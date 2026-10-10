// MACHINE-SAFETY regression: applyAutoStockToSetups must be STOCK-ID-AWARE.
//
// DEFECT (clobber): with the AUTO/FIXED toggle gone, sceneStock.mode is stuck
// 'auto', so deriveAutoStockBounds(geometry, sceneStock) no longer returns null
// and applyAutoStockToSetups now runs on every geometry add/move/remove. The
// pre-fix applier re-derived EVERY corner-pinned, non-snapped WCS from the
// whole-scene union WITHOUT checking wcs.stockId — clobbering the origin of a
// setup pinned to a FIXED stock onto the auto-box corner. WCS origins drive real
// cuts, so this is machine-safety-critical.
//
// THE CONTRACT (what these tests lock):
//   1. A WCS bound to a FIXED (explicit) stock does NOT move when geometry is
//      added / moved / removed (the clobber regression). FAILS pre-fix.
//   2. A WCS bound to a NAMED AUTO (derived) stock re-derives from THAT stock's
//      OWN member bounds, not the whole-scene union, when its members change.
//   3. An UNBOUND corner WCS still re-derives from the whole-scene union
//      (unchanged behavior).
//
// Driven through the REAL store (useCamStore), mutated via store actions exactly
// as the UI would, mirroring src/tests/store/wcsRederivation.test.ts.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { deriveAutoStockBounds } from '../../store/dispatchGeo'
import type {
  ImportedGeometry, SceneStock, Setup, WCS,
  PhysicalStock, BoundingBox, Vec3, Project, AutoStockItem,
} from '../../types'

// -- Fixtures (shared shapes with wcsRederivation.test.ts) ---------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** 2D part with a square footprint; XY-movable, flat in Z at position.z. */
function makeCurvesGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-1', name: 'Part', filename: 'part.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [{
      id: 'loop-1',
      points: [{ x: 0, y: 0 }, { x: 50, y: 0 }, { x: 50, y: 50 }, { x: 0, y: 50 }],
      closed: true, type: 'contour', layerId: 'L1', area: 2500,
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

function derivedStock(id: string, name = 'Stock'): PhysicalStock {
  return {
    id, name, mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
  }
}

function makeAutoSceneStock(over: Partial<SceneStock> = {}): SceneStock {
  return {
    mode: 'auto',
    autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [],
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

function currentOrigin(): Vec3 {
  return useCamStore.getState().project.setups[0].wcs.origin
}

beforeEach(() => {
  installProject({})
})

// =============================================================================
// TEST 1: a setup pinned to a FIXED stock does NOT move on geometry churn.
// (The clobber regression — FAILS pre-fix, PASSES post-fix.)
// =============================================================================

describe('clobber guard: WCS bound to a FIXED stock survives geometry churn (mode auto)', () => {
  it('adding geometry does NOT move a fixed-bound corner WCS', () => {
    // sceneStock.mode is 'auto' (the stuck-mode reality). The setup is corner-
    // pinned to an EXPLICIT (fixed) stock that lives in project.stocks.
    const fixed = explicitStock('fixed-1', 'Vise', { x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 12 })
    const wcs = makeWcs({
      stockId: 'fixed-1', cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      origin: expectedCorner({ x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 12 }, 2, 0, 'top'),
    })
    installProject({
      geometry: [], stocks: [fixed],
      setups: [makeSetup(wcs)], sceneStock: makeAutoSceneStock(),
    })
    const before = currentOrigin()
    // Add a part FAR from the fixed stock — its world bounds dominate the union.
    useCamStore.getState().addGeometry(
      makeCurvesGeo({ id: 'geo-new', position: { x: 0, y: 0, z: 0 } }),
    )
    // Pre-fix: re-derived from the union (origin jumps onto the auto box).
    // Post-fix: fixed-bound -> skipped, origin unchanged.
    expect(currentOrigin()).toEqual(before)
  })

  it('moving geometry does NOT move a fixed-bound corner WCS', () => {
    const fixed = explicitStock('fixed-1', 'Vise', { x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 12 })
    const geo = makeCurvesGeo({ id: 'geo-1', position: { x: 0, y: 0, z: 0 } })
    const wcs = makeWcs({
      stockId: 'fixed-1', cornerRow: 0, cornerCol: 2, cornerFace: 'top',
      origin: expectedCorner({ x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 12 }, 0, 2, 'top'),
    })
    installProject({
      geometry: [geo], stocks: [fixed],
      setups: [makeSetup(wcs)], sceneStock: makeAutoSceneStock(),
    })
    const before = currentOrigin()
    useCamStore.getState().updateGeometryTransform('geo-1', { x: 60, y: 70, z: 5 }, { x: 0, y: 0, z: 0 })
    expect(currentOrigin()).toEqual(before)
  })

  it('removing geometry does NOT move a fixed-bound corner WCS', () => {
    const fixed = explicitStock('fixed-1', 'Vise', { x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 12 })
    const geo = makeCurvesGeo({ id: 'geo-1', position: { x: 0, y: 0, z: 0 } })
    const wcs = makeWcs({
      stockId: 'fixed-1', cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      origin: expectedCorner({ x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 12 }, 2, 0, 'top'),
    })
    installProject({
      geometry: [geo], stocks: [fixed],
      setups: [makeSetup(wcs)], sceneStock: makeAutoSceneStock(),
    })
    const before = currentOrigin()
    useCamStore.getState().removeGeometry('geo-1')
    expect(currentOrigin()).toEqual(before)
  })
})

// =============================================================================
// TEST 2: a setup bound to a NAMED AUTO stock re-derives from THAT stock's
// bounds (not the global union) when that stock's members change.
// =============================================================================

describe('per-stock re-derive: WCS bound to a NAMED AUTO stock tracks ITS OWN members', () => {
  it('moving a member of the bound auto stock re-derives from that stock only', () => {
    // Two derived stocks. The WCS is bound to stock-A. A part on stock-B exists
    // far away — it is part of the whole-scene union but NOT of stock-A. After
    // moving stock-A's member, the WCS must land on stock-A's own member bounds,
    // which differ from the whole-scene union (proving it is NOT the union).
    const sceneStock = makeAutoSceneStock({
      autoStocks: [
        { id: 'auto-A', name: 'A', autoOffsetXY: 2, autoOffsetZTop: 1 } as AutoStockItem,
        { id: 'auto-B', name: 'B', autoOffsetXY: 2, autoOffsetZTop: 1 } as AutoStockItem,
      ],
    })
    const partA = makeCurvesGeo({ id: 'geo-A', stockId: 'auto-A', stockIdLocked: true, position: { x: 0, y: 0, z: 0 } })
    const partB = makeCurvesGeo({ id: 'geo-B', stockId: 'auto-B', stockIdLocked: true, position: { x: 500, y: 500, z: 0 } })

    // Bind the WCS to stock-A's BACK-RIGHT-top corner (row 0, col 2 = max X/max
    // Y). partB at (500,500) is on the +X/+Y side, so the whole-scene union's
    // max corner is FAR from stock-A's own max corner — a back-right pick makes
    // the union answer distinct from the per-stock answer.
    const offsets = { autoOffsetXY: 2, autoOffsetZTop: 1 }
    const boxA0 = deriveAutoStockBounds([partA], { mode: 'auto', ...offsets })!
    const wcs = makeWcs({
      stockId: 'auto-A', cornerRow: 0, cornerCol: 2, cornerFace: 'top',
      origin: expectedCorner(boxA0.min, boxA0.max, 0, 2, 'top'),
    })
    installProject({
      geometry: [partA, partB],
      stocks: [derivedStock('auto-A', 'A'), derivedStock('auto-B', 'B')],
      setups: [makeSetup(wcs)], sceneStock,
    })

    useCamStore.getState().updateGeometryTransform('geo-A', { x: 30, y: 40, z: 0 }, { x: 0, y: 0, z: 0 })

    // Expected: stock-A's OWN member bounds after the move (partA at 30,40).
    const movedA = makeCurvesGeo({ position: { x: 30, y: 40, z: 0 } })
    const boxA1 = deriveAutoStockBounds([movedA], { mode: 'auto', ...offsets })!
    const wantA = expectedCorner(boxA1.min, boxA1.max, 0, 2, 'top')

    // Whole-scene union would also include partB at (500,500) — a DIFFERENT,
    // wrong answer. Prove the result is stock-A's box, not the union.
    const union = deriveAutoStockBounds([movedA, partB], { mode: 'auto', ...offsets })!
    const wrongUnion = expectedCorner(union.min, union.max, 0, 2, 'top')

    expect(currentOrigin()).toEqual(wantA)
    expect(currentOrigin()).not.toEqual(wrongUnion)
  })
})

// =============================================================================
// TEST 3: an UNBOUND corner WCS still re-derives from the whole-scene union
// (unchanged behavior).
// =============================================================================

describe('unbound corner WCS: still re-derives from the whole-scene union', () => {
  it('adding geometry grows the union and the unbound WCS follows', () => {
    const sceneStock = makeAutoSceneStock()
    const geo = makeCurvesGeo({ id: 'geo-1', position: { x: 0, y: 0, z: 0 } })
    const box0 = deriveAutoStockBounds([geo], sceneStock)!
    // No stockId, no originBinding, no snap -> unbound corner WCS.
    const wcs = makeWcs({
      cornerRow: 0, cornerCol: 2, cornerFace: 'top',
      origin: expectedCorner(box0.min, box0.max, 0, 2, 'top'),
    })
    installProject({
      geometry: [geo], stocks: [derivedStock('stock-derived')],
      setups: [makeSetup(wcs)], sceneStock,
    })
    const before = currentOrigin()
    // Add a part that extends the union to the +X/+Y side.
    useCamStore.getState().addGeometry(
      makeCurvesGeo({ id: 'geo-2', position: { x: 100, y: 100, z: 0 } }),
    )
    const moved = makeCurvesGeo({ id: 'geo-2', position: { x: 100, y: 100, z: 0 } })
    const box1 = deriveAutoStockBounds([geo, moved], sceneStock)!
    const want = expectedCorner(box1.min, box1.max, 0, 2, 'top')
    expect(currentOrigin()).toEqual(want)
    expect(currentOrigin()).not.toEqual(before)  // it genuinely followed the union
  })
})
