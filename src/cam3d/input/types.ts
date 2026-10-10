// cam3d input pipeline: shared types.
//
// STL and STEP both normalize into ONE PartMesh (kernel/types.ts) so that
// everything downstream of the importer is format-blind (D-007). These types
// describe the importer's result envelope and the pluggable STEP tessellation
// seam (worker-backed in the browser, direct core.ts calls in Node tests).

import type { PartMesh } from '../kernel/types';

/** Result of importing a part file (either format). */
export interface PartImportResult {
  mesh: PartMesh;
  /** Human-readable non-fatal findings (dropped degenerates, open mesh, budget coarsening). */
  warnings: string[];
  /**
   * STEP only: the linear deflection (mm) actually used for tessellation.
   * Equals camTolerance/4 unless the triangle budget forced coarsening
   * (D-007: the effective deflection is always surfaced, never hidden).
   */
  effectiveDeflectionMm?: number;
  /** Triangles in the final (sanitized) mesh. */
  triangleCount: number;
}

/** BRepMesh-style tessellation parameters passed to the STEP tessellator. */
export interface StepTessellationParams {
  /** Linear (chord) deflection, mm. */
  linearDeflection: number;
  /** Angular deflection, radians. */
  angularDeflection: number;
}

/**
 * Raw tessellation of a STEP shape, as produced by the in-house OCCT model
 * kernel (D-011). faceRanges is the kernel's triangle->BRep-face mapping:
 * [firstIndexOffset, indexCount] per face, contiguous and ascending over the
 * whole indices array (asserted by the importer before deriving faceIds).
 */
export interface StepTessellation {
  positions: Float32Array;
  indices: Uint32Array;
  faceRanges: Uint32Array;
}

/**
 * The tessellation seam. Implementations MUST NOT detach/consume the caller's
 * bytes (the budget loop re-tessellates the same bytes at coarser deflection);
 * the worker-backed implementation copies before transferring.
 */
export type StepTessellator = (
  bytes: Uint8Array,
  params: StepTessellationParams,
) => Promise<StepTessellation>;
