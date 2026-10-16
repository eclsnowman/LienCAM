// WO-2787 fix round 4: what a reposition between two cut passes costs in machine time.
//
// Operator 2026-10-14: "What determines it from a machinist standpoint is cycletime (time in
// the cut versus air cutting) and surface finish ... If we can get there faster to lead into
// cleanup material by staying down and traveling through clear space ... do that ... When the
// best option is a lift retract, straight reposition, plunge, lead-in, and cleanup do that ...
// try to reuse those existing machining best practices."
//
// No new time model. Each candidate becomes the SAME passes processFeature pushes for it
// (ridePasses), those passes are written out by emit.ts's own emitConnectionPass at every
// level of emit's own schedule (emitLevelSchedule), and the moves are timed by the app's own
// job estimate (runtime.ts estimateRuntimeMs - the number the op card shows) at the resolved
// execution feeds. WO-2787 round 6: there is no second copy of the roles. Which role a
// segment carries, and so which feed prices it, is emit's answer, level by level:
//   - 'wallfollow' ride: 'wall_follow' at the cutting feed on a rough level, 'finish' at the
//                        finishing feed on the floor-finish replay;
//   - 'loopback' ride:  'fast_traverse' at the resolved fast-traverse rate;
//   - stop-short ride:  the loopback travel, then the fed tail as the 'lead' pass emits it;
//   - lift:             the passes processFeature will push for it (WO-2787 round 7): the link
//                       as the landing gate and micro-lift proof leave it (full clearance or a
//                       micro-lift hop, a moved landing, clear-air or helix descent), its lead,
//                       the entry ride and the cut from wherever the landing re-seams it, or a
//                       kept-down cleared approach - priced through estimatePassesMs, never a
//                       hand-built link.
// The op card times the job through the machine's accelerations when its profile has them
// (runtime.ts CutTimeMotion, WO-2024). The worker is handed no accelerations, so these prices
// are distance / feed: the op card's number only for a machine whose profile states none.
// Round 4 left accelerations out of the ranking; with them, short moves cost more than this.

import type { ToolpathMove } from '../../../../types'
import { estimateRuntimeMs } from '../../runtime'
import type { Pt } from './clipperEngine'
import { emitConnectionPass, emitLevelSchedule, type EmitContext } from './emit'
import type { AdaptivePass, RepositionChoiceTrace } from './processFeature'

export interface RepositionTimeModel {
  /** The context the feature is emitted with: heights, stepdown, floor replay and the feeds
   *  resolveFeedrates resolved for execution. */
  ctx: EmitContext
  /** mm/min a G0 runs at: the machine rapid the op card's estimate uses. */
  rapidRate: number
  /** WO-2787 round 7, set by processFeature while the WO-447 gap-fill will ride every stretch
   *  of wall left uncovered: the mm of that wall `rides` newly cover, beyond the stream so far
   *  and `extra`. Absent: no gap-fill follows, and coverage costs nothing later. */
  wallGapMm?: (rides: Pt[][], extra: Pt[][]) => number
  /** WO-2787 round 7, the whole-program check (engine/index.ts): every decision the timed
   *  ladder makes, and the rung a connection must take (null: decide as usual). */
  onChoice?: (decided: RepositionChoiceTrace) => void
  force?: (connStart: Pt, connEnd: Pt) => string | null
  /** A whole-program check's trial run: it records no production request. */
  trial?: true
}

export type RepositionRide = { kind: 'wallfollow' | 'loopback'; points: Pt[]; feedFrom?: number }

/** The passes a kept-down ride is pushed as. WO-466: a STOP-SHORT ride (feedFrom set) is the
 *  at-depth travel (a loopback, when it has length) and the engaged tail (a lead). */
export function ridePasses(ride: RepositionRide): AdaptivePass[] {
  if (ride.feedFrom === undefined) return [{ type: ride.kind, points: ride.points }]
  const travel = ride.points.slice(0, ride.feedFrom + 1)
  const out: AdaptivePass[] = travel.length >= 2 ? [{ type: 'loopback', points: travel }] : []
  out.push({ type: 'lead', points: ride.points.slice(ride.feedFrom) })
  return out
}

/** How many levels emit writes a candidate at (the routed and stop-short search budgets). */
export function repositionLevelCount(m: RepositionTimeModel): number {
  return emitLevelSchedule(m.ctx).length
}

/** Estimated milliseconds for a kept-down ride summed over every level emit writes it at. */
export function estimateRepositionMs(ride: RepositionRide, m: RepositionTimeModel): number {
  return estimatePassesMs(ridePasses(ride), ride.points[0], m)
}

/** Estimated milliseconds of the gap-fill ride that `mm` of wall would take, over every level:
 *  a wall ride of that length at the role emit writes it at (WO-2787 round 7). */
export function estimateWallGapMs(mm: number, m: RepositionTimeModel): number {
  if (!(mm > 0)) return 0
  const o = { x: 0, y: 0 }
  return estimatePassesMs([{ type: 'wallfollow', points: [o, { x: mm, y: 0 }] }], o, m)
}

/** Estimated milliseconds for `passes`, written by emit from `start`, summed over every level. */
export function estimatePassesMs(passes: AdaptivePass[], start: Pt, m: RepositionTimeModel): number {
  const { feeds } = m.ctx
  let ms = 0
  for (const level of emitLevelSchedule(m.ctx)) {
    // The tool stands at `start` on this level; the anchor move itself is not timed.
    const moves: ToolpathMove[] = [{ type: 'feed', x: start.x, y: start.y, z: level.z, feed: feeds.feedRate, role: 'cut' }]
    for (let i = 0; i < passes.length; i++) emitConnectionPass(moves, passes, i, level, m.ctx)
    ms += estimateRuntimeMs(moves, m.rapidRate, feeds.fastTraverseRate, feeds.finishRate)
  }
  return ms
}
