// IMPORT-STOCK-PROMPT: the store's promise-based import-time stock choice
// (requestImportStockChoice / resolveImportStockChoice) and the one-call apply
// seam (promptAndApplyImportStockChoice), driven through the REAL zustand store.
//
// Pins:
//   - request returns null (NO prompt) when the project has zero explicit stocks
//     (the lone catch-all auto stock is the one obvious destination -> historical
//     auto-assign-by-containment behavior preserved).
//   - request opens the choice (state reflects it, with the named stock list)
//     when one or more explicit stocks exist; resolve settles the awaited promise
//     with the user's pick + clears state.
//   - a second request supersedes the first, resolving the first with 'auto' (no
//     hung awaiter, no silent change of an earlier decision).
//   - promptAndApplyImportStockChoice persists each outcome through the EXISTING
//     stock-binding source of truth: 'auto' = no-op (historical default already
//     applied by addGeometry), 'none' = setGeometryNoStock (locked, sticky),
//     'stock' = setStockMembership (locked). A stale/invalid stock id is REFUSED
//     BY NAME (setStockMembership throws ADR-0003), never a silent fallback.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { resetDocumentHolder } from '../../doc/documentHolder'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import type { ImportedGeometry, PhysicalStock, SceneStock } from '../../types'

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

function makeExplicitStock(id: string, name: string): PhysicalStock {
  return {
    id, name, mode: 'explicit',
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 10 },
      size: { x: 50, y: 50, z: 10 }, center: { x: 25, y: 25, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 },
  }
}

/** A named DERIVED (automatic) stock -- bounds are computed from its members,
 *  so the stored bounds are a placeholder. With id === DERIVED_STOCK_ID it is
 *  the catch-all (the 'Auto' option); any other id is a NAMED derived stock the
 *  user can pin a part to. */
function makeDerivedStock(id: string, name: string): PhysicalStock {
  return {
    id, name, mode: 'derived',
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 },
      size: { x: 10, y: 10, z: 5 }, center: { x: 5, y: 5, z: 2.5 },
    },
    position: { x: 0, y: 0, z: 0 },
  }
}

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 10, y: 10, z: 0 }, max: { x: 20, y: 20, z: 5 },
      size: { x: 10, y: 10, z: 5 }, center: { x: 15, y: 15, z: 2.5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    ...over,
  }
}

const state = () => useCamStore.getState()

function resetStore(stocks: PhysicalStock[] = [], geometry: ImportedGeometry[] = []): void {
  resetDocumentHolder()
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      setups: [], sceneStock: autoStock,
      geometry, stocks,
      modelItems: [], modelItemPlacements: [], modelItemDocuments: undefined,
    },
    workspace: 'cam', activeModal: null, brepImportError: null,
    multiBodyImportChoice: null,
    importStockChoice: null,
    projectHistory: [], sketchHistory: [], canUndo: false,
  }))
}

describe('IMPORT-STOCK-PROMPT: request / resolve', () => {
  beforeEach(() => resetStore())

  it('returns null (NO prompt) when the project has zero explicit stocks (historical default preserved)', async () => {
    // No explicit stocks -> the lone catch-all auto stock is the one obvious
    // destination -> no modal, no surprise.
    const p = state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' })
    await expect(p).resolves.toBeNull()
    expect(state().importStockChoice).toBeNull()
  })

  it('returns null when the target row is absent, even when explicit stocks exist', async () => {
    resetStore([makeExplicitStock('fix-1', 'Fixture A')])
    const p = state().requestImportStockChoice({ geoId: 'missing', name: 'Missing' })
    await expect(p).resolves.toBeNull()
    expect(state().importStockChoice).toBeNull()
  })

  it('opens the choice with the named stock list when an explicit stock exists; resolve settles the promise and clears it', async () => {
    resetStore([makeExplicitStock('fix-1', 'Fixture A')], [makeGeo()])
    const p = state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' })
    // The set() ran synchronously before the returned promise's await point.
    expect(state().importStockChoice).toEqual({
      geoId: 'geo-1', name: 'Part',
      stocks: [{ id: 'fix-1', name: 'Fixture A' }],
    })

    state().resolveImportStockChoice({ kind: 'stock', stockId: 'fix-1' })
    await expect(p).resolves.toEqual({ kind: 'stock', stockId: 'fix-1' })
    expect(state().importStockChoice).toBeNull()
  })

  it('lists every explicit stock (only the catch-all derived stock is excluded -- it is the Auto option)', async () => {
    resetStore(
      [makeExplicitStock('fix-1', 'Fixture A'), makeExplicitStock('fix-2', 'Fixture B')],
      [makeGeo()],
    )
    state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' })
    const ids = state().importStockChoice!.stocks.map((s) => s.id)
    expect(ids).toEqual(['fix-1', 'fix-2'])
    state().resolveImportStockChoice({ kind: 'auto' })
  })

  it('returns null (NO prompt) when the ONLY stock is the lone catch-all auto stock (no named choice)', async () => {
    // A single derived stock with id === DERIVED_STOCK_ID is the catch-all =
    // the 'Auto' destination. With no explicit and no NAMED derived stock, there
    // is no meaningful choice -> no prompt (historical auto-assign preserved).
    resetStore([makeDerivedStock(DERIVED_STOCK_ID, 'Auto Stock 1')], [makeGeo()])
    const p = state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' })
    await expect(p).resolves.toBeNull()
    expect(state().importStockChoice).toBeNull()
  })

  it('opens the chooser when two named derived stocks exist alongside the catch-all', async () => {
    // catch-all + two NAMED derived stocks = a real choice (either named derived
    // vs Auto). The chooser opens and BOTH named derived stocks appear; the
    // catch-all is excluded (it is the Auto option).
    resetStore(
      [
        makeDerivedStock(DERIVED_STOCK_ID, 'Auto Stock 1'),
        makeDerivedStock('auto-op-a', 'Op Stock A'),
        makeDerivedStock('auto-op-b', 'Op Stock B'),
      ],
      [makeGeo()],
    )
    const p = state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' })
    expect(state().importStockChoice).not.toBeNull()
    const ids = state().importStockChoice!.stocks.map((s) => s.id)
    expect(ids).toEqual(['auto-op-a', 'auto-op-b'])
    expect(ids).not.toContain(DERIVED_STOCK_ID)
    state().resolveImportStockChoice({ kind: 'auto' })
    await p
  })

  it('lists every named derived AND explicit stock, excluding only the catch-all', async () => {
    // Mix: catch-all derived + one named derived + one explicit. All assignable
    // named stocks appear; the catch-all is the sole exclusion.
    resetStore(
      [
        makeDerivedStock(DERIVED_STOCK_ID, 'Auto Stock 1'),
        makeDerivedStock('auto-op', 'Op Stock'),
        makeExplicitStock('fix-1', 'Fixture A'),
      ],
      [makeGeo()],
    )
    state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' })
    const ids = state().importStockChoice!.stocks.map((s) => s.id)
    expect(ids).toEqual(['auto-op', 'fix-1'])
    expect(ids).not.toContain(DERIVED_STOCK_ID)
    state().resolveImportStockChoice({ kind: 'auto' })
  })

  it('opens when a single named derived stock exists alongside the catch-all (one named pick is a real choice)', async () => {
    resetStore(
      [makeDerivedStock(DERIVED_STOCK_ID, 'Auto Stock 1'), makeDerivedStock('auto-op', 'Op Stock')],
      [makeGeo()],
    )
    const p = state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' })
    expect(state().importStockChoice).not.toBeNull()
    expect(state().importStockChoice!.stocks.map((s) => s.id)).toEqual(['auto-op'])
    state().resolveImportStockChoice({ kind: 'auto' })
    await p
  })

  it('a second request supersedes the first, resolving the first with auto (no hung awaiter)', async () => {
    resetStore(
      [makeExplicitStock('fix-1', 'Fixture A')],
      [makeGeo({ id: 'geo-a' }), makeGeo({ id: 'geo-b' })],
    )
    const first = state().requestImportStockChoice({ geoId: 'geo-a', name: 'A' })
    const second = state().requestImportStockChoice({ geoId: 'geo-b', name: 'B' })
    // First awaiter must not hang; it resolves with 'auto' (the default), never a
    // hardcoded stock change.
    await expect(first).resolves.toEqual({ kind: 'auto' })
    expect(state().importStockChoice?.geoId).toBe('geo-b')

    state().resolveImportStockChoice({ kind: 'none' })
    await expect(second).resolves.toEqual({ kind: 'none' })
  })

  it('settles a pending request when a later request has no stock choice', async () => {
    resetStore([makeExplicitStock('fix-1', 'Fixture A')], [makeGeo()])
    const first = state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' })
    useCamStore.setState((s) => ({
      project: { ...s.project, stocks: [] },
    }))

    await expect(
      state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' }),
    ).resolves.toBeNull()
    await expect(first).resolves.toEqual({ kind: 'auto' })
    expect(state().importStockChoice).toBeNull()
  })

  it('settles and clears the prompt across project replacement, New, and Open', async () => {
    resetStore([makeExplicitStock('fix-1', 'Fixture A')], [makeGeo()])

    const replaced = state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' })
    state().setProject({ ...state().project, id: 'replacement-project' })
    await expect(replaced).resolves.toEqual({ kind: 'auto' })
    expect(state().importStockChoice).toBeNull()

    const newProjectPrompt = state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' })
    state().newProject()
    await expect(newProjectPrompt).resolves.toEqual({ kind: 'auto' })
    expect(state().importStockChoice).toBeNull()

    resetStore([makeExplicitStock('fix-1', 'Fixture A')], [makeGeo()])
    const openedProject = {
      ...state().project,
      id: 'opened-project',
      name: 'Opened Project',
    }
    const openPrompt = state().requestImportStockChoice({ geoId: 'geo-1', name: 'Part' })
    state().loadProjectFromFile(JSON.stringify(openedProject))
    await expect(openPrompt).resolves.toEqual({ kind: 'auto' })
    expect(state().importStockChoice).toBeNull()
    expect(state().project.id).toBe('opened-project')
  })
})

describe('IMPORT-STOCK-PROMPT: promptAndApplyImportStockChoice (persist through the existing seam)', () => {
  beforeEach(() => resetStore())

  it('is a no-op (no prompt) when zero explicit stocks -- historical auto-assign stays', async () => {
    resetStore([], [makeGeo({ id: 'geo-1' })])
    await state().promptAndApplyImportStockChoice('geo-1', 'Part')
    expect(state().importStockChoice).toBeNull()
    // The geo's stockId is whatever addGeometry's auto-assign left it at; the
    // prompt did not touch it.
    const geo = state().project.geometry.find((g) => g.id === 'geo-1')!
    expect(geo.stockIdLocked).toBeFalsy()
  })

  it('"auto" leaves the part on its auto-assigned stock (historical default, no lock)', async () => {
    resetStore([makeExplicitStock('fix-1', 'Fixture A')], [makeGeo({ id: 'geo-1' })])
    const p = state().promptAndApplyImportStockChoice('geo-1', 'Part')
    // The modal is open -- resolve with auto.
    expect(state().importStockChoice).not.toBeNull()
    state().resolveImportStockChoice({ kind: 'auto' })
    await p
    const geo = state().project.geometry.find((g) => g.id === 'geo-1')!
    // auto = no lock (a future re-sort by containment stays the sole decider).
    expect(geo.stockIdLocked).toBeFalsy()
  })

  it('"none" locks the part with no stock (setGeometryNoStock: sticky, deliberate)', async () => {
    resetStore([makeExplicitStock('fix-1', 'Fixture A')], [makeGeo({ id: 'geo-1' })])
    const p = state().promptAndApplyImportStockChoice('geo-1', 'Part')
    state().resolveImportStockChoice({ kind: 'none' })
    await p
    const geo = state().project.geometry.find((g) => g.id === 'geo-1')!
    expect(geo.stockId).toBeUndefined()
    expect(geo.stockIdLocked).toBe(true)
  })

  it('"stock" pins the part to the named stock (setStockMembership: locked)', async () => {
    resetStore([makeExplicitStock('fix-1', 'Fixture A')], [makeGeo({ id: 'geo-1' })])
    const p = state().promptAndApplyImportStockChoice('geo-1', 'Part')
    state().resolveImportStockChoice({ kind: 'stock', stockId: 'fix-1' })
    await p
    const geo = state().project.geometry.find((g) => g.id === 'geo-1')!
    expect(geo.stockId).toBe('fix-1')
    expect(geo.stockIdLocked).toBe(true)
  })

  it('"stock" on a NAMED derived stock pins the part to its id and locks (same seam as explicit)', async () => {
    // Choosing a derived stock writes its stockId and sets stockIdLocked, exactly
    // like an explicit stock. setStockMembership accepts any existing stock id
    // (explicit OR derived); the derived stock then re-wraps its bounds around
    // the new member.
    resetStore(
      [makeDerivedStock(DERIVED_STOCK_ID, 'Auto Stock 1'), makeDerivedStock('auto-op', 'Op Stock')],
      [makeGeo({ id: 'geo-1' })],
    )
    const p = state().promptAndApplyImportStockChoice('geo-1', 'Part')
    state().resolveImportStockChoice({ kind: 'stock', stockId: 'auto-op' })
    await p
    const geo = state().project.geometry.find((g) => g.id === 'geo-1')!
    expect(geo.stockId).toBe('auto-op')
    expect(geo.stockIdLocked).toBe(true)
  })

  it('"auto" leaves the part unlocked even when named derived stocks are present (Auto = the catch-all, no lock)', async () => {
    resetStore(
      [makeDerivedStock(DERIVED_STOCK_ID, 'Auto Stock 1'), makeDerivedStock('auto-op', 'Op Stock')],
      [makeGeo({ id: 'geo-1' })],
    )
    const p = state().promptAndApplyImportStockChoice('geo-1', 'Part')
    state().resolveImportStockChoice({ kind: 'auto' })
    await p
    const geo = state().project.geometry.find((g) => g.id === 'geo-1')!
    // auto = no lock (a future re-sort by containment stays the sole decider).
    expect(geo.stockIdLocked).toBeFalsy()
  })

  it('REFUSES a stale/invalid stock id BY NAME (no silent fallback to the catch-all)', async () => {
    resetStore([makeExplicitStock('fix-1', 'Fixture A')], [makeGeo({ id: 'geo-1' })])
    const p = state().promptAndApplyImportStockChoice('geo-1', 'Part')
    // The user picks a stock id that no longer exists (deleted between render and
    // click -- the stale edge). setStockMembership throws ADR-0003; the apply seam
    // surfaces it as a named import error rather than swallowing it or silently
    // falling back to the catch-all.
    state().resolveImportStockChoice({ kind: 'stock', stockId: 'ghost-stock' })
    await p
    // The part is NOT silently pinned to a phantom stock.
    const geo = state().project.geometry.find((g) => g.id === 'geo-1')!
    expect(geo.stockId).not.toBe('ghost-stock')
    expect(geo.stockIdLocked).not.toBe(true)
    // A named error was surfaced.
    expect(state().brepImportError).toContain('ghost-stock')
  })
})
