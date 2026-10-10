// WO INT-17C Stage C2: persistence round-trip gate. The WO's own TESTS/GATES
// line requires "persistence round-trip of a moved item (save/reload keeps
// the pose)". This drives the REAL store actions end to end: create a
// (non-legacy) Model Item, sync a body into it (the real INT-17A adapter
// path, which also seeds the item's whole-item Placement identity record --
// src/store/index.ts syncModelBodies), move its Placement via the ONE
// sanctioned action, save through the real save path, reload into a fresh
// store state, and confirm the moved pose survived byte-identical.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ModelBodyDisplay } from '../../types'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { resetDocumentHolder, stashLoadedDocument } = await import('../../doc/documentHolder')
const { createDocumentArchive } = await import('../../doc/persist')
const { FeatureDag } = await import('../../doc/dag')

function display(): ModelBodyDisplay {
  return {
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0], normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2], edgePositions: [0, 0, 0, 1, 0, 0], edgeOffsets: [0, 2],
    bbox: { min: [0, 0, 0], max: [1, 1, 0] },
  }
}

let savedBlobs: Blob[] = []
async function saveAndCaptureFile(): Promise<string> {
  savedBlobs = []
  await useCamStore.getState().saveProjectToFile()
  expect(savedBlobs).toHaveLength(1)
  return await savedBlobs[0].text()
}

beforeEach(() => {
  resetDocumentHolder()
  savedBlobs = []
  vi.stubGlobal('alert', vi.fn())
  vi.stubGlobal('URL', {
    createObjectURL: (blob: Blob) => { savedBlobs.push(blob); return 'blob:int17c-c2' },
    revokeObjectURL: () => {},
  })
  vi.stubGlobal('document', { createElement: () => ({ href: '', download: '', click: () => {} }) })
  useCamStore.getState().newProject()
})

describe('INT-17C Stage C2: a moved Model Item Placement survives save -> reload', () => {
  it('creates a Model Item, syncs a body, moves its Placement, saves, reloads: the moved pose round-trips byte-identical', async () => {
    const itemId = useCamStore.getState().addModelItem()
    stashLoadedDocument(
      createDocumentArchive({ dag: new FeatureDag(), elementMapDeltas: [] }),
      itemId,
    )

    // The real INT-17A adapter sync path (SolidsWorkbenchPage's own call
    // shape): the first body for this item seeds a whole-item identity
    // Placement record (syncModelBodies, INT-17C Stage C2).
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'b1', name: 'Bracket' }],
      derived: [{ bodyId: 'b1', version: 1, stableIds: ['b1:F0'], display: display() }],
      modelItemId: itemId,
    })

    const row = useCamStore.getState().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'b1')!
    expect(row.modelItemId).toBe(itemId)
    expect(useCamStore.getState().project.modelItemPlacements).toEqual([
      { modelItemId: itemId, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ])

    // Move it -- the ONE sanctioned Placement write path (mirrors the
    // gizmo drag-end / typed Properties Panel commit).
    useCamStore.getState().updateModelItemPlacement(
      itemId, 'b1', { x: 42, y: -7, z: 3.5 }, { x: 0, y: 15, z: 0 },
    )
    expect(useCamStore.getState().project.modelItemPlacements).toEqual([
      { modelItemId: itemId, position: { x: 42, y: -7, z: 3.5 }, rotation: { x: 0, y: 15, z: 0 } },
    ])

    const fileText = await saveAndCaptureFile()
    // Fresh session, nothing inherited (mirrors int17cC1FixtureBaseline's
    // own reload discipline).
    useCamStore.getState().newProject()
    expect(useCamStore.getState().project.modelItemPlacements ?? []).toHaveLength(0)

    await useCamStore.getState().loadProjectFromFile(fileText)

    const loaded = useCamStore.getState().project
    expect(loaded.modelItems).toHaveLength(1)
    expect(loaded.modelItems![0].id).toBe(itemId)
    expect(loaded.modelItemPlacements).toEqual([
      { modelItemId: itemId, position: { x: 42, y: -7, z: 3.5 }, rotation: { x: 0, y: 15, z: 0 } },
    ])
    // The geometry row's OWN position/rotation stayed identity throughout
    // (isolation, invariant 3) -- the moved pose lived ONLY in the
    // Placement record, never mirrored onto the row.
    const loadedRow = loaded.geometry.find((g) => g.modelBody?.ref.bodyId === 'b1')!
    expect(loadedRow.position).toEqual({ x: 0, y: 0, z: 0 })
    expect(loadedRow.rotation).toEqual({ x: 0, y: 0, z: 0 })
  })
})
