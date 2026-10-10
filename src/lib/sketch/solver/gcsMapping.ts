// Sketch document <-> planegcs mapping (PLAN.md 3.3, ADR-0016).
//
// This layer is PURE: no worker, no WASM loading, no store. It builds the
// planegcs primitive list from a Sketch, and rebuilds entity geometry from
// a solved GcsWrapper. Tests exercise it against a direct GcsWrapper in
// node; sketchSolverWorker.ts is a thin transport around it. Keeping the
// planegcs vocabulary contained here means a solver-package change can
// never leak into the persisted Sketch format or the store.
//
// FAIL LOUD (ADR 0003): every reference is validated before anything is
// pushed — an unknown entity id, a wrong-kind target (parallel on a
// circle), or a malformed constraint throws SketchMappingError, which the
// caller surfaces as a typed 'invalid_sketch' failure. Nothing is skipped
// or guessed.

import { Algorithm, SolveStatus as GcsSolveStatus } from '@salusoft89/planegcs'
import type { GcsWrapper, SketchPrimitive } from '@salusoft89/planegcs'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension,
  PointRef, PointSite, Vec2, SolveStatus,
} from '../types'
import { constraintRefIds, dimensionRefIds } from '../refIds'
import { ellipseFocusSite, ellipsePointAt, ellipseRadiiForFocalDistance } from '../ellipse'
import {
  controlSplineCurvatureAt, controlSplineEndCurvatureScale, splineControlSiteIndex, splineDragEdit, splineHasControlSites,
} from '../spline'
import type { EllipseShape } from '../ellipse'
import { lineAngle, measureDimension, resolvePoint, reversedAngleValueSignValid } from '../tools/dimTool'
import { reconcileCurveFillets } from '../tools/filletTool'
import { applyOffsetLinks } from '../tools/offsetTool'
import { resolveChamferCorner } from '../tools/theoreticalCorner'

export class SketchMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SketchMappingError'
  }
}

// ---- GCS id scheme -----------------------------------------------------
//
// Every gcs primitive id is derived from the OWNING document id with a ':'
// suffix (entity/constraint ids are UUIDs, which never contain ':'), so a
// gcs id always translates back to exactly one user-visible document
// object — that is what makes conflict reporting by id possible.
//
//   point entity  e  -> gcs point  e
//   line entity   e  -> gcs points e:start,e:end + gcs line e
//                       + e:center/e:centerRule only when center is referenced
//   circle entity e  -> gcs point  e:center                + gcs circle e
//   arc entity    e  -> gcs points e:center, e:start, e:end + gcs arc e
//                       + internal constraint e:rules (planegcs requires
//                         arc_rules to tie endpoints to center/radius/angles)
//   fix constraint on a circle/arc radius -> internal constraint f:radius

/** Owning document id for any gcs id (strip the ':site' suffix). */
function ownerId(gcsId: string): string {
  const i = gcsId.indexOf(':')
  return i === -1 ? gcsId : gcsId.slice(0, i)
}

function entityIndex(sketch: Sketch): Map<string, SketchEntity> {
  const map = new Map<string, SketchEntity>()
  for (const e of sketch.entities) {
    if (map.has(e.id)) throw new SketchMappingError(`duplicate entity id '${e.id}'`)
    map.set(e.id, e)
  }
  continuityInfo.set(map, readContinuity(sketch, map))
  return map
}

// ---- Continuity (WO-1866) -------------------------------------------------
//
// A continuity constraint names an OPEN control-point spline's end. That
// spline goes LOCAL: its end control points become real solver points and the
// pull writes each solved control point back on its own, instead of the
// solver-inert rigid translation from the anchor. The joint end control point
// IS the spline's 'start'/'end' solver point (one point, not two tied
// together), so gcsPointId aliases cp0 / cp[n-1] of a local spline onto them.
// The facts ride on the entity index (the one object every mapping step is
// handed) so no signature changes.

interface ContinuityInfo {
  /** Spline ids a continuity constraint names (local mode). */
  localSplines: Set<string>
  /** Control-point indices each continuity needs as solver points. */
  controls: Map<string, Set<number>>
  /** Joint site pairs a continuity already holds coincident. */
  jointPairs: Set<string>
}

const continuityInfo = new WeakMap<Map<string, SketchEntity>, ContinuityInfo>()

function isContinuity(c: SketchConstraint): c is Extract<SketchConstraint, { kind: 'continuity_g1' | 'continuity_g2' }> {
  return c.kind === 'continuity_g1' || c.kind === 'continuity_g2'
}

function isOpenControlSpline(e: SketchEntity | undefined): e is Extract<SketchEntity, { kind: 'spline' }> {
  return e?.kind === 'spline' && e.form === 'control' && !e.closed && e.points.length >= 2
}

function jointPairKey(a: PointRef, b: PointRef): string {
  const ka = `${a.entityId}.${a.site}`, kb = `${b.entityId}.${b.site}`
  return ka < kb ? `${ka}~${kb}` : `${kb}~${ka}`
}

/** Control-point indices from a spline end: k = 0 is the joint, 1 fixes the
 *  tangent, 2 the curvature. */
function endControlIndex(n: number, site: string, k: number): number {
  return site === 'end' ? n - 1 - k : k
}

function readContinuity(sketch: Sketch, index: Map<string, SketchEntity>): ContinuityInfo {
  const info: ContinuityInfo = { localSplines: new Set(), controls: new Map(), jointPairs: new Set() }
  for (const c of sketch.constraints) {
    if (!isContinuity(c)) continue
    info.jointPairs.add(jointPairKey(c.a, c.b))
    for (const ref of [c.a, c.b]) {
      const e = index.get(ref.entityId)
      if (!isOpenControlSpline(e) || (ref.site !== 'start' && ref.site !== 'end')) continue
      info.localSplines.add(e.id)
      const n = e.points.length
      // P1 and P2 for G1 and G2 alike, so the sketch's freedom count moves
      // by exactly one between the two levels (G1 leaves P2 free).
      const depth = Math.min(n - 1, 2)
      let s = info.controls.get(e.id)
      if (!s) { s = new Set(); info.controls.set(e.id, s) }
      for (let k = 1; k <= depth; k++) s.add(endControlIndex(n, ref.site, k))
    }
  }
  return info
}

/** Solver point id of control point i of a spline: the 'start'/'end' point for
 *  the two ends of a LOCAL spline, the on-demand `cp<i>` point otherwise. */
function splineControlGcsId(index: Map<string, SketchEntity>, e: Extract<SketchEntity, { kind: 'spline' }>, i: number): string {
  if (continuityInfo.get(index)?.localSplines.has(e.id)) {
    if (i === 0) return `${e.id}:start`
    if (i === e.points.length - 1) return `${e.id}:end`
  }
  return `${e.id}:cp${i}`
}

function getEntity(index: Map<string, SketchEntity>, id: string, where: string): SketchEntity {
  const e = index.get(id)
  if (!e) throw new SketchMappingError(`${where}: unknown entity id '${id}'`)
  return e
}

function expectKind<K extends SketchEntity['kind']>(
  index: Map<string, SketchEntity>, id: string, kinds: K[], where: string,
): Extract<SketchEntity, { kind: K }> {
  const e = getEntity(index, id, where)
  if (!(kinds as string[]).includes(e.kind)) {
    throw new SketchMappingError(`${where}: entity '${id}' is a ${e.kind}, expected ${kinds.join('|')}`)
  }
  return e as Extract<SketchEntity, { kind: K }>
}

/** Resolve a PointRef to its gcs point id, validating the site exists on
 *  that entity kind. */
export function gcsPointId(index: Map<string, SketchEntity>, ref: PointRef, where: string): string {
  const e = getEntity(index, ref.entityId, where)
  // WO-1861: a control-point spline's control points (and, WO-1862, a bezier
  // chain's anchors and handles) are solver sites only while a drag names one
  // (materialized by referencedSplineControlSites).
  const cp = splineControlSiteIndex(ref.site)
  if (cp !== null) {
    if (e.kind !== 'spline' || !splineHasControlSites(e.form) || cp >= e.points.length) {
      throw new SketchMappingError(`${where}: site '${ref.site}' does not exist on ${e.kind} '${e.id}'`)
    }
    return splineControlGcsId(index, e, cp)
  }
  const valid: Record<SketchEntity['kind'], string[]> = {
    point:  ['self'],
    line:   ['start', 'end', 'center'],
    circle: ['center'],
    arc:    ['center', 'start', 'end'],
    // Shape is solver-inert (no rim/endpoint sites); center is a real
    // solver point and the two FOCI are materialized as center-tied points
    // (sketchToGcsPrimitives) whenever something references them.
    ellipse:           ['center', 'focus1', 'focus2'],
    'elliptical-arc':  ['center', 'focus1', 'focus2', 'start', 'end'],
    // Native spline endpoints are addressable; interior through-points remain carried.
    spline:            ['start', 'end'],
    // Solver-inert: only the baseline-left text anchor is addressable.
    text:              ['start'],
    // Solver-inert block: only the origin anchor is addressable (SKC-BLOCKS).
    block:             ['origin'],
  }
  if (!valid[e.kind].includes(ref.site)) {
    throw new SketchMappingError(`${where}: site '${ref.site}' does not exist on ${e.kind} '${e.id}'`)
  }
  return ref.site === 'self' ? e.id : `${e.id}:${ref.site}`
}

// ---- Sketch -> gcs primitives ------------------------------------------

interface GcsPointSeed { id: string; at: Vec2 }

/** All gcs points an entity owns, with their current document coordinates.
 *  Arc endpoints are DERIVED from center/radius/angles here — the document
 *  stores one canonical representation, the redundancy planegcs needs
 *  (endpoints + angles) is reconstructed at mapping time. */
function entityPoints(e: SketchEntity, includeDerivedLineCenter = false): GcsPointSeed[] {
  switch (e.kind) {
    case 'point':  return [{ id: e.id, at: e.at }]
    case 'line': {
      const points: GcsPointSeed[] = [
        { id: `${e.id}:start`, at: e.start },
        { id: `${e.id}:end`,   at: e.end },
      ]
      if (includeDerivedLineCenter) {
        points.push({ id: `${e.id}:center`, at: {
          x: (e.start.x + e.end.x) / 2,
          y: (e.start.y + e.end.y) / 2,
        } })
      }
      return points
    }
    case 'circle': return [{ id: `${e.id}:center`, at: e.center }]
    // Ellipse / elliptical-arc are SOLVER-INERT (types.ts fork): only the
    // center is a real solver point; the shape params never enter the solve.
    case 'ellipse':          return [{ id: `${e.id}:center`, at: e.center }]
    case 'elliptical-arc':   return [
      { id: `${e.id}:center`, at: e.center },
      { id: `${e.id}:start`, at: ellipsePointAt(e, e.startParam) },
      { id: `${e.id}:end`, at: ellipsePointAt(e, e.endParam) },
    ]
    // Solver-inert spline: only the first through-point (anchor) is a real
    // solver point; the rest of the points never enter the solve.
    case 'spline':           return [
      { id: `${e.id}:start`, at: e.points[0] },
      { id: `${e.id}:end`, at: e.points[e.points.length - 1] },
    ]
    // Solver-inert text: only the baseline-left anchor is a real solver
    // point; the glyph geometry never enters the solve.
    case 'text':             return [{ id: `${e.id}:start`, at: e.at }]
    // Solver-inert block (SKC-BLOCKS): ONLY the origin anchor is a real solver
    // point; the members never enter the solve, so the block contributes exactly
    // 2 DoF regardless of member count. entitiesFromSolved carries the members
    // verbatim and re-places them from the (possibly moved) origin.
    case 'block':            return [{ id: `${e.id}:origin`, at: e.origin }]
    case 'arc':    return [
      { id: `${e.id}:center`, at: e.center },
      { id: `${e.id}:start`,  at: {
        x: e.center.x + e.radius * Math.cos(e.startAngle),
        y: e.center.y + e.radius * Math.sin(e.startAngle) } },
      { id: `${e.id}:end`,    at: {
        x: e.center.x + e.radius * Math.cos(e.endAngle),
        y: e.center.y + e.radius * Math.sin(e.endAngle) } },
    ]
  }
}

/** Gcs point ids grounded by a 'fix' constraint. Grounding marks the
 *  params fixed at PUSH time (removes them from the solve) rather than
 *  adding equations — that is what makes fix reduce DoF cleanly instead
 *  of risking redundancy with other constraints. */
function collectFixedPointIds(sketch: Sketch, index: Map<string, SketchEntity>): Set<string> {
  const fixed = new Set<string>()
  for (const c of sketch.constraints) {
    if (c.kind !== 'fix') continue
    const where = `fix '${c.id}'`
    if ((c.point ? 1 : 0) + (c.entityId ? 1 : 0) !== 1) {
      throw new SketchMappingError(`${where}: exactly one of point/entityId must be set`)
    }
    if (c.point) {
      fixed.add(gcsPointId(index, c.point, where))
    } else {
      // Whole-entity fix grounds every point the entity owns. For an arc
      // that grounds center+start+end, which determines radius and both
      // angles through e:rules. A circle's radius is pinned separately
      // below (it is a bare param, not a point).
      const e = getEntity(index, c.entityId!, where)
      for (const p of entityPoints(e)) {
        // A line center is derived from its endpoints. Grounding the two
        // canonical endpoint params already grounds it through centerRule;
        // fixing the derived point as well would only add redundant state.
        if (e.kind !== 'line' || p.id !== `${e.id}:center`) fixed.add(p.id)
      }
    }
  }
  return fixed
}

function mapConstraint(
  c: SketchConstraint, index: Map<string, SketchEntity>, fixedPoints: Set<string>,
): SketchPrimitive[] {
  const where = `${c.kind} '${c.id}'`
  switch (c.kind) {
    case 'coincident': {
      const p1 = gcsPointId(index, c.a, where), p2 = gcsPointId(index, c.b, where)
      // WO-1866: a continuity on the same two sites already holds them
      // together; pushing this too would only flag the joint redundant.
      if (continuityInfo.get(index)?.jointPairs.has(jointPairKey(c.a, c.b))) return []
      return [{ id: c.id, type: 'p2p_coincident', p1_id: p1, p2_id: p2 }]
    }

    case 'continuity_g1':
    case 'continuity_g2':
      return mapContinuity(c, index, where)

    case 'concentric': {
      // Concentric = the two centers coincide; planegcs has no dedicated
      // concentric constraint, so use p2p_coincident between the centers.
      const a = expectKind(index, c.a, ['circle', 'arc'], where)
      const b = expectKind(index, c.b, ['circle', 'arc'], where)
      return [{ id: c.id, type: 'p2p_coincident',
        p1_id: gcsPointId(index, { entityId: a.id, site: 'center' }, where),
        p2_id: gcsPointId(index, { entityId: b.id, site: 'center' }, where) }]
    }

    case 'parallel': {
      // Line operands, or a BLOCK's orientation line (SKC-ROTATION-SOLVABLE):
      // a parallel constraint on a block's orientation drives its rotation.
      const l1 = lineOperandId(index, c.a, where)
      const l2 = lineOperandId(index, c.b, where)
      return [{ id: c.id, type: 'parallel', l1_id: l1, l2_id: l2 }]
    }

    case 'perpendicular': {
      const l1 = lineOperandId(index, c.a, where)
      const l2 = lineOperandId(index, c.b, where)
      return [{ id: c.id, type: 'perpendicular_ll', l1_id: l1, l2_id: l2 }]
    }

    case 'collinear': {
      // planegcs exposes NO collinear primitive (verified against the
      // 1.1.7 constraint list). Express it as the documented composition
      // (ADR-0003, explicit — not a silent fallback): parallel locks the
      // direction, point-on-line drops one line's endpoint onto the
      // other's INFINITE line, which pins the perpendicular offset to
      // zero. Together = same infinite line. Both primitives derive their
      // id from c.id (':parallel' / ':onLine' suffixes) so conflict
      // diagnosis reports the single document constraint (ownerId strips
      // the suffix). DoF drops by 2.
      const a = expectKind(index, c.a, ['line'], where)
      const b = expectKind(index, c.b, ['line'], where)
      // WO-1469: collinear is symmetric in a/b (same infinite line either
      // way), but privileging operand `a`'s point unconditionally makes the
      // solved primitive depend on click order — pinning a fully-fixed
      // (immovable) entity's point onto the other line is worse-conditioned
      // for DogLeg than pinning the free entity's own point, even though
      // both are the same feasible geometry. Prefer pinning whichever
      // line's point is NOT fully fixed; when neither or both are fully
      // fixed, keep the original a-on-b default (deterministic, unchanged
      // behavior for the equally-conditioned cases).
      const isFullyFixed = (l: typeof a): boolean =>
        fixedPoints.has(`${l.id}:start`) && fixedPoints.has(`${l.id}:end`)
      const preferB = isFullyFixed(a) && !isFullyFixed(b)
      const onto = preferB ? b : a
      const onLine = preferB ? a : b
      return [
        { id: `${c.id}:parallel`, type: 'parallel', l1_id: a.id, l2_id: b.id },
        { id: `${c.id}:onLine`, type: 'point_on_line_pl',
          p_id: `${onto.id}:start`, l_id: onLine.id },
      ]
    }

    case 'horizontal':
    case 'vertical': {
      if ((c.line ? 1 : 0) + (c.points ? 1 : 0) !== 1) {
        throw new SketchMappingError(`${where}: exactly one of line/points must be set`)
      }
      if (c.line) {
        // A line, or a BLOCK's orientation line (SKC-ROTATION-SOLVABLE): a
        // horizontal/vertical constraint on a block orientation pins its rotation.
        const l = lineOperandId(index, c.line, where)
        return [{ id: c.id, type: c.kind === 'horizontal' ? 'horizontal_l' : 'vertical_l', l_id: l }]
      }
      return [{ id: c.id, type: c.kind === 'horizontal' ? 'horizontal_pp' : 'vertical_pp',
        p1_id: gcsPointId(index, c.points![0], where),
        p2_id: gcsPointId(index, c.points![1], where) }]
    }

    case 'tangent': {
      // planegcs has one tangent constraint per kind pair; dispatch on the
      // two entity kinds (order-normalized) so the document constraint
      // stays a single 'tangent'.
      const a = expectKind(index, c.a, ['line', 'circle', 'arc', 'ellipse', 'elliptical-arc', 'spline'], where)
      const b = expectKind(index, c.b, ['line', 'circle', 'arc', 'ellipse', 'elliptical-arc', 'spline'], where)
      if (a.kind === 'ellipse' || a.kind === 'elliptical-arc' || a.kind === 'spline' ||
          b.kind === 'ellipse' || b.kind === 'elliptical-arc' || b.kind === 'spline') {
        // PlaneGCS has no native primitive for these curves. The durable
        // curveFillet descriptor is reconciled geometrically after each solve.
        return []
      }
      const pair = `${a.kind}/${b.kind}`
      switch (pair) {
        case 'line/circle':   return [{ id: c.id, type: 'tangent_lc', l_id: a.id, c_id: b.id }]
        case 'circle/line':   return [{ id: c.id, type: 'tangent_lc', l_id: b.id, c_id: a.id }]
        case 'line/arc':      return [{ id: c.id, type: 'tangent_la', l_id: a.id, a_id: b.id }]
        case 'arc/line':      return [{ id: c.id, type: 'tangent_la', l_id: b.id, a_id: a.id }]
        case 'circle/circle': return [{ id: c.id, type: 'tangent_cc', c1_id: a.id, c2_id: b.id }]
        case 'arc/arc':       return [{ id: c.id, type: 'tangent_aa', a1_id: a.id, a2_id: b.id }]
        case 'circle/arc':    return [{ id: c.id, type: 'tangent_ca', c_id: a.id, a_id: b.id }]
        case 'arc/circle':    return [{ id: c.id, type: 'tangent_ca', c_id: b.id, a_id: a.id }]
        default:
          throw new SketchMappingError(`${where}: line/line tangency is meaningless`)
      }
    }

    case 'equal': {
      // 'equal' means equal LENGTH for lines and equal RADIUS for
      // circles/arcs — mixing a line with a curve has no meaning and is
      // rejected rather than silently picking one interpretation.
      const a = expectKind(index, c.a, ['line', 'circle', 'arc'], where)
      const b = expectKind(index, c.b, ['line', 'circle', 'arc'], where)
      const pair = `${a.kind}/${b.kind}`
      switch (pair) {
        case 'line/line':     return [{ id: c.id, type: 'equal_length', l1_id: a.id, l2_id: b.id }]
        case 'circle/circle': return [{ id: c.id, type: 'equal_radius_cc', c1_id: a.id, c2_id: b.id }]
        case 'arc/arc':       return [{ id: c.id, type: 'equal_radius_aa', a1_id: a.id, a2_id: b.id }]
        case 'circle/arc':    return [{ id: c.id, type: 'equal_radius_ca', c1_id: a.id, a2_id: b.id }]
        case 'arc/circle':    return [{ id: c.id, type: 'equal_radius_ca', c1_id: b.id, a2_id: a.id }]
        default:
          throw new SketchMappingError(`${where}: cannot equate a ${a.kind} with a ${b.kind}`)
      }
    }

    case 'midpoint': {
      // Point at the midpoint of a line = the line's endpoints are
      // symmetric about the point (the solver midpoint formulation).
      const l = expectKind(index, c.line, ['line'], where)
      return [{ id: c.id, type: 'p2p_symmetric_ppp',
        p1_id: `${l.id}:start`, p2_id: `${l.id}:end`,
        p_id: gcsPointId(index, c.point, where) }]
    }

    case 'symmetric': {
      const axis = expectKind(index, c.axis, ['line'], where)
      return [{ id: c.id, type: 'p2p_symmetric_ppl',
        p1_id: gcsPointId(index, c.a, where),
        p2_id: gcsPointId(index, c.b, where),
        l_id: axis.id }]
    }

    case 'fix': {
      // Point grounding happened via the `fixed` flag at push time
      // (collectFixedPointIds). The only equation a fix ever adds is the
      // radius pin for a whole-circle/arc fix — radius is a bare param
      // with no `fixed` flag exposed through the wrapper.
      if (c.entityId) {
        const e = getEntity(index, c.entityId, where)
        if (e.kind === 'circle') {
          return [{ id: `${c.id}:radius`, type: 'circle_radius', c_id: e.id, radius: e.radius }]
        }
      }
      return []
    }

    case 'point_on_object': {
      const obj = expectKind(index, c.object, ['line', 'circle', 'arc', 'ellipse', 'elliptical-arc', 'spline'], where)
      const p = gcsPointId(index, c.point, where)
      switch (obj.kind) {
        case 'line':   return [{ id: c.id, type: 'point_on_line_pl', p_id: p, l_id: obj.id }]
        case 'circle': return [{ id: c.id, type: 'point_on_circle', p_id: p, c_id: obj.id }]
        case 'arc':    return [{ id: c.id, type: 'point_on_arc', p_id: p, a_id: obj.id }]
        case 'ellipse':
        case 'elliptical-arc':
        case 'spline':
          // Specialized curve fillet reconciliation keeps theoretical
          // points on native curves; no sampled PlaneGCS surrogate is pushed.
          return []
      }
    }

    case 'pierce': {
      // WO-1865: the point sits where a model edge crosses the sketch plane. The crossing is
      // resolved OUTSIDE the solver (workbench regen pass, projectLink.relinkPierceConstraints)
      // and stored on the constraint, so here it is an ordinary point placement: two hard
      // coordinate equations (the same primitive the drag/park pins use, at full priority).
      // Two DoF, conflict-diagnosable against a Fix or another placement on the same point.
      const p = gcsPointId(index, c.point, where)
      return [
        { id: `${c.id}:x`, type: 'coordinate_x', p_id: p, x: c.at.x },
        { id: `${c.id}:y`, type: 'coordinate_y', p_id: p, y: c.at.y },
      ]
    }
  }
}

/** WO-1866: continuity at a spline end, composed from existing planegcs
 *  equations (the composition the architect approved in the work order).
 *  Every helper id is `${c.id}:<suffix>`, so a conflict or redundancy anywhere
 *  in the set is reported as this ONE document constraint.
 *
 *  With P0, P1, P2 the spline's control points counted from the joint, the
 *  spline leaves the joint along P0 -> P1 and its end curvature is
 *  c * h / |P1 - P0|^2 (h = signed distance of P2 from the line P0-P1, c from
 *  spline.controlSplineEndCurvatureScale). So:
 *   - G0: P0 coincident with the neighbour's joint end.
 *   - G1: P0 -> P1 points the way the neighbour arrives (directed, so the
 *     joint can never solve into a cusp).
 *   - G2 to a line: P2 on the line P0-P1 (zero curvature, linear, exact).
 *   - G2 to an arc (centre O, radius r): L^2 = c r h with the bend toward O,
 *     held exactly by the right-triangle altitude theorem. A = the mirror of O
 *     in P0 (|P0 A| = r, away from O); B = the foot of P2 on the normal O-P0
 *     (|P0 B| = |h|); B* = the point c of the way from P0 to B (a midpoint
 *     for c = 1/2, a trisection for c = 1/3 or 2/3, all linear); then a right
 *     angle at P1 between A and B* gives |P0 P1|^2 = |P0 A| |P0 B*| = r c h.
 *     A right angle there exists only when P0 lies between A and B*, so the
 *     spline must bend toward the centre: an S-joint is not a solution.
 *     Every helper point is pinned by its own equations (net 0 DOF), so G2
 *     removes exactly one more freedom than G1. */
function mapContinuity(
  c: Extract<SketchConstraint, { kind: 'continuity_g1' | 'continuity_g2' }>,
  index: Map<string, SketchEntity>, where: string,
): SketchPrimitive[] {
  const ea = getEntity(index, c.a.entityId, where)
  const eb = getEntity(index, c.b.entityId, where)
  const [sRef, nRef] = isOpenControlSpline(ea) ? [c.a, c.b] : [c.b, c.a]
  const spline = index.get(sRef.entityId)
  if (!isOpenControlSpline(spline)) {
    throw new SketchMappingError(`${where}: needs an open control-point spline end, got ${ea.kind} and ${eb.kind}`)
  }
  if (sRef.site !== 'start' && sRef.site !== 'end') {
    throw new SketchMappingError(`${where}: site '${sRef.site}' is not an end of spline '${spline.id}'`)
  }
  if (nRef.site !== 'start' && nRef.site !== 'end') {
    throw new SketchMappingError(`${where}: site '${nRef.site}' is not an end of '${nRef.entityId}'`)
  }
  const n = spline.points.length
  const g2 = c.kind === 'continuity_g2'
  const cpIndex = (k: number) => endControlIndex(n, sRef.site, k)
  const P = (k: number) => splineControlGcsId(index, spline, cpIndex(k))
  const at = (k: number) => spline.points[cpIndex(k)]
  const P0 = P(0), P1 = P(1)
  const joint = gcsPointId(index, nRef, where)
  const out: SketchPrimitive[] = [{ id: `${c.id}:g0`, type: 'p2p_coincident', p1_id: P0, p2_id: joint }]
  const nb = getEntity(index, nRef.entityId, where)

  if (nb.kind === 'line') {
    const far = `${nb.id}:${nRef.site === 'start' ? 'end' : 'start'}`
    out.push({ id: `${c.id}:g1`, type: 'l2l_angle_pppp',
      l1p1_id: far, l1p2_id: joint, l2p1_id: P0, l2p2_id: P1, angle: 0 })
    if (g2 && n >= 3) {
      out.push({ id: `${c.id}:g2`, type: 'point_on_line_ppp', p_id: P(2), lp1_id: P0, lp2_id: P1 })
    }
    return out
  }

  if (isOpenControlSpline(nb) && nb.id !== spline.id) {
    const m = nb.points.length
    const qIndex = (k: number) => endControlIndex(m, nRef.site, k)
    const Q = (k: number) => splineControlGcsId(index, nb, qIndex(k))
    const Q1 = Q(1)
    out.push({ id: `${c.id}:g1`, type: 'l2l_angle_pppp',
      l1p1_id: Q1, l1p2_id: joint, l2p1_id: P0, l2p2_id: P1, angle: 0 })
    if (!g2) return out
    // WO-1943: a two-point spline is straight, so its side's curvature is
    // zero and G2 is the G2-to-a-line equation on the other side.
    if (n < 3 && m < 3) return out
    if (n < 3 || m < 3) {
      out.push({ id: `${c.id}:g2`, type: 'point_on_line_ppp', p_id: n < 3 ? Q(2) : P(2), lp1_id: P0, lp2_id: P1 })
      return out
    }
    out.push(...splineSplineG2(c.id,
      { P0, P1, P2: P(2), p0: at(0), p1: at(1), p2: at(2), scale: controlSplineEndCurvatureScale(n) },
      { P1: Q1, P2: Q(2), p1: nb.points[qIndex(1)], p2: nb.points[qIndex(2)], scale: controlSplineEndCurvatureScale(m) },
      where))
    return out
  }

  if (nb.kind !== 'arc') {
    throw new SketchMappingError(`${where}: continuity joins a spline to a line, an arc or another control spline, not a ${nb.kind}`)
  }
  // The arc runs counter-clockwise start -> end. Its tangent at the joint
  // continues into the spline at its END and turns back at its START.
  out.push({ id: `${c.id}:leg`, type: 'line', p1_id: P0, p2_id: P1 })
  out.push({ id: `${c.id}:g1`, type: 'angle_via_point',
    crv1_id: nb.id, crv2_id: `${c.id}:leg`, p_id: P0, angle: nRef.site === 'end' ? 0 : Math.PI })
  if (!g2) return out
  if (n < 3) {
    throw new SketchMappingError(`${where}: a two-point control spline is straight and cannot match an arc's curvature`)
  }
  const scale = controlSplineEndCurvatureScale(n)
  const O = `${nb.id}:center`
  const o = nb.center, p0 = at(0), p2 = at(2)
  const nx = p0.x - o.x, ny = p0.y - o.y
  const nl2 = nx * nx + ny * ny || 1
  const t = ((p2.x - p0.x) * nx + (p2.y - p0.y) * ny) / nl2
  const b = { x: p0.x + t * nx, y: p0.y + t * ny }
  const along = (f: number) => ({ x: p0.x + f * (b.x - p0.x), y: p0.y + f * (b.y - p0.y) })
  const pt = (id: string, q: Vec2): SketchPrimitive => ({ id, type: 'point', x: q.x, y: q.y, fixed: false })
  const A = `${c.id}:A`, B = `${c.id}:B`
  out.push(
    pt(A, { x: 2 * p0.x - o.x, y: 2 * p0.y - o.y }),
    { id: `${c.id}:Arule`, type: 'p2p_symmetric_ppp', p1_id: O, p2_id: A, p_id: P0 },
    pt(B, b),
    { id: `${c.id}:Bon`, type: 'point_on_line_ppp', p_id: B, lp1_id: O, lp2_id: P0 },
    { id: `${c.id}:Bfoot`, type: 'perpendicular_pppp', l1p1_id: B, l1p2_id: P(2), l2p1_id: O, l2p2_id: P0 },
  )
  let Bs: string
  if (Math.abs(scale - 1 / 2) < 1e-9) {
    Bs = `${c.id}:M`
    out.push(pt(Bs, along(1 / 2)),
      { id: `${c.id}:Mrule`, type: 'p2p_symmetric_ppp', p1_id: P0, p2_id: B, p_id: Bs })
  } else if (Math.abs(scale - 1 / 3) < 1e-9 || Math.abs(scale - 2 / 3) < 1e-9) {
    const T1 = `${c.id}:T1`, T2 = `${c.id}:T2`
    out.push(pt(T1, along(1 / 3)), pt(T2, along(2 / 3)),
      { id: `${c.id}:T1rule`, type: 'p2p_symmetric_ppp', p1_id: P0, p2_id: T2, p_id: T1 },
      { id: `${c.id}:T2rule`, type: 'p2p_symmetric_ppp', p1_id: T1, p2_id: B, p_id: T2 })
    Bs = scale < 1 / 2 ? T1 : T2
  } else {
    throw new SketchMappingError(`${where}: no curvature construction for end scale ${scale}`)
  }
  out.push({ id: `${c.id}:g2`, type: 'perpendicular_pppp', l1p1_id: P1, l1p2_id: A, l2p1_id: P1, l2p2_id: Bs })
  return out
}

/** WO-1943: G2 where two control splines meet, on top of the G0 + G1 set.
 *
 *  Spline A leaves the shared joint P0 along P0 -> P1 (|P0 P1| = La), spline
 *  B along P0 -> Q1 the other way (|P0 Q1| = Lb). With ha, hb the offsets of
 *  P2, Q2 along the common normal, each end's curvature vector is c h / L^2
 *  along that normal (WO-1866's measured end relation), so G2 is
 *  cA ha / La^2 = cB hb / Lb^2 -- no radius anywhere, so a straight joint
 *  (ha = hb = 0) is an ordinary point of the equations, not a limit.
 *
 *  Held with two similar-triangle transfers, every step exact:
 *   - V = P0 + (P1 - P0) turned 90 deg: the normal through P0. Linear, via a
 *     helper point S carrying (P1 - P0) in four signed 'difference' equations.
 *   - Fa, Fb = the feet of P2, Q2 on the normal (offsets ha, hb).
 *   - P1*, Q1* = the control legs stretched by 1/c (x2, x3/2 or x3) with
 *     p2p_symmetric_ppp. Only the legs are scaled, never the offsets: planegcs
 *     holds a symmetric point as "on the line through the pair", which has no
 *     line when the pair coincides -- and at a straight joint Fa IS P0.
 *   - I on the normal with I -> Q1 parallel to P1* -> Fa.
 *   - G2: I -> P1 parallel to Q1* -> Fb; together the two parallels hold
 *     exactly cA ha Lb^2 = cB hb La^2. Both are directed angles of 0, and with
 *     La, Lb > 0 no line or symmetric pair in the set ever has zero length.
 *  Helper points are pinned by their own equations (net 0 DOF): G2 removes
 *  exactly one freedom more than G1, and bends both ends to the same side. */
function splineSplineG2(
  id: string,
  a: { P0: string; P1: string; P2: string; p0: Vec2; p1: Vec2; p2: Vec2; scale: number },
  b: { P1: string; P2: string; p1: Vec2; p2: Vec2; scale: number },
  where: string,
): SketchPrimitive[] {
  const out: SketchPrimitive[] = []
  const { P0, p0 } = a
  const pt = (pid: string, q: Vec2): SketchPrimitive => ({ id: pid, type: 'point', x: q.x, y: q.y, fixed: false })
  const param = (o_id: string, prop: 'x' | 'y') => ({ o_id, prop })
  const d = { x: a.p1.x - p0.x, y: a.p1.y - p0.y }
  const v = { x: p0.x - d.y, y: p0.y + d.x }
  const S = `${id}:S`, V = `${id}:V`
  out.push(
    pt(S, d), pt(V, v),
    { id: `${id}:Sx`, type: 'difference', param1: param(P0, 'x'), param2: param(a.P1, 'x'), difference: param(S, 'x') },
    { id: `${id}:Sy`, type: 'difference', param1: param(P0, 'y'), param2: param(a.P1, 'y'), difference: param(S, 'y') },
    { id: `${id}:Vy`, type: 'difference', param1: param(P0, 'y'), param2: param(V, 'y'), difference: param(S, 'x') },
    { id: `${id}:Vx`, type: 'difference', param1: param(V, 'x'), param2: param(P0, 'x'), difference: param(S, 'y') },
  )
  const nl2 = d.x * d.x + d.y * d.y || 1
  /** Foot of `P2` on the normal P0-V. */
  const foot = (tag: string, P2: string, p2: Vec2): { id: string; at: Vec2 } => {
    const t = ((p2.x - p0.x) * (v.x - p0.x) + (p2.y - p0.y) * (v.y - p0.y)) / nl2
    const at = { x: p0.x + t * (v.x - p0.x), y: p0.y + t * (v.y - p0.y) }
    const F = `${id}:${tag}F`
    out.push(pt(F, at),
      { id: `${id}:${tag}Fon`, type: 'point_on_line_ppp', p_id: F, lp1_id: P0, lp2_id: V },
      { id: `${id}:${tag}Ffoot`, type: 'perpendicular_pppp', l1p1_id: F, l1p2_id: P2, l2p1_id: P0, l2p2_id: V })
    return { id: F, at }
  }
  /** P0 + (P1 - P0) / scale: the control leg stretched by 1/c. */
  const stretched = (tag: string, P1: string, p1: Vec2, scale: number): { id: string; at: Vec2 } => {
    const at = (f: number) => ({ x: p0.x + f * (p1.x - p0.x), y: p0.y + f * (p1.y - p0.y) })
    const sym = (rule: string, p1_id: string, p2_id: string, mid: string): SketchPrimitive =>
      ({ id: `${id}:${tag}${rule}`, type: 'p2p_symmetric_ppp', p1_id, p2_id, p_id: mid })
    if (Math.abs(scale - 1 / 2) < 1e-9) {           // x2: P1 is the midpoint of P0 and P1*
      const X = `${id}:${tag}X2`
      out.push(pt(X, at(2)), sym('X2rule', P0, X, P1))
      return { id: X, at: at(2) }
    }
    if (Math.abs(scale - 2 / 3) < 1e-9) {           // x3/2: P1 is the midpoint of M and P1*
      const M = `${id}:${tag}M`, X = `${id}:${tag}X32`
      out.push(pt(M, at(1 / 2)), sym('Mrule', P0, P1, M), pt(X, at(3 / 2)), sym('X32rule', M, X, P1))
      return { id: X, at: at(3 / 2) }
    }
    if (Math.abs(scale - 1 / 3) < 1e-9) {           // x3: P0, P1, T2, P1* evenly spaced
      const T2 = `${id}:${tag}X2`, X = `${id}:${tag}X3`
      out.push(pt(T2, at(2)), sym('X2rule', P0, T2, P1), pt(X, at(3)), sym('X3rule', P1, X, T2))
      return { id: X, at: at(3) }
    }
    throw new SketchMappingError(`${where}: no curvature construction for end scale ${scale}`)
  }
  const Fa = foot('a', a.P2, a.p2), Fb = foot('b', b.P2, b.p2)
  const Pa = stretched('a', a.P1, a.p1, a.scale), Qb = stretched('b', b.P1, b.p1, b.scale)
  // Seed I where the first parallel puts it: I = P0 - (Lb / |P0 P1*|) (Fa - P0).
  const Lb = Math.hypot(b.p1.x - p0.x, b.p1.y - p0.y)
  const La1 = Math.hypot(Pa.at.x - p0.x, Pa.at.y - p0.y) || 1
  const I = `${id}:I`
  out.push(
    pt(I, { x: p0.x - (Lb / La1) * (Fa.at.x - p0.x), y: p0.y - (Lb / La1) * (Fa.at.y - p0.y) }),
    { id: `${id}:Ion`, type: 'point_on_line_ppp', p_id: I, lp1_id: P0, lp2_id: V },
    { id: `${id}:Irule`, type: 'l2l_angle_pppp', l1p1_id: I, l1p2_id: b.P1, l2p1_id: Pa.id, l2p2_id: Fa.id, angle: 0 },
    { id: `${id}:g2`, type: 'l2l_angle_pppp', l1p1_id: I, l1p2_id: a.P1, l2p1_id: Qb.id, l2p2_id: Fb.id, angle: 0 },
  )
  return out
}

// WO-1858 (BK-140): mapDimension returns a LIST, not one primitive. Every
// kind but 'd1xd2' still yields exactly one (or, for the inert ellipse forks,
// none), so the shared resolver's behaviour for them is unchanged -- but a
// DRIVING chamfer setback pair is two independent p2p_distance equations
// against one theoretical-corner phantom, and no single primitive can carry
// both. `entities`/`constraints` are the whole document, needed only by
// 'd1xd2' (its corner lookup walks the coincident/point_on_object graph);
// every other kind reads only `index`.
function mapDimension(
  d: SketchDimension, index: Map<string, SketchEntity>,
  entities: readonly SketchEntity[], constraints: readonly SketchConstraint[],
): SketchPrimitive[] {
  const where = `${d.kind} dim '${d.id}'`
  switch (d.kind) {
    case 'distance':
      return [{ id: d.id, type: 'p2p_distance', driving: d.driving,
        p1_id: gcsPointId(index, d.a, where), p2_id: gcsPointId(index, d.b, where),
        distance: d.value }]

    // distanceX/Y map to the signed 'difference' constraint
    // (b - a = value). The smart-dimension UI normalizes reference order
    // so the stored value is positive; the mapping does not take abs() —
    // a signed document value must stay signed through the solve.
    case 'distanceX':
      return [{ id: d.id, type: 'difference', driving: d.driving,
        param1: { o_id: gcsPointId(index, d.a, where), prop: 'x' },
        param2: { o_id: gcsPointId(index, d.b, where), prop: 'x' },
        difference: d.value }]

    case 'distanceY':
      return [{ id: d.id, type: 'difference', driving: d.driving,
        param1: { o_id: gcsPointId(index, d.a, where), prop: 'y' },
        param2: { o_id: gcsPointId(index, d.b, where), prop: 'y' },
        difference: d.value }]

    // ORDINATE (WO-1867): the SAME signed 'difference' equation distanceX/Y
    // push, but always ORIGIN -> POINT along the named world axis. Driving it
    // removes one degree of freedom, so the whole stack is worth one per
    // ordinate; and because every ordinate of a stack names the same datum
    // point, MOVING that datum carries every driven point with it in ONE solve
    // (the difference each ordinate holds is relative to the datum's parameter,
    // not to a fixed number). Dropping the origin operand here is the WO's
    // negative control: without it there is no datum in the equation and the
    // driven points stop following the datum.
    case 'ordinate':
      return [{ id: d.id, type: 'difference', driving: d.driving,
        param1: { o_id: gcsPointId(index, d.origin, where), prop: d.axis },
        param2: { o_id: gcsPointId(index, d.point, where), prop: d.axis },
        difference: d.value }]

    // Point-to-line distance (smart dim point+line, and line+line when
    // parallel). planegcs measures to the INFINITE line — the document
    // value is the perpendicular distance, never a segment-clamped one.
    case 'distancePL': {
      const l = expectKind(index, d.line, ['line'], where)
      return [{ id: d.id, type: 'p2l_distance', driving: d.driving,
        p_id: gcsPointId(index, d.point, where), l_id: l.id,
        distance: d.value }]
    }

    case 'angle': {
      // Line operands, or a BLOCK's orientation line (SKC-ROTATION-SOLVABLE):
      // an angle dimension whose operand is a block DRIVES that block's rotation
      // through its solver-owned orientation. The near sector (l2l_angle_ll)
      // takes whole line ids and works unchanged with the synthetic orient line.
      const l1 = lineOperandId(index, d.a, where)
      const l2 = lineOperandId(index, d.b, where)
      // SKC-58B far/obtuse sector: operand B's direction is REVERSED so the
      // stored signed `value` (a directed angle for the reversed B, e.g.
      // -145deg for a 35deg line's obtuse pick) is already satisfied by the
      // current geometry -- committing the obtuse sector moves nothing
      // (Operator's no-motion bar). l2l_angle_ll cannot reverse an operand (it
      // takes whole lines, direction fixed at start->end), so the reversed
      // case uses l2l_angle_pppp with B's two endpoint points SWAPPED
      // (l2p1=end, l2p2=start). A's operand is start->end, identical to the
      // l2l_angle_ll direction, so the two forms agree on A. The near sector
      // (reverseB absent/false) keeps the byte-identical l2l_angle_ll path.
      if (d.reverseB) {
        // The far/obtuse sector rebuilds an operand from its :start/:end endpoint
        // points (l2l_angle_pppp below). A block's synthetic orientation line has
        // no :start/:end sites -- only origin/refpoint -- so refuse the reversed
        // sector on a block operand BY NAME (ADR-0003). The near sector below
        // solves a block orientation normally; a block angle is always created in
        // the near sector (dimPlacement forces reverseB false for blocks).
        if (index.get(d.a)?.kind === 'block' || index.get(d.b)?.kind === 'block') {
          throw new SketchMappingError(
            `${where}: the far/obtuse angle sector is not supported on a block orientation; ` +
            `use the near sector (reverseB=false)`)
        }
        const a = expectKind(index, d.a, ['line'], where)
        const b = expectKind(index, d.b, ['line'], where)
        // SKC-59-R4 boundary guard: signedAngleEditValue (dimTool.ts) is the
        // ONLY sanctioned writer of a driving angle dim's typed edits, and it
        // ALWAYS preserves the dimension's existing sign -- so a value whose
        // sign contradicts the reversed-operand convention here means some
        // OTHER writer stored the raw (positive) typed magnitude directly,
        // bypassing it (the exact SKC-59-R1 bug: Operator's -143/reverseB=true
        // dim, typed 120, would land at value=+120 without the helper, and
        // l2l_angle_pppp would solve the MIRROR branch below with no warning
        // at all). Checking here, at the single choke point every reverseB
        // dim must pass through to reach the solver, means no accept path --
        // present or future -- can smuggle a wrongly-signed value past this.
        const theta = lineAngle(a, b)
        if (!reversedAngleValueSignValid(theta, d.value)) {
          throw new SketchMappingError(
            `${where}: reverseB=true angle dimension '${d.id}' value ${d.value} contradicts ` +
            `the reversed-operand sign convention for the current geometry (theta=${theta} ` +
            `between '${a.id}' and '${b.id}') -- a writer bypassed signedAngleEditValue`)
        }
        return [{ id: d.id, type: 'l2l_angle_pppp', driving: d.driving,
          l1p1_id: `${a.id}:start`, l1p2_id: `${a.id}:end`,
          l2p1_id: `${b.id}:end`,   l2p2_id: `${b.id}:start`,
          angle: d.value }]
      }
      return [{ id: d.id, type: 'l2l_angle_ll', driving: d.driving,
        l1_id: l1, l2_id: l2, angle: d.value }]
    }

    // THREE-POINT angle (WO-1868): l2l_angle_pppp from vertex->a to vertex->b.
    // Removing the VERTEX operand is the WO's negative control: without it the
    // constraint would measure a->? with no shared pivot and typing a new value
    // could not rotate a leg about the vertex. reverseB is SKC-58B's far sector
    // (leg B's direction reversed, so the stored obtuse-reading value is already
    // satisfied by the drawn geometry -- no motion on commit).
    case 'angle3': {
      const v = gcsPointId(index, d.vertex, where)
      const pa = gcsPointId(index, d.a, where)
      const pb = gcsPointId(index, d.b, where)
      if (d.reverseB) {
        // Same SKC-59-R4 boundary guard as the two-line kind: a wrongly-signed
        // value would solve the MIRROR branch silently.
        const pv = resolvePoint(entities, d.vertex)
        const qa = resolvePoint(entities, d.a)
        const qb = resolvePoint(entities, d.b)
        if (pv && qa && qb) {
          const theta = lineAngle({ start: pv, end: qa }, { start: pv, end: qb })
          if (!reversedAngleValueSignValid(theta, d.value)) {
            throw new SketchMappingError(
              `${where}: reverseB=true angle dimension '${d.id}' value ${d.value} contradicts ` +
              `the reversed-leg sign convention for the current geometry (theta=${theta}) -- ` +
              `a writer bypassed signedAngleEditValue`)
          }
        }
      }
      return [{ id: d.id, type: 'l2l_angle_pppp', driving: d.driving,
        l1p1_id: v, l1p2_id: pa,
        l2p1_id: d.reverseB ? pb : v, l2p2_id: d.reverseB ? v : pb,
        angle: d.value }]
    }

    case 'radius': {
      const e = expectKind(index, d.entityId, ['circle', 'arc'], where)
      return e.kind === 'circle'
        ? [{ id: d.id, type: 'circle_radius', c_id: e.id, radius: d.value, driving: d.driving }]
        : [{ id: d.id, type: 'arc_radius',    a_id: e.id, radius: d.value, driving: d.driving }]
    }

    case 'diameter': {
      const e = expectKind(index, d.entityId, ['circle', 'arc'], where)
      return e.kind === 'circle'
        ? [{ id: d.id, type: 'circle_diameter', c_id: e.id, diameter: d.value, driving: d.driving }]
        : [{ id: d.id, type: 'arc_diameter',    a_id: e.id, diameter: d.value, driving: d.driving }]
    }

    case 'arcLength': {
      const e = expectKind(index, d.entityId, ['arc'], where)
      return [{
        id: d.id,
        type: 'arc_length',
        a_id: e.id,
        dist: d.value,
        driving: d.driving,
      }]
    }

    // INERT ellipse major/minor radius dims (ADR-0003 explicit fork): the
    // ellipse is SOLVER-INERT, so these push NO planegcs constraint. We still
    // VALIDATE the ref (fail loud on a wrong-kind target) but return null; a
    // DRIVING dim's value is applied directly to the entity by
    // applyInertEllipseDims BEFORE the primitive list is built. This is NOT a
    // silent fallback -- it is the documented direct-edit mechanism.
    case 'majorRadius':
    case 'minorRadius':
    // Focus-to-focus (2c) is inert too: it DEFINES the ellipse by resizing the
    // foci-bearing semi-axis in applyInertEllipseDims BEFORE the primitive list
    // is built (planegcs has no ellipse primitive to constrain). Validate the
    // ref, push nothing.
    case 'focusDistance':
      expectKind(index, d.entityId, ['ellipse', 'elliptical-arc'], where)
      return []

    // Chamfer setback pair (WO-1858): the COMPOUND mapping. d1 and d2 are two
    // INDEPENDENT distances from the SKC-41A theoretical-corner phantom to the
    // chamfer line's own start and end -- exactly the pair
    // measureChamferSetbacks reads back, so the number the label shows and the
    // number the solver holds are the same quantity by construction. Two
    // p2p_distance equations remove two degrees of freedom, which is what a
    // fully-dimensioned chamfer corner is worth.
    //
    // A REFERENCE d1xd2 validates its ref and pushes nothing, like every other
    // reference dimension (the caller below only pushes for driving dims; the
    // early return also keeps the corner lookup off the hot path for readouts).
    case 'd1xd2': {
      const line = expectKind(index, d.entityId, ['line'], where)
      if (!d.driving) return []
      const resolved = resolveChamferCorner(entities, constraints, line.id)
      if (!resolved.ok) {
        // Rule 11: the software does what it can. Without the theoretical
        // corner there is no pair of distances to hold, so it says in ONE
        // console line what could not be worked out and solves the rest of
        // the sketch -- no UI notice, no refusal thrown at the operator, and
        // never a guessed virtual intersection.
        console.warn(
          `[gcsMapping] ${where}: cannot drive the setbacks of chamfer line ` +
          `'${line.id}' - ${resolved.reason}; the sketch solves without them`)
        return []
      }
      const phantom = gcsPointId(index, resolved.corner.phantomRef, where)
      return [
        { id: `${d.id}:d1`, type: 'p2p_distance', driving: d.driving,
          p1_id: phantom, p2_id: `${line.id}:start`, distance: d.value },
        { id: `${d.id}:d2`, type: 'p2p_distance', driving: d.driving,
          p1_id: phantom, p2_id: `${line.id}:end`, distance: d.d2 },
      ]
    }
  }
}

/** Every point-site reference (PointRef) a constraint carries. Entity-id
 *  only kinds (parallel, tangent, ...) carry none. */
function constraintPointRefs(c: SketchConstraint): PointRef[] {
  switch (c.kind) {
    case 'coincident':
    case 'continuity_g1':
    case 'continuity_g2':
    case 'symmetric':       return [c.a, c.b]
    case 'horizontal':
    case 'vertical':        return c.points ? [...c.points] : []
    case 'midpoint':
    case 'point_on_object':
    case 'pierce':          return [c.point]
    case 'fix':             return c.point ? [c.point] : []
    default:                return []
  }
}

/** Every point-site reference (PointRef) a dimension carries. */
function dimensionPointRefs(d: SketchDimension): PointRef[] {
  switch (d.kind) {
    case 'distance':
    case 'distanceX':
    case 'distanceY':  return [d.a, d.b]
    case 'ordinate':   return [d.origin, d.point]
    case 'angle3':     return [d.vertex, d.a, d.b]
    case 'distancePL': return [d.point]
    case 'angle':
    case 'radius':
    case 'diameter':
    case 'arcLength':
    case 'majorRadius':
    case 'minorRadius':
    case 'focusDistance':
    case 'd1xd2':      return []
  }
}

/**
 * Which FOCUS sites are referenced per entity id, across ALL constraints
 * and dimensions (driving or reference — a reference dim is validated
 * against the same point ids, and a driven->driving toggle must not change
 * the primitive topology). Un-referenced ellipses get NO focus primitives,
 * so an existing document without focus refs is byte-identical to before.
 */
function referencedFocusSites(sketch: Sketch): Map<string, Set<'focus1' | 'focus2'>> {
  const out = new Map<string, Set<'focus1' | 'focus2'>>()
  const add = (r: PointRef) => {
    if (r.site !== 'focus1' && r.site !== 'focus2') return
    let s = out.get(r.entityId)
    if (!s) { s = new Set(); out.set(r.entityId, s) }
    s.add(r.site)
  }
  for (const c of sketch.constraints) constraintPointRefs(c).forEach(add)
  for (const d of sketch.dimensions) dimensionPointRefs(d).forEach(add)
  return out
}

/** Control points of a control-point spline (WO-1861) are solver points only
 * when something names them -- in practice a select-tool drag of one control
 * point. Each named one becomes a FREE point seeded at the control point; the
 * pull (entitiesPulledFromSolved) writes it back as that control point alone.
 * An un-named spline materializes nothing and maps exactly as before. */
function referencedSplineControlSites(
  sketch: Sketch,
  index: Map<string, SketchEntity>,
  additional: readonly PointRef[] = [],
): Map<string, Set<number>> {
  const out = new Map<string, Set<number>>()
  const add = (ref: PointRef) => {
    const i = splineControlSiteIndex(ref.site)
    if (i === null) return
    let s = out.get(ref.entityId)
    if (!s) { s = new Set(); out.set(ref.entityId, s) }
    s.add(i)
  }
  for (const c of sketch.constraints) constraintPointRefs(c).forEach(add)
  for (const d of sketch.dimensions) dimensionPointRefs(d).forEach(add)
  additional.forEach(add)
  // WO-1866: the end control points a continuity constraint holds.
  for (const [id, idx] of continuityInfo.get(index)?.controls ?? []) {
    idx.forEach((i) => add({ entityId: id, site: `cp${i}` }))
  }
  return out
}

/** Line centers are derived solver points and are materialized only when a
 * point constraint/dimension (or an explicit drag request) references them.
 * Rendering always reads the canonical endpoints directly. */
function referencedLineCenters(
  sketch: Sketch,
  additional: readonly PointRef[] = [],
): Set<string> {
  const out = new Set<string>()
  const add = (ref: PointRef) => {
    if (ref.site !== 'center') return
    const entity = sketch.entities.find((candidate) => candidate.id === ref.entityId)
    if (entity?.kind === 'line') out.add(entity.id)
  }
  for (const c of sketch.constraints) constraintPointRefs(c).forEach(add)
  for (const d of sketch.dimensions) dimensionPointRefs(d).forEach(add)
  additional.forEach(add)
  return out
}

// ---- Block orientation: rotation as a SOLVABLE angle (SKC-ROTATION-SOLVABLE) --
//
// A block's rotation is TYPED-INERT by default (types.ts): only its `origin`
// point enters the solve, so the block contributes exactly 2 DoF regardless of
// member count (the SKC-BLOCKS pins). This is the ellipse/spline/text doctrine.
//
// When a constraint/dimension references the block AS A LINE OPERAND -- an angle
// dimension, or a parallel / perpendicular / horizontal / vertical constraint --
// its orientation is PROMOTED to a solver-owned angle, opt-in and per-block,
// exactly the way `referencedFocusSites` materializes an ellipse focus only when
// something references it. The promotion materializes a second `refpoint` point
// at a FIXED radius from the origin: a single `p2p_distance` pins that radius (1
// equation), leaving the ANGLE free (+1 rotational DoF), and a synthetic `orient`
// LINE (origin -> refpoint) is the operand the angular constraint solves against.
// This is the foci precedent (a center-tied materialized point) with the rigid
// two-`difference` tie (0 DoF) relaxed to a radius-only tie (1 DoF = the angle).
// entitiesFromSolved re-derives block.rotation from the solved origin->refpoint
// vector. A block NOT referenced this way materializes NOTHING and stays
// byte-identical to today (2 DoF) -- so every existing block DoF pin holds and no
// schema change is needed (the reference is an ordinary entity-id operand).

/** Radius of the internal orientation refpoint. Never rendered; only the ANGLE
 *  of the origin->refpoint vector is meaningful (atan2 is scale-free), so any
 *  well-conditioned positive constant works. */
const BLOCK_ORIENT_RADIUS = 10

const BLOCK_TWO_PI = Math.PI * 2
/** Normalize into [0, 2*PI) -- the same convention setBlockRotationDeg stores,
 *  so a solver-derived rotation and a typed one never disagree on range. */
function normBlockAngle(a: number): number {
  return ((a % BLOCK_TWO_PI) + BLOCK_TWO_PI) % BLOCK_TWO_PI
}

/**
 * Block ids whose orientation is referenced as a LINE operand by some
 * constraint/dimension (angle dim, parallel/perpendicular, horizontal/vertical).
 * ONLY these blocks get an orientation line + a free angle DoF; every other
 * block stays origin-only (2 DoF). Kept in exact lock-step with `lineOperandId`
 * below: it resolves a block operand to `${id}:orient` in precisely these cases,
 * so the synthetic line a constraint references always exists. `collinear` is
 * deliberately excluded (its mapping composes a point-on-line on an operand's
 * `:start` endpoint, which a block orientation line does not expose -- it fails
 * loud by name via expectKind instead, ADR-0003).
 */
function referencedBlockOrientations(
  sketch: Sketch, index: Map<string, SketchEntity>,
): Set<string> {
  const out = new Set<string>()
  const add = (id: string | undefined) => {
    if (id !== undefined && index.get(id)?.kind === 'block') out.add(id)
  }
  for (const c of sketch.constraints) {
    switch (c.kind) {
      case 'parallel':
      case 'perpendicular':
        add(c.a); add(c.b); break
      case 'horizontal':
      case 'vertical':
        add(c.line); break
    }
  }
  for (const d of sketch.dimensions) {
    if (d.kind === 'angle') { add(d.a); add(d.b) }
  }
  return out
}

/** The gcs LINE id an angular constraint/dimension operand resolves to: a real
 *  line entity's own id, or a block's synthetic orientation line
 *  (`${id}:orient`, materialized in sketchToGcsPrimitives when the block's
 *  orientation is referenced). Fails loud (ADR-0003) for any other kind, exactly
 *  as expectKind(['line']) did before -- just widened to accept a block. */
function lineOperandId(
  index: Map<string, SketchEntity>, id: string, where: string,
): string {
  const e = getEntity(index, id, where)
  if (e.kind === 'line') return e.id
  if (e.kind === 'block') return `${e.id}:orient`
  throw new SketchMappingError(`${where}: entity '${id}' is a ${e.kind}, expected line|block`)
}

/**
 * Build the full ordered planegcs primitive list for a sketch. Order
 * matters to the wrapper: points must exist before the geometry that
 * references them, geometry before the constraints on it.
 */
export function sketchToGcsPrimitives(
  sketch: Sketch,
  additionalPointRefs: readonly PointRef[] = [],
): SketchPrimitive[] {
  const index = entityIndex(sketch)
  const fixedPoints = collectFixedPointIds(sketch, index)
  const focusSites = referencedFocusSites(sketch)
  const orientedBlocks = referencedBlockOrientations(sketch, index)
  const lineCenters = referencedLineCenters(sketch, additionalPointRefs)
  const splineControls = referencedSplineControlSites(sketch, index, additionalPointRefs)
  const primitives: SketchPrimitive[] = []

  // 1. Points (with grounding flags), 2. geometry, 3. arc internal rules.
  for (const e of sketch.entities) {
    for (const p of entityPoints(e, lineCenters.has(e.id))) {
      primitives.push({ id: p.id, type: 'point', x: p.at.x, y: p.at.y, fixed: fixedPoints.has(p.id) })
    }
    switch (e.kind) {
      case 'point':
        break
      case 'line':
        primitives.push({ id: e.id, type: 'line', p1_id: `${e.id}:start`, p2_id: `${e.id}:end` })
        // The segment center is a DERIVED solver point, never persisted and
        // never used for rendering. This internal rule ties it to the two
        // canonical endpoints whenever a point constraint/dimension targets
        // {entityId, site:'center'}.
        if (lineCenters.has(e.id)) {
          primitives.push({ id: `${e.id}:centerRule`, type: 'p2p_symmetric_ppp',
            p1_id: `${e.id}:start`, p2_id: `${e.id}:end`, p_id: `${e.id}:center` })
        }
        break
      case 'circle':
        primitives.push({ id: e.id, type: 'circle', c_id: `${e.id}:center`, radius: e.radius })
        break
      case 'ellipse':
      case 'elliptical-arc': {
        // SOLVER-INERT shape: only the center point above enters the solve;
        // NO ellipse primitive is pushed, so the shape params are immune to
        // the constraint network and carried verbatim by entitiesFromSolved.
        //
        // REFERENCED FOCI are materialized as real gcs points rigidly TIED
        // to the center by two 'difference' constraints (focus - center =
        // const; the offset is constant within a solve because rotation and
        // radii are inert). Net DoF contribution is zero (2 params - 2
        // equations), and the tie makes a focus ref behave EXACTLY like a
        // center ref (a driving dim on a focus drags the whole ellipse)
        // instead of leaving a free phantom point the solver could move off
        // the rendered focus. Solved focus coordinates are deliberately NOT
        // pulled back (entitiesFromSolved re-derives foci from center +
        // shape; the tie guarantees both agree). Circle-degenerate: the
        // offset is (0,0) — the focus coincides with the center, which is
        // exactly the collapsed-foci semantics of ellipseFocusSite.
        const sites = focusSites.get(e.id)
        if (sites) {
          for (const site of ['focus1', 'focus2'] as const) {
            if (!sites.has(site)) continue
            const f = ellipseFocusSite(e, site)
            const pid = `${e.id}:${site}`
            primitives.push({ id: pid, type: 'point', x: f.x, y: f.y, fixed: fixedPoints.has(pid) })
            primitives.push({ id: `${pid}:tx`, type: 'difference', driving: true,
              param1: { o_id: `${e.id}:center`, prop: 'x' }, param2: { o_id: pid, prop: 'x' },
              difference: f.x - e.center.x })
            primitives.push({ id: `${pid}:ty`, type: 'difference', driving: true,
              param1: { o_id: `${e.id}:center`, prop: 'y' }, param2: { o_id: pid, prop: 'y' },
              difference: f.y - e.center.y })
          }
        }
        break
      }
      case 'spline':
        // SOLVER-INERT: push only the anchor point above; NO spline primitive
        // enters the solve. entitiesFromSolved translates the whole point list
        // rigidly to follow the (possibly moved) anchor.
        // WO-1861: a control point a drag names becomes its own FREE point
        // (no constraint ties it; the drag pin moves it alone).
        // WO-1866: on a LOCAL spline (continuity) the two end control points
        // are the start/end points already pushed above.
        for (const i of splineControls.get(e.id) ?? []) {
          if (!splineHasControlSites(e.form) || i >= e.points.length) continue
          if (splineControlGcsId(index, e, i) !== `${e.id}:cp${i}`) continue
          primitives.push({ id: `${e.id}:cp${i}`, type: 'point',
            x: e.points[i].x, y: e.points[i].y, fixed: false })
        }
        break
      case 'text':
        // SOLVER-INERT: push only the anchor point above; NO text/line
        // primitive enters the solve (the glyph geometry is carried
        // verbatim). entitiesFromSolved moves the anchor to follow it.
        break
      case 'block':
        // SOLVER-INERT (SKC-BLOCKS): the origin point above is the only member
        // participation -- the whole block is one rigid object worth exactly 2
        // DoF (origin x,y) regardless of member count; entitiesFromSolved carries
        // the members verbatim (local frame) and re-places them from the origin.
        //
        // SKC-ROTATION-SOLVABLE: if the block's ORIENTATION is referenced (angle
        // dim / parallel / perpendicular / horizontal / vertical), promote its
        // rotation to a solver-owned angle. Materialize a refpoint at a fixed
        // radius (seeded from the current typed rotation), pin the radius with one
        // p2p_distance (leaving the angle free = +1 DoF), and expose the
        // origin->refpoint `orient` LINE the angular constraint solves against.
        // Un-referenced blocks skip this entirely and stay byte-identical (2 DoF).
        if (orientedBlocks.has(e.id)) {
          const oid = `${e.id}:origin`
          const rid = `${e.id}:refpoint`
          const seedX = e.origin.x + Math.cos(e.rotation) * BLOCK_ORIENT_RADIUS
          const seedY = e.origin.y + Math.sin(e.rotation) * BLOCK_ORIENT_RADIUS
          primitives.push({ id: rid, type: 'point', x: seedX, y: seedY, fixed: false })
          primitives.push({ id: `${e.id}:orient:radius`, type: 'p2p_distance', driving: true,
            p1_id: oid, p2_id: rid, distance: BLOCK_ORIENT_RADIUS })
          primitives.push({ id: `${e.id}:orient`, type: 'line', p1_id: oid, p2_id: rid })
        }
        break
      case 'arc':
        primitives.push({ id: e.id, type: 'arc', c_id: `${e.id}:center`,
          start_id: `${e.id}:start`, end_id: `${e.id}:end`,
          start_angle: e.startAngle, end_angle: e.endAngle, radius: e.radius })
        // planegcs requires arc_rules to keep endpoint coordinates
        // consistent with center/radius/angles (they are separate params).
        primitives.push({ id: `${e.id}:rules`, type: 'arc_rules', a_id: e.id })
        break
    }
  }

  // 4. User constraints, 5. DRIVING dimensions. Reference (driven) dims
  // are mapped for VALIDATION only and never pushed: pushing one with a
  // free value param lets DogLeg trade geometry against the param
  // (measured: a stale reference value dragged a free 10mm line to
  // 2.31mm). Their displayed value is re-measured from the solved
  // geometry by the store after every solve — pure display data.
  for (const c of sketch.constraints) primitives.push(...mapConstraint(c, index, fixedPoints))
  for (const d of sketch.dimensions) {
    // fail-loud ref validation for ALL dims; the list is EMPTY for INERT dims
    // (ellipse major/minor radius, focus distance), which resize the entity
    // directly rather than the solver, and carries TWO primitives for a
    // driving chamfer setback pair (WO-1858).
    const prims = mapDimension(d, index, sketch.entities, sketch.constraints)
    if (d.driving) primitives.push(...prims)
  }

  return primitives
}

// ---- Inert ellipse major/minor radius (direct-edit, ADR-0003 explicit) -----
//
// The ellipse is SOLVER-INERT (types.ts): its shape params never enter the
// constraint solve, only its center is a real solver point. A major/minor
// radius DIMENSION is therefore NOT a planegcs constraint (mapDimension pushes
// nothing for it) -- it is a display + DIRECT-EDIT affordance. A DRIVING
// major/minor radius dim REWRITES the owning ellipse's stored radius here,
// BEFORE any primitive is built, exactly as an inert entity is manipulated
// directly; the resized ellipse then flows through sketchToGcsPrimitives
// (center point only) and entitiesFromSolved (shape carried verbatim)
// unchanged, so the render/bake reflect the new size after the solve returns.
//
// Reference (driving:false) dims never resize -- they only report (re-measured
// after each solve by the store, like every other reference dim). An ellipse
// with NO driving major/minor dim is returned UNTOUCHED (fast path), so an
// un-dimensioned ellipse is byte-identical to today. Because the dim adds no
// solver equation, it does not change the ellipse's definition state -- the
// shape freedom is simply not modelled by the solver, consistent with the
// solver-inert doctrine (a later milestone may promote the ellipse to a native
// primitive; that is deliberately out of scope here).
//
// WO-1464 (BUG-492): majorRadius, minorRadius and focusDistance are ONE system.
// An ellipse has TWO shape numbers, so any two driving shape dims define it and
// a third is redundant. The store never lets a third become driving (it is
// added as a reference instead, demoteExtraEllipseShapeDims), and every driving
// pair resolves through resolveEllipseShape so each driving value is exactly
// the value the geometry has -- the displayed dimension never disagrees with
// the ellipse it labels.
export function applyInertEllipseDims(sketch: Sketch): Sketch {
  const drives = new Map<string, EllipseShapeDimension[]>()
  for (const d of sketch.dimensions) {
    // Non-positive values are degenerate (a zero radius or zero 2c has no
    // ellipse): leave the entity's current shape. The user-facing edit path
    // (store.commitDimensionValue) refuses them loudly, so this silent skip is
    // only the defensive pre-solve guard, never the user's only feedback.
    if (!d.driving || !isEllipseShapeDimension(d) || !(d.value > 0)) continue
    const list = drives.get(d.entityId) ?? []
    // Two shape numbers define an ellipse; a third driving one (never written
    // by the store) is ignored in document order rather than guessed at.
    if (list.length < 2) list.push(d)
    drives.set(d.entityId, list)
  }
  if (drives.size === 0) return sketch // fast path: nothing to resize
  return {
    ...sketch,
    entities: sketch.entities.map((e) => {
      if (e.kind !== 'ellipse' && e.kind !== 'elliptical-arc') return e
      const drive = drives.get(e.id)
      if (!drive) return e
      const r = resolveEllipseShape(e, drive)
      // An impossible pair is refused at the commit boundary; keep the shape.
      if (!r.ok) return e
      return { ...e, majorRadius: r.majorRadius, minorRadius: r.minorRadius }
    }),
  }
}

export type EllipseShapeDimension = Extract<
  SketchDimension, { kind: 'majorRadius' | 'minorRadius' | 'focusDistance' }>

export function isEllipseShapeDimension(d: SketchDimension): d is EllipseShapeDimension {
  return d.kind === 'majorRadius' || d.kind === 'minorRadius' || d.kind === 'focusDistance'
}

export function ellipseShapeKindLabel(kind: EllipseShapeDimension['kind']): string {
  return kind === 'majorRadius' ? 'major radius' : kind === 'minorRadius' ? 'minor radius' : 'focus distance'
}

const fmtShape = (v: number): string => String(Number(v.toFixed(4)))
const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1)

export type EllipseShapeOutcome =
  | { ok: true; majorRadius: number; minorRadius: number }
  | { ok: false; reason: string }

/**
 * The radii an ellipse takes from at most two driving shape values (the caller
 * passes the valid, positive ones, first two in document order). Without a
 * focus distance the radii are the driving values. A focus distance alone
 * resizes the foci-bearing (longer) axis and keeps the shorter one. A focus
 * distance with one radius keeps that radius and COMPUTES the other: if the
 * radius is the entity's current long axis the other is sqrt(a^2 - c^2) (so
 * the radius must exceed c), if it is the short axis the other is
 * sqrt(c^2 + b^2). The long/short role comes from the entity's current radii
 * (ties: major is long), the same choice ellipseRadiiForFocalDistance makes.
 */
export function resolveEllipseShape(
  e: EllipseShape, drive: readonly EllipseShapeDimension[],
): EllipseShapeOutcome {
  let major: number | undefined
  let minor: number | undefined
  let focal: number | undefined
  for (const d of drive) {
    if (d.kind === 'majorRadius') major ??= d.value
    else if (d.kind === 'minorRadius') minor ??= d.value
    else focal ??= d.value
  }
  if (focal === undefined) {
    return { ok: true, majorRadius: major ?? e.majorRadius, minorRadius: minor ?? e.minorRadius }
  }
  if (major === undefined && minor === undefined) {
    const r = ellipseRadiiForFocalDistance(e, focal)
    return { ok: true, majorRadius: r.majorRadius, minorRadius: r.minorRadius }
  }
  const c = focal / 2
  const axisIsMajor = major !== undefined
  const axis = (major ?? minor) as number
  const majorIsLong = Math.abs(e.majorRadius) >= Math.abs(e.minorRadius)
  const axisIsLong = axisIsMajor ? majorIsLong : !majorIsLong
  if (axisIsLong && !(axis > c)) {
    const kind = axisIsMajor ? 'majorRadius' : 'minorRadius'
    return {
      ok: false,
      reason: `${ellipseShapeKindLabel(kind)} ${fmtShape(axis)} is not longer than half the ` +
        `focus distance (${fmtShape(c)})`,
    }
  }
  const other = axisIsLong ? Math.sqrt(axis * axis - c * c) : Math.sqrt(c * c + axis * axis)
  return axisIsMajor
    ? { ok: true, majorRadius: axis, minorRadius: other }
    : { ok: true, majorRadius: other, minorRadius: axis }
}

function drivingShapeDimsOn(
  dimensions: readonly SketchDimension[], entityId: string,
): EllipseShapeDimension[] {
  return dimensions.filter((d): d is EllipseShapeDimension =>
    isEllipseShapeDimension(d) && d.driving && d.entityId === entityId)
}

/** The refusal for committing `value` to driving shape dim `dimId`, or null
 *  when the ellipse can take it. Only an impossible shape is refused. */
export function ellipseShapeEditRefusal(
  sketch: Pick<Sketch, 'entities' | 'dimensions'>, dimId: string, value: number,
): string | null {
  const dim = sketch.dimensions.find((d) => d.id === dimId)
  if (!dim || !isEllipseShapeDimension(dim) || !dim.driving) return null
  const e = sketch.entities.find((x) => x.id === dim.entityId)
  if (!e || (e.kind !== 'ellipse' && e.kind !== 'elliptical-arc')) return null
  const drive = drivingShapeDimsOn(sketch.dimensions, dim.entityId)
    .map((d) => (d.id === dimId ? { ...d, value } : d))
    .filter((d) => d.value > 0)
    .slice(0, 2)
  const r = resolveEllipseShape(e, drive)
  return r.ok
    ? null
    : `${capitalize(ellipseShapeKindLabel(dim.kind))} dimension: ${r.reason} - no ellipse has that shape`
}

/** Refusal for toggling reference shape dim `dimId` to driving when its
 *  ellipse already has two driving shape dims, else null. */
export function ellipseShapeToggleRefusal(
  sketch: Pick<Sketch, 'dimensions'>, dimId: string,
): string | null {
  const dim = sketch.dimensions.find((d) => d.id === dimId)
  if (!dim || !isEllipseShapeDimension(dim) || dim.driving) return null
  if (drivingShapeDimsOn(sketch.dimensions, dim.entityId).length < 2) return null
  return `Ellipse already has two driving shape dimensions - ${ellipseShapeKindLabel(dim.kind)} ` +
    `stays a reference (${fmtShape(dim.value)})`
}

/**
 * Insert-path half of the rule: each incoming DRIVING shape dim whose ellipse
 * already has two driving shape dims (in `existing` or earlier in `incoming`)
 * is added as a REFERENCE showing the value the geometry has, with a console
 * line naming it. Everything else passes through unchanged (same array when
 * nothing is demoted).
 */
export function demoteExtraEllipseShapeDims(
  existing: readonly SketchDimension[], incoming: readonly SketchDimension[],
  entities: readonly SketchEntity[],
): { dims: SketchDimension[]; notices: string[] } {
  const notices: string[] = []
  const accepted: SketchDimension[] = []
  for (const d of incoming) {
    if (isEllipseShapeDimension(d) && d.driving &&
        drivingShapeDimsOn(existing, d.entityId).length +
        drivingShapeDimsOn(accepted, d.entityId).length >= 2) {
      const value = measureDimension(entities, d) ?? d.value
      accepted.push({ ...d, driving: false, value })
      notices.push(
        `Ellipse already has two driving shape dimensions - ${ellipseShapeKindLabel(d.kind)} ` +
        `added as a reference (${fmtShape(value)})`)
    } else {
      accepted.push(d)
    }
  }
  return { dims: notices.length ? accepted : (incoming as SketchDimension[]), notices }
}

/** demoteExtraEllipseShapeDims over a tool commit's `dimensions`. */
export function demoteExtraEllipseShapeDimsInCommit<T extends { dimensions?: SketchDimension[] }>(
  commit: T, existing: readonly SketchDimension[], entities: readonly SketchEntity[],
): { commit: T; notices: string[] } {
  const r = demoteExtraEllipseShapeDims(existing, commit.dimensions ?? [], entities)
  return { commit: r.notices.length ? { ...commit, dimensions: r.dims } : commit, notices: r.notices }
}

// ---- Drag (temporary constraints) ---------------------------------------

export interface DragTarget {
  /** A point site being dragged (a circle drags by 'center', etc.). */
  point: PointRef
  /** Target position in sketch coordinates. */
  to: Vec2
}

/** One or more point sites pinned at cursor-derived targets. A single
 *  target drags a point; multiple targets drag a whole entity rigidly
 *  (e.g. a line body = both endpoints offset by the same delta). */
export interface DragRequest {
  targets: DragTarget[]
}

/**
 * Temporary coordinate constraints pinning the dragged points at their
 * targets. `temporary: true` gives them planegcs tag -1 — the solver
 * treats them as soft/dragged (soft-parameter drag semantics) and they are
 * invisible to conflict diagnosis, so dragging can never poison the
 * document's own constraint network.
 */
export function dragPrimitives(sketch: Sketch, drag: DragRequest): SketchPrimitive[] {
  const index = entityIndex(sketch)
  return drag.targets.flatMap((t, i): SketchPrimitive[] => {
    const p = gcsPointId(index, t.point, 'drag')
    return [
      { id: `__drag${i}:x`, type: 'coordinate_x', p_id: p, x: t.to.x, temporary: true },
      { id: `__drag${i}:y`, type: 'coordinate_y', p_id: p, y: t.to.y, temporary: true },
    ]
  })
}

// ---- Free-DoF soft pins (B23: under-defined sketch drift) ----------------
//
// B23: an UNDER-DEFINED sketch has a null-space (the free DoF). Hand/snap-
// drawn geometry never exactly satisfies its constraints, so a plain DogLeg
// least-squares solve satisfies them by walking the FREE DoF off where the
// user drew — geometry drifts on finish/open/edit (~0.138 mm measured) and
// accumulates over reopen cycles. Seeding each point at its current x/y
// (sketchToGcsPrimitives) is NOT enough: nothing PINS the free DoF, so
// DogLeg is free to move them.
//
// FIX (phase 2 of solveSystem): re-solve the SAME hard system seeded at the
// as-drawn coords plus a SOFT pin per free point at its as-drawn coordinate,
// using coordinate_x/y with `temporary: true` (planegcs tag -1) — the SAME
// soft mechanism the drag path uses. Tag -1 is LOWER priority than the real
// constraints, so:
//   - truly free DoF (the null-space) stay parked at the drawn position
//     -> no drift, and
//   - hard constraints still win and move geometry to satisfy themselves;
//     the pins only select the minimal-movement point of the null-space.
// Points already grounded by a 'fix' (fixed param at push time) are skipped
// — they are removed from the solve entirely, so a pin would be redundant.
//
// The pins are temporary (tag -1): invisible to conflict/redundant
// diagnosis, and toDocumentIds drops their '__pin' ids defensively.
// Points/radii NOT to pin (the edited geometry on the T10 radius-edit path):
// see filletPinExclusions. Undefined on the normal B23 path = pin everything.
interface ParkExclusions { points: Set<string>; radiusEntities: Set<string> }

function freeDofPinPrimitives(
  sketch: Sketch, fixed: Set<string>, exclude?: ParkExclusions,
): SketchPrimitive[] {
  const pins: SketchPrimitive[] = []
  const continuity = continuityInfo.get(entityIndex(sketch))
  for (const e of sketch.entities) {
    // WO-1866: a local spline's materialized end control points are free
    // solver points too; park them where they were drawn like any other.
    if (e.kind === 'spline') {
      for (const i of continuity?.controls.get(e.id) ?? []) {
        const id = `${e.id}:cp${i}`
        if (i <= 0 || i >= e.points.length - 1 || exclude?.points.has(id)) continue
        const at = e.points[i]
        pins.push({ id: `__pin:${id}:x`, type: 'coordinate_x', p_id: id, x: at.x, temporary: true })
        pins.push({ id: `__pin:${id}:y`, type: 'coordinate_y', p_id: id, y: at.y, temporary: true })
      }
    }
    for (const p of entityPoints(e)) {
      // The line center has no independent free DoF; parking it in addition
      // to both endpoints would overweight the same translation twice.
      if (e.kind === 'line' && p.id === `${e.id}:center`) continue
      if (fixed.has(p.id) || exclude?.points.has(p.id)) continue
      pins.push({ id: `__pin:${p.id}:x`, type: 'coordinate_x', p_id: p.id, x: p.at.x, temporary: true })
      pins.push({ id: `__pin:${p.id}:y`, type: 'coordinate_y', p_id: p.id, y: p.at.y, temporary: true })
    }
    // A circle/arc RADIUS is a free DoF too — a bare param, not a point — so
    // the point-only pins above leave it as the ONLY unpinned freedom in the
    // null-space. DogLeg then satisfies any radius-coupled constraint (most
    // visibly a line/circle TANGENT added after the fact) by collapsing the
    // radius to wherever the geometry already sits — measured: a free r=5
    // circle made tangent to a fixed line at distance 0.5 shrank to r=0.5
    // while the line never moved. Park the radius at its as-drawn value with
    // the SAME soft mechanism (tag -1) so it is no longer the cheapest sink:
    // the tangent now redistributes the error across the line AND the radius
    // (minimal-movement of the whole null-space) instead of deforming only
    // the circle. The pin is skipped when the radius is already grounded by a
    // whole-entity fix (center fixed -> redundant hard radius pin exists).
    if ((e.kind === 'circle' || e.kind === 'arc') &&
        !fixed.has(`${e.id}:center`) && !exclude?.radiusEntities.has(e.id)) {
      pins.push(e.kind === 'circle'
        ? { id: `__pin:${e.id}:radius`, type: 'circle_radius', c_id: e.id, radius: e.radius, temporary: true }
        : { id: `__pin:${e.id}:radius`, type: 'arc_radius', a_id: e.id, radius: e.radius, temporary: true })
    }
    // SKC-59: a line's LENGTH is a free DoF exactly like a circle/arc radius,
    // and it is the cheapest sink an ANGLE constraint can collapse into. An
    // angle dim between two lines constrains only DIRECTION, never length; so
    // when the user edits an angle value on a line whose length is otherwise
    // free, DogLeg satisfies the new direction by TRADING length for angle. The
    // point-coordinate pins above do NOT prevent this: pinning both endpoints
    // at their as-drawn coords admits a lower-error least-squares solution that
    // SCALES the segment by cos(delta) (delta = angle swing) rather than
    // rotating it rigidly -- and when the new direction is ~perpendicular or
    // reversed relative to the old one, cos(delta) -> 0 and the line collapses
    // to a point (Operator SKC-59: a 143deg line edited to 120deg shrank to a
    // vertex). Park the length at its as-drawn value with the SAME soft
    // mechanism (tag -1) the radius pin uses, so the null-space minimum is a
    // length-preserving ROTATION instead of a collapse. `scale` overweights the
    // length residual against the two competing endpoint-coordinate pins (which
    // together pull ~2:1 toward the projected/shrunk endpoints); without it the
    // soft pins compromise to a small but user-visible shrink (Operator's bar: an
    // angle edit must not change length unless a constraint genuinely forces
    // it). It stays a soft (tag -1) pin, strictly LOWER priority than any hard
    // constraint, so a DRIVING distance dim / coincident that truly requires a
    // length change still wins (verified: a hard len=50 dim stretches the line
    // while the angle rotates it). Skipped when BOTH endpoints are grounded by
    // a fix (length already determined) or when either endpoint is on the
    // exclusion list (the fillet radius-edit path must keep its tangency legs
    // free to change length as the arc resizes).
    if (e.kind === 'line' &&
        !(fixed.has(`${e.id}:start`) && fixed.has(`${e.id}:end`)) &&
        !exclude?.points.has(`${e.id}:start`) && !exclude?.points.has(`${e.id}:end`)) {
      const segLen = Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y)
      // A degenerate (already zero-length) segment has no length to preserve
      // and a zero distance pin is ill-conditioned -- leave it to the hard
      // system (never manufacture a constraint from noise).
      if (segLen > 1e-9) {
        pins.push({ id: `__pin:${e.id}:len`, type: 'p2p_distance',
          p1_id: `${e.id}:start`, p2_id: `${e.id}:end`,
          distance: segLen, temporary: true, scale: LENGTH_PIN_SCALE })
      }
    }
  }
  return pins
}

// SKC-59: soft length-pin weight. The two endpoint-coordinate pins on a line
// pull ~2:1 toward the shrunk/projected endpoints of an angle-only edit, so an
// equal-weight (scale 1) length pin only softens the shrink instead of
// eliminating it. Overweighting the single length residual makes the
// null-space minimum a length-preserving rotation (measured: 40mm -> 40.0000
// across every sector/axis vs 40 -> 36.8..0.0 unpinned). Still tag -1, so it
// never outranks a hard constraint.
const LENGTH_PIN_SCALE = 1000

/**
 * B23 phase 2 (non-drag, under-defined only): re-solve the hard system with
 * soft pins parking the free DoF at the AS-DRAWN coords, on a freshly cleared
 * wrapper. Returns the parked entities, or null when this refinement is not
 * applicable / does not converge — in which case the caller keeps phase 1's
 * geometry (never worse than today). Phase 1 owns the authoritative
 * status/dof/diagnosis verdict; this pass only repositions free DoF.
 */
function solveFreeDofParked(
  wrapper: GcsWrapper, sketch: Sketch, exclude?: ParkExclusions,
  seedEntities?: SketchEntity[],
): SketchEntity[] | null {
  // Pin coordinates ALWAYS come from `sketch` (the as-drawn geometry) — that
  // is the spot the free DoF must return to. `seedEntities` (when given) only
  // changes the geometry the solve STARTS from: on the radius-edit path the
  // phase-1 solved geometry (fillet already at the new radius) is a far better
  // seed than the stale as-drawn coords, so DogLeg only has to pull the small
  // free-DoF drift back to the pins instead of re-making the large radius move
  // (which it gets stuck on from the as-drawn seed).
  let primitives: SketchPrimitive[]
  try {
    const index = entityIndex(sketch)
    const fixed = collectFixedPointIds(sketch, index)
    const pins = freeDofPinPrimitives(sketch, fixed, exclude)
    if (pins.length === 0) return null // nothing free to park
    primitives = sketchToGcsPrimitives(
      seedEntities ? { ...sketch, entities: seedEntities } : sketch)
    primitives.push(...pins)
  } catch {
    return null // already validated in phase 1; never block on a re-map error
  }

  wrapper.clear_data()
  wrapper.push_primitives_and_params(primitives)
  const result = wrapper.solve(Algorithm.DogLeg)
  // Only accept a cleanly converged parked solve. A non-converged status
  // (the full pin set can fight a large constraint-driven move) -> keep
  // phase 1. Conflicts cannot arise: pins are soft and seeded at coords the
  // hard system already satisfied, so they add at most redundancy.
  if (result !== GcsSolveStatus.Success && result !== GcsSolveStatus.Converged) {
    return null
  }
  wrapper.apply_solution()
  return entitiesFromSolved(sketch, (id) => wrapper.sketch_index.get_primitive(id))
}

// ---- Solved gcs state -> entities ----------------------------------------

type PrimitiveLookup = (id: string) => SketchPrimitive | undefined

function pulledPoint(lookup: PrimitiveLookup, id: string): Vec2 {
  const p = lookup(id)
  if (!p || p.type !== 'point') {
    throw new SketchMappingError(`solved sketch is missing point '${id}' — mapping/solve desync`)
  }
  return { x: p.x, y: p.y }
}

/**
 * Rebuild entity geometry from a solved wrapper's sketch index. Returns
 * NEW entity objects (input sketch is never mutated — on a failed solve
 * the caller keeps the last good geometry by simply not applying this).
 *
 * WO-1859: this is also where an ASSOCIATIVE OFFSET re-derives. The solved
 * source geometry is pulled first, then applyOffsetLinks re-runs the offset
 * tool from it and rewrites the linked pieces IN PLACE — which is why
 * dragging a source line or driving a source dimension carries the offset in
 * THIS solve rather than on the next interaction. The pass rewrites existing
 * entities only: it never adds or removes one, so no constraint can be
 * orphaned by it, and every host that already applies these entities gets
 * associativity without a new commit path.
 */
export function entitiesFromSolved(sketch: Sketch, lookup: PrimitiveLookup): SketchEntity[] {
  return applyOffsetLinks(entitiesPulledFromSolved(sketch, lookup))
}

/** The pull itself: solved coordinates onto new entity objects. */
function entitiesPulledFromSolved(sketch: Sketch, lookup: PrimitiveLookup): SketchEntity[] {
  const localSplines = continuityInfo.get(entityIndex(sketch))?.localSplines ?? new Set<string>()
  return sketch.entities.map((e): SketchEntity => {
    switch (e.kind) {
      case 'point':
        return { ...e, at: pulledPoint(lookup, e.id) }
      case 'line':
        return { ...e,
          start: pulledPoint(lookup, `${e.id}:start`),
          end:   pulledPoint(lookup, `${e.id}:end`) }
      case 'circle': {
        const c = lookup(e.id)
        if (!c || c.type !== 'circle') throw new SketchMappingError(`solved sketch is missing circle '${e.id}'`)
        return { ...e, center: pulledPoint(lookup, `${e.id}:center`), radius: c.radius }
      }
      case 'arc': {
        const a = lookup(e.id)
        if (!a || a.type !== 'arc') throw new SketchMappingError(`solved sketch is missing arc '${e.id}'`)
        return { ...e, center: pulledPoint(lookup, `${e.id}:center`),
          radius: a.radius, startAngle: a.start_angle, endAngle: a.end_angle }
      }
      case 'ellipse':
      case 'elliptical-arc':
        // Solver-inert: pull the (possibly moved) center, keep shape verbatim.
        return { ...e, center: pulledPoint(lookup, `${e.id}:center`) }
      case 'spline': {
        // WO-1861: a control-point drag in flight. Each named control point
        // lands where its pin put it and every other point stays put -- the
        // curve changes locally and the ends do not move unless they are the
        // point being dragged. The settle solve at drag end re-asserts any
        // constraint on the anchor with the ordinary rigid rule below.
        // WO-1862: a bezier chain applies its own edit rule on top
        // (splineDragEdit): a dragged anchor carries its handles, and a handle
        // dragged at a smooth joint keeps the other handle collinear.
        // WO-1866: a LOCAL spline (under a continuity constraint) takes every
        // control point the solve owns back individually -- both ends and
        // each materialized one -- and keeps the rest where they were drawn.
        if (localSplines.has(e.id)) {
          const n = e.points.length
          return { ...e, points: e.points.map((p, i) => {
            const id = i === 0 ? `${e.id}:start` : i === n - 1 ? `${e.id}:end` : `${e.id}:cp${i}`
            const m = lookup(id)
            return m && m.type === 'point' ? { x: m.x, y: m.y } : { x: p.x, y: p.y }
          }) }
        }
        if (splineHasControlSites(e.form)) {
          const moved = new Map<number, { x: number; y: number }>()
          e.points.forEach((_, i) => {
            const m = lookup(`${e.id}:cp${i}`)
            if (m && m.type === 'point') moved.set(i, { x: m.x, y: m.y })
          })
          if (moved.size > 0) return { ...e, points: splineDragEdit(e, moved) }
        }
        // Solver-inert: the anchor (points[0]) may have moved via a
        // constraint; translate the WHOLE point list by the same delta so the
        // drawn shape is carried verbatim (rigid translation, exactly like the
        // ellipse's center-relative shape).
        const anchor = pulledPoint(lookup, `${e.id}:start`)
        const dx = anchor.x - e.points[0].x
        const dy = anchor.y - e.points[0].y
        return {
          ...e,
          points: e.points.map((p) => ({ x: p.x + dx, y: p.y + dy })),
          filletSourcePoints: e.filletSourcePoints?.map((p) => ({ x: p.x + dx, y: p.y + dy })),
        }
      }
      case 'text':
        // Solver-inert: the anchor may have moved via a constraint; pull it
        // and carry the string/height/rotation verbatim (the whole text
        // translates rigidly with its baseline-left origin).
        return { ...e, at: pulledPoint(lookup, `${e.id}:start`) }
      case 'block': {
        // Solver-inert (SKC-BLOCKS): pull the (possibly moved) origin; members
        // are carried VERBATIM in the block's local frame. World placement is
        // recomputed from origin at render/bake time (blockMemberWorldEntities),
        // so a moved origin rigidly re-places the whole member set.
        const origin = pulledPoint(lookup, `${e.id}:origin`)
        // SKC-ROTATION-SOLVABLE: if the orientation was promoted to a solver DoF
        // (a refpoint was materialized because a constraint/dim referenced it),
        // re-derive the rotation from the solved origin->refpoint vector, so a
        // driving angle/parallel/horizontal constraint OWNS block.rotation and
        // the typed field becomes a live readout of the solved angle. A block
        // with no orientation reference has no refpoint and carries rotation
        // verbatim (byte-identical to before).
        const rp = lookup(`${e.id}:refpoint`)
        if (rp && rp.type === 'point') {
          return { ...e, origin, rotation: normBlockAngle(Math.atan2(rp.y - origin.y, rp.x - origin.x)) }
        }
        return { ...e, origin }
      }
    }
  })
}

// ---- Solve orchestration --------------------------------------------------

export type SketchSolveOutcome =
  | { ok: true; entities: SketchEntity[]; status: SolveStatus }
  | {
      ok: false
      /** 'conflicting' = over-constrained (status names the set);
       *  'solver_failed' = no convergence; 'invalid_sketch' = bad refs. */
      reason: 'conflicting' | 'solver_failed' | 'invalid_sketch'
      message: string
      status: SolveStatus
    }

/** Translate gcs-reported constraint ids back to user document ids
 *  (internal ':rules'/':radius' helpers report as their owner) and drop
 *  temporary drag pins (tag -1 never maps to a document id). */
function toDocumentIds(ids: (string | undefined)[]): string[] {
  return [...new Set(ids.filter((id): id is string => !!id).map(ownerId))]
    .filter(id => !id.startsWith('__drag') && !id.startsWith('__pin'))
}

// ---- Benign-by-construction redundancy suppression (C5) -------------------
//
// A fillet/round leg is expressed for planegcs as tangent_la PLUS an endpoint
// coincident (arc endpoint <-> line endpoint). That pair is ONE constraint
// past minimal, so planegcs's rank diagnosis flags the tangent as REDUNDANT
// (advisory) at the as-built geometry — every fillet contributes two such
// flags, and a multi-fillet sketch spams the "N redundant (advisory)" banner
// with them. This is NOT an over-constraint we can drop: BOTH constraints are
// load-bearing (the coincident closes/locates the joint; the tangent enforces
// the tangency direction through future edits), so removing either breaks the
// fillet. The diagnosis is mathematically correct but the advisory is noise,
// so these specific ids are suppressed from status.redundant. A TRUE conflict
// (over-constraint) is never redundant — it does not converge and is reported
// through the conflicting set instead (ADR-0003 fail-loud preserved).
//
// Pattern matched (exactly filletTool's joints): a 'tangent' between an arc
// and a line that ALSO share a 'coincident' tying that arc's start/end point
// to one of the line's start/end points. A redundant tangent WITHOUT the
// endpoint coincident is left visible — it is not the intrinsic fillet
// redundancy and the user may genuinely want to know about it.
interface FilletJoint {
  tangentConstraintId: string
  arcId: string
  arcSite: 'start' | 'end'
  lineId: string
  lineSite: 'start' | 'end'
}

/** Shared detector behind both the C5 redundant-advisory suppression and the
 *  SKC-77 DOF/definedness adjustment below. Pattern matched (exactly
 *  filletTool's joints): a 'tangent' between an arc and a line that ALSO
 *  share a 'coincident' tying that arc's start/end point to one of the
 *  line's start/end points. Returns one entry per joint (never a
 *  bare-tangent-without-coincident — that is a different, non-fillet
 *  situation the user may genuinely want a redundant advisory about). */
function findFilletJoints(sketch: Sketch): FilletJoint[] {
  let index: Map<string, SketchEntity>
  try {
    index = entityIndex(sketch)
  } catch {
    return [] // already validated in phase 1; never block on a re-map error
  }
  // Arc-endpoint <-> line-endpoint coincidences, keyed "arcId|lineId".
  const isEnd = (s: string): s is 'start' | 'end' => s === 'start' || s === 'end'
  const joined = new Map<string, { arcSite: 'start' | 'end'; lineSite: 'start' | 'end' }>()
  for (const c of sketch.constraints) {
    if (c.kind !== 'coincident') continue
    for (const [p, q] of [[c.a, c.b], [c.b, c.a]] as const) {
      const pe = index.get(p.entityId), qe = index.get(q.entityId)
      if (pe?.kind === 'arc' && qe?.kind === 'line' && isEnd(p.site) && isEnd(q.site)) {
        joined.set(`${p.entityId}|${q.entityId}`, { arcSite: p.site, lineSite: q.site })
      }
    }
  }
  const joints: FilletJoint[] = []
  for (const c of sketch.constraints) {
    if (c.kind !== 'tangent') continue
    const ae = index.get(c.a), be = index.get(c.b)
    const arcId = ae?.kind === 'arc' ? c.a : be?.kind === 'arc' ? c.b : null
    const lineId = ae?.kind === 'line' ? c.a : be?.kind === 'line' ? c.b : null
    if (!arcId || !lineId) continue
    const site = joined.get(`${arcId}|${lineId}`)
    if (!site) continue
    joints.push({
      tangentConstraintId: c.id, arcId, arcSite: site.arcSite, lineId, lineSite: site.lineSite,
    })
  }
  return joints
}

function benignFilletTangentIds(sketch: Sketch): Set<string> {
  return new Set(findFilletJoints(sketch).map((j) => j.tangentConstraintId))
}

// ---- SKC-77: fillet-joint DOF adjustment -----------------------------------
//
// Operator's report: fillet all 4 corners of a fully-defined 80x60 rectangle
// (H/V + coincident corners + 2 driving dims + the rectangle tool's own
// center-anchor rig) and the sketch flips to under-defined, even though every
// fillet got its own driving radius dimension exactly as promised.
//
// Root cause (verified against Operator's saved repro, coordination/evidence/
// SKC-77-FILLET-UNDEFINED/): each fillet JOINT (arc endpoint <-> line
// endpoint, tied by coincident + tangent, see findFilletJoints above) is
// GEOMETRICALLY well-posed — DogLeg always converges to the exact unique
// tangent point, never drifts — but is RANK-DEFICIENT in planegcs's raw
// dof() by exactly 1. This is a standard differential-geometry fact: a line
// and an arc that are tangent AT a point have PARALLEL tangent directions
// there, so the coincident's own linearization cannot distinguish "slide
// along the line" from "slide around the arc" to first order — the same
// phenomenon C5 (benignFilletTangentIds, above) already discounts from the
// "N redundant" advisory. That suppression only touched the advisory LIST;
// the separate DOF number (the "N DoF remain" header chip,
// SketchToolbox.tsx's SketchDefinitionChip, status.dof === 0) and the
// per-entity fullyDefinedEntities coloring were never adjusted, so a
// perfectly-determined filleted rectangle still reads "8 DoF" / paints its
// lines and arcs as under-defined — one phantom DOF per joint (4 corners x 2
// legs = 8, confirmed empirically on Operator's exact file).
//
// FIX (WO-1462, replacing SKC-77's grounding): for every DOF/definedness
// readout, swap each joint's tangent_la for the equivalent FIRST-ORDER
// well-posed form: the arc's radius line (center -> joint point) is
// perpendicular to the leg. With the coincident and arc_rules already putting
// the joint point on both the leg and the circle, "radius perpendicular to
// the leg at that point" IS tangency — same solution set — but sliding the
// point along the leg now changes the perpendicular's residual to first
// order, so the phantom DOF is gone and nothing else is touched.
// SKC-77 used to ground each joint point instead. That was exact only on an
// otherwise-anchored sketch: on a floating body, fixing a joint point also
// removed the body's REAL translation/rotation freedom, so an unanchored
// filleted rectangle read dof 0 and "fully defined" (BUG-392). The swap
// removes only the joint's own rank deficiency, whatever the anchor state.
// Applied uniformly to status.dof below and diagnoseDefinedEntities's
// baseline + probes so the two can never disagree.
function filletJointDiagnosticPrimitives(sketch: Sketch, prims: SketchPrimitive[]): SketchPrimitive[] {
  const joints = findFilletJoints(sketch)
  if (joints.length === 0) return prims // common fast path: no fillets at all
  const byTangent = new Map(joints.map((j) => [j.tangentConstraintId, j]))
  return prims.flatMap((p): SketchPrimitive[] => {
    const j = p.type === 'tangent_la' ? byTangent.get(p.id) : undefined
    if (!j) return [p]
    const radial = `${p.id}:fillet-radial`
    return [
      { id: radial, type: 'line', p1_id: `${j.arcId}:center`, p2_id: `${j.arcId}:${j.arcSite}` },
      { id: p.id, type: 'perpendicular_ll', l1_id: j.lineId, l2_id: radial },
    ]
  })
}

/** Re-measure dof with every fillet joint's rank-deficient DOF removed
 *  (see filletJointDiagnosticPrimitives above). Returns null when the sketch
 *  has no fillet joints at all (nothing to adjust — the caller keeps the raw
 *  value), so ordinary sketches pay zero extra cost. `solvedSketch` must
 *  already carry the SOLVED geometry (its entities are the post-solve
 *  coordinates) — the same convention diagnoseDefinedEntities uses. */
function adjustedFilletJointDof(wrapper: GcsWrapper, solvedSketch: Sketch): number | null {
  const joints = findFilletJoints(solvedSketch)
  if (joints.length === 0) return null
  const prims = filletJointDiagnosticPrimitives(solvedSketch, sketchToGcsPrimitives(solvedSketch))
  wrapper.clear_data()
  wrapper.push_primitives_and_params(prims)
  wrapper.solve(Algorithm.DogLeg)
  return wrapper.gcs.dof()
}

// T10: the geometry that a fillet RADIUS EDIT must be free to move — the
// fillet arc (its center/start/end points + its radius) and the tangency
// points it slides along its legs (the line endpoints joined to the arc by a
// coincident). The targeted parking pass (radius-edit path) pins every OTHER
// free DoF at its as-drawn spot (so the box does not grow) but leaves THESE
// free, so the driving radius dim can resize the fillet. Pinning these instead
// (the default full B23 pass does) is what reverted the resized arc — soft
// pins do not reliably yield to the hard radius dim over a large move.
function filletPinExclusions(sketch: Sketch): ParkExclusions {
  const points = new Set<string>()
  const radiusEntities = new Set<string>()
  let index: Map<string, SketchEntity>
  try {
    index = entityIndex(sketch)
  } catch {
    return { points, radiusEntities }
  }
  const isEnd = (s: string) => s === 'start' || s === 'end'
  // Per arc/line pair, the coincident-joined endpoint gcs ids (arc + line).
  const joinedEnds = new Map<string, Set<string>>()
  for (const c of sketch.constraints) {
    if (c.kind !== 'coincident') continue
    for (const [p, q] of [[c.a, c.b], [c.b, c.a]] as const) {
      const pe = index.get(p.entityId), qe = index.get(q.entityId)
      if (pe?.kind === 'arc' && qe?.kind === 'line' && isEnd(p.site) && isEnd(q.site)) {
        const key = `${p.entityId}|${q.entityId}`
        let s = joinedEnds.get(key)
        if (!s) { s = new Set(); joinedEnds.set(key, s) }
        s.add(`${p.entityId}:${p.site}`) // arc tangency endpoint
        s.add(`${q.entityId}:${q.site}`) // line tangency endpoint
      }
    }
  }
  for (const c of sketch.constraints) {
    if (c.kind !== 'tangent') continue
    const ae = index.get(c.a), be = index.get(c.b)
    const arcId = ae?.kind === 'arc' ? c.a : be?.kind === 'arc' ? c.b : null
    const lineId = ae?.kind === 'line' ? c.a : be?.kind === 'line' ? c.b : null
    if (!arcId || !lineId) continue
    const joined = joinedEnds.get(`${arcId}|${lineId}`)
    if (!joined) continue // tangent without endpoint coincident: not a fillet
    points.add(`${arcId}:center`)
    points.add(`${arcId}:start`)
    points.add(`${arcId}:end`)
    radiusEntities.add(arcId)
    for (const id of joined) points.add(id)
  }
  return { points, radiusEntities }
}

// The planegcs WASM ships a FIXED 16 MB heap (no ALLOW_MEMORY_GROWTH):
// one DogLeg solve of a system past roughly 210 entities (~420 params)
// aborts the whole module with OOM — measured against the BMG.dxf lift
// (340 entities, OOM) and synthetic slices (210 ok / 225 OOM). Documents
// that large are routinely INDEPENDENT subsystems though (a lifted import
// is one constraint island per loop), so above this budget the solve is
// partitioned by connected component and run as several small systems —
// mathematically identical (the giant system's matrix is block-diagonal
// across components). Kept WELL below the abort point for headroom.
const MAX_SOLVE_BATCH_ENTITIES = 150

/**
 * Full solve of a sketch on a caller-owned GcsWrapper (worker OR test).
 * NEVER fakes success: conflicts and non-convergence return ok:false with
 * the document untouched; the solution is only applied on a clean solve.
 *
 * Documents above MAX_SOLVE_BATCH_ENTITIES are solved per connected
 * component (batched back up to the budget); a SINGLE component above the
 * budget cannot be split and is attempted whole — it may still abort the
 * fixed-heap WASM (known planegcs build limit, fails loud either way).
 *
 * Definition diagnosis vs drag: temporary drag pins (planegcs tag -1) are
 * NOT document constraints, so the document's definition state CANNOT
 * change during a drag — but the dragged system's own dof IS reduced by
 * the pins (each independent pin equation consumes a freedom), which is
 * what made entities flash white mid-drag. Drag solves therefore skip the
 * definition diagnosis entirely and CARRY the pre-drag truth (dof +
 * fullyDefinedEntities) from the document's own solveStatus. If the
 * document was never solved (solveStatus null — open-solve still in
 * flight), the carried fields are unavailable: dof stays the dragged
 * system's (tainted) value and fullyDefinedEntities stays absent, which
 * the render layer treats as unknown (blue).
 */
export function solveSketchOnWrapper(
  wrapper: GcsWrapper, sketch: Sketch, drag?: DragRequest,
): SketchSolveOutcome {
  // INERT direct-edit resize: apply any DRIVING ellipse major/minor radius dim
  // to the entity BEFORE the solve (single choke point covering both the
  // single-system and partitioned paths). A no-op fast path when no such dim
  // exists, so un-dimensioned ellipses are byte-identical.
  sketch = applyInertEllipseDims(sketch)
  const skipDefinition = drag !== undefined
  const out = sketch.entities.length > MAX_SOLVE_BATCH_ENTITIES
    ? solvePartitioned(wrapper, sketch, drag, skipDefinition)
    : solveSystem(wrapper, sketch, drag, skipDefinition)
  if (drag && sketch.solveStatus !== null) {
    out.status.dof = sketch.solveStatus.dof
    out.status.fullyDefinedEntities = sketch.solveStatus.fullyDefinedEntities
  }
  return out
}

/** One planegcs system = one solve. The pre-partition behavior, verbatim
 *  apart from the optional B23 free-DoF parking pass.
 *
 *  parkFreeDof gates the B23 phase-2 refinement (see solveFreeDofParked). It
 *  is ON for the direct single-system solve (the normal finish/open/edit
 *  path, where drift is the user-visible bug) and OFF for per-batch solves
 *  inside solvePartitioned: a partitioned document only exists because it is
 *  too large for the fixed 16 MB planegcs heap, and the extra phase-2 solve
 *  per batch pushes the 340-entity BMG.dxf gate scene into WASM OOM. Large
 *  lifted imports therefore keep today's (un-parked) behavior; if the
 *  architect wants parking there too, the partitioned call below can pass
 *  true once the heap budget allows it. */
function solveSystem(
  wrapper: GcsWrapper, sketch: Sketch, drag?: DragRequest,
  skipDefinition = false, parkFreeDof = true,
): SketchSolveOutcome {
  let primitives: SketchPrimitive[]
  try {
    primitives = sketchToGcsPrimitives(
      sketch,
      drag?.targets.map((target) => target.point) ?? [],
    )
    if (drag) primitives.push(...dragPrimitives(sketch, drag))
  } catch (err) {
    if (err instanceof SketchMappingError) {
      // FAIL LOUD (ADR 0003): the solver never ran, so this status has NO
      // definition verdict — solveFailed marks it so no consumer renders
      // the placeholder dof 0 as "fully defined". The previous solve's
      // per-entity definition states still describe what is on screen
      // (geometry is untouched on failure) — carry them for coloring.
      return {
        ok: false, reason: 'invalid_sketch', message: err.message,
        status: {
          dof: 0, conflicting: [], redundant: [],
          fullyDefinedEntities: sketch.solveStatus?.fullyDefinedEntities,
          solveFailed: true, failureMessage: err.message,
        },
      }
    }
    throw err
  }

  // The wrapper accumulates state across solves; each solve starts clean
  // so deleted entities/constraints cannot haunt the network.
  wrapper.clear_data()
  wrapper.push_primitives_and_params(primitives)
  const result = wrapper.solve(Algorithm.DogLeg)

  const converged =
    result === GcsSolveStatus.Success || result === GcsSolveStatus.Converged

  const status: SolveStatus = {
    dof: wrapper.gcs.dof(),
    conflicting: toDocumentIds(wrapper.get_gcs_conflicting_constraints()),
    redundant: toDocumentIds(wrapper.get_gcs_redundant_constraints()),
  }

  // FALSE-POSITIVE conflict guard (fillet radius edit, ADR 0003 honored).
  // planegcs runs its conflict/redundant diagnosis on the constraint
  // Jacobian at the INITIAL geometry. A system that is only benignly
  // REDUNDANT (e.g. a fillet arc: tangent_la to each leg PLUS an endpoint
  // coincident to each leg is one constraint past minimal, so a tangent
  // reads as redundant) can be MISREPORTED as CONFLICTING when the solve
  // starts far from the solution — exactly what happens when the user
  // edits the driving radius dimension (geometry sits at the old radius,
  // the dim demands a new one). The DogLeg solve still CONVERGES to
  // geometry that satisfies every constraint; only the diagnosis lies.
  //
  // A TRUE conflict (e.g. width=40 and a second width dim=50 on the same
  // edge) does NOT converge — planegcs returns Failed and the geometry
  // never reaches the demanded value. So: when the solve converged but a
  // conflicting set was reported, RE-RUN the diagnosis seeded at the
  // SOLVED geometry (residuals ~0), where planegcs classifies redundant
  // vs conflicting correctly. True conflicts still don't converge there
  // and stay flagged; false positives clear. Non-drag only (drag never
  // edits dimensions and carries the document's pre-drag verdict anyway).
  let clearedFalseConflict = false
  if (!drag && converged && status.conflicting.length > 0) {
    try {
      wrapper.apply_solution()
      const solved = entitiesFromSolved(sketch, (id) => wrapper.sketch_index.get_primitive(id))
      const reprims = sketchToGcsPrimitives({ ...sketch, entities: solved })
      wrapper.clear_data()
      wrapper.push_primitives_and_params(reprims)
      wrapper.solve(Algorithm.DogLeg)
      status.dof = wrapper.gcs.dof()
      status.conflicting = toDocumentIds(wrapper.get_gcs_conflicting_constraints())
      status.redundant = toDocumentIds(wrapper.get_gcs_redundant_constraints())
      // The wrapper now holds the re-solve seeded AT the target geometry, so
      // the entity pull below is the authoritative result. The DEFAULT B23
      // parking pass is skipped on this path (its soft pins seed at the stale
      // pre-edit coords and can REVERT the resized fillet — soft pins do not
      // reliably yield to hard constraints when a large move is required).
      // T10 is handled instead by a TARGETED parking pass below that pins
      // only the OTHER (untouched) free geometry, never the edited fillet.
      clearedFalseConflict = status.conflicting.length === 0
    } catch {
      // Re-map/re-solve never validated here can only fail the way phase 1
      // already did; keep the first-pass status (never worse than today).
    }
  }

  // C5: drop the fillet/round tangents whose redundancy is benign by
  // construction (tangent_la + endpoint coincident per leg, one past minimal)
  // so the "N redundant (advisory)" banner is not spammed by every fillet.
  // Conflicts (true over-constraints) are unaffected — they are reported
  // through status.conflicting, never the redundant set.
  const benignTangents = benignFilletTangentIds(sketch)
  if (benignTangents.size > 0) {
    status.redundant = status.redundant.filter((id) => !benignTangents.has(id))
  }

  // Conflicts win over a numerically "successful" solve: planegcs can
  // converge while diagnosing an inconsistent subset, and presenting that
  // as success would silently drop the user's constraint (ADR 0003).
  if (status.conflicting.length > 0) {
    // Geometry stays at the last good solve, so the per-entity definition
    // states from that solve still describe what is on screen — carry them
    // (the conflicting constraints' entities render red on top).
    status.fullyDefinedEntities = sketch.solveStatus?.fullyDefinedEntities
    const message = `over-constrained: conflicting set [${status.conflicting.join(', ')}]`
    status.solveFailed = true
    status.failureMessage = message
    return { ok: false, reason: 'conflicting', message, status }
  }
  if (result !== GcsSolveStatus.Success && result !== GcsSolveStatus.Converged) {
    status.fullyDefinedEntities = sketch.solveStatus?.fullyDefinedEntities
    const message = `solver did not converge (status ${result})`
    status.solveFailed = true
    status.failureMessage = message
    return { ok: false, reason: 'solver_failed', message, status }
  }

  wrapper.apply_solution()
  let entities = entitiesFromSolved(sketch, (id) => wrapper.sketch_index.get_primitive(id))

  // B23 free-DoF parking (non-drag, under-defined only). Phase 1 above is the
  // AUTHORITATIVE solve: it owns the status/conflict/dof verdict and feeds the
  // definition diagnosis below, UNPERTURBED by any pin. But phase 1 has a
  // null-space, so DogLeg can satisfy the constraints by walking the FREE DoF
  // off where the user drew (~0.138 mm in B23). Phase 2 re-solves the SAME
  // hard system seeded at the ORIGINAL as-drawn coords plus soft pins
  // (coordinate_x/y, tag -1) that park every free point where it was drawn.
  // Tag -1 is lower priority than the real constraints, so hard constraints
  // still win; the pins only pick the minimal-movement point of the
  // null-space. If phase 2 fails to converge (e.g. a freshly applied
  // constraint demands a large move that fights the full pin set), we KEEP
  // phase 1's geometry — never worse than today's behavior.
  // The definition diagnosis below re-pushes its OWN primitives
  // (sketchToGcsPrimitives, no pins) on a cleared wrapper, so phase 2's pinned
  // wrapper state cannot leak into it — requirement: diagnosis stays on the
  // authoritative system.
  if (!drag && parkFreeDof && status.dof > 0 && !clearedFalseConflict) {
    // WO-1866: with a continuity constraint in the sketch, planegcs's soft-pin
    // pass started from the as-drawn coords stalls ("Converged") without ever
    // meeting the hard joint equations -- measured against a grounded arc, it
    // handed back the untouched drawing. Start it from phase 1's solution,
    // which already meets them, and keep phase 1 if the joint still breaks.
    const continuity = sketch.constraints.some(isContinuity)
    const refined = solveFreeDofParked(wrapper, sketch, undefined, continuity ? entities : undefined)
    if (refined && !(continuity && continuityViolations(sketch, refined).length > 0)) entities = refined
  }

  // T10 (radius-edit path): the default pass above is skipped because its full
  // pin set reverts the resized fillet. Run a TARGETED pass instead that pins
  // every free DoF EXCEPT the fillet being resized (its arc points + radius +
  // the tangency points it slides along its legs). This holds the rest of the
  // sketch — e.g. a box's free corners — at its as-drawn spot so a bigger
  // fillet does not grow the box, while the driving radius dim still resizes
  // the fillet (the excluded geometry carries no competing soft pin). Falls
  // back to phase 1 (today's behavior) if it does not converge.
  if (!drag && parkFreeDof && status.dof > 0 && clearedFalseConflict) {
    const refined = solveFreeDofParked(wrapper, sketch, filletPinExclusions(sketch), entities)
    if (refined) entities = refined
  }

  // PlaneGCS has no ellipse/spline primitive. Reconstruct their durable
  // native-curve fillet joints from the solved host geometry and radius.
  entities = reconcileCurveFillets(entities)

  // WO-1460: planegcs's "success" is a NUMERICAL verdict about the system,
  // not a GEOMETRIC one about the shape it produced. Constraints whose
  // parameters are all grounded drop out of the Jacobian (H + whole-line Fix
  // + V converges untouched, V unmet), and a free line can satisfy parallel
  // AND perpendicular by collapsing to zero length. Re-check the closed-form
  // kinds on the solved geometry and fail exactly like a reported conflict,
  // so every caller's reject/restore path handles it.
  if (!drag) {
    const invalid = validateSolvedGeometry(sketch, entities)
    if (invalid) {
      status.conflicting = invalid.conflicting
      status.fullyDefinedEntities = sketch.solveStatus?.fullyDefinedEntities
      status.solveFailed = true
      status.failureMessage = invalid.message
      return { ok: false, reason: 'conflicting', message: invalid.message, status }
    }
  }

  if (!skipDefinition) {
    // SKC-77: correct the REPORTED dof for the same benign fillet-joint rank
    // deficiency diagnoseDefinedEntities discounts below, so the "N DoF"
    // header chip (SketchToolbox.tsx SketchDefinitionChip, status.dof === 0)
    // can never disagree with the per-entity coloring it drives. Returns
    // null (no-op) on a sketch with no fillet joints — zero cost for the
    // overwhelming majority of solves. Safe to re-measure freely here: the
    // wrapper's solved geometry was already pulled into `entities` above,
    // nothing downstream reads the wrapper's own live state.
    if (status.dof > 0) {
      const adjusted = adjustedFilletJointDof(wrapper, { ...sketch, entities })
      if (adjusted !== null) status.dof = Math.max(0, adjusted)
    }
    if (status.dof === 0) {
      // dof === 0 means NO free parameter exists anywhere in the system, so
      // every entity is fully determined — the probe loop would only confirm
      // it at n extra solves.
      status.fullyDefinedEntities = sketch.entities.map((e) => e.id)
    } else {
      // dof > 0: the exact per-entity diagnosis is O(N) full solves. But the
      // definedness classification is STRUCTURAL — it depends only on the
      // constraint graph (which entities/constraints/dims exist and what they
      // reference), NEVER on dimension values or geometry coordinates. So when
      // the sketch TOPOLOGY is unchanged (a value edit, or a drag that came
      // through as a full solve), reuse the cached result and SKIP the probe
      // loop; only a structural edit recomputes it. Geometry output is
      // unaffected either way — `entities` was already applied above.
      const sig = sketchTopologySignature(sketch)
      if (sig === cachedDefinednessSig && cachedDefinednessResult !== null) {
        // Hand out a copy so a downstream mutation can never corrupt the cache.
        status.fullyDefinedEntities = [...cachedDefinednessResult]
      } else {
        const defined = diagnoseDefinedEntities(wrapper, { ...sketch, entities })
        cachedDefinednessSig = sig
        cachedDefinednessResult = defined
        status.fullyDefinedEntities = defined
      }
    }
  }
  return { ok: true, entities, status }
}

// ---- Post-solve geometric validation (WO-1460) ------------------------------

/** A line shorter than this has no defined direction (the sketcher's 0.01mm
 *  length convention). */
const DEGENERATE_LENGTH_MM = 0.01
/** Positional residual (mm) a closed-form constraint may keep after a
 *  converged solve. planegcs converges on a squared error of 1e-10, i.e.
 *  residuals near 1e-5; this sits one decade looser so no genuine solve is
 *  refused, and still far below any visible violation. */
const RESIDUAL_TOL_MM = 1e-4
/** Directional residual: sine (parallel) or cosine (perpendicular) of the
 *  angle between the two unit directions. */
const RESIDUAL_TOL_DIR = 1e-4

function lineLength(l: { start: Vec2; end: Vec2 }): number {
  return Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y)
}

/** Constraint kinds whose truth is a direct coordinate/direction comparison,
 *  mapped to the LINE entity ids they give a direction to. Block orientation
 *  operands are not line entities and are skipped. */
function directionalLineIds(c: SketchConstraint, index: Map<string, SketchEntity>): string[] {
  const lines = (ids: (string | undefined)[]): string[] =>
    ids.filter((id): id is string => id !== undefined && index.get(id)?.kind === 'line')
  switch (c.kind) {
    case 'horizontal':
    case 'vertical': return lines([c.line])
    case 'parallel':
    case 'perpendicular':
    case 'collinear': return lines([c.a, c.b])
    default: return []
  }
}

/** Independently re-derive "does this result actually hold" for the cheap,
 *  closed-form constraint kinds. Returns null when the solved geometry is
 *  valid; otherwise the offending constraint ids (plus the other constraints
 *  holding the same lines, so a reject notice names what it fought) and a
 *  message naming the offender. */
/** WO-1866: continuity constraints the solved geometry does NOT meet -- joint
 *  gap, direction (never a cusp) and, for G2, the curvature vector -- each
 *  measured on the entities themselves, never on the solver's own report. */
function continuityViolations(sketch: Sketch, solved: SketchEntity[]): string[] {
  const now = new Map(solved.map((e) => [e.id, e] as const))
  const out: string[] = []
  for (const c of sketch.constraints) {
    if (!isContinuity(c)) continue
    const a = now.get(c.a.entityId), b = now.get(c.b.entityId)
    const [sRef, nRef] = isOpenControlSpline(a) ? [c.a, c.b] : [c.b, c.a]
    const sp = now.get(sRef.entityId), nb = now.get(nRef.entityId)
    if (!isOpenControlSpline(sp) || !nb || !b) continue
    const end = continuityEnd(sp, sRef.site)
    const other = continuityEnd(nb, nRef.site)
    if (!end || !other) continue
    const gap = Math.hypot(end.at.x - other.at.x, end.at.y - other.at.y)
    // The spline LEAVES the joint the way the neighbour ARRIVES at it.
    const cross = end.leave.x * other.leave.y - end.leave.y * other.leave.x
    const dot = end.leave.x * other.leave.x + end.leave.y * other.leave.y
    let bad = gap > RESIDUAL_TOL_MM || dot > 0 || Math.abs(cross) > RESIDUAL_TOL_DIR
    if (!bad && c.kind === 'continuity_g2') {
      const dk = Math.hypot(end.k.x - other.k.x, end.k.y - other.k.y)
      bad = dk > RESIDUAL_TOL_DIR * Math.hypot(other.k.x, other.k.y) + 1e-7
    }
    if (bad) out.push(c.id)
  }
  return out
}

/** Joint facts of one curve end: position, unit direction pointing INTO the
 *  curve, and curvature vector (toward the centre of curvature). */
function continuityEnd(e: SketchEntity, site: PointSite): { at: Vec2; leave: Vec2; k: Vec2 } | null {
  const unit = (v: Vec2): Vec2 => { const l = Math.hypot(v.x, v.y) || 1; return { x: v.x / l, y: v.y / l } }
  if (e.kind === 'line' && (site === 'start' || site === 'end')) {
    const at = site === 'start' ? e.start : e.end
    const far = site === 'start' ? e.end : e.start
    return { at, leave: unit({ x: far.x - at.x, y: far.y - at.y }), k: { x: 0, y: 0 } }
  }
  if (e.kind === 'arc' && (site === 'start' || site === 'end')) {
    const t = site === 'start' ? e.startAngle : e.endAngle
    const at = { x: e.center.x + e.radius * Math.cos(t), y: e.center.y + e.radius * Math.sin(t) }
    const ccw = { x: -Math.sin(t), y: Math.cos(t) }
    const r2 = e.radius * e.radius
    return { at, leave: site === 'start' ? ccw : { x: -ccw.x, y: -ccw.y },
      k: { x: (e.center.x - at.x) / r2, y: (e.center.y - at.y) / r2 } }
  }
  if (isOpenControlSpline(e) && (site === 'start' || site === 'end')) {
    const n = e.points.length
    const i0 = site === 'start' ? 0 : n - 1, i1 = site === 'start' ? 1 : n - 2
    const at = e.points[i0]
    const leave = unit({ x: e.points[i1].x - at.x, y: e.points[i1].y - at.y })
    // Signed curvature is taken travelling start -> end; its left normal is
    // (-t.y, t.x) with t that travel direction.
    const t = site === 'start' ? leave : { x: -leave.x, y: -leave.y }
    const k = controlSplineCurvatureAt(e.points, site === 'start' ? 0 : n - 1)
    return { at, leave, k: { x: -t.y * k, y: t.x * k } }
  }
  return null
}

function validateSolvedGeometry(
  before: Sketch, solved: SketchEntity[],
): { conflicting: string[]; message: string } | null {
  const was = entityIndex(before)
  const now = new Map(solved.map((e) => [e.id, e] as const))
  const offenders: string[] = []
  const reasons: string[] = []
  const pointAt = (ref: PointRef): Vec2 | null => {
    const e = now.get(ref.entityId)
    if (!e) return null
    const id = gcsPointId(now, ref, 'validation')
    return entityPoints(e, true).find((p) => p.id === id)?.at ?? null
  }
  const asLine = (id: string) => {
    const e = now.get(id)
    return e && e.kind === 'line' ? e : null
  }
  for (const c of before.constraints) {
    const lineIds = directionalLineIds(c, now)
    // 1. Degeneracy: a line that had a direction before the solve and lost it.
    const collapsed = lineIds.find((id) => {
      const prev = was.get(id)
      const next = asLine(id)
      return prev?.kind === 'line' && next !== null &&
        lineLength(prev) >= DEGENERATE_LENGTH_MM && lineLength(next) < DEGENERATE_LENGTH_MM
    })
    if (collapsed) {
      offenders.push(c.id)
      reasons.push(`${c.kind} '${c.id}' collapsed line '${collapsed}' to zero length`)
      continue
    }
    // 2. Residual on the solved geometry. Lines already shorter than the
    // degeneracy length have no direction to check.
    const [la, lb] = lineIds.map(asLine)
    const directed = lineIds.length > 0 &&
      lineIds.every((id) => { const l = asLine(id); return l !== null && lineLength(l) >= DEGENERATE_LENGTH_MM })
    let violated = false
    switch (c.kind) {
      case 'horizontal':
      case 'vertical': {
        const axis = c.kind === 'horizontal' ? 'y' : 'x'
        if (c.line) {
          if (la && directed) violated = Math.abs(la.end[axis] - la.start[axis]) > RESIDUAL_TOL_MM
        } else if (c.points) {
          const p = pointAt(c.points[0])
          const q = pointAt(c.points[1])
          if (p && q) violated = Math.abs(q[axis] - p[axis]) > RESIDUAL_TOL_MM
        }
        break
      }
      case 'continuity_g1':
      case 'continuity_g2':
        violated = continuityViolations({ ...before, constraints: [c] }, solved).length > 0
        break
      case 'parallel':
      case 'perpendicular':
      case 'collinear': {
        if (!la || !lb || !directed || lineIds.length !== 2) break
        const ax = la.end.x - la.start.x, ay = la.end.y - la.start.y
        const bx = lb.end.x - lb.start.x, by = lb.end.y - lb.start.y
        const norm = lineLength(la) * lineLength(lb)
        if (c.kind === 'perpendicular') {
          violated = Math.abs(ax * bx + ay * by) / norm > RESIDUAL_TOL_DIR
        } else {
          violated = Math.abs(ax * by - ay * bx) / norm > RESIDUAL_TOL_DIR
        }
        if (!violated && c.kind === 'collinear') {
          // Same infinite line: b's endpoints sit on a's line.
          const off = (p: Vec2) => Math.abs((p.x - la.start.x) * ay - (p.y - la.start.y) * ax) / lineLength(la)
          violated = off(lb.start) > RESIDUAL_TOL_MM || off(lb.end) > RESIDUAL_TOL_MM
        }
        break
      }
    }
    if (violated) {
      offenders.push(c.id)
      reasons.push(`${c.kind} '${c.id}' is not satisfied by the solved geometry`)
    }
  }
  if (offenders.length === 0) return null
  // Name the constraints the offender fought: the other directional/fix
  // constraints holding the same entities.
  const offenderSet = new Set(offenders)
  const touched = new Set(before.constraints
    .filter((c) => offenderSet.has(c.id))
    .flatMap(constraintRefIds))
  const partners = before.constraints
    .filter((c) => !offenderSet.has(c.id) &&
      (c.kind === 'fix' || directionalLineIds(c, now).length > 0 ||
        ((c.kind === 'horizontal' || c.kind === 'vertical') && c.points !== undefined)) &&
      constraintRefIds(c).some((id) => touched.has(id)))
    .map((c) => c.id)
  return {
    conflicting: [...offenders, ...partners],
    message: `over-constrained: ${reasons.join('; ')}`,
  }
}

// ---- Exact per-entity definition diagnosis (fix-probe) ---------------------
//
// WHAT PLANEGCS EXPOSES (investigated 1.1.7, Stage 4): system-level dof(),
// conflicting/redundant/partially-redundant constraint ids, and per-pushed-
// param get_is_fixed(i) — which only echoes the fixed flag WE pushed.
// The GCS system has per-parameter dependency diagnosis
// (getDependentParams / hasDiagnosis pdiagnoselist), but the planegcs WASM
// bindings do NOT export it (verified against dist/planegcs_dist/
// gcs_system.d.ts and the emscripten glue — no 'dependent' symbol exists).
//
// THE PROBE (exact, never a heuristic): an entity is fully defined iff
// grounding ALL of its parameters at their solved values does not change
// the system's dof. Grounding a parameter removes it from the unknowns;
// if it was DETERMINED (no null-space component), one equation turns
// redundant and rank drops with it -> dof unchanged. If it was FREE, rank
// is unaffected -> dof drops. This is standard rank arithmetic on the
// constraint Jacobian, evaluated by the SAME planegcs diagnosis that
// produces the headline dof — so the per-entity answer can never disagree
// with the whole-sketch answer. Values are grounded at the exact solved
// coordinates, so a probe can introduce redundancy but never a conflict.
//
// Grounding per entity kind mirrors collectFixedPointIds (whole-entity
// fix): all owned gcs points fixed; a circle additionally pins its radius
// (a bare param with no fixed flag through the wrapper); an arc's radius/
// angles are determined by its three fixed points through arc_rules.
//
// COST: one diagnosis solve per entity (plus one baseline), each starting
// AT the solution (zero residual, converges immediately). Runs only on
// clean full solves with dof > 0 — never during drag streams.
function diagnoseDefinedEntities(
  wrapper: GcsWrapper, solvedSketch: Sketch,
): string[] {
  // SKC-77 / WO-1462: remove every fillet joint's phantom DOF FIRST, so the
  // baseline below (and every per-entity probe, which maps over `prims`)
  // already discounts it — a fillet arc/host line is otherwise wrongly
  // reported as "not fully defined" purely from the benign tangent+
  // coincident redundancy (filletJointDiagnosticPrimitives doc comment above
  // has the full derivation). No-ops (returns `prims` unchanged) on a sketch
  // with no fillet joints.
  const prims = filletJointDiagnosticPrimitives(solvedSketch, sketchToGcsPrimitives(solvedSketch))

  // Baseline dof measured on the SAME push the probes modify (geometry at
  // the solution) — not assumed equal to the caller's status.dof.
  wrapper.clear_data()
  wrapper.push_primitives_and_params(prims)
  wrapper.solve(Algorithm.DogLeg)
  const baseDof = wrapper.gcs.dof()

  const defined: string[] = []
  for (const e of solvedSketch.entities) {
    // Ground every gcs point the entity owns ('e' itself for point
    // entities, 'e:site' otherwise; ':' never appears inside an id).
    const probe: SketchPrimitive[] = prims.map((p) =>
      p.type === 'point' &&
        (p.id === e.id || p.id.startsWith(`${e.id}:`)) &&
        !(e.kind === 'line' && p.id === `${e.id}:center`)
        ? { ...p, fixed: true }
        : p,
    )
    if (e.kind === 'circle') {
      probe.push({ id: '__probe:radius', type: 'circle_radius', c_id: e.id, radius: e.radius })
    }
    wrapper.clear_data()
    wrapper.push_primitives_and_params(probe)
    const r = wrapper.solve(Algorithm.DogLeg)
    if (r !== GcsSolveStatus.Success && r !== GcsSolveStatus.Converged) {
      // Cannot verify -> never CLAIM defined (the safe direction is blue).
      console.warn(`[gcsMapping] definition probe did not converge for entity '${e.id}' (status ${r})`)
      continue
    }
    if (wrapper.gcs.dof() === baseDof) defined.push(e.id)
  }
  return defined
}

// ---- Definedness cache (topology-keyed) ------------------------------------
//
// diagnoseDefinedEntities is O(N) full solves per user solve, which reaches
// seconds on a moderately large sketch. But its RESULT is purely STRUCTURAL:
// which entities are fully defined depends only on the constraint graph (the
// set of entity ids + kinds, and the set of constraint/dimension ids + kinds +
// the point/entity refs each one targets, plus whether a dimension is
// driving). It does NOT depend on any dimension VALUE or geometry coordinate.
// So a value edit or a drag (same topology) yields the SAME definedness, and
// we can cache it: recompute only when the topology signature changes
// (add/remove entity, add/remove/retarget a constraint, add/remove a
// dimension, toggle a dim driving/reference, or a sketch switch — the sketch
// id is part of the signature so one sketch's cache is never reused for
// another). The signature is recomputed from the document on every solve, so
// invalidation is automatic: any topology-affecting field it captures forces a
// miss. The solve itself and the geometry output are untouched — only the
// diagnosis loop is skipped on a hit.
//
// EDGE CASE (documented, intentionally NOT handled): in a rare value-dependent
// singular configuration a value change could in principle flip definedness
// WITHOUT any topology change (e.g. a constraint that becomes redundant only
// at one exact value). With this cache the coloring would not refresh until
// the next structural edit. This is acceptable — it matches how mainstream CAD
// updates definedness on structural edits — and we deliberately do not try to
// detect it (detection would cost the very O(N) loop the cache removes).
let cachedDefinednessSig: string | null = null
let cachedDefinednessResult: string[] | null = null

function pointRefSig(r: PointRef): string {
  return `${r.entityId}.${r.site}`
}

/** Structural (value-free) reference fingerprint of a constraint. Constraints
 *  carry NO numeric value — every field is a reference — so the full ref set
 *  (including point sites) is captured. */
function constraintRefSig(c: SketchConstraint): string {
  switch (c.kind) {
    case 'coincident':
    case 'continuity_g1':
    case 'continuity_g2':   return `${pointRefSig(c.a)}~${pointRefSig(c.b)}`
    case 'concentric':
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
    case 'tangent':
    case 'equal':           return `${c.a}~${c.b}`
    case 'horizontal':
    case 'vertical':        return c.line
      ? `L:${c.line}`
      : `P:${(c.points ?? []).map(pointRefSig).join('~')}`
    case 'midpoint':        return `${pointRefSig(c.point)}~${c.line}`
    case 'symmetric':       return `${pointRefSig(c.a)}~${pointRefSig(c.b)}~${c.axis}`
    case 'fix':             return c.point ? `P:${pointRefSig(c.point)}` : `E:${c.entityId ?? ''}`
    case 'point_on_object': return `${pointRefSig(c.point)}~${c.object}`
    case 'pierce':          return `${pointRefSig(c.point)}~${c.source.bodyId}|${c.source.stableId}`
  }
}

/** Structural (value-free) reference fingerprint of a dimension — its refs and
 *  sites, EXCLUDING the numeric value and the display-only label anchor. The
 *  driving flag is captured separately by the caller (a reference dim removes
 *  no DoF, so it changes definedness). */
function dimensionRefSig(d: SketchDimension): string {
  switch (d.kind) {
    case 'distance':
    case 'distanceX':
    case 'distanceY':   return `${pointRefSig(d.a)}~${pointRefSig(d.b)}`
    // The AXIS is part of an ordinate's structure, not its value: an X and a Y
    // ordinate on the same datum/point pair are different equations and remove
    // different freedoms, so they must not share a topology signature.
    case 'ordinate':    return `${pointRefSig(d.origin)}~${pointRefSig(d.point)}~${d.axis}`
    case 'distancePL':  return `${pointRefSig(d.point)}~${d.line}`
    case 'angle3':      return `${pointRefSig(d.vertex)}~${pointRefSig(d.a)}~${pointRefSig(d.b)}`
    case 'angle':       return `${d.a}~${d.b}`
    case 'radius':
    case 'diameter':
    case 'arcLength':
    case 'majorRadius':
    case 'minorRadius':
    case 'focusDistance':
    case 'd1xd2':         return d.entityId
  }
}

/**
 * Cheap, stable topology signature of a sketch: the sketch id plus the sorted
 * set of {entity id:kind}, {constraint id:kind:refs}, and {dimension
 * id:kind:driving:refs}. EXCLUDES every numeric value, coordinate, and
 * display-only field. Two sketches with the same signature have identical
 * per-entity definedness (see the cache note above). Sorted so array
 * reordering (which does not change definedness) does not force a miss.
 */
export function sketchTopologySignature(sketch: Sketch): string {
  const ents = sketch.entities.map((e) => `${e.id}:${e.kind}`).sort()
  const cons = sketch.constraints
    .map((c) => `${c.id}:${c.kind}:${constraintRefSig(c)}`).sort()
  const dims = sketch.dimensions
    .map((d) => `${d.id}:${d.kind}:${d.driving ? 'D' : 'R'}:${dimensionRefSig(d)}`).sort()
  return `#${sketch.id}|E:${ents.join(',')}|C:${cons.join(',')}|D:${dims.join(',')}`
}

// ---- Partitioned solve (fixed-WASM-heap workaround) -----------------------

/** Connected components of the constraint graph (entities = nodes,
 *  constraints/dimensions = hyperedges), as disjoint entity-id sets. */
function connectedComponents(sketch: Sketch): Set<string>[] {
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let r = x
    while (parent.get(r) !== r) r = parent.get(r)!
    parent.set(x, r)
    return r
  }
  for (const e of sketch.entities) parent.set(e.id, e.id)
  const union = (ids: string[]) => {
    // Ids not in the document are NOT unioned here — the per-batch mapping
    // throws SketchMappingError on them (fail loud preserved, ADR 0003).
    const present = ids.filter((id) => parent.has(id))
    for (let i = 1; i < present.length; i++) {
      const a = find(present[0]), b = find(present[i])
      if (a !== b) parent.set(a, b)
    }
  }
  for (const c of sketch.constraints) union(constraintRefIds(c))
  for (const d of sketch.dimensions) union(dimensionRefIds(d))

  const byRoot = new Map<string, Set<string>>()
  for (const e of sketch.entities) {
    const r = find(e.id)
    let s = byRoot.get(r)
    if (!s) { s = new Set(); byRoot.set(r, s) }
    s.add(e.id)
  }
  return [...byRoot.values()]
}

/**
 * Solve a large document as independent connected components, greedily
 * batched back up to MAX_SOLVE_BATCH_ENTITIES per planegcs system (a batch
 * of unrelated components is block-diagonal — same math, fewer solves).
 * Outcomes merge exactly as the single giant system would report them:
 * dof sums, conflicting/redundant union, any failed batch fails the whole
 * solve with the document untouched.
 */
function solvePartitioned(
  wrapper: GcsWrapper, sketch: Sketch, drag?: DragRequest,
  skipDefinition = false,
): SketchSolveOutcome {
  // Largest-first first-fit packing.
  const components = connectedComponents(sketch)
    .sort((a, b) => b.size - a.size)
  const batches: Set<string>[] = []
  for (const comp of components) {
    const host = batches.find((b) => b.size + comp.size <= MAX_SOLVE_BATCH_ENTITIES)
    if (host) { comp.forEach((id) => host.add(id)) }
    else batches.push(new Set(comp))
  }

  // Every constraint/dimension must land in exactly one batch; one whose
  // references span no single batch is dangling (unknown entity id) and
  // must FAIL the solve, not silently vanish (ADR 0003).
  const inBatch = (ids: string[], b: Set<string>) => ids.every((id) => b.has(id))
  const unassigned = [
    ...sketch.constraints.filter((c) => !batches.some((b) => inBatch(constraintRefIds(c), b))),
    ...sketch.dimensions.filter((d) => !batches.some((b) => inBatch(dimensionRefIds(d), b))),
  ]
  if (unassigned.length > 0) {
    const message = `constraint '${unassigned[0].id}' references an unknown entity id`
    return {
      ok: false, reason: 'invalid_sketch', message,
      // solveFailed: no definition verdict here (same contract as the
      // single-system mapping-failure path); previous states carried.
      status: {
        dof: 0, conflicting: [], redundant: [],
        fullyDefinedEntities: sketch.solveStatus?.fullyDefinedEntities,
        solveFailed: true, failureMessage: message,
      },
    }
  }

  const solvedById = new Map<string, SketchEntity>()
  const merged: SolveStatus = { dof: 0, conflicting: [], redundant: [] }
  // Per-batch definition lists concatenate to exactly the giant system's
  // answer: batches are independent subsystems (block-diagonal Jacobian),
  // so a parameter's freedom is decided entirely within its own batch.
  const definedLists: string[][] = []
  let failed: Extract<SketchSolveOutcome, { ok: false }> | null = null

  for (const batch of batches) {
    const sub: Sketch = {
      ...sketch,
      entities: sketch.entities.filter((e) => batch.has(e.id)),
      constraints: sketch.constraints.filter((c) => inBatch(constraintRefIds(c), batch)),
      dimensions: sketch.dimensions.filter((d) => inBatch(dimensionRefIds(d), batch)),
    }
    const subDrag = drag
      ? { targets: drag.targets.filter((t) => batch.has(t.point.entityId)) }
      : undefined
    const out = solveSystem(
      wrapper, sub, subDrag && subDrag.targets.length > 0 ? subDrag : undefined,
      skipDefinition, false, // parkFreeDof OFF: extra phase-2 solve OOMs the heap (B23 note)
    )
    merged.dof += out.status.dof
    merged.conflicting.push(...out.status.conflicting)
    merged.redundant.push(...out.status.redundant)
    if (out.ok) {
      for (const e of out.entities) solvedById.set(e.id, e)
      if (out.status.fullyDefinedEntities) definedLists.push(out.status.fullyDefinedEntities)
    } else if (!failed || (failed.reason !== 'conflicting' && out.reason === 'conflicting')) {
      failed = out // conflicts win in the merged report, like the giant system
    }
  }

  if (failed) {
    // Geometry stays at the last good solve (same as the single-system
    // failure path): carry that solve's definition states wholesale; the
    // partial batch lists describe a mixed state nothing renders.
    merged.fullyDefinedEntities = sketch.solveStatus?.fullyDefinedEntities
    merged.solveFailed = true
    merged.failureMessage = failed.message
    return { ok: false, reason: failed.reason, message: failed.message, status: merged }
  }
  if (!skipDefinition) merged.fullyDefinedEntities = definedLists.flat()
  return {
    ok: true,
    entities: sketch.entities.map((e) => solvedById.get(e.id) ?? e),
    status: merged,
  }
}
