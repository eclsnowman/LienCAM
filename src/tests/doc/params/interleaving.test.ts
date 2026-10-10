import { describe, it, expect } from 'vitest'
import { ElementMap, FeatureDag, ParameterTable, RegenScheduler, paramNodeId } from '../../../doc'
import type { FeatureOp } from '../../../doc'
import { makeGate } from '../regen/_helpers'

// WO DOC-4 ruling 3 (interleaving invariants, DECISIONS 2026-07-08), one test
// per invariant, driven through table.setExpression (never raw
// scheduler.markDirty/run), using the scheduler's deterministic slow-op mock
// seam -- no wall-clock sleep anywhere.

function build() {
  const dag = new FeatureDag()
  const map = new ElementMap()
  const scheduler = new RegenScheduler(dag, map)
  return { dag, map, scheduler }
}

describe('ruling 3(a): a parameter edit committed while a regen pass has already used its value cancels that pass', () => {
  it('the feature never finishes "ok" against the stale (in-flight) value; the final pass uses the latest', async () => {
    const { dag, scheduler } = build()
    const seenWidths: number[] = []
    const g = makeGate()
    let armed = false
    const kernelOp: FeatureOp = async (node) => {
      if (node.id === 'F1') {
        if (armed) {
          g.signalReached()
          await g.gate
        }
        seenWidths.push(dag.getNode(paramNodeId('width'))?.payload.value as number)
      }
      return { ok: true, diagnostics: [] }
    }
    const table = new ParameterTable(dag, scheduler, kernelOp)

    await table.setExpression('base', '10')
    await table.setExpression('width', '2*base+3')
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [paramNodeId('width')] })
    scheduler.markDirty('F1')
    await scheduler.run(table.executor)
    expect(seenWidths).toEqual([23])
    expect(scheduler.statusOf('F1')).toBe('ok')

    // Arm the gate, then commit an edit whose pass will get F1 in flight.
    armed = true
    const p1 = table.setExpression('base', '11')
    await g.reached // F1's op for pass1 is now parked, having not yet read width
    expect(scheduler.statusOf('F1')).toBe('running')

    // A SECOND edit commits while pass1's F1 op is still in flight.
    const p2 = table.setExpression('base', '12')

    g.release() // let pass1's parked F1 op resume; it reads whatever width IS right now
    const [r1, r2] = await Promise.all([p1, p2])

    expect(r1.pass?.cancelled).toBe(true)
    expect(r2.pass?.cancelled).toBe(false)

    // Final, committed state reflects ONLY the latest edit.
    expect(dag.getNode(paramNodeId('base'))?.payload.value).toBe(12)
    expect(dag.getNode(paramNodeId('width'))?.payload.value).toBe(27)
    expect(scheduler.statusOf('F1')).toBe('ok')
    expect(scheduler.hasRunning()).toBe(false)
    expect(scheduler.dirtyIds()).toEqual([])

    // F1's kernel op was invoked for the cancelled pass too (it had already
    // been called before cancellation was detected) -- but the scheduler
    // NEVER lets that invocation's result commit as 'ok'. Exactly two 'ok'
    // transitions exist for F1 in the whole test: the initial build (23) and
    // the final committed pass (27). The discarded in-flight attempt (25,
    // read while base=11 was current but before pass1 was cancelled) is
    // reflected in seenWidths (proving it really ran) but never in a
    // completed 'ok' transition.
    expect(seenWidths).toEqual([23, 25, 27])
    const f1OkTransitions = scheduler.transitions().filter((t) => t.id === 'F1' && t.to === 'ok')
    expect(f1OkTransitions.length).toBe(2)
  })
})

describe('ruling 3(b): rapid successive edits coalesce through the scheduler cancel/reschedule path', () => {
  it('three edits fired without awaiting between them collapse to exactly one real regeneration, using only the final value', async () => {
    const { dag, scheduler } = build()
    const seenWidths: number[] = []
    const kernelOp: FeatureOp = async (node) => {
      if (node.id === 'F1') seenWidths.push(dag.getNode(paramNodeId('width'))?.payload.value as number)
      return { ok: true, diagnostics: [] }
    }
    const table = new ParameterTable(dag, scheduler, kernelOp)

    await table.setExpression('base', '10')
    await table.setExpression('width', '2*base+3')
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [paramNodeId('width')] })
    scheduler.markDirty('F1')
    await scheduler.run(table.executor)
    expect(seenWidths).toEqual([23])

    // Fire three edits back-to-back with NO await between them.
    const p1 = table.setExpression('base', '11')
    const p2 = table.setExpression('base', '12')
    const p3 = table.setExpression('base', '13')
    const [r1, r2, r3] = await Promise.all([p1, p2, p3])

    // Final committed state reflects ONLY the last edit (base=13 -> width=29).
    expect(dag.getNode(paramNodeId('base'))?.payload.value).toBe(13)
    expect(dag.getNode(paramNodeId('width'))?.payload.value).toBe(29)
    expect(scheduler.statusOf('F1')).toBe('ok')
    expect(scheduler.hasRunning()).toBe(false)
    expect(scheduler.dirtyIds()).toEqual([])

    // F1's kernel op ran exactly once more (beyond the initial build) -- for
    // the FINAL value only. No pass ever ran the kernel op against an
    // intermediate value (11 -> width 25, or 12 -> width 27): coalescing
    // discarded them before a kernel call was ever made for them.
    expect(seenWidths).toEqual([23, 29])

    // Exactly one of the three passes did the real work; the others found
    // nothing left dirty (the prior pass already drained the combined edit).
    const executedCounts = [r1, r2, r3].map((r) => r.pass?.executed.length ?? -1)
    expect(executedCounts.filter((n) => n > 0)).toEqual([3])
    expect(executedCounts.filter((n) => n === 0).length).toBe(2)
  })
})
