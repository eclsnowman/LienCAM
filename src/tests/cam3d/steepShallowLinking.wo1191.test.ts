import { describe, expect, it } from 'vitest';
import { hemisphereOnSlab } from '../../cam3d/fixtures';
import type { IrMove } from '../../cam3d/ir/types';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { parallelFinish, type ParallelFinishInput } from '../../cam3d/strategies/parallel';

const INPUT = {
  cutter: { kind: 'ball' as const, diameter: 4 },
  stepover: 1,
  angleDeg: 0,
  tolerance: 0.05,
  surfaceStockToLeave: 0.2,
  maxSlopeDeg: 31,
  xyBounds: { minX: 0, minY: 0, maxX: 24, maxY: 24 },
  heights: { clearanceZ: 20, retractZ: 17, feedZ: 15 },
  zSeed: 0,
};

function countEntries(moves: readonly IrMove[]): number {
  return moves.reduce((count, move, index) => (
    move.t !== 'rapid' && (index === 0 || moves[index - 1].t === 'rapid') ? count + 1 : count
  ), 0);
}

function countPasses(moves: readonly IrMove[]): number {
  return moves.reduce((count, move, index) => (
    move.role === 'cut' && moves[index - 1]?.role !== 'cut' ? count + 1 : count
  ), 0);
}

function connectorRuns(moves: readonly IrMove[]): IrMove[][] {
  const runs: IrMove[][] = [];
  for (let i = 0; i < moves.length; i++) {
    if (moves[i].role !== 'stepover' || moves[i - 1]?.role === 'stepover') continue;
    const run = [moves[i - 1]];
    while (i < moves.length && moves[i].role === 'stepover') run.push(moves[i++]);
    runs.push(run);
    i--;
  }
  return runs;
}

function samplePolyline(polyline: readonly IrMove[], step: number): Float64Array {
  const xy: number[] = [];
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const count = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step));
    for (let j = i === 1 ? 0 : 1; j <= count; j++) {
      const t = j / count;
      xy.push(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t);
    }
  }
  return new Float64Array(xy);
}

function interpolatePolylineZ(polyline: readonly IrMove[], xy: Float64Array): Float64Array {
  const z = new Float64Array(xy.length / 2);
  let sample = 0;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const segmentLength = Math.hypot(b.x - a.x, b.y - a.y);
    const count = Math.max(1, Math.ceil(segmentLength / 0.1));
    for (let j = i === 1 ? 0 : 1; j <= count; j++) {
      z[sample++] = a.z + (b.z - a.z) * (j / count);
    }
  }
  return z;
}

async function connectorSafety(
  kernel: BvhKernel,
  mesh: ReturnType<BvhKernel['uploadMesh']>,
  connector: readonly IrMove[],
): Promise<{ maxSlopeDeg: number; minSurfaceClearance: number }> {
  const cutter = kernel.makeCutter(INPUT.cutter);
  try {
    const xy = samplePolyline(connector, 0.1);
    const pathZ = interpolatePolylineZ(connector, xy);
    const centerZ = await kernel.dropPoints(mesh, cutter, xy, INPUT.zSeed);
    const normalStep = 0.25;
    const neighborXY = new Float64Array(xy.length * 4);
    for (let i = 0; i < xy.length / 2; i++) {
      const x = xy[2 * i];
      const y = xy[2 * i + 1];
      const base = i * 8;
      neighborXY.set([
        x - normalStep, y, x + normalStep, y,
        x, y - normalStep, x, y + normalStep,
      ], base);
    }
    const neighborZ = await kernel.dropPoints(mesh, cutter, neighborXY, INPUT.zSeed);
    let maxSlopeDeg = 0;
    let minSurfaceClearance = Infinity;
    for (let i = 0; i < centerZ.length; i++) {
      const base = i * 4;
      const dzdx = (neighborZ[base + 1] - neighborZ[base]) / (2 * normalStep);
      const dzdy = (neighborZ[base + 3] - neighborZ[base + 2]) / (2 * normalStep);
      const offsetSurfaceZ = centerZ[i] + INPUT.surfaceStockToLeave / Math.hypot(dzdx, dzdy, 1);
      maxSlopeDeg = Math.max(maxSlopeDeg, Math.atan(Math.hypot(dzdx, dzdy)) * 180 / Math.PI);
      minSurfaceClearance = Math.min(minSurfaceClearance, pathZ[i] - offsetSurfaceZ);
    }
    return { maxSlopeDeg, minSurfaceClearance };
  } finally {
    kernel.releaseCutter(cutter);
  }
}

function pointSegmentDistance2d(point: IrMove, a: IrMove, b: IrMove): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const denom = dx * dx + dy * dy;
  const t = denom === 0 ? 0 : Math.max(0, Math.min(1,
    ((point.x - a.x) * dx + (point.y - a.y) * dy) / denom,
  ));
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy));
}

function corridorEscape(previousPass: readonly IrMove[], from: IrMove, to: IrMove): number {
  let escape = Infinity;
  for (let i = 1; i < previousPass.length; i++) {
    escape = Math.min(escape, Math.max(
      pointSegmentDistance2d(from, previousPass[i - 1], previousPass[i]),
      pointSegmentDistance2d(to, previousPass[i - 1], previousPass[i]),
    ));
  }
  return escape;
}

function refusedConnectorEscapes(moves: readonly IrMove[]): number[] {
  const escapes: number[] = [];
  for (let i = 1; i < moves.length; i++) {
    if (moves[i].t !== 'rapid' || moves[i - 1].t === 'rapid') continue;
    const from = moves[i - 1];
    let next = i;
    while (next < moves.length && moves[next].t === 'rapid') next++;
    if (next >= moves.length) continue;
    const to = moves[next - 1];
    if (Math.hypot(to.x - from.x, to.y - from.y) > 2 * INPUT.stepover + 1e-9) continue;
    let start = i - 1;
    while (start > 0 && moves[start - 1].t !== 'rapid' && moves[start].role !== 'stepover') start--;
    const previousPass = moves.slice(start, i);
    if (previousPass.length >= 2) escapes.push(corridorEscape(previousPass, from, to));
  }
  return escapes;
}

describe('WO-1191 shallow linking', () => {
  it('stays down on shallow tracks without crossing steep or offset-surface samples', async () => {
    const kernel = new BvhKernel();
    const mesh = kernel.uploadMesh(hemisphereOnSlab(8, { x: 24, y: 24, t: 4 }));
    const input: ParallelFinishInput = { mesh, ...INPUT };
    try {
      const result = await parallelFinish(kernel, input);
      const entries = countEntries(result.moves);
      // Before WO-1191 every filtered piece was linked as a separate group, so
      // its entry count was exactly the number of surviving pass pieces.
      const baselineEntries = countPasses(result.moves);
      const stepovers = result.moves.filter(move => move.role === 'stepover').length;
      const connectors = connectorRuns(result.moves);
      console.log(
        `WO-1191 measurement: baselineEntries=${baselineEntries}; entries=${entries}; ` +
        `connectors=${connectors.length}; stepoverMoves=${stepovers}; moves=${result.moves.length}`,
      );
      expect(baselineEntries).toBe(55);
      expect(entries).toBe(26); // WO-1615: refined chords at creases split four more pieces
      expect(entries).toBeLessThan(baselineEntries / 2);
      expect(connectors).toHaveLength(baselineEntries - entries);
      const refusedEscapes = refusedConnectorEscapes(result.moves);
      console.log(`WO-1191 refused short-link escapes: ${refusedEscapes.map(value => value.toFixed(6)).join(', ')}`);
      expect(refusedEscapes.length).toBeGreaterThan(0);
      for (const escape of refusedEscapes) expect(escape).toBeGreaterThan(INPUT.stepover);
      let worstSlopeDeg = 0;
      let worstSurfaceClearance = Infinity;
      for (const [index, connector] of connectors.entries()) {
        const safety = await connectorSafety(kernel, mesh, connector);
        worstSlopeDeg = Math.max(worstSlopeDeg, safety.maxSlopeDeg);
        worstSurfaceClearance = Math.min(worstSurfaceClearance, safety.minSurfaceClearance);
        expect(safety.maxSlopeDeg, `connector ${index} crossed the ${INPUT.maxSlopeDeg} deg threshold`)
          .toBeLessThanOrEqual(INPUT.maxSlopeDeg + 1e-6);
        expect(safety.minSurfaceClearance, `connector ${index} fell below the offset surface`)
          .toBeGreaterThanOrEqual(-INPUT.tolerance);
      }
      console.log(
        `WO-1191 connector safety: maxSlope=${worstSlopeDeg.toFixed(6)} deg; ` +
        `minOffsetSurfaceClearance=${worstSurfaceClearance.toFixed(6)} mm ` +
        `(tolerance=${INPUT.tolerance.toFixed(3)} mm)`,
      );
    } finally {
      kernel.releaseMesh(mesh);
    }
  }, 120_000);
});
