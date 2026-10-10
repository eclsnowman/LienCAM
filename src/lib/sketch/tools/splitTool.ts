// Split tool (WO-1567, MODIFY tool pattern).
//
// Split breaks a line, arc or circle into two pieces AT the clicked point —
// trim's mirror image: instead of removing the clicked span, split keeps
// BOTH sides and rejoins them with a coincident constraint so the shape
// does not move. Reuses trimTool's document-transform machinery (the same
// cut-plan / point-site-rewrite / entity-constraint-repair primitives),
// since a split is exactly a trim cut with nothing thrown away:
//   - line:   one click -> two lines meeting at the click, coincident joint
//   - arc:    one click -> two arcs, same center/radius, coincident joint
//   - circle: a single cut leaves a still-closed curve, so it needs TWO
//             points — the first click stages, the second commits two arcs
//             covering the full 360deg, joined at both cut points
//   - ellipse: same two-point staging as circle — two elliptical arcs
//     covering the full ellipse
//   - elliptical-arc: one click, mirrors the arc case — two elliptical arcs
//     whose params sum to the original sweep
//   - spline: pickable (unlike trim, which excludes it) via pickSplitCurve;
//     an OPEN spline splits at one click, a CLOSED spline stages two points
//     like a circle. Each piece is a fresh dense resample of the ORIGINAL
//     curve (splinePointAt) rather than a re-fit through the raw click-point
//     list — exact Catmull-Rom subdivision at an arbitrary interior
//     parameter has no closed form, and resampling densely is the simplest
//     way to hit the WO's curve-fidelity bound (see resampleSplineRange).
//   - text / point / block: pickCurve (shared with trim) already excludes
//     these from picking entirely, so a click on one is the same quiet
//     no-op as an empty click, exactly like trim's own behavior
//
// Constraint survival reuses trim's KEPT/DROPPED table via
// repairEntityConstraints (repairEntityConstraints, trimTool.ts) — a
// constraint that trim would keep on the surviving piece (equal radius,
// tangent-by-region, point_on_object target, concentric, fix, ...) behaves
// the same way here since the original-id piece ("A") is exactly trim's
// kept piece; horizontal/vertical/parallel/perpendicular/collinear still
// propagate a copy onto the second piece ("B") for the same reason trim
// propagates them — both pieces are collinear/co-circular by construction.
// The one place split diverges from trim: a length dimension spanning the
// entity's OWN two endpoints no longer describes EITHER piece after a
// split (trim re-measures the surviving piece; split has no single
// surviving piece), so it is DROPPED here instead of converted — see
// dropOwnLengthDims.
//
// SOLVER-INERT JOINTS (ellipse / elliptical-arc): a coincident constraint
// between two free, untracked solver points only holds at the instant it is
// created — neither point is tied to the entity's actual shape (only
// 'center' is real for these kinds; see gcsMapping's addressable-site
// table), so nothing keeps them together once anything moves the ellipse.
// Per the WO's ruling this gets trim's existing downgrade instead: FIX each
// joint point at its just-computed location (reusing trimTool's
// fixPointConstraint) rather than tying two floating points together.
// Splines get a real coincident joint instead — a spline's own endpoints
// ARE addressable, ordinary solver points (gcsMapping), so the tie behaves
// like the line/arc case.

import type {
  Vec2,
  PointRef,
  SketchEntity,
  SketchArcEntity,
  SketchCircleEntity,
  SketchLineEntity,
  SketchEllipseEntity,
  SketchEllipticalArcEntity,
  SketchSplineEntity,
  SketchConstraint,
  SketchDimension,
} from '../types'
import {
  curveDistance, paramOf, arcSweep, norm, dist, TWO_PI, EPS_LEN, EPS_ANG,
  makeRefMapper, mapConstraintRefs, mapDimensionRefs, repairEntityConstraints,
  tallyClauses, ellipseBase, fixPointConstraint,
  type SketchDoc, type SketchDocTransform, type TrimPlan, type SiteMap, type TrimRepair,
  type RefMapper,
} from './trimTool'
import { ellipticalArcSweep } from '../ellipse'
import { nearestParamOnSpline, splinePointAt, nearestPointOnSpline, type SplineForm } from '../spline'
import { entityLabels } from '../browserModel'
import { constraintKindLabel } from '../constraintActions'
import { detachProjectedFixes, markProjectedGeometryDetached } from '../projectedEdit'

export type { SketchDoc, SketchDocTransform }

// ---- Chain state (CHAINING payload) -----------------------------------------

export interface SplitChainState {
  kind: 'split'
  /** Circle picked at step 1; awaiting the second point. */
  targetId: string
  /** World point of the staged first click. */
  first: Vec2
}

export interface SplitClickOutcome {
  chain: SplitChainState | null
  transform: SketchDocTransform | null
  notice: string | null
}

const NO_OP: SplitClickOutcome = { chain: null, transform: null, notice: null }

// A split plan is a trim plan (pieces / sites / spans, reused verbatim by
// repairEntityConstraints) plus the joint(s) a coincident constraint closes.
interface SplitPlan extends TrimPlan {
  /** Point-site pairs to join with a coincident constraint, one per cut. */
  joints: Array<[PointRef, PointRef]>
  /** Points to FIX in place instead (solver-inert kinds — see the header
   *  note on why a coincident joint would not hold for these). */
  fixedPoints?: PointRef[]
}

// ---- Per-kind plans -----------------------------------------------------------

function planLineSplit(
  target: SketchLineEntity, t: number, newId: () => string,
): SplitPlan | null {
  const L = dist(target.start, target.end)
  if (L <= EPS_LEN) return null
  if (t * L <= EPS_LEN || (1 - t) * L <= EPS_LEN) return null // snapped to an end
  const mid: Vec2 = {
    x: target.start.x + t * (target.end.x - target.start.x),
    y: target.start.y + t * (target.end.y - target.start.y),
  }
  const idB = newId()
  const pieceA: SketchLineEntity = { ...target, end: { x: mid.x, y: mid.y } }
  const pieceB: SketchLineEntity = { ...target, id: idB, start: { x: mid.x, y: mid.y } }
  const sites: SiteMap = new Map([['end', { entityId: idB, site: 'end' }]])
  return {
    pieces: [pieceA, pieceB], sites, cutPoints: [],
    spans: [{ from: 0, to: t }, { from: t, to: 1 }],
    joints: [[{ entityId: target.id, site: 'end' }, { entityId: idB, site: 'start' }]],
  }
}

function planArcSplit(
  target: SketchArcEntity, offset: number, newId: () => string,
): SplitPlan | null {
  const sweep = arcSweep(target)
  if (offset <= EPS_ANG || sweep - offset <= EPS_ANG) return null // snapped to an end
  const splitAngle = norm(target.startAngle + offset)
  const idB = newId()
  const pieceA: SketchArcEntity = { ...target, endAngle: splitAngle }
  const pieceB: SketchArcEntity = { ...target, id: idB, startAngle: splitAngle }
  const sites: SiteMap = new Map([['end', { entityId: idB, site: 'end' }]])
  return {
    pieces: [pieceA, pieceB], sites, cutPoints: [],
    spans: [{ from: 0, to: offset }, { from: offset, to: sweep }],
    joints: [[{ entityId: target.id, site: 'end' }, { entityId: idB, site: 'start' }]],
  }
}

function planCircleSplit(
  target: SketchCircleEntity, a1: number, a2: number, newId: () => string,
): SplitPlan | null {
  const sweepAB = norm(a2 - a1) // CCW travel a1 -> a2
  if (sweepAB <= EPS_ANG || TWO_PI - sweepAB <= EPS_ANG) return null // same point
  const idB = newId()
  const arcA: SketchArcEntity = {
    id: target.id, kind: 'arc', construction: target.construction,
    provenance: target.provenance,
    center: { x: target.center.x, y: target.center.y }, radius: target.radius,
    startAngle: a1, endAngle: a2,
  }
  const arcB: SketchArcEntity = {
    id: idB, kind: 'arc', construction: target.construction,
    provenance: target.provenance,
    center: { x: target.center.x, y: target.center.y }, radius: target.radius,
    startAngle: a2, endAngle: a1,
  }
  return {
    pieces: [arcA, arcB], sites: new Map(), cutPoints: [],
    spans: [{ from: a1, to: a1 + sweepAB }, { from: a2, to: a2 + (TWO_PI - sweepAB) }],
    joints: [
      [{ entityId: target.id, site: 'end' }, { entityId: idB, site: 'start' }],   // at a2
      [{ entityId: idB, site: 'end' }, { entityId: target.id, site: 'start' }],   // at a1
    ],
  }
}

// ---- Ellipse / elliptical-arc splits (solver-inert — fix-at-location joints) ----

function planEllipseSplit(
  target: SketchEllipseEntity, a1: number, a2: number, newId: () => string,
): SplitPlan | null {
  const sweepAB = norm(a2 - a1) // CCW travel a1 -> a2
  if (sweepAB <= EPS_ANG || TWO_PI - sweepAB <= EPS_ANG) return null // same point
  const idB = newId()
  const base = ellipseBase(target)
  const arcA: SketchEllipticalArcEntity = {
    ...base, id: target.id, construction: target.construction,
    startParam: a1, endParam: a2,
  }
  const arcB: SketchEllipticalArcEntity = {
    ...base, id: idB, construction: target.construction,
    startParam: a2, endParam: a1,
  }
  return {
    pieces: [arcA, arcB], sites: new Map(), cutPoints: [],
    spans: [{ from: a1, to: a1 + sweepAB }, { from: a2, to: a2 + (TWO_PI - sweepAB) }],
    joints: [],
    // Every endpoint touching the two cut points is fixed independently
    // (not tied to its counterpart) — see the header note.
    fixedPoints: [
      { entityId: target.id, site: 'end' },
      { entityId: idB, site: 'start' },
      { entityId: idB, site: 'end' },
      { entityId: target.id, site: 'start' },
    ],
  }
}

function planEllipticalArcSplit(
  target: SketchEllipticalArcEntity, offset: number, newId: () => string,
): SplitPlan | null {
  const sweep = ellipticalArcSweep(target.startParam, target.endParam)
  if (offset <= EPS_ANG || sweep - offset <= EPS_ANG) return null // snapped to an end
  const splitParam = norm(target.startParam + offset)
  const idB = newId()
  const pieceA: SketchEllipticalArcEntity = { ...target, endParam: splitParam }
  const pieceB: SketchEllipticalArcEntity = { ...target, id: idB, startParam: splitParam }
  const sites: SiteMap = new Map([['end', { entityId: idB, site: 'end' }]])
  return {
    pieces: [pieceA, pieceB], sites, cutPoints: [],
    spans: [{ from: 0, to: offset }, { from: offset, to: sweep }],
    joints: [],
    fixedPoints: [
      { entityId: target.id, site: 'end' },
      { entityId: idB, site: 'start' },
    ],
  }
}

// ---- Spline splits (dense resample of the ORIGINAL curve, see header note) ----

// Split-point snap tolerance in spline PARAMETER units (segment-count
// space, mirroring EPS_ANG/EPS_LEN's role for the other kinds).
const EPS_SPLINE_PARAM = 1e-6

/** Sample density for a resampled sub-range spanning `qRange` parameter
 *  units. Deliberately far denser than tessellateSpline's render budget —
 *  the WO's 0.001mm/50-sample fidelity bound needs samples much closer
 *  together than anything rendering ever required. */
function splineSplitSampleCount(qRange: number): number {
  return Math.max(32, Math.min(600, Math.ceil(Math.abs(qRange) * 200)))
}

/** Dense through-points tracing the ORIGINAL curve from qFrom to qTo
 *  (inclusive both ends, exact at the ends since splinePointAt is a pure
 *  function of the SAME source points). */
function resampleSplineRange(
  source: readonly Vec2[], closed: boolean, qFrom: number, qTo: number, count: number,
  form?: SplineForm,
): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i <= count; i++) {
    pts.push(splinePointAt(source, closed, qFrom + ((qTo - qFrom) * i) / count, form))
  }
  return pts
}

/** Shared fields for a piece resampled from a split spline — deliberately
 *  NOT a spread of `target` (which would carry stale filletSourcePoints
 *  sized for the ORIGINAL point list, and a control-point spline's `form`:
 *  every piece is dense THROUGH-points sampled from the exact curve, WO-1861
 *  decide-and-log -- a cut B-spline has non-uniform knots the uniform
 *  control-point form cannot carry). */
function splineBase(e: SketchSplineEntity): Pick<SketchSplineEntity, 'kind' | 'construction' | 'provenance'> {
  return { kind: 'spline', construction: e.construction, provenance: e.provenance }
}

function planOpenSplineSplit(
  target: SketchSplineEntity, world: Vec2, newId: () => string,
): SplitPlan | null {
  const source = target.points
  if (source.length < 2) return null
  const max = source.length - 1
  const form = target.form
  const q = nearestParamOnSpline(source, false, world, form)
  if (q <= EPS_SPLINE_PARAM || max - q <= EPS_SPLINE_PARAM) return null // snapped to an end
  const idB = newId()
  const pointsA = resampleSplineRange(source, false, 0, q, splineSplitSampleCount(q), form)
  const pointsB = resampleSplineRange(source, false, q, max, splineSplitSampleCount(max - q), form)
  const pieceA: SketchSplineEntity = { ...splineBase(target), id: target.id, closed: false, points: pointsA }
  const pieceB: SketchSplineEntity = { ...splineBase(target), id: idB, closed: false, points: pointsB }
  const sites: SiteMap = new Map([['end', { entityId: idB, site: 'end' }]])
  return {
    pieces: [pieceA, pieceB], sites, cutPoints: [],
    spans: [{ from: 0, to: q }, { from: q, to: max }],
    joints: [[{ entityId: target.id, site: 'end' }, { entityId: idB, site: 'start' }]],
  }
}

function planClosedSplineSplit(
  target: SketchSplineEntity, first: Vec2, world: Vec2, newId: () => string,
): SplitPlan | null {
  const source = target.points
  if (source.length < 3) return null
  const max = source.length
  const normQ = (a: number) => ((a % max) + max) % max
  const form = target.form
  const q1 = normQ(nearestParamOnSpline(source, true, first, form))
  const q2 = normQ(nearestParamOnSpline(source, true, world, form))
  const sweepAB = normQ(q2 - q1) // CCW travel q1 -> q2
  if (sweepAB <= EPS_SPLINE_PARAM || max - sweepAB <= EPS_SPLINE_PARAM) return null // same point
  const idB = newId()
  const pointsA = resampleSplineRange(source, true, q1, q1 + sweepAB, splineSplitSampleCount(sweepAB), form)
  const pointsB = resampleSplineRange(
    source, true, q2, q2 + (max - sweepAB), splineSplitSampleCount(max - sweepAB), form)
  const pieceA: SketchSplineEntity = { ...splineBase(target), id: target.id, closed: false, points: pointsA }
  const pieceB: SketchSplineEntity = { ...splineBase(target), id: idB, closed: false, points: pointsB }

  // The seam ('start' = points[0] @ param 0, 'end' = points[last] @ param
  // max-1) is a real addressable site pair on a closed spline — gcsMapping
  // treats every spline uniformly regardless of `closed`, and snap.ts offers
  // both as endpoint-snap candidates with no closed exclusion, so a
  // pre-existing constraint/dimension CAN target either. By the joint
  // correspondence below (q1 <-> {target:'start', idB:'end'}; q2 <->
  // {target:'end', idB:'start'}), the seam survives as an addressable
  // endpoint only when a cut landed exactly on it; otherwise it is strictly
  // interior to one piece and any reference to it is DROPPED (with a
  // notice — deadSiteRepairs below), mirroring trimTool's midpoint
  // DROP-with-notice for a referenced point that no longer exists (Operator
  // 2026-06-13), rather than silently re-anchoring to that piece's cut end.
  const near = (a: number, b: number): boolean => {
    const d = Math.abs(normQ(a - b))
    return d <= EPS_SPLINE_PARAM || max - d <= EPS_SPLINE_PARAM
  }
  const sites: SiteMap = new Map()
  if (form === 'control') {
    // WO-1861: a CLOSED control-point spline's 'start'/'end' sites are
    // control points, which lie OFF the periodic curve -- neither survives as
    // an endpoint of either piece, so any reference to them is dropped (with
    // the same notice as an interior seam below).
    sites.set('start', null)
    sites.set('end', null)
  } else {
    if (near(q2, 0)) sites.set('start', { entityId: idB, site: 'start' })
    else if (!near(q1, 0)) sites.set('start', null)
    // else: q1 is at the seam — pieceA keeps id target.id, so its own
    // 'start' already IS the seam (no rewrite needed).
    if (near(q1, max - 1)) sites.set('end', { entityId: idB, site: 'end' })
    else if (!near(q2, max - 1)) sites.set('end', null)
    // else: q2 is at the seam-end — pieceA's own 'end' already IS param
    // max-1 (no rewrite needed).
  }

  return {
    pieces: [pieceA, pieceB], sites, cutPoints: [],
    spans: [{ from: q1, to: q1 + sweepAB }, { from: q2, to: q2 + (max - sweepAB) }],
    joints: [
      [{ entityId: target.id, site: 'end' }, { entityId: idB, site: 'start' }],   // at q2
      [{ entityId: idB, site: 'end' }, { entityId: target.id, site: 'start' }],   // at q1
    ],
  }
}

// ---- Split-tool picking ---------------------------------------------------------
//
// Split can pick everything trim can (line/arc/circle/ellipse/elliptical-arc,
// via the shared pickCurve) PLUS splines — trim deliberately excludes splines
// (no curve-vs-curve cut target), but split only needs a point ON the curve,
// which nearestPointOnSpline already provides. This does NOT touch trim's own
// pickCurve, so trim's spline exclusion is unaffected.

function pickSplitCurve(
  entities: readonly SketchEntity[], world: Vec2, tol: number,
): SketchEntity | null {
  let best: { e: SketchEntity; d: number } | null = null
  for (const e of entities) {
    const d = e.kind === 'spline'
      ? nearestPointOnSpline(e.points, e.closed, world, e.form).dist
      : curveDistance(e, world)
    if (d !== null && d <= tol && (!best || d < best.d)) best = { e, d }
  }
  return best?.e ?? null
}

// ---- Own-length dimensions: drop instead of convert -----------------------------
//
// trim's convertOwnLengthDims re-measures a length dim spanning the
// trimmed entity's own endpoints onto the SURVIVING piece — correct there
// because the OTHER piece was thrown away. Split keeps both pieces, so a
// dim between the ORIGINAL start and end no longer describes either one;
// per the WO it is dropped, and the notice says so.

function dropOwnLengthDims(
  dimensions: readonly SketchDimension[], target: SketchEntity,
): { rest: SketchDimension[]; repairs: TrimRepair[] } {
  const rest: SketchDimension[] = []
  const repairs: TrimRepair[] = []
  for (const d of dimensions) {
    if (target.kind === 'arc' && d.kind === 'arcLength' && d.entityId === target.id) {
      repairs.push({
        action: 'dropped', kind: d.kind, otherId: null,
        reason: 'arc split — neither piece has the original sweep',
      })
      continue
    }
    const isOwnLength =
      target.kind === 'line' &&
      (d.kind === 'distance' || d.kind === 'distanceX' || d.kind === 'distanceY') &&
      d.a.entityId === target.id && d.b.entityId === target.id &&
      d.a.site !== d.b.site &&
      (d.a.site === 'start' || d.a.site === 'end') &&
      (d.b.site === 'start' || d.b.site === 'end')
    if (isOwnLength) {
      repairs.push({
        action: 'dropped', kind: d.kind, otherId: null,
        reason: 'line split — neither piece spans the original length',
      })
      continue
    }
    rest.push(d)
  }
  return { rest, repairs }
}

// ---- Dead-site notice -------------------------------------------------------------
//
// A SiteMap entry of `null` means the site was consumed by the split (not an
// endpoint of either piece) — currently only planClosedSplineSplit's seam
// sites do this. mapConstraintRefs/mapDimensionRefs already drop any
// reference through the ref mapper; this pass just recognizes that drop (a
// null result from the SAME mapper) and turns it into a repair record, so it
// reaches the notice channel like every other repair instead of vanishing.

function deadSiteRepairs(
  constraints: readonly SketchConstraint[],
  dimensions: readonly SketchDimension[],
  mapper: RefMapper,
  reason: string,
): TrimRepair[] {
  const repairs: TrimRepair[] = []
  for (const c of constraints) {
    if (mapConstraintRefs(c, mapper) === null) {
      repairs.push({ action: 'dropped', kind: c.kind, otherId: null, reason })
    }
  }
  for (const d of dimensions) {
    if (mapDimensionRefs(d, mapper) === null) {
      repairs.push({ action: 'dropped', kind: d.kind, otherId: null, reason })
    }
  }
  return repairs
}

// ---- Core transform --------------------------------------------------------------

function buildSplitTransform(
  doc: SketchDoc, target: SketchEntity, plan: SplitPlan, newId: () => string,
): { transform: SketchDocTransform; repairs: TrimRepair[] } {
  const mapper = makeRefMapper(target.id, plan.sites)
  const entities = doc.entities.flatMap((e) => (e.id === target.id ? plan.pieces : [e]))
  const sited = doc.constraints
    .map((c) => mapConstraintRefs(c, mapper))
    .filter((c): c is SketchConstraint => c !== null)
  const entityRepair = repairEntityConstraints(doc, target, plan, sited, newId)
  const constraints = entityRepair.constraints

  const dimSplit = dropOwnLengthDims(doc.dimensions, target)
  const dimensions = dimSplit.rest
    .map((d) => mapDimensionRefs(d, mapper))
    .filter((d): d is SketchDimension => d !== null)

  const deadSites = deadSiteRepairs(
    doc.constraints, dimSplit.rest, mapper,
    'closed spline split — the seam point is interior to one piece, not an endpoint of either',
  )

  for (const [a, b] of plan.joints) {
    constraints.push({ id: newId(), kind: 'coincident', a, b })
  }

  const fixRepairs: TrimRepair[] = []
  for (const p of plan.fixedPoints ?? []) {
    constraints.push(fixPointConstraint(newId, p))
    fixRepairs.push({
      action: 'converted', kind: 'fix', otherId: null,
      reason: `${target.kind} is solver-inert — split joint fixed in place instead of a coincident constraint`,
    })
  }

  return {
    transform: {
      entities: markProjectedGeometryDetached(doc.entities, entities, [target.id]),
      constraints: detachProjectedFixes(doc.entities, constraints, [target.id]),
      dimensions,
    },
    repairs: [...entityRepair.repairs, ...dimSplit.repairs, ...fixRepairs, ...deadSites],
  }
}

// ---- Repair notice ----------------------------------------------------------------

function repairClause(r: TrimRepair): string {
  switch (r.action) {
    case 'dropped':    return `dropped ${constraintKindLabel(r.kind)} (${r.reason})`
    case 'remapped':   return `moved ${constraintKindLabel(r.kind)} to the new piece`
    case 'propagated': return `applied ${constraintKindLabel(r.kind)} to both pieces`
    case 'converted':  return r.reason
  }
}

function splitNotice(doc: SketchDoc, targetId: string, repairs: readonly TrimRepair[]): string | null {
  if (repairs.length === 0) return null
  const label = entityLabels(doc.entities).get(targetId) ?? 'entity'
  const clauses = tallyClauses(repairs.map(repairClause))
  return `Split ${label}: ${clauses.join(', ')}`
}

// ---- Click behavior -----------------------------------------------------------------

function splitAtClick(
  doc: SketchDoc, target: SketchEntity, world: Vec2, newId: () => string,
): SplitClickOutcome {
  if (target.kind === 'line') {
    const t = paramOf(target, world)
    const plan = planLineSplit(target, t, newId)
    if (!plan) {
      return { chain: null, transform: null, notice: 'Split: that point is on an existing endpoint - nothing to split' }
    }
    const built = buildSplitTransform(doc, target, plan, newId)
    return { chain: null, transform: built.transform, notice: splitNotice(doc, target.id, built.repairs) }
  }
  if (target.kind === 'arc') {
    const offset = paramOf(target, world)
    const plan = planArcSplit(target, offset, newId)
    if (!plan) {
      return { chain: null, transform: null, notice: 'Split: that point is on an existing endpoint - nothing to split' }
    }
    const built = buildSplitTransform(doc, target, plan, newId)
    return { chain: null, transform: built.transform, notice: splitNotice(doc, target.id, built.repairs) }
  }
  if (target.kind === 'elliptical-arc') {
    const offset = paramOf(target, world)
    const plan = planEllipticalArcSplit(target, offset, newId)
    if (!plan) {
      return { chain: null, transform: null, notice: 'Split: that point is on an existing endpoint - nothing to split' }
    }
    const built = buildSplitTransform(doc, target, plan, newId)
    return { chain: null, transform: built.transform, notice: splitNotice(doc, target.id, built.repairs) }
  }
  if (target.kind === 'spline' && !target.closed) {
    const plan = planOpenSplineSplit(target, world, newId)
    if (!plan) {
      return { chain: null, transform: null, notice: 'Split: that point is on an existing endpoint - nothing to split' }
    }
    const built = buildSplitTransform(doc, target, plan, newId)
    return { chain: null, transform: built.transform, notice: splitNotice(doc, target.id, built.repairs) }
  }
  return { chain: null, transform: null, notice: `Split: a ${target.kind} cannot be split yet` }
}

/** Human-readable kind name for the two-point staging notice. */
function stagingKindLabel(kind: 'circle' | 'ellipse' | 'spline'): string {
  return kind === 'spline' ? 'closed spline' : kind
}

/**
 * CLICK(p) for the armed split tool:
 *   - no chain: pick the curve under the cursor (pickSplitCurve — everything
 *     trim can pick, plus splines). Line/arc/elliptical-arc/open-spline
 *     split immediately at the clicked point. A circle, full ellipse or
 *     closed spline needs a second point — the click stages it (Esc
 *     abandons the staged point). Every other kind (or an empty click) is a
 *     quiet no-op.
 *   - chain (two-point kind staged): the click supplies the second cut
 *     point and commits the split; a second point on top of the first is a
 *     no-op that keeps the stage (Esc to restart).
 */
export function splitClick(
  chain: SplitChainState | null,
  doc: SketchDoc,
  world: Vec2,
  tol: number,
  newId: () => string = () => crypto.randomUUID(),
): SplitClickOutcome {
  if (!chain) {
    const target = pickSplitCurve(doc.entities, world, tol)
    if (!target) return NO_OP
    if (target.kind === 'circle' || target.kind === 'ellipse' || (target.kind === 'spline' && target.closed)) {
      return {
        chain: { kind: 'split', targetId: target.id, first: world },
        transform: null,
        notice: `Split: click a second point on the ${stagingKindLabel(target.kind)} to complete the split`,
      }
    }
    return splitAtClick(doc, target, world, newId)
  }

  const target = doc.entities.find((e) => e.id === chain.targetId)
  if (!target || (target.kind !== 'circle' && target.kind !== 'ellipse' && target.kind !== 'spline')) {
    return { chain: null, transform: null, notice: 'Split: the picked entity is gone' }
  }
  const plan =
    target.kind === 'circle' ? planCircleSplit(target, paramOf(target, chain.first), paramOf(target, world), newId) :
    target.kind === 'ellipse' ? planEllipseSplit(target, paramOf(target, chain.first), paramOf(target, world), newId) :
    planClosedSplineSplit(target, chain.first, world, newId)
  if (!plan) {
    return {
      chain, transform: null,
      notice: 'Split: the second point matches the first - pick a different point (Esc to restart)',
    }
  }
  const built = buildSplitTransform(doc, target, plan, newId)
  return { chain: null, transform: built.transform, notice: splitNotice(doc, target.id, built.repairs) }
}
