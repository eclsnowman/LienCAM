// MSH-3-WIRING-RACE (coordinator repro): a late meshImport/STEP replay
// completion whose target Model Item was ALREADY removed by undo must be
// DISCARDED, never written -- otherwise syncModelBodies appends a zombie
// format:'model' geometry row for the deleted item (modelRows grows to 2 after
// a wrap -> undo -> re-wrap sequence when the kernel is cold and the first
// replay lands AFTER the undo).
//
// Deterministic (no setTimeout): we drive syncModelBodies directly with a
// modelItemId that is NOT present in project.modelItems -- exactly the state the
// in-flight replay's completion path sees after undo removed its item. The guard
// must discard it loudly and leave the geometry list untouched. The control
// proves the SAME input for a LIVE item still adopts, so the guard is not
// vacuous.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ImportedGeometry, ModelBodyDisplay, ModelItemRecord } from '../../types'
import type { DerivedModelBody, LiveModelBody } from '../../lib/cam/modelBodyAdapter'
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

import { useCamStore } from '../../store'

function display(): ModelBodyDisplay {
  return {
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    edgePositions: [0, 0, 0, 1, 1, 0],
    edgeOffsets: [0, 2],
    bbox: { min: [0, 0, 0], max: [1, 1, 0] },
  }
}
const derived = (bodyId: string): DerivedModelBody => ({ bodyId, version: 1, stableIds: [`${bodyId}:F0`], display: display() })
const live = (bodyId: string, name: string): LiveModelBody => ({ bodyId, name })

/** A plain imported STL row (NOT pending -- undo already cleared the marker). */
function plainStlRow(): ImportedGeometry {
  return {
    id: 'geo-stl', name: 'Plate', filename: 'plate.stl', type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 }, size: { x: 1, y: 1, z: 0 }, center: { x: 0.5, y: 0.5, z: 0 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}

const st = () => useCamStore.getState()
const modelRows = () => st().project.geometry.filter((g) => g.format === 'model')

function setGeometry(geometry: ImportedGeometry[], modelItems: ModelItemRecord[]): void {
  useCamStore.setState((s) => ({
    project: { ...s.project, geometry, modelItems, modelItemPlacements: [], stocks: [], setups: [] },
  }))
}

describe('MSH-3-WIRING-RACE: syncModelBodies discards a late replay for a removed item', () => {
  beforeEach(() => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [], modelItems: [], modelItemPlacements: [], stocks: [], setups: [] } }))
  })

  it('DISCARDS a sync whose modelItemId is no longer in project.modelItems (no zombie row)', () => {
    // Post-undo state: the STL row is plain again, the wrapped item is GONE.
    setGeometry([plainStlRow()], [])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const before = JSON.stringify(st().project.geometry)

    // The in-flight replay completes and calls syncModelBodies for the item undo
    // already removed.
    st().syncModelBodies({ modelItemId: 'removed-item', live: [live('CNV1', 'Plate')], derived: [derived('CNV1')] })

    expect(modelRows()).toHaveLength(0)                                   // NO zombie model row
    expect(JSON.stringify(st().project.geometry)).toBe(before)           // geometry untouched
    expect(warn).toHaveBeenCalled()                                      // discarded LOUDLY (ADR-0003)
    warn.mockRestore()
  })

  it('CONTROL: the SAME sync for a LIVE item still adopts the pending row (guard not vacuous)', () => {
    // A live item whose pending STL row is waiting for its first body.
    const pending: ImportedGeometry = { ...plainStlRow(), pendingModelItemId: 'live-item' }
    setGeometry([pending], [{ id: 'live-item', name: 'Plate', folderId: null }])

    st().syncModelBodies({ modelItemId: 'live-item', live: [live('CNV1', 'Plate')], derived: [derived('CNV1')] })

    const rows = modelRows()
    expect(rows).toHaveLength(1)                                          // adopted, exactly one
    expect(rows[0].id).toBe('geo-stl')                                   // SAME id (in-place adoption)
    expect(rows[0].pendingModelItemId).toBeUndefined()                   // pending cleared
  })

  it('the legacy scope (no modelItemId) is always allowed (never discarded)', () => {
    setGeometry([], [])
    // Omitted modelItemId -> legacy scope; a legacy body add must still land even
    // when project.modelItems does not list the legacy item explicitly.
    st().syncModelBodies({ live: [live('B1', 'Legacy Body')], derived: [derived('B1')] })
    expect(modelRows()).toHaveLength(1)
  })
})
