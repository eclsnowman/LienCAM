// @vitest-environment jsdom
//
// INT-MODEL-UNIFY: real click-through proof (real App, real ModeTabStrip,
// real store) that the plain Model tab entry (no selection) now resolves
// through enterModelWorkspace instead of a bare setWorkspace('part'). The
// store-level resolution matrix itself is proven directly in
// enterModelWorkspace.intModelUnify.test.ts; this file proves the WIRING --
// that the real tab click reaches it -- mirroring
// tabStripModelDefault.ui77.test.tsx's own mock harness.
// WO-2707: since WO-2700 (154b13a79) the tab reaches the New Model dialog
// instead; see the repin note above the first describe.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
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

vi.mock('../../components/model3d/SolidsWorkbenchPage', () => typedMock<typeof import('../../components/model3d/SolidsWorkbenchPage')>({
  SolidsWorkbenchPage: () => <div data-testid="solids-workbench-status">Ready</div>,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')

const st = () => useCamStore.getState()

beforeEach(() => {
  window.history.pushState(null, '', '/')
  act(() => {
    st().newProject()
    useCamStore.setState({ workspace: 'cam', activeModal: null })
  })
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

// WO-2707 repin (WO-2700 154b13a79, owner 10-09 'Keep it'): the plain Model tab
// no longer resolves through enterModelWorkspace. It opens the New Model dialog;
// the operator's Create Model makes the item and enters; an existing item is
// reopened by Edit Model on its setup-tree row. The INT-MODEL-UNIFY facts kept:
// what the operator models is always a REAL, visible Model Item, and the
// no-choice reply leaves workspace and active item untouched.
describe('INT-MODEL-UNIFY: plain Model tab click on a truly fresh project', () => {
  it('Create Model makes a REAL, visible Model Item instead of an invisible default', () => {
    render(<App />)
    expect(st().project.modelItems ?? []).toEqual([])

    fireEvent.click(screen.getByTestId('mode-tab-part'))
    // The dialog alone changes nothing.
    expect(st().activeModal).toBe('new-model')
    expect(st().workspace).toBe('cam')
    expect(st().project.modelItems ?? []).toEqual([])

    fireEvent.click(screen.getByTestId('model-entry-new'))

    expect(st().workspace).toBe('part')
    expect(st().project.modelItems).toHaveLength(1)
    const created = st().project.modelItems![0]
    expect(st().activeModelItemId).toBe(created.id)
    expect(created).toMatchObject({ documentState: 'empty' })
    expect(created.name).toBeTruthy()
    // The Finish/editing UI now shows for this entry (INT-MODEL-UNIFY: it
    // used to be suppressed for the legacy/default flow). GEO-UNIFY-S1b moved
    // that UI from an App.tsx-level floating banner INTO SolidsWorkbenchPage's
    // own panel (ModelWorkspaceHeader.tsx) -- this file mocks SolidsWorkbenchPage
    // out entirely (see the module mock above) for speed, so it can no longer
    // observe that DOM directly; `activeModelItemId`/`project.modelItems`
    // above already prove the same fact at the store level, and the real-page
    // UI-level proof lives in newModelItem.int17cC1Step6.test.tsx (real
    // SolidsWorkbenchPage via the fake geom client) and
    // solidsWorkbenchPage.modelWorkspaceHeader.geoUnifyS1b.test.tsx.
  })

  it('after Finish, a second plain click offers New Model again; Edit Model resumes the SAME item (still just one)', () => {
    render(<App />)
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    fireEvent.click(screen.getByTestId('model-entry-new'))
    const created = st().activeModelItemId!
    act(() => { st().finishModelItem() })
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expect(st().activeModal).toBe('new-model')
    fireEvent.click(screen.getByText('Cancel'))
    expect(st().project.modelItems).toHaveLength(1)

    fireEvent.click(screen.getByTestId(`model-placeholder-edit-btn-${created}`))

    expect(st().workspace).toBe('part')
    expect(st().activeModelItemId).toBe(created)
    expect(st().project.modelItems).toHaveLength(1)
    expect(st().project.modelItems).toMatchObject([
      { id: created, documentState: 'empty' },
    ])
  })
})

describe('INT-MODEL-UNIFY: plain Model tab click with 2+ Model Items and no active one', () => {
  it('opens the New Model dialog instead of silently reopening either item; Edit Model opens the chosen one', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          modelItems: [
            { id: 'item-a', name: 'Item A', documentState: 'empty' },
            { id: 'item-b', name: 'Item B', documentState: 'empty' },
          ],
        },
      }))
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-part'))

    expect(st().activeModal).toBe('new-model')
    expect(st().workspace).toBe('cam')
    expect(st().activeModelItemId).toBeNull()
    // WO-2700: the plain tab's dialog offers creation only, no existing-item list.
    expect(screen.queryByTestId('model-entry-row-item-a')).toBeNull()
    expect(screen.queryByTestId('model-entry-row-item-b')).toBeNull()
    fireEvent.click(screen.getByText('Cancel'))

    fireEvent.click(screen.getByTestId('model-placeholder-edit-btn-item-b'))
    expect(st().activeModal).toBeNull()
    expect(st().workspace).toBe('part')
    expect(st().activeModelItemId).toBe('item-b')
  })

  it('the dialog\'s Create Model action creates and opens a fresh THIRD item', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          modelItems: [
            { id: 'item-a', name: 'Item A', documentState: 'empty' },
            { id: 'item-b', name: 'Item B', documentState: 'empty' },
          ],
        },
      }))
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-part'))
    fireEvent.click(screen.getByTestId('model-entry-new'))

    expect(st().activeModal).toBeNull()
    expect(st().workspace).toBe('part')
    expect(st().project.modelItems).toHaveLength(3)
    expect(st().activeModelItemId).toBe(st().project.modelItems![2].id)
  })

  it('Cancel leaves workspace and activeModelItemId untouched (the no-choice reply)', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          modelItems: [
            { id: 'item-a', name: 'Item A', documentState: 'empty' },
            { id: 'item-b', name: 'Item B', documentState: 'empty' },
          ],
        },
      }))
    })
    render(<App />)

    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expect(st().activeModal).toBe('new-model')
    fireEvent.click(screen.getByText('Cancel'))

    expect(st().activeModal).toBeNull()
    expect(st().workspace).toBe('cam')
    expect(st().activeModelItemId).toBeNull()
  })
})
