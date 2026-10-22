// SPDX-License-Identifier: LGPL-2.1-or-later
// WO-2835: a load-accepted feed route is not an empty rapid corridor.
// WO-3018: every sampling, steering, sharpening and cap number comes from the policy record.
import { ADAPTIVE_POLICY as AP } from '../../../../kernel/ops/adaptive/policy'
import type { ToolpathMove } from '../../../../types'
import { difference, offsetClosed, offsetOpenRound, union, type Loops, type Pt } from './clipperEngine'

// The adaptive worker has no controller-definition input. Use a stated conservative
// fallback, not the saved LienCNC profile's numbers. No exact-stop exemption is assumed.
export const FLOOR_HOP_FALLBACK_BAND_MM = AP.caps.floorHopFallbackBandMm
const ARC_TOL = 0.0001
// Clipper D uses four decimals. This exceeds endpoint rounding, Boolean rounding
// and arc sagitta together. Inner removal and outer query never share an edge.
const GEOMETRY_BOUND_MM = 0.001

/** Trim transition ends: a rounded entry/departure can leave the horizontal plane
 * within the band of its junction. No such transitional sweep is credited. */
function trim(path: Pt[], distance: number): Pt[] {
  const trimStart = (input: Pt[]): Pt[] => {
    let remaining = distance
    for (let i = 1; i < input.length; i++) {
      const a = input[i - 1], b = input[i]
      const length = Math.hypot(b.x - a.x, b.y - a.y)
      if (length > remaining) {
        const t = remaining / length
        return [{ x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }, ...input.slice(i)]
      }
      remaining -= length
    }
    return []
  }
  return trimStart(trimStart(path).reverse()).reverse()
}

/** One emission's constructive removal ledger. Only actual horizontal fed
 * segments at/below the queried floor count; no planner belief, future pass,
 * helix approximation, or rapid is credited. Ignoring those sweeps is conservative.
 * The inner radius also reserves the junction's XY band on prior cuts. */
export function makeFloorHopCorridorProof(toolRadius: number, assemblyRadius = toolRadius) {
  const ledgers = new WeakMap<ToolpathMove[], { z: number; processed: number; cleared: Loops }>()
  return (moves: ToolpathMove[], route: readonly Pt[], z: number): boolean => {
    const band = FLOOR_HOP_FALLBACK_BAND_MM
    const innerRadius = toolRadius - band - GEOMETRY_BOUND_MM
    if (!(innerRadius > 0) || !(assemblyRadius >= toolRadius) || route.length < 2) return false
    const at = moves[moves.length - 1]
    if (!at || at.z !== z) return false
    let ledger = ledgers.get(moves)
    if (!ledger || ledger.z !== z) {
      ledger = { z, processed: 1, cleared: [] }
      ledgers.set(moves, ledger)
    }
    let path: Pt[] = []
    const fold = () => {
      const interior = trim(path, band + GEOMETRY_BOUND_MM)
      if (interior.length >= 2) {
        // Erode after each Boolean union so successive four-decimal intersections
        // cannot accumulate outward rounding into a phantom cleared crescent.
        ledger.cleared = offsetClosed(union(ledger.cleared, offsetOpenRound(interior, innerRadius, ARC_TOL)), -0.0003, ARC_TOL)
      }
      path = []
    }
    for (let i = ledger.processed; i < moves.length; i++) {
      const a = moves[i - 1], b = moves[i]
      if (b.type === 'feed' && a.z === b.z && b.z <= z) {
        if (path.length === 0) path.push(a)
        path.push(b)
      } else fold()
    }
    fold()
    ledger.processed = moves.length
    if (ledger.cleared.length === 0) return false
    // Inflate the ENTIRE polyline, not its vertices/centreline. This includes
    // small inter-segment crescents and every incoming/outgoing XY junction.
    const sweep = offsetOpenRound([...route], assemblyRadius + band + GEOMETRY_BOUND_MM, ARC_TOL)
    return sweep.length > 0 && difference(sweep, ledger.cleared).length === 0
  }
}
