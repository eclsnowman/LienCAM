// cam3d worker-side dispatcher: the TESTABLE core of the worker.
//
// The worker entry (cam3dWorker.ts) is a few lines of glue; everything with
// behavior lives here, constructed from two injected dependencies:
// - a GeometryKernel (so tests use a mock and the entry file wires the real
//   BvhKernel later -- this file never imports a concrete kernel), and
// - a PostResponse function (self.postMessage in the worker, a plain
//   function in tests -- no worker globals touched here).
//
// Cancellation plumbing: each dropGrid/dropPath request gets its OWN
// AbortController keyed by requestId. A `cancel` message aborts that
// controller; the kernel promise then rejects (kernels honor AbortSignal
// between chunks, per the L2 contract) and the rejection is serialized back
// as an error response whose name is preserved ('AbortError'), which is how
// the client knows the cancel landed.

import type { CutterHandle, GeometryKernel, MeshHandle } from '../kernel/types';
import type { OperationDiagnostics } from '../../types';
import { ZDexelField, removeSweep, toMesh, type Box3, type LinearMove } from '../stock';
import { parallelFinish } from '../strategies/parallel';
import { scallopFinish } from '../strategies/scallop';
import { pencilFinish } from '../strategies/pencil';
import { restFinish } from '../strategies/rest';
import type { AdaptivePlannerPool } from '../rough/adaptivePlanCache';
import { adaptiveRough } from '../strategies/adaptiveRough';
import { waterlineFinish } from '../strategies/waterline';
import { createOclWaterlineSlicer, type WaterlineSlicer } from '../kernel/oclWaterline';
import type {
  AdaptiveRoughedResponse,
  AdaptiveRoughRequest,
  Cam3dRequest,
  Cam3dResponse,
  DropGridRequest,
  DropPathRequest,
  ErrorResponse,
  ParallelFinishRequest,
  ScallopFinishRequest,
  PencilFinishRequest,
  RestFinishRequest,
  PostResponse,
  StockHandle,
  WaterlineRequest,
} from './protocol';

/**
 * Serialize a thrown value for the boundary. Error name is preserved
 * verbatim (AbortError, RangeError, custom kernel errors...) so the client
 * can rethrow something callers switch on exactly like a local throw.
 */
function serializeError(requestId: number, err: unknown): ErrorResponse {
  if (err instanceof Error) {
    return {
      kind: 'error',
      requestId,
      name: err.name,
      message: err.message,
      ...(err.stack !== undefined ? { stack: err.stack } : {}),
    };
  }
  // Non-Error throw (string, object...): stringify rather than lose it.
  return { kind: 'error', requestId, name: 'Error', message: String(err) };
}

/**
 * WO-274/WO-277: what the run that produced a retained carved field was planning
 * against. Kept because a carved field cannot testify to it -- its column tops
 * are legitimately lower than the box it came from, so "same stock" is only
 * provable from the REQUEST, not from the field.
 */
type RetainedStockOrigin = { bounds: Box3; cellSize: number };

/**
 * WO-277: every way the request being planned differs from the one that carved
 * the retained field, in words. Exact comparison on purpose -- a near-match is
 * still a different situation, and adapting to it is what this refusal exists to
 * prevent.
 */
function retainedStockOriginMismatches(
  origin: RetainedStockOrigin,
  bounds: Box3,
  cellSize: number,
): string[] {
  const diffs: string[] = [];
  for (const key of ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'] as const) {
    if (origin.bounds[key] !== bounds[key]) {
      diffs.push(`stockBounds.${key} ${bounds[key]} mm, field was carved with ${origin.bounds[key]} mm`);
    }
  }
  if (origin.cellSize !== cellSize) {
    diffs.push(`cellSize ${cellSize} mm, field was carved with ${origin.cellSize} mm`);
  }
  return diffs;
}

export class Cam3dDispatcher {
  private readonly kernel: GeometryKernel;
  private readonly post: PostResponse;
  /** AbortController per in-flight dropGrid/dropPath, keyed by requestId. */
  private readonly inflight = new Map<number, AbortController>();
  // Live-handle books for dispose(): the kernel tracks its own handles but
  // exposes no enumeration, so the dispatcher records what it created and
  // has not yet released. Insertion-ordered Sets keep release order fixed
  // (determinism rule).
  private readonly liveMeshes = new Set<MeshHandle>();
  private readonly liveCutters = new Set<CutterHandle>();
  // Stock fields live entirely worker-side (D-014: bulk data never crosses
  // the boundary; only sweep batches in and display meshes out). Handles are
  // monotonic like requestIds -- deterministic and readable in logs.
  private readonly stocks = new Map<StockHandle, ZDexelField>();
  private nextStockHandle = 1;
  // WO-274: handle of the carved field RETAINED from the last completed
  // adaptiveRough (undefined when none is held). Exactly one is kept at a
  // time -- see retainCarvedStock.
  private retainedCarvedStock: StockHandle | undefined;
  // WO-277: the stock box + cell size the retained field was carved against.
  // Held alongside the handle (never separately) so a later rough can prove it
  // is planning the same situation before it believes the field.
  private retainedCarvedStockOrigin: RetainedStockOrigin | undefined;
  // WO-1176: the waterline slicer is created lazily on the first waterline
  // request (the library it loads is 8.6 MB; the other families never pay
  // for it). Injectable so tests drive the dispatcher with a fake slicer.
  private slicer: WaterlineSlicer | undefined;
  private readonly makeSlicer: () => WaterlineSlicer;
  // WO-2096: where the adaptive rougher plans its Z levels in parallel. Absent
  // (tests, hosts without nested workers) it plans them one after another.
  private readonly plannerPool: AdaptivePlannerPool | undefined;

  constructor(
    kernel: GeometryKernel,
    post: PostResponse,
    opts: {
      slicer?: WaterlineSlicer | (() => WaterlineSlicer);
      plannerPool?: AdaptivePlannerPool;
    } = {},
  ) {
    this.kernel = kernel;
    this.post = post;
    this.plannerPool = opts.plannerPool;
    const provided = opts.slicer;
    this.makeSlicer = provided === undefined
      ? () => createOclWaterlineSlicer()
      : typeof provided === 'function' ? provided : () => provided;
  }

  /**
   * Handle one request. Synchronous ops (upload/release/make/init/dispose)
   * answer before this returns; dropGrid/dropPath answer when the kernel
   * promise settles. Unknown kinds THROW: a message outside the protocol is
   * a bug, and guessing would be a silent fallback.
   */
  handle(msg: Cam3dRequest): void {
    switch (msg.kind) {
      case 'init':
        this.answer(msg.requestId, () => ({
          kind: 'initDone',
          requestId: msg.requestId,
          kernelName: this.kernel.name,
        }));
        return;

      case 'uploadMesh':
        this.answer(msg.requestId, () => {
          const handle = this.kernel.uploadMesh(msg.mesh);
          this.liveMeshes.add(handle);
          return { kind: 'meshUploaded', requestId: msg.requestId, mesh: handle };
        });
        return;

      case 'releaseMesh':
        this.answer(msg.requestId, () => {
          this.kernel.releaseMesh(msg.mesh);
          this.liveMeshes.delete(msg.mesh);
          return { kind: 'meshReleased', requestId: msg.requestId };
        });
        return;

      case 'makeCutter':
        this.answer(msg.requestId, () => {
          const handle = this.kernel.makeCutter(msg.spec);
          this.liveCutters.add(handle);
          return { kind: 'cutterMade', requestId: msg.requestId, cutter: handle };
        });
        return;

      case 'releaseCutter':
        this.answer(msg.requestId, () => {
          this.kernel.releaseCutter(msg.cutter);
          this.liveCutters.delete(msg.cutter);
          return { kind: 'cutterReleased', requestId: msg.requestId };
        });
        return;

      case 'dropGrid':
      case 'dropPath':
        this.startDrop(msg);
        return;

      case 'stockCreate':
        this.answer(msg.requestId, () => {
          const field =
            msg.budget !== undefined
              ? ZDexelField.fromBox(msg.bounds, msg.cellSize, msg.budget)
              : ZDexelField.fromBox(msg.bounds, msg.cellSize);
          const handle = this.nextStockHandle++ as StockHandle;
          this.stocks.set(handle, field);
          return {
            kind: 'stockCreated',
            requestId: msg.requestId,
            stock: handle,
            nx: field.nx,
            ny: field.ny,
            cell: field.cell,
            warnings: [...field.warnings],
          };
        });
        return;

      case 'stockRemoveSweep':
        this.answer(msg.requestId, () => {
          const field = this.getStock(msg.stock);
          if (msg.moves.length % 6 !== 0) {
            throw new Error(
              `cam3d dispatcher: stockRemoveSweep moves length ${msg.moves.length} ` +
                `is not a multiple of 6 (x0,y0,z0,x1,y1,z1 per move).`,
            );
          }
          let removedVolumeMm3 = 0;
          let columnsChanged = 0;
          for (let k = 0; k < msg.moves.length; k += 6) {
            const move: LinearMove = {
              x0: msg.moves[k],
              y0: msg.moves[k + 1],
              z0: msg.moves[k + 2],
              x1: msg.moves[k + 3],
              y1: msg.moves[k + 4],
              z1: msg.moves[k + 5],
            };
            const r = removeSweep(field, move, msg.cutter);
            removedVolumeMm3 += r.removedVolumeMm3;
            columnsChanged += r.columnsChanged;
          }
          return {
            kind: 'stockSwept',
            requestId: msg.requestId,
            removedVolumeMm3,
            columnsChanged,
          };
        });
        return;

      case 'stockToMesh':
        // Inline (not answer()) because the terminal post carries a transfer
        // list: positions/indices go back as transferables, never copies.
        try {
          const field = this.getStock(msg.stock);
          const mesh =
            msg.triangleBudget !== undefined
              ? toMesh(field, msg.triangleBudget)
              : toMesh(field);
          this.post(
            {
              kind: 'stockMeshed',
              requestId: msg.requestId,
              positions: mesh.positions,
              indices: mesh.indices,
              vertexCount: mesh.vertexCount,
              triangleCount: mesh.triangleCount,
            },
            [mesh.positions.buffer as ArrayBuffer, mesh.indices.buffer as ArrayBuffer],
          );
        } catch (err) {
          this.post(serializeError(msg.requestId, err));
        }
        return;

      case 'stockDispose':
        this.answer(msg.requestId, () => {
          this.getStock(msg.stock); // fail loud on unknown/double-dispose
          this.stocks.delete(msg.stock);
          // Keep the retained-field pointer honest: an explicitly disposed
          // retained field is no longer held (WO-274).
          if (this.retainedCarvedStock === msg.stock) {
            this.retainedCarvedStock = undefined;
            this.retainedCarvedStockOrigin = undefined;
          }
          return { kind: 'stockDisposed', requestId: msg.requestId };
        });
        return;

      case 'parallelFinish':
        this.startParallelFinish(msg);
        return;

      case 'scallopFinish':
        this.startScallopFinish(msg);
        return;

      case 'pencilFinish':
        this.startPencilFinish(msg);
        return;

      case 'restFinish':
        this.startRestFinish(msg);
        return;

      case 'adaptiveRough':
        this.startAdaptiveRough(msg);
        return;

      case 'waterline':
        this.startWaterline(msg);
        return;

      case 'cancel':
        // A miss here is NOT an error: cancel racing normal completion is
        // legitimate (the abort arrived as the op finished, and the caller
        // already has its terminal response).
        this.inflight.get(msg.targetRequestId)?.abort();
        return;

      case 'dispose':
        this.answer(msg.requestId, () => {
          // Abort in-flight ops FIRST so their kernel promises reject (their
          // callers get loud AbortErrors) before the handles they reference
          // are freed underneath them.
          for (const controller of this.inflight.values()) controller.abort();
          this.inflight.clear();
          for (const cutter of this.liveCutters) this.kernel.releaseCutter(cutter);
          this.liveCutters.clear();
          for (const mesh of this.liveMeshes) this.kernel.releaseMesh(mesh);
          this.liveMeshes.clear();
          // Stock fields are worker-local (no kernel handles): drop them all,
          // the retained carved field (WO-274) included.
          this.stocks.clear();
          this.retainedCarvedStock = undefined;
          this.retainedCarvedStockOrigin = undefined;
          return { kind: 'disposed', requestId: msg.requestId };
        });
        return;

      default: {
        // With the union fully covered, `msg` is `never` here; the runtime
        // check still fires for malformed messages from a buggy sender.
        const bad = msg as { kind?: unknown };
        throw new Error(
          `cam3d dispatcher: unknown request kind '${String(bad.kind)}' -- ` +
            `protocol bug, refusing to guess`,
        );
      }
    }
  }

  /** Number of in-flight cancellable ops (test/diagnostic visibility). */
  get inflightCount(): number {
    return this.inflight.size;
  }

  /** Number of live stock fields (test/diagnostic visibility). */
  get liveStockCount(): number {
    return this.stocks.size;
  }

  /**
   * WO-274: read a live stock field by handle inside the worker (the retained
   * carved field is an ordinary entry in the same registry). Same fail-loud
   * contract as every other stock op -- an unknown or already-released handle
   * THROWS rather than answering with an empty field, because a silently-empty
   * field reads as "nothing here, safe to cut". Worker-local by design: bulk
   * field data never crosses the boundary (D-014), so this is for worker-side
   * readers and tests, not for the client.
   */
  peekStock(handle: StockHandle): ZDexelField {
    return this.getStock(handle);
  }

  /** Look up a live stock field; use-after-dispose fails loud. */
  private getStock(handle: StockHandle): ZDexelField {
    const field = this.stocks.get(handle);
    if (field === undefined) {
      throw new Error(
        `cam3d dispatcher: stock handle ${handle} is not live ` +
          `(never created, or already disposed).`,
      );
    }
    return field;
  }

  /**
   * WO-274: keep a completed rough's carved field alive under a handle instead
   * of letting it go out of scope when the handler returns.
   *
   * ONE retained field at a time: a field costs ~32 MB at the default cell
   * budget (stock/zdexel.ts DEFAULT_CELL_BUDGET), so retaining this run's field
   * RELEASES the previous run's -- the live count must not grow with the number
   * of operations run. Only a field retained by THIS path is released here;
   * fields the caller made with stockCreate belong to the caller and are never
   * touched. The released handle then fails loud on any later use, exactly like
   * a disposed one (getStock).
   */
  private retainCarvedStock(field: ZDexelField, origin: RetainedStockOrigin): StockHandle {
    const previous = this.retainedCarvedStock;
    const handle = this.nextStockHandle++ as StockHandle;
    this.stocks.set(handle, field);
    if (previous !== undefined) this.stocks.delete(previous);
    this.retainedCarvedStock = handle;
    // WO-277: the field and what it was carved against are set together and
    // cleared together -- a field whose situation is unknown is a field no later
    // rough may believe.
    this.retainedCarvedStockOrigin = origin;
    return handle;
  }

  /**
   * WO-277: resolve `startFromStock` to the field a rough may start from, or
   * THROW naming why it may not. Three separate refusals, all loud, none of them
   * a fallback to a full box:
   *
   *  - the handle is not live (never created, disposed, or released by a later
   *    rough's retention) -- WO-274's fail-loud path, unchanged;
   *  - the handle is live but is NOT the retained carved field (a stock the
   *    caller made with stockCreate, say): nothing records what it describes, so
   *    it cannot be believed;
   *  - the field was carved against a different stock box or cell size: it
   *    describes a different situation, and believing it would mean planning a
   *    cut through material this request still has.
   */
  private startingStockFor(msg: AdaptiveRoughRequest): ZDexelField | undefined {
    if (msg.startFromStock === undefined) return undefined;
    const field = this.getStock(msg.startFromStock); // unknown/stale -> fail loud
    if (this.retainedCarvedStock !== msg.startFromStock || this.retainedCarvedStockOrigin === undefined) {
      throw new Error(
        `cam3d dispatcher: stock handle ${msg.startFromStock} is live but is not the ` +
          `carved field retained by the last adaptive rough, so there is no record of ` +
          `what it describes; refusing to rough from it.`,
      );
    }
    const diffs = retainedStockOriginMismatches(
      this.retainedCarvedStockOrigin,
      msg.stockBounds,
      msg.cellSize,
    );
    if (diffs.length > 0) {
      throw new Error(
        `cam3d dispatcher: retained stock handle ${msg.startFromStock} was carved for a ` +
          `different situation (${diffs.join('; ')}); refusing to start this rough from ` +
          `it -- material it reports as already removed may still be there.`,
      );
    }
    return field;
  }

  /** Run a synchronous op; post its response, or the serialized throw. */
  private answer(requestId: number, op: () => Cam3dResponse): void {
    try {
      this.post(op());
    } catch (err) {
      this.post(serializeError(requestId, err));
    }
  }

  /**
   * Parallel-finish strategy: self-contained (whole mesh in, IR out). The
   * mesh handle is created HERE and disposed in a finally (D-005 lifetime
   * discipline); it is deliberately NOT tracked in liveMeshes so a concurrent
   * global dispose can never double-release a handle this method owns. Cancel
   * uses the same AbortController-in-`inflight` mechanism as dropGrid/dropPath
   * (the strategy threads the signal into its kernel drop batches); progress
   * is coarse (begin 0, strategy scan up to 0.9, end 1).
   */
  private startParallelFinish(msg: ParallelFinishRequest): void {
    const { requestId } = msg;
    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    if (msg.wantProgress) this.post({ kind: 'progress', requestId, fraction: 0 });

    const run = async (): Promise<Cam3dResponse> => {
      const mesh = this.kernel.uploadMesh(msg.mesh);
      try {
        const ir = await parallelFinish(
          this.kernel,
          {
            mesh,
            cutter: msg.cutter,
            stepover: msg.stepover,
            angleDeg: msg.angleDeg,
            tolerance: msg.tolerance,
            ...(msg.surfaceStockToLeave !== undefined
              ? { surfaceStockToLeave: msg.surfaceStockToLeave }
              : {}),
            ...(msg.maxSlopeDeg !== undefined ? { maxSlopeDeg: msg.maxSlopeDeg } : {}),
            ...(msg.minFinishZ !== undefined ? { minFinishZ: msg.minFinishZ } : {}),
            heights: msg.heights,
            zSeed: msg.zSeed,
            ...(msg.boundary !== undefined ? { boundary: msg.boundary } : {}),
            ...(msg.xyBounds !== undefined ? { xyBounds: msg.xyBounds } : {}),
            ...(msg.overrunBoundary !== undefined ? { overrunBoundary: msg.overrunBoundary } : {}),
          },
          {
            signal: controller.signal,
            onProgress: msg.wantProgress
              ? (fraction: number) => this.post({ kind: 'progress', requestId, fraction })
              : undefined,
          },
        );
        return { kind: 'parallelFinished', requestId, ir };
      } finally {
        // Upload-per-generate for M1; handle reuse is a possible later
        // optimization (keep a mesh handle across generate calls).
        this.kernel.releaseMesh(mesh);
      }
    };

    run().then(
      (terminal) => {
        this.inflight.delete(requestId);
        if (msg.wantProgress) this.post({ kind: 'progress', requestId, fraction: 1 });
        this.post(terminal);
      },
      (err: unknown) => {
        this.inflight.delete(requestId);
        this.post(serializeError(requestId, err));
      },
    );
  }

  private startScallopFinish(msg: ScallopFinishRequest): void {
    const { requestId } = msg;
    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    if (msg.wantProgress) this.post({ kind: 'progress', requestId, fraction: 0 });

    const run = async (): Promise<Cam3dResponse> => {
      const mesh = this.kernel.uploadMesh(msg.mesh);
      try {
        const notices: string[] = [];
        const ir = await scallopFinish(this.kernel, {
          mesh,
          cutter: msg.cutter,
          scallopHeight: msg.scallopHeight,
          tolerance: msg.tolerance,
          ...(msg.surfaceStockToLeave !== undefined ? { surfaceStockToLeave: msg.surfaceStockToLeave } : {}),
          ...(msg.minFinishZ !== undefined ? { minFinishZ: msg.minFinishZ } : {}),
          direction: msg.direction,
          heights: msg.heights,
          zSeed: msg.zSeed,
          ...(msg.boundary !== undefined ? { boundary: msg.boundary } : {}),
          ...(msg.xyBounds !== undefined ? { xyBounds: msg.xyBounds } : {}),
        }, {
          signal: controller.signal,
          onProgress: msg.wantProgress
            ? (fraction: number) => this.post({ kind: 'progress', requestId, fraction })
            : undefined,
          onNotice: (message: string) => { notices.push(message); },
        });
        return { kind: 'scallopFinished', requestId, ir, ...(notices.length > 0 ? { notices } : {}) };
      } finally {
        this.kernel.releaseMesh(mesh);
      }
    };
    run().then(
      terminal => {
        this.inflight.delete(requestId);
        if (msg.wantProgress) this.post({ kind: 'progress', requestId, fraction: 1 });
        this.post(terminal);
      },
      (error: unknown) => {
        this.inflight.delete(requestId);
        this.post(serializeError(requestId, error));
      },
    );
  }

  private startPencilFinish(msg: PencilFinishRequest): void {
    const { requestId } = msg;
    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    if (msg.wantProgress) this.post({ kind: 'progress', requestId, fraction: 0 });
    const run = async (): Promise<Cam3dResponse> => {
      const mesh = this.kernel.uploadMesh(msg.mesh);
      try {
        const ir = await pencilFinish(this.kernel, {
          mesh, cutter: msg.cutter, tolerance: msg.tolerance,
          ...(msg.stockToLeave !== undefined ? { stockToLeave: msg.stockToLeave } : {}),
          ...(msg.minFinishZ !== undefined ? { minFinishZ: msg.minFinishZ } : {}),
          direction: msg.direction, heights: msg.heights, zSeed: msg.zSeed,
          ...(msg.boundary !== undefined ? { boundary: msg.boundary } : {}),
          ...(msg.xyBounds !== undefined ? { xyBounds: msg.xyBounds } : {}),
        }, {
          signal: controller.signal,
          onProgress: msg.wantProgress ? fraction => this.post({ kind: 'progress', requestId, fraction }) : undefined,
        });
        return { kind: 'pencilFinished', requestId, ir };
      } finally {
        this.kernel.releaseMesh(mesh);
      }
    };
    run().then(
      terminal => {
        this.inflight.delete(requestId);
        if (msg.wantProgress) this.post({ kind: 'progress', requestId, fraction: 1 });
        this.post(terminal);
      },
      (error: unknown) => {
        this.inflight.delete(requestId);
        this.post(serializeError(requestId, error));
      },
    );
  }

  private startRestFinish(msg: RestFinishRequest): void {
    const { requestId } = msg;
    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    if (msg.wantProgress) this.post({ kind: 'progress', requestId, fraction: 0 });
    const run = async (): Promise<Cam3dResponse> => {
      const mesh = this.kernel.uploadMesh(msg.mesh);
      try {
        const result = await restFinish(this.kernel, {
          mesh,
          cutter: msg.cutter,
          referenceToolDiameter: msg.referenceToolDiameter,
          referenceCornerRadius: msg.referenceCornerRadius,
          tolerance: msg.tolerance,
          stockToLeave: msg.stockToLeave,
          stepdown: msg.stepdown,
          direction: msg.direction,
          spindleRotation: msg.spindleRotation,
          stockBounds: msg.stockBounds,
          cellSize: msg.cellSize,
          heights: msg.heights,
          topZ: msg.topZ,
          bottomZ: msg.bottomZ,
          referenceStock: this.getStock(msg.stock),
          ...(msg.boundary !== undefined ? { boundary: msg.boundary } : {}),
        }, {
          signal: controller.signal,
          onProgress: msg.wantProgress ? fraction => this.post({ kind: 'progress', requestId, fraction }) : undefined,
        });
        const ir = msg.stockSource === 'previous_operations'
          ? {
              ...result.ir,
              meta: {
                ...result.ir.meta,
                strategyId: 'rest_finish_previous_operations',
                params: { ...result.ir.meta.params, stockSource: msg.stockSource },
              },
            }
          : result.ir;
        return { kind: 'restFinished', requestId, ir };
      } finally {
        this.kernel.releaseMesh(mesh);
      }
    };
    run().then(
      terminal => {
        this.inflight.delete(requestId);
        if (msg.wantProgress) this.post({ kind: 'progress', requestId, fraction: 1 });
        this.post(terminal);
      },
      error => {
        this.inflight.delete(requestId);
        this.post(serializeError(requestId, error));
      },
    );
  }

  /**
   * Waterline strategy (WO-1176): self-contained (whole mesh in, IR out),
   * mirroring startParallelFinish. The mesh is uploaded to the kernel for the
   * side/slope probes and released in a finally; the SAME PartMesh data goes to
   * the slicer, which hands it to the library per level (WO-284: a fresh
   * library object every level). Cancel is honoured between levels through the
   * strategy's signal; progress is per level (begin 0, strategy to 0.9, end 1).
   *
   * A poisoned library (OclModulePoisonedError) is serialized by NAME so the
   * store can recycle this whole worker: after a wasm abort every later call
   * into the module fails, and a fresh worker is the only honest recovery.
   */
  private startWaterline(msg: WaterlineRequest): void {
    const { requestId } = msg;
    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    if (msg.wantProgress) this.post({ kind: 'progress', requestId, fraction: 0 });

    const run = async (): Promise<Cam3dResponse> => {
      if (this.slicer === undefined) this.slicer = this.makeSlicer();
      const mesh = this.kernel.uploadMesh(msg.mesh);
      try {
        const ir = await waterlineFinish(
          this.kernel,
          this.slicer,
          {
            mesh,
            partMesh: msg.mesh,
            cutter: msg.cutter,
            stepdown: msg.stepdown,
            sampling: msg.sampling,
            stockToLeave: msg.stockToLeave,
            minSlopeDeg: msg.minSlopeDeg,
            flatAreaDetection: msg.flatAreaDetection,
            order: msg.order,
            direction: msg.direction,
            spindle: msg.spindle,
            topZ: msg.topZ,
            bottomZ: msg.bottomZ,
            heights: msg.heights,
            zSeed: msg.zSeed,
            ...(msg.boundary !== undefined ? { boundary: msg.boundary } : {}),
            ...(msg.overrunBoundary !== undefined ? { overrunBoundary: msg.overrunBoundary } : {}),
            ...(msg.rampAngleDeg !== undefined ? { rampAngleDeg: msg.rampAngleDeg } : {}),
          },
          {
            signal: controller.signal,
            onProgress: msg.wantProgress
              ? (fraction: number) => this.post({ kind: 'progress', requestId, fraction })
              : undefined,
          },
        );
        return { kind: 'waterlineFinished', requestId, ir };
      } finally {
        this.kernel.releaseMesh(mesh);
      }
    };

    run().then(
      (terminal) => {
        this.inflight.delete(requestId);
        if (msg.wantProgress) this.post({ kind: 'progress', requestId, fraction: 1 });
        this.post(terminal);
      },
      (err: unknown) => {
        this.inflight.delete(requestId);
        this.post(serializeError(requestId, err));
      },
    );
  }

  /**
   * Adaptive-rougher strategy: self-contained (whole mesh in, IR out), mirroring
   * startParallelFinish exactly. The mesh handle is created HERE and disposed in
   * a finally (D-005), deliberately NOT tracked in liveMeshes so a concurrent
   * global dispose can never double-release it. Cancel uses the same
   * AbortController-in-`inflight` mechanism; the strategy threads the signal into
   * its per-level work and throws AbortError rather than returning a partial IR.
   * Progress is per-level (begin 0, strategy up to ~1, end 1).
   */
  private startAdaptiveRough(msg: AdaptiveRoughRequest): void {
    const { requestId } = msg;
    const controller = new AbortController();
    this.inflight.set(requestId, controller);
    if (msg.wantProgress) this.post({ kind: 'progress', requestId, fraction: 0 });

    const run = async (): Promise<{ terminal: Cam3dResponse; transfer: Transferable[] }> => {
      // WO-277: resolved BEFORE any work -- a refusal must cost nothing and must
      // reach the caller as an error response, never as a quiet full-box rough.
      const startFromStock = this.startingStockFor(msg);
      const mesh = this.kernel.uploadMesh(msg.mesh);
      // Chunk C3: capture the fully-carved stock field the strategy hands back
      // via onCarvedStock, then mesh it (toMesh) for the viewport carved-stock
      // preview. The field is in the part DISPLAY-LOCAL frame; its z-dexel
      // walls are cell-staircased (exact for open-topped monotone pockets;
      // true tri-dexel wall fidelity deferred, D-003).
      let carvedField: ZDexelField | undefined;
      let diagnostics: OperationDiagnostics | undefined;
      const notices: string[] = [];
      try {
        const ir = await adaptiveRough(
          this.kernel,
          {
            mesh,
            cutter: msg.cutter,
            stockBounds: msg.stockBounds,
            cellSize: msg.cellSize,
            maxStepdown: msg.maxStepdown,
            stepover: msg.stepover,
            millingDirection: msg.millingDirection,
            intermediateStepdown: msg.intermediateStepdown,
            spindleRotation: msg.spindleRotation,
            wallLeadInRadius: msg.wallLeadInRadius,
            wallLeadOutRadius: msg.wallLeadOutRadius,
            loopbackFilletPct: msg.loopbackFilletPct,
            integralWallFollow: msg.integralWallFollow,
            integralWallFollowLengthFactor: msg.integralWallFollowLengthFactor,
            tolerance: msg.tolerance,
            helixDiameter: msg.helixDiameter,
            helixAngleDeg: msg.helixAngleDeg,
            ...(msg.radialStockToLeave !== undefined
              ? { radialStockToLeave: msg.radialStockToLeave }
              : {}),
            ...(msg.axialStockToLeave !== undefined
              ? { axialStockToLeave: msg.axialStockToLeave }
              : {}),
            heights: msg.heights,
            materialTopZ: msg.materialTopZ,
            ...(msg.stockBoundsAreRealStock ? { stockBoundsAreRealStock: true } : {}),
            ...(msg.floorZ !== undefined ? { floorZ: msg.floorZ } : {}),
            ...(msg.boundary !== undefined ? { boundary: msg.boundary } : {}),
            ...(msg.reachStockEdgeBy !== undefined
              ? { reachStockEdgeBy: msg.reachStockEdgeBy }
              : {}),
            ...(msg.sideEntry ? { sideEntry: true } : {}),
            ...(startFromStock !== undefined ? { startFromStock } : {}),
          },
          {
            signal: controller.signal,
            onProgress: msg.wantProgress
              ? (fraction, detail) => this.post({
                  kind: 'progress', requestId, fraction,
                  ...(detail !== undefined ? { detail } : {}),
                })
              : undefined,
            onCarvedStock: (s) => {
              carvedField = s;
            },
            onDiagnostics: (value) => {
              diagnostics = value;
            },
            onNotice: (message: string) => {
              notices.push(message);
            },
            ...(this.plannerPool !== undefined ? { plannerPool: this.plannerPool } : {}),
          },
        );

        const terminal: AdaptiveRoughedResponse = { kind: 'adaptiveRoughed', requestId, ir };
        if (diagnostics !== undefined) terminal.diagnostics = diagnostics;
        if (notices.length > 0) terminal.notices = notices;
        const transfer: Transferable[] = [];
        // Auxiliary carved-stock preview (ADR-0003 NAMED, LOGGED fallback): a
        // toMesh failure (e.g. over the triangle budget) must NOT fail the
        // rough -- the toolpath is the primary product. On success attach the
        // mesh + its transferables (mirroring the stockToMesh branch); on
        // failure attach a warning + console.warn and return the IR normally.
        if (carvedField !== undefined) {
          // WO-274: retain the FIELD first -- it is the durable product of this
          // block and its handle rides back with the result. The display mesh
          // below stays auxiliary: it may legitimately fail (budget) and the
          // retained field must survive that failure, since a field is worth
          // more than the preview built from it.
          terminal.stockHandle = this.retainCarvedStock(carvedField, {
            bounds: msg.stockBounds,
            cellSize: msg.cellSize,
          });
          try {
            const carvedMesh = toMesh(carvedField);
            terminal.stockPositions = carvedMesh.positions;
            terminal.stockIndices = carvedMesh.indices;
            terminal.stockVertexCount = carvedMesh.vertexCount;
            terminal.stockTriangleCount = carvedMesh.triangleCount;
            transfer.push(
              carvedMesh.positions.buffer as ArrayBuffer,
              carvedMesh.indices.buffer as ArrayBuffer,
            );
          } catch (err) {
            const reason = err instanceof Error ? err.message : String(err);
            terminal.stockMeshWarning = `carved-stock preview skipped: ${reason}`;
            // eslint-disable-next-line no-console
            console.warn(`cam3d adaptiveRough: ${terminal.stockMeshWarning}`);
          }
        }
        return { terminal, transfer };
      } finally {
        this.kernel.releaseMesh(mesh);
      }
    };

    run().then(
      ({ terminal, transfer }) => {
        this.inflight.delete(requestId);
        // adaptiveRough emits its structured terminal progress before return;
        // do not overwrite the useful "Complete" phase with an unlabelled 1.0.
        this.post(terminal, transfer.length > 0 ? transfer : undefined);
      },
      (err: unknown) => {
        this.inflight.delete(requestId);
        this.post(serializeError(requestId, err));
      },
    );
  }

  /** Shared async path for dropGrid/dropPath (the two cancellable ops). */
  private startDrop(msg: DropGridRequest | DropPathRequest): void {
    const { requestId } = msg;
    const controller = new AbortController();
    this.inflight.set(requestId, controller);

    const opts = {
      signal: controller.signal,
      // Progress events only when someone is listening (wantProgress);
      // kernel calls onProgress between chunks per the L2 contract.
      onProgress: msg.wantProgress
        ? (fraction: number) => this.post({ kind: 'progress', requestId, fraction })
        : undefined,
    };

    let promise: Promise<Float64Array>;
    try {
      promise =
        msg.kind === 'dropGrid'
          ? this.kernel.dropGrid(msg.mesh, msg.cutter, msg.grid, opts)
          : this.kernel.dropPath(msg.mesh, msg.cutter, msg.xy, msg.zSeed, opts);
    } catch (err) {
      // Kernel threw before returning a promise (bad handle, bad spec).
      this.inflight.delete(requestId);
      this.post(serializeError(requestId, err));
      return;
    }

    promise.then(
      (z) => {
        this.inflight.delete(requestId);
        const terminal: Cam3dResponse =
          msg.kind === 'dropGrid'
            ? { kind: 'gridDropped', requestId, z }
            : { kind: 'pathDropped', requestId, z };
        // Transfer the result buffer back -- kernel results are plain
        // ArrayBuffers (never SharedArrayBuffer), so the cast is safe.
        this.post(terminal, [z.buffer as ArrayBuffer]);
      },
      (err: unknown) => {
        this.inflight.delete(requestId);
        this.post(serializeError(requestId, err));
      },
    );
  }
}
