import type { Vec2 } from '../types'
import type { DimPlacementResult } from './dimPlacement'

interface Bounds { left: number; top: number; right: number; bottom: number }
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v))
const finite = (p: Vec2) => Number.isFinite(p.x) && Number.isFinite(p.y)
const inBounds = (p: Vec2, r: Bounds) => p.x >= r.left && p.x <= r.right && p.y >= r.top && p.y <= r.bottom
function onSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x, dy = b.y - a.y
  const length2 = dx * dx + dy * dy
  const t = length2 > 0 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / length2, 0, 1) : 0
  return { x: a.x + t * dx, y: a.y + t * dy }
}
// Clip the measurement itself before choosing an endpoint: an off-screen guide must not
// create a helper pointing to an invisible feature (including a behind-camera sentinel).
function clip(a: Vec2, b: Vec2, r: Bounds): [Vec2, Vec2] | null {
  let lo = 0, hi = 1
  const dx = b.x - a.x, dy = b.y - a.y
  for (const [p, q] of [[-dx, a.x - r.left], [dx, r.right - a.x], [-dy, a.y - r.top], [dy, r.bottom - a.y]]) {
    if (p === 0) { if (q < 0) return null; continue }
    const t = q / p
    if (p < 0) lo = Math.max(lo, t)
    else hi = Math.min(hi, t)
    if (lo > hi) return null
  }
  return [{ x: a.x + lo * dx, y: a.y + lo * dy }, { x: a.x + hi * dx, y: a.y + hi * dy }]
}

/** A passive screen-space link to THIS placement's measurement, never nearby sketch entities.
 *  Linear bars have a stable index in dimGuides; radial leaders and angle arcs lead their lists.
 *  Ignore witness overshoot and arrow wings so screen-sized cosmetics cannot shift the endpoint. */
export function dimPreviewConnector(
  placement: DimPlacementResult, project: (p: Vec2) => Vec2, badge: Bounds, viewport: Bounds,
): { guide: Vec2; badge: Vec2 } | null {
  if (![badge.left, badge.top, badge.right, badge.bottom, viewport.right, viewport.bottom].every(Number.isFinite)
    || badge.right <= badge.left || badge.bottom <= badge.top) return null
  let guide = placement.guides[0]
  if (['distance', 'distanceX', 'distanceY', 'distancePL', 'focusDistance', 'ordinate'].includes(placement.kind)) {
    guide = placement.guides[2]
  }
  if (!guide?.length) return null
  // A radial anchor exactly on the rim has only a chevron: its middle point is the
  // legitimate attachment. All other three-point inputs are arrow wings, not a path.
  if (guide.length === 3) guide = [guide[1], guide[1]]
  const points = guide.map(project)
  // Approved mockups meet the middle of the nearest badge side. This keeps the
  // line visually attached to the readout rather than grazing a rounded corner.
  const cx = (badge.left + badge.right) / 2, cy = (badge.top + badge.bottom) / 2
  const edges = [{ x: badge.left, y: cy }, { x: badge.right, y: cy },
    { x: cx, y: badge.top }, { x: cx, y: badge.bottom }]
  let best: { guide: Vec2; badge: Vec2 } | null = null, gap = Infinity
  for (let i = 1; i < points.length; i++) {
    if (!finite(points[i - 1]) || !finite(points[i])) continue
    const segment = clip(points[i - 1], points[i], viewport)
    if (!segment) continue
    const [a, b] = segment
    if (clip(a, b, badge)) return null // overlap or zero gap: the readout already meets its guide
    for (const q of edges) {
      const p = onSegment(q, a, b), d = Math.hypot(q.x - p.x, q.y - p.y)
      if (d < gap) { gap = d; best = { guide: p, badge: q } }
    }
  }
  return best && gap > 2 && inBounds(best.badge, viewport) ? best : null
}
