import type { Vec2 } from '../../../types'

/**
 * Worst distance of points[lo+1..hi-1] from the SEGMENT points[lo] -> points[hi],
 * walked in traversal order (WO-3205). Each point is matched to the segment no
 * earlier than the previous point's match, so a point past either end, or one
 * that steps back along the segment, measures its true distance from the move
 * that would replace it. The infinite line measured a collinear reversal as 0
 * and dropped it from the post. Falls back to the distance from points[lo]
 * when the segment has no length.
 *
 * @returns the worst distance and the index it occurs at (lo when no interior point)
 */
export function orderedSegmentDeviation(points: Vec2[], lo: number, hi: number): { dist: number; index: number } {
  const a = points[lo]
  const b = points[hi]
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  let progress = 0
  let dist = 0
  let index = lo
  for (let k = lo + 1; k < hi; k++) {
    const p = points[k]
    const t = lenSq === 0 ? 0 : Math.max(progress, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq))
    progress = t
    const d = Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
    if (d > dist) {
      dist = d
      index = k
    }
  }
  return { dist, index }
}

/**
 * Ramer-Douglas-Peucker polyline simplification (R3 section 3.5).
 *
 * Collapses runs of near-collinear points using the ordered distance to the
 * chord segment ({@link orderedSegmentDeviation}), always preserving the first
 * and last points, and every reversal larger than epsilon. This is the DP
 * pre-pass run ahead of arc fitting: it MUST be invoked with an epsilon at
 * or below the arc tolerance so that it never spends error budget the
 * downstream arc-fit pass also needs. Running DP at a larger epsilon would
 * overspend the chordal-tolerance budget and produce out-of-tolerance arcs.
 *
 * @param points the input polyline
 * @param epsilon max ordered segment distance to discard a point (<= arc tolerance)
 * @returns the simplified polyline (a new array; inputs are not mutated)
 */
export function douglasPeucker(points: Vec2[], epsilon: number): Vec2[] {
  if (points.length <= 2) return points.map((p) => ({ x: p.x, y: p.y }))

  // Find the point of maximum ordered distance from the chord segment.
  const first = points[0]
  const last = points[points.length - 1]
  const { dist: maxDist, index: maxIndex } = orderedSegmentDeviation(points, 0, points.length - 1)

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
 * @param epsilon max ordered segment distance to discard a point (<= arc tolerance)
 * @returns ascending kept indices into `points` (first and last included)
 */
export function douglasPeuckerIndexed(points: Vec2[], epsilon: number): number[] {
  const n = points.length
  if (n <= 2) return points.map((_, i) => i)

  // Recurse over the [lo, hi] inclusive index window, returning kept indices.
  const recurse = (lo: number, hi: number): number[] => {
    const { dist: maxDist, index: maxIndex } = orderedSegmentDeviation(points, lo, hi)

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
