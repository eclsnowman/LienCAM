// @vitest-environment jsdom
//
// GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stages 1+4: React-render SMOKE tests for
// the two tree nav paths onto "Edit as model" for an imported STEP row --
//   (1) context menu: FIRST item "Edit as model" on a wrappable STEP row,
//   (2) inline PenTool button (title "Edit as model").
// Both dispatch wrapImportedGeometryAsModelItem (exercised for real for STEP,
// not mocked), which marks the row pending + opens the Model workspace. An STL
// row now ALSO shows both affordances (stage 4: mesh converts to a solid) --
// asserted for presence here; the STL click path is exercised in the store
// suite (wrapImportedMeshAsModelItem.mshWiring.test.ts).
//
// The IndexedDB STEP cache is the one seam mocked (no node equivalent).

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
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

const cache = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id: string, buf: ArrayBuffer) => { cache.set(id, buf) },
  loadCachedStep: async (id: string) => cache.get(id) ?? null,
  removeCachedStep: async (id: string) => { cache.delete(id) },
}))

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
type ImportedGeometry = import('../../types').ImportedGeometry

afterEach(cleanup)
const st = () => useCamStore.getState()

beforeEach(() => {
  cache.clear()
  cache.set('gStep', new Uint8Array([1, 2, 3]).buffer)
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ activeModal: null, workspace: 'cam', brepImportError: null })
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
  })
})

function stepGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'gStep', name: 'Bracket', filename: 'bracket.step', type: 'brep', format: 'step',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 },
      size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, solidCount: 1,
    ...over,
  }
}

function seed(row: ImportedGeometry) {
  act(() => { useCamStore.setState((s) => ({ project: { ...s.project, geometry: [row] } })) })
}

describe('GEO-UNIFY Stage 4: context-menu "Edit as model" on a STEP row', () => {
  it('right-click opens a menu whose FIRST item is Edit as model; clicking it wraps + opens the Model workspace', async () => {
    seed(stepGeo())
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('tree-name-geometry'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))
    expect(buttons[0].textContent).toBe('Edit as model')
    expect(buttons[0].getAttribute('data-action')).toBe('geo-edit-as-model')

    fireEvent.click(buttons[0])

    await waitFor(() => expect(st().workspace).toBe('part'))
    const itemId = st().activeModelItemId!
    expect(itemId).toBeTruthy()
    expect(st().project.geometry.find((g) => g.id === 'gStep')?.pendingModelItemId).toBe(itemId)
  })

  it('an STL row menu ALSO shows Edit as model FIRST (stage 4: mesh converts)', () => {
    seed(stepGeo({ format: 'stl', filename: 'x.stl', type: 'mesh' }))
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('tree-name-geometry'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))
    expect(buttons[0].getAttribute('data-action')).toBe('geo-edit-as-model')
  })
})

describe('GEO-UNIFY Stage 4: inline "Edit as model" button', () => {
  it('a wrappable STEP row shows the inline button; clicking it wraps + opens the Model workspace', async () => {
    seed(stepGeo())
    render(<DesignTree />)

    const btn = screen.getByTestId('edit-as-model-btn-gStep')
    expect(btn.tagName).toBe('BUTTON')
    fireEvent.click(btn)

    await waitFor(() => expect(st().workspace).toBe('part'))
    expect(st().activeModelItemId).toBeTruthy()
  })

  it('an STL row ALSO shows the inline Edit as model button (stage 4)', () => {
    seed(stepGeo({ format: 'stl', filename: 'x.stl', type: 'mesh' }))
    render(<DesignTree />)
    expect(screen.getByTestId('edit-as-model-btn-gStep').tagName).toBe('BUTTON')
  })

  it('a nest seed STEP copy has NO inline Edit as model button', () => {
    seed(stepGeo({ ownerNestId: 'nest-1' }))
    render(<DesignTree />)
    // A nest seed is suppressed from the standalone tree anyway, but the
    // predicate also excludes it -- assert the affordance is absent.
    expect(screen.queryByTestId('edit-as-model-btn-gStep')).toBeNull()
  })
})
