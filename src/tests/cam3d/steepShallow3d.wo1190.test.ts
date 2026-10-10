import { describe, expect, it } from 'vitest';
import { hemisphereOnSlab } from '../../cam3d/fixtures';
import { irFingerprint, type ToolpathIR } from '../../cam3d/ir/types';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { PartMesh } from '../../cam3d/kernel/types';
import {
  parallelFinish,
  splitParallelPassByMaxSlope,
  type ParallelFinishInput,
} from '../../cam3d/strategies/parallel';
import type { Cam3dClient, ParallelFinishClientInput } from '../../cam3d/worker/client';
import type { WaterlineClientInput } from '../../cam3d/worker/client';
import type { Tool, ToolpathMove } from '../../types';
import { defaultHeightIntent } from '../../lib/cam/heightIntent';
import {
  buildSteepShallow3dEvidenceContext,
  buildSteepShallow3dSmartIntent,
  resolveSteepShallow3dSmartHeights,
  steepShallow3dHeightDraftFromIntent,
} from '../../lib/cam/smartHeights';
import {
  computeSteepShallow3dMoves,
  DEFAULT_STEEP_SHALLOW3D_PARAMS,
  readSteepShallow3dParams,
  STEEP_SHALLOW_OVERLAP_DEG,
} from '../../cam3d/integration/steepShallow3dOperation';

const TOOL: Tool = {
  id: 'ball-4', name: '4 mm ball', type: 'ball_end_mill', diameter: 4,
  fluteLength: 12, shankDiameter: 4, overallLength: 40, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 12000, feedRate: 800, plungeRate: 250, depthOfCut: 1, stepover: 0.5 } },
} as unknown as Tool;

const PART: PartMesh = {
  positions: new Float32Array(),
  indices: new Uint32Array(),
  bounds: { min: [0, 0, 0], max: [10, 10, 4] },
  source: 'fixture',
};
const HEIGHTS = { clearanceZ: 10, retractZ: 8, feedZ: 6, topZ: 4, bottomZ: 0 };

function waterlineIr(): ToolpathIR {
  return {
    moves: [
      { t: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' },
      { t: 'rapid', x: 0, y: 0, z: 0, role: 'rapid' },
      { t: 'feed', x: 0, y: 1, z: 0, role: 'cut' },
      { t: 'feed', x: 0, y: 2, z: 0, role: 'cut' },
      { t: 'rapid', x: 0, y: 2, z: 10, role: 'rapid' },
    ],
    meta: { strategyId: 'waterline', cutterId: 'ball-d4' },
  };
}

function parallelIr(): ToolpathIR {
  return {
    moves: [
      { t: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' },
      { t: 'rapid', x: 0, y: 0, z: 0, role: 'rapid' },
      { t: 'feed', x: 1, y: 0, z: 0.2, role: 'cut' },
      { t: 'feed', x: 2, y: 0, z: 0.4, role: 'cut' },
      { t: 'rapid', x: 2, y: 0, z: 10, role: 'rapid' },
    ],
    meta: { strategyId: 'parallel_finish', cutterId: 'ball-d4' },
  };
}

function recordingClient(calls: Array<{ family: string; input: unknown }>): Cam3dClient {
  return {
    async generateWaterline(input: WaterlineClientInput): Promise<ToolpathIR> {
      calls.push({ family: 'waterline', input });
      return waterlineIr();
    },
    async generateParallelFinish(input: ParallelFinishClientInput): Promise<ToolpathIR> {
      calls.push({ family: 'parallel', input });
      return parallelIr();
    },
  } as unknown as Cam3dClient;
}

function distanceToSegment(point: [number, number, number], a: ToolpathMove, b: ToolpathMove): number {
  const ab = [b.x - a.x, b.y - a.y, b.z - a.z] as const;
  const ap = [point[0] - a.x, point[1] - a.y, point[2] - a.z] as const;
  const denom = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1,
    (ap[0] * ab[0] + ap[1] * ab[1] + ap[2] * ab[2]) / denom,
  ));
  return Math.hypot(
    point[0] - (a.x + t * ab[0]),
    point[1] - (a.y + t * ab[1]),
    point[2] - (a.z + t * ab[2]),
  );
}

describe('WO-1190 shallow slope filter', () => {
  it('splits at steep samples rather than bridging across the removed span', () => {
    const pass = new Float64Array([
      0, 0, 0, 1, 0, 0, 2, 0, 2, 3, 0, 2, 4, 0, 0, 5, 0, 0,
    ]);
    // Four derivative samples per point: x-, x+, y-, y+. The middle two
    // points have dz/dx=2 (63.4 deg); the outer pairs are horizontal.
    const neighbor = new Float64Array([
      0, 0, 0, 0, 0, 0, 0, 0,
      0, 4, 2, 2, 0, 4, 2, 2,
      0, 0, 0, 0, 0, 0, 0, 0,
    ]);
    const pieces = splitParallelPassByMaxSlope(pass, neighbor, 1, 30);
    expect(pieces.map(piece => Array.from(piece))).toEqual([
      [0, 0, 0, 1, 0, 0],
      [4, 0, 0, 5, 0, 0],
    ]);
  });

  it('keeps the stored legacy fixture byte-identical with maxSlopeDeg absent or zero', async () => {
    const kernel = new BvhKernel();
    const mesh = kernel.uploadMesh(hemisphereOnSlab(8, { x: 24, y: 24, t: 4 }));
    const input: ParallelFinishInput = {
      mesh, cutter: { kind: 'ball', diameter: 4 }, stepover: 2, angleDeg: 0,
      tolerance: 0.05, xyBounds: { minX: 0, minY: 0, maxX: 24, maxY: 24 },
      heights: { clearanceZ: 20, retractZ: 17, feedZ: 15 }, zSeed: 0,
    };
    try {
      const absent = await parallelFinish(kernel, input);
      const zero = await parallelFinish(kernel, { ...input, maxSlopeDeg: 0 });
      expect(JSON.stringify(zero)).toBe(JSON.stringify(absent));
      expect(irFingerprint(absent)).toBe('76e84a3868f7d9ce'); // WO-1615: chords refined at the dome/slab crease

      const filtered = await parallelFinish(kernel, { ...input, maxSlopeDeg: 30 });
      expect(filtered.moves.some(move => move.role === 'cut')).toBe(true);
      expect(filtered.moves.some(move => move.role === 'stepover')).toBe(true);
      expect(filtered.moves.filter(move => move.role === 'rapid').length).toBeGreaterThan(2);
    } finally {
      kernel.releaseMesh(mesh);
    }
  }, 120_000);
});

describe('WO-1190 composite operation', () => {
  const base = {
    partMesh: PART,
    tool: TOOL,
    resolvedHeights: HEIGHTS,
  };

  it('runs constant-Z steep paths first, raster shallow paths second, and overlaps the threshold', async () => {
    const calls: Array<{ family: string; input: unknown }> = [];
    const result = await computeSteepShallow3dMoves({
      ...base,
      params: { ...DEFAULT_STEEP_SHALLOW3D_PARAMS, thresholdDeg: 30 },
      client: recordingClient(calls),
    });
    expect(calls.map(call => call.family)).toEqual(['waterline', 'parallel']);
    const steepInput = calls[0].input as WaterlineClientInput;
    const shallowInput = calls[1].input as ParallelFinishClientInput;
    expect(steepInput.minSlopeDeg).toBe(30 - STEEP_SHALLOW_OVERLAP_DEG / 2);
    expect(shallowInput.maxSlopeDeg).toBe(30 + STEEP_SHALLOW_OVERLAP_DEG / 2);

    const cutRuns: ToolpathMove[][] = [];
    for (const move of result.moves) {
      if (move.role === 'cut') {
        if (cutRuns.length === 0 || result.moves[result.moves.indexOf(move) - 1]?.role !== 'cut') cutRuns.push([]);
        cutRuns[cutRuns.length - 1].push(move);
      }
    }
    expect(new Set(cutRuns[0].map(move => move.z)).size).toBe(1);
    expect(new Set(cutRuns[1].map(move => move.z)).size).toBeGreaterThan(1);

    const samples: Array<[number, number, number]> = [
      [0, 1, 0], [0, 1.5, 0], [0, 2, 0],
      [1, 0, 0.2], [1.5, 0, 0.3], [2, 0, 0.4],
    ];
    const cutSegments: Array<[ToolpathMove, ToolpathMove]> = [];
    for (let i = 1; i < result.moves.length; i++) {
      if (result.moves[i - 1].role === 'cut' && result.moves[i].role === 'cut') {
        cutSegments.push([result.moves[i - 1], result.moves[i]]);
      }
    }
    const distances = samples.map(point => Math.min(...cutSegments.map(([a, b]) => distanceToSegment(point, a, b))));
    const covered = distances.filter(distance => distance <= DEFAULT_STEEP_SHALLOW3D_PARAMS.tolerance).length;
    expect(covered / samples.length).toBe(1);
    expect(Math.max(...distances)).toBeLessThanOrEqual(DEFAULT_STEEP_SHALLOW3D_PARAMS.tolerance);
    console.log(`WO-1190 coverage: ${covered}/${samples.length} = 100%; max gap ${Math.max(...distances).toFixed(6)} mm`);
  });

  it('degrades at 0 deg and 90 deg to standalone waterline and parallel output', async () => {
    const zeroCalls: Array<{ family: string; input: unknown }> = [];
    const zero = await computeSteepShallow3dMoves({
      ...base,
      params: { ...DEFAULT_STEEP_SHALLOW3D_PARAMS, thresholdDeg: 0 },
      client: recordingClient(zeroCalls),
    });
    expect(zeroCalls.map(call => call.family)).toEqual(['waterline']);
    expect(zero.moves).toEqual(waterlineIr().moves.map(move => ({
      type: move.t, x: move.x, y: move.y, z: move.z, role: move.role,
    })));

    const ninetyCalls: Array<{ family: string; input: unknown }> = [];
    const ninety = await computeSteepShallow3dMoves({
      ...base,
      params: { ...DEFAULT_STEEP_SHALLOW3D_PARAMS, thresholdDeg: 90 },
      client: recordingClient(ninetyCalls),
    });
    expect(ninetyCalls.map(call => call.family)).toEqual(['parallel']);
    expect(ninety.moves).toEqual(parallelIr().moves.map(move => ({
      type: move.t, x: move.x, y: move.y, z: move.z, role: move.role,
    })));
  });

  it('reads exactly the authored operation fields and repairs invalid values', () => {
    expect(readSteepShallow3dParams({})).toEqual(DEFAULT_STEEP_SHALLOW3D_PARAMS);
    expect(readSteepShallow3dParams({
      thresholdDeg: 42, stepdown: 0.6, stepover: 0.4, angleDeg: 45,
      tolerance: 0.02, stockToLeave: 0.1, useStockBoundary: true, finishDepth: 3,
    })).toEqual({
      thresholdDeg: 42, stepdown: 0.6, stepover: 0.4, angleDeg: 45,
      tolerance: 0.02, stockToLeave: 0.1, useStockBoundary: true, finishDepth: 3,
    });
  });

  it('persists and resolves its own Smart Height target-field authority', () => {
    const intent = buildSteepShallow3dSmartIntent({
      setupId: 'setup-1',
      geometryIds: ['part-1'],
      safetyIntent: defaultHeightIntent(),
      finishDepthMm: 2,
    });
    expect(intent.policy).toEqual({
      operationType: 'steep_shallow_3d',
      variant: 'bounded_surface',
    });
    expect(steepShallow3dHeightDraftFromIntent(intent)).toEqual({
      mode: 'bounded_surface',
      finishDepthMm: 2,
    });
    const evidence = buildSteepShallow3dEvidenceContext({
      revision: { projectRevision: 'p1', setupRevision: 's1', operationRevision: 'o1' },
      wcsOriginMachineMm: 0,
      operationId: 'op-1',
      geometryIds: ['part-1'],
      target: {
        geometryId: 'part-1',
        artifactId: 'mesh:part-1',
        boundsMachineMm: { minX: 0, minY: 0, minZ: 0, maxX: 10, maxY: 10, maxZ: 4 },
        fingerprint: 'part-fp',
        representation: 'steep-shallow-target-surface-field',
      },
    });
    const resolved = resolveSteepShallow3dSmartHeights({
      intent,
      evidence,
      geometryIds: ['part-1'],
      geometryPositionZ: 0,
    });
    expect(resolved.plan.policy.operationType).toBe('steep_shallow_3d');
    expect(resolved.localHeights).toMatchObject({ topZ: 4, bottomZ: 2 });
    expect(resolved.finishDepthMm).toBe(2);
  });
});
