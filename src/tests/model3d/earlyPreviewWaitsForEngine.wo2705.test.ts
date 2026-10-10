// @vitest-environment jsdom
import { typedMock } from '../support/typedMock'
import { createElement } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { GeomClient } from '../../geom'
import type { KernelInfo } from '../../geom/geom-service'
import { SolidsWorkbenchPage, abandonableGeomClient } from '../../components/model3d/SolidsWorkbenchPage'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { mintRectangleSketch } from './mintRectangleSketch'
import { stubCanvas2d } from './stubCanvas2d'

// Keep the production factory identity, so the page exercises its real
// worker-client wrapper. Only the worker transport is replaced.
const transport = vi.hoisted(() => ({ create: vi.fn<() => GeomClient>() }))
vi.mock('../../geom', async (original) => typedMock<typeof import('../../geom')>({
  ...await original<typeof import('../../geom')>(),
  createGeomService: () => transport.create(),
}))

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: Error) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function coldClient() {
  const client = createFakeGeomClient()
  const boot = deferred<KernelInfo>()
  const info = client.init()
  let ready = false
  client.init = vi.fn(async () => {
    const result = await boot.promise
    ready = true
    return result
  })
  const extrude = client.makeExtrude.bind(client)
  client.makeExtrude = vi.fn(async (request) => {
    if (!ready) throw new Error('GeomEngine.init() has not completed')
    return extrude(request)
  })
  client.terminate = vi.fn(async () => undefined)
  return { client, boot, load: async () => boot.resolve(await info) }
}

let restoreCanvas: () => void
beforeEach(() => {
  restoreCanvas = stubCanvas2d()
  transport.create.mockReset()
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
})
afterEach(() => {
  cleanup()
  restoreCanvas()
  vi.restoreAllMocks()
})

function mount() {
  const runtime = createFakeSceneRuntime()
  const view = render(createElement(SolidsWorkbenchPage, {
    createSceneRuntime: () => runtime,
    geometryBootPolicy: { timeoutMs: 10_000, maxAttempts: 1 },
  }))
  return { ...view, runtime }
}

async function openEarlyExtrude() {
  await act(async () => { await mintRectangleSketch() })
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  await waitFor(() => expect(screen.getByTestId('extrude-preview-status')).toBeTruthy())
  // Drain preview/replay microtasks without resolving init.
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)) })
}

const previewStatus = () => screen.getByTestId('extrude-preview-status').getAttribute('data-status')

describe('WO-2705 early preview through the production page client', () => {
  it('waits before RPC, paints the preview after init, and Apply commits once', async () => {
    const cold = coldClient()
    transport.create.mockReturnValue(cold.client)
    const { runtime } = mount()
    await openEarlyExtrude()
    expect(previewStatus()).toBe('pending')
    expect(cold.client.makeExtrude).not.toHaveBeenCalled()
    const hooks = window.__solidsWorkbenchHooks!
    const historyBefore = hooks.history.size()
    await act(cold.load)
    await waitFor(() => expect(previewStatus()).toBe('ready'))
    expect(runtime.addedObjects.some((object) => object.userData.workbenchFeatureId === '__extrude-preview__')).toBe(true)
    expect(hooks.dag.has('F1')).toBe(false)
    expect(hooks.history.size()).toBe(historyBefore)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks.getBodyHandle('F1')).toBeDefined())
    expect(hooks.history.size()).toBe(historyBefore + 1)
    expect(cold.client.init).toHaveBeenCalledTimes(1)
  })

  it('recovers the same early dialog after init without another preview request', async () => {
    const cold = coldClient()
    transport.create.mockReturnValue(cold.client)
    mount()
    await openEarlyExtrude()
    await act(cold.load)
    await waitFor(() => expect(previewStatus()).toBe('ready'))
    expect(screen.getByTestId('dialog-shell-apply').hasAttribute('disabled')).toBe(false)
    expect(cold.client.makeExtrude).toHaveBeenCalledTimes(1)
  })

  it('settles waiting calls with the actual timeout reason when boot hangs', async () => {
    const cold = coldClient()
    const boxSpy = vi.spyOn(cold.client, 'makeBox')
    transport.create.mockReturnValue(cold.client)
    render(createElement(SolidsWorkbenchPage, {
      createSceneRuntime: () => createFakeSceneRuntime(),
      geometryBootPolicy: { timeoutMs: 50, maxAttempts: 1 },
    }))
    const result = window.__solidsWorkbenchHooks!.client.makeBox('F1', { x: 1, y: 1, z: 1 })
      .then(() => 'resolved', (error: Error) => error.message)
    await expect(result).resolves.toContain('initialization timed out after 50ms')
    await expect(result).resolves.toMatch(/reload/i)
    expect(boxSpy).not.toHaveBeenCalled()
    await waitFor(() => expect(cold.client.terminate).toHaveBeenCalledTimes(1))
  })

  it('settles page-client calls on unmount, including a late init completion', async () => {
    const cold = coldClient()
    transport.create.mockReturnValue(cold.client)
    const view = mount()
    const client = window.__solidsWorkbenchHooks!.client
    const result = client.makeBox('F1', { x: 1, y: 1, z: 1 }).then(() => 'resolved', (error: Error) => error.message)
    view.unmount()
    await expect(result).resolves.toMatch(/closed|retired|terminated/)
    await cold.load()
    await expect(client.makeBox('F2', { x: 1, y: 1, z: 1 })).rejects.toThrow(/closed|retired|terminated/)
    expect(cold.client.terminate).toHaveBeenCalledTimes(1)
  }, 3_000)

  it('settles a pending preview with the init failure reason and a reload step', async () => {
    const cold = coldClient()
    transport.create.mockReturnValue(cold.client)
    mount()
    await openEarlyExtrude()
    await act(async () => { cold.boot.reject(new Error('geometry asset fetch failed')) })
    await waitFor(() => expect(previewStatus()).toBe('refused'))
    expect(screen.getByTestId('extrude-preview-status').textContent).toContain('geometry asset fetch failed')
    expect(screen.getByTestId('extrude-preview-status').textContent).toMatch(/reload/i)
    expect(screen.getByTestId('extrude-preview-status').textContent).not.toContain('init() has not completed')
    expect(cold.client.makeExtrude).not.toHaveBeenCalled()
    await waitFor(() => expect(cold.client.terminate).toHaveBeenCalledTimes(1))
  })

  it('Cancel rejects the old operation with its cancellation reason and gates the fresh worker', async () => {
    const first = coldClient()
    const second = coldClient()
    transport.create.mockReturnValueOnce(first.client).mockReturnValueOnce(second.client)
    mount()
    await act(first.load)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toBe('Ready'))
    first.client.makeBox = vi.fn(() => new Promise<never>(() => undefined))
    const old = window.__solidsWorkbenchHooks!.client
    const outcome = old.makeBox('F1', { x: 1, y: 1, z: 1 }).catch((error: Error) => error.message)
    await waitFor(() => expect(screen.getByTestId('workbench-kernel-cancel')).toBeTruthy(), { timeout: 4_000 })
    fireEvent.click(screen.getByTestId('workbench-kernel-cancel'))
    await expect(outcome).resolves.toBe('the operation was cancelled')
    expect(transport.create).toHaveBeenCalledTimes(2)
    const boxSpy = vi.spyOn(second.client, 'makeBox')
    const replacement = window.__solidsWorkbenchHooks!.client.makeBox('F2', { x: 1, y: 1, z: 1 })
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)) })
    expect(boxSpy).not.toHaveBeenCalled()
    await act(second.load)
    await expect(replacement).resolves.toMatchObject({ ok: true })
    expect(first.client.terminate).toHaveBeenCalledTimes(1)
  })

  it('gates a replacement client during automatic boot recovery', async () => {
    const first = coldClient()
    const second = coldClient()
    transport.create.mockReturnValueOnce(first.client).mockReturnValueOnce(second.client)
    const runtime = createFakeSceneRuntime()
    render(createElement(SolidsWorkbenchPage, {
      createSceneRuntime: () => runtime,
      geometryBootPolicy: { timeoutMs: 10_000, maxAttempts: 2, backoffMs: [0] },
    }))
    await act(async () => { first.boot.reject(new Error('first asset fetch failed')) })
    await waitFor(() => expect(transport.create).toHaveBeenCalledTimes(2))
    await openEarlyExtrude()
    expect(previewStatus()).toBe('pending')
    expect(second.client.makeExtrude).not.toHaveBeenCalled()
    await act(second.load)
    await waitFor(() => expect(previewStatus()).toBe('ready'))
    expect(first.client.terminate).toHaveBeenCalledTimes(1)
  })
})

// Controls for wrapper lifecycle; the page cases above are application truth.
describe('WO-2705 readiness lifecycle controls', () => {
  it('terminate settles waiting init and RPC once and prevents late work', async () => {
    const cold = coldClient()
    const client = abandonableGeomClient(cold.client, { gateUntilInit: true })
    const init = client.init().catch((error: Error) => error.message)
    const box = client.makeBox('F1', { x: 1, y: 1, z: 1 }).catch((error: Error) => error.message)
    await client.terminate()
    await expect(init).resolves.toMatch(/closed|retired|terminated/)
    await expect(box).resolves.toMatch(/closed|retired|terminated/)
    client.abandon('cancelled again')
    await client.terminate()
    await cold.load()
    expect(client.busySince()).toBeNull()
    expect(cold.client.terminate).toHaveBeenCalledTimes(1)
    await expect(client.makeBox('F2', { x: 1, y: 1, z: 1 })).rejects.toThrow(/closed|retired|terminated/)
  }, 3_000)

  it('settles a gated running call when terminated after init', async () => {
    const cold = coldClient()
    const client = abandonableGeomClient(cold.client, { gateUntilInit: true })
    const init = client.init()
    await cold.load()
    await init
    const stuck = deferred<never>()
    cold.client.makeBox = vi.fn(() => stuck.promise)
    const result = client.makeBox('F1', { x: 1, y: 1, z: 1 }).catch((error: Error) => error.message)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(cold.client.makeBox).toHaveBeenCalledTimes(1)
    await client.terminate()
    await expect(result).resolves.toMatch(/closed|terminated/)
    expect(client.busySince()).toBeNull()
  }, 3_000)

  it('failed init without an existing waiter also rejects later calls with its reason', async () => {
    const cold = coldClient()
    const boxSpy = vi.spyOn(cold.client, 'makeBox')
    const client = abandonableGeomClient(cold.client, { gateUntilInit: true })
    const init = client.init().catch((error: Error) => error.message)
    cold.boot.reject(new Error('WASM compilation failed'))
    await expect(init).resolves.toBe('WASM compilation failed')
    await expect(client.makeBox('F1', { x: 1, y: 1, z: 1 })).rejects.toThrow('WASM compilation failed')
    expect(boxSpy).not.toHaveBeenCalled()
    await client.terminate()
  }, 3_000)

  it('abandon before init releases gated calls without executing them', async () => {
    const cold = coldClient()
    const boxSpy = vi.spyOn(cold.client, 'makeBox')
    const client = abandonableGeomClient(cold.client, { gateUntilInit: true })
    const box = client.makeBox('F1', { x: 1, y: 1, z: 1 }).catch((error: Error) => error.message)
    client.abandon('the operation was cancelled')
    await expect(box).resolves.toBe('the operation was cancelled')
    await client.terminate()
    expect(boxSpy).not.toHaveBeenCalled()
    expect(client.busySince()).toBeNull()
  })
})
