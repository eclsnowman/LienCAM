import { describe, expect, it, vi } from 'vitest'
import {
  FeaturePreviewSession,
  type FeaturePreviewAdapter,
  type FeaturePreviewBaseline,
  type FeaturePreviewEvaluation,
} from '../../components/model3d/featurePreviewSession'

interface Baseline {
  nodes: Array<{ id: string; value: number }>
}

interface Intent {
  value: number
}

interface Handle {
  id: string
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason?: unknown) => void
  const promise = new Promise<T>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}

function makeAdapter(overrides: Partial<FeaturePreviewAdapter<Baseline, Intent, Handle, Handle>> = {}) {
  const live = { nodes: [{ id: 'feature-1', value: 7 }], historyCount: 0 }
  const disposedCandidates: string[] = []
  const disposedPreFeatures: string[] = []
  const presented: string[] = []
  const restored: string[] = []
  const materializePreFeature = vi.fn(async (_context: FeaturePreviewBaseline<Baseline>) => ({ id: 'pre-feature' }))
  const evaluate = vi.fn(async ({ intent }: { intent: Readonly<Intent> }): Promise<FeaturePreviewEvaluation<Handle>> => ({
    ok: true,
    candidate: { id: `candidate-${intent.value}` },
  }))
  const adapter: FeaturePreviewAdapter<Baseline, Intent, Handle, Handle> = {
    captureBaseline: () => ({
      snapshot: { nodes: live.nodes.map((node) => ({ ...node })) },
      fingerprint: 'dag-v1:feature-1',
    }),
    materializePreFeature,
    evaluate,
    presentCandidate: ({ candidate }) => { presented.push(candidate.id) },
    disposeCandidate: (candidate) => { disposedCandidates.push(candidate.id) },
    disposePreFeature: (handle) => { disposedPreFeatures.push(handle.id) },
    restoreOriginal: (reason) => { restored.push(reason) },
    ...overrides,
  }
  return { adapter, live, disposedCandidates, disposedPreFeatures, presented, restored, materializePreFeature, evaluate }
}

describe('FeaturePreviewSession', () => {
  it('supersedes stale completion and presents only the newer generation', async () => {
    const first = deferred<FeaturePreviewEvaluation<Handle>>()
    const second = deferred<FeaturePreviewEvaluation<Handle>>()
    const { adapter, disposedCandidates, presented } = makeAdapter({
      evaluate: vi.fn(({ intent }) => intent.value === 1 ? first.promise : second.promise),
    })
    const session = new FeaturePreviewSession(adapter)

    const oldRequest = session.request({ value: 1 })
    await vi.waitFor(() => expect(adapter.evaluate).toHaveBeenCalledTimes(1))
    const newRequest = session.request({ value: 2 })
    first.resolve({ ok: true, candidate: { id: 'old' } })
    await vi.waitFor(() => expect(adapter.evaluate).toHaveBeenCalledTimes(2))
    second.resolve({ ok: true, candidate: { id: 'new' } })

    await expect(oldRequest).resolves.toMatchObject({ status: 'superseded' })
    await expect(newRequest).resolves.toMatchObject({ status: 'ready' })
    expect(disposedCandidates).toEqual(['old'])
    expect(presented).toEqual(['new'])
  })

  it('keeps one evaluation in flight and coalesces pending work to the latest intent', async () => {
    const first = deferred<FeaturePreviewEvaluation<Handle>>()
    let active = 0
    let maxActive = 0
    const seen: number[] = []
    const { adapter } = makeAdapter({
      evaluate: vi.fn(async ({ intent }) => {
        active += 1
        maxActive = Math.max(maxActive, active)
        seen.push(intent.value)
        const result = intent.value === 1
          ? await first.promise
          : { ok: true as const, candidate: { id: `candidate-${intent.value}` } }
        active -= 1
        return result
      }),
    })
    const session = new FeaturePreviewSession(adapter)

    const one = session.request({ value: 1 })
    await vi.waitFor(() => expect(adapter.evaluate).toHaveBeenCalledTimes(1))
    const two = session.request({ value: 2 })
    const three = session.request({ value: 3 })
    first.resolve({ ok: true, candidate: { id: 'candidate-1' } })

    await expect(two).resolves.toMatchObject({ status: 'superseded' })
    await expect(one).resolves.toMatchObject({ status: 'superseded' })
    await expect(three).resolves.toMatchObject({ status: 'ready' })
    expect(seen).toEqual([1, 3])
    expect(maxActive).toBe(1)
  })

  it('does not let a stale evaluation error poison the newer queued intent', async () => {
    const first = deferred<FeaturePreviewEvaluation<Handle>>()
    const { adapter, presented } = makeAdapter({
      evaluate: vi.fn(({ intent }) => intent.value === 1
        ? first.promise
        : Promise.resolve({ ok: true as const, candidate: { id: 'new-after-error' } })),
    })
    const session = new FeaturePreviewSession(adapter)

    const oldRequest = session.request({ value: 1 })
    await vi.waitFor(() => expect(adapter.evaluate).toHaveBeenCalledTimes(1))
    const newRequest = session.request({ value: 2 })
    first.reject(new Error('stale kernel failure'))

    await expect(oldRequest).resolves.toMatchObject({ status: 'superseded' })
    await expect(newRequest).resolves.toMatchObject({ status: 'ready' })
    expect(presented).toEqual(['new-after-error'])
  })

  it('disposes an evaluated candidate when current presentation fails', async () => {
    const { adapter, disposedCandidates, restored } = makeAdapter({
      presentCandidate: vi.fn(async () => { throw new Error('viewport paint failed') }),
    })
    const session = new FeaturePreviewSession(adapter)

    await expect(session.request({ value: 21 })).resolves.toMatchObject({
      status: 'error',
      reason: 'viewport paint failed',
    })
    expect(disposedCandidates).toEqual(['candidate-21'])
    expect(restored).toEqual(['error'])
  })

  it('disposes a stale candidate when presentation fails after a newer intent queues', async () => {
    const firstPaint = deferred<void>()
    const { adapter, disposedCandidates, presented } = makeAdapter({
      presentCandidate: vi.fn(async ({ candidate }) => {
        if (candidate.id === 'candidate-31') await firstPaint.promise
        presented.push(candidate.id)
      }),
    })
    const session = new FeaturePreviewSession(adapter)

    const oldRequest = session.request({ value: 31 })
    await vi.waitFor(() => expect(adapter.presentCandidate).toHaveBeenCalledTimes(1))
    const newRequest = session.request({ value: 32 })
    firstPaint.reject(new Error('stale viewport paint failed'))

    await expect(oldRequest).resolves.toMatchObject({ status: 'superseded' })
    await expect(newRequest).resolves.toMatchObject({ status: 'ready' })
    expect(disposedCandidates).toContain('candidate-31')
    expect(presented).toEqual(['candidate-32'])
  })

  it('uses a frozen detached baseline without mutating live DAG or history state', async () => {
    const { adapter, live } = makeAdapter({
      evaluate: vi.fn(async ({ snapshot }) => {
        expect(Object.isFrozen(snapshot)).toBe(true)
        expect(Object.isFrozen(snapshot.nodes)).toBe(true)
        expect(Object.isFrozen(snapshot.nodes[0])).toBe(true)
        return { ok: true as const, candidate: { id: 'candidate' } }
      }),
    })
    const session = new FeaturePreviewSession(adapter)

    await expect(session.request({ value: 8 })).resolves.toMatchObject({ status: 'ready' })
    expect(live).toEqual({ nodes: [{ id: 'feature-1', value: 7 }], historyCount: 0 })
  })

  it('transfers the accepted candidate exactly once without disposing it', async () => {
    const { adapter, disposedCandidates, disposedPreFeatures } = makeAdapter()
    const session = new FeaturePreviewSession(adapter)
    await session.request({ value: 4 })

    await expect(session.takeCandidate()).resolves.toEqual({ id: 'candidate-4' })
    await expect(session.takeCandidate()).rejects.toThrow('session is taken')
    await session.cancel()
    expect(disposedCandidates).toEqual([])
    expect(disposedPreFeatures).toEqual(['pre-feature'])
  })

  it('disposes cancel and error resources idempotently and rejects Apply afterward', async () => {
    const cancelled = makeAdapter()
    const cancelledSession = new FeaturePreviewSession(cancelled.adapter)
    await cancelledSession.request({ value: 5 })
    await Promise.all([cancelledSession.cancel(), cancelledSession.cancel()])
    expect(cancelled.disposedCandidates).toEqual(['candidate-5'])
    expect(cancelled.disposedPreFeatures).toEqual(['pre-feature'])
    await expect(cancelledSession.takeCandidate()).rejects.toThrow('session is cancelled')

    const failed = makeAdapter({ evaluate: vi.fn(async () => { throw new Error('kernel failed') }) })
    const failedSession = new FeaturePreviewSession(failed.adapter)
    await expect(failedSession.request({ value: 6 })).resolves.toMatchObject({ status: 'error', reason: 'kernel failed' })
    await failedSession.cancel()
    expect(failed.disposedPreFeatures).toEqual(['pre-feature'])
    await expect(failedSession.takeCandidate()).rejects.toThrow('session is error')
  })

  it('rejects Apply after a refused evaluation and replays one immutable baseline fingerprint', async () => {
    const { adapter, materializePreFeature, disposedCandidates } = makeAdapter({
      evaluate: vi.fn(async () => ({ ok: false as const, reason: 'invalid draft face' })),
    })
    const session = new FeaturePreviewSession(adapter)

    await expect(session.request({ value: 9 })).resolves.toEqual({
      status: 'refused',
      generation: 1,
      reason: 'invalid draft face',
    })
    await expect(session.takeCandidate()).rejects.toThrow('no accepted preview')
    expect(materializePreFeature).toHaveBeenCalledTimes(1)
    expect(materializePreFeature).toHaveBeenCalledWith(expect.objectContaining({
      fingerprint: 'dag-v1:feature-1',
      snapshot: { nodes: [{ id: 'feature-1', value: 7 }] },
    }))
    expect(Object.isFrozen(materializePreFeature.mock.calls[0]![0].snapshot)).toBe(true)
    expect(disposedCandidates).toEqual([])
  })

  it('restores after refusal and re-arms restoration after a later ready preview', async () => {
    const restored: string[] = []
    const { adapter } = makeAdapter({
      evaluate: vi.fn(async ({ intent }) => intent.value === 1
        ? { ok: false as const, reason: 'not draftable' }
        : { ok: true as const, candidate: { id: 'recovered-candidate' } }),
      restoreOriginal: (reason) => { restored.push(reason) },
    })
    const session = new FeaturePreviewSession(adapter)

    await expect(session.request({ value: 1 })).resolves.toMatchObject({ status: 'refused' })
    await expect(session.request({ value: 2 })).resolves.toMatchObject({ status: 'ready' })
    await session.cancel()

    expect(restored).toEqual(['refused', 'cancel'])
  })
})
