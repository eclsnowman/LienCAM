// WO-1285: arcs on the geometry route, and the extent check nobody had.
//
// Behavioural, not a grep: the builder emits a native XY arc with its centre
// through the same world->work transform as its end and the direction the
// bridge's measured inversion expects; it refuses by name what has never flown
// (helical, non-planar, a full circle, a malformed circle); the true swept
// extent of an arc is what is checked against the travel, using an arc whose
// ENDS are both inside the table because that is exactly what an endpoint box
// waves through; a program of arcs counts one slot per arc while its chorded
// equivalent blows the cap; and the simulator walks the circle rather than
// the chord, so its own limit trip sees the bulge.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolpathMove, WCS } from '../../types'
import type { ControllerEvents, MachineProgram, QueuedMove } from '../../lib/machine/controller'
import type { MachineEnvelope } from '../../lib/machine/machineEnvelope'
import {
  arcSweep,
  arcSweptBounds,
  buildStraightLineProgram,
  describeTravelOffence,
  firstStepOutsideTravel,
  programSweptBounds,
} from '../../lib/program/buildMachineProgram'
import { assessProgramCapacity } from '../../lib/program/programCapacity'
import { SimulatedController } from '../../lib/machine/simulatedController'

const WCS_ORIGIN = { x: 10, y: 20, z: -5 }
function makeWcs(): WCS {
  return {
    id: 'w1', label: 'G54', fixtureOffset: 54,
    origin: { ...WCS_ORIGIN },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  } as WCS
}
const TRACE = { opId: 'op-1285', setupId: 'setup-1285' }
const RAPID_FEED = 3000

function build(moves: ToolpathMove[]) {
  return buildStraightLineProgram(moves, makeWcs(), RAPID_FEED, TRACE)
}
function expectRefusal(result: ReturnType<typeof build>, ...fragments: string[]): string {
  if (result.ok) throw new Error('expected a refusal, got a program')
  expect(Object.hasOwn(result, 'program')).toBe(false)
  for (const fragment of fragments) expect(result.reason).toContain(fragment)
  return result.reason
}

/** A quarter arc, counter-clockwise about world (30, 20), from (40, 20) to (30, 30). */
const QUARTER_CCW: ToolpathMove[] = [
  { type: 'rapid', x: 40, y: 20, z: 5 },
  { type: 'feed', x: 40, y: 20, z: -3, feed: 300 },
  { type: 'arc_ccw', x: 30, y: 30, z: -3, feed: 800, cx: 30, cy: 20 },
]

describe('WO-1285 builder: an XY arc is emitted natively, never linearised', () => {
  it('emits kind arc with its centre through the same world->work transform as its end, clockwise from arc_cw', () => {
    const result = build([
      { type: 'rapid', x: 40, y: 20, z: 5 },
      { type: 'feed', x: 40, y: 20, z: -3, feed: 300 },
      { type: 'arc_cw', x: 20, y: 20, z: -3, feed: 800, cx: 30, cy: 20 },
    ])
    if (!result.ok) throw new Error(result.reason)
    const steps = result.program.steps.filter((s) => s.kind === 'arc')
    expect(steps).toHaveLength(1)
    const arc = steps[0] as Extract<QueuedMove, { kind: 'arc' }>
    // Work = world - origin, applied to the END and to the CENTRE alike.
    expect(arc.to).toEqual({ x: 20 - 10, y: 20 - 20, z: -3 + 5 })
    expect(arc.centre).toEqual({ x: 30 - 10, y: 20 - 20, z: -3 + 5 })
    expect(arc.clockwise).toBe(true)
    expect(arc.plane).toBe('xy')
    expect(arc.feedMmMin).toBe(800)
    // One slot on the board, three in the program, and the trace names the move.
    expect(result.motionCount).toBe(3)
    expect(result.program.index[arc.id]).toEqual({ opId: 'op-1285', setupId: 'setup-1285', moveOrdinal: 2 })
    // The program's box is arc-aware: this CLOCKWISE semicircle from (40,20) to
    // (20,20) passes (30, 10), world y = 10, work y = -10 - a point no endpoint reaches.
    expect(result.bounds?.min.y).toBeCloseTo(-10, 9)
    expect(result.bounds?.max.y).toBeCloseTo(0, 9)
  })

  it('arc_ccw is counter-clockwise, and nothing is inverted on this side', () => {
    const result = build(QUARTER_CCW)
    if (!result.ok) throw new Error(result.reason)
    const arc = result.program.steps.find((s) => s.kind === 'arc') as Extract<QueuedMove, { kind: 'arc' }>
    expect(arc.clockwise).toBe(false)
  })

  it('refuses an arc with no move before it: where it starts is unknown', () => {
    expectRefusal(build([{ type: 'arc_cw', x: 30, y: 20, z: -3, feed: 800, cx: 20, cy: 20 }]),
      'Move 0', 'arc_cw', 'no move before it')
  })

  // WO-1337 REPLACED THIS ORDER'S HELICAL REFUSAL. It used to read "refuses a
  // helical arc by name: it has never flown". The endpoint Z was always on the
  // wire; WO-1285 declined to use it because no helix had flown, and WO-1337
  // lifted that. The full behaviour is pinned in `helicalArc.wo1337.test.ts`;
  // what stays here is the half of WO-1285 that did not change - a Z ramp
  // rescues NOTHING, so the malformed and full-circle refusals still fire on a
  // helical arc, word for word.
  it('a helical arc is no longer refused, and a Z ramp excuses nothing else (WO-1337)', () => {
    const ok = build([
      { type: 'rapid', x: 40, y: 20, z: 5 },
      { type: 'arc_cw', x: 20, y: 20, z: 1, feed: 800, cx: 30, cy: 20 },
    ])
    expect(ok.ok).toBe(true)
    // Ends not on one circle, and ramping: still malformed.
    expectRefusal(build([
      { type: 'rapid', x: 40, y: 20, z: 5 },
      { type: 'arc_cw', x: 25, y: 20, z: 1, feed: 800, cx: 30, cy: 20 },
    ]), 'Move 1', 'not on one circle', 'malformed')
    // A full TURN of a helix: the XY ends coincide, so it is ambiguous about
    // which way and how far in exactly the way a flat full circle is.
    expectRefusal(build([
      { type: 'rapid', x: 40, y: 20, z: 5 },
      { type: 'arc_cw', x: 40, y: 20, z: 1, feed: 800, cx: 30, cy: 20 },
    ]), 'Move 1', 'start and end coincide', 'full circle')
  })

  it('refuses a full circle: the centre is ambiguous and our post never emits one', () => {
    expectRefusal(build([
      { type: 'rapid', x: 40, y: 20, z: -3 },
      { type: 'arc_cw', x: 40, y: 20, z: -3, feed: 800, cx: 30, cy: 20 },
    ]), 'Move 1', 'start and end coincide', 'full circle')
  })

  it('refuses a malformed arc whose ends are not on one circle, and one with no usable centre, and one of zero radius', () => {
    expectRefusal(build([
      { type: 'rapid', x: 40, y: 20, z: -3 },
      { type: 'arc_cw', x: 25, y: 20, z: -3, feed: 800, cx: 30, cy: 20 },
    ]), 'Move 1', 'not on one circle', 'malformed')
    expectRefusal(build([
      { type: 'rapid', x: 40, y: 20, z: -3 },
      { type: 'arc_cw', x: 20, y: 20, z: -3, feed: 800 },
    ]), 'Move 1', 'no usable centre')
    expectRefusal(build([
      { type: 'rapid', x: 30, y: 20, z: -3 },
      { type: 'arc_cw', x: 30, y: 20.000001, z: -3, feed: 800, cx: 30, cy: 20 },
    ]), 'Move 1', 'zero radius')
  })

  it('still refuses an arc with no feed rather than inventing one', () => {
    expectRefusal(build([
      { type: 'rapid', x: 40, y: 20, z: -3 },
      { type: 'arc_cw', x: 20, y: 20, z: -3, cx: 30, cy: 20 },
    ]), 'Move 1', 'no feed rate', 'never from here')
  })
})

describe('WO-1285 swept extents: the bulge, not the endpoint box', () => {
  it('arcSweep is signed, and coincident ends read as a full turn', () => {
    expect(arcSweep(0, Math.PI / 2, false)).toBeCloseTo(Math.PI / 2, 12)
    expect(arcSweep(0, Math.PI / 2, true)).toBeCloseTo(-3 * Math.PI / 2, 12)
    expect(arcSweep(0, 0, false)).toBeCloseTo(2 * Math.PI, 12)
    expect(arcSweep(0, 0, true)).toBeCloseTo(-2 * Math.PI, 12)
  })

  it('a semicircle whose ends sit on y = 0 bulges to y = radius: the extent the endpoint box cannot see', () => {
    // From (10, 0) to (-10, 0) counter-clockwise about the origin: passes (0, 10).
    const b = arcSweptBounds({ x: 10, y: 0, z: -3 }, { x: -10, y: 0, z: -3 }, { x: 0, y: 0 }, false)
    expect(b.max.y).toBeCloseTo(10, 9)
    expect(b.min.y).toBeCloseTo(0, 9)
    expect(b.min.x).toBeCloseTo(-10, 9)
    expect(b.max.x).toBeCloseTo(10, 9)
    // The same ends clockwise pass (0, -10) instead.
    const c = arcSweptBounds({ x: 10, y: 0, z: -3 }, { x: -10, y: 0, z: -3 }, { x: 0, y: 0 }, true)
    expect(c.min.y).toBeCloseTo(-10, 9)
    expect(c.max.y).toBeCloseTo(0, 9)
  })

  it('a quarter arc that crosses no quadrant extreme is bounded by its ends alone', () => {
    // 30 deg to 60 deg, counter-clockwise, radius 10.
    const from = { x: 10 * Math.cos(Math.PI / 6), y: 10 * Math.sin(Math.PI / 6), z: 0 }
    const to = { x: 10 * Math.cos(Math.PI / 3), y: 10 * Math.sin(Math.PI / 3), z: 0 }
    const b = arcSweptBounds(from, to, { x: 0, y: 0 }, false)
    expect(b.min.x).toBeCloseTo(to.x, 9)
    expect(b.max.x).toBeCloseTo(from.x, 9)
    expect(b.min.y).toBeCloseTo(from.y, 9)
    expect(b.max.y).toBeCloseTo(to.y, 9)
  })

  const ENVELOPE: MachineEnvelope = {
    x: { travelMm: 100, homesToward: 'min', homePositionMm: 0, pulloffMm: 0, min: 0, max: 100 },
    y: { travelMm: 100, homesToward: 'min', homePositionMm: 0, pulloffMm: 0, min: 0, max: 100 },
    z: null,
  }

  it('firstStepOutsideTravel names an arc whose ENDS are both on the table and whose bulge is not', () => {
    // Work frame with the work origin at machine (50, 90): the arc's ends land
    // at machine y = 90 (inside 0..100); its counter-clockwise semicircle of
    // radius 10 sweeps to machine y = 100 exactly (inside) - so widen it: radius
    // 15 sweeps to y = 105, outside, with both ends still at y = 90.
    const result = build([
      { type: 'rapid', x: WCS_ORIGIN.x + 15, y: WCS_ORIGIN.y, z: WCS_ORIGIN.z },
      { type: 'arc_ccw', x: WCS_ORIGIN.x - 15, y: WCS_ORIGIN.y, z: WCS_ORIGIN.z, feed: 500, cx: WCS_ORIGIN.x, cy: WCS_ORIGIN.y },
    ])
    if (!result.ok) throw new Error(result.reason)
    const origin = { x: 50, y: 90 }
    const offence = firstStepOutsideTravel(result.program, origin, ENVELOPE)
    expect(offence).not.toBeNull()
    expect(offence!.kind).toBe('arc')
    expect(offence!.axis).toBe('y')
    expect(offence!.reachesMm).toBeCloseTo(105, 9)
    expect(offence!.bulge).toBe(true)
    const words = describeTravelOffence(offence!, result.program)
    expect(words).toContain('an arc')
    expect(words).toContain('Y 105')
    expect(words).toContain('both of its ends are inside')
    expect(words).toContain('nothing was staged')
    // The endpoint box of the same program says INSIDE: that is the gap.
    const ends = result.program.steps.filter((s) => s.kind === 'line' || s.kind === 'arc')
      .map((s) => (s as Extract<QueuedMove, { kind: 'arc' | 'line' }>).to.y! + origin.y)
    expect(Math.max(...ends)).toBeLessThanOrEqual(100)
    // Swept the other way (clockwise) it bulges to y = 75, inside: no offence.
    const cw = build([
      { type: 'rapid', x: WCS_ORIGIN.x + 15, y: WCS_ORIGIN.y, z: WCS_ORIGIN.z },
      { type: 'arc_cw', x: WCS_ORIGIN.x - 15, y: WCS_ORIGIN.y, z: WCS_ORIGIN.z, feed: 500, cx: WCS_ORIGIN.x, cy: WCS_ORIGIN.y },
    ])
    if (!cw.ok) throw new Error(cw.reason)
    expect(firstStepOutsideTravel(cw.program, origin, ENVELOPE)).toBeNull()
  })

  it('a line is still judged by its end, and an axis with no envelope or no offset is not compared', () => {
    const result = build([{ type: 'rapid', x: WCS_ORIGIN.x + 200, y: WCS_ORIGIN.y, z: 5 }])
    if (!result.ok) throw new Error(result.reason)
    const off = firstStepOutsideTravel(result.program, { x: 0, y: 0 }, ENVELOPE)
    expect(off?.kind).toBe('line')
    expect(off?.axis).toBe('x')
    expect(off?.bulge).toBe(false)
    expect(firstStepOutsideTravel(result.program, { y: 0 }, ENVELOPE)).toBeNull()
    expect(programSweptBounds(result.program)?.max.x).toBeCloseTo(200, 9)
  })
})

describe('WO-1285 capacity: an arc is one slot; its chorded equivalent is the reason not to linearise', () => {
  it('300 arcs measure 300 against the cap, and 64 chords each would measure 19,200 and refuse', () => {
    const arcs: ToolpathMove[] = [{ type: 'rapid', x: 40, y: 20, z: -3 }]
    for (let i = 0; i < 300; i++) {
      // Alternate semicircles about (30, 20): (40,20) -> (20,20) -> (40,20) ...
      const toRight = i % 2 === 1
      arcs.push({ type: 'arc_cw', x: toRight ? 40 : 20, y: 20, z: -3, feed: 800, cx: 30, cy: 20 })
    }
    const built = build(arcs)
    if (!built.ok) throw new Error(built.reason)
    expect(built.motionCount).toBe(301)
    const cap = 4095
    const capacity = assessProgramCapacity(built.program.steps, cap)
    expect(capacity.fits).toBe(true)
    expect(capacity.count).toBe(301)
    // The chorded equivalent: 64 lines per arc, and none of them a rapid to split at.
    const chords: ToolpathMove[] = [{ type: 'rapid', x: 40, y: 20, z: -3 }]
    for (let i = 0; i < 300 * 64; i++) chords.push({ type: 'feed', x: 30 + 10 * Math.cos(i / 64), y: 20 + 10 * Math.sin(i / 64), z: -3, feed: 800 })
    const chorded = build(chords)
    if (!chorded.ok) throw new Error(chorded.reason)
    const chordCapacity = assessProgramCapacity(chorded.program.steps, cap)
    expect(chordCapacity.count).toBe(19201)
    expect(chordCapacity.fits).toBe(false)
    expect(chordCapacity.parts).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The simulator draws the true arc
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

describe('WO-1285 simulator: walks the circle, not the chord', () => {
  let ev: ControllerEvents
  let controller: SimulatedController
  beforeEach(() => {
    vi.useFakeTimers()
    ev = events()
    controller = new SimulatedController(ev, { travelMm: { x: 100, y: 100, z: 50 }, homeConvention: HOME })
  })
  afterEach(async () => {
    await controller.disconnect?.()
    vi.useRealTimers()
  })

  async function connectAndHome(): Promise<void> {
    await controller.connect({ kind: 'none' })
    await vi.advanceTimersByTimeAsync(2000)
  }

  it('the mid-point of a quarter arc lies on the circle, not on the chord', async () => {
    await connectAndHome()
    // Approach to (60, 30), then a counter-clockwise quarter arc about (30, 30) to (30, 60).
    const steps: QueuedMove[] = [
      { id: 1, kind: 'line', to: { x: 60, y: 30, z: 10 }, feedMmMin: 60000, rapid: true },
      { id: 2, kind: 'arc', to: { x: 30, y: 60, z: 10 }, centre: { x: 30, y: 30, z: 10 }, clockwise: false, plane: 'xy', feedMmMin: 6000 },
    ]
    expect(controller.loadProgram(program(steps))).toEqual({ ok: true, reason: null })
    expect(controller.startJob()).toBe(true)
    // The line finishes within a few ticks; then watch the arc.
    let sawArcMid = false
    let worstRadiusError = 0
    for (let t = 0; t < 400; t++) {
      await vi.advanceTimersByTimeAsync(50)
      const p = controller.status().machinePos
      if (!p) continue
      if (controller.programProgress().executingId === 2) {
        const r = Math.hypot(p.x - 30, p.y - 30)
        worstRadiusError = Math.max(worstRadiusError, Math.abs(r - 30))
        // Half-way round the quarter: (30 + 30 cos45, 30 + 30 sin45) = (51.2, 51.2), which the chord (60,30)->(30,60) never visits.
        if (Math.abs(p.x - 51.213) < 1.5 && Math.abs(p.y - 51.213) < 1.5) sawArcMid = true
      }
      if (controller.programProgress().lastCompletedId === 2) break
    }
    expect(sawArcMid).toBe(true)
    expect(worstRadiusError).toBeLessThan(0.01)
    expect(controller.status().machinePos).toMatchObject({ x: 30, y: 60 })
  })

  it('a bulge past the table is refused before the run starts, although both ends are inside', async () => {
    await connectAndHome()
    // Ends at (80, 90) and (20, 90): inside a 100 mm table. The counter-clockwise semicircle about (50, 90) sweeps to y = 120.
    const steps: QueuedMove[] = [
      { id: 1, kind: 'line', to: { x: 80, y: 90, z: 10 }, feedMmMin: 60000, rapid: true },
      { id: 2, kind: 'arc', to: { x: 20, y: 90, z: 10 }, centre: { x: 50, y: 90, z: 10 }, clockwise: false, plane: 'xy', feedMmMin: 6000 },
    ]
    expect(controller.loadProgram(program(steps))).toEqual({ ok: true, reason: null })
    expect(controller.startJob()).toBe(false)
    expect(ev.onAlarm).toHaveBeenCalledWith(null, expect.stringMatching(/step 2.*sweeps outside.*both of its ends are inside/), false)
    expect(controller.status().state).toBe('alarm')
  })

  it('refuses a non-XY plane by name at load', async () => {
    await connectAndHome()
    const steps: QueuedMove[] = [
      { id: 1, kind: 'arc', to: { x: 20, y: 30, z: 10 }, centre: { x: 30, y: 30, z: 10 }, clockwise: false, plane: 'xz', feedMmMin: 6000 },
    ]
    const outcome = controller.loadProgram(program(steps))
    expect(outcome.ok).toBe(false)
    expect(outcome.reason).toMatch(/XZ plane/)
    expect(outcome.reason).toMatch(/only XY arcs have flown/)
  })
})
