// Coordinate hierarchy Phase 4 (Item 5): design-tree membership read-out +
// OVERRIDE store action (setStockMembership).
//
// The design tree exposes which PhysicalStock each part rides with, and lets a
// reviewer override it. The override action must:
//   1. PIN: setStockMembership(geo, 'stock-2') sets stockId='stock-2' AND
//      stockIdLocked=true (a manual override).
//   2. STICK: a subsequent auto re-sort (assignStocks via a move) must NOT strip
//      the locked membership — the override survives.
//   3. CLEAR: setStockMembership(geo, null) clears the lock and lets
//      auto-containment re-sort the part to the stock that geometrically contains
//      it.
//   4. RE-DERIVE (Item 3 pipeline): after a membership change the gaining derived
//      stock's stored bounds INCLUDE the part and the losing derived stock's
//      EXCLUDE it (rederiveDerivedStockBounds ran).
//   5. FAIL-LOUD (ADR-0003): a non-null id with no matching PhysicalStock throws,
//      never pins the part to a phantom stock.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type {
  ImportedGeometry, SceneStock, PhysicalStock, BoundingBox, Vec3, Project,
} from '../../types'

// -- Fixtures (mirrors derivedRewrap.test.ts harness) --------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// A unit 10x10 2D square; world bounds = loop points transformed by position.
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

function derivedStock(id: string, name = 'Stock'): PhysicalStock {
  return {
    id, name, mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

// An explicit stock that CONTAINS a region: box at `min`, size max-min.
function explicitStock(id: string, name: string, min: Vec3, max: Vec3): PhysicalStock {
  return {
    id, name, mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z }),
    position: { ...min },
  }
}

function autoSceneStock(over: Partial<SceneStock> = {}): SceneStock {
  return {
    mode: 'auto',
    autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [],
    ...over,
  }
}

function installProject(over: Partial<Project>): void {
  useCamStore.setState((s) => ({
    project: { ...s.project, setups: [], ...over },
  }))
}

function getStock(id: string): PhysicalStock {
  const found = useCamStore.getState().project.stocks?.find((st) => st.id === id)
  if (!found) throw new Error(`stock ${id} missing`)
  return found
}

function getGeo(id: string): ImportedGeometry {
  const found = useCamStore.getState().project.geometry.find((g) => g.id === id)
  if (!found) throw new Error(`geo ${id} missing`)
  return found
}

// =============================================================================
// 1 + 2. PIN + STICK: a manual override sets stockId+lock and survives a re-sort.
// =============================================================================

describe('Phase 4 Item 5: setStockMembership PIN + STICK', () => {
  const sceneStock = autoSceneStock()

  beforeEach(() => {
    // geo-1 geometrically lives inside explicit stock-1 (box [0..20]); stock-2 is
    // a far-away box [100..120]. A manual override to stock-2 contradicts
    // containment, which is exactly what makes "STICK" meaningful.
    installProject({
      geometry: [makeGeo({ id: 'geo-1', position: { x: 5, y: 5, z: 0 } })],
      stocks: [
        explicitStock('stock-1', 'Bar A', { x: 0, y: 0, z: 0 }, { x: 20, y: 20, z: 10 }),
        explicitStock('stock-2', 'Bar B', { x: 100, y: 100, z: 0 }, { x: 120, y: 120, z: 10 }),
      ],
      sceneStock,
    })
  })

  it("setStockMembership(geo, 'stock-2') sets stockId='stock-2' AND stockIdLocked=true", () => {
    useCamStore.getState().setStockMembership('geo-1', 'stock-2')
    const geo = getGeo('geo-1')
    expect(geo.stockId).toBe('stock-2')
    expect(geo.stockIdLocked).toBe(true)
  })

  it('a later auto re-sort (via a move) does NOT strip the locked override', () => {
    useCamStore.getState().setStockMembership('geo-1', 'stock-2')
    // Move the part — this runs assignStocks. With the lock held, containment
    // (which would put it back in stock-1) must NOT override the manual choice.
    useCamStore.getState().updateGeometryTransform(
      'geo-1', { x: 6, y: 6, z: 0 }, { x: 0, y: 0, z: 0 },
    )
    const geo = getGeo('geo-1')
    expect(geo.stockId).toBe('stock-2')      // override held
    expect(geo.stockIdLocked).toBe(true)
  })
})

// =============================================================================
// 3. CLEAR: null drops the lock and auto-containment re-sorts to the container.
// =============================================================================

describe('Phase 4 Item 5: setStockMembership(geo, null) returns to auto', () => {
  const sceneStock = autoSceneStock()

  beforeEach(() => {
    // geo-1 physically sits inside stock-1 ([0..20]) but is manually PINNED to the
    // far stock-2. Clearing the lock must re-sort it back into stock-1.
    installProject({
      geometry: [makeGeo({
        id: 'geo-1', position: { x: 5, y: 5, z: 0 },
        stockId: 'stock-2', stockIdLocked: true,
      })],
      stocks: [
        explicitStock('stock-1', 'Bar A', { x: 0, y: 0, z: 0 }, { x: 20, y: 20, z: 10 }),
        explicitStock('stock-2', 'Bar B', { x: 100, y: 100, z: 0 }, { x: 120, y: 120, z: 10 }),
      ],
      sceneStock,
    })
  })

  it('clears the lock and re-sorts the part into its containing stock', () => {
    useCamStore.getState().setStockMembership('geo-1', null)
    const geo = getGeo('geo-1')
    expect(geo.stockIdLocked).toBe(false)
    // Auto-containment moved it from the pinned stock-2 back into stock-1.
    expect(geo.stockId).toBe('stock-1')
  })
})

// =============================================================================
// 4. RE-DERIVE: gaining derived stock includes the part, losing one excludes it.
// =============================================================================

describe('Phase 4 Item 5: membership change re-derives both derived stocks (Item 3 pipeline)', () => {
  const sceneStock = autoSceneStock()

  beforeEach(() => {
    // Two DERIVED stocks. geo-1 starts pinned to stock-A. We then re-pin it to
    // stock-B and assert stock-B grows to include it while stock-A shrinks to
    // exclude it. stock-A keeps a second member so it does not go memberless
    // (which would hold prior bounds).
    const stockA = derivedStock('stock-A', 'A')
    const stockB = derivedStock('stock-B', 'B')
    const geo1 = makeGeo({ id: 'geo-1', stockId: 'stock-A', stockIdLocked: true,
      position: { x: 0, y: 0, z: 0 } })
    const anchorA = makeGeo({ id: 'geo-anchorA', stockId: 'stock-A', stockIdLocked: true,
      position: { x: 50, y: 0, z: 0 } })
    const seedB = makeGeo({ id: 'geo-seedB', stockId: 'stock-B', stockIdLocked: true,
      position: { x: 300, y: 300, z: 0 } })
    installProject({
      geometry: [geo1, anchorA, seedB],
      stocks: [stockA, stockB],
      sceneStock,
    })
    // Prime stored bounds via a zero-effect re-pin of the anchors (re-runs the
    // pipeline so stored derived bounds reflect current members).
    useCamStore.getState().setStockMembership('geo-anchorA', 'stock-A')
    useCamStore.getState().setStockMembership('geo-seedB', 'stock-B')
  })

  it('re-pinning geo-1 to stock-B grows B to include it and shrinks A to exclude it', () => {
    const beforeA = getStock('stock-A').bounds
    const beforeB = getStock('stock-B').bounds
    // geo-1 (a 10x10 square at origin) currently keeps stock-A's min at -2.
    expect(beforeA.min.x).toBeCloseTo(0 - 2, 9)
    // stock-B before only owns seedB at (300,300): min.x = 298.
    expect(beforeB.min.x).toBeCloseTo(300 - 2, 9)

    useCamStore.getState().setStockMembership('geo-1', 'stock-B')

    const afterA = getStock('stock-A').bounds
    const afterB = getStock('stock-B').bounds
    // stock-A lost geo-1; only anchorA (at x 50..60) remains -> min.x = 48.
    expect(afterA.min.x).toBeCloseTo(50 - 2, 9)
    // stock-B gained geo-1 (at x 0..10) -> its min.x drops to include it: -2.
    expect(afterB.min.x).toBeCloseTo(0 - 2, 9)
    // Sanity: bounds genuinely changed.
    expect(afterA).not.toEqual(beforeA)
    expect(afterB).not.toEqual(beforeB)
    // Membership recorded on the part.
    expect(getGeo('geo-1').stockId).toBe('stock-B')
    expect(getGeo('geo-1').stockIdLocked).toBe(true)
  })
})

// =============================================================================
// 5. FAIL-LOUD: a non-null unknown stock id throws (ADR-0003).
// =============================================================================

describe('Phase 4 Item 5: setStockMembership fail-loud on unknown stock id', () => {
  beforeEach(() => {
    installProject({
      geometry: [makeGeo({ id: 'geo-1' })],
      stocks: [derivedStock('stock-only')],
      sceneStock: autoSceneStock(),
    })
  })

  it('throws when the target stock id does not exist', () => {
    expect(() =>
      useCamStore.getState().setStockMembership('geo-1', 'does-not-exist'),
    ).toThrow(/no PhysicalStock with id "does-not-exist"/)
    // The part is untouched (no phantom pin).
    expect(getGeo('geo-1').stockId).not.toBe('does-not-exist')
  })
})
