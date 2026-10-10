import { describe, expect, it } from 'vitest'
import { isSendableGcodeLine, prepareProgram, stripGcodeComments } from '../../lib/gcode/text'

describe('stripGcodeComments', () => {
  it('strips parenthesis comments', () => {
    expect(stripGcodeComments('G1 X10 (rapid to start) Y20')).toBe('G1 X10  Y20')
  })

  it('strips semicolon comments to end of line', () => {
    expect(stripGcodeComments('G1 X10 ; feed to depth')).toBe('G1 X10')
  })

  it('strips a comment-only line to empty', () => {
    expect(stripGcodeComments('(just a comment)')).toBe('')
    expect(stripGcodeComments('; just a comment')).toBe('')
  })

  it('trims surrounding whitespace after stripping', () => {
    expect(stripGcodeComments('   G0 X0   ')).toBe('G0 X0')
  })

  it('handles multiple parenthesis comments on one line', () => {
    expect(stripGcodeComments('G1 (a) X10 (b) Y20')).toBe('G1  X10  Y20')
  })
})

describe('isSendableGcodeLine', () => {
  it('accepts an ordinary motion line', () => {
    expect(isSendableGcodeLine('G1 X10 Y20')).toBe(true)
  })

  it('rejects a blank line', () => {
    expect(isSendableGcodeLine('')).toBe(false)
  })

  it('rejects a whitespace-only line', () => {
    expect(isSendableGcodeLine('   \t  ')).toBe(false)
  })

  it('rejects a comment-only line (parenthesis or semicolon)', () => {
    expect(isSendableGcodeLine('(setup comment)')).toBe(false)
    expect(isSendableGcodeLine('; setup comment')).toBe(false)
  })

  it('rejects a bare % program marker', () => {
    expect(isSendableGcodeLine('%')).toBe(false)
  })

  it('accepts a line that has a trailing comment but real code', () => {
    expect(isSendableGcodeLine('G1 X10 (rapid) ')).toBe(true)
  })
})

describe('prepareProgram', () => {
  it('drops blank, comment-only, and % marker lines, counting them as skipped', () => {
    const text = ['%', 'G21', '', '(comment only)', 'G1 X10 ; go', '   ', 'M30'].join('\n')
    const result = prepareProgram(text)
    expect(result.lines.map((l) => l.text)).toEqual(['G21', 'G1 X10', 'M30'])
    expect(result.skipped).toBe(4)
  })

  it('preserves original 1-based source line numbers across dropped lines', () => {
    const text = ['G21', '', 'G90', '(skip me)', 'M30'].join('\n')
    const result = prepareProgram(text)
    expect(result.lines.map((l) => l.sourceLine)).toEqual([1, 3, 5])
  })

  it('flags lines over GRBL_MAX_LINE_CHARS as overlong without dropping them', () => {
    const longLine = 'G1 ' + 'X1'.repeat(60) // well over 80 chars after stripping
    const text = ['G21', longLine, 'M30'].join('\n')
    const result = prepareProgram(text)
    expect(result.overlongLines).toEqual([2])
    expect(result.lines.map((l) => l.text)).toContain(longLine)
  })

  it('handles CRLF line endings the same as LF', () => {
    const text = 'G21\r\nG90\r\nM30'
    const result = prepareProgram(text)
    expect(result.lines.map((l) => l.text)).toEqual(['G21', 'G90', 'M30'])
  })
})
