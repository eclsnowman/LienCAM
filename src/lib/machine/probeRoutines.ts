import type { SetupFlip, Vec3 } from '../../types'
import {
  flipPointToSecondSide,
  type FlipAxis,
  type SecondSideFrame,
} from '../cam/flipSetup'

export type WorkProbeAxis = 'X' | 'Y'
export type WorkProbeDirection = '+' | '-'

export interface EdgeProbeInput {
  axis: WorkProbeAxis
  direction: WorkProbeDirection
  triggerPositionMm: number
  tipRadiusMm: number
}

export interface EdgeProbeResult {
  axis: WorkProbeAxis
  coordinateMm: number
  tipRadiusMm: number
  compensation: string
}

export interface CornerProbeInput {
  x: Omit<EdgeProbeInput, 'axis'>
  y: Omit<EdgeProbeInput, 'axis'>
}

export interface CornerProbeResult {
  xMm: number
  yMm: number
  tipRadiusMm: number
  compensation: string
}

/** Trigger coordinates from the four signed touches used on a round feature. */
export interface RoundProbeTouches {
  xNegativeMm: number
  xPositiveMm: number
  yNegativeMm: number
  yPositiveMm: number
  tipRadiusMm: number
}

export interface RoundProbeResult {
  centerXmm: number
  centerYmm: number
  diameterXmm: number
  diameterYmm: number
  tipRadiusMm: number
  compensation: string
}

function requireFinite(label: string, value: number): void {
  if (!Number.isFinite(value)) throw new RangeError(`${label} must be a finite number.`)
}

function requireTipRadius(tipRadiusMm: number): void {
  requireFinite('Probe tip radius', tipRadiusMm)
  if (tipRadiusMm < 0) throw new RangeError('Probe tip radius cannot be negative.')
}

function requirePositiveDiameter(label: string, diameterMm: number): void {
  if (diameterMm <= 0) {
    throw new RangeError(`${label} touches do not describe a positive diameter.`)
  }
}

/**
 * Convert the probe-centre trigger coordinate to the touched face coordinate.
 * A positive touch stops one radius before the face; a negative touch stops
 * one radius after it.
 */
export function calculateEdge(input: EdgeProbeInput): EdgeProbeResult {
  requireFinite('Trigger position', input.triggerPositionMm)
  requireTipRadius(input.tipRadiusMm)
  const signedRadius = input.direction === '+' ? input.tipRadiusMm : -input.tipRadiusMm
  return {
    axis: input.axis,
    coordinateMm: input.triggerPositionMm + signedRadius,
    tipRadiusMm: input.tipRadiusMm,
    compensation:
      `Probe tip radius compensation: ${input.direction === '+' ? '+' : '-'}${input.tipRadiusMm} mm ` +
      `on ${input.axis} (${input.axis}${input.direction} touch).`,
  }
}

export function calculateCorner(input: CornerProbeInput): CornerProbeResult {
  if (input.x.tipRadiusMm !== input.y.tipRadiusMm) {
    throw new RangeError('Corner touches must use the same probe tip radius.')
  }
  const x = calculateEdge({ axis: 'X', ...input.x })
  const y = calculateEdge({ axis: 'Y', ...input.y })
  return {
    xMm: x.coordinateMm,
    yMm: y.coordinateMm,
    tipRadiusMm: x.tipRadiusMm,
    compensation:
      `Probe tip radius compensation: ${x.tipRadiusMm} mm applied to both faces ` +
      `(X${input.x.direction}, Y${input.y.direction}).`,
  }
}

function requireRoundTouches(input: RoundProbeTouches): void {
  requireTipRadius(input.tipRadiusMm)
  requireFinite('X- trigger position', input.xNegativeMm)
  requireFinite('X+ trigger position', input.xPositiveMm)
  requireFinite('Y- trigger position', input.yNegativeMm)
  requireFinite('Y+ trigger position', input.yPositiveMm)
}

/** Inside touches: each measured span grows by one tip radius at each wall. */
export function calculateBoreCenter(input: RoundProbeTouches): RoundProbeResult {
  requireRoundTouches(input)
  const diameterXmm = input.xPositiveMm - input.xNegativeMm + 2 * input.tipRadiusMm
  const diameterYmm = input.yPositiveMm - input.yNegativeMm + 2 * input.tipRadiusMm
  requirePositiveDiameter('X bore', diameterXmm)
  requirePositiveDiameter('Y bore', diameterYmm)
  return {
    centerXmm: (input.xNegativeMm + input.xPositiveMm) / 2,
    centerYmm: (input.yNegativeMm + input.yPositiveMm) / 2,
    diameterXmm,
    diameterYmm,
    tipRadiusMm: input.tipRadiusMm,
    compensation:
      `Probe tip radius compensation: ${input.tipRadiusMm} mm added at both walls ` +
      '(2x radius per measured diameter).',
  }
}

/**
 * Outside touches: X+/Y+ approach the minimum faces and X-/Y- approach the
 * maximum faces, so the raw centre-to-centre span loses two tip radii.
 */
export function calculateBossCenter(input: RoundProbeTouches): RoundProbeResult {
  requireRoundTouches(input)
  const diameterXmm = input.xNegativeMm - input.xPositiveMm - 2 * input.tipRadiusMm
  const diameterYmm = input.yNegativeMm - input.yPositiveMm - 2 * input.tipRadiusMm
  requirePositiveDiameter('X boss', diameterXmm)
  requirePositiveDiameter('Y boss', diameterYmm)
  return {
    centerXmm: (input.xPositiveMm + input.xNegativeMm) / 2,
    centerYmm: (input.yPositiveMm + input.yNegativeMm) / 2,
    diameterXmm,
    diameterYmm,
    tipRadiusMm: input.tipRadiusMm,
    compensation:
      `Probe tip radius compensation: ${input.tipRadiusMm} mm subtracted at both faces ` +
      '(2x radius per measured diameter).',
  }
}

// --- WO-298: how crooked the part is (measurement only, no WCS write) --------
//
// Two ordinary edge touches (each still compensated by calculateEdge above,
// exactly as today) along one nominally-straight side, at two different
// positions along that side's length, give the angle the side actually sits
// at versus the axis the operator states it should be parallel to. Never
// inferred: a side 44 degrees off is either a badly clamped X side or a
// badly clamped Y side and the arithmetic cannot tell which
// (docs/research/probing-angle-compensation.md).
//
// This function only measures; it writes nothing. The Angle routine's
// Confirm (WO-2188) is what rotates the work offset by it.

export type YawNominalAxis = WorkProbeAxis

/** One touch along the side: where the probe sat along the nominal axis
 *  (not tip-radius compensated - that axis is never the probing direction
 *  here) and the raw trigger coordinate perpendicular to it (compensated
 *  below via calculateEdge, same as a single edge touch today). */
export interface YawTouch {
  alongMm: number
  triggerPositionMm: number
}

export interface YawAngleInput {
  /** The axis this side is nominally parallel to, as stated by the operator. */
  nominalAxis: YawNominalAxis
  /** Perpendicular probing direction, shared by both touches: they are two
   *  touches along the SAME face, so they approach it the same way. */
  direction: WorkProbeDirection
  tipRadiusMm: number
  first: YawTouch
  second: YawTouch
}

export interface YawAnglePoint {
  xMm: number
  yMm: number
}

export interface YawAngleResult {
  nominalAxis: YawNominalAxis
  /** Positive is counter-clockwise from the nominal axis. */
  thetaDeg: number
  /** The two COMPENSATED points theta was computed from, so the number can
   *  be checked by hand. */
  first: YawAnglePoint
  second: YawAnglePoint
  compensation: string
}

// WO-2188 (Operator 2026-09-29, the rotation card's default 5): no angle limit.
// Any angle the probe measured is reported, and the Angle routine's Confirm
// can rotate the work offset by it (docs/design/WCS-ROTATION.md).

function yawTouchPoint(
  nominalAxis: YawNominalAxis,
  direction: WorkProbeDirection,
  touch: YawTouch,
  tipRadiusMm: number,
): YawAnglePoint {
  const acrossAxis: WorkProbeAxis = nominalAxis === 'X' ? 'Y' : 'X'
  const across = calculateEdge({
    axis: acrossAxis,
    direction,
    triggerPositionMm: touch.triggerPositionMm,
    tipRadiusMm,
  })
  return nominalAxis === 'X'
    ? { xMm: touch.alongMm, yMm: across.coordinateMm }
    : { xMm: across.coordinateMm, yMm: touch.alongMm }
}

/**
 * The angle a nominally-straight side actually sits at, from two compensated
 * touches along its length.
 *
 * theta is tip-radius INVARIANT by construction: both touches share one
 * direction and one radius, so calculateEdge shifts both points by the same
 * constant and that constant cancels out of the direction P2-P1. Tip radius
 * compensation still matters here - it is what makes `first`/`second` the
 * true touched-face points rather than the raw probe-centre trigger
 * coordinates a machinist would otherwise check this number against by hand
 * - it just does not change theta itself, and that is expected, not a bug.
 */
export function calculateYawAngle(input: YawAngleInput): YawAngleResult {
  requireFinite('First touch along position', input.first.alongMm)
  requireFinite('First touch trigger position', input.first.triggerPositionMm)
  requireFinite('Second touch along position', input.second.alongMm)
  requireFinite('Second touch trigger position', input.second.triggerPositionMm)
  requireTipRadius(input.tipRadiusMm)

  if (input.first.alongMm === input.second.alongMm) {
    throw new RangeError(
      `Both touches were taken at the same position (${input.first.alongMm} mm) along the ` +
      `nominal ${input.nominalAxis} side. Two touches at the same position along the side ` +
      `give no angle - touch the side at two different positions along its length and probe ` +
      `again.`,
    )
  }

  const first = yawTouchPoint(input.nominalAxis, input.direction, input.first, input.tipRadiusMm)
  const second = yawTouchPoint(input.nominalAxis, input.direction, input.second, input.tipRadiusMm)

  const dx = second.xMm - first.xMm
  const dy = second.yMm - first.yMm
  // General CCW-angle-from-a-reference-axis formula, cross/dot of the
  // nominal axis unit vector against the measured direction. For nominal X
  // (1,0) this reduces to atan2(dy, dx) exactly as stated in the order; for
  // nominal Y (0,1) it is atan2(-dx, dy) - the same formula, generalised.
  const nominalX = input.nominalAxis === 'X' ? 1 : 0
  const nominalY = input.nominalAxis === 'X' ? 0 : 1
  const crossZ = nominalX * dy - nominalY * dx
  const dot = nominalX * dx + nominalY * dy
  const thetaDeg = (Math.atan2(crossZ, dot) * 180) / Math.PI

  return {
    nominalAxis: input.nominalAxis,
    thetaDeg,
    first,
    second,
    compensation:
      `Probe tip radius compensation: ${input.tipRadiusMm} mm applied to both touches ` +
      `(perpendicular to nominal ${input.nominalAxis}, ${input.direction} direction).`,
  }
}

/**
 * WO-2188: a measured line's angle against the WORK axes when the work offset
 * already carries `rotationDeg` (CCW seen from +Z): the angle the touches give
 * in machine axes less the rotation, folded to a line's (-90, 90]. Once Confirm
 * has rotated the work offset by the measured angle, the same face reads 0 -
 * as LinuxCNC's own probe results read in the rotated work frame
 * (docs/design/WCS-ROTATION.md).
 */
export function lineAngleInWorkDeg(machineDeg: number, rotationDeg: number): number {
  let deg = (machineDeg - rotationDeg) % 180
  if (deg <= -90) deg += 180
  if (deg > 90) deg -= 180
  return deg
}

/** WO-2188: the tap-it-square number - how far a face measured at `thetaDeg`
 *  runs off square over `overMm` along it, and which way to tap its far end
 *  (the +X end of a nominal-X face, the +Y end of a nominal-Y face). */
export interface FaceRunOff {
  /** Always >= 0. */
  runOffMm: number
  overMm: number
  end: 'right' | 'back'
  /** Null when it runs square (under 0.0005 mm). */
  tap: 'toward you' | 'away from you' | 'to the left' | 'to the right' | null
}

export function faceRunOff(nominalAxis: YawNominalAxis, thetaDeg: number, overMm: number): FaceRunOff {
  // Positive = the far end sits CCW of square: +Y (away from you) for a
  // nominal-X face, -X (to the left) for a nominal-Y face.
  const offMm = overMm * Math.tan((thetaDeg * Math.PI) / 180)
  const runOffMm = Math.abs(offMm)
  const square = runOffMm < 0.0005
  return nominalAxis === 'X'
    ? { runOffMm, overMm, end: 'right', tap: square ? null : offMm > 0 ? 'toward you' : 'away from you' }
    : { runOffMm, overMm, end: 'back', tap: square ? null : offMm > 0 ? 'to the right' : 'to the left' }
}

// --- WO-289: finding zero again after the part is turned over ----------------
//
// WO-261 (above) turns probe triggers into compensated MACHINE coordinates.
// WO-288 (src/lib/cam/flipSetup.ts) records that a setup IS the second side of
// another and owns the turn arithmetic. Neither knows about the other, so the
// machinist does the join in his head: he probes a feature that is still
// findable from this side, works out where it ought to read now the block is
// turned over, and subtracts.
//
// That subtraction is all this section adds, and only on a setup whose flipOf
// is set:
//
//   the feature sits at F in FIRST-side coordinates
//   -> after the turn it must read F' = flipPointToSecondSide(F)
//   -> the probe found it at machine coordinate P
//   -> so this side's zero is at machine coordinate P - F'
//
// With F = 0 that is exactly what WO-261 already writes (zero on the probed
// feature), which is why first-side probing is untouched: no flipOf, no join.
//
// The turn arithmetic is CALLED, never re-implemented. flipSetup.ts is a safety
// file and getting its sign wrong produces a plausible number on the wrong face.

/** The axis words the setup dialog already uses, so the panel and the dialog
 *  describe one turn the same way (SetupModal FLIP_AXES). */
const FLIP_AXIS_WORDS: Record<FlipAxis, string> = {
  x: 'X (front and back swap)',
  y: 'Y (left and right swap)',
}

export interface SecondSideZeroInput {
  /** What the setup itself records - read straight off `Setup.flipOf`. */
  relationship: SetupFlip
  /** The axis the caller resolved the flip for (a `SecondSidePlan.axis`). Given
   *  separately from `relationship.axis` on purpose: they come from two places
   *  and a stale one is refused, never quietly preferred. */
  flipAxis: FlipAxis
  /** Block extents + first-side and destination work zeros inside it (a `SecondSidePlan`). */
  frame: SecondSideFrame
  /** Where the probed feature sits in FIRST-side setup coordinates. Every axis
   *  that was probed needs one; a missing reference is refused rather than
   *  defaulted to 0, because 0 silently means "zero on the feature" - a
   *  perfectly plausible answer and the wrong one on a second side. */
  featureOnFirstSideMm: Partial<Record<WorkProbeAxis, number>>
  /** The compensated probe result per axis, in machine coordinates - what the
   *  WO-261 routines above already produce. */
  probedMachineMm: Partial<Record<WorkProbeAxis, number>>
  /** Names, for the sentence the machinist checks against the part. */
  firstSideName: string
  secondSideName: string
  /** Saved second-side work offset, and the one the caller would write to.
   *  A flip-corrected zero written into somebody else's offset is still wrong. */
  relationshipOffsetG: number
  targetOffsetG: number
}

export interface SecondSideZeroAxisResult {
  axis: WorkProbeAxis
  /** As given: the feature in first-side coordinates. */
  featureFirstSideMm: number
  /** What that feature must read on the second side, after the turn. */
  featureSecondSideMm: number
  /** What the probe actually found (machine coordinates). */
  probedMachineMm: number
  /** This side's zero: the machine coordinate to write into the offset. */
  workZeroMachineMm: number
}

export type SecondSideZeroRefusalCode =
  | 'SECOND_SIDE_AXIS_DISAGREES'
  | 'SECOND_SIDE_OFFSET_DISAGREES'
  | 'SECOND_SIDE_REFERENCE_MISSING'
  | 'SECOND_SIDE_NOTHING_PROBED'
  | 'SECOND_SIDE_TOUCHES_NOT_THIS_SETUP'
  | 'SECOND_SIDE_INPUT_NOT_FINITE'

export interface SecondSideZeroRefusal {
  ok: false
  code: SecondSideZeroRefusalCode
  /** Machinist-readable, shown verbatim. Names the disagreement; never picks. */
  message: string
}

export interface SecondSideZeroPlan {
  ok: true
  axis: FlipAxis
  firstSideSetupId: string
  firstSideName: string
  secondSideName: string
  axes: SecondSideZeroAxisResult[]
  /** Which side this is setting and which way the part was turned, in words and
   *  without numbers, so it reads the same in millimetres or inches. */
  statement: string
}

/** The one sentence the panel shows before anything is probed and the plan
 *  repeats after: which side is being set, and which way the part was turned. */
export function secondSideStatement(
  secondSideName: string,
  firstSideName: string,
  axis: FlipAxis,
): string {
  return (
    `Setting zero for "${secondSideName}" - the second side of "${firstSideName}", ` +
    `turned about ${FLIP_AXIS_WORDS[axis]}.`
  )
}

/**
 * The refusal for touches that were recorded while a DIFFERENT setup was
 * active.
 *
 * The caller (the probe panel) is mounted once and RETAINED for the whole
 * session, so the active setup can change under a half-finished probe session
 * with no remount. Those touches are measurements of whatever was in the vise
 * then; combining them with this side's block and turn gives a perfectly
 * plausible zero for a part that is no longer there. Named here with the other
 * second-side refusals so all of this wording lives in one place.
 */
export function secondSideStaleTouchRefusal(secondSideName: string): SecondSideZeroRefusal {
  return {
    ok: false,
    code: 'SECOND_SIDE_TOUCHES_NOT_THIS_SETUP',
    message:
      `The recorded touches were taken while a different setup was active, so they cannot ` +
      `set the zero for "${secondSideName}" - they measured whatever was in the vise then. ` +
      `Probe this side again.`,
  }
}

/**
 * Where a feature at `featureMm` on the first side must read on the second,
 * for ONE axis.
 *
 * flipPointToSecondSide maps each component from the same component only (X
 * from X, Y from Y, Z from Z), so one axis at a time is the whole answer for
 * that axis and the unused components can be anything. `secondSideProbeZero
 * reads one axis at a time` in the WO-289 tests holds this property down: if
 * flipSetup.ts ever couples the axes, that test fails here rather than a wrong
 * zero reaching an offset table.
 */
function featureAfterTurn(
  axis: WorkProbeAxis,
  featureMm: number,
  flipAxis: FlipAxis,
  frame: SecondSideFrame,
): number {
  const onFirstSide: Vec3 =
    axis === 'X' ? { x: featureMm, y: 0, z: 0 } : { x: 0, y: featureMm, z: 0 }
  const onSecondSide = flipPointToSecondSide(onFirstSide, flipAxis, frame)
  return axis === 'X' ? onSecondSide.x : onSecondSide.y
}

/**
 * Turn a probe result on a SECOND-SIDE setup into that side's zero, with the
 * turn already accounted for - or refuse and say what disagrees with what.
 *
 * Writes nothing and commands nothing: it returns numbers for a human to
 * confirm, exactly as WO-261 shipped.
 */
export function planSecondSideProbeZero(
  input: SecondSideZeroInput,
): SecondSideZeroPlan | SecondSideZeroRefusal {
  // Two records of one physical turn. If they differ, both answers are
  // plausible and only one matches the part in the vise - so name the
  // disagreement and refuse instead of picking.
  if (input.relationship.axis !== input.flipAxis) {
    return {
      ok: false,
      code: 'SECOND_SIDE_AXIS_DISAGREES',
      message:
        `"${input.secondSideName}" records that the part was turned about ` +
        `${input.relationship.axis.toUpperCase()}, but this zero was worked out as a turn ` +
        `about ${input.flipAxis.toUpperCase()}. Those are different operations and give ` +
        `different zeros, so nothing was worked out. Check which way the part was turned ` +
        `over.`,
    }
  }

  if (input.targetOffsetG !== input.relationshipOffsetG) {
    return {
      ok: false,
      code: 'SECOND_SIDE_OFFSET_DISAGREES',
      message:
        `"${input.secondSideName}" uses ` +
        `G${input.relationshipOffsetG}, but this panel would write G${input.targetOffsetG}. ` +
        `A second-side zero written into another offset is still the wrong offset. Select ` +
        `G${input.relationshipOffsetG} first.`,
    }
  }

  const axes: SecondSideZeroAxisResult[] = []
  for (const axis of ['X', 'Y'] as const) {
    const probedMachineMm = input.probedMachineMm[axis]
    if (probedMachineMm === undefined) continue

    const featureFirstSideMm = input.featureOnFirstSideMm[axis]
    if (featureFirstSideMm === undefined) {
      return {
        ok: false,
        code: 'SECOND_SIDE_REFERENCE_MISSING',
        message:
          `${axis} was probed, but where that feature sits on "${input.firstSideName}" was ` +
          `not given. Without it this side's ${axis} zero cannot be worked out - assuming ` +
          `the feature IS the zero would look right and be wrong. Enter the feature's ` +
          `first-side ${axis} and probe again.`,
      }
    }
    if (!Number.isFinite(featureFirstSideMm) || !Number.isFinite(probedMachineMm)) {
      return {
        ok: false,
        code: 'SECOND_SIDE_INPUT_NOT_FINITE',
        message: `The ${axis} feature position and probe result must both be finite numbers.`,
      }
    }

    const featureSecondSideMm = featureAfterTurn(
      axis,
      featureFirstSideMm,
      input.flipAxis,
      input.frame,
    )
    axes.push({
      axis,
      featureFirstSideMm,
      featureSecondSideMm,
      probedMachineMm,
      // The zero is where the machine must be for this feature to read its
      // second-side coordinate.
      workZeroMachineMm: probedMachineMm - featureSecondSideMm,
    })
  }

  if (axes.length === 0) {
    return {
      ok: false,
      code: 'SECOND_SIDE_NOTHING_PROBED',
      message: 'No probe result to turn into a second-side zero yet.',
    }
  }

  return {
    ok: true,
    axis: input.flipAxis,
    firstSideSetupId: input.relationship.setupId,
    firstSideName: input.firstSideName,
    secondSideName: input.secondSideName,
    axes,
    statement: secondSideStatement(
      input.secondSideName,
      input.firstSideName,
      input.flipAxis,
    ),
  }
}
