// WO-298: measure how crooked the part is - pure arithmetic only, no WCS
// write, no caller yet (the probing screen this feeds is WO-297's rebuild).

import { describe, expect, it } from 'vitest'

import { calculateYawAngle, type YawAngleInput } from '../../lib/machine/probeRoutines'

const BASE: Omit<YawAngleInput, 'nominalAxis' | 'first' | 'second'> = {
  direction: '+',
  tipRadiusMm: 3,
}

describe('calculateYawAngle', () => {
  it('reads a small CCW angle against a nominal X side', () => {
    // along = X (0 -> 100), across = Y. Raw triggers 15 then 10 - after the
    // shared +3 mm compensation that is still a +5 mm rise over 100 mm run.
    const result = calculateYawAngle({
      ...BASE,
      nominalAxis: 'X',
      first: { alongMm: 0, triggerPositionMm: 10 },
      second: { alongMm: 100, triggerPositionMm: 15 },
    })
    const expectedDeg = (Math.atan2(5, 100) * 180) / Math.PI
    expect(result.thetaDeg).toBeCloseTo(expectedDeg, 9)
    expect(result.thetaDeg).toBeGreaterThan(0)
  })

  it('reads a small CW angle against a nominal X side', () => {
    const result = calculateYawAngle({
      ...BASE,
      nominalAxis: 'X',
      first: { alongMm: 0, triggerPositionMm: 15 },
      second: { alongMm: 100, triggerPositionMm: 10 },
    })
    const expectedDeg = (Math.atan2(-5, 100) * 180) / Math.PI
    expect(result.thetaDeg).toBeCloseTo(expectedDeg, 9)
    expect(result.thetaDeg).toBeLessThan(0)
  })

  it('reads a small CCW angle against a nominal Y side', () => {
    // along = Y (0 -> 100), across = X. CCW from +Y sweeps toward -X, so the
    // across coordinate must FALL as along rises for a positive angle.
    const result = calculateYawAngle({
      ...BASE,
      nominalAxis: 'Y',
      first: { alongMm: 0, triggerPositionMm: 15 },
      second: { alongMm: 100, triggerPositionMm: 10 },
    })
    const expectedDeg = (Math.atan2(5, 100) * 180) / Math.PI
    expect(result.thetaDeg).toBeCloseTo(expectedDeg, 9)
    expect(result.thetaDeg).toBeGreaterThan(0)
  })

  it('reads a small CW angle against a nominal Y side', () => {
    const result = calculateYawAngle({
      ...BASE,
      nominalAxis: 'Y',
      first: { alongMm: 0, triggerPositionMm: 10 },
      second: { alongMm: 100, triggerPositionMm: 15 },
    })
    const expectedDeg = (Math.atan2(-5, 100) * 180) / Math.PI
    expect(result.thetaDeg).toBeCloseTo(expectedDeg, 9)
    expect(result.thetaDeg).toBeLessThan(0)
  })

  it('reports the COMPENSATED touch points, not the raw trigger coordinates', () => {
    // tipRadiusMm=4 on a '+' touch shifts each raw trigger by a visible
    // amount (20 -> 24, 20.5 -> 24.5); theta itself is unaffected by tip
    // radius here (both touches share one direction and radius, so the
    // shift is a constant added to both points and cancels out of the
    // direction between them - see calculateYawAngle's doc comment) but the
    // reported points must still be the compensated ones, because that is
    // what a machinist checking the number by hand would touch and read.
    const result = calculateYawAngle({
      direction: '+',
      tipRadiusMm: 4,
      nominalAxis: 'X',
      first: { alongMm: 0, triggerPositionMm: 20 },
      second: { alongMm: 50, triggerPositionMm: 20.5 },
    })
    expect(result.first).toEqual({ xMm: 0, yMm: 24 })
    expect(result.second).toEqual({ xMm: 50, yMm: 24.5 })
    expect(result.first.yMm).not.toBe(20)
    expect(result.second.yMm).not.toBe(20.5)
    const expectedDeg = (Math.atan2(0.5, 50) * 180) / Math.PI
    expect(result.thetaDeg).toBeCloseTo(expectedDeg, 9)
  })

  it('refuses two touches at the same position along the side', () => {
    expect(() =>
      calculateYawAngle({
        ...BASE,
        nominalAxis: 'X',
        first: { alongMm: 50, triggerPositionMm: 10 },
        second: { alongMm: 50, triggerPositionMm: 12 },
      }),
    ).toThrow(/same position/i)
  })

  it('refuses a non-finite input', () => {
    expect(() =>
      calculateYawAngle({
        ...BASE,
        nominalAxis: 'X',
        first: { alongMm: 0, triggerPositionMm: 10 },
        second: { alongMm: 100, triggerPositionMm: Number.NaN },
      }),
    ).toThrow(RangeError)
    expect(() =>
      calculateYawAngle({
        ...BASE,
        nominalAxis: 'X',
        first: { alongMm: 0, triggerPositionMm: 10 },
        second: { alongMm: Number.POSITIVE_INFINITY, triggerPositionMm: 15 },
      }),
    ).toThrow(RangeError)
  })

  it('reports a large angle as measured - no limit (WO-2188, Operator 09-29)', () => {
    // atan(30/100) ~ 16.7 deg: once refused past 5 deg; now reported.
    const result = calculateYawAngle({
      ...BASE,
      nominalAxis: 'X',
      first: { alongMm: 0, triggerPositionMm: 0 },
      second: { alongMm: 100, triggerPositionMm: 30 },
    })
    expect(result.thetaDeg).toBeCloseTo((Math.atan2(30, 100) * 180) / Math.PI, 9)
  })
})
