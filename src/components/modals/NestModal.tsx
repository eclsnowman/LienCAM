import { textFor, useText } from '../../i18n'
const tx = textFor('cam-operations-new-operation')
import { useState, useMemo, useRef, useEffect, useLayoutEffect } from 'react'
import { Check, X, LayoutGrid, Lock, Unlock, FilePlus2, Loader2, MousePointer2 } from 'lucide-react'
import { useCamStore } from '../../store'
import { useUiPrefs } from '../../store/uiPrefs'
import { NumericInput } from '../ui/NumericInput'
import { importGeometryFile } from '../../lib/import/importGeometryFile'
import { CREATE_NEST_TEST_DEFAULTS } from '../../lib/cam/nesting/createNestDefaults'
import {
  buildNestSources,
  buildNestRequest,
  sheetInputsFor,
  isExactChoice,
  mergeNestSettings,
  solverStateFromMode,
  type NestPickerRow,
  type SolverChoice,
} from './nestPicker'
import { formatElapsedSeconds } from '../../lib/format'
import type { ImportedGeometry, NestRecord, Project } from '../../types'
import type { NestStyle, Spacing, Placement } from '../../lib/cam/nesting/types'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import type { VpHandle } from '../panels/DesignTree'
import type { CreateNestParams } from '../../store'

const getVp = (): VpHandle | null =>
  ((window as unknown as Record<string, unknown>).__cncViewport as VpHandle) ?? null

/** A geometry is nestable when it has at least one closed loop with >= 3 points
 *  (the same rule createNest uses to resolve a source into a NestPart). */
function isNestable(geo: ImportedGeometry): boolean {
  return (geo.loops ?? []).some((l) => l.closed && l.points.length >= 3)
}

/** Mirrors the modal's own `status` derivation for the primary `provisional`
 *  record (P4.2), reused per-sheet (WO-1826) so an overflow sheet still in
 *  flight reads as "computing" the same way sheet 1 always has. */
function nestRecordStatus(rec: NestRecord): 'computing' | 'ready' | 'error' {
  if (rec.status) return rec.status
  return rec.placements.length > 0 ? 'ready' : 'computing'
}

type PickEntry = { included: boolean; quantity: number; locked: boolean }
const DEFAULT_PICK: PickEntry = { included: false, quantity: 1, locked: false }

const MODAL_KEYBOARD_EXCLUSION_SELECTOR = [
  'button',
  'select',
  'option',
  'textarea',
  'a[href]',
  'summary',
  '[contenteditable]:not([contenteditable="false"])',
  '[aria-multiline="true"]',
  '[role="button"]',
  '[role="link"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="menu"]',
  '[role="menuitem"]',
].join(',')

function isSafeNestEnterTarget(
  target: EventTarget | null,
  root: HTMLElement | null,
): boolean {
  if (!(target instanceof Element) || root === null || !root.contains(target)) return false
  if (target.closest(MODAL_KEYBOARD_EXCLUSION_SELECTOR) !== null) return false

  const input = target.closest('input')
  if (!(input instanceof HTMLInputElement)) return true
  return !input.disabled && [
    'text', 'number', 'search', 'email', 'password', 'tel', 'url',
  ].includes(input.type)
}

/**
 * New Nest modal (P4.1 picker + P4.2 full controls and Calculate/Accept flow).
 *
 * P4.2 adds the SHEET/SOLVER, STYLE and SPACING control sections, an in-modal
 * result summary (placed / left / utilization + per-source counts), a live
 * spinner while packing, in-modal error surfacing (ADR 0003 — no silently-stuck
 * nest), and a provisional-nest Accept/Cancel flow: Calculate creates a
 * provisional nest, Accept keeps it + closes, any dismissal WITHOUT Accept
 * discards it (removeNest). Re-Calculate replaces the provisional nest with a
 * fresh pack from the current controls.
 *
 * Self-gates on activeModal === 'new-nest'. Viewport multi-pick is the primary
 * membership path; the name list remains a fallback for inaccessible/occluded
 * parts and for quantity/orientation edits.
 */
export function NestModal() {
  useText('cam-operations-new-operation')
  const activeModal = useCamStore((s) => s.activeModal)
  const closeModal = useCamStore((s) => s.closeModal)
  const project = useCamStore((s) => s.project)
  const createNest = useCamStore((s) => s.createNest)
  const removeNest = useCamStore((s) => s.removeNest)
  const discardPendingHistory = useCamStore((s) => s.discardPendingHistory)
  const setNestVisible = useCamStore((s) => s.setNestVisible)
  const addGeometry = useCamStore((s) => s.addGeometry)
  const removeGeometry = useCamStore((s) => s.removeGeometry)
  const importBrepGeometry = useCamStore((s) => s.importBrepGeometry)
  // EDIT plumbing: a DesignTree nest row's pencil button sets this to the nest id
  // (then opens the modal). The open transition reads it to enter edit mode. The
  // "+" header button sets it null so a fresh open is never an edit.
  const nestEditTarget = useCamStore((s) => s.nestEditTarget)
  const setNestEditTarget = useCamStore((s) => s.setNestEditTarget)
  // Global default sheet thickness (N1d): seeds the Thickness (Z) field on a
  // fresh open and is the fallback when an edited record has no stored thickness.
  const defaultThicknessMm = useCamStore((s) => s.appSettings.defaultStockThicknessMm)

  // Persisted last-used CONTROL values (P4.3): prefilled on open, saved on
  // Calculate. Part-picker selections are NOT persisted (they depend on the
  // current project geometry and are re-picked each open).
  const lastNestSettings = useUiPrefs((s) => s.lastNestSettings)
  const setLastNestSettings = useUiPrefs((s) => s.setLastNestSettings)
  // WO-1904: the same remembered DXF drawing-origin choice the tree reads.
  const dxfKeepOrigin = useUiPrefs((s) => s.dxfKeepOrigin)

  const isOpen = activeModal === 'new-nest'
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()

  // Per-geometryId picker state (included / quantity / locked).
  const [pick, setPick] = useState<Record<string, PickEntry>>({})
  const [isPickingParts, setIsPickingParts] = useState(false)
  const [partPickerReady, setPartPickerReady] = useState(false)
  const partPickStartRef = useRef<Set<string>>(new Set())
  const partPickerAutoStartedRef = useRef(false)

  // CONSUME tracking (ADR 0025 §2 deep-copy seed model): geometry ids freshly
  // imported via the modal's inline "Add part..." THIS session. They are a
  // vehicle to bring a part into the nest, not a workspace part, so createNest
  // CONSUMES (deletes) them after deep-copying. Pre-existing workspace parts and
  // edit-prefilled owned seeds are NOT in this set (they stay / are owned by
  // their nest). A fresh import is consumed on Accept (handleAccept); intermediate
  // re-Calculates keep it alive so the deep copy always has a live source.
  const [freshIds, setFreshIds] = useState<Set<string>>(new Set())

  // P4.2 control state (solver / sheet / style / rotation / spacing). Seeded from
  // the last-used (persisted) settings if present, else the fresh defaults
  // (P4.3). The open effect re-applies the latest persisted values each fresh
  // open; this initializer just gives the right values on first mount.
  const initial = mergeNestSettings(lastNestSettings)
  const [solver, setSolver] = useState<SolverChoice>(initial.solver)
  const [sheet, setSheet] = useState<{ width: number; height: number }>({ ...initial.sheet })
  const [style, setStyle] = useState<NestStyle>(initial.style)
  const [rotationCount, setRotationCount] = useState<number>(initial.rotationCount)
  const [spacing, setSpacing] = useState<Spacing>({ ...initial.spacing })
  // Sheet Z thickness (Item 3). Initial = remembered last-used value if present,
  // else the global appSettings default. Always shown (every 2D part needs a Z).
  const [thickness, setThickness] = useState<number>(
    lastNestSettings?.thickness ?? defaultThicknessMm,
  )
  // Cut order (P7, "many paths to same result"): the multi-copy machining order,
  // also editable first-class in the nest Properties panel. Initial = remembered
  // last-used value (validated by mergeNestSettings) else the default
  // 'by-operation'. Same two options + labels as the Properties-panel control.
  const [machiningOrder, setMachiningOrder] = useState<'by-operation' | 'by-part'>(
    initial.machiningOrder,
  )
  // Auto-size ratio constraint (only shown / used for solver 'fixQty-none').
  const [ratioLocked, setRatioLocked] = useState<boolean>(initial.ratioLocked)
  const [ratioW, setRatioW] = useState<number>(initial.ratioW)
  const [ratioH, setRatioH] = useState<number>(initial.ratioH)
  // WO-1826: overflow onto additional sheets. Only meaningful for solver
  // 'fixSheet-exact' (fixed sheet, exact quantity, explicit leftovers) -- the
  // other solver modes size the sheet to fit everything or scale UP to fill
  // one sheet, so neither ever has genuine overflow (see multiSheetNest.ts).
  // maxSheets === 1 (the default) means "off": unchanged single-sheet
  // behaviour, byte-identical to before this WO. sheetsAuto true -> the cap
  // IS maxSheets; false -> the smaller of sheetsCount and maxSheets (a
  // caller-chosen ceiling BELOW the stated maximum, never grown past it).
  const [maxSheets, setMaxSheets] = useState<number>(1)
  const [sheetsAuto, setSheetsAuto] = useState<boolean>(true)
  const [sheetsCount, setSheetsCount] = useState<number>(1)

  // The provisional nest created by Calculate. Subscribing to the record by id
  // gives us status / placements / unplaced / utilization without polling.
  const [provisionalId, setProvisionalId] = useState<string | null>(null)
  // Live "still packing" readout (QW2): a wall-clock timer so a long pack never
  // looks hung. packStartRef is set when Calculate begins; the interval below
  // ticks `packElapsedMs` while isPacking and is cleared when packing ends.
  const [packElapsedMs, setPackElapsedMs] = useState(0)
  const packStartRef = useRef<number | null>(null)
  // The solver mode that was USED at the last Calculate. Captured so the result
  // summary's exact-vs-fill format + the shortfall warning stay stable even if
  // the user changes the Solver dropdown without re-calculating.
  const [lastCalcSolver, setLastCalcSolver] = useState<SolverChoice | null>(null)
  const provisional = useCamStore((s) =>
    provisionalId ? s.project.nests?.find((n) => n.id === provisionalId) : undefined,
  )
  // WO-1826: overflow sheets beyond the first. Sheet 1 stays `provisionalId`
  // (unchanged); each id here is a REAL sibling NestRecord created by the
  // SAME createNest sheet 1 uses -- run through the unchanged single-sheet
  // pipeline, never a duplicate/hand-rolled solve. `dispatchedFrom` guards
  // the chain effect below against dispatching the same next-sheet twice.
  const [overflowIds, setOverflowIds] = useState<string[]>([])
  const dispatchedFromRef = useRef<Set<string>>(new Set())
  // WO-1585 audit: identity of the ONE history entry a new-nest session's first
  // Calculate pushed, captured right after that push so a later Dismiss's
  // discardPendingHistory() can pop only that exact entry (never whatever
  // happens to be on top by then -- app-level undo has no modal guard and can
  // fire mid-session, see handleCalculate/handleDismiss). Null when there is no
  // new-session entry pending discard.
  const sessionHistoryEntryRef = useRef<Project | null>(null)
  // EDIT mode: the id of the EXISTING nest being edited (null = fresh "New Nest").
  // Independent of provisionalId (the freshly-packed candidate). On Accept the
  // original is deleted so the new pack replaces it; on Cancel it is kept intact.
  const [editingId, setEditingId] = useState<string | null>(null)
  // Whether the edited original was VISIBLE before we hid it on entering edit mode
  // (so Cancel can restore it — Accept deletes it so the flag is moot there). We
  // hide the original while editing to avoid two nests rendering at the origin.
  const editOrigWasVisible = useRef(false)

  const fileInputRef = useRef<HTMLInputElement>(null)

  // Selectable parts = nestable workspace geometry that is NOT already a nest's
  // owned seed copy (ownerNestId set). Owned seeds are internal to a nest and
  // must never appear as a standalone pickable row (ADR 0025 §2). When EDITING a
  // nest its OWN owned seeds are added back below (displayGeos) so the edit can
  // re-pack from them.
  const nestable = useMemo(
    () => project.geometry.filter((g) => isNestable(g) && !g.ownerNestId),
    [project.geometry],
  )

  const nameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const g of project.geometry) m.set(g.id, g.name)
    return m
  }, [project.geometry])

  // Seed picker state for any nestable part not yet tracked (default: excluded).
  useEffect(() => {
    if (!isOpen) return
    setPick((prev) => {
      let changed = false
      const next = { ...prev }
      for (const geo of nestable) {
        if (!next[geo.id]) {
          next[geo.id] = { ...DEFAULT_PICK }
          changed = true
        }
      }
      return changed ? next : prev
    })
  }, [isOpen, nestable])

  // Reset the modal when it OPENS: part picks always start empty (they depend on
  // the current project geometry), but the CONTROLS are PREFILLED from the
  // last-used persisted settings (P4.3) — or the fresh defaults if nothing has
  // been remembered — so an iterating user does not retype. The wasOpen guard
  // makes this fire only on the closed->open transition (not on every render).
  const wasOpen = useRef(false)
  useEffect(() => {
    if (isOpen && !wasOpen.current) {
      // EDIT vs FRESH: if nestEditTarget names an existing nest, prefill EVERY
      // control + the part-picker rows from that record and enter edit mode;
      // otherwise behave as today (fresh, prefilled from last-used settings).
      const target = nestEditTarget
        ? useCamStore.getState().project.nests?.find((n) => n.id === nestEditTarget)
        : undefined
      if (target) {
        // Inverse-map the stored solver mode back to the flattened controls.
        const ss = solverStateFromMode(target.solver ?? { kind: 'fixSheet' })
        setSolver(ss.solver)
        setRatioLocked(ss.ratioLocked)
        setRatioW(ss.ratioW)
        setRatioH(ss.ratioH)
        // NEST-MODAL-SPACING-VET: route sheet/style/rotationCount/spacing/
        // machiningOrder through the SAME shared validator the fresh-open path
        // already trusts (mergeNestSettings) instead of reading them straight
        // off the stored record. A record whose spacing/sheet is missing or
        // partial (a hand-edited/legacy .camproject, or any nest record that
        // reached the store by a path other than this modal) would otherwise
        // feed `undefined` straight into a NumericInput's `value` prop, which
        // crashes on mount (NumericInput.formatNum calls value.toFixed(10)
        // unconditionally) -- confirmed by coordination/reports/
        // PP-UTILITY-S2.report.md's hand-seeded capture fixture. The project
        // load boundary (projectMigrations.ts normalizeNestRecords) now
        // backfills persisted records too, but this keeps the modal itself
        // total for ANY in-memory nest record regardless of how it arrived (a
        // test/capture harness seeding the store directly bypasses that
        // migration).
        const merged = mergeNestSettings({
          sheet: target.sheet,
          style: target.style,
          rotationCount: target.rotationCount,
          spacing: target.spacing,
          thickness: target.thickness,
          machiningOrder: target.machiningOrder,
        })
        setSheet({ ...merged.sheet })
        setStyle(merged.style)
        setRotationCount(merged.rotationCount)
        setSpacing({ ...merged.spacing })
        // Prefill thickness from the edited record; fall back to the app default
        // for a pre-thickness record (Item 3) -- appSettings-aware, so kept
        // independent of mergeNestSettings' own (non-appSettings-aware) literal.
        setThickness(target.thickness ?? defaultThicknessMm)
        // Prefill cut order from the edited record; undefined === 'by-operation'
        // (the default) for a pre-P7 record (P7).
        setMachiningOrder(merged.machiningOrder)
        // Rebuild picker rows from the record's sources. Sources whose geometry
        // no longer exists are skipped (they can't be packed).
        // EDIT re-packs from the edited nest's OWN owned seed copies (alive until
        // Accept). Those are real geometry (ownerNestId === target.id) referenced
        // by target.sources; createNest deep-copies them into the provisional's
        // owned seeds. None are fresh imports to consume (freshIds stays empty).
        const geomIds = new Set(useCamStore.getState().project.geometry.map((g) => g.id))
        const nextPick: Record<string, PickEntry> = {}
        for (const src of target.sources) {
          if (!geomIds.has(src.geometryId)) continue
          nextPick[src.geometryId] = {
            included: true,
            quantity: Math.max(1, Math.round(src.quantity)),
            locked: !!src.locked,
          }
        }
        setPick(nextPick)
        setFreshIds(new Set())
        setEditingId(target.id)
        // Hide the original while editing so it doesn't render over the candidate
        // at the sheet origin; remember its prior visibility for Cancel restore.
        editOrigWasVisible.current = target.visible ?? true
        if ((target.visible ?? true) !== false) setNestVisible(target.id, false)
      } else {
        const s = mergeNestSettings(lastNestSettings)
        setPick({})
        setFreshIds(new Set())
        setSolver(s.solver)
        setSheet({ ...s.sheet })
        setStyle(s.style)
        setRotationCount(s.rotationCount)
        setSpacing({ ...s.spacing })
        // Remembered thickness if present, else the global app default (Item 3).
        setThickness(lastNestSettings?.thickness ?? defaultThicknessMm)
        // Remembered cut order if present, else the default 'by-operation' (P7).
        // s.machiningOrder is the validated/merged value from mergeNestSettings.
        setMachiningOrder(s.machiningOrder)
        setRatioLocked(s.ratioLocked)
        setRatioW(s.ratioW)
        setRatioH(s.ratioH)
        setEditingId(null)
      }
      setProvisionalId(null)
      setLastCalcSolver(null)
      sessionHistoryEntryRef.current = null
      // WO-1826: a fresh open never carries over a prior session's overflow
      // chain (those records, if any, were already handled by that session's
      // own Accept/Dismiss).
      setOverflowIds([])
      dispatchedFromRef.current = new Set()
    }
    wasOpen.current = isOpen
  }, [isOpen, lastNestSettings, nestEditTarget, setNestVisible, defaultThicknessMm])

  // Derive the modal's view of the provisional pack from its record's status. A
  // record with placements but no status reads as ready (back-compat / tests).
  // Computed BEFORE the early return below because the packing-timer effect is a
  // hook and MUST run on every render regardless of isOpen (Rules of Hooks — a
  // hook after `return null` causes "Rendered more hooks than during the
  // previous render" when the modal opens).
  const status: 'idle' | 'computing' | 'ready' | 'error' = !provisional
    ? 'idle'
    : provisional.status
      ? provisional.status
      : provisional.placements.length > 0
        ? 'ready'
        : 'computing'
  const isPacking = status === 'computing'
  const canAccept = status === 'ready'

  // QW2: tick the live elapsed readout ONLY while packing; clear the interval
  // when packing ends or the modal unmounts (no leak). Re-bases off packStartRef
  // (set in handleCalculate) so re-mounts/HMR don't lose the true start time.
  useEffect(() => {
    if (!isPacking) return
    if (packStartRef.current === null) packStartRef.current = performance.now()
    const tick = () => setPackElapsedMs(performance.now() - (packStartRef.current ?? performance.now()))
    tick()
    const handle = window.setInterval(tick, 300)
    return () => window.clearInterval(handle)
  }, [isPacking])

  useEffect(() => {
    if (isOpen) return
    getVp()?.setPartPickMode?.(null)
    setIsPickingParts(false)
    setPartPickerReady(false)
    partPickerAutoStartedRef.current = false
  }, [isOpen])

  useEffect(() => () => {
    getVp()?.setPartPickMode?.(null)
  }, [])

  // The parts shown in the picker: selectable workspace geometry PLUS, when
  // editing, the edited nest's own owned seed copies (so the edit can re-pack
  // from them). Owned seeds of OTHER nests are never shown.
  const displayGeos: ImportedGeometry[] = (() => {
    if (!editingId) return nestable
    const extra = project.geometry.filter(
      (g) => g.ownerNestId === editingId && isNestable(g) && !nestable.some((n) => n.id === g.id),
    )
    return [...nestable, ...extra]
  })()

  const rows: NestPickerRow[] = displayGeos.map((geo) => {
    const p = pick[geo.id] ?? DEFAULT_PICK
    return {
      geometryId: geo.id,
      included: p.included,
      quantity: p.quantity,
      locked: p.locked,
    }
  })

  // Inline imports are consumed by Calculate (ADR 0025). Their owned copies
  // belong in the result's Parts list, without becoming selectable workspace
  // rows or changing the source ids used for a subsequent Calculate (WO-1520).
  const listedNest = provisional ?? project.nests?.find((n) => n.id === editingId)
  const placedCounts = new Map<string, number>()
  for (const placement of listedNest?.placements ?? []) {
    placedCounts.set(placement.partId, (placedCounts.get(placement.partId) ?? 0) + 1)
  }
  // Before a pack returns placements (or if none fit), the nest still has
  // nestable sources. Show their requested quantities rather than claiming
  // there is no geometry while the owned copies are alive.
  if (placedCounts.size === 0) {
    for (const source of listedNest?.sources ?? []) {
      const geo = project.geometry.find((g) => g.id === source.geometryId)
      if (geo && isNestable(geo)) placedCounts.set(source.geometryId, source.quantity)
    }
  }

  const sources = buildNestSources(rows)
  const canCalculate = sources.length > 0

  const setRow = (id: string, patch: Partial<PickEntry>) => {
    setPick((prev) => ({
      ...prev,
      [id]: { ...(prev[id] ?? DEFAULT_PICK), ...patch },
    }))
  }

  const selectedPartIds = displayGeos
    .filter((geo) => (pick[geo.id] ?? DEFAULT_PICK).included)
    .map((geo) => geo.id)

  const finishPartPicking = () => {
    getVp()?.setPartPickMode?.(null)
    setIsPickingParts(false)
  }

  const cancelPartPicking = () => {
    const initial = partPickStartRef.current
    setPick((prev) => {
      const next = { ...prev }
      for (const geo of displayGeos) {
        next[geo.id] = {
          ...(prev[geo.id] ?? DEFAULT_PICK),
          included: initial.has(geo.id),
        }
      }
      return next
    })
    finishPartPicking()
  }

  const startPartPicking = (): boolean => {
    const vp = getVp()
    if (!vp?.setPartPickMode) return false
    const eligibleIds = displayGeos.map((geo) => geo.id)
    if (eligibleIds.length === 0) return false
    partPickStartRef.current = new Set(selectedPartIds)
    setIsPickingParts(true)
    vp.setPartPickMode((id) => {
      setPick((prev) => {
        const current = prev[id] ?? DEFAULT_PICK
        const next = {
          ...prev,
          [id]: { ...current, included: !current.included },
        }
        vp.setPartPickSelection?.(
          eligibleIds.filter((eligibleId) => (next[eligibleId] ?? DEFAULT_PICK).included),
        )
        return next
      })
    }, eligibleIds, selectedPartIds, 'nest-membership')
    return true
  }

  useEffect(() => {
    if (!isOpen || isPickingParts) return
    if (!partPickerReady) {
      setPartPickerReady(true)
      return
    }
    if (partPickerAutoStartedRef.current) return
    if (startPartPicking()) partPickerAutoStartedRef.current = true
  }, [isOpen, isPickingParts, partPickerReady, displayGeos])

  const handleAddPart = () => fileInputRef.current?.click()

  const handleFilePicked = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    // Same import path as the DesignTree tree (ADR 0010); the new geometry shows
    // up as a pickable row via the project.geometry subscription + the seed effect.
    // CONSUME tracking: snapshot the existing geometry ids, then any id present
    // AFTER the import is a FRESH modal import this session -> createNest CONSUMES
    // it after deep-copying (a vehicle to bring the part in, not a workspace part).
    // P4: a fresh import defaults to consume (auto-checked / included).
    const before = new Set(useCamStore.getState().project.geometry.map((g) => g.id))
    await importGeometryFile(file, { importBrepGeometry, addGeometry }, { keepOrigin: dxfKeepOrigin })
    const added = useCamStore.getState().project.geometry
      .map((g) => g.id)
      .filter((id) => !before.has(id))
    if (added.length > 0) {
      setFreshIds((prev) => {
        const next = new Set(prev)
        for (const id of added) next.add(id)
        return next
      })
      // Default the freshly-imported part to INCLUDED (P4: the user added it
      // deliberately, so it is checked + consumed by default).
      setPick((prev) => {
        const next = { ...prev }
        for (const id of added) next[id] = { ...DEFAULT_PICK, ...next[id], included: true }
        return next
      })
    }
    e.target.value = ''
  }

  const handleCalculate = () => {
    if (!canCalculate) return
    // Reset + start the live elapsed timer for this pack (QW2).
    packStartRef.current = performance.now()
    setPackElapsedMs(0)
    const params = buildNestRequest({ rows, solver, sheet, style, rotationCount, spacing, thickness, machiningOrder, seed: CREATE_NEST_TEST_DEFAULTS.seed, ratioLocked, ratioW, ratioH })
    // WO-1826: a fresh Calculate replaces the WHOLE chain, not just sheet 1 --
    // tear down any prior overflow sheets first (they never own history, so
    // this needs no history push of its own). Sheet 1's own name gets the
    // "(sheet N)" suffix only when overflow is actually possible this run, so
    // the overwhelmingly common single-sheet case stays byte-identical.
    for (const oid of overflowIds) removeNest(oid, { skipHistory: true })
    setOverflowIds([])
    dispatchedFromRef.current = new Set()
    if (solver === 'fixSheet-exact' && maxSheets > 1) {
      params.name = tx('NestModal.Census_sheet_1', { p1: params.name ?? tx('NestModal.Nest', { p1: (project.nests?.length ?? 0) + 1 }) })
    }

    // DEEP-COPY SEED MODEL (ADR 0025 §2): createNest deep-copies each source into
    // the new nest's OWNED seed and CONSUMES the fresh modal imports. We create
    // the new provisional FIRST (so it can copy from the still-alive sources —
    // incl. the previous provisional's owned seeds on a re-Calculate), THEN remove
    // the previous provisional (which deletes ITS owned seeds). Order matters: the
    // copy must happen before the old owned seeds are torn down.
    // WO-1585 audit: app-level undo has no modal guard (TopToolbar's window
    // Ctrl+Z fires whenever workspace is 'cam' and focus isn't a text input)
    // and can pop the entry this session's first Calculate pushed WHILE the
    // modal stays open. When that happens `provisionalId` (React state) is
    // stale -- it still names a nest that undo just removed from the store.
    // `provisional` is a live store subscription keyed on that same id, so it
    // goes undefined the instant the nest is gone; treat that as no provisional
    // at all so this Calculate re-establishes the session (pushes its own
    // entry) instead of taking the Re-calculate skip-history branch against an
    // id nothing here still owns.
    const prev = provisionalId !== null && provisional !== undefined ? provisionalId : null
    const editTargetId = editingId
    const consumeIds = [...freshIds].filter((fid) =>
      params.sources.some((s) => s.geometryId === fid),
    )
    // WO-1435/BUG-424: on the FIRST Calculate of an edit session, the
    // pushHistory() inside createNest below becomes the SOLE undo step for the
    // whole edit-Accept transaction — handleAccept skips its own removeNest
    // push and reuses this one so Accept produces exactly one history entry.
    // That snapshot must show the ORIGINAL exactly as it looked before editing
    // began, so momentarily undo the entry-to-edit-mode hide (setNestVisible
    // is untracked — it never touches history) around the call, then re-hide
    // immediately after for the editing UI.
    //
    // A Re-calculate (prev !== null) inside the SAME session -- edit or
    // WO-1585 new-nest alike -- must NOT add entries of its own. The audit on
    // WO-1435's attempt 1 caught that every edit-session Re-calculate still
    // pushed two (createNest's + removeNest(prev)'s), so one Undo after
    // Calculate -> Re-calculate -> Accept only reversed the LAST of those and
    // left both the old and new provisional visible; WO-1585 found the same
    // gap in a fresh (no editingId) session. The first Calculate's snapshot
    // must stay the transaction's only entry, so skip history on both calls
    // here for any Re-calculate, regardless of edit vs. new.
    const isRecalc = prev !== null
    if (prev === null && editTargetId !== null && editOrigWasVisible.current) {
      setNestVisible(editTargetId, true)
    }
    const id = createNest(params, consumeIds, isRecalc ? { skipHistory: true } : undefined)
    if (prev === null && editTargetId !== null && editOrigWasVisible.current) {
      setNestVisible(editTargetId, false)
    }
    if (prev) removeNest(prev, isRecalc ? { skipHistory: true } : undefined)
    // WO-1585 audit: this push just became (or re-became, post-undo) the
    // session's sole pending entry -- capture its identity so a later Dismiss
    // discards exactly this entry and never whatever else is on top by then.
    if (prev === null && editTargetId === null) {
      sessionHistoryEntryRef.current = useCamStore.getState().projectHistory.at(-1) ?? null
    }

    // BUG-378/WO-1520: `pick` stays keyed exactly as `rows` (hence `params.sources`)
    // already had it -- the ORIGINAL geometry id in fresh mode, or editingId's own
    // owned-seed id in edit mode. That is the SAME id `displayGeos` shows on the
    // next render (fresh mode never displays owned seeds; edit mode only displays
    // editingId's OWN seeds, never another nest's). The new provisional's owned
    // seeds (newNest.sources) are internal to createNest's deep-copy and are never
    // a row a user can see or re-pick, so rekeying `pick` onto them only orphaned
    // the entry the visible row actually reads (that was the bug: the row the user
    // just checked fell back to DEFAULT_PICK because its key had been deleted).
    // Nothing to do here except drop the now-consumed fresh imports.
    setFreshIds(new Set())

    setProvisionalId(id)
    setLastCalcSolver(solver)
    // Remember the CONTROL values (not the part picks) so the next New Nest opens
    // prefilled with what the user last used (P4.3 + ratio constraint).
    setLastNestSettings({ solver, sheet: { ...sheet }, style, rotationCount, spacing: { ...spacing }, thickness, machiningOrder, ratioLocked, ratioW, ratioH })
  }

  // Clean up any fresh modal imports that were added but never consumed (the user
  // clicked "Add part..." but never Calculated, so createNest never deep-copied +
  // consumed them). Without this they would linger at the workspace root.
  const cleanupUnconsumedFreshImports = () => {
    const live = new Set(useCamStore.getState().project.geometry.map((g) => g.id))
    for (const fid of freshIds) {
      if (live.has(fid)) removeGeometry(fid)
    }
  }

  // Accept keeps the provisional nest and closes. In EDIT mode the new pack
  // REPLACES the original: delete the edited nest (its visibility flag is moot
  // since it's removed; removeNest also deletes its owned seeds). Clears all
  // edit/provisional state + the store target.
  //
  // WO-1435/BUG-424: this removal must NOT push its own history entry — the
  // first Calculate of this edit session already pushed the ONE entry that
  // covers the whole replace (see handleCalculate). A second push here would
  // leave Accept as two undo steps, so a single Undo only reversed this
  // removal and exposed the two-nest intermediate (the original un-deleted,
  // the provisional still visible) instead of the true pre-edit state.
  const handleAccept = () => {
    if (editingId && editingId !== provisionalId) removeNest(editingId, { skipHistory: true })
    cleanupUnconsumedFreshImports()
    setEditingId(null)
    setProvisionalId(null)
    setFreshIds(new Set())
    setNestEditTarget(null)
    sessionHistoryEntryRef.current = null
    // WO-1826: overflow sheets are already REAL records (created by the same
    // createNest sheet 1 uses) -- Accept keeps them exactly like it keeps
    // sheet 1: nothing to remove, just stop tracking them as "the modal's
    // session".
    setOverflowIds([])
    dispatchedFromRef.current = new Set()
    closeModal()
  }

  // Any dismissal WITHOUT Accept discards the provisional nest (removeNest deletes
  // its owned seeds) but KEEPS the edited original — restoring its pre-edit
  // visibility (we hid it on entry). Fresh imports added this session were a
  // vehicle for the abandoned nest, so any un-consumed ones are removed too.
  //
  // WO-1585: a NEW-nest session (no editingId) has nothing to restore — its
  // provisional's removal must leave NO trace on the undo stack, or Undo
  // would resurrect the exact nest the operator just canceled. Its ONE
  // history entry came from the first Calculate (see handleCalculate), so
  // skip removeNest's own push and discard that pending entry instead of
  // adding a second one. Edit sessions are unchanged (WO-1435): Cancel there
  // already restores the pre-edit original untouched, so removeNest keeps
  // its normal push.
  const handleDismiss = () => {
    const isNewSession = editingId === null
    if (provisionalId) {
      removeNest(provisionalId, isNewSession ? { skipHistory: true } : undefined)
      // WO-1585 audit: guarded by identity, not just isNewSession -- if
      // app-level undo already popped this session's entry (see
      // handleCalculate), sessionHistoryEntryRef no longer names the stack's
      // top and the store no-ops rather than deleting an unrelated entry.
      if (isNewSession && sessionHistoryEntryRef.current) {
        discardPendingHistory(sessionHistoryEntryRef.current)
      }
    }
    // WO-1826: any overflow sheets this session dispatched are abandoned with
    // the rest of the pack -- they never owned history (see handleCalculate),
    // so their removal here does too.
    for (const oid of overflowIds) removeNest(oid, { skipHistory: true })
    setOverflowIds([])
    dispatchedFromRef.current = new Set()
    sessionHistoryEntryRef.current = null
    if (editingId && editOrigWasVisible.current) setNestVisible(editingId, true)
    cleanupUnconsumedFreshImports()
    setEditingId(null)
    setProvisionalId(null)
    setFreshIds(new Set())
    setNestEditTarget(null)
    closeModal()
  }

  const isOpenRef = useRef(isOpen)
  const isPickingPartsRef = useRef(isPickingParts)
  const canCalculateRef = useRef(canCalculate)
  const canAcceptRef = useRef(canAccept)
  const isPackingRef = useRef(isPacking)
  const cancelPartPickingRef = useRef(cancelPartPicking)
  const calculateRef = useRef(handleCalculate)
  const acceptRef = useRef(handleAccept)
  const dismissRef = useRef(handleDismiss)
  const pendingActionRef = useRef<number | null>(null)

  useLayoutEffect(() => {
    // NumericInput commits in its own keydown handler. Publish only committed
    // render state so the deferred shell action sees that same Enter's value.
    isOpenRef.current = isOpen
    isPickingPartsRef.current = isPickingParts
    canCalculateRef.current = canCalculate
    canAcceptRef.current = canAccept
    isPackingRef.current = isPacking
    cancelPartPickingRef.current = cancelPartPicking
    calculateRef.current = handleCalculate
    acceptRef.current = handleAccept
    dismissRef.current = handleDismiss
  })

  useEffect(() => {
    if (!isOpen) return

    const cancelPendingAction = (): void => {
      if (pendingActionRef.current === null) return
      window.clearTimeout(pendingActionRef.current)
      pendingActionRef.current = null
    }
    const onKey = (event: KeyboardEvent): void => {
      if (
        event.defaultPrevented
        || event.isComposing
        || event.keyCode === 229
        || event.key === 'Process'
      ) return
      if (event.key !== 'Enter' && event.key !== 'Escape') return

      const panel = document.querySelector<HTMLElement>('[data-testid="nest-modal-panel"]')
      if (event.key === 'Escape') {
        cancelPendingAction()
        event.preventDefault()
        event.stopImmediatePropagation()
        if (isPickingPartsRef.current) cancelPartPickingRef.current()
        else dismissRef.current()
        return
      }

      if (
        isPickingPartsRef.current
        || !isSafeNestEnterTarget(event.target, panel)
      ) return

      event.preventDefault()
      event.stopImmediatePropagation()
      if (pendingActionRef.current !== null) return
      pendingActionRef.current = window.setTimeout(() => {
        pendingActionRef.current = null
        if (!isOpenRef.current || isPickingPartsRef.current || isPackingRef.current) return
        if (canAcceptRef.current) acceptRef.current()
        else if (canCalculateRef.current) calculateRef.current()
      }, 0)
    }

    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
      cancelPendingAction()
    }
  }, [isOpen])

  const sheetIn = sheetInputsFor(solver)

  // WO-1826: overflow onto additional sheets. Sheet 1 stays the existing
  // provisional/Calculate flow untouched (above); everything below only
  // EXTENDS the chain past it. maxSheets === 1 (the default) means "off" --
  // multiSheetActive is false and none of this runs, so the single-sheet
  // case stays byte-identical to before this WO.
  const multiSheetActive = solver === 'fixSheet-exact' && maxSheets > 1
  const effectiveCap = sheetsAuto
    ? Math.max(1, Math.floor(maxSheets))
    : Math.max(1, Math.min(Math.floor(sheetsCount), Math.floor(maxSheets)))
  const overflowRecords = useMemo(
    () =>
      overflowIds
        .map((oid) => project.nests?.find((n) => n.id === oid))
        .filter((n): n is NestRecord => n !== undefined),
    [overflowIds, project.nests],
  )
  const sheetChain: NestRecord[] = provisional ? [provisional, ...overflowRecords] : []

  // Dispatches the NEXT sheet once the current last sheet in the chain is
  // ready with genuine leftovers and the cap allows another. Re-runs the SAME
  // createNest sheet 1 uses (real geometry, real worker pipeline) -- never a
  // duplicate/hand-rolled solve -- so each sheet is its own independent
  // program through the unchanged single-sheet pipeline (Operator's D9 ruling).
  useEffect(() => {
    if (!isOpen || !multiSheetActive || sheetChain.length === 0) return
    const last = sheetChain[sheetChain.length - 1]
    if (nestRecordStatus(last) !== 'ready') return
    if (last.unplaced.length === 0) return
    if (sheetChain.length >= effectiveCap) return
    if (dispatchedFromRef.current.has(last.id)) return
    dispatchedFromRef.current.add(last.id)

    // The next sheet's sources are the PREVIOUS sheet's own owned-seed
    // geometries (last.sources) -- already real project geometry, no
    // duplicate geometry -> NestPart resolution here. Which parts and how
    // many carry over comes straight from last.unplaced (ADR 0003: named
    // leftovers, never silently reshuffled -- a part placed on an earlier
    // sheet is never revisited).
    const lockedByPartId = new Map(last.sources.map((s) => [s.geometryId, !!s.locked]))
    const nextSources = last.unplaced.map((u) => ({
      geometryId: u.partId,
      quantity: u.count,
      ...(lockedByPartId.get(u.partId) ? { locked: true } : {}),
    }))
    const baseName = last.name.replace(/ \(sheet \d+\)$/, '')
    const nextParams: CreateNestParams = {
      sources: nextSources,
      sheet: { width: sheet.width, height: sheet.height },
      style,
      spacing: { ...spacing },
      // Same objective every sheet: fixed sheet, exact carried-over quantity,
      // explicit leftovers (the only mode with genuine overflow).
      solver: { kind: 'fixSheetExact' },
      // Same deterministic seed EVERY sheet (the request's "same deterministic
      // seed policy" -- WO-1826 acceptance).
      seed: CREATE_NEST_TEST_DEFAULTS.seed,
      thickness,
      machiningOrder,
      name: tx('NestModal.Census_sheet', { p1: baseName, p2: sheetChain.length + 1 }),
    }
    if (style === 'arbitrary') nextParams.rotationCount = Math.max(2, Math.floor(rotationCount))
    const nextId = createNest(nextParams, [], { skipHistory: true })
    setOverflowIds((prev) => [...prev, nextId])
  }, [
    isOpen, multiSheetActive, sheetChain, effectiveCap, sheet, style, spacing,
    thickness, machiningOrder, rotationCount, createNest,
  ])

  if (!isOpen) return null

  if (isPickingParts) {
    return (
      <div className="loop-pick-banner" data-testid="nest-part-pick-banner">
        <MousePointer2 size={16} className="loop-pick-icon" />
        <span className="loop-pick-text">
          <strong>{tx('NestModal.Nest_membership_picker_active')}</strong>{tx('NestModal.Click_parts_to_add_or_remove_them_selected_parts')}<strong data-testid="nest-part-pick-count">{tx('NestModal.selected', { p1: selectedPartIds.length })}</strong>
        </span>
        <button
          className="modal-btn modal-btn-ghost"
          data-testid="nest-part-pick-cancel"
          onClick={cancelPartPicking}
        >
          <X size={14} />{tx('NestModal.Cancel')}</button>
        <button
          className="loop-pick-done-btn"
          data-testid="nest-part-pick-done"
          onClick={finishPartPicking}
        >
          <Check size={14} />{tx('NestModal.Done')}</button>
      </div>
    )
  }

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- MODAL-
    // GOVERNED scrim in the UI-70 census.
    <div
      className="modal-backdrop"
      data-ui78-sanctioned=""
      onMouseDown={(e) => { if (e.target === e.currentTarget) handleDismiss() }}
    >
      <div className="modal-container nest-modal" data-testid="nest-modal-panel" ref={dialogFocusRef}>
        {/* Header */}
        <div className="modal-header">
          <LayoutGrid size={14} className="modal-header-icon" />
          <span className="modal-title">{editingId ? tx('NestModal.Edit_Nest') : tx('NestModal.New_Nest')}</span>
          <button className="modal-close-btn" onClick={handleDismiss}><X size={14} /></button>
        </div>

        {/* Body */}
        <div className="modal-body">
          <div className="mform-section-header">{tx('NestModal.Parts')}</div>

          {placedCounts.size > 0 && (
            <div className="nest-part-list" data-testid="nest-placed-parts">
              {[...placedCounts].map(([partId, quantity]) => (
                <div key={partId} className="nest-part-row">
                  <span className="nest-part-name">{nameById.get(partId) ?? partId}</span>
                  <span className="nest-part-qty-label">{tx('NestModal.Qty')}</span>
                  <span>{quantity}</span>
                </div>
              ))}
            </div>
          )}

          {displayGeos.length === 0 && placedCounts.size === 0 ? (
            <div className="nest-empty">{tx('NestModal.No_nestable_parts_Add_a_2D_part_DXF_SVG')}</div>
          ) : displayGeos.length > 0 && (
            <>
              <button
                type="button"
                className="op-pick-btn"
                data-testid="nest-pick-parts-in-viewport"
                onClick={startPartPicking}
              >
                <MousePointer2 size={14} />{tx('NestModal.Pick_parts_in_viewport')}<span className="op-pick-count">{tx('NestModal.selected', { p1: selectedPartIds.length })}</span>
              </button>
              <details className="nest-part-fallback" data-testid="nest-part-name-fallback">
                <summary>{tx('NestModal.Part_quantities_and_choose_by_name_fallback')}</summary>
                <div className="nest-part-list">
                  {displayGeos.map((geo) => {
                    const p = pick[geo.id] ?? DEFAULT_PICK
                    return (
                      <div key={geo.id} className={`nest-part-row${p.included ? ' nest-part-row-on' : ''}`}>
                        <input
                          type="checkbox"
                          className="nest-part-check"
                          data-testid={`nest-part-check-${geo.id}`}
                          checked={p.included}
                          onChange={(e) => setRow(geo.id, { included: e.target.checked })}
                        />
                        <span className="nest-part-name" data-tooltip={geo.name}>{geo.name}</span>
                        <label className="nest-part-qty-label">{tx('NestModal.Qty')}</label>
                        <NumericInput
                          className="mform-input nest-part-qty"
                          value={p.quantity}
                          min={1}
                          step={1}
                          disabled={!p.included}
                          onChange={(v) => setRow(geo.id, { quantity: Math.max(1, Math.round(v)) })}
                        />
                        <button
                          type="button"
                          className={`nest-part-lock${p.locked ? ' nest-part-lock-on' : ''}`}
                          disabled={!p.included}
                          data-tooltip={p.locked
                            ? tx('NestModal.Orientation_locked_solver_will_not_rotate_this_part')
                            : tx('NestModal.Orientation_free_click_to_lock_to_source_orientation')}
                          aria-label={p.locked ? tx('NestModal.Orientation_locked') : tx('NestModal.Orientation_free')}
                          onClick={() => setRow(geo.id, { locked: !p.locked })}
                        >
                          {p.locked ? <Lock size={12} /> : <Unlock size={12} />}
                        </button>
                      </div>
                    )
                  })}
                </div>
              </details>
            </>
          )}

          <button type="button" className="nest-add-part-btn" onClick={handleAddPart}>
            <FilePlus2 size={12} />{tx('NestModal.Add_part')}</button>
          {/* Hidden file input — same accepted formats as the DesignTree import. */}
          <input
            ref={fileInputRef}
            type="file"
            accept=".stl,.obj,.svg,.dxf,.step,.stp"
            style={{ display: 'none' }}
            onChange={handleFilePicked}
          />

          {/* ── SHEET / SOLVER ─────────────────────────────────────────────── */}
          <div className="mform-section-header">{tx('NestModal.Sheet_Solver')}</div>
          <div className="mform-row">
            <label className="mform-label">{tx('NestModal.Solver')}</label>
            <select
              className="mform-select"
              value={solver}
              onChange={(e) => setSolver(e.target.value as SolverChoice)}
            >
              <option value="fixSheet-exact">{tx('NestModal.Fixed_sheet_exact_quantity')}</option>
              <option value="fixSheet">{tx('NestModal.Fill_sheet_max_quantity_by_ratio')}</option>
              <option value="fixQty-none">{tx('NestModal.Exact_quantity_auto_size_sheet')}</option>
              <option value="fixQty-width">{tx('NestModal.Exact_quantity_lock_width_solve_height')}</option>
              <option value="fixQty-height">{tx('NestModal.Exact_quantity_lock_height_solve_width')}</option>
            </select>
          </div>
          {sheetIn.width && (
            <div className="mform-row">
              <label className="mform-label">
                {solver === 'fixQty-width' ? tx('NestModal.Sheet_width_locked') : tx('NestModal.Sheet_width')}
              </label>
              <NumericInput
                className="mform-input"
                value={sheet.width}
                min={1}
                step={1}
                onChange={(v) => setSheet((s) => ({ ...s, width: v }))}
              />
            </div>
          )}
          {sheetIn.height && (
            <div className="mform-row">
              <label className="mform-label">
                {solver === 'fixQty-height' ? tx('NestModal.Sheet_height_locked') : tx('NestModal.Sheet_height')}
              </label>
              <NumericInput
                className="mform-input"
                value={sheet.height}
                min={1}
                step={1}
                onChange={(v) => setSheet((s) => ({ ...s, height: v }))}
              />
            </div>
          )}
          {/* WO-1826: overflow onto additional sheets -- only meaningful for
              'fixSheet-exact' (fixed sheet, exact quantity, explicit
              leftovers). maxSheets defaults to 1 ("off"); raising it above 1
              is what turns overflow-onto-more-sheets on. */}
          {solver === 'fixSheet-exact' && (
            <>
              <div className="mform-row">
                <label className="mform-label">{tx('NestModal.Max_sheets')}</label>
                <NumericInput
                  className="mform-input"
                  data-testid="nest-modal-max-sheets"
                  value={maxSheets}
                  min={1}
                  step={1}
                  onChange={(v) => setMaxSheets(Math.max(1, Math.round(v)))}
                />
              </div>
              {maxSheets > 1 && (
                <div className="mform-row">
                  <label className="mform-label">
                    <input
                      type="checkbox"
                      data-testid="nest-modal-sheets-auto"
                      checked={sheetsAuto}
                      onChange={(e) => setSheetsAuto(e.target.checked)}
                    />{tx('NestModal.Auto_fill_as_many_sheets_as_needed_up_to')}</label>
                  {!sheetsAuto && (
                    <NumericInput
                      className="mform-input"
                      data-testid="nest-modal-sheets-count"
                      value={sheetsCount}
                      min={1}
                      step={1}
                      onChange={(v) => setSheetsCount(Math.max(1, Math.round(v)))}
                    />
                  )}
                </div>
              )}
            </>
          )}
          {/* Thickness (Z) — ALWAYS shown regardless of solver mode: every 2D nest
              part needs a cut depth. Independent of sheetInputsFor (Item 3). */}
          <div className="mform-row">
            <label className="mform-label">{tx('NestModal.Thickness_Z')}</label>
            <NumericInput
              className="mform-input"
              value={thickness}
              min={0.001}
              step={1}
              onChange={(v) => setThickness(v > 0 ? v : thickness)}
            />
          </div>
          {/* Cut order (P7, "many paths to same result") — the SAME field the nest
              Properties panel edits (NestRecord.machiningOrder), exposed here at
              creation time too. Same two options + labels as the PP control. */}
          <div className="mform-row">
            <label className="mform-label">{tx('NestModal.Cut_order')}</label>
            <select
              className="mform-select"
              data-testid="nest-modal-machining-order"
              value={machiningOrder}
              onChange={(e) => setMachiningOrder(e.target.value as 'by-operation' | 'by-part')}
            >
              <option value="by-operation">{tx('NestModal.By_operation_default')}</option>
              <option value="by-part">{tx('NestModal.By_part')}</option>
            </select>
          </div>
          {/* Auto-size only: optionally constrain the auto-sized sheet to a fixed
              W:H aspect ratio (else the free min-area solve makes a 1-wide strip). */}
          {solver === 'fixQty-none' && (
            <>
              <div className="mform-row">
                <label className="mform-label">
                  <input
                    type="checkbox"
                    className="nest-ratio-check"
                    checked={ratioLocked}
                    onChange={(e) => setRatioLocked(e.target.checked)}
                  />{tx('NestModal.Constrain_to_sheet_ratio_W_H')}</label>
              </div>
              {ratioLocked && (
                <div className="mform-row nest-ratio-row">
                  <label className="mform-label">{tx('NestModal.Sheet_ratio_W_H')}</label>
                  <NumericInput
                    className="mform-input nest-ratio-input"
                    value={ratioW}
                    min={0.1}
                    step={0.5}
                    onChange={(v) => setRatioW(v > 0 ? v : 1)}
                  />
                  <span className="nest-ratio-colon">{tx('NestModal.symbol')}</span>
                  <NumericInput
                    className="mform-input nest-ratio-input"
                    value={ratioH}
                    min={0.1}
                    step={0.5}
                    onChange={(v) => setRatioH(v > 0 ? v : 1)}
                  />
                </div>
              )}
            </>
          )}

          {/* ── STYLE ──────────────────────────────────────────────────────── */}
          <div className="mform-section-header">{tx('NestModal.Style')}</div>
          <div className="mform-row">
            <label className="mform-label">{tx('NestModal.Rotation')}</label>
            <select
              className="mform-select"
              value={style}
              onChange={(e) => setStyle(e.target.value as NestStyle)}
            >
              <option value="ninety">{tx('NestModal.90_degree_steps_0_90_180_270')}</option>
              <option value="arbitrary">{tx('NestModal.Arbitrary_angle')}</option>
            </select>
          </div>
          {style === 'arbitrary' && (
            <div className="mform-row">
              <label className="mform-label">{tx('NestModal.Orientation_samples')}</label>
              <NumericInput
                className="mform-input"
                value={rotationCount}
                min={2}
                step={1}
                onChange={(v) => setRotationCount(Math.max(2, Math.round(v)))}
              />
            </div>
          )}

          {/* ── SPACING ────────────────────────────────────────────────────── */}
          <div className="mform-section-header">{tx('NestModal.Spacing')}</div>
          <div className="mform-row">
            <label className="mform-label">{tx('NestModal.Part_gap')}</label>
            <NumericInput
              className="mform-input"
              value={spacing.partGap}
              min={0}
              step={0.5}
              onChange={(v) => setSpacing((s) => ({ ...s, partGap: v }))}
            />
          </div>
          <div className="mform-row">
            <label className="mform-label">{tx('NestModal.Sheet_margin')}</label>
            <NumericInput
              className="mform-input"
              value={spacing.sheetMargin}
              min={0}
              step={0.5}
              onChange={(v) => setSpacing((s) => ({ ...s, sheetMargin: v }))}
            />
          </div>
          <div className="mform-row">
            <label className="mform-label">{tx('NestModal.Window_gap')}</label>
            <NumericInput
              className="mform-input"
              value={spacing.windowGap}
              min={0}
              step={0.5}
              onChange={(v) => setSpacing((s) => ({ ...s, windowGap: v }))}
            />
          </div>

          {/* ── RESULT ─────────────────────────────────────────────────────── */}
          {status !== 'idle' && (
            <>
              <div className="mform-section-header">{tx('NestModal.Result')}</div>
              {isPacking && (
                <div className="nest-result-packing">
                  <Loader2 size={14} className="nest-spin" />
                  <span>{tx('NestModal.Packing', { p1: formatElapsedSeconds(packElapsedMs) })}<span className="nest-result-hint">{tx('NestModal.Complex_parts_can_take_10_30s')}</span>
                  </span>
                </div>
              )}
              {status === 'error' && (
                <div className="nest-result-error">{tx('NestModal.Nesting_failed', { p1: provisional?.error ?? tx('NestModal.unknown_error') })}</div>
              )}
              {/* Once overflow has actually produced sheet 2+, sheet 1's own
                  shortfall is routine (it is WHY sheet 2+ exist), not a
                  failure -- the per-sheet list below plus the
                  never-placed-by-name banner are the chain's real result.
                  Showing this single-sheet summary's "Couldn't fit all parts"
                  alert alongside a fully-placed chain read as a false failure
                  (caught at the WO-1826 picture gate). maxSheets>1 with no
                  actual overflow (sheetChain.length<=1) still shows this --
                  the only result there is to show. */}
              {status === 'ready' && provisional && (!multiSheetActive || sheetChain.length <= 1) && (
                <NestResultSummary
                  placements={provisional.placements}
                  unplaced={provisional.unplaced}
                  utilization={provisional.utilization}
                  sources={provisional.sources}
                  nameById={nameById}
                  // exact-vs-fill format is keyed to the solver USED at Calculate,
                  // not the (possibly changed) live dropdown. Default exact if the
                  // capture is somehow absent (a record with no preceding Calculate).
                  exact={lastCalcSolver ? isExactChoice(lastCalcSolver) : true}
                />
              )}
              {/* WO-1826: per-sheet list, one row per sibling NestRecord in the
                  chain (own stock, own part count) -- shown as soon as sheet 2+
                  exists, so the operator sees the overflow happening. */}
              {multiSheetActive && sheetChain.length > 1 && (
                <div className="nest-multisheet-list" data-testid="nest-modal-sheet-list">
                  {sheetChain.map((rec, i) => {
                    const st = nestRecordStatus(rec)
                    return (
                      <div
                        key={rec.id}
                        className="nest-multisheet-row"
                        data-testid={`nest-modal-sheet-row-${i + 1}`}
                      >
                        <span className="nest-multisheet-label">{tx('NestModal.Sheet', { p1: i + 1 })}</span>
                        {' '}
                        <span className="nest-multisheet-stock">{tx('NestModal.x_mm', { p1: rec.sheet.width, p2: rec.sheet.height })}</span>
                        {' '}
                        <span className="nest-multisheet-count">
                          {st === 'computing' ? tx('NestModal.Packing_status') : tx('NestModal.Census_placed', { p1: rec.placements.length })}
                        </span>
                      </div>
                    )
                  })}
                </div>
              )}
              {/* A part that fits no sheet within the maximum says so BY NAME --
                  nothing is silently dropped (ADR 0003 + WO-1826 acceptance). */}
              {multiSheetActive && sheetChain.length > 0 && (() => {
                const last = sheetChain[sheetChain.length - 1]
                if (nestRecordStatus(last) !== 'ready') return null
                if (last.unplaced.length === 0) return null
                if (sheetChain.length < effectiveCap) return null
                const names = last.unplaced.map(
                  (u) => `${nameById.get(u.partId) ?? u.partId} x${u.count}`,
                )
                return (
                  <div className="nest-multisheet-neverplaced" data-testid="nest-modal-never-placed">{tx('NestModal.Does_not_fit_on_any_sheet_max', { p1: effectiveCap, p2: names.join(', ') })}</div>
                )
              })()}
            </>
          )}
        </div>

        {/* Footer. Cancel uses the app-wide ghost (escape) style. Calculate and
            Accept are real ACTIONS and must read as clearly clickable, never
            muted (rule 9): whichever is the live next step is primary, the other
            falls back to ghost — same idiom as MachineLibraryModal's Save button.
            Before a successful pack, Calculate is primary and Accept is the lone
            disabled-dim control; once a pack is ready, Accept becomes primary and
            Re-calculate steps back to ghost. */}
        <div className="modal-footer">
          <button className="modal-btn modal-btn-ghost" onClick={handleDismiss}>{tx('NestModal.Cancel_2')}</button>
          <button
            className={`modal-btn ${canAccept ? 'modal-btn-ghost' : 'modal-btn-primary'}`}
            disabled={!canCalculate || isPacking}
            data-tooltip={canCalculate ? tx('NestModal.Pack_the_selected_parts_onto_the_sheet') : tx('NestModal.Include_at_least_one_part')}
            onClick={handleCalculate}
          >
            {provisionalId ? tx('NestModal.Re_calculate') : tx('NestModal.Calculate')}
          </button>
          <button
            className="modal-btn modal-btn-primary"
            disabled={!canAccept}
            data-tooltip={canAccept ? tx('NestModal.Keep_this_nest') : tx('NestModal.Calculate_a_nest_first')}
            onClick={handleAccept}
          >{tx('NestModal.Accept')}</button>
        </div>
      </div>
    </div>
  )
}

/** In-modal result summary: total placed/left + per-source placed counts so the
 *  user can confirm each part's count (ADR 0003 — leftovers are explicit).
 *
 *  Per-part PLACED is tallied from the ACTUAL placements (Placement.partId ===
 *  source.geometryId), so fill mode can truthfully report MORE than the typed
 *  ratio. In EXACT modes it shows "<placed> / <requested>"; in FILL mode just
 *  "<placed>" (the typed Qty is only a ratio there). A shortfall in EXACT mode
 *  raises a prominent warning; Accept stays enabled (partial packs are allowed). */
function NestResultSummary({
  placements,
  unplaced,
  utilization,
  sources,
  nameById,
  exact,
}: {
  placements: Placement[]
  unplaced: { partId: string; count: number }[]
  utilization: number
  sources: { geometryId: string; quantity: number }[]
  nameById: Map<string, string>
  exact: boolean
}) {
  useText('cam-operations-new-operation')
  // actual placed-per-part, tallied directly from the result placements.
  const placedById = new Map<string, number>()
  for (const p of placements) placedById.set(p.partId, (placedById.get(p.partId) ?? 0) + 1)

  const totalPlaced = placements.length
  const totalRequested = sources.reduce((a, s) => a + s.quantity, 0)
  const totalLeft = unplaced.reduce((a, u) => a + u.count, 0)
  // EXACT-mode shortfall: typed exactly N but fewer placed. Fill mode places a
  // ratio, so "fewer than typed" is expected there and never warns.
  const shortfall = exact ? Math.max(0, totalRequested - totalPlaced) : 0

  return (
    <div className="nest-result">
      <div className="nest-result-line">
        <strong>{totalPlaced}</strong>{tx('NestModal.placed')}{totalLeft > 0 && <>{tx('NestModal.symbol_2')}<strong>{totalLeft}</strong>{tx('NestModal.left_over')}</>}
        {' · '}
        <strong>{(utilization * 100).toFixed(1)}{tx('NestModal.symbol_3')}</strong>{tx('NestModal.utilization')}</div>
      {shortfall > 0 && (
        <div className="nest-result-shortfall" role="alert">{tx('NestModal.Couldn_t_fit_all_parts_didn_t_fit_Increase', { p1: shortfall })}</div>
      )}
      <div className="nest-result-parts">
        {sources.map((src) => {
          const requested = src.quantity
          const placedCount = placedById.get(src.geometryId) ?? 0
          const name = nameById.get(src.geometryId) ?? src.geometryId
          return (
            <div key={src.geometryId} className="nest-result-part">
              <span className="nest-result-part-name" data-tooltip={name}>{name}</span>
              <span className="nest-result-part-count">
                {placedCount}{exact ? ` / ${requested}` : ''}
              </span>
            </div>
          )
        })}
      </div>
    </div>
  )
}
