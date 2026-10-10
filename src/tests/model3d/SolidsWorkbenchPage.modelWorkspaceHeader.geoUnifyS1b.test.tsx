// @vitest-environment jsdom
//
// WO GEO-UNIFY-S1b RENDER GATE (standing repo rule: UI changes need a real
// React render smoke test -- tsc+vitest-on-pure-logic alone misses
// hooks-order bugs and wiring mistakes a unit test cannot see). Mirrors
// newModelItem.int17cC1Step6.test.tsx's own mocking precedent exactly (real
// App, real DesignTree, real SolidsWorkbenchPage; only the worker facade and
// WebGL scene runtime are faked at their existing injection seams).
//
// Operator's finding (coordination/evidence/GEO-UNIFY/
// operator-model-ws-header-finding.png): the floating "Editing: <name> [Finish]"
// banner "looks out of place. does not match visuals or even align" and
// there was no way to rename a model or create a new one FROM INSIDE the
// Model workspace. This drives the replacement (ModelWorkspaceHeader.tsx,
// now a real row inside SolidsWorkbenchPage's own left panel) end to end:
// rename commit/cancel, the switcher opening and switching, "+ New model"
// creating and switching, and Finish still working.

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
const { hasLiveDocument } = await import('../../doc/documentHolder')

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

describe('GEO-UNIFY-S1b: Model workspace header replaces the floating banner', () => {
  it('renders in-panel (not the old floating banner) once a Model Item is active', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('add-model-item-btn'))
    await waitReady()

    expect(screen.queryByTestId('model-item-editing-banner')).toBeNull()
    const header = screen.getByTestId('model-workspace-header')
    expect(header).toBeTruthy()
    // Lives inside the docked left panel, not floating over the app-shell.
    expect(screen.getByTestId('workbench-left-panel').contains(header)).toBe(true)
    expect(header.textContent).toContain('Model Item 1')
    expect(header.textContent).toContain('Finish')
  })

  it('rename: double-click commits through the SAME renameModelItem action the tree uses', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('add-model-item-btn'))
    await waitReady()
    const itemId = useCamStore.getState().activeModelItemId!

    fireEvent.doubleClick(screen.getByTestId('model-workspace-header-name'))
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Bracket' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(useCamStore.getState().project.modelItems!.find((m) => m.id === itemId)?.name).toBe('Bracket')
    expect(screen.getByTestId('model-workspace-header-name').textContent).toBe('Bracket')
    // Tree row reflects the SAME rename (one canonical action, two surfaces).
    expect(screen.getByTestId(`model-item-row-${itemId}`).textContent).toContain('Bracket')
  })

  it('rename: Escape cancels, name unchanged', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('add-model-item-btn'))
    await waitReady()

    fireEvent.doubleClick(screen.getByTestId('model-workspace-header-name'))
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: 'Should not stick' } })
    fireEvent.keyDown(input, { key: 'Escape' })

    expect(screen.getByTestId('model-workspace-header-name').textContent).toBe('Model Item 1')
  })

  it('switcher: opens, lists every item with the current one marked, and switching remounts to the picked item\'s own document', async () => {
    render(<App />)

    fireEvent.click(screen.getByTestId('add-model-item-btn'))
    await waitReady()
    const itemAId = useCamStore.getState().activeModelItemId!
    fireEvent.click(screen.getByTestId('model-item-finish-btn'))

    fireEvent.click(screen.getByTestId('add-model-item-btn'))
    await waitReady()
    const itemBId = useCamStore.getState().activeModelItemId!
    expect(itemBId).not.toBe(itemAId)

    // Currently viewing B -- open the switcher and pick A.
    fireEvent.click(screen.getByTestId('model-workspace-switcher-trigger'))
    const menu = screen.getByTestId('model-workspace-switcher-menu')
    expect(menu.textContent).toContain('Model Item 1')
    expect(menu.textContent).toContain('Model Item 2')
    expect(screen.getByTestId(`model-workspace-switcher-item-${itemBId}`).className).toMatch(/current/)

    fireEvent.click(screen.getByTestId(`model-workspace-switcher-item-${itemAId}`))

    expect(useCamStore.getState().activeModelItemId).toBe(itemAId)
    expect(useCamStore.getState().workspace).toBe('part')
    await waitReady()
    // Full remount to A's own document (SolidsWorkbenchPage's own
    // `${modelItemId}:${documentGeneration}` key) -- B's edits were stashed
    // by documentHolder.ts's registerLiveDocument unmount cleanup on the way
    // out, not discarded (save-correctness: see ModelWorkspaceHeader.tsx's
    // own header comment).
    expect(hasLiveDocument(itemAId)).toBe(true)
    expect(screen.getByTestId('model-workspace-header-name').textContent).toBe('Model Item 1')
  })

  it('"+ New model" in the header creates a fresh item and switches to it, same as the Geometry header\'s own New model', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('add-model-item-btn'))
    await waitReady()
    const itemAId = useCamStore.getState().activeModelItemId!

    fireEvent.click(screen.getByTestId('model-workspace-new-model-btn'))
    await waitReady()

    const itemBId = useCamStore.getState().activeModelItemId!
    expect(itemBId).not.toBe(itemAId)
    expect(useCamStore.getState().project.modelItems).toHaveLength(2)
    expect(screen.getByTestId('model-workspace-header-name').textContent).toBe('Model Item 2')
  })

  it('Finish still returns to the project workspace', async () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('add-model-item-btn'))
    await waitReady()

    fireEvent.click(screen.getByTestId('model-item-finish-btn'))
    expect(useCamStore.getState().workspace).toBe('cam')
  })
})
