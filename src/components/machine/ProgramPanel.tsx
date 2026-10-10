// ProgramPanel - load, stream, and WATCH a g-code program.
//
// LAYOUT LAW (Operator 2026-07-31, HARD): the path VISUALIZATION is first-class -
// it owns the panel. Everything else is compact chrome around it or a
// transient overlay ON it:
//   [ compact controls row: source / recent / file / skipped / run-from / view toggles ]
//   [ PREVIEW (dominant)                          | line-list rail   ]
//   [ mode + utility bar / progress (motion lives in the global bar) ]
// Transient state (run-from plan, tool-change hold, job error) renders as
// overlay cards on the preview - they never resize it.
// WO-115: the PROGRAM header strip (title + lint status + Info/Lines) is gone;
// its load-bearing facts (file name, skipped count) and the Info/Lines view
// toggles moved into the controls row below, so the panel starts at preview.

import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type CSSProperties,
} from 'react'
import { ChevronDown, ChevronUp, FileUp, FolderGit2, Scan } from 'lucide-react'
import { useText } from '../../i18n'
import { GcodeEditor, type GcodeEditorJump, type GcodeEditorToolRequest } from '../gcode/GcodeEditor'
import { GcodeLineMenu, type GcodeLineMenuItem } from '../gcode/GcodeLineMenu'
import { lineChanges, markFromRefusal, readerMarks, withLineEndingsOf, type GcodeLineMark } from '../gcode/gcodeEditing'
import { describeEdit, programContextForEdit, subscribeProgramForControl, takeProgramForControl } from '../gcode/editedProgram'
import { saveFile } from '../../lib/saveFile'
import { controlMachine, useCamStore } from '../../store'
import {
  executingProgramMoveId,
  executingProgramMoveShown,
  isListedStep,
  listedStepCount,
  useMachineControl,
} from '../../store/machineControlStore'
import {
  applyToolLengthOffset,
  armEpoch,
  armProgramFromLine,
  beginClampPause,
  beginGuidedToolChange,
  cancelGuidedToolChangeByOperator,
  programM0HoldLine,
  programPartsTransportState,
  programToolChangeCanStop,
  cancelMaterialFitTrace,
  combinedSetupProgramActive,
  continueClampPause,
  continueGuidedToolChange,
  continueGuidedToolChangeAfterRetry,
  guidedToolMeasureState,
  lastToolLengthWorkOffsetWrite,
  retryGuidedToolMeasure,
  controllerCanRunToolpathProgram,
  controllerCapabilities,
  controllerNeedsToolpathProgram,
  ESTOP_BLOCKS_MOTION,
  estopNeedsReset,
  getMachineController,
  loadGcodeFile,
  loadedProgramRunsThroughOffsetChanges,
  loadedProgramText,
  loadSetupToolpathProgram,
  loadSetupsToolpathProgram,
  noHomeSwitchesRefusal,
  operatorStopState,
  pausedProgramReadout,
  prepareMaterialFitTrace,
  referenceToolMeasuredIn,
  runFromReview,
  subscribeArmEpoch,
  subscribeEstopNeedsReset,
  subscribeOperatorStop,
  subscribeRunFromReview,
  stagedProgramContext,
  restageLoadedProgram,
  standaloneMdiJob,
  textProgramHoldLine,
  textToolChangeResumeLine,
  textM6WasAnswered,
} from '../../lib/machine/machineSession'
import { machineHasNoHomeSwitches, type Project, type Tool } from '../../types'
import { defaultTraceFeed } from '../../lib/machine/materialFit'
import { isSendableGcodeLine } from '../../lib/gcode/text'
import { fmtMachineLength, unitLabel, type Units } from '../../lib/ui/unitFormat'
import { useDisplayUnits } from './useDisplayUnits'
import { ProbeLamp, useProbeSignals } from './ProbeLamp'
import { parkCarrierMachine, useMachineActions } from '../../store/machineActionsStore'
import { machineParkList, machineSafeZValue, toolChangeMacroPark, toolChangePark } from '../../lib/machine/machineActions'
import { saveMachineToolRecord, useMachineToolTable } from '../../store/machineToolTableStore'
import {
  EMPTY_TOOL_TABLE,
  findTool,
  resolveProbeConfig,
  toolOffsetLine,
} from '../../lib/machine/toolTable'
import type { ToolChangeStep } from '../../store/machineControlStore'
import type { RunFromLinePlan } from '../../lib/machine/runFromLine'
import {
  listPrograms,
  readProgram,
  saveProgram,
  type RecentProgramMeta,
} from '../../lib/machine/programLibrary'
import { setupEnabledCutTimeMs } from '../../lib/cam/operationSuppression'
import { machineCutTimeMotion } from '../../lib/simulation/machineCutTimeMotion'
import { stagedProgramRunEstimate, textProgramRunEstimate } from '../../lib/machine/programRunEstimate'
import { lintGcode, type LintFinding } from '../../lib/gcode'
import {
  GRBL_CONFIG,
  importProgramContextFromGcode,
  postProject,
} from '../../lib/post'
import { resolveDeclaredController } from '../../lib/machine/machineChoice'
import {
  buildProgramContext,
  compareProgramContext,
  computeMotionDigest,
  deriveOperationProgress,
  isMultiSetupProgramContext,
  operationKindLabel,
  programContextSetupChipLabel,
  programContextSetups,
  programIntentIdentity,
  type OperationProgressState,
  type OperationProgressStatus,
  type ProgramContextV1,
  type ProgramContextComparison,
} from '../../lib/machine/programContext'

/** Plain-words status for each row of the expanded operation list. The
 *  active operation inherits the run state so a hold or error:N reads
 *  'held' / 'failed' on the row it happened in. */
/** Whole seconds since `startMs`, at least 1. Reads the clock at each render, as the inline form did. */
/** WO-1989: an axis the program left at a machine position has no work value;
 *  it stays where the prelude leaves it (audit 10: Z at the prelude's own last
 *  Z move, if any) until the program moves it. */
function resumeAxis(value: number | null, units: Units, rest: string | null = null): string {
  return value === null ? `- (stays ${rest ?? 'where it is'})` : fmtMachineLength(value, units)
}

/** The run length: start to end, never `Date.now()` - WO-2236, a readout
 *  that kept growing after the run ended ("1/1 done in 195s" for a ~4 s move,
 *  because it read the elapsed time since start at every render instead of
 *  the run's own end stamp). */
function runLengthSeconds(startMs: number, endMs: number): number {
  return Math.max(1, Math.round((endMs - startMs) / 1000))
}

function operationItemStatus(status: OperationProgressStatus, state: OperationProgressState): string {
  if (status === 'active' && state === 'held') return 'held'
  if (status === 'active' && state === 'failed') return 'failed'
  return status
}
import { ProgramPreview } from './ProgramPreview'
import { useSelectAllOnClick } from '../ui/selectAllOnClick'
import {
  centeredScrollTop,
  initialFollowScroll,
  isFollowing,
  markApplied,
  observeScroll,
} from './followScroll'
import { ProgramDivider, useProgramPreviewPercent } from './ProgramDivider'
import {
  fileLinesListing,
  listingRowIsMove,
  stagedProgramListing,
  type ProgramListingLine,
} from './ProgramListing'
import { RunClock, runClockSnapshot } from './RunClock'
import { deriveOperatorProgramPercent } from '../../lib/machine/operatorTransport'
import { buildProgramPath } from '../../lib/machine/programPath'
import { arcSweep } from '../../lib/program/buildMachineProgram'
import type { ProgramStep } from '../../lib/machine/controller'

/** Lines rendered around the live cursor (windowed - programs can be 100k+ lines). */
const FOLLOW_WINDOW = 160

interface ProgramDistanceSeries {
  /** Text programs key distance to raw source lines; staged programs to move count. */
  mode: 'source-line' | 'move-count'
  cursors: number[]
  cumulative: number[]
  total: number
}

function pointDistance(
  a: { x: number; y: number; z: number },
  b: { x: number; y: number; z: number },
): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
}

/** Distance in the same sampled 3D path ProgramPreview draws. */
function textProgramDistance(programText: string): ProgramDistanceSeries {
  const path = buildProgramPath(programText)
  const cursors: number[] = []
  const cumulative: number[] = []
  let total = 0
  for (let index = 1; index < path.moves.length; index++) {
    total += pointDistance(path.moves[index - 1], path.moves[index])
    const line = path.moveLines[index]
    if (cursors.at(-1) === line) cumulative[cumulative.length - 1] = total
    else {
      cursors.push(line)
      cumulative.push(total)
    }
  }
  return { mode: 'source-line', cursors, cumulative, total }
}

const ARC_PLANE_AXES = {
  xy: ['x', 'y', 'z'],
  xz: ['x', 'z', 'y'],
  yz: ['y', 'z', 'x'],
} as const

function stagedStepDistance(
  step: ProgramStep,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): number {
  if (step.kind !== 'arc') return step.kind === 'line' ? pointDistance(from, to) : 0
  const [u, v, w] = ARC_PLANE_AXES[step.plane]
  const radius = Math.hypot(from[u] - step.centre[u], from[v] - step.centre[v])
  if (!(radius > 0)) return pointDistance(from, to)
  const startAngle = Math.atan2(from[v] - step.centre[v], from[u] - step.centre[u])
  const endAngle = Math.atan2(to[v] - step.centre[v], to[u] - step.centre[u])
  return Math.hypot(Math.abs(arcSweep(startAngle, endAngle, step.clockwise)) * radius, to[w] - from[w])
}

/** Distance in the staged geometry program, including true planar/helical arc length. */
function stagedProgramDistance(stagedProgram: NonNullable<ReturnType<typeof useMachineControl.getState>['stagedProgram']>): ProgramDistanceSeries {
  const cursors: number[] = []
  const cumulative: number[] = []
  const position = { x: 0, y: 0, z: 0 }
  let total = 0
  for (let index = 0; index < stagedProgram.program.steps.length; index++) {
    const step = stagedProgram.program.steps[index]
    if (step.kind === 'line' || step.kind === 'arc') {
      const to = {
        x: step.to.x ?? position.x,
        y: step.to.y ?? position.y,
        z: step.to.z ?? position.z,
      }
      total += stagedStepDistance(step, position, to)
      Object.assign(position, to)
    }
    cursors.push(index + 1)
    cumulative.push(total)
  }
  return { mode: 'move-count', cursors, cumulative, total }
}

function completedProgramDistance(
  series: ProgramDistanceSeries,
  ackedSourceLine: number,
  ackedMoves: number,
): number {
  const cursor = series.mode === 'source-line' ? ackedSourceLine : ackedMoves
  let low = 0
  let high = series.cursors.length - 1
  let found = -1
  while (low <= high) {
    const middle = (low + high) >>> 1
    if (series.cursors[middle] <= cursor) {
      found = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return found >= 0 ? series.cumulative[found] : 0
}

/**
 * Pause-aware elapsed time for the percentage. This intentionally mirrors the
 * RunClock state machine beside it; runClockSnapshot remains the shared clock
 * arithmetic, while this local timer makes the bar and number update live.
 */
function useProgramProgressElapsedMs(
  phase: ReturnType<typeof useMachineControl.getState>['job']['phase'],
  startedAt: number | null,
  pausedAt: number | null,
): number | null {
  const active = phase === 'streaming' || phase === 'paused'
  const [clock, setClock] = useState({
    nowMs: 0,
    excludedUnstampedHoldMs: 0,
    unstampedHoldStartedAt: null as number | null,
  })

  useEffect(() => {
    if (!active || startedAt === null) {
      setClock({ nowMs: 0, excludedUnstampedHoldMs: 0, unstampedHoldStartedAt: null })
      return
    }
    const sampledAt = pausedAt ?? Date.now()
    setClock((current) => {
      if (phase === 'paused') {
        const unstampedHoldStartedAt = pausedAt === null
          ? current.unstampedHoldStartedAt ?? sampledAt
          : null
        return { ...current, nowMs: unstampedHoldStartedAt ?? sampledAt, unstampedHoldStartedAt }
      }
      const completedHoldMs = current.unstampedHoldStartedAt === null
        ? 0
        : Math.max(0, sampledAt - current.unstampedHoldStartedAt)
      return {
        nowMs: sampledAt,
        excludedUnstampedHoldMs: current.excludedUnstampedHoldMs + completedHoldMs,
        unstampedHoldStartedAt: null,
      }
    })
    if (phase === 'paused') return
    const timer = setInterval(() => setClock((current) => ({ ...current, nowMs: Date.now() })), 500)
    return () => clearInterval(timer)
  }, [active, phase, pausedAt, startedAt])

  if (!active || startedAt === null) return null
  return runClockSnapshot(
    clock.nowMs,
    startedAt + clock.excludedUnstampedHoldMs,
    pausedAt,
    null,
  ).elapsedMs
}

const TC_STEP_LABEL: Record<ToolChangeStep, string> = {
  stopping: 'stopping the program',
  parking: 'parking',
  'awaiting-swap': 'swap the tool',
  probing: 'probing the new tool',
  arming: 're-arming the program',
  ready: 'ready to resume',
  failed: 'stopped',
}

interface LoadedMeta {
  load: { lines: unknown[]; skipped: number; overlongLines: number[] }
  lint: LintFinding[]
}

/** Geometry programs have no exported G-code context, but their staged view
 * already carries the exact setup boundaries accepted by the controller. */
export function stagedSetupChipLabel(
  stagedProgram: ReturnType<typeof useMachineControl.getState>['stagedProgram'],
  moveId: number | null,
  doing = 'running',
): string | null {
  if (!stagedProgram || stagedProgram.setups.length < 2) return null
  if (moveId === null) return stagedProgram.setups.map(({ setupName }) => setupName).join(' + ')
  // WO-2580: by place in the program, not by id - a dwell's id is numbered
  // after every motion id, wherever it sits.
  const order = stagedStepOrder(stagedProgram)
  const at = order.get(moveId) ?? moveId
  const placeOf = (id: number) => (order.has(moveId) ? order.get(id) ?? Infinity : id)
  const active = stagedProgram.setups.reduce((current, candidate) =>
    placeOf(candidate.firstStepId) <= at ? candidate : current)
  return `${active.setupName} (${active.wcs}) ${doing}`
}

const stagedStepOrders = new WeakMap<object, Map<number, number>>()
function stagedStepOrder(stagedProgram: NonNullable<ReturnType<typeof useMachineControl.getState>['stagedProgram']>): Map<number, number> {
  let order = stagedStepOrders.get(stagedProgram.program)
  if (!order) {
    order = new Map(stagedProgram.program.steps.map((step, index) => [step.id, index]))
    stagedStepOrders.set(stagedProgram.program, order)
  }
  return order
}

/** WO-2519: the move the header's section is read from. Between a program's
 *  parts - an M0, a tool change - the board names no move, and the header
 *  listed every section ("File section 1 + File section 2 + ..."; machine
 *  session 2026-10-03, F7); the program is still in the section of the move
 *  it finished last. Before a start there is none, and every section is named. */
export function stagedSetupChipMoveId(
  job: Pick<ReturnType<typeof useMachineControl.getState>['job'], 'phase' | 'ackedSourceLine'>,
  executingMoveId: number | null,
): number | null {
  if (executingMoveId !== null) return executingMoveId
  const active = job.phase === 'streaming' || job.phase === 'paused'
  return active && job.ackedSourceLine > 0 ? job.ackedSourceLine : null
}

/** WO-2651 items 2 and 12: the controller holds the program while it runs or
 *  is held - at an M0, a tool change, between parts - so nothing is applied
 *  or inserted under it. Read live at the gesture, not from the last render. */
function programRunsOrHolds(
  s: Pick<ReturnType<typeof useMachineControl.getState>, 'job' | 'machineState' | 'toolChange'>,
): boolean {
  return s.job.phase === 'streaming' || s.job.phase === 'paused'
    || s.machineState === 'run' || s.machineState === 'hold' || s.toolChange !== null
}

/** A fresh nonce for editor jump/tool requests (WO-2651); event handlers only. */
let editorSeq = 0
const nextEditorSeq = () => ++editorSeq

export function ProgramPanel() {
  const probeSignals = useProbeSignals()
  const connected = useMachineControl((s) => s.connectionPhase) === 'connected'
  const machineState = useMachineControl((s) => s.machineState)
  const job = useMachineControl((s) => s.job)
  // WO-1663: after the operator's own Stop the progress stays where they
  // stopped it until CYCLE START runs the program again - not a reset count.
  const operatorStop = useSyncExternalStore(subscribeOperatorStop, operatorStopState, () => null)
  const stoppedAt =
    operatorStop !== null
    && operatorStop.name === job.name
    && (job.phase === 'empty' || job.phase === 'ready')
    // WO-2609 kit: M0/M6 Stop re-stages the whole file. The stop sentence
    // retains its boundary, but its old count is no longer the ready program.
    && !(operatorStop.boundary !== undefined && operatorStop.rearmed)
      ? operatorStop
      : null
  // WO-2519: in a kept stop - an MDI line or a jog in it, and the way back to
  // it - the readouts are the paused program's, not the stop's own.
  const paused = useSyncExternalStore(useMachineControl.subscribe, pausedProgramReadout, () => null)
  // WO-2256: a return near the file's top counts from below zero by the
  // moves of its way back (the store reads it as the file's count).
  const programText = useMachineControl((s) => s.programText)
  const stagedProgram = useMachineControl((s) => s.stagedProgram)
  const executingMoveId = useMachineControl((s) => s.executingMoveId)
  const singleBlock = useMachineControl((s) => s.singleBlock)
  // WO-2562: count directly from the controller's executing step, in the
  // file's numbering. Boundary and settled Single Block counts are terminal.
  const executingIndex = executingMoveId === null || stagedProgram === null
    ? -1 : stagedStepOrder(stagedProgram).get(executingMoveId) ?? -1
  const activeMove = (job.phase === 'streaming' || job.phase === 'paused')
    && programPartsTransportState() === null
    && !(singleBlock && machineState !== 'run') && executingIndex >= 0
  // WO-2580: counted as the file's moves - a stop-only section's dwell is not one.
  const shownAcked = listedStepCount(
    stagedProgram,
    Math.max(0, paused ? paused.done : stoppedAt ? stoppedAt.ackedMoves : activeMove ? executingIndex : job.ackedLines),
  )
  const shownTotal = listedStepCount(stagedProgram, paused ? paused.total : stoppedAt ? stoppedAt.totalMoves : job.totalLines)
  const stoppedAtMoveId = useMachineControl((s) => s.stoppedAtMoveId)
  const programContext = useMachineControl((s) => s.programContext)
  const surfaceMesh = useMachineControl((s) => s.surfaceMesh)
  const activeTool = useMachineControl((s) => s.activeTool)
  const toolChange = useMachineControl((s) => s.toolChange)
  const fitTrace = useMachineControl((s) => s.fitTrace)
  const homed = useMachineControl((s) => s.homed)
  const units = useDisplayUnits()
  const machine = useCamStore(controlMachine)
  const parkMachine = useCamStore(parkCarrierMachine)
  const project = useCamStore((s) => s.project)
  const toolLibrary = useCamStore((s) => s.toolLibrary)
  // The posting view of the project: the live root tool library is the truth the
  // post resolves tools from (project.toolLibrary is only a save-time snapshot).
  const liveProject = useMemo(() => ({ ...project, toolLibrary }), [project, toolLibrary])
  const machineId = machine?.id ?? 'default'
  const actionsCfg = useMachineActions((s) => s.byMachine[machineId])
  const toolTable = useMachineToolTable((s) => s.byMachine[machineId]?.table ?? EMPTY_TOOL_TABLE)
  const probeOverride = useMachineToolTable((s) => s.byMachine[machineId]?.probe)
  const probeCfg = useMemo(
    () => resolveProbeConfig(machine?.probing, probeOverride),
    [machine?.probing, probeOverride],
  )

  const setups = useCamStore((s) => s.project.setups)
  // WO-414 batch 3 (R6, Operator 2026-08-21 Approve): the Setup dropdown, "Load
  // setup", "Open file..." and "Recent" are ONE "Load" button that opens a
  // small in-flow menu (setups to post, Open file..., recent programs). The
  // bar is one row at rest. The menu renders in flow under the bar (no
  // positioned surface, no overlay), closes on a choice, Escape or a press
  // outside it.
  const [loadMenuOpen, setLoadMenuOpen] = useState(false)
  const loadMenuRef = useRef<HTMLDivElement | null>(null)
  const [loadError, setLoadErrorState] = useState<string | null>(null)
  // WO-414 batch 3 (R13 Approve): a load error / run-from refusal is ALSO
  // written to the console, so it survives the next click; on screen it is
  // one short red line that clears on the next load or plan.
  const setLoadError = (text: string | null) => {
    setLoadErrorState(text)
    if (text) useMachineControl.getState().pushConsole('tx', text, 'error')
  }
  const [meta, setMeta] = useState<LoadedMeta | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)
  const [recent, setRecent] = useState<RecentProgramMeta[]>([])
  const [runFromLine, setRunFromLine] = useState<number | ''>('')
  const runFromBeforeEdit = useRef<number | ''>('')
  const runFromSelectAll = useSelectAllOnClick()
  const [runFromPlan, setRunFromPlan] = useState<RunFromLinePlan | null>(null)
  const [runFromError, setRunFromError] = useState<string | null>(null)
  const [hoverLine, setHoverLine] = useState<number | null>(null)
  const armedFromLine = useMachineControl((s) => s.armedFromLine)
  const stagedNumbering = useMachineControl((s) => s.stagedNumbering)
  const offsets = useMachineControl((s) => s.offsets)
  const operationListExpanded = useMachineControl((s) => s.operationListExpanded)
  const programPreviewPercent = useProgramPreviewPercent()

  const refreshRecent = () => {
    void listPrograms().then(setRecent)
  }
  useEffect(refreshRecent, [])

  // The Load menu closes on Escape or a press anywhere outside it (a choice
  // closes it itself). No backdrop element, no positioned surface.
  useEffect(() => {
    if (!loadMenuOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setLoadMenuOpen(false)
    }
    const onPress = (event: MouseEvent) => {
      const host = loadMenuRef.current
      if (host && event.target instanceof Node && !host.contains(event.target)) setLoadMenuOpen(false)
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('mousedown', onPress)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('mousedown', onPress)
    }
  }, [loadMenuOpen])

  const ed = useText('gcode-editor')
  const [editing, setEditing] = useState<{
    name: string
    /** The loaded text the edit started from. */
    base: string
    text: string
    /** The setup information `base` was loaded (or posted) with. */
    context: ProgramContextV1 | null
    /** A load's own refusal of this exact text, marked at its line. */
    refusal: { text: string; mark: GcodeLineMark } | null
    note: string | null
  } | null>(null)
  const [editorOpen, setEditorOpen] = useState(false)
  const [editorJump, setEditorJump] = useState<GcodeEditorJump | null>(null)
  const [editorTool, setEditorTool] = useState<GcodeEditorToolRequest | null>(null)
  const [lineMenu, setLineMenu] = useState<{ x: number; y: number; line: number; sourceLine: number | null; pickable: boolean } | null>(null)
  /** Insert line's inline field: after listing row `listingLine`, staged
   *  after the program's line `editLine`. */
  const [insertAfter, setInsertAfter] = useState<{ listingLine: number; editLine: number } | null>(null)
  const [insertText, setInsertText] = useState('')
  const [liveMarks, setLiveMarks] = useState<GcodeLineMark[]>([])
  const programHeld = programRunsOrHolds({ job, machineState, toolChange })
  const stagedListingText = editing !== null && editing.text !== editing.base && programText !== null && !programHeld
    ? editing.text : null
  // WO-2651: staged edits to a text program show in its listing (marked as
  // staged) until Apply or Discard - never while it runs, when the listing
  // follows the controller.
  const listingShowsStaged = stagedListingText !== null
  const jobName = job.name
  const lines = useMemo<ProgramListingLine[]>(() => {
    if (stagedListingText !== null) {
      return stagedListingText.split(/\r?\n/).map((text, index) => ({ text, moveId: null, lineNumber: index + 1 }))
    }
    if (programText) {
      return programText.split(/\r?\n/).map((text, index) => ({ text, moveId: index + 1, lineNumber: index + 1 }))
    }
    if (!stagedProgram) return []
    // WO-2580: a step that is no line of the file has no row.
    const staged = stagedProgramListing(stagedProgram).filter((line) => line.moveId === null || isListedStep(stagedProgram, line.moveId))
    // WO-2680: an opened file lists every line of the file (a posted program
    // and a toolpath list their staged moves, as before).
    const plainFileText = jobName !== null && !jobName.endsWith(' (posted)') && !jobName.endsWith(' (toolpath)')
      && stagedProgram.sourceLines !== undefined
      ? loadedProgramText() : null
    return plainFileText === null ? staged : fileLinesListing(staged, plainFileText.split(/\r?\n/))
  }, [programText, stagedProgram, stagedListingText, jobName])
  const stagedRows = useMemo(() => {
    if (stagedListingText === null || programText === null) return null
    const rows = new Set<number>()
    for (const h of lineChanges(programText, stagedListingText).hunks) {
      for (let n = h.afterStart; n < h.afterStart + h.afterCount; n++) rows.add(n)
    }
    return rows
  }, [stagedListingText, programText])
  const runFromContext = stagedProgram ? stagedProgramContext() : null
  // A file's source lines exist even without a LienCAM stock/context envelope.
  const runFromText = programText ?? (stagedProgram ? loadedProgramText() : null)
  const runFromLines = useMemo(() => runFromText?.split(/\r?\n/) ?? [], [runFromText])
  const hasProgram = programText !== null || stagedProgram !== null
  // WO-2560: a kept file awaiting offsets has a name but no listing yet.
  // Hide these readouts only while the session's standalone typed line owns
  // the job; absence of text/listing does not identify an MDI line.
  const showProgramReadouts = !standaloneMdiJob()
  // The loaded program's context compared against the LIVE project, LIVE post
  // config, and loaded text: current, project changed, or program changed
  // (never mutates the snapshot).
  // A loaded program may be several megabytes. Hash it only when the text
  // changes; project edits still recompute the manufacturing-intent side.
  const loadedMotionDigest = useMemo(
    () => computeMotionDigest(programText ?? ''),
    [programText],
  )
  // WO-396: the comparison re-runs only when something the digest READS moved.
  // `liveProject` is a fresh object on every project replacement (selecting an
  // operation replaces the project to change activeOperationId), and each run
  // re-resolves every section and re-hashes every move; keyed on the identity
  // tuple instead, a tree click costs nothing and a real edit (any of those
  // references replaced) still recomputes the true digest on the next render.
  // The dependency list below IS programIntentIdentity(project, toolLibrary), spelled
  // out (the hook rule wants a literal); PROGRAM_INTENT_PROJECT_FIELDS in
  // programContext.ts is the single source and its Proxy test pins the read set.
  /** The post dialect this project's MACHINE declares. Identity resolution is
   *  shared with every control and post route, so an unknown or legacy value
   *  is a refusal rather than a guessed dialect (ADR-0003).
   *
   *  It has to be shared by the POST and the COMPARISON, because the post
   *  config is part of the hashed program intent (programContext.ts:517). Post
   *  a program with one dialect and compare it against another and the hashes
   *  can never match, so the panel would report "the project changed" forever
   *  on a program nobody had touched. */
  const controllerResolution = useMemo(
    () => resolveDeclaredController(project.machine),
    [project.machine],
  )
  const postConfigForProject = controllerResolution.ok ? controllerResolution.dialect : null

  const intentIdentity = programIntentIdentity(project, toolLibrary)
  const intentProject = useMemo(
    () => liveProject,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- keyed on what the digest reads, not on the project object (WO-396)
    [intentIdentity[0], intentIdentity[1], intentIdentity[2], intentIdentity[3], intentIdentity[4], intentIdentity[5], intentIdentity[6], intentIdentity[7], intentIdentity[8]],
  )
  // WO-398: an unknown fault in the comparison is shown as its own state, never as
  // a plausible 'project changed'. The library throws; the panel stays up and says so.
  const contextComparison = useMemo<ProgramContextComparison | 'comparison-failed'>(() => {
    if (!postConfigForProject) return programContext ? 'comparison-failed' : 'no-context'
    try {
      return compareProgramContext(programContext, intentProject, programText, postConfigForProject, loadedMotionDigest)
    } catch (err) {
      console.error('[program-context] comparison failed:', err)
      return 'comparison-failed'
    }
  }, [programContext, intentProject, programText, loadedMotionDigest, postConfigForProject])
  // WO-382: publish the verdict to the store so the cycle log can name the
  // operation an event happened in - only ever for a 'current' context. Keyed on
  // the context too: a re-load of the same text with a fresh snapshot clears the
  // store's verdict and this must re-publish even when the word is unchanged.
  useEffect(() => {
    useMachineControl.getState().setProgramContextVerdict(contextComparison)
  }, [contextComparison, programContext])
  // WO-382: where in the plan the controller is - derived ONLY from the
  // streamer's acked source line (plus the armed start line while nothing has
  // been acked yet) mapped through the verified spans. A stale, foreign or
  // unverifiable program gets nothing: the line-only UI stands, no error.
  const operationProgress = useMemo(
    () =>
      contextComparison === 'current'
        ? deriveOperationProgress(programContext, programText, {
            // A feed hold leaves the streamer 'streaming' (it only stops
            // filling); the machine's own Hold state is what the operator sees.
            phase: job.phase === 'streaming' && machineState === 'hold' ? 'paused' : job.phase,
            ackedSourceLine: job.ackedSourceLine,
            armedFromLine,
          })
        : null,
    [contextComparison, programContext, programText, job.phase, job.ackedSourceLine, armedFromLine, machineState],
  )
  const streaming = job.phase === 'streaming' || job.phase === 'paused'
  // The post-bound context identifies the exact setup(s) in this loaded
  // program. Only a current context may read the live project's operation
  // estimates; a foreign/stale file has no trustworthy program estimate and
  // the clock says so instead of borrowing some other setup's number.
  const programEstimateMs = useMemo(() => {
    let estimateContext = programContext
    if (estimateContext) {
      if (contextComparison !== 'current') return null
    } else {
      // Geometry controllers intentionally keep programText null. Their
      // verified post context is bound to the exact staged listing beside the
      // store; compare that source text before borrowing live project totals.
      const staged = stagedProgram ? stagedProgramContext() : null
      if (!staged || !postConfigForProject) return null
      try {
        if (compareProgramContext(
          staged.context,
          intentProject,
          staged.text,
          postConfigForProject,
          computeMotionDigest(staged.text),
        ) !== 'current') return null
      } catch {
        return null
      }
      estimateContext = staged.context
    }
    const setupIds = programContextSetups(estimateContext).map(({ setup }) => setup.id)
    const programSetups = setupIds.map((id) => project.setups.find((setup) => setup.id === id))
    if (programSetups.some((setup) => setup === undefined)) return null
    if (programSetups.some((setup) => setup!.operations.some((operation) =>
      operation.enabled
      && operation.status === 'ready'
      && (operation.estimatedCutTimeMs === undefined || operation.estimatedCutTimeMsError !== undefined)))) {
      return null
    }
    const motion = machineCutTimeMotion(machine)
    const total = programSetups.reduce((sum, setup) => sum + setupEnabledCutTimeMs(
      setup!.operations,
      {
        geometry: project.geometry,
        nests: project.nests ?? [],
        rapidRate: machine.rapidRate,
        motion,
      },
    ), 0)
    return Number.isFinite(total) && total > 0 ? total : null
  }, [
    contextComparison,
    programContext,
    stagedProgram,
    postConfigForProject,
    intentProject,
    project.setups,
    project.geometry,
    project.nests,
    machine,
  ])

  // WO-2279: context decides whether CAM totals describe this file; it never
  // decides whether the file's own commanded moves can be timed. Keep this
  // separate from programEstimateMs, which also feeds WO-2236's percentage.
  const ownMoveEstimate = useMemo(() => {
    try {
      if (programText !== null) {
        const dialect = machine.controller === 'uccnc' || machine.controller === 'linuxcnc'
          ? machine.controller : machine.controller === 'grbl' ? 'grbl' : 'generic'
        const workOffsets = Object.fromEntries(Object.entries(offsets).map(([wcs, v]) =>
          [wcs, { x: v[0] ?? 0, y: v[1] ?? 0, z: v[2] ?? 0 }]))
        return textProgramRunEstimate(programText, machine, {
          dialect, sessionWcs: 'G54', initialPosition: { x: 0, y: 0, z: 0 },
          machineDefinition: machine, machineUnits: 'mm', workOffsets, macroMCodes: 'report',
        })
      }
      return stagedProgram ? stagedProgramRunEstimate(stagedProgram.program.steps, machine) : null
    } catch {
      // Display only: an unplannable file must not affect staging or motion.
      return null
    }
  }, [programText, stagedProgram, machine, offsets])
  const resumedEstimate = stagedNumbering !== null || (armedFromLine !== null && armedFromLine > 1)
  const lastTextCursor = useRef(1)
  useEffect(() => { lastTextCursor.current = armedFromLine ?? 1 }, [programText, armedFromLine])
  useEffect(() => {
    if (programText !== null && job.ackedSourceLine > 0) lastTextCursor.current = job.ackedSourceLine + 1
  }, [programText, job.ackedSourceLine])
  // WO-2684 review: on the text door an ACK is not execution - GRBL acks a
  // line when it parses it, while the moves before it still run. The cursor
  // is the line the controller names executing; between named moves, the last
  // one it named this run (counted in full until it names the next).
  const textRunStart = useRef(1)
  const lastExecutingTextLine = useRef<number | null>(null)
  useEffect(() => {
    textRunStart.current = armedFromLine ?? 1
    lastExecutingTextLine.current = null
  }, [programText, armedFromLine, job.startedAt])
  const holdsSeenNow = useMachineControl((s) => s.holdsSeen)
  const executingTextLine = programText !== null && executingMoveId !== null && executingMoveId > 0
    ? executingMoveId : null
  useEffect(() => {
    if (executingTextLine !== null) lastExecutingTextLine.current = executingTextLine
  }, [executingTextLine])
  // Held at the file's own M0/M1/M6 the moves before it have run - but a
  // pause SENT is not a pause reached (review 10-08: a Feed Hold halfway into
  // a cut, GRBL unable to name the line, its M0 already sent). The stop is
  // reached when the controller has named the last move before it and the
  // machine stands where that move ends. Position alone is not history: an
  // earlier cut can cross the same point (review 10-08, round 3).
  const heldAtLine = machineState === 'hold' && programText !== null
    ? textProgramHoldLine(programText, job, holdsSeenNow) : null
  const heldAtEnd = heldAtLine === null ? null : ownMoveEstimate?.endBefore(heldAtLine) ?? null
  const namedSoFar = executingTextLine ?? lastExecutingTextLine.current
  const heldAtStands = useMachineControl((s) => !!heldAtEnd && !!s.wpos
    && Math.abs(s.wpos.x - heldAtEnd.x) <= 0.05 && Math.abs(s.wpos.y - heldAtEnd.y) <= 0.05
    && Math.abs(s.wpos.z - heldAtEnd.z) <= 0.05)
  const heldAtReached = heldAtStands && heldAtEnd !== null
    && namedSoFar !== null && namedSoFar >= heldAtEnd.cursor
  const textCursor = (): number => {
    if (executingTextLine !== null) return executingTextLine
    if (heldAtLine !== null && heldAtReached) return heldAtLine
    if (lastExecutingTextLine.current !== null) return lastExecutingTextLine.current
    // A controller that names no executing line: its ACKs are all there is.
    if (controllerCapabilities()?.executingMoveId !== true) {
      return job.ackedSourceLine > 0 ? job.ackedSourceLine + 1 : lastTextCursor.current
    }
    return textRunStart.current
  }
  // WO-2684: Est. remaining is the time to run the moves still left - held at
  // an M0, a tool change or a Feed Hold too (desk 10-08: "Est. remaining 0s"
  // at v80-m0.nc's M0 with a 4 s move to come). A kept stop reads the move it
  // paused in.
  const remainingCursor = paused?.cursor ?? (stagedProgram
    ? executingMoveId ?? job.ackedSourceLine + 1
    : textCursor())
  const movesLeft = ownMoveEstimate ? { estimate: ownMoveEstimate, cursor: remainingCursor } : undefined

  // Run-from only arms a program. The global CYCLE START owns motion; close
  // this local review card once that canonical action starts the job.
  useEffect(() => {
    if (runFromPlan && job.phase !== 'ready' && job.startedAt !== null) setRunFromPlan(null)
  }, [runFromPlan, job.phase, job.startedAt])

  // WO-082: any OTHER surface can now arm the program - the transport row's
  // "Re-arm from start" is deliberately outside this panel. This card says
  // "the machine will move to X/Y/Z and start at line N"; once a different arm
  // has replaced that job the card is a false statement about MOTION, so it
  // must not survive one. The arm epoch is the session's own signal that the
  // armed job was replaced.
  const epoch = useSyncExternalStore(subscribeArmEpoch, armEpoch, armEpoch)
  const seenEpoch = useRef(epoch)
  useEffect(() => {
    if (seenEpoch.current === epoch) return
    seenEpoch.current = epoch
    setRunFromPlan(null)
    setRunFromError(null)
  }, [epoch])

  // WO-051: Back lives in the transport STEP row, but its re-arm uses this
  // existing run-from review surface. Mirror the session event into the same
  // plan/error fields so target, positioning prelude, spindle restart and
  // plunge cautions stay visible before canonical CYCLE START owns motion.
  const externalReview = useSyncExternalStore(subscribeRunFromReview, runFromReview, runFromReview)
  // Operator 2026-09-14 ("A: Flash, all motion off"): Park + clamp parks - motion.
  const estopLatched = useSyncExternalStore(subscribeEstopNeedsReset, estopNeedsReset, () => true)
  const seenReview = useRef(externalReview.revision)
  useEffect(() => {
    if (seenReview.current === externalReview.revision) return
    seenReview.current = externalReview.revision
    if (externalReview.source === 'step-back') {
      setRunFromPlan(externalReview.plan)
      setRunFromError(externalReview.error)
      return
    }
    // A source:null revision is an explicit lifecycle clear, not an event to
    // ignore. ProgramPanel mirrors the external Step Back authority into its
    // local plan/error fields, so stopped/disconnect/reconnect must clear both
    // rendered mirrors as well as the session snapshot.
    setRunFromPlan(null)
    setRunFromError(null)
  }, [externalReview])

  // WO-382: tell the store which program line the armed job starts at, so the
  // operation display and the 'started' log row name the right operation for a
  // mid-program arm. Every setProgram (a full re-load, cancel, re-arm from top)
  // resets it to null; only an actual mid-program arm sets it.
  useEffect(() => {
    const line = runFromPlan?.startLine ?? (toolChange?.step === 'ready' ? toolChange.resumeLine : null)
    if (line !== null && line !== undefined) useMachineControl.getState().setArmedFromLine(line)
  }, [runFromPlan, toolChange])
  // WO-382: the recovery review names the operation the armed start sits in.
  const runFromOperation = useMemo(
    () =>
      runFromPlan && contextComparison === 'current'
        ? deriveOperationProgress(programContext, programText, {
            phase: 'ready',
            ackedSourceLine: 0,
            armedFromLine: runFromPlan.startLine,
          })?.operationLabel ?? null
        : null,
    [runFromPlan, contextComparison, programContext, programText],
  )

  const applyProgram = (
    name: string,
    text: string,
    save = true,
    context: ProgramContextV1 | null = null,
    runThroughOffsetChanges = false,
  ): { door: 'text' | 'program'; ok: boolean; reason: string | null } => {
    // WO-1335: THE FILE DOOR IS CHOSEN BY THE CONTROLLER, in the same place and
    // for the same reason `loadFromSetup` chooses the setup door.
    //
    // Operator, 2026-09-11, at the machine: "A CNC control software that cannot load
    // the most standard file format for controlling a CNC is not complete." On
    // his AXBB-E this function used to hand posted text to a controller with no
    // interpreter: nothing staged, no console line, and the program loaded
    // before it stayed loaded. A geometry controller now gets the file
    // INTERPRETED into the staged program it does run.
    //
    // A file loaded this way has no line list (nothing is streaming lines) and
    // no source-line streamer. The geometry route publishes its accepted staged
    // moves for the read-only list and controller-id highlight; lint / skipped
    // chips still describe source lines that are not being streamed, so `meta`
    // is cleared exactly as the toolpath door clears it.
    // WO-1977: the session picks the door - including the interpreter for a
    // file this controller's own text reader refuses but its program route
    // can run (a Fusion file on "Simulate LienCNC").
    const outcome = loadGcodeFile(name, text, context, { runThroughOffsetChanges })
    if (outcome.door === 'program') {
      setMeta(null)
      setRunFromPlan(null)
      setRunFromError(null)
      // The session owns the refusal's one console row. This local state only
      // mirrors it beside Load; pushing it again would print the same refusal.
      setLoadErrorState(outcome.ok ? null : outcome.reason)
      if (save && outcome.ok) void saveProgram(name, text).then(refreshRecent)
      return { door: 'program', ok: outcome.ok, reason: outcome.reason }
    }
    const load = outcome.load
    // WO-2464: comments are read the way the ACTIVE controller reads them (a LinuxCNC post's ';' is valid
    // RS274NGC); an undeclared controller keeps the GRBL reading.
    const activeDialect = resolveDeclaredController(machine)
    const lint = lintGcode(text, {
      commentStyle: (activeDialect.ok ? activeDialect.dialect : GRBL_CONFIG).capabilities.comment,
    })
    setMeta({ load, lint })
    setLoadError(null)
    setRunFromPlan(null)
    setRunFromError(null)
    if (save) void saveProgram(name, text).then(refreshRecent)
    // The text door always takes the text; a line its checks stop at is the
    // readiness reason ("Line N: ..."), which the editor marks.
    const readiness = useMachineControl.getState().programReadiness
    return { door: 'text', ok: true, reason: readiness.ready ? null : readiness.reason }
  }

  // Plan a mid-program start. Takes the line explicitly so a per-line gesture
  // can plan in one action: setRunFromLine is async, so reading it back here
  // would plan the PREVIOUS target.
  //
  // WO-082: line 1 is no longer a dead end. armProgramFromLine routes a
  // "that IS the program start" refusal to a normal arm-from-the-top, so the
  // operator who types 1 gets an armed program instead of "use Start instead"
  // next to a Start they had no way to reach.
  // WO-087: async because routing to an arm-from-the-top may first have to
  // reset the controller. The refusal still lands in the same field.
  // WO-414 batch 3 (R14 Approve): the "armed from the beginning" advice is a
  // console line the moment it arises, not a box under the bar that never
  // cleared on its own. R13: a refusal is ALSO written to the console.
  const planRunFrom = async (line: number | '' = runFromLine) => {
    setRunFromError(null)
    setRunFromPlan(null)
    if (line === '' || !runFromText) return
    setRunFromLine(line)
    const armed = await armProgramFromLine(line)
    if (!armed.ok) {
      setRunFromError(armed.reason)
      useMachineControl.getState().pushConsole('tx', `Run from line ${line} refused: ${armed.reason}`, 'error')
      return
    }
    if (armed.from === 'top') {
      useMachineControl.getState().pushConsole(
        'tx',
        `Line ${line} is the start of the program, so it is armed from the beginning - ` +
          'the whole program will run. Nothing moves until CYCLE START.',
        'info',
      )
      return
    }
    setRunFromPlan(armed.plan)
  }

  const cancelRunFrom = () => {
    restageLoadedProgram()
    setRunFromPlan(null)
    setRunFromError(null)
  }

  // WO-1506: the shared decode-and-diagnose step both raw-program entry
  // points (file, recent) call before applyProgram. `loadFromFile` already
  // did this; `loadFromRecent` called applyProgram with no context at all,
  // dropping a verified setup block loading the exact same bytes back from
  // Recent. A rejection reason now also reaches the operator's own console,
  // not only devtools - matching how this file already reports other
  // load-time refusals (e.g. `planRunFrom` above).
  const decodeProgramContext = (text: string): ProgramContextV1 | null => {
    const imported = importProgramContextFromGcode(text)
    if (imported.warning) {
      console.warn(`[program-context] ${imported.warning}`)
      useMachineControl.getState().pushConsole('rx', imported.warning, 'warn')
    }
    return imported.context
  }

  const loadFromRecent = (id: string) => {
    const entry = recent.find((r) => r.id === id)
    if (!entry) return
    void readProgram(id).then((text) => {
      if (text !== null) applyProgram(entry.name, text, false, decodeProgramContext(text))
      else setLoadError('That saved program could not be read - it may have been evicted.')
    })
  }

  // An operator Load or Open file always starts clean: a staged edit of the
  // program being replaced is dropped and the console says so - even when the
  // new file's text is identical or it is the same file opened again (machine
  // seat desk kit note, 10-07 1:25 AM). The effect above stays the backstop for
  // loads from elsewhere (Send to Control).
  // The project a Load setup read (review 10-07, sixth): a setup staged from its
  // toolpaths has no program text, so the editor posts it - from THIS snapshot
  // (project state is immutable, so the reference is the loaded revision), never
  // from a project regenerated since. Bound to the staged program it produced.
  const loadedSetupSource = useRef<{ project: Project; toolLibrary: Tool[]; setupIds: string; runThrough: boolean } | null>(null)
  const stagedSetupIds = (staged: typeof stagedProgram) => (staged?.setups ?? []).map((x) => x.setupId ?? '').join('|')
  const currentSetupSource = () => ({ project: useCamStore.getState().project, toolLibrary: useCamStore.getState().toolLibrary })
  const rememberLoadedSetupSource = (source: { project: Project; toolLibrary: Tool[] }, ids: readonly string[], ok: boolean, runThrough = false) => {
    // A failed Load leaves the loaded program in place, so it leaves its source too (review 10-07, seventh).
    if (ok) loadedSetupSource.current = { ...source, setupIds: ids.join('|'), runThrough }
  }

  const dropStagedEditForLoad = (incoming: string) => {
    if (!editing) return
    if (editing.text !== editing.base) {
      useMachineControl.getState().pushConsole('tx', ed('control.stagedDropped', { old: editing.name, now: incoming }), 'warn')
    }
    setEditing(null)
    setEditorOpen(false)
  }

  const loadFromSetup = async (setupId: string) => {
    dropStagedEditForLoad(useCamStore.getState().project.setups.find((x) => x.id === setupId)?.name ?? setupId)
    const st = useCamStore.getState()
    const setup = st.project.setups.find((s) => s.id === setupId)
    if (!setup) {
      setLoadError('No setup to post.')
      return
    }
    // WO-1267: THE DOOR IS CHOSEN BY THE CONTROLLER, ONCE, HERE.
    //
    // A controller with no G-code interpreter (Operator's AXBB-E) cannot be given
    // text at all, so posting one for it produced an empty armed job and a
    // "Re-arm from start" that was lit and did nothing. Its setups go through
    // the toolpath door instead - the door WO-1019 built and left without a
    // handle. Everything below this line is the TEXT route and is unchanged:
    // a controller that runs G-code still posts, still binds a program
    // context, still gets its line list and its run-from-line.
    if (controllerNeedsToolpathProgram()) {
      const loaded = await loadSetupToolpathProgram(setupId)
      // After the load: Load recomputes outdated operations, so the revision it staged is
      // the project as it stands now (review 10-07, eighth).
      rememberLoadedSetupSource(currentSetupSource(), [setupId], loaded.ok)
      // A toolpath program has no TEXT, so it has no lint findings and no line
      // count - `meta` is what the lint/skipped chips read, and leaving the
      // previous program's there would describe a program that is no longer
      // loaded. The session's own readiness sentence is what says what happened.
      setMeta(null)
      setRunFromPlan(null)
      setRunFromError(null)
      setLoadErrorState(loaded.ok ? null : loaded.reason)
      return
    }
    // WO-1653: THE MOMENT CODE LEAVES THE APP. Every enabled operation in this
    // setup goes (Control has no per-operation selection), so nothing is
    // excluded on this call's own account - a genuinely outdated operation
    // (a real edit or a real disable already in the project) is recomputed
    // here instead of the post below refusing it.
    await useCamStore.getState().stageOperationsForEmission(setupId, undefined)
    // The exact project view the post resolves tools/stocks from - read AFTER
    // staging, so a just-recomputed operation is seen fresh.
    const freshState = useCamStore.getState()
    const projectForPost = { ...freshState.project, toolLibrary: freshState.toolLibrary }
    const resolution = resolveDeclaredController(projectForPost.machine)
    if (!resolution.ok) {
      setLoadError(resolution.reason)
      return
    }
    const freshSetup = projectForPost.setups.find((s) => s.id === setupId) ?? setup
    const result = postProject(projectForPost, [freshSetup], resolution.dialect, {
      mode: 'combined',
      pauseBetweenSetups: false,
      baseName: 'control',
      ext: 'nc',
      modelRefsVerifiedSinceLoad: freshState.modelRefsVerifiedSinceLoad,
    })
    if (!result.ok || !result.combined) {
      const firstErrors = result.diagnostics
        .filter((d) => d.level === 'error')
        .slice(0, 3)
        .map((d) => d.message)
        .join(' ')
      setLoadError(
        `Setup "${setup.name}" is not ready to post: ${firstErrors || 'post refused'}. ` +
          'Fix it in the Post Process modal, then reload here.',
      )
      return
    }
    if (!result.combined.operationSpans) {
      setLoadError('The post did not return verified operation source spans. The program was not loaded.')
      return
    }
    const context = buildProgramContext(
      projectForPost,
      freshSetup,
      // The SAME config the G-code above was posted with. Building the context
      // against a different dialect than the program it describes is how a
      // context stops matching its own program.
      resolution.dialect,
      result.combined.gcode,
      result.combined.operationSpans,
    )
    applyProgram(`${setup.name} (posted)`, result.combined.gcode, true, context)
  }

  // WO-1323: EVERY SETUP, IN PROJECT ORDER, AS ONE PROGRAM.
  //
  // Item 5.5's third run - "both setups, ONE posted program: does the machine
  // SWITCH between them mid-program" - had no entry point at all: this menu
  // offered setups singly and `loadFromSetup` loads exactly one. The session
  // plans the program as one stage per setup and switches the frame at each
  // boundary once the outgoing setup's retract has been reported reached.
  //
  // OFFERED ONLY ON THE GEOMETRY ROUTE, and only with more than one setup to
  // combine. A G-code controller already has the Post Process modal's combined
  // program for this, and offering a second, differently-built answer to the
  // same question from the operator's Load menu is how two routes to one
  // machine start disagreeing about what the part is.
  //
  // WO-1329, Operator FROM THE MACHINE 2026-09-11: "The conditions for whether it
  // continues through G54 into G55 versus not should realistically only depend
  // on whether the tool changes between those setups... I would recommend that
  // the checkbox be ON by default." So this box is on when the panel opens, it
  // is a property of THIS load and nothing else (not the project, not the
  // machine), and turning it off gives WO-1323's hold at every boundary. It
  // cannot make a tool-change program continuous: WO-1330 makes that boundary a
  // tool-change SEQUENCE the operator works inside, and the box does not decide
  // it - the load line says so in as many words.
  const loadFromAllSetups = async () => {
    const ids = useCamStore.getState().project.setups.map((s) => s.id)
    dropStagedEditForLoad(useCamStore.getState().project.setups.map((x) => x.name).join(', '))
    const loaded = await loadSetupsToolpathProgram(ids, { runThrough: continueThroughSetups })
    rememberLoadedSetupSource(currentSetupSource(), ids, loaded.ok, continueThroughSetups)
    setMeta(null)
    setRunFromPlan(null)
    setRunFromError(null)
    setLoadErrorState(loaded.ok ? null : loaded.reason)
  }
  const canLoadAllSetups = setups.length > 1 && controllerCanRunToolpathProgram()
  const [continueThroughSetups, setContinueThroughSetups] = useState(true)

  // WO-381: a LienCAM-exported file may carry its setup information as a
  // comment-only LCX1 block after program end. Recover it from the RAW text
  // (before the streamer strips comments) and bind it exactly as a direct load
  // would; on any refusal the file loads as an ordinary no-context program with
  // one advisory warning - the chip then reads 'No setup information'.
  const loadFromFile = (file: File) => {
    dropStagedEditForLoad(file.name)
    void file.text().then((text) => {
      applyProgram(file.name, text, true, decodeProgramContext(text))
    })
  }

  // WO-1335 / WO-2651: a program sent from the Post Process screen goes through
  // the SAME load an opened file does - the door, the checks, the console line.
  const applyProgramRef = useRef(applyProgram)
  applyProgramRef.current = applyProgram
  useEffect(() => {
    const take = () => {
      const sent = takeProgramForControl()
      if (!sent) return
      // A hand-edited post carries its setup information through the edit.
      const context = sent.base !== undefined && sent.base !== sent.text
        ? programContextForEdit(sent.base, sent.text)
        : decodeProgramContext(sent.text)
      applyProgramRef.current(sent.name, sent.text, true, context)
    }
    take()
    return subscribeProgramForControl(take)
    // decodeProgramContext reads only the console store; mount-once is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // ---- WO-2651: EDIT THE LOADED PROGRAM ----
  //
  // Operator ruling, 2026-10-06: "Edit at post processor stage, or on control screen."
  // Apply re-reads the edited text through `applyProgram` - the load path an
  // opened file takes - so the listing, the 3D preview, the tool list,
  // run-from-line and the tool-change stops all follow the edited text, on
  // every controller (text door: simulator, GRBL, LinuxCNC; file door: the
  // UCCNC bridge). While a program runs or is held the controller holds it, so
  // nothing is applied under it and the editor is read-only: a real cannot
  // (rule 11).
  //
  // Amendment (Operator ruling, 10-06 ~11:00 PM CT): "what I don't wanna do is add more UI
  // elements for editing." So there is no Edit button: a right-click on a
  // listing line opens the line menu - Run from here (the existing plan),
  // Insert line (an inline field in the listing), Find / Replace and Go to line
  // (the editor over the preview, with that tool open). Edits are STAGED; the
  // one compact Apply / Discard place in the controls row shows only while
  // there are staged edits.
  const stagedEdits = editing !== null && editing.text !== editing.base
  const editingText = editorOpen ? editing?.text ?? null : null
  useEffect(() => {
    if (editingText === null) return
    const timer = setTimeout(() => setLiveMarks(readerMarks(editingText, machine)), 250)
    return () => clearTimeout(timer)
  }, [editingText, machine])
  const editorMarks = useMemo(() => {
    const refused = editing?.refusal && editing.refusal.text === editing.text ? [editing.refusal.mark] : []
    return [...refused, ...liveMarks.filter((m) => !refused.some((r) => r.line === m.line))]
  }, [editing, liveMarks])
  const stagedSummary = useMemo(
    () => (editing && editing.text !== editing.base ? describeEdit(editing.base, editing.text) : null),
    [editing],
  )
  // A program loaded in its place (another file, a setup, Apply itself) ends
  // an edit of the old one only when nothing is staged; staged edits stay
  // until Apply or Discard - but only while that program is still the one
  // loaded. A DIFFERENT program loaded drops the old program's edit and says
  // so: Apply must never load or run the program the operator replaced
  // (machine seat desk kit 10-07 12:50 AM, RED 1).
  useEffect(() => {
    if (!editing) return
    const loaded = loadedProgramText()
    const replaced = loaded !== null
      ? loaded !== editing.base && loaded !== editing.text
      : (job.name ?? 'program') !== editing.name
    if (replaced) {
      if (editing.text !== editing.base) {
        useMachineControl.getState().pushConsole('tx', ed('control.stagedDropped', { old: editing.name, now: job.name ?? 'program' }), 'warn')
      }
      setEditing(null)
      setEditorOpen(false)
      return
    }
    if (!stagedEdits && !editorOpen) setEditing(null)
  }, [job.name, programText, stagedProgram]) // eslint-disable-line react-hooks/exhaustive-deps

  // A run started with edits still staged runs the loaded program, not the
  // staged one; say so once per run (machine seat desk kit note, 10-07 1:25 AM).
  const phaseBeforeRun = useRef(job.phase)
  useEffect(() => {
    const before = phaseBeforeRun.current
    phaseBeforeRun.current = job.phase
    // A START leaves 'ready' for a run phase (a fast job can go straight to
    // 'complete'); a resume is paused -> streaming and does not repeat this.
    const started = job.phase === 'streaming' || job.phase === 'paused' || job.phase === 'complete' || job.phase === 'failed'
    if (before !== 'ready' || !started || !stagedEdits || !stagedSummary) return
    useMachineControl.getState().pushConsole('tx', ed('control.stagedNotRun', { summary: stagedSummary }), 'warn')
  }, [job.phase]) // eslint-disable-line react-hooks/exhaustive-deps

  /** The text to edit: the loaded program's, or - for setups staged from
   *  their toolpaths, which have none - the same setups posted for this
   *  machine's controller, exactly as Load setup posts one. */
  const textToEdit = (): { text: string; note: string | null; context: ProgramContextV1 | null } | { refused: string } => {
    const loaded = loadedProgramText()
    if (loaded !== null) {
      return { text: loaded, note: null, context: useMachineControl.getState().programContext ?? stagedProgramContext()?.context ?? null }
    }
    const st = useCamStore.getState()
    const snap = loadedSetupSource.current
    const source = snap && stagedProgram && snap.setupIds === stagedSetupIds(stagedProgram) ? snap : { project: st.project, toolLibrary: st.toolLibrary }
    const projectForPost = { ...source.project, toolLibrary: source.toolLibrary }
    const resolution = resolveDeclaredController(projectForPost.machine)
    if (!resolution.ok) return { refused: resolution.reason }
    // By setup id - two setups may share a display name (review 10-07); a name is the
    // fallback only for a record without an id.
    const chosen = (stagedProgram?.setups ?? []).flatMap((staged) => projectForPost.setups
      .filter((s) => (staged.setupId ? s.id === staged.setupId : s.name === staged.setupName)).slice(0, 1))
    if (chosen.length === 0) return { refused: ed('control.editNothingTip') }
    const posted = postProject(projectForPost, chosen, resolution.dialect, {
      mode: 'combined',
      pauseBetweenSetups: false,
      baseName: 'control',
      ext: 'nc',
      modelRefsVerifiedSinceLoad: st.modelRefsVerifiedSinceLoad,
    })
    if (!posted.ok || !posted.combined) {
      const firstError = posted.diagnostics.find((d) => d.level === 'error')?.message ?? 'post refused'
      return { refused: firstError }
    }
    // The setup information Load setup binds to the same post (item 9).
    const freshSetup = chosen.length === 1 ? chosen[0] : null
    const context = freshSetup && posted.combined.operationSpans
      ? buildProgramContext(projectForPost, freshSetup, resolution.dialect, posted.combined.gcode, posted.combined.operationSpans)
      : null
    return { text: posted.combined.gcode, note: ed('control.postedForEdit', { controller: resolution.dialect.label }), context }
  }

  /** The edit in progress, started from the loaded program if there is none. */
  const ensureEditing = (): NonNullable<typeof editing> | null => {
    if (editing) return editing
    const source = textToEdit()
    if ('refused' in source) {
      setLoadError(ed('control.postRefused', { reason: source.refused }))
      return null
    }
    if (source.note) useMachineControl.getState().pushConsole('tx', source.note, 'info')
    const started = { name: job.name ?? 'program', base: source.text, text: source.text, context: source.context, refusal: null, note: source.note }
    setLiveMarks([])
    setEditing(started)
    return started
  }

  /** Open the editor over the preview, at a LISTING line (mapped into the
   *  edit's numbering) and with a tool open. */
  const openEditor = (listed: number | null = null, tool: GcodeEditorToolRequest['kind'] | null = null) => {
    const current = ensureEditing()
    if (!current) return
    setInsertAfter(null)
    setEditorOpen(true)
    const line = listed === null ? null : editLineOf(current, listed)
    if (line !== null) setEditorJump({ line, seq: nextEditorSeq() })
    if (tool !== null && (tool !== 'insert' || line !== null)) setEditorTool({ kind: tool, line: line ?? undefined, seq: nextEditorSeq() })
  }

  /** A line of the loaded program, in the staged text's numbering: every
   *  change wholly above it moves it by what that change added or removed. */
  const stagedLineOf = (current: NonNullable<typeof editing>, loadedLine: number): number => {
    let shift = 0
    for (const h of lineChanges(current.base, current.text).hunks) {
      const above = h.beforeCount === 0 ? h.beforeStart <= loadedLine : h.beforeStart + h.beforeCount - 1 < loadedLine
      if (above) shift += h.afterCount - h.beforeCount
    }
    return loadedLine + shift
  }

  /** A listing line's program line, in the edit's numbering. A text listing
   *  with staged edits shows the staged text itself; otherwise the listing
   *  shows the loaded program, whose numbers the staged text has moved. */
  const editLineOf = (current: NonNullable<typeof editing>, listed: number): number =>
    programText !== null && listingShowsStaged ? listed : stagedLineOf(current, listed)

  /** Insert line, from the listing's inline field: stage `line` after the
   *  program's line `after` (listing numbering). */
  const stageInsertedLine = (after: number, line: string) => {
    if (programRunsOrHolds(useMachineControl.getState())) return
    const current = ensureEditing()
    if (!current) return
    const at = editLineOf(current, after)
    const rows = current.text.split(/\r?\n/)
    rows.splice(Math.min(Math.max(0, at), rows.length), 0, line)
    setEditing({ ...current, text: withLineEndingsOf(current.base, rows.join('\n')) })
  }

  const applyEdit = () => {
    if (!editing || programRunsOrHolds(useMachineControl.getState()) || editing.text === editing.base) return
    const summary = describeEdit(editing.base, editing.text)
    // Item 9: the program's setup information follows the edit (its spans
    // moved, its digest the edited text's) rather than being dropped.
    const context = programContextForEdit(editing.base, editing.text, editing.context)
    // A comment cannot revoke the loaded program's run-through choice (review 10-07, ninth).
    const snap = loadedSetupSource.current
    // The loaded program's own record first (it survives every Apply - review 10-07, tenth);
    // a setup load through the toolpath queue keeps it on the snapshot instead.
    const runThrough = loadedProgramRunsThroughOffsetChanges()
      || (!!snap && !!stagedProgram && snap.setupIds === stagedSetupIds(stagedProgram) && snap.runThrough)
    const outcome = applyProgramRef.current(editing.name, editing.text, true, context, runThrough)
    if (outcome.door === 'program' && !outcome.ok) {
      // Refused whole: the program loaded before is still the loaded one.
      useMachineControl.getState().pushConsole('tx', ed('control.refused', { reason: outcome.reason ?? '' }), 'error')
      setEditing({ ...editing, refusal: { text: editing.text, mark: markFromRefusal(outcome.reason ?? '') } })
      setEditorOpen(true)
      return
    }
    useMachineControl.getState().pushConsole('tx', ed('control.edited', { summary }), 'info')
    const lineReason = outcome.reason !== null && /^line \d+/i.test(outcome.reason) ? outcome.reason : null
    if (lineReason !== null) {
      // Loaded, and its checks stop at a line: keep the editor open on it.
      setEditing({ ...editing, base: editing.text, context, refusal: { text: editing.text, mark: markFromRefusal(lineReason) }, note: null })
      setEditorOpen(true)
      return
    }
    setEditing(null)
    setEditorOpen(false)
  }

  const discardEdits = () => {
    setEditing(null)
    setEditorOpen(false)
    setInsertAfter(null)
  }

  const saveEdited = () => {
    if (!editing) return
    const name = /\.[A-Za-z0-9]{1,6}$/.test(editing.name) ? editing.name : `${editing.name}.nc`
    void saveFile(name, editing.text, 'text/plain')
    useMachineControl.getState().pushConsole('tx', ed('control.savedFile', { name }), 'info')
  }

  /** Run from here, from a line menu: the existing plan, exactly as the
   *  hover button and the From line field reach it. */
  const runFromHere = (line: number) => {
    setEditorOpen(false)
    setRunFromLine(line)
    void planRunFrom(line)
  }

  // A setup staged from its toolpaths lists steps, not text lines, so its
  // listing lines open the editor (the setup posted as text) without a line.
  const listingHasText = programText !== null || (stagedProgram !== null && loadedProgramText() !== null)

  /** Insert line from the listing: the inline field under that row, or -
   *  with the editor open, or no text line to put it after - the editor's
   *  own Insert line. */
  const insertFromListing = (listingLine: number, editLine: number | null) => {
    if (editorOpen || editLine === null) {
      openEditor(editLine, 'insert')
      return
    }
    if (!ensureEditing()) return
    setInsertText('')
    setInsertAfter({ listingLine, editLine })
  }

  /** The right-click menu of one listing line (the operator's amendment, 10-06). */
  const listingMenuItems = (menu: NonNullable<typeof lineMenu>): GcodeLineMenuItem[] => {
    const editLine = listingHasText ? menu.sourceLine ?? menu.line : null
    const items: GcodeLineMenuItem[] = []
    if (runFromText && !streaming) {
      items.push({
        id: 'runfrom',
        label: ed('menu.runFromHere'),
        disabled: !menu.pickable,
        onSelect: () => { if (menu.sourceLine !== null) runFromHere(menu.sourceLine) },
      })
    }
    if (!programHeld) {
      items.push({ id: 'insert', label: ed('menu.insertLine'), separated: true, onSelect: () => insertFromListing(menu.line, editLine) })
    }
    items.push(
      { id: 'find', label: programHeld ? ed('menu.find') : ed('menu.findReplace'), separated: programHeld, onSelect: () => openEditor(editLine, 'find') },
      { id: 'goto', label: ed('menu.goToLine'), onSelect: () => openEditor(editLine, 'goto') },
    )
    return items
  }

  /** The editor's own line menu leads with Run from here while the editor
   *  shows exactly the program the plan reads. */
  const editorLineActions = (line: number) => {
    if (!runFromText || streaming || !editing || stagedEdits || editing.base !== runFromText) return []
    const text = runFromLines[line - 1] ?? ''
    return [{
      id: 'runfrom',
      label: ed('menu.runFromHere'),
      disabled: line < 2 || !isSendableGcodeLine(text),
      onSelect: runFromHere,
    }]
  }

  /** Close the editor. Staged edits stay staged (the Apply / Discard place
   *  keeps them); an edit with none ends with it. */
  const closeEditor = () => {
    setEditorOpen(false)
    if (!stagedEdits) setEditing(null)
  }

  const stagedPlace = stagedEdits ? (
    <span className="gce-staged" data-testid="control-editor-staged">
      <span className="gce-control-summary" data-testid="control-editor-summary">{stagedSummary}</span>
      <button
        className="modal-btn modal-btn-primary gce-btn"
        data-testid="control-editor-apply"
        disabled={programHeld}
        data-tooltip={programHeld ? ed('control.runningReadOnly') : ed('control.applyTip')}
        onClick={applyEdit}
      >
        {ed('control.apply')}
      </button>
      <button
        className="modal-btn modal-btn-ghost gce-btn"
        data-testid="control-editor-discard"
        data-tooltip={ed('control.discardTip')}
        onClick={discardEdits}
      >
        {ed('control.discard')}
      </button>
    </span>
  ) : null

  // Holding at a tool change: the hold is AT the change's own line, or it is
  // not a tool change. WO-1997: a cursor window near an M6 read the post's M0
  // after it as the same M6 again; the session names the pause held at.
  const holdsSeen = useMachineControl((s) => s.holdsSeen)
  const heldLine = machineState === 'hold' && programText ? textProgramHoldLine(programText, job, holdsSeen) : null
  const holdingToolChange = heldLine === null || textM6WasAnswered(heldLine)
    ? undefined
    : job.toolChanges.find((tc) => tc.sourceLine === heldLine)
  const nextToolChange = streaming
    ? job.toolChanges.find((tc) => tc.sourceLine > job.ackedSourceLine)
    : undefined

  // Guided tool change (stage 12): prerequisites, checked up front so the
  // button explains exactly what is missing instead of failing later.
  // WO-1670: parks and safe Z are the machine definition's.
  const parkList = machineParkList(parkMachine, actionsCfg)
  const tcPark = toolChangePark(parkMachine, actionsCfg, parkList)
  // WO-1681 fix round 2: the macro flag is the one source now - the pre-1681
  // wiring-store `toolChangeParkId` fallback is gone.
  const automaticM6Park = toolChangeMacroPark(parkMachine, parkList)
  const safeZ = machineSafeZValue(parkMachine, actionsCfg)
  // WO-2016: the same answer Load gave when it said a reference is needed.
  const referenceMeasured = referenceToolMeasuredIn(toolTable)
  const guidedBlocked = !holdingToolChange
    ? null
    : holdingToolChange.tool === null
      ? 'The program does not say which tool - swap manually and press CYCLE START.'
      : !tcPark
        ? 'Mark a position macro "used for tool change" on the Macros panel (park it over the probe pad).'
        : safeZ === null
          ? 'Set this machine\'s Safe Z on the Machine tab of its definition first.'
          : !homed
            ? 'The machine is not homed - guided changes need machine coordinates.'
            : !referenceMeasured
              ? 'Measure a reference tool on the pad first (Tools / Probe panel).'
              : null

  const onGuided = () => {
    if (!holdingToolChange || guidedBlocked || !tcPark) return
    void beginGuidedToolChange({
      tool: holdingToolChange.tool,
      resumeLine: textToolChangeResumeLine(programText ?? '', holdingToolChange.sourceLine),
      park: tcPark,
      safeZMachine: safeZ,
    })
  }

  // WO-1369: M6 invokes the configured tool-change macro. The program has
  // already reached its controller hold, so this effect is the M6 event wire;
  // the operator is asked only for the physical cutter swap that software
  // cannot perform. Comment-only M6 text and the legacy M0 "change tool"
  // convention retain their existing manual Guided change button.
  const automaticM6 = useRef<string | null>(null)
  const automaticM6ResumesTextProgram = useRef(false)
  const holdingM6 = holdingToolChange && programText
    ? /(?:^|\s)M0?6(?:\s|$)/i.test(
        (programText.split(/\r?\n/)[holdingToolChange.sourceLine - 1] ?? '')
          .replace(/\([^)]*\)/g, ' ')
          .replace(/;.*$/, ''),
      )
    : false
  useEffect(() => {
    if (!holdingToolChange || !holdingM6 || toolChange) {
      if (machineState !== 'hold') automaticM6.current = null
      return
    }
    const key = `${job.name ?? 'program'}:${holdingToolChange.sourceLine}:${holdsSeen}`
    if (automaticM6.current === key) return
    automaticM6.current = key
    // A sole ordinary park is still available to the manual Guided button,
    // but only an explicitly selected TC park opts this machine into M6 motion.
    if (automaticM6Park === null) return
    if (guidedBlocked !== null || tcPark === null) {
      automaticM6ResumesTextProgram.current = false
      useMachineControl.getState().pushConsole(
        'rx',
        `M6 on line ${holdingToolChange.sourceLine} cannot run the fixed-pad tool change: ${guidedBlocked}`,
        'error',
      )
      return
    }
    useMachineControl.getState().pushConsole(
      'rx',
      `M6 on line ${holdingToolChange.sourceLine}: moving to "${tcPark.label}". Fit T${holdingToolChange.tool}; `
        + 'Continue will probe it, apply its measured length and resume the program.',
      'info',
    )
    automaticM6ResumesTextProgram.current = true
    onGuided()
  }, [automaticM6Park, guidedBlocked, holdingM6, holdingToolChange, holdsSeen, job.name, machineState, tcPark, toolChange])

  // Every measure of the guided change - Continue's first one and each Retry -
  // records the tool and applies its length the same way.
  const applyMeasuredOffset = (tool: number | null | undefined) => (probedMachineZ: number) => {
    if (tool === null || tool === undefined) {
      return { ok: false, reason: 'No tool number to record the measurement against.' }
    }
    const tools = useMachineToolTable.getState()
    // WO-2042: the REFERENCE tool re-measured mid-program. Every other tool's
    // offset is its reading minus the reference's, and the work zero was set
    // against the reference's old reading - so the work zero moves by the
    // difference with it, and no tool cuts anywhere new. Recording the new
    // reading alone (09-26: 48.263 -> 48.292) shifted every tool 0.029 mm.
    const before = tools.tableFor(machineId)
    const previousRef = before.reference === tool ? findTool(before, tool) : undefined
    const previousRefZ = previousRef?.probedMachineZ ?? null
    const refShiftMm = previousRefZ === null ? 0 : probedMachineZ - previousRefZ
    const record = () => {
      useMachineToolTable.getState().recordProbedZ(machineId, tool, probedMachineZ, Date.now())
      if (machine) saveMachineToolRecord(machine)
    }
    // The table never holds the Ref's new reading without the work zero that
    // goes with it: the session records it (`commit`) only once the machine has
    // accepted the work-zero write. Until then the old reading stands; the
    // Ref's own offset is 0 against either reading.
    if (previousRefZ === null) record()
    const line = toolOffsetLine(tools.tableFor(machineId), tool)
    const applied = line.ok && applyToolLengthOffset(line.deltaMm, refShiftMm)
    if (!line.ok) return { ok: false, reason: line.reason }
    if (!applied) return { ok: false, reason: 'The controller refused the length-offset command.' }
    const mm = (v: number) => fmtMachineLength(v, units)
    const signed = (v: number) => {
      const shown = mm(v).replace(/^-(?=[0.]+$)/, '')
      return `${shown.startsWith('-') ? '' : '+'}${shown} ${unitLabel(units)}`
    }
    // WO-2522: the offset change printed is the write the controller takes, not the
    // Ref's shift - on 10-03 a UC100 G54 went 100 -> 100.01 while this line said
    // -0.04, because that controller holds the last tool's length in G54 Z too.
    const write = previousRefZ === null ? null : lastToolLengthWorkOffsetWrite()
    const lengthTakenOut = write === null ? 0 : line.deltaMm - write.toolLengthPartMm
    const refSentence = previousRefZ === null
      ? ''
      : ` T${tool} is the reference tool: its reading changed ${signed(refShiftMm)} from the last measure `
        + `(machine Z ${mm(previousRefZ)} ${unitLabel(units)}), the work zero moves with it and every other tool's offset is unchanged.`
        + (write === null
          ? ' The work offsets are unchanged.'
          : ` The ${write.wcs} Z offset changed ${signed(write.toZ - write.fromZ)} `
            + `(${mm(write.fromZ)} -> ${mm(write.toZ)} ${unitLabel(units)})`
            + (Number(mm(lengthTakenOut)) === 0
              ? '.'
              : `, which includes taking out the ${mm(lengthTakenOut)} ${unitLabel(units)} length of the tool before it - `
                + 'this controller holds tool length in the work offset.'))
    // WO-2025: the one line that says what the measure found and what was applied;
    // the session prints it once the controller has confirmed the offset.
    return {
      ok: true,
      commit: previousRefZ === null ? undefined : record,
      report: `T${tool} measured: contact at machine Z ${mm(probedMachineZ)} ${unitLabel(units)}. `
        + `Tool length offset ${mm(line.deltaMm)} ${unitLabel(units)} applied.`
        + refSentence,
    }
  }

  // WO-1996: a missed measure keeps the card at its M6. Retry measures again;
  // Continue from the M6 resumes once a retry has measured the tool.
  const onGuidedRetry = () => {
    void retryGuidedToolMeasure(probeCfg, applyMeasuredOffset(toolChange?.tool))
  }

  const onGuidedContinue = () => {
    const tool = toolChange?.tool
    const resumeLine = toolChange?.resumeLine ?? 1
    const resumeTextProgram = automaticM6ResumesTextProgram.current
    const retried = toolChange?.step === 'ready'
    void (async () => {
      const continued = retried
        ? await continueGuidedToolChangeAfterRetry()
        : await continueGuidedToolChange(probeCfg, applyMeasuredOffset(tool))
      if (!continued) return
      automaticM6ResumesTextProgram.current = false
      // Geometry M6 resumes its held part inside continueGuidedToolChange, and
      // a manually-invoked guided change keeps its established two-gesture
      // behavior. Only an M6-driven text streamer needs this final release.
      if (!resumeTextProgram || programText === null) return
      if (getMachineController().startJob()) return
      const message = 'The tool was measured and its offset applied, but the controller refused to resume the program.'
      useMachineControl.getState().setToolChange({
        step: 'failed',
        mode: 'toolChange',
        tool: tool ?? null,
        resumeLine,
        message,
        warnings: [],
      })
      useMachineControl.getState().pushConsole('rx', message, 'error')
    })()
  }

  // WO-2580: the move the controller is executing - the 3D view reads the same.
  const cursor = executingProgramMoveId({ job, stagedProgram, executingMoveId, stoppedAtMoveId }, paused)
  // WO-2683: held at the file's M0, the lit row is the M0's own line - the
  // line that holds - not the move before it (machine seat 10-08, v80-m0.nc:
  // lit on line 6, held on line 7). Only a listing of the file's lines has it.
  // CYCLE START at the M0 runs on, but until the controller names the next
  // move the move it names is still the one before the M0 - the M0 stays lit
  // rather than the highlight stepping back to it. Another boundary holding
  // next (a tool change with no move between) is no longer the M0: it keeps
  // its own highlight.
  const heldM0 = listingShowsStaged || !executingProgramMoveShown(job.phase, paused) ? null : programM0HoldLine()
  const otherBoundaryHolds = heldM0 === null && programPartsTransportState()?.held === true
  const [m0HeldAt, setM0HeldAt] = useState<{ line: number; cursor: number | null } | null>(null)
  const m0HeldNow = heldM0 !== null
    ? (m0HeldAt?.line === heldM0 && m0HeldAt.cursor === cursor ? m0HeldAt : { line: heldM0, cursor })
    : m0HeldAt !== null && (!streaming || listingShowsStaged || otherBoundaryHolds || cursor !== m0HeldAt.cursor)
      ? null
      : m0HeldAt
  if (m0HeldNow !== m0HeldAt) setM0HeldAt(m0HeldNow)
  const m0HoldLine = m0HeldNow?.line ?? null
  const m0HoldRow = m0HoldLine === null
    ? -1
    : lines.findIndex((line) => line.lineNumber === m0HoldLine)
  const cursorLine = m0HoldRow >= 0
    ? m0HoldRow + 1
    : cursor === null
      ? 0
      : lines.findIndex((line) => listingRowIsMove(line, cursor)) + 1
  const windowStart =
    streaming || job.phase === 'complete' || paused !== null
      ? Math.max(0, cursorLine - Math.floor(FOLLOW_WINDOW / 4))
      : 0
  const visible = lines.slice(windowStart, windowStart + FOLLOW_WINDOW)

  // WO-037/WO-040: while the machine is RUNNING (phase 'streaming' only -
  // paused and idle browsing are never auto-scrolled), keep the active row
  // vertically centered. The operator's own scroll wins - whether it happens
  // while streaming OR during a feed hold - and centering resumes after a
  // short idle (followScroll.ts owns the pure math + override state machine).
  const running = job.phase === 'streaming'
  const listRef = useRef<HTMLDivElement | null>(null)
  const followRef = useRef(initialFollowScroll())

  // A new run always starts following; an override never leaks into the next job.
  useEffect(() => {
    followRef.current = initialFollowScroll()
  }, [job.startedAt])

  useEffect(() => {
    if (!running) return
    const el = listRef.current
    if (!el || !isFollowing(followRef.current, Date.now())) return
    const row = el.querySelector<HTMLElement>('.gcode-line-hl')
    if (!row) return
    // scrollTop needs the row's top in CLIENT-AREA coordinates. The list is
    // not the row's offset parent (it has no CSS position), so offsetTop is
    // document-relative; rect deltas + scrollTop are list-local by
    // construction, whatever the stylesheet does (WO-040 finding 1). Rects
    // are border-box while scrollTop/clientHeight are client-area, so the
    // top border (clientTop) must come off too - .control-gcode-list has a
    // 1px border that otherwise shifts every centering by 1px (WO-044).
    const rowRect = row.getBoundingClientRect()
    const rowTop = rowRect.top - el.getBoundingClientRect().top - el.clientTop + el.scrollTop
    const top = centeredScrollTop(rowTop, rowRect.height, el.clientHeight, el.scrollHeight)
    followRef.current = markApplied(followRef.current, top)
    el.scrollTop = top
  }, [running, cursor])

  const progressPhase = paused !== null || (job.phase === 'streaming' && machineState === 'hold') ? 'paused' : job.phase
  const progressElapsedMs = useProgramProgressElapsedMs(progressPhase, job.startedAt, job.pausedAt)
  const programDistance = useMemo(
    () => programText
      ? textProgramDistance(programText)
      : stagedProgram
        ? stagedProgramDistance(stagedProgram)
        : { mode: 'move-count', cursors: [], cumulative: [], total: 0 } satisfies ProgramDistanceSeries,
    [programText, stagedProgram],
  )
  const shownDistance = completedProgramDistance(
    programDistance,
    paused?.cursor ?? stoppedAt?.line ?? job.ackedSourceLine,
    shownAcked,
  )
  // A Run from line / Step Back job gets a fresh startedAt, but the estimate
  // still describes the whole program. Do not divide the resumed slice's clock
  // by that whole-program estimate; its absolute source-line distance remains
  // comparable with the whole program and is the truthful fallback.
  const progressEstimateMs = paused !== null || (armedFromLine !== null && armedFromLine > 1)
    ? null
    : programEstimateMs
  const pct = deriveOperatorProgramPercent({
    phase: progressPhase,
    elapsedMs: progressElapsedMs,
    estimatedMs: progressEstimateMs,
    completedDistance: shownDistance,
    totalDistance: programDistance.total,
    completedMoves: shownAcked,
    totalMoves: shownTotal,
  })

  // WO-414 (Operator 2026-08-21, from the same conversation: "the top bar names
  // the setup twice"): a program posted from a setup used to show its name
  // ("Setup 4 (posted)") AND the context chip named the same setup again
  // ("Setup: Setup 4 (G57)"). When the context chip is CURRENT for a posted
  // program, it already says everything the name span said, so the name span
  // drops and the chip becomes the one place that says it: "Setup 4 (G57) -
  // posted" for one setup, "Setup: A -> B (G54, G55) - posted" for several
  // (the WO-412 form keeps its "Setup: " label there - it is naming a list,
  // not standing in for a single program name). A plain file load (no setup,
  // or a stale/foreign context) still shows job.name as its own span.
  const postedFromSetup = !!job.name && job.name.endsWith(' (posted)')
  const openedFileListing = !!job.name && !!stagedProgram && !job.name.endsWith(' (toolpath)')
  const fileSectionFrames = openedFileListing
    ? stagedProgram.setups.map((setup) => setup.wcs).join(' -> ')
    : ''
  const fileSectionLabel = openedFileListing
    ? `${job.name} - ${stagedProgram.setups.length} ${stagedProgram.setups.length === 1 ? 'section' : 'sections'} (${fileSectionFrames})`
    : null
  const mergeSetupChip = postedFromSetup && contextComparison === 'current' && !!programContext
  const mergedIsMulti = mergeSetupChip && isMultiSetupProgramContext(programContext)
  const mergedChipLabel = mergeSetupChip
    ? mergedIsMulti
      ? `${programContextSetupChipLabel(programContext)} - posted`
      : (() => {
          const only = programContextSetups(programContext)[0]
          return `${only.setup.name} (${only.wcs.label}) - posted`
        })()
    : null
  const bindingSentence = mergedIsMulti
    ? `This program is bound to the ${isMultiSetupProgramContext(programContext) ? programContext.setups.length : 0} setups it was posted from, in order.`
    : 'This program is bound to the setup it was posted from.'
  const mergedChipTooltip = mergeSetupChip
    ? `${mergedChipLabel}${
        meta ? ` - ${meta.load.lines.length} lines; ${meta.load.skipped} will not be sent (comments, blanks, program markers)` : ''
      }. ${bindingSentence}`
    : null
  // The combined-setup run exists from successful load through its final
  // stage. The narrower transport snapshot exists only between parts, so it
  // cannot decide whether this chip belongs before start or during a stage.
  // Opened-file listings have no combined-setup run and keep their file label.
  // WO-2680: a plain file the session split into sections at its M0s and
  // output words is still one file. With no section to name - before the
  // start, after a Stop - its header names the file ("v68-m7-m9.nc - 3
  // sections"), never every internal section ("File section 1 + File section
  // 2 + ..."; machine seat 10-08). A posted program keeps its header.
  const chipMoveId = stagedSetupChipMoveId(job, cursor)
  const plainFileNamesItself = openedFileListing && !postedFromSetup && chipMoveId === null
  const sectionChipLabel = paused !== null && paused.cursor !== null
    ? stagedSetupChipLabel(stagedProgram, paused.cursor, paused.state)
    : job.phase === 'complete' && stagedProgram
      ? stagedSetupChipLabel(stagedProgram, stagedProgram.program.steps.at(-1)?.id ?? null, 'finished')
    : combinedSetupProgramActive() && !plainFileNamesItself
      // WO-2580: the section of the move the controller is at - the highlight's.
      ? stagedSetupChipLabel(stagedProgram, chipMoveId,
          job.phase === 'paused' || machineState === 'hold' ? 'held'
            : job.phase === 'streaming' || machineState === 'run' ? 'running' : 'ready')
      : null
  // WO-2680 (review): while it runs, holds, pauses or finishes, the file's
  // name still leads; the section and its state follow it
  // ("v68-m7-m9.nc - File section 2 (G54) running").
  const stagedChipLabel = sectionChipLabel !== null && openedFileListing && !postedFromSetup
    ? `${job.name} - ${sectionChipLabel}`
    : sectionChipLabel

  return (
    <section className="panel control-panel control-program-panel">
      <div className="panel-body control-program-body">
        {/* ONE compact controls row - never grows, never wraps the preview down. */}
        <div className="control-program-source">
          {/* WO-414 batch 3b (Operator 2026-08-21, verbatim: "it should be much
              simpler... a pop-out, not having to move things around on the
              screen"): the Load menu is a floating popover anchored under this
              button, absolutely positioned OVER the content - nothing below
              or beside it reflows when it opens or closes. Same floating-
              surface treatment as the intended-stock popover in
              ProgramPreview.tsx (.control-intended-stock-popover). */}
          <div className="control-load-menu-anchor" ref={loadMenuRef}>
            <button
              className={`modal-btn modal-btn-ghost control-load-menu-btn ${loadMenuOpen ? 'control-chip-active' : ''}`}
              data-testid="control-load-menu"
              aria-haspopup="menu"
              aria-expanded={loadMenuOpen}
              disabled={streaming}
              onClick={() => setLoadMenuOpen((v) => !v)}
              data-tooltip="Load a program: post a setup, open a file, or pick a recent program"
            >
              <FolderGit2 size={13} /> Load <ChevronDown size={12} />
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".nc,.gcode,.ngc,.tap,.txt"
              data-testid="control-file-input"
              style={{ display: 'none' }}
              onChange={(e) => {
                const f = e.target.files?.[0]
                if (f) loadFromFile(f)
                e.target.value = ''
              }}
            />
            {loadMenuOpen && (
              <div className="control-load-menu" role="menu" data-testid="control-load-menu-panel">
                <div className="control-load-menu-group" data-testid="control-load-menu-setups">
                  <span className="control-load-menu-label">Load setup</span>
                  {setups.length === 0 ? (
                    <span className="control-load-menu-empty">No setups in project</span>
                  ) : (
                    setups.map((s) => (
                      <button
                        key={s.id}
                        role="menuitem"
                        className="control-load-menu-item"
                        data-testid={`control-load-setup-item-${s.id}`}
                        data-tooltip={`Post "${s.name}" and load it for sending`}
                        onClick={() => {
                          setLoadMenuOpen(false)
                          void loadFromSetup(s.id)
                        }}
                      >
                        {s.name}
                      </button>
                    ))
                  )}
                  {canLoadAllSetups && (
                    <button
                      role="menuitem"
                      className="control-load-menu-item"
                      data-testid="control-load-all-setups"
                      // WO-1329 audit: the help text follows the box next to it.
                      // With the box ticked - which is how the menu opens - this
                      // action loads a program that does NOT hold, so it must not
                      // promise a stop the operator would then wait for.
                      data-tooltip={
                        `Load all ${setups.length} setups as one program - each runs in its own work `
                        + (continueThroughSetups
                          ? 'offset, and the program runs straight through from one to the next '
                            + 'without stopping'
                          : 'offset, and the program holds between them so the work can be re-set')
                      }
                      onClick={() => {
                        setLoadMenuOpen(false)
                        void loadFromAllSetups()
                      }}
                    >
                      All {setups.length} setups
                    </button>
                  )}
                  {canLoadAllSetups && (
                    <label
                      className="control-load-menu-item"
                      data-tooltip={
                        'Run straight from one setup into the next without stopping. Off holds the '
                        + 'program at every boundary so the work can be re-set. A program that '
                        + 'changes tool between setups never runs through, either way.'
                      }
                    >
                      <input
                        type="checkbox"
                        data-testid="control-load-all-setups-continue"
                        checked={continueThroughSetups}
                        onChange={(e) => setContinueThroughSetups(e.target.checked)}
                      />
                      Continue through the setups
                    </label>
                  )}
                </div>
                <div className="control-load-menu-group control-load-menu-divider">
                  <button
                    role="menuitem"
                    className="control-load-menu-item"
                    data-testid="control-open-file"
                    data-tooltip="Load a g-code file from disk"
                    onClick={() => {
                      setLoadMenuOpen(false)
                      fileInputRef.current?.click()
                    }}
                  >
                    <FileUp size={13} /> Open file...
                  </button>
                </div>
                <div
                  className="control-load-menu-group control-load-menu-divider"
                  data-testid="control-load-menu-recent"
                >
                  <span className="control-load-menu-label">Recent ({recent.length})</span>
                  {recent.length === 0 ? (
                    <span className="control-load-menu-empty">none yet</span>
                  ) : (
                    // Cap the visible list to ~7 - a scrolling wall of every
                    // program ever loaded is not a "pick something recent" menu.
                    recent.slice(0, 7).map((r) => (
                      <button
                        key={r.id}
                        role="menuitem"
                        className="control-load-menu-item"
                        data-testid={`control-recent-item-${r.id}`}
                        data-tooltip={`${r.name} - ${new Date(r.savedAt).toLocaleString()} (${Math.ceil(r.size / 1024)}k)`}
                        onClick={() => {
                          setLoadMenuOpen(false)
                          loadFromRecent(r.id)
                        }}
                      >
                        {r.name}
                      </button>
                    ))
                  )}
                </div>
              </div>
            )}
          </div>
          {showProgramReadouts && job.name && !mergeSetupChip && !openedFileListing && (
            <span
              className="control-program-name"
              data-testid="control-program-name"
              data-skipped={meta ? meta.load.skipped : undefined}
              data-tooltip={
                meta
                  ? `${job.name} - ${meta.load.lines.length} lines; ${meta.load.skipped} will not be sent (comments, blanks, program markers)`
                  : job.name
              }
            >
              {job.name}
            </span>
          )}
          {showProgramReadouts && job.name && (
            <span
              className="control-program-context"
              data-testid="control-program-context"
              data-staleness={contextComparison}
              data-skipped={mergeSetupChip && meta ? meta.load.skipped : undefined}
              data-tooltip={
                stagedChipLabel
                  ? `${stagedChipLabel}. This is the setup boundary accepted by the controller.`
                : mergeSetupChip
                  ? mergedChipTooltip
                : openedFileListing
                  ? `This opened file is staged as ${stagedProgram.setups.length} controller ${stagedProgram.setups.length === 1 ? 'section' : 'sections'}, in order: ${fileSectionFrames}.`
                : contextComparison === 'no-context'
                  ? 'This program was loaded from a file and carries no setup information. The app cannot tell which project or setup it came from.'
                  : contextComparison === 'comparison-failed'
                    ? 'The app could not compare this program with the project (an internal error, logged to the console). Do not trust it as current.'
                  : contextComparison === 'current'
                    ? isMultiSetupProgramContext(programContext)
                      ? `This program is bound to the ${programContext.setups.length} setups it was posted from, in order.`
                      : 'This program is bound to the setup it was posted from.'
                    : contextComparison === 'project-changed'
                      ? 'The project changed after this program was posted. Reload from the setup to refresh the context.'
                      : 'The program text no longer matches its posted context.'
              }
            >
              {stagedChipLabel
                ?? (mergeSetupChip
                ? mergedChipLabel
              : openedFileListing
                ? fileSectionLabel
              : contextComparison === 'no-context' || !programContext
                ? 'No setup information'
                : contextComparison === 'comparison-failed'
                  ? 'Cannot verify against project'
                : contextComparison === 'current'
                  // WO-412: "Setup: A -> B (G54, G55)" for a multi-setup program.
                  ? programContextSetupChipLabel(programContext)
                  : contextComparison === 'project-changed'
                    ? 'Setup changed since post'
                    : 'Program changed since post')}
            </span>
          )}
          {surfaceMesh?.active && (
            // WO-416 (Operator: "Do not ever apply a huge vertical pixel stealing
            // banner across the entire screen ... don't do that again"): the
            // full-width "MESH COMPENSATION ACTIVE" strip that used to sit
            // under the tab row is gone. This is the whole replacement - one
            // chip in the row that already exists, zero new rows. Clicking it
            // opens MeshViewerModal, a Mainsail-style orbitable flatness view.
            <button
              type="button"
              className="control-mesh-chip"
              data-testid="control-mesh-chip"
              data-tooltip={`Surface mesh compensation active: ${surfaceMesh.pointsX} x ${surfaceMesh.pointsY} measured points. Click to view the flatness.`}
              onClick={() => useCamStore.getState().openModal('mesh-viewer')}
            >
              <span className="control-mesh-chip-dot" aria-hidden="true" />
              Mesh {surfaceMesh.pointsX}x{surfaceMesh.pointsY}
            </button>
          )}
          <span className="control-program-actions">
            {!!runFromText && runFromLines.length > 0 && !streaming && (
              <span className="control-runfrom-inline">
                <span className="control-field-label">From line</span>
                <input
                  className="mform-input mform-input-sm control-runfrom-input"
                  data-testid="control-runfrom-input"
                  type="text"
                  inputMode="numeric"
                  // 1 is accepted (WO-082): it arms the program from the top
                  // rather than bottoming the spinner out above the only line
                  // an operator restarting a scrapped part actually wants.
                  value={runFromLine}
                  min={1}
                  max={runFromLines.length}
                  placeholder="#"
                  onFocus={(event) => {
                    runFromBeforeEdit.current = runFromLine
                    runFromSelectAll.onFocus(event)
                  }}
                  onMouseUp={runFromSelectAll.onMouseUp}
                  onChange={(event) => {
                    const value = Number(event.target.value)
                    setRunFromLine(Number.isFinite(value) && event.target.value !== '' ? value : '')
                  }}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') event.currentTarget.blur()
                    if (event.key === 'Escape') {
                      setRunFromLine(runFromBeforeEdit.current)
                      event.currentTarget.blur()
                    }
                  }}
                />
                <button
                  className="modal-btn modal-btn-ghost"
                  data-testid="control-runfrom-plan"
                  disabled={runFromLine === ''}
                  onClick={() => void planRunFrom()}
                  data-tooltip="Plan a start at this line (1 arms the whole program from the beginning)"
                >
                  Plan
                </button>
              </span>
            )}
          </span>
        </div>
        {/* WO-1182: the transfer check's refusals, warnings and notes live in
            the console only (COHESION-STANDARD s13); nothing is repeated here. */}
        {(loadError ?? runFromError) && (
          <div
            className="control-connect-error control-load-error-line"
            data-testid="control-load-error"
            title={loadError ?? runFromError ?? undefined}
          >
            {loadError ?? runFromError}
          </div>
        )}

        {/* THE first-class surface: preview + optional narrow rail. */}
        <div className="control-program-main">
          <div className="control-preview-stage">
            <ProgramPreview />

            {editing && editorOpen && (
              <div className="control-overlay-card gce-control-card" data-testid="control-program-editor">
                <div className="gce-control-head">
                  <span className="gce-control-title">{ed('control.title', { name: editing.name })}</span>
                  {stagedPlace}
                  <span className="gce-control-actions">
                    <button
                      className="modal-btn modal-btn-ghost"
                      data-testid="control-editor-save"
                      data-tooltip={ed('control.saveFileTip')}
                      onClick={saveEdited}
                    >
                      {ed('control.saveFile')}
                    </button>
                    <button
                      className="modal-btn modal-btn-ghost"
                      data-testid="control-editor-close"
                      data-tooltip={stagedEdits ? ed('control.closeStagedTip') : ed('control.closeTip')}
                      onClick={closeEditor}
                    >
                      {ed('control.close')}
                    </button>
                  </span>
                </div>
                {editing.note && <div className="gce-control-note" data-testid="control-editor-note">{editing.note}</div>}
                <GcodeEditor
                  value={editing.text}
                  onChange={(text) => setEditing((current) => current && { ...current, text: withLineEndingsOf(current.base, text) })}
                  readOnly={programHeld}
                  readOnlyReason={programHeld ? ed('control.runningReadOnly') : null}
                  marks={editorMarks}
                  jumpTo={editorJump}
                  tool={editorTool}
                  lineActions={editorLineActions}
                  onEscape={closeEditor}
                  testId="control-gcode-editor"
                />
              </div>
            )}
            {/* WO-2651: the ONE compact Apply / Discard place, only while
                edits are staged - over the preview, never a row. */}
            {stagedPlace && !editorOpen && (
              <div className="control-overlay-card gce-staged-card">{stagedPlace}</div>
            )}

            {holdingToolChange && !toolChange && (
              <div
                className="control-overlay-card control-overlay-top control-toolchange-banner"
                data-testid="control-toolchange-banner"
              >
                <span>
                  Tool change - insert{' '}
                  {holdingToolChange.tool !== null ? `T${holdingToolChange.tool}` : 'the next tool'}
                  {/* WO-2016: T0 is a controller's "no tool reported", not a tool in the spindle. */}
                  {activeTool !== null && activeTool > 0 ? ` (current: T${activeTool})` : ''}, then press CYCLE START.
                </span>
                <button
                  className="modal-btn modal-btn-primary control-tc-guided-btn"
                  data-testid="control-guided-toolchange"
                  disabled={!!guidedBlocked}
                  data-tooltip={
                    guidedBlocked ??
                    'Stop cleanly, park over the probe pad, swap, auto-probe the new length, and re-arm the program'
                  }
                  onClick={onGuided}
                >
                  Guided change
                </button>
                {guidedBlocked && <span className="control-tc-blocked">{guidedBlocked}</span>}
              </div>
            )}

            {toolChange && (
              <div
                className={`control-overlay-card control-overlay-top control-toolchange-banner ${
                  toolChange.step === 'failed' ? 'control-tc-failed' : ''
                }`}
                data-testid="control-toolchange-card"
              >
                <div className="control-tc-header">
                  <span className="control-tc-title">
                    {toolChange.mode === 'clampPause' ? 'Park + clamp' : 'Guided tool change'}
                    {toolChange.tool !== null ? ` - T${toolChange.tool}` : ''} (
                    {toolChange.mode === 'clampPause' && toolChange.step === 'awaiting-swap'
                      ? 'fix the clamps'
                      : TC_STEP_LABEL[toolChange.step]}
                    )
                  </span>
                  {toolChange.mode === 'toolChange' && (
                    <ProbeLamp kind="probe" value={probeSignals.probe} testId="toolchange-lamp-probe" />
                  )}
                </div>
                <span data-testid="control-tc-message">{toolChange.message}</span>
                {toolChange.warnings.map((w, i) => (
                  <span key={i} className="control-tc-warning">
                    {w}
                  </span>
                ))}
                <span className="control-tc-actions">
                  {toolChange.mode === 'toolChange' && toolChange.step === 'awaiting-swap'
                    && guidedToolMeasureState()?.missed === true && (
                    <button
                      className="modal-btn modal-btn-primary"
                      data-testid="control-tc-retry"
                      onClick={onGuidedRetry}
                    >
                      Retry measure{toolChange.tool !== null ? ` T${toolChange.tool}` : ''}
                    </button>
                  )}
                  {toolChange.mode === 'toolChange' && toolChange.step === 'ready'
                    && guidedToolMeasureState()?.measured === true && (
                    <button
                      className="modal-btn modal-btn-primary"
                      data-testid="control-tc-continue"
                      onClick={onGuidedContinue}
                    >
                      Continue from the M6
                    </button>
                  )}
                  {toolChange.step === 'awaiting-swap' && guidedToolMeasureState() === null && (
                    <button
                      className="modal-btn modal-btn-primary"
                      data-testid="control-tc-continue"
                      onClick={() => {
                        if (toolChange.mode === 'clampPause') continueClampPause()
                        else onGuidedContinue()
                      }}
                    >
                      {toolChange.mode === 'clampPause'
                        ? 'Continue - re-arm program'
                        : `Continue - probe${toolChange.tool !== null ? ` T${toolChange.tool}` : ''}`}
                    </button>
                  )}
                  {(toolChange.step === 'awaiting-swap' ||
                    toolChange.step === 'ready' ||
                    toolChange.step === 'failed') && (
                    <button
                      className="modal-btn modal-btn-ghost"
                      data-testid="control-tc-cancel"
                      onClick={() => {
                        automaticM6ResumesTextProgram.current = false
                        cancelGuidedToolChangeByOperator()
                      }}
                    >
                      {programToolChangeCanStop() ? 'Stop program' : toolChange.step === 'failed' ? 'Close' : 'Cancel'}
                    </button>
                  )}
                </span>
              </div>
            )}

            {fitTrace && (
              <div
                className={`control-overlay-card control-overlay-top control-toolchange-banner ${
                  fitTrace.step === 'failed' ? 'control-tc-failed' : ''
                }`}
                data-testid="control-fittrace-card"
              >
                <span className="control-tc-title">
                  Material fit trace (
                  {fitTrace.step === 'confirm'
                    ? 'ready'
                    : fitTrace.step === 'tracing'
                      ? 'tracing'
                      : fitTrace.step === 'done'
                        ? 'finished'
                        : 'stopped'}
                  )
                </span>
                <span data-testid="control-fittrace-message">{fitTrace.message}</span>
                <span className="control-fittrace-bounds" data-testid="control-fittrace-bounds">
                  Outline: X {fmtMachineLength(fitTrace.bounds.minX, units)} to{' '}
                  {fmtMachineLength(fitTrace.bounds.maxX, units)}, Y {fmtMachineLength(fitTrace.bounds.minY, units)} to{' '}
                  {fmtMachineLength(fitTrace.bounds.maxY, units)} {unitLabel(units)} (
                  {fmtMachineLength(fitTrace.bounds.maxX - fitTrace.bounds.minX, units)} x{' '}
                  {fmtMachineLength(fitTrace.bounds.maxY - fitTrace.bounds.minY, units)})
                </span>
                {fitTrace.step === 'confirm' && (
                  <div className="control-runfrom-prelude">
                    {fitTrace.lines.map((cmd, i) => (
                      <span key={i} className="control-runfrom-cmd">
                        {cmd}
                      </span>
                    ))}
                  </div>
                )}
                <span className="control-tc-actions">
                  {fitTrace.step === 'confirm' && (
                    <span className="control-next-action-inline">
                      Press CYCLE START to trace the outline. Cancel to go back.
                    </span>
                  )}
                  {fitTrace.step !== 'tracing' && (
                    <button
                      className="modal-btn modal-btn-ghost"
                      data-testid="control-fittrace-cancel"
                      onClick={cancelMaterialFitTrace}
                    >
                      {fitTrace.step === 'confirm' ? 'Cancel' : 'Close'}
                    </button>
                  )}
                </span>
              </div>
            )}

            {job.error && (
              <div
                className="control-overlay-card control-overlay-top control-connect-error"
                data-testid="control-job-error"
              >
                {/* WO-423 (contract v3): a text-streaming backend knows which
                    LINE failed, a geometry backend which MOVE, and a backend
                    with no firmware alarm numbers has no code. Say whichever
                    is actually known rather than printing "line null". */}
                {job.error.line !== null
                  ? `Stopped at line ${job.error.line}`
                  : job.error.moveId !== null
                    ? `Stopped at move ${job.error.moveId}`
                    : 'Stopped'}
                {job.error.code !== null ? `: error ${job.error.code} - ` : ': '}
                {job.error.message}
              </div>
            )}

            {runFromPlan && !streaming && (
              <div
                className="control-overlay-card control-overlay-bottom control-runfrom-plan"
                data-testid="control-runfrom-planbox"
              >
                <div className="control-runfrom-title">
                  Run from line {runFromPlan.startLine} - the machine will first:
                </div>
                {/* The operator must see WHAT resumes and WHERE before any motion. */}
                <div className="control-runfrom-cmd" data-testid="control-runfrom-target">
                  {runFromPlan.startLine}: {runFromLines[runFromPlan.startLine - 1] ?? ''}
                </div>
                {runFromOperation && (
                  <div className="control-homed-hint" data-testid="control-runfrom-operation">
                    Starts in {runFromOperation}.
                  </div>
                )}
                {/* WO-1989: the tool the program has in the spindle at this line - a
                    later M6 in the streamed lines changes it, so it is not "the tool that cuts". */}
                {runFromPlan.tool && (
                  <div className="control-homed-hint" data-testid="control-runfrom-tool">
                    Tool at this line: T{runFromPlan.tool.number} (tool change on line{' '}
                    {runFromPlan.tool.changedOnLine}).
                    {activeTool !== null && activeTool > 0 && activeTool !== runFromPlan.tool.number
                      && runFromPlan.tool.changedOnLine < runFromPlan.startLine
                      ? ` The machine reports T${activeTool} in the spindle.`
                      : ''}
                  </div>
                )}
                <div className="control-homed-hint" data-testid="control-runfrom-resume">
                  Resume position (WCS) X {resumeAxis(runFromPlan.resumePosition.x, units)} Y{' '}
                  {resumeAxis(runFromPlan.resumePosition.y, units)} Z{' '}
                  {resumeAxis(runFromPlan.resumePosition.z, units, runFromPlan.zRest)}
                </div>
                <div className="control-runfrom-prelude">
                  {runFromPlan.prelude.map((cmd, i) => (
                    <span key={i} className="control-runfrom-cmd">
                      {cmd}
                    </span>
                  ))}
                </div>
                {runFromPlan.warnings.map((w, i) => (
                  <div key={i} className="control-homed-hint" data-testid="control-runfrom-warning">
                    {w}
                  </div>
                ))}
                <div className="control-runfrom-actions">
                  {/* WO-2671: one plain next step - what to press and how to back out.
                      No direction word: CYCLE START is not "above" at every layout. */}
                  <span className="control-next-action-inline" data-testid="control-runfrom-next-step">
                    Press CYCLE START to run from line {runFromPlan.startLine}
                    {singleBlock ? ', one block at a time' : ''}. Cancel to go back.
                  </span>
                  <button className="modal-btn modal-btn-ghost" onClick={cancelRunFrom}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </div>

          <ProgramDivider previewPercent={programPreviewPercent} />

          <div
            ref={listRef}
            className="control-gcode-list"
            data-testid="control-gcode-list"
            // Focusable by script only: the line menu hands keyboard focus back here.
            tabIndex={-1}
            style={{
              '--control-gcode-line-number-width': `${Math.max(1, String(lines.length).length)}ch`,
            } as CSSProperties}
            onScroll={(e) => {
              // A run OR a feed hold has follow behavior to override: browsing
              // during a hold must arm the same idle window, or resuming right
              // after would snap-recenter (WO-040 finding 3). Idle browsing is
              // free.
              if (!streaming) return
              followRef.current = observeScroll(
                followRef.current,
                e.currentTarget.scrollTop,
                Date.now(),
              )
            }}
          >
            {!hasProgram ? (
              <div className="panel-empty">
                Load a posted setup or open a g-code file. Everything is checked before a single
                line is sent.
              </div>
            ) : lines.length === 0 ? (
              <div className="panel-empty">This program contains no moves.</div>
            ) : (
              visible.map((line, i) => {
                const lineNo = line.lineNumber
                const isCursor = m0HoldRow >= 0
                  ? windowStart + i === m0HoldRow
                  : executingProgramMoveShown(job.phase, paused) && listingRowIsMove(line, cursor)
                // Line 1 can never be a resume target: there is no modal state
                // to reconstruct ahead of it. Rows the streamer would drop at
                // load (comments, blanks, '%' program markers) get no gesture;
                // the streamer's own predicate decides (WO-006 finding 3,
                // WO-021 % hole).
                // A file staged as moves (the UCCNC door) with no setup information still
                // lists each step at its own file line - the line the From line box plans
                // from - so Run from here uses it (desk kit RED 2, 10-07: it was disabled
                // on every row of an imported .nc on the UCCNC route).
                const sourceLine = programText ? lineNo
                  : line.moveId === null ? null
                    : runFromContext?.lineOfStep(line.moveId) ?? (stagedProgram && loadedProgramText() !== null ? lineNo : null)
                const sourceText = sourceLine === null ? '' : runFromLines[sourceLine - 1] ?? ''
                // WO-2651: a listing showing staged edits is not the program
                // the plan reads; Apply first.
                const pickable = !!runFromText
                  && !streaming
                  && !listingShowsStaged
                  && sourceLine !== null
                  && sourceLine >= 2
                  && isSendableGcodeLine(sourceText)
                // WO-2651: the program line this row edits (null: a setup
                // staged from toolpaths lists steps, not text lines).
                const editLine = listingHasText ? sourceLine ?? lineNo : null
                const staged = lineNo !== null && stagedRows?.has(lineNo)
                return (
                  <Fragment key={windowStart + i}>
                  <div
                    className={`gcode-line ${isCursor ? 'gcode-line-hl' : ''} ${
                      pickable ? 'gcode-line-pickable' : ''
                    }${staged ? ' gcode-line-staged' : ''}${
                      lineMenu !== null && lineNo !== null && lineMenu.line === lineNo ? ' gcode-line-menu-target' : ''}`}
                    onClick={() => {
                      if (pickable) setRunFromLine(sourceLine)
                      // WO-2651: with the editor open, a listing row shows its line there.
                      if (editing && editorOpen && editLine !== null) setEditorJump({ line: editLineOf(editing, editLine), seq: nextEditorSeq() })
                    }}
                    onDoubleClick={() => openEditor(editLine)}
                    data-testid={lineNo !== null ? `control-gcode-line-${lineNo}` : undefined}
                    data-staged={staged ? 'true' : undefined}
                    onMouseEnter={() => setHoverLine(lineNo)}
                    onMouseLeave={() => setHoverLine((h) => (h === lineNo ? null : h))}
                    onContextMenu={(e) => {
                      // WO-2651 (the operator's amendment): right-click opens THIS line's
                      // menu - Run from here (the same plan right-click used to
                      // start), Insert line, Find / Replace, Go to line.
                      if (lineNo === null && editLine === null) return
                      e.preventDefault()
                      setLineMenu({ x: e.clientX, y: e.clientY, line: lineNo ?? editLine ?? 1, sourceLine, pickable })
                    }}
                  >
                    <span className="gcode-lineno">{lineNo}</span>
                    <span className="gcode-linetext">{line.text}</span>
                    {pickable && hoverLine === lineNo && (
                      <button
                        className="modal-btn modal-btn-ghost"
                        data-testid={`control-runfrom-here-${lineNo}`}
                        style={{ marginLeft: 'auto', padding: '0 6px', fontSize: 11 }}
                        onClick={(e) => {
                          e.stopPropagation()
                          if (sourceLine !== null) void planRunFrom(sourceLine)
                        }}
                        data-tooltip="Plan a mid-program start at this line"
                      >
                        Run from here
                      </button>
                    )}
                  </div>
                  {insertAfter !== null && insertAfter.listingLine === lineNo && (
                    // WO-2651: Insert line's inline field, under its row. Enter
                    // stages the line (Apply loads it); Escape drops it.
                    <div className="gcode-line gcode-line-insert">
                      <span className="gcode-lineno">+</span>
                      <input
                        autoFocus
                        className="mform-input mform-input-sm mform-input-mono gce-insert-input"
                        data-testid="control-insert-line-input"
                        aria-label={ed('menu.insertLine')}
                        placeholder={ed('menu.insertPlaceholder', { line: insertAfter.listingLine })}
                        value={insertText}
                        spellCheck={false}
                        onChange={(e) => setInsertText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') {
                            e.preventDefault()
                            if (insertText.trim() !== '') stageInsertedLine(insertAfter.listingLine, insertText)
                            setInsertAfter(null)
                          } else if (e.key === 'Escape') {
                            e.preventDefault()
                            e.stopPropagation()
                            setInsertAfter(null)
                          }
                        }}
                        onBlur={() => setInsertAfter(null)}
                      />
                    </div>
                  )}
                  </Fragment>
                )
              })
            )}
            {lineMenu && (
              <GcodeLineMenu
                at={{ x: lineMenu.x, y: lineMenu.y }}
                title={ed('menu.title', { line: lineMenu.line })}
                items={listingMenuItems(lineMenu)}
                onClose={() => setLineMenu(null)}
                returnFocusTo={() => listRef.current}
                testId="control-line-menu"
              />
            )}
          </div>
        </div>

        <div className="control-transport">
          {/* WO-048 Operator NOTE 3: the single-block explainer moved NEXT TO its
              control - the STEP row under the Single Block toggle - so this
              progress row starts at Park + clamp. */}
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="control-clamp-pause"
            disabled={!streaming || !!toolChange || !tcPark || safeZ === null || !homed || estopLatched}
            data-tooltip={
              estopLatched
                ? ESTOP_BLOCKS_MOTION
                : !tcPark || safeZ === null
                ? "Needs a park macro marked for tool change (Macros panel) and this machine's Safe Z (Machine tab of its definition)"
                : !homed
                  ? machineHasNoHomeSwitches(machine)
                    ? noHomeSwitchesRefusal(
                        'set the machine position first because parking uses machine coordinates.',
                      )
                    : 'Home the machine first - parking uses machine coordinates'
                  : 'Stop cleanly and park so you can reposition clamps, then resume where it left off'
            }
            onClick={() => {
              if (!tcPark) return
              // Capture the resume anchor BEFORE the stop clears progress. A
              // few already-executed buffered lines may re-run: air cutting,
              // the safe direction.
              const resumeLine = Math.max(2, job.ackedSourceLine)
              void beginClampPause({ resumeLine, park: tcPark, safeZMachine: safeZ })
            }}
          >
            Park + clamp
          </button>
          <button
            className="modal-btn modal-btn-ghost"
            data-testid="control-fittrace"
            disabled={
              !connected ||
              streaming ||
              machineState !== 'idle' ||
              !hasProgram ||
              !homed ||
              safeZ === null ||
              !!toolChange ||
              !!fitTrace
            }
            data-tooltip={
              !hasProgram
                ? 'Load a program first'
                : safeZ === null
                  ? "Set this machine's Safe Z on the Machine tab of its definition first."
                  : !homed && connected
                    ? machineHasNoHomeSwitches(machine)
                      ? noHomeSwitchesRefusal(
                          'set the machine position first because the trace raises to a machine-coordinate safe Z.',
                        )
                      : 'Home the machine first - the trace raises to a machine-coordinate safe Z'
                    : "Trace the job's XY outline at safe Z, pausing at each corner - verify stock and clamps before cutting"
            }
            onClick={() => {
              const rapid = controlMachine(useCamStore.getState()).rapidRate ?? 3000
              const prepared = prepareMaterialFitTrace(safeZ, defaultTraceFeed(rapid))
              if (!prepared.ok) setLoadError(prepared.reason ?? 'The fit trace was refused.')
              else setLoadError(null)
            }}
          >
            <Scan size={13} /> Fit trace
          </button>
          {showProgramReadouts && <div className="control-progress">
            {operationProgress && (
              <span
                className="control-operation"
                data-testid="control-operation"
                data-state={operationProgress.state}
                data-operation-index={operationProgress.current?.index ?? 0}
                data-operation-status={operationProgress.current?.status ?? 'none'}
                data-expanded={operationListExpanded ? 'true' : 'false'}
              >
                <span className="control-operation-headline" data-testid="control-operation-headline">
                  {operationProgress.headline}
                </span>
                {/* Operator review 2026-08-20: "collapse details by default, expand
                    for details" - the per-operation list is a disclosure under
                    the row (same chevron family as the panel headers), not a
                    tooltip. The choice lives in machineControlStore for the
                    session (never persisted). */}
                <button
                  type="button"
                  className="panel-action-btn control-operation-toggle"
                  data-testid="control-operation-toggle"
                  aria-expanded={operationListExpanded}
                  aria-controls="control-operation-list"
                  aria-label={operationListExpanded ? 'Hide the operation list' : 'Show every operation'}
                  data-tooltip={
                    operationListExpanded
                      ? 'Hide the operation list'
                      : `Show all ${operationProgress.total} operations`
                  }
                  onClick={() => useMachineControl.getState().setOperationListExpanded(!operationListExpanded)}
                >
                  {operationListExpanded ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                </button>
              </span>
            )}
            <div className="control-progress-bar">
              <div data-testid="control-progress-fill" className="control-progress-fill" style={{ width: `${pct}%` }} />
            </div>
            <span className="control-progress-text" data-testid="control-progress-text">
              {shownTotal > 0
                ? `${shownAcked}/${shownTotal} (${pct}%)${
                    paused === null && job.phase === 'complete' && job.startedAt !== null && job.endedAt != null
                      ? ` done in ${runLengthSeconds(job.startedAt, job.endedAt)}s`
                      : ''
                  }${nextToolChange ? ` | next: ${nextToolChange.label} @ line ${nextToolChange.sourceLine}` : ''}`
                : 'no program'}
            </span>
            <RunClock
              phase={progressPhase}
              startedAt={job.startedAt}
              pausedAt={job.pausedAt}
              // Only a current post's estimate counts down by elapsed; a
              // resumed run's whole-program count does not describe it.
              estimatedMs={resumedEstimate && ownMoveEstimate ? null : programEstimateMs}
              movesLeft={movesLeft}
            />
          </div>}
          {operationProgress && operationListExpanded && (
            <ol
              id="control-operation-list"
              className="control-operation-list"
              data-testid="control-operation-list"
              aria-label="Operations in this program"
            >
              {operationProgress.entries.map((e) => (
                <li
                  key={e.index}
                  className="control-operation-item"
                  data-testid="control-operation-item"
                  data-status={operationItemStatus(e.status, operationProgress.state)}
                  data-operation-index={e.index}
                >
                  <span className="control-operation-item-index">{e.index}.</span>
                  <span className="control-operation-item-name">
                    {e.setup && isMultiSetupProgramContext(programContext) ? `${e.setup.name}: ` : ''}
                    {e.operation.name} ({operationKindLabel(e.operation.type)})
                  </span>
                  <span className="control-operation-item-lines">
                    lines {e.operation.startLine}-{e.operation.endLine}
                  </span>
                  <span className="control-operation-item-status" data-testid="control-operation-item-status">
                    {operationItemStatus(e.status, operationProgress.state)}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      </div>
    </section>
  )
}
