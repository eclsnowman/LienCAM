// WO-434: SimulatedController's sendCommand/sendCommandAwait interpret ONE
// MDI-style line - the vocabulary real machineSession.ts call sites actually
// send (probing, work-offset writes, TLO, safe-Z/mesh-probe positioning
// moves, manual spindle/coolant). Before this slice sendCommand was a
// documented no-op that returned `true` for anything while connected - these
// tests pin the fix: recognised lines really move/write/probe, and anything
// outside the vocabulary is refused rather than acked.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SimulatedController, type SimulatedPart } from '../../lib/machine/simulatedController'
import type { ControllerEvents } from '../../lib/machine/controller'

type Spy = ReturnType<typeof vi.fn>

function makeEvents(): ControllerEvents & {
  onStatus: Spy
  onParserState: Spy
  onOffset: Spy
  onAccessories: Spy
  onAlarm: Spy
  onJobEvent: Spy
} {
  return {
    onStatus: vi.fn(),
    onParserState: vi.fn(),
    onOffset: vi.fn(),
    onConnectionPhase: vi.fn(),
    onConsole: vi.fn(),
    onClose: vi.fn(),
    onReady: vi.fn(),
    onJobEvent: vi.fn(),
    onJobProgress: vi.fn(),
    onHomed: vi.fn(),
    onAlarm: vi.fn(),
    onAccessories: vi.fn(),
    onSetting: vi.fn(),
  }
}

// Same near-corner-homing fixture simulatedController.wo420.test.ts uses:
// machine zero at 0, table 0..travel, rig starts 5mm inward on every axis.
const HOME_CONVENTION = {
  x: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  y: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  z: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
}

async function connected(part?: SimulatedPart | null) {
  const events = makeEvents()
  const ctrl = new SimulatedController(events, {
    travelMm: { x: 300, y: 300, z: 100 },
    homeConvention: HOME_CONVENTION,
    part: part ?? null,
  })
  await ctrl.connect({ kind: 'none' })
  return { ctrl, events }
}

// A flat block directly under the rig's starting XY (5, 5) so a downward Z
// probe from the starting position (z=5) contacts a real surface at topZ.
const PART: SimulatedPart = {
  origin: { x: 0, y: 0 },
  sizeX: 50,
  sizeY: 50,
  topZ: -10,
  height: 20,
  bowMm: 0,
  noiseMm: 0,
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SimulatedController MDI interpreter (WO-434)', () => {
  // ---- probing --------------------------------------------------------

  it('a simulated probe against the virtual part succeeds through sendCommandAwait and reports a contact position', async () => {
    const { ctrl, events } = await connected(PART)
    const pending = ctrl.sendCommandAwait('G21 G91 G38.2 Z-100 F600')
    expect(pending).not.toBeNull()
    await vi.advanceTimersByTimeAsync(4000) // 5 -> -10 is 15mm at 10mm/s
    const ack = await pending!
    expect(ack.ok).toBe(true)
    expect(ack.message).toBeNull()
    expect(ctrl.status().machinePos!.z).toBeCloseTo(-10, 2)
    // onOffset('PRB', ...) is the channel executeDirectionalProbeTouch reads
    // the contact position out of via store().probe.
    const prb = events.onOffset.mock.calls.map((c) => c[0]).find((e) => e.label === 'PRB')
    expect(prb).toBeDefined()
    expect(prb.probeSuccess).toBe(true)
    expect(prb.values[2]).toBeCloseTo(-10, 2)
  })

  it('a probe miss reports a miss through sendCommandAwait, with the machine alarmed - not a silent success', async () => {
    const { ctrl, events } = await connected() // no part: every X/Y probe misses
    const pending = ctrl.sendCommandAwait('G21 G91 G38.2 X245 F6000')
    await vi.advanceTimersByTimeAsync(3000)
    const ack = await pending!
    expect(ack.ok).toBe(false)
    expect(ack.message).toMatch(/without touching off/)
    expect(ctrl.machineState()).toBe('alarm')
    const prb = events.onOffset.mock.calls.map((c) => c[0]).find((e) => e.label === 'PRB')
    expect(prb).toBeDefined()
    expect(prb.probeSuccess).toBe(false)
  })

  it('sendCommand refuses (rather than accepting) a G38.2 line with no feed rate', async () => {
    const { ctrl } = await connected()
    expect(ctrl.sendCommand('G91 G38.2 Z-10')).toBe(false)
  })

  // ---- work-offset writes / TLO ---------------------------------------

  it('G10 L2 writes a WCS register directly and raises onOffset for that row', async () => {
    const { ctrl, events } = await connected()
    expect(ctrl.sendCommand('G10 L2 P1 X12.5 Y-3')).toBe(true)
    const g54 = events.onOffset.mock.calls.map((c) => c[0]).find((e) => e.label === 'G54')
    expect(g54).toBeDefined()
    expect(g54.values).toEqual([12.5, -3, 0])
  })

  it('G10 L20 P0 zeros the active WCS through the current position, raising onOffset', async () => {
    const { ctrl, events } = await connected()
    const cur = ctrl.status().machinePos!
    expect(ctrl.sendCommand('G10 L20 P0 X0 Y0 Z0')).toBe(true)
    const g54 = events.onOffset.mock.calls.map((c) => c[0]).find((e) => e.label === 'G54')
    expect(g54!.values).toEqual([cur.x, cur.y, cur.z])
    expect(ctrl.status().workPos).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('G10 with no L word is refused, not silently accepted', async () => {
    const { ctrl } = await connected()
    expect(ctrl.sendCommand('G10 P1 X0')).toBe(false)
  })

  it('G43.1 sets a real TLO that shifts reported work Z, and raises onOffset(TLO); G49 clears it', async () => {
    const { ctrl, events } = await connected()
    const workZBefore = ctrl.status().workPos!.z
    expect(ctrl.sendCommand('G43.1 Z5')).toBe(true)
    expect(ctrl.status().workPos!.z).toBeCloseTo(workZBefore - 5, 4)
    let tlo = events.onOffset.mock.calls.map((c) => c[0]).find((e) => e.label === 'TLO')
    expect(tlo!.values).toEqual([5])

    expect(ctrl.sendCommand('G49')).toBe(true)
    expect(ctrl.status().workPos!.z).toBeCloseTo(workZBefore, 4)
    tlo = events.onOffset.mock.calls.map((c) => c[0]).find((e) => e.label === 'TLO' && e.values[0] === 0)
    expect(tlo).toBeDefined()
  })

  it('G43.1 with no Z word is refused', async () => {
    const { ctrl } = await connected()
    expect(ctrl.sendCommand('G43.1')).toBe(false)
  })

  // ---- refreshState() answers the same rows $# did ---------------------

  it('refreshState() raises onOffset for every WCS row, TLO and PRB', async () => {
    const { ctrl, events } = await connected()
    events.onOffset.mockClear()
    expect(ctrl.refreshState()).toBe(true)
    const labels = events.onOffset.mock.calls.map((c) => c[0].label)
    expect(labels).toEqual(expect.arrayContaining(['G54', 'G55', 'G56', 'G57', 'G58', 'G59', 'TLO', 'PRB']))
  })

  // ---- safe-Z park / mesh-probe positioning moves -----------------------

  it('a G53 rapid move through sendCommand really moves the machine to the machine-frame target', async () => {
    const { ctrl } = await connected()
    expect(ctrl.sendCommand('G21 G90 G53 G0 X0 Y0 Z50')).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    expect(ctrl.status().machinePos).toEqual({ x: 0, y: 0, z: 50 })
  })

  it('a G53 feed move through sendCommand really moves the machine, ignoring WCS and TLO', async () => {
    const { ctrl } = await connected()
    ctrl.sendCommand('G10 L2 P1 X100 Y100') // active WCS now offset - G53 must ignore it
    expect(ctrl.sendCommand('G21 G90 G53 G1 X20 Y20 F600')).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(ctrl.status().machinePos!.x).toBeCloseTo(20, 2)
    expect(ctrl.status().machinePos!.y).toBeCloseTo(20, 2)
  })

  it('a G53 feed move with no feed rate is refused rather than silently accepted', async () => {
    const { ctrl } = await connected()
    const before = ctrl.status().machinePos!
    expect(ctrl.sendCommand('G21 G90 G53 G1 X20 Y20')).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(ctrl.status().machinePos).toEqual(before)
  })

  it('a G53 move outside the declared travel is refused and the machine does not move - never a silent lie', async () => {
    const { ctrl } = await connected()
    const before = ctrl.status().machinePos!
    expect(ctrl.sendCommand('G21 G90 G53 G0 X99999 Y0 Z0')).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(ctrl.status().machinePos).toEqual(before)
  })

  it('a bare G0 (no G53) moves in the active WCS frame', async () => {
    const { ctrl } = await connected()
    ctrl.sendCommand('G10 L2 P1 X5 Y5')
    expect(ctrl.sendCommand('G21 G90 G0 X10 Y10')).toBe(true)
    await vi.advanceTimersByTimeAsync(2000)
    // Work X10 Y10 in a WCS offset by (5,5) = machine (15,15).
    expect(ctrl.status().machinePos!.x).toBeCloseTo(15, 2)
    expect(ctrl.status().machinePos!.y).toBeCloseTo(15, 2)
  })

  // ---- manual MDI spindle/coolant ---------------------------------------

  it('M3/M4/M5 drive the spindle immediately through sendCommand, not only inside a loaded program', async () => {
    const { ctrl, events } = await connected()
    expect(ctrl.sendCommand('M4 S8000')).toBe(true)
    expect(ctrl.status().spindleRpm).toBe(8000)
    expect(events.onAccessories).toHaveBeenCalledWith({ spindle: 'ccw', flood: false, mist: false })
    expect(ctrl.sendCommand('M5')).toBe(true)
    expect(ctrl.status().spindleRpm).toBe(0)
    expect(events.onAccessories).toHaveBeenCalledWith({ spindle: 'off', flood: false, mist: false })
  })

  it('M7/M8/M9 drive coolant immediately through sendCommand', async () => {
    const { ctrl, events } = await connected()
    expect(ctrl.sendCommand('M8')).toBe(true)
    expect(events.onAccessories).toHaveBeenCalledWith({ spindle: 'off', flood: true, mist: false })
    expect(ctrl.sendCommand('M9')).toBe(true)
    expect(events.onAccessories).toHaveBeenCalledWith({ spindle: 'off', flood: false, mist: false })
  })

  // ---- WCS select ---------------------------------------------------------

  it('a bare G54..G59 line selects the WCS', async () => {
    const { ctrl } = await connected()
    expect(ctrl.sendCommand('G55')).toBe(true)
    ctrl.sendCommand('G10 L2 P2 X7')
    expect(ctrl.status().workPos!.x).toBeCloseTo(ctrl.status().machinePos!.x - 7, 4)
  })

  // ---- refusals: outside the vocabulary --------------------------------

  it('a line outside the MDI vocabulary (an arc) is refused, not acked, and the machine does not move', async () => {
    const { ctrl } = await connected()
    const before = ctrl.status().machinePos!
    expect(ctrl.sendCommand('G2 X10 Y10 I5 J5 F300')).toBe(false)
    const pending = ctrl.sendCommandAwait('G2 X10 Y10 I5 J5 F300')
    expect(pending).not.toBeNull()
    const ack = await pending!
    expect(ack.ok).toBe(false)
    await vi.advanceTimersByTimeAsync(500)
    expect(ctrl.status().machinePos).toEqual(before)
  })

  it('an unsupported M-code is refused, not acked', async () => {
    const { ctrl } = await connected()
    expect(ctrl.sendCommand('M6 T2')).toBe(false)
  })

  it('sendCommand and sendCommandAwait both refuse while disconnected', async () => {
    const events = makeEvents()
    const ctrl = new SimulatedController(events, { travelMm: { x: 300, y: 300, z: 100 }, homeConvention: HOME_CONVENTION })
    expect(ctrl.sendCommand('G90')).toBe(false)
    expect(ctrl.sendCommandAwait('G90')).toBeNull()
  })

  // ---- modal-only lines still ack, matching a loaded program's preamble --

  it("G90/G20/G91/G21 alone (modal restore, as the probe cycle's finally-block sends) ack and update parserState", async () => {
    const { ctrl, events } = await connected()
    expect(ctrl.sendCommand('G91')).toBe(true)
    expect(ctrl.sendCommand('G20')).toBe(true)
    ctrl.refreshState()
    const state = events.onParserState.mock.calls.at(-1)![0] as { units: string; distanceMode: string }
    expect(state.units).toBe('inch')
    expect(state.distanceMode).toBe('incremental')
    expect(ctrl.sendCommand('G90')).toBe(true)
    expect(ctrl.sendCommand('G21')).toBe(true)
    ctrl.refreshState()
    const restored = events.onParserState.mock.calls.at(-1)![0] as { units: string; distanceMode: string }
    expect(restored.units).toBe('mm')
    expect(restored.distanceMode).toBe('absolute')
  })
})
