// @vitest-environment jsdom
//
// PP-SELECTION-UTILITY Stage 1: render-gate + interaction tests for the new
// Properties-panel quick wins (coordination/reports/PP-SELECTION-UTILITY.recon.md
// stage 1). The repo's vitest env is 'node' by default; the directive above
// flips THIS file to jsdom so a real React tree can mount.
//
// WHY THIS GATE EXISTS: a hooks-order bug ("Rendered more hooks than during
// the previous render") shipped once because a hook sat below an early
// return and tsc + the pure-logic suite did not catch it
// (feedback_render_gate_ui_changes). Stage 1 added several new useCamStore
// selectors + a useState to GeometryProperties, and new hooks to
// SetupProperties/ModelItemPlacementProperties/OperationProperties — every
// new branch gets a real mount here, not just a props-shape assertion.
//
// WHAT IT ASSERTS, per selection type:
//  - GeometryProperties (imported DXF part): Size (bbox), owning-stock
//    select, action row (Edit/Show-hide/Duplicate/Delete) all reuse the
//    SAME store actions the tree's row buttons call; a layer list renders.
//  - SetupProperties: Edit button opens the SAME edit-setup modal state the
//    tree's Settings2 button opens; WCS origin renders.
//  - ModelItemPlacementProperties: Edit/Rename/Delete buttons reuse
//    openModelItem/renameModelItem/removeModelItem; body count + folder show.
//  - OperationProperties: Duplicate/Rename/Delete reuse
//    duplicateOperation/updateOperation/removeOperation.

import { answerPendingConfirm } from '../components/confirmDialog.support'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import type { BoundingBox, ImportedGeometry, Operation, PhysicalStock, Setup } from '../../types'

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

const { PropertiesPanel } = await import('../../components/panels/PropertiesPanel')
const { useCamStore } = await import('../../store')

afterEach(cleanup)

beforeEach(() => {
  act(() => { useCamStore.getState().newProject() })
})

function box(w: number, h: number, d: number): BoundingBox {
  return {
    min: { x: 0, y: 0, z: 0 }, max: { x: w, y: h, z: d },
    size: { x: w, y: h, z: d }, center: { x: w / 2, y: h / 2, z: d / 2 },
  }
}

function explicitStock(id: string, name: string): PhysicalStock {
  return { id, name, mode: 'explicit', bounds: box(200, 100, 20), position: { x: 0, y: 0, z: 0 } }
}

describe('PP-SELECTION-UTILITY Stage 1: GeometryProperties (imported DXF part)', () => {
  function dxfGeo(): ImportedGeometry {
    return {
      id: 'geo-1', name: 'Bracket Outline', filename: 'bracket.dxf', type: 'curves_2d', format: 'dxf',
      boundingBox: box(150, 75, 0),
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      layers2d: [{ id: 'layer-1', name: 'Outline', color: '#4ac3ff', visible: true }],
      loops: [{ id: 'loop-1', layerId: 'layer-1', type: 'contour', points: [], area: 100 }],
    } as unknown as ImportedGeometry
  }

  // newProject() always seeds a default derived (migrated) PhysicalStock, so
  // "no stocks at all" is not a reachable project state; the gate
  // (project.stocks?.length ?? 0) > 0 -- byte-identical to the tree's own
  // gate -- is exercised for real by every other test in this block, so a
  // separate "select is absent" case would need a hand-built empty-stocks
  // state that never occurs in practice. Instead this seed adds ONE named
  // stock the geo is explicitly (locked) pinned to, and mirrors it into
  // sceneStock.fixedStocks so the <select>'s initial value matches a real
  // <option> -- exactly the coupling DesignTree.tsx's own dropdown relies on.
  function seed() {
    const geo: ImportedGeometry = { ...dxfGeo(), stockId: 'st-1', stockIdLocked: true }
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [geo],
          stocks: [explicitStock('st-1', 'Sheet Stock')],
          sceneStock: {
            ...s.project.sceneStock,
            fixedStocks: [
              { id: 'st-1', name: 'Sheet Stock', width: 200, height: 100, depth: 20, position: { x: 0, y: 0, z: 0 } },
            ],
          },
        },
      }))
      useCamStore.getState().setSelectedGeometry('geo-1')
    })
    return geo
  }

  it('mounts without throwing and shows Size, action row, layer list, and the owning-stock select (guards hooks-order)', () => {
    seed()
    render(<PropertiesPanel />)
    expect(screen.getByText('Properties')).not.toBeNull()
    expect(screen.getByTestId('geo-bbox-size').textContent).toContain('150')
    expect(screen.getByTestId('geo-bbox-size').textContent).toContain('75')
    expect(screen.getByTestId('geo-action-row')).not.toBeNull()
    expect(screen.getByTestId('geo-edit-sketch-btn')).not.toBeNull()
    expect(screen.getByTestId('geo-visibility-btn')).not.toBeNull()
    expect(screen.getByTestId('geo-duplicate-btn')).not.toBeNull()
    expect(screen.getByTestId('geo-delete-btn')).not.toBeNull()
    expect(screen.getByTestId('geo-layer-row-layer-1')).not.toBeNull()
    const select = screen.getByTestId('geo-stock-select') as HTMLSelectElement
    expect(select.value).toBe('st-1')
  })

  it('picking "None" from the select calls setGeometryNoStock (same action the tree dropdown calls)', () => {
    seed()
    render(<PropertiesPanel />)
    const select = screen.getByTestId('geo-stock-select') as HTMLSelectElement
    fireEvent.change(select, { target: { value: '__none__' } })
    expect(useCamStore.getState().project.geometry[0].stockId).toBeUndefined()
    expect(useCamStore.getState().project.geometry[0].stockIdLocked).toBe(true)
  })

  it('Delete (confirmed) removes the geometry row via removeGeometry', async () => {
    seed()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('geo-delete-btn'))
    await answerPendingConfirm(true)  // WO-1268: the themed confirm, via the store seam
    await waitFor(() => expect(useCamStore.getState().project.geometry.find((g) => g.id === 'geo-1')).toBeUndefined())
  })

  it('Delete (cancelled) leaves the geometry row untouched', async () => {
    seed()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('geo-delete-btn'))
    await answerPendingConfirm(false)
    expect(useCamStore.getState().project.geometry.find((g) => g.id === 'geo-1')).not.toBeUndefined()
  })

  it('Show/hide toggles all layers of a 2D part (same store action as the tree)', () => {
    seed()
    render(<PropertiesPanel />)
    expect(useCamStore.getState().project.geometry[0].layers2d![0].visible).toBe(true)
    fireEvent.click(screen.getByTestId('geo-visibility-btn'))
    expect(useCamStore.getState().project.geometry[0].layers2d![0].visible).toBe(false)
  })
})

describe('PP-SELECTION-UTILITY Stage 1: SetupProperties action row + WCS origin', () => {
  function seedSetup(): Setup {
    const setup = {
      id: 'setup-1', name: 'Setup A', operations: [],
      wcs: { label: 'G54', origin: { x: 10, y: 20, z: 5 } }, stock: { type: 'auto' }, notes: '',
    } as unknown as Setup
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, setups: [setup] } }))
      useCamStore.getState().setActiveSetup(setup.id)
    })
    return setup
  }

  it('mounts, shows the WCS origin, and the Edit button opens the SAME edit-setup modal state the tree uses', () => {
    seedSetup()
    render(<PropertiesPanel />)
    expect((screen.getByLabelText(/WCS origin X/) as HTMLInputElement).value).toBe('10')
    expect(screen.getByTestId('setup-action-row')).not.toBeNull()
    fireEvent.click(screen.getByTestId('setup-edit-btn'))
    expect(useCamStore.getState().activeModal).toBe('edit-setup')
    expect(useCamStore.getState().editingSetupId).toBe('setup-1')
  })
})

describe('PP-SELECTION-UTILITY Stage 1: ModelItemPlacementProperties action row', () => {
  function modelGeo(): ImportedGeometry {
    return {
      id: 'modelbody:item-a:b1', name: 'Bracket', filename: 'Bracket', type: 'brep', format: 'model',
      boundingBox: box(1, 1, 1),
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
      modelItemId: 'item-a',
      modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 } },
    } as unknown as ImportedGeometry
  }

  beforeEach(() => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [modelGeo()],
          modelItems: [{ id: 'item-a', name: 'Bracket Item', documentState: 'empty' }],
          modelItemPlacements: [
            { modelItemId: 'item-a', position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 } },
          ],
        },
      }))
      useCamStore.getState().setSelectedGeometry('modelbody:item-a:b1')
    })
  })

  it('mounts and shows body count, folder, and the action row (guards hooks-order)', () => {
    render(<PropertiesPanel />)
    expect(screen.getByTestId('model-item-body-count').textContent).toBe('1')
    expect(screen.getByTestId('model-item-action-row')).not.toBeNull()
  })

  it('Edit calls the SAME openModelItem the tree PenTool button calls', () => {
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('model-item-edit-btn'))
    expect(useCamStore.getState().workspace).toBe('part')
    expect(useCamStore.getState().activeModelItemId).toBe('item-a')
  })

  it('Rename calls renameModelItem with the prompted name', () => {
    render(<PropertiesPanel />)
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Bracket')
    fireEvent.click(screen.getByTestId('model-item-rename-btn'))
    expect(useCamStore.getState().project.modelItems?.find((m) => m.id === 'item-a')?.name).toBe('Renamed Bracket')
    promptSpy.mockRestore()
  })

  it('Delete (confirmed) cascades to removeModelItem and its dependent geometry row', async () => {
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('model-item-delete-btn'))
    await answerPendingConfirm(true)  // WO-1268: the themed confirm, via the store seam
    await waitFor(() => expect(useCamStore.getState().project.modelItems?.find((m) => m.id === 'item-a')).toBeUndefined())
    expect(useCamStore.getState().project.geometry.find((g) => g.id === 'modelbody:item-a:b1')).toBeUndefined()
  })
})

describe('PP-SELECTION-UTILITY Stage 1: OperationProperties action row', () => {
  function seedOp(): { setup: Setup; op: Operation } {
    const op = {
      id: 'op-1', name: 'Contour 1', type: 'contour', toolId: 't1', enabled: true, status: 'pending',
      heights: { clearanceHeight: 10, retractHeight: 5, topHeight: 0, bottomHeight: -5 },
      passes: { stepdown: 2, stepover: 1, stockToLeave: 0 },
      geometrySelections: [], params: {},
    } as unknown as Operation
    const setup = {
      id: 'setup-1', name: 'Setup A', operations: [op],
      wcs: { label: 'G54', origin: { x: 0, y: 0, z: 0 } }, stock: { type: 'auto' }, notes: '',
    } as unknown as Setup
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, setups: [setup] } }))
      useCamStore.getState().setActiveSetup(setup.id)
      useCamStore.getState().setActiveOperation(op.id)
    })
    return { setup, op }
  }

  it('mounts and shows the action row (guards hooks-order)', () => {
    seedOp()
    render(<PropertiesPanel />)
    expect(screen.getByTestId('op-action-row')).not.toBeNull()
  })

  it('Duplicate calls the SAME duplicateOperation the context menu calls', () => {
    seedOp()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('op-duplicate-btn'))
    expect(useCamStore.getState().project.setups[0].operations.length).toBe(2)
  })

  it('Delete removes the operation without prompting and Undo restores it', () => {
    seedOp()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('op-delete-btn'))
    expect(useCamStore.getState().project.setups[0].operations.length).toBe(0)
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.setups[0].operations.map((candidate) => candidate.id)).toEqual(['op-1'])
  })

  it('Rename calls updateOperation with the prompted name', () => {
    seedOp()
    render(<PropertiesPanel />)
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Op')
    fireEvent.click(screen.getByTestId('op-rename-btn'))
    expect(useCamStore.getState().project.setups[0].operations[0].name).toBe('Renamed Op')
    promptSpy.mockRestore()
  })
})
