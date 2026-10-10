// INT-MODEL-UNIFY: the Model tab's plain (no-selection) entry point used to
// be a bare `setWorkspace('part')` that silently rode the legacy document
// forever, with NO project.modelItems record ever created for it. Operator's
// repro: fresh project -> Model tab -> build sketch + extrude -> Finish ->
// Geometry list shows "Extrude F1 [MODEL]" but Model Items shows "0 -- No
// Model Items". This file drives the fix directly at the store level:
//   - enterModelWorkspace's 4-way resolution order (resume active / claim
//     legacy / open the sole item / chooser for 2+).
//   - openModelItem's legacy-id self-heal (a legacy-origin row can exist
//     before the legacy item is formally claimed -- e.g. a pre-fix session,
//     or content modeled before enterModelWorkspace's own claim ran).
//   - removeModelItem's cascade now correctly resolves a legacy-origin row's
//     ownership via resolveOwningModelItemId (the raw field is never set on
//     those rows by design -- modelBodyAdapter.ts), closing a delete-cascade
//     gap that opened the moment the legacy item became visible/deletable.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCamStore } from '../../store'
import { resetDocumentHolder } from '../../doc/documentHolder'
import type { ImportedGeometry, SceneStock } from '../../types'

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

/** A legacy-origin model row exactly as modelBodyAdapter.ts's
 *  buildModelBodyGeometry produces one when scoped to the legacy item: NO
 *  modelItemId field at all (by design, byte-identical to every pre-Stage-C1
 *  row -- see modelOrigin.ts's resolveOwningModelItemId doc comment). */
function legacyModelGeo(id: string, over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id, name: id, filename: id, type: 'brep', format: 'model',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      display: {
        positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
        indices: [0, 1, 2], edgePositions: [], edgeOffsets: [0],
        bbox: { min: [0, 0, 0], max: [1, 1, 1] },
      },
    },
    ...over,
  }
}

function resetStore(): void {
  resetDocumentHolder()
  useCamStore.setState((s) => ({
    project: {
      ...s.project, setups: [], sceneStock: autoStock,
      geometry: [], modelItems: [], modelItemPlacements: [], modelItemDocuments: undefined,
    },
    workspace: 'cam',
    activeModal: null,
    activeModelItemId: null,
    projectHistory: [],
    sketchHistory: [],
    canUndo: false,
  }))
}

const state = () => useCamStore.getState()
const items = () => state().project.modelItems ?? []
const historyLen = () => state().projectHistory.length

describe('INT-MODEL-UNIFY: enterModelWorkspace', () => {
  beforeEach(resetStore)

  it('a brand-new project (0 Model Items) claims the legacy slot and opens it', () => {
    state().enterModelWorkspace()
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe('legacy')
    expect(items()).toEqual([{ id: 'legacy', name: 'Project Model', documentState: 'empty' }])
  })

  it('claiming the legacy slot is ONE undo step and undo/redo reconcile navigation', () => {
    const baseline = historyLen()
    state().enterModelWorkspace()
    expect(historyLen()).toBe(baseline + 1)
    state().undo()
    expect(items()).toEqual([])
    expect(state().workspace).toBe('cam')
    expect(state().activeModelItemId).toBeNull()

    state().redo()
    expect(items()).toEqual([{ id: 'legacy', name: 'Project Model', documentState: 'empty' }])
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe('legacy')
  })

  it('a project with unclaimed legacy-origin geometry claims it as authored and refuses a missing checkpoint', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [legacyModelGeo('gA1')] },
    }))
    state().enterModelWorkspace()
    expect(state().workspace).toBe('cam')
    expect(state().activeModelItemId).toBeNull()
    expect(items()).toEqual([{ id: 'legacy', name: 'Project Model', documentState: 'authored' }])
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('document-not-ready'))
    expect(state().consoleEvents.at(-1)?.message).toMatch(/checkpoint reference is missing/i)
    errorSpy.mockRestore()
  })

  it('exactly ONE Model Item exists -- opens it directly, no chooser, no mutation to modelItems', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [{ id: 'item-a', name: 'Item A', documentState: 'empty' }],
      },
    }))
    const baseline = historyLen()
    state().enterModelWorkspace()
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe('item-a')
    expect(state().activeModal).toBeNull()
    expect(historyLen()).toBe(baseline) // no claim needed, no history entry
  })

  it('activeModelItemId already names a REAL item -- resumes it (workspace only, unchanged from today)', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [
          { id: 'item-a', name: 'Item A', documentState: 'empty' },
          { id: 'item-b', name: 'Item B', documentState: 'empty' },
        ],
      },
      activeModelItemId: 'item-b',
    }))
    state().enterModelWorkspace()
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe('item-b')
  })

  it('2+ Model Items and no active item -- opens the model-entry chooser instead of guessing', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [{ id: 'item-a', name: 'Item A' }, { id: 'item-b', name: 'Item B' }],
      },
    }))
    state().enterModelWorkspace()
    expect(state().activeModal).toBe('model-entry')
    // Neither workspace nor activeModelItemId is touched until a choice is made.
    expect(state().workspace).toBe('cam')
    expect(state().activeModelItemId).toBeNull()
  })

  it('2+ items but a STALE activeModelItemId (deleted item) -- falls through to the chooser, not a silent reopen', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [{ id: 'item-a', name: 'Item A' }, { id: 'item-b', name: 'Item B' }],
      },
      activeModelItemId: 'ghost',
    }))
    state().enterModelWorkspace()
    expect(state().activeModal).toBe('model-entry')
  })
})

describe('INT-MODEL-UNIFY: openModelItem legacy self-heal', () => {
  beforeEach(resetStore)

  it('openModelItem("legacy") on a project with no legacy record yet claims it and opens it', () => {
    state().openModelItem('legacy')
    expect(state().workspace).toBe('part')
    expect(state().activeModelItemId).toBe('legacy')
    expect(items()).toEqual([{ id: 'legacy', name: 'Project Model', documentState: 'empty' }])
  })

  it('openModelItem with any OTHER unknown id refuses loudly and preserves the current document', () => {
    const baseline = historyLen()
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    state().openModelItem('does-not-exist')
    expect(state().workspace).toBe('cam')
    expect(state().activeModelItemId).toBeNull()
    expect(historyLen()).toBe(baseline)
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('stale-target'))
    expect(state().consoleEvents.at(-1)).toMatchObject({
      severity: 'error',
      source: 'model',
      message: expect.stringContaining('missing or was deleted'),
    })
    errorSpy.mockRestore()
  })

  it('openModelItem("legacy") when already claimed just opens it (no duplicate record, no extra history entry)', () => {
    state().enterModelWorkspace() // claims it
    const baseline = historyLen()
    useCamStore.setState({ workspace: 'cam', activeModelItemId: null })
    state().openModelItem('legacy')
    expect(state().activeModelItemId).toBe('legacy')
    expect(items()).toEqual([{ id: 'legacy', name: 'Project Model', documentState: 'empty' }])
    expect(historyLen()).toBe(baseline)
  })
})

describe('INT-MODEL-UNIFY: removeModelItem cascade covers legacy-origin rows (no modelItemId on the row itself)', () => {
  beforeEach(resetStore)

  it('deleting the legacy item removes its own legacy-origin geometry rows too', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [{ id: 'legacy', name: 'Project Model' }],
        geometry: [legacyModelGeo('gA1'), legacyModelGeo('gA2')],
      },
    }))
    state().removeModelItem('legacy')
    expect(items()).toEqual([])
    expect(state().project.geometry).toEqual([])
  })

  it('deleting the legacy item leaves a DIFFERENT item\'s rows untouched', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [{ id: 'legacy', name: 'Project Model' }, { id: 'item-b', name: 'Item B' }],
        geometry: [
          legacyModelGeo('gA1'),
          { ...legacyModelGeo('gB1'), modelItemId: 'item-b' },
        ],
      },
    }))
    state().removeModelItem('legacy')
    expect(items()).toEqual([{ id: 'item-b', name: 'Item B' }])
    expect(state().project.geometry.map((g) => g.id)).toEqual(['gB1'])
  })
})
