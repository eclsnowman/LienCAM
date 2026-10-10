// sketch3d -> 2D-mapping BRIDGE (WO SKC-6B, one-sketcher convergence stage B).
//
// Architect STEP-0 ruling (2026-07-08, binding): the 2D CAM sketcher's SUPERSET
// mapping (src/lib/sketch/solver/gcsMapping.ts) is the SURVIVOR. The sketch3d
// lab RE-EXPRESSES its document through the 2D mapping instead of maintaining a
// second solve path. This module is that re-expression: it translates the SKC
// document type (Sketch3dDocument, 4 entity kinds) into the 2D mapping's input
// model (Sketch), then routes the solve through gcsMapping.ts's
// sketchToGcsPrimitives / entitiesFromSolved. The SKC kinds and constraint set
// are a STRICT SUBSET of the 2D superset, so the translation is total — no
// feature is invented.
//
// The retired src/sketch3d/mapping.ts (second solve path) was DELETED in stage D
// (WO SKC-6D): NOTHING in the live solve path (solveService.ts, dragSession.ts)
// imported it anymore — this bridge supplies every function they used to pull
// from mapping.ts (primitive build, solved read-back, entity handles, updated
// positions, diagnostic-id mapping). The one pure non-solver helper it also held
// (sketch3dPointSamples) moved to the neutral src/sketch3d/pointSamples.ts.

import type { GcsWrapper, SketchPrimitive } from '@salusoft89/planegcs'
import {
  SketchMappingError,
  sketchToGcsPrimitives,
  entitiesFromSolved,
} from '../lib/sketch/solver/gcsMapping'
import type {
  Sketch,
  SketchConstraint,
  SketchDimension,
  SketchEntity,
  PointRef,
} from '../lib/sketch/types'
import type {
  Sketch3dConstraint,
  Sketch3dConstraintBase,
  Sketch3dDocument,
  Sketch3dEntity,
  Sketch3dEntityHandle,
  Sketch3dPointRef,
  Sketch3dUpdatedPosition,
  Sketch3dVec2,
} from './types'

// Kept name-compatible with the class the SKC solve path used to throw so the
// solveService's `instanceof` classification of invalid sketches is unchanged.
// (Defined here, not re-exported from mapping.ts, so mapping.ts is deletable.)
export class Sketch3dMappingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'Sketch3dMappingError'
  }
}

// ---- id validation (preserves the SKC input contract exactly) --------------
//
// The 2D gcs id scheme derives every primitive id from the owning document id
// with a ':' suffix, so a ':' inside a document id would corrupt conflict
// diagnosis. The SKC mapping forbade ':' and empty ids and rejected duplicate
// entity/constraint ids; this bridge reproduces those checks so the set of
// accepted/rejected documents is byte-identical to before the re-route.

function validateId(id: string, where: string): void {
  if (id.length === 0) throw new Sketch3dMappingError(where + ': id must not be empty')
  if (id.includes(':')) {
    throw new Sketch3dMappingError(where + ": id '" + id + "' must not contain ':'")
  }
}

// ---- Sketch3dDocument -> 2D Sketch -----------------------------------------

function toPointRef(ref: Sketch3dPointRef): PointRef {
  // Sketch3dPointSite ('self'|'start'|'end'|'center') is a strict subset of the
  // 2D PointSite union, so the ref passes through structurally unchanged.
  return { entityId: ref.entityId, site: ref.site }
}

function vec(v: Sketch3dVec2): { x: number; y: number } {
  return { x: v.x, y: v.y }
}

function translateEntity(entity: Sketch3dEntity): SketchEntity {
  const construction = entity.construction ?? false
  switch (entity.kind) {
    case 'point':
      return { id: entity.id, kind: 'point', construction, at: vec(entity.at) }
    case 'line':
      return { id: entity.id, kind: 'line', construction, start: vec(entity.start), end: vec(entity.end) }
    case 'circle':
      return { id: entity.id, kind: 'circle', construction, center: vec(entity.center), radius: entity.radius }
    case 'arc':
      // WO SKC-12: startAngle/endAngle pass through VERBATIM, and that is now correct by
      // construction -- every Sketch3dArcEntity is produced (draw AND drag) exclusively by
      // sketch3d-shared/draftEntities.ts's canonicalArcFromThreePoints, which stores plain
      // principal atan2 values with major/minor expressed via a start/end swap, matching the 2D
      // superset's own SketchArcEntity invariant (lib/sketch/types.ts:46-50, canonical CCW) byte
      // for byte. Before this WO this pass-through silently violated that invariant (SKC's old
      // signed-sweep encoding could store endAngle outside the principal range) -- see
      // SKETCH-CONVERGENCE-PLAN.md Section 2.4.
      return {
        id: entity.id,
        kind: 'arc',
        construction,
        center: vec(entity.center),
        radius: entity.radius,
        startAngle: entity.startAngle,
        endAngle: entity.endAngle,
      }
  }
}

const driving = (c: Sketch3dConstraintBase): boolean => c.driving ?? true

// Split one SKC constraint into the 2D document's constraint / dimension arrays.
// SKC unifies dimensions into its constraint array (driving flags on the base);
// the 2D superset keeps user-editable VALUE-bearing dims in a separate array.
function translateConstraint(
  constraint: Sketch3dConstraint,
  constraints: SketchConstraint[],
  dimensions: SketchDimension[],
  kindById: Map<string, Sketch3dEntity['kind']>,
): void {
  switch (constraint.kind) {
    case 'coincident':
      constraints.push({ id: constraint.id, kind: 'coincident', a: toPointRef(constraint.a), b: toPointRef(constraint.b) })
      return
    case 'horizontal':
    case 'vertical': {
      const points = constraint.points
        ? ([toPointRef(constraint.points[0]), toPointRef(constraint.points[1])] as [PointRef, PointRef])
        : undefined
      constraints.push({ id: constraint.id, kind: constraint.kind, line: constraint.line, points })
      return
    }
    case 'parallel':
      constraints.push({ id: constraint.id, kind: 'parallel', a: constraint.a, b: constraint.b })
      return
    case 'perpendicular':
      constraints.push({ id: constraint.id, kind: 'perpendicular', a: constraint.a, b: constraint.b })
      return
    case 'tangent':
      constraints.push({ id: constraint.id, kind: 'tangent', a: constraint.a, b: constraint.b })
      return
    case 'equal':
      constraints.push({ id: constraint.id, kind: 'equal', a: constraint.a, b: constraint.b })
      return
    case 'midpoint':
      constraints.push({ id: constraint.id, kind: 'midpoint', point: toPointRef(constraint.point), line: constraint.line })
      return
    case 'fixed': {
      // SKC 'fixed' -> 2D 'fix'. IMPORTANT semantic-preservation: a SKC
      // whole-entity fix grounds only the points the entity OWNS and never pins
      // a circle's radius (SKC mapConstraint('fixed') emits no primitive). The
      // 2D whole-entity fix on a CIRCLE additionally pins the radius (emits a
      // circle_radius constraint), which would (a) over-constrain a circle that
      // also carries a radius/diameter dim and (b) change its free-DoF count.
      // For a circle, therefore, translate a whole-entity fix into a fix on the
      // CENTER point only — reproducing SKC's "center grounded, radius free"
      // exactly. Arc/line/point whole-entity fixes are identical in both
      // mappings (arc grounds center+start+end via arc_rules, no radius pin), so
      // they pass through as whole-entity fixes.
      if (constraint.entityId !== undefined && kindById.get(constraint.entityId) === 'circle') {
        constraints.push({ id: constraint.id, kind: 'fix', point: { entityId: constraint.entityId, site: 'center' } })
      } else {
        constraints.push({ id: constraint.id, kind: 'fix', point: constraint.point ? toPointRef(constraint.point) : undefined, entityId: constraint.entityId })
      }
      return
    }
    case 'distance':
      if (constraint.b !== undefined && constraint.line !== undefined) {
        throw new Sketch3dMappingError(constraint.id + ': set either b or line, not both')
      } else if (constraint.line !== undefined) {
        // point-to-line perpendicular distance
        dimensions.push({ id: constraint.id, kind: 'distancePL', driving: driving(constraint), value: constraint.value, point: toPointRef(constraint.a), line: constraint.line })
      } else if (constraint.b !== undefined) {
        dimensions.push({ id: constraint.id, kind: 'distance', driving: driving(constraint), value: constraint.value, a: toPointRef(constraint.a), b: toPointRef(constraint.b) })
      } else {
        throw new Sketch3dMappingError(constraint.id + ': distance needs b (point) or line')
      }
      return
    case 'angle':
      dimensions.push({ id: constraint.id, kind: 'angle', driving: driving(constraint), value: constraint.value, a: constraint.a, b: constraint.b })
      return
    case 'radius':
      dimensions.push({ id: constraint.id, kind: 'radius', driving: driving(constraint), value: constraint.value, entityId: constraint.entityId })
      return
    case 'diameter':
      dimensions.push({ id: constraint.id, kind: 'diameter', driving: driving(constraint), value: constraint.value, entityId: constraint.entityId })
      return
  }
}

/**
 * Translate a Sketch3dDocument into the 2D mapping's Sketch input model. A SKC
 * point entity's `fixed` flag becomes a synthesized 2D `fix` constraint (the 2D
 * model has no per-entity fixed flag — grounding is always a constraint). Fails
 * loud on the same inputs the SKC mapping rejected (empty/':'/duplicate ids).
 */
export function sketch3dToSketch(document: Sketch3dDocument): Sketch {
  const entities: SketchEntity[] = []
  const seenEntity = new Set<string>()
  const kindById = new Map<string, Sketch3dEntity['kind']>()
  for (const entity of document.entities) {
    validateId(entity.id, 'entity')
    if (seenEntity.has(entity.id)) throw new Sketch3dMappingError("duplicate entity id '" + entity.id + "'")
    seenEntity.add(entity.id)
    kindById.set(entity.id, entity.kind)
    entities.push(translateEntity(entity))
  }

  const constraints: SketchConstraint[] = []
  const dimensions: SketchDimension[] = []
  const seenConstraint = new Set<string>()
  for (const constraint of document.constraints) {
    validateId(constraint.id, 'constraint')
    if (seenConstraint.has(constraint.id)) {
      throw new Sketch3dMappingError("duplicate constraint id '" + constraint.id + "'")
    }
    seenConstraint.add(constraint.id)
    translateConstraint(constraint, constraints, dimensions, kindById)
  }

  // A fixed point entity grounds itself: synthesize a 2D fix constraint. The id
  // carries no ':' so it never collides with the gcs id scheme, and a point-only
  // fix emits NO primitive (grounding happens via the fixed param at push time),
  // so this id is never a solver/diagnosis id.
  for (const entity of document.entities) {
    if (entity.kind === 'point' && entity.fixed) {
      const fixId = '__sketch3d_fixed_' + entity.id
      if (seenConstraint.has(fixId)) throw new Sketch3dMappingError("synthesized fix id collides: '" + fixId + "'")
      seenConstraint.add(fixId)
      constraints.push({ id: fixId, kind: 'fix', point: { entityId: entity.id, site: 'self' } })
    }
  }

  return { id: document.id, layerId: 'sketch3d', entities, constraints, dimensions, solveStatus: null }
}

// The 2D mapping INTERLEAVES each entity's points with its geometry primitive,
// whereas the pre-route SKC mapping pushed ALL points first, then ALL geometry,
// then ALL arc_rules, then constraints in document order. planegcs registers a
// point's params in push order, and that order perturbs DogLeg's floating-point
// convergence path (~1e-6 in the solved coordinates) even when the constraint
// network is identical. That noise is normally invisible, but the SKC lab's
// incremental "add one constraint, re-solve" flow can land a near-singular
// tangent+radius arc configuration on either side of a rank boundary, flipping
// the reported DOF by 1. To keep the SKC solve numerically identical to the
// pre-route behavior (so every shipped sketch3d behavioral assertion holds), the
// bridge RE-ORDERS gcsMapping's output back into the SKC push order. This is a
// pure reordering of the SAME primitives gcsMapping produced — gcsMapping.ts is
// untouched, so the 2D CAM path's own push order (and its golden/perf) is
// unaffected.
const GEOMETRY_TYPES = new Set(['line', 'circle', 'arc'])

function reorderLikeSkcPushOrder(primitives: SketchPrimitive[], document: Sketch3dDocument): SketchPrimitive[] {
  const points: SketchPrimitive[] = []
  const geometry: SketchPrimitive[] = []
  const rules: SketchPrimitive[] = []
  const rest: SketchPrimitive[] = []
  for (const primitive of primitives) {
    if (primitive.type === 'point') points.push(primitive)
    else if (primitive.type === 'arc_rules') rules.push(primitive)
    else if (GEOMETRY_TYPES.has(primitive.type)) geometry.push(primitive)
    else rest.push(primitive)
  }
  // Constraint/dimension primitives back to ORIGINAL document constraint order
  // (the 2D mapping emits all plain constraints, then all dimensions; SKC emitted
  // them interleaved in document order). Stable within one owner so a multi-
  // primitive constraint keeps its internal order.
  const docIndex = new Map<string, number>()
  document.constraints.forEach((constraint, i) => docIndex.set(constraint.id, i))
  const orderedRest = rest
    .map((primitive, i) => ({ primitive, i }))
    .sort((a, b) => {
      const oa = docIndex.get(ownerId(a.primitive.id)) ?? Number.MAX_SAFE_INTEGER
      const ob = docIndex.get(ownerId(b.primitive.id)) ?? Number.MAX_SAFE_INTEGER
      return oa - ob || a.i - b.i
    })
    .map((x) => x.primitive)
  return [...points, ...geometry, ...rules, ...orderedRest]
}

/**
 * Build the planegcs primitive list for a SKC document THROUGH the 2D mapping.
 * Any mapping rejection (unknown ref, wrong-kind target, bad structure) is
 * surfaced as Sketch3dMappingError so the caller's invalid-sketch classification
 * is preserved regardless of which layer raised it.
 */
export function sketch3dToPrimitives(document: Sketch3dDocument): { sketch: Sketch; primitives: SketchPrimitive[] } {
  let sketch: Sketch
  try {
    sketch = sketch3dToSketch(document)
    const primitives = reorderLikeSkcPushOrder(sketchToGcsPrimitives(sketch), document)
    return { sketch, primitives }
  } catch (error) {
    if (error instanceof Sketch3dMappingError) throw error
    if (error instanceof SketchMappingError) throw new Sketch3dMappingError(error.message)
    throw error
  }
}

/**
 * Rebuild SKC entities from a solved wrapper, routed through the 2D mapping's
 * entitiesFromSolved. The original SKC document supplies the fields the 2D
 * entity does not carry (a point's `fixed` flag) and the canonical id order.
 */
export function sketch3dEntitiesFromSolved(
  document: Sketch3dDocument,
  sketch: Sketch,
  wrapper: GcsWrapper,
): Sketch3dEntity[] {
  const solved2d = entitiesFromSolved(sketch, (id) => wrapper.sketch_index.get_primitive(id))
  const byId = new Map(solved2d.map((entity) => [entity.id, entity]))
  return document.entities.map((entity): Sketch3dEntity => {
    const s = byId.get(entity.id)
    switch (entity.kind) {
      case 'point':
        return s && s.kind === 'point' ? { ...entity, at: vec(s.at) } : entity
      case 'line':
        return s && s.kind === 'line' ? { ...entity, start: vec(s.start), end: vec(s.end) } : entity
      case 'circle':
        return s && s.kind === 'circle' ? { ...entity, center: vec(s.center), radius: s.radius } : entity
      case 'arc':
        return s && s.kind === 'arc'
          ? { ...entity, center: vec(s.center), radius: s.radius, startAngle: s.startAngle, endAngle: s.endAngle }
          : entity
    }
  })
}

// ---- pure output shaping (relocated verbatim from mapping.ts) ---------------
//
// Handles / updated positions / diagnostic-id mapping are pure functions over
// the SKC document — they never touched planegcs. Moved here so the live solve
// path no longer imports mapping.ts (WO acceptance #1).

function pointFromPolar(center: Sketch3dVec2, radius: number, angle: number): Sketch3dVec2 {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }
}

function cloneVec2(value: Sketch3dVec2): Sketch3dVec2 {
  return { x: value.x, y: value.y }
}

export function sketch3dEntityHandles(document: Sketch3dDocument): Sketch3dEntityHandle[] {
  return document.entities.map((entity) => {
    switch (entity.kind) {
      case 'point':
        return { entityId: entity.id, kind: entity.kind, pointIds: { self: entity.id } }
      case 'line':
        return {
          entityId: entity.id,
          kind: entity.kind,
          geometryId: entity.id,
          pointIds: { start: entity.id + ':start', end: entity.id + ':end' },
        }
      case 'circle':
        return {
          entityId: entity.id,
          kind: entity.kind,
          geometryId: entity.id,
          pointIds: { center: entity.id + ':center' },
        }
      case 'arc':
        return {
          entityId: entity.id,
          kind: entity.kind,
          geometryId: entity.id,
          pointIds: {
            center: entity.id + ':center',
            start: entity.id + ':start',
            end: entity.id + ':end',
          },
          ruleId: entity.id + ':rules',
        }
    }
  })
}

export function positionsFromEntities(entities: Sketch3dEntity[]): Sketch3dUpdatedPosition[] {
  return entities.map((entity) => {
    switch (entity.kind) {
      case 'point':
        return { entityId: entity.id, kind: 'point', at: cloneVec2(entity.at) }
      case 'line':
        return { entityId: entity.id, kind: 'line', start: cloneVec2(entity.start), end: cloneVec2(entity.end) }
      case 'circle':
        return { entityId: entity.id, kind: 'circle', center: cloneVec2(entity.center), radius: entity.radius }
      case 'arc':
        return {
          entityId: entity.id,
          kind: 'arc',
          center: cloneVec2(entity.center),
          start: pointFromPolar(entity.center, entity.radius, entity.startAngle),
          end: pointFromPolar(entity.center, entity.radius, entity.endAngle),
          radius: entity.radius,
          startAngle: entity.startAngle,
          endAngle: entity.endAngle,
        }
    }
  })
}

function ownerId(gcsId: string): string {
  const i = gcsId.indexOf(':')
  return i === -1 ? gcsId : gcsId.slice(0, i)
}

export function mapDiagnosticIds(ids: string[]): string[] {
  const mapped: string[] = []
  const seen = new Set<string>()
  for (const id of ids) {
    const owner = ownerId(id)
    if (!seen.has(owner)) {
      seen.add(owner)
      mapped.push(owner)
    }
  }
  return mapped
}
