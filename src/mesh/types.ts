export type Vec3 = [number, number, number];

export interface MeshBuffers {
  positions: Float32Array;
  indices: Uint32Array;
}

export type MeshData = MeshBuffers;

export interface BoundingBox {
  min: Vec3;
  max: Vec3;
}

export type MeshBounds = BoundingBox;

export interface MeshMeasureResult {
  triangleCount: number;
  vertexCount: number;
  surfaceArea: number;
  volume: number;
  /** Signed volume (divergence-theorem sum over triangles, NOT abs()'d). A
   *  correctly outward-oriented closed mesh reports a POSITIVE value; a mesh
   *  with inverted (inward-facing) winding reports the same magnitude but
   *  NEGATIVE -- unlike `volume` (which is Math.abs(signedVolume) and cannot
   *  distinguish the two), this field is the real orientation check
   *  (MSH-2-R1.2). */
  signedVolume: number;
  bbox: BoundingBox;
  genus: number | null;
  componentCount: number;
}

export type MeshMeasures = MeshMeasureResult;

export interface MeshHealthReport {
  triangleCount: number;
  vertexCount: number;
  watertight: boolean;
  selfIntersections: boolean;
  holeCount: number;
  boundaryEdgeCount: number;
  nonManifoldEdgeCount: number;
  degenerateTriangleCount: number;
  duplicateTriangleCount: number;
  /** WO-1453: edges whose two adjacent triangles traverse them in the SAME
   *  direction instead of opposite directions -- a winding inversion that a
   *  fully edge-paired (boundary/non-manifold-free) mesh can still have, so
   *  `watertight` alone cannot catch it. */
  windingConflictEdgeCount: number;
  warnings: string[];
}

export interface MeshAnalyzeOptions {
  checkSelfIntersections?: boolean;
}

/** WO-1453: result of orientMesh(). */
export interface MeshOrientResult {
  mesh: MeshBuffers;
  /** triangles whose winding was reversed */
  flippedTriangleCount: number;
  /** winding conflicts left after orienting; nonzero = the surface cannot be oriented */
  windingConflictEdgeCount: number;
}

export interface MeshRepairResult {
  mesh: MeshBuffers;
  report: MeshHealthReport;
  measures: MeshMeasureResult;
  filledHoleCount: number;
  droppedDegenerateTriangleCount: number;
  /** WO-1453: triangles whose winding repair reversed (see orientMesh). */
  flippedTriangleCount: number;
}

export interface StlImportOptions extends MeshAnalyzeOptions {}

export interface StlImportResult {
  mesh: MeshBuffers;
  format: 'ascii' | 'binary';
  report: MeshHealthReport;
  measures: MeshMeasureResult;
}

export interface StlExportResult {
  bytes: ArrayBuffer;
  triangleCount: number;
}

export interface MeshInitOptions {
  requireManifold?: boolean;
}

export interface MeshKernelInfo {
  kernel: 'manifold-3d';
  version: '3.5.1';
  available: boolean;
  warning?: string;
}

export interface MeshStats {
  vertexCount: number;
  triangleCount: number;
}

export type MeshBooleanOperation = 'union' | 'difference' | 'intersect';

export interface MeshBooleanParams {
  operation: MeshBooleanOperation;
}

export type MeshPlaneCutKeep = 'positive' | 'negative' | 'both';

export interface MeshPlaneCutParams {
  normal: Vec3;
  offset: number;
  keep?: MeshPlaneCutKeep;
}

export interface MeshHollowParams {
  thickness: number;
}

export interface MeshMirrorParams {
  normal: Vec3;
}

export interface MeshTransformParams {
  translate?: Vec3;
  rotateDegrees?: Vec3;
  scale?: Vec3 | number;
  matrix?: number[];
}

export interface MeshDecimateParams {
  targetTriangleCount?: number;
  tolerance?: number;
  errorBound?: number;
}

export interface MeshOperationResult {
  mesh: MeshBuffers;
  report: MeshHealthReport;
  measures: MeshMeasureResult;
}

export interface MeshPlaneCutResult {
  positive?: MeshOperationResult;
  negative?: MeshOperationResult;
}

export function meshStats(mesh: MeshBuffers): MeshStats {
  return {
    vertexCount: mesh.positions.length / 3,
    triangleCount: mesh.indices.length / 3,
  };
}
