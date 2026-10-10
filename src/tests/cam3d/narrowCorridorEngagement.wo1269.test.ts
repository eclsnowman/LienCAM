// WO-1269: does the engagement ruler SEE a corridor barely wider than the cutter?
//
// Shakedown 4.1 (2026-09-07): a closed 10.00 mm ring pocket cut with a 9.52 mm
// cutter - 0.48 mm of clearance - produced no refusal and a highest reported
// engagement of 68%, measured in the wide pocket, not in the ring. Two readings:
//   (a) the engine avoided the ring and the ruler had nothing to see there;
//   (b) the ruler cannot resolve a 0.48 mm corridor and is blind where cutters break.
// WO-1253 showed the same ruler OVER-reads on a coarse cell (107% of a slot), so
// "it under-reads on one" has to be disproved by measurement, not assumed away.
//
// What the ruler measures is the WIDTH OF FRESH MATERIAL the cutter removes,
// quantized to whole replay columns. A corridor is not something the stock field
// knows about: a 9.52 mm cutter down a 10.00 mm corridor takes its full 9.52 mm
// of fresh stock, so the analytic answer is exactly 1.000 of a full slot whether
// the corridor is a channel in solid stock (the shakedown's ring) or a 10 mm rib
// left standing in air (the tightest thing a grid has to resolve). The 0.24 mm
// left on each side is what the cutter does NOT touch, and the ruler never has to
// see it. The three tests below pin:
//
//   1. THE CORRIDOR. A lap of the corridor centreline, in both corridor forms,
//      reads each leg's exact analytic engagement (107%, 99%, 99%, 83% - the
//      corners overlap) at every caller cell from the app's own 0.79 mm up to a
//      5 mm cell where WO-1253's 3x refinement bound bites (replay 1.67 mm, 5.7
//      columns across the cutter). The three full-corridor legs are over the cap
//      as one unbroken run at every cell.
//   2. THE TOLERANCE. The ruler's error is one replay column of the cutter's
//      diameter: a fresh strip of any width w reads within (replay / D) of w / D.
//      The blind band is therefore the true engagements in (cap, cap + replay / D]
//      which a straight, axis-aligned pass can read at or under the cap - 75% to
//      83% at the app's cell for this cutter. Nothing wider than that can hide.
//   3. THE APPLICATION. The shakedown geometry (a wide 40 x 40 pocket and a closed
//      10 mm ring around a 40 x 40 island) through adaptiveRough with the app's
//      derived cell. It emits: the ring's legs carry no lateral cutting at all,
//      its four 10 x 10 corner squares get ramp-and-nibble bites the ruler reads
//      under half the cap, and a 0.2 mm replay of the same moves agrees. That is
//      "provably avoids", which is what 4.1 must read. Reading (b) would show up
//      here as centimetres of cutting down the legs that read as nothing.

import { describe, it, expect, beforeAll } from 'vitest';

import { ZDexelField, type Box3 } from '../../cam3d/stock';
import { ensureGeom2dReady } from '../../cam3d/geom2d';
import { ensureEngineClipperReady } from '../../cam3d/rough/engineEntry';
import { BvhKernel } from '../../cam3d/kernel/bvhKernel';
import type { PartMesh, CutterSpec } from '../../cam3d/kernel/types';
import { MeshBuilder } from '../../cam3d/fixtures/meshBuilder';
import { adaptiveRough, SIDE_ENTRY_ENGAGEMENT_CAP, type AdaptiveRoughInput } from '../../cam3d/strategies/adaptiveRough';
import { deriveCellSize } from '../../cam3d/integration/adaptive3dOperation';
import { measurePathEngagement } from '../../cam3d/rough/pathEngagement';
import { forEachLinearSweep, replayMovesIntoStock } from '../../cam3d/rough/replayStock';
import type { IrMove } from '../../cam3d/ir/types';

const CUTTER: CutterSpec = { kind: 'flat', diameter: 9.52 };
const D = CUTTER.diameter;
const CORRIDOR = 10.0;
/** The cell the app plans a 9.52 mm adaptive_3d op on (tolerance 0.05 -> D / 12). */
const APP_CELL = deriveCellSize(0.05, D);
/** replayCellFor, restated: min(cell, D / 8) but never below cell / 3 (WO-1253). */
function replayCellFor(cell: number): number {
  return Math.max(Math.min(cell, D / 8), cell / 3);
}

// ---------------------------------------------------------------------------
// 1. The corridor
// ---------------------------------------------------------------------------

/** A closed square corridor: outer [lo, hi]^2, inner island inset by CORRIDOR. */
const RING = { lo: 10, hi: 70 } as const;
const RING_MID_LO = RING.lo + CORRIDOR / 2; // 15: corridor centreline
const RING_MID_HI = RING.hi - CORRIDOR / 2; // 65
const RING_BOUNDS: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 80, maxY: 80, maxZ: 10 };
const RING_Z = 7; // 3 mm slab under a 10 mm stock top

function insideRingCorridor(x: number, y: number): boolean {
  const inOuter = x > RING.lo && x < RING.hi && y > RING.lo && y < RING.hi;
  const inIsland = x > RING.lo + CORRIDOR && x < RING.hi - CORRIDOR && y > RING.lo + CORRIDOR && y < RING.hi - CORRIDOR;
  return inOuter && !inIsland;
}

/** One lap of the corridor centreline: plunge, then four 50 mm legs. */
function ringLap(): IrMove[] {
  return [
    { t: 'rapid', role: 'rapid', x: RING_MID_LO, y: RING_MID_LO, z: RING_BOUNDS.maxZ },
    { t: 'feed', role: 'plunge', x: RING_MID_LO, y: RING_MID_LO, z: RING_Z },
    { t: 'feed', role: 'cut', x: RING_MID_HI, y: RING_MID_LO, z: RING_Z },
    { t: 'feed', role: 'cut', x: RING_MID_HI, y: RING_MID_HI, z: RING_Z },
    { t: 'feed', role: 'cut', x: RING_MID_LO, y: RING_MID_HI, z: RING_Z },
    { t: 'feed', role: 'cut', x: RING_MID_LO, y: RING_MID_LO, z: RING_Z },
  ];
}

/**
 * Starting stock at the caller's cell. 'channel': an uncut box, the shakedown's
 * closed ring pocket as the stock field sees it. 'rib': everything OUTSIDE the
 * 10 mm corridor already cleared to the cutting depth, so the corridor is a
 * standing rib 0.48 mm wider than the cutter with air on both sides - the form a
 * grid can actually fail to resolve.
 */
function ringStock(cell: number, form: 'channel' | 'rib'): ZDexelField {
  const f = ZDexelField.fromBox(RING_BOUNDS, cell);
  if (form === 'channel') return f;
  for (let j = 0; j < f.ny; j++) {
    const y = f.originY + (j + 0.5) * f.cell;
    for (let i = 0; i < f.nx; i++) {
      const x = f.originX + (i + 0.5) * f.cell;
      if (!insideRingCorridor(x, y)) f.top[j * f.nx + i] = RING_Z;
    }
  }
  return f;
}

const LEG = RING_MID_HI - RING_MID_LO; // 50 mm
const R = D / 2;
const SLOT_PER_LEG = LEG * D; // mm^2 of plan area a full-slot leg removes
/**
 * Exact analytic engagement of each leg, as plan area of FRESH material over the
 * full-slot area. Every leg is a 50 x 9.52 rectangle plus a disc at each end:
 *   - the plunge has already removed leg 1's start disc, so leg 1 is the rectangle
 *     plus the fresh half of its end disc (+ pi R^2 / 2);
 *   - legs 2 and 3 start on the previous leg's end disc: the square
 *     R x R and quarter disc where the two capsules overlap are gone (- R^2 -
 *     pi R^2 / 4), and each gains a fresh end half-disc;
 *   - leg 4 loses that overlap at BOTH ends (leg 3 at its start, leg 1 and the
 *     plunge disc at its end) and its end disc is entirely gone already.
 * The corridor is wide enough (10 mm) that every one of those discs lies inside
 * the standing rib, so 'channel' and 'rib' share the same truth.
 */
const CORNER_LOSS = R * R + (Math.PI * R * R) / 4;
const HALF_DISC = (Math.PI * R * R) / 2;
const LEG_TRUTH = [
  (SLOT_PER_LEG + HALF_DISC) / SLOT_PER_LEG,
  (SLOT_PER_LEG - CORNER_LOSS + HALF_DISC) / SLOT_PER_LEG,
  (SLOT_PER_LEG - CORNER_LOSS + HALF_DISC) / SLOT_PER_LEG,
  (SLOT_PER_LEG - 2 * CORNER_LOSS) / SLOT_PER_LEG,
];

/**
 * The ruler's error budget at a replay cell: removed width quantizes to whole
 * columns (one column of the cutter's diameter), and every disc-shaped end or
 * overlap carries a rim of straddling columns (a half-disc's perimeter, pi R,
 * times one cell, over the leg's slot area).
 */
function rulerTolerance(replay: number, legMm: number): number {
  return replay / D + (Math.PI * R * replay) / (legMm * D);
}

describe('WO-1269: the ruler sees a 9.52 mm cutter in a 10.00 mm corridor', () => {
  // App cell, two intermediate cells, one at the D/8 replay floor exactly, and
  // one coarse enough that the 3x refinement bound is what sets the replay cell.
  const CELLS = [0.5, APP_CELL, 1.0, 1.5, 3.0, 5.0];
  for (const form of ['channel', 'rib'] as const) {
    it(`${form}: every leg reads its analytic engagement within one replay column`, () => {
      for (const cell of CELLS) {
        const replay = replayCellFor(cell);
        // A caller-built starting field can only describe STANDING material to its
        // own cell: at 1.5 mm a 10.00 mm rib whose edges fall mid-cell is stored as
        // 9.0 mm, and the replay resample cannot invent the missing 1.0 mm. That is
        // the field's fidelity, not the ruler's, and it is one caller column on top
        // of the ruler's own budget. An uncut box has no such edges.
        const fieldFidelity = form === 'rib' ? cell / D : 0;
        const tol = rulerTolerance(replay, LEG) + fieldFidelity;
        // Each leg is one sweep longer than the window, so the diagnostic hook
        // fires once per leg with that leg's own fraction when the cap is nil.
        const legRead: number[] = [];
        const r = measurePathEngagement(ringLap(), RING_BOUNDS, cell, CUTTER, {
          capFraction: 1e-6,
          startingStock: ringStock(cell, form),
          onOverCap: (h) => { legRead[h.moveIndex - 2] = h.fraction; },
        });
        const capped = measurePathEngagement(ringLap(), RING_BOUNDS, cell, CUTTER, {
          capFraction: SIDE_ENTRY_ENGAGEMENT_CAP,
          startingStock: ringStock(cell, form),
        });
        // eslint-disable-next-line no-console
        console.log(
          `WO-1269 ${form} cell ${cell.toFixed(2)} (replay ${replay.toFixed(2)}, ${(D / replay).toFixed(1)} cols, tol ${(tol * 100).toFixed(1)}%): `
          + `legs ${legRead.map((f, k) => `${(f * 100).toFixed(1)}% (true ${(LEG_TRUTH[k] * 100).toFixed(1)}%)`).join(', ')}; `
          + `over cap ${capped.overCapLengthMm.toFixed(0)} / ${capped.cuttingLengthMm.toFixed(0)} mm, longest run ${capped.longestOverCapRunMm.toFixed(0)} mm`,
        );
        expect(r.cuttingLengthMm).toBeCloseTo(4 * LEG, 6);
        expect(legRead.length).toBe(4);
        for (let k = 0; k < 4; k++) {
          expect(Math.abs(legRead[k] - LEG_TRUTH[k])).toBeLessThanOrEqual(tol);
        }
        expect(r.peakFraction).toBeCloseTo(Math.max(...legRead), 9);
        // The three full-corridor legs (true 99% - 107%) are over the cap at every
        // cell, as one unbroken run: the load shape the interior-entry refusal row
        // reads (WO-1252). The closing leg (true 83%) sits inside the one-column
        // band above the cap and is allowed to fall either side of it - that band
        // is the ruler's stated blind spot, pinned in the next describe.
        expect(capped.longestOverCapRunMm).toBeGreaterThanOrEqual(3 * LEG);
      }
    });
  }
});

// ---------------------------------------------------------------------------
// 2. The tolerance
// ---------------------------------------------------------------------------

describe('WO-1269: the ruler is accurate to one replay column of the cutter', () => {
  const BOUNDS: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 360, maxY: 60, maxZ: 20 };
  const Z = 17; // 3 mm slab
  const PASS = 300;
  /**
   * A 300 mm pass whose leading `w` mm of cutter width is fresh material and whose
   * trailing (D - w) rides stock already cleared to Z. The plunge removes the start
   * disc, so the pass's analytic engagement is
   *   (w * PASS + fresh share of the end half-disc) / (D * PASS),
   * the half-disc share being half the disc segment of height w from the rim.
   *
   * The fresh edge sits exactly on a caller-cell boundary, so the starting field
   * describes it without error and what remains is the RULER's own quantization;
   * the cutter axis is what moves, which walks its phase across the replay grid.
   */
  const build = (cell: number, w: number, freshHi: number): { moves: IrMove[]; start: ZDexelField } => {
    const start = ZDexelField.fromBox(BOUNDS, cell);
    const yc = freshHi + D / 2 - w; // cutter axis; fresh strip is [yc - D/2, freshHi]
    for (let j = 0; j < start.ny; j++) {
      const y = start.originY + (j + 0.5) * start.cell;
      if (y <= freshHi) continue;
      for (let i = 0; i < start.nx; i++) start.top[j * start.nx + i] = Z;
    }
    const moves: IrMove[] = [
      { t: 'rapid', role: 'rapid', x: 30, y: yc, z: BOUNDS.maxZ },
      { t: 'feed', role: 'plunge', x: 30, y: yc, z: Z },
      { t: 'feed', role: 'cut', x: 30 + PASS, y: yc, z: Z },
    ];
    return { moves, start };
  };
  /** Area of the disc (radius R) within `h` of its rim, i.e. the circular segment of height h. */
  const segment = (h: number): number => {
    const d = Math.min(Math.max(h, 0), 2 * R);
    return R * R * Math.acos((R - d) / R) - (R - d) * Math.sqrt(2 * R * d - d * d);
  };
  const truthFor = (w: number): number => (Math.min(w, D) * PASS + segment(w) / 2) / (D * PASS);

  for (const cell of [APP_CELL, 1.5, 5.0]) {
    it(`caller cell ${cell.toFixed(2)} mm: every fresh width reads within one replay column`, () => {
      const replay = replayCellFor(cell);
      const quantum = replay / D;
      const tol = rulerTolerance(replay, PASS);
      let worstUnder = 0;
      let worstOver = 0;
      let blindLo = Number.POSITIVE_INFINITY;
      let blindHi = 0;
      // Fresh widths from a sliver to the full cutter, the edge on three successive
      // caller-cell boundaries near y = 30 so the replay grid's phase against that
      // edge varies too (the replay cell need not divide the caller's).
      const k0 = Math.round(30 / cell);
      for (let w = 0.1; w <= D + 1e-9; w += 0.1) {
        for (const freshHi of [k0 * cell, (k0 + 1) * cell, (k0 + 2) * cell]) {
          const truth = truthFor(w);
          const { moves, start } = build(cell, w, freshHi);
          const r = measurePathEngagement(moves, BOUNDS, cell, CUTTER, {
            capFraction: SIDE_ENTRY_ENGAGEMENT_CAP,
            startingStock: start,
          });
          const err = r.peakFraction - truth;
          if (err < worstUnder) worstUnder = err;
          if (err > worstOver) worstOver = err;
          if (truth > SIDE_ENTRY_ENGAGEMENT_CAP && r.peakFraction <= SIDE_ENTRY_ENGAGEMENT_CAP) {
            blindLo = Math.min(blindLo, truth);
            blindHi = Math.max(blindHi, truth);
          }
          expect(Math.abs(err)).toBeLessThanOrEqual(tol);
        }
      }
      // eslint-disable-next-line no-console
      console.log(
        `WO-1269 tolerance cell ${cell.toFixed(2)} (replay ${replay.toFixed(3)}, one column ${(quantum * 100).toFixed(1)}%, tol ${(tol * 100).toFixed(1)}%): `
        + `worst under-read ${(worstUnder * 100).toFixed(1)}%, worst over-read +${(worstOver * 100).toFixed(1)}%; `
        + `true engagements that read at or under the ${(SIDE_ENTRY_ENGAGEMENT_CAP * 100).toFixed(0)}% cap: `
        + (blindHi > 0 ? `${(blindLo * 100).toFixed(1)}% .. ${(blindHi * 100).toFixed(1)}%` : 'none'),
      );
      // The blind band never reaches past one replay column above the cap: a true
      // engagement above cap + column ALWAYS reads over the cap.
      expect(blindHi).toBeLessThanOrEqual(SIDE_ENTRY_ENGAGEMENT_CAP + quantum + 1e-6);
      // And it is not imaginary: at every cell some true engagement just over the
      // cap does read under it, which is what the tolerance statement means.
      expect(blindHi).toBeGreaterThan(SIDE_ENTRY_ENGAGEMENT_CAP);
    });
  }
});

// ---------------------------------------------------------------------------
// 3. The application
// ---------------------------------------------------------------------------

// Block 130 x 70 x 20. A wide 40 x 40 pocket on the left; on the right a 60 x 60
// pocket with a full-height 40 x 40 island, leaving a closed 10.00 mm ring.
// Both cut to a flat floor 6 mm down. Built on the break-line grid exactly like
// engagementPocket (src/cam3d/fixtures), so every wall is an exact feature edge.
const SD_XS = [0, 5, 45, 65, 75, 115, 125, 130] as const;
const SD_YS = [0, 5, 15, 55, 65, 70] as const;
const SD_Z_TOP = 20;
const SD_Z_FLOOR = 14;
const SD_WIDE = { x0: 5, x1: 45, y0: 15, y1: 55 } as const;
const SD_RING_OUTER = { x0: 65, x1: 125, y0: 5, y1: 65 } as const;
const SD_RING_ISLAND = { x0: 75, x1: 115, y0: 15, y1: 55 } as const;

function inRect(x: number, y: number, r: { x0: number; x1: number; y0: number; y1: number }): boolean {
  return x > r.x0 && x < r.x1 && y > r.y0 && y < r.y1;
}
function sdInRing(x: number, y: number): boolean {
  return inRect(x, y, SD_RING_OUTER) && !inRect(x, y, SD_RING_ISLAND);
}
function sdIsPocket(x: number, y: number): boolean {
  return inRect(x, y, SD_WIDE) || sdInRing(x, y);
}

function shakedownRingPart(): PartMesh {
  const b = new MeshBuilder();
  const nx = SD_XS.length - 1;
  const ny = SD_YS.length - 1;
  const pocket: boolean[][] = [];
  for (let i = 0; i < nx; i++) {
    pocket[i] = [];
    for (let j = 0; j < ny; j++) {
      pocket[i][j] = sdIsPocket((SD_XS[i] + SD_XS[i + 1]) / 2, (SD_YS[j] + SD_YS[j + 1]) / 2);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      const x0 = SD_XS[i], x1 = SD_XS[i + 1];
      const y0 = SD_YS[j], y1 = SD_YS[j + 1];
      const z = pocket[i][j] ? SD_Z_FLOOR : SD_Z_TOP;
      b.quad(b.vertex(x0, y0, z), b.vertex(x1, y0, z), b.vertex(x1, y1, z), b.vertex(x0, y1, z));
    }
  }
  const wall = (ax: number, ay: number, bx: number, by: number, px: number, py: number): void => {
    const ex = bx - ax, ey = by - ay;
    const mx = (ax + bx) / 2, my = (ay + by) / 2;
    const dot = ey * (px - mx) + -ex * (py - my);
    const aLo = b.vertex(ax, ay, SD_Z_FLOOR);
    const bLo = b.vertex(bx, by, SD_Z_FLOOR);
    const bHi = b.vertex(bx, by, SD_Z_TOP);
    const aHi = b.vertex(ax, ay, SD_Z_TOP);
    if (dot >= 0) b.quad(aLo, bLo, bHi, aHi);
    else b.quad(aHi, bHi, bLo, aLo);
  };
  for (let i = 0; i < nx - 1; i++) {
    for (let j = 0; j < ny; j++) {
      const l = pocket[i][j], r = pocket[i + 1][j];
      if (l === r) continue;
      const x = SD_XS[i + 1];
      const y0 = SD_YS[j], y1 = SD_YS[j + 1];
      const px = l ? (SD_XS[i] + x) / 2 : (x + SD_XS[i + 2]) / 2;
      wall(x, y0, x, y1, px, (y0 + y1) / 2);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny - 1; j++) {
      const d = pocket[i][j], u = pocket[i][j + 1];
      if (d === u) continue;
      const y = SD_YS[j + 1];
      const x0 = SD_XS[i], x1 = SD_XS[i + 1];
      const py = d ? (SD_YS[j] + y) / 2 : (y + SD_YS[j + 2]) / 2;
      wall(x0, y, x1, y, (x0 + x1) / 2, py);
    }
  }
  const X = SD_XS[nx], Y = SD_YS[ny];
  const oLo = [b.vertex(0, 0, 0), b.vertex(X, 0, 0), b.vertex(X, Y, 0), b.vertex(0, Y, 0)];
  const oHi = [b.vertex(0, 0, SD_Z_TOP), b.vertex(X, 0, SD_Z_TOP), b.vertex(X, Y, SD_Z_TOP), b.vertex(0, Y, SD_Z_TOP)];
  b.quad(oLo[0], oLo[3], oLo[2], oLo[1]);
  for (let k = 0; k < 4; k++) {
    const k1 = (k + 1) % 4;
    b.quad(oLo[k], oLo[k1], oHi[k1], oHi[k]);
  }
  return b.build();
}

/**
 * The ring's four 10 x 10 corner squares, where a 9.52 mm cutter and a tiny ramp
 * physically fit, versus its four 10 mm legs, where nothing narrower than a full
 * slot does.
 */
function sdInRingCorner(x: number, y: number): boolean {
  const xEnd = (x > SD_RING_OUTER.x0 && x < SD_RING_ISLAND.x0) || (x > SD_RING_ISLAND.x1 && x < SD_RING_OUTER.x1);
  const yEnd = (y > SD_RING_OUTER.y0 && y < SD_RING_ISLAND.y0) || (y > SD_RING_ISLAND.y1 && y < SD_RING_OUTER.y1);
  return xEnd && yEnd;
}

/** Lateral cutting length (mm) below the stock top by where its midpoint lies. */
function lateralCuttingBy(moves: readonly IrMove[]): { corners: number; legs: number; total: number } {
  const lateral = new Set(['cut', 'finish', 'stepover']);
  const out = { corners: 0, legs: 0, total: 0 };
  let prev: { x: number; y: number; z: number } | null = null;
  for (const m of moves) {
    if (prev !== null && m.role !== undefined && lateral.has(m.role) && m.z < SD_Z_TOP - 1e-6) {
      forEachLinearSweep(prev, m, 0.05, (s) => {
        const len = Math.hypot(s.x1 - s.x0, s.y1 - s.y0);
        const mx = (s.x0 + s.x1) / 2;
        const my = (s.y0 + s.y1) / 2;
        out.total += len;
        if (sdInRing(mx, my)) {
          if (sdInRingCorner(mx, my)) out.corners += len;
          else out.legs += len;
        }
      });
    }
    prev = { x: m.x, y: m.y, z: m.z };
  }
  return out;
}

/**
 * Peak sliding-window fraction the ruler reports on sweeps whose midpoint is in
 * the ring, overall and per lateral role (the hook reports each window's role).
 */
function ringPeak(moves: readonly IrMove[], bounds: Box3, cell: number): { all: number; byRole: Map<string, number> } {
  let all = 0;
  const byRole = new Map<string, number>();
  measurePathEngagement(moves, bounds, cell, CUTTER, {
    capFraction: 1e-9,
    onOverCap: (h) => {
      if (!sdInRing(h.x, h.y)) return;
      if (h.fraction > all) all = h.fraction;
      if (h.fraction > (byRole.get(h.role) ?? 0)) byRole.set(h.role, h.fraction);
    },
  });
  return { all, byRole };
}

/**
 * Plan area of the ring the emitted moves actually removed, from a replay of the
 * moves into a fresh stock field at `cell`: every ring cell (by centre) whose top
 * dropped below the stock top, split into the four 10 x 10 corner squares and
 * the four 10 mm legs. Areas in mm^2 (cell count x cell^2); the analytic ring is
 * 60^2 - 40^2 = 2000 mm^2.
 */
function ringPlanCut(moves: readonly IrMove[], bounds: Box3, cell: number): {
  ringMm2: number; cutMm2: number; cornersMm2: number; cornersCutMm2: number; legsMm2: number; legsCutMm2: number;
} {
  const f = ZDexelField.fromBox(bounds, cell);
  replayMovesIntoStock(f, CUTTER, moves, null);
  const a = f.cell * f.cell;
  const out = { ringMm2: 0, cutMm2: 0, cornersMm2: 0, cornersCutMm2: 0, legsMm2: 0, legsCutMm2: 0 };
  for (let j = 0; j < f.ny; j++) {
    const y = f.originY + (j + 0.5) * f.cell;
    for (let i = 0; i < f.nx; i++) {
      const x = f.originX + (i + 0.5) * f.cell;
      if (!sdInRing(x, y)) continue;
      const cut = f.top[j * f.nx + i] < SD_Z_TOP - 1e-6;
      out.ringMm2 += a;
      if (cut) out.cutMm2 += a;
      if (sdInRingCorner(x, y)) {
        out.cornersMm2 += a;
        if (cut) out.cornersCutMm2 += a;
      } else {
        out.legsMm2 += a;
        if (cut) out.legsCutMm2 += a;
      }
    }
  }
  return out;
}

const pct = (num: number, den: number): string => `${((100 * num) / den).toFixed(1)}%`;

describe('WO-1269: the shakedown ring through adaptiveRough', () => {
  let kernel: BvhKernel;
  beforeAll(async () => {
    await ensureGeom2dReady();
    await ensureEngineClipperReady();
    kernel = new BvhKernel();
  });

  it('provably avoids the 10 mm ring: corner nibbles only, read the same on a 47-column grid', { timeout: 600000 }, async () => {
    const mesh = shakedownRingPart();
    const bounds: Box3 = { minX: 0, minY: 0, minZ: 0, maxX: 130, maxY: 70, maxZ: SD_Z_TOP };
    const handle = kernel.uploadMesh(mesh);
    try {
      const input: AdaptiveRoughInput = {
        mesh: handle,
        cutter: CUTTER,
        stockBounds: bounds,
        stockBoundsAreRealStock: true,
        cellSize: APP_CELL,
        maxStepdown: 3,
        stepover: 0.4,
        tolerance: 0.05,
        helixDiameter: 3,
        heights: { clearanceZ: SD_Z_TOP + 10, retractZ: SD_Z_TOP + 5, feedZ: SD_Z_TOP + 5 },
        materialTopZ: SD_Z_TOP,
      };
      // Reading (b) would be an emitted path with centimetres of cutting down the
      // ring's legs and a ruler that read nothing there. Reading (a) is what the
      // shakedown saw and what is pinned here: the path is emitted (no refusal),
      // the ring is entered only where the cutter fits, and the ruler's read of
      // those bites is confirmed by a replay four times finer than the app's.
      const ir = await adaptiveRough(kernel, input);
      const moves = ir.moves;
      const engagement = measurePathEngagement(moves, bounds, APP_CELL, CUTTER, {
        capFraction: SIDE_ENTRY_ENGAGEMENT_CAP,
      });
      const where = lateralCuttingBy(moves);
      const FINE_CELL = 0.2; // 47.6 columns across the cutter; replayCellFor keeps it
      const app = ringPeak(moves, bounds, APP_CELL);
      const fine = ringPeak(moves, bounds, FINE_CELL);
      const appRingPeak = app.all;
      const fineRingPeak = fine.all;
      const plan = ringPlanCut(moves, bounds, FINE_CELL);
      const roles = [...new Set([...app.byRole.keys(), ...fine.byRole.keys()])].sort();
      // eslint-disable-next-line no-console
      console.log(
        `WO-1269 shakedown ring: EMITTED ${moves.length} moves; ruler peak ${(engagement.peakFraction * 100).toFixed(1)}% `
        + `at (${engagement.peakAt?.x.toFixed(1)}, ${engagement.peakAt?.y.toFixed(1)}), over cap ${engagement.overCapLengthMm.toFixed(1)} mm, `
        + `longest run ${engagement.longestOverCapRunMm.toFixed(1)} mm; lateral cutting: ring corners ${where.corners.toFixed(1)} mm, `
        + `ring legs ${where.legs.toFixed(1)} mm, everywhere ${where.total.toFixed(1)} mm; `
        + `ring plan area (${FINE_CELL} mm replay) ${plan.ringMm2.toFixed(0)} mm^2, cut ${plan.cutMm2.toFixed(0)} mm^2 = ${pct(plan.cutMm2, plan.ringMm2)}, `
        + `corner squares ${plan.cornersCutMm2.toFixed(0)} / ${plan.cornersMm2.toFixed(0)} mm^2 = ${pct(plan.cornersCutMm2, plan.cornersMm2)}, `
        + `legs ${plan.legsCutMm2.toFixed(0)} / ${plan.legsMm2.toFixed(0)} mm^2 = ${pct(plan.legsCutMm2, plan.legsMm2)} (corner-bite reach band ${(8 * CORRIDOR * R).toFixed(0)} mm^2); `
        + `in-ring peak ${(appRingPeak * 100).toFixed(1)}% at the app's ${APP_CELL.toFixed(2)} mm cell vs ${(fineRingPeak * 100).toFixed(1)}% at ${FINE_CELL} mm`
        + `; per role: ${roles.map((r) => `${r} ${((app.byRole.get(r) ?? 0) * 100).toFixed(1)}% vs ${((fine.byRole.get(r) ?? 0) * 100).toFixed(1)}%`).join(', ')}`,
      );
      // The ring material that went is in the corner squares. The cutter's axis
      // never entered a leg (where.legs, below), so the only leg plan area it can
      // have touched is the rim of a corner bite: within one radius of a corner
      // square, i.e. at most a CORRIDOR x R band at each of the eight leg ends.
      const legReachBandMm2 = 8 * CORRIDOR * R;
      expect(plan.cornersCutMm2 / plan.cornersMm2).toBeGreaterThan(plan.legsCutMm2 / plan.legsMm2);
      expect(plan.legsCutMm2).toBeLessThanOrEqual(legReachBandMm2);
      // The wide pocket was cut; nothing anywhere is over the cap.
      expect(where.total).toBeGreaterThan(500);
      expect(engagement.peakFraction).toBeLessThanOrEqual(SIDE_ENTRY_ENGAGEMENT_CAP);
      expect(engagement.longestOverCapRunMm).toBe(0);
      // The ring's legs - the only place a 9.52 mm cutter in a 10 mm corridor can
      // slot - carry no lateral cutting at all. The corners do, and that is fine.
      expect(where.legs).toBeLessThan(1);
      expect(where.corners).toBeGreaterThan(10);
      // The ruler saw those corner bites: a 0.2 mm replay of the same moves puts
      // the in-ring peak within two app-cell columns of the app-cell read - the
      // column quantum of test 2 plus the rim of the entry disc, which is most of
      // what a 1 mm bite's 2 mm window contains - and both are well under the cap.
      expect(Math.abs(appRingPeak - fineRingPeak)).toBeLessThanOrEqual(2 * (APP_CELL / D));
      expect(fineRingPeak).toBeLessThan(SIDE_ENTRY_ENGAGEMENT_CAP);
      expect(appRingPeak).toBeGreaterThan(0.1); // the bites are real cutting, not noise
    } finally {
      kernel.releaseMesh(handle);
    }
  });
});
