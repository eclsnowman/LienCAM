// WO-1340: a contained waterline stops its cutter centre at the stock edge.
// On the analytic contour below the true cutter-centre path reaches one tool
// radius beyond that edge. The legacy clip therefore leaves a 3 mm band; the
// shared stock-edge overrun reduces it to the deliberate 0.01 mm tangency
// margin while retaining every strictly interior cut point byte-for-byte.

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { bossInOpenStock } from '../../cam3d/fixtures';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import type { CutterSpec, PartMesh } from '../../cam3d/kernel/types';
import type { Ring } from '../../cam3d/geom2d';
import type { WaterlineSlicer } from '../../cam3d/kernel/oclWaterline';
import type { Tool, ToolpathMove } from '../../types';
import {
  computeWaterline3dMoves,
  DEFAULT_WATERLINE_PARAMS,
  readWaterlineParams,
  type WaterlineParams,
} from '../../cam3d/integration/waterline3dOperation';
import { computeSteepShallow3dMoves } from '../../cam3d/integration/steepShallow3dOperation';
import { STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM } from '../../cam3d/integration/parallel3dOperation';

const PART = bossInOpenStock({ x: 100, y: 100 }, { x: 80, y: 80, z: 14 });
const RADIUS = 3;
const STOCK_EDGE_X = 10;
const TRUE_CENTRE_X = STOCK_EDGE_X - RADIUS;
const STOCK: readonly Ring[] = [new Float64Array([
  STOCK_EDGE_X, 0, 50, 0, 50, 100, STOCK_EDGE_X, 100,
])];
const TOOL = {
  id: 'wo1340-flat6', name: 'WO-1340 flat 6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 12000, feedRate: 900, plungeRate: 300, depthOfCut: 2, stepover: 1 } },
} as unknown as Tool;
const HEIGHTS = { clearanceZ: 30, retractZ: 25, feedZ: 19, topZ: 14, bottomZ: 0 };
const PARAMS: WaterlineParams = {
  ...DEFAULT_WATERLINE_PARAMS,
  stepdown: 4,
  flatAreaDetection: false,
  useStockBoundary: true,
};

/** A real waterline shape crossing the stock edge, offset from the wall by R. */
function crossingSlicer(): WaterlineSlicer {
  return {
    name: 'wo1340-analytic-crossing',
    async slice(_mesh: PartMesh, _cutter: CutterSpec, z: number): Promise<Ring[]> {
      if (z > 14 || z < 0) return [];
      return [new Float64Array([7, 7, 93, 7, 93, 93, 7, 93])];
    },
  };
}

function makeClient(): Cam3dClient {
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest); },
    terminate(): void {},
  };
  const dispatcher = new Cam3dDispatcher(
    new BvhKernel(),
    (msg: Cam3dResponse) => fakeWorker.onmessage?.({ data: msg } as MessageEvent),
    { slicer: crossingSlicer() },
  );
  return new Cam3dClient(fakeWorker);
}

async function compute(stockEdgeOvershoot: number | undefined): Promise<ToolpathMove[]> {
  const params = { ...PARAMS, stockEdgeOvershoot };
  return (await computeWaterline3dMoves({
    partMesh: PART,
    tool: TOOL,
    params,
    resolvedHeights: HEIGHTS,
    boundary: STOCK,
    boundaryKind: 'stock',
    client: makeClient(),
  })).moves;
}

function cutMoves(moves: readonly ToolpathMove[]): ToolpathMove[] {
  return moves.filter((move) => move.role === 'cut');
}

function interiorSignature(moves: readonly ToolpathMove[]): string {
  return JSON.stringify(cutMoves(moves).filter((move) =>
    move.x > STOCK_EDGE_X && move.x < 50 && move.y > 0 && move.y < 100));
}

describe('WO-1340 waterline stock-edge finish', () => {
  it('measures the legacy fin and writes the desk evidence', async () => {
    const before = await compute(0);
    const after = await compute(undefined);
    const beforeMinX = Math.min(...cutMoves(before).map((move) => move.x));
    const afterMinX = Math.min(...cutMoves(after).map((move) => move.x));
    const beforeUncutMm = beforeMinX - TRUE_CENTRE_X;
    const afterUncutMm = afterMinX - TRUE_CENTRE_X;

    expect(beforeUncutMm).toBeCloseTo(RADIUS, 9);
    expect(afterUncutMm).toBeCloseTo(STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM, 9);
    expect(afterUncutMm).toBeLessThanOrEqual(STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM + 1e-9);

    const evidence = {
      wo: 'WO-1340',
      conclusion: 'fin',
      units: 'mm',
      cutterRadiusMm: RADIUS,
      stockEdgeX: STOCK_EDGE_X,
      requiredCutterCentreX: TRUE_CENTRE_X,
      before: { stockEdgeOvershoot: 0, lastPassX: beforeMinX, uncutOutboardMm: beforeUncutMm },
      after: { stockEdgeOvershoot: 'auto', lastPassX: afterMinX, uncutOutboardMm: afterUncutMm },
      interpretation: 'The hard containment leaves one tool radius. Auto overrun leaves only the 0.01 mm tangency margin.',
    };
    const here = dirname(fileURLToPath(import.meta.url));
    const output = resolve(here, '../evidence/WO-1340/measured.json');
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, `${JSON.stringify(evidence, null, 2)}\n`);
  });

  it('keeps every strictly in-containment cut byte-identical and only adds exterior cuts', async () => {
    const before = await compute(0);
    const after = await compute(undefined);
    expect(interiorSignature(after)).toBe(interiorSignature(before));
    expect(cutMoves(before).every((move) => move.x >= STOCK_EDGE_X - 1e-9)).toBe(true);
    expect(cutMoves(after).some((move) => move.x < STOCK_EDGE_X - 1e-9)).toBe(true);
    expect(cutMoves(after).filter((move) => move.x < STOCK_EDGE_X).every((move) => move.z >= 0)).toBe(true);
    const exteriorPlunges = after.filter((move) => move.role === 'plunge' && move.x < STOCK_EDGE_X);
    expect(exteriorPlunges.length).toBeGreaterThan(0);
    expect(exteriorPlunges.every((move) => move.z >= 0)).toBe(true);
    expect(exteriorPlunges.some((move) => move.z === -1)).toBe(false);
  });

  it('does not invent an overrun without containment, and obeys the caller vouch for a selection boundary', async () => {
    const openParams = { ...PARAMS, useStockBoundary: false };
    const open = async (stockEdgeOvershoot: number | undefined, faceScope?: readonly number[]) =>
      (await computeWaterline3dMoves({
        partMesh: PART, tool: TOOL, params: { ...openParams, stockEdgeOvershoot },
        resolvedHeights: HEIGHTS, ...(faceScope ? { faceScope } : {}), client: makeClient(),
      })).moves;
    expect(JSON.stringify(await open(undefined))).toBe(JSON.stringify(await open(0)));
    const selection = async (stockEdgeOvershoot: number | undefined) =>
      (await computeWaterline3dMoves({
        partMesh: PART, tool: TOOL, params: { ...PARAMS, stockEdgeOvershoot },
        resolvedHeights: HEIGHTS, boundary: STOCK, boundaryKind: 'selection', client: makeClient(),
      })).moves;
    expect(JSON.stringify(await selection(undefined))).toBe(JSON.stringify(await selection(0)));
    expect(cutMoves(await selection(undefined)).every((move) => move.x >= STOCK_EDGE_X - 1e-9)).toBe(true);
  });

  it('keeps a composed steep/shallow waterline inside its consumed face-selection boundary', async () => {
    const result = await computeSteepShallow3dMoves({
      partMesh: PART,
      tool: TOOL,
      params: {
        thresholdDeg: 45,
        stepdown: 4,
        stepover: 2,
        angleDeg: 0,
        tolerance: PARAMS.tolerance,
        stockToLeave: 0,
        useStockBoundary: true,
      },
      resolvedHeights: HEIGHTS,
      boundary: STOCK,
      // The composer uses this exact vouch after consuming a face scope into
      // an inset selection region. The checkbox remains on because the
      // selection was intersected with stock before it reached either half.
      boundaryKind: 'selection',
      client: makeClient(),
    });

    expect(cutMoves(result.moves).length).toBeGreaterThan(0);
    expect(cutMoves(result.moves).every((move) => move.x >= STOCK_EDGE_X - 1e-9)).toBe(true);
  });

  it('reads absent/invalid as auto and keeps zero or a non-negative setting', () => {
    expect(readWaterlineParams({}).stockEdgeOvershoot).toBeUndefined();
    expect(readWaterlineParams({ stockEdgeOvershoot: -1 }).stockEdgeOvershoot).toBeUndefined();
    expect(readWaterlineParams({ stockEdgeOvershoot: 'x' }).stockEdgeOvershoot).toBeUndefined();
    expect(readWaterlineParams({ stockEdgeOvershoot: 0 }).stockEdgeOvershoot).toBe(0);
    expect(readWaterlineParams({ stockEdgeOvershoot: 1.25 }).stockEdgeOvershoot).toBe(1.25);
  });
});
