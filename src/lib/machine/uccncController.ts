// UccncController - MachineController backend for the AXBB-E (via UC100.dll),
// speaking the bridge protocol (docs/machine/BRIDGE-PROTOCOL.md) over a JSON
// message channel (bridgeTransport.ts).
//
// Unlike GrblController this backend takes GEOMETRY (loadMoves), not G-code
// text - the capability ADR-0041 exists to preserve. loadJob/loadJobFrom
// (text) are implemented but refuse: parsing text to moves is not in scope
// here (see "What" item 6 of WO-421).
//
// Two safety rules from the WO carry through every method below:
// - capabilities and readOnly come from the bridge's `hello` frame and
//   ONLY from there - never hardcoded, never assumed.
// - MachineStatus nulls pass straight through untouched. Nothing here may
//   substitute 0 (or any other value) for a null field.

import type {
  ApplyDefinitionResult,
  ConnectionPhase,
  ControlAxis,
  ControllerBackend,
  ControllerBridgeHello,
  ControllerCapabilities,
  ControllerSkewApplyResult,
  ConsoleEntry,
  ControllerEvents,
  JogAxis,
  MachineController,
  MachineDefinitionProvenance,
  MachineProgram,
  MachineState,
  MachineStatus,
  OutputReadback,
  OutputSwitchReceipt,
  OutputSwitchRequest,
  OverrideChange,
  ProbeTouch,
  SetWcsRotationResult,
  SetWorkOffsetResult,
  WcsRotations,
  ZeroWorkAxisReceipt,
  LoadOutcome,
  ProgramProgress,
  QueuedMove,
  StreamerProgress,
  WcsId,
} from './controller'

export const DRIVE_FAULT_ALARM_PREFIX = 'Drive fault:'
import {
  HOMED_GATE_AXES,
  RESERVED_PROGRAM_ID,
  resolveMaxProgramMoves,
  validateMachineProgram,
} from './controller'
import type {
  BridgeApplyDefinitionReply,
  BridgeApplyMachineDefinitionArgs,
  BridgeClientMessage,
  BridgeDefinitionDriftEntry,
  BridgeDefinitionSource,
  BridgeMessage,
  BridgePreviewProfileReply,
  BridgeTransportEvents,
} from './bridgeTransport'
import {
  readBridgeDefinitionDrift,
  readBridgeDefinitionSource,
  readZeroWorkAxisReceipt,
  readDeclaredVfdDefinition,
  vfdSpindleTurning,
} from './bridgeTransport'
import {
  AXIS_NAMES,
  type AxisName,
  type ControllerDefinition,
  type MachineSpindleDriveDefinition,
  type MachineSpindleLinkDefinition,
} from '../../types'
import type { MachinePosition } from './types'
import { WorkerTimer } from './workerTimer'
import { machineMoveForSend } from '../program/buildMachineProgram'
import {
  VFD_DEFINITIONS,
  compileVfdDefinition,
  vfdDecodePush,
  vfdIsUpToSpeed,
  vfdSetpointWord,
  type VfdCompiledScales,
  type VfdDefinition,
  type VfdReadings,
} from './vfd'
import {
  VFD_LINK_QUIET_STOP_MS,
  VFD_LINK_STATE_DOWN,
  spindleSafetyStopIsActionable,
  vfdStopRequired,
  type VfdLinkState,
} from './vfd/vfdSafety'

/** The bridge protocol version this build understands. connect() refuses a
 *  hello that reports anything else. */
export const SUPPORTED_BRIDGE_PROTOCOL = 1

/** Exported so tests can drive the timeout deterministically rather than
 *  guessing at a magic number. */
export const CALL_TIMEOUT_MS = 8000
export const HELLO_TIMEOUT_MS = 5000
/** WO-1546: the bridge polls a probe for up to five minutes before it answers
 *  (Machine.cs ProbeCore), and a real touch took 12 s on the board - the 8 s
 *  call timeout reported a probe that was still running as a failure. */
export const PROBE_CALL_TIMEOUT_MS = 5 * 60_000 + 30_000

/** WO-2020: Machine.cs owns the after-contact diagnosis and remedy. Its four
 * failure sentences all begin with this measured fact; they are completed
 * probe calls that failed while the board finished the cycle, not refusals. */
const PROBE_TOUCHED_FAILURE_PREFIX = 'the probe touched '

/** WO-2137: the bridge ANSWERED the call and said no - as opposed to a call
 *  that timed out or lost its link, where what the machine did is unknown. */
class BridgeReplyError extends Error {}

function probeCallFailureReason(command: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error)
  return reason.startsWith(PROBE_TOUCHED_FAILURE_PREFIX)
    ? reason
    : `the controller refused ${command}: ${reason}`
}

/** Stat.Puffer is a 12-bit counter on the UC100/AXBB-E path. Keep this
 * controller-specific: GRBL and the simulator report ordinary occupancies. */
const PUFFER_MODULUS = 4096

export interface ApplyVfdDefinitionResult {
  ok: boolean
  error: string | null
  /** What the bridge says it now holds. This is not inverter verification. */
  definition: VfdDefinition | null
}

/** WO-1006: what the bridge says it is HOLDING after a skew push.
 *
 *  `set` false with a null offset is "this bridge holds no measurement", which
 *  is a different claim from `set` true with `offsetMm: 0` - somebody measured
 *  this gantry and found it square. Same rule as `machineSkew` in src/types. */
export type ApplySkewResult = ControllerSkewApplyResult

interface ApplyVfdDefinitionOptions {
  /** A connect-time sync may create the link when hello says none exists yet.
   *  Edits never receive this exception and still require a stopped sample. */
  connectTimeSync?: boolean
}

interface UccncControllerOptions {
  /** OUR stored machine definition is the authority for this app-only choice.
   * Read it at encode time so a bridge refusal cannot make the checkbox and
   * the direction placed on the wire disagree. */
  directionInverted?: () => boolean
  /** The machine-owned drive choice, read at command time so changing the
   * definition does not require replacing the controller session. Undefined
   * preserves the legacy record's live-VFD fallback; explicit manual does not. */
  spindleDrive?: () => MachineSpindleDriveDefinition | undefined
  /** Persisted physical-machine fact carried into a replacement controller.
   * Status telemetry cannot override these axes; only a later homed push can. */
  datumRevokedAxes?: readonly JogAxis[]
}

/**
 * WHAT BOUNDS A HOMING CALL (WO-930). Two bounds, both app-side, both stated.
 *
 * The defect: `CALL_TIMEOUT_MS` applied to `home`/`homeAxes`, so **the app
 * abandoned any homing cycle longer than 8 seconds.** Z homes in 0.8 s so
 * nobody had hit it; X ran 55 s on 2026-08-23. In a scripted session a
 * slow-but-working home would have looked like a failure in the app while the
 * machine was still running - the one ambiguity a one-shot session cannot
 * afford.
 *
 * The fix is NOT a bigger number on its own. An unbounded wait is how a
 * 55-second runaway went unnoticed for 55 seconds, so a homing call is bounded
 * twice:
 *
 *   1. LIVENESS - `HOMING_LIVENESS_MS`. The bridge pushes status on change and
 *      at least every 100 ms moving / 500 ms idle (BRIDGE-PROTOCOL.md
 *      "Pushes"), and this client pokes it every `BRIDGE_KEEPALIVE_MS`. Five
 *      seconds of total silence is therefore a dead link, not a slow axis, and
 *      the call fails at once - as fast as the old 8 s budget for the failure
 *      the old budget was actually catching.
 *   2. CEILING - `HOMING_CEILING_PER_AXIS_MS` per axis in the list, however
 *      lively the bridge is. One `homeAxes` call can carry a whole ordered
 *      cycle, so the ceiling scales with the list rather than being one flat
 *      number that is either too small for three axes or absurd for one.
 *      120 s/axis is ~2x the worst axis ever measured here (55 s).
 *
 *      WO-938: on 2026-08-23 a 205 s X runaway ran past this 120 s ceiling
 *      and it never fired - measured on Operator's hardware. `callLongHoming`'s
 *      pure `setTimeout` was the whole mechanism, and this app runs in a
 *      BROWSER TAB: an unattended overnight cycle is exactly the shape of a
 *      tab that is not focused, and both Chrome and Firefox throttle
 *      `setTimeout` in a backgrounded tab, sometimes to once a minute. The
 *      ceiling now also carries a wall-clock deadline (`ceilingDeadline`)
 *      that `noteBridgeLiveness()` checks on every inbound frame - see that
 *      field's comment, and "ROOT CAUSE" in
 *      queue/WO-938-two-homing-guards-that-did-not-fire.md. The scaling
 *      itself (item above) is a SEPARATE, still-open gap for a multi-axis
 *      list: the bridge answers a whole list with one reply, so this file
 *      cannot see when axis 1 of 3 finishes and axis 2 starts, and a single
 *      hung axis can consume the WHOLE scaled budget rather than its own
 *      120 s share. Closing that needs the bridge to say so mid-cycle -
 *      `Machine.cs`, out of scope here - and is written up, not silently
 *      left, in the WO file above.
 *
 * WHAT THIS DOES NOT BOUND: **machine motion.** Abandoning the call is the app
 * giving up on an ANSWER; nothing here stops an axis. The bridge-side backstop
 * on travel is WO-921's, and the operator's is the E-STOP. Nor is abandoning
 * the call the end of the story: the bridge's own `homed` push still arrives
 * when the cycle really finishes and still records those axes, so a home that
 * outran the ceiling reports the truth late rather than being lost.
 */
export const HOMING_LIVENESS_MS = 5000
export const HOMING_CEILING_PER_AXIS_MS = 120000

/**
 * `applyMachineDefinition` gets its own, longer budget (WO-915).
 *
 * An apply is not one call at the far end: the bridge first clears the
 * controller's e-stop latch - up to six `Stop()` calls 250 ms apart, and the
 * latch is real, measured needing two on a cold board - then writes and reads
 * back every axis and the machine-wide inputs. The ordinary 8 s call budget
 * would time out on a slow board and leave the caller believing an apply
 * failed while it was still landing, which is the worst thing to be wrong
 * about here.
 */
export const APPLY_DEFINITION_TIMEOUT_MS = 30000

/**
 * How often this client sends SOMETHING to the bridge while connected.
 *
 * Not a feature - a safety obligation. BRIDGE-PROTOCOL.md: any frame from the
 * browser is a heartbeat, and the VfdLink stops the spindle if the client goes
 * quiet for longer than `ClientHeartbeatMs` (2 s, Vfd.cs:234). That watchdog is
 * correct and must not be softened: it is what stops a spindle when the browser
 * dies. The obligation is OURS - to keep proving we are alive.
 *
 * The protocol doc assumed this was free ("a UI that polls anything satisfies
 * this without trying"). True of the GRBL path, which polls `?` on a timer
 * (grbl/controller.ts); FALSE here - this transport is push-based, so before
 * this timer the app sent a frame only when the operator acted.
 *
 * MEASURED AT THE MACHINE, 2026-08-22, same command, one variable:
 *   client silent        -> reached 4999 RPM at t+1845ms, stopped ITSELF at
 *                           t+2573ms, lastStopReason "clientGone"
 *   queryStatus / 750 ms -> held 4999 RPM for the full 8 s run
 * So LienCAM could not run this spindle for longer than about 2.5 seconds.
 *
 * 750 ms leaves room for two consecutive misses inside the 2 s window. Raising
 * it past ~1 s spends that margin for nothing.
 */
export const BRIDGE_KEEPALIVE_MS = 750

/**
 * A successful output write receives a separate read-only observation budget.
 * This is a response budget, not a claim about relay settling time. Keeping it
 * below one second bounds MDI feedback while short, sequential reads leave Stop
 * and every other bridge call dispatchable.
 */
export const OUTPUT_CONFIRMATION_BUDGET_MS = 750
export const OUTPUT_CONFIRMATION_POLL_MS = 50
const OUTPUT_CONFIRMATION_READ_TIMEOUT_MS = 100
/** WO-2668: an edge read is not racing a write, so it waits as long as a call. */
const OUTPUT_STATE_READ_TIMEOUT_MS = 1000

const NO_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: false,
  bufferSeconds: false,
  // Contract v2 (WO-422): the AXBB-E has no G-code interpreter at all, so the
  // text path is false even once the bridge's hello arrives - see the bridge's
  // own capability frame, which reports it false too.
  gcodeText: false,
  perAxisHoming: false,
  ownsSpindle: false,
  spindleCommands: false,
}

function isQueuedMove(step: MachineProgram['steps'][number]): step is QueuedMove {
  return step.kind === 'line' || step.kind === 'arc' || step.kind === 'dwell' || step.kind === 'marker'
}

/** WO-1874: the progress bookkeeping a load writes before its frame goes out. */
interface StagedLoadBookkeeping {
  jobTotal: number
  jobStartedFlag: boolean
  jobMotionSeen: boolean
  jobLastMoveId: number | null
  streamedMoveOrdinals: ReadonlyMap<number, number>
  lastCompletedMoveId: number | null
  lastExecutingIdInJob: number | null
  pufferWrapsRemaining: number
  lastPufferMoves: number | null
  queuedMovesForProgress: number | null
  streamedAckedMoves: number
}

/**
 * WO-1874: A REFUSAL THE BOARD STATED, OR NOTHING.
 *
 * The bridge's `loadMoves` reply carries `{ok, reason}` in its value. Only an
 * explicit `ok: false` is a refusal; a bare `true`, a missing `ok` or any other
 * shape is a bridge that does not answer this question, and inventing a refusal
 * out of its silence would refuse a load the board may well have taken
 * (LIENCAM.md rule 11). A refusal with no words still gets a sentence, because
 * "not loaded" with no reason is not something an operator can act on.
 */
function readLoadMovesRefusal(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null
  const reply = value as { ok?: unknown; reason?: unknown }
  if (reply.ok !== false) return null
  return typeof reply.reason === 'string' && reply.reason.trim() !== ''
    ? reply.reason
    : 'the controller refused this program without giving a reason.'
}

const UNKNOWN_STATUS: MachineStatus = {
  state: 'unknown',
  subState: null,
  machinePos: null,
  workPos: null,
  feedMmMin: null,
  spindleRpm: null,
  overrides: null,
  executingMoveId: null,
  buffer: null,
  probeCycle: null,
  inputs: null,
  homed: null,
  spindle: null,
}

type OverrideSupport = Record<OverrideChange['kind'], boolean>

/** Optional, additive hello field. An older bridge has no declaration, which
 * must remain "unknown" rather than being guessed from the controller kind. */
function readOverrideSupport(capabilities: ControllerCapabilities): OverrideSupport | null {
  const raw = (capabilities as ControllerCapabilities & { overrides?: unknown }).overrides
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const value = raw as Record<string, unknown>
  if (
    typeof value.feed !== 'boolean'
    || typeof value.rapid !== 'boolean'
    || typeof value.spindle !== 'boolean'
  ) return null
  return { feed: value.feed, rapid: value.rapid, spindle: value.spindle }
}

/** What connect() needs from `backend`. BridgeTransport satisfies this
 *  structurally; tests may pass any fake that does. */
export interface UccncTransport {
  start(events: BridgeTransportEvents): Promise<void>
  send(message: BridgeClientMessage): void
  close(): Promise<void>
}

/** XYZ are required; a rotary coordinate is trusted only when its stated
 * value is finite. A bridge reply is cast off the socket, never prevalidated. */
function isFiniteMachinePosition(
  value: MachinePosition | null | undefined,
): value is MachinePosition {
  return value !== null
    && value !== undefined
    && Number.isFinite(value.x)
    && Number.isFinite(value.y)
    && Number.isFinite(value.z)
    && (value.a === undefined || Number.isFinite(value.a))
    && (value.b === undefined || Number.isFinite(value.b))
    && (value.c === undefined || Number.isFinite(value.c))
}

/** Offset rows are indexed by the canonical X/Y/Z/A/B/C order. Keep holes
 * before a sparse B or C so a later coordinate never shifts into A's cell. */
function machinePositionValues(position: MachinePosition): number[] {
  const values = [position.x, position.y, position.z]
  const rotary = [position.a, position.b, position.c]
  let last = rotary.length - 1
  while (last >= 0 && rotary[last] === undefined) last -= 1
  for (let index = 0; index <= last; index += 1) values.push(rotary[index] ?? 0)
  return values
}

/** WO-2187: `hello.workOffsets.rotation` (WO-2186) - degrees per system, 0 =
 *  none. Null when this bridge sent no rotation block (built before WO-2186);
 *  a value that is not a finite number is left out, never read as 0. */
function readHelloRotations(hello: unknown): WcsRotations | null {
  const offsets = typeof hello === 'object' && hello !== null
    ? (hello as { workOffsets?: unknown }).workOffsets
    : undefined
  const block = typeof offsets === 'object' && offsets !== null
    ? (offsets as { rotation?: unknown }).rotation
    : undefined
  if (typeof block !== 'object' || block === null) return null
  const out: Record<string, number> = {}
  for (const [wcs, deg] of Object.entries(block)) if (typeof deg === 'number' && Number.isFinite(deg)) out[wcs] = deg
  return out
}

function isUccncTransport(value: unknown): value is UccncTransport {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.start === 'function' && typeof v.send === 'function' && typeof v.close === 'function'
}

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: ReturnType<typeof setTimeout>
  /** WO-930: set only for a LONG call (homing). The ceiling fires whatever the
   *  bridge is saying; `timer` above is then the liveness window, re-armed by
   *  `noteBridgeLiveness()` on every inbound frame. */
  ceilingTimer?: ReturnType<typeof setTimeout>
  /**
   * WO-938. `Date.now() + ceilingMs`, stamped once at call start alongside
   * `ceilingTimer` - and, unlike that timer, NOT trusted to fire on its own.
   * A background/inactive browser tab is throttled by the browser itself
   * (Chrome and Firefox both clamp `setTimeout` in a tab that is not the
   * focused one, down to as little as one firing a minute for a
   * long-backgrounded tab) - exactly the shape of an unattended homing
   * cycle nobody is staring at. `noteBridgeLiveness()` cross-checks this
   * wall-clock deadline on every inbound frame, so a bridge that keeps
   * talking (which it does - see BRIDGE-PROTOCOL.md "Pushes") is what
   * actually catches an overrun `ceilingTimer` never got a chance to fire,
   * rather than the call waiting on a timer the tab was never scheduled to
   * run. See "ROOT CAUSE" in queue/WO-938-two-homing-guards-that-did-not-fire.md.
   */
  ceilingDeadline?: number
  /** Fires the exact abort `ceilingTimer` would have, on demand - called from
   *  `noteBridgeLiveness()` the instant an inbound frame proves the deadline
   *  has already passed. */
  expireCeiling?: () => void
  /** Re-arm the liveness window. Absent on an ordinary fixed-budget call,
   *  which is why those are untouched by bridge chatter. */
  keepAlive?: () => void
}

export class UccncController implements MachineController {
  private readonly events: ControllerEvents
  private transport: UccncTransport | null = null
  /** Transport callbacks outlive close in browsers and fakes. Each connect
   * captures this monotonically increasing generation so an old socket cannot
   * publish into, close, or satisfy a call on a later connection of this same
   * controller object. */
  private transportGeneration = 0
  /** A fake or very fast bridge may send hello inside start(). Cache that
   * frame so the 5 s hello deadline can begin after transport retry/open. */
  private connectingHello: BridgeHelloValue | null = null
  private readonly keepAliveTimer = new WorkerTimer()
  /** The quiet-link deadline uses the same worker-backed timing boundary as
   * bridge liveness, so a backgrounded browser does not quietly lose a VFD
   * safety check. It invokes vfdStopRequired; it owns no second policy. */
  private readonly vfdQuietStopTimer = new WorkerTimer()
  private phase: ConnectionPhase = 'disconnected'
  private _capabilities: ControllerCapabilities = NO_CAPABILITIES
  /** WO-1180: null means an older bridge made no per-channel claim. */
  private overrideSupport: OverrideSupport | null = null
  /** WO-2676: the bridge's SetOverride writes `to: 'percent'` as one
   *  absolute SetFRO/SetJRO/SetSRO (pendant/uccnc-bridge/Machine.cs). */
  readonly absoluteOverridePercent = true
  private readOnly = false
  private bridgeVersion: string | null = null
  private firmwareVersionValue: string | null = null
  // WO-448: the raw hello.vfd block, kept alongside `readOnly` so the connect
  // UI can surface both BEFORE an operator presses something the bridge will
  // refuse (BRIDGE-PROTOCOL.md "Hello"). Distinct from `vfdDefinition` above,
  // which is the COMPILED, matched definition (or null if unmatched) - this
  // is the bridge's own claim, unconditionally, even when nothing here
  // recognises the name.
  //
  // WO-967 widened that block with the definition DOCUMENT, and this field
  // carries it for the same "raw claim, verbatim" reason as the three fields
  // beside it. It is not validated here and nothing reads it off this field:
  // the surface that shows it reads `VfdPortLinkState.declared`, which is the
  // checked copy (`readDeclaredVfdDefinition`, bridgeTransport.ts). A consumer
  // reaching for the document belongs there, not here.
  private helloVfd: NonNullable<BridgeHelloValue['vfd']> | null = null
  // WO-911: the raw hello.uccnc block, kept the same way as helloVfd above -
  // the bridge's own claim about install root / profile / dll paths / the
  // enumerated .pro list, unconditionally, so a consumer (the WO-916 import
  // wizard) never has to re-derive it. Undefined before hello, after
  // disconnect, and when an older bridge sends no `uccnc` key at all - never
  // a `{}` that would read as "this machine has zero profiles." `undefined`
  // rather than `null` (unlike `helloVfd` above) deliberately: `bridgeHello()`
  // always emits this key, and bridgeConnect.wo448.test.tsx asserts the
  // published store value with `toEqual` against object literals that name
  // only `readOnly`/`vfd` - `toEqual` ignores `undefined`-valued keys but not
  // `null`-valued ones, so `null` here would fail that pre-existing,
  // out-of-scope test. Both `null` and `undefined` satisfy this WO's own
  // acceptance wording ("null or undefined - not a crash, not a `{}`").
  private helloUccnc: NonNullable<BridgeHelloValue['uccnc']> | undefined = undefined
  /** WO-1072: checked copies of the bridge's cache/profile reconciliation
   *  report. Undefined is meaningful: an older bridge never checked. */
  private helloDefinitionSource: BridgeDefinitionSource | undefined = undefined
  private helloDefinitionDrift: BridgeDefinitionDriftEntry[] | undefined = undefined
  private helloWorkOffsets: BridgeHelloValue['workOffsets'] | undefined = undefined
  /** WO-2187: each work system's rotation as the bridge reported it - its
   *  hello (`workOffsets.rotation`, every system) and each setWorkRotation
   *  receipt. Null when this bridge has said nothing about rotation. */
  private reportedRotations: WcsRotations | null = null
  private lastStatus: MachineStatus | null = null
  /** Sticky structured drive-fault edge already debounced by Machine.cs. */
  private driveFaultAlarmRaised = false
  private seq = 0
  private pending = new Map<number, PendingCall>()
  /** Per physical pin, so a later command owns that pin's result while reads
   * for unrelated ports/pins remain independent. */
  private outputCommandGeneration = new Map<string, number>()
  private helloWaiters: Array<(hello: BridgeHelloValue | null) => void> = []
  /**
   * Bridge startup lines can arrive before hello completes. Hold them until
   * the session layer has published its connected boundary; otherwise a real
   * line from this bridge would render among the previous session's history.
   */
  private connectingConsole: ConsoleEntry[] = []
  /** WO-930/1125: per axis, never one boolean. A non-null status frame is the
   *  continuous authority; `homed` pushes still merge completed axes so the
   *  console and gates react immediately between frames. */
  private homedAxes: Partial<Record<ControlAxis, boolean>> = {}
  /**
   * Axes whose datum was explicitly revoked by a position-lost alarm. A
   * bridge status sampled before that alarm was processed may still say true;
   * it cannot restore authority, even after reconnect. Only a later homing
   * event clears this latch.
   */
  private datumRevokedAxes: Set<ControlAxis>
  private singleBlockFlag = false
  private jobActiveFlag = false
  /** WO-2137: bumped by every start, step, stop and job event, so a start's
   *  late refusal rolls the job flags back only if nothing wrote them since. */
  private jobStartAttempt = 0
  private activeHoming: { axes: readonly AxisName[] } | null = null
  /** Board, 2026-09-14 (WO-1530): a loaded job has pushed NOTHING to the board
   *  until it is started or stepped, so an empty board buffer before that means
   *  "nothing sent yet", not "every move acknowledged". Set when the job starts
   *  or steps; cleared by a new load and by stop. A completed job keeps it. */
  private jobStartedFlag = false
  /** The loaded program's LAST move id. Once it has run and the board is idle or
   *  in hold, the job is done - whatever the buffer occupancy still says (board
   *  2026-09-14, WO-1530: Single Block kept offering a 7th block). */
  private jobLastMoveId: number | null = null
  /** True once a status frame has reported `run` since the last load, start,
   *  step or stop. Guards the last-move rule against a stale frame whose
   *  executing id is the last move of an identical, re-armed program. */
  private jobMotionSeen = false
  private jobTotal = 0
  /**
   * WO-1018: state for reconstructing the UCCNC board's wrapped Stat.Puffer
   * value for the line-shaped progress display. `programProgress()` continues
   * to expose the raw board occupancy; a future bridge contract that sends an
   * unwrapped value should delete this reconstruction instead of adding a
   * second opinion about the same number.
   *
   * `(jobTotal - 1) / 4096` is deliberate: totals through and including 4096
   * stay byte-identical to the old expression. A report >= 4096 proves this
   * session is not wrapping and disables reconstruction for the run, so a
   * correct value from non-wrapping hardware is preserved.
   */
  private pufferWrapsRemaining = 0
  private lastPufferMoves: number | null = null
  private queuedMovesForProgress: number | null = null
  /** WO-1081: whole-program ordinal by the original id that the bridge maps
   * back from its recycled wire id. Only long, window-streamed jobs use this;
   * ring-sized jobs retain WO-1018's Puffer behavior byte for byte. */
  private streamedMoveOrdinals: ReadonlyMap<number, number> = new Map()
  private streamedAckedMoves = 0
  /**
   * WO-1023: the last move id this controller can HONESTLY say finished.
   *
   * The bridge reports what is EXECUTING; it never reports what completed. The
   * one completion this end can observe without inventing anything is the
   * hand-over: while a job is active, the executing id moving from one real id
   * to a DIFFERENT real id means the board finished the first and started the
   * second, because its queue runs in order (`StreamStaged`, Machine.cs:4041).
   *
   * Three deliberate silences, each one a fact we do not have:
   *  - the id in flight when a job stops is never marked completed - it was
   *    interrupted, which is the opposite;
   *  - a transition to or from 0 advances nothing: 0 is the connect sentinel
   *    (Machine.cs:426), i.e. "nothing started", not a move;
   *  - nothing advances while no job is active, and the previous half of a
   *    hand-over is read from `lastExecutingIdInJob` (a frame seen INSIDE this
   *    job), never from `lastStatus`, so a stale id left over from a previous
   *    session OR a previous job can never be reported as this one's progress.
   * `null` until a hand-over is actually seen. NEVER derived by counting: these
   * are OUR ids, not ordinals, and a program may mint 1, 2, 5.
   *
   * ATTEMPT 2: this is one of the two PROGRESS CURSORS. It is never cleared on
   * its own - only by `resetProgressCursors()`, which clears both. See that
   * method for why the pair is indivisible.
   */
  private lastCompletedMoveId: number | null = null
  /**
   * WO-1023 fix round: the executing id from the last status frame that
   * arrived WHILE THIS JOB WAS RUNNING - the only id a hand-over may treat as
   * "the move that was in flight a moment ago".
   *
   * `lastStatus` cannot serve that purpose. It survives a load and a start
   * (deliberately - the DRO must not blank between jobs), so the frame it
   * holds when a new job's first status lands may still name a move from the
   * PREVIOUS job. Reading the hand-over off it recorded that stale id as
   * completed inside the new job: a completion neither the board nor the
   * bridge ever reported. This field is only ever written while
   * `jobActiveFlag` is true.
   *
   * ATTEMPT 2: this is the other PROGRESS CURSOR. Like its partner it is never
   * cleared on its own - only by `resetProgressCursors()`. See that method.
   */
  private lastExecutingIdInJob: number | null = null
  /** WO-1874: the board's own answer to the load frame last sent on this link.
   *  See `stagedLoadVerdict()` for what it does and does not claim. */
  private pendingStagedLoad: Promise<{ ok: boolean; reason: string | null }> | null = null
  /** Which load a late reply belongs to: only the newest one may roll the
   *  progress bookkeeping back, or a slow refusal would undo the load after it. */
  private stagedLoadSequence = 0
  private resetToIdlePromise: Promise<{ ok: boolean; reason: string | null }> | null = null
  private resetToIdleListeners = new Set<() => void>()

  // ---- WO-441/442: the VFD decode --------------------------------------------
  //
  // The bridge's `hello` names which definition is active (present + name,
  // never the definition itself - see BRIDGE-PROTOCOL.md "Hello"), and its
  // `vfd` push carries only RAW register words plus which of them are named
  // under the identity-scale rule (Vfd.cs). Vfd.cs's header rule - one
  // expression evaluator in the product, and it is not in C# - means turning
  // those words into real units (rpm, volts, amps, torque, power) happens
  // HERE, through the same compiled scale expressions vfdRuntime.ts uses
  // everywhere else. WO-441 landed the decode but had nowhere to publish it
  // beyond `MachineStatus.spindleRpm`, since `BridgeMessage` /
  // `BridgeHelloPush` (bridgeTransport.ts) did not yet carry a `vfd` push
  // variant or `hello.vfd`, and `MachineStatus` (controller.ts) had no slot
  // for volts/amps/torque/power/upToSpeed - so both were read/held
  // defensively (`as unknown as`, `vfdReadings()`) rather than widening
  // shared types out of scope. WO-442 closes that: both types now declare the
  // shape (matching BRIDGE-PROTOCOL.md exactly), the casts are gone, and
  // `status().spindle` is the published home - `vfdReadings()` stays as a
  // convenience for callers that want the bare readings without null-padding.
  private vfdDefinition: VfdDefinition | null = null
  private vfdCompiledScales: VfdCompiledScales | null = null
  /** OUR machine-definition choice, read at the app-to-bridge boundary. */
  private readonly directionInverted: () => boolean
  private readonly spindleDrive: (() => MachineSpindleDriveDefinition | undefined) | null
  /** Whether THIS bridge session currently holds a VFD link. Kept separate
   * from the selected drive because either fact can change while connected. */
  private vfdSpindleCommands = false
  /** WO-1724's bridge half advertises this additive hello capability. Until
   * then a board drive remains unsupported, so programs take the existing
   * manual-start path and a direct call refuses synchronously with a reason. */
  private boardSpindleCommands = false
  private vfdLastReadings: VfdReadings = {}
  /** The inverter's own answer to "are you turning", straight off the `vfd`
   *  push. Null until one arrives - never defaulted to false, which would be
   *  a UI claiming the spindle is stopped on no evidence at all. */
  private vfdTurning: boolean | null = null
  /** Connect-time definition sync begins immediately after hello, before the
   *  next WebSocket push can run. Keep that apply off the wire until a `vfd`
   *  sample affirmatively reports stopped; unknown is not a safe default. */
  private vfdTurningWaiters = new Set<(turning: boolean | null) => void>()
  /** False until the FIRST `vfd` push has been processed. Before that, the
   *  bridge's own `spindleRpm` (already gated to identity-scale fields only -
   *  Vfd.cs) is trusted rather than blanked to null on every status frame
   *  just because nothing has been decoded here yet. After that, this side is
   *  authoritative, including nulling out on a dropped link or a fault the
   *  bridge's raw pass-through would not otherwise reflect until its next
   *  poll. */
  private vfdHasSample = false

  /** WO-475: the last vfd push's `up` - whether the inverter ANSWERED, which
   *  is a different question from whether a link is configured. Null until the
   *  first push, because "unknown" and "down" are not the same claim. */
  private vfdLinkUp: boolean | null = null

  /** The last successful VFD poll THIS client observed. It is reset only by
   * `up: true`, never by a poll count, retry setting, or browser heartbeat. */
  private vfdLastSuccessAtMs: number | null = null
  /** The one TypeScript producer for vfdStopRequired. Each VFD frame replaces
   * this raw snapshot; the deadline only derives elapsed wall-clock time. */
  private vfdSafetyState: VfdLinkState = VFD_LINK_STATE_DOWN
  /** One stop per quiet-link episode. Recurring dead-link frames cannot repeat
   * the command; only a later successful VFD sample rearms this layer. */
  private vfdQuietStopIssued = false

  /** The RPM last commanded through `spindleOn`, or null when the spindle was
   *  stopped or never started. This is the missing half of `upToSpeed`: the
   *  inverter reports what it IS doing, and only the caller knows what it was
   *  ASKED to do. WO-905. */
  private commandedRpm: number | null = null

  constructor(events: ControllerEvents, options: UccncControllerOptions = {}) {
    this.events = events
    this.directionInverted = options.directionInverted ?? (() => false)
    this.spindleDrive = options.spindleDrive ?? null
    this.datumRevokedAxes = new Set(options.datumRevokedAxes ?? [])
  }

  get capabilities(): ControllerCapabilities {
    const spindleCommands = this.spindleCommandsFor(this.currentSpindleDrive())
    if (this._capabilities.spindleCommands !== spindleCommands) {
      this._capabilities = { ...this._capabilities, spindleCommands }
    }
    return this._capabilities
  }

  /** One live answer for every capability reader. The definition callback is
   * deliberately read here, not snapshotted at hello: saving a new drive does
   * not create a new controller session. Undefined preserves legacy records'
   * hello-VFD behavior. */
  private currentSpindleDrive(): MachineSpindleDriveDefinition {
    return this.spindleDrive?.()
      ?? (this.vfdSpindleCommands ? { kind: 'modbus-vfd' } : { kind: 'manual' })
  }

  private spindleCommandsFor(drive: MachineSpindleDriveDefinition): boolean {
    if (drive.kind === 'modbus-vfd') return this.vfdSpindleCommands
    if (drive.kind === 'board-speed' || drive.kind === 'relay') return this.boardSpindleCommands
    return false
  }

  /**
   * WO-448: what the bridge's `hello` frame said about THIS session -
   * `readOnly` and the raw `vfd` declaration - so the connect UI can surface
   * both before the operator presses something the bridge will refuse
   * (BRIDGE-PROTOCOL.md "Hello": "the UI must say so rather than letting the
   * operator discover it by pressing something"). Null before hello has
   * arrived and after disconnect - never a stale answer left over from a
   * previous bridge process.
   *
   * WO-911: `uccnc` rides along the same way, for the same reason - the raw
   * install root / profile / dll paths / `.pro` list, or undefined when the
   * bridge sent none (see the `helloUccnc` field comment for why undefined
   * rather than null here).
   */
  bridgeHello(): ControllerBridgeHello | null {
    if (this.phase !== 'connected') return null
    return {
      readOnly: this.readOnly,
      vfd: this.helloVfd,
      uccnc: this.helloUccnc,
      definitionSource: this.helloDefinitionSource,
      definitionDrift: this.helloDefinitionDrift,
      workOffsets: this.helloWorkOffsets,
    }
  }

  /** True only when this connected bridge explicitly names CNCdrive's demo
   * controller. An omitted board belongs to an older bridge and retains its
   * prior behavior; absence is never promoted into a hardware claim. */
  simulatedBoard(): boolean {
    const board = this.helloUccnc?.board
    return typeof board === 'number' && Number.isFinite(board) && board <= 0
  }

  // ---- lifecycle ----

  async connect(backend: ControllerBackend): Promise<void> {
    if (this.phase !== 'disconnected') throw new Error('Already connected or connecting')
    // Contract v3 types the payload too, so a message channel arrives as a
    // MessageChannel. This backend needs the narrower bridge shape on top of
    // it (its `send` takes a call frame, its `onMessage` a decoded one), so the
    // runtime check stays and the local is annotated rather than left as the
    // intersection - `kind` is the caller's claim, not proof.
    if (backend.kind !== 'messages' || !isUccncTransport(backend.transport)) {
      throw new Error('UccncController.connect needs a bridge transport (see bridgeTransport.ts)')
    }
    const transport: UccncTransport = backend.transport
    const generation = ++this.transportGeneration
    this.connectingConsole = []
    this.connectingHello = null
    // Publish the generation boundary while no transport is attached. The
    // session resets the controller-local Single Block flag at this edge; the
    // explicit bridge synchronization follows on the connected edge, after
    // start() can carry it.
    this.setPhase('connecting', null)
    this.transport = transport
    try {
      await transport.start({
        onMessage: (m) => this.handleMessage(m, transport, generation),
        onClose: (reason) => this.handleClose(reason, transport, generation),
      })
      // WO-1783: start() owns the one measured 6 s old-bridge retry. Starting
      // this deadline before the socket opens made that recovery impossible.
      // connectingHello preserves transports that answer synchronously.
      const hello = this.connectingHello ?? await this.waitForHello(HELLO_TIMEOUT_MS)
      this.connectingHello = null
      if (!hello) {
        throw new Error('The machine bridge never sent its hello frame.')
      }
      if (hello.protocol !== SUPPORTED_BRIDGE_PROTOCOL) {
        throw new Error(
          `This LienCAM speaks bridge protocol ${SUPPORTED_BRIDGE_PROTOCOL}, but the bridge ` +
            `(${hello.bridge}) speaks protocol ${hello.protocol}. Update the bridge or LienCAM so they match.`,
        )
      }
      // WO-1723: the machine definition chooses the drive, while the live
      // bridge decides whether this connection can carry that choice. A drive
      // unsupported by this bridge stays on the program's manual-start path
      // instead of attaching a spindle command that Cycle Start must refuse.
      // Older direct users without a machine callback retain the hello-VFD
      // fallback.
      this.vfdSpindleCommands = hello.vfd?.present === true
      this.boardSpindleCommands = (hello.capabilities as ControllerCapabilities & {
        boardSpindleCommands?: unknown
      }).boardSpindleCommands === true
      const drive = this.currentSpindleDrive()
      const spindleCommands = this.spindleCommandsFor(drive)
      this._capabilities = { ...hello.capabilities, spindleCommands }
      this.overrideSupport = readOverrideSupport(hello.capabilities)
      this.readOnly = hello.readOnly
      this.helloVfd = hello.vfd ?? null
      this.helloUccnc = hello.uccnc
      this.helloDefinitionSource = readBridgeDefinitionSource(hello.definitionSource)
      this.helloDefinitionDrift = readBridgeDefinitionDrift(hello.definitionDrift)
      this.helloWorkOffsets = hello.workOffsets
      this.bridgeVersion = hello.bridge
      this.setPhase('connected', this.firmwareVersionValue ?? this.bridgeVersion)
      if ((drive.kind === 'board-speed' || drive.kind === 'relay') && !this.boardSpindleCommands) {
        this.events.onConsole?.({
          dir: 'rx',
          text: 'This machine uses a board-driven spindle. This bridge build cannot drive it yet; board spindle support is the next bridge-side update.',
          severity: 'warn',
        })
      }
      const board = hello.uccnc?.board
      if (typeof board === 'number' && Number.isFinite(board)) {
        this.events.onConsole?.({
          dir: 'rx',
          text: board <= 0
            ? `board ${board} - THIS IS THE DEMO CONTROLLER. Nothing will move; every command is simulated.`
            : `board ${board} (REAL HARDWARE).`,
          severity: board <= 0 ? 'warn' : 'info',
        })
      }
      const startupConsole = this.connectingConsole
      this.connectingConsole = []
      for (const entry of startupConsole) this.deliverConsole(entry, transport, generation)
      // Last, and only once the connection is real: see BRIDGE_KEEPALIVE_MS.
      // `queryStatus` is an EXISTING read - the protocol says there should be no
      // dedicated heartbeat message, because the point is proof the client is
      // alive and any frame is that. It also refreshes the status snapshot, so
      // the frame is not spent on nothing.
      this.startKeepAlive()
    } catch (err) {
      if (this.transportIsCurrent(transport, generation)) await this.disconnect()
      throw err
    }
  }

  async disconnect(): Promise<void> {
    const transport = this.transport
    this.teardown('disconnect requested')
    if (transport) await transport.close()
  }

  connectionPhase(): ConnectionPhase {
    return this.phase
  }

  firmwareVersion(): string | null {
    return this.firmwareVersionValue
  }

  // ---- state ----

  machineState(): MachineState {
    return this.lastStatus?.state ?? 'unknown'
  }

  status(): MachineStatus {
    return this.lastStatus ?? UNKNOWN_STATUS
  }

  /**
   * WO-441: the VFD readings this controller has decoded from the bridge's
   * most recent `vfd` push, in real units - rpm, volts, amps, torque, power,
   * whichever the active definition names. Empty (never a stale value) when
   * there is no matching definition, the link is down, or the inverter is
   * faulted. `actualRpm` is also folded into `status().spindleRpm`, and
   * volts/amps/torque/power/upToSpeed are published (null-padded to every
   * field the WO names, whether or not this definition reports it) on
   * `status().spindle` - WO-442. This method stays as the bare, un-padded
   * reading set for callers that want exactly what was decoded.
   */
  vfdReadings(): VfdReadings {
    return this.vfdLastReadings
  }

  /**
   * Whether the decoded actual RPM is within the active definition's
   * `upToSpeedToleranceRpm` of `commandedRpm`. Null when there is no active
   * definition or no actual-RPM reading to compare - never a guessed true or
   * false. No spindle-on call exists yet in this controller to source
   * `commandedRpm` from automatically, so a caller supplies the RPM it last
   * commanded.
   */
  vfdUpToSpeed(commandedRpm: number): boolean | null {
    if (!this.vfdDefinition || this.vfdLastReadings.actualRpm === undefined) return null
    return vfdIsUpToSpeed(this.vfdDefinition, commandedRpm, this.vfdLastReadings.actualRpm)
  }

  // ---- spindle (WO-905) ------------------------------------------------
  //
  // The bridge takes a `setpointWord` and refuses to compute it from RPM: one
  // expression evaluator, and it is not in C#. So the conversion happens HERE,
  // through the definition's own `setpoint` expression - never a hardcoded
  // /2.4, which is only this inverter's number.

  spindleOn(direction: 'cw' | 'ccw', rpm: number): boolean {
    if (this.phase !== 'connected') return false
    const drive = this.spindleDrive?.()
      ?? (this.vfdDefinition !== null ? { kind: 'modbus-vfd' } : { kind: 'manual' })
    if (drive.kind === 'board-speed' || drive.kind === 'relay') {
      if (!this.boardSpindleCommands) {
        this.events.onConsole?.({
          dir: 'rx',
          text: 'The spindle command was not sent: this bridge build cannot drive a board spindle yet.',
          severity: 'error',
        })
        return false
      }
      this.commandedRpm = rpm
      this.fireAndForget('spindleOn', { direction, rpm, drive })
      return true
    }
    if (!this.vfdDefinition || !this.vfdCompiledScales) {
      this.events.onConsole?.({
        dir: 'rx',
        text: 'No inverter definition is active, so the spindle speed cannot be worked out. Start the bridge with --vfd.',
        severity: 'error',
      })
      return false
    }
    if (drive.kind === 'manual') return false
    const setpoint = vfdSetpointWord(this.vfdDefinition, this.vfdCompiledScales, rpm)
    if (!setpoint.ok) {
      this.events.onConsole?.({ dir: 'rx', text: `Spindle: ${setpoint.sentence}`, severity: 'error' })
      return false
    }
    // Clamping is reported, never silent - a spindle running slower than asked
    // is safe, one that silently ran a wrapped-around word is not.
    if (setpoint.clamped) {
      this.events.onConsole?.({
        dir: 'rx',
        text: `Spindle: ${rpm} RPM is outside this inverter's range, so it was limited to word ${setpoint.word}.`,
        severity: 'warn',
      })
    }
    // Remembered so `status.spindle.upToSpeed` can stop being null: comparing
    // actual against commanded is the whole definition of up-to-speed, and
    // until there was a spindleOn call there was nothing to compare against.
    this.commandedRpm = rpm
    const wireDirection = this.directionInverted()
      ? (direction === 'cw' ? 'ccw' : 'cw')
      : direction
    this.fireAndForget('spindleOn', { direction: wireDirection, setpointWord: setpoint.word })
    // If the link became quiet while the spindle was off, its original timer
    // has already elapsed. Apply the unchanged deadline immediately rather
    // than granting a fresh budget when a spindle command makes it actionable.
    this.evaluateVfdQuietStop()
    return true
  }

  /** NOTHING GATES A STOP - not the phase, not a missing definition, not a
   *  link that was never configured. Sent whenever there is a transport at
   *  all; the bridge accepts it unconditionally too, including with no link,
   *  where there is simply nothing to stop. */
  spindleOff(): void {
    this.commandedRpm = null
    if (!this.transport) return
    this.fireAndForget('spindleOff', {})
  }

  /** WO-1637/1800: send the bridge's one output switch exactly once. OFF goes
   *  whenever there is a transport (a stop is never gated on the phase, as
   *  `spindleOff`); ON only when connected. The write receipt may contain an
   *  early raw sample, so a successful write is followed only by bounded,
   *  read-only `getOutput` observations. */
  setOutput(request: OutputSwitchRequest): Promise<OutputSwitchReceipt> | null {
    const transport = this.transport
    if (!transport) return null
    if (request.on && this.phase !== 'connected') return null
    const transportGeneration = this.transportGeneration
    const pinKey = `${request.port}:${request.pin}`
    const commandGeneration = (this.outputCommandGeneration.get(pinKey) ?? 0) + 1
    this.outputCommandGeneration.set(pinKey, commandGeneration)
    return this.call<unknown>('setOutput', {
      port: request.port,
      pin: request.pin,
      on: request.on,
      negate: request.negate,
    }).then(
      (value): Promise<OutputSwitchReceipt> => this.confirmOutputReadback(
        request,
        readOutputReadback(value),
        transport,
        transportGeneration,
        pinKey,
        commandGeneration,
      ),
      (err: unknown): OutputSwitchReceipt => ({
        ok: false,
        reason: err instanceof Error ? err.message : String(err),
        superseded: !this.outputConfirmationIsCurrent(
          transport,
          transportGeneration,
          pinKey,
          commandGeneration,
        ),
      }),
    )
  }

  /** WO-2668: one read-only `getOutput`, for the session's output state after
   *  an edge it did not switch (connect, Stop/Reset, E-STOP, job end). A read
   *  failure is "could not report", never a refusal. */
  readOutput(request: Omit<OutputSwitchRequest, 'on'>): Promise<OutputReadback | null> | null {
    if (!this.transport || this.phase !== 'connected') return null
    return this.call<unknown>('getOutput', {
      port: request.port,
      pin: request.pin,
      negate: request.negate,
    }, OUTPUT_STATE_READ_TIMEOUT_MS).then(readOutputReadback, () => null)
  }

  private outputConfirmationIsCurrent(
    transport: UccncTransport,
    transportGeneration: number,
    pinKey: string,
    commandGeneration: number,
  ): boolean {
    return this.transportIsCurrent(transport, transportGeneration)
      && this.outputCommandGeneration.get(pinKey) === commandGeneration
  }

  private waitForOutputPoll(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }

  /**
   * Confirm only with a sample requested after the accepted write. Failures and
   * persistent opposites consume this finite response budget but never turn the
   * accepted write into a refusal. No output command is retried.
   */
  private async confirmOutputReadback(
    request: OutputSwitchRequest,
    firstObservation: OutputReadback | null,
    transport: UccncTransport,
    transportGeneration: number,
    pinKey: string,
    commandGeneration: number,
  ): Promise<OutputSwitchReceipt> {
    const deadline = Date.now() + OUTPUT_CONFIRMATION_BUDGET_MS
    let latest = firstObservation
    while (Date.now() < deadline) {
      if (!this.outputConfirmationIsCurrent(
        transport,
        transportGeneration,
        pinKey,
        commandGeneration,
      )) {
        return { ok: true, confirmation: 'superseded', readback: latest }
      }
      await this.waitForOutputPoll(Math.min(OUTPUT_CONFIRMATION_POLL_MS, deadline - Date.now()))
      if (!this.outputConfirmationIsCurrent(
        transport,
        transportGeneration,
        pinKey,
        commandGeneration,
      )) {
        return { ok: true, confirmation: 'superseded', readback: latest }
      }
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      try {
        const value = await this.call<unknown>('getOutput', {
          port: request.port,
          pin: request.pin,
          negate: request.negate,
        }, Math.min(OUTPUT_CONFIRMATION_READ_TIMEOUT_MS, remaining))
        const observation = readOutputReadback(value)
        if (observation !== null) latest = observation
        if (observation?.on === request.on) {
          if (!this.outputConfirmationIsCurrent(
            transport,
            transportGeneration,
            pinKey,
            commandGeneration,
          )) {
            return { ok: true, confirmation: 'superseded', readback: observation }
          }
          return { ok: true, confirmation: 'confirmed', readback: observation }
        }
      } catch {
        // A read failure says nothing about the already accepted write. Keep
        // observing until the named budget expires or this command is stale.
      }
    }
    if (!this.outputConfirmationIsCurrent(
      transport,
      transportGeneration,
      pinKey,
      commandGeneration,
    )) {
      return { ok: true, confirmation: 'superseded', readback: latest }
    }
    return { ok: true, confirmation: 'unconfirmed', readback: latest }
  }

  spindleResetFault(): void {
    if (this.phase !== 'connected') return
    this.fireAndForget('spindleResetFault', {})
  }

  queryStatus(): void {
    if (this.phase !== 'connected') return
    this.fireAndForget('queryStatus', {})
  }

  refreshState(): boolean {
    if (this.phase !== 'connected') return false
    this.fireAndForget('refreshState', {})
    return true
  }

  querySettings(): boolean {
    if (this.phase !== 'connected') return false
    this.fireAndForget('querySettings', {})
    return true
  }

  verifiedIdle(): boolean {
    return this.lastStatus?.state === 'idle'
  }

  /**
   * WO-930: every gate axis, not "some cycle finished".
   *
   * This used to be a flag set by the `.then()` of ANY `homeAxes` call, with
   * no reference to the list. The acceptance demo homes ONE axis, and that
   * flag was what told the app the whole machine had a datum.
   */
  homedThisSession(): boolean {
    return HOMED_GATE_AXES.every((axis) => this.homedAxes[axis] === true)
  }

  homedAxesThisSession(): Partial<Record<JogAxis, boolean>> {
    const gateAxes: Partial<Record<JogAxis, boolean>> = {}
    for (const axis of HOMED_GATE_AXES) {
      if (this.homedAxes[axis] !== undefined) gateAxes[axis] = this.homedAxes[axis]
    }
    return gateAxes
  }

  invalidateDatum(axes: readonly JogAxis[] | null): void {
    this.activeHoming = null
    const revoked = axes ?? HOMED_GATE_AXES
    const next = { ...this.homedAxes }
    for (const axis of revoked) {
      this.datumRevokedAxes.add(axis)
      next[axis] = false
    }
    this.homedAxes = next
  }

  /** Record a completed cycle. `null` axes means a backend that finished a
   *  cycle without saying which axes it covered - the protocol says this
   *  bridge always says (BRIDGE-PROTOCOL.md: "`homed.axes` is never null"),
   *  and an older one that does not is treated as the whole-machine cycle it
   *  used to be read as, so nothing that works today stops working. */
  private recordHomed(axes: readonly AxisName[] | null): void {
    const covered = axes ?? HOMED_GATE_AXES
    const next = { ...this.homedAxes }
    for (const axis of covered) {
      this.datumRevokedAxes.delete(axis)
      next[axis] = true
    }
    this.homedAxes = next
  }

  /** Adopt the bridge's continuous per-axis fact exactly. A nullish value
   *  means an older or keyless frame has no per-axis answer, so push-derived
   *  state remains the honest fallback instead of being erased by missing
   *  telemetry. Rotary axes are presentation facts here; the existing
   *  Cartesian machine-coordinate gates remain keyed by HOMED_GATE_AXES. */
  private adoptReportedHomed(axes: MachineStatus['homed'] | undefined): void {
    if (axes == null) return
    const next: Partial<Record<ControlAxis, boolean>> = {}
    for (const axis of AXIS_NAMES) {
      if (axes[axis] !== undefined) {
        next[axis] = this.datumRevokedAxes.has(axis) ? false : axes[axis]
      }
    }
    this.homedAxes = next
  }

  /** Every axis loses its datum. Used where the position counter's MEANING may
   *  have changed under us - a failed/partial apply, a lost link. Deliberately
   *  all-or-nothing even when the bridge named specific axes to re-home: this
   *  is what the collapsed flag did, and clearing fewer axes here would be
   *  MORE permissive than today, which this order forbids. */
  private dropAllHomed(): void {
    this.homedAxes = {}
  }

  resetInProgress(): boolean {
    return this.resetToIdlePromise !== null
  }

  subscribeResetInProgress(listener: () => void): () => void {
    this.resetToIdleListeners.add(listener)
    return () => this.resetToIdleListeners.delete(listener)
  }

  // ---- motion ----

  jog(axis: ControlAxis, deltaMm: number, feedMmMin: number): boolean {
    if (!this.motionAllowed()) return false
    this.fireAndForget('jog', { axis, deltaMm, feedMmMin })
    return true
  }

  jogToWorkXY(x: number, y: number, feedMmMin: number): boolean {
    if (!this.motionAllowed()) return false
    this.fireAndForget('jogToWorkXY', { x, y, feedMmMin })
    return true
  }

  jogToMachineZ(z: number, feedMmMin: number): boolean {
    if (!this.motionAllowed()) return false
    this.fireAndForget('jogToMachineZ', { z, feedMmMin })
    return true
  }

  jogToWorkXYAwait(x: number, y: number, feedMmMin: number): Promise<boolean> | null {
    if (!this.motionAllowed() || !this.transport) return null
    return this.call<boolean>('jogToWorkXY', { x, y, feedMmMin }).then((v) => v !== false)
  }

  jogToMachineZAwait(z: number, feedMmMin: number): Promise<boolean> | null {
    if (!this.motionAllowed() || !this.transport) return null
    return this.call<boolean>('jogToMachineZ', { z, feedMmMin }).then((v) => v !== false)
  }

  jogCancel(): void {
    if (!this.transport) return
    this.fireAndForget('jogCancel', {})
  }

  /**
   * WO-1111: the AXBB runs its own jog, so a held button is ONE motion.
   *
   * The bridge arms a deadman when this succeeds and stops the axis itself if
   * `jogHold` stops arriving, so the panel must keep calling `jogHold` for as
   * long as the operator is holding the button. That is the whole safety
   * bargain of a motion that runs until it is told to stop.
   */
  async jogStartContinuous(axis: JogAxis, direction: 1 | -1, feedMmMin: number): Promise<boolean> {
    if (!this.motionAllowed()) return false
    try {
      const ok = await this.call<boolean>('jogStart', { axis, direction, feedMmMin })
      return ok !== false
    } catch {
      return false
    }
  }

  /** "Still holding." Fire-and-forget on purpose: a keepalive that waits for a
   *  reply would queue behind whatever else is in flight, and a late keepalive
   *  is a stopped machine under the operator's finger. */
  jogHold(): void {
    if (!this.transport) return
    this.fireAndForget('jogHold', {})
  }

  jogStop(): void {
    if (!this.transport) return
    this.fireAndForget('jogStop', {})
  }

  /**
   * The orderless whole-machine cycle - and against this bridge it now EARNS A
   * REFUSAL, deliberately.
   *
   * WO-914: the homing order is a per-machine safety setting and the bridge
   * holds none. `Machine.Home()` refuses and names the fix rather than
   * substituting a list of its own, because a default at both ends would leave
   * a future reader unable to tell which one ran.
   *
   * This method does NOT quietly rewrite itself into
   * `homeAxes(resolveHomingOrder(null))`. Doing so would hide exactly the
   * disagreement the refusal exists to expose, and would make the bridge's
   * message unreachable and untested. The fallback belongs where the machine
   * definition is in hand - `JogPanel`'s Home All resolves it there - not in a
   * backend guessing on the operator's behalf. `capabilities.perAxisHoming` is
   * true for this bridge, so Home All never comes through here.
   */
  home(): boolean {
    if (!this.motionAllowed()) return false
    const transport = this.transport
    if (!transport) return false
    const generation = this.transportGeneration
    this.activeHoming = { axes: HOMED_GATE_AXES }
    this.lastStatus = { ...(this.lastStatus ?? UNKNOWN_STATUS), state: 'home' }
    this.events.onStatus?.(this.lastStatus)
    void this.callLongHoming('home', {}, HOMED_GATE_AXES.length)
      .then(() => {
        if (!this.transportIsCurrent(transport, generation)) return
        this.activeHoming = null
        this.recordHomed(null)
        this.emitSettledHomingStatus()
      })
      .catch((err) => {
        this.activeHoming = null
        if (this.transportIsCurrent(transport, generation)) {
          this.reportCallFailure('home', err)
          this.emitSettledHomingStatus()
        }
      })
    return true
  }

  /** Sent VERBATIM: the order the machine definition holds is the order the
   *  wire carries, with no filtering, reordering or de-duplication here. The
   *  bridge validates each name against the board and refuses the whole call
   *  if one is wrong - see `Machine.HomeAxes`. */
  homeAxes(axes: AxisName[]): boolean {
    if (!this.motionAllowed() || !this._capabilities.perAxisHoming) return false
    const transport = this.transport
    if (!transport) return false
    const generation = this.transportGeneration
    const requested = [...axes]
    if (requested.length > 0) {
      this.activeHoming = { axes: requested }
      this.lastStatus = { ...(this.lastStatus ?? UNKNOWN_STATUS), state: 'home' }
      this.events.onStatus?.(this.lastStatus)
    }
    void this.callLongHoming('homeAxes', { axes }, requested.length)
      .then(() => {
        if (!this.transportIsCurrent(transport, generation)) return
        this.activeHoming = null
        this.recordHomed(requested)
        this.emitSettledHomingStatus()
      })
      .catch((err) => {
        this.activeHoming = null
        if (this.transportIsCurrent(transport, generation)) {
          this.reportCallFailure('homeAxes', err)
          this.emitSettledHomingStatus()
        }
      })
    return true
  }

  private emitSettledHomingStatus(): void {
    if (this.lastStatus && this.lastStatus.state === 'home') {
      this.lastStatus = { ...this.lastStatus, state: 'idle' }
      this.events.onStatus?.(this.lastStatus)
    }
  }

  // ---- authority ----

  feedHold(): void {
    if (!this.transport) return
    this.fireAndForget('feedHold', {})
  }

  cycleResume(): boolean {
    if (!this.motionAllowed()) return false
    this.fireAndForget('cycleResume', {})
    return true
  }

  reset(): void {
    this.activeHoming = null
    if (!this.transport) return
    this.fireAndForget('reset', {})
  }

  unlock(): boolean {
    if (this.phase !== 'connected') return false
    this.fireAndForget('unlock', {})
    return true
  }

  emergencyStop(): void {
    this.activeHoming = null
    if (!this.transport) return
    // Never gated by readOnly or connection niceties beyond "can we still
    // reach the bridge at all" - stopping is the one call that must never be
    // refused locally.
    this.fireAndForget('emergencyStop', {})
  }

  resetToIdle(): Promise<{ ok: boolean; reason: string | null }> {
    this.activeHoming = null
    if (this.resetToIdlePromise) return this.resetToIdlePromise
    const pending = this.performResetToIdle()
    this.resetToIdlePromise = pending
    this.emitResetToIdleState()
    void pending.finally(() => {
      if (this.resetToIdlePromise === pending) {
        this.resetToIdlePromise = null
        this.emitResetToIdleState()
      }
    })
    return pending
  }

  private async performResetToIdle(): Promise<{ ok: boolean; reason: string | null }> {
    if (this.phase !== 'connected') {
      return { ok: false, reason: 'The controller is not connected.' }
    }
    try {
      return await this.call<{ ok: boolean; reason: string | null }>('resetToIdle', {})
    } catch (err) {
      return { ok: false, reason: err instanceof Error ? err.message : String(err) }
    }
  }

  private emitResetToIdleState(): void {
    for (const listener of this.resetToIdleListeners) listener()
  }

  setOverride(change: OverrideChange): void {
    if (!this.transport) return
    // The hello declaration is authoritative. In particular, this prevents
    // the legacy "rapid" call from changing UC100's distinct JRO channel when
    // the bridge has honestly declared that rapid override does not exist.
    if (this.overrideSupport?.[change.kind] === false) {
      this.events.onConsole?.({
        dir: 'tx',
        text: `<setOverride: bridge declared ${change.kind} override unsupported - ignoring>`,
        severity: 'info',
      })
      return
    }
    this.fireAndForget('setOverride', { change })
  }

  // ---- setup ----

  /**
   * WO-915: change a pin, apply, jog, watch which axis moves, fix it - with no
   * bridge restart. The premise was measured on the real AXBB-E on 2026-08-23:
   * a settings write takes on a live, already-open board.
   *
   * The definition goes over the wire EXACTLY as the app holds it, pins and
   * all. A pin is `(port, pin)` - the connector location off a wiring diagram
   * - and the bridge derives whatever numbering the controller wants, from the
   * single copy of that table it owns. Nothing here translates, looks up or
   * does arithmetic on a pin number, and WO-912's guard test fails the build
   * if that ever changes.
   *
   * Answers rather than throws: a PARTIAL apply is the case that matters, and
   * `{ok: false}` with the bridge's own lines is more use to an operator than
   * an exception. `homedThisSession` is dropped whenever the bridge says an
   * axis must be re-homed, and whenever the apply did not fully land - what
   * the position counter MEANS may have changed underneath it.
   *
   * NOT DEMONSTRATED (Q3): whether the controller USES a pin changed live, or
   * only stores it until the next open. The bridge's readback proves storage,
   * not use, and nothing here or in any UI text may say otherwise.
   */
  async applyMachineDefinition(
    definition: ControllerDefinition,
    provenance?: MachineDefinitionProvenance,
  ): Promise<ApplyDefinitionResult> {
    if (this.phase !== 'connected') {
      return UccncController.applyRefusal('Not connected to the machine bridge.')
    }
    if (this.readOnly) {
      return UccncController.applyRefusal(
        `The machine definition was not applied: ${UccncController.READ_ONLY_APPLY_REASON}`,
      )
    }
    let reply: BridgeApplyDefinitionReply
    try {
      const args: BridgeApplyMachineDefinitionArgs = provenance === undefined
        ? { definition }
        : { definition, provenance }
      reply = await this.call<BridgeApplyDefinitionReply>(
        'applyMachineDefinition',
        args,
        APPLY_DEFINITION_TIMEOUT_MS,
      )
    } catch (err) {
      // A timeout or a dropped link mid-apply leaves the controller in a state
      // this end cannot describe, so it claims nothing about it.
      this.dropAllHomed()
      return UccncController.applyRefusal(
        err instanceof Error ? err.message : String(err),
        false,
      )
    }
    const result: ApplyDefinitionResult = {
      ok: reply?.ok === true,
      error: reply?.error ?? null,
      reHome: Array.isArray(reply?.reHome) ? reply.reHome : [],
      configuredThisSession: reply?.configuredThisSession === true,
      lines: Array.isArray(reply?.lines) ? reply.lines : [],
    }
    if (!result.ok || result.reHome.length > 0) this.dropAllHomed()
    return result
  }

  /** Read one bridge-advertised .pro without touching the live controller.
   * Confirm performs this same call again and compares `fileHash`. */
  previewProfile(path: string): Promise<BridgePreviewProfileReply> {
    return this.call<BridgePreviewProfileReply>('previewProfile', { path })
  }

  /** WO-1053: replace the bridge's live VFD document. The bridge receipt is
   * shape/value checked before it becomes the decoder's definition; the value
   * sent is never treated as its own readback. */
  async applyVfdDefinition(
    definition: MachineSpindleLinkDefinition,
    options: ApplyVfdDefinitionOptions = {},
  ): Promise<ApplyVfdDefinitionResult> {
    if (this.phase !== 'connected') {
      return { ok: false, error: 'Not connected to the machine bridge.', definition: null }
    }
    if (this.readOnly) {
      return this.refuseVfdApply(UccncController.READ_ONLY_APPLY_REASON)
    }
    // WO-2011: the stopped-spindle gate exists for a link that could report
    // the spindle turning. When this bridge session holds NO link - hello
    // declared none, the bridge refused the last definition and closed the
    // port it opened for it, or it confirmed the link removed - nothing is
    // pushing spindle state and no command can reach the inverter through a
    // link that does not exist, so waiting for "stopped" could never end
    // (09-25: only Disconnect -> edit -> Connect got out). The apply is the
    // retry: the bridge's own no-link branch opens the port from the new
    // definition, reads the inverter, and keeps the link only if it reports
    // stopped. A held link, up or down, keeps the gate below unchanged.
    const noLinkHeld = !this.vfdSpindleCommands
    const mayCreateMissingLink = noLinkHeld
      || (options.connectTimeSync === true && this.helloVfd?.present === false)
    if (this.vfdTurning === true) {
      return this.refuseVfdApply(
        'The spindle is running. Stop it before changing the spindle link definition.',
      )
    }
    const spindleTurning = this.vfdTurning
      ?? (mayCreateMissingLink ? null : await this.waitForVfdTurning(CALL_TIMEOUT_MS))
    if (!mayCreateMissingLink && spindleTurning !== false) {
      return this.refuseVfdApply(spindleTurning === true
        ? 'The spindle is running. Stop it before changing the spindle link definition.'
        : 'The app has not confirmed the spindle is stopped. Wait for spindle status before changing the spindle link definition.')
    }

    let reply: { definition?: unknown; error?: string | null }
    try {
      reply = await this.call('applyVfdDefinition', { definition })
    } catch (err) {
      return this.refuseVfdApply(err instanceof Error ? err.message : String(err))
    }
    const readback = readDeclaredVfdDefinition(reply?.definition)
    if (readback.definition === null) {
      return {
        ok: false,
        error: reply?.error ?? readback.refusal
          ?? 'The machine bridge did not return the spindle definition it now holds.',
        definition: null,
      }
    }
    const compiled = compileVfdDefinition(readback.definition)
    if (!compiled.ok) {
      return this.refuseVfdApply(
        'The machine bridge returned a spindle definition this build cannot compile.',
      )
    }
    this.vfdDefinition = compiled.definition
    this.vfdCompiledScales = compiled.compiled
    this.vfdSpindleCommands = true
    // The accepted receipt is the configuration boundary. Reachability is
    // deliberately unknown until the replacement link publishes its own vfd
    // frame; readings from the definition it replaced cannot be decoded under
    // this document or keep an old quiet-link deadline alive. The stopped fact
    // that admitted this apply remains valid: applying a definition sends no
    // spindle command, and dropping that fact would deadlock the next edit
    // until an unrelated poll happens to arrive.
    const confirmedStopped = this.vfdTurning === false
    this.resetVfdLiveObservation(true, true, confirmedStopped ? false : null)
    return {
      ok: true,
      error: null,
      definition: readback.definition,
    }
  }

  /** The bridge has confirmed that its VFD link is closed. Retire the decoded
   * document and observations with that link; the selected drive remains owned
   * by the live machine definition callback and may already be board/manual. */
  confirmVfdLinkRemoved(): void {
    this.vfdSpindleCommands = false
    this.vfdDefinition = null
    this.vfdCompiledScales = null
    this.resetVfdLiveObservation(false, true)
    // Preserve the existing link-switched-off stop rule. This is intentionally
    // after the state change, and spindleOff itself remains ungated.
    this.evaluateVfdQuietStop()
  }

  /** WO-1006: HAND THE BRIDGE THE MEASURED GANTRY SQUARING OFFSET.
   *
   * THIS MOVES NOTHING AND CANNOT. It stores one signed millimetre value on
   * the bridge; the ONLY thing that ever consumes it is the bridge's homing
   * cycle, which applies it once, after the cycle, to the slaved axis. Operator,
   * 2026-08-26: "it is a one time offset after homing and then you slave the
   * drives together in sync from then on assuming it is moving square." So
   * `homeAxes` keeps its wire signature, `JogPanel` is untouched, and nothing
   * downstream of homing in this application knows the feature exists.
   *
   * IT COPIES THE `applyVfdDefinition` SEAM DELIBERATELY - a LienCAM-owned
   * document pushed to the bridge and held there - because that seam already
   * exists and a second shape for the same idea is how two of them drift.
   *
   * NOT GATED ON `readOnly`, unlike the VFD apply: that one writes axis enable
   * outputs, and this one writes a number into a variable. The move it can
   * later produce lives inside `homeAxes`, which a read-only build refuses
   * whole - so the gate is already on the only path that can move a machine.
   *
   * `null` CLEARS the measurement. It does not store a zero.
   */
  async applySkew(offsetMm: number | null): Promise<ApplySkewResult> {
    if (this.phase !== 'connected') {
      return { ok: false, error: 'Not connected to the machine bridge.', set: false, offsetMm: null }
    }
    if (offsetMm !== null && !Number.isFinite(offsetMm)) {
      return {
        ok: false,
        error: 'A gantry skew offset must be a number of millimetres.',
        set: false,
        offsetMm: null,
      }
    }
    let reply: { set?: unknown; offsetMm?: unknown } | null
    try {
      reply = await this.call('applySkew', { offsetMm })
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
        set: false,
        offsetMm: null,
      }
    }
    // THE RECEIPT IS THE READBACK, AND IT IS CHECKED AGAINST WHAT WAS SENT.
    // The bridge builds it from the value it now holds, not from the frame
    // that arrived, so a receipt that disagrees means the push did not take.
    const set = reply?.set === true
    const held = typeof reply?.offsetMm === 'number' && Number.isFinite(reply.offsetMm)
      ? reply.offsetMm
      : null
    if (set !== (offsetMm !== null) || (set && held !== offsetMm)) {
      return {
        ok: false,
        error: 'The machine bridge did not confirm the gantry skew it now holds.',
        set,
        offsetMm: held,
      }
    }
    return { ok: true, error: null, set, offsetMm: set ? held : null }
  }

  private static readonly READ_ONLY_APPLY_REASON =
    'this bridge build is read only, so it will not write settings to the controller'

  /** A refusal this end produced, in the same shape the bridge answers with -
   *  so a caller reads one type whichever end refused. */
  /** WO-2011: a spindle-link edit this controller turns away is said in the
   * Control console, not only returned to a caller whose console the operator
   * may not be looking at (COHESION-STANDARD 13.2). A bridge refusal needs no
   * line here: the bridge writes its own reason to the same console. */
  private refuseVfdApply(error: string): ApplyVfdDefinitionResult {
    this.events.onConsole?.({
      dir: 'rx',
      text: `Spindle link not changed - ${error}`,
      severity: 'warn',
    })
    return { ok: false, error, definition: null }
  }

  private static applyRefusal(error: string, configured = false): ApplyDefinitionResult {
    return { ok: false, error, reHome: [], configuredThisSession: configured, lines: [] }
  }

  selectWcs(wcs: WcsId): boolean {
    if (this.phase !== 'connected') return false
    this.fireAndForget('selectWcs', { wcs })
    return true
  }

  /** The bridge replies only after Machine.SelectWcs has replaced activeWcs.
   * A geometry-program load uses this receipt instead of racing the following
   * loadMoves frame behind the former fire-and-forget selection. */
  selectWcsAwait(wcs: WcsId): Promise<boolean> | null {
    if (this.phase !== 'connected' || !this.transport) return null
    return this.call<boolean>('selectWcs', { wcs }).then((confirmed) => confirmed === true)
  }

  zeroWorkAxis(axis: ControlAxis): boolean {
    return this.zeroWorkAxisAwait(axis) !== null
  }

  /** WO-1083 gave this reply the same receipt shape `setWorkOffset` has:
   *  `{ok, reason, wcs, axis, offset:{x,y,z}}`. A bridge older than that
   *  answers a bare `true`, which means "applied, but I cannot say what the
   *  offset became" - the receipt then carries no `offset` and the session
   *  stores nothing for it, rather than inventing a number from a status
   *  frame (WO-1042). Both shapes are accepted; neither is guessed at. */
  zeroWorkAxisAwait(axis: ControlAxis): Promise<ZeroWorkAxisReceipt> | null {
    if (this.phase !== 'connected') return null
    const transport = this.transport
    if (!transport) return null
    const generation = this.transportGeneration
    return this.call<unknown>('zeroWorkAxis', { axis }).then(
      (value) => {
        const receipt = readZeroWorkAxisReceipt(value)
        if (receipt.wcs && receipt.offset && this.transportIsCurrent(transport, generation)) {
          this.reportWorkOffset(receipt.wcs, receipt.offset)
        }
        return receipt
      },
      (err) => {
        if (this.transportIsCurrent(transport, generation)) this.reportCallFailure('zeroWorkAxis', err)
        return { confirmed: false }
      },
    )
  }

  /** WO-1041. A `call`, not fire-and-forget: the caller has to know whether
     *  the offset took, and `zeroWorkAxis`'s fire-and-forget shape cannot say.
     *
     *  NOT gated on `motionAllowed()` - this moves nothing and must work in
     *  exactly the states `zeroWorkAxis` does, which is `phase === 'connected'`
     *  and nothing more. Gating it behind the motion latch would make an
     *  offset unrestorable in precisely the situation where restoring one
     *  matters: after an E-STOP, before anything has been re-homed. */
    setWorkOffset(wcs: WcsId, offset: Partial<MachinePosition>): Promise<SetWorkOffsetResult> {
    if (this.phase !== 'connected') {
      return Promise.resolve({
        ok: false,
        reason: 'the machine is not connected.',
        offset: null,
      })
    }
    const args: Record<string, unknown> = { wcs }
    // Send only the axes the caller gave. An absent axis leaves that offset
    // alone at the bridge, so sending a substituted 0 would silently move a
    // zero the caller never mentioned.
    for (const axis of AXIS_NAMES) {
      const key = axis.toLowerCase() as Lowercase<ControlAxis>
      if (offset[key] !== undefined) args[key] = offset[key]
    }

    const transport = this.transport
    const generation = this.transportGeneration
    return this.call<SetWorkOffsetResult>('setWorkOffset', args).then(
      (receipt) => {
        if (
          receipt.ok
          && isFiniteMachinePosition(receipt.offset)
          && transport !== null
          && this.transportIsCurrent(transport, generation)
        ) {
          this.reportWorkOffset(wcs, receipt.offset)
        }
        return receipt
      },
      () => ({
        ok: false,
        reason: 'the bridge did not answer the setWorkOffset call.',
        offset: null,
      }),
    )
  }

  /** WO-2187: every work system's rotation as this bridge last reported it.
   *  The status frame's `workRotation` is the ACTIVE system's and does not
   *  name the system, so it is not keyed here - hello and the receipts are. */
  wcsRotations(): WcsRotations | null {
    return this.phase === 'connected' ? this.reportedRotations : null
  }

  /** WO-2187: `setWorkRotation {wcs, degrees}` (WO-2186) - the bridge rotates
   *  that system about its origin and applies it to everything it runs there.
   *  No motion, so - like setWorkOffset - not behind the motion latch. The
   *  receipt's `rotation` is what the bridge now holds. */
  setWcsRotation(wcs: string, degrees: number): Promise<SetWcsRotationResult> {
    const refused = (reason: string): SetWcsRotationResult =>
      ({ ok: false, reason, rotationDeg: null, offset: null, outcome: 'refused' })
    const transport = this.transport
    if (this.phase !== 'connected' || !transport) return Promise.resolve(refused('the machine is not connected.'))
    if (!Number.isFinite(degrees)) {
      return Promise.resolve(refused(`A rotation of ${String(degrees)} is not a number of degrees.`))
    }
    const generation = this.transportGeneration
    return this.call<unknown>('setWorkRotation', { wcs, degrees }).then(
      (value): SetWcsRotationResult => {
        const v = typeof value === 'object' && value !== null ? value as Record<string, unknown> : {}
        const rotation = typeof v.rotation === 'number' && Number.isFinite(v.rotation) ? v.rotation : null
        if (v.ok !== true) {
          return refused(typeof v.reason === 'string' ? v.reason : 'the bridge did not set the work rotation.')
        }
        const name = typeof v.wcs === 'string' ? v.wcs : wcs
        if (rotation !== null && this.transportIsCurrent(transport, generation)) {
          this.reportedRotations = { ...(this.reportedRotations ?? {}), [name]: rotation }
        }
        return { ok: true, reason: null, rotationDeg: rotation, offset: null, outcome: 'accepted' }
      },
      (err: unknown): SetWcsRotationResult => ({
        ok: false,
        reason: err instanceof Error ? err.message : 'the bridge did not answer the setWorkRotation call.',
        rotationDeg: null,
        offset: null,
        outcome: 'unknown',
      }),
    )
  }

  /**
   * WO-1266: an offset receipt IS the bridge reporting an offset. The echo in
   * a `setWorkOffset` / `zeroWorkAxis` reply is the whole WCS row as the
   * bridge holds it after the write, read on the thread that applied it - the
   * same statement `hello.workOffsets` makes at connect and the grbl `$#` row
   * makes on every refresh. Until this order it reached only the durable
   * store, so the Main tab's work-offsets table (which renders the SESSION
   * table - what the controller reported) kept the hello-time value after an
   * operator's zero: on 2026-09-07 it showed G54 Z 12.160 as active while the
   * bridge and the DRO held 66.570, 54 mm apart on the axis that hits the
   * spoilboard. This bridge has no offsets push frame and `refreshState` does
   * not re-read offsets, so the receipt is the only readback there is.
   * Raised through the same `onOffset` event every backend uses, so the
   * session records it exactly as it records a `$#` row.
   */
  private reportWorkOffset(wcs: WcsId, offset: MachinePosition): void {
    this.events.onOffset?.({ label: wcs, values: machinePositionValues(offset) })
  }

  /** WO-1546: a reply `{ok:false, at:null}` is a probe that RAN and found no
   *  contact, and carries no reason. A rejected call carries a `reason`, so the
   *  session never reports it as a miss. WO-2020 preserves Machine.cs's own
   *  after-contact sentence; only failures before a touch get the command's
   *  refusal wrapper. */
  probe(axis: JogAxis, targetMm: number, feedMmMin: number): Promise<ProbeTouch> {
    const command = `probe ${axis} to machine ${targetMm} at ${feedMmMin} mm/min`
    if (!this.motionAllowed()) {
      return Promise.resolve({
        ok: false,
        at: null,
        reason: `${command} was not sent: ${this.readOnly ? 'this bridge connection is read-only' : 'not connected to the machine'}.`,
      })
    }
    return this.call<ProbeTouch | null>('probe', { axis, targetMm, feedMmMin }, PROBE_CALL_TIMEOUT_MS).then(
      (touch) => {
        const at = touch?.at ?? null
        return { ok: touch?.ok === true && at !== null, at }
      },
      (error: unknown) => ({
        ok: false,
        at: null,
        reason: probeCallFailureReason(command, error),
      }),
    )
  }

  // ---- commands ----

  sendCommand(text: string): boolean {
    if (this.phase !== 'connected') return false
    if (!this._capabilities.gcodeText) {
      this.reportCallFailure(
        'sendCommand',
        `${UccncController.TEXT_REFUSAL} Refused text: ${text}`,
      )
      return false
    }
    this.fireAndForget('sendCommand', { text })
    return true
  }

  sendCommandAwait(text: string): Promise<{ ok: boolean; message: string | null }> | null {
    if (this.phase !== 'connected') return null
    if (!this._capabilities.gcodeText) {
      this.reportCallFailure(
        'sendCommandAwait',
        `${UccncController.TEXT_REFUSAL} Refused text: ${text}`,
      )
      return Promise.resolve({ ok: false, message: UccncController.TEXT_REFUSAL })
    }
    return this.call<{ ok: boolean; message: string | null }>('sendCommandAwait', { text }).catch(
      (err) => ({ ok: false, message: err instanceof Error ? err.message : String(err) }),
    )
  }

  // ---- program ----

  /** capabilities.gcodeText is false (the AXBB-E has no interpreter), so both
   *  text entry points refuse. Contract v3 gives the refusal a channel of its
   *  own - `{ok: false, reason}` - so it no longer has to be smuggled out as a
   *  console line beside an empty load. */
  private static readonly TEXT_REFUSAL =
    'This controller takes geometry, not G-code text - nothing was loaded.'

  loadJob(_programText: string): LoadOutcome {
    return { ok: false, reason: UccncController.TEXT_REFUSAL }
  }

  loadJobFrom(_programText: string, _startLine: number, _prelude: string[]): LoadOutcome {
    return { ok: false, reason: UccncController.TEXT_REFUSAL }
  }

  loadMoves(moves: QueuedMove[]): { ok: boolean; reason: string | null } {
    if (this.phase !== 'connected') {
      return { ok: false, reason: 'Not connected to the machine bridge.' }
    }
    if (!this._capabilities.geometryQueue) {
      return { ok: false, reason: 'This controller reported no geometry-queue capability.' }
    }
    const before = this.captureLoadBookkeeping()
    this.jobTotal = moves.length
    this.jobStartedFlag = false
    this.jobMotionSeen = false
    this.jobLastMoveId = moves.length > 0 ? moves[moves.length - 1].id : null
    this.streamedMoveOrdinals = this.indexStreamedMoves(moves)
    // WO-1023: a new program is a new id space - the previous run's last
    // completed id says nothing about this one, and neither does the id that
    // was executing when it ended.
    this.resetProgressCursors()
    this.sendStagedLoad({ moves }, before)
    return { ok: true, reason: null }
  }

  /** Load the motion-only MachineProgram slice through the bridge's existing
   * staged move path. The dedicated hello key is the permission boundary:
   * geometryQueue is advertised by old bridges that ignore `frame`, so it
   * must never authorize this call. */
  loadProgram(program: MachineProgram): { ok: boolean; reason: string | null } {
    if (!this._capabilities.machineProgram) {
      return {
        ok: false,
        reason: 'This bridge does not understand geometry programs; update the bridge.',
      }
    }
    const moves = program.steps.filter(isQueuedMove)
    if (moves.length !== program.steps.length) {
      return { ok: false, reason: 'This program contains action steps; action steps are not wired yet.' }
    }
    const validation = validateMachineProgram(program)
    if (!validation.ok) return { ok: false, reason: validation.reason }

    // WO-1081: program length is not board occupancy. The bridge meters this
    // single program through its 2048-move CurrentID credit window; retaining a
    // backend length refusal here would bypass that streamer for direct callers.

    const before = this.captureLoadBookkeeping()
    this.jobTotal = program.steps.length
    this.jobStartedFlag = false
    this.jobMotionSeen = false
    this.jobLastMoveId = moves.length > 0 ? moves[moves.length - 1].id : null
    this.streamedMoveOrdinals = this.indexStreamedMoves(moves)
    this.resetProgressCursors()
    this.sendStagedLoad({ moves, frame: program.frame }, before)
    return { ok: true, reason: null }
  }

  /**
   * WO-1874: WHAT THE BOARD SAID ABOUT THE LOAD THIS CONTROLLER LAST SENT.
   *
   * `Machine.LoadMoves` can REFUSE, and the bridge answers a protocol success
   * whose VALUE carries `{ok:false, reason}` (Bridge.cs, case "loadMoves"). The
   * refusal leaves `staged` untouched by design, so the board goes on holding
   * the PREVIOUS program. Until this order the reply was thrown away by
   * `fireAndForget` and the synchronous `{ok:true}` above - which only ever
   * meant "accepted for sending" - was read as "the new program is on the
   * board". The session armed the new program's cuts and parts, and Cycle Start
   * then ran the OLD one (WO-1835 Finding 1, motion hazard).
   *
   * THIS PROMISE ANSWERS EXACTLY ONE QUESTION: did the board refuse? It
   * resolves `{ok:false, reason}` only when the bridge said so in its own
   * words. A link failure, a timeout or a bridge too old to answer the question
   * resolves `{ok:true}` - NOT a claim that the load succeeded, but the honest
   * statement that nothing was said about what the board holds, which is where
   * this app stood before this order. Those cases still reach the operator as
   * the same console line `fireAndForget` wrote.
   *
   * `null` when no load has been sent on the current link.
   */
  stagedLoadVerdict(): Promise<{ ok: boolean; reason: string | null }> | null {
    return this.pendingStagedLoad
  }

  /** Everything a load writes before the frame goes out, so a refused load can
   *  put the PREVIOUS program's progress bookkeeping back - the board is still
   *  holding that program, and it is still the one reporting on it. */
  private captureLoadBookkeeping(): StagedLoadBookkeeping {
    return {
      jobTotal: this.jobTotal,
      jobStartedFlag: this.jobStartedFlag,
      jobMotionSeen: this.jobMotionSeen,
      jobLastMoveId: this.jobLastMoveId,
      streamedMoveOrdinals: this.streamedMoveOrdinals,
      lastCompletedMoveId: this.lastCompletedMoveId,
      lastExecutingIdInJob: this.lastExecutingIdInJob,
      pufferWrapsRemaining: this.pufferWrapsRemaining,
      lastPufferMoves: this.lastPufferMoves,
      queuedMovesForProgress: this.queuedMovesForProgress,
      streamedAckedMoves: this.streamedAckedMoves,
    }
  }

  private restoreLoadBookkeeping(before: StagedLoadBookkeeping): void {
    this.jobTotal = before.jobTotal
    this.jobStartedFlag = before.jobStartedFlag
    this.jobMotionSeen = before.jobMotionSeen
    this.jobLastMoveId = before.jobLastMoveId
    this.streamedMoveOrdinals = before.streamedMoveOrdinals
    this.lastCompletedMoveId = before.lastCompletedMoveId
    this.lastExecutingIdInJob = before.lastExecutingIdInJob
    this.pufferWrapsRemaining = before.pufferWrapsRemaining
    this.lastPufferMoves = before.lastPufferMoves
    this.queuedMovesForProgress = before.queuedMovesForProgress
    this.streamedAckedMoves = before.streamedAckedMoves
  }

  /**
   * Put the staging frame on the wire and KEEP the board's answer.
   *
   * The frame itself, its arguments and the console line a failed call writes
   * are byte for byte what `fireAndForget('loadMoves', ...)` sent and wrote.
   * The one difference is that the reply is read instead of discarded.
   *
   * WO-1897: every staged move reaches the transport here. A machine-absolute
   * (G53/G28/G30) line is handed over as a copy that SERIALISES to its machine
   * target, declared machine-absolute (`machineMoveForSend` ->
   * `machineMoveWireForm`, applied by the transport's `JSON.stringify`); every
   * other move goes out as it is. Both loads (`loadMoves`, `loadProgram`) come
   * through here.
   */
  private sendStagedLoad(
    args: { moves: readonly QueuedMove[] } & Record<string, unknown>,
    before: StagedLoadBookkeeping,
  ): void {
    const transport = this.transport
    if (!transport) {
      this.pendingStagedLoad = null
      return
    }
    const generation = this.transportGeneration
    const sequence = ++this.stagedLoadSequence
    const wireArgs = { ...args, moves: args.moves.map(machineMoveForSend) }
    this.pendingStagedLoad = this.call<unknown>('loadMoves', wireArgs).then(
      (value) => {
        const refusal = readLoadMovesRefusal(value)
        if (refusal === null) return { ok: true, reason: null }
        if (this.transportIsCurrent(transport, generation) && this.stagedLoadSequence === sequence) {
          this.restoreLoadBookkeeping(before)
          this.reportCallFailure('loadMoves', refusal)
        }
        return { ok: false, reason: refusal }
      },
      (err) => {
        if (this.transportIsCurrent(transport, generation)) this.reportCallFailure('loadMoves', err)
        return { ok: true, reason: null }
      },
    )
  }

  /**
   * WO-1023: progress BY ID - the shape this backend has always had, finally
   * with somewhere to put it. `jobProgress()` above still stuffs the executing
   * id into `StreamerProgress.ackedSourceLine`; that stays (the Program panel,
   * the transport bar, `machineSession`'s WCS follower and the store all read
   * that field on every backend), and this is the honest channel beside it.
   *
   * Every field is what the bridge SAID, or null. `queuedOnController` is the
   * board's own buffer occupancy and is null when the bridge does not report
   * one - never 0, which would claim an empty buffer.
   */
  programProgress(): ProgramProgress {
    // 0 is the bridge's connect sentinel (Machine.cs:426) and this contract's
    // reserved id (`RESERVED_PROGRAM_ID`) - it means "nothing started", which
    // `ProgramProgress.executingId` spells `null`. Passing the 0 through would
    // hand a caller a step id no program is allowed to mint.
    const executing = this.lastStatus?.executingMoveId ?? null
    return {
      executingId: executing === RESERVED_PROGRAM_ID ? null : executing,
      lastCompletedId: this.lastCompletedMoveId,
      total: this.jobTotal,
      queuedOnController: this.lastStatus?.buffer?.moves ?? null,
    }
  }

  startJob(): boolean {
    if (!this.motionAllowed()) return false
    const before = { active: this.jobActiveFlag, started: this.jobStartedFlag, motion: this.jobMotionSeen }
    this.jobActiveFlag = true
    this.jobStartedFlag = true
    this.jobMotionSeen = false
    // WO-1023: a job boundary. Nothing has executed OR completed in THIS job
    // yet, whatever the last status frame still says (it may name a move from
    // the job before).
    this.resetProgressCursors()
    // WO-2137: A START THE BRIDGE TURNED AWAY NEVER STARTED. The flags above
    // are set on "accepted for sending"; a started job is confirmed by the
    // bridge's `started` job event, sent BEFORE its ok (Bridge.cs "startJob").
    // An error REPLY is the bridge saying no - a probe or tool measure owns
    // the machine, a stop is still settling - and it sends no job event, so
    // nothing else would ever clear these. Left set, hasActiveJob() said "a
    // program is running" on an idle machine and locked out probing and MDI
    // until Stop/Reset (rehearsal 2026-09-28, bite 1). So an explicit refusal
    // puts them back as they were, unless a later start, step, stop or job
    // event has already written them. A call that timed out or lost its link
    // is NOT a refusal - the job may be running - and changes nothing here.
    const transport = this.transport
    if (!transport) return true
    const generation = this.transportGeneration
    const attempt = ++this.jobStartAttempt
    void this.call('startJob', {}).catch((err) => {
      if (!this.transportIsCurrent(transport, generation)) return
      this.reportCallFailure('startJob', err)
      if (!(err instanceof BridgeReplyError) || this.jobStartAttempt !== attempt) return
      this.jobActiveFlag = before.active
      this.jobStartedFlag = before.started
      this.jobMotionSeen = before.motion
      // Nothing ran in a job that never started; frames seen meanwhile were
      // the probe's, not this job's.
      this.resetProgressCursors()
    })
    return true
  }

  pauseJob(): void {
    if (!this.transport) return
    this.fireAndForget('pauseJob', {})
  }

  resumeJob(): boolean {
    if (!this.motionAllowed()) return false
    this.fireAndForget('resumeJob', {})
    return true
  }

  stopJob(): void {
    // A Stop ends a homing cycle too; the header must not keep saying Homing.
    this.activeHoming = null
    if (!this.transport) return
    this.jobStartAttempt += 1
    this.jobActiveFlag = false
    this.jobStartedFlag = false
    this.jobMotionSeen = false
    // A stopped job is gone, not "loaded and ready": GRBL's stop resets its
    // streamer to empty and this must read the same way, or a re-arm would
    // start from a queue the controller no longer holds.
    this.jobTotal = 0
    // WO-1023: the move in flight when a stop arrives did NOT complete, and
    // the job it belonged to is gone - so both cursors go back to "nothing has
    // finished, nothing was in flight" for whatever runs next.
    this.resetProgressCursors()
    this.fireAndForget('stopJob', {})
  }

  stepJob(): boolean {
    if (!this.motionAllowed()) return false
    // Single Block runs its FIRST block through stepJob, not startJob.
    this.jobStartAttempt += 1
    this.jobStartedFlag = true
    this.jobMotionSeen = false
    this.fireAndForget('stepJob', {})
    return true
  }

  setSingleBlockMode(on: boolean): void {
    this.singleBlockFlag = on
    if (!this.transport) return
    this.fireAndForget('setSingleBlockMode', { on })
  }

  singleBlockMode(): boolean {
    return this.singleBlockFlag
  }

  hasActiveJob(): boolean {
    return this.jobActiveFlag
  }

  /**
   * Contract v2's StreamerProgress is a TEXT streamer's shape; this backend
   * tracks progress by executing move id, not by line or byte count. So:
   *  - the executing move id stands in for the source line, because that id
   *    is ours and is exact, which is the whole point of the geometry path.
   *    It is an ID, not an ordinal, so long streamed jobs look it up in the
   *    loaded whole-program ordering instead of doing arithmetic on its value;
   *  - loadMoves hands the WHOLE queue over in one call, so every move is
   *    "sent" the moment it is loaded. Ring-sized jobs retain their Puffer
   *    occupancy progress; streamed jobs count completed original moves;
   *  - bytesInFlight is 0, as the contract documents for a controller with a
   *    real move buffer rather than a byte budget.
   * Flagged in the WO-422 report: the contract has no id-shaped progress.
   */
  jobProgress(): StreamerProgress {
    // Before this job has started or stepped, nothing of it has executed: an
    // empty board buffer then is "nothing pushed yet", and the executing id in
    // the last frame belongs to the job before (board 2026-09-14: 6 of 6 moves
    // read as done and id 126 lingered, so Single Block had no block to run).
    if (!this.jobStartedFlag && this.jobTotal > 0) {
      return {
        phase: this.jobActiveFlag ? 'streaming' : 'ready',
        totalLines: this.jobTotal,
        sentLines: this.jobTotal,
        ackedLines: 0,
        ackedSourceLine: 0,
        sentSourceLine: 0,
        bytesInFlight: 0,
      }
    }
    const executing = this.lastStatus?.executingMoveId ?? 0
    // The negative control is literal: through the 4096 boundary, retain the
    // old expression even between load and the first status for the new job.
    const streamed = this.usesStreamedProgress()
    const queued = streamed
      ? null
      : this.jobTotal <= PUFFER_MODULUS
        ? (this.lastStatus?.buffer?.moves ?? null)
        : this.queuedMovesForProgress
    // The last move has run and the board is at rest: the job is done, even if
    // the buffer still reports a move (Single Block held after its last block).
    const lastMoveDone = this.jobLastMoveId !== null
      && this.jobMotionSeen
      && executing === this.jobLastMoveId
      && (this.lastStatus?.state === 'idle' || this.lastStatus?.state === 'hold')
    const ackedLines = lastMoveDone
      ? this.jobTotal
      : streamed
        ? this.streamedAckedMoves
        : queued === null ? 0 : Math.max(0, this.jobTotal - queued)
    return {
      phase: this.jobTotal === 0 ? 'empty' : this.jobActiveFlag ? 'streaming' : 'ready',
      totalLines: this.jobTotal,
      sentLines: this.jobTotal,
      ackedLines,
      ackedSourceLine: executing,
      sentSourceLine: executing,
      bytesInFlight: 0,
    }
  }

  stoppedJobProgress(): StreamerProgress | null {
    // Not tracked: this backend has no text-streamer boundary to snapshot at.
    return null
  }

  // ---- internals ----

  private motionAllowed(): boolean {
    return this.phase === 'connected' && !this.readOnly
  }

  private setPhase(phase: ConnectionPhase, detail: string | null): void {
    this.phase = phase
    this.events.onConnectionPhase?.(phase, detail)
  }

  private nextSeq(): number {
    this.seq += 1
    return this.seq
  }

  private call<T = unknown>(
    method: string,
    args: Record<string, unknown>,
    timeoutMs: number = CALL_TIMEOUT_MS,
  ): Promise<T> {
    const transport = this.transport
    if (!transport) return Promise.reject(new Error('Not connected to the machine bridge.'))
    const seq = this.nextSeq()
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        reject(new Error(`The machine bridge did not answer "${method}" in time.`))
      }, timeoutMs)
      this.pending.set(seq, {
        resolve: (v) => resolve(v as T),
        reject,
        timer,
      })
      transport.send({ t: 'call', seq, m: method, a: args })
    })
  }

  /**
   * A HOMING call: bounded by liveness, and by a ceiling. See
   * `HOMING_LIVENESS_MS` / `HOMING_CEILING_PER_AXIS_MS` for why there are two
   * numbers and what each one actually promises.
   *
   * `axisCount` is how many axes the cycle covers, so the ceiling reflects the
   * work asked for rather than being one flat number. Clamped to at least one
   * axis: a bridge that accepts an empty or orderless cycle still gets a
   * bounded wait, never an unbounded one.
   */
  private callLongHoming<T = unknown>(
    method: string,
    args: Record<string, unknown>,
    axisCount: number,
  ): Promise<T> {
    const transport = this.transport
    if (!transport) return Promise.reject(new Error('Not connected to the machine bridge.'))
    const seq = this.nextSeq()
    const ceilingMs = Math.max(1, axisCount) * HOMING_CEILING_PER_AXIS_MS
    return new Promise<T>((resolve, reject) => {
      const finish = (message: string) => {
        const entry = this.pending.get(seq)
        if (!entry) return
        this.pending.delete(seq)
        clearTimeout(entry.timer)
        if (entry.ceilingTimer !== undefined) clearTimeout(entry.ceilingTimer)
        reject(new Error(message))
      }
      const ceilingMessage = `"${method}" ran past its ${Math.round(ceilingMs / 1000)} s budget and the call `
        + 'was abandoned. The machine may still be homing - watch it, and use the E-STOP if it is wrong.'
      const entry: PendingCall = {
        resolve: (v) => resolve(v as T),
        reject,
        timer: setTimeout(
          () => finish(`The machine bridge went silent during "${method}" and the call was abandoned. `
            + 'The machine may still be moving - use the E-STOP if it is.'),
          HOMING_LIVENESS_MS,
        ),
        ceilingTimer: setTimeout(() => finish(ceilingMessage), ceilingMs),
        // WO-938: the wall-clock backstop for the line above - see the field
        // comment on `ceilingDeadline`.
        ceilingDeadline: Date.now() + ceilingMs,
        expireCeiling: () => finish(ceilingMessage),
        keepAlive: () => {
          const live = this.pending.get(seq)
          if (!live) return
          clearTimeout(live.timer)
          live.timer = setTimeout(
            () => finish(`The machine bridge went silent during "${method}" and the call was abandoned. `
              + 'The machine may still be moving - use the E-STOP if it is.'),
            HOMING_LIVENESS_MS,
          )
        },
      }
      this.pending.set(seq, entry)
      transport.send({ t: 'call', seq, m: method, a: args })
    })
  }

  /**
   * Any frame from the bridge proves the link is alive, so it re-arms the
   * liveness window of every long call in flight. It does NOT touch an
   * ordinary fixed-budget call, and it does NOT touch a ceiling's SIZE -
   * bridge chatter must never be able to extend a homing cycle without
   * limit.
   *
   * WO-938: this is also where the ceiling's wall-clock deadline gets
   * checked, because this is already the one place every inbound frame
   * passes through. `ceilingTimer` alone is not enough to trust a homing
   * cycle to - see `ceilingDeadline`'s comment on `PendingCall`. A call
   * snapshot (`[...this.pending.values()]`) is taken first: `expireCeiling`
   * deletes its own entry from `this.pending` mid-loop, which is safe for a
   * live Map iterator but not worth relying on when a SECOND long call could
   * be expiring in the same pass.
   */
  private noteBridgeLiveness(): void {
    const now = Date.now()
    for (const pending of [...this.pending.values()]) {
      if (pending.ceilingDeadline !== undefined && now >= pending.ceilingDeadline) {
        pending.expireCeiling?.()
        continue
      }
      pending.keepAlive?.()
    }
  }

  /** Send a call and let its eventual failure surface on the console instead
   *  of blocking the synchronous boolean/void return every caller expects
   *  (matching the "as today" GRBL methods this interface was transcribed
   *  from - a `true`/void return means "accepted for sending", not
   *  "succeeded"). */
  private fireAndForget(method: string, args: Record<string, unknown>): void {
    const transport = this.transport
    if (!transport) return
    const generation = this.transportGeneration
    void this.call(method, args).catch((err) => {
      if (this.transportIsCurrent(transport, generation)) this.reportCallFailure(method, err)
    })
  }

  private reportCallFailure(method: string, err: unknown): void {
    const text = err instanceof Error ? err.message : String(err)
    this.events.onConsole?.({ dir: 'rx', text: `${method}: ${text}`, severity: 'error' })
  }

  private waitForHello(timeoutMs: number): Promise<BridgeHelloValue | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.helloWaiters = this.helloWaiters.filter((w) => w !== waiter)
        resolve(null)
      }, timeoutMs)
      const waiter = (hello: BridgeHelloValue | null) => {
        clearTimeout(timer)
        resolve(hello)
      }
      this.helloWaiters.push(waiter)
    })
  }

  private waitForVfdTurning(timeoutMs: number): Promise<boolean | null> {
    if (this.vfdTurning !== null) return Promise.resolve(this.vfdTurning)
    return new Promise((resolve) => {
      const settle = (turning: boolean | null) => {
        clearTimeout(timer)
        this.vfdTurningWaiters.delete(settle)
        resolve(turning)
      }
      const timer = setTimeout(() => settle(null), timeoutMs)
      this.vfdTurningWaiters.add(settle)
    })
  }

  private transportIsCurrent(transport: UccncTransport, generation: number): boolean {
    return this.transport === transport && this.transportGeneration === generation
  }

  private deliverConsole(entry: ConsoleEntry, transport: UccncTransport, generation: number): void {
    if (!this.transportIsCurrent(transport, generation)) return
    const id = entry.firmwareUpdateId
    if (typeof id !== 'string' || id.length === 0) {
      this.events.onConsole?.(entry)
      return
    }
    this.events.onConsole?.({ ...entry, onAccepted: () => {
      // A callback may outlive its socket. Never acknowledge on its successor.
      if (!this.transportIsCurrent(transport, generation)) return
      try { transport.send({ t: 'firmwareUpdateAck', id }) } catch {
        // Printed but the receipt was lost: replay is deduplicated by the console.
      }
    } })
  }

  private handleMessage(
    message: BridgeMessage,
    transport: UccncTransport,
    generation: number,
  ): void {
    if (!this.transportIsCurrent(transport, generation)) return
    // WO-930: any inbound frame is proof the link is alive, and that is what
    // keeps a long homing call from being abandoned mid-cycle. Done first, so
    // it happens whatever the frame is and whatever the handler below does.
    this.noteBridgeLiveness()
    switch (message.t) {
      case 'hello': {
        this.adoptVfdDefinition(message.v)
        // WO-2187: every hello restates the rotations - at connect and after a
        // board reopen alike - so a saved rotation shows on its first frame.
        this.reportedRotations = readHelloRotations(message.v)
        if (this.phase === 'connecting') this.connectingHello = message.v
        const waiters = this.helloWaiters
        this.helloWaiters = []
        for (const w of waiters) w(message.v)
        break
      }
      case 'reply':
        this.handleReply(message.seq, message.ok, message.v, message.error)
        break
      case 'status': {
        // Pass MachineStatus straight through - nulls and all. No field here
        // may be coalesced to a fabricated number. WO-441/442: spindleRpm and
        // spindle are the exceptions - both are recomputed from whatever this
        // controller has decoded from the `vfd` push (real units), never from
        // the bridge's own `status` frame, which carries neither (Bridge.cs
        // was not touched by either WO), so the DRO and the spindle panel
        // never read a register word wearing a real unit's name.
        //
        // WO-922: this straight-through is what carries the new per-axis
        // `inputs.home` / `limitMinus` / `limitPlus` maps as well - a `null`
        // in one of them means "no input is wired for this axis" and must
        // never be coalesced to `false` ("wired, currently open") on the way
        // past. `applyVfd` below spreads the status, so it preserves them
        // untouched; nothing else on this path inspects `inputs`. Teardown
        // drops `lastStatus`, so `status()` falls back to UNKNOWN_STATUS
        // (`inputs: null`) and no stale reading survives a disconnect.
        const status = this.applyVfd(this.applyOverrideSupport(message.v))
        if (this.jobStartedFlag && status.state === 'run') this.jobMotionSeen = true
        // WO-1125: status is the continuously reported authority. Adopt it
        // before any gate or observer can read the frame, so a pessimistic
        // drop or a missed push edge is corrected on this same frame.
        this.adoptReportedHomed(status.homed)
        // WO-1023: the ONLY completion this end can observe - see
        // `lastCompletedMoveId`. Read before `lastStatus` is replaced, because
        // it is the previous frame's executing id that just finished.
        this.noteMoveHandover(this.lastExecutingIdInJob, status.executingMoveId ?? null)
        // Recording the witness for the NEXT frame - not a boundary clear
        // (`resetProgressCursors` owns those). Only a frame seen INSIDE a
        // running job may witness a hand-over, so outside one nothing is
        // recorded and the next job's first status has no predecessor to
        // falsely complete.
        this.lastExecutingIdInJob = this.jobActiveFlag ? (status.executingMoveId ?? null) : null
        if (this.usesStreamedProgress()) this.noteStreamedProgress(status.executingMoveId ?? null)
        else this.notePufferMoves(status.buffer?.moves ?? null)
        const driveFault = (status as MachineStatus & {
          driveFault?: { latched?: unknown; description?: unknown }
        }).driveFault
        if (status.state === 'alarm' || status.inputs?.estop === true || driveFault?.latched === true) {
          this.activeHoming = null
        } else if (this.activeHoming && status.state === 'idle') {
          status.state = 'home'
        }
        this.lastStatus = status
        this.events.onStatus?.(status)
        if (driveFault?.latched === true && !this.driveFaultAlarmRaised) {
          this.driveFaultAlarmRaised = true
          this.invalidateDatum(null)
          const description = typeof driveFault.description === 'string'
            ? driveFault.description
            : 'Closed-loop driver fault'
          this.events.onAlarm?.(
            null,
            `${DRIVE_FAULT_ALARM_PREFIX} ${description}. Motion was stopped and the machine datum is no longer trustworthy. After the physical fault clears, press Stop/Reset, jog clear if needed, then re-home before running a program.`,
            true,
          )
        } else if (driveFault?.latched !== true) {
          this.driveFaultAlarmRaised = false
        }
        break
      }
      case 'console':
        if (this.phase === 'connecting') this.connectingConsole.push(message.v)
        else this.deliverConsole(message.v, transport, generation)
        break
      case 'phase':
        this.firmwareVersionValue = message.v.version
        this.events.onConnectionPhase?.(message.v.phase, message.v.version)
        break
      // ---- contract v3 pushes (WO-423) ----
      case 'jobEvent':
        // A job the bridge says is over is over here too, so hasActiveJob()
        // cannot keep claiming a run that stopped at the controller.
        // WO-1023: a job boundary the BRIDGE declares is a job boundary here
        // too - the progress of the job on one side of it is not the progress
        // of the job on the other, in EITHER cursor. 'paused' and 'resumed'
        // are NOT boundaries: the same job is still running, so they leave
        // both cursors, and the hand-over chain, intact.
        // WO-2137: whatever the bridge says about the job now outranks a
        // start's later refusal.
        this.jobStartAttempt += 1
        if (message.v.event === 'started') {
          this.jobActiveFlag = true
          this.jobStartedFlag = true
          this.resetProgressCursors()
        } else if (
          message.v.event === 'stopped' ||
          message.v.event === 'completed' ||
          message.v.event === 'failed'
        ) {
          this.jobActiveFlag = false
          if (message.v.event === 'completed' && this.usesStreamedProgress()) {
            this.streamedAckedMoves = this.jobTotal
          }
          // Keep the last reconstructed occupancy available at the terminal
          // edge. The next load/start resets it before accepting a new frame.
          this.resetProgressCursors(false)
        }
        this.events.onJobEvent?.(message.v.event, message.v.fault)
        break
      case 'homed':
        // WO-930: the push NAMES its axes, and now that is what is recorded.
        // This is also the reconciliation path for a cycle that outran the
        // app-side ceiling: the call was abandoned, the machine finished, and
        // the truth still lands here.
        this.recordHomed(message.v.axes)
        this.events.onHomed?.(message.v.axes)
        break
      case 'alarm':
        this.activeHoming = null
        if (message.v.positionLost) this.invalidateDatum(null)
        this.events.onAlarm?.(message.v.code, message.v.message, message.v.positionLost)
        break
      case 'vfd':
        this.handleVfdPush(message.v)
        break
      default:
        // Every BridgeMessage variant is matched above, so `message` is
        // `never` here on the happy path - a shape this build's type does
        // not know (an unrecognised push from a newer/older bridge) is
        // dropped, same as a malformed frame already is in BridgeTransport.
        break
    }
  }

  /**
   * WO-441: hello names the active definition; this looks it up among what
   * LienCAM ships (`VFD_DEFINITIONS`, currently Operator's Huanyang GT alone) and
   * compiles its scale expressions once, so every `vfd` push after this is a
   * lookup, not a parse. No match (unknown name, or no link configured) leaves
   * decoding off - `status.spindleRpm` then passes through from the bridge
   * exactly as before, which preserves today's behaviour when nothing here
   * recognises what is connected.
   *
   * WO-1053 closes WO-967's deliberate two-authority gap. A checked document
   * stated by hello is now the decoder's seed, and an accepted apply reply
   * replaces it. The shipped catalogue remains only the compatibility fallback
   * for an older bridge that names a definition but cannot state the document.
   */
  private adoptVfdDefinition(helloValue: BridgeHelloValue): void {
    const configured = helloValue.vfd?.present === true
    // Set this in the hello handler, not only after connect() resumes, so a VFD
    // push queued directly behind hello observes the right session boundary.
    this.vfdSpindleCommands = configured
    this.vfdDefinition = null
    this.vfdCompiledScales = null
    this.resetVfdLiveObservation(configured, true)
    const vfd = helloValue.vfd
    if (!vfd?.present || !vfd.name) return
    const declared = readDeclaredVfdDefinition(vfd.definition).definition
    const seed = declared ?? VFD_DEFINITIONS.find((d) => d.name === vfd.name)
    if (!seed) return
    const compiled = compileVfdDefinition(seed)
    if (!compiled.ok) return
    this.vfdDefinition = compiled.definition
    this.vfdCompiledScales = compiled.compiled
  }

  /** WO-441: decode one `vfd` push into real units, then push the result into
   *  the status the UI already watches rather than waiting for the next
   *  `status` frame (up to 500 ms away while idle). */
  private handleVfdPush(v: BridgeVfdValue): void {
    this.noteVfdLinkState(v)
    // Turning state is an independent live fact, not decoded telemetry. It is
    // classified by the document this controller confirmed for this link:
    // hello seeds it, and an apply receipt replaces it. A missing/uncompiled
    // document cannot prove stopped and deliberately yields null.
    const turning = vfdSpindleTurning(v, this.vfdDefinition)
    this.vfdTurning = turning
    const turningWaiters = [...this.vfdTurningWaiters]
    this.vfdTurningWaiters.clear()
    for (const waiter of turningWaiters) waiter(turning)
    if (!this.vfdDefinition || !this.vfdCompiledScales) return
    this.vfdLastReadings = vfdDecodePush(this.vfdDefinition, this.vfdCompiledScales, {
      up: v.up,
      faulted: v.faulted,
      statusWords: v.statusWords,
    })
    this.vfdLinkUp = v.up === true
    this.vfdHasSample = true
    if (!this.lastStatus) return // nothing to patch onto yet; the next `status` push applies it
    const status = this.applyVfd(this.lastStatus)
    if (status === this.lastStatus) return
    this.lastStatus = status
    this.events.onStatus?.(status)
  }

  /** Build the safety input from the bridge's VFD frame. `running` is
   * deliberately absent: it records the bridge's desired state, not physical
   * turning, and a failed stop can already have cleared it. The elapsed value
   * is recalculated by `currentVfdSafetyState` when the worker deadline fires.
   */
  private noteVfdLinkState(v: BridgeVfdValue): void {
    const now = Date.now()
    if (v.up) {
      this.vfdLastSuccessAtMs = now
      this.vfdQuietStopIssued = false
    }
    this.vfdSafetyState = {
      // Configured/enabled follows the live session: hello seeds it, an
      // accepted definition apply turns it on, and confirmed removal turns it
      // off. `v.up` below remains the separate reachability fact.
      enabled: this.vfdSpindleCommands,
      connected: v.up,
      timeSinceLastSuccessMs: this.vfdLastSuccessAtMs === null
        ? null
        : Math.max(0, now - this.vfdLastSuccessAtMs),
      bridgeConnected: this.phase === 'connected' && this.transport !== null,
      clientConnected: this.phase === 'connected',
      faulted: v.faulted,
    }
    // A VFD push is meaningful only for a bridge session that declared the
    // separate Modbus link. Never let a malformed/stale frame create this
    // rule for an ordinary UCCNC session (or, by extension, GRBL).
    if (!this.vfdSafetyState.enabled) {
      this.stopVfdQuietWatch()
      return
    }
    if (this.vfdSafetyState.enabled && v.up) this.startVfdQuietWatch()
    this.evaluateVfdQuietStop()
  }

  /** Clear observations that belong to an old definition/link without
   * changing the definition itself. `configured` and reachability are
   * separate: a newly accepted definition is enabled but not yet sampled.
   * `turning` may preserve a same-session confirmed stop across an apply;
   * hello, removal, and teardown still reset it to unknown. */
  private resetVfdLiveObservation(
    configured: boolean,
    sessionConnected: boolean,
    turning: boolean | null = null,
  ): void {
    this.stopVfdQuietWatch()
    this.vfdLastReadings = {}
    this.vfdTurning = turning
    this.vfdHasSample = false
    this.vfdLinkUp = null
    this.vfdLastSuccessAtMs = null
    this.vfdQuietStopIssued = false
    this.vfdSafetyState = {
      ...VFD_LINK_STATE_DOWN,
      enabled: configured,
      bridgeConnected: sessionConnected,
      clientConnected: sessionConnected,
    }
  }

  private currentVfdSafetyState(): VfdLinkState {
    const now = Date.now()
    return {
      ...this.vfdSafetyState,
      timeSinceLastSuccessMs: this.vfdLastSuccessAtMs === null
        ? null
        : Math.max(0, now - this.vfdLastSuccessAtMs),
      bridgeConnected: this.phase === 'connected' && this.transport !== null,
      clientConnected: this.phase === 'connected',
    }
  }

  /** The timer has no separate stop rule: the pure vfdSafety decision is the
   * only TypeScript authority. Once it requests a stop, one fire-and-forget
   * bridge call is enough; a later successful frame can arm a fresh deadline. */
  private evaluateVfdQuietStop(): void {
    const state = this.currentVfdSafetyState()
    const decision = vfdStopRequired(state)
    if (!decision.stop) {
      if (!state.enabled) this.stopVfdQuietWatch()
      return
    }
    if (!spindleSafetyStopIsActionable(this.commandedRpm !== null)) return
    this.stopVfdQuietWatch()
    if (this.vfdQuietStopIssued) return
    this.vfdQuietStopIssued = true
    this.events.onConsole?.({ dir: 'rx', text: `Spindle safety: ${decision.sentence}`, severity: 'error' })
    this.spindleOff()
  }

  /** Arm just after the strict `>` boundary used by Vfd.cs. Every successful
   * VFD poll restarts it, so irregular poll cadence cannot accumulate a count
   * or move the fixed wall-clock threshold. */
  private startVfdQuietWatch(): void {
    if (this.vfdLastSuccessAtMs === null) return
    this.vfdQuietStopTimer.start(VFD_LINK_QUIET_STOP_MS + 1, () => this.evaluateVfdQuietStop())
  }

  private stopVfdQuietWatch(): void {
    this.vfdQuietStopTimer.stop()
  }

  /**
   * WO-442: the `spindle` block for `MachineStatus`. `null` while no
   * definition is active - same "does not apply to this connection" meaning
   * as `MachineStatus.overrides.rapid` on a controller with no rapid
   * override. Once a definition IS active this always returns an object -
   * never null-collapses the whole thing just because one field, or every
   * field, is presently unreported - with each field independently null per
   * the same rule one level down. `upToSpeed` is always null: it needs the
   * commanded RPM, and this controller has no `spindleOn` call yet to source
   * one from automatically (see `vfdUpToSpeed`'s own note above).
   */
  private buildSpindleStatus(): MachineStatus['spindle'] {
    if (!this.vfdDefinition) return null
    const r = this.vfdLastReadings
    return {
      volts: r.volts ?? null,
      amps: r.amps ?? null,
      torque: r.torque ?? null,
      power: r.power ?? null,
      // WO-905: no longer unconditionally null. Up-to-speed is a comparison
      // between what the inverter reports and what it was ASKED for, and the
      // second half only exists once something has commanded a speed - which
      // is exactly what `spindleOn` now supplies. Still null before any
      // command, after a stop, and whenever the inverter is not reporting an
      // actual RPM: absence stated, never a substituted boolean.
      upToSpeed: this.commandedRpm === null ? null : this.vfdUpToSpeed(this.commandedRpm),
      // The bridge has always sent this and this controller always threw it
      // away, so nothing downstream could tell a running spindle from a
      // stopped one and the UI latched whatever it had last commanded.
      // Measured at the machine 2026-08-22: the bridge's own watchdog stopped
      // the spindle and the CW button stayed lit through it.
      running: this.vfdTurning,
      linkUp: this.vfdLinkUp,
    }
  }

  /** Preserve old-bridge omission as unknown, and let an explicit hello
   * declaration win over a contradictory numeric status value. Supported
   * channels still come only from the controller's live status read. */
  private applyOverrideSupport(status: MachineStatus): MachineStatus {
    if (status.overrides === undefined) return { ...status, overrides: null }
    if (status.overrides === null || this.overrideSupport === null) return status
    const overrides = {
      ...status.overrides,
      feed: this.overrideSupport.feed ? status.overrides.feed : null,
      rapid: this.overrideSupport.rapid ? status.overrides.rapid : null,
      spindle: this.overrideSupport.spindle ? status.overrides.spindle : null,
    }
    return { ...status, overrides }
  }

  /**
   * WO-441/442: fold the decoded actual RPM into `spindleRpm`, and the
   * decoded telemetry block into `spindle`. A no-op (same object back) when
   * there is no active definition at all - so a bridge with no VFD link, or
   * an unrecognised `hello.vfd.name`, keeps behaving exactly as before
   * WO-441: `spindleRpm` passes through whatever the bridge sent, and
   * `spindle` is left exactly as the bridge sent it too (today, that is
   * never - the wire type declares it but Bridge.cs does not populate it -
   * so it stays absent, same as any other field this WO does not touch;
   * `uccncController.wo421.test.ts`'s "passes MachineStatus straight
   * through, preserving nulls exactly" is what pins this down).
   *
   * Once a definition IS active, both fields are recomputed on every status:
   * `spindleRpm` from the last decoded `actualRpm` (null until the first
   * `vfd` push, then null again the moment the link drops or faults -
   * never a stale reading), and `spindle` from `buildSpindleStatus` above,
   * which is always an object once a definition matched, never null-collapsed
   * just because nothing has been decoded yet.
   */
  private applyVfd(status: MachineStatus): MachineStatus {
    if (!this.vfdDefinition) return status
    const spindle = this.buildSpindleStatus()
    const decodedRpm = this.vfdHasSample ? (this.vfdLastReadings.actualRpm ?? null) : status.spindleRpm
    if (status.spindleRpm === decodedRpm && status.spindle === spindle) return status
    return { ...status, spindleRpm: decodedRpm, spindle }
  }

  private handleReply(seq: number, ok: boolean, v: unknown, error?: string): void {
    const pending = this.pending.get(seq)
    if (!pending) return // stale or unmatched - nothing waits on it
    this.pending.delete(seq)
    clearTimeout(pending.timer)
    if (pending.ceilingTimer !== undefined) clearTimeout(pending.ceilingTimer)
    if (ok) pending.resolve(v)
    else pending.reject(new BridgeReplyError(error ?? 'The machine bridge reported a failure.'))
  }

  private handleClose(
    reason: string | null,
    transport: UccncTransport,
    generation: number,
  ): void {
    if (!this.transportIsCurrent(transport, generation)) return
    if (this.phase === 'disconnected') return
    this.teardown(reason ?? 'connection closed')
  }

  /** Prove to the bridge that this client is alive - see BRIDGE_KEEPALIVE_MS. */
  private startKeepAlive(): void {
    this.stopKeepAlive()
    this.keepAliveTimer.start(BRIDGE_KEEPALIVE_MS, () => {
      if (this.phase !== 'connected' || !this.transport) {
        this.stopKeepAlive()
        return
      }
      this.queryStatus()
    })
  }

  /**
   * WO-1023 attempt 2: THE ONLY PLACE ANY PROGRESS CURSOR IS CLEARED.
   *
   * Three audit rounds found three separate holes in one thing, and every one
   * of them had the same shape: a job boundary cleared ONE of the two cursors
   * and left the other holding a fact from the job before. `startJob` cleared
   * the hand-over witness but kept the previous run's completed id; a
   * bridge-declared `completed` -> `started` cleared the witness and kept the
   * completed id, so the new job's first `programProgress()` reported the old
   * job's last completed move. Patching each boundary as it was found just
   * moved the hole to the next boundary.
   *
   * So the cursors are not cleared individually anywhere. This method sets
   * BOTH to their empty state, and every job boundary calls it:
   * `loadMoves`, `startJob`, `stopJob`, `teardown`, and a bridge `jobEvent` of
   * `started` / `stopped` / `completed` / `failed`. `paused` and `resumed` are
   * deliberately NOT boundaries - the same job runs on across them, so the
   * hand-over chain must survive or a resumed job would forget what finished
   * before the pause.
   *
   * A future progress cursor belongs in HERE, not in a new line at one
   * boundary - that is the whole point of the method. `jobTotal` is not one of
   * these: it is the size of the LOADED queue, not a statement about what has
   * run, and it has its own lifecycle (`loadMoves` sets it, `stopJob` zeroes
   * it, a bridge job event leaves the loaded queue alone).
   */
  private resetProgressCursors(resetPuffer = true): void {
    this.lastCompletedMoveId = null
    this.lastExecutingIdInJob = null
    if (resetPuffer) {
      this.pufferWrapsRemaining = !this.usesStreamedProgress()
        ? Math.floor(Math.max(0, this.jobTotal - 1) / PUFFER_MODULUS)
        : 0
      this.lastPufferMoves = null
      this.queuedMovesForProgress = null
      this.streamedAckedMoves = 0
    }
  }

  private indexStreamedMoves(moves: readonly QueuedMove[]): ReadonlyMap<number, number> {
    if (!this.usesStreamedProgress()) return new Map()
    return new Map(moves.map((move, ordinal) => [move.id, ordinal]))
  }

  private usesStreamedProgress(): boolean {
    // The bridge's declared ring capacity is the single threshold for both
    // sides: above it Machine.cs engages its credit window and this controller
    // switches away from occupancy-based progress. Do not compare against the
    // Puffer modulus here; 4096 moves already exceeds the 4095-entry safe ring.
    return this.jobTotal > resolveMaxProgramMoves(this._capabilities)
      && this._capabilities.pacedMoveStreaming === true
  }

  /** Count only moves that must have finished before the currently executing
   * original move. Status polls may skip ids, so the mapped whole-program
   * ordinal is the acknowledgement; Puffer refills are deliberately ignored. */
  private noteStreamedProgress(executingId: number | null): void {
    if (!this.jobActiveFlag || executingId === null || executingId === RESERVED_PROGRAM_ID) return
    const ordinal = this.streamedMoveOrdinals.get(executingId)
    if (ordinal !== undefined) this.streamedAckedMoves = Math.max(this.streamedAckedMoves, ordinal)
  }

  /** Reconstruct a decreasing occupancy from the board's 12-bit remainder.
   * A remainder jumping up means the true value crossed one 4096 boundary. */
  private notePufferMoves(reported: number | null): void {
    if (reported === null) {
      this.queuedMovesForProgress = null
      return
    }

    if (this.jobTotal <= PUFFER_MODULUS || reported >= PUFFER_MODULUS) {
      this.pufferWrapsRemaining = 0
      this.lastPufferMoves = reported
      this.queuedMovesForProgress = reported
      return
    }

    // A zero before the first loaded-buffer sample is the previous empty
    // queue, not evidence that 4096 moves have already run. Leave it
    // provisional so the first nonzero remainder still reconstructs the full
    // occupancy (6284 -> 2188 in the recorded run).
    if (this.lastPufferMoves === null && reported === 0) {
      this.queuedMovesForProgress = this.jobTotal
      return
    }

    if (
      this.lastPufferMoves !== null
      && reported > this.lastPufferMoves
      && this.pufferWrapsRemaining > 0
    ) {
      this.pufferWrapsRemaining--
    }
    this.lastPufferMoves = reported
    this.queuedMovesForProgress = Math.min(
      this.jobTotal,
      reported + this.pufferWrapsRemaining * PUFFER_MODULUS,
    )
  }

  /**
   * WO-1023: record a completion, and only a real one. See
   * `lastCompletedMoveId` for why each of these conditions is a fact we lack
   * rather than a case we are being cautious about.
   */
  private noteMoveHandover(previousId: number | null, currentId: number | null): void {
    // `previousId` is `lastExecutingIdInJob`, not `lastStatus` - it is null
    // unless the frame before this one arrived inside the SAME running job.
    if (!this.jobActiveFlag) return
    if (previousId === null || previousId === 0) return
    if (currentId === null || currentId === 0) return
    if (currentId === previousId) return
    this.lastCompletedMoveId = previousId
  }

  /** Idempotent: teardown runs on paths that may never have started a timer. */
  private stopKeepAlive(): void {
    this.keepAliveTimer.stop()
  }

  private teardown(reason: string): void {
    this.stopKeepAlive()
    this.stopVfdQuietWatch()
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      if (pending.ceilingTimer !== undefined) clearTimeout(pending.ceilingTimer)
      pending.reject(new Error(reason))
    }
    this.pending.clear()
    this.helloWaiters = []
    this.connectingHello = null
    this.connectingConsole = []
    this.transport = null
    this.lastStatus = null
    // Capabilities are only ever true because the bridge, in THIS session,
    // said so. A stale copy surviving disconnect would be a lie the moment
    // the machine is reconnected to a different (or updated) bridge.
    this._capabilities = NO_CAPABILITIES
    this.overrideSupport = null
    this.vfdSpindleCommands = false
    this.boardSpindleCommands = false
    this.readOnly = false
    this.helloVfd = null
    this.helloUccnc = undefined
    this.helloDefinitionSource = undefined
    this.helloDefinitionDrift = undefined
    this.helloWorkOffsets = undefined
    this.reportedRotations = null
    this.activeHoming = null
    this.jobActiveFlag = false
    // WO-1023: same rule as `lastStatus` above - progress from a session that
    // has ended is not progress in the next one.
    this.resetProgressCursors()
    this.dropAllHomed()
    // WO-441: a stale definition surviving disconnect is the same lie as a
    // stale capability - the next bridge may report a different inverter, or
    // none at all.
    this.vfdDefinition = null
    this.vfdCompiledScales = null
    this.vfdLastReadings = {}
    this.vfdTurning = null
    const turningWaiters = [...this.vfdTurningWaiters]
    this.vfdTurningWaiters.clear()
    for (const waiter of turningWaiters) waiter(null)
    this.vfdHasSample = false
    this.vfdLinkUp = null
    this.vfdLastSuccessAtMs = null
    this.vfdQuietStopIssued = false
    this.vfdSafetyState = VFD_LINK_STATE_DOWN
    this.commandedRpm = null
    if (this.phase !== 'disconnected') this.setPhase('disconnected', reason)
  }
}

type BridgeHelloValue = Extract<BridgeMessage, { t: 'hello' }>['v']
type BridgeVfdValue = Extract<BridgeMessage, { t: 'vfd' }>['v']

/** WO-1637: the bridge's `setOutput` reply, `{port, pin, ucPin, level, on}`.
 *  The board's own pin number is not carried into src/ - nothing here uses
 *  one. Anything that is not that shape reads as "no readback". */
function readOutputReadback(raw: unknown): OutputReadback | null {
  if (raw === null || typeof raw !== 'object') return null
  const v = raw as Record<string, unknown>
  if (typeof v.port !== 'number' || typeof v.pin !== 'number') return null
  return {
    port: v.port,
    pin: v.pin,
    level: typeof v.level === 'boolean' ? v.level : null,
    on: typeof v.on === 'boolean' ? v.on : null,
  }
}
