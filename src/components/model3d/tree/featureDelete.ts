import { isGenesisNodeId, type FeatureDag } from '../../../doc'
import { datumPlaneIdFromNodeId, sketch3dIdFromNodeId } from '../../../sketch3d'

export type FeatureDeletePlan =
  | {
      ok: true
      idsToRemove: ReadonlySet<string>
      removalOrder: string[]
    }
  | {
      ok: false
      datumId: string
      retainedConsumerIds: string[]
    }

/** Returns the private face-plane datum generated for a package sketch.
 * Matching both namespaced suffixes prevents a sketch that merely uses a
 * shared/base datum from claiming ownership of it. */
function generatedDatumForSketch(dag: FeatureDag, sketchId: string): string | undefined {
  const sketch = dag.getNode(sketchId)
  if (sketch?.kind !== 'sketch') return undefined
  const planeNodeId = (sketch.payload as { planeNodeId?: unknown }).planeNodeId
  if (typeof planeNodeId !== 'string' || isGenesisNodeId(planeNodeId)) return undefined
  const rawSketchId = sketch3dIdFromNodeId(sketchId)
  const rawDatumId = datumPlaneIdFromNodeId(planeNodeId)
  if (rawSketchId === undefined || rawDatumId !== rawSketchId) return undefined
  return dag.getNode(planeNodeId)?.kind === 'datum' ? planeNodeId : undefined
}

/** UI-55: plans one safe feature-tree delete. A face sketch owns its
 * generated datum only while every remaining reference belongs to the
 * sketch deletion closure. Both structural edges and planeNodeId payload
 * links are checked so a malformed/future consumer cannot be stranded. */
export function planFeatureDelete(dag: FeatureDag, id: string): FeatureDeletePlan {
  const idsToRemove = new Set([id, ...dag.transitiveConsumersOf(id)])
  const generatedDatumId = generatedDatumForSketch(dag, id)
  if (generatedDatumId !== undefined) {
    const retainedConsumerIds = dag.nodeIds().filter((nodeId) => {
      if (idsToRemove.has(nodeId)) return false
      const node = dag.getNode(nodeId)
      return node !== undefined
        && (node.consumes.includes(generatedDatumId)
          || (node.payload as { planeNodeId?: unknown }).planeNodeId === generatedDatumId)
    })
    if (retainedConsumerIds.length > 0) {
      return { ok: false, datumId: generatedDatumId, retainedConsumerIds }
    }
    idsToRemove.add(generatedDatumId)
  }
  return {
    ok: true,
    idsToRemove,
    removalOrder: dag.featureOrder().filter((nodeId) => idsToRemove.has(nodeId)).reverse(),
  }
}
