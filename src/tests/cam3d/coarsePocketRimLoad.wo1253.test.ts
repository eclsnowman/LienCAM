// WO-1253: a coarse pocket rough must not slot, and the ruler that says so must
// be able to see a cutter.
//
// Two behaviours are pinned here, both on the EMITTED path and never asserted
// from inside the generator (WO-100):
//
//   1. THE PATH. The coarse engagementPocket rough (4 mm flat, 1.5 mm cells,
//      50% stepover) used to hand the operator a wall-cleanup contour that ran
//      10.2 mm straight down the 6 mm neck at 101.7% of a full slot - the cutter
//      buried. It now leaves that stretch standing, says so in
//      `wallRimOverloadMm`, and STILL CLEARS THE POCKET: the cleared plan area
//      must stay within a few percent of the footprint, so "under the cap" can
//      never be bought by cutting less.
//
//   2. THE RULER. `measurePathEngagement` replays a path into a z-dexel field.
//      At the caller's own cell a 4 mm cutter spans 2.7 columns, removed width
//      quantizes to multiples of the cell and the 2 mm sustained window cannot
//      average it away - the same path read 107.4% of a slot at 1.5 mm cells and
//      52.9% at 0.375 mm. A synthetic 50%-engagement pass proves the module now
//      reads the load rather than the quantization, at any caller cell.

import { describe, it, expect, beforeAll } from 'vitest';

import { ZDexelField, removeSweep, type Box3 } from '../../cam3d/stock';
import { ensureGeom2dReady } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { PartMesh, CutterSpec } from '../../cam3d/kernel/types';
import { engagementPocket, engagementPocketFootprintArea } from '../../cam3d/fixtures';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import { measurePathEngagement } from '../../cam3d/rough/pathEngagement';
import { forEachLinearSweep } from '../../cam3d/rough/replayStock';
import type { IrMove } from '../../cam3d/ir/types';

let kernel: BvhKernel;

beforeAll(async () => {
  await ensureGeom2dReady();
  await ensureEngineClipperReady();
  kernel = new BvhKernel();
});

function boxOf(mesh: PartMesh): Box3 {
  const { min, max } = mesh.bounds;
  return { minX: min[0], minY: min[1], minZ: min[2], maxX: max[0], maxY: max[1], maxZ: max[2] };
}

/** Plan area whose column top dropped below the stock top after replaying `moves`. */
function clearedPlanArea(moves: readonly IrMove[], bounds: Box3, cell: number, cutter: CutterSpec): number {
  const field = ZDexelField.fromBox(bounds, cell);
  let prev: { x: number; y: number; z: number } | null = null;
  for (const m of moves) {
    if (prev !== null) forEachLinearSweep(prev, m, cell / 4, (sweep) => { removeSweep(field, sweep, cutter); });
    prev = { x: m.x, y: m.y, z: m.z };
  }
  let cleared = 0;
  for (let c = 0; c < field.top.length; c++) if (field.top[c] < bounds.maxZ - 0.5) cleared++;
  return cleared * field.cell * field.cell;
}

describe('WO-1253: the coarse pocket rough does not slot', () => {
  it('emits no sustained cut over 75% of a slot, and still clears the pocket', { timeout: 180000 }, async () => {
    const mesh = engagementPocket();
    const bounds = boxOf(mesh);
    const CELL = 1.5;
    const cutter: CutterSpec = { kind: 'flat', diameter: 4 };
    const handle = kernel.uploadMesh(mesh);
    try {
      // Gate A.5's inputs exactly: this is the job that buried the cutter.
      const input: AdaptiveRoughInput = {
        mesh: handle,
        cutter,
        stockBounds: bounds,
        cellSize: CELL,
        maxStepdown: 12,
        stepover: 0.5,
        tolerance: 0.15,
        helixDiameter: 3,
        heights: { clearanceZ: 20, retractZ: 16.5, feedZ: 16.5 },
        materialTopZ: bounds.maxZ,
      };
      const ir = await adaptiveRough(kernel, input);

      const engagement = measurePathEngagement(ir.moves, bounds, CELL, cutter, { capFraction: 0.75 });
      const cleared = clearedPlanArea(ir.moves, bounds, CELL, cutter);
      const footprint = engagementPocketFootprintArea(); // 2360 mm^2
      const surrendered = (ir.meta.params?.wallRimOverloadMm as number | undefined) ?? 0;
      // eslint-disable-next-line no-console
      console.log(
        `WO-1253 coarse rough: peak ${(engagement.peakFraction * 100).toFixed(1)}% of a slot, `
        + `${engagement.overCapLengthMm.toFixed(2)} mm over cap of ${engagement.cuttingLengthMm.toFixed(1)} mm cutting; `
        + `cleared ${cleared.toFixed(0)} / footprint ${footprint} mm^2; `
        + `wall left standing ${surrendered.toFixed(2)} mm`,
      );

      // The path. Nothing sustained over the cap, anywhere.
      expect(engagement.cuttingLengthMm).toBeGreaterThan(1000); // the measure ran on a real path
      expect(engagement.overCapLengthMm).toBe(0);
      expect(engagement.peakFraction).toBeLessThanOrEqual(0.75);

      // It did not buy that by cutting less. The 6 mm neck cannot be cleared by a
      // 4 mm cutter under a 75% cap at all, so a few percent of the footprint is
      // deliberately left for a finishing pass -- and that is ALL that is left.
      expect(cleared).toBeGreaterThan(footprint * 0.93);

      // And it said so rather than going quiet about it.
      expect(surrendered).toBeGreaterThan(0);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});

describe('WO-1253: the engagement ruler resolves the cutter', () => {
  it('a 50%-engagement pass reads as one on a field far coarser than the tool', () => {
    // A 200 x 60 x 20 block. The tool takes a 100 mm pass whose leading half-width
    // is fresh material and whose trailing half rides stock a previous pass already
    // removed: a textbook 50% radial engagement at 10 mm axial depth.
    const bounds: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 200, maxY: 60, maxZ: 20 };
    const cutter: CutterSpec = { kind: 'flat', diameter: 4 };
    const Z = 10;

    const build = (cell: number): { moves: IrMove[]; start: ZDexelField } => {
      const start = ZDexelField.fromBox(bounds, cell);
      // Pre-clear the y > 32 half-plane down to Z so the pass ahead is half in air.
      for (let j = 0; j < start.ny; j++) {
        const y = start.originY + (j + 0.5) * start.cell;
        if (y < 32) continue;
        for (let i = 0; i < start.nx; i++) start.top[j * start.nx + i] = Z;
      }
      // Centre at y = 32 -> the disc spans y in [30, 34]; only [30, 32] is standing.
      const moves: IrMove[] = [
        { t: 'rapid', role: 'rapid', x: 50, y: 32, z: Z },
        { t: 'feed', role: 'cut', x: 150, y: 32, z: Z },
      ];
      return { moves, start };
    };

    for (const cell of [1.5, 0.75, 0.5]) {
      const { moves, start } = build(cell);
      const r = measurePathEngagement(moves, bounds, cell, cutter, {
        capFraction: 0.75,
        startingStock: start,
      });
      // eslint-disable-next-line no-console
      console.log(`WO-1253 ruler: caller cell ${cell} mm -> peak ${(r.peakFraction * 100).toFixed(1)}% of a slot, ${r.overCapLengthMm.toFixed(2)} mm over cap`);
      expect(r.cuttingLengthMm).toBeGreaterThan(90);
      // Half a slot, read as half a slot -- not as the 112% the 1.5 mm caller cell
      // would quantize a 4 mm cutter's width up to.
      expect(r.peakFraction).toBeGreaterThan(0.35);
      expect(r.peakFraction).toBeLessThan(0.7);
      expect(r.overCapLengthMm).toBe(0);
    }
  });
});
