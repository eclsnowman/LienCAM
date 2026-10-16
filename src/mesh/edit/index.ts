// WO-1845 / ADR-0051: an STL carries its edits as a replayed journal over its
// own bytes.
//
// Importing this module registers every shipped edit operation, so a consumer
// that resolves a journal never has to know which operations exist. A later
// slice adds its operation file to `./operations/` and one line below.

export type {
  MeshEditAncestry,
  MeshEditApplyInput,
  MeshEditApplyResult,
  MeshEditOperation,
  MeshEditRecord,
  MeshEditReplayResult,
  MeshEditReplayStop,
  MeshEditWitness,
} from './types';
export {
  NO_SOURCE_FACET,
  composeSourceFacetIds,
  facetCount,
  facetVertices,
  identityAncestry,
  sourceFacetIdsOf,
  vertexCount,
} from './idView';
export { computeWitness, witnessMismatch, WITNESS_RELATIVE_TOLERANCE } from './witness';
export {
  describeMeshEdit,
  getMeshEditOperation,
  listMeshEditOperations,
  registerMeshEditOperation,
} from './registry';
export { createMeshEditRecord, type NewMeshEdit } from './record';
export { replayMeshEdits } from './replay';
export { ancestryFromFacetOwners, composeMeshEditAncestry, mergeMeshEditAncestry } from './ancestry';
export {
  resolveEditedStlBytes,
  resolveEditedStlMesh,
  type ResolvedStlMesh,
} from './resolve';

// --- shipped operations (each registers itself on import) --------------------
export {
  flipFacetWindingOperation,
  FLIP_FACET_WINDING_KIND,
  FLIP_FACET_WINDING_VERSION,
} from './operations/flipFacetWinding';
export {
  removeRoundFeature,
  removeRoundFeatureOperation,
  roundFeatureRemovalRefusal,
  REMOVE_ROUND_FEATURE_KIND,
  REMOVE_ROUND_FEATURE_VERSION,
  type RemoveRoundFeatureParameters,
} from './operations/removeRoundFeature';
export {
  restoreSharpEdge,
  restoreSharpEdgeOperation,
  sharpEdgeRestorationRefusal,
  RESTORE_SHARP_EDGE_KIND,
  RESTORE_SHARP_EDGE_VERSION,
  type RestoreSharpEdgeParameters,
} from './operations/sharpEdgeRestoration';
export {
  changeBlendRadius,
  changeBlendRadiusOperation,
  blendRadiusChangeRefusal,
  CHANGE_BLEND_RADIUS_KIND,
  CHANGE_BLEND_RADIUS_VERSION,
  type ChangeBlendRadiusParameters,
} from './operations/edgeBlend';
export {
  moveFlatFace,
  moveFlatFaceOperation,
  flatFaceMoveOutcome,
  MOVE_FLAT_FACE_KIND,
  MOVE_FLAT_FACE_VERSION,
  type MoveFlatFaceParameters,
  type FlatFaceMoveOutcome,
} from './operations/planarOffset';
export {
  enlargeHole,
  enlargeHoleOperation,
  enlargeHoleRefusal,
  holeBreaksInto,
  primeBoringKernel,
  boreSegments,
  ENLARGE_HOLE_KIND,
  ENLARGE_HOLE_VERSION,
  type EnlargeHoleParameters,
} from './operations/enlargeHole';
export {
  booleanBody,
  booleanBodyOperand,
  booleanBodyOperation,
  booleanBodyRefusal,
  booleanBodySelection,
  BOOLEAN_BODY_KIND,
  BOOLEAN_BODY_VERSION,
  type BooleanBodyOperation,
  type BooleanBodyParameters,
  type BooleanBodyShape,
} from './operations/booleanBody';
export {
  changeChamferSize,
  chamferSizeChangeRefusal,
  changeChamferSizeOperation,
  CHANGE_CHAMFER_SIZE_KIND,
} from './operations/chamferSize';

export { MOVE_HOLE_KIND, moveHole, moveHoleOperation } from './operations/moveHole';
