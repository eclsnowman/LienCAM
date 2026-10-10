// Gate C3 -- HEADLESS proof that the 3D adaptive rougher returns a CARVED-stock
// field that reflects REAL material removal, and that it meshes to a non-empty
// display mesh (toMesh). Drives the strategy directly (strategies/adaptiveRough
// on a real BvhKernel) so the assertion is on the raw ZDexelField, no worker.
//
// What it proves:
//   1. onCarvedStock fires EXACTLY ONCE, with a ZDexelField.
//   2. toMesh(field) yields vertexCount > 0 && triangleCount > 0 (renderable).
//   3. The carved field has LESS material than the un-carved
//      ZDexelField.fromBox(stockBounds, cellSize): some columns are lowered
//      from the initial box top (removal actually happened) and the total
//      material volume dropped.

import { describe, expect, it } from 'vitest';

import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import { ZDexelField, toMesh } from '../../cam3d/stock';
import { engagementPocket } from '../../cam3d/fixtures';
import { stockBoundsFromMesh } from '../../cam3d/integration/adaptive3dOperation';

// Coarse-ish for a fast, deterministic gate. stepover is a FRACTION of tool
// diameter (the engagement knob); cellSize is passed explicitly so the fresh
// reference ZDexelField.fromBox below is built on the SAME grid the strategy used.
const CELL_SIZE = 1.0;

/** Total material volume (mm^3) of a z-dexel field: sum of (top-bottom)*cell^2. */
function materialVolume(field: ZDexelField): number {
  const { nx, ny, cell, top, bottom } = field;
  const cellArea = cell * cell;
  let v = 0;
  for (let c = 0; c < nx * ny; c++) {
    const h = top[c] - bottom[c];
    if (h > 0) v += h * cellArea;
  }
  return v;
}

describe('adaptive_3d gate C3: carved-stock field is returned and reflects removal', () => {
  it('engagementPocket carves material and meshes to a non-empty preview', { timeout: 180_000 }, async () => {
    const mesh = engagementPocket();
    const stockBounds = stockBoundsFromMesh(mesh);

    const kernel = new BvhKernel();
    const handle = kernel.uploadMesh(mesh);

    const top = mesh.bounds.max[2];
    const input: AdaptiveRoughInput = {
      mesh: handle,
      cutter: { kind: 'flat', diameter: 6 },
      stockBounds,
      cellSize: CELL_SIZE,
      maxStepdown: 3,
      stepover: 0.4,
      tolerance: 0.2,
      helixDiameter: 3,
      heights: { clearanceZ: top + 10, retractZ: top + 2, feedZ: top + 2 },
      materialTopZ: top,
    };

    let carved: ZDexelField | undefined;
    let carvedCalls = 0;
    const ir = await adaptiveRough(kernel, input, {
      onCarvedStock: (s) => {
        carvedCalls += 1;
        carved = s;
      },
    });
    kernel.releaseMesh(handle);

    // The toolpath (primary product) must still be produced.
    expect(ir.moves.length).toBeGreaterThan(0);

    // 1. Callback fired exactly once with a ZDexelField.
    expect(carvedCalls).toBe(1);
    expect(carved).toBeInstanceOf(ZDexelField);
    const carvedField = carved!;

    // 2. It meshes to a renderable, non-empty display mesh.
    const dm = toMesh(carvedField);
    expect(dm.vertexCount).toBeGreaterThan(0);
    expect(dm.triangleCount).toBeGreaterThan(0);
    expect(dm.positions.length).toBe(dm.vertexCount * 3);
    expect(dm.indices.length).toBe(dm.triangleCount * 3);

    // 3. Removal actually happened: compare against the un-carved box on the
    //    SAME grid. Some columns are lowered from the initial box top, and the
    //    total material volume dropped.
    const fresh = ZDexelField.fromBox(stockBounds, CELL_SIZE);
    expect(carvedField.nx).toBe(fresh.nx);
    expect(carvedField.ny).toBe(fresh.ny);

    let loweredColumns = 0;
    const EPS = 1e-4;
    for (let c = 0; c < fresh.nx * fresh.ny; c++) {
      if (carvedField.top[c] < fresh.top[c] - EPS) loweredColumns += 1;
    }
    expect(loweredColumns).toBeGreaterThan(0);

    const before = materialVolume(fresh);
    const after = materialVolume(carvedField);
    expect(after).toBeLessThan(before);

    // eslint-disable-next-line no-console
    console.log(
      `[gate C3] engagementPocket: ${loweredColumns} columns lowered, ` +
        `volume ${before.toFixed(0)} -> ${after.toFixed(0)} mm^3, ` +
        `preview ${dm.vertexCount} verts / ${dm.triangleCount} tris`,
    );
  });
});
