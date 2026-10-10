// @vitest-environment jsdom
//
// WO INT-17C Stage C1 closure disclosed (commits ccfc8c2ab, 49d32f84c):
// "switching the active Model Item unmounts the outgoing item's live
// document with no stash-on-unmount path -- its in-memory edits are lost
// the moment you switch away." This test drives that EXACT flow through
// the real UI (mirrors newModelItem.int17cC1Step6.test.tsx's App-level
// mocking precedent) and through the real save/load boundary (mirrors
// int17cC1ClosureGap1.test.ts's saveAndCaptureFile discipline) to prove
// the disclosed hazard is CLOSED, not merely documented:
//
//   create Model Item A -> build REAL content in it (sketch + extrude,
//   the same UI affordances SolidsWorkbenchPage.documentPersist.test.tsx's
//   buildModel() drives) -> Finish -> create/open Model Item B (the tree
//   action that remounts the embedded host on a DIFFERENT modelItemId,
//   unmounting A's live document) -> Finish -> save the project through
//   the REAL saveProjectToFile action -> load the saved file fresh ->
//   reopen item A through the REAL tree action -> its content is present.
//
// Before the fix (documentHolder.ts's registerLiveDocument): the outgoing
// item's live collector was deleted on unmount with nothing stashed, so a
// never-loaded-from-file item had no pass-through archive either --
// collectDocumentArchive(itemAId) fell all the way to `undefined` and the
// save silently omitted item A's document. This test pins the closed
// behavior; if the stash regresses, this reddens.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { createElement } from 'react'
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
const { CURRENT_PROJECT_SCHEMA_VERSION } = await import('../../store/migrations/projectMigrations')

// saveProjectToFile hands its Blob to URL.createObjectURL -- capturing there
// is how these tests read the exact bytes the browser would have downloaded.
// Only the two METHODS are patched (documentPersist.test.tsx's discipline),
// never the URL/document globals themselves: a real App render still needs
// real document.createElement for its own DOM.
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
  URL.createObjectURL = ((blob: Blob) => { savedBlobs.push(blob); return 'blob:int17c-switch-away' }) as typeof URL.createObjectURL
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

/** Build a real 40x20 rectangle sketch extruded 20mm through the real UI --
 *  the same affordances SolidsWorkbenchPage.documentPersist.test.tsx's
 *  buildModel() drives, adapted to this file's fakeGeomClient mount (whose
 *  makeExtrude succeeds by default, so no __solidsWorkbenchHooks body-handle
 *  wait is needed: the feature-row testid is the real, driven signal). */
async function buildRealContent(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())

  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(screen.getByTestId('feature-row-F1')).toBeTruthy())
}

async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

describe('INT-17C C1 disclosed hazard: Model Item content survives finish-switch-save-reload', () => {
  it('item A, built via the real UI, is still there after Finish -> open item B -> Finish -> save -> reload -> reopen A', async () => {
    render(<App />)

    // Create item A, build REAL content in it, Finish.
    fireEvent.click(screen.getByTestId('add-model-item-btn'))
    await waitReady()
    const itemAId = useCamStore.getState().activeModelItemId!
    await buildRealContent()
    fireEvent.click(screen.getByTestId('model-item-finish-btn'))
    await waitFor(() => expect(useCamStore.getState().workspace).toBe('cam'))

    // The disclosed hazard's trigger: open a DIFFERENT Model Item. This
    // remounts the embedded host on a new modelItemId, unmounting item A's
    // live document with no page left registered for itemAId.
    fireEvent.click(screen.getByTestId('add-model-item-btn'))
    await waitReady()
    const itemBId = useCamStore.getState().activeModelItemId!
    expect(itemBId).not.toBe(itemAId)
    fireEvent.click(screen.getByTestId('model-item-finish-btn'))
    await waitFor(() => expect(useCamStore.getState().workspace).toBe('cam'))

    // Save the project through the REAL store action -- no UI Save button
    // exists; src/tests/store/*'s own saveProjectToFile discipline is the
    // real path (int17cC1ClosureGap1.test.ts, documentPersist.test.tsx).
    const fileText = await saveAndCaptureFile()
    const parsed = JSON.parse(fileText) as Record<string, unknown> & {
      schemaVersion: number
      modelItemDocuments?: Record<string, string>
    }
    expect(parsed.schemaVersion).toBe(CURRENT_PROJECT_SCHEMA_VERSION)

    // THE ASSERTION (structural half): item A's archive actually rode in
    // the saved file, under its own id -- not silently omitted because its
    // live collector was gone by save time.
    expect(typeof parsed.modelItemDocuments?.[itemAId]).toBe('string')
    expect(parsed.modelItemDocuments![itemAId].length).toBeGreaterThan(0)

    // Load the saved file fresh, into the SAME running app (the ordinary
    // "open a project while the workbench host is mounted" path INT-14's
    // own tests already cover) -- proves this isn't merely a bytes-on-disk
    // claim but that the real load path re-seeds item A from those bytes.
    await useCamStore.getState().loadProjectFromFile(fileText)

    const loaded = useCamStore.getState().project
    const reloadedItemA = loaded.modelItems?.find((m) => m.id === itemAId)
    expect(reloadedItemA).toBeDefined()

    // THE ASSERTION (content half, via the real UI): reopening item A through the real tree
    // action shows its actual content, not a fresh empty workbench.
    // GEO-UNIFY Stage 1 (2026-07-24): item A's extrude gave it a real body,
    // so it no longer has a placeholder summary row -- reopen via its BODY
    // row's own "Edit model" pencil instead, keyed by the model item id (item
    // B's placeholder ALSO carries an "Edit model" pencil, so title alone is
    // ambiguous here).
    fireEvent.click(screen.getByTestId(`model-edit-btn-${itemAId}`))
    expect(useCamStore.getState().workspace).toBe('part')
    expect(useCamStore.getState().activeModelItemId).toBe(itemAId)
    await waitReady()
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy(), { timeout: 10000 })
    await waitFor(() => expect(screen.getByTestId('feature-row-F1')).toBeTruthy(), { timeout: 10000 })
  }, 60_000)
})
