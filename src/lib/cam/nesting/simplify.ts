/* Deterministic polygon simplification for the nesting PROXY geometry.
 *
 * WHY: profiling (NESTING perf gate) showed noFitPolygon dominates packing
 * wall-clock (~99.9%) on dense imported parts - Operator's BMG.dxf imports to a
 * ~202-vertex outer ring (and grows further under the spacing offset). The
 * orbiting NFP with searchEdges is ~O(n^2 * m^2) in the ring vertex counts, so a
 * 202-vertex ring is the hang. SVGnest stays fast because it SIMPLIFIES every
 * part to a curveTolerance before nesting (svgnest.js cleanPolygon); our port had
 * dropped that step. This module restores it.
 *
 * SCOPE: this simplification is applied ONLY to the rings used as NFP / placement
 * PROXY geometry (the spacing-grown outer ring, and the windows used for inside-
 * window NFP). The ORIGINAL full-resolution part geometry is never touched - the
 * engine emits {x,y,rotationDeg} poses that apply to the full geometry for
 * rendering / toolpath (ADR 0024). A simplified proxy only ever changes WHERE a
 * part is placed by a sub-tolerance amount, never the geometry that gets cut.
 *
 * METHOD: Douglas-Peucker (RDP), applied to the closed ring split at its two
 * extreme vertices (deterministic anchors) so the result is independent of where
 * the ring array happens to start. Pure, allocation-only, no Math.random, no
 * Date - byte-identical for identical input (determinism is the #1 nesting port
 * risk, NESTING-P1-ENGINE-PLAN.md).
 *
 * SMALL-FIXTURE PROTECTION: simplification is SKIPPED when a ring has fewer than
 * SIMPLIFY_MIN_VERTICES points. Every existing nesting unit test uses tiny 4-10
 * vertex fixtures (squares, L-shapes); those are returned byte-identical so all
 * existing tests pass unchanged. RDP is also idempotent when no vertex exceeds
 * the tolerance, so even a borderline ring above the threshold is left intact
 * unless it genuinely has redundant detail.
 */

import type { Vec2 } from '../../../types/index'

/**
 * Default curve tolerance (mm, canonical units - ADR 0022) for nesting-proxy
 * simplification. Chosen to achieve a LARGE vertex reduction on real imported
 * parts (BMG's ~202-vertex ring collapses to well under 50) while staying small
 * relative to a realistic spacing.partGap (mm-scale): a vertex is only removed
 * when it lies within DEFAULT_CURVE_TOLERANCE of the chord that would replace it,
 * so the proxy outline never deviates from the true outline by more than this.
 * Kept conservative so simplification on its own cannot manufacture an overlap
 * that the partGap clearance was meant to prevent.
 */
export const DEFAULT_CURVE_TOLERANCE = 0.3

/**
 * Below this vertex count a ring is returned UNCHANGED. Guarantees the small
 * hand-authored test fixtures (4-10 vertices) are byte-identical and protects
 * already-simple geometry from any RDP rounding. Real dense imports (hundreds of
 * vertices) are far above it and get simplified.
 */
export const SIMPLIFY_MIN_VERTICES = 16

/** Perpendicular distance from p to the (infinite) line through a-b. When a==b,
 *  falls back to the point distance |p-a|. */
function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  if (len2 === 0) {
    const ex = p.x - a.x
    const ey = p.y - a.y
    return Math.sqrt(ex * ex + ey * ey)
  }
  // |cross((b-a),(p-a))| / |b-a|
  const cross = Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x))
  return cross / Math.sqrt(len2)
}

/**
 * Classic Douglas-Peucker on an OPEN polyline pts[lo..hi] (endpoints kept).
 * Returns the indices to keep, in increasing order, INCLUDING lo and hi.
 * Iterative (explicit stack) so deep rings cannot overflow the call stack;
 * deterministic (no randomness, fixed traversal order).
 */
function rdpKeep(pts: Vec2[], tolerance: number): number[] {
  const n = pts.length
  const keep = new Array<boolean>(n).fill(false)
  keep[0] = true
  keep[n - 1] = true

  const stack: [number, number][] = [[0, n - 1]]
  while (stack.length > 0) {
    const [lo, hi] = stack.pop()!
    if (hi - lo < 2) continue
    let maxDist = -1
    let maxIdx = -1
    for (let i = lo + 1; i < hi; i++) {
      const d = perpendicularDistance(pts[i], pts[lo], pts[hi])
      if (d > maxDist) {
        maxDist = d
        maxIdx = i
      }
    }
    if (maxDist > tolerance && maxIdx > lo) {
      keep[maxIdx] = true
      stack.push([lo, maxIdx])
      stack.push([maxIdx, hi])
    }
  }

  const out: number[] = []
  for (let i = 0; i < n; i++) if (keep[i]) out.push(i)
  return out
}

/**
 * Deterministically simplify a CLOSED ring (vertex list, no repeated closing
 * point) to the given curve tolerance, returning a new ring. The input ring is
 * never mutated.
 *
 * Anchoring: a closed ring has no natural endpoints, and RDP needs two. Picking
 * the array's first/last vertex would make the result depend on the (arbitrary)
 * start index. Instead we anchor at the two vertices that are extreme along x
 * (min-x, then max-x) - a rotation/start-index-independent choice - split the
 * ring into two open chains between them, RDP each, and stitch. The min/max-x
 * vertices are guaranteed to survive (they are true geometric extremes), so the
 * proxy keeps the part's overall extent.
 *
 * Returns the ring UNCHANGED (same array reference) when it is below
 * SIMPLIFY_MIN_VERTICES, so small fixtures stay byte-identical.
 */
export function simplifyRing(ring: Vec2[], tolerance: number = DEFAULT_CURVE_TOLERANCE): Vec2[] {
  if (ring.length < SIMPLIFY_MIN_VERTICES || tolerance <= 0) {
    return ring
  }

  // deterministic anchors: index of min-x (ties -> min-y) and max-x (ties -> max-y).
  let iMin = 0
  let iMax = 0
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i]
    const lo = ring[iMin]
    const hi = ring[iMax]
    if (p.x < lo.x || (p.x === lo.x && p.y < lo.y)) iMin = i
    if (p.x > hi.x || (p.x === hi.x && p.y > hi.y)) iMax = i
  }
  if (iMin === iMax) {
    // degenerate (all same x): cannot anchor meaningfully; leave unchanged.
    return ring
  }

  const lo = Math.min(iMin, iMax)
  const hi = Math.max(iMin, iMax)

  // chain 1: lo .. hi (forward). chain 2: hi .. end, wrap, 0 .. lo (forward).
  const chainA: Vec2[] = ring.slice(lo, hi + 1)
  const chainB: Vec2[] = ring.slice(hi).concat(ring.slice(0, lo + 1))

  const keepA = rdpKeep(chainA, tolerance)
  const keepB = rdpKeep(chainB, tolerance)

  // reassemble the closed ring: chainA contributes [lo..hi]; chainB contributes
  // the wrap-around interior (drop its first and last, which duplicate hi and lo).
  const out: Vec2[] = []
  for (const k of keepA) out.push(chainA[k])
  for (let m = 1; m < keepB.length - 1; m++) out.push(chainB[keepB[m]])

  // a triangle is the minimum valid ring; if RDP somehow collapsed below that,
  // keep the original rather than emit a degenerate proxy.
  return out.length >= 3 ? out : ring
}
