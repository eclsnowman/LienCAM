// @vitest-environment jsdom
//
// WO INT-17C Stage C2: RENDER-GATE regression guard for the "Maximum update
// depth exceeded" crash-loop the C2 recon lane reproduced at HEAD, clicking
// the DesignTree "+" (New Model Item) button in the DEV app (localhost:5173,
// which mounts <App/> inside <StrictMode> -- src/main.tsx:32).
//
// WHY THIS FILE EXISTS AND newModelItem.int17cC1Step6.test.tsx DID NOT CATCH
// IT. That sibling file (and modelItemSwitchAwaySave.int17cC1.test.tsx) both
// render `<App />` bare -- no StrictMode -- so React's dev double-invoke of
// effects (mount -> cleanup -> mount, simulating a future unmount/remount to
// surface non-idempotent effects) never ran. The crash is EXACTLY a
// non-idempotent effect cleanup: registerLiveDocument's unmount cleanup
// (src/doc/documentHolder.ts) used to call clearLoadedDocument/
// stashLoadedDocument -- and therefore bumpGeneration -- unconditionally,
// even when the observed state was identical to what was already held. A
// brand-new Model Item's document is genesis-only (isEmptyDocument), so
// `collect()` returns null on every invocation; StrictMode's simulated
// cleanup ran that null branch once for free, bumping the generation for no
// reason. SolidsWorkbenchPage keys its child on
// `${modelItemId}:${documentGeneration}` (SolidsWorkbenchPage.tsx:1489), so
// that spurious bump remounted the very component whose (StrictMode
// double-invoked) cleanup produced it -- and the fresh mount's own
// StrictMode double-invoke did the same thing again, forever: React's
// "Maximum update depth exceeded" is that loop's own diagnostic for it.
//
// This test mirrors newModelItem.int17cC1Step6.test.tsx's App-level mocking
// precedent exactly, adding ONLY the StrictMode wrapper main.tsx actually
// uses, and drives the literal repro: render the app, click "+". Before the
// fix this either throws synchronously (update-depth) or the console records
// React's error; after the fix the item is created cleanly, exactly like the
// non-StrictMode sibling test already proves.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createElement, StrictMode } from 'react'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))

vi.mock('../../components/model3d/SolidsWorkbenchPage', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../components/model3d/SolidsWorkbenchPage')>()
  const { createFakeGeomClient } = await import('./fakeGeomClient')
  const { fakeCreateSceneRuntime } = await import('./fakeSceneRuntime')
  return typedMock<typeof import('../../components/model3d/SolidsWorkbenchPage')>({
    ...actual,
    SolidsWorkbenchPage: (props: any) =>
      createElement(actual.SolidsWorkbenchPage, {
        ...props,
        createClient: createFakeGeomClient,
        createSceneRuntime: fakeCreateSceneRuntime,
      }),
  })
})

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')

beforeEach(() => {
  window.history.pushState(null, '', '/?partWorkspace=1')
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam' })
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

async function waitReady() {
  await waitFor(() =>
    expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
  { timeout: 10000 })
}

describe('INT-17C Stage C2: New Model Item under StrictMode (dev-mount parity)', () => {
  it('clicking "+" under StrictMode creates the item with no update-depth crash-loop', async () => {
    // The ONLY difference from newModelItem.int17cC1Step6.test.tsx's render
    // call: wrapping in StrictMode, mirroring src/main.tsx's real dev mount
    // exactly (createRoot(...).render(<StrictMode><App/></StrictMode>)).
    render(createElement(StrictMode, null, createElement(App)))

    expect(useCamStore.getState().activeModelItemId).toBeNull()

    // Before the fix this either throws synchronously out of the effect
    // cleanup's cascading setState-in-render loop, or React logs "Maximum
    // update depth exceeded" and the tree never reaches 'ready'. Either way
    // waitReady() below times out/fails; after the fix it resolves normally.
    fireEvent.click(screen.getByTestId('add-model-item-btn'))

    expect(useCamStore.getState().workspace).toBe('part')
    const itemAId = useCamStore.getState().activeModelItemId
    expect(itemAId).not.toBeNull()
    expect(useCamStore.getState().project.modelItems).toHaveLength(1)

    await waitReady()

    // GEO-UNIFY-S1b: the floating banner is gone; the equivalent is now the
    // in-panel model-workspace-header row (ModelWorkspaceHeader.tsx).
    expect(screen.getByTestId('model-workspace-header')).toBeTruthy()

    // The crash-loop's own signature: an exploding, monotonically-growing
    // document generation for the new item. A healthy create settles at a
    // small, stable number instead of climbing without bound.
    const { getDocumentGeneration } = await import('../../doc/documentHolder')
    const generationAfterReady = getDocumentGeneration(itemAId!)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(getDocumentGeneration(itemAId!)).toBe(generationAfterReady)

    fireEvent.click(screen.getByTestId('model-item-finish-btn'))
    expect(useCamStore.getState().workspace).toBe('cam')
    expect(useCamStore.getState().project.modelItems).toHaveLength(1)
  })
})
