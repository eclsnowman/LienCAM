// MachineController - LienCAM's own machine-control language.
//
// Everything above this line (machineSession, the Control page, arming, the
// e-stop interlock, probing, step-back) talks to THIS, never to a firmware
// protocol. Backends translate outward:
//
//   GrblController     -> GRBL 1.1 text over a byte pipe (serial / websocket)
//   UccncController    -> UC100 / AXBB-E calls, over the local bridge
//   SimulatedController-> pure software, no protocol at all
//
// Rationale and the alternatives considered: ADR-0041.
//
// Two rules shaped this file, and both are load-bearing:
//
// 1. SIGNATURES FOLLOW THE WORKING IMPLEMENTATION. Almost every member here is
//    transcribed from GrblController as it already exists, deliberately, so the
//    GRBL backend needs no behaviour change to satisfy it. Only genuinely
//    firmware-specific members were renamed or replaced (grblVersion ->
//    firmwareVersion; overrideByte -> setOverride). Inventing a "nicer" shape
//    here would mean rewriting a proven backend for no gain.
//
// 2. NO LOWEST COMMON DENOMINATOR. Controllers differ in what they can do, so
//    the interface exposes `capabilities` and callers ask. A backend that can
//    accept toolpath geometry directly says so; one that can only take G-code
//    text says that instead. The abstraction must not hold a good controller
//    down to a poor one's limits - that was the whole reason for ADR-0041.

import type {
  GrblParserState,
  GrblStatusReport,
  MachinePosition,
  MachineState,
  MachineVec3,
  WcsId,
} from './types'
import type { LoadResult, StreamLine } from '../gcode/text'
import type { PathFidelityReport } from './pathFidelity'
import type { AxisName, ControllerDefinition } from '../../types'
import { DEFAULT_HOMING_ORDER } from '../../types'
import type { BridgeDefinitionDriftEntry, BridgeDefinitionSource, BridgeHelloPush } from './bridgeTransport'

/**
 * Progress through a loaded program. Owned by the CONTRACT, not by GRBL's
 * streamer, so every backend reports the same shape - `grbl/streamer.ts`
 * imports it from here.
 *
 * Contract v2 (2026-08-21): this was originally declared as a trimmed
 * `{sent, total, line}`, which no backend actually returns and which four live
 * callers would have lost fields to. The phase words were invented too - the
 * real ones are below, read out of the streamer. ADR-0041 rule 1 says
 * signatures follow the working implementation; this is that rule being obeyed
 * after the fact, twice.
 */
export type StreamerPhase =
  | 'empty' // nothing loaded
  | 'ready' // loaded, not started
  | 'streaming' // actively keeping the buffer full
  | 'paused' // user pause: stop filling (in-flight lines still execute/ack)
  | 'failed' // halted on error; no further fill
  | 'complete' // every line acked

export interface StreamerProgress {
  phase: StreamerPhase
  totalLines: number
  sentLines: number
  ackedLines: number
  /** Source line (1-based) of the most recently ACKED line; 0 before any ack. */
  ackedSourceLine: number
  /** Source line of the most recently SENT line; 0 before any send. */
  sentSourceLine: number
  /** GRBL-only: bytes against its 128-byte RX budget. Backends with no byte
   *  budget - anything with a real move buffer - report 0. */
  bytesInFlight: number
}

/** Who explicitly chose one machine-definition value that differs from the
 * profile. The bridge persists this declaration per drift key; it never
 * infers authorship from the fact that a value arrived over this interface. */
export interface MachineDefinitionProvenanceEntry {
  kind: 'liencam-ui' | 'operator'
  source: string
}

export type MachineDefinitionProvenance = Record<string, MachineDefinitionProvenanceEntry>

/**
 * Session facts published by a message bridge. Optional on MachineController:
 * a backend declares this capability by implementing `bridgeHello`, without a
 * caller naming the concrete controller class that happens to provide it.
 */
export interface ControllerBridgeHello {
  readOnly: boolean
  vfd: NonNullable<BridgeHelloPush['v']['vfd']> | null
  uccnc: BridgeHelloPush['v']['uccnc']
  definitionSource?: BridgeDefinitionSource
  definitionDrift?: BridgeDefinitionDriftEntry[]
  workOffsets?: BridgeHelloPush['v']['workOffsets']
}

/** Readback from a controller that can hold a gantry-squaring measurement. */
export interface ControllerSkewApplyResult {
  ok: boolean
  error: string | null
  set: boolean
  offsetMm: number | null
}

/** Connection lifecycle, as the store already models it. */
export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected'

/** Cartesian axes used by probing and existing automatic coordinate moves. */
export type JogAxis = 'X' | 'Y' | 'Z'

/** Every standard machine axis the control surface can address. A/B/C are
 * rotary coordinates and their values, jog distances and feeds are degrees. */
export type ControlAxis = AxisName

/** Definition-enabled axes that are independently controllable. A slave axis
 * is enabled at the controller because its motor moves, but it is not an
 * independent coordinate (Operator's enabled A follows Y), so it must not grow a
 * second jog/DRO/zero/offset control. */
export function enabledControlAxes(
  definition: ControllerDefinition | null | undefined,
): ControlAxis[] {
  if (!definition) return ['X', 'Y', 'Z']
  const enabled = definition.axes.filter((axis) => axis.enabled)
  const slaves = new Set(enabled.map((axis) => axis.slaveAxis).filter((axis): axis is AxisName => axis !== null))
  return enabled.filter((axis) => !slaves.has(axis.axis)).map((axis) => axis.axis)
}

export function isRotaryAxis(axis: ControlAxis): axis is Extract<ControlAxis, 'A' | 'B' | 'C'> {
  return axis === 'A' || axis === 'B' || axis === 'C'
}

/**
 * THE HOMING ORDER, RESOLVED. THIS IS THE ONLY FALLBACK IN THE PRODUCT.
 *
 * WO-914. Every machine now carries its homing order in its
 * `ControllerDefinition`, and every existing profile carries none, because
 * WO-912 made the field optional. So the fallback is the COMMON path, not the
 * edge case, and it is a safety default rather than a preference:
 *
 *   Homing Z last on a router with a tool in the spindle drives the tool
 *   through the work on its way to the X or Y switch. Z first is the only
 *   order that cannot do that.
 *
 * The fallback VALUE lives in exactly one place - `DEFAULT_HOMING_ORDER` in
 * `src/types/index.ts` - and this is the only function that reaches for it.
 * **Do not write `['Z', 'X', 'Y']` anywhere else.** The defect WO-914 exists
 * to remove is precisely that literal existing in more than one file, where a
 * reader cannot tell which copy ran.
 *
 * We fall back rather than refuse deliberately: refusing would brick homing
 * for every profile that exists today, on the day it landed. Falling back
 * preserves exactly today's proven behaviour on Operator's machine.
 *
 * The bridge has NO copy of this and never invents an order - see
 * `Machine.Home()`, which refuses instead. The app decides; the wire carries
 * the decision; the far end obeys or refuses.
 */
export function resolveHomingOrder(
  definition: ControllerDefinition | null | undefined,
): AxisName[] {
  const order = definition?.homing?.order
  if (order && order.length > 0) return [...order]
  return [...DEFAULT_HOMING_ORDER]
}

/**
 * THE AXES A "HOME THE MACHINE FIRST" GATE IS ABOUT (WO-930).
 *
 * X, Y and Z: the axes this product moves by MACHINE COORDINATE - safe Z,
 * park, the material-fit trace, every automatic probe cycle. A machine
 * coordinate on an axis with no datum is a number with no meaning, which is
 * the whole reason those gates exist.
 *
 * Deliberately not "every axis the definition names": nothing in this product
 * issues these existing automatic G53 moves on A/B/C. Adding rotary axes here
 * would make every gate refuse on a 4-axis machine for an axis no gate is
 * about - a new refusal, which this order forbids.
 */
export const HOMED_GATE_AXES: readonly JogAxis[] = ['X', 'Y', 'Z']

/**
 * Which of `axes` do NOT have a datum this session - empty when all do.
 *
 * WO-930. This is the honest question, and the one a gate should ask: a
 * caller that moves Z alone asks about Z, a caller that parks in XY at a safe
 * Z asks about all three. `homedThisSession()` is the same question asked
 * about `HOMED_GATE_AXES`, and every backend's answer to it is defined that
 * way.
 *
 * NEVER MORE PERMISSIVE THAN THE FLAG IT REPLACED. A backend that cannot
 * answer per axis falls back to `homedThisSession()` for every axis, so it
 * behaves exactly as before. A backend that CAN answer only ever reports an
 * axis homed when a cycle covering that axis actually completed, which is a
 * subset of the old "any cycle completed" flag.
 */
export function unhomedAxes(
  ctrl: Pick<MachineController, 'homedThisSession' | 'homedAxesThisSession'>,
  axes: readonly JogAxis[] = HOMED_GATE_AXES,
): JogAxis[] {
  const perAxis = typeof ctrl.homedAxesThisSession === 'function'
    ? ctrl.homedAxesThisSession()
    : null
  if (!perAxis) return ctrl.homedThisSession() ? [] : [...axes]
  return axes.filter((axis) => perAxis[axis] !== true)
}

/** "X and Y" / "Y" / "X, Y and Z" - for a refusal that NAMES what is missing,
 *  because "home the machine first" after homing an axis reads as a bug to the
 *  operator standing at the machine. */
export function describeAxisList(axes: readonly ControlAxis[]): string {
  if (axes.length === 0) return ''
  if (axes.length === 1) return axes[0]
  return `${axes.slice(0, -1).join(', ')} and ${axes[axes.length - 1]}`
}

/** The three override channels every controller in scope supports. */
export type OverrideKind = 'feed' | 'rapid' | 'spindle'

/** How an override is nudged. GRBL only accepts fixed steps and a reset;
 *  richer controllers accept an absolute percentage. `setOverride` takes both
 *  so a backend can serve whichever it actually has. */
export type OverrideChange =
  | { kind: OverrideKind; to: 'reset' }
  | { kind: OverrideKind; to: 'percent'; percent: number }
  | { kind: OverrideKind; to: 'step'; direction: 1 | -1; coarse: boolean }

/**
 * What a backend can actually do. Callers branch on these rather than assuming.
 * A field being false is a statement about the CONTROLLER, not about LienCAM.
 */
export interface ControllerCapabilities {
  /** Accepts id-tagged geometry directly, with no G-code round trip
   *  (UC100 AddLinearMove/AddCircularMove). False for GRBL, which can only be
   *  fed text. This is the capability ADR-0041 exists to preserve. */
  geometryQueue: boolean
  /** Reports which queued move is executing, by the id WE assigned - so
   *  progress, run-from-here and step-back are exact rather than inferred. */
  executingMoveId: boolean
  /** Reports buffer occupancy as a duration rather than a byte count. */
  bufferSeconds: boolean
  /** Accepts G-code TEXT: `sendCommand`, `loadJob`, `loadJobFrom`. False for a
   *  controller with no interpreter of its own - the AXBB-E has none, so its
   *  only program route is `loadMoves`. Contract v2: the text path was
   *  originally documented as universal. It is not; two independent backends
   *  refused it. */
  gcodeText: boolean
  /** Can home individual axes rather than only running the whole cycle. */
  perAxisHoming: boolean
  /** Spindle is driven by this controller. False when it lives on a separate
   *  link, e.g. a Modbus VFD, in which case spindle commands go elsewhere. */
  ownsSpindle: boolean
  /** Accepts `spindleOn`/`spindleOff`/`spindleResetFault` as CALLS, rather
   *  than as `M3`/`M5` text. Orthogonal to `ownsSpindle`, which says where the
   *  spindle physically lives, and to `gcodeText`, which is the other route to
   *  it - so the three answer different questions and a reader picks a route:
   *  calls if this is true, else text if `gcodeText`, else no spindle control.
   *
   *  WO-905, found at the machine 2026-08-22: the AXBB path had NEITHER. App
   *  spindle control was entirely `M3`/`M5` text, that backend refuses text,
   *  and the bridge's own spindle calls were reachable by nothing - so on a
   *  machine whose spindle we had just run to 24,000 RPM the product had no
   *  way to start it. Overloading `ownsSpindle` would have said the AXBB
   *  drives the spindle, which is false: it is a Modbus inverter on its own
   *  serial link, which is exactly why that flag is false there. */
  spindleCommands: boolean
  /**
   * Can EXECUTE a `MachineProgram` - motion steps and action steps, in one
   * ordered run, under one job state machine (ADR-0043 section 4).
   *
   * WO-1023 built the types; **no backend in this build can run one yet**, so
   * no backend sets this today and every reader gets `false`. It flips, one
   * backend at a time, in the order that teaches that backend's queue the
   * action step kinds - never before, because a `true` here is a promise that
   * `loadProgram` will return `{ ok: true }`, and both implementations
   * currently refuse by design.
   *
   * OPTIONAL, and absent means false. Two reasons, and the first is binding:
   * every existing backend's capability object is pinned by an exact-shape
   * `toEqual` assertion in a test this order does not own
   * (`grblControllerContract.wo418`, `simulatedController.wo420`,
   * `uccncController.wo421`), so a required field - or an optional one that
   * any backend sets to `false` - would fail three existing tests to say
   * something the reader already gets from absence. The second: this field
   * also arrives from the bridge's `hello` frame, and an old bridge sends no
   * such key, which must mean "cannot run a program" rather than a type error.
   *
   * Read it as `capabilities.machineProgram === true`, never as
   * `!capabilities.machineProgram === false`. To ask instead whether a backend
   * can REPORT id-shaped progress - a read, not an execution - ask
   * `typeof ctrl.programProgress === 'function'`, the same way callers already
   * ask about `applyMachineDefinition`.
   */
  machineProgram?: boolean
  /**
   * HOW MANY MOTION STEPS FORM A PREFERRED STATIONARY PROGRAM PART. Above it
   * the app splits at rapids when it can; a continuous cut stays one logical
   * program and a streaming backend bounds its own in-flight occupancy.
   *
   * MEASURED, NOT GUESSED (WO-1044; Operator's machine, 2026-08-26, Operator present,
   * `src/tests/evidence/CHORD-AB-2026-08-26/`): the AXBB-E through the bridge
   * executes `moveCount mod 4096` of a staged program. 4274 moves accepted ->
   * 178 executed; 6284 -> the remainder. The board ACCEPTS every move, reports
   * buffer-full ZERO times, and executes the wrong number. WO-1081 moves that
   * defence into the live stream: CurrentID acknowledgements replenish a
   * bounded window before the ring can wrap.
   *
   * OPTIONAL. When absent, `resolveMaxProgramMoves` supplies the conservative
   * default rapid-boundary part size. A REQUIRED field would fail three
   * exact-shape capability tests this order does not own
   * (`grblControllerContract.wo418`, `simulatedController.wo420`,
   * `uccncController.wo421`) to say what absence already says.
   *
   * ADVERTISED BY THE BRIDGE `hello` WHEN IT HAS ONE: the hello frame's
   * `capabilities` block IS this type and `UccncController` adopts it whole,
   * so a bridge that learns its board's real ceiling reports it here and the
   * app follows it without a release. Until it does, 4095 stands.
   *
   * Only meaningful beside `machineProgram`/`geometryQueue`: a text controller
   * streams lines and has no staged move list to overflow.
   */
  maxProgramMoves?: number
  /** True only when the geometry backend meters one logical program through a
   * bounded in-flight move window and reports original move ids as it runs. */
  pacedMoveStreaming?: boolean
  /**
   * ADR-0054 item 4: the axis-to-joint mapping on this controller is NOT one
   * joint per Cartesian axis - a slaved gantry (two joints behind Y, as on
   * Operator's machine) or non-trivial kinematics. A caller that needs a joint
   * fact (squaring, per-side homing) asks `status.joints` instead of reading
   * it off `machinePos` or `homed`, which stay Cartesian (ADR-0041 rule 2).
   *
   * OPTIONAL, and absent means the backend makes no such claim - read it as
   * `capabilities.nonIdentityJoints === true`. Same reason as
   * `machineProgram`: the three exact-shape capability tests
   * (`grblControllerContract.wo418`, `simulatedController.wo420`,
   * `uccncController.wo421`) pin every existing backend, and none of them has
   * to implement this on the day it lands.
   */
  nonIdentityJoints?: boolean
}

/** One move in LienCAM's own terms. Ids are OURS - mint them per operation,
 *  per pass, per anything - and come back in `status.executingMoveId`. */
export type QueuedMove =
  | {
      id: number
      kind: 'line'
      /** Absolute endpoint coordinates. XYZ are millimetres; A/B/C are
       * degrees. Omitted axes retain their current coordinate. */
      to: Partial<MachinePosition>
      feedMmMin: number
      /**
       * This line was a RAPID in the operation that produced it (ADR-0043
       * section 3, "Rapids"). Additive and optional, and deliberately
       * `true`-only: there is no `rapid: false`, because a move that is not
       * marked is simply a feed move, and a tri-state would invite a backend
       * to treat "absent" as a third thing.
       *
       * It carries NO feed of its own and changes no motion: the bridge
       * refuses a move without a feed (`Bridge.cs:2382`), so the builder
       * still resolves a real number from the machine definition's declared
       * rapid rate and puts it in `feedMmMin`. **This flag never becomes a
       * feed and never licenses inventing one** - it exists so instruments
       * (path fidelity, the operator readout, a simulator) can tell a
       * positioning move from a cutting move after the fact, which
       * `feedMmMin` alone cannot say.
       *
       * Every backend that exists today IGNORES it, and must keep accepting a
       * move that carries it - that is what makes it additive.
       */
      rapid?: true
    }
  | {
      id: number
      kind: 'arc'
      /**
       * Where the arc ENDS, all three axes.
       *
       * `to.z` MAY DIFFER FROM WHERE THE ARC STARTED, and when it does this
       * step is a HELIX (WO-1337). That is not a new field and not a new wire:
       * the bridge has always submitted an arc as
       * `UC100.AddCircularMoveP(X, Y, Z, CX, CY, CZ, !clockwise, feed, plane,
       * id, nextId)` - an endpoint Z has been in that call since WO-1019, and
       * until WO-1337 the builder simply refused to let it be anything but the
       * start's. A reader may therefore NOT assume `to.z` equals the previous
       * step's z, and one that interpolates an arc has to spend its Z over the
       * sweep (both `simulatedController` and `pathFidelity` already do:
       * length is `hypot(|sweep| * radius, dz)`, and Z advances with the same
       * fraction that walks the circle).
       *
       * No helix has yet run on the real board; that gate is a session item on
       * WO-1337 (an air-run fixture measuring the swept angle and the Z ramp),
       * not a condition of this type.
       */
      to: MachineVec3
      /**
       * The axis the arc turns about. Its X/Y define the circle; its Z is
       * carried at the endpoint's Z and defines nothing - an XY arc turns about
       * an axis parallel to Z, on which no point is more the centre than any
       * other. A backend must never read `centre.z` as a second opinion about
       * where the move ends: `to.z` is the only Z that steers the machine.
       */
      centre: MachineVec3
      clockwise: boolean
      plane: 'xy' | 'xz' | 'yz'
      feedMmMin: number
    }
  | { id: number; kind: 'dwell'; seconds: number }
  /** Sets the executing id without producing motion. Needed on connect: some
   *  controllers report a stale id from a previous session until something
   *  advances it (see uccnc-control-plan.md section 12.3). */
  | { id: number; kind: 'marker' }

/**
 * A dwell, as a program step. **The same type as the `QueuedMove` dwell, not a
 * copy of it** (WO-1023): a dwell is already expressible in the motion
 * vocabulary, and a second `{ kind: 'dwell' }` member with its own shape is
 * exactly how two lists of the same thing start. Aliased here so a reader of
 * `MachineAction` can see that dwell is covered without going looking.
 */
export type DwellStep = Extract<QueuedMove, { kind: 'dwell' }>

/**
 * A machine ACTION - everything a program does that is not motion.
 *
 * WO-1023, the type the boundary section of `docs/ARCHITECTURE.md` calls "THE
 * MISSING TYPE". Until this existed, an action was TEXT
 * (`builtinDefaultLines(controller, action): string[]`), which a controller
 * with no G-code interpreter can only satisfy dishonestly - and that dishonesty
 * is the root of the leak catalogue in
 * `docs/ARCHITECTURE-AUDIT-2026-08-26.md`. `ToolpathMove` already lets geometry
 * cross a boundary without naming a controller; this is the same thing for the
 * other half of a program.
 *
 * TWO RULES, both load-bearing, both enforced by
 * `src/tests/machine/machineProgramTypes.wo1023.test.ts`:
 *
 * 1. **No member carries G-code text.** Not a line, not a word, not an M-code
 *    number. Rendering an action into a dialect is a TEXT BACKEND's job (the
 *    action-table collapse in a successor order turns `builtinDefaultLines`
 *    into a renderer OF this type). A `MachineAction` that carried `M8` would
 *    have decided the dialect at the point the program was built, which is the
 *    leak, one level up.
 * 2. **No member carries a controller name.** No `'grbl'`, no `'uccnc'`, no
 *    "which backend is this for". Every difference between backends is a
 *    `ControllerCapabilities` value (ADR-0043 section 1).
 *
 * Shaped by the DOMAIN, not by the first caller: the members below are the ones
 * ADR-0021 gives the file post, transcribed as intents rather than as the
 * G-code the post emits for them. A member missing here would force its caller
 * back onto text.
 *
 * NEVER INVENT A MACHINE FACT. Every number an action needs is a REQUIRED
 * field: no default rpm, no default feed, no default WCS, no optional
 * "assume flood". A caller that does not know the number cannot build the step,
 * which is the refusal ADR-0003 asks for.
 */
export type MachineAction =
  /** Start the spindle at a REAL speed in RPM - never a register word, never a
   *  percentage (see `MachineController.spindleOn`, same rule). */
  | { id: number; kind: 'spindle'; direction: 'cw' | 'ccw'; rpm: number }
  /** Stop the spindle. A separate member rather than `rpm: 0`, so that "off"
   *  cannot be spelled two ways and no renderer has to guess which zero means
   *  stop. */
  | { id: number; kind: 'spindle'; direction: 'off' }
  /** One coolant channel. `air` is a channel in its own right - a mist output
   *  wired to an air blast is a different machine fact from mist. */
  | { id: number; kind: 'coolant'; channel: 'flood' | 'mist' | 'air'; on: boolean }
  /** See `DwellStep`: the motion vocabulary's dwell, not a second one. */
  | DwellStep
  /** Change to `toolNumber`. `description` is what the operator reads at the
   *  machine ("6mm 3-flute flat"), and is `null` - never `''` - when the
   *  project has none, because "no description" and "an empty description"
   *  are different facts. The step is what the guided tool-change flow keys
   *  off; nothing downstream may go back to scanning text for `M6`. */
  | { id: number; kind: 'toolChange'; toolNumber: number; description: string | null }
  /** Apply a tool length offset, as a DELTA in millimetres. Not a register
   *  number: which register holds it is the controller's business. */
  | { id: number; kind: 'toolLengthOffset'; deltaMm: number }
  /** Select the work coordinate system this program runs under (G54..G59 on a
   *  text backend; the bridge's `activeWcs` on the geometry path). */
  | { id: number; kind: 'workOffset'; op: 'select'; wcs: WcsId }
  /** Write one axis of one work offset register (ADR-0020 per-stock offsets;
   *  G10 L2 on a text backend). `valueMm` is the value to WRITE, in the
   *  machine frame the register itself is in. */
  | { id: number; kind: 'workOffset'; op: 'write'; wcs: WcsId; axis: 'X' | 'Y' | 'Z'; valueMm: number }
  /**
   * Go to a designated park position. `parkId` names WHICH park (a machine has
   * more than one: tool change, load/unload), so an operator readout can say
   * which; `safeZMachineMm` is the retract height and `x`/`y` the park point.
   *
   * Z is a MACHINE coordinate and says so in its name, X/Y are in the
   * program's declared frame - the same split the product already makes
   * (`jogToMachineZ` vs `jogToWorkXY`), because a safe height that moved with
   * the work offset would not be safe.
   */
  | { id: number; kind: 'park'; parkId: string; safeZMachineMm: number; x: number; y: number }
  /** Stop and wait for the operator, showing `message`. An M0 with WORDS: the
   *  reason a program stopped is the whole value of the step, and a bare pause
   *  is what forces an operator to guess. */
  | { id: number; kind: 'pause'; message: string }

/**
 * One step of a program: a move or an action, in ONE ordered list.
 *
 * ADR-0043 section 2: "A program is one ordered list. It is not 'moves plus a
 * side list of things to do first'." Both arms carry `id: number`, and that id
 * is the only thing progress, run-from-here, step-back and the fidelity check
 * ever key off.
 */
export type ProgramStep = QueuedMove | MachineAction

/**
 * What produced a step. A motion step traces to an operation, a setup and its
 * ordinal within that operation's moves; an action step traces to no move, and
 * says so rather than carrying `moveOrdinal: -1`.
 */
export type ProgramIndexEntry =
  | { opId: string; setupId: string; moveOrdinal: number }
  | { action: true }

/**
 * `id -> what produced it`, for every step in the program.
 *
 * A plain object rather than a `Map` deliberately: a `MachineProgram` travels
 * to the bridge as JSON (ADR-0043 section 4), and a `Map` serialises to `{}` -
 * silently, which is the shape of defect this series exists to remove.
 */
export type ProgramIndex = Record<number, ProgramIndexEntry>

/**
 * THE PROGRAM. Not a move list, and not a file of lines.
 *
 * ADR-0043 section 2. `QueuedMove` can carry a toolpath but cannot carry a
 * program - no spindle, no coolant, no tool change, no offset write - and
 * `StreamerProgress` counts lines on controllers that have none. This is the
 * container both of those were missing.
 *
 * DECLARED, NOT INFERRED. `frame` and `units` are on the type and go on the
 * wire, because the bridge already answers the frame question two different
 * ways (`AddLinearMoveP` takes machine coordinates, `JogToWorkXY` takes work
 * coordinates) and nothing said which a program was in - the path fidelity
 * check carries a `'work' | 'machine'` guess for exactly that reason. Both are
 * single-member literal types today: work and millimetres are the only answers
 * this product has, and a second value must arrive with the code that honours
 * it, never before.
 */
export interface MachineProgram {
  /** Always work coordinates. The machine applies its own offset register -
   *  the same register a posted file runs under (ADR-0043 section 3). */
  frame: 'work'
  /** Always millimetres on the wire. A controller whose profile is in inches
   *  is refused by capability, never silently scaled (ADR-0003). */
  units: 'mm'
  /** Ordered. Ids unique across ALL steps, action steps included. */
  steps: ProgramStep[]
  /** Every step id, mapped back to what produced it. */
  index: ProgramIndex
}

/**
 * Ids are minted from 1. **0 IS RESERVED** and no step may use it: it is the
 * bridge's connect sentinel (`Machine.cs:426`), so a step with id 0 is
 * indistinguishable from "this controller has not started anything yet".
 */
export const RESERVED_PROGRAM_ID = 0

/**
 * THE STATIONARY PART SIZE USED WHEN A BACKEND DOES NOT DECLARE ONE.
 *
 * 4095, because the board's own arithmetic is `moveCount mod 4096` (WO-1044,
 * measured - see `ControllerCapabilities.maxProgramMoves`): 4096 moves execute
 * as ZERO when it is pushed without flow control. This remains a conservative
 * rapid-boundary planning size, while the bridge's smaller live window is the
 * invariant that makes total program length unlimited.
 *
 * It is a DEFAULT, not a program-length law: a bridge that reports
 * `maxProgramMoves` uses that number for stationary split planning.
 */
export const DEFAULT_MAX_PROGRAM_MOVES = 4095

/**
 * How many motion steps the app should prefer in one stationary part.
 *
 * A pure function of the capability block - no controller instance, no clock -
 * so the app door, a backend and a test all get the same number.
 *
 * A garbage value (0, -1, 3.5, NaN, or a string that survived JSON parsing)
 * falls back to the same conservative rapid-boundary planning size.
 */
export function resolveMaxProgramMoves(capabilities: ControllerCapabilities): number {
  const declared = capabilities.maxProgramMoves
  if (typeof declared === 'number' && Number.isInteger(declared) && declared > 0) return declared
  return DEFAULT_MAX_PROGRAM_MOVES
}

/**
 * Is this program runnable AS WRITTEN? A pure function - no clock, no
 * controller, no I/O - so the builder, a backend and a test all get the same
 * answer.
 *
 * It REFUSES rather than repairs, and the reason NAMES THE OFFENDING ID,
 * because a program is built by code and read by a person: "step 41 is a line
 * with no feed" is actionable and "invalid program" is not. Nothing here
 * substitutes a value for a missing one - a program with no feed is refused,
 * never given a default (ADR-0003, and the rapid-feed rule in ADR-0043
 * section 3).
 *
 * The type says `frame: 'work'` and `units: 'mm'`, and this still checks both
 * at runtime: a program crosses a wire to the bridge, and on the far side of a
 * `JSON.parse` a declared literal is a claim, not a fact.
 */
export function validateMachineProgram(
  program: MachineProgram,
): { ok: true } | { ok: false; reason: string } {
  if (program.frame !== 'work') {
    return {
      ok: false,
      reason: `Program frame is not declared as work coordinates (got ${describeDeclared(program.frame)}).`,
    }
  }
  if (program.units !== 'mm') {
    return {
      ok: false,
      reason: `Program units are not declared as millimetres (got ${describeDeclared(program.units)}).`,
    }
  }
  const seen = new Set<number>()
  for (const step of program.steps) {
    const id = step.id
    if (!Number.isInteger(id)) {
      return { ok: false, reason: `Program step id ${describeDeclared(id)} is not a whole number.` }
    }
    if (id === RESERVED_PROGRAM_ID) {
      return {
        ok: false,
        reason: `Program step id ${RESERVED_PROGRAM_ID} is reserved for the machine's "nothing started yet" sentinel; ids run from 1.`,
      }
    }
    if (seen.has(id)) {
      return {
        ok: false,
        reason: `Program step id ${id} is used more than once; every step id must be unique across the whole program.`,
      }
    }
    seen.add(id)
    if ((step.kind === 'line' || step.kind === 'arc') && !(step.feedMmMin > 0)) {
      return {
        ok: false,
        reason: `Program step id ${id} is a ${step.kind} with no feed rate (got ${describeDeclared(step.feedMmMin)}); a feed has to come from the machine, never from here.`,
      }
    }
    if (!Object.hasOwn(program.index, id)) {
      return {
        ok: false,
        reason: `Program step id ${id} is missing from the program index, so nothing could say which operation it came from.`,
      }
    }
  }
  return { ok: true }
}

/** A value in a refusal reason, printed as what it IS - so `undefined` reads as
 *  "not declared" rather than disappearing into an empty string. */
function describeDeclared(value: unknown): string {
  if (value === undefined) return 'nothing'
  return typeof value === 'string' ? `"${value}"` : String(value)
}

/**
 * Progress through a `MachineProgram`, BY ID.
 *
 * The counterpart to `StreamerProgress`, which stays exactly as it is for the
 * text door. The two are not rivals: a text backend genuinely has lines and
 * bytes, and a geometry backend genuinely has ids and a move buffer.
 * `UccncController.jobProgress` has had to stuff an id into a field named
 * `ackedSourceLine` since WO-422 precisely because there was nowhere else to
 * put it, and that is the shape of defect this closes.
 *
 * Every field is a fact the CONTROLLER reports, or `null`. Nothing here is
 * derived by counting: ids are OURS and are not ordinals (a program may mint
 * 1, 2, 5), so no count may ever be computed from an id.
 */
export interface ProgramProgress {
  /** The step the controller says is executing now. Null when it says none -
   *  and `RESERVED_PROGRAM_ID` (0) IS "it says none", so a backend whose wire
   *  spells that state as 0 reports null here rather than handing back an id
   *  no program is allowed to mint. */
  executingId: number | null
  /** The last step the controller reported as FINISHED. Null before the first
   *  one finishes, and on a backend that only reports what is executing. */
  lastCompletedId: number | null
  /** Steps loaded. A count of the program, not of the controller's buffer. */
  total: number
  /** Buffer occupancy, when the controller reports one - else null, never 0.
   *  "Nothing queued" and "this controller does not say" are different facts. */
  queuedOnController: number | null
}

/**
 * One JOINT as the controller counts them - a motor-side fact, not a Cartesian
 * one (ADR-0054 item 4). On a slaved gantry two joints drive Y; LinuxCNC homes
 * joints, not axis letters, so a joint's `homed` must never be folded into one
 * per-letter boolean (the WO-930 collapse, one level down).
 */
export interface JointReading {
  /** The controller's own joint number, from 0 (LinuxCNC `joint.N`). */
  index: number
  /** The Cartesian axis this joint drives, or null when the controller does
   *  not say or the kinematics give it no single axis. Two joints may name
   *  the same axis. */
  axis: AxisName | null
  /** Joint position in its own units - mm linear, degrees rotary. Null when
   *  it could not be read this frame. */
  position: number | null
  /** Homed this session, for this joint alone. Null when the controller
   *  cannot say. */
  homed: boolean | null
}

/** A single snapshot of everything the Control page shows. Fields a backend
 *  cannot supply are null - never faked, so the UI can say "unknown" honestly
 *  instead of showing an invented number. */
export interface MachineStatus {
  state: MachineState
  subState: number | null
  machinePos: MachinePosition | null
  workPos: MachinePosition | null
  /** mm/min, post-override. */
  feedMmMin: number | null
  spindleRpm: number | null
  /** Per channel, because controllers differ in which they HAVE. The AXBB-E has
   *  feed, spindle and jog-rate but no rapid override at all, so its `rapid` is
   *  null rather than a jog-rate value wearing rapid's name. Contract v2. */
  overrides: {
    feed: number | null
    rapid: number | null
    spindle: number | null
  } | null
  /** Id of the move executing now, when `capabilities.executingMoveId`. */
  executingMoveId: number | null
  /** `moves` is OCCUPANCY - how many are queued right now. `capacitySeconds` is
   *  the buffer's configured DEPTH, not how full it is; the two answer different
   *  questions and the original single "seconds" field conflated them. */
  buffer: { moves: number | null; capacitySeconds: number | null } | null
  /**
   * WO-1632: a probe cycle is in process right now - the controller's own
   * cycle flag, NOT contact (that is `inputs.probe`). On the AXBB-E this flag
   * went true with the tool 70 mm in the air (board, 2026-09-14). Null when
   * the controller could not be read; absent on a backend that does not
   * report one (GRBL, the simulator).
   */
  probeCycle?: boolean | null
  /**
   * Triggered inputs, decoded rather than left as protocol letters.
   *
   * Contract v4 (2026-08-21): v3 carried four booleans, but the Control page
   * renders SIX lamps off GRBL's `Pn:` field - X, Y and Z limits separately,
   * plus Probe, Door and Hold - so routing GRBL through the contract would have
   * darkened four of them and WO-423 correctly kept GRBL's native channel
   * instead. Transcribed from `ControlPage.tsx` rather than designed.
   *
   * A controller that reports only an aggregate says so with `limits: null`;
   * one with no door or hold input reports null rather than false, because
   * "not triggered" and "no such input" are different facts.
   */
  inputs: {
    estop: boolean
    /** Any hard limit. Always present; `limits` adds which one, when known. */
    hardLimit: boolean
    softLimit: boolean
    /** The probe INPUT itself: true while the probe circuit is closed (a
     *  touch), with the machine's polarity applied. Never "a probe cycle is
     *  running" - that is `probeCycle`. Null when the controller has no probe
     *  pin configured or could not read its inputs (WO-1632). */
    probe: boolean | null
    /** Per axis, when the controller breaks it out. GRBL does; the AXBB-E
     *  reports a single flag, so it sends null. */
    limits: { x: boolean; y: boolean; z: boolean } | null
    /** Safety door / external panic input. Null on a controller without one. */
    door: boolean | null
    /** Feed hold asserted. Null on a controller that does not expose it. */
    hold: boolean | null
    /**
     * WO-922, contract v5, and the reason it exists: on 2026-08-23 X ran
     * 229 mm the wrong way during homing because its home switch was ALREADY
     * MADE and never released. Nobody could see that from LienCAM - the made
     * switch was found afterwards, by opening UCCNC's own I/O monitor. The
     * app carried no home-input state at all.
     *
     * `hardLimit` above could not have helped either, and the second gap is
     * why: X has `Limitminuspinnumber=0` / `Limitpluspinnumber=0` - NO limit
     * inputs wired - so that aggregate can never trip on that axis, and a
     * single boolean has no way to SAY so.
     *
     * Hence three values per axis, not two:
     *   `true`      - wired, and made right now
     *   `false`     - wired, and currently open
     *   `null`      - NO INPUT IS WIRED FOR THIS AXIS. Not the same as
     *                 `false`, and never to be defaulted to it. This is the
     *                 fact that was missing on the night.
     *   key absent  - this axis is not part of this machine at all (a 3-axis
     *                 machine sends X/Y/Z and says nothing about A/B/C).
     *
     * A reader must therefore distinguish `x === null` from `x === false`,
     * and use `in`/`Object.hasOwn` rather than `?? null` when it needs to
     * tell "no such axis" from "axis with no input". Collapsing any of the
     * three into a boolean puts back exactly the blindness this closes.
     *
     * OPTIONAL, all three, because the bridge half is WO-923 and has not
     * landed: an older bridge sends none of these keys, must still connect,
     * and must behave exactly as it does today. Absent means "this backend
     * does not report per-axis input state", which is a fourth thing again
     * from any of the above - and is why these are `?` rather than
     * `| null` fields that a backend could forget to set.
     */
    home?: Partial<Record<AxisName, boolean | null>>
    /** Per-axis minus-side limit input. Same three-way meaning as `home`. */
    limitMinus?: Partial<Record<AxisName, boolean | null>>
    /** Per-axis plus-side limit input. Same three-way meaning as `home`. */
    limitPlus?: Partial<Record<AxisName, boolean | null>>
  } | null
  /** Per-axis: has this axis been homed in this session. */
  homed: Partial<Record<ControlAxis, boolean>> | null
  /**
   * ADR-0054 item 4: the joint vector behind `machinePos`, which stays
   * Cartesian and unchanged. Same three-way rule as `inputs.home`:
   *   key absent  - this backend cannot say which joints it has (every
   *                 backend today: GRBL, the simulator, the AXBB-E, whose
   *                 path does not report the Y slave separately)
   *   `null`      - it reports joints, but could not read them this frame
   *   array       - one entry per joint, in controller order
   * Never default an absent key to `[]`: "no joints" and "cannot say" are
   * different facts. Optional so no backend has to implement it.
   */
  joints?: JointReading[] | null
  /**
   * WO-442: live VFD spindle telemetry, decoded to REAL units by
   * `src/lib/machine/vfd/vfdRuntime.ts` - never a raw register word wearing
   * a unit's name (see that file's header, and `docs/machine/BRIDGE-PROTOCOL.md`
   * "The `vfd` push"). `null` when the whole concept does not apply to this
   * connection - no VFD link configured, or an unrecognised definition name
   * in `hello.vfd`. Once a definition IS active this is an object whose OWN
   * fields go null individually, same rule, one level down: the inverter not
   * reporting that field, the last poll failing, or the inverter faulted.
   * `upToSpeed` is null until a caller can supply the commanded RPM to
   * compare against - this controller has no `spindleOn` call yet to source
   * one from automatically (see `UccncController.vfdUpToSpeed`'s own note).
   *
   * Optional, not required: `GrblController` and `SimulatedController` never
   * touch a VFD at all (their spindle, when they have one, is the
   * controller's own output, not a Modbus inverter) and are outside this
   * WO's owned-paths, so they simply never set this key - structurally the
   * same as `null` to every reader, which is why a reader should go through
   * `status.spindle?.field ?? null` rather than assuming the key exists.
   */
  /**
   * Spindle readings from a link this controller owns. **Required, and null
   * when there is no such link** - an optional field that is simply missing is
   * indistinguishable from a backend that forgot to set it, and this series'
   * rule is that absence is stated rather than implied. Every backend answers
   * the question; two of them answer `null`.
   */
  spindle: {
    volts: number | null
    amps: number | null
    torque: number | null
    power: number | null
    upToSpeed: boolean | null
    /**
     * Is the spindle TURNING, as the machine reports it - not as we commanded.
     *
     * Null when this backend cannot say (no link, or a controller with no VFD).
     * Direction is deliberately absent: on Operator's inverter 0x1001 reports the
     * OPPOSITE direction from the one commanded while rotating correctly
     * (VFD-COMMISSIONING.md 4.9), so the drive is truthful about WHETHER it
     * spins and unreliable about WHICH WAY. A UI wanting direction must take it
     * from what was commanded; a UI wanting running/stopped must take it from
     * here, and never from what it commanded.
     */
    running: boolean | null
    /**
     * WO-475: is the link to the inverter actually ALIVE - last transaction
     * answered? `null` before any sample has arrived.
     *
     * This is NOT the same question as "is a spindle link configured", and
     * conflating them is the defect this field exists for. `hello.vfd.present`
     * is `vfd != null` (Bridge.cs) - it is true when `--vfd` was passed, and
     * stays true when the serial port FAILED TO OPEN, which was observed
     * directly on 2026-08-22 with COM3 held by another process. The capability
     * derived from it is right to be static: a capability that flickers with a
     * cable is not a capability. Liveness belongs here, in status, where it is
     * allowed to change every poll.
     */
    linkUp: boolean | null
  } | null
}

/**
 * What a live machine-definition apply did (WO-915).
 *
 * The loop this exists for: change a pin -> apply -> jog -> watch which axis
 * moves -> fix it, with no restart. Proven possible on the AXBB-E 2026-08-23.
 *
 * `ok` is the whole apply, not the call: a backend answers this rather than
 * throwing, because a PARTIAL apply is the interesting case - the controller
 * is then part old and part new, and a caller must be told that rather than
 * catching an exception and guessing.
 */
export interface ApplyDefinitionResult {
  /** Every value was written AND read back off the controller and matched. */
  ok: boolean
  /** Null when `ok`. A sentence naming what failed - never a bare code. */
  error: string | null
  /**
   * Axes whose "homed this session" was cleared by this apply, and which the
   * operator must re-home. steps/unit, soft limits, homing direction, homing
   * value and any axis pin change all alter WHAT THE POSITION COUNTER MEANS;
   * keeping "homed" across one makes every later move wrong by a constant,
   * silently. The homing ORDER alone does not do this.
   */
  reHome: JogAxis[]
  /**
   * Whether the controller is configured for THIS session after the apply.
   * False also after a failed apply, because a half-applied definition is not
   * a configured machine - the backend refuses motion until an apply succeeds.
   */
  configuredThisSession: boolean
  /** The backend's own report, line by line. Also delivered on the console. */
  lines: { text: string; severity: 'info' | 'warn' | 'error' }[]
}

/**
 * WO-1041: the result of setting a work offset to given values.
 *
 * `offset` is the backend's ECHO of what it now holds for that WCS, so a
 * caller can see what it got. **It is not proof the value took effect.** On the
 * UCCNC path the controller has no work-offset register at all - the offset is
 * arithmetic the bridge applies to coordinates - so there is nothing to read
 * back, and the observable effect is that `workPos` in the status frame shifts
 * by the delta. Treat this field as a receipt, not a readback.
 */
export interface SetWorkOffsetResult {
  ok: boolean
  /** The refusal in plain words when `ok` is false, else null. */
  reason: string | null
  /** What the backend now holds for that WCS. An echo - see above. */
  offset: MachinePosition | null
  /** WO-1983: `unknown` when the answer stopped arriving. See `CommandOutcome`. */
  outcome?: CommandOutcome
}

/** WO-2187: work-system rotations in degrees CCW seen from +Z, by the
 *  controller's name for the system (G54 .. G59, LinuxCNC's G59.1 .. G59.3). */
export type WcsRotations = Readonly<Record<string, number>>

/** WO-2185 / WO-2187: the controller's answer to `setWcsRotation`. */
export interface SetWcsRotationResult {
  ok: boolean
  reason: string | null
  /** The rotation the controller now holds for that system, degrees CCW seen
   *  from +Z; null when it was not set or could not be read back. */
  rotationDeg: number | null
  /** That system's X Y Z row as the controller now holds it (a rotation
   *  leaves it as it was); null when the controller does not say. */
  offset: MachinePosition | null
  outcome: CommandOutcome
}

/**
 * WO-1083's receipt for `zeroWorkAxis`, in the same terms as
 * `SetWorkOffsetResult` above.
 *
 * `confirmed` says the backend applied the zero. `offset` is the backend's ECHO
 * of the whole WCS row AFTER the write - the same kind of statement, with the
 * same limits, as `SetWorkOffsetResult.offset`; the observable effect is still
 * `workPos` in the next status frame.
 *
 * **`offset` ABSENT MEANS "CANNOT SAY", NOT "ZERO".** A bridge older than
 * WO-1083 answers this call with a bare `true`, and no caller may substitute a
 * value for it - guessing one from a status frame is exactly the race the app
 * used to lose (WO-1042, ten audit rounds). A receipt without `offset` writes
 * nothing durable.
 */
export interface ZeroWorkAxisReceipt {
  confirmed: boolean
  /** The system the backend zeroed in, when it says. */
  wcs?: WcsId
  /** The whole WCS row after the write, when the backend can say. */
  offset?: MachinePosition
  /** WO-1983: `unknown` when the answer stopped arriving. See `CommandOutcome`. */
  outcome?: CommandOutcome
}

export interface ProbeTouch {
  ok: boolean
  /** Machine position at the moment of contact. */
  at: MachineVec3 | null
  /** A backend-known refusal reason. Absent when the backend cannot name one. */
  reason?: string
  /**
   * WO-1983: `unknown` when the probe was sent and no answer came back - the
   * probe MAY STILL BE RUNNING. It is not a miss and not a refusal; read it
   * with `probeOutcome`. An unknown touch carries `ok: false` and `at: null`
   * so a caller that has not learned this value yet can never use a contact
   * position from it. See `CommandOutcome`.
   */
  outcome?: CommandOutcome
}

/**
 * ADR-0054 item 1 (WO-1983): the third answer a command can give.
 *
 * - `accepted` - the controller answered that it did it.
 * - `refused` - the controller answered that it did not, or the command was
 *   never sent.
 * - `unknown` - the command crossed to the controller and THE ANSWER STOPPED
 *   ARRIVING: the call timed out, or the link closed with it in flight. The
 *   machine may still be doing it. (Measured, WO-1546: an 8 s call timeout
 *   reported a probe that took 12 s on the board as a failure.)
 *
 * **`unknown` is neither a failure nor a success.** A caller must not narrate
 * it as "refused", "did not run" or "no contact", and must not use any value
 * from it. The evidence that clears it is gathered AFTER the uncertainty - a
 * fresh status read, idle twice in a row - never a frame cached from before
 * it. `unknownOutcomeSentence` is the operator's sentence for it.
 *
 * OPTIONAL on every receipt that carries it, so no backend or test double has
 * to change: absent means the backend answers in two values exactly as before
 * this contract grew, and `ok` (or `confirmed`) decides. A backend that sets
 * `unknown` also sets `ok`/`confirmed` false and leaves every value field
 * empty, so a caller that does not read `outcome` yet stays conservative.
 *
 * Carried by: `ProbeTouch`, `ZeroWorkAxisReceipt`, `SetWorkOffsetResult`,
 * `CommandAck` (`sendCommandAwait`), `resetToIdle`'s result and the refused
 * branch of `OutputSwitchReceipt`. NOT carried by the members that resolve a
 * bare `Promise<boolean>` (`jogToWorkXYAwait`, `jogToMachineZAwait`,
 * `selectWcsAwait`, `jogStartContinuous`): widening those to a third value
 * changes what every caller's `if (answer)` means, so each is converted one
 * call at a time with its call sites. Until then a backend must never resolve
 * one of them `true` for an answer that did not arrive.
 */
export type CommandOutcome = 'accepted' | 'refused' | 'unknown'

/**
 * Read a receipt as the three-valued outcome. `unknown` wins whatever the
 * boolean says; otherwise `ok` (or `confirmed`) decides, so this reading
 * always agrees with a caller that reads the boolean. Not for `ProbeTouch`,
 * whose `ok: false` can be an honest miss - use `probeOutcome`.
 */
export function commandOutcome(
  receipt: { outcome?: CommandOutcome } & ({ ok: boolean } | { confirmed: boolean }),
): CommandOutcome {
  if (receipt.outcome === 'unknown') return 'unknown'
  const yes = 'ok' in receipt ? receipt.ok : receipt.confirmed
  return yes ? 'accepted' : 'refused'
}

/**
 * What a probe's answer says, in the order a caller must ask it:
 * - `unknown` - no answer came back; the probe may still be running.
 * - `touched` - it made contact at `at`.
 * - `failed` - the controller answered with a sentence (`reason`): it refused
 *   the probe, or it touched and then failed - the sentence says which.
 * - `no-contact` - it ran and found nothing.
 */
export function probeOutcome(touch: ProbeTouch): 'unknown' | 'touched' | 'failed' | 'no-contact' {
  if (touch.outcome === 'unknown') return 'unknown'
  if (touch.ok && touch.at !== null) return 'touched'
  if (touch.reason) return 'failed'
  return 'no-contact'
}

/**
 * The operator's sentence for an `unknown` outcome. It says what we know -
 * no answer arrived - and does not claim the command failed. `waitedMs` is
 * how long the caller waited, when it knows.
 */
export function unknownOutcomeSentence(command: string, waitedMs: number | null): string {
  const waited = waitedMs !== null && Number.isFinite(waitedMs) && waitedMs > 0
    ? ` within ${Math.round(waitedMs / 1000)} s`
    : ''
  return `No answer came back from the controller for ${command}${waited}. It may still be running - `
    + 'this is not a failure report. The next status report says what the machine is doing.'
}

/**
 * One console line. Contract v4: v3 said `info | warn | error` while GRBL and
 * the store both use `info | command | error` - neither a subset of the other,
 * so WO-423 had to keep GRBL's native console channel. This is the union, which
 * loses nothing on either side.
 */
export interface ConsoleEntry {
  dir: 'tx' | 'rx'
  text: string
  severity: 'info' | 'command' | 'warn' | 'error'
}

/** Why a job stopped, when it stopped badly. */
export interface JobFault {
  /** Backend-specific code (a GRBL error:N, a UC100 return code). */
  code: number | null
  /** A sentence an operator can act on - never a bare code. */
  message: string
  /** Source line, when the backend streams text. */
  line: number | null
  /** Move id, when the backend queues geometry. Contract v3: a geometry backend
   *  knows which MOVE failed, not which line of text. */
  moveId: number | null
}

/** Live accessory state, when `capabilities.ownsSpindle`. Null on a controller
 *  whose spindle is on a separate link - Operator's AXBB drives its VFD over
 *  Modbus, so it reports null here rather than a guess. */
export interface AccessoryState {
  spindle: 'cw' | 'ccw' | 'off'
  flood: boolean
  mist: boolean
}

/**
 * Everything a backend pushes upward.
 *
 * Contract v3 (2026-08-21): v1 carried only status, parser state, phase,
 * console and close - so `machineSession` had to keep a typed GRBL reference for
 * job progress, alarms, offsets, settings and homing, and the abstraction was
 * only half real. These are transcribed from `GrblControllerEvents`, which is
 * the working surface, per ADR-0041 rule 1.
 */
export interface ControllerEvents {
  onStatus?: (status: MachineStatus) => void
  onParserState?: (state: GrblParserState) => void
  onConnectionPhase?: (phase: ConnectionPhase, detail: string | null) => void
  onConsole?: (entry: ConsoleEntry) => void
  onClose?: (reason: string | null) => void

  // ---- contract v3: the channels machineSession had to reach past the
  //      interface for. Backends that cannot raise one simply never call it.
  /** Controller identified itself (a GRBL banner, a bridge `hello`). */
  onReady?: (version: string) => void
  /** A fault the operator must clear. `positionLost` means re-homing is needed
   *  before the machine's position can be trusted again. */
  onAlarm?: (code: number | null, message: string, positionLost: boolean) => void
  onJobProgress?: (progress: StreamerProgress) => void
  onJobEvent?: (
    event: 'started' | 'paused' | 'resumed' | 'stopped' | 'completed' | 'failed',
    fault: JobFault | null,
  ) => void
  /** One work-offset entry (G54..G59, G28, G30, G92, TLO, PRB). */
  onOffset?: (entry: { label: string; values: number[]; probeSuccess?: boolean }) => void
  /** One controller setting, keyed however that controller keys them - GRBL's
   *  are numbered (`$130`), a bridge's may be named. Callers that need a number
   *  (the travel envelope) parse and DROP a non-numeric key rather than
   *  coercing it to NaN. */
  onSetting?: (key: string, value: string) => void
  /** A homing cycle completed successfully. `axes` is null when the controller
   *  only reports "the cycle finished" (GRBL) rather than which axes. */
  onHomed?: (axes: ControlAxis[] | null) => void
  /** Spindle and coolant, when this controller owns them. */
  onAccessories?: (state: AccessoryState) => void
  /**
   * DID THE MACHINE FLY THE PATH IT WAS GIVEN? (WO-1008.)
   *
   * OPTIONAL AND ADDITIVE, deliberately: a backend or a session that does not
   * compute path fidelity simply never calls it, so no backend and no test
   * double has to grow a member. Making it REQUIRED would drag GRBL, UCCNC,
   * Simulated and every double along with it, which is a different order.
   *
   * The report carries its own verdict, and the third one is the point:
   * `unknown` is not `clean`. See `pathFidelity.ts`.
   */
  onPathFidelity?: (report: PathFidelityReport) => void
}

/** WO-1637: one output, as the machine definition names it. */
export interface OutputSwitchRequest {
  port: number
  pin: number
  on: boolean
  /** The definition's polarity; an unstated negate is sent as false, the
   *  bridge's own default. */
  negate: boolean
}

/** One raw output observation. `on` is the level with the definition's
 *  polarity applied; null when the board could not report its outputs. A raw
 *  observation is not itself proof that it was sampled after a write. */
export interface OutputReadback {
  port: number
  pin: number
  level: boolean | null
  on: boolean | null
}

export type OutputSwitchReceipt =
  | {
      ok: true
      /** `confirmed` means a later, read-only sample matched this request.
       * `unconfirmed` preserves an accepted write without promoting an
       * unknown or opposite sample into a physical-fault claim. `superseded`
       * means a newer command for this same physical pin owns narration. */
      confirmation: 'confirmed' | 'unconfirmed' | 'superseded'
      /** Latest raw observation, when the bridge supplied one. */
      readback: OutputReadback | null
    }
  | {
      ok: false
      reason: string
      superseded: boolean
      /** WO-1983: `unknown` when the answer stopped arriving. See `CommandOutcome`. */
      outcome?: CommandOutcome
    }

/** WO-1983: `sendCommandAwait`'s answer. Its shape is unchanged; `outcome` is
 *  the optional third value - see `CommandOutcome`. */
export interface CommandAck {
  ok: boolean
  message: string | null
  outcome?: CommandOutcome
}

/**
 * The contract every backend satisfies.
 *
 * Members marked (as today) are transcribed unchanged from GrblController, so
 * that backend satisfies them without edits. Keep it that way: a signature
 * change here is a behaviour change in a proven controller, and needs its own
 * reason.
 */
export interface MachineController {
  readonly capabilities: ControllerCapabilities

  // ---- lifecycle ----
  /** The thing this backend talks through - a byte pipe for GRBL, a message
   *  channel for the bridge, nothing at all for the simulator. Each backend
   *  narrows it; the contract only requires that one is supplied. Contract v2:
   *  this was `unknown`, which made the connect boundary the one place with no
   *  type safety, exactly where handing over the wrong object fails against a
   *  machine. */
  connect(backend: ControllerBackend): Promise<void>
  disconnect(): Promise<void>
  connectionPhase(): ConnectionPhase // (as today)
  /** Firmware/build identity, for the console and support. Was grblVersion(). */
  firmwareVersion(): string | null
  /** Connected bridge metadata, when this backend publishes it. */
  bridgeHello?(): ControllerBridgeHello | null

  // ---- state ----
  machineState(): MachineState // (as today)
  status(): MachineStatus
  /** Ask for a fresh status now, outside the poll cadence. (as today) */
  queryStatus(): void
  /** Re-read modal/parser state and offsets. (as today) */
  refreshState(): boolean
  /** Re-read the settings the travel envelope is derived from. (as today) */
  querySettings(): boolean
  /** Read one complete controller-settings transaction. A backend declares
   * this capability together with `writeSetting`; GRBL uses it for `$$` and
   * other controllers may expose the same transaction without sharing its
   * concrete class. */
  readSettings?(): Promise<Map<number, string>>
  /** Write one numbered controller setting and resolve its acknowledgement.
   * Paired with `readSettings` so settings ownership is a structural
   * capability rather than a GRBL class check. */
  writeSetting?(id: number, value: string): Promise<{ ok: boolean; message: string | null }> | null
  /** True when status frames are generated by a software motion model rather
   * than measured physical telemetry. Such frames are not subject to the
   * impossible-physical-speed instrument. */
  statusFramesAreSynthetic?(): boolean
  verifiedIdle(): boolean // (as today)
  /**
   * THE WHOLE MACHINE has a datum this session: every axis in
   * `HOMED_GATE_AXES` has been homed, not merely "some homing cycle finished".
   *
   * WO-930. Both bridge-capable backends used to set this on ANY completed
   * `homeAxes` call, whatever the list, so homing Z alone reported the machine
   * homed while X and Y were unreferenced - and every "home first" gate
   * opened, including the automatic probe cycles, which then moved an axis
   * whose machine coordinate meant nothing. The per-axis truth already existed
   * in `status().homed`; this boolean was where it got collapsed.
   *
   * A caller that needs ONE axis must not ask this - it will be told "no"
   * because of a different axis. Ask `unhomedAxes(ctrl, ['Z'])` instead: this
   * boolean is the conservative whole-machine reading, and `unhomedAxes` is
   * the honest per-axis one. Neither is ever more permissive than the old
   * collapsed flag was.
   *
   * A backend with no per-axis knowledge (GRBL, whose `$H` is one indivisible
   * whole-machine cycle) answers exactly as it always has.
   */
  homedThisSession(): boolean
  /**
   * Which axes have a datum in THIS session, per axis.
   *
   * OPTIONAL, and absent means "this backend cannot say which" rather than
   * "none" - `unhomedAxes` then falls back to `homedThisSession()` for every
   * axis, which is exactly today's behaviour and is honest for a backend whose
   * homing cycle is all-or-nothing. Do NOT read `status().homed` for a gate:
   * that is telemetry from the far end, it is `null` on a bridge that does not
   * report it, and a gate that reads it would be more permissive on a stale
   * frame than the session flag it replaced.
   *
   * An axis key that is absent means "not homed this session", the same as
   * `false`. A backend that homes A/B/C simply does not report them here -
   * they are not `JogAxis`, no gate in this product moves them by machine
   * coordinate, and inventing a key for them would put back the collapse
   * WO-930 removes.
   */
  homedAxesThisSession?(): Partial<Record<JogAxis, boolean>>
  /**
   * Revoke machine-coordinate authority after the controller reports that
   * position was lost. `null` means every gate axis; a named list permits a
   * future backend to preserve axes the controller explicitly says survived.
   *
   * Optional because controllers that never emit a position-lost alarm have
   * no alarm path to consume it. Alarm-capable backends must invalidate their
   * own authoritative state before publishing `onAlarm`.
   */
  invalidateDatum?(axes: readonly JogAxis[] | null): void
  /**
   * Establish the machine-coordinate datum at the machine's current physical
   * position. Optional until a hardware backend has a safe, acknowledged wire
   * command for it; callers must refuse an absent implementation rather than
   * pretending the datum changed.
   */
  setMachinePosition?(position: MachinePosition): boolean
  resetInProgress(): boolean // (as today)
  subscribeResetInProgress(listener: () => void): () => void // (as today)

  // ---- motion ----
  jog(axis: ControlAxis, deltaMm: number, feedMmMin: number): boolean // (as today)
  jogToWorkXY(x: number, y: number, feedMmMin: number): boolean // (as today)
  jogToMachineZ(z: number, feedMmMin: number): boolean // (as today)
  /**
   * WO-1548: the same two moves, resolved with the controller's own answer -
   * `false` when it refused the move, so an app-issued move line can name the
   * refusal instead of waiting out a move that never started. Null when the
   * controller would not take a call at all (not connected). Arrival is NOT
   * this answer: the caller waits for the status to report idle at the target.
   */
  jogToWorkXYAwait?(x: number, y: number, feedMmMin: number): Promise<boolean> | null
  jogToMachineZAwait?(z: number, feedMmMin: number): Promise<boolean> | null
  jogCancel(): void // (as today)
  /**
   * CONTINUOUS JOG ON THE CONTROLLER'S OWN JOG - WO-1111. Optional.
   *
   * Operator ruling 2026-08-29, at the machine: "jog is still stuttery, especially at the
   * beginning... I can see the feedrate under the DRO vary during continous
   * jog." Holding a jog button fired a fresh short `jog` every 150 ms, and the
   * controller ramped into and out of every one of them - a held jog was a
   * train of little trapezoids, and the feed readback showed it.
   *
   * A backend that can run its axis until told to stop implements these three.
   * `jogStartContinuous` starts it, `jogHold` says the operator is STILL
   * holding the button, `jogStop` ends it.
   *
   * `jogHold` IS NOT OPTIONAL FOR A BACKEND THAT IMPLEMENTS THIS, and it is
   * not a nicety: a motion that runs until stopped must not outlive the client
   * that asked for it. The backend is expected to stop the axis itself when the
   * holds stop arriving, so a frozen browser cannot drive an axis into a limit.
   *
   * Optional as a group: a backend that does not implement `jogStartContinuous`
   * keeps the burst behaviour, which is bounded for the same reason - each
   * burst is finite. Do not implement one of the three without the others.
   */
  jogStartContinuous?(axis: ControlAxis, direction: 1 | -1, feedMmMin: number): Promise<boolean>
  jogHold?(): void
  jogStop?(): void
  /**
   * The controller's own whole-machine homing cycle, with NO order from us -
   * GRBL's `$H`, where the firmware's `$22`/cycle config decides the sequence
   * and the browser cannot choose it.
   *
   * WO-914: prefer `homeAxes(resolveHomingOrder(...))` wherever
   * `capabilities.perAxisHoming` is true. The homing ORDER is a per-machine
   * safety setting (Z first, so a tool in the spindle is retracted before
   * anything moves in the plane), and this entry point cannot carry one.
   */
  home(): boolean // (as today)
  /**
   * Home exactly these axes, in exactly this order, one after another. Only
   * when `capabilities.perAxisHoming`.
   *
   * WO-914 widened this from `JogAxis[]` to `AxisName[]`: a machine
   * definition's `homing.order` may name A/B/C, and quietly FILTERING those
   * out would be the backend substituting a different list for the one the
   * machine was configured with. A backend that cannot home an axis must
   * refuse and say so, never drop it.
   */
  homeAxes?(axes: AxisName[]): boolean

  // ---- authority ----
  feedHold(): void // (as today)
  cycleResume(): boolean // (as today)
  /** Controller-level reset. Was softReset(). */
  reset(): void
  unlock(): boolean // (as today)
  /**
   * Stop is its own path, end to end (ADR-0054 item 3, WO-1984). A backend
   * MUST NOT route it through the command-submit path, and nothing may gate
   * it: no capability, read-only mode, verification state or link state may
   * refuse a stop locally (compare `spindleOff`, "Never gated"). The only
   * honest failure is "the board cannot be reached at all". On the UCCNC
   * bridge it is a `StopNow` job that jumps every queue and aborts a running
   * long operation, unlike `feedHold`, which only jumps the queue.
   */
  emergencyStop(): void // (as today)
  resetToIdle(): Promise<{ ok: boolean; reason: string | null; outcome?: CommandOutcome }>
  setOverride(change: OverrideChange): void
  /**
   * WO-2676: true when `setOverride({ to: 'percent' })` sets FEED and SPINDLE
   * to that exact percent in one write (UCCNC: SetFRO/SetSRO take an absolute
   * percent). A typed override then lands where it was typed, whatever the
   * board's readback timing - reset + steps cannot, because each step is
   * worked out from a readback that may not show the previous write yet.
   * Absent means steps only (GRBL has no absolute feed/spindle byte).
   *
   * Not in `capabilities`: three exact-shape capability tests pin that block,
   * and this is a fact about the backend's wire, not a hello claim.
   */
  readonly absoluteOverridePercent?: boolean
  // ---- spindle (WO-905), only when `capabilities.spindleCommands` ----
  /**
   * Start the spindle at a speed in RPM. **RPM, not a register word**: the
   * backend converts, using the inverter definition's own scale expression,
   * because there is exactly one expression evaluator in the product. The
   * bridge deliberately refuses to do this arithmetic for the same reason.
   *
   * Returns false when it could not be commanded, having said why on the
   * console - an unconvertible speed, no definition, or no link.
   */
  spindleOn?(direction: 'cw' | 'ccw', rpm: number): boolean
  /**
   * Stop the spindle. **Never gated** - no capability, no verification and no
   * link state may block a stop, so this is safe to call even where
   * `spindleCommands` is false, where it simply does nothing.
   *
   * NOTE, measured 2026-08-22: returning is NOT "the tool has stopped". This
   * spindle keeps turning for 6.4 s from 24,000 RPM. Anything that needs a
   * stationary tool must watch `status.spindle.actualRpm` reach zero.
   */
  spindleOff?(): void
  /** Clear a latched inverter fault. Does not spin anything, so it is gated
   *  on a link existing but not on the definition being verified. */
  spindleResetFault?(): void

  // ---- outputs (WO-1637) ----
  /**
   * Switch ONE output the machine definition names - port, pin and its negate,
   * carried as the definition states them. The backend knows no use case;
   * which pin is "flood" or "vacuum" is `resolveMachineOutputWord`'s answer.
   *
   * Optional: a text controller switches outputs with the words themselves.
   * OFF is sent whenever there is a link at all (a stop); ON only when
   * connected, and the bridge refuses it under E-STOP or inhibited outputs.
   * Null when nothing could be sent.
   */
  setOutput?(request: OutputSwitchRequest): Promise<OutputSwitchReceipt> | null

  // ---- setup ----
  /**
   * Apply a machine definition to the controller WITHOUT a restart (WO-915).
   * Optional: only a backend that can reconfigure its controller live
   * implements it, and a caller asks with `typeof c.applyMachineDefinition`
   * rather than assuming.
   *
   * The definition carries pins as `(port, pin)` - the physical connector
   * location a person reads off a wiring diagram. It is the BACKEND that
   * derives whatever numbering its controller wants, and there is exactly one
   * copy of that translation, in the bridge. Nothing in `src/` may translate,
   * look up or do arithmetic on a pin number (WO-912's guard test fails if it
   * ever does).
   *
   * NOT DEMONSTRATED, and no implementation may claim otherwise: whether a
   * controller USES a pin changed on a live connection, or only stores it
   * until the next open. A readback proves storage, not use.
   */
  applyMachineDefinition?(
    definition: ControllerDefinition,
    provenance?: MachineDefinitionProvenance,
  ): Promise<ApplyDefinitionResult>
  /** Store or clear a gantry-squaring measurement, with controller readback. */
  applySkew?(offsetMm: number | null): Promise<ControllerSkewApplyResult>
  selectWcs(wcs: WcsId): boolean // (as today)
  /**
   * Receipt-bearing WCS selection for program loads. A non-null promise means
   * the command crossed the controller boundary; true means the controller
   * echoed that it now holds the requested frame. Callers that stage work-
   * coordinate motion must await this receipt before handing over the first
   * move. The synchronous verb remains for existing operator controls.
   */
  selectWcsAwait?(wcs: WcsId): Promise<boolean> | null
  zeroWorkAxis(axis: ControlAxis): boolean // (as today)
  /**
   * Optional receipt-bearing form of `zeroWorkAxis`. A non-null promise means
   * the controller accepted the call for delivery; the receipt it resolves to
   * says whether the controller confirmed the write and, when the backend can
   * say, what the WCS row now holds.
   *
   * This is the ONLY seam through which a zero may become a durable work
   * offset: the value comes from the backend that applied it, never from a
   * status frame sampled on another loop.
   */
  zeroWorkAxisAwait?(axis: ControlAxis): Promise<ZeroWorkAxisReceipt> | null
  /**
   * WO-1041: set a work offset to GIVEN VALUES, rather than to wherever the
   * tool happens to be standing.
   *
   * `zeroWorkAxis` can only zero an axis at the current position. This is the
   * intent that lets a stored offset be pushed back INTO a controller - the
   * missing half of ADR-0044's "our data is the live truth and is pushed
   * through our own system", and the reason WO-1036 could remove the write into
   * the operator's UCCNC profile without losing the value for good.
   *
   * **NO MOTION.** It is a register/bookkeeping write. It does not move, does
   * not need homing, and must not sit behind the motion latch: it is callable
   * in exactly the states `zeroWorkAxis` is.
   *
   * Axes are individually optional, matching `QueuedMove`'s partial shape - an
   * omitted axis leaves that offset unchanged. A backend must validate every
   * given axis BEFORE writing any of them; a half-applied offset puts the tool
   * in a coordinate system nobody holds.
   *
   * Optional: a backend that genuinely cannot set an offset to a value says so
   * by not implementing it, rather than by accepting and doing nothing.
   */
  setWorkOffset?(wcs: WcsId, offset: Partial<MachinePosition>): Promise<SetWorkOffsetResult>
  /**
   * WO-2187: rotate one work system about its origin by `degrees` (CCW seen
   * from +Z; 0 clears it) IN THE CONTROLLER - LinuxCNC's `G10 L2 Pn R`, the
   * AXBB-E bridge's `setWorkRotation`. No motion; the controller then rotates
   * what runs in that system itself (docs/design/WCS-ROTATION.md), so the app
   * never rotates a program as well. The result is the controller's answer.
   *
   * Optional: a controller that cannot rotate a work system does not have it.
   */
  setWcsRotation?(wcs: string, degrees: number): Promise<SetWcsRotationResult>
  /**
   * WO-2187: every work system's rotation as the controller last REPORTED it
   * (degrees, 0 = none), keyed by the controller's own name for the system -
   * LinuxCNC also has G59.1 .. G59.3. A system the controller could not say is
   * absent. Null when nothing has been reported in this session.
   */
  wcsRotations?(): WcsRotations | null
  /** Probe toward an absolute machine-frame target in millimetres. A successful
   *  touch returns its contact position in that same machine frame. */
  probe(axis: JogAxis, targetMm: number, feedMmMin: number): Promise<ProbeTouch>

  // ---- commands ----
  /** One line of G-code, fire and forget. (as today) */
  sendCommand(text: string): boolean
  /** One line of G-code, resolved when the controller acknowledges. (as today) */
  sendCommandAwait(text: string): Promise<CommandAck> | null

  // ---- program ----
  /** Text path. Only meaningful when `capabilities.gcodeText`; a backend
   *  without an interpreter REFUSES, and contract v3 gives it somewhere to say
   *  so - an empty LoadResult is indistinguishable from an empty program. */
  loadJob(programText: string): LoadOutcome
  loadJobFrom(programText: string, startLine: number, prelude: string[]): LoadOutcome
  /** A pre-compiled line stream with source-line attribution, for callers that
   *  build their own program (surface-mesh compensation). Sits between the text
   *  path and the geometry path; refused by a backend with neither. Contract v3
   *  item 2 - this had no home before. */
  loadPreparedJob?(lines: StreamLine[]): LoadOutcome
  /** Geometry path - no G-code in the middle. Only when
   *  `capabilities.geometryQueue`. This is what ADR-0041 unlocks. */
  loadMoves?(moves: QueuedMove[]): { ok: boolean; reason: string | null }
  /**
   * PROGRAM path - moves AND actions, one ordered list, one job state machine
   * (ADR-0043 section 4). Only meaningful when `capabilities.machineProgram`;
   * a backend that does not declare it must still REFUSE in a sentence rather
   * than run part of a program, which is why the refusal has a channel of its
   * own instead of a bare `false`.
   *
   * Same return shape as `loadMoves` on purpose: the two are the same kind of
   * answer, and a caller that already handles one handles this.
   *
   * WO-1023 adds the member and both implementations refuse: the point of this
   * order is that there is something agnostic to CALL, not that anything can
   * yet run it. A half-run is the one outcome forbidden here - "loads but
   * cannot step, pause or stop" is exactly what WO-1019 refuses to ship.
   */
  loadProgram?(program: MachineProgram): { ok: boolean; reason: string | null }
  /**
   * Progress by STEP ID, beside `jobProgress()`'s line-shaped
   * `StreamerProgress`. Optional: a backend that cannot say which id is
   * executing does not implement it, and a caller asks with
   * `typeof ctrl.programProgress === 'function'` rather than assuming.
   *
   * A backend may implement this WITHOUT declaring `capabilities.machineProgram`
   * - reporting which id is running is a read it can already do honestly, and
   * running a whole program is not. Both geometry backends are in exactly that
   * state today.
   */
  programProgress?(): ProgramProgress
  startJob(): boolean // (as today)
  pauseJob(): void // (as today)
  resumeJob(): boolean // (as today)
  stopJob(): void // (as today)
  stepJob(): boolean // (as today)
  setSingleBlockMode(on: boolean): void // (as today)
  singleBlockMode(): boolean // (as today)
  hasActiveJob(): boolean // (as today)
  jobProgress(): StreamerProgress // (as today)
  stoppedJobProgress(): StreamerProgress | null // (as today)
}

/**
 * What a backend is handed at connect time. Deliberately a union rather than a
 * single shape: a byte pipe and a JSON message channel have nothing in common,
 * and pretending otherwise is what `unknown` was doing.
 */
export type ControllerBackend =
  /** GRBL: a byte pipe (serial, or a websocket carrying bytes). */
  | { kind: 'bytes'; transport: BytePipe }
  /** The machine bridge: a JSON message channel. */
  | { kind: 'messages'; transport: MessageChannel }
  /** Pure software - there is nothing on the other side. */
  | { kind: 'none' }

/** Contract v3: the two payloads, structurally. The union used to fix the kind
 *  and leave `transport: unknown`, which put the hole back one level. */
export interface BytePipe {
  start(events: { onChunk: (d: Uint8Array) => void; onClose: (r: string | null) => void }): Promise<void>
  write(data: Uint8Array): Promise<void>
  close(): Promise<void>
}

export interface MessageChannel {
  start(events: { onMessage: (m: unknown) => void; onClose: (r: string | null) => void }): Promise<void>
  send(message: unknown): void
  close(): Promise<void>
}

/** A load either produced a program or was refused, in a sentence. Contract v3:
 *  `LoadResult` alone could not distinguish "nothing to run" from "this
 *  controller cannot run text at all". */
export type LoadOutcome =
  | { ok: true; result: LoadResult }
  | { ok: false; reason: string }

/** Re-exported so backends and callers share one vocabulary. */
export type { GrblStatusReport, MachinePosition, MachineState, MachineVec3, WcsId, GrblParserState }
