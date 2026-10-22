// WO-3026 (alpha.3 A3-12): link choice by geometric case (approach 2's vocabulary:
// short gap, long gap, level change, between regions) and the outcome a link has,
// read off a move list. Used by the parity policy table (mapping.ts) and by the
// measurement that proves the table on production runs.

import { effectiveMoveMotion } from '../../lib/cam/stockCuttingRoles'

export const LINK_CASES = ['short_gap', 'long_gap', 'level_change', 'between_regions'] as const
export type LinkCase = (typeof LINK_CASES)[number]

/** What a link does, by the highest point it reaches (planes are the resolved safety planes). */
export const LINK_OUTCOMES = ['stay_down', 'low_rapid', 'feed_plane', 'retract_plane', 'clearance_plane'] as const
export type LinkOutcome = (typeof LINK_OUTCOMES)[number]

export interface LinkMove { type: string; x: number; y: number; z: number; role?: string }
export interface SafetyPlanes { clearanceZ: number; retractZ: number; feedZ: number }

/** One link: the non-pass moves between the end of one pass run and the start of the next. */
export interface LinkSpan {
  /** Index of the first link move in the list. */
  readonly start: number
  readonly from: { x: number; y: number; z: number }
  readonly to: { x: number; y: number; z: number }
  readonly moves: readonly LinkMove[]
  /** Lowest Z of the pass run the link leads into. */
  readonly nextRunMinZ: number
}

const PLANE_EPS = 1e-6
/** A link changes level when the next run sits this far from where the last one ended. */
export const LEVEL_EPS_MM = 1e-3

/** Split a move list into its links. The first approach and the final retract are not links. */
export function linkSpans(moves: readonly LinkMove[]): LinkSpan[] {
  const pass = moves.map(m => effectiveMoveMotion(m) === 'pass')
  const spans: LinkSpan[] = []
  let i = 0
  while (i < moves.length && !pass[i]) i++
  while (i < moves.length) {
    while (i < moves.length && pass[i]) i++
    const start = i
    while (i < moves.length && !pass[i]) i++
    if (i >= moves.length || start === i) break
    let end = i
    let nextRunMinZ = Infinity
    while (end < moves.length && pass[end]) nextRunMinZ = Math.min(nextRunMinZ, moves[end++].z)
    const from = moves[start - 1]
    const to = moves[i - 1]
    spans.push({
      start, from: { x: from.x, y: from.y, z: from.z }, to: { x: to.x, y: to.y, z: to.z },
      moves: moves.slice(start, i), nextRunMinZ,
    })
  }
  return spans
}

/**
 * The geometric case of a link. `levelled` families cut on Z levels (2.5D, adaptive,
 * waterline): a link whose next run sits at another Z is a level change. Surface
 * finishers (parallel, scallop, pencil) have no levels, so only the gap counts.
 * Between regions is a planner fact (the next pass belongs to another region or
 * feature), passed in when the caller knows it; a move list alone cannot show it.
 */
export function classifyLinkCase(
  span: Pick<LinkSpan, 'from' | 'to' | 'nextRunMinZ'>,
  opts: { toolDiameterMm: number; levelled: boolean; betweenRegions?: boolean },
): LinkCase {
  if (opts.betweenRegions) return 'between_regions'
  if (opts.levelled && Math.abs(span.nextRunMinZ - span.from.z) > LEVEL_EPS_MM) return 'level_change'
  const gap = Math.hypot(span.to.x - span.from.x, span.to.y - span.from.y)
  return gap <= opts.toolDiameterMm + PLANE_EPS ? 'short_gap' : 'long_gap'
}

/** The outcome of a link: stays down (no rapid), or the highest plane its rapids reach. */
export function classifyLinkOutcome(span: Pick<LinkSpan, 'moves'>, planes: SafetyPlanes): LinkOutcome {
  if (!span.moves.some(m => m.type === 'rapid')) return 'stay_down'
  const peak = Math.max(...span.moves.map(m => m.z))
  if (peak >= planes.clearanceZ - PLANE_EPS) return 'clearance_plane'
  if (peak >= planes.retractZ - PLANE_EPS) return 'retract_plane'
  if (peak >= planes.feedZ - PLANE_EPS) return 'feed_plane'
  return 'low_rapid'
}
