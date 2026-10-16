// @vitest-environment jsdom
//
// GEO-UNIFY Stage 1 (tree unification, coordination/reports/GEO-UNIFY.plan.md
// sec 1): the separate "Model Items" tree section is gone (Operator's explicit
// ruling -- "I don't want another new section called model items"). Model
// items with a body render as their body rows, unchanged, inside the ONE
// Geometry section; an item with ZERO bodies (still empty / in-progress)
// synthesizes a presentation-only placeholder row in that SAME section so it
// is never hidden. This file is the render-gate the plan's own Stage 1 gate
// notes call for: placeholder appears for a 0-body item, disappears once it
// gains a body, cascade delete reaches from a body row, and "Rename model..."
// vs the row's own "Rename" stay two distinct, both-reachable actions.
//
// Harness copied from DesignTreeModelItemDelete.int17cC3.test.tsx.

import { answerPendingConfirm } from './confirmDialog.support'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'

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
type ImportedGeometry = import('../../types').ImportedGeometry

afterEach(cleanup)

const st = () => useCamStore.getState()

function modelGeo(id: string, modelItemId: string, name: string): ImportedGeometry {
  return {
    id, name, filename: name, type: 'brep', format: 'model',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId,
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      display: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2], edgePositions: [], edgeOffsets: [0],
        bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    },
  }
}

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

describe('GEO-UNIFY Stage 1: the separate Model Items section is gone', () => {
  it('no "Model Items" section exists anywhere in the tree', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A' }] },
      }))
    })
    render(<DesignTree />)
    expect(screen.queryByTestId('model-items-section')).toBeNull()
    expect(screen.queryByText('Model Items')).toBeNull()
  })

  it('"New model" lives in the Geometry section header and creates + opens an item', () => {
    render(<DesignTree />)
    const before = (st().project.modelItems ?? []).length

    fireEvent.click(screen.getByTestId('add-model-item-btn'))

    expect((st().project.modelItems ?? []).length).toBe(before + 1)
    expect(st().workspace).toBe('part')
    expect(st().activeModelItemId).not.toBeNull()
  })
})

describe('GEO-UNIFY Stage 1: empty-model placeholder row', () => {
  it('a 0-body model item renders a placeholder row (Box icon + "MODEL (empty)" meta) inside Geometry', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A' }] },
      }))
    })
    render(<DesignTree />)

    const row = screen.getByTestId('model-item-row-item-a')
    expect(row.textContent).toContain('Item A')
    expect(row.textContent).toContain('MODEL (empty)')
    // Lives in the unified Geometry section, not a section of its own.
    expect(screen.getByTestId('geometry-section').contains(row)).toBe(true)
  })

  it('the placeholder disappears once the item gains its first body row', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A' }] },
      }))
    })
    const { rerender } = render(<DesignTree />)
    expect(screen.getByTestId('model-item-row-item-a')).toBeTruthy()

    // Simulate syncModelBodies adding the item's first body row (the actual
    // reconcile machinery, modelBodyAdapter.ts, is unchanged by Stage 1 --
    // this test only pins the TREE's reaction to the row appearing).
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [modelGeo('gA1', 'item-a', 'Bracket')] },
      }))
    })
    rerender(<DesignTree />)

    expect(screen.queryByTestId('model-item-row-item-a')).toBeNull()
    // WO-2858: a modeled body row is qualified by its model's name.
    expect(screen.getByTestId('tree-name-geometry').textContent).toBe('Item A - Bracket')
  })

  it('the Geometry section empty state mentions models when the project is truly empty', () => {
    render(<DesignTree />)
    expect(screen.getByText('Import a file, create a sketch, or start a model')).toBeTruthy()
  })
})

describe('GEO-UNIFY Stage 1: cascade delete reaches from a body row', () => {
  it('a body row\'s inline Trash2 deletes the WHOLE model item, not just this row', async () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [modelGeo('gA1', 'item-a', 'Bracket'), modelGeo('gA2', 'item-a', 'Gusset')],
          modelItems: [{ id: 'item-a', name: 'Item A' }],
        },
      }))
    })
    render(<DesignTree />)

    fireEvent.click(screen.getByTestId('delete-model-item-btn-gA1'))
    await answerPendingConfirm(true)  // WO-1268: the themed confirm, via the store seam

    await waitFor(() => expect(st().project.modelItems).toEqual([]))
    // BOTH bodies went with it (item-level cascade, not row-level removal).
    expect(st().project.geometry).toEqual([])
  })
})

describe('GEO-UNIFY Stage 1: "Rename model..." vs the row\'s own "Rename" stay distinct', () => {
  it('renaming the row (double-click / F2 path) does not touch the model item name', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [modelGeo('gA1', 'item-a', 'Bracket')],
          modelItems: [{ id: 'item-a', name: 'Item A' }],
        },
      }))
    })
    render(<DesignTree />)

    const nameLabel = screen.getByTestId('tree-name-geometry')
    fireEvent.doubleClick(nameLabel)
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('Bracket')
    fireEvent.change(input, { target: { value: 'New Row Name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(st().project.geometry.find((g) => g.id === 'gA1')?.name).toBe('New Row Name')
    expect(st().project.modelItems?.find((m) => m.id === 'item-a')?.name).toBe('Item A')
  })

  it('"Rename model..." (context menu) renames the item, leaving the row name untouched', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [modelGeo('gA1', 'item-a', 'Bracket')],
          modelItems: [{ id: 'item-a', name: 'Item A' }],
        },
      }))
    })
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('tree-name-geometry'))
    fireEvent.click(screen.getByText('Rename model...'))
    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('Item A')
    fireEvent.change(input, { target: { value: 'New Item Name' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect(st().project.modelItems?.find((m) => m.id === 'item-a')?.name).toBe('New Item Name')
    expect(st().project.geometry.find((g) => g.id === 'gA1')?.name).toBe('Bracket')
  })
})
