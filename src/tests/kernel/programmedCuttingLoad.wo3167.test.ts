// WO-3227 (WO-3167 Draft 2): the programmed-cut estimator against WO-3167's
// hand-calculated flat peripheral-cut oracles, through the estimators index the
// Tool Library imports. Every oracle below is worked by hand in the comment
// beside it; none is the estimator's own output.
import { describe, expect, it } from 'vitest'
import {
  CUT_REASON, RUBBING_CHIP_THICKNESS_MM, estimateProgrammedCut,
  type Estimate, type ProgrammedCutInput, type ProgrammedCutLoad,
} from '../../kernel/estimators'

const SLOT: ProgrammedCutInput = {
  toolType: 'flat_end_mill', diameterMm: 10, flutes: 2, fluteLengthMm: 25,
  rpm: 10000, feedMmMin: 1000, axialDepthMm: 5, radialDepthMm: 10,
}
const K = { kc11: 1700, mc: 0.25 }

function value(e: Estimate<number>): number {
  expect(e.status, e.status === 'available' ? '' : `no value: ${e.reason}`).toBe('available')
  return e.status === 'available' ? e.value : Number.NaN
}
function reason(e: Estimate<number>): string {
  expect(e.status).toBe('unavailable')
  return e.status === 'unavailable' ? e.reason : ''
}
const QUANTITIES: readonly (keyof Omit<ProgrammedCutLoad, 'rubbing'>)[] = [
  'feedPerToothMm', 'engagementAngleRad', 'maxChipMm', 'meanChipMm',
  'removalRateCm3Min', 'specificForceNMm2', 'powerW', 'torqueNm',
]
function noNaN(load: ProgrammedCutLoad): void {
  for (const q of QUANTITIES) {
    const e = load[q]
    if (e.status !== 'unavailable') expect(Number.isFinite(e.value), q).toBe(true)
  }
}

describe('WO-3227 programmed cut: full slot oracle (D10 z2 n10000 vf1000 ap5 ae10)', () => {
  const load = estimateProgrammedCut({ ...SLOT, coefficients: K })

  it('fz = 1000 / (10000 * 2) = 0.05 mm; phi = pi; hmax = fz', () => {
    expect(value(load.feedPerToothMm)).toBeCloseTo(0.05, 12)
    expect(value(load.engagementAngleRad)).toBeCloseTo(Math.PI, 12)
    expect(value(load.maxChipMm)).toBeCloseTo(0.05, 12)
  })

  it('hm = 2 * 0.05 / pi = 0.0318309886 mm (mean, not max)', () => {
    expect(value(load.meanChipMm)).toBeCloseTo(0.0318309886, 9)
  })

  it('Q = 5 * 10 * 1000 / 1000 = 50 cm3/min', () => {
    expect(value(load.removalRateCm3Min)).toBeCloseTo(50, 12)
  })

  it('kc11 1700, mc 0.25: P ~ 3353.939 W, T ~ 3.202776 N*m (W, not kW)', () => {
    // kc = 1700 * (0.1/pi)^-0.25 = 4024.73 N/mm2; P = 5*10*1000*kc/60000.
    expect(value(load.specificForceNMm2)).toBeCloseTo(4024.727, 2)
    expect(value(load.powerW)).toBeCloseTo(3353.939, 2)
    expect(value(load.torqueNm)).toBeCloseTo(3.202776, 5)
    expect(load.rubbing).toBe(false)
  })
})

describe('WO-3227 programmed cut: light radial engagement (ae = 1)', () => {
  const load = estimateProgrammedCut({ ...SLOT, radialDepthMm: 1, coefficients: K })

  it('phi = acos(0.8), hmax = 0.05 * 0.6 = 0.03 mm, hm ~ 0.015539989 mm', () => {
    expect(value(load.engagementAngleRad)).toBeCloseTo(Math.acos(0.8), 12)
    expect(value(load.maxChipMm)).toBeCloseTo(0.03, 12)
    expect(value(load.meanChipMm)).toBeCloseTo(0.015539989, 9)
  })

  it('Q = 5 cm3/min, P ~ 401.241 W', () => {
    expect(value(load.removalRateCm3Min)).toBeCloseTo(5, 12)
    expect(value(load.powerW)).toBeCloseTo(401.241, 2)
  })
})

describe('WO-3227 programmed cut: Kienzle feed scaling', () => {
  it('mc 0.25 at half feed -> 0.5^0.75 = 0.5946035575 x the power', () => {
    const full = value(estimateProgrammedCut({ ...SLOT, coefficients: K }).powerW)
    const half = value(estimateProgrammedCut({ ...SLOT, feedMmMin: 500, coefficients: K }).powerW)
    expect(half / full).toBeCloseTo(0.5946035575, 9)
  })
})

describe('WO-3227 programmed cut: missing and edge inputs never show NaN', () => {
  it('no coefficients: P, T and kc unavailable, fz/hmax/hm/Q still valid', () => {
    const load = estimateProgrammedCut(SLOT)
    expect(reason(load.powerW)).toBe(CUT_REASON.noCoefficients)
    expect(reason(load.torqueNm)).toBe(CUT_REASON.noCoefficients)
    expect(reason(load.specificForceNMm2)).toBe(CUT_REASON.noCoefficients)
    expect(value(load.feedPerToothMm)).toBeCloseTo(0.05, 12)
    expect(value(load.meanChipMm)).toBeCloseTo(0.0318309886, 9)
    expect(value(load.removalRateCm3Min)).toBe(50)
  })

  it('ae = 0: a known zero removal; contact-angle quantities unavailable', () => {
    const load = estimateProgrammedCut({ ...SLOT, radialDepthMm: 0, coefficients: K })
    expect(value(load.removalRateCm3Min)).toBe(0)
    expect(reason(load.engagementAngleRad)).toBe(CUT_REASON.noContact)
    expect(reason(load.maxChipMm)).toBe(CUT_REASON.noContact)
    expect(reason(load.meanChipMm)).toBe(CUT_REASON.noContact)
    expect(value(load.powerW)).toBe(0)
    noNaN(load)
  })

  it('ap = 0: zero removal, the chip itself is still defined', () => {
    const load = estimateProgrammedCut({ ...SLOT, axialDepthMm: 0, coefficients: K })
    expect(value(load.removalRateCm3Min)).toBe(0)
    expect(value(load.maxChipMm)).toBeCloseTo(0.05, 12)
    expect(value(load.powerW)).toBe(0)
    noNaN(load)
  })

  it('n = 0 or z = 0: fz and the chip unavailable, Q still known', () => {
    for (const patch of [{ rpm: 0 }, { flutes: 0 }]) {
      const load = estimateProgrammedCut({ ...SLOT, ...patch, coefficients: K })
      expect(reason(load.feedPerToothMm)).toBe(CUT_REASON.noSpindle)
      expect(reason(load.maxChipMm)).toBe(CUT_REASON.noSpindle)
      expect(reason(load.powerW)).toBe(CUT_REASON.noSpindle)
      expect(value(load.removalRateCm3Min)).toBe(50)
      noNaN(load)
    }
  })

  it('D <= 0, NaN or infinity: every quantity unavailable, no NaN', () => {
    for (const patch of [{ diameterMm: 0 }, { diameterMm: -6 }, { feedMmMin: Number.NaN }, { rpm: Number.POSITIVE_INFINITY }, { radialDepthMm: -1 }]) {
      const load = estimateProgrammedCut({ ...SLOT, ...patch, coefficients: K })
      for (const q of QUANTITIES) expect(reason(load[q]), q).toBe(CUT_REASON.invalidInput)
    }
  })

  it('ae > D: explicit status, never clamped to a slot', () => {
    const load = estimateProgrammedCut({ ...SLOT, radialDepthMm: 12, coefficients: K })
    expect(reason(load.maxChipMm)).toBe(CUT_REASON.stepoverOverDiameter)
    expect(reason(load.removalRateCm3Min)).toBe(CUT_REASON.stepoverOverDiameter)
    expect(value(load.feedPerToothMm)).toBeCloseTo(0.05, 12)
  })

  it('unusable coefficients: P/T unavailable with their own reason', () => {
    const load = estimateProgrammedCut({ ...SLOT, coefficients: { kc11: 0, mc: 0.25 } })
    expect(reason(load.powerW)).toBe(CUT_REASON.invalidCoefficients)
    expect(value(load.removalRateCm3Min)).toBe(50)
  })

  it('tiny ae neither cancels nor overflows: phi ~ 2 sqrt(ae/D), hm ~ fz sqrt(ae/D)', () => {
    const load = estimateProgrammedCut({ ...SLOT, radialDepthMm: 1e-12, coefficients: K })
    // r = 1e-13: phi = 2 asin(sqrt r) ~ 2 * 3.16227766e-7; hm = fz * 2r / phi ~ fz * sqrt(r).
    expect(value(load.engagementAngleRad) / (2 * Math.sqrt(1e-13))).toBeCloseTo(1, 9)
    expect(value(load.meanChipMm) / (0.05 * Math.sqrt(1e-13))).toBeCloseTo(1, 9)
    noNaN(load)
  })
})

describe('WO-3227 programmed cut: where the model applies', () => {
  it('ball, bull, drill, taper, thread and undercut cutters: model does not apply', () => {
    for (const toolType of ['ball_end_mill', 'bull_nose', 'drill', 'tapered_endmill', 'thread_mill', 'lollipop_mill', 'dovetail_mill']) {
      const load = estimateProgrammedCut({ ...SLOT, toolType, coefficients: K })
      for (const q of QUANTITIES) expect(reason(load[q]), `${toolType} ${q}`).toBe(CUT_REASON.shape)
    }
  })

  it('ap longer than the flute length: model does not apply (never clamped)', () => {
    const load = estimateProgrammedCut({ ...SLOT, axialDepthMm: 30 })
    for (const q of QUANTITIES) expect(reason(load[q]), q).toBe(CUT_REASON.depthOverFlutes)
  })
})

describe('WO-3227 programmed cut: rubbing note threshold', () => {
  it(`hmax below ${RUBBING_CHIP_THICKNESS_MM} mm flags rubbing; at or above does not`, () => {
    // ae = 1 gives Kr = 0.6: vf 160 -> fz 0.008, hmax 0.0048 (rubs); vf 200 -> hmax 0.006.
    expect(estimateProgrammedCut({ ...SLOT, radialDepthMm: 1, feedMmMin: 160 }).rubbing).toBe(true)
    expect(estimateProgrammedCut({ ...SLOT, radialDepthMm: 1, feedMmMin: 200 }).rubbing).toBe(false)
    expect(estimateProgrammedCut({ ...SLOT, feedMmMin: 0 }).rubbing).toBe(false)
  })
})
