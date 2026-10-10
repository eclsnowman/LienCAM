// Body appearance belongs to the user's logical body lineage, not to a
// particular kernel handle. Every downstream solid result is published through
// one replay seam; this helper is the corresponding one policy for carrying a
// base body color across that replacement.

import type { DagNodeSnapshot, FeatureDag } from '../../../doc'
import { isWorkbenchBodyOpType } from '../bodyLineage'
import type { AppearanceStore } from './appearanceStore'

/**
 * Copy an upstream body color to a newly published body result when (and only
 * when) the result has no color of its own. A result's own color is therefore
 * always authoritative: both a user override and an already-published result
 * survive later edit/regeneration publication unchanged.
 *
 * The consumes graph identifies ordinary single-body replacements. Multi-body
 * operations declare their semantic survivor as `targetFeatureId`; use it only
 * after verifying it is one of the actual body parents, so malformed payloads
 * cannot borrow an unrelated body's appearance.
 */
export function inheritBodyAppearanceAtPublication(
  store: AppearanceStore,
  dag: FeatureDag,
  result: DagNodeSnapshot,
): string | undefined {
  if (store.bodyColor(result.id) !== undefined) return undefined
  if (!isWorkbenchBodyOpType(result.payload.opType)) return undefined

  const bodyParents = result.consumes.filter((id) => {
    const parent = dag.getNode(id)
    return parent !== undefined && isWorkbenchBodyOpType(parent.payload.opType)
  })
  const semanticTarget = result.payload.targetFeatureId
  const sourceId =
    typeof semanticTarget === 'string' && bodyParents.includes(semanticTarget)
      ? semanticTarget
      : bodyParents.length === 1
        ? bodyParents[0]
        : undefined
  if (sourceId === undefined) return undefined

  const sourceColor = store.bodyColor(sourceId)
  if (sourceColor === undefined) return undefined
  store.setBodyColor(result.id, sourceColor)
  return sourceId
}
