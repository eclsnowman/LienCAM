// cam3d geom2d: ring representation and pure (no-wasm) helpers.
//
// RING REPRESENTATION (the cam3d 2D polygon convention -- consumers and the
// clipper wrappers in this package all speak this one shape):
//
//   Ring     = Float64Array of xy pairs [x0, y0, x1, y1, ...], mm, Z-up frame
//              viewed from +Z. The ring is implicitly closed: the first point
//              is NOT repeated at the end.
//   Ring[]   = a flat list of rings. Nesting is encoded by ORIENTATION, not by
//              grouping: positive signed (shoelace) area = CCW = outer
//              boundary (solid); negative = CW = hole.
//
// WHY flat-list + orientation instead of { outer, holes } grouping:
//   - It is exactly what clipper2 consumes and emits (its D-API outputs are
//     normalized to positive-area outers / negative-area holes), so booleans
//     and offsets round-trip with zero repacking.
//   - Waterline slicing produces loops one at a time with no cheap parent
//     info; a flat list lets slices flow straight into region booleans, and a
//     consumer that needs explicit nesting can derive it (point-in-polygon)
//     without this layer having guessed a grouping for it.
//   - Float64Array pairs are compact, structured-clone-fast across the worker
//     boundary, and trivially byte-comparable for determinism checks.
//
// ORIENTATION IS SEMANTIC: a CW ring passed to offset() is treated as a hole
// (positive delta SHRINKS the hole because the region grows). Build inputs to
// this convention; everything this package returns already complies.

export type Ring = Float64Array;

/**
 * Signed shoelace area of one ring, mm^2. Positive = CCW (outer boundary in
 * the cam3d convention), negative = CW (hole). Pure JS -- no wasm round-trip.
 */
export function area(ring: Ring): number {
  const n = ring.length / 2;
  let s = 0;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    s += ring[2 * j] * ring[2 * i + 1] - ring[2 * i] * ring[2 * j + 1];
  }
  return s / 2;
}

/** True when the ring is an outer boundary (positive area / CCW). */
export function isOuter(ring: Ring): boolean {
  return area(ring) > 0;
}

/** True when the ring is a hole (negative area / CW). */
export function isHole(ring: Ring): boolean {
  return area(ring) < 0;
}

/**
 * Net signed area of a ring set, mm^2: outers add, holes subtract. This is
 * the material quantity of a region -- only meaningful on ring sets that
 * follow the orientation convention (everything this package returns does).
 */
export function netArea(rings: readonly Ring[]): number {
  let s = 0;
  for (const r of rings) s += area(r);
  return s;
}

/**
 * Fail-loud input validation (architecture rule: garbage in throws, it never
 * silently produces an empty result -- silent empties were the root cause of
 * the 2D engine's disappearing-toolpath bug class). Checks: non-empty list,
 * even-length arrays, >= 3 points per ring, all coordinates finite.
 *
 * Deliberately does NOT reject zero-area (collinear) rings: clipper handles
 * them (they annihilate), and a legitimately tiny sliver from a boolean is
 * indistinguishable from one by any threshold this layer could pick.
 */
export function validateRings(rings: readonly Ring[], label: string): void {
  if (rings.length === 0) {
    throw new Error(
      `geom2d ${label}: empty ring list. Operations on nothing are almost ` +
        `always an upstream bug; branch before calling if empty is expected.`,
    );
  }
  for (let i = 0; i < rings.length; i++) {
    const r = rings[i];
    if (r.length % 2 !== 0) {
      throw new Error(
        `geom2d ${label}: ring ${i} has odd length ${r.length} (must be xy pairs).`,
      );
    }
    if (r.length < 6) {
      throw new Error(
        `geom2d ${label}: ring ${i} is degenerate (${r.length / 2} points; a ring needs >= 3).`,
      );
    }
    for (let k = 0; k < r.length; k++) {
      if (!Number.isFinite(r[k])) {
        throw new Error(
          `geom2d ${label}: ring ${i} has non-finite coordinate at index ${k} (${r[k]}).`,
        );
      }
    }
  }
}
