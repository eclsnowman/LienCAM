import { describe, expect, it } from 'vitest';

import { restStepFixture } from './restStepFixture';
import { computeRest3dMoves, DEFAULT_REST3D_PARAMS, readRest3dParams } from '../../cam3d/integration/rest3dOperation';
import { stockBoundsFromMesh } from '../../cam3d/integration/adaptive3dOperation';
import { irToToolpathMoves } from '../../cam3d/ir/toToolpathMoves';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { ZDexelField } from '../../cam3d/stock';
import { Cam3dClient, type AdaptiveRoughClientInput, type RestFinishClientInput, type WorkerLike } from '../../cam3d/worker/client';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling';
import { effectiveMoveRole, isStockCuttingRole } from '../../lib/cam/stockCuttingRoles';
import type { Tool, ToolpathMove } from '../../types';

const HEIGHTS = { clearanceZ: 20, retractZ: 15, feedZ: 14, topZ: 12, stockTopZ: 12, bottomZ: 4 };
const RATES = {
  feedRate: 600, plungeRate: 180, rampRate: 240, leadInRate: 400,
  leadOutRate: 400, fastTraverseRate: 1200, finishRate: 500,
};

function tool(id: string, diameter: number): Tool {
  return {
    id, name: `${diameter} mm flat`, type: 'flat_end_mill', diameter,
    fluteLength: 12, shankDiameter: diameter, overallLength: 45, numberOfFlutes: 2,
    material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 12_000, feedRate: 600, plungeRate: 180, depthOfCut: 4, stepover: 0.8 } },
  };
}

function makeHarness(): { client: Cam3dClient; dispatcher: Cam3dDispatcher } {
  const kernel = new BvhKernel();
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {
      // The in-process channel owns no browser worker.
    },
  };
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: message } as MessageEvent);
  });
  return { client: new Cam3dClient(fakeWorker), dispatcher };
}

function roughInput(diameter: number): AdaptiveRoughClientInput {
  const partMesh = restStepFixture();
  return {
    partMesh,
    cutter: { kind: 'flat', diameter },
    stockBounds: stockBoundsFromMesh(partMesh),
    cellSize: 0.25,
    maxStepdown: 4,
    stepover: 0.4,
    millingDirection: 'climb',
    spindleRotation: 'cw',
    wallLeadInRadius: 0,
    wallLeadOutRadius: 0,
    loopbackFilletPct: 25,
    integralWallFollow: true,
    integralWallFollowLengthFactor: 2,
    tolerance: 0.25,
    helixDiameter: Math.min(diameter, 2) * 0.6,
    helixAngleDeg: 10,
    heights: { clearanceZ: HEIGHTS.clearanceZ, retractZ: HEIGHTS.retractZ, feedZ: HEIGHTS.feedZ },
    materialTopZ: HEIGHTS.stockTopZ,
    floorZ: HEIGHTS.bottomZ,
    stockBoundsAreRealStock: true,
  };
}

function metrics(moves: readonly ToolpathMove[]): {
  cutLengthMm: number; cutTimeMs: number; liftCount: number; traverseCount: number;
} {
  let cutLengthMm = 0;
  let cutTimeMs = 0;
  let liftCount = 0;
  let traverseCount = 0;
  for (let index = 1; index < moves.length; index++) {
    const from = moves[index - 1];
    const move = moves[index];
    const length = Math.hypot(move.x - from.x, move.y - from.y, move.z - from.z);
    const role = effectiveMoveRole(move);
    if (isStockCuttingRole(role)) {
      cutLengthMm += length;
      cutTimeMs += length / (move.feed ?? RATES.feedRate) * 60_000;
    } else {
      if (move.z > from.z + 1e-9) liftCount++;
      if (Math.hypot(move.x - from.x, move.y - from.y) > 1e-9) traverseCount++;
    }
  }
  return { cutLengthMm, cutTimeMs, liftCount, traverseCount };
}

function topWithinReach(field: ZDexelField, x: number, y: number, radius: number): number {
  let highest = Number.NEGATIVE_INFINITY;
  const reach = radius + field.cell;
  const firstCenterX = field.originX + field.cell / 2;
  const firstCenterY = field.originY + field.cell / 2;
  const minI = Math.max(0, Math.ceil((x - reach - firstCenterX) / field.cell));
  const maxI = Math.min(field.nx - 1, Math.floor((x + reach - firstCenterX) / field.cell));
  const minJ = Math.max(0, Math.ceil((y - reach - firstCenterY) / field.cell));
  const maxJ = Math.min(field.ny - 1, Math.floor((y + reach - firstCenterY) / field.cell));
  for (let j = minJ; j <= maxJ; j++) for (let i = minI; i <= maxI; i++) {
    const cx = field.originX + (i + 0.5) * field.cell;
    const cy = field.originY + (j + 0.5) * field.cell;
    if (Math.hypot(cx - x, cy - y) <= reach) {
      highest = Math.max(highest, field.top[field.colIndex(i, j)]);
    }
  }
  return highest;
}

function alreadyClearCutLengths(
  moves: readonly ToolpathMove[],
  field: ZDexelField,
  cutterRadius: number,
  materialTopZ: number,
  clearanceTolerance: number,
): { alreadyClearCutLengthMm: number; totalCutLengthMm: number } {
  const sampleStep = field.cell / 2;
  const sampledMoves = sampleArcMovesForLinearConsumers(moves, { maxChordMm: sampleStep });
  let alreadyClearCutLengthMm = 0;
  let totalCutLengthMm = 0;

  for (let index = 1; index < sampledMoves.length; index++) {
    const from = sampledMoves[index - 1];
    const move = sampledMoves[index];
    if (!isStockCuttingRole(effectiveMoveRole(move))) continue;

    const dx = move.x - from.x;
    const dy = move.y - from.y;
    const dz = move.z - from.z;
    const segmentLength = Math.hypot(dx, dy, dz);
    if (segmentLength <= 1e-12) continue;

    const sampleCount = Math.max(1, Math.ceil(segmentLength / sampleStep));
    const sampleLength = segmentLength / sampleCount;
    for (let sample = 0; sample < sampleCount; sample++) {
      const t = (sample + 0.5) / sampleCount;
      const x = from.x + dx * t;
      const y = from.y + dy * t;
      const z = from.z + dz * t;
      // Preserve the original evidence boundary: path portions at or above the
      // stock top cannot be cutting stock and make no already-cleared claim.
      if (z >= materialTopZ - 1e-6) continue;

      totalCutLengthMm += sampleLength;
      if (topWithinReach(field, x, y, cutterRadius) <= z + clearanceTolerance) {
        alreadyClearCutLengthMm += sampleLength;
      }
    }
  }

  return { alreadyClearCutLengthMm, totalCutLengthMm };
}

describe('WO-1209 rest stock from preceding operations', () => {
  it('selects both stock sources, defaulting missing/unrecognized to previous_operations', () => {
    expect(readRest3dParams({}).stockSource).toBe('previous_operations');
    expect(readRest3dParams({ stockSource: 'previous_operations' }).stockSource).toBe('previous_operations');
    expect(readRest3dParams({ stockSource: 'previous_tool' }).stockSource).toBe('previous_tool');
    expect(readRest3dParams({ stockSource: 'unknown' }).stockSource).toBe('previous_operations');
  });

  it('keeps explicit previous_tool output byte-identical to the legacy default', async () => {
    const run = async (stockSource: 'previous_operations' | 'previous_tool') => {
      let nextStock = 1;
      const client = {
        async generateAdaptiveRough() {
          return { ir: { moves: [
            { t: 'rapid', x: 5, y: 5, z: 12, role: 'rapid' },
            { t: 'feed', x: 15, y: 5, z: 8, role: 'cut' },
          ], meta: { strategyId: 'adaptive_rough', cutterId: 'flat:8' } } };
        },
        async stockCreate() { return { stock: nextStock++, nx: 10, ny: 10, cell: 0.25, warnings: [] }; },
        async stockRemoveSweep() { return { removedVolumeMm3: 1, columnsChanged: 1 }; },
        async stockToMesh() {
          return { positions: new Float32Array(9), indices: new Uint32Array(3), vertexCount: 3, triangleCount: 1 };
        },
        async generateRestFinish() {
          return { moves: [
            { t: 'rapid', x: 10, y: 12, z: 15, role: 'rapid' },
            { t: 'feed', x: 20, y: 12, z: 4, role: 'cut' },
          ], meta: { strategyId: 'rest_finish_reference_tool', cutterId: 'flat:2' } };
        },
        async stockDispose() {},
      } as unknown as Cam3dClient;
      return computeRest3dMoves({
        partMesh: restStepFixture(), tool: tool('small', 2),
        stockBounds: { minX: 0, minY: 0, minZ: 0, maxX: 70, maxY: 50, maxZ: 12 },
        params: { ...DEFAULT_REST3D_PARAMS, stockSource, referenceToolDiameter: 8, tolerance: 0.25 },
        resolvedHeights: HEIGHTS, client,
      });
    };

    const legacy = await run(DEFAULT_REST3D_PARAMS.stockSource);
    const explicit = await run('previous_tool');
    expect(JSON.stringify(explicit.moves)).toBe(JSON.stringify(legacy.moves));
  });

  it('skips suppressed predecessors and refuses an enabled uncomputed predecessor by name', async () => {
    let created = 0;
    const client = { async stockCreate() { created++; throw new Error('must not create'); } } as unknown as Cam3dClient;
    await expect(computeRest3dMoves({
      partMesh: restStepFixture(), tool: tool('small', 2),
      stockBounds: stockBoundsFromMesh(restStepFixture()),
      params: { ...DEFAULT_REST3D_PARAMS, stockSource: 'previous_operations', tolerance: 0.25 },
      resolvedHeights: HEIGHTS, client,
      precedingOperations: [
        { id: 'suppressed', name: 'Suppressed rough', enabled: false, status: 'pending', tool: undefined, toolpathMoves: undefined },
        { id: 'uncomputed', name: 'Big rough', enabled: true, status: 'pending', tool: tool('big', 8), toolpathMoves: undefined },
      ],
    })).rejects.toThrow('Big rough');
    expect(created).toBe(0);
  });

  it('disposes the replayed stock on both success and worker failure', async () => {
    const run = async (throwDuringRest: boolean) => {
      const calls: string[] = [];
      const client = {
        async stockCreate() { calls.push('create'); return { stock: 31, nx: 20, ny: 20, cell: 0.25, warnings: [] }; },
        async stockRemoveSweep(_stock: number, _cutter: unknown, sweeps: unknown[]) { calls.push(`sweep:${sweeps.length}`); return { removedVolumeMm3: 1, columnsChanged: 1 }; },
        async stockToMesh() { calls.push('mesh'); return { positions: new Float32Array(9), indices: new Uint32Array(3), vertexCount: 3, triangleCount: 1 }; },
        async generateRestFinish() {
          calls.push('rest');
          if (throwDuringRest) throw new Error('planned worker failure');
          return { moves: [
            { t: 'rapid', x: 0, y: 0, z: 15, role: 'rapid' },
            { t: 'feed', x: 1, y: 0, z: 4, role: 'cut' },
          ], meta: { strategyId: 'rest_finish_reference_tool', cutterId: 'flat:2' } };
        },
        async stockDispose(stock: number) { calls.push(`dispose:${stock}`); },
      } as unknown as Cam3dClient;
      const promise = computeRest3dMoves({
        partMesh: restStepFixture(), tool: tool('small', 2),
        stockBounds: stockBoundsFromMesh(restStepFixture()),
        params: { ...DEFAULT_REST3D_PARAMS, stockSource: 'previous_operations', tolerance: 0.25 },
        resolvedHeights: HEIGHTS, client,
        precedingOperations: [{
          id: 'big', name: 'Big rough', enabled: true, status: 'ready', tool: tool('big', 8),
          toolpathMoves: [
            { type: 'rapid', x: 1, y: 0, z: 4, role: 'rapid' },
            { type: 'arc_ccw', x: 0, y: 1, z: 4, cx: 0, cy: 0, role: 'cut' },
          ],
        }],
      });
      if (throwDuringRest) await expect(promise).rejects.toThrow('planned worker failure');
      else await expect(promise).resolves.toMatchObject({ moves: expect.any(Array) });
      expect(calls).toContain('sweep:3');
      expect(calls.at(-1)).toBe('dispose:31');
      expect(calls.filter(call => call === 'dispose:31')).toHaveLength(1);
    };
    await run(false);
    await run(true);
  });

  it('cuts only what the big operation left and reduces time, length, lifts, and traverses', { timeout: 600_000 }, async () => {
    const { client, dispatcher } = makeHarness();
    const bigTool = tool('big', 8);
    const smallTool = tool('small', 2);

    const first = await client.generateAdaptiveRough(roughInput(bigTool.diameter));
    expect(first.carvedStockHandle).toBeDefined();
    const firstMoves = irToToolpathMoves(first.ir, RATES);
    await client.stockDispose(first.carvedStockHandle!);
    expect(dispatcher.liveStockCount).toBe(0);

    let replayedStock: ZDexelField | undefined;
    let strategyId: string | undefined;
    const generateRest = client.generateRestFinish.bind(client);
    client.generateRestFinish = async (input: RestFinishClientInput, opts) => {
      replayedStock = dispatcher.peekStock(input.stock).clone();
      const ir = await generateRest(input, opts);
      strategyId = ir.meta.strategyId;
      return ir;
    };

    const restOn = await computeRest3dMoves({
      partMesh: restStepFixture(), tool: smallTool,
      stockBounds: stockBoundsFromMesh(restStepFixture()),
      feedrateOverride: undefined,
      params: { ...DEFAULT_REST3D_PARAMS, stockSource: 'previous_operations', tolerance: 0.25, stepdown: 4 },
      resolvedHeights: HEIGHTS, client,
      precedingOperations: [{
        id: 'big', name: 'Big rough', enabled: true, status: 'ready', tool: bigTool,
        toolpathMoves: firstMoves,
      }],
    });
    expect(dispatcher.liveStockCount).toBe(0);
    expect(replayedStock).toBeDefined();
    expect(strategyId).toBe('rest_finish_previous_operations');

    const control = await client.generateAdaptiveRough(roughInput(smallTool.diameter));
    const restOffMoves = irToToolpathMoves(control.ir, RATES);
    await client.stockDispose(control.carvedStockHandle!);
    expect(dispatcher.liveStockCount).toBe(0);

    const cutLengths = alreadyClearCutLengths(
      restOn.moves,
      replayedStock!,
      smallTool.diameter / 2,
      HEIGHTS.stockTopZ,
      0.25,
    );
    const alreadyClearCutLengthFraction =
      cutLengths.alreadyClearCutLengthMm / cutLengths.totalCutLengthMm;
    const on = metrics(restOn.moves);
    const off = metrics(restOffMoves);

    expect(cutLengths.totalCutLengthMm).toBeGreaterThan(0);
    expect(alreadyClearCutLengthFraction).toBeLessThan(0.15);
    expect(on.cutTimeMs).toBeLessThan(off.cutTimeMs);
    expect(on.cutLengthMm).toBeLessThan(off.cutLengthMm);
    expect(on.liftCount).toBeLessThan(off.liftCount);
    expect(on.traverseCount).toBeLessThan(off.traverseCount);
    console.log('[WO-1209]', JSON.stringify({
      stockCellSizeMm: replayedStock!.cell,
      alreadyClearCutLengthMm: cutLengths.alreadyClearCutLengthMm,
      measuredCutLengthMm: cutLengths.totalCutLengthMm,
      alreadyClearCutLengthFraction,
      restOn: on,
      restOff: off,
    }));
  });
});
