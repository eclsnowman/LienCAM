// WO-411 slice 4 - the probe routine EDITOR in the Probing tab: the Routines
// list (factory / user / imported / quarantined), the editor for one routine
// (inputs, steps, outputs as readable forms, validated on every change with the
// step-named sentence inline), the library actions (Duplicate / Delete / Hide /
// Restore factory / Import / Export / New), and Check - which runs the
// validator and the expander against the LIVE machine profile, envelope and
// position and hands the result to ProbeRoutinePreview.
//
// Hosting pattern: the whole Control > Routines tab (standalone), no modal,
// no pop-over. Operator 2026-08-21 cleanup: the routine list is ONE dropdown
// (Factory / Yours / Imported) beside New / Import / Restore; below it two
// columns, editor | preview, each scrolling inside its own box so the tab
// itself never scrolls. The non-standalone (collapsible card) form survives
// for tests only.
//
// This file MOVES NOTHING. It imports no command emitter; the Run button
// hands the machine-code hand-off to ProbeRoutineRunPanel (slice 3).

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type ReactNode } from 'react'
import { useProbeRoutineStore } from '../../store/probeRoutineStore'
import type { ProbeRoutineLibraryEntry } from '../../lib/machine/probeRoutineLibrary'
import {
  PROBE_ROUTINE_SCHEMA_VERSION,
  PROBE_ROUTINE_STEP_KINDS,
  validateProbeRoutine,
  type ProbeRoutine,
  type ProbeRoutineCondition,
  type ProbeRoutineComparison,
  type ProbeRoutineInput,
  type ProbeRoutineOutput,
  type ProbeRoutineStep,
  type RoutineError,
} from '../../lib/machine/probeRoutineFormat'
import {
  describeToolSetterPlan,
  expandProbeRoutine,
  planToolSetterMeasure,
  type ExpandedDisplayUnits,
  type ExpandPoint,
  type ProbeRoutineExpandContext,
  type ToolSetterPlanContext,
} from '../../lib/machine/probeRoutineExpand'
import {
  FACTORY_BOSS_CENTRE,
  FACTORY_BOSS_CENTRE_ID,
  FACTORY_TOOL_SETTER,
  FACTORY_TOOL_SETTER_ID,
  findFactoryRoutine,
  isFactoryHoleRoutineId,
  isToolSetterRoutine,
  toolSetterRoutineForMachine,
  bossRoutineForMachine,
  holeRoutineForMachine,
  type ToolSetterDefaults,
} from '../../lib/machine/probeRoutineFactory'
import type { ImportCollision, ImportRoutinesResult } from '../../lib/machine/probeRoutineFile'
import type { MachineEnvelope, EnvelopeStatus } from '../../lib/machine/machineEnvelope'
import type { EffectiveProbeConfig } from '../../lib/machine/toolTable'
import type { AxisFeedLimits, Units } from '../../types'
import { ProbeRoutinePreview, type ProbeRoutinePreviewState } from './ProbeRoutinePreview'
import { HelpLink } from '../ui/HelpLink'
import { errorCodeAnchor } from '../../help/helpOpen'
import { saveFile } from '../../lib/saveFile'

// --- props ----------------------------------------------------------------------

export interface ProbeRoutineEditorProps {
  /** The honest machine position (null unless homed this session - WO-304). */
  start: ExpandPoint | null
  envelopeStatus: EnvelopeStatus
  envelope: MachineEnvelope
  probe: EffectiveProbeConfig
  tipRadiusMm: number
  axisLimits?: { x: AxisFeedLimits; y: AxisFeedLimits; z: AxisFeedLimits } | null
  activeWcs: string | null
  units: Units
  /** Start with the station open (tests and captures); the default is collapsed. */
  defaultOpen?: boolean
  /** Hosted as the whole Routines tab (WO-411, Operator 2026-08-21): always open,
   *  no Show/Hide toggle - the tab is the disclosure. */
  standalone?: boolean
  /** Rendered at the end of the picker row (the Routines tab puts the tip
   *  radius field here - the one live number Check needs from the operator). */
  headerExtra?: ReactNode
  /** WO-1613: the live facts a tool setter routine is filled from (the factory
   *  one's defaults come from the machine definition) and previewed with. */
  toolSetter?: { defaults: Partial<ToolSetterDefaults>; context: ToolSetterPlanContext } | null
  /** WO-2052: this machine's boss cross-over height, machine Z (its safe Z, else
   *  the top of Z travel less 1) - the factory Boss centre's default. */
  bossCrossOverZ?: number | null
  /** WO-2074: the active work offset's Z0, machine Z - the factory Bore centre
   *  and Inside corner routines' `topZ` default (the hole is in the face Z0
   *  was probed on). Null until a work offset is known. */
  workZeroMachineZ?: number | null
}

/** A draft the Measure tool plan can read (the draft may be mid-edit and malformed). */
function asToolSetterDraft(draft: ProbeRoutine | null): ProbeRoutine | null {
  if (!draft || !Array.isArray(draft.inputs) || typeof draft.requires !== 'object' || draft.requires === null) return null
  return isToolSetterRoutine(draft) ? draft : null
}

const START_REASON: Record<Exclude<EnvelopeStatus, 'homed'>, string> = {
  unknown: 'connect the machine and read its settings first',
  'not-homed': 'home the machine ($H) first - until then its position is not a fact about the table',
  'no-datum': 'this machine has no homing switches, so there is no machine datum to place a routine on',
}

// --- small immutable helpers ----------------------------------------------------

type PathKey = string | number
type Path = readonly PathKey[]

function cloneShallow<T>(value: T): T {
  if (Array.isArray(value)) return [...value] as unknown as T
  if (typeof value === 'object' && value !== null) return { ...(value as object) } as T
  return value
}

/** A copy of `root` with the value at `path` replaced (containers copied along the way). */
function setIn<T>(root: T, path: Path, value: unknown): T {
  if (path.length === 0) return value as T
  const copy = cloneShallow(root) as Record<PathKey, unknown>
  const [head, ...rest] = path
  copy[head] = setIn(copy[head], rest, value)
  return copy as T
}

/** A copy of `root` with the key / index at the end of `path` removed. */
function removeIn<T>(root: T, path: Path): T {
  if (path.length === 0) return root
  const parentPath = path.slice(0, -1)
  const last = path[path.length - 1]
  const parent = getIn(root, parentPath)
  if (Array.isArray(parent)) {
    const next = parent.filter((_, i) => i !== last)
    return setIn(root, parentPath, next)
  }
  if (typeof parent === 'object' && parent !== null) {
    const next = { ...(parent as Record<PathKey, unknown>) }
    delete next[last]
    return setIn(root, parentPath, next)
  }
  return root
}

function getIn(root: unknown, path: Path): unknown {
  let cur: unknown = root
  for (const key of path) {
    if (typeof cur !== 'object' || cur === null) return undefined
    cur = (cur as Record<PathKey, unknown>)[key]
  }
  return cur
}

function pathKey(path: Path): string {
  return path.map((p) => (typeof p === 'number' ? `[${p}]` : `.${p}`)).join('')
}

/** Text typed into a number field: a finite number when it parses, else the raw text (the validator names it). */
function numberOrText(text: string): number | string {
  const trimmed = text.trim()
  if (trimmed === '') return ''
  const n = Number(trimmed)
  return Number.isFinite(n) ? n : text
}

function exprText(value: unknown): string {
  return value === undefined || value === null ? '' : String(value)
}

// --- step numbering (the validator's: pre-order, branch arms counted in place) -----

function numberSteps(steps: unknown, start: number, out: Map<string, number>, basePath: Path): number {
  let n = start
  if (!Array.isArray(steps)) return n
  steps.forEach((step, i) => {
    const path = [...basePath, i]
    out.set(pathKey(path), n)
    n += 1
    if (typeof step === 'object' && step !== null && (step as { kind?: unknown }).kind === 'branch') {
      n = numberSteps((step as { then?: unknown }).then, n, out, [...path, 'then'])
      n = numberSteps((step as { else?: unknown }).else, n, out, [...path, 'else'])
    }
  })
  return n
}

// --- defaults for new things ---------------------------------------------------------

function newRoutine(existingIds: ReadonlySet<string>): ProbeRoutine {
  let id = 'user.new-routine'
  let n = 2
  while (existingIds.has(id)) id = `user.new-routine-${n++}`
  return {
    schemaVersion: PROBE_ROUTINE_SCHEMA_VERSION,
    id,
    name: 'New routine',
    version: '1.0.0',
    provenance: { kind: 'user' },
    description: '',
    requires: { homed: true, envelope: 'full', probe: 'touch' },
    inputs: [],
    steps: [],
    outputs: [],
  }
}

function newStep(kind: ProbeRoutineStep['kind'], existingNames: ReadonlySet<string>): ProbeRoutineStep {
  const fresh = (base: string) => {
    let name = base
    let n = 2
    while (existingNames.has(name)) name = `${base}${n++}`
    return name
  }
  switch (kind) {
    case 'move': return { kind: 'move', to: { x: '0', y: '0' } }
    case 'touch': return { kind: 'touch', name: fresh('touch'), axis: 'X', direction: '-', searchMm: '10' }
    case 'calc': return { kind: 'calc', name: fresh('value'), unit: 'mm', expr: '0' }
    case 'check': return { kind: 'check', condition: { cmp: '>', left: '1', right: '0' }, message: 'Stopped by a check.' }
    case 'branch': return { kind: 'branch', condition: { cmp: '>', left: '1', right: '0' }, then: [], else: [] }
  }
}

function newInput(type: ProbeRoutineInput['type'], existingNames: ReadonlySet<string>): ProbeRoutineInput {
  let name: string = type
  let n = 2
  while (existingNames.has(name)) name = `${type}${n++}`
  switch (type) {
    case 'length': return { name, label: 'Length', type: 'length', unit: 'mm', min: 0, max: 100, default: 10 }
    case 'angle': return { name, label: 'Angle', type: 'angle', unit: 'deg', min: -90, max: 90, default: 0 }
    case 'count': return { name, label: 'Count', type: 'count', min: 1, max: 10, default: 2 }
    case 'enum': return { name, label: 'Choice', type: 'enum', options: ['a', 'b'], default: 'a' }
  }
}

function newOutput(kind: ProbeRoutineOutput['kind']): ProbeRoutineOutput {
  switch (kind) {
    case 'workOffset': return { kind: 'workOffset', wcs: 'active', axes: { X: '0' }, label: 'Set X' }
    case 'toolLength': return { kind: 'toolLength', tool: 'active', machineZ: '0', label: 'Tool length' }
    case 'report': return { kind: 'report', items: [{ label: 'Value', expr: '0', unit: 'mm' }] }
  }
}

function newComparison(): ProbeRoutineComparison {
  return { cmp: '>', left: '1', right: '0' }
}

function conditionList(condition: ProbeRoutineCondition | undefined): { mode: 'one' | 'all' | 'any'; items: ProbeRoutineComparison[] } {
  if (!condition || typeof condition !== 'object') return { mode: 'one', items: [] }
  if ('all' in condition) return { mode: 'all', items: Array.isArray(condition.all) ? condition.all : [] }
  if ('any' in condition) return { mode: 'any', items: Array.isArray(condition.any) ? condition.any : [] }
  return { mode: 'one', items: [condition as ProbeRoutineComparison] }
}

function stepDisplayName(step: ProbeRoutineStep): string {
  if (step?.kind === 'calc') return '' // the calc sentence already starts with its name
  const name = (step as { name?: unknown }).name
  return typeof name === 'string' && name.length > 0 ? `'${name}'` : ''
}

/** The plain sentence a step reads as in the list (the file's own words, before expansion). */
function stepSentence(step: ProbeRoutineStep): string {
  switch (step.kind) {
    case 'move': {
      const to = step.to && typeof step.to === 'object' ? step.to : {}
      const parts = (['x', 'y', 'z'] as const).filter((a) => to[a] !== undefined).map((a) => `${a.toUpperCase()} ${exprText(to[a])}`)
      const frame = step.frame === 'machine' ? 'machine' : 'start-relative'
      return `${step.feed === 'rapid' ? 'Rapid' : 'Move'} to ${parts.join(', ') || '(nowhere)'} (${frame})${step.safeZ !== undefined ? `, safe Z at machine Z ${exprText(step.safeZ)}` : ''}`
    }
    case 'touch':
      return `Probe toward ${exprText(step.axis)}${exprText(step.direction)} up to ${exprText(step.searchMm)} mm`
    case 'calc':
      return `${exprText(step.name)} = ${exprText(step.expr)} (${exprText(step.unit)})`
    case 'check': {
      const { mode, items } = conditionList(step.condition)
      return `Check ${items.map((c) => `${exprText(c.left)} ${c.cmp} ${exprText(c.right)}`).join(mode === 'any' ? ' or ' : ' and ')}; otherwise stop: ${exprText(step.message)}`
    }
    case 'branch': {
      const { mode, items } = conditionList(step.condition)
      return `If ${items.map((c) => `${exprText(c.left)} ${c.cmp} ${exprText(c.right)}`).join(mode === 'any' ? ' or ' : ' and ')}`
    }
    default:
      return `Unknown step kind '${String((step as { kind?: unknown }).kind)}'`
  }
}

const PROVENANCE_LABEL = { factory: 'FACTORY', user: 'USER', imported: 'IMPORTED' } as const

function downloadText(fileName: string, text: string): boolean {
  if (typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function' || typeof document === 'undefined') return false
  void saveFile(fileName, text, 'application/json')
  return true
}

// --- the component -------------------------------------------------------------------

export function ProbeRoutineEditor({
  start,
  envelopeStatus,
  envelope,
  probe,
  tipRadiusMm,
  axisLimits = null,
  activeWcs,
  units,
  defaultOpen = false,
  standalone = false,
  headerExtra = null,
  toolSetter = null,
  bossCrossOverZ = null,
  workZeroMachineZ = null,
}: ProbeRoutineEditorProps) {
  // The factory setter routine shows (and a copy of it keeps) this machine's
  // setter, crossing height and search depth - read through a ref so select()
  // stays stable while the live context ticks.
  const setterDefaultsRef = useRef<Partial<ToolSetterDefaults> | null>(null)
  setterDefaultsRef.current = toolSetter?.defaults ?? null
  const bossCrossOverZRef = useRef<number | null>(null)
  bossCrossOverZRef.current = bossCrossOverZ
  const workZeroMachineZRef = useRef<number | null>(null)
  workZeroMachineZRef.current = workZeroMachineZ
  const activeWcsRef = useRef<string | null>(null)
  activeWcsRef.current = activeWcs
  const forMachine = (routine: ProbeRoutine): ProbeRoutine => {
    const withSetter = setterDefaultsRef.current ? toolSetterRoutineForMachine(routine, setterDefaultsRef.current) : routine
    const withBoss = bossRoutineForMachine(withSetter, bossCrossOverZRef.current)
    return holeRoutineForMachine(withBoss, workZeroMachineZRef.current, activeWcsRef.current)
  }
  // subscribe to the library slices so the list re-renders on every change
  const routines = useProbeRoutineStore((s) => s.routines)
  const quarantined = useProbeRoutineStore((s) => s.quarantined)
  const hidden = useProbeRoutineStore((s) => s.hidden)
  const entries: ProbeRoutineLibraryEntry[] = useMemo(
    () => useProbeRoutineStore.getState().listRoutines({ includeHidden: true }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [routines, hidden],
  )
  const quarantinedIds = useMemo(() => Object.keys(quarantined).sort(), [quarantined])

  const [openState, setOpen] = useState(defaultOpen)
  const open = standalone || openState
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [draft, setDraft] = useState<ProbeRoutine | null>(null)
  const [isNew, setIsNew] = useState(false)
  const [dirty, setDirty] = useState(false)
  const [inputValues, setInputValues] = useState<Record<string, string>>({})
  const [preview, setPreview] = useState<ProbeRoutinePreviewState>({ kind: 'idle' })
  const [previewStale, setPreviewStale] = useState(false)
  const [sourceOpen, setSourceOpen] = useState(false)
  const [status, setStatus] = useState<{ kind: 'ok' | 'error'; lines: string[] } | null>(null)
  const [importReport, setImportReport] = useState<ImportRoutinesResult | null>(null)
  const [pendingCollisions, setPendingCollisions] = useState<ImportCollision[]>([])
  const [addStepKind, setAddStepKind] = useState<ProbeRoutineStep['kind']>('touch')
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const stored = selectedId ? useProbeRoutineStore.getState().getRoutine(selectedId) : null
  const provenanceKind = isNew ? 'user' : draft?.provenance.kind ?? stored?.provenance.kind ?? null
  const readOnly = provenanceKind === 'factory'

  const select = useCallback((id: string | null) => {
    const stored = id ? useProbeRoutineStore.getState().getRoutine(id) : null
    const withSetter = stored && setterDefaultsRef.current ? toolSetterRoutineForMachine(stored, setterDefaultsRef.current) : stored
    const withBoss = withSetter ? bossRoutineForMachine(withSetter, bossCrossOverZRef.current) : withSetter
    const routine = withBoss ? holeRoutineForMachine(withBoss, workZeroMachineZRef.current, activeWcsRef.current) : withBoss
    setSelectedId(id)
    setDraft(routine)
    setIsNew(false)
    setDirty(false)
    setPreview({ kind: 'idle' })
    setPreviewStale(false)
    setSourceOpen(false)
    setStatus(null)
    setInputValues({})
  }, [])

  // keep the selection honest when the library changes under it (a delete, an import replacing it)
  useEffect(() => {
    if (selectedId === null || isNew) return
    if (useProbeRoutineStore.getState().getRoutine(selectedId) === null && !(selectedId in quarantined)) {
      select(null)
    }
  }, [routines, quarantined, selectedId, isNew, select])

  // WO-2052: the machine's cross-over height can arrive after the factory Boss
  // centre was picked (connect, home, a Safe Z edit) - an unedited pick follows it.
  const [followedBossCrossOverZ, setFollowedBossCrossOverZ] = useState(bossCrossOverZ)
  if (followedBossCrossOverZ !== bossCrossOverZ) {
    setFollowedBossCrossOverZ(bossCrossOverZ)
    if (selectedId === FACTORY_BOSS_CENTRE_ID && !isNew && !dirty && draft) {
      setDraft(bossRoutineForMachine(draft, bossCrossOverZ))
      setPreviewStale(true)
    }
  }

  // WO-2074: work Z0 can arrive, or change, after the factory Bore centre or
  // Inside corner was picked (connect, home, a work offset edit, a WCS
  // switch) - an unedited pick follows it, same as the boss's cross-over height.
  const [followedWorkZero, setFollowedWorkZero] = useState({ z: workZeroMachineZ, wcs: activeWcs })
  if (followedWorkZero.z !== workZeroMachineZ || followedWorkZero.wcs !== activeWcs) {
    setFollowedWorkZero({ z: workZeroMachineZ, wcs: activeWcs })
    if (isFactoryHoleRoutineId(selectedId) && !isNew && !dirty && draft) {
      setDraft(holeRoutineForMachine(draft, workZeroMachineZ, activeWcs))
      setPreviewStale(true)
    }
  }

  const touchDraft = useCallback((updater: (prev: ProbeRoutine) => ProbeRoutine) => {
    setDraft((prev) => (prev ? updater(prev) : prev))
    setDirty(true)
    setPreviewStale(true)
  }, [])
  const setField = useCallback((path: Path, value: unknown) => touchDraft((prev) => setIn(prev, path, value)), [touchDraft])
  const removeField = useCallback((path: Path) => touchDraft((prev) => removeIn(prev, path)), [touchDraft])
  /** Optional expression text: empty clears the key. */
  const setOptionalExpr = useCallback((path: Path, text: string) => {
    if (text.trim() === '') removeField(path)
    else setField(path, text)
  }, [removeField, setField])

  const displayUnits: ExpandedDisplayUnits = units === 'inch' ? 'in' : 'mm'
  const profileFeeds = useMemo(() => ({ searchMmMin: probe.fastFeed, finalMmMin: probe.slowFeed }), [probe.fastFeed, probe.slowFeed])

  // live validation of the draft, on every change
  const validation = useMemo(
    () => (draft ? validateProbeRoutine(draft, { profileFeeds }) : null),
    [draft, profileFeeds],
  )
  const errors: RoutineError[] = validation && !validation.ok ? validation.errors : []
  const stepNumbers = useMemo(() => {
    const map = new Map<string, number>()
    numberSteps(draft?.steps, 1, map, ['steps'])
    return map
  }, [draft])
  const errorsByStep = useMemo(() => {
    const map = new Map<number, RoutineError[]>()
    for (const e of errors) {
      if (e.where === 'step' && e.step) {
        const list = map.get(e.step.number) ?? []
        list.push(e)
        map.set(e.step.number, list)
      }
    }
    return map
  }, [errors])
  const setterDraft = asToolSetterDraft(draft)
  // Planned from the routine's DEFAULTS only: those are what the Measure tool
  // button runs, so a per-run value typed here would preview a different path.
  const setterPlan = useMemo(
    () => (setterDraft && toolSetter ? planToolSetterMeasure(setterDraft, {}, toolSetter.context) : null),
    [setterDraft, toolSetter],
  )
  const errorsFor = (where: RoutineError['where'], index: number): RoutineError[] =>
    errors.filter((e) => e.where === where && e.index === index)
  const routineErrors = errors.filter((e) => e.where === 'routine')

  // --- actions ------------------------------------------------------------------

  const store = () => useProbeRoutineStore.getState()

  const runCheck = () => {
    if (!draft) return
    const validated = validateProbeRoutine(draft, { profileFeeds })
    if (!validated.ok) {
      setPreview({ kind: 'errors', stage: 'static', errors: validated.errors })
      setPreviewStale(false)
      return
    }
    if (!start || envelopeStatus !== 'homed') {
      const reason = envelopeStatus === 'homed' ? 'the machine position is not known' : START_REASON[envelopeStatus]
      setPreview({ kind: 'blocked', sentence: `Check needs the live machine position to place "${draft.name}" on the table: ${reason}.` })
      setPreviewStale(false)
      return
    }
    const bound: Record<string, number | string> = {}
    for (const input of validated.routine.inputs) {
      const raw = inputValues[input.name]
      if (raw === undefined || raw.trim() === '') continue
      bound[input.name] = input.type === 'enum' ? raw : numberOrText(raw)
    }
    const ctx: ProbeRoutineExpandContext = {
      start,
      envelope,
      probe,
      tipRadiusMm,
      axisLimits,
      activeWcs,
    }
    const result = expandProbeRoutine(validated.routine, bound, ctx)
    if (!result.ok) {
      setPreview({ kind: 'errors', stage: 'expansion', errors: result.errors })
    } else {
      setPreview({ kind: 'ok', expanded: result.expanded })
      // reviewed-once (slice 5): an imported routine, unchanged from what is
      // stored, counts as reviewed for exactly this expansion.
      if (!dirty && !isNew && selectedId && validated.routine.provenance.kind === 'imported') {
        store().markReviewed(selectedId, result.expanded.hash)
      }
    }
    setPreviewStale(false)
  }

  const save = () => {
    if (!draft) return
    const result = store().saveRoutine(draft)
    if (!result.ok) {
      setStatus({ kind: 'error', lines: result.errors })
      return
    }
    setSelectedId(draft.id)
    setIsNew(false)
    setDirty(false)
    setDraft(store().getRoutine(draft.id))
    setStatus({ kind: 'ok', lines: [`Saved "${draft.name}".`] })
  }

  const revert = () => {
    if (isNew) { select(null); return }
    select(selectedId)
  }

  const duplicate = () => {
    if (!selectedId || isNew) return
    const result = store().duplicateRoutine(selectedId)
    if (!result.ok || !result.id) { setStatus({ kind: 'error', lines: result.errors }); return }
    // WO-1613: a copy of the factory setter routine starts from THIS machine's
    // setter and heights, as shown - not the compiled generic numbers.
    if (selectedId === FACTORY_TOOL_SETTER_ID) {
      const copy = store().getRoutine(result.id)
      if (copy) store().saveRoutine({ ...forMachine(FACTORY_TOOL_SETTER), id: copy.id, name: copy.name, provenance: { kind: 'user' } })
    }
    // WO-2052: likewise a copy of the Boss centre keeps this machine's cross-over height.
    if (selectedId === FACTORY_BOSS_CENTRE_ID) {
      const copy = store().getRoutine(result.id)
      if (copy) store().saveRoutine({ ...forMachine(FACTORY_BOSS_CENTRE), id: copy.id, name: copy.name, provenance: { kind: 'user' } })
    }
    // WO-2074: likewise a copy of the Bore centre / Inside corner keeps this
    // machine's work Z0 as the top.
    if (isFactoryHoleRoutineId(selectedId)) {
      const source = findFactoryRoutine(selectedId)
      const copy = source ? store().getRoutine(result.id) : null
      if (source && copy) store().saveRoutine({ ...forMachine(source), id: copy.id, name: copy.name, provenance: { kind: 'user' } })
    }
    select(result.id)
    setStatus({ kind: 'ok', lines: [`Duplicated as '${result.id}' - this copy is yours to edit.`] })
  }

  const remove = () => {
    if (!selectedId || isNew) return
    const name = draft?.name ?? selectedId
    const result = store().deleteRoutine(selectedId)
    if (!result.ok) { setStatus({ kind: 'error', lines: result.errors }); return }
    select(null)
    setStatus({ kind: 'ok', lines: [`Deleted "${name}".`] })
  }

  const hide = () => {
    if (!selectedId) return
    const result = store().hideFactoryRoutine(selectedId)
    setStatus(result.ok ? { kind: 'ok', lines: ['Hidden from the list. "Restore factory routines" brings it back.'] } : { kind: 'error', lines: result.errors })
  }

  const restoreFactory = () => {
    store().restoreFactoryRoutines()
    setStatus({ kind: 'ok', lines: ['Factory routines restored: every one visible and at its shipped content; your routines were not touched.'] })
  }

  const startNew = () => {
    const ids = new Set([...entries.map((e) => e.routine.id), ...quarantinedIds])
    const routine = newRoutine(ids)
    setSelectedId(routine.id)
    setDraft(routine)
    setIsNew(true)
    setDirty(true)
    setPreview({ kind: 'idle' })
    setPreviewStale(false)
    setStatus(null)
    setInputValues({})
  }

  const exportSelected = () => {
    if (!selectedId || isNew) return
    const result = store().exportRoutines([selectedId])
    if (!result.ok) { setStatus({ kind: 'error', lines: result.errors }); return }
    const downloaded = downloadText(result.fileName, result.text)
    setStatus({
      kind: downloaded ? 'ok' : 'error',
      lines: [downloaded ? `Exported "${draft?.name ?? selectedId}" as ${result.fileName}.` : 'This browser could not offer the file for download.'],
    })
  }

  const onImportFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => importText(typeof reader.result === 'string' ? reader.result : '', file.name)
    reader.onerror = () => setStatus({ kind: 'error', lines: [`Could not read ${file.name}.`] })
    reader.readAsText(file)
  }

  const importText = (text: string, fileName: string) => {
    const result = store().importFromText(text, fileName, 'ask')
    setImportReport(result)
    setPendingCollisions(result.collisions.filter((c) => c.resolution === 'pending'))
    if (result.ok && result.accepted.length === 1 && result.collisions.length === 0) select(result.accepted[0].id)
    setStatus(null)
  }

  const settleCollision = (collision: ImportCollision, decision: 'replace' | 'keep-both' | 'skip') => {
    const result = store().resolveCollision(collision, decision)
    setPendingCollisions((prev) => prev.filter((c) => c !== collision))
    if (!result.ok) setStatus({ kind: 'error', lines: result.errors })
  }

  // --- render -------------------------------------------------------------------

  const selectedEntry = entries.find((e) => e.routine.id === selectedId) ?? null
  const canEditThis = draft !== null && !readOnly
  const storedImported = stored?.provenance.kind === 'imported' ? stored : null

  // WO-411 cleanup (Operator ruling 2026-08-21: "no motion buttons ... no WCS ... try to
  // eliminate scrolling"): the routine list is ONE dropdown grouped Factory /
  // Yours / Imported, with New / Import / Restore beside it; the editor and
  // the preview take the full width as two columns that scroll INSIDE their
  // own boxes, so the tab itself never scrolls.
  const grouped = useMemo(() => ({
    factory: entries.filter((e) => e.kind === 'factory'),
    user: entries.filter((e) => e.kind === 'user'),
    imported: entries.filter((e) => e.kind === 'imported'),
  }), [entries])
  const optionLabel = (entry: ProbeRoutineLibraryEntry): string => {
    const notes: string[] = []
    if (entry.kind === 'imported') notes.push(typeof entry.routine.provenance.reviewedHash === 'string' ? 'reviewed once' : 'not yet reviewed')
    if (entry.hidden) notes.push('hidden')
    return notes.length > 0 ? `${entry.routine.name} (${notes.join(', ')})` : entry.routine.name
  }
  const renderOption = (entry: ProbeRoutineLibraryEntry) => (
    <option
      key={entry.routine.id}
      value={entry.routine.id}
      className={`probe-routine-item${entry.hidden ? ' probe-routine-item-hidden' : ''}`}
      data-testid={`probe-routine-item-${entry.routine.id}`}
      data-kind={entry.kind}
      data-hidden={entry.hidden ? 'true' : undefined}
    >
      {optionLabel(entry)}
    </option>
  )
  const selectValue = isNew ? '' : selectedId ?? ''
  const pickerRow = (
    <div className="probe-routine-picker-row" data-testid="probe-routine-picker-row">
      <label className="probe-routine-picker" data-testid="probe-routine-list">
        <span>Routine</span>
        <select
          className="mform-input"
          data-testid="probe-routine-select"
          aria-label="Probe routines"
          value={selectValue}
          onChange={(e) => select(e.target.value === '' ? null : e.target.value)}
        >
          <option value="">{isNew ? 'New routine (unsaved)' : entries.length === 0 ? 'No routines - press New or Import' : 'Pick a routine...'}</option>
          {grouped.factory.length > 0 && <optgroup label="Factory" data-testid="probe-routine-group-factory">{grouped.factory.map(renderOption)}</optgroup>}
          {grouped.user.length > 0 && <optgroup label="Yours" data-testid="probe-routine-group-user">{grouped.user.map(renderOption)}</optgroup>}
          {grouped.imported.length > 0 && <optgroup label="Imported" data-testid="probe-routine-group-imported">{grouped.imported.map(renderOption)}</optgroup>}
        </select>
      </label>
      {selectedEntry && !isNew && (
        <span className="probe-routine-picked-meta" data-testid="probe-routine-picked-meta">
          <span className="probe-routine-badge" data-kind={selectedEntry.kind}>{PROVENANCE_LABEL[selectedEntry.kind]}</span>
          {selectedEntry.kind === 'imported' && (
            <span
              className="probe-routine-badge"
              data-kind={typeof selectedEntry.routine.provenance.reviewedHash === 'string' ? 'reviewed' : 'unreviewed'}
              data-testid={`probe-routine-reviewed-${selectedEntry.routine.id}`}
            >
              {typeof selectedEntry.routine.provenance.reviewedHash === 'string' ? 'reviewed once' : 'not yet reviewed'}
            </span>
          )}
          {selectedEntry.hidden && <span className="probe-routine-badge" data-kind="hidden">hidden</span>}
        </span>
      )}
      <div className="probe-routine-toolbar">
        <button className="modal-btn modal-btn-ghost" data-testid="probe-routine-new" onClick={startNew}>New</button>
        <button className="modal-btn modal-btn-ghost" data-testid="probe-routine-import" onClick={() => fileInputRef.current?.click()}>Import</button>
        <input
          ref={fileInputRef}
          type="file"
          accept=".json,.liencam-probe.json,application/json"
          className="probe-routine-file-input"
          data-testid="probe-routine-import-input"
          onChange={onImportFile}
        />
        <button className="modal-btn modal-btn-ghost" data-testid="probe-routine-restore" onClick={restoreFactory}>Restore factory routines</button>
      </div>
      {headerExtra}
    </div>
  )

  return (
    <section
      className={`control-probe-setup-card probe-routine-station${open ? ' probe-routine-station-open' : ''}${standalone ? ' probe-routine-station-standalone' : ''}`}
      data-testid="probe-routine-section"
      data-open={open ? 'true' : 'false'}
    >
      {!standalone && (
        <div className="probe-routine-station-head">
          <div className="control-probe-zone-head probe-routine-station-title">
            <strong>
              Routines
              <HelpLink topic="probe-routines" label="Help" testId="probe-routine-help" />
            </strong>
            <span>
              {entries.length} routine{entries.length === 1 ? '' : 's'} - factory ones are read-only (duplicate to edit);
              yours and imported ones can be edited here. Check previews a routine on this machine before anything runs.
            </span>
          </div>
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="probe-routine-toggle"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? 'Hide routines' : 'Show routines'}
          </button>
        </div>
      )}

      {open && (
        <>
          {pickerRow}
          {quarantinedIds.length > 0 && (
            <ul className="probe-routine-items probe-routine-quarantine-list" aria-label="Quarantined routines" data-testid="probe-routine-quarantine-list">
              {quarantinedIds.map((id) => {
                const q = quarantined[id]
                const json = q.json as { name?: unknown } | null
                const name = json && typeof json === 'object' && typeof json.name === 'string' ? json.name : id
                return (
                  <li key={`q-${id}`} className="probe-routine-quarantined" data-testid={`probe-routine-quarantined-${id}`}>
                    <div className="probe-routine-item probe-routine-item-quarantined">
                      <span className="probe-routine-item-name">{name}</span>
                      <span className="probe-routine-item-meta">
                        <span className="probe-routine-badge" data-kind="quarantined">QUARANTINED</span>
                      </span>
                      <ul className="probe-routine-quarantine-reasons">
                        {q.errors.map((e, i) => <li key={i}>{e}</li>)}
                      </ul>
                      <button
                        className="modal-btn modal-btn-ghost"
                        data-testid={`probe-routine-quarantined-delete-${id}`}
                        onClick={() => {
                          const r = store().deleteRoutine(id)
                          setStatus(r.ok ? { kind: 'ok', lines: [`Removed the quarantined routine '${id}'.`] } : { kind: 'error', lines: r.errors })
                        }}
                      >
                        Delete
                      </button>
                    </div>
                  </li>
                )
              })}
            </ul>
          )}
          {importReport && (
            <div className="probe-routine-import-report" data-testid="probe-routine-import-report">
              <strong>{importReport.ok ? 'Import' : 'Import refused'}</strong>
              {importReport.fileErrors.map((e, i) => <div key={`f${i}`} className="control-probe-status-error">{e}</div>)}
              {importReport.accepted.length > 0 && (
                <div>Accepted: {importReport.accepted.map((r) => `"${r.name}" (${r.id})`).join(', ')}.</div>
              )}
              {importReport.renamed.map((r, i) => <div key={`r${i}`}>{r.sentence}</div>)}
              {importReport.refused.map((r, i) => (
                <div key={`x${i}`} className="control-probe-status-error">
                  Refused #{r.index}{r.name ? ` "${r.name}"` : ''}: {r.sentences.join(' ')}
                </div>
              ))}
              {importReport.notes.map((n, i) => <div key={`n${i}`}>{n}</div>)}
              {pendingCollisions.map((c) => (
                <div key={c.id} className="probe-routine-collision" data-testid={`probe-routine-collision-${c.id}`}>
                  <span>{c.sentence}</span>
                  <span className="probe-routine-toolbar">
                    <button className="modal-btn modal-btn-ghost" onClick={() => settleCollision(c, 'replace')}>Replace</button>
                    <button className="modal-btn modal-btn-ghost" onClick={() => settleCollision(c, 'keep-both')}>Keep both</button>
                    <button className="modal-btn modal-btn-ghost" onClick={() => settleCollision(c, 'skip')}>Skip</button>
                  </span>
                </div>
              ))}
              <button className="modal-btn modal-btn-ghost" onClick={() => { setImportReport(null); setPendingCollisions([]) }}>Dismiss</button>
            </div>
          )}

          <div className="probe-routine-columns" data-testid="probe-routine-columns">
            {/* ---- column 1: the editor ---- */}
            <div className="probe-routine-editor-col" data-testid="probe-routine-editor">
              {draft === null ? (
                <div className="control-probe-plan" data-testid="probe-routine-editor-empty">
                  Pick a routine from the dropdown above to read or edit it, or press New to write one.
                </div>
              ) : (
                <>
                  <div className="probe-routine-editor-head">
                    <span className="probe-routine-badge" data-kind={provenanceKind ?? 'user'} data-testid="probe-routine-badge">
                      {provenanceKind ? PROVENANCE_LABEL[provenanceKind] : 'USER'}
                      {isNew ? ' (unsaved)' : dirty ? ' (edited, unsaved)' : ''}
                    </span>
                    {storedImported && (
                      <span className="probe-routine-badge" data-kind={storedImported.provenance.reviewedHash ? 'reviewed' : 'unreviewed'} data-testid="probe-routine-editor-reviewed">
                        {storedImported.provenance.reviewedHash ? 'reviewed once' : 'not yet reviewed - Check it before it can ever run'}
                      </span>
                    )}
                    {readOnly && (
                      <span className="control-offsets-meta" data-testid="probe-routine-readonly-note">
                        Factory routine - read-only. Duplicate to edit a copy.
                      </span>
                    )}
                    <span className="probe-routine-id" title="Routine id">{draft.id}</span>
                  </div>
                  <div className="probe-routine-toolbar" data-testid="probe-routine-actions">
                    {!setterDraft && <button className="modal-btn modal-btn-primary" data-testid="probe-routine-check" onClick={runCheck}>Check</button>}
                    {canEditThis && (
                      <>
                        <button className="modal-btn modal-btn-ghost" data-testid="probe-routine-save" disabled={!dirty || errors.length > 0} onClick={save}>Save</button>
                        <button className="modal-btn modal-btn-ghost" data-testid="probe-routine-revert" disabled={!dirty} onClick={revert}>Revert</button>
                      </>
                    )}
                    {!isNew && <button className="modal-btn modal-btn-ghost" data-testid="probe-routine-duplicate" onClick={duplicate}>Duplicate</button>}
                    {!isNew && <button className="modal-btn modal-btn-ghost" data-testid="probe-routine-export" onClick={exportSelected}>Export</button>}
                    {!isNew && readOnly && <button className="modal-btn modal-btn-ghost" data-testid="probe-routine-hide" onClick={hide}>Hide</button>}
                    {!isNew && !readOnly && <button className="modal-btn modal-btn-danger" data-testid="probe-routine-delete" onClick={remove}>Delete</button>}
                    <button className="modal-btn modal-btn-ghost" data-testid="probe-routine-source-toggle" aria-pressed={sourceOpen} onClick={() => setSourceOpen((v) => !v)}>
                      {sourceOpen ? 'Hide source' : 'Source'}
                    </button>
                  </div>
                  {status && (
                    <div className={`control-probe-status${status.kind === 'error' ? ' control-probe-status-error' : ''}`} data-testid="probe-routine-status">
                      {status.lines.join(' ')}
                    </div>
                  )}
                  {errors.length > 0 && (
                    <div className="probe-routine-error-list" data-testid="probe-routine-errors">
                      <strong className="control-probe-status-error">{errors.length} problem{errors.length === 1 ? '' : 's'} - each is also shown where it lives:</strong>
                      <ul>
                        {errors.map((e, i) => (
                          <li key={`${e.code}-${i}`} data-testid="probe-routine-error" data-code={e.code}>
                            {e.sentence}
                            <HelpLink topic="probe-routines" anchor={errorCodeAnchor(e.code)} title={`What ${e.code} means`} testId={`probe-routine-error-help-${i}`} />
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}

                  {sourceOpen ? (
                    <pre className="probe-routine-source" data-testid="probe-routine-source">{JSON.stringify(draft, null, 2)}</pre>
                  ) : (
                    <>
                      {/* identity */}
                      <div className="probe-routine-fields probe-routine-fields-identity">
                        {isNew && (
                          <label>
                            Id (letters, digits, dots, dashes; not starting with factory.)
                            <input className="mform-input mform-input-mono" data-testid="probe-routine-id-input" value={draft.id} onChange={(e) => setField(['id'], e.target.value)} />
                          </label>
                        )}
                        <label>
                          Name
                          <input className="mform-input" data-testid="probe-routine-name" value={draft.name ?? ''} readOnly={readOnly} onChange={(e) => setField(['name'], e.target.value)} />
                        </label>
                        <label>
                          Version
                          <input className="mform-input mform-input-mono" data-testid="probe-routine-version" value={draft.version ?? ''} readOnly={readOnly} onChange={(e) => setField(['version'], e.target.value)} />
                        </label>
                        <label>
                          Needs homing
                          <select className="mform-input" data-testid="probe-routine-requires-homed" value={draft.requires?.homed ? 'yes' : 'no'} disabled={readOnly} onChange={(e) => setField(['requires', 'homed'], e.target.value === 'yes')}>
                            <option value="yes">yes - full envelope known</option>
                            <option value="no">no</option>
                          </select>
                        </label>
                        <label>
                          Probe
                          <select className="mform-input" value={draft.requires?.probe ?? 'touch'} disabled={readOnly} onChange={(e) => setField(['requires', 'probe'], e.target.value)}>
                            <option value="touch">touch probe</option>
                            <option value="toolSetter">tool setter</option>
                          </select>
                        </label>
                        <label className="probe-routine-field-wide">
                          Description
                          <textarea className="mform-input" data-testid="probe-routine-description" rows={1} value={draft.description ?? ''} readOnly={readOnly} onChange={(e) => setField(['description'], e.target.value)} />
                        </label>
                      </div>
                      {routineErrors.length > 0 && (
                        <ul className="probe-routine-inline-errors" data-testid="probe-routine-routine-errors">
                          {routineErrors.map((e, i) => <li key={i}>{e.sentence}</li>)}
                        </ul>
                      )}

                      {/* inputs */}
                      <InputsSection
                        draft={draft}
                        readOnly={readOnly}
                        values={inputValues}
                        onValue={(name, text) => { setInputValues((prev) => ({ ...prev, [name]: text })); setPreviewStale(true) }}
                        setField={setField}
                        removeField={removeField}
                        touchDraft={touchDraft}
                        errorsFor={(i) => errorsFor('input', i)}
                      />

                      {/* steps */}
                      <div className="probe-routine-block" data-testid="probe-routine-steps">
                        <div className="probe-routine-block-head">
                          <strong>Steps</strong>
                          <span>{stepNumbers.size} step{stepNumbers.size === 1 ? '' : 's'}</span>
                        </div>
                        <StepList
                          steps={Array.isArray(draft.steps) ? draft.steps : []}
                          path={['steps']}
                          readOnly={readOnly}
                          numbers={stepNumbers}
                          errorsByStep={errorsByStep}
                          setField={setField}
                          removeField={removeField}
                          setOptionalExpr={setOptionalExpr}
                          touchDraft={touchDraft}
                          addKind={addStepKind}
                          onAddKind={setAddStepKind}
                        />
                      </div>

                      {/* outputs */}
                      <OutputsSection
                        draft={draft}
                        readOnly={readOnly}
                        setField={setField}
                        removeField={removeField}
                        setOptionalExpr={setOptionalExpr}
                        touchDraft={touchDraft}
                        errorsFor={(i) => errorsFor('output', i)}
                      />
                    </>
                  )}
                </>
              )}
            </div>

            {/* ---- column 2: the preview ---- */}
            <div className="probe-routine-preview-col" data-testid="probe-routine-preview-col">
              {setterDraft ? (
                <div className="control-probe-plan probe-routine-setter-preview" data-testid="probe-routine-setter-preview">
                  <div className="control-probe-plan-title">
                    <strong>What Measure tool does with this routine</strong>
                  </div>
                  {setterPlan === null ? (
                    <div data-testid="probe-routine-setter-preview-unavailable">
                      The preview needs the machine connection's live facts.
                    </div>
                  ) : setterPlan.ok ? (
                    <ol className="probe-routine-setter-moves" data-testid="probe-routine-setter-moves" style={{ paddingLeft: '1.8em', margin: '4px 0 8px' }}>
                      {describeToolSetterPlan(setterPlan.plan, displayUnits).map((line, i) => (
                        <li key={i}>{line.replace(/^\d+\. /, '')}</li>
                      ))}
                    </ol>
                  ) : (
                    <div className="control-probe-status-error" data-testid="probe-routine-setter-preview-error">{setterPlan.reason}</div>
                  )}
                  <div className="control-offsets-meta">
                    The Measure tool button on the Probing tab runs this routine - your own copy before the factory one.
                    Nothing on this tab moves the machine.
                  </div>
                </div>
              ) : (
                <ProbeRoutinePreview
                  state={preview}
                  stale={previewStale}
                  units={displayUnits}
                  routineName={draft?.name ?? selectedEntry?.routine.name ?? ''}
                  run={{ probe, envelope, activeWcs }}
                />
              )}
            </div>
          </div>
        </>
      )}
    </section>
  )
}

// --- inputs ---------------------------------------------------------------------------

interface InputsSectionProps {
  draft: ProbeRoutine
  readOnly: boolean
  values: Record<string, string>
  onValue: (name: string, text: string) => void
  setField: (path: Path, value: unknown) => void
  removeField: (path: Path) => void
  touchDraft: (updater: (prev: ProbeRoutine) => ProbeRoutine) => void
  errorsFor: (index: number) => RoutineError[]
}

function InputsSection({ draft, readOnly, values, onValue, setField, removeField, touchDraft, errorsFor }: InputsSectionProps) {
  const [addType, setAddType] = useState<ProbeRoutineInput['type']>('length')
  const inputs = Array.isArray(draft.inputs) ? draft.inputs : []
  return (
    <div className="probe-routine-block" data-testid="probe-routine-inputs">
      <div className="probe-routine-block-head">
        <strong>Inputs</strong>
        <span>{inputs.length === 0 ? 'none - this routine takes no inputs' : 'declared by the routine; the value column is what Check uses'}</span>
      </div>
      {inputs.map((input, i) => {
        const p: Path = ['inputs', i]
        const name = typeof input.name === 'string' ? input.name : `#${i + 1}`
        const inputErrors = errorsFor(i + 1)
        return (
          <div key={i} className="probe-routine-row" data-testid={`probe-routine-input-${name}`}>
            <div className="probe-routine-row-head">
              <strong>{input.label || name}</strong>
              <span className="probe-routine-kind">{input.type}{'unit' in input && input.unit ? ` (${input.unit})` : ''}</span>
              {!readOnly && <button className="probe-routine-mini" data-testid={`probe-routine-input-${name}-remove`} onClick={() => removeField(p)} aria-label={`Remove input ${name}`}>remove</button>}
            </div>
            <div className="probe-routine-fields probe-routine-fields-5">
              <label>
                name
                <input className="mform-input mform-input-mono" value={name} readOnly={readOnly} data-testid={`probe-routine-input-${name}-name`} onChange={(e) => setField([...p, 'name'], e.target.value)} />
              </label>
              <label>
                label
                <input className="mform-input" value={input.label ?? ''} readOnly={readOnly} onChange={(e) => setField([...p, 'label'], e.target.value)} />
              </label>
              {input.type === 'enum' ? (
                <>
                  <label>
                    options (comma separated)
                    <input className="mform-input" value={Array.isArray(input.options) ? input.options.join(', ') : ''} readOnly={readOnly} data-testid={`probe-routine-input-${name}-options`} onChange={(e) => setField([...p, 'options'], e.target.value.split(',').map((s) => s.trim()).filter((s) => s.length > 0))} />
                  </label>
                  <label>
                    default
                    <input className="mform-input" value={String(input.default ?? '')} readOnly={readOnly} data-testid={`probe-routine-input-${name}-default`} onChange={(e) => setField([...p, 'default'], e.target.value)} />
                  </label>
                </>
              ) : (
                <>
                  <label>
                    min
                    <input className="mform-input" inputMode="decimal" value={String(input.min ?? '')} readOnly={readOnly} data-testid={`probe-routine-input-${name}-min`} onChange={(e) => setField([...p, 'min'], numberOrText(e.target.value))} />
                  </label>
                  <label>
                    max
                    <input className="mform-input" inputMode="decimal" value={String(input.max ?? '')} readOnly={readOnly} data-testid={`probe-routine-input-${name}-max`} onChange={(e) => setField([...p, 'max'], numberOrText(e.target.value))} />
                  </label>
                  <label>
                    default
                    <input className="mform-input" inputMode="decimal" value={String(input.default ?? '')} readOnly={readOnly} data-testid={`probe-routine-input-${name}-default`} onChange={(e) => setField([...p, 'default'], numberOrText(e.target.value))} />
                  </label>
                </>
              )}
              <label className="probe-routine-value-field">
                value for Check
                {input.type === 'enum' ? (
                  <select className="mform-input" value={values[name] ?? ''} data-testid={`probe-routine-input-value-${name}`} onChange={(e) => onValue(name, e.target.value)}>
                    <option value="">default ({String(input.default)})</option>
                    {(Array.isArray(input.options) ? input.options : []).map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input className="mform-input" inputMode="decimal" placeholder={`default ${String(input.default)}`} value={values[name] ?? ''} data-testid={`probe-routine-input-value-${name}`} onChange={(e) => onValue(name, e.target.value)} />
                )}
              </label>
            </div>
            {typeof input.help === 'string' && input.help.length > 0 && <div className="control-offsets-meta">{input.help}</div>}
            {inputErrors.length > 0 && (
              <ul className="probe-routine-inline-errors" data-testid={`probe-routine-input-${name}-errors`}>
                {inputErrors.map((e, k) => <li key={k}>{e.sentence}</li>)}
              </ul>
            )}
          </div>
        )
      })}
      {!readOnly && (
        <div className="probe-routine-add-row">
          <select className="mform-input" value={addType} data-testid="probe-routine-add-input-kind" onChange={(e) => setAddType(e.target.value as ProbeRoutineInput['type'])}>
            <option value="length">length</option>
            <option value="angle">angle</option>
            <option value="count">count</option>
            <option value="enum">choice</option>
          </select>
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="probe-routine-add-input"
            onClick={() => touchDraft((prev) => {
              const names = new Set((Array.isArray(prev.inputs) ? prev.inputs : []).map((x) => x.name))
              return { ...prev, inputs: [...(Array.isArray(prev.inputs) ? prev.inputs : []), newInput(addType, names)] }
            })}
          >
            Add input
          </button>
        </div>
      )}
    </div>
  )
}

// --- steps ------------------------------------------------------------------------------

interface StepListProps {
  steps: ProbeRoutineStep[]
  path: Path
  readOnly: boolean
  numbers: Map<string, number>
  errorsByStep: Map<number, RoutineError[]>
  setField: (path: Path, value: unknown) => void
  removeField: (path: Path) => void
  setOptionalExpr: (path: Path, text: string) => void
  touchDraft: (updater: (prev: ProbeRoutine) => ProbeRoutine) => void
  addKind: ProbeRoutineStep['kind']
  onAddKind: (kind: ProbeRoutineStep['kind']) => void
}

function allStepNames(steps: unknown, out: Set<string>): Set<string> {
  if (!Array.isArray(steps)) return out
  for (const s of steps) {
    if (typeof s === 'object' && s !== null) {
      const name = (s as { name?: unknown }).name
      if (typeof name === 'string') out.add(name)
      if ((s as { kind?: unknown }).kind === 'branch') {
        allStepNames((s as { then?: unknown }).then, out)
        allStepNames((s as { else?: unknown }).else, out)
      }
    }
  }
  return out
}

function StepList(props: StepListProps) {
  const { steps, path, readOnly, numbers, errorsByStep, setField, removeField, setOptionalExpr, touchDraft, addKind, onAddKind } = props
  const move = (index: number, delta: number) => {
    touchDraft((prev) => {
      const list = getIn(prev, path)
      if (!Array.isArray(list)) return prev
      const next = [...list]
      const target = index + delta
      if (target < 0 || target >= next.length) return prev
      const [item] = next.splice(index, 1)
      next.splice(target, 0, item)
      return setIn(prev, path, next)
    })
  }
  const add = () => {
    touchDraft((prev) => {
      const list = getIn(prev, path)
      const current = Array.isArray(list) ? list : []
      const names = allStepNames(prev.steps, new Set<string>())
      return setIn(prev, path, [...current, newStep(addKind, names)])
    })
  }
  return (
    <div className="probe-routine-steps">
      {steps.length === 0 && <div className="control-offsets-meta">No steps{path.length > 1 ? ' in this arm' : ''}.</div>}
      {steps.map((step, i) => {
        const p: Path = [...path, i]
        const number = numbers.get(pathKey(p)) ?? 0
        const stepErrors = errorsByStep.get(number) ?? []
        return (
          <div
            key={`${number}-${i}`}
            className={stepErrors.length > 0 ? 'probe-routine-step probe-routine-step-error' : 'probe-routine-step'}
            data-testid={`probe-routine-step-${number}`}
            data-kind={step?.kind ?? 'unknown'}
          >
            <div className="probe-routine-row-head">
              <span className="probe-routine-step-number">{number}.</span>
              <span className="probe-routine-kind">{String(step?.kind)}</span>
              <strong className="probe-routine-step-sentence" data-testid={`probe-routine-step-${number}-sentence`}>
                {stepDisplayName(step)} {stepSentence(step)}
              </strong>
              {!readOnly && (
                <span className="probe-routine-step-tools">
                  <button className="probe-routine-mini" aria-label={`Move step ${number} up`} disabled={i === 0} onClick={() => move(i, -1)}>up</button>
                  <button className="probe-routine-mini" aria-label={`Move step ${number} down`} disabled={i === steps.length - 1} onClick={() => move(i, 1)}>down</button>
                  <button className="probe-routine-mini" aria-label={`Remove step ${number}`} data-testid={`probe-routine-step-${number}-remove`} onClick={() => removeField(p)}>remove</button>
                </span>
              )}
            </div>
            <StepForm
              step={step}
              path={p}
              number={number}
              readOnly={readOnly}
              setField={setField}
              setOptionalExpr={setOptionalExpr}
              touchDraft={touchDraft}
            />
            {step?.kind === 'branch' && (
              <div className="probe-routine-arms">
                <div className="probe-routine-arm">
                  <span className="probe-routine-arm-label">then</span>
                  <StepList {...props} steps={Array.isArray(step.then) ? step.then : []} path={[...p, 'then']} />
                </div>
                <div className="probe-routine-arm">
                  <span className="probe-routine-arm-label">else</span>
                  <StepList {...props} steps={Array.isArray(step.else) ? step.else : []} path={[...p, 'else']} />
                </div>
              </div>
            )}
            {stepErrors.length > 0 && (
              <ul className="probe-routine-inline-errors" data-testid={`probe-routine-step-${number}-errors`}>
                {stepErrors.map((e, k) => (
                  <li key={k} data-testid="probe-routine-step-error" data-code={e.code}>
                    {e.sentence}
                    <HelpLink topic="probe-routines" anchor={errorCodeAnchor(e.code)} title={`What ${e.code} means`} testId={`probe-routine-step-${number}-error-help-${k}`} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        )
      })}
      {!readOnly && (
        <div className="probe-routine-add-row">
          <select className="mform-input" value={addKind} data-testid={`probe-routine-add-step-kind${path.length > 1 ? `-${pathKey(path)}` : ''}`} onChange={(e) => onAddKind(e.target.value as ProbeRoutineStep['kind'])}>
            {PROBE_ROUTINE_STEP_KINDS.map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
          <button className="modal-btn modal-btn-ghost" data-testid={`probe-routine-add-step${path.length > 1 ? `-${pathKey(path)}` : ''}`} onClick={add}>
            Add step{path.length > 1 ? ' here' : ''}
          </button>
        </div>
      )}
    </div>
  )
}

interface StepFormProps {
  step: ProbeRoutineStep
  path: Path
  number: number
  readOnly: boolean
  setField: (path: Path, value: unknown) => void
  setOptionalExpr: (path: Path, text: string) => void
  touchDraft: (updater: (prev: ProbeRoutine) => ProbeRoutine) => void
}

function StepForm({ step, path, number, readOnly, setField, setOptionalExpr, touchDraft }: StepFormProps) {
  const tid = (field: string) => `probe-routine-step-${number}-${field}`
  const ro = readOnly
  const text = (label: string, field: Path, value: unknown, opts: { optional?: boolean; mono?: boolean; testId?: string } = {}) => (
    <label key={pathKey(field)}>
      <span className="probe-routine-field-label" title={label}>{label}</span>
      <input
        className={`mform-input${opts.mono === false ? '' : ' mform-input-mono'}`}
        value={exprText(value)}
        readOnly={ro}
        data-testid={opts.testId ?? tid(field.slice(path.length).map(String).join('-'))}
        onChange={(e) => (opts.optional ? setOptionalExpr(field, e.target.value) : setField(field, e.target.value))}
      />
    </label>
  )
  const numField = (label: string, field: Path, value: unknown, optional = true) => (
    <label key={pathKey(field)}>
      <span className="probe-routine-field-label" title={label}>{label}</span>
      <input
        className="mform-input"
        inputMode="decimal"
        value={exprText(value)}
        readOnly={ro}
        data-testid={tid(field.slice(path.length).map(String).join('-'))}
        onChange={(e) => {
          if (optional && e.target.value.trim() === '') setOptionalExpr(field, '')
          else setField(field, numberOrText(e.target.value))
        }}
      />
    </label>
  )
  const select = (label: string, field: Path, value: unknown, options: readonly string[]) => (
    <label key={pathKey(field)}>
      <span className="probe-routine-field-label" title={label}>{label}</span>
      <select className="mform-input" value={exprText(value)} disabled={ro} data-testid={tid(field.slice(path.length).map(String).join('-'))} onChange={(e) => setField(field, e.target.value)}>
        {options.map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    </label>
  )

  switch (step?.kind) {
    case 'move':
      return (
        <div className="probe-routine-fields probe-routine-fields-4">
          {text('name (optional)', [...path, 'name'], step.name, { optional: true })}
          {select('frame', [...path, 'frame'], step.frame ?? 'start', ['start', 'machine'])}
          {select('feed', [...path, 'feed'], step.feed ?? 'position', ['position', 'rapid'])}
          {text('safe Z (first move only)', [...path, 'safeZ'], step.safeZ, { optional: true })}
          {text('to X', [...path, 'to', 'x'], step.to?.x, { optional: true })}
          {text('to Y', [...path, 'to', 'y'], step.to?.y, { optional: true })}
          {text('to Z', [...path, 'to', 'z'], step.to?.z, { optional: true })}
        </div>
      )
    case 'touch':
      return (
        <div className="probe-routine-fields probe-routine-fields-4">
          {text('name', [...path, 'name'], step.name)}
          {text('axis (X, Y, Z or $input.<name>)', [...path, 'axis'], step.axis)}
          {text('direction (+, - or $input.<name>)', [...path, 'direction'], step.direction)}
          {text('search (mm)', [...path, 'searchMm'], step.searchMm)}
          {text('retract (mm, optional)', [...path, 'retractMm'], step.retractMm, { optional: true })}
          {text('back-off (mm, optional)', [...path, 'backoffMm'], step.backoffMm, { optional: true })}
          {numField('search feed factor (<= 1)', [...path, 'searchFeedFactor'], step.searchFeedFactor)}
          {numField('final feed factor (<= 1)', [...path, 'finalFeedFactor'], step.finalFeedFactor)}
        </div>
      )
    case 'calc':
      return (
        <div className="probe-routine-fields probe-routine-fields-4 probe-routine-fields-calc">
          {text('name', [...path, 'name'], step.name)}
          {select('unit', [...path, 'unit'], step.unit, ['mm', 'deg', 'count', 'ratio'])}
          <span className="probe-routine-field-wide probe-routine-field-expr">{text('expression', [...path, 'expr'], step.expr)}</span>
        </div>
      )
    case 'check':
    case 'branch':
      return (
        <div className="probe-routine-fields probe-routine-fields-1">
          {text('name (optional)', [...path, 'name'], step.name, { optional: true })}
          <ConditionForm
            condition={step.condition}
            path={[...path, 'condition']}
            number={number}
            readOnly={ro}
            setField={setField}
            touchDraft={touchDraft}
          />
          {step.kind === 'check' && text('message when it stops', [...path, 'message'], step.message, { mono: false })}
        </div>
      )
    default:
      return (
        <div className="control-probe-status-error" data-testid={tid('unknown')}>
          This step kind is not in the vocabulary; remove it or change the source.
        </div>
      )
  }
}

interface ConditionFormProps {
  condition: ProbeRoutineCondition
  path: Path
  number: number
  readOnly: boolean
  setField: (path: Path, value: unknown) => void
  touchDraft: (updater: (prev: ProbeRoutine) => ProbeRoutine) => void
}

function ConditionForm({ condition, path, number, readOnly, setField, touchDraft }: ConditionFormProps) {
  const { mode, items } = conditionList(condition)
  const itemPath = (i: number): Path => (mode === 'one' ? path : [...path, mode, i])
  const setMode = (next: 'one' | 'all' | 'any') => {
    touchDraft((prev) => {
      const list = items.length > 0 ? items : [newComparison()]
      if (next === 'one') return setIn(prev, path, list[0])
      return setIn(prev, path, { [next]: list })
    })
  }
  return (
    <div className="probe-routine-condition" data-testid={`probe-routine-step-${number}-condition`}>
      <label>
        condition
        <select className="mform-input" value={mode} disabled={readOnly} data-testid={`probe-routine-step-${number}-condition-mode`} onChange={(e) => setMode(e.target.value as 'one' | 'all' | 'any')}>
          <option value="one">one comparison</option>
          <option value="all">all of these</option>
          <option value="any">any of these</option>
        </select>
      </label>
      {items.map((c, i) => (
        <div key={i} className="probe-routine-comparison">
          <input className="mform-input mform-input-mono" value={exprText(c.left)} readOnly={readOnly} data-testid={`probe-routine-step-${number}-cmp-${i}-left`} onChange={(e) => setField([...itemPath(i), 'left'], e.target.value)} />
          <select className="mform-input" value={c.cmp ?? '>'} disabled={readOnly} data-testid={`probe-routine-step-${number}-cmp-${i}-op`} onChange={(e) => setField([...itemPath(i), 'cmp'], e.target.value)}>
            {['<', '<=', '>', '>=', '==', '!='].map((o) => <option key={o} value={o}>{o}</option>)}
          </select>
          <input className="mform-input mform-input-mono" value={exprText(c.right)} readOnly={readOnly} data-testid={`probe-routine-step-${number}-cmp-${i}-right`} onChange={(e) => setField([...itemPath(i), 'right'], e.target.value)} />
          {!readOnly && mode !== 'one' && (
            <button className="probe-routine-mini" aria-label="Remove comparison" onClick={() => touchDraft((prev) => setIn(prev, [...path, mode], items.filter((_, k) => k !== i)))}>remove</button>
          )}
        </div>
      ))}
      {!readOnly && mode !== 'one' && (
        <button className="modal-btn modal-btn-ghost" onClick={() => touchDraft((prev) => setIn(prev, [...path, mode], [...items, newComparison()]))}>Add comparison</button>
      )}
    </div>
  )
}

// --- outputs ----------------------------------------------------------------------------

interface OutputsSectionProps {
  draft: ProbeRoutine
  readOnly: boolean
  setField: (path: Path, value: unknown) => void
  removeField: (path: Path) => void
  setOptionalExpr: (path: Path, text: string) => void
  touchDraft: (updater: (prev: ProbeRoutine) => ProbeRoutine) => void
  errorsFor: (index: number) => RoutineError[]
}

function OutputsSection({ draft, readOnly, setField, removeField, setOptionalExpr, touchDraft, errorsFor }: OutputsSectionProps) {
  const [addKind, setAddKind] = useState<ProbeRoutineOutput['kind']>('workOffset')
  const outputs = Array.isArray(draft.outputs) ? draft.outputs : []
  return (
    <div className="probe-routine-block" data-testid="probe-routine-outputs">
      <div className="probe-routine-block-head">
        <strong>Outputs (proposals)</strong>
        <span>what the routine would propose when it finishes; nothing is ever written without your confirmation</span>
      </div>
      {outputs.map((output, i) => {
        const p: Path = ['outputs', i]
        const outErrors = errorsFor(i + 1)
        const tid = (f: string) => `probe-routine-output-${i + 1}-${f}`
        return (
          <div key={i} className="probe-routine-row" data-testid={`probe-routine-output-${i + 1}`}>
            <div className="probe-routine-row-head">
              <span className="probe-routine-kind">{String(output?.kind)}</span>
              {!readOnly && <button className="probe-routine-mini" aria-label={`Remove output ${i + 1}`} onClick={() => removeField(p)}>remove</button>}
            </div>
            {output?.kind === 'workOffset' && (
              <div className="probe-routine-fields probe-routine-fields-4">
                <label>
                  {"work offset (active, G54..G59 or $input.<name>)"}
                  <input className="mform-input mform-input-mono" value={exprText(output.wcs)} readOnly={readOnly} data-testid={tid('wcs')} onChange={(e) => setField([...p, 'wcs'], e.target.value)} />
                </label>
                {(['X', 'Y', 'Z'] as const).map((a) => (
                  <label key={a}>
                    {a} =
                    <input className="mform-input mform-input-mono" value={exprText(output.axes?.[a])} readOnly={readOnly} data-testid={tid(`axis-${a}`)} onChange={(e) => setOptionalExpr([...p, 'axes', a], e.target.value)} />
                  </label>
                ))}
                <label className="probe-routine-field-wide">
                  label
                  <input className="mform-input" value={output.label ?? ''} readOnly={readOnly} data-testid={tid('label')} onChange={(e) => setField([...p, 'label'], e.target.value)} />
                </label>
                <label className="probe-routine-field-wide">
                  compensation note (optional)
                  <input className="mform-input" value={output.compensationNote ?? ''} readOnly={readOnly} onChange={(e) => setOptionalExpr([...p, 'compensationNote'], e.target.value)} />
                </label>
              </div>
            )}
            {output?.kind === 'toolLength' && (
              <div className="probe-routine-fields probe-routine-fields-4">
                <label>
                  tool (active or a number)
                  <input className="mform-input mform-input-mono" value={exprText(output.tool)} readOnly={readOnly} data-testid={tid('tool')} onChange={(e) => setField([...p, 'tool'], e.target.value === 'active' ? 'active' : numberOrText(e.target.value))} />
                </label>
                <label>
                  machine Z =
                  <input className="mform-input mform-input-mono" value={exprText(output.machineZ)} readOnly={readOnly} data-testid={tid('machineZ')} onChange={(e) => setField([...p, 'machineZ'], e.target.value)} />
                </label>
                <label className="probe-routine-field-wide">
                  label
                  <input className="mform-input" value={output.label ?? ''} readOnly={readOnly} data-testid={tid('label')} onChange={(e) => setField([...p, 'label'], e.target.value)} />
                </label>
              </div>
            )}
            {output?.kind === 'report' && (
              <div className="probe-routine-report-items">
                {(Array.isArray(output.items) ? output.items : []).map((item, k) => (
                  <div key={k} className="probe-routine-fields probe-routine-fields-4">
                    <label>
                      label
                      <input className="mform-input" value={item.label ?? ''} readOnly={readOnly} onChange={(e) => setField([...p, 'items', k, 'label'], e.target.value)} />
                    </label>
                    <label>
                      expression
                      <input className="mform-input mform-input-mono" value={exprText(item.expr)} readOnly={readOnly} data-testid={tid(`item-${k + 1}-expr`)} onChange={(e) => setField([...p, 'items', k, 'expr'], e.target.value)} />
                    </label>
                    <label>
                      unit
                      <select className="mform-input" value={item.unit ?? 'mm'} disabled={readOnly} onChange={(e) => setField([...p, 'items', k, 'unit'], e.target.value)}>
                        {['mm', 'deg', 'count', 'ratio'].map((u) => <option key={u} value={u}>{u}</option>)}
                      </select>
                    </label>
                    {!readOnly && <button className="probe-routine-mini" aria-label={`Remove report item ${k + 1}`} onClick={() => removeField([...p, 'items', k])}>remove</button>}
                  </div>
                ))}
                {!readOnly && (
                  <button className="modal-btn modal-btn-ghost" onClick={() => touchDraft((prev) => setIn(prev, [...p, 'items'], [...(Array.isArray(output.items) ? output.items : []), { label: 'Value', expr: '0', unit: 'mm' }]))}>
                    Add report item
                  </button>
                )}
              </div>
            )}
            {outErrors.length > 0 && (
              <ul className="probe-routine-inline-errors" data-testid={`probe-routine-output-${i + 1}-errors`}>
                {outErrors.map((e, k) => <li key={k}>{e.sentence}</li>)}
              </ul>
            )}
          </div>
        )
      })}
      {!readOnly && (
        <div className="probe-routine-add-row">
          <select className="mform-input" value={addKind} data-testid="probe-routine-add-output-kind" onChange={(e) => setAddKind(e.target.value as ProbeRoutineOutput['kind'])}>
            <option value="workOffset">work offset</option>
            <option value="toolLength">tool length</option>
            <option value="report">report</option>
          </select>
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="probe-routine-add-output"
            onClick={() => touchDraft((prev) => ({ ...prev, outputs: [...(Array.isArray(prev.outputs) ? prev.outputs : []), newOutput(addKind)] }))}
          >
            Add output
          </button>
        </div>
      )}
    </div>
  )
}
