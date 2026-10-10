// WO-101: a roughing pass must cut the REMAINDER, not stop at the last full
// stepdown.
//
// Operator's report (Adaptive_Clearing_Potential_Crash.camproject, 80x80x14 part in
// 100x100x15 stock, axial stock-to-leave 0): the pocket showed three toolpath
// rings stepping down the wall and then a clear vertical gap between the lowest
// ring and the actual floor, and the 1 mm of stock over the part's top face was
// never touched.
//
// ROOT CAUSE (see criticalDepths.ts): the depth ladder is NOT a
// `while (remaining >= stepdown)` loop -- planLevels already lands its last
// level exactly on the global floor. The defect is that the GLOBAL floor is the
// only depth the ladder pins. Every OTHER horizontal part surface -- a pocket
// floor above the global floor, the part's own top face below the stock top --
// gets no level of its own, so the cut region for that surface is only ever
// visited at the nearest level ABOVE it and a remainder thinner than one full
// stepdown is silently left on it. One mechanism, both of Operator's symptoms.
//
// The fixture below is Operator's part scaled down so the gate runs in seconds:
// a 20x20x14 block with a 10x10 pocket 10 mm deep (floor z=4) sitting in
// 28x28x15 stock -- 1 mm of skim over the top face, a 4 mm border of stock in
// XY (which is what drives the global floor down to the stock bottom, z=0, and
// therefore leaves the pocket floor unpinned). With maxStepdown 3 the OLD
// ladder was 12, 9, 6, 3, 0: three rings in the pocket (12, 9, 6) and then a
// 2 mm gap to the floor at 4 -- exactly the screenshot.

import { describe, it, expect, beforeAll } from 'vitest';

import { ZDexelField, removeSweep, type Box3, type LinearMove } from '../../cam3d/stock';
import { ensureGeom2dReady } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { CutterSpec } from '../../cam3d/kernel/types';
import { pocketBox, hemisphereOnSlab } from '../../cam3d/fixtures';
import { planLevels, findCriticalDepths, frameOf, buildPartHeightField } from '../../cam3d/rough';
import { adaptiveRough, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import type { ToolpathIR } from '../../cam3d/ir/types';

let kernel: BvhKernel;

beforeAll(async () => {
  await ensureGeom2dReady();
  await ensureEngineClipperReady();
  kernel = new BvhKernel();
});

// --- Operator's geometry, scaled --------------------------------------------------
const PART = { x: 20, y: 20, z: 14 } as const;
const POCKET = { x: 10, y: 10, depth: 10 } as const;
const POCKET_FLOOR_Z = PART.z - POCKET.depth; // 4
const TOP_FACE_Z = PART.z; // 14
const MARGIN_XY = 4; // stock border around the part, mm
const STOCK_TOP_Z = 15; // 1 mm of skim over the part top face
const CELL = 0.5;
const MAX_STEPDOWN = 3;
const CUTTER: CutterSpec = { kind: 'flat', diameter: 3 };

/** Replay every IR move as a tool-tip removeSweep onto a fresh stock box. */
function replayToField(ir: ToolpathIR, bounds: Box3, cell: number, cutter: CutterSpec): ZDexelField {
  const field = ZDexelField.fromBox(bounds, cell);
  let prev: { x: number; y: number; z: number } | null = null;
  for (const m of ir.moves) {
    if (prev !== null) {
      const sweep: LinearMove = { x0: prev.x, y0: prev.y, z0: prev.z, x1: m.x, y1: m.y, z1: m.z };
      removeSweep(field, sweep, cutter);
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  return field;
}

async function roughGeometry(opts: {
  part: { x: number; y: number; z: number };
  pocket: { x: number; y: number; depth: number };
  stockTopZ: number;
  axialStockToLeave: number;
}): Promise<{ ir: ToolpathIR; carved: ZDexelField; stock: Box3; pins: number[] }> {
  const mesh = pocketBox({ ...opts.part }, { ...opts.pocket });
  const stock: Box3 = {
    minX: -MARGIN_XY,
    minY: -MARGIN_XY,
    minZ: 0,
    maxX: opts.part.x + MARGIN_XY,
    maxY: opts.part.y + MARGIN_XY,
    maxZ: opts.stockTopZ,
  };
  const handle = kernel.uploadMesh(mesh);
  try {
    const input: AdaptiveRoughInput = {
      mesh: handle,
      cutter: CUTTER,
      stockBounds: stock,
      cellSize: CELL,
      maxStepdown: MAX_STEPDOWN,
      stepover: 0.4,
      tolerance: 0.1,
      helixDiameter: 2,
      axialStockToLeave: opts.axialStockToLeave,
      materialTopZ: opts.stockTopZ,
      stockBoundsAreRealStock: true,
      sideEntry: true,
      heights: { clearanceZ: opts.stockTopZ + 5, retractZ: opts.stockTopZ + 1, feedZ: opts.stockTopZ + 1 },
    };
    const ir = await adaptiveRough(kernel, input);
    // The pins the strategy itself derives, recomputed here from the same part
    // field so a test can name them (floorZ comes back in the IR meta).
    const stockField = ZDexelField.fromBox(stock, CELL);
    const part = await buildPartHeightField(kernel, handle, frameOf(stockField), { zSeed: -1 });
    const pins = findCriticalDepths(part, {
      stockTopZ: stock.maxZ,
      floorZ: ir.meta.params?.floorZ as number,
      axialStockToLeave: opts.axialStockToLeave,
      minFlatArea: Math.PI * TOOL_R * TOOL_R,
    });
    return { ir, carved: replayToField(ir, stock, CELL, CUTTER), stock, pins };
  } finally {
    kernel.releaseMesh(handle);
  }
}

async function roughIt(axialStockToLeave: number): Promise<{ ir: ToolpathIR; carved: ZDexelField }> {
  return roughGeometry({ part: PART, pocket: POCKET, stockTopZ: STOCK_TOP_Z, axialStockToLeave });
}

/**
 * Worst (highest) carved top over the columns whose CENTER lies in the given
 * world-XY rectangle -- i.e. the shallowest point of the cut over that face.
 * Inset the rectangle from the real face edges by the tool radius so the sample
 * only covers ground the tool can physically reach.
 */
function worstTopOver(
  field: ZDexelField,
  rect: { x0: number; x1: number; y0: number; y1: number },
): { worst: number; best: number; count: number } {
  let worst = -Infinity;
  let best = Infinity;
  let count = 0;
  for (let j = 0; j < field.ny; j++) {
    const y = field.centerY(j);
    if (y < rect.y0 || y > rect.y1) continue;
    for (let i = 0; i < field.nx; i++) {
      const x = field.centerX(i);
      if (x < rect.x0 || x > rect.x1) continue;
      const t = field.top[field.colIndex(i, j)];
      if (t > worst) worst = t;
      if (t < best) best = t;
      count++;
    }
  }
  return { worst, best, count };
}

/**
 * A synthetic part heightfield with named rectangular horizontal faces -- the
 * detector's own unit under test, with no mesh sampling in the way.
 * `solidTo` (default: the base, i.e. EMPTY) is the top of the surrounding
 * material, so a face can be tested both standing in open air and as a boss
 * proud of a solid floor.
 */
function fieldWithPlateaus(opts: {
  nx: number;
  ny: number;
  cell: number;
  base: number;
  solidTo?: number;
  plateaus: ReadonlyArray<{ i0: number; j0: number; w: number; h: number; z: number }>;
}): ZDexelField {
  const tops = new Float32Array(opts.nx * opts.ny).fill(opts.solidTo ?? opts.base);
  for (const p of opts.plateaus) {
    for (let j = p.j0; j < p.j0 + p.h; j++) {
      for (let i = p.i0; i < p.i0 + p.w; i++) tops[j * opts.nx + i] = p.z;
    }
  }
  return ZDexelField.fromColumnTops(
    { originX: 0, originY: 0, nx: opts.nx, ny: opts.ny, cell: opts.cell },
    tops,
    opts.base,
  );
}

const TOOL_R = CUTTER.diameter / 2;
/** Pocket floor interior, inset by the tool radius + a cell of grid slop. */
const POCKET_INTERIOR = {
  x0: (PART.x - POCKET.x) / 2 + TOOL_R + CELL,
  x1: (PART.x + POCKET.x) / 2 - TOOL_R - CELL,
  y0: (PART.y - POCKET.y) / 2 + TOOL_R + CELL,
  y1: (PART.y + POCKET.y) / 2 - TOOL_R - CELL,
};
/** A strip of the part's TOP FACE (between the pocket wall and the part wall). */
const TOP_FACE_STRIP = {
  x0: TOOL_R + CELL,
  x1: (PART.x - POCKET.x) / 2 - TOOL_R - CELL,
  y0: TOOL_R + CELL,
  y1: PART.y - TOOL_R - CELL,
};

// ---------------------------------------------------------------------------
describe('WO-101: the remainder below the last full stepdown is cut', () => {
  it('reaches the pocket floor with axial stock-to-leave 0', { timeout: 180000 }, async () => {
    const { ir, carved } = await roughIt(0);
    const floor = worstTopOver(carved, POCKET_INTERIOR);

    console.log(
      `WO-101 floor: levelCount ${ir.meta.params?.levelCount} floorZ ${ir.meta.params?.floorZ}; ` +
        `pocket interior (${floor.count} cols) deepest carved Z ${floor.worst.toFixed(3)} ` +
        `(shallowest point of the cut); target floor ${POCKET_FLOOR_Z}`,
    );

    expect(floor.count).toBeGreaterThan(20);
    // Stock-to-leave 0 means ZERO: every reachable column of the pocket floor is
    // cut to the floor, not to the last whole stepdown above it. One cell of
    // z-dexel discretization is the only allowance.
    expect(floor.worst).toBeLessThanOrEqual(POCKET_FLOOR_Z + CELL);
  });

  it('removes the 1 mm skim over the part top face', { timeout: 180000 }, async () => {
    const { carved } = await roughIt(0);
    const face = worstTopOver(carved, TOP_FACE_STRIP);

    console.log(
      `WO-101 top skim: top-face strip (${face.count} cols) shallowest carved Z ` +
        `${face.worst.toFixed(3)}, deepest ${face.best.toFixed(3)}; stock top ${STOCK_TOP_Z}, ` +
        `part top face ${TOP_FACE_Z}`,
    );

    expect(face.count).toBeGreaterThan(20);
    expect(face.worst).toBeLessThanOrEqual(TOP_FACE_Z + CELL);
  });

  it('honours axial stock-to-leave: the pocket floor keeps exactly that skin', { timeout: 180000 }, async () => {
    const S = 1.0;
    const { ir, carved } = await roughIt(S);
    const floor = worstTopOver(carved, POCKET_INTERIOR);

    console.log(
      `WO-101 axial S=${S}: floorZ ${ir.meta.params?.floorZ}; pocket interior deepest carved Z ` +
        `${floor.worst.toFixed(3)} / ${floor.best.toFixed(3)}; target ${POCKET_FLOOR_Z + S}`,
    );

    // Cut down to floor+S, and NOT past it (no silently deepened pass).
    expect(floor.worst).toBeLessThanOrEqual(POCKET_FLOOR_Z + S + CELL);
    expect(floor.best).toBeGreaterThanOrEqual(POCKET_FLOOR_Z + S - CELL);
  });
});

// ---------------------------------------------------------------------------
// CONTROL: the fix must add NOTHING when the depths already divide evenly.
// ---------------------------------------------------------------------------

describe('WO-101 control: an evenly-dividing job gains no redundant pass', () => {
  it('planLevels is unchanged by pins that coincide with natural levels', () => {
    const plain = planLevels(15, 0, 3);
    expect(plain).toEqual([12, 9, 6, 3, 0]);

    // A pin ON a natural level ends its segment instead of adding one.
    expect(planLevels(15, 0, 3, [12])).toEqual(plain);
    expect(planLevels(15, 0, 3, [12, 6, 3])).toEqual(plain);
    // Pins at (or outside) the ends are already hit exactly -- no level either.
    expect(planLevels(15, 0, 3, [15, 0, 99, -4])).toEqual(plain);
    // Duplicated pins collapse to one.
    expect(planLevels(15, 0, 3, [6, 6, 6])).toEqual(plain);
    // Absent pins are byte-identical to the 3-argument form.
    expect(planLevels(16, 4, 3, [])).toEqual(planLevels(16, 4, 3));
  });

  it('planLevels lands on off-grid pins without exceeding the stepdown', () => {
    // Operator's ladder: stock top 15, floor 0, pins at the top face (14) and the
    // pocket floor (4). Old ladder was [12, 9, 6, 3, 0] -- it stepped over both.
    const levels = planLevels(15, 0, 3, [14, 4]);
    expect(levels).toEqual([14, 11.5, 9, 6.5, 4, 2, 0]);
    expect(levels).toContain(14);
    expect(levels).toContain(4);

    let prev = 15;
    for (const z of levels) {
      expect(z).toBeLessThan(prev); // strictly descending: no duplicate/zero pass
      expect(prev - z).toBeLessThanOrEqual(3 + 1e-9); // no silently deepened pass
      prev = z;
    }
    expect(planLevels(15, 0, 3, [14, 4])).toEqual(levels); // deterministic
  });

  it('fails loud on a non-finite required depth', () => {
    expect(() => planLevels(15, 0, 3, [Number.NaN])).toThrow();
  });

  it('never returns an empty ladder, however shallow the job or the pin', () => {
    const floor = 15 - 1e-9;
    expect(planLevels(15, floor, 3)).toEqual([floor]); // one shallow pass, as before
    // A pin a nanometre off the floor snaps ONTO it: no zero-depth segment.
    expect(planLevels(15, 0, 3, [1e-9])).toEqual([12, 9, 6, 3, 0]);
    expect(planLevels(15, floor, 3, [15 - 5e-10])).toEqual([floor]);
  });

  it('end to end: a pocket floor already on a level adds no level', { timeout: 180000 }, async () => {
    // Part top 12 = stock top (no skim) and pocket floor 6 -- both land exactly
    // on the natural ladder [9, 6, 3, 0], so the pinned ladder must be identical.
    const part = { x: 20, y: 20, z: 12 };
    const pocket = { x: 10, y: 10, depth: 6 };
    const floorOfPocket = part.z - pocket.depth; // 6
    const { ir, carved, pins } = await roughGeometry({
      part,
      pocket,
      stockTopZ: part.z,
      axialStockToLeave: 0,
    });

    const naturalLevels = planLevels(part.z, ir.meta.params?.floorZ as number, MAX_STEPDOWN);
    // Level-plane cutting only: helix/ramp entries descend continuously, so
    // their Z values are not level planes.
    const cutZ = [...new Set(ir.moves.filter((m) => m.role === 'cut').map((m) => m.z))].sort((a, b) => b - a);

    console.log(
      `WO-101 control: floorZ ${ir.meta.params?.floorZ} levelCount ${ir.meta.params?.levelCount} ` +
        `(natural ladder ${naturalLevels.length}: ${naturalLevels.join(', ')}); critical depths ` +
        `[${pins.join(', ')}]; distinct cut-role Z in the IR: [${cutZ.join(', ')}]`,
    );

    // The pocket floor IS a critical depth here -- and it changes nothing.
    expect(pins).toContain(floorOfPocket);
    expect(ir.meta.params?.levelCount).toBe(naturalLevels.length);
    expect(cutZ.length).toBeLessThanOrEqual(naturalLevels.length);
    for (const z of cutZ) expect(naturalLevels).toContain(z); // no extra plane

    // ...and the pocket floor is still reached (it was, before and after).
    const rect = {
      x0: (part.x - pocket.x) / 2 + TOOL_R + CELL,
      x1: (part.x + pocket.x) / 2 - TOOL_R - CELL,
      y0: (part.y - pocket.y) / 2 + TOOL_R + CELL,
      y1: (part.y + pocket.y) / 2 - TOOL_R - CELL,
    };
    const floor = worstTopOver(carved, rect);
    expect(floor.worst).toBeLessThanOrEqual(floorOfPocket + CELL);
  });

  it('a DOME mints no critical depth, however many columns share a height', async () => {
    // The trap this test exists for: on a sphere sampled over a square grid,
    // 8-fold symmetry puts eight SCATTERED columns at bit-identical heights.
    // An area-only flat test read each of those orbits as a flat face and
    // planned 35 levels here instead of 5. A flat must be locally HORIZONTAL.
    const mesh = hemisphereOnSlab(20, { x: 100, y: 100, t: 10 });
    const bounds: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 100, maxY: 100, maxZ: 30 };
    const handle = kernel.uploadMesh(mesh);
    try {
      const field = ZDexelField.fromBox(bounds, 1.0);
      const part = await buildPartHeightField(kernel, handle, frameOf(field), { zSeed: -1 });
      const pins = findCriticalDepths(part, {
        stockTopZ: 30,
        floorZ: 10, // the slab top -- the ladder already lands there
        minFlatArea: Math.PI * TOOL_R * TOOL_R,
      });
      console.log(`WO-101 dome: critical depths on hemisphereOnSlab = [${pins.join(', ')}]`);
      expect(pins).toEqual([]);
      expect(planLevels(30, 10, 4, pins)).toEqual(planLevels(30, 10, 4)); // ladder unchanged
      // The slab top IS a real flat -- it just coincides with the floor above.
      // Drop the floor below it and it must be found, proving the detector is
      // not simply blind.
      expect(findCriticalDepths(part, {
        stockTopZ: 30,
        floorZ: 0,
        minFlatArea: Math.PI * TOOL_R * TOOL_R,
      })).toEqual([10]);
    } finally {
      kernel.releaseMesh(handle);
    }
  });

  it('a small but tool-sized face still earns its level (no erosion under-count)', () => {
    // AUDIT finding 1. A 4 x 4 mm face on a 1 mm grid is 16 mm^2 -- more than
    // twice the 3 mm cutter's 7.0686 mm^2 cross-section, so the cutter stands on
    // it comfortably. Judging the face by its ERODED interior (2 x 2 = 4 mm^2)
    // rejected it, and the ladder [6.667, 3.333, 0] then stepped straight over
    // z=5, leaving exactly the sub-stepdown remainder this WO forbids.
    const FACE_MM = 4;
    const cutterArea = Math.PI * TOOL_R * TOOL_R;

    // (a) the face stands in open air (its neighbours are empty columns).
    const inAir = fieldWithPlateaus({
      nx: 20,
      ny: 20,
      cell: 1,
      base: 0,
      plateaus: [{ i0: 8, j0: 8, w: FACE_MM, h: FACE_MM, z: 5 }],
    });
    const pinsAir = findCriticalDepths(inAir, { stockTopZ: 10, floorZ: 0, minFlatArea: cutterArea });

    // (b) the same face as a boss standing 3 mm proud of a SOLID floor at z=2 --
    // every neighbour carries material, so nothing about the border is "air".
    const onFloor = fieldWithPlateaus({
      nx: 20,
      ny: 20,
      cell: 1,
      base: 0,
      solidTo: 2,
      plateaus: [{ i0: 8, j0: 8, w: FACE_MM, h: FACE_MM, z: 5 }],
    });
    const pinsFloor = findCriticalDepths(onFloor, { stockTopZ: 10, floorZ: 0, minFlatArea: cutterArea });

    console.log(
      `WO-101 small face: ${FACE_MM}x${FACE_MM} mm face = ${FACE_MM * FACE_MM} mm^2 vs cutter ` +
        `cross-section ${cutterArea.toFixed(4)} mm^2; pins in air [${pinsAir.join(', ')}], ` +
        `pins as a boss on a solid floor [${pinsFloor.join(', ')}]; ` +
        `ladder with the air pin [${planLevels(10, 0, 4, pinsAir).join(', ')}], ` +
        `without any pin [${planLevels(10, 0, 4).join(', ')}]`,
    );

    expect(pinsAir).toEqual([5]);
    expect(pinsFloor).toContain(5); // plus the floor plane at z=2
    expect(planLevels(10, 0, 4, pinsAir)).toContain(5);

    // ...and the tool-size gate is still doing its job: a 2 x 2 mm face is
    // 4 mm^2, smaller than the cutter, so it earns nothing.
    const tooSmall = fieldWithPlateaus({
      nx: 20,
      ny: 20,
      cell: 1,
      base: 0,
      plateaus: [{ i0: 9, j0: 9, w: 2, h: 2, z: 5 }],
    });
    expect(findCriticalDepths(tooSmall, { stockTopZ: 10, floorZ: 0, minFlatArea: cutterArea })).toEqual([]);
  });

  it('pins EVERY qualifying face, past any fixed count', () => {
    // AUDIT finding 2. 33 separated 5 x 5 mm faces at z = 1..33, each 25 mm^2
    // (9 mm^2 even after the old one-cell erosion) against a 7.0686 mm^2 cutter.
    // A hard 32-pin cap kept the deepest 32 and silently dropped z=1, so that
    // face -- and only that face -- kept a sub-stepdown remainder.
    const COUNT = 33;
    const BLOCK = 5;
    const PITCH = BLOCK + 1; // one empty column between neighbouring faces
    const perRow = 6;
    const n = 1 + perRow * PITCH;
    const plateaus: Array<{ i0: number; j0: number; w: number; h: number; z: number }> = [];
    for (let k = 0; k < COUNT; k++) {
      plateaus.push({
        i0: 1 + (k % perRow) * PITCH,
        j0: 1 + Math.floor(k / perRow) * PITCH,
        w: BLOCK,
        h: BLOCK,
        z: k + 1, // 1 .. 33
      });
    }
    const field = fieldWithPlateaus({ nx: n, ny: n, cell: 1, base: 0, plateaus });
    const pins = findCriticalDepths(field, {
      stockTopZ: 40,
      floorZ: 0,
      minFlatArea: Math.PI * TOOL_R * TOOL_R,
    });
    const levels = planLevels(40, 0, 4, pins);

    console.log(
      `WO-101 many faces: ${COUNT} qualifying faces of ${BLOCK * BLOCK} mm^2 each; ` +
        `pins returned ${pins.length} [${pins.join(', ')}]; shallowest face z=1 pinned: ` +
        `${pins.includes(1)}; in the ladder: ${levels.includes(1)} (${levels.length} levels)`,
    );

    expect(pins.length).toBe(COUNT);
    const expected: number[] = [];
    for (let k = COUNT; k >= 1; k--) expected.push(k);
    expect(pins).toEqual(expected);
    expect(levels).toContain(1);
    // No pin is duplicated and none deepens a pass past the stepdown.
    let prev = 40;
    for (const z of levels) {
      expect(z).toBeLessThan(prev);
      expect(prev - z).toBeLessThanOrEqual(4 + 1e-9);
      prev = z;
    }
  });

  it('a curved surface contributes no critical depth (roughing still terraces)', async () => {
    // A dome's columns spread over thousands of height buckets, so no bucket
    // ever reaches the tool's cross-section: curves are a FINISHING concern and
    // must not multiply the ladder.
    const mesh = pocketBox({ x: 20, y: 20, z: 12 }, { x: 10, y: 10, depth: 6 });
    const bounds: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 20, maxY: 20, maxZ: 12 };
    const handle = kernel.uploadMesh(mesh);
    try {
      const field = ZDexelField.fromBox(bounds, CELL);
      const part = await buildPartHeightField(kernel, handle, frameOf(field), { zSeed: -1 });
      // Both flats are AT the ends here (top 12 = stock top, floor 6 = floorZ),
      // so nothing is pinned -- the ladder is byte-identical to today's.
      expect(findCriticalDepths(part, { stockTopZ: 12, floorZ: 6, minFlatArea: Math.PI * TOOL_R * TOOL_R })).toEqual([]);
      // A tiny minFlatArea would let noise in; the tool-sized threshold is what
      // keeps a 20x20 part down to its two real planes.
      const withFloorBelow = findCriticalDepths(part, {
        stockTopZ: 14,
        floorZ: 0,
        minFlatArea: Math.PI * TOOL_R * TOOL_R,
      });
      expect(withFloorBelow).toEqual([12, 6]); // exactly the two real flats
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});
