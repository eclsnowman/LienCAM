// CAM-BINDING-S3b - gizmo/panel placement move re-derives a bound stock LIVE,
// with NO Model-tab regen in between.
//
// Booked from the CAM-BINDING-S3 cross-model audit's Q4 NOTE
// (coordination/reports/CAM-BINDING-S3.audit.md): Stage 3's syncModelBodies
// live-update chain (rederiveDerivedStockBounds + applyAutoStockToSetups +
// reanchorProjectionLayers) only fired on a Model-tab regen. A gizmo drag or
// Properties Panel typed commit lands in updateModelItemPlacement instead,
// which wrote modelItemPlacements but never re-ran that chain - so a stock
// locked to the moved body visually lagged until the NEXT regen.
//
// This file drives the REAL updateModelItemPlacement action (never
// hand-built store state for the mechanism under test) and asserts the bound
// stock's bounds change IMMEDIATELY, with no intervening syncModelBodies
// call - proving the fix re-derives from the placement write itself, not
// from a regen this test never triggers.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ModelBodyDisplay } from '../../types'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))
import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'

const { useCamStore } = await import('../../store')
const { DERIVED_STOCK_ID } = await import('../../store/migrateHierarchy')
const { resetDocumentHolder } = await import('../../doc/documentHolder')

function display(min: [number, number, number], max: [number, number, number]): ModelBodyDisplay {
  return {
    positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
    bbox: { min, max },
  }
}

let idb: FakeIndexedDBHandle
beforeEach(() => {
  resetDocumentHolder()
  idb = installFakeIndexedDB()
  vi.clearAllMocks()
  useCamStore.getState().newProject()
})
afterEach(() => { idb.restore() })

// Seed a modeled body bound to the default derived stock, and return its
// geometry id + the stock id + the standard auto offsets in effect.
function seedBoundBody(bodyId: string, itemId: string, min: [number, number, number], max: [number, number, number]) {
  // The Model Item must exist in project.modelItems before its bodies sync --
  // the real app always mints it first (addModelItem / wrap / promote), and
  // syncModelBodies now discards a sync for a non-existent item (MSH-3-WIRING-RACE
  // guard against an undo-orphaned late replay re-minting a zombie row).
  useCamStore.setState((s) => ({
    project: { ...s.project, modelItems: [...(s.project.modelItems ?? []), { id: itemId, name: 'Block', folderId: null }] },
  }))
  useCamStore.getState().syncModelBodies({
    live: [{ bodyId, name: 'Block' }],
    derived: [{ bodyId, version: 1, stableIds: [`${bodyId}:F0`], display: display(min, max) }],
    modelItemId: itemId,
  })
  const geo = useCamStore.getState().project.geometry.find((g) => g.format === 'model' && g.modelItemId === itemId)!
  const stocks = useCamStore.getState().project.stocks ?? []
  const derivedStockId = stocks.find((s) => s.mode === 'derived')?.id ?? DERIVED_STOCK_ID
  useCamStore.getState().setStockMembership(geo.id, derivedStockId)
  const off = useCamStore.getState().project.sceneStock
  return { geo, derivedStockId, off }
}

describe('CAM-BINDING-S3b: updateModelItemPlacement re-derives a bound stock LIVE (no regen)', () => {
  it('a translated placement move updates the bound stock bounds IMMEDIATELY - no syncModelBodies call in between', () => {
    const { geo, derivedStockId, off } = seedBoundBody('b1', 'item-1', [-20, -15, 0], [20, 15, 10])

    const before = useCamStore.getState().project.stocks!.find((s) => s.id === derivedStockId)!.bounds
    expect(before.min).toEqual({ x: -20 - off.autoOffsetXY, y: -15 - off.autoOffsetXY, z: 0 })
    expect(before.max).toEqual({ x: 20 + off.autoOffsetXY, y: 15 + off.autoOffsetXY, z: 10 + off.autoOffsetZTop })

    // The ONLY store action exercised past this point is updateModelItemPlacement
    // - no syncModelBodies, no explicit re-derive call. If the fix regressed,
    // the stock would keep the pre-move bounds above.
    useCamStore.getState().updateModelItemPlacement('item-1', geo.modelBody!.ref.bodyId, { x: 100, y: 50, z: 5 }, { x: 0, y: 0, z: 0 })

    const after = useCamStore.getState().project.stocks!.find((s) => s.id === derivedStockId)!.bounds
    // World box: (-20,-15,0)-(20,15,10) shifted by (100,50,5) -> (80,35,5)-(120,65,15),
    // then padded by the standard auto offsets.
    expect(after.min).toEqual({ x: 80 - off.autoOffsetXY, y: 35 - off.autoOffsetXY, z: 5 })
    expect(after.max).toEqual({ x: 120 + off.autoOffsetXY, y: 65 + off.autoOffsetXY, z: 15 + off.autoOffsetZTop })
    // Genuinely different from the pre-move box (not stale).
    expect(after.min.x).not.toBe(before.min.x)
  })

  it('a rotated placement move updates the bound stock bounds IMMEDIATELY - real AABB numbers for a non-square footprint', () => {
    // 40(x) x 10(y) footprint - rotates to 10(x) x 40(y), same as the Stage 3
    // geometryWorldBounds rotated-placement fixture (modelBodyStockBounds.
    // camBindingStage3.test.ts), reused here through the LIVE gizmo path
    // instead of a direct geometryWorldBounds call.
    const { geo, derivedStockId, off } = seedBoundBody('b2', 'item-2', [-20, -5, 0], [20, 5, 10])

    useCamStore.getState().updateModelItemPlacement('item-2', geo.modelBody!.ref.bodyId, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 90 })

    const after = useCamStore.getState().project.stocks!.find((s) => s.id === derivedStockId)!.bounds
    // Rotated world box: (-5,-20,0)-(5,20,10), then padded.
    expect(after.min.x).toBeCloseTo(-5 - off.autoOffsetXY, 6)
    expect(after.max.x).toBeCloseTo(5 + off.autoOffsetXY, 6)
    expect(after.min.y).toBeCloseTo(-20 - off.autoOffsetXY, 6)
    expect(after.max.y).toBeCloseTo(20 + off.autoOffsetXY, 6)
    expect(after.min.z).toBeCloseTo(0, 6)
    expect(after.max.z).toBeCloseTo(10 + off.autoOffsetZTop, 6)
  })

  it('AUTOSTOCK-MODEL-FAIL: an UNASSIGNED (auto-catch-all) model body sizes the catch-all stock, and a placement move live-updates it (no regen)', () => {
    // Operator LIVE FAIL #3: a freshly modeled part sits in the catch-all "Auto Stock 1"
    // with NO explicit assignment (auto-catch-all), and the box must WRAP it and
    // track it. This body is never setStockMembership'd, mirroring exactly that
    // path. (The prior version of this test asserted the OLD boxless no-op.)
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [...(s.project.modelItems ?? []), { id: 'item-3', name: 'Modeled', folderId: null }] },
    }))
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'b3', name: 'Modeled' }],
      derived: [{ bodyId: 'b3', version: 1, stableIds: ['b3:F0'], display: display([0, 0, 0], [5, 5, 5]) }],
      modelItemId: 'item-3',
    })
    const off = useCamStore.getState().project.sceneStock
    const derived = (useCamStore.getState().project.stocks ?? []).find((s) => s.mode === 'derived')!
    // The catch-all now sizes to the unassigned body (padded) - a drawable box.
    expect(derived.bounds.size.x).toBeCloseTo(5 + 2 * off.autoOffsetXY, 6)

    // Moving the unassigned body live-updates the catch-all (no syncModelBodies).
    useCamStore.getState().updateModelItemPlacement('item-3', 'b3', { x: 500, y: 500, z: 500 }, { x: 0, y: 0, z: 0 })

    const after = useCamStore.getState().project.stocks!.find((s) => s.id === derived.id)!
    expect(after.bounds.min.x).toBeCloseTo(500 - off.autoOffsetXY, 6)
    expect(after.bounds.max.x).toBeCloseTo(505 + off.autoOffsetXY, 6)
    expect(after.bounds.min.x).not.toBe(derived.bounds.min.x)
  })

  // Mutation-provable: comment out this fix's rederiveDerivedStockBounds/
  // applyAutoStockToSetups block inside updateModelItemPlacement (store/index.ts)
  // and this goes RED - the stock keeps its PRE-move bounds instead of
  // tracking the moved body, with no syncModelBodies call anywhere in this test.
  it('MUTATION-PROOF marker: the live-update-on-placement path is genuinely exercised (not a vacuous pass)', () => {
    const { geo, derivedStockId } = seedBoundBody('b4', 'item-4', [0, 0, 0], [10, 10, 10])
    const before = useCamStore.getState().project.stocks!.find((s) => s.id === derivedStockId)!.bounds.max.x

    useCamStore.getState().updateModelItemPlacement('item-4', geo.modelBody!.ref.bodyId, { x: 40, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })

    const after = useCamStore.getState().project.stocks!.find((s) => s.id === derivedStockId)!.bounds.max.x
    expect(after).not.toBe(before)
    expect(after).toBeGreaterThan(before)
  })
})
