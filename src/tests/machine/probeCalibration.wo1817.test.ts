// @vitest-environment jsdom
//
// WO-1817 - probe calibration states tip diameter and runout instead of
// assuming them. Pure calculation coverage for lib/machine/probeCalibration.ts
// plus a render check that the definition panel's new calibration subsection
// (components/machine/definition/ProbingSection.tsx) shows the named
// UNCALIBRATED state rather than silently defaulting.

import React from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import {
  CALIBRATION_STALE_AFTER_DAYS,
  describeProbeCalibration,
  makeCalibrationFact,
  measureRunoutMm,
  measureTipDiameterMm,
  resolveTipRadiusMm,
  withRunout,
  withTipDiameter,
} from '../../lib/machine/probeCalibration'
import { ProbeCalibrationStatus } from '../../components/machine/definition/ProbingSection'
import type { ProbeCalibration } from '../../types'

afterEach(() => {
  cleanup()
})

describe('measureTipDiameterMm', () => {
  it('reads a known bore raw span into a tip diameter', () => {
    // Known bore: 20mm. Real tip radius 1.5mm -> raw span (uncompensated)
    // reads 2 * 1.5 = 3mm narrower than the true bore, on each axis.
    const tipDiameterMm = measureTipDiameterMm('bore', 20, {
      xNegativeMm: -8.5, xPositiveMm: 8.5,
      yNegativeMm: -8.5, yPositiveMm: 8.5,
    })
    expect(tipDiameterMm).toBeCloseTo(3, 6)
  })

  it('reads a known boss raw span into a tip diameter', () => {
    // Known boss: 20mm. Real tip radius 1.5mm -> raw span reads 3mm WIDER
    // than the true boss (touches happen outside the face).
    const tipDiameterMm = measureTipDiameterMm('boss', 20, {
      xNegativeMm: 11.5, xPositiveMm: -11.5,
      yNegativeMm: 11.5, yPositiveMm: -11.5,
    })
    expect(tipDiameterMm).toBeCloseTo(3, 6)
  })

  it('refuses a nominal diameter that is not physically possible', () => {
    // Raw span (20mm) already exceeds the stated nominal bore (18mm) -
    // a negative tip diameter, which cannot happen.
    expect(() => measureTipDiameterMm('bore', 18, {
      xNegativeMm: -10, xPositiveMm: 10,
      yNegativeMm: -10, yPositiveMm: 10,
    })).toThrow(RangeError)
  })

  it('refuses a non-finite or non-positive nominal diameter', () => {
    const touches = { xNegativeMm: -8, xPositiveMm: 8, yNegativeMm: -8, yPositiveMm: 8 }
    expect(() => measureTipDiameterMm('bore', 0, touches)).toThrow(RangeError)
    expect(() => measureTipDiameterMm('bore', Number.NaN, touches)).toThrow(RangeError)
  })
})

describe('measureRunoutMm', () => {
  it('is the absolute difference between the two spin-probe touches', () => {
    expect(measureRunoutMm(10.02, 10.05)).toBeCloseTo(0.03, 6)
    expect(measureRunoutMm(10.05, 10.02)).toBeCloseTo(0.03, 6)
  })

  it('is zero for a perfectly concentric tip', () => {
    expect(measureRunoutMm(12.5, 12.5)).toBe(0)
  })

  it('refuses non-finite trigger positions', () => {
    expect(() => measureRunoutMm(Number.NaN, 1)).toThrow(RangeError)
    expect(() => measureRunoutMm(1, Number.POSITIVE_INFINITY)).toThrow(RangeError)
  })
})

describe('makeCalibrationFact / withTipDiameter / withRunout', () => {
  it('builds a fact and layers it onto a calibration record without disturbing the other field', () => {
    const tipFact = makeCalibrationFact(3, 'measured', '2026-09-20')
    const runoutFact = makeCalibrationFact(0.03, 'stated', '2026-09-01')

    let calibration: ProbeCalibration | undefined
    calibration = withTipDiameter(calibration, tipFact)
    expect(calibration).toEqual({ tipDiameter: tipFact })

    calibration = withRunout(calibration, runoutFact)
    expect(calibration).toEqual({ tipDiameter: tipFact, runout: runoutFact })
  })

  it('refuses a non-positive or non-finite calibration value', () => {
    expect(() => makeCalibrationFact(0, 'stated', '2026-09-20')).toThrow(RangeError)
    expect(() => makeCalibrationFact(-1, 'measured', '2026-09-20')).toThrow(RangeError)
    expect(() => makeCalibrationFact(Number.NaN, 'stated', '2026-09-20')).toThrow(RangeError)
  })
})

describe('describeProbeCalibration / resolveTipRadiusMm', () => {
  it('names an absent calibration UNCALIBRATED, with no tip radius to resolve', () => {
    const summary = describeProbeCalibration(undefined)
    expect(summary.state).toBe('uncalibrated')
    expect(summary.tipDiameterMm).toBeNull()
    expect(summary.tipRadiusMm).toBeNull()
    expect(summary.label).toMatch(/uncalibrated/i)
    expect(resolveTipRadiusMm(undefined)).toBeNull()
  })

  it('reports a stated tip diameter as the stated state, radius derived from diameter', () => {
    const calibration: ProbeCalibration = {
      tipDiameter: makeCalibrationFact(3, 'stated', '2026-09-01'),
    }
    const summary = describeProbeCalibration(calibration, new Date('2026-09-02'))
    expect(summary.state).toBe('stated')
    expect(summary.tipDiameterMm).toBe(3)
    expect(summary.tipRadiusMm).toBe(1.5)
    expect(summary.tipDiameterStale).toBe(false)
    expect(resolveTipRadiusMm(calibration)).toBe(1.5)
  })

  it('reports a measured tip diameter as the measured state', () => {
    const calibration: ProbeCalibration = {
      tipDiameter: makeCalibrationFact(2.4, 'measured', '2026-09-20'),
    }
    const summary = describeProbeCalibration(calibration, new Date('2026-09-20'))
    expect(summary.state).toBe('measured')
    expect(summary.label).toMatch(/measured/i)
  })

  it('flags a tip diameter older than the stale threshold', () => {
    const staleDate = new Date('2026-09-22')
    staleDate.setDate(staleDate.getDate() - (CALIBRATION_STALE_AFTER_DAYS + 1))
    const calibration: ProbeCalibration = {
      tipDiameter: makeCalibrationFact(3, 'measured', staleDate.toISOString()),
    }
    const summary = describeProbeCalibration(calibration, new Date('2026-09-22'))
    expect(summary.tipDiameterStale).toBe(true)
    expect(summary.label).toMatch(/stale/i)
  })

  it('does not flag a tip diameter within the stale threshold', () => {
    const recentDate = new Date('2026-09-22')
    recentDate.setDate(recentDate.getDate() - (CALIBRATION_STALE_AFTER_DAYS - 1))
    const calibration: ProbeCalibration = {
      tipDiameter: makeCalibrationFact(3, 'measured', recentDate.toISOString()),
    }
    const summary = describeProbeCalibration(calibration, new Date('2026-09-22'))
    expect(summary.tipDiameterStale).toBe(false)
  })

  it('carries runout independently of tip diameter state', () => {
    const calibration: ProbeCalibration = {
      runout: makeCalibrationFact(0.02, 'measured', '2026-09-10'),
    }
    const summary = describeProbeCalibration(calibration, new Date('2026-09-11'))
    expect(summary.state).toBe('uncalibrated')
    expect(summary.runoutMm).toBe(0.02)
    expect(summary.runoutProvenance).toBe('measured')
  })
})

describe('ProbeCalibrationStatus (definition panel)', () => {
  it('shows the uncalibrated warning when no calibration is recorded', () => {
    render(React.createElement(ProbeCalibrationStatus, { calibration: undefined }))
    expect(screen.getByTestId('machine-def-panel-probing-calibration-state').textContent)
      .toMatch(/uncalibrated/i)
    expect(screen.getByTestId('machine-def-panel-probing-calibration-warning')).toBeTruthy()
    expect(screen.queryByTestId('machine-def-panel-probing-calibration-tip-diameter')).toBeNull()
  })

  it('shows the stated tip diameter and runout, with no uncalibrated warning', () => {
    const calibration: ProbeCalibration = {
      tipDiameter: makeCalibrationFact(3, 'stated', '2026-09-01'),
      runout: makeCalibrationFact(0.02, 'measured', '2026-09-20'),
    }
    render(React.createElement(ProbeCalibrationStatus, { calibration }))
    expect(screen.getByTestId('machine-def-panel-probing-calibration-tip-diameter').textContent)
      .toMatch(/3 mm/)
    expect(screen.getByTestId('machine-def-panel-probing-calibration-runout').textContent)
      .toMatch(/0.02 mm/)
    expect(screen.queryByTestId('machine-def-panel-probing-calibration-warning')).toBeNull()
  })
})
