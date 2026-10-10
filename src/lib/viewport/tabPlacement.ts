// Pure math for the in-viewport contour holding-tab editor (Tabs v2).
//
// The viewport places tab markers on a contour op's FINISH-CONTOUR polyline
// (Operation.contourTabPreview - derived by the engine itself, so marker
// positions and cut tabs share one geometry). A tab location is a FRACTION in
// [0, 1) of that closed polyline's perimeter: arc distance of the tab CENTER
// along the cut direction from the seam (path[0]). This module holds every
// piece of that mapping that does not need THREE - pointer-projection to the
// nearest arc position, fraction -> point sampling, even-spacing seeds, and
// the minimum-separation check the editor uses to refuse overlapping tabs -
// so the math is unit-tested without a WebGL context. The viewport supplies
// plain {x, y} world points (the pointer ray is intersected with the marker
// Z plane before reaching here).

export interface Pt2 { x: number; y: number }

export interface ArcPosition {
  /** Fraction in [0, 1) of the closed perimeter. */
  fraction: number
  /** Arc distance from the seam (mm). */
  distance: number
  /** The nearest point ON the polyline (world XY). */
  point: Pt2
  /** Euclidean distance from the query point to `point` (mm). */
  euclidean: number
}

/** Cumulative arc lengths of a CLOSED polyline: cumulative.length ===
 *  path.length + 1, last entry (the wrap back to path[0]) is the perimeter. */
export function polylineCumulative(path: Pt2[]): { cumulative: number[]; perimeter: number } {
  const cumulative = [0]
  let perimeter = 0
  for (let i = 0; i < path.length; i++) {
    const a = path[i]
    const b = path[(i + 1) % path.length]
    perimeter += Math.hypot(b.x - a.x, b.y - a.y)
    cumulative.push(perimeter)
  }
  return { cumulative, perimeter }
}

/**
 * Project a world-XY point onto the closed polyline: the nearest point on any
 * segment (including the closing segment back to path[0]), as an arc position.
 * Returns null for degenerate input (fewer than 2 points or ~zero perimeter).
 */
export function closestArcPosition(path: Pt2[], pt: Pt2): ArcPosition | null {
  if (path.length < 2) return null
  const { cumulative, perimeter } = polylineCumulative(path)
  if (!Number.isFinite(perimeter) || perimeter <= 1e-9) return null

  let bestD2 = Infinity
  let bestDistance = 0
  let bestPoint: Pt2 = path[0]
  for (let i = 0; i < path.length; i++) {
    const a = path[i]
    const b = path[(i + 1) % path.length]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const len2 = abx * abx + aby * aby
    const t = len2 <= 1e-18
      ? 0
      : Math.max(0, Math.min(1, ((pt.x - a.x) * abx + (pt.y - a.y) * aby) / len2))
    const px = a.x + abx * t
    const py = a.y + aby * t
    const dx = pt.x - px
    const dy = pt.y - py
    const d2 = dx * dx + dy * dy
    if (d2 < bestD2) {
      bestD2 = d2
      bestPoint = { x: px, y: py }
      bestDistance = cumulative[i] + Math.sqrt(len2) * t
    }
  }
  const distance = bestDistance >= perimeter ? bestDistance - perimeter : bestDistance
  return {
    fraction: distance / perimeter,
    distance,
    point: bestPoint,
    euclidean: Math.sqrt(bestD2),
  }
}

/** Point at fraction f (wrapped into [0,1)) of the closed polyline. */
export function pointAtFraction(path: Pt2[], fraction: number): Pt2 {
  const { cumulative, perimeter } = polylineCumulative(path)
  const f = ((fraction % 1) + 1) % 1
  const s = f * perimeter
  for (let i = 0; i < path.length; i++) {
    const start = cumulative[i]
    const end = cumulative[i + 1]
    if (s <= end + 1e-9) {
      const length = end - start
      if (length <= 1e-9) return path[(i + 1) % path.length]
      const t = Math.max(0, Math.min(1, (s - start) / length))
      const a = path[i]
      const b = path[(i + 1) % path.length]
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
  }
  return path[0]
}

/** Evenly-spaced tab-center fractions - the engine's default placement
 *  ((i + 0.5) / count), used to SEED custom locations so hand editing starts
 *  from exactly what the user already sees. */
export function evenTabFractions(count: number): number[] {
  const n = Math.max(1, Math.round(count))
  return Array.from({ length: n }, (_, i) => (i + 0.5) / n)
}

/**
 * Is `candidate` (a tab-center fraction) at least `minSepFraction` of CIRCULAR
 * arc separation away from every other tab? `excludeIndex` skips the tab being
 * dragged (null when testing a brand-new tab). Mirrors the engine's overlap
 * rule (center spacing >= one tab width), so the editor refuses placements the
 * engine would fail loud on.
 */
export function isTabFractionFree(
  fractions: number[],
  excludeIndex: number | null,
  candidate: number,
  minSepFraction: number,
): boolean {
  const c = ((candidate % 1) + 1) % 1
  for (let i = 0; i < fractions.length; i++) {
    if (i === excludeIndex) continue
    const f = ((fractions[i] % 1) + 1) % 1
    const raw = Math.abs(f - c)
    const sep = Math.min(raw, 1 - raw)
    if (sep < minSepFraction - 1e-12) return false
  }
  return true
}
