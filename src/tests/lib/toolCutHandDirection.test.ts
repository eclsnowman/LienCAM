import { describe, expect, it } from 'vitest'

import {
  directionForClockwiseSpindle,
  directionForTool,
  spindleRotationForTool,
} from '../../lib/tool/cutHand'

describe('physical milling direction contract', () => {
  it('derives spindle rotation only from the selected cutter hand', () => {
    expect(spindleRotationForTool({ cutHand: 'right' })).toBe('cw')
    expect(spindleRotationForTool({ cutHand: 'left' })).toBe('ccw')
    expect(spindleRotationForTool({ cutHand: undefined })).toBe('cw')
  })

  it('pins the complete tool-hand x physical-direction planner matrix', () => {
    expect(directionForTool('climb', { cutHand: 'right' })).toBe('climb')
    expect(directionForTool('conventional', { cutHand: 'right' })).toBe('conventional')
    expect(directionForTool('climb', { cutHand: 'left' })).toBe('conventional')
    expect(directionForTool('conventional', { cutHand: 'left' })).toBe('climb')
  })

  it('uses the same invariant for explicit spindle rotation', () => {
    expect(directionForClockwiseSpindle('climb', 'cw')).toBe('climb')
    expect(directionForClockwiseSpindle('conventional', 'cw')).toBe('conventional')
    expect(directionForClockwiseSpindle('climb', 'ccw')).toBe('conventional')
    expect(directionForClockwiseSpindle('conventional', 'ccw')).toBe('climb')
  })

  it('fails loud instead of guessing for malformed direction inputs', () => {
    expect(() => directionForClockwiseSpindle(
      'both_ways' as 'climb',
      'cw',
    )).toThrow(/invalid physical milling direction/i)
    expect(() => directionForClockwiseSpindle(
      'climb',
      'stopped' as 'cw',
    )).toThrow(/invalid spindle rotation/i)
  })
})
