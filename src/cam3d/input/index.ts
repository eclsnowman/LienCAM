// cam3d Part Input Pipeline -- public API.
//
// STL and STEP both normalize into ONE PartMesh (kernel/types.ts); everything
// downstream is format-blind (D-007). STEP tessellation is CAM-driven
// (deflection = camTolerance/4, ~1.5M-triangle budget, effective deflection
// surfaced) via the in-house OCCT model kernel (D-011), with per-triangle
// BRep face ids preserved (D-008).
//
// NOTE: fixturePaths.ts (node-test-only Sample Parts resolver) is deliberately
// NOT re-exported here -- it imports node:fs and must stay out of browser
// bundles; tests import it by path.

export type {
  PartImportResult,
  StepTessellation,
  StepTessellationParams,
  StepTessellator,
} from './types';

export { importStlToPartMesh, parseStl, detectStlFormat } from './stl';
export type { StlImportOptions, StlFormat, ParsedStl } from './stl';

export {
  importStepToPartMesh,
  getStepImportCacheStats,
  _resetStepImportCacheForTest,
  DEFAULT_TRIANGLE_BUDGET,
  DEFAULT_ANGULAR_DEFLECTION_RAD,
} from './step';
export type { StepImportOptions } from './step';

export { sanitizeTriangleMesh } from './sanitize';
export type { SanitizedMesh } from './sanitize';

export { makeOcctCoreTessellator } from './occtCoreTessellator';
