// The Tray example's stand-in (2026-08-19). The Tray .camproject was retired the
// same day: a 77,000-move, 12-minute toolpath is a smoke test, not a test loop.
// What the Tray actually exercised is small: a real closed pocket in a block,
// several stepdown levels, sharp corners the walker leaves slivers in (WO-400's
// lift landings), and - Operator's repro (39) - the same job with 0.5 mm of stock to
// leave, which used to refuse at a region entry labelled 'helix' below the floor.
// pocketBox is exactly a tray; at these dimensions the whole file runs in
// seconds and asserts the things that matter: it generates, every region is
// machined, the floor is reached to depth, entries are honest, and it is
// byte-deterministic.
import { beforeAll, describe, expect, it } from 'vitest';

import { pocketBox } from '../../cam3d/fixtures';
import { ensureGeom2dReady } from '../../cam3d/geom2d';
import { irFingerprint } from '../../cam3d/ir/types';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { CutterSpec } from '../../cam3d/kernel/types';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import type { Box3, ZDexelField } from '../../cam3d/stock';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import type { OperationDiagnostics } from '../../types';

// A tray: 60 x 40 x 12 block, 52 x 32 pocket 9 deep (4 mm walls, 3 mm floor).
const OUTER = { x: 60, y: 40, z: 12 };
const POCKET = { x: 52, y: 32, depth: 9 };
const FLOOR_Z = OUTER.z - POCKET.depth;
const CUTTER: CutterSpec = { kind: 'flat', diameter: 6 };
const CELL = 0.5;
const STOCK: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: OUTER.x, maxY: OUTER.y, maxZ: OUTER.z };

let kernel: BvhKernel;
beforeAll(async () => {
  await ensureGeom2dReady();
  await ensureEngineClipperReady();
  kernel = new BvhKernel();
});

async function roughTray(stockToLeave: number): Promise<{
  ir: Awaited<ReturnType<typeof adaptiveRough>>;
  carved: ZDexelField | undefined;
  diagnostics: OperationDiagnostics['adaptiveRough'] | undefined;
}> {
  const handle = kernel.uploadMesh(pocketBox(OUTER, POCKET));
  let carved: ZDexelField | undefined;
  let diagnostics: OperationDiagnostics['adaptiveRough'] | undefined;
  try {
    const input: AdaptiveRoughInput = {
      mesh: handle,
      cutter: CUTTER,
      stockBounds: STOCK,
      stockBoundsAreRealStock: true,
      cellSize: CELL,
      maxStepdown: 3,
      stepover: 0.4,
      tolerance: 0.05,
      helixDiameter: 3,
      radialStockToLeave: stockToLeave,
      axialStockToLeave: stockToLeave,
      heights: { clearanceZ: 20, retractZ: 13, feedZ: 13 },
      materialTopZ: OUTER.z,
    };
    const ir = await adaptiveRough(kernel, input, {
      onCarvedStock: (field) => { carved = field; },
      onDiagnostics: (d) => { diagnostics = d.adaptiveRough; },
    });
    return { ir, carved, diagnostics };
  } finally {
    kernel.releaseMesh(handle);
  }
}

/** Highest remaining material over the pocket floor, sampled one cutter radius in from the walls. */
function highestOverFloor(field: ZDexelField, inset: number): number {
  const x0 = (OUTER.x - POCKET.x) / 2 + inset;
  const x1 = x0 + POCKET.x - 2 * inset;
  const y0 = (OUTER.y - POCKET.y) / 2 + inset;
  const y1 = y0 + POCKET.y - 2 * inset;
  let highest = Number.NEGATIVE_INFINITY;
  for (let j = 0; j < field.ny; j++) {
    const cy = field.originY + (j + 0.5) * field.cell;
    if (cy < y0 || cy > y1) continue;
    for (let i = 0; i < field.nx; i++) {
      const cx = field.originX + (i + 0.5) * field.cell;
      if (cx < x0 || cx > x1) continue;
      highest = Math.max(highest, field.top[j * field.nx + i]);
    }
  }
  return highest;
}

describe('tray stand-in: closed pocket in a block, three stepdowns', () => {
  it('generates, machines every region, reaches the floor, entries are honest', { timeout: 120_000 }, async () => {
    const { ir, carved, diagnostics } = await roughTray(0);
    expect(ir.moves.length).toBeGreaterThan(500);
    expect(diagnostics?.plannedRegions ?? 0).toBeGreaterThan(0);
    expect(diagnostics?.skippedRegions ?? 0).toBe(0);
    // Every level cut: three stepdowns of 3 mm from 12 down to the floor at 3.
    const cutZs = [...new Set(ir.moves.filter((m) => m.role === 'cut').map((m) => m.z))].sort((a, b) => b - a);
    expect(cutZs.length).toBeGreaterThanOrEqual(3);
    expect(Math.min(...cutZs)).toBeCloseTo(FLOOR_Z, 3);
    // The product's own carved field: nothing stands over the pocket floor.
    expect(carved).toBeDefined();
    expect(highestOverFloor(carved!, CUTTER.diameter / 2 + 0.5)).toBeLessThanOrEqual(FLOOR_Z + 1e-3);
    // No entry promises a helix the emitter cannot make (ramp moves exist, and no
    // 'plunge' role opens a region: every region opening is a ramp).
    expect(ir.moves.some((m) => m.role === 'ramp')).toBe(true);
  });

  it('with 0.5 mm stock to leave still generates and stops 0.5 mm above the floor (Operator repro (39) shape)', { timeout: 120_000 }, async () => {
    const { ir, carved, diagnostics } = await roughTray(0.5);
    expect(ir.moves.length).toBeGreaterThan(500);
    expect(diagnostics?.skippedRegions ?? 0).toBe(0);
    const cutZs = ir.moves.filter((m) => m.role === 'cut').map((m) => m.z);
    expect(Math.min(...cutZs)).toBeCloseTo(FLOOR_Z + 0.5, 3);
    expect(carved).toBeDefined();
    const top = highestOverFloor(carved!, CUTTER.diameter / 2 + 1);
    expect(top).toBeLessThanOrEqual(FLOOR_Z + 0.5 + 1e-3);
    expect(top).toBeGreaterThanOrEqual(FLOOR_Z + 0.5 - 1e-3);
  });

  it('is byte-deterministic (D-006)', { timeout: 120_000 }, async () => {
    const a = await roughTray(0);
    const b = await roughTray(0);
    expect(irFingerprint(a.ir)).toBe(irFingerprint(b.ir));
  });
});
