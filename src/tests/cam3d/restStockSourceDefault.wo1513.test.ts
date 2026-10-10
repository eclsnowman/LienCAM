import { describe, expect, it } from 'vitest';

import { restStepFixture } from './restStepFixture';
import {
  computeRest3dMoves,
  readRest3dParams,
  readRestMachiningSettings,
} from '../../cam3d/integration/rest3dOperation';
import { stockBoundsFromMesh } from '../../cam3d/integration/adaptive3dOperation';
import type { Cam3dClient } from '../../cam3d/worker/client';
import type { Tool } from '../../types';

const HEIGHTS = { clearanceZ: 20, retractZ: 15, feedZ: 14, topZ: 12, stockTopZ: 12, bottomZ: 4 };

function tool(id: string, diameter: number): Tool {
  return {
    id, name: `${diameter} mm flat`, type: 'flat_end_mill', diameter,
    fluteLength: 12, shankDiameter: diameter, overallLength: 45, numberOfFlutes: 2,
    material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 12_000, feedRate: 600, plungeRate: 180, depthOfCut: 4, stepover: 0.8 } },
  };
}

describe('WO-1513 rest machining default stockSource', () => {
  it('readRestMachiningSettings and readRest3dParams agree on a missing/unrecognized stockSource', () => {
    const cases: Array<Record<string, unknown>> = [
      {},
      { stockSource: 'previous_operations' },
      { stockSource: 'previous_tool' },
      { stockSource: 'unrecognized-value' },
    ];
    for (const params of cases) {
      expect(readRest3dParams(params).stockSource).toBe(readRestMachiningSettings(params).stockSource);
    }
    expect(readRest3dParams({}).stockSource).toBe('previous_operations');
    expect(readRestMachiningSettings({}).stockSource).toBe('previous_operations');
  });

  it('a freshly-enabled rest toggle (no explicit stockSource) computes against preceding operations, not the previous-tool approximation', async () => {
    const calls: string[] = [];
    const client = {
      async generateAdaptiveRough() {
        calls.push('previousToolApproximation');
        throw new Error('must not take the previous_tool reference-rough path');
      },
      async stockCreate() { calls.push('create'); return { stock: 1, nx: 10, ny: 10, cell: 0.25, warnings: [] }; },
      async stockRemoveSweep(_stock: number, _cutter: unknown, sweeps: unknown[]) {
        calls.push(`sweep:${sweeps.length}`);
        return { removedVolumeMm3: 1, columnsChanged: 1 };
      },
      async stockToMesh() {
        calls.push('mesh');
        return { positions: new Float32Array(9), indices: new Uint32Array(3), vertexCount: 3, triangleCount: 1 };
      },
      async generateRestFinish() {
        calls.push('rest');
        return { moves: [
          { t: 'rapid', x: 0, y: 0, z: 15, role: 'rapid' },
          { t: 'feed', x: 1, y: 0, z: 4, role: 'cut' },
        ], meta: { strategyId: 'rest_finish_previous_operations', cutterId: 'flat:2' } };
      },
      async stockDispose(stock: number) { calls.push(`dispose:${stock}`); },
    } as unknown as Cam3dClient;

    // Exactly what Properties leaves behind when "Rest machining" is checked and no
    // source is chosen: no stockSource key persisted at all.
    const params = readRest3dParams({ referenceToolDiameter: 8, tolerance: 0.25 });
    expect(params.stockSource).toBe('previous_operations');

    const result = await computeRest3dMoves({
      partMesh: restStepFixture(), tool: tool('small', 2),
      stockBounds: stockBoundsFromMesh(restStepFixture()),
      params, resolvedHeights: HEIGHTS, client,
      precedingOperations: [{
        id: 'big', name: 'Big rough', enabled: true, status: 'ready', tool: tool('big', 8),
        toolpathMoves: [
          { type: 'rapid', x: 1, y: 0, z: 4, role: 'rapid' },
          { type: 'arc_ccw', x: 0, y: 1, z: 4, cx: 0, cy: 0, role: 'cut' },
        ],
      }],
    });

    expect(calls).not.toContain('previousToolApproximation');
    expect(calls).toContain('sweep:3');
    expect(result.moves).toHaveLength(2);
  });
});
