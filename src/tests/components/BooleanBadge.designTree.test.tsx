// @vitest-environment jsdom
// MSH-4-BOOLEAN-EDIT Stage 2: the DesignTree approx/exact badge on a boolean
// result row (honest: 'approx' only when genuinely approximate, 'exact' otherwise).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act } from '@testing-library/react'
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
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
type ImportedGeometry = import('../../types').ImportedGeometry

afterEach(cleanup)

function resultRow(approximate: boolean): ImportedGeometry {
  return {
    id: 'r1', name: 'scan (subtract)', filename: 'scan (subtract).stl', type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 }, size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    approximate,
    booleanProvenance: { op: 'difference', sourceMeshId: 'm', sourceMeshName: 'scan', modelBodyId: 'b', modelBodyName: 'Block', triangleCount: 24, volumeMm3: 875, curvedFaceCount: approximate ? 2 : 0 },
  }
}

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ activeModal: null, workspace: 'cam', brepImportError: null } as never)
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    } as never)
  })
})

function seed(row: ImportedGeometry) {
  act(() => { useCamStore.setState((s) => ({ project: { ...s.project, geometry: [row] } })) })
}

describe('DesignTree boolean-result badge', () => {
  it('an approximate result shows an "approx" badge', () => {
    seed(resultRow(true))
    render(<DesignTree />)
    const badge = screen.getByTestId('boolean-badge-r1')
    expect(badge.textContent).toBe('approx')
    expect(badge.className).toMatch(/badge-warning/)
  })

  it('an exact result shows an "exact" badge (never falsely "approx")', () => {
    seed(resultRow(false))
    render(<DesignTree />)
    const badge = screen.getByTestId('boolean-badge-r1')
    expect(badge.textContent).toBe('exact')
    expect(badge.className).toMatch(/badge-neutral/)
  })
})
