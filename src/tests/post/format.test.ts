import { describe, it, expect } from 'vitest'
import { fmtNum, word, fWord, sWord } from '../../lib/post/format'

describe('fmtNum', () => {
  it('trims trailing zeros', () => {
    expect(fmtNum(3.5, 3)).toBe('3.5')
    expect(fmtNum(3.50, 3)).toBe('3.5')
  })

  it('collapses an integer value (drops the decimal point)', () => {
    expect(fmtNum(3.0, 3)).toBe('3')
    expect(fmtNum(3, 3)).toBe('3')
    expect(fmtNum(0, 3)).toBe('0')
  })

  it('preserves negatives', () => {
    expect(fmtNum(-1.25, 3)).toBe('-1.25')
    expect(fmtNum(-5, 3)).toBe('-5')
  })

  it('normalizes -0 to 0', () => {
    expect(fmtNum(-0, 3)).toBe('0')
  })

  it('normalizes a tiny negative that rounds to zero (no "-0" word)', () => {
    // The arc-collapse I/J difference can produce -0.0004-scale values; these
    // must read "0", never "-0" (which some controllers reject).
    expect(fmtNum(-0.0004, 3)).toBe('0')
    expect(fmtNum(-0.00001, 3)).toBe('0')
    expect(word('J', -0.0004, 3)).toBe('J0')
  })

  it('honors the requested decimals (rounding)', () => {
    expect(fmtNum(1.23456, 3)).toBe('1.235')
    expect(fmtNum(1.2349, 2)).toBe('1.23')
    expect(fmtNum(2.5, 1)).toBe('2.5')
  })

  it('rounds away digits past the decimal budget rather than keeping them', () => {
    expect(fmtNum(0.0004, 3)).toBe('0')
    expect(fmtNum(0.0006, 3)).toBe('0.001')
  })
})

describe('word builders', () => {
  it('builds an address word', () => {
    expect(word('X', 3.5, 3)).toBe('X3.5')
    expect(word('Y', -2, 3)).toBe('Y-2')
  })

  it('fWord uses feed decimals', () => {
    expect(fWord(2000, 1)).toBe('F2000')
    expect(fWord(1234.56, 1)).toBe('F1234.6')
  })

  it('sWord rounds rpm to an integer', () => {
    expect(sWord(12000)).toBe('S12000')
    expect(sWord(11999.6)).toBe('S12000')
  })
})
