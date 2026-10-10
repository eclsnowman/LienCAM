import type { Vec2 } from '../../../types'

/**
 * Algebraic least-squares circle fit (Kasa method).
 *
 * Implements the circle-fitting primitive used by the arc-fitting pass
 * described in R3 section 3.2 (chordal-tolerance arc fitting). A run of
 * sampled toolpath points is fitted to the circle that minimizes the
 * algebraic distance, by solving the linear normal-equation system for the
 * general conic coefficients (D, E, F):
 *
 *   x^2 + y^2 + D*x + E*y + F = 0
 *   center: (cx, cy) = (-D/2, -E/2)
 *   radius: r = sqrt(cx^2 + cy^2 - F)
 *
 * Returns `null` (never throws) when a circle cannot be recovered:
 *   - fewer than 3 points,
 *   - the points are collinear / the system is singular (det ~ 0), or
 *   - the resulting radius is non-finite.
 *
 * A `null` return is the contract by which callers detect "this run is a
 * line, not an arc" (R3 section 3.2).
 *
 * @param points sampled points of the candidate run
 * @returns the fitted circle {cx, cy, r}, or null if no circle fits
 */
export function fitCircle(points: Vec2[]): { cx: number; cy: number; r: number } | null {
  const n = points.length
  if (n < 3) return null

  // Running sums; z = x*x + y*y.
  let Sx = 0
  let Sy = 0
  let Sxx = 0
  let Syy = 0
  let Sxy = 0
  let Sxz = 0
  let Syz = 0
  let Sz = 0

  for (const p of points) {
    const x = p.x
    const y = p.y
    const z = x * x + y * y
    Sx += x
    Sy += y
    Sxx += x * x
    Syy += y * y
    Sxy += x * y
    Sxz += x * z
    Syz += y * z
    Sz += z
  }

  // Normal-equation system A * [D, E, F]^T = b for x^2+y^2 + D x + E y + F = 0.
  // Rows derived from minimizing sum( (x^2+y^2 + D x + E y + F)^2 ).
  const a = [
    [Sxx, Sxy, Sx],
    [Sxy, Syy, Sy],
    [Sx, Sy, n],
  ]
  const b = [-Sxz, -Syz, -Sz]

  // Cramer's rule via 3x3 determinant.
  const det =
    a[0][0] * (a[1][1] * a[2][2] - a[1][2] * a[2][1]) -
    a[0][1] * (a[1][0] * a[2][2] - a[1][2] * a[2][0]) +
    a[0][2] * (a[1][0] * a[2][1] - a[1][1] * a[2][0])

  // Singular / collinear: no unique circle.
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null

  const det3 = (col: number[], idx: 0 | 1 | 2): number => {
    const m = [a[0].slice(), a[1].slice(), a[2].slice()]
    m[0][idx] = col[0]
    m[1][idx] = col[1]
    m[2][idx] = col[2]
    return (
      m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) -
      m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) +
      m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
    )
  }

  const D = det3(b, 0) / det
  const E = det3(b, 1) / det
  const F = det3(b, 2) / det

  const cx = -D / 2
  const cy = -E / 2
  const rSq = cx * cx + cy * cy - F
  if (!Number.isFinite(rSq) || rSq < 0) return null

  const r = Math.sqrt(rSq)
  if (!Number.isFinite(r)) return null

  return { cx, cy, r }
}

/**
 * Circle fit CONSTRAINED to keep both endpoints exactly equidistant from the
 * centre (WO-1384): the centre is forced onto the perpendicular bisector of
 * `points[0]` and the last point, so the start and end radii are identical by
 * construction -- never merely "both within tolerance of a third, unrelated
 * radius" the way the unconstrained {@link fitCircle} algebraic fit allows. A
 * posted G2/G3's start and end radii (recomputed by the controller from the
 * emitted X/Y/I/J) must agree; a centre off the bisector can pass both
 * endpoints' individual radial-deviation checks while the two radii differ
 * from EACH OTHER by up to ~2x the tolerance budget (the recorded defect:
 * 0.044 mm apart under a 0.05 mm tolerance).
 *
 * The centre is parametrized as C(t) = M + t*u, where M is the start/end
 * midpoint and u is the unit vector perpendicular to the start->end chord (u
 * spans exactly the perpendicular bisector). For any t, |C(t)-start| ==
 * |C(t)-end| automatically (M-start and M-end are anti-parallel along the
 * chord direction, which is perpendicular to u by construction), so this
 * fit can never reproduce the defect. `t` is then chosen to best fit the
 * INTERIOR points (everything strictly between the two endpoints) via
 * algebraic least squares -- the same style of fit as {@link fitCircle}, but
 * reduced to the one free parameter t: the algebraic error of interior point
 * Q at parameter t is `e(t) = |M-Q|^2 - h^2 + 2t * u.(M-Q)` (h = half the
 * chord length), which is LINEAR in t, so minimizing sum(e(t)^2) has a closed
 * form (ordinary 1D least squares through the origin). With zero or one
 * interior point sharing a common u-component (`sumA2 ~ 0`, e.g. the classic
 * 3-point case where geometry can leave the interior point's algebraic error
 * independent of t), t defaults to 0 (centre at the chord midpoint).
 *
 * Returns `null` for fewer than 3 points or coincident endpoints (no chord to
 * bisect) -- the same "this is a line, not an arc" contract {@link fitCircle}
 * uses.
 *
 * @param points the candidate span, points[0] and points[points.length-1]
 *   are the arc's start/end; everything between is fitted
 * @returns the fitted circle {cx, cy, r}, or null if no circle applies
 */
export function fitCircleEndpointLocked(points: Vec2[]): { cx: number; cy: number; r: number } | null {
  const n = points.length
  if (n < 3) return null

  const start = points[0]
  const end = points[n - 1]
  const dx = end.x - start.x
  const dy = end.y - start.y
  const chordLen = Math.hypot(dx, dy)
  if (chordLen < 1e-9) return null

  // Unit chord direction and its perpendicular (the bisector direction).
  const cux = dx / chordLen
  const cuy = dy / chordLen
  const ux = -cuy
  const uy = cux

  const mx = (start.x + end.x) / 2
  const my = (start.y + end.y) / 2
  const h = chordLen / 2

  let sumA2 = 0
  let sumAB = 0
  for (let k = 1; k < n - 1; k++) {
    const q = points[k]
    const mqx = mx - q.x
    const mqy = my - q.y
    const a = 2 * (ux * mqx + uy * mqy)
    const b = mqx * mqx + mqy * mqy - h * h
    sumA2 += a * a
    sumAB += a * b
  }

  const t = sumA2 > 1e-12 ? -sumAB / sumA2 : 0

  const cx = mx + t * ux
  const cy = my + t * uy
  const r = Math.sqrt(h * h + t * t)
  if (!Number.isFinite(r) || r <= 0) return null

  return { cx, cy, r }
}

/**
 * Maximum radial deviation of a point set from a candidate circle.
 *
 * For each point, the absolute difference between its distance to the
 * center and the radius; the returned value is the maximum over all points.
 * This is the chordal-tolerance error measure used to accept or reject an
 * arc fit (R3 section 3.2): the fit is acceptable when this value is within
 * the arc tolerance budget.
 *
 * @returns the worst-case radial error (>= 0); 0 for an empty point set
 */
export function maxRadialDeviation(points: Vec2[], cx: number, cy: number, r: number): number {
  let worst = 0
  for (const p of points) {
    const dx = p.x - cx
    const dy = p.y - cy
    const err = Math.abs(Math.hypot(dx, dy) - r)
    if (err > worst) worst = err
  }
  return worst
}

/**
 * Signed-by-direction included sweep angle from `start` to `end` about a
 * circle center (R3 section 3.2 arc construction).
 *
 * The angle of each endpoint is taken with atan2 about the center; the
 * difference is interpreted in the requested winding direction ('ccw' is the
 * positive sense, 'cw' is negated) and normalized into [0, 2*pi).
 *
 * @returns the swept angle in radians, in [0, 2*pi)
 */
export function sweepAngle(start: Vec2, end: Vec2, cx: number, cy: number, dir: 'cw' | 'ccw'): number {
  const a0 = Math.atan2(start.y - cy, start.x - cx)
  const a1 = Math.atan2(end.y - cy, end.x - cx)
  let delta = a1 - a0
  if (dir === 'cw') delta = -delta

  const twoPi = 2 * Math.PI
  // Normalize into [0, 2*pi).
  delta %= twoPi
  if (delta < 0) delta += twoPi
  return delta
}
