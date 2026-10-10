// ProbingPanel - workpiece probing (WO-297: split out of ToolsProbePanel per
// Operator's rejection of sharing the screen with the tool table -
// docs/ui-ux/probing-workspace-requirements.md). WO-385 expands the workspace
// to ten setup-integrated routines while preserving probe-tip compensation,
// the flip-aware second-side zero (WO-289), and confirmation before any work
// offset write.

import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { create } from 'zustand'
import { controlMachine, useCamStore } from '../../store'
import { useMachineControl } from '../../store/machineControlStore'
import { ProbeLamp, useProbeSignals } from './ProbeLamp'
import { parkCarrierMachine } from '../../store/machineActionsStore'
import { machineSafeZValue } from '../../lib/machine/machineActions'
import { saveMachineToolRecord, useMachineToolTable } from '../../store/machineToolTableStore'
import { findTool, machineProbeOverride, resolveProbeConfig } from '../../lib/machine/toolTable'
import {
  applySurfaceMesh,
  clearSurfaceMesh,
  describeWorkRotation,
  getMachineController,
  isProbeCycleActive,
  isProbeCyclePaused,
  subscribeProbeCycleActive,
  pauseProbing,
  resumeProbing,
  stopProbing,
  loadedProgramText,
  noHomeSwitchesRefusal,
  runFeatureProbeCycle,
  runSurfaceMeshProbeCycle,
  runZProbeCycle,
  planToolSetterForSession,
  setProbeSensing,
  setWorkOffsetValue,
  setWorkRotation,
  toolSetterRoutineToRun,
  workRotations,
  workZeroZSetRecord,
  useMachineProbeSensing,
  type ProbeSensingRoutine,
  type WcsId,
} from '../../lib/machine/machineSession'
import { useProbeRoutineStore } from '../../store/probeRoutineStore'
import { toolSetterRoutines } from '../../lib/machine/probeRoutineLibrary'
import { machineHasNoHomeSwitches, type Tool } from '../../types'
import {
  DEFAULT_MESH_FADE_MM,
  DEFAULT_MESH_MARGIN_MM,
  DEFAULT_MESH_POINTS,
  fingerprintProgram,
  planSurfaceMesh,
  type SurfaceMeshMap,
  type SurfaceMeshSample,
} from '../../lib/machine/zSurfaceMesh'
import {
  deriveEnvelopeStatus,
  safeMachinePosition,
  type EnvelopeStatus,
} from '../../lib/machine/machineEnvelope'
import { resolveMachineMotion } from '../../lib/machine/resolvedMachineMotion'
import {
  DEFAULT_MESH_HEIGHT_CHANGE_MM,
  DEFAULT_TOP_SEARCH_MM,
  DEFAULT_PROBE_SENSING,
  planFeatureProbeCycle,
  sensedPlateMm,
  sideCompensationRadiusMm,
  type ProbeSensing,
  type ProbeCycleStep,
  type ProbeCycleTouchKey,
} from '../../lib/machine/probeFeatureCycle'
import {
  calculateBoreCenter,
  calculateBossCenter,
  calculateCorner,
  calculateEdge,
  calculateYawAngle,
  faceRunOff,
  lineAngleInWorkDeg,
  planSecondSideProbeZero,
  secondSideStaleTouchRefusal,
  secondSideStatement,
  type SecondSideZeroPlan,
  type WorkProbeAxis,
  type WorkProbeDirection,
} from '../../lib/machine/probeRoutines'
import { planSecondSideSetup } from '../../lib/cam/flipSetup'
import { useDisplayUnits } from './useDisplayUnits'
import {
  fmtMachineLength,
  parseDimToMm,
  unitLabel,
} from '../../lib/ui/unitFormat'
import { formatPosition } from '../../lib/machine/positionFrames'
import { probeCalibratedRadius } from '../../lib/tool/probeTool'
import {
  calibrationDisagreementLine,
  calibrationFeatureKind,
  calibrationRadii,
  type CalibrationReference,
  type CalibrationReferenceKind,
} from '../../lib/machine/probeCalibration'
import {
  addCalibrationReference,
  editCalibrationReference,
  removeCalibrationReference,
  selectCalibrationReference,
  useCalibrationReferences,
} from './probing/calibrationReferences'
import { NumCell } from './NumCell'
import { resolveNumericDraft } from '../ui/NumericInput'
// WO-2205: the screen's one help link (opens the Help Center at a topic).
import { HelpLink } from '../ui/HelpLink'
import { EstopControl } from './ControlTransportBar'
import { JogPanel } from './JogPanel'
// WO-2062/WO-2063: Main's own Position (DRO) panel - the same component.
import { PositionPanel } from './ControlPage'
import { authorize } from '../../lib/machine/operatorAuthority'
import { buildProbeScene, withMeasuredAngle, withMeshHeights, type ProbeScene, type ProbingRoutine, type SceneSetup } from './probing/probeScene'
import { startTracker, stoppedAt, trackPosition, type TrackerState } from './probing/stepTracker'
import { KeyAndMore, StepCard, type LiveStepState } from './probing/ProbingScreen'

interface ProbeStatus {
  kind: 'ok' | 'error'
  text: string
}

// WO-1634: Operator probes with the cutter in the collet, not a dedicated
// stylus - "That's pretty typical for low-cost cncs that don't have a
// dedicated actual three-dimensional probe." The tip radius the touch
// routines compensate with should default to whatever tool is actually
// in the spindle, named the same way WO-1323 names a tool in G-code text:
// the library entry only when its T-number is unambiguous, never a guess
// among duplicates. WO-2105: duplicates are settled by the machine's own tool
// table - the entry whose diameter is the one the table holds for that T.
export function activeToolFromLibrary(
  activeTool: number | null,
  toolLibrary: readonly Tool[],
  tableDiaMm: number | null = null,
): Tool | null {
  if (activeTool === null) return null
  const matches = toolLibrary.filter((tool) => tool.toolNumber === activeTool)
  if (matches.length === 1) return matches[0]
  if (tableDiaMm === null || !(tableDiaMm > 0)) return null
  return matches.find((tool) => Math.abs(tool.diameter - tableDiaMm) < 0.001) ?? null
}

/** The tip radius used, and said to be the default, when the probe tool has
 *  no diameter anywhere yet. */
const DEFAULT_TIP_RADIUS_MM = 1.5


/** WO-2061: which work Z0 a routine uses and when it was set. Read at render;
 *  every confirmed Z0 write (either screen, the DRO, the pendant, the mesh)
 *  records its time in the session. */
function WorkZeroInUse({ machineId, wcs }: { machineId: string; wcs: WcsId | null }) {
  const record = workZeroZSetRecord(machineId, wcs)
  const text = wcs === null
    ? 'No work offset is active yet - Z0 is written to the active one.'
    : record === null
      ? `${wcs} Z0: not set from LienCAM since it opened - the controller's stored ${wcs} Z is in use.`
      : `${wcs} Z0 in use: set at ${new Date(record.at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
        + `${record.thisConnection ? '' : ' (an earlier connection)'}.`
  return (
    <div className="control-probe-field-note" data-testid="control-work-probe-z0-in-use">
      {text}
    </div>
  )
}

/** What a second side has for first-side references when none of the ones held
 *  were typed for the setup that is active now. Module-level so the scoped read
 *  is one stable object rather than a fresh {} every render. */
const NO_FEATURE_REFERENCE: Partial<Record<WorkProbeAxis, number>> = {}

type WorkProbeKind =
  | 'workZero'
  | 'edge'
  | 'zSurface'
  | 'insideCorner'
  | 'outsideCorner'
  | 'bore'
  | 'boss'
  | 'rectPocket'
  | 'rectBoss'
  | 'angle'
  | 'toolZ'
  | 'calibrate'
type WorkTouchKey = ProbeCycleTouchKey
/** Where along the face (the nominal axis) the Angle plan starts its two touches. */
function angleAlongOf(steps: readonly ProbeCycleStep[], nominalAxis: WorkProbeAxis): { first: number; second: number } | null {
  const at = (key: WorkTouchKey) => {
    const step = steps.find((s) => s.kind === 'touch' && s.key === key)
    return step?.kind === 'touch' ? (nominalAxis === 'X' ? step.expectedStart.x : step.expectedStart.y) : null
  }
  const first = at('angleFirst')
  const second = at('angleSecond')
  return first === null || second === null ? null : { first, second }
}
// The Angle routine's Face choices, by nominal axis and probe direction: the
// setup's own words, and the words its result names the face by (WO-2112).
const ANGLE_FACES: ReadonlyArray<{ value: string; face: string; probe: string }> = [
  { value: 'X+', face: 'front', probe: 'Y+' },
  { value: 'X-', face: 'back', probe: 'Y-' },
  { value: 'Y+', face: 'left', probe: 'X+' },
  { value: 'Y-', face: 'right', probe: 'X-' },
]

const ROUTINE_OPTIONS: ReadonlyArray<{ kind: WorkProbeKind; label: string; short: string }> = [
  // WO-2061: the Tools screen's Probe work Z0, first - the same routine.
  // WO-2063: the brief's order, three across.
  { kind: 'workZero', label: 'Z0', short: 'Top of stock' },
  { kind: 'edge', label: 'Edge', short: 'Single X/Y face' },
  { kind: 'outsideCorner', label: 'Outside corner', short: 'Two outside faces' },
  { kind: 'insideCorner', label: 'Inside corner', short: 'Two inside faces' },
  { kind: 'angle', label: 'Angle', short: 'Two-point alignment' },
  { kind: 'bore', label: 'Bore', short: 'Round inside center' },
  { kind: 'boss', label: 'Boss', short: 'Round outside center' },
  { kind: 'rectPocket', label: 'Rect pocket', short: 'Four inside faces' },
  { kind: 'rectBoss', label: 'Rect boss', short: 'Four outside faces' },
  { kind: 'zSurface', label: 'Z surface', short: 'Map cutting surface' },
  { kind: 'toolZ', label: 'Tool Z', short: 'Measure active tool' },
  // WO-2166: the loaded Probe tool's X / Y radius on a known reference.
  { kind: 'calibrate', label: 'Calibrate', short: 'Probe X / Y radius' },
]

interface WorkProbePreview {
  title: string
  resultText: string
  compensation: string
  values: Partial<Record<WorkProbeAxis, number>>
  angleDeg?: number
  /** WO-2188: what the Angle routine's Confirm sets - the work offset the
   *  run measured against, its rotation then (`fromDeg`) and the rotation that
   *  puts its work axis along the face (`toDeg` = from + the angle shown), plus
   *  the tap-it-square sentence for the same angle. Angle only. */
  angleRotation?: { wcs: string; fromDeg: number; toDeg: number; tapText: string }
  /** WO-289: on a second-side setup, how each probed number became this
   *  side's zero, one line per axis (WO-2122: shown on the Confirm step).
   *  Absent on every other setup, where the panel behaves exactly as WO-261
   *  shipped it. */
  secondSide?: string[]
}

/**
 * WO-289: the second-side arithmetic in words, in the machinist's display
 * units. Exported so the evidence fixture shows the SAME lines the panel does
 * rather than a hand-written mock-up of them.
 */
export function secondSideProbeLines(
  plan: SecondSideZeroPlan,
  units: ReturnType<typeof useDisplayUnits>,
): string[] {
  return [plan.statement, ...secondSideAxisLines(plan, units)]
}

/** WO-2122: the per-axis working alone - what the Confirm step shows under the
 *  result (the setup card already says which side this is). */
function secondSideAxisLines(
  plan: SecondSideZeroPlan,
  units: ReturnType<typeof useDisplayUnits>,
): string[] {
  const unit = unitLabel(units)
  return plan.axes.map(
    (axis) =>
      `${axis.axis}: the feature sits at ${fmtMachineLength(axis.featureFirstSideMm, units)} on ` +
      `"${plan.firstSideName}", so after the turn it must read ` +
      `${fmtMachineLength(axis.featureSecondSideMm, units)} here. The probe found it at ` +
      `${fmtMachineLength(axis.probedMachineMm, units)}, so this side's ${axis.axis} zero is ` +
      `${fmtMachineLength(axis.workZeroMachineMm, units)} ${unit}.`,
  )
}

/** What a confirmation writes, in the machinist's units: "X=12.000 mm, Y=-3.000 mm". */
function offsetWritesText(
  values: Partial<Record<WorkProbeAxis, number>>,
  units: ReturnType<typeof useDisplayUnits>,
): string {
  return (['X', 'Y'] as const)
    .filter((axis) => values[axis] !== undefined)
    .map((axis) => `${axis}=${fmtMachineLength(values[axis]!, units)} ${unitLabel(units)}`)
    .join(', ')
}

/** WO-2122: the Confirm step's second-side working - the result, one line per
 *  axis, and exactly what Confirm writes (all from the preview Confirm applies).
 *  Its own component so the React Compiler keeps optimising ProbingPanel. */
function SecondSideWorking({
  preview,
  wcs,
  units,
}: {
  preview: WorkProbePreview
  wcs: WcsId
  units: ReturnType<typeof useDisplayUnits>
}) {
  return (
    <div className="pbn-confirm-working" data-testid="control-second-side-working">
      <span>{preview.resultText}</span>
      {(preview.secondSide ?? []).map((line) => (
        <span key={line} data-testid="control-second-side-line">{line}</span>
      ))}
      <span data-testid="control-second-side-writes">
        Writes {wcs} {offsetWritesText(preview.values, units)}
      </span>
    </div>
  )
}

/** WO-2063: the Probing screen's Stop (docs/design/PROBING-SCREEN-V2.md). */
export const PROBE_STOP_TOOLTIP = 'Stop - cancels the running probe routine. Not an E-STOP: nothing latches.'

const WCS_LIST: WcsId[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']

type ProbePlanRefusalContext = 'automatic probe cycle' | 'mesh travel'

/** WO-1045: safeMpos can be absent for four different reasons. Only one of
 *  them is fixed by homing, so the plan refusal must branch on the status that
 *  actually closed the gate instead of treating every null position alike. */
function probePlanEnvelopeRefusal(
  status: EnvelopeStatus,
  context: ProbePlanRefusalContext,
): string {
  if (status === 'unknown') {
    return "The machine's travel limits are not known yet - the controller settings have not been read."
  }
  if (status === 'no-datum') {
    return noHomeSwitchesRefusal(
      context === 'automatic probe cycle'
        ? 'set the machine position before planning an automatic probe cycle.'
        : 'set the machine position before planning mesh travel.',
    )
  }
  if (status === 'not-homed') {
    return context === 'automatic probe cycle'
      ? 'Home the machine before planning an automatic probe cycle.'
      : 'Home the machine before planning mesh travel.'
  }
  return context === 'automatic probe cycle'
    ? 'The homed machine position has not been reported yet - wait for a position update before planning an automatic probe cycle.'
    : 'The homed machine position has not been reported yet - wait for a position update before planning mesh travel.'
}

/** A Face choice ("X+", "Y-"), or null for anything else. A tampered option
 *  could otherwise hand the planner a Z axis, which it would probe downward
 *  (WO-261's guard, kept when the axis and direction selects became one). */
function asWorkProbeFace(value: string): [WorkProbeAxis, WorkProbeDirection] | null {
  const axis = value[0]
  const direction = value[1]
  if (value.length !== 2 || (axis !== 'X' && axis !== 'Y') || (direction !== '+' && direction !== '-')) return null
  return [axis, direction]
}

/** WO-2267 (architect picture check 10-01): once a run has measured a mesh,
 *  the Z surface's result step says what it is - measured and waiting for
 *  Confirm, or applied - instead of the plan's "The mesh is armed." It is the
 *  result alone, like the other routines' "Press Confirm to set ...", so it
 *  stays on two lines beside the height legend at 1440 x 900. With no mesh
 *  the plan's own sentence stands (pinned by WO-2180). */
function withMeshResultSentence(scene: ProbeScene, mesh: { active: boolean; workOffset: string } | null): ProbeScene {
  const last = scene.steps.length - 1
  if (!mesh || last < 0) return scene
  const sentence = mesh.active
    ? `The mesh is applied to ${mesh.workOffset}.`
    : `The mesh is measured. Confirm applies it to ${mesh.workOffset}.`
  return { ...scene, steps: scene.steps.map((step, i) => (i === last ? { ...step, sentence } : step)) }
}

/** WO-2063: a picture's number, short enough to read from a distance: mm to
 *  one decimal (trailing .0 dropped - "10 mm", "16.6 mm"), inches to three.
 *  WO-2474: the probing pictures and their guidance words keep this format;
 *  the 2 mm / 3 inch rule is for the screen's number fields and readouts. */
function pictureValue(valueMm: number, units: ReturnType<typeof useDisplayUnits>): string {
  if (units === 'inch') return `${(valueMm / 25.4).toFixed(3)} in`
  return `${Number(valueMm.toFixed(1))} mm`
}

function motionValue(valueMm: number, units: ReturnType<typeof useDisplayUnits>): string {
  return `${fmtMachineLength(valueMm, units)} ${unitLabel(units)}`
}

export function WorkProbeResultPanel({
  preview,
  wcs,
  units,
  disabled,
  onApply,
}: {
  preview: WorkProbePreview
  wcs: WcsId
  units: ReturnType<typeof useDisplayUnits>
  disabled: boolean
  onApply: () => void
}) {
  const offsetText = offsetWritesText(preview.values, units)

  return (
    <div className="control-probe-status" data-testid="control-work-probe-result">
      <div style={{ display: 'flex', flex: '1 1 320px', flexDirection: 'column', gap: 2 }}>
        <strong>{preview.title}</strong>
        <span>{preview.resultText}</span>
        {preview.secondSide?.map((line) => (
          <span key={line} data-testid="control-second-side-line">{line}</span>
        ))}
        {offsetText && <span>Would write {wcs} {offsetText} after confirmation.</span>}
        <span>{preview.compensation}</span>
      </div>
      {offsetText && (
        <button
          className="modal-btn modal-btn-ghost"
          data-testid="control-work-probe-apply"
          disabled={disabled}
          onClick={onApply}
        >
          Confirm {wcs} offset
        </button>
      )}
    </div>
  )
}

// WO-1998: ControlPage mounts this panel only while the Probing sub-tab is
// open, and the Probing tab has no jog - so the operator MUST leave it between
// the touches of a corner. The chosen routine, its settings and the touches
// already taken live here, outside the component, until the routine is
// restarted or changed; they belong to one machine and are dropped when the
// Control tab is driving another. The path-clear confirmation is deliberately
// NOT kept: leaving the tab to move the machine is what it has to be re-given for.
interface ProbingSessionState {
  machineId: string | null
  values: Readonly<Record<string, unknown>>
}

const useProbingSession = create<ProbingSessionState>(() => ({ machineId: null, values: {} }))
const PROBING_SESSION_UNSET = Symbol('probing-session-unset')

// A disconnect ends the probing session: the touches are machine positions,
// and nothing vouches for them across a new connection.
useMachineControl.subscribe((state, previous) => {
  if (previous.connectionPhase === 'connected' && state.connectionPhase === 'disconnected') {
    useProbingSession.setState({ machineId: null, values: {} })
    probingSessionRefs = { machineId: null, refs: new Map() }
  }
})

export function __resetProbingSessionForTest(): void {
  useProbingSession.setState({ machineId: null, values: {} })
  probingSessionRefs = { machineId: null, refs: new Map() }
}

// WO-2139: the followed run's step tracker is written as the frame renders
// (never state per position report), so it lives beside the session, not in it.
let probingSessionRefs: { machineId: string | null; refs: Map<string, { current: unknown }> } = { machineId: null, refs: new Map() }

/** useRef, kept for the machine's probing session across unmounts. */
function useProbingSessionRef<T>(machineId: string, key: string, initial: T): { current: T } {
  if (probingSessionRefs.machineId !== machineId) probingSessionRefs = { machineId, refs: new Map() }
  let holder = probingSessionRefs.refs.get(key)
  if (!holder) {
    holder = { current: initial }
    probingSessionRefs.refs.set(key, holder)
  }
  return holder as { current: T }
}

type SessionSetter<T> = (next: T | ((current: T) => T)) => void

/** useState, kept for the machine's probing session across unmounts. A
 *  functional update reads the stored value at the moment it runs, so a touch
 *  that lands while the panel is unmounted is still recorded. */
function useProbingSessionState<T>(machineId: string, key: string, initial: T): [T, SessionSetter<T>] {
  const stored = useProbingSession((s) => (
    s.machineId === machineId && key in s.values ? s.values[key] : PROBING_SESSION_UNSET
  ))
  const value = stored === PROBING_SESSION_UNSET ? initial : stored as T
  const set: SessionSetter<T> = (next) => useProbingSession.setState((s) => {
    const values = s.machineId === machineId ? s.values : {}
    const current = key in values ? values[key] as T : initial
    const resolved = typeof next === 'function' ? (next as (current: T) => T)(current) : next
    if (s.machineId === machineId && key in values && Object.is(resolved, current)) return s
    return { machineId, values: { ...values, [key]: resolved } }
  })
  return [value, set]
}

export function ProbingPanel() {
  const probeActive = useSyncExternalStore(subscribeProbeCycleActive, isProbeCycleActive, () => false)
  const probePaused = useSyncExternalStore(subscribeProbeCycleActive, isProbeCyclePaused, () => false)
  const probeSignals = useProbeSignals()
  const machine = useCamStore(controlMachine)
  const machineId = machine?.id ?? 'default'
  // WO-2035: a boss cross-over with the top unknown runs at this Safe Z.
  const declaredSafeZ = useCamStore((s) => machineSafeZValue(parkCarrierMachine(s)))
  // WO-289: the setup being worked, only so the panel can tell whether it is
  // the second side of another. Read, never written.
  const setups = useCamStore((s) => s.project.setups)
  const stocks = useCamStore((s) => s.project.stocks)
  const activeSetupId = useCamStore((s) => s.project.activeSetupId)
  const toolLibrary = useCamStore((s) => s.toolLibrary)
  const probeOverride = useMachineToolTable((s) => s.byMachine[machineId]?.probe)
  const probeCfg = useMemo(
    () => resolveProbeConfig(machine?.probing, probeOverride),
    [machine?.probing, probeOverride],
  )
  // WO-2061: Z0 here runs the Tools screen's routine on the Tools screen's
  // settings - the definition's probe override with its active pad
  // (machineProbeOverride), one stored field seen through two screens.
  const workZeroCfg = useMemo(
    () => resolveProbeConfig(machine?.probing, machineProbeOverride(machine)),
    [machine],
  )
  const probePads = machine?.probePads ?? []
  const activeProbePadId = machine?.activeProbePadId ?? ''
  const probeStore = useMachineToolTable
  // WO-1676 fix round: the store's mutators stay pure cache writes (see
  // machineToolTableStore.ts); this panel is a real-edit caller, so it pushes
  // the cache onto the record right after every mutator call, same as
  // ToolsProbePanel's `save`.
  const saveToolRecord = () => {
    if (machine) saveMachineToolRecord(machine)
  }

  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const connectionKind = useMachineControl((s) => s.connectionKind)
  // WO-1546/WO-1613: on the bridge the tool measure is the tool setter
  // ROUTINE - the operator's pick, else their own copy, else the factory one
  // filled from the definition. Its plan is what the Measure button runs.
  const storedProbeRoutines = useProbeRoutineStore((s) => s.routines)
  const setterChoices = useMemo(
    () => toolSetterRoutines({ routines: storedProbeRoutines, quarantined: {}, hidden: [] }),
    [storedProbeRoutines],
  )
  const [setterRoutineId, setSetterRoutineId] = useProbingSessionState<string | null>(machineId, 'setterRoutineId', null)
  const chosenSetterRoutine = setterChoices.find((r) => r.id === setterRoutineId) ?? setterChoices[0]
  const setterRoutine = connectionKind === 'bridge' ? toolSetterRoutineToRun(machine, probeCfg, chosenSetterRoutine) : null
  // Re-plan when the active tool's recorded length changes.
  useMachineToolTable((s) => s.byMachine[machineId]?.table)
  const machineState = useMachineControl((s) => s.machineState)
  const jobPhase = useMachineControl((s) => s.job.phase)
  const activeTool = useMachineControl((s) => s.activeTool)
  const activeWcs = useMachineControl((s) => s.activeWcs)
  const programText = useMachineControl((s) => s.programText)
  const programName = useMachineControl((s) => s.job.name)
  // WO-2104: the loaded program's G-code whichever door took it - the UCCNC
  // bridge stages files with no store text. A load publishes a new listing.
  const stagedListing = useMachineControl((s) => s.stagedProgram)
  const meshProgramText = useMemo(
    () => loadedProgramText(),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the inputs loadedProgramText reads
    [programText, programName, stagedListing],
  )
  const activeSurfaceMesh = useMachineControl((s) => s.surfaceMesh)
  // WO-304: the four machine facts an operator standing at THIS tab needs
  // without leaving it - see the envelopeStatus/safeMpos derivation below.
  const mpos = useMachineControl((s) => s.mpos)
  const wpos = useMachineControl((s) => s.wpos)
  const homed = useMachineControl((s) => s.homed)
  const settings = useMachineControl((s) => s.settings)
  const units = useDisplayUnits()

  const [busy, setBusy] = useProbingSessionState(machineId, 'busy', false)
  // While a routine runs, the setter plan stays what it was at Start: planning
  // it resolves the whole machine definition (~20 ms on Operator's record), and
  // doing that on every position report held the running Probing screen to 8
  // redraws a second (WO-2063, profiled on the native kit 09-27).
  const setterPlanAtStart = useMemo(
    () => (busy && setterRoutine ? planToolSetterForSession(setterRoutine, probeCfg) : null),
    // Planned once, when the run starts; the routine and config are those of that render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [busy],
  )
  const setterPlan = busy ? setterPlanAtStart : setterRoutine ? planToolSetterForSession(setterRoutine, probeCfg) : null
  const toolSetter = setterPlan?.ok ? setterPlan.plan.setter : null
  const [workKind, setWorkKind] = useProbingSessionState<WorkProbeKind>(machineId, 'workKind', 'edge')
  const [workWcs, setWorkWcs] = useProbingSessionState<WcsId>(machineId, 'workWcs', activeWcs ?? 'G54')
  // WO-1634: the tip radius defaults to whatever tool the operator has
  // actually chucked up, because that IS the probe on machines like Operator's.
  // A typed value ratchets the field into "operator owns this now" for the
  // rest of the session - the active tool may keep changing after that
  // without ever overwriting a number the operator typed on purpose. No
  // active (or unambiguous) tool just leaves the field where it was; this
  // panel never refuses or nags about a probe it does not have.
  const [tipRadiusMm, setTipRadiusMm] = useProbingSessionState(machineId, 'tipRadiusMm', DEFAULT_TIP_RADIUS_MM)
  const [tipRadiusSource, setTipRadiusSource] = useProbingSessionState<string | null>(machineId, 'tipRadiusSource', null)
  const [tipRadiusTyped, setTipRadiusTyped] = useProbingSessionState(machineId, 'tipRadiusTyped', false)
  // WO-2060: the library's diameter first, then the diameter the machine's
  // own tool table holds for that T. With neither, the panel asks once (below)
  // and writes the answer to the tool table - never a silent 1.5 mm.
  const tableDiaMm = useMachineToolTable(
    (s) => (activeTool === null ? null : s.byMachine[machineId]?.table.tools.find((t) => t.tool === activeTool)?.dia ?? null),
  )
  const activeToolEntry = useMemo(
    () => activeToolFromLibrary(activeTool, toolLibrary, tableDiaMm),
    [activeTool, toolLibrary, tableDiaMm],
  )
  const libraryEntriesForActive = activeTool === null ? 0 : toolLibrary.filter((t) => t.toolNumber === activeTool).length
  const libraryDiaMm = activeToolEntry && activeToolEntry.diameter > 0 ? activeToolEntry.diameter : null
  const activeDiaMm = libraryDiaMm ?? (tableDiaMm !== null && tableDiaMm > 0 ? tableDiaMm : null)
  // WO-2105: where the radius came from, said on the Tip radius row.
  const activeDiaLabel = libraryDiaMm !== null && activeToolEntry
    ? libraryEntriesForActive > 1
      ? `T${activeTool} ${activeToolEntry.name} - the one of ${libraryEntriesForActive} tool library T${activeTool} entries `
        + `matching the machine tool table, diameter ${motionValue(libraryDiaMm, units)}`
      : `T${activeTool} ${activeToolEntry.name} - tool library, diameter ${motionValue(libraryDiaMm, units)}`
    : `T${activeTool} - machine tool table, diameter ${activeDiaMm === null ? 'not set' : motionValue(activeDiaMm, units)}`
  const askToolDiameter = activeTool !== null && activeDiaMm === null && !tipRadiusTyped
  useEffect(() => {
    if (tipRadiusTyped) return
    if (activeDiaMm === null) {
      // Audit: a tool with no diameter never inherits the previous tool's
      // radius; the default is used and SAID to be the default, beside the
      // question - never silent, never a refusal (WO-1634's rule).
      if (activeTool === null) return
      setTipRadiusMm(DEFAULT_TIP_RADIUS_MM)
      setTipRadiusSource(`the default - T${activeTool} has no diameter yet`)
      return
    }
    setTipRadiusMm(activeDiaMm / 2)
    setTipRadiusSource(activeDiaLabel)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the session setters are re-created each render
  }, [activeTool, activeDiaMm, activeDiaLabel, tipRadiusTyped])
  // WO-2156: a Probe-type tool in the spindle compensates X touches by its
  // calibrated X radius and Y touches by its calibrated Y radius; an axis left
  // blank keeps the radius above (the ball, diameter / 2). A typed radius
  // still overrides both; any other tool uses one radius on both axes.
  // WO-2166: Calibrate measures those two radii, so it moves on the ball -
  // and its Confirm, writing them, leaves the run it just showed as it was.
  const useCalibrated = !tipRadiusTyped && workKind !== 'calibrate'
  const calibratedXmm = useCalibrated && activeToolEntry ? probeCalibratedRadius(activeToolEntry, 'x') : null
  const calibratedYmm = useCalibrated && activeToolEntry ? probeCalibratedRadius(activeToolEntry, 'y') : null
  const tipRadiusXmm = calibratedXmm ?? tipRadiusMm
  const tipRadiusYmm = calibratedYmm ?? tipRadiusMm
  // The stand-offs the routine moves by take one radius; the larger keeps
  // every planned clearance at least what it asks for.
  const tipMotionMm = Math.max(tipRadiusXmm, tipRadiusYmm)
  const calibratedSource = activeToolEntry && (calibratedXmm !== null || calibratedYmm !== null)
    ? `T${activeTool} ${activeToolEntry.name} - `
      + `${calibratedXmm !== null ? 'calibrated X' : 'X ball'} ${fmtMachineLength(tipRadiusXmm, units)}, `
      + `${calibratedYmm !== null ? 'calibrated Y' : 'Y ball'} ${fmtMachineLength(tipRadiusYmm, units)} ${unitLabel(units)}`
    : null
  // WO-2059: how the face is sensed, one choice per routine, remembered per
  // machine. A plate adds its thickness (the tool table's pad, the same field
  // Z0 uses) to the tip radius on every side touch; the touches themselves
  // stay raw contacts, so changing the choice re-reads them.
  const sensingByRoutine = useMachineProbeSensing(machineId)
  const sensingRoutine: ProbeSensingRoutine | null = workKind === 'toolZ' || workKind === 'calibrate' ? null : workKind
  const sensing: ProbeSensing = (sensingRoutine && sensingByRoutine?.[sensingRoutine]) || DEFAULT_PROBE_SENSING
  const workZeroSensing: ProbeSensing = sensingByRoutine?.workZero ?? DEFAULT_PROBE_SENSING
  // WO-2061: the plate Z0 subtracts - the pad when 'plate' is chosen, none
  // when the probe touches the part - the same value the run uses.
  const workZeroPlateMm = sensedPlateMm(workZeroSensing, workZeroCfg)
  const plateMm = sensedPlateMm(sensing, probeCfg)
  const senseRadiusMm = sideCompensationRadiusMm(tipMotionMm, sensing, probeCfg)
  const senseRadiusXmm = sideCompensationRadiusMm(tipRadiusXmm, sensing, probeCfg)
  const senseRadiusYmm = sideCompensationRadiusMm(tipRadiusYmm, sensing, probeCfg)
  const perAxisRadius = senseRadiusXmm !== senseRadiusYmm
  const senseRadiusOn = (axis: WorkProbeAxis) => (axis === 'X' ? senseRadiusXmm : senseRadiusYmm)
  const withPlate = (text: string) => plateMm <= 0
    ? text
    : perAxisRadius
      ? `${text} Sensed through the plate: tip radius ${motionValue(tipRadiusXmm, units)} on X + plate ${motionValue(plateMm, units)} = ${motionValue(senseRadiusXmm, units)}; `
        + `${motionValue(tipRadiusYmm, units)} on Y + plate = ${motionValue(senseRadiusYmm, units)}.`
      : `${text} Sensed through the plate: tip radius ${motionValue(tipRadiusXmm, units)} + plate ${motionValue(plateMm, units)} = ${motionValue(senseRadiusXmm, units)}.`
  const [edgeAxis, setEdgeAxis] = useProbingSessionState<WorkProbeAxis>(machineId, 'edgeAxis', 'X')
  // WO-2060: X0 is normally the left face, Y0 the front, so the probe
  // defaults to moving X+ / Y+ (front-left corner, front-face angle).
  const [edgeDirection, setEdgeDirection] = useProbingSessionState<WorkProbeDirection>(machineId, 'edgeDirection', '+')
  const [outsideCornerX, setOutsideCornerX] = useProbingSessionState<WorkProbeDirection>(machineId, 'cornerXDirection', '+')
  const [outsideCornerY, setOutsideCornerY] = useProbingSessionState<WorkProbeDirection>(machineId, 'cornerYDirection', '+')
  // Audit: the front-left corner of a POCKET is touched moving X- / Y-, so an
  // inside corner keeps its own directions (default front-left, - / -).
  const [insideCornerX, setInsideCornerX] = useProbingSessionState<WorkProbeDirection>(machineId, 'insideCornerXDirection', '-')
  const [insideCornerY, setInsideCornerY] = useProbingSessionState<WorkProbeDirection>(machineId, 'insideCornerYDirection', '-')
  const insideCornerKind = workKind === 'insideCorner'
  const cornerXDirection = insideCornerKind ? insideCornerX : outsideCornerX
  const cornerYDirection = insideCornerKind ? insideCornerY : outsideCornerY
  const setCornerXDirection = insideCornerKind ? setInsideCornerX : setOutsideCornerX
  const setCornerYDirection = insideCornerKind ? setInsideCornerY : setOutsideCornerY
  const [angleNominalAxis, setAngleNominalAxis] = useProbingSessionState<WorkProbeAxis>(machineId, 'angleNominalAxis', 'X')
  const [angleProbeDirection, setAngleProbeDirection] = useProbingSessionState<WorkProbeDirection>(machineId, 'angleProbeDirection', '+')
  const [angleAlongDirection, setAngleAlongDirection] = useProbingSessionState<WorkProbeDirection>(machineId, 'angleAlongDirection', '+')
  const [angleSpacingMm, setAngleSpacingMm] = useProbingSessionState(machineId, 'angleSpacingMm', 25)
  // WO-2063: the setup's "Start within" and "Probing depth" (the planner's
  // defaults, 10 and 5, now the operator's fields - design 4.4).
  const [startDistanceMm, setStartDistanceMm] = useProbingSessionState(machineId, 'startDistanceMm', 10)
  const [depthBelowTopMm, setDepthBelowTopMm] = useProbingSessionState(machineId, 'depthBelowTopMm', 5)
  // WO-2108 (Operator 09-27): how far the first Z touch searches down for the top.
  const [topSearchMm, setTopSearchMm] = useProbingSessionState(machineId, 'topSearchMm', DEFAULT_TOP_SEARCH_MM)
  // WO-2266 (Operator 09-30, a boss with a hole in its middle): where Boss and
  // Rect boss take their top - touched first (the default) or work Z0.
  const [bossTop, setBossTop] = useProbingSessionState<'touch' | 'workZero'>(machineId, 'bossTop', 'touch')
  const bossTopFromWorkZero = (workKind === 'boss' || workKind === 'rectBoss') && bossTop === 'workZero'
  // WO-2518: circular diameter and rectangular width must remember separate
  // sizes; the old shared X value could belong to either shape.
  const [nominalDiameterMm, setNominalDiameterMm] = useProbingSessionState(machineId, 'nominalDiameterMm', 25)
  const [rectSizeXmm, setRectSizeXmm] = useProbingSessionState(machineId, 'rectSizeXmm', 25)
  const [nominalSizeYmm, setNominalSizeYmm] = useProbingSessionState(machineId, 'nominalSizeYmm', 25)
  const [meshMarginMm, setMeshMarginMm] = useProbingSessionState(machineId, 'meshMarginMm', DEFAULT_MESH_MARGIN_MM)
  const [meshPointsX, setMeshPointsX] = useProbingSessionState(machineId, 'meshPointsX', DEFAULT_MESH_POINTS)
  const [meshPointsY, setMeshPointsY] = useProbingSessionState(machineId, 'meshPointsY', DEFAULT_MESH_POINTS)
  const [meshFadeMm, setMeshFadeMm] = useProbingSessionState(machineId, 'meshFadeMm', DEFAULT_MESH_FADE_MM)
  // WO-2064: how far below point 1 any later point may sit; sets each later search.
  const [meshHeightChangeMm, setMeshHeightChangeMm] = useProbingSessionState(machineId, 'meshHeightChangeMm', DEFAULT_MESH_HEIGHT_CHANGE_MM)
  const [meshBoundsOverride, setMeshBoundsOverride] = useProbingSessionState<SurfaceMeshMap['bounds'] | null>(machineId, 'meshBoundsOverride', null)
  // WO-2166: Calibrate touches the reference picked from the machine's list
  // with Boss's moves (outside) or Bore's (inside), on its exact diameter.
  const calibrating = workKind === 'calibrate'
  const calibrationRefs = useCalibrationReferences(machineId)
  const calibrationRef = calibrationRefs.selected
  const circularFeature = workKind === 'bore' || workKind === 'boss'
  const featureSizeXmm = calibrating ? calibrationRef.diameterMm : circularFeature ? nominalDiameterMm : rectSizeXmm
  const featureSizeYmm = calibrating ? calibrationRef.diameterMm : circularFeature ? nominalDiameterMm : nominalSizeYmm
  // The Probe tool in the spindle - the one Confirm writes the radii to.
  const loadedProbe = activeToolEntry?.type === 'probe' ? activeToolEntry : null
  // The reference the last run touched: its result is worked out from that,
  // whatever the list says now.
  const [calibrationRun, setCalibrationRun] = useProbingSessionState<CalibrationReference | null>(machineId, 'calibrationRun', null)
  // Where each of its touches ran on the other axis (the machine's own
  // position at the touch), so a start off the middle is corrected for.
  const [calibrationAcross, setCalibrationAcross] = useProbingSessionState<Partial<Record<WorkTouchKey, number>>>(machineId, 'calibrationAcross', {})
  // What Confirm said in the result step (no Probe tool to write to, or written).
  const [calibrationNote, setCalibrationNote] = useProbingSessionState<string | null>(machineId, 'calibrationNote', null)
  const [meshSamples, setMeshSamples] = useProbingSessionState<SurfaceMeshSample[]>(machineId, 'meshSamples', [])
  const [, setMeshCycleSafeMachineZ] = useProbingSessionState<number | null>(machineId, 'meshCycleSafeMachineZ', null)
  const [workTouches, setWorkTouches] = useProbingSessionState<Partial<Record<WorkTouchKey, number>>>(machineId, 'workTouches', {})
  const [, storeWorkStatus] = useProbingSessionState<ProbeStatus | null>(machineId, 'workStatus', null)
  // Status words go to the one console (COHESION-STANDARD 13), never a banner -
  // said when they happen, once. WO-2139: never from a mount (reopening the
  // screen reprinted the last routine's line), and not at all when the runner
  // has already said it (its own Stop/Reset line).
  const setWorkStatus = (status: ProbeStatus | null, runnerSaidIt = false) => {
    storeWorkStatus(status)
    if (status && !runnerSaidIt) {
      useMachineControl.getState().pushConsole('rx', status.text, status.kind === 'error' ? 'error' : 'info')
    }
  }
  // WO-2112: where along the face the Angle run took its two points - from the
  // plan that ran, not the one rebuilt from wherever the probe stands now.
  const [angleRunAlongMm, setAngleRunAlongMm] = useProbingSessionState<{ first: number; second: number } | null>(machineId, 'angleRunAlongMm', null)
  // WO-2188: the work offset the Angle run measured against and the rotation
  // the controller reported for it then. The angle is shown against that work
  // frame, and Confirm sets the rotation from it - so a second press sets the
  // same value again rather than adding the angle twice. `overMm` is the run's
  // spacing, the length the tap-it-square number is given over.
  const [angleRunRotation, setAngleRunRotation] = useProbingSessionState<{ wcs: string; deg: number; overMm: number } | null>(machineId, 'angleRunRotation', null)
  const [angleRotating, setAngleRotating] = useState(false)
  // WO-2123: what the last Z0 / Tool Z run set, in the words its last step
  // shows - worked out from the same contact the run wrote.
  const [zSetResult, setZSetResult] = useProbingSessionState<{ routine: 'workZero' | 'toolZ'; text: string } | null>(machineId, 'zSetResult', null)
  const runOutcome = useRef(false)
  // WO-289: where the feature about to be probed sits on the FIRST side. Only
  // ever read on a second-side setup, and TAGGED with the setup it was typed
  // for. This state outlives the panel (WO-1998, useProbingSessionState), so
  // activeSetupId can change under it without touching the
  // routine/axis/direction controls that call resetWorkTouches. Without the
  // tag a number typed for one second side stays on screen, indistinguishable
  // from one typed for the setup now active, and goes into that setup's zero.
  const [featureFirstSide, setFeatureFirstSide] = useProbingSessionState<{
    setupId: string | null
    values: Partial<Record<WorkProbeAxis, number>>
  }>(machineId, 'featureFirstSide', { setupId: null, values: {} })
  // The setup the recorded touches were taken under, for the same reason: a
  // touch measured the part that was in the vise at the time.
  const [workTouchSetupId, setWorkTouchSetupId] = useProbingSessionState<string | null>(machineId, 'workTouchSetupId', null)

  // The flip relationship, resolved through the module that owns it. A setup
  // with no flipOf gives null and every line below it is skipped, which is what
  // keeps first-side probing byte-identical to WO-261.
  const secondSide = useMemo(() => {
    const setup = setups.find((candidate) => candidate.id === activeSetupId)
    if (!setup?.flipOf) return null
    return {
      setup,
      relationship: setup.flipOf,
      plan: planSecondSideSetup(
        { setups, stocks },
        { parentSetupId: setup.flipOf.setupId, axis: setup.flipOf.axis },
      ),
    }
  }, [setups, stocks, activeSetupId])

  // The relationship, split into the two states the panel renders: resolved, or
  // named-but-unresolvable. Split here rather than in the JSX because narrowing
  // a property union does not survive into the callbacks below.
  const secondSidePlan = secondSide?.plan.ok ? secondSide.plan : null
  const secondSideBlocked = secondSide && !secondSide.plan.ok ? secondSide.plan.message : null

  const motionEnvelope = useMemo(
    () => resolveMachineMotion({ machine, connectionKind, settings, datumKnown: homed }).envelope,
    [connectionKind, homed, machine, settings],
  )
  // WO-304: the same honest three-state chokepoint machineEnvelope.ts
  // (WO-292) established for the Program preview - a machine coordinate is
  // only ever real once $H has completed THIS session; unhomed, unknown or
  // no-datum, GRBL's own MPos is a number left over from wherever the
  // steppers happened to be at power-up, never a fact about the table.
  //
  // WO-1669: the store's `settings` table only ever holds numeric GRBL `$N`
  // keys (machineSession.ts's onSetting drops anything else), so it stays
  // empty for a bridge/UCCNC session even after the definition has been
  // applied and read back. The Control tab and the fit check (transferCheck.ts)
  // already answer "are the limits known" from resolveMachineMotion's
  // envelope, not from that raw dump - ask the same question here so a
  // read-back UCCNC definition counts as known limits on this tab too.
  const envelopeStatus = useMemo(
    () =>
      deriveEnvelopeStatus({
        connected,
        settingsKnown: Object.keys(settings).length > 0
          || Boolean(motionEnvelope.x && motionEnvelope.y && motionEnvelope.z),
        homed,
        noHomingSwitches: machine?.noHomingSwitches,
      }),
    [connected, settings, homed, machine?.noHomingSwitches, motionEnvelope],
  )
  const safeMpos = safeMachinePosition(envelopeStatus, mpos)

  const surfaceMeshPlan = useMemo(
    () => planSurfaceMesh(meshProgramText, {
      marginMm: meshMarginMm,
      pointsX: meshPointsX,
      pointsY: meshPointsY,
      fadeMm: meshFadeMm,
      ...(meshBoundsOverride ? { bounds: meshBoundsOverride } : {}),
    }),
    [meshProgramText, meshMarginMm, meshPointsX, meshPointsY, meshFadeMm, meshBoundsOverride],
  )
  const visibleSurfaceMesh = activeSurfaceMesh
    && meshProgramText
    && activeSurfaceMesh.sourceFingerprint === fingerprintProgram(meshProgramText)
      ? activeSurfaceMesh
      : null
  const surfaceMeshEnvelopeError = useMemo(() => {
    if (!surfaceMeshPlan.ok || !safeMpos || !wpos) return null
    if (!motionEnvelope.x || !motionEnvelope.y) return 'Read or define the machine XY travel envelope before probing a mesh.'
    const offsetX = safeMpos.x - wpos.x
    const offsetY = safeMpos.y - wpos.y
    const machineBounds = {
      minX: surfaceMeshPlan.setup.bounds.minX + offsetX,
      maxX: surfaceMeshPlan.setup.bounds.maxX + offsetX,
      minY: surfaceMeshPlan.setup.bounds.minY + offsetY,
      maxY: surfaceMeshPlan.setup.bounds.maxY + offsetY,
    }
    if (
      machineBounds.minX < motionEnvelope.x.min || machineBounds.maxX > motionEnvelope.x.max
      || machineBounds.minY < motionEnvelope.y.min || machineBounds.maxY > motionEnvelope.y.max
    ) {
      return 'The editable mesh area reaches outside the machine XY travel envelope.'
    }
    return null
  }, [surfaceMeshPlan, safeMpos, wpos, motionEnvelope])

  const zRoutine = workKind === 'zSurface' || workKind === 'toolZ' || workKind === 'workZero'
  // WO-985 also derives switchless mode from the controller wiring, while
  // machineEnvelope's status takes the older explicit profile flag. Preserve
  // that broader, already-shipped no-datum answer at this refusal boundary.
  const refusalEnvelopeStatus: EnvelopeStatus = machineHasNoHomeSwitches(machine)
    ? 'no-datum'
    : envelopeStatus
  const featureEnvelopeRefusal = probePlanEnvelopeRefusal(refusalEnvelopeStatus, 'automatic probe cycle')
  const meshEnvelopeRefusal = probePlanEnvelopeRefusal(refusalEnvelopeStatus, 'mesh travel')
  const guidedPlan = useMemo(() => {
    if (workKind === 'zSurface' || workKind === 'toolZ' || workKind === 'workZero') {
      return { ok: false as const, reason: 'Z probing uses the current XY position and the machine probe travel limit.' }
    }
    if (!safeMpos) {
      return {
        ok: false as const,
        reason: featureEnvelopeRefusal,
      }
    }
    return planFeatureProbeCycle({
      kind: workKind === 'calibrate' ? calibrationFeatureKind(calibrationRef.kind) : workKind,
      start: safeMpos,
      envelope: motionEnvelope,
      config: probeCfg,
      tipRadiusMm: senseRadiusMm,
      nominalSizeXmm: featureSizeXmm,
      nominalSizeYmm: featureSizeYmm,
      edgeAxis,
      edgeDirection,
      cornerXDirection,
      cornerYDirection,
      angleNominalAxis,
      angleProbeDirection,
      angleAlongDirection,
      angleSpacingMm,
      startDistanceMm,
      depthBelowTopMm: depthBelowTopMm,
      topSearchMm,
      ...(bossTopFromWorkZero ? { topFromWorkZero: true } : {}),
      safeZMachineMm: declaredSafeZ,
    })
  }, [
    startDistanceMm,
    depthBelowTopMm,
    topSearchMm,
    bossTopFromWorkZero,
    safeMpos,
    workKind,
    motionEnvelope,
    probeCfg,
    senseRadiusMm,
    sensing,
    calibrationRef.kind,
    featureSizeXmm,
    featureSizeYmm,
    edgeAxis,
    edgeDirection,
    cornerXDirection,
    cornerYDirection,
    angleNominalAxis,
    angleProbeDirection,
    angleAlongDirection,
    angleSpacingMm,
    declaredSafeZ,
    featureEnvelopeRefusal,
  ])

  // Refusal text belongs in the existing machine console too (WO-474). The
  // panel stays mounted between Control subviews, so remember the last active
  // refusal and never append it again merely because another store field
  // caused a rerender.
  const refusalAnnounced = useRef<string | null>(null)
  const activeEnvelopeRefusal = !safeMpos
    ? workKind === 'zSurface'
      ? surfaceMeshPlan.ok
        ? meshEnvelopeRefusal
        : null
      : !zRoutine
        ? featureEnvelopeRefusal
        : null
    : null
  useEffect(() => {
    if (activeEnvelopeRefusal === null) {
      refusalAnnounced.current = null
      return
    }
    if (activeEnvelopeRefusal === refusalAnnounced.current) return
    refusalAnnounced.current = activeEnvelopeRefusal
    useMachineControl.getState().pushConsole('tx', activeEnvelopeRefusal, 'error')
  }, [activeEnvelopeRefusal])
  // WO-2063: Start probing is the operator's go - the picture shows the path
  // before it is pressed (docs/design/PROBING-SCREEN-V2.md: E-STOP, Start
  // probing, Stop; no tick box on this screen).
  const pathClearConfirmed = true

  // The axes the chosen routine will produce, and so the axes a second side
  // needs a first-side reference for.
  const referenceAxes: WorkProbeAxis[] = workKind === 'edge'
    ? [edgeAxis]
    : workKind === 'zSurface' || workKind === 'toolZ' || workKind === 'workZero' || workKind === 'angle' || workKind === 'calibrate'
      ? []
      : ['X', 'Y']

  // The setup-scoped reads of the two states above. Derived rather than cleared
  // in an effect on purpose: an effect leaves one committed render in which the
  // panel names the NEW setup while still holding - and offering to write - the
  // old setup's numbers. Nothing below this line can see a number entered for a
  // setup that is not the active one.
  const featureFirstSideMm =
    featureFirstSide.setupId === activeSetupId ? featureFirstSide.values : NO_FEATURE_REFERENCE
  const touchesAreThisSetup = workTouchSetupId === activeSetupId

  const streaming = jobPhase === 'streaming' || jobPhase === 'paused'
  // WO-1545: every probe command goes through the G-code translator, so no
  // control here is gated on whether the controller takes text. The Unlock
  // button stays outside `canAct` - no route out of an alarm may ever be gated.
  const canAct = connected && machineState === 'idle' && !streaming && !busy
  const canEdit = !busy
  // WO-2008: the Run button says why it is grey - the machine's state first
  // (a tool-change hold is Hold), then the routine's own plan, then the tick.
  const runGuidedPlanBlocked = workKind === 'zSurface'
    ? !surfaceMeshPlan.ok || !safeMpos || Boolean(surfaceMeshEnvelopeError)
    : !guidedPlan.ok && !zRoutine
  const runGuidedWhyDisabled: string | null = !connected
    ? 'Connect to the machine first.'
    : busy
      ? 'A probe cycle is running - wait for it to finish.'
      : machineState === 'hold'
        ? 'A hold (a tool change waiting on you) owns the machine - press Cycle Start to finish it, or Stop, then run the probe.'
        : streaming
          ? 'A program is running - Feed Hold, then Stop, before probing.'
          : machineState !== 'idle'
            ? `The machine is ${machineState} - wait until it is idle.`
            : runGuidedPlanBlocked
              ? (workKind === 'zSurface'
                // The envelope's own cause when there is no safe position
                // (WO-1045 / WO-988: unread settings, not homed, no datum).
                ? (!surfaceMeshPlan.ok ? surfaceMeshPlan.reason : surfaceMeshEnvelopeError ?? activeEnvelopeRefusal ?? 'Read the machine position first.')
                : (!guidedPlan.ok ? guidedPlan.reason : 'This routine has no plan yet.'))
              : null

  const resetWorkTouches = () => {
    setWorkTouches({})
    setWorkTouchSetupId(null)
    setWorkStatus(null)
    setMeshSamples([])
    // A reference typed for one feature must never be reused for the next: the
    // routine or the axis just changed, so it is a different feature.
    setFeatureFirstSide({ setupId: null, values: {} })
  }

  const commitDim = (text: string, apply: (mm: number) => void): boolean => {
    const mm = parseDimToMm(text, units)
    if (!Number.isFinite(mm)) return false
    apply(mm)
    return true
  }

  const commitPositiveDim = (text: string, apply: (mm: number) => void): boolean => {
    const mm = parseDimToMm(text, units)
    if (!Number.isFinite(mm) || mm <= 0) return false
    apply(mm)
    return true
  }

  const commitNonNegativeDim = (text: string, apply: (mm: number) => void): boolean => {
    const mm = parseDimToMm(text, units)
    if (!Number.isFinite(mm) || mm < 0) return false
    apply(mm)
    return true
  }

  const commitMeshCount = (text: string, apply: (count: number) => void): boolean => {
    const count = Number(text)
    if (!Number.isInteger(count) || count < 3 || count > 25) return false
    apply(count)
    return true
  }

  const updateMeshBound = (key: keyof SurfaceMeshMap['bounds'], value: number) => {
    if (!surfaceMeshPlan.ok) return
    setMeshBoundsOverride({ ...surfaceMeshPlan.setup.bounds, [key]: value })
  }

  // WO-2267: the same action as the Control strip's mesh Clear.
  const disableSurfaceMesh = () => {
    clearSurfaceMesh()
    setMeshSamples([])
    setWorkStatus({ kind: 'ok', text: 'Surface mesh compensation disabled; the original program is armed.' })
  }

  // WO-2112: the Angle result - the measured angle and the face it was taken
  // on. The result step and the console both read it from here. Throws what
  // calculateYawAngle throws; null until both points are touched.
  const angleMeasurement = (
    along: { first: number; second: number },
    touches: Partial<Record<WorkTouchKey, number>>,
    rotation: { wcs: string; deg: number; overMm: number } | null,
  ): WorkProbePreview | null => {
    if (touches.angleFirst === undefined || touches.angleSecond === undefined) return null
    // The angle is the line's, whichever way along the face point 2 was taken:
    // measured with Point 2 on the minus side, the line from point 1 runs
    // backwards along the axis and reads as ~180 deg.
    const first = { alongMm: along.first, triggerPositionMm: touches.angleFirst }
    const second = { alongMm: along.second, triggerPositionMm: touches.angleSecond }
    const forward = along.second >= along.first
    const result = calculateYawAngle({
      nominalAxis: angleNominalAxis,
      direction: angleProbeDirection,
      tipRadiusMm: senseRadiusOn(angleNominalAxis === 'X' ? 'Y' : 'X'),
      first: forward ? first : second,
      second: forward ? second : first,
    })
    const face = ANGLE_FACES.find((f) => f.value === `${angleNominalAxis}${angleProbeDirection}`)
    const faceWords = face ? ` on the ${face.face} face (probe ${face.probe})` : ''
    // WO-2188: the touches are machine positions; under a work rotation the
    // angle is the one against the rotated work axis, so after Confirm the
    // same face reads 0 (docs/design/WCS-ROTATION.md).
    const fromDeg = rotation?.deg ?? 0
    const deg = lineAngleInWorkDeg(result.thetaDeg, fromDeg)
    const rotatedWords = fromDeg !== 0 && rotation ? `, with ${describeWorkRotation(rotation.wcs, fromDeg)}` : ''
    const off = faceRunOff(result.nominalAxis, deg, rotation?.overMm ?? Math.abs(along.second - along.first))
    const over = `${fmtMachineLength(off.overMm, units)} ${unitLabel(units)}`
    const tapText = off.tap === null
      ? `The face runs square over ${over} - nothing to tap.`
      : `The face runs off ${fmtMachineLength(off.runOffMm, units)} ${unitLabel(units)} over ${over} - tap the ${off.end} end ${off.tap}.`
    return {
      title: 'Angle result',
      resultText: `Measured ${deg.toFixed(3).replace(/^-(0\.0+)$/, '$1')} deg from nominal ${result.nominalAxis}${faceWords}${rotatedWords}.`,
      compensation: withPlate(result.compensation),
      values: {},
      angleDeg: deg,
      angleRotation: rotation ? { wcs: rotation.wcs, fromDeg, toDeg: fromDeg + deg, tapText } : undefined,
    }
  }

  const runGuidedCycle = async () => {
    runOutcome.current = false
    if (busy) return
    if (workKind === 'zSurface') {
      if (!surfaceMeshPlan.ok || surfaceMeshEnvelopeError || !safeMpos || !meshProgramText) {
        setWorkStatus({
          kind: 'error',
          text: surfaceMeshEnvelopeError ?? (surfaceMeshPlan.ok
            ? 'Review and confirm the mesh area, safe Z travel, and probe path before motion.'
            : surfaceMeshPlan.reason),
        })
        return
      }
      const confirmedSafeMachineZ = safeMpos.z
      setMeshCycleSafeMachineZ(confirmedSafeMachineZ)
      setBusy(true)
      setMeshSamples([])
      setWorkStatus({ kind: 'ok', text: `Probing ${surfaceMeshPlan.points.length} mesh points - keep the E-STOP in reach.` })
      try {
        const result = await runSurfaceMeshProbeCycle(
          {
            points: surfaceMeshPlan.points,
            bounds: surfaceMeshPlan.setup.bounds,
            cutBounds: surfaceMeshPlan.setup.cutBounds,
            pointsX: surfaceMeshPlan.setup.pointsX,
            pointsY: surfaceMeshPlan.setup.pointsY,
            fadeMm: surfaceMeshPlan.setup.fadeMm,
            safeMachineZ: confirmedSafeMachineZ,
            largestHeightChangeMm: meshHeightChangeMm,
            sourceProgramText: meshProgramText,
            sourceName: programName,
            workOffset: activeWcs ?? workWcs,
          },
          probeCfg,
          pathClearConfirmed,
          (sample) => setMeshSamples((current) => [...current, sample]),
        )
        runOutcome.current = result.ok
        setWorkStatus({ kind: result.ok ? 'ok' : 'error', text: result.message }, result.stopped === true)
      } finally {
        setBusy(false)
        setMeshCycleSafeMachineZ(null)
      }
      return
    }
    if (workKind === 'workZero') {
      // WO-2061: the Tools screen's Probe work Z0 - the same runZProbeCycle,
      // the same settings, and the same reference-tool mark on success
      // (WO-1995), bound to the machine and session that started it.
      const receiptMachineId = machineId
      const receiptGeneration = useCamStore.getState().control.sessionGeneration ?? 0
      const receiptTool = activeTool
      // WO-2123: the plate this run subtracts (runZProbeCycle reads the same choice).
      const receiptPlateMm = workZeroPlateMm
      setBusy(true)
      setWorkStatus(null)
      setZSetResult(null)
      try {
        const result = await runZProbeCycle('workZero', workZeroCfg)
        if (result.ok && result.probedMachineZ !== null) {
          // The run wrote Z0 at the contact less the plate, into the offset
          // active when it wrote (runZProbeCycle's afterContact).
          const zeroWcs = useMachineControl.getState().activeWcs
          setZSetResult({
            routine: 'workZero',
            text: `Work Z0 set: ${zeroWcs ?? 'the active work offset'} Z0 = `
              + `${formatPosition({ machine: { z: result.probedMachineZ - receiptPlateMm }, format: (v) => fmtMachineLength(v, units) })} ${unitLabel(units)}.`,
          })
        }
        const receiptState = useCamStore.getState()
        const receiptIsCurrent = (receiptState.control.sessionGeneration ?? 0) === receiptGeneration
          && controlMachine(receiptState).id === receiptMachineId
        let suffix = ''
        if (result.ok && result.probedMachineZ !== null && !receiptIsCurrent) {
          suffix = ' The machine connection changed before this result could be retained.'
        } else if (result.ok && result.probedMachineZ !== null && receiptTool !== null) {
          probeStore.getState().setReference(receiptMachineId, receiptTool)
          saveToolRecord()
          const refSetterZ = findTool(probeStore.getState().tableFor(receiptMachineId), receiptTool)?.probedMachineZ ?? null
          useMachineControl.getState().pushConsole(
            'rx',
            `Work Z0 pad fine contact: ${formatPosition({ machine: { z: result.probedMachineZ }, format: (v) => fmtMachineLength(v, units) })} ${unitLabel(units)}; T${receiptTool} marked as the reference tool. `
              + (refSetterZ === null
                ? `T${receiptTool} still needs a setter measurement (Measure T${receiptTool}) before Apply length can work.`
                : `Its setter reading stays ${formatPosition({ machine: { z: refSetterZ }, format: (v) => fmtMachineLength(v, units) })} ${unitLabel(units)}.`),
            'info',
          )
          suffix = ` T${receiptTool} marked as the reference tool.`
        } else if (result.ok) {
          suffix = ' No tool number is active, so no reference tool was marked.'
        }
        runOutcome.current = result.ok && receiptIsCurrent
        setWorkStatus({ kind: result.ok && receiptIsCurrent ? 'ok' : 'error', text: result.message + suffix }, result.stopped === true)
      } finally {
        setBusy(false)
      }
      return
    }
    if (zRoutine) {
      setBusy(true)
      setWorkStatus(null)
      setZSetResult(null)
      try {
        const result = await runZProbeCycle('measureTool', probeCfg, chosenSetterRoutine)
        if (result.ok && result.probedMachineZ !== null && activeTool !== null) {
          probeStore.getState().recordProbedZ(machineId, activeTool, result.probedMachineZ, Date.now())
          saveToolRecord()
        }
        if (result.ok && result.probedMachineZ !== null) {
          // WO-2123: the number just stored - the tool's Setter Z, or the
          // active length (the datum) when no T number is active.
          const at = `${formatPosition({ machine: { z: result.probedMachineZ }, format: (v) => fmtMachineLength(v, units) })} ${unitLabel(units)} on the setter`
          setZSetResult({
            routine: 'toolZ',
            text: activeTool === null
              ? `Tool length measured: ${at}, held as the active tool length (no T number is active).`
              : `Tool length measured: T${activeTool} = ${at}, stored as its Setter Z.`,
          })
        }
        const suffix = result.ok
          ? activeTool === null
            ? ' Held as active tool length (the datum).'
            : ` Recorded for active T${activeTool}.`
          : ''
        runOutcome.current = result.ok
        setWorkStatus({ kind: result.ok ? 'ok' : 'error', text: result.message + suffix }, result.stopped === true)
      } finally {
        setBusy(false)
      }
      return
    }
    if (!guidedPlan.ok) {
      setWorkStatus({ kind: 'error', text: guidedPlan.reason })
      return
    }
    setBusy(true)
    setWorkTouches({})
    setWorkTouchSetupId(activeSetupId)
    const calibrationAt = calibrating ? calibrationRef : null
    setCalibrationRun(calibrationAt)
    setCalibrationAcross({})
    setCalibrationNote(null)
    const angleAlong = workKind === 'angle' ? angleAlongOf(guidedPlan.plan.steps, angleNominalAxis) : null
    setAngleRunAlongMm(angleAlong)
    // WO-2188: the work offset this run measures against - the active one - and
    // its rotation as the controller reports it now.
    const angleWcs: string = useMachineControl.getState().activeWcs ?? workWcs
    const angleRotation = angleAlong
      ? { wcs: angleWcs, deg: workRotations()[angleWcs] ?? 0, overMm: Math.abs(angleAlong.second - angleAlong.first) }
      : null
    setAngleRunRotation(angleRotation)
    // WO-2188: where along the face each Angle contact landed, from the
    // controller's own record of that touch (a text controller's [PRB],
    // LinuxCNC's probed_position - machine frame). Under a LinuxCNC rotation
    // the probe move turns with the work axes, so the contact is not at the
    // plan's position along the face. No record of the touch = the plan's.
    const angleContactAlong: Partial<Record<WorkTouchKey, number>> = {}
    setWorkStatus({ kind: 'ok', text: `Running ${workKind} cycle - keep the E-STOP in reach.` })
    try {
      const result = await runFeatureProbeCycle(
        guidedPlan.plan,
        probeCfg,
        pathClearConfirmed,
        (key, positionMm) => {
          setWorkTouches((current) => ({ ...current, [key]: positionMm }))
          setWorkTouchSetupId(activeSetupId)
          if (angleAlong && (key === 'angleFirst' || key === 'angleSecond')) {
            const prb = useMachineControl.getState().probe
            const across = prb?.success ? prb.values[angleNominalAxis === 'X' ? 1 : 0] : undefined
            const along = prb?.success ? prb.values[angleNominalAxis === 'X' ? 0 : 1] : undefined
            if (typeof across === 'number' && Math.abs(across - positionMm) < 1e-9 && typeof along === 'number' && Number.isFinite(along)) {
              angleContactAlong[key] = along
            }
          }
          if (calibrationAt) {
            const at = getMachineController().status().machinePos ?? useMachineControl.getState().mpos
            if (at) setCalibrationAcross((current) => ({ ...current, [key]: key.startsWith('x') ? at.y : at.x }))
          }
        },
      )
      runOutcome.current = result.ok
      const ranAlong = angleAlong
        ? { first: angleContactAlong.angleFirst ?? angleAlong.first, second: angleContactAlong.angleSecond ?? angleAlong.second }
        : null
      if (ranAlong && (ranAlong.first !== angleAlong?.first || ranAlong.second !== angleAlong?.second)) setAngleRunAlongMm(ranAlong)
      // WO-2112: the console says the angle the screen shows, worked out by
      // the same function from the same touches.
      let measured = ''
      if (result.ok && ranAlong) {
        try {
          measured = ` ${angleMeasurement(ranAlong, result.touches, angleRotation)?.resultText ?? ''}`.trimEnd()
        } catch (error) {
          measured = error instanceof Error ? ` ${error.message}` : ''
        }
      }
      setWorkStatus({ kind: result.ok ? 'ok' : 'error', text: result.message + measured }, result.stopped === true)
      // WO-2166 (Operator 09-28): a repeat calibration that disagrees with the
      // tool's current radii says by how much - one console line, nothing else.
      const across = useProbingSession.getState().values.calibrationAcross as Partial<Record<WorkTouchKey, number>> | undefined
      const radii = result.ok && calibrationAt ? calibrationRadii(calibrationAt.kind, calibrationAt.diameterMm, result.touches, across) : null
      if (radii && loadedProbe) {
        const line = calibrationDisagreementLine(
          `T${activeTool} ${loadedProbe.name}`,
          { x: probeCalibratedRadius(loadedProbe, 'x'), y: probeCalibratedRadius(loadedProbe, 'y') },
          radii,
        )
        if (line) useMachineControl.getState().pushConsole('rx', line, 'info')
      }
    } finally {
      setBusy(false)
    }
  }

  const workPreview = (() => {
    try {
      if (workKind === 'edge' && workTouches.edge !== undefined) {
        const result = calculateEdge({
          axis: edgeAxis,
          direction: edgeDirection,
          triggerPositionMm: workTouches.edge,
          tipRadiusMm: senseRadiusOn(edgeAxis),
        })
        return {
          title: 'Edge result',
          resultText: `${result.axis} face ${fmtMachineLength(result.coordinateMm, units)} ${unitLabel(units)}.`,
          compensation: withPlate(result.compensation),
          values: { [result.axis]: result.coordinateMm },
        } satisfies WorkProbePreview
      }
      if (
        (workKind === 'insideCorner' || workKind === 'outsideCorner') &&
        workTouches.cornerX !== undefined &&
        workTouches.cornerY !== undefined
      ) {
        const x = { direction: cornerXDirection, triggerPositionMm: workTouches.cornerX, tipRadiusMm: senseRadiusXmm }
        const y = { direction: cornerYDirection, triggerPositionMm: workTouches.cornerY, tipRadiusMm: senseRadiusYmm }
        // WO-2156: calculateCorner takes one radius for both faces; a probe
        // calibrated apart in X and Y compensates each face by its own.
        const result = perAxisRadius
          ? (() => {
              const xEdge = calculateEdge({ axis: 'X', ...x })
              const yEdge = calculateEdge({ axis: 'Y', ...y })
              return {
                xMm: xEdge.coordinateMm,
                yMm: yEdge.coordinateMm,
                compensation: `Probe tip radius compensation: ${fmtMachineLength(x.tipRadiusMm, units)} ${unitLabel(units)} on the X face (X${cornerXDirection}), `
                  + `${fmtMachineLength(y.tipRadiusMm, units)} ${unitLabel(units)} on the Y face (Y${cornerYDirection}).`,
              }
            })()
          : calculateCorner({ x, y })
        return {
          title: `${workKind === 'insideCorner' ? 'Inside' : 'Outside'} corner result`,
          resultText:
            `Corner at ${formatPosition({ machine: { x: result.xMm, y: result.yMm }, format: (v) => fmtMachineLength(v, units) })} ${unitLabel(units)}.`,
          compensation: withPlate(result.compensation),
          values: { X: result.xMm, Y: result.yMm },
        } satisfies WorkProbePreview
      }
      if (
        (workKind === 'bore' || workKind === 'boss' || workKind === 'rectPocket' || workKind === 'rectBoss') &&
        workTouches.xNegative !== undefined &&
        workTouches.xPositive !== undefined &&
        workTouches.yNegative !== undefined &&
        workTouches.yPositive !== undefined
      ) {
        const inside = workKind === 'bore' || workKind === 'rectPocket'
        const rectangular = workKind === 'rectPocket' || workKind === 'rectBoss'
        const calculate = inside ? calculateBoreCenter : calculateBossCenter
        const touches = {
          xNegativeMm: workTouches.xNegative,
          xPositiveMm: workTouches.xPositive,
          yNegativeMm: workTouches.yNegative,
          yPositiveMm: workTouches.yPositive,
        }
        // WO-2156: one radius per call; the X span takes the X radius and the
        // Y span the Y radius (the centre does not depend on either).
        const alongX = calculate({ ...touches, tipRadiusMm: senseRadiusXmm })
        const result = perAxisRadius
          ? {
              ...alongX,
              diameterYmm: calculate({ ...touches, tipRadiusMm: senseRadiusYmm }).diameterYmm,
              compensation: `Probe tip radius compensation: ${fmtMachineLength(senseRadiusXmm, units)} ${unitLabel(units)} on X, ${fmtMachineLength(senseRadiusYmm, units)} ${unitLabel(units)} on Y `
                + `${inside ? 'added at both walls' : 'subtracted at both faces'} (2x radius per measured diameter).`,
            }
          : alongX
        return {
          title: `${ROUTINE_OPTIONS.find((option) => option.kind === workKind)?.label ?? workKind} centre result`,
          resultText:
            `Centre at ${formatPosition({ machine: { x: result.centerXmm, y: result.centerYmm }, format: (v) => fmtMachineLength(v, units) })}; ` +
            `measured ${rectangular ? 'width' : 'diameter'} X ${fmtMachineLength(result.diameterXmm, units)}, ` +
            `Y ${fmtMachineLength(result.diameterYmm, units)} ${unitLabel(units)}.`,
          compensation: withPlate(result.compensation),
          values: { X: result.centerXmm, Y: result.centerYmm },
        } satisfies WorkProbePreview
      }
      if (workKind === 'angle' && angleRunAlongMm) return angleMeasurement(angleRunAlongMm, workTouches, angleRunRotation)
    } catch (error) {
      return {
        title: 'Probe result invalid',
        resultText: error instanceof Error ? error.message : 'The captured touches are invalid.',
        compensation: withPlate(perAxisRadius
          ? `Probe tip radius compensation requested: ${fmtMachineLength(senseRadiusXmm, units)} ${unitLabel(units)} on X, ${fmtMachineLength(senseRadiusYmm, units)} ${unitLabel(units)} on Y.`
          : `Probe tip radius compensation requested: ${fmtMachineLength(senseRadiusXmm, units)} ${unitLabel(units)}.`),
        values: {},
      } satisfies WorkProbePreview
    }
    return null
  })()

  // WO-289: on a second-side setup the compensated probe result above is not
  // the zero - it is where a known feature was found. Hand both to the flip
  // module and let it produce the zero, or refuse and name the disagreement.
  const secondSideZero = (() => {
    if (!secondSide || !secondSidePlan || !workPreview) return null
    const probedMachineMm: Partial<Record<WorkProbeAxis, number>> = {}
    for (const axis of ['X', 'Y'] as const) {
      if (workPreview.values[axis] !== undefined) probedMachineMm[axis] = workPreview.values[axis]
    }
    // An invalid-touch preview carries no values; leave WO-261's own error text
    // standing rather than layering a second complaint on top of it.
    if (Object.keys(probedMachineMm).length === 0) return null
    // Touches taken while another setup was active are another part's
    // measurements. Refuse and say so, rather than feeding them this side's
    // block and turn - that produces a plausible zero for a part that is no
    // longer in the vise.
    if (!touchesAreThisSetup) return secondSideStaleTouchRefusal(secondSide.setup.name)
    return planSecondSideProbeZero({
      relationship: secondSide.relationship,
      flipAxis: secondSidePlan.axis,
      frame: {
        stockSize: secondSidePlan.stockSize,
        originInStock: secondSidePlan.originInStock,
      },
      featureOnFirstSideMm: featureFirstSideMm,
      probedMachineMm,
      firstSideName: secondSidePlan.parentSetupName,
      secondSideName: secondSide.setup.name,
      relationshipOffsetG: secondSidePlan.fixtureOffset,
      targetOffsetG: Number(workWcs.slice(1)),
    })
  })()

  // What the confirmation button would actually write. On a second side that is
  // the flip-corrected zero and nothing else; a refusal offers no button at all.
  const confirmPreview: WorkProbePreview | null = (() => {
    if (!workPreview) return null
    if (!secondSide) return workPreview
    if (!secondSideZero) return secondSidePlan ? workPreview : null
    if (!secondSideZero.ok) return null
    return {
      ...workPreview,
      values: Object.fromEntries(
        secondSideZero.axes.map((axis) => [axis.axis, axis.workZeroMachineMm]),
      ) as Partial<Record<WorkProbeAxis, number>>,
      secondSide: secondSideAxisLines(secondSideZero, units),
    }
  })()

  const applyWorkPreview = () => {
    // Only ever the values the confirmation actually showed.
    if (!confirmPreview) return
    const writes = (['X', 'Y'] as const).filter(
      (axis) => confirmPreview.values[axis] !== undefined,
    )
    let applied = 0
    for (const axis of writes) {
      if (setWorkOffsetValue(workWcs, axis, confirmPreview.values[axis]!)) applied++
      else break
    }
    setWorkStatus(
      applied === writes.length
        ? { kind: 'ok', text: `${workWcs} ${writes.join('/')} work offset applied after confirmation.` }
        : {
            kind: 'error',
            text: `${workWcs} accepted ${applied} of ${writes.length} offset writes. Verify the offset table before continuing.`,
          },
    )
  }

  // WO-2188 (Operator 09-29): Angle's Confirm - the operator's choice to rotate the
  // work offset by the angle shown, through the one controller call (WO-2187).
  // Not pressing it changes nothing. It sets the rotation the result names, so
  // the indicator and a second run read the controller's own answer.
  const angleRotationSet = workKind === 'angle' ? workPreview?.angleRotation ?? null : null
  const applyAngleRotation = async () => {
    if (!angleRotationSet || angleRotating) return
    setAngleRotating(true)
    try {
      await setWorkRotation(angleRotationSet.wcs, angleRotationSet.toDeg)
    } finally {
      setAngleRotating(false)
    }
  }
  const angleDegWords = (deg: number) => String(Number(deg.toFixed(3)))

  // WO-2166: the radii the last Calibrate run found, and Confirm's write to
  // the loaded Probe tool - only ever the numbers the result step shows.
  const calibrationResult = calibrating && calibrationRun
    ? calibrationRadii(calibrationRun.kind, calibrationRun.diameterMm, workTouches, calibrationAcross)
    : null
  const applyCalibration = () => {
    if (!calibrationResult) return
    if (!loadedProbe) {
      setCalibrationNote(activeTool === null
        ? 'No tool is loaded, so there is no Probe tool to write these to. Load the Probe tool and press Confirm.'
        : `T${activeTool} is not a Probe tool, so there is no Probe tool to write these to. Load the Probe tool and press Confirm.`)
      return
    }
    const x = calibrationResult.radiusXmm
    const y = calibrationResult.radiusYmm
    const written = useCamStore.getState().updateTool(loadedProbe.id, { probeEffectiveRadiusX: x, probeEffectiveRadiusY: y })
    const tool = `T${activeTool} ${loadedProbe.name}`
    setCalibrationNote(written ? `Written to ${tool}.` : `${tool} was not changed - the console says why.`)
    if (written) {
      setWorkStatus({
        kind: 'ok',
        text: `${tool}: calibrated X radius ${fmtMachineLength(x, units)}, Y radius ${fmtMachineLength(y, units)} ${unitLabel(units)} written`
          + `${calibrationRun ? ` (${calibrationRun.name})` : ''}.`,
      })
    }
  }

  // ---- WO-2063: the screen, one step at a time (docs/design/PROBING-SCREEN-V2.md) ----
  const probingRoutine: ProbingRoutine = workKind
  // Boss's cross-over lift, as a number: the plan object is rebuilt on every
  // position report, the lift is not.
  const bossLiftMm = guidedPlan.ok && guidedPlan.plan.review.clearMotion.kind === 'boss-cross-over'
    ? guidedPlan.plan.review.clearMotion.liftMm
    : null
  // Tool Z: the machine's real distances for the setter trip (the picture
  // draws it schematic), so the running tool and its counting distance keep
  // the machine's pace (WO-2063: the drawn tool reached the setter in 0.7 s
  // of a 6.5 s crossing).
  const setterTrip = setterPlan?.ok && workKind === 'toolZ' && mpos ? setterPlan.plan : null
  const riseMm = setterTrip && mpos ? Math.max(0, setterTrip.travelZ - mpos.z) : null
  const crossMm = setterTrip && mpos ? Math.hypot(setterTrip.setter.x - mpos.x, setterTrip.setter.y - mpos.y) : null
  const downMm = setterTrip ? setterTrip.travelZ - (setterTrip.approach?.expectedContactZ ?? setterTrip.searchFloorZ) : null
  const toolZMachine = useMemo(
    () => (riseMm === null || crossMm === null || downMm === null ? null : { riseMm, crossMm, downMm }),
    [riseMm, crossMm, downMm],
  )
  // The routine and its setup fields: what the pictures are drawn from.
  // Tool Z's real distances follow the machine's position, so they join the
  // picture below and are not part of the setup (a jog after a Stop is not
  // a setup change).
  const sceneSetup: SceneSetup = useMemo(() => ({
    routine: probingRoutine,
    config: probeCfg,
    tipRadiusMm: tipMotionMm,
    plateMm,
    startDistanceMm,
    depthMm: depthBelowTopMm,
    topSearchMm,
    ...(bossTopFromWorkZero ? { topFromWorkZero: true } : {}),
    edgeAxis,
    edgeDirection,
    cornerXDirection,
    cornerYDirection,
    angleNominalAxis,
    angleProbeDirection,
    angleAlongDirection,
    angleSpacingMm,
    sizeXmm: featureSizeXmm,
    sizeYmm: featureSizeYmm,
    wcs: workWcs,
    bossLiftMm,
    calibration: calibrating
      ? { kind: calibrationRef.kind, diameterMm: calibrationRef.diameterMm, tool: loadedProbe ? `T${activeTool}` : null }
      : null,
    toolZ: { tool: activeTool ?? null },
    workZero: {
      plateMm: workZeroPlateMm,
      clearanceMm: workZeroCfg.surfaceClearance,
      retractMm: workZeroCfg.retract,
      maxTravelMm: workZeroCfg.maxTravel,
    },
    mesh: surfaceMeshPlan.ok
      ? {
          points: surfaceMeshPlan.points.map((p) => ({ x: p.x, y: p.y })),
          heightChangeMm: meshHeightChangeMm,
          pointsX: surfaceMeshPlan.setup.pointsX,
          pointsY: surfaceMeshPlan.setup.pointsY,
          cutBounds: surfaceMeshPlan.setup.cutBounds,
        }
      : null,
    units: (mm: number) => pictureValue(mm, units),
  }), [
    probingRoutine, probeCfg, tipMotionMm, plateMm, startDistanceMm, depthBelowTopMm, topSearchMm, bossTopFromWorkZero, edgeAxis, edgeDirection,
    cornerXDirection, cornerYDirection, angleNominalAxis, angleProbeDirection, angleAlongDirection, angleSpacingMm,
    featureSizeXmm, featureSizeYmm, workWcs, bossLiftMm, activeTool, workZeroPlateMm, workZeroCfg, surfaceMeshPlan,
    meshHeightChangeMm, units, calibrating, calibrationRef.kind, calibrationRef.diameterMm, loadedProbe,
  ])
  const sceneFor = (setup: SceneSetup, run: boolean) => {
    const built = buildProbeScene({
      ...setup, toolZ: { tool: setup.toolZ?.tool ?? null, machine: toolZMachine }, everyPoint: run,
    })
    // WO-2267 (Operator 09-30: "it should probe ask you to apply it"): the Z
    // surface's last step is its result step and carries Confirm, as the
    // other routines' do. Nothing else about its steps changes.
    if (setup.routine !== 'zSurface' || built.steps.length === 0) return built
    return { ...built, steps: built.steps.map((step, i) => (i === built.steps.length - 1 ? { ...step, confirm: true } : step)) }
  }
  const planScene = useMemo(() => sceneFor(sceneSetup, false), [sceneSetup, toolZMachine]) // eslint-disable-line react-hooks/exhaustive-deps
  // WO-2139: the run the screen follows, where it ended and the step shown are
  // the session's, like the touches: Feed Hold and CYCLE START are on Main, so
  // the operator leaves this screen mid-run and must come back to the same run
  // - running, held, stopped or done with its result and Confirm.
  const [shownStep, setShownStep] = useProbingSessionState(machineId, 'shownStep', 0)
  const shownFor = useRef(workKind)
  useEffect(() => {
    if (shownFor.current === workKind) return
    shownFor.current = workKind
    setShownStep(0)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the session setters are re-created each render
  }, [workKind])
  const trackerRef = useProbingSessionRef<TrackerState | null>(machineId, 'tracker', null)
  const followingMotion = useProbingSessionRef(machineId, 'followingMotion', false)
  // The run being followed (a new object per Start probing), null when none.
  // It keeps the steps as they were at Start: the machine moving must not
  // re-plan the steps the screen is following (WO-2063, Operator 09-27: the
  // running probe jerked while every report rebuilt the plan).
  const [followRun, setFollowRun] = useProbingSessionState<{ at: number; scene: ProbeScene } | null>(machineId, 'followRun', null)
  // WO-2587: keep the drawing datum for a moved run, including after Stop
  // and screen reopening (WO-2139). Machine-only reports must not leave the
  // drawn depth stuck at the preceding work report. No tracker/plan change.
  const featureDatum = useProbingSessionRef<{ x: number; y: number; z: number } | null>(machineId, 'featureDatum', null)
  // Operator ruling 10-05: before Start the feature is not yet measured. Keep the
  // approved start-zone picture even when the reported tip appears in-frame.
  // followRun is latched by actual movement, and retained after Stop only.
  const reportedTip = followRun && connected && !followRun.scene.tool && wpos
    ? featureDatum.current && mpos
      ? { x: mpos.x - featureDatum.current.x, y: mpos.y - featureDatum.current.y, z: mpos.z - featureDatum.current.z }
      : wpos
    : null
  const scene = followRun?.scene ?? planScene
  const [runEnd, setRunEnd] = useProbingSessionState<'done' | 'stopped' | null>(machineId, 'runEnd', null)
  // WO-2113: why the last run stopped - its console line, word for word -
  // shown on the step card's "Stopped at step N" line.
  const [stoppedWhy, setStoppedWhy] = useProbingSessionState<string | null>(machineId, 'stoppedWhy', null)
  // WO-2664: a later Start refused before any motion replaces that reason
  // with its own ("Did not start") - the screen never shows two reasons.
  const [notStarted, setNotStarted] = useProbingSessionState<boolean>(machineId, 'notStarted', false)
  // A finished run - stopped, failed or done - keeps its picture until the
  // operator picks another routine or changes a setup field: then the picture
  // is the new plan's before-Start preview (audit, round 8: it stayed the old
  // routine's; review, round 9: after a success the new plan showed as done).
  // Keyed on the operator's own fields, not on sceneSetup: a Z surface success
  // re-arms the program its mesh points are planned from, and that must not
  // wipe the success it just showed.
  const operatorSetup = useMemo(() => [
    probingRoutine, probeCfg, tipMotionMm, plateMm, startDistanceMm, depthBelowTopMm, edgeAxis, edgeDirection,
    cornerXDirection, cornerYDirection, angleNominalAxis, angleProbeDirection, angleAlongDirection, angleSpacingMm,
    featureSizeXmm, featureSizeYmm, workWcs, bossLiftMm, activeTool, workZeroPlateMm, workZeroCfg,
    meshMarginMm, meshPointsX, meshPointsY, meshFadeMm, meshBoundsOverride, meshHeightChangeMm, units,
    calibrationRef.kind, calibrationRef.diameterMm, bossTopFromWorkZero,
  ], [
    probingRoutine, probeCfg, tipMotionMm, plateMm, startDistanceMm, depthBelowTopMm, edgeAxis, edgeDirection,
    cornerXDirection, cornerYDirection, angleNominalAxis, angleProbeDirection, angleAlongDirection, angleSpacingMm,
    featureSizeXmm, featureSizeYmm, workWcs, bossLiftMm, activeTool, workZeroPlateMm, workZeroCfg,
    meshMarginMm, meshPointsX, meshPointsY, meshFadeMm, meshBoundsOverride, meshHeightChangeMm, units,
    calibrationRef.kind, calibrationRef.diameterMm, bossTopFromWorkZero,
  ])
  // Compared by value (WO-2139): a return to the screen rebuilds the same
  // fields as new objects, and that is not a change.
  const setupAtRunEnd = useProbingSessionRef<string | null>(machineId, 'setupAtRunEnd', null)
  useEffect(() => {
    const setupKey = JSON.stringify(operatorSetup)
    const was = setupAtRunEnd.current
    setupAtRunEnd.current = setupKey
    if (was === null || was === setupKey) return
    if (busy) return
    setFollowRun(null)
    setRunEnd(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- the session setters are re-created each render
  }, [operatorSetup, busy])
  // Where the machine is on the plan, worked out as the frame renders from
  // the position it reports - never an effect that sets state per report:
  // on a long rapid (Tool Z's move to the setter, on the native kit, 09-27)
  // that chained one re-render per status push past React's nested-update
  // limit. The tracker only moves forward, so working it out twice for one
  // position gives the same answer.
  const live: LiveStepState | null = useMemo(() => {
    const was = trackerRef.current
    if (!followRun || !was) return null
    const next = busy && followingMotion.current && mpos ? trackPosition(scene, was, mpos) : was
    trackerRef.current = next
    return { step: next.step, move: next.move, t: next.t, touched: next.touched, stoppedAt: stoppedAt(scene, next) }
  }, [followRun, mpos, busy, scene, runEnd]) // eslint-disable-line react-hooks/exhaustive-deps
  const runState: 'idle' | 'running' | 'paused' | 'stopped' | 'done' = busy && followingMotion.current && live
    ? probePaused || machineState === 'hold' ? 'paused' : 'running'
    : runEnd ?? 'idle'
  const startProbing = async () => {
    if (busy) return
    const at = { ...(getMachineController().status().machinePos ?? mpos ?? { x: 0, y: 0, z: 0 }) }
    const workAtStart = useMachineControl.getState().wpos
    const resultsBefore = useProbingSession.getState().values
    followingMotion.current = false
    // The plan this Start runs - never a stopped run's picture - with a step
    // for every point it visits (Z surface).
    const runScene = sceneFor(sceneSetup, true)
    // XY belongs to the plan: anchor its start to the same machine position
    // startTracker receives. G54 XY may be nowhere near this feature. Z still
    // uses the work datum; only the solid probe's depth consumes this point.
    const datumAtStart = workAtStart
      ? { x: at.x - runScene.start.x, y: at.y - runScene.start.y, z: at.z - workAtStart.z }
      : null
    // WO-2557: Start is a request, not evidence of movement. Keep the
    // operator's preview (or retained run) until a position differs from the
    // start. Latch movement: a miss can move out and return here (WO-2258).
    const observePosition = (pos: typeof at) => {
      if (!followingMotion.current) {
        if (pos.x === at.x && pos.y === at.y && pos.z === at.z) return
        followingMotion.current = true
        featureDatum.current = datumAtStart
        trackerRef.current = startTracker(runScene, at)
        setFollowRun({ at: Date.now(), scene: runScene })
        setRunEnd(null)
        setNotStarted(false)
      }
      if (trackerRef.current) trackerRef.current = trackPosition(runScene, trackerRef.current, pos)
    }
    // WO-2139: followed from the machine's reports while the screen is closed
    // too (the operator on Main for Feed Hold), so it reopens on the step the
    // machine is on. Mounted, the frame's own tracking sees each report here
    // first and finds nothing new.
    const follow = useMachineControl.subscribe((state, previous) => {
      if (state.mpos === previous.mpos || !state.mpos) return
      observePosition(state.mpos)
    })
    try {
      await runGuidedCycle()
    } catch (error) {
      // WO-2664: a run that ends on a thrown error still says why.
      runOutcome.current = false
      setWorkStatus({ kind: 'error', text: error instanceof Error ? error.message : String(error) })
    } finally {
      follow()
    }
    if (runOutcome.current) {
      setRunEnd('done')
      const confirmIndex = planScene.steps.findIndex((s) => s.confirm)
      setShownStep(confirmIndex >= 0 ? confirmIndex : planScene.steps.length - 1)
      setFollowRun(null)
    } else {
      // WO-2113: the final controller readback can be newer than the screen.
      const restAt = getMachineController().status().machinePos ?? useMachineControl.getState().mpos
      if (restAt) observePosition(restAt)
      if (!followingMotion.current) {
        // The runner clears old measurements before asking to start. An
        // unsent request must also retain their picture/Confirm; keep only
        // the new console/status sentence and leave the screen state alone.
        useProbingSession.setState((s) => {
          if (s.machineId !== machineId) return s
          const values = { ...s.values }
          for (const key of ['workTouches', 'workTouchSetupId', 'meshSamples', 'zSetResult',
            'calibrationRun', 'calibrationAcross', 'calibrationNote', 'angleRunAlongMm', 'angleRunRotation']) {
            if (key in resultsBefore) values[key] = resultsBefore[key]
            else delete values[key]
          }
          return { values }
        })
        // WO-2664: a stopped run's reason on screen gives way to this one.
        const now = useProbingSession.getState()
        const refused = (now.machineId === machineId ? now.values.workStatus : null) as ProbeStatus | null | undefined
        if (now.machineId === machineId && now.values.runEnd === 'stopped' && refused?.kind === 'error') {
          setStoppedWhy(refused.text)
          setNotStarted(true)
        }
        return
      }
      // The status the run ended on, read from the session store: this
      // closure's workStatus is the one from before Start.
      const values = useProbingSession.getState().values
      const ended = (useProbingSession.getState().machineId === machineId ? values.workStatus : null) as ProbeStatus | null | undefined
      setStoppedWhy(ended?.kind === 'error' ? ended.text : null)
      setNotStarted(false)
      // Where the machine came to rest, as the controller reported it to the
      // run (its console line quotes it): the screen's position can trail it
      // (the simulator, 09-28: a miss drawn 0.165 mm short of its 10 mm).
      setRunEnd('stopped')
      setShownStep(trackerRef.current?.step ?? 0)
    }
  }

  // WO-2184: after a Z surface run, every point's measured height above point
  // 1 - the samples the run reported, when they cover this grid - so the dots
  // are drawn in their heights' colours and stay until the next run or a
  // change to the grid.
  const meshHeights = useMemo(() => {
    if (workKind !== 'zSurface' || busy || runEnd === 'stopped' || !surfaceMeshPlan.ok) return null
    const byCell = new Map(meshSamples.map((s) => [`${s.row}:${s.column}`, s]))
    const hits = surfaceMeshPlan.points.map((p) => {
      const s = byCell.get(`${p.row}:${p.column}`)
      return s && Math.abs(s.x - p.x) < 1e-6 && Math.abs(s.y - p.y) < 1e-6 && Number.isFinite(s.machineZ) ? s.machineZ : null
    })
    if (hits.length === 0 || hits.some((z) => z === null)) return null
    const zs = hits as number[]
    return zs.map((z) => z - zs[0])
  }, [workKind, busy, runEnd, surfaceMeshPlan, meshSamples])
  const heightText = (mm: number, signed: boolean) => {
    // The mesh picture's legend keeps main's format (WO-2474: pictures unchanged).
    const v = units === 'inch' ? (mm / 25.4).toFixed(4) : mm.toFixed(3)
    return `${signed && mm >= 0 ? '+' : ''}${v} ${units === 'inch' ? 'in' : 'mm'}`
  }
  const shownIndex = Math.min(shownStep, Math.max(0, scene.steps.length - 1))
  const shownSceneStep = scene.steps[runState === 'running' || runState === 'paused' ? Math.min(live?.step ?? 0, scene.steps.length - 1) : shownIndex]
  const startBlocked = !canAct || runGuidedPlanBlocked
  const estopGate = authorize('estop', { connected })
  const stopGate = authorize('stopReset', { connected })
  const sensingText = (s: ProbeSensing) => (s === 'plate' ? `Plate held against it (${fmtMachineLength(probeCfg.padThickness, units)} ${unitLabel(units)})` : 'Probe touches part')
  const row = (label: string, control: ReactNode, testId?: string, source?: string) => (
    <div className="pbn-setup-row" data-testid={testId} key={testId ?? label}>
      <span data-tooltip={source}>{label}</span>
      {control}
    </div>
  )
  const dimCell = (valueMm: number, testId: string, commit: (text: string) => boolean) => (
    <NumCell shown={fmtMachineLength(valueMm, units)} editable={canEdit} testId={testId} onCommit={commit} />
  )
  // "Start within" is used only by the routines that approach a face from
  // above it; "Probing depth" is used by every feature routine (the hole and
  // boss routines descend to it too), so it shows wherever sideRoutine does.
  const fromTopRoutine = workKind === 'edge' || workKind === 'outsideCorner' || workKind === 'angle'
  // WO-2108: the routines whose first move touches the top where the probe stands.
  // WO-2266: Boss and Rect boss choose it (Top); on work Z0 they search for no top.
  const bossRoutine = workKind === 'boss' || workKind === 'rectBoss'
  const topTouchRoutine = fromTopRoutine || (bossRoutine && !bossTopFromWorkZero)
    || (calibrating && calibrationRef.kind === 'outside')
  const sideRoutine = workKind !== 'zSurface' && workKind !== 'toolZ' && workKind !== 'workZero'
  const holeRoutine = workKind === 'bore' || workKind === 'rectPocket' || workKind === 'insideCorner'
    || (calibrating && calibrationRef.kind === 'inside')
  const topSource: 'touch' | 'workZero' = guidedPlan.ok
    ? (guidedPlan.plan.fromTop?.topTouch ? 'touch' : 'workZero')
    : (holeRoutine || bossTopFromWorkZero ? 'workZero' : 'touch')
  const faceValue = `${edgeAxis}${edgeDirection}`
  const cornerValue = `${cornerXDirection}${cornerYDirection}`
  const cornerChoices: Array<[string, string]> = insideCornerKind
    ? [['--', 'front-left'], ['+-', 'front-right'], ['-+', 'back-left'], ['++', 'back-right']]
    : [['++', 'front-left'], ['-+', 'front-right'], ['+-', 'back-left'], ['--', 'back-right']]
  const angleFaceValue = `${angleNominalAxis}${angleProbeDirection}`
  const setupTitle = `${ROUTINE_OPTIONS.find((o) => o.kind === workKind)?.label ?? workKind} setup`

  const confirmNode = (
    <div
      className={workKind === 'angle' ? 'pbn-confirm pbn-confirm-angle' : 'pbn-confirm'}
      data-testid="control-work-probe-result"
      // WO-2267 (architect picture check 10-01): the Z surface's row already
      // holds the sentence and the height legend; a Confirm beside them
      // squeezed the sentence to a narrow column at 1440 x 900. This node takes
      // no width (the -16 px cancels the row's gap) and its Confirm hangs just
      // below the sentence's end, so the sentence wraps exactly as main's.
      style={workKind === 'zSurface' ? { position: 'relative', alignSelf: 'stretch', width: 0, marginLeft: -16 } : undefined}
    >
      {secondSideZero && !secondSideZero.ok
        ? <span data-testid="control-second-side-refusal">{secondSideZero.message}</span>
        : calibrating
          ? (
              <>
                <div className="pbn-confirm-working" data-testid="control-calibrate-result">
                  {calibrationResult
                    ? (
                        <>
                          <span data-testid="control-calibrate-radii">
                            Radius X {fmtMachineLength(calibrationResult.radiusXmm, units)}, Y {fmtMachineLength(calibrationResult.radiusYmm, units)} {unitLabel(units)}
                          </span>
                          <span data-testid="control-calibrate-ball">
                            Ball radius {fmtMachineLength(loadedProbe ? loadedProbe.diameter / 2 : tipRadiusMm, units)} {unitLabel(units)}
                            {loadedProbe ? ` (T${activeTool} diameter / 2)` : ' (the tip radius on the left)'}
                          </span>
                        </>
                      )
                    : <span>No result yet - run the routine first.</span>}
                  {calibrationNote && <span data-testid="control-calibrate-note">{calibrationNote}</span>}
                </div>
                <button
                  type="button"
                  className="modal-btn modal-btn-primary"
                  data-testid="control-work-probe-apply"
                  disabled={!calibrationResult || busy}
                  data-tooltip={loadedProbe ? `Write the X and Y radius to T${activeTool} ${loadedProbe.name}` : undefined}
                  onClick={applyCalibration}
                >
                  Confirm
                </button>
              </>
            )
        : workKind === 'angle'
          ? (
              <>
                <div className="pbn-confirm-working" data-testid="control-work-probe-angle-result">
                  <span data-testid="control-work-probe-angle-measured">{workPreview ? workPreview.resultText : 'No result yet - run the routine first.'}</span>
                  {angleRotationSet && <span data-testid="control-work-probe-angle-tap">{angleRotationSet.tapText}</span>}
                </div>
                {angleRotationSet && angleDegWords(angleRotationSet.toDeg - angleRotationSet.fromDeg) !== '0' && (
                  <button
                    type="button"
                    className="modal-btn modal-btn-primary"
                    data-testid="control-work-probe-apply"
                    disabled={!canAct || angleRotating}
                    data-tooltip={`Set ${angleRotationSet.wcs}'s rotation in the controller to ${angleDegWords(angleRotationSet.toDeg)} deg`
                      + ` (it holds ${angleDegWords(angleRotationSet.fromDeg)} deg now), so work ${angleNominalAxis} runs along this face. It stays until cleared.`}
                    onClick={() => { void applyAngleRotation() }}
                  >
                    Rotate {angleRotationSet.wcs} by {angleDegWords(angleRotationSet.toDeg - angleRotationSet.fromDeg)} deg
                  </button>
                )}
              </>
            )
          : workKind === 'zSurface'
            // WO-2267: the run measured the mesh; Confirm applies it to the
            // work system it was probed in. Until then nothing is compensated.
            // The existing viewer reads the measured mesh even before it is
            // applied; opening it changes neither the result nor compensation.
            ? (
              <div style={{ position: 'absolute', top: '100%', right: 0, marginTop: 6, display: 'flex', gap: 6 }}>
                {visibleSurfaceMesh && (
                  <button
                    type="button"
                    className="modal-btn modal-btn-ghost"
                    data-testid="control-surface-mesh-show"
                    onClick={() => useCamStore.getState().openModal('mesh-viewer')}
                  >
                    Show surface
                  </button>
                )}
                <button
                  type="button"
                  className="modal-btn modal-btn-primary"
                  data-testid="control-work-probe-apply"
                  disabled={!visibleSurfaceMesh || visibleSurfaceMesh.active || !canAct}
                  data-tooltip={!visibleSurfaceMesh
                    ? 'No result yet - run the routine first.'
                    : visibleSurfaceMesh.active
                      ? `Mesh ${visibleSurfaceMesh.pointsX} x ${visibleSurfaceMesh.pointsY} applied to ${visibleSurfaceMesh.workOffset} - compensation is active. Clear it from the strip.`
                      : `Apply the measured ${visibleSurfaceMesh.pointsX} x ${visibleSurfaceMesh.pointsY} mesh to ${visibleSurfaceMesh.workOffset}: the loaded program runs compensated until Clear or a re-zero of ${visibleSurfaceMesh.workOffset}.`}
                  onClick={() => {
                    const applied = applySurfaceMesh()
                    setWorkStatus({ kind: applied.ok ? 'ok' : 'error', text: applied.message })
                  }}
                >
                  Confirm
                </button>
              </div>
              )
          : workKind === 'workZero' || workKind === 'toolZ'
            // WO-2123 (Operator, 09-28): Z0 and Tool Z write at once - no Confirm;
            // their last step shows the number they set.
            ? <span data-testid="control-work-probe-z-set">{zSetResult?.routine === workKind ? zSetResult.text : 'No result yet - run the routine first.'}</span>
          : (
              <>
                {confirmPreview?.secondSide
                  // WO-2122 (Operator, 09-28): on a second side the step shows the
                  // working and exactly what Confirm writes - the same values.
                  ? <SecondSideWorking preview={confirmPreview} wcs={workWcs} units={units} />
                  :<span>{confirmPreview ? confirmPreview.resultText : 'No result yet - run the routine first.'}</span>}
                <button
                  type="button"
                  className="modal-btn modal-btn-primary"
                  data-testid="control-work-probe-apply"
                  disabled={!confirmPreview || !canAct || Object.keys(confirmPreview.values).length === 0}
                  data-tooltip={confirmPreview ? `Write ${workWcs}: ${confirmPreview.compensation}` : undefined}
                  onClick={applyWorkPreview}
                >
                  Confirm
                </button>
              </>
            )}
    </div>
  )

  return (
    <div className="pbn-screen" data-testid="control-probing-panel">
      <div className="pbn-col pbn-col-left control-col-scroll" data-testid="control-probing-left">
        {/* Main's own Position panel (WO-2062 extraction); WORK stays live before homing here. */}
        <PositionPanel workLiveRegardlessOfHoming />
        <section className="panel control-panel" data-testid="control-probe-routine-bar">
          <div className="panel-header">
            <span className="panel-title">Routine</span>
            <ProbeLamp kind="probe" value={probeSignals.probe} testId="probing-lamp-probe" />
          </div>
          <div className="panel-body">
            <div className="pbn-routines" aria-label="Workpiece probe routine">
              {ROUTINE_OPTIONS.map(({ kind, label }) => (
                <button
                  key={kind}
                  type="button"
                  className={`pbn-routine control-probe-routine-tile ${workKind === kind ? 'control-chip-active' : ''}`}
                  data-testid={`control-work-probe-routine-${kind}`}
                  disabled={busy}
                  onClick={() => {
                    setWorkKind(kind)
                    resetWorkTouches()
                    setRunEnd(null)
                    setFollowRun(null)
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>
        </section>
        <section className="panel control-panel pbn-setup" data-testid="control-probe-setup-card">
          <div className="panel-header"><span className="panel-title">{setupTitle}<HelpLink topic="probing-tab" testId="control-probe-help-setup" /></span></div>
          <div className="panel-body pbn-setup-rows">
            {secondSidePlan && secondSide && (
              <>
                <div className="pbn-setup-note" data-testid="control-second-side-statement">
                  {secondSideStatement(secondSide.setup.name, secondSidePlan.parentSetupName, secondSidePlan.axis)}
                </div>
                {referenceAxes.map((axis) => row(
                  `Feature ${axis} on ${secondSidePlan.parentSetupName}`,
                  <NumCell
                    shown={featureFirstSideMm[axis] === undefined ? '' : fmtMachineLength(featureFirstSideMm[axis]!, units)}
                    editable={canEdit}
                    placeholder="-"
                    testId={`control-second-side-feature-${axis}`}
                    onCommit={(text) => commitDim(text, (mm) => setFeatureFirstSide((current) => ({
                      setupId: activeSetupId,
                      values: { ...(current.setupId === activeSetupId ? current.values : {}), [axis]: mm },
                    })))}
                  />,
                  `control-second-side-row-${axis}`,
                ))}
              </>
            )}
            {secondSideBlocked && <div className="pbn-setup-note" data-testid="control-second-side-blocked">{secondSideBlocked}</div>}
            {workKind === 'edge' && row('Face', (
              <select className="mform-input" data-testid="control-work-probe-edge-face" value={faceValue} disabled={busy}
                onChange={(event) => {
                  const face = asWorkProbeFace(event.target.value)
                  if (face === null) return
                  setEdgeAxis(face[0])
                  setEdgeDirection(face[1])
                  resetWorkTouches()
                }}>
                <option value="X+">X left (X+)</option>
                <option value="X-">X right (X-)</option>
                <option value="Y+">Y front (Y+)</option>
                <option value="Y-">Y back (Y-)</option>
              </select>
            ))}
            {(workKind === 'insideCorner' || workKind === 'outsideCorner') && row('Corner', (
              <select className="mform-input" data-testid="control-work-probe-corner" value={cornerValue} disabled={busy}
                onChange={(event) => {
                  const v = event.target.value
                  setCornerXDirection(v[0] as WorkProbeDirection)
                  setCornerYDirection(v[1] as WorkProbeDirection)
                  resetWorkTouches()
                }}>
                {cornerChoices.map(([value, words]) => <option key={value} value={value}>{words}</option>)}
              </select>
            ))}
            {workKind === 'angle' && row('Face', (
              <select className="mform-input" data-testid="control-work-probe-angle-face" value={angleFaceValue} disabled={busy}
                onChange={(event) => {
                  const face = asWorkProbeFace(event.target.value)
                  if (face === null) return
                  setAngleNominalAxis(face[0])
                  setAngleProbeDirection(face[1])
                  resetWorkTouches()
                }}>
                {ANGLE_FACES.map((f) => <option key={f.value} value={f.value}>{`${f.face} (probe ${f.probe})`}</option>)}
              </select>
            ))}
            {workKind === 'angle' && row('Point 2', (
              <select className="mform-input" data-testid="control-work-probe-angle-along-direction" value={angleAlongDirection} disabled={busy}
                onChange={(event) => { setAngleAlongDirection(event.target.value as WorkProbeDirection); resetWorkTouches() }}>
                <option value="+">{angleNominalAxis}+ of point 1</option>
                <option value="-">{angleNominalAxis}- of point 1</option>
              </select>
            ))}
            {workKind === 'angle' && row(`Spacing (${unitLabel(units)})`, dimCell(angleSpacingMm, 'control-work-probe-angle-spacing', (text) => commitPositiveDim(text, setAngleSpacingMm)))}
            {calibrating && row('Reference', (
              <select className="mform-input" data-testid="control-calibrate-reference" value={calibrationRef.id} disabled={busy}
                onChange={(event) => { selectCalibrationReference(machineId, event.target.value); resetWorkTouches() }}>
                {calibrationRefs.list.map((ref) => <option key={ref.id} value={ref.id}>{ref.name}</option>)}
              </select>
            ))}
            {calibrating && row('Name', (
              <input className="mform-input" data-testid="control-calibrate-reference-name" value={calibrationRef.name} disabled={busy}
                onChange={(event) => editCalibrationReference(machineId, calibrationRef.id, { name: event.target.value })} />
            ))}
            {calibrating && row('Kind', (
              <select className="mform-input" data-testid="control-calibrate-reference-kind" value={calibrationRef.kind} disabled={busy}
                onChange={(event) => {
                  editCalibrationReference(machineId, calibrationRef.id, { kind: event.target.value as CalibrationReferenceKind })
                  resetWorkTouches()
                }}>
                <option value="outside">Outside (pin, boss)</option>
                <option value="inside">Inside (ring, bore)</option>
              </select>
            ))}
            {calibrating && row(`Diameter (${unitLabel(units)})`, dimCell(calibrationRef.diameterMm, 'control-calibrate-reference-diameter', (text) => commitPositiveDim(text, (mm) => {
              editCalibrationReference(machineId, calibrationRef.id, { diameterMm: mm })
              resetWorkTouches()
            })))}
            {calibrating && (
              <div className="pbn-setup-row" key="calibrate-actions">
                <button className="modal-btn modal-btn-ghost" type="button" data-testid="control-calibrate-reference-add" disabled={busy}
                  onClick={() => { addCalibrationReference(machineId, calibrationRef); resetWorkTouches() }}>
                  Add reference
                </button>
                {calibrationRefs.list.length > 1
                  ? <button className="modal-btn modal-btn-ghost" type="button" data-testid="control-calibrate-reference-remove" disabled={busy}
                      onClick={() => { removeCalibrationReference(machineId, calibrationRef.id); resetWorkTouches() }}>Remove</button>
                  : <span />}
              </div>
            )}
            {(workKind === 'bore' || workKind === 'boss') && row(`Nominal diameter (${unitLabel(units)})`, dimCell(nominalDiameterMm, 'control-work-probe-nominal-diameter', (text) => commitPositiveDim(text, setNominalDiameterMm)))}
            {(workKind === 'rectPocket' || workKind === 'rectBoss') && row(`Width X (${unitLabel(units)})`, dimCell(rectSizeXmm, 'control-work-probe-nominal-x', (text) => commitPositiveDim(text, setRectSizeXmm)))}
            {(workKind === 'rectPocket' || workKind === 'rectBoss') && row(`Width Y (${unitLabel(units)})`, dimCell(nominalSizeYmm, 'control-work-probe-nominal-y', (text) => commitPositiveDim(text, setNominalSizeYmm)))}
            {/* The Bore video's setup: where the routine's top comes from - a
                hole's is work Z0 (WO-2057); the others touch it first (the
                plan's own top touch). One source: the plan Start probing runs.
                WO-2266: Boss and Rect boss choose between the two. */}
            {sideRoutine && row('Top', bossRoutine
              ? (
                  <select className="mform-input" data-testid="control-work-probe-top" value={topSource} disabled={busy}
                    onChange={(event) => setBossTop(event.target.value as 'touch' | 'workZero')}>
                    <option value="touch">Touch it first</option>
                    <option value="workZero">Use work Z0</option>
                  </select>
                )
              : (
                  <select className="mform-input" data-testid="control-work-probe-top" value={topSource} disabled={busy} onChange={() => {}}>
                    <option value={topSource}>{topSource === 'touch' ? 'Touch it first' : 'Use work Z0'}</option>
                  </select>
                ))}
            {/* WO-2108: how far that first touch searches down - the routines
                that touch the top (not a hole's, whose top is work Z0). */}
            {topTouchRoutine && row(`Search down for the top, up to (${unitLabel(units)})`, (
              <NumCell
                shown={fmtMachineLength(Math.min(topSearchMm, probeCfg.maxTravel), units)}
                min={1}
                max={probeCfg.maxTravel}
                editable={canEdit}
                ariaLabel="Search down for the top, up to"
                tooltip={`Search down for the top, up to: ${fmtMachineLength(1, units)} to ${fmtMachineLength(probeCfg.maxTravel, units)} ${unitLabel(units)}`}
                onCommit={(text) => {
                  // Reuse the existing canonical parser/range; only the display
                  // changes. Compare raw values so a finer edit is retained.
                  const current = Math.min(topSearchMm, probeCfg.maxTravel)
                  const raw = resolveNumericDraft(text, current, undefined, undefined, units)
                  const result = resolveNumericDraft(text, current, 1, probeCfg.maxTravel, units)
                  if (!result.committed) return false
                  if (result.value !== current) setTopSearchMm(result.value)
                  if (raw.value !== result.value && fmtMachineLength(raw.value, units) !== fmtMachineLength(result.value, units)) {
                    const verb = raw.value < 1 ? 'below' : 'above'
                    useCamStore.getState().addConsoleEvent({ severity: 'warning', source: 'input',
                      message: `Search down for the top, up to: ${fmtMachineLength(raw.value, units)} is ${verb} ${fmtMachineLength(result.value, units)} ${unitLabel(units)} - set to ${fmtMachineLength(result.value, units)} ${unitLabel(units)}` })
                  }
                  return false // reset the draft even when both round alike
                }}
              />
            ), 'control-work-probe-top-search')}
            {sensingRoutine && row(workKind === 'zSurface' ? 'Point 1 sensed by' : workKind === 'workZero' ? 'Z0 sensed by' : 'Sensed by', (
              <select className="mform-input" data-testid="control-work-probe-sensing" value={sensing} disabled={busy}
                onChange={(event) => setProbeSensing(machineId, sensingRoutine, event.target.value as ProbeSensing)}>
                <option value="probe">{sensingText('probe')}</option>
                <option value="plate">{sensingText('plate')}</option>
              </select>
            ))}
            {sensingRoutine && workKind !== 'workZero' && sensing === 'plate' && row(`Plate (${unitLabel(units)})`, dimCell(probeCfg.padThickness, 'control-work-probe-plate-thickness', (text) => commitNonNegativeDim(text, (mm) => {
              probeStore.getState().setProbeConfig(machineId, { padThickness: mm })
              saveToolRecord()
            })))}
            {sideRoutine && row(`Probing depth (${unitLabel(units)})`, dimCell(depthBelowTopMm, 'control-work-probe-depth', (text) => commitPositiveDim(text, setDepthBelowTopMm)))}
            {sideRoutine && row(`Clearance (${unitLabel(units)})`, dimCell(probeCfg.surfaceClearance, 'control-work-probe-face-distance', (text) => commitPositiveDim(text, (value) => {
              probeStore.getState().setProbeConfig(machineId, { surfaceClearance: value })
              saveToolRecord()
            })))}
            {fromTopRoutine && row(`Start within (${unitLabel(units)})`, dimCell(startDistanceMm, 'control-work-probe-start-within', (text) => commitPositiveDim(text, setStartDistanceMm)))}
            {sideRoutine && row(`Tip radius${activeTool !== null && tipRadiusSource && !tipRadiusSource.startsWith('the default') ? ` (T${activeTool})` : ''} (${unitLabel(units)})`, (
              <NumCell
                shown={fmtMachineLength(tipRadiusMm, units)}
                editable={canEdit}
                testId="control-work-probe-tip-radius"
                onCommit={(text) => {
                  const mm = parseDimToMm(text, units)
                  if (!Number.isFinite(mm) || mm < 0) return false
                  setTipRadiusTyped(true)
                  setTipRadiusSource(null)
                  setTipRadiusMm(mm)
                  return true
                }}
              />
            ), undefined, tipRadiusTyped ? 'Tip radius typed on this screen' : (calibratedSource ?? tipRadiusSource) === null ? undefined : `Tip radius from ${calibratedSource ?? tipRadiusSource}`)}
            {sideRoutine && askToolDiameter && row(`T${activeTool} diameter (${unitLabel(units)})`, (
              <NumCell
                shown=""
                editable={canEdit}
                testId="control-work-probe-tool-diameter"
                onCommit={(text) => {
                  const mm = parseDimToMm(text, units)
                  if (!Number.isFinite(mm) || mm <= 0 || activeTool === null) return false
                  probeStore.getState().addTool(machineId, activeTool)
                  probeStore.getState().updateTool(machineId, activeTool, { dia: mm })
                  saveToolRecord()
                  return true
                }}
              />
            ))}
            {sideRoutine && workKind !== 'angle' && !calibrating && row('Work offset', (
              <select className="mform-input" data-testid="control-work-probe-wcs" value={workWcs} disabled={busy}
                onChange={(event) => setWorkWcs(event.target.value as WcsId)}>
                {WCS_LIST.map((wcs) => <option key={wcs}>{wcs}</option>)}
              </select>
            ))}
            {workKind === 'workZero' && probePads.length > 1 && row('Pad choice', (
              <select className="mform-input" data-testid="control-work-probe-z0-pad-select" value={activeProbePadId} disabled={!canEdit}
                onChange={(event) => { probeStore.getState().selectProbePad(machineId, event.target.value); saveToolRecord() }}>
                {probePads.map((pad, index) => (
                  <option key={pad.id} value={pad.id}>Pad {index + 1} - {fmtMachineLength(pad.thickness, units)} {unitLabel(units)}</option>
                ))}
              </select>
            ))}
            {workKind === 'workZero' && workZeroSensing === 'plate' && row(`Plate (${unitLabel(units)})`, dimCell(workZeroCfg.padThickness, 'control-work-probe-z0-pad', (text) => {
              const mm = parseDimToMm(text, units)
              if (!Number.isFinite(mm)) return false
              probeStore.getState().setProbeConfig(machineId, { padThickness: mm })
              saveToolRecord()
              return true
            }))}
            {workKind === 'workZero' && row(`Clearance (${unitLabel(units)})`, dimCell(workZeroCfg.surfaceClearance, 'control-work-probe-z0-clearance', (text) => commitPositiveDim(text, (value) => {
              probeStore.getState().setProbeConfig(machineId, { surfaceClearance: value })
              saveToolRecord()
            })))}
            {workKind === 'workZero' && row('Work offset', <span data-testid="control-probing-target-wcs">{activeWcs ?? 'the active one'}</span>)}
            {workKind === 'workZero' && <WorkZeroInUse machineId={machineId} wcs={activeWcs} />}
            {workKind === 'zSurface' && !surfaceMeshPlan.ok && <div className="pbn-setup-note" data-testid="control-surface-mesh-plan-error">{surfaceMeshPlan.reason}</div>}
            {workKind === 'zSurface' && surfaceMeshPlan.ok && [
              row(`Margin (${unitLabel(units)})`, dimCell(meshMarginMm, 'control-surface-mesh-margin', (text) => commitNonNegativeDim(text, (value) => {
                setMeshMarginMm(value)
                setMeshBoundsOverride(null)
              }))),
              row(`Fade to flat (${unitLabel(units)})`, dimCell(meshFadeMm, 'control-surface-mesh-fade', (text) => commitPositiveDim(text, setMeshFadeMm))),
              row(`Largest height change (${unitLabel(units)})`, dimCell(meshHeightChangeMm, 'control-surface-mesh-height-change', (text) => commitNonNegativeDim(text, setMeshHeightChangeMm))),
              row(`Clearance (${unitLabel(units)})`, dimCell(probeCfg.surfaceClearance, 'control-work-probe-face-distance', (text) => commitPositiveDim(text, (value) => {
                probeStore.getState().setProbeConfig(machineId, { surfaceClearance: value })
                saveToolRecord()
              }))),
              row('Points X', <NumCell shown={String(meshPointsX)} editable={canEdit} testId="control-surface-mesh-points-x" onCommit={(text) => commitMeshCount(text, setMeshPointsX)} />),
              row('Points Y', <NumCell shown={String(meshPointsY)} editable={canEdit} testId="control-surface-mesh-points-y" onCommit={(text) => commitMeshCount(text, setMeshPointsY)} />),
              ...(['minX', 'maxX', 'minY', 'maxY'] as const).map((key) => row(
                `${key === 'minX' ? 'Min X' : key === 'maxX' ? 'Max X' : key === 'minY' ? 'Min Y' : 'Max Y'} (${unitLabel(units)})`,
                dimCell(surfaceMeshPlan.setup.bounds[key], `control-surface-mesh-${key.toLowerCase()}`, (text) => commitDim(text, (value) => updateMeshBound(key, value))),
                `control-surface-mesh-row-${key}`,
              )),
              <div className="pbn-setup-row" key="mesh-actions">
                <button className="modal-btn modal-btn-ghost" type="button" data-testid="control-surface-mesh-reset-bounds"
                  disabled={!canEdit || meshBoundsOverride === null} onClick={() => setMeshBoundsOverride(null)}>
                  Reset to cutting area
                </button>
                {/* WO-2283: an applied mesh belongs to its work system, whatever program is loaded. */}
                {activeSurfaceMesh?.active
                  ? <button className="modal-btn modal-btn-danger" type="button" data-testid="control-surface-mesh-disable"
                      disabled={!canEdit || streaming} onClick={disableSurfaceMesh}>Disable compensation</button>
                  : <span />}
              </div>,
            ]}
            {workKind === 'toolZ' && setterChoices.length > 1 && row('Tool setter routine', (
              <select className="mform-input" data-testid="control-probe-setter-routine-select" value={chosenSetterRoutine.id} disabled={busy}
                onChange={(event) => setSetterRoutineId(event.target.value)}>
                {setterChoices.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            ))}
            {workKind === 'toolZ' && row('Records', <span data-testid="control-probing-target-wcs">{activeTool === null ? 'the active tool length' : `T${activeTool}`}</span>)}
            {workKind === 'toolZ' && toolSetter && row('Setter at', <span>{formatPosition({ machine: toolSetter, axes: ['x', 'y'], format: v => `${fmtMachineLength(v, units)} ${unitLabel(units)}` })}</span>)}
          </div>
        </section>
      </div>

      <StepCard
        scene={runEnd === 'done' && workKind === 'angle'
          ? withMeasuredAngle(scene, workPreview?.angleDeg ?? null)
          : workKind === 'zSurface' ? withMeshResultSentence(withMeshHeights(scene, meshHeights, heightText), visibleSurfaceMesh) : scene}
        shown={shownIndex}
        onShow={(i) => { setShownStep(i); setRunEnd(null) }}
        live={live}
        // WO-2587: plan-anchored XY decides whether the tip is in-frame;
        // work Z supplies depth. Tool Z uses a separate schematic setter trip.
        reportedTip={reportedTip}
        runState={runState}
        stoppedWhy={runState === 'stopped' ? stoppedWhy : null}
        notStarted={runState === 'stopped' && notStarted}
        confirm={confirmNode}
        refusal={!zRoutine && !guidedPlan.ok ? guidedPlan.reason : null}
      />

      <div className="pbn-col pbn-col-right control-col-scroll" data-testid="control-probing-right">
        <JogPanel />
        <KeyAndMore more={shownSceneStep?.more ?? []} />
        <section className="panel control-panel pbn-controls" data-testid="control-probe-command-cluster">
          <EstopControl testId="control-estop" className="pbn-estop" disabled={estopGate.disabled} />
          <div className="pbn-controls-row">
            <button
              type="button"
              className="modal-btn modal-btn-primary pbn-start"
              data-testid="control-probe-run-guided"
              style={{ gridColumn: '1 / -1' }}
              disabled={startBlocked}
              data-tooltip={runGuidedWhyDisabled ?? `Run ${ROUTINE_OPTIONS.find((o) => o.kind === workKind)?.label ?? workKind}`}
              onClick={() => void startProbing()}
            >
              Start probing
            </button>
            <button type="button" className="modal-btn modal-btn-ghost pbn-start" data-testid="control-probe-pause"
              disabled={!probeActive || stopGate.disabled}
              onClick={() => { if (probePaused) resumeProbing(); else pauseProbing() }}>
              {probePaused ? 'Resume' : 'Pause'}
            </button>
            <button
              type="button"
              className="control-btn-stop control-safety-btn pbn-stop"
              data-testid="control-probe-stop"
              disabled={stopGate.disabled}
              data-tooltip={stopGate.refusal ?? PROBE_STOP_TOOLTIP}
              onClick={() => { stopProbing() }}
            >
              Stop
            </button>
          </div>
        </section>
      </div>
    </div>
  )
}
