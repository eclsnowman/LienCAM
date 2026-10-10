// @vitest-environment jsdom
//
// WO UI-3 acceptance #1: the design tree renders a feature DAG from the doc
// layer with per-feature status badges driven by DOC-5's status store, and
// status transitions update LIVE against the REAL RegenScheduler (not a
// fake/mock scheduler) -- only the kernel op itself (FeatureOp) is mocked,
// exactly per the criterion's "drives the real scheduler with a mock op".
// The mock op is a manually-gated promise (same "deterministic op-gate, not
// wall-clock sleeps" style DOC-5's own scheduler.test.ts used for its
// AC #2 cancellation proof) so the test can assert the 'running' state is
// actually observed mid-flight, not just skipped over.

import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
import { FeatureTree } from '../../components/model3d/tree'
import { FeatureDag, ElementMap, RegenScheduler, type DagNodeSnapshot } from '../../doc'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function statusOfRow(id: string): string | null {
  return screen.getByTestId(`feature-row-${id}`).querySelector('[data-status]')?.getAttribute('data-status') ?? null
}

describe('FeatureTree live status (WO UI-3 acceptance #1)', () => {
  it('reflects ok -> dirty -> running -> ok, driven by the real scheduler with a mock op', async () => {
    vi.useFakeTimers()
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { name: 'Box' } })
    const scheduler = new RegenScheduler(dag, new ElementMap())

    render(<FeatureTree dag={dag} scheduler={scheduler} pollMs={10} />)

    // Never built -> DOC-5's DEFAULT_STATUS ('dirty'), rendered without any
    // scheduler activity at all.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(statusOfRow('F1')).toBe('dirty')

    scheduler.markDirty('F1')
    const gate = deferred<void>()
    let opStarted = false
    const runPromise = scheduler.run(async (_node: DagNodeSnapshot) => {
      opStarted = true
      await gate.promise
      return { ok: true, diagnostics: [] }
    })

    // The scheduler sets 'running' synchronously before invoking the op; the
    // op itself is now parked on the gate, so this window is stable to poll.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(opStarted).toBe(true)
    expect(statusOfRow('F1')).toBe('running')

    gate.resolve()
    await act(async () => {
      await runPromise
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(statusOfRow('F1')).toBe('ok')

    // UI-3-R1 finding 3: the test name claims ok -> dirty -> running -> ok,
    // but everything above only proves dirty -> running -> ok (the FIRST
    // assertion is the never-built DEFAULT dirty state, not a live flip from
    // an established 'ok'). Prove the LIVE ok -> dirty transition here: mark
    // the now-'ok' row dirty again and assert the tree reflects it before
    // the next run starts.
    scheduler.markDirty('F1')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(statusOfRow('F1')).toBe('dirty')
  })

  it('reflects failed (own op) and degraded (upstream failed) with a real dependency edge', async () => {
    vi.useFakeTimers()
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: {} })
    dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['F1'], payload: {} })
    const scheduler = new RegenScheduler(dag, new ElementMap())

    render(<FeatureTree dag={dag} scheduler={scheduler} pollMs={10} />)

    scheduler.markDirty('F1')
    await scheduler.run(async (node: DagNodeSnapshot) => {
      if (node.id === 'F1') {
        return { ok: false, diagnostics: [{ code: 'KERNEL_OP_FAILED' as const, severity: 'error' as const, params: {} }] }
      }
      return { ok: true, diagnostics: [] }
    })

    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(statusOfRow('F1')).toBe('failed')
    expect(statusOfRow('F2')).toBe('degraded')

    // Repair: F1 succeeds -> both clear (mirrors DOC-5's own repair story).
    scheduler.markDirty('F1')
    await scheduler.run(async () => ({ ok: true, diagnostics: [] }))
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20)
    })
    expect(statusOfRow('F1')).toBe('ok')
    expect(statusOfRow('F2')).toBe('ok')
  })

  it('renders selection state and status badges for a multi-feature DAG (no scheduler wired)', () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'S1', kind: 'sketch', payload: { name: 'Sketch 1' } })
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: ['S1'], payload: { name: 'Extrude' } })
    render(<FeatureTree dag={dag} selectedId="F1" />)
    expect(screen.getByTestId('feature-row-S1')).toBeTruthy()
    expect(screen.getByTestId('feature-row-F1').getAttribute('aria-selected')).toBe('true')
    // No scheduler -> honest 'never built' default, not a fabricated 'ok'.
    expect(statusOfRow('S1')).toBe('dirty')
  })
})
