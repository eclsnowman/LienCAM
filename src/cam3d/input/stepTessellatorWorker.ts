// Browser-default StepTessellator: routes through the app's model-worker
// client (src/lib/cam/geometry/occt/model/modelClient.ts), so cam3d STEP
// imports share the ONE resident OCCT worker/wasm heap with the rest of the
// app (D-011) instead of spinning up a second kernel.
//
// This module is only ever loaded via dynamic import from step.ts when no
// tessellator was injected -- Node tests never touch it (modelClient depends
// on Worker + stepCache, which do not exist under vitest's node environment).

import { readStep } from '../../lib/cam/geometry/occt/model/modelClient';
import { fnv1a64Bytes } from './contentHash';
import type { StepTessellator } from './types';

export const workerStepTessellator: StepTessellator = async (bytes, params) => {
  // readStep TRANSFERS its buffer to the worker (detaching it). The
  // StepTessellator contract forbids consuming the caller's bytes (the budget
  // loop re-tessellates the same bytes), so hand the worker a private copy.
  const copy = bytes.slice().buffer;
  // Deterministic worker-registry id derived from content; cam3d imports are
  // not app geometry objects, so they get their own id namespace.
  const geoId = `cam3d-step-${fnv1a64Bytes(bytes)}`;
  const payload = await readStep(geoId, copy, 'cam3d STEP import', undefined, {
    linearDeflection: params.linearDeflection,
    angularDeflection: params.angularDeflection,
  });
  return {
    positions: payload.mesh.positions,
    indices: payload.mesh.indices,
    faceRanges: payload.mesh.faceRanges,
  };
};
