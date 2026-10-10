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
import {
  rapidEntry,
  plungeTo,
  rampTo,
  cutLoopWithOverlap,
  retractFrom,
} from './moves'

export function buildChamferToolpath(
  payload: ChamferWorkerPayload,
  onProgress?: (fraction: number, phase?: string) => void,
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

  return moves
}
