import { describe, it, expect } from 'vitest'
import { fitCircle, maxRadialDeviation, sweepAngle } from '../../lib/post/arcfit/circleFit'
import { douglasPeucker } from '../../lib/post/arcfit/simplify'
import type { Vec2 } from '../../types'

function sampleCircle(cx: number, cy: number, r: number, count: number, a0 = 0, a1 = 2 * Math.PI): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i < count; i++) {
    const t = a0 + ((a1 - a0) * i) / (count - 1)
    pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) })
  }
  return pts
}

describe('fitCircle', () => {
  it('recovers a known circle from sampled points', () => {
    const pts = sampleCircle(10, 5, 8, 12)
    const fit = fitCircle(pts)
    expect(fit).not.toBeNull()
    expect(fit!.cx).toBeCloseTo(10, 6)
    expect(fit!.cy).toBeCloseTo(5, 6)
    expect(fit!.r).toBeCloseTo(8, 6)
  })

  it('returns null for 3 collinear points', () => {
    const pts: Vec2[] = [
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 2, y: 2 },
    ]
    expect(fitCircle(pts)).toBeNull()
  })

  it('returns null for fewer than 3 points', () => {
    expect(fitCircle([])).toBeNull()
    expect(fitCircle([{ x: 0, y: 0 }])).toBeNull()
    expect(fitCircle([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBeNull()
  })
})

describe('maxRadialDeviation', () => {
  it('is ~0 for perfect-circle samples', () => {
    const pts = sampleCircle(10, 5, 8, 12)
    expect(maxRadialDeviation(pts, 10, 5, 8)).toBeCloseTo(0, 9)
  })

  it('is positive when a point is perturbed off the circle', () => {
    const pts = sampleCircle(0, 0, 5, 8)
    pts[3] = { x: pts[3].x + 0.5, y: pts[3].y }
    expect(maxRadialDeviation(pts, 0, 0, 5)).toBeGreaterThan(0)
  })
})

describe('sweepAngle', () => {
  it('measures a quarter circle ccw as ~pi/2', () => {
    const start: Vec2 = { x: 1, y: 0 }
    const end: Vec2 = { x: 0, y: 1 }
    expect(sweepAngle(start, end, 0, 0, 'ccw')).toBeCloseTo(Math.PI / 2, 9)
  })

  it('measures the same endpoints cw as ~3*pi/2 (complement)', () => {
    const start: Vec2 = { x: 1, y: 0 }
    const end: Vec2 = { x: 0, y: 1 }
    expect(sweepAngle(start, end, 0, 0, 'cw')).toBeCloseTo((3 * Math.PI) / 2, 9)
  })

  it('measures a 3/4 span ccw correctly', () => {
    const start: Vec2 = { x: 1, y: 0 }
    const end: Vec2 = { x: 0, y: -1 } // 270 deg ccw from start
    expect(sweepAngle(start, end, 0, 0, 'ccw')).toBeCloseTo((3 * Math.PI) / 2, 9)
  })
})

describe('douglasPeucker', () => {
  it('collapses a straight collinear run to its 2 endpoints', () => {
    const pts: Vec2[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 0 },
      { x: 3, y: 0 },
      { x: 4, y: 0 },
    ]
    const out = douglasPeucker(pts, 0.01)
    expect(out).toHaveLength(2)
    expect(out[0]).toEqual({ x: 0, y: 0 })
    expect(out[1]).toEqual({ x: 4, y: 0 })
  })

  it('keeps the middle corner of a clear zig-zag', () => {
    const pts: Vec2[] = [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 2, y: 5 }, // sharp corner, far off the 0,0 -> 4,0 chord
      { x: 3, y: 0 },
      { x: 4, y: 0 },
    ]
    const out = douglasPeucker(pts, 0.5)
    expect(out).toContainEqual({ x: 2, y: 5 })
    expect(out[0]).toEqual({ x: 0, y: 0 })
    expect(out[out.length - 1]).toEqual({ x: 4, y: 0 })
  })

  it('returns <=2 points as-is (copied)', () => {
    const single: Vec2[] = [{ x: 1, y: 2 }]
    expect(douglasPeucker(single, 0.1)).toEqual(single)
    const pair: Vec2[] = [{ x: 0, y: 0 }, { x: 1, y: 1 }]
    expect(douglasPeucker(pair, 0.1)).toEqual(pair)
  })
})
