import { beforeAll, describe, expect, it } from 'vitest';

import { ensureGeom2dReady } from '../../cam3d/geom2d';
import { bossInOpenStock } from '../../cam3d/fixtures';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import {
  ExactAdaptiveLevelPlanCache,
  type AdaptiveLevelPlanRequest,
} from '../../cam3d/rough/adaptivePlanCache';
import { emitLevelPasses } from '../../cam3d/rough/emit';
import { ensureEngineClipperReady, type FeatureResult } from '../../cam3d/rough/engineEntry';
import { orderAdaptiveComponents } from '../../cam3d/rough/orderComponents';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';

function request(overrides: Partial<AdaptiveLevelPlanRequest['params']> = {}): AdaptiveLevelPlanRequest {
  return {
    feature: {
      boundary: [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      holes: [[
        { x: 4, y: 4 },
        { x: 4, y: 6 },
        { x: 6, y: 6 },
        { x: 6, y: 4 },
      ]],
    },
    params: {
      toolRadius: 1,
      stepOver: 0.4,
      tolerance: 0.05,
      helixDiameter: 1.5,
      stockToLeave: 0,
      clearedSeed: [[
        { x: -2, y: -2 },
        { x: 12, y: -2 },
        { x: 12, y: 12 },
        { x: -2, y: 12 },
      ]],
      skipOuterBoundaryCleanup: true,
      ...overrides,
    },
  };
}

function result(): FeatureResult {
  return {
    startPoint: { x: 2, y: 2 },
    entries: [{ point: { x: 2, y: 2 }, radius: 0, mode: 'plunge' }],
    passes: [
      { type: 'entry', point: { x: 2, y: 2 }, radius: 0, mode: 'plunge' },
      { type: 'cut', points: [{ x: 2, y: 2 }, { x: 8, y: 2 }, { x: 8, y: 8 }] },
    ],
    cleared: [],
    cutRegion: [],
    residual: [],
    stats: {
      passes: 2,
      points: 3,
      cacheHits: 0,
      cacheMisses: 0,
      residualArea: 0,
      residualMaxInscribedR: 0,
    },
  };
}

describe('ExactAdaptiveLevelPlanCache', () => {
  it('reuses only exact geometry, seed, and planner flags', () => {
    const cache = new ExactAdaptiveLevelPlanCache();
    let calls = 0;
    const plan = (item: AdaptiveLevelPlanRequest) => cache.getOrPlan([item], () => {
      calls++;
      return [result()];
    });

    expect(plan(request()).reused).toBe(false);
    expect(plan(structuredClone(request())).reused).toBe(true);

    const boundaryChanged = request();
    boundaryChanged.feature.boundary[1].x = 10 + Number.EPSILON * 8;
    expect(plan(boundaryChanged).reused).toBe(false);

    const holeChanged = request();
    holeChanged.feature.holes![0][0].y = 4 + Number.EPSILON * 4;
    expect(plan(holeChanged).reused).toBe(false);

    const seedChanged = request();
    seedChanged.params.clearedSeed![0][0].x = -2 - Number.EPSILON * 2;
    expect(plan(seedChanged).reused).toBe(false);

    expect(plan(request({ skipOuterBoundaryCleanup: false })).reused).toBe(false);
    expect(calls).toBe(5);
    expect(cache.hits).toBe(1);
    expect(cache.misses).toBe(5);
    expect(cache.uniquePlans).toBe(5);
  });

  it('keeps cached planner results immutable through ordering and emission', () => {
    const cache = new ExactAdaptiveLevelPlanCache();
    const cached = cache.getOrPlan([request()], () => [result()]).results[0];
    const before = JSON.stringify(cached);

    const ordered = orderAdaptiveComponents(
      [{ originalIndex: 0, passes: cached.passes }],
      { x: Number.NaN, y: Number.NaN },
    );
    const context = {
      cursor: { x: Number.NaN, y: Number.NaN, z: 10 },
      helixAngleDeg: 10,
      toolRadius: 1,
      stockProven: false,
    };
    emitLevelPasses(ordered[0].passes, 4, {
      clearanceZ: 10,
      retractZ: 8,
      feedZ: 6,
    }, context);

    expect(JSON.stringify(cached)).toBe(before);
    expect(Object.isFrozen(cached)).toBe(true);
    expect(Object.isFrozen(cached.passes)).toBe(true);
    expect(Object.isFrozen(cached.passes[1])).toBe(true);
  });
});

describe('Adaptive 3D exact level-plan cache integration', () => {
  beforeAll(async () => {
    await ensureGeom2dReady();
    await ensureEngineClipperReady();
  });

  it('keeps cached and uncached multi-level toolpaths byte-identical', { timeout: 120_000 }, async () => {
    const stockBounds = { minX: 0, minY: 0, minZ: 0, maxX: 24, maxY: 24, maxZ: 6 };
    const mesh = bossInOpenStock(
      { x: 24, y: 24 },
      { x: 12, y: 12, z: 6 },
    );
    const kernel = new BvhKernel();
    const handle = kernel.uploadMesh(mesh);
    const input: AdaptiveRoughInput = {
      mesh: handle,
      cutter: { kind: 'flat', diameter: 2 },
      stockBounds,
      cellSize: 0.5,
      maxStepdown: 2,
      stepover: 0.4,
      millingDirection: 'climb',
      tolerance: 0.1,
      helixDiameter: 1.5,
      floorZ: 0,
      radialStockToLeave: 0,
      axialStockToLeave: 0,
      reachStockEdgeBy: 1,
      sideEntry: true,
      heights: { clearanceZ: 10, retractZ: 8, feedZ: 6.5 },
      materialTopZ: 6,
      stockBoundsAreRealStock: true,
    };

    try {
      const cached = await adaptiveRough(kernel, input);
      const uncached = await adaptiveRough(kernel, input, {
        disableExactPlanCache: true,
      } as never);

      expect(JSON.stringify(cached.moves)).toBe(JSON.stringify(uncached.moves));
      expect(cached.meta.params?.plannerCacheHits).toBe(2);
      expect(cached.meta.params?.plannerCacheMisses).toBe(1);
      expect(cached.meta.params?.plannerUniquePlans).toBe(1);

      const cachedParams = { ...cached.meta.params };
      const uncachedParams = { ...uncached.meta.params };
      delete cachedParams.plannerCacheHits;
      delete cachedParams.plannerCacheMisses;
      delete cachedParams.plannerUniquePlans;
      delete uncachedParams.plannerCacheHits;
      delete uncachedParams.plannerCacheMisses;
      delete uncachedParams.plannerUniquePlans;
      expect(cachedParams).toEqual(uncachedParams);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});
