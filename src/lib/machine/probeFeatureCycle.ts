// Feature-aware workpiece probe planning (WO-372).
//
// This module is intentionally pure. It turns operator-reviewed geometry and
// a homed machine envelope into named positioning/touch steps. It never sends
// motion and never guesses around missing geometry.

import type { MachineEnvelope } from './machineEnvelope'
import type { EffectiveProbeConfig } from './toolTable'
import type { WorkProbeAxis, WorkProbeDirection } from './probeRoutines'

export type ProbeFeatureKind =
  | 'edge'
  | 'corner'
  | 'insideCorner'
  | 'outsideCorner'
  | 'bore'
  | 'boss'
  | 'rectPocket'
  | 'rectBoss'
  | 'angle'
export type ProbeCycleTouchKey =
  | 'edge'
  | 'cornerX'
  | 'cornerY'
  | 'xNegative'
  | 'xPositive'
  | 'yNegative'
  | 'yPositive'
  | 'angleFirst'
  | 'angleSecond'

export interface ProbeCyclePoint {
  x: number
  y: number
  z: number
}

export interface ProbeCyclePositionStep {
  kind: 'position'
  label: string
  target: ProbeCyclePoint
  axes: Array<'X' | 'Y' | 'Z'>
}

export interface ProbeCycleTouchStep {
  kind: 'touch'
  key: ProbeCycleTouchKey
  label: string
  axis: WorkProbeAxis
  direction: WorkProbeDirection
  travelMm: number
  expectedStart: ProbeCyclePoint
  /** WO-2055: this touch is made from the top the cycle touched first
   *  (`ProbeFeatureCyclePlan.fromTop`). Before it the runner rises to safe
   *  height (top + clearance), crosses to `expectedStart`'s X and Y there, and
   *  descends to probing depth (top - depth) as a probe move that stops on
   *  contact; after it, it rises to safe height again. `expectedStart.z` is the
   *  start Z: the probing depth is known only once the top has been touched. */
  descendFromTop?: boolean
}

/** WO-2057: a hole routine's way down (Inside corner, Bore, Rect pocket). The
 *  runner rises to safe height (top + clearance) when it stands below it,
 *  crosses to `target`'s X and Y there (from above safe height it crosses where
 *  it stands, which is higher), and descends to probing depth (top - depth) as
 *  a probe move that stops on contact. `target.z` is the start Z: the heights
 *  are known only once the top is. */
export interface ProbeCycleDescendStep {
  kind: 'descend'
  label: string
  target: ProbeCyclePoint
}

/** WO-2057: rise straight up to safe height (top + clearance). */
export interface ProbeCycleRiseStep {
  kind: 'rise'
  label: string
}

export type ProbeCycleStep = ProbeCyclePositionStep | ProbeCycleTouchStep | ProbeCycleDescendStep | ProbeCycleRiseStep

export type ProbeCycleClearMotion =
  | { kind: 'bore-center'; center: ProbeCyclePoint }
  | { kind: 'boss-cross-over'; center: ProbeCyclePoint; liftMm: number; crossOverZMm: number }
  /** WO-2058: a boss started over the middle crosses at top + clearance - the
   *  top it touched first, so the height is known only once it has. */
  | { kind: 'boss-from-top'; center: ProbeCyclePoint; clearanceMm: number; depthMm: number }
  | { kind: 'corner-step-off' }
  | { kind: 'angle-two-point'; nominalAxis: WorkProbeAxis; spacingMm: number }
  | { kind: 'edge-only' }

export interface ProbeCycleReview {
  touchOrder: Array<{
    key: ProbeCycleTouchKey
    axis: WorkProbeAxis
    direction: WorkProbeDirection
  }>
  approachClearanceMm: number | null
  positioningFeedMmMin: number
  searchFeedMmMin: number
  probeFeedMmMin: number
  clearMotion: ProbeCycleClearMotion
}

export interface ProbeFeatureCyclePlan {
  kind: ProbeFeatureKind
  steps: ProbeCycleStep[]
  expectedCenter: ProbeCyclePoint | null
  searchTravelMm: number
  /** Internal seeks stop at the stated machine limits, even after a back-off. */
  internalSearchEnvelope?: MachineEnvelope
  stepOffMm: number
  summary: string
  /** Operator-facing facts are carried by the executable plan itself. The UI
   *  must render this record rather than re-derive a second description that
   *  could drift away from the steps runFeatureProbeCycle will execute. */
  review: ProbeCycleReview
  /** WO-2055: the heights a routine that starts over the material works from.
   *  Absent or null: every step runs at the Z it names, as before. */
  fromTop?: ProbeCycleFromTop | null
}

/**
 * WO-2055 (docs/design/PROBING-PAINT-BY-NUMBERS.md 4.1): Edge and Angle start
 * OVER the material, at any height above it - and Outside corner too since
 * WO-2056 (4.2), and Boss and Rect boss, over the middle, since WO-2058. The
 * cycle's first move touches the top there; every touch
 * marked `descendFromTop` then works from that top.
 */
export interface ProbeCycleFromTop {
  /** A Z- touch where the operator left the probe. Its contact is the top.
   *  Null for a hole routine (WO-2057): the probe stands over the hole, so the
   *  top is `knownTop` instead. */
  topTouch: { label: string; at: ProbeCyclePoint; travelMm: number } | null
  /** WO-2057 (design 4.1): the top of a hole routine, known before Run - work
   *  Z0 (the hole is in the face Z0 was probed on; the runner reads it from the
   *  controller's machine and work Z) or the rim the operator touched first. */
  knownTop?: ProbeCycleKnownTop
  /** Safe height = top + this. Every step-out crosses at it. */
  clearanceMm: number
  /** Probing depth = top - this. Every side touch runs at it. */
  depthMm: number
  /** How far each touch's start is stepped out past the face from where the
   *  operator stood: start distance + tip radius + clearance. Boss and Rect
   *  boss (WO-2058) step out from the middle: nominal X half-size + tip radius
   *  + clearance (the Y faces use the Y half-size). */
  stepOutMm: number
  /** The older plan - every touch from where the probe stands, no top touch
   *  and no descent (Outside corner goes around the corner at that height) -
   *  exactly as planned with `approachFromTop: false`. WO-2800 (Operator 10-14):
   *  the runner never runs it in place of this plan, on any route; a
   *  controller that cannot descend says so and moves nothing. */
  besideTheFace: ProbeFeatureCyclePlanResult
}

/** WO-2057: where a hole routine's top comes from. */
export type ProbeCycleKnownTop =
  | { source: 'workZero' }
  | { source: 'rim'; machineZ: number }

export interface PlanFeatureProbeCycleInput {
  kind: ProbeFeatureKind
  start: ProbeCyclePoint
  envelope: MachineEnvelope
  config: EffectiveProbeConfig
  /** The side-touch compensation radius: the tip radius, plus the plate when
   *  the face is sensed through one (sideCompensationRadiusMm). */
  tipRadiusMm: number
  nominalSizeXmm?: number
  nominalSizeYmm?: number
  edgeAxis?: WorkProbeAxis
  edgeDirection?: WorkProbeDirection
  cornerXDirection?: WorkProbeDirection
  cornerYDirection?: WorkProbeDirection
  angleNominalAxis?: WorkProbeAxis
  angleProbeDirection?: WorkProbeDirection
  angleAlongDirection?: WorkProbeDirection
  angleSpacingMm?: number
  /** WO-2035: machine Z of the boss top, when the routine has been told it
   *  (the operator's entry or a Z0 probe). Boss cross-overs clear it by the
   *  surface clearance. Absent: the cross-over runs at the machine's safe Z. */
  bossTopMachineZMm?: number | null
  /** WO-2035: the machine's safe Z. Absent: the top of Z travel less 1 mm. */
  safeZMachineMm?: number | null
  /** WO-2055: Edge and Angle (and Outside corner, WO-2056) start over the
   *  material and work from its top; Inside corner, Bore and Rect pocket
   *  (WO-2057) start over the hole and descend from its top; Boss and Rect
   *  boss (WO-2058) start over the middle and work from its top. Default true. False keeps the older plan - every touch from where the
   *  probe stands - for a caller whose own screen still tells the operator to
   *  start beside the face at probing depth (the pendant). */
  approachFromTop?: boolean
  /** WO-2055: how far inside the face the operator may start. Default 10 mm. */
  startDistanceMm?: number
  /** WO-2055: probing depth below the top. Default 5 mm. */
  depthBelowTopMm?: number
  /** WO-2108: how far the first Z touch searches down for the top (Edge,
   *  Outside corner, Angle, Boss, Rect boss); never more than the machine's
   *  maximum probe travel. The Probing screen always gives it (its field,
   *  default DEFAULT_TOP_SEARCH_MM). Absent: the maximum probe travel. */
  topSearchMm?: number
  /** WO-2057: machine Z of the rim the operator touched (jog over the rim,
   *  Touch top) for Inside corner, Bore and Rect pocket. Absent or null: the
   *  top is work Z0 - the hole is in the face Z0 was probed on. */
  rimTopMachineZMm?: number | null
  /** WO-2266 (Operator 2026-09-30, a boss with a hole in its middle): Boss and
   *  Rect boss take their top from work Z0, as the hole routines do, and touch
   *  nothing over the middle. Absent or false: they touch the top first. */
  topFromWorkZero?: boolean
}

/**
 * WO-2059: HOW THE FACE IS SENSED. 'probe' - the probe touches the part
 * itself; 'plate' - a plate of thickness T is held against the face and the
 * probe touches the plate. T is the tool table's pad thickness (WO-1979), the
 * same stored field Z0 uses. The first-time default is 'probe' (0 mm): until
 * 2026-09-26 Z0 subtracted the 10 mm default pad even when the tip touched the
 * part directly.
 */
export type ProbeSensing = 'probe' | 'plate'
export const DEFAULT_PROBE_SENSING: ProbeSensing = 'probe'

/** The thickness a touch is sensed through: T for a plate, 0 for the probe. */
export function sensedPlateMm(sensing: ProbeSensing, config: Pick<EffectiveProbeConfig, 'padThickness'>): number {
  return sensing === 'plate' ? config.padThickness : 0
}

/** A side touch stops one tip radius, plus the plate, short of the face. This
 *  is the radius every side result and every stand-off is compensated by. */
export function sideCompensationRadiusMm(
  tipRadiusMm: number,
  sensing: ProbeSensing,
  config: Pick<EffectiveProbeConfig, 'padThickness'>,
): number {
  return round4(tipRadiusMm + sensedPlateMm(sensing, config))
}

export type ProbeFeatureCyclePlanResult =
  | { ok: true; plan: ProbeFeatureCyclePlan }
  | { ok: false; reason: string }

const ROUND_TOUCHES: ReadonlyArray<{
  key: ProbeCycleTouchKey
  axis: WorkProbeAxis
  direction: WorkProbeDirection
}> = [
  { key: 'xNegative', axis: 'X', direction: '-' },
  { key: 'xPositive', axis: 'X', direction: '+' },
  { key: 'yNegative', axis: 'Y', direction: '-' },
  { key: 'yPositive', axis: 'Y', direction: '+' },
]

function round4(value: number): number {
  return Number(value.toFixed(4))
}

/** WO-2036: how far an XY touch searches - the distance to the face plus
 *  overtravel, never the full maximum travel. The slow re-touch has its own
 *  reach (twice the retract from the backed-off point), so the retract never
 *  lengthens the search (audit 4). ONE rule: the guided plan, the manual
 *  touch and the panel note all use it. */
export function xyTouchSearchMm(cfg: { maxTravel: number; surfaceClearance: number; overtravel: number }): number {
  return round4(Math.min(cfg.maxTravel, cfg.surfaceClearance + cfg.overtravel))
}

/** How far below the top of Z travel the Z0 end height may reach, so the rise
 *  never ends on the soft limit itself (the boss cross-over's margin). */
const WORK_ZERO_END_BELOW_Z_TOP_MM = 1

/**
 * WO-2061 (design 4.4, "Z0 end"): the machine Z probe work Z0 leaves the probe
 * at - the top it just measured (contact less the pad) plus the surface
 * clearance, ready for the next routine's step-out. It used to end 2 mm above
 * the touch. Never below that back-off: a pad thicker than the clearance still
 * sits under the probe until the operator lifts it away. Kept 1 mm under the
 * top of Z travel when the machine states one, but never below the back-off.
 */
export function workZeroEndMachineZ(input: {
  contactMachineZ: number
  padThicknessMm: number
  surfaceClearanceMm: number
  retractMm: number
  zTopMachineZ?: number | null
}): number {
  const backedOff = input.contactMachineZ + input.retractMm
  const clear = input.contactMachineZ - input.padThicknessMm + input.surfaceClearanceMm
  let end = Math.max(backedOff, clear)
  const zTop = input.zTopMachineZ
  if (typeof zTop === 'number' && Number.isFinite(zTop)) {
    end = Math.max(backedOff, Math.min(end, zTop - WORK_ZERO_END_BELOW_Z_TOP_MM))
  }
  return round4(end)
}

/** WO-2064: the largest height change a Z surface mesh expects between point 1
 *  and any other point, until the operator says otherwise (design 4.4). */
export const DEFAULT_MESH_HEIGHT_CHANGE_MM = 5

/** WO-2064: how far a mesh point after point 1 searches down. Every move
 *  between points runs at point 1's top + clearance, so the search is that
 *  clearance plus the largest height change expected - reaching that far below
 *  point 1's top, never the full maximum travel (capped at it). */
export function meshPointSearchMm(
  cfg: { maxTravel: number; surfaceClearance: number },
  largestHeightChangeMm: number = DEFAULT_MESH_HEIGHT_CHANGE_MM,
): number {
  return round4(Math.min(cfg.maxTravel, cfg.surfaceClearance + largestHeightChangeMm))
}

function finitePositive(value: number | undefined): value is number {
  return value !== undefined && Number.isFinite(value) && value > 0
}

function fullEnvelope(envelope: MachineEnvelope): envelope is {
  x: NonNullable<MachineEnvelope['x']>
  y: NonNullable<MachineEnvelope['y']>
  z: NonNullable<MachineEnvelope['z']>
} {
  return envelope.x !== null && envelope.y !== null && envelope.z !== null
}

function pointOutsideEnvelope(point: ProbeCyclePoint, envelope: MachineEnvelope): string | null {
  if (!fullEnvelope(envelope)) return 'Automatic probing requires a complete machine envelope.'
  for (const axis of ['x', 'y', 'z'] as const) {
    const value = point[axis]
    const bounds = envelope[axis]
    if (!Number.isFinite(value) || value < bounds.min - 0.0001 || value > bounds.max + 0.0001) {
      return `Planned ${axis.toUpperCase()} ${round4(value)} is outside the machine envelope `
        + `${round4(bounds.min)} to ${round4(bounds.max)}.`
    }
  }
  return null
}

function touchEndpoint(step: ProbeCycleTouchStep): ProbeCyclePoint {
  const axis = step.axis.toLowerCase() as 'x' | 'y'
  const sign = step.direction === '+' ? 1 : -1
  return { ...step.expectedStart, [axis]: step.expectedStart[axis] + sign * step.travelMm }
}

function validateSteps(steps: ProbeCycleStep[], envelope: MachineEnvelope): string | null {
  for (const step of steps) {
    // A touch made from the top also crosses to its own start first.
    const points = step.kind === 'position' || step.kind === 'descend'
      ? [step.target]
      : step.kind === 'rise'
        ? []
        : step.descendFromTop ? [step.expectedStart, touchEndpoint(step)] : [touchEndpoint(step)]
    for (const point of points) {
      const outside = pointOutsideEnvelope(point, envelope)
      if (outside) return `${step.label}: ${outside}`
    }
  }
  return null
}

/** WO-2055 defaults (design 4.4): start within 10 mm of the face; probe 5 mm below the top. */
const START_DISTANCE_MM = 10
const DEPTH_BELOW_TOP_MM = 5

/** WO-2108 (Operator 2026-09-27): the Probing screen's "Search down for the top"
 *  default - the Routines tab's too (probeRoutineFactory topSearchInput).
 *  Until 2026-09-27 the top touch searched the whole maximum probe travel: on
 *  a top the probe could not sense it drove the end mill 43.8 mm down to the
 *  bottom of Z. */
export const DEFAULT_TOP_SEARCH_MM = 25

/** WO-2108: the top touch's search - the distance asked for, never more than
 *  the machine's maximum probe travel (which is also the search when none is
 *  asked for). */
export function topSearchMm(cfg: Pick<EffectiveProbeConfig, 'maxTravel'>, requestedMm?: number): number {
  const asked = requestedMm !== undefined && Number.isFinite(requestedMm) && requestedMm > 0
  return round4(asked ? Math.min(cfg.maxTravel, requestedMm) : cfg.maxTravel)
}

/** The start stepped out past the face: against the touch's direction on its axis. */
function steppedOut(
  point: ProbeCyclePoint,
  axis: WorkProbeAxis,
  direction: WorkProbeDirection,
  stepOutMm: number,
): ProbeCyclePoint {
  const key = axis.toLowerCase() as 'x' | 'y'
  return { ...point, [key]: round4(point[key] + (direction === '+' ? -stepOutMm : stepOutMm)) }
}

/** WO-2554: a full configured seek near a machine boundary is shortened,
 * never rejected merely because its maximum endpoint would pass the limit. */
function internalSearchMm(input: PlanFeatureProbeCycleInput, axis: WorkProbeAxis, direction: WorkProbeDirection): number {
  const key = axis.toLowerCase() as 'x' | 'y'
  const bounds = input.envelope[key]!
  const room = direction === '+' ? bounds.max - input.start[key] : input.start[key] - bounds.min
  return round4(Math.min(input.config.maxTravel, Math.max(0, room)))
}

function touch(
  key: ProbeCycleTouchKey,
  label: string,
  axis: WorkProbeAxis,
  direction: WorkProbeDirection,
  travelMm: number,
  expectedStart: ProbeCyclePoint,
): ProbeCycleTouchStep {
  return { kind: 'touch', key, label, axis, direction, travelMm, expectedStart }
}

function position(
  label: string,
  target: ProbeCyclePoint,
  axes: Array<'X' | 'Y' | 'Z'> = ['X', 'Y'],
): ProbeCyclePositionStep {
  return { kind: 'position', label, target, axes }
}

function review(
  steps: ProbeCycleStep[],
  config: EffectiveProbeConfig,
  clearMotion: ProbeCycleClearMotion,
  approachClearanceMm: number | null,
): ProbeCycleReview {
  return {
    touchOrder: steps
      .filter((step): step is ProbeCycleTouchStep => step.kind === 'touch')
      .map(({ key, axis, direction }) => ({ key, axis, direction })),
    approachClearanceMm,
    positioningFeedMmMin: config.positioningFeed,
    searchFeedMmMin: config.fastFeed,
    probeFeedMmMin: config.slowFeed,
    clearMotion,
  }
}

function roundApproach(
  kind: 'boss',
  center: ProbeCyclePoint,
  axis: WorkProbeAxis,
  direction: WorkProbeDirection,
  sizeX: number,
  sizeY: number,
  tipRadius: number,
  clearance: number,
): ProbeCyclePoint {
  const size = axis === 'X' ? sizeX : sizeY
  const featureRadius = size / 2
  const probeCenterRadius = featureRadius + tipRadius + clearance
  // Outside features retain their near-side stand-off. Internal features
  // never position toward a nominal wall (WO-2554).
  const sign = kind === 'boss' && direction === '+' ? -1 : 1
  const key = axis.toLowerCase() as 'x' | 'y'
  return { ...center, [key]: round4(center[key] + sign * probeCenterRadius) }
}

/** How far below the top of Z travel a boss cross-over runs when no safe Z is
 *  given, so the move never ends on the soft limit itself (as the setter
 *  crossing, machineSession SETTER_CROSSING_BELOW_Z_TOP_MM). */
const CROSS_OVER_BELOW_Z_TOP_MM = 1

/**
 * WO-2035: the Z every boss cross-over runs at. Until 2026-09-26 it was the
 * start Z plus crossOverLift - started more than the lift below the boss top,
 * every cross-over drove the probe through the boss. The lift is still the
 * floor (a start close under the top crosses exactly where it always did);
 * above it, the cross-over clears the known top by the surface clearance, or,
 * with the top unknown, runs at the machine's safe Z. Since WO-2058 this is
 * the beside-the-face plan's height only (the pendant, and a text route with
 * no G38.3); a boss started over the middle crosses at the top it touched.
 */
function bossCrossOverZ(input: PlanFeatureProbeCycleInput): number {
  const { start, config, envelope } = input
  const lifted = start.z + config.crossOverLift
  const top = input.bossTopMachineZMm
  if (typeof top === 'number' && Number.isFinite(top)) {
    return round4(Math.max(lifted, top + config.surfaceClearance))
  }
  const stated = input.safeZMachineMm
  const safeZ = typeof stated === 'number' && Number.isFinite(stated)
    ? stated
    : envelope.z!.max - CROSS_OVER_BELOW_Z_TOP_MM
  return round4(Math.max(lifted, safeZ))
}

/**
 * WO-2058 (design 4.1, 4.2): Boss and Rect boss start OVER THE MIDDLE, by eye,
 * at any height above the top. The cycle touches the top there. Each face is
 * then touched from a start stepped out nominal half-size + tip radius +
 * clearance from the middle, after a guarded descent to probing depth below
 * that top, and every move between faces runs at top + clearance - the top it
 * touched, never a height taken from the start Z. It ends over the middle at
 * that height. Until 2026-09-27 the operator started outside the X max face at
 * probing depth and each cross-over ran at start Z + 10 (WO-2035 raised it to
 * clear the top); started 12 mm below the top, that drove through the boss.
 */
function bossPlanFromTop(
  input: PlanFeatureProbeCycleInput,
  searchTravel: number,
  sizeX: number,
  sizeY: number,
): ProbeFeatureCyclePlanResult {
  const { kind, start, config, envelope, tipRadiusMm } = input
  // No depth refusal here (Operator 2026-09-27): the Probing depth field only
  // takes a positive distance, so a bad depth cannot be typed.
  const depth = input.depthBelowTopMm ?? DEPTH_BELOW_TOP_MM
  const center = { ...start }
  const steps: ProbeCycleStep[] = ROUND_TOUCHES.map((spec) => ({
    ...touch(
      spec.key,
      `Probe ${spec.key}`,
      spec.axis,
      spec.direction,
      searchTravel,
      roundApproach('boss', center, spec.axis, spec.direction, sizeX, sizeY, tipRadiusMm, config.surfaceClearance),
    ),
    descendFromTop: true,
  }))
  // The runner rises to safe height after the last touch; only X and Y move.
  steps.push(position('Finish above nominal boss center', center))
  const invalid = validateSteps(steps, envelope)
  if (invalid) return { ok: false, reason: invalid }
  const clearance = config.surfaceClearance
  const stepOutMm = round4(sizeX / 2 + tipRadiusMm + clearance)
  if (input.topFromWorkZero) {
    // WO-2266: the top is work Z0 - nothing touches down over the middle (a
    // boss with a hole there). The runner reads it from the controller, rises
    // to it + clearance when below that, and each face's way down is the same
    // guarded descent from there.
    return {
      ok: true,
      plan: {
        kind,
        steps,
        expectedCenter: center,
        searchTravelMm: searchTravel,
        stepOffMm: config.retract,
        summary: `The top is work Z0. Rises to top + ${clearance} mm when below it, and for each of the four faces `
          + `steps out past it and descends to top - ${depth} mm, stopping if it touches anything; one bounded touch `
          + `per face, rising to top + ${clearance} mm after each. Ends over the middle at top + ${clearance} mm.`,
        review: review(steps, config, { kind: 'boss-from-top', center, clearanceMm: clearance, depthMm: depth }, clearance),
        fromTop: {
          topTouch: null,
          knownTop: { source: 'workZero' },
          clearanceMm: clearance,
          depthMm: depth,
          stepOutMm,
          besideTheFace: planFeatureProbeCycle({ ...input, approachFromTop: false }),
        },
      },
    }
  }
  return {
    ok: true,
    plan: {
      kind,
      steps,
      expectedCenter: center,
      searchTravelMm: searchTravel,
      stepOffMm: config.retract,
      summary: `Touches the top over the middle, rises to top + ${clearance} mm, and for each of the four faces steps `
        + `out past it at that height and descends to top - ${depth} mm, stopping if it touches anything; one `
        + `bounded touch per face, rising to top + ${clearance} mm after each. Ends over the middle at top + ${clearance} mm.`,
      review: review(steps, config, { kind: 'boss-from-top', center, clearanceMm: clearance, depthMm: depth }, clearance),
      fromTop: {
        topTouch: { label: 'Touch the top', at: start, travelMm: topSearchMm(config, input.topSearchMm) },
        clearanceMm: clearance,
        depthMm: depth,
        stepOutMm,
        besideTheFace: planFeatureProbeCycle({ ...input, approachFromTop: false }),
      },
    },
  }
}

function roundPlan(input: PlanFeatureProbeCycleInput, searchTravel: number): ProbeFeatureCyclePlanResult {
  const { kind, start, config, envelope, tipRadiusMm } = input
  if (kind !== 'bore' && kind !== 'boss' && kind !== 'rectPocket' && kind !== 'rectBoss') {
    return { ok: false, reason: 'Four-side plan kind is invalid.' }
  }
  const motionKind = kind === 'bore' || kind === 'rectPocket' ? 'bore' : 'boss'
  const sizeX = input.nominalSizeXmm
  const sizeY = input.nominalSizeYmm
  if (!finitePositive(sizeX) || !finitePositive(sizeY)) {
    return { ok: false, reason: 'Nominal X and Y feature sizes must be greater than zero.' }
  }
  if (!Number.isFinite(tipRadiusMm) || tipRadiusMm < 0) {
    return { ok: false, reason: 'Probe tip radius must be zero or greater.' }
  }
  if (motionKind === 'bore') {
    // WO-2265 (rule 11): the one thing a bore cannot be probed for - the tip
    // does not fit in it. The clearance never refuses.
    const fields: Array<[string, number]> = kind === 'bore'
      ? [['Nominal diameter', sizeX], ['Nominal diameter', sizeY]]
      : [['Width X', sizeX], ['Width Y', sizeY]]
    for (const [field, size] of fields) {
      if (size / 2 > tipRadiusMm) continue
      return {
        ok: false,
        reason: `${field} ${round4(size)} mm is not larger than the probe tip (radius ${round4(tipRadiusMm)} mm, `
          + `${round4(2 * tipRadiusMm)} mm across) - check ${field} or Tip radius.`,
      }
    }
  }
  if (motionKind === 'boss' && input.approachFromTop !== false) {
    return bossPlanFromTop(input, searchTravel, sizeX, sizeY)
  }

  const center = motionKind === 'bore'
    ? { ...start }
    : {
        x: round4(start.x - (sizeX / 2 + tipRadiusMm + config.surfaceClearance)),
        y: start.y,
        z: start.z,
      }
  const crossOverZ = bossCrossOverZ(input)
  const steps: ProbeCycleStep[] = []

  if (motionKind === 'bore') {
    // WO-2554 (owner ruling 10-04): a nominal is a drawing aid, never a wall
    // approach or search limit. Seek from the starting line, then return
    // away from that contact on its axis; WO-2517 guards those returns too.
    for (const spec of ROUND_TOUCHES) {
      steps.push(touch(spec.key, `Probe ${spec.key}`, spec.axis, spec.direction, internalSearchMm(input, spec.axis, spec.direction), center))
      steps.push(position(`Return toward start after ${spec.key}`, center, [spec.axis]))
    }
  } else {
    for (let index = 0; index < ROUND_TOUCHES.length; index++) {
      const spec = ROUND_TOUCHES[index]
      const approach = roundApproach(
        motionKind,
        center,
        spec.axis,
        spec.direction,
        sizeX,
        sizeY,
        tipRadiusMm,
        config.surfaceClearance,
      )
      if (index > 0) {
        const previous = ROUND_TOUCHES[index - 1]
        const previousApproach = roundApproach(
          motionKind,
          center,
          previous.axis,
          previous.direction,
          sizeX,
          sizeY,
          tipRadiusMm,
          config.surfaceClearance,
        )
        steps.push(position(`Lift clear after ${previous.key}`, { ...previousApproach, z: crossOverZ }, ['Z']))
        steps.push(position(`Cross above boss to ${spec.key}`, { ...approach, z: crossOverZ }))
        steps.push(position(`Lower outside ${spec.key}`, approach, ['Z']))
      }
      steps.push(touch(spec.key, `Probe ${spec.key}`, spec.axis, spec.direction, searchTravel, approach))
    }
    const last = ROUND_TOUCHES.at(-1)!
    const lastApproach = roundApproach(
      motionKind,
      center,
      last.axis,
      last.direction,
      sizeX,
      sizeY,
      tipRadiusMm,
      config.surfaceClearance,
    )
    steps.push(position('Lift clear after final boss touch', { ...lastApproach, z: crossOverZ }, ['Z']))
    steps.push(position('Finish above nominal boss center', { ...center, z: crossOverZ }))
  }

  const invalid = validateSteps(steps, envelope)
  if (invalid) return { ok: false, reason: invalid }
  return {
    ok: true,
    plan: {
      kind,
      steps,
      expectedCenter: center,
      searchTravelMm: motionKind === 'bore' ? config.maxTravel : searchTravel,
      ...(motionKind === 'bore' ? { internalSearchEnvelope: envelope } : {}),
      stepOffMm: config.retract,
      summary: motionKind === 'bore'
        ? `Four wall seeks from the starting line, up to ${config.maxTravel} mm at Search speed, then Probe speed; returns away from each wall toward the start.`
        : `Four touches; each cross-over runs at machine Z ${crossOverZ} at ${config.positioningFeed} mm/min.`,
      review: review(
        steps,
        config,
        motionKind === 'bore'
          ? { kind: 'bore-center', center }
          : {
              kind: 'boss-cross-over',
              center,
              liftMm: round4(crossOverZ - start.z),
              crossOverZMm: crossOverZ,
            },
        config.surfaceClearance,
      ),
    },
  }
}

/**
 * WO-2057 (design 4.1, 4.2): Inside corner, Bore and Rect pocket start over the
 * hole, at any height. Their top is work Z0 or the rim the operator touched,
 * never a touch where the probe stands (that would find the floor). The cycle
 * descends once, over the start, to probing depth below that top as a probe
 * move that stops on contact; the wall touches then run exactly as they always
 * have from there (the older plan's own steps, at depth); and it rises to safe
 * height at the end. Until 2026-09-27 every touch ran at whatever height the
 * operator left the probe.
 */
function holePlanFromTop(input: PlanFeatureProbeCycleInput): ProbeFeatureCyclePlanResult {
  const beside = planFeatureProbeCycle({ ...input, approachFromTop: false })
  if (!beside.ok) return beside
  const { config, start, envelope } = input
  // No depth refusal here (Operator 2026-09-27): the Probing depth field only
  // takes a positive distance, so a bad depth cannot be typed.
  const depth = input.depthBelowTopMm ?? DEPTH_BELOW_TOP_MM
  const rim = input.rimTopMachineZMm
  let knownTop: ProbeCycleKnownTop = { source: 'workZero' }
  if (rim !== undefined && rim !== null) {
    if (!Number.isFinite(rim)) return { ok: false, reason: 'The rim top must be a machine Z.' }
    knownTop = { source: 'rim', machineZ: round4(rim) }
    const heights: Array<[string, number]> = [
      ['Safe height above the rim', rim + config.surfaceClearance],
      ['Probing depth below the rim', rim - depth],
    ]
    for (const [what, z] of heights) {
      const outside = pointOutsideEnvelope({ ...start, z: round4(z) }, envelope)
      if (outside) return { ok: false, reason: `${what}: ${outside}` }
    }
  }
  const steps: ProbeCycleStep[] = [
    {
      kind: 'descend',
      label: input.kind === 'insideCorner' ? 'Descend to probing depth in the corner' : 'Descend to probing depth over the start',
      target: { ...start },
    },
    ...beside.plan.steps,
    { kind: 'rise', label: 'Rise to safe height' },
  ]
  const top = knownTop.source === 'rim' ? `the rim touched at machine Z ${knownTop.machineZ}` : 'work Z0'
  return {
    ok: true,
    plan: {
      ...beside.plan,
      steps,
      summary: `The top is ${top}. Rises to top + ${config.surfaceClearance} mm when below it, then descends to `
        + `top - ${depth} mm, stopping if it touches anything. ${beside.plan.summary} `
        + `Then rises to top + ${config.surfaceClearance} mm.`,
      fromTop: {
        topTouch: null,
        knownTop,
        clearanceMm: config.surfaceClearance,
        depthMm: depth,
        stepOutMm: 0,
        besideTheFace: beside,
      },
    },
  }
}

export function planFeatureProbeCycle(input: PlanFeatureProbeCycleInput): ProbeFeatureCyclePlanResult {
  const { config, envelope, start } = input
  if (!fullEnvelope(envelope)) {
    return { ok: false, reason: 'Automatic probing requires a complete machine envelope.' }
  }
  const startOutside = pointOutsideEnvelope(start, envelope)
  if (startOutside) return { ok: false, reason: `Start position: ${startOutside}` }
  const stated = round4(config.surfaceClearance + config.overtravel)
  if (!Number.isFinite(stated) || stated <= 0 || stated > config.maxTravel) {
    return {
      ok: false,
      reason: 'Surface clearance plus overtravel must be positive and within maximum travel.',
    }
  }
  const searchTravel = xyTouchSearchMm(config)
  if (
    (input.kind === 'insideCorner' || input.kind === 'bore' || input.kind === 'rectPocket')
    && input.approachFromTop !== false
  ) return holePlanFromTop(input)
  if (
    input.kind === 'bore' || input.kind === 'boss'
    || input.kind === 'rectPocket' || input.kind === 'rectBoss'
  ) return roundPlan(input, searchTravel)

  // WO-2569: one Search-speed seek retains the WO-2036 unseen-face bound.
  // WO-2036: a single-direction XY search (edge, corner, angle) is bounded
  // exactly like the four-side touches - the clearance the operator states
  // from the face plus overtravel - never the profile's maximum travel. On
  // 2026-09-26 a guided Edge X+ searched the full 100 mm at an anodized part
  // the probe could not see electrically and pushed the part about 65 mm.
  const steps: ProbeCycleStep[] = []
  // WO-2055: Edge and Angle start over the material. The cycle touches the top
  // where the probe stands, then makes each side touch from a start stepped out
  // past the face, at probing depth below that top.
  let fromTop: ProbeCycleFromTop | null = null
  let sideSearch = input.kind === 'insideCorner' ? config.maxTravel : searchTravel
  if (
    (input.kind === 'edge' || input.kind === 'angle' || input.kind === 'outsideCorner')
    && input.approachFromTop !== false
  ) {
    const startDistance = input.startDistanceMm ?? START_DISTANCE_MM
    const depth = input.depthBelowTopMm ?? DEPTH_BELOW_TOP_MM
    if (!finitePositive(startDistance) || !finitePositive(depth)) {
      return { ok: false, reason: 'Start distance and probing depth must be greater than zero.' }
    }
    if (!Number.isFinite(input.tipRadiusMm) || input.tipRadiusMm < 0) {
      return { ok: false, reason: 'Probe tip radius must be zero or greater.' }
    }
    fromTop = {
      topTouch: { label: 'Touch the top', at: start, travelMm: topSearchMm(config, input.topSearchMm) },
      clearanceMm: config.surfaceClearance,
      depthMm: depth,
      stepOutMm: round4(startDistance + input.tipRadiusMm + config.surfaceClearance),
      besideTheFace: planFeatureProbeCycle({ ...input, approachFromTop: false }),
    }
    // Expected distance from this stepped-out start to the face, plus the
    // configured overtravel. Clearance is already part of that distance;
    // do not add it a second time or substitute Maximum search.
    sideSearch = xyTouchSearchMm({ ...config, surfaceClearance: startDistance + config.surfaceClearance })
  }
  const sideTouch = (
    key: ProbeCycleTouchKey,
    label: string,
    axis: WorkProbeAxis,
    direction: WorkProbeDirection,
    from: ProbeCyclePoint,
  ): ProbeCycleTouchStep => fromTop
    ? {
        ...touch(key, label, axis, direction, sideSearch, steppedOut(from, axis, direction, fromTop.stepOutMm)),
        descendFromTop: true,
      }
    : touch(key, label, axis, direction, input.kind === 'insideCorner' ? internalSearchMm(input, axis, direction) : sideSearch, from)
  if (input.kind === 'edge') {
    if (!input.edgeAxis || !input.edgeDirection) {
      return { ok: false, reason: 'Edge axis and direction are required.' }
    }
    steps.push(sideTouch('edge', 'Probe edge', input.edgeAxis, input.edgeDirection, start))
  } else if (input.kind === 'corner' || input.kind === 'insideCorner' || input.kind === 'outsideCorner') {
    if (!input.cornerXDirection || !input.cornerYDirection) {
      return { ok: false, reason: 'Corner X and Y directions are required.' }
    }
    // WO-2056: Outside corner goes AROUND the corner. From the top, each face
    // gets its own step-out from the one start over the material: X face
    // first, then back over the stock to the start at safe height, then out
    // past the Y face. Until 2026-09-27 both touches ran from the same point,
    // so from any start off the corner's diagonal the first touch ran in front
    // of the part and missed. Inside corner (and the beside-the-face plan)
    // still touch both walls from where the probe stands - from the top,
    // after holePlanFromTop's descent (WO-2057).
    if (input.kind === 'outsideCorner' && !fromTop) {
      // WO-2056 audit: beside the faces (a route that cannot guard a descent)
      // Outside corner goes around the corner too, at the height the probe
      // stands. The start is clear of both faces, so moving along one face's
      // axis runs beside the other face, never into the part: past the Y face
      // (its search + tip + clearance) to touch X, back to the start, past the
      // X face to touch Y.
      if (!Number.isFinite(input.tipRadiusMm) || input.tipRadiusMm < 0) {
        return { ok: false, reason: 'Probe tip radius must be zero or greater.' }
      }
      const aroundMm = round4(xyTouchSearchMm(config) + input.tipRadiusMm + config.surfaceClearance)
      const besideX = steppedOut(start, 'Y', input.cornerYDirection === '+' ? '-' : '+', aroundMm)
      const besideY = steppedOut(start, 'X', input.cornerXDirection === '+' ? '-' : '+', aroundMm)
      steps.push(position('Go around beside the X face', besideX, ['Y']))
      steps.push(sideTouch('cornerX', 'Probe corner X face', 'X', input.cornerXDirection, besideX))
      steps.push(position('Go back around to the start', start))
      steps.push(position('Go around beside the Y face', besideY, ['X']))
      steps.push(sideTouch('cornerY', 'Probe corner Y face', 'Y', input.cornerYDirection, besideY))
    } else {
      steps.push(sideTouch('cornerX', 'Probe corner X face', 'X', input.cornerXDirection, start))
      if (fromTop) steps.push(position('Go back over the stock to the start', start))
      steps.push(sideTouch('cornerY', 'Probe corner Y face', 'Y', input.cornerYDirection, start))
    }
  } else {
    const nominalAxis = input.angleNominalAxis
    const probeDirection = input.angleProbeDirection
    const alongDirection = input.angleAlongDirection
    const spacingMm = input.angleSpacingMm
    if (!nominalAxis || !probeDirection || !alongDirection || !finitePositive(spacingMm)) {
      return {
        ok: false,
        reason: 'Angle nominal axis, probe direction, second-point direction, and spacing are required.',
      }
    }
    const probeAxis: WorkProbeAxis = nominalAxis === 'X' ? 'Y' : 'X'
    const alongKey = nominalAxis.toLowerCase() as 'x' | 'y'
    const secondStart = {
      ...start,
      [alongKey]: round4(start[alongKey] + (alongDirection === '+' ? spacingMm : -spacingMm)),
    }
    steps.push(sideTouch('angleFirst', 'Probe angle point 1', probeAxis, probeDirection, start))
    // Only the nominal axis moves: from the top, point 1 ends at safe height,
    // stepped out, so this crosses along the face there. The target's other
    // coordinates are not commanded.
    steps.push(position('Position along face for point 2', secondStart, [nominalAxis]))
    steps.push(sideTouch('angleSecond', 'Probe angle point 2', probeAxis, probeDirection, secondStart))
  }
  const invalid = validateSteps(steps, envelope)
  if (invalid) return { ok: false, reason: invalid }
  const approach = fromTop
    ? `Touches the top, rises to top + ${fromTop.clearanceMm} mm, steps out ${fromTop.stepOutMm} mm and descends `
      + `to top - ${fromTop.depthMm} mm, stopping if it touches anything; then `
    : ''
  return {
    ok: true,
    plan: {
      kind: input.kind,
      steps,
      expectedCenter: null,
      searchTravelMm: sideSearch,
      ...(input.kind === 'insideCorner' ? { internalSearchEnvelope: envelope } : {}),
      stepOffMm: config.retract,
      summary: input.kind === 'edge'
        ? `${approach}${fromTop ? 'one' : 'One'} bounded touch at ${config.fastFeed}/${config.slowFeed} mm/min.`
        : input.kind === 'angle'
          ? `${approach}${fromTop ? 'two' : 'Two'} bounded touches separated by ${input.angleSpacingMm} mm along ${input.angleNominalAxis}.`
          : fromTop
            ? `${approach}one bounded touch per face, going back over the start at safe height between them.`
            : input.kind === 'outsideCorner'
              ? 'Goes around the corner at the height where the probe stands: one bounded touch per face, '
                + 'going back to the start between them.'
              : `Two bounded touches; retract ${config.retract} mm before changing axis.`,
      review: review(
        steps,
        config,
        input.kind === 'edge'
          ? { kind: 'edge-only' }
          : input.kind === 'angle'
            ? {
                kind: 'angle-two-point',
                nominalAxis: input.angleNominalAxis!,
                spacingMm: input.angleSpacingMm!,
              }
            : { kind: 'corner-step-off' },
        config.surfaceClearance,
      ),
      fromTop,
    },
  }
}
