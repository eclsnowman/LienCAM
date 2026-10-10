import { describe, it, expect } from 'vitest'
import { ElementMap, FeatureDag, ParameterTable, RegenScheduler } from '../../../doc'
import { parseExpression } from '../../../doc/params/parser'
import { ParamParseError } from '../../../doc/params/types'

// WO DOC-4-R1.4.A: function library + exponent operator acceptance criteria
// not already covered by parser.test.ts's golden table -- unknown function
// name and wrong-arity rejection, both edit-time and never mutating the table.

function build() {
  const dag = new FeatureDag()
  const map = new ElementMap()
  const scheduler = new RegenScheduler(dag, map)
  const table = new ParameterTable(dag, scheduler)
  return { table }
}

describe('R1.4.A: unknown function name', () => {
  it('an identifier called like a function that is not a built-in is PARAM_UNKNOWN_FUNCTION, not PARAM_SYNTAX_ERROR', () => {
    expect(() => parseExpression('foo(1)')).toThrow(ParamParseError)
    try {
      parseExpression('foo(1)')
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ParamParseError)
      const err = e as ParamParseError
      expect(err.diagnostic.code).toBe('PARAM_UNKNOWN_FUNCTION')
      expect(err.diagnostic.params.name).toBe('foo')
    }
  })

  it('setExpression rejects an unknown function at edit time; nothing is mutated', async () => {
    const { table } = build()
    await table.setExpression('base', '10')

    const outcome = await table.setExpression('bad', 'foo(base)')
    expect(outcome.ok).toBe(false)
    expect(outcome.diag?.code).toBe('PARAM_UNKNOWN_FUNCTION')
    expect(table.has('bad')).toBe(false)
    expect(table.valueOf('base')).toBe(10)
    expect(table.statusOf('base')).toBe('ok')
  })
})

describe('R1.4.A: function arity', () => {
  const arityCases: Array<[string, string, number]> = [
    ['sin', 'sin(1, 2)', 1],
    ['sin', 'sin()', 1],
    ['sqrt', 'sqrt(1, 2, 3)', 1],
    ['atan2', 'atan2(1)', 2],
    ['atan2', 'atan2(1, 2, 3)', 2],
    ['min', 'min(1)', 2],
    ['max', 'max(1, 2, 3)', 2],
  ]

  it.each(arityCases)('%s: %s is rejected with PARAM_SYNTAX_ERROR naming the function + expected arity %i', (name, source, expected) => {
    try {
      parseExpression(source)
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(ParamParseError)
      const err = e as ParamParseError
      expect(err.diagnostic.code).toBe('PARAM_SYNTAX_ERROR')
      expect(err.diagnostic.params.detail).toContain(name)
      expect(err.diagnostic.params.detail).toContain(String(expected))
    }
  })

  it('setExpression rejects a wrong-arity call at edit time; nothing is mutated', async () => {
    const { table } = build()
    await table.setExpression('base', '10')

    const outcome = await table.setExpression('bad', 'min(base)')
    expect(outcome.ok).toBe(false)
    expect(outcome.diag?.code).toBe('PARAM_SYNTAX_ERROR')
    expect(outcome.diag?.params.detail).toContain('min')
    expect(table.has('bad')).toBe(false)
  })
})

describe("R1.4.A: 'pi' is a reserved constant, like mm/in", () => {
  it('a parameter cannot be named pi', async () => {
    const { table } = build()
    const outcome = await table.setExpression('pi', '3')
    expect(outcome.ok).toBe(false)
    expect(outcome.diag?.code).toBe('PARAM_SYNTAX_ERROR')
    expect(table.has('pi')).toBe(false)
  })

  it('pi resolves to Math.PI and is usable in arithmetic', async () => {
    const { table } = build()
    const outcome = await table.setExpression('circumference', '2*pi*10')
    expect(outcome.ok).toBe(true)
    expect(table.valueOf('circumference')).toBe(2 * Math.PI * 10)
  })
})
