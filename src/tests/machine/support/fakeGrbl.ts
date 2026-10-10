// FakeGrbl - a GRBL controller with enough real behavior to be HONEST (WO-087).
//
// WO-082 shipped a safety defect that its own tests reported as success, and
// the reason was the fixture. The old fake only RECORDED writes: no motion
// state, no RX buffer, no planner queue, no Feed Hold. A test written against
// it could not tell "the controller is idle and empty" from "the controller is
// in Hold with six lines of the failed run still queued inside it", so the
// strongest thing it could assert was that the app had written the same bytes
// twice. Its failed-cycle test then INJECTED an Idle status the production
// error path never produces. A fixture that cannot represent the failure will
// always report success - the proof has to be capable of failing.
//
// So this models the controller, strictly from docs/machine/GRBL-PROTOCOL.md:
//
//  - "Every accepted line answers ok or error:N ... Nothing in an errored line
//    ran" -> an errored line never enters the planner.
//  - an ok means PARSED, not finished: accepted motion lines go into a PLANNER
//    queue and execute later, one block per tick.
//  - "on error:N the ALREADY-BUFFERED lines keep executing until the buffer
//    drains -- a hard stop needs active intervention (stop feeding + feed
//    hold)" -> the planner keeps its lines after an error, and only feed hold
//    stops it running them.
//  - feed hold `!` 0x21 "decelerate, HOLD state"; cycle start `~` 0x7E
//    resumes it. Nothing else leaves Hold except a reset.
//  - "Soft reset = byte 0x18 ... clears parser/planner, PRESERVES alarm lock"
//    and reprints the welcome banner.
//  - status `?` 0x3F is DERIVED from planner + hold + alarm and answered in
//    ~5-20ms. No test writes a state into this fake.
//
// Everything GRBL says is delivered on a timer, exactly as a real device
// answers while the app is awaiting - so a test drives it with
// vi.advanceTimersByTimeAsync() and never hand-feeds a response.
//
// WO-1298 added POSITION to it, under the rule ADR-0048 s3 sets: this double
// may answer a question some test actually asks, and may not answer anything
// else. What it gained is exactly what "where did the machine land, under
// which offset" needs, still read out of docs/machine/GRBL-PROTOCOL.md:
//
//  - a work-offset table and a modal WCS word, so an executed block lands at
//    "work coordinate + the offset in force AT THE TIME it executed",
//  - position reported the two ways GRBL's $10 reports it (MPos, or WPos plus
//    the WCO the sender must add back), because a controller that derives
//    machine coordinates has to be exercised deriving them,
//  - WCO on the first report and on every report where it CHANGED, which is
//    what GRBL does and what makes a sender's cached WCO load-bearing.
//
// It still models nothing it is not asked about: no inch mode, no incremental
// distance mode, no G92, no G53. Those are recorded in `unmodelled` instead of
// being silently mis-executed, so a future test that needs one extends this
// file rather than getting a confidently wrong number out of it.

import type { MachineTransport, MachineVec3, TransportEvents, WcsId } from '../../../lib/machine/types'

export const GRBL_BANNER = "Grbl 1.1h ['$' for help]"

/** One device tick: GRBL answers what it owes and runs one planner block. */
export const FAKE_TICK_MS = 5

const enc = new TextEncoder()
const dec = new TextDecoder()

const WCS_WORDS: ReadonlySet<string> = new Set(['G54', 'G55', 'G56', 'G57', 'G58', 'G59'])
/** Words that would move the machine somewhere this double does not compute. */
const UNMODELLED_WORDS: ReadonlySet<string> = new Set(['G20', 'G91', 'G92', 'G53', 'G28', 'G30'])

/** GRBL reports three decimals. */
function xyz(v: MachineVec3): string {
  return `${v.x.toFixed(3)},${v.y.toFixed(3)},${v.z.toFixed(3)}`
}

export type FakeGrblState = 'Idle' | 'Run' | 'Hold' | 'Alarm'

export class FakeGrbl implements MachineTransport {
  events: TransportEvents | null = null
  /** Every raw write, so byte-level assertions stay possible. */
  written: Uint8Array[] = []
  /** Lines GRBL has ACCEPTED and not yet executed - its planner queue. This is
   *  the buffered motion the protocol warns keeps running after error:N. */
  planner: string[] = []
  /** Lines that actually RAN on the machine, in order. */
  executed: string[] = []
  /** Latched by feed hold; left only by cycle start or a soft reset. */
  hold = false
  /** Alarm lock. A soft reset deliberately does NOT clear it. */
  alarm: number | null = null
  /** The one line answered error:20. Nothing in it runs. */
  errorOn: string | null = null
  /** Soft resets seen - proof a flush actually reached the controller. */
  resets = 0
  /** WO-128. Query replies are rendered when `?` reaches the fake, like the
   *  device snapshotting its state, but may be delivered later so the harness
   *  can represent serial latency beyond a poll period. */
  statusReplyDelayMs = 0
  /** A live transport may stop answering status queries without closing. */
  answerStatusQueries = true

  // ---- WO-1298: position, offsets, and how they are reported ----

  /** Where the machine actually is, in MACHINE coordinates. Only executed
   *  planner blocks move it - an `ok` is a parse, not a move. */
  machinePos: MachineVec3 = { x: 0, y: 0, z: 0 }
  /** The modal work coordinate system, changed by a G54..G59 word executing. */
  wcs: WcsId = 'G54'
  /** Machine coordinates of each WCS zero. Unset systems sit on machine zero. */
  offsets: Partial<Record<WcsId, MachineVec3>> = {}
  /** GRBL's `$10` choice: report MPos (factory default) or WPos. */
  reportPosition: 'mpos' | 'wpos' = 'mpos'
  /** GRBL re-sends WCO whenever it changes. Set false to model a device that
   *  reports it once and never again - the negative control for a sender that
   *  derives machine coordinates from a cached WCO. */
  refreshWcoOnChange = true
  /** Milliseconds one planner block occupies. Default: one tick, the
   *  behaviour every pre-WO-1298 test was written against. */
  msPerBlock = FAKE_TICK_MS
  /** Words seen on an executed line that WOULD move the machine somewhere this
   *  double does not model. Never silently ignored; a test asserts this is
   *  empty, so a program that needs one fails loudly instead of quietly. */
  unmodelled: string[] = []

  private out: string[] = []
  private timer: ReturnType<typeof setInterval> | null = null
  private delayedOutputTimers = new Set<ReturnType<typeof setTimeout>>()
  private lastSentWco: string | null = null
  private blockDueInMs = 0

  /** GRBL's own state, derived - never set by a test. */
  state(): FakeGrblState {
    if (this.alarm !== null) return 'Alarm'
    if (this.hold) return 'Hold'
    return this.planner.length > 0 ? 'Run' : 'Idle'
  }

  async start(events: TransportEvents): Promise<void> {
    this.events = events
    this.out.push(GRBL_BANNER) // opening the port resets the MCU via DTR
    this.timer = setInterval(() => this.tick(), FAKE_TICK_MS)
  }

  async write(data: Uint8Array): Promise<void> {
    this.written.push(data)
    if (data.length === 1) {
      this.realtime(data[0])
      return
    }
    const text = dec.decode(data).replace(/\r?\n$/, '')
    if (this.alarm !== null) {
      if (text === '$X') {
        this.alarm = null
        this.hold = false
        this.out.push('ok')
        return
      }
      this.out.push('error:9') // "All g-code answers error:9 until $X or $H"
      return
    }
    if (text === this.errorOn) {
      this.out.push('error:20')
      return // nothing in an errored line ran: it never reaches the planner
    }
    // `$J=` is GRBL's jog motion command, not a settings query. Keep this
    // before the generic `$...` branch: treating it as harmless traffic makes
    // the fixture incapable of reproducing a stale-Idle re-arm race.
    if (text.startsWith('$J=')) {
      this.planner.push(text)
      this.out.push('ok')
      return
    }
    if (text.startsWith('$')) {
      this.out.push('ok') // settings/state queries occupy no planner block
      return
    }
    this.planner.push(text)
    this.out.push('ok')
  }

  async close(): Promise<void> {
    if (this.timer !== null) {
      clearInterval(this.timer)
      this.timer = null
    }
    for (const timer of this.delayedOutputTimers) clearTimeout(timer)
    this.delayedOutputTimers.clear()
    this.events?.onClose(null)
  }

  /** Raise an alarm the way a real controller pushes one, unsolicited. */
  raiseAlarm(code: number): void {
    this.alarm = code
    this.planner = []
    this.out.push(`ALARM:${code}`)
  }

  /** Emit a status report that answers no query. GRBL status reports are
   *  unsolicited push messages as well as query replies, so tests need this
   *  independent route instead of hand-injecting a transport chunk. */
  pushStatus(delayMs = 0): void {
    this.queueOutput(this.renderStatus(), delayMs)
  }

  /** g-code / MDI lines the app sent. */
  lines(): string[] {
    return this.written.filter((w) => w.length > 1).map((w) => dec.decode(w).replace(/\n$/, ''))
  }

  /** Realtime bytes (feed hold, cycle resume, soft reset, status query). */
  bytes(): number[] {
    return this.written.filter((w) => w.length === 1).map((w) => w[0])
  }

  private realtime(byte: number): void {
    switch (byte) {
      case 0x21: // feed hold - decelerate and stop executing
        this.hold = true
        break
      case 0x7e: // cycle start / resume - the ONLY release besides a reset
        this.hold = false
        break
      case 0x85: // jog cancel - flush the jog queue
        this.planner = []
        break
      case 0x18: // soft reset: halts, clears parser/planner, reprints banner
        this.resets++
        this.planner = []
        this.hold = false
        this.out.push(GRBL_BANNER)
        this.lastSentWco = null // a restarted parser re-announces its WCO
        break // the alarm lock is PRESERVED, on purpose
      case 0x3f: // status query
        if (this.answerStatusQueries) {
          this.queueOutput(this.renderStatus(), this.statusReplyDelayMs)
        }
        break
      default:
        break
    }
  }

  /** The offset in force right now, in machine coordinates. */
  private wco(): MachineVec3 {
    return this.offsets[this.wcs] ?? { x: 0, y: 0, z: 0 }
  }

  private renderStatus(): string {
    const wco = this.wco()
    const p = this.machinePos
    const field =
      this.reportPosition === 'wpos'
        ? `WPos:${xyz({ x: p.x - wco.x, y: p.y - wco.y, z: p.z - wco.z })}`
        : `MPos:${xyz(p)}`
    // GRBL sends WCO on the first report and again whenever it changes; a
    // sender is expected to remember it in between.
    const rendered = xyz(wco)
    const changed = this.lastSentWco === null || (this.refreshWcoOnChange && rendered !== this.lastSentWco)
    this.lastSentWco = rendered
    return `<${this.state()}|${field}|FS:0,0${changed ? `|WCO:${rendered}` : ''}>`
  }

  /**
   * Run one planner block on the machine. Absolute (G90) motion only: X/Y/Z
   * are WORK coordinates, so the machine lands at work + the offset of the WCS
   * in force at THIS moment, and unspecified axes hold their last position.
   */
  private execute(text: string): void {
    this.executed.push(text)
    if (text.startsWith('$')) return // jogs and queries are not modelled motion
    const words = text.toUpperCase().split(/\s+/).filter(Boolean)
    for (const word of words) {
      if (WCS_WORDS.has(word)) this.wcs = word as WcsId
      if (UNMODELLED_WORDS.has(word)) this.unmodelled.push(word)
    }
    if (!words.some((word) => word === 'G0' || word === 'G1')) return
    const wco = this.wco()
    const next = { ...this.machinePos }
    for (const word of words) {
      const axis = /^([XYZ])(-?\d*\.?\d+)$/.exec(word)
      if (axis) {
        const key = axis[1].toLowerCase() as keyof MachineVec3
        next[key] = Number(axis[2]) + wco[key]
      }
    }
    this.machinePos = next
  }

  private queueOutput(line: string, delayMs: number): void {
    if (delayMs <= 0) {
      this.out.push(line)
      return
    }
    const timer = setTimeout(() => {
      this.delayedOutputTimers.delete(timer)
      this.out.push(line)
    }, delayMs)
    this.delayedOutputTimers.add(timer)
  }

  private tick(): void {
    this.blockDueInMs -= FAKE_TICK_MS
    if (this.alarm === null && !this.hold && this.planner.length > 0 && this.blockDueInMs <= 0) {
      this.blockDueInMs = this.msPerBlock
      this.execute(this.planner.shift()!)
    }
    if (this.out.length === 0) return
    const say = this.out.splice(0)
    this.events?.onChunk(enc.encode(say.join('\r\n') + '\r\n'))
  }
}
