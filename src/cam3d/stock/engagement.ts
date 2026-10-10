// cam3d stock: cutter-workpiece engagement (CWE) for a candidate move.
//
// WHAT IS RETURNED (honest contract): removedVolume / moveLength in mm^2 --
// the AVERAGE cross-section area of material removed, normal to travel,
// over the whole move. It is computed from the exact per-column top deltas
// the sweep WOULD produce (on a clone; the field is NOT mutated), so it is
// consistent with the stock model by construction:
//   - 0 when the tool is entirely above / outside the stock,
//   - monotonically increasing with depth of cut for a given move,
//   - for a long straight slot at depth d with a flat tool of diameter D it
//     approaches D * d as length grows (entry/exit discs amortize away).
//
// It is an AVERAGE, not an instantaneous engagement profile along the move
// -- Phase 4/6 consumers that need per-sample engagement (feed optimization,
// adaptive stepover) will replace this with an incremental sweep query.
// PERF NOTE (WO-2096): the sweep runs on the caller's field and the columns it
// can touch are restored before return, instead of cloning the whole field per
// call (an adaptive rough's entry check cloned a 1M-column field per probe).
// Planning-time probes only; do NOT call per-simulation-frame -- the Phase 4/6
// replacement computes deltas in the move's footprint only.
//
// Zero-length moves return 0 (no travel, no cross-section to define); a
// pure vertical plunge uses |z1 - z0| as the move length, so its value is
// the plunge's average annular/full-disc area.

import type { CutterSpec } from '../kernel/types';
import { sweepProfile } from './cutterProfile';
import { removeSweep, type LinearMove } from './removeSweep';
import type { ZDexelField } from './zdexel';

/**
 * Inclusive column range of `removeSweep`'s footprint along one axis, one
 * column wider on each side. removeSweep writes only `top`, and only inside
 * the same centre-conservative range of the move's bbox inflated by the cutter
 * radius (every plunge/ramp stamp centre lies on the move, within a rounding
 * error of that bbox -- the extra column covers it).
 */
function sweptRange(lo: number, hi: number, origin: number, cell: number, n: number): [number, number] {
  const a = Math.max(0, Math.floor((lo - origin) / cell - 0.5) - 1);
  const b = Math.min(n - 1, Math.ceil((hi - origin) / cell - 0.5) + 1);
  return [a, b];
}

/**
 * Average engaged cross-section (mm^2) for `move` against the CURRENT field
 * state. Does not mutate the field. See module header for the exact
 * definition and its limits.
 */
export function engagementAt(field: ZDexelField, move: LinearMove, cutter: CutterSpec): number {
  const dx = move.x1 - move.x0;
  const dy = move.y1 - move.y0;
  const dz = move.z1 - move.z0;
  const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
  if (len === 0) return 0;
  const { x0, y0, x1, y1 } = move;
  if (!Number.isFinite(len) || !Number.isFinite(x0) || !Number.isFinite(y0)
    || !Number.isFinite(x1) || !Number.isFinite(y1)) {
    // removeSweep refuses a non-finite move by name before it writes anything.
    return removeSweep(field, move, cutter).removedVolumeMm3 / len;
  }
  const radius = sweepProfile(cutter).radius;
  const [i0, i1] = sweptRange(
    Math.min(x0, x1) - radius, Math.max(x0, x1) + radius, field.originX, field.cell, field.nx,
  );
  const [j0, j1] = sweptRange(
    Math.min(y0, y1) - radius, Math.max(y0, y1) + radius, field.originY, field.cell, field.ny,
  );
  const width = i1 - i0 + 1;
  const rows = j1 - j0 + 1;
  if (width <= 0 || rows <= 0) {
    // The footprint misses the field: removeSweep has no column to write.
    return removeSweep(field, move, cutter).removedVolumeMm3 / len;
  }
  const saved = new Float32Array(width * rows);
  for (let row = 0; row < rows; row++) {
    const start = (j0 + row) * field.nx + i0;
    saved.set(field.top.subarray(start, start + width), row * width);
  }
  try {
    return removeSweep(field, move, cutter).removedVolumeMm3 / len;
  } finally {
    for (let row = 0; row < rows; row++) {
      field.top.set(saved.subarray(row * width, (row + 1) * width), (j0 + row) * field.nx + i0);
    }
  }
}
