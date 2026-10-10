// WO-428: the parity test. Operator's real controller (the AXBB-E) takes
// geometry and no text; a GRBL machine takes text and no geometry. This test
// is the only evidence we will have - before hardware exists - that
// SimulatedController's new text-path interpreter (loadJob, which parses
// LienCAM's posted UCCNC-dialect text into a QueuedMove[]) resolves a program
// the SAME way the geometry path (loadMoves, fed a hand-authored QueuedMove[]
// describing the identical toolpath) does: same end position, same move
// count. If loadJob's arithmetic ever drifts from loadMoves' contract, this
// is what catches it.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { vi } from 'vitest'
import { SimulatedController } from '../../lib/machine/simulatedController'
import type { ControllerEvents, MachineStatus, QueuedMove } from '../../lib/machine/controller'

// Near-corner homing on all three axes (machine zero at 0, table 0..travel) -
// the same fixture simulatedController.wo420.test.ts uses, so both
// controllers in this test start from the identical, known position.
const HOME_CONVENTION = {
  x: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  y: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  z: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
}

function makeEvents(): ControllerEvents {
  return {
    onStatus: vi.fn(),
    onParserState: vi.fn(),
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

async function connected(): Promise<SimulatedController> {
  const ctrl = new SimulatedController(makeEvents(), {
    travelMm: { x: 300, y: 300, z: 100 },
    homeConvention: HOME_CONVENTION,
  })
  await ctrl.connect({ kind: 'none' })
  return ctrl
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('SimulatedController text path vs geometry path (WO-428 parity)', () => {
  it('the same posted program produces the same end position and the same move count as an equivalent QueuedMove stream', async () => {
    // Six motion lines, every one carrying an explicit motion word (no modal
    // carry-over relied on), so the sendable-line count and the QueuedMove
    // count are directly comparable - both "six moves".
    // The fixture's near-corner homing (HOME_CONVENTION) puts the whole Z
    // travel at 0..100 - unlike a real cutting job, every Z here stays
    // positive so the pre-flight envelope check (WO-428) does not itself
    // refuse the program before parity is even exercised.
    const programText = [
      'G0 X10 Y10 Z5',
      'G1 Z1 F300',
      'G1 X50 Y10 F600',
      'G2 X50 Y50 I0 J20 F300',
      'G1 X10 Y50',
      'G0 Z5',
    ].join('\n')

    // The equivalent QueuedMove stream a geometry-only caller (the real AXBB
    // path) would hand to loadMoves for the SAME toolpath, in absolute
    // machine coordinates - matching exactly what the text parser resolves
    // each line to (G54's WCO is zero in a fresh simulator, so work == machine
    // here).
    const geometryMoves: QueuedMove[] = [
      { id: 1, kind: 'line', to: { x: 10, y: 10, z: 5 }, feedMmMin: 4000 }, // G0: rapid rate
      { id: 2, kind: 'line', to: { x: 10, y: 10, z: 1 }, feedMmMin: 300 },
      { id: 3, kind: 'line', to: { x: 50, y: 10, z: 1 }, feedMmMin: 600 },
      {
        id: 4,
        kind: 'arc',
        to: { x: 50, y: 50, z: 1 },
        centre: { x: 50, y: 30, z: 1 },
        clockwise: true,
        plane: 'xy',
        feedMmMin: 300,
      },
      { id: 5, kind: 'line', to: { x: 10, y: 50, z: 1 }, feedMmMin: 300 },
      { id: 6, kind: 'line', to: { x: 10, y: 50, z: 5 }, feedMmMin: 4000 },
    ]

    const textCtrl = await connected()
    const geomCtrl = await connected()

    const outcome = textCtrl.loadJob(programText)
    expect(outcome.ok).toBe(true)
    const loadResult = geomCtrl.loadMoves!(geometryMoves)
    expect(loadResult.ok).toBe(true)

    expect(textCtrl.startJob()).toBe(true)
    expect(geomCtrl.startJob()).toBe(true)

    // Advance generously - parity is about where each ends up, not how long
    // each backend's own feed/rapid-rate choice takes to get there.
    await vi.advanceTimersByTimeAsync(60_000)

    expect(textCtrl.jobProgress().phase).toBe('complete')
    expect(geomCtrl.jobProgress().phase).toBe('complete')

    // Same move count: six sendable lines through the text path, six
    // QueuedMoves through the geometry path.
    expect(textCtrl.jobProgress().totalLines).toBe(6)
    expect(geomCtrl.jobProgress().totalLines).toBe(6)

    // Same end position.
    const textPos = textCtrl.status().machinePos as MachineStatus['machinePos']
    const geomPos = geomCtrl.status().machinePos as MachineStatus['machinePos']
    expect(textPos).not.toBeNull()
    expect(geomPos).not.toBeNull()
    expect(textPos!.x).toBeCloseTo(geomPos!.x, 6)
    expect(textPos!.y).toBeCloseTo(geomPos!.y, 6)
    expect(textPos!.z).toBeCloseTo(geomPos!.z, 6)
    expect(textPos).toEqual({ x: 10, y: 50, z: 5 })
  })

  it('a G91 incremental run through the text path lands on the same absolute position as the equivalent absolute QueuedMove stream', async () => {
    const programText = ['G90 G0 X10 Y10', 'G91', 'G1 X20 F600', 'G1 Y15', 'G90'].join('\n')

    // Absolute equivalent: from (10,10), +20 in X -> (30,10), then +15 in Y
    // -> (30,25).
    const geometryMoves: QueuedMove[] = [
      { id: 1, kind: 'line', to: { x: 10, y: 10 }, feedMmMin: 4000 },
      { id: 2, kind: 'line', to: { x: 30, y: 10 }, feedMmMin: 600 },
      { id: 3, kind: 'line', to: { x: 30, y: 25 }, feedMmMin: 600 },
    ]

    const textCtrl = await connected()
    const geomCtrl = await connected()

    expect(textCtrl.loadJob(programText).ok).toBe(true)
    expect(geomCtrl.loadMoves!(geometryMoves).ok).toBe(true)
    expect(textCtrl.startJob()).toBe(true)
    expect(geomCtrl.startJob()).toBe(true)

    await vi.advanceTimersByTimeAsync(60_000)

    expect(textCtrl.jobProgress().phase).toBe('complete')
    expect(geomCtrl.jobProgress().phase).toBe('complete')

    const textPos = textCtrl.status().machinePos!
    const geomPos = geomCtrl.status().machinePos!
    expect(textPos.x).toBeCloseTo(geomPos.x, 6)
    expect(textPos.y).toBeCloseTo(geomPos.y, 6)
    expect(textPos).toEqual({ x: 30, y: 25, z: geomPos.z })
  })
})
