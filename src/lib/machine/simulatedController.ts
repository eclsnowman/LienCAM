// SimulatedController - MachineController implemented natively, in software,
// with no protocol underneath at all (ADR-0041).
//
// simulatedTransport.ts (SimulatedGrblTransport) used to pretend to be GRBL
// over a byte pipe: it parsed '?', formatted '<...>' status reports, counted
// planner-queue characters, answered ok/error, replied to $G/$#/$$. None of
// that was simulation - it was protocol emulation, and this class drops all
// of it. What is PORTED here is the motion model underneath that protocol:
// position integration over real time, feed handling and overrides, travel
// limits, homing, and the probe trigger. WO-433 deleted simulatedTransport.ts
// and switched machineSession's connectMachine('simulator') to this class -
// it is now the only simulator LienCAM has.
//
// One simplification carried forward from simulatedTransport.ts was that an
// arc moved in a straight line to its endpoint. WO-1285 ended it: an 'arc'
// step now WALKS ITS CIRCLE (resolveMove / tick), at the same mm-per-tick the
// line integrator uses, so the per-tick travel-limit trip sees an arc's bulge
// and the pre-flight walk checks its true swept box. A simulator that agreed
// with a program it never drew was a lie exactly where bore, face and 2D
// adaptive, the arc emitters, need a pre-flight most.
//
// WO-428: this class now also carries a G-code INTERPRETER of its own -
// loadJob/loadJobFrom parse LienCAM's posted text using the PostConfig supplied
// with the controller into the same QueuedMove stream loadMoves
// takes, so both backend shapes ADR-0041 exists to distinguish (geometry-only
// AXBB-E, text-only GRBL) are honestly exercisable with nothing plugged in.
// WO-416's virtual part (bore/boss/bow probe geometry) is ported from
// simulatedTransport.ts alongside it (WO-433: the SimulatedPart/SimulatedBore/
// SimulatedBoss shapes now live in this file, below), and a program - loaded
// either way - now gets a travel-limit alarm instead of silently running off
// the declared table. See the bottom of the file for the interpreter and the
// ported virtual-part geometry.

import type {
  ConnectionPhase,
  ControlAxis,
  ControllerBackend,
  ControllerCapabilities,
  ControllerEvents,
  GrblParserState,
  JobFault,
  JogAxis,
  LoadOutcome,
  MachineController,
  MachineState,
  MachineProgram,
  MachinePosition,
  MachineStatus,
  MachineVec3,
  OverrideChange,
  ProbeTouch,
  ProgramProgress,
  QueuedMove,
  StreamerPhase,
  StreamerProgress,
  WcsId,
  ZeroWorkAxisReceipt,
} from './controller'
import type { AxisName, MachineHomeConvention, MachineSpindleLinkDefinition } from '../../types'
import {
  HOMED_GATE_AXES,
  resolveHomingOrder,
  validateMachineProgram,
} from './controller'
import { arcSweep, arcSweptBounds } from '../program/buildMachineProgram'
import {
  deriveMachineEnvelopeFromConvention,
  ENVELOPE_FIT_TOLERANCE_MM,
  resolveAxisHomePosition,
  type MachineEnvelope,
} from './machineEnvelope'
import type { ResolvedMachineMotion } from './resolvedMachineMotion'
import { prepareProgram, stripGcodeComments } from '../gcode/text'
import type { StreamLine } from '../gcode/text'
import type { VfdDefinition } from './vfd/vfdDefinition'
import { vfdIsUpToSpeed } from './vfd/vfdRuntime'
import type { PostConfig } from '../post/types'
import type { ToolpathMove } from '../../types'
import { plannedMoveDurationsMs, type CutTimeMotion } from '../cam/runtime'
import { UCCNC_CONFIG } from '../post/dialects/uccnc'
import {
  parseSimulatedProgramLines, prepareSimulatedProgram, simulatorParseIdentity,
  simulatorSpindleDirectionRefusal, simulatorSpindleRpm, simulatorTableRefusal,
  tokenizeWords, withoutNestedComments,
  type SimulatorParseInput, type PreparedSimulatedProgram,
  type TextWord, type LineEffect, type StartRelativeAxes,
} from './simulatedProgramPreparation'
import {
  gcodeMacroRefusal,
  gcodeOutputWords,
  gcodeTableDialectOf,
  gcodeWordTable,
  gcodeWordTableForMachine,
  gcodeWordTableWithOutputs,
  isGcodeMacroMCode,
  type GcodeMacroSource,
  type GcodeOutputSource,
  type GcodeOutputWord,
  type GcodeWordTable,
} from '../gcode/wordTable'

// ---- WO-433: the virtual-part shape, ported here from simulatedTransport.ts
// (deleted by this WO) so it has a home that outlives the retired transport.
// Byte-for-byte the same fields SimulatedGrblTransport declared.

// WO-416: a round hole through the block top, known diameter, some depth.
// The factory bore-centre routine finds its wall from inside.
export interface SimulatedBore {
  cx: number
  cy: number
  diameter: number
  depth: number
}

// WO-416: a round boss standing proud of the block top. The factory
// boss-centre routine finds its wall from outside.
export interface SimulatedBoss {
  cx: number
  cy: number
  diameter: number
  height: number
}

/**
 * WO-416: a virtual part the simulator's G38.2 can actually contact - a
 * rectangular block (machine-frame position, size) with a top surface that
 * is NOT flat (a gentle bow toward the edges plus a little noise, both
 * deterministic per XY so a repeat probe at the same point agrees), a round
 * bore and a round boss so the factory bore/boss routines find real walls.
 * `origin` is the block's MIN X/Y corner in machine mm; `topZ` is the
 * nominal (unbowed) top surface at the block's centre.
 */
export interface SimulatedPart {
  origin: { x: number; y: number }
  sizeX: number
  sizeY: number
  topZ: number
  height: number
  /** mm the top dips at the block's edge relative to its centre. Default 0.3. */
  bowMm?: number
  /** mm of deterministic per-XY surface noise (repeat-probe-safe). Default 0.02. */
  noiseMm?: number
  bore?: SimulatedBore | null
  boss?: SimulatedBoss | null
}

/**
 * WO-2692: the machine's fixed tool setter - a round button `diameter` across,
 * centred on the definition's stated setter X/Y, its top at `topZ`. Modelled
 * as the pad is: a surface met from above, and only that. The stated Z is
 * where a measure starts (UCCNC FixedProbePos), above the real button, so a
 * solid column under it would stop moves the real machine makes freely. A real
 * setter is there whatever part is clamped beside it, so it is met alongside
 * the part (or the pad), never instead of it.
 */
export interface SimulatedToolSetter {
  x: number
  y: number
  topZ: number
  diameter: number
}

/** WO-2692: the simulated setter button's diameter. Setters run roughly 10 to
 *  30 mm across; 20 mm is the middle of that, so a measure on the stated X/Y
 *  touches with room for a little positioning error and a touch 10 mm or more
 *  off it misses, as it would on the machine. */
export const SIMULATED_TOOL_SETTER_DIAMETER_MM = 20

export interface SimulatedControllerOptions {
  /** WO-1756: the dialect the SESSION MACHINE declares - production passes the
   *  built-in PostConfig for its declared controller, so typed lines and text
   *  loaded through this door are read in the dialect the machine speaks.
   *  Direct legacy fixtures omit it and retain the simulator's historical
   *  UCCNC default. */
  dialect?: PostConfig
  /** WO-1650: the machine definition's one output list. A word it names (a
   *  pump on M10) is accepted, switched and reported exactly as the reader and
   *  the post treat it. */
  outputs?: readonly GcodeOutputSource[] | null
  /** WO-1643: the machine's stated macro M-code range (and any bound M-codes),
   *  read the same way the file door's reader reads it - a typed line inside
   *  it is reported as a macro call, never refused as unrecognised vocabulary. */
  macros?: GcodeMacroSource | null
  /** Canonical motion authority. Production always supplies this; the older
   * fields below remain only for direct controller fixtures. */
  motion?: ResolvedMachineMotion
  /** Independent axes exposed by the selected machine definition. Slave
   * motors are absent; rotary values are degrees. */
  controlAxes?: readonly ControlAxis[]
  /** Cartesian axes whose definition requires a home cycle before absolute
   * program motion. Production always supplies this from the selected machine;
   * omission preserves direct legacy fixtures that do not model a definition. */
  programHomeRequiredAxes?: readonly JogAxis[]
  /** Active machine profile's travel (mm) - the same shape SimulatedGrblTransport
   *  took, so the caller (machineSession.ts, in WO-422) does not change shape. */
  travelMm?: { x: number; y: number; z: number }
  /** Machine-profile home-switch and machine-zero choices. */
  homeConvention?: MachineHomeConvention
  /** Assigned limit inputs from the selected controller definition. The
   * simulator needs only presence here; pin numbers remain a hardware fact. */
  limitWiring?: Partial<Record<AxisName, { minus: boolean; plus: boolean }>>
  /** The selected machine's spindle limits, allowed direction and optional
   * inverter link. Production supplies this as one snapshot with the other
   * machine facts; omission preserves older direct-controller fixtures. */
  spindle?: {
    minSpindleRpm?: number
    maxSpindleRpm?: number
    spindleDirection: 'cw' | 'ccw'
    spindleLinkDefinition?: MachineSpindleLinkDefinition | null
  }
  /** WO-428/WO-416: the virtual part G38.2 probes against. null (the default)
   *  reproduces the pre-WO-416 flat-pad-only behaviour every probe test
   *  before it depends on. Same shape as SimulatedGrblOptions.part so a
   *  caller can hand the identical object to either backend. */
  part?: SimulatedPart | null
  /** WO-2692: the machine's fixed tool setter. Production passes the selected
   *  machine's stated probing.toolSetter; absent or null, there is no setter
   *  and every probe meets what it met before. */
  toolSetter?: SimulatedToolSetter | null
  /** WO-2779: the radius of the probe tip, read on every probe tick so a tool
   *  change applies to the next touch. Production passes the tool in the
   *  spindle's radius (machineSession.ts). Absent: 0, a point - the touch every
   *  probe test before WO-2779 depends on. */
  probeTipRadiusMm?: () => number
  /** WO-2024: the machine definition's accelerations and axis velocities
   *  (machineCutTimeMotion). When supplied, each program move runs at the
   *  average speed the cut-time planner gives it, so a run takes the time the
   *  op card states instead of distance / feed. Absent: commanded feed, no
   *  acceleration - the simulator's historical motion. */
  cutTimeMotion?: CutTimeMotion | null
  /** Machine-scoped retained registers for the pinned Control machine. The
   * simulator starts with these as its live controller registers; loading
   * them is not an operator zero and creates no session-zero grant. */
  workOffsets?: Partial<Record<WcsId, Partial<MachinePosition>>>
}

const TICK_MS = 50
/** WO-2024: the most real time one tick may catch up. A timer that fires late
 *  (a busy page, a throttled window) still moves the machine by the time that
 *  actually passed, so a run takes as long as its moves say; past this cap -
 *  a suspended laptop, a tab frozen for minutes - the simulator stops catching
 *  up rather than teleport through the program. */
const MAX_CATCH_UP_MS = 1000
const STATUS_MS_MOVING = 100
const STATUS_MS_IDLE = 500
const HOMING_MS = 1500
/** A full commanded spindle transition takes this long. Machine/VFD
 * definitions do not yet carry acceleration data, so this is a named
 * stand-in rather than invented machine-specific physics. */
export const SIMULATOR_SPINDLE_RAMP_MS = 500
/** Machine Z where the virtual probe pad triggers when no part is placed -
 *  the pre-WO-416 flat-pad behaviour every probe test before it depended on. */
const PROBE_PAD_Z = -40
/** The E-STOP's alarm, and the answer to a probe it abandoned. */
const SIMULATED_ESTOP_MESSAGE = 'Emergency stop. Motion was abandoned; reset before moving again.'
/** mm/min this class integrates a rapid (G0, or a bare G28's move to the
 *  reference position) at. G-code carries no feed word for a rapid; matches
 *  SimulatedGrblTransport's RAPID_RATE so both backends move rapids at the
 *  same simulated speed. */
export const SIMULATOR_DEFAULT_RAPID_MM_MIN = 4000
const WCS_IDS: WcsId[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59']

// ---- WO-428: virtual-part surface constants (ported from simulatedTransport.ts) ----
const DEFAULT_BOW_MM = 0.3
const DEFAULT_NOISE_MM = 0.02

// ---- WO-434: the MDI (single-line sendCommand) vocabulary ----------------
// Deliberately narrower than the config-derived whole-program vocabulary -
// this is only the words real
// machineSession.ts call sites actually send one line at a time: probing
// (G38.2, with G91/G21 prefixes), work-offset writes (G10 L2/L20), TLO
// (G43.1/G49), safe-Z/mesh-probe positioning (G53 G0/G53 G1), plain G0/G1,
// WCS select, the modal words those lines carry (G20/G21/G90/G91), a dwell
// (G4 - WO-433: WO-434's own "still NOT ported" list claimed no real
// call site ever sends one; materialFit.ts's buildFitTraceSequence does,
// once per traced corner, and startMaterialFitTrace streams it through
// sendCommandAwait exactly like every other trace line - discovered live by
// materialFitTrace.test.tsx once WO-433 wired the native simulator in), and
// manual spindle/coolant (M3/M4/M5/M7/M8/M9). Anything else is outside the
// vocabulary and gets an explicit refusal - never a silent ok.
const SUPPORTED_MDI_G = new Set([0, 1, 4, 10, 20, 21, 38.2, 38.3, 43.1, 49, 53, 54, 55, 56, 57, 58, 59, 90, 91])
const SUPPORTED_MDI_M = new Set([3, 4, 5, 7, 8, 9])

function isQueuedMove(step: MachineProgram['steps'][number]): step is QueuedMove {
  return step.kind === 'line' || step.kind === 'arc' || step.kind === 'dwell' || step.kind === 'marker'
}

type AxisKey = 'x' | 'y' | 'z'
type PositionAxisKey = Lowercase<ControlAxis>

function positionAxisKey(axis: ControlAxis): PositionAxisKey {
  return axis.toLowerCase() as PositionAxisKey
}


interface RunningMove {
  id: number
  kind: 'line' | 'arc' | 'dwell' | 'marker' | 'probe'
  /** G38.3 reaches its target quietly when no surface is touched. */
  probeMissAllowed?: boolean
  target: MachinePosition
  feedMmMin: number
  /** Axes explicitly named by the source block. Keep an observable boundary
   *  when that set changes so an omitted axis is settled before a later block
   *  starts moving it (WO-1791). */
  specifiedAxes?: readonly PositionAxisKey[]
  /** WO-2024: the planned average speed (mm/min) this move actually runs at,
   *  set only when the controller has the machine's accelerations. */
  paceMmMin?: number
  seconds?: number
  dwellRemainingMs?: number
  /** WO-1285: the circle an 'arc' walks. `sweep` is signed (counter-clockwise
   *  positive); `length` is the path length including any z change; `travelled`
   *  advances by mm-per-tick exactly as a line's distance does. */
  arc?: {
    from: MachineVec3
    centre: MachineVec3
    radius: number
    startAngle: number
    sweep: number
    length: number
    travelled: number
  }
  /** True for a move counted toward job progress (loadJob/loadMoves +
   *  startJob); false for an ad hoc jog, home approach or probe. */
  program: boolean
  asState: 'run' | 'jog'
}


let simulatorReceipt = 0
export class SimulatedController implements MachineController {
  private readonly preparationSession = ++simulatorReceipt

  /** Cloneable inputs of this simulator's OWN interpreter. Reading these facts
   * never stages a program. The receipt is rechecked at synchronous adoption. */
  setupLoadPreparationInput(): SimulatorParseInput {
    return structuredClone({ session: this.preparationSession, controlAxes: [...this.controlAxes],
      activeWcs: this.activeWcs, lastEnqueuedTarget: this.lastEnqueuedTarget,
      dialect: this.dialect, table: this.wordTable(), outputCodes: [...this.outputWords.keys()],
      wco: this.wco, tlo: this.tlo, homePosition: this.homePosition, rapidMmMin: this.rapidMmMin,
      refusedAxes: [...this.refusedAxes], spindle: this.spindle ?? null, rereadingStaged: this.rereadingStaged,
      parser: this.parserState(),
    })
  }

  /** WO-2277: stepRunning places each sample on its line or circle and finishes
   * at the exact endpoint before starting the next move; it never blends a
   * corner, so this is not a hardware controller's corner-cutting allowance.
   * WO-2679: 0.01 mm, the finest length the Control console states
   * (fmtMachineLength, 2 dp). The old nanometre printed "against a 0.00 mm
   * threshold" - a check the operator cannot read. A 0.03 mm threshold still
   * sits inside any real machine's own (UCCNC Linearerror 0.03 -> 0.09). */
  readonly pathToleranceMm = 0.01

  readonly capabilities: ControllerCapabilities = {
    geometryQueue: true,
    executingMoveId: true,
    bufferSeconds: false,
    // WO-428: this class now carries its own interpreter (loadJob/loadJobFrom
    // parse LienCAM's posted text - in the dialect the session machine
    // declares, WO-1756 - into the same QueuedMove
    // stream loadMoves takes), so it honestly emulates BOTH backend shapes
    // ADR-0041 exists to distinguish - true here, unlike the real AXBB-E
    // (UccncController), which has no interpreter and stays false.
    gcodeText: true,
    perAxisHoming: true,
    ownsSpindle: true,
    // WO-905: the simulator mirrors GRBL - spindle via text, not calls.
    spindleCommands: false,
    machineProgram: true,
  }

  private readonly events: ControllerEvents
  /** WO-2024: the machine's accelerations, when the caller supplies them. */
  private readonly cutTimeMotion: CutTimeMotion | null
  private readonly controlAxes: readonly ControlAxis[]
  private readonly programHomeRequiredAxes: readonly JogAxis[] | null
  private readonly envelope: MachineEnvelope
  private readonly refusedAxes: ReadonlySet<AxisKey>
  private readonly homePosition: MachinePosition
  private readonly travelMm: { x: number; y: number; z: number }
  private readonly homeConvention: MachineHomeConvention | null
  private readonly limitWiring: Record<AxisKey, { minus: boolean; plus: boolean }>
  private readonly hasLimitInputs: boolean
  private readonly rapidMmMin: number
  private readonly spindle: SimulatedControllerOptions['spindle'] | null
  private readonly dialect: PostConfig

  private pos: MachinePosition
  private lastEnqueuedTarget: MachinePosition
  private phase: ConnectionPhase = 'disconnected'
  private state: MachineState = 'unknown'
  private firmwareVersionStr: string | null = null

  private homed: Partial<Record<ControlAxis, boolean>> = {}
  /** The one specific explanation for the latest synchronous homeAxes false.
   * JogPanel reads it only after that false and writes it to the existing
   * machine console; keeping it here avoids asking the UI to duplicate the
   * simulator's connection, E-STOP and axis-validation rules. */
  private lastHomeAxesRefusal: string | null = null
  private homingRemainingMs = 0
  /** WO-914: axes still to home, IN ORDER, front first. The simulator homes
   *  them one at a time so the order is observable - see `homeAxes`. */
  private homingQueue: ControlAxis[] = []
  /** Axes already homed by the cycle in flight, in the order they finished.
   *  This is what `onHomed` reports, so a caller sees the real sequence. */
  private homingDone: ControlAxis[] = []
  private homingPerAxisMs = 0

  private wco: Record<WcsId, MachinePosition> = Object.fromEntries(
    WCS_IDS.map((id) => [id, { x: 0, y: 0, z: 0 }]),
  ) as Record<WcsId, MachinePosition>
  private readonly hasInitialWorkOffsets: boolean
  private activeWcs: WcsId = 'G54'

  private feedOvr = 100
  private rapidOvr = 100
  private spindleOvr = 100
  // WO-905: renamed from `spindleOn`, which is now a MachineController member
  // name (the bridge call and the protocol doc both use it). This is the
  // controller output command; actual shaft motion is spindleRpm below.
  private spindleRunning = false
  /** Actual simulated shaft speed, distinct from the commanded target so M3
   * and M5 can ramp without making status claim an instantaneous change. */
  private spindleRpm = 0
  private spindleTargetRpm = 0
  private spindleRampRpmPerMs = 0
  /** WO-428: M3 vs M4 - the text path is the only thing that ever sets this. */
  private spindleDir: 'cw' | 'ccw' = 'cw'
  private floodOn = false
  private mistOn = false
  /** WO-1650: the machine's listed output words, by code, and which listed
   *  outputs are on (by their on word's number). */
  private readonly outputSources: readonly GcodeOutputSource[]
  private readonly outputWords: Map<number, GcodeOutputWord[]>
  /** WO-1643: the machine's stated macro M-code range/bindings, or null when
   *  the machine states neither - see `wordTable()`. */
  private readonly macroSource: GcodeMacroSource | null
  private listedOutputsOn: number[] = []

  /** WO-428/WO-416: the virtual part this controller's probe contacts, or
   *  null for the pre-WO-416 flat-pad-only behaviour. Mutable, mirroring
   *  SimulatedGrblTransport.setSimulatedPart - a live pass-through so the
   *  Diagnostics panel can move it without reconnecting. */
  private part: SimulatedPart | null
  /** WO-2692: the machine's fixed tool setter, or null when it states none.
   *  Mutable like the part, so a rehearsal can take the setter off the table
   *  (unplugged, knocked over) and see what a measure then says. */
  private toolSetter: SimulatedToolSetter | null
  /** WO-2779: where the probe tip's radius comes from (see the option). */
  private probeTipRadiusSource: () => number

  private queue: RunningMove[] = []
  private executingMoveId: number | null = null
  private nextSyntheticId = -1
  private probeResolvers = new Map<number, (touch: ProbeTouch) => void>()
  /** WO-2800: see setNativeBoardStandIn. */
  private nativeBoardStandIn = false
  private lastProbe: ProbeTouch = { ok: false, at: null }

  // ---- WO-434: MDI (sendCommand) modal state and plumbing ----
  // Persists across sendCommand calls, unlike parseProgramLines' local scale/
  // distanceMode (which reset per loadJob) - an MDI probe cycle is several
  // separate lines (G21 G91 G38.2 ..., G91 G0 ... retract, G91 G38.2 ... fine
  // pass) that rely on units/distance-mode carrying over exactly like a real
  // controller's modal group does.
  private mdiUnitsScale = 1 // mm; 25.4 under G20
  private mdiDistanceMode: 'absolute' | 'incremental' = 'absolute'
  private mdiFeed = 0
  /** WO-2878: the last T word executed, from the program stream or a typed
   *  line - what real GRBL's $G reports as T. GRBL boots and soft-resets it
   *  to 0 (gc_init); a program end leaves it. parserState() used to hard-code
   *  0, so any refresh (a units click) replaced a finished program's T2. */
  private toolNumber = 0
  /** G43.1 dynamic tool length offset (Z), mm - ported from
   *  SimulatedGrblTransport.tlo. Written through the text door (G43.1/G49):
   *  the MDI line, and the session applying a loaded file's `G43 H<n>` from
   *  the machine's tool table (WO-1677) - a loaded program carrying G43.1
   *  itself is refused by the shared reader. Added to every absolute work Z a
   *  program stages, through either program door (WO-2037). */
  private tlo = 0
  /** Resolves a sendCommandAwait() promise for an MDI-issued G38.2, keyed by
   *  the QueuedMove id finishProbe() completes - separate from
   *  probeResolvers (which serves the native probe() contract method and
   *  resolves a ProbeTouch, not a command ack). */
  private mdiProbeAwaiters = new Map<number, (ack: { ok: boolean; message: string | null }) => void>()

  private pendingProgram: QueuedMove[] = []
  /** WO-2037: the G43.1 length baked into `pendingProgram` and the moves whose
   *  Z carries it, so Cycle Start runs under the length in force THEN - an
   *  Apply between load and start moves them, as it moves the machine's. */
  private pendingLength: { mm: number; moves: Set<QueuedMove> } | null = null
  /** WO-2679: the position a text program was read from, and for each staged
   *  move the axes whose value still descends from it - every axis no absolute
   *  word has named yet. Cycle Start moves those by where the run really
   *  starts, so Home All between Load and Cycle Start cannot leave a stale
   *  pre-home X/Y on a Z-only block. */
  private pendingStart: { from: MachinePosition; moves: Map<QueuedMove, StartRelativeAxes> } | null = null
  /** WO-2712 amendment (Operator 10-09 5:26 PM): the text a program door staged
   *  and the work zeros it was read against. A controller reads a block when
   *  it executes it, so a work offset changed between Load and Cycle Start
   *  (Offsets tab, Push) is the one the run uses: Cycle Start reads the same
   *  lines again against the zeros in force then. */
  private pendingRead: { lines: StreamLine[]; zeros: string } | null = null
  /** True while that re-read runs: its per-line console notices were already
   *  printed by the Load. */
  private rereadingStaged = false
  private programTotal = 0
  /** ACKED/completed count and the acked move's id - i.e. moves that have
   *  actually finished executing. Despite the name, `programSent` has always
   *  meant "acked" here (see jobProgress(), which now derives a genuine
   *  DISPATCHED count from this plus whatever move is currently in flight -
   *  WO-433, see that method's own comment). */
  private programSent = 0
  private programLine = 0
  private programActive = false
  private stoppedProgress: StreamerProgress | null = null
  /** See abandonProgram / flushAbandoned: a stop path defers its job event so
   *  no subscriber can run before the machine is actually stopped. */
  private pendingAbandonFault: JobFault | null = null
  /** A program abandoned by an e-stop / alarm rather than finished. Keeps
   *  `phase` honest: a run that was cut short is 'failed', never 'complete'. */
  private programFailed = false
  private singleBlock = false

  /** WO-428: per-QueuedMove-id state changes for a text-loaded program - see
   *  LineEffect. Empty for a geometry-loaded (loadMoves) program: geometry
   *  carries no M-codes, by design (ADR-0041). */
  private lineEffects = new Map<number, LineEffect>()

  private estopTripped = false
  /** A hard-limit input is latched by ordinary motion reaching a wired end.
   * Homing uses the dedicated home-input contract and releases that switch
   * when the cycle completes, even though machine position remains exactly at
   * the declared home coordinate. */
  private hardLimitTripped: { axis: AxisKey; side: 'minus' | 'plus' } | null = null
  private softLimitTripped = false
  private resetInProgressFlag = false
  private resetListeners = new Set<() => void>()

  private statusTimer: ReturnType<typeof setInterval> | null = null
  private motionTimer: ReturnType<typeof setInterval> | null = null
  /** WO-2024: when the previous motion tick ran (Date.now()). */
  private lastTickAt: number | null = null

  constructor(events: ControllerEvents, options: SimulatedControllerOptions = {}) {
    this.events = events
    this.cutTimeMotion = options.cutTimeMotion ?? null
    this.controlAxes = options.controlAxes ?? ['X', 'Y', 'Z']
    this.programHomeRequiredAxes = options.programHomeRequiredAxes ?? null
    this.dialect = options.dialect ?? UCCNC_CONFIG
    this.outputSources = options.outputs ?? []
    this.outputWords = gcodeOutputWords(gcodeTableDialectOf(this.dialect.id) ?? 'uccnc', this.outputSources)
    this.macroSource = options.macros ?? null
    this.hasInitialWorkOffsets = options.workOffsets !== undefined
    this.travelMm = {
      x: options.travelMm?.x ?? 0,
      y: options.travelMm?.y ?? 0,
      z: options.travelMm?.z ?? 0,
    }
    this.homeConvention = options.homeConvention ?? null
    this.limitWiring = Object.fromEntries((['x', 'y', 'z'] as const).map((axis) => {
      const configured = options.limitWiring?.[axis.toUpperCase() as AxisName]
      return [axis, { minus: configured?.minus === true, plus: configured?.plus === true }]
    })) as Record<AxisKey, { minus: boolean; plus: boolean }>
    this.hasLimitInputs = Object.values(this.limitWiring)
      .some((wiring) => wiring.minus || wiring.plus)
    this.spindle = options.spindle ?? null
    this.part = options.part ?? null
    this.toolSetter = options.toolSetter ?? null
    this.probeTipRadiusSource = options.probeTipRadiusMm ?? (() => 0)
    this.refusedAxes = new Set(
      (['x', 'y', 'z'] as const).filter((axis) => {
        const state = options.motion?.axes[axis].definitionState
        return state === 'disabled' || state === 'undefined'
      }),
    )
    this.envelope = options.motion?.envelope ?? (options.homeConvention
      ? deriveMachineEnvelopeFromConvention(options.homeConvention, this.travelMm)
      : { x: null, y: null, z: null })
    this.rapidMmMin = options.motion?.rapidMmMin && options.motion.rapidMmMin > 0
      ? options.motion.rapidMmMin
      : SIMULATOR_DEFAULT_RAPID_MM_MIN
    this.wco = Object.fromEntries(WCS_IDS.map((id) => {
      const offset: MachinePosition = {
        x: options.workOffsets?.[id]?.x ?? 0,
        y: options.workOffsets?.[id]?.y ?? 0,
        z: options.workOffsets?.[id]?.z ?? 0,
      }
      for (const axis of this.controlAxes) {
        const key = positionAxisKey(axis)
        if (key !== 'x' && key !== 'y' && key !== 'z') {
          offset[key] = options.workOffsets?.[id]?.[key] ?? 0
        }
      }
      return [id, offset]
    })) as Record<WcsId, MachinePosition>

    const axisHome = (axis: AxisKey): number => {
      const resolved = options.motion?.envelope[axis]
      const resolvedToward = options.motion?.axes[axis].homesToward
      if (resolved && resolvedToward) return resolvedToward === 'max' ? resolved.max : resolved.min
      const travel = options.travelMm?.[axis]
      const convention = options.homeConvention?.[axis]
      return convention && Number.isFinite(travel) && travel! > 0
        ? resolveAxisHomePosition(convention, travel!)
        : 0
    }
    this.homePosition = { x: axisHome('x'), y: axisHome('y'), z: axisHome('z') }
    for (const axis of this.controlAxes) {
      const key = positionAxisKey(axis)
      if (this.homePosition[key] === undefined) this.homePosition[key] = 0
    }

    const initialAxis = (axis: AxisKey): number => {
      const resolved = options.motion?.envelope[axis]
      const homesToward = options.motion?.axes[axis].homesToward
        ?? options.homeConvention?.[axis].homesToward
      const travel = resolved?.travelMm ?? options.travelMm?.[axis]
      if (!Number.isFinite(travel) || travel! <= 0) return -5
      const inward = Math.min(5, travel! / 2)
      if (!homesToward && resolved) {
        if (resolved.min <= 0 && resolved.max >= 0) return 0
        return Math.abs(resolved.min) <= Math.abs(resolved.max)
          ? resolved.min + inward
          : resolved.max - inward
      }
      if (!homesToward) return -5
      return this.homePosition[axis] + (homesToward === 'max' ? -inward : inward)
    }
    this.pos = { x: initialAxis('x'), y: initialAxis('y'), z: initialAxis('z') }
    for (const axis of this.controlAxes) {
      const key = positionAxisKey(axis)
      if (this.pos[key] === undefined) this.pos[key] = 0
    }
    this.lastEnqueuedTarget = { ...this.pos }
  }

  // ---- lifecycle ----

  async connect(backend: ControllerBackend): Promise<void> {
    // Contract v2: a software controller has nothing on the other side, so
    // 'none' is the only backend it can be handed. Anything else is a wiring
    // mistake and says so rather than silently connecting to nothing.
    if (backend.kind !== 'none') {
      throw new Error(
        `SimulatedController is pure software; it was handed a '${backend.kind}' backend.`,
      )
    }
    this.phase = 'connecting'
    this.events.onConnectionPhase?.('connecting', null)
    this.firmwareVersionStr = 'LienCAM Simulated Controller'
    this.lastTickAt = Date.now()
    this.motionTimer = setInterval(() => this.tick(), TICK_MS)
    this.setState('idle')
    this.phase = 'connected'
    this.events.onReady?.(this.firmwareVersionStr)
    this.events.onConnectionPhase?.('connected', this.firmwareVersionStr)
    if (this.hasInitialWorkOffsets) this.emitAllOffsetRows()
  }

  async disconnect(): Promise<void> {
    if (this.motionTimer !== null) clearInterval(this.motionTimer)
    if (this.statusTimer !== null) clearInterval(this.statusTimer)
    this.motionTimer = null
    this.statusTimer = null
    this.phase = 'disconnected'
    this.state = 'unknown'
    // WO-2800 fix round 2: nothing will ever finish a move now, so a probe
    // call or G38 line still waiting is answered.
    this.answerAbandonedProbes('The simulator was disconnected.')
    this.events.onConnectionPhase?.('disconnected', null)
    this.events.onClose?.(null)
  }

  connectionPhase(): ConnectionPhase {
    return this.phase
  }

  firmwareVersion(): string | null {
    return this.firmwareVersionStr
  }

  // ---- state ----

  machineState(): MachineState {
    return this.state
  }

  status(): MachineStatus {
    const running = this.queue[0]
    const moving = this.state === 'run' || this.state === 'jog'
    const wco = this.wco[this.activeWcs]
    const limitMinus = this.limitInputs('minus')
    const limitPlus = this.limitInputs('plus')
    const hardLimit = (['X', 'Y', 'Z'] as const)
      .some((axis) => limitMinus[axis] === true || limitPlus[axis] === true)
    return {
      state: this.state,
      subState: this.state === 'hold' ? 0 : null,
      machinePos: { ...this.pos },
      // WPos = MPos - (WCS + TLO on Z) - the same GRBL WCO contract
      // SimulatedGrblTransport.effWco() ported (WO-434: tlo is now real,
      // written by G43.1/G49 over the MDI path, not always 0).
      workPos: this.workPosition(wco),
      feedMmMin: moving ? Math.round(((running?.feedMmMin ?? 0) * this.feedOvr) / 100) : 0,
      spindleRpm: this.reportedSpindleRpm(),
      overrides: { feed: this.feedOvr, rapid: this.rapidOvr, spindle: this.spindleOvr },
      executingMoveId: this.executingMoveId,
      buffer: {
        moves: this.queue.filter((m) => m.program).length,
        capacitySeconds: null, // capabilities.bufferSeconds is false - never faked
      },
      // Contract v4: door and hold remain null because the simulator has no
      // such inputs. Limit state comes from the selected machine's wiring.
      inputs: {
        estop: this.estopTripped,
        hardLimit,
        softLimit: this.softLimitTripped,
        // WO-2517: the pin, not the last probe's result - closed while the
        // tip touches or is pushed into the part (or the pad), on any move.
        probe: this.probeTouching(this.pos),
        limits: this.hasLimitInputs ? {
          x: limitMinus.X === true || limitPlus.X === true,
          y: limitMinus.Y === true || limitPlus.Y === true,
          z: limitMinus.Z === true || limitPlus.Z === true,
        } : null,
        door: null,
        hold: null,
        // Contract v5 (WO-922). A stand-in that reports every switch as
        // `false` forever is a fixture, not a simulator, so this models the
        // one thing the 2026-08-23 runaway turned on: the home switch of the
        // axis that is homing right now IS MADE while it is homing.
        home: this.homeInputs(),
        // Assigned inputs read false while open and true at their end of
        // travel. Unassigned inputs remain null; false would falsely claim a
        // switch exists. Operator's machine therefore retains all-null maps.
        limitMinus,
        limitPlus,
      },
      homed: { ...this.homed },
      spindle: this.buildSpindleStatus(),
    }
  }

  private reportedSpindleRpm(): number {
    return Math.round((this.spindleRpm * this.spindleOvr) / 100)
  }

  /** A configured simulated inverter reports what it can genuinely know.
   * Electrical telemetry stays null; shaft motion and link liveness are
   * native facts of this software model. */
  private buildSpindleStatus(): MachineStatus['spindle'] {
    const definition = this.spindle?.spindleLinkDefinition
    if (!definition) return null
    const commandedRpm = Math.round((this.spindleTargetRpm * this.spindleOvr) / 100)
    return {
      volts: null,
      amps: null,
      torque: null,
      power: null,
      upToSpeed: this.spindleRunning
        // MachineSpindleLinkDefinition widens only provenance metadata; the
        // shared runtime comparison reads the common tolerance field.
        ? vfdIsUpToSpeed(definition as VfdDefinition, commandedRpm, this.reportedSpindleRpm())
        : false,
      running: this.spindleRpm > 0,
      linkUp: true,
    }
  }

  /**
   * WO-922: per-axis home-switch state, honestly.
   *
   * This backend has a home switch on each of its three axes, and homes them
   * ONE AT A TIME (`homeAxes` / `tick`), so at most one switch is made at any
   * moment: the axis at the front of the homing queue, for the length of its
   * own slot. Every other axis reads `false` - wired, and open - not `null`,
   * which here would be a lie: these switches exist.
   *
   * A, B and C are absent from the map rather than `null`, because this
   * simulator is a three-axis machine and "there is no such axis" is a third
   * thing again from "an axis with no input wired".
   *
   * Not modelled: a switch that stays made after its cycle ends (real home
   * back-off is 0 on Operator's profile, so his really do). That is the runaway's
   * actual precondition, and modelling it would make the simulator report a
   * fault state it can never clear - so the incident's fixture belongs in a
   * test, not in the default stand-in. See the WO-922 test file.
   */
  private workPosition(wco: MachinePosition): MachinePosition {
    const work = { ...this.pos }
    for (const axis of this.controlAxes) {
      const key = positionAxisKey(axis)
      work[key] = this.pos[key]! - wco[key]!
    }
    work.z -= this.tlo
    return work
  }

  private homeInputs(): Partial<Record<AxisName, boolean | null>> {
    const homing = this.homingRemainingMs > 0 ? this.homingQueue[0] : undefined
    return Object.fromEntries(this.controlAxes.map((axis) => [axis, homing === axis]))
  }

  private limitInputs(side: 'minus' | 'plus'): Record<'X' | 'Y' | 'Z', boolean | null> {
    return Object.fromEntries((['x', 'y', 'z'] as const).map((axis) => {
      const assigned = this.limitWiring[axis][side]
      const made = assigned
        && this.hardLimitTripped?.axis === axis
        && this.hardLimitTripped.side === side
      return [axis.toUpperCase(), assigned ? made : null]
    })) as Record<'X' | 'Y' | 'Z', boolean | null>
  }

  queryStatus(): void {
    this.events.onStatus?.(this.status())
  }

  refreshState(): boolean {
    this.events.onParserState?.(this.parserState())
    // WO-434: was a no-op besides the parser-state read - the Offsets panel
    // (WCS table, TLO field) went stale under the simulator because nothing
    // ever called onOffset. Answer the same rows $# does.
    this.emitAllOffsetRows()
    return true
  }

  /**
   * WO-428: unlike WO-420's placeholder, this now actually answers - the
   * travel numbers machineEnvelope.ts's deriveMachineEnvelope reads
   * ($130/$131/$132, $23, $27), from the machine profile this controller was
   * constructed with. Mirrors SimulatedGrblTransport's $$ answer (WO-347): a
   * simulated connection describes the machine actually selected, never a
   * hardcoded literal. The values are fixed at construction, so there is
   * nothing to go stale and no "already queried" guard - every call answers
   * with the same numbers.
   */
  querySettings(): boolean {
    const emit = (key: number, value: string) => this.events.onSetting?.(String(key), value)
    const axisTravel = (mm: number): string => (Number.isFinite(mm) && mm > 0 ? mm : 0).toFixed(3)
    emit(130, axisTravel(this.travelMm.x))
    emit(131, axisTravel(this.travelMm.y))
    emit(132, axisTravel(this.travelMm.z))
    const dirMask = (['x', 'y', 'z'] as const).reduce(
      (mask, axis, bit) => mask | (this.homeConvention?.[axis].homesToward === 'min' ? 1 << bit : 0),
      0,
    )
    emit(23, String(dirMask))
    // No pull-off is modelled - this class parks exactly at homePosition.
    emit(27, '0.000')
    return true
  }

  /** Simulator positions advance on generated timer ticks, not hardware
   * telemetry. The session uses this capability to avoid applying its
   * impossible-physical-speed instrument to synthetic frames. */
  statusFramesAreSynthetic(): boolean {
    return true
  }

  verifiedIdle(): boolean {
    return this.state === 'idle' && this.queue.length === 0
  }

  /**
   * WO-930: DERIVED from the per-axis truth this class already kept, never a
   * second flag beside it. There used to be a `homedThisSessionFlag` set at
   * the end of ANY cycle, so `homeAxes(['Z'])` reported the whole machine
   * homed while X and Y sat on unreferenced counters. `this.homed` was right
   * the whole time; only the boolean lied.
   */
  homedThisSession(): boolean {
    return HOMED_GATE_AXES.every((axis) => this.homed[axis] === true)
  }

  homedAxesThisSession(): Partial<Record<JogAxis, boolean>> {
    const gateAxes: Partial<Record<JogAxis, boolean>> = {}
    for (const axis of HOMED_GATE_AXES) {
      if (this.homed[axis] !== undefined) gateAxes[axis] = this.homed[axis]
    }
    return gateAxes
  }

  /**
   * WO-986: the simulator's acknowledged manual-datum operation. Position and
   * datum truth change together, then cross the same status/homed event seams
   * a real backend uses so the store and every coordinate gate update from the
   * controller rather than from an optimistic UI write.
   */
  setMachinePosition(position: MachinePosition): boolean {
    const completeDatum = this.controlAxes.every((axis) => (
      Number.isFinite(position[positionAxisKey(axis)])
    ))
    if (
      this.phase !== 'connected'
      || this.estopTripped
      || this.programActive
      || !this.verifiedIdle()
      || !completeDatum
    ) return false

    const nextPosition = { ...this.pos }
    const nextHomed = { ...this.homed }
    for (const axis of this.controlAxes) {
      const key = positionAxisKey(axis)
      nextPosition[key] = position[key]!
      nextHomed[axis] = true
    }
    this.pos = nextPosition
    this.lastEnqueuedTarget = { ...nextPosition }
    this.homed = nextHomed
    this.events.onHomed?.([...this.controlAxes])
    this.events.onStatus?.(this.status())
    return true
  }

  resetInProgress(): boolean {
    return this.resetInProgressFlag
  }

  subscribeResetInProgress(listener: () => void): () => void {
    this.resetListeners.add(listener)
    return () => this.resetListeners.delete(listener)
  }

  // ---- motion ----

  jog(axis: ControlAxis, deltaMm: number, feedMmMin: number): boolean {
    if (!this.canJog() || !this.controlAxes.includes(axis)) return false
    const key = positionAxisKey(axis)
    const target = { ...this.lastEnqueuedTarget, [key]: this.lastEnqueuedTarget[key]! + deltaMm }
    if ((key === 'x' || key === 'y' || key === 'z') && !this.withinEnvelope(target, [key])) return false
    this.enqueueJog(target, feedMmMin)
    return true
  }

  jogToWorkXY(x: number, y: number, feedMmMin: number): boolean {
    if (!this.canJog()) return false
    const wco = this.wco[this.activeWcs]
    const target = { ...this.lastEnqueuedTarget, x: x + wco.x, y: y + wco.y }
    if (!this.withinEnvelope(target, ['x', 'y'])) return false
    this.enqueueJog(target, feedMmMin)
    return true
  }

  jogToMachineZ(z: number, feedMmMin: number): boolean {
    if (!this.canJog()) return false
    const target = { ...this.lastEnqueuedTarget, z }
    if (!this.withinEnvelope(target, ['z'])) return false
    this.enqueueJog(target, feedMmMin)
    return true
  }

  jogCancel(): void {
    // WO-2800: standing in for the native board, its stop (StopNow) also ends
    // a probe call in flight - where it stands, no contact.
    const stopped = this.nativeBoardStandIn ? this.queue.filter((m) => this.probeResolvers.has(m.id)) : []
    this.queue = this.queue.filter((m) => m.asState !== 'jog' && !stopped.includes(m))
    this.lastEnqueuedTarget = this.queue.length > 0 ? this.queue[this.queue.length - 1].target : { ...this.pos }
    for (const move of stopped) {
      const resolve = this.probeResolvers.get(move.id)
      this.probeResolvers.delete(move.id)
      resolve?.({ ok: false, at: null })
    }
    if (stopped.length > 0 && this.queue.length === 0) this.executingMoveId = null
    if (this.state === 'jog' || (stopped.length > 0 && this.state === 'run')) this.setState(this.queue.length > 0 ? 'run' : 'idle')
  }

  /** WO-2800: the session runs a feature routine (WO-2811: also Tool Z and a
   *  custom probe routine) through this simulator as the native-probe board
   *  its machine definition names (UCCNC). There a probe() that meets nothing ends quietly at its target (the guarded
   *  descent's way of arriving), and jogCancel stops one in flight. */
  setNativeBoardStandIn(on: boolean): void {
    this.nativeBoardStandIn = on
  }

  /**
   * The orderless whole-machine cycle.
   *
   * WO-914: this used to home `['X', 'Y', 'Z']` - its own literal, and a
   * Z-LAST one. It homed all three at once so nothing observed the order, but
   * the list was still a second, wrong copy of a safety setting. It now runs
   * the ONE resolved fallback (`resolveHomingOrder`, Z first) rather than a
   * list of its own. Callers that know the machine should pass its order to
   * `homeAxes` instead; `capabilities.perAxisHoming` is true here.
   */
  home(): boolean {
    return this.homeAxes(resolveHomingOrder(null))
  }

  homeAxesRefusal(): string | null {
    return this.lastHomeAxesRefusal
  }

  private refuseHomeAxes(reason: string): false {
    this.lastHomeAxesRefusal = `Homing was refused: ${reason} Nothing was homed.`
    return false
  }

  /**
   * Home these axes IN THIS ORDER, one at a time.
   *
   * The simulator genuinely sequences them - each axis snaps to its home
   * position, and appears in `status().homed`, only when its own slot ends -
   * because "the machine homed in the order the definition asked for" is not
   * a claim a test can make against three axes that all finish together. The
   * whole cycle still takes `HOMING_MS`, split evenly, so nothing that timed
   * the old cycle changes.
   *
   * An axis this simulator does not model is REFUSED, not skipped:
   * quietly homing a subset would be substituting a different order for the
   * one asked for, which is the exact defect WO-914 removes.
   */
  homeAxes(axes: AxisName[]): boolean {
    this.lastHomeAxesRefusal = null
    if (this.phase !== 'connected') {
      return this.refuseHomeAxes(`the simulated controller is ${this.phase}, not connected.`)
    }
    if (this.estopTripped) {
      return this.refuseHomeAxes('the simulated E-STOP is tripped; clear it before homing.')
    }
    if (axes.length === 0) {
      return this.refuseHomeAxes('the requested homing order is empty.')
    }
    const modelled: ControlAxis[] = []
    for (const a of axes) {
      if (!this.controlAxes.includes(a)) {
        return this.refuseHomeAxes(
          `the requested order includes unsupported axis ${a}; this simulator models ${this.controlAxes.join(', ')}.`,
        )
      }
      if (modelled.includes(a)) {
        return this.refuseHomeAxes(`the requested order lists axis ${a} more than once.`)
      }
      modelled.push(a)
    }
    this.queue = []
    this.homingQueue = modelled
    this.homingDone = []
    this.homingPerAxisMs = Math.max(TICK_MS, Math.round(HOMING_MS / axes.length))
    this.homingRemainingMs = this.homingPerAxisMs
    this.setState('home')
    return true
  }

  // ---- authority ----

  feedHold(): void {
    if (this.state === 'run' || this.state === 'jog') this.setState('hold')
  }

  cycleResume(): boolean {
    if (this.state !== 'hold') return false
    const next = this.queue[0]
    this.setState(next ? next.asState : 'idle')
    return true
  }

  /**
   * Controller-level reset - the Stop/Reset control, GRBL's soft reset (0x18).
   *
   * WO-469: it deliberately does NOT release an E-STOP. GRBL-PROTOCOL is
   * explicit that a soft reset "PRESERVES alarm lock", and the same must hold
   * here or Stop/Reset would become a second, unconfirmed way out of an
   * emergency stop. So `estopTripped` survives this and the state re-enters
   * 'alarm'. That is the intended behaviour, not the WO-469 bug: the bug was
   * that NOTHING an operator could reach released the latch. resetToIdle()
   * below is the release, and machineSession's confirmed E-STOP CLEAR is now
   * its operator-facing caller.
   */
  reset(): void {
    this.resetInProgressFlag = true
    this.resetListeners.forEach((fn) => fn())
    this.abandonProgram()
    this.abandonHoming()
    this.queue = []
    for (const resolve of this.mdiProbeAwaiters.values()) resolve({ ok: false, message: 'controller reset' })
    this.mdiProbeAwaiters.clear()
    for (const resolve of this.probeResolvers.values()) resolve({ ok: false, at: null, reason: 'controller reset' })
    this.probeResolvers.clear()
    this.executingMoveId = null
    this.lastEnqueuedTarget = { ...this.pos }
    this.spindleRunning = false
    this.spindleRpm = 0
    this.spindleTargetRpm = 0
    this.spindleRampRpmPerMs = 0
    this.hardLimitTripped = null
    this.softLimitTripped = false
    this.toolNumber = 0
    this.setState(this.estopTripped ? 'alarm' : 'idle')
    this.resetInProgressFlag = false
    this.resetListeners.forEach((fn) => fn())
    this.flushAbandoned()
  }

  /** WO-2609/2615: the Probing Pause/Stop door cancels the routine's motion
   * (seek or positioning) without abandoning an armed program or changing
   * operator Reset semantics. An active program is never owned by this door. */
  cancelProbe(): void {
    if (this.programActive || !this.queue.some(m => !m.program)) return
    this.queue = []
    this.executingMoveId = null
    this.lastEnqueuedTarget = { ...this.pos }
    this.setState(this.estopTripped ? 'alarm' : 'idle')
    for (const resolve of this.mdiProbeAwaiters.values()) resolve({ ok: false, message: 'controller reset' })
    this.mdiProbeAwaiters.clear()
    for (const resolve of this.probeResolvers.values()) resolve({ ok: false, at: null, reason: 'controller reset' })
    this.probeResolvers.clear()
  }

  /**
   * $X - clear a plain alarm lock.
   *
   * WO-469: it deliberately does NOT release an E-STOP either, and the
   * `estopTripped` term below is that refusal. JogPanel's Unlock button calls
   * this raw, and its jog D-pad is gated on the controller state alone, so an
   * unlock that cleared the E-STOP would re-enable jogging from a control
   * that is not the E-STOP. This is stricter than real GRBL, where $X is
   * unconditional - a divergence recorded in this WO's evidence and kept on
   * purpose, because the simulator's E-STOP has no physical release to stand
   * in for.
   */
  unlock(): boolean {
    if (this.state !== 'alarm' || this.estopTripped) return false
    this.hardLimitTripped = null
    this.softLimitTripped = false
    this.setState('idle')
    return true
  }

  /**
   * EMERGENCY STOP. Never gated, by anything, ever. Sets the latch that keeps
   * every motion entry point (home, homeAxes, and - through the 'alarm' state
   * - canJog) refusing until a deliberate operator action releases it. Only
   * resetToIdle() releases it.
   */
  emergencyStop(): void {
    this.estopTripped = true
    this.abandonProgram()
    // WO-914: A STOP MUST STOP A HOMING CYCLE. Without this the tick loop's
    // homing branch runs to completion behind the latch and then calls
    // setState('idle') - an E-STOP pressed mid-cycle would have been undone by
    // the very cycle it was meant to interrupt. The window used to be one
    // 1.5 s slot; sequencing the axes would have made it one slot per axis.
    this.abandonHoming()
    this.queue = []
    this.executingMoveId = null
    this.spindleRunning = false
    this.spindleRpm = 0
    this.spindleTargetRpm = 0
    this.spindleRampRpmPerMs = 0
    this.setState('alarm')
    // Everything above is the STOP. Nothing that a subscriber runs may come
    // before it, so both events are raised only now, with the machine already
    // stopped and its queue already drained.
    this.flushAbandoned()
    // WO-2800 fix round 2: a probe call or G38 line the E-STOP abandoned is
    // answered, never left waiting - a routine awaiting it ends here.
    this.answerAbandonedProbes(SIMULATED_ESTOP_MESSAGE)
    // No code: this controller is software and has no firmware alarm numbers,
    // and contract v3 types `code` as nullable for exactly that. Position is
    // NOT lost - the model kept integrating it - so re-homing is not demanded.
    this.events.onAlarm?.(null, SIMULATED_ESTOP_MESSAGE, false)
  }

  /** WO-2800 fix round 2: every probe call and G38 line still waiting ends,
   *  not touched, with `reason`. */
  private answerAbandonedProbes(reason: string): void {
    const calls = [...this.probeResolvers.values()]
    const lines = [...this.mdiProbeAwaiters.values()]
    this.probeResolvers.clear()
    this.mdiProbeAwaiters.clear()
    for (const resolve of calls) resolve({ ok: false, at: null, reason })
    for (const resolve of lines) resolve({ ok: false, message: reason })
  }

  /**
   * Return to a VERIFIED idle (WO-087) - and the ONE thing that releases an
   * E-STOP on this backend.
   *
   * WO-469: that was already true, and was the whole deadlock. Its only
   * non-test caller was armProgramFromTop(), a JOB action that refuses with
   * no program loaded and refuses again while alarmed - which is the only
   * state you can be in when you need it. The exit from an E-STOP was
   * reachable only through a door the E-STOP locked. The fix gave it a second
   * caller that is an OPERATOR-RECOVERY action: machineSession's resetEstop(),
   * reached from the flashing CLEAR mode of the E-STOP control, and only
   * after that function's debounce, connection, active-job, fresh-status and
   * epoch confirms have all passed. Clearing the latch after the operator has
   * acted is a different thing from ignoring the stop; nothing here is
   * reachable without that deliberate act.
   */
  async resetToIdle(): Promise<{ ok: boolean; reason: string | null }> {
    this.estopTripped = false
    this.hardLimitTripped = null
    this.softLimitTripped = false
    this.queue = []
    this.executingMoveId = null
    this.lastEnqueuedTarget = { ...this.pos }
    this.setState('idle')
    return { ok: true, reason: null }
  }

  setOverride(change: OverrideChange): void {
    const next = (current: number): number => {
      if (change.to === 'reset') return 100
      if (change.to === 'percent') return Math.max(10, Math.min(200, change.percent))
      return Math.max(10, Math.min(200, current + (change.coarse ? 10 : 1) * change.direction))
    }
    if (change.kind === 'feed') this.feedOvr = next(this.feedOvr)
    else if (change.kind === 'rapid') this.rapidOvr = next(this.rapidOvr)
    else this.spindleOvr = next(this.spindleOvr)
  }

  // ---- setup ----

  selectWcs(wcs: WcsId): boolean {
    this.activeWcs = wcs
    return true
  }

  zeroWorkAxis(axis: ControlAxis): boolean {
    this.applyWorkZero(axis)
    return true
  }

  /** WO-1042/1083: the simulator knows its own position, so it answers in the
   *  same receipt shape the bridge does - the whole WCS row after the write.
   *  The session then writes the store through ONE table for both backends,
   *  rather than reading a value out of a status frame for either. */
  zeroWorkAxisAwait(axis: ControlAxis): Promise<ZeroWorkAxisReceipt> | null {
    return Promise.resolve(this.applyWorkZero(axis))
  }

  private applyWorkZero(axis: ControlAxis): ZeroWorkAxisReceipt {
    const key = positionAxisKey(axis)
    const wcs = this.activeWcs
    this.wco[wcs] = { ...this.wco[wcs], [key]: this.pos[key] }
    return { confirmed: true, wcs, offset: { ...this.wco[wcs] } }
  }

  probe(axis: JogAxis, targetMm: number, feedMmMin: number): Promise<ProbeTouch> {
    return new Promise((resolve) => {
      if (this.phase !== 'connected') {
        resolve({ ok: false, at: null })
        return
      }
      const key = axis.toLowerCase() as AxisKey
      const target = { ...this.lastEnqueuedTarget, [key]: targetMm }
      this.lastEnqueuedTarget = target
      const id = this.mintId()
      this.probeResolvers.set(id, resolve)
      this.queue.push({ id, kind: 'probe', target, feedMmMin, program: false, asState: 'run', probeMissAllowed: this.nativeBoardStandIn })
      if (this.state === 'idle') this.setState('run')
    })
  }

  // ---- WO-428/WO-416: the virtual part (ported from simulatedTransport.ts) --
  //
  // Same geometry, same rules as SimulatedGrblTransport: a rectangular block
  // with a non-flat top (a deterministic bow + noise), an optional bore and
  // an optional boss, so the factory bore/boss-centre routines find real
  // walls. null (the default) reproduces the flat-pad-only behaviour every
  // probe test before WO-416 depends on.

  /** Place (or remove, with null) the virtual part every probe contacts from
   *  now on. Takes effect on the NEXT probe move; a probe already mid-cycle
   *  keeps whatever surface it started against. */
  setSimulatedPart(part: SimulatedPart | null): void {
    this.part = part
    // WO-2004: a part no tool on this machine can reach is placed as asked,
    // and said once - the default part's top at machine Z -40 sits below the
    // whole Z travel of a machine that homes to Z max (LienCNC V2: -0.1 to
    // 129.1), so every probe and every cut on it would silently miss.
    const z = this.envelope.z
    if (!part || !z) return
    const top = part.topZ + (part.boss?.height ?? 0)
    const bottom = part.topZ - part.height
    if (top >= z.min && bottom <= z.max) return
    const mm = (value: number) => Number(value.toFixed(3))
    this.events.onConsole?.({
      dir: 'rx',
      text: `The simulated part spans machine Z ${mm(bottom)} to ${mm(top)}, outside this machine's Z travel `
        + `(${mm(z.min)} to ${mm(z.max)}): no probe or cut can reach it (simulated).`,
      severity: 'warn',
    })
  }

  getSimulatedPart(): SimulatedPart | null {
    return this.part
  }

  /** WO-2692: place (or, with null, remove) the fixed tool setter. Takes
   *  effect on the next probe move, as setSimulatedPart does. */
  setSimulatedToolSetter(setter: SimulatedToolSetter | null): void {
    this.toolSetter = setter
  }

  getSimulatedToolSetter(): SimulatedToolSetter | null {
    return this.toolSetter
  }

  /** WO-2779: give the probe tip a fixed radius (0 makes it a point again).
   *  Takes effect on the next probe tick, as setSimulatedPart does. */
  setSimulatedProbeTipRadius(radiusMm: number): void {
    this.probeTipRadiusSource = () => radiusMm
  }

  /** WO-2779: the radius the probe touches the part with now - 0 for anything
   *  that is not a finite, positive number. */
  simulatedProbeTipRadius(): number {
    const r = this.probeTipRadiusSource()
    return Number.isFinite(r) && r > 0 ? r : 0
  }

  /** Deterministic per-XY pseudo-random value in [-amplitude, amplitude] - a
   *  repeat probe at the same point must agree, so this is a pure function of
   *  (x, y) alone, never of time or tick count. */
  private static surfaceNoise(x: number, y: number, amplitude: number): number {
    if (amplitude <= 0) return 0
    const s = Math.sin(x * 12.9898 + y * 78.233) * 43758.5453
    const frac = s - Math.floor(s)
    return (frac * 2 - 1) * amplitude
  }

  /** The block's top surface at (x, y): nominal topZ, dipping toward the
   *  edges by up to `bowMm`, plus the deterministic noise. */
  private topZAt(part: SimulatedPart, x: number, y: number): number {
    const cx = part.origin.x + part.sizeX / 2
    const cy = part.origin.y + part.sizeY / 2
    const halfDiag = Math.hypot(part.sizeX / 2, part.sizeY / 2) || 1
    const r = Math.min(1, Math.hypot(x - cx, y - cy) / halfDiag)
    const bow = part.bowMm ?? DEFAULT_BOW_MM
    const noise = part.noiseMm ?? DEFAULT_NOISE_MM
    return part.topZ - bow * r * r + SimulatedController.surfaceNoise(x, y, noise)
  }

  private static withinCircle(x: number, y: number, cx: number, cy: number, diameter: number): boolean {
    const r = diameter / 2
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r + 1e-9
  }

  /** A downward Z probe at fixed (x, y): the boss top (if over the boss),
   *  else the block top (if inside the footprint and not over the open
   *  bore), else null (nothing to contact - a miss). */
  private zTopThreshold(part: SimulatedPart, x: number, y: number): number | null {
    if (part.bore && SimulatedController.withinCircle(x, y, part.bore.cx, part.bore.cy, part.bore.diameter)) {
      return null // open hole - no top surface here
    }
    if (part.boss && SimulatedController.withinCircle(x, y, part.boss.cx, part.boss.cy, part.boss.diameter)) {
      return this.topZAt(part, x, y) + part.boss.height
    }
    // WO-2004: the same 1e-9 the wall and circle tests allow. A touch-off at
    // the corner a corner probe just found (work X0 Y0) is a machine position
    // computed through the offset, and it could land a float epsilon outside
    // a footprint computed another way - a miss on the part's own edge.
    const insideFootprint =
      x >= part.origin.x - 1e-9 && x <= part.origin.x + part.sizeX + 1e-9
      && y >= part.origin.y - 1e-9 && y <= part.origin.y + part.sizeY + 1e-9
    return insideFootprint ? this.topZAt(part, x, y) : null
  }

  /** The nearest crossing (bore wall, boss wall, or a block face) AHEAD of
   *  `from` along one horizontal axis, at the fixed (other-axis, z) - or null
   *  when nothing lies ahead. `dir` is +1 or -1.
   *  WO-2779: `tipR` is the probe tip's radius. A real probe closes when the
   *  ball's side reaches a wall, so its centre stops one radius short: the
   *  bore wall is met R - r from the bore's centre, the boss wall R + r, and a
   *  block face r out from it (round past a corner, as the ball is). The Z
   *  bands stay the centre's height. With r = 0 every crossing is the wall. */
  private horizontalThreshold(
    part: SimulatedPart,
    axis: 'x' | 'y',
    other: number,
    z: number,
    from: number,
    dir: 1 | -1,
    tipR = 0,
  ): number | null {
    const candidates: number[] = []
    const zTopNominal = part.topZ
    const zBottom = part.topZ - part.height
    const bore = part.bore
    if (bore) {
      const withinBoreZ = z <= zTopNominal + 1e-9 && z >= zTopNominal - bore.depth - 1e-9
      const c = axis === 'x' ? bore.cx : bore.cy
      const otherC = axis === 'x' ? bore.cy : bore.cx
      // WO-2779: a ball as wide as the bore fits nowhere in it; no wall to meet.
      if (withinBoreZ && (tipR === 0 || bore.diameter / 2 > tipR)) {
        const rr = (bore.diameter / 2 - tipR) ** 2
        const dOtherSq = (other - otherC) ** 2
        if (dOtherSq <= rr) {
          const half = Math.sqrt(rr - dOtherSq)
          candidates.push(c + half, c - half)
        }
      }
    }
    const boss = part.boss
    if (boss) {
      const withinBossZ = z <= zTopNominal + boss.height + 1e-9 && z >= zTopNominal - 1e-9
      const c = axis === 'x' ? boss.cx : boss.cy
      const otherC = axis === 'x' ? boss.cy : boss.cx
      if (withinBossZ) {
        const rr = (boss.diameter / 2 + tipR) ** 2
        const dOtherSq = (other - otherC) ** 2
        if (dOtherSq <= rr) {
          const half = Math.sqrt(rr - dOtherSq)
          candidates.push(c + half, c - half)
        }
      }
    }
    const withinBlockZ = z <= zTopNominal + 1e-9 && z >= zBottom - 1e-9
    const otherMin = axis === 'x' ? part.origin.y : part.origin.x
    const otherMax = otherMin + (axis === 'x' ? part.sizeY : part.sizeX)
    const withinOtherFootprint = other >= otherMin - tipR - 1e-9 && other <= otherMax + tipR + 1e-9
    if (withinBlockZ && withinOtherFootprint) {
      const min = axis === 'x' ? part.origin.x : part.origin.y
      const size = axis === 'x' ? part.sizeX : part.sizeY
      // WO-2779: beside the face, a full radius out; past its corner, the ball
      // meets the corner edge, so less.
      const past = Math.max(0, otherMin - other, other - otherMax)
      const out = tipR > 0 ? Math.sqrt(Math.max(0, tipR * tipR - past * past)) : 0
      candidates.push(min - out, min + size + out)
    }
    // WO-2004: `from` is where THIS TICK starts, not where the probe started.
    // A tick that ends a float epsilon short of the wall (318.99999999999994
    // against 319) used to read that wall as behind it, skip it, and let the
    // next tick carry the probe straight through the part - a miss. A wall at
    // `from` within the epsilon is still ahead.
    let best: number | null = null
    for (const c of candidates) {
      const ahead = dir === 1 ? c > from - 1e-9 : c < from + 1e-9
      if (!ahead) continue
      if (best === null || (dir === 1 ? c < best : c > best)) best = c
    }
    return best
  }

  /** WO-2517: whether the part (or the boss on it) has material at `p`. The
   *  open bore above its floor is air. */
  private solidAt(part: SimulatedPart, p: MachineVec3): boolean {
    const boss = part.boss
    if (boss && SimulatedController.withinCircle(p.x, p.y, boss.cx, boss.cy, boss.diameter)
      && p.z >= part.topZ - 1e-9 && p.z <= this.topZAt(part, p.x, p.y) + boss.height + 1e-9) {
      return true
    }
    const inFootprint = p.x >= part.origin.x - 1e-9 && p.x <= part.origin.x + part.sizeX + 1e-9
      && p.y >= part.origin.y - 1e-9 && p.y <= part.origin.y + part.sizeY + 1e-9
    if (!inFootprint || p.z < part.topZ - part.height - 1e-9 || p.z > this.topZAt(part, p.x, p.y) + 1e-9) return false
    const bore = part.bore
    const inHole = bore !== null && bore !== undefined
      && SimulatedController.withinCircle(p.x, p.y, bore.cx, bore.cy, bore.diameter)
      && p.z >= part.topZ - bore.depth + 1e-9
    return !inHole
  }

  /** WO-2517: the probe pin - closed while the tip touches a surface or has
   *  been pushed into it, by a probe move or by any other move (a real board
   *  runs a plain move through the part, and the probe deflects). A touch
   *  stops ON the surface, so material within a few microns counts. */
  private probeTouching(p: MachineVec3): boolean {
    const part = this.part
    const reach = 1e-3
    // WO-2692: the setter's top, like the pad, closes the pin on it only.
    const setter = this.toolSetter
    if (setter && p.z <= setter.topZ + 1e-6 && p.z >= setter.topZ - reach
      && SimulatedController.withinCircle(p.x, p.y, setter.x, setter.y, setter.diameter)) return true
    // No part: the pre-WO-416 flat pad is a surface met from above, and only
    // that (probeContactPoint never finds it from below or from the side), so
    // the pin closes on it, not anywhere under it.
    if (!part) return p.z <= PROBE_PAD_Z + 1e-6 && p.z >= PROBE_PAD_Z - reach
    const atTip = [
      p,
      { ...p, x: p.x + reach },
      { ...p, x: p.x - reach },
      { ...p, y: p.y + reach },
      { ...p, y: p.y - reach },
      { ...p, z: p.z - reach },
    ].some((q) => this.solidAt(part, q))
    // WO-2779: a tip with a radius also closes when its side reaches a wall -
    // where probeContactPoint stops it, one radius short.
    const tipR = this.simulatedProbeTipRadius()
    return atTip || (tipR > 0 && this.sideGapToSolid(part, p) <= tipR + reach)
  }

  /** WO-2779: how far (XY) `p` is from the part's nearest wall at its own
   *  height, over the same walls and Z bands horizontalThreshold meets: the
   *  boss, the block's faces, and the bore's wall from inside it. 0 inside
   *  material; Infinity with no wall at that height. */
  private sideGapToSolid(part: SimulatedPart, p: MachineVec3): number {
    let gap = Number.POSITIVE_INFINITY
    const top = part.topZ
    const boss = part.boss
    if (boss && p.z <= top + boss.height + 1e-9 && p.z >= top - 1e-9) {
      gap = Math.min(gap, Math.max(0, Math.hypot(p.x - boss.cx, p.y - boss.cy) - boss.diameter / 2))
    }
    if (p.z > top + 1e-9 || p.z < top - part.height - 1e-9) return gap
    const dx = Math.max(0, part.origin.x - p.x, p.x - (part.origin.x + part.sizeX))
    const dy = Math.max(0, part.origin.y - p.y, p.y - (part.origin.y + part.sizeY))
    if (dx > 0 || dy > 0) return Math.min(gap, Math.hypot(dx, dy))
    const bore = part.bore
    if (bore && p.z >= top - bore.depth - 1e-9) {
      const fromAxis = Math.hypot(p.x - bore.cx, p.y - bore.cy)
      if (fromAxis < bore.diameter / 2) return Math.min(gap, bore.diameter / 2 - fromAxis)
    }
    return 0
  }

  /** Where (if anywhere) this probe move crosses a surface between `prev`
   *  (this.pos before the tick) and `next` (this tick's proposed position).
   *  With no part placed, reproduces the pre-WO-416 flat-Z-pad-only check
   *  exactly. Every probe command moves a single axis, so the other two
   *  coordinates are fixed for the whole move - `prev`'s values for them are
   *  exact throughout. */
  private probeContactPoint(
    prev: MachineVec3,
    next: MachineVec3,
    dx: number,
    dy: number,
    dz: number,
  ): MachineVec3 | null {
    const onPart = this.partContactPoint(prev, next, dx, dy, dz)
    const setter = this.toolSetter
    const onSetter = setter ? SimulatedController.setterContactPoint(setter, prev, next, dx, dy, dz) : null
    if (!onSetter) return onPart
    if (!onPart) return onSetter
    // WO-2692: both lie on this tick's path; the probe meets the nearer first.
    const along = (c: MachineVec3) => Math.abs(c.x - prev.x) + Math.abs(c.y - prev.y) + Math.abs(c.z - prev.z)
    return along(onSetter) <= along(onPart) ? onSetter : onPart
  }

  /** WO-2692: where (if anywhere) this probe tick meets the setter's top -
   *  a downward Z probe over its footprint, as the pad is met. */
  private static setterContactPoint(
    setter: SimulatedToolSetter,
    prev: MachineVec3,
    next: MachineVec3,
    dx: number,
    dy: number,
    dz: number,
  ): MachineVec3 | null {
    if (dz >= 0 || Math.abs(dz) < Math.abs(dx) || Math.abs(dz) < Math.abs(dy)) return null
    if (!SimulatedController.withinCircle(prev.x, prev.y, setter.x, setter.y, setter.diameter)) return null
    return prev.z > setter.topZ && next.z <= setter.topZ ? { x: next.x, y: next.y, z: setter.topZ } : null
  }

  /** The part (or, with none placed, the flat pad) this probe tick meets. */
  private partContactPoint(
    prev: MachineVec3,
    next: MachineVec3,
    dx: number,
    dy: number,
    dz: number,
  ): MachineVec3 | null {
    const part = this.part
    if (!part) {
      if (dz < 0 && prev.z > PROBE_PAD_Z && next.z <= PROBE_PAD_Z) {
        return { x: next.x, y: next.y, z: PROBE_PAD_Z }
      }
      return null
    }
    if (dz !== 0 && Math.abs(dz) >= Math.abs(dx) && Math.abs(dz) >= Math.abs(dy)) {
      if (dz >= 0) return null // upward Z probes are not modelled against the part
      const threshold = this.zTopThreshold(part, prev.x, prev.y)
      if (threshold === null) return null
      if (prev.z > threshold && next.z <= threshold) {
        return { x: next.x, y: next.y, z: threshold }
      }
      return null
    }
    if (dx !== 0 && Math.abs(dx) >= Math.abs(dy)) {
      const dir: 1 | -1 = dx > 0 ? 1 : -1
      const threshold = this.horizontalThreshold(part, 'x', prev.y, prev.z, prev.x, dir, this.simulatedProbeTipRadius())
      if (threshold === null) return null
      const crossed = dir === 1 ? next.x >= threshold : next.x <= threshold
      return crossed ? { x: threshold, y: next.y, z: next.z } : null
    }
    if (dy !== 0) {
      const dir: 1 | -1 = dy > 0 ? 1 : -1
      const threshold = this.horizontalThreshold(part, 'y', prev.x, prev.z, prev.y, dir, this.simulatedProbeTipRadius())
      if (threshold === null) return null
      const crossed = dir === 1 ? next.y >= threshold : next.y <= threshold
      return crossed ? { x: next.x, y: threshold, z: next.z } : null
    }
    return null
  }

  // ---- commands ----
  //
  // WO-434: this controller's native language is QueuedMove (loadMoves,
  // below) - that is the entire point of ADR-0041 - but machineSession.ts
  // sends a large set of everyday operator actions as single MDI-style
  // G-code lines through sendCommand/sendCommandAwait, not through
  // loadJob/loadMoves: probing, work-offset writes, TLO, safe-Z park, the
  // mesh-probe cycle's positioning moves, and manual spindle/coolant. Ported
  // from SimulatedGrblTransport's handleGcode/handleDollar/finishProbe -
  // see executeMdiLine below for the actual interpreter. A move that cannot
  // be honoured returns false / {ok:false, message} rather than the old
  // blanket `true` - silently lying about motion is worse than a refusal.

  sendCommand(text: string): boolean {
    if (this.phase !== 'connected') return false
    return this.executeMdiLine(text).ok
  }

  sendCommandAwait(text: string): Promise<{ ok: boolean; message: string | null }> | null {
    if (this.phase !== 'connected') return null
    const outcome = this.executeMdiLine(text)
    if (!outcome.ok) return Promise.resolve({ ok: false, message: outcome.message })
    // A queued G38.2 resolves later, when finishProbe() reads the contact
    // (or the miss) - everything else acks as soon as it is queued/applied,
    // exactly like real GRBL's "ok" (queued, not completed).
    return outcome.awaiter ?? Promise.resolve({ ok: true, message: null })
  }

  /**
   * WO-434: interprets ONE already-typed MDI/macro line against the MDI
   * modal state above (mdiUnitsScale/mdiDistanceMode/mdiFeed/activeWcs),
   * ported from SimulatedGrblTransport.handleGcode. Deliberately separate
   * from parseProgramLines: that method's SUPPORTED_G/SUPPORTED_M and local
   * scale/distanceMode are the WHOLE-PROGRAM dialect's rules, reset per
   * load; this is the narrower, persistent, single-line MDI vocabulary
   * (SUPPORTED_MDI_G/SUPPORTED_MDI_M above). A word outside it is refused
   * by name, never silently accepted.
   */
  /** WO-1644: the word table of the dialect this simulator runs, with this
   *  machine's own output words (WO-1650) and macro M-code range/bindings
   *  (WO-1643) - never the dialect's fixed macro floor alone. */
  private wordTable(): GcodeWordTable {
    return gcodeWordTableForMachine(
      gcodeWordTableWithOutputs(
        gcodeWordTable(gcodeTableDialectOf(this.dialect.id) ?? 'uccnc'),
        this.outputSources,
      ),
      this.macroSource,
    )
  }

  /** WO-1650: the listed outputs this simulator has on, each named by its on
   *  word (`M10`), in code order. */
  listedOutputsOnWords(): string[] {
    return this.listedOutputsOn.map((code) => `M${code}`)
  }

  /** WO-1650: switch the listed outputs a line's words name, and say so. M9
   *  stops every one of them. */
  private applyListedOutputWords(mWords: readonly number[], lineLabel: string): void {
    const on = new Set(this.listedOutputsOn)
    const said: string[] = []
    for (const m of mWords) {
      if (m === 9) {
        if (on.size > 0) said.push('M9 every listed output off')
        on.clear()
        continue
      }
      for (const word of this.outputWords.get(m) ?? []) {
        if (word.on) on.add(word.onCode)
        else on.delete(word.onCode)
        said.push(`M${m} ${word.name} ${word.on ? 'on' : 'off'}`)
      }
    }
    this.listedOutputsOn = [...on].sort((a, b) => a - b)
    if (said.length > 0) {
      this.events.onConsole?.({ dir: 'rx', text: `${lineLabel}${said.join('; ')} (simulated).`, severity: 'info' })
    }
  }

  /** The table's sentence for the first G or M word it does not carry. */
  private tableRefusal(table: GcodeWordTable, words: readonly TextWord[]): string | null {
    return simulatorTableRefusal(table, words)
  }

  /** WO-2878: a typed T word becomes the reported tool only when its line is
   *  accepted. GRBL runs nothing of an errored line (docs/machine/
   *  GRBL-PROTOCOL.md:11), so a refused line - wherever below it is refused -
   *  leaves `$G`'s T where it was. One commit point covers every return. */
  private executeMdiLine(
    rawText: string,
  ): { ok: true; awaiter?: Promise<{ ok: boolean; message: string | null }> } | { ok: false; message: string } {
    let typedTool: number | undefined
    // A T inside a comment - (T9) or ; T7 - selects nothing (audit 10-16 round 5).
    for (const w of tokenizeWords(stripGcodeComments(rawText).trim())) if (w.letter === 'T') typedTool = w.value
    const outcome = this.interpretMdiLine(rawText)
    if (outcome.ok && typedTool !== undefined && Number.isInteger(typedTool) && typedTool >= 0) {
      this.toolNumber = typedTool
    }
    return outcome
  }

  private interpretMdiLine(
    rawText: string,
  ): { ok: true; awaiter?: Promise<{ ok: boolean; message: string | null }> } | { ok: false; message: string } {
    const text = rawText.trim()
    if (text === '') return { ok: true } // blank line: harmless ack, like real GRBL

    const words = tokenizeWords(text)
    const gWords = words.filter((w) => w.letter === 'G').map((w) => w.value)
    const mWords = words.filter((w) => w.letter === 'M').map((w) => w.value)
    const table = this.wordTable()
    // WO-1644: a word the dialect's table does not carry gets the table's sentence.
    const unknown = this.tableRefusal(table, words)
    if (unknown !== null) return { ok: false, message: unknown }
    for (const g of gWords) {
      if (!SUPPORTED_MDI_G.has(g)) {
        return { ok: false, message: `G${g} is not part of the manual-command vocabulary - refusing to run it.` }
      }
    }
    for (const m of mWords) {
      // WO-1643: a code this machine's own macro range/bindings claim is
      // reported as a macro call - the same sentence the file door's reader
      // gives it - never the blanket "not part of the manual-command
      // vocabulary" refusal a typed line otherwise gets.
      if (isGcodeMacroMCode(table, m)) {
        return { ok: false, message: `${gcodeMacroRefusal(table, m)}.` }
      }
      if (!SUPPORTED_MDI_M.has(m) && !this.outputWords.has(m)) {
        return { ok: false, message: `M${m} is not part of the manual-command vocabulary - refusing to run it.` }
      }
    }
    // Last-wins per letter, mirroring SimulatedGrblTransport.words().
    const wWords = new Map<string, number>()
    for (const w of words) wWords.set(w.letter, w.value)

    if (gWords.includes(20)) this.mdiUnitsScale = 25.4
    if (gWords.includes(21)) this.mdiUnitsScale = 1
    if (gWords.includes(90)) this.mdiDistanceMode = 'absolute'
    if (gWords.includes(91)) this.mdiDistanceMode = 'incremental'
    for (const id of WCS_IDS) {
      if (gWords.includes(Number(id.slice(1)))) this.activeWcs = id
    }
    if (wWords.has('F')) this.mdiFeed = wWords.get('F')!
    // The typed T word is taken by executeMdiLine once this line is accepted.
    const typedTool = wWords.get('T')

    let accessoriesChanged = false
    if (mWords.includes(3) || mWords.includes(4)) {
      const direction = mWords.includes(4) ? 'ccw' : 'cw'
      const rpm = wWords.get('S')
      const refusal = this.spindleDirectionRefusal(direction)
      if (refusal) {
        this.events.onConsole?.({ dir: 'rx', text: refusal, severity: 'error' })
        return { ok: false, message: refusal }
      }
      const resolved = this.resolveSpindleRpm(direction, rpm)
      if (resolved.notice) {
        this.events.onConsole?.({ dir: 'rx', text: resolved.notice, severity: 'warn' })
      }
      this.spindleRunning = true
      this.spindleDir = direction
      if (resolved.rpm !== undefined) this.beginSpindleRamp(resolved.rpm)
      accessoriesChanged = true
    }
    if (mWords.includes(5)) {
      this.spindleRunning = false
      this.beginSpindleRamp(0)
      accessoriesChanged = true
    }
    if (mWords.includes(7)) {
      this.mistOn = true
      accessoriesChanged = true
    }
    if (mWords.includes(8)) {
      this.floodOn = true
      accessoriesChanged = true
    }
    if (mWords.includes(9)) {
      this.floodOn = false
      this.mistOn = false
      accessoriesChanged = true
    }
    this.applyListedOutputWords(mWords, '')
    if (accessoriesChanged) {
      this.events.onAccessories?.({
        spindle: this.spindleRunning ? this.spindleDir : 'off',
        flood: this.floodOn,
        mist: this.mistOn,
      })
    }

    // G10 L2/L20 - work-offset register write. Never motion, whatever L is.
    if (gWords.includes(10)) {
      if (!wWords.has('L')) return { ok: false, message: 'G10 requires an L word (L2 or L20).' }
      const l = wWords.get('L')
      const p = wWords.get('P') ?? 0
      const id = p === 0 ? this.activeWcs : WCS_IDS[p - 1]
      if (!id || (l !== 2 && l !== 20)) {
        return { ok: false, message: `G10: L${l} P${p} is not a supported offset write.` }
      }
      const next = { ...this.wco[id] }
      for (const axis of this.controlAxes) {
        if (!wWords.has(axis)) continue
        const key = positionAxisKey(axis)
        const scale = axis === 'X' || axis === 'Y' || axis === 'Z' ? this.mdiUnitsScale : 1
        const stated = wWords.get(axis)! * scale
        next[key] = l === 20 ? this.lastEnqueuedTarget[key]! - stated : stated
        // TLO shifts reported work Z, so the register absorbs the remainder.
        if (l === 20 && axis === 'Z') next.z -= this.tlo
      }
      this.wco = { ...this.wco, [id]: next }
      this.emitOffsetRow(id)
      return { ok: true }
    }

    // G43.1 / G49 - dynamic tool length offset. Never motion, even though
    // G43.1 carries a Z word.
    if (gWords.includes(43.1)) {
      if (!wWords.has('Z')) return { ok: false, message: 'G43.1 requires a Z word.' }
      this.tlo = wWords.get('Z')! * this.mdiUnitsScale
      this.emitOffsetRow('TLO')
      return { ok: true }
    }
    if (gWords.includes(49)) {
      this.tlo = 0
      this.emitOffsetRow('TLO')
      return { ok: true }
    }

    // G4 - dwell. WO-433: unlike the whole-program interpreter's G4 (which
    // divides P by 1000 - LienCAM's own posted text is always the UCCNC
    // dialect, whose G4 P-word is declared in MILLISECONDS, dwellUnits: 'ms'
    // in src/lib/post/dialects/uccnc.ts), an MDI line is hand-built by
    // machineSession's own code (materialFit.ts's FIT_TRACE_DWELL_S, named
    // and valued as SECONDS) and must also make sense sent to real GRBL
    // hardware, whose G4 P-word is seconds. So P here is seconds, taken
    // literally - no unit conversion. Queued like G0/G1: this only confirms
    // the dwell was ACCEPTED (a real controller's ack means buffered, not
    // finished), matching startMaterialFitTrace's own "acks mean buffered,
    // not done" comment, which separately waits for Idle afterward.
    if (gWords.includes(4)) {
      const seconds = wWords.get('P')
      if (seconds === undefined || !(seconds >= 0)) {
        return { ok: false, message: 'G4 requires a non-negative P word (seconds).' }
      }
      this.queue.push({
        id: this.mintId(),
        kind: 'dwell',
        target: { ...this.lastEnqueuedTarget },
        feedMmMin: 0,
        seconds,
        program: false,
        asState: 'run',
      })
      if (this.state === 'idle') this.setState('run')
      return { ok: true }
    }

    // G38.2 / G38.3 - probe toward the ported virtual part (or the flat pad with
    // none placed). Queues the same 'probe' RunningMove kind tick()/
    // probeContactPoint already animate for the native probe() method, so
    // it reaches the identical geometry. The ack (sendCommandAwait) resolves
    // only when finishProbe() reads the contact or the miss.
    if (gWords.includes(38.2) || gWords.includes(38.3)) {
      const feed = wWords.get('F') ?? 0
      if (feed <= 0) return { ok: false, message: 'A probe move has no feed rate set.' }
      if (!wWords.has('X') && !wWords.has('Y') && !wWords.has('Z')) {
        return { ok: false, message: 'A probe move needs an X, Y or Z word.' }
      }
      const target = { ...this.lastEnqueuedTarget }
      for (const axis of ['X', 'Y', 'Z'] as const) {
        const v = wWords.get(axis)
        if (v === undefined) continue
        const key = axis.toLowerCase() as AxisKey
        const scaled = v * this.mdiUnitsScale
        target[key] =
          this.mdiDistanceMode === 'incremental' ? target[key] + scaled : scaled + this.wco[this.activeWcs][key]
      }
      this.lastEnqueuedTarget = target
      const id = this.mintId()
      const awaiter = new Promise<{ ok: boolean; message: string | null }>((resolve) => {
        this.mdiProbeAwaiters.set(id, resolve)
      })
      this.queue.push({ id, kind: 'probe', target, feedMmMin: feed, program: false, asState: 'run', probeMissAllowed: gWords.includes(38.3) })
      if (this.state === 'idle') this.setState('run')
      return { ok: true, awaiter }
    }

    // G0/G1, bare or G53 (machine-frame, absolute, WCO/TLO/distance-mode
    // ignored - the park-move and mesh-probe positioning contract).
    const hasCoord = wWords.has('X') || wWords.has('Y') || wWords.has('Z')
    const rapid = gWords.includes(0)
    const feedMove = gWords.includes(1)
    if (hasCoord && (rapid || feedMove)) {
      if (!rapid && this.mdiFeed <= 0) return { ok: false, message: 'A feed move has no feed rate set.' }
      const g53 = gWords.includes(53)
      const target = { ...this.lastEnqueuedTarget }
      for (const axis of ['X', 'Y', 'Z'] as const) {
        const v = wWords.get(axis)
        if (v === undefined) continue
        const key = axis.toLowerCase() as AxisKey
        const scaled = v * this.mdiUnitsScale
        target[key] = g53
          ? scaled
          : this.mdiDistanceMode === 'incremental'
            ? target[key] + scaled
            : scaled + this.wco[this.activeWcs][key]
      }
      const addressedAxes = (['X', 'Y', 'Z'] as const)
        .filter((axis) => wWords.has(axis))
        .map((axis) => axis.toLowerCase() as AxisKey)
      if (!this.withinEnvelope(target, addressedAxes)) {
        return { ok: false, message: "This move would leave the machine's declared travel." }
      }
      this.lastEnqueuedTarget = target
      const feedMmMin = rapid ? this.rapidMmMin : this.mdiFeed
      this.queue.push({ id: this.mintId(), kind: 'line', target, feedMmMin, program: false, asState: 'run' })
      if (this.state === 'idle') this.setState('run')
      return { ok: true }
    }
    if (hasCoord) {
      return { ok: false, message: 'A coordinate word appeared with no motion word (G0/G1).' }
    }

    // Non-motion line: units, distance mode, WCS select, spindle/coolant
    // (already applied above) - plain ok, like real GRBL. WO-2878: so is a
    // bare T word - GRBL takes "T5" and reports it as T in $G.
    if (gWords.length > 0 || mWords.length > 0 || typedTool !== undefined) return { ok: true }
    return { ok: false, message: `'${text}' is not part of the manual-command vocabulary.` }
  }

  private spindleDirectionRefusal(direction: 'cw' | 'ccw'): string | null {
    return simulatorSpindleDirectionRefusal(this.spindle ?? null, direction)
  }

  private resolveSpindleRpm(direction: 'cw' | 'ccw', rpm: number | undefined) {
    return simulatorSpindleRpm(this.spindle ?? null, direction, rpm)
  }

  private beginSpindleRamp(targetRpm: number): void {
    this.spindleTargetRpm = targetRpm
    if (!this.spindle) {
      // Backwards compatibility for direct fixtures which predate machine
      // spindle configuration; production always takes the timed branch.
      this.spindleRpm = targetRpm
      this.spindleRampRpmPerMs = 0
      return
    }
    this.spindleRampRpmPerMs = Math.abs(targetRpm - this.spindleRpm) / SIMULATOR_SPINDLE_RAMP_MS
  }

  private tickSpindle(): void {
    if (this.spindleRpm === this.spindleTargetRpm) return
    const step = this.spindleRampRpmPerMs * TICK_MS
    if (step <= 0 || Math.abs(this.spindleTargetRpm - this.spindleRpm) <= step) {
      this.spindleRpm = this.spindleTargetRpm
      return
    }
    this.spindleRpm += this.spindleTargetRpm > this.spindleRpm ? step : -step
  }

  private emitOffsetRow(id: WcsId | 'TLO'): void {
    if (id === 'TLO') {
      this.events.onOffset?.({ label: 'TLO', values: [this.tlo] })
      return
    }
    const w = this.wco[id]
    this.events.onOffset?.({ label: id, values: machinePositionValues(w) })
  }

  /** Every row SimulatedGrblTransport's `$#` answers with, ported: the six
   *  WCS registers, TLO, and the last probe contact (or the pre-probe
   *  default when none has run yet). */
  private emitAllOffsetRows(): void {
    for (const id of WCS_IDS) this.emitOffsetRow(id)
    this.emitOffsetRow('TLO')
    const at = this.lastProbe.at ?? this.pos
    this.events.onOffset?.({ label: 'PRB', values: [at.x, at.y, at.z], probeSuccess: this.lastProbe.ok })
  }

  // ---- program ----

  /** WO-428: parse LienCAM's posted text into the same QueuedMove stream
   *  loadMoves takes, then hand it to loadMoves so both entry points share
   *  ONE execution path - the pre-flight envelope check in startJob and the
   *  motion/M-code engine in tick() never need to know which door a program
   *  came in. A word the selected dialect does not emit refuses the WHOLE load with a
   *  named reason; nothing already loaded is disturbed. */
  loadJob(programText: string, analysis?: PreparedSimulatedProgram): LoadOutcome {
    // Exact bytes, configuration, parser/modal/start/offset state and instance
    // must still agree. Stale facts fall through to the same interpreter.
    const accepted = analysis?.text === programText
      && analysis.identity === simulatorParseIdentity(this.setupLoadPreparationInput()) ? analysis : null
    const facts = accepted ?? prepareSimulatedProgram(programText, this.setupLoadPreparationInput())
    const prepared = facts.prepared
    const parsed = facts.parsed
    for (const text of facts.notices) this.events.onConsole?.({ dir: 'rx', text, severity: 'warn' })
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    // Execution consumes its own index; retained prepared facts stay intact.
    this.lineEffects = new Map(parsed.effects)
    this.stageCarryingLength(parsed, prepared.lines)
    return { ok: true, result: prepared }
  }

  /** Mid-program start: `prelude` (modal restore + positioning, built by the
   *  caller's run-from-here planner) streams first, carrying sourceLine 0 -
   *  same convention GrblController uses, so the UI cursor ignores it -
   *  then every program line at or after `startLine`. */
  loadJobFrom(programText: string, startLine: number, prelude: string[]): LoadOutcome {
    const prepared = prepareProgram(withoutNestedComments(programText))
    const lines: StreamLine[] = [
      ...prelude.map((text) => ({ text, sourceLine: 0 })),
      ...prepared.lines.filter((l) => l.sourceLine >= startLine),
    ]
    const parsed = this.parseProgramLines(lines)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    this.lineEffects = parsed.effects
    this.stageCarryingLength(parsed, lines)
    return { ok: true, result: { ...prepared, lines } }
  }

  /**
   * WO-433: a pre-compiled line stream with source-line attribution - the
   * contract's own optional member (controller.ts's `loadPreparedJob`),
   * added for surface-mesh compensation (zSurfaceMesh.ts's
   * compileSurfaceCompensatedProgram), which builds its own program text
   * outside the normal load-from-file path. `GrblController.loadPreparedJob`
   * just hands `lines` straight to its streamer (GRBL executes TEXT, so
   * nothing needs re-parsing); this class's native language is QueuedMove, so
   * the equivalent is running `lines` through the SAME interpreter loadJob
   * uses, mirroring loadJobFrom's prelude+program handling exactly, minus the
   * text-prepare step (the caller already compiled this).
   *
   * Before this method existed, `machineSession.loadMachineProgram` fell back
   * to "This controller cannot take a mesh-compensated program" for every
   * simulator connection - discovered live by
   * zSurfaceMeshRunner.test.ts once WO-433 actually wired the native
   * simulator in; WO-433's STOPPED section and WO-434's own "still NOT
   * ported" list both missed this member because neither traced
   * machineSession's mesh-compensation path, only its sendCommand/MDI paths.
   */
  loadPreparedJob(lines: StreamLine[]): LoadOutcome {
    const parsed = this.parseProgramLines(lines)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    this.lineEffects = parsed.effects
    this.stageCarryingLength(parsed, lines)
    // Already compiled by the caller: nothing was stripped or skipped here,
    // and no line was rejected for length, so the result reports exactly
    // what was handed over - mirrors GrblController.loadPreparedJob's own
    // contract note.
    return { ok: true, result: { lines, skipped: 0, overlongLines: [] } }
  }

  /** Run the motion-only MachineProgram slice through the same queue and job
   * lifecycle as loadMoves. Actions remain all-or-nothing refusals until the
   * queue can execute them in order.
   *
   * WO-1081: the simulator has no finite hardware ring, so program length is
   * not refused here. The product still uses the declared/default part size to
   * preserve free stationary handoffs at rapids, while an unsplittable cut is
   * staged whole just as it is for the paced UC100 bridge. */
  loadProgram(program: MachineProgram): { ok: boolean; reason: string | null } {
    const moves = program.steps.filter(isQueuedMove)
    if (moves.length !== program.steps.length) {
      return { ok: false, reason: 'This program contains action steps; action steps are not wired yet.' }
    }
    const validation = validateMachineProgram(program)
    if (!validation.ok) return { ok: false, reason: validation.reason }
    // MachineProgram declares WORK coordinates (controller.ts), and the bridge
    // applies the active WCS while loading. WO-2004 (readiness walk 2026-09-25):
    // this door used to apply it to A/B/C only, so a Fusion file read by the
    // interpreter on "Simulate LienCNC V2" ran its XYZ as MACHINE coordinates -
    // with G54 at X300 the tool went to machine X20 and the path check read
    // hundreds of mm off. Every axis now crosses the same boundary the bridge
    // does. A G53 line carries its original partial machine target as
    // non-enumerable execution metadata and bypasses the offset exactly once.
    //
    // WO-2037: the G43.1 length in force is added to every work Z here too, as
    // the machine adds the length it holds (the bridge's lives in the work
    // offset's Z). A file's own `G43 H<n>` arrives folded NET of this register
    // (machineSession `toolLengthInForceMm`), so it replaces the applied length
    // instead of stacking on it; a file with no G43 runs with the applied one;
    // after the file's G49 its moves carry no fold of their own. A G53 line is
    // a machine target and takes neither the offset nor the length.
    const offset = { ...this.wco[this.activeWcs], z: this.wco[this.activeWcs].z + this.tlo }
    const machineMoves = moves.map((move): QueuedMove => {
      if (move.kind === 'line') {
        const absolute = move as typeof move & {
          machineAbsolute?: true
          machineTarget?: Partial<MachinePosition>
        }
        // The same target the bridge is sent (machineMoveWireForm).
        if (absolute.machineAbsolute === true) {
          return { ...move, to: { ...(absolute.machineTarget ?? move.to) } }
        }
        const to: Partial<MachinePosition> = {}
        for (const axis of ['x', 'y', 'z', 'a', 'b', 'c'] as const) {
          const workTarget = move.to[axis]
          if (typeof workTarget === 'number') to[axis] = workTarget + (offset[axis] ?? 0)
        }
        return { ...move, to }
      }
      if (move.kind === 'arc') {
        return {
          ...move,
          to: { x: move.to.x + offset.x, y: move.to.y + offset.y, z: move.to.z + offset.z },
          centre: { x: move.centre.x + offset.x, y: move.centre.y + offset.y, z: move.centre.z + offset.z },
        }
      }
      return move
    })
    return this.loadMoves(machineMoves)
  }

  /**
   * WO-1023: progress BY ID, which is this controller's native shape - it
   * already tracks the id executing and the id that last finished, and
   * `jobProgress()` has been squeezing both through a text streamer's
   * `ackedSourceLine` field ever since.
   *
   * `lastCompletedId` is `programLine`, the id of the move that ACTUALLY
   * finished executing (see `completeRunning`), reported as `null` rather than
   * `0` before the first one: 0 is a reserved id, so it can never be a real
   * answer. Implemented without declaring `capabilities.machineProgram`, which
   * is a claim about RUNNING a program - see `loadProgram` above.
   */
  programProgress(): ProgramProgress {
    return {
      executingId: this.executingMoveId,
      lastCompletedId: this.programLine > 0 ? this.programLine : null,
      total: this.programTotal,
      // This controller's buffer IS its queue, and it knows the occupancy
      // exactly - so a number, never null. Jog moves are not program steps and
      // are not counted, the same rule status().buffer.moves follows.
      queuedOnController: this.queue.filter((m) => m.program).length,
    }
  }

  loadMoves(moves: QueuedMove[]): { ok: boolean; reason: string | null } {
    // WO-1285: only an XY arc has ever flown on hardware, and this simulator
    // draws what it can vouch for. A non-XY plane is refused by name rather
    // than drawn as a guess.
    for (const m of moves) {
      if (m.kind === 'arc' && m.plane !== 'xy') {
        return {
          ok: false,
          reason: `Step id ${m.id} is an arc in the ${m.plane.toUpperCase()} plane; only XY arcs have flown on `
            + 'hardware, and the simulator does not pretend otherwise. Nothing was staged.',
        }
      }
    }
    this.pendingProgram = moves
    this.pendingLength = null
    this.pendingStart = null
    this.pendingRead = null
    this.programTotal = moves.length
    this.programSent = 0
    this.programLine = 0
    this.programFailed = false
    this.emitProgress()
    return { ok: true, reason: null }
  }

  /** WO-2037: a text-door program, remembering which moves carry the G43.1
   *  length it was read under. The program door needs no such record: the
   *  session reads the file again when the length changes before Cycle Start
   *  (its reader offsets carry this register), as it does for the bridge. */
  private stageCarryingLength(parsed: {
    moves: QueuedMove[]
    lengthMoves: Set<QueuedMove>
    start: MachinePosition
    startRelative: Map<QueuedMove, StartRelativeAxes>
  }, lines: StreamLine[]): void {
    if (!this.loadMoves(parsed.moves).ok) return
    this.pendingLength = { mm: this.tlo, moves: parsed.lengthMoves }
    this.pendingStart = { from: { ...parsed.start }, moves: parsed.startRelative }
    this.pendingRead = { lines, zeros: this.workZerosKey() }
  }

  /** WO-2712 amendment: every work zero a staged read depends on - the six
   *  registers and the work system a program's first blocks run in. */
  private workZerosKey(): string {
    return JSON.stringify([this.activeWcs, WCS_IDS.map((id) => this.wco[id])])
  }

  /** WO-2712 amendment: Cycle Start on text staged under other work zeros
   *  reads the same lines again against the zeros in force now - exactly a
   *  fresh load, from where the run starts and under the length in force, so
   *  the start/length rebases that follow have nothing left to move. Before
   *  this the run walked the moves baked at Load and the travel check refused
   *  a G54 the operator had already corrected. */
  private rereadForWorkZeroChange(): void {
    const staged = this.pendingRead
    if (!staged || staged.zeros === this.workZerosKey()) return
    this.rereadingStaged = true
    try {
      const parsed = this.parseProgramLines(staged.lines)
      // The same lines parsed at Load; only positions can differ now.
      if (!parsed.ok) return
      this.lineEffects = parsed.effects
      this.stageCarryingLength(parsed, staged.lines)
    } finally {
      this.rereadingStaged = false
    }
  }

  /** WO-2679: move every start-relative coordinate of the staged program by
   *  the change between the position it was read from and where this run
   *  starts. The 10-08 desk run loaded at the simulator's pre-home -5,-5,-5,
   *  homed to 0,0,0, and its `G0 Z15` flew to X-5 Y-5 - 5.35 mm off the path
   *  the check rightly derived from the run's own start. A controller reads
   *  a block when it executes it; this makes the staged one agree. Runs before
   *  rebasePendingLength, carrying its move set across the remap. */
  private rebasePendingStart(): void {
    const staged = this.pendingStart
    if (!staged) return
    const start = this.lastEnqueuedTarget
    const delta: Partial<MachinePosition> = {}
    let moved = false
    for (const axis of this.controlAxes) {
      const key = positionAxisKey(axis)
      const d = (start[key] ?? 0) - (staged.from[key] ?? 0)
      if (d !== 0) moved = true
      delta[key] = d
    }
    if (!moved) return
    const shift = (point: Partial<MachinePosition>, axes: readonly PositionAxisKey[]): Partial<MachinePosition> => {
      const out = { ...point }
      for (const key of axes) if (out[key] !== undefined) out[key] = out[key]! + (delta[key] ?? 0)
      return out
    }
    const length = this.pendingLength
    const lengthMoves = new Set<QueuedMove>()
    const moves = new Map<QueuedMove, StartRelativeAxes>()
    this.pendingProgram = this.pendingProgram.map((move) => {
      const axes = staged.moves.get(move)
      let shifted: QueuedMove = move
      if (axes && move.kind === 'line') shifted = { ...move, to: shift(move.to, axes.to) }
      else if (axes && move.kind === 'arc') {
        shifted = {
          ...move,
          to: shift(move.to, axes.to) as typeof move.to,
          centre: shift(move.centre, axes.centre) as typeof move.centre,
        }
      }
      if (axes) moves.set(shifted, axes)
      if (length?.moves.has(move)) lengthMoves.add(shifted)
      return shifted
    })
    if (length) this.pendingLength = { mm: length.mm, moves: lengthMoves }
    this.pendingStart = { from: { ...start }, moves }
  }

  /** WO-2037: move every length-carrying Z of the staged program by the change
   *  in G43.1 since it was read, so it runs under the length in force now.
   *  WO-2679: carries pendingStart's map across the remap, so a retry after a
   *  refused start still finds every start-relative move. */
  private rebasePendingLength(): void {
    const baked = this.pendingLength
    if (!baked || baked.mm === this.tlo) return
    const delta = this.tlo - baked.mm
    const staged = this.pendingStart
    const startMoves = new Map<QueuedMove, StartRelativeAxes>()
    const moves = new Set<QueuedMove>()
    this.pendingProgram = this.pendingProgram.map((move) => {
      const axes = staged?.moves.get(move)
      if (!baked.moves.has(move)) {
        if (axes) startMoves.set(move, axes)
        return move
      }
      let shifted: QueuedMove = move
      if (move.kind === 'line' && typeof move.to.z === 'number') {
        shifted = { ...move, to: { ...move.to, z: move.to.z + delta } }
      } else if (move.kind === 'arc') {
        shifted = {
          ...move,
          to: { ...move.to, z: move.to.z + delta },
          centre: { ...move.centre, z: move.centre.z + delta },
        }
      }
      moves.add(shifted)
      if (axes) startMoves.set(shifted, axes)
      return shifted
    })
    this.pendingLength = { mm: this.tlo, moves }
    if (staged) this.pendingStart = { from: staged.from, moves: startMoves }
  }

  startJob(): boolean {
    // WO-433: ported from GrblController - "Single Block: stepJob is the
    // only start". Continuous Cycle Start must refuse while Single Block is
    // armed, the same as real GRBL, so a race (or a caller other than the
    // gated Control-tab button) cannot stream the whole program past a mode
    // the operator turned on specifically to hold it back one line at a time.
    if (this.singleBlock) return false
    return this.beginQueuedProgram()
  }

  /**
   * WO-433: queues every pending move and starts the run - the body
   * `startJob()` always ran, factored out so `stepJob()` can reach it too
   * for the "Single Block, nothing running yet" case. Ported from
   * GrblController.stepJob(), which does the equivalent
   * (`this.jobActive = true; ...; this.streamer.start()`) when stepped from
   * an unstarted, 'ready' streamer - discovered live by
   * controlTabRegrid.test.tsx's "pressing Step sends exactly one program
   * line" and ProgramPanel.mcTier1.test.tsx's Single Block suite once WO-433
   * wired the native simulator in: this class's stepJob() used to be a bare
   * `return this.cycleResume()`, which only ever resumes from HOLD and can
   * never start a freshly loaded, never-run program - Step did nothing the
   * first time an operator pressed it.
   */
  private beginQueuedProgram(): boolean {
    if (this.phase !== 'connected' || this.state === 'alarm' || this.pendingProgram.length === 0) return false
    // WO-1790: startJob and the first stepJob share this release point. A
    // production simulator therefore cannot dispatch either form of absolute
    // program motion until every axis the definition requires has a datum.
    // An empty list is the deliberate switchless-machine exemption; it does
    // not write to `homed` or invent a datum (WO-1722).
    if (this.programHomeRequiredAxes?.some((axis) => this.homed[axis] !== true)) return false
    this.rereadForWorkZeroChange()
    // WO-428: walk the whole program against a SHADOW position first - a
    // program that would leave the machine's declared travel is refused
    // WHOLE, with an alarm, before anything moves. Real motion (and
    // lastEnqueuedTarget) is only committed once every move in it is known
    // to fit - never gates a STOP (nothing here is one), only a START.
    this.rebasePendingStart()
    this.rebasePendingLength()
    let shadow = { ...this.lastEnqueuedTarget }
    for (const m of this.pendingProgram) {
      const from = shadow
      shadow = resolveTarget(m, shadow)
      const movedAxes = (['x', 'y', 'z'] as const).filter((axis) => shadow[axis] !== from[axis])
      if ((m.kind === 'line' || m.kind === 'arc')
        && !this.withinEnvelope(shadow, movedAxes)) {
        this.events.onAlarm?.(
          null,
          "This program would move outside the machine's declared travel - refusing to start it.",
          false,
        )
        this.setState('alarm')
        return false
      }
      // WO-1285: an arc's BULGE. Both ends can be on the table while the
      // sweep is not; the endpoint walk above cannot see that, the true
      // swept box can.
      if (m.kind === 'arc') {
        const swept = arcSweptBounds(from, shadow, m.centre, m.clockwise)
        if (!this.withinEnvelope(swept.min, ['x', 'y']) || !this.withinEnvelope(swept.max, ['x', 'y'])) {
          this.events.onAlarm?.(
            null,
            `This program's arc (step ${m.id}) sweeps outside the machine's declared travel although both of its ends are inside - refusing to start it.`,
            false,
          )
          this.setState('alarm')
          return false
        }
      }
    }
    const programStart = { ...this.lastEnqueuedTarget }
    const resolved = this.pendingProgram.map((m) => this.resolveMove(m, { program: true, asState: 'run' }))
    if (this.cutTimeMotion) this.paceByPlan(programStart, this.pendingProgram, resolved, this.cutTimeMotion)
    for (const r of resolved) this.queue.push(r)
    this.pendingProgram = []
    this.programActive = true
    this.stoppedProgress = null
    if (this.state === 'idle') this.setState('run')
    this.events.onJobEvent?.('started', null)
    this.emitProgress()
    return true
  }

  // The lifecycle events below fire only when a program is actually loaded or
  // running. A feed hold with nothing loaded is a hold, not a program pause,
  // and announcing one would be an event this controller did not have.

  pauseJob(): void {
    const running = this.programActive
    this.feedHold()
    if (!running) return
    this.events.onJobEvent?.('paused', null)
    this.emitProgress()
  }

  resumeJob(): boolean {
    const running = this.programActive
    if (!this.cycleResume()) return false
    if (!running) return true
    this.events.onJobEvent?.('resumed', null)
    this.emitProgress()
    return true
  }

  stopJob(): void {
    const loaded = this.programActive || this.pendingProgram.length > 0
    // stoppedJobProgress() is the one place the pre-stop totals survive (a
    // re-arm continuation reads them from there) - jobProgress() itself must
    // go back to reporting nothing loaded, matching GRBL's own streamer
    // after a stop. WO-433: before this, programTotal/programSent/
    // programLine were never cleared here, so jobProgress().phase kept
    // reading 'ready' (loaded, startable) after a genuine Stop/Reset - a
    // lie, since pendingProgram is empty and startJob() would refuse.
    // Discovered live by operationSemanticProgress.wo382.test.tsx's
    // "Stop/Reset drops back to the line-only row" once WO-433 wired the
    // native simulator in.
    this.stoppedProgress = this.jobProgress()
    this.queue = this.queue.filter((m) => !m.program)
    // WO-2022: the planner anchor follows the dropped moves, as jogCancel's
    // does. Left at the stopped program's last target, a later Z-only Safe Z
    // (or a relative jog) built from it carried X and Y to that endpoint.
    this.lastEnqueuedTarget = this.queue.length > 0 ? this.queue[this.queue.length - 1].target : { ...this.pos }
    this.pendingProgram = []
    this.programActive = false
    this.programTotal = 0
    this.programSent = 0
    this.programLine = 0
    // A deliberate Stop/Reset fully clears the job, including a stale
    // 'failed' flag from an earlier abandoned run - 'empty' must win over it,
    // the same way the totals above do.
    this.programFailed = false
    this.executingMoveId = this.queue[0]?.id ?? null
    // WO-2863 (sweep G3): GRBL's Stop ends in a soft reset (grbl/controller.ts
    // stopJob), and a soft reset turns the spindle off. This one left it
    // turning, so Control read "10000 rpm" at Idle beside a lit Off button.
    // It stops here as reset() stops it; UCCNC's own stopJob is not this code.
    const spindleWasOn = this.spindleRunning || this.spindleRpm > 0
    this.spindleRunning = false
    this.spindleRpm = 0
    this.spindleTargetRpm = 0
    this.spindleRampRpmPerMs = 0
    if (spindleWasOn) {
      this.events.onAccessories?.({ spindle: 'off', flood: this.floodOn, mist: this.mistOn })
    }
    if (this.state !== 'alarm') this.setState('idle')
    if (!loaded) return
    this.events.onJobEvent?.('stopped', null)
    this.emitProgress()
  }

  stepJob(): boolean {
    if (this.phase !== 'connected' || this.state === 'alarm') return false
    // WO-433: a program that is LOADED but never started has nothing to
    // resume from HOLD - Step must be able to send its first line too (see
    // beginQueuedProgram's doc comment). Once a program is active, stepping
    // is exactly cycleResume() as before: singleBlock's own hold-after-each-
    // move logic (completeRunning) is what makes that resume advance only
    // one line before holding again.
    if (!this.programActive) return this.beginQueuedProgram()
    return this.cycleResume()
  }

  setSingleBlockMode(on: boolean): void {
    this.singleBlock = on
  }

  singleBlockMode(): boolean {
    return this.singleBlock
  }

  hasActiveJob(): boolean {
    return this.programActive
  }

  /**
   * Contract v2's StreamerProgress, which is a TEXT streamer's shape. This
   * controller consumes geometry, so:
   *  - "lines" are moves. `ackedLines`/`ackedSourceLine` are `programSent`/
   *    `programLine` - the count and id of moves that have ACTUALLY FINISHED
   *    executing: OUR ids - for a geometry-loaded program the caller's own
   *    move ids; for a text-loaded one (WO-428) the ACTUAL source line
   *    number, one move per sendable line, so this cursor is exact for the
   *    Program panel too.
   *  - `sentLines`/`sentSourceLine` are DISPATCHED, not acked - WO-433:
   *    v2's own doc used to claim "sent and acked in the same instant...
   *    sentLines === ackedLines", which was true only because nothing here
   *    ever tracked dispatch separately, not because there is genuinely no
   *    distinction. There is one: this class queues every move of a run in
   *    ONE synchronous pass (loadMoves/beginQueuedProgram), so the move now
   *    sitting at the front of `queue` - IF the machine is actually clear to
   *    run it (not held) - has been dispatched even though tick() has not
   *    yet finished animating it. `operatorTransport.ts`'s single-block
   *    re-enable gate (`job.ackedLines === job.sentLines`) and
   *    machineSession's onJobProgress throttle-edge comment ("the one sent
   *    line... catches... render immediately") were both written for
   *    exactly this split; collapsing it silently defeated both - Single
   *    Block's Step button queued its one move but sentLines stayed 0 until
   *    the move physically finished (which needs simulated real time a
   *    synchronous operator click never advances), discovered live by
   *    controlTabRegrid.test.tsx's "pressing Step sends exactly one program
   *    line" once WO-433 wired the native simulator into real UI tests.
   *  - bytesInFlight is 0, as the contract documents for anything that is not
   *    GRBL's byte budget.
   */
  jobProgress(): StreamerProgress {
    const inFlight = this.queue[0]
    const dispatching = inFlight?.program === true && this.state !== 'hold'
    return {
      phase: this.programPhase(),
      totalLines: this.programTotal,
      sentLines: dispatching ? this.programSent + 1 : this.programSent,
      ackedLines: this.programSent,
      ackedSourceLine: this.programLine,
      sentSourceLine: dispatching ? inFlight.id : this.programLine,
      bytesInFlight: 0,
    }
  }

  stoppedJobProgress(): StreamerProgress | null {
    return this.stoppedProgress ? { ...this.stoppedProgress } : null
  }

  private programPhase(): StreamerPhase {
    if (this.programFailed) return 'failed'
    if (this.programTotal === 0) return 'empty'
    if (this.programActive) return this.state === 'hold' ? 'paused' : 'streaming'
    if (this.programSent >= this.programTotal) return 'complete'
    return 'ready'
  }

  // ---- internal: motion queue ----

  private canJog(): boolean {
    return this.phase === 'connected' && this.state !== 'alarm' && this.state !== 'home'
  }

  private withinEnvelope(target: MachinePosition, addressedAxes: ReadonlyArray<AxisKey>): boolean {
    for (const axis of addressedAxes) {
      const env = this.envelope[axis]
      if (!env) {
        if (this.refusedAxes.has(axis)) return false
        continue
      }
      // WO-1143 parity: the same rounding slack preview and transfer review
      // grant (fitProgramToEnvelope), so a boundary move gets one verdict.
      if (target[axis] < env.min - ENVELOPE_FIT_TOLERANCE_MM
        || target[axis] > env.max + ENVELOPE_FIT_TOLERANCE_MM) return false
    }
    return true
  }

  /** WO-2024: give every program line/arc the average speed the cut-time
   *  planner says the machine reaches on it (plannedMoveDurationsMs - the same
   *  plan the op card's estimate sums), so the run's length matches the
   *  estimate. Geometry is untouched; only the pace changes. A program the
   *  planner cannot plan (a feedless move, an axis with no acceleration) keeps
   *  the commanded feed. */
  private paceByPlan(
    start: MachinePosition,
    source: readonly QueuedMove[],
    resolved: readonly RunningMove[],
    motion: CutTimeMotion,
  ): void {
    const moves: ToolpathMove[] = [{ type: 'rapid', x: start.x, y: start.y, z: start.z }]
    const owners: RunningMove[] = []
    for (let i = 0; i < resolved.length; i++) {
      const r = resolved[i]
      const at = { x: r.target.x, y: r.target.y, z: r.target.z, feed: r.feedMmMin }
      if (r.kind === 'arc' && r.arc) {
        moves.push({ ...at, type: r.arc.sweep > 0 ? 'arc_ccw' : 'arc_cw', cx: r.arc.centre.x, cy: r.arc.centre.y })
      } else if (r.kind === 'line') {
        const rapid = (source[i] as { rapid?: true }).rapid === true
        moves.push({ ...at, type: rapid ? 'rapid' : 'feed' })
      } else continue
      owners.push(r)
    }
    let durations: number[] | null
    try {
      durations = plannedMoveDurationsMs(moves, (m) => m.feed as number, motion)
    } catch {
      return
    }
    if (!durations) return
    for (let i = 1; i < moves.length; i++) {
      const r = owners[i - 1]
      const p = moves[i - 1]
      const length = r.arc
        ? r.arc.length
        : Math.hypot(moves[i].x - p.x, moves[i].y - p.y, moves[i].z - p.z)
      const ms = durations[i]
      if (length > 0 && ms > 0) r.paceMmMin = Math.min(r.feedMmMin, (length / ms) * 60000)
    }
  }

  private enqueueJog(target: MachinePosition, feedMmMin: number): void {
    this.lastEnqueuedTarget = target
    this.queue.push({ id: this.mintId(), kind: 'line', target, feedMmMin, program: false, asState: 'jog' })
    if (this.state === 'idle') this.setState('jog')
  }

  private mintId(): number {
    return this.nextSyntheticId--
  }

  /** Resolves a caller's QueuedMove into the absolute target this class
   *  animates toward, committing it as the new lastEnqueuedTarget (see
   *  resolveTarget for the pure computation shared with startJob's
   *  pre-flight envelope check). */
  private resolveMove(move: QueuedMove, opts: { program: boolean; asState: 'run' | 'jog' }): RunningMove {
    const from = { ...this.lastEnqueuedTarget }
    const target = resolveTarget(move, this.lastEnqueuedTarget)
    const specifiedTarget: Partial<MachinePosition> | undefined =
      move.kind === 'line' || move.kind === 'arc' ? move.to : undefined
    const specifiedAxes = specifiedTarget
      ? this.controlAxes
        .map(positionAxisKey)
        .filter((axis) => specifiedTarget[axis] !== undefined)
      : undefined
    this.lastEnqueuedTarget = target
    if (move.kind === 'arc') {
      // WO-1285: walk the circle. A degenerate arc (an end on its own centre)
      // has no circle to walk and animates as the line it amounts to.
      const radius = Math.hypot(from.x - move.centre.x, from.y - move.centre.y)
      if (radius > 1e-9) {
        const startAngle = Math.atan2(from.y - move.centre.y, from.x - move.centre.x)
        const endAngle = Math.atan2(target.y - move.centre.y, target.x - move.centre.x)
        const sweep = arcSweep(startAngle, endAngle, move.clockwise)
        const length = Math.hypot(Math.abs(sweep) * radius, target.z - from.z)
        return {
          id: move.id, kind: 'arc', target, feedMmMin: move.feedMmMin, ...opts,
          specifiedAxes,
          arc: { from, centre: { ...move.centre }, radius, startAngle, sweep, length, travelled: 0 },
        }
      }
      return { id: move.id, kind: 'line', target, feedMmMin: move.feedMmMin, specifiedAxes, ...opts }
    }
    if (move.kind === 'line') {
      return { id: move.id, kind: 'line', target, feedMmMin: move.feedMmMin, specifiedAxes, ...opts }
    }
    if (move.kind === 'dwell') {
      return { id: move.id, kind: 'dwell', target, feedMmMin: 0, seconds: move.seconds, ...opts }
    }
    return { id: move.id, kind: 'marker', target, feedMmMin: 0, ...opts }
  }

  private tick(): void {
    // WO-2024: read the clock on EVERY tick, before any early return, so time
    // spent homing, held or alarmed is never caught up as motion afterwards.
    let budgetMs = this.motionBudgetMs()
    // Spindle inertia is independent of axis motion, homing, holds and idle.
    this.tickSpindle()
    // WO-914: ONE AXIS PER SLOT, in the order the caller gave. The axis at the
    // front of the queue finishes, lands on its home position and shows up in
    // status().homed; only then does the next one start. That sequencing is
    // what makes "it homed in the order the definition asked for" something a
    // test can actually observe rather than assume.
    if (this.homingRemainingMs > 0) {
      this.homingRemainingMs -= TICK_MS
      if (this.homingRemainingMs <= 0) {
        const axis = this.homingQueue.shift()
        if (axis) {
          const key = positionAxisKey(axis)
          this.pos = { ...this.pos, [key]: this.homePosition[key] }
          this.homed = { ...this.homed, [axis]: true }
          this.lastEnqueuedTarget = { ...this.pos }
          this.homingDone.push(axis)
        }
        if (this.homingQueue.length > 0) {
          this.homingRemainingMs = this.homingPerAxisMs
        } else {
          // WO-930: nothing is asserted here. The cycle finishing is not a
          // claim about the machine - each axis already recorded ITSELF in
          // `this.homed` as its own slot ended, and `homedThisSession()` reads
          // that. A cycle of one axis therefore leaves the other two unhomed,
          // which is the truth.
          this.setState('idle')
          // Not null: unlike GRBL, this controller homes exactly the axes it
          // was asked for (capabilities.perAxisHoming) and knows which they
          // were - and now, in which order they finished.
          this.events.onHomed?.([...this.homingDone])
        }
      }
      return
    }
    if (this.state === 'hold' || this.state === 'alarm') return
    // WO-2024: motion is paid for in TIME, and time is not lost at a move
    // boundary. The old loop finished at most one move per 50 ms tick and threw
    // the rest of the tick away, so Full Suite Setup 1 Adaptive (9892 moves,
    // median 1.5 mm at F610) needed 24m24s of ticks for 18m57s of moves - and
    // a tick that fired late (a busy page) lost that time outright, which is
    // how the 09-26 rehearsal saw 2.2 moves/s. Now a tick spends the real time
    // since the last one (at least one TICK_MS, at most MAX_CATCH_UP_MS),
    // carrying what a finished move did not use into the next one. Each step
    // still moves at most one TICK_MS of travel, so the limit trip and an
    // arc's placement see the same granularity as before.
    for (;;) {
      const running = this.queue[0]
      if (!running) {
        if (this.state === 'run' || this.state === 'jog') this.setState('idle')
        this.executingMoveId = null
        return
      }
      this.executingMoveId = running.id
      const outcome = this.stepRunning(running, budgetMs)
      budgetMs -= outcome.usedMs
      if (!outcome.completed) return
      // Keep going only into the next queued move, only while running, and
      // never past a probe (its caller acts on the result before any more
      // motion) - hold, alarm, single block, M0 and job end all stop here. A
      // marker (an M-code/modal line) keeps the one tick it always had: a
      // controller spends time on those lines too, a program has a handful of
      // them, and callers observe the spindle/coolant change at that cadence.
      if (running.kind === 'probe' || running.kind === 'marker') return
      if (this.queue.length === 0) return
      if (this.state !== 'run' && this.state !== 'jog') return
      const next = this.queue[0]
      // A consecutive chain of zero-distance program blocks still has
      // controller cadence. Without this boundary, thousands of coincident
      // blocks can finish in one tick, cross a multipart boundary, and load
      // the next part before an operator fault can be observed (WO-1054). An
      // isolated zero before real travel costs no motion time.
      if (running.program && outcome.usedMs <= 1e-9 && this.isZeroDistanceMotion(next)) return
      if (outcome.usedMs > 1e-9 && this.changesSpecifiedAxes(running, next)) return
      if (budgetMs <= 1e-9) return
    }
  }

  private isZeroDistanceMotion(move: RunningMove): boolean {
    if (move.kind !== 'line') return false
    return this.controlAxes.every((axis) => {
      const key = positionAxisKey(axis)
      return Math.abs(move.target[key]! - this.pos[key]!) <= 1e-12
    })
  }

  /** A source block that omits an axis promises to hold it through that whole
   *  segment. Do not spend leftover tick time on a following block with a
   *  different explicit axis set: callers must be able to observe the first
   *  block settled before the newly named axes begin moving. */
  private changesSpecifiedAxes(completed: RunningMove, next: RunningMove): boolean {
    if (!completed.specifiedAxes || !next.specifiedAxes) return false
    if (completed.specifiedAxes.length !== next.specifiedAxes.length) return true
    return completed.specifiedAxes.some((axis, index) => axis !== next.specifiedAxes![index])
  }

  /** WO-2024: the time this tick may spend on motion. */
  private motionBudgetMs(): number {
    const now = Date.now()
    const elapsed = this.lastTickAt === null ? TICK_MS : now - this.lastTickAt
    this.lastTickAt = now
    return Math.min(MAX_CATCH_UP_MS, Math.max(TICK_MS, elapsed))
  }

  /** WO-2024: spend up to `budgetMs` on the move at the front of the queue.
   *  `completed` means it finished (and was shifted off the queue and
   *  completed); `usedMs` is the time it took. A stop that ends the tick (limit
   *  trip, probe contact, feed override 0) reports the whole budget used. */
  private stepRunning(running: RunningMove, budgetMs: number): { completed: boolean; usedMs: number } {
    if (running.kind === 'marker') {
      this.queue.shift()
      this.completeRunning(running)
      return { completed: true, usedMs: budgetMs }
    }
    if (running.kind === 'dwell') {
      this.setState(running.asState)
      const remaining = running.dwellRemainingMs ?? (running.seconds ?? 0) * 1000
      running.dwellRemainingMs = remaining - budgetMs
      if (running.dwellRemainingMs <= 0) {
        this.queue.shift()
        this.completeRunning(running)
        return { completed: true, usedMs: Math.max(0, remaining) }
      }
      return { completed: false, usedMs: budgetMs }
    }

    this.setState(running.asState)
    const mmPerMs = ((running.paceMmMin ?? running.feedMmMin) * this.feedOvr) / 100 / 60000
    if (!(mmPerMs > 0)) return { completed: false, usedMs: budgetMs }
    let usedMs = 0
    while (budgetMs - usedMs > 1e-9) {
      const stepMs = Math.min(TICK_MS, budgetMs - usedMs)
      const mmThisStep = mmPerMs * stepMs
      const dx = running.target.x - this.pos.x
      const dy = running.target.y - this.pos.y
      const dz = running.target.z - this.pos.z
      let complete: boolean
      let next: MachinePosition
      let travelledMm: number
      if (running.kind === 'arc' && running.arc) {
        // WO-1285: the same mm per step, spent along the circle instead of the
        // chord. The position is placed ON the arc, so the limit trip below
        // sees where the tool really is.
        const a = running.arc
        travelledMm = Math.min(Math.max(0, a.length - a.travelled), mmThisStep)
        a.travelled += mmThisStep
        complete = a.travelled >= a.length || a.length === 0
        const f = complete ? 1 : a.travelled / a.length
        const angle = a.startAngle + a.sweep * f
        next = complete
          ? { ...this.pos, ...running.target }
          : {
              ...this.pos,
              x: a.centre.x + a.radius * Math.cos(angle),
              y: a.centre.y + a.radius * Math.sin(angle),
              z: a.from.z + (running.target.z - a.from.z) * f,
            }
      } else {
        const deltas = this.controlAxes.map((axis) => {
          const key = positionAxisKey(axis)
          return { key, delta: running.target[key]! - this.pos[key]! }
        })
        const dist = Math.hypot(...deltas.map(({ delta }) => delta))
        complete = dist <= mmThisStep || dist === 0
        travelledMm = Math.min(dist, mmThisStep)
        next = { ...this.pos }
        if (complete) next = { ...next, ...running.target }
        else {
          for (const { key, delta } of deltas) {
            next[key] = this.pos[key]! + (delta * mmThisStep) / dist
          }
        }
      }

      if (running.kind === 'probe') {
        const contact = this.probeContactPoint(this.pos, next, dx, dy, dz)
        if (contact) {
          // MERGE, never replace: probeContactPoint returns a bare {x,y,z}, so
          // assigning it would delete every rotary coordinate - and finishProbe
          // re-bases the target from this position, so unlike a motion tick the
          // lost value never comes back (WO-1725 audit round 2).
          this.pos = { ...this.pos, ...contact }
          this.queue.shift()
          this.finishProbe(running, true)
          return { completed: true, usedMs: budgetMs }
        }
      }
      if (running.kind !== 'probe') {
        const limitTrip = this.firstMotionLimitTrip(next)
        if (limitTrip) {
          this.tripMotionLimit(limitTrip, next)
          return { completed: false, usedMs: budgetMs }
        }
      }
      this.pos = next
      usedMs += complete ? Math.min(stepMs, travelledMm / mmPerMs) : stepMs
      if (!complete) continue
      this.queue.shift()
      if (running.kind === 'probe') {
        this.finishProbe(running, false)
        return { completed: true, usedMs: budgetMs }
      }
      this.completeRunning(running)
      return { completed: true, usedMs }
    }
    return { completed: false, usedMs }
  }

  private firstMotionLimitTrip(next: MachinePosition): {
    kind: 'hard' | 'soft'
    axis: AxisKey
    side: 'minus' | 'plus'
    fraction: number
  } | null {
    const candidates: Array<{
      kind: 'hard' | 'soft'
      axis: AxisKey
      side: 'minus' | 'plus'
      fraction: number
    }> = []
    for (const axis of ['x', 'y', 'z'] as const) {
      const envelope = this.envelope[axis]
      const delta = next[axis] - this.pos[axis]
      if (!envelope || delta === 0) continue
      const side = delta < 0 ? 'minus' : 'plus'
      const boundary = side === 'minus' ? envelope.min : envelope.max
      const reachesBoundary = side === 'minus' ? next[axis] <= boundary : next[axis] >= boundary
      if (reachesBoundary && this.limitWiring[axis][side]) {
        candidates.push({
          kind: 'hard',
          axis,
          side,
          fraction: Math.max(0, Math.min(1, (boundary - this.pos[axis]) / delta)),
        })
      }
      const outside = side === 'minus' ? next[axis] < boundary : next[axis] > boundary
      if (outside) {
        candidates.push({
          kind: 'soft',
          axis,
          side,
          fraction: Math.max(0, Math.min(1, (boundary - this.pos[axis]) / delta)),
        })
      }
    }
    candidates.sort((a, b) => a.fraction - b.fraction
      || (a.kind === b.kind ? 0 : a.kind === 'hard' ? -1 : 1))
    return candidates[0] ?? null
  }

  private tripMotionLimit(trip: {
    kind: 'hard' | 'soft'
    axis: AxisKey
    side: 'minus' | 'plus'
    fraction: number
  }, next: MachinePosition): void {
    const running = this.queue[0]
    if (!running) return
    if (trip.kind === 'hard') {
      this.hardLimitTripped = { axis: trip.axis, side: trip.side }
      const stopped = { ...this.pos }
      for (const axis of this.controlAxes) {
        const key = positionAxisKey(axis)
        stopped[key] = this.pos[key]! + (next[key]! - this.pos[key]!) * trip.fraction
      }
      this.pos = stopped
    } else {
      this.pos = { ...next }
      this.softLimitTripped = true
    }
    this.abandonProgram()
    this.queue = []
    this.executingMoveId = null
    this.lastEnqueuedTarget = { ...this.pos }
    this.setState('alarm')
    this.flushAbandoned()
    const axis = trip.axis.toUpperCase()
    const message = trip.kind === 'hard'
      ? `${axis} ${trip.side === 'minus' ? 'negative' : 'positive'} limit switch was triggered `
        + 'at the end of declared travel. Motion was stopped.'
      : `${axis} ${trip.side === 'minus' ? 'negative' : 'positive'} soft limit was exceeded `
        + 'in motion. Motion was stopped.'
    this.events.onAlarm?.(null, message, false)
  }

  private completeRunning(running: RunningMove): void {
    let finished = false
    if (running.program) {
      this.programSent++
      this.programLine = running.id
      if (!this.queue.some((m) => m.program)) {
        this.programActive = false
        finished = true
      }
    }
    // WO-428: apply this line's M-code state change (spindle/coolant/pause),
    // if any, now that its move has actually completed - never earlier.
    const effect = this.lineEffects.get(running.id)
    if (effect) {
      this.lineEffects.delete(running.id)
      this.applyLineEffect(effect)
    }
    if (this.queue.length === 0) {
      this.executingMoveId = null
    } else if (running.program && this.singleBlock && this.queue.some((m) => m.program)) {
      this.setState('hold')
    }
    if (running.program) this.emitProgress()
    // The last program move finished with nothing left to run: that IS
    // completion here, since a software controller has no wire to drain.
    if (finished && !this.programFailed) this.events.onJobEvent?.('completed', null)
  }

  /** WO-428: M3/M4/M5/M7/M8/M9/M0's real effect, applied exactly once, when
   *  the line carrying it finishes executing (see LineEffect). */
  private applyLineEffect(effect: LineEffect): void {
    let accessoriesChanged = false
    if (effect.spindle) {
      this.spindleRunning = effect.spindle.on
      this.spindleDir = effect.spindle.dir
      this.beginSpindleRamp(effect.spindle.on
        ? (effect.spindle.rpm ?? this.spindleTargetRpm)
        : 0)
      accessoriesChanged = true
    }
    if (effect.coolant) {
      if (effect.coolant.flood !== undefined) this.floodOn = effect.coolant.flood
      if (effect.coolant.mist !== undefined) this.mistOn = effect.coolant.mist
      accessoriesChanged = true
    }
    if (effect.outputs) this.applyListedOutputWords(effect.outputs, '')
    if (accessoriesChanged) {
      this.events.onAccessories?.({
        spindle: this.spindleRunning ? this.spindleDir : 'off',
        flood: this.floodOn,
        mist: this.mistOn,
      })
    }
    if (effect.wcs) this.activeWcs = effect.wcs
    if (effect.tool !== undefined) this.toolNumber = effect.tool
    if (effect.pause && this.state !== 'alarm') this.setState('hold')
  }

  private finishProbe(running: RunningMove, success: boolean): void {
    this.lastProbe = { ok: success, at: success ? { ...this.pos } : null }
    // WO-433: a probe move's QUEUED target (set eagerly when the line was
    // parsed - see the G38.2 branch of executeMdiLine and the native probe()
    // method above) is the FULL requested travel, which is exactly what a
    // probe is allowed to never reach: a contact stops it early. Without this
    // correction, lastEnqueuedTarget kept claiming the machine had travelled
    // the whole commanded distance, so the very next relative move (the
    // retract-then-fine-pass sequence executeDirectionalProbeTouch always
    // sends) computed its target from that phantom overshoot instead of the
    // real contact point - discovered live, end to end, by
    // simulatedProbeSurfaces.wo416.test.ts once WO-433 actually wired this
    // path in: the retract undershot, so the fine pass never reached the
    // surface at all ("fine pass lost contact"). this.pos IS the true
    // machine position whether this was a contact (early stop) or a miss
    // (ran the full programmed distance) - always the correct new base.
    this.lastEnqueuedTarget = { ...this.pos }
    // WO-434: onOffset('PRB', ...) - ported from SimulatedGrblTransport's
    // [PRB:...] line, which is emitted for a miss exactly like a contact
    // (current position, success flag 0/1). This is what
    // executeDirectionalProbeTouch (machineSession.ts) reads out of
    // store().probe after its sendCommandAwait resolves.
    this.events.onOffset?.({
      label: 'PRB',
      values: [this.pos.x, this.pos.y, this.pos.z],
      probeSuccess: success,
    })
    const resolve = this.probeResolvers.get(running.id)
    this.probeResolvers.delete(running.id)
    resolve?.(this.lastProbe)
    const mdiResolve = this.mdiProbeAwaiters.get(running.id)
    this.mdiProbeAwaiters.delete(running.id)
    if (success || running.probeMissAllowed) {
      mdiResolve?.({ ok: true, message: null })
      this.completeRunning(running)
    } else {
      // A missed probe alarms and drains the queue, so a program riding on
      // top of it did not finish - say so rather than let it read 'ready'.
      this.abandonProgram()
      this.queue = []
      this.executingMoveId = null
      this.setState('alarm')
      // Events last, with the queue already drained (see abandonProgram).
      this.flushAbandoned()
      const message = 'The probe reached the end of its travel without touching off.'
      mdiResolve?.({ ok: false, message })
      this.events.onAlarm?.(null, message, false)
    }
  }

  /** A cleared queue means the loaded program cannot continue. Anything that
   *  drains motion (e-stop, reset, probe alarm) goes through here so
   *  jobProgress().phase never claims a cut-short run completed.
   *
   *  WO-433: only an ACTUALLY RUNNING program (`programActive`) can become
   *  'failed' - a program that was merely LOADED (armed via loadJob/loadMoves)
   *  but never started has nothing to call a failed run, and clearing it here
   *  must read the same as GRBL's own reset wiping an unstarted streamer:
   *  genuinely EMPTY (totals zeroed), not 'ready' (which would claim a
   *  since-cleared program can still be started - it cannot, startJob()
   *  already refuses on an empty pendingProgram) and not 'failed' (which
   *  claims a run was cut short when none ever began). Discovered live by
   *  machineControlSafety.test.tsx's "a failed plan with nothing armed does
   *  not conjure a sendable job" once WO-433 wired the native simulator in -
   *  the old wasLoaded (active OR pending) test conflated the two cases. */
  /** Drop the homing cycle in flight, if any. Axes already homed keep their
   *  positions and their `homed` flags - they really did reach their switches
   *  - but the cycle raises no `onHomed` and does not claim the session is
   *  homed, because it did not finish. */
  private abandonHoming(): void {
    this.homingQueue = []
    this.homingDone = []
    this.homingRemainingMs = 0
  }

  private abandonProgram(): void {
    const wasRunning = this.programActive
    const hadPending = this.pendingProgram.length > 0
    this.programActive = false
    this.pendingProgram = []
    if (!wasRunning) {
      if (hadPending) {
        this.programTotal = 0
        this.programSent = 0
        this.programLine = 0
      }
      return
    }
    this.programFailed = true
    // DEFERRED, not raised here. Every caller of this is a stop path, and no
    // subscriber may run between "the program is abandoned" and the queue
    // actually being drained - a listener that throws would leave the machine
    // stopping half-way. The caller flushes once the stop work is done.
    this.pendingAbandonFault = {
      // Software controller: no firmware code, and it queues GEOMETRY, so it
      // knows which MOVE was executing, not which line of text. Contract v3
      // carries both fields for exactly this split.
      code: null,
      message: 'Motion was abandoned before the program finished.',
      line: null,
      moveId: this.executingMoveId,
    }
  }

  /** Raise whatever `abandonProgram` deferred. Called LAST on every stop path,
   *  after the machine is already stopped. */
  private flushAbandoned(): void {
    const fault = this.pendingAbandonFault
    if (!fault) return
    this.pendingAbandonFault = null
    this.events.onJobEvent?.('failed', fault)
    this.emitProgress()
  }

  // ---- internal: status/state plumbing ----

  private setState(next: MachineState): void {
    if (this.state === next) return
    const wasIdle = this.state === 'idle'
    this.state = next
    if (wasIdle !== (next === 'idle')) this.scheduleStatusTimer()
  }

  private scheduleStatusTimer(): void {
    if (this.statusTimer !== null) clearInterval(this.statusTimer)
    const interval = this.state === 'idle' ? STATUS_MS_IDLE : STATUS_MS_MOVING
    // WO-433: emit the FIRST status of a new state immediately.
    // setInterval's own first callback only fires after a full `interval`
    // elapses, which left every caller of the store (and every UI gate that
    // reads machineState) seeing a STALE reading for up to 500ms after every
    // idle<->moving edge - including the very first one, at connect
    // ('unknown', the pre-connect default, persisting well past when
    // connectMachine's promise had already resolved). A software controller
    // has no reason to make callers wait out an artificial poll cadence for
    // news it already knows synchronously. Discovered live: connecting,
    // resetting the E-STOP interlock and loading a program (a real operator
    // flow, and controlTabRegrid.test.tsx / ProgramPanel.mcTier1.test.tsx's
    // own connect helpers) left machineState 'unknown' rather than 'idle',
    // so CYCLE START read disabled ("Wait for the machine to become idle")
    // even though the machine genuinely was.
    this.events.onStatus?.(this.status())
    this.statusTimer = setInterval(() => this.events.onStatus?.(this.status()), interval)
  }

  private emitProgress(): void {
    this.events.onJobProgress?.(this.jobProgress())
  }

  private parserState(): GrblParserState {
    return {
      wcs: this.activeWcs,
      // WO-434: reflects the MDI path's own persistent modal state (a
      // program load never touches these instance fields - its own
      // scale/distanceMode are local and discarded per parseProgramLines
      // call), so an operator-typed G20/G91 shows up here honestly.
      units: this.mdiUnitsScale === 25.4 ? 'inch' : 'mm',
      distanceMode: this.mdiDistanceMode,
      motionMode: 'G0',
      tool: this.toolNumber,
      spindle: this.spindleRunning ? this.spindleDir : 'off',
      coolant: this.floodOn ? 'flood' : this.mistOn ? 'mist' : 'off',
      feed: 0,
      spindleRpm: this.spindleRpm,
    }
  }

  // ---- WO-428: text-path G-code interpreter --------------------------------
  //
  // Parses already-stripped, already-numbered lines (text.ts's prepareProgram
  // did the comment-stripping and line accounting - not duplicated here) into
  // the same QueuedMove[] loadMoves takes, PLUS a LineEffect per line that
  // carries a real M-code. One QueuedMove per sendable line - even a
  // non-motion line (WCS select, spindle, M0/M6/M30) becomes a 'marker' - so
  // jobProgress().ackedSourceLine visits every line in order, exactly like a
  // real text streamer's cursor, and the Program-panel can trust it. A canned
  // drill cycle's hole (WO-2687) is the one line that becomes SEVERAL moves,
  // all carrying that line's id - the moves the controller makes for it.
  //
  // Position is tracked with a local, throwaway shadow (`pos`) seeded from
  // lastEnqueuedTarget: nothing here commits to instance state. The parse can
  // therefore run (and fail loud) entirely before any of it is queued.

  private parseProgramLines(lines: StreamLine[]) {
    const notices: string[] = []
    const parsed = parseSimulatedProgramLines(lines, this.setupLoadPreparationInput(), notices)
    for (const text of notices) this.events.onConsole?.({ dir: 'rx', text, severity: 'warn' })
    return parsed
  }

}

// ---- module-private helpers ------------------------------------------------

function compact(to: Partial<MachinePosition>): Partial<MachinePosition> {
  const out: Partial<MachinePosition> = {}
  for (const axis of ['x', 'y', 'z', 'a', 'b', 'c'] as const) {
    if (to[axis] !== undefined) out[axis] = to[axis]
  }
  return out
}

/** Pure: where a QueuedMove's target lands given the position it starts from.
 *  Shared by SimulatedController.resolveMove (which commits the result as the
 *  new lastEnqueuedTarget) and startJob's pre-flight envelope check (which
 *  must walk the whole program WITHOUT committing anything until every move
 *  in it is known to fit the declared travel). */
function resolveTarget(move: QueuedMove, from: MachinePosition): MachinePosition {
  if (move.kind === 'line') return { ...from, ...compact(move.to) }
  if (move.kind === 'arc') return { ...from, ...move.to }
  return { ...from } // dwell / marker: no motion
}

/** Offset rows use the canonical axis indexes. A sparse B/C definition keeps
 * zero placeholders for omitted earlier rotary axes instead of shifting. */
function machinePositionValues(position: MachinePosition): number[] {
  const values = [position.x, position.y, position.z]
  const rotary = [position.a, position.b, position.c]
  let last = rotary.length - 1
  while (last >= 0 && rotary[last] === undefined) last -= 1
  for (let index = 0; index <= last; index += 1) values.push(rotary[index] ?? 0)
  return values
}


