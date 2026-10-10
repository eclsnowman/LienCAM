// @vitest-environment jsdom
//
// WO INT-17C Stage C3: delete-with-dependents for Model Items. GEO-UNIFY
// Stage 1 (tree unification, 2026-07-24) removed the separate "Model Items"
// tree section this file originally exercised -- a model item with a body
// no longer has its own summary row (its BODY rows carry the delete/rename
// affordances instead, per plan sec 1.2's "model-row affordance parity");
// an EMPTY model item (no bodies) still gets a presentation-only placeholder
// row with the SAME testids the old section rows used (plan sec 1.1). This
// file is re-pointed accordingly:
//   1. delete: refuse-unless-confirmed, dependents named in the confirm
//      message, one-undo-step cascade -- now triggered from a BODY row's own
//      inline Trash2 (item-a) or the placeholder row's Trash2 (item-b,
//      empty) -- mirrors handleDeleteFolder's own confirm-then-cascade shape.
//   2. GEO-UNIFY Stage 1 D4: body rows show the owning model's name as meta
//      text only when 2+ models exist in the project, and "Rename model..."
//      / "Delete model" reach the SAME renameModelItem / handleDeleteModelItem
//      flow from a body row's context menu.
//
// Harness copied from DesignTreeInlineRename.smoke.test.tsx.

import { answerPendingConfirm } from './confirmDialog.support'
import {describe, it, expect, beforeEach, afterEach} from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'

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
type ImportedGeometry = import('../../types').ImportedGeometry

afterEach(cleanup)

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

/** Seeds two Model Items: 'item-a' owns two CAM rows (body rows, no
 *  placeholder), 'item-b' owns none (renders as a placeholder row). */
function seedTwoItems() {
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [
          modelGeo('gA1', 'item-a', 'Bracket'),
          modelGeo('gA2', 'item-a', 'Gusset'),
        ],
        modelItems: [{ id: 'item-a', name: 'Item A' }, { id: 'item-b', name: 'Item B' }],
        modelItemPlacements: [
          { modelItemId: 'item-a', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
        ],
      },
    }))
  })
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
  seedTwoItems()
})

const st = () => useCamStore.getState()

describe('INT-17C Stage C3 / GEO-UNIFY Stage 1: Model Item delete (design-tree cascade)', () => {
  it('refuses (does nothing) when the confirm is cancelled -- item and its CAM rows survive', async () => {
    render(<DesignTree />)

    // item-a has bodies -> no summary row; its OWN body row's Trash2 (keyed
    // by the geometry id, not the item id) performs the item-level cascade.
    fireEvent.click(screen.getByTestId('delete-model-item-btn-gA1'))

    // WO-1268: the app's own themed confirm, answered through the store seam.
    await answerPendingConfirm(false)
    expect((st().project.modelItems ?? []).map(m => m.id)).toEqual(['item-a', 'item-b'])
    expect(st().project.geometry.map(g => g.id).sort()).toEqual(['gA1', 'gA2'])
  })

  it('names every dependent CAM part by name and count in the confirm message', async () => {
    render(<DesignTree />)

    fireEvent.click(screen.getByTestId('delete-model-item-btn-gA1'))

    const asked = await answerPendingConfirm(false)
    const message = `${asked.title} ${asked.body}`
    expect(message).toContain('Item A')
    expect(message).toContain('2')
    expect(message).toContain('Bracket')
    expect(message).toContain('Gusset')
  })

  it('an EMPTY Model Item (no dependents) still confirms, with a plain message -- via its placeholder row', async () => {
    render(<DesignTree />)

    // item-b owns zero bodies -> renders as the GEO-UNIFY Stage 1 placeholder
    // row, same testid convention the old Model Items section used.
    fireEvent.click(screen.getByTestId('delete-model-item-btn-item-b'))

    const asked = await answerPendingConfirm(true)
    expect(asked.title).toMatch(/delete model item "item b"/i)
    expect(asked.body).toMatch(/empty/i)
    await waitFor(() => expect((st().project.modelItems ?? []).map(m => m.id)).toEqual(['item-a']))
  })

  it('confirmed delete cascades in one undo step -- item, its CAM rows, and its Placement all removed together, and Undo restores all three', async () => {
    const before = st().projectHistory.length
    render(<DesignTree />)

    fireEvent.click(screen.getByTestId('delete-model-item-btn-gA1'))
    await answerPendingConfirm(true)

    await waitFor(() => expect(st().projectHistory.length).toBe(before + 1))
    expect((st().project.modelItems ?? []).map(m => m.id)).toEqual(['item-b'])
    expect(st().project.geometry).toHaveLength(0)
    expect(st().project.modelItemPlacements ?? []).toHaveLength(0)

    act(() => { st().undo() })
    expect((st().project.modelItems ?? []).map(m => m.id).sort()).toEqual(['item-a', 'item-b'])
    expect(st().project.geometry.map(g => g.id).sort()).toEqual(['gA1', 'gA2'])
    expect(st().project.modelItemPlacements ?? []).toHaveLength(1)
  })

  it('clears the CAM selection when the selected row belonged to the deleted item', async () => {
    act(() => { useCamStore.getState().setSelectedGeometry('gA1') })
    render(<DesignTree />)

    fireEvent.click(screen.getByTestId('delete-model-item-btn-gA1'))
    await answerPendingConfirm(true)

    await waitFor(() => expect(st().viewer.selectedGeometryId).toBeNull())
  })
})

describe('GEO-UNIFY Stage 1 D4: owning-model name shown on body rows only when 2+ models exist', () => {
  it('shows the owning model name as meta text on a body row when the project has 2+ models', () => {
    render(<DesignTree />)
    // seedTwoItems (beforeEach): item-a (2 bodies) + item-b (empty) = 2 models.
    expect(screen.getByTestId('tree-name-model-owner-gA1').textContent).toBe('Item A')
    expect(screen.getByTestId('tree-name-model-owner-gA2').textContent).toBe('Item A')
  })

  it('stays quiet (no owner meta) with only ONE model in the project', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, modelItems: [{ id: 'item-a', name: 'Item A' }] },
      }))
    })
    render(<DesignTree />)
    expect(screen.queryByTestId('tree-name-model-owner-gA1')).toBeNull()
  })

  it('context menu "Rename model..." on a body row renames the OWNING ITEM, not the row\'s own name', () => {
    render(<DesignTree />)
    const nameLabels = screen.getAllByTestId('tree-name-geometry')
    fireEvent.contextMenu(nameLabels[0])  // gA1's row
    fireEvent.click(screen.getByText('Rename model...'))

    const input = screen.getByTestId('tree-rename-input') as HTMLInputElement
    expect(input.value).toBe('Item A')
    fireEvent.change(input, { target: { value: 'Renamed Item' } })
    fireEvent.keyDown(input, { key: 'Enter' })

    expect((st().project.modelItems ?? []).find((m) => m.id === 'item-a')?.name).toBe('Renamed Item')
    // The row's OWN name (Bracket) is untouched -- two different names, both reachable.
    expect(st().project.geometry.find((g) => g.id === 'gA1')?.name).toBe('Bracket')
  })

  it('context menu "Delete model" on a body row cascades the whole item, same as the inline Trash2', async () => {
    render(<DesignTree />)
    const nameLabels = screen.getAllByTestId('tree-name-geometry')
    fireEvent.contextMenu(nameLabels[0])  // gA1's row
    fireEvent.click(screen.getByText('Delete model'))
    await answerPendingConfirm(true)

    await waitFor(() => expect((st().project.modelItems ?? []).map((m) => m.id)).toEqual(['item-b']))
    expect(st().project.geometry).toHaveLength(0)
  })
})
