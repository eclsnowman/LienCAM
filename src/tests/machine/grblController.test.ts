import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrblController, type GrblControllerEvents } from '../../lib/machine/grbl/controller'
import { REALTIME } from '../../lib/machine/grbl/constants'
import type { MachineTransport, TransportEvents } from '../../lib/machine/types'

const enc = new TextEncoder()
const dec = new TextDecoder()

class FakeTransport implements MachineTransport {
  events: TransportEvents | null = null
  written: Uint8Array[] = []
  closed = false

  async start(events: TransportEvents): Promise<void> {
    this.events = events
  }

  async write(data: Uint8Array): Promise<void> {
    this.written.push(data)
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.events?.onClose(null)
  }

  feed(text: string): void {
    this.events!.onChunk(enc.encode(text))
  }

  unplug(): void {
    this.closed = true
    this.events!.onClose('device disconnected')
  }

  /** All written line-writes decoded, realtime single bytes as [0xNN]. */
  writtenItems(): string[] {
    return this.written.map((w) =>
      w.length === 1 && (w[0] < 0x20 || w[0] > 0x7e)
        ? `[0x${w[0].toString(16)}]`
        : dec.decode(w).replace(/\n$/, ''),
    )
  }

  realtimeBytes(): number[] {
    return this.written.filter((w) => w.length === 1).map((w) => w[0])
  }
}

function makeEvents() {
  return {
    onConnection: vi.fn(),
    onStatus: vi.fn(),
    onConsole: vi.fn(),
    onAlarm: vi.fn(),
    onJobProgress: vi.fn(),
    onJobEvent: vi.fn(),
    onWelcome: vi.fn(),
  } satisfies GrblControllerEvents
}

async function connect() {
  const events = makeEvents()
  const ctrl = new GrblController(events)
  const ft = new FakeTransport()
  const pending = ctrl.connect({ kind: 'bytes', transport: ft })
  await vi.advanceTimersByTimeAsync(0) // let start() settle and the waiter register
  ft.feed("Grbl 1.1h ['$' for help]\r\n")
  await pending
  ft.written = [] // drop handshake-era writes for cleaner assertions
  return { ctrl, ft, events }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GrblController handshake', () => {
  it('connects on the welcome banner and reports the version', async () => {
    const { ctrl, events } = await connect()
    expect(ctrl.connectionPhase()).toBe('connected')
    expect(ctrl.grblVersion()).toBe('1.1h')
    expect(events.onWelcome).toHaveBeenCalledWith('1.1h')
    expect(events.onConnection).toHaveBeenCalledWith('connected', '1.1h')
  })

  it('probes with a soft reset when the banner does not arrive, then connects', async () => {
    const events = makeEvents()
    const ctrl = new GrblController(events)
    const ft = new FakeTransport()
    const pending = ctrl.connect({ kind: 'bytes', transport: ft })
    await vi.advanceTimersByTimeAsync(2500) // banner window elapses
    expect(ft.realtimeBytes()).toContain(REALTIME.softReset)
    ft.feed("Grbl 1.1f ['$' for help]\r\n")
    await pending
    expect(ctrl.connectionPhase()).toBe('connected')
    expect(ctrl.grblVersion()).toBe('1.1f')
  })

  it('fails loudly when nothing ever answers', async () => {
    const events = makeEvents()
    const ctrl = new GrblController(events)
    const ft = new FakeTransport()
    const pending = ctrl.connect({ kind: 'bytes', transport: ft })
    pending.catch(() => undefined) // avoid unhandled rejection while timers advance
    await vi.advanceTimersByTimeAsync(6000)
    await expect(pending).rejects.toThrow(/welcome banner/i)
    expect(ctrl.connectionPhase()).toBe('disconnected')
  })
})

describe('GrblController status handling', () => {
  it('caches WCO and derives work position on reports that omit it', async () => {
    const { ft, events } = await connect()
    ft.feed('<Idle|MPos:10.000,10.000,5.000|WCO:10.000,0.000,0.000>\n')
    let [report, derived] = events.onStatus.mock.calls.at(-1)!
    expect(report.state).toBe('idle')
    expect(derived.wpos).toEqual({ x: 0, y: 10, z: 5 })
    ft.feed('<Idle|MPos:12.000,10.000,5.000>\n')
    ;[report, derived] = events.onStatus.mock.calls.at(-1)!
    expect(derived.wpos).toEqual({ x: 2, y: 10, z: 5 }) // cached WCO applied
    expect(derived.mpos).toEqual({ x: 12, y: 10, z: 5 })
  })

  it('polls slowly when idle and fast when running', async () => {
    const { ft } = await connect()
    ft.feed('<Idle|MPos:0,0,0>\n')
    ft.written = []
    await vi.advanceTimersByTimeAsync(1000)
    const idlePolls = ft.realtimeBytes().filter((b) => b === REALTIME.statusQuery).length
    expect(idlePolls).toBe(1) // 1Hz at idle
    ft.feed('<Run|MPos:0,0,0>\n')
    ft.written = []
    await vi.advanceTimersByTimeAsync(1000)
    const runPolls = ft.realtimeBytes().filter((b) => b === REALTIME.statusQuery).length
    expect(runPolls).toBe(5) // 5Hz while running
  })
})

describe('GrblController MDI and jog', () => {
  it('sends an MDI line and consumes its ack', async () => {
    const { ctrl, ft } = await connect()
    expect(ctrl.sendCommand('G21')).toBe(true)
    expect(ft.writtenItems()).toContain('G21')
    ft.feed('ok\n')
    // ack consumed without touching job machinery
    expect(ctrl.jobProgress().phase).toBe('empty')
  })

  it('builds a correct incremental jog line', async () => {
    const { ctrl, ft } = await connect()
    ft.feed('<Idle|MPos:0,0,0>\n')
    expect(ctrl.jog('X', 0.1, 600)).toBe(true)
    expect(ctrl.jog('Z', -1, 300)).toBe(true)
    const items = ft.writtenItems()
    expect(items).toContain('$J=G91 G21 X0.1 F600')
    expect(items).toContain('$J=G91 G21 Z-1 F300')
  })

  it('refuses jog while in alarm', async () => {
    const { ctrl, ft } = await connect()
    ft.feed('ALARM:1\n')
    expect(ctrl.jog('X', 1, 600)).toBe(false)
  })

  it('zeroes the active work offset with G10 L20 P0', async () => {
    const { ctrl, ft } = await connect()
    expect(ctrl.zeroWorkAxis('Z')).toBe(true)
    expect(ft.writtenItems()).toContain('G10 L20 P0 Z0')
  })
})

describe('GrblController job lifecycle', () => {
  it('streams a program to completion', async () => {
    const { ctrl, ft, events } = await connect()
    // WO-423: loadJob returns a LoadOutcome. GRBL has an interpreter, so it
    // never refuses on capability grounds - assert that, then the lines.
    const load = ctrl.loadJob('G21\nG90\nG1 X5 F100')
    if (!load.ok) throw new Error(`GRBL refused a text load: ${load.reason}`)
    expect(load.result.lines).toHaveLength(3)
    expect(ctrl.startJob()).toBe(true)
    expect(events.onJobEvent).toHaveBeenCalledWith('started', null)
    expect(ft.writtenItems()).toEqual(expect.arrayContaining(['G21', 'G90', 'G1 X5 F100']))
    ft.feed('ok\nok\nok\n')
    expect(events.onJobEvent).toHaveBeenCalledWith('completed', null)
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(ctrl.jobProgress().phase).toBe('complete')
  })

  it('blocks MDI while a job is active and start while MDI is pending', async () => {
    const { ctrl, ft } = await connect()
    expect(ctrl.sendCommand('G21')).toBe(true)
    ctrl.loadJob('G90')
    expect(ctrl.startJob()).toBe(false) // MDI ack still pending
    ft.feed('ok\n')
    expect(ctrl.startJob()).toBe(true)
    expect(ctrl.sendCommand('G0 X0')).toBe(false) // job active
  })

  it('halts with feed hold and surfaces the source line on error:N mid-stream', async () => {
    const { ctrl, ft, events } = await connect()
    ctrl.loadJob('G21\nG91.5\nG1 X5 F100')
    ctrl.startJob()
    ft.feed('ok\n')
    ft.written = []
    ft.feed('error:20\n')
    expect(ft.realtimeBytes()).toContain(REALTIME.feedHold)
    const failed = events.onJobEvent.mock.calls.find((c) => c[0] === 'failed')
    expect(failed).toBeDefined()
    // WO-423: the contract's JobFault. `line` (not sourceLine) because a text
    // streamer knows the source LINE; `moveId` is null because GRBL has none.
    expect(failed![1]).toMatchObject({ code: 20, line: 2, moveId: null })
    expect(ctrl.hasActiveJob()).toBe(false)
  })

  it('hard-stops the job and flags position-lost alarms', async () => {
    const { ctrl, ft, events } = await connect()
    ctrl.loadJob('G21\nG1 X5 F100')
    ctrl.startJob()
    ft.feed('ALARM:1\n')
    expect(events.onAlarm).toHaveBeenCalledWith(1, expect.stringMatching(/hard limit/i), true)
    const failed = events.onJobEvent.mock.calls.find((c) => c[0] === 'failed')
    expect(failed).toBeDefined()
    expect(ctrl.hasActiveJob()).toBe(false)
  })

  it('stop sequence: feed hold, settle, soft reset', async () => {
    const { ctrl, ft, events } = await connect()
    ctrl.loadJob('G21\nG1 X5 F100')
    ctrl.startJob()
    ft.written = []
    ctrl.stopJob()
    expect(ft.realtimeBytes()).toEqual([REALTIME.feedHold])
    expect(ctrl.resumeJob()).toBe(false)
    expect(ctrl.stepJob()).toBe(false)
    expect(ctrl.cycleResume()).toBe(false)
    expect(ft.realtimeBytes()).not.toContain(REALTIME.cycleStartResume)
    await vi.advanceTimersByTimeAsync(600)
    expect(ft.realtimeBytes()).toContain(REALTIME.softReset)
    expect(events.onJobEvent).toHaveBeenCalledWith('stopped', null)
    expect(ctrl.jobProgress().phase).toBe('empty')
  })

  it('kills the session and job on transport loss', async () => {
    const { ctrl, ft, events } = await connect()
    ctrl.loadJob('G21\nG1 X5 F100')
    ctrl.startJob()
    ft.unplug()
    expect(ctrl.connectionPhase()).toBe('disconnected')
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(events.onConnection).toHaveBeenCalledWith('disconnected', 'device disconnected')
    expect(events.onJobEvent).toHaveBeenCalledWith('stopped', null)
  })

  it('a mid-session banner (external reset) voids the job', async () => {
    const { ctrl, ft, events } = await connect()
    ctrl.loadJob('G21\nG1 X5 F100')
    ctrl.startJob()
    ft.feed("Grbl 1.1h ['$' for help]\r\n")
    expect(ctrl.hasActiveJob()).toBe(false)
    expect(events.onJobEvent).toHaveBeenCalledWith('stopped', null)
  })
})

describe('GrblController overrides', () => {
  it('passes override bytes straight through as realtime', async () => {
    const { ctrl, ft } = await connect()
    ctrl.overrideByte(REALTIME.feedOvrCoarsePlus, 'feed +10%')
    ctrl.overrideByte(REALTIME.spindleOvrReset, 'spindle 100%')
    expect(ft.realtimeBytes()).toEqual([REALTIME.feedOvrCoarsePlus, REALTIME.spindleOvrReset])
  })
})
