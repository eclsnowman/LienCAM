// @vitest-environment jsdom
//
// PP-SELECTION-UTILITY Stage 2: render-gate + interaction tests for the next
// tranche of Properties-panel quick wins (coordination/reports/
// PP-SELECTION-UTILITY.recon.md), landing on top of Stage 1
// (coordination/reports/PP-UTILITY-S1.report.md). The repo's vitest env is
// 'node' by default; the directive above flips THIS file to jsdom so a real
// React tree can mount (feedback_render_gate_ui_changes).
//
// WHAT IT ASSERTS, per selection type:
//  - B-rep face/edge picks: quantitative area/length/normal computed from the
//    ALREADY-FETCHED BrepModelPayload mesh (no new kernel query), plus
//    per-pick Clear and Clear-all reusing setBrepSelections.
//  - Fixed stock: Rename/Remove action row (updateFixedStock/removeFixedStock,
//    the SAME actions the tree's TreeRenameLabel/Trash2 button call) + the
//    bound nest's NAME (not just a generic hint).
//  - Auto stock: Offset XY/Z become EDITABLE (parity fix — the tree already
//    allowed this), a member-parts list, and a Rename/Remove action row.
//  - Nest: Edit (reopens the New Nest modal prefilled via
//    setNestEditTarget+openModal, same as the tree's Pencil button),
//    Hide/Show (setNestVisible), and Delete (removeNest) — all three were
//    tree-only before this pass.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent } from '@testing-library/react'
import type { BoundingBox, FixedStockItem, AutoStockItem, ImportedGeometry, NestRecord } from '../../types'

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
const { setBrepPayload, removeBrepPayload } = await import('../../lib/cam/geometry/occt/model/modelClient')

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

describe('PP-SELECTION-UTILITY Stage 2: BrepSelectionInfo quantitative pick info', () => {
  const GEO_ID = 'brep-part'

  function seedPayload() {
    // One planar right-triangle face (area = 0.5 * base * height = 0.5 mm^2,
    // normal +Z) and one 2-point edge of length 5 (a 3-4-5 segment) — hand
    // computable so the panel's reduction over the mesh can be asserted
    // exactly, not just "renders something".
    setBrepPayload(GEO_ID, {
      faceCount: 1, edgeCount: 1, solidCount: 1,
      bbox: { min: [0, 0, 0], max: [1, 1, 0] },
      mesh: {
        positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
        normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
        indices: new Uint32Array([0, 1, 2]),
        faceRanges: new Uint32Array([0, 3]),
      },
      edges: {
        positions: new Float32Array([0, 0, 0, 3, 4, 0]),
        edgeRanges: new Uint32Array([0, 2]),
      },
      faceTypes: new Uint8Array([0]),  // Plane
    })
  }

  function seedGeo(): ImportedGeometry {
    return {
      id: GEO_ID, name: 'Bracket', filename: 'bracket.step', type: 'brep', format: 'step',
      boundingBox: box(1, 1, 1),
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    } as unknown as ImportedGeometry
  }

  beforeEach(() => {
    seedPayload()
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [seedGeo()] },
        viewer: {
          ...s.viewer,
          brepSelections: [
            { geoId: GEO_ID, kind: 'face', index: 0 },
            { geoId: GEO_ID, kind: 'edge', index: 0 },
          ],
        },
      }))
    })
  })

  afterEach(() => removeBrepPayload(GEO_ID))

  it('shows computed face area + normal, and edge length, reduced from the ALREADY-fetched mesh (guards hooks-order)', () => {
    render(<PropertiesPanel />)
    expect(screen.getByTestId('brep-selection-header').textContent).toContain('2')
    const labels = screen.getAllByTestId('brep-selection-label')
    expect(labels[0].textContent).toContain('Face 0 (Plane)')
    expect(labels[0].textContent).toContain('area 0.50 mm^2')
    expect(labels[0].textContent).toContain('normal (0.000, 0.000, 1.000)')
    expect(labels[1].textContent).toContain('Edge 0')
    expect(labels[1].textContent).toContain('length 5.00 mm')
  })

  it('per-pick Clear removes only that pick via setBrepSelections', () => {
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId(`brep-selection-clear-${GEO_ID}-face-0`))
    expect(useCamStore.getState().viewer.brepSelections).toEqual([
      { geoId: GEO_ID, kind: 'edge', index: 0 },
    ])
  })

  it('Clear all empties brepSelections', () => {
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('brep-selection-clear-all-btn'))
    expect(useCamStore.getState().viewer.brepSelections).toEqual([])
  })
})

describe('PP-SELECTION-UTILITY Stage 2: FixedStockProperties action row + nest binding name', () => {
  function seedFixedStock(nestBound: boolean): FixedStockItem {
    const stock: FixedStockItem = {
      id: 'fs-1', name: 'Sheet Block', width: 200, height: 100, depth: 20,
      position: { x: 0, y: 0, z: 0 },
    }
    const nests: NestRecord[] = nestBound ? [{
      id: 'nest-1', name: 'Sheet Nest', boundStockId: 'fs-1',
      sheet: { width: 200, height: 100 }, spacing: { partGap: 2, sheetMargin: 5 },
      style: 'ninety', sources: [], placements: [], unplaced: [], utilization: 0.5, seed: 1,
    } as unknown as NestRecord] : []
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          sceneStock: { ...s.project.sceneStock, fixedStocks: [stock] },
          ...(nestBound ? { nests } : {}),
        },
      }))
      useCamStore.getState().setSelectedStock('fs-1')
    })
    return stock
  }

  it('mounts with the action row and Rename/Remove wired (guards hooks-order)', () => {
    seedFixedStock(false)
    render(<PropertiesPanel />)
    expect(screen.getByTestId('stock-fixed-action-row')).not.toBeNull()
  })

  it('Rename calls updateFixedStock with the prompted name (same action the tree commits through)', () => {
    seedFixedStock(false)
    render(<PropertiesPanel />)
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Block')
    fireEvent.click(screen.getByTestId('stock-fixed-rename-btn'))
    expect(useCamStore.getState().project.sceneStock.fixedStocks?.[0].name).toBe('Renamed Block')
    promptSpy.mockRestore()
  })

  it('Remove deletes fixed stock without prompting and Undo restores it', () => {
    seedFixedStock(false)
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('stock-fixed-remove-btn'))
    expect(useCamStore.getState().project.sceneStock.fixedStocks ?? []).toEqual([])
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.sceneStock.fixedStocks?.map((stock) => stock.id)).toEqual(['fs-1'])
  })

  it('shows the bound nest by NAME when one is bound', () => {
    seedFixedStock(true)
    render(<PropertiesPanel />)
    expect(screen.getByTestId('stock-fixed-nest-binding').textContent).toContain('Sheet Nest')
  })
})

describe('PP-SELECTION-UTILITY Stage 2: AutoStockProperties editable offsets + members + action row', () => {
  function seedAutoStock(): AutoStockItem {
    const stock: AutoStockItem = { id: 'as-1', name: 'Auto A', autoOffsetXY: 5, autoOffsetZTop: 3 }
    const member: ImportedGeometry = {
      id: 'geo-m1', name: 'Member Part', filename: 'm.dxf', type: 'curves_2d', format: 'dxf',
      boundingBox: box(10, 10, 0), position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      loaded: true, stockId: 'as-1',
    } as unknown as ImportedGeometry
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [member],
          sceneStock: { ...s.project.sceneStock, autoStocks: [stock] },
        },
      }))
      useCamStore.getState().setSelectedStock('as-1')
    })
    return stock
  }

  it('mounts with editable Offset XY/Z, member list, and the action row (guards hooks-order)', () => {
    seedAutoStock()
    render(<PropertiesPanel />)
    expect(screen.getByTestId('stock-auto-offset-xy').querySelector('input')).not.toBeNull()
    expect(screen.getByTestId('stock-auto-offset-z').querySelector('input')).not.toBeNull()
    expect(screen.getByTestId('stock-auto-offset-z-bottom').querySelector('input')).not.toBeNull() // AUTO-STOCK-BOTTOM
    expect(screen.getByTestId('stock-auto-member-geo-m1').textContent).toContain('Member Part')
    expect(screen.getByTestId('stock-auto-action-row')).not.toBeNull()
  })

  it('AUTO-STOCK-BOTTOM: editing Offset Z bottom commits through updateAutoStock', () => {
    seedAutoStock()
    render(<PropertiesPanel />)
    const input = screen.getByTestId('stock-auto-offset-z-bottom').querySelector('input')!
    fireEvent.change(input, { target: { value: '7' } })
    fireEvent.blur(input)
    expect(useCamStore.getState().project.sceneStock.autoStocks?.[0].autoOffsetZBottom).toBe(7)
  })

  it('editing Offset XY commits through updateAutoStock (parity fix: was read-only)', () => {
    seedAutoStock()
    render(<PropertiesPanel />)
    const input = screen.getByTestId('stock-auto-offset-xy').querySelector('input')!
    fireEvent.change(input, { target: { value: '12' } })
    fireEvent.blur(input)
    expect(useCamStore.getState().project.sceneStock.autoStocks?.[0].autoOffsetXY).toBe(12)
  })

  it('Rename calls updateAutoStock with the prompted name', () => {
    seedAutoStock()
    render(<PropertiesPanel />)
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('Renamed Auto')
    fireEvent.click(screen.getByTestId('stock-auto-rename-btn'))
    expect(useCamStore.getState().project.sceneStock.autoStocks?.[0].name).toBe('Renamed Auto')
    promptSpy.mockRestore()
  })

  it('Remove deletes auto stock without prompting and Undo restores it', () => {
    seedAutoStock()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('stock-auto-remove-btn'))
    expect(useCamStore.getState().project.sceneStock.autoStocks ?? []).toEqual([])
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.sceneStock.autoStocks?.map((stock) => stock.id)).toEqual(['as-1'])
  })
})

describe('PP-SELECTION-UTILITY Stage 2: NestProperties Edit/Hide-show/Delete action row', () => {
  function seedNest(): NestRecord {
    const nest = {
      id: 'nest-1', name: 'Panel Nest', visible: true,
      sheet: { width: 300, height: 200 }, spacing: { partGap: 2, sheetMargin: 5, windowGap: 1 },
      style: 'ninety', solver: { kind: 'fixSheet' }, sources: [],
      placements: [{ partId: 'seed-a', instanceId: 'seed-a#0', x: 10, y: 20, rotationDeg: 0, depth: 0 }],
      unplaced: [], utilization: 0.6, seed: 7,
    } as unknown as NestRecord
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, nests: [nest] } }))
      useCamStore.getState().setSelectedNest('nest-1')
    })
    return nest
  }

  it('mounts with the action row (guards hooks-order)', () => {
    seedNest()
    render(<PropertiesPanel />)
    expect(screen.getByTestId('nest-action-row')).not.toBeNull()
  })

  it('Edit calls setNestEditTarget + opens the SAME new-nest modal the tree Pencil button opens', () => {
    seedNest()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('nest-edit-props'))
    expect(useCamStore.getState().nestEditTarget).toBe('nest-1')
    expect(useCamStore.getState().activeModal).toBe('new-nest')
  })

  it('Hide/Show toggles nest.visible via setNestVisible', () => {
    seedNest()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('nest-visibility-props'))
    expect(useCamStore.getState().project.nests?.[0].visible).toBe(false)
    fireEvent.click(screen.getByTestId('nest-visibility-props'))
    expect(useCamStore.getState().project.nests?.[0].visible).toBe(true)
  })

  it('Delete removes the nest without prompting and Undo restores it', () => {
    seedNest()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('nest-delete-props'))
    expect(useCamStore.getState().project.nests ?? []).toEqual([])
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.nests?.map((nest) => nest.id)).toEqual(['nest-1'])
  })

  it('Explode removes the nest without prompting and Undo restores it', () => {
    seedNest()
    render(<PropertiesPanel />)
    fireEvent.click(screen.getByTestId('nest-explode-props'))
    expect(useCamStore.getState().project.nests ?? []).toEqual([])
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.nests?.map((nest) => nest.id)).toEqual(['nest-1'])
  })

  it('edits pack inputs inline with one-step undo, stale marking, and prior-result preservation', () => {
    const original = seedNest()
    render(<PropertiesPanel />)

    fireEvent.change(screen.getByTestId('nest-style-props'), { target: { value: 'arbitrary' } })
    expect(useCamStore.getState().project.nests?.[0]).toMatchObject({
      style: 'arbitrary', rotationCount: 4, needsRecompute: true,
      placements: original.placements,
    })
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.nests?.[0]).toMatchObject({ style: 'ninety' })
    expect(useCamStore.getState().project.nests?.[0].needsRecompute).toBeUndefined()

    const partGap = screen.getByLabelText('Nest part gap')
    fireEvent.focus(partGap)
    fireEvent.change(partGap, { target: { value: '3.5' } })
    fireEvent.blur(partGap)
    expect(useCamStore.getState().project.nests?.[0]).toMatchObject({
      spacing: { partGap: 3.5, sheetMargin: 5, windowGap: 1 },
      needsRecompute: true,
      placements: original.placements,
    })
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.nests?.[0].spacing.partGap).toBe(2)

    const sheetMargin = screen.getByLabelText('Nest sheet margin')
    fireEvent.focus(sheetMargin)
    fireEvent.change(sheetMargin, { target: { value: '6.5' } })
    fireEvent.blur(sheetMargin)
    expect(useCamStore.getState().project.nests?.[0]).toMatchObject({
      spacing: { partGap: 2, sheetMargin: 6.5, windowGap: 1 },
      needsRecompute: true,
      placements: original.placements,
    })

    const windowGap = screen.getByLabelText('Nest window gap')
    fireEvent.focus(windowGap)
    fireEvent.change(windowGap, { target: { value: '2.5' } })
    fireEvent.blur(windowGap)
    expect(useCamStore.getState().project.nests?.[0]).toMatchObject({
      spacing: { partGap: 2, sheetMargin: 6.5, windowGap: 2.5 },
      needsRecompute: true,
      placements: original.placements,
    })
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.nests?.[0].spacing).toEqual({
      partGap: 2, sheetMargin: 6.5, windowGap: 1,
    })
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.nests?.[0].spacing).toEqual({
      partGap: 2, sheetMargin: 5, windowGap: 1,
    })

    fireEvent.change(screen.getByTestId('nest-solver-props'), { target: { value: 'fixSheet-exact' } })
    expect(useCamStore.getState().project.nests?.[0]).toMatchObject({
      solver: { kind: 'fixSheetExact' }, needsRecompute: true,
      placements: original.placements,
    })
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.nests?.[0].solver).toEqual({ kind: 'fixSheet' })

    const seed = screen.getByLabelText('Nest random seed')
    fireEvent.focus(seed)
    fireEvent.change(seed, { target: { value: '42' } })
    fireEvent.blur(seed)
    expect(useCamStore.getState().project.nests?.[0]).toMatchObject({
      seed: 42, needsRecompute: true, placements: original.placements,
    })
    act(() => useCamStore.getState().undo())
    expect(useCamStore.getState().project.nests?.[0].seed).toBe(7)
  })

  it('shows a stored fixed-ratio solver truthfully and only changes it when another modal solver is chosen', () => {
    seedNest()
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          nests: s.project.nests?.map((nest) => ({
            ...nest,
            solver: { kind: 'fixQtyRatio' as const, ratio: 1.5 },
          })),
        },
      }))
    })
    render(<PropertiesPanel />)

    const solver = screen.getByTestId('nest-solver-props') as HTMLSelectElement
    expect(solver.value).toBe('fixQtyRatio')
    expect(solver.selectedOptions[0].textContent).toContain('fixed ratio')

    fireEvent.change(solver, { target: { value: 'fixQty-width' } })
    expect(useCamStore.getState().project.nests?.[0]).toMatchObject({
      solver: { kind: 'fixQty', lockedAxis: 'width' },
      needsRecompute: true,
    })
  })
})
