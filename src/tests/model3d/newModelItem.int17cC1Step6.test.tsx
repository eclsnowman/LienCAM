// @vitest-environment jsdom
//
// WO INT-17C Stage C1 step 6 RENDER GATE (standing repo rule: UI/modal
// changes need a real React render smoke test — tsc+vitest-on-pure-logic
// alone misses hooks-order bugs and wiring mistakes a unit test cannot see).
// Mirrors partWorkbenchMount.int13a.test.tsx's own mocking precedent exactly
// (real App, real DesignTree, real SolidsWorkbenchPage; only the worker
// facade and WebGL scene runtime are faked at their existing injection
// seams) — this is the SAME infrastructure the repo already uses to satisfy
// "mount the real page, drive the real command, assert the real tree/
// editing-space states" for the sibling INT-13A Part-Studio-tab surface.
//
// Drives the WO's own Stage C1 acceptance test #1 in UI terms: create Model
// Item A, Finish; create Model Item B, Finish; reopen A; only A is active,
// and the pre-existing legacy Part-Studio flow (no Model Item selected)
// stays visually/behaviorally untouched throughout.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createElement } from 'react'
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
const { hasLiveDocument, LEGACY_MODEL_ITEM_ID } = await import('../../doc/documentHolder')

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

describe('INT-17C Stage C1 step 6: New Model Item command + isolated Editing Space + Finish', () => {
  it('create -> isolated Editing Space opens immediately -> Finish -> back to project', async () => {
    render(<App />)

    // Pre-existing legacy flow untouched: no Model Item selected yet.
    expect(useCamStore.getState().activeModelItemId).toBeNull()
    // GEO-UNIFY-S1b: the floating banner is gone; the equivalent is now the
    // in-panel model-workspace-header row (ModelWorkspaceHeader.tsx).
    expect(screen.queryByTestId('model-workspace-header')).toBeNull()

    fireEvent.click(screen.getByTestId('add-model-item-btn'))

    // "create -> the new item's isolated Editing Space opens immediately"
    expect(useCamStore.getState().workspace).toBe('part')
    const itemAId = useCamStore.getState().activeModelItemId
    expect(itemAId).not.toBeNull()
    expect(useCamStore.getState().project.modelItems).toHaveLength(1)
    expect(useCamStore.getState().project.modelItems![0].name).toBe('Model Item 1')

    await waitReady()
    // registerLiveDocument (SolidsWorkbenchPage step-5 wiring) ran with THIS
    // item's real id, not the legacy default — proves modelItemId actually
    // threaded through App -> SolidsWorkbenchPage, not just the workspace tab.
    expect(hasLiveDocument(itemAId!)).toBe(true)
    expect(hasLiveDocument(LEGACY_MODEL_ITEM_ID)).toBe(false)

    expect(screen.getByTestId('model-workspace-header')).toBeTruthy()
    expect(screen.getByTestId(`model-item-row-${itemAId}`).className).toMatch(/tree-item-geo-active/)

    fireEvent.click(screen.getByTestId('model-item-finish-btn'))
    // "Finish -> returns to the project"
    expect(useCamStore.getState().workspace).toBe('cam')
    // The item itself is NOT removed by finishing — it stays in the tree.
    expect(useCamStore.getState().project.modelItems).toHaveLength(1)
  })

  it('reopening item A shows only item A — item B stays absent', async () => {
    render(<App />)

    fireEvent.click(screen.getByTestId('add-model-item-btn'))
    await waitReady()
    const itemAId = useCamStore.getState().activeModelItemId!
    fireEvent.click(screen.getByTestId('model-item-finish-btn'))

    fireEvent.click(screen.getByTestId('add-model-item-btn'))
    await waitReady()
    const itemBId = useCamStore.getState().activeModelItemId!
    expect(itemBId).not.toBe(itemAId)
    fireEvent.click(screen.getByTestId('model-item-finish-btn'))

    expect(useCamStore.getState().project.modelItems).toHaveLength(2)
    // GEO-UNIFY Stage 1 (2026-07-24): the separate "Model Items" section is
    // gone -- both (still-empty) items render as placeholder rows inside the
    // ONE unified Geometry section.
    expect(screen.getByTestId('geometry-section').textContent).toContain('Model Item 1')
    expect(screen.getByTestId('geometry-section').textContent).toContain('Model Item 2')

    // Reopen A specifically (design-tree row click, not "whatever was last active").
    fireEvent.click(screen.getByTestId(`model-item-row-${itemAId}`))
    expect(useCamStore.getState().workspace).toBe('part')
    expect(useCamStore.getState().activeModelItemId).toBe(itemAId)
    await waitReady()

    // Only ONE workbench mount exists at a time — B's content is absent, not
    // merely hidden behind A's (isolation falls out of the single embedded
    // host + per-item remount key, step 5).
    expect(screen.getAllByTestId('solids-workbench-status')).toHaveLength(1)
    expect(screen.getByTestId(`model-item-row-${itemAId}`).className).toMatch(/tree-item-geo-active/)
    expect(screen.getByTestId(`model-item-row-${itemBId}`).className).not.toMatch(/tree-item-geo-active/)
    expect(hasLiveDocument(itemAId)).toBe(true)
  })
})
