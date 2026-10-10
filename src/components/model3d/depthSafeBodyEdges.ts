// Compatibility surface for existing Model imports. The implementation is
// shared by the CAM and Model body-presentation paths.
export {
  BODY_EDGE_NDC_DEPTH_BIAS as MODEL_EDGE_NDC_DEPTH_BIAS,
  installDepthSafeBodyEdgeBias,
} from '../../viewport3d/bodyPresentation'
