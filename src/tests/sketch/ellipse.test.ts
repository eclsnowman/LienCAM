// Pure ellipse geometry (Tier 2a). Headless unit coverage of the
// ellipse.ts module: point-at-parameter, tessellation, bounds, quadrants,
// rotation correctness, and nearest-point projection.

import { describe, it, expect } from 'vitest'
import {
  ellipsePointAt,
  ellipseDerivativeAt,
  tessellateEllipse,
  tessellateEllipticalArc,
  ellipticalArcSweep,
  ellipseQuadrants,
  ellipseBounds,
  ellipsePerimeter,
  nearestPointOnEllipse,
  distanceToEllipticalArc,
  ellipseFoci,
  type EllipseShape,
} from '../../lib/sketch/ellipse'

const HALF_PI = Math.PI / 2

// Axis-aligned 2:1 ellipse centered at origin (a=10, b=5).
const E: EllipseShape = { center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0 }
// Same shape rotated 90 deg (major axis now along +Y).
const E90: EllipseShape = { ...E, rotation: HALF_PI }
// Offset rotated ellipse for the harder cases.
const EOFF: EllipseShape = { center: { x: 3, y: -2 }, majorRadius: 8, minorRadius: 3, rotation: Math.PI / 6 }

const close = (a: number, b: number, eps = 1e-9) => Math.abs(a - b) <= eps

describe('ellipsePointAt (axis-aligned)', () => {
  it('t=0 -> +major-axis vertex', () => {
    const p = ellipsePointAt(E, 0)
    expect(close(p.x, 10)).toBe(true)
    expect(close(p.y, 0)).toBe(true)
  })
  it('t=90deg -> +minor-axis co-vertex', () => {
    const p = ellipsePointAt(E, HALF_PI)
    expect(close(p.x, 0)).toBe(true)
    expect(close(p.y, 5)).toBe(true)
  })
  it('t=180deg -> -major-axis vertex', () => {
    const p = ellipsePointAt(E, Math.PI)
    expect(close(p.x, -10)).toBe(true)
    expect(close(p.y, 0)).toBe(true)
  })
  it('t=270deg -> -minor-axis co-vertex', () => {
    const p = ellipsePointAt(E, (3 * Math.PI) / 2)
    expect(close(p.x, 0)).toBe(true)
    expect(close(p.y, -5)).toBe(true)
  })
})

describe('WO-207 ellipse native fillet differential geometry', () => {
  it('returns a non-degenerate tangent perpendicular to the ellipse normal', () => {
    const t = 0.73
    const d = ellipseDerivativeAt(EOFF, t)
    const c = Math.cos(EOFF.rotation), s = Math.sin(EOFF.rotation)
    const localNormal = { x: Math.cos(t) / EOFF.majorRadius, y: Math.sin(t) / EOFF.minorRadius }
    const normal = { x: localNormal.x * c - localNormal.y * s, y: localNormal.x * s + localNormal.y * c }
    expect(Math.hypot(d.x, d.y)).toBeGreaterThan(0)
    expect(d.x * normal.x + d.y * normal.y).toBeCloseTo(0, 10)
  })
})

describe('ellipsePointAt (rotated 90deg)', () => {
  it('t=0 -> major now along +Y', () => {
    const p = ellipsePointAt(E90, 0)
    expect(close(p.x, 0)).toBe(true)
    expect(close(p.y, 10)).toBe(true)
  })
  it('t=90deg -> minor now along -X', () => {
    const p = ellipsePointAt(E90, HALF_PI)
    expect(close(p.x, -5)).toBe(true)
    expect(close(p.y, 0)).toBe(true)
  })
})

describe('ellipsePointAt (translated center)', () => {
  it('adds the center offset', () => {
    const e: EllipseShape = { center: { x: 7, y: 11 }, majorRadius: 4, minorRadius: 2, rotation: 0 }
    const p = ellipsePointAt(e, 0)
    expect(close(p.x, 11)).toBe(true)
    expect(close(p.y, 11)).toBe(true)
  })
  it('every parametric point satisfies the canonical ellipse equation', () => {
    // In the local frame, (x'/a)^2 + (y'/b)^2 == 1.
    for (let i = 0; i < 12; i++) {
      const t = (i / 12) * Math.PI * 2
      const p = ellipsePointAt(EOFF, t)
      const c = Math.cos(EOFF.rotation), s = Math.sin(EOFF.rotation)
      const dx = p.x - EOFF.center.x, dy = p.y - EOFF.center.y
      const xl = dx * c + dy * s   // R^T (rotate back)
      const yl = -dx * s + dy * c
      const v = (xl / EOFF.majorRadius) ** 2 + (yl / EOFF.minorRadius) ** 2
      expect(close(v, 1, 1e-9)).toBe(true)
    }
  })
})

describe('quadrants & bounds', () => {
  it('returns the four vertices/co-vertices in order', () => {
    const q = ellipseQuadrants(E)
    const want = [[10, 0], [0, 5], [-10, 0], [0, -5]]
    q.forEach((p, i) => {
      expect(close(p.x, want[i][0])).toBe(true)
      expect(close(p.y, want[i][1])).toBe(true)
    })
  })
  it('axis-aligned bounds equal +/- the radii', () => {
    const b = ellipseBounds(E)
    expect(close(b.minX, -10)).toBe(true)
    expect(close(b.maxX, 10)).toBe(true)
    expect(close(b.minY, -5)).toBe(true)
    expect(close(b.maxY, 5)).toBe(true)
  })
  it('rotated-90 bounds swap the extents', () => {
    const b = ellipseBounds(E90)
    expect(close(b.maxX, 5)).toBe(true)
    expect(close(b.maxY, 10)).toBe(true)
  })
  it('a circle (a==b) perimeter matches 2*pi*r', () => {
    expect(close(ellipsePerimeter(5, 5), 2 * Math.PI * 5, 1e-6)).toBe(true)
  })
})

describe('tessellation', () => {
  it('full ellipse closes (last point == first point)', () => {
    const pts = tessellateEllipse(E)
    expect(pts.length).toBeGreaterThan(8)
    expect(close(pts[0].x, pts[pts.length - 1].x)).toBe(true)
    expect(close(pts[0].y, pts[pts.length - 1].y)).toBe(true)
  })
  it('every tessellated point lies on the curve (canonical eq ~ 1)', () => {
    const pts = tessellateEllipse(EOFF)
    for (const p of pts) {
      const c = Math.cos(EOFF.rotation), s = Math.sin(EOFF.rotation)
      const dx = p.x - EOFF.center.x, dy = p.y - EOFF.center.y
      const xl = dx * c + dy * s, yl = -dx * s + dy * c
      const v = (xl / EOFF.majorRadius) ** 2 + (yl / EOFF.minorRadius) ** 2
      expect(close(v, 1, 1e-9)).toBe(true)
    }
  })
  it('tessellated polyline perimeter approaches the analytic perimeter', () => {
    const pts = tessellateEllipse(E)
    let len = 0
    for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
    const peri = ellipsePerimeter(10, 5)
    // Chord-sum underestimates slightly; within 1%.
    expect(len).toBeLessThanOrEqual(peri)
    expect(len).toBeGreaterThan(peri * 0.99)
  })
})

describe('elliptical arc', () => {
  it('sweep from 0 to 90deg is a quarter turn', () => {
    expect(close(ellipticalArcSweep(0, HALF_PI), HALF_PI)).toBe(true)
  })
  it('a wrap-around sweep normalizes into (0, 2pi]', () => {
    // start 270deg -> end 0deg is a quarter turn CCW.
    expect(close(ellipticalArcSweep((3 * Math.PI) / 2, 0), HALF_PI)).toBe(true)
  })
  it('arc endpoints match ellipsePointAt(start/end)', () => {
    const pts = tessellateEllipticalArc(E, 0, HALF_PI)
    const s = ellipsePointAt(E, 0), e = ellipsePointAt(E, HALF_PI)
    expect(close(pts[0].x, s.x) && close(pts[0].y, s.y)).toBe(true)
    expect(close(pts[pts.length - 1].x, e.x) && close(pts[pts.length - 1].y, e.y)).toBe(true)
  })
  it('arc does NOT close (start != end for a partial sweep)', () => {
    const pts = tessellateEllipticalArc(E, 0, HALF_PI)
    expect(close(pts[0].x, pts[pts.length - 1].x) && close(pts[0].y, pts[pts.length - 1].y)).toBe(false)
  })
})

describe('nearest-point projection', () => {
  it('a point far on the +X axis projects to the +major vertex', () => {
    const r = nearestPointOnEllipse(E, { x: 100, y: 0 })
    expect(close(r.point.x, 10, 1e-6)).toBe(true)
    expect(close(r.point.y, 0, 1e-6)).toBe(true)
    expect(close(r.dist, 90, 1e-4)).toBe(true)
  })
  it('a point on the +Y axis projects to the +minor co-vertex', () => {
    const r = nearestPointOnEllipse(E, { x: 0, y: 100 })
    expect(close(r.point.x, 0, 1e-6)).toBe(true)
    expect(close(r.point.y, 5, 1e-6)).toBe(true)
  })
  it('a point ON the curve has ~zero projection distance', () => {
    const on = ellipsePointAt(EOFF, 1.234)
    const r = nearestPointOnEllipse(EOFF, on)
    expect(r.dist).toBeLessThan(1e-3)
  })
  it('arc distance falls back to the nearer endpoint outside the sweep', () => {
    // Quarter arc 0..90deg; the nearest full-ellipse point to (-20,0) is the
    // -major vertex (param 180deg) which is OUTSIDE the [0,90deg] sweep, so
    // the distance falls back to the nearer arc endpoint: start (10,0) is 30
    // away, end (0,5) is sqrt(20^2 + 5^2) = sqrt(425) ~= 20.62 away (nearer).
    const d = distanceToEllipticalArc(E, 0, HALF_PI, { x: -20, y: 0 })
    expect(close(d, Math.sqrt(425), 1e-3)).toBe(true)
  })
})

describe('ellipseFoci', () => {
  // a=10, b=5 -> c = sqrt(100 - 25) = sqrt(75).
  const C = Math.sqrt(75)

  it('axis-aligned: two foci at center +- c along the major (+X) axis', () => {
    const foci = ellipseFoci(E)
    expect(foci).toHaveLength(2)
    expect(close(foci[0].x, C, 1e-9)).toBe(true)
    expect(close(foci[0].y, 0, 1e-9)).toBe(true)
    expect(close(foci[1].x, -C, 1e-9)).toBe(true)
    expect(close(foci[1].y, 0, 1e-9)).toBe(true)
  })

  it('rotated 90deg: foci ride the rotated major axis (+Y)', () => {
    const foci = ellipseFoci(E90)
    expect(foci).toHaveLength(2)
    expect(close(foci[0].x, 0, 1e-9)).toBe(true)
    expect(close(foci[0].y, C, 1e-9)).toBe(true)
    expect(close(foci[1].x, 0, 1e-9)).toBe(true)
    expect(close(foci[1].y, -C, 1e-9)).toBe(true)
  })

  it('offset + rotated: foci sit ON the long axis, symmetric about the center', () => {
    const foci = ellipseFoci(EOFF) // a=8, b=3, rot=30deg, center (3,-2)
    const c = Math.sqrt(8 * 8 - 3 * 3)
    const dx = c * Math.cos(Math.PI / 6)
    const dy = c * Math.sin(Math.PI / 6)
    expect(close(foci[0].x, 3 + dx, 1e-9)).toBe(true)
    expect(close(foci[0].y, -2 + dy, 1e-9)).toBe(true)
    expect(close(foci[1].x, 3 - dx, 1e-9)).toBe(true)
    expect(close(foci[1].y, -2 - dy, 1e-9)).toBe(true)
  })

  it('a < b SWAP (tool never clamps): foci ride the rotation+90deg direction', () => {
    // majorRadius 5 < minorRadius 10 at rotation 0: the true long axis is +Y,
    // c = sqrt(100 - 25) as if the radii were swapped.
    const swapped: EllipseShape = {
      center: { x: 1, y: 2 }, majorRadius: 5, minorRadius: 10, rotation: 0,
    }
    const foci = ellipseFoci(swapped)
    expect(foci).toHaveLength(2)
    expect(close(foci[0].x, 1, 1e-9)).toBe(true)
    expect(close(foci[0].y, 2 + C, 1e-9)).toBe(true)
    expect(close(foci[1].x, 1, 1e-9)).toBe(true)
    expect(close(foci[1].y, 2 - C, 1e-9)).toBe(true)
  })

  it('circle-degenerate (a == b): collapses to ONE node at the center, no NaN', () => {
    const circle: EllipseShape = {
      center: { x: 7, y: -4 }, majorRadius: 6, minorRadius: 6, rotation: 0.3,
    }
    const foci = ellipseFoci(circle)
    expect(foci).toHaveLength(1)
    expect(foci[0].x).toBe(7)
    expect(foci[0].y).toBe(-4)
  })

  it('non-finite input THROWS (fail-loud, never a silent NaN focus)', () => {
    const bad: EllipseShape = {
      center: { x: 0, y: 0 }, majorRadius: NaN, minorRadius: 5, rotation: 0,
    }
    expect(() => ellipseFoci(bad)).toThrow(/non-finite/)
  })
})
