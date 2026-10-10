import { describe, it, expect } from 'vitest'
import { parseGcode, tokenizeLine } from '../../lib/gcode/parse'

// A small known-good program exercising the subset the post emits.
const SAMPLE = [
  'G90 G94 G17 G21 G64',
  'G54',
  '( Profile )',
  'T1',
  'M3 S12000',
  'G0 X10 Y20 Z5',
  'G1 Z-2 F400',
  'X30 F2000',
  'Y40',
  'G0 Z5',
  'M5',
  'M30',
].join('\n')

describe('tokenizeLine', () => {
  it('parses address words and strips a paren comment', () => {
    const line = tokenizeLine('G1 X3.5 Y-2 F2000 ( cut )', 7)
    expect(line.comment).toBe('cut')
    expect(line.words).toEqual([
      { letter: 'G', value: 1 },
      { letter: 'X', value: 3.5 },
      { letter: 'Y', value: -2 },
      { letter: 'F', value: 2000 },
    ])
  })

  it('records an unknown letter without crashing', () => {
    const line = tokenizeLine('Q5 X1', 1)
    expect(line.words[0]).toEqual({ letter: 'Q', value: 5 })
  })
})

describe('parseGcode — modal interpreter', () => {
  const prog = parseGcode(SAMPLE)

  it('produces one segment per motion block', () => {
    // G0 X10Y20Z5, G1 Z-2, X30, Y40, G0 Z5  => 5 motion segments
    expect(prog.segments.length).toBe(5)
  })

  it('classifies rapid vs feed by modal motion mode', () => {
    expect(prog.segments[0].kind).toBe('rapid') // G0
    expect(prog.segments[1].kind).toBe('feed') // G1 plunge
    expect(prog.segments[2].kind).toBe('feed') // modal G1 continues (X30)
    expect(prog.segments[3].kind).toBe('feed') // modal G1 continues (Y40)
    expect(prog.segments[4].kind).toBe('rapid') // G0 retract
  })

  it('tracks modal from/to coordinates', () => {
    expect(prog.segments[0].from).toEqual({ x: 0, y: 0, z: 0 })
    expect(prog.segments[0].to).toEqual({ x: 10, y: 20, z: 5 })
    // X30 block: only X changes, Y/Z carried modally.
    expect(prog.segments[2].from).toEqual({ x: 10, y: 20, z: -2 })
    expect(prog.segments[2].to).toEqual({ x: 30, y: 20, z: -2 })
  })

  it('carries modal feed onto feed segments', () => {
    expect(prog.segments[1].feed).toBe(400)
    expect(prog.segments[2].feed).toBe(2000)
    expect(prog.segments[3].feed).toBe(2000) // modal feed persists
  })

  it('records the active WCS and final snapshot', () => {
    expect(prog.end.wcs).toBe(54)
    expect(prog.end.spindle).toBe(12000)
    expect(prog.end.position).toEqual({ x: 30, y: 40, z: 5 })
  })
})
