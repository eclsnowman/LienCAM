import type { Vec2 } from '../../../types'

/**
 * Perpendicular distance from `p` to the infinite line through a -> b.
 * Falls back to the point-to-point distance when a and b coincide.
 */
function perpendicularDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  // |cross((b-a), (p-a))| / |b-a|
  const cross = Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x))
  return cross / Math.sqrt(lenSq)
}

/**
 * Ramer-Douglas-Peucker polyline simplification (R3 section 3.5).
 *
 * Collapses runs of near-collinear points using perpendicular distance to
 * the chord, always preserving the first and last points. This is the DP
 * pre-pass run ahead of arc fitting: it MUST be invoked with an epsilon at
 * or below the arc tolerance so that it never spends error budget the
 * downstream arc-fit pass also needs. Running DP at a larger epsilon would
 * overspend the chordal-tolerance budget and produce out-of-tolerance arcs.
 *
 * @param points the input polyline
 * @param epsilon max perpendicular distance to discard a point (<= arc tolerance)
 * @returns the simplified polyline (a new array; inputs are not mutated)
 */
export function douglasPeucker(points: Vec2[], epsilon: number): Vec2[] {
  if (points.length <= 2) return points.map((p) => ({ x: p.x, y: p.y }))

  // Find the point of maximum perpendicular distance from the chord.
  let maxDist = 0
  let maxIndex = 0
  const first = points[0]
  const last = points[points.length - 1]
  for (let i = 1; i < points.length - 1; i++) {
    const d = perpendicularDistance(points[i], first, last)
    if (d > maxDist) {
      maxDist = d
      maxIndex = i
    }
  }

  if (maxDist > epsilon) {
    // Recurse on both halves and stitch (drop the duplicated split point).
    const left = douglasPeucker(points.slice(0, maxIndex + 1), epsilon)
    const right = douglasPeucker(points.slice(maxIndex), epsilon)
    return left.slice(0, -1).concat(right)
  }

  // Whole run is within tolerance of the chord: keep only the endpoints.
  return [
    { x: first.x, y: first.y },
    { x: last.x, y: last.y },
  ]
}

/**
 * Indexed Ramer-Douglas-Peucker (R3 section 3.5).
 *
 * Identical algorithm to {@link douglasPeucker}, but returns the indices into
 * the INPUT array of the points that are KEPT (first and last always kept),
 * in ascending order, rather than copied point objects. The downstream
 * arc-fit pass uses these as candidate breakpoints while validating every
 * dropped ORIGINAL point against the tolerance budget -- so the simplified
 * subset is only a breakpoint selector, never the thing measured.
 *
 * @param points the input polyline
 * @param epsilon max perpendicular distance to discard a point (<= arc tolerance)
 * @returns ascending kept indices into `points` (first and last included)
 */
export function douglasPeuckerIndexed(points: Vec2[], epsilon: number): number[] {
  const n = points.length
  if (n <= 2) return points.map((_, i) => i)

  // Recurse over the [lo, hi] inclusive index window, returning kept indices.
  const recurse = (lo: number, hi: number): number[] => {
    const first = points[lo]
    const last = points[hi]
    let maxDist = 0
    let maxIndex = lo
    for (let i = lo + 1; i < hi; i++) {
      const d = perpendicularDistance(points[i], first, last)
      if (d > maxDist) {
        maxDist = d
        maxIndex = i
      }
    }

    if (maxDist > epsilon) {
      const left = recurse(lo, maxIndex)
      const right = recurse(maxIndex, hi)
      // Stitch, dropping the duplicated split index shared at the seam.
      return left.slice(0, -1).concat(right)
    }

    // Whole window within tolerance of the chord: keep only the endpoints.
    return [lo, hi]
  }

  return recurse(0, n - 1)
}
