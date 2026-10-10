// WO-1422: typing a fixed stock's position (updateFixedStock) must be the SAME
// rigid-fixture move as dragging it (moveFixedStockLive) - member geometry AND
// any stock_corner-bound WCS ride by the same delta either way. Before this fix,
// updateFixedStock only re-sorted membership by containment (assignStocks) and
// never called translateStockMembers, so a typed move silently left the part
// behind while the stock (and any bound WCS) moved out from under it.
//
// Driven through the real store (useCamStore), mirroring the fixture shapes in
// explicitStockMove.test.ts (the moveFixedStockLive Q1 safety-gate file).

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type {
  ImportedGeometry, FixedStockItem, SceneStock, Setup, WCS,
  PhysicalStock, BoundingBox, Vec3, Project,
} from '../../types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

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

/** A fresh project: one member on stock-1, a stock_corner WCS bound to stock-1's
 *  front-left-top corner (same shape explicitStockMove.test.ts uses for the Q1
 *  gate), so both the member-ride and the WCS-ride assertions apply. */
function installFixture(): void {
  const member = makeMemberGeo({ position: { x: 10, y: 10, z: 0 } })
  const fixed = fixedStockItem({ position: { x: 0, y: 0, z: 0 } })
  const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
  const wcs = makeWcs({
    stockId: 'stock-1', cornerRow: 2, cornerCol: 0, cornerFace: 'top',
    origin: expectedCorner({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }, 2, 0, 'top'),
  })
  installProject({
    geometry: [member], stocks: [explicit],
    setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed]),
  })
}

function captureRelevantState() {
  return {
    memberPosition: geo('geo-member').position,
    memberStockId: geo('geo-member').stockId,
    physStockPosition: physStock('stock-1').position,
    fixedStockPosition: fixedStock('stock-1').position,
    wcsOrigin: setupWcsOrigin(),
  }
}

beforeEach(() => {
  installFixture()
})

// =============================================================================
// 1. A typed position move and a dragged position move to the SAME coordinates
//    must leave the member, twin, and bound WCS in the IDENTICAL place.
// =============================================================================

describe('WO-1422: updateFixedStock position edit matches moveFixedStockLive', () => {
  it('typed move rides the member geometry byte-identically to a dragged move', () => {
    const target: Vec3 = { x: 37, y: -19, z: 4 }

    useCamStore.getState().updateFixedStock('stock-1', { position: target })
    const typed = captureRelevantState()

    // Reset to the identical starting fixture and perform the equivalent drag.
    installFixture()
    useCamStore.getState().moveFixedStockLive('stock-1', target)
    const dragged = captureRelevantState()

    expect(typed).toEqual(dragged)
    // And the member actually rode - it did not just stay "contained" by luck.
    expect(typed.memberPosition).toEqual({ x: 10 + 37, y: 10 + -19, z: 0 + 4 })
    expect(typed.memberStockId).toBe('stock-1')
  })

  it('a member that would fall OUTSIDE the stock box on a naive re-sort still rides with it', () => {
    // Move the stock far enough that, without a rigid ride, containment re-sort
    // would drop the member (it would land far outside the moved box).
    const target: Vec3 = { x: 500, y: 500, z: 0 }

    useCamStore.getState().updateFixedStock('stock-1', { position: target })
    const typed = captureRelevantState()

    installFixture()
    useCamStore.getState().moveFixedStockLive('stock-1', target)
    const dragged = captureRelevantState()

    expect(typed).toEqual(dragged)
    expect(typed.memberPosition).toEqual({ x: 510, y: 510, z: 0 })
    expect(typed.memberStockId).toBe('stock-1')
  })
})

// =============================================================================
// 2. A pure resize/depth/name edit (no position field) stays a no-op for
//    members - unchanged from today.
// =============================================================================

describe('WO-1422: updateFixedStock non-position edits stay a member no-op', () => {
  it('a depth-only edit leaves the member position untouched', () => {
    const before = captureRelevantState()

    useCamStore.getState().updateFixedStock('stock-1', { depth: 25 })

    const after = captureRelevantState()
    expect(after.memberPosition).toEqual(before.memberPosition)
    expect(fixedStock('stock-1').depth).toBe(25)
  })

  it('a name-only edit leaves the member position untouched', () => {
    const before = captureRelevantState()

    useCamStore.getState().updateFixedStock('stock-1', { name: 'Renamed' })

    const after = captureRelevantState()
    expect(after.memberPosition).toEqual(before.memberPosition)
    expect(fixedStock('stock-1').name).toBe('Renamed')
  })

  it('a resize (width/height) edit with no position change leaves the member untouched', () => {
    const before = captureRelevantState()

    useCamStore.getState().updateFixedStock('stock-1', { width: 150, height: 150 })

    const after = captureRelevantState()
    expect(after.memberPosition).toEqual(before.memberPosition)
  })
})
