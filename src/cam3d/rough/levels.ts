// cam3d rough: deterministic axial level planner.
//
// A 3-axis rougher clears the job in horizontal Z slices from the stock top
// down to the floor. planLevels returns the Z planes at which a cut region is
// computed and cleared: EVENLY spaced from just below the stock top down to
// (and INCLUDING) the floor, with every step <= maxStepdown.
//
// Why below the top, not at it: cutting AT stockTopZ removes nothing (the
// stock top is already at that height), so the first meaningful level is one
// step down. Even spacing (step = total / n, n = ceil(total / maxStepdown))
// keeps every level a legal depth-of-cut and lands the last one exactly on the
// floor with no overshoot and no duplicate. Deterministic: same inputs give
// the same array, byte for byte.
//
// REQUIRED DEPTHS (WO-101). The floor is not the only height that must be hit
// exactly: every horizontal part surface is only ever cut by a level AT it, so
// any surface the ladder steps over keeps a remainder thinner than one full
// stepdown (see criticalDepths.ts for the mechanism and both symptoms). Passing
// those depths here splits the ladder into segments -- stock top -> pin -> ...
// -> floor -- and spaces each segment evenly on its own. That lands a level on
// every named surface WITHOUT ever deepening a pass beyond maxStepdown (each
// segment recomputes its own n) and WITHOUT appending a redundant pass when a
// depth already divides evenly (a pin that coincides with a natural level ends
// its segment instead of adding one). No pins => byte-identical to before.

/** Two depths closer than this (mm) are the same plane: pin only one. */
const PIN_MERGE_EPS = 1e-6;

/**
 * Z levels top-down from `stockTopZ` to `floorZ`, each step <= `maxStepdown`,
 * the last level EXACTLY `floorZ`, and a level exactly on each of
 * `requiredDepths` that lies strictly between the two. With no required depths:
 * length ceil((stockTopZ - floorZ) / maxStepdown). Fails loud on floorZ >=
 * stockTopZ, maxStepdown <= 0, or a non-finite required depth.
 */
export function planLevels(
  stockTopZ: number,
  floorZ: number,
  maxStepdown: number,
  requiredDepths: readonly number[] = [],
): number[] {
  if (!Number.isFinite(stockTopZ) || !Number.isFinite(floorZ)) {
    throw new Error(`planLevels: stockTopZ/floorZ must be finite (got ${stockTopZ}, ${floorZ}).`);
  }
  if (!Number.isFinite(maxStepdown) || maxStepdown <= 0) {
    throw new Error(`planLevels: maxStepdown must be positive and finite, got ${maxStepdown}.`);
  }
  if (floorZ >= stockTopZ) {
    throw new Error(`planLevels: floorZ (${floorZ}) must be below stockTopZ (${stockTopZ}).`);
  }
  for (const d of requiredDepths) {
    if (!Number.isFinite(d)) {
      throw new Error(`planLevels: requiredDepths must all be finite, got ${d}.`);
    }
  }

  // Segment boundaries, descending: stock top, the pins that are strictly
  // inside (and distinct), then the floor. A pin sitting on an end or on
  // another pin adds no segment -- that end already lands there exactly.
  const stops: number[] = [stockTopZ];
  const pins = requiredDepths.filter((d) => d > floorZ && d < stockTopZ).sort((a, b) => b - a);
  for (const d of pins) {
    if (stops[stops.length - 1] - d > PIN_MERGE_EPS) stops.push(d);
  }
  // A pin within eps of the floor IS the floor (snap it rather than opening a
  // zero-depth segment). With no pins at all there is nothing to snap: the
  // ladder must always keep at least one level, however shallow the job.
  if (stops.length === 1 || stops[stops.length - 1] - floorZ > PIN_MERGE_EPS) stops.push(floorZ);
  else stops[stops.length - 1] = floorZ;

  const levels: number[] = [];
  for (let s = 0; s + 1 < stops.length; s++) {
    const upper = stops[s];
    const lower = stops[s + 1];
    const span = upper - lower;
    // -1e-9 snaps float noise (e.g. span/maxStepdown = 3.0000000001) back down,
    // matching the ZDexelField grid-count convention.
    const n = Math.max(1, Math.ceil(span / maxStepdown - 1e-9));
    const step = span / n;
    for (let k = 1; k <= n; k++) levels.push(upper - k * step);
    // Pin this segment's last level exactly on its stop (kill f64 drift).
    levels[levels.length - 1] = lower;
  }
  return levels;
}
