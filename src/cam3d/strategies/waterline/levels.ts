// cam3d L4 (waterline): the Z ladder.
//
// Step from the top of the finishing band down by a maximum stepdown and
// let the last step be shorter, so the bottom of the band is always cut.
// Flat-area detection adds a level exactly at every horizontal face, so a
// floor/wall corner gets its own pass instead of landing between two
// stepdowns. Both decisions live here, and nowhere else.
//
// Convention: the top of the band (Material Start) is NOT itself a level -- a
// pass at the very top surface would trace the outline of the top face and
// cut nothing a parallel pass does not already own. The first pass is one
// stepdown below it; the bottom (Cutter End) is always the last level, lifted
// a hair when it lands on a flat floor (see the lift below).

import type { PartMesh } from '../../kernel/types';

/** Two levels closer than this (mm) are the same level. */
export const LEVEL_MERGE_EPS = 1e-3;

/** More levels than this is a stepdown typo, not a finishing pass. */
export const MAX_LEVELS = 5000;

/** A face tilted less than this from horizontal counts as flat. */
export const FLAT_FACE_MAX_TILT_DEG = 1;

/**
 * Heights of the mesh's horizontal faces (triangle normal within
 * FLAT_FACE_MAX_TILT_DEG of +Z, area > 0), clustered within LEVEL_MERGE_EPS
 * and returned descending. Downward-facing flats (undersides) are ignored: a
 * 3-axis tool cannot reach them. Deterministic: fixed triangle order, fixed
 * clustering order.
 */
export function flatFaceHeights(mesh: PartMesh): number[] {
  const { positions, indices } = mesh;
  const cosMax = Math.cos((FLAT_FACE_MAX_TILT_DEG * Math.PI) / 180);
  const heights: number[] = [];
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * 3;
    const b = indices[t + 1] * 3;
    const c = indices[t + 2] * 3;
    const abx = positions[b] - positions[a];
    const aby = positions[b + 1] - positions[a + 1];
    const abz = positions[b + 2] - positions[a + 2];
    const acx = positions[c] - positions[a];
    const acy = positions[c + 1] - positions[a + 1];
    const acz = positions[c + 2] - positions[a + 2];
    const nx = aby * acz - abz * acy;
    const ny = abz * acx - abx * acz;
    const nz = abx * acy - aby * acx;
    const len = Math.hypot(nx, ny, nz);
    if (!(len > 0)) continue; // zero-area sliver
    if (nz / len < cosMax) continue; // tilted, or facing down
    heights.push(positions[a + 2]);
  }
  heights.sort((p, q) => q - p);
  const clustered: number[] = [];
  for (const h of heights) {
    const last = clustered[clustered.length - 1];
    if (last === undefined || last - h > LEVEL_MERGE_EPS) clustered.push(h);
  }
  return clustered;
}

export interface LevelPlanInput {
  /** Top of the finishing band (Material Start), mm. Not itself a level. */
  topZ: number;
  /** Bottom of the band (Cutter End), mm. Always the last level. */
  bottomZ: number;
  /** Maximum stepdown, mm (> 0). */
  stepdown: number;
  /** Extra levels (flat-face heights); those inside the band are inserted. */
  flatHeights?: readonly number[];
  /**
   * Heights of the mesh's upward flat faces, used to LIFT any level that
   * lands on one (see planWaterlineLevels). Pass the same list as
   * `flatHeights` when detection is on, and the mesh's flat heights anyway
   * when it is off, so a ladder level that happens to land on a floor is
   * lifted either way.
   */
  liftOffFlats?: readonly number[];
  /** How far (mm) a level sitting on a flat face is lifted above it. Default 0. */
  flatLiftMm?: number;
}

/**
 * The levels to cut, DESCENDING, each distinct by LEVEL_MERGE_EPS. Throws
 * (ADR-0003) when the band is empty or the stepdown is not positive: a
 * waterline with nothing to cut is an authoring error the operator must see,
 * never a silently empty toolpath.
 */
export function planWaterlineLevels(input: LevelPlanInput): number[] {
  const { topZ, bottomZ, stepdown } = input;
  if (!Number.isFinite(topZ) || !Number.isFinite(bottomZ)) {
    throw new Error(`waterline: non-finite band top=${topZ} bottom=${bottomZ}.`);
  }
  if (!(stepdown > 0) || !Number.isFinite(stepdown)) {
    throw new Error(`waterline: stepdown must be a positive finite number (got ${stepdown}).`);
  }
  if (topZ - bottomZ <= LEVEL_MERGE_EPS) {
    throw new Error(
      `waterline: the finishing band is empty (Material Start ${topZ} mm, Cutter End ${bottomZ} mm); ` +
        'nothing lies between them to cut.',
    );
  }
  // A hand-edited stepdown of 1e-6 would otherwise ask the slicer for millions
  // of levels; refuse by name at a count no finishing pass reaches.
  const count = Math.ceil((topZ - bottomZ) / stepdown);
  if (count > MAX_LEVELS) {
    throw new Error(
      `waterline: a ${stepdown} mm stepdown over ${(topZ - bottomZ).toFixed(3)} mm is ${count} levels; ` +
        `the limit is ${MAX_LEVELS}. Use a larger stepdown.`,
    );
  }
  const levels: number[] = [];
  for (let k = 1; ; k++) {
    const z = topZ - k * stepdown;
    if (z <= bottomZ + LEVEL_MERGE_EPS) break;
    levels.push(z);
  }
  levels.push(bottomZ);
  for (const h of input.flatHeights ?? []) {
    if (!Number.isFinite(h)) continue;
    if (h >= topZ - LEVEL_MERGE_EPS || h <= bottomZ + LEVEL_MERGE_EPS) continue;
    levels.push(h);
  }
  // LIFT OFF FLAT FACES. A level that lies exactly on an upward flat face is
  // the one height the slicer's fibre grid is ill-conditioned at: the face is
  // coplanar with the level, every fibre grazes it, and the loops come back
  // with spokes and slivers (measured on hemisphereOnSlab at the slab top,
  // WO-1176 evidence 01 before this lift). A hair above the face the loops
  // are the wall outline, which is what a floor/wall corner pass is for; the
  // step left on the floor is the lift, below the operation's tolerance.
  const lift = input.flatLiftMm ?? 0;
  const flats = input.liftOffFlats ?? [];
  const lifted = lift > 0 && flats.length > 0
    ? levels.map((z) => {
        const onFlat = flats.some((h) => Math.abs(h - z) <= LEVEL_MERGE_EPS);
        return onFlat && z + lift < topZ - LEVEL_MERGE_EPS ? z + lift : z;
      })
    : levels;
  lifted.sort((p, q) => q - p);
  const out: number[] = [];
  for (const z of lifted) {
    const last = out[out.length - 1];
    if (last === undefined || last - z > LEVEL_MERGE_EPS) out.push(z);
    // A flat-face height that falls within eps of a ladder level keeps the
    // ladder value (first wins after the descending sort ties break by order).
  }
  return out;
}
