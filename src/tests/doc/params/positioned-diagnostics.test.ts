import { describe, it, expect } from 'vitest'
import { parseExpression } from '../../../doc/params/parser'
import { ParamParseError } from '../../../doc/params/types'

// WO DOC-4-R1.4.B: PARAM_SYNTAX_ERROR (and PARAM_UNKNOWN_FUNCTION) carry the
// character offset and a human-readable snippet of the offending token --
// enough for a future UI to render an inline caret. Three malformed inputs
// (error at start, middle, end of source) with the EXACT offset asserted;
// message quality (plain language, no parser-internal jargon like "unexpected
// EOF in <expr>") is checked directly on all three.

function parseErrorOf(source: string): ParamParseError {
  try {
    parseExpression(source)
  } catch (e) {
    if (e instanceof ParamParseError) return e
    throw e
  }
  throw new Error(`expected ${JSON.stringify(source)} to fail to parse`)
}

describe('R1.4.B: positioned syntax diagnostics', () => {
  it('error at the START of the source: exact offset + snippet', () => {
    const err = parseErrorOf('* 2')
    expect(err.diagnostic.code).toBe('PARAM_SYNTAX_ERROR')
    expect(err.diagnostic.params.pos).toBe('0')
    expect(err.diagnostic.params.snippet).toBe('*')
    expect(err.message).not.toMatch(/EOF|<expr>/i)
    expect(err.message).toContain('position 0')
  })

  it('error in the MIDDLE of the source: exact offset + snippet', () => {
    const err = parseErrorOf('2 + * 3')
    expect(err.diagnostic.code).toBe('PARAM_SYNTAX_ERROR')
    expect(err.diagnostic.params.pos).toBe('4')
    expect(err.diagnostic.params.snippet).toBe('*')
    expect(err.message).not.toMatch(/EOF|<expr>/i)
    expect(err.message).toContain('position 4')
  })

  it('error at the END of the source: exact offset + a plain-language "end of expression" snippet, never raw EOF jargon', () => {
    const err = parseErrorOf('2 +')
    expect(err.diagnostic.code).toBe('PARAM_SYNTAX_ERROR')
    expect(err.diagnostic.params.pos).toBe('3')
    expect(err.diagnostic.params.snippet).toBe('end of expression')
    expect(err.message).not.toMatch(/EOF|<expr>/i)
    expect(err.message).toContain('position 3')
  })

  it('an unclosed paren reports the position of the missing close, not the open', () => {
    const err = parseErrorOf('(1 + 2')
    expect(err.diagnostic.code).toBe('PARAM_SYNTAX_ERROR')
    expect(err.diagnostic.params.pos).toBe('6')
    expect(err.diagnostic.params.snippet).toBe('end of expression')
  })

  it('trailing tokens after a complete expression are positioned at the trailing token', () => {
    const err = parseErrorOf('1 2')
    expect(err.diagnostic.code).toBe('PARAM_SYNTAX_ERROR')
    expect(err.diagnostic.params.pos).toBe('2')
    expect(err.diagnostic.params.snippet).toBe('2')
  })

  it('PARAM_UNKNOWN_FUNCTION also carries a positioned offset + snippet (the function name)', () => {
    const err = parseErrorOf('2 + foo(1)')
    expect(err.diagnostic.code).toBe('PARAM_UNKNOWN_FUNCTION')
    expect(err.diagnostic.params.pos).toBe('4')
    expect(err.diagnostic.params.snippet).toBe('foo')
    expect(err.message).not.toMatch(/EOF|<expr>/i)
  })

  it('an illegal character is positioned exactly at that character', () => {
    const err = parseErrorOf('1 @ 2')
    expect(err.diagnostic.code).toBe('PARAM_SYNTAX_ERROR')
    expect(err.diagnostic.params.pos).toBe('2')
    expect(err.diagnostic.params.snippet).toBe('@')
  })
})
