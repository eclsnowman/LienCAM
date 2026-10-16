import type { BoreWorkerPayload } from './types'
import type { MoveRole, ToolpathMove } from '../../types'
import { resolveFeedrates } from './feedrates'
import { fitCircle } from './geometry'
import { orderHoleLikePoints } from './holeOrder'
import { generateHelixArcs } from './threadHelix'
import { resolveHeights } from './heights'
import { directionForTool } from '../tool/cutHand'
import { loopWindingFor } from './millingDirection'
import { operatorLoopRef, type OperatorLoop } from './toolFluteReach'
import {
  assertInternalCircleEnvelopeInside,
  internalCircleCenterRadius,
  resolveInternalCircleTargetDiameter,
} from './cutterEnvelope'

type Pt = { x: number; y: number }

interface BoreRecord extends Pt {
  loopId: string
  /** How messages name this hole to the operator; never the loop id. */
  label: string
  diameter: number
  selectedDiameter: number
  circularityErr: number
}

interface CircleFit {
  cx: number
  cy: number
  diameter: number
  circularityErr: number
}

const EPS = 1e-6

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

function rapidTo(moves: ToolpathMove[], point: Pt, z: number): void {
  moves.push({ type: 'rapid', x: point.x, y: point.y, z, role: 'rapid' })
}

function plungeAt(moves: ToolpathMove[], point: Pt, z: number, feed: number): void {
  moves.push({ type: 'feed', x: point.x, y: point.y, z, feed, role: 'plunge' })
}

function rapidEntryAt(
  moves: ToolpathMove[],
  point: Pt,
  feedZ: number,
  clearanceZ: number,
  retractZ: number,
): void {
  rapidTo(moves, point, clearanceZ)
  rapidTo(moves, point, retractZ)
  rapidTo(moves, point, feedZ)
}

function isEndMillType(toolType: string | undefined): boolean {
  return toolType === 'flat_end_mill' || toolType === 'bull_nose'
}

function uniqueOpenPoints(points: Pt[]): Pt[] {
  if (points.length < 2) return points
  const first = points[0]
  const last = points[points.length - 1]
  if (Math.hypot(last.x - first.x, last.y - first.y) < 1e-7) {
    return points.slice(0, -1)
  }
  return points
}

function fitCircularLoop(loop: OperatorLoop & { points: Pt[] }): CircleFit {
  const label = operatorLoopRef(loop)
  const points = uniqueOpenPoints(loop.points)
  if (points.length < 8) {
    throw new Error(`Bore: ${label} is not a sampled circle. Select circular hole loops or a 3D cylindrical bore face.`)
  }

  const fit = fitCircle(points)
  if (!(fit.radius > EPS)) {
    throw new Error(`Bore: ${label} has no usable diameter.`)
  }

  const diameter = fit.radius * 2
  const radialTol = Math.max(0.05, diameter * 0.025)

  if (!(fit.residual <= radialTol)) {
    throw new Error(
      `Bore: ${label} is not round enough for circular bore milling. ` +
      'Use a circular loop or pick a 3D cylindrical bore face.'
    )
  }

  return { cx: fit.center.x, cy: fit.center.y, diameter, circularityErr: fit.residual }
}

function buildRings(maxRadius: number, radialStep: number): number[] {
  if (maxRadius <= EPS) return []
  const step = Math.max(0.01, radialStep)
  const rings: number[] = []
  let r = Math.min(step, maxRadius)
  while (r < maxRadius - 0.001) {
    rings.push(r)
    r += step
  }
  if (rings.length === 0 || Math.abs(rings[rings.length - 1] - maxRadius) > 0.001) {
    rings.push(maxRadius)
  }
  return rings
}

// The bore wall surrounds the orbit, so the one milling-direction rule
// (./millingDirection, WO-1896) makes climb counter-clockwise for an M3 spindle.
function orbitIsCCW(direction: 'climb' | 'conventional'): boolean {
  return loopWindingFor(direction, false) === 'ccw'
}

function arcTypeForDirection(direction: 'climb' | 'conventional'): 'arc_cw' | 'arc_ccw' {
  return orbitIsCCW(direction) ? 'arc_ccw' : 'arc_cw'
}

function dirSignForDirection(direction: 'climb' | 'conventional'): 1 | -1 {
  // generateHelixArcs uses +1 = CCW, -1 = CW.
  return orbitIsCCW(direction) ? 1 : -1
}

function circleStart(c: Pt, radius: number): Pt {
  return pointOnCircle(c, radius, 0)
}

function pointOnCircle(c: Pt, radius: number, angle: number): Pt {
  return { x: c.x + radius * Math.cos(angle), y: c.y + radius * Math.sin(angle) }
}

function angleFromLast(moves: ToolpathMove[], c: Pt, fallback = 0): number {
  const last = moves[moves.length - 1]
  if (!last) return fallback
  const dx = last.x - c.x
  const dy = last.y - c.y
  if (Math.hypot(dx, dy) <= EPS) return fallback
  return Math.atan2(dy, dx)
}

function cutCircle(
  moves: ToolpathMove[],
  c: Pt,
  radius: number,
  z: number,
  direction: 'climb' | 'conventional',
  feed: number,
  role: MoveRole,
  overlapMm = 0,
): void {
  if (radius <= EPS) return
  const type = arcTypeForDirection(direction)
  const startAngle = angleFromLast(moves, c)
  const sign = dirSignForDirection(direction)
  const mid = pointOnCircle(c, radius, startAngle + sign * Math.PI)
  const end = pointOnCircle(c, radius, startAngle + sign * Math.PI * 2)
  moves.push({ type, x: mid.x, y: mid.y, z, cx: c.x, cy: c.y, feed, role })
  moves.push({ type, x: end.x, y: end.y, z, cx: c.x, cy: c.y, feed, role })
  if (overlapMm > EPS) {
    const maxAngle = Math.PI * 1.5
    const angle = Math.min(maxAngle, overlapMm / radius)
    const overlap = pointOnCircle(c, radius, startAngle + sign * (Math.PI * 2 + angle))
    moves.push({
      type,
      x: overlap.x,
      y: overlap.y,
      z,
      cx: c.x,
      cy: c.y,
      feed,
      role,
    })
  }
}

// Below this orbit radius the tool center has nowhere left to orbit (the tool
// nearly fills the hole); helical entry has no room and a plunge is the only
// option.
const MIN_HELIX_ORBIT_RADIUS_MM = 0.05

function enterDepth(
  moves: ToolpathMove[],
  c: Pt,
  currentZ: number,
  targetZ: number,
  orbitRadius: number,
  direction: 'climb' | 'conventional',
  rampAngleDeg: number,
  rampRate: number,
  plungeRate: number,
  fastTraverseRate: number,
  entryType: string,
  notify: (message: string) => void,
): void {
  if (currentZ <= targetZ + EPS) return

  const startAngle = angleFromLast(moves, c)
  if (entryType === 'ramp_helical' && orbitRadius > MIN_HELIX_ORBIT_RADIUS_MM) {
    const tanAngle = Math.tan(Math.max(0.25, rampAngleDeg) * Math.PI / 180)
    // No pitch floor beyond keeping it strictly positive: the authored ramp
    // angle and the orbit circumference are what set the pitch. EPS only
    // guards the division-by-zero/negative case generateHelixArcs rejects;
    // it never overrides the angle the operator asked for.
    const pitch = Math.max(EPS, 2 * Math.PI * orbitRadius * tanAngle)
    // WO-2039: the helix goes out as helical arcs (G2/G3 with Z), not as the
    // ~0.01 mm chords a small orbit samples into - 38,744 of them for one bore,
    // which ran at the board's move rate instead of the programmed feed.
    const helix = generateHelixArcs({
      cx: c.x,
      cy: c.y,
      radius: orbitRadius,
      pitch,
      bottomZ: targetZ,
      topZ: currentZ,
      dir: dirSignForDirection(direction),
      descend: true,
      feed: rampRate,
      role: 'helix',
      startAngle,
    })
    moves.push(...helix)
    return
  }

  if (entryType === 'ramp_helical') {
    console.log(
      `Bore: orbit radius ${orbitRadius.toFixed(3)} mm is at or below the ` +
      `${MIN_HELIX_ORBIT_RADIUS_MM} mm helix threshold - using a straight plunge entry.`
    )
    notify(
      `the tool has no room to orbit for a helical entry (orbit radius ${MIN_HELIX_ORBIT_RADIUS_MM} mm ` +
      'or less), so a straight plunge was used instead.',
    )
  }

  void fastTraverseRate
  plungeAt(moves, pointOnCircle(c, orbitRadius, startAngle), targetZ, plungeRate)
}

function retractFromLast(moves: ToolpathMove[], retractZ: number, clearanceZ: number): void {
  const last = moves[moves.length - 1]
  if (!last) return
  rapidTo(moves, { x: last.x, y: last.y }, retractZ)
  rapidTo(moves, { x: last.x, y: last.y }, clearanceZ)
}

export function buildBoreToolpath(
  payload: BoreWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
  notify?: (message: string) => void,
): ToolpathMove[] {
  const { params, heights, tool, loops, wcsOrigin, feedrateOverride, boreBottoms } = payload
  // WO-1540: one notice per distinct fact, however many orbits and depths repeat it.
  const notices = new Set<string>()
  const note = (message: string) => { notices.add(message) }
  const plannerDirection = directionForTool(params.direction, tool)
  const { clearanceZ, retractZ, feedZ, topZ, bottomZ } = resolveHeights(heights, wcsOrigin)
  const { feedRate, plungeRate, rampRate, fastTraverseRate, finishRate } = resolveFeedrates(tool, feedrateOverride)

  if (!isEndMillType(tool.type)) {
    throw new Error('Bore: use a flat or bull-nose end mill. Drill bits, V-bits, and ball mills are not valid bore milling tools.')
  }

  const selectedLoops = params.loopIds.length === 0
    ? loops.filter(l => l.closed)
    : loops.filter(l => params.loopIds.includes(l.id))

  if (selectedLoops.length === 0) {
    if (params.loopIds.length > 0 && loops.length > 0) {
      throw new Error(
        'Bore: the selected bore loop(s) no longer exist - the geometry was re-derived. ' +
        'Open the operation, re-select the circular loops or cylinder faces, and recompute.'
      )
    }
    throw new Error('Bore: no circular bore loop found. Select circular loops or pick 3D cylindrical bore faces in the Geometry tab.')
  }

  const records: BoreRecord[] = selectedLoops.map(loop => {
    const fit = fitCircularLoop(loop)
    // The Geometry list shows an unnamed bore loop by its diameter.
    const label = operatorLoopRef(loop, `the ${fit.diameter.toFixed(3)} mm hole`)
    const targetDiameter = resolveInternalCircleTargetDiameter({
      operation: 'Bore',
      loopId: loop.id,
      loop: label,
      selectedDiameter: fit.diameter,
      targetDiameter: params.targetDiameter,
    })
    return {
      loopId: loop.id,
      label,
      x: fit.cx,
      y: fit.cy,
      diameter: targetDiameter,
      selectedDiameter: fit.diameter,
      circularityErr: fit.circularityErr,
    }
  })

  const ordered = orderHoleLikePoints(records, params.sortStrategy)
  const moves: ToolpathMove[] = []
  const requestedRadialStep = payload.passes.stepover || tool.diameter * 0.35
  const radialStep = Math.max(0.01, Math.min(tool.diameter * 0.8, requestedRadialStep))
  const stockToLeave = Math.max(0, payload.passes.stockToLeave ?? 0)
  const finishPasses = Math.max(0, Math.round(payload.passes.finishPasses ?? 0))
  const springPasses = Math.max(0, Math.round(payload.passes.springPasses ?? 0))
  const overlapMm = Math.max(0, payload.passes.overlapMm ?? 0)

  interface OrbitPlan {
    radius: number
    kind: 'rough' | 'finish'
  }

  for (let i = 0; i < ordered.length; i++) {
    const rec = ordered[i]
    const center = { x: rec.x, y: rec.y }
    const mappedBottom = boreBottoms?.[rec.loopId]
    if (boreBottoms !== undefined && mappedBottom == null) {
      console.warn(`bore: boreBottoms has no entry for loop "${rec.loopId}" - using op-level bottom height`)
      note(`${rec.label[0].toUpperCase()}${rec.label.slice(1)} has no bore bottom of its own, so the operation's bottom height was used.`)
    }
    const boreBottomZ = mappedBottom != null ? mappedBottom + wcsOrigin.z : bottomZ
    if (topZ <= boreBottomZ + EPS) {
      throw new Error(`Bore: top of cut must be above bottom of cut for ${rec.label}.`)
    }

    const finalRadius = internalCircleCenterRadius({
      operation: 'Bore',
      loopId: rec.loopId,
      loop: rec.label,
      targetDiameter: rec.diameter,
      toolDiameter: tool.diameter,
      minRadialClearance: 0.025,
    })
    assertInternalCircleEnvelopeInside({
      operation: 'Bore',
      loopId: rec.loopId,
      loop: rec.label,
      centerRadius: finalRadius,
      toolDiameter: tool.diameter,
      boundaryDiameter: rec.selectedDiameter,
    })
    const roughMaxRadius = Math.max(0, finalRadius - stockToLeave)
    const rings = buildRings(roughMaxRadius, radialStep)
    const depths = buildDepths(topZ, boreBottomZ, payload.passes.stepdown)

    const orbitPlans: OrbitPlan[] = rings.map(radius => ({ radius, kind: 'rough' }))
    const hasFinishOrSpring = finishPasses > 0 || springPasses > 0
    if (orbitPlans.length === 0 && !hasFinishOrSpring) {
      throw new Error(
        `Bore: stock to leave ${stockToLeave.toFixed(3)} mm leaves no valid roughing orbit for ${rec.label}. ` +
        'Reduce stock to leave or enable a finish pass.'
      )
    }
    if (finalRadius > EPS && hasFinishOrSpring) {
      orbitPlans.push({ radius: finalRadius, kind: 'finish' })
    }

    for (let p = 0; p < orbitPlans.length; p++) {
      const plan = orbitPlans[p]
      const start = circleStart(center, plan.radius)
      rapidEntryAt(moves, start, feedZ, clearanceZ, retractZ)

      let currentZ = feedZ
      if (currentZ > topZ + EPS) {
        plungeAt(moves, start, topZ, plungeRate)
        currentZ = topZ
      }

      for (let d = 0; d < depths.length; d++) {
        const depth = depths[d]
        enterDepth(
          moves,
          center,
          currentZ,
          depth,
          plan.radius,
          plannerDirection,
          payload.linking.rampAngle,
          rampRate,
          plungeRate,
          fastTraverseRate,
          payload.linking.entryType,
          note,
        )
        currentZ = depth

        if (plan.kind === 'rough') {
          cutCircle(moves, center, plan.radius, depth, plannerDirection, feedRate, 'cut', overlapMm)
        } else {
          const repeats = Math.max(1, finishPasses + springPasses)
          const role: MoveRole = finishPasses + springPasses > 0 ? 'finish' : 'cut'
          const feed = role === 'finish' ? finishRate : feedRate
          for (let n = 0; n < repeats; n++) {
            cutCircle(moves, center, plan.radius, depth, plannerDirection, feed, role, overlapMm)
          }
        }

        onProgress?.(
          (i + (p + (d + 1) / depths.length) / Math.max(1, orbitPlans.length)) / ordered.length,
          ordered.length > 1 ? `Bore ${i + 1}/${ordered.length}` : undefined,
        )
      }

      retractFromLast(moves, retractZ, clearanceZ)
    }
  }

  for (const message of notices) notify?.(message)
  return moves
}
