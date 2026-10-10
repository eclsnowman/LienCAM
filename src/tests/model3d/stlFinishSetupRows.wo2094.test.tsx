// @vitest-environment jsdom
// WO-2094: finishing an STL in the Model screen adds no empty row to Setup.
//
// Measured 2026-09-27 (headed direct-edit check): Setup "+" -> Edit as model
// on "Sample Parts/obj_1_Platte C.stl" -> Finish left an extra
// "Project Model  MODEL (empty)" row beside the STL. The STL opens as a
// mesh-backed body (WO-1935), which enters the Model screen the way the Model
// tab does - and that claimed the project's plain "Project Model" record. On
// Finish nothing owned it, so the tree drew its empty placeholder row.
//
// Driven through the product's own entry points: the store's "Edit as model"
// action (wrapImportedGeometryAsModelItem - the tree menu, the inline pen and
// Setup all call it), the REAL SolidsWorkbenchPage and its Finish button, then
// the REAL DesignTree, with the scene runtime faked (jsdom has no WebGL) and
// the STL cache serving Operator's real part bytes.
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
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
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: async (id: string, buf: ArrayBuffer) => { cache.set(id, buf) },
  loadCachedSTL: async (id: string) => cache.get(id) ?? null,
  removeCachedSTL: async (id: string) => { cache.delete(id) },
}))

const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { DesignTree } = await import('../../components/panels/DesignTree')
const { createFakeSceneRuntime } = await import('./fakeSceneRuntime')
const { createFakeGeomClient } = await import('./fakeGeomClient')
const { waitForLoadedModel3d: waitFor } = await import('./loadTolerantWaitFor')
type ImportedGeometry = import('../../types').ImportedGeometry

const PART = 'obj_1_Platte C'

function partBytes(): ArrayBuffer {
  const b = readFileSync(resolve(__dirname, '../../../Sample Parts/obj_1_Platte C.stl'))
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer
}

function stlRow(id: string): ImportedGeometry {
  return {
    id, name: PART, filename: `${PART}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 100, z: 10 }, size: { x: 100, y: 100, z: 10 }, center: { x: 50, y: 50, z: 5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    meshEdits: [],
  }
}

const state = () => useCamStore.getState()

beforeEach(() => {
  cache.clear()
  act(() => {
    state().newProject()
    useCamStore.setState({ activeModal: null })
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
  })
})

afterEach(cleanup)

async function editAsModelThenFinish(): Promise<void> {
  cache.set('platte', partBytes())
  act(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [stlRow('platte')] } }))
  })
  let result: Awaited<ReturnType<ReturnType<typeof state>['wrapImportedGeometryAsModelItem']>> | undefined
  await act(async () => { result = await state().wrapImportedGeometryAsModelItem('platte') })
  expect(result?.ok).toBe(true)
  // The part is curved: it opens as a mesh-backed body, kept as an STL.
  expect(state().modelStlGeoId).toBe('platte')
  expect(state().workspace).toBe('part')

  const runtime = createFakeSceneRuntime()
  render(<SolidsWorkbenchPage createClient={() => createFakeGeomClient()} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i))
  await waitFor(() => expect(screen.getByTestId('body-row-stl-body:platte')).toBeTruthy(), { timeout: 20_000 })

  await act(async () => { fireEvent.click(screen.getByTestId('model-item-finish-btn')) })
  await waitFor(() => expect(state().workspace).toBe('cam'))
  cleanup()
}

describe('WO-2094: finishing an STL in Model adds no empty setup row', () => {
  it('Edit as model -> Finish on Platte C: the tree lists the STL once and no empty model row', async () => {
    await editAsModelThenFinish()

    // The row is untouched and still the only geometry.
    expect(state().project.geometry.map((g) => [g.id, g.format])).toEqual([['platte', 'stl']])
    // No model record that owns nothing and holds nothing was left behind.
    expect(state().project.modelItems ?? []).toEqual([])

    render(<DesignTree />)
    expect(screen.queryAllByTestId(/^model-item-row-/)).toHaveLength(0)
    expect(screen.queryByText('MODEL (empty)')).toBeNull()
    expect(screen.getAllByText(PART).length).toBeGreaterThanOrEqual(1)
  })

  it('the STL opens and finishes the same way a second time', async () => {
    await editAsModelThenFinish()
    await editAsModelThenFinish()
    expect(state().project.modelItems ?? []).toEqual([])
    render(<DesignTree />)
    expect(screen.queryAllByTestId(/^model-item-row-/)).toHaveLength(0)
  })

  it('a Project Model the user already had is kept after an STL visit', async () => {
    // The plain Model tab on an empty project claims "Project Model" - a
    // deliberate empty model the user made. An STL visit afterwards must not
    // take it away.
    await act(async () => { await state().enterModelWorkspace() })
    act(() => { state().setWorkspace('cam') })
    const before = (state().project.modelItems ?? []).map((m) => m.id)
    expect(before).toHaveLength(1)

    await editAsModelThenFinish()

    expect((state().project.modelItems ?? []).map((m) => m.id)).toEqual(before)
    render(<DesignTree />)
    expect(screen.queryAllByTestId(/^model-item-row-/)).toHaveLength(1)
  })
})
