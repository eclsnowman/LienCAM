// Pure interpolating-spline geometry (basic Catmull-Rom spline, item C4).
//
// PURE and headless-testable: no store, no three.js, no DOM, no planegcs.
// A v1 sketch spline is SOLVER-INERT (types.ts fork, exactly like the
// ellipse): it stores the clicked through-points verbatim and only its
// FIRST point (the anchor, site 'start') participates in the constraint
// solve. The curve INTERPOLATES every through-point (the points ARE the
// curve), so each maps 1:1 to a future constrainable point when the spline
// graduates to a constraint-driven entity.
//
// PARAMETERIZATION (centripetal Catmull-Rom, alpha = 0.5): the knot spacing
// between consecutive control points is |P[i+1]-P[i]|^0.5. Centripetal (vs
// uniform alpha=0 or chordal alpha=1) provably avoids cusps and self-
// intersections WITHIN a segment, so a hand-drawn through-point sequence
// tessellates cleanly. An OPEN spline duplicates its terminal points to get
// a one-sided tangent at each end; a CLOSED spline wraps the control indices.
//
// CONTROL-POINT FORM (WO-1861): a spline whose `form` is 'control' reads the
// SAME `points` array as the control polygon of a uniform cubic B-spline --
// the curve is pulled toward the points instead of passing through them.
// OPEN = clamped knots (the curve starts on points[0] and ends on the last
// point), CLOSED = periodic knots (C2 across the seam, no corner). Fewer than
// four points drop the degree to what the points define (3 points: quadratic,
// 2: a line, 1: a point) -- never a refusal. Every public evaluator below
// takes a trailing `form` and dispatches on it, and the parameter domain is
// the SAME for both forms ([0, n-1] open, [0, n] closed) so callers that walk
// the domain (split, pattern-path, fillet) need no per-form arithmetic. The
// evaluator is the one rational de Boor the DXF importer already used
// (evalNurbs, moved here from import/dxfCurves.ts) so bezier and conic arcs
// (WO-1862/1863) reuse it, weights included.
//
// BEZIER FORM (WO-1862): a spline whose `form` is 'bezier' reads `points` as a
// chain of cubic bezier segments laid end to end -- anchor, out-handle,
// in-handle, anchor, out-handle, ... (3m+1 points for m open segments; a
// CLOSED chain drops the repeated first anchor, 3m points, and its last
// segment runs back to points[0]). Each segment is a single-span cubic
// B-spline with clamped knots [0,0,0,0,1,1,1,1], so it is evaluated by the
// SAME evalNurbs -- there is no second curve engine. Segment k occupies the
// shared parameter range [3k, 3k+3], so the domain is again [0, n-1] open and
// [0, n] closed. A short tail (a chain that is not 3m+1 points) drops the
// degree of its last segment, never a refusal. `smooth[k]` marks anchor 3k as
// a smooth joint: its two handles stay collinear through handle drags
// (splineDragEdit) -- the curve's own edit rule, because a tangent between
// spline pieces maps to no solver primitive.
//
// CONIC ARC (WO-1863): a spline whose `form` is 'conic' is ONE rational
// quadratic bezier over start, apex and end (the apex is where the two end
// tangents meet), apex weight w = rho / (1 - rho): rho = 0.5 is a parabola,
// below it an ellipse arc, above it a hyperbola arc. `points` holds FOUR
// points -- start, apex, SHOULDER, end -- where the shoulder is the curve's
// t = 0.5 point, rho of the way from the chord midpoint to the apex. Storing
// rho as that point (rather than as a number) keeps every consumer that reads
// (points, closed, form) exact with no rho plumbing, and every affine map any
// tool applies to the points (move, rotate, scale, mirror, pattern, paste)
// keeps it exact too, because an affine map keeps both the conic and the
// shoulder's ratio along the median. The end is still points[n-1], so the
// 'start'/'end' sites mean what they mean on every spline. The evaluator is
// the same evalNurbs (degree 2, weights [1, w, 1]); the shared parameter
// domain [0, 3] maps linearly onto the bezier's t in [0, 1].

import type { Vec2 } from '../../types'

/** How a spline's `points` are read: 'fit' = through-points (the curve passes
 *  through each, the default when absent), 'control' = B-spline control
 *  polygon, 'bezier' = a chain of cubic bezier segments (WO-1862), 'conic' =
 *  one conic arc stored as start, apex, shoulder, end (WO-1863). */
export type SplineForm = 'fit' | 'control' | 'bezier' | 'conic'

const ALPHA = 0.5
// Chord step (mm) for tessellation -- matches the ellipse chord budget
// (ellipse.ts TESS_STEP_MM) so screen rendering and bake polylines agree.
export const SPLINE_TESS_STEP_MM = 0.3
// Per-segment tessellation cap (very long segments stay bounded).
const MAX_SUB_PER_SEGMENT = 200

/** Next centripetal knot after `t`, advancing from `a` to `b`. A minimum
 *  positive delta keeps duplicated/coincident control points from producing
 *  a zero-width knot interval (division by zero in the Barry-Goldman form). */
function nextKnot(t: number, a: Vec2, b: Vec2): number {
  const d = Math.hypot(b.x - a.x, b.y - a.y)
  return t + Math.max(Math.pow(d, ALPHA), 1e-6)
}

/** Barry-Goldman evaluation of one centripetal Catmull-Rom segment (the
 *  curve runs P1 -> P2; P0/P3 set the tangents). `u` in [0, 1] maps onto the
 *  segment's knot interval [t1, t2]. C(0) == P1 and C(1) == P2 exactly, so
 *  the curve passes THROUGH every control point. */
function segmentPoint(p0: Vec2, p1: Vec2, p2: Vec2, p3: Vec2, u: number): Vec2 {
  const t0 = 0
  const t1 = nextKnot(t0, p0, p1)
  const t2 = nextKnot(t1, p1, p2)
  const t3 = nextKnot(t2, p2, p3)
  const t = t1 + (t2 - t1) * u
  const lerp = (a: Vec2, b: Vec2, ta: number, tb: number): Vec2 => {
    const w = (t - ta) / ((tb - ta) || 1e-9)
    return { x: a.x + (b.x - a.x) * w, y: a.y + (b.y - a.y) * w }
  }
  const A1 = lerp(p0, p1, t0, t1)
  const A2 = lerp(p1, p2, t1, t2)
  const A3 = lerp(p2, p3, t2, t3)
  const B1 = lerp(A1, A2, t0, t2)
  const B2 = lerp(A2, A3, t1, t3)
  return lerp(B1, B2, t1, t2)
}

/** Four control points for segment `i` (curve runs points[i] -> points[i+1]).
 *  Open splines clamp at the ends (duplicate terminal = one-sided tangent);
 *  closed splines wrap. */
function controlsFor(
  points: readonly Vec2[], closed: boolean, i: number,
): [Vec2, Vec2, Vec2, Vec2] {
  const n = points.length
  if (closed) {
    return [
      points[(i - 1 + n) % n], points[i % n],
      points[(i + 1) % n], points[(i + 2) % n],
    ]
  }
  const clamp = (k: number) => points[Math.max(0, Math.min(n - 1, k))]
  return [clamp(i - 1), clamp(i), clamp(i + 1), clamp(i + 2)]
}

// ---- B-spline / NURBS evaluation (shared with the DXF importer) -------------

/**
 * Index of the knot span containing `u`, clamped to the curve's valid domain
 * [knots[p], knots[n]]. Works for clamped and for periodic (unclamped) knot
 * vectors alike, which is why closed splines need no special case: the valid
 * domain of a periodic vector already traces the whole closed curve.
 */
function findSpan(n: number, p: number, u: number, knots: readonly number[]): number {
  if (u >= knots[n]) return n - 1
  if (u <= knots[p]) return p
  let lo = p, hi = n
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1
    if (u < knots[mid]) hi = mid; else lo = mid
  }
  return lo
}

/**
 * One point of a (rational) B-spline by de Boor's algorithm, evaluated in
 * homogeneous coordinates so optional weights are honoured. `ctrl` are the
 * control points, `p` the degree, `knots` the knot vector (n + p + 1 values),
 * `weights` the per-control-point weights if the spline is rational.
 */
export function evalNurbs(
  ctrl: readonly Vec2[], p: number, knots: readonly number[],
  weights: readonly number[] | undefined, u: number,
): Vec2 {
  const n = ctrl.length
  const k = findSpan(n, p, u, knots)
  const d: Array<{ x: number; y: number; w: number }> = []
  for (let j = 0; j <= p; j++) {
    const i = k - p + j
    const w = weights?.[i] ?? 1
    d.push({ x: ctrl[i].x * w, y: ctrl[i].y * w, w })
  }
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const i = k - p + j
      const den = knots[i + p - r + 1] - knots[i]
      const a = Math.abs(den) > 1e-12 ? (u - knots[i]) / den : 0
      d[j] = {
        x: (1 - a) * d[j - 1].x + a * d[j].x,
        y: (1 - a) * d[j - 1].y + a * d[j].y,
        w: (1 - a) * d[j - 1].w + a * d[j].w,
      }
    }
  }
  const w = d[p].w
  return Math.abs(w) > 1e-12 ? { x: d[p].x / w, y: d[p].y / w } : { x: d[p].x, y: d[p].y }
}

/** The uniform cubic B-spline a control-point sketch spline denotes: the
 *  control list (a closed curve wraps its first `p` points onto the end), the
 *  degree, the integer knot vector and its valid domain [u0, u1]. */
interface ControlBSpline {
  ctrl: Vec2[]
  p: number
  knots: number[]
  u0: number
  u1: number
}

/** Degree a control-point spline of `n` points uses: cubic, dropping to what
 *  the points can define (the refusal bar: draw it, say nothing). */
export function controlSplineDegree(n: number): number {
  return Math.max(0, Math.min(3, n - 1))
}

function controlBSpline(points: readonly Vec2[], closed: boolean): ControlBSpline {
  const n = points.length
  const p = controlSplineDegree(n)
  const knots: number[] = []
  if (closed) {
    // Periodic: wrap p control points, uniform knots 0..n+2p. The valid domain
    // [p, n+p] is exactly one lap, and the wrapped points make the curve C2
    // across the seam.
    const ctrl = [...points, ...points.slice(0, p)].map((q) => ({ x: q.x, y: q.y }))
    for (let i = 0; i <= ctrl.length + p; i++) knots.push(i)
    return { ctrl, p, knots, u0: p, u1: n + p }
  }
  // Clamped: p+1 equal knots at each end so the curve starts on points[0] and
  // ends on points[n-1]; integer interior knots, domain [0, n-p].
  const spans = n - p
  for (let i = 0; i <= p; i++) knots.push(0)
  for (let i = 1; i < spans; i++) knots.push(i)
  for (let i = 0; i <= p; i++) knots.push(spans)
  return { ctrl: points.map((q) => ({ x: q.x, y: q.y })), p, knots, u0: 0, u1: spans }
}

/** Derivative of a B-spline as a B-spline one degree lower (the standard
 *  hodograph: Q_i = p (P_{i+1} - P_i) / (u_{i+p+1} - u_{i+1}), the knot
 *  vector with its first and last knot dropped). */
function bsplineHodograph(b: { ctrl: Vec2[]; p: number; knots: number[] }): { ctrl: Vec2[]; p: number; knots: number[] } {
  const { ctrl, p, knots } = b
  const out: Vec2[] = []
  for (let i = 0; i + 1 < ctrl.length; i++) {
    const den = knots[i + p + 1] - knots[i + 1]
    const s = Math.abs(den) > 1e-12 ? p / den : 0
    out.push({ x: (ctrl[i + 1].x - ctrl[i].x) * s, y: (ctrl[i + 1].y - ctrl[i].y) * s })
  }
  return { ctrl: out, p: p - 1, knots: knots.slice(1, -1) }
}

/** WO-1866: exact signed curvature of an OPEN control-point spline at shared
 *  parameter q ([0, n-1]), from its analytic first and second derivatives
 *  (never from a tessellation or a finite difference). Positive = the curve
 *  turns left (counter-clockwise) travelling start -> end. */
export function controlSplineCurvatureAt(points: readonly Vec2[], q: number): number {
  const n = points.length
  if (n < 3) return 0
  const b = controlBSpline(points, false)
  const u = controlKnotAt(b, n, false, q)
  const d1 = bsplineHodograph(b)
  const d2 = bsplineHodograph(d1)
  const v = evalNurbs(d1.ctrl, d1.p, d1.knots, undefined, u)
  const a = evalNurbs(d2.ctrl, d2.p, d2.knots, undefined, u)
  const speed = Math.hypot(v.x, v.y)
  if (speed < 1e-12) return 0
  return (v.x * a.y - v.y * a.x) / (speed * speed * speed)
}

/** WO-1866: the constant c in an open control-point spline's END curvature,
 *  k = c * (a x b) / |a|^3 with a = P1 - P0, b = P2 - P1 (the far end is the
 *  mirror image). Read from the knot vector the spline actually uses:
 *  c = ((p-1)/p) * u_{p+1} / u_{p+2} measured from the clamped start, which
 *  is 1/2 for three points, 2/3 for four and 1/3 for five or more. */
export function controlSplineEndCurvatureScale(n: number): number {
  const p = controlSplineDegree(n)
  if (p < 2) return 0
  const { knots } = controlBSpline(Array.from({ length: n }, () => ({ x: 0, y: 0 })), false)
  return ((p - 1) / p) * (knots[p + 1] - knots[0]) / (knots[p + 2] - knots[0])
}

/** Shared-domain parameter q ([0, n-1] open, [0, n] closed) -> knot value. */
function controlKnotAt(b: ControlBSpline, n: number, closed: boolean, q: number): number {
  const qMax = closed ? n : n - 1
  const t = Math.max(0, Math.min(qMax, q)) / qMax
  return b.u0 + (b.u1 - b.u0) * t
}

function controlPointAt(points: readonly Vec2[], closed: boolean, q: number): Vec2 {
  const n = points.length
  if (n === 1) return { ...points[0] }
  const b = controlBSpline(points, closed)
  if (closed) {
    // Periodic: any q is one lap's worth of parameter, so wrap rather than clamp.
    const w = ((q % n) + n) % n
    return evalNurbs(b.ctrl, b.p, b.knots, undefined, controlKnotAt(b, n, closed, w))
  }
  // Exact endpoints: a clamped curve interpolates its end control points.
  if (q <= 0) return { ...points[0] }
  if (q >= n - 1) return { ...points[n - 1] }
  return evalNurbs(b.ctrl, b.p, b.knots, undefined, controlKnotAt(b, n, closed, q))
}

/** Tessellation of a control-point spline: every knot span is subdivided
 *  finely enough that no chord exceeds `step` (a span's curve length never
 *  exceeds the length of its own p+1 control points, so that polygon bounds
 *  the chord count from above). Open: first/last point are exactly the end
 *  control points. Closed: the last point equals the first. */
function tessellateControlSpline(
  points: readonly Vec2[], closed: boolean, step: number,
): Vec2[] {
  const n = points.length
  const b = controlBSpline(points, closed)
  const out: Vec2[] = [{ ...controlPointAt(points, closed, 0) }]
  for (let u = b.u0; u < b.u1; u++) {
    // Span [u, u+1] is shaped by control points k-p .. k.
    const k = findSpan(b.ctrl.length, b.p, u + 0.5, b.knots)
    let local = 0
    for (let i = k - b.p; i < k; i++) {
      local += Math.hypot(b.ctrl[i + 1].x - b.ctrl[i].x, b.ctrl[i + 1].y - b.ctrl[i].y)
    }
    const sub = Math.min(MAX_SUB_PER_SEGMENT, Math.max(1, Math.ceil(local / step)))
    for (let j = 1; j <= sub; j++) out.push(evalNurbs(b.ctrl, b.p, b.knots, undefined, u + j / sub))
  }
  if (closed) out[out.length - 1] = { ...out[0] }
  else out[out.length - 1] = { ...points[n - 1] }
  return out
}

// ---- Bezier chain (WO-1862) -------------------------------------------------

/** Clamped single-span knot vector of degree `p`: a bezier of degree p IS the
 *  B-spline over its p+1 points with these knots. */
function bezierSpanKnots(p: number): number[] {
  const k: number[] = []
  for (let i = 0; i <= p; i++) k.push(0)
  for (let i = 0; i <= p; i++) k.push(1)
  return k
}

/** The chain as an open point run: a closed chain repeats points[0] at the end
 *  so its last segment returns to the start. */
function bezierRun(points: readonly Vec2[], closed: boolean): Vec2[] {
  const run = points.map((p) => ({ x: p.x, y: p.y }))
  if (closed && run.length > 1) run.push({ ...run[0] })
  return run
}

/** Segment of the run holding parameter q: its control points (degree =
 *  count - 1, cubic except a short tail) and the local bezier parameter t. */
function bezierSegmentAt(run: readonly Vec2[], q: number): { ctrl: Vec2[]; t: number } {
  const last = run.length - 1
  const c = Math.max(0, Math.min(last, q))
  const start = Math.min(3 * Math.floor(c / 3), 3 * Math.floor((last - 1) / 3))
  const end = Math.min(start + 3, last)
  const deg = end - start
  return { ctrl: run.slice(start, end + 1), t: Math.max(0, Math.min(1, (c - start) / deg)) }
}

/** Shared-domain q wrapped onto one lap of a closed chain (q = n stays n). */
function bezierWrap(n: number, closed: boolean, q: number): number {
  if (!closed || q === n) return q
  return ((q % n) + n) % n
}

function bezierPointAt(points: readonly Vec2[], closed: boolean, q: number): Vec2 {
  const { ctrl, t } = bezierSegmentAt(bezierRun(points, closed), bezierWrap(points.length, closed, q))
  if (t <= 0) return { ...ctrl[0] }
  if (t >= 1) return { ...ctrl[ctrl.length - 1] }
  const p = ctrl.length - 1
  return evalNurbs(ctrl, p, bezierSpanKnots(p), undefined, t)
}

/** Exact derivative dC/dq of a bezier chain: the hodograph -- the degree-(p-1)
 *  bezier over the differences P[i+1]-P[i] (dC/dt = p x hodograph and a
 *  segment spans p units of q, so the p cancels). At a segment's first point
 *  it is exactly the out-handle vector, so the end tangent is parallel to the
 *  handle. Zero for a zero-length handle; splineDerivativeAt then falls back
 *  to the curve's own limiting direction. */
function bezierDerivativeAt(points: readonly Vec2[], closed: boolean, q: number): Vec2 {
  const { ctrl, t } = bezierSegmentAt(bezierRun(points, closed), bezierWrap(points.length, closed, q))
  const diffs: Vec2[] = []
  for (let i = 0; i + 1 < ctrl.length; i++) {
    diffs.push({ x: ctrl[i + 1].x - ctrl[i].x, y: ctrl[i + 1].y - ctrl[i].y })
  }
  if (diffs.length === 1) return diffs[0]
  const p = diffs.length - 1
  return evalNurbs(diffs, p, bezierSpanKnots(p), undefined, t)
}

/** Tessellation of a bezier chain: each segment subdivided uniformly in t so
 *  no chord exceeds `step`. The speed |dC/dt| of a degree-p bezier never
 *  exceeds p x its longest control leg (the hodograph lies in the hull of the
 *  scaled legs), so p x maxLeg / step samples bound every chord. Every anchor
 *  lands exactly in the output. Closed: the last point equals the first. */
function tessellateBezierChain(points: readonly Vec2[], closed: boolean, step: number): Vec2[] {
  const run = bezierRun(points, closed)
  const last = run.length - 1
  const out: Vec2[] = [{ ...run[0] }]
  for (let start = 0; start < last; start += 3) {
    const end = Math.min(start + 3, last)
    const ctrl = run.slice(start, end + 1)
    const p = end - start
    const knots = bezierSpanKnots(p)
    let maxLeg = 0
    for (let i = 0; i < p; i++) {
      maxLeg = Math.max(maxLeg, Math.hypot(ctrl[i + 1].x - ctrl[i].x, ctrl[i + 1].y - ctrl[i].y))
    }
    // A segment spans p units of the shared parameter, so it gets p segments'
    // worth of the per-segment cap.
    const sub = Math.min(p * MAX_SUB_PER_SEGMENT, Math.max(1, Math.ceil((p * maxLeg) / step)))
    for (let j = 1; j < sub; j++) out.push(evalNurbs(ctrl, p, knots, undefined, j / sub))
    out.push({ ...ctrl[p] })
  }
  return out
}

// ---- Conic arc (WO-1863) -------------------------------------------------------

/** Largest rho a conic arc is drawn at. rho = 1 is the two apex legs (w is
 *  infinite) and rho < 0 bends the arc away from the apex, so neither is a
 *  single arc between the endpoints; the drawable range is [0, CONIC_RHO_MAX].
 *  rho = 0 is drawable: weight 0 is the straight chord. */
export const CONIC_RHO_MAX = 0.999

/** rho clamped into the drawable range (a non-number reads as 0.5, the
 *  parabola). Pure; the draw and edit paths say on the console when they
 *  clamp (conicLogClamp). */
export function conicClampRho(rho: number): number {
  if (!Number.isFinite(rho)) return 0.5
  return Math.max(0, Math.min(CONIC_RHO_MAX, rho))
}

/** One console line when a requested rho had to be clamped (rule 11: draw it,
 *  say what was drawn, no notice). Returns the rho that is drawn. */
export function conicLogClamp(rho: number): number {
  const drawn = conicClampRho(rho)
  if (drawn !== rho) {
    console.info(`Conic: rho ${rho} has no single arc between the endpoints; drawn at rho ${drawn}.`)
  }
  return drawn
}

/** Apex weight of the rational quadratic bezier for `rho`: the t = 0.5 point
 *  sits w / (1 + w) of the way from the chord midpoint to the apex, so
 *  w = rho / (1 - rho). rho = 0.5 gives w = 1, the ordinary (parabolic)
 *  quadratic bezier. */
export function conicWeight(rho: number): number {
  const r = conicClampRho(rho)
  return r / (1 - r)
}

/** The shoulder: rho of the way from the chord midpoint to the apex. */
export function conicShoulder(start: Vec2, apex: Vec2, end: Vec2, rho: number): Vec2 {
  const r = conicClampRho(rho)
  const mx = (start.x + end.x) / 2, my = (start.y + end.y) / 2
  return { x: mx + (apex.x - mx) * r, y: my + (apex.y - my) * r }
}

/** The stored point list of a conic arc: start, apex, shoulder, end. */
export function conicPoints(start: Vec2, apex: Vec2, end: Vec2, rho: number): Vec2[] {
  return [
    { x: start.x, y: start.y }, { x: apex.x, y: apex.y },
    conicShoulder(start, apex, end, rho), { x: end.x, y: end.y },
  ]
}

/** rho of a stored conic: the shoulder's position along the median from the
 *  chord midpoint (0) to the apex (1), by projection, so a shoulder nudged
 *  off the median still reads sensibly. An apex ON the chord midpoint has no
 *  median; the arc is then the chord whatever rho is, and 0.5 is returned. */
export function conicRho(points: readonly Vec2[]): number {
  if (points.length < 4) return 0.5
  const [s, a, sh, e] = [points[0], points[1], points[2], points[points.length - 1]]
  const mx = (s.x + e.x) / 2, my = (s.y + e.y) / 2
  const dx = a.x - mx, dy = a.y - my
  const len2 = dx * dx + dy * dy
  if (len2 < 1e-24) return 0.5
  return conicClampRho(((sh.x - mx) * dx + (sh.y - my) * dy) / len2)
}

/** A conic arc with its rho set to `rho` (clamped, with the console line):
 *  the start, apex and end stay exactly where they are and only the shoulder
 *  moves. Anything that is not a conic is returned unchanged. */
export function conicWithRho<T extends { points: Vec2[]; form?: SplineForm }>(e: T, rho: number): T {
  if (e.form !== 'conic' || e.points.length < 4) return e
  const p = e.points
  return { ...e, points: conicPoints(p[0], p[1], p[p.length - 1], conicLogClamp(rho)) }
}

/** The three bezier control points (start, apex, end) and the apex weight a
 *  stored conic denotes. */
function conicControl(points: readonly Vec2[]): { ctrl: Vec2[]; w: number } {
  const n = points.length
  return {
    ctrl: [points[0], points[1], points[n - 1]].map((p) => ({ x: p.x, y: p.y })),
    w: conicWeight(conicRho(points)),
  }
}

const CONIC_KNOTS = [0, 0, 0, 1, 1, 1]

/** Point of the rational quadratic bezier over start/apex/end with apex
 *  weight `w`, at bezier parameter t in [0, 1] (the shared evaluator). */
export function conicBezierAt(start: Vec2, apex: Vec2, end: Vec2, w: number, t: number): Vec2 {
  if (t <= 0) return { x: start.x, y: start.y }
  if (t >= 1) return { x: end.x, y: end.y }
  return evalNurbs([start, apex, end], 2, CONIC_KNOTS, [1, w, 1], t)
}

/** Shared-domain q in [0, n-1] -> the conic's point (t = q / (n-1)). */
function conicPointAt(points: readonly Vec2[], q: number): Vec2 {
  const { ctrl, w } = conicControl(points)
  const qMax = points.length - 1
  return conicBezierAt(ctrl[0], ctrl[1], ctrl[2], w, Math.max(0, Math.min(qMax, q)) / qMax)
}

/** Tessellation of a conic arc: uniform in t, then any chord longer than
 *  `step` is bisected until it is not (a heavy apex weight crowds the
 *  parameter toward the apex, so uniform t alone would leave long chords near
 *  the ends). First and last points are exactly the start and end. */
function tessellateConic(points: readonly Vec2[], step: number): Vec2[] {
  const { ctrl, w } = conicControl(points)
  const [s, a, e] = ctrl
  const at = (t: number) => conicBezierAt(s, a, e, w, t)
  const legs = Math.hypot(a.x - s.x, a.y - s.y) + Math.hypot(e.x - a.x, e.y - a.y)
  const base = Math.min(2 * MAX_SUB_PER_SEGMENT, Math.max(8, Math.ceil(legs / step)))
  const out: Vec2[] = [{ ...s }]
  const push = (t0: number, p0: Vec2, t1: number, p1: Vec2, depth: number): void => {
    if (depth < 12 && Math.hypot(p1.x - p0.x, p1.y - p0.y) > step) {
      const tm = (t0 + t1) / 2
      const pm = at(tm)
      push(t0, p0, tm, pm, depth + 1)
      push(tm, pm, t1, p1, depth + 1)
      return
    }
    out.push(p1)
  }
  let t0 = 0
  let p0: Vec2 = { ...s }
  for (let i = 1; i <= base; i++) {
    const t1 = i / base
    const p1 = i === base ? { ...e } : at(t1)
    push(t0, p0, t1, p1, 0)
    t0 = t1
    p0 = p1
  }
  return out
}

/** Points of a conic arc after a drag moved some of them (index -> new
 *  position). The conic's edit rule: dragging the start, apex or end keeps
 *  rho (the shoulder follows to the same fraction of the new median);
 *  dragging the shoulder sets rho -- it slides along the median, clamped to
 *  the drawable range. */
function conicDragEdit(points: readonly Vec2[], moved: ReadonlyMap<number, Vec2>): Vec2[] {
  const n = points.length
  const last = n - 1
  const at = (i: number): Vec2 => {
    const m = moved.get(i)
    return m ? { x: m.x, y: m.y } : { x: points[i].x, y: points[i].y }
  }
  const start = at(0), apex = at(1), end = at(last)
  let rho = conicRho(points)
  const sh = moved.get(2)
  if (sh) rho = conicRho([start, apex, sh, end])
  return conicPoints(start, apex, end, rho)
}

/** True when index `i` of a bezier chain of `n` points is an ANCHOR (on the
 *  curve). Every third point is; an open chain's last point is its end anchor
 *  even when the tail is short. */
export function bezierIsAnchor(i: number, n: number, closed: boolean): boolean {
  return i % 3 === 0 || (!closed && i === n - 1)
}

/** Anchor a handle belongs to, or null for an anchor: an out-handle (3k+1)
 *  belongs to the anchor before it, an in-handle (3k+2) to the anchor after
 *  it (a closed chain's last in-handle to points[0]). */
export function bezierHandleAnchor(i: number, n: number, closed: boolean): number | null {
  if (bezierIsAnchor(i, n, closed)) return null
  if (i % 3 === 1) return i - 1
  if (i + 1 < n) return i + 1
  return closed ? 0 : i - 2
}

/** The in- and out-handle indices of anchor `a` (null where the chain has
 *  none: an open chain's first anchor has no in-handle, its last no out). */
export function bezierAnchorHandles(
  a: number, n: number, closed: boolean,
): { in: number | null; out: number | null } {
  const inIdx = a > 0 ? a - 1 : closed && n > 2 ? n - 1 : null
  const outIdx = a + 1 < n ? a + 1 : null
  return {
    in: inIdx !== null && bezierHandleAnchor(inIdx, n, closed) === a ? inIdx : null,
    out: outIdx !== null && bezierHandleAnchor(outIdx, n, closed) === a ? outIdx : null,
  }
}

/** Anchor indices of a bezier chain in order. */
export function bezierAnchors(n: number, closed: boolean): number[] {
  const out: number[] = []
  for (let i = 0; i < n; i++) if (bezierIsAnchor(i, n, closed)) out.push(i)
  return out
}

/** Joint number of anchor `a` -- its index into the entity's `smooth` flags. */
export function bezierJointOf(a: number): number {
  return Math.floor(a / 3)
}

/** Joint numbers that have a handle on BOTH sides -- the only anchors where
 *  smooth vs corner means anything (interior anchors, plus points[0] of a
 *  closed chain). */
export function bezierJoints(n: number, closed: boolean): number[] {
  return bezierAnchors(n, closed)
    .filter((a) => {
      const h = bezierAnchorHandles(a, n, closed)
      return h.in !== null && h.out !== null
    })
    .map(bezierJointOf)
}

/** Handle `o` of anchor `a` turned to lie opposite handle `h` (collinear
 *  through the anchor), keeping its own length. Unchanged when `h` sits on
 *  the anchor (there is no direction to follow). */
function opposedHandle(a: Vec2, h: Vec2, o: Vec2): Vec2 {
  const hx = h.x - a.x, hy = h.y - a.y
  const hl = Math.hypot(hx, hy)
  if (hl < 1e-12) return { x: o.x, y: o.y }
  const ol = Math.hypot(o.x - a.x, o.y - a.y)
  return { x: a.x - (hx / hl) * ol, y: a.y - (hy / hl) * ol }
}

/**
 * Points of a direct-edit spline after a drag moved some of its points to
 * `moved` (index -> new position). Control-point splines: exactly the moved
 * points change. A conic arc (WO-1863) keeps its rho through a start/apex/end
 * drag and takes a new rho from a shoulder drag (conicDragEdit). Bezier chains apply the curve's own edit rule: an anchor
 * carries its handles with it, and a handle dragged at a SMOOTH joint turns
 * the joint's other handle to stay collinear (its length kept); at a corner
 * joint the other handle stays where it is. Nothing else moves.
 */
export function splineDragEdit(
  e: { points: readonly Vec2[]; closed: boolean; form?: SplineForm; smooth?: readonly boolean[] },
  moved: ReadonlyMap<number, Vec2>,
): Vec2[] {
  if (e.form === 'conic' && e.points.length >= 4) return conicDragEdit(e.points, moved)
  const pts = e.points.map((p) => ({ x: p.x, y: p.y }))
  const n = pts.length
  if (e.form !== 'bezier') {
    for (const [i, p] of moved) if (i >= 0 && i < n) pts[i] = { x: p.x, y: p.y }
    return pts
  }
  for (const [a, p] of moved) {
    if (a < 0 || a >= n || !bezierIsAnchor(a, n, e.closed)) continue
    const dx = p.x - e.points[a].x, dy = p.y - e.points[a].y
    pts[a] = { x: p.x, y: p.y }
    const h = bezierAnchorHandles(a, n, e.closed)
    for (const hi of [h.in, h.out]) {
      if (hi !== null && !moved.has(hi)) pts[hi] = { x: pts[hi].x + dx, y: pts[hi].y + dy }
    }
  }
  for (const [i, p] of moved) {
    const a = i >= 0 && i < n ? bezierHandleAnchor(i, n, e.closed) : null
    if (a === null) continue
    pts[i] = { x: p.x, y: p.y }
    if (!e.smooth?.[bezierJointOf(a)]) continue
    const h = bezierAnchorHandles(a, n, e.closed)
    const other = h.in === i ? h.out : h.in
    if (other === null || moved.has(other)) continue
    pts[other] = opposedHandle(pts[a], pts[i], pts[other])
  }
  return pts
}

/**
 * A bezier chain with joint `joint` (anchor 3 x joint) made smooth or returned
 * to a corner. Making it smooth turns the in-handle to lie opposite the
 * out-handle (lengths kept; the in-handle leads when the out-handle has zero
 * length), so the curve is tangent-continuous across the joint and handle
 * drags keep it so. A corner keeps the geometry exactly as it is and lets the
 * two handles move independently from then on. Anything else is returned
 * unchanged.
 */
export function bezierSetJointSmooth<T extends {
  points: Vec2[]; closed: boolean; form?: SplineForm; smooth?: boolean[]
}>(e: T, joint: number, smooth: boolean): T {
  const n = e.points.length
  const a = joint * 3
  if (e.form !== 'bezier' || a >= n) return e
  const count = bezierAnchors(n, e.closed).length
  const flags = Array.from({ length: count }, (_, k) => e.smooth?.[k] ?? false)
  flags[joint] = smooth
  const points = e.points.map((p) => ({ x: p.x, y: p.y }))
  const h = bezierAnchorHandles(a, n, e.closed)
  if (smooth && h.in !== null && h.out !== null) {
    const A = points[a]
    const outLen = Math.hypot(points[h.out].x - A.x, points[h.out].y - A.y)
    if (outLen > 1e-12) points[h.in] = opposedHandle(A, points[h.out], points[h.in])
    else points[h.out] = opposedHandle(A, points[h.in], points[h.out])
  }
  return { ...e, points, smooth: flags }
}

/** Evaluate the native spline at segment parameter q. Open splines use
 * [0, points.length-1], closed splines [0, points.length], for BOTH forms. */
export function splinePointAt(
  points: readonly Vec2[], closed: boolean, q: number, form: SplineForm = 'fit',
): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 }
  if (points.length === 1) return { ...points[0] }
  if (form === 'control') return controlPointAt(points, closed, q)
  if (form === 'bezier') return bezierPointAt(points, closed, q)
  if (form === 'conic' && points.length >= 4) return conicPointAt(points, q)
  const segCount = closed ? points.length : points.length - 1
  const clamped = Math.max(0, Math.min(segCount, q))
  const i = Math.min(segCount - 1, Math.floor(clamped))
  const u = clamped >= segCount ? 1 : clamped - i
  const [p0, p1, p2, p3] = controlsFor(points, closed, i)
  return segmentPoint(p0, p1, p2, p3, u)
}

/** Derivative of the native curve: exact (the hodograph) for a bezier chain,
 *  a stable central difference otherwise and wherever a bezier handle has
 *  zero length. */
export function splineDerivativeAt(
  points: readonly Vec2[], closed: boolean, q: number, form: SplineForm = 'fit',
): Vec2 {
  if (form === 'bezier' && points.length > 1) {
    const d = bezierDerivativeAt(points, closed, q)
    if (Math.hypot(d.x, d.y) > 1e-12) return d
  }
  const max = closed ? points.length : Math.max(0, points.length - 1)
  const h = Math.max(1e-5, max * 1e-6)
  const lo = Math.max(0, q - h), hi = Math.min(max, q + h)
  if (hi <= lo) return { x: 0, y: 0 }
  const a = splinePointAt(points, closed, lo, form)
  const b = splinePointAt(points, closed, hi, form)
  return { x: (b.x - a.x) / (hi - lo), y: (b.y - a.y) / (hi - lo) }
}

/** Nearest native parameter. Sampling seeds a continuous refinement; the
 * returned point is never taken from a tessellated approximation. */
export function nearestParamOnSpline(
  points: readonly Vec2[], closed: boolean, p: Vec2, form: SplineForm = 'fit',
): number {
  const max = closed ? points.length : Math.max(0, points.length - 1)
  if (max <= 0) return 0
  const samples = Math.max(32, Math.min(512, Math.ceil(max * 48)))
  const d2 = (q: number): number => {
    const at = splinePointAt(points, closed, q, form)
    return (at.x - p.x) ** 2 + (at.y - p.y) ** 2
  }
  let best = 0, bestD = Infinity
  for (let i = 0; i <= samples; i++) {
    const q = max * i / samples, d = d2(q)
    if (d < bestD) { best = q; bestD = d }
  }
  const span = max / samples
  let lo = Math.max(0, best - span), hi = Math.min(max, best + span)
  const gr = (Math.sqrt(5) - 1) / 2
  let a = hi - gr * (hi - lo), b = lo + gr * (hi - lo)
  for (let i = 0; i < 36; i++) {
    if (d2(a) < d2(b)) { hi = b; b = a; a = hi - gr * (hi - lo) }
    else { lo = a; a = b; b = lo + gr * (hi - lo) }
  }
  return (lo + hi) / 2
}

/**
 * Tessellate the spline to a polyline. An OPEN spline returns the through-
 * points joined by curve samples, first point first, last point last (no
 * duplicate). A CLOSED spline appends the wrap segment back to points[0], so
 * the last point EQUALS the first (a closed polyline ready for line
 * rendering, mirroring tessellateEllipse). Fewer than 2 points returns the
 * points verbatim. A CONTROL-form spline returns curve samples only (the
 * curve does not pass through its interior control points) under the same
 * first/last conventions.
 */
export function tessellateSpline(
  points: readonly Vec2[], closed: boolean, step: number = SPLINE_TESS_STEP_MM,
  form: SplineForm = 'fit',
): Vec2[] {
  const pts = points.map((p) => ({ x: p.x, y: p.y }))
  const n = pts.length
  if (n < 2) return pts
  if (form === 'control') return tessellateControlSpline(pts, closed, step)
  if (form === 'bezier') return tessellateBezierChain(pts, closed, step)
  if (form === 'conic' && n >= 4) return tessellateConic(pts, step)
  const segCount = closed ? n : n - 1
  const out: Vec2[] = [{ ...pts[0] }]
  for (let i = 0; i < segCount; i++) {
    const [p0, p1, p2, p3] = controlsFor(pts, closed, i)
    const segLen = Math.hypot(p2.x - p1.x, p2.y - p1.y)
    const sub = Math.min(MAX_SUB_PER_SEGMENT, Math.max(1, Math.ceil(segLen / step)))
    for (let j = 1; j <= sub; j++) out.push(segmentPoint(p0, p1, p2, p3, j / sub))
  }
  return out
}

/**
 * Control-point (through-point) marker positions for a committed spline, used
 * by the sketch layer to draw persistent handles when the points/constraint
 * display flag is on. Pure and headless-testable: returns a fresh copy of the
 * through-points when `visible`, else an empty list (so the render pass can
 * gate on the SAME flag it uses for other point glyphs without branching).
 * On a through-point spline the markers are a visibility aid; on a
 * control-point spline (WO-1861) the layer always shows them and each one is
 * a drag handle (splineControlPointDragTarget).
 */
export function splineControlMarkers(
  points: readonly Vec2[], visible: boolean,
): Vec2[] {
  if (!visible) return []
  return points.map((p) => ({ x: p.x, y: p.y }))
}

/**
 * Nearest point on the spline curve to `p`, found by sampling the polyline
 * and projecting onto each chord. Accurate to well under the tessellation
 * chord for snapping/picking; not a closed-form minimum-distance solve (not
 * needed -- the spline is solver-inert, this only drives snap/pick).
 */
export function nearestPointOnSpline(
  points: readonly Vec2[], closed: boolean, p: Vec2, form: SplineForm = 'fit',
): { point: Vec2; dist: number } {
  const poly = tessellateSpline(points, closed, SPLINE_TESS_STEP_MM, form)
  if (poly.length === 0) return { point: { x: p.x, y: p.y }, dist: Infinity }
  if (poly.length === 1) {
    return { point: { ...poly[0] }, dist: Math.hypot(poly[0].x - p.x, poly[0].y - p.y) }
  }
  let best: { point: Vec2; dist: number } = { point: { ...poly[0] }, dist: Infinity }
  for (let i = 0; i + 1 < poly.length; i++) {
    const a = poly[i], b = poly[i + 1]
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
    t = Math.max(0, Math.min(1, t))
    const q = { x: a.x + t * dx, y: a.y + t * dy }
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d < best.dist) best = { point: q, dist: d }
  }
  return best
}

// ---- Control-point editing (WO-1861) ----------------------------------------

/** The control polygon of a control-point spline as a polyline (a closed
 *  spline's polygon returns to points[0]). Drawn so the operator sees what
 *  each control point is pulling on. */
export function splineControlPolygon(points: readonly Vec2[], closed: boolean): Vec2[] {
  const out = points.map((p) => ({ x: p.x, y: p.y }))
  if (closed && out.length > 2) out.push({ ...out[0] })
  return out
}

/** Index of the control point nearest `p` within `tol`, or null. Ties go to
 *  the lower index. */
export function splineControlPointNear(
  points: readonly Vec2[], p: Vec2, tol: number,
): number | null {
  let best: number | null = null
  let bestD = Infinity
  for (let i = 0; i < points.length; i++) {
    const d = Math.hypot(points[i].x - p.x, points[i].y - p.y)
    if (d <= tol && d < bestD) { best = i; bestD = d }
  }
  return best
}

/** Solver site naming control point `index` of a control-point spline. These
 *  sites exist only while a drag names them (gcsMapping materializes them on
 *  demand); a stored constraint never references one. */
export function splineControlSite(index: number): `cp${number}` {
  return `cp${index}`
}

/** Control-point index a site names, or null for any other site. */
export function splineControlSiteIndex(site: string): number | null {
  const m = /^cp(\d+)$/.exec(site)
  return m ? Number(m[1]) : null
}

/** True for the spline forms whose every point is a drag handle: the
 *  control-point spline (WO-1861), the bezier chain (WO-1862: anchors and
 *  handles) and the conic arc (WO-1863: start, apex, shoulder, end). A
 *  through-point spline is not one of them. */
export function splineHasControlSites(form: SplineForm | undefined): boolean {
  return form === 'control' || form === 'bezier' || form === 'conic'
}

/** The drag target for a grab on a control-point spline or a bezier chain:
 *  the point under the grab (within `tol`) as its own solver site, so dragging
 *  it moves that point (a bezier anchor carries its handles -- splineDragEdit).
 *  Null for a through-point spline or a grab away from every point (the host
 *  then applies its whole-entity drag). Ties go to the lower index; on a
 *  bezier an ANCHOR wins a tie, so a zero-length handle sitting on its anchor
 *  grabs the anchor (and the anchor carries it). */
export function splineControlPointDragTarget(
  e: { id: string; points: readonly Vec2[]; form?: SplineForm; closed?: boolean },
  grab: Vec2, tol: number,
): { point: { entityId: string; site: `cp${number}` }; orig: Vec2 } | null {
  if (!splineHasControlSites(e.form)) return null
  let index = splineControlPointNear(e.points, grab, tol)
  if (index === null) return null
  if (e.form === 'bezier') {
    const n = e.points.length
    const a = bezierHandleAnchor(index, n, e.closed ?? false)
    if (a !== null && Math.hypot(e.points[a].x - e.points[index].x, e.points[a].y - e.points[index].y) < 1e-9) {
      index = a
    }
  }
  return { point: { entityId: e.id, site: splineControlSite(index) }, orig: { ...e.points[index] } }
}

/** A control-point spline or bezier chain re-expressed as the through-point
 *  spline that traces the same curve (dense samples of the exact curve). Used
 *  where an operation only knows how to rebuild a through-point spline -- a
 *  fillet trimming one at a tangent point. A through-point spline is returned
 *  as-is. */
export function splineAsThroughPoints<T extends {
  points: Vec2[]; closed: boolean; form?: SplineForm; smooth?: boolean[]
}>(
  e: T,
): T {
  if (!splineHasControlSites(e.form) || e.points.length < 2) return e
  const n = e.points.length
  const qMax = e.closed ? n : n - 1
  const count = Math.max(32, Math.min(600, Math.ceil(qMax * 200)))
  const pts: Vec2[] = []
  // A closed curve's last sample would repeat the first; the closed flag wraps.
  const last = e.closed ? count - 1 : count
  for (let i = 0; i <= last; i++) pts.push(splinePointAt(e.points, e.closed, (qMax * i) / count, e.form))
  const { form: _form, smooth: _smooth, ...rest } = e
  void _form
  void _smooth
  return { ...rest, points: pts } as T
}

/** What the sketch layer draws between a direct-edit spline's handles: the
 *  whole control polygon for a control-point spline, the apex legs and the
 *  shoulder's median for a conic arc (WO-1863), and for a bezier chain
 *  one leg per anchor from its in-handle through the anchor to its out-handle
 *  (the polygon between two handles means nothing on a bezier). Empty for a
 *  through-point spline. */
export function splineHandleLegs(
  points: readonly Vec2[], closed: boolean, form: SplineForm | undefined,
): Vec2[][] {
  if (form === 'control') return [splineControlPolygon(points, closed)]
  if (form === 'conic' && points.length >= 4) {
    // The two apex legs the arc is tangent to at its ends, and the median
    // from the chord midpoint to the apex the shoulder slides along.
    const s = points[0], a = points[1], e = points[points.length - 1]
    return [
      [{ ...s }, { ...a }, { ...e }],
      [{ x: (s.x + e.x) / 2, y: (s.y + e.y) / 2 }, { ...a }],
    ]
  }
  if (form !== 'bezier') return []
  const n = points.length
  const legs: Vec2[][] = []
  for (const a of bezierAnchors(n, closed)) {
    const h = bezierAnchorHandles(a, n, closed)
    const leg: Vec2[] = []
    if (h.in !== null) leg.push({ ...points[h.in] })
    leg.push({ ...points[a] })
    if (h.out !== null) leg.push({ ...points[h.out] })
    if (leg.length > 1) legs.push(leg)
  }
  return legs
}

/** The bezier JOINTS a selection holds (anchors with a handle on both sides),
 *  and whether every one is already smooth. Null when no selected entity is a
 *  bezier chain with a joint. Shared by both hosts' Smooth / Corner row and
 *  the engine action, so the row never offers what the action would refuse. */
export function bezierJointSummary(
  entities: ReadonlyArray<{ id: string; kind: string; points?: readonly Vec2[]; closed?: boolean;
    form?: SplineForm; smooth?: readonly boolean[] }>,
  selectedIds: readonly string[],
): { entityIds: string[]; joints: number; allSmooth: boolean } | null {
  const selected = new Set(selectedIds)
  const entityIds: string[] = []
  let joints = 0
  let allSmooth = true
  for (const e of entities) {
    if (e.kind !== 'spline' || e.form !== 'bezier' || !e.points || !selected.has(e.id)) continue
    const js = bezierJoints(e.points.length, e.closed ?? false)
    if (js.length === 0) continue
    entityIds.push(e.id)
    joints += js.length
    if (js.some((j) => !e.smooth?.[j])) allSmooth = false
  }
  return entityIds.length > 0 ? { entityIds, joints, allSmooth } : null
}

/** The conic arcs a selection holds (WO-1863) and their rho -- the first
 *  one's, with `mixed` set when they differ. Null when no selected entity is
 *  a conic. Shared by both hosts' rho row and the engine action. */
export function conicSelectionSummary(
  entities: ReadonlyArray<{ id: string; kind: string; points?: readonly Vec2[]; form?: SplineForm }>,
  selectedIds: readonly string[],
): { entityIds: string[]; rho: number; mixed: boolean } | null {
  const selected = new Set(selectedIds)
  const entityIds: string[] = []
  let rho = 0.5
  let mixed = false
  for (const e of entities) {
    if (e.kind !== 'spline' || e.form !== 'conic' || !e.points || e.points.length < 4) continue
    if (!selected.has(e.id)) continue
    const r = conicRho(e.points)
    if (entityIds.length === 0) rho = r
    else if (Math.abs(r - rho) > 1e-9) mixed = true
    entityIds.push(e.id)
  }
  return entityIds.length > 0 ? { entityIds, rho, mixed } : null
}
