import { describe, expect, it } from 'vitest'
import {
  assertInternalCircleEnvelopeInside,
  internalCircleCenterRadius,
  resolveInternalCircleTargetDiameter,
} from '../../lib/cam/cutterEnvelope'

describe('cutterEnvelope internal circle helpers', () => {
  it('uses selected diameter when no target override is supplied', () => {
    expect(resolveInternalCircleTargetDiameter({
      operation: 'Bore',
      loopId: 'loop-a',
      selectedDiameter: 13,
    })).toBe(13)
  })

  it('allows a smaller manual target but rejects silent oversize targets', () => {
    expect(resolveInternalCircleTargetDiameter({
      operation: 'Bore',
      loopId: 'loop-a',
      selectedDiameter: 16,
      targetDiameter: 14,
    })).toBe(14)

    expect(() => resolveInternalCircleTargetDiameter({
      operation: 'Bore',
      loopId: 'loop-a',
      selectedDiameter: 13,
      targetDiameter: 14,
    })).toThrow(/exceeds selected diameter/i)
  })

  it('computes the center radius and rejects tools without radial clearance', () => {
    expect(internalCircleCenterRadius({
      operation: 'Bore',
      loopId: 'loop-a',
      targetDiameter: 14,
      toolDiameter: 6,
      minRadialClearance: 0.025,
    })).toBe(4)

    expect(() => internalCircleCenterRadius({
      operation: 'Bore',
      loopId: 'loop-a',
      targetDiameter: 6.02,
      toolDiameter: 6,
      minRadialClearance: 0.025,
    })).toThrow(/too small/i)
  })

  it('detects cutter-envelope overtravel against the selected boundary', () => {
    expect(() => assertInternalCircleEnvelopeInside({
      operation: 'Bore',
      loopId: 'loop-a',
      centerRadius: 3.5,
      toolDiameter: 6,
      boundaryDiameter: 13,
    })).not.toThrow()

    expect(() => assertInternalCircleEnvelopeInside({
      operation: 'Bore',
      loopId: 'loop-a',
      centerRadius: 4,
      toolDiameter: 6,
      boundaryDiameter: 13,
    })).toThrow(/cutter envelope radius/i)
  })
})
