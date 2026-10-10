import { describe, expect, it } from 'vitest'
import { distance, distanceToArcRing, distanceToRing, distanceToSegment, screenToWorld, worldToScreen } from '../../components/sketch3dlab/geometry2d'

describe('sketch3dlab geometry2d', () => {
  it('screenToWorld inverts worldToScreen for arbitrary points', () => {
    for (const p of [{ x: 0, y: 0 }, { x: 40, y: 20 }, { x: -5, y: 12.5 }]) {
      const roundTripped = screenToWorld(worldToScreen(p))
      expect(roundTripped.x).toBeCloseTo(p.x, 9)
      expect(roundTripped.y).toBeCloseTo(p.y, 9)
    }
  })

  it('worldToScreen flips y (world up = screen up)', () => {
    const a = worldToScreen({ x: 0, y: 0 })
    const b = worldToScreen({ x: 0, y: 10 })
    expect(b.y).toBeLessThan(a.y)
  })

  it('distanceToSegment returns 0 on the segment and the perpendicular distance off it', () => {
    const a = { x: 0, y: 0 }
    const b = { x: 10, y: 0 }
    expect(distanceToSegment({ x: 5, y: 0 }, a, b)).toBeCloseTo(0, 9)
    expect(distanceToSegment({ x: 5, y: 3 }, a, b)).toBeCloseTo(3, 9)
    // beyond the endpoint clamps to the endpoint, not the infinite line
    expect(distanceToSegment({ x: 15, y: 0 }, a, b)).toBeCloseTo(5, 9)
  })

  it('distanceToSegment handles a degenerate zero-length segment', () => {
    const a = { x: 3, y: 4 }
    expect(distanceToSegment({ x: 0, y: 0 }, a, a)).toBeCloseTo(5, 9)
  })

  it('distanceToRing is 0 exactly on the ring, positive inside/outside', () => {
    const center = { x: 0, y: 0 }
    expect(distanceToRing({ x: 5, y: 0 }, center, 5)).toBeCloseTo(0, 9)
    expect(distanceToRing({ x: 0, y: 0 }, center, 5)).toBeCloseTo(5, 9)
    expect(distanceToRing({ x: 10, y: 0 }, center, 5)).toBeCloseTo(5, 9)
  })

  it('distanceToArcRing matches distanceToRing (pick tolerance ignores sweep)', () => {
    const arc = { center: { x: 1, y: 1 }, radius: 4, startAngle: 0, endAngle: 1 }
    expect(distanceToArcRing({ x: 5, y: 1 }, arc)).toBeCloseTo(distanceToRing({ x: 5, y: 1 }, arc.center, arc.radius), 9)
  })

  it('distance is symmetric', () => {
    const a = { x: 1, y: 2 }
    const b = { x: 4, y: 6 }
    expect(distance(a, b)).toBeCloseTo(distance(b, a), 9)
    expect(distance(a, b)).toBeCloseTo(5, 9)
  })
})
