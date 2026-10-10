// @vitest-environment jsdom
//
// GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 1 (nav path 3, plan sec 7 delta a):
// when the current CAM selection is a wrappable imported STEP row, clicking the
// mode strip's "Model" tab WRAPS it as a new Model Item and opens it -- the
// branch slots BEFORE enterModelWorkspace's 4-way resolution. A non-STEP / no
// selection keeps today's behavior (proven by the sibling
// modeTabStripSelectedModelOpen suite). Same App-level mock harness.
//
// WO-2707 repin (WO-2700 154b13a79, owner 10-09 'Keep it'): the plain Model tab
// now always opens the New Model dialog and never acts on the selection. The
// wrap is reached by the operator's explicit route instead: the STEP row's
// inline "Edit as model" button in the setup tree (edit-as-model-btn-<id>),
// which calls the same wrapImportedGeometryAsModelItem. The wrap assertions
// are unchanged.

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

// The IndexedDB STEP byte cache -> in-memory map (no node equivalent).
const cache = new Map<string, ArrayBuffer>()
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async (id: string, buf: ArrayBuffer) => { cache.set(id, buf) },
  loadCachedStep: async (id: string) => cache.get(id) ?? null,
  removeCachedStep: async (id: string) => { cache.delete(id) },
}))

vi.mock('../../components/viewport/Viewport', () => typedMock<typeof import('../../components/viewport/Viewport')>({
  Viewport: () => <div data-testid="viewport-stub" />,
}))
vi.mock('../../components/model3d/SolidsWorkbenchPage', () => typedMock<typeof import('../../components/model3d/SolidsWorkbenchPage')>({
  SolidsWorkbenchPage: () => <div data-testid="solids-workbench-status">Ready</div>,
}))

const { default: App } = await import('../../App')
const { useCamStore } = await import('../../store')
type ImportedGeometry = import('../../types').ImportedGeometry

const st = () => useCamStore.getState()

function stepGeo(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${name}.step`, type: 'brep', format: 'step',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 },
      size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 },
    },
    position: { x: 2, y: 1, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    solidCount: 1,
  }
}

beforeEach(() => {
  window.history.pushState(null, '', '/')
  cache.clear()
  cache.set('gStep', new Uint8Array([1, 2, 3]).buffer)
  act(() => {
    st().newProject()
    useCamStore.setState({ workspace: 'cam' })
  })
})

afterEach(() => {
  cleanup()
  window.history.pushState(null, '', '/')
})

describe('GEO-UNIFY Stage 4: Edit as model wraps the selected STEP row', () => {
  it('a selected wrappable STEP row -> Edit as model wraps it and opens the NEW item', async () => {
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepGeo('gStep', 'Bracket')] } }))
      st().setSelectedGeometry('gStep')
    })
    render(<App />)

    // The plain tab offers New Model and leaves the STEP row alone.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expect(st().activeModal).toBe('new-model')
    expect(st().workspace).toBe('cam')
    expect(st().project.geometry.find((g) => g.id === 'gStep')!.pendingModelItemId).toBeUndefined()
    fireEvent.click(screen.getByText('Cancel'))

    fireEvent.click(screen.getByTestId('edit-as-model-btn-gStep'))

    await waitFor(() => expect(st().activeModelItemId).toBeTruthy())
    expect(st().workspace).toBe('part')
    const itemId = st().activeModelItemId!
    // A brand-new item was minted for the wrapped STEP and opened.
    expect((st().project.modelItems ?? []).some((m) => m.id === itemId)).toBe(true)
    // The STEP row is now pending adoption (still format:'step', not duplicated).
    const row = st().project.geometry.find((g) => g.id === 'gStep')!
    expect(row.format).toBe('step')
    expect(row.pendingModelItemId).toBe(itemId)
  })

  it('a selected multi-body STEP row -> Edit as model fans it out to ONE item and opens it', async () => {
    // INT-IMPORT-EDIT stage 3: a multi-body STEP no longer refuses -- the Model
    // tab wraps it into ONE Model Item (one import node per solid) and opens it;
    // the old CAM row is marked pending for adoption as the first solid.
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stepGeo('gStep', 'Multi')] } }))
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: s.project.geometry.map((g) => g.id === 'gStep' ? { ...g, solidCount: 4 } : g) },
      }))
      st().setSelectedGeometry('gStep')
    })
    render(<App />)

    // The plain tab offers New Model and leaves the STEP row alone.
    fireEvent.click(screen.getByTestId('mode-tab-part'))
    expect(st().activeModal).toBe('new-model')
    expect(st().workspace).toBe('cam')
    expect(st().project.geometry.find((g) => g.id === 'gStep')!.pendingModelItemId).toBeUndefined()
    fireEvent.click(screen.getByText('Cancel'))

    fireEvent.click(screen.getByTestId('edit-as-model-btn-gStep'))

    await waitFor(() => expect(st().activeModelItemId).toBeTruthy())
    expect(st().workspace).toBe('part')
    expect(st().brepImportError).toBeNull()
    expect(st().project.modelItems ?? []).toHaveLength(1)
    const row = st().project.geometry.find((g) => g.id === 'gStep')!
    expect(row.format).toBe('step')
    expect(row.pendingModelItemId).toBe(st().activeModelItemId)
  })
})
