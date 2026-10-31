import type { HeightParams, OperationType, ToolpathMove } from '../../types'
import { effectiveMoveRole, isStockCuttingRole } from './moveRoles'

/** Checked/default keeps current stay-downs. Unchecked uses the existing resolved
 * Retract plane, never an additional operator height. resolvedRetractZ is already
 * in the moves' frame for 3D strategies; other callers supply WCS-relative planes. */
export function minimumTravelZInFrame(heights: HeightParams, wcsZ: number, frameZ = 0, resolvedRetractZ?: number): number | undefined {
  if (heights.minimizeZTravel !== false) return undefined
  const value = resolvedRetractZ ?? (heights.retractHeight + wcsZ - frameZ)
  if (!Number.isFinite(value)) throw new Error('Retract must be a finite height.')
  return value
}

/** Raise only non-cutting XY segments. Restore their original endpoint vertically so the
 * following cut/helix/ramp starts at exactly its original position. Never turn a low link
 * into a diagonal climb, lower a clamp detour, or change the first approach/final exit.
 * Checked/default returns the original array, preserving existing programs byte for byte. */
export function enforceMinimumTravelZ(moves: ToolpathMove[], floor: number | undefined): ToolpathMove[] {
  if (floor === undefined || moves.length < 2) return moves
  if (!Number.isFinite(floor)) throw new Error('Minimum travel Z must be a finite WCS height.')
  const out: ToolpathMove[] = [moves[0]]
  let changed = false
  for (let i = 1; i < moves.length; i++) {
    const from = moves[i - 1], to = moves[i]
    const xy = Math.hypot(to.x - from.x, to.y - from.y) > 1e-9
    if (!xy || isStockCuttingRole(effectiveMoveRole(to)) || Math.min(from.z, to.z) >= floor) {
      out.push(to)
      continue
    }
    changed = true
    const z = Math.max(floor, from.z, to.z)
    if (from.z < z) out.push({ type: 'rapid', role: 'rapid', x: from.x, y: from.y, z })
    out.push({ ...to, z })
    if (to.z < z) out.push({ type: 'rapid', role: 'rapid', x: to.x, y: to.y, z: to.z })
  }
  return changed ? out : moves
}

/** Resolved planes in the move frame. One contract at worker, 3D publication,
 * kernel publication and final post expansion; checked/default is an identity. */
export function enforceOperationTravel(
  moves: ToolpathMove[], heights: HeightParams, wcsZ: number, frameZ = 0,
  resolved?: { clearanceZ: number; retractZ: number; feedZ: number },
  operationType?: OperationType,
): ToolpathMove[] {
  if (heights.minimizeZTravel !== false || moves.length < 2) return moves
  const retractZ = minimumTravelZInFrame(heights, wcsZ, frameZ, resolved?.retractZ)
  const clearanceZ = resolved?.clearanceZ ?? heights.clearanceHeight + wcsZ - frameZ
  const feedZ = resolved?.feedZ ?? heights.feedHeight + wcsZ - frameZ
  if (![clearanceZ, feedZ].every(Number.isFinite)) throw new Error('Reference planes must be finite heights.')
  const linked = enforceMinimumTravelZ(moves, retractZ)
  const out: ToolpathMove[] = []
  const cutting = (m: ToolpathMove) => isStockCuttingRole(effectiveMoveRole(m))
  let drilledColumn = false
  for (let i = 0; i < linked.length; i++) {
    const m = linked[i]
    const prev = out.at(-1)
    // WO-1886/WO-1926: a rapid inside an already drilled column is part of
    // the selected cycle, not a new entry. Keep chip-break partial retracts
    // and peck rapid re-approaches. XY travel starts a new hole (including
    // copies/nests); external links still pass through the Retract rule above.
    if (prev && Math.hypot(m.x - prev.x, m.y - prev.y) > 1e-9) drilledColumn = false
    const internalDrillStep = operationType === 'drill' && drilledColumn
    if (prev && !cutting(prev) && cutting(m) && !internalDrillStep) {
      // Restore Feed only at entry from air, never between engaged passes or
      // inside a helix/ramp. Retain the original start of every XY cutting segment.
      const vertical = Math.hypot(m.x - prev.x, m.y - prev.y) < 1e-9
      if (prev.z < feedZ - 1e-9) {
        // Back up through the vertical air descent so it stops at Feed. The
        // original low endpoint is reached at entry feed, not at rapid.
        let j = out.length - 1
        while (j >= 0 && !cutting(out[j]) && out[j].z < feedZ
          && Math.hypot(out[j].x - prev.x, out[j].y - prev.y) < 1e-9) j--
        const start = j + 1
        out.splice(start)
        out.push({ type: 'rapid', role: 'rapid', x: prev.x, y: prev.y, z: feedZ })
        out.push({ type: 'feed', role: 'plunge', x: prev.x, y: prev.y, z: prev.z, feed: m.feed })
      } else if (vertical && m.z < feedZ - 1e-9 && prev.z > feedZ + 1e-9) {
        out.push({ type: 'rapid', role: 'rapid', x: prev.x, y: prev.y, z: feedZ })
      }
    }
    if ((i === 0 || i === linked.length - 1) && !cutting(m) && m.z < clearanceZ) {
      out.push({ ...m, z: clearanceZ })
    } else out.push(m)
    if (cutting(m)) drilledColumn = true
  }
  return out
}
