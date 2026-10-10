import { describe, expect, it } from 'vitest';
import { hemisphereOnSlab, steps } from '../../cam3d/fixtures';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { IrMove, ToolpathIR } from '../../cam3d/ir/types';
import { irFingerprint } from '../../cam3d/ir/types';
import { parallelFinish } from '../../cam3d/strategies/parallel';
import { effectivePencilRadius, pencilFinish } from '../../cam3d/strategies/pencil';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import { computePencil3dMoves } from '../../cam3d/integration/pencil3dOperation';
import type { Tool } from '../../types';
import {
  PENCIL_CORNER_X, PENCIL_FILLET_RADIUS, PENCIL_FIXTURE_SIZE,
  pencilCornerFixture, pencilCornerHeight, pencilGeometricFloor,
} from './pencilCornerFixture';

const CUTTER = { kind: 'ball' as const, diameter: 4 };
const RADIUS = CUTTER.diameter / 2;
const TOLERANCE = 0.1;
const HEIGHTS = { clearanceZ: 20, retractZ: 18, feedZ: 17 };
const BOUNDS = { minX: 0, minY: 0, maxX: PENCIL_FIXTURE_SIZE.x, maxY: PENCIL_FIXTURE_SIZE.y };
const ASYMMETRIC_DOME_RADIUS = 8;
const ASYMMETRIC_SLAB = { x: 24, y: 24, t: 4 } as const;
const ASYMMETRIC_TOLERANCE = 0.2;
const STEPS_SIZE = 40;
const STEPS_TOLERANCE = 0.2;
/** The three concave corner rings of `steps(4, 40, 3)`, as [half-width, tip Z]:
 *  5 mm treads and 3 mm risers put them at 17/z3, 12/z6 and 7/z9. */
const STEPS_CORNER_TRACKS = [[17, 3], [12, 6], [7, 9]] as const;

function cuts(ir: ToolpathIR): IrMove[] {
  return ir.moves.filter(move => move.role === 'cut');
}

function sectionToolCenters(ir: ToolpathIR, y: number): Array<{ x: number; z: number }> {
  const hits: Array<{ x: number; z: number }> = [];
  for (let i = 1; i < ir.moves.length; i++) {
    const a = ir.moves[i - 1], b = ir.moves[i];
    if (a.role !== 'cut' || b.role !== 'cut' || Math.abs(b.y - a.y) < 1e-10) continue;
    const t = (y - a.y) / (b.y - a.y);
    if (t >= 0 && t <= 1) hits.push({ x: a.x + (b.x - a.x) * t, z: a.z + (b.z - a.z) * t });
  }
  return hits;
}

function materialAtCorner(paths: readonly ToolpathIR[]): number {
  let machinedZ = Infinity;
  for (const ir of paths) for (const center of sectionToolCenters(ir, PENCIL_FIXTURE_SIZE.y / 2)) {
    const dx = center.x - PENCIL_CORNER_X;
    if (Math.abs(dx) <= RADIUS) {
      machinedZ = Math.min(machinedZ, center.z + RADIUS - Math.sqrt(RADIUS ** 2 - dx ** 2));
    }
  }
  return machinedZ - pencilCornerHeight(PENCIL_CORNER_X);
}

function makeClient(): Cam3dClient {
  const kernel = new BvhKernel();
  const worker: WorkerLike = { onmessage: null, onerror: null,
    postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest); }, terminate(): void {} };
  const dispatcher = new Cam3dDispatcher(kernel, (message: Cam3dResponse) => {
    worker.onmessage?.({ data: message } as MessageEvent);
  });
  return new Cam3dClient(worker);
}

function ballTool(): Tool {
  return { id: 'wo1193-ball', name: '4 mm ball', type: 'ball_end_mill', diameter: 4,
    fluteLength: 12, shankDiameter: 4, overallLength: 50, numberOfFlutes: 2,
    material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: {} };
}

describe('WO-1193 pencil cleanup', () => {
  it('accepts rolling-radius cutters and refuses flat and V cutters plainly', () => {
    expect(effectivePencilRadius(CUTTER)).toBe(2);
    expect(effectivePencilRadius({ kind: 'bull', diameter: 6, cornerRadius: 1 })).toBe(1);
    expect(() => effectivePencilRadius({ kind: 'flat', diameter: 4 })).toThrow(/ball or bull-nose/);
    expect(() => effectivePencilRadius({ kind: 'vbit', diameter: 4, angleFromAxisDeg: 30 })).toThrow(/ball or bull-nose/);
  });

  it('reduces measured corner stock to the geometric floor without cutting flat regions', async () => {
    const kernel = new BvhKernel(), mesh = kernel.uploadMesh(pencilCornerFixture());
    try {
      const parallel = await parallelFinish(kernel, {
        mesh, cutter: CUTTER, stepover: 3, angleDeg: 90, tolerance: TOLERANCE,
        xyBounds: BOUNDS, heights: HEIGHTS, zSeed: 4,
      });
      const pencil = await pencilFinish(kernel, {
        mesh, cutter: CUTTER, tolerance: TOLERANCE, direction: 'climb',
        xyBounds: BOUNDS, heights: HEIGHTS, zSeed: 4,
      });
      const before = materialAtCorner([parallel]);
      const after = materialAtCorner([parallel, pencil]);
      const floor = pencilGeometricFloor(RADIUS);
      const cutMoves = cuts(pencil);
      const flatMoves = cutMoves.filter(move => Math.abs(move.x - PENCIL_CORNER_X) > RADIUS).length;
      expect(before).toBeGreaterThan(floor + TOLERANCE);
      expect(after).toBeGreaterThanOrEqual(floor - TOLERANCE);
      expect(after).toBeLessThanOrEqual(floor + TOLERANCE);
      expect(flatMoves).toBe(0);
      expect(pencil.meta.params?.tracedPolylineCount).toBe(1);
      console.log(`WO-1193 corner mm: fillet radius=${PENCIL_FILLET_RADIUS}; cutter radius=${RADIUS}; before=${before.toFixed(6)}; after=${after.toFixed(6)}; floor=${floor.toFixed(6)}; flat moves=${flatMoves}; polylines=${pencil.meta.params?.tracedPolylineCount}`);
    } finally { kernel.releaseMesh(mesh); }
  }, 120_000);

  it('follows the cutter-location minimum at an asymmetric dome-to-slab corner', async () => {
    const kernel = new BvhKernel();
    const mesh = kernel.uploadMesh(hemisphereOnSlab(ASYMMETRIC_DOME_RADIUS, ASYMMETRIC_SLAB));
    try {
      const pencil = await pencilFinish(kernel, {
        mesh, cutter: CUTTER, tolerance: ASYMMETRIC_TOLERANCE, direction: 'climb',
        xyBounds: { minX: 0, minY: 0, maxX: ASYMMETRIC_SLAB.x, maxY: ASYMMETRIC_SLAB.y },
        heights: HEIGHTS, zSeed: 0,
      });
      const centerX = ASYMMETRIC_SLAB.x / 2;
      const centerY = ASYMMETRIC_SLAB.y / 2;
      const idealTrackRadius = Math.sqrt((ASYMMETRIC_DOME_RADIUS + RADIUS) ** 2 - RADIUS ** 2);
      const idealCornerGap = Math.hypot(idealTrackRadius - ASYMMETRIC_DOME_RADIUS, RADIUS) - RADIUS;
      const cutMoves = cuts(pencil);
      const trackRadii = cutMoves.map(move => Math.hypot(move.x - centerX, move.y - centerY));
      const lowest = cutMoves.reduce((best, move) => move.z < best.z ? move : best, cutMoves[0]);
      const lowestRadius = Math.hypot(lowest.x - centerX, lowest.y - centerY);
      const highestTipZ = Math.max(...cutMoves.map(move => move.z));
      const minTrackRadius = Math.min(...trackRadii);
      const maxTrackRadius = Math.max(...trackRadii);
      const offTrack = cutMoves.filter((move, index) =>
        move.z > ASYMMETRIC_SLAB.t + ASYMMETRIC_TOLERANCE ||
        Math.abs(trackRadii[index] - idealTrackRadius) > ASYMMETRIC_TOLERANCE * 2);
      const cornerGap = cutMoves.reduce((best, move) => {
        const radial = Math.hypot(move.x - centerX, move.y - centerY);
        return Math.min(best, Math.hypot(radial - ASYMMETRIC_DOME_RADIUS, move.z + RADIUS - ASYMMETRIC_SLAB.t) - RADIUS);
      }, Infinity);

      console.log(`WO-1193 asymmetric corner mm: ideal radius=${idealTrackRadius.toFixed(4)}; track radius=${minTrackRadius.toFixed(4)}..${maxTrackRadius.toFixed(4)}; tip z=${lowest.z.toFixed(4)}..${highestTipZ.toFixed(4)}; gap=${cornerGap.toFixed(4)}; floor=${idealCornerGap.toFixed(4)}; off track=${offTrack.length}/${cutMoves.length}; polylines=${pencil.meta.params?.tracedPolylineCount}`);
      if (offTrack.length > 0) console.log('WO-1193 asymmetric off-track sample', offTrack.slice(0, 8));
      expect(pencil.meta.params?.tracedPolylineCount).toBe(1);
      expect(lowest.z).toBeLessThanOrEqual(ASYMMETRIC_SLAB.t + ASYMMETRIC_TOLERANCE);
      expect(Math.abs(lowestRadius - idealTrackRadius)).toBeLessThanOrEqual(ASYMMETRIC_TOLERANCE * 2);
      expect(highestTipZ).toBeLessThanOrEqual(ASYMMETRIC_SLAB.t + ASYMMETRIC_TOLERANCE);
      expect(trackRadii.every(radial => Math.abs(radial - idealTrackRadius) <= ASYMMETRIC_TOLERANCE * 2)).toBe(true);
      expect(cornerGap).toBeGreaterThanOrEqual(idealCornerGap - ASYMMETRIC_TOLERANCE);
      expect(cornerGap).toBeLessThanOrEqual(idealCornerGap + ASYMMETRIC_TOLERANCE);
    } finally { kernel.releaseMesh(mesh); }
  }, 120_000);

  it('round-trips through the production adapter, client, and dispatcher', async () => {
    const client = makeClient();
    try {
      const result = await computePencil3dMoves({
        partMesh: pencilCornerFixture(), tool: ballTool(),
        params: { tolerance: TOLERANCE, stockToLeave: 0, useStockBoundary: false, direction: 'climb' },
        resolvedHeights: { clearanceZ: 20, retractZ: 18, feedZ: 17, topZ: pencilCornerHeight(0), bottomZ: 4, stockTopZ: pencilCornerHeight(0) },
        client,
      });
      expect(result.moves.some(move => move.role === 'cut')).toBe(true);
      expect(result.moves.every(move => Number.isFinite(move.x + move.y + move.z))).toBe(true);
    } finally { await client.dispose(); }
  }, 120_000);

  /**
   * THE SEARCH MUST NOT LEAVE ITS OWN BAND (fix-round audit, index.ts:252).
   *
   * A stepped part puts several concave corners a short distance apart with
   * dead ground between them. When the transverse search swept the whole
   * +/-(2r+cell) line and merely SKIPPED the cells outside the band, it
   * crossed that dead ground and snapped onto whichever neighbouring band was
   * lower - always the next tread down, and by as little as 23 microns. The
   * near corner then received NO pass, and the pass meant for it was
   * re-emitted on a convex rollover about 3 mm above the material, cutting
   * nothing. Both trap counters still read clean, which is exactly why this
   * shape needs its own case: the polyline COUNT was right, the polyline
   * POSITIONS were not.
   *
   * Measured, broken code -> fix:
   *   halfwidth 17 @ z3     545 -> 1064 cutting moves
   *   halfwidth 12 @ z6      35 ->  535
   *   halfwidth  7 @ z9       2 ->   86
   *   share of cuts on a real corner track   55.7% -> 99.5%
   */
  it('cuts every corner of a stepped part, never a neighbour it stepped across', async () => {
    const kernel = new BvhKernel(), mesh = kernel.uploadMesh(steps(4, STEPS_SIZE, 3));
    try {
      const pencil = await pencilFinish(kernel, {
        mesh, cutter: CUTTER, tolerance: STEPS_TOLERANCE, direction: 'climb',
        xyBounds: { minX: 0, minY: 0, maxX: STEPS_SIZE, maxY: STEPS_SIZE },
        heights: { clearanceZ: 30, retractZ: 28, feedZ: 26 }, zSeed: 0,
      });
      const center = STEPS_SIZE / 2;
      const cutMoves = cuts(pencil);
      // A square corner ring shows up as one constant Chebyshev half-width.
      const halfWidth = (move: IrMove): number =>
        Math.max(Math.abs(move.x - center), Math.abs(move.y - center));
      const onTrack = (move: IrMove, h: number, z: number): boolean =>
        Math.abs(halfWidth(move) - h) <= STEPS_TOLERANCE * 3
        && Math.abs(move.z - z) <= STEPS_TOLERANCE * 1.5;

      const perTrack = STEPS_CORNER_TRACKS.map(([h, z]) =>
        cutMoves.filter(move => onTrack(move, h, z)).length);
      const anyTrack = cutMoves.filter(move =>
        STEPS_CORNER_TRACKS.some(([h, z]) => onTrack(move, h, z))).length;

      console.log(`WO-1193 stepped part: polylines=${pencil.meta.params?.tracedPolylineCount}; cuts=${cutMoves.length}; `
        + STEPS_CORNER_TRACKS.map(([h, z], i) => `h${h}@z${z}=${perTrack[i]}`).join('; ')
        + `; on a corner track=${anyTrack}/${cutMoves.length}`);

      expect(pencil.meta.params?.tracedPolylineCount).toBe(STEPS_CORNER_TRACKS.length);
      // EVERY corner gets a real pass. The broken code left two of the three
      // with 35 and 2 moves, so this is the assertion that fails on it.
      for (const count of perTrack) expect(count).toBeGreaterThanOrEqual(40);
      // And virtually nothing lands anywhere else: the broken code put 44% of
      // its cutting moves on convex rollovers that cut nothing.
      expect(anyTrack / cutMoves.length).toBeGreaterThan(0.95);
    } finally { kernel.releaseMesh(mesh); }
  }, 120_000);

  it('keeps the standing parallel fixture byte-identical', async () => {
    const kernel = new BvhKernel(), mesh = kernel.uploadMesh(hemisphereOnSlab(8, { x: 24, y: 24, t: 4 }));
    try {
      const parallel = await parallelFinish(kernel, {
        mesh, cutter: CUTTER, stepover: 2, angleDeg: 0, tolerance: 0.05,
        xyBounds: { minX: 0, minY: 0, maxX: 24, maxY: 24 },
        heights: { clearanceZ: 20, retractZ: 17, feedZ: 15 }, zSeed: 0,
      });
      expect(irFingerprint(parallel)).toBe('76e84a3868f7d9ce'); // WO-1615: chords refined at the dome/slab crease
    } finally { kernel.releaseMesh(mesh); }
  }, 120_000);
});
