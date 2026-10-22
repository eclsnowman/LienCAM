// WO-3009: reader output -> LienCAM's canonical move list (mm, Z up, the A.5
// row's world frame). Arcs stay arcs (absolute cx/cy, measured along the arc
// by metrics.ts moveLength). G0 -> rapid. Feeds stay on the move as data.
import type { ToolpathMove } from '../../../types'
import type { ParsedProgram, Point3 } from './parse'

/** Where the program's zero sits in the A.5 row's world frame (Z up, Z = 0 at the table). */
export interface WcsRecord { originMm: Point3 }

export type NormalisedProgram =
  | { moves: ToolpathMove[]; unavailable?: undefined; parsed: ParsedProgram }
  | { moves?: undefined; unavailable: string; parsed: ParsedProgram }

export function normaliseProgram(parsed: ParsedProgram, wcs: WcsRecord): NormalisedProgram {
  if (parsed.unparsedMotionWord) return { unavailable: `n/a: unparsed motion word ${parsed.unparsedMotionWord}`, parsed }
  const o = wcs.originMm
  const moves = parsed.segments.map((s): ToolpathMove => {
    const end = { x: s.end.x + o.x, y: s.end.y + o.y, z: s.end.z + o.z }
    if (s.motion === 'G0') return { type: 'rapid', role: 'rapid', ...end }
    const fed = s.feed === undefined ? {} : { feed: s.feed }
    if (s.motion === 'G1') return { type: 'feed', ...end, ...fed }
    return { type: s.motion === 'G2' ? 'arc_cw' : 'arc_ccw', ...end, cx: s.centre!.x + o.x, cy: s.centre!.y + o.y, ...fed }
  })
  if (!moves.length) return { unavailable: 'n/a: program has no motion with a fully programmed position', parsed }
  return { moves, parsed }
}
