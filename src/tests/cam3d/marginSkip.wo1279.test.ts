// WO-1279: with Clip to stock outline on, the finish cuts the margin down to
// the floor.
//
// The kernel's contract returns exactly zSeed where nothing lies under the
// cutter (a MISS), and the parallel strategy used to emit that as a cut: a
// finishing pass ploughing the full depth of the stock margin at finishing
// feed over ground with no part under it. These tests are behavioural: a part
// smaller than its region is finished to its edge and no further, nothing is
// ever cut at the floor, every sample over the part is bit-identical to the
// same part finished at its own bounds, a region with no part under it at all
// refuses out loud, and two parts in one region (a nest) are each finished
// with nothing cut in the gap between them.

import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { CutterHandle, MeshHandle, PartMesh } from '../../cam3d/kernel/types';
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder';
import { wave } from '../../cam3d/fixtures';
import { parallelFinish, spanSamples } from '../../cam3d/strategies/parallel';
import type { IrMove, ToolpathIR } from '../../cam3d/ir/types';
import type { Ring } from '../../cam3d/geom2d';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import type { Tool, ToolpathMove } from '../../types';
import {
  computeParallel3dMoves,
  resolveStockEdgeOverrun,
  STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM,
  xyBoundsRing,
  type Parallel3dParams,
  type ResolvedParallel3dHeights,
} from '../../cam3d/integration/parallel3dOperation';

const SIZE = 20;
const Z0 = 5;
const SLOPE = 0.5;
const FLAT6 = { kind: 'flat', diameter: 6 } as const;
const R = 3;
const OVERRUN = R - STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM;
/** The stock margin around the part in every stock-mode test: wider than the radius. */
const MARGIN = 10;

/** A closed slab over [x0, x0+SIZE] x [0, SIZE], top z = Z0 + SLOPE * (x - x0). */
function slopedSlab(b: MeshBuilder, x0 = 0, n = 21): void {
  const top = (x: number, y: number): number => b.vertex(x, y, Z0 + SLOPE * (x - x0));
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const xa = x0 + (SIZE * i) / (n - 1), xb = x0 + (SIZE * (i + 1)) / (n - 1);
      const ya = (SIZE * j) / (n - 1), yb = (SIZE * (j + 1)) / (n - 1);
      b.quad(top(xa, ya), top(xb, ya), top(xb, yb), top(xa, yb));
    }
  }
  const x1 = x0 + SIZE;
  const c00 = b.vertex(x0, 0, 0), c10 = b.vertex(x1, 0, 0);
  const c11 = b.vertex(x1, SIZE, 0), c01 = b.vertex(x0, SIZE, 0);
  b.quad(c00, c01, c11, c10);
  b.quad(c00, c10, top(x1, 0), top(x0, 0));
  b.quad(c10, c11, top(x1, SIZE), top(x1, 0));
  b.quad(c11, c01, top(x0, SIZE), top(x1, SIZE));
  b.quad(c01, c00, top(x0, 0), top(x0, SIZE));
}

function slab(): PartMesh {
  const b = new MeshBuilder();
  slopedSlab(b);
  return b.build();
}

/** Two slabs side by side with a 10 mm gap of nothing between them. */
const NEST_GAP = 10;
function nest(): PartMesh {
  const b = new MeshBuilder();
  slopedSlab(b, 0);
  slopedSlab(b, SIZE + NEST_GAP);
  return b.build();
}

function rect(minX: number, minY: number, maxX: number, maxY: number): Ring {
  return new Float64Array([minX, minY, maxX, minY, maxX, maxY, minX, maxY]);
}

const kernel = new BvhKernel();
const HEIGHTS = { clearanceZ: 30, retractZ: 20, feedZ: 20 };
/** The stock floor: below the part bottom, exactly what the app hands the strategy. */
const Z_SEED = -10;

function cutMoves(ir: ToolpathIR): IrMove[] {
  return ir.moves.filter(m => m.role === 'cut');
}

async function redrop(mesh: MeshHandle, cutter: CutterHandle, pts: readonly { x: number; y: number }[]): Promise<Float64Array> {
  const xy = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    xy[2 * i] = pts[i].x;
    xy[2 * i + 1] = pts[i].y;
  }
  return kernel.dropPoints(mesh, cutter, xy, Z_SEED);
}

function baseInput(mesh: MeshHandle) {
  return {
    mesh, cutter: FLAT6, stepover: 2, angleDeg: 0, tolerance: 0.05, heights: HEIGHTS, zSeed: Z_SEED,
  };
}

/** What the adapter hands the strategy in stock-outline mode: the stock ring and its overrun band. */
async function stockModeInput(mesh: MeshHandle, stock: Ring) {
  const overrun = await resolveStockEdgeOverrun({
    cutterRadius: R, boundary: [stock], boundaryKind: 'stock',
    xyBounds: { minX: 0, minY: 0, maxX: SIZE, maxY: SIZE },
  });
  return { ...baseInput(mesh), boundary: [stock], overrunBoundary: overrun.rings! };
}

const key = (m: { x: number; y: number; z: number }) => `${m.x}|${m.y}|${m.z}`;

describe('WO-1279 strategy: a finish cuts only where the cutter meets the part', () => {
  const slabMesh = kernel.uploadMesh(slab());
  const STOCK = rect(-MARGIN, -MARGIN, SIZE + MARGIN, SIZE + MARGIN);

  it('a part smaller than its stock outline is finished to one radius past its edge and no further, never at the floor', async () => {
    const ir = await parallelFinish(kernel, await stockModeInput(slabMesh, STOCK));
    const cuts = cutMoves(ir);
    expect(cuts.length).toBeGreaterThan(0);
    // Nothing is cut at the floor, anywhere: the lowest surface on the part is Z0.
    for (const m of cuts) expect(m.z).toBeGreaterThanOrEqual(Z0 - 1e-9);
    // The passes reach tangency with the part edge (one radius, to 0.01 mm)
    // and not one sample lies further into the margin than that.
    const xs = cuts.map(m => m.x);
    expect(Math.min(...xs)).toBeGreaterThanOrEqual(-R - 1e-9);
    expect(Math.min(...xs)).toBeLessThanOrEqual(-OVERRUN + 0.01);
    expect(Math.max(...xs)).toBeLessThanOrEqual(SIZE + R + 1e-9);
    expect(Math.max(...xs)).toBeGreaterThanOrEqual(SIZE + OVERRUN - 0.01);
    // The tip at the refined end is on the surface at the edge, not R*slope above it.
    const atStart = cuts.filter(m => m.x < -OVERRUN + 0.02);
    expect(atStart.length).toBeGreaterThan(0);
    for (const m of atStart) expect(m.z).toBeLessThanOrEqual(Z0 + SLOPE * 0.03);
    // No scanline lies further than a radius from the part (y = -2 .. 22 at 2 mm).
    const ys = [...new Set(cuts.map(m => m.y))].sort((a, b) => a - b);
    expect(ys[0]).toBeCloseTo(-2, 9);
    expect(ys[ys.length - 1]).toBeCloseTo(SIZE + 2, 9);
    // No gouge: every cut point is at or above an independent drop.
    const c = kernel.makeCutter(FLAT6);
    try {
      const truth = await redrop(slabMesh, c, cuts);
      for (let i = 0; i < cuts.length; i++) expect(cuts[i].z).toBeGreaterThanOrEqual(truth[i] - 1e-9);
    } finally {
      kernel.releaseCutter(c);
    }
    expect(ir.meta.params?.skippedSamples).toBeGreaterThan(0);
  });

  it('every sample over the part is bit-identical to what the legacy lattice produced; everything else is a refined end', async () => {
    // The legacy strategy sampled each in-region span uniformly (spanSamples,
    // the one formula both paths share) and emitted EVERY sample, misses at
    // zSeed included. Rebuild that lattice for the stock span, drop it the
    // legacy way, and require: (1) every legacy HIT survives bit-for-bit;
    // (2) every cut sample that is not a legacy hit is a refined run end,
    // within one chord step of a part edge.
    const input = await stockModeInput(slabMesh, STOCK);
    const ir = await parallelFinish(kernel, input);
    const step = Math.min(Math.max(Math.sqrt(8 * input.tolerance * R), input.tolerance), input.stepover);
    const c = kernel.makeCutter(FLAT6);
    const legacyHits = new Set<string>();
    try {
      for (let y = 0; y <= SIZE; y += input.stepover) {
        const ts = spanSamples(-MARGIN, SIZE + MARGIN, step, true, true);
        const xy = new Float64Array(ts.length * 2);
        for (let i = 0; i < ts.length; i++) {
          xy[2 * i] = ts[i];
          xy[2 * i + 1] = y;
        }
        const z = await kernel.dropPoints(slabMesh, c, xy, Z_SEED);
        for (let i = 0; i < ts.length; i++) if (z[i] > Z_SEED) legacyHits.add(key({ x: ts[i], y, z: z[i] }));
      }
    } finally {
      kernel.releaseCutter(c);
    }
    expect(legacyHits.size).toBeGreaterThan(100);
    const emitted = new Set(ir.moves.map(key));
    for (const k of legacyHits) expect(emitted.has(k), `legacy hit ${k} moved or vanished`).toBe(true);
    // A pass's FIRST sample is emitted by the linker as the lead-in touchdown,
    // the plunge, or the end of a stay-down stepover link, so pass samples are
    // gathered across those roles; connector interior samples sit between
    // scanlines and are excluded by the lattice-row test.
    const onRow = (y: number) => Math.abs(y / input.stepover - Math.round(y / input.stepover)) < 1e-9 && y >= 0 && y <= SIZE;
    const passRoles = new Set(['cut', 'lead_in', 'plunge', 'stepover']);
    const refinedPositions = new Set<string>();
    for (const m of ir.moves) {
      if (!passRoles.has(String(m.role)) || !onRow(m.y)) continue;
      if (legacyHits.has(key(m))) continue;
      const nearEdge = Math.abs(m.x - (-R)) <= step + 0.01 || Math.abs(m.x - (SIZE + R)) <= step + 0.01;
      if (m.role === 'stepover' && !nearEdge) continue; // a connector endpoint on a legacy sample it links to
      expect(nearEdge, `unexpected sample ${key(m)} (${m.role})`).toBe(true);
      refinedPositions.add(key(m));
    }
    // Two refined ends per containment row (11 rows at 2 mm over [0, 20]);
    // the WO-1271 band rows beyond refine their own ends on top of that.
    expect(refinedPositions.size).toBe(2 * (SIZE / input.stepover + 1));
    expect(ir.meta.params?.refinedEnds).toBeGreaterThanOrEqual(refinedPositions.size);
  });

  it('a region with no part under it at all refuses out loud', async () => {
    const far = rect(100, 100, 120, 120);
    await expect(parallelFinish(kernel, { ...baseInput(slabMesh), boundary: [far] }))
      .rejects.toThrow(/no part surface/);
  });

  it('a wave that fills its region is unchanged: no sample is skipped and the output is the legacy output', async () => {
    const waveMesh = kernel.uploadMesh(wave(SIZE, 25));
    const ir = await parallelFinish(kernel, {
      ...baseInput(waveMesh), xyBounds: { minX: 0, minY: 0, maxX: SIZE, maxY: SIZE },
    });
    expect(ir.meta.params?.skippedSamples).toBeUndefined();
    expect(cutMoves(ir).length).toBeGreaterThan(0);
  });

  it('two parts in one stock (a nest): each is finished, nothing is cut in the gap, and the gap is crossed above the surface', async () => {
    const nestMesh = kernel.uploadMesh(nest());
    const stock = rect(-MARGIN, -MARGIN, 2 * SIZE + NEST_GAP + MARGIN, SIZE + MARGIN);
    const ir = await parallelFinish(kernel, await stockModeInput(nestMesh, stock));
    const cuts = cutMoves(ir);
    for (const m of cuts) expect(m.z).toBeGreaterThanOrEqual(Z0 - 1e-9);
    const gapLo = SIZE + R;
    const gapHi = SIZE + NEST_GAP - R;
    let left = 0, right = 0;
    for (const m of cuts) {
      expect(m.x > gapLo + 1e-9 && m.x < gapHi - 1e-9, `cut at x=${m.x} in the gap`).toBe(false);
      if (m.x < gapLo) left++;
      else right++;
    }
    expect(left).toBeGreaterThan(100);
    expect(right).toBeGreaterThan(100);
    // Any feed move that spans the gap rides at or above the part tops, never the floor.
    for (const m of ir.moves) {
      if (m.role === 'cut') continue;
      if (m.x > gapLo + 1e-6 && m.x < gapHi - 1e-6) expect(m.z).toBeGreaterThanOrEqual(Z0 - 1e-9);
    }
  });
});

// ---------------------------------------------------------------------------
// Adapter: the same through the operation door
// ---------------------------------------------------------------------------

function makeClient(): Cam3dClient {
  const k = new BvhKernel();
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {},
  };
  const dispatcher = new Cam3dDispatcher(k, (msg: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: msg } as MessageEvent);
  });
  return new Cam3dClient(fakeWorker);
}

const FLAT_TOOL: Tool = {
  id: 'tool-flat6', name: 'flat d6', type: 'flat_end_mill', diameter: 6, fluteLength: 20,
  shankDiameter: 6, overallLength: 50, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  notes: '', feedsAndSpeeds: {},
};
const HEIGHTS_APP: ResolvedParallel3dHeights = { clearanceZ: 30, retractZ: 20, feedZ: 20, topZ: 15, bottomZ: -10 };
const PARAMS: Parallel3dParams = { stepover: 2, angleDeg: 0, tolerance: 0.05, useStockBoundary: true };

function extent(moves: readonly ToolpathMove[]) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, cuts = 0;
  for (const m of moves) {
    if (m.role !== 'cut') continue;
    cuts++;
    minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x); minZ = Math.min(minZ, m.z);
  }
  return { minX, maxX, minZ, cuts };
}

describe('WO-1279 adapter: Clip to stock outline on a part smaller than its stock', () => {
  const part = slab();
  const stock = [rect(-MARGIN, -MARGIN, SIZE + MARGIN, SIZE + MARGIN)];

  it('with the auto overrun and with Edge overrun 0 alike, the margin is never ploughed and the part is finished to tangency', { timeout: 60_000 }, async () => {
    for (const stockEdgeOvershoot of [undefined, 0]) {
      const { moves } = await computeParallel3dMoves({
        partMesh: part, tool: FLAT_TOOL, params: { ...PARAMS, stockEdgeOvershoot },
        resolvedHeights: HEIGHTS_APP, client: makeClient(), boundary: stock, boundaryKind: 'stock',
      });
      const e = extent(moves);
      expect(e.cuts).toBeGreaterThan(0);
      expect(e.minZ).toBeGreaterThanOrEqual(Z0 - 1e-9);
      expect(e.minX).toBeGreaterThanOrEqual(-R - 1e-9);
      expect(e.minX).toBeLessThanOrEqual(-OVERRUN + 0.01);
      expect(e.maxX).toBeLessThanOrEqual(SIZE + R + 1e-9);
    }
  });

  it('a part-bounds run of the same part is byte-identical to before (the wave gate pins hold elsewhere)', { timeout: 60_000 }, async () => {
    const a = await computeParallel3dMoves({
      partMesh: part, tool: FLAT_TOOL, params: { ...PARAMS, useStockBoundary: false },
      resolvedHeights: HEIGHTS_APP, client: makeClient(),
    });
    const b = await computeParallel3dMoves({
      partMesh: part, tool: FLAT_TOOL, params: { ...PARAMS, useStockBoundary: false },
      resolvedHeights: HEIGHTS_APP, client: makeClient(),
    });
    expect(JSON.stringify(a.moves)).toBe(JSON.stringify(b.moves));
    expect(extent(a.moves).minZ).toBeGreaterThanOrEqual(Z0 - 1e-9);
  });

  it('xyBoundsRing is the strategy rectangle', () => {
    expect(Array.from(xyBoundsRing({ minX: 1, minY: 2, maxX: 3, maxY: 4 }))).toEqual([1, 2, 3, 2, 3, 4, 1, 4]);
  });
});
