// Pure Catmull-Rom spline geometry (basic interpolating spline, C4).
// Headless coverage of spline.ts: passes-through-control-points,
// centripetal bounded-overshoot sanity, open vs closed tessellation, point
// count, and nearest-point projection.

import { describe, it, expect } from 'vitest'
import {
  tessellateSpline, nearestPointOnSpline, splineControlMarkers, SPLINE_TESS_STEP_MM,
  splinePointAt, splineDerivativeAt, nearestParamOnSpline,
} from '../../lib/sketch/spline'
import type { Vec2 } from '../../types'

const close = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) <= eps

describe('WO-207 native spline parameterization', () => {
  it('evaluates and projects on the native Catmull-Rom curve', () => {
    const q = 1.35
    const p = splinePointAt(WAVE, false, q)
    const recovered = nearestParamOnSpline(WAVE, false, p)
    expect(recovered).toBeCloseTo(q, 4)
    const d = splineDerivativeAt(WAVE, false, q)
    expect(Math.hypot(d.x, d.y)).toBeGreaterThan(1e-6)
  })
})

/** Min distance from `p` to any vertex of the polyline. */
function minVertexDist(poly: Vec2[], p: Vec2): number {
  let m = Infinity
  for (const q of poly) m = Math.min(m, Math.hypot(q.x - p.x, q.y - p.y))
  return m
}

const WAVE: Vec2[] = [
  { x: 0, y: 0 }, { x: 10, y: 8 }, { x: 20, y: -4 }, { x: 30, y: 6 }, { x: 40, y: 0 },
]

describe('tessellateSpline passes THROUGH every control point', () => {
  it('open spline: each through-point is a polyline vertex', () => {
    const poly = tessellateSpline(WAVE, false)
    for (const cp of WAVE) {
      expect(minVertexDist(poly, cp)).toBeLessThan(1e-6)
    }
  })
  it('closed spline: each through-point is a polyline vertex', () => {
    const poly = tessellateSpline(WAVE, true)
    for (const cp of WAVE) {
      expect(minVertexDist(poly, cp)).toBeLessThan(1e-6)
    }
  })
})

describe('open vs closed', () => {
  it('open: first == points[0], last == last point, last != first', () => {
    const poly = tessellateSpline(WAVE, false)
    expect(close(poly[0].x, WAVE[0].x) && close(poly[0].y, WAVE[0].y)).toBe(true)
    const last = poly[poly.length - 1]
    expect(close(last.x, WAVE[4].x) && close(last.y, WAVE[4].y)).toBe(true)
    expect(close(poly[0].x, last.x) && close(poly[0].y, last.y)).toBe(false)
  })
  it('closed: last point EQUALS the first (duplicate closing vertex)', () => {
    const poly = tessellateSpline(WAVE, true)
    const last = poly[poly.length - 1]
    expect(close(poly[0].x, last.x) && close(poly[0].y, last.y)).toBe(true)
  })
})

describe('tessellation density', () => {
  it('produces far more vertices than control points', () => {
    const poly = tessellateSpline(WAVE, false)
    expect(poly.length).toBeGreaterThan(WAVE.length)
  })
  it('vertex count scales with chord length / step', () => {
    const poly = tessellateSpline(WAVE, false)
    // Lower bound: total straight-chord length / step (curve is longer).
    let chord = 0
    for (let i = 1; i < WAVE.length; i++) {
      chord += Math.hypot(WAVE[i].x - WAVE[i - 1].x, WAVE[i].y - WAVE[i - 1].y)
    }
    expect(poly.length).toBeGreaterThan(chord / SPLINE_TESS_STEP_MM * 0.5)
  })
  it('a 2-point spline is a straight Catmull-Rom segment (endpoints exact)', () => {
    const poly = tessellateSpline([{ x: 0, y: 0 }, { x: 6, y: 0 }], false)
    expect(close(poly[0].x, 0)).toBe(true)
    expect(close(poly[poly.length - 1].x, 6)).toBe(true)
    // Collinear input stays on the line (no cusp / no overshoot off-axis).
    for (const p of poly) expect(Math.abs(p.y)).toBeLessThan(1e-9)
  })
  it('fewer than 2 points returns the points verbatim', () => {
    expect(tessellateSpline([{ x: 3, y: 4 }], false)).toEqual([{ x: 3, y: 4 }])
    expect(tessellateSpline([], false)).toEqual([])
  })
})

describe('centripetal bounded-overshoot sanity (no cusp blow-up)', () => {
  it('a sharp-spike point set stays near the control bbox', () => {
    // A configuration where UNIFORM/chordal Catmull-Rom loops/overshoots;
    // centripetal (alpha=0.5) stays well-behaved. Assert the curve never
    // strays beyond the control bbox by more than the longest control edge.
    const pts: Vec2[] = [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10.5, y: 6 }, { x: 11, y: 0 }, { x: 20, y: 0 },
    ]
    const poly = tessellateSpline(pts, false)
    const minX = Math.min(...pts.map((p) => p.x)), maxX = Math.max(...pts.map((p) => p.x))
    const minY = Math.min(...pts.map((p) => p.y)), maxY = Math.max(...pts.map((p) => p.y))
    let longest = 0
    for (let i = 1; i < pts.length; i++) {
      longest = Math.max(longest, Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
    }
    for (const p of poly) {
      expect(p.x).toBeGreaterThanOrEqual(minX - longest)
      expect(p.x).toBeLessThanOrEqual(maxX + longest)
      expect(p.y).toBeGreaterThanOrEqual(minY - longest)
      expect(p.y).toBeLessThanOrEqual(maxY + longest)
    }
  })
})

describe('splineControlMarkers (persistent handle builder, points display flag)', () => {
  it('returns a COPY of the through-points when visible', () => {
    const markers = splineControlMarkers(WAVE, true)
    expect(markers).toEqual(WAVE)
    // Fresh objects, not aliases into the source array.
    expect(markers[0]).not.toBe(WAVE[0])
    markers[0].x = 999
    expect(WAVE[0].x).toBe(0)
  })
  it('returns an EMPTY list when the display flag is off (nothing drawn)', () => {
    expect(splineControlMarkers(WAVE, false)).toEqual([])
  })
  it('empty input yields no markers', () => {
    expect(splineControlMarkers([], true)).toEqual([])
  })
})

describe('nearestPointOnSpline', () => {
  it('a point ON a control point projects to ~zero distance', () => {
    const r = nearestPointOnSpline(WAVE, false, { x: 20, y: -4 })
    expect(r.dist).toBeLessThan(1e-6)
  })
  it('a far point projects to a finite, large distance on the curve', () => {
    const r = nearestPointOnSpline(WAVE, false, { x: 20, y: 100 })
    expect(r.dist).toBeGreaterThan(90)
    expect(Number.isFinite(r.dist)).toBe(true)
  })
})
