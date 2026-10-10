// @vitest-environment jsdom
//
// WO INT-18 (F-6 residual, INT-15's disclosed symmetric part-host leak): CONSTRUCTED
// INTERLEAVE can-fail test for the bare-N new-sketch/look-normal-to arm listener
// (SolidsWorkbenchPage.tsx, the `nPickArmed` arm effect). INT-15 workspace-scoped the
// CAM-host + sketcher window key listeners (F-1..F-5) but ruled this ONE part-host
// listener 'exempt:F-6-residual-part-host-leak' -- its guard checked only sibling
// tool sub-modes (all cleared by disarmActiveTool on suspend), never `suspended`
// itself, so a bare N press with every sub-mode at rest could still arm nPickArmed
// while the Part workspace is hidden (display:none) and the CAM workspace is the one
// visibly active.
//
// WHY THIS FILE MOUNTS THE PAGE DIRECTLY (same reasoning as
// SolidsWorkbenchPage.suspendResume.int13b.test.tsx:8-16, RECON-3 re-verified this
// session): App renders SolidsWorkbenchPage lazily with no injection seam, so a full
// <App/> mount would need a real occt-wasm kernel and a real WebGL context. The page
// is mounted `embedded` with the fake kernel + fake runtime instead, and suspension is
// driven through the REAL store action (`setWorkspace`) the Part/Setup tabs dispatch --
// not by poking a prop.

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createFakeGeomClient } from './fakeGeomClient'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import type { CreateSceneRuntime } from '../../components/model3d/sceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { sketcherToolStore } from '../../lib/sketch/sketcher'
import { sketcherMenuStore } from '../../lib/sketch/sketcher/overlays/menuStore'
import { useCamStore } from '../../store'

afterEach(cleanup)

// Same module-scope localStorage shim as the sibling suspend/resume file (:44-71) --
// the persist()-wrapped store resolves localStorage once at module init.
vi.hoisted(() => {
  const m = new Map<string, string>()
  const memStorage: Storage = {
    get length() {
      return m.size
    },
    clear: () => m.clear(),
    getItem: (k: string) => (m.has(k) ? m.get(k)! : null),
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => {
      m.delete(k)
    },
    setItem: (k: string, v: string) => {
      m.set(k, String(v))
    },
  }
  Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })
})

let restoreCanvas2d: (() => void) | null = null
beforeEach(() => {
  restoreCanvas2d = stubCanvas2d()
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  useCamStore.getState().newProject()
  // TRAP (per the sibling file): with `embedded` set, `suspended` is TRUE on the very
  // first render while the store sits at its 'cam' default -- boot live so each test
  // controls its own suspend transition explicitly.
  useCamStore.getState().setWorkspace('part')
})
afterEach(() => {
  restoreCanvas2d?.()
  restoreCanvas2d = null
  sketcherToolStore.__reset()
  sketcherMenuStore.__reset()
  useCamStore.setState({ workspace: 'cam' })
})

function suspendWorkspace(): void {
  act(() => {
    useCamStore.getState().setWorkspace('cam')
  })
}
function resumeWorkspace(): void {
  act(() => {
    useCamStore.getState().setWorkspace('part')
  })
}

function pressN(): void {
  act(() => {
    fireEvent.keyDown(window, { key: 'n' })
  })
}

function npickHintVisible(): boolean {
  return screen.queryByTestId('solids-workbench-npick-hint') !== null
}

async function boot(): Promise<FakeSceneRuntime> {
  let captured: FakeSceneRuntime | null = null
  const captureSceneRuntime: CreateSceneRuntime = () => {
    const rt = createFakeSceneRuntime()
    captured = rt
    return rt
  }
  render(<SolidsWorkbenchPage embedded createClient={() => createFakeGeomClient()} createSceneRuntime={captureSceneRuntime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  return captured as unknown as FakeSceneRuntime
}

describe('WO INT-18 (F-6 residual): bare-N arm listener is workspace-scoped on the Part host', () => {
  it('workspace suspended -> N press does NOT arm the look-normal-to pick (no hint bar mounts)', async () => {
    await boot()

    suspendWorkspace()

    pressN()

    // THE F-6 assertion: a bare N press while the Part workspace is hidden must be a
    // no-op. Before this WO's fix, the arm effect's guard only checked sibling tool
    // sub-modes (all 'none' at rest), never `suspended`, so this pressed through and
    // armed nPickArmed silently while the CAM workspace was the one visibly active.
    expect(npickHintVisible()).toBe(false)

    // ...and resuming does not retroactively arm a press that happened while suspended
    // -- the listener was never attached, so no keydown was ever observed.
    resumeWorkspace()
    expect(npickHintVisible()).toBe(false)
  }, 40_000)

  it('workspace active -> N still arms the look-normal-to pick (the fix does not regress the live path)', async () => {
    await boot()

    // Precondition (charter rule 1): the workspace is live (boot() leaves it on 'part').
    pressN()
    expect(npickHintVisible()).toBe(true)
  }, 40_000)

  it('suspend -> resume -> N: the listener re-arms on resume exactly like every INT-15 sibling', async () => {
    await boot()

    suspendWorkspace()
    pressN()
    expect(npickHintVisible()).toBe(false)

    resumeWorkspace()
    pressN()
    expect(npickHintVisible()).toBe(true)
  }, 40_000)
})
