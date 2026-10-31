// SPDX-License-Identifier: LGPL-2.1-or-later
// Ported from FreeCAD's Adaptive2d (src/Mod/CAM/libarea/Adaptive.cpp and Path Adaptive Python), Copyright (c) 2018 Kresimir Tusek.
// This file remains under LGPL-2.1-or-later; the LienCAM project as a whole is distributed under GPL-3.0-or-later (see /LICENSE).
// Phase 5 emit layer: turn a 2D FeatureResult (processFeature output) into Z-aware
// ToolpathMove[]. Port of FreeCAD GenerateGCode.py, but emitting our move vocabulary
// (ADR-0001: ToolpathMove only, no gcode) with resolved heights (ADR-0002) and
// feedrates (ADR-0004).
//
// Structure mirrors GenerateGCode.GenerateGCode:
//   for each depth level (topZ -> bottomZ in stepdown steps):
//     replay the ordered `passes` stream at that level's end depth:
//       entry -> a helix ramp (or straight plunge) down to the level depth
//       cut   -> feed moves along the dense polyline at the level depth
//       link  -> jumpType 1 keep-down feed through cleared / jumpType 2 lift+rapid+plunge
//
// The 2D path is computed ONCE by processFeature; the depth loop replays it, re-boring
// each region's helix from the previous level's depth to this level's depth. v1 keeps
// the safe-approach simple (lift to clearance before each entry); keep-down between
// depth levels is a later optimization.
//
// No general arc/spline smoothing here (deliberate, per the user's Phase-5 decision):
// emit the clean dense polyline as controlled geometry. The only native arcs are explicit,
// configured wall-finish lead-in/out moves. A toleranced smoothing stage may slot in before
// the postprocessor later; the postprocessor itself re-segments per controller.

// WO-3018: every sampling, steering, sharpening and cap number comes from the policy record.
import { ADAPTIVE_POLICY as AP } from '../../../../kernel/ops/adaptive/policy'
import type { ToolpathMove } from '../../../../types'
import type { AdaptiveMillingDirection } from '../../types'
import { materialSideFor, type MaterialSide } from '../../millingDirection'
import type { ResolvedHeights } from '../../heights'
import type { ResolvedFeedrates } from '../../feedrates'
import type { FeatureResult, AdaptivePass, FinishApproach } from './processFeature'
import { MIN_DESCENT_HELIX_RADIUS } from './processFeature'
import { operatorNotice } from './operatorNotices'
import { entryAbove, floorHop, floorHopAlong, helixDescent, helixFits, rapidEntryAt } from '../../moves'
import { FLOOR_HOP_FALLBACK_BAND_MM, makeFloorHopCorridorProof } from './rapidCorridor'
import { effectiveMoveRole, isStockCuttingRole } from '../../stockCuttingRoles'
import { maxTraverseIntrusion, removeSweep, ZDexelField } from '../../../../cam3d/stock'
import { replaySagittaFor, toolpathMovesToLinearSweeps } from '../../../../cam3d/rough/replayStock'
import {
  DESCENT_STANDOFF_MM, LOW_TRAVEL_HEADROOM_MM, TRAVERSE_INTRUSION_TOLERANCE_MM,
} from '../../../../cam3d/rough/traverseSafety'

/** Material side of travel for the context's direction (./millingDirection, WO-1896). */
function materialSideOf(ctx: EmitContext): MaterialSide {
  return materialSideFor(ctx.millingDirection ?? 'climb')
}

/** The cleared side of travel is the side the material is not on. */
function clearedSideOf(ctx: EmitContext): MaterialSide {
  return materialSideOf(ctx) === 'right' ? 'left' : 'right'
}

export interface EmitContext {
  heights: ResolvedHeights
  feeds: ResolvedFeedrates
  /** mm axial per depth level (PassParams.stepdown). Clamped to >= 0.1. */
  stepdown: number
  /** Helix ramp pitch in degrees (entry HelixAngle). Clamped to >= 1. */
  helixAngleDeg: number
  /** Physical milling direction for a clockwise spindle. Missing is climb (material
   *  on the right, WO-1896), which is the historical emission. */
  millingDirection?: AdaptiveMillingDirection
  /** Below this entry helix radius (mm) fall back to a straight plunge. Default 0.2. */
  minHelixRadius?: number
  /** Wall-finish DEPTH SCHEDULE. 'final' and WO-1043's 'final_to_size' both run the lap
   *  once, at the bottom level; 'each_stepdown' runs it at every level. The two 'final*'
   *  values are indistinguishable HERE by design: what separates them is the lap's radial
   *  offset, which processFeature owns (ProcessParams.wallFinishToNet, resolved in
   *  engine/index.ts). The emitter schedules laps; it never moves them. Default 'final'. */
  wallFinishMode?: 'final' | 'each_stepdown' | 'final_to_size'
  /** Optional tangent lead radii for dedicated wall-finish contours. Zero/undefined
   *  preserves the legacy finish move stream byte-for-byte. */
  finishLeadInRadius?: number
  finishLeadOutRadius?: number
  /** True floor Z for an optional one-time adaptive floor cleanup replay. Undefined
   *  selects the byte-identical legacy emitter. */
  floorFinishDepth?: number
  /** WO-2835: the operation's floor-hop height, in mm above the level floor. A reposition
   *  over a cleared floor (a jumpType-1 keep-down, or a jumpType-2 link the planner proved
   *  clear for a micro-lift) leaves the cut in one rapid that rises while it starts the XY
   *  move, holds this height, and descends while it finishes the XY move (moves/ floorHop).
   *  Undefined keeps the legacy shapes: the keep-down traverses at floor depth and the
   *  micro-lift goes straight up to link.microLift.z, across, and down. */
  floorHopMm?: number
  /** Actual cutter/defined shank, supplied by the production entry. */
  floorHopToolRadius?: number
  floorHopAssemblyRadius?: number
  /** Emission-local physical proof. Candidate-only shape/timing controls omit it;
   * the complete feature always installs it before emitting any motion. */
  floorHopIsClear?: (moves: ToolpathMove[], route: readonly { x: number; y: number }[], z: number) => boolean
}

const HELIX_FI_STEP = Math.PI / AP.helix.angularStepDivisor     // FreeCAD spiral angular step
const HELIX_EDGE_BACKOFF = AP.helix.edgeBackoffMm        // FreeCAD: r = helixRadius - 0.01
const MAX_HELIX_POINTS = AP.helix.maxPoints          // safety cap so a tiny angle cannot explode the loop
// One floor for planner and both emitters (processFeature.MIN_DESCENT_HELIX_RADIUS). Read at
// call time, not bound to a module constant: processFeature reaches this file through
// repositionTime.ts (WO-2787 round 6), so on that import order processFeature's export is not
// yet initialised while this module body runs.
const defaultMinHelixRadius = (): number => MIN_DESCENT_HELIX_RADIUS
const FINISH_LEAD_SWEEP = Math.PI / AP.sharpening.finishLeadMaxSweepDivisor   // tangent gate: explicit finish leads never exceed 90 deg
const FINISH_LEAD_FIT_SAMPLES = AP.sampling.finishLeadFitSamples
const XY_EPS = 1e-9

/** Convert one feature's processFeature result into a full multi-depth ToolpathMove[]. */
export function emitFeature(result: FeatureResult, ctx: EmitContext): ToolpathMove[] {
  const floor = floorReplayDepth(ctx)
  const guarded = { ...ctx, floorHopIsClear: makeFloorHopCorridorProof(
    ctx.floorHopToolRadius ?? 0, ctx.floorHopAssemblyRadius ?? ctx.floorHopToolRadius ?? 0,
  ) }
  const moves = floor === undefined ? emitFeatureLegacy(result, guarded) : emitFeatureWithFloorFinish(result, guarded, floor)
  return liftLinksOverUnclearedStock(moves, ctx)
}

/** The Z the pass stream is replayed at once more for floor finishing, or undefined when no
 *  replay is emitted. */
function floorReplayDepth(ctx: EmitContext): number | undefined {
  // Load-bearing identity branch: omitted/disabled floor finishing executes the exact
  // pre-feature emitter below, preserving the existing move stream byte-for-byte.
  if (!Number.isFinite(ctx.floorFinishDepth)) return undefined
  // WO-2038: no floor stock left (rough bottom already at the true floor) means the last
  // rough level cleared the floor; a replay there would cut the whole level again in air.
  // Clear the final depth once, exactly as with floor finishing off.
  if (Math.abs((ctx.floorFinishDepth as number) - ctx.heights.bottomZ) <= 1e-6) return undefined
  return ctx.floorFinishDepth as number
}

/** One depth level the pass stream is emitted at: the level's start and cutting Z, and
 *  whether it is the floor-finish replay (cuts and wall rides there carry role 'finish'). */
export interface EmitLevel { startZ: number; z: number; floorReplay: boolean }

/** Multi-depth: descend from the stock top to the final depth in stepdown bites. */
function roughLevels(topZ: number, bottomZ: number, stepdown: number): EmitLevel[] {
  const step = Math.max(stepdown, AP.sampling.minStepdownMm)
  const levels: EmitLevel[] = []
  let passStartDepth = topZ
  let guard = 0
  while (passStartDepth > bottomZ + 1e-6 && guard++ < AP.sampling.maxDepthLevels) {
    const passEndDepth = Math.max(passStartDepth - step, bottomZ)
    levels.push({ startZ: passStartDepth, z: passEndDepth, floorReplay: false })
    passStartDepth = passEndDepth
  }
  return levels
}

/** WO-2787 round 6: every level emitFeature writes the pass stream at, in emit order -- the
 *  rough levels, then the floor replay when one is scheduled. The reposition time model
 *  prices a candidate over exactly this schedule. */
export function emitLevelSchedule(ctx: EmitContext): EmitLevel[] {
  const levels = roughLevels(ctx.heights.topZ, ctx.heights.bottomZ, ctx.stepdown)
  const floor = floorReplayDepth(ctx)
  if (floor === undefined) return levels
  // Capping the start at topZ covers an axial-stock value larger than the total depth
  // without emitting above the stock top.
  levels.push({ startZ: Math.max(floor, Math.min(ctx.heights.bottomZ, ctx.heights.topZ)), z: floor, floorReplay: true })
  return levels
}

/** WO-2787 round 6: ONE mapping from a connection pass ('cut', 'lead', 'wallfollow',
 *  'loopback', 'link') to the moves -- roles and feeds -- it is written as at one level. Both
 *  level loops emit through it and the reposition time model (repositionTime.ts) prices every
 *  candidate through it, so a ride is ranked at the roles the program will carry: at the floor
 *  replay a wall ride is 'finish' at the finishing feed, not the roughing feed. Entries and
 *  dedicated finish contours stay in the loops. */
export function emitConnectionPass(
  moves: ToolpathMove[], passes: AdaptivePass[], i: number,
  level: EmitLevel, ctx: EmitContext,
): void {
  const pass = passes[i]
  const z = level.z
  if (pass.type === 'cut') {
    if (level.floorReplay) emitFloorFinishCut(moves, pass.points, z)
    else emitCut(moves, pass.points, z, ctx.feeds.feedRate)
  } else if (pass.type === 'lead') {
    emitLead(moves, pass.points, z, leadFeedRate(passes, i, ctx))
  } else if (pass.type === 'wallfollow') {
    // Wall-follow polylines still contact and clean the floor during the replay. They
    // therefore use the same finish role/rate as the primary adaptive cuts.
    if (level.floorReplay) emitFloorFinishCut(moves, pass.points, z)
    else emitWallFollow(moves, pass.points, z, ctx.feeds.feedRate)
  } else if (pass.type === 'loopback') {
    emitLoopback(moves, pass.points, z, floorHopAt(ctx, z), ctx)
  } else if (pass.type === 'link') {
    // A link immediately before an entry is superseded by the entry's own safe
    // approach (the entry owns the reposition to the helix start), so skip it.
    const next = passes[i + 1]
    if (next && next.type === 'entry') return
    const minHelixR = finitePositive(ctx.minHelixRadius) || defaultMinHelixRadius()
    const helixAngleRad = Math.max(ctx.helixAngleDeg, AP.helix.minAngleDeg) * Math.PI / 180
    emitLink(moves, pass, level.startZ, z, ctx, helixAngleRad, minHelixR)
  }
}

function emitFeatureLegacy(result: FeatureResult, ctx: EmitContext): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  if (!result.startPoint || result.passes.length === 0) return moves

  const { clearanceZ, topZ, bottomZ } = ctx.heights
  const minHelixR = finitePositive(ctx.minHelixRadius) || defaultMinHelixRadius()
  const helixAngleRad = Math.max(ctx.helixAngleDeg, AP.helix.minAngleDeg) * Math.PI / 180
  const passes = result.passes

  for (const level of roughLevels(topZ, bottomZ, ctx.stepdown)) {
    const { startZ: passStartDepth, z: passEndDepth } = level

    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i]
      if (pass.type === 'entry') {
        emitEntry(moves, pass, passStartDepth, passEndDepth, ctx, helixAngleRad, minHelixR)
      } else if (pass.type === 'finish') {
        // Dedicated wall-finishing contour (wallFinish feature). Roughing passes emit at
        // every level; the finish contour is depth-gated by wallFinishMode:
        //   'final' (default) -> only at the last/bottom level (passEndDepth at bottomZ)
        //   'final_to_size'   -> same schedule as 'final' (WO-1043); its lap cuts to size
        //                        because processFeature planned it on the true wall, not
        //                        because anything here treats it differently
        //   'each_stepdown'   -> at every level
        // No feedrate is baked here -- the move carries role 'finish'; feed-by-role is a
        // later commit. The postprocessor / runtime estimate resolves the feed by role.
        const isBottom = passEndDepth <= bottomZ + 1e-6
        if ((ctx.wallFinishMode ?? 'final') === 'each_stepdown' || isBottom) {
          // WO-449: the gated connection INTO this lap, emitted at THIS level's depth. The
          // plan is XY-only and depth-independent, so one planned connection serves every
          // level -- plan once (processFeature), emit per level (here).
          const approach = finishApproachFor(result, i)
          emitFinishApproach(moves, approach, passStartDepth, passEndDepth, ctx, helixAngleRad, minHelixR)
          emitFinish(
            moves,
            pass.points,
            finishClearedRegion(result, i),
            result.finishFitRegion,
            passEndDepth,
            ctx,
            approach,
          )
        }
      } else {
        emitConnectionPass(moves, passes, i, level, ctx)
      }
    }
  }

  // Final retract to clearance.
  const last = moves[moves.length - 1]
  if (last) moves.push({ type: 'rapid', x: last.x, y: last.y, z: clearanceZ, role: 'rapid' })

  return moves
}

/** Floor finishing keeps the existing processFeature stream and rough depth loop, then
 *  replays that stream exactly once at the true floor. Adaptive `cut` moves in the replay
 *  carry role `finish` with no baked feed, so the resolved finish feed applies. Dedicated
 *  wall-finish contours are scheduled separately so final-only runs at trueBottom and
 *  each-stepdown never duplicates a contour when roughBottom already equals trueBottom. */
function emitFeatureWithFloorFinish(
  result: FeatureResult,
  ctx: EmitContext,
  trueBottom: number,
): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  if (!result.startPoint || result.passes.length === 0) return moves

  const { clearanceZ, topZ, bottomZ: roughBottom } = ctx.heights
  if (trueBottom > roughBottom + 1e-6) {
    throw new Error(`[floorFinish] true bottom ${trueBottom} is above rough bottom ${roughBottom}`)
  }
  if (trueBottom < topZ - 1e-6 && roughBottom >= topZ - 1e-6) {
    throw new Error(
      '[floorFinish] axial floor stock leaves no rough depth before the true-bottom cleanup; reduce floor stock below the total cut depth',
    )
  }

  const minHelixR = finitePositive(ctx.minHelixRadius) || defaultMinHelixRadius()
  const helixAngleRad = Math.max(ctx.helixAngleDeg, AP.helix.minAngleDeg) * Math.PI / 180
  const passes = result.passes
  const wallFinishMode = ctx.wallFinishMode ?? 'final'

  let lastRoughDepth: number | undefined
  for (const level of roughLevels(topZ, roughBottom, ctx.stepdown)) {
    const { startZ: passStartDepth, z: passEndDepth } = level

    for (let i = 0; i < passes.length; i++) {
      const pass = passes[i]
      if (pass.type === 'entry') {
        emitEntry(moves, pass, passStartDepth, passEndDepth, ctx, helixAngleRad, minHelixR)
      } else if (pass.type === 'finish') {
        // With a floor replay, both final-only modes ('final' and WO-1043's
        // 'final_to_size') belong to trueBottom. The each-stepdown mode still runs at
        // every rough depth.
        if (wallFinishMode === 'each_stepdown') {
          const approach = finishApproachFor(result, i)
          emitFinishApproach(moves, approach, passStartDepth, passEndDepth, ctx, helixAngleRad, minHelixR)
          emitFinish(
            moves,
            pass.points,
            finishClearedRegion(result, i),
            result.finishFitRegion,
            passEndDepth,
            ctx,
            approach,
          )
        }
      } else {
        emitConnectionPass(moves, passes, i, level, ctx)
      }
    }

    lastRoughDepth = passEndDepth
  }

  // One spring/cleanup replay at the true floor. Capping the start at topZ covers an
  // axial-stock value larger than the total depth without emitting above the stock top.
  const floorStartDepth = Math.max(trueBottom, Math.min(roughBottom, topZ))
  const floorLevel: EmitLevel = { startZ: floorStartDepth, z: trueBottom, floorReplay: true }
  const roughWallFinishAlreadyAtFloor =
    wallFinishMode === 'each_stepdown' &&
    lastRoughDepth !== undefined &&
    Math.abs(lastRoughDepth - trueBottom) <= 1e-6

  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i]
    if (pass.type === 'entry') {
      emitEntry(moves, pass, floorStartDepth, trueBottom, ctx, helixAngleRad, minHelixR)
    } else if (pass.type === 'finish') {
      // WO-1043: 'final_to_size' schedules exactly like 'final', so the test is
      // "not each_stepdown" rather than a list of final-ish names. Byte-identical for
      // the two pre-existing modes: roughWallFinishAlreadyAtFloor is already gated on
      // each_stepdown, so this reads the same for 'final' as `mode === 'final'` did.
      if (wallFinishMode !== 'each_stepdown' || !roughWallFinishAlreadyAtFloor) {
        const approach = finishApproachFor(result, i)
        emitFinishApproach(moves, approach, floorStartDepth, trueBottom, ctx, helixAngleRad, minHelixR)
        emitFinish(
          moves,
          pass.points,
          finishClearedRegion(result, i),
          result.finishFitRegion,
          trueBottom,
          ctx,
          approach,
        )
      }
    } else {
      emitConnectionPass(moves, passes, i, floorLevel, ctx)
    }
  }

  const last = moves[moves.length - 1]
  if (last) moves.push({ type: 'rapid', x: last.x, y: last.y, z: clearanceZ, role: 'rapid' })
  return moves
}

/** WO-3023: before an entry's rapid to `target` at clearance, leave where the tool stands
 *  VERTICALLY when it is still below clearance -- the rule emitFinishApproach states (TIER 3,
 *  first half). Without it the next level's entry rapid rose diagonally from the end of the
 *  last pass, through the stock between chambers (WO-3019 item 1). */
function leaveVertically(moves: ToolpathMove[], target: { x: number; y: number }, clearanceZ: number): void {
  const last = moves[moves.length - 1]
  if (last && last.z < clearanceZ && (last.x !== target.x || last.y !== target.y)) {
    moves.push({ type: 'rapid', x: last.x, y: last.y, z: clearanceZ, role: 'rapid' })
  }
}

/** Helix ramp (or straight plunge) entry from passStartDepth down to passEndDepth. */
function emitEntry(
  moves: ToolpathMove[], entry: Extract<AdaptivePass, { type: 'entry' }>,
  passStartDepth: number, passEndDepth: number,
  ctx: EmitContext, helixAngleRad: number, minHelixR: number,
): void {
  const { clearanceZ, retractZ } = ctx.heights
  const { plungeRate } = ctx.feeds
  const c = entry.point

  if (entry.mode === 'side') {
    if (!entry.clearPoint) {
      throw new Error('adaptive emit: side entry is missing its fully-clear descent point')
    }
    const clear = entry.clearPoint
    leaveVertically(moves, clear, clearanceZ)
    moves.push({ type: 'rapid', x: clear.x, y: clear.y, z: clearanceZ, role: 'rapid' })
    moves.push({ type: 'rapid', x: clear.x, y: clear.y, z: passEndDepth, role: 'rapid' })
    moves.push({
      type: 'feed',
      x: c.x,
      y: c.y,
      z: passEndDepth,
      feed: ctx.feeds.leadInRate,
      role: 'lead_in',
    })
    return
  }

  const useHelix = entry.mode === 'helix' && helixFits(entry.radius, minHelixR)

  if (!useHelix) {
    // Straight plunge: safe rapid approach over the entry, then feed down to depth.
    // WO-3083: rapid down to just above the level's material, feed from there.
    leaveVertically(moves, c, clearanceZ)
    rapidEntryAt(moves, c, entryAbove(passStartDepth, undefined, ctx.heights.feedZ), retractZ, clearanceZ)
    moves.push({ type: 'feed', x: c.x, y: c.y, z: passEndDepth, feed: plungeRate, role: 'plunge' })
    return
  }

  emitHelixRamp(moves, c, entry.radius, passStartDepth, passEndDepth, ctx, helixAngleRad)
}

/** The helix ramp proper: safe approach (clearance -> retract -> feed -> plunge to the level's
 *  start depth) at the spiral start, then spiral down around centre `c` at radius `helixR` to
 *  passEndDepth. Shared by region entries (emitEntry) AND helix-descent lift landings
 *  (emitLink, jumpType 2 with helixDescent) so both descend with the exact same construction
 *  (FreeCAD GenerateGCode.py:47-76). The spiral itself is the shared entry library's
 *  helixDescent (WO-1679). Returns the spiral's end point (always at angle -PI/16 from `c`,
 *  depth-independent) so a caller can continue with an at-depth lead. */
function emitHelixRamp(
  moves: ToolpathMove[], c: { x: number; y: number }, helixR: number,
  passStartDepth: number, passEndDepth: number,
  ctx: EmitContext, helixAngleRad: number,
): { x: number; y: number } {
  const { clearanceZ, retractZ } = ctx.heights
  const { rampRate } = ctx.feeds
  // WO-3083 (folds WO-3077): the helix starts ENTRY_CLEARANCE_MM above the level's material -
  // reached by rapid - instead of AT it after a fed plunge through the air from the Feed plane.
  const startZ = entryAbove(passStartDepth, undefined, ctx.heights.feedZ)
  const r = Math.max(helixR - HELIX_EDGE_BACKOFF, helixR * AP.helix.minRadiusFraction)
  const tanAngle = Math.tan(helixAngleRad)
  const depthPerCircle = 2 * Math.PI * helixR * tanAngle
  const passDepth = startZ - passEndDepth
  const maxfi = depthPerCircle > 1e-9 ? (passDepth / depthPerCircle) * 2 * Math.PI : 2 * Math.PI
  // The helix bores into material that surrounds it: material on the right is CCW.
  const travelSign = materialSideOf(ctx) === 'right' ? 1 : -1
  const offsetFi = -travelSign * maxfi - Math.PI / AP.helix.angularStepDivisor // end near 0 deg in either direction
  const startX = c.x + r * Math.cos(offsetFi)
  const startY = c.y + r * Math.sin(offsetFi)

  // Safe approach to the helix start, down to just above the level's material.
  leaveVertically(moves, { x: startX, y: startY }, clearanceZ)
  rapidEntryAt(moves, { x: startX, y: startY }, startZ, retractZ, clearanceZ)

  // Spiral down to the level depth (the final move lands exactly on passEndDepth).
  const first = moves.length
  const end = helixDescent(moves, {
    centre: c, radius: r, pitchRadius: helixR, fromZ: startZ, toZ: passEndDepth,
    tanAngle, feed: rampRate, startAngle: offsetFi, direction: travelSign,
    sampling: { kind: 'fixed', stepRad: HELIX_FI_STEP, maxPoints: MAX_HELIX_POINTS },
  })
  // WO-3270: the spiral's first point is where the rapid stopped. Fed there, it is a zero-length
  // G1 between the rapid and the descent, and the entry reads as no entry at all.
  const rapid = moves[first - 1], start = moves[first]
  if (rapid?.type === 'rapid' && start && start.x === rapid.x && start.y === rapid.y && start.z === rapid.z) moves.splice(first, 1)
  return end
}

/** Cut pass: feed along the dense polyline at the level depth. */
function emitCut(moves: ToolpathMove[], points: { x: number; y: number }[], z: number, feedRate: number): void {
  for (const p of points) moves.push({ type: 'feed', x: p.x, y: p.y, z, feed: feedRate, role: 'cut' })
}

function emitLead(moves: ToolpathMove[], points: { x: number; y: number }[], z: number, feedRate: number): void {
  for (const p of points) moves.push({ type: 'feed', x: p.x, y: p.y, z, feed: feedRate, role: 'lead_in' })
}

/** Feedrate for a `lead` pass (WO-1091). A lead that follows a CLEAR-AIR landing link is the
 *  second half of that landing manoeuvre -- the bounded engage the tool makes after rapiding
 *  down a shaft proven empty -- so it runs at leadInRate, the same rate the side entry's own
 *  engage uses (emitEntry mode 'side') and the same rate every gated wall-finish approach lead
 *  already uses (emitFinishApproach). Every other lead keeps the cutting feed it always had:
 *  the flag is set only by planGatedLanding's clear-air rung, and the link that carries it is
 *  pushed immediately before its lead by every call site in processFeature. */
function leadFeedRate(passes: AdaptivePass[], index: number, ctx: EmitContext): number {
  const prev = index > 0 ? passes[index - 1] : undefined
  return prev && prev.type === 'link' && prev.clearAirLanding
    ? ctx.feeds.leadInRate
    : ctx.feeds.feedRate
}

/** Floor cleanup follows the same adaptive cut geometry at trueBottom, but selects
 *  finishing feed by role instead of baking the roughing feed into each move. */
function emitFloorFinishCut(moves: ToolpathMove[], points: { x: number; y: number }[], z: number): void {
  for (const p of points) moves.push({ type: 'feed', x: p.x, y: p.y, z, role: 'finish' })
}

/** Integral wall-follow: ride the shared wall at depth in place of a lift. Each point is a
 *  cutting feed move at the SAME Z as the surrounding cut passes (no retract/plunge). The
 *  polyline starts at the previous cut's last point, so it connects continuously; the
 *  'wall_follow' role lets the postprocessor/estimator distinguish it from a roughing cut.
 *  (The leading point coincides with the previous move's end; emitting it is harmless and
 *  keeps the helper independent of caller state.) */
function emitWallFollow(moves: ToolpathMove[], points: { x: number; y: number }[], z: number, feedRate: number): void {
  for (const p of points) moves.push({ type: 'feed', x: p.x, y: p.y, z, feed: feedRate, role: 'wall_follow' })
}

/** Wall-clean loopback: the fillet -> fast-traverse -> fillet motion over ALREADY-CLEARED
 *  stock that connects a wall-follow exit to a wall-follow entry. Emitted as a polyline of
 *  fast_traverse moves at the SAME depth (no retract/plunge): the path is continuous with the
 *  surrounding wall-follow cuts and stays in cleared territory. Role 'fast_traverse' carries
 *  NO feedrate -- the postprocessor (and the runtime estimate's no-feed fallback) applies the
 *  machine traverse rate. (ADR-0001: geometry + move type only, no baked feedrate.) */
function emitLoopback(moves: ToolpathMove[], points: { x: number; y: number }[], z: number, hop: number, ctx: EmitContext): void {
  // A feed-accepted loopback may still remove slivers (round5 continuous witnesses).
  // Promote only an EMPTY physical full-width corridor; otherwise keep the fed route.
  if (hop > 0 && points.length > 1 && emitProvenFloorHop(moves, points, z, hop, ctx)) return
  for (const p of points) moves.push({ type: 'feed', x: p.x, y: p.y, z, role: 'fast_traverse' })
}

interface FinishLeadPlan {
  /** Closed contour re-seamed at a straight segment midpoint. First === last geometrically. */
  contour: { x: number; y: number }[]
  seam: { x: number; y: number }
  leadIn?: { start: { x: number; y: number }; center: { x: number; y: number } }
  leadOut?: { end: { x: number; y: number }; center: { x: number; y: number } }
  arcType: 'arc_ccw' | 'arc_cw'
}

/** Dedicated wall-finishing contour (wallFinish feature): feed along the true-wall polyline
 *  at the level depth, tagged role 'finish' so the postprocessor / runtime estimate can apply
 *  the finishing feedrate distinctly from roughing 'cut'.
 *
 *  Positive configured lead radii add exact 90 deg native arcs on the explicitly supplied
 *  cleared side of travel. The seam is placed at the midpoint of a deterministic fitting segment, keeping
 *  both arc joins tangent without changing contour geometry or winding. If the requested
 *  geometry cannot fit, the legacy finish stream is retained exactly; malformed arcs are
 *  never emitted. */
function emitFinish(
  moves: ToolpathMove[],
  points: { x: number; y: number }[],
  clearedRegion: 'inside' | 'outside',
  finishFitRegion: { x: number; y: number }[][] | undefined,
  z: number,
  ctx: EmitContext,
  approach?: FinishApproach,
): void {
  const leadInRadius = finitePositive(ctx.finishLeadInRadius)
  const leadOutRadius = finitePositive(ctx.finishLeadOutRadius)

  // WO-449: a GATED connection owns this lap's entry. Its tangent lead already landed the
  // tool on the lap's own start point (proven against the pre-move belief, which the
  // configured lead-in arc never was), so the seam is FIXED there and the configured lead-in
  // is superseded rather than duplicated. The lead-OUT is kept, rebuilt at that fixed seam.
  if (approach) {
    emitGatedFinish(moves, points, clearedRegion, finishFitRegion, z, ctx, approach, leadOutRadius)
    return
  }

  // Load-bearing identity branch: disabled radii execute the exact pre-lead implementation.
  if (leadInRadius === 0 && leadOutRadius === 0) {
    emitLegacyFinish(moves, points, z)
    return
  }

  const plan = buildFinishLeadPlan(
    points,
    leadInRadius,
    leadOutRadius,
    clearedRegion,
    clearedSideOf(ctx),
    finishFitRegion,
  )
  if (!plan) {
    emitLegacyFinish(moves, points, z)
    return
  }

  let firstFinishIndex = 0
  if (plan.leadIn) {
    moves.push({
      type: 'feed',
      x: plan.leadIn.start.x,
      y: plan.leadIn.start.y,
      z,
      feed: ctx.feeds.leadInRate,
      role: 'lead_in',
    })
    moves.push({
      type: plan.arcType,
      x: plan.seam.x,
      y: plan.seam.y,
      z,
      cx: plan.leadIn.center.x,
      cy: plan.leadIn.center.y,
      feed: ctx.feeds.leadInRate,
      role: 'lead_in',
    })
    // The arc already ends at contour[0] (the seam), so start finishing at contour[1].
    firstFinishIndex = 1
  }

  for (let i = firstFinishIndex; i < plan.contour.length; i++) {
    const p = plan.contour[i]
    moves.push({ type: 'feed', x: p.x, y: p.y, z, role: 'finish' })
  }

  if (plan.leadOut) {
    moves.push({
      type: plan.arcType,
      x: plan.leadOut.end.x,
      y: plan.leadOut.end.y,
      z,
      cx: plan.leadOut.center.x,
      cy: plan.leadOut.center.y,
      feed: ctx.feeds.leadOutRate,
      role: 'lead_out',
    })
  }
}

function emitLegacyFinish(
  moves: ToolpathMove[],
  points: { x: number; y: number }[],
  z: number,
): void {
  for (const p of points) moves.push({ type: 'feed', x: p.x, y: p.y, z, role: 'finish' })
}

/** WO-449: the lap, run from the seam the gated connection landed on.
 *
 *  `cutStartIndex` is non-zero only where the gate's corner-fillet rung fired; that rung
 *  proves its own lead sweep plus already-cleared stock covers the skipped prefix, and the
 *  lap is CLOSED (last point === first), so the head is still reached at the end of the lap.
 *
 *  The lead-OUT is the same quarter-circle construction the configured finish leads use,
 *  tangent to the lap's LAST segment and validated by the same region sampler. It is dropped
 *  (no arc, exactly as a non-fitting configured lead is dropped) when the seam cannot carry
 *  it -- never emitted malformed. */
function emitGatedFinish(
  moves: ToolpathMove[],
  points: { x: number; y: number }[],
  clearedRegion: 'inside' | 'outside',
  finishFitRegion: { x: number; y: number }[][] | undefined,
  z: number,
  ctx: EmitContext,
  approach: FinishApproach,
  leadOutRadius: number,
): void {
  const start = Math.max(0, Math.min(approach.cutStartIndex ?? 0, points.length - 1))
  for (let i = start; i < points.length; i++) {
    moves.push({ type: 'feed', x: points[i].x, y: points[i].y, z, role: 'finish' })
  }
  if (leadOutRadius <= 0) return
  const clearedTravelSide = clearedSideOf(ctx)
  const lead = buildFinishLeadOutAtSeam(points, leadOutRadius, clearedRegion, clearedTravelSide, finishFitRegion)
  if (!lead) return
  moves.push({
    type: clearedTravelSide === 'left' ? 'arc_ccw' : 'arc_cw',
    x: lead.end.x,
    y: lead.end.y,
    z,
    cx: lead.center.x,
    cy: lead.center.y,
    feed: ctx.feeds.leadOutRate,
    role: 'lead_out',
  })
}

/** Tangent quarter-circle lead-out leaving the CLOSED lap at its own final point, on the
 *  cleared side of travel. Same formula and same fit sampler as buildFinishLeadPlan's
 *  lead-out; the only difference is that the seam is fixed (the gated connection chose it)
 *  and the tangent comes from the lap's last segment instead of a segment midpoint. */
function buildFinishLeadOutAtSeam(
  points: { x: number; y: number }[],
  leadOutRadius: number,
  clearedRegion: 'inside' | 'outside',
  clearedTravelSide: 'left' | 'right',
  finishFitRegion: { x: number; y: number }[][] | undefined,
): { end: { x: number; y: number }; center: { x: number; y: number } } | null {
  if (points.length < 4 || !samePoint(points[0], points[points.length - 1])) return null
  const ring = points.slice(0, -1)
  if (ring.length < 3) return null
  const seam = points[points.length - 1]
  const prev = points[points.length - 2]
  const length = Math.hypot(seam.x - prev.x, seam.y - prev.y)
  // The tangent must come from a real segment at least one radius long, exactly as the
  // midpoint construction demands a radius of straight span on each side of its seam.
  if (length + XY_EPS < leadOutRadius) return null
  const tangent = { x: (seam.x - prev.x) / length, y: (seam.y - prev.y) / length }
  const left = { x: -tangent.y, y: tangent.x }
  const clearedNormal = clearedTravelSide === 'left' ? left : { x: -left.x, y: -left.y }
  if (!finishLeadsFitRegion(
    ring,
    clearedRegion === 'inside',
    finishFitRegion,
    seam,
    tangent,
    clearedNormal,
    0,
    leadOutRadius,
  )) {
    return null
  }
  return {
    end: {
      x: seam.x + leadOutRadius * tangent.x + leadOutRadius * clearedNormal.x,
      y: seam.y + leadOutRadius * tangent.y + leadOutRadius * clearedNormal.y,
    },
    center: {
      x: seam.x + leadOutRadius * clearedNormal.x,
      y: seam.y + leadOutRadius * clearedNormal.y,
    },
  }
}

function finishClearedRegion(
  result: FeatureResult,
  passIndex: number,
): 'inside' | 'outside' {
  return result.finishClearedRegions?.[finishPassOrdinal(result, passIndex)] ?? 'inside'
}

/** Position of the `finish` pass at `passIndex` among all finish passes (0-based). */
function finishPassOrdinal(result: FeatureResult, passIndex: number): number {
  let finishIndex = -1
  for (let i = 0; i <= passIndex; i++) {
    if (result.passes[i]?.type === 'finish') finishIndex++
  }
  return finishIndex
}

/** WO-449: the gated connection planned for this lap, or undefined for a legacy/synthetic
 *  FeatureResult that carries none (those keep the pre-WO-449 stream exactly). */
function finishApproachFor(result: FeatureResult, passIndex: number): FinishApproach | undefined {
  return result.finishApproaches?.[finishPassOrdinal(result, passIndex)]
}

/** WO-449: EMIT THE GATED CONNECTION INTO A WALL-FINISH LAP.
 *
 *  Replaces the bare feed at depth that used to carry the tool from the previous position
 *  (the last roughing move, or the previous finish lap) straight into the next contour --
 *  on SquareIsland, straight THROUGH the retained island at finishing feed (Operator, simulator,
 *  move 6849). The tier is 3 (GOOD-SPEC section 3): retract STRAIGHT UP where the tool
 *  stands, cross at clearance where nothing can be met, then descend by the route the
 *  planner's lift-landing gate proved -- a helix ramp (same construction as a region entry)
 *  or a plunge at a point whose cutter disk the gate proved clear -- and lead at depth onto
 *  the lap. The attribution rides in `approach.reason`.
 *
 *  Depth-independent by construction: the plan is pure XY, so the SAME connection is emitted
 *  at every level wallFinishMode schedules a lap at, at that level's own depth. */
function emitFinishApproach(
  moves: ToolpathMove[],
  approach: FinishApproach | undefined,
  passStartDepth: number,
  z: number,
  ctx: EmitContext,
  helixAngleRad: number,
  minHelixR: number,
): void {
  if (!approach) return
  const { clearanceZ, retractZ } = ctx.heights
  const { plungeRate, rampRate, leadInRate } = ctx.feeds

  // WO-466 TIER 2.5: THE TOOL NEVER LEAVES THE FLOOR. The planner proved the first stretch
  // clear at the same zero-tolerance traverse bound a whole-corridor keep-down meets, and the
  // engaged tail under the same caps a tier-0 cut-through meets, so there is nothing to lift
  // over: traverse at depth, then feed into the skin. No rapid, no clearance, no descent.
  if (approach.tier === 'stopshort' && approach.travel && approach.feed) {
    emitStopShortApproach(moves, approach.departure, approach.travel, approach.feed, z, ctx)
    return
  }

  // TIER 3, first half: leave where we stand VERTICALLY. A diagonal rise would move in XY
  // while still below the stock top -- the very thing this connection exists to stop.
  const last = moves[moves.length - 1]
  if (last && (last.x !== approach.descent.x || last.y !== approach.descent.y || last.z !== clearanceZ)) {
    moves.push({ type: 'rapid', x: last.x, y: last.y, z: clearanceZ, role: 'rapid' })
  }

  if (approach.helix && approach.helix.radius >= minHelixR) {
    // The gate found no proven-clear shaft: descend by helix ramp, which opens its own full
    // disk (emitHelixRamp does its own clearance -> retract -> feed -> plunge approach at the
    // spiral start), then lead at depth to the lap start inside the disk it just opened.
    const end = emitHelixRamp(moves, approach.helix.center, approach.helix.radius, passStartDepth, z, ctx, helixAngleRad)
    if (Math.hypot(approach.descent.x - end.x, approach.descent.y - end.y) > XY_EPS) {
      moves.push({ type: 'feed', x: approach.descent.x, y: approach.descent.y, z, feed: rampRate, role: 'lead_in' })
    }
  } else {
    if (approach.helix) {
      // ADR-0003 fail-loud: the planner flagged a helix but its radius is below the emit floor.
      console.warn(`[finish-connection] helix descent radius ${approach.helix.radius.toFixed(2)}mm < minHelixRadius ${minHelixR.toFixed(2)}mm at (${approach.descent.x.toFixed(2)}, ${approach.descent.y.toFixed(2)}) -- falling back to straight plunge (UNSAFE landing)`)
      operatorNotice('a helical descent did not fit before a wall-finish lap, so the tool plunged straight in there instead.')
    }
    const d = approach.descent
    moves.push({ type: 'rapid', x: d.x, y: d.y, z: clearanceZ, role: 'rapid' })
    if (approach.clearAirLanding) {
      // WO-1091, same rung and same proof as a roughing clear-air landing (emitLink): the
      // gate proved the WHOLE cutter disk standing in air here, so the shaft holds no stock
      // and the descent is a rapid. The lead below already runs at leadInRate.
      moves.push({ type: 'rapid', x: d.x, y: d.y, z, role: 'rapid' })
    } else {
      moves.push({ type: 'rapid', x: d.x, y: d.y, z: retractZ, role: 'rapid' })
      moves.push({ type: 'rapid', x: d.x, y: d.y, z: entryAbove(passStartDepth, undefined, ctx.heights.feedZ), role: 'rapid' })
      moves.push({ type: 'feed', x: d.x, y: d.y, z, feed: plungeRate, role: 'plunge' })
    }
  }

  // The at-depth tangent lead the gate built onto the lap. Its first point IS the descent,
  // already reached above, so it is not re-emitted.
  const lead = approach.lead
  if (lead) {
    for (let i = 1; i < lead.length; i++) {
      moves.push({ type: 'feed', x: lead[i].x, y: lead[i].y, z, feed: leadInRate, role: 'lead_in' })
    }
  }
}

/** WO-466 tier 2.5, emitted: an at-depth traverse over proven-cleared ground, then the
 *  engaged tail at feed. Vocabulary is the engine's existing one and nothing new is
 *  invented -- role 'fast_traverse' with NO baked feedrate for the travel (identical to a
 *  jumpType-1 keep-down link and to emitLoopback), role 'lead_in' at leadInRate for the
 *  fed tail (identical to the at-depth lead a gated tier-3 descent already lands with).
 *
 *  PRECONDITION, and it holds by construction: the tool is already AT THIS LEVEL'S DEPTH.
 *  Every pass emitted before a `finish` pass within a level runs at that level's own
 *  passEndDepth, and a lap with no prior motion carries no approach at all. If that ever
 *  stops being true the tool would be asked to ramp diagonally into the part, so it is
 *  checked and answered with a vertical descent AT THE POINT THE TOOL ALREADY STANDS --
 *  ground the previous pass just cut -- plus an ADR-0003 warning naming the violation. */
function emitStopShortApproach(
  moves: ToolpathMove[],
  departure: { x: number; y: number }[] | undefined,
  travel: { x: number; y: number }[],
  feed: { x: number; y: number }[],
  z: number,
  ctx: EmitContext,
): void {
  const last = moves[moves.length - 1]
  if (last && Math.abs(last.z - z) > 1e-6) {
    console.warn(`[finish-connection] stop-short keep-down expected the tool at z=${z.toFixed(3)} but it is at z=${last.z.toFixed(3)} -- descending vertically where it stands before travelling`)
    moves.push({ type: 'feed', x: last.x, y: last.y, z, feed: ctx.feeds.plungeRate, role: 'plunge' })
  }
  if (departure) {
    for (let i = 1; i < departure.length; i++) {
      moves.push({ type: 'feed', x: departure[i].x, y: departure[i].y, z, feed: ctx.feeds.leadInRate, role: 'lead_in' })
    }
  }
  // travel[0] / feed[0] are where the tool already is; only the destinations are emitted.
  // WO-2835: the travel hops (emitLoopback's rule) and lands where the fed tail begins.
  const hop = floorHopAt(ctx, z)
  if (!(hop > 0 && travel.length > 1 && emitProvenFloorHop(moves, travel, z, hop, ctx))) {
    for (let i = 1; i < travel.length; i++) {
      moves.push({ type: 'feed', x: travel[i].x, y: travel[i].y, z, role: 'fast_traverse' })
    }
  }
  for (let i = 1; i < feed.length; i++) {
    moves.push({ type: 'feed', x: feed[i].x, y: feed[i].y, z, feed: ctx.feeds.leadInRate, role: 'lead_in' })
  }
}

/** Construct tangent quarter-circle leads without altering the contour itself. A candidate
 *  segment must provide one radius of straight span on each side of its midpoint, and every
 *  sampled lead point must stay strictly on the loop's cleared side. Candidates are tried
 *  longest-first (source order breaks ties), so the choice is deterministic. */
function buildFinishLeadPlan(
  points: { x: number; y: number }[],
  leadInRadius: number,
  leadOutRadius: number,
  clearedRegion: 'inside' | 'outside',
  clearedTravelSide: 'left' | 'right',
  finishFitRegion: { x: number; y: number }[][] | undefined,
): FinishLeadPlan | null {
  if (points.length < 4 || !samePoint(points[0], points[points.length - 1])) return null

  const ring = points.slice(0, -1)
  if (ring.length < 3) return null
  const area = signedRingArea(ring)
  if (!Number.isFinite(area) || Math.abs(area) <= XY_EPS) return null

  const requiredRadius = Math.max(leadInRadius, leadOutRadius)
  const candidates = ring.map((a, index) => {
    const b = ring[(index + 1) % ring.length]
    return { index, length: Math.hypot(b.x - a.x, b.y - a.y) }
  }).filter(candidate => candidate.length + XY_EPS >= 2 * requiredRadius)
    .sort((a, b) => b.length - a.length || a.index - b.index)

  for (const candidate of candidates) {
    const a = ring[candidate.index]
    const b = ring[(candidate.index + 1) % ring.length]
    const tangent = { x: (b.x - a.x) / candidate.length, y: (b.y - a.y) / candidate.length }
    const left = { x: -tangent.y, y: tangent.x }
    const clearedNormal = clearedTravelSide === 'left'
      ? left
      : { x: -left.x, y: -left.y }
    const seam = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const leadIn = leadInRadius > 0 ? {
      start: {
        x: seam.x - leadInRadius * tangent.x + leadInRadius * clearedNormal.x,
        y: seam.y - leadInRadius * tangent.y + leadInRadius * clearedNormal.y,
      },
      center: {
        x: seam.x + leadInRadius * clearedNormal.x,
        y: seam.y + leadInRadius * clearedNormal.y,
      },
    } : undefined
    const leadOut = leadOutRadius > 0 ? {
      end: {
        x: seam.x + leadOutRadius * tangent.x + leadOutRadius * clearedNormal.x,
        y: seam.y + leadOutRadius * tangent.y + leadOutRadius * clearedNormal.y,
      },
      center: {
        x: seam.x + leadOutRadius * clearedNormal.x,
        y: seam.y + leadOutRadius * clearedNormal.y,
      },
    } : undefined

    if (!finishLeadsFitRegion(
      ring,
      clearedRegion === 'inside',
      finishFitRegion,
      seam,
      tangent,
      clearedNormal,
      leadInRadius,
      leadOutRadius,
    )) {
      continue
    }

    const contour = [seam]
    for (let step = 1; step <= ring.length; step++) {
      contour.push(ring[(candidate.index + step) % ring.length])
    }
    contour.push(seam)
    return {
      contour,
      seam,
      leadIn,
      leadOut,
      arcType: clearedTravelSide === 'left' ? 'arc_ccw' : 'arc_cw',
    }
  }

  return null
}

/** Sample the exact quarter circles and require them to remain strictly in the complete
 *  tool-centre region. The region carries the outer wall plus every island/neighbor loop,
 *  so fitting against it rejects cross-loop collisions. Legacy/synthetic FeatureResults
 *  without that internal context retain the historical own-ring check. */
function finishLeadsFitRegion(
  ring: { x: number; y: number }[],
  clearedSideIsInside: boolean,
  finishFitRegion: { x: number; y: number }[][] | undefined,
  seam: { x: number; y: number },
  tangent: { x: number; y: number },
  clearedNormal: { x: number; y: number },
  leadInRadius: number,
  leadOutRadius: number,
): boolean {
  const onClearedSide = (p: { x: number; y: number }): boolean =>
    finishFitRegion
      ? pointStrictlyInsideRegion(p, finishFitRegion)
      : pointStrictlyInsideRing(p, ring) === clearedSideIsInside

  if (leadInRadius > 0) {
    const center = {
      x: seam.x + leadInRadius * clearedNormal.x,
      y: seam.y + leadInRadius * clearedNormal.y,
    }
    // Exclude the final seam sample: it intentionally lies on the finish contour.
    for (let i = 0; i < FINISH_LEAD_FIT_SAMPLES; i++) {
      const angle = FINISH_LEAD_SWEEP * i / FINISH_LEAD_FIT_SAMPLES
      const p = {
        x: center.x - leadInRadius * (tangent.x * Math.cos(angle) + clearedNormal.x * Math.sin(angle)),
        y: center.y - leadInRadius * (tangent.y * Math.cos(angle) + clearedNormal.y * Math.sin(angle)),
      }
      if (!onClearedSide(p)) return false
    }
  }

  if (leadOutRadius > 0) {
    const center = {
      x: seam.x + leadOutRadius * clearedNormal.x,
      y: seam.y + leadOutRadius * clearedNormal.y,
    }
    for (let i = 1; i <= FINISH_LEAD_FIT_SAMPLES; i++) {
      const angle = FINISH_LEAD_SWEEP * i / FINISH_LEAD_FIT_SAMPLES
      const p = {
        x: center.x + leadOutRadius * (tangent.x * Math.sin(angle) - clearedNormal.x * Math.cos(angle)),
        y: center.y + leadOutRadius * (tangent.y * Math.sin(angle) - clearedNormal.y * Math.cos(angle)),
      }
      if (!onClearedSide(p)) return false
    }
  }

  return true
}

/** Even-odd membership across the canonical offset result preserves disjoint outer roots
 *  and excludes every nested island. Any sample on any loop is rejected as a wall contact. */
function pointStrictlyInsideRegion(
  p: { x: number; y: number },
  region: { x: number; y: number }[][],
): boolean {
  let containingRings = 0
  for (const ring of region) {
    const relation = pointRingRelation(p, ring)
    if (relation === 0) return false
    if (relation === 1) containingRings++
  }
  return containingRings % 2 === 1
}

function pointStrictlyInsideRing(
  p: { x: number; y: number },
  ring: { x: number; y: number }[],
): boolean {
  return pointRingRelation(p, ring) === 1
}

function pointRingRelation(
  p: { x: number; y: number },
  ring: { x: number; y: number }[],
): -1 | 0 | 1 {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[j]
    const b = ring[i]
    const abx = b.x - a.x
    const aby = b.y - a.y
    const apx = p.x - a.x
    const apy = p.y - a.y
    const cross = abx * apy - aby * apx
    const dot = apx * abx + apy * aby
    const lengthSq = abx * abx + aby * aby
    if (lengthSq > XY_EPS * XY_EPS
      && Math.abs(cross) <= XY_EPS
      && dot >= -XY_EPS
      && dot <= lengthSq + XY_EPS) {
      return 0
    }
    if ((a.y > p.y) !== (b.y > p.y) &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) {
      inside = !inside
    }
  }
  return inside ? 1 : -1
}

function signedRingArea(ring: { x: number; y: number }[]): number {
  let twiceArea = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i]
    const b = ring[(i + 1) % ring.length]
    twiceArea += a.x * b.y - b.x * a.y
  }
  return twiceArea / 2
}

function samePoint(a: { x: number; y: number }, b: { x: number; y: number }): boolean {
  return Math.hypot(a.x - b.x, a.y - b.y) <= XY_EPS
}

function finitePositive(value: number | undefined): number {
  return Number.isFinite(value) && (value as number) > 0 ? value as number : 0
}

/** Link between passes: jumpType 1 keeps the tool down (fast traverse through cleared);
 *  jumpType 2 lifts to clearance, rapids across, and plunges back. (Our engine's jumpType
 *  convention differs from FreeCAD's, where both are rapids -- see processFeature appendCutPass.)
 *
 *  HELIX-DESCENT LANDING (lift-landing gate, processFeature 2026-06-12): a jumpType-2 link
 *  flagged `helixDescent` lands in a mostly-UNCUT disk (early-job raw walker landing), where a
 *  straight plunge would be a full-width centre plunge into near-solid stock (R1/R2). Descend
 *  instead via the SAME helix ramp construction as a region entry (emitHelixRamp: same modal
 *  helixAngle, same edge backoff), centred where processFeature proved the helix fits inside
 *  the cut region, then a short at-depth lead from the helix bottom to the landing -- which by
 *  construction (|centre - landing| <= radius) stays inside the disk the helix just opened.
 *  The pass still starts cutting from the same point; no path reversal; deterministic. If the
 *  planned radius is below the minHelixRadius floor, fall back to the straight plunge WITH a
 *  loud warn (ADR-0003: nothing unsafe goes silent).
 *
 *  CLEAR-AIR LANDING (WO-1091): a jumpType-2 link flagged `clearAirLanding` did the opposite
 *  of a helix descent -- rather than open new stock, the gate moved the landing OUT of the
 *  stock, onto a point of `cleared` where the whole cutter disk is proven standing in air at
 *  the side entry's own bound. Its shaft therefore contains nothing to cut, so it descends by
 *  RAPID (not a plungeRate feed), and the `lead` pass that follows carries the tool into the
 *  seam at leadInRate (leadFeedRate). That is exactly the motion emitEntry emits for a side
 *  entry -- rapid over the clear point, rapid down through air, feed in -- and it is Operator's
 *  "straight plunge into cleared space next to the desired entry position, and a step
 *  over/lead-in into the desired reentry point" (2026-08-28). A landing WITHOUT the flag was
 *  proven only to the looser landingUncutCap and keeps its plungeRate feed, unchanged. */
function emitLink(
  moves: ToolpathMove[], link: Extract<AdaptivePass, { type: 'link' }>,
  passStartDepth: number, z: number,
  ctx: EmitContext, helixAngleRad: number, minHelixR: number,
): void {
  const { clearanceZ } = ctx.heights
  const [a, b] = link.points
  const hop = floorHopAt(ctx, z)
  if (link.jumpType === 1 && hop > 0 && emitProvenFloorHop(moves, link.points, z, hop, ctx)) return
  if (link.jumpType === 1) {
    // Keep-down reposition: a non-cutting traverse at depth through already-cleared stock.
    // It carries the 'fast_traverse' move type and NO feed -- the postprocessor (and, until
    // it exists, the runtime estimate's no-feed fallback) applies the machine traverse rate.
    // The operation emits geometry + move type only; it does not bake a feedrate.
    moves.push({ type: 'feed', x: b.x, y: b.y, z, role: 'fast_traverse' })
    return
  }
  // WO-437 tier 2 (GOOD-SPEC.md section 3): a link the planner proved clear at full tool
  // width against clearedBeforePass (processFeature attachMicroLift) hops at a small
  // stay-down height above this level's floor instead of flying to full clearance -- the
  // ancestor's own keep-down (jumpType-1 rapid at passEndDepth + Lift Distance), the reference path's
  // Stay-Down, a small lift. Changes ONLY the height of these two horizontal-
  // clearance rapids; the gated descent below (helixDescent/plunge) is untouched.
  if (link.microLift?.empty && hop > 0 && !link.helixDescent
    && (!ctx.floorHopIsClear || (moves.length > 0 && samePoint(moves[moves.length - 1], a) && moves[moves.length - 1].z === z))
    && hopIsClear(ctx, moves, link.points, z)) {
    // WO-2835 blended micro-lift: the hop height is the operation setting, not
    // LIFT_DISTANCE, and the shape is rise-while-moving / hold / descend-while-moving
    // (moves/ floorHop) over a corridor attachMicroLift proved EMPTY at full tool width,
    // landing disk included (never set together with helixDescent). A micro-lift proven
    // only to the sliver cap keeps its LIFT_DISTANCE hover below. A clear-air landing
    // descends by rapid into air and its lead follows at leadInRate; any other landing
    // holds the hop height to the landing and plunges at plungeRate.
    floorHop(moves, a, b, z, hop, link.clearAirLanding === true)
    if (!link.clearAirLanding) moves.push({ type: 'feed', x: b.x, y: b.y, z, feed: ctx.feeds.plungeRate, role: 'plunge' })
    return
  }
  // WO-3323: the micro-lift's LIFT_DISTANCE hover is capped at the clearance height, as every
  // floor hop is (floorHopAt): a 0.1 mm cut under a 0.1 mm Clearance hovered at 1.9.
  const stayDownZ = link.microLift ? Math.min(clearanceZ, z + link.microLift.z) : clearanceZ
  moves.push({ type: 'rapid', x: a.x, y: a.y, z: stayDownZ, role: 'rapid' })
  const hd = link.helixDescent
  if (hd && hd.radius >= minHelixR) {
    const end = emitHelixRamp(moves, hd.center, hd.radius, passStartDepth, z, ctx, helixAngleRad)
    // Short at-depth lead from the helix bottom to the pass start, through the material the
    // helix itself just opened. Role 'lead_in' (feed-by-role); rampRate, continuing the
    // entry maneuver's conservative feed.
    if (Math.hypot(b.x - end.x, b.y - end.y) > 1e-9) {
      moves.push({ type: 'feed', x: b.x, y: b.y, z, feed: ctx.feeds.rampRate, role: 'lead_in' })
    }
    return
  }
  if (hd) {
    // ADR-0003 fail-loud: the planner flagged a helix but its radius is below the emit floor.
    console.warn(`[lift-landing] helix descent radius ${hd.radius.toFixed(2)}mm < minHelixRadius ${minHelixR.toFixed(2)}mm at (${b.x.toFixed(2)}, ${b.y.toFixed(2)}) -- falling back to straight plunge (UNSAFE landing)`)
    operatorNotice('a helical descent did not fit when re-entering the material, so the tool plunged straight in there instead.')
  }
  moves.push({ type: 'rapid', x: b.x, y: b.y, z: stayDownZ, role: 'rapid' })
  if (link.clearAirLanding) {
    // WO-1091 CLEAR-AIR LANDING: the planner did not merely find this shaft within the
    // landing cap -- it took the point out of `cleared` itself and proved the WHOLE cutter
    // disk standing in air at SIDE_RESEED_CLEAR_UNCUT_MAX, the side entry's own bound. There
    // is no stock in the shaft to plunge through, so the descent is a RAPID, exactly as
    // emitEntry emits a side entry (mode 'side': rapid over the proven-clear point, rapid
    // down through air, then feed in). The bounded engage that follows is the `lead` pass,
    // emitted at leadInRate by the pass loops above -- together, the standard reposition
    // Operator asked for in place of the drill. A landing WITHOUT this flag was proven only to
    // the looser landingUncutCap and keeps its feed-rate plunge below, unchanged.
    moves.push({ type: 'rapid', x: b.x, y: b.y, z, role: 'rapid' })
    return
  }
  // WO-3083: a landing from Clearance rapids down to just above the level's material first
  // (it used to plunge the whole way from Clearance at plunge rate).
  const landStartZ = entryAbove(passStartDepth, undefined, ctx.heights.feedZ)
  if (stayDownZ > landStartZ) moves.push({ type: 'rapid', x: b.x, y: b.y, z: landStartZ, role: 'rapid' })
  moves.push({ type: 'feed', x: b.x, y: b.y, z, feed: ctx.feeds.plungeRate, role: 'plunge' })
}

/** Keep the existing fed route at the frontier; hop only an interior corridor
 * proven empty, and slow the terminal fed approach before any material contact.
 * This changes no cutting point or XY route. A failed proof emits nothing here. */
function emitProvenFloorHop(
  moves: ToolpathMove[], route: { x: number; y: number }[], z: number, hop: number, ctx: EmitContext,
): boolean {
  const at = moves[moves.length - 1]
  if (ctx.floorHopIsClear && (!at || at.z !== z || !samePoint(at, route[0]))) return false
  if (hopIsClear(ctx, moves, route, z)) {
    floorHopAlong(moves, route, z, hop, true)
    return true
  }
  const distances = [0]
  for (let i = 1; i < route.length; i++) distances.push(distances[i - 1] + Math.hypot(route[i].x - route[i - 1].x, route[i].y - route[i - 1].y))
  const length = distances[distances.length - 1]
  const between = (from: number, to: number): { x: number; y: number }[] => {
    const out: { x: number; y: number }[] = []
    for (let i = 1; i < route.length; i++) {
      const a = route[i - 1], b = route[i], start = distances[i - 1], end = distances[i]
      if (end <= from || start >= to || end <= start) continue
      const point = (s: number) => ({ x: a.x + (b.x - a.x) * (s - start) / (end - start), y: a.y + (b.y - a.y) * (s - start) / (end - start) })
      if (out.length === 0) out.push(point(Math.max(from, start)))
      out.push(point(Math.min(to, end)))
    }
    return out
  }
  const minimum = Math.max(hop, 2 * FLOOR_HOP_FALLBACK_BAND_MM)
  for (const trim of [minimum, length * 0.1, length * 0.25, length * 0.4]) {
    if (trim < minimum || length - 2 * trim <= 1e-9) continue
    const interior = between(trim, length - trim)
    if (!hopIsClear(ctx, moves, interior, z)) continue
    for (const p of between(0, trim).slice(1)) moves.push({ type: 'feed', ...p, z, role: 'fast_traverse' })
    floorHopAlong(moves, interior, z, hop, true)
    // The terminal approach runs at FEED (leadInRate), so it is not a traverse: WO-1286 keeps
    // every 'fast_traverse' feed-less. It is a fed link between passes over the corridor it
    // already travelled - role 'loop_back' (stockCuttingRoles: link motion, non-cutting, the
    // same non-cutting class the traverse had). Posted G-code is unchanged: G1 at move.feed.
    for (const p of between(length - trim, length).slice(1)) moves.push({ type: 'feed', ...p, z, feed: ctx.feeds.leadInRate, role: 'loop_back' })
    return true
  }
  return false
}

function hopIsClear(ctx: EmitContext, moves: ToolpathMove[], route: readonly { x: number; y: number }[], z: number): boolean {
  return ctx.floorHopIsClear?.(moves, route, z) ?? true
}

/** WO-2835: the floor-hop height for a hop off floor depth z, capped so no hop, straight or
 *  routed, rises above the clearance height. 0 (legacy shapes) when the setting is off or the
 *  clearance height leaves no room above z. */
function floorHopAt(ctx: EmitContext, z: number): number {
  const hop = ctx.floorHopMm
  if (hop === undefined || !Number.isFinite(hop) || hop <= 0) return 0
  return Math.max(0, Math.min(hop, ctx.heights.clearanceZ - z))
}

// WO-3204: links stay in cleared stock. Operator's WO-096 rule (cam3d/rough/traverseSafety.ts):
// "It is ok to travel below the travel height providing the code generator knows the stock is
// cleared ... it can only do so if it knows that is cleared territory. And it needs to be stock
// aware to do so." The planner's links (fast_traverse keep-downs, loopbacks, their fed terminal
// approaches, floor hops and micro-lifts) are DESIGNED to run over cleared floor, but the design
// is a 2D belief: replaying the program into the stock showed them crossing material that was
// still standing (WO-3197, first witness Tee move 769). So the emitted program is walked once
// more in order against the same in-process stock the 3D rougher proves its links with
// (ZDexelField + removeSweep + maxTraverseIntrusion, no second model): every cutting move is
// replayed as it passes, and every run of non-cutting moves is asked, in the stock state AT
// THAT POINT, whether its corridor is clear. A proven run is kept move for move (stay-down
// stays wherever it is proven); an unproven one is replaced by the enforceTraverseSafety
// route -- straight up where the tool stands (a lift meets nothing new), across at the
// lowest height the stock proves clear (the depth itself when the straight chord is clear,
// else the highest material under it plus LOW_TRAVEL_HEADROOM_MM, else Clearance), and a
// guarded descent: rapid only as deep as the stock proves empty, then feed 'plunge'. Only a
// TRAVERSE (rapid, or feed-less fast_traverse) meeting material unproves a run: a move that
// carries a cutting feed and meets material is an engagement and is labelled 'lead_in'.
//
// RESOLUTION. The field samples each column at its centre, so neither removal nor query can
// resolve material within half a cell diagonal of the cutter's edge. Both are narrowed by
// that same amount: a link retracing a cut path is then proven by the very columns the cut
// removed, and on a 0.1 mm grid any column the WO-3197 oracle (0.2 mm grid, query narrowed
// by its half diagonal, full-radius removal) finds standing inside its query is standing,
// unremoved, inside this query too, whatever the two grids' alignment.
//
// THE STOCK IT KNOWS. The emitter is handed no stock box, so the field is the feature's own
// footprint filled solid to heights.topZ -- the same premise every entry here already rapids
// down on (nothing stands above the level's start). Material outside the real stock is
// therefore assumed present (a link may lift that need not); material cleared by an earlier
// operation or feature is assumed present too. Both only ever lift more, never less.
//
// WHICH TOOLS. The cutter is the flat end mill the production entry names
// (floorHopToolRadius, flat end mills only). Other cutters, and synthetic contexts that name
// none, emit exactly as before.
const STOCK_GUARD_CELL_MM = 0.1
const GUARD_EPS = 1e-9

function liftLinksOverUnclearedStock(moves: ToolpathMove[], ctx: EmitContext): ToolpathMove[] {
  const toolRadius = finitePositive(ctx.floorHopToolRadius)
  if (toolRadius === 0 || moves.length < 2) return moves
  const { clearanceZ, topZ } = ctx.heights
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const m of moves) {
    // An arc may bulge past its endpoints by up to its radius; its centre bounds that.
    const reach = (m.type === 'arc_cw' || m.type === 'arc_ccw') && Number.isFinite(m.cx) && Number.isFinite(m.cy)
      ? Math.hypot(m.x - m.cx!, m.y - m.cy!) : 0
    const cx = reach > 0 ? m.cx! : m.x, cy = reach > 0 ? m.cy! : m.y
    minX = Math.min(minX, cx - reach, m.x); maxX = Math.max(maxX, cx + reach, m.x)
    minY = Math.min(minY, cy - reach, m.y); maxY = Math.max(maxY, cy + reach, m.y)
    minZ = Math.min(minZ, m.z)
  }
  if (![minX, minY, minZ, maxX, maxY, topZ, clearanceZ].every(Number.isFinite) || !(topZ > minZ)) return moves
  const pad = toolRadius + 4 * STOCK_GUARD_CELL_MM
  const field = ZDexelField.fromBox({
    minX: minX - pad, minY: minY - pad, minZ: minZ - 1, maxX: maxX + pad, maxY: maxY + pad, maxZ: topZ,
  }, STOCK_GUARD_CELL_MM)
  const reachRadius = toolRadius - field.cell * Math.SQRT1_2
  if (!(reachRadius > 0)) return moves
  const cutter = { kind: 'flat' as const, diameter: 2 * reachRadius }
  const sagitta = replaySagittaFor(field)
  const tol = TRAVERSE_INTRUSION_TOLERANCE_MM
  const hitAlong = (x0: number, y0: number, z0: number, x1: number, y1: number, z1: number) =>
    maxTraverseIntrusion(field, { x0, y0, z0, x1, y1, z1 }, cutter)
  const out: ToolpathMove[] = [moves[0]]
  const cut = (m: ToolpathMove): void => {
    for (const sweep of toolpathMovesToLinearSweeps([out[out.length - 1], m], sagitta)) removeSweep(field, sweep, cutter)
    out.push(m)
  }
  // Judge a run of non-cutting moves in the stock state it starts in. A pure vertical lift is
  // not asked: the body already occupies everything above the tip, so raising it meets
  // nothing. A TRAVERSE (a rapid, or a feed-less fast_traverse at the machine traverse rate)
  // that meets standing material makes the run unproven: null. A move that carries a cutting
  // feed (the fed terminal approach WO-2835 lands with, at leadInRate, planned to slow down
  // before the frontier) and meets material is an engagement, not travel: its index is
  // returned and it is replayed as the 'lead_in' it is -- same G1, same feed, now removing in
  // the stock what it cuts.
  const judgeRun = (from: ToolpathMove, run: readonly ToolpathMove[]): Set<number> | null => {
    const engaged = new Set<number>()
    let p = from
    for (let k = 0; k < run.length; k++) {
      const q = run[k]
      if (q.type === 'arc_cw' || q.type === 'arc_ccw') return null // no non-cutting arc is emitted; never assume one
      const vertical = Math.hypot(q.x - p.x, q.y - p.y) <= GUARD_EPS
      if (!(vertical && q.z >= p.z) && hitAlong(p.x, p.y, p.z, q.x, q.y, q.z).intrusionMm > tol) {
        if (q.type !== 'feed' || finitePositive(q.feed) === 0) return null
        engaged.add(k)
      }
      p = q
    }
    return engaged
  }
  const reroute = (from: ToolpathMove, to: ToolpathMove): void => {
    const lowZ = Math.max(from.z, to.z)
    const atDepth = hitAlong(from.x, from.y, lowZ, to.x, to.y, lowZ)
    let travelZ = Math.max(clearanceZ, lowZ)
    let keptDown = false
    if (atDepth.intrusionMm <= tol) {
      // The straight chord is itself proven: still stay-down, through cleared stock.
      travelZ = lowZ
      keptDown = true
    } else if (Number.isFinite(atDepth.contactTipZ)) {
      const overZ = Math.max(lowZ, atDepth.contactTipZ + LOW_TRAVEL_HEADROOM_MM)
      if (overZ < clearanceZ - GUARD_EPS
        && hitAlong(from.x, from.y, overZ, to.x, to.y, overZ).intrusionMm <= tol - LOW_TRAVEL_HEADROOM_MM) travelZ = overZ
    }
    // WO-3274: the planner priced this connection against a lift that hovers LIFT_DISTANCE over
    // the level (processFeature attachMicroLift). Emitted, that hover is kept where the stock
    // proves it clear, and where it does not this same reroute lifts it again from the hover.
    // A reroute of the kept-down route that climbed higher than the lift's would make the
    // kept-down choice slower than the lift it beat (gt_two_island, gt_fix5: clearance against
    // the lift's hover at the stock top). So it flies at the lowest of those hover heights,
    // LIFT_DISTANCE steps over the level, that the stock proves clear at the same tolerance
    // every kept run is held to.
    if (!keptDown && Number.isFinite(atDepth.contactTipZ)) {
      const step = AP.caps.liftDistanceMm
      for (let k = Math.max(1, Math.ceil((atDepth.contactTipZ - tol - lowZ) / step - GUARD_EPS)); ; k++) {
        const hoverZ = lowZ + k * step
        if (!(hoverZ < travelZ - GUARD_EPS)) break
        if (hitAlong(from.x, from.y, hoverZ, to.x, to.y, hoverZ).intrusionMm <= tol) { travelZ = hoverZ; break }
      }
    }
    if (from.z < travelZ - GUARD_EPS) out.push({ type: 'rapid', x: from.x, y: from.y, z: travelZ, role: 'rapid' })
    out.push(keptDown
      ? { type: 'feed', x: to.x, y: to.y, z: travelZ, role: 'fast_traverse' }
      : { type: 'rapid', x: to.x, y: to.y, z: travelZ, role: 'rapid' })
    if (!(to.z < travelZ - GUARD_EPS)) return
    // Guarded descent (traverseSafety descendSafely): the rapid stops DESCENT_STANDOFF_MM above
    // the highest material under the cutter; any remaining depth is fed as a plunge.
    const probe = hitAlong(to.x, to.y, to.z, to.x, to.y, to.z)
    const rapidFloorZ = probe.intrusionMm > -DESCENT_STANDOFF_MM
      ? Math.min(travelZ, probe.contactTipZ + DESCENT_STANDOFF_MM) : to.z
    if (rapidFloorZ <= to.z + GUARD_EPS) {
      out.push({ type: 'rapid', x: to.x, y: to.y, z: to.z, role: 'rapid' })
      return
    }
    if (rapidFloorZ < travelZ - GUARD_EPS) out.push({ type: 'rapid', x: to.x, y: to.y, z: rapidFloorZ, role: 'rapid' })
    cut({ type: 'feed', x: to.x, y: to.y, z: to.z, feed: ctx.feeds.plungeRate, role: 'plunge' })
  }
  for (let i = 1; i < moves.length;) {
    if (isStockCuttingRole(effectiveMoveRole(moves[i]))) {
      cut(moves[i++])
      continue
    }
    let end = i
    while (end < moves.length && !isStockCuttingRole(effectiveMoveRole(moves[end]))) end++
    const run = moves.slice(i, end)
    const from = out[out.length - 1]
    const engaged = judgeRun(from, run)
    if (engaged === null) reroute(from, run[run.length - 1])
    else run.forEach((m, k) => { if (engaged.has(k)) cut({ ...m, role: 'lead_in' }); else out.push(m) })
    i = end
  }
  return out
}
