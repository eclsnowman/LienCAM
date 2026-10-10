// Unit tests for the pure contour tab-placement math (Tabs v2): the
// pointer -> arc-position projection the viewport edit mode uses, the
// fraction -> point sampling markers render with, the even-spacing seed, and
// the minimum-separation (overlap) gate. No THREE, no WebGL - plain {x, y}.

import { describe, expect, it } from 'vitest'
import {
  closestArcPosition,
  pointAtFraction,
  evenTabFractions,
  isTabFractionFree,
  polylineCumulative,
} from '../../lib/viewport/tabPlacement'

// 10 x 10 square, CCW from the origin: perimeter 40, seam at (0,0).
const square = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
]

describe('tabPlacement - polylineCumulative', () => {
  it('closes the loop and reports the full perimeter', () => {
    const { cumulative, perimeter } = polylineCumulative(square)
    expect(perimeter).toBeCloseTo(40, 12)
    expect(cumulative).toHaveLength(5)
    expect(cumulative[0]).toBe(0)
    expect(cumulative[4]).toBeCloseTo(40, 12)
  })
})

describe('tabPlacement - closestArcPosition (pointer -> arc projection)', () => {
  it('projects onto the nearest segment interior', () => {
    const arc = closestArcPosition(square, { x: 5, y: -3 })!
    expect(arc.point.x).toBeCloseTo(5, 9)
    expect(arc.point.y).toBeCloseTo(0, 9)
    expect(arc.distance).toBeCloseTo(5, 9)
    expect(arc.fraction).toBeCloseTo(0.125, 9)
    expect(arc.euclidean).toBeCloseTo(3, 9)
  })

  it('projects onto later segments with the correct cumulative distance', () => {
    const arc = closestArcPosition(square, { x: 12, y: 5 })!
    expect(arc.point.x).toBeCloseTo(10, 9)
    expect(arc.point.y).toBeCloseTo(5, 9)
    expect(arc.distance).toBeCloseTo(15, 9)
    expect(arc.fraction).toBeCloseTo(0.375, 9)
  })

  it('handles the implicit closing segment (last vertex back to the seam)', () => {
    const arc = closestArcPosition(square, { x: -4, y: 5 })!
    expect(arc.point.x).toBeCloseTo(0, 9)
    expect(arc.point.y).toBeCloseTo(5, 9)
    expect(arc.fraction).toBeCloseTo(0.875, 9)
  })

  it('wraps a projection landing exactly on the seam to fraction 0', () => {
    const arc = closestArcPosition(square, { x: -1, y: -1 })!
    expect(arc.point.x).toBeCloseTo(0, 9)
    expect(arc.point.y).toBeCloseTo(0, 9)
    expect(arc.fraction).toBeCloseTo(0, 9)
    expect(arc.fraction).toBeLessThan(1)
  })

  it('refuses degenerate input', () => {
    expect(closestArcPosition([{ x: 1, y: 1 }], { x: 0, y: 0 })).toBeNull()
    expect(closestArcPosition([{ x: 1, y: 1 }, { x: 1, y: 1 }], { x: 0, y: 0 })).toBeNull()
  })
})

describe('tabPlacement - pointAtFraction (marker rendering)', () => {
  it('samples the closed polyline at a fraction of its perimeter', () => {
    expect(pointAtFraction(square, 0.125)).toEqual({ x: 5, y: 0 })
    const p = pointAtFraction(square, 0.375)
    expect(p.x).toBeCloseTo(10, 9)
    expect(p.y).toBeCloseTo(5, 9)
  })

  it('wraps fractions outside [0, 1)', () => {
    const atOne = pointAtFraction(square, 1.0)
    expect(atOne.x).toBeCloseTo(0, 9)
    expect(atOne.y).toBeCloseTo(0, 9)
    const negative = pointAtFraction(square, -0.125)
    expect(negative.x).toBeCloseTo(0, 9)
    expect(negative.y).toBeCloseTo(5, 9)
  })

  it('round-trips with closestArcPosition', () => {
    for (const f of [0.1, 0.33, 0.5, 0.77, 0.99]) {
      const p = pointAtFraction(square, f)
      const arc = closestArcPosition(square, p)!
      expect(arc.fraction).toBeCloseTo(f, 9)
      expect(arc.euclidean).toBeLessThan(1e-9)
    }
  })
})

describe('tabPlacement - evenTabFractions (seed for first edit)', () => {
  it('matches the engine default centers (i + 0.5) / count', () => {
    expect(evenTabFractions(4)).toEqual([0.125, 0.375, 0.625, 0.875])
    expect(evenTabFractions(1)).toEqual([0.5])
  })

  it('clamps a degenerate count to one tab', () => {
    expect(evenTabFractions(0)).toEqual([0.5])
  })
})

describe('tabPlacement - isTabFractionFree (engine overlap rule mirror)', () => {
  const fractions = [0.1, 0.5]

  it('refuses a new tab closer than the minimum separation', () => {
    expect(isTabFractionFree(fractions, null, 0.13, 0.05)).toBe(false)
    expect(isTabFractionFree(fractions, null, 0.2, 0.05)).toBe(true)
  })

  it('measures separation CIRCULARLY across the seam', () => {
    expect(isTabFractionFree([0.02], null, 0.99, 0.05)).toBe(false)
    expect(isTabFractionFree([0.02], null, 0.9, 0.05)).toBe(true)
  })

  it('excludes the dragged tab itself', () => {
    // Moving index 0 slightly is legal even though it is near its own old spot.
    expect(isTabFractionFree(fractions, 0, 0.12, 0.05)).toBe(true)
    // ...but still cannot approach the OTHER tab.
    expect(isTabFractionFree(fractions, 0, 0.47, 0.05)).toBe(false)
  })
})
