// cam3d L2: Primitive Services contract -- the ONLY kernel-facing API.
//
// This interface is THE boundary of the engine (architecture doc section 3).
// Strategies (L4) and field services (L3) see only this; they never import
// OCL, Clipper2, or three-mesh-bvh directly. Behind it the kernel is
// swappable (BvhKernel preview tier / OclKernel exact tier / future Rust)
// with zero strategy changes.
//
// Units: mm, Z-up, Z=0 at table surface.

/**
 * The cutter as a radial profile. One definition feeds drop tests, push
 * tests, sweep volumes, and engagement (architecture doc section 2).
 * Angles follow tool_angle_conventions.md: angleFromAxisDeg is measured
 * from the tool axis (canonical internal convention).
 */
export type CutterSpec =
  | { kind: 'flat'; diameter: number }
  | { kind: 'ball'; diameter: number }
  | { kind: 'bull'; diameter: number; cornerRadius: number }
  | {
      kind: 'vbit';
      diameter: number;
      angleFromAxisDeg: number;
      /** Tip flat diameter; 0 or absent = a sharp point (WO-1971). */
      tipDiameter?: number;
    };

/**
 * A regular sample grid for batched drop-cutter queries.
 * Row-major result layout: y is the OUTER loop, x the inner --
 * sample (ix, iy) lands at index iy * nx + ix, at world point
 * (x0 + ix * dx, y0 + iy * dy). zSeed is the drop FLOOR (typically the
 * table or stock bottom, i.e. BELOW the part): the cutter is dropped from
 * above and its CL z is raised to the highest contact, so every result is
 * >= zSeed, and zSeed itself is returned where no surface lies under the
 * cutter footprint (the miss policy). Matches OCL raise-from-seed
 * semantics.
 */
export type GridSpec = {
  x0: number;
  y0: number;
  nx: number;
  ny: number;
  dx: number;
  dy: number;
  zSeed: number;
};

/**
 * The one mesh format everything downstream consumes. STL and STEP imports
 * and procedural fixtures all normalize into this (one PartMesh, one engine
 * path -- MISSION.md M1).
 * - positions: xyz triples, mm.
 * - indices: triangle vertex indices into positions/3.
 * - bounds: axis-aligned, must match actual vertex extents.
 * - faceIds: optional per-triangle BRep face id (STEP imports), enables
 *   "machine selected faces" containment later.
 */
export type PartMesh = {
  positions: Float32Array;
  indices: Uint32Array;
  bounds: { min: [number, number, number]; max: [number, number, number] };
  faceIds?: Uint32Array;
  source: 'stl' | 'step' | 'model' | 'fixture';
};

// Branded handle types: plain numbers at runtime (cheap to pass over the
// worker/WASM boundary) but nominally typed, so a MeshHandle can never be
// passed where a CutterHandle is expected. The unique symbols exist only in
// the type system (declare const), never at runtime.
declare const meshHandleBrand: unique symbol;
declare const cutterHandleBrand: unique symbol;

export type MeshHandle = number & { readonly [meshHandleBrand]: 'MeshHandle' };
export type CutterHandle = number & { readonly [cutterHandleBrand]: 'CutterHandle' };

/**
 * L2 Primitive Services. Implementations: BvhKernel (fast/approximate
 * preview tier) and OclKernel (exact commit tier) -- both behind this one
 * interface; strategies never know which is running.
 *
 * Contract rules (architecture doc section 5):
 * - Mesh uploaded ONCE per part; all operations reference the handle.
 * - Batch-only boundary: one call per whole grid / whole path, never
 *   per-point.
 * - Every handle must be released (see kernel/registry.ts); use-after-
 *   release fails loud.
 * - Long operations honor AbortSignal between chunks and report progress.
 * - Deterministic: identical inputs -> identical outputs, fixed iteration
 *   order.
 */
export interface GeometryKernel {
  /** Upload a part mesh once; returns a handle all later calls reference. */
  uploadMesh(mesh: PartMesh): MeshHandle;
  releaseMesh(h: MeshHandle): void;

  makeCutter(spec: CutterSpec): CutterHandle;
  releaseCutter(c: CutterHandle): void;

  /**
   * Batched drop-cutter over a whole grid. Returns one z per sample,
   * row-major per GridSpec (length nx * ny): the lowest tool-tip z at which
   * the cutter touches but does not gouge the mesh.
   */
  dropGrid(
    m: MeshHandle,
    c: CutterHandle,
    g: GridSpec,
    opts?: {
      signal?: AbortSignal;
      onProgress?: (f: number) => void;
      /** Optional physical surface height at every grid axis. Implementations
       * fill this in the same grid traversal as the cutter-location result. */
      surfaceZ?: Float64Array;
    },
  ): Promise<Float64Array>;

  /**
   * Batched drop-cutter along an arbitrary polyline of (x, y) pairs
   * (xy.length = 2 * n). Returns n z values in input order.
   */
  dropPath(
    m: MeshHandle,
    c: CutterHandle,
    xy: Float64Array,
    zSeed: number,
    opts?: { signal?: AbortSignal },
  ): Promise<Float64Array>;

  /**
   * Batched drop-cutter at arbitrary (x, y) sample points (xy.length = 2 * n,
   * layout x0,y0,x1,y1,...). Returns n z values in input order, computed by
   * EXACTLY the same per-point contact math and miss policy as dropGrid
   * (every result >= zSeed; zSeed itself where nothing lies under the
   * footprint). Semantically dropPath under a sampling-oriented name: the
   * points need not form a connected polyline -- rotated-frame strategies
   * (parallel passes at arbitrary angles) batch whole scanlines of samples
   * through this in one call (batch-only boundary, D-005).
   * Empty input yields an empty output.
   */
  dropPoints(
    m: MeshHandle,
    c: CutterHandle,
    xy: Float64Array,
    zSeed: number,
    opts?: { signal?: AbortSignal },
  ): Promise<Float64Array>;

  /** Implementation name for diagnostics/DECISIONS logging (e.g. 'bvh', 'ocl'). */
  readonly name: string;

  // TODO(cam3d, later chunks): waterline(m, c, z, sampling), offset(polys,
  // delta), boolean(a, b, op), medialAxis(polys). Deliberately NOT stubbed
  // here -- they land with their implementations and tests, and a stub that
  // throws would be a silent-fallback trap for strategy code.
}
