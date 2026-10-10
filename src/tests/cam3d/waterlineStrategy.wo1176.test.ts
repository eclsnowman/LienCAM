// WO-1176: the waterline strategy end to end with a FAKE slicer (analytic
// loops for a rectangular boss) and a real BvhKernel for the probes.

import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { bossInOpenStock } from '../../cam3d/fixtures';
import type { CutterSpec, PartMesh } from '../../cam3d/kernel/types';
import type { Ring } from '../../cam3d/geom2d';
import { irFingerprint } from '../../cam3d/ir/types';
import type { WaterlineSampling, WaterlineSlicer } from '../../cam3d/kernel/oclWaterline';
import { waterlineSamplingFor } from '../../cam3d/kernel/oclWaterline';
import {
  enlargedCutter, orderPasses, waterlineFinish, type WaterlineFinishInput,
} from '../../cam3d/strategies/waterline';
import type { WaterlinePass } from '../../cam3d/strategies/waterline/loops';

// bossInOpenStock: an 80 x 80 x 14 boss from (10, 10) to (90, 90), base at z = 0.
const PART = bossInOpenStock({ x: 100, y: 100 }, { x: 80, y: 80, z: 14 });

/** Analytic slicer: the boss outline pushed out by the cutter radius, canonical order. */
function fakeSlicer(record: number[] = []): WaterlineSlicer {
  return {
    name: 'fake-rect',
    async slice(_mesh: PartMesh, cutter: CutterSpec, z: number): Promise<Ring[]> {
      record.push(z);
      if (z > 14 || z < 0) return [];
      const r = cutter.diameter / 2;
      const x0 = 10 - r;
      const x1 = 90 + r;
      return [new Float64Array([x0, x0, x1, x0, x1, x1, x0, x1])];
    },
  };
}

function baseInput(kernel: BvhKernel, over: Partial<WaterlineFinishInput> = {}): WaterlineFinishInput {
  return {
    mesh: kernel.uploadMesh(PART),
    partMesh: PART,
    cutter: { kind: 'flat', diameter: 6 },
    stepdown: 4,
    sampling: waterlineSamplingFor(0.05),
    stockToLeave: 0,
    minSlopeDeg: 0,
    flatAreaDetection: true,
    order: 'level',
    direction: 'climb',
    spindle: 'cw',
    topZ: 14,
    bottomZ: 0,
    heights: { clearanceZ: 30, retractZ: 25, feedZ: 19 },
    zSeed: -1,
    ...over,
  };
}

describe('waterlineFinish', () => {
  it('cuts one loop per level, every cut on a planned level, and stays down between them', async () => {
    const kernel = new BvhKernel();
    const sliced: number[] = [];
    const ir = await waterlineFinish(kernel, fakeSlicer(sliced), baseInput(kernel));
    expect(sliced).toEqual([10, 6, 2, 0]);
    expect(ir.meta.strategyId).toBe('waterline_finish');
    expect(ir.meta.params).toMatchObject({ levels: 4, slicer: 'fake-rect', topZ: 14, bottomZ: 0 });
    const cutZ = new Set(ir.moves.filter((m) => m.role === 'cut').map((m) => m.z));
    expect([...cutZ].sort((a, b) => b - a)).toEqual([10, 6, 2, 0]);
    for (const m of ir.moves) {
      expect(m.z).toBeGreaterThanOrEqual(0);
      expect(m.z).toBeLessThanOrEqual(30);
    }
    // Same wall at every level: one entry, no retract between levels, one lift.
    expect(ir.moves.filter((m) => m.t === 'rapid' && m.z === 30)).toHaveLength(2);
    expect(ir.moves.filter((m) => m.role === 'stepover').length).toBeGreaterThanOrEqual(0);
    // Climb around a boss with a cw spindle is clockwise: signed area of the
    // first level's cut polygon is negative.
    const first = ir.moves.filter((m) => m.role === 'cut' && m.z === 10);
    let a = 0;
    for (let i = 0; i < first.length; i++) {
      const p = first[i];
      const q = first[(i + 1) % first.length];
      a += p.x * q.y - q.x * p.y;
    }
    expect(a).toBeLessThan(0);
  });

  it('reports progress per level and honours a cancel between levels', async () => {
    const kernel = new BvhKernel();
    const fractions: number[] = [];
    await waterlineFinish(kernel, fakeSlicer(), baseInput(kernel), { onProgress: (f) => fractions.push(f) });
    expect(fractions[fractions.length - 1]).toBe(1);
    expect(fractions.length).toBeGreaterThanOrEqual(4);
    const controller = new AbortController();
    let n = 0;
    const cancelling: WaterlineSlicer = {
      name: 'cancelling',
      async slice(mesh, cutter, z) {
        if (++n === 2) controller.abort();
        return fakeSlicer().slice(mesh, cutter, z, waterlineSamplingFor(0.05));
      },
    };
    await expect(waterlineFinish(kernel, cancelling, baseInput(kernel), { signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('applies the stock to leave by enlarging the cutter the loops are computed for', async () => {
    const kernel = new BvhKernel();
    const cutters: number[] = [];
    const spy: WaterlineSlicer = {
      name: 'spy',
      async slice(mesh, cutter, z, sampling) {
        cutters.push(cutter.diameter);
        return fakeSlicer().slice(mesh, cutter, z, sampling);
      },
    };
    const ir = await waterlineFinish(kernel, spy, baseInput(kernel, { stockToLeave: 0.5, flatAreaDetection: false }));
    expect(cutters.every((d) => d === 7)).toBe(true);
    // The loop now sits 3.5 mm off the boss: x from 6.5 to 93.5.
    const xs = ir.moves.filter((m) => m.role === 'cut').map((m) => m.x);
    expect(Math.min(...xs)).toBeCloseTo(6.5, 9);
    expect(Math.max(...xs)).toBeCloseTo(93.5, 9);
    expect(enlargedCutter({ kind: 'bull', diameter: 6, cornerRadius: 1 }, 0.5))
      .toEqual({ kind: 'bull', diameter: 7, cornerRadius: 1.5 });
  });

  it('refuses by name when no level has a loop, and when the boundary clips everything away', async () => {
    const kernel = new BvhKernel();
    const empty: WaterlineSlicer = { name: 'empty', async slice() { return []; } };
    await expect(waterlineFinish(kernel, empty, baseInput(kernel))).rejects.toThrow(/no waterline loops on any of the 4 levels/);
    const away = [new Float64Array([200, 200, 210, 200, 210, 210, 200, 210])];
    await expect(waterlineFinish(kernel, fakeSlicer(), baseInput(kernel, { boundary: away })))
      .rejects.toThrow(/removed by the steep-areas-only angle or the boundary clip/);
  });

  it('clips to a boundary into open passes inside the footprint', async () => {
    const kernel = new BvhKernel();
    const half = [new Float64Array([-10, -10, 50, -10, 50, 110, -10, 110])]; // x <= 50
    const ir = await waterlineFinish(kernel, fakeSlicer(), baseInput(kernel, { boundary: half, flatAreaDetection: false }));
    for (const m of ir.moves) if (m.role === 'cut') expect(m.x).toBeLessThanOrEqual(50 + 1e-9);
    expect(ir.moves.filter((m) => m.role === 'cut').length).toBeGreaterThan(0);
  });

  it('is byte-identical across two runs (D-006)', async () => {
    const kernel = new BvhKernel();
    const a = irFingerprint(await waterlineFinish(kernel, fakeSlicer(), baseInput(kernel)));
    const b = irFingerprint(await waterlineFinish(kernel, fakeSlicer(), baseInput(kernel)));
    expect(a).toBe(b);
  });

  it('validates its inputs by name', async () => {
    const kernel = new BvhKernel();
    await expect(waterlineFinish(kernel, fakeSlicer(), baseInput(kernel, { stepdown: 0 }))).rejects.toThrow(/invalid stepdown/);
    await expect(waterlineFinish(kernel, fakeSlicer(), baseInput(kernel, { stockToLeave: -1 }))).rejects.toThrow(/stockToLeave/);
    await expect(waterlineFinish(kernel, fakeSlicer(), baseInput(kernel, { minSlopeDeg: 90 }))).rejects.toThrow(/minSlopeDeg/);
  });
});

describe('orderPasses', () => {
  const sq = (cx: number, level: number, region: number): WaterlinePass => ({
    xy: new Float64Array([cx - 5, -5, cx + 5, -5, cx + 5, 5, cx - 5, 5]),
    z: 10 - level, closed: true, level, materialInside: true, region,
  });

  it('level-first visits every pass of a level before the next level', () => {
    const passes = [sq(0, 0, 0), sq(0, 1, 0), sq(100, 0, 1), sq(100, 1, 1)];
    expect(orderPasses(passes, 'level').map((p) => `${p.region}@${p.level}`))
      .toEqual(['0@0', '1@0', '1@1', '0@1']);
  });

  it('region-first finishes one island to its bottom before the next', () => {
    const passes = [sq(0, 0, 0), sq(0, 1, 0), sq(100, 0, 1), sq(100, 1, 1)];
    expect(orderPasses(passes, 'region').map((p) => `${p.region}@${p.level}`))
      .toEqual(['0@0', '0@1', '1@0', '1@1']);
  });

  it('is deterministic for identical input', () => {
    const passes = [sq(30, 0, 0), sq(0, 0, 1), sq(60, 1, 2)];
    const a = orderPasses(passes, 'level').map((p) => p.xy[0]);
    const b = orderPasses(passes, 'level').map((p) => p.xy[0]);
    expect(a).toEqual(b);
  });
});

describe('waterlineSamplingFor', () => {
  it('maps the default tolerance to 0.5 / 0.025 mm and clamps the extremes', () => {
    expect(waterlineSamplingFor(0.05)).toEqual({ sampling: 0.5, minSampling: 0.025 });
    expect(waterlineSamplingFor(0.001)).toEqual({ sampling: 0.1, minSampling: 0.01 });
    expect(waterlineSamplingFor(1)).toEqual({ sampling: 1, minSampling: 0.5 });
    expect(() => waterlineSamplingFor(0)).toThrow(/tolerance/);
  });
  it('is the type the strategy consumes', () => {
    const s: WaterlineSampling = waterlineSamplingFor(0.1);
    expect(s.minSampling).toBeLessThanOrEqual(s.sampling);
  });
});
