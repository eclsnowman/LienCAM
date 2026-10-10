// @vitest-environment jsdom
//
// React-render SMOKE tests for clutter-audit item P13: promote "Edit sketch"
// for sketch-editable design-tree layers, per feedback_render_gate_ui_changes
// (tsc + model tests miss render wiring + event-bubbling bugs):
//
//   (a) Double-clicking the layer ROW BODY opens sketch edit (openSketchForLayer)
//       for a sketch-editable layer. Double-clicking the NAME text does NOT —
//       it starts inline rename (the name span stops propagation).
//   (b) Right-clicking a sketch-editable layer opens a menu whose FIRST item
//       is "Edit sketch"; clicking it calls openSketchForLayer with the layer/geo ids.
//
// openSketchForLayer is spied on the real store so we assert the exact call
// without opening a sketch session.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'

// In-memory localStorage shim BEFORE importing the store (zustand persist).
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
const { useCamStore } = await import('../../store')
const { useUiPrefs } = await import('../../store/uiPrefs')

afterEach(cleanup)

const st = () => useCamStore.getState()

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ activeModal: null })
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
  })
})

function seedSketchEditableLayer() {
  act(() => {
    st().addGeometry({
      id: 'g1', name: 'PartOne', filename: 'p.dxf', type: 'curves_2d', format: 'dxf',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
        size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      layers2d: [{ id: 'lyr1', name: 'Outline', color: '#ff0000', visible: true }],
      loops: [{ id: 'lp1', layerId: 'lyr1', closed: true, type: 'contour', area: 50,
        points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }] }],
    })
  })
}

/** The row body is the layer row DIV; find it via a stable child (the count span). */
function layerRow(): HTMLElement {
  const name = screen.getByTestId('tree-name-layer')
  return name.closest('.tree-layer-row') as HTMLElement
}

describe('IMPORT-PROVENANCE-MARK: geometry row badge', () => {
  it('renders the shared neutral badge only for an edited import-origin layer', () => {
    seedSketchEditableLayer()
    render(<DesignTree />)

    expect(screen.queryByTestId('import-edited-badge-g1')).toBeNull()

    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: s.project.geometry.map((geo) => geo.id === 'g1'
            ? {
                ...geo,
                layers2d: geo.layers2d?.map((layer) => ({
                  ...layer,
                  sourceEdited: true as const,
                })),
              }
            : geo),
        },
      }))
    })
    expect(screen.queryByTestId('import-edited-badge-g1')).toBeNull()

    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: s.project.geometry.map((geo) => geo.id === 'g1'
            ? {
                ...geo,
                layers2d: geo.layers2d?.map((layer) => ({
                  ...layer,
                  sourceOrigin: 'import' as const,
                })),
              }
            : geo),
        },
      }))
    })

    const badge = screen.getByTestId('import-edited-badge-g1')
    expect(badge.textContent).toBe('edited')
    expect(badge.classList.contains('badge')).toBe(true)
    expect(badge.classList.contains('badge-neutral')).toBe(true)
    expect(badge.getAttribute('data-tooltip')).toContain('may no longer match its source file')
  })
})

describe('P13a: row-body double-click opens sketch edit', () => {
  it('double-clicking the row body calls openSketchForLayer(layerId, geoId)', () => {
    seedSketchEditableLayer()
    const spy = vi.spyOn(st(), 'openSketchForLayer').mockReturnValue(true)
    render(<DesignTree />)
    fireEvent.doubleClick(layerRow())
    expect(spy).toHaveBeenCalledWith('lyr1', 'g1')
    spy.mockRestore()
  })

  it('double-clicking the NAME text starts rename, NOT sketch edit', () => {
    seedSketchEditableLayer()
    const spy = vi.spyOn(st(), 'openSketchForLayer').mockReturnValue(true)
    render(<DesignTree />)
    fireEvent.doubleClick(screen.getByTestId('tree-name-layer'))
    // Rename input appeared; sketch edit was not triggered.
    expect(screen.getByTestId('tree-rename-input')).toBeTruthy()
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})

describe('P13b: right-click menu has Edit sketch first', () => {
  it('opens a menu whose first item is Edit sketch; clicking it calls openSketchForLayer', () => {
    seedSketchEditableLayer()
    const spy = vi.spyOn(st(), 'openSketchForLayer').mockReturnValue(true)
    render(<DesignTree />)
    fireEvent.contextMenu(layerRow())

    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))
    // FIRST menu item is Edit sketch (the P13 requirement).
    expect(buttons[0].textContent).toBe('Edit sketch')
    expect(buttons[0].getAttribute('data-action')).toBe('layer-edit-sketch')

    fireEvent.click(buttons[0])
    expect(spy).toHaveBeenCalledWith('lyr1', 'g1')
    spy.mockRestore()
  })
})
