// WO-1987: LinuxCNC as LienCAM's third controller backend (ADR-0041, ADR-0054).
//
// Speaks docs/machine/LINUXCNC-GATEWAY-PROTOCOL.md to gateway.py on the
// LinuxCNC PC. This is its OWN backend: Operator ruling 2026-09-26, "UCCNC and LinuxCNC
// are completely different software" - nothing here imports or routes through
// the UCCNC bridge's controller or transport, and nothing there changes.
//
// ADR-0048: verified in simulation (the WO-1982 LinuxCNC 2.9.4 simulator, and
// the gateway's measured fake), NOT verified on LinuxCNC hardware.
//
// Three rules shape it, all from ADR-0054:
// - A reply carries `outcome`. `unknown` (the gateway's call deadline passed)
//   is never narrated as a refusal and never resolves a boolean `true`.
// - Stops are their own path. emergencyStop, stopJob, reset, feedHold,
//   pauseJob, jogStop/jogCancel and spindleOff are sent the moment they are
//   called, whatever the link or job state says - the gateway issues them on a
//   channel no ordinary call uses.
// - LinuxCNC's state is STATUS, not a local veto. Motion is refused here only
//   when there is no connection to send it on; everything else is LinuxCNC's
//   own answer, reported in its own words.

import type {
  CommandAck,
  CommandOutcome,
  ConnectionPhase,
  ControlAxis,
  ControllerBackend,
  ControllerCapabilities,
  ControllerEvents,
  JobFault,
  JogAxis,
  JointReading,
  LoadOutcome,
  MachineController,
  MachineStatus,
  MessageChannel,
  OverrideChange,
  ProbeTouch,
  SetWcsRotationResult,
  SetWorkOffsetResult,
  StreamerProgress,
  WcsRotations,
  ZeroWorkAxisReceipt,
} from '../controller'
import { HOMED_GATE_AXES, unknownOutcomeSentence } from '../controller'
import type { MachinePosition, MachineState, WcsId } from '../types'
import type { AxisName } from '../../../types'
import { prepareProgram, type LoadResult } from '../../gcode/text'

export const LINUXCNC_GATEWAY_PROTOCOL = 1
/** Longer than the gateway's own deadline (5 s ordinary, 2 s stops), so the
 *  gateway's `unknown` - with its sentence - arrives before ours would. */
export const LINUXCNC_CALL_TIMEOUT_MS = 8000
/** homeAxes answers only after every joint has finished (gateway default
 *  --home-timeout 120 s per call), so its reply is allowed that long. */
export const LINUXCNC_HOME_TIMEOUT_MS = 130_000
export const LINUXCNC_HELLO_TIMEOUT_MS = 5000
/** WO-2099: an awaited MDI line answers only when its move ends (a G38
 *  search, a rapid to the tool setter), so it is allowed longer than the
 *  gateway's own motion cap (--motion-cap, 330 s). The gateway owns the
 *  deadline: it answers `unknown` after its --call-timeout with NO motion,
 *  and that answer arrives first. */
export const LINUXCNC_AWAITED_LINE_TIMEOUT_MS = 340_000

/** How long a refusal waits for the gateway's own console line of the same
 *  sentence (it pushes them on a 20 ms tick). */
const CONSOLE_ECHO_WAIT_MS = 250

const UNITS_WORD = /^\s*G2[01]\s*$/i
/** G38.2 .. G38.5 in a line, comments removed first (gateway.py PROBE_WORD). */
const PROBE_WORD = /G\s*0*38\s*\.\s*[2-5](?![0-9])/i

function isProbeLine(text: string): boolean {
  return PROBE_WORD.test(text.replace(/\([^)]*\)|;.*/g, ''))
}

/** The last G20/G21 word in a line, comments removed; null when it has none. */
function unitsWordIn(text: string): 'G20' | 'G21' | null {
  const words = text.replace(/\([^)]*\)|;.*/g, '').match(/G\s*0*2[01](?![0-9.])/gi)
  const last = words?.at(-1)?.replace(/\s|0(?=2)/g, '').toUpperCase()
  return last === 'G20' || last === 'G21' ? last : null
}

/** A line's code with its comments removed, and where each code character
 *  sits in the raw line. */
function codeOf(raw: string): { code: string; at: number[] } {
  let code = ''
  const at: number[] = []
  let inParen = false
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i]
    if (inParen) {
      if (ch === ')') inParen = false
      continue
    }
    if (ch === '(') {
      inParen = true
      continue
    }
    if (ch === ';') break
    code += ch
    at.push(i)
  }
  return { code, at }
}

const PAUSE_WORD = /(^|\s)(M0?0)(?=\s|$)/i
const TOOL_WORD = /(?:^|\s)T\s*\d+/i
const TOOL_LINE = /^\s*(?:N\d+\s+)?T\s*\d+\s*$/i

/**
 * WO-2100: THE PROGRAM LINUXCNC RUNS CARRIES ITS OWN M6. The session hands
 * every text controller its program with each M6 after the first move staged
 * as an `M0` hold, because a text controller has no tool change of its own to
 * stop at. LinuxCNC has one: its M6 asks iocontrol for the tool, holds the
 * program, and afterwards the tool in the spindle - and the length offset a
 * `G43` then applies - are LinuxCNC's. So a pause that is a tool change goes to
 * LinuxCNC as `M6` again: an `M0` on a line with a T word, or on the line
 * right after a bare T line. Every other pause, and every line number, is
 * unchanged; the session's hold still lands on that line (jobProgress).
 */
export function linuxcncProgramText(text: string): string {
  let previousCode = ''
  return text.split('\n').map((raw) => {
    const { code, at } = codeOf(raw)
    const pause = PAUSE_WORD.exec(code)
    let line = raw
    if (pause && (TOOL_WORD.test(code) || TOOL_LINE.test(previousCode))) {
      const first = pause.index + pause[1].length
      const start = at[first]
      const end = at[first + pause[2].length - 1] + 1
      line = raw.slice(0, start) + 'M6' + raw.slice(end)
    }
    if (code.trim() !== '') previousCode = code
    return line
  }).join('\n')
}

/** WO-2100: LinuxCNC holding a program (or an MDI line) at its M6 until the
 *  operator answers - the gateway's `linuxcnc.toolChange` status block. */
export interface LinuxcncToolChange {
  /** The tool LinuxCNC asks for (iocontrol `tool-prep-number`); 0 = none. */
  tool: number
  /** The M6's program line, in the app's numbering; null for an MDI M6. */
  line: number | null
  /** LinuxCNC's `tool_in_spindle` when it asked. */
  inSpindle: number
  /** What answers LinuxCNC's tool change in its HAL. */
  answeredBy: string | null
  /** Whether Cycle Start can answer it from here (the gateway has a pin to press). */
  canAnswer: boolean
}

function readToolChange(block: unknown): LinuxcncToolChange | null {
  if (!isRecord(block) || !isRecord(block.toolChange)) return null
  const raw = block.toolChange
  const tool = finiteOrNull(raw.tool)
  if (tool === null) return null
  const line = finiteOrNull(raw.line)
  return {
    tool,
    line: line !== null && line > 0 ? line : null,
    inSpindle: finiteOrNull(raw.inSpindle) ?? 0,
    answeredBy: typeof raw.answeredBy === 'string' ? raw.answeredBy : null,
    canAnswer: typeof raw.press === 'string',
  }
}

/** WO-2185: every work system's XY rotation as LinuxCNC holds it - the
 *  gateway's `linuxcnc.wcsRotation` status block, keyed G54 .. G59.3, degrees
 *  CCW seen from +Z (LinuxCNC's `G10 L2 Pn R`). null = LinuxCNC's value is not
 *  known to the gateway. */
export type LinuxcncWcsRotation = Readonly<Record<string, number | null>>

const APP_WCS: readonly string[] = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59'] satisfies readonly WcsId[]
function isAppWcs(wcs: string): wcs is WcsId {
  return APP_WCS.includes(wcs)
}

function readWcsRotation(block: unknown): LinuxcncWcsRotation | null {
  if (!isRecord(block) || !isRecord(block.wcsRotation)) return null
  const out: Record<string, number | null> = {}
  for (const [wcs, value] of Object.entries(block.wcsRotation)) out[wcs] = finiteOrNull(value)
  return out
}

/** WO-2185: setWcsRotation's receipt - LinuxCNC's own readback after its
 *  `G10 L2 Pn R`. WO-2187 moved the shape to the controller contract. */
export type { SetWcsRotationResult } from '../controller'

const STOP_CALLS = new Set(['emergencyStop', 'stopJob', 'reset', 'pauseJob', 'feedHold', 'jogStop', 'jogCancel', 'spindleOff'])

/** What a gateway reply says, with the third outcome always filled in. */
export interface GatewayReply {
  ok: boolean
  v: unknown
  error: string | null
  outcome: CommandOutcome
}

/** The gateway's hello (LINUXCNC-GATEWAY-PROTOCOL.md "Hello"). */
export interface LinuxcncHello {
  protocol: number
  bridge: string
  controller: string
  linuxcncVersion: string | null
  ini: string | null
  /** One letter per JOINT, `[TRAJ]COORDINATES` - a slaved gantry reads XYYZ. */
  coordinates: string
  capabilities: Record<string, unknown>
  readOnly: boolean
  /** WO-1988: the bridge protocol's own Modbus VFD block. The LinuxCNC
   *  gateway sends a constant here (it owns no VFD link; LinuxCNC owns the
   *  spindle) - never a LinuxCNC spindle fact. `null` when no `vfd` block. */
  vfd: { present: boolean; verified: boolean; name: string | null } | null
  /** WO-2097: the facts in LinuxCNC's own INI/HAL, read by the gateway per
   *  session. `null` when the gateway sent no `config` block (an older one). */
  config: LinuxcncConfig | null
}

/** An INI value exactly as the file writes it, or `null` when unset. */
type IniValue = string | null

/** WO-2097: `hello.config` (gateway.py `Lcnc.read_config`). INI values stay
 *  the INI's own strings in the INI's own units: never converted, never
 *  filled in. */
export interface LinuxcncConfig {
  ini: string | null
  linearUnits: IniValue
  angularUnits: IniValue
  /** `[AXIS_<L>]` per axis letter; `units` is LINEAR_UNITS or ANGULAR_UNITS. */
  axes: { axis: string; units: IniValue; minLimit: IniValue; maxLimit: IniValue; maxVelocity: IniValue }[]
  /** `[SPINDLE_<n>]`, RPM, for each of `[TRAJ]SPINDLES`. */
  spindles: {
    spindle: number
    maxForwardVelocity: IniValue
    minForwardVelocity: IniValue
    maxReverseVelocity: IniValue
    minReverseVelocity: IniValue
  }[]
  /** The running HAL's links for the standard I/O pins (`halcmd -s show`). */
  io: {
    read: boolean
    error: string | null
    pins: {
      group: string
      pin: string
      inHal: boolean
      dir: string | null
      signal: string | null
      /** halcmd's own arrows, relative to the signal. */
      linked: { arrow: string; pin: string }[]
    }[]
  }
}

/** LinuxCNC's own program line numbers, in the APP's program numbering
 *  (the gateway maps a run-from-line file back; a set-up line reads 0). */
export interface LinuxcncLines {
  motionLine: number
  currentLine: number
  readLine: number
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
  inputs: null,
  homed: null,
  spindle: null,
}

const EMPTY_PROGRESS: StreamerProgress = {
  phase: 'empty',
  totalLines: 0,
  sentLines: 0,
  ackedLines: 0,
  ackedSourceLine: 0,
  sentSourceLine: 0,
  bytesInFlight: 0,
}

const AXIS_LETTERS: readonly AxisName[] = ['X', 'Y', 'Z', 'A', 'B', 'C']

interface PendingCall {
  resolve: (reply: GatewayReply) => void
  timer: ReturnType<typeof setTimeout>
  method: string
  timeoutMs: number
}

type LoadState =
  | { kind: 'none' }
  | { kind: 'pending'; verdict: Promise<{ ok: boolean; reason: string | null }> }
  | { kind: 'accepted' }
  | { kind: 'refused'; reason: string }
  /** No answer by the deadline: LinuxCNC may or may not have opened it. */
  | { kind: 'unknown'; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function readOutcome(value: unknown): CommandOutcome | null {
  return value === 'accepted' || value === 'refused' || value === 'unknown' ? value : null
}

function readPosition(value: unknown): MachinePosition | null {
  if (!isRecord(value)) return null
  const x = finiteOrNull(value.x)
  const y = finiteOrNull(value.y)
  const z = finiteOrNull(value.z)
  if (x === null || y === null || z === null) return null
  const position: MachinePosition = { x, y, z }
  for (const key of ['a', 'b', 'c'] as const) {
    const rotary = finiteOrNull(value[key])
    if (rotary !== null) position[key] = rotary
  }
  return position
}

function readAxisLetter(value: unknown): AxisName | null {
  return typeof value === 'string' && (AXIS_LETTERS as readonly string[]).includes(value.toUpperCase())
    ? value.toUpperCase() as AxisName
    : null
}

/** `linuxcnc.joints` -> the contract's JointReading (ADR-0054 item 4). */
function readJoints(block: unknown): JointReading[] | null {
  if (!isRecord(block) || !Array.isArray(block.joints)) return null
  return block.joints.filter(isRecord).map((joint, fallback) => ({
    index: finiteOrNull(joint.joint) ?? fallback,
    axis: readAxisLetter(joint.axis),
    position: finiteOrNull(joint.position),
    homed: typeof joint.homed === 'boolean' ? joint.homed : null,
  }))
}

/** WO-1988: `hello.vfd`, the bridge protocol's VFD block (LINUXCNC-GATEWAY-
 *  PROTOCOL.md "Hello"). Absent or malformed reads as `null` - "the gateway
 *  did not say" - never as "no spindle". */
function readVfdInfo(value: unknown): LinuxcncHello['vfd'] {
  if (!isRecord(value)) return null
  return {
    present: value.present === true,
    verified: value.verified === true,
    name: typeof value.name === 'string' ? value.name : null,
  }
}

function iniValue(value: unknown): IniValue {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

/** WO-2097: `hello.config`. Absent or malformed reads as `null`; a missing
 *  key inside it reads as unset - never a guessed value. */
function readConfig(value: unknown): LinuxcncConfig | null {
  if (!isRecord(value)) return null
  const io = isRecord(value.io) ? value.io : {}
  return {
    ini: iniValue(value.ini),
    linearUnits: iniValue(value.linearUnits),
    angularUnits: iniValue(value.angularUnits),
    axes: (Array.isArray(value.axes) ? value.axes : []).filter(isRecord).map((axis) => ({
      axis: typeof axis.axis === 'string' ? axis.axis : '?',
      units: iniValue(axis.units),
      minLimit: iniValue(axis.minLimit),
      maxLimit: iniValue(axis.maxLimit),
      maxVelocity: iniValue(axis.maxVelocity),
    })),
    spindles: (Array.isArray(value.spindles) ? value.spindles : []).filter(isRecord).map((spindle, fallback) => ({
      spindle: finiteOrNull(spindle.spindle) ?? fallback,
      maxForwardVelocity: iniValue(spindle.MAX_FORWARD_VELOCITY),
      minForwardVelocity: iniValue(spindle.MIN_FORWARD_VELOCITY),
      maxReverseVelocity: iniValue(spindle.MAX_REVERSE_VELOCITY),
      minReverseVelocity: iniValue(spindle.MIN_REVERSE_VELOCITY),
    })),
    io: {
      read: io.read === true,
      error: typeof io.error === 'string' ? io.error : null,
      pins: (Array.isArray(io.pins) ? io.pins : []).filter(isRecord).map((pin) => ({
        group: typeof pin.group === 'string' ? pin.group : '',
        pin: typeof pin.pin === 'string' ? pin.pin : '?',
        inHal: pin.inHal === true,
        dir: typeof pin.dir === 'string' ? pin.dir : null,
        signal: typeof pin.signal === 'string' ? pin.signal : null,
        linked: (Array.isArray(pin.linked) ? pin.linked : []).filter(isRecord)
          .filter((end) => typeof end.arrow === 'string' && typeof end.pin === 'string')
          .map((end) => ({ arrow: end.arrow as string, pin: end.pin as string })),
      })),
    },
  }
}

function readLines(block: unknown): LinuxcncLines | null {
  if (!isRecord(block)) return null
  const motionLine = finiteOrNull(block.motionLine)
  const currentLine = finiteOrNull(block.currentLine)
  const readLine = finiteOrNull(block.readLine)
  if (motionLine === null || currentLine === null || readLine === null) return null
  return { motionLine, currentLine, readLine }
}

const MACHINE_STATES = new Set<MachineState>(['unknown', 'idle', 'run', 'hold', 'jog', 'alarm', 'door', 'check', 'home', 'sleep'])

/** A gateway status frame, as the contract's MachineStatus. The gateway sends
 *  `MachineStatus` exactly; this keeps its nulls and adds the joint vector. */
function readStatus(raw: Record<string, unknown>): MachineStatus {
  const state = typeof raw.state === 'string' && MACHINE_STATES.has(raw.state as MachineState)
    ? raw.state as MachineState
    : 'unknown'
  const status: MachineStatus = {
    state,
    subState: finiteOrNull(raw.subState),
    machinePos: readPosition(raw.machinePos),
    workPos: readPosition(raw.workPos),
    feedMmMin: finiteOrNull(raw.feedMmMin),
    spindleRpm: finiteOrNull(raw.spindleRpm),
    overrides: isRecord(raw.overrides)
      ? {
          feed: finiteOrNull(raw.overrides.feed),
          rapid: finiteOrNull(raw.overrides.rapid),
          spindle: finiteOrNull(raw.overrides.spindle),
        }
      : null,
    executingMoveId: null,
    buffer: isRecord(raw.buffer)
      ? { moves: finiteOrNull(raw.buffer.moves), capacitySeconds: finiteOrNull(raw.buffer.capacitySeconds) }
      : null,
    inputs: isRecord(raw.inputs) ? raw.inputs as MachineStatus['inputs'] : null,
    homed: isRecord(raw.homed) ? raw.homed as MachineStatus['homed'] : null,
    spindle: null,
  }
  // Absent `linuxcnc` block = a status read that failed (pollError): the
  // gateway reports joints, but not this frame -> null, never [].
  status.joints = readJoints(raw.linuxcnc)
  return status
}

export class LinuxCncController implements MachineController {
  private _capabilities: ControllerCapabilities = {
    geometryQueue: false,
    executingMoveId: false,
    bufferSeconds: false,
    gcodeText: false,
    perAxisHoming: false,
    ownsSpindle: false,
    spindleCommands: false,
  }

  private transport: MessageChannel | null = null
  private generation = 0
  private phase: ConnectionPhase = 'disconnected'
  private hello: LinuxcncHello | null = null
  private helloWaiter: ((hello: LinuxcncHello | null) => void) | null = null
  private versionText: string | null = null
  private lastStatus: MachineStatus | null = null
  private lastLines: LinuxcncLines | null = null
  /** WO-2100: LinuxCNC waiting at an M6, from the last status frame. */
  private toolChangeWait: LinuxcncToolChange | null = null
  /** WO-2185: each work system's rotation, from the last status frame. */
  private wcsRotation: LinuxcncWcsRotation | null = null
  /** WO-2204: the active work system (LinuxCNC's g5x_index, 1 = G54), from
   *  the last status frame. */
  private wcsIndex: number | null = null
  private seq = 0
  private pending = new Map<number, PendingCall>()
  /** Axes the app revoked (a travel change, a position-lost alarm). LinuxCNC's
   *  own homed bit is the datum; a revoked axis stays unhomed HERE until
   *  LinuxCNC reports a fresh homing of it. */
  private revoked = new Set<JogAxis>()
  private resetting = false
  private resetListeners = new Set<() => void>()
  private resetPromise: Promise<{ ok: boolean; reason: string | null; outcome?: CommandOutcome }> | null = null
  /** A G20/G21 that arrived while LinuxCNC could not take MDI (see sendCommand). */
  private heldUnitsWord: string | null = null
  /** The gateway's last console lines, so a refusal quoting one is not repeated. */
  private recentConsole: string[] = []
  /** WO-2099: LinuxCNC's reading after the last G38 line it ran to its end. */
  private lastProbe: { tripped: boolean; at: MachinePosition } | null = null
  /** WO-2099: the units word LienCAM last sent LinuxCNC, so probe() - whose
   *  line is in G21 - puts it back. */
  private unitsWord: 'G20' | 'G21' | null = null

  // ---- job ----
  private load: LoadState = { kind: 'none' }
  private loaded: LoadResult | null = null
  private jobActive = false
  private jobStarted = false
  /** LinuxCNC ran the loaded program to its end (the gateway's `completed`). */
  private jobCompleted = false
  private singleBlock = false
  private lastProgramLine = 0
  private stoppedProgress: StreamerProgress | null = null
  private lastPublishedProgress = ''

  private readonly events: ControllerEvents

  constructor(events: ControllerEvents) {
    this.events = events
  }

  get capabilities(): ControllerCapabilities {
    return this._capabilities
  }

  /** The gateway's hello, while connected - LinuxCNC's version, INI and joint
   *  letters. Not the UCCNC bridge's hello: that shape is UCCNC's. */
  linuxcncHello(): LinuxcncHello | null {
    return this.phase === 'connected' ? this.hello : null
  }

  /** LinuxCNC's own line numbers from the last status frame. */
  linuxcncLines(): LinuxcncLines | null {
    return this.lastLines
  }

  /** WO-2100: the tool change LinuxCNC is holding for, or null. Cycle Start
   *  (resumeJob / cycleResume) answers it: the gateway presses LinuxCNC's own
   *  tool-changed answer, and LinuxCNC continues with that tool. */
  linuxcncToolChange(): LinuxcncToolChange | null {
    return this.toolChangeWait
  }

  /** WO-2185: each work system's XY rotation as LinuxCNC reported it in the
   *  last status frame - including one LinuxCNC restored from its parameter
   *  file before LienCAM connected. null before the first frame. */
  linuxcncWcsRotation(): LinuxcncWcsRotation | null {
    return this.wcsRotation
  }

  /** WO-2187: the same report in the controller contract's terms - every
   *  system LinuxCNC said a number for (G59.1 .. G59.3 included); one it could
   *  not say is left out, never read as 0. */
  wcsRotations(): WcsRotations | null {
    if (!this.wcsRotation) return null
    const out: Record<string, number> = {}
    for (const [wcs, deg] of Object.entries(this.wcsRotation)) if (deg !== null) out[wcs] = deg
    return out
  }

  // ---- lifecycle ----

  async connect(backend: ControllerBackend): Promise<void> {
    if (this.phase !== 'disconnected') throw new Error('Already connected or connecting')
    if (backend.kind !== 'messages') {
      throw new Error('LinuxCncController.connect needs the LinuxCNC gateway socket (gatewayTransport.ts).')
    }
    const transport = backend.transport
    const generation = ++this.generation
    this.hello = null
    this.transport = transport
    this.setPhase('connecting', null)
    try {
      const helloArrived = this.waitForHello(LINUXCNC_HELLO_TIMEOUT_MS)
      await transport.start({
        onMessage: (message) => {
          if (generation === this.generation) this.handleMessage(message)
        },
        onClose: (reason) => {
          if (generation === this.generation) this.teardown(reason ?? 'The LinuxCNC gateway closed the connection.')
        },
      })
      const hello = this.hello ?? await helloArrived
      if (!hello) throw new Error('The LinuxCNC gateway never sent its hello frame.')
      if (hello.protocol !== LINUXCNC_GATEWAY_PROTOCOL) {
        throw new Error(
          `This LienCAM speaks LinuxCNC gateway protocol ${LINUXCNC_GATEWAY_PROTOCOL}, but ${hello.bridge} `
            + `speaks protocol ${hello.protocol}. Update gateway.py or LienCAM so they match.`,
        )
      }
      if (hello.controller !== 'linuxcnc') {
        throw new Error(
          `The program on that socket says it drives "${hello.controller}", not LinuxCNC. `
            + 'Is another bridge running on the LinuxCNC gateway port?',
        )
      }
      this._capabilities = this.readCapabilities(hello)
      this.versionText = hello.linuxcncVersion ? `LinuxCNC ${hello.linuxcncVersion}` : hello.bridge
      this.setPhase('connected', this.versionText)
      this.events.onReady?.(this.versionText)
      this.events.onConsole?.({
        dir: 'rx',
        text: `Connected to LinuxCNC${hello.linuxcncVersion ? ` ${hello.linuxcncVersion}` : ''} through ${hello.bridge}`
          + `${hello.ini ? ` (${hello.ini})` : ''}. LinuxCNC support is verified on the LinuxCNC simulator, not yet on LinuxCNC hardware.`,
        severity: 'info',
      })
      if (this.lastStatus) this.events.onStatus?.(this.lastStatus)
    } catch (error) {
      if (generation === this.generation) await this.disconnect()
      throw error
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
    return this.versionText
  }

  // ---- state ----

  machineState(): MachineState {
    return this.lastStatus?.state ?? 'unknown'
  }

  status(): MachineStatus {
    return this.lastStatus ?? UNKNOWN_STATUS
  }

  queryStatus(): void {
    this.fire('queryStatus', {})
  }

  refreshState(): boolean {
    if (!this.connected()) return false
    this.queryStatus()
    return true
  }

  /** The gateway has no settings dump: LinuxCNC's INI configures the machine. */
  querySettings(): boolean {
    return false
  }

  verifiedIdle(): boolean {
    return this.connected() && this.lastStatus?.state === 'idle'
  }

  homedThisSession(): boolean {
    const homed = this.homedAxesThisSession()
    return HOMED_GATE_AXES.every((axis) => homed[axis] === true)
  }

  /** LinuxCNC keeps a real homed bit per joint (the gateway folds every joint
   *  behind a letter into it), so this reads the controller, minus any axis
   *  the app revoked since LinuxCNC last homed it. */
  homedAxesThisSession(): Partial<Record<JogAxis, boolean>> {
    const reported = this.lastStatus?.homed ?? null
    const out: Partial<Record<JogAxis, boolean>> = {}
    for (const axis of HOMED_GATE_AXES) {
      out[axis] = this.connected() && reported?.[axis] === true && !this.revoked.has(axis)
    }
    return out
  }

  invalidateDatum(axes: readonly JogAxis[] | null): void {
    for (const axis of axes ?? HOMED_GATE_AXES) this.revoked.add(axis)
  }

  resetInProgress(): boolean {
    return this.resetting
  }

  subscribeResetInProgress(listener: () => void): () => void {
    this.resetListeners.add(listener)
    return () => this.resetListeners.delete(listener)
  }

  // ---- motion ----

  jog(axis: ControlAxis, deltaMm: number, feedMmMin: number): boolean {
    return this.fireIfConnected('jog', { axis, deltaMm, feedMmMin })
  }

  jogToWorkXY(x: number, y: number, feedMmMin: number): boolean {
    return this.fireIfConnected('jogToWorkXY', { x, y, feedMmMin })
  }

  jogToMachineZ(z: number, feedMmMin: number): boolean {
    return this.fireIfConnected('jogToMachineZ', { z, feedMmMin })
  }

  jogToWorkXYAwait(x: number, y: number, feedMmMin: number): Promise<boolean> | null {
    return this.awaitBoolean('jogToWorkXY', { x, y, feedMmMin })
  }

  jogToMachineZAwait(z: number, feedMmMin: number): Promise<boolean> | null {
    return this.awaitBoolean('jogToMachineZ', { z, feedMmMin })
  }

  jogCancel(): void {
    this.stop('jogCancel')
  }

  /** The gateway's wire name is `jogStart` (LINUXCNC-GATEWAY-PROTOCOL.md). It
   *  arms the gateway's own jog deadman: `jogHold` keeps it alive, and when the
   *  holds stop arriving the GATEWAY stops the axis. */
  async jogStartContinuous(axis: ControlAxis, direction: 1 | -1, feedMmMin: number): Promise<boolean> {
    if (!this.connected()) return false
    const reply = await this.call('jogStart', { axis, direction, feedMmMin })
    this.reportFailure('jogStart', reply)
    return reply.ok && reply.outcome === 'accepted' && reply.v === true
  }

  jogHold(): void {
    if (!this.transport) return
    this.sendRaw('jogHold', {})
  }

  jogStop(): void {
    this.stop('jogStop')
  }

  home(): boolean {
    if (!this.connected()) return false
    void this.call('home', {}, LINUXCNC_CALL_TIMEOUT_MS).then((reply) => this.reportFailure('home', reply))
    return true
  }

  homeAxes(axes: AxisName[]): boolean {
    if (!this.connected()) return false
    void this.call('homeAxes', { axes }, LINUXCNC_HOME_TIMEOUT_MS).then((reply) => this.reportFailure('homeAxes', reply))
    return true
  }

  // ---- authority ----

  feedHold(): void {
    this.stop('feedHold')
  }

  cycleResume(): boolean {
    return this.fireIfConnected('cycleResume', {})
  }

  reset(): void {
    this.endJobLocally()
    this.stop('reset')
  }

  unlock(): boolean {
    return this.fireIfConnected('unlock', {})
  }

  /** Never gated (ADR-0054 item 3): sent whenever a socket exists at all,
   *  before any bookkeeping, on the gateway's stop channel. */
  emergencyStop(): void {
    this.stop('emergencyStop')
  }

  resetToIdle(): Promise<{ ok: boolean; reason: string | null; outcome?: CommandOutcome }> {
    if (this.resetPromise) return this.resetPromise
    if (!this.connected()) {
      return Promise.resolve({ ok: false, reason: 'Not connected to LinuxCNC.', outcome: 'refused' })
    }
    this.setResetting(true)
    this.resetPromise = this.call('resetToIdle', {}).then((reply) => {
      const value = isRecord(reply.v) ? reply.v : null
      const ok = reply.ok && reply.outcome === 'accepted' && value?.ok === true
      const reason = ok
        ? null
        : typeof value?.reason === 'string' ? value.reason : reply.error ?? 'LinuxCNC did not come out of E-STOP.'
      if (ok) this.endJobLocally()
      return { ok, reason, outcome: ok ? 'accepted' as const : reply.outcome === 'unknown' ? 'unknown' as const : 'refused' as const }
    }).finally(() => {
      this.resetPromise = null
      this.setResetting(false)
    })
    return this.resetPromise
  }

  setOverride(change: OverrideChange): void {
    this.fire('setOverride', { change })
  }

  spindleOn(direction: 'cw' | 'ccw', rpm: number): boolean {
    return this.fireIfConnected('spindleOn', { direction, rpm })
  }

  /** Never gated. */
  spindleOff(): void {
    this.stop('spindleOff')
  }

  // ---- setup ----

  selectWcs(wcs: WcsId): boolean {
    return this.fireIfConnected('selectWcs', { wcs })
  }

  selectWcsAwait(wcs: WcsId): Promise<boolean> | null {
    return this.awaitBoolean('selectWcs', { wcs })
  }

  zeroWorkAxis(axis: ControlAxis): boolean {
    return this.zeroWorkAxisAwait(axis) !== null
  }

  /** LinuxCNC HAS the offset register the AXBB-E lacks, so the receipt's
   *  `offset` is a READBACK (`G10 L20`, then the register read back). */
  zeroWorkAxisAwait(axis: ControlAxis): Promise<ZeroWorkAxisReceipt> | null {
    if (!this.connected()) return null
    return this.call('zeroWorkAxis', { axis }).then((reply) => {
      this.reportFailure('zeroWorkAxis', reply)
      const value = isRecord(reply.v) ? reply.v : null
      const confirmed = reply.ok && reply.outcome === 'accepted' && value?.ok === true
      const receipt: ZeroWorkAxisReceipt = { confirmed, outcome: confirmed ? 'accepted' : reply.outcome === 'unknown' ? 'unknown' : 'refused' }
      if (!confirmed) return receipt
      const wcs = typeof value?.wcs === 'string' ? value.wcs as WcsId : undefined
      const offset = readPosition(value?.offset)
      if (wcs) receipt.wcs = wcs
      if (offset) receipt.offset = offset
      if (wcs && offset) this.reportOffset(wcs, offset)
      return receipt
    })
  }

  async setWorkOffset(wcs: WcsId, offset: Partial<MachinePosition>): Promise<SetWorkOffsetResult> {
    if (!this.connected()) return { ok: false, reason: 'Not connected to LinuxCNC.', offset: null, outcome: 'refused' }
    const args: Record<string, unknown> = { wcs }
    for (const axis of ['x', 'y', 'z'] as const) {
      const value = offset[axis]
      if (value === undefined) continue
      if (!Number.isFinite(value)) {
        return { ok: false, reason: `${axis.toUpperCase()} ${String(value)} is not a number.`, offset: null, outcome: 'refused' }
      }
      args[axis] = value
    }
    const rotary = (['a', 'b', 'c'] as const).filter((axis) => offset[axis] !== undefined)
    if (rotary.length > 0) {
      return {
        ok: false,
        reason: `The LinuxCNC gateway sets X, Y and Z work offsets; ${rotary.map((a) => a.toUpperCase()).join(', ')} was not written.`,
        offset: null,
        outcome: 'refused',
      }
    }
    const reply = await this.call('setWorkOffset', args)
    const value = isRecord(reply.v) ? reply.v : null
    const ok = reply.ok && reply.outcome === 'accepted' && value?.ok === true
    const readback = ok ? readPosition(value?.offset) : null
    if (ok && readback) this.reportOffset(wcs, readback)
    return {
      ok,
      reason: ok ? null : typeof value?.reason === 'string' ? value.reason : reply.error ?? 'LinuxCNC did not set the work offset.',
      offset: readback,
      outcome: ok ? 'accepted' : reply.outcome === 'unknown' ? 'unknown' : 'refused',
    }
  }

  /** WO-2185: rotate a work system about its origin by `degrees` (CCW seen
   *  from +Z) with LinuxCNC's own `G10 L2 Pn R` - its X Y Z stay as they were;
   *  0 clears it. LinuxCNC then rotates program moves, arcs, probe moves and
   *  the work position itself, saves the rotation in its parameter file and
   *  restores it at startup (measured, docs/design/WCS-ROTATION.md). On the
   *  wire it is the bridge vocabulary's setWorkOffset with `r` (degrees) -
   *  one G10 line, as LinuxCNC's own. The result is LinuxCNC's readback. */
  async setWcsRotation(wcs: string, degrees: number): Promise<SetWcsRotationResult> {
    if (!this.connected()) return { ok: false, reason: 'Not connected to LinuxCNC.', rotationDeg: null, offset: null, outcome: 'refused' }
    if (!Number.isFinite(degrees)) {
      return { ok: false, reason: `A rotation of ${String(degrees)} is not a number of degrees.`, rotationDeg: null, offset: null, outcome: 'refused' }
    }
    const reply = await this.call('setWorkOffset', { wcs, r: degrees })
    const value = isRecord(reply.v) ? reply.v : null
    const ok = reply.ok && reply.outcome === 'accepted' && value?.ok === true
    const readback = ok ? readPosition(value?.offset) : null
    // WO-2187: G59.1 .. G59.3 can be rotated too; the app's offset table has
    // rows for G54 .. G59 only.
    if (ok && readback && isAppWcs(wcs)) this.reportOffset(wcs, readback)
    return {
      ok,
      reason: ok ? null : typeof value?.reason === 'string' ? value.reason : reply.error ?? 'LinuxCNC did not set the work rotation.',
      rotationDeg: ok ? finiteOrNull(value?.rotation) : null,
      offset: readback,
      outcome: ok ? 'accepted' : reply.outcome === 'unknown' ? 'unknown' : 'refused',
    }
  }

  /** WO-2185: clear a work system's rotation - `G10 L2 Pn R0`, the one thing
   *  that clears it on LinuxCNC (measured). */
  clearWcsRotation(wcs: string): Promise<SetWcsRotationResult> {
    return this.setWcsRotation(wcs, 0)
  }

  /** WO-2099: LinuxCNC's own G38.2, toward an absolute MACHINE target - what
   *  the Routines run panel (runProbeRoutine) calls for every touch, on any
   *  controller. G38 takes no G53, so the move is relative from the machine
   *  position LinuxCNC last reported. WO-2204: LinuxCNC turns a G91 move by
   *  the active work system's rotation (`G10 L2 Pn R`), so under a rotation
   *  the machine-axis distance goes out as the work-frame X Y that LinuxCNC
   *  turns back onto that machine axis. A touch ends AT the contact (below);
   *  afterwards distance mode is G90 again and
   *  units are the word LienCAM last sent (G20 stays G20). The contact is
   *  LinuxCNC's `probed_position` (machine coordinates, measured). A miss - the
   *  move ended without the probe input tripping - is `{ok:false, at:null}`
   *  with no reason; anything else not done carries LinuxCNC's sentence, or
   *  says why nothing was sent: no link, or no position to move from. */
  async probe(axis: JogAxis, targetMm: number, feedMmMin: number): Promise<ProbeTouch> {
    const from = this.lastStatus?.machinePos?.[axis.toLowerCase() as 'x' | 'y' | 'z']
    const known = typeof from === 'number' && Number.isFinite(from)
    const units = this.unitsWord
    const ack = known
      ? await this.sendCommandAwait(`G21 G91 G38.2 ${this.machineAxisWords(axis, targetMm - from)} F${Number(feedMmMin.toFixed(3))}`)
      : null
    const tripped = ack?.ok ? this.lastProbe : null
    if (tripped?.tripped) {
      // LinuxCNC decelerates PAST the trip point (measured: 0.06 mm at
      // 300 mm/min), so it goes back to the latched contact along the probed
      // axis - away from the part - as LinuxCNC's own probe macros do. The
      // touch then stands where it says it touched, which is what the routine
      // runner's retract and back-off are planned from.
      const back = tripped.at[axis.toLowerCase() as 'x' | 'y' | 'z']
      await this.sendCommandAwait(`G21 G90 G53 G0 ${axis}${Number(back.toFixed(4))}`)
    }
    if (ack) {
      this.unitsWord = units
      this.fire('sendCommand', { text: units === 'G20' ? 'G90 G20' : 'G90' })
    }
    const touch = this.lastProbe
    if (ack?.ok && touch?.tripped) return { ok: true, at: touch.at, outcome: 'accepted' }
    if (ack && touch && !touch.tripped) return { ok: false, at: null, outcome: 'accepted' }
    if (ack) return { ok: false, at: null, reason: ack.message ?? undefined, outcome: ack.outcome === 'unknown' ? 'unknown' : 'refused' }
    const why = this.connected() ? 'LinuxCNC has not reported its machine position' : 'not connected to LinuxCNC'
    return { ok: false, at: null, reason: `probe ${axis} to machine ${targetMm} at ${feedMmMin} mm/min was not sent: ${why}.`, outcome: 'refused' }
  }

  /** WO-2204: the G91 words that move `distanceMm` along MACHINE `axis`.
   *  LinuxCNC runs an incremental X Y as Rot(R)(x, y) in the machine frame
   *  (R = the active system's rotation, measured on the WO-1982 simulator),
   *  so the words are Rot(-R) of the machine step. Z, and any axis with no
   *  rotation, is the one word it always was. */
  private machineAxisWords(axis: JogAxis, distanceMm: number): string {
    const word = (letter: string, mm: number) => `${letter}${Number(mm.toFixed(4))}`
    const deg = this.activeWcsRotationDeg()
    if (axis === 'Z' || deg === 0) return word(axis, distanceMm)
    const a = (deg * Math.PI) / 180
    const [mx, my] = axis === 'X' ? [distanceMm, 0] : [0, distanceMm]
    return `${word('X', mx * Math.cos(a) + my * Math.sin(a))} ${word('Y', -mx * Math.sin(a) + my * Math.cos(a))}`
  }

  /** WO-2204: the active work system's XY rotation as LinuxCNC reported it
   *  (its stat.rotation_xy); 0 when the status carries none. */
  private activeWcsRotationDeg(): number {
    const index = this.wcsIndex
    if (index === null || !this.wcsRotation) return 0
    const wcs = ['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'G59.1', 'G59.2', 'G59.3'][index - 1]
    return (wcs && this.wcsRotation[wcs]) || 0
  }

  // ---- commands ----

  /** One MDI line. A units word (G20/G21 - the Control page syncs one the
   *  moment the link connects) cannot run while LinuxCNC is in E-STOP or off:
   *  it takes no MDI then ("Can't run MDI when the machine is not on",
   *  measured). Only while LinuxCNC cannot take MDI at all (E-STOP/off, or no
   *  status yet) is the word held; it is sent on the first idle status - after
   *  a reset, typically. A held word goes before any later line once LinuxCNC
   *  can take MDI, so the order the lines were typed in is the order LinuxCNC
   *  runs them. A line sent while it still cannot (a Flood press in E-STOP)
   *  goes out as typed - LinuxCNC refuses it itself - and the word stays held:
   *  sent into E-STOP it would be refused and lost (WO-1987 review round 2). */
  sendCommand(text: string): boolean {
    if (!this.connected()) return false
    this.unitsWord = unitsWordIn(text) ?? this.unitsWord
    if (UNITS_WORD.test(text)) {
      if (this.mdiUnavailable()) {
        this.heldUnitsWord = text.trim().toUpperCase()
        return true
      }
      this.heldUnitsWord = null
    } else {
      this.flushHeldUnitsWord()
    }
    this.fire('sendCommand', { text })
    return true
  }

  /** LinuxCNC takes no MDI at all: E-STOP/off (`alarm`), or no status yet. */
  private mdiUnavailable(): boolean {
    const state = this.lastStatus?.state
    return state === undefined || state === 'unknown' || state === 'alarm'
  }

  /** Sends a held units word, but only once LinuxCNC can take it. */
  private flushHeldUnitsWord(): void {
    const units = this.heldUnitsWord
    if (!units || this.mdiUnavailable()) return
    this.heldUnitsWord = null
    this.fire('sendCommand', { text: units })
  }

  /** WO-2099: a line waits for its move to end (LINUXCNC_AWAITED_LINE_TIMEOUT_MS),
   *  and a G38 line's reply `probe` block - LinuxCNC's `probe_tripped` and
   *  `probed_position` - is raised as the PRB offset entry BEFORE the ack
   *  resolves, exactly where a text controller's [PRB] report lands: the
   *  session's G38 route reads the contact from it. */
  sendCommandAwait(text: string): Promise<CommandAck> | null {
    if (!this.connected()) return null
    this.flushHeldUnitsWord()
    this.unitsWord = unitsWordIn(text) ?? this.unitsWord
    const probeLine = isProbeLine(text)
    if (probeLine) this.lastProbe = null
    const generation = this.generation
    return this.call('sendCommandAwait', { text }, LINUXCNC_AWAITED_LINE_TIMEOUT_MS).then((reply) => {
      const value = isRecord(reply.v) ? reply.v : null
      const ok = reply.ok && reply.outcome === 'accepted' && value?.ok === true
      const message = typeof value?.message === 'string' ? value.message : reply.error
      const probe = probeLine && isRecord(value?.probe) ? value.probe : null
      const at = probe ? readPosition(probe.at) : null
      if (probe && at && generation === this.generation) {
        this.lastProbe = { tripped: probe.tripped === true, at }
        this.events.onOffset?.({ label: 'PRB', values: [at.x, at.y, at.z], probeSuccess: probe.tripped === true })
      }
      return { ok, message: message ?? null, outcome: ok ? 'accepted' : reply.outcome === 'unknown' ? 'unknown' : 'refused' }
    })
  }

  // ---- program ----

  /** LinuxCNC takes a FILE: the gateway writes the text to its program
   *  directory and opens it. The line list here is the app's own reading of
   *  the same text (for progress and run-from-line); LinuxCNC has no 80-char
   *  line buffer, so no line is overlong on this controller. */
  loadJob(programText: string): LoadOutcome {
    return this.sendLoad('loadJob', { programText: linuxcncProgramText(programText) }, prepareProgram(programText))
  }

  loadJobFrom(programText: string, startLine: number, prelude: string[]): LoadOutcome {
    const whole = prepareProgram(programText)
    const from: LoadResult = {
      ...whole,
      lines: whole.lines.filter((line) => line.sourceLine >= startLine),
    }
    return this.sendLoad('loadJobFrom', { programText: linuxcncProgramText(programText), startLine, prelude }, from)
  }

  /** The gateway's answer to the load just sent - read structurally by
   *  machineSession (`boardLoadVerdict`). Resolves `ok:false` only on an
   *  explicit refusal; an unanswered load is not a refusal. */
  stagedLoadVerdict(): Promise<{ ok: boolean; reason: string | null }> | null {
    return this.load.kind === 'pending' ? this.load.verdict : null
  }

  /** Never starts a file LinuxCNC did not accept: a start sent after a refused
   *  load would run the PREVIOUS program still open in LinuxCNC. */
  startJob(): boolean {
    return this.startOrStep('startJob')
  }

  pauseJob(): void {
    this.stop('pauseJob')
  }

  resumeJob(): boolean {
    return this.fireIfConnected('resumeJob', {})
  }

  stopJob(): void {
    this.endJobLocally()
    this.stop('stopJob')
  }

  stepJob(): boolean {
    return this.startOrStep('stepJob')
  }

  setSingleBlockMode(on: boolean): void {
    this.singleBlock = on
    this.fire('setSingleBlockMode', { on })
  }

  singleBlockMode(): boolean {
    return this.singleBlock
  }

  hasActiveJob(): boolean {
    return this.jobActive
  }

  /** A text controller: progress is LinuxCNC's `motion_line` - the line whose
   *  MOTION is executing, measured on the WO-1982 simulator - in the app's
   *  numbering. A set-up line of a run from line reads 0 and is ignored. */
  jobProgress(): StreamerProgress {
    const loaded = this.loaded
    if (!loaded) return EMPTY_PROGRESS
    const total = loaded.lines.length
    const line = this.jobStarted ? this.lastProgramLine : 0
    const acked = this.jobCompleted
      ? total
      : line > 0 ? loaded.lines.filter((entry) => entry.sourceLine < line).length : 0
    return {
      phase: this.jobCompleted ? 'complete' : this.jobActive ? 'streaming' : 'ready',
      totalLines: total,
      sentLines: total,
      ackedLines: acked,
      ackedSourceLine: line,
      sentSourceLine: line,
      bytesInFlight: 0,
    }
  }

  stoppedJobProgress(): StreamerProgress | null {
    return this.stoppedProgress
  }

  // ---- internals ----

  private connected(): boolean {
    return this.phase === 'connected' && this.transport !== null
  }

  private readCapabilities(hello: LinuxcncHello): ControllerCapabilities {
    const declared = hello.capabilities
    const flag = (key: string) => declared[key] === true
    const capabilities: ControllerCapabilities = {
      geometryQueue: flag('geometryQueue'),
      executingMoveId: flag('executingMoveId'),
      bufferSeconds: flag('bufferSeconds'),
      gcodeText: flag('gcodeText'),
      perAxisHoming: flag('perAxisHoming'),
      ownsSpindle: flag('ownsSpindle'),
      spindleCommands: flag('spindleCommands'),
    }
    // ADR-0054 item 4: more joints than letters (a slaved gantry, XYYZ).
    const letters = hello.coordinates.toUpperCase().split('')
    if (new Set(letters).size !== letters.length) capabilities.nonIdentityJoints = true
    return capabilities
  }

  private startOrStep(method: 'startJob' | 'stepJob'): boolean {
    if (!this.connected()) return false
    const load = this.load
    if (load.kind === 'none' || load.kind === 'refused' || load.kind === 'unknown') {
      const reason = load.kind === 'refused'
        ? `LinuxCNC refused the program load, so nothing was started: ${load.reason}`
        : load.kind === 'unknown'
          ? `No answer came back for the program load, so LienCAM cannot say which file LinuxCNC has open and started nothing. Load the program again. (${load.reason})`
          : 'No program is loaded on LinuxCNC, so nothing was started.'
      this.events.onConsole?.({ dir: 'rx', text: reason, severity: 'error' })
      return false
    }
    this.jobActive = true
    this.jobStarted = true
    this.jobCompleted = false
    this.stoppedProgress = null
    this.lastProgramLine = 0
    const generation = this.generation
    const send = () => {
      if (generation !== this.generation) return
      void this.call(method, {}).then((reply) => {
        if (generation !== this.generation) return
        this.reportFailure(method, reply)
        if (!reply.ok && reply.outcome === 'refused') this.failJob(reply.error ?? `LinuxCNC refused ${method}.`)
      })
    }
    if (load.kind === 'accepted') {
      send()
      return true
    }
    void load.verdict.then((verdict) => {
      if (generation !== this.generation) return
      if (this.load.kind === 'accepted') send()
      else this.failJob(`LinuxCNC did not load the program, so it was not started: ${verdict.reason ?? 'no answer came back for the load.'}`)
    })
    return true
  }

  private sendLoad(method: 'loadJob' | 'loadJobFrom', args: Record<string, unknown>, lines: LoadResult): LoadOutcome {
    if (!this.connected()) return { ok: false, reason: 'Not connected to LinuxCNC.' }
    const result: LoadResult = { ...lines, overlongLines: [] }
    this.loaded = result
    this.jobActive = false
    this.jobStarted = false
    this.jobCompleted = false
    this.lastProgramLine = 0
    this.stoppedProgress = null
    const generation = this.generation
    const verdict = this.call(method, args).then((reply) => {
      const value = isRecord(reply.v) ? reply.v : null
      const accepted = reply.ok && reply.outcome === 'accepted' && value?.ok === true
      const reason = accepted
        ? null
        : typeof value?.reason === 'string' ? value.reason : reply.error ?? 'LinuxCNC did not answer the program load.'
      if (generation === this.generation && this.load.kind === 'pending' && this.load.verdict === verdict) {
        if (accepted) {
          this.load = { kind: 'accepted' }
        } else {
          this.load = reply.outcome === 'unknown'
            ? { kind: 'unknown', reason: reason ?? '' }
            : { kind: 'refused', reason: reason ?? '' }
          this.loaded = null
          this.events.onConsole?.({
            dir: 'rx',
            text: `${method}: ${reason}`,
            severity: reply.outcome === 'unknown' ? 'warn' : 'error',
          })
        }
        this.publishProgress()
      }
      // Only an explicit refusal takes the arm back (machineSession
      // watchBoardLoadRefusal); an unanswered load is not a refusal.
      return reply.outcome === 'unknown' ? { ok: true, reason: null } : { ok: accepted, reason }
    })
    this.load = { kind: 'pending', verdict }
    this.publishProgress()
    return { ok: true, result }
  }

  private failJob(message: string): void {
    if (!this.jobActive && !this.jobStarted) return
    this.snapshotStopped()
    this.jobActive = false
    this.jobStarted = false
    this.jobCompleted = false
    const fault: JobFault = { code: null, message, line: null, moveId: null }
    this.events.onJobEvent?.('failed', fault)
    this.publishProgress()
  }

  private endJobLocally(): void {
    if (this.jobActive || this.jobStarted) this.snapshotStopped()
    this.jobActive = false
    this.jobStarted = false
    this.jobCompleted = false
  }

  private snapshotStopped(): void {
    if (this.loaded) this.stoppedProgress = this.jobProgress()
  }

  private publishProgress(): void {
    const progress = this.jobProgress()
    const key = JSON.stringify(progress)
    if (key === this.lastPublishedProgress) return
    this.lastPublishedProgress = key
    this.events.onJobProgress?.(progress)
  }

  private reportOffset(wcs: WcsId, offset: MachinePosition): void {
    const values = [offset.x, offset.y, offset.z]
    this.events.onOffset?.({ label: wcs, values })
  }

  private setResetting(on: boolean): void {
    if (this.resetting === on) return
    this.resetting = on
    for (const listener of this.resetListeners) listener()
  }

  private setPhase(phase: ConnectionPhase, detail: string | null): void {
    this.phase = phase
    this.events.onConnectionPhase?.(phase, detail)
  }

  private waitForHello(timeoutMs: number): Promise<LinuxcncHello | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.helloWaiter = null
        resolve(null)
      }, timeoutMs)
      this.helloWaiter = (hello) => {
        clearTimeout(timer)
        this.helloWaiter = null
        resolve(hello)
      }
    })
  }

  /** A stop: sent at once whenever a socket exists, never gated, never
   *  queued behind anything here. Its failure goes to the console. */
  private stop(method: string): void {
    if (!this.transport) return
    void this.call(method, {}).then((reply) => this.reportFailure(method, reply))
  }

  private fire(method: string, args: Record<string, unknown>): void {
    if (!this.connected()) return
    void this.call(method, args).then((reply) => this.reportFailure(method, reply))
  }

  private fireIfConnected(method: string, args: Record<string, unknown>): boolean {
    if (!this.connected()) return false
    this.fire(method, args)
    return true
  }

  /** `true` only for an answer LinuxCNC gave: an `unknown` resolves false,
   *  never true (controller.ts, CommandOutcome). */
  private awaitBoolean(method: string, args: Record<string, unknown>): Promise<boolean> | null {
    if (!this.connected()) return null
    return this.call(method, args).then((reply) => {
      this.reportFailure(method, reply)
      return reply.ok && reply.outcome === 'accepted' && reply.v === true
    })
  }

  private reportFailure(method: string, reply: GatewayReply): void {
    if (reply.ok) return
    const entry = {
      dir: 'rx' as const,
      text: reply.error ?? (reply.outcome === 'unknown'
        ? unknownOutcomeSentence(method, null)
        : `LinuxCNC refused ${method}.`),
      severity: reply.outcome === 'unknown' ? 'warn' as const : 'error' as const,
    }
    // The gateway puts every LinuxCNC error-channel sentence on the console
    // itself, on its next 20 ms tick - usually just AFTER the reply. A refusal
    // that quotes one ("LinuxCNC refused jog: <sentence>") is said once, by
    // that line, not twice.
    const quoted = reply.outcome === 'refused' && reply.error?.startsWith('LinuxCNC refused ')
      ? reply.error.slice(reply.error.indexOf(': ') + 2)
      : null
    if (!quoted || reply.error!.indexOf(': ') < 0) {
      this.events.onConsole?.(entry)
      return
    }
    const generation = this.generation
    setTimeout(() => {
      if (generation !== this.generation) return
      if (!this.recentConsole.includes(quoted)) this.events.onConsole?.(entry)
    }, CONSOLE_ECHO_WAIT_MS)
  }

  private sendRaw(method: string, args: Record<string, unknown>): number {
    this.seq += 1
    this.transport?.send({ t: 'call', seq: this.seq, m: method, a: args })
    return this.seq
  }

  /** Never rejects. No reply by the deadline, or the socket closing with the
   *  call in flight, is `unknown`: it crossed to LinuxCNC and may still run. */
  private call(method: string, args: Record<string, unknown>, timeoutMs = LINUXCNC_CALL_TIMEOUT_MS): Promise<GatewayReply> {
    if (!this.transport) {
      return Promise.resolve({ ok: false, v: undefined, error: 'Not connected to LinuxCNC.', outcome: 'refused' })
    }
    const timeout = STOP_CALLS.has(method) ? Math.min(timeoutMs, LINUXCNC_CALL_TIMEOUT_MS) : timeoutMs
    return new Promise((resolve) => {
      const seq = this.sendRaw(method, args)
      const timer = setTimeout(() => {
        this.pending.delete(seq)
        resolve({ ok: false, v: undefined, error: unknownOutcomeSentence(method, timeout), outcome: 'unknown' })
      }, timeout)
      this.pending.set(seq, { resolve, timer, method, timeoutMs: timeout })
    })
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return
    const value = message.v
    switch (message.t) {
      case 'reply': {
        const seq = finiteOrNull(message.seq)
        const entry = seq === null ? undefined : this.pending.get(seq)
        if (!entry || seq === null) return
        this.pending.delete(seq)
        clearTimeout(entry.timer)
        const ok = message.ok === true
        entry.resolve({
          ok,
          v: value,
          error: typeof message.error === 'string' ? message.error : null,
          outcome: readOutcome(message.outcome) ?? (ok ? 'accepted' : 'refused'),
        })
        return
      }
      case 'hello': {
        if (!isRecord(value)) return
        const hello: LinuxcncHello = {
          protocol: finiteOrNull(value.protocol) ?? -1,
          bridge: typeof value.bridge === 'string' ? value.bridge : 'the LinuxCNC gateway',
          controller: typeof value.controller === 'string' ? value.controller : 'unknown',
          linuxcncVersion: typeof value.linuxcncVersion === 'string' ? value.linuxcncVersion : null,
          ini: typeof value.ini === 'string' ? value.ini : null,
          coordinates: typeof value.coordinates === 'string' ? value.coordinates : 'XYZ',
          capabilities: isRecord(value.capabilities) ? value.capabilities : {},
          readOnly: value.readOnly === true,
          vfd: readVfdInfo(value.vfd),
          config: readConfig(value.config),
        }
        this.hello = hello
        this.helloWaiter?.(hello)
        return
      }
      case 'status': {
        if (!isRecord(value)) return
        this.lastStatus = readStatus(value)
        const lines = readLines(value.linuxcnc)
        this.lastLines = lines
        this.toolChangeWait = readToolChange(value.linuxcnc)
        this.wcsRotation = readWcsRotation(value.linuxcnc)
        this.wcsIndex = isRecord(value.linuxcnc) ? finiteOrNull(value.linuxcnc.wcsIndex) : null
        // WO-2100: held at an M6, the program stands ON the M6's line - the
        // line the session staged its tool-change hold at - not on the last
        // motion line before it.
        const heldAt = this.toolChangeWait?.line ?? null
        if (this.jobStarted && heldAt !== null) this.lastProgramLine = heldAt
        else if (this.jobStarted && lines && lines.motionLine > 0) this.lastProgramLine = lines.motionLine
        if (this.phase === 'connected' && this.lastStatus.state === 'idle') this.flushHeldUnitsWord()
        if (this.phase === 'connected') {
          this.events.onStatus?.(this.lastStatus)
          if (this.jobStarted) this.publishProgress()
        }
        return
      }
      case 'console': {
        if (!isRecord(value) || typeof value.text !== 'string') return
        const severity = value.severity === 'error' || value.severity === 'warn' || value.severity === 'command'
          ? value.severity
          : 'info'
        this.recentConsole.push(value.text)
        if (this.recentConsole.length > 20) this.recentConsole.shift()
        this.events.onConsole?.({ dir: 'rx', text: value.text, severity })
        return
      }
      case 'homed': {
        const axes = isRecord(value) && Array.isArray(value.axes)
          ? value.axes.map(readAxisLetter).filter((axis): axis is AxisName => axis !== null)
          : []
        for (const axis of axes) this.revoked.delete(axis as JogAxis)
        this.events.onHomed?.(axes)
        return
      }
      case 'alarm': {
        if (!isRecord(value)) return
        const positionLost = value.positionLost === true
        // Alarm-capable backends invalidate their own datum BEFORE publishing.
        if (positionLost) this.invalidateDatum(null)
        this.events.onAlarm?.(
          finiteOrNull(value.code),
          typeof value.message === 'string' ? value.message : 'LinuxCNC raised an alarm.',
          positionLost,
        )
        return
      }
      case 'jobEvent': {
        if (!isRecord(value)) return
        const event = value.event
        if (event !== 'started' && event !== 'paused' && event !== 'resumed'
          && event !== 'stopped' && event !== 'completed' && event !== 'failed') return
        const raw = isRecord(value.fault) ? value.fault : null
        const fault: JobFault | null = raw
          ? {
              code: finiteOrNull(raw.code),
              message: typeof raw.message === 'string' ? raw.message : 'LinuxCNC stopped the program.',
              line: finiteOrNull(raw.line),
              moveId: null,
            }
          : null
        if (event === 'completed') this.lastProgramLine = this.loaded?.lines.at(-1)?.sourceLine ?? this.lastProgramLine
        if (event === 'stopped' || event === 'completed' || event === 'failed') {
          this.jobCompleted = event === 'completed'
          this.snapshotStopped()
          this.jobActive = false
          this.jobStarted = event === 'completed'
        } else if (event === 'started' || event === 'resumed') {
          this.jobActive = true
          this.jobStarted = true
        }
        this.events.onJobEvent?.(event, fault)
        this.publishProgress()
        return
      }
      default:
        return
    }
  }

  private teardown(reason: string): void {
    const wasLive = this.phase !== 'disconnected'
    this.generation += 1
    this.transport = null
    this.hello = null
    this.helloWaiter?.(null)
    for (const [seq, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.resolve({
        ok: false,
        v: undefined,
        error: `The link to LinuxCNC closed with ${entry.method} in flight. It may still have run - the next status report says what the machine is doing.`,
        outcome: 'unknown',
      })
      this.pending.delete(seq)
    }
    this.jobActive = false
    this.jobStarted = false
    this.jobCompleted = false
    this.load = { kind: 'none' }
    this.loaded = null
    this.lastStatus = null
    this.lastLines = null
    this.toolChangeWait = null
    this.wcsRotation = null
    this.wcsIndex = null
    this.setResetting(false)
    this.heldUnitsWord = null
    this.recentConsole = []
    this.lastProbe = null
    this.unitsWord = null
    if (!wasLive) return
    this.setPhase('disconnected', reason === 'disconnect requested' ? null : reason)
    if (reason !== 'disconnect requested') this.events.onClose?.(reason)
  }
}
