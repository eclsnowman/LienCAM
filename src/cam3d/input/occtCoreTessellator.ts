// StepTessellator backed by DIRECT calls into the in-house OCCT model
// kernel's pure core (src/lib/cam/geometry/occt/model/core.ts) -- no Worker.
//
// This is the Node/vitest vehicle (mirrors src/tests/brep/model-core.test.ts:
// the caller loads the wasm module with loadOcctModel({ wasmBinary }) and
// hands it in). It is also usable anywhere a loaded oc module already exists.
//
// Statelessness is deliberate: each call re-runs read + heal + tessellate on
// the given bytes, so the tessellator is a pure function of (bytes, params)
// and the budget coarsening loop stays deterministic. The redundant re-read
// during coarsening costs milliseconds on realistic STEP files and only
// happens on budget overruns; the session-level import cache in step.ts makes
// repeated imports free anyway.

import { readStepShape, indexSubshapes, tessellate } from '../../lib/cam/geometry/occt/model/core';
import type { OcctModelModule } from '../../lib/cam/geometry/occt/model/loader';
import type { StepTessellator } from './types';

/** Build a StepTessellator from an already-loaded OCCT model module. */
export function makeOcctCoreTessellator(oc: OcctModelModule): StepTessellator {
  return async (bytes, params) => {
    const { shape } = readStepShape(oc, bytes, 'cam3d-step-import');
    try {
      const { faces, edges } = indexSubshapes(oc, shape);
      try {
        const result = tessellate(oc, shape, faces, edges, {
          linearDeflection: params.linearDeflection,
          angularDeflection: params.angularDeflection,
        });
        return {
          positions: result.mesh.positions,
          indices: result.mesh.indices,
          faceRanges: result.mesh.faceRanges,
        };
      } finally {
        for (const f of faces) f.delete();
        for (const e of edges) e.delete();
      }
    } finally {
      // cam3d only needs the mesh; the TopoDS_Shape does not stay resident
      // (unlike the app's model worker, which keeps it for derive requests).
      shape.delete();
    }
  };
}
