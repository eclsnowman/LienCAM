// viewport3d public surface (WO UI-1, extended WO UI-2). See
// docs/3d-modeling-plan.md 3.1/3.3.

export { GeometryCache, type CachedBody } from './GeometryCache';
export { PickEngine } from './PickEngine';
export { SelectionState, type SelectionListener } from './SelectionState';
export * from './types';

// WO UI-2 additions --------------------------------------------------------
export { COARSE_TESS_QUALITY, DISPLAY_TESS_QUALITY } from './tessQuality';
export {
  progressiveTessellate,
  progressiveTessellateAtQuality,
  type ProgressiveTessellateResult,
  type TessellatingClient,
  type TessPaintPhase,
  type TierQualities,
} from './progressiveTessellate';
export { pickAcrossBodies } from './multiBodyPick';
export {
  MODEL_EDGE_PICK_TOLERANCE_PX,
  screenSpaceEdgePickThresholds,
} from './screenSpacePick';
export { faceAreaFromMesh } from './faceArea';
export { featureAnchorFromMesh } from './featureAnchor';
export {
  BODY_EDGE_NDC_DEPTH_BIAS,
  applyBodyEdgeOverlayStyle,
  createBodyEdgeOverlay,
  createBodyPresentationPair,
  disposeBodyEdgeOverlay,
  disposeBodyPresentation,
  installDepthSafeBodyEdgeBias,
  setBodyPresentationVisible,
  syncBodyEdgeOverlayColors,
  syncBodyEdgeOverlayGeometry,
  syncBodyEdgeOverlayGeometryForVisibility,
  type BodyEdgeOverlay,
  type BodyEdgeOverlayOptions,
  type BodyEdgeOverlayStyle,
  type BodyPresentationPair,
} from './bodyPresentation';
export {
  INTERACTION_BODY_OUTLINE_WIDTH_PX,
  INTERACTION_EDGE_WIDTH_PX,
  INTERACTION_HOVER_ORANGE,
  INTERACTION_ORANGE,
  INTERACTION_SELECTED_EDGE_WIDTH_PX,
  SELECTED_BODY_VISUAL_CONTRACT,
  applySelectedBodyMaterialTint,
  createBodySilhouetteOverlay,
  createCachedBodyInteractionOverlay,
  createEdgeInteractionOverlay,
  createFaceInteractionOverlay,
  disposeInteractionOverlay,
  faceBoundarySegmentPositions,
  faceTrianglePositions,
  interactionOverlayVisibleForMode,
  restoreSelectedBodyMaterialTint,
  syncInteractionClipping,
  syncInteractionResolution,
  updateSelectedBodyMaterialTint,
  type FaceTriangleSource,
  type InteractionDisplayMode,
  type InteractionResolution,
  type InteractionVariant,
  type SelectedBodyMaterialState,
} from './interactionPresentation';
export {
  attachHighlightAttributes,
  applyBodyHighlight,
  applyEdgeHighlights,
  applyFaceHighlights,
  paintEdgeColor,
  computeEdgeVertexOffsets,
  DEFAULT_HIGHLIGHT_COLORS,
  DEFAULT_EDGE_HIGHLIGHT_COLORS,
  type HighlightColorSet,
} from './highlight';
export {
  GeomBridgeSession,
  type CreateBoxSpec,
  type CreateCutBoxSpec,
  type ImportedBodySummary,
  type AdoptedBodySummary,
} from './geomBridgeSession';
