// WO-3034: walk planned moves as straight tool-tip segments. Arcs (absolute
// cx/cy, as the app stores them) are walked along the arc in chords whose
// sagitta stays under `maxSagitta`, never as one chord; Z moves linearly across
// an arc (helical). The same walk as the stick's forEachLinearSweep.
import type { ToolpathMove } from '../../types'
import type { LinearMove } from '../material'
import { effectiveMoveRole } from '../../lib/cam/stockCuttingRoles'

export type Segment = LinearMove

/** Visit every segment of moves[1..]; `index` is the move the segment belongs to. */
export function forEachSegment(moves: readonly ToolpathMove[], maxSagitta: number,
  visit: (segment: Segment, index: number) => void): void {
  for (let index = 1; index < moves.length; index++) {
    const from = moves[index - 1], move = moves[index]
    const arc = (move.type === 'arc_cw' || move.type === 'arc_ccw') && move.cx !== undefined && move.cy !== undefined
    if (!arc) {
      visit({ x0: from.x, y0: from.y, z0: from.z, x1: move.x, y1: move.y, z1: move.z }, index)
      continue
    }
    const cx = move.cx!, cy = move.cy!
    const r = Math.hypot(from.x - cx, from.y - cy)
    const a0 = Math.atan2(from.y - cy, from.x - cx)
    let sweep = Math.atan2(move.y - cy, move.x - cx) - a0
    if (move.type === 'arc_cw') { while (sweep >= 0) sweep -= 2 * Math.PI } else { while (sweep <= 0) sweep += 2 * Math.PI }
    const sagitta = Math.max(maxSagitta, 1e-4)
    const chord = r > sagitta ? 2 * Math.sqrt(2 * r * sagitta - sagitta * sagitta) : Number.POSITIVE_INFINITY
    const steps = Math.max(1, Math.ceil(Math.abs(sweep) * r / chord))
    let px = from.x, py = from.y, pz = from.z
    for (let k = 1; k <= steps; k++) {
      const t = k / steps
      const x = k === steps ? move.x : cx + r * Math.cos(a0 + sweep * t)
      const y = k === steps ? move.y : cy + r * Math.sin(a0 + sweep * t)
      const z = from.z + (move.z - from.z) * t
      visit({ x0: px, y0: py, z0: pz, x1: x, y1: y, z1: z }, index)
      px = x; py = y; pz = z
    }
  }
}

/** Two directions closer than this (sine of the angle between them) are the same line. */
const COLLINEAR_SIN = 1e-9

/**
 * The canonical form estimates read (WO-3034 fix round 3): consecutive straight
 * feed moves of one role that continue along the same line merge into one move,
 * so a path and the same path cut into more collinear pieces give the same
 * estimate. Arcs, rapids and turns are kept as they are; the input is not touched.
 */
export function mergeCollinearFeeds(moves: readonly ToolpathMove[]): ToolpathMove[] {
  const out: ToolpathMove[] = []
  for (const move of moves) {
    const last = out.length >= 2 ? out[out.length - 1] : undefined
    if (last && move.type === 'feed' && last.type === 'feed' && effectiveMoveRole(move) === effectiveMoveRole(last)) {
      const from = out[out.length - 2]
      const ux = last.x - from.x, uy = last.y - from.y, uz = last.z - from.z
      const vx = move.x - last.x, vy = move.y - last.y, vz = move.z - last.z
      const lu = Math.hypot(ux, uy, uz), lv = Math.hypot(vx, vy, vz)
      if (lv === 0) continue
      const cross = Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx)
      if (lu > 0 && ux * vx + uy * vy + uz * vz > 0 && cross <= COLLINEAR_SIN * lu * lv) {
        out[out.length - 1] = move
        continue
      }
    }
    out.push(move)
  }
  return out
}

