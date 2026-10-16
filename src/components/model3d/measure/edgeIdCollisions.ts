// GEO-15-R1 (ICR-3 step 1) -- shared UI-side edge-id collision detector.
//
// The stable-id grammar keys a two-face edge on the UNORDERED adjacent-face
// pair only (src/geom/worker/stable-id.ts, docs/stable-id-spec.md), so two
// physically distinct edges that share one face pair collapse to the SAME
// stable id. Any picked-edge-id resolver that then first-wins (`edgeIds
// .indexOf(id)`) or last-wins silently binds the pick to the WRONG twin. This
// is the UI-lane twin of the worker's private #collidingPickedEdgeIds
// (geom-engine.ts): the two consumers live in different layers (the worker
// holds occt handles; the UI holds the tessellated CachedBody) and cannot
// share one module without crossing the worker/UI boundary, so the SAME small
// algorithm is mirrored here and pinned identical by the collision fixtures in
// both lanes. THREE-free on purpose -- faceBoundary.ts imports it and stays
// THREE-free for its src/sketch3d/** consumers.
//
// GEO-16 is the sequenced grammar extension + migration that will make every
// physical edge resolvable; until then every UI picked-edge-id resolver must
// REFUSE a pick that lands on a colliding id rather than guess a twin.

import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import type { StableId } from '../../../geom/geom-service'

export interface EdgeIdCollision {
  id: StableId
  /** Number of distinct physical edges on the body that carry this stable id
   *  (>= 2 for a reported collision). */
  count: number
}

/**
 * The REQUESTED (caller-picked) ids that collide -- i.e. whose multiplicity in
 * the body's full `edgeIds` list is >= 2 -- de-duplicated and deterministically
 * ordered by first appearance in `requested`. A collision the caller did NOT
 * pick is never reported (it is not this operation's problem), even though the
 * body may carry unrelated collisions elsewhere. Mirrors the worker's
 * #collidingPickedEdgeIds exactly.
 */
export function edgeIdCollisions(
  edgeIds: readonly StableId[],
  requested: readonly StableId[],
): EdgeIdCollision[] {
  const counts = new Map<StableId, number>()
  for (const id of edgeIds) counts.set(id, (counts.get(id) ?? 0) + 1)
  const seen = new Set<StableId>()
  const out: EdgeIdCollision[] = []
  for (const id of requested) {
    if (seen.has(id)) continue
    seen.add(id)
    const n = counts.get(id) ?? 0
    if (n >= 2) out.push({ id, count: n })
  }
  return out
}

/** Human-readable, id-naming refusal used by the UI measure resolvers'
 *  structured MeasureFailure. Names every colliding id and its collision
 *  count; states the grammar-collapse cause and that disambiguation is GEO-16. */
export function edgeIdCollisionMessage(collisions: readonly EdgeIdCollision[]): string {
  const named = collisions.map((c) => workbenchText('edgeIdCollisions.distinctEdgesShareThisStableId', { id: String(c.id), count: c.count })).join(', ')
  return (
    workbenchText('edgeIdCollisions.measureRefusedPickedEdgeCannotBeResolvedToA', { named: String(named) }) +
    workbenchText('edgeIdCollisions.theStableIdGrammarCollapsesTwoFaceEdgesThat') +
    workbenchText('edgeIdCollisions.icr3Step1DocsStableIdSpecMd') +
    workbenchText('edgeIdCollisions.grammarDisambiguationIsTrackedAsGEO16')
  )
}
