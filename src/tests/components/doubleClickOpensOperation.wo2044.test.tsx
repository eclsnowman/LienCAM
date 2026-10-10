// @vitest-environment jsdom
//
// WO-2044 Tier 2: drive the real DesignTree and store routes. Operation rows
// have two render paths (setup root and operation folder), and both must open
// the existing operation editor on double-click. Rename remains available via
// F2 and the context menu; setup and geometry name gestures stay unchanged.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key: string) => mem.get(key) ?? null,
  key: (index: number) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key: string) => { mem.delete(key) },
  setItem: (key: string, value: string) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { DesignTree } = await import('../../components/panels/DesignTree')
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')
type Operation = import('../../types').Operation
type Setup = import('../../types').Setup

const st = () => useCamStore.getState()

function makeOperation(id: string, name: string, folderId?: string): Operation {
  return {
    id, name, type: 'contour_2d', enabled: true, status: 'pending', toolId: 'tool-1',
    geometrySelections: [], heights: {}, passes: {}, linking: {}, params: {},
    ...(folderId ? { folderId } : {}),
  } as unknown as Operation
}

function seedDesignTree({ foldered = false }: { foldered?: boolean } = {}) {
  const folderId = foldered ? 'folder-1' : undefined
  act(() => {
    useCamStore.setState((state) => ({
      activeModal: null,
      editingOpPayload: null,
      project: {
        ...state.project,
        geometry: [{
          id: 'geo-1', name: 'Plate', filename: 'plate.dxf', type: 'curves_2d', format: 'dxf',
          boundingBox: {
            min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
            size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
          },
          position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
        }],
        setups: [{
          id: 'setup-1', name: 'Top Setup',
          wcs: {
            id: 'wcs-1', label: 'G54', fixtureOffset: 54,
            origin: { x: 0, y: 0, z: 0 },
            xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
          },
          operations: [makeOperation('op-1', foldered ? 'Folder Contour' : 'Root Contour', folderId)],
          operationFolders: foldered ? [{ id: folderId!, name: 'Finishing', parentId: null }] : [],
          notes: '',
        } as unknown as Setup],
        activeSetupId: 'setup-1',
        activeOperationId: null,
      },
    }))
    useUiPrefs.setState({
      treeGeometryExpanded: true,
      treeSetupsExpanded: true,
      expandedSetupIds: ['setup-1'],
      collapsedOperationFolderIds: [],
    })
  })
}

function operationLabel(name: string) {
  return screen.getAllByTestId('tree-name-op').find((node) => node.textContent === name)!
}

function expectEditorOpen() {
  expect(st().activeModal).toBe('edit-operation')
  expect(st().editingOpPayload).toEqual({ setupId: 'setup-1', opId: 'op-1' })
  expect(screen.queryByTestId('tree-rename-input')).toBeNull()
}

function clickContextRename() {
  const menu = screen.getByTestId('tree-context-menu')
  const rename = Array.from(menu.querySelectorAll('button')).find((button) => button.textContent === 'Rename')
  expect(rename).toBeTruthy()
  fireEvent.click(rename!)
}

afterEach(cleanup)

beforeEach(() => {
  mem.clear()
  act(() => {
    st().newProject()
    useUiPrefs.setState({
      expandedSetupIds: [],
      collapsedOperationFolderIds: [],
      collapsedFolderIds: [],
      collapsedNestIds: [],
    })
  })
})

describe('WO-2044 operation double-click contract', () => {
  it('double-clicking a root operation name opens that operation editor instead of rename', () => {
    seedDesignTree()
    render(<DesignTree />)

    const label = operationLabel('Root Contour')
    expect(label.getAttribute('data-tooltip')).toBe('Double-click to edit operation')
    fireEvent.doubleClick(label)

    expectEditorOpen()
  })

  it('double-clicking the root operation row body opens the same editor route', () => {
    seedDesignTree()
    render(<DesignTree />)

    const row = operationLabel('Root Contour').closest('.tree-op')!
    fireEvent.doubleClick(row.querySelector('.tree-op-num')!)

    expectEditorOpen()
  })

  it('double-clicking an operation nested in an operation folder also opens its editor', () => {
    seedDesignTree({ foldered: true })
    render(<DesignTree />)

    fireEvent.doubleClick(operationLabel('Folder Contour'))

    expectEditorOpen()
  })

  it('F2 still renames the active operation and does not open its editor', () => {
    seedDesignTree()
    render(<DesignTree />)
    act(() => { st().setActiveOperation('op-1') })

    fireEvent.keyDown(window, { key: 'F2' })
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('Root Contour')
    expect(st().activeModal).toBeNull()

    fireEvent.change(input, { target: { value: 'F2 Renamed' } })
    fireEvent.keyDown(input, { key: 'Enter' })
    expect(st().project.setups[0].operations[0].name).toBe('F2 Renamed')
  })

  it('the operation context menu still renames inline without opening the editor', () => {
    seedDesignTree()
    render(<DesignTree />)

    fireEvent.contextMenu(operationLabel('Root Contour'))
    clickContextRename()

    expect((screen.getByTestId('tree-rename-input') as HTMLInputElement).value).toBe('Root Contour')
    expect(st().activeModal).toBeNull()
  })

  it('setup and geometry name double-clicks keep their inline rename behavior', () => {
    seedDesignTree()
    render(<DesignTree />)

    fireEvent.doubleClick(screen.getByTestId('tree-name-setup'))
    expect((screen.getByTestId('tree-rename-input') as HTMLInputElement).value).toBe('Top Setup')
    expect(st().activeModal).toBeNull()
    fireEvent.keyDown(screen.getByTestId('tree-rename-input'), { key: 'Escape' })

    fireEvent.doubleClick(screen.getByTestId('tree-name-geometry'))
    expect((screen.getByTestId('tree-rename-input') as HTMLInputElement).value).toBe('Plate')
    expect(st().activeModal).toBeNull()
  })

  it('double-clicking an operation action button does not leak into the row gesture', () => {
    seedDesignTree()
    render(<DesignTree />)

    const row = operationLabel('Root Contour').closest('.tree-op')!
    fireEvent.doubleClick(row.querySelector('[aria-label="Suppress operation"]')!)

    expect(st().activeModal).toBeNull()
    expect(st().project.setups[0].operations[0].enabled).toBe(true)
  })
})
