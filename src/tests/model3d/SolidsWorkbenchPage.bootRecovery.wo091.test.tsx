// @vitest-environment jsdom

// WO-091: the geometry kernel must load, or the app must fix it ITSELF.
//
// Operator's ruling (2026-08-08): "we really shouldn't have to have a retry button
// to get it to do the thing they asked it to do ... it needs to either not have
// that happen or know that it's happened and resolve it itself."
//
// So every test here drives recovery with ZERO user input. There is no click,
// no button query that expects a hit, and no test that would still pass if the
// app merely OFFERED to recover. The page is given a boot policy in
// milliseconds so the REAL deadline/backoff/retry loop runs -- these are not
// fakes of the recovery, they are the recovery.
//
// Supersedes SolidsWorkbenchPage.bootFailure.wo085.test.tsx, which asserted the
// Retry button that this WO removes (and whose third case could not fail; see
// the concurrency test at the bottom for the honest version of it).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage } from '../../components/model3d'
import type { GeomClient } from '../../geom'
import type { KernelInfo } from '../../geom/geom-service'
import type { Sketch3dSolveService } from '../../sketch3d/solveService'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'

const FAKE_KERNEL_INFO: KernelInfo = {
  backend: 'occt-wasm',
  occtVersion: 'fake-0.0',
  capabilities: { defeature: false, xcaf: false, hlr: false },
}

/** Millisecond-scale mirror of the production policy: three attempts, a real
 *  deadline, a real backoff. Small enough to run in a unit test, structurally
 *  identical to what ships. */
const FAST_POLICY = { timeoutMs: 25, maxAttempts: 3, backoffMs: [1, 1] } as const

const EXHAUSTED_STATUS =
  'The 3D geometry engine did not load after 3 attempts. Reloading the page usually fixes this.'

function statusText(): string {
  return screen.getByTestId('solids-workbench-status').textContent ?? ''
}

function solverText(): string | null {
  return screen.queryByTestId('solids-workbench-solver-state')?.textContent ?? null
}

function fakeSolveService(): Sketch3dSolveService {
  return { dispose: () => undefined } as unknown as Sketch3dSolveService
}

/** A client whose init() never settles -- the hang this WO exists to kill. */
function hangingClient(phase = 'compiling geometry', pct = 42) {
  const client = createFakeGeomClient()
  let settle: ((info: KernelInfo) => void) | undefined
  let reportProgress: ((pct: number, phase: string) => void) | undefined
  client.init = (onProgress) => {
    reportProgress = onProgress
    onProgress?.(pct, phase)
    return new Promise<KernelInfo>((resolve) => { settle = resolve })
  }
  return {
    client,
    resolveLate: (): void => settle?.(FAKE_KERNEL_INFO),
    reportLateProgress: (p: number, ph: string): void => reportProgress?.(p, ph),
  }
}

/** A client whose init() rejects immediately -- the DOCUMENTED failure shape:
 *  a Vite dep-optimizer hash that no longer exists, so the worker's module
 *  import 404s and the load fails in milliseconds rather than hanging. */
function rejectingClient(message = 'Failed to fetch dynamically imported module: occt-wasm-abc123.js') {
  const client = createFakeGeomClient()
  client.init = async (onProgress) => {
    onProgress?.(73, 'geom:loading-wasm')
    throw new Error(message)
  }
  return client
}

/** Hand the page a scripted sequence of clients and record how many it asked
 *  for and which it tore down. `terminate` is the tell that a failed attempt
 *  was actually disposed rather than leaked. */
function clientFactory(clients: GeomClient[]) {
  const terminated: GeomClient[] = []
  const handed: GeomClient[] = []
  const create = vi.fn((): GeomClient => {
    const next = clients[handed.length]
    if (next === undefined) throw new Error(`unexpected boot attempt ${handed.length + 1}`)
    handed.push(next)
    const inner = next.terminate.bind(next)
    next.terminate = async () => { terminated.push(next); await inner() }
    return next
  })
  return { create, terminated, handed }
}

let splashProgress: Array<{ pct: number; phase: string }> = []

beforeEach(() => {
  splashProgress = []
  window.LienSplash = {
    ready: () => undefined,
    setProgress: (pct: number, phase: string) => { splashProgress.push({ pct, phase }) },
  }
})

afterEach(() => {
  cleanup()
  delete window.LienSplash
  vi.restoreAllMocks()
})

describe('WO-091 geometry kernel boots or the app fixes it itself', () => {
  it('recovers from a HUNG kernel load with a fresh worker and NO user input', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const first = hangingClient()
    const second = createFakeGeomClient()
    const factory = clientFactory([first.client, second])

    render(
      <SolidsWorkbenchPage
        createClient={factory.create}
        createSceneRuntime={fakeCreateSceneRuntime}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    // Nobody clicks anything between here and Ready. That is the whole point.
    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })

    expect(factory.create).toHaveBeenCalledTimes(2)
    // The hung attempt was TORN DOWN, not merely dropped: leaving a wedged
    // worker alive for the life of the tab is the other half of this bug.
    expect(factory.terminated).toEqual([first.client])
    expect(second.initCallCount).toBe(1)
    expect(errors).toHaveBeenCalledWith(
      expect.stringMatching(
        /^SolidsWorkbenchPage: 3D geometry engine initialization failed \(attempt 1 of 3\); phase=compiling geometry; progress=42%; elapsed=\d+ms$/,
      ),
      expect.objectContaining({ message: 'geometry engine initialization timed out after 25ms' }),
    )
  })

  it('recovers from a REJECTED kernel load (the documented stale-hash shape) with no user input', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const first = rejectingClient()
    const second = createFakeGeomClient()
    const factory = clientFactory([first, second])

    render(
      <SolidsWorkbenchPage
        createClient={factory.create}
        createSceneRuntime={fakeCreateSceneRuntime}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })
    expect(factory.create).toHaveBeenCalledTimes(2)
  })

  it('uses its whole attempt budget before giving up, and shows an honest status - never a false Ready', async () => {
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const factory = clientFactory([rejectingClient(), rejectingClient(), rejectingClient()])

    render(
      <SolidsWorkbenchPage
        createClient={factory.create}
        createSceneRuntime={fakeCreateSceneRuntime}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    await waitFor(() => { expect(statusText()).toBe(EXHAUSTED_STATUS) }, { timeout: 4_000 })

    expect(factory.create).toHaveBeenCalledTimes(3)
    // WO-108 finding 2: counting three CREATIONS is not the same as proving
    // three teardowns, and this test used to stop at the count. The third
    // worker had no attempt-4 to clean up after it, so it was left running for
    // the life of the tab -- invisible to this file until the assertion below
    // existed. All three, not "at least one".
    expect(factory.terminated).toEqual(factory.handed)
    expect(statusText()).not.toMatch(/ready/i)
    // A workbench that claims to be Ready without a kernel is worse than an
    // honest failure, because the user will act on the claim.
    expect(statusText()).not.toBe('initializing geometry kernel...')
    // Every attempt left a diagnostic, numbered, so a recurrence is countable.
    for (const attempt of [1, 2, 3]) {
      expect(errors).toHaveBeenCalledWith(
        expect.stringContaining(`initialization failed (attempt ${attempt} of 3)`),
        expect.anything(),
      )
    }
  })

  it('offers NO retry control at any point - not while working, not after giving up', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const factory = clientFactory([rejectingClient(), rejectingClient(), rejectingClient()])

    render(
      <SolidsWorkbenchPage
        createClient={factory.create}
        createSceneRuntime={fakeCreateSceneRuntime}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    await waitFor(() => { expect(statusText()).toBe(EXHAUSTED_STATUS) }, { timeout: 4_000 })

    expect(screen.queryByTestId('solids-workbench-retry')).toBeNull()
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull()
  })

  it('writes the diagnostic even when the user gives up and navigates away first', async () => {
    // WO-091 item 5. This is the LIKELY case, not an edge case: Operator has waited
    // on a hung Model tab and then acted, twice. The diagnostic used to sit
    // behind `if (!ownsBoot()) return`, so unmounting threw away exactly the
    // recurrences it was written to capture.
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const first = hangingClient('geom:loading-wasm', 10)
    const factory = clientFactory([first.client, createFakeGeomClient(), createFakeGeomClient()])

    const view = render(
      <SolidsWorkbenchPage
        createClient={factory.create}
        createSceneRuntime={fakeCreateSceneRuntime}
        geometryBootPolicy={{ timeoutMs: 60, maxAttempts: 3, backoffMs: [1, 1] }}
      />,
    )
    await waitFor(() => { expect(statusText()).toBe('initializing geometry kernel...') })

    // The user walks away while the kernel is still hung. (jsdom's own
    // getContext() complaints also land on console.error, so count only OUR
    // line -- it has not been written yet, which is what makes the wait below
    // a real observation rather than a lucky read.)
    const bootFailureLines = (): unknown[] => errors.mock.calls
      .filter(([first]) => typeof first === 'string' && first.includes('3D geometry engine initialization failed'))
    view.unmount()
    expect(bootFailureLines()).toHaveLength(0)

    await waitFor(() => {
      expect(errors).toHaveBeenCalledWith(
        expect.stringMatching(
          /^SolidsWorkbenchPage: 3D geometry engine initialization failed \(attempt 1 of 3\); phase=geom:loading-wasm; progress=10%; elapsed=\d+ms$/,
        ),
        expect.objectContaining({ message: 'geometry engine initialization timed out after 60ms' }),
      )
    }, { timeout: 4_000 })

    // Ownership is still respected for STATE: the unmounted page starts no
    // second attempt. Only the log survives the walk-away.
    expect(factory.create).toHaveBeenCalledTimes(1)
  })

  it('never shows a frozen string: a slow attempt counts elapsed seconds, a fast one shows no timer', async () => {
    // The real-browser capture (src/tests/evidence/WO-085/wo091-capture.mjs)
    // measured 30s of an UNCHANGING "initializing geometry kernel..." when the
    // payload fetch wedges the worker -- visually identical to the hang this WO
    // exists to kill. "Still working" has to look different from "dead".
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const slow = hangingClient()
    const factory = clientFactory([slow.client, createFakeGeomClient()])

    render(
      <SolidsWorkbenchPage
        createClient={factory.create}
        createSceneRuntime={fakeCreateSceneRuntime}
        geometryBootPolicy={{
          timeoutMs: 2_000, maxAttempts: 2, backoffMs: [1],
          statusTickAfterMs: 20, statusTickEveryMs: 5,
        }}
      />,
    )

    await waitFor(() => {
      expect(statusText()).toMatch(/^initializing geometry kernel\.\.\. \(\d+s\)$/)
    }, { timeout: 4_000 })

    // ...and it keeps moving rather than sticking on the first tick.
    const first = statusText()
    await waitFor(() => { expect(statusText()).not.toBe(first) }, { timeout: 4_000 })
  })

  it('shows no elapsed timer at all on a boot that succeeds promptly', async () => {
    const factory = clientFactory([createFakeGeomClient()])
    render(
      <SolidsWorkbenchPage
        createClient={factory.create}
        createSceneRuntime={fakeCreateSceneRuntime}
        geometryBootPolicy={FAST_POLICY}
      />,
    )
    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })
    expect(statusText()).not.toMatch(/\(\d+s\)/)
  })

  it('keeps Ready honest while a bounded solver failure retries and recovers without input', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let calls = 0
    const createSolveService = (): Promise<Sketch3dSolveService> => {
      calls++
      if (calls === 1) {
        return new Promise((_resolve, reject) => {
          setTimeout(() => reject(new Error('planegcs wasm module load timed out after 25ms')), 30)
        })
      }
      return Promise.resolve(fakeSolveService())
    }

    render(
      <SolidsWorkbenchPage
        createClient={() => createFakeGeomClient()}
        createSceneRuntime={fakeCreateSceneRuntime}
        createSolveService={createSolveService}
        geometryBootPolicy={{
          timeoutMs: 100,
          maxAttempts: 2,
          backoffMs: [30],
          statusTickAfterMs: 5,
          statusTickEveryMs: 5,
        }}
      />,
    )

    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })
    expect(statusText()).not.toMatch(/initializing geometry kernel/i)
    await waitFor(() => { expect(solverText()).toMatch(/^sketch solver: loading\.\.\. \(\d+s\)$/) }, { timeout: 4_000 })
    await waitFor(() => { expect(solverText()).toBeNull() }, { timeout: 4_000 })
    expect(calls).toBe(2)
    expect(screen.queryByRole('button', { name: /retry|try again/i })).toBeNull()
  })

  it('does not let an abandoned attempt talk over the one that succeeded', async () => {
    // WO-091 item 7c, the honest version. The superseded case is only real if
    // the abandoned attempt is STILL LIVE and still emitting when the winner
    // lands -- which is exactly what an abandoned Comlink worker does, because
    // nothing about a timeout cancels the work on the other thread.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const first = hangingClient('compiling geometry', 42)
    const second = createFakeGeomClient()
    second.init = async (onProgress) => {
      onProgress?.(100, 'geom:ready')
      return FAKE_KERNEL_INFO
    }
    const factory = clientFactory([first.client, second])

    render(
      <SolidsWorkbenchPage
        createClient={factory.create}
        createSceneRuntime={fakeCreateSceneRuntime}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })
    const progressAtReady = [...splashProgress]
    expect(progressAtReady.at(-1)).toEqual({ pct: 100, phase: 'geom:ready' })

    // The abandoned worker is still running and reports again, late.
    first.reportLateProgress(55, 'compiling geometry')
    first.resolveLate()
    await Promise.resolve()
    await Promise.resolve()

    // It must not drive the splash backwards, and it must not disturb Ready.
    expect(splashProgress).toEqual(progressAtReady)
    expect(statusText()).toBe('Ready')
    expect(factory.create).toHaveBeenCalledTimes(2)
  })
})
