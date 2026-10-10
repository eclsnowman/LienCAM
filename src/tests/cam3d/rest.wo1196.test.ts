import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { restFinish } from '../../cam3d/strategies/rest';
import { replayMovesIntoStock } from '../../cam3d/rough/replayStock';
import type { ZDexelField } from '../../cam3d/stock';
import { REST_FIXTURE, restStepFixture } from './restStepFixture';
import { computeRest3dMoves, DEFAULT_REST3D_PARAMS } from '../../cam3d/integration/rest3dOperation';
import type { Cam3dClient } from '../../cam3d/worker/client';
import type { Tool } from '../../types';

function maximumDepth(field: ZDexelField, region: typeof REST_FIXTURE.regions[number]): number {
  let maximum = 0;
  for (let j = 0; j < field.ny; j++) for (let i = 0; i < field.nx; i++) {
    const x = field.originX + (i + 0.5) * field.cell;
    const y = field.originY + (j + 0.5) * field.cell;
    if (x > region.x0 + 1 && x < region.x1 - 1 && y > region.y0 + 1 && y < region.y1 - 1) {
      maximum = Math.max(maximum, field.top[field.colIndex(i, j)] - REST_FIXTURE.floorZ);
    }
  }
  return maximum;
}

function topWithinReach(field: ZDexelField, x: number, y: number, radius: number): number {
  let highest = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < field.ny; j++) for (let i = 0; i < field.nx; i++) {
    const cx = field.originX + (i + 0.5) * field.cell;
    const cy = field.originY + (j + 0.5) * field.cell;
    if (Math.hypot(cx - x, cy - y) <= radius + field.cell) {
      highest = Math.max(highest, field.top[field.colIndex(i, j)]);
    }
  }
  return highest;
}

describe('WO-1196 reference-tool rest machining', () => {
  it('owns the explicit reference-stock lifecycle through the application adapter', async () => {
    const calls: string[] = [];
    const client = {
      async generateAdaptiveRough() {
        calls.push('referenceRough');
        return {
          ir: { moves: [
            { t: 'rapid', x: 5, y: 5, z: 12, role: 'rapid' },
            { t: 'feed', x: 15, y: 5, z: 8, role: 'cut' },
          ], meta: { strategyId: 'adaptive_rough', cutterId: 'flat:8' } },
          carvedStockHandle: 17,
        };
      },
      async stockDispose(stock: number) { calls.push(`dispose:${stock}`); },
      async stockCreate() {
        calls.push('create');
        return { stock: 23, nx: 10, ny: 10, cell: 0.25, warnings: [] };
      },
      async stockRemoveSweep(stock: number, reference: { diameter: number }, sweeps: unknown[]) {
        calls.push(`sweep:${stock}:${reference.diameter}:${sweeps.length}`);
        return { removedVolumeMm3: 1, columnsChanged: 1 };
      },
      async stockToMesh(stock: number) {
        calls.push(`mesh:${stock}`);
        return { positions: new Float32Array(9), indices: new Uint32Array(3), vertexCount: 3, triangleCount: 1 };
      },
      async generateRestFinish(input: { stock: number; referenceToolDiameter: number }) {
        calls.push(`rest:${input.stock}:${input.referenceToolDiameter}`);
        return { moves: [
          { t: 'rapid', x: 10, y: 12, z: 15, role: 'rapid' },
          { t: 'feed', x: 20, y: 12, z: 4, role: 'cut' },
        ], meta: { strategyId: 'rest_finish_reference_tool', cutterId: 'flat:2' } };
      },
    } as unknown as Cam3dClient;
    const tool = {
      id: 'rest-tool', name: '2 mm flat', type: 'flat_end_mill', diameter: 2,
      fluteLength: 10, shankDiameter: 2, overallLength: 40, numberOfFlutes: 2,
      material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: {},
    } as Tool;

    const result = await computeRest3dMoves({
      partMesh: restStepFixture(), tool,
      stockBounds: { minX: 0, minY: 0, minZ: 0, maxX: 70, maxY: 50, maxZ: 12 },
      params: { ...DEFAULT_REST3D_PARAMS, referenceToolDiameter: 8, tolerance: 0.25 },
      resolvedHeights: { clearanceZ: 20, retractZ: 15, feedZ: 14, topZ: 12, stockTopZ: 12, bottomZ: 4 },
      client,
    });

    expect(calls).toEqual([
      'referenceRough', 'dispose:17', 'create', 'sweep:23:8:1', 'mesh:23', 'rest:23:8', 'dispose:23',
    ]);
    expect(result.moves).toHaveLength(2);
  });

  it('clears both disconnected unreachable slots without re-roughing clear ground', { timeout: 600_000 }, async () => {
    const kernel = new BvhKernel();
    const mesh = restStepFixture();
    const handle = kernel.uploadMesh(mesh);
    try {
      const result = await restFinish(kernel, {
        mesh: handle,
        cutter: { kind: 'flat', diameter: 2 },
        referenceToolDiameter: 8,
        referenceCornerRadius: 0,
        tolerance: 0.25,
        stockToLeave: 0.25,
        stepdown: 4,
        direction: 'climb',
        spindleRotation: 'cw',
        stockBounds: { minX: 0, minY: 0, minZ: 0, maxX: 70, maxY: 50, maxZ: 12 },
        cellSize: 0.25,
        heights: { clearanceZ: 20, retractZ: 15, feedZ: 14, materialTopZ: 12 },
        topZ: 12,
        bottomZ: 4,
      });
      const before = REST_FIXTURE.regions.map(region => maximumDepth(result.referenceStock, region));
      expect(before[0]).toBeGreaterThan(4);
      expect(before[1]).toBeGreaterThan(4);

      const afterStock = result.referenceStock.clone();
      replayMovesIntoStock(afterStock, { kind: 'flat', diameter: 2 }, result.ir.moves, null);
      const after = REST_FIXTURE.regions.map(region => maximumDepth(afterStock, region));
      expect(after[0]).toBeLessThanOrEqual(0.5);
      expect(after[1]).toBeLessThanOrEqual(0.5);

      const lateral = new Set(['cut', 'stepover', 'finish']);
      const cutting = result.ir.moves.filter(move => lateral.has(String(move.role)) && move.z < 12 - 1e-6);
      expect(cutting.length).toBeGreaterThan(0);
      const overClear = cutting.filter(move => topWithinReach(result.referenceStock, move.x, move.y, 1) <= move.z + 0.25);
      const alreadyClearFraction = overClear.length / cutting.length;
      expect(alreadyClearFraction).toBeLessThan(0.15);
      console.log('[WO-1196]', JSON.stringify({
        before: Object.fromEntries(REST_FIXTURE.regions.map((region, index) => [region.name, before[index]])),
        after: Object.fromEntries(REST_FIXTURE.regions.map((region, index) => [region.name, after[index]])),
        cuttingMoves: cutting.length,
        alreadyClearFraction,
      }));
    } finally {
      kernel.releaseMesh(handle);
    }
  });

  it('refuses an invalid reference tool in one sentence', async () => {
    const kernel = new BvhKernel();
    const mesh = restStepFixture();
    const handle = kernel.uploadMesh(mesh);
    try {
      await expect(restFinish(kernel, {
        mesh: handle, cutter: { kind: 'flat', diameter: 4 }, referenceToolDiameter: 4,
        referenceCornerRadius: 0, tolerance: 0.5, stockToLeave: 0, stepdown: 4,
        direction: 'climb', spindleRotation: 'cw', stockBounds: { minX: 0, minY: 0, minZ: 0, maxX: 70, maxY: 50, maxZ: 12 },
        cellSize: 0.5, heights: { clearanceZ: 20, retractZ: 15, feedZ: 14 }, topZ: 12, bottomZ: 4,
      })).rejects.toThrow('Reference tool diameter must be greater than this operation\'s cutter diameter.');
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});
