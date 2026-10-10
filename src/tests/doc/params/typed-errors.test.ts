import { describe, it, expect } from 'vitest'
import { DagCycleError, ElementMap, FeatureDag, ParameterTable, RegenScheduler, paramNodeId } from '../../../doc'

// WO DOC-4 acceptance criterion #2: typed errors, never throws-through --
// unknown reference, division by zero, syntax error, self-reference, and
// reference CYCLE (A->B->A) each produce a typed diagnostic; the table stays
// usable; dependents get status 'degraded' via the status store -- never
// deleted, never silently stale-valued.

function build() {
  const dag = new FeatureDag()
  const map = new ElementMap()
  const scheduler = new RegenScheduler(dag, map)
  const table = new ParameterTable(dag, scheduler)
  return { dag, map, scheduler, table }
}

describe('AC #2: typed parameter errors', () => {
  it('syntax error is rejected before touching the dag; table stays usable', async () => {
    const { table } = build()
    await table.setExpression('base', '10')

    const outcome = await table.setExpression('bad', '2 + * 3')
    expect(outcome.ok).toBe(false)
    expect(outcome.diag?.code).toBe('PARAM_SYNTAX_ERROR')
    expect(table.has('bad')).toBe(false)
    // Unrelated parameter is completely unaffected.
    expect(table.valueOf('base')).toBe(10)
    expect(table.statusOf('base')).toBe('ok')
  })

  it('self-reference is rejected with a distinct code, never as a generic cycle', async () => {
    const { table } = build()
    const outcome = await table.setExpression('a', 'a + 1')
    expect(outcome.ok).toBe(false)
    expect(outcome.diag?.code).toBe('PARAM_SELF_REFERENCE')
    expect(table.has('a')).toBe(false)
  })

  it('unknown reference produces a typed diagnostic via the status store; table stays usable', async () => {
    const { table } = build()
    await table.setExpression('base', '10')

    const outcome = await table.setExpression('c', 'doesNotExist + 1')
    // The edit itself commits (a forward/dangling reference is allowed --
    // it may be defined later); the FAILURE surfaces through the status
    // store once the scheduler actually tries to evaluate it.
    expect(outcome.ok).toBe(true)
    expect(table.statusOf('c')).toBe('failed')
    const diags = table.diagnosticsOf('c')
    expect(diags.some((d) => 'code' in d && d.code === 'PARAM_UNKNOWN_REFERENCE')).toBe(true)
    // Never deleted, never silently stale-valued: 'c' still exists with its
    // last-good (never-yet-successful) value, not garbage.
    expect(table.has('c')).toBe(true)
    expect(table.valueOf('c')).toBe(0)
    // Unrelated parameter is completely unaffected.
    expect(table.statusOf('base')).toBe('ok')
  })

  it('division by zero produces a typed diagnostic and RETAINS the last-good value (never silently stale)', async () => {
    const { table } = build()
    await table.setExpression('base', '10')
    await table.setExpression('width', '100/base')
    expect(table.statusOf('width')).toBe('ok')
    expect(table.valueOf('width')).toBe(10)

    // Now break it: base becomes 0, so width's own recompute divides by zero.
    await table.setExpression('base', '0')
    expect(table.statusOf('width')).toBe('failed')
    expect(table.diagnosticsOf('width').some((d) => 'code' in d && d.code === 'PARAM_DIVISION_BY_ZERO')).toBe(true)
    // Last-good value from BEFORE the failure survives -- never NaN/Infinity/reset.
    expect(table.valueOf('width')).toBe(10)
  })

  it('a failed parameter degrades its dependents via the SAME status store used for features (never deleted)', async () => {
    const { table } = build()
    await table.setExpression('p', '0')
    await table.setExpression('q', '5/p')
    expect(table.statusOf('q')).toBe('failed')

    await table.setExpression('r', 'q + 1')
    expect(table.statusOf('r')).toBe('degraded')
    expect(table.diagnosticsOf('r').some((d) => 'code' in d && d.code === 'UPSTREAM_FAILED')).toBe(true)
    // Never deleted, never silently stale-valued.
    expect(table.has('r')).toBe(true)
    expect(table.valueOf('r')).toBe(0)
  })

  it('CYCLE (A->B->A) is rejected with a typed diagnostic; the table stays usable', async () => {
    const { table } = build()
    await table.setExpression('a', '1')
    await table.setExpression('b', 'a + 1')
    expect(table.valueOf('a')).toBe(1)
    expect(table.valueOf('b')).toBe(2)

    const outcome = await table.setExpression('a', 'b + 1')
    expect(outcome.ok).toBe(false)
    expect(outcome.diag?.code).toBe('PARAM_CYCLE')

    // Rejected atomically: 'a' keeps its ORIGINAL expression/value, 'b' is untouched.
    expect(table.expressionOf('a')).toBe('1')
    expect(table.valueOf('a')).toBe(1)
    expect(table.statusOf('a')).toBe('ok')
    expect(table.valueOf('b')).toBe(2)
    expect(table.statusOf('b')).toBe('ok')
  })

  it('FAILS-IF: a cyclic parameter reference can never reach the evaluator (guard by construction)', async () => {
    // This is the AC #2 FAILS-IF: if the cycle guard were ever bypassed (a
    // bug reintroducing an input-order/no-check edge write), evaluating a
    // cyclic parameter graph would recurse across nodes unboundedly. Proven
    // here two ways: (1) the DAG itself refuses the edge SYNCHRONOUSLY (not
    // even a rejected Promise -- there is no async window in which a partially
    // -wired cyclic graph could be handed to the scheduler), and (2) the
    // table-level edit rejects it before any scheduler pass ever runs.
    const { dag, table } = build()
    await table.setExpression('a', '1')
    await table.setExpression('b', 'a + 1')

    expect(() => dag.setConsumes(paramNodeId('a'), [paramNodeId('b')])).toThrow(DagCycleError)

    const outcome = await table.setExpression('a', 'b + 1')
    expect(outcome.ok).toBe(false)
    expect(outcome.diag?.code).toBe('PARAM_CYCLE')
    // The dag's actual consumes for 'a' never changed to include 'b'.
    expect(dag.getNode(paramNodeId('a'))?.consumes).toEqual([])
  })
})
