// Gate C-1 -- STOCK-OUTLINE full-clear for the adaptive_3d 3D rougher.
//
// Diagnosed problem: the rougher sized its carve ZDexelField's XY extent to the
// PART MESH AABB, so stock OUTSIDE the part footprint was never modelled and
// could not be cleared -- the part was left trapped in a "packet". Stage C-1
// (OPT-IN, gated behind useStockBoundary) sizes the field's XY extent to the
// REAL stock footprint AABB instead, so the existing cutRegionAt (stock minus
// part) automatically clears out to the stock walls.
//
// This gate proves that at the STRATEGY / cutRegion layer -- exactly where the
// store's Stage C-1 change lands (it computes a bigger stock Box3 and passes it
// down; the strategy already builds its field from the passed stockBounds). The
// two modes are driven purely by the stockBounds Box3 handed to the strategy:
//   - "Part bounds"    -> stockBounds = part mesh AABB (today's default).
//   - "Stock outline"  -> stockBounds = the real stock footprint AABB (C-1).
//
// Fixture: a SMALL central dome-on-slab part (30 x 30 footprint) inside a much
// larger 60 x 60 rectangular stock, so there is a large stock border BEYOND the
// part AABB. We assert:
//   1. cutRegionAt netArea at a representative level jumps from ~(part-AABB minus
//      dome disc) to ~(stock-area minus dome disc): the border is now cut.
//   2. A full adaptiveRough run in each mode: the carved cleared plan-area at a
//      representative plane is SUBSTANTIALLY larger in stock-outline mode and
//      approximately (stock area - dome disc area); the part is NOT gouged; and
//      two stock-outline runs are byte-identical (D-006).

import { describe, it, expect, beforeAll } from 'vitest';

import {
  ZDexelField,
  removeSweep,
  type Box3,
} from '../../cam3d/stock';
import { ensureGeom2dReady, netArea } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import { forEachLinearSweep } from '../../cam3d/rough/replayStock';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { PartMesh, CutterSpec, MeshHandle } from '../../cam3d/kernel/types';
import { hemisphereOnSlab } from '../../cam3d/fixtures';
import { buildPartHeightField, frameOf, cutRegionAt } from '../../cam3d/rough';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import { irFingerprint, type ToolpathIR } from '../../cam3d/ir/types';

let kernel: BvhKernel;

beforeAll(async () => {
  await ensureGeom2dReady();
  await ensureEngineClipperReady();
  kernel = new BvhKernel();
});

// --- Fixture geometry --------------------------------------------------------
// Dome (r=12) on a 30 x 30 x 10 slab: part AABB is x[0,30] y[0,30] z[0,22],
// centred at (15,15). The stock is a 60 x 60 block CENTRED on the part, top at
// the part top: x[-15,45] y[-15,45] z[0,22]. Border area 3600 - 900 = 2700 mm^2
// sits BEYOND the part AABB -- the material C-1 must free.
const DOME_R = 8;
const SLAB = { x: 30, y: 30, t: 10 } as const;
const PART_CX = SLAB.x / 2; // 15
const PART_CY = SLAB.y / 2; // 15
const STOCK_TOP = SLAB.t + DOME_R; // 22
const STOCK_HALF = 30; // 60 x 60 stock
const PART_BOUNDS: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: SLAB.x, maxY: SLAB.y, maxZ: STOCK_TOP };
const STOCK_BOUNDS: Box3 = {
  minX: PART_CX - STOCK_HALF,
  minY: PART_CY - STOCK_HALF,
  minZ: 0,
  maxX: PART_CX + STOCK_HALF,
  maxY: PART_CY + STOCK_HALF,
  maxZ: STOCK_TOP,
};
const PART_AREA = SLAB.x * SLAB.y; // 900
const STOCK_AREA = (2 * STOCK_HALF) * (2 * STOCK_HALF); // 3600

// Representative level between the slab top (10) and the dome apex (22).
const Z_REP = 16;
// Dome cross-section radius at Z_REP: sqrt(r^2 - (z - slabTop)^2).
function domeDiscAreaAt(z: number): number {
  const h = z - SLAB.t;
  const rr = DOME_R * DOME_R - h * h;
  return rr > 0 ? Math.PI * rr : 0;
}

function mkMesh(): PartMesh {
  return hemisphereOnSlab(DOME_R, { x: SLAB.x, y: SLAB.y, t: SLAB.t });
}

async function partFieldFor(handle: MeshHandle, stock: ZDexelField, zSeed: number): Promise<ZDexelField> {
  return buildPartHeightField(kernel, handle, frameOf(stock), { zSeed });
}

/** Replay every IR move as a tool-tip removeSweep onto a fresh stock box. */
function replayToField(ir: ToolpathIR, bounds: Box3, cell: number, cutter: CutterSpec): ZDexelField {
  const field = ZDexelField.fromBox(bounds, cell);
  let prev: { x: number; y: number; z: number } | null = null;
  for (const m of ir.moves) {
    if (prev !== null) {
      // Follow emitted arcs. Their endpoint chord cuts through the retained
      // model even when the actual circular motion clears it.
      forEachLinearSweep(prev, m, 0.005, sweep => removeSweep(field, sweep, cutter));
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  return field;
}

// ---------------------------------------------------------------------------
describe('Gate C-1a: cutRegionAt sizes the cut region to the stock (not the part)', () => {
  it('netArea at a representative level jumps from ~(part-dome) to ~(stock-dome)', { timeout: 180000 }, async () => {
    const CELL = 0.5;
    const mesh = mkMesh();
    const handle = kernel.uploadMesh(mesh);
    try {
      // Part-bounds field: XY extent = part AABB (today's default path).
      const partStock = ZDexelField.fromBox(PART_BOUNDS, CELL);
      const partPart = await partFieldFor(handle, partStock, PART_BOUNDS.minZ - 1);
      const regionPart = await cutRegionAt(partStock, partPart, Z_REP, { radialStockToLeave: 0 });
      const areaPart = netArea(regionPart);

      // Stock-outline field: XY extent = real stock footprint AABB (Stage C-1).
      const outStock = ZDexelField.fromBox(STOCK_BOUNDS, CELL);
      const outPart = await partFieldFor(handle, outStock, STOCK_BOUNDS.minZ - 1);
      const regionOut = await cutRegionAt(outStock, outPart, Z_REP, { radialStockToLeave: 0 });
      const areaOut = netArea(regionOut);

      const disc = domeDiscAreaAt(Z_REP); // ~339.3 mm^2
      const expPart = PART_AREA - disc; // ~560.7
      const expStock = STOCK_AREA - disc; // ~3260.7

      // eslint-disable-next-line no-console
      console.log(
        `C-1a cutRegion netArea @z=${Z_REP}: part-bounds ${areaPart.toFixed(1)} (exp ~${expPart.toFixed(
          0,
        )}), stock-outline ${areaOut.toFixed(1)} (exp ~${expStock.toFixed(0)}); dome disc ${disc.toFixed(
          0,
        )} mm^2`,
      );

      // Part-bounds cut region ~ part footprint minus the dome disc (the packet).
      expect(Math.abs(areaPart - expPart)).toBeLessThanOrEqual(0.06 * PART_AREA);
      // Stock-outline cut region ~ full stock minus the dome disc: the border is cut.
      expect(Math.abs(areaOut - expStock)).toBeLessThanOrEqual(0.06 * STOCK_AREA);
      // And it is SUBSTANTIALLY larger (border removed, not a packet).
      expect(areaOut).toBeGreaterThan(4 * areaPart);
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});

// ---------------------------------------------------------------------------
describe('Gate C-1b: full rougher clears to the stock walls, preserves the part, deterministic', () => {
  const CELL = 0.75;
  // A 4 mm tool fits the flat slab-top annulus around the r=8 dome, so the
  // part-bounds run clears a REAL ring (a non-degenerate packet) to contrast
  // against the full-stock clear.
  const cutter: CutterSpec = { kind: 'flat', diameter: 4 };
  const TOL = 0.1;

  const inputFor = (bounds: Box3, handle: MeshHandle): AdaptiveRoughInput => ({
    mesh: handle,
    cutter,
    stockBounds: bounds,
    cellSize: CELL,
    // Finer than the full depth so the intermediate ring (slab top 10 -> stock
    // top 22) is cut in BOTH modes -- otherwise a single floor-level run leaves
    // the part-bounds ring uncut (a degenerate empty packet).
    maxStepdown: 4,
    stepover: 0.5,
    tolerance: TOL,
    helixDiameter: 3,
    heights: { clearanceZ: STOCK_TOP + 10, retractZ: STOCK_TOP + 2, feedZ: STOCK_TOP + 2 },
    materialTopZ: STOCK_TOP,
  });

  /** Cleared plan-area (mm^2) at Z_REP: columns whose final top dropped to <= Z_REP. */
  function clearedAreaToPlane(field: ZDexelField): number {
    let cols = 0;
    for (let c = 0; c < field.top.length; c++) if (field.top[c] <= Z_REP + 0.5) cols++;
    return cols * CELL * CELL;
  }

  it('stock-outline cleared area >> part-bounds; part not gouged; byte-identical (D-006)', { timeout: 300000 }, async () => {
    const mesh = mkMesh();

    // --- Part-bounds run (the packet) ---
    let clearedPart: number;
    {
      const handle = kernel.uploadMesh(mesh);
      try {
        const ir = await adaptiveRough(kernel, inputFor(PART_BOUNDS, handle));
        const fin = replayToField(ir, PART_BOUNDS, CELL, cutter);
        clearedPart = clearedAreaToPlane(fin);
      } finally {
        kernel.releaseMesh(handle);
      }
    }

    // --- Stock-outline run (full clear) + determinism + no-gouge ---
    let clearedOut: number;
    let fpA: string;
    let fpB: string;
    let movesA: number;
    let movesB: number;
    let maxGouge = -Infinity;
    {
      const handle = kernel.uploadMesh(mesh);
      try {
        const irA = await adaptiveRough(kernel, inputFor(STOCK_BOUNDS, handle));
        const irB = await adaptiveRough(kernel, inputFor(STOCK_BOUNDS, handle));
        fpA = irFingerprint(irA);
        fpB = irFingerprint(irB);
        movesA = irA.moves.length;
        movesB = irB.moves.length;

        const fin = replayToField(irA, STOCK_BOUNDS, CELL, cutter);
        clearedOut = clearedAreaToPlane(fin);

        // No-gouge: over EVERY column that has part, the carved top must not sit
        // below the part top by more than a discretization margin.
        const outStock = ZDexelField.fromBox(STOCK_BOUNDS, CELL);
        const part = await partFieldFor(handle, outStock, STOCK_BOUNDS.minZ - 1);
        for (let c = 0; c < fin.top.length; c++) {
          const hasPart = part.top[c] > part.bottom[c];
          if (!hasPart) continue;
          const g = part.top[c] - fin.top[c];
          if (g > maxGouge) maxGouge = g;
        }
      } finally {
        kernel.releaseMesh(handle);
      }
    }

    const disc = domeDiscAreaAt(Z_REP);
    const expStockClear = STOCK_AREA - disc; // ~3261

    // eslint-disable-next-line no-console
    console.log(
      `C-1b cleared@z=${Z_REP}: part-bounds ${clearedPart.toFixed(0)} mm^2, stock-outline ` +
        `${clearedOut.toFixed(0)} mm^2 (exp ~${expStockClear.toFixed(0)}); maxGouge ${maxGouge.toFixed(
          4,
        )} mm; movesA ${movesA} fp ${fpA}`,
    );

    // Border removed: stock-outline clears the whole block minus the dome disc.
    expect(Math.abs(clearedOut - expStockClear)).toBeLessThanOrEqual(0.1 * STOCK_AREA);
    // Substantially larger than the packet (border was previously untouched).
    expect(clearedOut).toBeGreaterThan(3 * clearedPart);
    // Part preserved: no gouge into the dome (discretization only, well below a
    // real plunge of several mm).
    expect(maxGouge).toBeLessThanOrEqual(0.6);
    // Determinism (D-006): two stock-outline generates are byte-identical.
    expect(fpB).toBe(fpA);
    expect(movesB).toBe(movesA);
  });
});
