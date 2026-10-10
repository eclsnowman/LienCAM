// WO-1252 probe (opt-in): what is the LONGEST UNBROKEN over-cap run of the 10mm
// ring, the case the refusal row exists for? `overCapLengthMm` is a whole-path
// sum, so it grows with path length and cannot tell one cutter-breaking corridor
// apart from a handful of sub-millimetre corner nibbles scattered over a long
// rest job. The fix round moved the row onto `longestOverCapRunMm`; these are the
// numbers that decision was made on. WO1252_RUNS=1 to run.
import { describe, it, beforeAll } from 'vitest';
import { ensureGeom2dReady } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { Box3 } from '../../cam3d/stock';
import type { CutterSpec } from '../../cam3d/kernel/types';
import { bossInOpenStock } from '../../cam3d/fixtures';
import { adaptiveRough } from '../../cam3d/strategies/adaptiveRough';

const STOCK_XY = 60;
const STOCK_Z = 6;
const PART_Z = 5;
const CELL = 0.79;
const CUTTER: CutterSpec = { kind: 'flat', diameter: 9.52 };

describe.skipIf(!process.env.WO1252_RUNS)('WO-1252 sustained-run probe', () => {
  let kernel: BvhKernel;
  beforeAll(async () => { await ensureGeom2dReady(); await ensureEngineClipperReady(); kernel = new BvhKernel(); });
  for (const ringWidth of [10, 15]) {
    for (const sideEntry of [false, true]) {
      it(`ring ${ringWidth}mm sideEntry=${sideEntry}`, { timeout: 900000 }, async () => {
        const partXY = STOCK_XY - 2 * ringWidth;
        const mesh = bossInOpenStock({ x: STOCK_XY, y: STOCK_XY }, { x: partXY, y: partXY, z: PART_Z });
        const stockBounds: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: STOCK_XY, maxY: STOCK_XY, maxZ: STOCK_Z };
        const handle = kernel.uploadMesh(mesh);
        try {
          await adaptiveRough(kernel, {
            mesh: handle, cutter: CUTTER, stockBounds, stockBoundsAreRealStock: true, cellSize: CELL,
            maxStepdown: 3, stepover: 0.4, tolerance: 0.05, helixDiameter: 3,
            heights: { clearanceZ: STOCK_Z + 10, retractZ: STOCK_Z + 5, feedZ: STOCK_Z + 5 },
            materialTopZ: STOCK_Z, sideEntry,
          });
          // eslint-disable-next-line no-console
          console.log(`[WO-1252 probe] ring ${ringWidth} side=${sideEntry}: EMITTED (no refusal)`);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.log(`[WO-1252 probe] ring ${ringWidth} side=${sideEntry}: REFUSED ${(err as Error).message}`);
        } finally {
          kernel.releaseMesh(handle);
        }
      });
    }
  }
});
