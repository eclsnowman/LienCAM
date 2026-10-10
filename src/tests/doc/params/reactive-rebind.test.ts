import { describe, it, expect } from 'vitest'
import { ElementMap, FeatureDag, ParameterTable, RegenScheduler, paramNodeId } from '../../../doc'
import type { FeatureOp } from '../../../doc'

// WO DOC-4 acceptance criterion #3: reactive rebind end-to-end. Table
// {base=10, width=2*base+3} with a feature consuming 'width' (mocked kernel
// seam) -> edit base=12 -> exactly the dependent subgraph regenerates
// (scheduler order log proves no over-regen) and the feature sees 27.

describe('AC #3: reactive rebind end-to-end', () => {
  it('editing base regenerates exactly {base, width, F1}; an untouched sibling parameter never re-runs; F1 sees 27', async () => {
    const dag = new FeatureDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)

    const seenWidths: number[] = []
    const kernelOp: FeatureOp = async (node) => {
      if (node.id === 'F1') {
        const width = dag.getNode(paramNodeId('width'))?.payload.value as number
        seenWidths.push(width)
      }
      return { ok: true, diagnostics: [] }
    }
    const table = new ParameterTable(dag, scheduler, kernelOp)

    // An unrelated parameter that must NEVER be touched by editing 'base'.
    await table.setExpression('other', '5')
    await table.setExpression('base', '10')
    const initialWidth = await table.setExpression('width', '2*base+3')
    expect(initialWidth.ok).toBe(true)
    expect(table.valueOf('width')).toBe(23)

    // F1 is a feature node (owned by a future WO in real life; simulated
    // here directly on the shared dag) consuming 'width' by ordinary DAG edge.
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [paramNodeId('width')] })
    scheduler.markDirty('F1')
    await scheduler.run(table.executor)
    expect(seenWidths).toEqual([23])
    expect(scheduler.statusOf('F1')).toBe('ok')

    // The edit: base=12 -> width should become 27, F1 should see 27.
    const outcome = await table.setExpression('base', '12')
    expect(outcome.ok).toBe(true)
    expect(table.valueOf('base')).toBe(12)
    expect(table.valueOf('width')).toBe(27)
    expect(seenWidths).toEqual([23, 27])

    // Over-regeneration guard: exactly the downstream closure of 'base' ran,
    // in topological order -- 'other' (untouched sibling) never appears.
    expect(outcome.pass?.executed).toEqual([paramNodeId('base'), paramNodeId('width'), 'F1'])
    expect(outcome.pass?.executed).not.toContain(paramNodeId('other'))
    expect(outcome.pass?.cancelled).toBe(false)

    // Everything ends 'ok'; nothing degraded, nothing stuck dirty/running.
    for (const name of ['other', 'base', 'width']) expect(table.statusOf(name)).toBe('ok')
    expect(scheduler.statusOf('F1')).toBe('ok')
    expect(scheduler.hasRunning()).toBe(false)
    expect(table.valueOf('other')).toBe(5)
  })
})
