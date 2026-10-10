// cam3d L2 companion: tell a drop-cutter MISS from a HIT.
//
// The GeometryKernel contract (types.ts) returns exactly zSeed where nothing
// lies under the cutter footprint, and every strategy consumes that scalar,
// so a miss and a real surface at the seed height read the same. This module
// is the ONE rule that tells them apart, carried across from the waterline
// adapter (waterline3dOperation.ts seeds one millimetre below the floor for
// exactly this reason): probe BELOW the floor, so a miss is a value no
// contact can produce, then clamp hits back up to the caller's zSeed so every
// emitted height is bit-identical to a probe at zSeed. The kernel's contact
// math does not depend on the seed (the seed only starts the running best),
// so a hit's value is the same either way.
//
// Pure. Touches neither the contract nor any kernel implementation. It lives
// beside the contract rather than inside a strategy by decision (WO-1279
// deferred it, WO-1281 as the second consumer decided it): parallel consumes
// a point list, scallop a grid, and both need this rule, not a wrapper of a
// particular shape. Wrappers stay with their consumers.

/** How far below the caller's drop floor the probe is seeded. */
export const MISS_PROBE_MARGIN_MM = 1;

/** The seed to hand the kernel so a miss comes back as a distinct value. */
export function probeSeedBelow(zSeed: number): number {
  return zSeed - MISS_PROBE_MARGIN_MM;
}

/**
 * Classify a batch of drop results that were probed at `probeSeedBelow(zSeed)`:
 * `z[i]` is what a probe at `zSeed` would have returned (hits: the contact
 * height; misses: exactly zSeed), `hit[i]` is whether anything lay under the
 * footprint at all.
 */
export function classifyProbedDrops(
  probed: Float64Array,
  zSeed: number,
): { z: Float64Array; hit: Uint8Array } {
  const probeSeed = probeSeedBelow(zSeed);
  const n = probed.length;
  const z = new Float64Array(n);
  const hit = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    hit[i] = probed[i] > probeSeed ? 1 : 0;
    z[i] = probed[i] > zSeed ? probed[i] : zSeed;
  }
  return { z, hit };
}
