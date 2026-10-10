// Coordinate-hierarchy Phase 1: geometry <-> stock LINKAGE (logic + tests).
//
// Mirrors autoStock.test.ts style. Two layers:
//   1. Pure functions (stockAssignment.ts): assignGeometryToStocks by AABB
//      containment, deriveStockBounds over MEMBER geometry, getUnassignedGeometry.
//   2. Store integration: setGeometryStock sets stockId + stockIdLocked.
//
// The derive functions reuse geometryWorldBounds (so 2D/3D world AABBs match the
// auto-stock derive exactly), and deriveStockBounds with members == all geometry
// is numerically IDENTICAL to deriveAutoStockBounds (the migrated common case).

import { describe, it, expect } from 'vitest'
import {
  assignGeometryToStocks,
  deriveStockBounds,
  stockWorldBounds,
  getUnassignedGeometry,
} from '../../store/stockAssignment'
import { deriveAutoStockBounds } from '../../store/dispatchGeo'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import { useCamStore } from '../../store'
import { migrateProjectData } from '../../store/migrations/projectMigrations'
import type {
  ImportedGeometry, PhysicalStock, SceneStock, Loop2D, BoundingBox,
} from '../../types'

// -- Shared fixtures -----------------------------------------------------------

const OFF_XY = 2
const Z_TOP = 1

function makeAutoSceneStock(over: Partial<SceneStock> = {}): SceneStock {
  return {
    mode: 'auto',
    autoOffsetXY: OFF_XY, autoOffsetZTop: Z_TOP,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [],
    ...over,
  }
}

function makeMeshGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: -25, y: -25, z: 0 }, max: { x: 25, y: 25, z: 10 },
      size: { x: 50, y: 50, z: 10 }, center: { x: 0, y: 0, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ...over,
  }
}

function make2DGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  const loop: Loop2D = {
    id: 'loop-1',
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    closed: true, type: 'contour', layerId: 'L1', area: 100,
  }
  return {
    id: 'geo-2d', name: 'Sketch', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [loop],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    ...over,
  }
}

/** Explicit PhysicalStock from a world min corner + size (bounds.min is the
 *  local origin; world AABB = position .. position+size). */
function makeExplicitStock(
  id: string, pos: { x: number; y: number; z: number },
  size: { x: number; y: number; z: number },
): PhysicalStock {
  const bounds: BoundingBox = {
    min: { x: 0, y: 0, z: 0 },
    max: { x: size.x, y: size.y, z: size.z },
    size: { ...size },
    center: { x: size.x / 2, y: size.y / 2, z: size.z / 2 },
  }
  return { id, name: id, mode: 'explicit', bounds, position: pos }
}

function makeDerivedStock(id = DERIVED_STOCK_ID): PhysicalStock {
  return {
    id, name: 'Stock', mode: 'derived',
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
      size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
  }
}

// -- 1. stockWorldBounds --------------------------------------------------------

describe('stockWorldBounds', () => {
  it('explicit: world AABB = position .. position + size', () => {
    const s = makeExplicitStock('s1', { x: 10, y: 20, z: 0 }, { x: 100, y: 80, z: 12 })
    const b = stockWorldBounds(s)
    expect(b.min).toEqual({ x: 10, y: 20, z: 0 })
    expect(b.max).toEqual({ x: 110, y: 100, z: 12 })
  })

  it('derived: stored bounds verbatim (already world-space)', () => {
    const s: PhysicalStock = {
      ...makeDerivedStock(),
      bounds: {
        min: { x: -27, y: -27, z: 0 }, max: { x: 27, y: 27, z: 11 },
        size: { x: 54, y: 54, z: 11 }, center: { x: 0, y: 0, z: 5.5 },
      },
    }
    const b = stockWorldBounds(s)
    expect(b.min).toEqual({ x: -27, y: -27, z: 0 })
    expect(b.max).toEqual({ x: 27, y: 27, z: 11 })
  })
})

// -- 2. assignGeometryToStocks (containment) -----------------------------------

describe('assignGeometryToStocks', () => {
  it('3D geometry inside one explicit stock is assigned to it', () => {
    // mesh world AABB -25..25 / 0..10. Explicit box -30..30 / -5..20 contains it.
    const stocks = [makeDerivedStock(), makeExplicitStock(
      'big', { x: -30, y: -30, z: -5 }, { x: 60, y: 60, z: 25 })]
    const out = assignGeometryToStocks([makeMeshGeo()], stocks)
    expect(out[0].stockId).toBe('big')
  })

  it('2D geometry inside an explicit stock is assigned to it', () => {
    // 2D loops world AABB 0..10 (X/Y) flat at z 0. Box -1..11 / -1..1 contains it.
    const stocks = [makeDerivedStock(), makeExplicitStock(
      'plate', { x: -1, y: -1, z: -1 }, { x: 12, y: 12, z: 2 })]
    const out = assignGeometryToStocks([make2DGeo()], stocks)
    expect(out[0].stockId).toBe('plate')
  })

  it('geometry outside all explicit stocks falls to the derived stock', () => {
    const stocks = [makeDerivedStock(), makeExplicitStock(
      'tiny', { x: 100, y: 100, z: 0 }, { x: 5, y: 5, z: 5 })]
    const out = assignGeometryToStocks([makeMeshGeo()], stocks)
    expect(out[0].stockId).toBe(DERIVED_STOCK_ID)
  })

  it('nested explicit stocks: the smallest containing one wins', () => {
    // Both contain the mesh (-25..25 / 0..10); inner is smaller volume.
    const outer = makeExplicitStock('outer', { x: -40, y: -40, z: -5 }, { x: 80, y: 80, z: 30 })
    const inner = makeExplicitStock('inner', { x: -26, y: -26, z: -1 }, { x: 52, y: 52, z: 13 })
    // Order outer-first to prove selection is by volume, not array order.
    const out = assignGeometryToStocks([makeMeshGeo()], [makeDerivedStock(), outer, inner])
    expect(out[0].stockId).toBe('inner')
  })

  it('equal-volume containing stocks: ties go to the first by array order', () => {
    const a = makeExplicitStock('a', { x: -30, y: -30, z: -5 }, { x: 60, y: 60, z: 25 })
    const b = makeExplicitStock('b', { x: -30, y: -30, z: -5 }, { x: 60, y: 60, z: 25 })
    const out = assignGeometryToStocks([makeMeshGeo()], [a, b, makeDerivedStock()])
    expect(out[0].stockId).toBe('a')
  })

  it('stockIdLocked geometry keeps its manual stockId (auto-assign skips it)', () => {
    // Geometry sits inside 'big' but is locked to the derived stock.
    const locked = makeMeshGeo({ stockId: DERIVED_STOCK_ID, stockIdLocked: true })
    const stocks = [makeDerivedStock(), makeExplicitStock(
      'big', { x: -30, y: -30, z: -5 }, { x: 60, y: 60, z: 25 })]
    const out = assignGeometryToStocks([locked], stocks)
    expect(out[0].stockId).toBe(DERIVED_STOCK_ID)
    expect(out[0]).toBe(locked) // unchanged reference
  })

  it('no derived stock + no containing explicit stock -> stockId undefined', () => {
    const stocks = [makeExplicitStock('tiny', { x: 100, y: 100, z: 0 }, { x: 5, y: 5, z: 5 })]
    const out = assignGeometryToStocks([makeMeshGeo()], stocks)
    expect(out[0].stockId).toBeUndefined()
  })

  it('only clones geometry whose stockId changes', () => {
    const already = makeMeshGeo({ stockId: 'big' })
    const stocks = [makeDerivedStock(), makeExplicitStock(
      'big', { x: -30, y: -30, z: -5 }, { x: 60, y: 60, z: 25 })]
    const out = assignGeometryToStocks([already], stocks)
    expect(out[0]).toBe(already) // no change -> same reference
  })
})

// -- 3. deriveStockBounds -------------------------------------------------------

describe('deriveStockBounds', () => {
  it('explicit: returns stored bounds unchanged', () => {
    const s = makeExplicitStock('s1', { x: 10, y: 20, z: 0 }, { x: 100, y: 80, z: 12 })
    expect(deriveStockBounds(s, [], makeAutoSceneStock())).toBe(s.bounds)
  })

  it('derived: wraps ONLY its members (differs from the all-geometry aggregate)', () => {
    const derived = makeDerivedStock()
    // Two parts: the centered mesh (member) + a far-away mesh that is NOT a member.
    const member = makeMeshGeo({ id: 'm', stockId: DERIVED_STOCK_ID })
    const nonMember = makeMeshGeo({
      id: 'far', stockId: 'other',
      position: { x: 200, y: 0, z: 0 },
    })
    const sceneStock = makeAutoSceneStock()
    const memberOnly = deriveStockBounds(derived, [member, nonMember], sceneStock)!
    // Member-only box matches the lone centered mesh: -27..27 / 0..11.
    expect(memberOnly.min).toEqual({ x: -27, y: -27, z: 0 })
    expect(memberOnly.max).toEqual({ x: 27, y: 27, z: 11 })
    // The all-geometry aggregate stretches X to the far mesh (pos.x 200 +
    // local max 25 = 225, + OFF_XY) — prove member-only differs from it.
    const aggregate = deriveAutoStockBounds([member, nonMember], sceneStock)!
    expect(aggregate.max.x).toBeCloseTo(225 + OFF_XY, 9)
    expect(memberOnly.max.x).not.toBeCloseTo(aggregate.max.x, 3)
  })

  it('derived: null when no member geometry contributes bounds', () => {
    const derived = makeDerivedStock()
    const nonMember = makeMeshGeo({ id: 'far', stockId: 'other' })
    expect(deriveStockBounds(derived, [nonMember], makeAutoSceneStock())).toBeNull()
  })

  it('equals deriveAutoStockBounds when members == all geometry (numeric)', () => {
    const derived = makeDerivedStock()
    const all = [
      makeMeshGeo({ id: 'a', stockId: DERIVED_STOCK_ID }),
      make2DGeo({ id: 'b', stockId: DERIVED_STOCK_ID, position: { x: 40, y: 5, z: 0 } }),
    ]
    const sceneStock = makeAutoSceneStock()
    const derivedBounds = deriveStockBounds(derived, all, sceneStock)!
    const autoBounds = deriveAutoStockBounds(all, sceneStock)!
    expect(derivedBounds.min.x).toBeCloseTo(autoBounds.min.x, 9)
    expect(derivedBounds.min.y).toBeCloseTo(autoBounds.min.y, 9)
    expect(derivedBounds.min.z).toBeCloseTo(autoBounds.min.z, 9)
    expect(derivedBounds.max.x).toBeCloseTo(autoBounds.max.x, 9)
    expect(derivedBounds.max.y).toBeCloseTo(autoBounds.max.y, 9)
    expect(derivedBounds.max.z).toBeCloseTo(autoBounds.max.z, 9)
  })

  // -- AUTO-STOCK-BOTTOM: deriveStockBounds applies the bottom allowance -------
  it('derived: positive autoOffsetZBottom extends ONLY min.z downward', () => {
    const derived = makeDerivedStock()
    const member = makeMeshGeo({ id: 'm', stockId: DERIVED_STOCK_ID })
    const b = deriveStockBounds(derived, [member], makeAutoSceneStock({ autoOffsetZBottom: 5 }))!
    expect(b.min).toEqual({ x: -27, y: -27, z: -5 }) // min 0 minus 5mm allowance
    expect(b.max).toEqual({ x: 27, y: 27, z: 11 })  // top unchanged
  })

  it('derived: zero / missing autoOffsetZBottom preserves base === min Z', () => {
    const derived = makeDerivedStock()
    const member = makeMeshGeo({ id: 'm', stockId: DERIVED_STOCK_ID })
    expect(deriveStockBounds(derived, [member], makeAutoSceneStock({ autoOffsetZBottom: 0 }))!.min.z).toBe(0)
    expect(deriveStockBounds(derived, [member], makeAutoSceneStock())!.min.z).toBe(0) // undefined -> ?? 0
  })

  it('derived: bottom allowance matches deriveAutoStockBounds for the same offsets', () => {
    const derived = makeDerivedStock()
    const all = [makeMeshGeo({ id: 'a', stockId: DERIVED_STOCK_ID })]
    const sceneStock = makeAutoSceneStock({ autoOffsetZBottom: 4 })
    const derivedBounds = deriveStockBounds(derived, all, sceneStock)!
    const autoBounds = deriveAutoStockBounds(all, sceneStock)!
    expect(derivedBounds.min.z).toBeCloseTo(autoBounds.min.z, 9) // both -4
    expect(derivedBounds.max.z).toBeCloseTo(autoBounds.max.z, 9)
  })
})

// -- 4. getUnassignedGeometry ---------------------------------------------------

describe('getUnassignedGeometry', () => {
  it('flags geometry with undefined stockId and dangling (no-such-stock) stockId', () => {
    const stocks = [makeDerivedStock(), makeExplicitStock(
      'big', { x: -30, y: -30, z: -5 }, { x: 60, y: 60, z: 25 })]
    const undefined_ = makeMeshGeo({ id: 'u', stockId: undefined })
    const dangling = makeMeshGeo({ id: 'd', stockId: 'ghost-stock' })
    const ok = makeMeshGeo({ id: 'k', stockId: 'big' })
    const out = getUnassignedGeometry([undefined_, dangling, ok], stocks)
    const ids = out.map((g) => g.id).sort()
    expect(ids).toEqual(['d', 'u'])
  })

  it('returns empty when every geometry points to an existing stock', () => {
    const stocks = [makeDerivedStock()]
    const out = getUnassignedGeometry(
      [makeMeshGeo({ stockId: DERIVED_STOCK_ID })], stocks)
    expect(out).toEqual([])
  })
})

// -- 5. Store integration: setGeometryStock ------------------------------------

describe('setGeometryStock (store action)', () => {
  it('sets stockId AND stockIdLocked = true (manual override)', () => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [makeMeshGeo({ id: 'g1' })],
        stocks: [makeDerivedStock(), makeExplicitStock(
          'explicit-1', { x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 10 })],
      },
    }))
    useCamStore.getState().setGeometryStock('g1', 'explicit-1')
    const geo = useCamStore.getState().project.geometry.find((g) => g.id === 'g1')!
    expect(geo.stockId).toBe('explicit-1')
    expect(geo.stockIdLocked).toBe(true)
  })
})

// -- 6. New-project path: the derived stock + auto-assign close the Phase 2 gap -
//
// A freshly created project must carry the derived PhysicalStock so addGeometry's
// assignStocks (guarded: no-op when stocks is empty) actually runs. Without the
// derived stock, new-project geometry never gets a stockId -> Phase 2 fail-loud.

// -- 7. Named AUTO stocks: store actions + derived sync -------------------------

import { DERIVED_STOCK_ID as DSID } from '../../store/migrateHierarchy'
import type { AutoStockItem } from '../../types'

function autoItem(over: Partial<AutoStockItem> = {}): AutoStockItem {
  return { id: 'auto-1', name: 'Auto', autoOffsetXY: OFF_XY, autoOffsetZTop: Z_TOP, ...over }
}

describe('addAutoStock / updateAutoStock / removeAutoStock (store actions)', () => {
  it('addAutoStock yields a derived PhysicalStock; catch-all + derived intact when empty', () => {
    useCamStore.getState().newProject()
    const before = useCamStore.getState().project.stocks ?? []
    // No-autoStock project: exactly the lone derived (catch-all) stock.
    expect(before.length).toBe(1)
    expect(before[0].id).toBe(DSID)

    useCamStore.getState().addAutoStock(autoItem({ id: 'auto-1', name: 'Fixture A' }))
    const stocks = useCamStore.getState().project.stocks ?? []
    const auto = stocks.find((s) => s.id === 'auto-1')!
    expect(auto).toBeDefined()
    expect(auto.mode).toBe('derived')
    expect(auto.name).toBe('Fixture A')
    // The catch-all derived stock is preserved.
    expect(stocks.some((s) => s.id === DSID)).toBe(true)
  })

  it('no-autoStock project: store stocks are byte-identical before/after a no-op sync', () => {
    useCamStore.getState().newProject()
    const before = structuredClone(useCamStore.getState().project.stocks)
    // Adding then removing an auto stock with no members returns to the same set.
    useCamStore.getState().addAutoStock(autoItem({ id: 'tmp' }))
    useCamStore.getState().removeAutoStock('tmp')
    const after = useCamStore.getState().project.stocks
    expect(after).toEqual(before)
  })

  it('updateAutoStock propagates a name edit to the derived stock', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addAutoStock(autoItem({ id: 'auto-1', name: 'Old' }))
    useCamStore.getState().updateAutoStock('auto-1', { name: 'New' })
    const auto = (useCamStore.getState().project.stocks ?? []).find((s) => s.id === 'auto-1')!
    expect(auto.name).toBe('New')
    expect(useCamStore.getState().project.sceneStock.autoStocks!.find((a) => a.id === 'auto-1')!.name)
      .toBe('New')
  })

  it('removeAutoStock unassigns its members so they fall back to the catch-all', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addAutoStock(autoItem({ id: 'auto-1' }))
    // A member pinned to the auto stock.
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [makeMeshGeo({ id: 'm1', stockId: 'auto-1', stockIdLocked: true })],
      },
    }))
    useCamStore.getState().removeAutoStock('auto-1')
    const stocks = useCamStore.getState().project.stocks ?? []
    expect(stocks.some((s) => s.id === 'auto-1')).toBe(false)
    const m = useCamStore.getState().project.geometry.find((g) => g.id === 'm1')!
    // Lock cleared + re-sorted to the catch-all derived stock.
    expect(m.stockIdLocked).toBe(false)
    expect(m.stockId).toBe(DSID)
  })

  it('auto stock bounds wrap ONLY its members (+ its own offsets)', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addAutoStock(autoItem({ id: 'auto-1', autoOffsetXY: 2, autoOffsetZTop: 1 }))
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [
          // member: centered mesh -25..25 / 0..10
          makeMeshGeo({ id: 'm1', stockId: 'auto-1', stockIdLocked: true }),
          // non-member far away, on the catch-all
          makeMeshGeo({ id: 'm2', stockId: DSID, position: { x: 300, y: 0, z: 0 } }),
        ],
      },
    }))
    // Re-derive by touching the auto stock (no-op name patch triggers sync).
    useCamStore.getState().updateAutoStock('auto-1', {})
    const auto = (useCamStore.getState().project.stocks ?? []).find((s) => s.id === 'auto-1')!
    expect(auto.bounds.min).toEqual({ x: -27, y: -27, z: 0 })
    expect(auto.bounds.max).toEqual({ x: 27, y: 27, z: 11 })
  })

  it('AUTO-STOCK-BOTTOM (AT8): per-stock autoOffsetZBottom overrides the global fallback', () => {
    useCamStore.getState().newProject()
    // Named auto stock with its OWN bottom allowance of 5mm.
    useCamStore.getState().addAutoStock(
      autoItem({ id: 'auto-1', autoOffsetXY: 2, autoOffsetZTop: 1, autoOffsetZBottom: 5 }),
    )
    // Member pinned to it: centered mesh -25..25 / 0..10.
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [makeMeshGeo({ id: 'm1', stockId: 'auto-1', stockIdLocked: true })],
      },
    }))
    // Set the GLOBAL bottom allowance to a DIFFERENT value (1mm) to prove the
    // per-stock value wins.
    useCamStore.getState().updateSceneStock({ autoOffsetZBottom: 1 })
    // Re-trigger the per-stock sync (no-op patch runs syncAutoStocksToPhysical,
    // which reads the per-auto offset, NOT the global).
    useCamStore.getState().updateAutoStock('auto-1', {})
    const auto = (useCamStore.getState().project.stocks ?? []).find((s) => s.id === 'auto-1')!
    // Per-stock 5mm wins over global 1mm: base = 0 - 5 = -5 (not -1).
    expect(auto.bounds.min.z).toBe(-5)
    expect(auto.bounds.max.z).toBe(11) // top unchanged
  })

  it('AUTO-STOCK-BOTTOM: updateAutoStock editing autoOffsetZBottom re-derives the base downward', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addAutoStock(
      autoItem({ id: 'auto-1', autoOffsetXY: 2, autoOffsetZTop: 1 }),
    )
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [makeMeshGeo({ id: 'm1', stockId: 'auto-1', stockIdLocked: true })],
      },
    }))
    useCamStore.getState().updateAutoStock('auto-1', {})
    let auto = (useCamStore.getState().project.stocks ?? []).find((s) => s.id === 'auto-1')!
    expect(auto.bounds.min.z).toBe(0) // no bottom allowance yet
    useCamStore.getState().updateAutoStock('auto-1', { autoOffsetZBottom: 4 })
    auto = (useCamStore.getState().project.stocks ?? []).find((s) => s.id === 'auto-1')!
    expect(auto.bounds.min.z).toBe(-4) // base extended 4mm down
    expect(auto.bounds.max.z).toBe(11)
  })
})

// -- 8. Explicit geometry -> auto-stock membership (setGeometryAutoStock) -------

// -- 7b. AUTO-STOCK-BOTTOM: save/load round-trip preserves the bottom allowance -
describe('autoOffsetZBottom project round-trip (AT3)', () => {
  it('a present autoOffsetZBottom survives JSON serialize + migrateProjectData', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addAutoStock(autoItem({ id: 'auto-1', autoOffsetZBottom: 3 }))
    const project = useCamStore.getState().project
    // Simulate the save -> load serialization boundary (JSON.stringify/parse is
    // exactly what saveProjectToFile/loadProjectFromFile cross).
    const raw = JSON.parse(JSON.stringify(project))
    expect(raw.sceneStock.autoStocks.find((a: AutoStockItem) => a.id === 'auto-1').autoOffsetZBottom)
      .toBe(3) // the value is carried by the serialization
    const migrated = migrateProjectData(raw)
    // Additive field with no migration step: the value passes through untouched.
    expect(migrated.sceneStock.autoStocks!.find((a) => a.id === 'auto-1')!.autoOffsetZBottom)
      .toBe(3)
  })

  it('a MISSING autoOffsetZBottom (old project) loads undefined and reads as 0 (back-compat)', () => {
    useCamStore.getState().newProject()
    const project = useCamStore.getState().project
    // Strip the field to emulate a pre-field saved project.
    const raw = JSON.parse(JSON.stringify(project))
    for (const a of raw.sceneStock.autoStocks ?? []) delete a.autoOffsetZBottom
    delete raw.sceneStock.autoOffsetZBottom
    const migrated = migrateProjectData(raw)
    const item = migrated.sceneStock.autoStocks![0]
    expect(item.autoOffsetZBottom).toBeUndefined() // not synthesized by migration
    // And the read boundary coalesces it to 0 (prior base === min Z preserved).
    const b = deriveStockBounds(
      { id: item.id, name: item.name, mode: 'derived', bounds: project.stocks![0].bounds, position: { x: 0, y: 0, z: 0 } },
      [],
      { autoOffsetXY: item.autoOffsetXY, autoOffsetZTop: item.autoOffsetZTop, autoOffsetZBottom: item.autoOffsetZBottom },
    )
    // No member geometry -> null (byte-identical to the pre-field behavior).
    expect(b).toBeNull()
  })
})

import type { FixedStockItem } from '../../types'

describe('setGeometryAutoStock (explicit membership)', () => {
  it('assigns 2 of 3 parts; the auto stock wraps exactly those 2 (+offsets) and survives addFixedStock', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addAutoStock(autoItem({ id: 'auto-1', autoOffsetXY: 2, autoOffsetZTop: 1 }))
    // Three meshes, each 50x50x10 local, placed apart in X.
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [
          makeMeshGeo({ id: 'p1', position: { x: 0, y: 0, z: 0 } }),    // world -25..25
          makeMeshGeo({ id: 'p2', position: { x: 60, y: 0, z: 0 } }),   // world 35..85
          makeMeshGeo({ id: 'p3', position: { x: 500, y: 0, z: 0 } }),  // far away
        ],
      },
    }))
    // Pin p1 + p2 to the auto stock; leave p3 alone.
    useCamStore.getState().setGeometryAutoStock('p1', 'auto-1')
    useCamStore.getState().setGeometryAutoStock('p2', 'auto-1')

    const stocks = useCamStore.getState().project.stocks ?? []
    const auto = stocks.find((s) => s.id === 'auto-1')!
    // Members union: X -25..85, Y -25..25, Z 0..10. + offsets (2 XY, 1 ZTop).
    expect(auto.bounds.min).toEqual({ x: -27, y: -27, z: 0 })
    expect(auto.bounds.max).toEqual({ x: 87, y: 27, z: 11 })

    const g = useCamStore.getState().project.geometry
    expect(g.find((x) => x.id === 'p1')!.stockId).toBe('auto-1')
    expect(g.find((x) => x.id === 'p1')!.stockIdLocked).toBe(true)
    expect(g.find((x) => x.id === 'p2')!.stockId).toBe('auto-1')
    expect(g.find((x) => x.id === 'p3')!.stockId).not.toBe('auto-1')

    // Membership sticks through a subsequent addFixedStock (not clobbered).
    const fixed: FixedStockItem = {
      id: 'fix-1', name: 'Block', width: 200, height: 200, depth: 50,
      position: { x: -100, y: -100, z: -10 }, // would contain p1/p2 if unlocked
    }
    useCamStore.getState().addFixedStock(fixed)
    const after = useCamStore.getState().project.geometry
    expect(after.find((x) => x.id === 'p1')!.stockId).toBe('auto-1')
    expect(after.find((x) => x.id === 'p2')!.stockId).toBe('auto-1')
    // The auto stock still exists and keeps its member-derived bounds.
    const auto2 = (useCamStore.getState().project.stocks ?? []).find((s) => s.id === 'auto-1')!
    expect(auto2.bounds.max).toEqual({ x: 87, y: 27, z: 11 })
  })

  it('null unassigns: clears the lock + stockId so containment re-sorts the part', () => {
    useCamStore.getState().newProject()
    useCamStore.getState().addAutoStock(autoItem({ id: 'auto-1' }))
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [makeMeshGeo({ id: 'p1' })] },
    }))
    useCamStore.getState().setGeometryAutoStock('p1', 'auto-1')
    expect(useCamStore.getState().project.geometry[0].stockIdLocked).toBe(true)
    useCamStore.getState().setGeometryAutoStock('p1', null)
    const p1 = useCamStore.getState().project.geometry.find((g) => g.id === 'p1')!
    expect(p1.stockIdLocked).toBe(false)
    // Re-sorted by containment to the catch-all (no explicit stock contains it).
    expect(p1.stockId).toBe(DSID)
  })

  it('fail-loud (ADR-0003): a non-existent auto stock id throws', () => {
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [makeMeshGeo({ id: 'p1' })] },
    }))
    expect(() => useCamStore.getState().setGeometryAutoStock('p1', 'ghost')).toThrow(/no AUTO stock/)
  })
})

describe('newProject derived-stock path', () => {
  it('newProject() yields project.stocks containing the derived stock', () => {
    useCamStore.getState().newProject()
    const stocks = useCamStore.getState().project.stocks ?? []
    expect(stocks.some((s) => s.id === DERIVED_STOCK_ID)).toBe(true)
    // Empty fresh project: geometry and setups stay empty.
    expect(useCamStore.getState().project.geometry).toEqual([])
    expect(useCamStore.getState().project.setups).toEqual([])
  })

  it('addGeometry on a fresh project assigns stockId === DERIVED_STOCK_ID', () => {
    // Reset to a brand-new project (proves the new-project path, not a loaded one).
    useCamStore.getState().newProject()
    useCamStore.getState().addGeometry(makeMeshGeo({ id: 'fresh-geo', stockId: undefined }))
    const geo = useCamStore.getState().project.geometry.find((g) => g.id === 'fresh-geo')!
    // The guard did NOT skip (stocks non-empty) -> auto-assign ran and the part,
    // contained by no explicit stock, falls to the lone derived stock.
    expect(geo.stockId).toBe(DERIVED_STOCK_ID)
  })
})
