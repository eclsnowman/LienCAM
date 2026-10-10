// cam3d stock: subtract a linear tool move from the z-dexel field.
//
// The move is the TOOL TIP path. For a radially-monotone cutter the material
// surface a sweep leaves in a column is
//   envelope(col) = min over t in [0,1] of  tipZ(t) + height(dist_xy(col, axis(t)))
// and the update is simply  top = min(top, envelope)  per column (D-016).
//
// Two paths:
//  - HORIZONTAL moves (z0 === z1), the perf path (simulation replay is
//    dominated by these): the min over t collapses in closed form to
//    z + height(point-to-segment xy distance), so each column is one
//    distance computation -- no stepping, exact up to f32 storage rounding.
//    The loop touches only the columns inside the capsule footprint
//    (segment bbox inflated by R) and its body is branch-minimal: one
//    footprint test, one min.
//  - Z-VARYING moves (ramps): parametric stepping with sample spacing
//    ds <= cell/2 along the move, stamping the instantaneous circular
//    imprint at each sample and min-ing per column. ERROR BOUND (honest):
//    stamps UNDER-remove, never over-remove. Between samples the tool
//    travels <= ds, so the un-stamped envelope differs by at most ds/2
//    laterally (imprint boundary raggedness <= cell/4, below the field's
//    own cell resolution) and |z1-z0|/len * ds/2 vertically on the flat of
//    the profile. Near a BALL cutter's rim the profile slope diverges, so
//    the vertical error there is bounded not by the slope but by the
//    lateral quantization (height change across ds/2 of rim), i.e. the
//    same cell-resolution bound that already limits the field's fidelity.
//  - A vertical plunge (x0 == x1, y0 == y1) degenerates cleanly to ONE
//    circular imprint at min(z0, z1) -- handled explicitly, and the generic
//    stepping path would produce the identical result.
//
// Determinism (D-006): fixed iteration order (j outer, i inner, samples in
// t order), no RNG; identical inputs give byte-identical arrays. Cutting at
// or below the field bottom clamps to the canonical empty encoding
// (top === bottom exactly).

import type { CutterSpec } from '../kernel/types';
import { sweepProfile } from './cutterProfile';
import type { ZDexelField } from './zdexel';

/** Linear tool-tip move, mm world coordinates. */
export interface LinearMove {
  x0: number;
  y0: number;
  z0: number;
  x1: number;
  y1: number;
  z1: number;
}

export interface SweepResult {
  /**
   * Material removed by THIS sweep, mm^3: sum over changed columns of
   * (oldTop - newTop) * cell^2, accumulated in f64 from the f32 tops.
   */
  removedVolumeMm3: number;
  /**
   * Number of column-top updates applied. On the horizontal perf path this
   * equals distinct columns changed; a ramp's stepped stamps may update the
   * same column more than once.
   */
  columnsChanged: number;
}

function assertMoveFinite(move: LinearMove): void {
  for (const [v, label] of [
    [move.x0, 'x0'], [move.y0, 'y0'], [move.z0, 'z0'],
    [move.x1, 'x1'], [move.y1, 'y1'], [move.z1, 'z1'],
  ] as const) {
    if (!Number.isFinite(v)) {
      throw new Error(`removeSweep: move.${label} must be finite, got ${v}.`);
    }
  }
}

/** Inclusive column-index range whose CENTERS can lie within [lo, hi]. */
function idxRange(lo: number, hi: number, origin: number, cell: number, n: number): [number, number] {
  // Center of column k is origin + (k + 0.5) * cell; conservative by one
  // cell on each side -- the exact footprint test inside the loop filters.
  const a = Math.max(0, Math.floor((lo - origin) / cell - 0.5));
  const b = Math.min(n - 1, Math.ceil((hi - origin) / cell - 0.5));
  return [a, b];
}

/**
 * Subtract the swept volume of `cutter` moving linearly along `move` (tool
 * tip path) from `field`, in place. Returns the removed volume (see
 * SweepResult). Flat and ball cutters only (cutterProfile.ts fails loud on
 * bull/vbit). Re-running the identical sweep is a no-op (idempotent).
 */
export function removeSweep(field: ZDexelField, move: LinearMove, cutter: CutterSpec): SweepResult {
  assertMoveFinite(move);
  const prof = sweepProfile(cutter);
  const R = prof.radius;
  const isBall = prof.kind === 'ball';

  const acc: SweepResult = { removedVolumeMm3: 0, columnsChanged: 0 };
  const dx = move.x1 - move.x0;
  const dy = move.y1 - move.y0;
  const dz = move.z1 - move.z0;

  if (dx === 0 && dy === 0) {
    // Vertical plunge (or zero-length move): one imprint at the lowest tip z.
    stampDisc(field, move.x0, move.y0, Math.min(move.z0, move.z1), R, isBall, acc);
  } else if (dz === 0) {
    sweepHorizontal(field, move, R, isBall, acc);
  } else {
    // Ramp: parametric stepping, sample spacing <= cell/2 along the move.
    const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
    const nSteps = Math.max(1, Math.ceil(len / (field.cell / 2)));
    for (let k = 0; k <= nSteps; k++) {
      const t = k / nSteps;
      stampDisc(field, move.x0 + t * dx, move.y0 + t * dy, move.z0 + t * dz, R, isBall, acc);
    }
  }

  const cellArea = field.cell * field.cell;
  acc.removedVolumeMm3 *= cellArea;
  return acc;
}

/**
 * Perf path: horizontal capsule sweep. envelope = z + height(point-to-
 * segment distance), exact closed form; iterates only the capsule bbox.
 */
function sweepHorizontal(
  field: ZDexelField,
  move: LinearMove,
  R: number,
  isBall: boolean,
  acc: SweepResult,
): void {
  const { nx, ny, cell, originX, originY, top, bottom } = field;
  const z = move.z0;
  const ax = move.x0;
  const ay = move.y0;
  const abx = move.x1 - move.x0;
  const aby = move.y1 - move.y0;
  const ab2 = abx * abx + aby * aby; // > 0: dx==dy==0 handled by caller
  const invAb2 = 1 / ab2;
  const r2 = R * R;

  const [i0, i1] = idxRange(Math.min(move.x0, move.x1) - R, Math.max(move.x0, move.x1) + R, originX, cell, nx);
  const [j0, j1] = idxRange(Math.min(move.y0, move.y1) - R, Math.max(move.y0, move.y1) + R, originY, cell, ny);

  let removed = 0;
  let changed = 0;
  for (let j = j0; j <= j1; j++) {
    const cy = originY + (j + 0.5) * cell;
    const wy = cy - ay;
    const rowBase = j * nx;
    for (let i = i0; i <= i1; i++) {
      const cx = originX + (i + 0.5) * cell;
      const wx = cx - ax;
      // Closest point on the segment (clamped projection).
      let t = (wx * abx + wy * aby) * invAb2;
      t = t < 0 ? 0 : t > 1 ? 1 : t;
      const ex = wx - t * abx;
      const ey = wy - t * aby;
      const d2 = ex * ex + ey * ey;
      if (d2 <= r2) {
        const env = isBall ? z + R - Math.sqrt(r2 - d2) : z;
        const c = rowBase + i;
        const bot = bottom[c];
        const nt = env < bot ? bot : env;
        const cur = top[c];
        if (nt < cur) {
          top[c] = nt;
          removed += cur - top[c]; // f32 round-trip: charge the STORED delta
          changed++;
        }
      }
    }
  }
  acc.removedVolumeMm3 += removed;
  acc.columnsChanged += changed;
}

/** One circular imprint of the tip at (x, y, z): top = min(top, z + height(d)). */
function stampDisc(
  field: ZDexelField,
  x: number,
  y: number,
  z: number,
  R: number,
  isBall: boolean,
  acc: SweepResult,
): void {
  const { nx, ny, cell, originX, originY, top, bottom } = field;
  const r2 = R * R;
  const [i0, i1] = idxRange(x - R, x + R, originX, cell, nx);
  const [j0, j1] = idxRange(y - R, y + R, originY, cell, ny);

  let removed = 0;
  let changed = 0;
  for (let j = j0; j <= j1; j++) {
    const ey = originY + (j + 0.5) * cell - y;
    const ey2 = ey * ey;
    const rowBase = j * nx;
    for (let i = i0; i <= i1; i++) {
      const ex = originX + (i + 0.5) * cell - x;
      const d2 = ex * ex + ey2;
      if (d2 <= r2) {
        const env = isBall ? z + R - Math.sqrt(r2 - d2) : z;
        const c = rowBase + i;
        const bot = bottom[c];
        const nt = env < bot ? bot : env;
        const cur = top[c];
        if (nt < cur) {
          top[c] = nt;
          removed += cur - top[c];
          changed++;
        }
      }
    }
  }
  acc.removedVolumeMm3 += removed;
  acc.columnsChanged += changed;
}
