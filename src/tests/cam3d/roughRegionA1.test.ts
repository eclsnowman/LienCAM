// Gate A1: per-level CUT REGION geometry core, proved against exact-analytic
// fixtures.
//
// The rougher slices a job top-down; at each Z level the region still to clear
// is (stock section) MINUS (part section). This gate proves that core:
//  - convert.ts round-trips ring <-> loop exactly.
//  - engagementPocket: the mid-level cut region area equals the analytic H-
//    minus-island footprint (2360 mm^2), empties above the block top and below
//    the pocket floor, and decomposes into ONE component with the island hole.
//  - hemisphereOnSlab: the part section on a CURVED surface matches the analytic
//    disc area pi*r(h)^2 (validates buildPartHeightField + remainingAbove), and
//    the cut region is its stock complement.
//  - determinism: identical inputs -> byte-identical rings.
//
// Alignment is load-bearing: a HALF-CELL systematic area bias would mean the
// part grid is off from the stock grid. The tolerances below are the block-
// trace discretization bound (perimeter * cell * sqrt(2)), NOT slack to hide a
// real offset -- the engagement fixture's straight edges align to cell
// boundaries so its area comes out essentially exact.

import { describe, it, expect, beforeAll } from 'vitest';

import { ZDexelField, remainingAbove, type Box3 } from '../../cam3d/stock';
import { ensureGeom2dReady, netArea, area, type Ring } from '../../cam3d/geom2d';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { PartMesh } from '../../cam3d/kernel/types';
import {
  engagementPocket,
  engagementPocketFootprintArea,
  ENGAGEMENT_POCKET_BOUNDARIES,
  hemisphereOnSlab,
  hemisphereDiscRadiusAt,
} from '../../cam3d/fixtures';
import {
  ringToLoop,
  loopToRing,
  tupleLoopToRing,
  ringsToLoops,
  loopsToRings,
  planLevels,
  buildPartHeightField,
  frameOf,
  cutRegionAt,
  decomposeToComponents,
} from '../../cam3d/rough';

const CELL = 0.5;

let kernel: BvhKernel;

beforeAll(async () => {
  await ensureGeom2dReady();
  kernel = new BvhKernel();
});

function boxOf(mesh: PartMesh): Box3 {
  const { min, max } = mesh.bounds;
  return { minX: min[0], minY: min[1], minZ: min[2], maxX: max[0], maxY: max[1], maxZ: max[2] };
}

/** Build the part heightfield aligned to a stock field's grid. */
async function partFieldFor(mesh: PartMesh, stock: ZDexelField): Promise<ZDexelField> {
  const m = kernel.uploadMesh(mesh);
  try {
    return await buildPartHeightField(kernel, m, frameOf(stock), {
      zSeed: mesh.bounds.min[2] - 1, // below stock bottom: misses read as empty
    });
  } finally {
    kernel.releaseMesh(m);
  }
}

/** Byte-identity across two ring sets (raw f64 buffer compare). */
function assertRingsByteIdentical(a: Ring[], b: Ring[], label: string): void {
  expect(b.length).toBe(a.length);
  for (let r = 0; r < a.length; r++) {
    expect(b[r].length).toBe(a[r].length);
    for (let k = 0; k < a[r].length; k++) {
      if (!Object.is(a[r][k], b[r][k])) {
        throw new Error(`${label}: ring ${r} differs at ${k} (${a[r][k]} vs ${b[r][k]}).`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
describe('Gate A1: convert.ts round-trips', () => {
  it('ringToLoop / loopToRing is an exact identity', () => {
    const ring = Float64Array.from([0, 0, 10, 0, 10, 5, 3, 7]);
    const loop = ringToLoop(ring);
    expect(loop).toEqual([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 5 },
      { x: 3, y: 7 },
    ]);
    const back = loopToRing(loop);
    expect(back.length).toBe(ring.length);
    for (let k = 0; k < ring.length; k++) expect(back[k]).toBe(ring[k]);
  });

  it('tupleLoopToRing flattens [x,y][] and round-trips through ringsToLoops', () => {
    const ring = tupleLoopToRing(ENGAGEMENT_POCKET_BOUNDARIES.outer);
    expect(ring.length).toBe(ENGAGEMENT_POCKET_BOUNDARIES.outer.length * 2);
    expect(area(ring)).toBeCloseTo(2460, 9); // CCW H outline
    const loops = ringsToLoops([ring]);
    const back = loopsToRings(loops);
    for (let k = 0; k < ring.length; k++) expect(back[0][k]).toBe(ring[k]);
  });

  it('fails loud on malformed input', () => {
    expect(() => ringToLoop(Float64Array.from([0, 0, 1]))).toThrow(); // odd length
    expect(() => ringToLoop(Float64Array.from([0, 0, 1, 1]))).toThrow(); // < 3 points
    expect(() => loopToRing([{ x: 0, y: 0 }, { x: 1, y: NaN }, { x: 2, y: 2 }])).toThrow();
  });
});

// ---------------------------------------------------------------------------
describe('Gate A1: planLevels', () => {
  it('even steps top-down, last level exactly the floor, step <= max', () => {
    const levels = planLevels(16, 4, 3);
    expect(levels.length).toBe(4); // ceil(12/3)
    expect(levels[levels.length - 1]).toBe(4);
    let prev = 16;
    for (const z of levels) {
      expect(z).toBeLessThan(prev);
      expect(prev - z).toBeLessThanOrEqual(3 + 1e-9);
      prev = z;
    }
    expect(planLevels(16, 4, 3)).toEqual(levels); // deterministic
  });

  it('fails loud on bad inputs', () => {
    expect(() => planLevels(4, 16, 3)).toThrow(); // floor above top
    expect(() => planLevels(16, 4, 0)).toThrow(); // non-positive step
  });
});

// ---------------------------------------------------------------------------
describe('Gate A1: engagementPocket cut regions', () => {
  const mesh = engagementPocket();
  const analytic = engagementPocketFootprintArea(); // 2360

  it('mid-level cut region area == analytic H-minus-island footprint', async () => {
    const stock = ZDexelField.fromBox(boxOf(mesh), CELL);
    const part = await partFieldFor(mesh, stock);
    const z = 10; // in (floor 4, top 16)
    const cut = await cutRegionAt(stock, part, z);
    const measured = netArea(cut);
    // Straight edges align to 0.5 cell boundaries -> essentially exact.
    const tol = 0.01 * analytic;
    console.log(
      `A1 engagement z=${z}: cut netArea ${measured.toFixed(3)} mm^2 vs analytic ` +
        `${analytic} (err ${Math.abs(measured - analytic).toFixed(4)}, tol ${tol.toFixed(1)})`,
    );
    expect(Math.abs(measured - analytic)).toBeLessThanOrEqual(tol);
  });

  it('empty above the block top; empty below the pocket floor', async () => {
    const stock = ZDexelField.fromBox(boxOf(mesh), CELL);
    const part = await partFieldFor(mesh, stock);
    // Above z=16: stock section itself is empty -> nothing to cut.
    const above = await cutRegionAt(stock, part, 16.001);
    expect(above.length).toBe(0);
    // Below z=4 the part is solid everywhere (block is full below the floor),
    // so it fills the stock section: empty cut region.
    const below = await cutRegionAt(stock, part, 2);
    expect(netArea(below)).toBeCloseTo(0, 6);
  });

  it('decomposes into one component with the island as a hole', async () => {
    const stock = ZDexelField.fromBox(boxOf(mesh), CELL);
    const part = await partFieldFor(mesh, stock);
    const cut = await cutRegionAt(stock, part, 10);
    const comps = decomposeToComponents(cut);
    expect(comps.length).toBe(1);
    expect(comps[0].holes.length).toBe(1);
    expect(area(comps[0].boundary)).toBeCloseTo(2460, 0); // H outer
    expect(Math.abs(area(comps[0].holes[0]))).toBeCloseTo(100, 0); // island
  });

  it('is deterministic: identical inputs -> byte-identical rings', async () => {
    const stock = ZDexelField.fromBox(boxOf(mesh), CELL);
    const part = await partFieldFor(mesh, stock);
    const a = await cutRegionAt(stock, part, 10);
    const b = await cutRegionAt(stock, part, 10);
    assertRingsByteIdentical(a, b, 'engagement cut z=10');
  });
});

// ---------------------------------------------------------------------------
describe('Gate A1: hemisphereOnSlab curved part section', () => {
  const R = 20;
  const SLAB_T = 10;
  const mesh = hemisphereOnSlab(R, { x: 100, y: 100, t: SLAB_T });
  const STOCK_AREA = 100 * 100;

  it('part section area == pi*r(h)^2 on the dome; cut is the complement', async () => {
    const stock = ZDexelField.fromBox(boxOf(mesh), CELL);
    const part = await partFieldFor(mesh, stock);

    for (const h of [3, 6, 9, 12]) {
      const z = SLAB_T + h;
      const discR = hemisphereDiscRadiusAt(R, h);
      const expected = Math.PI * discR * discR;
      // remainingAbove(part, z) traces the dome disc directly.
      const partSecArea = netArea(remainingAbove(part, z));
      // Block-trace discretization bound: boundary crosses ~perimeter/cell
      // cells, each at most cell^2 -> |err| <= perimeter*cell*sqrt(2). Plus a
      // small facet allowance for the 64x16-faceted dome.
      const perim = 2 * Math.PI * discR;
      const tol = perim * CELL * Math.SQRT2 + 0.02 * expected;
      console.log(
        `A1 hemi h=${h}: part disc area ${partSecArea.toFixed(2)} vs pi*r^2 ${expected.toFixed(2)} ` +
          `(err ${Math.abs(partSecArea - expected).toFixed(2)}, tol ${tol.toFixed(2)})`,
      );
      expect(Math.abs(partSecArea - expected)).toBeLessThanOrEqual(tol);

      // Cut region = stock (full 10000) minus the dome disc: exact complement.
      const cut = await cutRegionAt(stock, part, z);
      expect(netArea(cut)).toBeCloseTo(STOCK_AREA - partSecArea, 3);

      // Structure: one outer (the stock square) with the dome disc as a hole.
      const comps = decomposeToComponents(cut);
      expect(comps.length).toBe(1);
      expect(comps[0].holes.length).toBe(1);
    }
  });
});
