import type { Vec2 } from '../types'

/** Shared screen tick unit; the guide builder keeps its existing 2.6 arrow multiplier. */
export const DIMENSION_TICK_PX = 5

/** Guide arrowheads are symmetric [barb, tip, barb] polylines. */
export function chevronTip(poly: Vec2[]): Vec2 | null {
  if (poly.length !== 3) return null
  const tip = poly[1]
  const len0 = Math.hypot(poly[0].x - tip.x, poly[0].y - tip.y)
  const len2 = Math.hypot(poly[2].x - tip.x, poly[2].y - tip.y)
  if (!(len0 > 0 && len2 > 0) ||
      Math.abs(len0 - len2) > Math.max(len0, len2) * 1e-6) return null
  return tip
}

type Project = (at: Vec2) => Vec2 | null

/** Preserve plane-aligned barb directions, solving their lengths independently
 *  so camera foreshortening cannot change the intended on-screen proportions.
 *  Extracted from SketchLayer's committed renderer for preview/commit parity. */
export function screenSizedChevron(poly: Vec2[], worldPerPixel: number, project?: Project): Vec2[] {
  if (!project) return poly
  const tip = chevronTip(poly)
  if (!tip) return poly
  const len0 = Math.hypot(poly[0].x - tip.x, poly[0].y - tip.y)
  const targetPx = len0 / Math.max(worldPerPixel, 1e-9)
  return [solveProjectedEndpoint(tip, poly[0], targetPx, project), tip,
    solveProjectedEndpoint(tip, poly[2], targetPx, project)]
}

function solveProjectedEndpoint(tip: Vec2, endpoint: Vec2, targetPx: number, project: Project): Vec2 {
  if (!(Number.isFinite(targetPx) && targetPx > 0)) return endpoint
  const tipPx = project(tip)
  if (!tipPx) return endpoint
  const dx = endpoint.x - tip.x
  const dy = endpoint.y - tip.y
  const lengthAt = (factor: number): number => {
    const p = project({ x: tip.x + dx * factor, y: tip.y + dy * factor })
    return p ? Math.hypot(p.x - tipPx.x, p.y - tipPx.y) : Number.NaN
  }
  const initial = lengthAt(1)
  if (!(Number.isFinite(initial) && initial > 0)) return endpoint
  if (Math.abs(initial - targetPx) < 1e-4) return endpoint
  let low = 0
  let high = Math.max(1, targetPx / initial)
  let highLength = lengthAt(high)
  for (let i = 0; i < 8 && Number.isFinite(highLength) && highLength < targetPx; i++) {
    high *= 2
    highLength = lengthAt(high)
  }
  if (!(Number.isFinite(highLength) && highLength >= targetPx)) return endpoint
  for (let i = 0; i < 18; i++) {
    const mid = (low + high) / 2
    const midLength = lengthAt(mid)
    if (!Number.isFinite(midLength)) return endpoint
    if (midLength < targetPx) low = mid
    else high = mid
  }
  const factor = (low + high) / 2
  return { x: tip.x + dx * factor, y: tip.y + dy * factor }
}
