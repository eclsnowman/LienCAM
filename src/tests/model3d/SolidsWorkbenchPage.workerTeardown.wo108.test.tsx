// @vitest-environment jsdom

// WO-108 finding 2: A DEAD WORKER MUST DIE.
//
// WO-091 terminated a failed geometry client only when a LATER attempt was
// about to start (`replaceClient()`, called from the retry loop). That leaves
// two holes, and both leak a wedged worker thread for as long as the tab lives:
//
//   EXHAUSTION. When attempt 3 fails there is no attempt 4, so nothing ever
//     calls replaceClient(). The third worker -- the one still spinning on a
//     wasm compile that will never finish -- is simply abandoned.
//
//   UNMOUNT. The cleanup called `client.disposeAll()`, which is an RPC. Asking
//     a worker that never finished loading to answer a message is asking the
//     hung thing to participate in its own cleanup; a worker wedged mid-import
//     never runs the handler, so the promise never settles and the thread stays
//     alive. terminate() does not need the worker to be alive enough to answer.
//     That is the entire point of it.
//
// WO-091's exhaustion test counted three creations and checked the message but
// never asserted the three failed clients were torn down; its only teardown
// assertion covered attempt 1 followed by a SUCCESSFUL retry. So the leak was
// invisible to the suite it shipped with. These assert the real thing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage } from '../../components/model3d'
import type { GeomClient } from '../../geom'
import type { KernelInfo } from '../../geom/geom-service'
import type { Sketch3dSolveService } from '../../sketch3d/solveService'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'

const FAST_POLICY = { timeoutMs: 25, maxAttempts: 3, backoffMs: [1, 1] } as const

const EXHAUSTED_STATUS =
  'The 3D geometry engine did not load after 3 attempts. Reloading the page usually fixes this.'

function statusText(): string {
  return screen.getByTestId('solids-workbench-status').textContent ?? ''
}

const fakeSolveService = (): Sketch3dSolveService =>
  ({ dispose: () => undefined }) as unknown as Sketch3dSolveService

/**
 * Records the ORDER of teardown calls on each client it hands out, so a test
 * can assert not just "terminate happened" but "terminate happened, and the
 * teardown did not first block on an RPC the worker can never answer".
 *
 * `disposeAll` here NEVER SETTLES on the clients marked hung -- which is what a
 * real Comlink call into a wedged worker does. A cleanup path that awaits it
 * before terminating simply never terminates.
 */
function recordingFactory(specs: Array<{ outcome: 'reject' | 'hang' | 'succeed'; hangDisposeAll?: boolean }>) {
  const events: string[] = []
  const handed: GeomClient[] = []
  const terminated: GeomClient[] = []

  const create = vi.fn((): GeomClient => {
    const index = handed.length
    const spec = specs[index]
    if (spec === undefined) throw new Error(`unexpected boot attempt ${index + 1}`)
    const client = createFakeGeomClient()
    const realInit = client.init.bind(client)

    client.init = (onProgress) => {
      onProgress?.(37, 'geom:loading-wasm')
      if (spec.outcome === 'reject') return Promise.reject(new Error('Failed to fetch dynamically imported module'))
      if (spec.outcome === 'hang') return new Promise<KernelInfo>(() => {})
      return realInit(onProgress)
    }
    const innerDisposeAll = client.disposeAll.bind(client)
    client.disposeAll = async (): Promise<void> => {
      events.push(`disposeAll:${index}`)
      // A worker wedged mid-import never runs this handler.
      if (spec.hangDisposeAll === true) return new Promise<void>(() => {})
      return innerDisposeAll()
    }
    client.terminate = async (): Promise<void> => {
      events.push(`terminate:${index}`)
      terminated.push(client)
    }
    handed.push(client)
    return client
  })

  return { create, events, handed, terminated }
}

beforeEach(() => {
  window.LienSplash = { ready: () => undefined, setProgress: () => undefined }
})

afterEach(() => {
  cleanup()
  delete window.LienSplash
  vi.restoreAllMocks()
})

describe('WO-108: a failed geometry worker is terminated, never left running', () => {
  it('terminates ALL THREE failed clients when automatic recovery is exhausted', async () => {
    // The hole WO-091's own exhaustion test could not see: it counted three
    // creations, but the third worker was never torn down at all.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const factory = recordingFactory([{ outcome: 'reject' }, { outcome: 'reject' }, { outcome: 'reject' }])

    render(
      <SolidsWorkbenchPage
        createClient={factory.create}
        createSceneRuntime={fakeCreateSceneRuntime}
        createSolveService={async () => fakeSolveService()}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    await waitFor(() => { expect(statusText()).toBe(EXHAUSTED_STATUS) }, { timeout: 4_000 })
    expect(factory.create).toHaveBeenCalledTimes(3)

    // Every client handed out was terminated -- including the LAST one, which
    // no subsequent attempt exists to clean up after.
    await waitFor(() => {
      expect(factory.terminated).toEqual(factory.handed)
    }, { timeout: 4_000 })
    expect(factory.events).toContain('terminate:2')
  })

  it('terminates the wedged worker on unmount WITHOUT waiting on an RPC it can never answer', async () => {
    // The user gives up on a hung Model tab and navigates away. The worker is
    // mid-import: it will never answer disposeAll(). If teardown depends on
    // that answer, the thread outlives the page.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const factory = recordingFactory([{ outcome: 'hang', hangDisposeAll: true }])

    const view = render(
      <SolidsWorkbenchPage
        createClient={factory.create}
        createSceneRuntime={fakeCreateSceneRuntime}
        createSolveService={async () => fakeSolveService()}
        geometryBootPolicy={{ timeoutMs: 60_000, maxAttempts: 3, backoffMs: [1, 1] }}
      />,
    )
    await waitFor(() => { expect(statusText()).toBe('initializing geometry kernel...') })
    expect(factory.terminated).toHaveLength(0)

    view.unmount()

    // Terminated, synchronously enough that no pending promise stands between
    // the unmount and the thread dying.
    expect(factory.terminated).toEqual(factory.handed)
    // And the teardown did not stake itself on the never-answered RPC: if
    // disposeAll was called at all, terminate came first.
    const disposeAt = factory.events.indexOf('disposeAll:0')
    const terminateAt = factory.events.indexOf('terminate:0')
    expect(terminateAt).toBeGreaterThanOrEqual(0)
    if (disposeAt >= 0) expect(terminateAt).toBeLessThan(disposeAt)
  })

  it('still terminates on unmount after a boot that SUCCEEDED', async () => {
    // The healthy path must not regress into a leak either: a live worker is
    // released when the page goes away, same as a wedged one.
    const factory = recordingFactory([{ outcome: 'succeed' }])

    const view = render(
      <SolidsWorkbenchPage
        createClient={factory.create}
        createSceneRuntime={fakeCreateSceneRuntime}
        createSolveService={async () => fakeSolveService()}
        geometryBootPolicy={FAST_POLICY}
      />,
    )
    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })

    view.unmount()
    expect(factory.terminated).toEqual(factory.handed)
  })
})
