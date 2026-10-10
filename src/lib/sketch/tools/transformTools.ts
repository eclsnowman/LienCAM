// Sketch transform tools: Move, Rotate, Scale, each with "Keep original"
// (copy) - WO-1568, FEATURE-HITLIST v1 "Move / Rotate / Scale / Copy
// entities".
//
// Flow (all three share the pattern tools' gesture):
//   1. SET: clicks toggle entities in/out of the set (a pre-selection seeds
//      it at arm time). Confirm (Enter) closes the set - clicks never leave
//      this phase on their own.
//   2. PLACE (snap-enabled point clicks):
//      - move:   base point, then destination point
//      - rotate: centre, then a reference-direction point, then a
//                target-direction point
//      - scale:  base point - the overlay opens with the factor; two more
//                clicks (reference point, target point) set the factor as
//                their distance ratio from the base
//      A live ghost follows the cursor while a placement is pending.
//   3. CONFIRM OVERLAY: dX / dY, the angle or the factor are typed live
//      (the ghost follows), plus a Keep original checkbox; OK commits as
//      ONE undo step.
//
// CONSTRAINT AND DIMENSION RULES (transformSelection). "Inside" = every
// operand is in the set; "outside tie" = some operands in, some out.
//
//   moved IN PLACE                     | Keep original (COPY)
//   -----------------------------------+-----------------------------------
//   inside constraints kept, except:   | inside constraints copied onto the
//     fix -> released (it grounds the  | copy (remapped ids), except fix;
//       old position)                  | never an outside tie
//     rotate: H/V swapped at a quarter |   rotate: H/V swapped at a quarter
//       turn, removed otherwise        |     turn, removed otherwise
//   outside ties released unless the   |
//     transform keeps them true:       |
//     move:   parallel/perp/equal      |
//     rotate: equal; parallel/perp at  |
//             a half turn              |
//     scale:  parallel/perp            |
//   inside dimensions kept; scale      | inside dimensions copied (same
//     multiplies every length by the   |   value rules)
//     factor; rotate turns X/Y dims at |
//     a quarter turn, makes a driving  |
//     X/Y dim a reference otherwise    |
//   outside DRIVING dims released      |
//     (angle dims survive move/scale); |
//     reference dims kept              |
//
// The operator asked for the motion, so nothing is refused for being
// constrained: a fully constrained set releases its outside ties and moves.
//
// PURE module following the toolMachine pattern: clicks RETURN chain
// transitions; the overlay apply (controller) commits as one undo step.

import type {
  Vec2,
  PointRef,
  SketchEntity,
  SketchConstraint,
  SketchDimension,
} from '../types'
import { isInjectedSketchAnchorId } from '../sketchAnchors'
import type { SketchDoc, SketchDocTransform } from './trimTool'
import { axisConstraintKindAt, pickEntity, remapConstraint } from './patternTools'

export type TransformOp = 'move' | 'rotate' | 'scale'

export const TRANSFORM_OP_LABEL: Readonly<Record<TransformOp, string>> = {
  move: 'Move', rotate: 'Rotate', scale: 'Scale',
}

// ---- Chain state (CHAINING payload) ---------------------------------------------

export interface TransformChainState {
  kind: 'transform'
  op: TransformOp
  ids: string[]
  /** Set closed by Confirm (Enter): clicks now PLACE. */
  confirmed: boolean
  /** True when `ids` were consumed from the selection at arm time. */
  seeded?: boolean
  /** move base / rotate centre / scale base. */
  base: Vec2 | null
  /** move destination / rotate reference-direction point / scale reference point. */
  ref: Vec2 | null
  /** rotate target-direction point / scale target point (unused by move). */
  target: Vec2 | null
  /** Overlay values: seeded by the placement clicks, editable by typing. */
  dx: number
  dy: number
  angleDeg: number
  factor: number
  /** Keep original: commit a transformed COPY and leave the set untouched. */
  keepOriginal: boolean
}

export function newTransformChain(
  op: TransformOp, ids: readonly string[], seeded = false,
): TransformChainState {
  return {
    kind: 'transform', op, ids: [...ids], confirmed: false,
    base: null, ref: null, target: null,
    dx: 0, dy: 0, angleDeg: 0, factor: 1, keepOriginal: false,
    ...(seeded ? { seeded: true } : {}),
  }
}

/** True once the placement clicks are done and the confirm overlay is up. */
export function transformPlaced(chain: TransformChainState): boolean {
  if (!chain.confirmed || !chain.base) return false
  switch (chain.op) {
    case 'move': return chain.ref !== null
    case 'rotate': return chain.target !== null
    case 'scale': return true
  }
}

/** The set as it will be transformed: existing entities only, never the
 *  injected origin/axes (the sketch frame itself cannot move). */
export function transformSetIds(
  entities: readonly SketchEntity[], ids: readonly string[],
): Set<string> {
  const present = new Set(entities.map((e) => e.id))
  return new Set(ids.filter((id) => present.has(id) && !isInjectedSketchAnchorId(id)))
}

// ---- Transform specs ---------------------------------------------------------------

export interface TransformSpec {
  map: (p: Vec2) => Vec2
  /** Rotation it applies to directions (radians; 0 for move/scale). */
  dTheta: number
  /** Uniform scale it applies to lengths (1 for move/rotate). */
  scale: number
  /** True when the transform changes nothing (zero move, 0deg, factor 1). */
  identity: boolean
}

const TWO_PI = Math.PI * 2
const HALF_PI = Math.PI / 2
// Same float-roundoff tolerance patternTools uses for "is a quarter turn".
const TURN_EPS = 1e-6
const LEN_EPS = 1e-9

function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Whole quarter turns (0..3) when `a` is a multiple of 90deg, else null. */
function quarterTurns(a: number): number | null {
  const n = norm(a)
  const k = Math.round(n / HALF_PI)
  if (Math.abs(n - k * HALF_PI) > TURN_EPS) return null
  return k % 4
}

export function moveSpec(dx: number, dy: number): TransformSpec {
  return {
    map: (p) => ({ x: p.x + dx, y: p.y + dy }),
    dTheta: 0, scale: 1,
    identity: Math.abs(dx) < LEN_EPS && Math.abs(dy) < LEN_EPS,
  }
}

export function rotateSpec(center: Vec2, rad: number): TransformSpec {
  // Exact trig at quarter turns so a 90deg rotation of a 40 mm edge lands
  // on 40, not 39.999999999999996.
  const k = quarterTurns(rad)
  const cos = k === null ? Math.cos(rad) : [1, 0, -1, 0][k]
  const sin = k === null ? Math.sin(rad) : [0, 1, 0, -1][k]
  return {
    map: (p) => ({
      x: center.x + (p.x - center.x) * cos - (p.y - center.y) * sin,
      y: center.y + (p.x - center.x) * sin + (p.y - center.y) * cos,
    }),
    dTheta: rad, scale: 1,
    identity: k === 0,
  }
}

export function scaleSpec(center: Vec2, factor: number): TransformSpec {
  return {
    map: (p) => ({
      x: center.x + (p.x - center.x) * factor,
      y: center.y + (p.y - center.y) * factor,
    }),
    dTheta: 0, scale: factor,
    identity: Math.abs(factor - 1) < LEN_EPS,
  }
}

/** The committed transform for a placed chain at its overlay values, or
 *  the reason it cannot be built. */
export function transformSpecOf(chain: TransformChainState): TransformSpec | string {
  const label = TRANSFORM_OP_LABEL[chain.op]
  if (!chain.base) return `${label}: click the base point first`
  switch (chain.op) {
    case 'move':
      if (!Number.isFinite(chain.dx) || !Number.isFinite(chain.dy)) {
        return 'Move: dX and dY must be numbers'
      }
      return moveSpec(chain.dx, chain.dy)
    case 'rotate':
      if (!Number.isFinite(chain.angleDeg)) return 'Rotate: the angle must be a number'
      return rotateSpec(chain.base, (chain.angleDeg * Math.PI) / 180)
    case 'scale':
      // A zero or negative factor has no size to give the geometry.
      if (!(chain.factor > 0) || !Number.isFinite(chain.factor)) {
        return 'Scale: the factor must be greater than 0'
      }
      return scaleSpec(chain.base, chain.factor)
  }
}

// ---- Entity transform --------------------------------------------------------------

/** One entity under `t`, every non-geometric field carried over. */
function transformEntity(e: SketchEntity, t: TransformSpec, id: string): SketchEntity {
  const s = t.scale
  const turn = (a: number): number => (t.dTheta === 0 ? a : norm(a + t.dTheta))
  switch (e.kind) {
    case 'point':
      return { ...e, id, at: t.map(e.at) }
    case 'line':
      return { ...e, id, start: t.map(e.start), end: t.map(e.end) }
    case 'circle':
      return { ...e, id, center: t.map(e.center), radius: e.radius * s }
    case 'arc':
      return {
        ...e, id, center: t.map(e.center), radius: e.radius * s,
        startAngle: turn(e.startAngle), endAngle: turn(e.endAngle),
      }
    // Ellipse params live in the ellipse's own frame: map the centre, scale
    // the radii, add the rotation.
    case 'ellipse':
      return {
        ...e, id, center: t.map(e.center),
        majorRadius: e.majorRadius * s, minorRadius: e.minorRadius * s,
        rotation: e.rotation + t.dTheta,
      }
    case 'elliptical-arc':
      return {
        ...e, id, center: t.map(e.center),
        majorRadius: e.majorRadius * s, minorRadius: e.minorRadius * s,
        rotation: e.rotation + t.dTheta,
      }
    case 'spline':
      return {
        ...e, id, points: e.points.map(t.map),
        ...(e.filletSourcePoints ? { filletSourcePoints: e.filletSourcePoints.map(t.map) } : {}),
      }
    case 'text':
      return {
        ...e, id, at: t.map(e.at), height: e.height * s,
        ...(t.dTheta !== 0 ? { rotation: (e.rotation ?? 0) + t.dTheta } : {}),
        ...(e.letterSpacingMm !== undefined ? { letterSpacingMm: e.letterSpacingMm * s } : {}),
        ...(e.pathOffsetMm !== undefined ? { pathOffsetMm: e.pathOffsetMm * s } : {}),
      }
    // Block members live in the block's local frame: only the placement moves.
    case 'block':
      return {
        ...e, id, origin: t.map(e.origin),
        rotation: e.rotation + t.dTheta, scale: e.scale * s,
      }
  }
}

/** A copy's references to OTHER entities follow the copy when their target
 *  was copied too, and are dropped otherwise (a copy never stays bound to
 *  the original's geometry). */
function detachCopy(e: SketchEntity, m: ReadonlyMap<string, string>): SketchEntity {
  if (e.kind === 'text' && e.pathId !== undefined) {
    const pathId = m.get(e.pathId)
    if (pathId) return { ...e, pathId }
    const { pathId: _p, pathOffsetMm: _o, pathFlip: _f, pathAlign: _a, ...free } = e
    return free
  }
  if (e.kind === 'arc' && e.curveFillet) {
    const cf = e.curveFillet
    const a = m.get(cf.hostAId), b = m.get(cf.hostBId), p = m.get(cf.theoreticalPointId)
    if (a && b && p) {
      return { ...e, curveFillet: { ...cf, hostAId: a, hostBId: b, theoreticalPointId: p } }
    }
    const { curveFillet: _cf, ...plain } = e
    return plain
  }
  return e
}

// ---- Membership -----------------------------------------------------------------------

function constraintEntityIds(c: SketchConstraint): string[] {
  switch (c.kind) {
    case 'coincident':
    case 'continuity_g1':
    case 'continuity_g2':
      return [c.a.entityId, c.b.entityId]
    case 'concentric':
    case 'parallel':
    case 'perpendicular':
    case 'collinear':
    case 'tangent':
    case 'equal':
      return [c.a, c.b]
    case 'horizontal':
    case 'vertical':
      if (c.line) return [c.line]
      return c.points ? [c.points[0].entityId, c.points[1].entityId] : []
    case 'midpoint':
      return [c.point.entityId, c.line]
    case 'symmetric':
      return [c.a.entityId, c.b.entityId, c.axis]
    case 'fix':
      if (c.entityId) return [c.entityId]
      return c.point ? [c.point.entityId] : []
    case 'point_on_object':
      return [c.point.entityId, c.object]
    case 'pierce':
      return [c.point.entityId]
  }
}

function dimensionEntityIds(d: SketchDimension): string[] {
  switch (d.kind) {
    case 'distance':
    case 'distanceX':
    case 'distanceY':
      return [d.a.entityId, d.b.entityId]
    case 'ordinate':
      return [d.origin.entityId, d.point.entityId]
    case 'distancePL':
      return [d.point.entityId, d.line]
    case 'angle':
      return [d.a, d.b]
    case 'angle3':
      return [d.vertex.entityId, d.a.entityId, d.b.entityId]
    case 'radius':
    case 'diameter':
    case 'arcLength':
    case 'majorRadius':
    case 'minorRadius':
    case 'focusDistance':
    case 'd1xd2':
      return [d.entityId]
  }
}

type Membership = 'none' | 'inside' | 'outside-tie'

function membership(ids: readonly string[], set: ReadonlySet<string>): Membership {
  const n = ids.filter((id) => set.has(id)).length
  if (n === 0) return 'none'
  return n === ids.length ? 'inside' : 'outside-tie'
}

/** An outside tie the transform leaves TRUE, so it never has to be released. */
function outsideTieSurvives(kind: SketchConstraint['kind'], op: TransformOp, dTheta: number): boolean {
  const direction = kind === 'parallel' || kind === 'perpendicular'
  switch (op) {
    case 'move': return direction || kind === 'equal'
    case 'rotate': {
      const k = quarterTurns(dTheta)
      return kind === 'equal' || (direction && (k === 0 || k === 2))
    }
    case 'scale': return direction
  }
}

// ---- Dimension value rules ----------------------------------------------------------------

/** An inside dimension after the transform: label moved, lengths scaled,
 *  X/Y components turned with a quarter-turn rotation. `toReference` is set
 *  when a driving X/Y dimension has no axis to measure along any more. */
function transformInsideDimension(
  d: SketchDimension, op: TransformOp, t: TransformSpec,
): { dim: SketchDimension; toReference: boolean } {
  const next = {
    ...d,
    ...(d.labelAnchor ? { labelAnchor: t.map(d.labelAnchor) } : {}),
  } as SketchDimension
  if (op === 'scale' && d.kind !== 'angle' && d.kind !== 'angle3' && !t.identity) {
    next.value = d.value * t.scale
    if (next.kind === 'd1xd2' && d.kind === 'd1xd2') next.d2 = d.d2 * t.scale
    delete next.expression // an equation no longer describes the scaled value
    return { dim: next, toReference: false }
  }
  // WO-1867: an ORDINATE is the same axis-bound signed component distanceX/Y
  // are, so a rotation treats it identically -- except that the axis it
  // measures along lives in a FIELD (`axis`) rather than in the kind, so an
  // odd quarter turn flips the field and leaves the kind alone. An arbitrary
  // (non-quarter) turn leaves no world axis to measure along, so a driving
  // ordinate degrades to a reference readout exactly like a driving distanceX
  // does -- never a refusal thrown at the operator (rule 11).
  if (op === 'rotate' && d.kind === 'ordinate') {
    const k = quarterTurns(t.dTheta)
    if (k === null) {
      return d.driving
        ? { dim: { ...next, driving: false }, toReference: true }
        : { dim: next, toReference: false }
    }
    if (k === 0) return { dim: next, toReference: false }
    let x = d.axis === 'x' ? d.value : 0
    let y = d.axis === 'y' ? d.value : 0
    for (let i = 0; i < k; i++) [x, y] = [-y, x]
    const turned = { ...next } as SketchDimension & { kind: 'ordinate' }
    turned.axis = k % 2 === 0 ? d.axis : (d.axis === 'x' ? 'y' : 'x')
    turned.value = turned.axis === 'x' ? x : y
    if (turned.value !== d.value) delete turned.expression
    return { dim: turned, toReference: false }
  }
  if (op === 'rotate' && (d.kind === 'distanceX' || d.kind === 'distanceY')) {
    const k = quarterTurns(t.dTheta)
    if (k === null) {
      return d.driving
        ? { dim: { ...next, driving: false }, toReference: true }
        : { dim: next, toReference: false }
    }
    if (k === 0) return { dim: next, toReference: false }
    // The dimension is the signed b-a component. A quarter turn maps the
    // difference vector (x, y) -> (-y, x): an odd count swaps the axis the
    // component lies on, and the rotated vector carries its new sign.
    let x = d.kind === 'distanceX' ? d.value : 0
    let y = d.kind === 'distanceY' ? d.value : 0
    for (let i = 0; i < k; i++) [x, y] = [-y, x]
    const turned = { ...next } as SketchDimension & { kind: 'distanceX' | 'distanceY' }
    turned.kind = k % 2 === 0 ? d.kind : (d.kind === 'distanceX' ? 'distanceY' : 'distanceX')
    turned.value = turned.kind === 'distanceX' ? x : y
    if (turned.value !== d.value) delete turned.expression
    return { dim: turned, toReference: false }
  }
  return { dim: next, toReference: false }
}

function remapPointRef(r: PointRef, m: ReadonlyMap<string, string>): PointRef {
  return { entityId: m.get(r.entityId)!, site: r.site }
}

/** An inside dimension's operands moved onto the copy's ids. */
function remapDimension(
  d: SketchDimension, m: ReadonlyMap<string, string>, id: string,
): SketchDimension {
  switch (d.kind) {
    case 'distance':
    case 'distanceX':
    case 'distanceY':
      return { ...d, id, a: remapPointRef(d.a, m), b: remapPointRef(d.b, m) }
    case 'ordinate':
      return { ...d, id, origin: remapPointRef(d.origin, m), point: remapPointRef(d.point, m) }
    case 'distancePL':
      return { ...d, id, point: remapPointRef(d.point, m), line: m.get(d.line)! }
    case 'angle':
      return { ...d, id, a: m.get(d.a)!, b: m.get(d.b)! }
    case 'angle3':
      return {
        ...d, id,
        vertex: remapPointRef(d.vertex, m), a: remapPointRef(d.a, m), b: remapPointRef(d.b, m),
      }
    case 'radius':
    case 'diameter':
    case 'arcLength':
    case 'majorRadius':
    case 'minorRadius':
    case 'focusDistance':
    case 'd1xd2':
      return { ...d, id, entityId: m.get(d.entityId)! }
  }
}

// ---- The transform ---------------------------------------------------------------------------

export interface TransformOutcome {
  transform: SketchDocTransform
  /** Entities moved (in place) or created (copy). */
  count: number
  copied: boolean
  /** Outside ties and fixes removed from the moved geometry. */
  released: number
  /** Horizontal/vertical constraints the rotation no longer satisfies (removed). */
  axisDropped: number
  /** Driving X/Y dimensions a non-quarter-turn rotation made reference. */
  toReference: number
}

/**
 * Move / rotate / scale the entities in `ids` under `t` - in place, or as a
 * copy when `keepOriginal` - applying the constraint and dimension rules in
 * the header. Returns full replacement document arrays (one undo step).
 */
export function transformSelection(
  doc: SketchDoc,
  ids: readonly string[],
  op: TransformOp,
  t: TransformSpec,
  keepOriginal: boolean,
  newId: () => string = () => crypto.randomUUID(),
): TransformOutcome | string {
  const set = transformSetIds(doc.entities, ids)
  if (set.size === 0) return `${TRANSFORM_OP_LABEL[op]}: nothing selected to ${op}`
  return keepOriginal
    ? copyTransformed(doc, set, op, t, newId)
    : transformInPlace(doc, set, op, t)
}

function transformInPlace(
  doc: SketchDoc, set: ReadonlySet<string>, op: TransformOp, t: TransformSpec,
): TransformOutcome {
  let released = 0
  let axisDropped = 0
  let toReference = 0
  // Project/Use geometry whose grounding fix is released is no longer the
  // static projected copy (types.ts projectionDetached).
  const detached = new Set<string>()

  const constraints: SketchConstraint[] = []
  for (const c of doc.constraints) {
    const where = membership(constraintEntityIds(c), set)
    if (where === 'none' || t.identity) {
      constraints.push(c)
      continue
    }
    if (where === 'inside') {
      // WO-1865: a pierce is positional grounding supplied by the model; moving the point off
      // the crossing releases it exactly like a Fix (counted in the notice, never silent).
      if (c.kind === 'fix' || c.kind === 'pierce') {
        released++
        if (c.kind === 'fix' && c.projectionGrounding && c.entityId) detached.add(c.entityId)
        continue
      }
      if (op === 'rotate' && (c.kind === 'horizontal' || c.kind === 'vertical')) {
        const kind = axisConstraintKindAt(c.kind, t.dTheta)
        if (!kind) {
          axisDropped++
          continue
        }
        constraints.push(kind === c.kind ? c : { ...c, kind })
        continue
      }
      constraints.push(c)
      continue
    }
    if (outsideTieSurvives(c.kind, op, t.dTheta)) constraints.push(c)
    else released++
  }

  const dimensions: SketchDimension[] = []
  for (const d of doc.dimensions) {
    const where = membership(dimensionEntityIds(d), set)
    if (where === 'none') {
      dimensions.push(d)
      continue
    }
    if (where === 'inside') {
      const r = transformInsideDimension(d, op, t)
      if (r.toReference) toReference++
      dimensions.push(r.dim)
      continue
    }
    // Outside tie: a reference dimension only reports, a driving one would
    // pull the geometry back - unless the transform leaves its value true.
    if (!d.driving || t.identity || ((d.kind === 'angle' || d.kind === 'angle3') && op !== 'rotate')) {
      dimensions.push(d)
    } else {
      released++
    }
  }

  const entities = doc.entities.map((e) => {
    if (!set.has(e.id)) return e
    const moved = transformEntity(e, t, e.id)
    return detached.has(e.id) ? { ...moved, projectionDetached: true as const } : moved
  })

  return {
    transform: { entities, constraints, dimensions },
    count: set.size, copied: false, released, axisDropped, toReference,
  }
}

function copyTransformed(
  doc: SketchDoc, set: ReadonlySet<string>, op: TransformOp, t: TransformSpec,
  newId: () => string,
): TransformOutcome {
  const m = new Map<string, string>()
  const sources = doc.entities.filter((e) => set.has(e.id))
  for (const e of sources) m.set(e.id, newId())
  // A copy is native geometry: it is not the grounded Project/Use copy.
  const copies = sources.map((e) => {
    const { provenance: _p, projectionDetached: _d, ...native } =
      detachCopy(transformEntity(e, t, m.get(e.id)!), m)
    return native as SketchEntity
  })

  let axisDropped = 0
  let toReference = 0
  const dTheta = op === 'rotate' ? t.dTheta : 0
  const newConstraints: SketchConstraint[] = []
  for (const c of doc.constraints) {
    if (membership(constraintEntityIds(c), set) !== 'inside') continue
    const rc = remapConstraint(c, m, newId, dTheta)
    if (rc) newConstraints.push(rc)
    else if (c.kind === 'horizontal' || c.kind === 'vertical') axisDropped++
  }

  const newDimensions: SketchDimension[] = []
  for (const d of doc.dimensions) {
    if (membership(dimensionEntityIds(d), set) !== 'inside') continue
    const r = transformInsideDimension(d, op, t)
    if (r.toReference) toReference++
    newDimensions.push(remapDimension(r.dim, m, newId()))
  }

  return {
    transform: {
      entities: [...doc.entities, ...copies],
      constraints: [...doc.constraints, ...newConstraints],
      dimensions: [...doc.dimensions, ...newDimensions],
    },
    count: copies.length, copied: true, released: 0, axisDropped, toReference,
  }
}

/** What the commit did, for the notice ("Moved 4 entities - released 1 tie ..."). */
export function transformNotice(op: TransformOp, o: TransformOutcome): string {
  const past = { move: 'Moved', rotate: 'Rotated', scale: 'Scaled' }[op]
  const ents = `${o.count} ${o.count === 1 ? 'entity' : 'entities'}`
  let s = o.copied ? `${past} a copy of ${ents}` : `${past} ${ents}`
  if (o.released > 0) {
    s += ` - released ${o.released} ${o.released === 1 ? 'tie' : 'ties'} to geometry outside the selection`
  }
  if (o.axisDropped > 0) {
    s += ` - removed ${o.axisDropped} horizontal/vertical ` +
      `${o.axisDropped === 1 ? 'constraint' : 'constraints'} the rotation no longer satisfies`
  }
  if (o.toReference > 0) {
    s += ` - ${o.toReference} X/Y ${o.toReference === 1 ? 'dimension' : 'dimensions'} changed to reference`
  }
  return s
}

// ---- Apply (confirm overlay OK) --------------------------------------------------------------

export function transformApply(
  chain: TransformChainState, doc: SketchDoc, newId?: () => string,
): TransformOutcome | string {
  const label = TRANSFORM_OP_LABEL[chain.op]
  if (!transformPlaced(chain)) return `${label}: finish placing it first`
  const t = transformSpecOf(chain)
  if (typeof t === 'string') return t
  return transformSelection(doc, chain.ids, chain.op, t, chain.keepOriginal, newId)
}

// ---- Ghost preview ------------------------------------------------------------------------------

function directionDelta(base: Vec2, from: Vec2, to: Vec2): number | null {
  if (dist(from, base) < LEN_EPS || dist(to, base) < LEN_EPS) return null
  return Math.atan2(to.y - base.y, to.x - base.x) - Math.atan2(from.y - base.y, from.x - base.x)
}

/** Signed degrees in (-180, 180], rounded off float noise. */
function toDegrees(rad: number): number {
  let deg = (rad * 180) / Math.PI
  deg = ((deg % 360) + 360) % 360
  if (deg > 180) deg -= 360
  return Math.round(deg * 1e9) / 1e9
}

/** The transform the ghost shows right now: the overlay values once placed,
 *  otherwise the pending placement toward the cursor. */
export function transformLiveSpec(
  chain: TransformChainState, cursor: Vec2,
): TransformSpec | null {
  if (!chain.confirmed || !chain.base || chain.ids.length === 0) return null
  const base = chain.base
  switch (chain.op) {
    case 'move':
      return chain.ref
        ? moveSpec(chain.dx, chain.dy)
        : moveSpec(cursor.x - base.x, cursor.y - base.y)
    case 'rotate': {
      if (chain.target) return rotateSpec(base, (chain.angleDeg * Math.PI) / 180)
      if (!chain.ref) return null
      const a = directionDelta(base, chain.ref, cursor)
      return a === null ? null : rotateSpec(base, a)
    }
    case 'scale': {
      if (chain.ref && !chain.target) {
        const r = dist(chain.ref, base)
        const f = r < LEN_EPS ? 0 : dist(cursor, base) / r
        return f > LEN_EPS ? scaleSpec(base, f) : null
      }
      return chain.factor > 0 && Number.isFinite(chain.factor)
        ? scaleSpec(base, chain.factor)
        : null
    }
  }
}

/** Ghost geometry for the set under the live transform (throwaway ids) -
 *  the SAME transformEntity the commit uses, so ghost == committed. */
export function transformPreviewEntities(
  chain: TransformChainState, entities: readonly SketchEntity[], cursor: Vec2,
): SketchEntity[] | null {
  const t = transformLiveSpec(chain, cursor)
  if (!t) return null
  const set = transformSetIds(entities, chain.ids)
  return entities
    .filter((e) => set.has(e.id))
    .map((e, i) => transformEntity(e, t, `__xf${i}__`))
}

// ---- Click behavior ------------------------------------------------------------------------------

export interface TransformClickOutcome {
  chain: TransformChainState | null
  notice: string | null
}

/**
 * CLICK(p) for an armed transform tool (flow in the header): set-toggle
 * until Confirm, then the placement clicks; the overlay's OK commits.
 * Re-clicking after the last placement re-places it.
 */
export function transformClick(
  op: TransformOp,
  chain: TransformChainState | null,
  entities: readonly SketchEntity[],
  world: Vec2,
  tol: number,
): TransformClickOutcome {
  const label = TRANSFORM_OP_LABEL[op]
  if (chain?.confirmed) {
    const p = { x: world.x, y: world.y }
    const base = chain.base
    if (!base) return { chain: { ...chain, base: p }, notice: null }
    switch (op) {
      case 'move':
        return { chain: { ...chain, ref: p, dx: p.x - base.x, dy: p.y - base.y }, notice: null }
      case 'rotate': {
        if (dist(p, base) < LEN_EPS) {
          return {
            chain,
            notice: `Rotate: click a point away from the centre to set the ${chain.ref ? 'target' : 'reference'} direction`,
          }
        }
        if (!chain.ref) return { chain: { ...chain, ref: p }, notice: null }
        return {
          chain: { ...chain, target: p, angleDeg: toDegrees(directionDelta(base, chain.ref, p)!) },
          notice: null,
        }
      }
      case 'scale': {
        if (dist(p, base) < LEN_EPS) {
          return { chain, notice: 'Scale: click a point away from the base point' }
        }
        if (!chain.ref || chain.target) {
          return { chain: { ...chain, ref: p, target: null }, notice: null }
        }
        const factor = dist(p, base) / dist(chain.ref, base)
        return { chain: { ...chain, target: p, factor }, notice: null }
      }
    }
  }

  // Set phase (an idle empty click stays quiet). The injected origin/axes
  // are never set members - a click that only finds them is a miss.
  const found = pickEntity(entities, world, tol)
  const hit = found && !isInjectedSketchAnchorId(found.id) ? found : null
  if (!chain && !hit) return { chain: null, notice: null }
  const current = chain ?? newTransformChain(op, [])
  if (!hit) {
    return {
      chain: current,
      notice: current.ids.length === 0
        ? `${label}: click entities to add them to the set`
        : `${label}: press Confirm (Enter) to close the set - or click more entities`,
    }
  }
  const ids = current.ids.includes(hit.id)
    ? current.ids.filter((id) => id !== hit.id)
    : [...current.ids, hit.id]
  return { chain: { ...current, ids }, notice: null }
}

/** Esc inside a transform: back one placement step, then reopen the set. */
export function transformEscape(chain: TransformChainState): TransformChainState | null {
  if (chain.target) return { ...chain, target: null }
  if (chain.ref) return { ...chain, ref: null }
  if (chain.base) return { ...chain, base: null }
  if (chain.confirmed) return { ...chain, confirmed: false }
  return null
}
