// @vitest-environment jsdom
//
// EDIT-MODEL-REGRESSION (Operator, same-hour URGENT, 2026-07-24). Operator's live
// finding: a project with a real modeled body ("Extrude F1 [MODEL]", 1 body)
// -- clicking Edit (Properties panel button, or the tree's "Edit model"
// pencil/context-menu item) lands in the Model workspace showing the S1b
// header ("PROJECT MODEL") but 0 bodies / 4 features (genesis only). The
// routing works (workspace flips to 'part', activeModelItemId becomes
// 'legacy') -- the DOCUMENT LOAD is broken.
//
// Root cause: the workbench consumed the holder's one pending seed during
// render. React StrictMode/speculative rendering can discard that render, so
// the committed mount then saw no seed and constructed a genesis-only DAG.
// A second gap left byte-identical A -> B -> A switches with pass-through
// bytes but no seed parked for A's next mount.
//
// This test drives the complete real-App flow under StrictMode: build a live
// body, Finish to CAM, re-enter from the selected CAM row, switch B -> A ->
// B -> A in the Model workspace, and repeat Finish -> CAM -> Model three
// times. It asserts the feature tree, live kernel handle, viewport mesh, and
// CAM model-body display all stay scoped to the selected document.
//
// WO-2707 repin (WO-2700 154b13a79, owner 10-09 'Keep it'): the plain Model tab
// now opens the New Model dialog; Create Model makes a real item (A, a fresh
// id, no longer the 'legacy' slot) and enters. Re-entry after Finish is the
// operator's explicit Edit Model on the CAM/setup tree row (model-edit-btn-<A>
// or the row's context menu) -- the selection-aware tab path and the tab's
// active-item resume were deliberately removed by WO-2700. Every document
// assertion (feature tree, live kernel handle, scene mesh, CAM display) is kept.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createElement, StrictMode } from 'react'
import { mintRectangleSketch } from './mintRectangleSketch'
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

let savedBlobs: Blob[] = []
let savedCreateObjectURL: typeof URL.createObjectURL
let savedRevokeObjectURL: typeof URL.revokeObjectURL

beforeEach(() => {
  window.history.pushState(null, '', '/?partWorkspace=1')
  useCamStore.getState().newProject()
  useCamStore.setState({ workspace: 'cam' })
  savedBlobs = []
  savedCreateObjectURL = URL.createObjectURL
  savedRevokeObjectURL = URL.revokeObjectURL
  URL.createObjectURL = ((blob: Blob) => { savedBlobs.push(blob); return 'blob:edit-model-regression' }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
  URL.createObjectURL = savedCreateObjectURL
  URL.revokeObjectURL = savedRevokeObjectURL
})

async function waitReady() {
  await waitFor(() =>
    expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i),
  { timeout: 10000 })
}

function commitField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

async function buildRealContent(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(screen.getByTestId('feature-row-F1')).toBeTruthy())
  await expectLiveModelBody('F1')
}

function camModelBodyRow(bodyId: string) {
  return useCamStore.getState().project.geometry.find(
    (geo) => geo.format === 'model' && geo.modelBody?.ref.bodyId === bodyId,
  )
}

async function expectLiveModelBody(bodyId: string): Promise<void> {
  await waitFor(() => {
    const hooks = window.__solidsWorkbenchHooks
    expect(hooks?.getBodyHandle(bodyId)).toBeDefined()
    expect(hooks?.hasSceneMesh(bodyId)).toBe(true)
    expect(camModelBodyRow(bodyId)?.modelBody?.display?.positions.length).toBeGreaterThan(0)
  }, { timeout: 10000 })
}

describe('EDIT-MODEL-REGRESSION: every model workspace transition preserves the selected document', () => {
  it('StrictMode: CAM entry, A -> B -> A selector switches, Finish, and repeated CAM cycles keep A loaded', async () => {
    render(<StrictMode><App /></StrictMode>)

    // Plain Model tab -> New Model dialog -> Create Model (WO-2700), the
    // operator's own route into a new model.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    fireEvent.click(screen.getByTestId('model-entry-new'))
    await waitReady()
    const itemAId = useCamStore.getState().activeModelItemId!
    expect(itemAId).toBeTruthy()
    await buildRealContent()
    fireEvent.click(screen.getByTestId('model-item-finish-btn'))
    await waitFor(() => expect(useCamStore.getState().workspace).toBe('cam'))
    const finishedRow = camModelBodyRow('F1')
    // A real (non-legacy) item scopes its CAM row id (modelBodyAdapter.ts).
    expect(finishedRow?.id).toBe(`modelbody:${itemAId}:F1`)
    expect(finishedRow?.modelItemId).toBe(itemAId)
    expect(finishedRow?.modelBody?.display?.positions.length).toBeGreaterThan(0)

    // Re-enter from the selected CAM model-origin row through its Edit Model
    // (WO-2700: the plain tab no longer acts on the selection).
    fireEvent.click(screen.getByTestId('tree-name-geometry'))
    fireEvent.click(screen.getByTestId(`model-edit-btn-${itemAId}`))
    await waitReady()
    expect(useCamStore.getState().activeModelItemId).toBe(itemAId)
    await waitFor(() => expect(screen.getByTestId('feature-row-F1')).toBeTruthy(), { timeout: 10000 })
    await expectLiveModelBody('F1')

    // Create B from inside the workspace. This forces A's live document to
    // stash and remounts the same host on a different modelItemId.
    fireEvent.click(screen.getByTestId('model-workspace-new-model-btn'))
    await waitReady()
    const itemBId = useCamStore.getState().activeModelItemId!
    expect(itemBId).not.toBe(itemAId)

    // Exercise the in-workspace selector B -> A -> B -> A. Before the fix,
    // StrictMode's discarded render consumed A's seed and the committed A
    // mount showed only the four genesis rows.
    const switchTo = async (id: string): Promise<void> => {
      fireEvent.click(screen.getByTestId('model-workspace-switcher-trigger'))
      fireEvent.click(screen.getByTestId(`model-workspace-switcher-item-${id}`))
      await waitReady()
    }
    await switchTo(itemAId)
    expect(useCamStore.getState().activeModelItemId).toBe(itemAId)
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(screen.getByTestId('feature-row-F1')).toBeTruthy(), { timeout: 10000 })
    await expectLiveModelBody('F1')
    await switchTo(itemBId)
    expect(useCamStore.getState().activeModelItemId).toBe(itemBId)
    expect(screen.queryByTestId('feature-row-F1')).toBeNull()
    expect(window.__solidsWorkbenchHooks?.getBodyHandle('F1')).toBeUndefined()
    expect(window.__solidsWorkbenchHooks?.hasSceneMesh('F1')).toBe(false)
    await switchTo(itemAId)
    await waitFor(() => expect(screen.getByTestId('feature-row-F1')).toBeTruthy(), { timeout: 10000 })
    await expectLiveModelBody('F1')

    // Finish/save-to-CAM and repeatedly re-enter the same item. The retained
    // host and the active-item resume path must never degrade the live model.
    for (let cycle = 0; cycle < 3; cycle++) {
      fireEvent.click(screen.getByTestId('model-item-finish-btn'))
      await waitFor(() => expect(useCamStore.getState().workspace).toBe('cam'))
      fireEvent.click(screen.getByTestId(`model-edit-btn-${itemAId}`))
      await waitReady()
      expect(useCamStore.getState().activeModelItemId).toBe(itemAId)
      await waitFor(() => expect(screen.getByTestId('feature-row-F1')).toBeTruthy(), { timeout: 10000 })
      await expectLiveModelBody('F1')
    }
  }, 60_000)
})

// DEFECT 2: Operator's report -- "right-click on a model-origin geometry row in
// the CAM tree no longer offers Edit model". Traced against the current
// code (src/lib/tree/treeContextMenu.ts's 'geometry' case + DesignTree.tsx's
// row-level onContextMenu, both already routed through the shared
// resolveOwningModelItemId resolver by INT-MODEL-UNIFY/GEO-UNIFY-S1) and
// found ALREADY CORRECT on HEAD -- this locks it in as a render-gate
// regression test (mutation-proof: see the report for the git-stash RED
// proof against a deliberately reverted treeContextMenu.ts).
describe('DEFECT 2 lock-in: the CAM geometry row context menu offers "Edit model" FIRST for a model-origin row', () => {
  it('Model tab -> Create Model, build content, Finish -- the CAM row\'s context menu opens with "Edit model" first, and invoking it routes back into the Model workspace', async () => {
    render(<App />)

    // WO-2707 (WO-2700 154b13a79): Model tab -> New Model dialog -> Create Model.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    fireEvent.click(screen.getByTestId('model-entry-new'))
    await waitReady()
    const itemId = useCamStore.getState().activeModelItemId!
    expect(itemId).toBeTruthy()
    await buildRealContent()
    fireEvent.click(screen.getByTestId('model-item-finish-btn'))
    await waitFor(() => expect(useCamStore.getState().workspace).toBe('cam'))

    // Right-click the CAM tree's own geometry row for the modeled body.
    fireEvent.contextMenu(screen.getByTestId('tree-name-geometry'))
    const menu = screen.getByTestId('tree-context-menu')
    const firstItem = menu.querySelector('button[role="menuitem"]') as HTMLButtonElement
    expect(firstItem).toBeTruthy()
    expect(firstItem.dataset.action).toBe('geo-edit-model')
    expect(firstItem.textContent).toBe('Edit model')

    fireEvent.click(firstItem)
    expect(useCamStore.getState().workspace).toBe('part')
    expect(useCamStore.getState().activeModelItemId).toBe(itemId)
    await waitReady()
    await waitFor(() => expect(screen.getByTestId('feature-row-F1')).toBeTruthy(), { timeout: 10000 })
  }, 60_000)
})
