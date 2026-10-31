// pocket2d.ts — 2D Pocket toolpath generator.
//
// Generates concentric offset ring toolpaths for clearing pocket floors with a
// flat or ball end mill. Supports islands, multiple depths, finish contour passes,
// helical entry, ramp entry, and both outside-in and inside-out fill orders.
//
// Algorithm overview
//   1. Offset the pocket boundary inward by (toolRadius + wallStock) to get the
//      outermost ring the tool centre can travel without cutting into the wall stock.
//   2. Generate successive inward rings at the requested stepover, preserving every
//      source vertex while subdividing long segments for smooth output.
//   3. Keep links down only when the accumulated cutter sweep proves them clear;
//      otherwise retract, reposition, and re-enter.
//   4. Expand islands by tool radius plus wall stock, bridge them during ring travel,
//      then cut each complete island roughing contour at every depth.
//   5. Validate complete island contours against the outer tool-center envelope and
//      every other island; fail loudly when the selected cutter cannot fit.
//   6. At final depth, optionally finish both the outer wall and every island wall at
//      their exact tool-radius offsets with internal-wall winding reversed.

import { signedArea, ensureCCW, centroid, pointInPolygon, largestLoop, minRadiusFrom, minSqDistToLoop, findContainingLoop, distToPolyBoundary } from './geometry'
import { offsetLoop } from './face2d/clipperOffset'
import { resolveHeights } from './heights'
import { resolveFeedrates } from './feedrates'
import { assertPocketEntryAllowed } from './pocketEntryPolicy'
import { entryStartZ, helixDescent, helixFits, MIN_HELIX_RADIUS_MM, rampDescent, resolveFloorHopMm, usableStock } from './moves'
import { assertToolFluteReach, operatorLoopRef } from './toolFluteReach'
import { directionForTool } from '../tool/cutHand'
import { clearanceAllowanceMmOf, type ToolReachInputs } from './holderClearanceGate'
import { applyRestAir2d } from './restAir2d'
import { appendCornerRelief } from './cornerRelief2d'
import { roundPocketRingCorners } from './pocketRingCorners'
import { EngagementFeedQuantizer, SweptMaterialIndex, nominalEngagement } from './engagement2d'
import type { StockState } from './stockState'
import {
  reduceRegionAroundKeepOuts, workholdingDepthBands, workholdingIslandNotice,
  type ReducedRegion,
} from './adaptiveClearing2d/engine/workholdingIsland'
import type { ToolpathMove, LoopData, PocketWorkerPayload, PocketParams, ToolpathStockBlock } from './types'


type Pt2 = { x: number; y: number }

interface IslandContourGroup {
  roughPaths: Pt2[][]
  finishPaths: Pt2[][]
}

const SAMPLE_FRAC   = 0.5
const MAX_MOVES     = 150_000

function buildDepths(topZ: number, bottomZ: number, stepdown: number): number[] {
  const sd = Math.abs(stepdown) || 1
  const depths: number[] = []
  let z = topZ - sd
  while (z > bottomZ + 0.001) {
    depths.push(z)
    z -= sd
  }
  depths.push(bottomZ)
  return depths
}

function rapidTo(moves: ToolpathMove[], point: Pt2, z: number): void {
  moves.push({ type: 'rapid', x: point.x, y: point.y, z, role: 'rapid' })
}

function feedTo(
  moves: ToolpathMove[],
  point: Pt2,
  z: number,
  feedRate: number,
  role: ToolpathMove['role'] = 'cut',
): void {
  moves.push({ type: 'feed', x: point.x, y: point.y, z, feed: feedRate, role })
}

function plungeAt(
  moves: ToolpathMove[],
  point: Pt2,
  depth: number,
  feedRate: number,
): void {
  feedTo(moves, point, depth, feedRate, 'plunge')
}

function retractLinkPlunge(
  moves: ToolpathMove[],
  fromPt: Pt2,
  toPt: Pt2,
  retractZ: number,
  depth: number,
  plungeRate: number,
): void {
  rapidTo(moves, fromPt, retractZ)
  rapidTo(moves, toPt, retractZ)
  plungeAt(moves, toPt, depth, plungeRate)
}
const MIN_AREA_FRAC = 0.05   // keep rings with area ≥ MIN_AREA_FRAC × π × R_tool²

// ── Arc-length parameterised closed curve ──────────────────────────────────────

interface ArcCurve { pts: Pt2[]; cumLen: number[]; total: number }

function buildArcCurve(pts: Pt2[]): ArcCurve {
  const n = pts.length
  const cumLen: number[] = [0]
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n
    cumLen.push(cumLen[i] + Math.hypot(pts[j].x - pts[i].x, pts[j].y - pts[i].y))
  }
  return { pts, cumLen, total: cumLen[n] }
}

function sampleAt(c: ArcCurve, t: number): Pt2 {
  if (c.total < 1e-9) return c.pts[0]
  const target = (((t % 1) + 1) % 1) * c.total
  let lo = 0, hi = c.pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (c.cumLen[mid + 1] < target) lo = mid + 1; else hi = mid
  }
  const sl = c.cumLen[lo + 1] - c.cumLen[lo]
  const u  = sl < 1e-10 ? 0 : (target - c.cumLen[lo]) / sl
  const j  = (lo + 1) % c.pts.length
  return { x: c.pts[lo].x + u * (c.pts[j].x - c.pts[lo].x),
           y: c.pts[lo].y + u * (c.pts[j].y - c.pts[lo].y) }
}

function nearestT(pt: Pt2, c: ArcCurve): number {
  // Coarse scan then refine — more samples for longer curves for accuracy
  const samples = Math.max(48, Math.min(400, Math.ceil(c.total / 0.5)))
  let bestT = 0, bestD = Infinity
  for (let i = 0; i < samples; i++) {
    const t = i / samples, p = sampleAt(c, t)
    const d = (p.x - pt.x) ** 2 + (p.y - pt.y) ** 2
    if (d < bestD) { bestD = d; bestT = t }
  }
  return bestT
}

function tangentAt(c: ArcCurve, t: number): Pt2 {
  if (c.total < 1e-9 || c.pts.length < 2) return { x: 1, y: 0 }
  const target = (((t % 1) + 1) % 1) * c.total
  let lo = 0, hi = c.pts.length - 1
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (c.cumLen[mid + 1] < target) lo = mid + 1; else hi = mid
  }
  const j  = (lo + 1) % c.pts.length
  const dx = c.pts[j].x - c.pts[lo].x, dy = c.pts[j].y - c.pts[lo].y
  const len = Math.hypot(dx, dy)
  return len < 1e-9 ? { x: 1, y: 0 } : { x: dx / len, y: dy / len }
}

// ── Ring generation ────────────────────────────────────────────────────────────
// Returns all generations in outside-in order: generations[0] = outermost.
// Each generation may contain multiple loops (non-convex pockets that split).

/**
 * Walk a directed closed curve by exact arc distance without ever chord-cutting
 * a source vertex. Each source edge is subdivided independently, so every
 * crossed vertex is emitted and every emitted segment is <= maxStep long.
 *
 * With no callback this is the exact move-count preflight. Supplying a callback
 * replays the identical partition and reports exact accumulated travel for Z.
 */
function walkArcDistance(
  curve: ArcCurve, startT: number, totalDistance: number, maxStep: number,
  onSample?: (point: Pt2, traveled: number) => void,
  moveLimit = Number.POSITIVE_INFINITY,
): number {
  if (curve.total < 1e-9 || curve.pts.length === 0 || totalDistance <= 1e-12) return 0

  const epsilon = Math.max(1e-10, curve.total * 1e-12)
  const normalizedT = ((startT % 1) + 1) % 1
  const startDistance = normalizedT * curve.total
  const stepLimit = Math.max(0.01, maxStep)
  const segmentCount = curve.pts.length

  // If startDistance is exactly a source vertex, use its outgoing edge.
  let segment = 0
  while (segment < segmentCount - 1 &&
         curve.cumLen[segment + 1] <= startDistance + epsilon) segment++
  let localDistance = Math.max(0, startDistance - curve.cumLen[segment])
  let traveled = 0
  let moveCount = 0
  let zeroEdgeGuard = 0

  while (traveled < totalDistance - epsilon) {
    const edgeLength = curve.cumLen[segment + 1] - curve.cumLen[segment]
    if (edgeLength <= epsilon || edgeLength - localDistance <= epsilon) {
      segment = (segment + 1) % segmentCount
      localDistance = 0
      zeroEdgeGuard++
      if (zeroEdgeGuard > segmentCount) {
        throw new Error('Pocket 2D Profile Ramp: first scheduled ring contains no walkable edge.')
      }
      continue
    }
    zeroEdgeGuard = 0

    const available = edgeLength - localDistance
    const span = Math.min(totalDistance - traveled, available)
    const subdivisions = Math.max(1, Math.ceil(span / stepLimit))
    if (Number.isFinite(moveLimit) && moveCount + subdivisions > moveLimit)
      return moveLimit + 1
    const a = curve.pts[segment]
    const b = curve.pts[(segment + 1) % segmentCount]

    if (onSample) {
      for (let index = 1; index <= subdivisions; index++) {
        const alongSpan = span * index / subdivisions
        const sampleTravel = traveled + alongSpan
        const reachesVertex = index === subdivisions && span >= available - epsilon
        if (reachesVertex) {
          onSample(b, sampleTravel)
        } else {
          const u = Math.min(1, (localDistance + alongSpan) / edgeLength)
          onSample({
            x: a.x + u * (b.x - a.x),
            y: a.y + u * (b.y - a.y),
          }, sampleTravel)
        }
      }
    }

    moveCount += subdivisions
    traveled += span
    localDistance += span
    if (localDistance >= edgeLength - epsilon) {
      segment = (segment + 1) % segmentCount
      localDistance = 0
    }
  }

  return moveCount
}

function assertPocketMoveCapacity(
  moves: ToolpathMove[], additionalMoves: number, context: string,
): void {
  if (moves.length + Math.max(0, additionalMoves) <= MAX_MOVES) return
  throw new Error(
    `Pocket 2D would exceed the ${MAX_MOVES}-move safety limit while ${context}. ` +
    'Refusing to return a silently truncated or partial toolpath. Increase stepover, ' +
    'increase the ramp angle, reduce pocket depth, or split the operation.',
  )
}

function generateRings(
  outerPts: Pt2[], toolRadius: number, wallStock: number, stepover: number,
): { generations: Pt2[][][]; finishPath: Pt2[] | null } {
  const minArea = Math.PI * toolRadius * toolRadius * MIN_AREA_FRAC

  let current: Pt2[][] = cleanOffsetLoops(offsetLoop(outerPts, -(toolRadius + wallStock)), minArea)
  if (current.length === 0) return { generations: [], finishPath: null }

  const generations: Pt2[][][] = []
  while (generations.length < 2000 && current.length > 0) {
    generations.push(current)
    const next: Pt2[][] = []
    for (const loop of current) {
      const loopArea = Math.abs(signedArea(loop))
      next.push(...cleanOffsetLoops(offsetLoop(loop, -stepover), minArea, loopArea))
    }
    current = next
  }

  // Centre cleanup: step inward from the last regular ring using toolRadius
  // (not stepover) until the robust offsetter returns nothing.
  //
  // Why a separate minArea here: the main-loop minArea (5 % of tool circle)
  // stops rings that are too small for a meaningful stepover pass, but it is
  // far too aggressive for centre cleanup — it truncates the inward march
  // while the enclosed area is still larger than the tool can reach.  We use
  // a near-zero threshold so only truly degenerate geometry is rejected.
  //
  // Each loop in the last generation is processed independently, so pockets
  // that have already split into sub-regions each get their own cleanup chain.
  const cleanupMinArea = 1e-4   // essentially zero — let the geometry decide
  if (generations.length > 0) {
    let cleanupSrc = generations[generations.length - 1]
    for (let guard = 0; guard < 500; guard++) {
      const next: Pt2[][] = []
      for (const loop of cleanupSrc) {
        const loopArea = Math.abs(signedArea(loop))
        next.push(...cleanOffsetLoops(offsetLoop(loop, -toolRadius), cleanupMinArea, loopArea))
      }
      if (next.length === 0) break
      generations.push(next)
      cleanupSrc = next
    }
  }

  // Finish-contour path at exact tool-centre offset (no wall stock)
  let finishPath: Pt2[] | null = null
  if (wallStock > 0) {
    const subs = cleanOffsetLoops(offsetLoop(outerPts, -toolRadius), 0)
    finishPath = subs.length > 0 ? largestLoop(subs) : null
  }
  return { generations, finishPath }
}

/**
 * Subdivide one complete revolution without losing the source polygon vertices.
 *
 * Uniform arc-length sampling alone turns every sharp vertex that falls between
 * samples into a chord. On rectangular offsets that visibly clips all four
 * corners. This walks from the arbitrary start parameter to each subsequent
 * source vertex, subdivides only the intervening segment, and emits the vertex
 * itself exactly before continuing.
 */
function fullLoopSamples(c: ArcCurve, startT: number, maxStep: number): Pt2[] {
  if (c.total < 1e-9 || c.pts.length === 0) return []

  const normalizedT = ((startT % 1) + 1) % 1
  const startDistance = normalizedT * c.total
  const stops: { distance: number; point: Pt2 }[] = []
  const distanceEpsilon = Math.max(1e-9, c.total * 1e-12)

  for (let i = 0; i < c.pts.length; i++) {
    let distance = c.cumLen[i] - startDistance
    while (distance <= distanceEpsilon) distance += c.total
    if (distance <= c.total + distanceEpsilon)
      stops.push({ distance: Math.min(distance, c.total), point: c.pts[i] })
  }

  stops.sort((a, b) => a.distance - b.distance)
  const startPoint = sampleAt(c, normalizedT)
  if (stops.length === 0 || Math.abs(stops[stops.length - 1].distance - c.total) > distanceEpsilon)
    stops.push({ distance: c.total, point: startPoint })

  const samples: Pt2[] = []
  let previousDistance = 0
  for (const stop of stops) {
    const span = stop.distance - previousDistance
    if (span <= distanceEpsilon) continue
    const subdivisions = Math.max(1, Math.ceil(span / Math.max(maxStep, 0.01)))
    for (let i = 1; i <= subdivisions; i++) {
      if (i === subdivisions) {
        samples.push(stop.point)
      } else {
        const distance = previousDistance + span * i / subdivisions
        samples.push(sampleAt(c, (startDistance + distance) / c.total))
      }
    }
    previousDistance = stop.distance
  }

  return samples
}

// ── Loop classifier ────────────────────────────────────────────────────────────

function cleanOffsetLoops(raw: Pt2[][], minArea: number, parentArea = Infinity): Pt2[][] {
  return raw
    .filter(l => l.length >= 3 && l.every(p => isFinite(p.x) && isFinite(p.y)))
    .map(l => ensureCCW([...l]) as Pt2[])
    .filter(l => {
      const area = Math.abs(signedArea(l))
      return area >= minArea && area < parentArea * 0.999
    })
}

function classifyLoops(loops: LoopData[]): { outerBounds: LoopData[]; islandPool: LoopData[] } {
  const byType = loops.some(l => l.type === 'contour' || l.type === 'hole')
  if (byType && loops.some(l => l.type === 'contour'))
    return { outerBounds: loops.filter(l => l.type === 'contour'),
             islandPool:  loops.filter(l => l.type === 'hole') }
  if (byType) {
    // Holes picked with no contour: an STL's bores and reliefs load as 'hole'
    // chains, and a bore picked alone is the region to clear. Nest the picks the
    // way 2D Adaptive does (adaptiveClearing2d/engine/index.ts): largest first, a
    // loop inside no larger picked loop bounds a region of its own, and a loop
    // inside one is that region's island.
    const outerBounds: LoopData[] = []
    const islandPool: LoopData[] = []
    const byArea = [...loops].sort((a, b) =>
      Math.abs(signedArea(b.points as Pt2[])) - Math.abs(signedArea(a.points as Pt2[])))
    for (const loop of byArea) {
      const c = centroid(loop.points as Pt2[])
      if (outerBounds.some(o => pointInPolygon(c, o.points as Pt2[]))) islandPool.push(loop)
      else outerBounds.push(loop)
    }
    return { outerBounds: loops.filter(l => outerBounds.includes(l)), islandPool }
  }
  const outer   = loops.filter(l => signedArea(l.points as Pt2[]) > 0)
  const islands = loops.filter(l => signedArea(l.points as Pt2[]) <= 0)
  if (outer.length === 0) {
    const sorted = [...loops].sort((a, b) =>
      Math.abs(signedArea(b.points as Pt2[])) - Math.abs(signedArea(a.points as Pt2[])))
    return { outerBounds: [sorted[0]], islandPool: sorted.slice(1) }
  }
  return { outerBounds: outer, islandPool: islands }
}

/**
 * WO-1579. Where workholding reaches into the depths this pocket cuts, its footprint -
 * grown by the Shank clearance - is taken out of the region like an island, so the
 * rings route around a clamp and clear everything else. No workholding in reach
 * leaves the classified loops exactly as they were. The worker's reach trim still
 * runs on the result.
 *
 * WO-1618. The footprint is taken out only at the depths that reach it: the depths
 * are cut in bands, each with its own region, so a vise under a through pocket leaves
 * the pocket cleared in full down to just above the vise top.
 */
interface PocketDepthBand {
  depths: number[]
  reduced: ReducedRegion | null
  addedFloorZ?: number
  workholdingTopZ?: number
}

function pocketDepthBands(
  classified: { outerBounds: LoopData[]; islandPool: LoopData[] },
  payload: PocketWorkerPayload,
  topZ: number,
  allDepths: number[],
): PocketDepthBand[] {
  const reach = payload as PocketWorkerPayload & ToolReachInputs
  if (!reach.workholding || reach.workholding.length === 0) return [{ depths: allDepths, reduced: null }]
  const region = [
    ...classified.outerBounds.map(l => ensureCCW([...l.points as Pt2[]]) as Pt2[]),
    ...classified.islandPool.map(l => {
      const pts = [...l.points as Pt2[]]
      return signedArea(pts) > 0 ? pts.reverse() : pts
    }),
  ]
  const bands: PocketDepthBand[] = []
  for (const band of workholdingDepthBands({
    meshes: reach.workholding,
    depths: allDepths,
    topZ: topZ + Math.max(0, payload.tool.fluteLength || 0),
    allowanceMm: clearanceAllowanceMmOf(reach),
  })) {
    const reduced = reduceRegionAroundKeepOuts(region, band.keepOuts)
    const above = bands[bands.length - 1]
    // A floor added for a footprint that takes nothing more out of THIS region is dropped.
    if (above && Math.abs((above.reduced?.removedAreaMm2 ?? 0) - (reduced?.removedAreaMm2 ?? 0)) <= 1e-3) {
      if (above.addedFloorZ !== undefined) above.depths.pop()
      above.depths.push(...band.depths)
      above.addedFloorZ = band.addedFloorZ
      above.workholdingTopZ = band.workholdingTopZ
      continue
    }
    bands.push({ depths: [...band.depths], reduced, addedFloorZ: band.addedFloorZ, workholdingTopZ: band.workholdingTopZ })
  }
  const last = bands[bands.length - 1]
  if (last.addedFloorZ !== undefined) {
    last.depths.pop()
    delete last.addedFloorZ
    delete last.workholdingTopZ
  }
  return bands
}

function classifyBand(
  classified: { outerBounds: LoopData[]; islandPool: LoopData[] },
  band: PocketDepthBand,
): { outerBounds: LoopData[]; islandPool: LoopData[]; underWorkholding?: true } {
  const { reduced } = band
  if (!reduced) return classified
  if (!reduced.loops.some(points => signedArea(points) > 0)) {
    return { outerBounds: [], islandPool: [], underWorkholding: true }
  }
  const pieces: LoopData[] = reduced.loops.map((points, index) => ({
    id: `workholding-region-${index}`,
    points,
    closed: true,
    type: signedArea(points) > 0 ? 'contour' : 'hole',
  }))
  return {
    outerBounds: pieces.filter(l => l.type === 'contour'),
    islandPool: pieces.filter(l => l.type === 'hole'),
  }
}

function formatMm(mm: number): string {
  return String(Number(mm.toFixed(2)))
}

// ── Depth array ────────────────────────────────────────────────────────────────

// ── Entry: ramp along a curve ──────────────────────────────────────────────────

function rampAlongPath(
  moves: ToolpathMove[], curve: ArcCurve,
  startT: number, fromZ: number, toZ: number,
  tanAngle: number, rampRate: number,
): number {
  if (fromZ <= toZ + 1e-6) return startT
  const totalDrop = fromZ - toZ
  const effectiveTan = Math.max(tanAngle, 0.001)
  const neededArc = totalDrop / effectiveTan
  const step      = Math.max(0.1, Math.min(2.0, curve.total / 36))
  const remainingMoves = Math.max(0, MAX_MOVES - moves.length)
  const rampMoveCount = walkArcDistance(
    curve, startT, neededArc, step, undefined, remainingMoves,
  )
  if (rampMoveCount > remainingMoves) {
    throw new Error(
      `Pocket 2D Profile Ramp requires more than the ${remainingMoves} remaining moves, ` +
      'which would exceed ' +
      `the ${MAX_MOVES}-move safety limit. Increase the ramp angle or use Plunge. ` +
      'Refusing to replace the requested ramp with a silent plunge.',
    )
  }

  rampDescent(moves, (length, visit) => {
    walkArcDistance(curve, startT, length, step, visit)
  }, fromZ, toZ, neededArc, rampRate)
  return (startT + neededArc / curve.total) % 1
}

// ── Entry dispatcher ───────────────────────────────────────────────────────────

function performEntry(
  moves: ToolpathMove[], entryType: string, ctr: Pt2,
  rampCurve: ArcCurve, helixR: number,
  fromZ: number, toZ: number, tanAngle: number, rampAngle: number,
  plungeRate: number, rampRate: number,
): { endPt: Pt2 } {
  if (entryType === 'ramp_helical' && helixFits(helixR)) {
    rapidTo(moves, { x: ctr.x + helixR, y: ctr.y }, fromZ)
    return {
      endPt: helixDescent(moves, {
        centre: ctr, radius: helixR, fromZ, toZ,
        tanAngle: Math.tan(rampAngle * Math.PI / 180), feed: rampRate,
      }),
    }
  }
  if (entryType === 'ramp_linear' && rampCurve.total > 1e-6) {
    const endT = rampAlongPath(moves, rampCurve, 0, fromZ, toZ, tanAngle, rampRate)
    return { endPt: sampleAt(rampCurve, endT) }
  }
  // Default: plunge at ctr
  rapidTo(moves, ctr, fromZ)
  plungeAt(moves, ctr, toZ, plungeRate)
  return { endPt: ctr }
}

// ── Island arc bridge ──────────────────────────────────────────────────────────
// Routes around an island boundary instead of cutting through it.
// Validates every bridge point against outerRings — the outermost cutting rings
// define where the tool centre is allowed to be.  Returns true if a valid route
// was emitted; false means the gap is too narrow and the caller must retract.

function emitIslandBridge(
  moves: ToolpathMove[], fromPt: Pt2, toPt: Pt2, island: Pt2[],
  depth: number, feedRate: number, useClimb: boolean,
  outerRings: Pt2[][],
): boolean {
  const c = buildArcCurve(island)
  if (c.total < 1e-6) return true   // degenerate island — nothing to route around

  const tEntry = nearestT(fromPt, c)
  const tExit  = nearestT(toPt,   c)
  const dtCCW  = ((tExit  - tEntry) + 1) % 1
  const dtCW   = ((tEntry - tExit)  + 1) % 1

  // Preferred direction first (climb → CCW, conventional → CW), then the other.
  const dirs = useClimb
    ? [{ dt: dtCCW, sign:  1 }, { dt: dtCW, sign: -1 }]
    : [{ dt: dtCW,  sign: -1 }, { dt: dtCCW, sign:  1 }]

  for (const { dt, sign } of dirs) {
    const nPts = Math.max(8, Math.ceil(dt * c.total / 0.5))
    const pts: Pt2[] = []
    let valid = true
    for (let i = 1; i <= nPts; i++) {
      const t  = ((tEntry + sign * dt * i / nPts) % 1 + 1) % 1
      const pt = sampleAt(c, t)
      pts.push(pt)
      // The bridge point must lie inside at least one outer cutting ring.
      // If it doesn't, the gap is narrower than the tool radius — not safe.
      if (!outerRings.some(r => pointInPolygon(pt, r))) { valid = false; break }
    }
    if (valid) {
      for (const pt of pts)
        feedTo(moves, pt, depth, feedRate, 'cut')
      return true
    }
  }
  return false   // no valid path around the island — caller must retract
}

// ── Keep-out back-off ──────────────────────────────────────────────────────────
// pOut is outside every island keep-out, pIn is inside one. Binary-search the
// crossing along pOut→pIn, then back off a small margin toward pOut so the
// returned point sits strictly OUTSIDE the keep-out. Returns null when the
// clear span is too short to be worth emitting (pOut already at the boundary).

const KEEPOUT_MARGIN = 0.02   // mm strictly outside the keep-out boundary

function backOffFromKeepOut(pOut: Pt2, pIn: Pt2, islands: Pt2[][]): Pt2 | null {
  let lo = 0, hi = 1
  for (let k = 0; k < 24; k++) {
    const mid = (lo + hi) / 2
    const p = { x: pOut.x + mid * (pIn.x - pOut.x), y: pOut.y + mid * (pIn.y - pOut.y) }
    if (findContainingLoop(p, islands) >= 0) hi = mid; else lo = mid
  }
  const len = Math.hypot(pIn.x - pOut.x, pIn.y - pOut.y)
  if (len < 1e-9) return null
  const tSafe = lo - KEEPOUT_MARGIN / len
  if (tSafe < 1e-6) return null
  return { x: pOut.x + tSafe * (pIn.x - pOut.x), y: pOut.y + tSafe * (pIn.y - pOut.y) }
}

// ── Cut one complete ring ──────────────────────────────────────────────────────
// Starts at arc-t = startT, makes one full revolution + optional overlapMm extension.
// Returns { lastPt, exitTangent } — exitTangent is used for arc lead-in to the next ring.

function cutRingFull(
  moves: ToolpathMove[], ring: Pt2[], startT: number,
  islands: Pt2[][], outerRings: Pt2[][],
  depth: number, retractZ: number,
  feedRate: number, plungeRate: number,
  sampleStep: number, useClimb: boolean,
  overlapMm = 0,
): { lastPt: Pt2; exitTangent: Pt2 } {
  const curve = buildArcCurve(ring)
  const fallback = ring[0] ?? { x: 0, y: 0 }
  if (curve.total < 1e-6) return { lastPt: fallback, exitTangent: { x: 1, y: 0 } }
  let lastPt: Pt2 = sampleAt(curve, startT)
  let islandActive = false, islandIdx = -1
  let islandEntryPt = lastPt

  for (const pt of fullLoopSamples(curve, startT, sampleStep)) {
    const ii = findContainingLoop(pt, islands)

    if (ii >= 0 && !islandActive) {
      islandActive = true; islandIdx = ii; islandEntryPt = lastPt
    } else if (ii < 0 && islandActive) {
      if (islandIdx >= 0) {
        const ok = emitIslandBridge(
          moves, islandEntryPt, pt, islands[islandIdx],
          depth, feedRate, useClimb, outerRings)
        if (!ok) {
          // Gap too narrow to route around the island while staying inside the pocket.
          // Retract, rapid to the exit point, and plunge back in.
          retractLinkPlunge(moves, islandEntryPt, pt, retractZ, depth, plungeRate)
        }
      }
      islandActive = false; islandIdx = -1
      feedTo(moves, pt, depth, feedRate, 'cut')
      lastPt = pt
    } else if (ii < 0) {
      feedTo(moves, pt, depth, feedRate, 'cut')
      lastPt = pt
    }
  }

  // Overlap: continue past the seam to prevent witness marks.
  // Island-checked like the main revolution above — the original block emitted
  // samples unconditionally, which produced cut endpoints inside the island
  // keep-out whenever the seam region grazed an island. When a sample (or the
  // final interpolated endpoint) lands inside a keep-out, bisect back along the
  // segment so the emitted endpoint sits a small margin OUTSIDE, then end the
  // overlap there — a shortened overlap is a cosmetic witness-mark tradeoff,
  // an island nick is a gouge (safety over stay-down).
  if (overlapMm > 0 && curve.total > 1e-6) {
    let distAccum = 0
    let prevPt = lastPt
    let curT = startT
    const step = sampleStep / curve.total
    // When the revolution tail was island-swallowed, lastPt sits far behind the
    // seam and the chord from lastPt to the first overlap sample can pass
    // straight through the keep-out. Never interpolate along that chord: if it
    // intrudes, skip the overlap entirely.
    const firstPt = sampleAt(curve, (curT + step) % 1)
    let chordClear = true
    for (let k = 0; k <= 8; k++) {
      const u = k / 8
      const p = { x: prevPt.x + u * (firstPt.x - prevPt.x),
                  y: prevPt.y + u * (firstPt.y - prevPt.y) }
      if (findContainingLoop(p, islands) >= 0) { chordClear = false; break }
    }
    while (chordClear && distAccum < overlapMm) {
      curT = (curT + step) % 1
      const pt = sampleAt(curve, curT)
      if (findContainingLoop(pt, islands) >= 0) {
        const safe = backOffFromKeepOut(prevPt, pt, islands)
        if (safe) {
          feedTo(moves, safe, depth, feedRate, 'cut')
          lastPt = safe
        }
        break
      }
      const seg = Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y)
      if (distAccum + seg >= overlapMm) {
        const frac = (overlapMm - distAccum) / Math.max(seg, 1e-9)
        const ip = { x: prevPt.x + frac * (pt.x - prevPt.x), y: prevPt.y + frac * (pt.y - prevPt.y) }
        if (findContainingLoop(ip, islands) >= 0) {
          const safe = backOffFromKeepOut(prevPt, ip, islands)
          if (safe) {
            feedTo(moves, safe, depth, feedRate, 'cut')
            lastPt = safe
          }
          break
        }
        feedTo(moves, ip, depth, feedRate, 'cut')
        lastPt = ip
        break
      }
      feedTo(moves, pt, depth, feedRate, 'cut')
      lastPt = pt; prevPt = pt; distAccum += seg
    }
  }

  // Exit tangent from the last two emitted moves for smooth arc lead-in to next ring
  const n = moves.length
  let exitTangent: Pt2
  if (n >= 2) {
    const a = moves[n - 2], b = moves[n - 1]
    const dx = (b.x ?? 0) - (a.x ?? 0), dy = (b.y ?? 0) - (a.y ?? 0)
    const len = Math.hypot(dx, dy)
    exitTangent = len > 1e-6 ? { x: dx / len, y: dy / len } : tangentAt(curve, startT)
  } else {
    exitTangent = tangentAt(curve, startT)
  }

  return { lastPt, exitTangent }
}

// ── Safe direct-feed check ─────────────────────────────────────────────────────
// Checks 9 evenly-spaced points along fromPt→toPt INCLUDING both endpoints.
// The midpoint-only check missed cases where the path arc crosses an island or
// boundary mid-segment (e.g. exiting a helix entry toward a ring point on the
// far side of an island); the interior-only check additionally missed targets
// that sit exactly inside a keep-out (a direct feed TO a gouging point).

// Outside-in first-ring entry planning. The direct-feed safety helper resumes below.
interface FirstRingPlan {
  /** Raw ring object retained so the scheduler can recognize this exact ring. */
  sourceRing: Pt2[]
  /** The same ring in the exact climb/conventional direction that will be cut. */
  directedRing: Pt2[]
  curve: ArcCurve
  startT: number
  startPt: Pt2
}

interface EntryResult {
  endPt: Pt2
  /** Present only when Profile Ramp already completed the first ring at depth. */
  preCutRing?: Pt2[]
  preCutPath?: Pt2[]
  exitTangent?: Pt2
}

function orientRoughRing(ring: Pt2[], useClimb: boolean): Pt2[] {
  const ccw = ensureCCW([...ring]) as Pt2[]
  return useClimb ? ccw : ([...ccw].reverse() as Pt2[])
}

/**
 * Bind entry to the exact ring that the outside-in scheduler will cut first.
 * The scheduler receives this object too, so entry planning and ring ordering
 * cannot independently choose different loops in a split first generation.
 */
function planFirstScheduledRing(
  cutGens: Pt2[][][], useClimb: boolean, islands: Pt2[][],
): FirstRingPlan {
  const sourceRing = largestLoop(cutGens[0])
  const directedRing = orientRoughRing(sourceRing, useClimb)
  const curve = buildArcCurve(directedRing)
  if (curve.total < 1e-6) {
    throw new Error('Pocket 2D: the first scheduled outer ring is degenerate; entry cannot be planned.')
  }
  let startT = 0
  if (findContainingLoop(sampleAt(curve, startT), islands) >= 0) {
    const samples = Math.max(32, Math.ceil(curve.total / 0.25))
    let found = false
    for (let index = 1; index <= samples; index++) {
      const candidateT = index / samples
      if (findContainingLoop(sampleAt(curve, candidateT), islands) < 0) {
        startT = candidateT
        found = true
        break
      }
    }
    if (!found) {
      throw new Error(
        'Pocket 2D: no island-clear start exists on the first scheduled outer ring. ' +
        'Choose different geometry or a smaller tool.',
      )
    }
  }
  return { sourceRing, directedRing, curve, startT, startPt: sampleAt(curve, startT) }
}

function emitProfileCleanupLap(
  moves: ToolpathMove[], curve: ArcCurve, startT: number,
  depth: number, feedRate: number, sampleStep: number, overlapMm: number,
): { lastPt: Pt2; exitTangent: Pt2 } {
  let lastPt = sampleAt(curve, startT)
  for (const point of fullLoopSamples(curve, startT, sampleStep)) {
    feedTo(moves, point, depth, feedRate, 'cut')
    lastPt = point
  }

  let overlapTravel = 0
  const overlapStep = Math.max(0.01, sampleStep)
  walkArcDistance(curve, startT, Math.max(0, overlapMm), overlapStep, (point, traveled) => {
    overlapTravel = traveled
    lastPt = point
    feedTo(moves, lastPt, depth, feedRate, 'cut')
  })

  return {
    lastPt,
    exitTangent: tangentAt(curve, startT + overlapTravel / curve.total),
  }
}

/**
 * Execute an outside-in entry at the first scheduled ring.
 *
 * Profile Ramp descends from the material surface (stock top for the first Z
 * level, the previous machined depth thereafter), then cuts one complete lap
 * at target depth before any stepover. Only that at-depth lap is credited to
 * the cleared-stock model; the descending sweep is deliberately not credited.
 */
function performOutsideInEntry(
  moves: ToolpathMove[], plan: FirstRingPlan, entryType: string,
  materialSurfaceZ: number, depth: number,
  clearanceZ: number, retractZ: number,
  tanAngle: number, plungeRate: number, rampRate: number, feedRate: number,
  sampleStep: number, overlapMm: number, islands: Pt2[][],
): EntryResult {
  if (entryType === 'plunge') {
    rapidTo(moves, plan.startPt, clearanceZ)
    rapidTo(moves, plan.startPt, retractZ)
    plungeAt(moves, plan.startPt, depth, plungeRate)
    return { endPt: plan.startPt }
  }

  if (entryType !== 'ramp_linear') {
    throw new Error(`Pocket 2D: unsupported outside-in entry type "${entryType}".`)
  }

  // A profile ramp cannot use the ring cutter's retract-and-bridge behavior:
  // the entire descending motion must remain one continuous profile. Refuse a
  // ring that crosses an expanded island keep-out instead of hiding a plunge.
  if (!closedPathStaysOutsideKeepOuts(plan.directedRing, islands)) {
    throw new Error(
      'Pocket 2D Profile Ramp: the first scheduled outer ring crosses an island ' +
      'keep-out. Choose Plunge or change the geometry; no silent entry fallback was emitted.',
    )
  }

  const neededArc = Math.max(0, materialSurfaceZ - depth) / Math.max(tanAngle, 0.001)
  const endT = (plan.startT + neededArc / plan.curve.total) % 1
  const cleanupMoves = fullLoopSamples(plan.curve, endT, sampleStep).length
  const approachMoves = Math.abs(materialSurfaceZ - retractZ) > 1e-9 ? 3 : 2
  const variableMoveBudget = Math.max(
    0, MAX_MOVES - moves.length - approachMoves - cleanupMoves,
  )
  const overlapStep = Math.max(0.01, sampleStep)
  const overlapMoves = walkArcDistance(
    plan.curve, endT, Math.max(0, overlapMm), overlapStep,
    undefined, variableMoveBudget,
  )
  const rampMoveBudget = Math.max(0, variableMoveBudget - overlapMoves)
  const rampStep = Math.max(0.1, Math.min(2.0, plan.curve.total / 36))
  const rampMoves = walkArcDistance(
    plan.curve, plan.startT, neededArc, rampStep, undefined, rampMoveBudget,
  )
  const plannedMoves = approachMoves + rampMoves + cleanupMoves + overlapMoves
  if (overlapMoves > variableMoveBudget || rampMoves > rampMoveBudget ||
      moves.length + plannedMoves > MAX_MOVES) {
    throw new Error(
      'Pocket 2D Profile Ramp requires more entry and cleanup moves than remain and would ' +
      `exceed the ${MAX_MOVES}-move safety limit. Increase the ramp angle or use Plunge. ` +
      'Refusing to replace the requested ramp with a silent plunge or return a partial path.',
    )
  }

  rapidTo(moves, plan.startPt, clearanceZ)
  rapidTo(moves, plan.startPt, retractZ)
  if (Math.abs(materialSurfaceZ - retractZ) > 1e-9)
    rapidTo(moves, plan.startPt, materialSurfaceZ)

  const actualEndT = rampAlongPath(
    moves, plan.curve, plan.startT, materialSurfaceZ, depth,
    tanAngle, rampRate,
  )
  const cleanup = emitProfileCleanupLap(
    moves, plan.curve, actualEndT, depth, feedRate, sampleStep, overlapMm,
  )
  return {
    endPt: cleanup.lastPt,
    preCutRing: plan.sourceRing,
    preCutPath: plan.directedRing,
    exitTangent: cleanup.exitTangent,
  }
}

// Checks 9 evenly-spaced points along the link, including both endpoints. This
// catches island/boundary crossings and targets that lie inside a keep-out.
function pathIsSafe(fromPt: Pt2, toPt: Pt2, outerPoly: Pt2[], islands: Pt2[][]): boolean {
  const N = 8
  for (let i = 0; i <= N; i++) {
    const t  = i / N
    const pt = { x: fromPt.x + t * (toPt.x - fromPt.x), y: fromPt.y + t * (toPt.y - fromPt.y) }
    if (!pointInPolygon(pt, outerPoly)) return false
    if (islands.some(isl => pointInPolygon(pt, isl))) return false
  }
  return true
}

/**
 * Validate an approach to a point that intentionally lies on a keep-out
 * boundary. The target is omitted because point-in-polygon classification at an
 * exact boundary is numerically ambiguous; every interior station is still
 * checked, so an approach through an island is rejected.
 */
function boundaryApproachIsSafe(
  fromPt: Pt2, toPt: Pt2, outerPoly: Pt2[], islands: Pt2[][],
): boolean {
  const chord = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y)
  const stations = Math.max(8, Math.ceil(chord / 0.5))
  for (let i = 0; i < stations; i++) {
    const t = i / stations
    const pt = { x: fromPt.x + t * (toPt.x - fromPt.x), y: fromPt.y + t * (toPt.y - fromPt.y) }
    if (!pointInPolygon(pt, outerPoly)) return false
    if (islands.some(island => pointInPolygon(pt, island))) return false
  }
  return true
}

// ── Cleared-region accumulator (material-safety: stay-down only over cleared stock) ──
//
// pathIsSafe validates a stay-down link only against the OUTER boundary + islands —
// it has no notion of which stock is already CUT. In a pocket whose offset rings
// SPLIT into separate lobes at a waist/neck (a non-convex boundary that pinches the
// region in two), the link connecting a finished lobe to the next can feed straight
// across the still-UNCLEARED waist at full depth — a gouge/crash on a real machine.
//
// This mirrors the proven adaptive-clearing rule (adaptiveClearing2d/.../processFeature.ts
// :779-785): a kept-down connection may cut at depth ONLY if its swept corridor lies
// inside already-cleared stock; otherwise it plows uncut roughing material and must
// retract. AC builds the corridor as a half-radius capsule and tests
// area(difference(corridor, cleared)) > eps. We reproduce the SAME idea without the
// async clipper2 wasm (buildPocketToolpath is synchronous and uses the pure-JS
// geometry helpers): the cleared region is the union of TOOL SWEEPS, where each cut
// tool-centre path P sweeps the exact Minkowski band { p : dist(p, P) <= toolRadius }.
// dist-to-polyline is exact — no offset self-intersection artefacts, no wasm — and
// naturally yields the annulus of a large ring (its centre is > toolRadius from the
// ring) while overlapping consecutive rings fill the interior in. A point is cleared
// iff it lies within toolRadius of ANY accumulated cut path.

/** True when every segment of a closed centerline lies in the union of the
 * valid outer tool-center loops. Segment/boundary intersections split each
 * segment into intervals, so a narrow excursion outside a concave envelope
 * cannot hide between fixed sampling stations. */
function inclusiveSegmentIntersectionT(a: Pt2, b: Pt2, c: Pt2, d: Pt2): number | null {
  const abX = b.x - a.x, abY = b.y - a.y
  const cdX = d.x - c.x, cdY = d.y - c.y
  const denominator = abX * cdY - abY * cdX
  if (Math.abs(denominator) < 1e-12) return null
  const t = ((c.x - a.x) * cdY - (c.y - a.y) * cdX) / denominator
  const u = ((c.x - a.x) * abY - (c.y - a.y) * abX) / denominator
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null
  return Math.max(0, Math.min(1, t))
}

function segmentBoundarySplitTs(a: Pt2, b: Pt2, boundaries: Pt2[][]): number[] {
  const splitTs = [0, 1]
  for (const boundary of boundaries) {
    for (let edge = 0; edge < boundary.length; edge++) {
      const hitT = inclusiveSegmentIntersectionT(
        a, b, boundary[edge], boundary[(edge + 1) % boundary.length],
      )
      if (hitT !== null) splitTs.push(hitT)
    }
  }
  splitTs.sort((left, right) => left - right)
  return splitTs
}

function closedPathFitsOuterEnvelope(path: Pt2[], outerEnvelope: Pt2[][]): boolean {
  if (path.length < 2 || outerEnvelope.length === 0) return false
  const tolerance = 1e-7
  const pointFits = (point: Pt2): boolean =>
    outerEnvelope.some(loop => distToPolyBoundary(point, loop) <= tolerance)

  for (let i = 0; i < path.length; i++) {
    const a = path[i]
    const b = path[(i + 1) % path.length]
    if (!pointFits(a) || !pointFits(b)) return false

    const splitTs = segmentBoundarySplitTs(a, b, outerEnvelope)
    for (let split = 1; split < splitTs.length; split++) {
      if (splitTs[split] - splitTs[split - 1] <= 1e-10) continue
      const t = (splitTs[split - 1] + splitTs[split]) / 2
      const midpoint = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
      if (!pointFits(midpoint)) return false
    }
  }
  return true
}

function closedPathIsStrictlyInside(path: Pt2[], outer: Pt2[]): boolean {
  if (!closedPathFitsOuterEnvelope(path, [outer])) return false
  const tolerance = 1e-7
  if (path.some(point => distToPolyBoundary(point, outer) >= -tolerance)) return false

  // Reject crossings and tangencies explicitly. Endpoints can all be inside a
  // concave polygon while the connecting segment leaves through a notch.
  for (let i = 0; i < path.length; i++) {
    const a = path[i]
    const b = path[(i + 1) % path.length]
    for (let edge = 0; edge < outer.length; edge++) {
      if (inclusiveSegmentIntersectionT(a, b, outer[edge], outer[(edge + 1) % outer.length]) !== null)
        return false
    }
  }
  return true
}

function assignIslandsToOuterBounds(
  outerBounds: LoopData[], islands: LoopData[],
): Map<LoopData, LoopData[]> {
  const assignments = new Map<LoopData, LoopData[]>(
    outerBounds.map(bound => [bound, [] as LoopData[]]),
  )

  for (const island of islands) {
    const islandPath = ensureCCW(island.points as Pt2[]) as Pt2[]
    const containing = outerBounds.filter(bound =>
      closedPathIsStrictlyInside(islandPath, ensureCCW(bound.points as Pt2[]) as Pt2[]))
    if (containing.length === 0) {
      throw new Error(
        `Pocket: selected island ${operatorLoopRef(island, 'loop')} is not fully contained inside any selected ` +
        'outer pocket boundary. It crosses, touches, or lies outside the boundary. Refusing to ' +
        'silently omit or partially machine the island.'
      )
    }
    if (containing.length > 1) {
      throw new Error(
        `Pocket: selected island ${operatorLoopRef(island, 'loop')} is fully contained by multiple selected ` +
        'outer pocket boundaries, so its ownership is ambiguous. Select one outer boundary.'
      )
    }
    assignments.get(containing[0])!.push(island)
  }
  return assignments
}

/** True when a closed centerline remains outside every other island keep-out. */
function closedPathStaysOutsideKeepOuts(path: Pt2[], keepOuts: Pt2[][]): boolean {
  if (path.length < 2) return false
  if (keepOuts.length === 0) return true
  const tolerance = 1e-7
  const pointFits = (point: Pt2): boolean =>
    keepOuts.every(keepOut => distToPolyBoundary(point, keepOut) >= -tolerance)

  for (let i = 0; i < path.length; i++) {
    const a = path[i]
    const b = path[(i + 1) % path.length]
    if (!pointFits(a) || !pointFits(b)) return false
    const splitTs = segmentBoundarySplitTs(a, b, keepOuts)
    for (let split = 1; split < splitTs.length; split++) {
      if (splitTs[split] - splitTs[split - 1] <= 1e-10) continue
      const t = (splitTs[split - 1] + splitTs[split]) / 2
      const midpoint = { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) }
      if (!pointFits(midpoint)) return false
    }
  }
  return true
}

function assertIslandContoursFit(
  groups: IslandContourGroup[], roughOuterEnvelope: Pt2[][],
  finishOuterEnvelope: Pt2[][], requireFinish: boolean,
): void {
  for (const group of groups) {
    if (group.roughPaths.length === 0) {
      throw new Error(
        'Pocket: failed to construct a tool-radius-expanded island keep-out. Refusing to emit ' +
        'an unprotected island toolpath.'
      )
    }
    for (const path of group.roughPaths) {
      if (!closedPathFitsOuterEnvelope(path, roughOuterEnvelope)) {
        throw new Error(
          'Pocket: island clearance is too narrow for the selected tool and radial stock to leave. ' +
          'The complete island roughing contour does not fit inside the outer tool-center envelope. ' +
          'Use a smaller tool, reduce stock to leave, or change the geometry. Refusing to emit a ' +
          'wall-overcutting toolpath.'
        )
      }
    }
    if (!requireFinish) continue
    if (group.finishPaths.length === 0) {
      throw new Error(
        'Pocket: failed to construct the requested island finish contour. Refusing to silently ' +
        'omit the island wall finish.'
      )
    }
    for (const path of group.finishPaths) {
      if (!closedPathFitsOuterEnvelope(path, finishOuterEnvelope)) {
        throw new Error(
          'Pocket: island clearance is too narrow for the selected tool. The complete island ' +
          'finish contour does not fit inside the outer tool-center envelope. Use a smaller tool ' +
          'or change the geometry. Refusing to emit a wall-overcutting toolpath.'
        )
      }
    }
  }

  for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
    const group = groups[groupIndex]
    const otherRoughKeepOuts = groups.flatMap((other, index) =>
      index === groupIndex ? [] : other.roughPaths)
    for (const path of group.roughPaths) {
      if (!closedPathStaysOutsideKeepOuts(path, otherRoughKeepOuts)) {
        throw new Error(
          'Pocket: clearance between islands is too narrow for the selected tool and radial ' +
          'stock to leave. Complete island contours would overlap. Use a smaller tool, reduce ' +
          'stock to leave, or change the geometry. Refusing to emit an incomplete island toolpath.'
        )
      }
    }
  }
}

interface ClearedRegion {
  /** Fold a cut tool-centre path (a cut ring, closed=true) into the cleared union. */
  addCutPath(pts: Pt2[], closed: boolean): void
  /** True iff the stay-down link fromPt->toPt lies wholly inside cleared stock.
   *  Interior stations only: the endpoints sit on the cut frontier (AC exempts them
   *  via the half-radius corridor), so sampling them would false-positive at edges. */
  linkStaysInCleared(fromPt: Pt2, toPt: Pt2): boolean
  isEmpty(): boolean
}

/** Min distance from pt to a polyline (closed → also the wrap segment). Exact
 *  point-to-segment, so { p : dist <= r } is the true tool sweep of the path. */
function distPointToPath(pt: Pt2, pts: Pt2[], closed: boolean): number {
  const n = pts.length
  if (n === 0) return Infinity
  if (n === 1) return Math.hypot(pt.x - pts[0].x, pt.y - pts[0].y)
  let best = Infinity
  const segs = closed ? n : n - 1
  for (let i = 0; i < segs; i++) {
    const a = pts[i], b = pts[(i + 1) % n]
    const dx = b.x - a.x, dy = b.y - a.y
    const lenSq = dx * dx + dy * dy
    let t = lenSq < 1e-12 ? 0 : ((pt.x - a.x) * dx + (pt.y - a.y) * dy) / lenSq
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const ex = a.x + t * dx - pt.x, ey = a.y + t * dy - pt.y
    const d = Math.hypot(ex, ey)
    if (d < best) best = d
  }
  return best
}

function makeClearedRegion(toolRadius: number): ClearedRegion {
  const paths: { pts: Pt2[]; closed: boolean }[] = []
  const r = toolRadius + 1e-6   // tolerance so a point exactly on the band edge counts cleared
  const contains = (pt: Pt2): boolean => {
    for (const p of paths) if (distPointToPath(pt, p.pts, p.closed) <= r) return true
    return false
  }
  return {
    // A single point represents the cutter footprint at a proven at-depth entry
    // endpoint. It is a disk in the distance-to-path model, not an empty path.
    addCutPath(pts, closed) { if (pts.length >= 1) paths.push({ pts, closed }) },
    isEmpty() { return paths.length === 0 },
    linkStaysInCleared(fromPt, toPt) {
      if (paths.length === 0) return false
      const chord = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y)
      if (chord < 1e-9) return true
      // Interior stations spaced <= toolRadius/2 so a waist gap wider than the tool
      // cannot be straddled between two samples (mirrors AC's half-radius corridor).
      const n = Math.max(4, Math.ceil(chord / (toolRadius * 0.5)))
      for (let i = 1; i < n; i++) {
        const t = i / n
        const p = { x: fromPt.x + t * (toPt.x - fromPt.x), y: fromPt.y + t * (toPt.y - fromPt.y) }
        if (!contains(p)) return false
      }
      return true
    },
  }
}

// ── Quintic Bézier stepover blend (G2 at both ends) ──────────────────────────
// Blends from fromPt (departing along exitTangent) to toPt (arriving along
// entryTangent). Uses a degree-5 Bézier with the G2 (zero-curvature) endpoint
// conditions, which means curvature eases from zero rather than jumping in
// abruptly — the most gradual possible tool-loading transition.
//
// G2 construction for a quintic with control points P0…P5:
//   B''(0) = 0  →  P2 = 2·P1 − P0  (P2 collinear with P0 and P1)
//   B''(1) = 0  →  P3 = 2·P4 − P5  (P3 collinear with P4 and P5)
// So we choose P1 = P0 + α·T0, P4 = P5 − α·T1, then derive P2 and P3.
//
// α is capped at chord/5 to prevent the mid-control points from overlapping
// when the tangents are nearly parallel (the worst case geometrically).

function emitBezierLeadin(
  moves: ToolpathMove[], fromPt: Pt2, toPt: Pt2,
  exitTangent: Pt2, entryTangent: Pt2,
  depth: number, feedRate: number,
  islands: Pt2[][],
): boolean {
  const chord = Math.hypot(toPt.x - fromPt.x, toPt.y - fromPt.y)
  if (chord < 0.01) return true

  // Antiparallel tangents → quintic would self-cross — fall back to direct feed.
  const dot = exitTangent.x * entryTangent.x + exitTangent.y * entryTangent.y
  if (dot < -0.5) return false

  // α = chord/5 keeps P2 and P3 from overlapping for the near-parallel case.
  const alpha = chord / 5
  const p0 = fromPt
  const p1 = { x: fromPt.x +     alpha * exitTangent.x, y: fromPt.y +     alpha * exitTangent.y }
  const p2 = { x: fromPt.x + 2 * alpha * exitTangent.x, y: fromPt.y + 2 * alpha * exitTangent.y }
  const p5 = toPt
  const p4 = { x: toPt.x   -     alpha * entryTangent.x, y: toPt.y   -     alpha * entryTangent.y }
  const p3 = { x: toPt.x   - 2 * alpha * entryTangent.x, y: toPt.y   - 2 * alpha * entryTangent.y }

  // Sample the full curve FIRST and validate every emitted sample against the
  // island keep-outs — the Bezier bows away from the straight chord, so a
  // chord-only check (the caller's pathIsSafe) does not cover it. On violation
  // emit nothing and return false; the caller falls back to its already
  // chord-validated straight feed.
  const nSteps = Math.max(6, Math.ceil(chord / 0.5))
  const pts: Pt2[] = []
  for (let i = 1; i <= nSteps; i++) {
    const t = i / nSteps, u = 1 - t
    // Quintic Bézier: B(t) = Σ C(5,k) · u^(5-k) · t^k · Pk
    const b0 =    u*u*u*u*u
    const b1 =  5*u*u*u*u*t
    const b2 = 10*u*u*u*t*t
    const b3 = 10*u*u*t*t*t
    const b4 =  5*u*t*t*t*t
    const b5 =    t*t*t*t*t
    const pt = {
      x: b0*p0.x + b1*p1.x + b2*p2.x + b3*p3.x + b4*p4.x + b5*p5.x,
      y: b0*p0.y + b1*p1.y + b2*p2.y + b3*p3.y + b4*p4.y + b5*p5.y,
    }
    if (findContainingLoop(pt, islands) >= 0) return false
    pts.push(pt)
  }
  for (const pt of pts)
    feedTo(moves, pt, depth, feedRate, 'stepover')
  return true
}

// ── Step over to the next ring ────────────────────────────────────────────────
// Arc mode uses a "lane-change" strategy: instead of landing at the geometrically
// nearest point (a short perpendicular hop), we advance the entry point along the
// ring by ≈ 2× the radial gap.  The quintic Bézier then spans a longer diagonal,
// producing the elongated S-curve that eases in and out of the cut gradually.
//
// Because cutRingFull always cuts a full revolution from startT, starting at the
// advanced point still covers the entire ring — the "skipped" section near baseT
// is cut at the end of the revolution just before the ring closes.

function stepToRing(
  moves: ToolpathMove[], fromPt: Pt2, curve: ArcCurve,
  outerPoly: Pt2[], islands: Pt2[][],
  depth: number, retractZ: number, feedRate: number, plungeRate: number,
  exitTangent?: Pt2, stepoverLeadIn: 'none' | 'arc' = 'none',
  cleared?: ClearedRegion | null,
): { startT: number; startPt: Pt2 } | null {
  const baseT  = nearestT(fromPt, curve)
  const basePt = sampleAt(curve, baseT)

  // Arc mode: advance the entry point along the ring to create an elongated
  // lane-change transition instead of a short perpendicular hop.
  let startT = baseT, startPt = basePt
  if (stepoverLeadIn === 'arc' && exitTangent && curve.total > 1e-6) {
    const radialGap = Math.hypot(basePt.x - fromPt.x, basePt.y - fromPt.y)
    // Look ahead ≈ 2× the stepover distance along the ring arc.
    // Cap at 20% of ring perimeter so we don't overshoot on small rings.
    const lookAheadFrac = Math.min((2 * radialGap) / curve.total, 0.20)
    const advT  = (baseT + lookAheadFrac) % 1
    const advPt = sampleAt(curve, advT)
    // Only use the advanced point if the straight-line path to it is safe.
    if (pathIsSafe(fromPt, advPt, outerPoly, islands)) {
      startT = advT; startPt = advPt
    }
  }

  // Island keep-out guard: rings are offsets of the outer boundary only — they
  // do not subtract islands, so the nearest/advanced sample can sit inside an
  // island keep-out. Landing there gouges the island whether we arrive by feed
  // OR by the retract+plunge fallback below. Advance along the ring in the cut
  // direction to the nearest island-clear sample before emitting any move.
  if (islands.length > 0 && curve.total > 1e-6 &&
      findContainingLoop(startPt, islands) >= 0) {
    const nScan = Math.max(32, Math.ceil(curve.total / 0.25))
    let found = false
    for (let i = 1; i <= nScan; i++) {
      const t  = (startT + i / nScan) % 1
      const pt = sampleAt(curve, t)
      if (findContainingLoop(pt, islands) < 0) { startT = t; startPt = pt; found = true; break }
    }
    // Ring entirely inside a keep-out (e.g. innermost rings of an annular
    // pocket sitting on the island): nothing on it is cuttable — skip it.
    if (!found) return null
  }

  const dx = startPt.x - fromPt.x, dy = startPt.y - fromPt.y
  if (dx * dx + dy * dy < 0.001) return { startT, startPt }

  // Retract when the boundary/island check fails OR (material safety) the stay-down
  // travel would plow uncut stock — its swept corridor leaves the already-cleared
  // region (e.g. a link across an uncleared waist between two lobes). Same retract
  // branch in both cases. The caller seeds the accumulator with only the actual
  // at-depth entry footprint, so even the first approach must be proven clear.
  const plowsUncut = !!cleared && !cleared.linkStaysInCleared(fromPt, startPt)
  if (plowsUncut || !pathIsSafe(fromPt, startPt, outerPoly, islands)) {
    retractLinkPlunge(moves, fromPt, startPt, retractZ, depth, plungeRate)
    return { startT, startPt }
  }

  if (stepoverLeadIn === 'arc' && exitTangent) {
    const entryTangent = tangentAt(curve, startT)
    const ok = emitBezierLeadin(moves, fromPt, startPt, exitTangent, entryTangent, depth, feedRate, islands)
    if (!ok) feedTo(moves, startPt, depth, feedRate, 'stepover')
  } else {
    feedTo(moves, startPt, depth, feedRate, 'stepover')
  }

  return { startT, startPt }
}

// ── Cut all generations at a single depth ─────────────────────────────────────
// cutGens: ordered list of generations to cut (may be reversed for inside-out).
// Returns final XY position.

// Cut each complete rough island centerline once per depth. The concentric rings
// are generated from the outer boundary only; their local island bridges avoid a
// gouge but do not guarantee 360-degree wall coverage. A dedicated contour closes
// those equatorial cusps. Internal walls use the opposite winding from outer walls
// for the same climb/conventional selection.
function cutRoughIslandContours(
  moves: ToolpathMove[], islands: Pt2[][],
  outerPoly: Pt2[], outerRings: Pt2[][],
  depth: number, fromPt: Pt2,
  feedRate: number, plungeRate: number, retractZ: number,
  sampleStep: number, useClimb: boolean,
  cleared: ClearedRegion,
): { lastPt: Pt2; exitTangent?: Pt2 } {
  let lastPt = fromPt
  let exitTangent: Pt2 | undefined

  for (let islandIndex = 0; islandIndex < islands.length; islandIndex++) {
    const ccw = ensureCCW([...islands[islandIndex]]) as Pt2[]
    const ring = useClimb ? ([...ccw].reverse() as Pt2[]) : ccw
    const curve = buildArcCurve(ring)
    if (curve.total < 1e-6) continue
    assertPocketMoveCapacity(moves, 1, 'cutting an island cleanup contour')

    const startT = nearestT(lastPt, curve)
    const startPt = sampleAt(curve, startT)
    const chordSq = (startPt.x - lastPt.x) ** 2 + (startPt.y - lastPt.y) ** 2
    if (chordSq >= 0.001) {
      const plowsUncut = !cleared.linkStaysInCleared(lastPt, startPt)
      if (plowsUncut || !boundaryApproachIsSafe(lastPt, startPt, outerPoly, islands)) {
        retractLinkPlunge(moves, lastPt, startPt, retractZ, depth, plungeRate)
      } else {
        feedTo(moves, startPt, depth, feedRate, 'stepover')
      }
    }

    // The active island is the boundary being cut, not an obstruction. Other
    // islands remain keep-outs throughout the contour.
    const otherIslands = islands.filter((_, index) => index !== islandIndex)
    const cut = cutRingFull(
      moves, ring, startT, otherIslands, outerRings,
      depth, retractZ, feedRate, plungeRate, sampleStep, useClimb,
    )
    lastPt = cut.lastPt
    exitTangent = cut.exitTangent
    cleared.addCutPath(ring, true)
    assertPocketMoveCapacity(moves, 0, 'cutting an island cleanup contour')
  }

  return { lastPt, exitTangent }
}

function cutAllGenerations(
  moves: ToolpathMove[], cutGens: Pt2[][][],
  islands: Pt2[][], outerPoly: Pt2[], outerRings: Pt2[][],
  depth: number, entryPt: Pt2,
  feedRate: number, plungeRate: number, retractZ: number,
  sampleStep: number, useClimb: boolean,
  overlapMm: number, stepoverLeadIn: 'none' | 'arc',
  cleanupCentroid: Pt2 | null,
  cleared: ClearedRegion,
  firstRingPlan?: FirstRingPlan,
  firstRingAlreadyCut = false,
  initialExitTangent?: Pt2,
): Pt2 {
  let lastPt = entryPt
  let lastExitTangent: Pt2 | undefined = initialExitTangent
  // Cleared stock is seeded only from the proven at-depth entry footprint, so the
  // first ring approach is held to the same material-safety gate as every later link.

  for (let generationIndex = 0; generationIndex < cutGens.length; generationIndex++) {
    const genLoops = cutGens[generationIndex]
    assertPocketMoveCapacity(moves, 0, 'scheduling pocket rings')

    // Orient each loop, then sort by nearest to lastPt. For outside-in, the
    // explicit entry plan owns the first slot so entry and scheduling cannot
    // independently select different loops in a split outer generation.
    const directedLoops = genLoops.map(source => {
      const ring = generationIndex === 0 && source === firstRingPlan?.sourceRing
        ? firstRingPlan.directedRing
        : orientRoughRing(source, useClimb)
      return { source, ring }
    })
    directedLoops.sort((a, b) => {
      if (generationIndex === 0 && firstRingPlan) {
        if (a.source === firstRingPlan.sourceRing) return -1
        if (b.source === firstRingPlan.sourceRing) return 1
      }
      return minSqDistToLoop(lastPt, a.ring) - minSqDistToLoop(lastPt, b.ring)
    })

    for (const { source, ring } of directedLoops) {
      if (generationIndex === 0 && firstRingAlreadyCut &&
          source === firstRingPlan?.sourceRing) continue
      const curve = buildArcCurve(ring)
      if (curve.total < 1e-6) continue
      assertPocketMoveCapacity(moves, 1, 'cutting a scheduled pocket ring')

      const isPlannedFirstRing = generationIndex === 0 &&
        source === firstRingPlan?.sourceRing
      const atPlannedStart = isPlannedFirstRing &&
        Math.hypot(lastPt.x - firstRingPlan.startPt.x, lastPt.y - firstRingPlan.startPt.y) < 1e-6
      const stepped = atPlannedStart
        ? { startT: firstRingPlan.startT, startPt: firstRingPlan.startPt }
        : stepToRing(
            moves, lastPt, curve, outerPoly, islands, depth, retractZ, feedRate, plungeRate,
            lastExitTangent, stepoverLeadIn, cleared)
      if (!stepped) continue   // ring entirely inside an island keep-out — nothing cuttable
      const { startT, startPt } = stepped
      lastPt = startPt

      const { lastPt: newLastPt, exitTangent } = cutRingFull(
        moves, ring, startT, islands, outerRings,
        depth, retractZ, feedRate, plungeRate, sampleStep, useClimb, overlapMm)
      lastPt = newLastPt
      lastExitTangent = exitTangent
      // Fold this ring's tool sweep into the cleared region so the NEXT link (the
      // next ring or lobe) is validated against what the machine has now removed.
      cleared.addCutPath(ring, true)
      assertPocketMoveCapacity(moves, 0, 'cutting a scheduled pocket ring')
    }
  }

  const islandCleanup = cutRoughIslandContours(
    moves, islands, outerPoly, outerRings,
    depth, lastPt, feedRate, plungeRate, retractZ,
    sampleStep, useClimb, cleared,
  )
  lastPt = islandCleanup.lastPt
  lastExitTangent = islandCleanup.exitTangent ?? lastExitTangent
  assertPocketMoveCapacity(moves, 0, 'finishing island cleanup contours')

  // Centre cleanup: after the last ring the enclosed centre area is still uncut
  // because the tool only swept toolRadius inward from the ring perimeter.
  // For non-circular pockets the last ring's interior can be larger than the tool
  // can reach from the perimeter alone. A single feed to the centroid of the last
  // cleanup ring guarantees the centre material is removed.
  if (cleanupCentroid) {
    // Same material-safety gate as ring links: the feed to the centre may stay down
    // only if it rides over cleared stock; else retract+rapid+plunge.
    const plowsCleanup = !cleared.isEmpty() && !cleared.linkStaysInCleared(lastPt, cleanupCentroid)
    const canStayDown = !plowsCleanup && pathIsSafe(lastPt, cleanupCentroid, outerPoly, islands)
    assertPocketMoveCapacity(
      moves, canStayDown ? 1 : 3,
      'cleaning the pocket center',
    )
    if (canStayDown) {
      feedTo(moves, cleanupCentroid, depth, feedRate, 'cut')
    } else {
      retractLinkPlunge(moves, lastPt, cleanupCentroid, retractZ, depth, plungeRate)
    }
    lastPt = cleanupCentroid
  }

  return lastPt
}

// ── Finish-contour pass ────────────────────────────────────────────────────────
// Uses the same cutRingFull island-avoidance logic as roughing passes.
// The valid area for bridge points is the finish ring itself — bridges must not
// exit it to avoid violating the outer pocket boundary or cutting into islands.

function emitFinishContour(
  moves: ToolpathMove[], finishPath: Pt2[] | null, fallbackRing: Pt2[],
  depth: number, retractZ: number, feedRate: number, plungeRate: number,
  useClimb: boolean, outerPoly: Pt2[], islands: Pt2[][],
  finishPasses: number, springPasses: number,
  stayDown: boolean, stayDownLift: number,
  cleared: ClearedRegion,
): void {
  const path    = finishPath ?? fallbackRing
  const dirPath = useClimb ? [...path] : [...path].reverse()
  const curve   = buildArcCurve(dirPath)
  if (curve.total < 1e-6) return

  // Bridge validation: the tool centre must stay within the finish ring itself.
  const outerRings: Pt2[][] = [path]

  const lastM   = moves[moves.length - 1]
  const lastPt: Pt2 = { x: lastM?.x ?? dirPath[0].x, y: lastM?.y ?? dirPath[0].y }
  const startT  = nearestT(lastPt, curve)
  const startPt = sampleAt(curve, startT)

  if (stayDown && stayDownLift > 0) {
    // Stay-down: lift slightly above current depth, feed to the finish path start,
    // then ramp back down along the path as a lead-in into the wall material.
    // This avoids retracting to clearance height and saves machining time.
    const liftZ      = depth + stayDownLift
    const leadInDist = Math.max(4, stayDownLift * 8)  // ramp distance proportional to lift
    const steps      = 6                               // interpolation points for smooth ramp
    const leadInDT   = Math.min(leadInDist / curve.total, 0.4)  // cap at 40% of loop

    // Lift at current position then feed to finish path start at lifted height.
    feedTo(moves, lastPt, liftZ, feedRate, 'cut')
    feedTo(moves, startPt, liftZ, feedRate, 'cut')

    // Ramp down along the path from liftZ to depth — this is the lead-in into the wall.
    const leadInLen = leadInDT * curve.total
    rampDescent(moves, (_length, visit) => {
      for (let i = 1; i <= steps; i++) {
        visit(sampleAt(curve, (startT + leadInDT * i / steps) % 1), leadInLen * i / steps)
      }
    }, liftZ, depth, leadInLen, plungeRate)

    // Finish the loop from the end of the ramp onward (at full depth).
    const afterRampT = (startT + leadInDT) % 1
    const totalPasses = Math.max(1, finishPasses) + Math.max(0, springPasses)
    for (let p = 0; p < totalPasses; p++) {
      cutRingFull(
        moves, dirPath, afterRampT, islands, outerRings,
        depth, retractZ, feedRate, plungeRate, 0.5, useClimb)
    }
  } else {
    // Normal approach: retract if path crosses an obstruction OR (material safety)
    // the travel to the finish-pass start would plow uncut stock; otherwise feed.
    const plowsFinish = !cleared.isEmpty() && !cleared.linkStaysInCleared(lastPt, startPt)
    if (plowsFinish || !pathIsSafe(lastPt, startPt, outerPoly, islands)) {
      retractLinkPlunge(moves, lastPt, startPt, retractZ, depth, plungeRate)
    } else {
      feedTo(moves, startPt, depth, feedRate, 'stepover')
    }

    const totalPasses = Math.max(1, finishPasses) + Math.max(0, springPasses)
    for (let p = 0; p < totalPasses; p++) {
      cutRingFull(
        moves, dirPath, startT, islands, outerRings,
        depth, retractZ, feedRate, plungeRate, 0.5, useClimb)
    }
  }
}

// ── Context ────────────────────────────────────────────────────────────────────

/**
 * Finish internal island walls at the exact tool-radius offset. Internal walls
 * require the opposite winding from the outer wall: climb is clockwise and
 * conventional is counter-clockwise. The active rough keep-out is intentionally
 * removed while its stock allowance is cut; every other island remains protected.
 */
function emitIslandFinishContours(
  moves: ToolpathMove[], groups: IslandContourGroup[], roughIslands: Pt2[][],
  outerRings: Pt2[][],
  depth: number, retractZ: number, feedRate: number, plungeRate: number,
  useClimb: boolean, outerPoly: Pt2[],
  finishPasses: number, springPasses: number,
  cleared: ClearedRegion,
): void {
  for (const group of groups) for (const finishPath of group.finishPaths) {
    const ccw = ensureCCW([...finishPath]) as Pt2[]
    const dirPath = useClimb ? ([...ccw].reverse() as Pt2[]) : ccw
    const curve = buildArcCurve(dirPath)
    if (curve.total < 1e-6) continue

    // Keep the source-island association created during offset generation. A
    // concave island's polygon centroid can lie outside it, so geometry-based
    // rematching here would occasionally retain the active rough keep-out and
    // swallow the intended finish contour.
    const activePaths = new Set(group.roughPaths)
    const otherIslands = roughIslands.filter(island => !activePaths.has(island))

    const lastMove = moves[moves.length - 1]
    const lastPt: Pt2 = {
      x: lastMove?.x ?? dirPath[0].x,
      y: lastMove?.y ?? dirPath[0].y,
    }
    const startT = nearestT(lastPt, curve)
    const startPt = sampleAt(curve, startT)
    const chordSq = (startPt.x - lastPt.x) ** 2 + (startPt.y - lastPt.y) ** 2
    if (chordSq >= 0.001) {
      const plowsUncut = !cleared.linkStaysInCleared(lastPt, startPt)
      const approachKeepOuts = [finishPath, ...otherIslands]
      if (plowsUncut || !boundaryApproachIsSafe(lastPt, startPt, outerPoly, approachKeepOuts)) {
        retractLinkPlunge(moves, lastPt, startPt, retractZ, depth, plungeRate)
      } else {
        feedTo(moves, startPt, depth, feedRate, 'stepover')
      }
    }

    const totalPasses = Math.max(1, finishPasses) + Math.max(0, springPasses)
    for (let pass = 0; pass < totalPasses; pass++) {
      cutRingFull(
        moves, dirPath, startT, otherIslands, outerRings,
        depth, retractZ, feedRate, plungeRate, 0.5, useClimb,
      )
    }
    cleared.addCutPath(dirPath, true)
  }
}

interface Ctx {
  feedRate: number; plungeRate: number; rampRate: number
  tanAngle: number; rampAngle: number
  useClimb: boolean; insideOut: boolean
  clearanceZ: number; retractZ: number; topZ: number; sampleStep: number
  entryType: string
  overlapMm: number; stepoverLeadIn: 'none' | 'arc'
  toolRadius: number   // for the cleared-region swept-band radius (material-safety links)
  /** WO-1972: mm above the material still standing where a helix begins. */
  entryClearance: number
  /** Material the earlier operations of the setup left (world frame), if sent. */
  remaining?: StockState
  /** The stock block as loaded (world frame), if sent. */
  stockBlock?: ToolpathStockBlock
  /** Lowest Z this operation's earlier depth bands already cut down to; undefined
   *  for the first band, where nothing of this operation has cut yet. */
  entryCeilingZ?: number
}

// -- WO-1972: helix start height and the stay-down link between levels --------
//
// Operator ruling 2026-09-25, on a three-level inside-out pocket that helixed from retract
// at every level: "It should plunge to just before engagement with stock
// remaining, then helix prior to entry... rest stock aware. Not stock top... but
// stock remaining." A helix begins entryClearance above the highest material
// still standing under its footprint, and between levels the tool stays down.

/**
 * Where a helix at `ctr` descending to `depth` begins. The material under it is
 * the highest the remaining stock holds over the helix's swept square, padded by
 * one dexel cell (highestMaterialOver reads too high, never too low); with no
 * remaining stock, the block as loaded; with neither, Top. `ceilingZ` is what
 * this operation already cut there (the level above, or the band above) - the
 * material is never above it. The start is never below the level being cut.
 */
function helixStartZ(
  ctx: Ctx, ctr: Pt2, helixR: number, ceilingZ: number | undefined, depth: number,
): number {
  // WO-3083: the one entry rule every operation shares (moves/index.ts).
  return entryStartZ({ ...(ctx.remaining ? { remaining: ctx.remaining } : {}),
    ...(ctx.stockBlock ? { stockBlock: ctx.stockBlock } : {}), topZ: ctx.topZ },
  ctr, helixR + ctx.toolRadius, depth, { ceilingZ, clearance: ctx.entryClearance })
}

/**
 * The link from where the level above ended (`from`, on that level's floor) to
 * the next helix start, kept down. The lift is straight up, clear of the floor;
 * the traverse runs at that height and is proven the way every pocket link is:
 * the tool centre stays inside the outermost ring envelope and outside every
 * island keep-out (so the cutter reaches neither wall nor island stock), over
 * the sweep that level cleared. Where the helix starts lower still (an earlier
 * operation emptied its footprint deeper), the drop to it is made over the
 * helix footprint alone. Emits nothing and returns false when unproven.
 */
function linkDownToHelix(
  moves: ToolpathMove[], from: ToolpathMove, levelZ: number,
  helixStart: Pt2, startZ: number, entryClearance: number, toolRadius: number,
  outerRings: Pt2[][], islands: Pt2[][], cleared: ClearedRegion,
): boolean {
  if (Math.abs(from.z - levelZ) > 1e-6) return false
  if (!cleared.linkStaysInCleared(from, helixStart)) return false
  const chord = Math.hypot(helixStart.x - from.x, helixStart.y - from.y)
  // The traverse is a rapid, so the cutter's flanks must ride over cleared
  // floor too, not only its centre: check the two lines just inside its sides.
  if (chord > 1e-9) {
    const side = 0.95 * toolRadius / chord
    const nx = -(helixStart.y - from.y) * side, ny = (helixStart.x - from.x) * side
    for (const s of [1, -1]) {
      const a = { x: from.x + s * nx, y: from.y + s * ny }
      const b = { x: helixStart.x + s * nx, y: helixStart.y + s * ny }
      if (!cleared.linkStaysInCleared(a, b)) return false
    }
  }
  const stations = Math.max(8, Math.ceil(chord / 0.5))
  for (let i = 1; i < stations; i++) {
    const t = i / stations
    const pt = { x: from.x + t * (helixStart.x - from.x), y: from.y + t * (helixStart.y - from.y) }
    if (!outerRings.some(ring => pointInPolygon(pt, ring))) return false
    if (islands.some(island => pointInPolygon(pt, island))) return false
  }
  const linkZ = Math.max(startZ, levelZ + entryClearance)
  // WO-2835 (architect ruling 2026-10-20): a link becomes a sideways rapid only where its
  // clearance is certified. Nothing here certifies a rise that moves sideways off the floor
  // through the corner the cut just made, so the lift stays straight up, inside the tool's
  // own cut, and the floor-hop setting does not blend it.
  rapidTo(moves, from, linkZ)
  // performEntry makes the last move to the helix start at startZ.
  if (linkZ > startZ + 1e-9) rapidTo(moves, helixStart, linkZ)
  return true
}

// Returns the centroid of the innermost generation for outside-in fill, to be fed
// to after all rings are cut. Returns null for inside-out fill (centre is first,
// not last) or when the centroid falls outside the pocket or inside an island.
function computeCleanupCentroid(
  generations: Pt2[][][], insideOut: boolean,
  outerPts: Pt2[], islands: Pt2[][],
): Pt2 | null {
  if (insideOut || generations.length === 0) return null
  const lastGen  = generations[generations.length - 1]
  const lastLoop = largestLoop(lastGen)
  const ctr      = centroid(lastLoop)
  if (!pointInPolygon(ctr, outerPts)) return null
  if (islands.some(isl => pointInPolygon(ctr, isl))) return null
  return ctr
}

// ── Machine one region — all depths (by_region order strategy) ─────────────────

function machineRegion(
  moves: ToolpathMove[],
  outerPts: Pt2[], generations: Pt2[][][],
  finishPath: Pt2[] | null, islands: Pt2[][], finishIslandGroups: IslandContourGroup[],
  entryCtr: Pt2, safeHelixR: number,
  allDepths: number[], params: PocketParams,
  passes: { finishPasses?: number; springPasses?: number },
  ctx: Ctx,
  /** WO-2296: the rings as cut (corners rounded); the geometry rings otherwise. */
  ringPaths: Pt2[][][] = generations,
): void {
  const { feedRate, plungeRate, rampRate, tanAngle, rampAngle,
          useClimb, insideOut, clearanceZ, retractZ, topZ, sampleStep, entryType,
          overlapMm, stepoverLeadIn } = ctx

  const cutGens   = insideOut ? [...ringPaths].reverse() : ringPaths
  // outerRings = the outermost generation in geometry order (always generations[0]).
  // These define the maximum tool-centre extent during both cuts and island bridges.
  const outerRings = generations[0]

  // Centroid of innermost generation — fed to after all rings to clean centre.
  const cleanupCentroid = computeCleanupCentroid(generations, insideOut, outerPts, islands)

  const outsideInPlan = insideOut ? undefined : planFirstScheduledRing(cutGens, useClimb, islands)
  // Preserve the established inside-out entry curve and placement exactly.
  const insideFirstRing = insideOut ? largestLoop(cutGens[0]) : null
  const insideDirectedRing = insideFirstRing
    ? (useClimb ? [...insideFirstRing] : [...insideFirstRing].reverse())
    : null
  const insideRampCurve = insideDirectedRing ? buildArcCurve(insideDirectedRing) : null
  // WO-1972: a helix entry starts at the material and stays down between levels.
  const helixEntry = insideOut && entryType === 'ramp_helical' && helixFits(safeHelixR)
  const helixStartPt = { x: entryCtr.x + safeHelixR, y: entryCtr.y }
  let prevCleared: ClearedRegion | null = null

  for (let di = 0; di < allDepths.length; di++) {
    const depth   = allDepths[di]
    const isFinal = di === allDepths.length - 1

    // Cleared stock is per-depth: each Z level starts from fully uncut material.
    const cleared = makeClearedRegion(ctx.toolRadius)

    let entry: EntryResult
    if (insideOut) {
      const approachPt = entryCtr
      const entryZ = helixEntry
        ? helixStartZ(ctx, entryCtr, safeHelixR, di === 0 ? ctx.entryCeilingZ : allDepths[di - 1], depth)
        : retractZ
      if (di === 0) {
        rapidTo(moves, approachPt, clearanceZ)
        if (!helixEntry || retractZ > entryZ) rapidTo(moves, approachPt, retractZ)
      } else {
        const m = moves[moves.length - 1]
        const stayedDown = helixEntry && prevCleared !== null && linkDownToHelix(
          moves, m, allDepths[di - 1], helixStartPt, entryZ, ctx.entryClearance, ctx.toolRadius,
          outerRings, islands, prevCleared)
        if (!stayedDown) {
          rapidTo(moves, m, retractZ)
          rapidTo(moves, approachPt, retractZ)
        }
      }
      entry = performEntry(
        moves, entryType, entryCtr, insideRampCurve!, safeHelixR,
        entryZ, depth, tanAngle, rampAngle, plungeRate, rampRate,
      )
    } else {
      // At later depths, lift vertically before traversing to the entry start.
      // The profile itself begins at the preceding machined depth, not retract Z.
      if (di > 0) {
        const m = moves[moves.length - 1]
        rapidTo(moves, m, clearanceZ)
      }
      entry = performOutsideInEntry(
        moves, outsideInPlan!, entryType,
        di === 0 ? topZ : allDepths[di - 1], depth,
        clearanceZ, retractZ, tanAngle, plungeRate, rampRate, feedRate,
        sampleStep, overlapMm, islands,
      )
    }

    // A helix or plunge proves only its final cutter footprint clear. A Profile
    // Ramp proves the ring only after its explicit full-depth cleanup lap.
    if (entry.preCutPath) cleared.addCutPath(entry.preCutPath, true)
    else cleared.addCutPath([entry.endPt], false)

    cutAllGenerations(moves, cutGens, islands, outerPts, outerRings,
      depth, entry.endPt, feedRate, plungeRate, retractZ, sampleStep, useClimb,
      overlapMm, stepoverLeadIn, cleanupCentroid, cleared,
      outsideInPlan, !!entry.preCutRing, entry.exitTangent)

    if (isFinal && params.finishContour) {
      emitFinishContour(moves, finishPath, largestLoop(generations[0]),
        depth, retractZ, feedRate, plungeRate, useClimb, outerPts, islands,
        passes.finishPasses ?? 1, passes.springPasses ?? 0,
        params.stayDown ?? false, params.stayDownLift ?? 1.0, cleared)
      emitIslandFinishContours(
        moves, finishIslandGroups, islands, outerRings,
        depth, retractZ, feedRate, plungeRate, useClimb, outerPts,
        passes.finishPasses ?? 1, passes.springPasses ?? 0, cleared,
      )
    }
    prevCleared = cleared
  }

  const endM = moves[moves.length - 1]
  rapidTo(moves, endM, retractZ)
  rapidTo(moves, endM, clearanceZ)
}

// ── Machine one region at one depth (by_depth order strategy) ─────────────────

function machineRegionAtDepth(
  moves: ToolpathMove[],
  outerPts: Pt2[], generations: Pt2[][][],
  finishPath: Pt2[] | null, islands: Pt2[][], finishIslandGroups: IslandContourGroup[],
  entryCtr: Pt2, safeHelixR: number,
  depth: number, materialSurfaceZ: number, isFinal: boolean,
  params: PocketParams,
  passes: { finishPasses?: number; springPasses?: number },
  ctx: Ctx,
  /** WO-1972: what this operation already cut over the entry (undefined on the
   *  first level of the first band). */
  ceilingZ?: number,
  /** WO-1972: the cleared sweep of the level above, when the tool was left down on it. */
  prevCleared?: ClearedRegion,
  /** WO-1972: leave the tool down at the end of this level for the next one. */
  holdDown = false,
  /** WO-2296: the rings as cut (corners rounded); the geometry rings otherwise. */
  ringPaths: Pt2[][][] = generations,
): ClearedRegion {
  const { feedRate, plungeRate, rampRate, tanAngle, rampAngle,
          useClimb, insideOut, clearanceZ, retractZ, sampleStep, entryType,
          overlapMm, stepoverLeadIn } = ctx

  const cutGens    = insideOut ? [...ringPaths].reverse() : ringPaths
  const outerRings = generations[0]

  const cleanupCentroid = computeCleanupCentroid(generations, insideOut, outerPts, islands)

  const outsideInPlan = insideOut ? undefined : planFirstScheduledRing(cutGens, useClimb, islands)
  let entry: EntryResult
  if (insideOut) {
    const firstRing = largestLoop(cutGens[0])
    const dirFirstRing = useClimb ? [...firstRing] : [...firstRing].reverse()
    const rampCurve = buildArcCurve(dirFirstRing)
    // WO-1972: a helix entry starts at the material; from a level the tool was
    // left down on, it stays down.
    const helixEntry = entryType === 'ramp_helical' && helixFits(safeHelixR)
    const entryZ = helixEntry ? helixStartZ(ctx, entryCtr, safeHelixR, ceilingZ, depth) : retractZ
    if (prevCleared) {
      const m = moves[moves.length - 1]
      const helixStartPt = { x: entryCtr.x + safeHelixR, y: entryCtr.y }
      const stayedDown = helixEntry && linkDownToHelix(
        moves, m, materialSurfaceZ, helixStartPt, entryZ, ctx.entryClearance, ctx.toolRadius,
        outerRings, islands, prevCleared)
      if (!stayedDown) {
        rapidTo(moves, m, retractZ)
        rapidTo(moves, m, clearanceZ)
        rapidTo(moves, entryCtr, clearanceZ)
        rapidTo(moves, entryCtr, retractZ)
      }
    } else {
      rapidTo(moves, entryCtr, clearanceZ)
      if (!helixEntry || retractZ > entryZ) rapidTo(moves, entryCtr, retractZ)
    }
    entry = performEntry(
      moves, entryType, entryCtr, rampCurve, safeHelixR,
      entryZ, depth, tanAngle, rampAngle, plungeRate, rampRate,
    )
  } else {
    entry = performOutsideInEntry(
      moves, outsideInPlan!, entryType, materialSurfaceZ, depth,
      clearanceZ, retractZ, tanAngle, plungeRate, rampRate, feedRate,
      sampleStep, overlapMm, islands,
    )
  }

  // Cleared stock is per-depth: this Z level starts from fully uncut material.
  const cleared = makeClearedRegion(ctx.toolRadius)
  if (entry.preCutPath) cleared.addCutPath(entry.preCutPath, true)
  else cleared.addCutPath([entry.endPt], false)

  cutAllGenerations(moves, cutGens, islands, outerPts, outerRings,
    depth, entry.endPt, feedRate, plungeRate, retractZ, sampleStep, useClimb,
    overlapMm, stepoverLeadIn, cleanupCentroid, cleared,
    outsideInPlan, !!entry.preCutRing, entry.exitTangent)

  if (isFinal && params.finishContour) {
    emitFinishContour(moves, finishPath, largestLoop(generations[0]),
      depth, retractZ, feedRate, plungeRate, useClimb, outerPts, islands,
      passes.finishPasses ?? 1, passes.springPasses ?? 0,
      params.stayDown ?? false, params.stayDownLift ?? 1.0, cleared)
    emitIslandFinishContours(
      moves, finishIslandGroups, islands, outerRings,
      depth, retractZ, feedRate, plungeRate, useClimb, outerPts,
      passes.finishPasses ?? 1, passes.springPasses ?? 0, cleared,
    )
  }

  if (!holdDown) {
    const endM = moves[moves.length - 1]
    rapidTo(moves, endM, retractZ)
    rapidTo(moves, endM, clearanceZ)
  }
  return cleared
}

// ── Island-aware entry placement (both fill orders) ───────────────────────────
// The naive entry centre — centroid of the innermost ring for inside-out,
// centroid of the outer boundary for outside-in — lands ON the island for
// annular pockets, and performEntry would silently downgrade the helix to a
// straight plunge into the island (ADR 0003 violation: silent fallback that
// gouges). This validates the naive centre against the toolRadius-expanded
// island keep-outs first; when invalid, it scans the innermost-generation ring
// vertices (the deepest interior points) plus the naive centre for the
// island-clear point with the best clearance to both islands and the pocket
// wall, and fits the helix radius to that clearance.
//
// WO-2876: the rings are offsets of the outer boundary alone, so around a
// central island the innermost generations shrink onto the island and every
// one of their vertices lies inside its keep-out (a 40 mm square round a 12 mm
// circle refused with ~11 mm of room on every side). When the innermost
// generation offers nothing, the scan walks outward to the first generation
// that does - the ring inside-out actually cuts first, since stepToRing skips
// rings wholly inside a keep-out - sampling along its rings, not only at their
// corners. A Helix entry walks on past a clear ring too tight for its helix to
// the first one the requested helix fits (a 1 mm stepover's first clear ring
// left 0.28 mm, the next ring out 1.69 mm); when no ring fits it the roomiest
// one takes a reduced helix if helixFits accepts it, and otherwise the
// operation refuses - it never plunges for a Helix (rule 11). A pocket whose
// innermost generation already had a point is placed exactly as before.

/** Min distance from pt to every expanded-island boundary (positive outside). */
function minDistToIslands(pt: Pt2, islands: Pt2[][]): number {
  let d = Infinity
  for (const isl of islands) d = Math.min(d, distToPolyBoundary(pt, isl))
  return d
}

/** Points every `step` mm along each closed loop, its vertices included. */
function ringSamples(loops: Pt2[][], step: number): Pt2[] {
  const out: Pt2[] = []
  for (const loop of loops) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      const n = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step))
      for (let k = 0; k < n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n })
    }
  }
  return out
}

/** The island-clear candidate with the best clearance to the islands and the pocket wall. */
function bestIslandClearPoint(
  candidates: Pt2[], outerRings: Pt2[][], expandedIslands: Pt2[][],
): { pt: Pt2; clear: number } | null {
  let bestPt: Pt2 | null = null
  let bestClear = -Infinity
  for (const c of candidates) {
    if (expandedIslands.some(isl => pointInPolygon(c, isl))) continue
    const wallRing = outerRings.find(r => pointInPolygon(c, r))
    if (!wallRing) continue
    const wallClear = -distToPolyBoundary(c, wallRing)   // negative inside → clearance
    const islClear  = minDistToIslands(c, expandedIslands)
    const clear     = Math.min(wallClear, islClear)
    if (clear > bestClear) { bestClear = clear; bestPt = c }
  }
  return bestPt && bestClear > 0 ? { pt: bestPt, clear: bestClear } : null
}

/** Spacing of the WO-2876 outward ring scan; stepToRing scans rings at the same 0.25 mm. */
const ENTRY_RING_SCAN_STEP = 0.25

function placeEntry(
  naiveCtr: Pt2, clampRing: Pt2[], candidateGen: Pt2[][],
  outerRings: Pt2[][], expandedIslands: Pt2[][],
  requestedHelixR: number, toolRadius: number,
  /** WO-2876: the generations outside candidateGen, innermost first. */
  outwardGens: Pt2[][][] = [],
  /** WO-2876: the entry is a Helix, so the outward scan looks for room for it. */
  wantsHelix = false,
): { entryCtr: Pt2; safeHelixR: number } {
  const margin = toolRadius * 0.1

  // Legacy clamp against the clamp ring (vertex distance) — unchanged. The
  // clamp ring is the innermost ring for inside-out, the outermost ring for
  // outside-in.
  const maxR        = minRadiusFrom(clampRing, naiveCtr) - margin
  const legacyHelixR = maxR > margin ? Math.min(requestedHelixR, maxR) : 0

  // Fast path: no islands, or the centre clears every island keep-out by the
  // helix radius in use (plus margin). Identical to the legacy behaviour, so
  // simple pockets emit byte-identical toolpaths.
  if (expandedIslands.length === 0) return { entryCtr: naiveCtr, safeHelixR: legacyHelixR }
  if (!expandedIslands.some(isl => pointInPolygon(naiveCtr, isl)) &&
      minDistToIslands(naiveCtr, expandedIslands) - margin >= legacyHelixR)
    return { entryCtr: naiveCtr, safeHelixR: legacyHelixR }

  // Candidate scan: innermost-generation ring vertices + the naive centre.
  // Score island-clear candidates by clearance = min(dist to islands, dist to
  // the outermost-ring wall boundary); pick the best.
  const candidates: Pt2[] = [naiveCtr]
  for (const loop of candidateGen) candidates.push(...loop)

  let best = bestIslandClearPoint(candidates, outerRings, expandedIslands)
  let outward = false
  if (!best) {
    let roomiest: { pt: Pt2; clear: number } | null = null
    for (const gen of outwardGens) {
      const found = bestIslandClearPoint(ringSamples(gen, ENTRY_RING_SCAN_STEP), outerRings, expandedIslands)
      if (!found) continue
      if (!wantsHelix || found.clear - margin >= requestedHelixR) { best = found; break }
      if (!roomiest || found.clear > roomiest.clear) roomiest = found
    }
    best ??= roomiest
    outward = best !== null
  }

  if (!best) {
    // ADR 0003: never emit a gouging entry — surface the error through the worker.
    throw new Error(
      'pocket2d entry: no island-clear entry point — every candidate lies ' +
      'inside an island keep-out or outside the pocket. Refusing to emit a ' +
      'gouging entry (ADR 0003).')
  }
  const { pt: bestPt, clear: bestClear } = best

  const fitR = Math.min(requestedHelixR, bestClear - margin)
  // WO-2876 (rule 11): a Helix placed by the outward scan either runs as a
  // helix or moves nothing. Every consumer of safeHelixR (performEntry,
  // machineRegion, machineRegionAtDepth, staysDown) turns a radius helixFits
  // rejects into a plunge, so a fit below it here would be a Plunge the
  // operator did not choose. Only the outward route refuses: it used to throw,
  // and the legacy candidates keep their logged degradation unchanged.
  if (outward && wantsHelix && !(fitR > margin && helixFits(fitR))) {
    throw new Error(
      `Pocket 2D: no room for the Helix entry around the island in this pocket - the most ` +
      `room any ring offers is ${bestClear.toFixed(2)} mm and a helix needs ` +
      `${(Math.max(margin, MIN_HELIX_RADIUS_MM) + margin).toFixed(2)} mm. Nothing was cut; ` +
      `a Plunge entry fits.`)
  }
  if (fitR <= margin) {
    // Structured, non-silent degradation (ADR 0003): the plunge point itself is
    // verified island-clear above.
    console.warn(
      `pocket2d entry: helix_degraded_to_plunge clearance=${bestClear.toFixed(3)}mm ` +
      `at island-clear point (${bestPt.x.toFixed(3)}, ${bestPt.y.toFixed(3)})`)
    return { entryCtr: bestPt, safeHelixR: 0 }
  }
  return { entryCtr: bestPt, safeHelixR: fitR }
}

// ── WO-2291: slot feed ─────────────────────────────────────────────────────────
//
// Below 100%, a cut move slows where the cutter is buried: its engagement is read
// against everything this Z level has already swept (engagement2d), and the feed
// eases from the cutting feed at the stepover's engagement down to the slot feed at
// a full-width slot. Only the feed of 'cut' moves changes; a move whose feed changes
// part-way is split at that point on its own line. Links, plunges, ramps and helixes
// keep their feeds, and every horizontal feed move on a level is a prior sweep.

/** Engagement is sampled at most this fraction of the tool diameter apart. */
const SLOT_FEED_CHUNK_FRAC = 0.25
const SLOT_FEED_SAMPLES_PER_CHUNK = 3

export function resolveSlotFeedScale(params: PocketParams): number | null {
  const percent = params.slotFeedPercent
  if (percent === undefined || !Number.isFinite(percent) || percent >= 100) return null
  return Math.max(1, percent) / 100
}

function applySlotFeed(
  moves: ToolpathMove[], levels: number[], toolRadius: number, stepover: number, slotScale: number,
): ToolpathMove[] {
  const sortedLevels = [...new Set(levels)].sort((a, b) => b - a)
  // A move belongs to the level whose slab (down from the level above) holds it.
  const levelOf = (z: number): number | undefined => sortedLevels.find(d => d <= z + 1e-6)
  const indices = new Map<number, SweptMaterialIndex>()
  const quantizer = new EngagementFeedQuantizer({
    nominal: nominalEngagement(stepover, toolRadius), slotScale, minStretch: 2 * toolRadius,
  })
  const chunkLen = 2 * toolRadius * SLOT_FEED_CHUNK_FRAC
  const out: ToolpathMove[] = []
  let prev: ToolpathMove | undefined
  for (const m of moves) {
    const from = prev
    prev = m
    const level = from && m.type === 'feed' && Math.abs(m.z - from.z) < 1e-6 ? levelOf(m.z) : undefined
    if (from === undefined || level === undefined) {
      quantizer.reset()
      out.push(m)
      continue
    }
    let index = indices.get(level)
    if (!index) { index = new SweptMaterialIndex(toolRadius); indices.set(level, index) }
    const dx = m.x - from.x, dy = m.y - from.y
    const len = Math.hypot(dx, dy)
    if (m.role !== 'cut' || m.feed === undefined || len <= 1e-9) {
      if (m.role !== 'cut') quantizer.reset()
      out.push(m)
    } else {
      const n = Math.max(1, Math.ceil(len / chunkLen))
      let groupScale = 1
      for (let k = 0; k < n; k++) {
        let engagement = 0
        for (let s = 1; s <= SLOT_FEED_SAMPLES_PER_CHUNK; s++) {
          const t = (k + s / (SLOT_FEED_SAMPLES_PER_CHUNK + 1)) / n
          engagement = Math.max(engagement, index.engagementAt(from.x + dx * t, from.y + dy * t, dx, dy))
        }
        const scale = quantizer.push(engagement, len / n)
        if (k > 0 && scale !== groupScale) {
          const t = k / n
          out.push({ ...m, x: from.x + dx * t, y: from.y + dy * t, feed: m.feed * groupScale })
        }
        groupScale = scale
      }
      out.push(groupScale === 1 ? m : { ...m, feed: m.feed * groupScale })
    }
    if (Math.abs(m.z - level) < 1e-6) index.addSweptSegment(from.x, from.y, m.x, m.y)
  }
  return out
}

// ── Main export ────────────────────────────────────────────────────────────────

export function buildPocketToolpath(
  payload: PocketWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
  notify?: (message: string) => void,
): ToolpathMove[] {
  const { params, heights, passes, linking, tool, loops, wcsOrigin } = payload
  const moves: ToolpathMove[] = []

  // Saved projects are migrated before dispatch, but the worker remains a
  // deterministic fail-loud boundary for stale or programmatic payloads.
  assertPocketEntryAllowed(params.fillStrategy, linking.entryType)

  const toolRadius  = tool.diameter / 2
  const { feedRate, plungeRate, rampRate } = resolveFeedrates(
    tool, payload.feedrateOverride,
  )

  const { clearanceZ, retractZ, feedZ, topZ, bottomZ: rawBottomZ } = resolveHeights(heights, wcsOrigin)
  assertToolFluteReach({
    operation: 'Pocket',
    topZ,
    bottomZ: rawBottomZ,
    fluteLength: tool.fluteLength,
  })
  const bottomZ = rawBottomZ

  const stepover   = Math.max(0.1, passes.stepover)
  const wallStock  = Math.max(0, passes.stockToLeave ?? 0)
  // Axial (floor) stock: shared PassParams field wins; legacy per-op
  // PocketParams.floorStockToLeave is the back-compat fallback.
  const floorStock = Math.max(0, passes.floorStockToLeave ?? params.floorStockToLeave ?? 0)
  const sampleStep = Math.max(0.1, stepover * SAMPLE_FRAC)

  const roughBottomZ = floorStock > 0 ? bottomZ + floorStock : bottomZ
  const roughDepths  = buildDepths(topZ, roughBottomZ, passes.stepdown)
  const allDepths    = floorStock > 0 ? [...roughDepths, bottomZ] : roughDepths
  if (allDepths.length === 0) return moves

  const entryType  = linking.entryType
  const rampAngle  = Math.max(0.5, Math.min(linking.rampAngle ?? 3, 30))
  const tanAngle   = Math.tan(rampAngle * Math.PI / 180)
  const helixDiaPct = params.helixDiameter ?? 90
  const insideOut  = (params.fillStrategy ?? 'outside_in') === 'inside_out'
  const useClimb   = directionForTool(params.direction, tool) !== 'conventional'

  // ADR 0003: never silently emit an empty toolpath. A non-empty loop selection
  // that matches NO current loop means the op's saved loop ids were orphaned -
  // loop ids are minted fresh every time a geometry's loops are re-derived
  // (re-import, sketch bake, projection-tolerance change), so a stored selection
  // points at ids that no longer exist. Fail loud and tell the user to re-select
  // instead of producing nothing (the silent "ready / 0 moves / nothing renders"
  // bug, Operator 2026-06-13).
  const closedLoops = loops.filter(l => l.closed)
  const targetLoops = params.loopIds.length > 0
    ? closedLoops.filter(l => params.loopIds.includes(l.id))
    : closedLoops
  if (targetLoops.length === 0) {
    if (params.loopIds.length > 0 && closedLoops.length > 0) {
      throw new Error(
        'Pocket: the selected loop(s) no longer exist - the geometry was re-derived ' +
        '(re-import / sketch edit / projection-tolerance change regenerates loop ids). ' +
        'Open the operation, re-select the loop in the Geometry tab, and recompute.'
      )
    }
    throw new Error('Pocket: no closed loop found to cut. Select a closed contour in the Geometry tab.')
  }

  const classified = classifyLoops(targetLoops)
  const bands = pocketDepthBands(classified, payload, topZ, allDepths)
  const allowanceMm = clearanceAllowanceMmOf(payload)
  const overlapMm       = Math.max(0, params.overlapMm ?? 0)
  const stepoverLeadIn  = (params.stepoverLeadIn ?? 'none') as 'none' | 'arc'

  const requestedClearance = params.entryClearance
  const entryClearance = requestedClearance !== undefined && Number.isFinite(requestedClearance) &&
    requestedClearance >= 0 ? requestedClearance : 1
  const ctx: Ctx = { feedRate, plungeRate, rampRate, tanAngle, rampAngle,
                      useClimb, insideOut, clearanceZ, retractZ, topZ, sampleStep, entryType,
                      overlapMm, stepoverLeadIn, toolRadius, entryClearance,
                      remaining: usableStock((payload as ToolReachInputs).remainingStock),
                      stockBlock: payload.stockBlock }

  let bandTopZ = topZ
  for (let bi = 0; bi < bands.length; bi++) {
    const band = bands[bi]
    const bandDepths = band.depths
    const bandCtx: Ctx = { ...ctx, topZ: bandTopZ, entryCeilingZ: bi > 0 ? bandTopZ : undefined }
    const { outerBounds, islandPool, underWorkholding } = classifyBand(classified, band)
    const above = bi > 0 ? bands[bi - 1] : undefined
    if (above?.addedFloorZ !== undefined) {
      notify?.(
        `Pocket: over the workholding the cut stops ${allowanceMm} mm above its top, so the last ` +
        `${formatMm(above.addedFloorZ - bandDepths[bandDepths.length - 1])} mm of the depth was not cut there; ` +
        'everything above it is cleared.',
      )
    }
    // The footprint only grows with depth, so every band below this one is under it too.
    if (underWorkholding) {
      if (above) break
      notify?.(workholdingIslandNotice('Pocket', band.reduced!.removedAreaMm2, allowanceMm))
      notify?.('Pocket: the whole region sits under the workholding, so there was nothing to cut.')
      return moves
    }
    if (band.reduced) notify?.(workholdingIslandNotice('Pocket', band.reduced.removedAreaMm2, allowanceMm))
    if (outerBounds.length === 0) {
      throw new Error('Pocket: the selected loops contain no usable closed boundary to pocket.')
    }
    const islandsByOuter = assignIslandsToOuterBounds(outerBounds, islandPool)

    const boundsTotal = outerBounds.length
    let completedBounds = 0
    for (const bound of outerBounds) {
      const outerPts = ensureCCW(bound.points as Pt2[])

      // Expand islands by (toolRadius + wallStock) to get keep-out zones for the
      // tool centre — mirroring generateRings, which offsets the outer boundary by
      // -(toolRadius + wallStock). Without the wallStock term the tool centre could
      // approach the island to toolRadius and machine away the island's wall stock.
      const myIslands = islandsByOuter.get(bound) ?? []
      const islandContourGroups: IslandContourGroup[] = myIslands.map(isl => {
        const source = ensureCCW(isl.points as Pt2[]) as Pt2[]
        const expanded = cleanOffsetLoops(offsetLoop(source, toolRadius + wallStock), 0)
        return {
          roughPaths: expanded,
          finishPaths: cleanOffsetLoops(offsetLoop(source, toolRadius), 0),
        }
      })
      const expandedIslands = islandContourGroups.flatMap(group => group.roughPaths)

      const { generations, finishPath } = generateRings(outerPts, toolRadius, wallStock, stepover)
      if (generations.length === 0) continue
      // WO-2296: the rings as cut. Every envelope, entry and centre decision keeps
      // reading the geometry rings; only the cut paths take their corners as arcs.
      const ringPaths = params.roundRingCorners === true
        ? roundPocketRingCorners(generations, { toolRadius, islands: expandedIslands })
        : generations
      const finishOuterEnvelope = params.finishContour
        ? cleanOffsetLoops(offsetLoop(outerPts, -toolRadius), 0)
        : []
      assertIslandContoursFit(
        islandContourGroups,
        generations[0],
        finishOuterEnvelope,
        params.finishContour,
      )

      // Inside-out retains its island-aware centroid entry placement. Outside-in
      // Profile Ramp and Plunge instead use the exact scheduled outer-ring plan;
      // entryCtr and safeHelixR are unused placeholders on that path.
      let entryCtr: Pt2
      let safeHelixR = 0
      const requestedHelixR = (helixDiaPct / 100) * toolRadius
      const innerGen = generations[generations.length - 1]

      if (insideOut) {
        const innerRing = largestLoop(innerGen)
        const placed = placeEntry(centroid(innerRing), innerRing, innerGen,
          generations[0], expandedIslands, requestedHelixR, toolRadius,
          generations.slice(0, -1).reverse(), entryType === 'ramp_helical')
        entryCtr   = placed.entryCtr
        safeHelixR = placed.safeHelixR
      } else if (entryType === 'ramp_linear' || entryType === 'plunge') {
        // Both allowed outside-in entries are bound to the scheduled outer ring;
        // these legacy centroid/helix values are intentionally unused.
        // Entry execution uses only the first-ring plan, so no island-interior
        // placement search is needed for either allowed outside-in strategy.
        entryCtr = centroid(outerPts)
        safeHelixR = 0
      } else {
        // The policy assertion above makes this branch unreachable. Keep a
        // defensive failure here in case a future entry type bypasses that policy.
        throw new Error('Pocket 2D: unreachable outside-in entry strategy after compatibility validation.')
      }

      if (params.orderStrategy === 'by_region') {
        machineRegion(moves, outerPts, generations, finishPath, expandedIslands, islandContourGroups,
          entryCtr, safeHelixR, bandDepths, params, passes, bandCtx, ringPaths)
        // Progress checkpoint: region machined (coarse — per outer boundary).
        onProgress?.((completedBounds + 1) / boundsTotal,
          boundsTotal > 1 ? `Region ${completedBounds + 1}/${boundsTotal}` : undefined)
      } else {
        // WO-1972: with a helix entry the tool stays down from one level to the next.
        const staysDown = insideOut && entryType === 'ramp_helical' && helixFits(safeHelixR)
        let heldCleared: ClearedRegion | undefined
        for (let di = 0; di < bandDepths.length; di++) {
          const isLast = di === bandDepths.length - 1
          const holdDown = staysDown && !isLast
          const levelCleared = machineRegionAtDepth(moves, outerPts, generations, finishPath, expandedIslands,
            islandContourGroups, entryCtr, safeHelixR, bandDepths[di], di === 0 ? bandTopZ : bandDepths[di - 1],
            isLast, params, passes, bandCtx,
            di === 0 ? bandCtx.entryCeilingZ : bandDepths[di - 1], heldCleared, holdDown, ringPaths)
          heldCleared = holdDown ? levelCleared : undefined
          // Progress checkpoint: one Z level of this region (coarse — per depth pass).
          onProgress?.((completedBounds + (di + 1) / bandDepths.length) / boundsTotal,
            bandDepths.length > 1 ? `Z level ${di + 1}/${bandDepths.length}` : undefined)
        }
      }
      completedBounds++
    }
    bandTopZ = bandDepths[bandDepths.length - 1]
  }

  // ADR 0003: a selection that matched closed loops but still produced no motion
  // (e.g. every ring collapsed because the tool is larger than the pocket) must
  // surface, not return silently.
  if (moves.length === 0) {
    throw new Error(
      'Pocket: produced no toolpath - the selected region is smaller than the tool ' +
      '(rings collapse). Use a smaller tool or a larger pocket.'
    )
  }

  // WO-2291: slot feed on the main path (rings, islands, finish). Absent/100% leaves
  // every move untouched.
  const slotScale = resolveSlotFeedScale(params)
  if (slotScale !== null) {
    const fed = applySlotFeed(moves, bands.flatMap(band => band.depths), toolRadius, stepover, slotScale)
    moves.length = 0
    for (const m of fed) moves.push(m)
  }

  // WO-2287: corner relief, after the whole main path so it reads where the walls were
  // really cut. The pocket boundary is cleared inside, its islands outside. None/absent
  // appends nothing.
  appendCornerRelief(moves, params, toolRadius, wallStock, [{
    loops: [
      ...classified.outerBounds.map(l => ({ points: l.points, clearedInside: true })),
      ...classified.islandPool.map(l => ({ points: l.points, clearedInside: false })),
    ],
    levels: allDepths,
  }], { feedZ, retractZ, clearanceZ, feedRate, plungeRate, direction: useClimb ? 'climb' : 'conventional' })

  assertPocketMoveCapacity(moves, 0, 'completing the operation')

  // WO-1888: last, on the finished path, so the rings, islands, entries and
  // finish passes are planned exactly as they always were and only the ones the
  // earlier operations already emptied are dropped. Nothing happens without a
  // remaining stock on the request, so a first operation is byte-identical.
  return applyRestAir2d(
    'Pocket', moves, tool, (payload as ToolReachInputs).remainingStock, retractZ, notify,
    resolveFloorHopMm(linking),
  )
}
