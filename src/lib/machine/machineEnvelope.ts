// machineEnvelope - "where is the table, and where is home", derived from
// what the controller already reports, never asked of the operator (WO-292).
//
// GRBL settles the question completely: $130-$132 (max travel per axis) plus
// $23 (homing direction invert mask) fix which corner of each axis's travel
// machine zero sits at, and which sign the rest of the table occupies from
// there. $27 (pull-off) is the small retract off the switch $H leaves the
// axis parked at once homing completes.
//
// Per grbl's homing cycle (limits_go_home): with an axis's $23 bit CLEAR
// (default), the search approaches its switch from the negative side, i.e.
// the switch sits at that axis's MAXIMUM travel corner - after homing,
// machine zero is there and the reachable table is entirely <= 0 ("far
// corner" homing). With the bit SET, the search approaches from the positive
// side - the switch sits at the MINIMUM corner, machine zero is there, and
// the table is entirely >= 0 ("near corner" homing). This is decided per
// axis, independently.
//
// Framework-free (no React, no store) - pure derivation over a plain
// settings dump, so it is testable without a controller or a connection.
//
// WO-300: grbl's "the switch always reads zero" is one convention, not the
// only one - Operator's UCCNC machine writes an operator-chosen offset on homing
// instead (home at back-right-top reading 738/724.5/128.9, table entirely
// positive). Every convention we have seen reduces to the same two facts per
// axis: which end of the travel the switch is at, and what the axis reads
// there. AxisEnvelope now carries both; grbl's zero is just the special case
// homePositionMm = 0.

import type { MachineHomeConvention } from '../../types'

export type EnvelopeAxisId = 'x' | 'y' | 'z'

export interface AxisEnvelope {
  /** mm, from $130/$131/$132. */
  travelMm: number
  /** Which end of the travel the homing switch (and so machine zero) sits
   *  at, decoded from $23's bit for this axis. */
  homesToward: 'max' | 'min'
  /** mm, the machine coordinate this axis reads once parked on its home
   *  switch. grbl always zeroes here (WO-292); a machine profile may
   *  declare a different one for a controller that writes an operator-
   *  chosen offset on homing instead. */
  homePositionMm: number
  /** mm, from $27 - how far off the switch $H leaves the axis parked. */
  pulloffMm: number
  /** Reachable machine-coordinate range for this axis, min <= max. */
  min: number
  max: number
}

export interface MachineEnvelope {
  x: AxisEnvelope | null
  y: AxisEnvelope | null
  z: AxisEnvelope | null
}

const AXIS_IDS: readonly EnvelopeAxisId[] = ['x', 'y', 'z']
const AXIS_TRAVEL_SETTING: Record<EnvelopeAxisId, number> = { x: 130, y: 131, z: 132 }
const AXIS_DIR_BIT: Record<EnvelopeAxisId, number> = { x: 0, y: 1, z: 2 }
const HOMING_DIR_MASK_SETTING = 23
const PULLOFF_SETTING = 27

function positiveNumber(raw: string | undefined): number | null {
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : null
}

function nonNegativeNumber(raw: string | undefined): number | null {
  const value = Number(raw)
  return Number.isFinite(value) && value >= 0 ? value : null
}

/** The reachable range implied by the two facts every homing convention
 *  reduces to: which end of the travel the switch sits at, and what the
 *  axis reads once parked there. */
function axisRangeFromHome(
  homesToward: 'max' | 'min',
  homePositionMm: number,
  travelMm: number,
): { min: number; max: number } {
  return homesToward === 'max'
    ? { min: homePositionMm - travelMm, max: homePositionMm }
    : { min: homePositionMm, max: homePositionMm + travelMm }
}

/** Build a full axis envelope from the three facts that describe any homing
 *  convention we have seen (WO-300). grbl's own convention (WO-292) is just
 *  the special case homePositionMm = 0; a machine profile can declare any
 *  other, for a controller that does not report it the grbl way. */
export function deriveAxisEnvelopeFromHome(args: {
  travelMm: number
  homesToward: 'max' | 'min'
  homePositionMm: number
  pulloffMm?: number
}): AxisEnvelope {
  const { travelMm, homesToward, homePositionMm, pulloffMm = 0 } = args
  const { min, max } = axisRangeFromHome(homesToward, homePositionMm, travelMm)
  return { travelMm, homesToward, homePositionMm, pulloffMm, min, max }
}

/** Resolve the user-facing "machine zero end" choice to the coordinate read
 *  at the home switch. Older profiles may carry homePositionMm directly. */
export function resolveAxisHomePosition(
  convention: MachineHomeConvention[EnvelopeAxisId],
  travelMm: number,
): number {
  if (convention.machineZeroAt === 'min') {
    return convention.homesToward === 'max' ? travelMm : 0
  }
  if (convention.machineZeroAt === 'max') {
    return convention.homesToward === 'max' ? 0 : -travelMm
  }
  return Number.isFinite(convention.homePositionMm) ? convention.homePositionMm! : 0
}

/** Derive the simulator/display envelope declared by a machine profile. */
export function deriveMachineEnvelopeFromConvention(
  convention: MachineHomeConvention,
  travel: { x: number; y: number; z: number },
): MachineEnvelope {
  const axis = (id: EnvelopeAxisId): AxisEnvelope | null => {
    const travelMm = travel[id]
    if (!Number.isFinite(travelMm) || travelMm <= 0) return null
    const declared = convention[id]
    return deriveAxisEnvelopeFromHome({
      travelMm,
      homesToward: declared.homesToward,
      homePositionMm: resolveAxisHomePosition(declared, travelMm),
    })
  }
  return { x: axis('x'), y: axis('y'), z: axis('z') }
}

function deriveAxisEnvelope(settings: Record<number, string>, axis: EnvelopeAxisId): AxisEnvelope | null {
  const travelMm = positiveNumber(settings[AXIS_TRAVEL_SETTING[axis]])
  if (travelMm === null) return null
  const dirMaskRaw = Number(settings[HOMING_DIR_MASK_SETTING])
  // A dump that never carried $23 (or an unparsable one) is GRBL's own
  // default: every axis un-inverted, homing to the max-travel corner.
  const dirMask = Number.isFinite(dirMaskRaw) ? dirMaskRaw : 0
  const invert = (dirMask & (1 << AXIS_DIR_BIT[axis])) !== 0
  const pulloffMm = nonNegativeNumber(settings[PULLOFF_SETTING]) ?? 0
  const homesToward: 'max' | 'min' = invert ? 'min' : 'max'
  // Preserve the established live-GRBL derivation. Profile conventions are
  // applied only to the built-in simulator, never substituted for serial
  // controller facts.
  return deriveAxisEnvelopeFromHome({ travelMm, homesToward, homePositionMm: 0, pulloffMm })
}

/** Derive the reachable envelope from a firmware settings dump ($$). Each
 *  axis is independent: a dump missing that axis's travel (not yet read, or
 *  never reported) yields null for that axis alone rather than failing the
 *  whole envelope.
 *
 *  WO-301: a machine that declares it has no homing switches has no datum to
 *  derive a box from, no matter what the settings dump says - `$130-$132`
 *  describe travel a switch-less machine may never have measured against a
 *  fixed corner. Pass `noHomingSwitches: true` to suppress the envelope
 *  outright rather than deriving one that looks real but isn't. */
export function deriveMachineEnvelope(
  settings: Record<number, string>,
  opts?: { noHomingSwitches?: boolean },
): MachineEnvelope {
  if (opts?.noHomingSwitches) return { x: null, y: null, z: null }
  return {
    x: deriveAxisEnvelope(settings, 'x'),
    y: deriveAxisEnvelope(settings, 'y'),
    z: deriveAxisEnvelope(settings, 'z'),
  }
}

export type EnvelopeStatus = 'unknown' | 'not-homed' | 'homed' | 'no-datum'

/**
 * The four honest states, and nothing in between:
 *  - 'unknown': not connected, or the controller's settings were never read -
 *    there is no envelope to describe yet.
 *  - 'not-homed': settings are known (the box and corner are knowable), but
 *    THIS session has not completed a $H - the live machine coordinate is
 *    not yet anchored to that box and must not be shown as fact.
 *  - 'homed': $H has completed this session - the envelope is both known and
 *    live, so the current machine coordinate can be trusted and located in it.
 *  - 'no-datum': the machine profile declares it has no homing switches at
 *    all (WO-301). This is NOT 'not-homed' - that word promises a homing
 *    that is coming. Here there is no datum, by design, and there never will
 *    be one; work coordinates the operator sets by hand are unaffected and
 *    stay fully usable. Wins over every other input: a switch-less machine
 *    has no datum whether or not it happens to be connected or reporting
 *    settings.
 */
export function deriveEnvelopeStatus(args: {
  connected: boolean
  settingsKnown: boolean
  homed: boolean
  noHomingSwitches?: boolean
}): EnvelopeStatus {
  if (args.noHomingSwitches) return 'no-datum'
  if (!args.connected || !args.settingsKnown) return 'unknown'
  return args.homed ? 'homed' : 'not-homed'
}

/** The one rule this whole order exists to enforce: a machine coordinate is
 *  never handed to a caller (and so never rendered) unless the envelope
 *  status is 'homed'. Unhomed, unknown or no-datum (WO-301), GRBL's own MPos
 *  is a number left over from wherever the steppers happened to be at
 *  power-up - not a fact about the table. */
export function safeMachinePosition<T>(status: EnvelopeStatus, mpos: T | null): T | null {
  return status === 'homed' ? mpos : null
}

export interface TravelMismatch {
  axis: EnvelopeAxisId
  typedMm: number
  reportedMm: number
  differenceMm: number
}

/** A hand-typed Machine Library travel and a firmware-reported one are two
 *  independently sourced numbers; rounding on either side (a measurement to
 *  the nearest mm, a firmware default) can differ by a hair without meaning
 *  anything. Below this, silence; at or above it, a real disagreement worth
 *  surfacing before the tool reaches a corner it should not. */
export const TRAVEL_MISMATCH_TOLERANCE_MM = 1

/** Compare the derived envelope's per-axis travel against what the Machine
 *  Library record has typed in, and name every axis that disagrees by more
 *  than the tolerance - never silently preferring either number. An axis
 *  the controller has not reported yet, or a machine with no configured
 *  travel, is simply not compared (nothing to reconcile against). */
export function reconcileTravels(
  envelope: MachineEnvelope,
  configuredTravel: { x: number; y: number; z: number } | null | undefined,
): TravelMismatch[] {
  if (!configuredTravel) return []
  const mismatches: TravelMismatch[] = []
  for (const axis of AXIS_IDS) {
    const derived = envelope[axis]
    if (!derived) continue
    const typedMm = configuredTravel[axis]
    if (!Number.isFinite(typedMm) || typedMm <= 0) continue
    const differenceMm = Math.abs(typedMm - derived.travelMm)
    if (differenceMm >= TRAVEL_MISMATCH_TOLERANCE_MM) {
      mismatches.push({ axis, typedMm, reportedMm: derived.travelMm, differenceMm })
    }
  }
  return mismatches
}

export interface HomeConventionMismatch {
  axis: EnvelopeAxisId
  declaredHomesToward: 'max' | 'min'
  reportedHomesToward: 'max' | 'min'
  declaredHomePositionMm: number
  reportedHomePositionMm: number
}

/** Same tolerance as travel (TRAVEL_MISMATCH_TOLERANCE_MM) - both ask "does
 *  a hand-declared number match what the controller reports", just about a
 *  different fact. */
export const HOME_POSITION_MISMATCH_TOLERANCE_MM = TRAVEL_MISMATCH_TOLERANCE_MM

/** Compare a machine profile's declared homing convention against what the
 *  controller's own settings derive, and name every axis that disagrees -
 *  either on which corner the switch is at, or what it reads there once
 *  parked - never silently preferring either. A profile that thinks the
 *  table starts somewhere other than the controller does is a crash at the
 *  corner of the table, so either kind of disagreement is named, even when
 *  the other fact happens to agree. No declared convention (absent means
 *  "the controller tells us"), or an axis the controller has not reported
 *  yet, is simply not compared. */
export function reconcileHomeConvention(
  envelope: MachineEnvelope,
  declaredConvention: MachineHomeConvention | null | undefined,
  configuredTravel?: { x: number; y: number; z: number } | null,
): HomeConventionMismatch[] {
  if (!declaredConvention) return []
  const mismatches: HomeConventionMismatch[] = []
  for (const axis of AXIS_IDS) {
    const reported = envelope[axis]
    if (!reported) continue
    const declared = declaredConvention[axis]
    const homesTowardDiffers = declared.homesToward !== reported.homesToward
    const declaredHomePositionMm = configuredTravel
      ? resolveAxisHomePosition(declared, configuredTravel[axis])
      : declared.homePositionMm
    const positionDiffers = Number.isFinite(declaredHomePositionMm)
      && Math.abs(declaredHomePositionMm! - reported.homePositionMm) >= HOME_POSITION_MISMATCH_TOLERANCE_MM
    if (homesTowardDiffers || positionDiffers) {
      mismatches.push({
        axis,
        declaredHomesToward: declared.homesToward,
        reportedHomesToward: reported.homesToward,
        declaredHomePositionMm: declaredHomePositionMm ?? reported.homePositionMm,
        reportedHomePositionMm: reported.homePositionMm,
      })
    }
  }
  return mismatches
}

// ---------------------------------------------------------------------------
// WO-377: the SIGNED result of a declared convention, in plain words, and the
// loaded program's fit against the envelope.
//
// Operator's machine: Y travel 724.5, home switch at the MAX end, machine zero at
// the MAX end. That is a correct definition and it yields machine Y
// -724.5..0 - the whole table is in negative Y. A program posted in positive
// Y with G54 still sitting on machine zero is therefore OUTSIDE the table.
// The Machine Library used to show the three ingredients and never their
// signed result; the Control preview drew the grid where the table really is
// and the program where it really is, which looked like a misplaced grid.
// These helpers name the result so nobody has to derive it in their head.
// ---------------------------------------------------------------------------

export interface SignedAxisRange {
  axis: EnvelopeAxisId
  travelMm: number
  homesToward: 'max' | 'min'
  machineZeroAt: 'max' | 'min'
  /** Reachable machine-coordinate range, min <= max (mm). */
  min: number
  max: number
  /** mm, what the axis reads parked on its home switch. */
  homePositionMm: number
  /** True when any part of the reachable range is below zero - the case the
   *  Machine Library must explain rather than silently rewrite. */
  negative: boolean
}

/** The signed range one axis's declared switch end / zero end / travel
 *  produce. Mirrors deriveMachineEnvelopeFromConvention for a single axis so
 *  the Machine Library preview and the Control grid can never disagree. */
export function signedAxisRange(
  axis: EnvelopeAxisId,
  convention: { homesToward: 'max' | 'min'; machineZeroAt?: 'max' | 'min'; homePositionMm?: number },
  travelMm: number,
): SignedAxisRange | null {
  if (!Number.isFinite(travelMm) || travelMm <= 0) return null
  const homePositionMm = resolveAxisHomePosition(
    convention as MachineHomeConvention[EnvelopeAxisId],
    travelMm,
  )
  const { min, max } = axisRangeFromHome(convention.homesToward, homePositionMm, travelMm)
  const machineZeroAt: 'max' | 'min' = convention.machineZeroAt
    ?? (Math.abs(min) <= Math.abs(max) ? 'min' : 'max')
  return {
    axis,
    travelMm,
    homesToward: convention.homesToward,
    machineZeroAt,
    min,
    max,
    homePositionMm,
    negative: min < 0,
  }
}

function endWord(end: 'max' | 'min'): string {
  return end === 'max' ? 'maximum' : 'minimum'
}

/** One plain sentence per axis: where home lands inside the signed range, and
 *  - when the range dips below zero - why that is valid and what it means for
 *  a program. `fmt` formats a millimetre value in the caller's display units. */
export function describeSignedAxisRange(
  range: SignedAxisRange,
  fmt: (mm: number) => string = formatEnvelopeMm,
): string {
  const A = range.axis.toUpperCase()
  const homeEnd = endWord(range.homesToward)
  const sentence =
    `${A} runs ${fmt(range.min)} to ${fmt(range.max)}; home lands at ${A} ${fmt(range.homePositionMm)}, the ${homeEnd} end.`
  if (!range.negative) return sentence
  const where = range.max <= 0 ? 'entirely' : 'partly'
  return `${sentence} The table is ${where} in negative ${A} - that is valid and is saved as typed; a program in positive ${A} needs a work offset placed onto the table.`
}

export function formatEnvelopeMm(value: number): string {
  if (Object.is(value, -0)) value = 0
  return Number.isInteger(value) ? String(value) : value.toFixed(1)
}

export type EnvelopeFitState = 'inside' | 'partial' | 'outside'

export interface AxisEnvelopeFit {
  axis: EnvelopeAxisId
  /** Program extent on this axis in MACHINE coordinates (work + offset). */
  programMin: number
  programMax: number
  machineMin: number
  machineMax: number
  state: EnvelopeFitState
}

export interface ProgramEnvelopeFit {
  /** 'inside' when every compared axis fits; 'outside' when at least one
   *  axis has NO overlap with the table; 'partial' otherwise. */
  state: EnvelopeFitState
  axes: AxisEnvelopeFit[]
  /** The axes that do not fit, in X/Y/Z order - what the warning names. */
  offending: AxisEnvelopeFit[]
}

export interface Bounds3 {
  min: { x: number; y: number; z: number }
  max: { x: number; y: number; z: number }
}

/** Axis-aligned bounds of a point cloud (the program's moves, in whatever
 *  frame they were given). null for an empty list. */
export function boundsOfPoints(
  points: ReadonlyArray<{ x: number; y: number; z: number }>,
): Bounds3 | null {
  if (points.length === 0) return null
  const min = { x: Infinity, y: Infinity, z: Infinity }
  const max = { x: -Infinity, y: -Infinity, z: -Infinity }
  for (const p of points) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y) || !Number.isFinite(p.z)) continue
    if (p.x < min.x) min.x = p.x
    if (p.y < min.y) min.y = p.y
    if (p.z < min.z) min.z = p.z
    if (p.x > max.x) max.x = p.x
    if (p.y > max.y) max.y = p.y
    if (p.z > max.z) max.z = p.z
  }
  if (!Number.isFinite(min.x)) return null
  return { min, max }
}

/** WO-2219: one work point as the controller runs it in a ROTATED work offset
 *  (docs/design/WCS-ROTATION.md, measured on LinuxCNC: machine = O + Rot(R)(work),
 *  R in degrees, CCW positive seen from +Z, about the work origin). Returns the
 *  point turned about that origin - add the offset for machine coordinates.
 *  Z is never turned. No rotation returns the point itself. */
export function turnWorkPoint<T extends { x: number; y: number }>(point: T, degrees: number): T {
  if (!Number.isFinite(degrees) || degrees === 0) return point
  const radians = (degrees * Math.PI) / 180
  const c = Math.cos(radians)
  const s = Math.sin(radians)
  return { ...point, x: point.x * c - point.y * s, y: point.x * s + point.y * c }
}

/** WO-2219: the work offset's rotation, as the controller REPORTS it, for the
 *  fit check. `workPoints` are the program's own XY work points (the same ones
 *  its bounds came from); given them, the turned extent is exact. Without them
 *  the four corners of the box are turned - exact for a rectangle, never
 *  smaller than the true extent for any other shape. */
export interface WorkRotationForFit {
  degrees: number
  workPoints?: ReadonlyArray<{ x: number; y: number }> | null
  /** The program's XY arcs, untessellated (the staged route keeps an arc as
   *  one step). Each adds the points where it reaches a TURNED axis extreme,
   *  so a bulge no arc end reaches is measured exactly. */
  workArcs?: ReadonlyArray<WorkArcForFit> | null
}

/** WO-2219: one XY arc in work coordinates, as staged. */
export interface WorkArcForFit {
  from: { x: number; y: number }
  to: { x: number; y: number }
  centre: { x: number; y: number }
  clockwise: boolean
}

/** WO-2219: the points of `arc` where, turned by `degrees`, it is furthest
 *  along machine X or Y - the work angles that turn onto 0/90/180/270 deg,
 *  where the sweep passes them (the same sweep rule as the load check's
 *  `arcSweep`: coincident ends are a full turn). */
export function arcTurnedExtremePoints(arc: WorkArcForFit, degrees: number): Array<{ x: number; y: number }> {
  const r = Math.hypot(arc.from.x - arc.centre.x, arc.from.y - arc.centre.y)
  if (!Number.isFinite(r) || r === 0) return []
  const twoPi = 2 * Math.PI
  const a0 = Math.atan2(arc.from.y - arc.centre.y, arc.from.x - arc.centre.x)
  const a1 = Math.atan2(arc.to.y - arc.centre.y, arc.to.x - arc.centre.x)
  const ccw = (((a1 - a0) % twoPi) + twoPi) % twoPi
  const full = ccw <= 1e-12 || twoPi - ccw <= 1e-12
  const sweep = full ? twoPi : arc.clockwise ? twoPi - ccw : ccw
  const turn = (degrees * Math.PI) / 180
  const points: Array<{ x: number; y: number }> = []
  for (let k = 0; k < 4; k++) {
    const q = (k * Math.PI) / 2 - turn
    // Angle from a0 to q, measured in the direction of travel, in [0, 2pi).
    const along = arc.clockwise ? a0 - q : q - a0
    const d = ((along % twoPi) + twoPi) % twoPi
    if (d <= sweep + 1e-12) points.push({ x: arc.centre.x + r * Math.cos(q), y: arc.centre.y + r * Math.sin(q) })
  }
  return points
}

/** WO-2219: the program's work bounds turned by the rotation, so that
 *  machine = these bounds + offset on every axis, exactly as for an unrotated
 *  offset. Z is unchanged. No rotation returns the bounds themselves. */
export function turnWorkBounds(
  bounds: Bounds3,
  degrees: number,
  workPoints?: ReadonlyArray<{ x: number; y: number }> | null,
  workArcs?: ReadonlyArray<WorkArcForFit> | null,
): Bounds3 {
  if (!Number.isFinite(degrees) || degrees === 0) return bounds
  const corners = [
    { x: bounds.min.x, y: bounds.min.y },
    { x: bounds.max.x, y: bounds.min.y },
    { x: bounds.max.x, y: bounds.max.y },
    { x: bounds.min.x, y: bounds.max.y },
  ]
  const finitePoints = [
    ...(workPoints ?? []),
    ...(workPoints && workPoints.length > 0 ? (workArcs ?? []).flatMap((arc) => arcTurnedExtremePoints(arc, degrees)) : []),
  ].filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y))
  const source = finitePoints.length > 0 ? finitePoints : corners
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const point of source) {
    const turned = turnWorkPoint(point, degrees)
    if (turned.x < minX) minX = turned.x
    if (turned.y < minY) minY = turned.y
    if (turned.x > maxX) maxX = turned.x
    if (turned.y > maxY) maxY = turned.y
  }
  return {
    min: { x: minX, y: minY, z: bounds.min.z },
    max: { x: maxX, y: maxY, z: bounds.max.z },
  }
}

/** WO-2219: the XY work points a fit under rotation should turn, from the
 *  preview's resolved moves, by the SAME rule `buildPreviewModel` bounds its
 *  work box with (WO-1639): only work-frame move ends, and only once the
 *  program has itself commanded X and Y - an assumed start or a held modal
 *  value is not a place the program sends the tool. An axis no work move ever
 *  commands keeps its modal value, as it does in the box. */
export function workXYPointsForFit(
  moves: ReadonlyArray<{
    coordinateFrame: 'work' | 'machine'
    addressedAxes: ReadonlyArray<string>
    to: { x: number; y: number }
  }>,
): Array<{ x: number; y: number }> {
  const workMoves = moves.filter((move) => move.coordinateFrame === 'work')
  const everAddressed = new Set<string>()
  for (const move of workMoves) for (const axis of move.addressedAxes) everAddressed.add(axis)
  const addressedSoFar = new Set<string>()
  const points: Array<{ x: number; y: number }> = []
  for (const move of workMoves) {
    for (const axis of move.addressedAxes) addressedSoFar.add(axis)
    if ((everAddressed.has('x') && !addressedSoFar.has('x')) || (everAddressed.has('y') && !addressedSoFar.has('y'))) continue
    points.push({ x: move.to.x, y: move.to.y })
  }
  return points
}

/** Rounding slack between a posted coordinate and a typed travel: a program
 *  touching the table edge exactly is inside, not a warning. */
export const ENVELOPE_FIT_TOLERANCE_MM = 0.01

/** Per-axis MACHINE-coordinate range of one-shot G53 targets in the judged
 *  program (WO-1630). An axis present here was commanded in machine
 *  coordinates at least once - no work offset ever applies to those targets -
 *  so they are compared to the table directly, never shifted by
 *  `workOriginMachine`. A program can still move that SAME axis in work
 *  coordinates elsewhere (a G53 park plus an ordinary G54 cut on the same
 *  axis), so this range is UNIONED with the axis's work-coordinate bounds
 *  below, never a replacement for them. */
export type MachineAxisRanges = Partial<Record<EnvelopeAxisId, { min: number; max: number }>>

/** Where the loaded program lands on the declared table, after the active
 *  work offset. `programBounds` is in WORK coordinates (what the program
 *  text says); `workOriginMachine` is the active offset (G54..G59) in
 *  machine coordinates, so machine = work + offset. Axes whose envelope or
 *  work origin is unknown are not compared. Returns null when nothing can be
 *  compared (no program, no established offset, no envelope axis, and no
 *  machine-absolute range) - the caller then says nothing.
 *
 *  WO-2219: `workRotation` is that offset's rotation as the controller reports
 *  it; the work box is turned first (machine = offset + Rot(R)(work)). Absent
 *  or 0, every verdict is exactly what it was.
 *
 *  WO-1630: an axis's verdict is the UNION of (a) its `machineAxisRanges`
 *  entry, if any - one-shot G53 targets, in true machine coordinates, never
 *  shifted - and (b) `programBounds` on that axis shifted by the active
 *  offset, if the program addresses it in work coordinates too. Operator's board
 *  painted a false OUTSIDE for `G53 G0 Z128` after a G54 Z edit because the
 *  check shifted a MACHINE coordinate by a work offset that never applies to
 *  it; an audit follow-up then found the opposite failure - REPLACING an
 *  axis's work-coordinate moves with only its G53 targets painted a false
 *  INSIDE for `G53 G0 Z128` followed by a `G54 G1 Z-500` that really leaves
 *  the table, because the G54 move was dropped from the verdict entirely.
 *  Neither fact may be discarded: a G53 target is never shifted by the
 *  offset, and a work-coordinate move on the same axis is never hidden by a
 *  G53 target sharing that axis. */
/** One sub-range's own verdict against the table: 'inside' fully contained,
 *  'outside' no overlap at all, 'partial' straddles an edge. */
function classifyRange(
  min: number,
  max: number,
  env: { min: number; max: number },
  tolerance: number,
): EnvelopeFitState {
  const inside = min >= env.min - tolerance && max <= env.max + tolerance
  if (inside) return 'inside'
  // 'partial' needs REAL overlap - a program that merely touches the table's
  // edge from outside (Operator's Y 0..60 against -724.5..0) is off the table.
  const overlaps = max > env.min + tolerance && min < env.max - tolerance
  return overlaps ? 'partial' : 'outside'
}

const FIT_STATE_SEVERITY: Record<EnvelopeFitState, number> = { inside: 0, partial: 1, outside: 2 }

/** The worse of two verdicts - 'outside' beats 'partial' beats 'inside'. Used
 *  to combine an axis's G53-target verdict with its work-coordinate-move
 *  verdict (WO-1630): a numeric min/max blend of two DISJOINT ranges (a G53
 *  target on the table, a work move far below it) can look like it merely
 *  straddles an edge ('partial', which does not block CYCLE START) when one
 *  of the two facts is genuinely, fully off the table. The worse verdict is
 *  never silently improved by a better one on the same axis. */
function worseFitState(a: EnvelopeFitState, b: EnvelopeFitState): EnvelopeFitState {
  return FIT_STATE_SEVERITY[a] >= FIT_STATE_SEVERITY[b] ? a : b
}

export function fitProgramToEnvelope(
  programBounds: Bounds3 | null | undefined,
  workOriginMachine: Partial<{ x: number; y: number; z: number }> | null | undefined,
  envelope: MachineEnvelope,
  tolerance: number = ENVELOPE_FIT_TOLERANCE_MM,
  machineAxisRanges?: MachineAxisRanges | null,
  workRotation?: WorkRotationForFit | null,
): ProgramEnvelopeFit | null {
  if (!programBounds && !machineAxisRanges) return null
  // WO-2219: under a rotated work offset the program runs TURNED about the
  // work origin; judge where it runs. G53 targets (machineAxisRanges) are
  // machine coordinates and are never turned.
  if (programBounds && workRotation) {
    programBounds = turnWorkBounds(programBounds, workRotation.degrees, workRotation.workPoints, workRotation.workArcs)
  }
  const axes: AxisEnvelopeFit[] = []
  for (const axis of AXIS_IDS) {
    const env = envelope[axis]
    if (!env) continue
    const machineRange = machineAxisRanges?.[axis]
    let workMin: number | null = null
    let workMax: number | null = null
    if (programBounds && workOriginMachine) {
      const origin = workOriginMachine[axis]
      if (Number.isFinite(origin)) {
        workMin = programBounds.min[axis] + origin!
        workMax = programBounds.max[axis] + origin!
      }
    }
    let programMin: number
    let programMax: number
    let state: EnvelopeFitState
    if (machineRange && workMin !== null && workMax !== null) {
      // The UNION: `programMin`/`programMax` report the full span of what the
      // program actually reaches on this axis (for the sentence naming it),
      // but the verdict is the WORSE of the two facts judged separately - see
      // `worseFitState`.
      programMin = Math.min(machineRange.min, workMin)
      programMax = Math.max(machineRange.max, workMax)
      const machineState = classifyRange(machineRange.min, machineRange.max, env, tolerance)
      const workState = classifyRange(workMin, workMax, env, tolerance)
      state = worseFitState(machineState, workState)
    } else if (machineRange) {
      programMin = machineRange.min
      programMax = machineRange.max
      state = classifyRange(programMin, programMax, env, tolerance)
    } else if (workMin !== null && workMax !== null) {
      programMin = workMin
      programMax = workMax
      state = classifyRange(programMin, programMax, env, tolerance)
    } else {
      continue
    }
    axes.push({
      axis,
      programMin,
      programMax,
      machineMin: env.min,
      machineMax: env.max,
      state,
    })
  }
  if (axes.length === 0) return null
  const offending = axes.filter((a) => a.state !== 'inside')
  const state: EnvelopeFitState = offending.length === 0
    ? 'inside'
    : offending.some((a) => a.state === 'outside') ? 'outside' : 'partial'
  return { state, axes, offending }
}
