import { operatorText } from '../i18n/locales/en/console-and-operator-messages'
// Machine-control runtime store - a SEPARATE zustand store (uiPrefs pattern),
// deliberately NOT a slice of useCamStore: nothing here is project data, and
// none of it may ever persist (a "connected" state must not rehydrate from
// localStorage). The GrblController instance lives module-side in
// machineSession.ts; this store holds only render-ready snapshots it emits.

import { create, type StateCreator } from 'zustand'
import { jobInFlight, streamedToolChange } from '../lib/machine/currentTool'
// WO-422 (ADR-0041): the connection lifecycle and the progress shape are the
// CONTRACT's, not GRBL's. WO-423 closes the last one: a failed run carries the
// contract's JobFault, so nothing here imports from grbl/ any more.
import type {
  ConnectionPhase,
  ConsoleEntry,
  ControllerBridgeHello,
  JobFault,
  MachineProgram,
  MachineStatus,
  StreamerPhase,
  StreamerProgress,
} from '../lib/machine/controller'
import type {
  AccessoryState,
  GrblOffsetEntry,
  GrblParserState,
  MachinePosition,
  MachineState,
  WcsId,
} from '../lib/machine/types'
import type { SurfaceMeshMap } from '../lib/machine/zSurfaceMesh'
import {
  assertProgramContextMatchesProgram,
  describeOperationAtProgress,
  freezeProgramContext,
  type ProgramContextComparison,
  type ProgramContextV1,
} from '../lib/machine/programContext'

export interface StagedProgramSetup {
  setupName: string
  /** The project setup this section came from (absent for a file's sections) -
   *  names are not unique, ids are (WO-2651 review 10-07). */
  setupId?: string
  wcs: WcsId
  /** Id of the first step belonging to this setup. */
  firstStepId: number
}

/** The exact geometry program accepted by the session, plus the frame lines
 *  the read-only operator listing needs. It is session state, never project
 *  data and never another controller payload. */
export interface StagedProgramView {
  program: MachineProgram
  setups: StagedProgramSetup[]
  /** Operator file lines by step id. Absent for geometry without file text. */
  sourceLines?: Readonly<Record<number, number>>
  /** WO-2580: steps the controller runs that are no line of the file - the
   *  zero-second dwell a section with no motion is staged as (an M0 right
   *  after `T# M6`, WO-2556 / 704c5093e). No display shows them: no row, not
   *  the move the controller is at, not counted. */
  unlistedStepIds?: readonly number[]
}

const unlistedCache = new WeakMap<StagedProgramView, { ids: Set<number>; positions: number[] }>()
function unlistedOf(view: StagedProgramView): { ids: Set<number>; positions: number[] } | null {
  if (!view.unlistedStepIds?.length) return null
  let found = unlistedCache.get(view)
  if (!found) {
    const ids = new Set(view.unlistedStepIds)
    const positions: number[] = []
    view.program.steps.forEach((step, index) => { if (ids.has(step.id)) positions.push(index) })
    found = { ids, positions }
    unlistedCache.set(view, found)
  }
  return found
}

/** WO-2580: whether a step id is one the listing shows (see `unlistedStepIds`). */
export function isListedStep(view: StagedProgramView | null, id: number): boolean {
  return view === null || !(unlistedOf(view)?.ids.has(id) ?? false)
}

/** WO-2580: a count of the staged program's steps (done or total, in its
 *  order) as the file's: less the unlisted steps among them. */
export function listedStepCount(view: StagedProgramView | null, count: number): number {
  const unlisted = view === null ? null : unlistedOf(view)
  if (unlisted === null) return count
  let before = 0
  while (before < unlisted.positions.length && unlisted.positions[before] < count) before++
  return count - before
}

export interface MachineConsoleLine {
  id: number
  dir: 'tx' | 'rx'
  text: string
  // Contract v4 (WO-426): the CONTRACT's own union - info/command/warn/error -
  // covers both GRBL's vocabulary (info/command/error) and the generic
  // backend vocabulary (info/warn/error) that used to need collapsing here.
  severity: ConsoleEntry['severity']
  /** Store-owned push time. Optional only for rows restored from older state. */
  at?: number
}

export type OverrideChannel = 'feed' | 'rapid' | 'spindle'
export type OverrideAvailability = 'unknown' | 'supported' | 'unsupported'
export type OverrideAvailabilityState = Record<OverrideChannel, OverrideAvailability>

const UNKNOWN_OVERRIDE_AVAILABILITY: OverrideAvailabilityState = {
  feed: 'unknown',
  rapid: 'unknown',
  spindle: 'unknown',
}

const UNKNOWN_OVERRIDES = { feed: null, rapid: null, spindle: null }

/** Operator, 2026-09-03, after running his machine: "when I started up it didn't
 *  default to g54. I had to click it from the work offsets panel. It should
 *  default to g54 unless told otherwise." G54 is what every controller powers
 *  up in, so this is the honest model rather than a guess - a controller's own
 *  modal report (`applyParserState`) or the operator's own press
 *  (`selectWorkOffset`) overrides it, which is the "unless told otherwise". */
const DEFAULT_WCS: WcsId = 'G54'

/** Guided tool-change steps reached only after the operator confirmed the new
 *  tool is fitted (Continue at 'awaiting-swap'). */
const TOOL_FITTED_STEPS: ReadonlySet<ToolChangeStep> = new Set(['probing', 'arming', 'ready'])

export interface MachineAlarm {
  /** Null on a controller with no firmware alarm numbers (the simulator, the
   *  bridge's decoded status word). Contract v3 types it nullable for exactly
   *  that, and the banner shows the MESSAGE either way. */
  code: number | null
  message: string
  positionLost: boolean
}

export type BridgeSocketPresence = 'open' | 'closed'
export type BridgeControllerPresence = 'live' | 'lost' | 'unknown'
export type BridgeProcessPresence = 'running' | 'stopped' | 'gave-up' | 'unknown'

export interface BridgePresence {
  socket: BridgeSocketPresence
  /** Reserved for WO-1130's controller-liveness frame. Never infer it from
   * the websocket or process: both can be healthy around a dead board handle. */
  controller: BridgeControllerPresence
  process: BridgeProcessPresence
}

/** The one three-source resolver. Socket is the app's own transport fact;
 * process is host-reported; controller remains unknown until the protocol
 * supplies that independent fact. */
export function bridgePresence(
  state: Pick<MachineControlState, 'connectionPhase' | 'connectionKind' | 'bridgeControllerPresence' | 'bridgeProcessPresence'>,
): BridgePresence {
  return {
    socket: state.connectionKind === 'bridge' && state.connectionPhase === 'connected'
      ? 'open'
      : 'closed',
    controller: state.bridgeControllerPresence,
    process: state.bridgeProcessPresence,
  }
}

/** WO-3191: which way the app last told the spindle to turn (M3 cw, M4 ccw,
 *  M5 off). */
export type CommandedSpindleDirection = 'cw' | 'ccw' | 'off'

export interface CommandedAccessoryState {
  spindle: GrblParserState['spindle']
  coolant: GrblParserState['coolant']
}

/** A tool change detected in the loaded program (T word / M6 / the GRBL
 *  dialect's M0 "change tool" pause). */
export interface ProgramToolChange {
  sourceLine: number
  tool: number | null
  label: string
}

/** Guided tool-change flow (stage 12): a linear step machine the operator
 *  walks through from the tool-change hold to a re-armed program. */
export type ToolChangeStep =
  | 'stopping'
  | 'parking'
  | 'awaiting-swap'
  | 'probing'
  | 'arming'
  | 'ready'
  | 'failed'

export interface ToolChangeState {
  step: ToolChangeStep
  /** What the pause is FOR: a tool swap (probe + offset before re-arm) or a
   *  clamp/material intervention (park, fix, re-arm - no probe). */
  mode: 'toolChange' | 'clampPause'
  /** The tool the program asks for (null when the program only pauses). */
  tool: number | null
  /** First program line that streams after the change. */
  resumeLine: number
  /** Plain-language status / instruction / failure text for the card. */
  message: string
  /** Run-from-line cautions to show at the 'ready' step. */
  warnings: string[]
}

/** Material-fit trace flow (Operator's M20002): confirm-card -> trace -> done. */
export interface FitTraceState {
  step: 'confirm' | 'tracing' | 'done' | 'failed'
  /** Plain-language status / instruction / failure text for the card. */
  message: string
  /** XY bounds of the program's cutting moves (mm, work coordinates). */
  bounds: { minX: number; minY: number; maxX: number; maxY: number }
  /** The planned command sequence, shown on the confirm card. */
  lines: string[]
}

export interface MachineJobState {
  phase: StreamerPhase
  name: string | null
  totalLines: number
  sentLines: number
  ackedLines: number
  ackedSourceLine: number
  sentSourceLine: number
  startedAt: number | null
  /** Set while the job is paused. On resume, `startedAt` moves forward by the
   *  paused span, so `now - startedAt` is time the program actually ran - a
   *  9.7-minute setup-boundary hold read as 653 s of running on 2026-09-11. */
  pausedAt: number | null
  /** Stamped once, when the 'completed' event lands. `endedAt - startedAt` is
   *  the run length and never changes again - WO-2236: reading it off
   *  `Date.now()` instead made "done in" keep growing after the run ended
   *  (195 s shown for a ~4 s move). Optional: many fixtures build a
   *  MachineJobState literal without it. */
  endedAt?: number | null
  error: JobFault | null
  toolChanges: ProgramToolChange[]
}

/** WO-2256: a program staged as the REST of the loaded file - a kept stop's
 *  return, Run from line, Step Back - is a program of its own to the
 *  controller, which counts its moves and names its moves from its own start.
 *  This is how those readings read as the FILE's: the moves done and the total
 *  are the file's, and the move the controller names is the file listing's.
 *  Nothing staged or sent changes; only what `job` and `executingMoveId` say. */
export interface StagedNumbering {
  /** The total the controller counts the staged program in. Progress with any
   *  other total is not this program's and is shown as it comes. */
  stagedTotal: number
  /** The file's own total, in the same count. The file's moves after the
   *  start are the staged program's after its prelude, so "done" is the
   *  file's total less what is left. */
  fileTotal: number
  /** A staged step id as the file listing's step id (null: none of the
   *  file's). Absent where the controller's cursor is already the file's own
   *  line (a text door streams the file's lines). */
  stepOf: ((stagedId: number) => number | null) | null
  /** The file's program parts before the one the staged program carries on
   *  in, and the staged program's own parts before it (its way back), so the
   *  part a held program names is counted as the file's. */
  partsBefore: number
  stagedPartsBefore: number
}

/** The counts and cursor exactly as the controller reported them for the
 *  staged program (see `StagedNumbering`). */
export type StagedJobCounts = Pick<
  MachineJobState,
  'totalLines' | 'sentLines' | 'ackedLines' | 'ackedSourceLine' | 'sentSourceLine'
>

function stagedCounts(progress: StagedJobCounts): StagedJobCounts {
  return {
    totalLines: progress.totalLines,
    sentLines: progress.sentLines,
    ackedLines: progress.ackedLines,
    ackedSourceLine: progress.ackedSourceLine,
    sentSourceLine: progress.sentSourceLine,
  }
}

/** The staged program's counts as the file's. One offset for every count, so
 *  done/sent/total keep exactly the order they had (the transport's gates
 *  read them). */
export function fileNumberedCounts(staged: StagedJobCounts, numbering: StagedNumbering | null): StagedJobCounts {
  if (numbering === null || staged.totalLines !== numbering.stagedTotal) return stagedCounts(staged)
  const shift = numbering.fileTotal - numbering.stagedTotal
  const step = (id: number): number => (numbering.stepOf === null || id <= 0 ? id : numbering.stepOf(id) ?? 0)
  return {
    totalLines: numbering.fileTotal,
    sentLines: staged.sentLines + shift,
    ackedLines: staged.ackedLines + shift,
    ackedSourceLine: step(staged.ackedSourceLine),
    sentSourceLine: step(staged.sentSourceLine),
  }
}

function fileNumberedMoveId(id: number | null, numbering: StagedNumbering | null): number | null {
  if (id === null || numbering === null || numbering.stepOf === null) return id
  return numbering.stepOf(id)
}

/** WO-2580: the move the CONTROLLER is executing, as the listing's row id (a
 *  text program's line number, a staged step id). Control's highlighted line
 *  and its 3D view's current move both read it here, so each shows the
 *  controller's move, not the other display's. A program door: the move id
 *  the controller reports executing (the simulator's front move; the AXBB-E
 *  bridge's CurrentID, null when WO-2564 cannot prove it is this job's). A
 *  text door: the source line the controller reports (LinuxCNC's motion_line;
 *  GRBL reports no executing line - its acknowledged one is all there is). In
 *  a kept stop - an MDI line, a jog, the way back - the controller runs no
 *  program move; the move is the one it reported when the program stopped.
 *  Running or held on the program's own stop (an M0, a tool change, the
 *  words between two moves) with no move named, it is the last move the
 *  controller named - the move it stopped at (machine seat 10-04: the first
 *  M0 showed nothing while the board stood at the end of line 9). A step that
 *  is no line of the file (`unlistedStepIds`) names no move. */
export function executingProgramMoveId(
  s: Pick<MachineControlState, 'job' | 'stagedProgram' | 'executingMoveId' | 'stoppedAtMoveId'>,
  paused: { cursor: number | null } | null,
): number | null {
  if (paused) return paused.cursor
  if (!s.stagedProgram) return s.job.ackedSourceLine
  if (s.executingMoveId !== null && isListedStep(s.stagedProgram, s.executingMoveId)) return s.executingMoveId
  return s.job.phase === 'streaming' || s.job.phase === 'paused' ? s.stoppedAtMoveId : null
}

/** WO-2580: whether that move is shown at all - a running, held, finished or
 *  failed program, or a kept stop's paused one. */
export function executingProgramMoveShown(phase: StreamerPhase, paused: object | null): boolean {
  return phase === 'streaming' || phase === 'paused' || phase === 'complete' || phase === 'failed' || paused !== null
}

/** Fail-closed verdict shared by every operator path that can start or
 *  resume the loaded program. Loading resets this verdict; validation must
 *  explicitly arm it before CYCLE START becomes available. */
export interface MachineProgramReadiness {
  ready: boolean
  reason: string
}

/** ProgramPreview's table-envelope verdict for the currently rendered
 * program. Null means this session has not published a verdict, so motion
 * must never infer that the program is inside the table. */
export interface MachineProgramFit {
  state: 'inside' | 'partial' | 'outside'
  sentence: string
}

/** One row of the cycle event log: what happened to a program run, and when. */
export interface CycleEvent {
  id: number
  at: number
  event: 'started' | 'paused' | 'resumed' | 'stopped' | 'completed' | 'failed'
  /** Program name at the time of the event. */
  name: string | null
  /** Source line for failures; null otherwise. */
  line: number | null
  /** WO-382: the operation the event happened in ("Face 1 (facing), operation
   *  2 of 5"), derived from the streamer's acked source line through the
   *  verified context spans. Null unless the context was 'current' at the
   *  moment of the event - a stale or foreign program never names one. */
  operation: string | null
}

/** What the Control view last concluded about the loaded context against the
 *  live project, published by the surface that owns the comparison
 *  (ProgramPanel). null = not compared yet (or no surface mounted): every
 *  semantic claim stays off until a 'current' verdict arrives. */
export type ProgramContextVerdict = ProgramContextComparison | 'comparison-failed' | null

const CONSOLE_LIMIT = 500

/** Plain JSON data (status frames) compared by value. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false
  if (Array.isArray(a) !== Array.isArray(b)) return false
  const aKeys = Object.keys(a)
  const bKeys = Object.keys(b)
  if (aKeys.length !== bKeys.length) return false
  return aKeys.every((key) =>
    Object.prototype.hasOwnProperty.call(b, key)
    && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]))
}

/** The current object when the next one holds the same value, else the next. */
function sameValueKept<T>(current: T, next: T): T {
  return sameValue(current, next) ? current : next
}
const CYCLE_LOG_LIMIT = 50
const ACCESSORIES_OFF: AccessoryState = { spindle: 'off', flood: false, mist: false }

export interface MachineControlState {
  connectionPhase: ConnectionPhase
  /** Which local connection path is active. Used only to distinguish the
   *  profile-driven built-in simulator from a real serial controller. */
  connectionKind: 'serial' | 'simulator' | 'bridge' | 'gateway' | null
  /** WO-3189: counts every change to the simulator's virtual part (seeded at
   *  connect, placed, reset) so the Diagnostics card redraws what the
   *  simulator holds. The part itself lives in the simulated controller. */
  simulatedPartRevision: number
  connectionDetail: string | null
  grblVersion: string | null
  /**
   * WO-448: what the machine bridge's `hello` frame said about THIS session -
   * null on every other connection kind, and null on 'bridge' too until hello
   * arrives / after disconnect. The connect UI reads this to surface
   * `readOnly` and a declared spindle link BEFORE the operator presses
   * something the bridge will refuse (BRIDGE-PROTOCOL.md "Hello").
   *
   * WO-911: `uccnc` rides along the same way - the bridge's raw install
   * root / profile / dll paths / `.pro` list, or undefined when the bridge
   * sent no `uccnc` key at all (an older bridge, or a fixture that omits
   * it). `undefined` rather than `null` here (unlike `vfd` above): this
   * mirrors what `UccncController.bridgeHello()` actually publishes, kept
   * that way so bridgeConnect.wo448.test.tsx's `toEqual` assertions against
   * `{ readOnly, vfd }` literals - which predate this field and are outside
   * this WO's owned paths - keep passing (`toEqual` ignores undefined-valued
   * keys, not null-valued ones).
   */
  bridgeHello: ControllerBridgeHello | null
  /** Host process and future controller-liveness rows remain independent of
   * connectionPhase so the customer surface can say which layer failed. */
  bridgeControllerPresence: BridgeControllerPresence
  bridgeProcessPresence: BridgeProcessPresence
  machineState: MachineState
  subState: number | null
  mpos: MachinePosition | null
  wpos: MachinePosition | null
  feed: number | null
  spindleRpm: number | null
  /** WO-3191: the direction of the last M3/M4/M5 the app actually sent to this
   *  controller, by any route - the program stream, MDI or the spindle panel.
   *  Written ONLY by `recordCommandedSpindle` (lib/machine/commandedSpindle).
   *  Never the inverter's direction bit: this VFD reports the opposite way while
   *  turning correctly (VFD-COMMISSIONING.md 4.9). Whether it turns is the
   *  machine's report, not this. */
  commandedSpindle: CommandedSpindleDirection
  /** Values reported by this controller session. Null is never rendered by
   *  itself: overrideAvailability says whether the channel is still unknown or
   *  was explicitly reported unsupported. */
  overrides: { feed: number | null; rapid: number | null; spindle: number | null }
  overrideAvailability: OverrideAvailabilityState
  // Contract v4 (WO-426): decoded per-lamp inputs from the contract, not
  // GRBL's raw `Pn:` letter string. `limits`/`door`/`hold` are individually
  // nullable - "not triggered" and "no such input" are different facts, and a
  // lamp must be able to render the difference rather than default to clear.
  //
  // Contract v5 (WO-922, the 2026-08-23 runaway): the same object now also
  // carries the optional per-axis `home`, `limitMinus` and `limitPlus` maps.
  // They arrive here by widening the contract alone - `machineSession`'s
  // `applyContractStatus` already hands `status.inputs` across whole - so a
  // reader gets them from `useMachineControl().inputs?.home?.X` and MUST
  // treat `null` (no input wired on that axis) as different from `false`
  // (wired, currently open) and from an absent key (no such axis). NOTHING
  // RENDERS THESE YET: WO-922 deliberately stops at the store, because where
  // the readout goes - the existing `control-pin-leds` row, the machine
  // console, or both - is Operator's call and is not a lane's to decide.
  inputs: MachineStatus['inputs']
  /** WO-1671: the status frame's `probeCycle` - a probe cycle is in process
   *  on the controller right now (the PROBING lamp). Null when the frame does
   *  not carry the field or the controller could not read it. */
  probeCycle: boolean | null
  /** WO-2774: the Probing screen holds a stopped probe run (its red "Stopped
   *  at step N" / "Did not start" line is up). Published by ProbingPanel from
   *  its session, so the header chip reads it on every workspace. */
  probeRunStopped: boolean
  /** COMMANDED modal accessory state from $G. This can lead the live report. */
  commandedAccessories: CommandedAccessoryState | null
  /** REPORTED accessory state from status-report A:, resolved by the controller. */
  reportedAccessories: AccessoryState
  /** WO-2668: each output pin's state AS THE CONTROLLER READ IT BACK, keyed
   *  `port:pin`, as a raw electrical level. Readers apply their own polarity. Written by the session from
   *  every output receipt and output read, whoever switched the pin - a Control
   *  button, MDI, a macro or a program line. An absent key is a pin nobody has
   *  read this session; a reader keeps its own fallback for it. */
  outputPins: Readonly<Record<string, boolean>>
  alarm: MachineAlarm | null
  job: MachineJobState
  consoleLines: MachineConsoleLine[]
  /** The loaded program text (for the line list); null when nothing loaded. */
  programText: string | null
  /** Exact staged geometry program when the controller route has no text. */
  stagedProgram: StagedProgramView | null
  /** Live geometry move id reported by the controller status stream - as the
   *  file listing's id while `stagedNumbering` is set (WO-2256). */
  executingMoveId: number | null
  /** WO-2256: how the staged program's numbering reads as the file's; null
   *  when the staged program is the file itself. Cleared by every setProgram. */
  stagedNumbering: StagedNumbering | null
  /** WO-2256: `job`'s counts and the executing id as the controller reported
   *  them for the staged program, before `stagedNumbering`. */
  stagedJob: StagedJobCounts
  stagedExecutingMoveId: number | null
  /** WO-2580: the last move the controller named executing in the loaded
   *  program (as `executingMoveId` reads it) - the move it stopped at once it
   *  names none. Cleared by every setProgram. */
  stoppedAtMoveId: number | null
  /** Frozen manufacturing-intent snapshot bound to the loaded program, or null
   *  for an explicit no-context load (arbitrary file). Always replaced ATOMICALLY
   *  with programText through setProgram - never set or cleared independently. */
  programContext: ProgramContextV1 | null
  /** Canonical lint/load verdict used by the one operator transport. */
  programReadiness: MachineProgramReadiness
  /** Last table-fit verdict actually published by ProgramPreview. */
  programFit: MachineProgramFit | null
  /** WO-382: the last published context comparison (see ProgramContextVerdict).
   *  Cleared whenever the bound context changes. */
  programContextVerdict: ProgramContextVerdict
  /** WO-382: first PROGRAM source line of the armed job when it was armed
   *  mid-program (run-from-line, Step Back, guided re-arm); null = from the top.
   *  Advisory only - read while no program line has been acked yet, so the
   *  operation display can say which operation the armed start sits in. Reset
   *  by every setProgram. */
  armedFromLine: number | null
  /** WO-382 (Operator review 2026-08-20): the operation row's per-operation list
   *  is collapsed by default; the operator's choice lives for the session
   *  only (this store never persists) and survives Control re-mounts. */
  operationListExpanded: boolean
  /** Active work coordinate system from $G; null until first refresh. */
  activeWcs: WcsId | null
  /** Modal parser facts an operator cares about (units / distance / motion). */
  parserModal: Pick<GrblParserState, 'units' | 'distanceMode' | 'motionMode'> | null
  /** The tool in the spindle: the controller's own report ($G on GRBL), or -
   *  on a controller that reports none (the UCCNC bridge) - the tool the
   *  operator fitted at a guided change or measured by number (WO-2105). */
  activeTool: number | null
  /** WO-2878: freshness of the two sources of the current tool, as EVENTS on
   *  one monotonic sequence. toolReportStamp is taken by every action that
   *  reports or sets the tool - even when it repeats the stored number;
   *  streamToolStamp when the acked cursor enters a T word of the program, or
   *  a run ends on one. currentToolOf() lets the larger one speak. */
  toolReportStamp: number
  streamToolStamp: number
  /** $# offsets by label (G54..G59, G28, G30, G92) - values are [x, y, z]. */
  offsets: Record<string, number[]>
  /** Tool length offset ($# TLO), mm. */
  tlo: number | null
  /** Last probe result ($# PRB). */
  probe: { values: number[]; success: boolean } | null
  /** $$ settings snapshot (key -> raw value string). */
  settings: Record<number, string>
  /** A $H homing cycle completed in this connection session. */
  homed: boolean
  /** Guided tool-change flow state; null when no flow is running. */
  toolChange: ToolChangeState | null
  /** Material-fit trace flow state; null when no trace is in progress. */
  fitTrace: FitTraceState | null
  /** Session-only probed surface map. It is cleared on disconnect or when a
   * different program is loaded; project files never silently re-arm motion
   * compensation. */
  surfaceMesh: SurfaceMeshMap | null
  /** Cycle event log: program start/stop history, newest last. Survives
   *  disconnects on purpose - it is the operator's session history. */
  cycleEvents: CycleEvent[]
  /** Hold transitions since the program started - identifies WHICH pause the
   *  machine is sitting at when every line is already acked (the cursor is
   *  at the end but the machine holds at the Nth M0). */
  holdsSeen: number
  /** Single-block MODE: the operator steps one line at a time instead of
   *  streaming continuously. This is a mode, not an action - the Step button
   *  exists regardless, but while this is on continuous Start is refused so a
   *  stray click cannot run the whole program. */
  singleBlock: boolean

  // Mutators - called by machineSession's controller event wiring and the UI.
  setConnection: (phase: ConnectionPhase, detail: string | null) => void
  setConnectionKind: (kind: 'serial' | 'simulator' | 'bridge' | 'gateway' | null) => void
  /** WO-448 (`vfd`), WO-911 (`uccnc`). Set once hello arrives on a bridge
   *  connection; cleared (null) on every other phase transition, so a stale
   *  reading from a previous bridge process can never survive a
   *  disconnect/reconnect. */
  setBridgeHello: (hello: ControllerBridgeHello | null) => void
  setBridgeProcessPresence: (presence: BridgeProcessPresence) => void
  setWelcome: (version: string) => void
  applyStatus: (
    state: MachineState,
    subState: number | null,
    mpos: MachinePosition | null,
    wpos: MachinePosition | null,
    feed: number | null,
    spindleRpm: number | null,
    /** Per channel, because controllers differ in which they HAVE. The AXBB-E
   *  reports feed and spindle but has no rapid override at all, so its `rapid`
   *  is null. Previously this was all-or-nothing: one null channel discarded
   *  the whole report and the panel froze at its last value. */
  overrides: { feed: number | null; rapid: number | null; spindle: number | null } | null,
    inputs: MachineStatus['inputs'],
    reportedAccessories: AccessoryState,
  ) => void
  /** Spindle/coolant, over the contract's OWN channel (`onAccessories`), not
   *  bundled into `applyStatus` - a status poll and an accessory change are
   *  different events and arrive at different rates. WO-426. */
  setReportedAccessories: (state: AccessoryState) => void
  /** WO-2668: one pin's controller readback; null forgets it (unread). */
  setOutputPin: (key: string, level: boolean | null) => void
  pushConsole: (dir: 'tx' | 'rx', text: string, severity: MachineConsoleLine['severity']) => void
  clearConsole: () => void
  setAlarm: (alarm: MachineAlarm | null) => void
  applyParserState: (state: GrblParserState) => void
  /** WO-415: a G54..G59 word the controller acknowledged (streamed line or MDI)
   *  selects that offset - mirror it without waiting for the next $G. */
  setActiveWcs: (wcs: WcsId) => void
  applyOffset: (entry: GrblOffsetEntry) => void
  /** Forget the last [PRB] result (a probe cycle starts fresh). */
  clearProbe: () => void
  applySetting: (key: number, value: string) => void
  setHomed: (homed: boolean) => void
  setToolChange: (toolChange: ToolChangeState | null) => void
  /** WO-2105: the operator measured or zeroed with this tool by number, so it
   *  is the one in the spindle. A controller's own report still overrides. */
  setActiveTool: (tool: number) => void
  setFitTrace: (fitTrace: FitTraceState | null) => void
  setSurfaceMesh: (surfaceMesh: SurfaceMeshMap | null) => void
  setSingleBlock: (on: boolean) => void
  /** A backend generation owns operational modes and telemetry provenance.
   *  Reset them together before controls for the replacement can be enabled. */
  resetControllerSessionState: () => void
  setProgramReadiness: (readiness: MachineProgramReadiness) => void
  setProgramFit: (fit: MachineProgramFit | null) => void
  setProgramContextVerdict: (verdict: ProgramContextVerdict) => void
  setArmedFromLine: (line: number | null) => void
  setOperationListExpanded: (expanded: boolean) => void
  setProgram: (
    name: string | null,
    text: string | null,
    toolChanges?: ProgramToolChange[],
    /** Explicit context to bind. undefined = preserve the current context when
     *  the text is unchanged, else clear; null = explicit no-context; a
     *  ProgramContextV1 = explicit snapshot. */
    context?: ProgramContextV1 | null,
    stagedProgram?: StagedProgramView | null,
  ) => void
  setExecutingMoveId: (moveId: number | null) => void
  /** WO-2256: install (or clear) the file numbering of the staged program. */
  setStagedNumbering: (numbering: StagedNumbering | null) => void
  setProbeCycle: (probeCycle: boolean | null) => void
  setProbeRunStopped: (probeRunStopped: boolean) => void
  applyJobProgress: (progress: StreamerProgress) => void
  applyJobEvent: (
    event: 'started' | 'paused' | 'resumed' | 'stopped' | 'completed' | 'failed',
    error: JobFault | null,
  ) => void
}

const initialJob: MachineJobState = {
  phase: 'empty',
  name: null,
  totalLines: 0,
  sentLines: 0,
  ackedLines: 0,
  ackedSourceLine: 0,
  sentSourceLine: 0,
  startedAt: null,
  pausedAt: null,
  endedAt: null,
  error: null,
  toolChanges: [],
}

let consoleSeq = 0

let toolStampSeq = 0
function nextToolStamp(): number {
  return ++toolStampSeq
}

/** The stream speaks again when the acked cursor enters a different T word
 *  (by line, so a second run through the same T counts), or when a run ends
 *  on one: that tool is what the program left in the spindle. */
function streamToolAdvanced(prev: MachineControlState, next: MachineControlState): boolean {
  if (next.job === prev.job) return false
  // Bookkeeping only: a publication carrying no tool list (a partial job)
  // moves no stream cursor, and must never throw the publication itself.
  if (!Array.isArray(next.job?.toolChanges)) return false
  const entry = streamedToolChange(next.job.toolChanges, next.job.ackedSourceLine)
  if (entry === null) return false
  if (!Array.isArray(prev.job?.toolChanges)) return true
  const before = streamedToolChange(prev.job.toolChanges, prev.job.ackedSourceLine)
  if (before === null || before.sourceLine !== entry.sourceLine || before.tool !== entry.tool) return true
  return jobInFlight(prev.job.phase) && !jobInFlight(next.job.phase)
}

/** Every publication - the actions below and every direct setState from the
 *  session - passes here, so no job writer can move the cursor unstamped. */
const stampStreamTool = (config: StateCreator<MachineControlState>): StateCreator<MachineControlState> =>
  (set, get, api) => {
    const stamped = ((partial: Partial<MachineControlState> | ((s: MachineControlState) => Partial<MachineControlState>), replace?: boolean) => {
      const prev = get()
      const patch = typeof partial === 'function' ? partial(prev) : partial
      const next = replace ? (patch as MachineControlState) : { ...prev, ...patch }
      const out = streamToolAdvanced(prev, next) ? { ...patch, streamToolStamp: nextToolStamp() } : patch
      ;(set as (p: Partial<MachineControlState>, r?: boolean) => void)(out, replace)
    }) as typeof set
    api.setState = stamped
    return config(stamped, get, api)
  }

export const useMachineControl = create<MachineControlState>()(stampStreamTool((set) => ({
  connectionPhase: 'disconnected',
  connectionKind: null,
  simulatedPartRevision: 0,
  connectionDetail: null,
  bridgeHello: null,
  bridgeControllerPresence: 'unknown',
  bridgeProcessPresence: 'unknown',
  grblVersion: null,
  machineState: 'unknown',
  subState: null,
  mpos: null,
  wpos: null,
  feed: null,
  spindleRpm: null,
  commandedSpindle: 'off',
  overrides: UNKNOWN_OVERRIDES,
  overrideAvailability: UNKNOWN_OVERRIDE_AVAILABILITY,
  inputs: null,
  probeCycle: null,
  probeRunStopped: false,
  commandedAccessories: null,
  reportedAccessories: ACCESSORIES_OFF,
  outputPins: {},
  alarm: null,
  job: initialJob,
  consoleLines: [],
  programText: null,
  stagedProgram: null,
  executingMoveId: null,
  stagedNumbering: null,
  stagedJob: stagedCounts(initialJob),
  stagedExecutingMoveId: null,
  stoppedAtMoveId: null,
  programContext: null,
  programReadiness: { ready: false, reason: operatorText('machineControlStore1') },
  programFit: null,
  programContextVerdict: null,
  armedFromLine: null,
  operationListExpanded: false,
  activeWcs: DEFAULT_WCS,
  parserModal: null,
  activeTool: null,
  toolReportStamp: 0,
  streamToolStamp: 0,
  offsets: {},
  tlo: null,
  probe: null,
  settings: {},
  homed: false,
  toolChange: null,
  fitTrace: null,
  surfaceMesh: null,
  cycleEvents: [],
  holdsSeen: 0,
  singleBlock: false,

  setConnection: (phase, detail) =>
    set((s) => ({
      connectionPhase: phase,
      // Runtime transport identity belongs to a live backend session. Clear it
      // in the same store publication as an unexpected disconnect so React
      // can never observe an enabled selector beside the departed transport.
      ...(phase === 'disconnected' ? { connectionKind: null } : {}),
      connectionDetail: detail,
      // A drop invalidates every machine-derived readout - back to unknowns,
      // but keep program + console so the operator can see what happened.
      ...(phase === 'disconnected'
        ? {
            bridgeHello: null,
            grblVersion: null,
            machineState: 'unknown' as MachineState,
            subState: null,
            mpos: null,
            wpos: null,
            feed: null,
            spindleRpm: null,
            commandedSpindle: 'off' as const,
            overrides: UNKNOWN_OVERRIDES,
            overrideAvailability: UNKNOWN_OVERRIDE_AVAILABILITY,
            singleBlock: false,
            inputs: null,
            probeCycle: null,
            probeRunStopped: false,
            commandedAccessories: null,
            reportedAccessories: ACCESSORIES_OFF,
            outputPins: {},
            alarm: null,
            activeWcs: DEFAULT_WCS,
            parserModal: null,
            activeTool: null,
            toolReportStamp: nextToolStamp(),
            offsets: {},
            tlo: null,
            probe: null,
            settings: {},
            homed: false,
            toolChange: null,
            fitTrace: null,
            surfaceMesh: null,
            executingMoveId: null,
            stagedExecutingMoveId: null,
            stoppedAtMoveId: null,
            stagedNumbering: null,
            stagedJob: stagedCounts(initialJob),
            programReadiness: {
              ready: false,
              reason: s.programText || s.stagedProgram
                ? operatorText('machineControlStore2')
                : operatorText('machineControlStore3'),
            },
            programFit: null,
            job: { ...initialJob, name: s.job.name, toolChanges: s.job.toolChanges },
          }
        : {}),
    })),
  setConnectionKind: (connectionKind) => set({ connectionKind }),
  setBridgeHello: (bridgeHello) => set({ bridgeHello }),
  setBridgeProcessPresence: (bridgeProcessPresence) => set({ bridgeProcessPresence }),

  setWelcome: (version) => set({ grblVersion: version }),

  // WO-2257: a frame that repeats the inputs and overrides keeps the objects
  // the screen already has. Every frame decodes fresh copies, and a fresh
  // copy of an unchanged value re-rendered the whole Control page - 40 times a
  // second while an axis moves. The values are exactly the frame's.
  applyStatus: (state, subState, mpos, wpos, feed, spindleRpm, overrides, inputs, reportedAccessories) =>
    set((s) => ({
      holdsSeen: state === 'hold' && s.machineState !== 'hold' ? s.holdsSeen + 1 : s.holdsSeen,
      machineState: state,
      subState,
      mpos,
      wpos,
      feed,
      spindleRpm,
      overrides: sameValueKept(s.overrides, overrides ?? s.overrides),
      overrideAvailability: overrides
        ? sameValueKept(s.overrideAvailability, {
            feed: overrides.feed === null ? 'unsupported' : 'supported',
            rapid: overrides.rapid === null ? 'unsupported' : 'supported',
            spindle: overrides.spindle === null ? 'unsupported' : 'supported',
          })
        : s.overrideAvailability,
      inputs: sameValueKept(s.inputs, inputs),
      reportedAccessories,
      // Leaving alarm state via $X/$H clears the banner condition.
      alarm: state === 'alarm' ? s.alarm : null,
    })),

  setReportedAccessories: (state) => set({ reportedAccessories: state }),

  setOutputPin: (key, level) =>
    set((s) => {
      if (level === null) {
        if (!(key in s.outputPins)) return {}
        const { [key]: _forgotten, ...rest } = s.outputPins
        return { outputPins: rest }
      }
      return s.outputPins[key] === level ? {} : { outputPins: { ...s.outputPins, [key]: level } }
    }),

  pushConsole: (dir, text, severity) =>
    set((s) => {
      const line: MachineConsoleLine = { id: ++consoleSeq, dir, text, severity, at: Date.now() }
      const lines =
        s.consoleLines.length >= CONSOLE_LIMIT
          ? [...s.consoleLines.slice(-(CONSOLE_LIMIT - 1)), line]
          : [...s.consoleLines, line]
      return { consoleLines: lines }
    }),

  clearConsole: () => set({ consoleLines: [] }),

  // Raising an alarm flips the state chip IMMEDIATELY - the next status poll
  // may be up to a second away, and the pinned safety bar must not read
  // "Idle" while the alarm banner is up.
  setAlarm: (alarm) => set((s) => ({ alarm, machineState: alarm ? 'alarm' : s.machineState })),

  setActiveWcs: (wcs) => set((s) => (s.activeWcs === wcs ? {} : { activeWcs: wcs })),

  applyParserState: (state) =>
    set((s) => ({
      activeWcs: state.wcs ?? s.activeWcs,
      parserModal: {
        units: state.units,
        distanceMode: state.distanceMode,
        motionMode: state.motionMode,
      },
      commandedAccessories: {
        spindle: state.spindle,
        coolant: state.coolant,
      },
      // WO-2878: a report is tool knowledge only when it CARRIES a tool
      // (tool null = this report says nothing about it); a units or MDI
      // refresh must not outrank the program's last T with no tool fact.
      ...(state.tool === null ? {} : { activeTool: state.tool, toolReportStamp: nextToolStamp() }),
    })),

  applyOffset: (entry) =>
    set((s) => {
      if (entry.label === 'TLO') return { tlo: entry.values[0] ?? null }
      if (entry.label === 'PRB')
        return { probe: { values: entry.values, success: entry.probeSuccess ?? false } }
      return { offsets: { ...s.offsets, [entry.label]: entry.values } }
    }),

  clearProbe: () => set({ probe: null }),

  applySetting: (key, value) =>
    set((s) => ({ settings: { ...s.settings, [key]: value } })),

  setHomed: (homed) => set({ homed }),

  // WO-2105: the UC100 bridge has no tool number, so the app keeps it the way
  // UCCNC's own M6 macro does - Setcurrenttool(NewTool) right after the
  // operator's "Insert new tool" is confirmed, before the tool probe. Here that
  // is the step past 'awaiting-swap'. Stopping, parking and waiting for the
  // swap still have the old tool in; a cancel leaves it there.
  setToolChange: (toolChange) => set(
    toolChange !== null && toolChange.mode === 'toolChange' && toolChange.tool !== null
      && TOOL_FITTED_STEPS.has(toolChange.step)
      ? { toolChange, activeTool: toolChange.tool, toolReportStamp: nextToolStamp() }
      : { toolChange },
  ),
  // WO-2878: a repeat of the stored number still publishes - the receipt
  // itself is the news (Measure T3 after a program that ended on T2 is T3).
  setActiveTool: (tool) => set({ activeTool: tool, toolReportStamp: nextToolStamp() }),

  setFitTrace: (fitTrace) => set({ fitTrace }),
  setSurfaceMesh: (surfaceMesh) => set({ surfaceMesh }),
  setSingleBlock: (on) => set({ singleBlock: on }),
  resetControllerSessionState: () => set({
    singleBlock: false,
    overrides: UNKNOWN_OVERRIDES,
    overrideAvailability: UNKNOWN_OVERRIDE_AVAILABILITY,
  }),

  setProgramReadiness: (programReadiness) => set({ programReadiness }),
  setProgramFit: (programFit) => set({ programFit }),
  setProgramContextVerdict: (programContextVerdict) => set({ programContextVerdict }),
  setArmedFromLine: (armedFromLine) => set({ armedFromLine }),
  setOperationListExpanded: (operationListExpanded) => set({ operationListExpanded }),

  setProgram: (name, text, toolChanges = [], context, stagedProgram = null) =>
    set((s) => {
      const sameText = text === s.programText
      if (context !== undefined) assertProgramContextMatchesProgram(context, text)
      const nextContext =
        context !== undefined ? freezeProgramContext(context) : sameText ? s.programContext : null
      return {
        programText: text,
        stagedProgram,
        executingMoveId: null,
        stagedExecutingMoveId: null,
        stoppedAtMoveId: null,
        stagedNumbering: null,
        stagedJob: stagedCounts(initialJob),
        // Program and context are replaced in one atomic set. Explicit null =
        // no-context; explicit snapshot = bound context (validated, deep-copied,
        // deep-frozen at this boundary so a mutable caller reference cannot reach
        // the stored snapshot); undefined = preserve only when the text is
        // unchanged (re-arm / re-load of the same text).
        programContext: nextContext,
        // WO-382: a verdict belongs to one (context, text) pair. Keep it only
        // when both survive; the comparing surface re-publishes otherwise.
        programContextVerdict: nextContext === s.programContext && sameText ? s.programContextVerdict : null,
        // A table-fit verdict belongs to the program ProgramPreview measured.
        // Re-arming identical text keeps it; loading different text waits for
        // the preview to publish that program's own verdict.
        programFit: sameText ? s.programFit : null,
        armedFromLine: null,
        programReadiness: {
          ready: false,
          reason: text ? operatorText('machineControlStore4') : operatorText('machineControlStore5'),
        },
        job: { ...initialJob, name, toolChanges },
        holdsSeen: 0,
        // WO-2283: the surface mesh belongs to the work system it was probed
        // in, not to a program - loading another program leaves it applied.
      }
    }),

  setExecutingMoveId: (moveId) => set((s) => {
    const executingMoveId = fileNumberedMoveId(moveId, s.stagedNumbering)
    return {
      stagedExecutingMoveId: moveId,
      executingMoveId,
      stoppedAtMoveId: executingMoveId !== null && isListedStep(s.stagedProgram, executingMoveId)
        ? executingMoveId
        : s.stoppedAtMoveId,
    }
  }),
  setStagedNumbering: (stagedNumbering) => set((s) => {
    // Nothing was read as the file: `job` is the controller's own already.
    if (stagedNumbering === null && s.stagedNumbering === null) return {}
    const executingMoveId = fileNumberedMoveId(s.stagedExecutingMoveId, stagedNumbering)
    return {
      stagedNumbering,
      job: { ...s.job, ...fileNumberedCounts(s.stagedJob, stagedNumbering) },
      executingMoveId,
      stoppedAtMoveId: executingMoveId !== null && isListedStep(s.stagedProgram, executingMoveId)
        ? executingMoveId
        : s.stoppedAtMoveId,
    }
  }),
  setProbeCycle: (probeCycle) => set({ probeCycle }),
  setProbeRunStopped: (probeRunStopped) => set((s) => (s.probeRunStopped === probeRunStopped ? s : { probeRunStopped })),

  applyJobProgress: (progress) =>
    set((s) => ({
      stagedJob: stagedCounts(progress),
      job: {
        ...s.job,
        phase: progress.phase,
        ...fileNumberedCounts(progress, s.stagedNumbering),
      },
    })),

  applyJobEvent: (event, error) =>
    set((s) => ({
      cycleEvents: [
        ...(s.cycleEvents.length >= CYCLE_LOG_LIMIT
          ? s.cycleEvents.slice(-(CYCLE_LOG_LIMIT - 1))
          : s.cycleEvents),
        {
          id: ++consoleSeq,
          at: Date.now(),
          event,
          name: s.job.name,
          // Contract v3: `line` for a text-streaming backend, null for one that
          // queues geometry (its failure names a moveId instead). The cycle log
          // is a line log, so a geometry failure honestly logs no line.
          line: event === 'failed' ? (error?.line ?? null) : null,
          // WO-382: name the operation only for a verified-current context. The
          // cursor is the streamer's acked source line as last applied (the
          // 'stopped' event arrives BEFORE the reset progress, so it still
          // names where the stop happened); a failure uses the failed line.
          operation:
            s.programContextVerdict === 'current'
              ? describeOperationAtProgress(s.programContext, s.programText, {
                  phase: s.job.phase === 'empty' ? 'ready' : s.job.phase,
                  ackedSourceLine:
                    event === 'failed' && error?.line ? error.line : s.job.ackedSourceLine,
                  armedFromLine: s.armedFromLine,
                })
              : null,
        },
      ],
      job: {
        ...s.job,
        startedAt: event === 'started'
          ? Date.now()
          : event === 'resumed' && s.job.startedAt !== null && s.job.pausedAt !== null
            ? s.job.startedAt + (Date.now() - s.job.pausedAt)
            : s.job.startedAt,
        pausedAt: event === 'paused' ? Date.now() : event === 'resumed' || event === 'started' ? null : s.job.pausedAt,
        endedAt: event === 'completed' ? Date.now() : event === 'started' ? null : s.job.endedAt,
        error: event === 'failed' ? error : event === 'started' ? null : s.job.error,
      },
      // Starting the re-armed program is the guided tool change's last step.
      toolChange: event === 'started' ? null : s.toolChange,
      // A job start supersedes any lingering fit-trace card.
      fitTrace: event === 'started' ? null : s.fitTrace,
      holdsSeen: event === 'started' ? 0 : s.holdsSeen,
    })),
})))
