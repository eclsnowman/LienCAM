// WO-418: GrblController implements MachineController.
//
// This is the one test that stops a future change quietly inventing numbers
// for fields GRBL cannot report (ADR-0041's "no lowest common denominator" /
// "never faked" rules). It checks three things:
//  1. capabilities reports GRBL's real limits, not aspirational ones.
//  2. the optional interface members GRBL cannot serve are genuinely absent
//     (not stubbed with a false/no-op implementation).
//  3. status() reports null - never a placeholder - for what GRBL cannot
//     supply, even when GRBL's own report contains an adjacent but different
//     field (Bf: is planner blocks/RX bytes, not a move count).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { GrblController, type GrblControllerEvents } from '../../lib/machine/grbl/controller'
import type { MachineController } from '../../lib/machine/controller'
import type { MachineTransport, TransportEvents } from '../../lib/machine/types'
import { REALTIME } from '../../lib/machine/grbl/constants'

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
    this.events!.onChunk(new TextEncoder().encode(text))
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
    // WO-423 / contract v3: the channels machineSession used to reach past the
    // interface for. GRBL raises all of these through ControllerEvents now.
    onConnectionPhase: vi.fn(),
    onReady: vi.fn(),
    onOffset: vi.fn(),
    onSetting: vi.fn(),
    onHomed: vi.fn(),
    onAccessories: vi.fn(),
    onParserState: vi.fn(),
  } satisfies GrblControllerEvents
}

async function connect() {
  const events = makeEvents()
  const ctrl = new GrblController(events)
  const ft = new FakeTransport()
  const pending = ctrl.connect({ kind: 'bytes', transport: ft })
  await vi.advanceTimersByTimeAsync(0)
  ft.feed("Grbl 1.1h ['$' for help]\r\n")
  await pending
  return { ctrl, ft, events }
}

beforeEach(() => {
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('GrblController implements MachineController', () => {
  it('is assignable to the MachineController type', () => {
    // Compile-time proof, not just a runtime one. WO-418 recorded a finding
    // here - loadJob/loadJobFrom/jobProgress/stoppedJobProgress really return
    // LoadResult/StreamerProgress, not the interface's invented trimmed
    // shapes - and it needed a ts-expect-error to stay visible. Contract v2
    // (WO-422) adopted the real shapes, so the assignment now holds outright.
    const ctrl: MachineController = new GrblController(makeEvents())
    expect(ctrl).toBeInstanceOf(GrblController)
  })

  it('reports GRBL capabilities honestly - narrow, not aspirational', () => {
    const ctrl = new GrblController(makeEvents())
    expect(ctrl.capabilities).toEqual({
      geometryQueue: false,
      // WO-2581: a uniquely proven executing source block is now available;
      // ambiguous frames still return null rather than ACK progress.
      executingMoveId: true,
      bufferSeconds: false,
      // Contract v2: text is GRBL's ONLY program route, so this one is true.
      gcodeText: true,
      perAxisHoming: false,
      ownsSpindle: true,
      spindleCommands: false,
    })
  })

  it('does not implement the capability-gated optional members', () => {
    // Cast rather than type-annotate as MachineController: the class-level
    // mismatch documented above is orthogonal to this check (optional-member
    // absence is real regardless of it).
    const ctrl = new GrblController(makeEvents()) as unknown as MachineController
    expect(ctrl.loadMoves).toBeUndefined()
    expect(ctrl.homeAxes).toBeUndefined()
  })

  it('status() before any connection is honestly all-unknown', () => {
    const ctrl = new GrblController(makeEvents())
    const status = ctrl.status()
    expect(status.state).toBe('unknown')
    expect(status.machinePos).toBeNull()
    expect(status.workPos).toBeNull()
    expect(status.feedMmMin).toBeNull()
    expect(status.overrides).toBeNull()
    expect(status.executingMoveId).toBeNull()
    expect(status.buffer).toEqual({ moves: null, capacitySeconds: null })
    expect(status.inputs).toBeNull()
    expect(status.homed).toEqual({ X: false, Y: false, Z: false })
  })

  it('status() never invents executingMoveId or a buffer move/second count, even with live data', async () => {
    const { ctrl, ft } = await connect()
    // Bf: (planner blocks, RX bytes) and FS:/Ov: are all present - a naive
    // implementation could be tempted to repurpose Bf: as a move count.
    ft.feed('<Run|MPos:1.000,2.000,3.000|FS:500,8000|Ov:100,100,100|Bf:14,120|Pn:X>\n')
    const status = ctrl.status()
    expect(status.state).toBe('run')
    expect(status.machinePos).toEqual({ x: 1, y: 2, z: 3 })
    expect(status.feedMmMin).toBe(500)
    expect(status.spindleRpm).toBe(8000)
    expect(status.overrides).toEqual({ feed: 100, rapid: 100, spindle: 100 })
    // The must-not-invent fields, per WO-418, regardless of Bf: being present:
    expect(status.executingMoveId).toBeNull()
    expect(status.buffer).toEqual({ moves: null, capacitySeconds: null })
    // Pn:X is a real triggered pin - status() should surface it, not hide it.
    // Contract v4 (WO-426): GRBL has all six inputs the Control page renders,
    // so `limits`/`door`/`hold` are real booleans here, never null - null on
    // this controller would be a lie (see the SimulatedController contract
    // test for the genuine null case, a controller that lacks these inputs).
    expect(status.inputs).toEqual({
      hardLimit: true,
      softLimit: false,
      probe: false,
      estop: false,
      limits: { x: true, y: false, z: false },
      door: false,
      hold: false,
    })
  })

  it('status() reports no triggered inputs once a report with no Pn: arrives', async () => {
    const { ctrl, ft } = await connect()
    ft.feed('<Idle|MPos:0,0,0|FS:0,0>\n')
    expect(ctrl.status().inputs).toEqual({
      hardLimit: false,
      softLimit: false,
      probe: false,
      estop: false,
      limits: { x: false, y: false, z: false },
      door: false,
      hold: false,
    })
  })

  it('status() decodes per-axis limits, door and hold off Pn: - contract v4 (WO-426)', async () => {
    const { ctrl, ft } = await connect()
    ft.feed('<Run|MPos:0,0,0|FS:0,0|Pn:YZPDH>\n')
    expect(ctrl.status().inputs).toEqual({
      hardLimit: true,
      softLimit: false,
      probe: true,
      estop: true, // GRBL's only external panic input is the door pin (D).
      limits: { x: false, y: true, z: true },
      door: true,
      hold: true,
    })
  })

  // WO-422: setOverride is now the ONLY route from the UI and the pendant to
  // an override, so the mapping onto GRBL's realtime bytes is what actually
  // reaches the machine. Nothing tested it before this slice.
  it('setOverride writes the exact GRBL realtime bytes for every channel it has', async () => {
    const { ctrl, ft } = await connect()
    const bytesSince = (from: number) => ft.written.slice(from).map((b) => b[0])

    let mark = ft.written.length
    ctrl.setOverride({ kind: 'feed', to: 'reset' })
    ctrl.setOverride({ kind: 'feed', to: 'step', direction: 1, coarse: true })
    ctrl.setOverride({ kind: 'feed', to: 'step', direction: -1, coarse: false })
    expect(bytesSince(mark)).toEqual([
      REALTIME.feedOvrReset,
      REALTIME.feedOvrCoarsePlus,
      REALTIME.feedOvrFineMinus,
    ])

    mark = ft.written.length
    ctrl.setOverride({ kind: 'spindle', to: 'reset' })
    ctrl.setOverride({ kind: 'spindle', to: 'step', direction: -1, coarse: true })
    ctrl.setOverride({ kind: 'spindle', to: 'step', direction: 1, coarse: false })
    expect(bytesSince(mark)).toEqual([
      REALTIME.spindleOvrReset,
      REALTIME.spindleOvrCoarseMinus,
      REALTIME.spindleOvrFinePlus,
    ])

    // Rapid is ABSOLUTE on GRBL and has exactly three levels, so a percent
    // maps and a step does not.
    mark = ft.written.length
    ctrl.setOverride({ kind: 'rapid', to: 'percent', percent: 25 })
    ctrl.setOverride({ kind: 'rapid', to: 'percent', percent: 50 })
    ctrl.setOverride({ kind: 'rapid', to: 'percent', percent: 100 })
    expect(bytesSince(mark)).toEqual([
      REALTIME.rapidOvrQuarter,
      REALTIME.rapidOvrHalf,
      REALTIME.rapidOvrFull,
    ])
  })

  it('setOverride refuses, rather than approximates, what GRBL has no byte for', async () => {
    const { ctrl, ft } = await connect()
    const mark = ft.written.length
    // No absolute-percent byte for feed/spindle, no incremental rapid byte,
    // and no rapid level between the three GRBL defines.
    ctrl.setOverride({ kind: 'feed', to: 'percent', percent: 137 })
    ctrl.setOverride({ kind: 'spindle', to: 'percent', percent: 90 })
    ctrl.setOverride({ kind: 'rapid', to: 'percent', percent: 75 })
    ctrl.setOverride({ kind: 'rapid', to: 'step', direction: 1, coarse: true })
    expect(ft.written.slice(mark)).toEqual([])
  })

  // ---- WO-423: contract v3's event channels --------------------------------
  //
  // Before this slice these lived on GRBL alone and machineSession kept a typed
  // GrblController reference to reach them. They are the CONTRACT's now, so
  // these tests assert the contract's signatures, not GRBL's old ones.

  it('raises onReady with the banner version, through the contract', async () => {
    const { events } = await connect()
    expect(events.onReady).toHaveBeenCalledWith('1.1h')
    expect(events.onConnectionPhase).toHaveBeenCalledWith('connected', '1.1h')
  })

  it('keys a setting by string - "however that controller keys them"', async () => {
    const { ft, events } = await connect()
    ft.feed('$130=738.000\n')
    expect(events.onSetting).toHaveBeenCalledWith('130', '738.000')
  })

  it('reports a homing cycle with null axes: GRBL says the cycle finished, not which axes', async () => {
    const { ctrl, ft, events } = await connect()
    ctrl.sendCommand('$H')
    ft.feed('ok\n')
    expect(events.onHomed).toHaveBeenCalledWith(null)
  })

  it('a failed job carries a JobFault: a source LINE, never a move id', async () => {
    const { ctrl, ft, events } = await connect()
    ctrl.loadJob('G21\nG91.5\nG1 X5 F100')
    ctrl.startJob()
    ft.feed('ok\n')
    ft.feed('error:20\n')
    const failed = events.onJobEvent.mock.calls.find((c) => c[0] === 'failed')
    expect(failed).toBeDefined()
    expect(failed![1]).toEqual({
      code: 20,
      // The offending line joins the message: JobFault has no field for it and
      // "error 20 on line 2" alone is not something an operator can act on.
      message: expect.stringContaining('G91.5'),
      line: 2,
      // GRBL streams text and has no move ids at all - never invented.
      moveId: null,
    })
  })

  it('an alarm reaches the contract channel with its position-lost verdict', async () => {
    const { ft, events } = await connect()
    ft.feed('ALARM:1\n')
    expect(events.onAlarm).toHaveBeenCalledWith(1, expect.any(String), true)
  })

  it('raises onAccessories on a CHANGE, and not once per unchanged report', async () => {
    const { ft, events } = await connect()
    ft.feed('<Idle|MPos:0,0,0|FS:0,0|Ov:100,100,100|A:SF>\n')
    expect(events.onAccessories).toHaveBeenCalledWith({ spindle: 'cw', flood: true, mist: false })
    const after = events.onAccessories.mock.calls.length
    ft.feed('<Idle|MPos:0,0,0|FS:0,0|Ov:100,100,100|A:SF>\n')
    expect(events.onAccessories.mock.calls.length).toBe(after)
    ft.feed('<Idle|MPos:0,0,0|FS:0,0|Ov:100,100,100>\n')
    expect(events.onAccessories).toHaveBeenLastCalledWith({ spindle: 'off', flood: false, mist: false })
  })

  it('goes back to honestly unknown after disconnect', async () => {
    const { ctrl, ft } = await connect()
    ft.feed('<Run|MPos:1,2,3|FS:500,8000>\n')
    expect(ctrl.status().machinePos).not.toBeNull()
    await ctrl.disconnect()
    const status = ctrl.status()
    expect(status.state).toBe('unknown')
    expect(status.machinePos).toBeNull()
    expect(status.inputs).toBeNull()
  })
})
