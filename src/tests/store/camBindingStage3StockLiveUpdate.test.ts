// CAM-BINDING Stage 3 (stock) - store-level live-update proof.
//
// Deliverable under test (charter): "you can create a stock ... from a
// modeled part, the same way you can from an imported part today" (assign
// the body to a named stock via setStockMembership, the DesignTree's
// existing "Owning stock" control) AND "confirm the stock dimensions match
// the model's live bounding box and update when the model is edited
// (re-derive on regen, mirroring syncModelBodies's existing live-update
// pattern)".
//
// Drives the REAL syncModelBodies action twice (create, then edit) and the
// REAL setStockMembership action - never hand-built store state for the
// mechanism under test - so this proves the actual live wiring, not a
// reimplementation of it.

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

describe('CAM-BINDING Stage 3: create a stock from a modeled part, and watch it live-update', () => {
  it('assigning a modeled body to a named stock sizes it to the body\'s live bbox; editing the body re-derives it', () => {
    // 1. A part is modeled (syncModelBodies is the REAL producer call the
    //    Model workbench regen hook makes).
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'F1', name: 'Block' }],
      derived: [{ bodyId: 'F1', version: 1, stableIds: ['F1:F0'],
        display: display([-20, -15, 0], [20, 15, 10]) }],
    })
    const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')
    expect(modelGeo).toBeDefined()
    const stocksBefore = useCamStore.getState().project.stocks ?? []
    expect(stocksBefore.length).toBeGreaterThan(0)
    const derivedStockId = stocksBefore.find((s) => s.mode === 'derived')?.id ?? DERIVED_STOCK_ID

    // 2. "Create a stock from it" - the SAME UI action an imported part
    //    already uses: assign it to a named (here, the default catch-all)
    //    derived stock via setStockMembership.
    expect(() => useCamStore.getState().setStockMembership(modelGeo!.id, derivedStockId)).not.toThrow()
    const afterAssign = useCamStore.getState()
    expect(afterAssign.project.geometry.find((g) => g.id === modelGeo!.id)!.stockId).toBe(derivedStockId)
    expect(afterAssign.project.geometry.find((g) => g.id === modelGeo!.id)!.stockIdLocked).toBe(true)

    const off = afterAssign.project.sceneStock
    const stock = afterAssign.project.stocks!.find((s) => s.id === derivedStockId)!
    // Stock dimensions match the model's live bounding box (padded by the
    // standard auto offsets, exactly like an ordinary part's derived stock).
    expect(stock.bounds.min.x).toBeCloseTo(-20 - off.autoOffsetXY, 6)
    expect(stock.bounds.min.y).toBeCloseTo(-15 - off.autoOffsetXY, 6)
    expect(stock.bounds.min.z).toBeCloseTo(0, 6)
    expect(stock.bounds.max.x).toBeCloseTo(20 + off.autoOffsetXY, 6)
    expect(stock.bounds.max.y).toBeCloseTo(15 + off.autoOffsetXY, 6)
    expect(stock.bounds.max.z).toBeCloseTo(10 + off.autoOffsetZTop, 6)

    // 3. LIVE UPDATE: edit the model (grow it) - a second syncModelBodies
    //    pass, exactly what the Model workbench's regen hook fires on every
    //    parametric edit. version bumped, same bodyId (same body, updated).
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'F1', name: 'Block' }],
      derived: [{ bodyId: 'F1', version: 2, stableIds: ['F1:F0'],
        display: display([-30, -25, 0], [30, 25, 16]) }],
    })
    const afterEdit = useCamStore.getState()
    const stockAfterEdit = afterEdit.project.stocks!.find((s) => s.id === derivedStockId)!
    expect(stockAfterEdit.bounds.min.x).toBeCloseTo(-30 - off.autoOffsetXY, 6)
    expect(stockAfterEdit.bounds.min.y).toBeCloseTo(-25 - off.autoOffsetXY, 6)
    expect(stockAfterEdit.bounds.max.x).toBeCloseTo(30 + off.autoOffsetXY, 6)
    expect(stockAfterEdit.bounds.max.y).toBeCloseTo(25 + off.autoOffsetXY, 6)
    expect(stockAfterEdit.bounds.max.z).toBeCloseTo(16 + off.autoOffsetZTop, 6)
    // Genuinely different from the pre-edit box (not a stale, frozen value).
    expect(stockAfterEdit.bounds.max.x).not.toBeCloseTo(stock.bounds.max.x, 3)
  })

  it('AUTOSTOCK-MODEL-FAIL (Operator LIVE FAIL #3): a model body with NO explicit stock is folded into the CATCH-ALL auto stock and sizes it, so the box actually renders', () => {
    // Operator: "A part is in autostock but there is no stock shown ... a part that
    // is in the autostock can never again ... not be included." An unassigned,
    // unlocked model row is 'auto-catch-all' - the design tree shows it as a
    // member of the default "Auto Stock 1" - so the rendered auto-stock box must
    // WRAP it. This deliberately REVERSES the prior "a model body's mere presence
    // does not inflate a stock nobody locked it to" rule for the CATCH-ALL stock
    // and its RENDERED bounds (the compute/WCS path stays strict; see the
    // camDrillFix2/FIX3 suites, which still pass).
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'F2', name: 'Modeled part' }],
      derived: [{ bodyId: 'F2', version: 1, stableIds: ['F2:F0'],
        display: display([0, 0, 0], [5, 5, 5]) }],
    })
    const state = useCamStore.getState()
    const off = state.project.sceneStock
    const stocks = state.project.stocks ?? []
    const derived = stocks.find((s) => s.mode === 'derived')
    expect(derived).toBeDefined()
    // The catch-all now sizes to the unassigned body's live bbox (padded by the
    // standard auto offsets) - a non-zero box the viewport will draw.
    expect(derived!.bounds.size.x).toBeCloseTo(5 + 2 * off.autoOffsetXY, 6)
    expect(derived!.bounds.size.y).toBeCloseTo(5 + 2 * off.autoOffsetXY, 6)
    expect(derived!.bounds.max.z).toBeCloseTo(5 + off.autoOffsetZTop, 6)
  })

  it('AUTOSTOCK-MODEL-FAIL: a model body deliberately set to NONE (locked, no stock) is NOT folded - the box stays empty (ADR-0003 respect for an explicit no-stock choice)', () => {
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'F2b', name: 'Reference only' }],
      derived: [{ bodyId: 'F2b', version: 1, stableIds: ['F2b:F0'],
        display: display([0, 0, 0], [5, 5, 5]) }],
    })
    const geo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!
    // Explicit "None": setGeometryNoStock locks the row to NO stock
    // (stockIdLocked=true + stockId=undefined) - distinct from the catch-all.
    useCamStore.getState().setGeometryNoStock(geo.id)
    const derived = (useCamStore.getState().project.stocks ?? []).find((s) => s.mode === 'derived')!
    expect(derived.bounds.size.x).toBe(0)
    expect(derived.bounds.size.y).toBe(0)
  })

  // Mutation-provable: comment out this file's new rederiveDerivedStockBounds/
  // applyAutoStockToSetups block inside syncModelBodies (store/index.ts) and
  // the first test above goes RED at the "LIVE UPDATE" assertions (the stock
  // keeps its PRE-edit bounds instead of tracking the grown model).
  it('MUTATION-PROOF marker: the live-update path is genuinely exercised (not a vacuous pass)', () => {
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'F3', name: 'Mut' }],
      derived: [{ bodyId: 'F3', version: 1, stableIds: ['F3:F0'],
        display: display([0, 0, 0], [10, 10, 10]) }],
    })
    const geo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!
    const stockId = (useCamStore.getState().project.stocks ?? []).find((s) => s.mode === 'derived')!.id
    useCamStore.getState().setStockMembership(geo.id, stockId)
    const before = useCamStore.getState().project.stocks!.find((s) => s.id === stockId)!.bounds.max.x
    useCamStore.getState().syncModelBodies({
      live: [{ bodyId: 'F3', name: 'Mut' }],
      derived: [{ bodyId: 'F3', version: 2, stableIds: ['F3:F0'],
        display: display([0, 0, 0], [50, 10, 10]) }],
    })
    const after = useCamStore.getState().project.stocks!.find((s) => s.id === stockId)!.bounds.max.x
    expect(after).not.toBe(before)
    expect(after).toBeGreaterThan(before)
  })
})
