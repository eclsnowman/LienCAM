// WO-3227 (WO-3167 Draft 2): the programmed cut of one flat end mill cutting on
// its side - chip thickness, removal rate and, only when cutting coefficients are
// given, specific force, power and torque. Advisory: it reads the tool's own feeds
// and speeds and writes nothing back (contracts.ts: never a fingerprint, a move or
// a refusal).
//
// Model (straight flute, peripheral cut, radial engagement ae on diameter D):
//   fz   = vf / (n z)
//   phi  = contact angle, 1 - cos(phi) = 2 ae / D, taken as 2 asin(sqrt(ae / D))
//          so a tiny ae neither cancels nor overflows
//   hmax = fz * Kr, Kr the radial chip-thinning factor (feeds/thinning.ts)
//   hm   = fz (1 - cos(phi)) / phi = fz (2 ae / D) / phi
//   Q    = ap ae vf / 1000                       cm3/min
//   kc   = kc11 hm^-mc   (Kienzle, 1 mm reference chip thickness)   N/mm2
//   P    = ap ae vf kc / 60 000                  W
//   T    = P / (2 pi n / 60)                     N*m
// Hand oracles (WO-3167): D=10, z=2, n=10000, vf=1000, ap=5, ae=10 -> hm = 0.1/pi,
// Q = 50 cm3/min, and with kc11=1700, mc=0.25 P ~ 3353.939 W, T ~ 3.202776 N*m.
import { chipThinningFactor } from '../feeds/thinning'
import { available, unavailable, type Estimate, type ProgrammedCutLoad } from './contracts'

/**
 * Below this maximum chip thickness the edge may rub rather than cut. A proposal
 * constant from the WO-3167 report, "not a universal edge-preparation fact":
 * it only words an advisory note and gates nothing.
 */
export const RUBBING_CHIP_THICKNESS_MM = 0.005

/** The one cutter shape the flat side-milling model applies to. */
export const PROGRAMMED_CUT_TOOL_TYPES: readonly string[] = ['flat_end_mill']

/** Why a quantity has no value; the screen words each one in its own language. */
export const CUT_REASON = {
  shape: 'the flat side-milling model does not apply to this cutter shape',
  depthOverFlutes: 'the depth of cut is longer than the flute length',
  invalidInput: 'a diameter, flute count, speed, feed, depth or stepover is missing or not a usable number',
  noSpindle: 'feed per tooth needs a spindle speed and a flute count above zero',
  noContact: 'with no stepover the cutter has no contact angle',
  stepoverOverDiameter: 'the stepover is wider than the cutter diameter',
  noCoefficients: 'power and torque need cutting coefficients (kc1.1 and mc)',
  invalidCoefficients: 'the cutting coefficients are not usable numbers (kc1.1 > 0, 0 <= mc < 1)',
  zeroChip: 'specific cutting force has no value at zero chip thickness',
} as const

export interface CuttingCoefficients {
  /** Specific cutting force at 1 mm chip thickness, N/mm2. */
  readonly kc11: number
  /** Kienzle exponent, dimensionless. */
  readonly mc: number
}

export interface ProgrammedCutInput {
  /** The tool's type (ToolType); only a flat end mill has this model. */
  readonly toolType: string
  readonly diameterMm: number
  readonly flutes: number
  /** Flute length, mm; a depth of cut beyond it is outside the model. */
  readonly fluteLengthMm?: number
  readonly rpm: number
  /** Programmed cutting feed, mm/min. */
  readonly feedMmMin: number
  /** Axial depth of cut ap, mm. */
  readonly axialDepthMm: number
  /** Radial depth of cut (stepover) ae, mm. */
  readonly radialDepthMm: number
  /** Optional; without them power and torque stay unavailable. */
  readonly coefficients?: CuttingCoefficients
}

const ASSUMPTIONS = [
  'flat end mill cutting on its side, straight flutes',
  'programmed depth and stepover, not the engagement the toolpath actually reaches',
]

const usable = (v: number) => Number.isFinite(v) && v >= 0

function allUnavailable(reason: string, rubbing = false): ProgrammedCutLoad {
  const none = unavailable<number>(reason, ASSUMPTIONS)
  return Object.freeze({
    feedPerToothMm: none, engagementAngleRad: none, maxChipMm: none, meanChipMm: none,
    removalRateCm3Min: none, specificForceNMm2: none, powerW: none, torqueNm: none, rubbing,
  })
}

/** The programmed cut of one flat end mill on its side; pure and deterministic. */
export function estimateProgrammedCut(input: ProgrammedCutInput): ProgrammedCutLoad {
  if (!PROGRAMMED_CUT_TOOL_TYPES.includes(input.toolType)) return allUnavailable(CUT_REASON.shape)
  const { diameterMm: D, flutes: z, rpm: n, feedMmMin: vf, axialDepthMm: ap, radialDepthMm: ae } = input
  if (!(D > 0) || !Number.isFinite(D) || ![z, n, vf, ap, ae].every(usable)) return allUnavailable(CUT_REASON.invalidInput)
  const fluteLength = input.fluteLengthMm
  if (fluteLength !== undefined && Number.isFinite(fluteLength) && fluteLength > 0 && ap > fluteLength) {
    return allUnavailable(CUT_REASON.depthOverFlutes)
  }

  const fz: Estimate<number> = n > 0 && z > 0
    ? available(vf / (n * z), ASSUMPTIONS)
    : unavailable(CUT_REASON.noSpindle, ASSUMPTIONS)
  if (ae > D) {
    const wide = unavailable<number>(CUT_REASON.stepoverOverDiameter, ASSUMPTIONS)
    return Object.freeze({
      feedPerToothMm: fz, engagementAngleRad: wide, maxChipMm: wide, meanChipMm: wide,
      removalRateCm3Min: wide, specificForceNMm2: wide, powerW: wide, torqueNm: wide, rubbing: false,
    })
  }

  const removal = ap * ae * vf / 1000
  const removalRateCm3Min = available(removal, ASSUMPTIONS)
  const r = ae / D
  const engagementAngleRad: Estimate<number> = ae > 0
    ? available(2 * Math.asin(Math.sqrt(r)), ASSUMPTIONS)
    : unavailable(CUT_REASON.noContact, ASSUMPTIONS)

  let maxChipMm: Estimate<number>
  let meanChipMm: Estimate<number>
  if (fz.status !== 'available') {
    maxChipMm = meanChipMm = unavailable(CUT_REASON.noSpindle, ASSUMPTIONS)
  } else if (engagementAngleRad.status !== 'available') {
    maxChipMm = meanChipMm = unavailable(CUT_REASON.noContact, ASSUMPTIONS)
  } else {
    maxChipMm = available(fz.value * chipThinningFactor(r), ASSUMPTIONS)
    meanChipMm = available(fz.value * (2 * r) / engagementAngleRad.value, ASSUMPTIONS)
  }

  const k = input.coefficients
  let specificForceNMm2: Estimate<number>
  let powerW: Estimate<number>
  let torqueNm: Estimate<number>
  if (!k) {
    specificForceNMm2 = powerW = torqueNm = unavailable(CUT_REASON.noCoefficients, ASSUMPTIONS)
  } else if (!(k.kc11 > 0) || !Number.isFinite(k.kc11) || !(k.mc >= 0 && k.mc < 1)) {
    specificForceNMm2 = powerW = torqueNm = unavailable(CUT_REASON.invalidCoefficients, ASSUMPTIONS)
  } else {
    const kAssumptions = [...ASSUMPTIONS, `Kienzle kc = kc1.1 hm^-mc with kc1.1 ${k.kc11} N/mm2 at 1 mm, mc ${k.mc}`]
    const hm = meanChipMm.status === 'available' ? meanChipMm.value : undefined
    specificForceNMm2 = hm !== undefined && hm > 0
      ? available(k.kc11 * Math.pow(hm, -k.mc), kAssumptions)
      : unavailable(meanChipMm.status === 'available' ? CUT_REASON.zeroChip : meanChipMm.reason, kAssumptions)
    if (removal === 0) {
      // No material removed: a known zero, whatever the chip.
      powerW = available(0, kAssumptions)
    } else if (specificForceNMm2.status === 'available') {
      powerW = available(ap * ae * vf * specificForceNMm2.value / 60_000, kAssumptions)
    } else {
      powerW = unavailable(specificForceNMm2.reason, kAssumptions)
    }
    torqueNm = powerW.status === 'available' && n > 0
      ? available(powerW.value / (2 * Math.PI * n / 60), kAssumptions)
      : unavailable(powerW.status === 'unavailable' ? powerW.reason : CUT_REASON.noSpindle, kAssumptions)
  }

  const rubbing = maxChipMm.status === 'available' && maxChipMm.value > 0 && maxChipMm.value < RUBBING_CHIP_THICKNESS_MM
  return Object.freeze({
    feedPerToothMm: fz, engagementAngleRad, maxChipMm, meanChipMm,
    removalRateCm3Min, specificForceNMm2, powerW, torqueNm, rubbing,
  })
}
