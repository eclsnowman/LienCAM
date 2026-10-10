import { describe, it, expect } from 'vitest'
import { lintGcode, assertClean } from '../../lib/gcode/lint'

const GOOD = [
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

describe('lintGcode — clean program', () => {
  it('returns zero errors on a known-good sample', () => {
    const findings = lintGcode(GOOD)
    const errors = findings.filter((f) => f.level === 'error')
    expect(errors).toEqual([])
  })

  it('assertClean does not throw on a good program', () => {
    expect(() => assertClean(GOOD)).not.toThrow()
  })
})

describe('lintGcode — flags bad programs', () => {
  it('flags unbalanced parentheses', () => {
    const bad = 'G0 X10 ( open comment\nM30'
    const findings = lintGcode(bad)
    expect(findings.some((f) => f.code === 'UNBALANCED_PAREN' && f.level === 'error')).toBe(true)
  })

  it('flags a stray garbage token', () => {
    const bad = ['G54', 'G0 X10 Y20 Z5 @ junk', 'M30'].join('\n')
    const findings = lintGcode(bad)
    expect(findings.some((f) => f.code === 'STRAY_TOKEN' && f.level === 'error')).toBe(true)
  })

  it('flags a semicolon comment in a parens-only file', () => {
    const bad = ['G54', 'G0 X10 Y20 Z5 ; reposition', 'M30'].join('\n')
    const findings = lintGcode(bad, { commentStyle: 'paren' })
    expect(findings.some((f) => f.code === 'WRONG_COMMENT_STYLE' && f.level === 'error')).toBe(true)
  })

  it('accepts semicolon comments when commentStyle is semicolon', () => {
    const ok = ['G54', 'G0 X10 Y20 Z5 ; reposition', 'M3 S1000', 'G1 X20 F500', 'M30'].join('\n')
    const findings = lintGcode(ok, { commentStyle: 'semicolon' })
    expect(findings.some((f) => f.code === 'WRONG_COMMENT_STYLE')).toBe(false)
    expect(findings.some((f) => f.code === 'STRAY_TOKEN')).toBe(false)
  })

  it('semicolon style still reads parenthesised comments (LinuxCNC accepts both)', () => {
    const ok = ['G21 G90 G54', 'G0 Z5 (retract)', 'G0 X0 Y0 ; park', 'M30'].join('\n')
    const findings = lintGcode(ok, { commentStyle: 'semicolon' })
    expect(findings).toEqual([])
  })

  it('flags a missing program end', () => {
    const bad = ['G54', 'G0 X10 Y20 Z5'].join('\n')
    const findings = lintGcode(bad)
    expect(findings.some((f) => f.code === 'NO_PROGRAM_END')).toBe(true)
  })

  it('flags the first motion block lacking an explicit motion mode', () => {
    const bad = ['G54', 'X10 Y20 Z5', 'M30'].join('\n')
    const findings = lintGcode(bad)
    expect(findings.some((f) => f.code === 'NO_INITIAL_MOTION_MODE')).toBe(true)
  })

  it('warns when the spindle is not started before the first feed', () => {
    const bad = ['G54', 'G0 X0 Y0 Z5', 'G1 Z-1 F300', 'M3 S1000', 'M30'].join('\n')
    const findings = lintGcode(bad)
    expect(findings.some((f) => f.code === 'SPINDLE_NOT_STARTED' && f.level === 'warning')).toBe(true)
  })

  it('assertClean throws on an error-bearing program', () => {
    const bad = 'G0 X10 ( oops\nM30'
    expect(() => assertClean(bad)).toThrow(/lint found/)
  })
})

describe('lintGcode — arc-block well-formedness', () => {
  it('passes a well-formed arc with I/J center offsets', () => {
    const ok = ['G54', 'G0 X0 Y0 Z5', 'G2 X10 Y10 I5 J0 F500', 'M30'].join('\n')
    const findings = lintGcode(ok)
    expect(findings.some((f) => f.code === 'ARC_NO_CENTER')).toBe(false)
    expect(findings.some((f) => f.code === 'ARC_R_AND_IJK')).toBe(false)
  })

  it('flags a G3 endpoint move with no I/J/K and no R as ARC_NO_CENTER', () => {
    const bad = ['G54', 'G0 X0 Y0 Z5', 'G3 X10 Y10 F500', 'M30'].join('\n')
    const findings = lintGcode(bad)
    expect(findings.some((f) => f.code === 'ARC_NO_CENTER' && f.level === 'error')).toBe(true)
  })

  it('respects modality: an inherited-G2 block with a center passes, one without errors', () => {
    const text = [
      'G54',
      'G0 X0 Y0 Z5',
      'G2 X1 Y1 I1 J0 F500', // explicit arc, well-formed
      'X2 Y2 I0 J1', // inherits G2 modally, well-formed
      'X3 Y3', // still modal G2, missing center -> error
      'M30',
    ].join('\n')
    const findings = lintGcode(text)
    const arcErrors = findings.filter((f) => f.code === 'ARC_NO_CENTER')
    expect(arcErrors.length).toBe(1)
    expect(arcErrors[0].line).toBe(5)
  })

  it('does not flag a following G1 block once the motion mode is cleared', () => {
    const text = [
      'G54',
      'G0 X0 Y0 Z5',
      'G2 X1 Y1 I1 J0 F500',
      'G1 X4 Y4', // mode switched away from arc; no center required
      'M30',
    ].join('\n')
    const findings = lintGcode(text)
    expect(findings.some((f) => f.code === 'ARC_NO_CENTER')).toBe(false)
  })

  it('warns ARC_R_AND_IJK when an arc carries both R and I/J/K', () => {
    const text = ['G54', 'G0 X0 Y0 Z5', 'G2 X1 Y1 R5 I1 J0 F500', 'M30'].join('\n')
    const findings = lintGcode(text)
    expect(findings.some((f) => f.code === 'ARC_R_AND_IJK' && f.level === 'warning')).toBe(true)
  })
})

describe('lintGcode — drill canned cycles', () => {
  it('accepts a G83 peck block with the Q increment (no UNKNOWN_LETTER on Q)', () => {
    const text = [
      'G54',
      'T1',
      'M3 S8000',
      'G0 Z15',
      'G98 G83 X10 Y10 Z-11 R1 Q3 F150', // peck cycle: Q is the peck increment
      'X35 Y14',
      'X60 Y10',
      'G80',
      'M5',
      'M30',
    ].join('\n')
    const findings = lintGcode(text)
    expect(findings.some((f) => f.code === 'UNKNOWN_LETTER')).toBe(false)
    expect(findings.filter((f) => f.level === 'error')).toEqual([])
  })

  it('accepts a G82 dwell block (P) and a G81 simple block (R)', () => {
    const text = [
      'G54',
      'T1',
      'M3 S8000',
      'G0 Z15',
      'G98 G82 X0 Y0 Z-5 R1 P500 F150', // dwell cycle
      'G98 G81 X20 Y0 Z-5 R1 F150', // simple cycle
      'G80',
      'M5',
      'M30',
    ].join('\n')
    const findings = lintGcode(text)
    expect(findings.filter((f) => f.level === 'error')).toEqual([])
  })

  it('still flags a genuinely unknown letter (e.g. W) as UNKNOWN_LETTER', () => {
    const bad = ['G54', 'G0 X10 Y20 Z5 W3', 'M30'].join('\n')
    const findings = lintGcode(bad)
    expect(findings.some((f) => f.code === 'UNKNOWN_LETTER' && f.level === 'error')).toBe(true)
  })
})
