// @vitest-environment jsdom
//
// React-render SMOKE tests for UI-EDIT-MODEL-FROM-BODY: a model-origin CAM
// geometry row (imported from a Model workspace item) had no path back to
// editing its source model — the round trip (openModelItem) was already
// SHIPPED, this is pure discoverability. Mirrors the P13 layer-edit-sketch
// precedent (DesignTreeLayerEditSketch.smoke.test.tsx):
//
//   (a) Right-clicking a model-origin geometry row opens a menu whose FIRST
//       item is "Edit model"; clicking it calls openModelItem(modelItemId)
//       and lands on {workspace: 'part', activeModelItemId}.
//   (b) A non-model-origin geometry row's menu OMITS "Edit model" entirely.
//   (c) Double-click semantics on the row are UNCHANGED (still rename) — this
//       lane is context-menu only.
//
// openModelItem is exercised for real (not mocked) so the workspace-switch
// side effect is asserted directly against store state.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, screen, cleanup, fireEvent, act } from '@testing-library/react'
import { getByTooltip, queryByTooltip } from '../support/tooltipQuery'

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

const st = () => useCamStore.getState()

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    // newProject() resets activeModelItemId but NOT workspace (it only
    // switches workspace on explicit navigation) -- force 'cam' so tests are
    // order-independent regardless of what a prior test in this file left it as.
    useCamStore.setState({ activeModal: null, workspace: 'cam' })
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
  })
})

// Same shape as DesignTreeModelItemDelete.int17cC3.test.tsx's modelGeo helper.
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

function seedModelOriginRow() {
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [modelGeo('gA1', 'item-a', 'Bracket')],
        modelItems: [{ id: 'item-a', name: 'Item A', documentState: 'empty' }],
      },
    }))
  })
}

function seedNonModelRow() {
  act(() => {
    useCamStore.getState().addGeometry({
      id: 'g1', name: 'PartOne', filename: 'p.dxf', type: 'curves_2d', format: 'dxf',
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
        size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
      },
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    })
  })
}

describe('UI-EDIT-MODEL-FROM-BODY: context-menu Edit model on a model-origin row', () => {
  it('right-click opens a menu whose FIRST item is Edit model; clicking it opens the model workspace', () => {
    seedModelOriginRow()
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('tree-name-geometry'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))

    expect(buttons[0].textContent).toBe('Edit model')
    expect(buttons[0].getAttribute('data-action')).toBe('geo-edit-model')

    fireEvent.click(buttons[0])

    expect(st().workspace).toBe('part')
    expect(st().activeModelItemId).toBe('item-a')
  })

  it('double-click on the row still starts rename (double-click semantics unchanged by this lane)', () => {
    seedModelOriginRow()
    render(<DesignTree />)

    fireEvent.doubleClick(screen.getByTestId('tree-name-geometry'))

    expect(screen.getByTestId('tree-rename-input')).toBeTruthy()
    expect(st().workspace).not.toBe('part')
  })
})

describe('UI-EDIT-MODEL-FROM-BODY: non-model-origin rows are unaffected', () => {
  it('a non-model geometry row\'s menu OMITS Edit model entirely', () => {
    seedNonModelRow()
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('tree-name-geometry'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))

    expect(buttons.map((b) => b.textContent)).not.toContain('Edit model')
    expect(menu.querySelector('[data-action="geo-edit-model"]')).toBeNull()
    // Rename stays the first item, exactly as before this lane.
    expect(buttons[0].textContent).toBe('Rename')
  })
})

describe('UI-EDIT-MODEL-FROM-BODY: inline row button (Operator ruling addendum)', () => {
  it('a model-origin row shows an inline "Edit model" icon button that calls openModelItem', () => {
    seedModelOriginRow()
    render(<DesignTree />)

    const btn = getByTooltip('Edit model')
    expect(btn.tagName).toBe('BUTTON')
    fireEvent.click(btn)

    expect(st().workspace).toBe('part')
    expect(st().activeModelItemId).toBe('item-a')
  })

  it('a non-model geometry row has NO inline "Edit model" button', () => {
    seedNonModelRow()
    render(<DesignTree />)

    expect(queryByTooltip('Edit model')).toBeNull()
  })
})
