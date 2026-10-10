import type { Vec2 } from '../../types'
import { evalNurbs } from '../sketch/spline'

/**
 * Chord length every DXF curve is sampled to, in millimetres. One constant for
 * the whole importer: ARC/CIRCLE (`sampleArc`), LWPOLYLINE bulges, SPLINE and
 * ELLIPSE all land on the same spacing, so a drawing that mixes them has one
 * visual fidelity and not four (WO-1841).
 */
export const CHORD_LEN_MM = 0.5

/** Hard ceiling on samples for one curve, so a degenerate knot vector cannot hang the import. */
const MAX_SAMPLES = 8192

function polylineLength(pts: Vec2[]): number {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return L
}

function maxChord(pts: Vec2[]): number {
  let m = 0
  for (let i = 1; i < pts.length; i++) m = Math.max(m, Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y))
  return m
}

// -- B-spline / NURBS (DXF SPLINE with control points) ------------------------

// The rational de Boor evaluator lives with the sketch spline (WO-1861) so the
// importer, control-point sketch splines, bezier and conic arcs share ONE
// implementation; re-exported here for the importer's existing callers.
export { evalNurbs }

/** A clamped uniform knot vector, for files that declare fewer knots than the degree needs. */
function clampedUniformKnots(n: number, p: number): number[] {
  const knots: number[] = []
  const inner = n - p - 1
  for (let i = 0; i <= p; i++) knots.push(0)
  for (let i = 1; i <= inner; i++) knots.push(i / (inner + 1))
  for (let i = 0; i <= p; i++) knots.push(1)
  return knots
}

/**
 * A DXF SPLINE's control-point form sampled to `segLenMM` chords. Returns [] if
 * the record cannot describe a curve at all (too few control points, or a
 * degenerate parameter domain) - the caller reports that entity as not imported
 * rather than dropping it in silence.
 */
export function sampleNurbs(
  ctrl: Vec2[], degree: number, knots: number[], weights?: number[], segLenMM = CHORD_LEN_MM
): Vec2[] {
  const n = ctrl.length
  if (n < 2) return []
  const p = Math.max(1, Math.min(Math.floor(degree) || 3, n - 1))

  // A knot vector must hold n + p + 1 values; anything else (missing, truncated,
  // or written for a different degree) is replaced by the clamped uniform one.
  const kv = knots.length === n + p + 1 ? knots : clampedUniformKnots(n, p)

  const u0 = kv[p], u1 = kv[n]
  if (!(u1 > u0)) return []

  // The control polygon is at least as long as the curve, so its length is a
  // safe first guess; the loop below then guarantees the chord bound outright.
  let nSeg = Math.max(8, Math.ceil(polylineLength(ctrl) / segLenMM))
  let pts: Vec2[] = []
  for (;;) {
    nSeg = Math.min(nSeg, MAX_SAMPLES)
    pts = []
    for (let i = 0; i <= nSeg; i++) pts.push(evalNurbs(ctrl, p, kv, weights, u0 + (u1 - u0) * i / nSeg))
    if (nSeg >= MAX_SAMPLES || maxChord(pts) <= segLenMM) break
    nSeg *= 2
  }
  return pts
}

// -- Fit points (DXF SPLINE with codes 11/21 and no control points) -----------

/**
 * A curve through a SPLINE's fit points, centripetal Catmull-Rom (Barry-Goldman
 * form) so it passes exactly through every fit point and does not loop back on
 * itself when their spacing is uneven.
 *
 * This is NOT the file's own interpolant - AutoCAD stores fit points alongside
 * the control points it solved for, and when only the fit points survive we
 * cannot recover that exact solve. It is a smooth curve through the operator's
 * own points, which is far closer to the drawing than the straight chords that
 * are the only alternative (WO-1841 decide-and-log).
 */
export function sampleFitPoints(fit: Vec2[], closed: boolean, segLenMM = CHORD_LEN_MM): Vec2[] {
  const pts = fit.filter((p, i) => i === 0 || Math.hypot(p.x - fit[i - 1].x, p.y - fit[i - 1].y) > 1e-12)
  if (pts.length < 2) return []
  if (pts.length === 2) return [pts[0], pts[1]]

  const at = (i: number): Vec2 => {
    if (closed) return pts[((i % pts.length) + pts.length) % pts.length]
    return pts[Math.max(0, Math.min(pts.length - 1, i))]
  }
  // alpha = 0.5 (centripetal); the floor keeps coincident neighbours from
  // collapsing a knot interval to zero.
  const knotAfter = (t: number, a: Vec2, b: Vec2): number =>
    t + Math.max(Math.hypot(b.x - a.x, b.y - a.y) ** 0.5, 1e-9)

  const out: Vec2[] = []
  const nSpan = closed ? pts.length : pts.length - 1
  for (let i = 0; i < nSpan; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2)
    const t0 = 0, t1 = knotAfter(t0, p0, p1), t2 = knotAfter(t1, p1, p2), t3 = knotAfter(t2, p2, p3)
    const evalAt = (t: number): Vec2 => {
      const lerp = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => {
        const f = (tb - ta) > 1e-12 ? (t - ta) / (tb - ta) : 0
        return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }
      }
      const a1 = lerp(p0, p1, t0, t1), a2 = lerp(p1, p2, t1, t2), a3 = lerp(p2, p3, t2, t3)
      const b1 = lerp(a1, a2, t0, t2), b2 = lerp(a2, a3, t1, t3)
      return lerp(b1, b2, t1, t2)
    }
    // The chord p1->p2 is shorter than the curve arched between them, so its
    // length only starts the estimate; double until the chord bound really holds.
    let steps = Math.max(2, Math.ceil(Math.hypot(p2.x - p1.x, p2.y - p1.y) / segLenMM))
    let span: Vec2[] = []
    for (;;) {
      steps = Math.min(steps, MAX_SAMPLES)
      span = [{ ...p1 }]
      for (let s = 1; s < steps; s++) span.push(evalAt(t1 + (t2 - t1) * s / steps))
      span.push({ ...p2 })
      if (steps >= MAX_SAMPLES || maxChord(span) <= segLenMM) break
      steps *= 2
    }
    out.push(...(i === 0 ? span : span.slice(1)))
  }
  return out
}

// -- ELLIPSE ------------------------------------------------------------------

/**
 * A DXF ELLIPSE sampled to `segLenMM` chords.
 * `center` is group 10/20, `majorEnd` the group-11/21 major-axis endpoint
 * RELATIVE to the centre, `ratio` the group-40 minor/major ratio, and
 * `startParam`/`endParam` the group-41/42 parameters in RADIANS (a full
 * ellipse is 0 .. 2*PI). The parametrisation is the DXF one:
 *   P(t) = C + major*cos t + perp(major)*ratio*sin t
 * so the result is already rotated by the major axis' own angle.
 */
export function sampleEllipse(
  center: Vec2, majorEnd: Vec2, ratio: number,
  startParam: number, endParam: number, segLenMM = CHORD_LEN_MM
): Vec2[] {
  const a = Math.hypot(majorEnd.x, majorEnd.y)
  if (!(a > 1e-12)) return []
  const k = Math.abs(ratio) > 1e-12 ? Math.abs(ratio) : 1

  let t0 = startParam, t1 = endParam
  if (!Number.isFinite(t0)) t0 = 0
  if (!Number.isFinite(t1)) t1 = 2 * Math.PI
  let span = t1 - t0
  while (span <= 1e-12) span += 2 * Math.PI
  if (span > 2 * Math.PI) span = 2 * Math.PI

  // |dP/dt| <= a, so a*span/nSeg <= segLenMM bounds every chord - the same
  // bound sampleArc uses for a circular arc, where a is simply the radius.
  const nSeg = Math.min(MAX_SAMPLES, Math.max(4, Math.ceil((a * span) / segLenMM)))
  const px = -majorEnd.y * k, py = majorEnd.x * k   // minor-axis vector: major rotated +90, scaled

  const pts: Vec2[] = []
  for (let i = 0; i <= nSeg; i++) {
    const t = t0 + span * i / nSeg
    pts.push({
      x: center.x + majorEnd.x * Math.cos(t) + px * Math.sin(t),
      y: center.y + majorEnd.y * Math.cos(t) + py * Math.sin(t),
    })
  }
  // A full ellipse closes on itself exactly, so the loop joiner sees a closed
  // chain rather than a hairline gap of rounding error.
  if (span >= 2 * Math.PI - 1e-9) pts[pts.length - 1] = { ...pts[0] }
  return pts
}
