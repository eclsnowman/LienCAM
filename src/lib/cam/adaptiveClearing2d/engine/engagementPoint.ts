// SPDX-License-Identifier: LGPL-2.1-or-later
// Ported from FreeCAD's Adaptive2d (src/Mod/CAM/libarea/Adaptive.cpp and Path Adaptive Python), Copyright (c) 2018 Kresimir Tusek.
// This file remains under LGPL-2.1-or-later; the LienCAM project as a whole is distributed under GPL-3.0-or-later (see /LICENSE).
// The engage-point walker: slides a point ALONG the region boundary to find where
// uncut material remains, which becomes the start of the next pass. Port of
// FreeCAD EngagementPoint.py.
//
// This is how the algorithm handles multiple passes AND multiple regions without any
// explicit region decomposition: after a pass runs out, the walker advances along the
// boundary curve, placing the tool disk and testing how much of it still bites uncut
// material (disk minus cleared). When that bite enters a target band, that point seeds
// the next pass. A full lap with no bite anywhere => the feature is cleared.

import { type Pt, type Loops } from './clipperEngine'
import type { ToolGeometry } from './toolGeometry'

export interface EngagementWalker {
  /** Reset to the first boundary segment. */
  initialize(): void
  /** Current point on the boundary and the segment's unit direction. */
  getCurrentPoint(): { pt: Pt; dir: Pt }
  /** Jump the walker to the boundary point closest to `pt` (used after the first pass). */
  moveToClosestPoint(pt: Pt): void
  /** Advance along the boundary until the tool disk bite (disk minus cleared) enters
   *  (toReachArea, maxArea). Returns false if a full lap finds nothing -> region done. */
  moveForwardToCutThreshold(cleared: Loops, stepDistance: number, toReachArea: number, maxArea: number): boolean
  /** Snapshot of the walker's current boundary location (path/segment/offset-along-segment). */
  getLocation(): WalkerLocation
  /** Cumulative boundary distance walked by moveForwardToCutThreshold since initialize().
   *  The WO-410 fruitless-lap odometer: processFeature compares the distance walked since
   *  the last PRODUCTIVE pass against totalBoundaryLength() to detect a full lap in which
   *  no pass removed anything (the engage frontier is then exhausted -> re-seed). Only
   *  threshold walking counts; moveToClosestPoint's scan is a search, not a lap. */
  getOdometer(): number
  /** Total length of every boundary loop this walker walks (sum over paths). */
  totalBoundaryLength(): number
  /** Reconstruct the boundary polyline traversed in the configured travel direction from
   *  `start` to the CURRENT location, along boundaryPaths. Returns the ordered points
   *  (exact start point, every intermediate segment-boundary vertex passed, exact current
   *  point). Returns null if the current location is on a DIFFERENT pathIndex than `start`
   *  (the walk wrapped to another boundary loop), i.e. it is not a single-wall follow. */
  spanFrom(start: WalkerLocation): Pt[] | null
}

/** A snapshot of the walker's position on the boundary. */
export interface WalkerLocation { pathIndex: number; segIndex: number; segPos: number }

const segLen = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

/**
 * Walk over `boundaryPaths` (the machinable-region boundary loops). FreeCAD indexes
 * each segment as [path[i-1], path[i]] so segment 0 is the closing edge -- replicated.
 */
export function createEngagementWalker(
  boundaryPaths: Loops,
  tool: ToolGeometry,
  forward = true,
  // WO-439 fix 2: the region a roughing pass may actually remove material from
  // (processFeature's targetRegion). When given, the bite test below counts only uncut
  // material inside it -- see the call.
  biteRegion?: Loops,
): EngagementWalker {
  let pathIndex = 0
  let segIndex = 0
  let segPos = 0
  let segmentLength = 0
  let pathDistanceTraveled = 0
  let odometer = 0 // WO-410: cumulative threshold-walk distance since initialize()
  const pathLengths: number[] = []

  // Segment [pi][si] runs from pth[si-1] to pth[si] (FreeCAD winding). Pulled out of
  // curSegment so spanFrom can reconstruct points at locations other than the current one
  // using the SAME math, so reconstructed endpoints match getCurrentPoint exactly.
  function segmentAt(pi: number, si: number): [Pt, Pt] {
    const pth = boundaryPaths[pi]
    const a = pth[(si - 1 + pth.length) % pth.length]
    const b = pth[si % pth.length]
    return forward ? [a, b] : [b, a]
  }

  /** Point at offset `pos` along segment [pi][si] -- the same derivation getCurrentPoint
   *  uses (a + (b-a)*pos/L). L is the segment's length (guarded like moveForward does). */
  function pointAt(pi: number, si: number, pos: number): Pt {
    const [a, b] = segmentAt(pi, si)
    const L = segLen(a, b) || 1
    return { x: a.x + (b.x - a.x) * pos / L, y: a.y + (b.y - a.y) * pos / L }
  }

  function curSegment(): [Pt, Pt] {
    return segmentAt(pathIndex, segIndex)
  }

  function initialize(): void {
    pathIndex = 0; segIndex = 0; segPos = 0; pathDistanceTraveled = 0
    odometer = 0
    segmentLength = segLen(...curSegment())
    pathLengths.length = 0
    for (const pth of boundaryPaths) {
      let total = 0
      for (let si = 0; si < pth.length; si++) total += segLen(pth[(si - 1 + pth.length) % pth.length], pth[si])
      pathLengths.push(total)
    }
  }

  function getCurrentPoint(): { pt: Pt; dir: Pt } {
    const [a, b] = curSegment()
    const L = segmentLength || 1
    const pt = { x: a.x + (b.x - a.x) * segPos / L, y: a.y + (b.y - a.y) * segPos / L }
    const dir = { x: (b.x - a.x) / L, y: (b.y - a.y) / L }
    return { pt, dir }
  }

  function nextPath(): boolean {
    pathIndex++
    segIndex = 0
    let hasMore = true
    if (pathIndex >= boundaryPaths.length) { pathIndex = 0; hasMore = false }
    segPos = 0
    segmentLength = segLen(...curSegment())
    pathDistanceTraveled = 0
    return hasMore
  }

  // Advance `distance` along the boundary, wrapping segments. Returns false once a
  // full path length has been traversed (FreeCAD's loop-completion signal).
  function moveForward(distance: number): boolean {
    pathDistanceTraveled += distance
    let d = distance
    while (segPos + d >= segmentLength) {
      segIndex = forward
        ? (segIndex + 1) % boundaryPaths[pathIndex].length
        : (segIndex - 1 + boundaryPaths[pathIndex].length) % boundaryPaths[pathIndex].length
      d -= (segmentLength - segPos)
      segPos = 0
      segmentLength = segLen(...curSegment())
      if (segmentLength === 0) segmentLength = 1e-9 // guard against coincident points
    }
    segPos += d
    return pathDistanceTraveled <= pathLengths[pathIndex] + distance
  }

  function moveToClosestPoint(pt: Pt): void {
    // WO-1178: project onto EVERY segment exactly. The port used to step the boundary by one
    // segment length per probe, so on a polygon with long straight edges (a rectangle's cut
    // region has four) it only ever sampled the vertices and parked the walker at the nearest
    // CORNER -- on the Bar the first walk after the opening spiral started 5.4 mm away at the
    // top-left vertex instead of at the spiral's own end, so the next pass was planted past
    // the corner apex with its stock behind it. The exact foot of the perpendicular is the
    // point the walker's own math (pointAt / getCurrentPoint) reproduces byte for byte.
    let best = { pathIndex, segIndex, segPos }
    let minD2 = Infinity
    for (let pi = 0; pi < boundaryPaths.length; pi++) {
      const pth = boundaryPaths[pi]
      for (let si = 0; si < pth.length; si++) {
        const [a, b] = segmentAt(pi, si)
        const ex = b.x - a.x, ey = b.y - a.y
        const l2 = ex * ex + ey * ey
        const L = Math.sqrt(l2)
        let t = l2 > 1e-18 ? ((pt.x - a.x) * ex + (pt.y - a.y) * ey) / l2 : 0
        t = t < 0 ? 0 : t > 1 ? 1 : t
        const qx = a.x + ex * t, qy = a.y + ey * t
        const d2 = (pt.x - qx) ** 2 + (pt.y - qy) ** 2
        if (d2 < minD2) { minD2 = d2; best = { pathIndex: pi, segIndex: si, segPos: t * L } }
      }
    }
    pathIndex = best.pathIndex; segIndex = best.segIndex; segPos = best.segPos
    segmentLength = segLen(...curSegment())
    if (segmentLength === 0) segmentLength = 1e-9
    pathDistanceTraveled = 0
  }

  /** The walker's mutable location, for the WO-1178 band-jump bisection below. */
  type WalkState = { pathIndex: number; segIndex: number; segPos: number; segmentLength: number; pathDistanceTraveled: number }
  const saveState = (): WalkState => ({ pathIndex, segIndex, segPos, segmentLength, pathDistanceTraveled })
  const restoreState = (s: WalkState): void => {
    pathIndex = s.pathIndex; segIndex = s.segIndex; segPos = s.segPos
    segmentLength = s.segmentLength; pathDistanceTraveled = s.pathDistanceTraveled
  }

  function moveForwardToCutThreshold(cleared: Loops, stepDistance: number, toReachArea: number, maxArea: number): boolean {
    let passes = 0
    const biteAt = (pt: Pt): number =>
      biteRegion ? tool.diskBiteIn(pt, cleared, biteRegion) : tool.diskBite(pt, cleared)
    // WO-1178: the bite at the previous probe. The walker walks in the CUTTING direction, so a
    // bite that is RISING step to step means stock lies ahead of the tool and a pass planted
    // here rides into it; a FALLING bite means the stock is behind the tool -- the disk is
    // leaving a patch -- and a pass planted there starts with its material at its back
    // (measured on the Bar: the top-left corner's only start sat 1.07 mm PAST the apex, cut
    // 0.8 mm of nothing, and the corner was left for a hairpin at the end of the lap).
    // Only a rising or flat in-band bite is a start. `null` until the first probe, so the
    // first probe after initialize / moveToClosestPoint is judged exactly as before.
    let prevBite: number | null = null
    let prevState: WalkState | null = null
    for (;;) {
      const before = saveState()
      odometer += stepDistance
      if (!moveForward(stepDistance)) {
        if (!nextPath()) {
          passes++
          if (passes > 1) return false
        }
      }
      const { pt } = getCurrentPoint()
      // totalArea (absolute sum) is the faithful port: FreeCAD EngagementPoint.py:186-187
      // sums math.fabs(Area(poly)) for this same disk-minus-cleared bite. It is a local
      // engagement threshold (band test), not a net region quantity.
      // WO-439 fix 2 -- CLIP THE BITE AGAINST THE REACHABLE REGION. The raw disk bite
      // counts everything under the cutter, including what no roughing pass may ever
      // remove: the finishing-stock rim, the retained islands, and the stock beyond the
      // feature. The walker rides the cut-region wall, so that unremovable rim sat under
      // every probe it ever took and always read as an in-band bite -- and so
      // moveForwardToCutThreshold returned false ZERO times across three fixtures in the
      // step-1 census: the walk could never honestly exhaust. It handed the stepper a
      // start ON the wall, the pass stalled at zero motion, the fruitless-lap odometer
      // fired, and reseed drilled a new entry (ALL extra entries on Bar 8/8 and Triangle
      // 10/10 were fruitless-lap reseeds). Clipped, the probe asks the honest question:
      // is there uncut material here that a pass could actually work on?
      const bite = biteAt(pt)
      const rising = prevBite === null || bite >= prevBite - 1e-9
      if (bite > toReachArea && bite < maxArea && rising) return true
      // WO-1178 BAND JUMP. The band is narrow (its ceiling is one engage bite) and the walker
      // region can begin abruptly -- the credited wall band ends on a hard line one load-depth
      // off the wall -- so a 0.5 mm step can carry the bite from under the band to over it in
      // one go. The old walker then passed the patch and lapped the boundary looking for the
      // next one (Bar: a full lap between the opening spiral and its second pass). The band
      // was crossed between the two probes, so the start is between them: bisect the last
      // step for it. Both ends stay within the same path (nextPath resets the location), and
      // the odometer keeps the whole step -- the search is not a lap.
      if (prevBite !== null && prevState !== null && prevBite <= toReachArea && bite >= maxArea
        && before.pathIndex === pathIndex) {
        const after = saveState()
        let lo = 0
        let hi = 1
        // Search for the band's LOW edge: the first point where the bite clears the floor. A
        // start taken higher in the band bites harder on its first step and leaves less room
        // for the load to grow before the steering has to peel off.
        let found: WalkState | null = null
        for (let k = 0; k < 6 && hi - lo > 1e-3; k++) {
          const mid = (lo + hi) / 2
          restoreState(before)
          moveForward(stepDistance * mid)
          const b = biteAt(getCurrentPoint().pt)
          if (b > toReachArea && b < maxArea) { found = saveState(); hi = mid; continue }
          if (b <= toReachArea) lo = mid
          else hi = mid
        }
        if (found) { restoreState(found); return true }
        restoreState(after)
      }
      prevBite = bite
      prevState = before
    }
  }

  function getLocation(): WalkerLocation {
    return { pathIndex, segIndex, segPos }
  }

  function getOdometer(): number { return odometer }

  function totalBoundaryLength(): number {
    let total = 0
    for (const L of pathLengths) total += L
    return total
  }

  // Reconstruct the boundary polyline from `start` in the configured travel direction.
  // Canonical boundaryPaths are never reversed; only segment traversal changes.
  function spanFrom(start: WalkerLocation): Pt[] | null {
    // A wrap onto another boundary loop (via nextPath) means this is not a single wall.
    if (start.pathIndex !== pathIndex) return null

    const pth = boundaryPaths[pathIndex]
    const span: Pt[] = []

    // Exact start point, derived with the same math the walker uses for its points.
    span.push(pointAt(start.pathIndex, start.segIndex, start.segPos))

    // Same-segment, no vertex crossed: just start -> current (current via getCurrentPoint
    // so the endpoint matches its math byte-for-byte, including the 1e-9 length guard).
    if (start.segIndex === segIndex) {
      span.push(getCurrentPoint().pt)
      return span
    }

    // Walk the intermediate segment-boundary vertices forward, wrapping mod path length.
    // Bound the loop by path length so a malformed state can never spin forever.
    let si = start.segIndex
    for (let guard = 0; guard < pth.length + 1; guard++) {
      const [, end] = segmentAt(start.pathIndex, si)
      span.push({ ...end })
      si = forward
        ? (si + 1) % pth.length
        : (si - 1 + pth.length) % pth.length
      if (si === segIndex) break
    }

    span.push(getCurrentPoint().pt)
    return span
  }

  initialize()
  return { initialize, getCurrentPoint, moveToClosestPoint, moveForwardToCutThreshold, getLocation, getOdometer, totalBoundaryLength, spanFrom }
}

// ── Integral wall-follow helper (pure) ──────────────────────────────────────────

/** Closest projection of `p` onto the closed loop `loop`, using the SAME winding the
 *  walker uses (segment i runs loop[i-1]..loop[i]). Returns the projection point, the
 *  segment index (the `i` whose segment owns the projection), the parametric position t
 *  in [0,1] along that segment, and the squared distance. Guards zero-length segments. */
function projectOntoLoop(p: Pt, loop: Pt[]): { clp: Pt; segIndex: number; t: number; distSq: number } {
  let best = { clp: loop[0], segIndex: 0, t: 0, distSq: Infinity }
  const n = loop.length
  for (let i = 0; i < n; i++) {
    const a = loop[(i - 1 + n) % n]
    const b = loop[i]
    const lx = b.x - a.x, ly = b.y - a.y
    const lsq = lx * lx + ly * ly
    let t = lsq === 0 ? 0 : ((p.x - a.x) * lx + (p.y - a.y) * ly) / lsq
    t = t < 0 ? 0 : t > 1 ? 1 : t
    const cx = a.x + t * lx, cy = a.y + t * ly
    const dx = p.x - cx, dy = p.y - cy
    const distSq = dx * dx + dy * dy
    if (distSq < best.distSq) best = { clp: { x: cx, y: cy }, segIndex: i, t, distSq }
  }
  return best
}

/** Length of a polyline (sum of segment lengths). */
function polylineLength(pts: Pt[]): number {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return len
}

/**
 * The boundary arc that rides a SHARED wall between two points, or null if there is no
 * suitable shared wall. Used for integral wall-follow: a between-pass lift is replaced by
 * a wall-skim that stays at depth.
 *
 * Algorithm:
 *  1. Project p0 and p1 onto every loop; for each, take its nearest loop. If they differ
 *     (or no loop is "close" for either), the two points are not on a shared wall -> null.
 *  2. On the shared loop, the two projections split the closed loop into two arcs (forward
 *     and backward through the boundary vertices). Build both candidate polylines -- each
 *     STARTS at the literal p0 and ENDS at the literal p1, with the boundary vertices of
 *     that arc in between -- and pick the SHORTER one (a wall skim's winding is not load-
 *     critical, so direction-agnostic shorter arc is correct).
 *  3. If the shorter arc's length exceeds `maxLen`, return null (e.g. wrapping a big island).
 *
 * Winding matches the walker (segment i runs loop[i-1]..loop[i]); the "end vertex" of
 * segment i is loop[i % len]. The returned polyline connects continuously: first point is
 * exactly p0 (previous cut's last point), last is exactly p1 (next cut's start).
 */
export function boundaryArcBetween(loops: Pt[][], p0: Pt, p1: Pt, maxLen: number): Pt[] | null {
  const arcs = bothBoundaryArcs(loops, p0, p1)
  if (!arcs) return null
  const lenF = polylineLength(arcs.forward)
  const lenB = polylineLength(arcs.backward)
  // 3. Length budget (on the shorter arc, as before).
  if (Math.min(lenF, lenB) > maxLen) return null
  return lenF <= lenB ? arcs.forward : arcs.backward
}

/**
 * BOTH boundary arcs between p0 and p1 on their shared wall, ordered SHORTER-FIRST (ties ->
 * forward first, matching boundaryArcBetween's shorter pick). Returns [] when the two points
 * do not share a loop. NO length filter: the caller applies whatever budget each candidate
 * warrants. Used by the B8 rung-(b)(1) route-around (processFeature): when the DIRECT
 * (shorter) boundary arc would slot uncut, the OTHER arc -- e.g. the far side of an island --
 * is a distinct still-at-depth candidate, gated by the same material-safety check. The
 * Both directions are returned intentionally. The caller must select only the arc whose travel
 * keeps material on the side required by the active climb/conventional mode. A through-cleared
 * chord is a reposition, not a wall-follow, and is classified separately by processFeature.
 */
export function boundaryArcsBetween(loops: Pt[][], p0: Pt, p1: Pt): Pt[][] {
  const arcs = bothBoundaryArcs(loops, p0, p1)
  if (!arcs) return []
  const lenF = polylineLength(arcs.forward)
  const lenB = polylineLength(arcs.backward)
  return lenF <= lenB ? [arcs.forward, arcs.backward] : [arcs.backward, arcs.forward]
}

/** Shared core: build BOTH boundary arcs (forward + backward through the loop vertices)
 *  between p0 and p1 on their nearest shared loop, or null when they project onto different
 *  loops (not a shared wall). Each arc STARTS at the literal p0 and ENDS at the literal p1. */
function bothBoundaryArcs(loops: Pt[][], p0: Pt, p1: Pt): { forward: Pt[]; backward: Pt[] } | null {
  if (loops.length === 0) return null

  // 1. Nearest loop for each endpoint.
  let best0 = { loopIndex: -1, segIndex: 0, distSq: Infinity }
  let best1 = { loopIndex: -1, segIndex: 0, distSq: Infinity }
  for (let li = 0; li < loops.length; li++) {
    const loop = loops[li]
    if (loop.length < 3) continue
    const pr0 = projectOntoLoop(p0, loop)
    if (pr0.distSq < best0.distSq) best0 = { loopIndex: li, segIndex: pr0.segIndex, distSq: pr0.distSq }
    const pr1 = projectOntoLoop(p1, loop)
    if (pr1.distSq < best1.distSq) best1 = { loopIndex: li, segIndex: pr1.segIndex, distSq: pr1.distSq }
  }
  if (best0.loopIndex < 0 || best1.loopIndex < 0) return null
  // Not a shared wall: the two points project closest onto different loops.
  if (best0.loopIndex !== best1.loopIndex) return null

  const loop = loops[best0.loopIndex]
  const n = loop.length

  // 2. Build both arcs between the two projections, riding the boundary vertices.
  // Forward arc: p0 -> end-vertices of segments segIndex0 .. (segIndex1 - 1) -> p1.
  // (The "end vertex" of segment si is loop[si % n]; the walk wraps mod n. When the two
  // projections share a segment we still cover both winding directions below.)
  const si0 = best0.segIndex
  const si1 = best1.segIndex

  const buildArc = (startSeg: number, endSeg: number): Pt[] => {
    const arc: Pt[] = [{ x: p0.x, y: p0.y }]
    // Append end-vertices of segments startSeg, startSeg+1, ... up to but not including
    // endSeg, wrapping mod n. Bounded by n+1 so a malformed index can never spin forever.
    let si = startSeg
    for (let guard = 0; guard < n + 1; guard++) {
      if (si === endSeg) break
      arc.push({ x: loop[si % n].x, y: loop[si % n].y })
      si = (si + 1) % n
    }
    arc.push({ x: p1.x, y: p1.y })
    return arc
  }

  // The forward direction walks segments si0 -> si1; the backward direction walks si1 -> si0
  // (with the roles of p0/p1 reversed), then we reverse it so it still starts at p0.
  const forward = buildArc(si0, si1)
  const backward = (() => {
    // backward = p1 -> end-vertices si1 .. (si0 - 1) -> p0, then reversed to start at p0.
    const arc: Pt[] = [{ x: p1.x, y: p1.y }]
    let si = si1
    for (let guard = 0; guard < n + 1; guard++) {
      if (si === si0) break
      arc.push({ x: loop[si % n].x, y: loop[si % n].y })
      si = (si + 1) % n
    }
    arc.push({ x: p0.x, y: p0.y })
    arc.reverse()
    return arc
  })()

  return { forward, backward }
}
