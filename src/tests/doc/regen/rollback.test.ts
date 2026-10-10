import { describe, it, expect } from 'vitest'
import { FeatureDag } from '../../../doc/dag'
import { ElementMap } from '../../../doc/element-map'
import { RegenScheduler } from '../../../doc/regen'
import { genDelta, makeExecutor } from './_helpers'

// WO UI-7 (BK-40) acceptance criterion 1, at the scheduler layer:
//
// "Marker below feature N: features >N regen-skipped (execution-spy proof);
// marker to end: all restored EXCEPT user-suppressed ones (the interaction
// test)."

function chain(): { dag: FeatureDag; map: ElementMap } {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
  dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
  dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F2'] })
  return { dag, map: new ElementMap() }
}

const ops = Object.fromEntries(['F1', 'F2', 'F3'].map((id) => [id, { delta: genDelta(id, [`${id}:F`]) }]))

describe('AC #1: RegenScheduler skips features at/after the rollback marker -- zero engine calls', () => {
  it('an initial build runs all three; marker after F1 then re-marking dirty runs NONE of {F2, F3}', async () => {
    const { dag, map } = chain()
    const scheduler = new RegenScheduler(dag, map)

    scheduler.markDirty('F1')
    const first = await scheduler.run(makeExecutor(ops).executor)
    expect(first.executed).toEqual(['F1', 'F2', 'F3'])

    dag.setRollbackMarker({ kind: 'after', nodeId: 'F1' })
    const spy = makeExecutor(ops)
    scheduler.markDirty('F2')
    expect(scheduler.dirtyIds()).toEqual(['F2', 'F3'])

    const pass = await scheduler.run(spy.executor)

    // The whole point of AC #1: the executor was NEVER invoked for F2/F3.
    expect(spy.recorder).toEqual([])
    expect(pass.executed).toEqual([])
    expect(scheduler.statusOf('F2')).toBe('rolledBack')
    expect(scheduler.statusOf('F3')).toBe('rolledBack')
    expect(scheduler.statusOf('F1')).toBe('ok') // above the marker, untouched
    expect(scheduler.dirtyIds()).toEqual([])
  })

  it('moving the marker back to "end" and re-marking dirty REPLAYS the kernel op for both F2 and F3', async () => {
    const { dag, map } = chain()
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty('F1')
    await scheduler.run(makeExecutor(ops).executor)

    dag.setRollbackMarker({ kind: 'after', nodeId: 'F1' })
    scheduler.markDirty('F2')
    await scheduler.run(makeExecutor(ops).executor)
    expect(scheduler.statusOf('F2')).toBe('rolledBack')

    dag.setRollbackMarker({ kind: 'end' })
    const replay = makeExecutor(ops)
    scheduler.markDirty('F2')
    const pass = await scheduler.run(replay.executor)

    expect(replay.recorder).toEqual(['F2', 'F3'])
    expect(pass.executed).toEqual(['F2', 'F3'])
    expect(scheduler.statusOf('F2')).toBe('ok')
    expect(scheduler.statusOf('F3')).toBe('ok')
  })

  it('interaction: marker to end restores F2 (never individually suppressed) but F3 (independently user-suppressed) stays suppressed, never runs', async () => {
    const { dag, map } = chain()
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty('F1')
    await scheduler.run(makeExecutor(ops).executor)

    dag.setSuppressed('F3', true) // F3 independently, individually suppressed
    dag.setRollbackMarker({ kind: 'start' }) // rolls back F1, F2, F3 too
    scheduler.markDirty('F1')
    const rolledBackPass = makeExecutor(ops)
    await scheduler.run(rolledBackPass.executor)
    expect(rolledBackPass.recorder).toEqual([])
    expect(scheduler.statusOf('F1')).toBe('rolledBack')
    expect(scheduler.statusOf('F2')).toBe('rolledBack')
    // F3 is BOTH rolled back and user-suppressed -- suppression is the more
    // specific, individually-authored state and wins the status report.
    expect(scheduler.statusOf('F3')).toBe('suppressed')

    dag.setRollbackMarker({ kind: 'end' }) // restore the rollback...
    const restore = makeExecutor(ops)
    scheduler.markDirty('F1')
    const pass = await scheduler.run(restore.executor)

    // F1 and F2 replay (never individually suppressed); F3 never runs --
    // still suppressed on its own merit, the marker passing it changed nothing.
    expect(restore.recorder).toEqual(['F1', 'F2'])
    expect(pass.executed).toEqual(['F1', 'F2'])
    expect(scheduler.statusOf('F1')).toBe('ok')
    expect(scheduler.statusOf('F2')).toBe('ok')
    expect(scheduler.statusOf('F3')).toBe('suppressed')
  })
})

describe('Mission #2 (absent-not-error): rollback is checked BEFORE failure isolation', () => {
  it('a rolled-back node downstream of a genuinely FAILED upstream reports "rolledBack", never "degraded"', async () => {
    const { dag, map } = chain()
    const scheduler = new RegenScheduler(dag, map)

    dag.setRollbackMarker({ kind: 'start' })
    scheduler.markDirty('F1')
    const failThenSkip = makeExecutor({ F1: { ok: false } })
    await scheduler.run(failThenSkip.executor)

    expect(scheduler.statusOf('F1')).toBe('rolledBack')
    expect(scheduler.statusOf('F2')).toBe('rolledBack')
    expect(scheduler.statusOf('F3')).toBe('rolledBack')
    expect(failThenSkip.recorder).toEqual([]) // F1's own op never even ran -- rolled back first
  })
})
