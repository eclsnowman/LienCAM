import { describe, expect, it } from 'vitest';
import type { GeometryKernel, MeshHandle, CutterHandle, PartMesh } from '../../cam3d/kernel/types';
import type { Tool } from '../../types';
import type { Cam3dClient, ParallelFinishClientInput } from '../../cam3d/worker/client';
import {
  clipParallelPassesAtMinZ,
  offsetDropSamplesAlongNormals,
  parallelFinish,
} from '../../cam3d/strategies/parallel';
import {
  computeParallel3dMoves,
  DEFAULT_PARALLEL3D_PARAMS,
  readParallel3dParams,
} from '../../cam3d/integration/parallel3dOperation';

function planeKernel(zAt: (x: number, y: number) => number): GeometryKernel {
  return {
    makeCutter: () => 1 as CutterHandle,
    releaseCutter: () => {},
    dropPoints: async (_mesh: MeshHandle, _cutter: CutterHandle, xy: Float64Array) => {
      const z = new Float64Array(xy.length / 2);
      for (let i = 0; i < z.length; i++) z[i] = zAt(xy[2 * i], xy[2 * i + 1]);
      return z;
    },
  } as unknown as GeometryKernel;
}

const BASE_INPUT = {
  mesh: 1 as MeshHandle,
  cutter: { kind: 'ball' as const, diameter: 2 },
  stepover: 1,
  angleDeg: 0,
  tolerance: 0.1,
  xyBounds: { minX: 0, minY: 0, maxX: 2, maxY: 2 },
  heights: { clearanceZ: 20, retractZ: 15, feedZ: 15 },
  zSeed: -10,
};

describe('parallel finish surface-normal allowance', () => {
  it('moves samples in XYZ along the normalized two-axis surface normal', () => {
    const xy = new Float64Array([10, 20]);
    const centerZ = new Float64Array([30]);
    // z = 2x + y, sampled [x-h, x+h, y-h, y+h] with h=1.
    const neighborZ = new Float64Array([28, 32, 29, 31]);
    const allowance = 3;
    const offset = offsetDropSamplesAlongNormals(xy, centerZ, neighborZ, 1, allowance);
    const inv = 1 / Math.sqrt(6);

    expect(offset[0]).toBeCloseTo(10 - 6 * inv, 12);
    expect(offset[1]).toBeCloseTo(20 - 3 * inv, 12);
    expect(offset[2]).toBeCloseTo(30 + 3 * inv, 12);
    expect(Math.hypot(offset[0] - 10, offset[1] - 20, offset[2] - 30))
      .toBeCloseTo(allowance, 12);
  });

  it('keeps the legacy strategy output byte-identical at zero allowance', async () => {
    const kernel = planeKernel((x, y) => 4 + 0.25 * x + 0.5 * y);
    const legacy = await parallelFinish(kernel, BASE_INPUT);
    const explicitZero = await parallelFinish(kernel, { ...BASE_INPUT, surfaceStockToLeave: 0 });
    expect(JSON.stringify(explicitZero)).toBe(JSON.stringify(legacy));
  });

  it('applies the normal offset in the real strategy and clips generated cuts by depth', async () => {
    const kernel = planeKernel((x, y) => 4 + x + 2 * y);
    const legacy = await parallelFinish(kernel, BASE_INPUT);
    const offset = await parallelFinish(kernel, { ...BASE_INPUT, surfaceStockToLeave: 1 });
    const legacyCut = legacy.moves.find((move) => move.role === 'cut');
    const offsetCut = offset.moves.find((move) => move.role === 'cut');
    expect(legacyCut).toBeDefined();
    expect(offsetCut).toBeDefined();
    expect(offsetCut?.x).not.toBeCloseTo(legacyCut?.x ?? 0, 8);
    expect(offsetCut?.y).not.toBeCloseTo(legacyCut?.y ?? 0, 8);
    expect(offsetCut?.z).toBeGreaterThan(legacyCut?.z ?? Infinity);

    const full = await parallelFinish(planeKernel((_x, y) => y), BASE_INPUT);
    const limited = await parallelFinish(planeKernel((_x, y) => y), {
      ...BASE_INPUT,
      minFinishZ: 1,
    });
    const fullCuts = full.moves.filter((move) => move.role === 'cut');
    const limitedCuts = limited.moves.filter((move) => move.role === 'cut');
    expect(limitedCuts.length).toBeLessThan(fullCuts.length);
    expect(limitedCuts.every((move) => move.z >= 1)).toBe(true);
  });

  it('refuses invalid allowance and a depth limit that removes every pass', async () => {
    const kernel = planeKernel(() => 5);
    await expect(parallelFinish(kernel, { ...BASE_INPUT, surfaceStockToLeave: -0.1 }))
      .rejects.toMatchObject({ name: 'ParallelFinishError' });
    await expect(parallelFinish(kernel, { ...BASE_INPUT, minFinishZ: 6 }))
      .rejects.toThrow(/finish depth limit.*removed every surface pass/i);
  });
});

describe('parallel finish depth clipping', () => {
  it('splits a pass at both crossings and inserts exact limit points', () => {
    const pass = new Float64Array([
      0, 0, 2,
      1, 0, 0,
      2, 0, 2,
      3, 0, 0,
      4, 0, 2,
    ]);
    const clipped = clipParallelPassesAtMinZ([pass], 1);

    expect(clipped).toHaveLength(3);
    expect([...clipped[0]]).toEqual([0, 0, 2, 0.5, 0, 1]);
    expect([...clipped[1]]).toEqual([1.5, 0, 1, 2, 0, 2, 2.5, 0, 1]);
    expect([...clipped[2]]).toEqual([3.5, 0, 1, 4, 0, 2]);
    for (const segment of clipped) {
      for (let i = 2; i < segment.length; i += 3) expect(segment[i]).toBeGreaterThanOrEqual(1);
    }
  });
});

describe('parallel finish parameter and adapter wiring', () => {
  it('defaults old projects and resolves finish depth below model top', async () => {
    expect(DEFAULT_PARALLEL3D_PARAMS.surfaceStockToLeave).toBe(0);
    expect(DEFAULT_PARALLEL3D_PARAMS.finishDepth).toBeUndefined();
    expect(readParallel3dParams({})).toMatchObject({
      surfaceStockToLeave: 0,
      finishDepth: undefined,
    });

    let captured: ParallelFinishClientInput | undefined;
    const client = {
      generateParallelFinish: async (input: ParallelFinishClientInput) => {
        captured = input;
        return {
          moves: [{ t: 'feed' as const, x: 0, y: 0, z: 10, role: 'cut' as const }],
          meta: { strategyId: 'parallel_finish', cutterId: 'ball-d2' },
        };
      },
    } as unknown as Cam3dClient;
    const mesh: PartMesh = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      indices: new Uint32Array([0, 1, 2]),
      bounds: { min: [0, 0, 0], max: [1, 1, 10] },
      source: 'fixture',
    };
    const tool = {
      id: 'tool',
      name: 'Ball 2',
      type: 'ball_end_mill',
      diameter: 2,
      fluteLength: 10,
      shankDiameter: 2,
      overallLength: 30,
      numberOfFlutes: 2,
      material: 'carbide',
      coating: 'none',
      notes: '',
      feedsAndSpeeds: {},
    } as Tool;

    await computeParallel3dMoves({
      partMesh: mesh,
      tool,
      params: {
        ...DEFAULT_PARALLEL3D_PARAMS,
        surfaceStockToLeave: 0.4,
        finishDepth: 3,
      },
      resolvedHeights: {
        clearanceZ: 20,
        retractZ: 15,
        feedZ: 15,
        topZ: 10,
        bottomZ: 0,
      },
      client,
    });

    expect(captured).toMatchObject({
      surfaceStockToLeave: 0.4,
      minFinishZ: 7,
    });
  });
});
