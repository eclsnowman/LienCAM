// Coordinate hierarchy Phase 4 (Items 2 + 4): EXPLICIT-STOCK MOVE = RIGID FIXTURE.
//
// Moving an explicit stock must behave like re-clamping a physical fixture: the
// stock, its explicit PhysicalStock twin, its MEMBER geometry, AND any
// stock_corner WCS bound to it all translate by the SAME delta, in ONE store
// mutation. The cut location RELATIVE TO THE WORK OFFSET (the value that drives
// eventual GCode) must be UNCHANGED - only where the whole fixture sits on the
// machine bed changes. This is Operator's binding Q1 condition (Option 1:
// machine-absolute coords + delta propagation must NOT change output).
//
// This file is the Q1 SAFETY GATE. The OUTPUT-INVARIANCE test (the first
// describe block) is BINDING: if it fails, Option 1 does not hold for that case
// and must escalate to Option 2 (stored relative offsets).
//
// Driven through the REAL store (useCamStore) exactly as the gizmo does.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { resolveTopZ } from '../../store/dispatchGeo'
import type {
  ImportedGeometry, FixedStockItem, SceneStock, Setup, WCS,
  PhysicalStock, BoundingBox, Vec3, Project,
} from '../../types'
import type { ChamferHeightReference } from '../../lib/cam/types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** A 2D member part. World Z extent is flat at position.z (loops are 2D). */
function makeMemberGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-member', name: 'Member', filename: 'm.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 30, y: 30, z: 0 }),
    position: { x: 10, y: 10, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    stockId: 'stock-1',
    loops: [{
      id: 'loop-1',
      points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }],
      closed: true, type: 'contour', layerId: 'L1', area: 900,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    ...over,
  } as ImportedGeometry
}

function explicitStock(id: string, name: string, min: Vec3, max: Vec3): PhysicalStock {
  return {
    id, name, mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z }),
    position: { ...min },
  }
}

function fixedStockItem(over: Partial<FixedStockItem> = {}): FixedStockItem {
  return {
    id: 'stock-1', name: 'Stock', width: 100, height: 100, depth: 12,
    position: { x: 0, y: 0, z: 0 },
    ...over,
  }
}

function makeFixedSceneStock(stocks: FixedStockItem[], over: Partial<SceneStock> = {}): SceneStock {
  return {
    mode: 'fixed',
    autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: stocks,
    ...over,
  }
}

/** Mirrors cornerOriginFromBox / SetupModal.cornerToWorld. */
function expectedCorner(
  min: Vec3, max: Vec3, row: number, col: number, face: 'top' | 'bottom',
): Vec3 {
  const xF = col / 2
  const yF = 1 - row / 2
  return {
    x: min.x + xF * (max.x - min.x),
    y: min.y + yF * (max.y - min.y),
    z: face === 'top' ? max.z : min.z,
  }
}

function makeWcs(over: Partial<WCS> = {}): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    ...over,
  }
}

function makeSetup(wcs: WCS): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs,
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    } as Setup['stock'],
    operations: [], notes: '',
  }
}

function installProject(over: Partial<Project>): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [],
      setups: [],
      stocks: [],
      activeSetupId: 'setup-1',
      activeOperationId: null,
      ...over,
    },
  }))
}

function state() { return useCamStore.getState().project }
function geo(id: string): ImportedGeometry {
  const g = state().geometry.find((x) => x.id === id)
  if (!g) throw new Error(`geo ${id} not found`)
  return g
}
function physStock(id: string): PhysicalStock {
  const p = (state().stocks ?? []).find((x) => x.id === id)
  if (!p) throw new Error(`stock ${id} not found`)
  return p
}
function fixedStock(id: string): FixedStockItem {
  const f = (state().sceneStock.fixedStocks ?? []).find((x) => x.id === id)
  if (!f) throw new Error(`fixed ${id} not found`)
  return f
}
function setupWcsOrigin(): Vec3 { return state().setups[0].wcs.origin }

/** The cut location RELATIVE TO THE WORK OFFSET, as it would drive GCode:
 *  - Z = resolveTopZ('stock_top') (already WCS-relative; subtracts wcs.origin.z).
 *  - X/Y = member world position minus the WCS origin (the work-offset frame).
 *  Captured the same way before and after the move. */
function wcsRelativeCutLocation(): { x: number; y: number; z: number } {
  const p = state()
  const setup = p.setups[0]
  const memberPos = geo('geo-member').position
  const wcs = setup.wcs.origin
  const ref: ChamferHeightReference = 'stock_top'
  const z = resolveTopZ(ref, 0, setup, p.sceneStock, p.geometry, 'geo-member', p.stocks)
  return {
    x: memberPos.x - wcs.x,
    y: memberPos.y - wcs.y,
    z, // already WCS-relative
  }
}

beforeEach(() => {
  installProject({})
})

// =============================================================================
// 1. OUTPUT-INVARIANCE (the Q1 safety gate, BINDING)
// =============================================================================

describe('Q1 SAFETY GATE: output-invariance under explicit-stock move', () => {
  it('WCS-relative cut location is BYTE-IDENTICAL before and after the move', () => {
    const member = makeMemberGeo({ position: { x: 10, y: 10, z: 0 } })
    const fixed = fixedStockItem({ position: { x: 0, y: 0, z: 0 } })
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    // stock_corner WCS: front-left-top corner of the stock.
    const wcs = makeWcs({
      stockId: 'stock-1', cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      origin: expectedCorner({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }, 2, 0, 'top'),
    })
    installProject({
      geometry: [member], stocks: [explicit],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed]),
    })

    const before = wcsRelativeCutLocation()

    // Re-clamp the fixture to a new bed position (X, Y AND Z all change).
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 37, y: -19, z: 4 })

    const after = wcsRelativeCutLocation()

    // BYTE-IDENTICAL: Option 1 cannot change output. (toEqual = exact, not close.)
    expect(after).toEqual(before)
    // And the captured value is the expected one (the member sits at +10,+10 from
    // the front-left corner; stock_top is the box top = WCS z, so relative z = 0).
    expect(before).toEqual({ x: 10, y: 10, z: 0 })
  })

  it('output-invariance holds with a non-zero stock_top offset plane', () => {
    const member = makeMemberGeo({ position: { x: 25, y: 5, z: 0 } })
    const fixed = fixedStockItem()
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const wcs = makeWcs({
      stockId: 'stock-1', cornerRow: 0, cornerCol: 2, cornerFace: 'top',
      origin: expectedCorner({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }, 0, 2, 'top'),
    })
    installProject({
      geometry: [member], stocks: [explicit],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed]),
    })
    const p0 = state()
    const zBefore = resolveTopZ('stock_top', -2, p0.setups[0], p0.sceneStock, p0.geometry, 'geo-member', p0.stocks)

    useCamStore.getState().moveFixedStockLive('stock-1', { x: -50, y: 80, z: -3 })

    const p1 = state()
    const zAfter = resolveTopZ('stock_top', -2, p1.setups[0], p1.sceneStock, p1.geometry, 'geo-member', p1.stocks)
    expect(zAfter).toEqual(zBefore)
  })
})

// =============================================================================
// 2. RIDE happened: stock + twin + members shift; non-member does not.
// =============================================================================

describe('explicit-stock move: rigid ride', () => {
  it('member ABSOLUTE position shifts by exactly the delta; twin + legacy shift; non-member static', () => {
    const member = makeMemberGeo({ id: 'geo-member', stockId: 'stock-1', position: { x: 10, y: 10, z: 2 } })
    // A non-member on a different, locked stock - must NOT move.
    const nonMember = makeMemberGeo({
      id: 'geo-other', stockId: 'stock-2', stockIdLocked: true, position: { x: 210, y: 10, z: 0 },
    })
    const fixed1 = fixedStockItem({ id: 'stock-1', position: { x: 0, y: 0, z: 0 } })
    const fixed2 = fixedStockItem({ id: 'stock-2', position: { x: 200, y: 0, z: 0 } })
    const explicit1 = explicitStock('stock-1', 'S1', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const explicit2 = explicitStock('stock-2', 'S2', { x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 12 })
    installProject({
      geometry: [member, nonMember], stocks: [explicit1, explicit2],
      setups: [makeSetup(makeWcs())], sceneStock: makeFixedSceneStock([fixed1, fixed2]),
    })

    const delta = { x: 15, y: -8, z: 3 }
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 15, y: -8, z: 3 })

    // Member rode by exactly the delta (rotation unchanged).
    expect(geo('geo-member').position).toEqual({ x: 10 + delta.x, y: 10 + delta.y, z: 2 + delta.z })
    expect(geo('geo-member').rotation).toEqual({ x: 0, y: 0, z: 0 })
    // Member is still owned by stock-1 (containment preserved by the rigid ride).
    expect(geo('geo-member').stockId).toBe('stock-1')
    // Explicit PhysicalStock twin moved with it.
    expect(physStock('stock-1').position).toEqual({ x: 15, y: -8, z: 3 })
    // Legacy fixed stock moved.
    expect(fixedStock('stock-1').position).toEqual({ x: 15, y: -8, z: 3 })
    // Non-member untouched (position + ownership).
    expect(geo('geo-other').position).toEqual({ x: 210, y: 10, z: 0 })
    expect(geo('geo-other').stockId).toBe('stock-2')
    // The other stock did not move.
    expect(physStock('stock-2').position).toEqual({ x: 200, y: 0, z: 0 })
  })
})

// =============================================================================
// 3. WCS trigger matrix (Item 4): stock_corner rides; part_feature/manual do not.
// =============================================================================

describe('explicit-stock move: WCS trigger matrix', () => {
  it('stock_corner WCS re-zeros by the delta', () => {
    const fixed = fixedStockItem()
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const wcs = makeWcs({
      stockId: 'stock-1', cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      origin: expectedCorner({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }, 2, 0, 'top'),
    })
    installProject({
      geometry: [], stocks: [explicit],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed]),
    })
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 12, y: 7, z: 3 })
    const want = expectedCorner({ x: 12, y: 7, z: 3 }, { x: 112, y: 107, z: 15 }, 2, 0, 'top')
    expect(setupWcsOrigin()).toEqual(want)
  })

  it('manual WCS does NOT move on a stock move', () => {
    const fixed = fixedStockItem()
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const wcs = makeWcs({ origin: { x: 3, y: 4, z: 5 } })  // no corner, no snap
    installProject({
      geometry: [], stocks: [explicit],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed]),
    })
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 50, y: 50, z: 50 })
    expect(setupWcsOrigin()).toEqual({ x: 3, y: 4, z: 5 })
  })

  it('part_feature WCS on a NON-member does NOT move on the stock move', () => {
    const member = makeMemberGeo({ id: 'geo-member', stockId: 'stock-1', position: { x: 10, y: 10, z: 0 } })
    const other = makeMemberGeo({
      id: 'geo-other', stockId: 'stock-2', stockIdLocked: true, position: { x: 210, y: 10, z: 0 },
    })
    const fixed1 = fixedStockItem({ id: 'stock-1' })
    const fixed2 = fixedStockItem({ id: 'stock-2', position: { x: 200, y: 0, z: 0 } })
    const explicit1 = explicitStock('stock-1', 'S1', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const explicit2 = explicitStock('stock-2', 'S2', { x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 12 })
    const wcs = makeWcs({
      snapGeoId: 'geo-other', snapLocalPt: { x: 5, y: 7, z: 0 }, origin: { x: 215, y: 17, z: 0 },
    })
    installProject({
      geometry: [member, other], stocks: [explicit1, explicit2],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed1, fixed2]),
    })
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 50, y: 50, z: 50 })
    expect(setupWcsOrigin()).toEqual({ x: 215, y: 17, z: 0 })  // bound to a non-member
  })
})

// =============================================================================
// 4. FAIL LOUD (ADR-0003): moving an unknown stock id throws.
// =============================================================================

describe('explicit-stock move: fail-loud', () => {
  it('throws when the stock id has no fixed stock', () => {
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    installProject({
      geometry: [], stocks: [explicit],
      setups: [makeSetup(makeWcs())], sceneStock: makeFixedSceneStock([fixedStockItem()]),
    })
    expect(() =>
      useCamStore.getState().moveFixedStockLive('does-not-exist', { x: 1, y: 2, z: 3 }),
    ).toThrow(/no fixed stock with id/)
  })
})

// =============================================================================
// 5. ATOMIC: one mutation moves stock + twin + members + WCS together.
//    moveFixedStockLive is a SINGLE set() with no history push (live drag); the
//    enclosing gizmo gesture pushes ONE history entry on enter (DesignTree
//    pushHistory before enterStockGizmoMode), so undo reverts the whole gesture.
//    Here we assert the single-mutation shape: a SECOND move from the new
//    position re-derives its delta from the (already-moved) state, i.e. there is
//    no half-applied intermediate - each call lands one consistent frame.
// =============================================================================

describe('explicit-stock move: atomic single-frame mutation', () => {
  it('a second consecutive move composes correctly (no stale-delta drift)', () => {
    const member = makeMemberGeo({ id: 'geo-member', stockId: 'stock-1', position: { x: 10, y: 10, z: 0 } })
    const fixed = fixedStockItem()
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    installProject({
      geometry: [member], stocks: [explicit],
      setups: [makeSetup(makeWcs())], sceneStock: makeFixedSceneStock([fixed]),
    })
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 20, y: 0, z: 0 })
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 35, y: 5, z: 0 })
    // Member absolute = original (10,10,0) + total delta (35,5,0) = (45,15,0).
    expect(geo('geo-member').position).toEqual({ x: 45, y: 15, z: 0 })
    expect(physStock('stock-1').position).toEqual({ x: 35, y: 5, z: 0 })
    expect(fixedStock('stock-1').position).toEqual({ x: 35, y: 5, z: 0 })
  })
})
