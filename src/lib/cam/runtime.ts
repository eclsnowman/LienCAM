// Estimated execution ("cut") time for a computed toolpath.
//
// Walks ToolpathMove[] summing segmentLength / speed.
//
// Move geometry and move speed are SEPARATE concerns. A move is geometry (points/arcs)
// plus a move type (role); the OPERATION that produced it holds the speed for each move
// type -- always known, and bounded by the machine maxima (machine limits sit above
// operation speeds in the hierarchy). Pairing a move's role with that known speed is what
// lets us simulate and time any toolpath. The postprocessor is only where the speed is
// finally WRITTEN into gcode -- not where it becomes known.
//
// Interim (until geometry and speed are fully divorced and the postprocessor exists,
// operations stamp the resolved feed onto move.feed and we read it here):
//   - rapid moves use the machine's rapidRate (mm/min)
//   - 'fast_traverse' / 'finish' moves carry no baked feed by design (ADR-0001);
//     they use the caller-supplied fastTraverseRate/finishRate, which is their
//     known operation speed.
//   - every other feed/arc move MUST carry a finite positive move.feed (mm/min);
//     a legacy/degraded move that reaches here without one REFUSES BY NAME
//     (requireFinitePositiveFeed) instead of silently guessing rapidRate --
//     the same refusal the simulation frame builder already enforces
//     (SIM-4/ADR-0003: no warn-and-continue fallback for a feedless cut).
// Arc segments use true arc length (radius x swept angle) plus any Z component.
//
// This is the diagnostic "how long will this op take to run" number. It is
// computed in the store on TOOLPATH_COMPLETE (the store has both the moves and
// the active machine); the worker payload has no machine config.
//
// WO-2024: distance / feed is NOT how long the machine takes. Full Suite Setup 1
// Adaptive (T19, 9892 short moves at F610) reads 18m57s that way; the same moves
// through the machine definition's accelerations take about twice that, because
// short adaptive segments never reach the commanded feed. When the caller hands
// in the machine's motion limits (`CutTimeMotion`, built by machineCutTimeMotion
// in src/lib/simulation/machineCutTimeMotion.ts) the estimate runs through the
// same achievable-feed planner the feed-estimate panel uses (fitted to Operator's
// measured runs, WO-1010/WO-1077). Without them it stays distance / feed - the
// only honest number when the machine states no acceleration.

import type { ToolpathMove } from '../../types'
import { estimateAchievableFeed, type AxisAccelerations } from '../simulation/achievableFeed'
import { unifyLinearSegments, type LinearUnification } from '../simulation/linearUnification'
import { sampleArcMovesForLinearConsumers } from './toolpathArcSampling'

/** WO-2024: the machine facts that bound how fast a toolpath actually runs. */
export interface CutTimeMotion {
  /** Per-axis acceleration, mm/s^2, from the machine definition. */
  axisAccelerations: AxisAccelerations
  /** Per-axis maximum velocity, mm/min. A segment never runs faster than the
   *  slowest axis it moves allows along its direction. */
  maxVelocityMmMin?: { x?: number; y?: number; z?: number }
  /** The controller's own full-stop corner angle, when its profile has one. */
  stopAtAngleDeg?: number
  /** WO-2148: the controller joins runs of short G1 moves before planning
   *  them (UCCNC linear unification), when its profile says how. */
  linearUnification?: LinearUnification
  /** WO-2148: the machine facts this estimate used, in words, for display. */
  facts?: string[]
}

interface XY { x: number; y: number }

function pointDistance(a: ToolpathMove, b: ToolpathMove): number {
  return Math.hypot(b.x - a.x, b.y - a.y, b.z - a.z)
}

/**
 * Refuse (throw) unless `feed` is a finite positive mm/min value. Shared by
 * every consumer that turns a move's baked feed into a machine speed --
 * this estimate and the simulation frame builder (SimulationPanel.buildFrames)
 * -- so a feedless/invalid cutting move refuses THE SAME WAY everywhere
 * instead of one consumer failing loud while another silently guesses a
 * fallback speed (ADR-0003).
 */
export function requireFinitePositiveFeed(feed: number | undefined, context: string): number {
  if (!Number.isFinite(feed) || (feed as number) <= 0) {
    throw new Error(`${context}: expected a finite positive feed, received ${String(feed)}.`)
  }
  return feed as number
}

/** Arc length in the XY plane from p0 to p1 about centre (cx, cy). */
function arcLengthXY(p0: XY, p1: XY, cx: number, cy: number, ccw: boolean): number {
  const r  = Math.hypot(p0.x - cx, p0.y - cy)
  const a0 = Math.atan2(p0.y - cy, p0.x - cx)
  const a1 = Math.atan2(p1.y - cy, p1.x - cx)
  let sweep = ccw ? a1 - a0 : a0 - a1
  while (sweep < 0) sweep += 2 * Math.PI
  // A ~zero sweep between two distinct endpoints means a full revolution.
  if (sweep < 1e-9 && (p0.x !== p1.x || p0.y !== p1.y)) sweep = 2 * Math.PI
  return r * sweep
}

/**
 * Estimated time (milliseconds) for the machine to execute `moves`.
 * `rapidRate` is the machine rapid traverse rate in mm/min.
 * `fastTraverseRate` is the operation's resolved fast-traverse speed (already clamped to
 * the machine rapid rate); used for `'fast_traverse'` moves, which carry geometry + move
 * type but no baked feed. Defaults to `rapidRate` when not supplied.
 * `finishRate` is the operation's resolved wall-finish speed (resolveFeedrates defaults it
 * to the cutting feed); used for `'finish'` moves, which likewise carry geometry but no
 * baked feed. Defaults to `rapidRate` when not supplied (degraded callers that have no
 * resolved feeds), matching the fast-traverse convention.
 * A move's `dwellMs` (timed pause after it arrives) is added on top of the travel time;
 * a dwell that is not a finite non-negative number refuses by name (WO-1516).
 */
export function estimateRuntimeMs(
  moves: ToolpathMove[], rapidRate: number, fastTraverseRate: number = rapidRate,
  finishRate: number = rapidRate, motion?: CutTimeMotion | null,
): number {
  if (!moves || moves.length === 0) return 0
  let dwellMs = 0
  for (let i = 0; i < moves.length; i++) {
    const d = moves[i].dwellMs
    if (d === undefined) continue
    if (!Number.isFinite(d) || d < 0) {
      throw new Error(`estimateRuntimeMs refused move ${i}: expected a finite non-negative dwell, received ${String(d)}.`)
    }
    dwellMs += d
  }
  const speedOf = (m: ToolpathMove, i: number): number => m.role === 'fast_traverse'
    ? fastTraverseRate
    : m.role === 'finish'
      ? finishRate
      : m.type === 'rapid'
        ? rapidRate
        : requireFinitePositiveFeed(m.feed, `estimateRuntimeMs refused move ${i} (${m.role ?? 'cut'})`)
  if (motion) {
    const planned = plannedRuntimeMs(moves, speedOf, motion)
    if (planned !== null) return planned + dwellMs
  }
  let minutes = 0
  let prev = moves[0]
  for (let i = 1; i < moves.length; i++) {
    const m  = moves[i]
    const dz = m.z - prev.z
    let len: number
    if ((m.type === 'arc_cw' || m.type === 'arc_ccw') && m.cx !== undefined && m.cy !== undefined) {
      len = Math.hypot(arcLengthXY(prev, m, m.cx, m.cy, m.type === 'arc_ccw'), dz)
    } else {
      len = Math.hypot(m.x - prev.x, m.y - prev.y, dz)
    }
    const speed = speedOf(m, i)
    if (speed > 0) minutes += len / speed
    prev = m
  }
  return minutes * 60000 + dwellMs
}

/**
 * WO-2024: travel time through the machine's accelerations. Arcs are walked as
 * the same short chords the viewport and feed-estimate panel use; each chord's
 * commanded speed is its move's speed, capped by the slowest axis along its
 * direction. Null when the motion limits do not cover every axis the path moves
 * (the planner's own answer), so the caller falls back to distance / feed.
 */
function plannedRuntimeMs(
  moves: ToolpathMove[],
  speedOf: (m: ToolpathMove, i: number) => number,
  motion: CutTimeMotion,
): number | null {
  const durations = plannedMoveDurationsMs(moves, speedOf, motion)
  return durations ? durations.reduce((sum, ms) => sum + ms, 0) : null
}

/**
 * WO-2024: the same plan, per ORIGINAL move - entry i is how long moves[i]
 * takes to reach its endpoint from moves[i - 1] (entry 0 is always 0). An arc's
 * chords are summed back into the arc. The simulator paces each program move by
 * this, so its run takes the time the estimate states. Travel only; dwells are
 * the caller's.
 */
export function plannedMoveDurationsMs(
  moves: ToolpathMove[],
  speedOf: (m: ToolpathMove, i: number) => number,
  motion: CutTimeMotion,
): number[] | null {
  const sampledOrigin: number[] = []
  const sampledAll = sampleArcMovesForLinearConsumers(moves, {}, sampledOrigin)
  // Validate every move's speed against its ORIGINAL index first, so a feedless
  // cut refuses by the same name whether or not the machine has accelerations.
  const speeds = moves.map((m, i) => (i === 0 ? 0 : speedOf(m, i)))
  // WO-2148: plan the lines the controller plans - short G1 runs joined.
  const unification = motion.linearUnification
  const kept = unification
    ? unifyLinearSegments(sampledAll, (segment, first) => {
      const move = moves[sampledOrigin[segment]]
      const firstIndex = sampledOrigin[first]
      return move.type === 'feed' && moves[firstIndex].type === 'feed'
        && speeds[sampledOrigin[segment]] === speeds[firstIndex]
    }, unification)
    : null
  const sampled = kept ? kept.map((k) => sampledAll[k]) : sampledAll
  const origin = kept ? kept.map((k) => sampledOrigin[k]) : sampledOrigin
  const arcRadius = (i: number): number | undefined => {
    const m = moves[i]
    if ((m.type !== 'arc_cw' && m.type !== 'arc_ccw') || m.cx === undefined || m.cy === undefined) return undefined
    return Math.hypot(m.x - m.cx, m.y - m.cy)
  }
  const vmax = motion.maxVelocityMmMin
  const estimate = estimateAchievableFeed(sampled, {
    axisAccelerations: motion.axisAccelerations,
    arcRadiusMm: (before, after) => (origin[before] === origin[after] ? arcRadius(origin[after]) : undefined),
    commandedFeedMmMin: (m, i) => {
      let speed = speeds[origin[i]]
      if (vmax) {
        const p = sampled[i - 1]
        const len = Math.hypot(m.x - p.x, m.y - p.y, m.z - p.z)
        const axes: Array<[number, number | undefined]> = [
          [m.x - p.x, vmax.x], [m.y - p.y, vmax.y], [m.z - p.z, vmax.z],
        ]
        for (const [d, limit] of axes) {
          if (Number.isFinite(limit) && (limit as number) > 0 && Math.abs(d) > 1e-12) {
            speed = Math.min(speed, (limit as number) * len / Math.abs(d))
          }
        }
      }
      return speed
    },
    isRapid: (m) => m.type === 'rapid',
    stopAtAngleDeg: motion.stopAtAngleDeg,
  })
  if (!estimate) return null
  const durations = new Array<number>(moves.length).fill(0)
  if (!kept) {
    for (const segment of estimate.segments) durations[origin[segment.moveIndex]] += segment.estimatedDurationMs
    return durations
  }
  // A joined line's time goes back to the program moves it covers, by length.
  for (const segment of estimate.segments) {
    const from = kept[segment.moveIndex - 1]
    const to = kept[segment.moveIndex]
    let total = 0
    for (let k = from + 1; k <= to; k++) total += pointDistance(sampledAll[k - 1], sampledAll[k])
    for (let k = from + 1; k <= to; k++) {
      const share = total > 0 ? pointDistance(sampledAll[k - 1], sampledAll[k]) / total : 1 / (to - from)
      durations[sampledOrigin[k]] += segment.estimatedDurationMs * share
    }
  }
  return durations
}

/** Cut-time estimate result: exactly one of `ms` / `error` is set. */
export type CutTimeEstimate = { ms: number; error?: undefined } | { ms?: undefined; error: string }

/**
 * `estimateRuntimeMs`, refused-by-name errors caught and turned into a named
 * result instead of an uncaught throw reaching the store's compute-complete
 * handler. The op card renders `ms` as a duration or `error` as a refusal
 * state -- never a silently-substituted rapidRate number (ADR-0003; BK-137).
 */
export function estimateRuntimeMsOrError(
  moves: ToolpathMove[], rapidRate: number, fastTraverseRate: number = rapidRate,
  finishRate: number = rapidRate, motion?: CutTimeMotion | null,
): CutTimeEstimate {
  try {
    return { ms: estimateRuntimeMs(moves, rapidRate, fastTraverseRate, finishRate, motion) }
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) }
  }
}
