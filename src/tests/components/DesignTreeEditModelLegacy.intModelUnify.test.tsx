// @vitest-environment jsdom
//
// INT-MODEL-UNIFY: UI-EDIT-MODEL-FROM-BODY's "Edit model" pencil + context-
// menu item both gated on the geometry row's RAW modelItemId field --
// which a legacy-origin row never carries (modelBodyAdapter.ts writes it
// undefined by design), so the discoverability fix shipped this morning was
// silently dead for the single most common case: a project modeled entirely
// through the plain Model tab. Both surfaces now resolve ownership through
// the shared resolveOwningModelItemId (modelOrigin.ts), which falls back to
// the legacy id for exactly this row shape. Mirrors
// DesignTreeEditModel.uiEditModelFromBody.test.tsx's own harness/shape.

import { answerPendingConfirm } from './confirmDialog.support'
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, fireEvent, act, waitFor } from '@testing-library/react'
import { getByTooltip } from '../support/tooltipQuery'

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

afterEach(() => { cleanup(); vi.restoreAllMocks() })

const st = () => useCamStore.getState()

beforeEach(() => {
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.setState({ activeModal: null, workspace: 'cam' })
    useUiPrefs.setState({
      treeStockExpanded: true, treeGeometryExpanded: true, treeSetupsExpanded: true,
      collapsedPartIds: [], collapsedFolderIds: [], collapsedNestIds: [],
      expandedSeedIds: [], expandedSetupIds: [], expandedStockIds: [],
    })
  })
})

// A legacy-origin row: format 'model', modelBody set, NO modelItemId field --
// exactly what modelBodyAdapter.ts's buildModelBodyGeometry writes when
// scoped to the legacy item (never stamps the row itself, by design).
function legacyModelGeo(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: name, type: 'brep', format: 'model',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
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

function seedClaimedLegacyRow() {
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [legacyModelGeo('gA1', 'Extrude F1')],
        modelItems: [{ id: 'legacy', name: 'Project Model', documentState: 'empty' }],
      },
    }))
  })
}

describe('INT-MODEL-UNIFY: Edit model on a legacy-origin row (claimed legacy item)', () => {
  it('the inline pencil button appears and routes to the legacy item', () => {
    seedClaimedLegacyRow()
    render(<DesignTree />)

    const btn = getByTooltip('Edit model')
    expect(btn.tagName).toBe('BUTTON')
    fireEvent.click(btn)

    expect(st().workspace).toBe('part')
    expect(st().activeModelItemId).toBe('legacy')
  })

  it('the context menu\'s FIRST item is "Edit model" and routes to the legacy item', () => {
    seedClaimedLegacyRow()
    render(<DesignTree />)

    fireEvent.contextMenu(screen.getByTestId('tree-name-geometry'))
    const menu = screen.getByTestId('tree-context-menu')
    const buttons = Array.from(menu.querySelectorAll('button'))
    expect(buttons[0].textContent).toBe('Edit model')

    fireEvent.click(buttons[0])
    expect(st().workspace).toBe('part')
    expect(st().activeModelItemId).toBe('legacy')
  })

  it('clicking the body row\'s own Trash2 cascades the whole legacy Model Item (GEO-UNIFY Stage 1 D5: delete parity)', async () => {
    seedClaimedLegacyRow()
    render(<DesignTree />)

    // The Model Items section is gone (GEO-UNIFY Stage 1) -- the body row's
    // own inline Trash2 now performs the full "delete model" cascade, keyed
    // by the geometry row's own id (there is exactly one body here).
    fireEvent.click(screen.getByTestId('delete-model-item-btn-gA1'))
    await answerPendingConfirm(true)  // WO-1268: the themed confirm, via the store seam

    await waitFor(() => expect(st().project.modelItems).toEqual([]))
    expect(st().project.geometry).toEqual([])
  })
})

describe('INT-MODEL-UNIFY: legacy-origin authored evidence without a checkpoint', () => {
  it('offers Edit model but refuses to activate an authored legacy item whose checkpoint is missing', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: { ...s.project, geometry: [legacyModelGeo('gA1', 'Extrude F1')], modelItems: [] },
      }))
    })
    render(<DesignTree />)

    // The pencil button is shown because resolveOwningModelItemId resolves a
    // real id. The click self-heals the registry, but the body row is authored
    // evidence: without a checkpoint the acquisition gate must leave CAM
    // active rather than silently mount an empty model.
    const btn = getByTooltip('Edit model')
    fireEvent.click(btn)
    expect(st().workspace).toBe('cam')
    expect(st().activeModelItemId).toBeNull()
    expect(st().project.modelItems).toEqual([
      { id: 'legacy', name: 'Project Model', documentState: 'authored' },
    ])
    expect(st().consoleEvents.at(-1)?.message).toMatch(/checkpoint reference is missing/i)
  })
})
