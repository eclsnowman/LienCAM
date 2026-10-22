// WO-3031 (alpha.3 A3-13): reading the entries out of a program. An entry is where the tool
// goes down into the cut after a rapid: a run of feed moves that descends (a plunge, a ramp
// or a helix), or a rapid that lands at the depth the next feed move cuts at (an open or
// already-cleared start). Its class is read from the motion alone, so the same reading
// serves today's programs and the kernel's.

import type { ToolpathMove } from '../../types'

export const ENTRY_CLASSES = ['helix', 'ramp', 'plunge', 'open'] as const
/** helix: the descent turns about one centre; ramp: it descends along a path; plunge: it
 *  descends in Z only (today's straight feed descent - not the ladder's rated rung);
 *  open: a rapid lands at cutting depth and the tool feeds in sideways. */
export type EntryClass = typeof ENTRY_CLASSES[number]

type Move = Pick<ToolpathMove, 'type' | 'x' | 'y' | 'z'> & { role?: string; feed?: number }

export interface EntrySpan {
  /** Index of the first move of the entry (the landing rapid for 'open'). */
  readonly start: number
  /** Index one past its last descending move. */
  readonly end: number
  readonly entryClass: EntryClass
  readonly fromZ: number
  readonly toZ: number
  /** Feed of the descending moves (the first one), absent for 'open'. */
  readonly feed?: number
  /** Roles the descending moves carry. */
  readonly roles: readonly string[]
}

const EPS = 1e-6
const DESCENT_ROLES = new Set(['plunge', 'ramp', 'helix'])

/** True when at least six distinct XY points all lie on the circle through the first three
 *  (to `tol` mm). Six, because the four corners of a rectangle share a circle too: a ramp
 *  round a rectangular contour is not a helix. */
export function onOneCircle(points: ReadonlyArray<{ x: number; y: number }>, tol = 1e-4): boolean {
  const seen = new Set<string>()
  const distinct = points.filter(p => {
    const key = `${p.x.toFixed(6)},${p.y.toFixed(6)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  if (distinct.length < 6) return false
  const [a, b, c] = distinct
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < 1e-12) return false
  const sa = a.x * a.x + a.y * a.y, sb = b.x * b.x + b.y * b.y, sc = c.x * c.x + c.y * c.y
  const ox = (sa * (b.y - c.y) + sb * (c.y - a.y) + sc * (a.y - b.y)) / d
  const oy = (sa * (c.x - b.x) + sb * (a.x - c.x) + sc * (b.x - a.x)) / d
  const r = Math.hypot(a.x - ox, a.y - oy)
  return distinct.every(p => Math.abs(Math.hypot(p.x - ox, p.y - oy) - r) <= tol)
}

/** Every entry of a program, in order. */
export function entrySpans(moves: readonly Move[]): EntrySpan[] {
  const spans: EntrySpan[] = []
  for (let i = 1; i < moves.length; i++) {
    const prev = moves[i - 1]
    const move = moves[i]
    if (prev.type !== 'rapid') continue
    if (move.type === 'rapid') continue
    if (move.z < prev.z - EPS) {
      // A descending feed run starts here: it runs while the moves go down, or carry a
      // descent role at the depth reached (the 3D helix's turn at depth).
      let end = i
      let z = prev.z
      while (end < moves.length && moves[end].type !== 'rapid'
        && (moves[end].z < z - EPS || (Math.abs(moves[end].z - z) <= EPS && DESCENT_ROLES.has(moves[end].role ?? '')))) {
        z = moves[end].z
        end++
      }
      const run = moves.slice(i, end)
      const points = [prev, ...run]
      // The descending part only (a run may end with an at-depth lead onto the pass), with
      // repeated XY points (a vertical drop before the spiral) taken once.
      let lastDrop = 0
      for (let k = 1; k < points.length; k++) if (points[k].z < points[k - 1].z - EPS) lastDrop = k
      const descent = points.slice(0, lastDrop + 1)
        .filter((p, k, all) => k === 0 || Math.hypot(p.x - all[k - 1].x, p.y - all[k - 1].y) > EPS)
      const lateral = descent.length > 1
      const entryClass: EntryClass = !lateral ? 'plunge'
        : run.some(m => m.role === 'helix' || m.type === 'arc_cw' || m.type === 'arc_ccw') || onOneCircle(descent) ? 'helix'
          : 'ramp'
      spans.push({
        start: i, end, entryClass, fromZ: prev.z, toZ: z, feed: run[0].feed,
        roles: [...new Set(run.map(m => m.role ?? ''))],
      })
      i = end - 1
    } else if (i >= 2 && prev.z < moves[i - 2].z - EPS && Math.abs(move.z - prev.z) <= EPS
      && Math.hypot(move.x - prev.x, move.y - prev.y) > EPS) {
      // A rapid landed at this depth and the tool feeds in sideways.
      spans.push({ start: i - 1, end: i, entryClass: 'open', fromZ: moves[i - 2].z, toZ: prev.z, roles: [] })
    }
  }
  return spans
}
