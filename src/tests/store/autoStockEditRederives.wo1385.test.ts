// WO-1385: updateAutoStock, setStockMembership and removeAutoStock changed
// stocks/geometry but never called applyAutoStockToSetups (the pairing every
// other stock-changing path uses — see autoStock.test.ts and
// stockMembership.test.ts). A setup whose origin is bound to the stock corner
// kept its OLD origin after these three edits, and its ready operations never
// went stale, so a downstream toolpath was cut relative to a work zero that no
// longer matched the (now-repadded / re-membered) stock.
//
// These tests fail on main before the fix: origin stays put and the ready op
// stays 'ready' after each of the three edits.

import { describe, it, expect } from 'vitest'
import { useCamStore } from '../../store'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import type {
  ImportedGeometry, SceneStock, PhysicalStock, Setup, Operation,
  HeightParams, PassParams, LinkingParams, WCS, Project, Loop2D,
} from '../../types'

// -- Shared fixtures ------------------------------------------------------------

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

// 10x10 2D square used for the setStockMembership fixture (mirrors
// stockMembership.test.ts's harness).
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

function derivedStock(id: string, name = 'Stock'): PhysicalStock {
  return {
    id, name, mode: 'derived',
    bounds: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
      size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
  }
}

function makeHeights(): HeightParams {
  return {
    clearanceHeight: 30, clearanceHeightMode: 'absolute',
    retractHeight: 20, feedHeight: 15,
    topHeight: 0, topHeightMode: 'stock_top',
    bottomHeight: -3, bottomHeightMode: 'absolute',
  }
}

const passes: PassParams = {
  stepdown: 2, stepover: 1.6, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 10,
  leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
}

// A READY op that does not reference the moved geometry, so any 'outdated'
// flip comes from the WCS re-derivation alone (outdateOps).
function makeReadyOp(): Operation {
  return {
    id: 'op-1', name: 'Op', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    heights: makeHeights(), passes, linking,
    params: { geometryId: 'geo-unrelated', loopIds: [] },
    toolpathMoves: [],
  }
}

// Corner-bound WCS: legacy (non-originBinding) cornerRow/cornerCol/cornerFace +
// stockId, exactly what wcsStockCornerBinding/wcsBoundStockId read as a
// stock-corner binding to the named stock.
function makeCornerWcs(origin: { x: number; y: number; z: number }, stockId: string): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin, stockId,
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    cornerRow: 2, cornerCol: 0, cornerFace: 'top',   // front-left, top face
  }
}

function makeSetup(wcs: WCS, operations: Operation[]): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', wcs,
    stock: {
      type: 'rectangular',
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    } as Setup['stock'],
    operations,
    notes: '',
  }
}

function installProject(over: Partial<Project>): void {
  useCamStore.setState((s) => ({
    project: { ...s.project, setups: [], ...over },
  }))
}

const state = () => useCamStore.getState()
const wcsAfter = () => state().project.setups[0].wcs
const opAfter = () => state().project.setups[0].operations[0]

// =============================================================================
// 1. updateAutoStock: a padding edit must move the corner-bound origin and
//    outdate the ready op the same way updateSceneStock already does.
// =============================================================================

describe('WO-1385: updateAutoStock re-derives corner-bound setups', () => {
  it('raising autoOffsetZTop on the named auto stock moves the origin and outdates the ready op', () => {
    const sceneStock: SceneStock = {
      mode: 'auto',
      autoOffsetXY: 2, autoOffsetZTop: 1,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
      fixedStocks: [],
      autoStocks: [{ id: 'auto-1', name: 'Auto 1', autoOffsetXY: 2, autoOffsetZTop: 1 }],
    }
    installProject({
      geometry: [makeMeshGeo({ stockId: 'auto-1', stockIdLocked: true })],
      stocks: [derivedStock('auto-1', 'Auto 1')],
      sceneStock,
      setups: [makeSetup(makeCornerWcs({ x: -27, y: -27, z: 11 }, 'auto-1'), [makeReadyOp()])],
    })

    state().updateAutoStock('auto-1', { autoOffsetZTop: 8 })

    // Box top moves from 10+1=11 to 10+8=18; XY corner unaffected.
    expect(wcsAfter().origin).toEqual({ x: -27, y: -27, z: 18 })
    expect(opAfter().status).toBe('outdated')
    expect(opAfter().toolpathMoves).toBeUndefined()
  })
})

// =============================================================================
// 2. setStockMembership: removing the member that set a derived stock's bounds
//    must shrink the box the corner-bound setup follows, same as any other
//    stock-changing path.
// =============================================================================

describe('WO-1385: setStockMembership re-derives corner-bound setups', () => {
  it('re-pinning the member that set the bounds away shrinks stock-A and moves its bound origin', () => {
    const sceneStock: SceneStock = {
      mode: 'auto',
      autoOffsetXY: 2, autoOffsetZTop: 1,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
      fixedStocks: [],
    }
    // stock-A currently wraps geo-1 (0..10) AND anchorA (50..60): box
    // (-2,-2,0)..(62,12,1). stock-B has an unrelated seed member so it survives
    // the pipeline untouched.
    const geo1 = make2DGeo({ id: 'geo-1', stockId: 'stock-A', stockIdLocked: true,
      position: { x: 0, y: 0, z: 0 } })
    const anchorA = make2DGeo({ id: 'geo-anchorA', stockId: 'stock-A', stockIdLocked: true,
      position: { x: 50, y: 0, z: 0 } })
    const seedB = make2DGeo({ id: 'geo-seedB', stockId: 'stock-B', stockIdLocked: true,
      position: { x: 300, y: 300, z: 0 } })
    installProject({
      geometry: [geo1, anchorA, seedB],
      stocks: [derivedStock('stock-A', 'A'), derivedStock('stock-B', 'B')],
      sceneStock,
      setups: [makeSetup(makeCornerWcs({ x: -2, y: -2, z: 1 }, 'stock-A'), [makeReadyOp()])],
    })

    state().setStockMembership('geo-1', 'stock-B')

    // stock-A now wraps only anchorA (50..60,0..10): box (48,-2,0)..(62,12,1).
    // Front-left-top corner -> x moves from -2 to 48; y/z unchanged.
    expect(wcsAfter().origin.x).toBeCloseTo(48, 9)
    expect(wcsAfter().origin.y).toBeCloseTo(-2, 9)
    expect(wcsAfter().origin.z).toBeCloseTo(1, 9)
    expect(opAfter().status).toBe('outdated')
    expect(opAfter().toolpathMoves).toBeUndefined()
  })
})

// =============================================================================
// 3. removeAutoStock: repointSetupsAfterStockRemoval only fixes the dangling
//    wcs.stockId reference; the origin must still follow to wherever it was
//    re-pointed (here, the surviving catch-all).
// =============================================================================

describe('WO-1385: removeAutoStock re-derives the re-pointed setup origin', () => {
  it('deleting the bound auto stock re-points to the catch-all AND re-derives the origin from it', () => {
    // Named auto stock 'auto-1' pads tighter (XY 2 / ZTop 1) than the global
    // sceneStock offsets (XY 5 / ZTop 3) it falls back to once removed — so the
    // re-pointed box is numerically distinguishable from the deleted stock's,
    // not just coincidentally identical.
    const sceneStock: SceneStock = {
      mode: 'auto',
      autoOffsetXY: 5, autoOffsetZTop: 3,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
      fixedStocks: [],
      autoStocks: [{ id: 'auto-1', name: 'Auto 1', autoOffsetXY: 2, autoOffsetZTop: 1 }],
    }
    installProject({
      geometry: [makeMeshGeo({ stockId: 'auto-1', stockIdLocked: true })],
      stocks: [derivedStock('auto-1', 'Auto 1'), derivedStock(DERIVED_STOCK_ID, 'Stock')],
      sceneStock,
      setups: [makeSetup(makeCornerWcs({ x: -27, y: -27, z: 11 }, 'auto-1'), [makeReadyOp()])],
    })

    state().removeAutoStock('auto-1')

    // The removed stock's member (geo-1) is cleared and falls back to the
    // catch-all via assignStocks; the setup's dangling wcs.stockId is
    // re-pointed to the catch-all (repointSetupsAfterStockRemoval) and its
    // origin must now be re-derived from THAT stock's new box (global 5/3
    // padding: (-30,-30,0)..(30,30,13)), not left at the old auto-1 corner.
    expect(state().project.setups[0].wcs.stockId).toBe(DERIVED_STOCK_ID)
    expect(wcsAfter().origin).toEqual({ x: -30, y: -30, z: 13 })
    expect(opAfter().status).toBe('outdated')
  })
})
