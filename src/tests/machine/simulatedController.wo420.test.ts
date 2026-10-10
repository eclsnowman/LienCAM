// WO-420: SimulatedController implements MachineController natively - no
// GRBL wire protocol underneath. These tests exercise the ported motion
// model directly against the interface, not against a byte pipe.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulatedController } from '../../lib/machine/simulatedController'
import type { ControllerEvents, MachineStatus } from '../../lib/machine/controller'
import { UCCNC_CONFIG } from '../../lib/post/dialects/uccnc'

type Spy = ReturnType<typeof vi.fn>

function makeEvents(): ControllerEvents & {
  onStatus: Spy
  onParserState: Spy
  onReady: Spy
  onJobEvent: Spy
  onJobProgress: Spy
  onHomed: Spy
  onAlarm: Spy
  onAccessories: Spy
  onSetting: Spy
} {
  return {
    onStatus: vi.fn(),
    onParserState: vi.fn(),
    onSetting: vi.fn(),
    onConnectionPhase: vi.fn(),
    onConsole: vi.fn(),
    onClose: vi.fn(),
    // WO-423 / contract v3.
    onReady: vi.fn(),
    onJobEvent: vi.fn(),
    onJobProgress: vi.fn(),
    onHomed: vi.fn(),
    onAlarm: vi.fn(),
    onAccessories: vi.fn(),
  }
}

// Near-corner homing on all three axes: machine zero at 0, table entirely
// 0..travel. Initial (unhomed) position sits 5mm inward from home on every
// axis - the same fixture simulatedTransport.ts used before this slice.
const HOME_CONVENTION = {
  x: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  y: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  z: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
}

async function connected() {
  const events = makeEvents()
  const ctrl = new SimulatedController(events, {
    dialect: UCCNC_CONFIG,
    travelMm: { x: 300, y: 300, z: 100 },
    homeConvention: HOME_CONVENTION,
  })
  await ctrl.connect({ kind: 'none' })
  return { ctrl, events }
}

function lastStatus(events: ReturnType<typeof makeEvents>): MachineStatus {
  return events.onStatus.mock.calls.at(-1)![0] as MachineStatus
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SimulatedController', () => {
  it('declares the geometry-queue, id-tracking capabilities a software controller can honestly claim', async () => {
    const { ctrl } = await connected()
    expect(ctrl.capabilities).toEqual({
      geometryQueue: true,
      executingMoveId: true,
      bufferSeconds: false,
      // WO-428: this class now carries its own interpreter, so it can honestly
      // claim BOTH backend shapes ADR-0041 exists to distinguish.
      gcodeText: true,
      perAxisHoming: true,
      ownsSpindle: true,
      spindleCommands: false,
      machineProgram: true,
    })
  })

  // WO-426, contract v4: the simulator has no per-axis limit switches, no
  // door input and no separate hold pin - `null`, not `false`, because "no
  // such input" and "input present but clear" are different facts a lamp
  // must be able to show differently. `probe` and `estop` ARE real inputs the
  // simulator has, so they stay booleans - the contrast inside one assertion
  // is the required proof that null renders differently from false.
  it('reports limits/door/hold as null (no such input), not false, unlike probe/estop', async () => {
    const { ctrl } = await connected()
    const inputs = ctrl.status().inputs
    expect(inputs).not.toBeNull()
    expect(inputs!.limits).toBeNull()
    expect(inputs!.door).toBeNull()
    expect(inputs!.hold).toBeNull()
    expect(typeof inputs!.probe).toBe('boolean')
    expect(typeof inputs!.estop).toBe('boolean')
    expect(typeof inputs!.hardLimit).toBe('boolean')
    expect(typeof inputs!.softLimit).toBe('boolean')
  })

  it('a jog moves the reported position over real time', async () => {
    const { ctrl } = await connected()
    const before = ctrl.status().machinePos!.x
    expect(ctrl.jog('X', 10, 6000)).toBe(true) // 6000 mm/min = 100 mm/s -> 10mm in 100ms
    await vi.advanceTimersByTimeAsync(200)
    expect(ctrl.status().machinePos!.x).toBeCloseTo(before + 10, 2)
    expect(ctrl.machineState()).toBe('idle')
  })

  it('refuses a jog that would cross the travel envelope, and does not move', async () => {
    const { ctrl } = await connected()
    const before = ctrl.status().machinePos!
    expect(ctrl.jog('X', -1000, 6000)).toBe(false)
    await vi.advanceTimersByTimeAsync(200)
    expect(ctrl.status().machinePos).toEqual(before)
  })

  it('homing sets homed per axis and parks at the declared home position', async () => {
    const { ctrl } = await connected()
    expect(ctrl.homedThisSession()).toBe(false)
    expect(ctrl.home()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ctrl.homedThisSession()).toBe(true)
    const status = ctrl.status()
    expect(status.machinePos).toEqual({ x: 0, y: 0, z: 0 })
    expect(status.homed).toEqual({ X: true, Y: true, Z: true })
  })

  it('a queued move sequence advances executingMoveId in order, then clears it', async () => {
    const { ctrl, events } = await connected()
    ctrl.loadMoves([
      { id: 101, kind: 'line', to: { x: 20 }, feedMmMin: 6000 },
      { id: 102, kind: 'line', to: { y: 20 }, feedMmMin: 6000 },
      { id: 103, kind: 'marker' },
    ])
    expect(ctrl.startJob()).toBe(true)

    // Ticks land every 50ms. The rig starts 5mm inward on every axis (see
    // HOME_CONVENTION), so move 1 (X 5 -> 20, 15mm @ 100mm/s) takes 150ms -
    // at t=60ms it is still in flight.
    await vi.advanceTimersByTimeAsync(60)
    ctrl.queryStatus()
    expect(lastStatus(events).executingMoveId).toBe(101)

    // t=250ms: move 1 finished at t=150ms, move 2 (Y 5 -> 20, also 150ms) is
    // in flight (it started at t=150ms, so it is not done until t=300ms).
    await vi.advanceTimersByTimeAsync(190)
    ctrl.queryStatus()
    expect(lastStatus(events).executingMoveId).toBe(102)

    // t=450ms: move 2 finished at t=300ms, the marker was consumed right
    // after with no further motion, and the queue is empty.
    await vi.advanceTimersByTimeAsync(200)
    ctrl.queryStatus()
    expect(lastStatus(events).executingMoveId).toBeNull()
    expect(ctrl.hasActiveJob()).toBe(false)
    // Contract v2's StreamerProgress: a software controller sends and acks a
    // move in the same instant, and its "source line" is the id WE minted.
    expect(ctrl.jobProgress()).toEqual({
      phase: 'complete',
      totalLines: 3,
      sentLines: 3,
      ackedLines: 3,
      ackedSourceLine: 103,
      sentSourceLine: 103,
      bytesInFlight: 0,
    })
  })

  it('probe reports a touch at the contact point', async () => {
    const events = makeEvents()
    // homesToward 'max' so the machine-frame range is negative and reaches
    // down past the probe pad at Z=-40.
    const ctrl = new SimulatedController(events, {
      travelMm: { x: 300, y: 300, z: 200 },
      homeConvention: {
        x: HOME_CONVENTION.x,
        y: HOME_CONVENTION.y,
        z: { homesToward: 'max', machineZeroAt: 'max' },
      },
    })
    await ctrl.connect({ kind: 'none' })
    const touch = ctrl.probe('Z', -100, 600) // 600 mm/min = 10 mm/s
    await vi.advanceTimersByTimeAsync(4000) // -5 -> -40 pad is 35mm at 10mm/s
    const result = await touch
    expect(result.ok).toBe(true)
    expect(result.at).not.toBeNull()
    expect(result.at!.z).toBeCloseTo(-40, 1)
  })

  it('a probe that never reaches a surface reports a miss', async () => {
    const { ctrl } = await connected()
    const touch = ctrl.probe('X', 250, 6000) // travels +X only, never crosses the Z pad
    await vi.advanceTimersByTimeAsync(3000) // 245mm at 100mm/s = 2.45s to reach the (missed) target
    const result = await touch
    expect(result.ok).toBe(false)
    expect(result.at).toBeNull()
  })

  it('status() reports buffer.capacitySeconds as null because bufferSeconds is not a capability', async () => {
    const { ctrl } = await connected()
    expect(ctrl.status().buffer!.capacitySeconds).toBeNull()
  })

  // ---- WO-423: contract v3's event channels ------------------------------
  //
  // "A backend that cannot raise one simply never calls it." These tests pin
  // both halves: what this controller really knows, and what it must NOT
  // invent.

  it('WO-428: refuses a word this dialect does not emit with a REASON, not a silent skip', async () => {
    const { ctrl, events } = await connected()
    const outcome = ctrl.loadJob('G43.1 Z10\n')
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.reason).toMatch(/Line 1.*G43\.1/)
    // The console line WO-422 needed as a stand-in for the old capability
    // refusal is gone: the outcome says it.
    expect(events.onConsole).not.toHaveBeenCalled()
  })

  it('raises onReady when the software controller comes up', async () => {
    const { events } = await connected()
    expect(events.onReady).toHaveBeenCalledWith('LienCAM Simulated Controller')
  })

  it('reports the job lifecycle it really has: started, then completed', async () => {
    const { ctrl, events } = await connected()
    ctrl.loadMoves!([{ id: 7, kind: 'line', to: { x: 10 }, feedMmMin: 6000 }])
    expect(ctrl.startJob()).toBe(true)
    expect(events.onJobEvent).toHaveBeenCalledWith('started', null)
    await vi.advanceTimersByTimeAsync(500)
    expect(events.onJobEvent).toHaveBeenCalledWith('completed', null)
    expect(events.onJobProgress).toHaveBeenCalled()
  })

  it('names the MOVE, not a line, when a run is abandoned', async () => {
    const { ctrl, events } = await connected()
    ctrl.loadMoves!([{ id: 42, kind: 'line', to: { x: 200 }, feedMmMin: 600 }])
    ctrl.startJob()
    await vi.advanceTimersByTimeAsync(200)
    ctrl.emergencyStop()
    const failed = events.onJobEvent.mock.calls.find((c) => c[0] === 'failed')
    expect(failed).toBeDefined()
    expect(failed![1]).toEqual({
      code: null, // software controller: no firmware alarm numbers
      message: expect.any(String),
      line: null, // it queues geometry, so there is no line of text
      moveId: 42,
    })
    expect(events.onAlarm).toHaveBeenCalledWith(null, expect.any(String), false)
  })

  it('says WHICH axes homed - unlike GRBL, this controller knows', async () => {
    const { ctrl, events } = await connected()
    expect(ctrl.homeAxes!(['Z', 'X'])).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(events.onHomed).toHaveBeenCalledWith(['Z', 'X'])
  })

  // WO-434 superseded this: sendCommand now interprets M3/M4/M5/M7/M8/M9 as
  // real, immediate manual actions (machineSession's MDI spindle/coolant
  // buttons send exactly this way) rather than staying inert. See
  // simulatedControllerMdi.wo434.test.ts for the full MDI interpreter suite.
  it('M3 through sendCommand drives the spindle immediately - MDI spindle is not a program-only effect (WO-434)', async () => {
    const { ctrl, events } = await connected()
    expect(ctrl.sendCommand('M3 S12000')).toBe(true)
    expect(ctrl.status().spindleRpm).toBe(12000)
    expect(events.onAccessories).toHaveBeenCalledWith({ spindle: 'cw', flood: false, mist: false })
  })

  it('a feed hold with nothing loaded is a hold, not a program pause', async () => {
    const { ctrl, events } = await connected()
    ctrl.jog('X', 20, 600)
    ctrl.pauseJob()
    expect(events.onJobEvent).not.toHaveBeenCalled()
  })

  // ---- WO-428: the text path ----------------------------------------------

  it('runs a posted program through the text path to the same end position a hand-authored line would reach', async () => {
    const { ctrl } = await connected()
    const before = ctrl.status().machinePos!
    const outcome = ctrl.loadJob('G90 G21\nG54\nG0 X20 Y20\n')
    expect(outcome.ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    const pos = ctrl.status().machinePos!
    expect(pos.x).toBeCloseTo(before.x + 15, 2) // rig starts 5mm inward (HOME_CONVENTION)
    expect(pos.y).toBeCloseTo(before.y + 15, 2)
    expect(ctrl.jobProgress().phase).toBe('complete')
  })

  it('M3/M4/M5 drive the spindle for real through the text path, and raise onAccessories', async () => {
    const { ctrl, events } = await connected()
    // Every marker (M3, then the G4 dwell, then M5) advances one tick (50ms)
    // at a time - ticks are not free-running, so each assertion needs enough
    // real time for the ticks up to that line to have actually run.
    ctrl.loadJob('M3 S12000\nG4 P10\nM5\n')
    ctrl.startJob()
    await vi.advanceTimersByTimeAsync(60) // one tick: M3 applied
    expect(ctrl.status().spindleRpm).toBe(12000)
    expect(events.onAccessories).toHaveBeenCalledWith({ spindle: 'cw', flood: false, mist: false })
    await vi.advanceTimersByTimeAsync(150) // dwell tick, then M5's tick
    expect(ctrl.status().spindleRpm).toBe(0)
    expect(events.onAccessories).toHaveBeenCalledWith({ spindle: 'off', flood: false, mist: false })
  })

  it('M4 is CCW, M8 is flood coolant - reflected in parserState, not defaulted to M3/off', async () => {
    const { ctrl, events } = await connected()
    ctrl.loadJob('M4 S3000\nM8\n')
    ctrl.startJob()
    await vi.advanceTimersByTimeAsync(150) // both markers' ticks have run
    ctrl.refreshState()
    const state = events.onParserState.mock.calls.at(-1)![0] as { spindle: string; coolant: string }
    expect(state.spindle).toBe('ccw')
    expect(state.coolant).toBe('flood')
  })

  it('M0 holds the program mid-run; cycleResume continues it', async () => {
    const { ctrl, events } = await connected()
    ctrl.loadJob('G0 X10\nM0\nG0 X20\n')
    ctrl.startJob()
    await vi.advanceTimersByTimeAsync(300)
    expect(ctrl.machineState()).toBe('hold')
    expect(ctrl.jobProgress().phase).toBe('paused') // program still active, held
    expect(ctrl.cycleResume()).toBe(true)
    await vi.advanceTimersByTimeAsync(300)
    expect(events.onJobEvent).toHaveBeenCalledWith('completed', null)
  })

  it('G28 rapids to the machine reference position', async () => {
    const { ctrl } = await connected()
    ctrl.loadJob('G28\n')
    ctrl.startJob()
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctrl.status().machinePos).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('a program that would leave the declared travel is refused whole, with an alarm - never starts moving', async () => {
    const { ctrl, events } = await connected()
    const before = ctrl.status().machinePos!
    expect(ctrl.loadMoves!([{ id: 1, kind: 'line', to: { x: 5000 }, feedMmMin: 6000 }]).ok).toBe(true)
    expect(ctrl.startJob()).toBe(false)
    expect(ctrl.machineState()).toBe('alarm')
    expect(events.onAlarm).toHaveBeenCalledWith(null, expect.any(String), false)
    expect(ctrl.status().machinePos).toEqual(before)
  })

  it('querySettings answers the travel numbers the envelope derivation reads, from the profile it was built with', async () => {
    const events = makeEvents()
    const ctrl = new SimulatedController(events, {
      travelMm: { x: 300, y: 250, z: 100 },
      homeConvention: HOME_CONVENTION,
    })
    await ctrl.connect({ kind: 'none' })
    expect(ctrl.querySettings()).toBe(true)
    expect(events.onSetting).toHaveBeenCalledWith('130', '300.000')
    expect(events.onSetting).toHaveBeenCalledWith('131', '250.000')
    expect(events.onSetting).toHaveBeenCalledWith('132', '100.000')
  })
})

// WO-1650: THE SIMULATOR ACCEPTS AND REPORTS THE WORDS THE MACHINE'S OUTPUT
// LIST DEFINES - a pump on M10 and air on M11 - exactly as the reader and the
// post treat them. Without the list, M10 keeps the word table's refusal.
describe('SimulatedController - WO-1650 listed output words', () => {
  const PUMP_AND_AIR = [
    { name: 'coolant pump', onCode: 'M10', offCode: null },
    { name: 'air', onCode: 'M11', offCode: 'M12' },
  ]

  async function withOutputs(outputs: typeof PUMP_AND_AIR | null) {
    const events = makeEvents()
    const ctrl = new SimulatedController(events, {
      dialect: UCCNC_CONFIG,
      travelMm: { x: 300, y: 300, z: 100 },
      homeConvention: HOME_CONVENTION,
      outputs,
    })
    await ctrl.connect({ kind: 'none' })
    return { ctrl, events }
  }

  const consoleTexts = (events: ReturnType<typeof makeEvents>): string[] =>
    (events.onConsole as Spy).mock.calls.map((call) => (call[0] as { text: string }).text)

  it('typed M10 / M11 / M12 / M9 switch and report the listed outputs', async () => {
    const { ctrl, events } = await withOutputs(PUMP_AND_AIR)
    expect(ctrl.sendCommand('M10')).toBe(true)
    expect(ctrl.sendCommand('M11')).toBe(true)
    expect(ctrl.listedOutputsOnWords()).toEqual(['M10', 'M11'])
    expect(consoleTexts(events)).toContain('M10 coolant pump on (simulated).')
    expect(ctrl.sendCommand('M12')).toBe(true)
    expect(ctrl.listedOutputsOnWords()).toEqual(['M10'])
    expect(ctrl.sendCommand('M9')).toBe(true)
    expect(ctrl.listedOutputsOnWords()).toEqual([])
  })

  it('a loaded program with M10 / M11 / M9 runs and switches them at their lines', async () => {
    const { ctrl } = await withOutputs(PUMP_AND_AIR)
    const outcome = ctrl.loadJob('G90 G21\nG54\nM10\nG0 X20 Y20\nM11\nG4 P10\n')
    expect(outcome.ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ctrl.jobProgress().phase).toBe('complete')
    expect(ctrl.listedOutputsOnWords()).toEqual(['M10', 'M11'])
    expect(ctrl.loadJob('M9\nG4 P10\n').ok).toBe(true)
    expect(ctrl.startJob()).toBe(true)
    await vi.advanceTimersByTimeAsync(1000)
    expect(ctrl.listedOutputsOnWords()).toEqual([])
  })

  it('control: a machine that lists no pump refuses M10 with the table sentence', async () => {
    const { ctrl } = await withOutputs(null)
    expect(ctrl.sendCommand('M10')).toBe(false)
    expect(ctrl.listedOutputsOnWords()).toEqual([])
    const load = ctrl.loadJob('G90 G21\nM10\nG0 X20\n')
    expect(load.ok).toBe(false)
    if (!load.ok) expect(load.reason).toMatch(/M10 is not in the UCCNC G-code word table/)
  })
})
