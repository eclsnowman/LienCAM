// @vitest-environment jsdom
//
// WO-2451: right-click Export... on a sketch, a setup and an operation in the
// design tree opens the one Export window (WO-2448) with that item picked.
// Everything else in those menus stays as it was.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

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

const { DesignTree } = await import('../../components/panels/DesignTree')
const { ExportModal } = await import('../../components/modals/ExportModal')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
import type { ImportedGeometry, Operation, Setup } from '../../types'
import type { Sketch } from '../../lib/sketch/types'

const st = () => useCamStore.getState()

const sketch = {
  id: 'sk-1', layerId: 'layer-1', ownerGeometryId: 'g-sketches', constraints: [], dimensions: [], solveStatus: null,
  entities: [{ id: 'e1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: 25, y: 10 } }],
} as unknown as Sketch
const sketches = {
  id: 'g-sketches', name: 'Sketches', filename: '', type: '2d', format: 'sketch',
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 1 } },
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  layers2d: [{ id: 'layer-1', name: 'Bracket outline', visible: true, sourceType: 'sketch' }], sketches: [sketch], loops: [],
} as unknown as ImportedGeometry
const setup = {
  id: 'su1', name: 'Setup A',
  wcs: { id: 'w1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 } },
  operations: [{
    id: 'op1', name: 'Contour 1', type: 'contour_2d', enabled: true, status: 'pending', toolId: 't1',
    geometrySelections: [], heights: {}, passes: {}, linking: {}, params: {},
  } as unknown as Operation],
  notes: '',
} as unknown as Setup

beforeEach(() => {
  act(() => {
    st().newProject()
    useCamStore.setState((s) => ({
      activeModal: null, workspace: 'cam', activeSketch: null,
      project: { ...s.project, geometry: [sketches], setups: [setup], activeSetupId: 'su1', activeOperationId: null },
    }))
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: ['su1'], expandedStockIds: [],
    })
  })
})

afterEach(() => {
  act(() => { st().closeModal() })
  cleanup()
})

function exportFrom(testId: string, pickedRow: string) {
  render(<><DesignTree /><ExportModal /></>)
  fireEvent.contextMenu(screen.getAllByTestId(testId)[0])
  const menu = screen.getByTestId('tree-context-menu')
  const item = Array.from(menu.querySelectorAll('button')).find((b) => b.textContent === 'Export...')!
  expect(item).toBeTruthy()
  fireEvent.click(item)
  expect(st().activeModal).toBe('export')
  const row = screen.getByTestId(`export-row-${pickedRow}`)
  expect(row.getAttribute('aria-current')).toBe('true')
}

describe('design tree right-click Export...', () => {
  it('operation -> its toolpath row is picked', () => { exportFrom('tree-name-op', 'toolpath:su1:op1') })
  it('setup -> the setups row is picked', () => { exportFrom('tree-name-setup', 'setups') })
  it('sketch layer -> its sketch row is picked', () => { exportFrom('tree-name-layer', 'sketch:g-sketches:layer-1') })

  it('menus are otherwise unchanged: Export... only added, Delete still last', () => {
    render(<DesignTree />)
    fireEvent.contextMenu(screen.getAllByTestId('tree-name-op')[0])
    const actions = Array.from(screen.getByTestId('tree-context-menu').querySelectorAll('button')).map((b) => b.getAttribute('data-action'))
    expect(actions).toEqual([
      'op-edit', 'op-regenerate', 'op-toggle-enabled', 'op-duplicate', 'op-rename',
      'op-move-up', 'op-move-down', 'export', 'op-delete',
    ])
  })

  it('a row type with no Export row (stock) gets no Export... entry', () => {
    act(() => { useCamStore.setState((s) => ({ project: { ...s.project, geometry: [], setups: [] } })) })
    render(<DesignTree />)
    const stock = screen.queryAllByTestId('tree-name-stock-auto')[0] ?? screen.queryAllByTestId('tree-name-stock-fixed')[0]
    if (!stock) return
    fireEvent.contextMenu(stock)
    expect(screen.getByTestId('tree-context-menu').querySelector('[data-action="export"]')).toBeNull()
  })
})
