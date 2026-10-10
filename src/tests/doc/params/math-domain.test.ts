import { describe, it, expect } from 'vitest'
import { ElementMap, FeatureDag, ParameterTable, RegenScheduler } from '../../../doc'
import { GOLDEN_CASES } from './golden-cases'

// WO DOC-4-R1.4.C: no evaluation path may ever store NaN or Infinity as a
// parameter value. Function domain errors (sqrt of negative, asin/acos
// outside [-1, 1], atan2(0, 0)) and any overflow produce typed
// PARAM_MATH_DOMAIN, with the SAME last-good-value-retained semantics as
// division-by-zero.

function build() {
  const dag = new FeatureDag()
  const map = new ElementMap()
  const scheduler = new RegenScheduler(dag, map)
  const table = new ParameterTable(dag, scheduler)
  return { table }
}

function hasMathDomainDiag(diags: ReturnType<ParameterTable['diagnosticsOf']>): boolean {
  return diags.some((d) => 'code' in d && d.code === 'PARAM_MATH_DOMAIN')
}

describe('R1.4.C: NaN/Infinity backstop -- one test per domain-error class', () => {
  it('sqrt of a negative number', async () => {
    const { table } = build()
    await table.setExpression('x', 'sqrt(4)')
    expect(table.valueOf('x')).toBe(2)

    const outcome = await table.setExpression('x', 'sqrt(-1)')
    expect(outcome.ok).toBe(true) // eval-time, commits
    expect(table.statusOf('x')).toBe('failed')
    expect(hasMathDomainDiag(table.diagnosticsOf('x'))).toBe(true)
    expect(table.valueOf('x')).toBe(2) // last-good value retained
  })

  it('asin outside [-1, 1]', async () => {
    const { table } = build()
    await table.setExpression('x', 'asin(0.5)')
    const good = table.valueOf('x')

    await table.setExpression('x', 'asin(2)')
    expect(table.statusOf('x')).toBe('failed')
    expect(hasMathDomainDiag(table.diagnosticsOf('x'))).toBe(true)
    expect(table.valueOf('x')).toBe(good)
  })

  it('acos outside [-1, 1]', async () => {
    const { table } = build()
    await table.setExpression('x', 'acos(0)')
    const good = table.valueOf('x')

    await table.setExpression('x', 'acos(-2)')
    expect(table.statusOf('x')).toBe('failed')
    expect(hasMathDomainDiag(table.diagnosticsOf('x'))).toBe(true)
    expect(table.valueOf('x')).toBe(good)
  })

  it('atan2(0, 0) is undefined', async () => {
    const { table } = build()
    await table.setExpression('x', 'atan2(1, 1)')
    const good = table.valueOf('x')

    await table.setExpression('x', 'atan2(0, 0)')
    expect(table.statusOf('x')).toBe('failed')
    expect(hasMathDomainDiag(table.diagnosticsOf('x'))).toBe(true)
    expect(table.valueOf('x')).toBe(good)
  })

  it('exponent overflow (2^2000, past double range) is caught, never committed', async () => {
    const { table } = build()
    await table.setExpression('x', '10')

    const outcome = await table.setExpression('x', '2^2000')
    expect(outcome.ok).toBe(true)
    expect(table.statusOf('x')).toBe('failed')
    expect(hasMathDomainDiag(table.diagnosticsOf('x'))).toBe(true)
    expect(table.valueOf('x')).toBe(10)
    expect(Number.isFinite(table.valueOf('x'))).toBe(true)
  })

  it('multiplication overflow to Infinity is caught, never committed', async () => {
    const { table } = build()
    await table.setExpression('x', '10')

    const big = '1' + '0'.repeat(200) // 10^200 -- finite on its own
    const outcome = await table.setExpression('x', `${big} * ${big}`) // 10^400 -- overflows
    expect(outcome.ok).toBe(true)
    expect(table.statusOf('x')).toBe('failed')
    expect(hasMathDomainDiag(table.diagnosticsOf('x'))).toBe(true)
    expect(table.valueOf('x')).toBe(10)
  })
})

describe('R1.4.C: evaluator-level sweep -- every golden-table row + every failure fixture', () => {
  it('Number.isFinite holds for EVERY committed value in the table after the whole sweep', async () => {
    const { table } = build()

    // Every golden-table row (parser.test.ts's own AC #1 golden, R1.4.A's
    // functions/exponent rows included) committed as its own parameter.
    for (let i = 0; i < GOLDEN_CASES.length; i++) {
      const [source, expected] = GOLDEN_CASES[i]
      const name = `golden${i}`
      const outcome = await table.setExpression(name, source)
      expect(outcome.ok).toBe(true)
      expect(table.valueOf(name)).toBe(expected)
    }

    // Every failure fixture: seed a known-good value, then break it -- the
    // edit still commits (ok:true, eval-time diagnostic), and the table must
    // retain the last-good (finite) value, never NaN/Infinity.
    const failureFixtures = [
      '1/0', // PARAM_DIVISION_BY_ZERO
      'sqrt(-1)',
      'asin(2)',
      'acos(-2)',
      'atan2(0, 0)',
      '2^2000',
      `${'1' + '0'.repeat(200)} * ${'1' + '0'.repeat(200)}`,
    ]
    for (let i = 0; i < failureFixtures.length; i++) {
      const name = `failure${i}`
      await table.setExpression(name, '1')
      const outcome = await table.setExpression(name, failureFixtures[i])
      expect(outcome.ok).toBe(true)
      expect(table.statusOf(name)).toBe('failed')
    }

    expect(table.names().length).toBe(GOLDEN_CASES.length + failureFixtures.length)
    for (const name of table.names()) {
      const value = table.valueOf(name)
      expect(value).not.toBeUndefined()
      expect(Number.isFinite(value)).toBe(true)
    }
  })
})
