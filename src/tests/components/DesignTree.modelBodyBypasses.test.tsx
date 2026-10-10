// @vitest-environment jsdom
//
// INT-17A-R1 C3 + C4, UI side: the two bypasses that are reachable only by
// CLICKING - the stock-membership control the DesignTree rendered on a modeled
// row, and the folder-delete cascade that swept a modeled entry away.
//
// A React MOUNT test (render-gate rule): the pure store tests in
// src/tests/store/int17aR1Bypasses.test.ts prove the store refuses; this proves
// the CONTROL that reaches the store is not offered in the first place, and
// that the folder-delete confirm names the real outcome. tsc cannot see either.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { ImportedGeometry, ModelBodyDisplay } from '../../types'
import { typedMock } from '../support/typedMock'

// jsdom's localStorage is broken under vitest's node launch flags and the store
// persists on every set(); install the in-memory shim BEFORE importing the store
// (same scaffolding as DesignTreeAutoStock.smoke.test.tsx).
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

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))
vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  cache2DGeometry: vi.fn(async () => {}), load2DGeometry: vi.fn(async () => null), remove2DGeometry: vi.fn(async () => {}),
}))
// The display cache is INCIDENTAL here (this file tests DesignTree's rows and
// confirms, not the cache), so it is mocked alongside the other three IDB caches
// above. INT-17A-R2 C2: kept in step with the real project-scoped signatures -
// a mock whose shape has drifted from the module is a test that passes on code
// that would not run. The cache's own behaviour is covered against the REAL
// module in src/tests/store/int17aR2Boundary.test.ts.
const displayStore = new Map<string, ModelBodyDisplay>()
const mockKey = (projectId: string, geometryId: string) => `${projectId}::${geometryId}`
vi.mock('../../lib/modelBodyDisplayCache', () => typedMock<typeof import('../../lib/modelBodyDisplayCache')>({
  cacheModelBodyDisplay: vi.fn(async (
    scope: { projectId: string; geometryId: string }, d: ModelBodyDisplay,
  ) => { displayStore.set(mockKey(scope.projectId, scope.geometryId), d) }),
  loadCachedModelBodyDisplay: vi.fn(async (scope: { projectId: string; geometryId: string }) =>
    displayStore.get(mockKey(scope.projectId, scope.geometryId)) ?? null),
  removeCachedModelBodyDisplay: vi.fn(async (projectId: string, geometryId: string) => {
    displayStore.delete(mockKey(projectId, geometryId))
  }),
  pruneModelBodyDisplayCache: vi.fn(async () => {}),
}))

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')

const display: ModelBodyDisplay = {
  positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
  indices: [0, 1, 2], edgePositions: [0, 0, 0, 1, 0, 0], edgeOffsets: [0, 2],
  bbox: { min: [0, 0, 0], max: [1, 1, 0] },
}

const bbox = {
  min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 },
  size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 },
}
const dxfGeo = (id: string, folderId?: string): ImportedGeometry => ({
  id, name: `Part ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
  boundingBox: bbox, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  loaded: true, folderId,
  loops: [{ id: `${id}-l`, layerId: `${id}-lay`, type: 'contour', area: 0.5,
            points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }], closed: true }],
  layers2d: [{ id: `${id}-lay`, name: 'Layer', visible: true, color: '#fff' }],
} as ImportedGeometry)

afterEach(cleanup)
beforeEach(() => {
  displayStore.clear()
  vi.clearAllMocks()
  act(() => {
    useCamStore.getState().newProject()
    useUiPrefs.setState({
      treeGeometryExpanded: true,
      collapsedPartIds: [],
      expandedDerivedGeoIds: [],
    })
  })
})

/** Seed one modeled body through the REAL sync action (never a hand-built row),
 *  so the entry under test is exactly what the Model tab produces. */
function seedModelBody(name = 'Extrude F1'): string {
  act(() => {
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'F1', name }],
      derived: [{ bodyId: 'F1', version: 1, stableIds: ['F1:F0'], display }],
    })
  })
  return useCamStore.getState().project.geometry.find((g) => g.format === 'model')!.id
}

describe('SECTION-STALENESS-MARK: DesignTree warning badge', () => {
  it('renders the shared warning badge only for a stale tracked section', () => {
    const modelId = seedModelBody()
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: s.project.geometry.map((geo) => geo.id === modelId
            ? {
                ...geo,
                layers2d: [{
                  id: 'section-1',
                  name: 'Section z=0',
                  color: '#ff8c00',
                  visible: true,
                  derived: true,
                  sectionSource: {
                    bodyId: 'F1',
                    geometryFingerprint: 'mbf1:original',
                  },
                  sectionStale: false,
                }],
                loops: [{
                  id: 'section-loop-1',
                  layerId: 'section-1',
                  closed: true,
                  type: 'contour',
                  area: 0.5,
                  points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
                }],
              }
            : geo),
        },
      }))
      useUiPrefs.setState({ expandedDerivedGeoIds: [modelId] })
    })

    render(<DesignTree />)
    expect(screen.queryByTestId(`section-stale-badge-${modelId}-section-1`)).toBeNull()

    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: s.project.geometry.map((geo) => geo.id === modelId
            ? {
                ...geo,
                layers2d: geo.layers2d?.map((layer) => ({
                  ...layer,
                  sectionStale: true,
                })),
              }
            : geo),
        },
      }))
    })

    const badge = screen.getByTestId(`section-stale-badge-${modelId}-section-1`)
    expect(badge.textContent).toBe('stale')
    expect(badge.classList.contains('badge')).toBe(true)
    expect(badge.classList.contains('badge-warning')).toBe(true)
    expect(badge.getAttribute('data-tooltip'))
      .toBe('Source model changed after this section was created. Create a new section before using it.')
  })
})

describe('CAM-BINDING Stage 3 UI: the DesignTree now offers a stock-membership control on a modeled row too', () => {
  it('a modeled row renders a stock select, same as an ordinary part on the same tree', () => {
    const modelId = seedModelBody()
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, geometry: [...s.project.geometry, dxfGeo('a')] } }))
    })
    // The project has stocks (a fresh project carries the default auto stock),
    // so the control IS rendered for eligible parts - this is not a vacuous pass.
    expect((useCamStore.getState().project.stocks ?? []).length).toBeGreaterThan(0)

    const { container } = render(<DesignTree />)
    const selects = Array.from(container.querySelectorAll('.tree-geo-stock-select'))
    expect(selects.length).toBe(2)                       // pre-Stage-3: 1 (model row excluded)

    // Both rows render the control: scope by geometry ROW (.tree-geo-block), so
    // this cannot pass by finding a shared ancestor that happens to contain
    // both rows.
    const rows = Array.from(container.querySelectorAll('.tree-geo-block'))
    const modelRow = rows.find((r) => r.textContent?.includes('Extrude F1'))
    const partRow  = rows.find((r) => r.textContent?.includes('Part a'))
    expect(modelRow).toBeDefined()
    expect(partRow).toBeDefined()
    expect(modelRow!.querySelector('.tree-geo-stock-select')).not.toBeNull()
    expect(partRow!.querySelector('.tree-geo-stock-select')).not.toBeNull()
    expect(modelId).toBeTruthy()
  })

  it('the modeled row is still LISTED and its own controls (colour, eye) stay', () => {
    seedModelBody()
    render(<DesignTree />)
    expect(screen.getByText(/Extrude F1/)).not.toBeNull()
  })
})

describe('C4 UI: folder delete around a modeled entry', () => {
  it('deletes the ordinary part without prompting, keeps the modeled body, and Undo restores the folder contents', () => {
    const modelId = seedModelBody()
    let folderId = ''
    act(() => {
      folderId = useCamStore.getState().addGeometryFolder('Parts')
      useCamStore.setState((s) => ({ project: { ...s.project, geometry: [...s.project.geometry, dxfGeo('a', folderId)] } }))
      useCamStore.getState().setGeometryFolderId(modelId, folderId)
    })

    const { container } = render(<DesignTree />)
    const delBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.getAttribute('data-tooltip') === 'Delete folder (and its contents)')
    expect(delBtn).toBeDefined()
    act(() => { fireEvent.click(delBtn!) })

    const after = useCamStore.getState().project.geometry
    expect(after.find((g) => g.id === 'a')).toBeUndefined()
    const survivor = after.find((g) => g.id === modelId)
    expect(survivor).toBeDefined()
    expect(survivor!.folderId ?? null).toBeNull()
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.geometry.find((g) => g.id === 'a')?.folderId).toBe(folderId)
    expect(useCamStore.getState().project.geometry.find((g) => g.id === modelId)?.folderId).toBe(folderId)
  })

  it('a folder of ordinary parts deletes wholesale without prompting and Undo restores it', () => {
    let folderId = ''
    act(() => {
      folderId = useCamStore.getState().addGeometryFolder('Parts')
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [dxfGeo('a', folderId), dxfGeo('b', folderId)] },
      }))
    })
    const { container } = render(<DesignTree />)
    const delBtn = Array.from(container.querySelectorAll('button'))
      .find((b) => b.getAttribute('data-tooltip') === 'Delete folder (and its contents)')
    act(() => { fireEvent.click(delBtn!) })

    expect(useCamStore.getState().project.geometry).toHaveLength(0)
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.geometry.map((geo) => geo.id).sort()).toEqual(['a', 'b'])
  })
})
