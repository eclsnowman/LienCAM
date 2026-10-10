// Pure ellipse / elliptical-arc geometry (Tier 2a sketch entities).
//
// PURE and headless-testable: no store, no three.js, no DOM, no planegcs.
// The single source of truth for every ellipse computation the rest of the
// sketch stack needs -- point-at-parameter, tessellation, bounds, quadrant
// points, and nearest-point projection (snap/pick). Mirrors the role
// circleTools.circumcircle plays for circles/arcs.
//
// PARAMETERIZATION (eccentric angle): a point on the ellipse at parameter
// t (radians) is, in the ellipse's OWN axis frame,
//     (majorRadius * cos t, minorRadius * sin t)
// then rotated by `rotation` (CCW radians, major axis from +X) and
// translated to `center`. So t = 0 is the +major-axis vertex, t = PI/2 the
// +minor-axis co-vertex, etc. An elliptical arc sweeps CCW from startParam
// to endParam in this same parameter space (matching the arc CCW convention
// in types.ts).

import type { Vec2 } from '../../types'

const TWO_PI = Math.PI * 2

/** Minimal ellipse shape (both the full ellipse and the arc carry these). */
export interface EllipseShape {
  center: Vec2
  majorRadius: number
  minorRadius: number
  /** Rotation of the major axis from +X, CCW radians. */
  rotation: number
}

/** Normalize an angle into [0, 2*PI). */
function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

/** Point on the ellipse at eccentric parameter `t` (radians). */
export function ellipsePointAt(e: EllipseShape, t: number): Vec2 {
  const c = Math.cos(e.rotation)
  const s = Math.sin(e.rotation)
  const x = e.majorRadius * Math.cos(t)
  const y = e.minorRadius * Math.sin(t)
  return {
    x: e.center.x + x * c - y * s,
    y: e.center.y + x * s + y * c,
  }
}

/** First derivative with respect to eccentric parameter t. */
export function ellipseDerivativeAt(e: EllipseShape, t: number): Vec2 {
  const c = Math.cos(e.rotation), s = Math.sin(e.rotation)
  const x = -e.majorRadius * Math.sin(t)
  const y = e.minorRadius * Math.cos(t)
  return { x: x * c - y * s, y: x * s + y * c }
}

/**
 * Eccentric parameter `t` of the point on the ellipse whose direction (in
 * the ellipse's own axis frame) matches `p`. Inverse of ellipsePointAt for
 * points ON the curve; for points OFF the curve it returns the parameter
 * whose radial direction in normalized (lx/a, ly/b) space points at `p`
 * -- i.e. the angle pick gesture, exactly like the center-arc tool reads
 * atan2 of the click relative to the center (the click need not sit on the
 * curve). Returns a value in [0, 2*PI).
 */
export function ellipseParamFromPoint(e: EllipseShape, p: Vec2): number {
  const c = Math.cos(e.rotation)
  const s = Math.sin(e.rotation)
  const dx = p.x - e.center.x
  const dy = p.y - e.center.y
  // World-relative -> ellipse axis frame (rotate by -rotation).
  const lx = dx * c + dy * s
  const ly = -dx * s + dy * c
  const a = e.majorRadius || 1
  const b = e.minorRadius || 1
  return norm(Math.atan2(ly / b, lx / a))
}

/** Ramanujan II perimeter approximation (used to pick a segment count). */
export function ellipsePerimeter(a: number, b: number): number {
  const ra = Math.abs(a)
  const rb = Math.abs(b)
  if (ra + rb === 0) return 0
  const h = ((ra - rb) ** 2) / ((ra + rb) ** 2)
  return Math.PI * (ra + rb) * (1 + (3 * h) / (10 + Math.sqrt(4 - 3 * h)))
}

// Chord step (mm) for tessellation -- matches the sketch arc chord budget
// closely enough for screen rendering and bake polylines.
const TESS_STEP_MM = 0.3

/** Adaptive segment count for a (sub)sweep of the ellipse. */
export function ellipseSegmentCount(e: EllipseShape, sweep: number = TWO_PI): number {
  const frac = Math.min(1, Math.abs(sweep) / TWO_PI)
  const peri = ellipsePerimeter(e.majorRadius, e.minorRadius) * frac
  return Math.min(512, Math.max(16, Math.ceil(peri / TESS_STEP_MM)))
}

/**
 * Closed tessellation of a full ellipse. Returns segments+1 points with the
 * last point EQUAL to the first (a closed polyline ready for line rendering),
 * mirroring tessellateCircle in the sketch layer.
 */
export function tessellateEllipse(e: EllipseShape, segments?: number): Vec2[] {
  const n = segments ?? ellipseSegmentCount(e)
  const pts: Vec2[] = []
  for (let i = 0; i <= n; i++) pts.push(ellipsePointAt(e, (TWO_PI * i) / n))
  return pts
}

/** CCW sweep of an elliptical arc (startParam -> endParam), in (0, 2*PI]. */
export function ellipticalArcSweep(startParam: number, endParam: number): number {
  let s = endParam - startParam
  while (s <= 0) s += TWO_PI
  return s
}

/**
 * CCW sweep on the RAW parameter delta, in [0, 2*PI) -- never remapped to a
 * full turn the way `ellipticalArcSweep` (point-sampling only) deliberately
 * treats a non-positive delta. An exactly start===end elliptical arc is a
 * zero-length degenerate, not a full ellipse -- the single source bake and
 * the 3D-workbench sketch profile share for classifying an ALREADY-STORED
 * (startParam, endParam) pair. Creation time is different: a user click
 * lands on a continuous world point, so its mapped parameter is never
 * bit-exact even along an intentional same-ray click (BUG-494) -- the
 * click-5 guard in ellipseTools.ts instead measures curve-point distance
 * against the same closeTol every other click guard uses.
 */
export function ellipticalArcSweepRaw(startParam: number, endParam: number): number {
  return ((endParam - startParam) % TWO_PI + TWO_PI) % TWO_PI
}

/** Degenerate-sweep tolerance (radians) for classifying an ALREADY-STORED
 *  (startParam, endParam) pair: bake and the 3D-workbench sketch profile. */
export const ELLIPTICAL_ARC_DEGENERATE_EPS = 1e-9

/**
 * Tessellation of an elliptical arc from startParam sweeping CCW to endParam.
 * Returns segments+1 points; first/last are the two arc endpoints (an OPEN
 * polyline).
 */
export function tessellateEllipticalArc(
  e: EllipseShape, startParam: number, endParam: number, segments?: number,
): Vec2[] {
  const sweep = ellipticalArcSweep(startParam, endParam)
  const n = segments ?? ellipseSegmentCount(e, sweep)
  const pts: Vec2[] = []
  for (let i = 0; i <= n; i++) pts.push(ellipsePointAt(e, startParam + (sweep * i) / n))
  return pts
}

/** The four quadrant points (t = 0, 90, 180, 270 deg): +major, +minor,
 *  -major, -minor vertices. */
export function ellipseQuadrants(e: EllipseShape): Vec2[] {
  return [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2].map((t) => ellipsePointAt(e, t))
}

/**
 * The FOCUS points of the ellipse: center +- c along the LONGER axis, with
 * c = sqrt(|a^2 - b^2|). The draw tool never clamps minorRadius <= majorRadius
 * (ellipseFromClicks takes a free perpendicular distance), so an entity can
 * legitimately carry majorRadius < minorRadius — the true long axis is then
 * the "minor" one and the foci ride the rotation+90deg direction instead.
 *
 * Degenerate circle (a == b exactly): both foci COLLAPSE onto the center —
 * returns ONE point (the center) explicitly, never a NaN pair (ADR-0003:
 * no silent NaN). Non-finite input throws (fail-loud).
 */
export function ellipseFoci(e: EllipseShape): Vec2[] {
  const a = Math.abs(e.majorRadius)
  const b = Math.abs(e.minorRadius)
  if (
    !Number.isFinite(a) || !Number.isFinite(b) || !Number.isFinite(e.rotation) ||
    !Number.isFinite(e.center.x) || !Number.isFinite(e.center.y)
  ) {
    throw new Error(
      `ellipseFoci: non-finite ellipse (a=${e.majorRadius}, b=${e.minorRadius}, ` +
      `rot=${e.rotation}, center=${e.center.x},${e.center.y})`,
    )
  }
  const diff = a * a - b * b
  if (diff === 0) return [{ x: e.center.x, y: e.center.y }] // circle: collapsed
  const c = Math.sqrt(Math.abs(diff))
  // diff > 0: long axis IS the major axis (rotation); diff < 0: swapped.
  const ang = diff > 0 ? e.rotation : e.rotation + Math.PI / 2
  const dx = c * Math.cos(ang)
  const dy = c * Math.sin(ang)
  return [
    { x: e.center.x + dx, y: e.center.y + dy },
    { x: e.center.x - dx, y: e.center.y - dy },
  ]
}

/**
 * Position of ONE addressable focus site ('focus1' = center + c along the
 * long axis, 'focus2' = center - c; see ellipseFoci for the axis-swap and
 * fail-loud rules). Circle-degenerate (collapsed foci): BOTH sites resolve
 * to the single collapsed point (the center) — a saved focus ref stays
 * resolvable when the ellipse later degenerates via a radius edit.
 * Single source for every focus-site consumer (render resolvePointRef, the
 * dim tool, snap enumeration, and the gcs mapping's materialized points).
 */
export function ellipseFocusSite(e: EllipseShape, site: 'focus1' | 'focus2'): Vec2 {
  const f = ellipseFoci(e)
  return site === 'focus1' ? f[0] : (f[1] ?? f[0])
}

/**
 * New {majorRadius, minorRadius} for a DIRECT focus-to-focus edit: given a
 * target inter-focal distance 2c (`focalDistance`), resize the FOCI-BEARING
 * (longer) semi-axis to a = sqrt(c^2 + b^2) while keeping the OTHER (shorter)
 * semi-axis, the rotation and the center fixed -- the inverse of ellipseFoci's
 * c = sqrt(|a^2 - b^2|). The foci ride the LONGER stored axis (majorRadius when
 * |majorRadius| >= |minorRadius|, else minorRadius -- the draw tool never clamps
 * major >= minor, so a legit entity can carry major < minor), so THAT axis is
 * the one rewritten; enlarging it by the short axis keeps it the longer one, so
 * the foci arrangement is preserved (and a would-be circle heals to a proper
 * ellipse). PURE: callers guard the degenerate 2c <= 0 / non-finite case (a
 * focus-to-focus dim needs two DISTINCT foci); this never introduces a NaN for
 * a finite input but a non-positive 2c is meaningless and must be rejected
 * upstream (ADR-0003, no silent fallback).
 */
export function ellipseRadiiForFocalDistance(
  e: EllipseShape, focalDistance: number,
): { majorRadius: number; minorRadius: number } {
  const A = Math.abs(e.majorRadius)
  const B = Math.abs(e.minorRadius)
  const c = focalDistance / 2
  if (A >= B) {
    // Major is the foci-bearing (long) axis: rewrite it, minor is the short b.
    return { majorRadius: Math.sqrt(c * c + B * B), minorRadius: e.minorRadius }
  }
  // Axis-swap: minor is the longer, foci-bearing axis; major is the short b.
  return { majorRadius: e.majorRadius, minorRadius: Math.sqrt(c * c + A * A) }
}

/** Extra world-mm the label rides PAST the axis vertex so it always clears
 *  the ellipse outline (used only when the drop lands inside the vertex). */
export const AXIS_LABEL_CLEARANCE_MM = 2

/**
 * On-axis leader geometry for a major/minor RADIUS dimension. Given the raw
 * label anchor (the free cursor / dragged label position), return a leader that
 * lies ALONG the chosen axis (respecting the ellipse rotation) instead of at an
 * arbitrary angle toward wherever the label was dropped:
 *   - `dir`    the axis unit direction, flipped to the SIDE the anchor was
 *              dropped toward (so the label stays on the near end of the axis),
 *   - `vertex` the axis VERTEX (center + radius*dir) -- where the leader meets
 *              the outline,
 *   - `label`  the label point, the anchor PROJECTED onto the axis line and
 *              pushed to at least the vertex (+ a small clearance) so it never
 *              overlaps the outline.
 * Shared by the placement preview (dimPlacement.dimGuides), the committed
 * leader render (sketchLayer.buildDimensionGraphics) and the label placement
 * (sketchLayer.dimensionDisplay) so all three stay on-axis and in lockstep
 * (preview === commit). Idempotent: feeding back an already-on-axis label
 * returns the same geometry.
 */
export function ellipseAxisDimLeader(
  e: EllipseShape, axis: 'major' | 'minor', anchor: Vec2,
): { dir: Vec2; vertex: Vec2; label: Vec2 } {
  const ang = axis === 'major' ? e.rotation : e.rotation + Math.PI / 2
  const r = axis === 'major' ? e.majorRadius : e.minorRadius
  let dir = { x: Math.cos(ang), y: Math.sin(ang) }
  // Which end of the axis was the label dropped toward? (default +axis).
  const proj = (anchor.x - e.center.x) * dir.x + (anchor.y - e.center.y) * dir.y
  if (proj < 0) dir = { x: -dir.x, y: -dir.y }
  const vertex = { x: e.center.x + dir.x * r, y: e.center.y + dir.y * r }
  // Label rides the axis at the drop distance, but never inside the vertex
  // (+ clearance) so it clears the outline.
  const d = Math.max(Math.abs(proj), r + AXIS_LABEL_CLEARANCE_MM)
  const label = { x: e.center.x + dir.x * d, y: e.center.y + dir.y * d }
  return { dir, vertex, label }
}

/** Axis-aligned bounding box of the (possibly rotated) full ellipse. */
export function ellipseBounds(
  e: EllipseShape,
): { minX: number; minY: number; maxX: number; maxY: number } {
  const c = Math.cos(e.rotation)
  const s = Math.sin(e.rotation)
  // Half-extents of a rotated ellipse (envelope of the parametric form).
  const hx = Math.hypot(e.majorRadius * c, e.minorRadius * s)
  const hy = Math.hypot(e.majorRadius * s, e.minorRadius * c)
  return {
    minX: e.center.x - hx, maxX: e.center.x + hx,
    minY: e.center.y - hy, maxY: e.center.y + hy,
  }
}

/**
 * Nearest point on the (full) ellipse curve to `p`: coarse parameter sample
 * then a few golden-section refinement steps. Returns the parameter, the
 * point, and the distance. Accurate to well under the tessellation chord for
 * snapping/picking; not a closed-form minimum-distance solve (not needed --
 * the ellipse is solver-inert, this only drives snap/pick tolerances).
 */
export function nearestPointOnEllipse(
  e: EllipseShape, p: Vec2,
): { t: number; point: Vec2; dist: number } {
  const d2 = (t: number): number => {
    const q = ellipsePointAt(e, t)
    const dx = q.x - p.x
    const dy = q.y - p.y
    return dx * dx + dy * dy
  }
  // Coarse sweep.
  const COARSE = 64
  let bestT = 0
  let bestD = Infinity
  for (let i = 0; i < COARSE; i++) {
    const t = (TWO_PI * i) / COARSE
    const d = d2(t)
    if (d < bestD) { bestD = d; bestT = t }
  }
  // Golden-section refine within +/- one coarse step.
  const span = TWO_PI / COARSE
  let lo = bestT - span
  let hi = bestT + span
  const gr = (Math.sqrt(5) - 1) / 2
  let c = hi - gr * (hi - lo)
  let d = lo + gr * (hi - lo)
  let fc = d2(c)
  let fd = d2(d)
  for (let i = 0; i < 40; i++) {
    if (fc < fd) { hi = d; d = c; fd = fc; c = hi - gr * (hi - lo); fc = d2(c) }
    else { lo = c; c = d; fc = fd; d = lo + gr * (hi - lo); fd = d2(d) }
  }
  const t = norm((lo + hi) / 2)
  const point = ellipsePointAt(e, t)
  return { t, point, dist: Math.hypot(point.x - p.x, point.y - p.y) }
}

/** Distance from `p` to an elliptical arc curve: nearest point on the full
 *  ellipse if its parameter lies within the arc sweep, else the nearer of the
 *  two arc endpoints (mirrors snap.curveDistance's arc handling). */
export function distanceToEllipticalArc(
  e: EllipseShape, startParam: number, endParam: number, p: Vec2,
): number {
  const near = nearestPointOnEllipse(e, p)
  const sweep = ellipticalArcSweep(startParam, endParam)
  const rel = norm(near.t - startParam)
  if (rel <= sweep + 1e-9) return near.dist
  const s = ellipsePointAt(e, startParam)
  const en = ellipsePointAt(e, endParam)
  return Math.min(Math.hypot(p.x - s.x, p.y - s.y), Math.hypot(p.x - en.x, p.y - en.y))
}
