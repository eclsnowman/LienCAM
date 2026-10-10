// GrblController - orchestrates a MachineTransport, the LineFramer, RX line
// classification, and the character-counting streamer into one stateful
// controller session. Framework-free; the UI layer subscribes via the typed
// event callbacks and renders snapshots.
//
// Safety contract (docs/planning/MACHINE-CONTROL-PLAN.md):
// - nothing here auto-connects or auto-runs; every motion originates from an
//   explicit caller action
// - error:N during a job halts feeding AND issues a feed hold (halt-and-
//   surface); ALARM:N hard-stops the job and surfaces decoded meaning
// - a disconnect kills the session outright; machine state is unknown until
//   a fresh banner is seen (no resume across reconnect)

import { LineFramer } from '../lineFramer'
import type {
  AccessoryState,
  GrblOffsetEntry,
  GrblStatusReport,
  GrblParserState,
  MachineTransport,
  MachineVec3,
  WcsId,
} from '../types'
import type {
  ControllerBackend,
  ControllerCapabilities,
  ControllerEvents,
  JobFault,
  LoadOutcome,
  MachineController,
  MachineStatus,
  OverrideChange,
  OverrideKind,
  ProbeTouch,
} from '../controller'
import { GRBL_ALARMS_POSITION_LOST, GRBL_ALARM_MESSAGES, REALTIME } from './constants'
import { classifyGrblLine, parseOffsetEntry, parseParserState } from './lines'
import { CharacterCountStreamer, GrblExecutingBlockTracker, type StreamerProgress } from './streamer'
// The G-code text helpers are not GRBL concepts (WO-417): they live in the
// neutral module, and WO-422 removed the re-export shim that stood in for
// this import.
import { prepareProgram, type StreamLine } from '../../gcode/text'
import { tokenizeLine } from '../../gcode/parse'
import { formatGrblSetting } from './settings'

export type ConnectionPhase = 'disconnected' | 'connecting' | 'connected'
export type ResetToIdleResult = { ok: boolean; reason: string | null }

export type JogAxis = 'X' | 'Y' | 'Z'

export interface ConsoleEcho {
  dir: 'tx' | 'rx'
  text: string
  /** Severity hint for rendering; 'error' covers error:N and ALARM:N. */
  severity: 'info' | 'command' | 'error'
}

export interface DerivedPosition {
  mpos: MachineVec3 | null
  wpos: MachineVec3 | null
  /** Resolved accessory state: the A: field rides only on override-bearing
   *  reports, so the controller caches it like WCO. Never null - all-off
   *  until a report says otherwise. */
  accessories: AccessoryState
}

/** How a single awaited command line ended: its ack, or the reason the
 *  session died under it (alarm / reset / disconnect - ok:false, code -1). */
export interface CommandAck {
  ok: boolean
  code: number
  message: string
}

interface PendingCommand {
  label: string
  resolve?: (ack: CommandAck) => void
}

/**
 * WO-423: the contract's `ControllerEvents` IS this controller's event
 * channel now - `onAlarm`, `onJobProgress`, `onJobEvent`, `onOffset`,
 * `onSetting`, `onHomed`, `onAccessories`, `onReady`, `onConsole`,
 * `onParserState` and `onClose` all come straight from it, with the contract's
 * signatures, so nothing above the backends has to know GRBL raised them.
 *
 * Two members are NOT taken from the contract, and both are reported misfits
 * rather than lossy conversions:
 *
 *  - `onStatus`. The contract's `MachineStatus.inputs` is four booleans
 *    (estop / hardLimit / softLimit / probe). GRBL's `Pn:` field is a letter
 *    set, and the Control page renders SIX distinct LEDs from it (X, Y and Z
 *    limits separately, Probe, Door, Hold). Narrowing to the contract shape
 *    would darken four of them, so GRBL keeps its richer native channel and
 *    the gap is a WO-423 finding.
 *  - `onConsole`. The contract's severities are info/warn/error; GRBL's are
 *    info/COMMAND/error, and the store's console really does render a command
 *    tier (an echoed TX line). There is no warn tier below and no command tier
 *    above, so neither set is a subset of the other - also a WO-423 finding.
 *
 * `onConnection` and `onWelcome` are additions, not replacements: the
 * contract's `onConnectionPhase` and `onReady` fire alongside them.
 */
export interface GrblControllerEvents extends Omit<ControllerEvents, 'onStatus' | 'onConsole'> {
  /** GRBL-native status: the raw report plus the positions derived from the
   *  cached WCO. See the note above on why this is not `MachineStatus`. */
  onStatus?: (report: GrblStatusReport, derived: DerivedPosition) => void
  /** GRBL-native alias of the contract's `onConnectionPhase`; both fire. */
  onConnection?: (phase: ConnectionPhase, detail: string | null) => void
  /** GRBL-native alias of the contract's `onReady`; both fire. */
  onWelcome?: (version: string) => void
  /** GRBL-native console echo, including the `command` severity the contract
   *  has no member for. See the note above. */
  onConsole?: (echo: ConsoleEcho) => void
}

const ACCESSORIES_OFF: AccessoryState = { spindle: 'off', flood: false, mist: false }

const HANDSHAKE_BANNER_MS = 2500
const HANDSHAKE_RESET_MS = 2500
const POLL_TICK_MS = 200
const IDLE_POLL_EVERY_TICKS = 5 // 1Hz idle, 5Hz active
const STOP_SETTLE_MS = 600 // feed-hold decel window before the soft reset
const STATUS_CONFIRM_MS = 1000 // window for the post-reset report that proves idle
// The protocol says a `?` reply arrives in about 5-20ms. Beyond 100ms the
// indistinguishable `<...>` line could be a delayed reply to an older query or
// an unsolicited push, so it may update display state but cannot prove Idle.
// This is deliberately shorter than the 200ms active polling interval.
const STATUS_QUERY_MAX_AGE_MS = 100

const encoder = new TextEncoder()

/** GRBL accepts text and can attribute a unique executing source block
 *  from position (WO-2581); it cannot report buffer occupancy as a duration,
 *  and can only home all configured axes together - but
 *  it does drive the spindle itself. See ADR-0041. */
const GRBL_CAPABILITIES: ControllerCapabilities = {
  geometryQueue: false,
  executingMoveId: true,
  bufferSeconds: false,
  // Contract v2 (WO-422): text IS this controller's only program route.
  gcodeText: true,
  perAxisHoming: false,
  ownsSpindle: true,
  // WO-905: GRBL commands its spindle with M3/M5 TEXT, which is what
  // gcodeText already says. It has no call-shaped spindle interface.
  spindleCommands: false,
  // WO-1023: `machineProgram` is ABSENT, which reads as false. GRBL cannot
  // execute a MachineProgram - its only program route is text, and the
  // renderer that would turn action steps into this controller's dialect is a
  // later order (ADR-0043 section 4, "Text backends are unchanged today").
  // Absent rather than an explicit `false` because this object's exact shape
  // is pinned by an out-of-lane test and absence already means false at every
  // reader; the field's own doc in controller.ts carries the full reasoning.
  // `loadProgram` and `programProgress` are correspondingly not implemented.
}

/** WO-418: `OverrideChange` -> the fixed realtime bytes GRBL actually has.
 *  Reset applies to all three channels; step (+-/coarse-fine) only exists for
 *  feed and spindle - GRBL's rapid override has no incremental nudge, only
 *  three fixed absolute levels (25/50/100%), so a rapid 'step' has no GRBL
 *  equivalent either, same as 'percent' (see setOverride). */
const OVERRIDE_RESET_BYTE: Record<OverrideKind, number> = {
  feed: REALTIME.feedOvrReset,
  rapid: REALTIME.rapidOvrFull,
  spindle: REALTIME.spindleOvrReset,
}
const OVERRIDE_STEP_BYTE: Record<
  'feed' | 'spindle',
  { coarsePlus: number; coarseMinus: number; finePlus: number; fineMinus: number }
> = {
  feed: {
    coarsePlus: REALTIME.feedOvrCoarsePlus,
    coarseMinus: REALTIME.feedOvrCoarseMinus,
    finePlus: REALTIME.feedOvrFinePlus,
    fineMinus: REALTIME.feedOvrFineMinus,
  },
  spindle: {
    coarsePlus: REALTIME.spindleOvrCoarsePlus,
    coarseMinus: REALTIME.spindleOvrCoarseMinus,
    finePlus: REALTIME.spindleOvrFinePlus,
    fineMinus: REALTIME.spindleOvrFineMinus,
  },
}

/** Generous but bounded: a probe move can be slow (low feed, long travel), but
 *  a [PRB:...] feedback line that never arrives (probe alarm, disconnect)
 *  must not hang probe() forever. */
const PROBE_RESULT_MAX_WAIT_MS = 15000

/** Contract v3 types `ControllerBackend.transport`, so a byte pipe arrives
 *  typed and the duck-typed narrowing WO-422 needed is gone. The runtime check
 *  stays, one layer down: `kind` is a claim made by the caller, and handing
 *  GRBL something that cannot write bytes must fail in a sentence here rather
 *  than later, against a machine. */
function isBytePipe(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return typeof v.start === 'function' && typeof v.write === 'function' && typeof v.close === 'function'
}

export class GrblController implements MachineController {
  readonly capabilities: ControllerCapabilities = GRBL_CAPABILITIES
  private readonly events: GrblControllerEvents
  private transport: MachineTransport | null = null
  private framer = new LineFramer()
  private streamer: CharacterCountStreamer
  private executionTracker = new GrblExecutingBlockTracker()
  private executingSourceLine: number | null = null
  private axisStepsPerMm = new Map<number, number>()
  private reportPositionScale: number | null = null
  private parserModes: Pick<GrblParserState, 'units' | 'distanceMode' | 'motionMode' | 'wcs'> = {
    units: 'mm', distanceMode: 'absolute', motionMode: 'G0', wcs: 'G54',
  }
  private phase: ConnectionPhase = 'disconnected'
  private version: string | null = null
  private lastWco: MachineVec3 | null = null
  private lastState: GrblStatusReport['state'] = 'unknown'
  private lastAccessories: AccessoryState = ACCESSORIES_OFF
  /** FIFO of un-acked manual commands - length is the pending count, labels
   *  let acks be attributed ($H completion -> homed, etc.), and entries with
   *  a resolver settle sendCommandAwait promises (probe runner plumbing). */
  private mdiQueue: PendingCommand[] = []
  private homed = false
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private pollTick = 0
  private stopTimer: ReturnType<typeof setTimeout> | null = null
  /** Last controller-owned progress snapshot captured immediately before a
   * controlled stop flushes the streamer. Callers that must re-arm from the
   * final acknowledged source line cannot recover this authority from the
   * render-throttled store or from the reset streamer. */
  private stoppedJobProgressValue: StreamerProgress | null = null
  private jobActive = false
  private jobLoadGeneration = 0
  /** Load generation whose first line has emitted `started`. A mid-job
   * run-from replacement is a new reviewed arm even if the prior Single
   * Block lifecycle still has jobActive=true. */
  private startedJobLoadGeneration = -1
  /** 'completed' already emitted for the currently loaded job (reentrancy guard). */
  private jobCompleteEmitted = false
  /** Single Block MODE, enforced HERE and not only in UI state (WO-006,
   *  d20f0892e audit finding 2): while on, continuous start/resume are
   *  refused - stepJob is the only way program lines reach the machine. */
  private singleBlock = false
  private bannerWaiters: Array<(version: string) => void> = []
  /** Woken by the next status report. resetToIdle() is the only user: the
   *  controller's OWN answer to `?` is the only honest proof of what state a
   *  reset left it in. */
  private statusWaiters: Array<(report: GrblStatusReport) => void> = []
  /** WO-418. Woken by the next [PRB:...] feedback line - probe()'s only user.
   *  Same one-shot-waiter idiom as bannerWaiters/statusWaiters above. */
  private probeWaiters: Array<(entry: GrblOffsetEntry) => void> = []
  /** WO-418. Last full status report and its derived positions, so status()
   *  has something to build from between reports. Null before the first
   *  report of a connection and cleared on teardown - status() must go back
   *  to honestly unknown, the same as every other cached field here. */
  private lastReport: GrblStatusReport | null = null
  private lastDerived: DerivedPosition | null = null
  /** Activity generation and send time for the ONE query allowed in flight.
   *  GRBL may also push indistinguishable `<...>` reports unsolicited, so a
   *  report proves Idle only inside the documented response window. */
  private pendingStatusQueries: Array<{
    activity: number
    sentAt: number
    verifiesIdle: boolean
  }> = []
  /** A banner clears our tokens but cannot recall old serial bytes already in
   *  flight. Wait one response window before establishing a new pairing. */
  private statusPairingNotBefore = 0
  /** WO-104. Every line write and every state-changing realtime byte advances
   *  this generation. An Idle report verifies only the generation captured
   *  when its `?` was written, so later traffic turns the answer into
   *  NOT-KNOWN without every public command path having to remember a fragile
   *  boolean assignment. */
  private controllerActivity = 0
  private idleVerifiedAtActivity: number | null = null
  /** A sent Feed Hold makes a truthful Idle report impossible until GRBL is
   *  resumed, reset, disconnected, or superseded by an alarm. Status reports
   *  carry no ID, so none of them can safely release this guard. */
  private feedHoldOutstanding = false
  /** WO-104. The reset is controller authority, so its single-flight guard
   *  and observable lifetime live here rather than in any mounted button. */
  private resetToIdleInFlight: Promise<ResetToIdleResult> | null = null
  private resetToIdleListeners = new Set<() => void>()
  /** True between OUR soft reset and its banner: GRBL retains machine
   *  position across a commanded 0x18, so homed state survives it. An
   *  UNEXPECTED banner (MCU reset, power blip) still clears homed. */
  private expectedResetBanner = false
  private settingsReadRows: Map<number, string> | null = null
  private settingsReadInFlight: Promise<Map<number, string>> | null = null

  constructor(events: GrblControllerEvents) {
    this.events = events
    this.streamer = new CharacterCountStreamer((text) => {
      void this.writeLine(text, 'command')
    })
  }

  connectionPhase(): ConnectionPhase {
    return this.phase
  }

  /** Was grblVersion() - renamed for MachineController (WO-418). */
  firmwareVersion(): string | null {
    return this.version
  }

  /** @deprecated use firmwareVersion(). Kept as a thin alias: callers outside
   *  this slice's owned paths (grblController.test.ts, grblSimulator.test.ts)
   *  still call this name. */
  grblVersion(): string | null {
    return this.firmwareVersion()
  }

  machineState(): GrblStatusReport['state'] {
    return this.lastState
  }

  /**
   * WO-418 addition. Built from the report this controller already caches
   * (`lastReport`/`lastDerived`, set in handleStatus). Fields GRBL cannot
   * supply are null, never invented - per the WO:
   *  - `executingMoveId` is the physical source line proven by the current
   *    report (WO-2581), or null when GRBL's position cannot identify it.
   *  - `buffer.moves` and `buffer.capacitySeconds` are always null: GRBL's
   *    `Bf:` is planner blocks and RX bytes, not a move count or a duration.
   *
   * `inputs` and `homed` needed a judgment call the WO did not spell out and
   * are flagged in the WO-418 report:
   *  - `hardLimit`/`probe` decode directly off GRBL's `Pn:` letters (X/Y/Z,
   *    P) - GRBL includes `Pn:` on a report only while a pin is asserted, so
   *    its absence honestly means "nothing triggered right now", not unknown.
   *  - `softLimit` has no live GRBL pin at all (a soft-limit violation is
   *    ALARM:2, not a Pn letter), so it is always false.
   *  - `estop` maps to GRBL's `D` (safety-door) pin, the only external panic
   *    input GRBL's protocol exposes - many builds wire their e-stop there.
   *    This app's own software e-stop interlock (machineSession.ts) is a
   *    separate, higher-level concept this slice does not touch.
   *  - `inputs` as a whole is null only before the first status report of a
   *    connection (`lastReport === null`) - genuinely no data yet.
   */
  status(): MachineStatus {
    const report = this.lastReport
    return {
      state: this.lastState,
      subState: report?.subState ?? null,
      machinePos: this.lastDerived?.mpos ?? null,
      workPos: this.lastDerived?.wpos ?? null,
      feedMmMin: report?.feed ?? null,
      spindleRpm: report?.spindleRpm ?? null,
      overrides: report?.overrides ?? null,
      executingMoveId: this.executingSourceLine,
      buffer: { moves: null, capacitySeconds: null },
      inputs: report
        ? {
            hardLimit: /[XYZ]/.test(report.pins ?? ''),
            softLimit: false,
            probe: (report.pins ?? '').includes('P'),
            estop: (report.pins ?? '').includes('D'),
            // Contract v4: GRBL's Pn: field breaks limits out per axis and also
            // carries Door and Hold as their own letters - it has all six inputs
            // the Control page renders, so these are real booleans, never null.
            // (report.pins ?? '') matches the fields above: Pn: is only present
            // on a report while a pin is asserted, so its absence means "nothing
            // triggered", not "unknown".
            limits: {
              x: (report.pins ?? '').includes('X'),
              y: (report.pins ?? '').includes('Y'),
              z: (report.pins ?? '').includes('Z'),
            },
            door: (report.pins ?? '').includes('D'),
            hold: (report.pins ?? '').includes('H'),
          }
        : null,
      homed: { X: this.homed, Y: this.homed, Z: this.homed },
      // No Modbus spindle link on this backend - stated, not omitted.
      spindle: null,
    }
  }

  hasActiveJob(): boolean {
    return this.jobActive
  }

  /** Final live cursor captured at the controlled-stop reset boundary. */
  stoppedJobProgress(): StreamerProgress | null {
    return this.stoppedJobProgressValue ? { ...this.stoppedJobProgressValue } : null
  }

  resetInProgress(): boolean {
    return this.resetToIdleInFlight !== null
  }

  subscribeResetInProgress(listener: () => void): () => void {
    this.resetToIdleListeners.add(listener)
    return () => this.resetToIdleListeners.delete(listener)
  }

  /**
   * Whether the controller has STATED, since the last job started, that it is
   * Idle with nothing of ours outstanding (WO-087).
   *
   * Idle is GRBL's own report that its planner is drained and it is not in
   * Hold, so it is the only evidence the app has that no motion from a
   * previous run is still queued inside the controller. This deliberately
   * carries no inference: it starts false, every job start invalidates it, a
   * reset invalidates it, and only a status report can set it. A caller that
   * needs "the controller is safe to arm on top of" therefore gets the safe
   * answer - no - unless GRBL has actually said otherwise AFTER the latest
   * traffic that could have changed its state.
   *
   * The failed-cycle case is exactly why it cannot be a live read of the last
   * known state: error:N leaves the machine in Hold with the rest of the run
   * still buffered, and the app's cached state can be a moment behind that.
   */
  verifiedIdle(): boolean {
    return this.idleVerifiedAtActivity === this.controllerActivity
  }

  /**
   * Attach a started-or-startable transport and perform the GRBL handshake:
   * wait for the welcome banner (opening a USB CDC port usually resets the
   * MCU via DTR); if silent, probe with a soft reset which always reprints
   * the banner. Fails loudly if no banner ever arrives.
   */
  async connect(backend: ControllerBackend): Promise<void> {
    if (this.phase !== 'disconnected') throw new Error('Already connected or connecting')
    // Contract v3 types the payload as well as the kind, so the byte pipe
    // arrives as a BytePipe rather than as `unknown`. Handing GRBL the wrong
    // thing must still fail HERE, in a sentence, not later against a machine.
    if (backend.kind !== 'bytes') {
      throw new Error(
        `GrblController speaks GRBL text over a byte pipe; it was handed a '${backend.kind}' backend.`,
      )
    }
    if (!isBytePipe(backend.transport)) {
      throw new Error('GrblController.connect needs a byte pipe (start/write/close).')
    }
    const transport: MachineTransport = backend.transport
    this.transport = transport
    this.framer = new LineFramer()
    this.setPhase('connecting', null)
    try {
      await transport.start({
        onChunk: (data) => this.handleChunk(data),
        onClose: (reason) => this.handleClose(reason),
      })
      let version = await this.waitForBanner(HANDSHAKE_BANNER_MS)
      if (!version) {
        await this.writeRealtime(REALTIME.softReset, 'soft-reset (handshake probe)')
        version = await this.waitForBanner(HANDSHAKE_RESET_MS)
      }
      if (!version) {
        throw new Error('No GRBL welcome banner received - is this a GRBL controller?')
      }
      this.setPhase('connected', version)
      this.startPolling()
      this.queryStatus()
    } catch (err) {
      await this.disconnect()
      throw err
    }
  }

  async disconnect(): Promise<void> {
    const transport = this.transport
    this.teardown('disconnect requested')
    if (transport) await transport.close()
  }

  // ---- realtime commands (bypass the RX buffer; never counted) ----

  queryStatus(): void {
    void this.writeRealtime(REALTIME.statusQuery, null)
  }

  feedHold(): void {
    void this.writeRealtime(REALTIME.feedHold, 'feed hold')
  }

  cycleResume(): boolean {
    if (this.stopTimer !== null) return false
    void this.writeRealtime(REALTIME.cycleStartResume, 'cycle start / resume')
    return true
  }

  /** Was softReset() - renamed for MachineController (WO-418). */
  reset(): void {
    this.clearExecutionAttribution()
    this.expectedResetBanner = true
    void this.writeRealtime(REALTIME.softReset, 'soft reset')
  }

  /** @deprecated use reset(). Kept as a thin alias: callers outside this
   *  slice's owned paths (machineSession.ts, operatorTransport.ts,
   *  pendantMachine.ts, and their tests) still call this name. */
  softReset(): void {
    this.reset()
  }

  jogCancel(): void {
    void this.writeRealtime(REALTIME.jogCancel, 'jog cancel')
  }

  /** @deprecated use setOverride(). Kept as a thin alias: callers outside
   *  this slice's owned paths (OverridePanel.tsx, pendantMachine.ts, and
   *  their tests) still call this name with a raw realtime byte. */
  overrideByte(byte: number, label: string): void {
    void this.writeRealtime(byte, label)
  }

  /** Was overrideByte(byte, label) - renamed for MachineController (WO-418).
   *  Maps LienCAM's controller-neutral override vocabulary onto GRBL's fixed
   *  realtime bytes. GRBL has no absolute-percent override protocol and no
   *  incremental nudge for rapid override (only three fixed levels) - both
   *  are refused rather than approximated; see the comments below. */
  setOverride(change: OverrideChange): void {
    if (change.to === 'percent') {
      // WO-422: GRBL's RAPID override is absolute and has exactly three
      // levels (0x95/0x96/0x97 = 100/50/25%), so those three percentages are
      // expressible here - and are the ones the UI and the pendant have
      // always sent, byte for byte. Any other percentage, and every percentage
      // on feed/spindle (which have deltas, not absolutes), still has no GRBL
      // equivalent and is refused rather than approximated.
      const byte =
        change.kind === 'rapid'
          ? change.percent === 100
            ? REALTIME.rapidOvrFull
            : change.percent === 50
              ? REALTIME.rapidOvrHalf
              : change.percent === 25
                ? REALTIME.rapidOvrQuarter
                : null
          : null
      if (byte !== null) {
        this.overrideByte(byte, `rapid set ${change.percent}%`)
        return
      }
      this.events.onConsole?.({
        dir: 'tx',
        text:
          `<setOverride: GRBL has no absolute-percent override protocol byte ` +
          `for ${change.kind} (${change.percent}%) - ignoring>`,
        severity: 'info',
      })
      return
    }
    if (change.to === 'reset') {
      this.overrideByte(OVERRIDE_RESET_BYTE[change.kind], `${change.kind} reset 100%`)
      return
    }
    // change.to === 'step'
    if (change.kind === 'rapid') {
      this.events.onConsole?.({
        dir: 'tx',
        text:
          `<setOverride: GRBL's rapid override has no incremental step byte, ` +
          `only fixed 25/50/100% levels - ignoring step>`,
        severity: 'info',
      })
      return
    }
    const bytes = OVERRIDE_STEP_BYTE[change.kind]
    const byte = change.coarse
      ? change.direction > 0
        ? bytes.coarsePlus
        : bytes.coarseMinus
      : change.direction > 0
        ? bytes.finePlus
        : bytes.fineMinus
    this.overrideByte(byte, '')
  }

  // ---- MDI / discrete commands ----

  /**
   * Send one manual command line. Refused while a job is streaming - MDI
   * bytes would occupy the same RX buffer the streamer is accounting for.
   */
  sendCommand(text: string): boolean {
    if (this.phase !== 'connected') return false
    if (this.jobActive) return false
    this.mdiQueue.push({ label: text })
    void this.writeLine(text, 'command')
    return true
  }

  /**
   * Send one manual command line and resolve when ITS ack arrives - the
   * plumbing sequenced flows (probe cycles) are built on. Never rejects:
   * alarm, controller reset, and disconnect settle the promise with ok:false
   * and a plain reason so an awaiting runner always terminates. Returns null
   * when refused (same conditions as sendCommand).
   */
  sendCommandAwait(text: string): Promise<CommandAck> | null {
    if (this.phase !== 'connected') return null
    if (this.jobActive) return null
    return new Promise<CommandAck>((resolve) => {
      this.mdiQueue.push({ label: text, resolve })
      void this.writeLine(text, 'command')
    })
  }

  /** Incremental jog in mm. Refused while a job is active or in alarm. */
  jog(axis: JogAxis, deltaMm: number, feedMmMin: number): boolean {
    if (!this.jogAllowed()) return false
    const delta = Number(deltaMm.toFixed(4))
    const feed = Math.max(1, Math.round(feedMmMin))
    this.mdiQueue.push({ label: '$J' })
    void this.writeLine(`$J=G91 G21 ${axis}${delta} F${feed}`, 'command')
    return true
  }

  /**
   * Jog to an absolute WORK position (jog protocol, so parser modal state is
   * untouched and 0x85 cancels it). Used for "goto XY zero" - Z deliberately
   * never moves on a goto.
   */
  jogToWorkXY(x: number, y: number, feedMmMin: number): boolean {
    if (!this.jogAllowed()) return false
    const feed = Math.max(1, Math.round(feedMmMin))
    this.mdiQueue.push({ label: '$J' })
    void this.writeLine(`$J=G90 G21 X${Number(x.toFixed(4))} Y${Number(y.toFixed(4))} F${feed}`, 'command')
    return true
  }

  /**
   * Jog to an absolute MACHINE-coordinate Z (jog protocol with G53, per the
   * GRBL jog spec). Soft limits still apply and parser modal state is
   * untouched - the safe-Z macro's contract. Only meaningful homed; callers
   * guard that.
   */
  jogToMachineZ(z: number, feedMmMin: number): boolean {
    if (!this.jogAllowed()) return false
    const feed = Math.max(1, Math.round(feedMmMin))
    this.mdiQueue.push({ label: '$J' })
    void this.writeLine(`$J=G53 G90 G21 Z${Number(z.toFixed(4))} F${feed}`, 'command')
    return true
  }

  private jogAllowed(): boolean {
    if (this.phase !== 'connected' || this.jobActive) return false
    return this.lastState !== 'alarm' && this.lastState !== 'run' && this.lastState !== 'hold'
  }

  /** Select the active work coordinate system (G54-G59). */
  selectWcs(wcs: WcsId): boolean {
    return this.sendCommand(wcs)
  }

  /** Query modal state ($G) and the offsets table ($#). */
  refreshState(): boolean {
    const a = this.sendCommand('$G')
    const b = this.sendCommand('$#')
    return a && b
  }

  /** Dump all settings ($$) - answered as $N=value lines via onSetting. */
  querySettings(): boolean {
    if (this.settingsReadInFlight) return true
    const pending = this.beginSettingsRead()
    if (!pending) return false
    // querySettings keeps the controller-neutral boolean contract. The
    // connect reconciler joins this same transaction through readSettings(),
    // while this handler prevents an expected disconnect from becoming an
    // unhandled rejection if there is no joiner.
    void pending.catch(() => {})
    return true
  }

  /** Read one complete $$ transaction. Its resolving map contains only rows
   * that arrived before this command's own acknowledgement. */
  readSettings(): Promise<Map<number, string>> {
    if (this.settingsReadInFlight) return this.settingsReadInFlight
    const pending = this.beginSettingsRead()
    return pending ?? Promise.reject(new Error('GRBL settings cannot be read while disconnected or running a job.'))
  }

  private beginSettingsRead(): Promise<Map<number, string>> | null {
    const rows = new Map<number, string>()
    this.settingsReadRows = rows
    const acknowledgement = this.sendCommandAwait('$$')
    if (!acknowledgement) {
      this.settingsReadRows = null
      return null
    }
    const pending = acknowledgement.then((ack) => {
      if (!ack.ok) throw new Error(ack.message || 'GRBL refused the settings read.')
      return new Map(rows)
    }).finally(() => {
      if (this.settingsReadInFlight === pending) this.settingsReadInFlight = null
      if (this.settingsReadRows === rows) this.settingsReadRows = null
    })
    this.settingsReadInFlight = pending
    return pending
  }

  /** Write one numbered EEPROM setting and resolve on its own ok/error line. */
  writeSetting(id: number, value: string): Promise<CommandAck> | null {
    const command = formatGrblSetting(id, value)
    return command === null ? null : this.sendCommandAwait(command)
  }

  /** True once a $H homing cycle has completed in THIS connection session. */
  homedThisSession(): boolean {
    return this.homed
  }

  homedAxesThisSession(): Partial<Record<JogAxis, boolean>> {
    return { X: this.homed, Y: this.homed, Z: this.homed }
  }

  /** GRBL's alarm verdict names no axes, so any datum revocation is whole-machine. */
  invalidateDatum(_axes: readonly JogAxis[] | null): void {
    this.homed = false
  }

  /** Zero the given axis in the ACTIVE work coordinate system (G10 L20 P0). */
  zeroWorkAxis(axis: JogAxis): boolean {
    return this.sendCommand(`G10 L20 P0 ${axis}0`)
  }

  home(): boolean {
    return this.sendCommand('$H')
  }

  unlock(): boolean {
    return this.sendCommand('$X')
  }

  /** Convert the contract's absolute machine target to the relative G91 travel
   *  GRBL's probe cycle accepts. A reported machine position is required:
   *  assuming an origin here would send physical motion to an invented place. */
  async probe(axis: JogAxis, targetMm: number, feedMmMin: number): Promise<ProbeTouch> {
    const machinePos = this.lastDerived?.mpos
    if (!machinePos) {
      this.restoreAbsoluteMode()
      return {
        ok: false,
        at: null,
        reason: 'Cannot probe without a reported machine position.',
      }
    }
    const feed = Math.max(1, Math.round(feedMmMin))
    const key = axis.toLowerCase() as keyof MachineVec3
    const distance = Number((targetMm - machinePos[key]).toFixed(4))
    const prb = this.nextProbeResult(PROBE_RESULT_MAX_WAIT_MS)
    const ack = this.sendCommandAwait(`G21 G91 G38.2 ${axis}${distance} F${feed}`)
    if (!ack) {
      this.restoreAbsoluteMode()
      return { ok: false, at: null }
    }
    try {
      const ackResult = await ack
      if (!ackResult.ok) return { ok: false, at: null }
      const offset = await prb
      if (!offset || offset.probeSuccess !== true || offset.values.length < 3) {
        return { ok: false, at: null }
      }
      return { ok: true, at: { x: offset.values[0], y: offset.values[1], z: offset.values[2] } }
    } finally {
      this.restoreAbsoluteMode()
    }
  }

  /**
   * A probe is issued in G91 because the travel is relative, and GRBL does NOT
   * restore the previous distance mode afterwards - it is sticky modal state.
   * Leaving it set means the NEXT absolute move is interpreted as relative,
   * which on a machine is a move to entirely the wrong place.
   *
   * `machineSession`'s own probe cycles have always ended with an explicit
   * `G90` (see its directional and surface-mesh cycles); this primitive was
   * added later and did not. Restored here on EVERY exit path, including a
   * refused ack and a thrown error, because the failure paths are exactly the
   * ones where an operator retries and moves next.
   */
  private restoreAbsoluteMode(): void {
    this.sendCommand('G90')
  }

  // ---- job lifecycle ----

  /** Prepare a program for streaming. Does not send anything.
   *  Contract v3 wraps the streamer's real `LoadResult` in a `LoadOutcome`;
   *  GRBL has an interpreter (`capabilities.gcodeText`), so it never refuses
   *  on capability grounds and always answers `ok: true`. */
  loadJob(programText: string): LoadOutcome {
    const prepared = prepareProgram(programText)
    this.streamer.load(prepared.lines)
    this.stoppedJobProgressValue = null
    this.clearExecutionAttribution()
    this.jobLoadGeneration++
    this.jobCompleteEmitted = false
    return { ok: true, result: prepared }
  }

  /** Load an already-compiled line stream while preserving each generated
   * line's attribution to the original source program. Surface-mesh
   * compensation uses this because one arc or long feed can become several
   * short G1 blocks, yet the operator cursor must still name the source line
   * they came from. */
  loadPreparedJob(lines: StreamLine[]): LoadOutcome {
    this.streamer.load(lines)
    this.stoppedJobProgressValue = null
    this.clearExecutionAttribution()
    this.jobLoadGeneration++
    this.jobCompleteEmitted = false
    // Already compiled by the caller: nothing was stripped or skipped here,
    // and no line was rejected for length, so the result reports exactly what
    // was handed over rather than re-deriving numbers this path never had.
    return { ok: true, result: { lines, skipped: 0, overlongLines: [] } }
  }

  /**
   * Prepare a MID-PROGRAM start: stream `prelude` (modal restore +
   * positioning, built by runFromLine's planner) and then every program line
   * at or after `startLine`. Prelude lines carry sourceLine 0 so the UI
   * cursor and line list ignore them.
   */
  loadJobFrom(programText: string, startLine: number, prelude: string[]): LoadOutcome {
    const prepared = prepareProgram(programText)
    const lines: StreamLine[] = [
      ...prelude.map((text) => ({ text, sourceLine: 0 })),
      ...prepared.lines.filter((l) => l.sourceLine >= startLine),
    ]
    this.streamer.load(lines)
    this.stoppedJobProgressValue = null
    this.clearExecutionAttribution()
    this.jobLoadGeneration++
    this.jobCompleteEmitted = false
    return { ok: true, result: { ...prepared, lines } }
  }

  startJob(): boolean {
    if (this.phase !== 'connected' || this.jobActive) return false
    if (this.stopTimer !== null) return false
    if (this.lastState === 'alarm') return false
    if (this.singleBlock) return false // Single Block: stepJob is the only start
    if (this.streamer.progress().phase !== 'ready') return false
    if (this.mdiQueue.length > 0) return false // let manual traffic drain first
    this.seedExecutionAttribution()
    this.jobActive = true
    // The first streamed line advances controllerActivity in writeLine(), so
    // any earlier Idle proof is invalid before startJob() returns.
    // 'started' BEFORE the first send: a synchronous transport (the
    // simulator) can ack the whole job inside start(), and the completion
    // event must not precede the start event.
    this.events.onJobEvent?.('started', null)
    this.startedJobLoadGeneration = this.jobLoadGeneration
    this.streamer.start()
    this.emitProgress()
    return true
  }

  /** Pause = stop filling AND feed-hold so motion actually stops. */
  pauseJob(): void {
    if (!this.jobActive) return
    this.streamer.pause()
    this.feedHold()
    this.events.onJobEvent?.('paused', null)
  }

  /** Refused while Single Block is on: resuming would stream the remainder
   *  continuously. Returns whether the resume actually happened. */
  resumeJob(): boolean {
    if (!this.jobActive) return false
    if (this.singleBlock) return false
    if (!this.cycleResume()) return false
    this.streamer.resume()
    this.events.onJobEvent?.('resumed', null)
    this.emitProgress()
    return true
  }

  /**
   * Stop = feed hold, let deceleration settle, then soft reset to flush the
   * controller's buffer. The job is dead afterwards (GRBL parser state reset).
   */
  stopJob(): void {
    if (!this.jobActive || this.stopTimer !== null) return
    this.stoppedJobProgressValue = null
    this.streamer.pause()
    this.feedHold()
    this.stopTimer = setTimeout(() => {
      this.stopTimer = null
      this.stoppedJobProgressValue = this.streamer.progress()
      this.softReset()
      this.streamer.reset()
      this.jobActive = false
      this.events.onJobEvent?.('stopped', null)
      this.emitProgress()
    }, STOP_SETTLE_MS)
  }

  /**
   * Engage or release Single Block MODE at the controller boundary. Engaging
   * mid-stream constrains the streamer immediately: no further lines are
   * sent (lines already in GRBL's buffer finish executing). Releasing NEVER
   * auto-resumes - a paused job stays paused until an explicit resumeJob().
   */
  setSingleBlockMode(on: boolean): void {
    this.singleBlock = on
    if (on && this.jobActive && this.streamer.progress().phase === 'streaming') {
      this.streamer.pause()
      this.events.onJobEvent?.('paused', null)
      this.emitProgress()
    }
  }

  singleBlockMode(): boolean {
    return this.singleBlock
  }

  /**
   * Single-block: send exactly one program line. Starts the job on the first
   * step. The caller gates the NEXT step on the machine returning to Idle
   * (motion complete), giving true move-by-move execution.
   */
  stepJob(): boolean {
    if (this.phase !== 'connected' || this.lastState === 'alarm') return false
    if (this.stopTimer !== null) return false
    const prog = this.streamer.progress()
    const newlyLoaded = this.startedJobLoadGeneration !== this.jobLoadGeneration
    if (!this.jobActive) {
      if (prog.phase !== 'ready' || this.mdiQueue.length > 0) return false
      if (newlyLoaded) this.seedExecutionAttribution()
      this.jobActive = true
      // The stepped line advances controllerActivity in writeLine().
      this.events.onJobEvent?.('started', null)
      this.startedJobLoadGeneration = this.jobLoadGeneration
    } else if (newlyLoaded) {
      this.seedExecutionAttribution()
      // Loading a reviewed run-from slice replaces the streamer's authority
      // while an ordinary Single Block lifecycle can still be active. Its
      // first canonical step must publish the same start boundary so every
      // confirmation surface clears before the reviewed line is sent.
      this.events.onJobEvent?.('started', null)
      this.startedJobLoadGeneration = this.jobLoadGeneration
    }
    const sent = this.streamer.step()
    if (sent) this.emitProgress()
    return sent
  }

  /**
   * EMERGENCY STOP: immediate soft reset (0x18) - GRBL halts instantly and
   * flushes everything. No deceleration settle like stopJob(); position may
   * be lost if motion was in progress (GRBL raises the alarm if so). The job
   * is dead afterwards.
   */
  emergencyStop(): void {
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    this.events.onConsole?.({ dir: 'tx', text: '<EMERGENCY STOP>', severity: 'error' })
    this.softReset()
    this.settleMdi('emergency stop')
    const hadJob = this.jobActive || this.streamer.progress().phase !== 'empty'
    this.streamer.reset()
    if (this.jobActive) {
      this.jobActive = false
      this.events.onJobEvent?.('stopped', null)
    } else if (hadJob) {
      this.events.onJobEvent?.('stopped', null)
    }
    this.emitProgress()
  }

  jobProgress(): StreamerProgress {
    return this.streamer.progress()
  }

  /**
   * Return the controller to a VERIFIED idle state (WO-087): no buffered
   * motion left from the previous run, not in Hold, so the caller may arm a
   * program whose first executed line will be line 1 and nothing else.
   *
   * Every step is read off docs/machine/GRBL-PROTOCOL.md, not from memory:
   *
   *  1. STOP FEEDING + FEED HOLD. "on error:N the ALREADY-BUFFERED lines keep
   *     executing until the buffer drains -- a hard stop needs active
   *     intervention (stop feeding + feed hold)" (Streaming). The error path
   *     already does this; doing it again is idempotent and covers the paths
   *     that did not (a job left paused, a stop that never settled).
   *  2. SETTLE, THEN RESET. Alarm 3 is "abort during cycle (position LOST)"
   *     (Serial fundamentals), so the reset waits out the same deceleration
   *     window stopJob() uses rather than aborting motion that is still
   *     stopping.
   *  3. SOFT RESET 0x18. "Halts immediately, reprints banner, CLEARS
   *     PARSER/PLANNER, PRESERVES alarm lock" (Serial fundamentals). Clearing
   *     the planner is the only thing that actually empties the queued motion
   *     of the failed run, and re-initialising the parser is what leaves Hold
   *     behind - `~` would merely RESUME the old program instead.
   *  4. WAIT FOR THE BANNER. "Welcome banner ... on power-up and after soft
   *     reset -- detect it to confirm the device is GRBL and re-init is done"
   *     (Serial fundamentals). It is the controller's own statement that the
   *     flush finished, so it is what we wait for rather than a fixed delay.
   *  5. ASK, DO NOT ASSUME. A reset preserves the alarm lock and can itself
   *     raise ALARM:3, so the final word is a status report: `?` is answered
   *     "in ~5-20ms" (Status reports) with the live state.
   *
   * Anything short of a banner AND an Idle report is a refusal - there is no
   * safe guess about a controller that did not answer. Nothing sent here can
   * start motion: 0x21, 0x18 and 0x3F are the halt and query bytes.
   */
  resetToIdle(): Promise<ResetToIdleResult> {
    if (this.resetToIdleInFlight) return this.resetToIdleInFlight

    const pending = this.performResetToIdle()
    this.resetToIdleInFlight = pending
    this.emitResetToIdleState()
    void pending.then(
      () => this.finishResetToIdle(pending),
      () => this.finishResetToIdle(pending),
    )
    return pending
  }

  private async performResetToIdle(): Promise<ResetToIdleResult> {
    if (this.phase !== 'connected') {
      return { ok: false, reason: 'The controller is not connected.' }
    }
    const loadGeneration = this.jobLoadGeneration
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    this.streamer.pause()
    this.feedHold()
    const resetActivity = this.controllerActivity
    await new Promise<void>((resolve) => setTimeout(resolve, STOP_SETTLE_MS))
    if (this.phase !== 'connected') {
      return { ok: false, reason: 'The controller disconnected during the reset.' }
    }
    // A precondition checked before a 600ms await is stale by construction.
    // If another authority loaded or started work, REFUSE before 0x18: the
    // protocol says soft reset halts immediately and clears planner/parser,
    // which would abort that newer work and can lose position in motion.
    if (
      this.jobLoadGeneration !== loadGeneration ||
      this.jobActive ||
      this.controllerActivity !== resetActivity
    ) {
      return { ok: false, reason: 'A program was loaded or started during the reset settle.' }
    }
    const banner = this.nextBanner(HANDSHAKE_RESET_MS)
    this.softReset()
    const postResetActivity = this.controllerActivity
    if (!(await banner)) {
      return { ok: false, reason: 'It did not answer the reset with its startup banner.' }
    }
    await this.waitForStatusPairingWindow()
    const status = this.nextStatus(STATUS_CONFIRM_MS)
    this.queryStatus()
    const report = await status
    if (!report) {
      return { ok: false, reason: 'It did not report its state after the reset.' }
    }
    if (report.state !== 'idle') {
      return { ok: false, reason: `It reported "${report.state}" after the reset, not idle.` }
    }
    if (
      this.jobLoadGeneration !== loadGeneration ||
      this.jobActive ||
      this.controllerActivity !== postResetActivity
    ) {
      return { ok: false, reason: 'A program was loaded or started during the reset settle.' }
    }
    return { ok: true, reason: null }
  }

  private finishResetToIdle(pending: Promise<ResetToIdleResult>): void {
    if (this.resetToIdleInFlight !== pending) return
    this.resetToIdleInFlight = null
    this.emitResetToIdleState()
  }

  private emitResetToIdleState(): void {
    for (const listener of this.resetToIdleListeners) listener()
  }

  // ---- internals ----

  private setPhase(phase: ConnectionPhase, detail: string | null): void {
    this.phase = phase
    this.events.onConnection?.(phase, detail)
    this.events.onConnectionPhase?.(phase, detail)
  }

  private startPolling(): void {
    this.stopPolling()
    this.pollTick = 0
    this.pollTimer = setInterval(() => {
      this.pollTick++
      const active =
        this.jobActive ||
        this.lastState === 'run' ||
        this.lastState === 'jog' ||
        this.lastState === 'hold' ||
        this.lastState === 'home' ||
        this.lastState === 'door'
      if (active || this.pollTick % IDLE_POLL_EVERY_TICKS === 0) this.queryStatus()
    }, POLL_TICK_MS)
  }

  private stopPolling(): void {
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
  }

  private teardown(reason: string): void {
    this.stopPolling()
    if (this.stopTimer !== null) {
      clearTimeout(this.stopTimer)
      this.stopTimer = null
    }
    const hadJob = this.jobActive
    this.jobActive = false
    this.idleVerifiedAtActivity = null
    this.streamer.reset()
    this.clearExecutionAttribution()
    this.reportPositionScale = null
    this.axisStepsPerMm.clear()
    this.settleMdi(reason)
    this.homed = false
    this.version = null
    this.lastWco = null
    this.lastState = 'unknown'
    this.lastAccessories = ACCESSORIES_OFF
    this.transport = null
    this.bannerWaiters = []
    this.statusWaiters = []
    this.probeWaiters = []
    this.lastReport = null
    this.lastDerived = null
    this.pendingStatusQueries = []
    this.statusPairingNotBefore = 0
    this.feedHoldOutstanding = false
    if (this.phase !== 'disconnected') this.setPhase('disconnected', reason)
    if (hadJob) this.events.onJobEvent?.('stopped', null)
  }

  private handleClose(reason: string | null): void {
    if (this.phase === 'disconnected') return
    this.teardown(reason ?? 'connection closed')
  }

  private waitForBanner(timeoutMs: number): Promise<string | null> {
    if (this.version) return Promise.resolve(this.version)
    return this.nextBanner(timeoutMs)
  }

  /** Wait for the NEXT banner, never a remembered one - resetToIdle() needs
   *  proof that THIS reset re-initialised the controller, and a version string
   *  left over from the handshake proves nothing about that. */
  private nextBanner(timeoutMs: number): Promise<string | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.bannerWaiters = this.bannerWaiters.filter((w) => w !== waiter)
        resolve(null)
      }, timeoutMs)
      const waiter = (version: string) => {
        clearTimeout(timer)
        resolve(version)
      }
      this.bannerWaiters.push(waiter)
    })
  }

  private nextStatus(timeoutMs: number): Promise<GrblStatusReport | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.statusWaiters = this.statusWaiters.filter((w) => w !== waiter)
        resolve(null)
      }, timeoutMs)
      const waiter = (report: GrblStatusReport) => {
        clearTimeout(timer)
        resolve(report)
      }
      this.statusWaiters.push(waiter)
    })
  }

  /** WO-418. Wait for the NEXT [PRB:...] feedback line - probe()'s
   *  correlation with the G38.2 it just sent. Same idiom as nextStatus. */
  private nextProbeResult(timeoutMs: number): Promise<GrblOffsetEntry | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.probeWaiters = this.probeWaiters.filter((w) => w !== waiter)
        resolve(null)
      }, timeoutMs)
      const waiter = (entry: GrblOffsetEntry) => {
        clearTimeout(timer)
        resolve(entry)
      }
      this.probeWaiters.push(waiter)
    })
  }

  private waitForStatusPairingWindow(): Promise<void> {
    const remaining = this.statusPairingNotBefore - Date.now()
    return remaining > 0
      ? new Promise((resolve) => setTimeout(resolve, remaining))
      : Promise.resolve()
  }

  private dropExpiredStatusQueries(now: number): void {
    const remaining = this.pendingStatusQueries.filter(
      (query) => now - query.sentAt <= STATUS_QUERY_MAX_AGE_MS,
    )
    const lostVerifyingQuery = this.pendingStatusQueries.some(
      (query) => query.verifiesIdle && now - query.sentAt > STATUS_QUERY_MAX_AGE_MS,
    )
    if (lostVerifyingQuery) {
      // The missing reply may still be in the serial path. A brand-new token
      // created now must not launder that old report into fresh evidence.
      this.statusPairingNotBefore = Math.max(
        this.statusPairingNotBefore,
        now + STATUS_QUERY_MAX_AGE_MS,
      )
      this.idleVerifiedAtActivity = null
    }
    this.pendingStatusQueries = remaining
  }

  private async writeLine(text: string, severity: ConsoleEcho['severity']): Promise<void> {
    if (!this.transport) return
    this.controllerActivity++
    this.events.onConsole?.({ dir: 'tx', text, severity })
    try {
      await this.transport.write(encoder.encode(text + '\n'))
    } catch (err) {
      this.handleClose(err instanceof Error ? err.message : String(err))
    }
  }

  private async writeRealtime(byte: number, label: string | null): Promise<void> {
    if (!this.transport) return
    // `?` asks for the evidence; every other realtime byte can alter machine
    // state, motion, or a pending stop and therefore invalidates old evidence.
    let statusQuery: { activity: number; sentAt: number; verifiesIdle: boolean } | null = null
    if (byte === REALTIME.statusQuery) {
      const now = Date.now()
      this.dropExpiredStatusQueries(now)
      // One fresh query is already enough. Sending another would create an
      // unresolvable FIFO when replies pause, because reports carry no ID.
      if (this.pendingStatusQueries.length > 0) return
      // Keep the protocol's polling cadence during a drain window. A drain
      // token consumes its own reply without letting it prove Idle or extend
      // ambiguity forever as an "unmatched" report would.
      statusQuery = {
        activity: this.controllerActivity,
        sentAt: now,
        verifiesIdle:
          now >= this.statusPairingNotBefore &&
          !this.feedHoldOutstanding,
      }
      this.pendingStatusQueries.push(statusQuery)
    } else {
      this.controllerActivity++
      if (byte === REALTIME.feedHold) this.feedHoldOutstanding = true
      else if (byte === REALTIME.cycleStartResume || byte === REALTIME.softReset) {
        this.feedHoldOutstanding = false
      }
    }
    if (label) this.events.onConsole?.({ dir: 'tx', text: `<${label}>`, severity: 'info' })
    try {
      await this.transport.write(Uint8Array.of(byte))
    } catch (err) {
      if (statusQuery) {
        const index = this.pendingStatusQueries.indexOf(statusQuery)
        if (index >= 0) this.pendingStatusQueries.splice(index, 1)
      }
      this.handleClose(err instanceof Error ? err.message : String(err))
    }
  }

  private handleChunk(data: Uint8Array): void {
    for (const line of this.framer.push(data)) this.handleLine(line)
  }

  private handleLine(raw: string): void {
    const parsed = classifyGrblLine(raw)
    switch (parsed.kind) {
      case 'ok':
        this.routeAck(true, 0)
        break
      case 'error': {
        this.events.onConsole?.({
          dir: 'rx',
          text: `${raw} - ${parsed.message}`,
          severity: 'error',
        })
        this.routeAck(false, parsed.code, parsed.message)
        break
      }
      case 'alarm':
        this.handleAlarm(parsed.code, parsed.message, raw)
        break
      case 'status':
        this.handleStatus(parsed.report)
        break
      case 'welcome': {
        this.clearExecutionAttribution()
        this.parserModes = { units: 'mm', distanceMode: 'absolute', motionMode: 'G0', wcs: 'G54' }
        this.version = parsed.version
        this.events.onConsole?.({ dir: 'rx', text: raw, severity: 'info' })
        this.events.onWelcome?.(parsed.version)
        this.events.onReady?.(parsed.version)
        const waiters = this.bannerWaiters
        this.bannerWaiters = []
        for (const w of waiters) w(parsed.version)
        // A banner mid-session means the controller reset under us: any
        // in-flight accounting is void.
        if (this.jobActive) {
          this.streamer.reset()
          this.jobActive = false
          this.events.onJobEvent?.('stopped', null)
        }
        this.settleMdi('controller reset')
        // Any reset (expected or not) stops spindle and coolant, and leaves
        // the machine state unknown until it reports again (WO-087). The value
        // is set HERE; the event it raises goes at the very END of this branch,
        // so a subscriber cannot come between a reset and the safety state
        // below being restored.
        const accessoriesWere = this.lastAccessories
        this.lastAccessories = ACCESSORIES_OFF
        this.idleVerifiedAtActivity = null
        this.pendingStatusQueries = []
        this.statusPairingNotBefore = Date.now() + STATUS_QUERY_MAX_AGE_MS
        this.feedHoldOutstanding = false
        if (!this.expectedResetBanner) this.homed = false
        this.expectedResetBanner = false
        // Safety state is restored; now it is safe to let a subscriber run.
        if (accessoriesWere.spindle !== 'off' || accessoriesWere.flood || accessoriesWere.mist) {
          this.events.onAccessories?.(ACCESSORIES_OFF)
        }
        break
      }
      case 'setting':
        if (parsed.key === 13) this.reportPositionScale = Number(parsed.value) === 0 ? 1
          : Number(parsed.value) === 1 ? 25.4 : null
        if ([100, 101, 102].includes(parsed.key)) {
          const steps = Number(parsed.value)
          if (Number.isFinite(steps) && steps > 0) this.axisStepsPerMm.set(parsed.key, steps)
          else this.axisStepsPerMm.delete(parsed.key)
        }
        // Contract v3: settings are keyed "however that controller keys them",
        // as a string. GRBL's keys are the numbers after the `$`.
        this.settingsReadRows?.set(parsed.key, parsed.value)
        this.events.onSetting?.(String(parsed.key), parsed.value)
        this.events.onConsole?.({ dir: 'rx', text: raw, severity: 'info' })
        break
      case 'feedback': {
        if (parsed.label === 'GC') {
          const state = parseParserState(parsed.text)
          this.parserModes = state
          this.events.onParserState?.(state)
        } else {
          const offset = parseOffsetEntry(parsed.label, parsed.text)
          if (offset) {
            this.events.onOffset?.(offset)
            if (offset.label === 'PRB') {
              const waiters = this.probeWaiters
              this.probeWaiters = []
              for (const w of waiters) w(offset)
            }
          }
        }
        this.events.onConsole?.({ dir: 'rx', text: raw, severity: 'info' })
        break
      }
      case 'other':
        this.events.onConsole?.({ dir: 'rx', text: raw, severity: 'info' })
        break
    }
  }

  private routeAck(ok: boolean, code: number, message = ''): void {
    if (this.streamer.ownsNextAck()) {
      const ackedText = this.streamer.nextAckLine()?.text
      if (ok && ackedText) this.adoptManualParserModes(ackedText, false)
      const error = this.streamer.handleAck(ok, code)
      if (error) {
        // Halt-and-surface: lines already inside GRBL keep executing unless
        // we actively hold. Do so immediately.
        this.feedHold()
        this.jobActive = false
        this.events.onJobEvent?.('failed', this.fault(error.code, message, error.sourceLine, error.text))
      } else if (this.streamer.progress().phase === 'complete') {
        this.jobActive = false
        // A synchronous transport delivers acks REENTRANTLY (fill -> ack ->
        // fill...), so every unwinding stack frame sees phase 'complete' -
        // emit the completion exactly once per loaded job.
        if (!this.jobCompleteEmitted) {
          this.jobCompleteEmitted = true
          this.events.onJobEvent?.('completed', null)
        }
      }
      this.emitProgress()
      return
    }
    if (this.mdiQueue.length > 0) {
      const entry = this.mdiQueue.shift()!
      if (ok) this.adoptManualParserModes(entry.label)
      if (ok && entry.label.trim().toUpperCase() === '$H') {
        this.homed = true
        // null, not a synthesised axis list: `$H` runs whichever axes the
        // controller's $23/homing mask configures and its ok says only that
        // the cycle finished. Contract v3 documents null for exactly this.
        this.events.onHomed?.(null)
      }
      if (ok) this.events.onConsole?.({ dir: 'rx', text: 'ok', severity: 'info' })
      entry.resolve?.({ ok, code, message })
      return
    }
    // Unmatched ok (startup block echo etc.) - show it rather than hide it.
    if (ok) this.events.onConsole?.({ dir: 'rx', text: 'ok', severity: 'info' })
  }

  /** Settle every pending awaited command as failed - an alarm, reset, or
   *  disconnect means no further acks are coming for them. */
  private settleMdi(reason: string): void {
    const pending = this.mdiQueue
    this.mdiQueue = []
    for (const entry of pending) entry.resolve?.({ ok: false, code: -1, message: reason })
  }

  private handleAlarm(code: number, message: string, raw: string): void {
    const positionLost = GRBL_ALARMS_POSITION_LOST.has(code)
    // Datum loss is controller authority, not UI advice. Revoke it before any
    // callback can unlock or inspect a motion gate.
    if (positionLost) this.invalidateDatum(null)
    this.lastState = 'alarm'
    this.clearExecutionAttribution()
    this.feedHoldOutstanding = false
    this.events.onConsole?.({ dir: 'rx', text: `${raw} - ${message}`, severity: 'error' })
    this.settleMdi(GRBL_ALARM_MESSAGES[code] ?? message)
    if (this.jobActive) {
      this.streamer.pause()
      this.jobActive = false
      // `raw` is the ALARM:N line itself, which the decoded message already
      // says in words - nothing to append.
      this.events.onJobEvent?.(
        'failed',
        this.fault(code, GRBL_ALARM_MESSAGES[code] ?? message, this.streamer.progress().ackedSourceLine),
      )
      this.emitProgress()
    }
    this.events.onAlarm?.(code, message, positionLost)
  }

  private handleStatus(report: GrblStatusReport): void {
    const now = Date.now()
    this.dropExpiredStatusQueries(now)
    // Consume the whole pairing state. With the single-flight cap this is
    // either one timely candidate or none; an unsolicited/late report never
    // leaves arithmetic behind that can offset every later poll.
    const query = this.pendingStatusQueries.length === 1
      ? this.pendingStatusQueries[0]
      : null
    const verificationQuery = query?.verifiesIdle ? query : null
    this.pendingStatusQueries = []
    if (!query) {
      // Unmatched means unsolicited or too late. Let any adjacent bytes from
      // the same ambiguous interval drain before a later poll starts clean.
      this.statusPairingNotBefore = Math.max(
        this.statusPairingNotBefore,
        now + STATUS_QUERY_MAX_AGE_MS,
      )
    }
    if (report.wco) this.lastWco = report.wco
    this.lastState = report.state
    // The ONLY place an activity generation becomes verified. The report
    // describes the machine when GRBL received `?`, not when the app parses
    // the reply. Traffic in that reply window must therefore leave the old
    // captured generation unequal to the live one. Idle alone is also not
    // enough: streamer or MDI lines can still be un-acked motion.
    this.idleVerifiedAtActivity =
      report.state === 'idle' &&
      !this.jobActive &&
      this.streamer.progress().bytesInFlight === 0 &&
      this.mdiQueue.length === 0
        ? verificationQuery?.activity ?? null
        : null
    // GRBL appends A: only to override-bearing reports and only when an
    // accessory is on: A present -> take it; Ov present without A -> all off;
    // neither -> the report carries no accessory info, keep the cache.
    if (report.accessories) this.setAccessories(report.accessories)
    else if (report.overrides) this.setAccessories(ACCESSORIES_OFF)
    const wco = this.lastWco
    const derived: DerivedPosition = {
      mpos: report.mpos ?? (report.wpos && wco ? addVec(report.wpos, wco) : null),
      wpos: report.wpos ?? (report.mpos && wco ? subVec(report.mpos, wco) : null),
      accessories: this.lastAccessories,
    }
    // WO-418: cache the merged snapshot status() reads from.
    this.lastReport = report
    this.lastDerived = derived
    const scale = this.reportPositionScale
    const position = derived.wpos && scale !== null ? scaleVec(derived.wpos, scale) : null
    this.executingSourceLine = this.executionTracker.resolve(report, position, this.streamer.progress().sentLines)
    this.events.onStatus?.(report, derived)
    // resetToIdle waits for the reply to ITS query. An unmatched push may
    // update the UI above, but cannot satisfy that safety proof.
    if (verificationQuery) {
      const waiters = this.statusWaiters
      this.statusWaiters = []
      for (const w of waiters) w(report)
    }
  }

  /** Cache the resolved accessory state and raise contract v3's
   *  `onAccessories` when it actually CHANGES. GRBL appends `A:` only to
   *  override-bearing reports, so re-announcing an unchanged value on every
   *  poll would be noise, not news. `capabilities.ownsSpindle` is true here:
   *  this controller really does drive the spindle and coolant. */
  private setAccessories(next: AccessoryState): void {
    const prev = this.lastAccessories
    this.lastAccessories = next
    if (prev.spindle === next.spindle && prev.flood === next.flood && prev.mist === next.mist) return
    this.events.onAccessories?.(next)
  }

  private clearExecutionAttribution(): void {
    this.executingSourceLine = null
    this.executionTracker.load([], { position: null, wco: null, units: 'mm',
      absolute: true, motion: null, wcs: null })
  }

  private seedExecutionAttribution(): void {
    const scale = this.reportPositionScale
    this.executionTracker.load(this.streamer.programLines(), {
      position: this.lastState === 'idle' && this.lastDerived?.wpos && scale !== null
        ? scaleVec(this.lastDerived.wpos, scale) : null,
      wco: this.lastWco && scale !== null ? scaleVec(this.lastWco, scale) : null,
      units: this.parserModes.units ?? 'mm',
      absolute: this.parserModes.distanceMode !== 'incremental',
      motion: this.parserModes.motionMode,
      wcs: this.parserModes.wcs,
      toleranceMm: this.axisStepsPerMm.size === 3 && scale !== null
        ? Math.max(0.02, Math.hypot(...[100, 101, 102].map(axis =>
          0.5 / this.axisStepsPerMm.get(axis)! + (scale === 1 ? 0.0005 : 0.00127))))
        : null,
    })
  }

  /** Manual G-code changes the next program's modal starting facts only after
   * its successful ACK. $J never changes GRBL's parser state. */
  private adoptManualParserModes(text: string, clearAttribution = true): void {
    if (text.trim().startsWith('$')) return
    const gs = tokenizeLine(text, 0).words.filter(w => w.letter === 'G').map(w => w.value)
    for (const g of gs) {
      if (g === 20 || g === 21) this.parserModes.units = g === 20 ? 'inch' : 'mm'
      if (g === 90 || g === 91) this.parserModes.distanceMode = g === 90 ? 'absolute' : 'incremental'
      if ([0, 1, 2, 3, 80].includes(g)) this.parserModes.motionMode = `G${g}`
      if (g >= 54 && g <= 59) this.parserModes.wcs = `G${g}` as WcsId
    }
    // A manual move must not inherit a loaded program's identity.
    if (clearAttribution) this.clearExecutionAttribution()
  }

  private emitProgress(): void {
    this.events.onJobProgress?.(this.streamer.progress())
  }

  /**
   * GRBL's failure facts -> the contract's `JobFault`. `moveId` is always
   * null: this controller streams TEXT, so it knows which SOURCE LINE failed
   * and has no move ids at all - the exact split contract v3 documents.
   *
   * The offending program line joins the message rather than being dropped.
   * `JobFault` has no field for it and inventing one is not this slice's call,
   * but "error 20 on line 812" without the line itself is not a sentence an
   * operator can act on.
   */
  private fault(code: number, message: string, sourceLine: number, offendingLine?: string): JobFault {
    const offending = offendingLine?.trim()
    return {
      code,
      message: offending ? `${message} (${offending})` : message,
      line: sourceLine,
      moveId: null,
    }
  }
}

function addVec(a: MachineVec3, b: MachineVec3): MachineVec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

function subVec(a: MachineVec3, b: MachineVec3): MachineVec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

function scaleVec(v: MachineVec3, scale: number): MachineVec3 {
  return { x: v.x * scale, y: v.y * scale, z: v.z * scale }
}
