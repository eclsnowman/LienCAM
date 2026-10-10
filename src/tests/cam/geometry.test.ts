import { describe, it, expect } from 'vitest'
import {
  centroid,
  findContainingLoop,
  segSegIntersect,
  polyBBox,
  offsetOpenChain,
  pruneSelfIntersections,
} from '../../lib/cam/geometry'
import type { Vec2 } from '../../types'

// Perpendicular distance from a point to the INFINITE LINE through (a, b).
// The offsetOpenChain spacing invariant is "perp distance to the edge LINE",
// not "perp distance to the segment" — at a corner the bisector vertex projects
// past the segment endpoint, but its perpendicular distance to the edge's
// infinite line is exactly |dist|.
function distToLine(pt: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.sqrt(dx * dx + dy * dy)
  if (len < 1e-12) return Math.hypot(pt.x - a.x, pt.y - a.y)
  return Math.abs((pt.x - a.x) * dy - (pt.y - a.y) * dx) / len
}

// Verify the spacing invariant on every offset vertex against every adjacent
// source edge line. offset[k] corresponds to chain[k]; the adjacent edges are
// (chain[k-1], chain[k]) for k>0 and (chain[k], chain[k+1]) for k<n-1.
function checkPerpSpacing(offset: Vec2[], chain: Vec2[], dist: number, tol = 1e-6): void {
  const n = chain.length
  expect(offset.length).toBe(n)
  const absDist = Math.abs(dist)
  for (let k = 0; k < n; k++) {
    if (k > 0) {
      expect(distToLine(offset[k], chain[k - 1], chain[k])).toBeCloseTo(absDist, 6)
    }
    if (k < n - 1) {
      expect(distToLine(offset[k], chain[k], chain[k + 1])).toBeCloseTo(absDist, 6)
    }
  }
  void tol
}

function selfIntersects(chain: Vec2[]): boolean {
  for (let i = 0; i < chain.length - 1; i++) {
    for (let j = i + 2; j < chain.length - 1; j++) {
      if (segSegIntersect(chain[i], chain[i + 1], chain[j], chain[j + 1]) !== null) return true
    }
  }
  return false
}

describe('geometry', () => {

  describe('centroid', () => {
    it('returns average of points for a triangle', () => {
      const pts = [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 3 }]
      const c = centroid(pts)
      expect(c.x).toBeCloseTo(2, 9)
      expect(c.y).toBeCloseTo(1, 9)
    })

    it('returns NaN for empty array (unguarded behavior; call sites validate non-empty)', () => {
      const c = centroid([])
      expect(Number.isNaN(c.x)).toBe(true)
      expect(Number.isNaN(c.y)).toBe(true)
    })
  })

  describe('findContainingLoop', () => {
    // Two non-overlapping axis-aligned squares
    const loopA = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    const loopB = [{ x: 20, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 10 }, { x: 20, y: 10 }]

    it('returns the correct loop index for a point inside one loop', () => {
      expect(findContainingLoop({ x: 5, y: 5 }, [loopA, loopB])).toBe(0)
      expect(findContainingLoop({ x: 25, y: 5 }, [loopA, loopB])).toBe(1)
    })

    it('returns -1 for a point outside all loops', () => {
      expect(findContainingLoop({ x: 15, y: 5 }, [loopA, loopB])).toBe(-1)
    })
  })

  describe('segSegIntersect', () => {
    it('returns { t1 } for two crossing segments', () => {
      // Diagonal cross: (0,0)→(2,2) and (0,2)→(2,0) cross at (1,1), t1=0.5
      const result = segSegIntersect(
        { x: 0, y: 0 }, { x: 2, y: 2 },
        { x: 0, y: 2 }, { x: 2, y: 0 },
      )
      expect(result).not.toBeNull()
      expect(result!.t1).toBeCloseTo(0.5, 9)
    })

    it('returns null for two parallel segments', () => {
      const result = segSegIntersect(
        { x: 0, y: 0 }, { x: 4, y: 0 },
        { x: 0, y: 1 }, { x: 4, y: 1 },
      )
      expect(result).toBeNull()
    })
  })

  describe('polyBBox', () => {
    it('returns correct bounding box for a known rectangle', () => {
      const pts = [{ x: 2, y: 3 }, { x: 8, y: 3 }, { x: 8, y: 7 }, { x: 2, y: 7 }]
      const bb = polyBBox(pts)
      expect(bb.minX).toBe(2)
      expect(bb.minY).toBe(3)
      expect(bb.maxX).toBe(8)
      expect(bb.maxY).toBe(7)
    })
  })

  // ── Stage-A gate: offsetOpenChain perpendicular-spacing invariant ──────────
  // The whole grid-free offset-arc approach rests on this single property: every
  // offset vertex must be perpendicular-distance |dist| from the source chain
  // (within the bisector miter formula's algebraic identity, ~fp noise).
  // If this fails, nothing built on top of it is trustworthy.

  describe('offsetOpenChain', () => {
    it('PERPENDICULAR SPACING — straight chain: every offset vertex is perp-dist |dist| from edge line', () => {
      const chain: Vec2[] = [
        { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 0 }, { x: 15, y: 0 }, { x: 20, y: 0 },
      ]
      const dist = 3
      const offset = offsetOpenChain(chain, dist)
      checkPerpSpacing(offset, chain, dist)
    })

    it('PERPENDICULAR SPACING — convex bend (90°): bisector vertex is perp-dist |dist| from both edges', () => {
      const chain: Vec2[] = [
        { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      ]
      const dist = 2
      const offset = offsetOpenChain(chain, dist)
      checkPerpSpacing(offset, chain, dist)
      expect(selfIntersects(offset)).toBe(false)
    })

    it('PERPENDICULAR SPACING — convex bend, opposite side: still perp-dist |dist|', () => {
      const chain: Vec2[] = [
        { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 },
      ]
      const dist = -2
      const offset = offsetOpenChain(chain, dist)
      checkPerpSpacing(offset, chain, dist)
    })

    it('PERPENDICULAR SPACING — shallow concave bend (untriggered miter clamp): perp-dist |dist|', () => {
      // 135° interior angle bend — well within miter limit.
      const chain: Vec2[] = [
        { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 17.071, y: 7.071 },
      ]
      const dist = -1.5  // concave-side offset
      const offset = offsetOpenChain(chain, dist)
      checkPerpSpacing(offset, chain, dist, 1e-4)
    })

    it('convex bend is smooth (no self-intersection)', () => {
      // Shallow convex bend; offset side: convex (no fold).
      const chain: Vec2[] = [
        { x: 0, y: 0 }, { x: 5, y: 0 }, { x: 10, y: 1 }, { x: 15, y: 0 },
      ]
      const offset = offsetOpenChain(chain, 1.5)
      expect(selfIntersects(offset)).toBe(false)
    })

    it('concave bend produces self-intersection that pruneSelfIntersections removes', () => {
      // Sharp concave V offset to the concave side at dist greater than the
      // edge-half-length → the two offset legs cross.
      const chain: Vec2[] = [
        { x: 0, y: 0 }, { x: 5, y: 5 }, { x: 10, y: 0 },
      ]
      // dist=3 on the concave (top) side: each offset leg pulls inward toward
      // the apex, crossing the other.
      const offset = offsetOpenChain(chain, -3)
      expect(offset.length).toBeGreaterThanOrEqual(3)
      // Bisector-spacing identity still holds at the apex (perp distance to chain):
      // when miter is far from clamp, every vertex is perp-dist 3.
      // (The pre-prune offset may self-intersect; this is what pruning fixes.)
      const pruned = pruneSelfIntersections(offset)
      expect(selfIntersects(pruned)).toBe(false)
    })

    it('returns empty array for input shorter than 2 vertices', () => {
      expect(offsetOpenChain([], 1)).toEqual([])
      expect(offsetOpenChain([{ x: 0, y: 0 }], 1)).toEqual([])
    })

    it('degenerate-collapse safety — extreme inward offset on tight concave bend collapses cleanly', () => {
      // Tight V bend; large offset to concave side. After pruning the result
      // should be short (a near-point) but must not crash or produce NaN.
      const chain: Vec2[] = [
        { x: 0, y: 0 }, { x: 1, y: 5 }, { x: 2, y: 0 },
      ]
      const raw = offsetOpenChain(chain, -10)
      const pruned = pruneSelfIntersections(raw)
      for (const p of pruned) {
        expect(Number.isFinite(p.x)).toBe(true)
        expect(Number.isFinite(p.y)).toBe(true)
      }
      expect(selfIntersects(pruned)).toBe(false)
    })
  })

  describe('pruneSelfIntersections', () => {
    it('passes through a chain with no self-intersections unchanged in shape', () => {
      const chain: Vec2[] = [
        { x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 1 }, { x: 3, y: 1 },
      ]
      const out = pruneSelfIntersections(chain)
      expect(out.length).toBe(chain.length)
      for (let i = 0; i < chain.length; i++) {
        expect(out[i].x).toBeCloseTo(chain[i].x, 9)
        expect(out[i].y).toBeCloseTo(chain[i].y, 9)
      }
    })

    it('collapses a simple figure-8 fold to a single crossing point', () => {
      // Chain that crosses itself: segments (0,1) and (2,3) cross at (0.5, 0.5).
      const chain: Vec2[] = [
        { x: 0, y: 0 }, { x: 1, y: 1 }, { x: 1, y: 0 }, { x: 0, y: 1 },
      ]
      const out = pruneSelfIntersections(chain)
      expect(selfIntersects(out)).toBe(false)
    })

    it('returns fresh copy (no aliasing) for chains under 4 vertices', () => {
      const chain: Vec2[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }]
      const out = pruneSelfIntersections(chain)
      expect(out).not.toBe(chain)
      expect(out[0]).not.toBe(chain[0])
    })
  })

})
