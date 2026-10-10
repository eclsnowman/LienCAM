// @vitest-environment jsdom

// WO-108 finding 1: READY MUST NOT WAIT ON THE SOLVER.
//
// WO-091 bounded the geometry kernel's hang and recovered from it. It left the
// half next door untouched: `boot()` awaited `bootConstraintSolver()` before
// calling `LienSplash.ready()` or setting Ready. So when the constraint
// solver's wasm fetch hung, the workbench sat for the loader's full 30-SECOND
// deadline showing the literal string `initializing geometry kernel...` -- a
// string that had already stopped being true, because the geometry kernel was
// live and the workbench underneath was fully rendered and usable.
//
// That is not a hypothesis. src/tests/evidence/WO-091/wo091-solver-hang-RED.png
// is a real-browser capture of it: design tree, datum planes, viewport and the
// entire modeling toolbar all drawn, under a status line claiming the geometry
// kernel is still initializing. The measurements are in
// wo091-solver-hang-RED.json -- geom:ready at 6395ms, the same status string
// unchanged for 30284ms, Ready 30034ms after the kernel was live.
//
// The three rules these tests encode, from WO-108's acceptance:
//
//   1. Ready is gated on the GEOMETRY KERNEL, which is what the workbench needs
//      to render and model. Not on the solver, which is optional by design and
//      already has a degraded mode.
//   2. Never claim a capability that is not there. If the solver is loading or
//      dead, the page SAYS SO, specifically, and names the consequence.
//   3. The status is never stale. No string that describes a step that already
//      finished, and nothing that stops moving while work is outstanding.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage } from '../../components/model3d'
import type { Sketch3dSolveService } from '../../sketch3d/solveService'
import { createFakeGeomClient } from './fakeGeomClient'
import { fakeCreateSceneRuntime } from './fakeSceneRuntime'

/** Fast enough to run in a unit test, structurally identical to production:
 *  a real deadline, a real backoff, a real elapsed tick. */
const FAST_POLICY = {
  timeoutMs: 200,
  maxAttempts: 3,
  backoffMs: [1, 1],
  statusTickAfterMs: 20,
  statusTickEveryMs: 5,
} as const

function statusText(): string {
  return screen.getByTestId('solids-workbench-status').textContent ?? ''
}

function solverText(): string | null {
  return screen.queryByTestId('solids-workbench-solver-state')?.textContent ?? null
}

/** A solve service that is inert: the workbench only holds it and disposes it. */
function fakeSolveService(): Sketch3dSolveService {
  return { dispose: () => undefined } as unknown as Sketch3dSolveService
}

/** A solver boot that never settles -- Operator's shape, and the one the real
 *  browser capture reproduced. Nothing about a pending wasm fetch cancels. */
function hangingSolver() {
  let calls = 0
  return {
    create: (): Promise<Sketch3dSolveService> => { calls++; return new Promise<Sketch3dSolveService>(() => {}) },
    get callCount() { return calls },
  }
}

/** A solver boot that rejects the way a dead asset does: in milliseconds. */
function failingSolver(message = 'planegcs wasm module load timed out after 30000ms') {
  let calls = 0
  return {
    create: async (): Promise<Sketch3dSolveService> => { calls++; throw new Error(message) },
    get callCount() { return calls },
  }
}

let splashReadyAt: number | null = null
let bootStartedAt = 0

beforeEach(() => {
  splashReadyAt = null
  bootStartedAt = Date.now()
  window.LienSplash = {
    ready: () => { if (splashReadyAt === null) splashReadyAt = Date.now() - bootStartedAt },
    setProgress: () => undefined,
  }
})

afterEach(() => {
  cleanup()
  delete window.LienSplash
  vi.restoreAllMocks()
})

describe('WO-108: the workbench is Ready when the GEOMETRY KERNEL is live', () => {
  it('reaches Ready while a HUNG solver is still outstanding, instead of waiting out its deadline', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const solver = hangingSolver()

    render(
      <SolidsWorkbenchPage
        createClient={() => createFakeGeomClient()}
        createSceneRuntime={fakeCreateSceneRuntime}
        createSolveService={solver.create}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    // The solver never settles. If Ready is gated on it, this wait is the
    // 30-second freeze in miniature and times out.
    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })
    expect(solver.callCount).toBeGreaterThan(0)
    expect(splashReadyAt).not.toBeNull()
  })

  it('never leaves a geometry-kernel string on screen once the kernel is live', async () => {
    // The exact lie the browser capture caught: `initializing geometry
    // kernel...` still on the strip 30s after geom:ready.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const solver = hangingSolver()

    render(
      <SolidsWorkbenchPage
        createClient={() => createFakeGeomClient()}
        createSceneRuntime={fakeCreateSceneRuntime}
        createSolveService={solver.create}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })

    // Hold it under observation while the solver stays hung. The string must
    // not drift back to a step that finished.
    for (let i = 0; i < 5; i++) {
      await new Promise((r) => { setTimeout(r, 20) })
      expect(statusText()).not.toMatch(/initializing geometry kernel/i)
      expect(statusText()).toBe('Ready')
    }
  })

  it('SAYS the solver is still loading, names it, and keeps the message moving', async () => {
    // Ready without a solver is only honest if the gap is disclosed. A silent
    // Ready that cannot solve a constraint is the same false Ready in a
    // different costume (WO-108 acceptance).
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const solver = hangingSolver()

    render(
      <SolidsWorkbenchPage
        createClient={() => createFakeGeomClient()}
        createSceneRuntime={fakeCreateSceneRuntime}
        createSolveService={solver.create}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })
    await waitFor(() => { expect(solverText()).toMatch(/sketch solver/i) }, { timeout: 4_000 })
    expect(solverText()).toMatch(/loading/i)

    // ...and it does not freeze: a message that stops moving while work is
    // outstanding is indistinguishable from a dead one.
    await waitFor(() => { expect(solverText()).toMatch(/\(\d+s\)$/) }, { timeout: 4_000 })
    const first = solverText()
    await waitFor(() => { expect(solverText()).not.toBe(first) }, { timeout: 4_000 })
  })

  it('SAYS the solver is unavailable, and names the consequence, once its own attempts are spent', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const solver = failingSolver()

    render(
      <SolidsWorkbenchPage
        createClient={() => createFakeGeomClient()}
        createSceneRuntime={fakeCreateSceneRuntime}
        createSolveService={solver.create}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })
    await waitFor(() => { expect(solverText()).toMatch(/sketch solver unavailable/i) }, { timeout: 4_000 })
    // Not just "it broke" -- what it means for the work in front of the user.
    expect(solverText()).toMatch(/as drawn/i)
    // Every attempt was a genuine one, not a re-await of the first corpse.
    expect(solver.callCount).toBe(FAST_POLICY.maxAttempts)
    // The geometry kernel is untouched by the solver's failure.
    expect(statusText()).toBe('Ready')
  })

  it('says NOTHING about the solver when the solver is fine', async () => {
    // A permanent badge is noise, and noise is how a real warning gets ignored.
    render(
      <SolidsWorkbenchPage
        createClient={() => createFakeGeomClient()}
        createSceneRuntime={fakeCreateSceneRuntime}
        createSolveService={async () => fakeSolveService()}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })
    await waitFor(() => { expect(solverText()).toBeNull() }, { timeout: 4_000 })
  })

  it('recovers a failed solver on its own, behind an already-usable workbench', async () => {
    // WO-091's bounded-recovery ruling, applied to the optional half: the user
    // is never asked to press anything, and the disclosure clears itself.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    let calls = 0
    const create = async (): Promise<Sketch3dSolveService> => {
      calls++
      if (calls === 1) throw new Error('planegcs wasm module load timed out after 30000ms')
      return fakeSolveService()
    }

    render(
      <SolidsWorkbenchPage
        createClient={() => createFakeGeomClient()}
        createSceneRuntime={fakeCreateSceneRuntime}
        createSolveService={create}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    await waitFor(() => { expect(statusText()).toBe('Ready') }, { timeout: 4_000 })
    await waitFor(() => { expect(solverText()).toBeNull() }, { timeout: 4_000 })
    expect(calls).toBe(2)
    // Nothing was clicked. There is no control to click.
    expect(screen.queryByRole('button', { name: /retry/i })).toBeNull()
  })

  it('still refuses a FALSE Ready when the geometry kernel is the thing that died', async () => {
    // The other direction of the same rule: decoupling the solver must not
    // weaken the gate that matters. A workbench with no kernel is not Ready.
    vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const create = (): ReturnType<typeof createFakeGeomClient> => {
      const client = createFakeGeomClient()
      client.init = async () => { throw new Error('Failed to fetch dynamically imported module') }
      return client
    }

    render(
      <SolidsWorkbenchPage
        createClient={create}
        createSceneRuntime={fakeCreateSceneRuntime}
        createSolveService={async () => fakeSolveService()}
        geometryBootPolicy={FAST_POLICY}
      />,
    )

    await waitFor(() => {
      expect(statusText()).toMatch(/^The 3D geometry engine did not load after 3 attempts/)
    }, { timeout: 4_000 })
    expect(statusText()).not.toMatch(/\bready\b/i)
    expect(splashReadyAt).toBeNull()
  })
})
