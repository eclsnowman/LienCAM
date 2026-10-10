// cam3d main-thread client: promise-per-request wrapper over the cam3d
// worker, following the proven modelClient.ts pattern (request id -> pending
// map -> resolve/reject on response; progress routing; loud error surfacing).
//
// The surface mirrors GeometryKernel one-to-one but every method is async
// (worker hop), so this class does not `implements GeometryKernel` -- the
// sync-returning uploadMesh/releaseMesh/makeCutter/releaseCutter signatures
// cannot line up. Callers that want kernel-shaped code await the handles.
//
// Cancellation: dropGrid/dropPath take an AbortSignal. Abort sends a
// `cancel` message; the promise then rejects when the WORKER confirms with
// an AbortError response (we do not reject locally on abort, because a
// completion that beat the abort across the boundary is real, valid data
// and is resolved normally -- same semantics as aborting a settled fetch).

import type {
  CutterHandle,
  CutterSpec,
  GridSpec,
  MeshHandle,
  PartMesh,
} from '../kernel/types';
import type { Box3, LinearMove, StockMesh, SweepResult } from '../stock';
import type {
  Cam3dRequest,
  Cam3dResponse,
  CancelRequest,
  DisposeRequest,
  StockHandle,
} from './protocol';
import type { Ring } from '../geom2d';
import type { PathBuildHeights } from '../pathbuild';
import type { ToolpathIR } from '../ir/types';
import type { OperationDiagnostics } from '../../types';
import type { AdaptiveMillingDirection } from '../../lib/cam/types';
import type { Cam3dProgressCallback } from '../progress';

/**
 * Everything the parallel-finish strategy needs, carried in one request. The
 * mesh crosses as a whole PartMesh (buffers transferred); heights and zSeed
 * are required by the strategy (the L4 recipe has no defaults for them).
 */
export type ParallelFinishClientInput = {
  partMesh: PartMesh;
  cutter: CutterSpec;
  /** Pass spacing, mm (> 0). */
  stepover: number;
  /** Pass direction, degrees CCW from +X. 0/90/180/270 are exact. */
  angleDeg: number;
  /** Max chordal deviation of the sampled polyline from the surface, mm. */
  tolerance: number;
  /** Material left along the sampled 3D surface normal, mm. */
  surfaceStockToLeave?: number;
  /** Shallow-area ceiling from horizontal; 0/undefined preserves whole-part output. */
  maxSlopeDeg?: number;
  /** Lowest cutter-tip Z to finish. */
  minFinishZ?: number;
  heights: PathBuildHeights;
  /** Drop floor / miss value, mm. */
  zSeed: number;
  /** Containment region (geom2d convention: outers CCW, holes CW). */
  boundary?: readonly Ring[];
  /** Containment fallback when no boundary is given: the part's xy bounds. */
  xyBounds?: { minX: number; minY: number; maxX: number; maxY: number };
  /** WO-1271: the tool-centre region (see ParallelFinishInput.overrunBoundary). */
  overrunBoundary?: readonly Ring[];
};

export type ScallopFinishClientInput = {
  partMesh: PartMesh;
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
};

export type PencilFinishClientInput = {
  partMesh: PartMesh;
  cutter: CutterSpec;
  tolerance: number;
  stockToLeave?: number;
  minFinishZ?: number;
  direction: 'climb' | 'conventional';
  heights: PathBuildHeights;
  zSeed: number;
  boundary?: readonly Ring[];
  xyBounds?: { minX: number; minY: number; maxX: number; maxY: number };
};

export type RestFinishClientInput = {
  partMesh: PartMesh;
  cutter: CutterSpec;
  referenceToolDiameter: number;
  referenceCornerRadius: number;
  tolerance: number;
  stockToLeave: number;
  stepdown: number;
  direction: 'climb' | 'conventional';
  spindleRotation: 'cw' | 'ccw';
  stock: StockHandle;
  stockBounds: Box3;
  cellSize: number;
  heights: PathBuildHeights;
  topZ: number;
  bottomZ: number;
  boundary?: readonly Ring[];
  /** Remaining-stock authority; absent preserves the legacy reference-tool IR. */
  stockSource?: 'previous_operations' | 'previous_tool';
};

/**
 * Everything the waterline strategy needs (WO-1176), carried in one request.
 * Mirrors ParallelFinishClientInput: the mesh crosses as a whole PartMesh
 * (worker-owned copies transferred, see generateWaterline).
 */
export type WaterlineClientInput = {
  partMesh: PartMesh;
  cutter: CutterSpec;
  /** Level spacing, mm (> 0). */
  stepdown: number;
  /** Library sampling derived from the operation tolerance (kernel/oclWaterline.ts). */
  sampling: { sampling: number; minSampling: number };
  /** Radial allowance, mm (>= 0). */
  stockToLeave: number;
  /** 0 = whole part; else drop runs shallower than this angle from horizontal. */
  minSlopeDeg: number;
  flatAreaDetection: boolean;
  order: 'level' | 'region';
  direction: 'climb' | 'conventional';
  spindle: 'cw' | 'ccw';
  /** Top of the band (Material Start), mm. */
  topZ: number;
  /** Bottom of the band (Cutter End), mm. */
  bottomZ: number;
  heights: PathBuildHeights;
  /** Drop floor for the kernel probes, mm. */
  zSeed: number;
  /** Optional containment (geom2d convention: outers CCW, holes CW). */
  boundary?: readonly Ring[];
  /** WO-1340: wider stock-edge tool-centre region; boundary stays unchanged. */
  overrunBoundary?: readonly Ring[];
  rampAngleDeg?: number;
};

/**
 * Everything the adaptive rougher needs, carried in one request. Mirrors
 * ParallelFinishClientInput; the mesh crosses as a whole PartMesh (worker-owned
 * copies transferred, see generateAdaptiveRough). Unlike the finish input the
 * rougher REQUIRES a stock box + cell size (it carves stock).
 */
export type AdaptiveRoughClientInput = {
  partMesh: PartMesh;
  cutter: CutterSpec;
  /** Stock box the ZDexelField is built from (Box3, mm). */
  stockBounds: Box3;
  /** Requested stock/part grid cell size, mm (coarsened loudly under budget). */
  cellSize: number;
  /** Max axial depth of cut per level, mm. */
  maxStepdown: number;
  /** Stepover as a FRACTION 0..1 of tool DIAMETER (the engagement knob). */
  stepover: number;
  /** Physical milling direction for a clockwise spindle. */
  millingDirection?: AdaptiveMillingDirection;
  /** WO-1365: cut an extra terrace at the finish stepover before the full
   *  stepdown, trading rough time for less stair-stepping on curved/angled
   *  walls. Absent/false -> byte-identical to before (WO-1365 negative control). */
  intermediateStepdown?: boolean;
  /** Physical rotation; the production operation adapter always supplies this. */
  spindleRotation?: 'cw' | 'ccw';
  wallLeadInRadius?: number;
  wallLeadOutRadius?: number;
  loopbackFilletPct?: number;
  integralWallFollow?: boolean;
  integralWallFollowLengthFactor?: number;
  /** Chordal tolerance, mm. */
  tolerance: number;
  /** Entry helix diameter, mm. */
  helixDiameter: number;
  /** Entry helix descent angle from horizontal, degrees. */
  helixAngleDeg: number;
  /** Radial finish stock left on part walls, mm (default 0). */
  radialStockToLeave?: number;
  /** Axial finish stock left on the floor, mm (default 0). */
  axialStockToLeave?: number;
  heights: { clearanceZ: number; retractZ: number; feedZ: number };
  materialTopZ: number;
  /** WO-096: caller's assertion that stockBounds is real, complete stock
   *  containing this part. Absent/false -> the traverse guard proves nothing and
   *  every below-clearance link is routed over the clearance plane. */
  stockBoundsAreRealStock?: boolean;
  /** Optional floor override; default computed from the part. */
  floorZ?: number;
  /** Optional job clip region (geom2d convention: outers CCW, holes CW). */
  boundary?: readonly Ring[];
  /** Corner-reach (Stage C-2), mm the cut region is dilated past the stock edge
   *  (full-clear branch only; 0/undefined elsewhere). */
  reachStockEdgeBy?: number;
  /** OPT-IN side entry (outside-in); store-gated. undefined/false -> default helix. */
  sideEntry?: boolean;
  /**
   * WO-277: start from the carved field a previous rough RETAINED (its
   * `carvedStockHandle`) instead of a full stock box, so this operation only
   * works the material that one could not reach. Absent -> full box.
   *
   * The worker REFUSES rather than adapts: a stale handle, a handle that is not
   * the last rough's retained field, or a field carved against different
   * stockBounds/cellSize all reject with a message naming the difference. There
   * is no quiet fallback to a full box -- sequencing mistakes must be visible.
   */
  startFromStock?: StockHandle;
};

/** stockCreate result: the handle plus the grid facts for honest reporting. */
export type StockCreated = {
  stock: StockHandle;
  nx: number;
  ny: number;
  /** Effective (post-coarsening) cell size, mm. */
  cell: number;
  warnings: string[];
};

/**
 * The slice of Worker the client uses. A real DOM Worker satisfies it;
 * tests inject a fake wired straight to a Cam3dDispatcher.
 */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  terminate(): void;
  onmessage: ((ev: MessageEvent) => void) | null;
  onerror: ((ev: ErrorEvent) => void) | null;
}

/** Error rethrown on the main thread; name comes from the worker verbatim. */
export class Cam3dWorkerError extends Error {
  /** Stack captured inside the worker (this Error's own .stack is local). */
  workerStack?: string;

  constructor(name: string, message: string, workerStack?: string) {
    super(message);
    this.name = name;
    this.workerStack = workerStack;
  }
}

/** AbortError-shaped local error (plain Error: DOMException is not
 *  guaranteed in every runtime, and callers switch on .name anyway). */
function makeAbortError(message: string): Error {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

type DropOpts = {
  signal?: AbortSignal;
  onProgress?: Cam3dProgressCallback;
  /** WO-1540: receives each operator notice the strategy returned beside its IR. */
  onNotice?: (message: string) => void;
};

type Pending = {
  /** Receives the terminal (non-progress, non-error) response. */
  resolve: (msg: Cam3dResponse) => void;
  reject: (err: Error) => void;
  onProgress?: Cam3dProgressCallback;
  /** Detaches the abort listener once the request settles. */
  cleanup?: () => void;
};

export class Cam3dClient {
  private readonly worker: WorkerLike;
  /** Monotonic, never random: deterministic and collision-free per client. */
  private nextRequestId = 1;
  private readonly pending = new Map<number, Pending>();
  private disposed = false;
  /** Set once the worker crashes: after this no request has a responder, so
   *  any send() (or a dispose round-trip) would hang forever waiting. */
  private dead = false;

  constructor(worker: WorkerLike | (() => WorkerLike)) {
    this.worker = typeof worker === 'function' ? worker() : worker;
    this.worker.onmessage = (ev: MessageEvent) => this.onMessage(ev.data as Cam3dResponse);
    // A worker-level error (script load failure, unhandled throw) kills every
    // in-flight request; reject them all loudly (modelClient.ts pattern) and
    // mark the client dead so later calls fail fast instead of hanging.
    this.worker.onerror = (ev: ErrorEvent) => {
      this.dead = true;
      this.failAll(
        new Cam3dWorkerError(
          'Cam3dWorkerCrash',
          `cam3d worker failed: ${ev.message || 'unknown worker error'}`,
        ),
      );
    };
  }

  // ---- GeometryKernel mirror (async) ----

  /** Readiness ping; resolves with the kernel implementation name. */
  async init(): Promise<string> {
    const msg = await this.send('initDone', { kind: 'init', requestId: this.takeId() });
    return msg.kernelName;
  }

  /**
   * Upload a part mesh once; resolves with the handle all later calls use.
   * NOTE: mesh.positions/indices (and faceIds) buffers are TRANSFERRED to
   * the worker and detached here -- pass copies if you still need them.
   */
  async uploadMesh(mesh: PartMesh): Promise<MeshHandle> {
    const transfer: Transferable[] = [
      mesh.positions.buffer as ArrayBuffer,
      mesh.indices.buffer as ArrayBuffer,
    ];
    if (mesh.faceIds !== undefined) transfer.push(mesh.faceIds.buffer as ArrayBuffer);
    const msg = await this.send(
      'meshUploaded',
      { kind: 'uploadMesh', requestId: this.takeId(), mesh },
      { transfer },
    );
    return msg.mesh;
  }

  async releaseMesh(mesh: MeshHandle): Promise<void> {
    await this.send('meshReleased', { kind: 'releaseMesh', requestId: this.takeId(), mesh });
  }

  async makeCutter(spec: CutterSpec): Promise<CutterHandle> {
    const msg = await this.send('cutterMade', {
      kind: 'makeCutter',
      requestId: this.takeId(),
      spec,
    });
    return msg.cutter;
  }

  async releaseCutter(cutter: CutterHandle): Promise<void> {
    await this.send('cutterReleased', {
      kind: 'releaseCutter',
      requestId: this.takeId(),
      cutter,
    });
  }

  /** Batched drop-cutter over a grid; z buffer arrives transferred. */
  async dropGrid(
    mesh: MeshHandle,
    cutter: CutterHandle,
    grid: GridSpec,
    opts?: DropOpts,
  ): Promise<Float64Array> {
    const msg = await this.send(
      'gridDropped',
      {
        kind: 'dropGrid',
        requestId: this.takeId(),
        mesh,
        cutter,
        grid,
        wantProgress: opts?.onProgress !== undefined,
      },
      opts,
    );
    return msg.z;
  }

  /**
   * Batched drop-cutter along a polyline of (x, y) pairs.
   * NOTE: xy's buffer is TRANSFERRED to the worker and detached here.
   */
  async dropPath(
    mesh: MeshHandle,
    cutter: CutterHandle,
    xy: Float64Array,
    zSeed: number,
    opts?: DropOpts,
  ): Promise<Float64Array> {
    const msg = await this.send(
      'pathDropped',
      {
        kind: 'dropPath',
        requestId: this.takeId(),
        mesh,
        cutter,
        xy,
        zSeed,
        wantProgress: opts?.onProgress !== undefined,
      },
      { ...opts, transfer: [xy.buffer as ArrayBuffer] },
    );
    return msg.z;
  }

  // ---- stock ops (worker-side z-dexel stock) ----

  /** Create a full stock box IN THE WORKER; resolves with handle + grid facts. */
  async stockCreate(bounds: Box3, cellSize: number, budget?: number): Promise<StockCreated> {
    const msg = await this.send('stockCreated', {
      kind: 'stockCreate',
      requestId: this.takeId(),
      bounds,
      cellSize,
      ...(budget !== undefined ? { budget } : {}),
    });
    return {
      stock: msg.stock,
      nx: msg.nx,
      ny: msg.ny,
      cell: msg.cell,
      warnings: msg.warnings,
    };
  }

  /**
   * Apply a batch of linear sweeps with one cutter in ONE boundary call;
   * resolves with the batch totals. The moves are packed into a Float64Array
   * (6 per move) that is TRANSFERRED -- callers keep their LinearMove
   * objects, nothing of theirs is detached.
   */
  async stockRemoveSweep(
    stock: StockHandle,
    cutter: CutterSpec,
    moves: readonly LinearMove[],
  ): Promise<SweepResult> {
    const packed = new Float64Array(moves.length * 6);
    for (let k = 0; k < moves.length; k++) {
      const m = moves[k];
      const o = k * 6;
      packed[o] = m.x0;
      packed[o + 1] = m.y0;
      packed[o + 2] = m.z0;
      packed[o + 3] = m.x1;
      packed[o + 4] = m.y1;
      packed[o + 5] = m.z1;
    }
    const msg = await this.send(
      'stockSwept',
      {
        kind: 'stockRemoveSweep',
        requestId: this.takeId(),
        stock,
        cutter,
        moves: packed,
      },
      { transfer: [packed.buffer as ArrayBuffer] },
    );
    return { removedVolumeMm3: msg.removedVolumeMm3, columnsChanged: msg.columnsChanged };
  }

  /** Mesh the stock for display; positions/indices arrive TRANSFERRED. */
  async stockToMesh(stock: StockHandle, triangleBudget?: number): Promise<StockMesh> {
    const msg = await this.send('stockMeshed', {
      kind: 'stockToMesh',
      requestId: this.takeId(),
      stock,
      ...(triangleBudget !== undefined ? { triangleBudget } : {}),
    });
    return {
      positions: msg.positions,
      indices: msg.indices,
      vertexCount: msg.vertexCount,
      triangleCount: msg.triangleCount,
    };
  }

  /** Release one stock field; use-after-dispose of the handle fails loud. */
  async stockDispose(stock: StockHandle): Promise<void> {
    await this.send('stockDisposed', {
      kind: 'stockDispose',
      requestId: this.takeId(),
      stock,
    });
  }

  // ---- strategies (L4, run entirely worker-side) ----

  /**
   * Run the parallel (raster) finishing strategy in the worker and resolve
   * with its ToolpathIR. Self-contained per D-005: the request carries the
   * whole PartMesh plus the cutter spec and params; the worker uploads the
   * mesh, runs the strategy, and disposes the mesh handle before answering
   * (upload-per-generate for M1).
   *
   * NON-DESTRUCTIVE: the caller's PartMesh is frequently SHARED (the STEP
   * importer memoizes its result mesh, and a regenerate -- changing stepover/
   * angle/tolerance and re-running -- reuses that exact cached mesh). Transfer
   * detaches the source buffers, so sending the caller's own buffers would
   * leave the cached mesh dead and every regenerate would throw "ArrayBuffer
   * already detached" on the second post. We therefore upload worker-owned
   * COPIES of positions/indices/faceIds and transfer those, leaving the source
   * mesh intact. Still zero-copy across the boundary; the extra main-thread
   * copy is one budget-capped preview mesh per generate.
   *
   * Cancellation and progress use the same plumbing as dropGrid/dropPath:
   * opts.signal aborts cooperatively (the worker threads it into the kernel
   * drop batches) and settles as an AbortError response; opts.onProgress
   * receives coarse fractions in [0, 1].
   */
  async generateParallelFinish(
    input: ParallelFinishClientInput,
    opts?: DropOpts,
  ): Promise<ToolpathIR> {
    const { partMesh } = input;
    // Worker-owned copies so transfer never detaches the caller's (cached) mesh.
    const meshForWorker: PartMesh = {
      ...partMesh,
      positions: partMesh.positions.slice(),
      indices: partMesh.indices.slice(),
      ...(partMesh.faceIds !== undefined ? { faceIds: partMesh.faceIds.slice() } : {}),
    };
    const transfer: Transferable[] = [
      meshForWorker.positions.buffer as ArrayBuffer,
      meshForWorker.indices.buffer as ArrayBuffer,
    ];
    if (meshForWorker.faceIds !== undefined) transfer.push(meshForWorker.faceIds.buffer as ArrayBuffer);
    const msg = await this.send(
      'parallelFinished',
      {
        kind: 'parallelFinish',
        requestId: this.takeId(),
        mesh: meshForWorker,
        cutter: input.cutter,
        stepover: input.stepover,
        angleDeg: input.angleDeg,
        tolerance: input.tolerance,
        ...(input.surfaceStockToLeave !== undefined
          ? { surfaceStockToLeave: input.surfaceStockToLeave }
          : {}),
        ...(input.maxSlopeDeg !== undefined ? { maxSlopeDeg: input.maxSlopeDeg } : {}),
        ...(input.minFinishZ !== undefined ? { minFinishZ: input.minFinishZ } : {}),
        heights: input.heights,
        zSeed: input.zSeed,
        ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
        ...(input.xyBounds !== undefined ? { xyBounds: input.xyBounds } : {}),
        ...(input.overrunBoundary !== undefined ? { overrunBoundary: input.overrunBoundary } : {}),
        wantProgress: opts?.onProgress !== undefined,
      },
      { ...opts, transfer },
    );
    return msg.ir;
  }

  async generateScallopFinish(
    input: ScallopFinishClientInput,
    opts?: DropOpts,
  ): Promise<ToolpathIR> {
    const { partMesh } = input;
    const meshForWorker: PartMesh = {
      ...partMesh,
      positions: partMesh.positions.slice(),
      indices: partMesh.indices.slice(),
      ...(partMesh.faceIds !== undefined ? { faceIds: partMesh.faceIds.slice() } : {}),
    };
    const transfer: Transferable[] = [
      meshForWorker.positions.buffer as ArrayBuffer,
      meshForWorker.indices.buffer as ArrayBuffer,
    ];
    if (meshForWorker.faceIds !== undefined) transfer.push(meshForWorker.faceIds.buffer as ArrayBuffer);
    const msg = await this.send(
      'scallopFinished',
      {
        kind: 'scallopFinish',
        requestId: this.takeId(),
        mesh: meshForWorker,
        cutter: input.cutter,
        scallopHeight: input.scallopHeight,
        tolerance: input.tolerance,
        ...(input.surfaceStockToLeave !== undefined ? { surfaceStockToLeave: input.surfaceStockToLeave } : {}),
        ...(input.minFinishZ !== undefined ? { minFinishZ: input.minFinishZ } : {}),
        direction: input.direction,
        heights: input.heights,
        zSeed: input.zSeed,
        ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
        ...(input.xyBounds !== undefined ? { xyBounds: input.xyBounds } : {}),
        wantProgress: opts?.onProgress !== undefined,
      },
      { ...opts, transfer },
    );
    for (const notice of msg.notices ?? []) opts?.onNotice?.(notice);
    return msg.ir;
  }

  async generatePencilFinish(input: PencilFinishClientInput, opts?: DropOpts): Promise<ToolpathIR> {
    const { partMesh } = input;
    const meshForWorker: PartMesh = {
      ...partMesh,
      positions: partMesh.positions.slice(),
      indices: partMesh.indices.slice(),
      ...(partMesh.faceIds !== undefined ? { faceIds: partMesh.faceIds.slice() } : {}),
    };
    const transfer: Transferable[] = [
      meshForWorker.positions.buffer as ArrayBuffer,
      meshForWorker.indices.buffer as ArrayBuffer,
    ];
    if (meshForWorker.faceIds !== undefined) transfer.push(meshForWorker.faceIds.buffer as ArrayBuffer);
    const msg = await this.send('pencilFinished', {
      kind: 'pencilFinish', requestId: this.takeId(), mesh: meshForWorker,
      cutter: input.cutter, tolerance: input.tolerance,
      ...(input.stockToLeave !== undefined ? { stockToLeave: input.stockToLeave } : {}),
      ...(input.minFinishZ !== undefined ? { minFinishZ: input.minFinishZ } : {}),
      direction: input.direction, heights: input.heights, zSeed: input.zSeed,
      ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
      ...(input.xyBounds !== undefined ? { xyBounds: input.xyBounds } : {}),
      wantProgress: opts?.onProgress !== undefined,
    }, { ...opts, transfer });
    return msg.ir;
  }

  async generateRestFinish(input: RestFinishClientInput, opts?: DropOpts): Promise<ToolpathIR> {
    const { partMesh } = input;
    const meshForWorker: PartMesh = {
      ...partMesh,
      positions: partMesh.positions.slice(),
      indices: partMesh.indices.slice(),
      ...(partMesh.faceIds !== undefined ? { faceIds: partMesh.faceIds.slice() } : {}),
    };
    const transfer: Transferable[] = [
      meshForWorker.positions.buffer as ArrayBuffer,
      meshForWorker.indices.buffer as ArrayBuffer,
    ];
    if (meshForWorker.faceIds !== undefined) transfer.push(meshForWorker.faceIds.buffer as ArrayBuffer);
    const msg = await this.send('restFinished', {
      kind: 'restFinish', requestId: this.takeId(), mesh: meshForWorker,
      cutter: input.cutter,
      referenceToolDiameter: input.referenceToolDiameter,
      referenceCornerRadius: input.referenceCornerRadius,
      tolerance: input.tolerance,
      stockToLeave: input.stockToLeave,
      stepdown: input.stepdown,
      direction: input.direction,
      spindleRotation: input.spindleRotation,
      stock: input.stock,
      stockBounds: input.stockBounds,
      cellSize: input.cellSize,
      heights: input.heights,
      topZ: input.topZ,
      bottomZ: input.bottomZ,
      ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
      ...(input.stockSource !== undefined ? { stockSource: input.stockSource } : {}),
      wantProgress: opts?.onProgress !== undefined,
    }, { ...opts, transfer });
    return msg.ir;
  }

  /**
   * Run the waterline (constant-Z) finishing strategy in the worker (WO-1176)
   * and resolve with its ToolpathIR. Self-contained per D-005 and
   * NON-DESTRUCTIVE exactly like generateParallelFinish: worker-owned copies of
   * positions/indices/faceIds are transferred, the caller's mesh stays intact.
   * Cancellation/progress use the same plumbing (opts.signal / opts.onProgress).
   */
  async generateWaterline(input: WaterlineClientInput, opts?: DropOpts): Promise<ToolpathIR> {
    const { partMesh } = input;
    const meshForWorker: PartMesh = {
      ...partMesh,
      positions: partMesh.positions.slice(),
      indices: partMesh.indices.slice(),
      ...(partMesh.faceIds !== undefined ? { faceIds: partMesh.faceIds.slice() } : {}),
    };
    const transfer: Transferable[] = [
      meshForWorker.positions.buffer as ArrayBuffer,
      meshForWorker.indices.buffer as ArrayBuffer,
    ];
    if (meshForWorker.faceIds !== undefined) transfer.push(meshForWorker.faceIds.buffer as ArrayBuffer);
    const msg = await this.send(
      'waterlineFinished',
      {
        kind: 'waterline',
        requestId: this.takeId(),
        mesh: meshForWorker,
        cutter: input.cutter,
        stepdown: input.stepdown,
        sampling: input.sampling,
        stockToLeave: input.stockToLeave,
        minSlopeDeg: input.minSlopeDeg,
        flatAreaDetection: input.flatAreaDetection,
        order: input.order,
        direction: input.direction,
        spindle: input.spindle,
        topZ: input.topZ,
        bottomZ: input.bottomZ,
        heights: input.heights,
        zSeed: input.zSeed,
        ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
        ...(input.overrunBoundary !== undefined ? { overrunBoundary: input.overrunBoundary } : {}),
        ...(input.rampAngleDeg !== undefined ? { rampAngleDeg: input.rampAngleDeg } : {}),
        wantProgress: opts?.onProgress !== undefined,
      },
      { ...opts, transfer },
    );
    return msg.ir;
  }

  /**
   * Run the per-Z-level 3D adaptive rougher in the worker and resolve with its
   * ToolpathIR. Self-contained per D-005, mirroring generateParallelFinish: the
   * request carries the whole PartMesh plus cutter/stock/params; the worker
   * uploads the mesh, runs the strategy, and disposes the handle before
   * answering.
   *
   * NON-DESTRUCTIVE (identical rationale to generateParallelFinish): the
   * caller's PartMesh is frequently SHARED (importer-memoized, reused across
   * regenerate). Transfer detaches source buffers, so we upload worker-owned
   * COPIES of positions/indices/faceIds and transfer THOSE, leaving the source
   * mesh intact -- still zero-copy across the boundary.
   *
   * Cancellation/progress use the same plumbing as generateParallelFinish:
   * opts.signal aborts cooperatively (settles as an AbortError response);
   * opts.onProgress receives coarse per-level fractions in [0, 1].
   */
  async generateAdaptiveRough(
    input: AdaptiveRoughClientInput,
    opts?: DropOpts,
  ): Promise<{
    ir: ToolpathIR;
    carvedStock?: StockMesh;
    carvedStockWarning?: string;
    diagnostics?: OperationDiagnostics;
    carvedStockHandle?: StockHandle;
  }> {
    const { partMesh } = input;
    // Worker-owned copies so transfer never detaches the caller's (cached) mesh.
    const meshForWorker: PartMesh = {
      ...partMesh,
      positions: partMesh.positions.slice(),
      indices: partMesh.indices.slice(),
      ...(partMesh.faceIds !== undefined ? { faceIds: partMesh.faceIds.slice() } : {}),
    };
    const transfer: Transferable[] = [
      meshForWorker.positions.buffer as ArrayBuffer,
      meshForWorker.indices.buffer as ArrayBuffer,
    ];
    if (meshForWorker.faceIds !== undefined)
      transfer.push(meshForWorker.faceIds.buffer as ArrayBuffer);
    const msg = await this.send(
      'adaptiveRoughed',
      {
        kind: 'adaptiveRough',
        requestId: this.takeId(),
        mesh: meshForWorker,
        cutter: input.cutter,
        stockBounds: input.stockBounds,
        cellSize: input.cellSize,
        maxStepdown: input.maxStepdown,
        stepover: input.stepover,
        millingDirection: input.millingDirection ?? 'climb',
        intermediateStepdown: input.intermediateStepdown ?? false,
        spindleRotation: input.spindleRotation ?? 'cw',
        wallLeadInRadius: input.wallLeadInRadius ?? 0,
        wallLeadOutRadius: input.wallLeadOutRadius ?? 0,
        loopbackFilletPct: input.loopbackFilletPct ?? 25,
        integralWallFollow: input.integralWallFollow ?? true,
        integralWallFollowLengthFactor: input.integralWallFollowLengthFactor ?? 2,
        tolerance: input.tolerance,
        helixDiameter: input.helixDiameter,
        helixAngleDeg: input.helixAngleDeg,
        ...(input.radialStockToLeave !== undefined
          ? { radialStockToLeave: input.radialStockToLeave }
          : {}),
        ...(input.axialStockToLeave !== undefined
          ? { axialStockToLeave: input.axialStockToLeave }
          : {}),
        heights: input.heights,
        materialTopZ: input.materialTopZ,
        ...(input.stockBoundsAreRealStock ? { stockBoundsAreRealStock: true } : {}),
        ...(input.floorZ !== undefined ? { floorZ: input.floorZ } : {}),
        ...(input.boundary !== undefined ? { boundary: input.boundary } : {}),
        ...(input.reachStockEdgeBy !== undefined
          ? { reachStockEdgeBy: input.reachStockEdgeBy }
          : {}),
        ...(input.sideEntry ? { sideEntry: true } : {}),
        ...(input.startFromStock !== undefined ? { startFromStock: input.startFromStock } : {}),
        wantProgress: opts?.onProgress !== undefined,
      },
      { ...opts, transfer },
    );
    // Chunk C3: the carved-stock preview mesh is AUXILIARY -- present on
    // success, absent (with a warning) when the worker skipped meshing it
    // (ADR-0003 named fallback). The IR (toolpath) is always present.
    const result: {
      ir: ToolpathIR;
      carvedStock?: StockMesh;
      carvedStockWarning?: string;
      diagnostics?: OperationDiagnostics;
      carvedStockHandle?: StockHandle;
    } = {
      ir: msg.ir,
    };
    if (msg.diagnostics !== undefined) result.diagnostics = msg.diagnostics;
    // WO-274: handle to the carved field the worker RETAINED for this run. The
    // field never crosses the boundary; the handle is how a later operation asks
    // the worker about it -- WO-277 reads it back as `startFromStock` so the next
    // rough starts from what this one left.
    if (msg.stockHandle !== undefined) result.carvedStockHandle = msg.stockHandle;
    if (
      msg.stockPositions !== undefined &&
      msg.stockIndices !== undefined &&
      msg.stockVertexCount !== undefined &&
      msg.stockTriangleCount !== undefined
    ) {
      result.carvedStock = {
        positions: msg.stockPositions,
        indices: msg.stockIndices,
        vertexCount: msg.stockVertexCount,
        triangleCount: msg.stockTriangleCount,
      };
    }
    if (msg.stockMeshWarning !== undefined) result.carvedStockWarning = msg.stockMeshWarning;
    for (const notice of msg.notices ?? []) opts?.onNotice?.(notice);
    return result;
  }

  /**
   * Release every live kernel handle, then terminate the worker. The client
   * is dead afterwards.
   *
   * Teardown is terminate-first (modelClient.ts discipline) and NEVER awaits a
   * round-trip: the previous version awaited a 'disposed' reply before tearing
   * down, which hung forever after a worker CRASH -- onerror/failAll had
   * already drained `pending`, so the fresh dispose request had no responder
   * and its promise never settled. Now the worker-side release is fired
   * fire-and-forget (a healthy worker still frees its handles; in the
   * in-process test channel that runs synchronously before terminate), then
   * the local pending map is failed with AbortError and the worker terminated
   * unconditionally. A crashed worker skips the post entirely.
   */
  async dispose(): Promise<void> {
    if (this.disposed) {
      throw new Error('cam3d client: dispose called after dispose() -- client is dead');
    }
    this.disposed = true;
    if (!this.dead) {
      try {
        const req: DisposeRequest = { kind: 'dispose', requestId: this.takeId() };
        this.worker.postMessage(req);
      } catch {
        // A dead/terminated worker may throw on postMessage; teardown proceeds.
      }
    }
    this.failAll(makeAbortError('cam3d client disposed while request was in flight'));
    this.worker.terminate();
  }

  // ---- plumbing ----

  private takeId(): number {
    return this.nextRequestId++;
  }

  /**
   * Post one request and settle on its terminal response. The pending entry
   * is registered BEFORE postMessage so a synchronously-answering channel
   * (the test fake) cannot outrun it.
   */
  private send<K extends Cam3dResponse['kind']>(
    expectKind: K,
    msg: Exclude<Cam3dRequest, CancelRequest>,
    extras?: DropOpts & { transfer?: Transferable[] },
  ): Promise<Extract<Cam3dResponse, { kind: K }>> {
    if (this.disposed) {
      // Covers double-dispose too: the worker is (about to be) terminated,
      // so a second dispose would hang forever waiting for an answer.
      return Promise.reject(
        new Error(`cam3d client: ${msg.kind} called after dispose() -- client is dead`),
      );
    }
    if (this.dead) {
      // Worker crashed: no responder remains, so awaiting would hang. Fail
      // fast and loud instead (same spirit as the onerror sweep).
      return Promise.reject(
        new Cam3dWorkerError(
          'Cam3dWorkerCrash',
          `cam3d client: ${msg.kind} after worker crash -- client is dead`,
        ),
      );
    }

    const signal = extras?.signal;
    if (signal?.aborted) {
      // Already aborted: never even cross the boundary.
      return Promise.reject(makeAbortError(`cam3d ${msg.kind} aborted before send`));
    }

    return new Promise((resolve, reject) => {
      let cleanup: (() => void) | undefined;
      if (signal) {
        const onAbort = () => {
          // Ask the worker to abort; settlement comes back as the worker's
          // AbortError response (see class doc for the completion race).
          const cancel: CancelRequest = { kind: 'cancel', targetRequestId: msg.requestId };
          this.worker.postMessage(cancel);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        cleanup = () => signal.removeEventListener('abort', onAbort);
      }
      this.pending.set(msg.requestId, {
        resolve: (terminal) => {
          if (terminal.kind !== expectKind) {
            reject(
              new Cam3dWorkerError(
                'Cam3dProtocolError',
                `cam3d worker answered '${terminal.kind}' where '${expectKind}' was expected`,
              ),
            );
            return;
          }
          resolve(terminal as Extract<Cam3dResponse, { kind: K }>);
        },
        reject,
        onProgress: extras?.onProgress,
        cleanup,
      });
      if (extras?.transfer) this.worker.postMessage(msg, extras.transfer);
      else this.worker.postMessage(msg);
    });
  }

  private onMessage(msg: Cam3dResponse): void {
    const req = this.pending.get(msg.requestId);
    if (req === undefined) {
      // Not a swallow: the only unmatched responses are from requests this
      // client already settled locally (dispose/crash sweep rejected them),
      // so the caller has ALREADY been told loudly. Anything else cannot
      // name a pending id -- ids never leave this class.
      return;
    }
    if (msg.kind === 'progress') {
      req.onProgress?.(msg.fraction, msg.detail);
      return;
    }
    this.pending.delete(msg.requestId);
    req.cleanup?.();
    if (msg.kind === 'error') {
      req.reject(new Cam3dWorkerError(msg.name, msg.message, msg.stack));
    } else {
      req.resolve(msg);
    }
  }

  /** Reject every in-flight request (worker crash or dispose sweep). */
  private failAll(err: Error): void {
    for (const req of this.pending.values()) {
      req.cleanup?.();
      req.reject(err);
    }
    this.pending.clear();
  }
}
