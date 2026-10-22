// WO-3009: a reference program carries no LienCAM roles. Assign them in the
// stockCuttingRoles vocabulary from the carried z-dexel field: a fed move is
// cutting only when its swept cutter reaches material; otherwise it is a
// feed-rate link through air (loop_back). [INFERRED, alpha3-17 A.7]
// Entry CLASSES are left to the M-ENTRY-4 collector, which reads stock state.
import type { ToolpathMove } from '../../../types'
import type { CutterSpec } from '../../../cam3d/kernel/types'
import { removeSweep, type ZDexelField } from '../../../cam3d/stock'
import { maxTraverseIntrusion } from '../../../cam3d/stock/traverseClearance'
import { forEachLinearSweep, replaySagittaFor } from '../../../cam3d/rough/replayStock'
import { resolveMoveFeedrate, type ResolvedFeedrates } from '../../../lib/cam/feedrates'
import { toIrMoves } from '../metrics'

/** The M-AIR-1 contact threshold (metrics.alpha3.ts): at or below this the move is air. */
export const CONTACT_MM = 1e-3

/** Returns new moves with roles; carves the cutting moves out of `field` (mutated). */
export function assignRoles(moves: readonly ToolpathMove[], field: ZDexelField, cutter: CutterSpec): ToolpathMove[] {
  const ir = toIrMoves(moves)
  const sagitta = replaySagittaFor(field)
  return moves.map((m, i) => {
    if (m.type === 'rapid') return { ...m, role: 'rapid' as const }
    if (i === 0) return { ...m, role: 'loop_back' as const }
    const from = moves[i - 1]
    let cuts = false
    forEachLinearSweep(from, ir[i], sagitta, sweep => {
      if (!cuts && maxTraverseIntrusion(field, sweep, cutter).intrusionMm > CONTACT_MM) cuts = true
      if (cuts) removeSweep(field, sweep, cutter)
    })
    if (!cuts) return { ...m, role: 'loop_back' as const }
    const vertical = m.type === 'feed' && Math.hypot(m.x - from.x, m.y - from.y) < 1e-6 && m.z < from.z
    return { ...m, role: vertical ? 'plunge' as const : 'cut' as const }
  })
}

/**
 * What a posted program carries of an engine move list: positions, arc
 * centres and the feed each move is posted at (the role's deferred feed
 * resolved, as the post resolves it), but no roles.
 */
export function programView(moves: readonly ToolpathMove[], feeds: ResolvedFeedrates): ToolpathMove[] {
  return moves.map(move => {
    const { role: _role, engagement: _engagement, feed: _feed, ...rest } = move
    const feed = move.type === 'rapid' ? undefined : resolveMoveFeedrate(move, feeds)
    return feed === undefined ? rest : { ...rest, feed }
  })
}
