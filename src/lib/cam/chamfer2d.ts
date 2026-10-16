// 2D Chamfer toolpath generator — for V-bits and chamfer mills.
//
// ── Tip angle convention ──────────────────────────────────────────────────────
//
//   angleFromAxisDeg is the half-angle measured FROM THE TOOL AXIS (per side), in degrees:
//     angleFromAxisDeg = 45  →  90° included  →  45° each side from centre axis
//     angleFromAxisDeg = 30  →  60° included  →  30° each side from centre axis
//
//   tanHalf = tan(angleFromAxisDeg°) — used to convert between Z depth and XY radius.
//   Use toolHalfAngleRad() (from ./geometry) to deg2rad in ONE place (no halving).
//   For a 90° (included) bit (angleFromAxisDeg = 45): tanHalf = tan(45°) = 1.0, so
//   every 1 mm of depth = 1 mm of radius.
//
// ── Depth and offset model ────────────────────────────────────────────────────
//
//   chamferWidth  — desired Z depth below the reference face (mm).
//                   This is what the operator sets to control how deep the bevel goes.
//
//   tipOffset     — extra Z depth beyond chamferWidth (mm), default 0.
//                   Moving deeper lifts the cutting contact point up the flute to a
//                   larger effective radius, improving surface speed and finish quality.
//                   This does NOT change the visual chamfer depth — it shifts the tool
//                   centre outward (XY) by the same amount the cone widens.
//
//   zDrop    = chamferWidth + tipOffset    (total Z from reference face to tool tip)
//   zCut     = topZ − zDrop               (absolute WCS Z of the tip during cutting)
//   xyOffset = tipOffset × tanHalf         (XY path offset produced by the extra depth)
//
//   Example — 90° (included) bit, chamferWidth = 1 mm, tipOffset = 0:
//     zDrop = 1 mm, xyOffset = 0 mm. Tip travels exactly 1 mm below the face,
//     tool centre sits on the profile edge.
//
//   Example — 90° (included) bit, chamferWidth = 1 mm, tipOffset = 1 mm:
//     zDrop = 2 mm, xyOffset = 1 × tan(45°) = 1 mm. Tip is 2 mm below the face,
//     tool centre is shifted 1 mm away from the profile edge.
//
// ── Inner vs outer chamfer ────────────────────────────────────────────────────
//
//   Outer chamfer (side = 'outer'): chamfer on the outside of a wall or part edge.
//     The tool must be positioned OUTSIDE the profile. xyOffset expands the path outward.
//
//   Inner chamfer (side = 'inner'): chamfer on the inside of a hole or pocket wall.
//     The tool must be positioned INSIDE the profile. xyOffset shrinks the path inward.
//
//   When tipOffset = 0: xyOffset = 0 and the tool centre runs exactly on the profile
//   edge regardless of bit angle or which side is selected. No offset is applied.
//
// ── Direction and winding ─────────────────────────────────────────────────────
//
//   Paths are normalised to CCW (ensureCCW) and then reversed when the one
//   milling-direction rule (./millingDirection, WO-1896: climb = material on
//   the cutter's right) wants CW:
//     Outer + climb        → reverse (CW)
//     Inner + conventional → reverse (CW)

import { offsetPolygon, ensureCCW, toolHalfAngleRad } from './geometry'
import { resolveHeights } from './heights'
import { resolveFeedrates } from './feedrates'
import { directionForTool } from '../tool/cutHand'
import { loopWindingFor } from './millingDirection'
import type { ToolpathMove } from './types'
import type { Vec2 } from '../../types'
import type { ChamferWorkerPayload } from './types'
import { checkClearSpaceCandidateSweep, checkChamferEngagementSweep, type ClearSpaceCandidateSweep, type ClearSpaceCandidateReport, type ChamferCutSweep } from './holderClearance'
import { prepareChamferClearSpace, trimToolpathToToolReach, type ToolReachInputs } from './holderClearanceGate'
import {
  rapidEntry,
  plungeTo,
  rampTo,
  cutLoopWithOverlap,
  retractFrom,
} from './moves'

/** Optional diagnostic sink; the production worker does not supply one. No
 * observer result participates in candidate selection or movement generation. */
export type ChamferClearSpaceStage =
  | 'loop-input' | 'anchor-edge' | 'cut-engagement' | 'overlap-edge' | 'overlap-edge-length'
  | 'exit-engagement' | 'exit-to-retract' | 'exit-to-clearance'
  | 'previous-transfer' | 'approach-to-retract' | 'approach-to-feed' | 'entry-descent' | 'entry-engagement'
type ObservationPoint = { x: number; y: number; z: number }
export interface ChamferClearSpaceObservation {
  loopId: string
  loopIndex: number
  anchorIndex: number
  stage: ChamferClearSpaceStage
  segmentIndex?: number
  from?: ObservationPoint
  to?: ObservationPoint
  report?: ClearSpaceCandidateReport
  structural?: {
    reason: 'invalid-loop-input' | 'degenerate-anchor-edge' | 'overlap-edge-not-found' | 'degenerate-overlap-edge'
    endpoint?: ObservationPoint
    edgeIndex?: number
    edgeFrom?: Vec2
    edgeTo?: Vec2
    edgeLength?: number
  }
}

export function buildChamferToolpath(
  payload: ChamferWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
  notify?: (message: string) => void,
  observe?: (event: ChamferClearSpaceObservation) => void,
): ToolpathMove[] {
  const { params, heights, linking, tool, loops, wcsOrigin } = payload
  const plannerDirection = directionForTool(params.direction, tool)

  const angleFromAxisDeg = tool.angleFromAxisDeg
  if (!angleFromAxisDeg || angleFromAxisDeg <= 0) {
    throw new Error(
      'Chamfer operation requires a V-bit or chamfer mill with a tip angle defined. ' +
      'Edit the tool in the library and set the Tip Angle field.'
    )
  }

  // angleFromAxisDeg is already the per-side half-angle; toolHalfAngleRad just
  // converts deg->rad. Its tan converts depth to XY radius.
  const halfAngleRad = toolHalfAngleRad(angleFromAxisDeg)
  const tanHalf      = Math.tan(halfAngleRad)
  if (tanHalf < 1e-9) throw new Error(`Tip angle ${angleFromAxisDeg}° is too small for a valid chamfer calculation.`)

  const { chamferWidth, tipOffset, overlapMm } = params

  const { feedRate, plungeRate } = resolveFeedrates(
    tool, payload.feedrateOverride,
  )

  // All heights are stored relative to WCS origin; resolved to absolute machine Z here.
  // topZ is the reference face Z — set by resolveChamferTopZ in the store before dispatch.
  const { clearanceZ, retractZ, feedZ, topZ } = resolveHeights(heights, wcsOrigin)

  // Compute the single cutting depth for this chamfer pass.
  const zDrop    = chamferWidth + tipOffset  // total Z below the reference face
  const zCut     = topZ - zDrop             // absolute WCS Z for the tip during cutting
  const xyOffset = tipOffset * tanHalf      // XY path shift when tipOffset > 0

  const moves: ToolpathMove[] = []
  const clearSpace = params.entryPolicy === 'clear_space'
  const prepared = clearSpace ? prepareChamferClearSpace(payload) : undefined
  if (clearSpace && !prepared?.input) {
    throw new Error(`Chamfer clear-space is unsupported: ${prepared?.reason} No on-edge entry was substituted.`)
  }

  // Filter to only closed loops; optionally restrict to specific loop IDs.
  // ADR 0003: fail loud on an orphaned selection (loop ids are regenerated on
  // every geometry re-derive) instead of silently emitting nothing.
  const closedLoops = loops.filter(l => l.closed)
  const targetLoops =
    params.loopIds.length > 0
      ? closedLoops.filter(l => params.loopIds.includes(l.id))
      : closedLoops

  if (targetLoops.length === 0) {
    if (params.loopIds.length > 0 && closedLoops.length > 0) {
      throw new Error(
        'Chamfer: the selected loop(s) no longer exist - the geometry was re-derived ' +
        '(re-import / sketch edit / projection-tolerance change regenerates loop ids). ' +
        'Open the operation, re-select the edge loop in the Geometry tab, and recompute.'
      )
    }
    throw new Error('Chamfer: no closed loop found. Select a closed edge loop in the Geometry tab.')
  }

  const isRamp    = linking.entryType === 'ramp_linear'
  const rampAngle = Math.max(0.5, Math.min(linking.rampAngle ?? 3, 30))
  const tanRamp   = Math.tan(rampAngle * Math.PI / 180)

  let completedLoops = 0
  for (const loop of targetLoops) {
    // Progress checkpoint: count at the top so skipped (degenerate) loops still
    // advance the fraction to 1.0 (coarse — per loop).
    completedLoops++
    onProgress?.(completedLoops / targetLoops.length,
      targetLoops.length > 1 ? `Chamfer ${completedLoops}/${targetLoops.length}` : undefined)

    // Per-loop side selection: defaults to 'inner' for holes, 'outer' for everything else.
    const side    = params.loopSides[loop.id] ?? (loop.type === 'hole' ? 'inner' : 'outer')
    const isOuter = side === 'outer'

    // Shift the tool path by xyOffset relative to the profile edge.
    // Positive (outward) for outer chamfer; negative (inward) for inner chamfer.
    // When tipOffset = 0, xyOffset = 0 and the loop is used as-is.
    const offsetDist  = isOuter ? +xyOffset : -xyOffset
    const chamferPath = Math.abs(offsetDist) < 1e-9
      ? (loop.points as Vec2[]).map(p => ({ x: p.x, y: p.y }))
      : offsetPolygon(loop.points, offsetDist)
    if (!chamferPath || chamferPath.length < 2) continue

    // Reverse from the CCW default when the combination requires CW travel.
    const needsReverse = loopWindingFor(plannerDirection, isOuter) === 'cw'

    const ccw  = ensureCCW(chamferPath as Vec2[])
    const path = needsReverse ? ([...ccw].reverse() as Vec2[]) : (ccw as Vec2[])

    if (clearSpace) {
      const planned = planClearSpaceLoop({ path, isOuter, zCut, feedZ, retractZ, clearanceZ,
        feedRate, plungeRate, overlapMm, input: prepared!.input!, previous: moves[moves.length - 1],
        loopId: loop.id, loopIndex: completedLoops - 1, observe })
      if (!planned) throw new Error(`Chamfer clear-space is unsupported for loop ${loop.id}: ` +
        'no complete approach, intended engagement, overlap exit and retract could be proved. No on-edge entry was substituted.')
      moves.push(...planned)
      continue
    }

    // Rapid to clearance, descend to feed height, then enter at cutting depth.
    rapidEntry(moves, path, feedZ, retractZ, clearanceZ)

    if (isRamp) {
      // Ramp entry: descend gradually along the path profile rather than plunging straight down.
      const curIdx = rampTo(moves, path, 0, feedZ, zCut, tanRamp, plungeRate)
      cutLoopWithOverlap(moves, path, curIdx, zCut, feedRate, overlapMm)
    } else {
      // Plunge entry: drop straight to cutting depth at the start point.
      plungeTo(moves, path, 0, zCut, plungeRate)
      cutLoopWithOverlap(moves, path, 0, zCut, feedRate, overlapMm)
    }

    retractFrom(moves, retractZ, clearanceZ)
  }

  if (clearSpace) {
    if (moves.length === 0) throw new Error('Chamfer clear-space is unsupported: no nondegenerate cutting loop was produced.')
    // WO-1941/WO-1575: a later reach trim is not proof that a planned lead worked.
    // Reuse the production check unchanged and refuse a modified strategy here.
    const reach = trimToolpathToToolReach({ ...payload, ...(payload as ToolReachInputs), operation: 'Chamfer', moves, plungeRate })
    if (reach.moves.length !== moves.length || reach.moves.some((m, i) =>
      m.x !== moves[i].x || m.y !== moves[i].y || m.z !== moves[i].z || m.type !== moves[i].type)) {
      throw new Error('Chamfer clear-space is unsupported: the existing reach check modifies the planned motion. No on-edge entry was substituted.')
    }
    for (const notice of prepared!.notices) notify?.(notice)
    const report = checkClearSpaceCandidateSweep({ ...prepared!.input!, from: moves[0], to: moves[0] })
    notify?.(report.scope === 'tool-shank-and-holder'
      ? 'Chamfer clear-space: tool, shank and available holder checked; approach before the first programmed position is not established.'
      : 'Chamfer clear-space: tool and shank checked only; holder clearance and approach before the first programmed position are not established.')
  }
  return moves
}

interface ClearSpaceLoop {
  path: Vec2[]; isOuter: boolean; zCut: number; feedZ: number; retractZ: number; clearanceZ: number
  feedRate: number; plungeRate: number; overlapMm: number
  input: Omit<ClearSpaceCandidateSweep, 'from' | 'to'>
  previous?: ToolpathMove
  loopId: string; loopIndex: number
  observe?: (event: ChamferClearSpaceObservation) => void
}

/** Normal candidates are proposals only: every emitted segment is proved against
 * the supplied material envelope. No center/centroid or own-bore assumption.
 * Start at a segment midpoint to avoid an arbitrary sharp-vertex lead. */
function planClearSpaceLoop(p: ClearSpaceLoop): ToolpathMove[] | undefined {
  const { path, zCut, feedZ, retractZ, clearanceZ, input, feedRate, plungeRate, overlapMm } = p
  const point = (v: ObservationPoint): ObservationPoint => ({ x: v.x, y: v.y, z: v.z })
  const structural = (anchorIndex: number, stage: ChamferClearSpaceStage, detail: NonNullable<ChamferClearSpaceObservation['structural']>) =>
    p.observe?.({ loopId: p.loopId, loopIndex: p.loopIndex, anchorIndex, stage, structural: detail })
  if (path.some(v => !Number.isFinite(v.x) || !Number.isFinite(v.y)) ||
      ![zCut, feedZ, retractZ, clearanceZ, overlapMm].every(Number.isFinite) ||
      clearanceZ < retractZ || retractZ < feedZ || feedZ < zCut || overlapMm < 0) {
    structural(-1, 'loop-input', { reason: 'invalid-loop-input' })
    return undefined
  }
  const signedArea = path.reduce((sum, a, i) => {
    const b = path[(i + 1) % path.length]
    return sum + a.x * b.y - b.x * a.y
  }, 0)
  const outward = (signedArea > 0 ? 1 : -1) * (p.isOuter ? 1 : -1)
  const cell = input.stock!.resolutionMm
  const scale = Math.max(cell * 2, input.tool.diameter / 2)
  const distances = [...new Set([0.25, 0.5, 1, 2, 4].map(f => Math.max(cell * 2, scale * f)))]
  const record = (anchorIndex: number, stage: ChamferClearSpaceStage, from: ObservationPoint,
    to: ObservationPoint, report: ClearSpaceCandidateReport, segmentIndex?: number) => {
    const accepted = report.status === 'clear'
    // Copies prevent the observer from mutating planner points or query results.
    p.observe?.({ loopId: p.loopId, loopIndex: p.loopIndex, anchorIndex, stage, segmentIndex,
      from: point(from), to: point(to), report: { ...report,
        blocker: report.blocker ? { ...report.blocker } : undefined, warnings: [...report.warnings],
        ...(report.firstStockRejection ? { firstStockRejection: {
          ...report.firstStockRejection, cell: { ...report.firstStockRejection.cell }, band: { ...report.firstStockRejection.band },
          permission: { ...report.firstStockRejection.permission,
            anchor: report.firstStockRejection.permission.anchor ? point(report.firstStockRejection.permission.anchor) : null,
            free: report.firstStockRejection.permission.free ? point(report.firstStockRejection.permission.free) : null },
        } } : {}) } })
    return accepted
  }
  const clear = (anchorIndex: number, stage: ChamferClearSpaceStage, from: ObservationPoint, to: ObservationPoint) =>
    record(anchorIndex, stage, from, to, checkClearSpaceCandidateSweep({ ...input, from, to,
      ...(p.observe ? { includeFirstStockRejection: true } : {}) }))
  const engagement = (anchorIndex: number, stage: ChamferClearSpaceStage, from: ObservationPoint,
    to: ObservationPoint, cutPath: Vec2[], segmentIndex?: number, actualSegments?: ChamferCutSweep['actualSegments']) =>
    record(anchorIndex, stage, from, to,
      checkChamferEngagementSweep({ ...input, from, to,
        ...(p.observe ? { includeFirstStockRejection: true } : {}) }, { path: cutPath, z: zCut, ...(actualSegments ? { actualSegments } : {}) }), segmentIndex)
  for (let i = 0; i < path.length; i++) {
    const a = path[i], b = path[(i + 1) % path.length]
    const length = Math.hypot(b.x - a.x, b.y - a.y)
    if (!(length > 1e-9)) {
      structural(i, 'anchor-edge', { reason: 'degenerate-anchor-edge', edgeIndex: i,
        edgeFrom: { ...a }, edgeTo: { ...b }, edgeLength: length })
      continue
    }
    const anchor = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const normal = { x: outward * (b.y - a.y) / length, y: -outward * (b.x - a.x) / length }
    const cutPath = [anchor, ...Array.from({ length: path.length }, (_, n) => path[(i + 1 + n) % path.length])]
    const cutting: ToolpathMove[] = []
    cutLoopWithOverlap(cutting, cutPath, 0, zCut, feedRate, overlapMm)
    // Include every cut and actual interpolated overlap endpoint before exit search.
    if (cutting.some((m, n) => !engagement(i, 'cut-engagement', n === 0 ? { ...anchor, z: zCut } : cutting[n - 1], m, cutPath, n))) continue
    // This OPEN sequence is the actual checked cutting, including its rounded
    // overlap endpoint. Do not invent an endpoint-to-start closing chord.
    const actualSegments = cutting.map((move, n) => ({
      from: point(n === 0 ? { ...anchor, z: zCut } : cutting[n - 1]), to: point(move),
    }))
    const end = cutting[cutting.length - 1]
    const exitEdge = cutPath.findIndex((v, n) => {
      const next = cutPath[(n + 1) % cutPath.length]
      const dx = next.x - v.x, dy = next.y - v.y
      const cross = (end.x - v.x) * dy - (end.y - v.y) * dx
      return Math.abs(cross) <= 1e-8 && (end.x - v.x) * (end.x - next.x) + (end.y - v.y) * (end.y - next.y) <= 1e-8
    })
    if (exitEdge < 0) {
      structural(i, 'overlap-edge', { reason: 'overlap-edge-not-found', endpoint: point(end), edgeIndex: exitEdge })
      continue
    }
    const e0 = cutPath[exitEdge], e1 = cutPath[(exitEdge + 1) % cutPath.length]
    const exitLength = Math.hypot(e1.x - e0.x, e1.y - e0.y)
    if (!(exitLength > 1e-9)) {
      structural(i, 'overlap-edge-length', { reason: 'degenerate-overlap-edge', endpoint: point(end),
        edgeIndex: exitEdge, edgeFrom: { ...e0 }, edgeTo: { ...e1 }, edgeLength: exitLength })
      continue
    }
    const exitNormal = { x: outward * (e1.y - e0.y) / exitLength, y: -outward * (e1.x - e0.x) / exitLength }
    const exit = distances.map(d => ({ x: end.x + exitNormal.x * d, y: end.y + exitNormal.y * d, z: zCut }))
      .find(q => engagement(i, 'exit-engagement', end, q, cutPath, undefined, actualSegments) &&
        clear(i, 'exit-to-retract', q, { ...q, z: retractZ }) && clear(i, 'exit-to-clearance', { ...q, z: retractZ }, { ...q, z: clearanceZ }))
    if (!exit) continue
    for (const distance of distances) {
      const candidate = { x: anchor.x + normal.x * distance, y: anchor.y + normal.y * distance, z: zCut }
      const first = { ...candidate, z: clearanceZ }
      if (!clear(i, 'previous-transfer', p.previous ?? first, first) || !clear(i, 'approach-to-retract', first, { ...candidate, z: retractZ }) ||
          !clear(i, 'approach-to-feed', { ...candidate, z: retractZ }, { ...candidate, z: feedZ }) ||
          !clear(i, 'entry-descent', { ...candidate, z: feedZ }, candidate) || !engagement(i, 'entry-engagement', candidate, { ...anchor, z: zCut }, cutPath, undefined, actualSegments)) continue
      const result: ToolpathMove[] = []
      rapidEntry(result, [candidate], feedZ, retractZ, clearanceZ)
      plungeTo(result, [candidate], 0, zCut, plungeRate)
      result.push({ type: 'feed', role: 'lead_in', ...anchor, z: zCut, feed: feedRate }, ...cutting,
        { type: 'feed', role: 'lead_out', ...exit, feed: feedRate })
      retractFrom(result, retractZ, clearanceZ)
      return result
    }
  }
  return undefined
}
