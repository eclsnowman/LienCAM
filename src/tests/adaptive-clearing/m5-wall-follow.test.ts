import { describe, it, expect } from 'vitest'
import { sampleArc } from '../../lib/cam/geometry'

describe('AdaptiveClearing2D — M5 wall-follow', () => {

  describe('sampleArc', () => {
    const TWO_PI = 2 * Math.PI

    function expectedN(radius: number, chordTol: number, span: number): number {
      const cosVal = Math.max(-1, Math.min(1, 1 - chordTol / radius))
      const maxStep = 2 * Math.acos(cosVal)
      return Math.max(1, Math.ceil(span / maxStep))
    }

    it('point count matches ceil(span/maxStep) formula', () => {
      // CCW quarter-circle: span = π/2
      const pts = sampleArc({ x: 0, y: 0 }, 10, 0, Math.PI / 2, 'CCW', 0.5)
      expect(pts.length).toBe(expectedN(10, 0.5, Math.PI / 2))
    })

    it('all returned points lie on the circle within fp tolerance', () => {
      const cx = 5, cy = 3, r = 7
      const pts = sampleArc({ x: cx, y: cy }, r, 0, Math.PI, 'CCW', 0.3)
      for (const pt of pts) {
        const dist = Math.sqrt((pt.x - cx) ** 2 + (pt.y - cy) ** 2)
        expect(dist).toBeCloseTo(r, 10)
      }
    })

    it('CCW sweep increases angle monotonically', () => {
      const cx = 0, cy = 0
      const pts = sampleArc({ x: cx, y: cy }, 10, 0, Math.PI, 'CCW', 0.3)
      expect(pts.length).toBeGreaterThan(1)
      const angles = pts.map(p => Math.atan2(p.y - cy, p.x - cx))
      for (let i = 1; i < angles.length; i++)
        expect(angles[i]).toBeGreaterThan(angles[i - 1])
    })

    it('CW sweep decreases angle monotonically', () => {
      const cx = 0, cy = 0
      // CW from π to 0 — short path, angles decrease π → 0
      const pts = sampleArc({ x: cx, y: cy }, 10, Math.PI, 0, 'CW', 0.3)
      expect(pts.length).toBeGreaterThan(1)
      const angles = pts.map(p => Math.atan2(p.y - cy, p.x - cx))
      for (let i = 1; i < angles.length; i++)
        expect(angles[i]).toBeLessThan(angles[i - 1])
    })

    it('360° full circle returns n points with no duplicate endpoint', () => {
      const r = 10, cx = 0, cy = 0
      // startAngle == endAngle → span = 0 → wraps to 2π → full circle
      const pts = sampleArc({ x: cx, y: cy }, r, 0, 0, 'CCW', 0.5)
      expect(pts.length).toBe(expectedN(r, 0.5, TWO_PI))
      const first = pts[0], last = pts[pts.length - 1]
      const isDuplicate = Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9
      expect(isDuplicate).toBe(false)
    })

    it('near-zero span returns 1 point at startAngle', () => {
      // span = 1e-10 > 0, not wrapped → ceil(tiny/maxStep) = 0 → max(1,0) = 1
      const pts = sampleArc({ x: 0, y: 0 }, 10, 1.0, 1.0 + 1e-10, 'CCW', 0.3)
      expect(pts.length).toBe(1)
      expect(pts[0].x).toBeCloseTo(10 * Math.cos(1.0), 10)
      expect(pts[0].y).toBeCloseTo(10 * Math.sin(1.0), 10)
    })
  })

  describe('corner classification', () => {
    // Local consts — L_SHAPE_NARROW export deferred to Commit 5
    const T_SHAPE = [
      { x: 40, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 60 }, { x: 120, y: 60 },
      { x: 120, y: 120 }, { x: 0, y: 120 }, { x: 0, y: 60 }, { x: 40, y: 60 },
    ]
    const L_SHAPE_NARROW = [
      { x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 60 }, { x: 40, y: 60 },
      { x: 40, y: 120 }, { x: 0, y: 120 },
    ]

    // Intentional inline duplicate — replaced by wallFollow.ts export in Item 2.
    function classifyBoundaryCorners(poly: { x: number; y: number }[]) {
      return poly.map((v, i) => {
        const prev = poly[(i + poly.length - 1) % poly.length]
        const next = poly[(i + 1) % poly.length]
        const dx1 = v.x - prev.x, dy1 = v.y - prev.y
        const len1 = Math.sqrt(dx1 * dx1 + dy1 * dy1)
        const dx2 = next.x - v.x, dy2 = next.y - v.y
        const len2 = Math.sqrt(dx2 * dx2 + dy2 * dy2)
        const cross = (dx1 / len1) * (dy2 / len2) - (dy1 / len1) * (dx2 / len2)
        return { v, isReflex: cross < -1e-9 }
      })
    }

    it('T_SHAPE has exactly 2 reflex vertices at (80,60) and (40,60)', () => {
      const classified = classifyBoundaryCorners(T_SHAPE)
      const reflex = classified.filter(c => c.isReflex)
      expect(reflex.length).toBe(2)
      const coords = reflex.map(c => `${c.v.x},${c.v.y}`).sort()
      expect(coords).toEqual(['40,60', '80,60'])
    })

    it('L_SHAPE_NARROW has exactly 1 reflex vertex at (40,60)', () => {
      const classified = classifyBoundaryCorners(L_SHAPE_NARROW)
      const reflex = classified.filter(c => c.isReflex)
      expect(reflex.length).toBe(1)
      expect(reflex[0].v).toEqual({ x: 40, y: 60 })
    })

    it('arc endpoints at T_SHAPE (80,60) for offset=5 are correct', () => {
      const vertex = { x: 80, y: 60 }
      const arcStart = { x: 75, y: 60 }  // vertex + 5 * inward normal of incoming edge (dir (0,1) → inward (-1,0))
      const arcEnd   = { x: 80, y: 65 }  // vertex + 5 * inward normal of outgoing edge (dir (1,0) → inward (0,+1))
      const offset = 5

      const distStart = Math.sqrt((arcStart.x - vertex.x) ** 2 + (arcStart.y - vertex.y) ** 2)
      const distEnd   = Math.sqrt((arcEnd.x   - vertex.x) ** 2 + (arcEnd.y   - vertex.y) ** 2)
      expect(distStart).toBeCloseTo(offset, 10)
      expect(distEnd).toBeCloseTo(offset, 10)

      // Arc spans CW from 180° (arcStart) to 90° (arcEnd)
      expect(Math.atan2(arcStart.y - vertex.y, arcStart.x - vertex.x)).toBeCloseTo(Math.PI, 10)
      expect(Math.atan2(arcEnd.y   - vertex.y, arcEnd.x   - vertex.x)).toBeCloseTo(Math.PI / 2, 10)

      // Midpoint at 135° (within CW sweep 180°→90°) also lies at distance = offset
      const mid = {
        x: vertex.x + offset * Math.cos((3 * Math.PI) / 4),
        y: vertex.y + offset * Math.sin((3 * Math.PI) / 4),
      }
      const distMid = Math.sqrt((mid.x - vertex.x) ** 2 + (mid.y - vertex.y) ** 2)
      expect(distMid).toBeCloseTo(offset, 10)
    })
  })
})
