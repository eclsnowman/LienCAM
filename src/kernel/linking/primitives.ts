// WO-3026 (alpha.3 A3-12): the one approach / retract primitive set (REQ-LINK-3), copied
// from today's shared 2.5D helpers (src/lib/cam/moves/index.ts - read-only, not edited):
// the approach down through Clearance -> Retract -> Feed, the feed plunge, the retract,
// and the WO-2835 floor hop. Lowest rapid endpoint = the feed plane, as today. The entry
// builders (helix, ramp) in the same file belong to the entry service (A3-13), not here.

import type { MoveRole, ToolpathMove, Vec2 } from '../../types'

/** Rapid to point `p` at clearanceZ → retractZ → feedZ. */
export function rapidEntryAt(
  moves: ToolpathMove[], p: Vec2,
  feedZ: number, retractZ: number, clearanceZ: number
) {
  moves.push({ type: 'rapid', x: p.x, y: p.y, z: clearanceZ,   role: 'rapid' })
  moves.push({ type: 'rapid', x: p.x, y: p.y, z: retractZ, role: 'rapid' })
  moves.push({ type: 'rapid', x: p.x, y: p.y, z: feedZ,    role: 'rapid' })
}

/** Rapid to path[0] at clearanceZ → retractZ → feedZ. */
export function rapidEntry(
  moves: ToolpathMove[], path: Vec2[],
  feedZ: number, retractZ: number, clearanceZ: number
) {
  rapidEntryAt(moves, path[0], feedZ, retractZ, clearanceZ)
}

/** Feed plunge at path[fromIdx] from current Z to depth. */
export function plungeTo(
  moves: ToolpathMove[], path: Vec2[], fromIdx: number, depth: number, feedRate: number,
  role: MoveRole = 'plunge'
) {
  const p = path[fromIdx]
  moves.push({ type: 'feed', x: p.x, y: p.y, z: depth, feed: feedRate, role })
}

/** Retract Z-only from wherever the tool currently is, then rapid to clearanceZ. */
export function retractFrom(moves: ToolpathMove[], retractZ: number, clearanceZ: number) {
  const last = moves[moves.length - 1]
  const x = last?.x ?? 0
  const y = last?.y ?? 0
  moves.push({ type: 'rapid', x, y, z: retractZ, role: 'rapid' })
  moves.push({ type: 'rapid', x, y, z: clearanceZ,   role: 'rapid' })
}

// -- Floor hop: the one reposition over a cleared floor (WO-2835) ----------------------------
// Every operation that repositions between two cuts over a floor it has proven cleared moves
// through here, so the shape and the height setting live in one place.

/** WO-2835 default floor-hop height (mm): the middle of the operator's 0.2-0.5 mm (2026-10-15). */
export const DEFAULT_FLOOR_HOP_MM = 0.3

/** The operation's floor-hop height from its linking settings: absent is the default, 0 turns
 *  the hop off (the operation keeps its legacy reposition), anything negative or not finite
 *  reads as the default. */
export function resolveFloorHopMm(linking: { floorHopMm?: number } | undefined): number {
  const value = linking?.floorHopMm
  return Number.isFinite(value) && (value as number) >= 0 ? (value as number) : DEFAULT_FLOOR_HOP_MM
}

/** WO-2835 (operator ruling 10-15: "3d move zup x/y move zdown", blended): the floor hop from `a` (the
 *  cut's end, at floor depth `z`) to `b`, as G0 rapids along the straight a -> b line. The
 *  rise and the descent each cover `hop` mm of XY (45 degrees), and the hold between them
 *  sits `hop` above the floor. A travel shorter than two rises becomes one peak at its
 *  midpoint. `land` ends the descent at `b` on the floor (the caller has proven `b` stands
 *  in air); otherwise the hop holds its height to `b` (rising more steeply when the travel
 *  is shorter than `hop`) and the caller's fed plunge or entry takes it from there.
 *
 *  Corner rounding: every segment here shares the a -> b XY line, so a controller blending
 *  the rise/hold/descent corners within its corner tolerance moves only in Z, inside the
 *  convex hull of segments that never go below the floor. The corners at `a` and `b` (cut ->
 *  hop, hop -> next cut) are the same corners the legacy traverse had. */
export function floorHop(
  moves: ToolpathMove[], a: { x: number; y: number }, b: { x: number; y: number },
  z: number, hop: number, land: boolean,
): void {
  floorHopAlong(moves, [a, b], z, hop, land)
}

/** The same hop along a travel polyline (`path[0]` is where the tool stands; WO-2787's routed
 *  keep-downs): Z rises 1:1 with the distance travelled up to `hop`, holds, and (when `land`)
 *  falls 1:1 over the last `hop` of the travel, so the XY route is the proven one, unchanged.
 *  Every vertex of the path is kept; the rise, hold and descent breakpoints are added. */
export function floorHopAlong(
  moves: ToolpathMove[], path: readonly { x: number; y: number }[],
  z: number, hop: number, land: boolean,
): void {
  const cum = [0]
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y))
  }
  const len = cum[cum.length - 1]
  const end = path[path.length - 1]
  if (!(len > 1e-9)) {
    if (!land && path.length > 0) moves.push({ type: 'rapid', x: end.x, y: end.y, z: z + hop, role: 'rapid' })
    return
  }
  const lift = (s: number): number => z + Math.max(0, land ? Math.min(s, hop, len - s) : Math.min(s, hop))
  const breaks = (land ? (len < 2 * hop ? [len / 2] : [hop, len - hop]) : [hop]).filter(s => s > 1e-9 && s < len - 1e-9)
  let next = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], sa = cum[i - 1], sb = cum[i]
    while (next < breaks.length && breaks[next] <= sb + 1e-12) {
      const s = breaks[next++]
      if (s <= sa + 1e-12 || s >= sb - 1e-12) continue
      const t = (s - sa) / (sb - sa)
      moves.push({ type: 'rapid', x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: lift(s), role: 'rapid' })
    }
    const last = i === path.length - 1
    moves.push({ type: 'rapid', x: b.x, y: b.y, z: last ? (land ? z : z + hop) : lift(sb), role: 'rapid' })
  }
}
