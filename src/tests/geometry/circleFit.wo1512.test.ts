import { describe, it, expect } from 'vitest'
import { fitCircle, centroid } from '../../lib/cam/geometry'
import type { Vec2 } from '../../types'

// An unevenly sampled circle: dense on one arc (near angle 0), sparse on the
// opposite arc (near angle PI). centroid() is biased toward the dense side;
// fitCircle() must not be.
function unevenCircle(cx: number, cy: number, r: number): Vec2[] {
  const pts: Vec2[] = []
  // Dense arc: 40 points packed into a 60deg wedge around angle 0.
  for (let i = 0; i < 40; i++) {
    const a = (-Math.PI / 6) + (i / 39) * (Math.PI / 3)
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  // Sparse arc: 5 points spread across the remaining 300deg.
  for (let i = 0; i < 5; i++) {
    const a = (Math.PI / 6) + (i / 4) * (2 * Math.PI - Math.PI / 3)
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

function evenCircle(cx: number, cy: number, r: number, n: number): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

describe('fitCircle', () => {
  it('resolves the analytic center of an unevenly sampled circle, unlike centroid()', () => {
    const cx = 12.5, cy = -3.2, r = 6
    const pts = unevenCircle(cx, cy, r)

    const fit = fitCircle(pts)
    expect(fit.center.x).toBeCloseTo(cx, 3)
    expect(fit.center.y).toBeCloseTo(cy, 3)
    expect(fit.radius).toBeCloseTo(r, 3)
    expect(fit.residual).toBeLessThan(0.000256)

    // The old primitive is measurably biased away from the true center on
    // this same sample set - this is BUG-417.
    const biased = centroid(pts)
    const bias = Math.hypot(biased.x - cx, biased.y - cy)
    expect(bias).toBeGreaterThan(0.05)
  })

  it('resolves the same center for the same physical circle at different sample density', () => {
    const cx = -4, cy = 9, r = 10
    const sparse = fitCircle(evenCircle(cx, cy, r, 9))
    const dense = fitCircle(evenCircle(cx, cy, r, 200))
    const uneven = fitCircle(unevenCircle(cx, cy, r))

    for (const fit of [sparse, dense, uneven]) {
      expect(fit.center.x).toBeCloseTo(cx, 3)
      expect(fit.center.y).toBeCloseTo(cy, 3)
      expect(fit.radius).toBeCloseTo(r, 3)
    }
  })

  it('reports a large residual for a genuinely non-circular loop (square)', () => {
    const square: Vec2[] = [
      { x: -5, y: -5 }, { x: 0, y: -5 }, { x: 5, y: -5 },
      { x: 5, y: 0 }, { x: 5, y: 5 },
      { x: 0, y: 5 }, { x: -5, y: 5 },
      { x: -5, y: 0 },
    ]
    const fit = fitCircle(square)
    expect(fit.residual).toBeGreaterThan(0.3)
  })

  it('is independent of absolute position far from the origin (WCS offset)', () => {
    const r = 4
    const near = fitCircle(unevenCircle(0, 0, r))
    const far = fitCircle(unevenCircle(10000, -5000, r))
    expect(far.radius).toBeCloseTo(near.radius, 6)
    expect(far.residual).toBeCloseTo(near.residual, 6)
    expect(far.center.x).toBeCloseTo(10000, 3)
    expect(far.center.y).toBeCloseTo(-5000, 3)
  })

  it('returns an infinite residual for degenerate input (fewer than 3 points)', () => {
    expect(fitCircle([]).residual).toBe(Infinity)
    expect(fitCircle([{ x: 1, y: 1 }]).residual).toBe(Infinity)
    expect(fitCircle([{ x: 1, y: 1 }, { x: 2, y: 2 }]).residual).toBe(Infinity)
  })

  it('returns an infinite residual for collinear points', () => {
    const line: Vec2[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]
    expect(fitCircle(line).residual).toBe(Infinity)
  })
})
