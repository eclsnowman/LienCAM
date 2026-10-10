// @vitest-environment jsdom
// MSH-4-BOOLEAN-EDIT Stage 4: all THREE nav paths reach the picker on the SAME
// shared predicates - (1) right-click context menu, (2) inline tree button,
// (3) Properties Panel button - plus Edit re-opens the picker for a result row.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import { buildTreeContextMenu } from '../../lib/tree/treeContextMenu'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    get length() { return mem.size },
    clear: () => mem.clear(),
    getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
    key: (i: number) => Array.from(mem.keys())[i] ?? null,
    removeItem: (k: string) => { mem.delete(k) },
    setItem: (k: string, v: string) => { mem.set(k, String(v)) },
  },
  configurable: true,
})
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: async () => {}, loadCachedStep: async () => null, removeCachedStep: async () => {},
}))

const { DesignTree } = await import('../../components/panels/DesignTree')
const { GeometryProperties } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
type ImportedGeometry = import('../../types').ImportedGeometry

afterEach(cleanup)

function meshRow(): ImportedGeometry {
  return {
    id: 'm1', name: 'scan', filename: 'scan.stl', type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 }, size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}
function modelRow(): ImportedGeometry {
  return {
    id: 'b1', name: 'Block', filename: 'Block', type: 'model', format: 'model',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 5, z: 5 }, size: { x: 5, y: 5, z: 5 }, center: { x: 2.5, y: 2.5, z: 2.5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true, modelItemId: 'legacy',
    modelBody: { ref: { bodyId: 'B1', stableIds: [], version: 1 }, display: { positions: [0, 0, 0, 1, 1, 1, 2, 0, 0], normals: [0, 0, 0, 0, 0, 0, 0, 0, 0], indices: [0, 1, 2], edgePositions: [], edgeOffsets: [], bbox: { min: [0, 0, 0], max: [2, 1, 1] }, faceIds: ['a'], triFace: [0] } },
  }
}
function resultRow(): ImportedGeometry {
  return {
    ...meshRow(), id: 'r1', name: 'scan (subtract)',
    approximate: true,
    booleanProvenance: { op: 'difference', sourceMeshId: 'm1', sourceMeshName: 'scan', modelBodyId: 'b1', modelBodyName: 'Block', triangleCount: 24, volumeMm3: 875, curvedFaceCount: 2 },
  }
}

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ activeModal: null, workspace: 'cam', brepImportError: null, booleanMeshMeshGeoId: null, booleanMeshEditResultId: null } as never)
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    } as never)
  })
})

function seed(rows: ImportedGeometry[]) {
  act(() => { useCamStore.setState((s) => ({ project: { ...s.project, geometry: rows } })) })
}

describe('MSH-4 nav paths - context menu (pure builder)', () => {
  it('a mesh source row with a model body available offers "Boolean with model body..."', () => {
    const items = buildTreeContextMenu({ kind: 'geometry', geoId: 'm1', canToggleVisibility: true, hidden: false, wrappable: true, booleanSource: true, booleanResult: false })
    expect(items.some((i) => i.action === 'geo-boolean-with-model')).toBe(true)
  })
  it('a boolean result row offers "Edit boolean..." FIRST', () => {
    const items = buildTreeContextMenu({ kind: 'geometry', geoId: 'r1', canToggleVisibility: true, hidden: false, booleanResult: true, booleanSource: true })
    expect(items[0].action).toBe('geo-edit-boolean')
  })
  it('a plain mesh with NO model body available does not offer the boolean item', () => {
    const items = buildTreeContextMenu({ kind: 'geometry', geoId: 'm1', canToggleVisibility: true, hidden: false, booleanSource: false, booleanResult: false })
    expect(items.some((i) => i.action === 'geo-boolean-with-model')).toBe(false)
  })
})

describe('MSH-4 nav paths - inline tree button (path 2)', () => {
  it('a mesh source row shows the Combine button; clicking opens the picker preselected', () => {
    seed([meshRow(), modelRow()])
    render(<DesignTree />)
    const btn = screen.getByTestId('boolean-btn-m1')
    fireEvent.click(btn)
    expect(useCamStore.getState().activeModal).toBe('boolean-mesh')
    expect(useCamStore.getState().booleanMeshMeshGeoId).toBe('m1')
  })
  it('a result row shows the Edit-boolean button; clicking re-opens the picker for that result', () => {
    seed([resultRow(), modelRow()])
    render(<DesignTree />)
    const btn = screen.getByTestId('boolean-edit-btn-r1')
    fireEvent.click(btn)
    expect(useCamStore.getState().activeModal).toBe('boolean-mesh')
    expect(useCamStore.getState().booleanMeshEditResultId).toBe('r1')
  })
  it('no model body in the project -> no boolean button on a mesh row', () => {
    seed([meshRow()])
    render(<DesignTree />)
    expect(screen.queryByTestId('boolean-btn-m1')).toBeNull()
  })
})

describe('MSH-4 nav paths - Properties Panel button (path 3)', () => {
  it('a selected mesh source row shows "Boolean with model body..."', () => {
    seed([meshRow(), modelRow()])
    render(<GeometryProperties geo={meshRow()} />)
    const btn = screen.getByTestId('pp-boolean-with-model')
    fireEvent.click(btn)
    expect(useCamStore.getState().activeModal).toBe('boolean-mesh')
    expect(useCamStore.getState().booleanMeshMeshGeoId).toBe('m1')
  })
  it('a selected result row shows "Edit boolean..."', () => {
    seed([resultRow(), modelRow()])
    render(<GeometryProperties geo={resultRow()} />)
    const btn = screen.getByTestId('pp-edit-boolean')
    fireEvent.click(btn)
    expect(useCamStore.getState().booleanMeshEditResultId).toBe('r1')
  })
})
