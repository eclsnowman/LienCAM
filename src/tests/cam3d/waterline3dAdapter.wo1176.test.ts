// WO-1176: the waterline_3d L6 bridge, headless -- an in-process Cam3dClient
// over a Cam3dDispatcher with a REAL BvhKernel and a FAKE slicer, so the whole
// worker protocol (request, progress, cancel, response, error names) is
// exercised without a Worker or the library.

import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { bossInOpenStock } from '../../cam3d/fixtures';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import type { CutterSpec, PartMesh } from '../../cam3d/kernel/types';
import type { Ring } from '../../cam3d/geom2d';
import type { Tool } from '../../types';
import { OclModulePoisonedError, type WaterlineSlicer } from '../../cam3d/kernel/oclWaterline';
import {
  computeWaterline3dMoves,
  defaultWaterlineStepdownFor,
  readWaterlineParams,
  waterlineTileNotice,
  DEFAULT_WATERLINE_PARAMS,
  type WaterlineParams,
} from '../../cam3d/integration/waterline3dOperation';

const PART = bossInOpenStock({ x: 100, y: 100 }, { x: 80, y: 80, z: 14 });

function rectSlicer(record: number[] = []): WaterlineSlicer {
  return {
    name: 'fake-rect',
    async slice(_mesh: PartMesh, cutter: CutterSpec, z: number): Promise<Ring[]> {
      record.push(z);
      if (z > 14 || z < 0) return [];
      const r = cutter.diameter / 2;
      return [new Float64Array([10 - r, 10 - r, 90 + r, 10 - r, 90 + r, 90 + r, 10 - r, 90 + r])];
    },
  };
}

function makeClient(slicer: WaterlineSlicer): Cam3dClient {
  const kernel = new BvhKernel();
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {},
  };
  const dispatcher = new Cam3dDispatcher(kernel, (msg: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: msg } as MessageEvent);
  }, { slicer });
  return new Cam3dClient(fakeWorker);
}

const flat6: Tool = {
  id: 'tool-flat-6', name: 'flat 6', type: 'flat_end_mill', diameter: 6, fluteLength: 20,
  shankDiameter: 6, overallLength: 50, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  notes: '', feedsAndSpeeds: { default: { rpm: 12000, feedRate: 900, plungeRate: 300, depthOfCut: 2, stepover: 1 } },
} as unknown as Tool;

const heights = { clearanceZ: 30, retractZ: 25, feedZ: 19, topZ: 14, bottomZ: 0 };

describe('readWaterlineParams / defaults', () => {
  it('fills missing and invalid fields from the defaults and keeps valid ones', () => {
    expect(readWaterlineParams({})).toEqual(DEFAULT_WATERLINE_PARAMS);
    expect(readWaterlineParams({ stepdown: -1, tolerance: 0, minSlopeDeg: 95, order: 'x', direction: 'y' }))
      .toEqual(DEFAULT_WATERLINE_PARAMS);
    expect(readWaterlineParams({
      stepdown: 0.6, tolerance: 0.02, stockToLeave: 0.3, minSlopeDeg: 43, flatAreaDetection: false,
      order: 'region', direction: 'conventional', finishDepth: 5, useStockBoundary: true,
    })).toEqual({
      stepdown: 0.6, tolerance: 0.02, stockToLeave: 0.3, minSlopeDeg: 43, flatAreaDetection: false,
      order: 'region', direction: 'conventional', finishDepth: 5, useStockBoundary: true,
    });
  });

  it('starts a fresh operation at 10% of the tool diameter, floored at 0.2 mm', () => {
    expect(defaultWaterlineStepdownFor(6)).toBe(0.6);
    expect(defaultWaterlineStepdownFor(1)).toBe(0.2);
    expect(defaultWaterlineStepdownFor(NaN)).toBe(DEFAULT_WATERLINE_PARAMS.stepdown);
  });
});

describe('waterlineTileNotice (WO-2638: tiles, never a size refusal)', () => {
  it('is silent for a small part and names the tiles for a large one', () => {
    expect(waterlineTileNotice(PART, 0.05, 3)).toBeNull();
    const big: PartMesh = { ...PART, bounds: { min: [0, 0, 0], max: [1000, 100, 10] } };
    expect(waterlineTileNotice(big, 0.05, 3)).toMatch(/1000\.0 mm across.*sliced in 2 x 1 tiles at the full tolerance/);
    const huge: PartMesh = { ...PART, bounds: { min: [0, 0, 0], max: [3000, 100, 10] } };
    expect(waterlineTileNotice(huge, 0.05, 3)).toMatch(/sliced in 4 x 1 tiles/);
  });
});

describe('computeWaterline3dMoves through the in-process worker', () => {
  const params: WaterlineParams = { ...DEFAULT_WATERLINE_PARAMS, stepdown: 4, flatAreaDetection: false };

  it('returns moves on every planned level, reports progress, and stays byte-identical across runs', async () => {
    const sliced: number[] = [];
    const client = makeClient(rectSlicer(sliced));
    const fractions: number[] = [];
    const a = await computeWaterline3dMoves({
      partMesh: PART, tool: flat6, params, resolvedHeights: heights, client,
      onProgress: (f) => fractions.push(f),
    });
    expect(sliced).toEqual([10, 6, 2, 0]);
    expect(a.moves.length).toBeGreaterThan(10);
    expect(fractions[0]).toBe(0);
    expect(fractions[fractions.length - 1]).toBe(1);
    const cutZ = new Set(a.moves.filter((m) => m.role === 'cut').map((m) => m.z));
    expect([...cutZ].sort((p, q) => q - p)).toEqual([10, 6, 2, 0]);
    // WO-1678: the adapter carries no reach check; the store's one seam trims its moves.
    expect(a).not.toHaveProperty('holderClearanceWarning');
    const b = await computeWaterline3dMoves({
      partMesh: PART, tool: flat6, params, resolvedHeights: heights, client: makeClient(rectSlicer()),
    });
    expect(JSON.stringify(a.moves)).toBe(JSON.stringify(b.moves));
  });

  it('honours a cancel: the promise rejects with AbortError', async () => {
    const controller = new AbortController();
    let n = 0;
    const slicer: WaterlineSlicer = {
      name: 'cancelling',
      async slice(mesh, cutter, z, sampling) {
        if (++n === 2) controller.abort();
        return rectSlicer().slice(mesh, cutter, z, sampling);
      },
    };
    await expect(computeWaterline3dMoves({
      partMesh: PART, tool: flat6, params, resolvedHeights: heights, client: makeClient(slicer),
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('delegates a V-bit cone to the injected slicer (not proof of production support)', async () => {
    const vbit = { ...flat6, type: 'v_bit', angleFromAxisDeg: 45 } as unknown as Tool;
    const seen: CutterSpec[] = [];
    const injected: WaterlineSlicer = { name: 'record-cone', async slice(mesh, cutter, z, sampling) {
      seen.push(cutter);
      return rectSlicer().slice(mesh, cutter, z, sampling);
    } };
    const client = makeClient(injected);
    try {
      const { moves } = await computeWaterline3dMoves({
        partMesh: PART, tool: vbit, params, resolvedHeights: heights, client,
      });
      expect(seen).toHaveLength(4);
      for (const cutter of seen) expect(cutter).toEqual({ kind: 'vbit', diameter: 6, angleFromAxisDeg: 45 });
      expect(moves.some(m => m.role === 'cut')).toBe(true);
    } finally { await client.dispose(); }
    // WO-2460's store-level test uses the real slicer and records its missing
    // V-bit model. A radius-offset fake rectangle cannot prove cone contact.
  });

  it('refuses an empty result by name', async () => {
    const empty: WaterlineSlicer = { name: 'empty', async slice() { return []; } };
    await expect(computeWaterline3dMoves({
      partMesh: PART, tool: flat6, params, resolvedHeights: heights, client: makeClient(empty),
    })).rejects.toThrow(/no waterline loops/);
  });

  it('computes an oversized part instead of refusing it, and says it was tiled', async () => {
    const sliced: number[] = [];
    const big: PartMesh = { ...PART, bounds: { min: [0, 0, 0], max: [1000, 100, 14] } };
    const out = await computeWaterline3dMoves({
      partMesh: big, tool: flat6, params, resolvedHeights: heights, client: makeClient(rectSlicer(sliced)),
    });
    expect(sliced).toEqual([10, 6, 2, 0]);
    expect(out.notices?.some((n) => /sliced in 2 x 1 tiles/.test(n))).toBe(true);
  });

  it('rethrows a poisoned slicer under the name the store recycles the worker on', async () => {
    const poisoned: WaterlineSlicer = {
      name: 'poisoned',
      async slice() { throw new OclModulePoisonedError('waterline: the slicing library ran out of memory'); },
    };
    await expect(computeWaterline3dMoves({
      partMesh: PART, tool: flat6, params, resolvedHeights: heights, client: makeClient(poisoned),
    })).rejects.toMatchObject({ name: 'OclModulePoisoned' });
  });

  it('passes the stock boundary through and clips the loops to it', async () => {
    const half = [new Float64Array([-10, -10, 50, -10, 50, 110, -10, 110])];
    const { moves } = await computeWaterline3dMoves({
      partMesh: PART, tool: flat6, params, resolvedHeights: heights, client: makeClient(rectSlicer()),
      boundary: half,
    });
    for (const m of moves) if (m.role === 'cut') expect(m.x).toBeLessThanOrEqual(50 + 1e-9);
  });
});
