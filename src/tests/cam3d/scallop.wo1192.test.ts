import { describe, expect, it } from 'vitest';
import { hemisphereOnSlab } from '../../cam3d/fixtures';
import { irFingerprint } from '../../cam3d/ir/types';
import type { IrMove, ToolpathIR } from '../../cam3d/ir/types';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { computeScallop3dMoves } from '../../cam3d/integration/scallop3dOperation';
import { parallelFinish } from '../../cam3d/strategies/parallel';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import type { Tool } from '../../types';
import {
  scallopFinish,
  stepoverForScallop,
} from '../../cam3d/strategies/scallop';

const CUTTER = { kind: 'ball' as const, diameter: 4 };
const BOUNDS = { minX: 0, minY: 0, maxX: 24, maxY: 24 };
const HEIGHTS = { clearanceZ: 20, retractZ: 17, feedZ: 15 };

type Sample = { x: number; y: number; z: number };

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel();
  const worker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {},
  };
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    worker.onmessage?.({ data: message } as MessageEvent);
  });
  return new Cam3dClient(worker);
}

function ballTool(): Tool {
  return {
    id: 'wo1192-ball', name: '4 mm ball', type: 'ball_end_mill', diameter: 4,
    fluteLength: 12, shankDiameter: 4, overallLength: 50, numberOfFlutes: 2,
    material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: {},
  };
}

function cutSegments(ir: ToolpathIR): Array<[IrMove, IrMove]> {
  const segments: Array<[IrMove, IrMove]> = [];
  for (let i = 1; i < ir.moves.length; i++) {
    if (ir.moves[i - 1].role === 'cut' && ir.moves[i].role === 'cut') {
      segments.push([ir.moves[i - 1], ir.moves[i]]);
    }
  }
  return segments;
}

function sectionIntersections(ir: ToolpathIR, y: number): Sample[] {
  const hits: Sample[] = [];
  for (const [a, b] of cutSegments(ir)) {
    const minY = Math.min(a.y, b.y);
    const maxY = Math.max(a.y, b.y);
    if (y < minY - 1e-8 || y > maxY + 1e-8 || Math.abs(b.y - a.y) < 1e-10) continue;
    const t = (y - a.y) / (b.y - a.y);
    if (t < -1e-8 || t > 1 + 1e-8) continue;
    hits.push({ x: a.x + (b.x - a.x) * t, y, z: a.z + (b.z - a.z) * t });
  }
  hits.sort((a, b) => a.x - b.x);
  return hits.filter((hit, index) => index === 0 || Math.abs(hit.x - hits[index - 1].x) > 0.03);
}

function measuredCusps(hits: readonly Sample[], radius: number): Array<{ midpointX: number; cusp: number; spacing: number }> {
  const result: Array<{ midpointX: number; cusp: number; spacing: number }> = [];
  for (let i = 1; i < hits.length; i++) {
    const spacing = Math.hypot(hits[i].x - hits[i - 1].x, hits[i].z - hits[i - 1].z);
    if (spacing >= 2 * radius) continue;
    result.push({
      midpointX: (hits[i].x + hits[i - 1].x) / 2,
      cusp: radius - Math.sqrt(radius * radius - (spacing / 2) ** 2),
      spacing,
    });
  }
  return result;
}

function pointSegmentDistance(point: Sample, a: IrMove, b: IrMove): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const dz = b.z - a.z;
  const denominator = dx * dx + dy * dy + dz * dz;
  const t = denominator === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - a.x) * dx + (point.y - a.y) * dy + (point.z - a.z) * dz) / denominator,
  ));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy), point.z - (a.z + t * dz));
}

describe('WO-1192 constant scallop', () => {
  it('derives its surface spacing from cusp height and refuses an impossible cusp', () => {
    expect(stepoverForScallop(2, 0.01)).toBeCloseTo(0.3994996871, 9);
    expect(() => stepoverForScallop(2, 2)).toThrow(/must be smaller than cutter radius/);
  });

  it('contours a deterministic geodesic distance field without changing parallel output', async () => {
    const kernel = new BvhKernel();
    const mesh = kernel.uploadMesh(hemisphereOnSlab(8, { x: 24, y: 24, t: 4 }));
    try {
      const input = {
        mesh,
        cutter: CUTTER,
        scallopHeight: 0.05,
        tolerance: 0.2,
        direction: 'climb' as const,
        xyBounds: BOUNDS,
        heights: HEIGHTS,
        zSeed: 0,
      };
      const first = await scallopFinish(kernel, input);
      const second = await scallopFinish(kernel, input);
      expect(first.moves.some(move => move.role === 'cut')).toBe(true);
      expect(JSON.stringify(second)).toBe(JSON.stringify(first));
      expect(first.meta.strategyId).toBe('scallop_finish');
      expect(first.meta.params?.stepover).toBeCloseTo(stepoverForScallop(2, 0.05), 10);

      const parallel = await parallelFinish(kernel, {
        mesh,
        cutter: CUTTER,
        stepover: 2,
        angleDeg: 0,
        tolerance: 0.05,
        xyBounds: BOUNDS,
        heights: HEIGHTS,
        zSeed: 0,
      });
      expect(irFingerprint(parallel)).toBe('76e84a3868f7d9ce'); // WO-1615: chords refined at the dome/slab crease
    } finally {
      kernel.releaseMesh(mesh);
    }
  }, 120_000);

  it('round-trips through the production adapter, client, and worker dispatcher', async () => {
    const client = makeClient();
    try {
      const partMesh = hemisphereOnSlab(8, { x: 24, y: 24, t: 4 });
      const result = await computeScallop3dMoves({
        partMesh,
        tool: ballTool(),
        params: {
          scallopHeight: 0.05,
          tolerance: 0.2,
          stockToLeave: 0,
          useStockBoundary: false,
          direction: 'climb',
        },
        resolvedHeights: {
          clearanceZ: 20, retractZ: 17, feedZ: 15,
          topZ: 12, bottomZ: 0, stockTopZ: 12,
        },
        client,
      });
      expect(result.moves.some(move => move.role === 'cut')).toBe(true);
      expect(result.moves.every(move => Number.isFinite(move.x + move.y + move.z))).toBe(true);
      expect(result.computeTimeMs).toBeGreaterThanOrEqual(0);
    } finally {
      await client.dispose();
    }
  }, 120_000);

  it('holds measured cusp on flat and steep regions while equal-XY parallel spacing grows it', async () => {
    const kernel = new BvhKernel();
    const mesh = kernel.uploadMesh(hemisphereOnSlab(8, { x: 24, y: 24, t: 4 }));
    const scallopHeight = 0.02;
    const tolerance = 0.1;
    const flatSpacing = stepoverForScallop(2, scallopHeight);
    try {
      const scallop = await scallopFinish(kernel, {
        mesh, cutter: CUTTER, scallopHeight, tolerance, direction: 'climb',
        xyBounds: BOUNDS, heights: HEIGHTS, zSeed: 0,
      });
      const parallel = await parallelFinish(kernel, {
        mesh, cutter: CUTTER, stepover: flatSpacing, angleDeg: 90, tolerance,
        xyBounds: BOUNDS, heights: HEIGHTS, zSeed: 0,
      });
      const scallopCusps = measuredCusps(sectionIntersections(scallop, 12), 2)
        // A clipped pass can miss the section; keep only adjacent-pass intervals.
        .filter(sample => sample.spacing <= flatSpacing * 1.5)
        .filter(sample => sample.midpointX < 11.5);
      const parallelCusps = measuredCusps(sectionIntersections(parallel, 12), 2)
        .filter(sample => sample.spacing <= flatSpacing * 1.5)
        .filter(sample => sample.midpointX < 11.5);
      const scallopFlat = scallopCusps.filter(sample => sample.midpointX >= 0.8 && sample.midpointX <= 3.5);
      const scallopSteep = scallopCusps.filter(sample => sample.midpointX >= 4.5 && sample.midpointX <= 9.5);
      const parallelFlat = parallelCusps.filter(sample => sample.midpointX >= 0.8 && sample.midpointX <= 3.5);
      const parallelSteep = parallelCusps.filter(sample => sample.midpointX >= 4.5 && sample.midpointX <= 9.5);
      expect(scallopFlat.length).toBeGreaterThan(2);
      expect(scallopSteep.length).toBeGreaterThan(2);
      const maximum = (samples: typeof scallopCusps) => Math.max(...samples.map(sample => sample.cusp));
      const average = (samples: typeof scallopCusps) => samples.reduce((sum, sample) => sum + sample.cusp, 0) / samples.length;
      expect(maximum(scallopFlat)).toBeLessThanOrEqual(scallopHeight + tolerance);
      expect(maximum(scallopSteep)).toBeLessThanOrEqual(scallopHeight + tolerance);
      expect(average(scallopFlat)).toBeGreaterThan(scallopHeight * 0.5);
      expect(average(parallelSteep)).toBeGreaterThan(average(parallelFlat) * 1.25);
      expect(average(parallelSteep)).toBeGreaterThan(average(scallopSteep) * 1.25);

      const cutter = kernel.makeCutter(CUTTER);
      try {
        const xy: number[] = [];
        for (let y = 0.5; y < 24; y += 1) for (let x = 0.5; x < 24; x += 1) xy.push(x, y);
        const z = await kernel.dropPoints(mesh, cutter, new Float64Array(xy), 0);
        const segments = cutSegments(scallop);
        let maxCoverageGap = 0;
        let covered = 0;
        for (let i = 0; i < z.length; i++) {
          const point = { x: xy[i * 2], y: xy[i * 2 + 1], z: z[i] };
          const distance = Math.min(...segments.map(([a, b]) => pointSegmentDistance(point, a, b)));
          const gap = Math.max(0, distance - CUTTER.diameter / 2);
          maxCoverageGap = Math.max(maxCoverageGap, gap);
          if (gap <= tolerance) covered++;
        }
        expect(covered).toBe(z.length);
        expect(maxCoverageGap).toBeLessThanOrEqual(tolerance);
        console.log(
          `WO-1192 cusp mm: scallop flat avg=${average(scallopFlat).toFixed(6)} max=${maximum(scallopFlat).toFixed(6)}; ` +
          `scallop steep avg=${average(scallopSteep).toFixed(6)} max=${maximum(scallopSteep).toFixed(6)}; ` +
          `parallel flat avg=${average(parallelFlat).toFixed(6)}; parallel steep avg=${average(parallelSteep).toFixed(6)}; ` +
          `coverage=${covered}/${z.length}, max gap=${maxCoverageGap.toFixed(6)} mm`,
        );
      } finally {
        kernel.releaseCutter(cutter);
      }
    } finally {
      kernel.releaseMesh(mesh);
    }
  }, 120_000);
});
