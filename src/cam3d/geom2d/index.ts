// cam3d L2: 2D geometry primitives (clipper2 wrappers).
//
// Strategies (waterline containment, z-level roughing regions) consume rings
// through THIS surface only -- they never import clipper2 directly (hard
// layering rule, architecture doc section 3). See rings.ts for the ring
// representation + orientation convention (Float64Array xy pairs; CCW/positive
// area = outer, CW/negative = hole) and wasm.ts for the scaling convention
// (D API, precision 6 -> coordinate resolution 1e-6 mm).
//
// Contract:
// - Async init ONCE (await ensureGeom2dReady()); every op below is then
//   synchronous, pure, and deterministic (fixed iteration order, no RNG, no
//   time dependence -- identical inputs give byte-identical outputs).
// - Batch-shaped: whole ring sets in, whole ring sets out.
// - Fail loud: uninitialised module, empty input lists and degenerate rings
//   all THROW (see rings.validateRings). An empty RESULT is different: it is
//   a valid, documented return (e.g. an inward offset annihilating the ring,
//   or an intersection of disjoint regions) and comes back as [].

import type { Ring } from './rings';
import { validateRings } from './rings';
import { fromPathsD, requireMod, toPathsD, withWasm, PRECISION } from './wasm';

export type { Ring } from './rings';
export { area, isOuter, isHole, netArea } from './rings';
export { ensureGeom2dReady, geom2dReady, PRECISION } from './wasm';

export type JoinType = 'round' | 'miter' | 'square';
export type BooleanOp = 'union' | 'intersect' | 'difference' | 'xor';

export interface OffsetOptions {
  /**
   * Corner treatment on convex joins. Default 'round' (the toolpath-natural
   * join: a round cutter physically produces round outside corners).
   * 'miter' keeps corners sharp up to the fixed miter limit 2.0 (sharp down
   * to ~60 deg corners; sharper ones get squared off, clipper's safety
   * against spike vertices). 'square' chamfers at exactly |delta|.
   */
  joinType?: JoinType;
  /**
   * Max deviation (mm) of a round join's polygonal approximation from the
   * true arc. Default 0.02 mm -- dense enough that downstream regions do not
   * inherit visible facets, without spraying vertices. Ignored for
   * miter/square joins.
   */
  arcTolerance?: number;
}

const MITER_LIMIT = 2.0;
const DEFAULT_ARC_TOLERANCE = 0.02;

/**
 * Offset closed rings by `delta` mm: positive grows the region, negative
 * shrinks it. Holes (CW rings) automatically move the opposite way, so a
 * region passed as [outer, hole] grows/shrinks as a REGION -- pass a region's
 * rings in ONE call, never per-ring (per-ring calls lose the hole coupling).
 *
 * Returns zero or more rings in the package convention (outers CCW, holes
 * CW): a concave region can split into several islands under inward offset,
 * and a large enough inward offset annihilates the region entirely -- that
 * empty result is valid, not an error.
 */
export function offset(rings: readonly Ring[], delta: number, opts?: OffsetOptions): Ring[] {
  validateRings(rings, 'offset input');
  if (!Number.isFinite(delta)) {
    throw new Error(`geom2d offset: delta must be finite (got ${delta}).`);
  }
  const m = requireMod();
  const joins = {
    round: m.JoinType.Round,
    miter: m.JoinType.Miter,
    square: m.JoinType.Square,
  } as const;
  const join = joins[opts?.joinType ?? 'round'];
  const arcTol = opts?.arcTolerance ?? DEFAULT_ARC_TOLERANCE;
  return withWasm((own) => {
    const paths = own(toPathsD(rings));
    const res = own(
      m.InflatePathsD(paths, delta, join, m.EndType.Polygon, MITER_LIMIT, PRECISION, arcTol),
    );
    return fromPathsD(res);
  });
}

/**
 * Boolean of two ring sets. NonZero fill: orientation is load-bearing (CCW
 * adds, CW subtracts), so overlapping outers WITHIN one operand merge instead
 * of punching even-odd parity holes -- the right semantic for accumulating
 * waterline/sweep regions. (The 2D engine's clipperEngine.ts uses EvenOdd
 * because its FreeCAD-port inputs are already normalized-disjoint; geom2d
 * inputs are not guaranteed to be.)
 *
 * Result rings follow the package convention (outers CCW, holes CW). An
 * empty result (e.g. intersect of disjoint regions, difference that consumes
 * the subject) is valid, not an error.
 */
export function boolean(a: readonly Ring[], b: readonly Ring[], op: BooleanOp): Ring[] {
  // `boolean` is a legal value-space identifier in TS (the primitive type
  // name only occupies type space); the name is the L2 contract's.
  validateRings(a, `boolean(${op}) subject`);
  validateRings(b, `boolean(${op}) clip`);
  const m = requireMod();
  return withWasm((own) => {
    const s = own(toPathsD(a));
    const c = own(toPathsD(b));
    const fill = m.FillRule.NonZero;
    const res = own(
      op === 'union'
        ? m.UnionD(s, c, fill, PRECISION)
        : op === 'intersect'
          ? m.IntersectD(s, c, fill, PRECISION)
          : op === 'difference'
            ? m.DifferenceD(s, c, fill, PRECISION)
            : m.XorD(s, c, fill, PRECISION),
    );
    return fromPathsD(res);
  });
}
