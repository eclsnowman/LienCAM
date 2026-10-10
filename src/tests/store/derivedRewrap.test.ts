// Coordinate hierarchy Phase 4 (Item 3): DERIVED stock bounds re-wrap EAGERLY in
// DATA on a member move / add / remove.
//
// Before Phase 4, deriveStockBounds ran only LAZILY at dispatch time, so a derived
// stock's STORED PhysicalStock.bounds went stale whenever a member geometry moved
// (recon FACT C). The store now re-derives and stores each derived stock's bounds
// from ITS OWN members (geo.stockId === stock.id) after the membership re-sort in
// updateGeometryTransform / addGeometry / removeGeometry.
//
// This file proves:
//   1. RE-WRAP: moving a derived member re-wraps the owning derived stock's STORED
//      bounds to include the new position (bounds change vs before).
//   2. GUARDRAIL b: a SECOND derived stock's stored bounds are untouched by the
//      move (no all-stocks / all-geometry aggregate; each stock re-derives from
//      its OWN members only).
//   3. OTHER MEMBERS STATIC: a non-moved member's resolved world placement is
//      unchanged by the re-wrap.
//   4. NO DIVERGENCE (handoff item 4): single-derived-stock case keeps stored
//      bounds byte-equal to what deriveAutoStockBounds would give after the move.
//   5. ADD / REMOVE: a new member grows, and a removed member shrinks, the stored
//      derived bounds.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { deriveAutoStockBounds } from '../../store/dispatchGeo'
import type {
  ImportedGeometry, SceneStock, PhysicalStock, BoundingBox, Vec3, Project,
} from '../../types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// A unit 10x10 2D square at the origin (loop points 0..10). World bounds = the
// loop points transformed by position/rotation; z = position.z.
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
    project: {
      ...s.project,
      setups: [],
      ...over,
    },
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
// 1 + 2 + 3. Move a derived member: owning stock re-wraps; sibling untouched.
// =============================================================================

describe('Phase 4 Item 3: derived stock re-wraps on member move', () => {
  // Two derived stocks. stockA owns geoA1 + geoA2 (locked so the move cannot
  // re-sort membership and confound the test). stockB owns geoB (locked).
  // Moving geoA1 must re-wrap stockA only; stockB stays put.
  const sceneStock = autoSceneStock()

  beforeEach(() => {
    const stockA = derivedStock('stock-A', 'A')
    const stockB = derivedStock('stock-B', 'B')
    const geoA1 = makeGeo({ id: 'geo-A1', stockId: 'stock-A', stockIdLocked: true,
      position: { x: 0, y: 0, z: 0 } })
    const geoA2 = makeGeo({ id: 'geo-A2', stockId: 'stock-A', stockIdLocked: true,
      position: { x: 20, y: 0, z: 0 } })
    const geoB = makeGeo({ id: 'geo-B', stockId: 'stock-B', stockIdLocked: true,
      position: { x: 200, y: 200, z: 0 } })
    installProject({
      geometry: [geoA1, geoA2, geoB],
      stocks: [stockA, stockB],
      sceneStock,
    })
    // Seed both stocks with FRESH derived bounds (simulate the post-load state),
    // by nudging each member by zero is not enough (zero-delta is skipped), so we
    // assert against a recomputed baseline instead. Capture baselines now.
  })

  it('owning stock bounds re-wrap to include the moved member position (change vs before)', () => {
    const before = getStock('stock-A').bounds
    // Move geoA1 far in +X/+Y/+Z. Members A span x [0..30] before (A1 0..10, A2 20..30).
    // After A1 -> +100/+50/+5, members span x [20..110], y [50..60]+[0..10], z 0..5.
    useCamStore.getState().updateGeometryTransform(
      'geo-A1', { x: 100, y: 50, z: 5 }, { x: 0, y: 0, z: 0 },
    )
    const after = getStock('stock-A').bounds
    // Bounds actually changed (not stale).
    expect(after).not.toEqual(before)
    // Re-wrapped to the new extent: A1 now [100..110]x[50..60]z5, A2 [20..30]x[0..10]z0.
    // Padded autoOffsetXY=2 each XY side; base z = min member z (0), top z = max(5)+1.
    expect(after.min.x).toBeCloseTo(20 - 2, 9)   // A2 min x 20 - pad
    expect(after.max.x).toBeCloseTo(110 + 2, 9)  // A1 max x 110 + pad
    expect(after.min.y).toBeCloseTo(0 - 2, 9)    // A2 min y 0 - pad
    expect(after.max.y).toBeCloseTo(60 + 2, 9)   // A1 max y 60 + pad
    expect(after.min.z).toBeCloseTo(0, 9)        // min member z, no Z base pad
    expect(after.max.z).toBeCloseTo(5 + 1, 9)    // max member z + autoOffsetZTop
  })

  it('a SECOND derived stock derives only from its OWN members (guardrail b: no all-stocks aggregate)', () => {
    // Move geoA1 RIGHT ON TOP of stockB's region. If a forbidden all-stocks /
    // all-geometry aggregate were used, stockB's bounds would absorb geoA1's new
    // position. Because each derived stock re-derives from ITS OWN members only,
    // stockB must reflect ONLY geoB (still at 200,200) and ignore geoA1 entirely.
    useCamStore.getState().updateGeometryTransform(
      'geo-A1', { x: 200, y: 200, z: 0 }, { x: 0, y: 0, z: 0 },
    )
    const afterB = getStock('stock-B').bounds
    // geoB is a 10x10 square at (200,200): world [200..210]x[200..210], z 0.
    // Padded autoOffsetXY=2 each XY side, base z 0, top z 0 + autoOffsetZTop(1).
    expect(afterB.min.x).toBeCloseTo(200 - 2, 9)
    expect(afterB.min.y).toBeCloseTo(200 - 2, 9)
    expect(afterB.max.x).toBeCloseTo(210 + 2, 9)
    expect(afterB.max.y).toBeCloseTo(210 + 2, 9)
    expect(afterB.max.z).toBeCloseTo(0 + 1, 9)
    // geoA1 (also now at 200,200) did NOT leak into stockB: its X extent would
    // have pushed min.x to 198 either way, but a leak would ALSO drag stockB's
    // bounds toward A2 (at 20..30) via an aggregate. Assert min.x is exactly
    // geoB's 198, never the lower stock-A extent (18).
    expect(afterB.min.x).not.toBeCloseTo(20 - 2, 6)
    // And geoA1 still belongs to stock-A (lock held), so membership did not leak.
    expect(getGeo('geo-A1').stockId).toBe('stock-A')
  })

  it("a non-moved member's resolved world position is unchanged by the re-wrap", () => {
    const beforeA2 = { ...getGeo('geo-A2').position }
    const beforeB = { ...getGeo('geo-B').position }
    useCamStore.getState().updateGeometryTransform(
      'geo-A1', { x: 100, y: 50, z: 5 }, { x: 0, y: 0, z: 0 },
    )
    // Sibling members keep their own placement; only the moved part moved.
    expect(getGeo('geo-A2').position).toEqual(beforeA2)
    expect(getGeo('geo-B').position).toEqual(beforeB)
  })
})

// =============================================================================
// 4. NO DIVERGENCE: single-derived-stock stored bounds == deriveAutoStockBounds.
// =============================================================================

describe('Phase 4 Item 3: single-stock stored bounds match deriveAutoStockBounds after move', () => {
  const sceneStock = autoSceneStock()

  beforeEach(() => {
    const stock = derivedStock('stock-only')
    const geo1 = makeGeo({ id: 'geo-1', stockId: 'stock-only', position: { x: 0, y: 0, z: 0 } })
    const geo2 = makeGeo({ id: 'geo-2', stockId: 'stock-only', position: { x: 30, y: 0, z: 0 } })
    installProject({ geometry: [geo1, geo2], stocks: [stock], sceneStock })
  })

  it('after a member move, stored derived bounds equal deriveAutoStockBounds(all geometry)', () => {
    useCamStore.getState().updateGeometryTransform(
      'geo-1', { x: -40, y: 15, z: 3 }, { x: 0, y: 0, z: 0 },
    )
    const stored = getStock('stock-only').bounds
    const allGeo = useCamStore.getState().project.geometry
    const auto = deriveAutoStockBounds(allGeo, sceneStock)!
    // Single derived stock owning all geometry: stored bounds == the flat auto box.
    expect(stored.min).toEqual(auto.min)
    expect(stored.max).toEqual(auto.max)
  })
})

// =============================================================================
// 5. ADD / REMOVE: a new member grows, a removed member shrinks, stored bounds.
// =============================================================================

describe('Phase 4 Item 3: derived bounds re-wrap on member add / remove', () => {
  const sceneStock = autoSceneStock()

  beforeEach(() => {
    const stock = derivedStock('stock-only')
    const geo1 = makeGeo({ id: 'geo-1', stockId: 'stock-only', position: { x: 0, y: 0, z: 0 } })
    installProject({ geometry: [geo1], stocks: [stock], sceneStock })
  })

  it('adding a member grows the stored derived bounds', () => {
    const before = getStock('stock-only').bounds
    // New member far in +X, pre-assigned to the derived stock (locked so the
    // containment re-sort keeps it there).
    useCamStore.getState().addGeometry(makeGeo({
      id: 'geo-2', stockId: 'stock-only', stockIdLocked: true,
      position: { x: 100, y: 0, z: 0 },
    }))
    const after = getStock('stock-only').bounds
    expect(after).not.toEqual(before)
    expect(after.max.x).toBeCloseTo(110 + 2, 9) // new member max x 110 + pad
  })

  it('removing a member shrinks the stored derived bounds', () => {
    // Start with two members, then remove the far one.
    useCamStore.getState().addGeometry(makeGeo({
      id: 'geo-2', stockId: 'stock-only', stockIdLocked: true,
      position: { x: 100, y: 0, z: 0 },
    }))
    const wide = getStock('stock-only').bounds
    expect(wide.max.x).toBeCloseTo(110 + 2, 9)
    useCamStore.getState().removeGeometry('geo-2')
    const narrow = getStock('stock-only').bounds
    expect(narrow).not.toEqual(wide)
    expect(narrow.max.x).toBeCloseTo(10 + 2, 9) // only geo-1 (0..10) + pad remains
  })
})

// =============================================================================
// Bug C: an EMPTIED derived stock collapses to a ZERO-VOLUME box (min === max)
// so the viewport (which skips zero-volume) draws no stale box. (Intended fix,
// Operator: an empty stock should disappear. Was previously "keep prior bounds".)
// =============================================================================

describe('Bug C: emptied derived stock collapses to zero-volume bounds', () => {
  const sceneStock = autoSceneStock()

  beforeEach(() => {
    const stock = derivedStock('stock-only')
    const geo1 = makeGeo({ id: 'geo-1', stockId: 'stock-only', position: { x: 0, y: 0, z: 0 } })
    installProject({ geometry: [geo1], stocks: [stock], sceneStock })
  })

  it("removing the LAST member zeroes the stock's bounds (min === max, zero size)", () => {
    // The seeded PhysicalStock starts at the zero placeholder box; trigger one
    // re-derive (a zero-distance-safe move) so the stock holds a REAL non-zero
    // box first, matching the in-app state before the user empties it.
    useCamStore.getState().updateGeometryTransform(
      'geo-1', { x: 0, y: 0, z: 1 }, { x: 0, y: 0, z: 0 },
    )
    const before = getStock('stock-only').bounds
    expect(before.size.x).toBeGreaterThan(0) // now a real 10x10 + pad box
    // None = clears stockId + locks it; the stock loses its only member.
    useCamStore.getState().setGeometryNoStock('geo-1')
    const after = getStock('stock-only').bounds
    expect(after.size).toEqual({ x: 0, y: 0, z: 0 })
    expect(after.min).toEqual(after.max) // zero-volume: viewport skips it
  })
})

// =============================================================================
// Bug E: rederiveDerivedStockBounds honors each derived stock's PER-ITEM offsets
// (sceneStock.autoStocks[].autoOffsetXY/ZTop), NOT the global sceneStock offsets,
// so a user-edited named-stock offset is preserved across a re-derive triggered
// by a member move. Mirrors syncAutoStocksToPhysical's per-item rule.
// =============================================================================

describe('Bug E: re-derive honors per-auto-stock offsets (not the global)', () => {
  // Global offsets are 2 / 1; the named stock's OWN offsets are 7 / 4. After a
  // member move re-derives the bounds, the 7/4 per-item pad must win.
  const PER_XY = 7
  const PER_ZTOP = 4
  const sceneStock = autoSceneStock({
    autoOffsetXY: 2, autoOffsetZTop: 1, // global - must NOT be used for this stock
    autoStocks: [
      { id: 'stock-only', name: 'Named', autoOffsetXY: PER_XY, autoOffsetZTop: PER_ZTOP },
    ],
  })

  beforeEach(() => {
    const stock = derivedStock('stock-only', 'Named')
    const geo1 = makeGeo({ id: 'geo-1', stockId: 'stock-only', stockIdLocked: true,
      position: { x: 0, y: 0, z: 0 } })
    installProject({ geometry: [geo1], stocks: [stock], sceneStock })
  })

  it('a member move re-pads with the per-stock offset, not the global offset', () => {
    // Move the only member to z=5 so the box re-derives.
    useCamStore.getState().updateGeometryTransform(
      'geo-1', { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 },
    )
    const after = getStock('stock-only').bounds
    // 10x10 part at (0,0): members span [0..10]x[0..10], z 5. Per-item pad 7 each
    // XY side; top z = 5 + per-item ZTop 4. If the GLOBAL (2 / 1) had been used
    // these would be 12 / -2 / 6 instead.
    expect(after.min.x).toBeCloseTo(0 - PER_XY, 9)   // not 0 - 2
    expect(after.max.x).toBeCloseTo(10 + PER_XY, 9)  // not 10 + 2
    expect(after.min.y).toBeCloseTo(0 - PER_XY, 9)
    expect(after.max.y).toBeCloseTo(10 + PER_XY, 9)
    expect(after.max.z).toBeCloseTo(5 + PER_ZTOP, 9) // not 5 + 1
  })
})
