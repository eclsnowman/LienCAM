// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { typedMock } from '../support/typedMock'
import type { Project, Operation } from '../../types'
import type { KernelPlan } from '../../kernel/planning'
import { operationGenerationIsCurrent } from '../../lib/cam/generationFingerprint'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'

const injected = vi.hoisted(() => ({ plan: undefined as KernelPlan | undefined, calls: 0 }))
vi.mock('../../kernel/planning', async importOriginal => typedMock<typeof import('../../kernel/planning')>({
  ...await importOriginal<typeof import('../../kernel/planning')>(),
  kernelPlanners: Object.freeze({ drill: async () => {
    injected.calls++
    return injected.plan!
  } }),
}))
const { useCamStore } = await import('../../store')
class WorkerStub {
  static latest: WorkerStub | undefined
  onmessage: ((event: { data: WorkerResponseMsg }) => void) | null = null
  onerror: ((event: { message: string }) => void) | null = null
  terminate = vi.fn()
  dispatchedAt = 0
  postMessage = vi.fn((_request: WorkerRequestMsg) => { this.dispatchedAt = Date.now() })
  constructor() { WorkerStub.latest = this }
}
let setupId: string, opId: string
const operation = () => useCamStore.getState().project.setups[0].operations[0]
async function start() {
  const done = useCamStore.getState().computeOperationToolpath(setupId, opId)
  await vi.waitFor(() => expect(WorkerStub.latest?.postMessage).toHaveBeenCalledOnce())
  return { done, worker: WorkerStub.latest! }
}
function send(worker: WorkerStub, message: WorkerResponseMsg) { worker.onmessage?.({ data: message }) }

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubEnv('LIENCAM_ENGINE', 'current')
  injected.calls = 0
  WorkerStub.latest = undefined
  vi.stubGlobal('Worker', WorkerStub)
  const project = JSON.parse(readFileSync('examples/01-fixture-plate/fixture-plate.camproject', 'utf8')) as Project
  const setup = project.setups[0]
  const op = setup.operations.find(op => op.type === 'drill')!
  setup.operations = [{ ...op, status: 'outdated', toolpathMoves: undefined, generationFingerprint: undefined }]
  project.geometry = project.geometry.filter(g => g.format === 'svg')
  setupId = setup.id; opId = op.id
  useCamStore.setState({ project, toolLibrary: project.toolLibrary, toolpathBatch: null })
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.unstubAllEnvs() })

describe('WO-2904 planar worker inactivity', () => {
  it('ends a stalled production compute with the operation name at the shared 180 second timeout', async () => {
    const { done, worker } = await start()
    await vi.advanceTimersByTimeAsync(worker.dispatchedAt + 179_999 - Date.now())
    expect(operation().status).toBe('computing')
    await vi.advanceTimersByTimeAsync(1)
    expect(operation().status).toBe('error')
    expect(operation().errorMessage).toContain(operation().name)
    expect(operation().toolpathMoves).toBeUndefined()
    expect(worker.terminate).toHaveBeenCalledOnce()
    await done
    // An already queued late response cannot resurrect a timed-out operation.
    send(worker, { type: 'TOOLPATH_COMPLETE', opId, moves: [], computeTimeMs: 1 } as WorkerResponseMsg)
    expect(operation().status).toBe('error')
  })
  it('resets inactivity on progress, then stops supervising a successful result', async () => {
    const { done, worker } = await start()
    await vi.advanceTimersByTimeAsync(170_000)
    send(worker, { type: 'TOOLPATH_PROGRESS', opId, progress: 0.5, phase: 'Drilling' } as WorkerResponseMsg)
    await vi.advanceTimersByTimeAsync(170_000)
    expect(operation().status).toBe('computing')
    send(worker, { type: 'TOOLPATH_COMPLETE', opId, moves: [], computeTimeMs: 2 } as WorkerResponseMsg)
    await done
    expect(operation().status).toBe('ready')
    await vi.advanceTimersByTimeAsync(180_000)
    expect(operation().status).toBe('ready')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
  it('flips a registered engine stale and recomputes through production Post staging', async () => {
    const { done, worker } = await start()
    send(worker, { type: 'TOOLPATH_COMPLETE', opId, moves: [], computeTimeMs: 2 } as WorkerResponseMsg)
    await done
    const before = operation()
    const current = () => {
      const state = useCamStore.getState()
      return operationGenerationIsCurrent(state.project, state.project.setups[0], operation())
    }
    expect(current()).toBe(true)
    injected.plan = { moves: [], resolvedHeights: before.resolvedHeights!,
      resolvedHeightPlan: before.resolvedHeightPlan!, computeTimeMs: 3 }
    vi.stubEnv('LIENCAM_ENGINE', 'kernel')
    expect(current()).toBe(false)
    const staged = await useCamStore.getState().stageOperationsForEmission(setupId, undefined)
    expect(staged.recomputed.map(entry => entry.opId)).toEqual([opId])
    expect(injected.calls).toBe(1)
    expect(current()).toBe(true)
    expect(operation().generationFingerprint).not.toBe(before.generationFingerprint)
    staged.restore()
  })
  it.each(['error', 'crash'])('cleans up the watchdog after worker %s', async route => {
    const { done, worker } = await start()
    if (route === 'error') send(worker, { type: 'TOOLPATH_ERROR', opId, message: 'Test worker error' } as WorkerResponseMsg)
    else worker.onerror?.({ message: 'Test crash' })
    await done
    const failed = operation() as Operation
    await vi.advanceTimersByTimeAsync(180_000)
    expect(operation().errorMessage).toBe(failed.errorMessage)
    expect(operation().status).toBe('error')
    expect(worker.terminate).toHaveBeenCalledOnce()
  })
})
