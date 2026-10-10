// WO-1337: THE FIRST HELICAL ARC THIS PRODUCT WILL EVER SEND.
//
// `buildMachineProgram.ts` refused a helical arc product-wide, by name, with an
// honest reason: none had ever flown on this hardware. The wire never lacked
// the field - the bridge submits an arc as
// `UC100.AddCircularMoveP(X, Y, Z, CX, CY, CZ, !clockwise, feed, plane, id,
// nextId)` (`Machine.cs`), an endpoint Z and a centre Z, and the builder simply
// forced the endpoint Z equal to the start's. This order stops forcing it.
//
// Operator's `fusion-liencnc-v2-operator.nc` is a helical ramp entry: thousands of
// short `G3` arcs, each with an I/J centre and a Z step of about 0.1 mm. It is
// the ordinary output of a Fusion UCCNC post and it is what he has asked to run.
//
// WHAT THESE TESTS ARE, AND WHAT THEY ARE NOT. They are Tier 2 desk evidence:
// the staged wire frame, the swept geometry, the travel check and the
// simulator's own integrator. NO HELIX HAS FLOWN ON THE REAL BOARD. The board
// confirmation this order names is an air-run fixture with the swept angle and
// the Z ramp read off the frames, and nothing here is a substitute for it -
// roundness cannot catch a direction error, and a helix flown the long way
// round is still a helix. So the direction checks below are written as
// direction checks, not as roundness checks.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import type { ToolpathMove, WCS } from '../../types'
import type {
  BridgeCallMessage,
  BridgeMessage,
  BridgeTransportEvents,
} from '../../lib/machine/bridgeTransport'
import type {
  ControllerCapabilities,
  ControllerEvents,
  MachineProgram,
  QueuedMove,
} from '../../lib/machine/controller'
import type { MachineEnvelope } from '../../lib/machine/machineEnvelope'
import {
  arcSweptBounds,
  buildStraightLineProgram,
  firstStepOutsideTravel,
  programSweptBounds,
} from '../../lib/program/buildMachineProgram'
import { assessProgramCapacity } from '../../lib/program/programCapacity'
import { readGcodeProgram, type GcodeReaderOptions } from '../../lib/gcode/reader'
import { interpretGcodeProgram, type GcodeInterpretOptions } from '../../lib/gcode/interpret'
import { SimulatedController } from '../../lib/machine/simulatedController'
import {
  SUPPORTED_BRIDGE_PROTOCOL,
  UccncController,
  type UccncTransport,
} from '../../lib/machine/uccncController'

type Arc = Extract<QueuedMove, { kind: 'arc' }>

const WCS_ORIGIN = { x: 10, y: 20, z: -5 }
function makeWcs(): WCS {
  return {
    id: 'w1', label: 'G54', fixtureOffset: 54,
    origin: { ...WCS_ORIGIN },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  } as WCS
}
const TRACE = { opId: 'op-1337', setupId: 'setup-1337' }
const RAPID_FEED = 3000

function build(moves: ToolpathMove[]) {
  return buildStraightLineProgram(moves, makeWcs(), RAPID_FEED, TRACE)
}
function expectRefusal(result: ReturnType<typeof build>, ...fragments: string[]): void {
  if (result.ok) throw new Error('expected a refusal, got a program')
  expect(Object.hasOwn(result, 'program')).toBe(false)
  for (const fragment of fragments) expect(result.reason).toContain(fragment)
}
function arcsOf(result: ReturnType<typeof build>): Arc[] {
  if (!result.ok) throw new Error(result.reason)
  return result.program.steps.filter((s): s is Arc => s.kind === 'arc')
}

/**
 * A Fusion-shaped helical ramp about world (30, 20): `turns` full revolutions,
 * `perTurn` arcs each, descending `depthMm` in total. Split into quarters
 * because a FULL CIRCLE is still refused - which is what Fusion's post emits
 * anyway.
 */
function helicalRamp(opts: {
  turns: number
  perTurn: number
  radius: number
  zStart: number
  depthMm: number
  feed: number
  ccw?: boolean
}): ToolpathMove[] {
  const { turns, perTurn, radius, zStart, depthMm, feed } = opts
  const ccw = opts.ccw !== false
  const total = turns * perTurn
  const at = (k: number): { x: number; y: number; z: number } => {
    const angle = ((ccw ? 1 : -1) * 2 * Math.PI * k) / perTurn
    return {
      x: 30 + radius * Math.cos(angle),
      y: 20 + radius * Math.sin(angle),
      z: zStart - (depthMm * k) / total,
    }
  }
  const start = at(0)
  const moves: ToolpathMove[] = [{ type: 'rapid', x: start.x, y: start.y, z: start.z }]
  for (let k = 1; k <= total; k++) {
    const p = at(k)
    moves.push({ type: ccw ? 'arc_ccw' : 'arc_cw', x: p.x, y: p.y, z: p.z, feed, cx: 30, cy: 20 })
  }
  return moves
}

describe('WO-1337 builder: a helical arc stages as ONE arc carrying its endpoint Z', () => {
  it('emits a single arc step whose endpoint Z differs from the start, with the centre through the same transform', () => {
    // A quarter arc counter-clockwise about world (30, 20) from (40, 20) to
    // (30, 30), ramping Z from -1 to -1.4 - the shape of one Fusion `G3` line.
    const result = build([
      { type: 'rapid', x: 40, y: 20, z: 5 },
      { type: 'feed', x: 40, y: 20, z: -1, feed: 300 },
      { type: 'arc_ccw', x: 30, y: 30, z: -1.4, feed: 800, cx: 30, cy: 20 },
    ])
    if (!result.ok) throw new Error(result.reason)
    const arcs = arcsOf(result)
    expect(arcs).toHaveLength(1)
    const arc = arcs[0]

    // ONE step, not a chorded approximation of one.
    expect(result.motionCount).toBe(3)

    // Work = world - origin, applied to the END and to the CENTRE alike.
    expect(arc.to).toEqual({ x: 30 - 10, y: 30 - 20, z: -1.4 + 5 })
    expect(arc.centre).toEqual({ x: 30 - 10, y: 20 - 20, z: -1.4 + 5 })
    // THE Z THAT MATTERS: the endpoint's, and it is NOT where the arc started.
    const startZ = -1 + 5
    expect(arc.to.z).not.toBeCloseTo(startZ, 6)
    expect(arc.to.z - startZ).toBeCloseTo(-0.4, 9)
    // The centre's Z is the endpoint's, exactly as on a planar arc: the helix
    // axis is parallel to Z and no point on it is more the centre.
    expect(arc.centre.z).toBe(arc.to.z)

    // Direction, plane and feed are untouched by the ramp (WO-1285's contract).
    expect(arc.clockwise).toBe(false)
    expect(arc.plane).toBe('xy')
    expect(arc.feedMmMin).toBe(800)
    expect(result.program.index[arc.id]).toEqual({ ...TRACE, moveOrdinal: 2 })
  })

  it('a clockwise helix keeps the clockwise flag: nothing is inverted on this side', () => {
    const arc = arcsOf(build([
      { type: 'rapid', x: 40, y: 20, z: -1 },
      { type: 'arc_cw', x: 30, y: 10, z: -1.4, feed: 800, cx: 30, cy: 20 },
    ]))[0]
    expect(arc.clockwise).toBe(true)
    expect(arc.to.z).toBeCloseTo(-1.4 + 5, 9)
  })

  it('stages Operator\'s ramp shape: 3,561 arcs are 3,561 slots and fit the board, where chords would not', () => {
    // His file is 3,561 `G3` lines stepping Z by about 0.1 mm. Built as arcs it
    // sits under the 4,095 ceiling; that is the whole reason not to linearise.
    const moves = helicalRamp({
      turns: 1187, perTurn: 3, radius: 4, zStart: 0, depthMm: 356.1, feed: 400,
    })
    const built = build(moves)
    if (!built.ok) throw new Error(built.reason)
    expect(arcsOf(built)).toHaveLength(3_561)
    expect(built.motionCount).toBe(3_562) // the arcs plus the approach rapid
    const capacity = assessProgramCapacity(built.program.steps, 4_095)
    expect(capacity.count).toBe(3_562)
    expect(capacity.fits).toBe(true)

    // Every step ramps, and the total descent is what the file asked for.
    const arcs = arcsOf(built)
    expect(arcs[0].to.z).toBeGreaterThan(arcs[arcs.length - 1].to.z)
    expect(arcs[0].to.z - arcs[arcs.length - 1].to.z).toBeCloseTo(356.1 - 356.1 / 3_561, 6)

    // The same helix chorded at 16 segments per arc blows the ceiling, with no
    // rapid anywhere in the descent to split it at.
    const chorded = assessProgramCapacity(
      Array.from({ length: 3_561 * 16 }, (_, i) => ({
        id: i + 1, kind: 'line' as const, to: { x: i, y: i, z: -i / 1000 }, feedMmMin: 400,
      })),
      4_095,
    )
    expect(chorded.fits).toBe(false)
    expect(chorded.parts).toBeNull()
  })
})

describe('WO-1337 builder: a Z ramp excuses nothing - every other refusal still fires by name', () => {
  it('still refuses a FULL CIRCLE, even one that descends a whole turn', () => {
    expectRefusal(build([
      { type: 'rapid', x: 40, y: 20, z: -1 },
      { type: 'arc_cw', x: 40, y: 20, z: -2, feed: 800, cx: 30, cy: 20 },
    ]), 'Move 1', 'start and end coincide', 'full circle', 'split it into two arcs')
  })

  it('still refuses a MALFORMED arc whose ends are not on one circle while it ramps', () => {
    expectRefusal(build([
      { type: 'rapid', x: 40, y: 20, z: -1 },
      { type: 'arc_cw', x: 25, y: 20, z: -1.4, feed: 800, cx: 30, cy: 20 },
    ]), 'Move 1', 'not on one circle', 'malformed')
  })

  it('still refuses a ramping arc with no centre, zero radius, no move before it, or no feed', () => {
    expectRefusal(build([
      { type: 'rapid', x: 40, y: 20, z: -1 },
      { type: 'arc_cw', x: 20, y: 20, z: -1.4, feed: 800 },
    ]), 'Move 1', 'no usable centre')
    expectRefusal(build([
      { type: 'rapid', x: 30, y: 20, z: -1 },
      { type: 'arc_cw', x: 30, y: 20.000001, z: -1.4, feed: 800, cx: 30, cy: 20 },
    ]), 'Move 1', 'zero radius')
    expectRefusal(build([
      { type: 'arc_cw', x: 30, y: 20, z: -1.4, feed: 800, cx: 20, cy: 20 },
    ]), 'Move 0', 'no move before it')
    expectRefusal(build([
      { type: 'rapid', x: 40, y: 20, z: -1 },
      { type: 'arc_cw', x: 20, y: 20, z: -1.4, cx: 30, cy: 20 },
    ]), 'Move 1', 'no feed rate', 'never from here')
  })
})

describe('WO-1337 swept bounds: the Z range of a helix IS its two ends', () => {
  it('a ramping arc has the same XY box as the planar one and a Z box of its ends', () => {
    // A counter-clockwise semicircle from (10, 0) to (-10, 0) about the origin
    // bulges to y = 10. Ramping Z must not move that, and must not invent a Z
    // the arc never reaches.
    const planar = arcSweptBounds({ x: 10, y: 0, z: -3 }, { x: -10, y: 0, z: -3 }, { x: 0, y: 0 }, false)
    const helical = arcSweptBounds({ x: 10, y: 0, z: -3 }, { x: -10, y: 0, z: -5 }, { x: 0, y: 0 }, false)
    expect(helical.min.x).toBeCloseTo(planar.min.x, 12)
    expect(helical.max.x).toBeCloseTo(planar.max.x, 12)
    expect(helical.min.y).toBeCloseTo(planar.min.y, 12)
    expect(helical.max.y).toBeCloseTo(planar.max.y, 12)
    // Z is the two ends and nothing wider: there is no Z equivalent of a bulge.
    expect(helical.min.z).toBeCloseTo(-5, 12)
    expect(helical.max.z).toBeCloseTo(-3, 12)
  })

  it('a whole ramping program reports the descent in its bounds', () => {
    const built = build(helicalRamp({
      turns: 3, perTurn: 4, radius: 6, zStart: 0, depthMm: 6, feed: 500,
    }))
    if (!built.ok) throw new Error(built.reason)
    const bounds = programSweptBounds(built.program)!
    // Work Z = world Z + 5. Start 0 -> 5, finish -6 -> -1.
    expect(bounds.max.z).toBeCloseTo(5, 9)
    expect(bounds.min.z).toBeCloseTo(-1, 9)
    // XY is still the full circle of radius 6 about work (20, 0).
    expect(bounds.min.x).toBeCloseTo(14, 9)
    expect(bounds.max.x).toBeCloseTo(26, 9)
  })
})

const ENVELOPE: MachineEnvelope = {
  x: { travelMm: 100, homesToward: 'min', homePositionMm: 0, pulloffMm: 0, min: 0, max: 100 },
  y: { travelMm: 100, homesToward: 'min', homePositionMm: 0, pulloffMm: 0, min: 0, max: 100 },
  z: { travelMm: 50, homesToward: 'max', homePositionMm: 0, pulloffMm: 0, min: -50, max: 0 },
}

describe('WO-1337 travel: a helix that ramps off the bottom of Z is named, and one that does not is left alone', () => {
  it('names the arc and the Z axis when the descent leaves the declared travel', () => {
    // Work origin at machine (50, 50, -10): a descent to work Z -45 is machine
    // -55, below the -50 floor.
    const built = build([
      { type: 'rapid', x: WCS_ORIGIN.x + 10, y: WCS_ORIGIN.y, z: WCS_ORIGIN.z },
      { type: 'arc_ccw', x: WCS_ORIGIN.x - 10, y: WCS_ORIGIN.y, z: WCS_ORIGIN.z - 45, feed: 500, cx: WCS_ORIGIN.x, cy: WCS_ORIGIN.y },
    ])
    if (!built.ok) throw new Error(built.reason)
    const offence = firstStepOutsideTravel(built.program, { x: 50, y: 50, z: -10 }, ENVELOPE)
    expect(offence).not.toBeNull()
    expect(offence!.kind).toBe('arc')
    expect(offence!.axis).toBe('z')
    expect(offence!.reachesMm).toBeCloseTo(-55, 9)
    // NOT a bulge: an END is what left the table, and the operator is told so.
    expect(offence!.bulge).toBe(false)
  })

  it('passes a helix whose whole descent is inside, and still catches its XY bulge', () => {
    const inside = build([
      { type: 'rapid', x: WCS_ORIGIN.x + 10, y: WCS_ORIGIN.y, z: WCS_ORIGIN.z },
      { type: 'arc_cw', x: WCS_ORIGIN.x - 10, y: WCS_ORIGIN.y, z: WCS_ORIGIN.z - 5, feed: 500, cx: WCS_ORIGIN.x, cy: WCS_ORIGIN.y },
    ])
    if (!inside.ok) throw new Error(inside.reason)
    expect(firstStepOutsideTravel(inside.program, { x: 50, y: 50, z: -10 }, ENVELOPE)).toBeNull()

    // The same descent swept the other way bulges to machine y = 105.
    const bulging = build([
      { type: 'rapid', x: WCS_ORIGIN.x + 15, y: WCS_ORIGIN.y, z: WCS_ORIGIN.z },
      { type: 'arc_ccw', x: WCS_ORIGIN.x - 15, y: WCS_ORIGIN.y, z: WCS_ORIGIN.z - 5, feed: 500, cx: WCS_ORIGIN.x, cy: WCS_ORIGIN.y },
    ])
    if (!bulging.ok) throw new Error(bulging.reason)
    const offence = firstStepOutsideTravel(bulging.program, { x: 50, y: 90, z: -10 }, ENVELOPE)
    expect(offence!.axis).toBe('y')
    expect(offence!.reachesMm).toBeCloseTo(105, 9)
    expect(offence!.bulge).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// The integrator that will animate it, and the measurement the air run repeats
// ---------------------------------------------------------------------------

function events(): ControllerEvents {
  return {
    onStatus: vi.fn(), onParserState: vi.fn(), onConnectionPhase: vi.fn(), onConsole: vi.fn(),
    onClose: vi.fn(), onReady: vi.fn(), onJobEvent: vi.fn(), onJobProgress: vi.fn(), onHomed: vi.fn(),
    onAlarm: vi.fn(), onAccessories: vi.fn(), onSetting: vi.fn(),
  }
}
const HOME = {
  x: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  y: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
  z: { homesToward: 'min' as const, machineZeroAt: 'min' as const },
}
function program(steps: QueuedMove[]): MachineProgram {
  const index: MachineProgram['index'] = {}
  for (const s of steps) index[s.id] = { opId: 'op', setupId: 'setup', moveOrdinal: s.id - 1 }
  return { frame: 'work', units: 'mm', steps, index }
}

describe('WO-1337 simulator: the swept angle and the Z ramp, measured from the path', () => {
  let controller: SimulatedController
  beforeEach(() => {
    vi.useFakeTimers()
    controller = new SimulatedController(events(), {
      travelMm: { x: 100, y: 100, z: 50 }, homeConvention: HOME,
    })
  })
  afterEach(async () => {
    await controller.disconnect?.()
    vi.useRealTimers()
  })

  /** Run one arc after an approach and return every sampled position during it. */
  async function flyArc(arc: QueuedMove, approach: { x: number; y: number; z: number }) {
    await controller.connect({ kind: 'none' })
    await vi.advanceTimersByTimeAsync(2000)
    const steps: QueuedMove[] = [
      { id: 1, kind: 'line', to: { ...approach }, feedMmMin: 60000, rapid: true },
      arc,
    ]
    expect(controller.loadProgram(program(steps))).toEqual({ ok: true, reason: null })
    expect(controller.startJob()).toBe(true)
    const path: Array<{ x: number; y: number; z: number }> = []
    for (let t = 0; t < 600; t++) {
      await vi.advanceTimersByTimeAsync(50)
      const p = controller.status().machinePos
      if (p && controller.programProgress().executingId === 2) path.push({ ...p })
      if (controller.programProgress().lastCompletedId === 2) break
    }
    return path
  }

  it('holds the circle while Z descends in step with the swept angle, and lands on the endpoint Z', async () => {
    // A counter-clockwise QUARTER about (30, 30), radius 30, descending 6 mm:
    // (60, 30, 10) -> (30, 60, 4).
    const path = await flyArc(
      { id: 2, kind: 'arc', to: { x: 30, y: 60, z: 4 }, centre: { x: 30, y: 30, z: 4 }, clockwise: false, plane: 'xy', feedMmMin: 1200 },
      { x: 60, y: 30, z: 10 },
    )
    // 47 mm of arc at 20 mm/s, sampled every 50 ms tick: tens of samples, not
    // the handful a fast feed would leave to argue from.
    expect(path.length).toBeGreaterThan(30)

    let worstRadiusError = 0
    let worstZError = 0
    for (const p of path) {
      const r = Math.hypot(p.x - 30, p.y - 30)
      worstRadiusError = Math.max(worstRadiusError, Math.abs(r - 30))
      // Z MUST TRACK THE SWEPT ANGLE, not the chord and not the XY distance:
      // the fraction of the quarter already swept is the fraction of the
      // descent already spent.
      const swept = Math.atan2(p.y - 30, p.x - 30) / (Math.PI / 2)
      worstZError = Math.max(worstZError, Math.abs(p.z - (10 - 6 * swept)))
      // NO Z OUTSIDE THE TWO ENDS: the claim `arcSweptBounds` rests on.
      expect(p.z).toBeGreaterThanOrEqual(4 - 1e-6)
      expect(p.z).toBeLessThanOrEqual(10 + 1e-6)
    }
    expect(worstRadiusError).toBeLessThan(0.01)
    expect(worstZError).toBeLessThan(0.05)
    expect(controller.status().machinePos).toMatchObject({ x: 30, y: 60, z: 4 })

    // THE SAMPLE NEAREST HALF WAY ROUND, judged on its own measured angle. The
    // chord from (60,30) to (30,60) passes 8.8 mm inside this point, so a
    // linearised arc could not produce it; and its Z is half the descent, to
    // within the 1 mm of arc one 50 ms tick covers.
    const mid = path.reduce((best, p) =>
      Math.abs(Math.atan2(p.y - 30, p.x - 30) - Math.PI / 4)
        < Math.abs(Math.atan2(best.y - 30, best.x - 30) - Math.PI / 4) ? p : best)
    expect(Math.hypot(mid.x - 51.213, mid.y - 51.213)).toBeLessThan(1.5)
    expect(Math.hypot(mid.x - 45, mid.y - 45)).toBeGreaterThan(8)
    const midSwept = Math.atan2(mid.y - 30, mid.x - 30) / (Math.PI / 2)
    expect(mid.z).toBeCloseTo(10 - 6 * midSwept, 1)
    expect(Math.abs(mid.z - 7)).toBeLessThan(0.25)
  })

  it('a helix flown the long way round is still a helix: the direction flag decides which, and roundness cannot', async () => {
    // THE SAME TWO ENDS, the other direction. Counter-clockwise is the quarter
    // through (51, 51); clockwise is the three-quarters through (0, 30) - and
    // both are perfectly round. This is the error the air run exists to catch.
    const path = await flyArc(
      { id: 2, kind: 'arc', to: { x: 30, y: 60, z: 4 }, centre: { x: 30, y: 30, z: 4 }, clockwise: true, plane: 'xy', feedMmMin: 1200 },
      { x: 60, y: 30, z: 10 },
    )
    const visitedFarSide = path.some((p) => p.x < 5 && Math.abs(p.y - 30) < 5)
    const visitedNearMid = path.some((p) => Math.abs(p.x - 51.213) < 1.0 && Math.abs(p.y - 51.213) < 1.0)
    expect(visitedFarSide).toBe(true)
    expect(visitedNearMid).toBe(false)
    // The descent is spread over the THREE QUARTERS actually flown, not over
    // the quarter the two ends suggest: (30, 0) is 90 of the 270 degrees, so a
    // third of the 6 mm is gone by then. A Z spent per unit of chord, or per
    // quarter, would read 7 here.
    const bottom = path.find((p) => Math.abs(p.x - 30) < 1.0 && p.y < 5)
    expect(bottom).toBeDefined()
    expect(bottom!.z).toBeCloseTo(10 - 6 / 3, 1)
    expect(controller.status().machinePos).toMatchObject({ x: 30, y: 60, z: 4 })
  })
})

// ---------------------------------------------------------------------------
// THE WIRE. What the real backend puts in the `loadMoves` frame - captured, not
// described. This is the desk half of the order's evidence.
// ---------------------------------------------------------------------------

const BRIDGE_CAPS: ControllerCapabilities = {
  geometryQueue: true,
  executingMoveId: true,
  bufferSeconds: true,
  gcodeText: false,
  perAxisHoming: true,
  ownsSpindle: true,
  spindleCommands: false,
  machineProgram: true,
}

class FakeTransport implements UccncTransport {
  sinks: BridgeTransportEvents | null = null
  sent: BridgeCallMessage[] = []
  async start(sinks: BridgeTransportEvents): Promise<void> { this.sinks = sinks }
  send(message: BridgeCallMessage): void { this.sent.push(message) }
  async close(): Promise<void> {}
  emit(message: BridgeMessage): void { this.sinks?.onMessage(message) }
  lastCall(m: string): BridgeCallMessage {
    const calls = this.sent.filter((c) => c.m === m)
    if (calls.length === 0) throw new Error(`no "${m}" call reached the wire`)
    return calls[calls.length - 1]
  }
}

async function connectedBridge(): Promise<{ transport: FakeTransport; controller: UccncController }> {
  const transport = new FakeTransport()
  const controller = new UccncController(events())
  const connected = controller.connect({ kind: 'messages', transport })
  transport.emit({
    t: 'hello',
    v: {
      protocol: SUPPORTED_BRIDGE_PROTOCOL,
      bridge: 'liencam-uccnc-bridge/0.2',
      capabilities: BRIDGE_CAPS,
      readOnly: false,
    },
  })
  await connected
  return { transport, controller }
}

describe('WO-1337 wire: the G28 retract frame the bridge is handed', () => {
  it('is an ordinary rapid to home in work coordinates - no new step, nothing to interpret', async () => {
    const { transport, controller } = await connectedBridge()

    // Read a real Fusion-shaped home block, build it, and put it on the wire.
    const moves = movesOf([
      'G21 G90 G54',
      'G0 X1 Y1 Z1',
      'G1 Z-2 F200',
      'G28 G91 Z0',
      'G90',
      'M30',
    ].join('\n'), { machineHome: MACHINE_HOME })
    const built = build(moves)
    if (!built.ok) throw new Error(built.reason)
    expect(controller.loadProgram(built.program)).toEqual({ ok: true, reason: null })

    const frame = transport.lastCall('loadMoves')
    const wire = frame.a.moves as QueuedMove[]
    // THREE PLAIN LINES. The home block is the last of them, and there is no
    // "go home" step on this wire for a board to have an opinion about.
    expect(wire.map((move) => move.kind)).toEqual(['line', 'line', 'line'])
    const retract = wire[2]
    if (retract.kind !== 'line') throw new Error('expected a line')
    expect(retract.to).toEqual({
      x: 1 - WCS_ORIGIN.x, y: 1 - WCS_ORIGIN.y, z: HOME_IN_G54.z - WCS_ORIGIN.z,
    })
    expect(retract.rapid).toBe(true)

    if (process.env.WRITE_EVIDENCE === '1') {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync('src/tests/evidence/WO-1337', { recursive: true })
      writeFileSync('src/tests/evidence/WO-1337/wire-g28-retract.json', `${JSON.stringify({
        note: 'The loadMoves frame UccncController put on a fake bridge transport for a file whose '
          + 'last block is `G28 G91 Z0`, read by reader.ts on a HOMED machine (machine home '
          + '(-1, -2, -3), G54 at machine (10, 5, 2)) and built by buildStraightLineProgram. '
          + 'Captured by src/tests/machine/helicalArc.wo1337.test.ts (WRITE_EVIDENCE=1).',
        gcode: 'G21 G90 G54 / G0 X1 Y1 Z1 / G1 Z-2 F200 / G28 G91 Z0 / G90 / M30',
        call: frame.m,
        frame: frame.a.frame,
        moves: wire,
      }, null, 2)}\n`)
    }
  })
})

describe('WO-1337 wire: the helical arc frame the bridge is handed', () => {
  it('carries an endpoint Z, a centre Z and the direction flag WO-1285 measured', async () => {
    const transport = new FakeTransport()
    const controller = new UccncController(events())
    const connected = controller.connect({ kind: 'messages', transport })
    transport.emit({
      t: 'hello',
      v: {
        protocol: SUPPORTED_BRIDGE_PROTOCOL,
        bridge: 'liencam-uccnc-bridge/0.2',
        capabilities: BRIDGE_CAPS,
        readOnly: false,
      },
    })
    await connected

    // Two turns of a real ramp, built by the product's own builder from the
    // moves a Fusion post produces - not a hand-written payload.
    const built = build(helicalRamp({
      turns: 2, perTurn: 4, radius: 4, zStart: 0, depthMm: 1.6, feed: 400,
    }))
    if (!built.ok) throw new Error(built.reason)
    expect(controller.loadProgram(built.program)).toEqual({ ok: true, reason: null })

    const frame = transport.lastCall('loadMoves')
    expect(frame.a.frame).toBe('work')
    const moves = frame.a.moves as QueuedMove[]
    expect(moves).toHaveLength(9)
    const wireArcs = moves.filter((m): m is Arc => m.kind === 'arc')
    expect(wireArcs).toHaveLength(8)

    // EVERY arc on the wire ramps, and the Z it ramps to is on the frame.
    let previousZ = (moves[0] as Extract<QueuedMove, { kind: 'line' }>).to.z!
    for (const arc of wireArcs) {
      expect(typeof arc.to.z).toBe('number')
      expect(typeof arc.centre.z).toBe('number')
      expect(arc.to.z).toBeLessThan(previousZ)
      expect(arc.to.z - previousZ).toBeCloseTo(-0.2, 9)
      expect(arc.centre.z).toBe(arc.to.z)
      // `arc_ccw` reaches the wire as clockwise:false. The bridge submits
      // `AddCircularMoveP(..., !m.Clockwise, ...)`, so this frame becomes a
      // TRUE counter-clockwise flag at the API - the inversion measured on
      // Operator's machine 2026-08-25, unchanged by the ramp.
      expect(arc.clockwise).toBe(false)
      expect(arc.plane).toBe('xy')
      expect(arc.feedMmMin).toBe(400)
      previousZ = arc.to.z
    }
    // Eight quarter-arcs of a 4 mm radius, two turns, 1.6 mm down in total.
    expect(wireArcs[wireArcs.length - 1].to.z).toBeCloseTo(5 - 1.6, 9)

    if (process.env.WRITE_EVIDENCE === '1') {
      const { mkdirSync, writeFileSync } = await import('node:fs')
      mkdirSync('src/tests/evidence/WO-1337', { recursive: true })
      writeFileSync(
        'src/tests/evidence/WO-1337/wire-helical-arc.json',
        `${JSON.stringify({
          note: 'The loadMoves frame UccncController put on a fake bridge transport for a helical '
            + 'ramp built by buildStraightLineProgram. Captured by '
            + 'src/tests/machine/helicalArc.wo1337.test.ts (WRITE_EVIDENCE=1). Desk evidence '
            + '(Tier 2) only - no helix has run on the board.',
          call: frame.m,
          frame: frame.a.frame,
          moves,
        }, null, 2)}\n`,
      )
    }
  })
})

// ---------------------------------------------------------------------------
// THE READER'S OWN TWO REFUSALS (WO-1337, attempt 2).
//
// The builder's helical refusal was the SECOND one in the way. `reader.ts` had
// its own, and it is the one Operator's file actually stopped at - line 31, before
// a single move existed for the builder to judge. The same file also carries
// the word that stops both third-party Fusion files at their first and seventh
// lines: `G28`, the home block every Fusion post opens and closes with.
//
// Both are resolved here rather than passed on. What leaves the reader for a
// helical `G3` is one arc move with the Z it ramps to; what leaves it for a
// `G28` is plain rapids to numbers in work coordinates - which the travel and
// soft-limit checks above can see exactly as they see every other move.
// ---------------------------------------------------------------------------

/** The work origins a controller reports, and a HOME that is not the origin of
 *  anything - deliberately non-zero on all three axes, so a test that passed by
 *  accident (home == machine zero == work zero) cannot. */
const WORK_OFFSETS = { G54: { x: 10, y: 5, z: 2 }, G55: { x: 110, y: 5, z: 2 } }
const MACHINE_HOME = { x: -1, y: -2, z: -3 }
/** Home in G54 WORK coordinates: machine - offset, the G53 arithmetic. */
const HOME_IN_G54 = { x: -11, y: -7, z: -5 }

function readerOptions(overrides: Partial<GcodeReaderOptions> = {}): GcodeReaderOptions {
  return {
    dialect: 'uccnc',
    sessionWcs: 'G54',
    initialPosition: { x: 0, y: 0, z: 0 },
    machineUnits: 'mm',
    workOffsets: WORK_OFFSETS,
    ...overrides,
  }
}

function read(text: string, overrides: Partial<GcodeReaderOptions> = {}) {
  return readGcodeProgram(text, readerOptions(overrides))
}

function movesOf(text: string, overrides: Partial<GcodeReaderOptions> = {}): ToolpathMove[] {
  const result = read(text, overrides)
  if (!result.ok) throw new Error(`expected a program, got: ${result.refusal.message}`)
  return result.program.moves
}

function refusalOf(text: string, overrides: Partial<GcodeReaderOptions> = {}) {
  const result = read(text, overrides)
  if (result.ok) throw new Error('expected a refusal, got a program')
  // A REFUSAL CARRIES NO PROGRAM - nothing partial escapes the reader.
  expect(Object.hasOwn(result, 'program')).toBe(false)
  return result.refusal
}

describe('WO-1337 reader: a helical G2/G3 reads as ONE arc move that ramps', () => {
  it('carries the endpoint Z the file states, with the I/J centre unchanged', () => {
    const moves = movesOf([
      'G21 G90 G54',
      'G0 X10 Y0 Z5',
      'G1 Z1 F200',
      'G3 X0 Y10 Z0.5 I-10 J0 F300',
      'M30',
    ].join('\n'))

    const arcs = moves.filter((move) => move.type === 'arc_ccw' || move.type === 'arc_cw')
    expect(arcs).toHaveLength(1)
    expect(arcs[0]).toEqual({
      type: 'arc_ccw', role: 'cut', feed: 300, cx: 0, cy: 0, x: 0, y: 10, z: 0.5,
    })
    // It RAMPS: the move before it ended at z 1 and this one ends half a
    // millimetre lower, which is the whole point.
    expect(moves[moves.length - 2].z).toBe(1)
  })

  it('a ramp of many short arcs stays that many arcs - nothing is fused or split', () => {
    // Four quarter-turns of radius 10 about the origin, each dropping 0.1 mm:
    // the shape of a Fusion helical ramp entry, in miniature.
    const lines = ['G21 G90 G54', 'G0 X10 Y0 Z5', 'G1 Z1 F200']
    const corners = [[0, 10, -10, 0], [-10, 0, 0, -10], [0, -10, 10, 0], [10, 0, 0, 10]]
    corners.forEach(([x, y, i, j], index) => {
      lines.push(`G3 X${x} Y${y} Z${(1 - 0.1 * (index + 1)).toFixed(1)} I${i} J${j} F300`)
    })
    lines.push('M30')

    const arcs = movesOf(lines.join('\n')).filter((move) => move.type === 'arc_ccw')
    expect(arcs).toHaveLength(4)
    expect(arcs.map((arc) => arc.z)).toEqual([0.9, 0.8, 0.7, 0.6])
  })

  it('and every XY check it always made still fires while the arc ramps', () => {
    const base = ['G21 G90 G54', 'G0 X10 Y0 Z5', 'G1 Z1 F200']
    // Ends not on one circle - and a Z ramp does not put them on one.
    expect(refusalOf([...base, 'G3 X0 Y5 Z0.5 I-10 J0 F300', 'M30'].join('\n')).reason)
      .toContain('not equidistant')
    // No centre at all.
    expect(refusalOf([...base, 'G3 X0 Y10 Z0.5 F300', 'M30'].join('\n')).reason)
      .toContain('no I/J centre or R radius')
    // No feed.
    expect(refusalOf(['G21 G90 G54', 'G0 X10 Y0 Z5', 'G3 X0 Y10 Z0.5 I-10 J0', 'M30'].join('\n')).reason)
      .toContain('no positive feed rate')
    // A K word is still not understood on a G17-plane arc: a ramp is not
    // permission to reinterpret the plane's centre axes.
    expect(refusalOf([...base, 'G3 X0 Y10 Z0.5 I-10 J0 K1 F300', 'M30'].join('\n')).reason)
      .toContain('K on a G17-plane arc')
  })
})

describe('WO-1337 reader: G28 is a machine-frame retract, resolved at load', () => {
  it("resolves the `G28 G91 Z0` every Fusion post writes into ONE rapid to home Z", () => {
    const moves = movesOf([
      'G21 G90 G54',
      'G0 X1 Y1 Z1',
      'G28 G91 Z0',
      'G90',
      'M30',
    ].join('\n'), { machineHome: MACHINE_HOME })

    // The intermediate point is `G91 Z0` - where the tool already is - so no
    // move is emitted for it. What is emitted is the retract itself, on Z
    // alone, to machine home in G54 work coordinates.
    expect(moves).toEqual([
      { type: 'rapid', role: 'rapid', feed: undefined, x: 1, y: 1, z: 1 },
      { type: 'rapid', role: 'rapid', feed: undefined, x: 1, y: 1, z: HOME_IN_G54.z },
    ])
  })

  it('a BARE G28 sends every axis home, and a named one moves only the axes it names', () => {
    const bare = movesOf(['G21 G90 G54', 'G0 X1 Y1 Z1', 'G28', 'M30'].join('\n'), {
      machineHome: MACHINE_HOME,
    })
    expect(bare[bare.length - 1]).toEqual({
      type: 'rapid', role: 'rapid', feed: undefined, ...HOME_IN_G54,
    })

    // X and Y named, Z not: the tool holds the Z it was at.
    const named = movesOf(['G21 G90 G54', 'G0 X1 Y1 Z1', 'G28 X5 Y5', 'M30'].join('\n'), {
      machineHome: MACHINE_HOME,
    })
    expect(named.slice(1)).toEqual([
      // LEG ONE, the intermediate point the block states, in the ACTIVE frame.
      { type: 'rapid', role: 'rapid', feed: undefined, x: 5, y: 5, z: 1 },
      // LEG TWO, home on X and Y only - Z is untouched at 1. WO-2596: one
      // rapid per axis in the homing order, X then Y.
      { type: 'rapid', role: 'rapid', feed: undefined, x: HOME_IN_G54.x, y: 5, z: 1 },
      { type: 'rapid', role: 'rapid', feed: undefined, x: HOME_IN_G54.x, y: HOME_IN_G54.y, z: 1 },
    ])
  })

  it('RUNS with no home position named, to machine zero, as UCCNC and LinuxCNC do (WO-1644)', () => {
    // G28 does not require homing: the controllers rapid to the stored G28
    // position, machine zero until something sets it.
    const moves = movesOf(['G21 G90 G54', 'G0 X1 Y1 Z1', 'G28 G91 Z0', 'M30'].join('\n'))
    expect(moves.at(-1)).toMatchObject({ type: 'rapid', x: 1, y: 1, z: -WORK_OFFSETS.G54.z })
  })

  it('is refused when the frame it must be stated in is unknown, like G53 is', () => {
    const refusal = refusalOf(['G21 G90 G55', 'G0 X1 Y1 Z1', 'G28', 'M30'].join('\n'), {
      sessionWcs: 'G55',
      machineHome: MACHINE_HOME,
      workOffsets: { G54: WORK_OFFSETS.G54 },
    })
    expect(refusal.line).toBe(3)
    expect(refusal.reason).toContain('G55 work offset is unknown')
  })

  it('and G30 is still refused: its point is stored in a controller nothing reads back', () => {
    const refusal = refusalOf(['G21 G90 G54', 'G0 X1 Y1 Z1', 'G30 G91 Z0', 'M30'].join('\n'), {
      machineHome: MACHINE_HOME,
    })
    expect(refusal.line).toBe(3)
    expect(refusal.reason).toContain('G30')
    expect(refusal.reason).toContain('controller-stored point')
  })

  it('stays inside the checks that follow it: a home rapid is an ordinary move to the travel test', () => {
    // Home is a real place and the moves that reach it are ordinary rapids, so
    // the builder and the travel check see them like any other. Proven by
    // building the read moves and finding the retract in the program.
    const moves = movesOf(['G21 G90 G54', 'G0 X1 Y1 Z1', 'G28', 'M30'].join('\n'), {
      machineHome: MACHINE_HOME,
    })
    const built = build(moves)
    if (!built.ok) throw new Error(built.reason)
    const last = built.program.steps[built.program.steps.length - 1]
    expect(last.kind).toBe('line')
    if (last.kind !== 'line') return
    expect(last.to).toEqual({
      x: HOME_IN_G54.x - WCS_ORIGIN.x,
      y: HOME_IN_G54.y - WCS_ORIGIN.y,
      z: HOME_IN_G54.z - WCS_ORIGIN.z,
    })
    expect(last.rapid).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// THE HEADLINE: OPERATOR'S OWN FILE.
// ---------------------------------------------------------------------------


const INTERPRET_OPTIONS: GcodeInterpretOptions = {
  dialect: 'uccnc',
  sessionWcs: 'G54',
  initialPosition: { x: 0, y: 0, z: 0 },
  machineUnits: 'mm',
  workOffsets: WORK_OFFSETS,
}

describe("WO-1337: SampleMachine's fusion-liencnc-v2-sample.nc LOADS", () => {
  const text = readFileSync('src/tests/fixtures/foreign-gcode/fusion-liencnc-v2-sample.nc', 'utf8')

  it('reads the whole file into stages, and the arc it used to stop on is in them', () => {
    const result = interpretGcodeProgram(text, INTERPRET_OPTIONS)
    if (!result.ok) throw new Error(`Operator's file was refused: ${result.refusal.message}`)

    // THE NUMBER THE CORPUS ROW CARRIES.
    expect(result.program.moveCount).toBe(110_615)
    expect(result.program.frames).toEqual(['G54', 'G54', 'G54', 'G54', 'G54'])
    expect(result.program.tools).toEqual([19])

    // LINE 31 - where it stopped for two rounds of two work orders - is an arc
    // that ramps, and it is staged as one arc move.
    const staged = result.program.stages.flatMap(
      (stage) => stage.moves.map((move, index) => ({ move, line: stage.moveLines[index] })),
    )
    const line31 = staged.filter((entry) => entry.line === 31)
    expect(line31).toHaveLength(1)
    expect(line31[0].move).toMatchObject({ type: 'arc_ccw', x: 273.543, y: 112.683, z: 2.394 })
    // Its predecessor ended higher: this arc descends 0.106 mm as it sweeps.
    const before = staged[staged.indexOf(line31[0]) - 1]
    expect(before.move.z).toBeCloseTo(2.5, 9)

    // AND THE FILE IS MOSTLY RAMPING ARCS - the helical entry is not one
    // special case in it, it is what the file is made of.
    const arcs = staged.filter(({ move }) => move.type === 'arc_cw' || move.type === 'arc_ccw')
    expect(arcs.length).toBeGreaterThan(3_000)
    const ramping = arcs.filter(({ move }, index) => index > 0 && move.z !== arcs[index - 1].move.z)
    expect(ramping.length).toBeGreaterThan(3_000)
  })

  it('writes what it read to evidence when asked', async () => {
    if (process.env.WRITE_EVIDENCE !== '1') return
    const result = interpretGcodeProgram(text, INTERPRET_OPTIONS)
    if (!result.ok) throw new Error(`Operator's file was refused: ${result.refusal.message}`)
    const staged = result.program.stages.flatMap(
      (stage) => stage.moves.map((move, index) => ({ move, line: stage.moveLines[index] })),
    )
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync('src/tests/evidence/WO-1337', { recursive: true })
    writeFileSync('src/tests/evidence/WO-1337/sampleMachine-file-read.json', `${JSON.stringify({
      note: "What interpretGcodeProgram read from SampleMachine's fusion-liencnc-v2-sample.nc, captured by "
        + 'src/tests/machine/helicalArc.wo1337.test.ts (WRITE_EVIDENCE=1). Every number here is '
        + 'also an assertion in that test. Tier 2 desk evidence: NO HELIX HAS FLOWN ON THE BOARD.',
      file: 'src/tests/fixtures/foreign-gcode/fusion-liencnc-v2-sample.nc',
      moveCount: result.program.moveCount,
      sections: result.program.stages.length,
      frames: result.program.frames,
      tools: result.program.tools,
      macros: result.program.macros,
      toolLengthOffsets: result.program.toolLengthOffsets,
      arcs: staged.filter(({ move }) => move.type === 'arc_cw' || move.type === 'arc_ccw').length,
      theArcItUsedToStopOn: staged.find((entry) => entry.line === 31),
      firstFiveMoves: staged.slice(0, 5),
      lastMove: staged[staged.length - 1],
    }, null, 2)}\n`)
  })
})

describe('WO-1337: the two third-party Fusion files read past their home block', () => {
  it.each([
    ['fusion360-issue395-xy.nc', 7],
    ['fusion360-drilling-excerpt.nc', 3],
  ])('%s: line %i is no longer where it stops', (name, homeLine) => {
    const text = readFileSync(`src/tests/fixtures/foreign-gcode/${name}`, 'utf8')

    // WO-1644: WITH NO HOME NAMED it no longer stops at the home block - G28
    // needs no homing and resolves to machine zero.
    const unnamed = interpretGcodeProgram(text, INTERPRET_OPTIONS)
    expect(unnamed.ok, unnamed.ok ? `line ${homeLine}` : unnamed.refusal.message).toBe(true)

    // HOMED, the home block resolves and WO-1357 removes each later invented
    // refusal: G18 arcs are linearised and UCCNC's reset G0 carries the opening
    // G43 Z block. Both ordinary Fusion files now load completely.
    const homed = interpretGcodeProgram(text, { ...INTERPRET_OPTIONS, machineHome: MACHINE_HOME })
    expect(homed.ok).toBe(true)
    if (!homed.ok) return
    expect(homed.program.moveCount).toBeGreaterThan(0)
  })
})
