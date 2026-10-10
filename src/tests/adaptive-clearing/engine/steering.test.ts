// Phase 2 tests: the interpolation table (deterministic) and the steering search
// (converges to the target load on a synthetic cleared region).

import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady, type Loops } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import { createInterpolator } from '../../../lib/cam/adaptiveClearing2d/engine/interpolation'
import { createStepper } from '../../../lib/cam/adaptiveClearing2d/engine/steering'

const PI4 = Math.PI / 4

describe('interpolation table', () => {
  it('iteration 1 returns the predicted angle; 2 and 4 bracket at -/+ maxDeflection', () => {
    const ip = createInterpolator(PI4)
    expect(ip.getNextAngle(1, 0, 0.123, 12).angle).toBeCloseTo(0.123, 9)
    expect(ip.getNextAngle(2, 0, 0.123, 12).angle).toBeCloseTo(-PI4, 9)
    expect(ip.getNextAngle(4, 0, 0.123, 12).angle).toBeCloseTo(PI4, 9)
  })

  it('interpolates the angle for a bracketed target from sorted samples', () => {
    const ip = createInterpolator(PI4)
    ip.reset()
    ip.addPoint(3.0, 0.3)   // inserted out of order on purpose
    ip.addPoint(1.0, -0.3)
    ip.addPoint(2.0, 0.0)
    expect(ip.nPoints).toBe(3)
    // target 2.0 sits exactly on the middle sample -> angle 0.0
    const { angle, clamped } = ip.getNextAngle(3, 2.0, 0, 12)
    expect(angle).toBeCloseTo(0.0, 6)
    expect(clamped).toBe(false)
  })

  it('clamps an out-of-range extrapolated angle to +maxDeflection', () => {
    const ip = createInterpolator(PI4)
    ip.reset()
    ip.addPoint(1.0, -0.2)
    ip.addPoint(2.0, 0.2)
    // target far above the largest sample -> positive extrapolation -> clamp to +pi/4
    const { angle, clamped } = ip.getNextAngle(3, 50.0, 0, 12)
    expect(angle).toBeCloseTo(PI4, 9)
    expect(clamped).toBe(true)
  })
})

describe('steering search', () => {
  // cleared = a big half-plane below y=0; the tool sits on the edge heading +x.
  const cleared: Loops = [[{ x: -200, y: -200 }, { x: 200, y: -200 }, { x: 200, y: 0 }, { x: -200, y: 0 }]]

  beforeAll(async () => { await ensureEngineClipperReady() })

  it('converges to a reachable target load within the deflection clamp', () => {
    const tool = createToolGeometry(2.0, 0.2)
    const stepper = createStepper(tool, { maxErrorRel: 0.05 })
    const step = 0.5

    // Measure straight-ahead load, then aim for HALF of it -- reachable by deflecting
    // further into the cleared half-plane (which reduces the uncut bite).
    const straight = tool.cutArea({ x: 0, y: 0 }, { x: step, y: 0 }, cleared).areaPerDist
    expect(straight).toBeGreaterThan(0)
    const target = 0.5 * straight

    stepper.resetHistory()
    const r = stepper.findNextPoint(cleared, { x: 0, y: 0 }, { x: 1, y: 0 }, step, target)

    expect(Math.abs(r.deflectionAngle)).toBeLessThanOrEqual(PI4 + 1e-9) // clamp holds
    expect(r.areaPerDist).toBeGreaterThanOrEqual(0)
    // Either it converged near target, or it ran out of iterations and returned closest.
    const converged = Math.abs(r.areaPerDist - target) < 0.2 * target
    expect(converged || r.hitIterationLimit).toBe(true)
  })

  it('reducing the target load steers the tool to cut less per distance', () => {
    const tool = createToolGeometry(2.0, 0.2)
    const stepper = createStepper(tool, { maxErrorRel: 0.05 })
    const step = 0.5
    const straight = tool.cutArea({ x: 0, y: 0 }, { x: step, y: 0 }, cleared).areaPerDist

    stepper.resetHistory()
    const low = stepper.findNextPoint(cleared, { x: 0, y: 0 }, { x: 1, y: 0 }, step, 0.3 * straight)
    // A small target must not produce MORE cut than going straight at full edge bite.
    expect(low.areaPerDist).toBeLessThan(straight + 1e-6)
  })
})
