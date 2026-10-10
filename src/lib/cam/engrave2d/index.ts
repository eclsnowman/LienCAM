// Engrave / Trace 2D toolpath builder.
//
// Rides the tool centre along selected curves at a constant depth. Unlike the
// other 2D operations (which only consume closed loops), this one is built to
// follow OPEN curves — text outlines, scribe lines, logos — and optionally
// closed loops too. Two modes share one toolpath core:
//   - 'trace'   : any tool, ride the line (or an offset of it)
//   - 'engrave' : V/chamfer bit; cut depth may be derived from a target line
//                 width via the tool tip angle (depth = w / (2·tanHalf)).
//
// Constant depth below a flat plane, or (WO-1969) constant depth below the
// part's surface when the store hands over a sampled surface (surfaceFollow.ts).
// True variable-depth V-carving (medial-axis v-carving) is the 'vcarve' op.
//
// Reuses: resolveHeights, resolveFeedrates, the moves/ entry+retract helpers,
// the geometry offset + arc-sampling primitives, and the chamfer V-bit math.

import type { ToolpathMove, EngraveWorkerPayload, LoopData } from '../types'
import type { Vec2 } from '../../../types'
import { resolveHeights } from '../heights'
import { resolveFeedrates } from '../feedrates'
import { rapidEntry, rapidEntryAt, plungeTo, retractFrom, helixDescent, helixFits } from '../moves'
import { offsetOpenChain, offsetPolygon, sampleArc, signedArea, toolHalfAngleRad } from '../geometry'
import { directionForTool } from '../../tool/cutHand'
import { rideSurface, type EngraveSurfaceFollowParams, type SurfaceRidePoint } from './surfaceFollow'
import {
  buildOpenTrochoid,
  buildTrochoid,
  closedLength,
  openLength,
  orbitSenseFor,
  resolveTrochoidalGeometry,
  type Trochoid,
} from '../trochoidal2d'

/** Local copy of contour2d's private depth-list helper: steps from topZ down to
 *  bottomZ in <= stepdown increments, always ending exactly at bottomZ. */
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

function unit(dx: number, dy: number): Vec2 {
  const m = Math.hypot(dx, dy) || 1
  return { x: dx / m, y: dy / m }
}

/**
 * Tangential quarter-circle lead arc of radius R.
 *  - mode 'in' : returns points running start .. just-before `p`, arriving at
 *    `p` tangent to `dir` (the curve start direction).
 *  - mode 'out': returns points running just-after `p` .. end, departing `p`
 *    tangent to `dir` (the curve end direction).
 * The arc is laid on the left side of the travel direction (consistent choice;
 * surface scribing has no material constraint that forces a side).
 */
function leadArc(p: Vec2, dir: Vec2, R: number, tol: number, mode: 'in' | 'out'): Vec2[] {
  const nL = { x: -dir.y, y: dir.x }          // left normal of travel
  const C  = { x: p.x + R * nL.x, y: p.y + R * nL.y }
  const aP = Math.atan2(p.y - C.y, p.x - C.x)
  const ct = tol > 0 ? Math.min(tol, R * 0.5) : 0.01
  if (mode === 'in') {
    // start (aP − 90°) .. just before p; sampleArc excludes the end angle.
    return sampleArc(C, R, aP - Math.PI / 2, aP, 'CCW', ct)
  }
  // p .. just before (aP + 90°); drop the first sample (== p, already emitted).
  return sampleArc(C, R, aP, aP + Math.PI / 2, 'CCW', ct).slice(1)
}

/** A curve paired with the cut orientation the orderer chose for it. Open
 *  strokes may be reversed when their far end is nearer the tool; closed loops
 *  never are (their travel direction is fixed later by winding). */
interface OrderedCurve {
  curve: LoopData
  reverse: boolean
}

/** Enter/exit points of a curve under a chosen cut orientation. Closed loops
 *  always start and finish at points[0]; an open curve's ends swap on reverse. */
function curveLimits(c: LoopData, reverse: boolean): { enter: Vec2; exit: Vec2 } {
  if (c.closed) return { enter: c.points[0], exit: c.points[0] }
  if (reverse) return { enter: c.points[c.points.length - 1], exit: c.points[0] }
  return { enter: c.points[0], exit: c.points[c.points.length - 1] }
}

/** Today's ordering: first curve as drawn, then nearest START point (strictly
 *  closer wins). Kept verbatim so the reversal path can be compared against it. */
function orderNoReverse(curves: LoopData[]): OrderedCurve[] {
  if (curves.length <= 1) return curves.map(curve => ({ curve, reverse: false }))
  const remaining = [...curves]
  const out: OrderedCurve[] = [{ curve: remaining.shift() as LoopData, reverse: false }]
  while (remaining.length) {
    const end = curveLimits(out[out.length - 1].curve, false).exit
    let bi = 0, bd = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const s = remaining[i].points[0]
      const d = (s.x - end.x) ** 2 + (s.y - end.y) ** 2
      if (d < bd) { bd = d; bi = i }
    }
    out.push({ curve: remaining.splice(bi, 1)[0], reverse: false })
  }
  return out
}

/** Planned rapid travel between consecutive curves (entry/exit XY only). */
function orderTravel(order: OrderedCurve[]): number {
  let total = 0
  for (let i = 1; i < order.length; i++) {
    const from = curveLimits(order[i - 1].curve, order[i - 1].reverse).exit
    const to   = curveLimits(order[i].curve, order[i].reverse).enter
    total += Math.hypot(to.x - from.x, to.y - from.y)
  }
  return total
}

/**
 * Greedy nearest-endpoint ordering to trim rapids between separate curves.
 * An OPEN stroke may be entered from either end, whichever is nearer the tool;
 * closed loops keep their source direction. When `reverseOpen` is false the
 * legacy start-only ordering is used unchanged (the negative control). The
 * reversal result is accepted only when it does not plan MORE travel than the
 * legacy order, so the chosen order never has more travel than today's.
 */
function orderCurves(curves: LoopData[], reverseOpen: boolean): OrderedCurve[] {
  const legacy = orderNoReverse(curves)
  if (!reverseOpen || curves.length <= 1) return legacy

  const remaining = curves.slice(1)
  const out: OrderedCurve[] = [{ curve: curves[0], reverse: false }]
  while (remaining.length) {
    const end = curveLimits(out[out.length - 1].curve, out[out.length - 1].reverse).exit
    let bi = 0, br = false, bd = Infinity
    for (let i = 0; i < remaining.length; i++) {
      const c = remaining[i]
      for (const reverse of c.closed ? [false] : [false, true]) {
        const s = curveLimits(c, reverse).enter
        const d = (s.x - end.x) ** 2 + (s.y - end.y) ** 2
        if (d < bd) { bd = d; bi = i; br = reverse }
      }
    }
    out.push({ curve: remaining.splice(bi, 1)[0], reverse: br })
  }
  return orderTravel(out) < orderTravel(legacy) ? out : legacy
}

export function buildEngraveToolpath(
  payload: EngraveWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
  ordering?: { reverseOpen?: boolean },
  /** Operator console channel (WO-1540), when the caller has one. */
  notify?: (message: string) => void,
): ToolpathMove[] {
  const { params, heights, passes, linking, tool, loops, wcsOrigin } = payload
  const moves: ToolpathMove[] = []
  const plannerDirection = params.direction === 'as_drawn'
    ? 'as_drawn'
    : directionForTool(params.direction, tool)

  const { clearanceZ, retractZ, feedZ, topZ, bottomZ } = resolveHeights(heights, wcsOrigin)
  const { feedRate, plungeRate, rampRate, leadInRate, leadOutRate } = resolveFeedrates(tool, payload.feedrateOverride)

  // Axial offset shifts the cut plane in Z (negative drives a V-tip into the surface).
  const axial   = params.axialOffset || 0
  const topCut  = topZ + axial
  let   bottomCut = bottomZ + axial

  // V-engrave: derive depth from the desired surface line width when requested.
  if (params.mode === 'engrave' && params.useWidthForDepth && tool.angleFromAxisDeg && tool.angleFromAxisDeg > 0) {
    // angleFromAxisDeg is already the per-side half-angle; toolHalfAngleRad deg2rads it.
    const tanHalf = Math.tan(toolHalfAngleRad(tool.angleFromAxisDeg))
    if (tanHalf > 1e-9 && params.targetLineWidth > 0) {
      // depth below the top plane that produces targetLineWidth at the surface.
      bottomCut = topCut - params.targetLineWidth / (2 * tanHalf)
    }
  }

  // WO-1969: surface following. The store sampled the part's top surface under
  // the paths; every pass rides it at a depth BELOW the surface instead of a
  // fixed Z, so the passes are offsets from the surface, not planes.
  const surface = (params as typeof params & EngraveSurfaceFollowParams).surfaceFollow
  const depths = surface
    ? buildDepths(0, -surface.depthMm, passes.stepdown)
    : buildDepths(topCut, bottomCut, passes.stepdown)
  let heldSurfaceZ = surface?.maxZ ?? 0
  const tol    = params.tolerance && params.tolerance > 0 ? params.tolerance : 0.01
  const leadR  = linking.leadInRadius  || 0
  const leadOR = linking.leadOutRadius || 0

  // Select target curves: open and/or closed per params, restricted to loopIds
  // when provided. Paths with < 2 points are unusable.
  const sel = loops.filter(l => {
    if (l.points.length < 2) return false
    if (params.loopIds.length > 0 && !params.loopIds.includes(l.id)) return false
    return (l.closed && params.includeClosed) || (!l.closed && params.includeOpen)
  })

  // WO-2299: Style Trochoidal replaces how a Trace on the line cuts each curve:
  // a slot wider than the tool, centred on it, in overlapping orbits. Other
  // modes and sides keep today's pass. A curve too short for one orbit is cut
  // Plain and the console says so.
  const trochoidal = params.engraveStyle === 'trochoidal' && params.mode === 'trace' && params.side === 'center'
    ? resolveTrochoidalGeometry(tool.diameter, params.trochoidalWidth, params.trochoidalAdvance)
    : null
  // Orbit sense (../trochoidal2d): climb -> CCW in Y-up. 'As drawn' sets only the
  // travel order, so its orbits turn the climb way for this tool's cut hand.
  const orbitSense = orbitSenseFor(plannerDirection === 'as_drawn' ? directionForTool('climb', tool) : plannerDirection)
  const helixEntry = !!trochoidal && linking.entryType === 'ramp_linear' && helixFits(trochoidal.orbitRadius)
  const tanAngle = Math.tan(Math.max(0.5, Math.min(linking.rampAngle ?? 3, 30)) * Math.PI / 180)

  const ordered = orderCurves(sel, ordering?.reverseOpen !== false)
  const total   = ordered.length || 1
  let   done    = 0

  for (const item of ordered) {
    const curve = item.curve
    let pts: Vec2[] = curve.points.map(p => ({ x: p.x, y: p.y }))

    // Open strokes may be entered from either end; the orderer picked the end
    // nearer the tool. Reverse before any winding/offset work.
    const openReversed = item.reverse && !curve.closed
    if (openReversed) pts = pts.reverse()

    // Closed-loop travel direction from winding; open curves keep source order.
    if (curve.closed && plannerDirection !== 'as_drawn') {
      const isCCW   = signedArea(pts) > 0
      const wantCCW = plannerDirection === 'conventional'
      if (isCCW !== wantCCW) pts = pts.reverse()
    }

    if (trochoidal) {
      const orbit = planTrochoidalSlot(pts, curve.closed, trochoidal, tool.diameter, orbitSense)
      if (orbit) {
        heldSurfaceZ = emitTrochoidalSlot(moves, orbit, pts[0], {
          depths, closed: curve.closed, helix: helixEntry, orbitRadius: trochoidal.orbitRadius,
          sense: orbitSense, tanAngle, surface, heldSurfaceZ,
          feedZ, retractZ, clearanceZ, feedRate, plungeRate, rampRate,
        })
        done++
        onProgress?.(done / total, total > 1 ? `Engrave ${done}/${total}` : undefined)
        continue
      }
      const line = `Engrave: curve "${curve.id}" was cut Plain - it is too short for one trochoidal orbit.`
      if (notify) notify(line)
      else console.info(line)
    }

    // Sideways compensation (computed offset path; never G41/G42 in the post).
    if (params.side !== 'center' && params.sideOffset > 0) {
      // offsetOpenChain offsets relative to travel direction, so a reversed open
      // stroke must flip the sign to stay on the same physical side as drawn.
      const sideSign = params.side === 'left' ? 1 : -1
      const signed = openReversed ? -sideSign * params.sideOffset : sideSign * params.sideOffset
      pts = curve.closed
        ? (offsetPolygon(pts, signed, 4) ?? pts)
        : offsetOpenChain(pts, signed, 4)
      if (pts.length < 2) { done++; onProgress?.(done / total); continue }
    }

    // Optional tangential lead arcs. 'in' arrives at pts[0]; 'out' departs the end.
    const last      = pts[pts.length - 1]
    const leadInPts = leadR  > 0 ? leadArc(pts[0], unit(pts[1].x - pts[0].x, pts[1].y - pts[0].y), leadR, tol, 'in') : []
    const leadOutPts = leadOR > 0
      ? leadArc(last, unit(last.x - pts[pts.length - 2].x, last.y - pts[pts.length - 2].y), leadOR, tol, 'out')
      : []
    const entryPt = leadInPts.length ? leadInPts[0] : pts[0]

    for (let di = 0; di < depths.length; di++) {
      const depth = depths[di]

      if (surface) {
        const targets: SurfaceRidePoint[] = [
          ...leadInPts.map(p => ({ p, role: 'lead_in' as const, feed: leadInRate })),
          ...pts.map(p => ({ p, role: 'cut' as const, feed: feedRate })),
          ...(curve.closed ? [{ p: pts[0], role: 'cut' as const, feed: feedRate }] : []),
          ...leadOutPts.map(p => ({ p, role: 'lead_out' as const, feed: leadOutRate })),
        ]
        const ride = rideSurface(surface, entryPt, targets, depth, heldSurfaceZ)
        heldSurfaceZ = ride.lastSurfaceZ
        rapidEntry(moves, [entryPt], feedZ, retractZ, clearanceZ)
        plungeTo(moves, [entryPt], 0, ride.entryZ, plungeRate)
        for (const move of ride.moves) moves.push(move)
        retractFrom(moves, retractZ, clearanceZ)
        continue
      }

      // Position above the entry point (lift + re-enter between depth passes).
      rapidEntry(moves, [entryPt], feedZ, retractZ, clearanceZ)
      plungeTo(moves, [entryPt], 0, depth, plungeRate)

      // Lead-in arc into the curve start.
      for (const p of leadInPts) moves.push({ type: 'feed', x: p.x, y: p.y, z: depth, feed: leadInRate, role: 'lead_in' })

      // Ride the curve.
      for (const p of pts) moves.push({ type: 'feed', x: p.x, y: p.y, z: depth, feed: feedRate, role: 'cut' })
      if (curve.closed) moves.push({ type: 'feed', x: pts[0].x, y: pts[0].y, z: depth, feed: feedRate, role: 'cut' })

      // Lead-out arc away from the curve end.
      for (const p of leadOutPts) moves.push({ type: 'feed', x: p.x, y: p.y, z: depth, feed: leadOutRate, role: 'lead_out' })

      retractFrom(moves, retractZ, clearanceZ)
    }

    done++
    onProgress?.(done / total, total > 1 ? `Engrave ${done}/${total}` : undefined)
  }

  onProgress?.(1)
  return moves
}

// -- Trochoidal slot (WO-2299) ------------------------------------------------

/**
 * The orbit for one curve's slot: the curve itself is the guide (open or closed,
 * ../trochoidal2d), already in its cut direction. Returns null for a curve shorter
 * than one orbit's advance - the caller cuts it Plain.
 */
function planTrochoidalSlot(
  pts: Vec2[],
  closed: boolean,
  geo: { advance: number; orbitRadius: number },
  toolDiameter: number,
  sense: 1 | -1,
): Trochoid | null {
  const length = closed ? closedLength(pts) : openLength(pts)
  if (!(length >= geo.advance)) return null
  const opts = { orbitRadius: geo.orbitRadius, advance: geo.advance, toolDiameter, sense }
  return closed ? buildTrochoid(pts, opts) : buildOpenTrochoid(pts, opts)
}

interface TrochoidalSlotArgs {
  depths: number[]
  closed: boolean
  /** Descend by a helix on the orbit circle instead of plunging. */
  helix: boolean
  orbitRadius: number
  sense: 1 | -1
  tanAngle: number
  surface: EngraveSurfaceFollowParams['surfaceFollow']
  heldSurfaceZ: number
  feedZ: number
  retractZ: number
  clearanceZ: number
  feedRate: number
  plungeRate: number
  rampRate: number
}

/**
 * Emit one curve's slot at every level; returns the surface height held at its
 * end (surface following). Every level enters at the orbit's first point, inside
 * the start bore. Plunge re-enters there each level and retracts after it, as a
 * Plain pass does. Helix descends on the orbit circle around the curve's first
 * point at the ramp angle, a whole number of turns so it ends where the orbit
 * starts; a closed slot returns there and stays down for the next level, an open
 * one retracts from its end, re-enters at the start down the bore the level above
 * cut, and helixes on from there. A surface-following slot rides the orbit points
 * at the depth below the surface, as Plain rides its curve.
 */
function emitTrochoidalSlot(moves: ToolpathMove[], orbit: Trochoid, centre: Vec2, a: TrochoidalSlotArgs): number {
  const start = orbit.points[0]
  const R = a.orbitRadius
  let held = a.heldSurfaceZ
  let z = a.feedZ
  for (let di = 0; di < a.depths.length; di++) {
    const depth = a.depths[di]
    const isLast = di === a.depths.length - 1

    if (a.surface) {
      const targets: SurfaceRidePoint[] = orbit.points.slice(1).map(p => ({ p, role: 'cut' as const, feed: a.feedRate }))
      const ride = rideSurface(a.surface, start, targets, depth, held)
      held = ride.lastSurfaceZ
      rapidEntryAt(moves, start, a.feedZ, a.retractZ, a.clearanceZ)
      moves.push({ type: 'feed', x: start.x, y: start.y, z: ride.entryZ, feed: a.plungeRate, role: 'plunge' })
      for (const move of ride.moves) moves.push(move)
      retractFrom(moves, a.retractZ, a.clearanceZ)
      continue
    }

    if (a.helix) {
      if (di === 0 || !a.closed) {
        rapidEntryAt(moves, start, a.feedZ, a.retractZ, a.clearanceZ)
        z = a.feedZ
        if (di > 0) {
          // Down the bore the level above already cut, to where material starts.
          z = a.depths[di - 1]
          moves.push({ type: 'feed', x: start.x, y: start.y, z, feed: a.plungeRate, role: 'plunge' })
        }
      }
      const drop = z - depth
      if (drop > 1e-9) {
        const turns = Math.max(1, Math.ceil(drop / (2 * Math.PI * R * a.tanAngle)))
        helixDescent(moves, {
          centre, radius: R, fromZ: z, toZ: depth,
          tanAngle: drop / (turns * 2 * Math.PI * R), feed: a.rampRate,
          startAngle: 0, direction: a.sense,
        })
        // A whole number of turns ends on the orbit's first point; pin it there exactly.
        const last = moves[moves.length - 1]
        last.x = start.x
        last.y = start.y
      }
    } else {
      rapidEntryAt(moves, start, a.feedZ, a.retractZ, a.clearanceZ)
      moves.push({ type: 'feed', x: start.x, y: start.y, z: depth, feed: a.plungeRate, role: 'plunge' })
    }

    for (let i = 1; i < orbit.points.length; i++) {
      const p = orbit.points[i]
      moves.push({ type: 'feed', x: p.x, y: p.y, z: depth, feed: a.feedRate, role: 'cut' })
    }
    z = depth
    if (!a.helix || !a.closed || isLast) retractFrom(moves, a.retractZ, a.clearanceZ)
  }
  return held
}
