// Project/Use geometry is fixed: a CAM-layer projection is a static copy, and a model
// projection follows its source only through its live link (projectLink.ts, WO-1864).
// A geometric edit is the operator taking the piece over, so it releases the
// projection-time grounding AND the live link (an edited piece that kept following
// the model would undo the edit on the next model change), while retaining
// provenance so the reference color continues to explain its origin.

import type { SketchConstraint, SketchEntity } from './types'
import { withoutProjectionLink } from './projectLink'

/** Drop only Project/Use grounding, never a later user-authored Fix.
 *  Pre-marker files have projected provenance plus one unmarked automatic Fix;
 *  after this first edit, projectionDetached makes later unmarked Fixes durable. */
export function detachProjectedFixes(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  editedIds: readonly string[],
): SketchConstraint[] {
  const edited = new Set(editedIds)
  const projected = new Map(
    entities
      .filter((entity) => edited.has(entity.id) && entity.provenance === 'projected')
      .map((entity) => [entity.id, entity] as const),
  )
  if (projected.size === 0) return [...constraints]
  return constraints.filter((constraint) =>
    !(constraint.kind === 'fix'
      && constraint.entityId !== undefined
      && projected.has(constraint.entityId)
      && (constraint.projectionGrounding === true
        || projected.get(constraint.entityId)?.projectionDetached !== true)),
  )
}

/** Persist the edit lifecycle on changed projected hosts and their derived pieces. */
export function markProjectedGeometryDetached(
  sourceEntities: readonly SketchEntity[],
  resultEntities: readonly SketchEntity[],
  editedIds: readonly string[],
): SketchEntity[] {
  const edited = new Set(editedIds)
  const sourceIds = new Set(sourceEntities.map((entity) => entity.id))
  const hasProjectedEdit = sourceEntities.some((entity) =>
    edited.has(entity.id) && entity.provenance === 'projected')
  if (!hasProjectedEdit) return [...resultEntities]
  return resultEntities.map((entity) =>
    entity.provenance === 'projected'
      && (edited.has(entity.id) || !sourceIds.has(entity.id))
      ? { ...withoutProjectionLink(entity), projectionDetached: true }
      : entity,
  )
}

/** Geometry derived from any projected operand remains visibly projected. */
export function projectedProvenance(
  ...entities: readonly SketchEntity[]
): 'projected' | undefined {
  return entities.some((entity) => entity.provenance === 'projected')
    ? 'projected'
    : undefined
}
