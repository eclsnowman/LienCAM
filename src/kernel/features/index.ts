// WO-3002: kernel geometry identity and feature interface (alpha.3 A3-09, data
// slice: steps 1, 2, 3 and 5). Data only - nothing in the app consumes it yet.
// Not here by design: the shared binder (step 4) and the registry hook (step 6).
import { partFeatureList } from './identity'
import type { AdapterResult } from './adapters'
import type { FeatureSource, FeatureSourceScope, PartFeatureList, PartFrame } from './types'

export * from './types'
export { faceSignature, edgeSignature, edgeMeasure, geometrySignature, identifyFaces, identifyEdges, partFeatureList } from './identity'
export {
  facesFromSnapshots, edgesFromTessellation, fromStepCylinders, fromModelVerdicts, fromMeshRecognition, fromLoops,
  DEFINING_FIELDS, STEP_CYLINDER_KINDS, MODEL_FEATURE_CLASSES, MESH_ROUND_KINDS, MESH_REGION_KINDS, MESH_BLEND_KINDS, LOOP_TYPES,
  type AdapterResult, type ModelVerdictLike, type MeshRoundLike, type MeshRegionLike, type MeshBlendLike,
  type MeshRecognitionLike, type LoopLike, type FaceSnapshotLike, type TessEdgesLike,
} from './adapters'
export { assignIds, canonicalAxis, canonicalRing, contentHash, COORD_QUANTUM_MM, AREA_QUANTUM_MM2, DIRECTION_QUANTUM, type P3 } from './signature'

/** Recognition never blocks: a recogniser or adapter that throws on one body
 *  gives that body no features and one line saying so. */
export function recognisedFeatureList(frame: PartFrame, source: FeatureSource, recognise: () => AdapterResult, scope?: FeatureSourceScope): PartFeatureList {
  const owned = scope ? { scope: structuredClone(scope) } : {}
  let result: AdapterResult
  try { result = recognise() } catch (error) {
    return { ...partFeatureList(frame, source, [], [`${source} recognition failed on this body, so it lists no features (${error instanceof Error ? error.message : String(error)})`]), ...owned }
  }
  return { ...partFeatureList(frame, source, result.candidates, result.notes), ...owned }
}
