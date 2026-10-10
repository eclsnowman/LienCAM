// WO-1899: the optimizer's circle/arc fit must check the EDGES, not only the
// corners. An R10 regular octagon has all 8 corners exactly on its
// circumcircle, but every 45deg edge sags r - sqrt(r^2 - c^2/4) = 0.761 mm
// between them, so a vertex-only test turns the octagon into a true circle
// 0.76 mm off where the drawing's edges were (DesignTree "Optimize layer",
// loopOptimizer full-circle detection). Genuinely fine polylines - 360 edges
// on R10, sag ~0.0004 mm - must still convert.

import { describe, it, expect } from 'vitest'
import { optimizeLoops } from '../../lib/geometry/loopOptimizer'
import type { Loop2D, Vec2 } from '../../types'

function loop(points: Vec2[], closed = true): Loop2D {
  return { id: 'L', points, closed, type: 'contour', layerId: 'lay', area: 0 }
}

// Regular n-gon on radius r, first vertex at angle 0.
function regularPolygon(r: number, n: number): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    pts.push({ x: r * Math.cos(a), y: r * Math.sin(a) })
  }
  return pts
}

// The pre-fix criterion: max |dist(corner) - r| over the CORNERS only.
function vertexOnlyErr(pts: Vec2[], r: number): number {
  let max = 0
  for (const p of pts) {
    const d = Math.abs(Math.hypot(p.x, p.y) - r)
    if (d > max) max = d
  }
  return max
}

function hasFullCircleArc(out: Loop2D, r = 10): boolean {
  return (out.segments ?? []).some((s) => s.type === 'arc' && Math.abs(s.radius - r) < 1)
}

describe('WO-1899 loop optimizer checks edges, not only corners', () => {
  it('acceptance 1: R10 regular octagon at 0.01mm tolerance is NOT converted', () => {
    const octagon = regularPolygon(10, 8)
    const [out] = optimizeLoops([loop(octagon)], { tolerance: 0.01 })

    // Every corner is on the circle - the vertex-only test accepted it ...
    expect(vertexOnlyErr(octagon, 10)).toBeLessThan(0.01)
    // ... but every edge sags 0.761mm, so it must not become a circle.
    expect(hasFullCircleArc(out)).toBe(false)
  })

  it('acceptance 2: R10 polygon with 360 edges IS converted (sag ~0.0004mm)', () => {
    const poly = regularPolygon(10, 360)
    const [out] = optimizeLoops([loop(poly)], { tolerance: 0.01 })

    expect(hasFullCircleArc(out)).toBe(true)
  })

  it('acceptance 4 negative control: vertex-only criterion WOULD convert the octagon', () => {
    // Reproduces the pre-fix behaviour in isolation: the old test looked only
    // at corners, so the octagon passed. The edge sag is what disqualifies it.
    const octagon = regularPolygon(10, 8)
    const chord = 2 * 10 * Math.sin(Math.PI / 8)
    const sag = 10 - Math.sqrt(100 - (chord * chord) / 4)
    expect(sag).toBeGreaterThan(0.01)
    expect(vertexOnlyErr(octagon, 10)).toBeLessThan(0.01)
  })

  it('a densely-sampled circle still becomes an arc (no regression for real circles)', () => {
    const circle: Vec2[] = []
    for (let i = 0; i < 64; i++) {
      const a = (2 * Math.PI * i) / 64
      circle.push({ x: 10 * Math.cos(a), y: 10 * Math.sin(a) })
    }
    const [out] = optimizeLoops([loop(circle)], { tolerance: 0.05 })
    expect(hasFullCircleArc(out)).toBe(true)
  })
})
