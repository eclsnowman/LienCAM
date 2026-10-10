// cam3d rough: CRITICAL DEPTHS -- the horizontal part surfaces a depth ladder
// must land on exactly.
//
// WHY (WO-101). A Z-level rougher clears the plan-view area where stock remains
// above the level MINUS the area where the part remains above it (cutRegionAt).
// A flat part surface at height h is therefore only cut at levels z >= h: the
// LOWEST level that touches it is the lowest ladder level at or above h. If the
// ladder has no level exactly at h, everything between h and that level is
// silently left behind -- a remainder thinner than one full stepdown.
//
// planLevels pins its LAST level exactly on the global floor, so the deepest
// surface in the job is always reached; nothing pins any OTHER horizontal
// surface. That is one mechanism with two visible symptoms:
//   - a POCKET FLOOR above the global floor keeps up to one stepdown of stock
//     (Operator: three rings down the wall, then a vertical gap to the floor);
//   - the part's OWN TOP FACE below the stock top keeps the whole skim, because
//     the first level is already a full stepdown below the stock top.
// Both vanish once the ladder is required to land on those surfaces.
//
// WHAT COUNTS AS A SURFACE. Two SEPARATE questions, asked of two different
// measurements of the same connected equal-height component -- and keeping
// them separate is the whole point (see "WHY NOT EROSION" below):
//
//  1. IS THIS A PLANE AT ALL? At least one column in the component must be
//     LOCALLY HORIZONTAL, which it is by EITHER of two tests (see "GRID
//     RESOLUTION" below for why it takes two):
//       (a) UNANIMITY: every in-grid neighbour that carries part material is
//           level with it within `flatTol`, and at least one is.
//       (b) QUAD: the column is one corner of a 2 x 2 block of columns that are
//           ALL level with it within `flatTol`.
//     Either way the test means "flat" rather than "same height": on a sphere
//     sampled over a square grid, the 8-fold symmetry puts eight SCATTERED
//     columns at bit-identical heights, and area alone would read that as a
//     flat and mint a level for it (measured: a hemisphere fixture planned 35
//     levels instead of 5). On a dome adjacent columns differ by
//     (r/sqrt(R^2-r^2)) * cell, which only vanishes within microns of the pole,
//     so no dome column is level with any neighbour, let alone with three.
//     A neighbour that is OPEN AIR (or off the grid) is the EDGE of the face
//     and votes neither way in (a): a face standing proud in air is still a
//     face. (b) needs three REAL level neighbours and gets no such abstention,
//     which is what keeps it from firing on grid noise.
//  2. IS IT BIG ENOUGH TO STAND ON? A connected equal-height component's FULL
//     plan-view area -- every column in that component, horizontal or not --
//     must reach `minFlatArea`. The caller passes the tool's own cross-section,
//     since a flat smaller than the tool can never be cleared by it anyway.
//
// BOTH ANSWERS ARE READINGS OF A SAMPLED FIELD, NOT OF THE PART. partField
// samples cell CENTRES, so a cell counts towards a face only when the face
// swallows its centre. Both questions therefore under-read a face by up to a
// column all round, and neither can be trusted to say NO on its own once the
// cell is an appreciable fraction of the tool. That is what "WHERE EXACTLY THE
// REFUSAL IS KEYED" below is about, and what the extent bound used there is
// for: one connected face holds its sampled centres and NO neighbouring centre.
// A face can still bulge diagonally between sample rows, so the component's
// largest possible axis extents use the diagonal phase envelope of its sampled
// bounding box, not just one cell of axis-aligned padding. Disconnected samples
// at the same height cannot establish one face (WO-134 audit fix), and samples
// that meet only at a grid corner remain separate just as remainingAbove's
// physical mask keeps them separate (WO-221). That component bound decides
// whether a NO is trustworthy or has to become a refusal.
//
// WHY NOT EROSION (audit of WO-101 attempt 1). Answering question 2 with the
// columns that survived question 1 measures the face ERODED by one column all
// round, which rejects faces the cutter fits on with room to spare: a 4 x 4 mm
// face on a 1 mm grid is 16 mm^2 against a 3 mm cutter's 7.0686 mm^2, but its
// eroded interior is 2 x 2 = 4 mm^2, so it was dropped and the ladder stepped
// straight over it -- exactly the sub-stepdown remainder this file exists to
// remove. Horizontality is evidence about the PLANE; it is not a measure of the
// plane's SIZE. One locally horizontal column is enough to tell a plane from a
// curve; that connected component's area then decides whether the tool can use
// it. Disconnected sub-tool faces never pool their area into a fictitious face.
//
// GRID RESOLUTION, and why test (b) exists (WO-134). Unanimity alone is a
// statement about the GRID, not about the cutter: a face only TWO cells wide
// and bordered by material on every side has NO unanimous column, because every
// one of its cells touches the lower material on at least one side. The audit
// of WO-101 ran it -- a 4 x 4 mm face at 2 mm cells (16 mm^2, against a 3 mm
// cutter's 7.0686 mm^2, and wider than the cutter in both directions) returned
// no pin at all, so the ladder stepped over it and left a remainder the caller
// was told would be cut. `cellSize` is caller-supplied and ZDexelField coarsens
// it further under the cell budget, so that is a real job, not a curiosity.
//
// The quad test is the narrowest thing that fixes it. A 2 x 2 block of columns
// at one height IS a plane at grid resolution, and every artefact unanimity
// exists to reject is at most ONE cell wide somewhere: a quantised slope's
// contours are 1-column strips, a cone's are 1-column rings, a dome's are
// scattered points, a ridge crest is a 1-column line. None of those closes a
// quad, so (b) admits no case (a) was protecting against -- it is strictly an
// additional way to qualify, so no face (a) already pinned can be lost.
//
// WHERE THE GRID CAN NO LONGER JUDGE, REFUSE (WO-134 fix round). The quad
// HANDLES the two-cell case. The ONE-cell case cannot be handled: a single
// sample of a 4 x 4 mm face and a single sample of a dome's pole are the same
// four numbers, so pinning it would mint a level on every curve (the
// overcorrection WO-134 names) and dropping it silently leaves commanded
// material -- the defect this file exists to remove, one resolution coarser.
// So the third answer is the only honest one: REFUSE the job by name, stating
// the cell size and the face (see gridResolutionError).
//
// WHERE EXACTLY THE REFUSAL IS KEYED (WO-134 round 3, and this is the whole
// correction). Round 2 keyed it at `cellArea >= minFlatArea` -- one column
// already tool-SIZED. That is far too late, and its own audit ran the proof: a
// 3.2 x 3.2 mm pocket floor, wider than a 3 mm cutter in both directions, on a
// 2 mm grid whose phase puts a single sample inside it. One column, 4 mm^2
// represented against the cutter's 7.0686 mm^2 -- below the old trigger, so the
// job was ACCEPTED and the ladder stepped over the floor. Same defect, same
// silence, one band lower.
//
// The honest key is not "how big is a column" but "can this grid still SEE a
// face the tool can stand on". Question 1 needs a 2 x 2 level block. The part
// field samples one point per cell (partField.ts: a near-point probe at cell
// CENTRES), so a face is seen only through the centres that fall inside it, and
// the grid's phase against the part is arbitrary. Worst phase for a round face
// of diameter `across` is its centre landing ON a lattice point: the nearest
// full 2 x 2 block then has its far corner at cell*sqrt(2), so the block is
// inside the face iff across/2 >= cell*sqrt(2). Hence
//
//     RESOLVING CELL = across / (2*sqrt(2))  ~= 0.3536 * tool diameter
//
// At or below it, EVERY face the tool can stand on closes a quad whatever the
// phase, so a bucket with no locally horizontal column really is a curve and
// dropping it is a statement about the part. Above it the grid may or may not
// see such a face depending on nothing but where the stock box happens to
// start -- and it demonstrably does not: the WO's own 4 x 4 mm face pins at
// 2 mm cells on one stock origin and vanishes on an origin half a cell over.
// That is not a part property, so it may not decide whether material is left.
//
// So above the resolving cell the scan REFUSES over every component that does
// not earn a level -- whether question 1 could not call it a plane or question
// 2 read its area short, because above this cell size neither NO is trustworthy.
// A component that PINS is untouched, and one whose samples could not reach
// `across` even at their largest possible extent is dropped in silence exactly
// as before, so a genuinely sub-tool feature stays quiet and a maybe-tool-sized
// one is loud.
//
// AT OR BELOW the resolving cell the refusal stays inactive. Component-local
// area still matters there: disconnected sub-tool faces must not pool their
// samples into a false tool-sized face.
//
// The cost of this is real and it is the one the WO chose: a sloped or curved
// part roughed on a grid coarser than ~0.35 x the tool now REFUSES, where it
// used to run and might have left a tread standing. It refuses with the cell
// size that would work, so the caller has an action; it mints no level, so it
// is not the overcorrection WO-134 forbids; and it never fires below the
// resolving cell, where the ramp, cone and dome controls all still return
// nothing at all.
//
// EXACTNESS. The depth reported for a bucket is the MAXIMUM height among its
// locally horizontal columns (plus axialStockToLeave), never the bucket centre.
// remainingAbove treats a column as part when top > z + epsilon, so pinning the
// level at that MAX guarantees every column of that surface reads as cuttable at
// its own level. Rounding to the bucket centre instead would leave the highest
// columns of the face masked and reintroduce the very remainder this fixes.
//
// NO CAP. Every qualifying face is pinned. The count is already bounded by the
// physics: each pinned face consumes at least `minFlatArea` of DISTINCT plan
// area (a column lands in exactly one bucket), so the result can never exceed
// planArea / minFlatArea, and curved or sloped stock mints nothing at all. A
// fixed cap on top of that would silently drop a face the caller was told would
// be cut -- the defect this file exists to remove.
//
// DETERMINISM (D-006): a row-major connected-component walk followed by a
// fixed-width histogram over [floorZ, stockTopZ] in descending bin order. No
// maps keyed by float, no iteration-order dependence, no sort, no allocation
// per column.

import type { ZDexelField } from '../stock';

/** Height resolution (mm) at which two part surfaces count as the SAME plane. */
export const CRITICAL_DEPTH_QUANTUM = 1e-3;

/**
 * `Error.name` of the refusal above -- the grid is too coarse to tell a
 * commanded face from a sample of a curve, so the operation declines the job
 * instead of planning a ladder that steps over it. Matched by name the way
 * 'AbortError' is.
 */
export const GRID_RESOLUTION_ERROR_NAME = 'GridResolutionError';

/**
 * Grid pitch, as a fraction of the smallest commanded flat's width, at or below
 * which question 1 is guaranteed to see that flat WHATEVER the grid's phase.
 * Worst phase puts the face's centre on a lattice point; the nearest full 2 x 2
 * block of centres then has its far corner at cell*sqrt(2) from it, so the
 * block lies inside the face iff across/2 >= cell*sqrt(2). See the header.
 */
const RESOLVING_CELL_FRACTION = 1 / (2 * Math.SQRT2); // ~= 0.35355

/** One height the grid carries material at that it cannot call a plane, and
 *  cannot rule out as a face the tool could stand on either. */
interface UnresolvedFace {
  /** Highest such column in the bucket, in the same frame as a returned depth. */
  depth: number;
  /** Columns whose material top lands in this bucket. */
  columns: number;
  /** Plan-view area those columns represent, mm^2 (a LOW reading -- see below). */
  area: number;
  /** Largest face those samples could belong to, mm, on the x and y axes. */
  maxWidth: number;
  maxDepth: number;
}

function gridResolutionError(
  cell: number,
  across: number,
  minFlatArea: number,
  resolvingCell: number,
  unresolved: readonly UnresolvedFace[],
): Error {
  const shown = unresolved
    .slice(0, 3)
    .map(
      (u) =>
        `Z=${u.depth} (${u.columns} column${u.columns === 1 ? '' : 's'}, ` +
        `${u.area.toFixed(4)} mm^2 sampled, a face of up to ` +
        `${u.maxWidth.toFixed(4)} x ${u.maxDepth.toFixed(4)} mm)`,
    )
    .join(', ');
  const more = unresolved.length > 3 ? `, and ${unresolved.length - 3} more` : '';
  const err = new Error(
    `findCriticalDepths: cannot resolve a commanded face at this cell size. ` +
      `The tool needs a flat ${across.toFixed(4)} mm across ` +
      `(${minFlatArea.toFixed(4)} mm^2), but this grid takes one sample per ` +
      `${cell} mm cell, so a face that size can land on as few as one column ` +
      `depending only on where the stock box starts -- and one sample of a face ` +
      `cannot be told apart from one sample of a curve. ` +
      `${unresolved.length} height${unresolved.length === 1 ? '' : 's'} ` +
      `carr${unresolved.length === 1 ? 'ies' : 'y'} material this grid cannot call a ` +
      `plane and cannot rule out as a face the tool would fit on: ${shown}${more}. ` +
      `Refusing the job rather than planning a ladder that steps over it and leaves ` +
      `the material standing. Use a cell size of at most ` +
      `${resolvingCell.toFixed(4)} mm, so a face the tool can stand on always spans a ` +
      `2 x 2 block of columns.`,
  );
  err.name = GRID_RESOLUTION_ERROR_NAME;
  return err;
}

/** Histogram bin ceiling; the quantum coarsens if a job's Z range needs more. */
const MAX_BINS = 1_000_000;

export interface CriticalDepthOpts {
  /** Top of the ladder (stock top), mm. */
  stockTopZ: number;
  /** Bottom of the ladder (already includes axialStockToLeave), mm. */
  floorZ: number;
  /** Axial finish stock left on horizontal faces, mm (raises each depth). */
  axialStockToLeave?: number;
  /** Minimum plan-view area (mm^2) for a flat to earn its own level. */
  minFlatArea: number;
  /** Height resolution; defaults to CRITICAL_DEPTH_QUANTUM. */
  quantum?: number;
  /**
   * Max height difference (mm) to a neighbouring column for the surface to
   * count as LEVEL there. Defaults to `quantum`. This, not the area, is what
   * separates a flat face from a curve that happens to repeat a height.
   */
  flatTol?: number;
}

/**
 * Verdict of neighbour column `n` on whether height `t` is a horizontal plane:
 * `1` it carries material level with `t`, `0` it is open air (the edge of the
 * face -- no evidence either way), `-1` it carries material at another height
 * (so `t` is a slope or a crest here, not a plane).
 */
function neighbourVerdict(
  top: Float32Array,
  bottom: Float32Array,
  n: number,
  t: number,
  flatTol: number,
): -1 | 0 | 1 {
  const nt = top[n];
  if (!(nt > bottom[n])) return 0; // open air / no part: this is an edge
  const dz = nt - t;
  return (dz < 0 ? -dz : dz) <= flatTol ? 1 : -1;
}

/**
 * Z heights, STRICTLY between `floorZ` and `stockTopZ` and sorted DESCENDING,
 * at which the ladder must place a level so no horizontal part surface keeps a
 * sub-stepdown remainder. Returns [] when the part has no qualifying flat in
 * range (then planLevels is byte-identical to its 3-argument behaviour).
 */
export function findCriticalDepths(part: ZDexelField, opts: CriticalDepthOpts): number[] {
  const { stockTopZ, floorZ, minFlatArea } = opts;
  const axialStockToLeave = opts.axialStockToLeave ?? 0;
  if (!Number.isFinite(stockTopZ) || !Number.isFinite(floorZ)) {
    throw new Error(`findCriticalDepths: stockTopZ/floorZ must be finite (got ${stockTopZ}, ${floorZ}).`);
  }
  if (!Number.isFinite(axialStockToLeave) || axialStockToLeave < 0) {
    throw new Error(`findCriticalDepths: axialStockToLeave must be finite and >= 0, got ${axialStockToLeave}.`);
  }
  if (!Number.isFinite(minFlatArea) || minFlatArea < 0) {
    throw new Error(`findCriticalDepths: minFlatArea must be finite and >= 0, got ${minFlatArea}.`);
  }
  const range = stockTopZ - floorZ;
  if (!(range > 0)) return [];

  const requested = opts.quantum ?? CRITICAL_DEPTH_QUANTUM;
  if (!Number.isFinite(requested) || requested <= 0) {
    throw new Error(`findCriticalDepths: quantum must be positive and finite, got ${requested}.`);
  }
  // Coarsen rather than allocate an unbounded histogram (ZDexelField's budget
  // convention): a very tall job resolves its flats a little more coarsely.
  const q = Math.max(requested, range / MAX_BINS);
  const nbins = Math.max(1, Math.ceil(range / q));
  /** Components that independently satisfy both the plane and area tests. */
  const qualifyingCounts = new Int32Array(nbins);
  /** Highest qualifying component depth in the bucket (the depth to pin). */
  const binMax = new Float64Array(nbins).fill(-Infinity);

  // Only a surface exactly on an end is already covered by that end. The
  // histogram quantum groups heights for deterministic storage; it must not
  // make a positive near-floor face equivalent to the floor. remainingAbove
  // still masks that face at floorZ and would leave the preceding level's
  // stock standing (WO-221's Z0.0005 regression).
  const lo = floorZ;
  const hi = stockTopZ;

  const flatTol = opts.flatTol ?? q;
  if (!Number.isFinite(flatTol) || flatTol < 0) {
    throw new Error(`findCriticalDepths: flatTol must be finite and >= 0, got ${flatTol}.`);
  }

  const cellArea = part.cell * part.cell;
  // The smallest flat this job must cut, read back as a width: minFlatArea is
  // the tool's own cross-section by this function's contract, so the diameter of
  // the equal-area circle is the tool the caller chose.
  const across = minFlatArea > 0 ? 2 * Math.sqrt(minFlatArea / Math.PI) : 0;
  const resolvingCell = across * RESOLVING_CELL_FRACTION;
  // See "WHERE EXACTLY THE REFUSAL IS KEYED" above. minFlatArea 0 means "any
  // flat counts", which is not a tool size and cannot be too big for a cell.
  const cannotJudge = minFlatArea > 0 && part.cell > resolvingCell;
  /** Locally horizontal samples used by the component-local area decision. */
  const horizontalCells = new Uint8Array(part.top.length);

  const { top, bottom, nx, ny } = part;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const c = j * nx + i;
      const t = top[c];
      if (!(t > bottom[c])) continue; // empty column: no part surface here
      const d = t + axialStockToLeave;
      if (!(d > lo) || !(d < hi)) continue;
      // QUESTION 1 (is it a plane): every neighbour that carries material must
      // be level, and at least one must. Off-grid and empty neighbours are the
      // edge of the face and abstain. Unrolled and allocation-free -- this runs
      // once per column of a 4M-cell grid.
      // An off-grid neighbour abstains exactly as an empty one does.
      const vxm = i > 0 ? neighbourVerdict(top, bottom, c - 1, t, flatTol) : 0;
      const vxp = i + 1 < nx ? neighbourVerdict(top, bottom, c + 1, t, flatTol) : 0;
      const vym = j > 0 ? neighbourVerdict(top, bottom, c - nx, t, flatTol) : 0;
      const vyp = j + 1 < ny ? neighbourVerdict(top, bottom, c + nx, t, flatTol) : 0;

      // (a) UNANIMITY, unchanged: no material neighbour disagrees and at least
      //     one is level. An isolated column is not a plane.
      let horizontal =
        vxm >= 0 && vxp >= 0 && vym >= 0 && vyp >= 0 && vxm + vxp + vym + vyp > 0;

      // (b) QUAD (WO-134): this column is one corner of a fully level 2 x 2
      //     block. See "GRID RESOLUTION" above -- a 2-cell-wide face has no
      //     unanimous column at all, so (a) alone drops it for a reason that
      //     belongs to the grid rather than to the cutter.
      if (!horizontal) {
        for (let s = 0; s < 4; s++) {
          const dx = s & 1 ? 1 : -1;
          const dy = s & 2 ? 1 : -1;
          if ((dx < 0 ? vxm : vxp) !== 1) continue;
          if ((dy < 0 ? vym : vyp) !== 1) continue;
          // Both edges of the block are in range and level, so the diagonal
          // index is in range too; only its height is still unknown.
          if (neighbourVerdict(top, bottom, c + dx + dy * nx, t, flatTol) === 1) {
            horizontal = true;
            break;
          }
        }
      }
      if (!horizontal) {
        // Not a plane as far as the grid can tell. Harmless while the grid is
        // fine enough for that to mean something.
        continue;
      }
      horizontalCells[c] = 1;
    }
  }

  {
    // THE COMPONENT DECISION. A height bucket may contain several disconnected
    // faces, so neither horizontal evidence nor area may cross a component
    // boundary. Four-connectivity matches remainingAbove's physical mask:
    // samples touching only at one grid corner do not create cutter-supporting
    // material between their centres and may not pool sub-tool face area.
    // Above the resolving cell, a component that does not earn a level must
    // additionally be ruled out on evidence rather than assumed away.
    const unresolved: UnresolvedFace[] = [];
    const visited = new Uint8Array(top.length);
    const stack = new Int32Array(top.length);
    for (let seed = 0; seed < top.length; seed++) {
      if (visited[seed]) continue;
      const seedTop = top[seed];
      if (!(seedTop > bottom[seed])) {
        visited[seed] = 1;
        continue;
      }
      const seedDepth = seedTop + axialStockToLeave;
      if (!(seedDepth > lo) || !(seedDepth < hi)) {
        visited[seed] = 1;
        continue;
      }

      let size = 1;
      stack[0] = seed;
      visited[seed] = 1;
      let columns = 0;
      let levelColumns = 0;
      let depth = -Infinity;
      let minI = nx;
      let maxI = -1;
      let minJ = ny;
      let maxJ = -1;
      while (size > 0) {
        const c = stack[--size];
        const i = c % nx;
        const j = (c - i) / nx;
        const d = top[c] + axialStockToLeave;
        columns++;
        levelColumns += horizontalCells[c];
        if (d > depth) depth = d;
        if (i < minI) minI = i;
        if (i > maxI) maxI = i;
        if (j < minJ) minJ = j;
        if (j > maxJ) maxJ = j;

        for (let dj = -1; dj <= 1; dj++) {
          const y = j + dj;
          if (y < 0 || y >= ny) continue;
          for (let di = -1; di <= 1; di++) {
            if (Math.abs(di) + Math.abs(dj) !== 1) continue;
            const x = i + di;
            if (x < 0 || x >= nx) continue;
            const n = y * nx + x;
            if (visited[n] || !(top[n] > bottom[n])) continue;
            const nd = top[n] + axialStockToLeave;
            if (!(nd > lo) || !(nd < hi) || Math.abs(nd - seedDepth) > flatTol) continue;
            visited[n] = 1;
            stack[size++] = n;
          }
        }
      }

      const area = columns * cellArea;
      if (levelColumns > 0 && area >= minFlatArea) {
        let bin = Math.floor((depth - floorZ) / q);
        if (bin < 0) bin = 0;
        else if (bin >= nbins) bin = nbins - 1;
        qualifyingCounts[bin]++;
        if (depth > binMax[bin]) binMax[bin] = depth;
        continue;
      }
      if (!cannotJudge) continue;
      const spanI = maxI - minI;
      const spanJ = maxJ - minJ;
      // The old axis-only envelope was `(spanI + 2) * cell` by
      // `(spanJ + 2) * cell`. It correctly ruled out one isolated 1.4 mm
      // sample for a 3 mm tool (2.8 mm max), but incorrectly ruled out a
      // 3.1 mm round face sampled as two same-column points at 1.45 mm cells:
      // between the two rows the disk can bulge diagonally beyond 2*cell.
      // Include the orthogonal sample span in each possible axis extent. A
      // single sample remains exactly 2*cell on both axes, while that adjacent
      // pair becomes sqrt(5)*cell wide and is refused rather than dropped.
      const maxWidth = Math.hypot(spanI + 2, spanJ) * part.cell;
      const maxDepth = Math.hypot(spanJ + 2, spanI) * part.cell;
      if (maxWidth < across || maxDepth < across) continue;
      unresolved.push({ depth, columns, area, maxWidth, maxDepth });
    }
    unresolved.sort((a, b) => b.depth - a.depth);
    if (unresolved.length > 0) {
      throw gridResolutionError(part.cell, across, minFlatArea, resolvingCell, unresolved);
    }
  }

  const depths: number[] = [];
  // Deepest first. Every marked bucket contains at least one connected
  // component that independently passed both the plane and full-area tests.
  for (let bin = nbins - 1; bin >= 0; bin--) {
    if (qualifyingCounts[bin] === 0) continue;
    const depth = binMax[bin];
    const prev = depths[depths.length - 1];
    // The two halves of a split plane are one plane: pin only the higher. Two
    // levels a nanometre apart would be the duplicate pass this must not emit.
    if (prev !== undefined && prev - depth < q) continue;
    depths.push(depth);
  }
  return depths;
}
