// Snap engine (Stage 3 chunk 3, PLAN.md 3.4 always-on inference + 3.5
// UTILITY snap toggles).
//
// PURE and headless-testable: no store, no three.js, no DOM. Given the
// cursor's world position, the sketch entities, the grid spacing, the
// in-progress tool context (the chain's previous point for H/V alignment)
// and the enabled-snap flags, findSnap() returns the single best snap
// candidate or null. The viewport renders the result (marker + guide +
// inference badge) and every armed tool's click/preview lands on
// result.point instead of the raw cursor.
//
// Priority (PLAN 3.4): ENTITY snaps (endpoint / midpoint / center /
// intersection) beat ALIGNMENT (h-align / v-align) beat GRID. Within the
// entity tier the nearest candidate wins; exact ties fall back to the
// kind order endpoint > midpoint > center > intersection. The snap radius
// is specified in SCREEN PIXELS and converted with worldPerPixel so the
// feel is zoom-invariant.
//
// `inferences` carries the constraint(s) the click WILL create if it
// commits (previewed as badges at the cursor BEFORE the click, per PLAN
// 3.4). inference.ts converts them into real document constraints at
// commit time; with the inference flag off the snap still positions the
// click but carries no inferences.

import type {
  Vec2, SketchEntity, PointRef, SketchEllipseEntity, SketchEllipticalArcEntity,
} from './types'
import type { ToolChainState } from './tools/toolMachine'
import {
  nearestPointOnEllipse, distanceToEllipticalArc, ellipseQuadrants, ellipsePointAt,
  ellipseParamFromPoint, ellipticalArcSweep, ellipseFoci,
} from './ellipse'
import type { EllipseShape } from './ellipse'
import { projectToCurve } from './dragSnap'
import { isInjectedSketchAnchorId } from './sketchAnchors'
import { bezierIsAnchor, nearestPointOnSpline, tessellateSpline } from './spline'
import { distanceToText } from './text'
import { SKETCH_AXIS_X_ENTITY_ID, SKETCH_AXIS_Y_ENTITY_ID } from './sketchAnchors'

export type SnapKind =
  | 'endpoint'
  | 'midpoint'
  | 'center'
  | 'quadrant'
  | 'intersection'
  | 'curve'
  | 'grid'
  | 'h-align'
  | 'v-align'

/** A constraint the committing click will create. References EXISTING
 *  document entities only; the new-geometry side is resolved at commit
 *  time by inference.ts (the entity does not exist yet while previewing).
 *
 *  horizontal / vertical come in two flavors (matching the document
 *  constraint, types.ts): WITHOUT `to` they apply to the new LINE whose
 *  endpoints are the alignment pair (chain-previous alignment); WITH `to`
 *  they become the two-point variant between the new point site and an
 *  EXISTING point (hover-wake remote alignment). */
export type SnapInference =
  | { kind: 'coincident'; to: PointRef }
  | { kind: 'midpoint'; line: string }
  | { kind: 'point_on_object'; object: string }
  | { kind: 'horizontal'; to?: PointRef }
  | { kind: 'vertical'; to?: PointRef }
  | { kind: 'grid' }

export interface SnapResult {
  /** Snapped world position — clicks and previews land HERE. */
  point: Vec2
  kind: SnapKind
  /** Existing entities this snap derives from (marker/glow targets). */
  sourceEntityIds: string[]
  /** Pending constraints (badge preview now, real constraints on commit). */
  inferences: SnapInference[]
  /** h/v-align only: the reference point the dashed guide is drawn from.
   *  When a chain-previous alignment participates this is ALWAYS the
   *  chain point (inference.ts resolves the new line against it). */
  alignFrom?: Vec2
  /** Dual H+V alignment only: the SECOND guide's source point. */
  alignFrom2?: Vec2
  /** Point-site snaps (endpoint/midpoint/center): the spot the cursor is
   *  hovering — what hover-wake records as an alignment reference. */
  wake?: WokenRef
}

// ---- Hover-wake alignment references --------
//
// While a drawing tool is armed, hovering a snappable point WAKES it: the
// point joins a small most-recent set and contributes remote H/V
// alignment candidates as the cursor moves away (dashed guide from the
// woken point, virtual snap pinning the shared coordinate). The set is
// owned by the store (cleared on commit / tool change / Esc / disarm);
// the pure semantics live here so they are headless-testable.

export interface WokenRef {
  /** World position of the woken point (guide origin, pinned coordinate). */
  point: Vec2
  /** Addressable point site for the committed two-point H/V constraint.
   *  null = the spot has no solver point (a line's MIDPOINT): it still
   *  aligns positionally but commits no constraint. */
  ref: PointRef | null
}

/** Most-recent woken references kept (waking another drops the oldest). */
export const WAKE_CAP = 3

function wakeKey(w: WokenRef): string {
  return w.ref ? `${w.ref.entityId}:${w.ref.site}` : `@${w.point.x},${w.point.y}`
}

/**
 * Wake a reference (pure). Most-recent-last ordering: re-waking an already
 * woken ref refreshes its recency; exceeding WAKE_CAP drops the oldest.
 * Returns the SAME array when nothing changes (already most recent) so the
 * store can cheaply skip a state update per pointermove.
 */
export function wakeRef(
  set: readonly WokenRef[], woken: WokenRef,
): readonly WokenRef[] {
  const key = wakeKey(woken)
  const last = set[set.length - 1]
  if (last && wakeKey(last) === key) return set // already most recent
  const without = set.filter((w) => wakeKey(w) !== key)
  const next = [...without, woken]
  return next.length > WAKE_CAP ? next.slice(next.length - WAKE_CAP) : next
}

export interface SnapFlags {
  /** Endpoint / midpoint / center / intersection snaps. */
  entity: boolean
  /** Snap to grid multiples. */
  grid: boolean
  /** H/V alignment guides + auto-constraint creation on commit. */
  inference: boolean
}

export const DEFAULT_SNAP_FLAGS: SnapFlags = {
  entity: true,
  grid: false,
  inference: true,
}

/** Snap radius in screen pixels (slightly wider than the 8 px pick
 *  tolerance — snapping should feel magnetic, picking precise). */
export const SNAP_PX = 10

export interface SnapQuery {
  cursor: Vec2
  entities: readonly SketchEntity[]
  /** Grid pitch in mm (shared with the viewport's drawn grid). */
  gridSpacing: number
  /** World mm per screen pixel (orthographic top-down sketch camera). */
  worldPerPixel: number
  /** Reference point for H/V alignment (line chain's previous point);
   *  null/undefined disables alignment snaps. */
  alignRef?: Vec2 | null
  /** Hover-woken reference points (store-owned set): each contributes
   *  remote H/V alignment candidates alongside alignRef. */
  wokenRefs?: readonly WokenRef[]
  flags?: SnapFlags
  /** Override the snap radius (pixels). */
  snapPx?: number
}

// ---- Geometry helpers -------------------------------------------------------

const TWO_PI = Math.PI * 2

function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

function d2(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x
  const dy = a.y - b.y
  return dx * dx + dy * dy
}

function arcPoint(center: Vec2, radius: number, angle: number): Vec2 {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }
}

/** Is `angle` inside the CCW sweep [startAngle, endAngle]? Small angular
 *  slack keeps intersections AT an arc endpoint from flickering out. */
function angleOnArc(angle: number, startAngle: number, endAngle: number): boolean {
  const sweep = norm(endAngle - startAngle)
  const rel = norm(angle - startAngle)
  const slack = 1e-9
  return rel <= sweep + slack
}

/** Shortest distance from p to an entity's curve (for bounding the
 *  intersection search). Point entities measure to the point itself. */
export function curveDistance(e: SketchEntity, p: Vec2): number {
  switch (e.kind) {
    case 'point':
      return Math.hypot(p.x - e.at.x, p.y - e.at.y)
    case 'line': {
      const dx = e.end.x - e.start.x
      const dy = e.end.y - e.start.y
      const len2 = dx * dx + dy * dy
      let t = len2 > 0 ? ((p.x - e.start.x) * dx + (p.y - e.start.y) * dy) / len2 : 0
      t = Math.max(0, Math.min(1, t))
      return Math.hypot(p.x - (e.start.x + t * dx), p.y - (e.start.y + t * dy))
    }
    case 'circle':
      return Math.abs(Math.hypot(p.x - e.center.x, p.y - e.center.y) - e.radius)
    case 'arc': {
      const ang = Math.atan2(p.y - e.center.y, p.x - e.center.x)
      if (angleOnArc(ang, e.startAngle, e.endAngle)) {
        return Math.abs(Math.hypot(p.x - e.center.x, p.y - e.center.y) - e.radius)
      }
      const s = arcPoint(e.center, e.radius, e.startAngle)
      const en = arcPoint(e.center, e.radius, e.endAngle)
      return Math.min(Math.hypot(p.x - s.x, p.y - s.y), Math.hypot(p.x - en.x, p.y - en.y))
    }
    case 'ellipse':
      return nearestPointOnEllipse(e, p).dist
    case 'elliptical-arc':
      return distanceToEllipticalArc(e, e.startParam, e.endParam, p)
    case 'spline':
      return nearestPointOnSpline(e.points, e.closed, p, e.form).dist
    case 'text':
      return distanceToText(e.text, e.height, e.at, e.rotation ?? 0, p,
        { mirrored: e.mirrored, letterSpacingMm: e.letterSpacingMm })
    case 'block':
      // A block is a rigid container, not an intersection curve (v1).
      return Infinity
  }
}

// ---- Intersection primitives ------------------------------------------------

/** Segment/segment intersection point (segments, not infinite lines). */
function segSegIntersection(a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2): Vec2 | null {
  const d1x = a2.x - a1.x, d1y = a2.y - a1.y
  const d2x = b2.x - b1.x, d2y = b2.y - b1.y
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) < 1e-12) return null
  const t = ((b1.x - a1.x) * d2y - (b1.y - a1.y) * d2x) / denom
  const u = ((b1.x - a1.x) * d1y - (b1.y - a1.y) * d1x) / denom
  if (t < 0 || t > 1 || u < 0 || u > 1) return null
  return { x: a1.x + t * d1x, y: a1.y + t * d1y }
}

/** Segment/circle intersection points (on the segment, on the full circle). */
function segCircleIntersections(
  a: Vec2, b: Vec2, center: Vec2, radius: number,
): Vec2[] {
  const dx = b.x - a.x, dy = b.y - a.y
  const fx = a.x - center.x, fy = a.y - center.y
  const A = dx * dx + dy * dy
  if (A < 1e-18) return []
  const B = 2 * (fx * dx + fy * dy)
  const C = fx * fx + fy * fy - radius * radius
  const disc = B * B - 4 * A * C
  if (disc < 0) return []
  const sq = Math.sqrt(disc)
  const out: Vec2[] = []
  for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
    if (t < 0 || t > 1) continue
    const p = { x: a.x + t * dx, y: a.y + t * dy }
    if (out.length === 1 && d2(out[0], p) < 1e-18) continue // tangent double root
    out.push(p)
  }
  return out
}

/** Circle/circle intersection points (full circles). */
function circleCircleIntersections(
  c1: Vec2, r1: number, c2: Vec2, r2: number,
): Vec2[] {
  const dx = c2.x - c1.x, dy = c2.y - c1.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-12) return [] // concentric: none or infinite — neither snaps
  if (d > r1 + r2 || d < Math.abs(r1 - r2)) return []
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
  const h2 = r1 * r1 - a * a
  const h = h2 > 0 ? Math.sqrt(h2) : 0
  const mx = c1.x + (a * dx) / d
  const my = c1.y + (a * dy) / d
  if (h === 0) return [{ x: mx, y: my }] // externally/internally tangent
  return [
    { x: mx - (h * dy) / d, y: my + (h * dx) / d },
    { x: mx + (h * dy) / d, y: my - (h * dx) / d },
  ]
}

/** True when p lies on entity e's curve span (arcs / elliptical-arcs check
 *  the sweep; lines/circles/ellipses are full-span). */
function onCurveSpan(e: SketchEntity, p: Vec2): boolean {
  if (e.kind === 'arc') {
    const ang = Math.atan2(p.y - e.center.y, p.x - e.center.x)
    return angleOnArc(ang, e.startAngle, e.endAngle)
  }
  if (e.kind === 'elliptical-arc') {
    const t = ellipseParamFromPoint(e, p)
    const rel = norm(t - e.startParam)
    return rel <= ellipticalArcSweep(e.startParam, e.endParam) + 1e-9
  }
  return true
}

// ---- Ellipse / elliptical-arc intersections (numeric sampling+bisect) --------
//
// An ellipse (rotated) has no simple closed-form intersection with every
// other curve, so we use a uniform, robust method: sample the OTHER curve
// along its parameter, evaluate the ellipse implicit F (< 0 inside, 0 on,
// > 0 outside) at each sample, and BISECT every sign change to the crossing
// point. Crossings are then filtered to BOTH curves' spans. This covers
// ellipse/elliptical-arc against line / circle / arc / ellipse /
// elliptical-arc. Splines and text cutters are out of scope (return []).

/** Ellipse implicit at p: (lx/a)^2 + (ly/b)^2 - 1 in the ellipse's own
 *  axis frame (< 0 inside, 0 on the curve, > 0 outside). */
function ellipseImplicit(e: EllipseShape, p: Vec2): number {
  const c = Math.cos(e.rotation), s = Math.sin(e.rotation)
  const dx = p.x - e.center.x, dy = p.y - e.center.y
  const lx = dx * c + dy * s
  const ly = -dx * s + dy * c
  const a = e.majorRadius || 1, b = e.minorRadius || 1
  return (lx * lx) / (a * a) + (ly * ly) / (b * b) - 1
}

/** Point at normalized parameter t in [0,1] along a cutter curve — the
 *  sampling parameterization for ellipseCurveIntersections. */
function pointAtParam01(e: SketchEntity, t: number): Vec2 {
  switch (e.kind) {
    case 'line':
      return {
        x: e.start.x + t * (e.end.x - e.start.x),
        y: e.start.y + t * (e.end.y - e.start.y),
      }
    case 'circle':
      return arcPoint(e.center, e.radius, TWO_PI * t)
    case 'arc': {
      const sweep = norm(e.endAngle - e.startAngle)
      return arcPoint(e.center, e.radius, e.startAngle + (sweep || TWO_PI) * t)
    }
    case 'ellipse':
      return ellipsePointAt(e, TWO_PI * t)
    case 'elliptical-arc':
      return ellipsePointAt(e, e.startParam + ellipticalArcSweep(e.startParam, e.endParam) * t)
    default:
      return { x: 0, y: 0 }
  }
}

/** Sample density along the cutter for the sign-change search. */
function sampleCount(e: SketchEntity): number {
  switch (e.kind) {
    case 'line': return 48
    case 'arc': return 96
    case 'elliptical-arc': return 96
    case 'circle': return 128
    case 'ellipse': return 128
    default: return 0
  }
}

/** Intersections of ellipse/elliptical-arc `ell` with a curve `other`. */
function ellipseCurveIntersections(
  ell: SketchEllipseEntity | SketchEllipticalArcEntity, other: SketchEntity,
): Vec2[] {
  const n = sampleCount(other)
  if (n === 0) return []
  const F = (t: number): number => ellipseImplicit(ell, pointAtParam01(other, t))
  const out: Vec2[] = []
  const push = (t: number): void => {
    const p = pointAtParam01(other, t)
    if (onCurveSpan(ell, p) && onCurveSpan(other, p) &&
        !out.some((q) => d2(q, p) < 1e-14)) out.push(p)
  }
  // A crossing may land BETWEEN samples (sign change -> bisect) or EXACTLY
  // ON a sample (F ~ 0 there -> push it directly; the two flanking
  // intervals do not register as sign changes). ZERO_F is on the ellipse's
  // dimensionless implicit scale.
  const ZERO_F = 1e-9
  let tPrev = 0
  let fPrev = F(0)
  if (Math.abs(fPrev) < ZERO_F) push(0)
  for (let i = 1; i <= n; i++) {
    const tCur = i / n
    const fCur = F(tCur)
    if (Math.abs(fCur) < ZERO_F) {
      push(tCur) // crossing lands on this sample
    } else if (Math.abs(fPrev) >= ZERO_F && (fPrev < 0) !== (fCur < 0)) {
      // Bisect the sign change between tPrev and tCur.
      let a = tPrev, b = tCur, fa = fPrev
      for (let k = 0; k < 60; k++) {
        const m = (a + b) / 2
        const fm = F(m)
        if (fm === 0) { a = b = m; break }
        if ((fa < 0) !== (fm < 0)) b = m
        else { a = m; fa = fm }
      }
      push((a + b) / 2)
    }
    tPrev = tCur
    fPrev = fCur
  }
  return out
}

/** All intersection points between two entities (line/line, line/circle,
 *  line/arc, circle/circle, circle/arc, arc/arc, and ellipse/elliptical-arc
 *  against any of those). Point (and spline/text cutter) entities never
 *  intersect. */
export function entityIntersections(a: SketchEntity, b: SketchEntity): Vec2[] {
  if (a.kind === 'point' || b.kind === 'point') return []
  if (a.kind === 'spline' || b.kind === 'spline') {
    if (a.kind === 'text' || b.kind === 'text' || a.kind === 'block' || b.kind === 'block') return []
    const poly = (e: SketchEntity): Vec2[] => {
      if (e.kind === 'spline') return tessellateSpline(e.points, e.closed, 0.08, e.form)
      if (e.kind === 'line') return [e.start, e.end]
      if (e.kind === 'circle') {
        const out: Vec2[] = []
        for (let i = 0; i <= 256; i++) out.push(arcPoint(e.center, e.radius, TWO_PI * i / 256))
        return out
      }
      if (e.kind === 'arc') {
        const sweep = norm(e.endAngle - e.startAngle) || TWO_PI
        const out: Vec2[] = []
        for (let i = 0; i <= 192; i++) out.push(arcPoint(e.center, e.radius, e.startAngle + sweep * i / 192))
        return out
      }
      if (e.kind === 'ellipse') {
        const out: Vec2[] = []
        for (let i = 0; i <= 256; i++) out.push(ellipsePointAt(e, TWO_PI * i / 256))
        return out
      }
      if (e.kind === 'elliptical-arc') {
        const sweep = ellipticalArcSweep(e.startParam, e.endParam)
        const out: Vec2[] = []
        for (let i = 0; i <= 192; i++) out.push(ellipsePointAt(e, e.startParam + sweep * i / 192))
        return out
      }
      return []
    }
    const pa = poly(a), pb = poly(b), out: Vec2[] = []
    for (let i = 0; i + 1 < pa.length; i++) {
      for (let j = 0; j + 1 < pb.length; j++) {
        const p = segSegIntersection(pa[i], pa[i + 1], pb[j], pb[j + 1])
        if (p && !out.some((q) => d2(q, p) < 1e-10)) out.push(p)
      }
    }
    return out
  }
  const aEll = a.kind === 'ellipse' || a.kind === 'elliptical-arc'
  const bEll = b.kind === 'ellipse' || b.kind === 'elliptical-arc'
  if (aEll || bEll) {
    const ell = (aEll ? a : b) as SketchEllipseEntity | SketchEllipticalArcEntity
    const other = aEll ? b : a
    if (other.kind === 'text') return []
    return ellipseCurveIntersections(ell, other)
  }
  if (a.kind === 'line' && b.kind === 'line') {
    const p = segSegIntersection(a.start, a.end, b.start, b.end)
    return p ? [p] : []
  }
  if (a.kind === 'line' || b.kind === 'line') {
    const line = (a.kind === 'line' ? a : b) as SketchEntity & { kind: 'line' }
    const curve = a.kind === 'line' ? b : a
    if (curve.kind !== 'circle' && curve.kind !== 'arc') return []
    return segCircleIntersections(line.start, line.end, curve.center, curve.radius)
      .filter((p) => onCurveSpan(curve, p))
  }
  // circle/arc combinations
  if ((a.kind === 'circle' || a.kind === 'arc') && (b.kind === 'circle' || b.kind === 'arc')) {
    return circleCircleIntersections(a.center, a.radius, b.center, b.radius)
      .filter((p) => onCurveSpan(a, p) && onCurveSpan(b, p))
  }
  return []
}

// ---- Candidate collection -----------------------------------------------------

interface Candidate {
  point: Vec2
  kind: SnapKind
  dist: number
  sourceEntityIds: string[]
  inferences: SnapInference[]
  /** Point-site candidates only: the hover-wake payload. */
  wake?: WokenRef
  /** H/V alignment: the reference point the dashed guide is drawn from. */
  alignFrom?: Vec2
  /** Dual H+V alignment only: the second guide's source point. */
  alignFrom2?: Vec2
}

/** Tie-break order within the entity tier (lower wins on exact ties). */
const KIND_RANK: Record<SnapKind, number> = {
  endpoint: 0,
  midpoint: 1,
  center: 2,
  quadrant: 2,
  intersection: 3,
  curve: 3.5,
  'h-align': 4,
  'v-align': 4,
  grid: 5,
}

/** The two FOCUS snap spots of an ellipse / elliptical-arc ('center' kind:
 *  center-like reference markers, coincident-inferable). Collapsed foci
 *  (circle-degenerate, ellipseFoci returns ONE point) yield NO spots — the
 *  center spot already covers that exact coordinate. */
function ellipseFocusSpots(
  e: EllipseShape & { id: string },
): Array<{ point: Vec2; kind: SnapKind; ref: PointRef }> {
  const foci = ellipseFoci(e)
  if (foci.length < 2) return []
  return [
    { point: foci[0], kind: 'center', ref: { entityId: e.id, site: 'focus1' } },
    { point: foci[1], kind: 'center', ref: { entityId: e.id, site: 'focus2' } },
  ]
}

/** Point-site snap spots on an existing entity. Point entities snap as
 *  'endpoint' (they ARE a bare point); circle/arc centers as 'center'. */
function entitySnapSpots(
  e: SketchEntity,
): Array<{ point: Vec2; kind: SnapKind; ref: PointRef }> {
  switch (e.kind) {
    case 'point':
      return [{ point: e.at, kind: 'endpoint', ref: { entityId: e.id, site: 'self' } }]
    case 'line':
      // WO SKC-49: the injected X/Y axis lines are suppressed here -- their synthetic +/-100m
      // endpoints and midpoint (the projected origin) are ARBITRARY, not user-meaningful pick
      // targets, and explicit-snap PRECEDENCE (dimTool.ts dimToolClick) would otherwise convert an
      // intended angle/distancePL pick against the axis BODY into a junk endpoint/midpoint
      // distance dim the instant the cursor drifted near one. A mid-axis click still resolves (via
      // pickDimOperand's whole-entity segDistance fallback, dimTool.ts) to the axis as a LINE
      // operand -- exactly what an angle or distancePL pick needs. The origin POINT keeps its own
      // 'point'-case endpoint spot above (that one is deliberate and addressable).
      if (e.id === SKETCH_AXIS_X_ENTITY_ID || e.id === SKETCH_AXIS_Y_ENTITY_ID) return []
      return [
        { point: e.start, kind: 'endpoint', ref: { entityId: e.id, site: 'start' } },
        { point: e.end, kind: 'endpoint', ref: { entityId: e.id, site: 'end' } },
        {
          point: { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 },
          kind: 'midpoint',
          ref: { entityId: e.id, site: 'center' },
        },
      ]
    case 'circle':
      return [{ point: e.center, kind: 'center', ref: { entityId: e.id, site: 'center' } }]
    case 'arc':
      return [
        { point: arcPoint(e.center, e.radius, e.startAngle), kind: 'endpoint', ref: { entityId: e.id, site: 'start' } },
        { point: arcPoint(e.center, e.radius, e.endAngle), kind: 'endpoint', ref: { entityId: e.id, site: 'end' } },
        { point: e.center, kind: 'center', ref: { entityId: e.id, site: 'center' } },
      ]
    case 'ellipse': {
      // Center and the two FOCI are addressable point sites (coincident /
      // dims — the gcs mapping materializes foci as center-tied points).
      // Quadrants stay position-only ('quadrant' produces no inference --
      // see findSnap): they have no solver point on a solver-inert shape.
      // Circle-degenerate: the foci COLLAPSE onto the center — skip them so
      // the spot list never stacks three refs on one coordinate (the center
      // spot already owns that location).
      const c: PointRef = { entityId: e.id, site: 'center' }
      return [
        { point: e.center, kind: 'center', ref: c },
        ...ellipseFocusSpots(e),
        ...ellipseQuadrants(e).map((q) => ({ point: q, kind: 'quadrant' as const, ref: c })),
      ]
    }
    case 'elliptical-arc': {
      const c: PointRef = { entityId: e.id, site: 'center' }
      const start = ellipsePointAt(e, e.startParam)
      const end = ellipsePointAt(e, e.endParam)
      // Center + foci addressable; endpoints position-only (no solver site).
      return [
        { point: e.center, kind: 'center', ref: c },
        ...ellipseFocusSpots(e),
        { point: start, kind: 'quadrant', ref: c },
        { point: end, kind: 'quadrant', ref: c },
      ]
    }
    case 'spline': {
      // Through-points are snap candidates. The FIRST point is the addressable
      // anchor ('start' -> coincident inference, endpoint kind); every other
      // through-point is position-only (kind 'quadrant' -> snaps the click but
      // commits no constraint, same treatment as ellipse quadrants).
      const anchor: PointRef = { entityId: e.id, site: 'start' }
      const spots: Array<{ point: Vec2; kind: SnapKind; ref: PointRef }> = [
        { point: e.points[0], kind: 'endpoint', ref: anchor },
      ]
      for (let i = 1; i < e.points.length; i++) {
        // WO-1862: a bezier handle tip is off the curve -- only its anchors
        // are snap candidates.
        if (e.form === 'bezier' && !bezierIsAnchor(i, e.points.length, e.closed)) continue
        // WO-1863: a conic's apex is off the curve (its shoulder and end are on it).
        if (e.form === 'conic' && i === 1) continue
        spots.push({ point: e.points[i], kind: 'quadrant', ref: anchor })
      }
      return spots
    }
    case 'text':
      // Solver-inert: only the baseline-left anchor is a snap candidate (the
      // addressable 'start' site -> coincident inference, endpoint kind).
      return [{ point: e.at, kind: 'endpoint', ref: { entityId: e.id, site: 'start' } }]
    case 'block':
      // Solver-inert block: only the origin anchor is a snap candidate (site
      // 'origin' -> coincident inference), so it can be positioned onto other
      // geometry (SKC-BLOCKS).
      return [{ point: e.origin, kind: 'endpoint', ref: { entityId: e.id, site: 'origin' } }]
  }
}

/** Cap on entities entering the pairwise intersection search (bounded). */
const INTERSECTION_ENTITY_CAP = 12

// ---- Curve-body H/V composition (SKC-73) ---------------------------------------
//
// A curve-body projection candidate (point_on_object) can carry an
// additional H or V inference when the projected point aligns with a
// hover-woken or chain-previous reference point.  composeCurveHV mutates
// the candidate's inferences and alignFrom fields so the caller emits the
// correct snap result.

interface AlignSrc {
  point: Vec2
  /** undefined = chain source (constrains the new LINE);
   *  PointRef = woken source (two-point constraint);
   *  null = woken position-only source (no constraint). */
  ref?: PointRef | null
}

function composeCurveHV(
  candidate: Candidate, q: SnapQuery, tol: number,
): void {
  const srcInference = (
    src: AlignSrc, kind: 'horizontal' | 'vertical',
  ): SnapInference => {
    if (src.ref === undefined) return { kind }
    if (src.ref === null) return { kind } // position-only, no two-point constraint
    return { kind, to: src.ref }
  }

  const sources: AlignSrc[] = []
  if (q.alignRef) sources.push({ point: q.alignRef })
  for (const w of q.wokenRefs ?? []) sources.push({ point: w.point, ref: w.ref })

  let bestH: { src: AlignSrc; d: number } | null = null
  let bestV: { src: AlignSrc; d: number } | null = null
  for (const src of sources) {
    if (Math.hypot(candidate.point.x - src.point.x, candidate.point.y - src.point.y) <= tol) continue
    const dy = Math.abs(candidate.point.y - src.point.y)
    const dx = Math.abs(candidate.point.x - src.point.x)
    if (dy <= tol && (!bestH || dy < bestH.d)) bestH = { src, d: dy }
    if (dx <= tol && (!bestV || dx < bestV.d)) bestV = { src, d: dx }
  }

  // Same-source H+V collapses to the closer axis (the intersection
  // would be AT the source itself, which is the entity tier's domain).
  if (bestH && bestV && bestH.src === bestV.src) {
    if (bestH.d <= bestV.d) bestV = null
    else bestH = null
  }

  if (bestH && bestV) {
    const hChain = bestH.src.ref === undefined
    const primary = hChain || bestV.src.ref !== undefined ? bestH.src : bestV.src
    const secondary = primary === bestH.src ? bestV.src : bestH.src
    candidate.inferences = [
      ...candidate.inferences,
      srcInference(bestH.src, 'horizontal'),
      srcInference(bestV.src, 'vertical'),
    ]
    candidate.alignFrom = { x: primary.point.x, y: primary.point.y }
    candidate.alignFrom2 = { x: secondary.point.x, y: secondary.point.y }
  } else if (bestH) {
    candidate.inferences = [...candidate.inferences, srcInference(bestH.src, 'horizontal')]
    candidate.alignFrom = { x: bestH.src.point.x, y: bestH.src.point.y }
  } else if (bestV) {
    candidate.inferences = [...candidate.inferences, srcInference(bestV.src, 'vertical')]
    candidate.alignFrom = { x: bestV.src.point.x, y: bestV.src.point.y }
  }
}

// ---- Engine -------------------------------------------------------------------

/** H/V alignment reference for the current chain: the line tool's previous
 *  point (the next segment starts there). Other tools have no meaningful
 *  alignment reference — a rect corner aligned with its anchor is a
 *  degenerate rectangle, a rim point aligned with a circle center adds no
 *  constraint the circle does not already imply. */
export function chainAlignRef(chain: ToolChainState | null): Vec2 | null {
  if (chain?.kind === 'line') return chain.prev
  return null
}

export function findSnap(q: SnapQuery): SnapResult | null {
  const flags = q.flags ?? DEFAULT_SNAP_FLAGS
  const tol = (q.snapPx ?? SNAP_PX) * q.worldPerPixel
  if (!(tol > 0)) return null
  const cursor = q.cursor
  const withInference = flags.inference

  // ---- Tier 1: entity snaps --------------------------------------------------
  if (flags.entity) {
    const candidates: Candidate[] = []

    for (const e of q.entities) {
      for (const spot of entitySnapSpots(e)) {
        const dist = Math.hypot(cursor.x - spot.point.x, cursor.y - spot.point.y)
        if (dist > tol) continue
        let inferences: SnapInference[] = []
        if (withInference) {
          if (spot.kind === 'quadrant') {
            // Position-only: an ellipse quadrant has no addressable solver
            // site, so it snaps the click but commits no constraint.
            inferences = []
          } else if (spot.kind === 'midpoint') {
            inferences = [{ kind: 'midpoint', line: e.id }]
          } else {
            // endpoint and center snaps both commit a coincident onto the
            // exact point site of the EXISTING entity (shared point, never
            // duplicated geometry).
            inferences = [{ kind: 'coincident', to: spot.ref }]
          }
        }
        candidates.push({
          point: { x: spot.point.x, y: spot.point.y },
          kind: spot.kind,
          dist,
          sourceEntityIds: [e.id],
          inferences,
          // Hover-wake payload: line midpoint is the line's canonical center
          // site. Drawing inference keeps the established midpoint constraint,
          // while Smart Dimension and point-site picking receive the stable
          // owner/site reference.
          wake: {
            point: { x: spot.point.x, y: spot.point.y },
            ref: spot.kind === 'quadrant' ? null : spot.ref,
          },
        })
      }
    }

    // Intersections: bounded — only entities whose curve passes near the
    // cursor participate, capped to a fixed count. When more than the cap
    // are near, keep the spatially closest ones (closest-N by distance to
    // cursor), not whichever happen to come first in q.entities — the cap
    // must be a distance policy, never a document-order accident.
    const near = q.entities
      .map((e) => ({ e, d: e.kind !== 'point' ? curveDistance(e, cursor) : Infinity }))
      .filter(({ d }) => d <= tol * 2)
      .sort((a, b) => a.d - b.d)
      .slice(0, INTERSECTION_ENTITY_CAP)
      .map(({ e }) => e)
    for (let i = 0; i < near.length; i++) {
      for (let j = i + 1; j < near.length; j++) {
        for (const p of entityIntersections(near[i], near[j])) {
          const dist = Math.hypot(cursor.x - p.x, cursor.y - p.y)
          if (dist > tol) continue
          candidates.push({
            point: p,
            kind: 'intersection',
            dist,
            sourceEntityIds: [near[i].id, near[j].id],
            inferences: withInference
              ? [
                  { kind: 'point_on_object', object: near[i].id },
                  { kind: 'point_on_object', object: near[j].id },
                ]
              : [],
          })
        }
      }
    }

    if (candidates.length > 0) {
      candidates.sort(
        (a, b) => a.dist - b.dist || KIND_RANK[a.kind] - KIND_RANK[b.kind]
      )
      const best = candidates[0]
      return {
        point: best.point,
        kind: best.kind,
        sourceEntityIds: best.sourceEntityIds,
        inferences: best.inferences,
        ...(best.wake ? { wake: best.wake } : {}),
      }
    }

    // 1c. Curve-body projection (SKC-73): when no named point or
    // intersection won, project the cursor onto line / circle / arc
    // bodies and infer point_on_object.  Compose with H/V alignment
    // when the projected point aligns with a hover-woken or chain
    // reference point.
    const curveCandidates: Candidate[] = []
    for (const e of q.entities) {
      if (e.kind !== 'line' && e.kind !== 'circle' && e.kind !== 'arc') continue
      // The injected anchor axes span the whole sketch; letting their bodies
      // participate here made every cursor position within tol of an axis a
      // point_on_object(axis) snap, stealing H/V alignment from woken refs
      // and chain points (RED-A, 2026-07-21). Axis intersections still snap
      // via the intersection tier; alignment onto axes still comes from H/V.
      if (isInjectedSketchAnchorId(e.id)) continue
      const proj = projectToCurve(e, cursor)
      if (!proj) continue
      const dist = Math.hypot(cursor.x - proj.x, cursor.y - proj.y)
      if (dist > tol) continue
      curveCandidates.push({
        point: { x: proj.x, y: proj.y },
        kind: 'curve',
        dist,
        sourceEntityIds: [e.id],
        inferences: withInference
          ? [{ kind: 'point_on_object', object: e.id }]
          : [],
      })
    }
    if (curveCandidates.length > 0) {
      curveCandidates.sort(
        (a, b) => a.dist - b.dist || KIND_RANK[a.kind] - KIND_RANK[b.kind]
      )
      // Refuse ambiguous ties (approximately equidistant curves) and
      // point-magnetized targets — the spec says ambiguous nearby
      // targets must never select by document order.
      if (curveCandidates.length > 1 &&
          Math.abs(curveCandidates[1].dist - curveCandidates[0].dist) <= 1e-9) {
        // fall through — no curve-body snap, let Tier 2 handle
      } else {
        const best = curveCandidates[0]
        if (withInference) {
          composeCurveHV(best, q, tol)
        }
        return {
          point: best.point,
          kind: best.kind,
          sourceEntityIds: best.sourceEntityIds,
          inferences: best.inferences,
          ...(best.alignFrom ? { alignFrom: best.alignFrom } : {}),
          ...(best.alignFrom2 ? { alignFrom2: best.alignFrom2 } : {}),
        }
      }
    }
  }

  // ---- Tier 2: H/V alignment (chain's previous point + woken refs) ------------
  //
  // Every source — the chain's previous point and each hover-woken
  // reference — contributes an H candidate (cursor Y near source Y) and a
  // V candidate (cursor X near source X). The closest H and closest V win
  // their axis; when BOTH axes hit from DIFFERENT sources the snap is
  // their intersection (both coordinates pinned, both guides drawn, both
  // constraints inferred). Same-source H+V would intersect AT the source
  // itself (the entity tier's business), so only the closer axis is kept.
  if (withInference) {
    interface AlignSource {
      point: Vec2
      /** undefined = chain source (constrains the new LINE);
       *  PointRef = woken source (two-point constraint);
       *  null = woken position-only source (no constraint). */
      ref?: PointRef | null
    }
    const sources: AlignSource[] = []
    if (q.alignRef) sources.push({ point: q.alignRef })
    for (const w of q.wokenRefs ?? []) sources.push({ point: w.point, ref: w.ref })

    let bestH: { src: AlignSource; d: number } | null = null
    let bestV: { src: AlignSource; d: number } | null = null
    for (const src of sources) {
      // Inside tol of the source itself there is nothing to align — that
      // click is the zero-length guard's / entity snap's business.
      if (Math.hypot(cursor.x - src.point.x, cursor.y - src.point.y) <= tol) continue
      const dy = Math.abs(cursor.y - src.point.y)
      const dx = Math.abs(cursor.x - src.point.x)
      if (dy <= tol && (!bestH || dy < bestH.d)) bestH = { src, d: dy }
      if (dx <= tol && (!bestV || dx < bestV.d)) bestV = { src, d: dx }
    }
    if (bestH && bestV && bestH.src === bestV.src) {
      if (bestH.d <= bestV.d) bestV = null
      else bestH = null
    }

    const srcInference = (
      src: AlignSource, kind: 'horizontal' | 'vertical',
    ): SnapInference[] => {
      if (src.ref === undefined) return [{ kind }] // chain: new line H/V
      if (src.ref === null) return [] // woken midpoint: position only
      return [{ kind, to: src.ref }] // woken point: two-point H/V
    }

    if (bestH && bestV) {
      // Dual alignment: intersect. alignFrom carries the CHAIN source when
      // one participates (inference.ts resolves the new line against it);
      // the other source goes to alignFrom2 (second guide).
      const hChain = bestH.src.ref === undefined
      const primary = hChain || bestV.src.ref !== undefined
        ? bestH.src : bestV.src
      const secondary = primary === bestH.src ? bestV.src : bestH.src
      return {
        point: { x: bestV.src.point.x, y: bestH.src.point.y },
        kind: bestH.d <= bestV.d ? 'h-align' : 'v-align',
        sourceEntityIds: [],
        inferences: [
          ...srcInference(bestH.src, 'horizontal'),
          ...srcInference(bestV.src, 'vertical'),
        ],
        alignFrom: { x: primary.point.x, y: primary.point.y },
        alignFrom2: { x: secondary.point.x, y: secondary.point.y },
      }
    }
    if (bestH) {
      return {
        point: { x: cursor.x, y: bestH.src.point.y },
        kind: 'h-align',
        sourceEntityIds: [],
        inferences: srcInference(bestH.src, 'horizontal'),
        alignFrom: { x: bestH.src.point.x, y: bestH.src.point.y },
      }
    }
    if (bestV) {
      return {
        point: { x: bestV.src.point.x, y: cursor.y },
        kind: 'v-align',
        sourceEntityIds: [],
        inferences: srcInference(bestV.src, 'vertical'),
        alignFrom: { x: bestV.src.point.x, y: bestV.src.point.y },
      }
    }
  }

  // ---- Tier 3: grid ------------------------------------------------------------
  if (flags.grid && q.gridSpacing > 0) {
    const g = q.gridSpacing
    const p = { x: Math.round(cursor.x / g) * g, y: Math.round(cursor.y / g) * g }
    if (Math.hypot(cursor.x - p.x, cursor.y - p.y) <= tol) {
      return { point: p, kind: 'grid', sourceEntityIds: [], inferences: withInference ? [{ kind: 'grid' }] : [] }
    }
  }

  return null
}
