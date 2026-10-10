// Trim tool (Stage 6 chunk 1, PLAN.md 3.5 MODIFY v1).
//
// Intended behavior: click a SEGMENT of an entity and the clicked portion
// between its nearest bounding intersections (with any other
// NON-CONSTRUCTION entity) is removed.
//   - line:   splits into 1-2 remaining lines
//   - circle: becomes an arc spanning everything but the clicked span
//             (needs >= 2 distinct intersection angles; fewer = the whole
//             circle goes, there is no bounded span to keep)
//   - arc:    shrinks from one end or splits into two arcs
//   - no intersections at all: the WHOLE entity is deleted, with the
//     established delete cascade (deleteSelection rules)
//
// PURE module following the deleteSelection pattern: functions take the
// document arrays and RETURN the new arrays; the store applies them as
// one undo step and re-solves.
//
// Constraint survival rules (parametric intent):
//   - point sites that survive keep their constraints: a site that moved
//     to the second piece is REWRITTEN to it (same geometric point)
//   - point sites on removed geometry cascade away (their constraints/
//     dimensions are dropped — a dangling ref would fail every solve)
//   - every NEW cut endpoint gets a point_on_object constraint onto the
//     entity it was trimmed against (the cut stays on the boundary when
//     the sketch re-solves) — UNLESS the cutter is solver-inert (ellipse /
//     elliptical-arc, see fixPointConstraint), which gets a fix constraint
//     at the cut point's just-computed location instead (planegcs has no
//     point-on-curve primitive for either kind)
//   - entity-level references are repaired by MEANING, not mechanically:
//     see the kept/dropped table at repairEntityConstraints.

import type {
  Vec2,
  PointRef,
  PointSite,
  Sketch,
  SketchEntity,
  SketchArcEntity,
  SketchCircleEntity,
  SketchLineEntity,
  SketchEllipseEntity,
  SketchEllipticalArcEntity,
  SketchSplineEntity,
  SketchConstraint,
  SketchDimension,
  BlockDefinition,
} from '../types'
import { entityIntersections } from '../snap'
import {
  nearestPointOnEllipse, distanceToEllipticalArc, ellipseParamFromPoint, ellipsePointAt,
  ellipticalArcSweep, tessellateEllipticalArc,
} from '../ellipse'
import { nearestParamOnSpline, splineAsThroughPoints, splineDerivativeAt } from '../spline'
import { deleteFromSketch } from '../deleteSelection'
import { constraintRefIds, dimensionRefIds } from '../refIds'
import { entityLabels } from '../browserModel'
import { constraintKindLabel } from '../constraintActions'
import { positiveArcSweep } from './dimTool'
import { detachProjectedFixes, markProjectedGeometryDetached } from '../projectedEdit'

// Minimal document view every transform works on (a full Sketch is one).
export type SketchDoc = Pick<Sketch, 'entities' | 'constraints' | 'dimensions'>

/** Replacement document arrays — the store swaps them in wholesale as a
 *  single undo step (the modify-tool analog of ToolCommit's append). */
export interface SketchDocTransform {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  dimensions: SketchDimension[]
  /** SKC-BLOCKS Stage 5: the block-definition registry, when a transform changes
   *  it (place/explode an instance). OMITTED by every ordinary geometry tool
   *  (trim/fillet/...), so `replace`'s `{...s, ...next}` spread leaves the current
   *  sketch's blockDefs untouched -- only a block command sets this key. */
  blockDefs?: Record<string, BlockDefinition>
}

export interface TrimOutcome {
  /** null = nothing was trimmed (empty click / nothing crossed). */
  transform: SketchDocTransform | null
  /** Explanation when the click hit something but could not trim — OR,
   *  on success, the repair summary ("Trimmed Line 3: kept 2
   *  constraints, dropped Equal (lengths changed)"). null on a plain
   *  trim with no repairs (the generic flash speaks). */
  notice: string | null
}

const NO_OP: TrimOutcome = { transform: null, notice: null }

// Pieces shorter than this are dropped rather than kept as slivers.
export const EPS_LEN = 1e-6 // mm, line pieces
export const EPS_ANG = 1e-6 // rad, arc sweeps
// Two cut parameters closer than this are the same cut.
const EPS_PARAM = 1e-9

export const TWO_PI = Math.PI * 2

export function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// ---- Picking ----------------------------------------------------------------

function segDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

export function arcSweep(e: SketchArcEntity): number {
  const s = norm(e.endAngle - e.startAngle)
  // A stored full-turn arc (endAngle == startAngle) sweeps 2pi, not 0.
  return s < EPS_ANG ? TWO_PI : s
}

export function arcPointAt(e: { center: Vec2; radius: number }, angle: number): Vec2 {
  return {
    x: e.center.x + e.radius * Math.cos(angle),
    y: e.center.y + e.radius * Math.sin(angle),
  }
}

export function curveDistance(e: SketchEntity, p: Vec2): number | null {
  switch (e.kind) {
    case 'point':
      return null // points are not trimmable — use Delete
    case 'block':
      return null // a block is not trimmable — use Explode
    case 'line':
      return segDistance(p, e.start, e.end)
    case 'circle':
      return Math.abs(dist(p, e.center) - e.radius)
    case 'arc': {
      const ang = norm(Math.atan2(p.y - e.center.y, p.x - e.center.x) - e.startAngle)
      if (ang <= arcSweep(e)) return Math.abs(dist(p, e.center) - e.radius)
      const s = arcPointAt(e, e.startAngle)
      const en = arcPointAt(e, e.endAngle)
      return Math.min(dist(p, s), dist(p, en))
    }
    case 'ellipse':
      return nearestPointOnEllipse(e, p).dist
    case 'elliptical-arc':
      return distanceToEllipticalArc(e, e.startParam, e.endParam, p)
    // splines/text are not trimmable (no curve-vs-curve split). Use Delete.
    case 'spline':
    case 'text':
      return null
  }
}

/** Nearest trimmable curve (line / circle / arc) within tol, or null. */
export function pickCurve(
  entities: readonly SketchEntity[], world: Vec2, tol: number,
): SketchEntity | null {
  let best: { e: SketchEntity; d: number } | null = null
  for (const e of entities) {
    const d = curveDistance(e, world)
    if (d !== null && d <= tol && (!best || d < best.d)) best = { e, d }
  }
  return best?.e ?? null
}

// ---- Cut collection ----------------------------------------------------------

interface Cut {
  /** Parameter along the target: line t in [0,1]; arc/circle angle-based. */
  param: number
  point: Vec2
  /** Entity the target was cut against. */
  cutterId: string
}

/** Curve parameter of a point ON the target entity. */
export function paramOf(target: SketchEntity, p: Vec2): number {
  switch (target.kind) {
    case 'line': {
      const dx = target.end.x - target.start.x
      const dy = target.end.y - target.start.y
      const len2 = dx * dx + dy * dy
      if (len2 <= 0) return 0
      const t = ((p.x - target.start.x) * dx + (p.y - target.start.y) * dy) / len2
      return Math.max(0, Math.min(1, t))
    }
    case 'circle':
      return norm(Math.atan2(p.y - target.center.y, p.x - target.center.x))
    case 'arc': {
      const a = norm(
        Math.atan2(p.y - target.center.y, p.x - target.center.x) - target.startAngle
      )
      return Math.min(a, arcSweep(target))
    }
    // Ellipse param space mirrors the circle: absolute eccentric parameter.
    case 'ellipse':
      return ellipseParamFromPoint(target, p)
    // Elliptical-arc mirrors the arc: offset from startParam within the sweep.
    case 'elliptical-arc': {
      const a = norm(ellipseParamFromPoint(target, p) - target.startParam)
      return Math.min(a, ellipticalArcSweep(target.startParam, target.endParam))
    }
    default:
      return 0
  }
}

// ---- Fillet host trim ---------------------------------------------------------

/** Solver-backed host kinds accepted by the circular fillet tool. */
export type CircularFilletHost =
  | SketchLineEntity
  | SketchArcEntity
  | SketchCircleEntity

export interface CircularFilletHostTrim {
  /** Replacement keeps the host id so entity-level constraints survive. */
  entity: SketchLineEntity | SketchArcEntity
  /** Endpoint joined to the inserted fillet arc. */
  jointSite: 'start' | 'end'
  /** Existing endpoint consumed at the sharp corner, if there was one. */
  consumedSite: 'start' | 'end' | null
}

export type GeneralFilletHost = CircularFilletHost
  | SketchEllipseEntity
  | SketchEllipticalArcEntity
  | SketchSplineEntity

export interface GeneralFilletHostTrim {
  entity: SketchLineEntity | SketchArcEntity | SketchEllipticalArcEntity | SketchSplineEntity
  jointSite: 'start' | 'end'
  consumedSite: 'start' | 'end' | null
  keep: 'forward' | 'backward'
}

function endpointAt(
  host: SketchLineEntity | SketchArcEntity, site: 'start' | 'end',
): Vec2 {
  if (host.kind === 'line') return host[site]
  return arcPointAt(host, site === 'start' ? host.startAngle : host.endAngle)
}

/**
 * Keep the side of `host` selected by `hint`, replacing the local sharp
 * corner at `corner` with `tangent`. Lines move one endpoint, arcs change one
 * angular bound, and full circles open into the complementary arc. This is a
 * geometry-only helper; filletTool owns constraint repair and atomic commit.
 */
export function trimCircularFilletHost(
  host: CircularFilletHost,
  corner: Vec2,
  tangent: Vec2,
  hint: Vec2,
): CircularFilletHostTrim | string {
  if (host.kind === 'line') {
    const dx = host.end.x - host.start.x
    const dy = host.end.y - host.start.y
    const len2 = dx * dx + dy * dy
    const len = Math.sqrt(len2)
    if (len <= EPS_LEN) return 'degenerate host'
    const at = (p: Vec2): number =>
      ((p.x - host.start.x) * dx + (p.y - host.start.y) * dy) / len2
    const c = at(corner), t = at(tangent), h = at(hint)
    const direction = Math.sign(h - c)
    if (direction === 0) return 'ambiguous kept side'
    if (t < -EPS_PARAM || t > 1 + EPS_PARAM || (t - c) * direction <= EPS_PARAM) {
      return 'no fit on kept line span'
    }
    if (direction > 0) {
      if ((1 - t) * len <= EPS_LEN) return 'tangent without room on kept line span'
      return {
        entity: { ...host, start: { x: tangent.x, y: tangent.y } },
        jointSite: 'start',
        consumedSite: dist(endpointAt(host, 'start'), corner) <= EPS_LEN ? 'start' : null,
      }
    }
    if (t * len <= EPS_LEN) return 'tangent without room on kept line span'
    return {
      entity: { ...host, end: { x: tangent.x, y: tangent.y } },
      jointSite: 'end',
      consumedSite: dist(endpointAt(host, 'end'), corner) <= EPS_LEN ? 'end' : null,
    }
  }

  const angle = (p: Vec2): number => norm(Math.atan2(p.y - host.center.y, p.x - host.center.x))
  const cAngle = angle(corner)
  const tAngle = angle(tangent)
  const hAngle = angle(hint)

  if (host.kind === 'arc') {
    // Fillet trimming is governed by physical kept length, not a fixed
    // angular cutoff. A 1e-7 rad span is still 0.1 mm on a 1,000,000 mm
    // radius host and can carry a field-sized fillet. The general trim
    // helper's EPS_ANG also treats sub-EPS sweeps as a stored full turn,
    // which is not the SketchArcEntity contract used by fillet hosts.
    const sweep = positiveArcSweep(host.startAngle, host.endAngle)
    const spanEps = EPS_LEN / host.radius
    const rel = (a: number): number => norm(a - host.startAngle)
    const c = rel(cAngle), t = rel(tAngle), h = rel(hAngle)
    if (c > sweep + spanEps || t > sweep + spanEps) return 'no fit on kept arc span'
    const direction = Math.sign(h - c)
    if (direction === 0) return 'ambiguous kept side'
    if ((t - c) * direction <= spanEps) return 'no fit on kept arc span'
    if (direction > 0) {
      if (sweep - t <= spanEps) return 'tangent without room on kept arc span'
      return {
        entity: { ...host, startAngle: tAngle },
        jointSite: 'start',
        consumedSite: dist(endpointAt(host, 'start'), corner) <= EPS_LEN ? 'start' : null,
      }
    }
    if (t <= spanEps) return 'tangent without room on kept arc span'
    return {
      entity: { ...host, endAngle: tAngle },
      jointSite: 'end',
      consumedSite: dist(endpointAt(host, 'end'), corner) <= EPS_LEN ? 'end' : null,
    }
  }

  const ccwHint = norm(hAngle - cAngle)
  const cwHint = norm(cAngle - hAngle)
  if (Math.abs(ccwHint - cwHint) <= EPS_ANG) return 'ambiguous kept side on circle'
  const keepCcw = ccwHint < cwHint
  const towardTangent = keepCcw ? norm(tAngle - cAngle) : norm(cAngle - tAngle)
  if (towardTangent <= EPS_ANG || TWO_PI - towardTangent <= EPS_ANG) {
    return 'tangent without room on circle'
  }
  const entity: SketchArcEntity = {
    id: host.id,
    kind: 'arc',
    construction: host.construction,
    center: { x: host.center.x, y: host.center.y },
    radius: host.radius,
    // Remove the local corner-to-tangent span. The complementary open arc
    // contains the selected hint side and keeps the circle's stable id.
    startAngle: keepCcw ? tAngle : cAngle,
    endAngle: keepCcw ? cAngle : tAngle,
  }
  return {
    entity,
    jointSite: keepCcw ? 'start' : 'end',
    consumedSite: null,
  }
}

/** Trim an ellipse or native Catmull-Rom spline at an exact fillet tangent.
 * Full ellipses open into elliptical arcs. Splines remain native through-
 * point curves and retain their untrimmed source points for later rebuilds. */
export function trimGeneralFilletHost(
  host: GeneralFilletHost,
  corner: Vec2,
  tangent: Vec2,
  hint: Vec2,
): GeneralFilletHostTrim | string {
  if (host.kind === 'line' || host.kind === 'arc' || host.kind === 'circle') {
    const r = trimCircularFilletHost(host, corner, tangent, hint)
    if (typeof r === 'string') return r
    const keep = r.jointSite === 'start' ? 'forward' : 'backward'
    return { ...r, keep }
  }
  if (host.kind === 'ellipse') {
    const c = ellipseParamFromPoint(host, corner)
    const t = ellipseParamFromPoint(host, tangent)
    const h = ellipseParamFromPoint(host, hint)
    const ccw = norm(h - c), cw = norm(c - h)
    if (Math.abs(ccw - cw) <= EPS_ANG) return 'closed ellipse kept side is ambiguous'
    const keep: 'forward' | 'backward' = ccw < cw ? 'forward' : 'backward'
    const entity: SketchEllipticalArcEntity = {
      ...host,
      kind: 'elliptical-arc',
      startParam: keep === 'forward' ? t : c,
      endParam: keep === 'forward' ? c : t,
    }
    return { entity, jointSite: keep === 'forward' ? 'start' : 'end', consumedSite: null, keep }
  }
  if (host.kind === 'elliptical-arc') {
    const sweep = ellipticalArcSweep(host.startParam, host.endParam)
    const rel = (p: Vec2): number => norm(ellipseParamFromPoint(host, p) - host.startParam)
    const c = rel(corner), t = rel(tangent), h = rel(hint)
    if (c > sweep + EPS_PARAM || t > sweep + EPS_PARAM) return 'no fit on kept ellipse span'
    const keep: 'forward' | 'backward' = h > c ? 'forward' : 'backward'
    if ((t - c) * (keep === 'forward' ? 1 : -1) <= EPS_PARAM) return 'no fit on kept ellipse span'
    return keep === 'forward'
      ? { entity: { ...host, startParam: ellipseParamFromPoint(host, tangent) }, jointSite: 'start',
          consumedSite: dist(ellipsePointAt(host, host.startParam), corner) <= EPS_LEN ? 'start' : null, keep }
      : { entity: { ...host, endParam: ellipseParamFromPoint(host, tangent) }, jointSite: 'end',
          consumedSite: dist(ellipsePointAt(host, host.endParam), corner) <= EPS_LEN ? 'end' : null, keep }
  }

  if (host.closed) return 'closed spline ambiguity'
  // WO-1861: the trim rebuilds from through-points, so a control-point host is
  // first re-expressed as the through-point spline tracing the same curve.
  const spline = splineAsThroughPoints(host)
  const source = spline.filletSourcePoints ?? spline.points
  if (source.length < 2) return 'degenerate spline derivative'
  const c = nearestParamOnSpline(source, false, corner)
  const t = nearestParamOnSpline(source, false, tangent)
  const h = nearestParamOnSpline(source, false, hint)
  const keep: 'forward' | 'backward' = h > c ? 'forward' : 'backward'
  if ((t - c) * (keep === 'forward' ? 1 : -1) <= EPS_PARAM) return 'no fit on kept spline span'
  const d = splineDerivativeAt(source, false, t)
  const dl = Math.hypot(d.x, d.y)
  if (dl <= EPS_LEN) return 'degenerate spline derivative'
  const unit = { x: d.x / dl, y: d.y / dl }
  const helper = Math.max(EPS_LEN * 10, Math.min(0.1, dist(source[0], source[source.length - 1]) * 1e-3))
  let points: Vec2[]
  if (keep === 'forward') {
    const rest = source.slice(Math.min(source.length, Math.floor(t) + 1))
    points = [tangent, { x: tangent.x + unit.x * helper, y: tangent.y + unit.y * helper }, ...rest]
  } else {
    const rest = source.slice(0, Math.max(0, Math.ceil(t)))
    points = [...rest, { x: tangent.x - unit.x * helper, y: tangent.y - unit.y * helper }, tangent]
  }
  const deduped = points.filter((p, i) => i === 0 || dist(p, points[i - 1]) > EPS_LEN)
  if (deduped.length < 2) return 'insufficient trim span on spline'
  return {
    entity: { ...spline, points: deduped, filletSourcePoints: source.map((p) => ({ ...p })) },
    jointSite: keep === 'forward' ? 'start' : 'end',
    consumedSite: dist(spline.points[keep === 'forward' ? 0 : spline.points.length - 1], corner) <= EPS_LEN
      ? (keep === 'forward' ? 'start' : 'end') : null,
    keep,
  }
}

/** All intersections of the target with every OTHER non-construction
 *  curve entity, as cut parameters (deduped). */
function collectCuts(doc: SketchDoc, target: SketchEntity): Cut[] {
  const cuts: Cut[] = []
  for (const other of doc.entities) {
    if (other.id === target.id || other.construction || other.kind === 'point') continue
    for (const p of entityIntersections(target, other)) {
      const param = paramOf(target, p)
      if (cuts.some((c) => Math.abs(c.param - param) <= EPS_PARAM)) continue
      cuts.push({ param, point: p, cutterId: other.id })
    }
  }
  cuts.sort((a, b) => a.param - b.param)
  return cuts
}

// ---- Reference rewriting -------------------------------------------------------

/** Where each point site of the trimmed entity ended up:
 *  missing key = unchanged (site survives on the original id);
 *  PointRef    = site survives but MOVED to another entity;
 *  null        = site was on removed geometry (referencing constraints/
 *                dimensions cascade away). */
export type SiteMap = Map<PointSite, PointRef | null>

export type RefMapper = (r: PointRef) => PointRef | null | 'keep'

export function makeRefMapper(entityId: string, sites: SiteMap): RefMapper {
  return (r) => {
    if (r.entityId !== entityId || !sites.has(r.site)) return 'keep'
    return sites.get(r.site) ?? null
  }
}

/** Rewrite a constraint's point references. null = drop the constraint. */
export function mapConstraintRefs(
  c: SketchConstraint, map: RefMapper,
): SketchConstraint | null {
  const one = (r: PointRef): PointRef | null => {
    const m = map(r)
    return m === 'keep' ? r : m
  }
  switch (c.kind) {
    case 'coincident': {
      const a = one(c.a), b = one(c.b)
      return a && b ? { ...c, a, b } : null
    }
    case 'horizontal':
    case 'vertical': {
      if (!c.points) return c
      const a = one(c.points[0]), b = one(c.points[1])
      return a && b ? { ...c, points: [a, b] } : null
    }
    case 'midpoint': {
      const p = one(c.point)
      return p ? { ...c, point: p } : null
    }
    case 'symmetric': {
      const a = one(c.a), b = one(c.b)
      return a && b ? { ...c, a, b } : null
    }
    case 'fix': {
      if (!c.point) return c
      const p = one(c.point)
      return p ? { ...c, point: p } : null
    }
    case 'point_on_object':
    case 'pierce': {
      // WO-1865: a pierce rides its point site through a trim/split like any point placement.
      const p = one(c.point)
      return p ? { ...c, point: p } : null
    }
    default:
      return c // no point references
  }
}

/** Rewrite a dimension's point references. null = drop the dimension. */
export function mapDimensionRefs(
  d: SketchDimension, map: RefMapper,
): SketchDimension | null {
  const one = (r: PointRef): PointRef | null => {
    const m = map(r)
    return m === 'keep' ? r : m
  }
  switch (d.kind) {
    case 'distance':
    case 'distanceX':
    case 'distanceY': {
      const a = one(d.a), b = one(d.b)
      return a && b ? { ...d, a, b } : null
    }
    // WO-1867: an ordinate is dropped when EITHER of its point refs dies with
    // the cut -- a stack with no datum measures nothing, and a datum with no
    // measured point is not a dimension. (splitTool routes its own dimension
    // repair through this same mapper, so the split path is covered here too.)
    case 'ordinate': {
      const origin = one(d.origin), point = one(d.point)
      return origin && point ? { ...d, origin, point } : null
    }
    case 'distancePL': {
      const p = one(d.point)
      return p ? { ...d, point: p } : null
    }
    // WO-1868: a three-point angle dies with the cut when ANY of its three
    // point refs does -- a leg or vertex that no longer exists measures nothing.
    case 'angle3': {
      const vertex = one(d.vertex), a = one(d.a), b = one(d.b)
      return vertex && a && b ? { ...d, vertex, a, b } : null
    }
    case 'angle':
    case 'radius':
    case 'diameter':
    case 'arcLength':
    case 'majorRadius':
    case 'minorRadius':
    case 'focusDistance':
    case 'd1xd2':
      return d // entity-id references only
  }
}

function pointOnObject(
  newId: () => string, point: PointRef, object: string,
): SketchConstraint {
  return { id: newId(), kind: 'point_on_object', point, object }
}

/** Substitute anchor for a cut endpoint whose cutter is SOLVER-INERT
 *  (ellipse / elliptical-arc): planegcs has no point-on-curve primitive for
 *  either kind (gcsMapping.ts point_on_object case only accepts
 *  line/circle/arc as the object), so pushing one there throws and fails
 *  the whole solve (SKC-53 / Operator N-29). FIX the cut point at its
 *  just-computed location instead — that location IS exactly on the
 *  cutter boundary right now, so this is geometrically correct at cut
 *  time; it just does not keep tracking the cutter if it later moves. */
export function fixPointConstraint(newId: () => string, point: PointRef): SketchConstraint {
  return { id: newId(), kind: 'fix', point }
}

// ---- Cut bounds -------------------------------------------------------------------

/** Nearest cuts bounding the click parameter (open interval ends are
 *  null). Shared by the trim planners AND the hover highlight so the
 *  highlighted span is exactly the span a click removes. */
function cutBounds(cuts: Cut[], clickParam: number): { lo: Cut | null; hi: Cut | null } {
  let lo: Cut | null = null
  let hi: Cut | null = null
  for (const c of cuts) {
    if (c.param <= clickParam && (!lo || c.param > lo.param)) lo = c
    if (c.param >= clickParam && (!hi || c.param < hi.param)) hi = c
  }
  return { lo, hi }
}

/** Cyclic bounds around the click angle on a circle (cuts sorted
 *  ascending; wraps both ways). Requires cuts.length >= 1. */
function cyclicCutBounds(cuts: Cut[], clickParam: number): { lo: Cut; hi: Cut } {
  let lo = cuts[cuts.length - 1] // wraps when the click precedes every cut
  let hi = cuts[0]               // wraps when the click follows every cut
  for (const c of cuts) {
    if (c.param <= clickParam) lo = c
  }
  for (let i = cuts.length - 1; i >= 0; i--) {
    if (cuts[i].param > clickParam) hi = cuts[i]
  }
  return { lo, hi }
}

// ---- Per-kind trims -------------------------------------------------------------

export interface TrimPlan {
  /** Replacement entities for the target (0 = whole-entity delete). */
  pieces: SketchEntity[]
  sites: SiteMap
  /** New cut endpoints -> the boundary they were trimmed against. */
  cutPoints: Array<{ point: PointRef; object: string }>
  /** Original-param span each piece covers (parallel to `pieces`):
   *  line t, arc angle-offset, circle absolute angle (`to` may exceed
   *  2pi — containment wraps for circles). Drives the region checks of
   *  the entity-level constraint repair (tangency survival). */
  spans: Array<{ from: number; to: number }>
}

function planLineTrim(
  target: SketchLineEntity, cuts: Cut[], clickParam: number, newId: () => string,
): TrimPlan | null {
  const L = dist(target.start, target.end)
  if (L <= EPS_LEN) return null
  const { lo, hi } = cutBounds(cuts, clickParam)
  const keepA = lo !== null && lo.param * L > EPS_LEN
  const keepB = hi !== null && (1 - hi.param) * L > EPS_LEN
  if (!keepA && !keepB) return { pieces: [], sites: new Map(), cutPoints: [], spans: [] }

  const pieces: SketchEntity[] = []
  const sites: SiteMap = new Map()
  const cutPoints: TrimPlan['cutPoints'] = []
  const spans: TrimPlan['spans'] = []

  if (keepA) {
    // Start-side piece keeps the original id (and the original start).
    pieces.push({ ...target, end: { x: lo!.point.x, y: lo!.point.y } })
    spans.push({ from: 0, to: lo!.param })
    cutPoints.push({ point: { entityId: target.id, site: 'end' }, object: lo!.cutterId })
    if (keepB) {
      const idB = newId()
      pieces.push({
        ...target, id: idB, start: { x: hi!.point.x, y: hi!.point.y },
      })
      spans.push({ from: hi!.param, to: 1 })
      // The original END survives on piece B.
      sites.set('end', { entityId: idB, site: 'end' })
      cutPoints.push({ point: { entityId: idB, site: 'start' }, object: hi!.cutterId })
    } else {
      sites.set('end', null) // original end was on removed geometry
    }
  } else {
    // Only the end-side piece survives: it keeps the original id.
    pieces.push({ ...target, start: { x: hi!.point.x, y: hi!.point.y } })
    spans.push({ from: hi!.param, to: 1 })
    sites.set('start', null)
    cutPoints.push({ point: { entityId: target.id, site: 'start' }, object: hi!.cutterId })
  }
  return { pieces, sites, cutPoints, spans }
}

function planArcTrim(
  target: SketchArcEntity, cuts: Cut[], clickParam: number, newId: () => string,
): TrimPlan | null {
  const sweep = arcSweep(target)
  const { lo, hi } = cutBounds(cuts, clickParam)
  const keepA = lo !== null && lo.param > EPS_ANG
  const keepB = hi !== null && sweep - hi.param > EPS_ANG
  if (!keepA && !keepB) return { pieces: [], sites: new Map(), cutPoints: [], spans: [] }

  const pieces: SketchEntity[] = []
  const sites: SiteMap = new Map()
  const cutPoints: TrimPlan['cutPoints'] = []
  const spans: TrimPlan['spans'] = []

  if (keepA) {
    pieces.push({ ...target, endAngle: norm(target.startAngle + lo!.param) })
    spans.push({ from: 0, to: lo!.param })
    cutPoints.push({ point: { entityId: target.id, site: 'end' }, object: lo!.cutterId })
    if (keepB) {
      const idB = newId()
      pieces.push({
        ...target, id: idB, startAngle: norm(target.startAngle + hi!.param),
      })
      spans.push({ from: hi!.param, to: sweep })
      sites.set('end', { entityId: idB, site: 'end' })
      cutPoints.push({ point: { entityId: idB, site: 'start' }, object: hi!.cutterId })
    } else {
      sites.set('end', null)
    }
  } else {
    pieces.push({ ...target, startAngle: norm(target.startAngle + hi!.param) })
    spans.push({ from: hi!.param, to: sweep })
    sites.set('start', null)
    cutPoints.push({ point: { entityId: target.id, site: 'start' }, object: hi!.cutterId })
  }
  // The center site survives on every piece that keeps the original id.
  return { pieces, sites, cutPoints, spans }
}

function planCircleTrim(
  target: SketchCircleEntity, cuts: Cut[], clickParam: number,
): TrimPlan | null {
  // A bounded span needs two distinct cut angles; fewer = whole delete.
  if (cuts.length < 2) return { pieces: [], sites: new Map(), cutPoints: [], spans: [] }
  // Cyclic bounds around the click angle (cuts are sorted ascending).
  const { lo, hi } = cyclicCutBounds(cuts, clickParam)
  const keptSweep = norm(lo.param - hi.param)
  if (keptSweep <= EPS_ANG) return { pieces: [], sites: new Map(), cutPoints: [], spans: [] }

  // The circle becomes ONE arc spanning CCW from the upper bound back
  // around to the lower bound (everything except the clicked span). It
  // keeps the circle's id, so center-site and entity-level references
  // (concentric, tangent, equal, radius dims) stay valid unchanged.
  const arc: SketchArcEntity = {
    id: target.id,
    kind: 'arc',
    construction: target.construction,
    provenance: target.provenance,
    center: { x: target.center.x, y: target.center.y },
    radius: target.radius,
    startAngle: hi.param,
    endAngle: lo.param,
  }
  return {
    pieces: [arc],
    sites: new Map(),
    cutPoints: [
      { point: { entityId: target.id, site: 'start' }, object: hi.cutterId },
      { point: { entityId: target.id, site: 'end' }, object: lo.cutterId },
    ],
    // Circle param space is the absolute angle; the kept arc runs CCW
    // from hi around to lo (`to` may pass 2pi — containment wraps).
    spans: [{ from: hi.param, to: hi.param + keptSweep }],
  }
}

// ---- Ellipse / elliptical-arc trims -----------------------------------------
//
// TRIM-TO-CONSTRUCTION (Operator 2026-07-01): trimming an ellipse or elliptical
// arc MAINTAINS THE SHAPE — the clicked (removed) span is NOT dropped, it is
// re-emitted as CONSTRUCTION geometry (kept for reference; construction is
// never baked to a Loop2D, so it is not cut along a path or extruded in 3D).
// This removed->construction default is SCOPED to ellipse/elliptical-arc;
// line/circle/arc trim keep their normal drop-the-span behavior.
//
// Both ellipse and elliptical-arc are SOLVER-INERT (types.ts / gcsMapping):
// only 'center' is an addressable solver point, so the pieces carry the
// shape verbatim and NO point_on_object cutPoints are emitted (the arc
// endpoints are not solver points — a point_on_object onto them would fail
// the gcs mapping). Center-based and entity-id references stay valid on the
// KEPT piece because it keeps the original id.

/** Shared shape fields for a piece cut from an ellipse/elliptical-arc. */
export function ellipseBase(
  e: SketchEllipseEntity | SketchEllipticalArcEntity,
): Pick<
  SketchEllipticalArcEntity,
  'kind' | 'center' | 'majorRadius' | 'minorRadius' | 'rotation' | 'provenance'
> {
  return {
    kind: 'elliptical-arc',
    center: { x: e.center.x, y: e.center.y },
    majorRadius: e.majorRadius,
    minorRadius: e.minorRadius,
    rotation: e.rotation,
    provenance: e.provenance,
  }
}

function planEllipseTrim(
  target: SketchEllipseEntity, cuts: Cut[], clickParam: number, newId: () => string,
): TrimPlan | null {
  // A bounded span needs two distinct cut params; fewer = whole delete.
  if (cuts.length < 2) return { pieces: [], sites: new Map(), cutPoints: [], spans: [] }
  const { lo, hi } = cyclicCutBounds(cuts, clickParam)
  const keptSweep = norm(lo.param - hi.param)     // CCW hi -> lo (complement)
  if (keptSweep <= EPS_ANG) return { pieces: [], sites: new Map(), cutPoints: [], spans: [] }
  const removedSweep = norm(hi.param - lo.param)  // CCW lo -> hi (clicked span)

  const base = ellipseBase(target)
  // KEPT span becomes an elliptical-arc keeping the ellipse id (center site
  // + entity-id refs stay valid), construction only if the source was.
  const kept: SketchEllipticalArcEntity = {
    ...base, id: target.id, construction: target.construction,
    startParam: hi.param, endParam: lo.param,
  }
  // REMOVED (clicked) span is re-emitted as CONSTRUCTION (maintain the shape).
  const removed: SketchEllipticalArcEntity = {
    ...base, id: newId(), construction: true,
    startParam: lo.param, endParam: hi.param,
  }
  return {
    pieces: [kept, removed],
    sites: new Map(),
    cutPoints: [], // solver-inert endpoints — no point_on_object
    spans: [
      { from: hi.param, to: hi.param + keptSweep },
      { from: lo.param, to: lo.param + removedSweep },
    ],
  }
}

function planEllipticalArcTrim(
  target: SketchEllipticalArcEntity, cuts: Cut[], clickParam: number, newId: () => string,
): TrimPlan | null {
  const sweep = ellipticalArcSweep(target.startParam, target.endParam)
  const { lo, hi } = cutBounds(cuts, clickParam)
  const keepA = lo !== null && lo.param > EPS_ANG
  const keepB = hi !== null && sweep - hi.param > EPS_ANG
  if (!keepA && !keepB) return { pieces: [], sites: new Map(), cutPoints: [], spans: [] }

  const pieces: SketchEntity[] = []
  const sites: SiteMap = new Map()
  const spans: TrimPlan['spans'] = []
  const base = ellipseBase(target)
  // Removed-span offsets (from startParam), filled below.
  let remFrom = 0
  let remTo = sweep

  if (keepA) {
    // Start-side piece keeps the original id (and the original startParam).
    pieces.push({ ...target, endParam: norm(target.startParam + lo!.param) })
    spans.push({ from: 0, to: lo!.param })
    remFrom = lo!.param
    if (keepB) {
      const idB = newId()
      pieces.push({ ...target, id: idB, startParam: norm(target.startParam + hi!.param) })
      spans.push({ from: hi!.param, to: sweep })
      sites.set('end', { entityId: idB, site: 'end' })
      remTo = hi!.param
    } else {
      sites.set('end', null)
      remTo = sweep
    }
  } else {
    // Only the end-side piece survives: it keeps the original id.
    pieces.push({ ...target, startParam: norm(target.startParam + hi!.param) })
    spans.push({ from: hi!.param, to: sweep })
    sites.set('start', null)
    remFrom = 0
    remTo = hi!.param
  }

  // Removed span re-emitted as CONSTRUCTION (maintain the shape).
  if (remTo - remFrom > EPS_ANG) {
    pieces.push({
      ...base, id: newId(), construction: true,
      startParam: norm(target.startParam + remFrom),
      endParam: norm(target.startParam + remTo),
    })
    spans.push({ from: remFrom, to: remTo })
  }
  return { pieces, sites, cutPoints: [], spans }
}

// ---- Entity-level constraint repair ---------------------------------------------
//
// KEPT / DROPPED TABLE for constraints/dimensions that reference the
// trimmed entity BY ID (point-site references are handled separately by
// the SiteMap above). "A" = the piece keeping the original id, "B" = the
// second piece of a split (collinear / co-circular with A by
// construction).
//
//   tangent             REGION CHECK: kept on the piece whose span holds
//                       the tangency point (A verbatim; remapped to B
//                       when the tangency region moved there); DROPPED
//                       when the tangency region itself was trimmed away.
//   horizontal/vertical kept on A, AND a copy applied to B — both pieces
//   (line form)         are collinear, the orientation intent holds.
//   parallel/perp       kept on A, AND a copy applied to B (collinear).
//   equal (line-line)   DROPPED — trim changed the length; the equality
//                       intent is stale on every surviving piece.
//   equal (radius)      kept on A — trimming an arc/circle never changes
//                       its radius. (Not copied to B: one radius intent,
//                       one constraint.)
//   midpoint (line ref) DROPPED when the trimmed entity IS the referenced
//                       line — the original midpoint no longer exists, and
//                       keeping it would drag the anchored point to the
//                       shorter piece's midpoint. The anchored point stays
//                       put at the cut-away virtual midpoint.
//   concentric, angle/radius/diameter dims, point_on_object target,
//   symmetric axis, fix entity
//                       kept on A (the original id keeps them valid; the
//                       infinite-line / full-circle meaning is unchanged).
//   distance/X/Y dim spanning the entity's own start+end (a length dim)
//                       CONVERTED: re-pointed at A's surviving endpoints
//                       and re-measured — a stale driving length would
//                       fight the cut's point_on_object on the next
//                       solve. The notice says what it now measures.

/** One non-trivial repair the trim performed (notice fodder). */
export interface TrimRepair {
  action: 'remapped' | 'propagated' | 'dropped' | 'converted'
  kind: SketchConstraint['kind'] | SketchDimension['kind']
  /** The other entity involved (label lookup for notices), if any. */
  otherId: string | null
  reason: string
  /** Id of the repaired (still-surviving) constraint/dimension — lets
   *  the notice's "kept N" count exclude items already called out. */
  id?: string
}

// Region-check tolerance: a tangency point exactly ON a cut boundary
// counts as inside the adjacent surviving piece (boundary-inclusive).
const EPS_REGION = 1e-7

function spanContains(
  targetKind: SketchEntity['kind'], span: { from: number; to: number }, raw: number,
): boolean {
  if (targetKind === 'circle') {
    // Wrapping containment: CCW travel from `from` within the kept sweep.
    return norm(raw - span.from) <= span.to - span.from + EPS_REGION
  }
  return raw >= span.from - EPS_REGION && raw <= span.to + EPS_REGION
}

/** UNCLAMPED parameter of the tangency point between the trimmed target
 *  and `other`, in the target's original param space (line t / arc
 *  angle-offset / circle absolute angle), or null when no tangency
 *  geometry exists (parallel-kind pairs, degenerate). Derived from the
 *  CURRENT geometry: for a satisfied tangent this is the touch point;
 *  for a not-yet-solved one it is the nearest-approach point — the same
 *  spot the solver will pull the tangency to. */
function tangencyParamOnTarget(target: SketchEntity, other: SketchEntity): number | null {
  if (target.kind === 'line' && (other.kind === 'circle' || other.kind === 'arc')) {
    const dx = target.end.x - target.start.x
    const dy = target.end.y - target.start.y
    const len2 = dx * dx + dy * dy
    if (len2 <= 0) return null
    // Foot of the perpendicular from the circle center (unclamped t).
    return ((other.center.x - target.start.x) * dx + (other.center.y - target.start.y) * dy) / len2
  }
  if (target.kind === 'arc' || target.kind === 'circle') {
    let p: Vec2 | null = null
    if (other.kind === 'line') {
      const dx = other.end.x - other.start.x
      const dy = other.end.y - other.start.y
      const len2 = dx * dx + dy * dy
      if (len2 <= 0) return null
      const t =
        ((target.center.x - other.start.x) * dx + (target.center.y - other.start.y) * dy) / len2
      const foot = { x: other.start.x + t * dx, y: other.start.y + t * dy }
      const ux = foot.x - target.center.x
      const uy = foot.y - target.center.y
      const ulen = Math.hypot(ux, uy)
      if (ulen <= EPS_LEN) return null // line through the center: no tangency
      p = {
        x: target.center.x + (ux / ulen) * target.radius,
        y: target.center.y + (uy / ulen) * target.radius,
      }
    } else if (other.kind === 'circle' || other.kind === 'arc') {
      const ux = other.center.x - target.center.x
      const uy = other.center.y - target.center.y
      const ulen = Math.hypot(ux, uy)
      if (ulen <= EPS_LEN) return null // concentric: no tangency point
      // Internal vs external tangency both touch on the center line;
      // pick the candidate nearer the other circle.
      const cand: Vec2[] = [
        { x: target.center.x + (ux / ulen) * target.radius,
          y: target.center.y + (uy / ulen) * target.radius },
        { x: target.center.x - (ux / ulen) * target.radius,
          y: target.center.y - (uy / ulen) * target.radius },
      ]
      const err = (q: Vec2): number => Math.abs(dist(q, other.center) - other.radius)
      p = err(cand[0]) <= err(cand[1]) ? cand[0] : cand[1]
    }
    if (!p) return null
    const a = Math.atan2(p.y - target.center.y, p.x - target.center.x)
    return target.kind === 'arc' ? norm(a - target.startAngle) : norm(a)
  }
  return null
}

/** Apply the kept/dropped table to entity-level constraint references.
 *  `constraints` has already been through the point-site mapping. */
export function repairEntityConstraints(
  doc: SketchDoc,
  target: SketchEntity,
  plan: TrimPlan,
  constraints: SketchConstraint[],
  newId: () => string,
): { constraints: SketchConstraint[]; repairs: TrimRepair[] } {
  const out: SketchConstraint[] = []
  const repairs: TrimRepair[] = []
  const pieceB = plan.pieces.find((p) => p.id !== target.id) ?? null

  for (const c of constraints) {
    switch (c.kind) {
      case 'tangent': {
        if (c.a !== target.id && c.b !== target.id) { out.push(c); break }
        const otherId = c.a === target.id ? c.b : c.a
        const other = doc.entities.find((e) => e.id === otherId)
        const raw = other ? tangencyParamOnTarget(target, other) : null
        if (raw === null) { out.push(c); break } // no tangency geometry: keep
        const home = plan.pieces.find((_p, i) =>
          spanContains(target.kind, plan.spans[i], raw),
        )
        if (!home) {
          repairs.push({
            action: 'dropped', kind: 'tangent', otherId,
            reason: 'tangency region trimmed away',
          })
          break
        }
        if (home.id === target.id) { out.push(c); break } // region survives on A
        // The tangency region lives on piece B: move the reference there.
        out.push(c.a === target.id ? { ...c, a: home.id } : { ...c, b: home.id })
        repairs.push({
          action: 'remapped', kind: 'tangent', otherId,
          reason: 'tangency region is on the new piece', id: c.id,
        })
        break
      }
      case 'horizontal':
      case 'vertical': {
        out.push(c)
        if (c.line === target.id && pieceB) {
          out.push({ id: newId(), kind: c.kind, line: pieceB.id })
          repairs.push({
            action: 'propagated', kind: c.kind, otherId: null,
            reason: 'applies to both collinear pieces',
          })
        }
        break
      }
      case 'parallel':
      case 'perpendicular':
      case 'collinear': {
        out.push(c)
        if ((c.a === target.id || c.b === target.id) && pieceB) {
          out.push(
            c.a === target.id
              ? { id: newId(), kind: c.kind, a: pieceB.id, b: c.b }
              : { id: newId(), kind: c.kind, a: c.a, b: pieceB.id },
          )
          repairs.push({
            action: 'propagated', kind: c.kind,
            otherId: c.a === target.id ? c.b : c.a,
            reason: 'applies to both collinear pieces',
          })
        }
        break
      }
      case 'equal': {
        if (c.a !== target.id && c.b !== target.id) { out.push(c); break }
        if (target.kind === 'line') {
          // Equal LENGTH: trim changed the length — stale on every piece.
          repairs.push({
            action: 'dropped', kind: 'equal',
            otherId: c.a === target.id ? c.b : c.a,
            reason: 'lengths changed',
          })
          break
        }
        out.push(c) // equal RADIUS: trimming never changes the radius
        break
      }
      case 'midpoint': {
        // A midpoint constraint anchors c.point to the MIDDLE of c.line.
        // Keeping it on the original-id piece (which is now a shorter piece
        // after the trim) re-resolves "midpoint" to that piece's middle and
        // DRAGS the anchored point there (Operator 2026-06-13: a circle pinned to
        // a line's midpoint jumped left when the line was trimmed at it). The
        // original midpoint no longer exists, so DROP the constraint — the
        // anchored point stays put at the virtual midpoint that was cut away.
        // (When c.point sat on the trimmed line instead, the site mapper has
        // already handled c.point; here we only fire for the line reference.)
        if (c.line === target.id) {
          repairs.push({
            action: 'dropped', kind: 'midpoint', otherId: null,
            reason: 'line trimmed — original midpoint is gone',
          })
          break
        }
        out.push(c)
        break
      }
      default:
        out.push(c) // kept on the original-id piece (see table)
    }
  }
  return { constraints: out, repairs }
}

/** CONVERT length-style dims that span the trimmed line's own endpoints:
 *  re-point them at the original-id piece and re-measure. Runs BEFORE the
 *  generic site mapping (which would either smear the dim across the gap
 *  via the moved-site rewrite or cascade it away with a removed site).
 *  Returns the dims to keep converting + the rest to map normally. */
function convertOwnLengthDims(
  dimensions: readonly SketchDimension[],
  target: SketchEntity,
  plan: TrimPlan,
): { converted: SketchDimension[]; rest: SketchDimension[]; repairs: TrimRepair[] } {
  const converted: SketchDimension[] = []
  const rest: SketchDimension[] = []
  const repairs: TrimRepair[] = []
  const linePieceA = plan.pieces.find((p): p is SketchLineEntity =>
    p.id === target.id && p.kind === 'line',
  )
  const arcPieceA = plan.pieces.find((p): p is SketchArcEntity =>
    p.id === target.id && p.kind === 'arc',
  )
  for (const d of dimensions) {
    if (arcPieceA && d.kind === 'arcLength' && d.entityId === target.id) {
      converted.push({
        ...d,
        value: arcPieceA.radius * positiveArcSweep(
          arcPieceA.startAngle, arcPieceA.endAngle,
        ),
      })
      repairs.push({
        action: 'converted', kind: d.kind, otherId: null,
        reason: 'arc length dim now measures the kept piece', id: d.id,
      })
      continue
    }
    const isOwnLength =
      linePieceA !== undefined &&
      (d.kind === 'distance' || d.kind === 'distanceX' || d.kind === 'distanceY') &&
      d.a.entityId === target.id && d.b.entityId === target.id &&
      d.a.site !== d.b.site &&
      (d.a.site === 'start' || d.a.site === 'end') &&
      (d.b.site === 'start' || d.b.site === 'end')
    if (!isOwnLength) { rest.push(d); continue }
    const value =
      d.kind === 'distance' ? dist(linePieceA.start, linePieceA.end) :
      d.kind === 'distanceX' ? Math.abs(linePieceA.end.x - linePieceA.start.x) :
      Math.abs(linePieceA.end.y - linePieceA.start.y)
    converted.push({
      ...d,
      a: { entityId: target.id, site: 'start' },
      b: { entityId: target.id, site: 'end' },
      value,
    })
    repairs.push({
      action: 'converted', kind: d.kind, otherId: null,
      reason: 'length dim now measures the kept piece', id: d.id,
    })
  }
  return { converted, rest, repairs }
}

// ---- Core transform --------------------------------------------------------------

interface TrimResult {
  transform: SketchDocTransform
  /** Non-trivial constraint/dimension repairs (notice fodder). */
  repairs: TrimRepair[]
  /** Id of the entity that was trimmed (notice label lookup). */
  targetId: string
}

/** Trim `target` at the clicked curve parameter. Returns the document
 *  transform + repair log, or null when the click changes nothing
 *  (degenerate target). */
function trimEntityAt(
  doc: SketchDoc, target: SketchEntity, world: Vec2, newId: () => string,
): TrimResult | null {
  // Points + splines + text + blocks are not trimmable (use Delete/Explode).
  // Ellipse and elliptical-arc ARE trimmable (removed span -> construction geometry).
  if (target.kind === 'point' || target.kind === 'spline' || target.kind === 'text'
      || target.kind === 'block') {
    return null
  }
  const cuts = collectCuts(doc, target)
  const clickParam = paramOf(target, world)

  let plan: TrimPlan | null
  switch (target.kind) {
    case 'line':   plan = planLineTrim(target, cuts, clickParam, newId); break
    case 'arc':    plan = planArcTrim(target, cuts, clickParam, newId); break
    case 'circle': plan = planCircleTrim(target, cuts, clickParam); break
    case 'ellipse': plan = planEllipseTrim(target, cuts, clickParam, newId); break
    case 'elliptical-arc':
      plan = planEllipticalArcTrim(target, cuts, clickParam, newId); break
  }
  if (!plan) return null

  // No surviving piece: whole-entity delete with the established cascade.
  if (plan.pieces.length === 0) {
    const r = deleteFromSketch(doc, [target.id])
    return r
      ? {
          transform: {
            entities: r.entities, constraints: r.constraints, dimensions: r.dimensions,
          },
          repairs: [],
          targetId: target.id,
        }
      : null
  }

  const mapper = makeRefMapper(target.id, plan.sites)
  const entities = doc.entities.flatMap((e) =>
    e.id === target.id ? plan.pieces : [e]
  )
  const sited = doc.constraints
    .map((c) => mapConstraintRefs(c, mapper))
    .filter((c): c is SketchConstraint => c !== null)
  const entityRepair = repairEntityConstraints(doc, target, plan, sited, newId)
  const constraints = entityRepair.constraints

  const dimSplit = convertOwnLengthDims(doc.dimensions, target, plan)
  const dimensions = [
    ...dimSplit.rest
      .map((d) => mapDimensionRefs(d, mapper))
      .filter((d): d is SketchDimension => d !== null),
    ...dimSplit.converted,
  ]

  // Every new cut endpoint stays on the boundary it was trimmed against —
  // except a SOLVER-INERT cutter (ellipse / elliptical-arc), which planegcs
  // cannot express as a point_on_object target (see fixPointConstraint):
  // FIX the cut point in place instead, and say so through the notice
  // channel (the tool promises "constraints repair automatically" on
  // screen — this downgrade is a repair, not a silent drop).
  const cutRepairs: TrimRepair[] = []
  for (const cp of plan.cutPoints) {
    const cutter = doc.entities.find((e) => e.id === cp.object)
    const solverInertCutter = cutter?.kind === 'ellipse' || cutter?.kind === 'elliptical-arc'
    if (solverInertCutter) {
      constraints.push(fixPointConstraint(newId, cp.point))
      cutRepairs.push({
        action: 'converted', kind: 'fix', otherId: cp.object,
        reason: 'cutter is solver-inert — cut point fixed in place instead of anchored to it',
      })
    } else {
      constraints.push(pointOnObject(newId, cp.point, cp.object))
    }
  }
  return {
    transform: {
      entities: markProjectedGeometryDetached(doc.entities, entities, [target.id]),
      constraints: detachProjectedFixes(doc.entities, constraints, [target.id]),
      dimensions,
    },
    repairs: [...entityRepair.repairs, ...dimSplit.repairs, ...cutRepairs],
    targetId: target.id,
  }
}

// ---- Removal-span highlight ---------------------------------------------------------
//
// "What is about to be trimmed": the EXACT span a click at `world` would
// remove, as a tessellated polyline. Derived from the SAME cuts/bounds
// the planners use (cutBounds/cyclicCutBounds), so the highlight can
// never disagree with the committed trim.

/** Tessellated polyline of a parameter span on the target curve. */
function spanOutline(
  target: SketchEntity, fromParam: number, toParam: number,
): Vec2[] | null {
  switch (target.kind) {
    case 'line': {
      const at = (t: number): Vec2 => ({
        x: target.start.x + t * (target.end.x - target.start.x),
        y: target.start.y + t * (target.end.y - target.start.y),
      })
      return [at(fromParam), at(toParam)]
    }
    case 'arc':
    case 'circle': {
      const start = target.kind === 'arc' ? target.startAngle : 0
      const a0 = start + fromParam
      const sweep = target.kind === 'circle'
        ? (norm(toParam - fromParam) < EPS_ANG && toParam !== fromParam
            ? TWO_PI
            : norm(toParam - fromParam))
        : toParam - fromParam
      const n = Math.max(8, Math.ceil((Math.abs(sweep) * target.radius) / 0.5))
      const pts: Vec2[] = []
      for (let i = 0; i <= n; i++) {
        pts.push(arcPointAt(target, a0 + (sweep * i) / n))
      }
      return pts
    }
    // Ellipse params are absolute eccentric params (toParam may exceed 2pi).
    case 'ellipse':
      return tessellateEllipticalArc(target, fromParam, toParam)
    // Elliptical-arc params are OFFSETS from startParam.
    case 'elliptical-arc':
      return tessellateEllipticalArc(
        target, target.startParam + fromParam, target.startParam + toParam,
      )
    default:
      return null
  }
}

/** The span a click at `world` on `target` would REMOVE, or null when
 *  the click would change nothing (degenerate target). */
export function trimRemovalSpan(
  doc: SketchDoc, target: SketchEntity, world: Vec2,
): Vec2[] | null {
  if (target.kind === 'point' || target.kind === 'spline' || target.kind === 'text'
      || target.kind === 'block') {
    return null
  }
  const cuts = collectCuts(doc, target)
  const clickParam = paramOf(target, world)

  switch (target.kind) {
    case 'line': {
      const L = dist(target.start, target.end)
      if (L <= EPS_LEN) return null
      const { lo, hi } = cutBounds(cuts, clickParam)
      const keepA = lo !== null && lo.param * L > EPS_LEN
      const keepB = hi !== null && (1 - hi.param) * L > EPS_LEN
      return spanOutline(target, keepA ? lo!.param : 0, keepB ? hi!.param : 1)
    }
    case 'arc': {
      const sweep = arcSweep(target)
      const { lo, hi } = cutBounds(cuts, clickParam)
      const keepA = lo !== null && lo.param > EPS_ANG
      const keepB = hi !== null && sweep - hi.param > EPS_ANG
      return spanOutline(target, keepA ? lo!.param : 0, keepB ? hi!.param : sweep)
    }
    case 'circle': {
      // Fewer than two cuts (or a degenerate kept sweep) = the WHOLE
      // circle goes — highlight all of it.
      if (cuts.length < 2) return spanOutline(target, 0, TWO_PI)
      const { lo, hi } = cyclicCutBounds(cuts, clickParam)
      const keptSweep = norm(lo.param - hi.param)
      if (keptSweep <= EPS_ANG) return spanOutline(target, 0, TWO_PI)
      // Kept arc runs CCW hi -> lo; the REMOVED span is CCW lo -> hi.
      return spanOutline(target, lo.param, lo.param + norm(hi.param - lo.param))
    }
    case 'ellipse': {
      // Fewer than two cuts (or a degenerate kept sweep) = whole delete.
      if (cuts.length < 2) return spanOutline(target, 0, TWO_PI)
      const { lo, hi } = cyclicCutBounds(cuts, clickParam)
      const keptSweep = norm(lo.param - hi.param)
      if (keptSweep <= EPS_ANG) return spanOutline(target, 0, TWO_PI)
      // Kept arc runs CCW hi -> lo; the REMOVED span is CCW lo -> hi.
      return spanOutline(target, lo.param, lo.param + norm(hi.param - lo.param))
    }
    case 'elliptical-arc': {
      const sweep = ellipticalArcSweep(target.startParam, target.endParam)
      const { lo, hi } = cutBounds(cuts, clickParam)
      const keepA = lo !== null && lo.param > EPS_ANG
      const keepB = hi !== null && sweep - hi.param > EPS_ANG
      return spanOutline(target, keepA ? lo!.param : 0, keepB ? hi!.param : sweep)
    }
  }
}

/**
 * Hover highlight for the armed trim tool: the exact span a click at
 * `world` would remove, or null when nothing is under the cursor.
 */
export function trimHighlight(
  doc: SketchDoc, world: Vec2, tol: number,
): Vec2[][] | null {
  const target = pickCurve(doc.entities, world, tol)
  if (!target) return null
  const span = trimRemovalSpan(doc, target, world)
  return span && span.length >= 2 ? [span] : null
}

// ---- Repair notices ------------------------------------------------------------
//
// Repair TRANSPARENCY: every non-trivial repair (remapped / propagated /
// dropped / converted) is summarized in the commit flash — intelligent
// cleanup includes SAYING what was done. A trim with no repairs returns
// a null notice and the generic "Trimmed ..." flash speaks instead.

/** One clause per repair action ("dropped Equal (lengths changed)"). */
function repairClause(r: TrimRepair): string {
  switch (r.action) {
    case 'dropped':    return `dropped ${constraintKindLabel(r.kind)} (${r.reason})`
    case 'remapped':   return `moved ${constraintKindLabel(r.kind)} to the new piece`
    case 'propagated': return `applied ${constraintKindLabel(r.kind)} to both pieces`
    case 'converted':  return r.reason
  }
}

/** Dedupe identical clauses into "clause x2" form (swipes repeat). */
export function tallyClauses(clauses: readonly string[]): string[] {
  const counts = new Map<string, number>()
  for (const c of clauses) counts.set(c, (counts.get(c) ?? 0) + 1)
  return [...counts.entries()].map(([c, k]) => (k > 1 ? `${c} x${k}` : c))
}

/** Constraints/dimensions that referenced the target BEFORE the trim and
 *  survive (same id) AFTER it, minus the ones a repair already calls out
 *  by name — the "kept N constraints" count of the notice. */
function keptRefCount(doc: SketchDoc, r: TrimResult): number {
  const called = new Set(r.repairs.map((x) => x.id).filter((x): x is string => !!x))
  const before = [
    ...doc.constraints
      .filter((c) => constraintRefIds(c).includes(r.targetId))
      .map((c) => c.id),
    ...doc.dimensions
      .filter((d) => dimensionRefIds(d).includes(r.targetId))
      .map((d) => d.id),
  ]
  const after = new Set([
    ...r.transform.constraints.map((c) => c.id),
    ...r.transform.dimensions.map((d) => d.id),
  ])
  return before.filter((id) => after.has(id) && !called.has(id)).length
}

function trimRepairNotice(doc: SketchDoc, r: TrimResult): string | null {
  if (r.repairs.length === 0) return null
  const label = entityLabels(doc.entities).get(r.targetId) ?? 'entity'
  const kept = keptRefCount(doc, r)
  const clauses = tallyClauses(r.repairs.map(repairClause))
  return (
    `Trimmed ${label}: kept ${kept} constraint${kept === 1 ? '' : 's'}, ` +
    clauses.join(', ')
  )
}

// ---- Public: click trim ------------------------------------------------------------

/**
 * CLICK(p) for the armed trim tool: trim the curve under the cursor at
 * the clicked spot. Empty clicks are quiet (nothing was asked); a click
 * that hits geometry always either transforms the document or explains
 * itself via `notice`. A successful trim that repaired constraints also
 * reports WHAT it did through `notice` (repair transparency).
 */
export function trimAtPoint(
  doc: SketchDoc,
  world: Vec2,
  tol: number,
  newId: () => string = () => crypto.randomUUID(),
): TrimOutcome {
  const target = pickCurve(doc.entities, world, tol)
  if (!target) return NO_OP
  const r = trimEntityAt(doc, target, world, newId)
  if (!r) {
    return { transform: null, notice: 'Trim: nothing to trim there' }
  }
  return { transform: r.transform, notice: trimRepairNotice(doc, r) }
}

// ---- Public: drag-swipe trim ---------------------------------------------------------

/** Iteration guard: a swipe can never trim more pieces than this. */
const SWIPE_CAP = 100

/**
 * Shared swipe-crossing walk: every curve segment the path crosses is
 * trimmed at the crossing point, one at a time in path order against the
 * EVOLVING document (a piece created by one crossing can itself be
 * trimmed by a later one). `onTrim` observes each crossing against the
 * document it applies to, BEFORE the trim lands — the highlight preview
 * collects removal spans through it.
 */
function runSwipe(
  doc: SketchDoc,
  path: readonly Vec2[],
  newId: () => string,
  onTrim?: (current: SketchDoc, target: SketchEntity, at: Vec2) => void,
): { doc: SketchDoc; trimmed: number; repairs: TrimRepair[] } {
  let current: SketchDoc = doc
  let trimmed = 0
  const repairs: TrimRepair[] = []

  for (let i = 0; i + 1 < path.length && trimmed < SWIPE_CAP; i++) {
    const a = path[i], b = path[i + 1]
    if (dist(a, b) <= EPS_LEN) continue
    // Synthetic swipe segment for the shared intersection primitives.
    const swipeSeg: SketchLineEntity = {
      id: '__swipe__', kind: 'line', construction: false, start: a, end: b,
    }
    // Re-scan this path segment until it crosses nothing: each applied
    // trim removes the crossed span, so the crossing disappears from the
    // next scan (no processed-set bookkeeping needed).
    for (let guard = 0; guard < SWIPE_CAP && trimmed < SWIPE_CAP; guard++) {
      let best: { e: SketchEntity; p: Vec2; t: number } | null = null
      for (const e of current.entities) {
        if (e.kind === 'point') continue
        for (const p of entityIntersections(swipeSeg, e)) {
          const t = paramOf(swipeSeg, p)
          if (!best || t < best.t) best = { e, p, t }
        }
      }
      if (!best) break
      onTrim?.(current, best.e, best.p)
      const next = trimEntityAt(current, best.e, best.p, newId)
      if (!next) break // degenerate target: stop rather than loop
      current = next.transform
      repairs.push(...next.repairs)
      trimmed++
    }
  }
  return { doc: current, trimmed, repairs }
}

/**
 * Drag-swipe trim: every curve segment the swipe path crosses
 * is trimmed at the crossing point, in path order.
 */
export function trimSwipe(
  doc: SketchDoc,
  path: readonly Vec2[],
  newId: () => string = () => crypto.randomUUID(),
): TrimOutcome {
  const r = runSwipe(doc, path, newId)
  if (r.trimmed === 0) return NO_OP
  // Aggregate repair transparency across every span the swipe trimmed
  // (per-entity labels would go stale against the evolving document).
  const clauses = tallyClauses(r.repairs.map(repairClause))
  return {
    transform: {
      entities: [...r.doc.entities],
      constraints: [...r.doc.constraints],
      dimensions: [...r.doc.dimensions],
    },
    notice: clauses.length > 0
      ? `Trimmed ${r.trimmed} span${r.trimmed === 1 ? '' : 's'}: ${clauses.join(', ')}`
      : null,
  }
}

/**
 * Live highlight for an in-progress swipe: the removal spans the swipe
 * so far would trim, accumulating along the path. Same walk as
 * trimSwipe (evolving document), so the highlights are exactly what
 * releasing the drag commits.
 */
export function trimSwipeHighlights(
  doc: SketchDoc, path: readonly Vec2[],
): Vec2[][] {
  const spans: Vec2[][] = []
  let n = 0
  runSwipe(doc, path, () => `__swipe_preview_${n++}__`, (current, target, at) => {
    const span = trimRemovalSpan(current, target, at)
    if (span && span.length >= 2) spans.push(span)
  })
  return spans
}
