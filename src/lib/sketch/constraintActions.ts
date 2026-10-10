// Constraint buttons -> selection operands (Stage 4, PLAN 3.4/3.5).
//
// PURE planning layer: given the current document and the selected ids,
// decide per constraint kind whether the selection is a VALID operand set
// and, when it is, build the exact constraint objects a click creates.
// The toolbox calls this to enable/disable buttons (the reason string is
// the disabled tooltip), the store calls it again on click — one rule
// set, no UI/store divergence.
//
// SELECTION MODEL (documented rule): raw ids are selected ENTITIES
// (selected constraint/dimension ids are ignored — they are navigation,
// not operands); encoded center ids are explicit PointRef operands.
// Point-level operands on raw ids keep the historical UNAMBIGUOUS
// implied-point behavior:
//   - point entity  -> its own location ('self')
//   - circle        -> its center (the only point site it has)
//   - line/arc      -> NO implied point (start/end/center would be a
//                      guess); select the visible center node explicitly

import type {
  Sketch, SketchEntity, SketchConstraint, SketchConstraintKind, PointRef, Vec2,
} from './types'
import { constraintRefIds, dimensionRefIds } from './refIds'
import {
  centerRefForEntity,
  decodePointSelectionRef,
} from './centerReferences'
import { entityLabels } from './browserModel'

export type ConstraintPlanResult =
  | { ok: true; constraints: SketchConstraint[] }
  | { ok: false; reason: string }

const newId = () => crypto.randomUUID()

function invalid(reason: string): ConstraintPlanResult {
  return { ok: false, reason }
}

/** Unambiguous implied point of an entity, or null (see header). */
function impliedPoint(e: SketchEntity): PointRef | null {
  if (e.kind === 'point') return { entityId: e.id, site: 'self' }
  if (e.kind === 'circle') return { entityId: e.id, site: 'center' }
  return null
}

/** Human label for notices/tooltips ('point_on_object' -> 'Point on
 *  object'). Accepts dimension kinds too (conflict-set naming). */
export function constraintKindLabel(kind: string): string {
  if (kind === 'arcLength') return 'Arc length'
  if (kind === 'd1xd2') return 'D1 x D2'
  if (kind === 'continuity_g1') return 'Tangent continuity (G1)'
  if (kind === 'continuity_g2') return 'Curvature continuity (G2)'
  const text = kind.replace(/_/g, ' ')
  return text.charAt(0).toUpperCase() + text.slice(1)
}

export function planConstraintForSelection(
  sketch: Sketch, selectedIds: string[], kind: SketchConstraintKind,
): ConstraintPlanResult {
  // Selection operands retain click order. A virtual center key resolves to
  // an explicit PointRef; raw entity ids preserve the historical implied-point
  // behavior for standalone points and circles.
  const byId = new Map(sketch.entities.map((e) => [e.id, e]))
  const operands = selectedIds.flatMap((id) => {
    const pointRef = decodePointSelectionRef(id)
    if (pointRef) {
      const entity = byId.get(pointRef.entityId)
      if (!entity) return []
      const valid = pointRef.site === 'center'
        ? centerRefForEntity(entity) !== null
        : (pointRef.site === 'start' || pointRef.site === 'end')
          && (entity.kind === 'line' || entity.kind === 'arc')
      if (!valid) return []
      return [{ entity, point: pointRef, whole: false }]
    }
    const entity = byId.get(id)
    return entity ? [{ entity, point: impliedPoint(entity), whole: true }] : []
  })
  const ents = operands.filter((operand) => operand.whole).map((operand) => operand.entity)

  const lines = ents.filter((e) => e.kind === 'line')
  const curves = ents.filter((e) => e.kind === 'circle' || e.kind === 'arc')
  // Operands that carry a DIRECTION for angular constraints: real lines plus a
  // block's solver-owned orientation line (SKC-ROTATION-SOLVABLE). Used only by
  // horizontal/vertical/parallel/perpendicular; collinear stays lines-only.
  const orientables = ents.filter((e) => e.kind === 'line' || e.kind === 'block')
  const points = operands
    .map((operand) => operand.point)
    .filter((p): p is PointRef => p !== null)
  const pointKeys = points.map((point) => `${point.entityId}:${point.site}`)
  const hasRepeatedPoint = new Set(pointKeys).size !== pointKeys.length
  const mixedCenterOwner = operands.some((operand) =>
    !operand.whole && operand.point?.site === 'center' &&
    operands.some((candidate) =>
      candidate.whole && candidate.entity.id === operand.entity.id))
  const sameOwnerPair = operands.length === 2 &&
    operands[0].entity.id === operands[1].entity.id

  // Refuse redundant same-logical-owner plans before any constraint object is
  // minted. The solver must never be asked to diagnose combinations the
  // selection planner can identify exactly by owner and point site.
  if (kind === 'fix' && mixedCenterOwner) {
    return invalid('cannot fix both a center and its owning entity')
  }
  if (kind === 'concentric' && sameOwnerPair) {
    return invalid('cannot make an entity concentric with itself')
  }
  if (kind === 'point_on_object' && sameOwnerPair &&
      operands.some((operand) => !operand.whole && operand.point)) {
    return invalid('cannot place a point on its own object')
  }
  if (mixedCenterOwner) {
    return invalid('cannot constrain the same point through a center and its owning entity')
  }
  if (hasRepeatedPoint) {
    return invalid('cannot constrain the same point to itself')
  }

  switch (kind) {
    case 'horizontal':
    case 'vertical': {
      // One constraint per selected line OR block orientation, or the two-point
      // variant. SKC-ROTATION-SOLVABLE: a horizontal/vertical on a block pins
      // its solver-owned rotation (its origin->refpoint orientation line) to
      // 0/90deg, exactly like on a real line.
      if (orientables.length >= 1 && orientables.length === ents.length) {
        return { ok: true, constraints: orientables.map((o): SketchConstraint => (
          { id: newId(), kind, line: o.id }
        )) }
      }
      if (operands.length === 2 && points.length === 2) {
        return { ok: true, constraints: [
          { id: newId(), kind, points: [points[0], points[1]] },
        ] }
      }
      return invalid('select one or more lines or blocks, or two points')
    }

    case 'parallel':
    case 'perpendicular': {
      // First operand paired with each subsequent (parallel — all share
      // operand 0), consecutive pairs (perpendicular — a chain alternates
      // direction). A BLOCK operand contributes its orientation line
      // (SKC-ROTATION-SOLVABLE), so parallel/perpendicular DRIVE a block's
      // rotation against a reference line or another block.
      if (orientables.length < 2 || orientables.length !== ents.length) {
        return invalid('select two or more lines or block orientations')
      }
      const constraints: SketchConstraint[] = []
      for (let i = 1; i < orientables.length; i++) {
        constraints.push(kind === 'perpendicular'
          ? { id: newId(), kind, a: orientables[i - 1].id, b: orientables[i].id }
          : { id: newId(), kind, a: orientables[0].id, b: orientables[i].id })
      }
      return { ok: true, constraints }
    }

    case 'collinear': {
      // Collinear composes a point-on-line on an operand's :start endpoint,
      // which a block orientation line does not expose -- so it stays lines-only
      // (a block operand refuses by name in the solver mapping via expectKind).
      if (lines.length < 2 || lines.length !== ents.length) {
        return invalid('select two or more lines')
      }
      const constraints: SketchConstraint[] = []
      for (let i = 1; i < lines.length; i++) {
        constraints.push({ id: newId(), kind, a: lines[0].id, b: lines[i].id })
      }
      return { ok: true, constraints }
    }

    case 'coincident': {
      if (operands.length === 2 && points.length === 2) {
        return { ok: true, constraints: [
          { id: newId(), kind, a: points[0], b: points[1] },
        ] }
      }
      if (operands.length === 2) {
        const candidates = operands.flatMap((pointOperand, pointIndex) => {
          if (!pointOperand.point) return []
          const objectOperand = operands[pointIndex === 0 ? 1 : 0]
          if (!objectOperand.whole ||
              !['line', 'circle', 'arc'].includes(objectOperand.entity.kind)) return []
          return [[pointOperand.point, objectOperand.entity.id] as const]
        })
        if (candidates.length === 1) {
          return { ok: true, constraints: [{
            id: newId(),
            kind: 'point_on_object',
            point: candidates[0][0],
            object: candidates[0][1],
          }] }
        }
      }
      return invalid('select two points, or a point and a curve')
    }

    case 'concentric': {
      const concentricCurves = operands
        .map((operand) => operand.entity)
        .filter((e) => e.kind === 'circle' || e.kind === 'arc')
      if (operands.length === 2 && concentricCurves.length === 2) {
        return { ok: true, constraints: [
          { id: newId(), kind, a: concentricCurves[0].id, b: concentricCurves[1].id },
        ] }
      }
      return invalid('select two circles or arcs')
    }

    case 'tangent': {
      // line + circle/arc, or any two circles/arcs. Never line+line
      // (meaningless) and never points.
      if (ents.length === 2 && curves.length >= 1 &&
          lines.length + curves.length === 2) {
        return { ok: true, constraints: [
          { id: newId(), kind, a: ents[0].id, b: ents[1].id },
        ] }
      }
      return invalid('select a line and a circle/arc, or two circles/arcs')
    }

    case 'equal': {
      // Equal LENGTH (all lines) or equal RADIUS (all circles/arcs) —
      // mixing has no meaning (mirrors the solver mapping's rule).
      if (lines.length >= 2 && lines.length === ents.length) {
        return { ok: true, constraints: lines.slice(1).map((l): SketchConstraint => (
          { id: newId(), kind, a: lines[0].id, b: l.id }
        )) }
      }
      if (curves.length >= 2 && curves.length === ents.length) {
        return { ok: true, constraints: curves.slice(1).map((c): SketchConstraint => (
          { id: newId(), kind, a: curves[0].id, b: c.id }
        )) }
      }
      return invalid('select two or more lines, or two or more circles/arcs')
    }

    case 'midpoint': {
      if (operands.length === 2 && points.length === 1 && lines.length === 1) {
        return { ok: true, constraints: [
          { id: newId(), kind, point: points[0], line: lines[0].id },
        ] }
      }
      return invalid('select a point and a line')
    }

    case 'symmetric': {
      if (operands.length === 3 && points.length === 2 && lines.length === 1) {
        return { ok: true, constraints: [
          { id: newId(), kind, a: points[0], b: points[1], axis: lines[0].id },
        ] }
      }
      return invalid('select two points and an axis line')
    }

    case 'fix': {
      if (operands.length === 0) return invalid('select at least one entity or center point')
      // Skip entities already grounded whole (a duplicate fix adds
      // nothing); a point-site fix does not fully ground its entity, so
      // it does not exclude one here.
      const wholeFixed = new Set(sketch.constraints
        .filter((c) => c.kind === 'fix' && c.entityId)
        .map((c) => (c as Extract<SketchConstraint, { kind: 'fix' }>).entityId!))
      const pointFixed = new Set(sketch.constraints
        .filter((c) => c.kind === 'fix' && c.point)
        .map((c) => {
          const point = (c as Extract<SketchConstraint, { kind: 'fix' }>).point!
          return `${point.entityId}:${point.site}`
        }))
      const constraints: SketchConstraint[] = []
      for (const operand of operands) {
        if (!operand.whole && operand.point) {
          const key = `${operand.point.entityId}:${operand.point.site}`
          if (!pointFixed.has(key) && !wholeFixed.has(operand.entity.id)) {
            constraints.push({ id: newId(), kind, point: operand.point })
          }
        } else if (!wholeFixed.has(operand.entity.id)) {
          constraints.push({ id: newId(), kind, entityId: operand.entity.id })
        }
      }
      return constraints.length > 0
        ? { ok: true, constraints }
        : invalid('selection is already fixed')
    }

    case 'continuity_g1':
    case 'continuity_g2':
      return planContinuity(ents, operands.length, kind)

    case 'point_on_object': {
      // One unambiguous point + one curve. Two circles are rejected:
      // which is the point and which the object would be a guess (use
      // concentric/tangent for circle pairs).
      if (operands.length === 2) {
        const objectKinds: SketchEntity['kind'][] = ['line', 'circle', 'arc']
        const candidates = operands.flatMap((pointOperand, pointIndex) => {
          if (!pointOperand.point) return []
          const objectOperand = operands[pointIndex === 0 ? 1 : 0]
          if (!objectOperand.whole || !objectKinds.includes(objectOperand.entity.kind)) return []
          // Two raw circles remain intentionally ambiguous; an explicitly
          // selected center is never silently reinterpreted as its curve.
          if (pointOperand.whole && pointOperand.entity.kind !== 'point' &&
              objectOperand.entity.kind !== 'line' && objectOperand.entity.kind !== 'arc') return []
          return [[pointOperand.point, objectOperand.entity] as [PointRef, SketchEntity]]
        })
        if (candidates.length === 1) {
          const pair = candidates[0]
          return { ok: true, constraints: [
            { id: newId(), kind, point: pair[0], object: pair[1].id },
          ] }
        }
      }
      return invalid('select a point and a curve (line, circle, or arc)')
    }

    case 'pierce':
      // WO-1865: one operand is a MODEL edge, which is never a sketch selection. The sketch half
      // is piercePointForSelection below; the workbench Pierce command picks the edge.
      return invalid('select one sketch point, then pick the model edge that crosses the sketch plane')
  }
}

/** WO-1865: the one point site a Pierce applies to -- a point, a line/arc endpoint, or a
 *  circle/arc centre (the same point operands every other constraint accepts). No other selection
 *  names a single point, so nothing else can be pierced; that is the only refusal. */
export function piercePointForSelection(
  sketch: Sketch, selectedIds: readonly string[],
): { ok: true; point: PointRef } | { ok: false; reason: string } {
  const byId = new Map(sketch.entities.map((e) => [e.id, e]))
  const points: PointRef[] = []
  for (const id of selectedIds) {
    const pointRef = decodePointSelectionRef(id)
    if (pointRef) {
      const entity = byId.get(pointRef.entityId)
      if (!entity) continue
      const valid = pointRef.site === 'center'
        ? centerRefForEntity(entity) !== null
        : (pointRef.site === 'start' || pointRef.site === 'end')
          && (entity.kind === 'line' || entity.kind === 'arc')
      if (valid) points.push(pointRef)
      continue
    }
    const entity = byId.get(id)
    const implied = entity ? impliedPoint(entity) : null
    if (implied) points.push(implied)
  }
  if (points.length !== 1) {
    return { ok: false, reason: 'Pierce: select exactly one sketch point (a point, an endpoint or a centre) first.' }
  }
  // A point that is already pierced is simply re-pierced (applyPierce replaces its old one).
  return { ok: true, point: points[0] }
}

// ---- Continuity (WO-1866) --------------------------------------------------

type EndSite = 'start' | 'end'

function isOpenControlSpline(e: SketchEntity): e is Extract<SketchEntity, { kind: 'spline' }> {
  return e.kind === 'spline' && e.form === 'control' && !e.closed && e.points.length >= 2
}

/** The two joinable ends of a line, arc or open control spline. */
function curveEnds(e: SketchEntity): Array<{ site: EndSite; at: Vec2 }> {
  if (e.kind === 'line') return [{ site: 'start', at: e.start }, { site: 'end', at: e.end }]
  if (e.kind === 'arc') {
    const at = (t: number) => ({ x: e.center.x + e.radius * Math.cos(t), y: e.center.y + e.radius * Math.sin(t) })
    return [{ site: 'start', at: at(e.startAngle) }, { site: 'end', at: at(e.endAngle) }]
  }
  if (isOpenControlSpline(e)) {
    return [{ site: 'start', at: e.points[0] }, { site: 'end', at: e.points[e.points.length - 1] }]
  }
  return []
}

/** Select a control spline and the line, arc or control spline it meets; the joint is the pair of ends closest together. The spline is
 *  operand `a`. The constraint carries the joint coincidence itself, so the
 *  ends need not touch yet -- the solve brings them together. */
function planContinuity(
  ents: SketchEntity[], operandCount: number, kind: 'continuity_g1' | 'continuity_g2',
): ConstraintPlanResult {
  const need = 'select a control spline and the line, arc or control spline it meets'
  if (ents.length !== 2 || operandCount !== 2) return invalid(need)
  const splineIdx = isOpenControlSpline(ents[0]) ? 0 : isOpenControlSpline(ents[1]) ? 1 : -1
  if (splineIdx < 0) return invalid(need)
  const spline = ents[splineIdx]
  const other = ents[1 - splineIdx]
  if (spline.id === other.id || curveEnds(other).length === 0) return invalid(need)
  if (kind === 'continuity_g2' && other.kind === 'arc' && spline.kind === 'spline' && spline.points.length < 3) {
    return invalid("a two-point control spline is straight and cannot match an arc's curvature")
  }
  let best: { a: EndSite; b: EndSite; d: number } | null = null
  for (const sa of curveEnds(spline)) {
    for (const sb of curveEnds(other)) {
      const d = Math.hypot(sa.at.x - sb.at.x, sa.at.y - sb.at.y)
      if (!best || d < best.d) best = { a: sa.site, b: sb.site, d }
    }
  }
  if (!best) return invalid(need)
  return { ok: true, constraints: [{
    id: newId(), kind,
    a: { entityId: spline.id, site: best.a },
    b: { entityId: other.id, site: best.b },
  }] }
}

// ---- Conflict naming -------------------------------------------------------

/** Same readable per-kind label convention the design-tree browser panel's
 *  conflict rows use (dedupe + '?' fallback); display-only, never raw ids. */
function refsLabel(ids: string[], labels: Map<string, string>): string {
  return [...new Set(ids)].map((id) => labels.get(id) ?? '?').join(', ')
}

/** "Horizontal(Line 5)" / "Distance(Line 1 = 40)" style description of one
 *  conflicting constraint/dimension for the rejection notice. */
function describeOne(sketch: Sketch, id: string, labels: Map<string, string>): string | null {
  const c = sketch.constraints.find((x) => x.id === id)
  if (c) {
    return `${constraintKindLabel(c.kind)}(${refsLabel(constraintRefIds(c), labels)})`
  }
  const d = sketch.dimensions.find((x) => x.id === id)
  if (d) {
    const refs = refsLabel(dimensionRefIds(d), labels)
    return `${constraintKindLabel(d.kind)}(${refs} = ${d.value})`
  }
  return null
}

/** Name a conflicting set for the user, excluding the just-rejected ids
 *  (naming the rejected constraint as its own conflict says nothing). */
export function describeConstraintSet(
  sketch: Sketch, ids: string[], exclude: ReadonlySet<string>,
): string {
  const labels = entityLabels(sketch.entities)
  return ids
    .filter((id) => !exclude.has(id))
    .map((id) => describeOne(sketch, id, labels))
    .filter((s): s is string => s !== null)
    .join(', ')
}
