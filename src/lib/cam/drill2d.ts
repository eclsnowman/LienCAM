import type { DrillWorkerPayload } from './types'
import type { ToolpathMove } from '../../types'
import { resolveHeights } from './heights'
import { resolveFeedrates } from './feedrates'
import { centroid } from './geometry'
import { entryMaterialOf, entryStartZ } from './moves'

type Pt = { x: number; y: number }

/**
 * G83 re-approach clearance (mm): after a full retract the drill rapids back
 * down to this far above the previous peck depth, then feeds the next peck.
 * Mirrors the G83 cycle's clearance-above-last-depth return (WO-1886). No
 * per-operation peck-clearance setting exists yet, so this is the default.
 */
const PECK_REAPPROACH_CLEARANCE = 0.5

/**
 * Resolve the final per-hole bottom map sent to the worker as holeBottoms.
 *
 * Pure: never mutates its inputs. All Z values are WCS-RELATIVE (same
 * convention as heights.bottomHeight; absolute Z = value + wcsOrigin.z).
 *
 * Precedence per hole: manual override > perHoleDepth-detected > per-loop
 * owning-geometry fallback > op-level bottom plane. The result, when defined,
 * is COMPLETE over selectedLoopIds so the builder's missing-entry warn (a
 * real-bug tripwire) does not fire in normal use and the override-only (DXF)
 * case does not warn-spam.
 *
 * `perLoopFallback` (the per-pick-type fix): a loop with NO detected B-rep
 * hole must NOT silently inherit the single op-wide bottom plane when that
 * plane is the 3D MODEL's bottom Z (model_bottom mode) — a flat 2D (DXF /
 * sketch) hole at its own plane would be cut to the 3D model depth. The store
 * resolves each such loop's OWN owning-geometry plane-relative bottom and
 * passes it here, keyed by loopId, so it wins over the op-wide plane but
 * stays below override/detected. Empty / undefined -> byte-identical legacy.
 *
 * Returns undefined when there is no detected map, no override, AND no
 * per-loop fallback — preserving today's byte-identical path (no holeBottoms
 * sent; every hole falls back to the op-level bottom inside the builder).
 */
export function resolveHoleBottoms(
  selectedLoopIds: string[],
  detected: Record<string, number> | undefined,
  overrides: Record<string, number> | undefined,
  opLevelBottomWcsRel: number,
  perLoopFallback?: Record<string, number>,
): Record<string, number> | undefined {
  const hasDetected = detected !== undefined && Object.keys(detected).length > 0
  const hasOverrides = overrides !== undefined && Object.keys(overrides).length > 0
  const hasFallback = perLoopFallback !== undefined && Object.keys(perLoopFallback).length > 0
  if (!hasDetected && !hasOverrides && !hasFallback) return undefined

  const result: Record<string, number> = {}
  for (const id of selectedLoopIds) {
    result[id] = overrides?.[id] ?? detected?.[id] ?? perLoopFallback?.[id] ?? opLevelBottomWcsRel
  }
  return result
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function nearestNeighbourSort<T extends Pt>(pts: T[]): T[] {
  if (pts.length <= 1) return pts
  const remaining = [...pts]
  const sorted: T[] = [remaining.splice(0, 1)[0]]
  while (remaining.length > 0) {
    const last = sorted[sorted.length - 1]
    let bestIdx = 0, bestDist = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const d = dist(last, remaining[i])
      if (d < bestDist) { bestDist = d; bestIdx = i }
    }
    sorted.push(remaining.splice(bestIdx, 1)[0])
  }
  return sorted
}

function sortByX<T extends Pt>(pts: T[]): T[] {
  return [...pts].sort((a, b) => a.x - b.x)
}

function sortByY<T extends Pt>(pts: T[]): T[] {
  return [...pts].sort((a, b) => a.y - b.y)
}

function rapid(moves: ToolpathMove[], x: number, y: number, z: number) {
  moves.push({ type: 'rapid', x, y, z, role: 'rapid' })
}

function feed(moves: ToolpathMove[], x: number, y: number, z: number, f: number, role: ToolpathMove['role']) {
  moves.push({ type: 'feed', x, y, z, feed: f, role })
}

export function buildDrillToolpath(
  payload: DrillWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
): ToolpathMove[] {
  const { params, heights, tool, loops, wcsOrigin, feedrateOverride, holeBottoms } = payload

  const { clearanceZ, retractZ, feedZ, topZ, bottomZ } = resolveHeights(heights, wcsOrigin)

  const { feedRate, plungeRate } = resolveFeedrates(tool, feedrateOverride)


  // Filter loops to selected IDs (empty = all), THEN require closed: an open loop
  // (e.g. a partial-ellipse region baked as two disconnected open loops, SKC-47-R2)
  // has no well-defined hole boundary — silently drilling at its open-arc centroid
  // is wrong geometry, not just a missing hole, so it must fail loud here rather
  // than fall through as if it were a valid selection (ADR 0003).
  const matchedLoops = params.loopIds.length === 0
    ? loops
    : loops.filter(l => params.loopIds.includes(l.id))
  const selectedLoops = matchedLoops.filter(l => l.closed)

  // ADR 0003: fail loud on an orphaned selection (loop ids are regenerated on
  // every geometry re-derive) instead of silently emitting nothing.
  if (selectedLoops.length === 0) {
    if (params.loopIds.length > 0 && matchedLoops.some(l => !l.closed)) {
      throw new Error(
        'Drill: the selected hole(s) are open loops (no closed boundary) - a partial curve ' +
        'or unclosed sketch region cannot define a drill centre. Re-select closed hole loops ' +
        'in the Geometry tab.'
      )
    }
    if (params.loopIds.length > 0 && loops.length > 0) {
      throw new Error(
        'Drill: the selected hole(s) no longer exist - the geometry was re-derived ' +
        '(re-import / sketch edit / projection-tolerance change regenerates loop ids). ' +
        'Open the operation, re-select the holes in the Geometry tab, and recompute.'
      )
    }
    throw new Error('Drill: no hole loop found. Select hole loops in the Geometry tab.')
  }

  // Loop points are already world-space XY — use centroids directly (same as
  // contour/pocket). Carry the loop id through sorting so per-hole bottoms
  // (holeBottoms, keyed by loop id) survive any reordering.
  const rawCentroids = selectedLoops.map(l => ({ ...centroid(l.points), loopId: l.id }))

  // Sort
  let sortedPts: (Pt & { loopId: string })[]
  switch (params.sortStrategy) {
    case 'nearest_neighbor': sortedPts = nearestNeighbourSort(rawCentroids); break
    case 'by_x':             sortedPts = sortByX(rawCentroids);              break
    case 'by_y':             sortedPts = sortByY(rawCentroids);              break
    default:                 sortedPts = rawCentroids
  }

  // WO-3083: the R plane - where every hole starts feeding - sits ENTRY_CLEARANCE_MM above the
  // highest material over any hole (was the Feed plane, Top + 5, fed at plunge rate). One plane
  // for the operation, so a native canned cycle still carries one R.
  const material = entryMaterialOf(payload, topZ, feedZ)
  const holeBottomOf = (pt: Pt & { loopId: string }) => {
    const mapped = holeBottoms?.[pt.loopId]
    return mapped != null ? mapped + wcsOrigin.z : bottomZ
  }
  const entryRZ = Math.max(...sortedPts.map(pt => entryStartZ(material, pt, tool.diameter / 2, holeBottomOf(pt))))
  // 'clearance' posts as G98, which returns to the initial plane between holes, so its R is free
  // to sit just above the material. 'retract' posts as G99, whose native cycle returns to R
  // between holes: there R is also the hop, so it keeps the operator's Feed plane exactly as
  // before this order (at the default heights Feed = Retract, so the machine hops where this
  // stream shows). Lowering it to the entry height would hop the machine at Top + 1 while the
  // stream shows Retract.
  // WO-3104 unchecked restores typed reference planes: R is Feed in BOTH
  // modes. G98 returns at Retract; G99 returns at R by controller definition.
  const rPlaneZ = heights.minimizeZTravel === false ? feedZ
    : params.retractMode === 'clearance' ? entryRZ : feedZ
  // Between-hole hop Z. WO-3083 (owner 2026-10-23: "We don't need to go that high unless a
  // reposition move would go over a clamp"): both modes hop at Retract (G98 was Clearance). The
  // post starts the G98 cycle from this plane, so the machine returns where this stream hops; a
  // hop whose corridor crosses workholding is raised by the reach trim, and the post ends the
  // cycle to make that lift (cannedCycle.ts liftZ). First entry and final exit stay at Clearance.
  const betweenZ = params.retractMode === 'clearance' ? Math.max(retractZ, rPlaneZ) : retractZ

  const moves: ToolpathMove[] = []

  for (let i = 0; i < sortedPts.length; i++) {
    const pt = sortedPts[i]
    const isFirst = i === 0

    // Per-hole bottom (D1): holeBottoms entries are WCS-relative, same
    // convention as heights.bottomHeight — resolve exactly as resolveHeights
    // does (value + wcsOrigin.z). Holes absent from the map use the op-level
    // bottom plane. Depth and peck counts follow the per-hole bottom.
    const mapped = holeBottoms?.[pt.loopId]
    if (holeBottoms !== undefined && mapped == null) {
      // ADR 0003 Pattern 2: per-hole depth was requested but this loop has no
      // hole entry — fall back loudly to the op-level bottom plane.
      console.warn(`drill: holeBottoms has no entry for loop "${pt.loopId}" — using op-level bottom height`)
    }
    const holeBottomZ = mapped != null ? mapped + wcsOrigin.z : bottomZ
    const totalDepth = topZ - holeBottomZ  // positive: stock surface down to cut depth

    // Position above hole
    if (isFirst) {
      rapid(moves, pt.x, pt.y, clearanceZ)
    } else {
      rapid(moves, pt.x, pt.y, betweenZ)
    }

    // Approach the R plane
    feed(moves, pt.x, pt.y, rPlaneZ, feedRate, 'rapid')
    if (heights.minimizeZTravel === false) moves[moves.length - 1].type = 'rapid'

    // Drill cycle
    switch (params.cycleType) {
      case 'simple':
        emitSimple(moves, pt, holeBottomZ, plungeRate, 0)
        break
      case 'peck':
        emitPeck(moves, pt, holeBottomZ, rPlaneZ, retractZ, plungeRate, params.peckDepth, totalDepth,
          params.peckDecrement, params.minPeckDepth)
        break
      case 'chip_break':
        emitChipBreak(moves, pt, holeBottomZ, topZ, plungeRate, params.peckDepth, params.chipBreakRetract, totalDepth,
          params.peckDecrement, params.minPeckDepth)
        break
      case 'dwell':
        emitSimple(moves, pt, holeBottomZ, plungeRate, params.dwell)
        break
    }

    // Retract to between-hole height
    rapid(moves, pt.x, pt.y, betweenZ)

    // Progress checkpoint: one hole drilled (coarse — per hole).
    onProgress?.((i + 1) / sortedPts.length,
      sortedPts.length > 1 ? `Hole ${i + 1}/${sortedPts.length}` : undefined)
  }

  // Final retract to clearance
  if (sortedPts.length > 0) {
    const last = sortedPts[sortedPts.length - 1]
    rapid(moves, last.x, last.y, clearanceZ)
  }

  return moves
}

// G81 / G82 — simple drill (with optional dwell at bottom)
function emitSimple(
  moves: ToolpathMove[],
  pt: Pt,
  bottomZ: number,
  plungeRate: number,
  dwell: number, // seconds
) {
  feed(moves, pt.x, pt.y, bottomZ, plungeRate, 'plunge')
  if (dwell > 0) {
    // The pause at the bottom lives on the plunge itself (ToolpathMove.dwellMs),
    // so the estimate and both post paths read one canonical duration (WO-1516).
    moves[moves.length - 1].dwellMs = dwell * 1000
  }
  // Retract handled by caller (rapid to betweenZ)
}

// G83 — full-retract peck drill
function emitPeck(
  moves: ToolpathMove[],
  pt: Pt,
  bottomZ: number,
  feedZ: number,
  retractZ: number,
  plungeRate: number,
  peckDepth: number,
  totalDepth: number,
  peckDecrement?: number,
  minPeckDepth?: number,
) {
  // Peck increments are measured from the STOCK SURFACE (topZ), not from feedZ.
  // feedZ is ABOVE topZ, so starting the descent there while deriving the peck
  // count from topZ left the final peck ~(feedZ - topZ) short of the hole bottom
  // and emitted a dangling re-approach (DEF-4). Starting at topZ keeps the start
  // and the count consistent: the last peck clamps exactly to bottomZ (full depth)
  // and never trips the "more to go" retract. feedZ stays the re-approach ceiling
  // (WO-3083: the caller passes the R plane).
  const topZ = bottomZ + totalDepth
  const endZ = bottomZ

  // WO-1926: optional shrinking pecks. A positive finite peckDecrement shaves
  // each successive peck toward a floor (minPeckDepth, defaulting to the
  // decrement itself so a decrement set alone can never drive a peck to zero and
  // stall the loop). Neither field set -> the original constant-peck arithmetic
  // below, byte for byte.
  const decrement =
    (typeof peckDecrement === 'number' && Number.isFinite(peckDecrement) && peckDecrement > 0)
      ? peckDecrement
      : undefined

  if (decrement === undefined) {
    let currentZ = topZ
    const pecks = Math.ceil(totalDepth / peckDepth)

    for (let p = 0; p < pecks; p++) {
      const targetZ = Math.max(endZ, currentZ - peckDepth)
      feed(moves, pt.x, pt.y, targetZ, plungeRate, 'plunge')
      // Full retract after each peck (except the last, which reaches bottomZ — the
      // caller does the final retract). targetZ === endZ on the last peck, so this
      // never runs there.
      if (targetZ > endZ) {
        rapid(moves, pt.x, pt.y, retractZ)
        // G83 re-approach: RAPID back down to a small clearance above the depth
        // just reached, capped at the feed plane. Only that clearance plus the
        // next peck is then consumed at plunge feed (WO-1886). The old code fed
        // (at plunge rate) to a clearance above the depth at the START of the
        // peck, so each peck re-traced the whole drilled depth. The clearance
        // default is 0.5 mm (no per-op peck clearance setting exists yet).
        const reApproach = Math.min(feedZ, targetZ + PECK_REAPPROACH_CLEARANCE)
        rapid(moves, pt.x, pt.y, reApproach)
      }
      currentZ = targetZ
    }
    return
  }

  const floor =
    (typeof minPeckDepth === 'number' && Number.isFinite(minPeckDepth) && minPeckDepth > 0)
      ? minPeckDepth
      : decrement

  let peckLen = peckDepth
  let currentZ = topZ
  // Progressing by peckLen (>= floor > 0) always terminates, so a hard loop
  // bound is unnecessary; the epsilon only absorbs float noise on the final clamp.
  while (currentZ > endZ + 1e-9) {
    const targetZ = Math.max(endZ, currentZ - peckLen)
    feed(moves, pt.x, pt.y, targetZ, plungeRate, 'plunge')
    if (targetZ > endZ) {
      rapid(moves, pt.x, pt.y, retractZ)
      const reApproach = Math.min(feedZ, targetZ + PECK_REAPPROACH_CLEARANCE)
      rapid(moves, pt.x, pt.y, reApproach)
    }
    currentZ = targetZ
    peckLen = Math.max(floor, peckLen - decrement)
  }
}

// G73 — chip-break peck (partial retract, stays in hole)
function emitChipBreak(
  moves: ToolpathMove[],
  pt: Pt,
  bottomZ: number,
  topZ: number,
  plungeRate: number,
  peckDepth: number,
  chipBreakRetract: number,
  totalDepth: number,
  peckDecrement?: number,
  minPeckDepth?: number,
) {
  const endZ = bottomZ

  // WO-1926: the same shrinking-peck option as emitPeck (a chip-break peck is a
  // peck too). Only the retract differs — it stays in the hole. Neither field
  // set -> the original constant-peck arithmetic, byte for byte.
  const decrement =
    (typeof peckDecrement === 'number' && Number.isFinite(peckDecrement) && peckDecrement > 0)
      ? peckDecrement
      : undefined

  if (decrement === undefined) {
    let currentZ = topZ
    const pecks = Math.ceil(totalDepth / peckDepth)

    for (let p = 0; p < pecks; p++) {
      const targetZ = Math.max(endZ, currentZ - peckDepth)
      feed(moves, pt.x, pt.y, targetZ, plungeRate, 'plunge')
      if (targetZ > endZ) {
        // Partial retract only — stay in hole, don't exceed stock top
        const partialRetract = Math.min(topZ, targetZ + chipBreakRetract)
        rapid(moves, pt.x, pt.y, partialRetract)
      }
      currentZ = targetZ
    }
    return
  }

  const floor =
    (typeof minPeckDepth === 'number' && Number.isFinite(minPeckDepth) && minPeckDepth > 0)
      ? minPeckDepth
      : decrement

  let peckLen = peckDepth
  let currentZ = topZ
  while (currentZ > endZ + 1e-9) {
    const targetZ = Math.max(endZ, currentZ - peckLen)
    feed(moves, pt.x, pt.y, targetZ, plungeRate, 'plunge')
    if (targetZ > endZ) {
      const partialRetract = Math.min(topZ, targetZ + chipBreakRetract)
      rapid(moves, pt.x, pt.y, partialRetract)
    }
    currentZ = targetZ
    peckLen = Math.max(floor, peckLen - decrement)
  }
}
