// WO-3034 (alpha.3 A3-21): re-hosted copy of src/lib/simulation/linearUnification.ts for the kernel estimators
// (draft WO-A3-21: today's time model is re-hosted as copies; the current engine's
// file is not touched). Kept verbatim below this header so post-plan time equals
// the store's estimatedCutTimeMs; estimators.wo3034.test.ts pins that parity.
// WO-2148: UCCNC's linear unification, as its profile states it.
//
// With constant velocity on, UCCNC joins runs of short G1 moves into one line
// before it plans them: a move no longer than `Generalsettings.MaxLinearaddlenght`
// joins the line when every point it skips stays within
// `Generalsettings.Linearerror` of it and the joined line is no longer than
// `Generalsettings.MaxLinearunificationlenght`. Operator's profile: 0.03 / 1 / 2 mm.
//
// Measured 2026-09-26 on the machine PC: Bore 3's 38,776 chords (0.01 mm long on a
// 0.05 mm helix) ran in 82 s. Planned one chord at a time they read 150 s or
// more; joined as the controller joins them - about eleven chords per line,
// stopping at each line's end because the lines turn more than the 89 deg stop
// angle - they read 77 s. (src/tests/evidence/WO-2148/GAP.md.)

import type { FeedEstimatePoint } from './achievableFeed'

export interface LinearUnification {
  /** Largest distance a skipped point may sit off the joined line, mm. */
  linearErrorMm: number
  /** Longest single move that may join a line, mm. */
  maxAddMm: number
  /** Longest joined line, mm. */
  maxUnifiedMm: number
}

function distance(a: FeedEstimatePoint, b: FeedEstimatePoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
}

/** Every point from `from` + 1 to `to` - 1 within `tolerance` of the line from->to. */
function skippedPointsOnLine(
  points: readonly FeedEstimatePoint[], from: number, to: number, tolerance: number,
): boolean {
  const p = points[from]
  const e = points[to]
  const dx = e.x - p.x
  const dy = e.y - p.y
  const dz = e.z - p.z
  const lengthSq = dx * dx + dy * dy + dz * dz
  for (let k = from + 1; k < to; k++) {
    const q = points[k]
    const t = lengthSq > 0 ? ((q.x - p.x) * dx + (q.y - p.y) * dy + (q.z - p.z) * dz) / lengthSq : 0
    if (t < 0 || t > 1) return false
    if (Math.hypot(q.x - p.x - t * dx, q.y - p.y - t * dy, q.z - p.z - t * dz) > tolerance) return false
  }
  return true
}

/**
 * The indices of `points` the controller still plans through once it has
 * joined short moves: always the first and last point. Segment k runs from
 * points[k - 1] to points[k]; `canJoin(k, first)` says whether segment k may
 * join a line that began with segment `first` (both G1 at one feed - a rapid,
 * an arc or a feed change always starts a new line).
 */
export function unifyLinearSegments(
  points: readonly FeedEstimatePoint[],
  canJoin: (segment: number, firstSegment: number) => boolean,
  settings: LinearUnification,
): number[] {
  const kept = [0]
  if (points.length < 2) return kept
  let start = 0
  while (start < points.length - 1) {
    const first = start + 1
    let end = first
    if (canJoin(first, first) && distance(points[start], points[first]) <= settings.maxAddMm) {
      while (end + 1 < points.length
        && canJoin(end + 1, first)
        && distance(points[end], points[end + 1]) <= settings.maxAddMm
        && distance(points[start], points[end + 1]) <= settings.maxUnifiedMm
        && skippedPointsOnLine(points, start, end + 1, settings.linearErrorMm)) {
        end++
      }
    }
    kept.push(end)
    start = end
  }
  return kept
}
