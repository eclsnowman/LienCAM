import { describe, it, expect } from 'vitest'
import { FeatureDag } from '../../../doc/dag'
import { ElementMap } from '../../../doc/element-map'
import { RegenScheduler } from '../../../doc/regen'
import { genDelta, makeExecutor, makeGate, plane } from './_helpers'

// WO DOC-5 acceptance criteria 1-3: dirty propagation (over-regeneration
// guarded), cancellation + reschedule (deterministic op-gate, no wall clock),
// and failure isolation (failed feature -> degraded dependents whose last-good
// geometry survives; repair clears both).

// ---------------------------------------------------------------------------
// AC #1 -- dirty propagation across a diamond, with an over-regeneration guard.
// ---------------------------------------------------------------------------

describe('AC #1: dirty propagation regenerates exactly the downstream closure', () => {
  // A >=6-feature DAG with a diamond (F4 joins F2 and F3) plus an untouched
  // branch (F6 off F1). Editing F2 must re-execute {F2, F4, F5} only.
  //
  //        F1
  //      / | \
  //    F2  F3  F6
  //      \ /
  //       F4
  //       |
  //       F5
  function buildDag(): FeatureDag {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({ id: 'F6', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({ id: 'F4', kind: 'feature', consumes: ['F2', 'F3'] })
    dag.insertNode({ id: 'F5', kind: 'feature', consumes: ['F4'] })
    return dag
  }

  const ops = Object.fromEntries(
    ['F1', 'F2', 'F3', 'F4', 'F5', 'F6'].map((id) => [id, { delta: genDelta(id, [`${id}:F`]) }]),
  )

  it('editing F2 re-executes only {F2, F4, F5} in topological order; untouched F1/F3/F6 never run', async () => {
    const dag = buildDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)

    // Initial full build off the root.
    const build = makeExecutor(ops)
    scheduler.markDirty('F1')
    const first = await scheduler.run(build.executor)
    expect(first.executed.length).toBe(6)
    for (const id of ['F1', 'F2', 'F3', 'F4', 'F5', 'F6']) {
      expect(scheduler.statusOf(id)).toBe('ok')
    }

    // Now edit F2 only.
    const edit = makeExecutor(ops)
    scheduler.markDirty('F2')
    // The closure that got marked dirty is exactly {F2, F4, F5}.
    expect(scheduler.dirtyIds()).toEqual(['F2', 'F4', 'F5'])

    const pass = await scheduler.run(edit.executor)

    // Over-regeneration guard: the op-call recorder must contain ONLY the
    // downstream closure -- an untouched feature here fails the test.
    const expected = new Set(['F2', 'F4', 'F5'])
    expect(edit.recorder).toEqual(dag.topoOrder().filter((id) => expected.has(id)))
    expect(edit.recorder).not.toContain('F1')
    expect(edit.recorder).not.toContain('F3')
    expect(edit.recorder).not.toContain('F6')
    expect(pass.executed).toEqual(edit.recorder)
    expect(scheduler.dirtyIds()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// AC #2 -- cancellation: a second edit mid-pass cancels + reschedules cleanly.
// ---------------------------------------------------------------------------

describe('AC #2: a mid-pass edit cancels the in-flight pass and reschedules to a clean combined regen', () => {
  function build(): { dag: FeatureDag; map: ElementMap } {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({ id: 'F3', kind: 'feature', consumes: ['F2'] })
    return { dag, map: new ElementMap() }
  }
  const ops = Object.fromEntries(
    ['F1', 'F2', 'F3'].map((id) => [id, { delta: genDelta(id, [`${id}:F`]) }]),
  )

  it('the cancelled+rescheduled final state equals a single clean regen; nothing is stuck running', async () => {
    // Reference: a single clean pass over the whole chain.
    const ref = build()
    const refSched = new RegenScheduler(ref.dag, ref.map)
    refSched.markDirty('F1')
    await refSched.run(makeExecutor(ops).executor)
    const refIds = ref.map.serializeIds()
    const refStatuses = refSched.statuses()

    // Live: park at F1 (first chunk), inject a second edit mid-pass, release.
    const live = build()
    const sched = new RegenScheduler(live.dag, live.map)
    const g = makeGate()
    const gatedOps = {
      F1: () => ({ delta: genDelta('F1', ['F1:F']), gate: g.gate }),
      F2: { delta: genDelta('F2', ['F2:F']) },
      F3: { delta: genDelta('F3', ['F3:F']) },
    }
    // The gated F1 op signals when it is entered so the test can inject the
    // second edit deterministically -- no wall-clock sleep anywhere.
    const gatedExec = makeExecutor({
      ...gatedOps,
      F1: () => {
        g.signalReached()
        return { delta: genDelta('F1', ['F1:F']), gate: g.gate }
      },
    })

    sched.markDirty('F1')
    const run1 = sched.run(gatedExec.executor)
    await g.reached // executor(F1) is now parked on the gate
    expect(sched.statusOf('F1')).toBe('running')

    // Second edit arrives mid-pass -> cancels run1.
    sched.markDirty('F1')
    const run2 = sched.run(gatedExec.executor)

    g.release() // let the in-flight F1 op settle; run1 sees it was cancelled
    const [r1, r2] = await Promise.all([run1, run2])

    expect(r1.cancelled).toBe(true)
    expect(r2.cancelled).toBe(false)

    // No status stuck at 'running'.
    expect(sched.hasRunning()).toBe(false)
    // Final ID set + statuses match the single clean regen exactly.
    expect(live.map.serializeIds()).toBe(refIds)
    expect(sched.statuses()).toEqual(refStatuses)
    for (const [, status] of sched.statuses()) expect(status).toBe('ok')
    expect(sched.dirtyIds()).toEqual([])
  })

  it('queues a competing run behind synchronous prepared adoption without a second kernel replay', async () => {
    const live = build()
    const scheduler = new RegenScheduler(live.dag, live.map)
    const results = new Map([
      ['F1', { ok: true as const, elementMap: genDelta('F1', ['F1:F']), diagnostics: [] }],
      ['F2', { ok: true as const, elementMap: genDelta('F2', ['F2:F']), diagnostics: [] }],
      ['F3', { ok: true as const, elementMap: genDelta('F3', ['F3:F']), diagnostics: [] }],
    ])
    const competing = makeExecutor(ops)
    let queued!: ReturnType<RegenScheduler['run']>
    let published = 0

    scheduler.markDirty('F1')
    const adopted = await scheduler.adoptPrepared(
      ['F1', 'F2', 'F3'],
      (id) => results.get(id)!,
      () => {
        published += 1
        scheduler.markDirty('F1')
        queued = scheduler.run(competing.executor)
      },
    )
    const queuedPass = await queued

    expect(published).toBe(1)
    expect(adopted).toEqual({ executed: ['F1', 'F2', 'F3'], cancelled: false })
    expect(queuedPass).toEqual({ executed: [], cancelled: false })
    expect(competing.recorder).toEqual([])
    expect(scheduler.dirtyIds()).toEqual([])
    expect(scheduler.statuses().map(([, status]) => status)).toEqual(['ok', 'ok', 'ok'])
  })

  it('releases the scheduler tail when prepared publication throws', async () => {
    const live = build()
    const scheduler = new RegenScheduler(live.dag, live.map)
    const result = { ok: true as const, elementMap: genDelta('F1', ['F1:F']), diagnostics: [] }
    scheduler.markDirty('F1')

    await expect(scheduler.adoptPrepared(['F1'], () => result, () => {
      throw new Error('publication refused')
    })).rejects.toThrow('publication refused')

    const repair = makeExecutor(ops)
    const pass = await scheduler.run(repair.executor)
    expect(pass.cancelled).toBe(false)
    expect(repair.recorder).toEqual(['F1', 'F2', 'F3'])
    expect(scheduler.dirtyIds()).toEqual([])
  })

  it('publishes and adopts a brand-new id inside the serialized boundary without executor replay', async () => {
    const live = build()
    const scheduler = new RegenScheduler(live.dag, live.map)
    const gate = makeGate()
    const priorExecutor = makeExecutor({
      F1: () => {
        gate.signalReached()
        return { delta: genDelta('F1', ['F1:F']), gate: gate.gate }
      },
      F2: { delta: genDelta('F2', ['F2:F']) },
      F3: { delta: genDelta('F3', ['F3:F']) },
    })
    const preparedResult = {
      ok: true as const,
      elementMap: genDelta('F4', ['F4:F']),
      diagnostics: [],
    }
    const competing = makeExecutor({
      ...ops,
      F4: { delta: genDelta('F4', ['F4:F']) },
    })
    let published = 0
    let committed = 0
    let rolledBack = 0
    let queued!: ReturnType<RegenScheduler['run']>

    scheduler.markDirty('F1')
    const prior = scheduler.run(priorExecutor.executor)
    await gate.reached

    expect(live.dag.has('F4')).toBe(false)
    const adoption = scheduler.adoptPreparedWithTransaction(
      ['F4'],
      () => preparedResult,
      {
        publish: () => {
          published += 1
          live.dag.insertNode({ id: 'F4', kind: 'feature', consumes: ['F3'] })
          scheduler.markDirty('F4')
          queued = scheduler.run(competing.executor)
        },
        commit: () => {
          committed += 1
        },
        rollback: () => {
          rolledBack += 1
          if (live.dag.has('F4')) live.dag.removeNode('F4')
        },
      },
    )

    // Adoption queued behind the still-running pass; the live node remains
    // absent until that pass reaches its cancellation boundary and unwinds.
    await Promise.resolve()
    expect(published).toBe(0)
    expect(live.dag.has('F4')).toBe(false)

    gate.release()
    const [priorResult, adoptionResult] = await Promise.all([prior, adoption])
    const queuedResult = await queued

    expect(priorResult.cancelled).toBe(true)
    expect(adoptionResult).toEqual({ executed: ['F4'], cancelled: false })
    expect(queuedResult).toEqual({ executed: ['F1', 'F2', 'F3'], cancelled: false })
    expect(published).toBe(1)
    expect(committed).toBe(1)
    expect(rolledBack).toBe(0)
    expect(live.dag.has('F4')).toBe(true)
    expect(live.map.resolve('F4:F').status).toBe('exact')
    expect(scheduler.statusOf('F4')).toBe('ok')
    expect(scheduler.dirtyIds()).toEqual([])
    expect(priorExecutor.recorder).toEqual(['F1'])
    expect(competing.recorder).toEqual(['F1', 'F2', 'F3'])
    expect(competing.recorder).not.toContain('F4')
  })

  it('rolls back once when the published transaction does not create its prepared id', async () => {
    const live = build()
    const scheduler = new RegenScheduler(live.dag, live.map)
    let published = 0
    let committed = 0
    let rolledBack = 0

    await expect(scheduler.adoptPreparedWithTransaction(
      ['F4'],
      () => ({ ok: true, elementMap: genDelta('F4', ['F4:F']), diagnostics: [] }),
      {
        publish: () => {
          published += 1
        },
        commit: () => {
          committed += 1
        },
        rollback: () => {
          rolledBack += 1
          throw new Error('rollback refused')
        },
      },
    )).rejects.toThrow("no such node 'F4'")

    expect(published).toBe(1)
    expect(committed).toBe(0)
    expect(rolledBack).toBe(1)
    expect(live.dag.has('F4')).toBe(false)
    expect(live.map.resolve('F4:F').status).toBe('lost')

    // The failed transaction released the scheduler boundary.
    scheduler.markDirty('F1')
    const repair = makeExecutor(ops)
    await expect(scheduler.run(repair.executor)).resolves.toEqual({
      executed: ['F1', 'F2', 'F3'],
      cancelled: false,
    })
  })

  it('rolls back a created node when prepared result resolution fails before scheduler mutation', async () => {
    const live = build()
    const scheduler = new RegenScheduler(live.dag, live.map)
    let committed = 0
    let rolledBack = 0

    await expect(scheduler.adoptPreparedWithTransaction(
      ['F4'],
      () => {
        throw new Error('prepared result unavailable')
      },
      {
        publish: () => {
          live.dag.insertNode({ id: 'F4', kind: 'feature', consumes: ['F3'] })
        },
        commit: () => {
          committed += 1
        },
        rollback: () => {
          rolledBack += 1
          live.dag.removeNode('F4')
        },
      },
    )).rejects.toThrow('prepared result unavailable')

    expect(committed).toBe(0)
    expect(rolledBack).toBe(1)
    expect(live.dag.has('F4')).toBe(false)
    expect(live.map.resolve('F4:F').status).toBe('lost')
    expect(scheduler.dirtyIds()).toEqual([])
  })

  it('snapshots the id list before waiting and rejects duplicate prepared ids before publication', async () => {
    const live = build()
    const scheduler = new RegenScheduler(live.dag, live.map)
    let published = 0
    const transaction = {
      publish: () => {
        published += 1
      },
      commit: () => undefined,
      rollback: () => undefined,
    }

    const duplicateIds = ['F4', 'F4']
    await expect(scheduler.adoptPreparedWithTransaction(
      duplicateIds,
      () => ({ ok: true, elementMap: genDelta('F4', ['F4:F']), diagnostics: [] }),
      transaction,
    )).rejects.toThrow('executed ids must be unique')
    expect(published).toBe(0)

    const ids = ['F4']
    const adoption = scheduler.adoptPreparedWithTransaction(
      ids,
      () => ({ ok: true, elementMap: genDelta('F4', ['F4:F']), diagnostics: [] }),
      {
        publish: () => {
          live.dag.insertNode({ id: 'F4', kind: 'feature', consumes: ['F3'] })
        },
        commit: () => undefined,
        rollback: () => {
          if (live.dag.has('F4')) live.dag.removeNode('F4')
        },
      },
    )
    ids.push('caller-mutation-after-call')

    await expect(adoption).resolves.toEqual({ executed: ['F4'], cancelled: false })
    expect(live.dag.has('caller-mutation-after-call')).toBe(false)
  })

  it('surfaces a forbidden commit throw without rolling back completed scheduler adoption and releases the tail', async () => {
    const live = build()
    const scheduler = new RegenScheduler(live.dag, live.map)
    let committed = 0
    let rolledBack = 0

    await expect(scheduler.adoptPreparedWithTransaction(
      ['F4'],
      () => ({ ok: true, elementMap: genDelta('F4', ['F4:F']), diagnostics: undefined as never }),
      {
        publish: () => {
          live.dag.insertNode({ id: 'F4', kind: 'feature', consumes: ['F3'] })
        },
        commit: () => {
          committed += 1
          throw new Error('commit contract violated')
        },
        rollback: () => {
          rolledBack += 1
        },
      },
    )).rejects.toThrow('commit contract violated')

    expect(committed).toBe(1)
    expect(rolledBack).toBe(0)
    expect(live.dag.has('F4')).toBe(true)
    expect(live.map.resolve('F4:F').status).toBe('exact')
    expect(scheduler.statusOf('F4')).toBe('ok')

    scheduler.markDirty('F4')
    const next = makeExecutor({ F4: { delta: genDelta('F4', ['F4:F']) } })
    await expect(scheduler.run(next.executor)).resolves.toEqual({ executed: ['F4'], cancelled: false })
  })
})

// ---------------------------------------------------------------------------
// AC #3 -- failure isolation: failed feature -> degraded dependents whose
// last-good geometry survives; repairing the feature clears both.
// ---------------------------------------------------------------------------

describe('AC #3: a failed feature degrades its dependents but their last-good geometry survives; repair clears both', () => {
  const BOX_TOP = 'F1:box:top'
  const FILLET_BAND = 'F2:fillet:band'
  const CUT_WALL = 'F3:cut:wall'

  // F1 box -> F2 fillet (consumes F1) -> F3 cut (consumes F2, references the
  // fillet band face). This is the plan's delete-fillet-downstream-survives
  // story at the scheduler level.
  function buildDag(): FeatureDag {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({
      id: 'F3',
      kind: 'feature',
      consumes: ['F2'],
      refs: [{ id: FILLET_BAND, kind: 'single-face' }],
    })
    return dag
  }

  const okOps = {
    F1: { delta: genDelta('F1', [BOX_TOP], { [BOX_TOP]: plane({ x: 0, y: 0, z: 10 }, 100) }) },
    F2: { delta: genDelta('F2', [FILLET_BAND], { [FILLET_BAND]: plane({ x: 0, y: 5, z: 8 }, 20) }) },
    F3: { delta: genDelta('F3', [CUT_WALL], { [CUT_WALL]: plane({ x: 3, y: 0, z: 5 }, 15) }) },
  }

  it('degrades the dependent, keeps the resolver answering, then clears on repair', async () => {
    const dag = buildDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)

    // Clean initial build.
    scheduler.markDirty('F1')
    await scheduler.run(makeExecutor(okOps).executor)
    expect(scheduler.statusOf('F1')).toBe('ok')
    expect(scheduler.statusOf('F2')).toBe('ok')
    expect(scheduler.statusOf('F3')).toBe('ok')
    // The fillet band the cut references resolves exactly before the failure.
    expect(map.resolve(FILLET_BAND, 'single-face').status).toBe('exact')

    // Edit F2 so its kernel op fails (e.g. fillet radius too large).
    const failOps = {
      ...okOps,
      F2: {
        ok: false,
        diagnostics: [{ code: 'FILLET_RADIUS_TOO_LARGE', severity: 'error', params: { radius: 999 } }] as const,
      },
    }
    scheduler.markDirty('F2')
    expect(scheduler.dirtyIds()).toEqual(['F2', 'F3'])
    const failPass = await scheduler.run(makeExecutor(failOps as never).executor)

    // F2 failed with its typed diagnostic.
    expect(scheduler.statusOf('F2')).toBe('failed')
    expect(scheduler.diagnosticsOf('F2').some((d) => d.code === 'FILLET_RADIUS_TOO_LARGE')).toBe(true)

    // F3 is degraded (upstream failed) and was NOT re-executed.
    expect(scheduler.statusOf('F3')).toBe('degraded')
    expect(scheduler.diagnosticsOf('F3').some((d) => d.code === 'UPSTREAM_FAILED')).toBe(true)
    expect(failPass.executed).not.toContain('F3')

    // Last-good geometry survives: the resolver still answers for the fillet
    // band AND the cut wall -- nothing was deleted from the ElementMap.
    expect(map.resolve(FILLET_BAND, 'single-face').status).toBe('exact')
    expect(map.resolve(CUT_WALL, 'single-face').status).toBe('exact')

    // Repair: edit F2 so it succeeds again.
    scheduler.markDirty('F2')
    const repair = makeExecutor(okOps)
    const repairPass = await scheduler.run(repair.executor)

    expect(scheduler.statusOf('F2')).toBe('ok')
    expect(scheduler.statusOf('F3')).toBe('ok')
    expect(scheduler.diagnosticsOf('F2')).toEqual([])
    expect(scheduler.diagnosticsOf('F3')).toEqual([])
    // Both re-executed this pass (F3 could rebuild once its upstream was healthy).
    expect(repairPass.executed).toEqual(['F2', 'F3'])
    expect(scheduler.dirtyIds()).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// R1 (audit major, scheduler.ts:151) -- a REJECTED worker op must fold into the
// same failure-isolation path as an ok:false result, not leave the node stuck
// 'running' and reject run(). FAILS-IF: pre-fix, run() rejects (so the await
// throws) and F2 is left 'running' with F3 never degraded.
// ---------------------------------------------------------------------------

describe('R1: a rejected kernel op fails the feature (not stuck running), degrades dependents, and clears on repair', () => {
  const BOX_TOP = 'F1:box:top'
  const FILLET_BAND = 'F2:fillet:band'
  const CUT_WALL = 'F3:cut:wall'

  // Same delete-fillet-downstream-survives chain as AC #3, but F2's kernel op
  // REJECTS (worker RPC threw) rather than returning a graceful ok:false.
  function buildDag(): FeatureDag {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'] })
    dag.insertNode({
      id: 'F3',
      kind: 'feature',
      consumes: ['F2'],
      refs: [{ id: FILLET_BAND, kind: 'single-face' }],
    })
    return dag
  }

  const okOps = {
    F1: { delta: genDelta('F1', [BOX_TOP], { [BOX_TOP]: plane({ x: 0, y: 0, z: 10 }, 100) }) },
    F2: { delta: genDelta('F2', [FILLET_BAND], { [FILLET_BAND]: plane({ x: 0, y: 5, z: 8 }, 20) }) },
    F3: { delta: genDelta('F3', [CUT_WALL], { [CUT_WALL]: plane({ x: 3, y: 0, z: 5 }, 15) }) },
  }

  it('run() resolves; F2 is failed with a typed diag; F3 degrades; last-good survives; repair clears', async () => {
    const dag = buildDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)

    // Clean initial build.
    scheduler.markDirty('F1')
    await scheduler.run(makeExecutor(okOps).executor)
    expect(scheduler.statusOf('F3')).toBe('ok')
    expect(map.resolve(FILLET_BAND, 'single-face').status).toBe('exact')

    // Edit F2 so its worker op REJECTS (not ok:false -- an actual thrown error).
    const rejectOps = { ...okOps, F2: { throws: new Error('worker RPC lost') } }
    scheduler.markDirty('F2')
    expect(scheduler.dirtyIds()).toEqual(['F2', 'F3'])

    // FAILS-IF: pre-fix this await REJECTS (the executor throw propagates out of
    // run()); the assertion that it resolves is the guard.
    const failPass = await scheduler.run(makeExecutor(rejectOps as never).executor)
    expect(failPass.cancelled).toBe(false)

    // F2 is 'failed' (NOT stuck 'running') with a synthesized typed diagnostic
    // that records the rejection reason.
    expect(scheduler.statusOf('F2')).toBe('failed')
    expect(scheduler.hasRunning()).toBe(false)
    const f2diag = scheduler.diagnosticsOf('F2').find((d) => d.code === 'KERNEL_OP_FAILED')
    expect(f2diag).toBeDefined()
    expect(f2diag?.params?.reason).toBe('worker RPC lost')

    // F3 degraded via the existing isolation path; not re-executed.
    expect(scheduler.statusOf('F3')).toBe('degraded')
    expect(scheduler.diagnosticsOf('F3').some((d) => d.code === 'UPSTREAM_FAILED')).toBe(true)
    expect(failPass.executed).not.toContain('F3')

    // Last-good geometry survives the rejection.
    expect(map.resolve(FILLET_BAND, 'single-face').status).toBe('exact')
    expect(map.resolve(CUT_WALL, 'single-face').status).toBe('exact')

    // Repair clears both.
    scheduler.markDirty('F2')
    const repairPass = await scheduler.run(makeExecutor(okOps).executor)
    expect(scheduler.statusOf('F2')).toBe('ok')
    expect(scheduler.statusOf('F3')).toBe('ok')
    expect(scheduler.diagnosticsOf('F2')).toEqual([])
    expect(scheduler.diagnosticsOf('F3')).toEqual([])
    expect(repairPass.executed).toEqual(['F2', 'F3'])
    expect(scheduler.dirtyIds()).toEqual([])
  })
})
