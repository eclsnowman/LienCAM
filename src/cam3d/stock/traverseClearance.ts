// cam3d stock: "is this traverse clear of material?" -- the read-only mirror of
// removeSweep.
//
// WO-096. removeSweep answers "what does this move REMOVE". This module answers
// the safety question nobody was asking: "what would this move HIT". Same field,
// same cutter profile, same capsule footprint -- but it never mutates and it
// reports the worst intrusion instead of a removed volume.
//
// COLLISION MODEL (mirrors cutterProfile.ts exactly). With the tool tip at z,
// the cutter occupies, in a column at radial distance r from the tool axis,
// everything from z + height(r) UPWARD (the shank continues forever -- which is
// why one z-dexel interval per column is exact here, D-016). So a column with
// material top T collides iff
//     T > z + height(r)
// and the INTRUSION depth is T - (z + height(r)) mm.
//
// CONSERVATIVE BY CONSTRUCTION -- this is a safety query, so every approximation
// leans toward "unsafe":
//  - horizontal moves (z0 === z1) use the exact closed-form point-to-segment
//    distance, same as sweepHorizontal;
//  - z-VARYING moves are evaluated at the LOWEST tip z of the whole segment,
//    so the answer can only over-report, never miss a hit between samples
//    (removeSweep's stepping is allowed to under-remove; a safety check is not
//    allowed to under-detect);
//  - an EMPTY column (top === bottom, the canonical empty encoding) holds no
//    material and is skipped.
//
// Determinism (D-006): fixed iteration order (j outer, i inner), no RNG; the
// reported witness column is the worst one, ties broken by first-seen order.

import type { CutterSpec } from '../kernel/types';
import { sweepProfile } from './cutterProfile';
import type { LinearMove } from './removeSweep';
import type { ZDexelField } from './zdexel';

/** Worst material contact found under a swept move. */
export interface TraverseIntrusion {
  /**
   * Depth the material rises INTO the tool, mm. <= 0 means the move is clear
   * (and its magnitude is the smallest gap found under the swept footprint);
   * -Infinity means the footprint touched no material at all.
   */
  intrusionMm: number;
  /** Center of the worst column, mm (NaN when nothing was under the sweep). */
  x: number;
  y: number;
  /** Material top of the worst column, mm. */
  materialTopZ: number;
  /** Tool-tip z at which the cutter just touches the worst column. */
  contactTipZ: number;
  /** Tool tip z the worst column was judged against, mm. */
  tipZ: number;
  /** Columns inspected (footprint size); 0 means the sweep left the field. */
  columnsTested: number;
}

const CLEAR: TraverseIntrusion = Object.freeze({
  intrusionMm: Number.NEGATIVE_INFINITY,
  x: NaN,
  y: NaN,
  materialTopZ: NaN,
  contactTipZ: NaN,
  tipZ: NaN,
  columnsTested: 0,
});

/** Inclusive column-index range whose CENTERS can lie within [lo, hi]. */
function idxRange(lo: number, hi: number, origin: number, cell: number, n: number): [number, number] {
  const a = Math.max(0, Math.floor((lo - origin) / cell - 0.5));
  const b = Math.min(n - 1, Math.ceil((hi - origin) / cell - 0.5));
  return [a, b];
}

/**
 * Worst material intrusion into the cutter along a linear tool-tip move.
 *
 * Positive `intrusionMm` means the move drives the tool through material that
 * is still standing in `field` -- for a rapid or a traverse that is a crash.
 * Flat and ball cutters only (sweepProfile fails loud otherwise).
 */
export function maxTraverseIntrusion(
  field: ZDexelField,
  move: LinearMove,
  cutter: CutterSpec,
): TraverseIntrusion {
  for (const [v, label] of [
    [move.x0, 'x0'], [move.y0, 'y0'], [move.z0, 'z0'],
    [move.x1, 'x1'], [move.y1, 'y1'], [move.z1, 'z1'],
  ] as const) {
    if (!Number.isFinite(v)) {
      throw new Error(`maxTraverseIntrusion: move.${label} must be finite, got ${v}.`);
    }
  }

  const prof = sweepProfile(cutter);
  const R = prof.radius;
  const isBall = prof.kind === 'ball';
  const r2 = R * R;

  const { nx, ny, cell, originX, originY, top, bottom } = field;
  const ax = move.x0;
  const ay = move.y0;
  const abx = move.x1 - move.x0;
  const aby = move.y1 - move.y0;
  const ab2 = abx * abx + aby * aby;
  // Z-varying (and vertical) moves are judged at the LOWEST tip z of the whole
  // segment -- the conservative choice (see module header).
  const tipZ = move.z0 === move.z1 ? move.z0 : Math.min(move.z0, move.z1);

  const [i0, i1] = idxRange(
    Math.min(move.x0, move.x1) - R, Math.max(move.x0, move.x1) + R, originX, cell, nx,
  );
  const [j0, j1] = idxRange(
    Math.min(move.y0, move.y1) - R, Math.max(move.y0, move.y1) + R, originY, cell, ny,
  );

  let worst = Number.NEGATIVE_INFINITY;
  let wx = NaN;
  let wy = NaN;
  let wTop = NaN;
  let wHeightAboveTip = 0;
  let tested = 0;

  for (let j = j0; j <= j1; j++) {
    const cy = originY + (j + 0.5) * cell;
    const wyOff = cy - ay;
    const rowBase = j * nx;
    for (let i = i0; i <= i1; i++) {
      const cx = originX + (i + 0.5) * cell;
      const wxOff = cx - ax;
      let d2: number;
      if (ab2 > 0) {
        let t = (wxOff * abx + wyOff * aby) / ab2;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const ex = wxOff - t * abx;
        const ey = wyOff - t * aby;
        d2 = ex * ex + ey * ey;
      } else {
        d2 = wxOff * wxOff + wyOff * wyOff;
      }
      if (d2 > r2) continue;
      tested++;
      const c = rowBase + i;
      const t0 = top[c];
      // Canonical empty encoding: top === bottom means no material here.
      if (!(t0 > bottom[c])) continue;
      const heightAboveTip = isBall ? R - Math.sqrt(r2 - d2) : 0;
      const intrusion = t0 - (tipZ + heightAboveTip);
      if (intrusion > worst) {
        worst = intrusion;
        wx = cx;
        wy = cy;
        wTop = t0;
        wHeightAboveTip = heightAboveTip;
      }
    }
  }

  if (tested === 0) return CLEAR;
  if (worst === Number.NEGATIVE_INFINITY) {
    return {
      intrusionMm: worst,
      x: NaN,
      y: NaN,
      materialTopZ: NaN,
      contactTipZ: NaN,
      tipZ,
      columnsTested: tested,
    };
  }
  return {
    intrusionMm: worst,
    x: wx,
    y: wy,
    materialTopZ: wTop,
    contactTipZ: wTop - wHeightAboveTip,
    tipZ,
    columnsTested: tested,
  };
}

/** How much of the cutter face still stands above a plunge floor. */
export interface PlungeUncut {
  /** Columns whose centre lies under the cutter disk (0 = the disk left the field). */
  columns: number;
  /** Of those, columns with material still above the tool tip at `tipZ`. */
  uncutColumns: number;
  /** uncutColumns / columns (0 when nothing is under the disk). */
  fraction: number;
  /** Highest tool-tip contact among the uncut columns (-Infinity when none). */
  highestContactTipZ: number;
}

/**
 * Fraction of the cutter face that would meet standing material on a straight
 * descent to `tipZ` at (x, y) -- the honest measure for "is this plunge into
 * a cleared shaft or into a wall of stock". Same footprint test as
 * maxTraverseIntrusion (column centres within R, ball height per column), so
 * the two agree column for column; this one counts instead of taking the worst.
 * A column counts as uncut when its top is more than `eps` above the tip.
 */
export function plungeUncutFraction(
  field: ZDexelField,
  x: number,
  y: number,
  tipZ: number,
  cutter: CutterSpec,
  eps = 1e-3,
): PlungeUncut {
  const prof = sweepProfile(cutter);
  const R = prof.radius;
  const isBall = prof.kind === 'ball';
  const r2 = R * R;
  const { nx, ny, cell, originX, originY, top, bottom } = field;
  const [i0, i1] = idxRange(x - R, x + R, originX, cell, nx);
  const [j0, j1] = idxRange(y - R, y + R, originY, cell, ny);
  let columns = 0;
  let uncut = 0;
  let highest = Number.NEGATIVE_INFINITY;
  for (let j = j0; j <= j1; j++) {
    const dy = originY + (j + 0.5) * cell - y;
    const rowBase = j * nx;
    for (let i = i0; i <= i1; i++) {
      const dx = originX + (i + 0.5) * cell - x;
      const d2 = dx * dx + dy * dy;
      if (d2 > r2) continue;
      columns++;
      const c = rowBase + i;
      const t0 = top[c];
      if (!(t0 > bottom[c])) continue;
      const heightAboveTip = isBall ? R - Math.sqrt(r2 - d2) : 0;
      if (t0 > tipZ + heightAboveTip + eps) {
        uncut++;
        highest = Math.max(highest, t0 - heightAboveTip);
      }
    }
  }
  return {
    columns,
    uncutColumns: uncut,
    fraction: columns > 0 ? uncut / columns : 0,
    highestContactTipZ: highest,
  };
}
