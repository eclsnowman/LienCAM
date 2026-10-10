import { describe, it, expect } from 'vitest'
import { FeatureDag } from '../../../doc/dag'
import { ElementMap } from '../../../doc/element-map'
import { RegenScheduler } from '../../../doc/regen'
import { genDelta, makeExecutor } from './_helpers'

// WO UI-6 (BK-39) acceptance criteria, at the scheduler layer:
//
// AC #1 -- Suppress skips execution: a spy/fake proves a suppressed feature
// AND its cascade run ZERO engine calls on regen; unsuppress replays them.
// AC #2 -- Cascade correctness at the execution layer (dag.test.ts/
// suppress.test.ts already cover the pure structural cascade).
//
// Mission #2 (absent-not-error): a suppressed node's scheduler status is
// 'suppressed', NEVER 'degraded'/'failed', even when it sits downstream of a
// genuinely failed feature -- suppression is checked FIRST in the pass loop.

function chain(): { dag: FeatureDag; map: ElementMap } {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
  dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
  dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F2'] })
  return { dag, map: new ElementMap() }
}

const ops = Object.fromEntries(['F1', 'F2', 'F3'].map((id) => [id, { delta: genDelta(id, [`${id}:F`]) }]))

describe('AC #1: RegenScheduler skips a suppressed feature and its cascade -- zero engine calls', () => {
  it('an initial build runs all three; suppressing F2 then re-marking dirty runs NONE of {F2, F3}; F1 is never even re-marked', async () => {
    const { dag, map } = chain()
    const scheduler = new RegenScheduler(dag, map)

    scheduler.markDirty('F1')
    const first = await scheduler.run(makeExecutor(ops).executor)
    expect(first.executed).toEqual(['F1', 'F2', 'F3'])
    for (const id of ['F1', 'F2', 'F3']) expect(scheduler.statusOf(id)).toBe('ok')

    dag.setSuppressed('F2', true)
    const spy = makeExecutor(ops)
    scheduler.markDirty('F2') // downstream closure = {F2, F3}
    expect(scheduler.dirtyIds()).toEqual(['F2', 'F3'])

    const pass = await scheduler.run(spy.executor)

    // The whole point of AC #1: the executor (the "kernel call") was NEVER
    // invoked for F2 or F3.
    expect(spy.recorder).toEqual([])
    expect(pass.executed).toEqual([])
    expect(scheduler.statusOf('F2')).toBe('suppressed')
    expect(scheduler.statusOf('F3')).toBe('suppressed')
    expect(scheduler.statusOf('F1')).toBe('ok') // upstream, untouched
    expect(scheduler.dirtyIds()).toEqual([])
    expect(scheduler.diagnosticsOf('F2')).toEqual([])
    expect(scheduler.diagnosticsOf('F3')).toEqual([])
  })

  it('unsuppressing F2 and re-marking dirty REPLAYS the kernel op for both F2 and F3', async () => {
    const { dag, map } = chain()
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty('F1')
    await scheduler.run(makeExecutor(ops).executor)

    dag.setSuppressed('F2', true)
    scheduler.markDirty('F2')
    await scheduler.run(makeExecutor(ops).executor)
    expect(scheduler.statusOf('F2')).toBe('suppressed')

    dag.setSuppressed('F2', false)
    const replay = makeExecutor(ops)
    scheduler.markDirty('F2')
    const pass = await scheduler.run(replay.executor)

    expect(replay.recorder).toEqual(['F2', 'F3'])
    expect(pass.executed).toEqual(['F2', 'F3'])
    expect(scheduler.statusOf('F2')).toBe('ok')
    expect(scheduler.statusOf('F3')).toBe('ok')
  })

  it('a diamond: suppressing one branch runs zero calls for it while the sibling branch executes normally', async () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({ id: 'F4', kind: 'feature', consumes: ['F2', 'F3'] })
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    const diamondOps = Object.fromEntries(['F1', 'F2', 'F3', 'F4'].map((id) => [id, { delta: genDelta(id, [`${id}:F`]) }]))

    dag.setSuppressed('F2', true)
    scheduler.markDirty('F1')
    const spy = makeExecutor(diamondOps)
    const pass = await scheduler.run(spy.executor)

    // F1 (untouched upstream) and F3 (healthy sibling branch) DO run; F2
    // (suppressed) and F4 (cascade -- consumes F2) do NOT.
    expect(spy.recorder).toEqual(['F1', 'F3'])
    expect(pass.executed).toEqual(['F1', 'F3'])
    expect(scheduler.statusOf('F1')).toBe('ok')
    expect(scheduler.statusOf('F3')).toBe('ok')
    expect(scheduler.statusOf('F2')).toBe('suppressed')
    expect(scheduler.statusOf('F4')).toBe('suppressed')
  })
})

describe('Mission #2 (absent-not-error): suppression is checked BEFORE failure isolation', () => {
  it('a suppressed node downstream of a genuinely FAILED upstream reports "suppressed", never "degraded"', async () => {
    const { dag, map } = chain()
    const scheduler = new RegenScheduler(dag, map)

    dag.setSuppressed('F2', true)
    scheduler.markDirty('F1')
    const failThenSkip = makeExecutor({ F1: { ok: false } }) // F2/F3 never reached anyway
    await scheduler.run(failThenSkip.executor)

    expect(scheduler.statusOf('F1')).toBe('failed')
    // F2 is suppressed -- even though its upstream F1 failed, it must NOT
    // report 'degraded' (mission #2's absent-not-error rule): suppression
    // wins, and its own kernel op was never called.
    expect(scheduler.statusOf('F2')).toBe('suppressed')
    expect(scheduler.statusOf('F3')).toBe('suppressed')
    expect(failThenSkip.recorder).toEqual(['F1'])
  })
})
