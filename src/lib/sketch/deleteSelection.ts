import type { Sketch, SketchEntity, SketchConstraint, SketchDimension } from './types'
import { constraintRefIds, dimensionRefIds } from './refIds'
import { patternGoverningIds } from './patterns'
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
//   - WO-2616 supersedes WO-1859: source deletion cascades to dependent
//     offsets and pattern copies; Break is the explicit way to keep free copies.

export interface DeleteSelectionResult {
  patterns?: Sketch['patterns']
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
  sketch: Pick<Sketch, 'entities' | 'constraints' | 'dimensions' | 'patterns'>,
  ids: readonly string[],
): DeleteSelectionResult | null {
  // A virtual center follows ordinary point deletion language: deleting the
  // selected node deletes its owning entity, then the existing dependency
  // cascade removes every persisted PointRef that names that owner.
  const idSet = new Set(ids.map(ownerIdForSelection))
  // A source deletion cascades through nested pattern definitions. Deleting
  // a member suppresses its entire instance and remains reversible by Edit.
  let patterns = sketch.patterns ?? []
  let changed = true
  while (changed) {
    changed = false
    patterns = patterns.map(pattern => {
      const keys = pattern.members.filter(m => idSet.has(m.id)).map(m => `${m.column},${m.row}`)
      if (!keys.length) return pattern
      for (const member of pattern.members) if (keys.includes(`${member.column},${member.row}`)) { if (!idSet.has(member.id)) changed = true; idSet.add(member.id) }
      return { ...pattern, suppressed: [...new Set([...pattern.suppressed, ...keys])] }
    })
    for (const entity of sketch.entities) {
      if (entity.offsetLink && entity.offsetLink.source.some(ref => idSet.has(ref.entityId)) && !idSet.has(entity.id)) {
        idSet.add(entity.id)
        changed = true
      }
    }
    patterns = patterns.filter(pattern => {
      if (!patternGoverningIds(pattern).some(id => idSet.has(id))) return true
      for (const member of pattern.members) idSet.add(member.id)
      changed = true
      return false
    })
  }


  const removedEntityIds = sketch.entities
    .filter((e) => idSet.has(e.id))
    .map((e) => e.id)
  const removedEntities = new Set(removedEntityIds)

  const entities = sketch.entities.filter(e => !idSet.has(e.id))
  const constraints = sketch.constraints.filter(
    (c) => !idSet.has(c.id) && !constraintRefIds(c).some((r) => removedEntities.has(r))
  )
  const dimensions = sketch.dimensions.filter(
    (d) => !idSet.has(d.id) && !dimensionRefIds(d).some((r) => removedEntities.has(r))
  )

  const unchanged =
    entities.length === sketch.entities.length &&
    constraints.length === sketch.constraints.length &&
    dimensions.length === sketch.dimensions.length
  return unchanged ? null : { entities, constraints, dimensions, removedEntityIds,
    ...(sketch.patterns ? { patterns } : {}) }
}
