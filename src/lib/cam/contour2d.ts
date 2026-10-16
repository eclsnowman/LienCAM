// 2D Contour toolpath generator.
//
// All Z values are WORLD coordinates (WCS origin added by caller before reaching here).
//
// Climb/conventional (CW spindle default) follow the one rule in
// ./millingDirection (WO-1896): climb keeps the material on the cutter's right.
//   outer + climb        → CW  offset  (part on the right)
//   outer + conventional → CCW offset
//   inner + climb        → CCW offset  (wall material on the right)
//   inner + conventional → CW  offset
// Open chains: travel runs so the chain (the part) is on the required side.
//
// Pass strategy:
//   ramp_linear: continuous descent — ramp feeds into depth[0], cuts loop, ramps
//     to depth[1], cuts loop … no inter-pass retracts; tool stays engaged.
//   plunge: retract to retractZ between every depth pass.
//
//   Roughing (stockToLeave > 0): rough path at ALL depths; then bridge directly
//     into the finish path at final depth via a lofted spiral (no retract/re-entry).
//   overlapMm: finishing loops extend this many mm past their start to prevent witness marks.

import {
  offsetOpenChain,
  offsetPolygon,
  pruneSelfIntersections,
  signedArea,
  ensureCCW,
} from './geometry'
import { offsetLoop } from './face2d/clipperOffset'
import { resolveHeights } from './heights'
import { resolveFeedrates } from './feedrates'
import { assertToolFluteReach, operatorLoopRef, operatorLoopTarget, type OperatorLoop } from './toolFluteReach'
import { directionForTool } from '../tool/cutHand'
import { loopWindingFor, materialSideFor } from './millingDirection'
import {
  DEFAULT_CONTOUR_TABS,
  type ToolpathMove,
  type ContourParams,
  type ContourWorkerPayload,
  type LoopData,
} from './types'
import type { ToolCutHand, Vec2 } from '../../types'
import {
  rapidEntry,
  rapidEntryAt,
  plungeTo,
  rampTo,
  rampDescent,
  cutLoop,
  cutLoopWithOverlap,
  retractFrom,
  helixDescent,
  helixFits,
} from './moves'
import {
  buildTrochoid,
  closedLength,
  nearestGuideDistance,
  orbitSenseFor,
  reseamClosed,
  resolveTrochoidalGeometry,
  trochoidalGuideOffset,
  TROCHOIDAL_ALLOWANCE_FRACTION,
  type Trochoid,
} from './trochoidal2d'
import type { ToolReachInputs } from './holderClearanceGate'
import { applyRestAir2d } from './restAir2d'
import { appendCornerRelief, type CornerReliefGroup } from './cornerRelief2d'

const OPEN_EPS = 1e-8
const OPEN_OUTSIDE_EPS = 1e-4

type OpenStockBounds = NonNullable<ContourWorkerPayload['stockBounds']>

function finitePoint(p: Vec2): boolean {
  return Number.isFinite(p.x) && Number.isFinite(p.y)
}

function cleanOpenChain(points: Vec2[], context: string): Vec2[] {
  const clean: Vec2[] = []
  for (const point of points) {
    if (!finitePoint(point)) {
      throw new Error(`Open contour: ${context} contains a non-finite point.`)
    }
    const previous = clean[clean.length - 1]
    if (!previous || Math.hypot(point.x - previous.x, point.y - previous.y) > OPEN_EPS) {
      clean.push({ x: point.x, y: point.y })
    }
  }
  const length = clean.slice(1).reduce(
    (sum, point, index) =>
      sum + Math.hypot(point.x - clean[index].x, point.y - clean[index].y),
    0,
  )
  if (clean.length < 2 || length <= OPEN_EPS) {
    throw new Error(`Open contour: ${context} has fewer than two usable points.`)
  }
  return clean
}

function requireOpenStockBounds(
  stockBounds: ContourWorkerPayload['stockBounds'],
): OpenStockBounds {
  if (!stockBounds) {
    throw new Error(
      'Open contour: active stock XY bounds are required for safe stock-edge entry and exit.',
    )
  }
  const values = [
    stockBounds.min.x, stockBounds.min.y, stockBounds.max.x, stockBounds.max.y,
  ]
  if (
    values.some(value => !Number.isFinite(value)) ||
    stockBounds.max.x <= stockBounds.min.x ||
    stockBounds.max.y <= stockBounds.min.y
  ) {
    throw new Error(
      'Open contour: active stock XY bounds are invalid; expected finite positive X/Y extents.',
    )
  }
  return stockBounds
}

function unitDirection(from: Vec2, to: Vec2, context: string): Vec2 {
  const dx = to.x - from.x
  const dy = to.y - from.y
  const length = Math.hypot(dx, dy)
  if (length <= OPEN_EPS) {
    throw new Error(`Open contour: ${context} has no usable tangent direction.`)
  }
  return { x: dx / length, y: dy / length }
}

/**
 * Continue an endpoint tangent until the cutter center is beyond the stock AABB
 * expanded by its radius. For an endpoint already outside that expanded box,
 * only a tangent that stays on an outward/parallel half-plane is accepted.
 */
function tangentPointOutsideStock(
  point: Vec2,
  direction: Vec2,
  stockBounds: OpenStockBounds,
  toolRadius: number,
  context: string,
): Vec2 {
  const clearance = toolRadius + OPEN_OUTSIDE_EPS
  const minX = stockBounds.min.x - clearance
  const minY = stockBounds.min.y - clearance
  const maxX = stockBounds.max.x + clearance
  const maxY = stockBounds.max.y + clearance
  const insideExpanded =
    point.x >= minX && point.x <= maxX && point.y >= minY && point.y <= maxY

  if (!insideExpanded) {
    const staysOutside =
      (point.x < minX && direction.x <= OPEN_EPS) ||
      (point.x > maxX && direction.x >= -OPEN_EPS) ||
      (point.y < minY && direction.y <= OPEN_EPS) ||
      (point.y > maxY && direction.y >= -OPEN_EPS)
    if (!staysOutside) {
      throw new Error(
        `Open contour: ${context} tangent points back through the stock; no safe outside lead fits.`,
      )
    }
    const leadLength = Math.max(toolRadius, 0.1)
    return {
      x: point.x + direction.x * leadLength,
      y: point.y + direction.y * leadLength,
    }
  }

  const distances: number[] = []
  if (direction.x > OPEN_EPS) distances.push((maxX - point.x) / direction.x)
  if (direction.x < -OPEN_EPS) distances.push((minX - point.x) / direction.x)
  if (direction.y > OPEN_EPS) distances.push((maxY - point.y) / direction.y)
  if (direction.y < -OPEN_EPS) distances.push((minY - point.y) / direction.y)
  const exitDistance = distances
    .filter(distance => Number.isFinite(distance) && distance >= -OPEN_EPS)
    .sort((a, b) => a - b)[0]
  if (exitDistance === undefined) {
    throw new Error(`Open contour: ${context} tangent cannot reach a stock edge safely.`)
  }
  const beyond = Math.max(0, exitDistance) + OPEN_OUTSIDE_EPS
  return {
    x: point.x + direction.x * beyond,
    y: point.y + direction.y * beyond,
  }
}

interface OpenPathPlan {
  path: Vec2[]
  entry: Vec2
  exit: Vec2
}

function buildOpenPathPlan(
  sourcePath: Vec2[],
  offsetDistance: number,
  reverseTravel: boolean,
  stockBounds: OpenStockBounds,
  toolRadius: number,
  context: string,
): OpenPathPlan {
  const offset = pruneSelfIntersections(offsetOpenChain(sourcePath, offsetDistance))
  const usable = cleanOpenChain(offset, `${context} offset`)
  const path = reverseTravel ? [...usable].reverse() : usable
  const startOut = unitDirection(path[1], path[0], `${context} entry`)
  const endOut = unitDirection(path[path.length - 2], path[path.length - 1], `${context} exit`)
  return {
    path,
    entry: tangentPointOutsideStock(path[0], startOut, stockBounds, toolRadius, `${context} entry`),
    exit: tangentPointOutsideStock(
      path[path.length - 1], endOut, stockBounds, toolRadius, `${context} exit`,
    ),
  }
}

function emitOpenPass(
  moves: ToolpathMove[],
  plan: OpenPathPlan,
  depth: number,
  feedZ: number,
  retractZ: number,
  clearanceZ: number,
  feedRate: number,
  plungeRate: number,
  leadInRate: number,
  leadOutRate: number,
): void {
  rapidEntryAt(moves, plan.entry, feedZ, retractZ, clearanceZ)
  moves.push({
    type: 'feed', x: plan.entry.x, y: plan.entry.y, z: depth,
    feed: plungeRate, role: 'plunge',
  })
  moves.push({
    type: 'feed', x: plan.path[0].x, y: plan.path[0].y, z: depth,
    feed: leadInRate, role: 'lead_in',
  })
  // lead_in already lands on path[0]; begin cutting at the next vertex so the
  // toolpath does not carry a cosmetic zero-length cut at the same coordinate.
  for (const point of plan.path.slice(1)) {
    moves.push({
      type: 'feed', x: point.x, y: point.y, z: depth,
      feed: feedRate, role: 'cut',
    })
  }
  moves.push({
    type: 'feed', x: plan.exit.x, y: plan.exit.y, z: depth,
    feed: leadOutRate, role: 'lead_out',
  })
  retractFrom(moves, retractZ, clearanceZ)
}

function buildOpenContourToolpath(
  payload: ContourWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
): ToolpathMove[] {
  const {
    params, heights, passes, tool, loops, wcsOrigin, loopBottoms,
  } = payload
  const plannerDirection = directionForTool(params.direction, tool)
  if (payload.linking.entryType !== 'plunge') {
    throw new Error(
      `Open contour: entry type "${payload.linking.entryType}" is not supported. ` +
      'Choose Plunge in the Linking tab and recompute.',
    )
  }
  if (params.tabs) {
    throw new Error('Open contour: holding tabs are not supported on open chains.')
  }
  const openSide = params.openSide ?? 'right'
  if (openSide !== 'left' && openSide !== 'right') {
    throw new Error('Open contour: cutter side must be left or right.')
  }
  const stockBounds = requireOpenStockBounds(payload.stockBounds)
  const selectedIds = params.loopIds ?? []
  const targetLoops: LoopData[] = selectedIds.length > 0
    ? selectedIds.map(id => {
        const loop = loops.find(candidate => candidate.id === id)
        if (!loop) {
          throw new Error(
            'Open contour: a selected chain no longer exists. Re-select it and recompute.',
          )
        }
        if (loop.closed) {
          throw new Error(
            'Open contour: the selection includes a closed or mixed profile. Select only open chains.',
          )
        }
        return loop
      })
    : loops.filter(loop => !loop.closed)
  if (targetLoops.length === 0) {
    throw new Error('Open contour: no open chain found to cut. Select an open chain.')
  }

  const moves: ToolpathMove[] = []
  const toolRadius = tool.diameter / 2
  if (!Number.isFinite(toolRadius) || toolRadius <= 0) {
    throw new Error('Open contour: tool diameter must be a finite value greater than 0 mm.')
  }
  const {
    feedRate, plungeRate, leadInRate, leadOutRate,
  } = resolveFeedrates(tool, payload.feedrateOverride)
  const {
    clearanceZ, retractZ, feedZ, topZ, bottomZ: rawBottomZ,
  } = resolveHeights(heights, wcsOrigin)
  const axialStock = Math.max(0, passes.floorStockToLeave ?? 0)
  const stockToLeave = Math.max(0, passes.stockToLeave)
  const hasRoughing = stockToLeave > 0
  const doFinish = passes.finishPasses > 0
  if (!hasRoughing && !doFinish) {
    throw new Error(
      'Open contour: no cutting mode selected. Enable roughing, a finish pass, or both.',
    )
  }

  const resolvedLoopBottoms = new Map<string, number>()
  for (const loop of targetLoops) {
    const loopBottom = loopBottoms?.[loop.id]
    const loopRawBottom = loopBottom != null ? loopBottom + wcsOrigin.z : rawBottomZ
    // A roughing-only contour intentionally stops above the nominal floor by
    // floorStockToLeave. Reach must follow the deepest move we will actually
    // emit, while any enabled finish pass still reaches the nominal floor.
    const loopDeepestCut = doFinish ? loopRawBottom : loopRawBottom + axialStock
    assertToolFluteReach({
      operation: 'Open Contour',
      topZ,
      bottomZ: loopDeepestCut,
      fluteLength: tool.fluteLength,
      target: operatorLoopTarget(loop, 'chain'),
    })
    resolvedLoopBottoms.set(loop.id, loopRawBottom)
  }

  const sideSign = openSide === 'right' ? 1 : -1
  // Walking the chain in its drawn order with the cutter on its right leaves
  // the chain (the part) on the cutter's left, and vice versa.
  const forwardMaterialSide = openSide === 'right' ? 'left' : 'right'
  const reverseTravel = forwardMaterialSide !== materialSideFor(plannerDirection)

  let completed = 0
  for (const loop of targetLoops) {
    const chain = operatorLoopRef(loop, 'a selected chain', 'chain')
    const source = cleanOpenChain(loop.points, chain)
    const bottomZ = resolvedLoopBottoms.get(loop.id) ?? rawBottomZ
    const roughBottomZ = bottomZ + axialStock
    const depths = buildDepths(topZ, bottomZ, passes.stepdown)
    const roughDepths = axialStock > 0
      ? buildDepths(topZ, roughBottomZ, passes.stepdown)
      : depths
    const finalDepth = depths[depths.length - 1]
    const finishMode = params.contourFinishMode ?? 'final'
    const finishDepths = hasRoughing
      ? (finishMode === 'each_stepdown' ? depths : [finalDepth])
      : depths
    const roughPlan = hasRoughing
      ? buildOpenPathPlan(
          source,
          sideSign * (toolRadius + stockToLeave),
          reverseTravel,
          stockBounds,
          toolRadius,
          `${chain} rough path`,
        )
      : null
    const finishPlan = doFinish
      ? buildOpenPathPlan(
          source,
          sideSign * toolRadius,
          reverseTravel,
          stockBounds,
          toolRadius,
          `${chain} finish path`,
        )
      : null

    if (roughPlan) {
      for (const depth of roughDepths) {
        emitOpenPass(
          moves, roughPlan, depth, feedZ, retractZ, clearanceZ,
          feedRate, plungeRate, leadInRate, leadOutRate,
        )
      }
    }
    if (finishPlan) {
      for (const depth of finishDepths) {
        for (let repeat = 0; repeat < passes.finishPasses; repeat++) {
          emitOpenPass(
            moves, finishPlan, depth, feedZ, retractZ, clearanceZ,
            feedRate, plungeRate, leadInRate, leadOutRate,
          )
        }
        if (depth === finalDepth) {
          for (let repeat = 0; repeat < passes.springPasses; repeat++) {
            emitOpenPass(
              moves, finishPlan, depth, feedZ, retractZ, clearanceZ,
              feedRate, plungeRate, leadInRate, leadOutRate,
            )
          }
        }
      }
    }

    completed++
    onProgress?.(
      completed / targetLoops.length,
      targetLoops.length > 1 ? `Open contour ${completed}/${targetLoops.length}` : undefined,
    )
  }
  // WO-1888: see the closed-contour return. Same call, same stock source.
  return applyRestAir2d(
    'Open contour', moves, tool, (payload as ToolReachInputs).remainingStock, retractZ,
  )
}

/**
 * Which loop ids a contour's saved params should actually carry: a
 * higher-precedence machining-boundary source (a bound model edge chain or a
 * picked face - both outrank loop ids and fold into `modelReferences` ahead
 * of them, see NewOperationModalBody's `contourModelReferences`) means any
 * saved loop-id selection belongs to a source this operation no longer uses.
 * Persisting it anyway leaves `targetLoops` below to filter the NEW
 * boundary's freshly-derived loops against an id from the OLD, superseded
 * one - a genuine mismatch this function correctly refuses (loop ids are
 * minted fresh on every geometry re-derive), even though the new boundary is
 * completely valid on its own.
 */
export function contourLoopIdsForSave(
  loopIds: string[],
  hasSupersedingBoundary: boolean,
): string[] {
  return hasSupersedingBoundary ? [] : loopIds
}

export function buildContourToolpath(
  payload: ContourWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
  /** Operator console channel (WO-1540), when the caller has one. */
  notify?: (message: string) => void,
): ToolpathMove[] {
  if ((payload.params.pathType ?? 'closed') === 'open') {
    return buildOpenContourToolpath(payload, onProgress)
  }
  const {
    params, heights, passes, linking, tool, loops, wcsOrigin, loopBottoms, stockBottomZ,
  } = payload
  const plannerDirection = directionForTool(params.direction, tool)
  const moves: ToolpathMove[] = []

  const toolRadius = tool.diameter / 2
  const { feedRate, plungeRate, rampRate, leadInRate } = resolveFeedrates(
    tool, payload.feedrateOverride,
  )

  const { clearanceZ, retractZ, feedZ, topZ, bottomZ: rawBottomZ } = resolveHeights(heights, wcsOrigin)

  // Axial (floor) stock to leave: the floor analog of the radial passes.stockToLeave.
  // Roughing stops `axialStock` mm ABOVE the true bottom (rough floor = bottomZ + axial),
  // exactly the way radial stock keeps the roughing offset `stockToLeave` mm off the wall.
  // The finish pass (when present) descends to the true bottom and removes it; "roughing
  // only" leaves the floor stock and stops. axialStock = 0 -> roughDepths is built with the
  // SAME args as depths, so the emitted path is byte-identical to the prior behavior.
  const axialStock = Math.max(0, passes.floorStockToLeave ?? 0)
  // Shared (op-wide) bottom + depth schedule. This is the fallback every loop uses
  // unless loopBottoms gives it its own Z (per-loop multi-Z, below), and it backs
  // the legacy zero-pass guard. When loopBottoms is absent the per-loop recompute
  // reproduces these EXACT arrays, so output stays byte-identical.
  const sharedBottomZ = rawBottomZ
  const sharedDepths  = buildDepths(topZ, sharedBottomZ, passes.stepdown)

  const isOuter     = params.side === 'outer'
  // Offsets come back CCW (ensureCCW below); reverse when the rule wants CW.
  const needsReverse = loopWindingFor(plannerDirection, isOuter) === 'cw'

  // ADR 0003: fail loud on an orphaned selection (loop ids are regenerated on
  // every geometry re-derive) instead of silently emitting nothing.
  const closedLoops = loops.filter(l => l.closed)
  const targetLoops: LoopData[] = params.loopIds.length > 0
    ? closedLoops.filter(l => params.loopIds.includes(l.id))
    : closedLoops

  if (targetLoops.length === 0) {
    if (params.loopIds.length > 0 && closedLoops.length > 0) {
      throw new Error(
        'Contour: the selected loop(s) no longer exist - the geometry was re-derived ' +
        '(re-import / sketch edit / projection-tolerance change regenerates loop ids). ' +
        'Open the operation, re-select the loop in the Geometry tab, and recompute.'
      )
    }
    throw new Error('Contour: no closed loop found to cut. Select a closed contour in the Geometry tab.')
  }
  // Legacy single-bottom guard: only governs the shared-bottom path. With
  // per-loop loopBottoms, an individual zero-depth loop (a boss top picked at
  // its own Z) is skipped below instead of killing the whole op.
  if (!loopBottoms && sharedDepths.length === 0) {
    throw new Error('Contour: stepdown resolves to zero passes (check stepdown and the top/bottom heights).')
  }

  // ADR 0003: a contour with no cutting mode (roughing off AND finish off:
  // stockToLeave == 0 and finishPasses == 0) would silently emit zero moves
  // with status "ready". Fail loud with an actionable fix instead.
  const opStockToLeave = Math.max(0, passes.stockToLeave)
  const opHasRoughing  = opStockToLeave > 0
  const opDoFinish     = passes.finishPasses > 0
  if (!opHasRoughing && !opDoFinish) {
    throw new Error('Contour: no cutting mode selected. Enable roughing (stock to leave > 0), a finish pass, or both, in the Passes tab.')
  }

  const resolvedLoopBottoms = new Map<string, number>()
  for (const loop of targetLoops) {
    const loopBottom = loopBottoms?.[loop.id]
    const loopRawBottom = loopBottom != null ? loopBottom + wcsOrigin.z : rawBottomZ
    // Roughing-only paths stop at the intentional floor allowance; a finish
    // path reaches the nominal bottom. Validate the deepest emitted cut, not a
    // deeper plane which this operation will never command.
    const loopDeepestCut = opDoFinish ? loopRawBottom : loopRawBottom + axialStock
    assertToolFluteReach({
      operation: 'Contour',
      topZ,
      bottomZ: loopDeepestCut,
      fluteLength: tool.fluteLength,
      target: operatorLoopTarget(loop),
    })
    resolvedLoopBottoms.set(loop.id, loopRawBottom)
  }
  const tabSettings = resolveContourTabs(
    params,
    linking.entryType,
    topZ,
    stockBottomZ,
    wcsOrigin.z,
    opDoFinish,
  )

  const isRamp    = linking.entryType === 'ramp_linear'
  const rampAngle = Math.max(0.5, Math.min(linking.rampAngle ?? 3, 30))
  const tanAngle  = Math.tan(rampAngle * Math.PI / 180)
  const overlapMm = Math.max(0, passes.overlapMm ?? 0)

  // WO-2289: Roughing style Trochoidal replaces only how the rough pass is traced
  // at a level. A loop it cannot fit is roughed with Offset and the console says so.
  const trochoidalRequested = params.roughingStyle === 'trochoidal' && opHasRoughing
  const sayOffsetFallback = (loop: OperatorLoop) => {
    const line = `Contour: ${operatorLoopRef(loop)} was roughed with Offset - the trochoidal channel does not fit it. ` +
      'Narrow the Channel width to rough it in orbits.'
    if (notify) notify(line)
    else console.info(line)
  }

  // WO-2287: each loop's corners are relieved at that loop's own levels, after the
  // whole main path. An outside contour clears outside the part, an inside one inside.
  const reliefGroups: CornerReliefGroup[] = []

  let completedLoops = 0
  for (const loop of targetLoops) {
    // Progress checkpoint: count at the top so skipped (degenerate) loops still
    // advance the fraction to 1.0 (coarse — per loop).
    completedLoops++
    onProgress?.(completedLoops / targetLoops.length,
      targetLoops.length > 1 ? `Contour ${completedLoops}/${targetLoops.length}` : undefined)

    // Per-loop bottom-of-cut: a loop with its own loopBottoms entry descends to
    // ITS level (multiple picked boss tops each cut to their own height); every
    // other loop uses the shared op bottom (rawBottomZ) -> byte-identical legacy.
    // loopBottoms is WCS-relative (mirrors drill's holeBottoms); convert to the
    // machine-absolute frame by adding wcsOrigin.z before the shared reach
    // preflight, exactly as drill2d.ts does for per-hole bottoms.
    const bottomZ      = resolvedLoopBottoms.get(loop.id) ?? rawBottomZ
    const roughBottomZ = bottomZ + axialStock
    const depths       = buildDepths(topZ, bottomZ, passes.stepdown)
    const roughDepths  = axialStock > 0 ? buildDepths(topZ, roughBottomZ, passes.stepdown) : depths
    // A zero-depth loop (loop bottom == top, e.g. a boss top picked at its own Z)
    // contributes no cut; skip it gracefully rather than throwing the whole op.
    if (depths.length === 0) continue
    reliefGroups.push({
      loops: [{ points: loop.points, clearedInside: !isOuter }],
      levels: opDoFinish ? depths : roughDepths,
    })
    if (tabSettings && bottomZ > tabSettings.stockBottomZ + 1e-6) {
      throw new Error(
        `Contour tabs: ${operatorLoopRef(loop)} is not a cut-through contour. ` +
        `Bottom of cut ${bottomZ.toFixed(3)} mm does not reach stock bottom ` +
        `${tabSettings.stockBottomZ.toFixed(3)} mm.`,
      )
    }

    const rawPts = loop.points

    const stockToLeave = Math.max(0, passes.stockToLeave)
    const hasRoughing  = stockToLeave > 0

    const roughDist  = isOuter ? +(toolRadius + stockToLeave) : -(toolRadius + stockToLeave)
    const finishDist = isOuter ? +toolRadius : -toolRadius

    // Offset via the robust Clipper2 offsetter (same one face2d uses), NOT the
    // hand-rolled miter offset: clipper trims the COLLINEAR self-overlap that a
    // parallel-wall square tab/notch produces on an outer offset (the bug this
    // replaces), removes spikes, and splits a pinched part into clean separate
    // loops. roughDist/finishDist are already signed (+ outer / - inner); the
    // probe confirmed clipper grows on +delta and shrinks on -delta for CCW input,
    // so the sign is passed straight through (no negation).
    //
    // minArea: a tiny absolute epsilon (0.01 mm^2) drops only numerically-
    // degenerate near-zero-area loops while preserving every real region —
    // material safety means we never aggressively drop a genuine sub-loop.
    const MIN_LOOP_AREA = 0.01
    const roughLoops  = hasRoughing ? offsetLoop(rawPts, roughDist, MIN_LOOP_AREA) : []
    const finishLoops = offsetLoop(rawPts, finishDist, MIN_LOOP_AREA)

    const applyDir = (pts: Vec2[]) => {
      const ccw = ensureCCW(pts as Array<{ x: number; y: number }>)
      return needsReverse ? [...ccw].reverse() : ccw
    }

    const finalDepth = depths[depths.length - 1]
    const doFinish = passes.finishPasses > 0

    // contourFinishMode (mirrors ACParams.wallFinishMode):
    //   'final'        — finish once at full depth (default; byte-identical to prior behavior)
    //   'each_stepdown'— finish at every depth level
    // Only meaningful when roughing is on; the no-roughing branch always finishes
    // at every depth.
    const finishMode = params.contourFinishMode ?? 'final'
    const finishDepths = hasRoughing
      ? (finishMode === 'each_stepdown' ? depths : [finalDepth])
      : depths

    // ── Multi-region branch ─────────────────────────────────────────────────
    // A large stockToLeave / finish offset can pinch the part into 2+ disjoint
    // regions (clipper's offsetLoop returns >1 sub-loop). Single-region stays on
    // the original byte-identical path below.
    if (tabSettings && finishLoops.length !== 1) {
      throw new Error(
        `Contour tabs: ${operatorLoopRef(loop)} must resolve to one closed finish contour; ` +
        `the offset produced ${finishLoops.length} regions.`,
      )
    }
    if (finishLoops.length === 0 && roughLoops.length === 0) continue   // degenerate
    if (roughLoops.length > 1 || finishLoops.length > 1) {
      if (trochoidalRequested) sayOffsetFallback(loop)
      emitMultiRegion({
        moves,
        roughLoops, finishLoops, applyDir,
        hasRoughing, doFinish, isRamp,
        depths: roughDepths, finishDepths, finalDepth,
        feedZ, retractZ, clearanceZ,
        feedRate, plungeRate, rampRate, leadInRate,
        tanAngle, overlapMm,
        finishPasses: passes.finishPasses,
        springPasses: passes.springPasses,
      })
      continue
    }

    const roughPoly  = roughLoops.length === 1 ? roughLoops[0] : null
    const finishPoly = finishLoops.length === 1 ? finishLoops[0] : undefined
    if (!finishPoly) continue

    const roughPath  = roughPoly ? applyDir(roughPoly) : null
    const finishPath = applyDir(finishPoly)
    // User-placed tab centers for THIS loop (fractions of the finish-contour
    // perimeter). Absent/empty -> evenly spaced (byte-identical legacy plan).
    const customTabFractions = params.tabLocations?.[loop.id]
    const tabPlan = tabSettings
      ? buildContourTabPlan(
          finishPath,
          tabSettings,
          customTabFractions && customTabFractions.length > 0 ? customTabFractions : undefined,
        )
      : null
    const trochoid = trochoidalRequested && roughPath
      ? planTrochoidalRough(rawPts, isOuter, applyDir, tool.diameter, stockToLeave, params,
          plannerDirection, roughPath, tabPlan)
      : null
    if (trochoidalRequested && roughPath && !trochoid) sayOffsetFallback(loop)

    // ── Roughing passes ────────────────────────────────────────────────────
    // After the last depth we leave the tool AT depth so we can bridge
    // smoothly into the finishing path with a Bézier arc.
    let roughEndIdx = 0   // index in roughPath where the tool ends after roughing

    if (hasRoughing && roughPath) {
      if (trochoid) {
        emitTrochoidalRough(moves, trochoid, {
          depths: roughDepths, isRamp, stayDown: doFinish && !tabPlan,
          tabTopZ: tabPlan ? tabPlan.tabTopZ : null,
          feedZ, retractZ, clearanceZ, feedRate, plungeRate, rampRate, tanAngle,
        })
        if (doFinish && !tabPlan) {
          // Step from the orbit seam onto the Offset rough path's seam (inside the
          // cleared channel), so the bridge below is exactly Offset's own.
          const z = moves[moves.length - 1].z
          moves.push({ type: 'feed', x: roughPath[0].x, y: roughPath[0].y, z, feed: leadInRate, role: 'lead_in' })
        }
        roughEndIdx = 0
      } else if (isRamp) {
        rapidEntry(moves, roughPath, feedZ, retractZ, clearanceZ)
        let curZ   = feedZ
        let curIdx = 0
        for (const depth of roughDepths) {
          curIdx = rampTo(moves, roughPath, curIdx, curZ, depth, tanAngle, rampRate)
          curZ   = depth
          curIdx = cutLoop(moves, roughPath, curIdx, depth, feedRate)
        }
        roughEndIdx = curIdx
        if (!doFinish || tabPlan) retractFrom(moves, retractZ, clearanceZ)
        // else: stay at depth — bridge is emitted below

      } else {
        // Plunge per depth — only retract between intermediate depths
        for (let di = 0; di < roughDepths.length; di++) {
          const depth  = roughDepths[di]
          const isLast = di === roughDepths.length - 1
          rapidEntry(moves, roughPath, feedZ, retractZ, clearanceZ)
          plungeTo(moves, roughPath, 0, depth, plungeRate, 'plunge')
          cutLoop(moves, roughPath, 0, depth, feedRate)
          if (!isLast || !doFinish || tabPlan) {
            retractFrom(moves, retractZ, clearanceZ)
          }
          // Last depth + finishing: tool stays at depth, bridge emitted below
        }
        roughEndIdx = 0  // plunge always cuts from/to index 0
      }
    }

    // ── Finishing passes ───────────────────────────────────────────────────
    // finishMode / finishDepths resolved above (shared with the multi-region branch).
    if (doFinish) {
      if (tabPlan) {
        // Plunge entry requires a fresh entry per depth (unchanged legacy
        // behavior). Ramp entry rapids to the seam ONCE, on the FIRST depth;
        // every depth (first and subsequent) then runs a CLAMPED ramp descent
        // from wherever the tool currently sits (the seam, or the cursor the
        // previous depth's last pass left it at) down to this depth's floor --
        // never refusing for a tab in the way: the tool rides up and over any
        // tab that blocks it (at full retained height) and the ramp's own
        // descent progress simply pauses until it clears, however many laps
        // that takes (clampedRampDescent). Roughing retracts above instead of
        // lofting into the finish path so the bridge cannot cross a tab at
        // full depth. Every finish and spring repeat uses the same geometric
        // tab intervals, so no later pass silently removes them.
        let prevDepth = feedZ
        let prevCursor = 0
        for (let di = 0; di < finishDepths.length; di++) {
          const depth = finishDepths[di]
          const isFirstDepth = di === 0
          const isLastDepth = di === finishDepths.length - 1
          let cursor: number
          if (isRamp) {
            if (isFirstDepth) {
              rapidEntryAt(moves, tabPlan.path[0], feedZ, retractZ, clearanceZ)
            }
            cursor = clampedRampDescent(
              moves, tabPlan, prevCursor, prevDepth, depth, tanAngle, rampRate, feedRate, plungeRate,
            )
          } else {
            // Enter at the PLAN's seam, not the raw finish path's: a custom
            // seam-spanning tab re-seams plan.path so path[0] always sits in a
            // tab-free gap. Without custom tabs plan.path IS finishPath (same
            // reference), so this is byte-identical to the legacy entry.
            rapidEntry(moves, tabPlan.path, feedZ, retractZ, clearanceZ)
            plungeTo(moves, tabPlan.path, 0, depth, leadInRate, 'lead_in')
            cursor = 0
          }
          // Seam overlap exists to blend the closure mark before a RETRACT
          // (tool deflection at the seam). Plunge retracts after every depth,
          // so every plunge pass keeps the legacy per-pass overlap unchanged.
          // Ramp only retracts once, after the very last cutting pass of the
          // very last depth -- every other ramp pass (all intermediate-depth
          // passes, and every non-final pass at the final depth) is immediately
          // followed by more cutting, not a retract, so it closes EXACT
          // (overlap 0) and lets the next stepdown ramp's forward travel
          // smooth the seam instead. This also means the cursor for an
          // intermediate depth's transition never drifts from that depth's
          // entry position.
          const hasSpring = depth === finalDepth && passes.springPasses > 0
          for (let fp = 0; fp < passes.finishPasses; fp++) {
            const isVeryLastPass = isRamp && isLastDepth && !hasSpring && fp === passes.finishPasses - 1
            const passOverlap = isRamp ? (isVeryLastPass ? overlapMm : 0) : overlapMm
            cursor = cutLoopWithTabs(
              moves, tabPlan, cursor, depth, feedRate, plungeRate, passOverlap,
            )
          }
          if (depth === finalDepth) {
            for (let sp = 0; sp < passes.springPasses; sp++) {
              const isVeryLastPass = isRamp && isLastDepth && sp === passes.springPasses - 1
              const passOverlap = isRamp ? (isVeryLastPass ? overlapMm : 0) : overlapMm
              cursor = cutLoopWithTabs(
                moves, tabPlan, cursor, depth, feedRate, plungeRate, passOverlap,
              )
            }
          }
          // Plunge re-enters every depth, so it must also retract every depth
          // (byte-identical legacy). Ramp stays engaged between depths and
          // only retracts once, after the final depth's passes.
          if (!isRamp || isLastDepth) {
            retractFrom(moves, retractZ, clearanceZ)
          }
          prevDepth = depth
          prevCursor = cursor
        }
      } else if (isRamp && !hasRoughing) {
        // Continuous ramp descent — no roughing
        rapidEntry(moves, finishPath, feedZ, retractZ, clearanceZ)
        let curZ   = feedZ
        let curIdx = 0
        for (const depth of finishDepths) {
          curIdx = rampTo(moves, finishPath, curIdx, curZ, depth, tanAngle, rampRate)
          curZ   = depth
          for (let fp = 0; fp < passes.finishPasses; fp++) {
            curIdx = cutLoopWithOverlap(moves, finishPath, curIdx, depth, feedRate, overlapMm)
          }
        }
        for (let sp = 0; sp < passes.springPasses; sp++) {
          curIdx = cutLoopWithOverlap(moves, finishPath, curIdx, finalDepth, feedRate, overlapMm)
        }
        retractFrom(moves, retractZ, clearanceZ)

      } else if (hasRoughing && roughPath) {
        // Final depth FIRST: bridge from roughing end into finishing — lofted
        // spiral, no retract. loftBridge requires the tool to still be sitting at
        // roughPath[roughEndIdx] at depth (the roughing branch left it there), so
        // this must run before any intermediate-depth finishing (which retracts).
        // Lead-in length ≈ 2× tool diameter so the blend has enough distance to be gradual.
        const leadInLengthMm = Math.max(tool.diameter * 2, 8)
        let curIdx = loftBridge(
          moves,
          roughPath, roughEndIdx,
          finishPath,
          finalDepth, leadInRate, leadInLengthMm
        )
        for (let fp = 0; fp < passes.finishPasses; fp++) {
          curIdx = cutLoopWithOverlap(moves, finishPath, curIdx, finalDepth, feedRate, overlapMm)
        }
        for (let sp = 0; sp < passes.springPasses; sp++) {
          curIdx = cutLoopWithOverlap(moves, finishPath, curIdx, finalDepth, feedRate, overlapMm)
        }
        retractFrom(moves, retractZ, clearanceZ)

        // each_stepdown: finish the intermediate depths too, each via a fresh
        // rapid+plunge entry. For 'final' mode finishDepths is [finalDepth] only,
        // so this loop runs zero times and the emitted path above is byte-identical
        // to the prior behavior.
        for (const depth of finishDepths) {
          if (depth === finalDepth) continue
          rapidEntry(moves, finishPath, feedZ, retractZ, clearanceZ)
          plungeTo(moves, finishPath, 0, depth, leadInRate, 'lead_in')
          let idx = 0
          for (let fp = 0; fp < passes.finishPasses; fp++) {
            idx = cutLoopWithOverlap(moves, finishPath, idx, depth, feedRate, overlapMm)
          }
          retractFrom(moves, retractZ, clearanceZ)
        }

      } else {
        // No roughing, plunge entry at each depth
        for (const depth of finishDepths) {
          rapidEntry(moves, finishPath, feedZ, retractZ, clearanceZ)
          plungeTo(moves, finishPath, 0, depth, leadInRate, 'lead_in')
          let curIdx = 0
          for (let fp = 0; fp < passes.finishPasses; fp++) {
            curIdx = cutLoopWithOverlap(moves, finishPath, curIdx, depth, feedRate, overlapMm)
          }
          if (depth === finalDepth) {
            for (let sp = 0; sp < passes.springPasses; sp++) {
              curIdx = cutLoopWithOverlap(moves, finishPath, curIdx, depth, feedRate, overlapMm)
            }
          }
          retractFrom(moves, retractZ, clearanceZ)
        }
      }
    }
  }

  // WO-1888: last, on the finished path, so every depth pass, roughing bridge
  // and finish pass is planned exactly as it always was and only the ones the
  // earlier operations already emptied are dropped. Nothing happens without a
  // remaining stock on the request, so a first operation is byte-identical.
  appendCornerRelief(moves, params, toolRadius, opStockToLeave, reliefGroups,
    { feedZ, retractZ, clearanceZ, feedRate, plungeRate, direction: plannerDirection })

  return applyRestAir2d('Contour', moves, tool, (payload as ToolReachInputs).remainingStock, retractZ)
}

// -- Trochoidal roughing (WO-2289) ---------------------------------------------

interface TrochoidalRoughPlan {
  orbit: Trochoid
  /** Orbit centre at the seam: where every level enters. */
  seam: Vec2
  orbitRadius: number
  sense: 1 | -1
  guideLength: number
  /** Guide arc spans (start, length) whose orbits ride at the tab top below it. */
  tabSpans: Array<{ start: number; length: number }>
}

/**
 * Plan one loop's trochoidal rough pass: the guide, computed once at
 * guideOffset = S + W/2 + 0.01 D from the design boundary (./trochoidal2d), and
 * the orbit around it. Tabs fragment the GUIDE before any orbit exists: each tab
 * interval of the finish plan is projected onto the guide and widened by what an
 * orbit reaches past its centre (R, one chord, the allowance); orbits centred in a
 * span ride at the tab top. The seam sits mid-way through the widest tab-free gap,
 * or, with no tabs, beside the Offset rough path's seam so the roughing->finish
 * bridge stays Offset's own. Returns null when the channel does not fit the loop
 * (no single guide loop, or tabs leave no gap) - the caller roughs it with Offset.
 */
function planTrochoidalRough(
  rawPts: Vec2[],
  isOuter: boolean,
  applyDir: (pts: Vec2[]) => Vec2[],
  toolDiameter: number,
  stockToLeave: number,
  params: ContourParams,
  plannerDirection: 'climb' | 'conventional',
  roughPath: Vec2[],
  tabPlan: ContourTabPlan | null,
): TrochoidalRoughPlan | null {
  const geo = resolveTrochoidalGeometry(toolDiameter, params.trochoidalWidth, params.trochoidalAdvance)
  const guideOffset = trochoidalGuideOffset(toolDiameter, geo.width, stockToLeave)
  const guideLoops = offsetLoop(rawPts, isOuter ? guideOffset : -guideOffset, 0.01)
  if (guideLoops.length !== 1) return null
  const guide0 = applyDir(guideLoops[0])
  const L = closedLength(guide0)
  if (!(L > 0)) return null

  const R = geo.orbitRadius
  const reach = R + 0.1 * toolDiameter + TROCHOIDAL_ALLOWANCE_FRACTION * toolDiameter
  const spans0 = (tabPlan?.intervals ?? []).map(({ start, end }) => {
    const ds = nearestGuideDistance(guide0, sampleTabPath(tabPlan!, start))
    const de = nearestGuideDistance(guide0, sampleTabPath(tabPlan!, end))
    return { start: modDistance(ds - reach, L), length: modDistance(de - ds, L) + 2 * reach }
  })

  let seamDistance: number
  if (spans0.length > 0) {
    // Merge the spans round the loop, then put the seam mid-way through the widest gap.
    const merged: Array<{ start: number; end: number }> = []
    for (const s of [...spans0].sort((p, q) => p.start - q.start)) {
      const last = merged[merged.length - 1]
      if (last && s.start <= last.end) last.end = Math.max(last.end, s.start + s.length)
      else merged.push({ start: s.start, end: s.start + s.length })
    }
    let bestGap = -Infinity
    let bestMid = 0
    for (let i = 0; i < merged.length; i++) {
      const nextStart = i + 1 < merged.length ? merged[i + 1].start : merged[0].start + L
      const gap = nextStart - merged[i].end
      if (gap > bestGap) { bestGap = gap; bestMid = merged[i].end + gap / 2 }
    }
    // The seam's entry bore and stationary orbit need a gap at least an orbit wide.
    if (!(bestGap > 2 * reach)) return null
    seamDistance = modDistance(bestMid, L)
    if (spans0.some(s => modDistance(seamDistance - s.start + reach, L) < s.length + 2 * reach - 1e-9)) {
      return null
    }
  } else {
    seamDistance = nearestGuideDistance(guide0, roughPath[0])
  }

  const guide = reseamClosed(guide0, seamDistance)
  const sense = orbitSenseFor(plannerDirection)
  const orbit = buildTrochoid(guide, {
    orbitRadius: R, advance: geo.advance, toolDiameter, sense,
  })
  if (!orbit) return null
  return {
    orbit,
    seam: guide[0],
    orbitRadius: R,
    sense,
    guideLength: orbit.guideLength,
    tabSpans: spans0.map(s => ({ start: modDistance(s.start - seamDistance, L), length: s.length })),
  }
}

interface TrochoidalEmitArgs {
  depths: number[]
  isRamp: boolean
  /** Stay at the last depth (the finish bridge follows) instead of retracting. */
  stayDown: boolean
  tabTopZ: number | null
  feedZ: number
  retractZ: number
  clearanceZ: number
  feedRate: number
  plungeRate: number
  rampRate: number
  tanAngle: number
}

/**
 * Emit the trochoidal rough pass at every level. Entry mirrors Offset: Plunge
 * re-enters at the seam each level and retracts after it; Ramp descends by a helix
 * on the orbit circle at the ramp angle (a whole number of turns, so it ends where
 * the orbit starts) and stays engaged between levels. A level below the tab top
 * lifts the orbits whose centre is in a tab span to the tab top, and after the
 * span descends again along the orbit at the ramp angle, never straight down.
 */
function emitTrochoidalRough(moves: ToolpathMove[], plan: TrochoidalRoughPlan, a: TrochoidalEmitArgs): void {
  const { orbit } = plan
  const start = orbit.points[0]
  const R = plan.orbitRadius
  const helix = a.isRamp && helixFits(R)
  const L = plan.guideLength
  const inTab = (d: number) => plan.tabSpans.some(s => modDistance(d - s.start, L) < s.length)

  let z = a.feedZ
  for (let di = 0; di < a.depths.length; di++) {
    const depth = a.depths[di]
    const isLast = di === a.depths.length - 1
    if (helix) {
      if (di === 0) rapidEntryAt(moves, start, a.feedZ, a.retractZ, a.clearanceZ)
      const drop = z - depth
      if (drop > 1e-9) {
        const turns = Math.max(1, Math.ceil(drop / (2 * Math.PI * R * a.tanAngle)))
        helixDescent(moves, {
          centre: plan.seam, radius: R, fromZ: z, toZ: depth,
          tanAngle: drop / (turns * 2 * Math.PI * R), feed: a.rampRate,
          startAngle: 0, direction: plan.sense,
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

    const tabbed = a.tabTopZ !== null && depth < a.tabTopZ - 1e-6
    const tabTopZ = a.tabTopZ ?? depth
    let cz = depth
    for (let i = 1; i < orbit.points.length; i++) {
      const p = orbit.points[i]
      const prev = orbit.points[i - 1]
      if (tabbed && inTab(orbit.centreDistance[i])) {
        if (cz < tabTopZ - 1e-9) {
          moves.push({ type: 'feed', x: prev.x, y: prev.y, z: tabTopZ, feed: a.feedRate, role: 'cut' })
          cz = tabTopZ
        }
        moves.push({ type: 'feed', x: p.x, y: p.y, z: tabTopZ, feed: a.feedRate, role: 'cut' })
      } else if (cz > depth + 1e-9) {
        cz = Math.max(depth, cz - Math.hypot(p.x - prev.x, p.y - prev.y) * a.tanAngle)
        moves.push({ type: 'feed', x: p.x, y: p.y, z: cz, feed: a.rampRate, role: 'ramp' })
      } else {
        moves.push({ type: 'feed', x: p.x, y: p.y, z: depth, feed: a.feedRate, role: 'cut' })
      }
    }
    if (cz > depth + 1e-9) {
      moves.push({ type: 'feed', x: start.x, y: start.y, z: depth, feed: a.rampRate, role: 'ramp' })
    }
    z = depth
    if (helix ? (isLast && !a.stayDown) : (!isLast || !a.stayDown)) {
      retractFrom(moves, a.retractZ, a.clearanceZ)
    }
  }
}

// -- Holding tabs -------------------------------------------------------------

export interface ResolvedContourTabs {
  width: number
  count: number
  tabTopZ: number
  stockBottomZ: number
  shape: 'box' | 'triangular'
}

/** Triangular-tab ramp slope: mm of Z rise per mm of contour travel (45 deg,
 *  the default ramped-tab behavior). */
const TAB_RAMP_SLOPE = 1

export interface ContourTabPlan extends ResolvedContourTabs {
  path: Vec2[]
  cumulative: number[]
  perimeter: number
  intervals: Array<{ start: number; end: number }>
}

function resolveContourTabs(
  params: ContourParams,
  entryType: ContourWorkerPayload['linking']['entryType'],
  topZ: number,
  stockBottomWcsZ: number | undefined,
  wcsOriginZ: number,
  doFinish: boolean,
): ResolvedContourTabs | null {
  if (params.tabs !== true) return null

  const width = params.tabWidth ?? DEFAULT_CONTOUR_TABS.width
  const height = params.tabHeight ?? DEFAULT_CONTOUR_TABS.height
  const count = params.tabCount ?? DEFAULT_CONTOUR_TABS.count
  const shape = params.tabShape ?? 'box'

  if (!Number.isFinite(width) || width <= 0) {
    throw new Error('Contour tabs: tab width must be a finite value greater than 0 mm.')
  }
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error('Contour tabs: tab height must be a finite value greater than 0 mm.')
  }
  if (!Number.isFinite(count) || !Number.isInteger(count) || count < 1) {
    throw new Error('Contour tabs: tab count must be a positive whole number.')
  }
  // Triangular ramps rise at 45 deg from each end of the tab, so a tab narrower
  // than 2 x height would peak below the requested tab top on the final pass and
  // silently retain less material than asked. Fail loud with the minimum width.
  if (shape === 'triangular' && width < 2 * height - 1e-9) {
    throw new Error(
      `Contour tabs: triangular tabs ramp at 45 deg from both ends, so the tab width must be ` +
      `at least 2 x the tab height. Height ${height.toFixed(3)} mm needs width >= ` +
      `${(2 * height).toFixed(3)} mm (or reduce the tab height).`,
    )
  }
  if (!doFinish) {
    throw new Error(
      'Contour tabs: a finish/profile pass is required. Roughing-only contours leave wall stock and cannot create holding tabs.',
    )
  }
  if (entryType !== 'plunge' && entryType !== 'ramp_linear') {
    throw new Error(
      `Contour tabs: entry type "${entryType}" is not supported with tabs. ` +
      'Use Plunge or Ramp (linear).',
    )
  }
  if (!Number.isFinite(stockBottomWcsZ)) {
    throw new Error(
      'Contour tabs: stock bottom could not be resolved. Bind the setup to visible stock before computing tabs.',
    )
  }

  const stockBottomZ = (stockBottomWcsZ as number) + wcsOriginZ
  const tabTopZ = stockBottomZ + height
  if (tabTopZ >= topZ - 1e-6) {
    throw new Error(
      `Contour tabs: tab height ${height.toFixed(3)} mm does not fit below the contour top ` +
      `${topZ.toFixed(3)} mm.`,
    )
  }
  return { width, count, tabTopZ, stockBottomZ, shape }
}

/** Cumulative arc lengths of a CLOSED polyline (last entry wraps back to
 *  path[0], so cumulative.length === path.length + 1 and the final value is
 *  the perimeter). */
function buildTabCumulative(path: Vec2[]): { cumulative: number[]; perimeter: number } {
  const cumulative = [0]
  let perimeter = 0
  for (let i = 0; i < path.length; i++) {
    const a = path[i]
    const b = path[(i + 1) % path.length]
    perimeter += Math.hypot(b.x - a.x, b.y - a.y)
    cumulative.push(perimeter)
  }
  return { cumulative, perimeter }
}

/** Rotate a closed polyline so its seam (index 0) sits at arc distance `d0`
 *  of the original parameterization. When d0 falls mid-segment the exact
 *  interpolated point is inserted as the new first vertex; coincident
 *  neighbors are deduplicated so the result stays a clean closed loop. */
function reseamPath(path: Vec2[], cumulative: number[], d0: number): Vec2[] {
  const n = path.length
  // Segment containing d0: cumulative[i] <= d0 <= cumulative[i+1].
  let i = 0
  while (i < n - 1 && cumulative[i + 1] < d0 - 1e-9) i++
  const segLen = cumulative[i + 1] - cumulative[i]
  const t = segLen <= 1e-9 ? 0 : Math.max(0, Math.min(1, (d0 - cumulative[i]) / segLen))
  const a = path[i]
  const b = path[(i + 1) % n]
  const seam = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
  const out: Vec2[] = [seam]
  for (let k = 1; k <= n; k++) {
    const p = path[(i + k) % n]
    const prev = out[out.length - 1]
    if (Math.hypot(p.x - prev.x, p.y - prev.y) < 1e-9) continue
    if (Math.hypot(p.x - seam.x, p.y - seam.y) < 1e-9) continue
    out.push(p)
  }
  return out
}

/**
 * Build the geometric tab plan for one closed finish contour.
 *
 * Default (no `customFractions`): `tabs.count` tabs evenly spaced around the
 * perimeter — byte-identical to the original behavior.
 *
 * Custom (`customFractions` non-empty): each fraction f in [0,1) is the arc
 * position of a TAB CENTER (f x perimeter, measured along the cut direction
 * from the contour seam); `tabs.count` is ignored. Fail-loud rules: every
 * fraction must be finite (all-invalid throws by name) and neighboring tabs
 * must keep at least one tab width of center-to-center separation (overlap
 * throws by name).
 *
 * SEAM-SPANNING CHOICE (documented decision): a custom tab whose interval
 * would cross the seam is handled by RE-SEAMING the path — the polyline is
 * rotated so the seam lands at the middle of the largest tab-free gap —
 * rather than splitting the interval in two. Splitting breaks the triangular
 * Z profile (each half would ramp back to full depth at the seam, severing
 * the tab at its center) and leaves the plunge entry point inside retained
 * tab material; re-seaming keeps every downstream consumer (interval events,
 * triangular profile, plunge entry at path[0], ramp-descent gap logic)
 * working unmodified. The plan's `path` is therefore the authoritative cut
 * path — entries must use it, not the caller's original polyline.
 */
export function buildContourTabPlan(
  path: Vec2[],
  tabs: ResolvedContourTabs,
  customFractions?: number[],
): ContourTabPlan {
  if (path.length < 3) {
    throw new Error('Contour tabs: the finished contour has fewer than three points.')
  }

  let { cumulative, perimeter } = buildTabCumulative(path)

  if (!Number.isFinite(perimeter) || perimeter <= 1e-6) {
    throw new Error('Contour tabs: the finished contour has zero usable perimeter.')
  }

  if (customFractions !== undefined) {
    const valid = customFractions.filter((f) => Number.isFinite(f))
    if (valid.length === 0) {
      throw new Error(
        'Contour tabs: every custom tab location on this contour is invalid (non-numeric). ' +
        'Re-place the tabs in the viewport or reset to even spacing.',
      )
    }
    let centers = valid
      .map((f) => modDistance(f * perimeter, perimeter))
      .sort((a, b) => a - b)

    if (tabs.width * centers.length >= perimeter - 1e-6) {
      throw new Error(
        `Contour tabs: ${centers.length} tabs at ${tabs.width.toFixed(3)} mm wide do not fit ` +
        `on the ${perimeter.toFixed(3)} mm contour perimeter.`,
      )
    }
    // Overlap: circular center-to-center spacing must be at least one width.
    for (let i = 0; i < centers.length; i++) {
      const next = centers[(i + 1) % centers.length]
      const spacing = i === centers.length - 1
        ? next + perimeter - centers[i]
        : next - centers[i]
      if (centers.length > 1 && spacing < tabs.width - 1e-9) {
        throw new Error(
          `Contour tabs: custom tabs at ${centers[i].toFixed(3)} mm and ` +
          `${modDistance(next, perimeter).toFixed(3)} mm along the contour overlap ` +
          `(tab width ${tabs.width.toFixed(3)} mm needs at least that much center spacing). ` +
          'Move them apart or reset to even spacing.',
        )
      }
    }

    // Seam-spanning tab -> re-seam the path (see doc comment above).
    const seamCovered =
      centers[0] < tabs.width / 2 - 1e-9 ||
      perimeter - centers[centers.length - 1] < tabs.width / 2 - 1e-9
    if (seamCovered) {
      // Largest tab-free gap (by center spacing); new seam at its middle.
      let bestIdx = 0
      let bestSpacing = -Infinity
      for (let i = 0; i < centers.length; i++) {
        const next = centers[(i + 1) % centers.length]
        const spacing = i === centers.length - 1
          ? next + perimeter - centers[i]
          : next - centers[i]
        if (spacing > bestSpacing) { bestSpacing = spacing; bestIdx = i }
      }
      const d0 = modDistance(centers[bestIdx] + bestSpacing / 2, perimeter)
      path = reseamPath(path, cumulative, d0)
      ;({ cumulative, perimeter } = buildTabCumulative(path))
      centers = centers
        .map((c) => modDistance(c - d0, perimeter))
        .sort((a, b) => a - b)
    }

    const intervals = centers.map((c) => ({
      start: c - tabs.width / 2,
      end: c + tabs.width / 2,
    }))
    return { ...tabs, count: centers.length, path, cumulative, perimeter, intervals }
  }

  if (tabs.width * tabs.count >= perimeter - 1e-6) {
    throw new Error(
      `Contour tabs: ${tabs.count} tabs at ${tabs.width.toFixed(3)} mm wide do not fit ` +
      `on the ${perimeter.toFixed(3)} mm contour perimeter.`,
    )
  }

  const spacing = perimeter / tabs.count
  const intervals = Array.from({ length: tabs.count }, (_, i) => {
    const center = (i + 0.5) * spacing
    return { start: center - tabs.width / 2, end: center + tabs.width / 2 }
  })
  return { ...tabs, path, cumulative, perimeter, intervals }
}

function modDistance(value: number, modulus: number): number {
  const result = value % modulus
  return result < 0 ? result + modulus : result
}

export function sampleTabPath(plan: ContourTabPlan, distance: number): Vec2 {
  const s = modDistance(distance, plan.perimeter)
  for (let i = 0; i < plan.path.length; i++) {
    const start = plan.cumulative[i]
    const end = plan.cumulative[i + 1]
    if (s <= end + 1e-9) {
      const length = end - start
      if (length <= 1e-9) return plan.path[(i + 1) % plan.path.length]
      const t = Math.max(0, Math.min(1, (s - start) / length))
      const a = plan.path[i]
      const b = plan.path[(i + 1) % plan.path.length]
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
    }
  }
  return plan.path[0]
}

/**
 * Cut Z the tab profile shows at an absolute arc distance `distance` when
 * cutting at `depth`. Box: flat `tabTopZ` inside a tab interval (only when
 * `depth` is actually below the retained tab top), plain `depth` everywhere
 * else. Triangular: rides the 45 deg profile --
 * z(s) = min(tabTopZ, depth + min(s - start, end - s) * TAB_RAMP_SLOPE) --
 * inside a tab interval, plain `depth` in the gaps. Piecewise linear with
 * breakpoints exactly at the tab-interval boundaries (and, for triangular,
 * the climb points), so callers that emit one feed move per event boundary
 * reproduce the exact profile. Shared by cutArcWithTabs (both directly, for
 * every finish/spring pass) and the cross-depth transition padding, so both
 * stay in lockstep with a single source of truth for the tab shape.
 */
function tabZAt(plan: ContourTabPlan, depth: number, distance: number): number {
  if (depth >= plan.tabTopZ - 1e-6) return depth
  const s = modDistance(distance, plan.perimeter)
  for (const { start, end } of plan.intervals) {
    if (s > start && s < end) {
      if (plan.shape === 'triangular') {
        const rise = Math.min(s - start, end - s) * TAB_RAMP_SLOPE
        return Math.min(plan.tabTopZ, depth + rise)
      }
      return plan.tabTopZ
    }
  }
  return depth
}

/**
 * Fixed arc-position breakpoints where the tab profile's SLOPE changes for a
 * pass cutting at `depth` -- the interval start/end for 'box' (flat top), plus
 * the two climb points for 'triangular' (the profile is flat 'targetFloor'
 * outside these, rises to `tabTopZ` between start/start+climb, flat at the top
 * between the climb points when the tab is wider than 2 x its climb, and falls
 * back to `targetFloor` between end-climb/end). Between any two consecutive
 * values here (or across a lap boundary), tabZAt(plan, depth, s) is EXACTLY
 * affine in s, which is what lets cutArcWithTabs (per-position Z) and
 * clampedRampDescent (the ramp/tab clamp crossing) both reason about a single
 * interval with plain linear interpolation instead of re-deriving the profile
 * shape at every call site.
 */
function tabEventBoundaries(plan: ContourTabPlan, depth: number): number[] {
  const triangular = plan.shape === 'triangular' && depth < plan.tabTopZ - 1e-6
  if (!triangular) {
    return plan.intervals.flatMap(({ start, end }) => [start, end])
  }
  return plan.intervals.flatMap(({ start, end }) => {
    const climb = Math.min((plan.tabTopZ - depth) / TAB_RAMP_SLOPE, plan.width / 2)
    return [start, start + climb, end - climb, end]
  })
}

/**
 * Cut one closed finish loop while retaining fixed geometric tab intervals.
 * The cursor is arc distance from path[0], so overlap and repeated finish/spring
 * passes continue from the exact prior endpoint without rotating tab placement.
 * All lifts, traverses, and returns are ordinary feed moves consumed unchanged
 * by simulation and postprocessing.
 *
 * Tab profile ('box' default): vertical lift to the tab top, feed across,
 * vertical plunge back down -- byte-identical to the original behavior.
 * 'triangular' instead feeds up a 45 deg ramp, across the (possibly
 * degenerate) flat top, and down the far ramp, with the same interval
 * geometry at the stock bottom so spacing/gap constraints are unchanged.
 */
function cutLoopWithTabs(
  moves: ToolpathMove[],
  plan: ContourTabPlan,
  startDistance: number,
  depth: number,
  feedRate: number,
  plungeRate: number,
  overlapMm: number,
): number {
  const total = plan.perimeter + Math.max(0, overlapMm)
  return cutArcWithTabs(moves, plan, startDistance, total, depth, feedRate, plungeRate)
}

/**
 * Core of cutLoopWithTabs, generalized to travel an arbitrary arc distance
 * `total` forward from `startDistance` instead of always a full loop (+
 * overlap). Used directly by cutLoopWithTabs (total = perimeter + overlap)
 * and by clampedRampDescent, which walks only the short remainder of a tab
 * crossing (total = distance to the tab's exit/release point) whenever a
 * ramp descent is currently clamped riding over a tab.
 */
function cutArcWithTabs(
  moves: ToolpathMove[],
  plan: ContourTabPlan,
  startDistance: number,
  total: number,
  depth: number,
  feedRate: number,
  plungeRate: number,
): number {
  const events = [0, total]

  // Triangular tabs only shape the pass when it actually cuts below the tab
  // top; shallower passes (and 'box') keep the original flat/box event set.
  const triangular = plan.shape === 'triangular' && depth < plan.tabTopZ - 1e-6
  const fixedBoundaries = [...plan.cumulative.slice(0, -1), ...tabEventBoundaries(plan, depth)]

  for (const boundary of fixedBoundaries) {
    let t = boundary - modDistance(startDistance, plan.perimeter)
    while (t <= 1e-9) t += plan.perimeter
    for (; t < total - 1e-9; t += plan.perimeter) events.push(t)
  }

  events.sort((a, b) => a - b)
  const ordered = events.filter((value, index) =>
    index === 0 || Math.abs(value - events[index - 1]) > 1e-8)

  let current = sampleTabPath(plan, startDistance)
  let currentZ = moves[moves.length - 1]?.z ?? depth
  for (let i = 1; i < ordered.length; i++) {
    const from = ordered[i - 1]
    const to = ordered[i]

    if (triangular) {
      // Ramped tab: Z rides the 45 deg profile as part of the same feed move,
      // so there are never vertical same-XY steps at the tab boundaries.
      // Rising and flat-top segments run at feedRate; descending segments
      // mirror the box convention and use plungeRate.
      const desiredZ = tabZAt(plan, depth, startDistance + to)
      current = sampleTabPath(plan, startDistance + to)
      moves.push({
        type: 'feed',
        x: current.x,
        y: current.y,
        z: desiredZ,
        feed: desiredZ < currentZ - 1e-9 ? plungeRate : feedRate,
        role: 'cut',
      })
      currentZ = desiredZ
      continue
    }

    const midpoint = startDistance + (from + to) / 2
    const desiredZ = tabZAt(plan, depth, midpoint)

    if (Math.abs(currentZ - desiredZ) > 1e-8) {
      moves.push({
        type: 'feed',
        x: current.x,
        y: current.y,
        z: desiredZ,
        feed: desiredZ > currentZ ? feedRate : plungeRate,
        role: 'cut',
      })
      currentZ = desiredZ
    }

    current = sampleTabPath(plan, startDistance + to)
    moves.push({
      type: 'feed',
      x: current.x,
      y: current.y,
      z: currentZ,
      feed: feedRate,
      role: 'cut',
    })
  }

  return modDistance(startDistance + total, plan.perimeter)
}

interface TabProfilePiece { start: number; end: number; valueAtStart: number; slope: number }

/**
 * Partition ONE lap [0, perimeter) of tabZAt(plan, depth, .) into pieces that
 * are each EXACTLY affine (constant slope 0 for a gap or a box tab's flat
 * interior; slope +-TAB_RAMP_SLOPE for a triangular climb) -- the true knot
 * set, `tabEventBoundaries` plus an explicit knot at 0 (always a gap; see
 * buildContourTabPlan's seam-covered re-seaming), so no piece ever wraps.
 *
 * This exists because tabZAt itself cannot be evaluated safely for
 * clampedRampDescent's crossing math AT an arbitrary knot: at a box tab's own
 * start/end, tabZAt intentionally reports the OUTSIDE value (the profile is a
 * genuine step -- that convention is exactly right for a single-depth pass,
 * which never needs to know what's just past the wall). But
 * clampedRampDescent needs the piece's own value approaching that knot FROM
 * INSIDE (to know it should keep riding the tab, not silently drop through
 * it) -- so each piece here carries its own start value and slope, sampled at
 * safely-interior points, and the caller extrapolates within a piece with
 * plain arithmetic instead of re-querying tabZAt at its knots.
 */
function buildTabProfilePieces(plan: ContourTabPlan, depth: number): TabProfilePiece[] {
  const knots = Array.from(new Set(
    [0, ...tabEventBoundaries(plan, depth).map((k) => modDistance(k, plan.perimeter))],
  )).sort((a, b) => a - b)
  const uniqueKnots: number[] = []
  for (const k of knots) {
    if (uniqueKnots.length === 0 || k - uniqueKnots[uniqueKnots.length - 1] > 1e-9) uniqueKnots.push(k)
  }

  const pieces: TabProfilePiece[] = []
  for (let i = 0; i < uniqueKnots.length; i++) {
    const start = uniqueKnots[i]
    const end = i + 1 < uniqueKnots.length ? uniqueKnots[i + 1] : plan.perimeter
    // Sample two safely-interior points (never exactly on a knot) to derive
    // this piece's slope and start value without ever touching tabZAt's
    // outside-the-boundary convention.
    const nearStart = start + Math.min(1e-4, (end - start) / 4)
    const mid = (start + end) / 2
    const nearStartVal = tabZAt(plan, depth, nearStart)
    const midVal = tabZAt(plan, depth, mid)
    const slope = Math.abs(mid - nearStart) > 1e-9 ? (midVal - nearStartVal) / (mid - nearStart) : 0
    const valueAtStart = nearStartVal - slope * (nearStart - start)
    pieces.push({ start, end, valueAtStart, slope })
  }
  return pieces
}

/**
 * The tab profile piece the contour is inside of (or entering) at absolute
 * arc position `pos`, plus that piece's value AT pos and its true end
 * position in the SAME absolute (unbounded) coordinate `pos` is measured in --
 * so the caller can keep walking forward across lap boundaries with plain
 * arithmetic.
 */
function tabPieceAt(
  pieces: TabProfilePiece[], perimeter: number, pos: number,
): { value: number; slope: number; pieceEnd: number } {
  let lap = Math.floor(pos / perimeter)
  let s = pos - lap * perimeter
  if (s >= perimeter - 1e-9) { lap += 1; s = 0 }
  if (s < 0) s = 0
  for (const piece of pieces) {
    if (s >= piece.start - 1e-7 && s < piece.end - 1e-9) {
      const value = piece.valueAtStart + piece.slope * (Math.max(s, piece.start) - piece.start)
      return { value, slope: piece.slope, pieceEnd: lap * perimeter + piece.end }
    }
  }
  // Pieces are built to tile [0, perimeter) exactly; only reachable via a
  // last-knot floating-point graze -- treat it as having just wrapped into
  // the first piece of the next lap.
  const first = pieces[0]
  return { value: first.valueAtStart, slope: first.slope, pieceEnd: (lap + 1) * perimeter + first.end }
}

/**
 * OWNER DIRECTIVE: a ramp descent must never be refused just because a tab is
 * in the way -- the tool rides OVER the tab (at full retained height) and
 * keeps descending once it is clear, however many laps that takes. This
 * replaces the old gap-fitting planTabRampEntry/planTabRampEntryFrom, which
 * threw whenever the below-tabTop tail didn't fit a single tab-free gap.
 *
 * CLAMPED DESCENT: walking forward from `anchorDistance` (the tool's current
 * position -- the seam for the very first entry, or wherever the previous
 * depth's cutting pass left the cursor for every later stepdown), the
 * emitted Z at arc position s is
 *   z(s) = max(rampLine(s), tabZAt(plan, targetFloor, s))
 * where rampLine descends at `tanAngle` per mm of travel from `startZ` BUT
 * its progress toward `targetFloor` pauses whenever the tab profile is
 * currently above it -- the tool instead rides the tab's own profile (box:
 * vertical rise to tabTopZ, feed across, vertical drop; triangular: the 45
 * deg slopes) and the ramp resumes descending, from the exact Z it paused
 * at, only once the tab profile drops back to that paused level. While
 * rampLine is still above every tab in view (early in a deep descent) no
 * clamp ever engages and the ramp behaves exactly as it always has.
 *
 * IMPLEMENTATION: an event-driven integrator over the same fixed breakpoints
 * cutArcWithTabs/tabZAt already use (tabEventBoundaries -- tab-interval
 * start/end, plus the triangular climb points). Between any two consecutive
 * breakpoints tabZAt(plan, targetFloor, s) is exactly affine, and so is
 * rampLine, so whichever of (a) the next breakpoint, (b) the ramp reaching
 * targetFloor, or (c) the two lines crossing, comes first is found by plain
 * linear interpolation -- no search, no iteration within a segment. Each
 * resulting span is then dispatched to the SAME low-level emitters the rest of
 * the file already uses: rampWithTabs for an unclamped span (role 'ramp',
 * `rampRate`, vertex-accurate XY) and cutArcWithTabs for a clamped span
 * (role 'cut', the existing box/triangular tab-crossing convention: rises and
 * traverses at `feedRate`, descents at `plungeRate`) -- so the emitted moves
 * for a tab crossing are byte-identical to the ones a same-depth finishing
 * pass would cut.
 *
 * Termination: completes exactly when the ramp's own progress (not merely
 * arc position) reaches `targetFloor` -- so a transition that never has to
 * clamp (or clears its last tab before the floor is reached) ends after
 * precisely `(startZ - targetFloor) / tanAngle` mm of 'ramp'-role travel, the
 * same total the old unconstrained ramp always used; every tab crossing adds
 * ADDITIONAL 'cut'-role travel on top, never fewer 'ramp' mm than the ideal.
 *
 * Fails loud ONLY when the descent is pathological: the per-lap descent
 * budget (tab-FREE arc length x tanAngle -- the only contour where the ramp
 * ever advances toward the floor, since progress pauses for the entire width
 * of every tab it must cross) would need more than MAX_WRAPS laps to clear
 * the required drop. The message names the drop, the per-lap budget, and the
 * angle so the fix (steeper angle, or fewer/narrower tabs) is obvious.
 *
 * Returns the arc distance (mod perimeter) where the tool lands, exactly at
 * `targetFloor`, clear of every tab -- ready for cutLoopWithTabs.
 */
function clampedRampDescent(
  moves: ToolpathMove[],
  plan: ContourTabPlan,
  anchorDistance: number,
  startZ: number,
  targetFloor: number,
  tanAngle: number,
  rampRate: number,
  feedRate: number,
  plungeRate: number,
): number {
  const totalDrop = startZ - targetFloor
  if (totalDrop <= 1e-6) return modDistance(anchorDistance, plan.perimeter)

  const MAX_WRAPS = 50
  const tabWidthSum = plan.intervals.reduce((sum, { start, end }) => sum + (end - start), 0)
  const tabFreeLen = Math.max(0, plan.perimeter - tabWidthSum)
  const perLapCapacity = tabFreeLen * tanAngle
  if (perLapCapacity <= 1e-9 || totalDrop / perLapCapacity > MAX_WRAPS) {
    const rampAngleDeg = Math.atan(tanAngle) * 180 / Math.PI
    throw new Error(
      `Contour tabs: the ramp from ${startZ.toFixed(3)} mm to ${targetFloor.toFixed(3)} mm needs ` +
      `${totalDrop.toFixed(3)} mm of descent, but the tab-free contour (${tabFreeLen.toFixed(1)} of ` +
      `${plan.perimeter.toFixed(1)} mm -- the rest is retained tab width the ramp cannot advance ` +
      `through) only permits ${perLapCapacity.toFixed(3)} mm of descent per lap at ` +
      `${rampAngleDeg.toFixed(1)} deg -- more than ${MAX_WRAPS} laps of the contour would be needed. ` +
      `Use a steeper ramp angle, or fewer/narrower tabs.`,
    )
  }

  const pieces = buildTabProfilePieces(plan, targetFloor)
  const maxIterations = (pieces.length + 1) * (MAX_WRAPS + 4) * 2 + 32

  let pos = anchorDistance
  let refZ = startZ

  for (let iter = 0; ; iter++) {
    if (iter > maxIterations || pos - anchorDistance > plan.perimeter * MAX_WRAPS + 1e-6) {
      throw new Error(
        `Contour tabs: the ramp from ${startZ.toFixed(3)} mm to ${targetFloor.toFixed(3)} mm did not ` +
        `clear its tabs within ${MAX_WRAPS} laps of the ${plan.perimeter.toFixed(1)} mm contour. Use a ` +
        `steeper ramp angle, or fewer/narrower tabs.`,
      )
    }

    // clamped/unclamped is recomputed FRESH every iteration from the current
    // position (never carried state) -- it is exactly "is the tab profile at
    // or above the paused ramp reference right here", nothing more. Ties
    // (za == refZ, e.g. a stepdown that lands exactly at tabTopZ) resolve
    // toward clamped: at worst that is one zero-length no-op emission, never
    // an unsafe descent.
    const { value: za, slope, pieceEnd: b } = tabPieceAt(pieces, plan.perimeter, pos)

    // Degenerate zero-width piece (pos already landed exactly on the next
    // knot, e.g. a triangular tab whose climb-in and climb-out points
    // coincide) -- nothing to emit, just cross it.
    if (b - pos <= 1e-9) { pos = b; continue }

    let clampedHere = za >= refZ - 1e-9

    if (clampedHere) {
      // Ride this piece (constant for a box top/gap, sloped for a triangular
      // climb) forward. Its OWN extrapolated value at the piece's true end --
      // never tabZAt queried AT that boundary, which would report the piece
      // on the OTHER side of a box tab's wall -- decides whether the release
      // happens inside this piece or only once the piece itself ends.
      const zbPiece = za + slope * (b - pos)

      if (zbPiece >= refZ - 1e-9) {
        // Stays at/above the paused ramp for the piece's entire span --
        // ride it fully (a tie throughout, e.g. a stepdown landing exactly at
        // tabTopZ, emits a flat/no-op traversal here, which is correct: the
        // tool is already exactly where it needs to be).
        cutArcWithTabs(moves, plan, pos, b - pos, targetFloor, feedRate, plungeRate)
        pos = b
        // A box tab's wall is a genuine step: the piece we just rode (still
        // above refZ) can hand off directly to a LOWER piece (typically a
        // gap) with no gradual slope to carry the tool down. Triangular
        // hand-offs never need this (each piece's end value already matches
        // the next piece's start value exactly), so this only ever fires
        // once, at a box tab's far wall.
        const { value: zaNext } = tabPieceAt(pieces, plan.perimeter, pos)
        if (zaNext < refZ - 1e-9 && zbPiece > refZ + 1e-9) {
          const p = sampleTabPath(plan, pos)
          moves.push({ type: 'feed', x: p.x, y: p.y, z: refZ, feed: plungeRate, role: 'cut' })
        }
        continue
      }

      // Release inside this piece (only possible on a triangular slope: za
      // >= refZ, the piece's own value falls back to refZ before its true
      // end). When za is within epsilon of refZ (a floating-point tie -- the
      // ramp landed almost exactly on the release point of the PREVIOUS
      // transition's own tab crossing), the release fraction can land back at
      // `pos` itself: there is nothing to emit and no forward progress would
      // be made by looping here again, so fall straight into the unclamped
      // case below using the SAME za/slope/b instead of re-deriving them --
      // the piece's own slope already guarantees the tab stays clear from
      // here to `b` (that is exactly what "release" means).
      const t = (za - refZ) / (za - zbPiece)
      const releasePos = Math.max(pos, Math.min(b, pos + Math.max(0, Math.min(1, t)) * (b - pos)))
      if (releasePos > pos + 1e-9) {
        cutArcWithTabs(moves, plan, pos, releasePos - pos, targetFloor, feedRate, plungeRate)
        pos = releasePos
        // refZ unchanged -- the ramp resumes descending from the paused value.
        continue
      }
      clampedHere = false
    }

    // Unclamped: the tab profile is currently below the ramp reference.
    // Whichever comes first -- reaching targetFloor, the tab profile
    // overtaking the descending ramp, or simply this piece's end -- decides
    // the next step.
    if (refZ <= targetFloor + 1e-9) {
      return modDistance(pos, plan.perimeter)
    }
    const floorPos = pos + (refZ - targetFloor) / tanAngle
    const idealZb = refZ - tanAngle * (b - pos)
    const zbPiece = za + slope * (b - pos)
    // diffA is >= 0 in the normal case; the fallthrough-from-clamped path
    // above can leave it a hair negative at a floating-point tie, which only
    // ever nudges crossPos to just before `pos` -- harmless, since the
    // `crossPos > pos + 1e-9` guard below discards it either way.
    const diffA = refZ - za
    const diffB = idealZb - zbPiece
    let crossPos = Infinity
    if (diffB < -1e-9) {
      crossPos = pos + (diffA / (diffA - diffB)) * (b - pos)
    }

    if (floorPos <= b + 1e-9 && floorPos <= crossPos + 1e-9) {
      if (floorPos > pos + 1e-9) {
        rampWithTabs(moves, plan, pos, floorPos - pos, refZ, targetFloor, rampRate)
      }
      return modDistance(floorPos, plan.perimeter)
    }
    if (crossPos < b - 1e-9 && crossPos > pos + 1e-9) {
      const crossZ = refZ - tanAngle * (crossPos - pos)
      rampWithTabs(moves, plan, pos, crossPos - pos, refZ, crossZ, rampRate)
      pos = crossPos
      refZ = crossZ
      continue
    }
    rampWithTabs(moves, plan, pos, b - pos, refZ, idealZb, rampRate)
    pos = b
    refZ = idealZb
  }
}

/**
 * Emit an unclamped ramp span: walk `lengthMm` forward from `startDistance`,
 * Z linear in arc length from `startZ` to `depth`, breaking at every path
 * vertex so XY follows the contour exactly. A pure emitter -- the caller
 * (clampedRampDescent) has already decided this span never touches a tab.
 */
function rampWithTabs(
  moves: ToolpathMove[],
  plan: ContourTabPlan,
  startDistance: number,
  lengthMm: number,
  startZ: number,
  depth: number,
  rampRate: number,
): void {
  if (lengthMm <= 1e-9) return

  const events: number[] = []
  for (const boundary of plan.cumulative.slice(0, -1)) {
    let t = boundary - modDistance(startDistance, plan.perimeter)
    while (t <= 1e-9) t += plan.perimeter
    for (; t < lengthMm - 1e-9; t += plan.perimeter) events.push(t)
  }
  events.push(lengthMm)
  events.sort((a, b) => a - b)

  rampDescent(moves, (_length, visit) => {
    let prev = -Infinity
    for (const t of events) {
      if (t - prev <= 1e-8) continue
      prev = t
      visit(sampleTabPath(plan, startDistance + t), t)
    }
  }, startZ, depth, lengthMm, rampRate)
}

/**
 * Derive the finish-contour polyline for ONE loop exactly as the toolpath
 * builder will cut it: the same clipper offset (tool radius, signed by side),
 * the same MIN_LOOP_AREA, the same CCW/direction normalization — so an arc
 * FRACTION of this polyline's perimeter means the same physical point to the
 * viewport tab editor and to the tab engine. Returns null when the offset
 * does not resolve to exactly one closed region (the tab engine fails loud
 * there; a preview has nothing meaningful to show).
 *
 * Requires `ensureClipperReady()` to have resolved (offsetLoop is sync after
 * that); the store awaits it before computing the preview.
 */
export function computeContourTabPreviewLoop(
  loopPts: Vec2[],
  side: 'outer' | 'inner',
  direction: 'climb' | 'conventional',
  toolDiameter: number,
  toolCutHand: ToolCutHand = 'right',
): { path: Vec2[]; perimeter: number } | null {
  const plannerDirection = directionForTool(direction, { cutHand: toolCutHand })
  const isOuter = side === 'outer'
  const needsReverse = loopWindingFor(plannerDirection, isOuter) === 'cw'
  const finishDist = isOuter ? +toolDiameter / 2 : -toolDiameter / 2
  const finishLoops = offsetLoop(loopPts, finishDist, 0.01)
  if (finishLoops.length !== 1) return null
  const ccw = ensureCCW(finishLoops[0] as Array<{ x: number; y: number }>)
  const path = needsReverse ? [...ccw].reverse() : ccw
  if (path.length < 3) return null
  const { perimeter } = buildTabCumulative(path)
  if (!Number.isFinite(perimeter) || perimeter <= 1e-6) return null
  return { path, perimeter }
}

// ── Multi-region emission ───────────────────────────────────────────────────────

interface MultiRegionArgs {
  moves: ToolpathMove[]
  roughLoops: Vec2[][]
  finishLoops: Vec2[][]
  applyDir: (pts: Vec2[]) => Vec2[]
  hasRoughing: boolean
  doFinish: boolean
  isRamp: boolean
  depths: number[]
  finishDepths: number[]
  finalDepth: number
  feedZ: number
  retractZ: number
  clearanceZ: number
  feedRate: number
  plungeRate: number
  rampRate: number
  leadInRate: number
  tanAngle: number
  overlapMm: number
  finishPasses: number
  springPasses: number
}

/**
 * Emit a contour toolpath when a large offset has pinched the part into 2+
 * disjoint regions. Rough loops are decoupled from finish loops: ALL roughing
 * regions are cut first, then ALL finishing regions. Every region is fully
 * self-contained (rapid entry → depth passes → retract) — the retract followed
 * by the next region's rapid entry IS the safe travel/reposition between islands
 * (there is no loftBridge in multi-region).
 *
 * Roles, feedrates-by-role, depths and overlap mirror the single-region path so
 * the two code paths stay consistent. Loop order is clipper offsetLoop's
 * deterministic return order (no sorting).
 */
function emitMultiRegion(a: MultiRegionArgs): void {
  const {
    moves, roughLoops, finishLoops, applyDir,
    hasRoughing, doFinish, isRamp,
    depths, finishDepths, finalDepth,
    feedZ, retractZ, clearanceZ,
    feedRate, plungeRate, rampRate, leadInRate,
    tanAngle, overlapMm, finishPasses, springPasses,
  } = a

  // ── ALL roughing regions first ──────────────────────────────────────────
  if (hasRoughing) {
    for (const loop of roughLoops) {
      const roughPath = applyDir(loop)
      if (isRamp) {
        rapidEntry(moves, roughPath, feedZ, retractZ, clearanceZ)
        let curZ   = feedZ
        let curIdx = 0
        for (const depth of depths) {
          curIdx = rampTo(moves, roughPath, curIdx, curZ, depth, tanAngle, rampRate)
          curZ   = depth
          curIdx = cutLoop(moves, roughPath, curIdx, depth, feedRate)
        }
      } else {
        for (const depth of depths) {
          rapidEntry(moves, roughPath, feedZ, retractZ, clearanceZ)
          plungeTo(moves, roughPath, 0, depth, plungeRate, 'plunge')
          cutLoop(moves, roughPath, 0, depth, feedRate)
          retractFrom(moves, retractZ, clearanceZ)
        }
      }
      // Always retract after a roughing region — no bridge in multi-region.
      // (Plunge branch already retracts after each depth; one extra Z-only
      //  retract from clearance is harmless but redundant, so only retract here
      //  for the ramp branch which stayed at depth.)
      if (isRamp) retractFrom(moves, retractZ, clearanceZ)
    }
  }

  // ── THEN all finishing regions ──────────────────────────────────────────
  if (doFinish) {
    for (const loop of finishLoops) {
      const finishPath = applyDir(loop)
      for (const depth of finishDepths) {
        rapidEntry(moves, finishPath, feedZ, retractZ, clearanceZ)
        plungeTo(moves, finishPath, 0, depth, leadInRate, 'lead_in')
        let curIdx = 0
        for (let fp = 0; fp < finishPasses; fp++) {
          curIdx = cutLoopWithOverlap(moves, finishPath, curIdx, depth, feedRate, overlapMm)
        }
        if (depth === finalDepth) {
          for (let sp = 0; sp < springPasses; sp++) {
            curIdx = cutLoopWithOverlap(moves, finishPath, curIdx, depth, feedRate, overlapMm)
          }
        }
        retractFrom(moves, retractZ, clearanceZ)
      }
    }
  }
}

// ── Bridge helpers ────────────────────────────────────────────────────────────

/**
 * Bridge from roughing end into the finishing path via a **lofted spiral**:
 * walk `leadInLengthMm` forward along BOTH paths simultaneously and blend
 * between corresponding arc-length positions with a smoothstep weight.
 *
 * Every intermediate point is a convex combination of a roughPath sample and
 * a finishPath sample at the same arc-length fraction — so the path is
 * mathematically guaranteed to stay between the two contours and never
 * venture outside the already-cleared band.
 *
 * Returns the finishPath index where the loft lands (fromIdx for cutLoop).
 */
function loftBridge(
  moves: ToolpathMove[],
  roughPath: Vec2[], roughEndIdx: number,
  finishPath: Vec2[],
  z: number, feedRate: number,
  leadInLengthMm: number
): number {
  const fn = finishPath.length

  // Find the finishPath vertex nearest to where roughing ended
  const fromPt = roughPath[roughEndIdx]
  let minD2 = Infinity, nearIdx = 0
  for (let i = 0; i < fn; i++) {
    const dx = finishPath[i].x - fromPt.x
    const dy = finishPath[i].y - fromPt.y
    const d2 = dx * dx + dy * dy
    if (d2 < minD2) { minD2 = d2; nearIdx = i }
  }

  // Sample M evenly arc-length-spaced points along each path for leadInLengthMm
  const M = Math.max(14, Math.ceil(leadInLengthMm * 2))
  const roughSamples = sampleAlongPath(roughPath, roughEndIdx, leadInLengthMm, M)
  const finishSamples = sampleAlongPath(finishPath, nearIdx,    leadInLengthMm, M)

  // Advance the finish path index to match where the loft ends
  const targetIdx = advancePathIndex(finishPath, nearIdx, leadInLengthMm)

  // Blend: at parameter i/(M-1) the tool is at smoothstep(t) of the way from
  // roughPath to finishPath — slow entry, steady mid, slow exit
  for (let i = 1; i < M; i++) {
    const t = i / (M - 1)
    const s = t * t * (3 - 2 * t)   // smoothstep — zero derivative at t=0 and t=1
    const rp = roughSamples[i]
    const fp = finishSamples[i]
    moves.push({
      type: 'feed',
      x: (1 - s) * rp.x + s * fp.x,
      y: (1 - s) * rp.y + s * fp.y,
      z, feed: feedRate, role: 'lead_in',
    })
  }
  // Snap exactly onto the finish profile vertex to avoid floating-point drift
  moves.push({ type: 'feed', x: finishPath[targetIdx].x, y: finishPath[targetIdx].y, z, feed: feedRate, role: 'lead_in' })

  return targetIdx
}

/**
 * Walk `totalDist` mm forward along `path` from `startIdx` and return
 * M evenly arc-length-spaced sample points (inclusive of start).
 */
function sampleAlongPath(path: Vec2[], startIdx: number, totalDist: number, M: number): Vec2[] {
  const n = path.length
  const samples: Vec2[] = [path[startIdx]]
  if (M <= 1 || totalDist < 1e-6) return samples

  const stepDist = totalDist / (M - 1)
  let ci = startIdx
  let ni = (ci + 1) % n
  let segLen = ptDist(path[ci], path[ni])
  let posInSeg = 0       // how far into the current segment we are
  let totalWalked = 0    // total arc-length consumed

  for (let s = 1; s < M; s++) {
    const target = s * stepDist
    while (totalWalked + (segLen - posInSeg) < target) {
      totalWalked += segLen - posInSeg
      posInSeg = 0
      ci = ni
      ni = (ci + 1) % n
      if (ci === startIdx) break   // gone all the way around — stop
      segLen = ptDist(path[ci], path[ni])
    }
    const remainder = target - totalWalked
    const t = segLen > 1e-9 ? Math.min(1, (posInSeg + remainder) / segLen) : 0
    samples.push({
      x: path[ci].x + t * (path[ni].x - path[ci].x),
      y: path[ci].y + t * (path[ni].y - path[ci].y),
    })
    posInSeg += remainder
    totalWalked = target
  }

  while (samples.length < M) samples.push(samples[samples.length - 1])
  return samples
}

/** Advance along `path` from `startIdx` by `dist` mm and return the resulting vertex index. */
function advancePathIndex(path: Vec2[], startIdx: number, dist: number): number {
  const n = path.length
  let walked = 0
  let idx = startIdx
  while (walked < dist) {
    const next = (idx + 1) % n
    walked += ptDist(path[idx], path[next])
    idx = next
    if (idx === startIdx) break
  }
  return idx
}

function ptDist(a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  return Math.sqrt(dx * dx + dy * dy)
}


// ── Depth list builder ────────────────────────────────────────────────────────

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

// Re-export for tests
export { signedArea, offsetPolygon }
