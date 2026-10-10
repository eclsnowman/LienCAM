// Explicit "None" geometry membership (coordinate hierarchy).
//
// "None" is distinct from the auto catch-all:
//   - None            = stockIdLocked=true + stockId=undefined. The user
//                       DELIBERATELY chose no stock; assignStocks SKIPS locked
//                       geometry, so it stays None across re-sorts and never
//                       falls back to the default auto stock.
//   - auto-catch-all  = stockIdLocked=false + stockId=undefined. Transient;
//                       assignStocks routes it into the default auto stock.
//
// These tests assert:
//   1. setGeometryNoStock pins None (locked + no stockId).
//   2. A None part stays None across assignStocks AND across adding a fixed stock.
//   3. An unlocked part routes to the default auto stock (catch-all).
//   4. resolveStockMembershipState tells the three states apart.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import {
  assignGeometryToStocks,
  resolveStockMembershipState,
} from '../../store/stockAssignment'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import type {
  ImportedGeometry, SceneStock, PhysicalStock, BoundingBox, Vec3, Project,
} from '../../types'

// -- Fixtures (mirror stockMembership.test.ts) --------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function makeGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [{
      id: 'loop-1',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    ...over,
  } as ImportedGeometry
}

function derivedStock(id: string, name = 'Auto Stock 1'): PhysicalStock {
  return {
    id, name, mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

function autoSceneStock(over: Partial<SceneStock> = {}): SceneStock {
  return {
    mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [], ...over,
  }
}

function installProject(over: Partial<Project>): void {
  useCamStore.setState((s) => ({ project: { ...s.project, setups: [], ...over } }))
}

function getGeo(id: string): ImportedGeometry {
  const found = useCamStore.getState().project.geometry.find((g) => g.id === id)
  if (!found) throw new Error(`geo ${id} missing`)
  return found
}

// =============================================================================
// 1. PIN None: setGeometryNoStock locks the part with no stock id.
// =============================================================================

describe('setGeometryNoStock: pins explicit None', () => {
  beforeEach(() => {
    installProject({
      geometry: [makeGeo({ id: 'geo-1', stockId: DERIVED_STOCK_ID })],
      stocks: [derivedStock(DERIVED_STOCK_ID)],
      sceneStock: autoSceneStock(),
    })
  })

  it('sets stockIdLocked=true and clears stockId', () => {
    useCamStore.getState().setGeometryNoStock('geo-1')
    const geo = getGeo('geo-1')
    expect(geo.stockId).toBeUndefined()
    expect(geo.stockIdLocked).toBe(true)
  })
})

// =============================================================================
// 2. STICK: a None part stays None across assignStocks AND addFixedStock.
// =============================================================================

describe('explicit None is sticky (never falls back to the catch-all)', () => {
  beforeEach(() => {
    installProject({
      // geo-1 starts as None; geo-2 is unlocked (catch-all candidate).
      geometry: [
        makeGeo({ id: 'geo-1', stockId: undefined, stockIdLocked: true }),
        makeGeo({ id: 'geo-2', position: { x: 0, y: 0, z: 0 } }),
      ],
      stocks: [derivedStock(DERIVED_STOCK_ID)],
      sceneStock: autoSceneStock(),
    })
  })

  it('assignStocks skips a None part, leaving it unassigned', () => {
    const out = assignGeometryToStocks(
      [makeGeo({ id: 'geo-1', stockId: undefined, stockIdLocked: true })],
      [derivedStock(DERIVED_STOCK_ID)],
    )
    expect(out[0].stockId).toBeUndefined()
    expect(out[0].stockIdLocked).toBe(true)
  })

  it('an unlocked part routes to the default auto stock (catch-all)', () => {
    const out = assignGeometryToStocks(
      [makeGeo({ id: 'geo-2', stockId: undefined })],
      [derivedStock(DERIVED_STOCK_ID)],
    )
    expect(out[0].stockId).toBe(DERIVED_STOCK_ID)
  })

  it('a None part stays None after adding a fixed stock that contains it', () => {
    useCamStore.getState().setGeometryNoStock('geo-1')
    // A fixed block covering the part's footprint would CONTAIN it — but the
    // lock means the containment re-sort must NOT pull it in.
    useCamStore.getState().addFixedStock({
      id: 'fs-cover', name: 'Cover', width: 200, height: 200, depth: 50,
      position: { x: -50, y: -50, z: -10 },
    })
    const geo = getGeo('geo-1')
    expect(geo.stockId).toBeUndefined()
    expect(geo.stockIdLocked).toBe(true)
  })
})

// =============================================================================
// 3. resolveStockMembershipState distinguishes the three states.
// =============================================================================

describe('resolveStockMembershipState: three distinct states', () => {
  const stocks = [derivedStock(DERIVED_STOCK_ID), {
    ...derivedStock('named-1', 'Named'), mode: 'explicit' as const,
  }]

  it("named-stock when stockId resolves to an existing stock", () => {
    expect(resolveStockMembershipState(
      { stockId: 'named-1', stockIdLocked: true }, stocks,
    )).toBe('named-stock')
  })

  it('auto-catch-all when unlocked with no resolvable stock', () => {
    expect(resolveStockMembershipState(
      { stockId: undefined, stockIdLocked: false }, stocks,
    )).toBe('auto-catch-all')
    // A dangling id (unlocked) is also a catch-all candidate.
    expect(resolveStockMembershipState(
      { stockId: 'ghost', stockIdLocked: false }, stocks,
    )).toBe('auto-catch-all')
  })

  it('none when locked with no stock id', () => {
    expect(resolveStockMembershipState(
      { stockId: undefined, stockIdLocked: true }, stocks,
    )).toBe('none')
  })
})
