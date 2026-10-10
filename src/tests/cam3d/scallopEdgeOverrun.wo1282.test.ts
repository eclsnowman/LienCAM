// WO-1282: a scallop finish leaves the same edge fins Parallel Finish did.
//
// Scallop contains its geodesic distance field to a region and contours it, so
// in part-bounds mode the tool CENTRE stops on the part's bounding box and one
// radius of material is left outside the cut -- with a flat cutter on a surface
// sloping down toward the edge, a wedge up to R * slope tall. Same defect, same
// cause and (ADR-0015 s2, CONVENTIONS principle 0b) the same cure as WO-1271:
// let the centre travel one radius past the edge.
//
// WHY THIS IS NOT A COPY OF WO-1271. Parallel clips scanlines, so the overrun
// there is a SECOND region: the lattice stays anchored on the containment
// extent and interior passes are byte-identical. Scallop's geometry is a
// distance field whose seeds are the cutter-contact silhouette (WO-1281), and
// there is no lattice to anchor -- the region IS what the grid, the seeds and
// every contour level are derived from. So the overrun here is the containment
// region the adapter hands down, decided by the SAME shared function parallel
// uses (resolveStockEdgeOverrun), and the identity that can be promised is
// different. What these tests prove:
//
//   stockEdgeOvershoot: 0  -> byte-identical to the pre-WO-1282 toolpath
//                             (LEGACY_PART_BOUNDS_FINGERPRINT, recorded before
//                             the adapter was touched).
//   overrun on             -> NOT byte-identical, and no such claim is made:
//                             the grid resamples, so every contour moves. What
//                             IS promised and proven here is (a) the cut only
//                             ever GROWS outward, (b) no vertex sits further
//                             than one cutter radius plus a grid cell outside
//                             the part, whatever overshoot is asked for --
//                             because WO-1281's contact mask, not the overrun,
//                             is what bounds the band, (c) the tip never goes
//                             below the surface a drop cutter reports, so a
//                             model wall at the edge is never descended, and
//                             (d) it is still deterministic (D-006).

import { describe, expect, it, vi } from 'vitest';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { MeshHandle, PartMesh } from '../../cam3d/kernel/types';
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder';
import { steps } from '../../cam3d/fixtures';
import type { Ring } from '../../cam3d/geom2d';
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher';
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client';
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol';
import type { Tool, ToolpathMove } from '../../types';
import {
  STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM,
  xyBoundsRing,
  type ResolvedParallel3dHeights,
} from '../../cam3d/integration/parallel3dOperation';
import {
  computeScallop3dMoves,
  readScallop3dParams,
  type Scallop3dParams,
} from '../../cam3d/integration/scallop3dOperation';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const SIZE = 16;
const Z0 = 5;
const SLOPE = 0.5;
const FLAT6 = { kind: 'flat', diameter: 6 } as const;
const R = 3;
/** The auto overrun: one radius less the tangent margin. */
const OVERRUN = R - STOCK_EDGE_OVERRUN_TANGENT_MARGIN_MM;
const TOLERANCE = 0.25;

/**
 * A closed slab over [0,SIZE]^2 whose top is the plane z = Z0 + SLOPE * x and
 * whose four sides are VERTICAL WALLS down to z = 0. Two things at once:
 * a flat cutter centred on the x = 0 edge is held up by the higher material one
 * radius inside its footprint (tip at z(R), not z(0)) -- that gap IS the fin --
 * and the walls are model walls standing exactly on the containment edge the
 * overrun crosses, which is the ADR-0015 inverse case.
 */
function slopedSlab(n = 17): PartMesh {
  const b = new MeshBuilder();
  const top = (x: number, y: number): number => b.vertex(x, y, Z0 + SLOPE * x);
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const x0 = (SIZE * i) / (n - 1), x1 = (SIZE * (i + 1)) / (n - 1);
      const y0 = (SIZE * j) / (n - 1), y1 = (SIZE * (j + 1)) / (n - 1);
      b.quad(top(x0, y0), top(x1, y0), top(x1, y1), top(x0, y1));
    }
  }
  const c00 = b.vertex(0, 0, 0), c10 = b.vertex(SIZE, 0, 0);
  const c11 = b.vertex(SIZE, SIZE, 0), c01 = b.vertex(0, SIZE, 0);
  b.quad(c00, c01, c11, c10); // bottom (-Z)
  b.quad(c00, c10, top(SIZE, 0), top(0, 0)); // y = 0 wall
  b.quad(c10, c11, top(SIZE, SIZE), top(SIZE, 0)); // x = SIZE wall
  b.quad(c11, c01, top(0, SIZE), top(SIZE, SIZE)); // y = SIZE wall
  b.quad(c01, c00, top(0, 0), top(0, SIZE)); // x = 0 wall
  return b.build();
}

const SLAB = slopedSlab();

const FLAT_TOOL: Tool = {
  id: 'tool-flat6', name: 'flat d6', type: 'flat_end_mill', diameter: 6, fluteLength: 20,
  shankDiameter: 6, overallLength: 50, numberOfFlutes: 2, material: 'carbide', coating: 'none',
  notes: '', feedsAndSpeeds: {},
};

/**
 * feedZ sits just above the part top, as the height resolver puts it in the
 * app. It matters here: buildLinkedPath ramps into the first pass ALONG that
 * pass, so a feedZ ten millimetres above the surface spends the whole outermost
 * contour descending and books it as `lead_in` instead of `cut`. That would hide
 * the very pass this order adds.
 */
const SLAB_HEIGHTS: ResolvedParallel3dHeights = {
  clearanceZ: 20, retractZ: 15, feedZ: 14, topZ: Z0 + SLOPE * SIZE, bottomZ: 0,
};
const BASE_PARAMS: Scallop3dParams = {
  scallopHeight: 0.05, tolerance: TOLERANCE, stockToLeave: 0,
  useStockBoundary: false, direction: 'climb',
};

function makeClient(): Cam3dClient {
  const k = new BvhKernel();
  const fakeWorker: WorkerLike = {
    onmessage: null,
    onerror: null,
    postMessage(message: unknown): void {
      dispatcher.handle(message as Cam3dRequest);
    },
    terminate(): void {},
  };
  const dispatcher = new Cam3dDispatcher(k, (msg: Cam3dResponse) => {
    fakeWorker.onmessage?.({ data: msg } as MessageEvent);
  });
  return new Cam3dClient(fakeWorker);
}

async function compute(
  partMesh: PartMesh,
  params: Scallop3dParams,
  extra: {
    boundary?: readonly Ring[];
    boundaryKind?: 'stock' | 'selection';
    faceScope?: readonly number[];
    resolvedHeights?: ResolvedParallel3dHeights;
  } = {},
): Promise<ToolpathMove[]> {
  const { resolvedHeights = SLAB_HEIGHTS, ...rest } = extra;
  const { moves } = await computeScallop3dMoves({
    partMesh, tool: FLAT_TOOL, params, resolvedHeights, client: makeClient(), ...rest,
  });
  return moves;
}

function cuts(moves: readonly ToolpathMove[]): ToolpathMove[] {
  return moves.filter(m => m.role === 'cut');
}

function cutExtent(moves: readonly ToolpathMove[]): {
  minX: number; maxX: number; minY: number; maxY: number; minZ: number;
} {
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity;
  for (const m of cuts(moves)) {
    minX = Math.min(minX, m.x); maxX = Math.max(maxX, m.x);
    minY = Math.min(minY, m.y); maxY = Math.max(maxY, m.y);
    minZ = Math.min(minZ, m.z);
  }
  return { minX, maxX, minY, maxY, minZ };
}

/** FNV-1a over the canonical move list -- the same reduction irFingerprint uses. */
function movesFingerprint(moves: readonly ToolpathMove[]): string {
  const text = moves
    .map(m => `${m.type}|${m.role ?? ''}|${m.x}|${m.y}|${m.z}|${m.feed ?? ''}`)
    .join('\n');
  const MASK64 = 0xffffffffffffffffn;
  let h = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i++) {
    const cu = text.charCodeAt(i);
    h = ((h ^ BigInt(cu & 0xff)) * 0x100000001b3n) & MASK64;
    h = ((h ^ BigInt(cu >>> 8)) * 0x100000001b3n) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

/**
 * Recorded on this branch BEFORE the adapter learned the overrun: the
 * part-bounds toolpath every scallop op shipped so far. `stockEdgeOvershoot: 0`
 * must still reproduce it exactly.
 *
 * WO-2209 (2026-09-29) repinned it, 13089d6949a0d9f5 / 770 cuts ->
 * fe8e731540fd7363 / 854: the shared link builder now ramps every Feed Height
 * entry back onto the pass start and cuts the pass whole, so the 84 samples the
 * old ramps rode over are cut moves now. The adapter is untouched.
 */
const LEGACY_PART_BOUNDS_FINGERPRINT = 'fe8e731540fd7363';
const LEGACY_PART_BOUNDS_CUTS = 854;

// ---------------------------------------------------------------------------
// The fin, and its removal
// ---------------------------------------------------------------------------

describe('WO-1282 scallop: the tool centre is contained, the overrun lets the cutter clear the edge', () => {
  it('with the overrun off the outermost pass leaves a wedge; with it on the tip follows the surface down to the edge', { timeout: 120_000 }, async () => {
    const none = await compute(SLAB, { ...BASE_PARAMS, stockEdgeOvershoot: 0 });
    const auto = await compute(SLAB, BASE_PARAMS);

    // Off: the centre never leaves the part's bounding box.
    const e0 = cutExtent(none);
    expect(e0.minX).toBeGreaterThanOrEqual(-1e-9);
    expect(e0.maxX).toBeLessThanOrEqual(SIZE + 1e-9);
    expect(e0.minY).toBeGreaterThanOrEqual(-1e-9);
    expect(e0.maxY).toBeLessThanOrEqual(SIZE + 1e-9);

    // On: it travels past it, on every side, and stops short of one radius.
    const e1 = cutExtent(auto);
    expect(e1.minX).toBeLessThan(-1);
    expect(e1.maxX).toBeGreaterThan(SIZE + 1);
    expect(e1.minY).toBeLessThan(-1);
    expect(e1.maxY).toBeGreaterThan(SIZE + 1);

    // THE FIN. The slab top at the x = 0 edge is Z0; the lowest tip the pass
    // reaches is the material it actually takes down to. With the centre
    // clipped, the whole outer band is held up at z(R) = Z0 + SLOPE * R and
    // more (the first contour is one stepover inside the region edge).
    const finOff = e0.minZ - Z0;
    const finOn = e1.minZ - Z0;
    expect(finOff).toBeGreaterThan(SLOPE * R);
    // With the overrun the same first contour sits one stepover inside a
    // region edge that is now a radius further out: the leftover collapses.
    expect(finOn).toBeLessThan(finOff / 2);
    expect(finOn).toBeLessThan(SLOPE * R);
  });

  it('stockEdgeOvershoot: 0 reproduces the pre-WO-1282 toolpath exactly', { timeout: 120_000 }, async () => {
    const none = await compute(SLAB, { ...BASE_PARAMS, stockEdgeOvershoot: 0 });
    expect(cuts(none).length).toBe(LEGACY_PART_BOUNDS_CUTS);
    expect(movesFingerprint(none)).toBe(LEGACY_PART_BOUNDS_FINGERPRINT);
  });

  it('the overrun only ever grows the cut, never moves it inward, and stays deterministic', { timeout: 120_000 }, async () => {
    const none = await compute(SLAB, { ...BASE_PARAMS, stockEdgeOvershoot: 0 });
    const auto = await compute(SLAB, BASE_PARAMS);
    const again = await compute(SLAB, BASE_PARAMS);
    // D-006: same input, same bytes.
    expect(JSON.stringify(again)).toBe(JSON.stringify(auto));
    // Not byte-identical to the legacy path, and no such claim is made: the
    // seeds move outward, so every contour derived from the field moves.
    expect(movesFingerprint(auto)).not.toBe(movesFingerprint(none));
    // What IS promised: the cut region grows. The overrun run reaches at
    // least as far out on every side and cuts at least as much.
    const e0 = cutExtent(none);
    const e1 = cutExtent(auto);
    expect(e1.minX).toBeLessThanOrEqual(e0.minX);
    expect(e1.maxX).toBeGreaterThanOrEqual(e0.maxX);
    expect(e1.minY).toBeLessThanOrEqual(e0.minY);
    expect(e1.maxY).toBeGreaterThanOrEqual(e0.maxY);
    expect(cuts(auto).length).toBeGreaterThan(cuts(none).length);
  });

  it('the contact mask caps the band at one radius however much overshoot is asked for', { timeout: 120_000 }, async () => {
    // WO-1281's mask (inside = inRegion AND the cutter meets the part) is what
    // bounds the excursion, not the requested number: a centre further than R
    // from the part has nothing under its footprint, so that cell never enters
    // the field and no contour can be routed through it. Ask for 10 mm on a
    // 3 mm tool and the answer is still one radius.
    const wide = await compute(SLAB, { ...BASE_PARAMS, stockEdgeOvershoot: 10 });
    const reach = R + TOLERANCE;
    for (const m of cuts(wide)) {
      expect(m.x).toBeGreaterThanOrEqual(-reach);
      expect(m.x).toBeLessThanOrEqual(SIZE + reach);
      expect(m.y).toBeGreaterThanOrEqual(-reach);
      expect(m.y).toBeLessThanOrEqual(SIZE + reach);
    }
    expect(cuts(wide).length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// The case that makes the order dangerous: walls belonging to the model
// ---------------------------------------------------------------------------

describe('WO-1282 walls: the overrun crosses a stock edge, never a wall the model owns', () => {
  it('the slab has vertical walls on the containment edge and the pass never descends one', { timeout: 120_000 }, async () => {
    const auto = await compute(SLAB, BASE_PARAMS);
    const cut = cuts(auto);
    expect(cut.length).toBeGreaterThan(0);
    // The lowest point on the slab TOP is Z0; the walls run from there to
    // z = 0. Not one vertex is on a wall face.
    for (const m of cut) expect(m.z).toBeGreaterThanOrEqual(Z0 - 1e-9);

    // And nowhere is the tip below the surface an independent drop reports for
    // that xy. A contour vertex is INTERPOLATED between two grid nodes a cell
    // apart, so where the cutter-location surface curves over that cell the
    // vertex rides the chord and sits under it by the surface's sag -- the same
    // allowance WO-1281 records for the same reason, and a property of
    // contouring a sampled field, not of the overrun. It is worth measuring
    // rather than waving at: the worst case in the OVERRUN BAND is reported
    // below and must be no worse than in the interior.
    const k = new BvhKernel();
    const mesh: MeshHandle = k.uploadMesh(SLAB);
    const c = k.makeCutter(FLAT6);
    try {
      const xy = new Float64Array(cut.length * 2);
      for (let i = 0; i < cut.length; i++) { xy[2 * i] = cut[i].x; xy[2 * i + 1] = cut[i].y; }
      const truth = await k.dropPoints(mesh, c, xy, 0);
      let worstBand = 0;
      let worstInside = 0;
      for (let i = 0; i < cut.length; i++) {
        const under = truth[i] - cut[i].z;
        const inBand = cut[i].x < 0 || cut[i].x > SIZE || cut[i].y < 0 || cut[i].y > SIZE;
        if (inBand) worstBand = Math.max(worstBand, under);
        else worstInside = Math.max(worstInside, under);
        expect(cut[i].z, `cut at (${cut[i].x}, ${cut[i].y}) is inside the part`)
          .toBeGreaterThanOrEqual(truth[i] - 2 * TOLERANCE);
      }
      console.log(
        `WO-1282 worst dip below the drop surface: overrun band ${worstBand.toFixed(6)} mm, ` +
        `interior ${worstInside.toFixed(6)} mm (one grid cell = ${TOLERANCE} mm)`,
      );
      expect(worstBand).toBeLessThanOrEqual(Math.max(worstInside, TOLERANCE));
    } finally {
      k.releaseCutter(c);
      k.releaseMesh(mesh);
    }
  });

  it('rides over a boss standing inside the region: the overrun never cuts into its wall', { timeout: 180_000 }, async () => {
    // A 24 x 24 x 5 slab carrying a 12 x 12 x 5 boss centred on it: the boss
    // walls stand INSIDE the region and its top is at z = 10.
    const STEP_SIZE = 24;
    const STEP_H = 5;
    const BOSS_MIN = STEP_SIZE / 4;
    const BOSS_MAX = (3 * STEP_SIZE) / 4;
    const stepTol = 0.4;
    const stepped = steps(2, STEP_SIZE, STEP_H);
    const stepParams: Scallop3dParams = { ...BASE_PARAMS, scallopHeight: 0.1, tolerance: stepTol };
    const stepHeights: ResolvedParallel3dHeights = {
      clearanceZ: 20, retractZ: 12, feedZ: 11, topZ: 2 * STEP_H, bottomZ: 0,
    };
    const moves = await compute(stepped, stepParams, { resolvedHeights: stepHeights });
    const cut = cuts(moves);
    expect(cut.length).toBeGreaterThan(0);
    // The overrun did happen: every contour has moved outward by it. (The
    // tread is FLAT, so there is no fin to measure here -- a flat cutter on a
    // flat face already clears the edge with its rim. This fixture is here for
    // the wall, and the extents only confirm the overrun was applied.)
    const e = cutExtent(moves);
    const e0 = cutExtent(await compute(stepped, { ...stepParams, stockEdgeOvershoot: 0 }, {
      resolvedHeights: stepHeights,
    }));
    expect(e.minX).toBeLessThan(e0.minX - 1);
    expect(e.maxX).toBeGreaterThan(e0.maxX + 1);

    const bossDistance = (x: number, y: number): number => Math.hypot(
      Math.max(0, BOSS_MIN - x, x - BOSS_MAX), Math.max(0, BOSS_MIN - y, y - BOSS_MAX),
    );
    // Where the footprint is CLEAR of the boss the tread is at STEP_H; where it
    // overlaps, the cutter is held at the boss top. A contour vertex is
    // interpolated between two grid nodes one cell apart, so on the one-cell
    // band that straddles the cutter-location cliff it lands between the two
    // heights -- pre-existing scallop behaviour, bounded by the tolerance and
    // untouched by this order. Off that band the rule is exact.
    let overBoss = 0;
    for (const m of cut) {
      const d = bossDistance(m.x, m.y);
      if (d >= R - 2 * stepTol) continue;
      overBoss++;
      expect(m.z, `cut at (${m.x}, ${m.y}) is inside the boss wall`)
        .toBeGreaterThanOrEqual(2 * STEP_H - 1e-6);
    }
    expect(overBoss).toBeGreaterThan(0);
    // Nothing anywhere below the tread.
    for (const m of cut) expect(m.z).toBeGreaterThanOrEqual(STEP_H - 1e-6);
  });
});

// ---------------------------------------------------------------------------
// WHEN it applies: the same vouch, the same shared decision as WO-1271
// ---------------------------------------------------------------------------

describe('WO-1282 adapter: auto one radius on a part edge or a vouched stock outline, never on a selection edge', () => {
  it('readScallop3dParams: absent or invalid -> auto (undefined); a finite >= 0 value is kept', () => {
    expect(readScallop3dParams({}).stockEdgeOvershoot).toBeUndefined();
    expect(readScallop3dParams({ stockEdgeOvershoot: -1 }).stockEdgeOvershoot).toBeUndefined();
    expect(readScallop3dParams({ stockEdgeOvershoot: 'x' }).stockEdgeOvershoot).toBeUndefined();
    expect(readScallop3dParams({ stockEdgeOvershoot: 0 }).stockEdgeOvershoot).toBe(0);
    expect(readScallop3dParams({ stockEdgeOvershoot: 1.25 }).stockEdgeOvershoot).toBe(1.25);
  });

  it('a vouched stock outline is overrun; an unvouched one is not, and says so out loud', { timeout: 180_000 }, async () => {
    const boundary = [xyBoundsRing({ minX: 2, minY: 2, maxX: SIZE - 2, maxY: SIZE - 2 })];
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let unvouched: ToolpathMove[];
    try {
      unvouched = await compute(SLAB, { ...BASE_PARAMS, useStockBoundary: true }, { boundary });
      const lines = warn.mock.calls.map(call => String(call[0])).filter(l => l.includes('stock-edge overrun'));
      expect(lines).toHaveLength(1);
      expect(lines[0]).toMatch(/did not say whether this boundary is a stock outline/);

      warn.mockClear();
      const selection = await compute(SLAB, { ...BASE_PARAMS, useStockBoundary: true }, {
        boundary, boundaryKind: 'selection',
      });
      // Forgetting the marker costs a fin, never a gouge: the two are the same
      // toolpath, and only the unvouched one is announced.
      expect(JSON.stringify(selection)).toBe(JSON.stringify(unvouched));
      expect(warn.mock.calls.filter(c => String(c[0]).includes('stock-edge overrun'))).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
    const e0 = cutExtent(unvouched);
    expect(e0.minX).toBeGreaterThanOrEqual(2 - 1e-9);
    expect(e0.maxX).toBeLessThanOrEqual(SIZE - 2 + 1e-9);

    const vouched = await compute(SLAB, { ...BASE_PARAMS, useStockBoundary: true }, {
      boundary, boundaryKind: 'stock',
    });
    const e1 = cutExtent(vouched);
    expect(e1.minX).toBeLessThan(e0.minX - 1);
    expect(e1.maxX).toBeGreaterThan(e0.maxX + 1);
    // Still capped by the contact mask at one radius past the stock outline.
    expect(e1.minX).toBeGreaterThanOrEqual(2 - OVERRUN - TOLERANCE);
    expect(e1.maxX).toBeLessThanOrEqual(SIZE - 2 + OVERRUN + TOLERANCE);
  });

  it('a face-scoped pass never overruns: byte-identical with auto and with 0', { timeout: 180_000 }, async () => {
    const faceIds = new Uint32Array(SLAB.indices.length / 3).fill(7);
    const scopedMesh: PartMesh = { ...SLAB, faceIds };
    const auto = await compute(scopedMesh, BASE_PARAMS, { faceScope: [7] });
    const none = await compute(scopedMesh, { ...BASE_PARAMS, stockEdgeOvershoot: 0 }, { faceScope: [7] });
    expect(JSON.stringify(auto)).toBe(JSON.stringify(none));
    // WO-1223 inset: radius + 0.05 mm clearance on every side, and the
    // selection edge is a wall the overrun must not push past.
    const inset = R + 0.05;
    const e = cutExtent(auto);
    expect(e.minX).toBeGreaterThanOrEqual(inset - 1e-6);
    expect(e.maxX).toBeLessThanOrEqual(SIZE - inset + 1e-6);
  });
});
