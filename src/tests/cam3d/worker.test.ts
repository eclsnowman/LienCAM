// cam3d worker scaffold tests: client <-> dispatcher over a FAKE message
// channel (two functions wired to each other) with a MOCK GeometryKernel.
// Per project rule the testable core is exercised directly -- no real
// Worker/postMessage, so transferables are asserted via recorded transfer
// lists rather than actual buffer detachment.

import { describe, expect, it } from 'vitest';
import type {
  CutterHandle,
  CutterSpec,
  GeometryKernel,
  GridSpec,
  MeshHandle,
  PartMesh,
} from '../../cam3d/kernel/types';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, Cam3dWorkerError, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';

// ---- mock kernel ----

function abortError(): Error {
  const err = new Error('aborted by signal');
  err.name = 'AbortError';
  return err;
}

type DropRecord = {
  op: 'dropGrid' | 'dropPath';
  mesh: number;
  cutter: number;
  /** Expected result length (grid nx*ny or path point count). */
  n: number;
  aborted: boolean;
  resolve: (z: Float64Array) => void;
  reject: (err: unknown) => void;
  emitProgress: (fraction: number) => void;
};

/**
 * Records every call; returns canned Float64Arrays; honors AbortSignal.
 * Drops settle on a microtask by default; set autoResolve = false to hold
 * them open and settle manually via `drops[i]` (controllable delay).
 */
class MockKernel implements GeometryKernel {
  readonly name = 'mock';
  readonly calls: string[] = [];
  readonly drops: DropRecord[] = [];
  autoResolve = true;
  makeCutterError?: Error;
  private nextMesh = 1;
  private nextCutter = 101;

  uploadMesh(mesh: PartMesh): MeshHandle {
    this.calls.push(`uploadMesh:${mesh.source}:${mesh.positions.length / 3}v`);
    return this.nextMesh++ as MeshHandle;
  }

  releaseMesh(h: MeshHandle): void {
    this.calls.push(`releaseMesh:${h}`);
  }

  makeCutter(spec: CutterSpec): CutterHandle {
    if (this.makeCutterError !== undefined) throw this.makeCutterError;
    this.calls.push(`makeCutter:${spec.kind}:${spec.diameter}`);
    return this.nextCutter++ as CutterHandle;
  }

  releaseCutter(c: CutterHandle): void {
    this.calls.push(`releaseCutter:${c}`);
  }

  dropGrid(
    m: MeshHandle,
    c: CutterHandle,
    g: GridSpec,
    opts?: { signal?: AbortSignal; onProgress?: (f: number) => void },
  ): Promise<Float64Array> {
    this.calls.push(`dropGrid:${m}:${c}:${g.nx}x${g.ny}`);
    return this.startDrop('dropGrid', m, c, g.nx * g.ny, opts);
  }

  dropPath(
    m: MeshHandle,
    c: CutterHandle,
    xy: Float64Array,
    zSeed: number,
    opts?: { signal?: AbortSignal; onProgress?: (f: number) => void },
  ): Promise<Float64Array> {
    this.calls.push(`dropPath:${m}:${c}:${xy.length / 2}pts:seed${zSeed}`);
    return this.startDrop('dropPath', m, c, xy.length / 2, opts);
  }

  dropPoints(
    m: MeshHandle,
    c: CutterHandle,
    xy: Float64Array,
    zSeed: number,
    opts?: { signal?: AbortSignal },
  ): Promise<Float64Array> {
    // Interface-completeness only (dropPoints shares dropPath's per-point
    // routine in the real kernel); the worker protocol does not carry it yet.
    this.calls.push(`dropPoints:${m}:${c}:${xy.length / 2}pts:seed${zSeed}`);
    return this.startDrop('dropPath', m, c, xy.length / 2, opts);
  }

  private startDrop(
    op: 'dropGrid' | 'dropPath',
    mesh: number,
    cutter: number,
    n: number,
    opts?: { signal?: AbortSignal; onProgress?: (f: number) => void },
  ): Promise<Float64Array> {
    return new Promise<Float64Array>((resolve, reject) => {
      const rec: DropRecord = {
        op,
        mesh,
        cutter,
        n,
        aborted: false,
        resolve,
        reject,
        emitProgress: (fraction) => opts?.onProgress?.(fraction),
      };
      if (opts?.signal !== undefined) {
        const onAbort = () => {
          rec.aborted = true;
          reject(abortError());
        };
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener('abort', onAbort, { once: true });
      }
      this.drops.push(rec);
      // Canned deterministic result: filled with the 1-based drop index so
      // concurrent callers can tell whose result they got.
      const canned = new Float64Array(n).fill(this.drops.length);
      if (this.autoResolve) queueMicrotask(() => resolve(canned));
    });
  }
}

// ---- fake channel harness ----

function makeHarness() {
  const kernel = new MockKernel();
  /** Transfer list of each client -> worker postMessage, in send order. */
  const toWorkerTransfers: Transferable[][] = [];
  /** Transfer list of each worker -> client post, in send order. */
  const toMainTransfers: Transferable[][] = [];
  let isTerminated = false;

  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown, transfer?: Transferable[]): void {
      toWorkerTransfers.push(transfer ?? []);
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {
      isTerminated = true;
    },
  };
  const dispatcher = new Cam3dDispatcher(
    kernel,
    (msg: Cam3dResponse, transfer?: Transferable[]) => {
      toMainTransfers.push(transfer ?? []);
      fakeWorker.onmessage?.({ data: msg } as MessageEvent);
    },
  );
  const client = new Cam3dClient(fakeWorker);
  return {
    client,
    dispatcher,
    kernel,
    toWorkerTransfers,
    toMainTransfers,
    terminated: () => isTerminated,
  };
}

/** Harness plus one uploaded mesh and one cutter (the common preamble). */
async function makeLoadedHarness() {
  const h = makeHarness();
  const mesh = await h.client.uploadMesh(makeMesh());
  const cutter = await h.client.makeCutter({ kind: 'flat', diameter: 6 });
  return { ...h, mesh, cutter };
}

function makeMesh(): PartMesh {
  return {
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    indices: new Uint32Array([0, 1, 2]),
    bounds: { min: [0, 0, 0], max: [10, 10, 0] },
    source: 'fixture',
  };
}

const GRID_2X2: GridSpec = { x0: 0, y0: 0, nx: 2, ny: 2, dx: 1, dy: 1, zSeed: -5 };

// ---- tests ----

describe('cam3d worker scaffold', () => {
  it('round-trips every op with correctly typed results', async () => {
    const { client, kernel } = makeHarness();

    expect(await client.init()).toBe('mock');

    const mesh = await client.uploadMesh(makeMesh());
    expect(mesh).toBe(1);

    const cutter = await client.makeCutter({ kind: 'flat', diameter: 6 });
    expect(cutter).toBe(101);

    const zg = await client.dropGrid(mesh, cutter, GRID_2X2);
    expect(zg).toBeInstanceOf(Float64Array);
    expect(Array.from(zg)).toEqual([1, 1, 1, 1]);

    const zp = await client.dropPath(mesh, cutter, new Float64Array([0, 0, 5, 5]), -5);
    expect(zp).toBeInstanceOf(Float64Array);
    expect(Array.from(zp)).toEqual([2, 2]);

    await client.releaseCutter(cutter);
    await client.releaseMesh(mesh);

    expect(kernel.calls).toEqual([
      'uploadMesh:fixture:3v',
      'makeCutter:flat:6',
      'dropGrid:1:101:2x2',
      'dropPath:1:101:2pts:seed-5',
      'releaseCutter:101',
      'releaseMesh:1',
    ]);
  });

  it('transfers buffers across the boundary instead of copying', async () => {
    const { client, toWorkerTransfers, toMainTransfers } = makeHarness();

    const mesh = makeMesh();
    const posBuf = mesh.positions.buffer;
    const idxBuf = mesh.indices.buffer;
    const h = await client.uploadMesh(mesh);
    expect(toWorkerTransfers[0]).toEqual([posBuf, idxBuf]);

    const cutter = await client.makeCutter({ kind: 'ball', diameter: 3 });

    const xy = new Float64Array([0, 0, 1, 1]);
    const xyBuf = xy.buffer;
    await client.dropPath(h, cutter, xy, -5);
    // messages so far: uploadMesh, makeCutter, dropPath
    expect(toWorkerTransfers).toHaveLength(3);
    expect(toWorkerTransfers[2]).toEqual([xyBuf]);

    const zg = await client.dropGrid(h, cutter, GRID_2X2);
    // last worker -> main post is the grid result, transferring its buffer
    expect(toMainTransfers.at(-1)).toEqual([zg.buffer]);
  });

  it('transfers faceIds buffer too when present', async () => {
    const { client, toWorkerTransfers } = makeHarness();
    const mesh = makeMesh();
    mesh.faceIds = new Uint32Array([7]);
    const faceBuf = mesh.faceIds.buffer;
    await client.uploadMesh(mesh);
    expect(toWorkerTransfers[0]).toHaveLength(3);
    expect(toWorkerTransfers[0][2]).toBe(faceBuf);
  });

  it('routes progress events to the right caller with fractions', async () => {
    const h = await makeLoadedHarness();
    h.kernel.autoResolve = false;

    const fa: number[] = [];
    const fb: number[] = [];
    const p1 = h.client.dropGrid(h.mesh, h.cutter, GRID_2X2, { onProgress: (f) => fa.push(f) });
    const p2 = h.client.dropPath(h.mesh, h.cutter, new Float64Array([0, 0]), -5, {
      onProgress: (f) => fb.push(f),
    });

    h.kernel.drops[0].emitProgress(0.25);
    h.kernel.drops[1].emitProgress(0.9);
    h.kernel.drops[0].emitProgress(0.5);

    h.kernel.drops[0].resolve(new Float64Array(4));
    h.kernel.drops[1].resolve(new Float64Array(1));
    await Promise.all([p1, p2]);

    expect(fa).toEqual([0.25, 0.5]);
    expect(fb).toEqual([0.9]);
  });

  it('cancel: client abort aborts the kernel call and rejects with AbortError', async () => {
    const h = await makeLoadedHarness();
    h.kernel.autoResolve = false;

    const ac = new AbortController();
    const p = h.client.dropGrid(h.mesh, h.cutter, GRID_2X2, { signal: ac.signal });
    expect(h.kernel.drops).toHaveLength(1);
    expect(h.kernel.drops[0].aborted).toBe(false);

    ac.abort();
    // The cancel message reached the dispatcher, which aborted the kernel op.
    expect(h.kernel.drops[0].aborted).toBe(true);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('cancel: a pre-aborted signal rejects locally without reaching the kernel', async () => {
    const h = await makeLoadedHarness();
    const ac = new AbortController();
    ac.abort();
    await expect(
      h.client.dropGrid(h.mesh, h.cutter, GRID_2X2, { signal: ac.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.kernel.drops).toHaveLength(0);
  });

  it('cancel: aborting one request leaves a concurrent one untouched', async () => {
    const h = await makeLoadedHarness();
    h.kernel.autoResolve = false;

    const ac = new AbortController();
    const p1 = h.client.dropGrid(h.mesh, h.cutter, GRID_2X2, { signal: ac.signal });
    const p2 = h.client.dropGrid(h.mesh, h.cutter, GRID_2X2);
    ac.abort();
    h.kernel.drops[1].resolve(Float64Array.of(7, 7, 7, 7));

    await expect(p1).rejects.toMatchObject({ name: 'AbortError' });
    expect(Array.from(await p2)).toEqual([7, 7, 7, 7]);
    expect(h.kernel.drops[1].aborted).toBe(false);
  });

  it('surfaces async kernel rejections with name and message preserved', async () => {
    const h = await makeLoadedHarness();
    h.kernel.autoResolve = false;

    const p = h.client.dropGrid(h.mesh, h.cutter, GRID_2X2);
    const boom = new Error('use-after-dispose of handle #7');
    boom.name = 'KernelHandleError';
    h.kernel.drops[0].reject(boom);

    const err = (await p.then(
      () => {
        throw new Error('expected rejection');
      },
      (e: unknown) => e,
    )) as Cam3dWorkerError;
    expect(err).toBeInstanceOf(Cam3dWorkerError);
    expect(err.name).toBe('KernelHandleError');
    expect(err.message).toBe('use-after-dispose of handle #7');
    // stack captured worker-side rides along for diagnostics
    expect(err.workerStack).toBeDefined();
  });

  it('surfaces sync kernel throws (makeCutter) with name and message', async () => {
    const { client, kernel } = makeHarness();
    const bad = new Error('negative diameter');
    bad.name = 'CutterSpecError';
    kernel.makeCutterError = bad;
    await expect(client.makeCutter({ kind: 'flat', diameter: -1 })).rejects.toMatchObject({
      name: 'CutterSpecError',
      message: 'negative diameter',
    });
  });

  it('dispose releases every still-live handle and terminates the worker', async () => {
    const { client, kernel, terminated } = makeHarness();
    const m1 = await client.uploadMesh(makeMesh());
    const m2 = await client.uploadMesh(makeMesh());
    const c1 = await client.makeCutter({ kind: 'ball', diameter: 3 });
    await client.releaseMesh(m1); // released explicitly: must NOT be re-released

    kernel.calls.length = 0;
    await client.dispose();

    // cutters first, then meshes, insertion order (fixed iteration order)
    expect(kernel.calls).toEqual([`releaseCutter:${c1}`, `releaseMesh:${m2}`]);
    expect(terminated()).toBe(true);
    await expect(client.init()).rejects.toThrow(/after dispose/);
    await expect(client.dispose()).rejects.toThrow(/after dispose/);
  });

  it('dispose aborts in-flight requests so their callers hear about it', async () => {
    const h = await makeLoadedHarness();
    h.kernel.autoResolve = false;

    const p = h.client.dropGrid(h.mesh, h.cutter, GRID_2X2);
    await h.client.dispose();

    expect(h.kernel.drops[0].aborted).toBe(true);
    await expect(p).rejects.toMatchObject({ name: 'AbortError' });
    expect(h.dispatcher.inflightCount).toBe(0);
  });

  it('throws loudly on an unknown message kind', () => {
    const { dispatcher } = makeHarness();
    expect(() =>
      dispatcher.handle({ kind: 'reticulateSplines', requestId: 42 } as unknown as Cam3dRequest),
    ).toThrow(/unknown request kind 'reticulateSplines'/);
  });

  it('resolves concurrent dropGrids to the right callers (reverse settle)', async () => {
    const h = await makeLoadedHarness();
    h.kernel.autoResolve = false;

    const gridB: GridSpec = { ...GRID_2X2, nx: 3, ny: 1 };
    const p1 = h.client.dropGrid(h.mesh, h.cutter, GRID_2X2);
    const p2 = h.client.dropGrid(h.mesh, h.cutter, gridB);
    expect(h.dispatcher.inflightCount).toBe(2);

    // settle in REVERSE order to prove routing is by requestId, not FIFO
    h.kernel.drops[1].resolve(Float64Array.of(9, 9, 9));
    h.kernel.drops[0].resolve(Float64Array.of(1, 2, 3, 4));

    expect(Array.from(await p1)).toEqual([1, 2, 3, 4]);
    expect(Array.from(await p2)).toEqual([9, 9, 9]);
    expect(h.dispatcher.inflightCount).toBe(0);
  });
});

// ---- stock ops (additive: worker-side z-dexel stock) ----

describe('cam3d worker stock ops', () => {
  const STOCK_BOX = { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 10, maxZ: 5 };

  it('round-trips create -> batch sweep -> toMesh -> dispose', async () => {
    const { client, dispatcher, toWorkerTransfers, toMainTransfers } = makeHarness();

    const created = await client.stockCreate(STOCK_BOX, 1);
    expect(created.nx).toBe(20);
    expect(created.ny).toBe(10);
    expect(created.cell).toBe(1);
    expect(created.warnings).toEqual([]);
    expect(dispatcher.liveStockCount).toBe(1);

    // Batch of two moves, ONE boundary call: a horizontal cut then a plunge.
    const swept = await client.stockRemoveSweep(created.stock, { kind: 'flat', diameter: 4 }, [
      { x0: 5, y0: 5, z0: 3, x1: 15, y1: 5, z1: 3 },
      { x0: 5, y0: 5, z0: 3, x1: 5, y1: 5, z1: 2 },
    ]);
    expect(swept.removedVolumeMm3).toBeGreaterThan(0);
    expect(swept.columnsChanged).toBeGreaterThan(0);
    // The packed moves buffer (2 moves * 6 f64) was TRANSFERRED, not cloned.
    const sweepTransfer = toWorkerTransfers.at(-1);
    expect(sweepTransfer).toHaveLength(1);
    expect((sweepTransfer![0] as ArrayBuffer).byteLength).toBe(2 * 6 * 8);

    const mesh = await client.stockToMesh(created.stock);
    expect(mesh.positions).toBeInstanceOf(Float32Array);
    expect(mesh.indices).toBeInstanceOf(Uint32Array);
    expect(mesh.triangleCount).toBeGreaterThan(12); // carved: more than a box
    expect(mesh.indices.length).toBe(mesh.triangleCount * 3);
    expect(mesh.positions.length).toBe(mesh.vertexCount * 3);
    // Both result buffers came back TRANSFERRED in one post.
    expect(toMainTransfers.at(-1)).toEqual([mesh.positions.buffer, mesh.indices.buffer]);

    await client.stockDispose(created.stock);
    expect(dispatcher.liveStockCount).toBe(0);
  });

  it('stockDispose invalidates the handle loudly (use-after-dispose)', async () => {
    const { client } = makeHarness();
    const created = await client.stockCreate(STOCK_BOX, 1);
    await client.stockDispose(created.stock);
    await expect(client.stockToMesh(created.stock)).rejects.toThrow(/not live/);
    await expect(
      client.stockRemoveSweep(created.stock, { kind: 'flat', diameter: 4 }, [
        { x0: 0, y0: 0, z0: 3, x1: 1, y1: 0, z1: 3 },
      ]),
    ).rejects.toThrow(/not live/);
    await expect(client.stockDispose(created.stock)).rejects.toThrow(/not live/);
  });

  it('surfaces stock errors with names preserved (budget, bad cutter)', async () => {
    const { client } = makeHarness();
    const created = await client.stockCreate(STOCK_BOX, 1);
    // Triangle budget exceeded inside the worker -> loud error response.
    await expect(client.stockToMesh(created.stock, 4)).rejects.toThrow(/budget of 4/);
    // Unsupported cutter kind fails loud from cutterProfile.
    await expect(
      client.stockRemoveSweep(created.stock, { kind: 'vbit', diameter: 6, angleFromAxisDeg: 30 }, [
        { x0: 0, y0: 0, z0: 3, x1: 1, y1: 0, z1: 3 },
      ]),
    ).rejects.toThrow(/not supported/);
    // The stock survives failed calls.
    const mesh = await client.stockToMesh(created.stock);
    expect(mesh.triangleCount).toBe(12); // untouched box
  });

  it('global dispose clears live stock fields with everything else', async () => {
    const { client, dispatcher } = makeHarness();
    await client.stockCreate(STOCK_BOX, 1);
    await client.stockCreate(STOCK_BOX, 1);
    expect(dispatcher.liveStockCount).toBe(2);
    await client.dispose();
    expect(dispatcher.liveStockCount).toBe(0);
  });
});
