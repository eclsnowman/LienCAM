// @vitest-environment jsdom

import { typedMock } from '../support/typedMock'
import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'
import type { GeomClient } from '../../geom'
import type { KernelInfo } from '../../geom/geom-service'
import type { Sketch3dSolveService } from '../../sketch3d/solveService'
import { SolidsWorkbenchPage, abandonableGeomClient } from '../../components/model3d/SolidsWorkbenchPage'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'

// Preserve the production factory identity and real abandonable wrapper;
// replace only the worker transport, as in WO-2705's early-preview tests.
const transport = vi.hoisted(() => ({ create: vi.fn<() => GeomClient>() }))
vi.mock('../../geom', async (original) => typedMock<typeof import('../../geom')>({
  ...await original<typeof import('../../geom')>(),
  createGeomService: () => transport.create(),
}))

const policy = { timeoutMs: 2_000, maxAttempts: 1 } as const
const solve = async (): Promise<Sketch3dSolveService> => ({ dispose: () => undefined }) as Sketch3dSolveService
const failureLines = () => vi.mocked(console.error).mock.calls.filter(([message]) =>
  typeof message === 'string' && message.includes('3D geometry engine initialization failed'))

function pendingClient() {
  const client = createFakeGeomClient()
  let reject!: (error: Error) => void
  const pending = new Promise<KernelInfo>((_resolve, no) => { reject = no })
  client.init = vi.fn(() => pending)
  client.terminate = vi.fn(async () => undefined)
  return { client, reject }
}

function readyClient() {
  const client = createFakeGeomClient()
  client.terminate = vi.fn(async () => undefined)
  return client
}

function page(createClient?: () => GeomClient, modelItemId = 'wo2616-replay', timeoutMs: number = policy.timeoutMs) {
  return <SolidsWorkbenchPage
    modelItemId={modelItemId}
    createClient={createClient}
    createSceneRuntime={fakeCreateSceneRuntime}
    createSolveService={solve}
    geometryBootPolicy={{ ...policy, timeoutMs }}
  />
}

beforeEach(() => {
  transport.create.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  window.LienSplash = { ready: () => undefined, setProgress: () => undefined }
})

afterEach(() => {
  cleanup()
  delete window.LienSplash
  vi.restoreAllMocks()
})

describe('WO-2616 deliberate same-instance boot replay close', () => {
  it('replays a pending production client in StrictMode without a false init failure and terminates each once', async () => {
    const first = pendingClient()
    const second = readyClient()
    transport.create.mockReturnValueOnce(first.client).mockReturnValueOnce(second)
    const view = render(<StrictMode>{page()}</StrictMode>)

    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toBe('Ready'))
    expect(transport.create).toHaveBeenCalledTimes(2)
    expect(first.client.init).toHaveBeenCalledTimes(1)
    expect(first.client.terminate).toHaveBeenCalledTimes(1)
    expect(second.terminate).not.toHaveBeenCalled()
    expect(failureLines()).toEqual([])
    view.unmount()
    await act(async () => { await Promise.resolve() })
    expect(first.client.terminate).toHaveBeenCalledTimes(1)
    expect(second.terminate).toHaveBeenCalledTimes(1)
  })

  it('logs a genuine identical-message rejection despite a newer StrictMode setup', async () => {
    // Same-thread injected clients keep settling after cleanup (WO-091).
    // This proves the replay guard cannot classify by text or ownership alone.
    const first = pendingClient()
    const second = readyClient()
    const create = vi.fn<() => GeomClient>().mockReturnValueOnce(first.client).mockReturnValueOnce(second)
    render(<StrictMode>{page(create)}</StrictMode>)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toBe('Ready'))
    const error = new Error('The geometry client was closed.')
    await act(async () => { first.reject(error) })
    expect(failureLines()).toHaveLength(1)
    expect(failureLines()[0][1]).toBe(error)
    expect(first.client.terminate).toHaveBeenCalledTimes(1)
  })

  it('retains an ordinary abandon error even when terminate and replay follow it', async () => {
    const inner = pendingClient()
    const first = abandonableGeomClient(inner.client, { gateUntilInit: true })
    inner.client.init = vi.fn(() => {
      first.abandon('The geometry client was closed.')
      return new Promise<KernelInfo>(() => undefined)
    })
    const second = readyClient()
    const create = vi.fn<() => GeomClient>().mockReturnValueOnce(first).mockReturnValueOnce(second)
    render(<StrictMode>{page(create)}</StrictMode>)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toBe('Ready'))
    expect(failureLines()).toHaveLength(1)
    expect(failureLines()[0][1]).toMatchObject({ message: 'The geometry client was closed.' })
    expect(inner.client.terminate).toHaveBeenCalledTimes(1)
  })

  it('logs a real initialization rejection after navigation unmount', async () => {
    const first = pendingClient()
    const view = render(page(() => first.client))
    expect(first.client.init).toHaveBeenCalledTimes(1)
    view.unmount()
    const error = new Error('worker module import failed after navigation')
    await act(async () => { first.reject(error) })
    expect(failureLines()).toHaveLength(1)
    expect(failureLines()[0][1]).toBe(error)
    expect(first.client.terminate).toHaveBeenCalledTimes(1)
  })

  it('logs the real deadline after navigation unmount', async () => {
    const first = pendingClient()
    const view = render(page(() => first.client, 'wo2616-timeout', 60))
    expect(first.client.init).toHaveBeenCalledTimes(1)
    view.unmount()
    await waitFor(() => expect(failureLines()).toHaveLength(1))
    expect(failureLines()[0][1]).toMatchObject({ message: 'geometry engine initialization timed out after 60ms' })
    expect(first.client.terminate).toHaveBeenCalledTimes(1)
  })

  it('keeps the production close diagnostic when a different document replaces a pending client', async () => {
    const first = pendingClient()
    const second = readyClient()
    transport.create.mockReturnValueOnce(first.client).mockReturnValueOnce(second)
    const view = render(page(undefined, 'wo2616-old-document'))
    expect(first.client.init).toHaveBeenCalledTimes(1)
    view.rerender(page(undefined, 'wo2616-new-document'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toBe('Ready'))
    expect(failureLines()).toHaveLength(1)
    expect(failureLines()[0][1]).toMatchObject({ message: 'The geometry client was closed.' })
    expect(first.client.terminate).toHaveBeenCalledTimes(1)
  })

  it('retains the real old-document failure after a replacement document reaches Ready', async () => {
    const first = pendingClient()
    const second = readyClient()
    const create = vi.fn<() => GeomClient>().mockReturnValueOnce(first.client).mockReturnValueOnce(second)
    const view = render(page(create, 'wo2616-old-rejection'))
    view.rerender(page(create, 'wo2616-new-ready'))
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toBe('Ready'))
    const error = new Error('old document native initialization rejected')
    await act(async () => { first.reject(error) })
    expect(failureLines()).toHaveLength(1)
    expect(failureLines()[0][1]).toBe(error)
    expect(first.client.terminate).toHaveBeenCalledTimes(1)
  })
})
