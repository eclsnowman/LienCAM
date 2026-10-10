// WO INT-17C Stage C3: `renameModelItem` and `removeModelItem` are the two
// new store actions this stage adds (design-tree management for Model
// Items). This file drives them directly, mirroring
// updateModelItemPlacement.int17cC2.test.ts's own store-level harness for
// the same registry.
//
// removeModelItem's contract under test (per the WO's Stage C3 scope):
//   - cascade-deletes every CAM geometry row this item owns (modelItemId
//     match) -- NOT the "delete around it" folder-cascade behavior, because
//     unlike a folder, the item that could ever regenerate these rows is the
//     thing being deleted (see the action's own doc comment in store/index.ts).
//   - prunes modelItemPlacements and modelItemDocuments for this id.
//   - resets activeModelItemId (and returns workspace to 'cam') when the
//     deleted item was the active one; leaves both alone otherwise.
//   - is ONE undo step for the whole cascade (pushHistory once).
//   - no-ops on an unknown id (no history entry, no state change).
//   - tears down this item's documentHolder state (disposeModelItem) without
//     touching a DIFFERENT item's live/pending/autosave state.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import {
  disposeDocumentAutosave, hasLiveDocument,
  registerLiveDocument, resetDocumentHolder, startDocumentAutosave,
  stashLoadedDocument, takePendingDocumentSeed,
} from '../../doc/documentHolder'
import { createDocumentArchive } from '../../doc/persist'
import { FeatureDag } from '../../doc/dag'
import type { ImportedGeometry, ModelItemPlacementRecord, SceneStock } from '../../types'

/** A minimal real document archive (mirrors documentHolder.test.ts's own
 *  makeArchive helper) -- stashLoadedDocument decode-validates real zip
 *  bytes, so a placeholder byte array would throw before this test's own
 *  assertion runs. */
function makeArchive(): Uint8Array {
  const dag = new FeatureDag()
  dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', height: 5 } })
  return createDocumentArchive({ dag, elementMapDeltas: [] })
}

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

function modelGeo(id: string, modelItemId: string, over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id, name: id, filename: id, type: 'brep', format: 'model',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    modelItemId,
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
  useCamStore.setState(s => ({
    project: {
      ...s.project, setups: [], sceneStock: autoStock,
      geometry: [modelGeo('gA1', 'item-a'), modelGeo('gA2', 'item-a'), modelGeo('gB1', 'item-b')],
      modelItems: [{ id: 'item-a', name: 'Item A' }, { id: 'item-b', name: 'Item B' }],
      modelItemPlacements: [
        { modelItemId: 'item-a', position: { x: 1, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
        { modelItemId: 'item-b', position: { x: 2, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
      ] satisfies ModelItemPlacementRecord[],
      modelItemDocuments: { 'item-a': 'QQ==', 'item-b': 'Qg==' },
    },
    workspace: 'cam',
    activeModelItemId: null,
    projectHistory: [],
    sketchHistory: [],
    canUndo: false,
  }))
}

const state = () => useCamStore.getState()
const historyLen = () => state().projectHistory.length
const items = () => state().project.modelItems ?? []
const placements = () => state().project.modelItemPlacements ?? []
const docs = () => state().project.modelItemDocuments ?? {}
const geoIds = () => state().project.geometry.map(g => g.id)

describe('INT-17C Stage C3: renameModelItem', () => {
  beforeEach(resetStore)

  it('renames the ModelItemRecord and pushes one undo step', () => {
    const baseline = historyLen()
    state().renameModelItem('item-a', 'Bracket Body')
    expect(items().find(m => m.id === 'item-a')!.name).toBe('Bracket Body')
    expect(historyLen()).toBe(baseline + 1)
    state().undo()
    expect(items().find(m => m.id === 'item-a')!.name).toBe('Item A')
  })

  it('no-ops on an unknown id (no history entry, no throw)', () => {
    const baseline = historyLen()
    expect(() => state().renameModelItem('does-not-exist', 'X')).not.toThrow()
    expect(historyLen()).toBe(baseline)
  })

  it('no-ops when the name is unchanged (no dead history entry)', () => {
    const baseline = historyLen()
    state().renameModelItem('item-a', 'Item A')
    expect(historyLen()).toBe(baseline)
  })

  it('never touches a different item -- item-b is untouched', () => {
    state().renameModelItem('item-a', 'Renamed')
    expect(items().find(m => m.id === 'item-b')!.name).toBe('Item B')
  })
})

describe('INT-17C Stage C3: removeModelItem', () => {
  beforeEach(resetStore)

  it('cascade-deletes the item, its geometry rows, and its Placement -- item-b untouched', () => {
    state().removeModelItem('item-a')
    expect(items().map(m => m.id)).toEqual(['item-b'])
    expect(geoIds()).toEqual(['gB1'])
    expect(placements().map(p => p.modelItemId)).toEqual(['item-b'])
    expect(docs()).toEqual({ 'item-b': 'Qg==' })
  })

  it('is ONE undo step for the whole cascade -- undo restores item, rows, Placement, and document bytes together', () => {
    const baseline = historyLen()
    state().removeModelItem('item-a')
    expect(historyLen()).toBe(baseline + 1)
    state().undo()
    expect(items().map(m => m.id).sort()).toEqual(['item-a', 'item-b'])
    expect(geoIds().sort()).toEqual(['gA1', 'gA2', 'gB1'])
    expect(placements().find(p => p.modelItemId === 'item-a')).toBeDefined()
    expect(docs()['item-a']).toBe('QQ==')
  })

  it('no-ops on an unknown id (no history entry, no state change)', () => {
    const baseline = historyLen()
    expect(() => state().removeModelItem('does-not-exist')).not.toThrow()
    expect(historyLen()).toBe(baseline)
    expect(items()).toHaveLength(2)
  })

  it('deleting an item with NO CAM rows still removes cleanly (empty-item delete)', () => {
    useCamStore.setState(s => ({
      project: { ...s.project, modelItems: [...(s.project.modelItems ?? []), { id: 'item-c', name: 'Empty Item' }] },
    }))
    state().removeModelItem('item-c')
    expect(items().map(m => m.id)).toEqual(['item-a', 'item-b'])
    // item-a/item-b's own rows are untouched by an empty item's delete.
    expect(geoIds().sort()).toEqual(['gA1', 'gA2', 'gB1'])
  })

  it('resets activeModelItemId and returns to the cam workspace when the deleted item was active', () => {
    useCamStore.setState({ activeModelItemId: 'item-a', workspace: 'part' })
    state().removeModelItem('item-a')
    expect(state().activeModelItemId).toBeNull()
    expect(state().workspace).toBe('cam')
  })

  it('leaves activeModelItemId and workspace alone when a DIFFERENT item is deleted', () => {
    useCamStore.setState({ activeModelItemId: 'item-b', workspace: 'part' })
    state().removeModelItem('item-a')
    expect(state().activeModelItemId).toBe('item-b')
    expect(state().workspace).toBe('part')
  })

  it('clears the selected CAM row when it belonged to the deleted item (mirrors removeGeometry)', () => {
    useCamStore.setState(s => ({ viewer: { ...s.viewer, selectedGeometryId: 'gA1' } }))
    state().removeModelItem('item-a')
    // removeModelItem itself does not own selection clearing (that is the
    // DesignTree UI caller's job, same split as removeGeometryFolder) -- but
    // applyGeometryRemoval's own selection-clear guard still fires for a
    // victim id, so a stale selection never survives the geometry removal.
    expect(state().viewer.selectedGeometryId).toBeNull()
  })

  it("tears down THIS item's documentHolder state without touching a different item's", () => {
    const collectA = () => ({ dag: { toJSON: () => ({ nodes: [], edges: [] }) } } as never)
    registerLiveDocument(collectA, 'item-a')
    startDocumentAutosave({ documentId: 'doc-a' }, 'item-a')
    stashLoadedDocument(makeArchive(), 'item-b')
    expect(hasLiveDocument('item-a')).toBe(true)

    state().removeModelItem('item-a')

    expect(hasLiveDocument('item-a')).toBe(false)
    // item-b's stashed state (a DIFFERENT id) must survive item-a's delete.
    expect(takePendingDocumentSeed('item-b')).not.toBeNull()
    disposeDocumentAutosave('item-b')
  })
})
