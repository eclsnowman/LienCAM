import { describe, it, expect } from 'vitest'
import { parseExpression, serializeAst } from '../../../doc/params/parser'
import { evaluate, type ParamLookup } from '../../../doc/params/evaluator'
import { GOLDEN_CASES } from './golden-cases'

// WO DOC-4 acceptance criterion #1: golden table of expressions -> values
// covering precedence, parentheses, unary minus, both unit suffixes,
// mixed-unit arithmetic, and float edge cases; parse is deterministic (same
// input -> identical AST serialization twice).

const NO_REFS: ParamLookup = () => ({ ok: false })

function evalSource(source: string, lookup: ParamLookup = NO_REFS): number {
  const { ast } = parseExpression(source)
  const result = evaluate(ast, lookup)
  if (!result.ok) throw new Error(`expected ok, got diag ${JSON.stringify(result.diag)}`)
  return result.value
}

describe('AC #1: parser + evaluator golden table', () => {
  const cases = GOLDEN_CASES

  it.each(cases)('%s -> %p', (source, expected) => {
    expect(evalSource(source)).toBe(expected)
  })

  it('parameter references resolve through the supplied lookup', () => {
    const lookup: ParamLookup = (name) => (name === 'base' ? { ok: true, value: 10 } : { ok: false })
    expect(evalSource('2*base+3', lookup)).toBe(23)
    expect(evalSource('base/2 - 1in', lookup)).toBe(10 / 2 - 25.4)
  })

  it('determinism: parsing the same source twice yields byte-identical AST serialization', () => {
    for (const [source] of cases) {
      const a = parseExpression(source)
      const b = parseExpression(source)
      expect(serializeAst(b.ast)).toBe(serializeAst(a.ast))
      expect(b.refs).toEqual(a.refs)
    }
    const nested = '2*base+3 - (width/2) + -1in'
    expect(serializeAst(parseExpression(nested).ast)).toBe(serializeAst(parseExpression(nested).ast))
  })

  it('collects sorted, de-duplicated parameter references', () => {
    const { refs } = parseExpression('base + width*base - height/base')
    expect(refs).toEqual(['base', 'height', 'width'])
  })
})
