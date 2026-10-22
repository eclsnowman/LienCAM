// WO-3031 (alpha.3 A3-13): the one ramp builder, copied from today's shared 2.5D entry
// library (src/lib/cam/moves/index.ts rampDescent / rampTo, WO-1679 - read-only, not
// edited). The operation supplies the path the ramp follows (a walk) and its feed; the
// descent profile and the final-depth guarantee live here. Pocket's curve walk and
// Contour's tab-clamped ramp keep their own walks (mapping.ts cites them).

import type { MoveRole, ToolpathMove, Vec2 } from '../../types'

/** Visits points along an operation's own path, `traveled` mm from the ramp start, until
 *  `length` mm have been covered (the last visit at or past `length`). */
export type RampWalk = (length: number, visit: (point: Vec2, traveled: number) => void) => void

/**
 * Descend from fromZ to toZ over `length` mm of XY travel along the path `walk` traces.
 * Z is linear in distance travelled; any point at or past `length` is exactly toZ.
 * Emits feed moves at `feed` with role `role` (default 'ramp'; a ramp lead passes its lead role).
 */
export function rampDescent(
  moves: ToolpathMove[], walk: RampWalk,
  fromZ: number, toZ: number, length: number, feed: number,
  role: MoveRole = 'ramp',
): void {
  const drop = fromZ - toZ
  walk(length, (p, traveled) => {
    const z = traveled >= length - 1e-9 ? toZ : Math.max(toZ, fromZ - (traveled / length) * drop)
    moves.push({ type: 'feed', x: p.x, y: p.y, z, feed, role })
  })
}

/**
 * Ramp from fromZ to toZ along the closed contour starting at path[fromIdx], stepping
 * vertex to vertex (the vertex that completes the ramp length lands at toZ).
 * Returns the path index where toZ is first reached.
 */
export function rampTo(
  moves: ToolpathMove[], path: Vec2[], fromIdx: number,
  fromZ: number, toZ: number, tanAngle: number, rampRate: number,
): number {
  const n = path.length
  const totalDrop = fromZ - toZ
  if (totalDrop <= 1e-6) return fromIdx

  let landed = -1
  rampDescent(moves, (length, visit) => {
    let distAccum = 0
    for (let step = 0; step < n * 50 && distAccum < length; step++) {
      const i = (fromIdx + step) % n
      const j = (i + 1) % n
      distAccum += Math.hypot(path[j].x - path[i].x, path[j].y - path[i].y)
      visit(path[j], distAccum)
      if (distAccum >= length) landed = j
    }
    // A contour too short to carry the ramp in 50 laps: finish the drop where it began.
    if (landed < 0) visit(path[fromIdx], length)
  }, fromZ, toZ, totalDrop / tanAngle, rampRate)
  return landed < 0 ? fromIdx : landed
}
