// Unit tests for the UI unit-conversion shim (ADR-0022, Phase 1).
//
// Core guarantees: mm mode is an identity transform (so today's behavior is
// byte-identical), inch conversion uses 1 in = 25.4 mm EXACT, round-trips are
// lossless to float precision, and garbage parses to NaN (never 0).

import { describe, it, expect } from 'vitest'
import {
  MM_PER_INCH,
  MM2_PER_IN2,
  DIM_DECIMALS,
  FEED_DECIMALS,
  AREA_DECIMALS,
  unitLabel,
  feedLabel,
  areaLabel,
  toDisplay,
  fromDisplay,
  fmtDim,
  fmtArea,
  parseDimToMm,
  feedToDisplay,
  fmtFeed,
  parseFeedToMmMin,
} from '../../lib/ui/unitFormat'

describe('unitFormat constants', () => {
  it('1 inch = 25.4 mm exactly', () => {
    expect(MM_PER_INCH).toBe(25.4)
  })
  it('per-unit decimals tables', () => {
    expect(DIM_DECIMALS).toEqual({ mm: 3, inch: 4 })
    expect(FEED_DECIMALS).toEqual({ mm: 1, inch: 1 })
  })
})

describe('mm mode is identity', () => {
  it('toDisplay/fromDisplay return the input unchanged', () => {
    for (const x of [0, 1, 25.4, 123.456, -7.5]) {
      expect(toDisplay(x, 'mm')).toBe(x)
      expect(fromDisplay(x, 'mm')).toBe(x)
    }
  })
  it('fmtDim is just toFixed(3) at mm', () => {
    expect(fmtDim(25.4, 'mm')).toBe('25.400')
    expect(fmtDim(0, 'mm')).toBe('0.000')
  })
  it('feeds are identity at mm', () => {
    expect(feedToDisplay(1500, 'mm')).toBe(1500)
    expect(fmtFeed(1500, 'mm')).toBe('1500.0')
    expect(parseFeedToMmMin('1500', 'mm')).toBe(1500)
  })
  it('parseDimToMm at mm', () => {
    expect(parseDimToMm('25.4', 'mm')).toBe(25.4)
  })
})

describe('inch conversion (25.4 mm <-> 1.0000 in)', () => {
  it('toDisplay 25.4 mm -> 1 in', () => {
    expect(toDisplay(25.4, 'inch')).toBe(1)
  })
  it('fmtDim 25.4 mm -> "1.0000"', () => {
    expect(fmtDim(25.4, 'inch')).toBe('1.0000')
  })
  it('parseDimToMm "1" inch -> 25.4 mm', () => {
    expect(parseDimToMm('1', 'inch')).toBe(25.4)
  })
  it('round-trips losslessly', () => {
    for (const x of [0.5, 1, 12.7, 50.8, 101.6, 3.175]) {
      expect(fromDisplay(toDisplay(x, 'inch'), 'inch')).toBeCloseTo(x, 9)
    }
  })
})

describe('feeds in inch (IPM)', () => {
  it('254 mm/min = 10 IPM', () => {
    expect(feedToDisplay(254, 'inch')).toBe(10)
  })
  it('fmtFeed 254 mm/min -> "10.0"', () => {
    expect(fmtFeed(254, 'inch')).toBe('10.0')
  })
  it('parseFeedToMmMin "10" inch -> 254 mm/min', () => {
    expect(parseFeedToMmMin('10', 'inch')).toBe(254)
  })
})

describe('labels', () => {
  it('unitLabel', () => {
    expect(unitLabel('mm')).toBe('mm')
    expect(unitLabel('inch')).toBe('in')
  })
  it('feedLabel', () => {
    expect(feedLabel('mm')).toBe('mm/min')
    expect(feedLabel('inch')).toBe('in/min')
  })
})

describe('area (mm² <-> in²)', () => {
  it('MM2_PER_IN2 = 645.16 exactly (25.4²)', () => {
    expect(MM2_PER_IN2).toBe(645.16)
    expect(MM2_PER_IN2).toBe(MM_PER_INCH * MM_PER_INCH)
  })
  it('AREA_DECIMALS table', () => {
    expect(AREA_DECIMALS).toEqual({ mm: 1, inch: 3 })
  })
  it('areaLabel uses the superscript-2 glyph', () => {
    expect(areaLabel('mm')).toBe('mm²')
    expect(areaLabel('inch')).toBe('in²')
  })
  it('mm is identity with today toFixed(1)', () => {
    // Matches the legacy `loop.area.toFixed(1)` output exactly.
    expect(fmtArea(645.16, 'mm')).toBe('645.2')
    expect(fmtArea(19.9, 'mm')).toBe('19.9')
    expect(fmtArea(0, 'mm')).toBe('0.0')
  })
  it('inch: 645.16 mm² -> 1.000 in²', () => {
    expect(fmtArea(MM2_PER_IN2, 'inch')).toBe('1.000')
    expect(fmtArea(2 * MM2_PER_IN2, 'inch')).toBe('2.000')
  })
})

describe('parse tolerance and garbage handling', () => {
  it('garbage -> NaN, not 0', () => {
    expect(parseDimToMm('abc', 'mm')).toBeNaN()
    expect(parseDimToMm('', 'mm')).toBeNaN()
    expect(parseDimToMm('1 2', 'mm')).toBeNaN()
    expect(parseFeedToMmMin('xyz', 'inch')).toBeNaN()
  })
  it('tolerant of a trailing unit label', () => {
    expect(parseDimToMm('25.4 mm', 'mm')).toBe(25.4)
    expect(parseDimToMm('1 in', 'inch')).toBe(25.4)
    expect(parseDimToMm('1.0000in', 'inch')).toBe(25.4)
    expect(parseFeedToMmMin('10 in/min', 'inch')).toBe(254)
  })
  it('accepts a raw number input', () => {
    expect(parseDimToMm(25.4, 'mm')).toBe(25.4)
    expect(parseDimToMm(1, 'inch')).toBe(25.4)
  })
})
