// WO-1281: scallop marched its distance field across the stock margin at
// floor height.
//
// The strategy drops a grid over the containment and masked it by the ring
// alone, so with a stock outline larger than the part its geodesic field was
// seeded at the STOCK edge, marched flat across the margin at the kernel's
// miss value (the floor), climbed the part's cliff, and the contours stitched
// from that field ran over the margin at full depth. The mask is now the
// CONTACT region (inside the ring AND the cutter meets the part), so the seeds
// are the cutter-contact silhouette and the field never contains the margin.
//
// Identity, honestly: a part that fills its region has no miss cell, so its
// output is byte-identical (the fingerprint below was recorded BEFORE the
// change). A part smaller than its region gets contours that MOVE BY DESIGN:
// they were derived from a field seeded through floor and cliff, and moving
// the seeds to the silhouette is the fix. For that case the proof is that
// every contour vertex rides the cutter-location surface, none is at the
// floor, none lies further than one radius from the part, and a nest is
// finished part by part with nothing in the gap.

import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { CutterHandle, MeshHandle, PartMesh } from '../../cam3d/kernel/types';
import { classifyProbedDrops, MISS_PROBE_MARGIN_MM, probeSeedBelow } from '../../cam3d/kernel/dropClassify';
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder';
import { wave } from '../../cam3d/fixtures';
import { irFingerprint } from '../../cam3d/ir/types';
import type { IrMove, ToolpathIR } from '../../cam3d/ir/types';
import type { Ring } from '../../cam3d/geom2d';
import { scallopFinish } from '../../cam3d/strategies/scallop';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import type { Tool } from '../../types';
import { computeScallop3dMoves } from '../../cam3d/integration/scallop3dOperation';

const SIZE = 20;
const BALL6 = { kind: 'ball', diameter: 6 } as const;
const R = 3;
const MARGIN = 10;
const Z_SEED = -10;
const HEIGHTS = { clearanceZ: 30, retractZ: 20, feedZ: 20 };
const BASE = { cutter: BALL6, scallopHeight: 0.1, tolerance: 0.25, direction: 'climb' as const, heights: HEIGHTS, zSeed: Z_SEED };

/** Recorded on main at 683dec8b9, before this order touched the strategy. */
// WO-2209 (2026-09-29) repinned 47e8731cfda5f3dd / 1322 -> b1a71d38d17f148d / 1580: the shared
// link builder now brings every Feed Height entry back onto the pass start and cuts the pass whole.
const LEGACY_FILL_FINGERPRINT = 'b1a71d38d17f148d';
const LEGACY_FILL_MOVES = 1580;

const Z0 = 5;
const SLOPE = 0.5;
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

describe('WO-1281 kernel/dropClassify: one rule for every consumer', () => {
  it('probes below the floor, knows a miss, and hands back what a probe at zSeed would have', () => {
    const zSeed = -10;
    expect(probeSeedBelow(zSeed)).toBe(zSeed - MISS_PROBE_MARGIN_MM);
    const { z, hit } = classifyProbedDrops(new Float64Array([-11, -10, -9.5, 7]), zSeed);
    // A probe exactly at zSeed is a hit ON the floor; one above it keeps its height.
    expect(Array.from(hit)).toEqual([0, 1, 1, 1]);
    expect(Array.from(z)).toEqual([-10, -10, -9.5, 7]);
  });
});

describe('WO-1281 strategy: a scallop finish cuts only where the cutter meets the part', () => {
  const waveMesh = kernel.uploadMesh(wave(SIZE, 25));

  it('a part that fills its region is byte-identical to the recorded legacy output', { timeout: 60_000 }, async () => {
    const ir = await scallopFinish(kernel, { ...BASE, mesh: waveMesh, xyBounds: { minX: 0, minY: 0, maxX: SIZE, maxY: SIZE } });
    expect(irFingerprint(ir)).toBe(LEGACY_FILL_FINGERPRINT);
    expect(ir.moves.length).toBe(LEGACY_FILL_MOVES);
    expect(ir.meta.params?.skippedGridCells).toBeUndefined();
  });

  it('a part smaller than its stock outline: contours ride the surface, never the floor, never further than a radius from the part', { timeout: 60_000 }, async () => {
    const stock = rect(-MARGIN, -MARGIN, SIZE + MARGIN, SIZE + MARGIN);
    const ir = await scallopFinish(kernel, { ...BASE, mesh: waveMesh, boundary: [stock] });
    const cuts = cutMoves(ir);
    expect(cuts.length).toBeGreaterThan(100);
    // The wave's lowest point is z = 5; the floor is -10. Nothing at the floor.
    for (const m of cuts) expect(m.z).toBeGreaterThan(Z_SEED + 1);
    // Every vertex within a radius (plus a grid cell) of the part footprint.
    const reach = R + BASE.tolerance;
    for (const m of cuts) {
      expect(m.x).toBeGreaterThanOrEqual(-reach);
      expect(m.x).toBeLessThanOrEqual(SIZE + reach);
      expect(m.y).toBeGreaterThanOrEqual(-reach);
      expect(m.y).toBeLessThanOrEqual(SIZE + reach);
    }
    // Every vertex on the cutter-location surface: a contour vertex is
    // interpolated between two grid nodes a cell apart, so it sits within
    // the surface's sag over one cell of an independent drop, never below
    // it by more than that, and never above it by more than a cell.
    const c = kernel.makeCutter(BALL6);
    try {
      const truth = await redrop(waveMesh, c, cuts);
      let worst = 0;
      for (let i = 0; i < cuts.length; i++) worst = Math.max(worst, Math.abs(cuts[i].z - truth[i]));
      expect(worst).toBeLessThanOrEqual(2 * BASE.tolerance);
    } finally {
      kernel.releaseCutter(c);
    }
    expect(ir.meta.params?.skippedGridCells).toBeGreaterThan(0);
    // The contours here MOVE BY DESIGN relative to the pre-WO-1281 output:
    // they are now derived from a field seeded at the cutter-contact
    // silhouette instead of at the stock edge through floor and cliff.
  });

  it('a region with no part under it refuses out loud', async () => {
    await expect(scallopFinish(kernel, { ...BASE, mesh: waveMesh, boundary: [rect(100, 100, 120, 120)] }))
      .rejects.toThrow(/no part surface under it/);
  });

  it('two parts in one stock (a nest): each is finished, nothing is cut in the gap', { timeout: 120_000 }, async () => {
    const nestMesh = kernel.uploadMesh(nest());
    const stock = rect(-MARGIN, -MARGIN, 2 * SIZE + NEST_GAP + MARGIN, SIZE + MARGIN);
    const ir = await scallopFinish(kernel, { ...BASE, mesh: nestMesh, boundary: [stock] });
    const cuts = cutMoves(ir);
    const gapLo = SIZE + R + BASE.tolerance;
    const gapHi = SIZE + NEST_GAP - R - BASE.tolerance;
    let left = 0, right = 0;
    for (const m of cuts) {
      // A ball rolling over a slab's top edge legitimately dips below the
      // top by up to its radius; the floor is 15 mm further down.
      expect(m.z).toBeGreaterThanOrEqual(Z0 - R - 2 * BASE.tolerance);
      expect(m.x > gapLo && m.x < gapHi, `cut at x=${m.x} in the gap`).toBe(false);
      if (m.x < gapLo) left++;
      else right++;
    }
    expect(left).toBeGreaterThan(50);
    expect(right).toBeGreaterThan(50);
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
const BALL_TOOL: Tool = {
  id: 'tool-ball6', name: 'ball d6', type: 'ball_end_mill', diameter: 6, fluteLength: 20,
  shankDiameter: 6, overallLength: 50, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  notes: '', feedsAndSpeeds: {},
};

describe('WO-1281 adapter: Clip to stock outline on a part smaller than its stock', () => {
  it('never cuts the margin and finishes the part', { timeout: 120_000 }, async () => {
    const part = wave(SIZE, 25);
    const { moves } = await computeScallop3dMoves({
      partMesh: part, tool: BALL_TOOL,
      params: { scallopHeight: 0.1, tolerance: 0.25, stockToLeave: 0, useStockBoundary: true, direction: 'climb' },
      resolvedHeights: { clearanceZ: 30, retractZ: 20, feedZ: 20, topZ: 15, bottomZ: Z_SEED },
      boundary: [rect(-MARGIN, -MARGIN, SIZE + MARGIN, SIZE + MARGIN)],
      client: makeClient(),
    });
    const cuts = moves.filter(m => m.role === 'cut');
    expect(cuts.length).toBeGreaterThan(100);
    for (const m of cuts) {
      expect(m.z).toBeGreaterThan(Z_SEED + 1);
      expect(Math.abs(m.x - SIZE / 2)).toBeLessThanOrEqual(SIZE / 2 + R + 0.25);
    }
  });
});
