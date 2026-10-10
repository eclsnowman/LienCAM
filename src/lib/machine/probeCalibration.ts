// WO-1817 - probe calibration states tip diameter and runout instead of
// assuming them. Authority: docs/archive/FEATURE-HITLIST-2026-07-21.md
// "Probe calibration, since every number above depends on tip diameter and
// runout" (Operator ruling 2026-08-09); method read against
// docs/research/PROBING-RECON.md's "Calibration" section and tiered scope.
//
// NO NEW MOTION PATH: both measurements below are arithmetic over the
// TRIGGER POSITIONS the existing probe-routine machinery already produces -
// `calculateBoreCenter`/`calculateBossCenter` (probeRoutines.ts, run by the
// factory bore/boss-centre routines in probeRoutineFactory.ts) for tip
// diameter, and a single edge-touch trigger position taken twice for runout.
// Nothing here issues a move or adds a step kind.
//
// Tip diameter: run the existing bore or boss routine against a KNOWN ring
// gauge or pad diameter, with the probe's own tip radius set to zero so the
// routine reports the RAW (uncompensated) span. The gap between that raw
// span and the known diameter is twice the tip radius - the same arithmetic
// `calculateBoreCenter`/`calculateBossCenter` already apply in the other
// direction to compensate a real measurement.
//
// Runout: touch the same physical point twice with the spindle rotated a
// half turn between touches (spin-and-probe to measure concentricity)
// using the existing
// single-axis edge-touch routine. A concentric tip triggers at the same
// position both times; the difference is the total indicated runout.
//
// STALENESS: `CALIBRATION_STALE_AFTER_DAYS` is a decide-and-log default
// (180 days - roughly a semi-annual re-check), not a physical constant.
// Operator can reverse it; it changes nothing about a value's correctness, only
// when the UI calls it stale.

import { calculateBoreCenter, calculateBossCenter, type RoundProbeTouches } from './probeRoutines'
import type { ProbeCalibration, ProbeCalibrationFact, ProbeCalibrationProvenance } from '../../types'
import type { ProbeCycleTouchKey } from './probeFeatureCycle'

export type { ProbeCalibration, ProbeCalibrationFact, ProbeCalibrationProvenance }

export const CALIBRATION_STALE_AFTER_DAYS = 180

function requireFiniteAbove(label: string, value: number, floor: number): void {
  if (!Number.isFinite(value) || value <= floor) {
    throw new RangeError(`${label} must be a finite number greater than ${floor}.`)
  }
}

/** A calibration fact, validated: no negative or non-finite values ever
 *  reach a machine definition through this constructor. */
export function makeCalibrationFact(
  valueMm: number,
  provenance: ProbeCalibrationProvenance,
  date: string,
): ProbeCalibrationFact {
  requireFiniteAbove('A calibration value', valueMm, 0)
  return { valueMm, provenance, date }
}

/** Record a tip diameter fact, leaving any runout fact untouched. */
export function withTipDiameter(
  calibration: ProbeCalibration | undefined,
  fact: ProbeCalibrationFact,
): ProbeCalibration {
  return { ...(calibration ?? {}), tipDiameter: fact }
}

/** Record a runout fact, leaving any tip diameter fact untouched. */
export function withRunout(
  calibration: ProbeCalibration | undefined,
  fact: ProbeCalibrationFact,
): ProbeCalibration {
  return { ...(calibration ?? {}), runout: fact }
}

// --- measurement: the arithmetic a calibration routine runs -----------------

export type CalibrationFeatureKind = 'bore' | 'boss'

/**
 * The effective tip diameter, from touching a KNOWN bore or boss with the
 * existing bore/boss-centre routine machinery. `touches` are the routine's
 * own trigger coordinates; tip radius is forced to zero here so the routine
 * hands back the raw, uncompensated span instead of assuming a radius it
 * does not yet know.
 *
 * Bore touches happen inside the wall, one radius short of it, so the raw
 * span reads narrower than the true bore by twice the tip radius. Boss
 * touches happen outside the face, one radius past it, so the raw span
 * reads wider than the true boss by the same amount. Both are the exact
 * inverse of the compensation `calculateBoreCenter`/`calculateBossCenter`
 * already apply.
 */
export function measureTipDiameterMm(
  featureKind: CalibrationFeatureKind,
  nominalDiameterMm: number,
  touches: Omit<RoundProbeTouches, 'tipRadiusMm'>,
): number {
  requireFiniteAbove('The known ring/pad diameter', nominalDiameterMm, 0)
  const raw = featureKind === 'bore'
    ? calculateBoreCenter({ ...touches, tipRadiusMm: 0 })
    : calculateBossCenter({ ...touches, tipRadiusMm: 0 })
  const rawDiameterMm = (raw.diameterXmm + raw.diameterYmm) / 2
  const tipDiameterMm = featureKind === 'bore'
    ? nominalDiameterMm - rawDiameterMm
    : rawDiameterMm - nominalDiameterMm
  if (!(tipDiameterMm > 0)) {
    throw new RangeError(
      `The touches plus the stated ${featureKind} diameter (${nominalDiameterMm} mm) describe a tip ` +
      `diameter of ${tipDiameterMm.toFixed(4)} mm, which is not physically possible. Check the stated ` +
      `diameter and probe again.`,
    )
  }
  return tipDiameterMm
}

/**
 * Total indicated runout from two touches of the SAME physical point, taken
 * with the spindle rotated a half turn between them (spin-and-probe). A
 * concentric tip triggers at the same position both times; the raw
 * difference is the runout - no tip radius needed, because both touches
 * share one contact geometry and a constant radius offset cancels out of
 * the difference.
 */
export function measureRunoutMm(
  triggerAtOrientationAMm: number,
  triggerAtOrientationBMm: number,
): number {
  if (!Number.isFinite(triggerAtOrientationAMm) || !Number.isFinite(triggerAtOrientationBMm)) {
    throw new RangeError('Both spin-probe trigger positions must be finite numbers.')
  }
  return Math.abs(triggerAtOrientationBMm - triggerAtOrientationAMm)
}

// --- reading calibration back: what a probe result or the definition shows --

export type ProbeCalibrationState = 'uncalibrated' | 'stated' | 'measured'

export interface ProbeCalibrationSummary {
  state: ProbeCalibrationState
  tipDiameterMm: number | null
  /** Never a hidden default - null means no compensation can be applied. */
  tipRadiusMm: number | null
  tipDiameterProvenance: ProbeCalibrationProvenance | null
  tipDiameterDate: string | null
  tipDiameterStale: boolean
  runoutMm: number | null
  runoutProvenance: ProbeCalibrationProvenance | null
  runoutDate: string | null
  runoutStale: boolean
  /** One sentence for the probing panels: what calibration this result used,
   *  or that none is stated. */
  label: string
}

function ageInDays(dateIso: string, now: Date): number {
  const then = new Date(dateIso).getTime()
  if (!Number.isFinite(then)) return 0
  return (now.getTime() - then) / (24 * 60 * 60 * 1000)
}

function isStale(dateIso: string, now: Date): boolean {
  return ageInDays(dateIso, now) > CALIBRATION_STALE_AFTER_DAYS
}

/** The one place that turns a machine's `probeCalibration` record into the
 *  state a probing screen or a probe result shows. Absence of a tip
 *  diameter is UNCALIBRATED, never silently read as zero radius. */
export function describeProbeCalibration(
  calibration: ProbeCalibration | undefined,
  now: Date = new Date(),
): ProbeCalibrationSummary {
  const tipDiameter = calibration?.tipDiameter
  const runout = calibration?.runout

  const tipDiameterStale = tipDiameter ? isStale(tipDiameter.date, now) : false
  const runoutStale = runout ? isStale(runout.date, now) : false

  const state: ProbeCalibrationState = !tipDiameter
    ? 'uncalibrated'
    : (tipDiameter.provenance === 'measured' ? 'measured' : 'stated')

  const label = !tipDiameter
    ? 'Uncalibrated - tip diameter has not been stated or measured. No tip radius compensation can be applied.'
    : `Tip diameter ${tipDiameter.provenance} ${tipDiameter.date}` +
      (tipDiameterStale ? ` - stale (over ${CALIBRATION_STALE_AFTER_DAYS} days old, re-check before trusting this result)` : '')

  return {
    state,
    tipDiameterMm: tipDiameter?.valueMm ?? null,
    tipRadiusMm: tipDiameter ? tipDiameter.valueMm / 2 : null,
    tipDiameterProvenance: tipDiameter?.provenance ?? null,
    tipDiameterDate: tipDiameter?.date ?? null,
    tipDiameterStale,
    runoutMm: runout?.valueMm ?? null,
    runoutProvenance: runout?.provenance ?? null,
    runoutDate: runout?.date ?? null,
    runoutStale,
    label,
  }
}

/** The tip radius a probe routine may use for compensation, or null when
 *  uncalibrated. Callers must refuse or flag on null - never substitute a
 *  guessed radius here, that is exactly the assumption this WO removes. */
export function resolveTipRadiusMm(calibration: ProbeCalibration | undefined): number | null {
  const tipDiameter = calibration?.tipDiameter
  if (!tipDiameter) return null
  return tipDiameter.valueMm / 2
}

// --- WO-2166: the loaded Probe tool's X / Y radius on a known reference ------
//
// The Probing screen's Calibrate routine touches a reference of known diameter
// +X, -X, +Y, -Y - Boss-style around an outside reference (gauge pin, round
// boss), Bore-style inside an inside one (ring gauge, known bore) - and works
// out the probe's effective radius on EACH axis from that axis's two touches:
//   outside: r = (span - D) / 2    inside: r = (D - span) / 2
// where span is the distance between the probe centres at the two slow
// touches. Confirm writes the two numbers to the loaded Probe tool's
// Calibrated radius X / Y (WO-2154), which the side routines use (WO-2156).

/** Outside: the probe touches the reference from outside (gauge pin, round
 *  boss). Inside: from inside it (ring gauge, known bore). */
export type CalibrationReferenceKind = 'outside' | 'inside'

export interface CalibrationReference {
  id: string
  /** The operator's own name for it, e.g. "25.000 gauge pin". */
  name: string
  kind: CalibrationReferenceKind
  /** Its exact diameter, mm. */
  diameterMm: number
}

/** The routine a reference is touched with: Boss outside, Bore inside. */
export function calibrationFeatureKind(kind: CalibrationReferenceKind): CalibrationFeatureKind {
  return kind === 'inside' ? 'bore' : 'boss'
}

export interface CalibrationRadii {
  /** Probe centre to probe centre between the two X touches, and the Y. */
  spanXmm: number
  spanYmm: number
  /** The effective radius on each axis. */
  radiusXmm: number
  radiusYmm: number
}

/** Four decimals: a tenth of a micron, finer than any board reports. */
const round4 = (value: number): number => Number(value.toFixed(4))

/**
 * The effective radius per axis from the four touches (the probe centre at
 * each slow touch, machine mm), or null until all four are in.
 *
 * `across` is where each touch ran on the OTHER axis (the Y an X touch ran
 * along, the X a Y touch ran along). A start off the middle makes one pair
 * touch across a chord, which reads short; the X touches give the true X
 * centre and the Y touches the true Y centre, so the chord is corrected:
 * the centre-to-contact distance is sqrt(half-span^2 + offset^2). Started on
 * the middle (or without `across`) this is exactly r = (span - D) / 2.
 */
export function calibrationRadii(
  kind: CalibrationReferenceKind,
  diameterMm: number,
  touches: Partial<Record<ProbeCycleTouchKey, number>>,
  across: Partial<Record<ProbeCycleTouchKey, number>> = {},
): CalibrationRadii | null {
  const { xNegative, xPositive, yNegative, yPositive } = touches
  if (xNegative === undefined || xPositive === undefined || yNegative === undefined || yPositive === undefined) return null
  const spanX = Math.abs(xNegative - xPositive)
  const spanY = Math.abs(yNegative - yPositive)
  const centreX = (xNegative + xPositive) / 2
  const centreY = (yNegative + yPositive) / 2
  const xTouchesAtY = across.xNegative ?? across.xPositive
  const yTouchesAtX = across.yNegative ?? across.yPositive
  const offX = xTouchesAtY === undefined ? 0 : xTouchesAtY - centreY
  const offY = yTouchesAtX === undefined ? 0 : yTouchesAtX - centreX
  const toContact = (span: number, off: number) => Math.hypot(span / 2, off)
  const radius = (reach: number) => (kind === 'outside' ? reach - diameterMm / 2 : diameterMm / 2 - reach)
  return {
    spanXmm: round4(spanX),
    spanYmm: round4(spanY),
    radiusXmm: round4(radius(toContact(spanX, offX))),
    radiusYmm: round4(radius(toContact(spanY, offY))),
  }
}

/** A repeat calibration further than this from the tool's current value, on
 *  either axis, prints one console line saying by how much (Operator, 09-28: a
 *  console message, not a blocker). 0.01 mm: well past the repeatability of
 *  a touch probe, well inside what moves a part. */
export const CALIBRATION_DISAGREEMENT_MM = 0.01

/**
 * The one console line for a repeat calibration that differs from the tool's
 * current radii by more than CALIBRATION_DISAGREEMENT_MM on either axis, or
 * null (no current value, or within it).
 */
export function calibrationDisagreementLine(
  toolLabel: string,
  current: { x: number | null; y: number | null },
  measured: Pick<CalibrationRadii, 'radiusXmm' | 'radiusYmm'>,
): string | null {
  const parts: string[] = []
  let over = false
  for (const [axis, was, now] of [['X', current.x, measured.radiusXmm], ['Y', current.y, measured.radiusYmm]] as const) {
    if (was === null) continue
    const by = Math.abs(now - was)
    if (by > CALIBRATION_DISAGREEMENT_MM + 1e-9) over = true
    parts.push(`${axis} ${now.toFixed(3)} mm vs ${was.toFixed(3)} (by ${by.toFixed(3)})`)
  }
  if (!over) return null
  return `Calibrate: ${toolLabel} measured ${parts.join(', ')} - more than ${CALIBRATION_DISAGREEMENT_MM.toFixed(3)} mm `
    + 'from its current calibration. Confirm writes the new values.'
}
