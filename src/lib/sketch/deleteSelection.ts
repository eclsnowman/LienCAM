import type { Sketch, SketchEntity, SketchConstraint, SketchDimension } from './types'
import { constraintRefIds, dimensionRefIds, offsetSourceRefIds } from './refIds'
import { withoutOffsetLink } from './tools/offsetTool'
import { ownerIdForSelection } from './centerReferences'

// Delete-selection document transform (pulled forward from Stage 6 by
// user request). PURE: returns the new document arrays; the store applies
// them as one undo step and re-solves.
//
// Selection ids may name entities, constraints, or dimensions (the
// viewport pick returns all three kinds). Rules:
//   - a selected entity is removed, AND every constraint/dimension that
//     references it cascades away with it (a dangling reference would
//     fail EVERY future solve — the gcs mapping fails loud on unknown
//     ids, by design)
//   - a selected constraint/dimension is removed alone (its entities stay)
//   - WO-1859: an ASSOCIATIVE OFFSET whose source is being deleted does NOT
//     cascade. Deleting the source must leave the operator's offset standing
//     (rule 11: the software never destroys work to protect a reference), so
//     the entity stays and only its link is dropped — it becomes ordinary
//     geometry, exactly as if the link had been broken by hand. Unlike a
//     constraint reference, a dropped offset link cannot break a solve.

export interface DeleteSelectionResult {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
  dimensions: SketchDimension[]
  /** Ids of the ENTITIES that were removed (cascade roots). */
  removedEntityIds: string[]
}

/** Apply a delete of `ids` to the sketch. Returns null when the selection
 *  matched nothing (no edit — the caller skips the history push). Accepts
 *  any document view carrying the three arrays (modify tools pass their
 *  in-flight working copy, not a full Sketch). */
export function deleteFromSketch(
  sketch: Pick<Sketch, 'entities' | 'constraints' | 'dimensions'>,
  ids: readonly string[],
): DeleteSelectionResult | null {
  // A virtual center follows ordinary point deletion language: deleting the
  // selected node deletes its owning entity, then the existing dependency
  // cascade removes every persisted PointRef that names that owner.
  const idSet = new Set(ids.map(ownerIdForSelection))

  const removedEntityIds = sketch.entities
    .filter((e) => idSet.has(e.id))
    .map((e) => e.id)
  const removedEntities = new Set(removedEntityIds)

  let linksBroken = 0
  const entities = sketch.entities
    .filter((e) => !idSet.has(e.id))
    .map((e) => {
      if (!offsetSourceRefIds(e).some((r) => removedEntities.has(r))) return e
      linksBroken += 1
      return withoutOffsetLink(e)
    })
  const constraints = sketch.constraints.filter(
    (c) => !idSet.has(c.id) && !constraintRefIds(c).some((r) => removedEntities.has(r))
  )
  const dimensions = sketch.dimensions.filter(
    (d) => !idSet.has(d.id) && !dimensionRefIds(d).some((r) => removedEntities.has(r))
  )

  const unchanged =
    linksBroken === 0 &&
    entities.length === sketch.entities.length &&
    constraints.length === sketch.constraints.length &&
    dimensions.length === sketch.dimensions.length
  return unchanged ? null : { entities, constraints, dimensions, removedEntityIds }
}
