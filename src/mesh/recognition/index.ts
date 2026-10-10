// WO-1846: the round features LienCAM can prove in an imported STL,
// WO-1848: the fillets and chamfers it can prove along an edge, and
// WO-1854: the flat faces it can prove and an operator can pick.
//
// WHAT THIS DOOR OFFERS, AND WHO MAY USE IT. One named export per question
// about the part; nothing else in this directory is a public contract, and no
// consumer deep-imports `topology.ts`, `surfaces.ts` or `flatFaces.ts` around
// it.
//   `recognizeMeshFeatures` - "what round features does this part contain?"
//       WO-1847 (removal) and WO-1851 (toolpath targets) ask this.
//   `recognizeEdgeBlends`   - "what fillets and chamfers run along its edges?"
//       the panel's edge-blend list asks this.
//   `recognizeFlatFaces`    - "which parts of it are FLAT, and what shape is
//       each one?" WO-1848, WO-1849 (push/pull a face) and WO-1851 (a pocket
//       cut down to a flat floor) ask this. Answered once, here, so those three
//       do not each invent a flat-face pick of their own - which is the whole
//       reason WO-1854 exists.
// `flatFacePlaneBasis` rides beside the flat-face answer because a caller that
// projects an outline (the store, into a `Layer2D`) has to use the SAME basis
// the reported signed areas were measured in.
//
// WIDENED DELIBERATELY, TWICE, and this header is the record of both:
//  - WO-1848 (architect audit item 2) needed a tangency check its acceptance
//    said to take from WO-1846's door, and there was none there. Rather than
//    deep-import `surfaces.ts` around this contract, the edge-blend question
//    got its own named export - it is a question about the part, which is what
//    this door answers. The two mesh-EDIT operations WO-1848 ships reach
//    `./edgeBlends` directly instead, because they apply an explicit selection
//    rather than ask what the part proves; that reach is documented in
//    `src/mesh/edit/operations/sharpEdgeRestoration.ts`.
//  - WO-1854 (its own "door decision", made here once): two orders already
//    declared `depends-on: WO-1846 (planar regions)` and WO-1846 produced no
//    such thing. The flat-face question is the same KIND of question as the
//    other two, so it is answered by the same door rather than by a second
//    recogniser or by three consumers reaching past this file.

export { recognizeMeshFeatures } from './recognize';
export {
  DEFAULT_FEATURE_OPTIONS,
  type FeatureAxis,
  type FeatureBand,
  type FeatureKind,
  type FeatureRefusal,
  type MeshFeatureOptions,
  type MeshFeatureRecognition,
  type RecognizedFeature,
} from './types';
export { describeFeature, featureDiameterText } from './describe';
export { recognizeEdgeBlends, describeEdgeBlend, DEFAULT_EDGE_BLEND_OPTIONS } from './edgeBlends';
export type {
  EdgeBlendOptions,
  EdgeBlendRecognition,
  RecognizedEdgeBlend,
  SharpEdgeLine,
} from './edgeBlends';
export {
  recognizeFlatFaces,
  describeFlatFace,
  flatFacePlaneBasis,
  DEFAULT_FLAT_FACE_OPTIONS,
} from './flatFaces';
export type {
  FlatFaceOptions,
  FlatFaceOutline,
  FlatFacePlane,
  FlatFaceRecognition,
  FlatFaceSkip,
  RecognizedFlatFace,
} from './flatFaces';
