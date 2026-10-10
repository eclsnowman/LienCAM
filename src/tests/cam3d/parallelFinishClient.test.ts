// cam3d parallelFinish client round-trip + dispose-after-crash tests.
//
// Round-trip runs through the SAME fake message channel the worker scaffold
// tests use, but wired to a REAL BvhKernel (not a mock) so the strategy does
// genuine drop-cutter work on a small fixture, then feeds the result through
// the IR -> ToolpathMove[] converter. Determinism is asserted across two runs.
//
// The dispose tests cover Deliverable 1: dispose() must RESOLVE (never hang)
// after a simulated worker crash, and on a normal lifecycle.

import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { PartMesh } from '../../cam3d/kernel/types';
import { wave } from '../../cam3d/fixtures';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import {
  Cam3dClient,
  type ParallelFinishClientInput,
  type WorkerLike,
} from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import { irToToolpathMoves } from '../../cam3d/ir/toToolpathMoves';
import type { ToolpathMove } from '../../types';

// In-process channel: client <-> dispatcher(real BvhKernel), synchronous post.
function makeHarness() {
  const kernel = new BvhKernel();
  let isTerminated = false;
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {
      isTerminated = true;
    },
  };
  const dispatcher = new Cam3dDispatcher(kernel, (msg: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: msg } as MessageEvent);
  });
  const client = new Cam3dClient(fakeWorker);
  return { client, dispatcher, kernel, fakeWorker, terminated: () => isTerminated };
}

// Faithful-transfer channel: unlike makeHarness (whose fake postMessage ignores
// the transfer list, so nothing ever detaches), this one simulates a REAL
// Worker.postMessage by transferring the listed buffers out of this realm via
// structuredClone. That detaches them from the client-side message exactly as a
// real worker boundary would, and hands the dispatcher the clone that now owns
// them. Needed to reproduce the parallel_3d "ArrayBuffer already detached"
// regenerate bug, which is invisible to the non-transferring harness.
function makeTransferHarness() {
  const kernel = new BvhKernel();
  let isTerminated = false;
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown, transfer?: Transferable[]): void {
      const delivered =
        transfer && transfer.length > 0
          ? structuredClone(message, { transfer }) // detaches transfer[] in this realm
          : message;
      dispatcher.handle(delivered as Cam3dRequest);
    },
    terminate(): void {
      isTerminated = true;
    },
  };
  const dispatcher = new Cam3dDispatcher(kernel, (msg: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: msg } as MessageEvent);
  });
  const client = new Cam3dClient(fakeWorker);
  return { client, dispatcher, kernel, fakeWorker, terminated: () => isTerminated };
}

function tinyMesh(): PartMesh {
  return {
    positions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    indices: new Uint32Array([0, 1, 2]),
    bounds: { min: [0, 0, 0], max: [10, 10, 0] },
    source: 'fixture',
  };
}

// A small, fast fixture: wave heightfield on a 25x25 grid over [0,20]^2.
function smallInput(cutterKind: 'flat' | 'ball'): ParallelFinishClientInput {
  return {
    partMesh: wave(20, 25),
    cutter: { kind: cutterKind, diameter: 6 },
    stepover: 4,
    angleDeg: 0,
    tolerance: 0.1,
    heights: { clearanceZ: 25, retractZ: 16, feedZ: 16 },
    zSeed: 0,
    xyBounds: { minX: 0, minY: 0, maxX: 20, maxY: 20 },
  };
}

const VALID_TYPES = new Set(['rapid', 'feed', 'arc_cw', 'arc_ccw']);
const VALID_ROLES = new Set([
  'rapid',
  'cut',
  'helix',
  'ramp',
  'plunge',
  'stepover',
  'fast_traverse',
  'lead_in',
  'lead_out',
  'loop_back',
  'wall_follow',
  'finish',
]);

function assertWellFormed(moves: ToolpathMove[]): void {
  expect(moves.length).toBeGreaterThan(0);
  for (const m of moves) {
    expect(VALID_TYPES.has(m.type), `bad type ${m.type}`).toBe(true);
    expect(Number.isFinite(m.x) && Number.isFinite(m.y) && Number.isFinite(m.z)).toBe(true);
    if (m.role !== undefined) expect(VALID_ROLES.has(m.role), `bad role ${m.role}`).toBe(true);
    if (m.feed !== undefined) expect(Number.isFinite(m.feed)).toBe(true);
    if (m.type === 'arc_cw' || m.type === 'arc_ccw') {
      expect(Number.isFinite(m.cx!) && Number.isFinite(m.cy!)).toBe(true);
    }
  }
}

describe('Cam3dClient.generateParallelFinish (real kernel round-trip)', () => {
  for (const kind of ['flat', 'ball'] as const) {
    it(`returns a non-empty IR and well-formed moves (${kind} d6)`, { timeout: 60_000 }, async () => {
      const h = makeHarness();
      const ir = await h.client.generateParallelFinish(smallInput(kind));
      expect(ir.moves.length).toBeGreaterThan(0);
      expect(ir.moves.some((mv) => mv.role === 'cut')).toBe(true);
      expect(ir.meta.strategyId).toBe('parallel_finish');

      const moves = irToToolpathMoves(ir);
      assertWellFormed(moves);
      await h.client.dispose();
    });
  }

  it('is byte-stable across two runs (determinism, D-006)', { timeout: 60_000 }, async () => {
    const h = makeHarness();
    // Fresh fixtures each run (a real transfer would detach the first); wave()
    // is deterministic so the two meshes are byte-identical inputs.
    const a = await h.client.generateParallelFinish(smallInput('ball'));
    const b = await h.client.generateParallelFinish(smallInput('ball'));
    expect(JSON.stringify(b.moves)).toBe(JSON.stringify(a.moves));
    expect(JSON.stringify(irToToolpathMoves(b))).toBe(JSON.stringify(irToToolpathMoves(a)));
    await h.client.dispose();
  });

  it('does not detach the caller mesh -> regenerate with the SAME mesh works (ArrayBuffer-detached regression)', { timeout: 60_000 }, async () => {
    // The STEP importer memoizes its result mesh, so a regenerate (change a
    // param, run again) reuses the exact same PartMesh object. Transfer must not
    // detach it, or the second post throws "ArrayBuffer already detached" and
    // every 3D-finish regenerate is dead until reload. Uses the faithful
    // transfer harness so the detach actually happens (as in a real worker).
    const h = makeTransferHarness();
    const input = smallInput('ball'); // ONE mesh object, reused across both runs
    const ir1 = await h.client.generateParallelFinish(input);
    expect(ir1.moves.length).toBeGreaterThan(0);
    // The caller's mesh survived the transfer (was the bug: byteLength -> 0).
    expect(input.partMesh.positions.byteLength).toBeGreaterThan(0);
    expect(input.partMesh.indices.byteLength).toBeGreaterThan(0);
    // Regenerate with the SAME mesh must not throw and must still produce moves.
    const ir2 = await h.client.generateParallelFinish(input);
    expect(ir2.moves.length).toBeGreaterThan(0);
    await h.client.dispose();
  });

  it('reports coarse progress ending at 1', { timeout: 60_000 }, async () => {
    const h = makeHarness();
    const fractions: number[] = [];
    await h.client.generateParallelFinish(smallInput('ball'), {
      onProgress: (f) => fractions.push(f),
    });
    expect(fractions.length).toBeGreaterThan(0);
    expect(fractions[0]).toBe(0);
    expect(fractions.at(-1)).toBe(1);
    for (const f of fractions) {
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThanOrEqual(1);
    }
    await h.client.dispose();
  });

  it('does not leak the uploaded mesh handle (disposed in the worker finally)', { timeout: 60_000 }, async () => {
    const h = makeHarness();
    await h.client.generateParallelFinish(smallInput('flat'));
    // The strategy handle was created and released inside the dispatcher; it
    // was never tracked in liveMeshes, so a global dispose has nothing to do
    // with it and the kernel registry is back to empty.
    await h.client.dispose();
    expect(h.terminated()).toBe(true);
  });
});

describe('Cam3dClient.dispose lifecycle (Deliverable 1)', () => {
  it('resolves after a simulated worker crash instead of hanging', { timeout: 5_000 }, async () => {
    const h = makeHarness();
    await h.client.uploadMesh(tinyMesh());
    // Simulate a worker-level crash: onerror drains pending and marks dead.
    h.fakeWorker.onerror?.({ message: 'simulated worker crash' } as ErrorEvent);
    // The previous implementation awaited a dispose round-trip with no
    // responder here and hung forever; this must resolve promptly.
    await expect(h.client.dispose()).resolves.toBeUndefined();
    expect(h.terminated()).toBe(true);
  });

  it('an in-flight request rejects on crash and later calls fail fast', { timeout: 5_000 }, async () => {
    const h = makeHarness();
    h.fakeWorker.onerror?.({ message: 'boom' } as ErrorEvent);
    // Post-crash calls fail loud (dead client) rather than hang.
    await expect(h.client.uploadMesh(tinyMesh())).rejects.toThrow(/worker crash/);
    await expect(h.client.dispose()).resolves.toBeUndefined();
  });

  it('resolves on a normal lifecycle and rejects a second dispose', { timeout: 5_000 }, async () => {
    const h = makeHarness();
    await h.client.uploadMesh(tinyMesh());
    await expect(h.client.dispose()).resolves.toBeUndefined();
    expect(h.terminated()).toBe(true);
    await expect(h.client.dispose()).rejects.toThrow(/after dispose/);
  });
});
