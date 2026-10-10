// WO-1823 stage 1: the store's FIXED-STOCK TWIN seam.
//
// ARCHITECTURE-AUDIT-2026-08-26 section 3.8: the FixedStockItem ->
// PhysicalStock twin invariant was "maintained by five call sites each
// remembering", and only ONE of the five (moveFixedStockLive) checked its own
// work. Stage 1 moves the write into src/store/dispatchSeam.ts behind
// writeFixedStockTwins, which syncs, optionally refines, CHECKS the invariant
// and re-sorts membership in one call.
//
// What this file proves, in the order the acceptance asks for it:
//
//  1. THE SIXTH CALLER CANNOT FORGET IT. The check is not something a caller
//     performs; it is something the writer performs on the caller's output. The
//     negative controls drive a would-be sixth caller through the writer with a
//     `refine` hook that drops a twin and one that strands a twin - the shape of
//     the twin-sync incidents - and the writer refuses, ADR-0003 fail-loud,
//     before it hands back either the stocks or the re-sorted geometry. The same
//     mangling through the bare sync is silent, which is the point: the
//     enforcement lives in the writer, so it costs a new caller nothing.
//  2. ALL FIVE EXISTING SITES ROUTE THROUGH IT, driven through the REAL store
//     (useCamStore, its production actions) - addFixedStock, updateFixedStock,
//     moveFixedStockLive, removeFixedStock, and removeNest's bound-stock
//     teardown (the one site with a refine hook). Each is asserted with the
//     module's OWN post-condition against the stored project, so "the site
//     routes through the writer" and "the invariant holds" are one predicate.
//  3. NO BEHAVIOUR CHANGE at the relocated boundary: the twin still mirrors its
//     FixedStockItem's name/size/position, a removed stock's twin still goes
//     away, and a never-migrated scene (project.stocks undefined) still stores
//     nothing rather than refusing (rule 11).

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useCamStore } from '../../store'
import {
  syncFixedStocksToPhysical,
  writeFixedStockTwins,
  assertFixedStockTwins,
} from '../../store/dispatchSeam'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import type {
  BoundingBox, FixedStockItem, ImportedGeometry, Loop2D, NestRecord,
  PhysicalStock, Vec3,
} from '../../types'
import type { NestResult } from '../../lib/cam/nesting/types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function fixedStockItem(over: Partial<FixedStockItem> = {}): FixedStockItem {
  return {
    id: 'stock-1', name: 'Stock 1', width: 100, height: 80, depth: 12,
    position: { x: 0, y: 0, z: 0 },
    ...over,
  }
}

/** The migrated catch-all derived stock every real project carries. */
function catchAll(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Stock', mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

function explicitTwin(fixed: FixedStockItem): PhysicalStock {
  return {
    id: fixed.id, name: fixed.name, mode: 'explicit',
    bounds: bbox(
      { x: 0, y: 0, z: 0 },
      { x: fixed.width, y: fixed.height, z: fixed.depth },
    ),
    position: { ...fixed.position },
  }
}

function squareLoop(id: string, s: number): Loop2D {
  return {
    id, layerId: 'L', closed: true, type: 'contour', area: s * s,
    points: [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }],
  }
}

function makePart(id: string, side: number, position: Vec3, over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id, name: `Part ${id}`, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: side, y: side, z: 0 }),
    position: { ...position }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [squareLoop(`${id}-outer`, side)],
    layers2d: [{ id: 'L', color: '#00e5ff', visible: true }],
    ...over,
  } as ImportedGeometry
}

/** A real store project: the migrated catch-all present (so the sync actually
 *  runs), plus whatever fixed stocks / geometry the case needs. */
function installProject(opts: {
  fixedStocks?: FixedStockItem[]
  stocks?: PhysicalStock[] | undefined
  geometry?: ImportedGeometry[]
  nests?: NestRecord[]
} = {}): void {
  useCamStore.getState().newProject()
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: opts.geometry ?? [],
      geometryFolders: [],
      setups: [],
      nests: opts.nests ?? [],
      stocks: 'stocks' in opts ? opts.stocks : (opts.stocks ?? [catchAll()]),
      sceneStock: {
        ...s.project.sceneStock,
        mode: 'fixed',
        fixedStocks: opts.fixedStocks ?? [],
      },
    },
    projectHistory: [],
    canUndo: false,
  }))
}

function stored() { return useCamStore.getState().project }

/** THE predicate, evaluated with the seam module's own post-condition against
 *  the STORED project - the same code path every store action now runs. */
function expectStoredTwinsIntact(context: string): void {
  const p = stored()
  expect(() =>
    assertFixedStockTwins(p.stocks, p.sceneStock.fixedStocks ?? [], context),
  ).not.toThrow()
}

function twin(id: string): PhysicalStock {
  const t = (stored().stocks ?? []).find((s) => s.id === id)
  if (!t) throw new Error(`no PhysicalStock ${id}`)
  return t
}

// A synthetic pack result for the nest path (applyNestResult mints the bound
// fixed stock, removeNest tears it down - site 5).
function nestResult(width: number, height: number): NestResult {
  return {
    placements: [{ partId: 'seed', instanceId: 'seed#0', x: 0, y: 0, rotationDeg: 0, depth: 0 }],
    unplaced: [], utilization: 0.5, sheetUsed: { width, height },
  }
}

function makeNest(id: string, seedId: string): NestRecord {
  return {
    id, name: `Nest ${id}`,
    sheet: { width: 100, height: 100 },
    style: 'arbitrary',
    spacing: { partGap: 1, sheetMargin: 1, windowGap: 1 },
    seed: 1,
    sources: [{ geometryId: seedId, quantity: 1 }],
    placements: [{ partId: seedId, instanceId: `${seedId}#0`, x: 0, y: 0, rotationDeg: 0, depth: 0 }],
    unplaced: [],
    utilization: 0.5,
    thickness: 12,
  }
}

beforeEach(() => {
  installProject()
})

// =============================================================================
// 1. A SIXTH CALLER CANNOT FORGET THE INVARIANT (the binding acceptance)
// =============================================================================

describe('WO-1823 seam: a sixth caller cannot forget the twin invariant', () => {
  const fixed = fixedStockItem()

  it('refuses, ADR-0003 fail-loud, when a caller DROPS a twin on its way out', () => {
    const resort = vi.fn((g: ImportedGeometry[]) => g)
    expect(() =>
      writeFixedStockTwins({
        existing: [catchAll(), explicitTwin(fixed)],
        fixedStocks: [fixed],
        geometry: [],
        context: 'sixthCaller',
        // A sixth caller doing exactly what removeNest legitimately does -
        // deriving over the synced list - and getting it wrong.
        refine: (stocks) => (stocks ?? []).filter((s) => s.mode !== 'explicit'),
        resort,
      }),
    ).toThrow(
      'sixthCaller: fixed stock "stock-1" has no explicit PhysicalStock twin after sync',
    )
    // The check runs BEFORE the membership re-sort: a caller cannot even get
    // half of the write out of a failed one.
    expect(resort).not.toHaveBeenCalled()
  })

  it('refuses when a caller STRANDS a twin whose FixedStockItem is gone', () => {
    const resort = vi.fn((g: ImportedGeometry[]) => g)
    expect(() =>
      writeFixedStockTwins({
        existing: [catchAll(), explicitTwin(fixed)],
        // The operator deleted the stock; the write forgets to drop its twin.
        fixedStocks: [],
        geometry: [],
        context: 'sixthCaller',
        refine: (stocks) => [...(stocks ?? []), explicitTwin(fixed)],
        resort,
      }),
    ).toThrow(
      'sixthCaller: explicit PhysicalStock "stock-1" has no FixedStockItem source after sync',
    )
    expect(resort).not.toHaveBeenCalled()
  })

  it('NEGATIVE CONTROL: the same two mistakes are SILENT through the bare sync', () => {
    // This is why the enforcement had to move into the writer. The sync itself
    // cannot catch a caller that mangles its result afterwards - which is what
    // "five call sites each remembering" cost us.
    const synced = syncFixedStocksToPhysical([catchAll(), explicitTwin(fixed)], [fixed])
    const dropped = (synced ?? []).filter((s) => s.mode !== 'explicit')
    expect(dropped.some((s) => s.id === fixed.id)).toBe(false) // twin gone, no error
    const stranded = [...(syncFixedStocksToPhysical([catchAll(), explicitTwin(fixed)], []) ?? []), explicitTwin(fixed)]
    expect(stranded.some((s) => s.id === fixed.id && s.mode === 'explicit')).toBe(true)
  })

  it('passes the post-refine stocks to the re-sort, in that order', () => {
    const seen: (PhysicalStock[] | undefined)[] = []
    const out = writeFixedStockTwins({
      existing: [catchAll(), explicitTwin(fixed)],
      fixedStocks: [fixed],
      geometry: [],
      context: 'orderProbe',
      refine: (stocks) => (stocks ?? []).map((s) => ({ ...s, name: `${s.name}!` })),
      resort: (g, stocks) => { seen.push(stocks); return g },
    })
    expect(seen).toHaveLength(1)
    expect(seen[0]?.find((s) => s.id === fixed.id)?.name).toBe('Stock 1!')
    expect(out.stocks?.find((s) => s.id === fixed.id)?.name).toBe('Stock 1!')
  })

  it('a never-migrated scene stores no twins and does NOT refuse (rule 11)', () => {
    const geometry = [makePart('g1', 10, { x: 0, y: 0, z: 0 })]
    const out = writeFixedStockTwins({
      existing: undefined,
      fixedStocks: [fixed],
      geometry,
      context: 'noMigration',
      resort: (g, stocks) => {
        expect(stocks).toBeUndefined()
        return g
      },
    })
    expect(out.stocks).toBeUndefined()
    expect(out.geometry).toBe(geometry)
  })
})

// =============================================================================
// 2. THE FIVE EXISTING CALL SITES, THROUGH THE REAL STORE
// =============================================================================

describe('WO-1823 seam: all five fixed-stock writers keep the invariant', () => {
  it('site 1 - addFixedStock mints the twin', () => {
    const fixed = fixedStockItem()
    useCamStore.getState().addFixedStock(fixed)

    expectStoredTwinsIntact('addFixedStock')
    const t = twin('stock-1')
    expect(t.mode).toBe('explicit')
    expect(t.name).toBe('Stock 1')
    expect(t.bounds.size).toEqual({ x: 100, y: 80, z: 12 })
    expect(t.position).toEqual({ x: 0, y: 0, z: 0 })
  })

  it('site 2 - updateFixedStock refreshes the twin (resize AND move)', () => {
    useCamStore.getState().addFixedStock(fixedStockItem())

    useCamStore.getState().updateFixedStock('stock-1', { width: 150, name: 'Renamed' })
    expectStoredTwinsIntact('updateFixedStock/resize')
    expect(twin('stock-1').bounds.size.x).toBe(150)
    expect(twin('stock-1').name).toBe('Renamed')

    useCamStore.getState().updateFixedStock('stock-1', { position: { x: 25, y: 5, z: -3 } })
    expectStoredTwinsIntact('updateFixedStock/move')
    expect(twin('stock-1').position).toEqual({ x: 25, y: 5, z: -3 })
  })

  it('site 3 - moveFixedStockLive rides the twin (and its members)', () => {
    installProject({ geometry: [makePart('g1', 10, { x: 10, y: 10, z: 0 })] })
    useCamStore.getState().addFixedStock(fixedStockItem())
    expect(stored().geometry[0].stockId).toBe('stock-1') // a member by containment

    useCamStore.getState().moveFixedStockLive('stock-1', { x: 30, y: 0, z: 0 })

    expectStoredTwinsIntact('moveFixedStockLive')
    expect(twin('stock-1').position).toEqual({ x: 30, y: 0, z: 0 })
    // The rigid-fixture ride is unchanged by the relocation: the member rode the
    // same +30 X delta and stayed a member.
    expect(stored().geometry[0].position).toEqual({ x: 40, y: 10, z: 0 })
    expect(stored().geometry[0].stockId).toBe('stock-1')
  })

  it('site 4 - removeFixedStock drops the twin and releases its members', () => {
    installProject({ geometry: [makePart('g1', 10, { x: 10, y: 10, z: 0 })] })
    useCamStore.getState().addFixedStock(fixedStockItem())
    useCamStore.getState().addFixedStock(fixedStockItem({ id: 'stock-2', name: 'Stock 2', position: { x: 400, y: 0, z: 0 } }))

    useCamStore.getState().removeFixedStock('stock-1')

    expectStoredTwinsIntact('removeFixedStock')
    expect((stored().stocks ?? []).some((s) => s.id === 'stock-1')).toBe(false)
    expect(twin('stock-2').mode).toBe('explicit') // the sibling twin survives
    expect(stored().geometry[0].stockId).not.toBe('stock-1')
  })

  it('site 5 - removeNest tears down the bound stock THROUGH the refine hook', () => {
    const seed = makePart('seed', 10, { x: 0, y: 0, z: 0 }, { ownerNestId: 'n1' })
    installProject({ geometry: [seed], nests: [makeNest('n1', 'seed')] })

    // applyNestResult mints the backing fixed stock (via addFixedStock - site 1).
    useCamStore.getState().applyNestResult('n1', nestResult(100, 100))
    const boundStockId = stored().nests!.find((n) => n.id === 'n1')!.boundStockId
    expect(boundStockId).toBeDefined()
    expectStoredTwinsIntact('applyNestResult')
    expect(twin(boundStockId!).mode).toBe('explicit')

    // The teardown branch: sync -> rederiveDerivedStockBounds (the refine hook)
    // -> post-condition -> re-sort, all inside the writer.
    useCamStore.getState().removeNest('n1')

    expectStoredTwinsIntact('removeNest')
    expect((stored().sceneStock.fixedStocks ?? []).some((f) => f.id === boundStockId)).toBe(false)
    expect((stored().stocks ?? []).some((s) => s.id === boundStockId)).toBe(false)
    expect((stored().nests ?? []).some((n) => n.id === 'n1')).toBe(false)
  })

  it('a never-migrated scene runs every site without refusing (rule 11)', () => {
    installProject({ stocks: undefined })
    const store = useCamStore.getState()

    store.addFixedStock(fixedStockItem())
    store.updateFixedStock('stock-1', { width: 150 })
    store.moveFixedStockLive('stock-1', { x: 5, y: 0, z: 0 })
    store.removeFixedStock('stock-1')

    expect(stored().stocks).toBeUndefined()
    expect((stored().sceneStock.fixedStocks ?? [])).toHaveLength(0)
  })
})
