import { textFor, useText } from '../../i18n'
const words = textFor('setup-stock-tools-machine-post')
import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from 'react'
import {
  X,
  Download,
  FileCode2,
  Maximize2,
  RefreshCw,
  ChevronRight,
  ChevronDown,
  FilePen,
  Send,
} from 'lucide-react'
import { useCamStore } from '../../store'
import { operationGenerationIsCurrent } from '../../lib/cam/generationFingerprint'
import { useDialogFocus } from '../../hooks/useDialogFocus'
import {
  postProject,
  postSupportsProgramContextEnvelope,
  BUILT_IN_DIALECTS,
  downloadFilenameForConfig,
  extForConfig,
  parseUserPostConfig,
  importPostFile,
  registerUserPostController,
  serializeUserPostConfig,
  syncUserPostControllers,
  unregisterUserPostController,
  userPostDefinitionFilename,
  withUserPostWordTable,
  postToolNumbersOf,
  withPostToolNumber,
  isPostToolNumber,
} from '../../lib/post'
import type {
  PostConfig,
  PostResult,
  PostProjectResult,
  PostDiagnostic,
  ProgramEndMode,
  UserPostConfig,
} from '../../lib/post'
import {
  resolveSetupWorkOffset,
  findResolvedWorkOffsetConflicts,
  type ResolvedSetupWorkOffset,
} from '../../lib/post/workOffsets'
import { buildSetupSheetData, renderSetupSheetText, setupSheetFilenameFor } from '../../lib/post/setupSheet'
import { buildSetupSheetPdf, setupSheetPdfFilenameFor } from '../../lib/post/setupSheetPdf'
import { resolveDeclaredController } from '../../lib/machine/machineChoice'
import { DIM_DECIMALS, FEED_DECIMALS, unitLabel } from '../../lib/ui/unitFormat'
import { DisclosureSection } from '../ui/DisclosureSection'
import { ThemedListbox, type ThemedListboxItems } from '../ui/ThemedListbox'
import { useSelectAllOnClick } from '../ui/selectAllOnClick'
import type { Project, Setup, Tool, Units } from '../../types'
import {
  readRegisteredLocalData,
  writeRegisteredLocalData,
} from '../../store/persistedKeys'
import { stockWorldBounds } from '../../store/stockAssignment'
import { HelpLink } from '../ui/HelpLink'
import { ResizableSplit, SPLIT_BAR_PX } from '../common/ResizableSplit'
import { PanelCollapseToggle, usePanelCollapsed } from '../common/CollapsiblePanel'
import { saveFile } from '../../lib/saveFile'
import { operatorDownloadFilename } from '../../lib/post/downloadExtension'
import { GcodeEditor } from '../gcode/GcodeEditor'
import { readerMarks, withLineEndingsOf, withoutContextStamp, type GcodeLineMark } from '../gcode/gcodeEditing'
import { describeEdit, sendProgramToControl } from '../gcode/editedProgram'

// ============================================================
// Post Process dialog (C-P1d) — Screen 1 of the mockup.
// ============================================================
// Self-gated on activeModal === 'post-process', mounted unconditionally in
// App.tsx alongside the other modals. The properties form edits a LOCAL
// deep-cloned working copy of the selected PostConfig (never mutates the
// imported config). Every change rebuilds the PostInput and re-runs postProgram
// for the live preview + diagnostics (fail-loud, ADR-0003).
//
// Built-in templates (UCCNC / GRBL / Generic) are the starting samples. The
// user can clone the edited config to a named user post persisted in
// localStorage ("Save Post As...") or import a portable declarative JSON post
// definition. Spindle direction / coolant are derived per-operation by
// buildPostInput (from tool + machine), not from the PostConfig, so those rows
// are read-only notes. Arc controls (center mode, min radius, tolerance) are
// only rendered when the dialect actually emits arcs; UCCNC/GRBL are arcs:true
// (C-P2), so the section is live there and hidden for linear-only dialects.

// Built-in templates come from the shared dialect registry (single source of
// truth, also feeds the Machine Library controller dropdown).
const BUILT_INS: PostConfig[] = BUILT_IN_DIALECTS.filter((config) => config.builtin)

// Deep clone so the working copy never aliases the imported config.
function cloneConfig(c: PostConfig): PostConfig {
  return structuredClone(c)
}

/** Honest backing state for an unresolved machine. It borrows only the config
 * shape needed to keep the editor mounted; its empty id is not a dialect and
 * the post boundary refuses before this object can be dispatched. */
function undeclaredWorkingConfig(): PostConfig {
  return {
    ...cloneConfig(BUILT_INS[0]),
    id: '',
    label: words("PostProcessModal.controller_not_declared"),
    builtin: false,
  }
}

// ---- user-post localStorage store (minimal; full library is C-P5) ----------
function loadUserPosts(): UserPostConfig[] {
  try {
    const raw = readRegisteredLocalData('userPosts')
    if (!raw) return []
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((candidate) => {
      const result = parseUserPostConfig(JSON.stringify(candidate))
      return result.ok ? [result.config] : []
    })
  } catch {
    return []
  }
}

function saveUserPosts(posts: UserPostConfig[]): void {
  writeRegisteredLocalData('userPosts', JSON.stringify(posts))
}

// WO-2433: the old fixed split was two 720px columns.
const POST_PREVIEW_DEFAULT_PX = 720
const POST_PREVIEW_PANEL_KEY = 'post-process.preview'

// The pane limits are px, but the form inside them grows with the UI scale
// (rem sizing), so the limits grow with it. App.tsx publishes the resolved
// scale as --ui-scale on the root.
function readUiScale(): number {
  if (typeof document === 'undefined') return 1
  const raw = Number.parseFloat(document.documentElement.style.getPropertyValue('--ui-scale'))
  return Number.isFinite(raw) && raw > 0 ? raw : 1
}

type TabId ='properties' | 'preview' | 'about'
type PostActionNotice = { kind: 'success' | 'error'; message: string }

/** The hand-edit key of one separate-mode file: the setup it was posted from, so a
 *  change of extension, of which setups are output, or of the project's name never moves
 *  or loses an edit (WO-2651 reviews 10-07). The name stem is the fallback only. */
function separateEditKey(file: { filename: string; setupId?: string }): string {
  return file.setupId ? `setup:${file.setupId}` : `file:${file.filename.replace(/\.[^./\\]+$/, '')}`
}

export function PostProcessModal() {
  const words = useText('setup-stock-tools-machine-post')
  const ed = useText('gcode-editor')
  const activeModal = useCamStore((s) => s.activeModal)
  const isOpen = activeModal === 'post-process'
  const dialogFocusRef = useDialogFocus<HTMLDivElement>()
  const closeModal = useCamStore((s) => s.closeModal)
  // WO-2860: while Export stages a partial post, the store holds the staged
  // program - stageOperationsForEmission turns every unticked operation off
  // until restore() - not the operator's project. Read live, that program
  // re-seeded the Output Scope (the unticked operation came back ticked, H4)
  // and showed the operation the exclusion outdated as out of date, so the
  // auto-recompute below computed it a second time; that compute landed after
  // restore() and left it Outdated with its time gone from the setup (F7).
  // The dialog reads the project as it was when Export began until the
  // staging is restored.
  const stagedFromRef = useRef<Project | null>(null)
  const [, setStagingEnded] = useState(0)
  const project = useCamStore((s) => stagedFromRef.current ?? s.project)
  // Tool library is a ROOT slice (single source of truth); fed to the pure post
  // path via a merged project at the boundary so postProject sees the live lib.
  const toolLibrary = useCamStore((s) => s.toolLibrary)
  // CAM-BINDING Stage 5: reactive (not getState()) so the preview/gate
  // re-runs the instant the Model tab finishes its first real resolve pass
  // this session, without requiring the user to touch any other post option.
  const modelRefsVerifiedSinceLoad = useCamStore((s) => s.modelRefsVerifiedSinceLoad)
  // WO-2332: Post Process checks unverified model references itself (a
  // transient kernel replays each referenced Model Item) instead of sending
  // the operator to the Model tab first.
  const verifyModelReferences = useCamStore((s) => s.verifyModelReferences)
  const modelRefCheckInFlight = useCamStore((s) => s.modelRefCheckInFlight)
  const computeAllToolpaths = useCamStore((s) => s.computeAllToolpaths)
  const stageOperationsForEmission = useCamStore((s) => s.stageOperationsForEmission)
  const addConsoleEvent = useCamStore((s) => s.addConsoleEvent)
  // WO-1653: guards handleExport against re-entrancy while it stages a
  // recompute. Declared here (ahead of the `if (!isOpen) return null` below)
  // so this hook always runs, open or closed.
  const isExportingRef = useRef(false)
  // WO-2651: hand edits to the posted program, per previewed file ('combined'
  // or a separate file's name): `base` is the posted text the edit started
  // from, `text` the edited text Export and Send to Control carry.
  const [handEdits, setHandEdits] = useState<Record<string, { base: string; text: string }>>({})
  const [previewEditing, setPreviewEditing] = useState(false)
  // Hand edits belong to the project they were made in: New Project or opening another
  // project drops them, so a new project never exports an old one's program (review 10-07).
  const editsProjectId = useRef(project.id)
  useEffect(() => {
    if (editsProjectId.current === project.id) return
    editsProjectId.current = project.id
    setHandEdits({})
    setPreviewEditing(false)
  }, [project.id])
  // WO-2433: the preview pane's folded state (shared uiPrefs record).
  const previewCollapsed = usePanelCollapsed(POST_PREVIEW_PANEL_KEY)
  // App-global export unit (ADR-0022). Seeds the per-export override dropdown
  // below, which is the EFFECTIVE export unit this dialog feeds the post (drives
  // format.units + per-unit decimals at the export boundary).
  const exportUnits = useCamStore((s) => s.appSettings.exportUnits)

  // Per-export units OVERRIDE (Phase 3b). Defaults to the app-global preference
  // and the user can change it for this one export. This modal is mounted
  // unconditionally in App.tsx and only self-gates rendering (it never
  // unmounts), so the useState initializer alone would go stale if the global
  // preference changes while the dialog is closed; the useEffect below resyncs
  // the override to the global value whenever the global changes. (When the
  // global is 'mm' and the user never touches the dropdown, the effective value
  // stays 'mm' and the posted output is byte-identical to Phase 3.)
  const [standardExportUnitsOverride, setStandardExportUnitsOverride] = useState<Units>(exportUnits)
  // Vendor defaults belong to the vendor selection; retain the operator's
  // existing override for built-in/portable posts and for reopening the modal.
  const [vendorExportUnitsOverride, setVendorExportUnitsOverride] = useState<Units>(exportUnits)
  useEffect(() => {
    setStandardExportUnitsOverride(exportUnits)
    setVendorExportUnitsOverride(exportUnits)
  }, [exportUnits])

  useEffect(() => {
    if (isOpen && modelRefsVerifiedSinceLoad !== true) void verifyModelReferences()
  }, [isOpen, modelRefsVerifiedSinceLoad, verifyModelReferences])

  // ---- Output scope (E2 multi-setup selection) --------------------------------
  // All Operations reflects every enabled child in the setup/op tree.
  // Selection state:
  //   checkedSetups: setupId -> included in export (setup-level multi-select)
  //   checkedOps:    setupId -> Set<opId> of KEPT enabled ops within that setup
  // Opening starts on the setup the operator is working in; the master is
  // checked only if that already includes every enabled operation.
  const [outputMode, setOutputMode] = useState<'combined' | 'separate'>('combined')
  // App.tsx keeps this modal mounted. Names are session-only, per project and
  // selected operations; setup identity keeps separate names off neighboring files.
  const [exportNames, setExportNames] = useState<Record<string, string>>({})
  const [pauseBetweenSetups, setPauseBetweenSetups] = useState(false)
  const [expandedSetups, setExpandedSetups] = useState<Set<string>>(new Set())
  const [checkedSetups, setCheckedSetups] = useState<Set<string>>(new Set())
  const [checkedOps, setCheckedOps] = useState<Record<string, Set<string>>>({})

  // Enabled ops per setup (the only ops the post engine considers). Recomputed
  // whenever the visible project's selectable tree changes. The component is
  // always mounted, so hidden progress writes must not rebuild this tree.
  const enabledOpsBySetup = useMemo(() => {
    const m: Record<string, { id: string; name: string }[]> = {}
    if (!isOpen) return m
    for (const s of project.setups) {
      m[s.id] = s.operations
        .filter((o) => o.enabled)
        .map((o) => ({ id: o.id, name: o.name }))
    }
    return m
  }, [isOpen, project.setups])

  const selectableOpCount = Object.values(enabledOpsBySetup).reduce((n, ops) => n + ops.length, 0)
  const checkedOpCount = Object.entries(enabledOpsBySetup).reduce((n, [setupId, ops]) =>
    n + (checkedSetups.has(setupId) ? ops.filter(op => checkedOps[setupId]?.has(op.id)).length : 0), 0)
  const allOperations = selectableOpCount > 0 && checkedOpCount === selectableOpCount
  const someOperations = checkedOpCount > 0 && !allOperations

  // Resolve every setup through its physical stock using the SAME semantics as
  // the real post path (resolveSetupWorkOffset + findResolvedWorkOffsetConflicts).
  // Multiple setups cutting the SAME stock may share one G54-G59 offset; only
  // DIFFERENT physical owners (distinct stocks, or legacy unbound setups) on one
  // offset are a conflict. Resolution errors (malformed/dangling stock binding)
  // are swallowed here so the modal never throws during render; postProject
  // independently refuses the export with a named diagnostic on the same error,
  // so fail-loud posting behavior is preserved (ADR-0003).
  const resolvedWorkOffsets = useMemo(() => {
    const resolved: ResolvedSetupWorkOffset[] = []
    if (!isOpen) return resolved
    for (const setup of project.setups) {
      try {
        resolved.push(resolveSetupWorkOffset(project, setup))
      } catch {
        // Malformed setup/stock data: skip; the post path refuses export loud.
      }
    }
    return resolved
  }, [isOpen, project])

  // Work-offset conflicts across ALL project setups (export-blocking, fail-loud),
  // resolved through physical stock ownership so same-stock sharing is allowed.
  const conflicts = useMemo(
    () => findResolvedWorkOffsetConflicts(resolvedWorkOffsets),
    [resolvedWorkOffsets],
  )
  // setupId -> name of a DIFFERENT physical owner sharing the same resolved
  // offset (for the inline "conflicts with" badge). Same-stock sharing is
  // deliberately NOT a conflict.
  const conflictPartner = useMemo(() => {
    const m: Record<string, string> = {}
    for (const c of conflicts) {
      const owners: { ownerKey: string; ownerName: string; setupIds: string[] }[] = []
      for (const r of resolvedWorkOffsets) {
        if (r.fixtureOffset !== c.fixtureOffset) continue
        const ownerKey = r.stockId == null ? `setup:${r.setup.id}` : `stock:${r.stockId}`
        const ownerName = r.stockName ?? r.stockId ?? r.setup.name
        const existing = owners.find((o) => o.ownerKey === ownerKey)
        if (existing) existing.setupIds.push(r.setup.id)
        else owners.push({ ownerKey, ownerName, setupIds: [r.setup.id] })
      }
      for (const owner of owners) {
        const other = owners.find((o) => o.ownerKey !== owner.ownerKey)
        if (!other) continue
        for (const setupId of owner.setupIds) {
          m[setupId] = other.ownerName
        }
      }
    }
    return m
  }, [conflicts, resolvedWorkOffsets])

  // Resolved WCS label per setup (stock-override-aware). Falls back to the
  // setup-local label when resolution refused malformed data, so the modal still
  // renders an offset rather than throwing.
  const resolvedWcsLabel = useMemo(() => {
    const m: Record<string, string> = {}
    for (const r of resolvedWorkOffsets) {
      m[r.setup.id] = r.setup.wcs.label
    }
    return m
  }, [resolvedWorkOffsets])

  // The selection seed depends only on setup ids and enabled operation ids, not
  // on setup object identity. Progress writes immutably replace project.setups,
  // but preserve this signature, so they cannot re-seed over a user's choices.
  // JSON keeps ordering and avoids delimiter collisions in arbitrary ids.
  const selectionSeedSignature = useMemo(() => {
    if (!isOpen) return '[]'
    return JSON.stringify(project.setups.map((setup) => [
      setup.id,
      setup.operations.filter((operation) => operation.enabled).map((operation) => operation.id),
    ]))
  }, [isOpen, project.setups])

  // If the selectable tree changes while the dialog stays open, retain the
  // historical behavior of including every newly selectable setup/op. Progress
  // writes do not change this signature and therefore do not disturb choices.
  useEffect(() => {
    if (!isOpen) return
    const seed = JSON.parse(selectionSeedSignature) as [string, string[]][]
    setCheckedSetups(new Set(seed.map(([setupId]) => setupId)))
    setCheckedOps(Object.fromEntries(
      seed.map(([setupId, operationIds]) => [setupId, new Set(operationIds)]),
    ))
  }, [isOpen, selectionSeedSignature])

  // Every open is a fresh answer to "what am I working on?". This effect runs
  // after the selectable-tree seed above, so it is idempotent under StrictMode
  // and leaves only the active (or first available) setup selected.
  useEffect(() => {
    if (!isOpen) return
    const activeSetupId = project.setups.some((setup) => setup.id === project.activeSetupId)
      ? project.activeSetupId
      : project.setups[0]?.id ?? null
    setExpandedSetups(new Set(activeSetupId ? [activeSetupId] : []))
    setCheckedSetups(new Set(activeSetupId ? [activeSetupId] : []))
  }, [isOpen, project.activeSetupId])

  // User posts become controller definitions before resolving the machine, so
  // a persisted user-controller id works on the first render after reload.
  const [userPosts, setUserPosts] = useState<UserPostConfig[]>(() =>
    syncUserPostControllers(loadUserPosts()),
  )

  // Machine identity is resolved once for every post path. A legacy/unknown
  // value leaves the selector unchosen and becomes a normal post diagnostic;
  // no dialect is silently selected for it.
  const controllerResolution = useMemo(
    () => resolveDeclaredController(project.machine),
    [project.machine, userPosts],
  )
  const defaultPostId = controllerResolution.ok ? controllerResolution.dialect.id : ''

  const [selectedId, setSelectedId] = useState<string>(defaultPostId)
  const [working, setWorking] = useState<PostConfig>(() =>
    controllerResolution.ok
      ? cloneConfig(controllerResolution.dialect)
      : undeclaredWorkingConfig(),
  )
  const exportUnitsOverride = working.options.vendorPost ? vendorExportUnitsOverride : standardExportUnitsOverride
  const setExportUnitsOverride = working.options.vendorPost ? setVendorExportUnitsOverride : setStandardExportUnitsOverride
  const [tab, setTab] = useState<TabId>('properties')
  const [flyoutOpen, setFlyoutOpen] = useState(false)
  // Which separate-mode file the preview is showing (E2 follow-up: preview EACH
  // file, not just file 1). Combined mode ignores it. Clamped below so it never
  // points past the end when the selection/config changes the file list.
  const [previewFileIndex, setPreviewFileIndex] = useState(0)
  const [importError, setImportError] = useState<string | null>(null)
  const [postActionNotice, setPostActionNotice] = useState<PostActionNotice | null>(null)
  // WO-381: "Include LienCAM context". null = follow the post's default (ON for
  // a post certified for the envelope, OFF and disabled otherwise); a user
  // choice sticks until another post is selected. OFF is byte-for-byte the
  // historical output.
  const [contextChoice, setContextChoice] = useState<boolean | null>(null)
  const importInputRef = useRef<HTMLInputElement>(null)
  const selectAllNumeric = useSelectAllOnClick()

  // Refresh user posts from storage whenever the dialog (re)opens.
  useEffect(() => {
    if (isOpen) {
      setUserPosts(syncUserPostControllers(loadUserPosts()))
      setImportError(null)
      setPostActionNotice(null)
      if (!controllerResolution.ok) {
        setSelectedId('')
        setWorking(undeclaredWorkingConfig())
        addConsoleEvent({
          severity: 'error',
          source: 'post',
          message: controllerResolution.reason,
        })
      } else {
        // Every opening starts from the machine's format, including after a
        // saved-post choice. Choosing a format never edits that declaration.
        setSelectedId(controllerResolution.dialect.id)
        setWorking(cloneConfig(controllerResolution.dialect))
      }
    }
  }, [isOpen, project.machine])

  // Selecting a different post returns the context toggle to that post's default.
  useEffect(() => { setContextChoice(null) }, [selectedId])

  // The full selectable list = built-in templates + saved user posts.
  const allPosts = useMemo(() => [...BUILT_INS, ...userPosts], [userPosts])
  // Grouped options for the themed post-definition listbox (mirrors the two
  // <optgroup>s the native select used: Built-in templates / Saved posts).
  const postDefinitionOptions = useMemo<ThemedListboxItems>(() => {
    const groups: ThemedListboxItems = [
      {
        label: words("PostProcessModal.built_in_templates"),
        // Format choice is local to this export; the machine still supplies
        // limits and the opening default. Keep unresolved machines unchosen.
        options: (controllerResolution.ok ? BUILT_INS : [])
          .map((candidate) => ({ value: candidate.id, label: candidate.label })),
      },
      ...(userPosts.length > 0
        ? [{ label: words("PostProcessModal.saved_posts"), options: userPosts.map((c) => ({ value: c.id, label: c.label })) }]
        : []),
    ]
    return groups
  }, [controllerResolution.ok, userPosts])
  const selectedUserPost = userPosts.find((post) => post.id === selectedId)
  const isBuiltinSelected = BUILT_INS.some((post) => post.id === selectedId)

  const ext = extForConfig(working)
  // Base filename = project name (sanitized), falling back to 'program'.
  const baseName = useMemo(() => {
    const trimmed = (project.name ?? '').trim()
    return (trimmed || 'program').replace(/\s+/g, '_')
  }, [project.name])
  const combinedFilename = useMemo(
    () => downloadFilenameForConfig(project.name, working),
    [project.name, working],
  )

  // Every output route follows the checked setup/op selection. The aggregate
  // checkbox is display/action state: all enabled children can be selected while
  // an empty or disabled-only setup remains unchecked (WO-2862 audit).
  const scope = useMemo(() => {
    const setups: Setup[] = project.setups.filter((s) => checkedSetups.has(s.id))
    const selectedOpIds: Record<string, string[]> = {}
    for (const s of setups) {
      const enabledIds = (enabledOpsBySetup[s.id] ?? []).map((o) => o.id)
      const kept = enabledIds.filter((id) => checkedOps[s.id]?.has(id))
      // Omit the entry only when ALL enabled ops are kept (= keep all) AND there
      // is at least one op; otherwise pass the explicit (possibly empty) list so
      // a partially/fully-unchecked setup posts exactly the chosen ops.
      if (kept.length === enabledIds.length && enabledIds.length > 0) continue
      selectedOpIds[s.id] = kept
    }
    return { setups, selectedOpIds }
  }, [project.setups, checkedSetups, checkedOps, enabledOpsBySetup])

  // A pending operation has never produced toolpath bytes, so it cannot be in
  // a program. That fact does not make already-generated operations
  // unexportable: keep the requested scope for the UI, but narrow the post
  // boundary to the generated subset and say exactly what was omitted.
  const pendingSelections = useMemo(() => scope.setups.flatMap((setup) => {
    const selected = scope.selectedOpIds?.[setup.id]
    return setup.operations
      .filter((operation) => operation.enabled)
      .filter((operation) => selected === undefined || selected.includes(operation.id))
      .filter((operation) => operation.status === 'pending')
      .map((operation) => ({ setupName: setup.name, operation }))
  }), [scope])

  const postableScope = useMemo(() => {
    if (pendingSelections.length === 0) return scope
    const setups: Setup[] = []
    const selectedOpIds: Record<string, string[]> = {}
    for (const setup of scope.setups) {
      const selected = scope.selectedOpIds?.[setup.id]
      const postableIds = setup.operations
        .filter((operation) => operation.enabled)
        .filter((operation) => selected === undefined || selected.includes(operation.id))
        .filter((operation) => operation.status !== 'pending')
        .map((operation) => operation.id)
      if (postableIds.length === 0) continue
      setups.push(setup)
      const enabledCount = setup.operations.filter((operation) => operation.enabled).length
      if (postableIds.length !== enabledCount) selectedOpIds[setup.id] = postableIds
    }
    return { setups, selectedOpIds }
  }, [scope, pendingSelections])

  // Total selected (enabled) ops across the chosen setups — drives the empty
  // guard + the footer/preview counts.
  const selectedOpCount = useMemo(() => {
    let n = 0
    for (const s of scope.setups) {
      const enabledIds = (enabledOpsBySetup[s.id] ?? []).map((o) => o.id)
      const sel = scope.selectedOpIds?.[s.id]
      n += sel === undefined ? enabledIds.length : sel.length
    }
    return n
  }, [scope, enabledOpsBySetup])

  const postableOpCount = useMemo(() => {
    let n = 0
    for (const setup of postableScope.setups) {
      const enabledIds = (enabledOpsBySetup[setup.id] ?? []).map((operation) => operation.id)
      const selected = postableScope.selectedOpIds?.[setup.id]
      n += selected === undefined ? enabledIds.length : selected.length
    }
    return n
  }, [postableScope, enabledOpsBySetup])

  const pendingDiagnostic: PostDiagnostic | null = useMemo(() => {
    if (pendingSelections.length === 0) return null
    const names = pendingSelections
      .map(({ setupName, operation }) => `"${setupName} / ${operation.name}"`)
      .join(', ')
    const verb = pendingSelections.length === 1 ? words("PostProcessModal.is") : words("PostProcessModal.are")
    return {
      level: 'info',
      code: 'OPS_NOT_GENERATED',
      message: words("PostProcessModal.not_generated_and_will_not_be_included", { value1: names, value2: verb }),
    }
  }, [pendingSelections])

  // The config actually handed to the post: the working copy with its export
  // unit + per-unit decimals driven by the EFFECTIVE export unit (the dialog's
  // override, seeded from app-global exportUnits) (ADR-0022). For an effective
  // 'mm' this is identity (mm/3/1) so output stays byte-identical to today; for
  // 'inch' it sets units:'inch' + xyz 4 / feed 1.
  const exportConfig = useMemo<PostConfig>(() => {
    return {
      ...working,
      format: {
        ...working.format,
        units: exportUnitsOverride,
        xyzDecimals: working.options.vendorPost ? working.format.xyzDecimals : DIM_DECIMALS[exportUnitsOverride],
        feedDecimals: working.options.vendorPost ? working.format.feedDecimals : FEED_DECIMALS[exportUnitsOverride],
      },
    }
  }, [working, exportUnitsOverride])

  // WO-381: the envelope is offered only by a certified post (capability
  // declared after its compatibility-matrix row and tests). Absent = off.
  const contextReady = postSupportsProgramContextEnvelope(exportConfig)
  const includeContext = contextReady && (contextChoice ?? true)

  // Re-run the multi-setup orchestrator on every selection/config change. Cheap
  // (linear emit) and keeps the preview perfectly in sync (ADR-0003 fail-loud).
  const projectResult: PostProjectResult | null = useMemo(() => {
    if (!isOpen) return null
    if (!controllerResolution.ok) {
      return {
        ok: false,
        diagnostics: [
          {
            level: 'error',
            code: 'CONTROLLER_UNDECLARED',
            message: controllerResolution.reason,
          },
        ],
      }
    }
    try {
      return postProject({ ...project, toolLibrary }, postableScope.setups, exportConfig, {
        mode: outputMode,
        pauseBetweenSetups,
        selectedOpIds: postableScope.selectedOpIds,
        baseName,
        ext,
        // CAM-BINDING Stage 5: the session-scoped "has a real resolve pass
        // run against the live kernel since this project was opened" flag -
        // see postProject.ts's PostProjectOptions doc comment.
        modelRefsVerifiedSinceLoad,
        // WO-381: omitted (undefined) when off, so the historical output is
        // untouched; the orchestrator appends the LCX1 block only when asked.
        programContext: includeContext ? true : undefined,
      })
    } catch (err) {
      return {
        ok: false,
        diagnostics: [
          {
            level: 'error',
            code: 'POST_THREW',
            message: words("PostProcessModal.post_engine_threw", { value1: (err as Error)?.message ?? String(err) }),
          },
        ],
      }
    }
  }, [isOpen, project, toolLibrary, postableScope, exportConfig, outputMode, pauseBetweenSetups, baseName, ext, modelRefsVerifiedSinceLoad, includeContext])

  // WO-2788: an out-of-date operation in scope is recomputed, not refused
  // (rule 11). A restart is the common route: the browser copy of the project
  // never carries toolpath moves (persistPartialize, localStorage quota), so a
  // restored project opens with every operation out of date. Post recomputes
  // ONLY the out-of-date operations this post includes, one at a time in setup
  // order, so each reads its upstream's fresh result (the order Regenerate All
  // keeps, WO-2656/2661/2662); one that goes out of date because an earlier one
  // recomputed is recomputed when it is reached. A pending (never generated)
  // operation is not in the post (WO-2043) and is never computed here: it stays
  // omitted. Then ONE console line says what was recomputed. A genuine compute
  // failure leaves that operation 'error', which the preview still refuses with
  // its own reason. Each operation is tried once per opening, so a result that
  // stays out of date cannot loop, and closing Post stops a run between
  // operations.
  const [autoRecomputing, setAutoRecomputing] = useState<ReadonlySet<string> | null>(null)
  const autoRecomputeTried = useRef(new Set<string>())
  const postIsOpen = useRef(isOpen)
  // The running recompute, so Export (runFreshPost) waits for it rather than
  // being disabled behind the operations it is computing (WO-1653's rule).
  const autoRecomputeRun = useRef<Promise<void> | null>(null)
  useEffect(() => {
    postIsOpen.current = isOpen
    if (!isOpen) autoRecomputeTried.current = new Set()
  }, [isOpen])
  useEffect(() => {
    // WO-2860: Export's own staging recomputes what it posts.
    if (!isOpen || autoRecomputing || !projectResult || stagedFromRef.current) return
    const outdatedIds = new Set(
      projectResult.diagnostics
        .filter((d) => d.code === 'OP_OUTDATED' && d.opId && !autoRecomputeTried.current.has(d.opId))
        .map((d) => d.opId!),
    )
    if (outdatedIds.size === 0) return
    // The operations this post includes, per setup holding an out-of-date one.
    const work = postableScope.setups.flatMap((setup) => {
      const selected = postableScope.selectedOpIds?.[setup.id]
      const included = setup.operations
        .filter((op) => op.enabled && op.status !== 'pending')
        .filter((op) => selected === undefined || selected.includes(op.id))
        .map((op) => op.id)
      return included.some((id) => outdatedIds.has(id)) ? [{ setupId: setup.id, included }] : []
    })
    for (const id of outdatedIds) autoRecomputeTried.current.add(id)
    if (work.length === 0) return
    setAutoRecomputing(new Set(work.flatMap((w) => w.included)))
    const recomputed: string[] = []
    const recomputeSetup = async ({ setupId, included }: (typeof work)[number]) => {
      for (const opId of included) {
        if (!postIsOpen.current) return
        const state = useCamStore.getState()
        const setup = state.project.setups.find((s) => s.id === setupId)
        const op = setup?.operations.find((o) => o.id === opId)
        if (!setup || !op || !op.enabled) continue
        // Stale the way buildPostInput reads it: 'outdated', or 'ready' with a
        // fingerprint that no longer matches its inputs.
        const stale = op.status === 'outdated' || (op.status === 'ready' &&
          !operationGenerationIsCurrent({ ...state.project, toolLibrary: state.toolLibrary }, setup, op))
        if (!stale) continue
        autoRecomputeTried.current.add(opId)
        // A compute that throws is reported by the operation's own status.
        await state.computeOperationToolpath(setupId, opId).catch(() => {})
        const after = useCamStore.getState().project.setups
          .find((s) => s.id === setupId)?.operations.find((o) => o.id === opId)
        if (after?.status === 'ready') recomputed.push(`"${after.name}"`)
      }
    }
    // Setups run side by side, as Regenerate All runs them.
    const run = Promise.all(work.map(recomputeSetup)).then(() => {}).finally(() => {
      if (recomputed.length > 0) {
        addConsoleEvent({
          severity: 'info',
          source: 'post',
          message: words("PostProcessModal.recomputed_out_of_date_before_posting", {
            value1: recomputed.length,
            value2: recomputed.length === 1 ? '' : 's',
            value3: recomputed.join(', '),
          }),
        })
      }
      setAutoRecomputing(null)
      autoRecomputeRun.current = null
    })
    autoRecomputeRun.current = run
  }, [isOpen, autoRecomputing, projectResult, postableScope, addConsoleEvent])

  // WO-381: what the toggle's hint says. The orchestrator's own reason wins
  // (multi-setup, partial selection, size cap, not certified); otherwise a
  // short statement of what the block is.
  const contextHint = useMemo(() => {
    if (!contextReady) return words("PostProcessModal.the_post_is_not_certified_for_liencam", { value1: working.label })
    if (!includeContext) return words("PostProcessModal.off_the_file_is_the_plain_program")
    if (!projectResult || !projectResult.ok) return words("PostProcessModal.setup_information_is_written_after_m30_as")
    if (outputMode === 'combined') {
      const status = projectResult.combined?.programContextEnvelope
      if (status && !status.included) return status.reason
      // WO-412: a combined multi-setup program carries one block listing every setup.
      if (status?.included) {
        return status.setupCount > 1
          ? words("PostProcessModal.setup_information_for_setups_written_after_m30", { value1: status.setupCount, value2: status.lines })
          : words("PostProcessModal.setup_information_written_after_m30_as_comment", { value1: status.lines })
      }
      return words("PostProcessModal.setup_information_is_written_after_m30_as")
    }
    const statuses = (projectResult.files ?? []).map((f) => f.result.programContextEnvelope)
    const refused = statuses.find((s) => s && !s.included)
    if (refused && !refused.included) return refused.reason
    return words("PostProcessModal.each_file_carries_its_own_setup_information")
  }, [contextReady, includeContext, projectResult, outputMode, working.label])

  // Separate-mode file list (empty for combined / when nothing emitted).
  const separateFiles = useMemo(
    () => (outputMode === 'separate' ? projectResult?.files ?? [] : []),
    [outputMode, projectResult],
  )

  const filenameScope = (setup: Setup) => [
    setup.id, (scope.selectedOpIds?.[setup.id] ?? enabledOpsBySetup[setup.id]?.map(op => op.id) ?? []).slice().sort(),
  ]
  const combinedNameKey = JSON.stringify([project.id, 'combined', scope.setups.map(filenameScope).sort(
    (a, b) => String(a[0]).localeCompare(String(b[0])),
  )])
  const separateNameKey = (file: { filename: string; setupId?: string }) => {
    const setup = scope.setups.find(candidate => candidate.id === file.setupId)
    return JSON.stringify([project.id, 'separate', setup ? filenameScope(setup) : separateEditKey(file)])
  }
  const namedDownload = (key: string, defaultFilename: string) =>
    operatorDownloadFilename(exportNames[key], defaultFilename, working)
  const combinedExportFilename = namedDownload(combinedNameKey, combinedFilename)
  const filenameField = (key: string, defaultFilename: string, label: string) => (
    <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flex: '1 1 22rem', minWidth: 0 }}>
      <span className="mform-label" style={{ minWidth: 'auto' }}>{label}</span>
      <input
        className="mform-input"
        type="text"
        value={exportNames[key] ?? defaultFilename}
        onChange={event => {
          // Replace forbidden characters visibly while typing. Trim/extension
          // completion waits for blur so spaces and a typed dot remain editable.
          const value = Array.from(event.target.value, char => char.charCodeAt(0) < 32 ? '-' : char)
            .join('').replace(/[<>:"/\\|?*]/g, '-')
          setExportNames(names => ({ ...names, [key]: value }))
        }}
        onBlur={() => setExportNames(names => names[key] === undefined ? names : ({
          ...names, [key]: operatorDownloadFilename(names[key], defaultFilename, working),
        }))}
      />
    </label>
  )

  // Keep previewFileIndex in range: reset to 0 whenever the file list shrinks
  // past it (selection/config change) so it never indexes off the end.
  useEffect(() => {
    if (previewFileIndex !== 0 && previewFileIndex >= separateFiles.length) {
      setPreviewFileIndex(0)
    }
  }, [separateFiles.length, previewFileIndex])

  // The PostResult to PREVIEW: combined program, or the SELECTED separate file.
  const result: PostResult | null = useMemo(() => {
    if (!projectResult) return null
    if (outputMode === 'combined') return projectResult.combined ?? null
    const idx = previewFileIndex < separateFiles.length ? previewFileIndex : 0
    return separateFiles[idx]?.result ?? null
  }, [projectResult, outputMode, separateFiles, previewFileIndex])

  // Filename of the previewed separate file (labels the preview pane).
  const previewFilename = useMemo(() => {
    if (outputMode !== 'separate' || separateFiles.length === 0) return null
    const idx = previewFileIndex < separateFiles.length ? previewFileIndex : 0
    return separateFiles[idx]?.filename ?? null
  }, [outputMode, separateFiles, previewFileIndex])

  // WO-2651: the previewed file's hand edit, and whether the post moved on
  // under it (a setting changed or the program was re-posted). Edits are never
  // dropped silently: the preview asks to keep them or re-post.
  // Separate files are keyed by their file name without its extension: a setting
  // that changes the extension leaves the edit on its file, and a change in which
  // setups are output never moves one setup's edit onto another's file (review
  // 10-07: keyed by list place, a deselected setup's edit exported as the next one).
  const editKey = outputMode === 'separate'
    ? separateEditKey(separateFiles[previewFileIndex < separateFiles.length ? previewFileIndex : 0] ?? { filename: '' })
    : 'combined'
  const handEdit = handEdits[editKey] ?? null
  const postedText = result?.gcode ?? ''
  const editsStale = handEdit !== null && postedText.length > 0 && handEdit.base !== postedText
    && withoutContextStamp(handEdit.base) !== withoutContextStamp(postedText)
  const shownGcode = handEdit?.text ?? postedText
  const handEditSummary = useMemo(
    () => (handEdit ? describeEdit(handEdit.base, handEdit.text) : null),
    [handEdit],
  )
  const setHandEdit = (text: string | null) => {
    setHandEdits((all) => {
      const { [editKey]: _dropped, ...rest } = all
      if (text === null) return rest
      const base = all[editKey]?.base ?? postedText
      return text === base ? rest : { ...rest, [editKey]: { base, text: withLineEndingsOf(base, text) } }
    })
  }
  const keepHandEdit = () => {
    if (handEdit) setHandEdits((all) => ({ ...all, [editKey]: { base: postedText, text: handEdit.text } }))
  }

  // Diagnostics for the preview pane. Combined: the orchestrator's own list.
  // Separate: the SELECTED file's diagnostics, prepended with any orchestrator-
  // level diagnostics (e.g. DUPLICATE_WORK_OFFSET) that are not tied to one file
  // so export-blocking conflicts still surface no matter which file is shown.
  const previewDiagnostics: PostDiagnostic[] | null = useMemo(() => {
    if (!projectResult) return null
    // WO-2332: while the model-reference check runs, the footer says so; the
    // "not checked yet" refusal it is about to answer is not shown meanwhile.
    // WO-2788: likewise, an operation Post is recomputing shows no "out of
    // date" refusal while the recompute it is waiting on runs.
    const shown = (diags: PostDiagnostic[]): PostDiagnostic[] => diags.filter((d) =>
      !(modelRefCheckInFlight && d.code === 'OP_MODEL_REFS_UNVERIFIED') &&
      !(d.code === 'OP_OUTDATED' && d.opId && autoRecomputing?.has(d.opId)))
    if (outputMode === 'combined') {
      return pendingDiagnostic
        ? shown([...(projectResult.diagnostics ?? []), pendingDiagnostic])
        : projectResult.diagnostics ? shown(projectResult.diagnostics) : null
    }
    const orchestrator = (projectResult.diagnostics ?? []).filter(
      (d) => d.code === 'DUPLICATE_WORK_OFFSET' || d.code === 'POST_THREW' || d.code === 'CONTROLLER_UNDECLARED',
    )
    const fileDiags = result?.diagnostics ?? []
    return shown([...orchestrator, ...fileDiags, ...(pendingDiagnostic ? [pendingDiagnostic] : [])])
  }, [projectResult, outputMode, result, pendingDiagnostic, modelRefCheckInFlight, autoRecomputing])

  // WO-2637 (Operator ruling 2026-10-06): two different tools in one program sharing a
  // tool number do not post; this screen names them and lets the operator give
  // one its own number FOR THIS PROGRAM. Rows: every tool in a conflict (from
  // any file's TOOL_NUMBER_DUPLICATE), plus every tool the project already
  // posts under its own number, so a chosen number stays visible and undoable.
  const postToolNumbers = useMemo(() => postToolNumbersOf(project), [project])
  const toolNumberRows = useMemo((): ToolNumberRow[] => {
    if (!projectResult) return []
    const all = [
      ...(projectResult.diagnostics ?? []),
      ...(projectResult.combined?.diagnostics ?? []),
      ...(projectResult.files ?? []).flatMap((file) => file.result.diagnostics),
    ]
    const sharesWith = new Map<string, Set<string>>()
    const postsAs = new Map<string, number>()
    for (const d of all) {
      if (d.code !== 'TOOL_NUMBER_DUPLICATE' || !d.toolIds || d.toolNumber === undefined) continue
      for (const id of d.toolIds) {
        postsAs.set(id, d.toolNumber)
        const partners = sharesWith.get(id) ?? new Set<string>()
        for (const other of d.toolIds) if (other !== id) partners.add(other)
        sharesWith.set(id, partners)
      }
    }
    const used = new Set(project.setups.flatMap((setup) => setup.operations.map((op) => op.toolId)))
    const ids = [...sharesWith.keys(), ...Object.keys(postToolNumbers).filter((id) => used.has(id) && !sharesWith.has(id))]
    const byId = new Map(toolLibrary.map((tool) => [tool.id, tool]))
    return ids.flatMap((id) => {
      const tool = byId.get(id)
      if (!tool) return []
      return [{
        tool,
        postsAs: postToolNumbers[id] ?? postsAs.get(id) ?? tool.toolNumber,
        sharesWith: [...(sharesWith.get(id) ?? [])].map((other) => byId.get(other)?.name ?? other),
      }]
    })
  }, [projectResult, project.setups, postToolNumbers, toolLibrary])

  if (!isOpen) return null

  // WO-2637: the number a tool posts as in this project's programs. It rides on
  // the project (saved with it, so a re-post keeps it); the tool library keeps
  // its own number. Null takes it away.
  const setPostToolNumber = (tool: Tool, n: number | null) => {
    useCamStore.setState((s) => {
      const next = withPostToolNumber(postToolNumbersOf(s.project), tool, n)
      const { postToolNumbers: _previous, ...rest } = s.project
      return {
        project: { ...rest, ...(next ? { postToolNumbers: next } : {}), updatedAt: new Date().toISOString() },
      }
    })
  }

  // ---- working-copy mutators (always clone-then-set, never mutate state) ----
  const patch = (fn: (draft: PostConfig) => void) =>
    setWorking((prev) => {
      const next = cloneConfig(prev)
      fn(next)
      return next
    })

  const onSelectPost = (id: string) => {
    const selected = allPosts.find((c) => c.id === id)
    if (!selected) return
    setSelectedId(id)
    setWorking(cloneConfig(selected))
    if (selected.options.vendorPost) setVendorExportUnitsOverride(selected.format.units)
  }

  // ---- Save Post As... : clone working config to a named user post ----------
  const handleSavePostAs = () => {
    const name = window.prompt(
      words("PostProcessModal.name_for_this_saved_post"),
      words("PostProcessModal.customLabel", { label: working.label }),
    )
    if (!name || !name.trim()) return
    setPostActionNotice(null)
    try {
      const id = `user-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`
      const saved = withUserPostWordTable({
        ...cloneConfig(working),
        id,
        label: name.trim(),
        builtin: false,
      })
      const next = [...userPosts, saved]
      saveUserPosts(next)
      registerUserPostController(saved)
      setUserPosts(next)
      setSelectedId(id)
      setWorking(cloneConfig(saved))
      setPostActionNotice({ kind: 'success', message: words("PostProcessModal.saved", { value1: saved.label }) })
      addConsoleEvent({
        severity: 'success',
        source: 'post',
        message: words("PostProcessModal.saved_user_post", { value1: saved.label }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : words("PostProcessModal.browser_storage_refused_the_post")
      setPostActionNotice({ kind: 'error', message: words("PostProcessModal.save_failed", { value1: message }) })
      addConsoleEvent({
        severity: 'error',
        source: 'post',
        message: words("PostProcessModal.post_save_failed", { value1: message }),
      })
    }
  }

  const handleImportPost = async (file: File | undefined) => {
    if (!file) return
    setImportError(null)
    setPostActionNotice(null)
    try {
      if (!/\.(pp|cps|scpost|pst)$/i.test(file.name) && file.size > 256 * 1024) {
        throw new Error(words("PostProcessModal.post_definition_is_larger_than_the_256"))
      }
      const bytes = typeof file.arrayBuffer === 'function'
        ? new Uint8Array(await file.arrayBuffer())
        : new TextEncoder().encode(await file.text())
      const parsed = importPostFile(new TextDecoder().decode(bytes), file.name, bytes)
      if (!parsed.ok) throw new Error(parsed.error)
      const id = `user-import-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`
      const imported = withUserPostWordTable({ ...cloneConfig(parsed.config), id, builtin: false })
      const next = [...userPosts, imported]
      saveUserPosts(next)
      registerUserPostController(imported)
      setUserPosts(next)
      setSelectedId(id)
      setWorking(cloneConfig(imported))
      if (imported.options.vendorPost) setVendorExportUnitsOverride(imported.format.units)
      setPostActionNotice({ kind: 'success', message: words("PostProcessModal.imported", { value1: imported.label }) })
      addConsoleEvent({
        severity: 'success',
        source: 'post',
        message: words("PostProcessModal.imported_post_definition", { value1: imported.label }),
      })
      for (const message of parsed.report ?? []) {
        addConsoleEvent({ severity: 'info', source: 'post', message })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : words("PostProcessModal.post_definition_could_not_be_imported")
      setImportError(message)
      setPostActionNotice({ kind: 'error', message: words("PostProcessModal.import_failed", { value1: message }) })
      addConsoleEvent({
        severity: 'error',
        source: 'post',
        message: words("PostProcessModal.post_import_failed", { value1: message }),
      })
    } finally {
      if (importInputRef.current) importInputRef.current.value = ''
    }
  }

  const handleDeletePost = async () => {
    const selected = userPosts.find((post) => post.id === selectedId)
    if (!selected || isBuiltinSelected) {
      const message = words("PostProcessModal.only_a_selected_custom_post_can_be")
      setPostActionNotice({ kind: 'error', message })
      addConsoleEvent({ severity: 'error', source: 'post', message: words("PostProcessModal.post_delete_failed", { value1: message }) })
      return
    }
    // WO-1268: themed dialog. A saved post lives in this browser's storage and
    // no Undo restores it, so the prompt is legitimate.
    const ok = await useCamStore.getState().requestConfirm({
      title: words("PostProcessModal.delete_saved_post", { value1: selected.label }),
      body: words("PostProcessModal.it_is_removed_from_this_browser_undo"),
      confirmLabel: words("PostProcessModal.delete"),
      cancelLabel: words("PostProcessModal.cancel"),
      tone: 'danger',
    })
    if (!ok) return
    setPostActionNotice(null)
    try {
      const next = userPosts.filter((post) => post.id !== selected.id)
      saveUserPosts(next)
      unregisterUserPostController(selected.id)
      setUserPosts(next)
      if (controllerResolution.ok) {
        setSelectedId(controllerResolution.dialect.id)
        setWorking(cloneConfig(controllerResolution.dialect))
      } else {
        setSelectedId('')
        setWorking(undeclaredWorkingConfig())
      }
      setPostActionNotice({ kind: 'success', message: words("PostProcessModal.deleted", { value1: selected.label }) })
      addConsoleEvent({
        severity: 'success',
        source: 'post',
        message: words("PostProcessModal.deleted_user_post", { value1: selected.label }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : words("PostProcessModal.browser_storage_refused_the_change")
      setPostActionNotice({ kind: 'error', message: words("PostProcessModal.delete_failed", { value1: message }) })
      addConsoleEvent({
        severity: 'error',
        source: 'post',
        message: words("PostProcessModal.post_delete_failed", { value1: message }),
      })
    }
  }

  // Summarise the export, including stock overrides, pending omissions and
  // setups with no kept operations (postProject omits those empty sections).
  // Keep the resolved-label fallback for malformed data; posting diagnoses it.
  const wcsLabel = [...new Set(postableScope.setups
    .filter((setup) => {
      const selected = postableScope.selectedOpIds?.[setup.id]
      return setup.operations.some((op) => op.enabled &&
        (selected === undefined || selected.includes(op.id)))
    })
    .map((setup) => resolvedWcsLabel[setup.id] ?? setup.wcs?.label ?? '—'))]
    .join(', ') || '—'

  // Header summary: scope of this export (driven by the selection).
  const setupCount = scope.setups.length
  const headerScope = allOperations && setupCount === project.setups.length
    ? words("PostProcessModal.setup_all_operations", { value1: setupCount, value2: setupCount === 1 ? '' : 's' })
    : words("PostProcessModal.setup_operation", { value1: setupCount, value2: setupCount === 1 ? '' : 's', value3: selectedOpCount, value4: selectedOpCount === 1 ? '' : 's' })

  // ---- empty-selection guard: zero setups or zero ops chosen ----
  const nothingSelected = postableScope.setups.length === 0 || postableOpCount === 0

  // ---- single anchor download helper ----
  const downloadFile = (filename: string, contents: string | Blob, mimeType = 'text/plain') => {
    void saveFile(filename, contents, mimeType)
  }

  const handleSharePost = () => {
    setPostActionNotice(null)
    try {
      const source = serializeUserPostConfig(working)
      const filename = userPostDefinitionFilename(working)
      downloadFile(filename, source, 'application/json')
      setPostActionNotice({ kind: 'success', message: words("PostProcessModal.downloaded", { value1: filename }) })
      addConsoleEvent({
        severity: 'success',
        source: 'post',
        message: words("PostProcessModal.shared_post_definition", { value1: filename }),
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : words("PostProcessModal.post_definition_could_not_be_downloaded")
      setPostActionNotice({ kind: 'error', message: words("PostProcessModal.share_failed", { value1: message }) })
      addConsoleEvent({
        severity: 'error',
        source: 'post',
        message: words("PostProcessModal.post_share_failed", { value1: message }),
      })
    }
  }

  // ---- export: combined -> one file; separate -> sequential anchor clicks ----
  // WO-1653: OP_OUTDATED is exactly the case handleExport's stageOperationsForEmission
  // recomputes before writing a byte (rule 11 - the software can do it, so it must not
  // refuse first). Excluding it here is what makes that recompute reachable by a real
  // click; every other error (a genuinely uncomputable op, a bad WCS, a missing tool
  // number) still blocks - only a recompute-fixable staleness does not.
  // WO-2788: neither does an operation Post's own recompute is computing -
  // Export waits for that recompute (runFreshPost) and then decides.
  const exportBlockingDiagnostics = (projectResult?.diagnostics ?? []).filter(
    (d) => d.level === 'error' && d.code !== 'OP_OUTDATED' && !(autoRecomputing && d.code === 'OP_COMPUTING'),
  )
  const canExport = !!projectResult && exportBlockingDiagnostics.length === 0 && !nothingSelected && !modelRefCheckInFlight
  // WO UI-11B POST lane: generate success/refusal/error emit console events.
  // Modal behavior (downloads, disabled state) is entirely unchanged — the
  // events are purely additive.
  //
  // WO-1653: THE MOMENT CODE LEAVES THE APP. `projectResult` is a live preview
  // memo that can be showing an OP_OUTDATED refusal, or (with a partial
  // selection) a toolpath that still assumes an unselected predecessor's cut -
  // both cases this order says the software can fix itself. Export stages a
  // recompute against exactly what is about to go out (nothing selected
  // counts as disabled, WO-1653's own rule) and rebuilds the program from live
  // state before writing a single byte, instead of reusing the preview.
  // WO-1842: shared by the G-code export and the setup-sheet download so a
  // sheet is always built from the SAME fresh, staged-recompute post those
  // bytes came from (never the live preview memo, which can be stale).
  const runFreshPost = async (): Promise<{
    result: PostProjectResult
    project: Project
    setups: Setup[]
  }> => {
    const restores: Array<() => void> = []
    try {
      await autoRecomputeRun.current
      // WO-2332: never post ahead of an unfinished model-reference check.
      await useCamStore.getState().verifyModelReferences()
      stagedFromRef.current = useCamStore.getState().project
      for (const s of postableScope.setups) {
        const staged = await stageOperationsForEmission(s.id, postableScope.selectedOpIds?.[s.id])
        restores.push(staged.restore)
      }
      try {
        const freshState = useCamStore.getState()
        const freshProject = { ...freshState.project, toolLibrary: freshState.toolLibrary }
        const freshSetups = postableScope.setups.map(
          (s) => freshProject.setups.find((fs) => fs.id === s.id) ?? s,
        )
        const result = postProject(freshProject, freshSetups, exportConfig, {
          mode: outputMode,
          pauseBetweenSetups,
          selectedOpIds: postableScope.selectedOpIds,
          baseName,
          ext,
          modelRefsVerifiedSinceLoad: freshState.modelRefsVerifiedSinceLoad,
          programContext: includeContext ? true : undefined,
        })
        return { result, project: freshProject, setups: freshSetups }
      } catch (err) {
        return {
          result: {
            ok: false,
            diagnostics: [{
              level: 'error',
              code: 'POST_THREW',
              message: words("PostProcessModal.post_engine_threw", { value1: (err as Error)?.message ?? String(err) }),
            }],
          },
          project: useCamStore.getState().project,
          setups: postableScope.setups,
        }
      }
    } finally {
      stagedFromRef.current = null
      restores.forEach((restore) => restore())
      setStagingEnded((n) => n + 1)
    }
  }

  const handleExport = async () => {
    if (nothingSelected) {
      addConsoleEvent({ severity: 'warning', source: 'post', message: words("PostProcessModal.post_export_refused_nothing_selected") })
      return
    }
    if (isExportingRef.current) return
    isExportingRef.current = true
    let result: PostProjectResult
    try {
      ;({ result } = await runFreshPost())
    } finally {
      isExportingRef.current = false
    }

    if (!result.ok) {
      const errDiag = result.diagnostics.find((d) => d.level === 'error')
      addConsoleEvent({
        severity: errDiag ? 'error' : 'warning',
        source: 'post',
        message: errDiag
          ? words("PostProcessModal.post_export_blocked", { value1: errDiag.message })
          : words("PostProcessModal.post_export_refused_not_ready"),
      })
      return
    }
    if (outputMode === 'combined') {
      const gcode = result.combined?.gcode ?? ''
      if (gcode.length === 0) {
        addConsoleEvent({ severity: 'warning', source: 'post', message: words("PostProcessModal.post_export_refused_no_g_code_was") })
        return
      }
      // WO-2651: the hand-edited text is what is written, byte for byte.
      const edited = handEdits.combined
      downloadFile(combinedExportFilename, edited ? edited.text : gcode)
      addConsoleEvent({
        severity: 'success', source: 'post',
        message: edited
          ? ed('post.exportedEdited', { name: combinedExportFilename, summary: describeEdit(edited.base, edited.text) })
          : words("PostProcessModal.posted_lines", { value1: combinedExportFilename, value2: result.combined?.meta?.lineCount ?? 0 }),
      })
      return
    }
    // Separate: download each file sequentially with a small delay so the
    // browser does not coalesce/drop rapid programmatic downloads. No zip.
    const files = result.files ?? []
    let downloaded = 0
    for (let i = 0; i < files.length; i++) {
      const f = files[i]
      if (f.result.gcode.length === 0) continue
      const edited = handEdits[separateEditKey(f)]
      const filename = namedDownload(separateNameKey(f), f.filename)
      downloadFile(filename, edited ? edited.text : f.result.gcode)
      addConsoleEvent({
        severity: 'success', source: 'post',
        message: edited
          ? ed('post.exportedEdited', { name: filename, summary: describeEdit(edited.base, edited.text) })
          : words("PostProcessModal.posted_lines", { value1: filename, value2: f.result.meta?.lineCount ?? 0 }),
      })
      downloaded++
      if (i < files.length - 1) {
        await new Promise((r) => setTimeout(r, 220))
      }
    }
    if (downloaded === 0) {
      addConsoleEvent({ severity: 'warning', source: 'post', message: words("PostProcessModal.post_export_refused_no_g_code_was_2") })
    } else {
      addConsoleEvent({ severity: 'success', source: 'post', message: words("PostProcessModal.posted_file", { value1: downloaded, value2: downloaded === 1 ? '' : 's' }) })
    }
  }

  // WO-2651: SEND TO CONTROL - the program Export would write (the fresh
  // post, with the hand edits), handed to Control's own Load path. Separate
  // output sends the file being previewed.
  const handleSendToControl = async () => {
    if (nothingSelected) {
      addConsoleEvent({ severity: 'warning', source: 'post', message: words("PostProcessModal.post_export_refused_nothing_selected") })
      return
    }
    if (isExportingRef.current) return
    isExportingRef.current = true
    let result: PostProjectResult
    try {
      ;({ result } = await runFreshPost())
    } finally {
      isExportingRef.current = false
    }
    const errDiag = result.ok ? undefined : result.diagnostics.find((d) => d.level === 'error')
    const fileIndex = previewFileIndex < (result.files?.length ?? 0) ? previewFileIndex : 0
    const file = outputMode === 'combined'
      ? (result.combined ? { filename: combinedFilename, gcode: result.combined.gcode } : null)
      : (() => {
        const chosen = result.files?.[fileIndex]
        return chosen ? { filename: chosen.filename, setupId: chosen.setupId, gcode: chosen.result.gcode } : null
      })()
    if (!result.ok || !file || file.gcode.length === 0) {
      addConsoleEvent({
        severity: errDiag ? 'error' : 'warning',
        source: 'post',
        message: errDiag
          ? words("PostProcessModal.post_export_blocked", { value1: errDiag.message })
          : words("PostProcessModal.post_export_refused_no_g_code_was"),
      })
      return
    }
    const edited = handEdits[outputMode === 'combined' ? 'combined' : separateEditKey(file)]
    const text = edited ? edited.text : file.gcode
    sendProgramToControl({ name: file.filename, text, ...(edited ? { base: edited.base } : {}) })
    addConsoleEvent({
      severity: 'success',
      source: 'post',
      message: ed('post.sentToControl', {
        name: file.filename,
        lines: text.replace(/\r?\n$/, '').split(/\r?\n/).length.toLocaleString(),
        edited: edited ? ed('post.sentEdited', { summary: describeEdit(edited.base, edited.text) }) : '',
      }),
    })
    closeModal()
    useCamStore.getState().setWorkspace('control')
  }

  // WO-1842/WO-2293: text and PDF setup sheets for the same program the Export button
  // writes, downloaded from its own control next to it. Re-runs the SAME
  // staged-recompute fresh post (runFreshPost) so the sheet's NC line ranges,
  // byte length and SHA-256 always describe bytes that exist (the file this
  // click, or the matching Export click, actually writes) — never the live
  // preview memo. 'separate' mode downloads one sheet per file, matched to its
  // file by the same `-G<offset>` filename postProject itself derives.
  const handleDownloadSetupSheet = async () => {
    if (nothingSelected) {
      addConsoleEvent({ severity: 'warning', source: 'post', message: words("PostProcessModal.setup_sheet_refused_nothing_selected") })
      return
    }
    if (isExportingRef.current) return
    isExportingRef.current = true
    let fresh: Awaited<ReturnType<typeof runFreshPost>>
    try {
      fresh = await runFreshPost()
    } finally {
      isExportingRef.current = false
    }
    const { result, project: freshProject, setups: freshSetups } = fresh

    if (!result.ok) {
      const errDiag = result.diagnostics.find((d) => d.level === 'error')
      addConsoleEvent({
        severity: errDiag ? 'error' : 'warning',
        source: 'post',
        message: errDiag
          ? words("PostProcessModal.setup_sheet_refused", { value1: errDiag.message })
          : words("PostProcessModal.setup_sheet_refused_not_ready"),
      })
      return
    }

    if (outputMode === 'combined') {
      const gcode = result.combined?.gcode ?? ''
      if (gcode.length === 0) {
        addConsoleEvent({ severity: 'warning', source: 'post', message: words("PostProcessModal.setup_sheet_refused_no_g_code_was") })
        return
      }
      const sheet = await buildSetupSheetData(freshProject, freshSetups, exportConfig, result.combined!, combinedFilename, stockWorldBounds, postableScope.selectedOpIds)
      const textName = setupSheetFilenameFor(combinedFilename)
      const pdfName = setupSheetPdfFilenameFor(combinedFilename)
      const pdf = buildSetupSheetPdf(sheet, gcode)
      downloadFile(textName, renderSetupSheetText(sheet), 'text/plain')
      await new Promise((r) => setTimeout(r, 220))
      downloadFile(pdfName, new Blob([pdf], { type: 'application/pdf' }), 'application/pdf')
      addConsoleEvent({ severity: 'success', source: 'post', message: words("PostProcessModal.downloaded_and", { value1: textName, value2: pdfName }) })
      return
    }

    const files = result.files ?? []
    let downloaded = 0
    const downloadedNames: string[] = []
    for (let i = 0; i < freshSetups.length; i++) {
      const setup = freshSetups[i]
      const resolved = resolveSetupWorkOffset(freshProject, setup)
      const expectedFilename = `${baseName}-G${resolved.fixtureOffset}.${ext}`
      const file = files.find((f) => f.filename === expectedFilename)
      if (!file || file.result.gcode.length === 0) continue
      const sheet = await buildSetupSheetData(freshProject, [setup], exportConfig, file.result, file.filename, stockWorldBounds, postableScope.selectedOpIds)
      const textName = setupSheetFilenameFor(file.filename)
      const pdfName = setupSheetPdfFilenameFor(file.filename)
      const pdf = buildSetupSheetPdf(sheet, file.result.gcode)
      downloadFile(textName, renderSetupSheetText(sheet), 'text/plain')
      await new Promise((r) => setTimeout(r, 220))
      downloadFile(pdfName, new Blob([pdf], { type: 'application/pdf' }), 'application/pdf')
      downloadedNames.push(textName, pdfName)
      downloaded++
      if (downloaded < files.length) {
        await new Promise((r) => setTimeout(r, 220))
      }
    }
    if (downloaded === 0) {
      addConsoleEvent({ severity: 'warning', source: 'post', message: words("PostProcessModal.setup_sheet_refused_no_g_code_was_2") })
    } else {
      addConsoleEvent({ severity: 'success', source: 'post', message: words("PostProcessModal.downloaded", { value1: downloadedNames.join(', ') }) })
    }
  }

  const handleCopyGcode = async (gcode: string) => {
    const copyFailure = (message: string) => {
      addConsoleEvent({
        severity: 'error',
        source: 'post',
        message: words("PostProcessModal.g_code_copy_failed", { value1: message }),
      })
      return new Error(message)
    }
    if (!navigator.clipboard?.writeText) {
      throw copyFailure(words("PostProcessModal.clipboard_access_is_unavailable_select_the_g"))
    }
    try {
      await navigator.clipboard.writeText(gcode)
      const lineCount = gcode.replace(/\n$/, '').split('\n').length
      addConsoleEvent({
        severity: 'success',
        source: 'post',
        message: words("PostProcessModal.copied_all_g_code_to_the_clipboard", { value1: lineCount.toLocaleString() }),
      })
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      throw copyFailure(words("PostProcessModal.the_browser_refused_clipboard_access_select_the", { value1: detail }))
    }
  }

  // ---- F: recompute every op in the active setup (wires the store action) ---
  const hasNoToolpathDiag = !!result?.diagnostics.some(
    (d) => d.code === 'OP_NO_TOOLPATH',
  )
  const handleRecomputeAll = () => {
    // Recompute every enabled op across the SELECTED setups (multi-setup scope)
    // as one staged batch (WO-2661): stock-aware operations read the results of
    // the ones before them, so each waits for its upstream, as Regenerate All.
    void computeAllToolpaths(scope.setups.map((s) => s.id))
    // The live `result` useMemo re-runs automatically once the store's
    // toolpathMoves update (worker completion patches project state).
  }

  const endMode = working.options.programEndMode
  const toolChangeMode: 'm6' | 'pause' | 'macro' | 'none' =
    working.capabilities.toolChange
  const dwellUnit = working.capabilities.dwellUnits === 's' ? 's' : 'ms'

  // ---- collapsed-section current-value summaries (clutter P5) ---------------
  // One line per DisclosureSection so the collapsed header still tells the user
  // what the section is set to without opening it.
  const fmtSummary = working.format
  const formatSummary = [
    exportUnitsOverride === 'inch' ? 'in' : 'mm',
    fmtSummary.xyzDecimals,
    fmtSummary.feedDecimals,
    // Only advertise the line-number step when line numbers are actually on.
    ...(fmtSummary.lineNumbers ? [fmtSummary.lineNumberStep || 5] : []),
  ].join(' / ')
  const arcsSummary = working.capabilities.arcs
    ? [
        working.capabilities.arcCenterMode === 'r' ? 'R' : 'IJK',
        working.capabilities.minArcRadius,
        working.capabilities.maxArcRadius ?? 1e4,
        working.capabilities.minSweepDeg ?? 2,
      ].join(' / ')
    : words("PostProcessModal.off")
  const workOffsetsSummary = `${wcsLabel}${working.options.writeWorkOffsets ? ' / G10 L2' : ''}`
  const framingSummary = [
    working.framing.programStart.join(' '),
    working.framing.programEnd.join(' '),
  ]
    .filter((s) => s.trim() !== '')
    .join(' | ')

  // ============ RIGHT: preview + diagnostics ============
  const previewPane = (collapsible: boolean) => (
    <PreviewPane
      result={result}
      config={working}
      enabledOpCount={postableOpCount}
      separateFiles={separateFiles.map((f) => f.filename)}
      previewFileIndex={previewFileIndex < separateFiles.length ? previewFileIndex : 0}
      previewFilename={previewFilename}
      onSelectFile={setPreviewFileIndex}
      diagnostics={previewDiagnostics}
      onExpand={() => setFlyoutOpen(true)}
      onCopyAll={handleCopyGcode}
      showRecompute={hasNoToolpathDiag}
      onRecomputeAll={handleRecomputeAll}
      collapsible={collapsible}
      shownGcode={shownGcode}
      editing={previewEditing || handEdit !== null}
      onStartEdit={() => setPreviewEditing(true)}
      onEditText={setHandEdit}
      handEditSummary={handEditSummary}
      editsStale={editsStale}
      onKeepEdits={keepHandEdit}
      onDiscardEdits={() => { setHandEdit(null); setPreviewEditing(false) }}
      machine={project.machine}
    />
  )

  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- this
    // modal's own scrim, MODAL-GOVERNED in the UI-70 census (COHESION-
    // STANDARD.md section 5 governs modality, not the overlay census).
    <div
      className="modal-backdrop"
      data-ui78-sanctioned=""
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) closeModal()
      }}
    >
      <div
        className="modal-container post-modal"
        onMouseDown={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          // Nested listboxes/editors consume their own Escape first. The full
          // preview is a sibling with its own close handler, not part of this panel.
          if (e.key !== 'Escape' || e.defaultPrevented) return
          e.preventDefault()
          e.stopPropagation()
          closeModal()
        }}
        ref={dialogFocusRef}
      >
        {/* Header */}
        <div className="modal-header">
          <FileCode2 size={14} className="modal-header-icon" />
          <span className="modal-title">{words("PostProcessModal.post_process", { value1: project.name?.trim() || words("PostProcessModal.project"), value2: headerScope })}</span>
          <button className="modal-close-btn" onClick={closeModal} data-tooltip={words("PostProcessModal.close")}
          aria-label={words("PostProcessModal.close")}>
            <X size={16} />
          </button>
        </div>

        {/* Tabs */}
        <div className="op-modal-tabs">
          <button
            className={`op-modal-tab${tab === 'properties' ? ' op-modal-tab-active' : ''}`}
            onClick={() => setTab('properties')}
          >{words("PostProcessModal.properties")}</button>
          <button
            className={`op-modal-tab${tab === 'preview' ? ' op-modal-tab-active' : ''}`}
            onClick={() => setTab('preview')}
          >{words("PostProcessModal.preview")}</button>
          <button
            className={`op-modal-tab${tab === 'about' ? ' op-modal-tab-active' : ''}`}
            onClick={() => setTab('about')}
          >{words("PostProcessModal.about_this_post")}</button>
        </div>

        <div className="modal-body post-body">
          {postActionNotice && (
            <div
              className={`post-action-notice post-action-notice-${postActionNotice.kind}`}
              data-testid="post-action-notice"
              role={postActionNotice.kind === 'error' ? 'alert' : 'status'}
            >
              {postActionNotice.message}
            </div>
          )}
          {/* Empty-state guard: no setups at all in the project. */}
          {project.setups.length === 0 ? (
            <div className="post-empty">
              <div className="post-selector" style={{ textAlign: 'left' }}>
                <span className="lbl">{words("PostProcessModal.post")}</span>
                <ThemedListbox
                  ariaLabel={words("PostProcessModal.post_definition")}
                  testId="post-definition-select"
                  value={selectedId}
                  options={postDefinitionOptions}
                  onChange={onSelectPost}
                />
                <span className={`badge ${isBuiltinSelected ? 'badge-builtin' : 'badge-custom'}`}>
                  {isBuiltinSelected ? words("PostProcessModal.builtIn") : words("PostProcessModal.customBadge")}
                </span>
              </div>{words("PostProcessModal.no_cam_setup_is_available_for_g")}</div>
          ) : tab === 'about' ? (
            <AboutTab config={working} />
          ) : (
            // WO-2433: the Properties tab splits its form and the live preview
            // with the shared resizable bar (preview = the sized pane, so it can
            // fold to its header); the Preview tab is the preview alone.
            tab === 'properties' ? (
              // The width the two 720px grid columns + gap gave the modal, so its
              // fit-content shell is unchanged; it shrinks with the viewport cap.
              <div style={{ display: 'flex', width: Math.round(POST_PREVIEW_DEFAULT_PX * 2 * readUiScale()) + SPLIT_BAR_PX, maxWidth: '100%' }}>
              <ResizableSplit
                prefKey="post-process.preview"
                testId="post-split"
                className="post-split"
                sizedPane="second"
                defaultSize={Math.round(POST_PREVIEW_DEFAULT_PX * readUiScale())}
                minSize={Math.round(420 * readUiScale())}
                maxSize={Math.round(1100 * readUiScale())}
                fillMinSize={Math.round(560 * readUiScale())}
                label={words("PostProcessModal.resize_the_post_settings_and_g_code")}
                sizedCollapsed={previewCollapsed}
                first={(
                <div>
                  {/* Post selector */}
                  <div className="post-selector">
                    <span className="lbl">{words("PostProcessModal.post")}</span>
                    <ThemedListbox
                      ariaLabel={words("PostProcessModal.post_definition")}
                      testId="post-definition-select"
                      value={selectedId}
                      options={postDefinitionOptions}
                      onChange={onSelectPost}
                    />
                    <span
                      className={`badge ${isBuiltinSelected ? 'badge-builtin' : 'badge-custom'}`}
                    >
                      {isBuiltinSelected ? words("PostProcessModal.builtIn") : words("PostProcessModal.customBadge")}
                    </span>
                  </div>
                  {importError && (
                    <div
                      data-testid="post-import-error"
                      style={{ color: 'var(--text-danger)', fontSize: 'var(--font-size-sm)', marginBottom: 8 }}
                    >{words("PostProcessModal.import_failed", { value1: importError })}</div>
                  )}

                  {toolNumberRows.length > 0 && (
                    <ToolNumbersSection rows={toolNumberRows} onSet={setPostToolNumber} />
                  )}

                  {/* Output scope (E2 multi-setup selection) */}
                  <div className="mform-section-header">{words("PostProcessModal.output_scope")}</div>
                  <label className="scope-master">
                    {/* The themed checkbox (app.css) draws checked and unchecked only;
                        a mixed scope gets the accent fill and a dash drawn here. */}
                    <span style={{ position: 'relative', display: 'inline-flex' }}>
                    <input
                      type="checkbox"
                      data-testid="post-scope-all"
                      data-state={allOperations ? 'checked' : someOperations ? 'mixed' : 'unchecked'}
                      checked={allOperations}
                      style={someOperations ? { background: 'var(--accent)', borderColor: 'var(--accent)' } : undefined}
                      ref={(node) => { if (node) node.indeterminate = someOperations }}
                      onChange={(e) => {
                        const on = e.target.checked
                        setCheckedSetups(new Set(on ? project.setups.map(setup => setup.id) : []))
                        if (on) setCheckedOps(Object.fromEntries(
                          Object.entries(enabledOpsBySetup).map(([id, ops]) => [id, new Set(ops.map(op => op.id))]),
                        ))
                      }}
                    />
                    {someOperations && (
                      <span
                        aria-hidden="true"
                        data-testid="post-scope-all-mixed"
                        style={{
                          position: 'absolute', left: '25%', right: '25%', top: 'calc(50% - 1px)', height: 2,
                          background: 'var(--text-on-accent)', pointerEvents: 'none',
                        }}
                      />
                    )}
                    </span>{words("PostProcessModal.all_operations")}</label>

                  <ScopeTree
                      setups={project.setups}
                      enabledOpsBySetup={enabledOpsBySetup}
                      checkedSetups={checkedSetups}
                      checkedOps={checkedOps}
                      expandedSetups={expandedSetups}
                      conflictPartner={conflictPartner}
                      resolvedWcsLabel={resolvedWcsLabel}
                      onToggleSetup={(id, on) =>
                        setCheckedSetups((prev) => {
                          const next = new Set(prev)
                          if (on) next.add(id)
                          else next.delete(id)
                          return next
                        })
                      }
                      onToggleOp={(setupId, opId, on) =>
                        setCheckedOps((prev) => {
                          const next = { ...prev }
                          const set = new Set(next[setupId] ?? [])
                          if (on) set.add(opId)
                          else set.delete(opId)
                          next[setupId] = set
                          return next
                        })
                      }
                      onToggleExpand={(id) =>
                        setExpandedSetups((prev) => {
                          const next = new Set(prev)
                          if (next.has(id)) next.delete(id)
                          else next.add(id)
                          return next
                        })
                      }
                  />


                  <div className="scope-mode-row">
                    <span className="mform-label">{words("PostProcessModal.output")}</span>
                    <div className="seg">
                      <button
                        className={outputMode === 'combined' ? 'on' : ''}
                        onClick={() => setOutputMode('combined')}
                      >{words("PostProcessModal.combined_one_file")}</button>
                      <button
                        className={outputMode === 'separate' ? 'on' : ''}
                        onClick={() => setOutputMode('separate')}
                      >{words("PostProcessModal.separate_files_one_per_setup")}</button>
                    </div>
                  </div>
                  <div className="mform-row">
                    <span className="mform-label">{words("PostProcessModal.pause_between_setups_m0")}</span>
                    <Toggle
                      checked={pauseBetweenSetups && outputMode === 'combined'}
                      disabled={outputMode !== 'combined'}
                      onChange={(v) => setPauseBetweenSetups(v)}
                    />
                  </div>
                  <div className="mform-row" data-testid="post-include-context-row">
                    <span className="mform-label">{words("PostProcessModal.include_liencam_context")}{/* WO-413: Help opens OVER this modal and returns here with the choice intact */}
                      <HelpLink topic="post-include-context" testId="post-include-context-help" />
                    </span>
                    <Toggle
                      checked={includeContext}
                      disabled={!contextReady}
                      onChange={(v) => setContextChoice(v)}
                    />
                    <span className="op-hint" style={{ margin: 0 }} data-testid="post-include-context-hint">
                      {contextHint}
                    </span>
                  </div>

                  {/* Output / Format details (clutter P5): collapsed by
                      default behind the standard disclosure; the summary
                      shows units / xyz decimals / feed decimals (/ N step). */}
                  <DisclosureSection
                    title={words("PostProcessModal.output_format")}
                    summary={formatSummary}
                    testId="disclosure-output-format"
                  >
                  <div className="mform-row">
                    <div className="post-unit-control" data-testid="post-export-units">
                      <span className="mform-label">{words("PostProcessModal.export_units")}</span>
                      <div className="post-unit-segmented" role="radiogroup" aria-label={words("PostProcessModal.export_units")}>
                        <label className={exportUnitsOverride === 'mm' ? 'post-unit-option post-unit-option-active' : 'post-unit-option'}>
                          <input
                            type="radio"
                            name="post-export-units"
                            value="mm"
                            checked={exportUnitsOverride === 'mm'}
                            onChange={() => setExportUnitsOverride('mm')}
                          />
                          <span>{words("PostProcessModal.mm")}</span>
                        </label>
                        <label className={exportUnitsOverride === 'inch' ? 'post-unit-option post-unit-option-active' : 'post-unit-option'}>
                          <input
                            type="radio"
                            name="post-export-units"
                            value="inch"
                            checked={exportUnitsOverride === 'inch'}
                            onChange={() => setExportUnitsOverride('inch')}
                          />
                          <span>{words("PostProcessModal.in")}</span>
                        </label>
                      </div>
                    </div>
                    <span className="badge badge-config">
                      {exportUnitsOverride === 'inch' ? 'G20' : 'G21'}{words("PostProcessModal.symbol")}{unitLabel(exportUnitsOverride)}{words("PostProcessModal.symbol_2")}</span>
                  </div>
                  <div className="mform-row">
                    <span className="mform-label">{words("PostProcessModal.xyz_decimals")}</span>
                    <input
                      className="mform-input mform-input-sm mform-input-mono"
                      type="text" inputMode="decimal"
                      onFocus={selectAllNumeric.onFocus}
                      onMouseUp={selectAllNumeric.onMouseUp}
                      min={0}
                      max={6}
                      value={working.format.xyzDecimals}
                      onChange={(e) =>
                        patch((d) => {
                          d.format.xyzDecimals = clampInt(e.target.value, 0, 6)
                        })
                      }
                    />
                    <span
                      className="mform-label"
                      style={{ minWidth: 'auto', marginLeft: 18 }}
                    >{words("PostProcessModal.feed_decimals")}</span>
                    <input
                      className="mform-input mform-input-sm mform-input-mono"
                      type="text" inputMode="decimal"
                      onFocus={selectAllNumeric.onFocus}
                      onMouseUp={selectAllNumeric.onMouseUp}
                      min={0}
                      max={4}
                      value={working.format.feedDecimals}
                      onChange={(e) =>
                        patch((d) => {
                          d.format.feedDecimals = clampInt(e.target.value, 0, 4)
                        })
                      }
                    />
                  </div>
                  <div className="mform-row">
                    <span className="mform-label">{words("PostProcessModal.line_sequence_numbers")}</span>
                    <Toggle
                      checked={working.format.lineNumbers}
                      onChange={(v) => patch((d) => { d.format.lineNumbers = v })}
                    />
                    <span
                      className="mform-label"
                      style={{ minWidth: 'auto', marginLeft: 18 }}
                    >{words("PostProcessModal.increment")}</span>
                    <input
                      className="mform-input mform-input-sm mform-input-mono"
                      type="text" inputMode="decimal"
                      onFocus={selectAllNumeric.onFocus}
                      onMouseUp={selectAllNumeric.onMouseUp}
                      min={1}
                      disabled={!working.format.lineNumbers}
                      value={working.format.lineNumberStep || 5}
                      onChange={(e) =>
                        patch((d) => {
                          d.format.lineNumberStep = clampInt(e.target.value, 1, 1000)
                        })
                      }
                    />
                  </div>
                  </DisclosureSection>

                  {/* Arcs (clutter P5): whole section behind the disclosure.
                      The "Emit arcs" toggle is always shown inside so a user
                      can force linear-segment-only output (off) or toleranced
                      G2/G3 collapse (on); the tuning controls appear only when
                      on. Summary: center mode / min R / max R / min sweep. */}
                  <DisclosureSection
                    title={words("PostProcessModal.arcs")}
                    summary={arcsSummary}
                    testId="disclosure-arcs"
                  >
                  <div className="mform-row">
                    <span className="mform-label">{words("PostProcessModal.emit_arcs_g2_g3")}</span>
                    <Toggle
                      checked={working.capabilities.arcs}
                      onChange={(v) =>
                        patch((d) => { d.capabilities.arcs = v })
                      }
                    />
                  </div>
                  {working.capabilities.arcs && (
                    <>
                      <div className="mform-row">
                        <span className="mform-label">{words("PostProcessModal.arc_center_mode")}</span>
                        <div className="seg">
                          <button
                            className={working.capabilities.arcCenterMode === 'ijk' ? 'on' : ''}
                            onClick={() =>
                              patch((d) => { d.capabilities.arcCenterMode = 'ijk' })
                            }
                          >
                            IJK
                          </button>
                          <button
                            className={working.capabilities.arcCenterMode === 'r' ? 'on' : ''}
                            onClick={() =>
                              patch((d) => { d.capabilities.arcCenterMode = 'r' })
                            }
                          >
                            R
                          </button>
                        </div>
                      </div>
                      <div className="mform-row">
                        <span className="mform-label">{words("PostProcessModal.min_arc_radius")}</span>
                        <input
                          className="mform-input mform-input-sm mform-input-mono"
                          type="text" inputMode="decimal"
                          onFocus={selectAllNumeric.onFocus}
                          onMouseUp={selectAllNumeric.onMouseUp}
                          min={0}
                          step={0.01}
                          value={working.capabilities.minArcRadius}
                          onChange={(e) =>
                            patch((d) => {
                              d.capabilities.minArcRadius = floatClamp(e.target.value, 0, 100)
                            })
                          }
                        />
                        <span className="unit-suffix">{words("PostProcessModal.mm")}</span>
                      </div>
                      <div className="mform-row">
                        <span className="mform-label">{words("PostProcessModal.max_arc_radius")}</span>
                        <input
                          className="mform-input mform-input-sm mform-input-mono"
                          type="text" inputMode="decimal"
                          onFocus={selectAllNumeric.onFocus}
                          onMouseUp={selectAllNumeric.onMouseUp}
                          min={0}
                          step={1}
                          value={working.capabilities.maxArcRadius ?? 1e4}
                          onChange={(e) =>
                            patch((d) => {
                              d.capabilities.maxArcRadius = floatClamp(e.target.value, 0, 1e6)
                            })
                          }
                        />
                        <span className="unit-suffix">{words("PostProcessModal.mm")}</span>
                      </div>
                      <div className="mform-row">
                        <span className="mform-label">{words("PostProcessModal.min_sweep_angle")}</span>
                        <input
                          className="mform-input mform-input-sm mform-input-mono"
                          type="text" inputMode="decimal"
                          onFocus={selectAllNumeric.onFocus}
                          onMouseUp={selectAllNumeric.onMouseUp}
                          min={0}
                          step={0.5}
                          value={working.capabilities.minSweepDeg ?? 2}
                          onChange={(e) =>
                            patch((d) => {
                              d.capabilities.minSweepDeg = floatClamp(e.target.value, 0, 180)
                            })
                          }
                        />
                        <span className="unit-suffix">{words("PostProcessModal.deg")}</span>
                      </div>
                      <div className="mform-row">
                        <span className="mform-label">{words("PostProcessModal.arc_tolerance")}</span>
                        <input
                          className="mform-input mform-input-sm mform-input-mono"
                          type="text" inputMode="decimal"
                          onFocus={selectAllNumeric.onFocus}
                          onMouseUp={selectAllNumeric.onMouseUp}
                          min={0.001}
                          step={0.005}
                          value={working.options.arcTolerance ?? 0.05}
                          onChange={(e) =>
                            patch((d) => {
                              d.options.arcTolerance = floatClamp(e.target.value, 0.001, 1)
                            })
                          }
                        />
                        <span className="unit-suffix">{words("PostProcessModal.mm")}</span>
                      </div>
                    </>
                  )}
                  </DisclosureSection>

                  {/* Work offsets (clutter P5): collapsed disclosure with the
                      live WCS label (+ G10 L2 when enabled) as the summary. */}
                  <DisclosureSection
                    title={words("PostProcessModal.work_offsets")}
                    summary={workOffsetsSummary}
                    testId="disclosure-work-offsets"
                  >
                  <div className="mform-row">
                    <span className="mform-label">{words("PostProcessModal.fixture_offset_from_wcs")}</span>
                    <span className="post-readonly">{wcsLabel}</span>
                  </div>
                  <div className="mform-row">
                    <span className="mform-label">{words("PostProcessModal.write_offsets_via_g10_l2")}</span>
                    <Toggle
                      checked={working.options.writeWorkOffsets}
                      onChange={(v) =>
                        patch((d) => { d.options.writeWorkOffsets = v })
                      }
                    />
                  </div>
                  </DisclosureSection>

                  {/* Tool change */}
                  <div className="mform-section-header">{words("PostProcessModal.tool_change")}</div>
                  <div className="mform-row">
                    <span className="mform-label">{words("PostProcessModal.tool_change_mode")}</span>
                    <div className="seg">
                      {(['m6', 'pause', 'macro', 'none'] as const).map((m) => (
                        <button
                          key={m}
                          className={toolChangeMode === m ? 'on' : ''}
                          onClick={() =>
                            patch((d) => { d.capabilities.toolChange = m })
                          }
                        >
                          {m === 'm6'
                            ? 'M6'
                            : m === 'pause'
                              ? words("PostProcessModal.pause_m0")
                              : m === 'macro'
                                ? words("PostProcessModal.custom")
                                : words("PostProcessModal.none")}
                        </button>
                      ))}
                    </div>
                  </div>
                  {toolChangeMode === 'macro' && (
                    <>
                      <div className="mform-row" style={{ alignItems: 'flex-start' }}>
                        <span className="mform-label" style={{ paddingTop: 5 }}>{words("PostProcessModal.custom_g_code")}</span>
                        <textarea
                          className="mform-textarea"
                          rows={3}
                          value={working.options.toolChangeMacro ?? ''}
                          onChange={(e) =>
                            patch((d) => { d.options.toolChangeMacro = e.target.value })
                          }
                          placeholder="M6 T{tool}"
                        />
                      </div>
                    </>
                  )}


                  {/* Spindle / Coolant (read-only — derived per op) */}
                  <div className="mform-section-header">{words("PostProcessModal.spindle_coolant")}</div>
                  <div className="mform-row">
                    <span className="mform-label">{words("PostProcessModal.spindle_settle_dwell")}</span>
                    <input
                      className="mform-input mform-input-sm mform-input-mono"
                      type="text" inputMode="decimal"
                      onFocus={selectAllNumeric.onFocus}
                      onMouseUp={selectAllNumeric.onMouseUp}
                      min={0}
                      value={Number(working.options.dwellMs ?? 0)}
                      onChange={(e) =>
                        patch((d) => {
                          d.options.dwellMs = clampInt(e.target.value, 0, 600000)
                        })
                      }
                    />
                    <span className="unit-suffix">{dwellUnit}</span>
                  </div>

                  {/* Program end */}
                  <div className="mform-section-header">{words("PostProcessModal.program_end")}</div>
                  <div className="mform-row">
                    <span className="mform-label">{words("PostProcessModal.end_behavior")}</span>
                    <ThemedListbox
                      testId="post-program-end-mode"
                      ariaLabel={words("PostProcessModal.end_behavior")}
                      value={endMode}
                      options={[
                        { value: 'safe_z_only', label: words("PostProcessModal.safe_z_only") },
                        { value: 'machine_coords', label: words("PostProcessModal.machine_coords_g53_") },
                        { value: 'home', label: words("PostProcessModal.home") },
                        { value: 'custom', label: words("PostProcessModal.custom_verbatim_") },
                      ]}
                      onChange={(v) =>
                        patch((d) => {
                          d.options.programEndMode = v as ProgramEndMode
                        })
                      }
                    />
                  </div>
                  {endMode === 'machine_coords' && (
                    <div className="mform-row">
                      <span className="mform-label">{words("PostProcessModal.machine_x_y_z")}</span>
                      <input
                        className="mform-input mform-input-sm mform-input-mono"
                        type="text" inputMode="decimal"
                        onFocus={selectAllNumeric.onFocus}
                        onMouseUp={selectAllNumeric.onMouseUp}
                        placeholder={words("PostProcessModal.x")}
                        value={numOrEmpty(working.options.programEndMachineX)}
                        onChange={(e) =>
                          patch((d) => {
                            d.options.programEndMachineX = floatOrUndef(e.target.value)
                          })
                        }
                      />
                      <input
                        className="mform-input mform-input-sm mform-input-mono"
                        type="text" inputMode="decimal"
                        onFocus={selectAllNumeric.onFocus}
                        onMouseUp={selectAllNumeric.onMouseUp}
                        placeholder={words("PostProcessModal.y")}
                        value={numOrEmpty(working.options.programEndMachineY)}
                        onChange={(e) =>
                          patch((d) => {
                            d.options.programEndMachineY = floatOrUndef(e.target.value)
                          })
                        }
                      />
                      <input
                        className="mform-input mform-input-sm mform-input-mono"
                        type="text" inputMode="decimal"
                        onFocus={selectAllNumeric.onFocus}
                        onMouseUp={selectAllNumeric.onMouseUp}
                        placeholder={words("PostProcessModal.z")}
                        value={numOrEmpty(working.options.programEndMachineZ)}
                        onChange={(e) =>
                          patch((d) => {
                            d.options.programEndMachineZ = floatOrUndef(e.target.value)
                          })
                        }
                      />
                    </div>
                  )}
                  {endMode === 'home' && (
                    <div className="mform-row">
                      <span className="mform-label">{words("PostProcessModal.home_command")}</span>
                      <input
                        className="mform-input mform-input-mono"
                        value={String(working.options.homeCommand ?? '')}
                        onChange={(e) =>
                          patch((d) => { d.options.homeCommand = e.target.value })
                        }
                        placeholder="G28"
                      />
                    </div>
                  )}
                  {endMode === 'custom' && (
                    <>
                      <div className="mform-row" style={{ alignItems: 'flex-start' }}>
                        <span className="mform-label" style={{ paddingTop: 5 }}>{words("PostProcessModal.end_g_code")}</span>
                        <textarea
                          className="mform-textarea"
                          rows={3}
                          value={working.options.programEndCustom ?? ''}
                          onChange={(e) =>
                            patch((d) => { d.options.programEndCustom = e.target.value })
                          }
                          placeholder="M5&#10;G53 G0 Z0&#10;M30"
                        />
                      </div>
                    </>
                  )}

                  {/* Program framing (clutter P5): preamble/postamble behind
                      the disclosure; summary previews the literal lines. */}
                  <DisclosureSection
                    title={words("PostProcessModal.program_framing")}
                    summary={framingSummary}
                    testId="disclosure-program-framing"
                  >
                  <div className="mform-row" style={{ alignItems: 'flex-start' }}>
                    <span className="mform-label" style={{ paddingTop: 5 }}>{words("PostProcessModal.preamble")}</span>
                    <textarea
                      className="mform-textarea"
                      rows={3}
                      value={working.framing.programStart.join('\n')}
                      onChange={(e) =>
                        patch((d) => {
                          d.framing.programStart = splitLines(e.target.value)
                        })
                      }
                    />
                  </div>
                  <div className="mform-row" style={{ alignItems: 'flex-start' }}>
                    <span className="mform-label" style={{ paddingTop: 5 }}>{words("PostProcessModal.postamble")}</span>
                    <textarea
                      className="mform-textarea"
                      rows={2}
                      value={working.framing.programEnd.join('\n')}
                      onChange={(e) =>
                        patch((d) => {
                          d.framing.programEnd = splitLines(e.target.value)
                        })
                      }
                    />
                  </div>
                  </DisclosureSection>

                  {/* Comments */}
                  <div className="mform-section-header">{words("PostProcessModal.comments")}</div>
                  <div className="mform-row">
                    <span className="mform-label">{words("PostProcessModal.section_comments")}</span>
                    <Toggle
                      checked={working.framing.sectionComment}
                      onChange={(v) =>
                        patch((d) => { d.framing.sectionComment = v })
                      }
                    />
                    <span
                      className="mform-label"
                      style={{ minWidth: 'auto', marginLeft: 18 }}
                    >{words("PostProcessModal.comment_style")}</span>
                    <span className="post-readonly">
                      {working.capabilities.comment === 'paren'
                        ? words("PostProcessModal.parenComment")
                        : words("PostProcessModal.semicolonComment")}
                    </span>
                  </div>
                </div>
                )}
                second={previewPane(true)}
              />
              </div>
            ) : (
              <div className="post-grid post-grid-single">{previewPane(false)}</div>
            )
          )}
        </div>

        {/* Export names stay beside the action, including on Preview/About tabs. */}
        <div data-testid="post-export-filenames" style={{
          display: 'flex', flexWrap: 'wrap', gap: '0.5rem 1rem', padding: '0.7rem 0.875rem',
          borderTop: '1px solid var(--border)', background: 'var(--bg-panel-alt)',
          flexShrink: 0, maxHeight: '9rem', overflowY: 'auto',
        }}>
          {outputMode === 'combined'
            ? filenameField(combinedNameKey, combinedFilename, words("PostProcessModal.file_name"))
            : separateFiles.map(file => filenameField(
              separateNameKey(file), file.filename,
              words("PostProcessModal.separate_file_name", { name: file.filename }),
            ))}
        </div>
        {/* Footer */}
        <div className="modal-footer">
          <input
            ref={importInputRef}
            data-testid="post-import-input"
            type="file"
            accept=".json,.lienpost.json,.pp,.cps,.scpost,.pst,application/json"
            style={{ display: 'none' }}
            onChange={(event) => void handleImportPost(event.target.files?.[0])}
          />
          <button
            className="modal-btn modal-btn-ghost"
            onClick={() => importInputRef.current?.click()}
            data-tooltip={words("PostProcessModal.import_a_liencam_json_vectric_estlcam_pp")}
          >{words("PostProcessModal.import_post")}</button>
          <button
            className="modal-btn modal-btn-ghost"
            onClick={handleSharePost}
            data-tooltip={words("PostProcessModal.download_the_currently_edited_post_as_a")}
          >{words("PostProcessModal.share_post")}</button>
          <button
            className="modal-btn modal-btn-ghost"
            onClick={handleSavePostAs}
            data-tooltip={words("PostProcessModal.save_the_current_edited_settings_as_a")}
          >{words("PostProcessModal.new_save_post_as")}</button>
          {selectedUserPost && !isBuiltinSelected && (
            <button
              className="modal-btn modal-btn-danger"
              data-testid="post-delete-custom"
              onClick={handleDeletePost}
              data-tooltip={words("PostProcessModal.delete_the_saved_post", { value1: selectedUserPost.label })}
            >{words("PostProcessModal.delete_post")}</button>
          )}
          <span className="footer-spacer" />
          {modelRefCheckInFlight && (
            <span className="post-model-ref-check" data-testid="post-model-ref-check" role="status">{words("PostProcessModal.checking_model_references")}</span>
          )}
          <button className="modal-btn modal-btn-ghost" onClick={closeModal}>{words("PostProcessModal.cancel")}</button>
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="post-send-to-control"
            // Never disabled (WO-1182 census): a click that cannot send runs
            // the same checks Export runs and the console says why.
            onClick={() => void handleSendToControl()}
            data-tooltip={
              !canExport
                ? nothingSelected
                  ? words("PostProcessModal.select_at_least_one_setup_and_operation")
                  : modelRefCheckInFlight
                    ? words("PostProcessModal.checking_model_references")
                    : words("PostProcessModal.fix_the_errors_below_before_exporting")
                : outputMode === 'separate'
                  ? ed('post.sendToControlSeparateTip', { name: previewFilename ?? '' })
                  : ed('post.sendToControlTip')
            }
          >
            <Send size={14} />{ed('post.sendToControl')}</button>
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="post-download-setup-sheet"
            onClick={handleDownloadSetupSheet}
            disabled={!canExport}
            data-tooltip={
              !canExport
                ? nothingSelected
                  ? words("PostProcessModal.select_at_least_one_setup_and_operation")
                  : modelRefCheckInFlight
                    ? words("PostProcessModal.checking_model_references")
                    : words("PostProcessModal.fix_the_errors_below_before_exporting")
                : words("PostProcessModal.download_the_setup_sheet_text_and_pdf")
            }
          >
            <Download size={14} />{words("PostProcessModal.setup_sheet")}</button>
          <button
            className="modal-btn modal-btn-primary"
            onClick={handleExport}
            disabled={!canExport}
            data-tooltip={
              !canExport
                ? nothingSelected
                  ? words("PostProcessModal.select_at_least_one_setup_and_operation")
                  : modelRefCheckInFlight
                    ? words("PostProcessModal.checking_model_references")
                    : words("PostProcessModal.fix_the_errors_below_before_exporting")
                : outputMode === 'separate'
                  ? words("PostProcessModal.download_named_files", { count: projectResult?.files?.length ?? 0 })
                  : words("PostProcessModal.download_named", { name: combinedExportFilename })
            }
          >
            <Download size={14} />
            {outputMode === 'separate'
              ? words("PostProcessModal.export_files", { value1: projectResult?.files?.length ?? 0 })
              : words("PostProcessModal.export", { value1: ext })}
          </button>
        </div>
      </div>

      {/* Full-g-code flyout viewer (G) */}
      {flyoutOpen && (
        <GcodeFlyout
          gcode={shownGcode}
          dialect={working.label}
          onCopyAll={handleCopyGcode}
          showRecompute={hasNoToolpathDiag}
          onRecomputeAll={handleRecomputeAll}
          onClose={() => setFlyoutOpen(false)}
        />
      )}
    </div>
  )
}

// ============================================================
// Sub-components
// ============================================================

// Collapsible setup/op selection tree. One row per setup with a setup-level checkbox (multi-select + select-all
// of its enabled ops) and a chevron to reveal per-op checkboxes. A setup whose
// work offset collides with another is greyed and flagged inline (export will
// fail loud on it via DUPLICATE_WORK_OFFSET).
function ScopeTree({
  setups,
  enabledOpsBySetup,
  checkedSetups,
  checkedOps,
  expandedSetups,
  conflictPartner,
  resolvedWcsLabel,
  onToggleSetup,
  onToggleOp,
  onToggleExpand,
}: {
  setups: Setup[]
  enabledOpsBySetup: Record<string, { id: string; name: string }[]>
  checkedSetups: Set<string>
  checkedOps: Record<string, Set<string>>
  expandedSetups: Set<string>
  conflictPartner: Record<string, string>
  resolvedWcsLabel: Record<string, string>
  onToggleSetup: (id: string, on: boolean) => void
  onToggleOp: (setupId: string, opId: string, on: boolean) => void
  onToggleExpand: (id: string) => void
}) {
  const words = useText('setup-stock-tools-machine-post')
  return (
    <div className="scope-tree">
      {setups.map((s) => {
        const ops = enabledOpsBySetup[s.id] ?? []
        const expanded = expandedSetups.has(s.id)
        const setupChecked = checkedSetups.has(s.id)
        const conflict = conflictPartner[s.id]
        return (
          <div key={s.id}>
            <div className={`scope-setup-row${conflict ? ' scope-conflict' : ''}`}>
              <button
                className="scope-chevron"
                onClick={() => onToggleExpand(s.id)}
                data-tooltip={expanded ? words("PostProcessModal.collapse") : words("PostProcessModal.expand_operations")}
                aria-label={expanded ? words("PostProcessModal.collapse") : words("PostProcessModal.expand_operations")}
              >
                {expanded ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
              </button>
              <input
                className="scope-setup-cb"
                type="checkbox"
                checked={setupChecked}
                onChange={(e) => onToggleSetup(s.id, e.target.checked)}
              />
              <span className="scope-setup-name">{s.name}</span>
              <span className="scope-setup-wcs">{resolvedWcsLabel[s.id] ?? s.wcs.label}</span>
              {conflict && (
                <span className="scope-conflict-note">{words("PostProcessModal.conflicts_with", { value1: resolvedWcsLabel[s.id] ?? s.wcs.label, value2: conflict })}</span>
              )}
            </div>
            {expanded && (
              <div className="scope-op-list">
                {ops.length === 0 ? (
                  <div className="scope-op-empty">{words("PostProcessModal.no_enabled_operations")}</div>
                ) : (
                  ops.map((op) => (
                    <div key={op.id} className="scope-op-row">
                      <label>
                        <input
                          className="scope-op-cb"
                          type="checkbox"
                          checked={setupChecked && !!checkedOps[s.id]?.has(op.id)}
                          disabled={!setupChecked}
                          onChange={(e) => onToggleOp(s.id, op.id, e.target.checked)}
                        />
                        {op.name}
                      </label>
                    </div>
                  ))
                )}
              </div>
            )}
          </div>
        )
      })}
    </div>
  )
}

function PreviewPane({
  result,
  config,
  enabledOpCount,
  separateFiles,
  previewFileIndex,
  previewFilename,
  onSelectFile,
  diagnostics,
  onExpand,
  onCopyAll,
  showRecompute,
  onRecomputeAll,
  collapsible = false,
  shownGcode,
  editing,
  onStartEdit,
  onEditText,
  handEditSummary,
  editsStale,
  onKeepEdits,
  onDiscardEdits,
  machine,
}: {
  result: PostResult | null
  config: PostConfig
  enabledOpCount: number
  separateFiles: string[]
  previewFileIndex: number
  previewFilename: string | null
  onSelectFile: (i: number) => void
  diagnostics: PostDiagnostic[] | null
  onExpand: () => void
  onCopyAll: (gcode: string) => Promise<void>
  showRecompute: boolean
  onRecomputeAll: () => void
  /** WO-2433: the Properties-tab split lets the preview fold to its header. */
  collapsible?: boolean
  /** WO-2651: the text shown and written - the hand edit when there is one. */
  shownGcode: string
  editing: boolean
  onStartEdit: () => void
  onEditText: (text: string) => void
  handEditSummary: string | null
  editsStale: boolean
  onKeepEdits: () => void
  onDiscardEdits: () => void
  machine: Project['machine']
}) {
  const words = useText('setup-stock-tools-machine-post')
  const ed = useText('gcode-editor')
  const folded = usePanelCollapsed(POST_PREVIEW_PANEL_KEY) && collapsible
  // WO-2651: the shared reader's verdict on the edited text, marked in the
  // editor - never a refusal (rule 11).
  const [marks, setMarks] = useState<GcodeLineMark[]>([])
  useEffect(() => {
    if (!editing) return
    const timer = setTimeout(() => setMarks(readerMarks(shownGcode, machine)), 250)
    return () => clearTimeout(timer)
  }, [editing, shownGcode, machine])
  // While the preview is edited, the header counts the edited buffer the same way the editor does (a final newline
  // ends the last line; it does not add one) - Rholand's 10-07 visual review.
  const lineCount = editing
    ? (shownGcode === '' ? 0 : shownGcode.replace(/\r?\n$/, '').split(/\r?\n/).length)
    : result?.meta?.lineCount ?? 0
  const dialect = config.label
  const hasGcode = !!result && result.gcode.length > 0
  // Diagnostics are resolved by the parent (combined: orchestrator; separate:
  // selected file + any orchestrator-level conflicts); fall back to result's own.
  const diags = diagnostics ?? result?.diagnostics ?? []
  // Separate mode shows a file selector (preview EACH file, not just file 1).
  const showFileSelector = separateFiles.length > 0
  const [contextAt, setContextAt] = useState<{ x: number; y: number } | null>(null)
  const openContextMenu = (event: ReactMouseEvent<HTMLElement>) => {
    if (!hasGcode && !showRecompute) return
    event.preventDefault()
    event.stopPropagation()
    setContextAt({ x: event.clientX, y: event.clientY })
  }

  return (
    <div className="preview-pane">
      <div className="preview-head">
        <span className="ttl">{words("PostProcessModal.g_code_preview")}{previewFilename ? <>{words("PostProcessModal.symbol_3")}{previewFilename}</> : null}
        </span>
        <div className="preview-head-right">
          {/* The hand-edit notice lives in this head, never a row of its own: nothing
              pushes the preview down (WO-2651 amendment item 6, Post as on Control). */}
          {editing && !folded && hasGcode && (<>
            {editsStale && handEditSummary && (
              <div className="gce-post-line gce-post-line-head" data-testid="post-stale-edits" role="status">
                <span>{ed('post.staleEdits', { summary: handEditSummary })}</span>
                <button className="post-expand-btn" data-testid="post-keep-edits" data-tooltip={ed('post.keepEditsTip')} onClick={onKeepEdits}>
                  {ed('post.keepEdits')}</button>
                <button className="post-expand-btn" data-testid="post-repost" data-tooltip={ed('post.repostTip')} onClick={onDiscardEdits}>
                  {ed('post.repost')}</button>
              </div>
            )}
            {!editsStale && handEditSummary && (
              <div className="gce-post-line gce-post-line-head" data-testid="post-hand-edited">
                <span>{ed('post.handEdited', { summary: handEditSummary })}</span>
                <button className="post-expand-btn" data-testid="post-discard-edits" data-tooltip={ed('post.discardEditsTip')} onClick={onDiscardEdits}>
                  {ed('post.discardEdits')}</button>
              </div>
            )}
          </>)}
          <span className="lib-meta">{words("PostProcessModal.lines", { value1: dialect, value2: lineCount.toLocaleString() })}</span>
          <button
            className="post-expand-btn"
            onClick={onExpand}
            disabled={!hasGcode}
            data-tooltip={hasGcode ? words("PostProcessModal.expand_full_g_code_viewer") : words("PostProcessModal.no_g_code_to_expand")}
          >
            <Maximize2 size={13} />{words("PostProcessModal.expand")}</button>
          {!editing && hasGcode && (
            <button
              className="post-expand-btn"
              data-testid="post-preview-edit"
              onClick={onStartEdit}
              data-tooltip={ed('post.editTip')}
            >
              <FilePen size={13} />{ed('post.edit')}</button>
          )}
          {collapsible && (
            <PanelCollapseToggle
              panelKey={POST_PREVIEW_PANEL_KEY}
              testId="post-preview-collapse"
              collapseTip={words("PostProcessModal.collapse_the_g_code_preview")}
              expandTip={words("PostProcessModal.expand_the_g_code_preview")}
            />
          )}
        </div>
      </div>

      {folded && (
        // Folding removes the room, never the verdict: errors stay visible.
        <span className="lib-meta" data-testid="post-preview-folded-summary">
          {diags.filter((d) => d.level === 'error').length}{words("PostProcessModal.error_s")}{' '}
          {diags.filter((d) => d.level === 'warning').length}{words("PostProcessModal.warning_s")}</span>
      )}

      {!folded && showFileSelector && (
        <div className="scope-file-selector">
          <span className="lbl">{words("PostProcessModal.preview_file")}</span>
          <ThemedListbox
            testId="post-preview-file-select"
            ariaLabel={words("PostProcessModal.preview_file")}
            value={String(previewFileIndex)}
            options={separateFiles.map((name, i) => ({
              value: String(i),
              label: words("PostProcessModal.previewFileNumber", { index: i + 1, count: separateFiles.length, name }),
            }))}
            onChange={(v) => onSelectFile(Number(v))}
          />
        </div>
      )}

      {folded ? null : !result || result.gcode.length === 0 ? (
        <div
          className="gcode post-gcode-empty"
          data-testid="post-gcode-preview"
          onContextMenu={openContextMenu}
        >
          {enabledOpCount === 0
            ? words("PostProcessModal.no_enabled_operations_to_post_enable_and")
            : !result || result.ok === false
              ? words("PostProcessModal.no_output_see_diagnostics_below")
              : words("PostProcessModal.no_moves_emitted")}
        </div>
      ) : editing ? (
        <>
          <div className="gce-post-editor" onContextMenu={openContextMenu}>
            <GcodeEditor value={shownGcode} onChange={onEditText} marks={marks} testId="post-gcode-editor" />
          </div>
        </>
      ) : (
        <pre
          className="gcode"
          data-testid="post-gcode-preview"
          onContextMenu={openContextMenu}
        >
          {result.gcode}
        </pre>
      )}

      {contextAt && (
        <PostGcodeContextMenu
          at={contextAt}
          gcode={shownGcode}
          onCopyAll={onCopyAll}
          onOpenFull={hasGcode ? onExpand : undefined}
          showRecompute={showRecompute}
          onRecomputeAll={onRecomputeAll}
          onClose={() => setContextAt(null)}
        />
      )}

      {!folded && (<>
      <div className="preview-head">
        <span className="ttl">{words("PostProcessModal.diagnostics")}</span>
        {showRecompute && (
          <button
            className="post-recompute-btn"
            onClick={onRecomputeAll}
            data-tooltip={words("PostProcessModal.recompute_every_enabled_operation_in_this_setup")}
          >
            <RefreshCw size={13} />{words("PostProcessModal.recompute_all")}</button>
        )}
      </div>
      <div className="diag">
        {editing && marks.length > 0 && (
          <div className="diag-row diag-warn" data-testid="post-edited-marks-diag">
            <span className="diag-ico">[!]</span>
            <span>{words("PostProcessModal.edited_program_marked_lines", { value1: marks.length.toLocaleString() })}</span>
          </div>
        )}
        {diags.length === 0 ? (
          <div className="diag-row diag-ok">
            <span className="diag-ico">{words("PostProcessModal.ok")}</span>
            <span>{editing
              ? words("PostProcessModal.no_diagnostics_generated_program")
              : words("PostProcessModal.no_diagnostics_program_assembled_cleanly")}</span>
          </div>
        ) : (
          diags.map((d, i) => (
            <div
              key={`${d.code}-${i}`}
              data-code={d.code}
              className={`diag-row ${
                d.level === 'error'
                  ? 'diag-err'
                  : d.level === 'warning'
                    ? 'diag-warn'
                    : 'diag-info'
              }`}
            >
              <span className="diag-ico">
                {d.level === 'error' ? '[X]' : d.level === 'warning' ? '[!]' : '[i]'}
              </span>
              <span>
                {d.message}
              </span>
            </div>
          ))
        )}
      </div>
      </>)}
    </div>
  )
}

function PostGcodeContextMenu({
  at,
  gcode,
  onCopyAll,
  onOpenFull,
  showRecompute,
  onRecomputeAll,
  onClose,
}: {
  at: { x: number; y: number }
  gcode: string
  onCopyAll: (gcode: string) => Promise<void>
  onOpenFull?: () => void
  showRecompute: boolean
  onRecomputeAll: () => void
  onClose: () => void
}) {
  const words = useText('setup-stock-tools-machine-post')
  const menuRef = useRef<HTMLDivElement>(null)
  const firstActionRef = useRef<HTMLButtonElement>(null)
  const [copyError, setCopyError] = useState<string | null>(null)
  const hasGcode = gcode.length > 0

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      event.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [onClose])

  useEffect(() => {
    const menu = menuRef.current
    if (menu) {
      const bounds = menu.getBoundingClientRect()
      if (bounds.right > window.innerWidth) menu.style.left = `${at.x - bounds.width}px`
      if (bounds.bottom > window.innerHeight) menu.style.top = `${at.y - bounds.height}px`
    }
    firstActionRef.current?.focus()
  }, [at])

  const copyAll = async () => {
    setCopyError(null)
    try {
      await onCopyAll(gcode)
      onClose()
    } catch (error) {
      setCopyError(error instanceof Error ? error.message : String(error))
    }
  }

  return (
    <>
      <div
        className="sketch-context-overlay"
        onPointerDown={onClose}
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }}
      />
      <div
        ref={menuRef}
        className="sketch-context-menu"
        style={{ left: at.x, top: at.y }}
        role="menu"
        aria-label={words("PostProcessModal.g_code_context_menu")}
        data-testid="post-gcode-context-menu"
        onContextMenu={(event) => {
          event.preventDefault()
          event.stopPropagation()
        }}
      >
        <div className="sketch-context-label">{words("PostProcessModal.g_code_output")}</div>
        {hasGcode && (
          <button
            ref={firstActionRef}
            className="sketch-context-item"
            role="menuitem"
            onClick={() => void copyAll()}
          >{words("PostProcessModal.copy_all_g_code")}</button>
        )}
        {hasGcode && onOpenFull && (
          <button
            className="sketch-context-item"
            role="menuitem"
            onClick={() => {
              onOpenFull()
              onClose()
            }}
          >{words("PostProcessModal.open_full_preview")}</button>
        )}
        {showRecompute && (
          <>
            {hasGcode && <div className="sketch-context-sep" />}
            <button
              ref={hasGcode ? undefined : firstActionRef}
              className="sketch-context-item"
              role="menuitem"
              onClick={() => {
                onRecomputeAll()
                onClose()
              }}
            >{words("PostProcessModal.recompute_all")}</button>
          </>
        )}
        {copyError && (
          <div className="post-gcode-context-error" role="alert">
            {copyError}
          </div>
        )}
      </div>
    </>
  )
}

// Full-screen g-code viewer with line numbers + go-to-line (G).
function GcodeFlyout({
  gcode,
  dialect,
  onCopyAll,
  showRecompute,
  onRecomputeAll,
  onClose,
}: {
  gcode: string
  dialect: string
  onCopyAll: (gcode: string) => Promise<void>
  showRecompute: boolean
  onRecomputeAll: () => void
  onClose: () => void
}) {
  const words = useText('setup-stock-tools-machine-post')
  const lines = useMemo(() => gcode.replace(/\n$/, '').split('\n'), [gcode])
  const [gotoValue, setGotoValue] = useState('')
  const [highlightLine, setHighlightLine] = useState<number | null>(null)
  const [contextAt, setContextAt] = useState<{ x: number; y: number } | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)
  const lineRefs = useRef<(HTMLDivElement | null)[]>([])
  const selectAllNumeric = useSelectAllOnClick()

  // Esc closes the flyout.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && contextAt === null) onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [contextAt, onClose])

  const goToLine = () => {
    const n = parseInt(gotoValue, 10)
    if (Number.isNaN(n) || n < 1 || n > lines.length) return
    const el = lineRefs.current[n - 1]
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' })
      setHighlightLine(n)
    }
  }

  return (
    <div
      className="gcode-flyout-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="gcode-flyout" onMouseDown={(e) => e.stopPropagation()}>
        <div className="gcode-flyout-head">
          <span className="gcode-flyout-title">{words("PostProcessModal.full_g_code_lines", { value1: dialect, value2: lines.length.toLocaleString() })}</span>
          <div className="gcode-flyout-goto">
            <label htmlFor="gcode-goto">{words("PostProcessModal.go_to_line")}</label>
            <input
              id="gcode-goto"
              className="mform-input mform-input-sm mform-input-mono"
              type="text" inputMode="decimal"
              onFocus={selectAllNumeric.onFocus}
              onMouseUp={selectAllNumeric.onMouseUp}
              min={1}
              max={lines.length}
              value={gotoValue}
              onChange={(e) => setGotoValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') goToLine()
              }}
              placeholder={words("PostProcessModal.symbol_5")}
            />
            <button className="modal-btn modal-btn-ghost" onClick={goToLine}>{words("PostProcessModal.go")}</button>
          </div>
          <button
            className="modal-close-btn gcode-flyout-close"
            onClick={onClose}
            data-tooltip={words("PostProcessModal.close_esc")}
            aria-label={words("PostProcessModal.close")}
          >
            <X size={18} />
          </button>
        </div>
        <div
          className="gcode-flyout-body"
          ref={scrollRef}
          data-testid="gcode-flyout-body"
          onContextMenu={(event) => {
            if (gcode.length === 0 && !showRecompute) return
            event.preventDefault()
            event.stopPropagation()
            setContextAt({ x: event.clientX, y: event.clientY })
          }}
        >
          {lines.map((ln, i) => (
            <div
              key={i}
              ref={(el) => {
                lineRefs.current[i] = el
              }}
              className={`gcode-line${highlightLine === i + 1 ? ' gcode-line-hl' : ''}`}
            >
              <span className="gcode-lineno">{i + 1}</span>
              <span className="gcode-linetext">{ln === '' ? ' ' : ln}</span>
            </div>
          ))}
        </div>
        {contextAt && (
          <PostGcodeContextMenu
            at={contextAt}
            gcode={gcode}
            onCopyAll={onCopyAll}
            showRecompute={showRecompute}
            onRecomputeAll={onRecomputeAll}
            onClose={() => setContextAt(null)}
          />
        )}
      </div>
    </div>
  )
}

function AboutTab({ config }: { config: PostConfig }) {
  const words = useText('setup-stock-tools-machine-post')
  const cap = config.capabilities
  return (
    <div className="post-about">
      <div className="mform-section-header">{words("PostProcessModal.about_this_post")}</div>
      <dl className="post-about-dl">
        <dt>{words("PostProcessModal.label")}</dt><dd>{config.label}</dd>
        <dt>{words("PostProcessModal.id")}</dt><dd>{config.id}</dd>
        <dt>{words("PostProcessModal.built_in")}</dt><dd>{config.builtin ? words("PostProcessModal.yes") : words("PostProcessModal.no")}</dd>
        <dt>{words("PostProcessModal.arcs")}</dt><dd>{cap.arcs ? words("PostProcessModal.emit_g2_g3_toleranced_arc_collapse") : words("PostProcessModal.linear_only")}</dd>
        <dt>{words("PostProcessModal.tool_change")}</dt><dd>{cap.toolChange}</dd>
        <dt>{words("PostProcessModal.comment_style")}</dt><dd>{cap.comment}</dd>
        <dt>{words("PostProcessModal.dwell_units")}</dt><dd>{cap.dwellUnits}</dd>
        <dt>{words("PostProcessModal.work_offsets")}</dt>
        <dd>
          {cap.workOffsets.g54_59 ? 'G54-G59' : words("PostProcessModal.none_2")}
          {cap.workOffsets.g10 ? ', G10 L2' : ''}
        </dd>
        <dt>{words("PostProcessModal.feed_mode")}</dt><dd>{cap.feedMode}</dd>
      </dl>
    </div>
  )
}

// ---- WO-2637: tool numbers for this program --------------------------------
// English here until the catalog grant (src/i18n/locales/en/
// setup-stock-tools-machine-post.ts) lets these join the text catalog.
type ToolNumberRow = { tool: Tool; postsAs: number | undefined; sharesWith: string[] }

function ToolNumbersSection({ rows, onSet }: {
  rows: ToolNumberRow[]
  onSet: (tool: Tool, n: number | null) => void
}) {
  const words = useText('setup-stock-tools-machine-post')
  const conflicts = rows.some((row) => row.sharesWith.length > 0)
  return (
    <div data-testid="post-tool-numbers">
      <div className="mform-section-header">{words("PostProcessModal.toolNumbersHeader")}</div>
      {conflicts && (
        <div className="op-hint" data-testid="post-tool-numbers-conflict" style={{ color: 'var(--text-danger)' }}>
          {words("PostProcessModal.toolNumbersConflict")}
        </div>
      )}
      {rows.map((row) => (
        <ToolNumberField key={row.tool.id} row={row} onSet={onSet} />
      ))}
    </div>
  )
}

function ToolNumberField({ row, onSet }: { row: ToolNumberRow; onSet: (tool: Tool, n: number | null) => void }) {
  const words = useText('setup-stock-tools-machine-post')
  const { tool, postsAs, sharesWith } = row
  const shown = postsAs === undefined ? '' : String(postsAs)
  const [draft, setDraft] = useState(shown)
  useEffect(() => { setDraft(shown) }, [shown])
  const commit = () => {
    const trimmed = draft.trim()
    if (trimmed === '') { onSet(tool, null); return }
    const n = Number(trimmed)
    if (isPostToolNumber(n)) onSet(tool, n)
    else setDraft(shown)
  }
  const library = tool.toolNumber === undefined
    ? words("PostProcessModal.toolNumberNoneInLibrary")
    : words("PostProcessModal.toolNumberInLibrary", { number: String(tool.toolNumber) })
  return (
    <div className="mform-row" data-testid={`post-tool-number-row-${tool.id}`}>
      <span className="mform-label" title={tool.name}>{tool.name}</span>
      <span className="mform-label" style={{ minWidth: 'auto' }}>{words("PostProcessModal.toolNumberLetter")}</span>
      <input
        className="mform-input mform-input-sm mform-input-mono"
        type="text" inputMode="numeric"
        aria-label={words("PostProcessModal.toolNumberFieldLabel", { name: tool.name })}
        data-testid={`post-tool-number-${tool.id}`}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
      />
      <span className="op-hint" style={{ margin: 0 }}>
        {sharesWith.length > 0
          ? words("PostProcessModal.toolNumberSharesWith", {
            number: String(postsAs),
            names: sharesWith.map((name) => `"${name}"`).join(', '),
            library,
          })
          : words("PostProcessModal.toolNumberPostsAs", { number: String(postsAs), library })}
      </span>
    </div>
  )
}

function Toggle({
  checked,
  onChange,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  disabled?: boolean
}) {
  return (
    // CVU-2: REGIME 2 ownership marker (see DisclosureSection.tsx) -- covers
    // this control's own track+knob children (PANEL-INTERNAL in the UI-70
    // census: internal to this switch, not a canvas overlay).
    <label className={`toggle${disabled ? ' toggle-disabled' : ''}`} data-ui78-sanctioned="">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <span className="track" />
      <span className="knob" />
    </label>
  )
}

// ============================================================
// Small helpers
// ============================================================

function clampInt(raw: string, lo: number, hi: number): number {
  const n = parseInt(raw, 10)
  if (Number.isNaN(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

function floatClamp(raw: string, lo: number, hi: number): number {
  const n = parseFloat(raw)
  if (Number.isNaN(n)) return lo
  return Math.max(lo, Math.min(hi, n))
}

function floatOrUndef(raw: string): number | undefined {
  if (raw.trim() === '') return undefined
  const n = parseFloat(raw)
  return Number.isNaN(n) ? undefined : n
}

function numOrEmpty(v: unknown): number | string {
  return typeof v === 'number' ? v : ''
}

// Split a textarea value into literal lines, dropping a single trailing blank.
function splitLines(v: string): string[] {
  const lines = v.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}
