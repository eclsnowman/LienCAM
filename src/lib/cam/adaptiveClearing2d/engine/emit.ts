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

import type { ToolpathMove } from '../../../../types'
import type { AdaptiveMillingDirection } from '../../types'
import { materialSideFor, type MaterialSide } from '../../millingDirection'
import type { ResolvedHeights } from '../../heights'
import type { ResolvedFeedrates } from '../../feedrates'
import type { FeatureResult, AdaptivePass, FinishApproach } from './processFeature'
import { MIN_DESCENT_HELIX_RADIUS } from './processFeature'
import { operatorNotice } from './operatorNotices'
import { helixDescent, helixFits } from '../../moves'

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
}

const HELIX_FI_STEP = Math.PI / 16     // FreeCAD spiral angular step
const HELIX_EDGE_BACKOFF = 0.01        // FreeCAD: r = helixRadius - 0.01
const MAX_HELIX_POINTS = 5000          // safety cap so a tiny angle cannot explode the loop
// One floor for planner and both emitters (processFeature.MIN_DESCENT_HELIX_RADIUS). Read at
// call time, not bound to a module constant: processFeature reaches this file through
// repositionTime.ts (WO-2787 round 6), so on that import order processFeature's export is not
// yet initialised while this module body runs.
const defaultMinHelixRadius = (): number => MIN_DESCENT_HELIX_RADIUS
const FINISH_LEAD_SWEEP = Math.PI / 2   // tangent gate: explicit finish leads never exceed 90 deg
const FINISH_LEAD_FIT_SAMPLES = 8
const XY_EPS = 1e-9

/** Convert one feature's processFeature result into a full multi-depth ToolpathMove[]. */
export function emitFeature(result: FeatureResult, ctx: EmitContext): ToolpathMove[] {
  const floor = floorReplayDepth(ctx)
  return floor === undefined ? emitFeatureLegacy(result, ctx) : emitFeatureWithFloorFinish(result, ctx, floor)
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
  const step = Math.max(stepdown, 0.1)
  const levels: EmitLevel[] = []
  let passStartDepth = topZ
  let guard = 0
  while (passStartDepth > bottomZ + 1e-6 && guard++ < 2000) {
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
    emitLoopback(moves, pass.points, z)
  } else if (pass.type === 'link') {
    // A link immediately before an entry is superseded by the entry's own safe
    // approach (the entry owns the reposition to the helix start), so skip it.
    const next = passes[i + 1]
    if (next && next.type === 'entry') return
    const minHelixR = finitePositive(ctx.minHelixRadius) || defaultMinHelixRadius()
    const helixAngleRad = Math.max(ctx.helixAngleDeg, 1) * Math.PI / 180
    emitLink(moves, pass, level.startZ, z, ctx, helixAngleRad, minHelixR)
  }
}

function emitFeatureLegacy(result: FeatureResult, ctx: EmitContext): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  if (!result.startPoint || result.passes.length === 0) return moves

  const { clearanceZ, topZ, bottomZ } = ctx.heights
  const minHelixR = finitePositive(ctx.minHelixRadius) || defaultMinHelixRadius()
  const helixAngleRad = Math.max(ctx.helixAngleDeg, 1) * Math.PI / 180
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
  const helixAngleRad = Math.max(ctx.helixAngleDeg, 1) * Math.PI / 180
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

/** Helix ramp (or straight plunge) entry from passStartDepth down to passEndDepth. */
function emitEntry(
  moves: ToolpathMove[], entry: Extract<AdaptivePass, { type: 'entry' }>,
  passStartDepth: number, passEndDepth: number,
  ctx: EmitContext, helixAngleRad: number, minHelixR: number,
): void {
  const { clearanceZ, retractZ, feedZ } = ctx.heights
  const { plungeRate } = ctx.feeds
  const c = entry.point

  if (entry.mode === 'side') {
    if (!entry.clearPoint) {
      throw new Error('adaptive emit: side entry is missing its fully-clear descent point')
    }
    const clear = entry.clearPoint
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
    moves.push({ type: 'rapid', x: c.x, y: c.y, z: clearanceZ, role: 'rapid' })
    moves.push({ type: 'rapid', x: c.x, y: c.y, z: retractZ, role: 'rapid' })
    moves.push({ type: 'rapid', x: c.x, y: c.y, z: feedZ, role: 'rapid' })
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
  const { clearanceZ, retractZ, feedZ } = ctx.heights
  const { plungeRate, rampRate } = ctx.feeds
  const r = Math.max(helixR - HELIX_EDGE_BACKOFF, helixR * 0.5)
  const tanAngle = Math.tan(helixAngleRad)
  const depthPerCircle = 2 * Math.PI * helixR * tanAngle
  const passDepth = passStartDepth - passEndDepth
  const maxfi = depthPerCircle > 1e-9 ? (passDepth / depthPerCircle) * 2 * Math.PI : 2 * Math.PI
  // The helix bores into material that surrounds it: material on the right is CCW.
  const travelSign = materialSideOf(ctx) === 'right' ? 1 : -1
  const offsetFi = -travelSign * maxfi - Math.PI / 16 // end near 0 deg in either direction
  const startX = c.x + r * Math.cos(offsetFi)
  const startY = c.y + r * Math.sin(offsetFi)

  // Safe approach to the helix start, then descend to the level's start depth.
  moves.push({ type: 'rapid', x: startX, y: startY, z: clearanceZ, role: 'rapid' })
  moves.push({ type: 'rapid', x: startX, y: startY, z: retractZ, role: 'rapid' })
  moves.push({ type: 'rapid', x: startX, y: startY, z: feedZ, role: 'rapid' })
  moves.push({ type: 'feed', x: startX, y: startY, z: passStartDepth, feed: plungeRate, role: 'plunge' })

  // Spiral down to the level depth (the final move lands exactly on passEndDepth).
  return helixDescent(moves, {
    centre: c, radius: r, pitchRadius: helixR, fromZ: passStartDepth, toZ: passEndDepth,
    tanAngle, feed: rampRate, startAngle: offsetFi, direction: travelSign,
    sampling: { kind: 'fixed', stepRad: HELIX_FI_STEP, maxPoints: MAX_HELIX_POINTS },
  })
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
function emitLoopback(moves: ToolpathMove[], points: { x: number; y: number }[], z: number): void {
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
  const { clearanceZ, retractZ, feedZ } = ctx.heights
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
      moves.push({ type: 'rapid', x: d.x, y: d.y, z: feedZ, role: 'rapid' })
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
  for (let i = 1; i < travel.length; i++) {
    moves.push({ type: 'feed', x: travel[i].x, y: travel[i].y, z, role: 'fast_traverse' })
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
  const stayDownZ = link.microLift ? z + link.microLift.z : clearanceZ
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
  moves.push({ type: 'feed', x: b.x, y: b.y, z, feed: ctx.feeds.plungeRate, role: 'plunge' })
}
