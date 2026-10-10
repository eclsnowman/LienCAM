// cam3d worker protocol: the typed message contract between the main-thread
// client (client.ts) and the worker-side dispatcher (dispatcher.ts).
//
// Design rules:
// - Discriminated unions on `kind`. The dispatcher THROWS on unknown kinds:
//   a message this file does not describe is a protocol bug, and protocol
//   bugs must be loud, never silently ignored (MISSION.md fail-loud rule).
// - Every request carries a requestId from a monotonic per-client counter
//   (no Math.random / UUIDs: deterministic, collision-free within a client,
//   and trivially readable in logs). Every response names the request it
//   answers.
// - Large buffers cross the boundary as TRANSFERABLES, never copies: mesh
//   positions/indices and dropPath xy travel main -> worker; Float64Array z
//   results travel worker -> main. Transferring detaches the sender's view,
//   so client.ts documents which caller buffers are consumed.
// - `cancel` is the one request without a requestId or a response of its
//   own: the confirmation is the TARGET request answering with an
//   AbortError-shaped error response. Giving cancel its own reply would
//   mean a cancel/completion race produces two answers for one operation.

import type { CutterHandle, CutterSpec, GridSpec, MeshHandle, PartMesh } from '../kernel/types';
import type { Box3 } from '../stock';
import type { Ring } from '../geom2d';
import type { AdaptiveMillingDirection } from '../../lib/cam/types';
import type { PathBuildHeights } from '../pathbuild';
import type { ToolpathIR } from '../ir/types';
import type { OperationDiagnostics } from '../../types';
import type { Cam3dProgressDetail } from '../progress';

// Branded stock handle (same pattern as MeshHandle/CutterHandle in
// kernel/types.ts): a plain number at runtime, nominally typed so it can
// never be passed where a mesh or cutter handle is expected. Stock fields
// live in the WORKER (dispatcher registry), which is why the brand is
// declared here rather than in kernel/types.ts -- stock is not a kernel
// concept.
declare const stockHandleBrand: unique symbol;
export type StockHandle = number & { readonly [stockHandleBrand]: 'StockHandle' };

// ---- Requests (main -> worker) ----

/** Readiness ping; answers with the kernel implementation name. */
export type InitRequest = { kind: 'init'; requestId: number };

/** positions/indices (and faceIds if present) buffers are TRANSFERRED. */
export type UploadMeshRequest = { kind: 'uploadMesh'; requestId: number; mesh: PartMesh };

export type ReleaseMeshRequest = { kind: 'releaseMesh'; requestId: number; mesh: MeshHandle };

export type MakeCutterRequest = { kind: 'makeCutter'; requestId: number; spec: CutterSpec };

export type ReleaseCutterRequest = {
  kind: 'releaseCutter';
  requestId: number;
  cutter: CutterHandle;
};

export type DropGridRequest = {
  kind: 'dropGrid';
  requestId: number;
  mesh: MeshHandle;
  cutter: CutterHandle;
  grid: GridSpec;
  /** True only when the caller registered onProgress -- avoids posting
   *  progress traffic across the boundary that nobody is listening to. */
  wantProgress: boolean;
};

export type DropPathRequest = {
  kind: 'dropPath';
  requestId: number;
  mesh: MeshHandle;
  cutter: CutterHandle;
  /** (x, y) pairs, xy.length = 2 * n. Buffer is TRANSFERRED. */
  xy: Float64Array;
  zSeed: number;
  wantProgress: boolean;
};

// ---- stock ops (z-dexel stock lives worker-side; D-014) ----

/** Create a full stock box in the worker; answers with a StockHandle. */
export type StockCreateRequest = {
  kind: 'stockCreate';
  requestId: number;
  bounds: Box3;
  /** Requested cell size, mm (may be coarsened under the cell budget). */
  cellSize: number;
  /** Optional cell-budget override (defaults to DEFAULT_CELL_BUDGET). */
  budget?: number;
};

/**
 * Apply a BATCH of linear sweeps with one cutter, sequentially, in one
 * boundary call (D-005 batching). `moves` packs 6 f64 per move
 * (x0,y0,z0,x1,y1,z1); the buffer is TRANSFERRED.
 */
export type StockRemoveSweepRequest = {
  kind: 'stockRemoveSweep';
  requestId: number;
  stock: StockHandle;
  cutter: CutterSpec;
  moves: Float64Array;
};

/** Mesh the stock for display; positions/indices come back TRANSFERRED. */
export type StockToMeshRequest = {
  kind: 'stockToMesh';
  requestId: number;
  stock: StockHandle;
  /** Optional triangle-budget override (defaults to DEFAULT_TRIANGLE_BUDGET). */
  triangleBudget?: number;
};

export type StockDisposeRequest = {
  kind: 'stockDispose';
  requestId: number;
  stock: StockHandle;
};

// ---- strategies (L4 recipe runs entirely worker-side) ----

/**
 * Run the parallel (raster) finishing strategy. SELF-CONTAINED per D-005: the
 * whole PartMesh rides along (positions/indices/faceIds buffers are
 * TRANSFERRED) so the worker can upload it, run the strategy, and dispose the
 * handle in one boundary call -- no separate uploadMesh round-trip. The params
 * mirror ParallelFinishInput minus the mesh handle (created worker-side).
 */
export type ParallelFinishRequest = {
  kind: 'parallelFinish';
  requestId: number;
  mesh: PartMesh;
  cutter: CutterSpec;
  stepover: number;
  angleDeg: number;
  tolerance: number;
  surfaceStockToLeave?: number;
  maxSlopeDeg?: number;
  minFinishZ?: number;
  heights: PathBuildHeights;
  zSeed: number;
  boundary?: readonly Ring[];
  xyBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** WO-1271: the tool-centre region (see ParallelFinishInput.overrunBoundary). */
  overrunBoundary?: readonly Ring[];
  /** True only when the caller registered onProgress (see DropGridRequest). */
  wantProgress: boolean;
};

export type ScallopFinishRequest = {
  kind: 'scallopFinish';
  requestId: number;
  mesh: PartMesh;
  cutter: CutterSpec;
  scallopHeight: number;
  tolerance: number;
  surfaceStockToLeave?: number;
  minFinishZ?: number;
  direction: 'climb' | 'conventional';
  heights: PathBuildHeights;
  zSeed: number;
  boundary?: readonly Ring[];
  xyBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  wantProgress: boolean;
};

export type PencilFinishRequest = {
  kind: 'pencilFinish';
  requestId: number;
  mesh: PartMesh;
  cutter: CutterSpec;
  tolerance: number;
  stockToLeave?: number;
  minFinishZ?: number;
  direction: 'climb' | 'conventional';
  heights: PathBuildHeights;
  zSeed: number;
  boundary?: readonly Ring[];
  xyBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  wantProgress: boolean;
};

export type RestFinishRequest = {
  kind: 'restFinish';
  requestId: number;
  mesh: PartMesh;
  cutter: CutterSpec;
  referenceToolDiameter: number;
  referenceCornerRadius: number;
  tolerance: number;
  stockToLeave: number;
  stepdown: number;
  direction: 'climb' | 'conventional';
  spindleRotation: 'cw' | 'ccw';
  /** Caller-owned stock after replaying the explicit reference tool. */
  stock: StockHandle;
  stockBounds: Box3;
  cellSize: number;
  heights: PathBuildHeights;
  topZ: number;
  bottomZ: number;
  boundary?: readonly Ring[];
  /** Absent is the pre-WO-1209 previous-tool contract. */
  stockSource?: 'previous_operations' | 'previous_tool';
  wantProgress: boolean;
};

/**
 * Run the per-Z-level 3D adaptive rougher (strategies/adaptiveRough.ts).
 * SELF-CONTAINED per D-005, exactly like ParallelFinishRequest: the whole
 * PartMesh rides along (positions/indices/faceIds buffers are TRANSFERRED) so
 * the worker uploads it, runs the strategy, and disposes the handle in one
 * boundary call. The fields mirror AdaptiveRoughInput minus the mesh handle
 * (created worker-side). Unlike the finish request the rougher REQUIRES the
 * stock box + cell size (it carves stock), so both cross the boundary.
 */
export type AdaptiveRoughRequest = {
  kind: 'adaptiveRough';
  requestId: number;
  mesh: PartMesh;
  cutter: CutterSpec;
  stockBounds: Box3;
  cellSize: number;
  maxStepdown: number;
  /** Stepover as a FRACTION 0..1 of tool DIAMETER (the engagement knob). */
  stepover: number;
  millingDirection: AdaptiveMillingDirection;
  /** WO-1365: cut an extra terrace at the finish stepover before the full
   *  stepdown, trading rough time for less stair-stepping on curved/angled
   *  walls. false -> byte-identical to before (WO-1365 negative control). */
  intermediateStepdown: boolean;
  spindleRotation: 'cw' | 'ccw';
  wallLeadInRadius: number;
  wallLeadOutRadius: number;
  loopbackFilletPct: number;
  integralWallFollow: boolean;
  integralWallFollowLengthFactor: number;
  tolerance: number;
  helixDiameter: number;
  helixAngleDeg: number;
  radialStockToLeave?: number;
  axialStockToLeave?: number;
  heights: { clearanceZ: number; retractZ: number; feedZ: number };
  materialTopZ: number;
  /** WO-096: caller's assertion that stockBounds is real, complete stock
   *  containing this part. Absent/false -> the traverse guard proves nothing. */
  stockBoundsAreRealStock?: boolean;
  floorZ?: number;
  boundary?: readonly Ring[];
  /** Corner-reach (Stage C-2), mm the cut region is dilated past the stock edge
   *  (full-clear branch only; 0/undefined elsewhere). */
  reachStockEdgeBy?: number;
  /** OPT-IN side entry (outside-in); store-gated. undefined/false -> default helix. */
  sideEntry?: boolean;
  /**
   * WO-277: start this rough from the carved field a PREVIOUS rough RETAINED
   * (the `stockHandle` on its response) instead of a full stock box, so this
   * operation only works the material that one could not reach. Absent -> full
   * box, byte-identical to before.
   *
   * The worker REFUSES rather than adapts. The handle must be live (WO-274's
   * fail-loud path), must be the field the last rough retained -- retention is
   * one field at a time, so the reader is the operation immediately following --
   * and that rough must have been planned with the SAME stockBounds and
   * cellSize. Any mismatch answers with an error naming what differed; there is
   * deliberately no quiet fallback to a full box, because a quiet fallback is
   * how a caller never learns its sequencing is wrong.
   */
  startFromStock?: StockHandle;
  /** True only when the caller registered onProgress (see DropGridRequest). */
  wantProgress: boolean;
};

/**
 * Run the waterline (constant-Z) finishing strategy (strategies/waterline,
 * WO-1176). SELF-CONTAINED per D-005 exactly like ParallelFinishRequest: the
 * whole PartMesh rides along (positions/indices/faceIds buffers TRANSFERRED);
 * the worker uploads it to the kernel for the side/slope probes AND hands it
 * to the opencamlib slicer it hosts, runs the strategy, and releases the
 * handle in one boundary call. The fields mirror WaterlineFinishInput minus
 * the mesh handle (created worker-side).
 */
export type WaterlineRequest = {
  kind: 'waterline';
  requestId: number;
  mesh: PartMesh;
  cutter: CutterSpec;
  stepdown: number;
  /** Library sampling derived from the operation tolerance (one place: kernel/oclWaterline.ts). */
  sampling: { sampling: number; minSampling: number };
  stockToLeave: number;
  minSlopeDeg: number;
  flatAreaDetection: boolean;
  order: 'level' | 'region';
  direction: 'climb' | 'conventional';
  spindle: 'cw' | 'ccw';
  topZ: number;
  bottomZ: number;
  heights: PathBuildHeights;
  zSeed: number;
  boundary?: readonly Ring[];
  /** WO-1340: wider stock-edge tool-centre region; boundary stays unchanged. */
  overrunBoundary?: readonly Ring[];
  rampAngleDeg?: number;
  /** True only when the caller registered onProgress (see DropGridRequest). */
  wantProgress: boolean;
};

/**
 * Abort the in-flight request `targetRequestId`. Fire-and-forget: the target
 * request itself answers with an AbortError error response (or with its
 * normal result if completion won the race -- that race is legitimate).
 */
export type CancelRequest = { kind: 'cancel'; targetRequestId: number };

/** Release every live kernel handle and reset the dispatcher. */
export type DisposeRequest = { kind: 'dispose'; requestId: number };

export type Cam3dRequest =
  | InitRequest
  | UploadMeshRequest
  | ReleaseMeshRequest
  | MakeCutterRequest
  | ReleaseCutterRequest
  | DropGridRequest
  | DropPathRequest
  | StockCreateRequest
  | StockRemoveSweepRequest
  | StockToMeshRequest
  | StockDisposeRequest
  | ParallelFinishRequest
  | ScallopFinishRequest
  | PencilFinishRequest
  | RestFinishRequest
  | AdaptiveRoughRequest
  | WaterlineRequest
  | CancelRequest
  | DisposeRequest;

// ---- Responses (worker -> main) ----

export type InitDoneResponse = { kind: 'initDone'; requestId: number; kernelName: string };

export type MeshUploadedResponse = { kind: 'meshUploaded'; requestId: number; mesh: MeshHandle };

export type MeshReleasedResponse = { kind: 'meshReleased'; requestId: number };

export type CutterMadeResponse = { kind: 'cutterMade'; requestId: number; cutter: CutterHandle };

export type CutterReleasedResponse = { kind: 'cutterReleased'; requestId: number };

/** z buffer is TRANSFERRED back (no copy). */
export type GridDroppedResponse = { kind: 'gridDropped'; requestId: number; z: Float64Array };

/** z buffer is TRANSFERRED back (no copy). */
export type PathDroppedResponse = { kind: 'pathDropped'; requestId: number; z: Float64Array };

/** Grid facts ride along so callers can report cells/cell-size honestly. */
export type StockCreatedResponse = {
  kind: 'stockCreated';
  requestId: number;
  stock: StockHandle;
  nx: number;
  ny: number;
  /** Effective (post-coarsening) cell size, mm. */
  cell: number;
  /** Coarsening warnings -- loud across the boundary, never swallowed. */
  warnings: string[];
};

/** Batch totals across all moves in the request. */
export type StockSweptResponse = {
  kind: 'stockSwept';
  requestId: number;
  removedVolumeMm3: number;
  columnsChanged: number;
};

/** positions and indices buffers are TRANSFERRED back (no copy). */
export type StockMeshedResponse = {
  kind: 'stockMeshed';
  requestId: number;
  positions: Float32Array;
  indices: Uint32Array;
  vertexCount: number;
  triangleCount: number;
};

export type StockDisposedResponse = { kind: 'stockDisposed'; requestId: number };

/**
 * The strategy's ToolpathIR. NOTE: IR moves are plain objects (no bulk
 * ArrayBuffers), so there is nothing to transfer -- structured clone carries
 * it, which is correct: the transferable rule (D-014) is about bulk raw
 * buffers (mesh/z), not the modest move list.
 */
export type ParallelFinishedResponse = {
  kind: 'parallelFinished';
  requestId: number;
  ir: ToolpathIR;
};

export type ScallopFinishedResponse = {
  kind: 'scallopFinished';
  requestId: number;
  ir: ToolpathIR;
  /** WO-1540: plain-language notices for the app console (what was left out). */
  notices?: string[];
};

export type PencilFinishedResponse = {
  kind: 'pencilFinished';
  requestId: number;
  ir: ToolpathIR;
};

export type RestFinishedResponse = {
  kind: 'restFinished';
  requestId: number;
  ir: ToolpathIR;
};

/** The waterline strategy's ToolpathIR (WO-1176); same rationale as ParallelFinishedResponse. */
export type WaterlineFinishedResponse = {
  kind: 'waterlineFinished';
  requestId: number;
  ir: ToolpathIR;
};

/**
 * The rougher's ToolpathIR, plus an OPTIONAL carved-stock display mesh (Chunk
 * C3). The IR moves are plain objects (structured-clone, nothing to transfer,
 * same rationale as ParallelFinishedResponse). The carved-stock positions/
 * indices ARE bulk buffers -- when present they are TRANSFERRED back (D-014),
 * exactly like StockMeshedResponse. All stock* fields are auxiliary and ABSENT
 * on a mesh failure (ADR-0003 named fallback): the toolpath still returns, and
 * stockMeshWarning carries the reason the preview was skipped.
 */
export type AdaptiveRoughedResponse = {
  kind: 'adaptiveRoughed';
  requestId: number;
  ir: ToolpathIR;
  diagnostics?: OperationDiagnostics;
  /** WO-1540: plain-language notices for the app console (what was left out). */
  notices?: string[];
  /** Carved-stock mesh xyz triples (TRANSFERRED); absent on mesh failure. */
  stockPositions?: Float32Array;
  /** Carved-stock triangle indices (TRANSFERRED); absent on mesh failure. */
  stockIndices?: Uint32Array;
  stockVertexCount?: number;
  stockTriangleCount?: number;
  /** Set (mesh fields absent) when the carved-stock preview was skipped. */
  stockMeshWarning?: string;
  /**
   * WO-274: handle to the RETAINED carved field. The field itself stays
   * worker-side (D-014: bulk data never crosses the boundary) and stays LIVE in
   * the dispatcher's stock registry after the run -- until the next rough
   * retains its own field (one at a time), the caller stockDisposes it, or a
   * global dispose clears everything. Using the handle after any of those fails
   * loud. Absent when the strategy handed back no field; independent of the
   * stock* mesh fields above, which are a preview and may be skipped.
   */
  stockHandle?: StockHandle;
};

export type DisposedResponse = { kind: 'disposed'; requestId: number };

/** Interim progress for a long op; fraction in [0, 1]. */
export type ProgressEvent = {
  kind: 'progress';
  requestId: number;
  fraction: number;
  detail?: Cam3dProgressDetail;
};

/**
 * Serialized failure. `name` survives the boundary so callers can switch on
 * it exactly as they would on a local throw (e.g. name === 'AbortError').
 */
export type ErrorResponse = {
  kind: 'error';
  requestId: number;
  name: string;
  message: string;
  stack?: string;
};

export type Cam3dResponse =
  | InitDoneResponse
  | MeshUploadedResponse
  | MeshReleasedResponse
  | CutterMadeResponse
  | CutterReleasedResponse
  | GridDroppedResponse
  | PathDroppedResponse
  | StockCreatedResponse
  | StockSweptResponse
  | StockMeshedResponse
  | StockDisposedResponse
  | ParallelFinishedResponse
  | ScallopFinishedResponse
  | PencilFinishedResponse
  | RestFinishedResponse
  | AdaptiveRoughedResponse
  | WaterlineFinishedResponse
  | DisposedResponse
  | ProgressEvent
  | ErrorResponse;

/**
 * How the dispatcher talks back: postMessage on the worker side, or a plain
 * function in tests (dependency-injected so the core needs no worker global).
 */
export type PostResponse = (msg: Cam3dResponse, transfer?: Transferable[]) => void;
