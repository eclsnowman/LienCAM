// WO-3034 (alpha.3 A3-21): re-hosted copy of src/lib/simulation/achievableFeed.ts for the kernel estimators
// (draft WO-A3-21: today's time model is re-hosted as copies; the current engine's
// file is not touched). Kept verbatim below this header so post-plan time equals
// the store's estimatedCutTimeMs; estimators.wo3034.test.ts pins that parity.
/**
 * O(n) achievable-feed planner for a linearly sampled toolpath.
 *
 * Acceleration is stored per machine axis in mm/s^2. For a segment direction
 * u, path acceleration is bounded by min(axisAcceleration / |uAxis|). A
 * chord-independent curvature cap, v = sqrt(c * a * R), limits sampled curves
 * by their local radius rather than their segment length; a vertex turning
 * more than CURVE_VERTEX_MAX_DEG is a corner and caps only the speed through
 * it, and a programmed arc is planned from its own radius (WO-2148). A forward/backward
 * pass then makes every boundary speed reachable from both sides, and segment
 * duration comes from the resulting trapezoid or triangle.
 */

export interface FeedEstimatePoint {
  x: number
  y: number
  z: number
}

export interface AxisAccelerations {
  x?: number
  y?: number
  z?: number
}

/** Fitted to WO-1010 and WO-1077's seven measured runs on Operator's machine. */
export const DEFAULT_CURVATURE_ACCELERATION_FRACTION = 0.066

/**
 * WO-2148: a vertex that turns more than this is a CORNER, not a sample of a
 * curve. Through a curve's samples (the seven calibration runs turn 0.3-2.9 deg
 * per vertex) the whole chord runs at the curve speed. Out of a corner the
 * machine accelerates again on the next segment: the corner limits only the
 * junction speed. Fitted on the program that ran on the machine PC on 2026-09-26
 * (Full Suite Setup 1, src/tests/evidence/WO-2148/GAP.md): any value from 3 to
 * 10 deg puts the Adaptive within 2% of its measured time; capping every
 * segment's cruise (the WO-1071 model) read it 31% long.
 */
export const CURVE_VERTEX_MAX_DEG = 5

/**
 * WO-2148: share of axis acceleration a programmed G2/G3 arc gets as
 * centripetal acceleration. The controller knows an arc's true radius and runs
 * it at sqrt(a * R); the 0.066 curvature fraction is what it manages on a curve
 * it has to infer from G1 chords. Measured on the same run: the Adaptive's
 * arcs at 0.066 read the op 9% long, at 1 within 1%.
 */
export const ARC_ACCELERATION_FRACTION = 1

export interface AchievableFeedOptions<T extends FeedEstimatePoint> {
  axisAccelerations: AxisAccelerations | null | undefined
  /** Effective commanded rate for this move, including rapid/by-role rates. */
  commandedFeedMmMin: (move: T, moveIndex: number) => number
  /** Rapid and cutting chains never blend into one another. */
  isRapid?: (move: T, moveIndex: number) => boolean
  /** Select the segments represented by the operation feed range/chipload. */
  includeInFeedSummary?: (move: T, moveIndex: number) => boolean
  /** Fraction of configured axis acceleration available to sustained curvature. */
  curvatureAccelerationFraction?: number
  /** Direction change above which the controller comes to a full stop. */
  stopAtAngleDeg?: number
  /** WO-2148: largest vertex turn still sampling a curve (CURVE_VERTEX_MAX_DEG). */
  curveVertexMaxDeg?: number
  /** WO-2148: the true radius (mm) of the programmed arc both segments meeting
   *  at a vertex belong to, when they do. Such a vertex is planned from the
   *  arc's radius (ARC_ACCELERATION_FRACTION), not from its chords. */
  arcRadiusMm?: (beforeMoveIndex: number, afterMoveIndex: number) => number | undefined
}

export interface AchievableFeedSegment {
  moveIndex: number
  lengthMm: number
  commandedFeedMmMin: number
  /** Effective distance/time feed over this segment. */
  estimatedFeedMmMin: number
  entryFeedMmMin: number
  exitFeedMmMin: number
  peakFeedMmMin: number
  estimatedDurationMs: number
  theoreticalDurationMs: number
  rapid: boolean
  includedInFeedSummary: boolean
  blendedSegmentCount: number
}

export interface FeedRangeEstimate {
  minMmMin: number
  typicalMmMin: number
}

export interface AchievableFeedEstimate {
  segments: AchievableFeedSegment[]
  estimatedCycleTimeMs: number
  theoreticalCycleTimeMs: number
  commandedFeed: FeedRangeEstimate | null
  estimatedFeed: FeedRangeEstimate | null
}

interface PlannedSegment {
  accelerationMmSec2: number
  feedLimitMmSec: number
  ux: number
  uy: number
  uz: number
}

const EPS = 1e-9
const STRAIGHT_DOT = 1 - 1e-12

function positive(value: number | undefined): value is number {
  return Number.isFinite(value) && (value as number) > 0
}

function pathAcceleration(
  ux: number,
  uy: number,
  uz: number,
  acceleration: AxisAccelerations,
): number | null {
  let limit = Infinity
  if (Math.abs(ux) > EPS) {
    if (!positive(acceleration.x)) return null
    limit = Math.min(limit, acceleration.x / Math.abs(ux))
  }
  if (Math.abs(uy) > EPS) {
    if (!positive(acceleration.y)) return null
    limit = Math.min(limit, acceleration.y / Math.abs(uy))
  }
  if (Math.abs(uz) > EPS) {
    if (!positive(acceleration.z)) return null
    limit = Math.min(limit, acceleration.z / Math.abs(uz))
  }
  return Number.isFinite(limit) ? limit : null
}

function clamp(value: number, low: number, high: number): number {
  return Math.max(low, Math.min(high, value))
}

/**
 * The controller data selected a curvature family, not a per-chord junction
 * family. Use the configured acceleration of every axis whose direction is
 * changing; projecting by |uAxis| here would make an XY circle artificially
 * faster around its diagonals even though the measured calibration uses the
 * configured axis acceleration in force.
 */
function curvatureAcceleration(
  previous: PlannedSegment,
  next: PlannedSegment,
  acceleration: AxisAccelerations,
): number | null {
  let limit = Infinity
  const changed = [
    [previous.ux, next.ux, acceleration.x],
    [previous.uy, next.uy, acceleration.y],
    [previous.uz, next.uz, acceleration.z],
  ] as const
  for (const [before, after, axisAcceleration] of changed) {
    if (Math.abs(before - after) <= EPS) continue
    if (!positive(axisAcceleration)) return null
    limit = Math.min(limit, axisAcceleration)
  }
  return Number.isFinite(limit) ? limit : null
}

function segmentProfile(
  lengthMm: number,
  accelerationMmSec2: number,
  commandedMmSec: number,
  entryMmSec: number,
  exitMmSec: number,
): { durationSec: number; peakMmSec: number } {
  const accelerationDistance = Math.max(0,
    (commandedMmSec ** 2 - entryMmSec ** 2) / (2 * accelerationMmSec2))
  const decelerationDistance = Math.max(0,
    (commandedMmSec ** 2 - exitMmSec ** 2) / (2 * accelerationMmSec2))

  if (accelerationDistance + decelerationDistance <= lengthMm) {
    const cruiseDistance = lengthMm - accelerationDistance - decelerationDistance
    return {
      durationSec: (commandedMmSec - entryMmSec) / accelerationMmSec2
        + cruiseDistance / commandedMmSec
        + (commandedMmSec - exitMmSec) / accelerationMmSec2,
      peakMmSec: commandedMmSec,
    }
  }

  const peakMmSec = Math.min(
    commandedMmSec,
    Math.sqrt(accelerationMmSec2 * lengthMm + (entryMmSec ** 2 + exitMmSec ** 2) / 2),
  )
  return {
    durationSec: (peakMmSec - entryMmSec) / accelerationMmSec2
      + (peakMmSec - exitMmSec) / accelerationMmSec2,
    peakMmSec,
  }
}

/**
 * Estimate achievable feed per non-zero segment and the resulting cycle time.
 * Returns null when acceleration is absent for any axis the stream moves.
 */
export function estimateAchievableFeed<T extends FeedEstimatePoint>(
  moves: readonly T[],
  options: AchievableFeedOptions<T>,
): AchievableFeedEstimate | null {
  const acceleration = options.axisAccelerations
  if (!acceleration) return null
  const curvatureAccelerationFraction = options.curvatureAccelerationFraction
    ?? DEFAULT_CURVATURE_ACCELERATION_FRACTION
  if (!positive(curvatureAccelerationFraction)) {
    throw new Error(`Achievable-feed estimate expected a finite positive curvature acceleration fraction, received ${String(curvatureAccelerationFraction)}.`)
  }
  const stopAtAngleDeg = Number.isFinite(options.stopAtAngleDeg)
    && (options.stopAtAngleDeg as number) >= 0
    && (options.stopAtAngleDeg as number) <= 180
    ? options.stopAtAngleDeg
    : undefined
  const curveVertexMaxDeg = options.curveVertexMaxDeg ?? CURVE_VERTEX_MAX_DEG

  const segments: AchievableFeedSegment[] = []
  const planned: PlannedSegment[] = []
  if (moves.length >= 2) {
    let previous = moves[0]
    for (let moveIndex = 1; moveIndex < moves.length; moveIndex++) {
      const move = moves[moveIndex]
      const dx = move.x - previous.x
      const dy = move.y - previous.y
      const dz = move.z - previous.z
      const lengthMm = Math.hypot(dx, dy, dz)
      previous = move
      if (!(lengthMm > EPS)) continue

      const ux = dx / lengthMm
      const uy = dy / lengthMm
      const uz = dz / lengthMm
      const accelerationMmSec2 = pathAcceleration(ux, uy, uz, acceleration)
      if (accelerationMmSec2 == null) return null

      const commandedFeedMmMin = options.commandedFeedMmMin(move, moveIndex)
      if (!positive(commandedFeedMmMin)) {
        throw new Error(
          `Achievable-feed estimate refused move ${moveIndex}: expected a finite positive commanded feed, received ${String(commandedFeedMmMin)}.`,
        )
      }
      const rapid = options.isRapid?.(move, moveIndex) ?? false
      segments.push({
        moveIndex,
        lengthMm,
        commandedFeedMmMin,
        estimatedFeedMmMin: 0,
        entryFeedMmMin: 0,
        exitFeedMmMin: 0,
        peakFeedMmMin: 0,
        estimatedDurationMs: 0,
        theoreticalDurationMs: lengthMm / commandedFeedMmMin * 60000,
        rapid,
        includedInFeedSummary: options.includeInFeedSummary?.(move, moveIndex) ?? !rapid,
        blendedSegmentCount: 1,
      })
      planned.push({
        accelerationMmSec2,
        feedLimitMmSec: commandedFeedMmMin / 60,
        ux,
        uy,
        uz,
      })
    }
  }

  const boundaryCaps = new Array<number>(segments.length + 1).fill(Infinity)
  const hardStops = new Array<boolean>(segments.length + 1).fill(false)
  const junctionCaps = new Array<number>(segments.length + 1).fill(Infinity)
  boundaryCaps[0] = 0
  boundaryCaps[segments.length] = 0
  for (let boundary = 1; boundary < segments.length; boundary++) {
    const before = segments[boundary - 1]
    const after = segments[boundary]
    if (before.rapid !== after.rapid) {
      hardStops[boundary] = true
      continue
    }

    const previousPlan = planned[boundary - 1]
    const nextPlan = planned[boundary]
    const dot = clamp(
      previousPlan.ux * nextPlan.ux
        + previousPlan.uy * nextPlan.uy
        + previousPlan.uz * nextPlan.uz,
      -1,
      1,
    )
    if (dot >= STRAIGHT_DOT) continue

    const directionChangeRad = Math.acos(dot)
    const directionChangeDeg = directionChangeRad * 180 / Math.PI
    if (stopAtAngleDeg !== undefined && directionChangeDeg > stopAtAngleDeg) {
      hardStops[boundary] = true
      continue
    }

    const cornerAcceleration = curvatureAcceleration(previousPlan, nextPlan, acceleration)
    if (cornerAcceleration == null) return null
    const arcRadius = options.arcRadiusMm?.(before.moveIndex, after.moveIndex)
    if (arcRadius !== undefined && positive(arcRadius)) {
      // WO-2148: inside a programmed arc - its own radius, both chords.
      const arcSpeed = Math.sqrt(ARC_ACCELERATION_FRACTION * cornerAcceleration * arcRadius)
      previousPlan.feedLimitMmSec = Math.min(previousPlan.feedLimitMmSec, arcSpeed)
      nextPlan.feedLimitMmSec = Math.min(nextPlan.feedLimitMmSec, arcSpeed)
      continue
    }
    const speedFactor = curvatureAccelerationFraction * cornerAcceleration / directionChangeRad
    const beforeSpeed = Math.sqrt(speedFactor * before.lengthMm)
    const afterSpeed = Math.sqrt(speedFactor * after.lengthMm)
    if (directionChangeDeg > curveVertexMaxDeg) {
      // WO-2148: a corner limits the speed through it, not the segments'
      // cruise - a 28 mm link after a 24 deg kink still reaches its feed.
      junctionCaps[boundary] = Math.min(beforeSpeed, afterSpeed)
      continue
    }
    previousPlan.feedLimitMmSec = Math.min(previousPlan.feedLimitMmSec, beforeSpeed)
    nextPlan.feedLimitMmSec = Math.min(nextPlan.feedLimitMmSec, afterSpeed)
  }
  for (let boundary = 1; boundary < segments.length; boundary++) {
    boundaryCaps[boundary] = hardStops[boundary]
      ? 0
      : Math.min(
          planned[boundary - 1].feedLimitMmSec,
          planned[boundary].feedLimitMmSec,
          junctionCaps[boundary],
        )
  }

  const boundarySpeeds = new Array<number>(segments.length + 1).fill(0)
  for (let i = 0; i < segments.length; i++) {
    boundarySpeeds[i + 1] = Math.min(
      boundaryCaps[i + 1],
      planned[i].feedLimitMmSec,
      Math.sqrt(boundarySpeeds[i] ** 2 + 2 * planned[i].accelerationMmSec2 * segments[i].lengthMm),
    )
  }
  for (let i = segments.length - 1; i >= 0; i--) {
    boundarySpeeds[i] = Math.min(
      boundarySpeeds[i],
      planned[i].feedLimitMmSec,
      Math.sqrt(boundarySpeeds[i + 1] ** 2 + 2 * planned[i].accelerationMmSec2 * segments[i].lengthMm),
    )
  }

  for (let chainStart = 0; chainStart < segments.length;) {
    let chainEnd = chainStart + 1
    while (chainEnd < segments.length && boundaryCaps[chainEnd] > EPS) chainEnd++
    const count = chainEnd - chainStart
    for (let i = chainStart; i < chainEnd; i++) segments[i].blendedSegmentCount = count
    chainStart = chainEnd
  }

  let estimatedCycleTimeMs = 0
  let theoreticalCycleTimeMs = 0
  let summaryDistanceMm = 0
  let summaryEstimatedMs = 0
  let summaryTheoreticalMs = 0
  let minEstimatedFeedMmMin = Infinity
  let minCommandedFeedMmMin = Infinity

  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i]
    const entryMmSec = boundarySpeeds[i]
    const exitMmSec = boundarySpeeds[i + 1]
    const profile = segmentProfile(
      segment.lengthMm,
      planned[i].accelerationMmSec2,
      planned[i].feedLimitMmSec,
      entryMmSec,
      exitMmSec,
    )
    segment.entryFeedMmMin = entryMmSec * 60
    segment.exitFeedMmMin = exitMmSec * 60
    segment.peakFeedMmMin = profile.peakMmSec * 60
    segment.estimatedDurationMs = profile.durationSec * 1000
    segment.estimatedFeedMmMin = segment.lengthMm / segment.estimatedDurationMs * 60000
    estimatedCycleTimeMs += segment.estimatedDurationMs
    theoreticalCycleTimeMs += segment.theoreticalDurationMs
    if (segment.includedInFeedSummary) {
      summaryDistanceMm += segment.lengthMm
      summaryEstimatedMs += segment.estimatedDurationMs
      summaryTheoreticalMs += segment.theoreticalDurationMs
      minEstimatedFeedMmMin = Math.min(minEstimatedFeedMmMin, segment.estimatedFeedMmMin)
      minCommandedFeedMmMin = Math.min(minCommandedFeedMmMin, segment.commandedFeedMmMin)
    }
  }

  const commandedFeed = summaryDistanceMm > 0 && summaryTheoreticalMs > 0
    ? {
        minMmMin: minCommandedFeedMmMin,
        typicalMmMin: summaryDistanceMm / summaryTheoreticalMs * 60000,
      }
    : null
  const estimatedFeed = summaryDistanceMm > 0 && summaryEstimatedMs > 0
    ? {
        minMmMin: minEstimatedFeedMmMin,
        typicalMmMin: summaryDistanceMm / summaryEstimatedMs * 60000,
      }
    : null

  return {
    segments,
    estimatedCycleTimeMs,
    theoreticalCycleTimeMs,
    commandedFeed,
    estimatedFeed,
  }
}
