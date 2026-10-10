// WO INT-4A-R1 (R1.1): unit-level proof that resolveDrivenField makes a
// feature's driving value REPLAY through regen -- re-evaluated fresh on
// every RegenScheduler pass against the dag's CURRENT parameter state, never
// a value captured once at Apply-time -- exactly the "editable, expression-
// capable, replayed through regen like every other driving dimension"
// contract this rework's audit finding asked for. No kernel needed: this
// drives the SAME resolveDrivenField the real SolidsWorkbenchPage executor
// calls, against a bare FeatureDag + RegenScheduler + a stub kernel op.

import { describe, it, expect } from 'vitest'
import { ElementMap, FeatureDag, RegenScheduler, type FeatureOp } from '../../doc'
import { resolveDrivenField, validateFeatureExpression, featureExpressionRefs } from '../../components/model3d/workbench/featureDimension'

describe('featureDimension (WO INT-4A-R1.1)', () => {
  it('validateFeatureExpression rejects a malformed expression before anything commits', () => {
    expect(validateFeatureExpression('base*7').ok).toBe(true)
    const bad = validateFeatureExpression('1 + ')
    expect(bad.ok).toBe(false)
    expect(bad.diag?.code).toBeDefined()
  })

  it('featureExpressionRefs extracts the referenced parameter names, sorted+deduped', () => {
    expect(featureExpressionRefs('base + base + extra')).toEqual(['base', 'extra'])
    expect(featureExpressionRefs(undefined)).toEqual([])
    expect(featureExpressionRefs('  ')).toEqual([])
  })

  it('a bound expression re-evaluates fresh on every regen pass against the CURRENT parameter value', async () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'param:base', kind: 'parameter', payload: { name: 'base', expression: '5', value: 5 } })
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      consumes: ['param:base'],
      payload: { opType: 'extrude', distance: 999, expression: 'base*7' },
    })
    const scheduler = new RegenScheduler(dag, new ElementMap())

    const kernelOp: FeatureOp = async (node) => {
      if (node.id !== 'F1') return { ok: true, diagnostics: [] }
      const driven = resolveDrivenField(dag, node, 'distance')
      expect(driven.diag).toBeUndefined()
      return { ok: true, diagnostics: [] }
    }

    scheduler.markDirty('F1')
    const pass1 = await scheduler.run(kernelOp)
    expect(pass1.executed).toEqual(['F1'])
    expect(dag.getNode('F1')?.payload.distance).toBe(35) // 5*7

    // Change the parameter's value directly (as params/table.ts's own
    // executor would after a real setExpression) and re-mark F1 dirty --
    // the SAME consumes-edge wiring ExtrudeDialog computes lets a real
    // parameter-edit's markDirty(paramId) reach F1 automatically; this test
    // exercises the read side (resolveDrivenField), so it drives markDirty
    // on F1 directly.
    dag.setPayload('param:base', { name: 'base', expression: '5', value: 10 })
    scheduler.markDirty('F1')
    const pass2 = await scheduler.run(kernelOp)
    expect(pass2.executed).toEqual(['F1'])
    expect(dag.getNode('F1')?.payload.distance).toBe(70) // 10*7 -- NOT still 35
  })

  it('an eval failure retains the last-good value and reports a warning diagnostic (never 0/dropped)', () => {
    const dag = new FeatureDag()
    dag.insertNode({
      id: 'F1',
      kind: 'feature',
      payload: { opType: 'extrude', distance: 42, expression: 'missingParam*2' },
    })
    const node = dag.getNode('F1')!
    const driven = resolveDrivenField(dag, node, 'distance')
    expect(driven.value).toBe(42)
    expect(driven.diag?.severity).toBe('warning')
  })

  it('an unbound (literal-only) feature is unaffected -- byte-identical to pre-R1.1 behavior', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', distance: 15 } })
    const node = dag.getNode('F1')!
    const driven = resolveDrivenField(dag, node, 'distance')
    expect(driven).toEqual({ value: 15 })
  })
})
