// Coordinate hierarchy Phase 3: WCS re-derivation TRIGGER MATRIX (verify + lock).
//
// This file PROVES the conditional re-derivation model the plan locked, by
// driving the REAL store (useCamStore) through each mutation and asserting the
// WCS origin either re-derives to the expected new value OR stays unchanged.
//
// THE REQUESTED MODEL (what every cell below asserts):
//   - WCS bound to a STOCK CORNER re-derives ONLY when THAT stock moves/resizes.
//       * EXPLICIT stock: a PART move must NOT move the WCS.
//       * DERIVED/AUTO stock: a member-geometry move DOES move the WCS (the
//         derived stock's own corner genuinely moved) - asserted, correct.
//   - WCS bound to a PART FEATURE (vertex/snap) re-derives ONLY when THAT part
//     moves; a stock move/resize must NOT move it.
//   - MANUAL WCS (no corner, no snap) is never re-derived by any event.
//
// Matrix (event x binding):
//                       | corner-on-EXPLICIT | corner-on-DERIVED | part_feature | manual
//  explicit-stock move  |   re-derive        |   (n/a fixed)     |  unchanged   | unchanged
//  explicit-stock resize|   re-derive        |   (n/a fixed)     |  unchanged   | unchanged
//  member-part move(auto)|  (n/a auto)       |   re-derive       |  re-derive*  | unchanged
//  unrelated-part move  |   unchanged        |   unchanged**     |  unchanged   | unchanged
//   * part_feature re-derives on ITS OWN part move (snap mechanism), asserted.
//   **in auto mode an unrelated-part move grows the derived box, which IS that
//     stock moving - covered by the member-move cell; "unrelated" here means a
//     part NOT contributing to the bound stock (a different explicit stock).
//
// Plus the two named regressions:
//   B10: add a 3D part -> auto stock thickens -> corner-pinned WCS z follows.
//   B18: switch auto->fixed -> corner WCS jumps to the fixed-stock corner.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { deriveAutoStockBounds } from '../../store/dispatchGeo'
import type {
  ImportedGeometry, FixedStockItem, SceneStock, Setup, WCS,
  PhysicalStock, BoundingBox, Vec3, Project, ModelItemPlacementRecord,
} from '../../types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** 2D part: world bounds Z is flat at position.z (loops are 2D). Use for XY moves. */
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

/** 3D part: boundingBox has real Z extent, so moving position.z changes the
 *  derived auto box max.z (the B10 thickening case). */
function makeMeshGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-3d', name: 'Part3D', filename: 'part.stl', type: 'mesh', format: 'stl',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 40, z: 8 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ...over,
  } as ImportedGeometry
}

/** Modeled-body geo (WO-294 bore cell): format 'model' rows never move via
 *  updateGeometryTransform (isModelOriginGeometry refuses it) - their pose
 *  lives in project.modelItemPlacements instead. */
function makeModelGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-model', name: 'Bracket', filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 30, y: 30, z: 10 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    modelItemId: 'legacy',
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:wall'], version: 1 } },
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

function derivedStock(id = 'stock-derived'): PhysicalStock {
  return {
    id, name: 'Stock', mode: 'derived',
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

/** Mirrors cornerOriginFromBox / SetupModal.cornerToWorld: cornerRow 0-2
 *  back->front, cornerCol 0-2 left->right, on the top/bottom face of an AABB. */
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

/** Install a project into the real store and return nothing; mutations are then
 *  driven through the store actions exactly as the UI would. */
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
  // Reset to a clean, predictable project before each test.
  installProject({})
})

// =============================================================================
// ROW: EXPLICIT-STOCK MOVE  (updateFixedStock position / moveFixedStockLive)
// =============================================================================

describe('event: explicit-stock move', () => {
  it('corner-on-EXPLICIT: WCS re-derives to the moved stock corner', () => {
    const fixed = fixedStockItem({ position: { x: 0, y: 0, z: 0 } })
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    // front-left-top corner (row 2 = front, col 0 = left, top face).
    const wcs = makeWcs({
      stockId: 'stock-1', cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      origin: expectedCorner({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }, 2, 0, 'top'),
    })
    installProject({
      geometry: [], stocks: [explicit],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed]),
    })
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 10, y: 20, z: 5 })
    const want = expectedCorner({ x: 10, y: 20, z: 5 }, { x: 110, y: 120, z: 17 }, 2, 0, 'top')
    expect(currentOrigin()).toEqual(want)
  })

  it('part_feature (snap on a MEMBER): the WCS rides with its part (rigid fixture)', () => {
    // Phase 4 (Item 2) change: an explicit-stock move is now a RIGID FIXTURE move -
    // member geometry rides with the stock. A part_feature (snap) WCS is bound to a
    // FEATURE on that part, so when the part rides, the feature rides, and the WCS
    // rides with it by the same delta. This is the contract ("a part_feature WCS
    // rides when its part moves"): the part moved BECAUSE the fixture it sits in
    // moved. Output-invariance is PRESERVED by riding (part and WCS both shift by
    // the delta), and would be BROKEN by staying put.
    const geo = makeCurvesGeo({ stockId: 'stock-1', position: { x: 0, y: 0, z: 0 } })
    const fixed = fixedStockItem()
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const wcs = makeWcs({
      snapGeoId: 'geo-1', snapLocalPt: { x: 5, y: 7, z: 0 },
      origin: { x: 5, y: 7, z: 0 },
    })
    installProject({
      geometry: [geo], stocks: [explicit],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed]),
    })
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 99, y: 99, z: 99 })
    // delta (99,99,99) -> snap origin (5,7,0) + delta = (104,106,99).
    expect(currentOrigin()).toEqual({ x: 104, y: 106, z: 99 })
  })

  it('part_feature (snap on a NON-MEMBER): a stock move does NOT move the WCS', () => {
    // The snapped part belongs to a DIFFERENT stock (locked), so it does not ride
    // when stock-1 moves -> its part_feature WCS stays put.
    const memberOf1 = makeCurvesGeo({ id: 'geo-1', stockId: 'stock-1', position: { x: 0, y: 0, z: 0 } })
    const other = makeCurvesGeo({
      id: 'geo-2', stockId: 'stock-2', stockIdLocked: true, position: { x: 210, y: 10, z: 0 },
    })
    const fixed1 = fixedStockItem({ id: 'stock-1' })
    const fixed2 = fixedStockItem({ id: 'stock-2', position: { x: 200, y: 0, z: 0 } })
    const explicit1 = explicitStock('stock-1', 'S1', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const explicit2 = explicitStock('stock-2', 'S2', { x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 12 })
    const wcs = makeWcs({
      snapGeoId: 'geo-2', snapLocalPt: { x: 5, y: 7, z: 0 }, origin: { x: 215, y: 17, z: 0 },
    })
    installProject({
      geometry: [memberOf1, other], stocks: [explicit1, explicit2],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed1, fixed2]),
    })
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 99, y: 99, z: 99 })
    expect(currentOrigin()).toEqual({ x: 215, y: 17, z: 0 })  // bound to geo-2, not a member of stock-1
  })

  it('manual: a stock move does NOT move the WCS', () => {
    const fixed = fixedStockItem()
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const wcs = makeWcs({ origin: { x: 3, y: 4, z: 5 } })  // no corner, no snap
    installProject({
      geometry: [], stocks: [explicit],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed]),
    })
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 99, y: 99, z: 99 })
    expect(currentOrigin()).toEqual({ x: 3, y: 4, z: 5 })
  })
})

// =============================================================================
// ROW: EXPLICIT-STOCK RESIZE  (updateFixedStock width/height/depth)
// =============================================================================

describe('event: explicit-stock resize', () => {
  it('corner-on-EXPLICIT: WCS re-derives to the resized stock corner', () => {
    const fixed = fixedStockItem()
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    // back-right-top corner (row 0 = back, col 2 = right) tracks max.x/max.y.
    const wcs = makeWcs({
      stockId: 'stock-1', cornerRow: 0, cornerCol: 2, cornerFace: 'top',
      origin: expectedCorner({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }, 0, 2, 'top'),
    })
    installProject({
      geometry: [], stocks: [explicit],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed]),
    })
    useCamStore.getState().updateFixedStock('stock-1', { width: 80, height: 60, depth: 20 })
    const want = expectedCorner({ x: 0, y: 0, z: 0 }, { x: 80, y: 60, z: 20 }, 0, 2, 'top')
    expect(currentOrigin()).toEqual(want)
  })

  it('part_feature (snap): a stock resize does NOT move the WCS', () => {
    const geo = makeCurvesGeo({ stockId: 'stock-1' })
    const fixed = fixedStockItem()
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const wcs = makeWcs({
      snapGeoId: 'geo-1', snapLocalPt: { x: 5, y: 7, z: 0 }, origin: { x: 5, y: 7, z: 0 },
    })
    installProject({
      geometry: [geo], stocks: [explicit],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed]),
    })
    useCamStore.getState().updateFixedStock('stock-1', { width: 80, height: 60, depth: 20 })
    expect(currentOrigin()).toEqual({ x: 5, y: 7, z: 0 })
  })

  it('manual: a stock resize does NOT move the WCS', () => {
    const fixed = fixedStockItem()
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const wcs = makeWcs({ origin: { x: 3, y: 4, z: 5 } })
    installProject({
      geometry: [], stocks: [explicit],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed]),
    })
    useCamStore.getState().updateFixedStock('stock-1', { width: 80, height: 60, depth: 20 })
    expect(currentOrigin()).toEqual({ x: 3, y: 4, z: 5 })
  })
})

// =============================================================================
// ROW: DERIVED-STOCK MEMBER-PART MOVE  (auto mode, updateGeometryTransform)
// =============================================================================

describe('event: derived-stock member-part move (auto mode)', () => {
  it('corner-on-DERIVED: WCS re-derives because the derived stock corner genuinely moved', () => {
    const geo = makeCurvesGeo({ position: { x: 0, y: 0, z: 0 } })
    const sceneStock = makeAutoSceneStock()
    const box0 = deriveAutoStockBounds([geo], sceneStock)!
    const wcs = makeWcs({
      cornerRow: 2, cornerCol: 0, cornerFace: 'top',  // corner-pinned, no explicit stockId, no snap
      origin: expectedCorner(box0.min, box0.max, 2, 0, 'top'),
    })
    installProject({
      geometry: [geo], stocks: [derivedStock()],
      setups: [makeSetup(wcs)], sceneStock,
    })
    useCamStore.getState().updateGeometryTransform('geo-1', { x: 30, y: 40, z: 0 }, { x: 0, y: 0, z: 0 })
    const moved = makeCurvesGeo({ position: { x: 30, y: 40, z: 0 } })
    const box1 = deriveAutoStockBounds([moved], sceneStock)!
    const want = expectedCorner(box1.min, box1.max, 2, 0, 'top')
    expect(currentOrigin()).toEqual(want)
    expect(currentOrigin()).not.toEqual(wcs.origin)  // it genuinely moved
  })

  it('part_feature (snap): WCS re-derives on its OWN part move (snap mechanism)', () => {
    const geo = makeCurvesGeo({ position: { x: 0, y: 0, z: 0 } })
    const sceneStock = makeAutoSceneStock()
    const wcs = makeWcs({
      snapGeoId: 'geo-1', snapLocalPt: { x: 5, y: 7, z: 0 }, origin: { x: 5, y: 7, z: 0 },
    })
    installProject({
      geometry: [geo], stocks: [derivedStock()],
      setups: [makeSetup(wcs)], sceneStock,
    })
    useCamStore.getState().updateGeometryTransform('geo-1', { x: 30, y: 40, z: 2 }, { x: 0, y: 0, z: 0 })
    // No rotation -> origin = localPt + new position.
    expect(currentOrigin()).toEqual({ x: 35, y: 47, z: 2 })
  })

  it('manual: a member-part move does NOT move the WCS', () => {
    const geo = makeCurvesGeo({ position: { x: 0, y: 0, z: 0 } })
    const sceneStock = makeAutoSceneStock()
    const wcs = makeWcs({ origin: { x: 3, y: 4, z: 5 } })  // no corner, no snap
    installProject({
      geometry: [geo], stocks: [derivedStock()],
      setups: [makeSetup(wcs)], sceneStock,
    })
    useCamStore.getState().updateGeometryTransform('geo-1', { x: 30, y: 40, z: 0 }, { x: 0, y: 0, z: 0 })
    expect(currentOrigin()).toEqual({ x: 3, y: 4, z: 5 })
  })
})

// =============================================================================
// ROW: UNRELATED-PART MOVE  (a part on a DIFFERENT explicit stock, fixed mode)
// =============================================================================

describe('event: unrelated-part move (fixed mode, part not on the bound stock)', () => {
  it('corner-on-EXPLICIT: moving an UNRELATED part does NOT move the WCS', () => {
    // Two explicit stocks; WCS pinned to stock-1; move a part on stock-2.
    const fixed1 = fixedStockItem({ id: 'stock-1' })
    const fixed2 = fixedStockItem({ id: 'stock-2', position: { x: 200, y: 0, z: 0 } })
    const explicit1 = explicitStock('stock-1', 'S1', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const explicit2 = explicitStock('stock-2', 'S2', { x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 12 })
    const partOn2 = makeCurvesGeo({
      id: 'geo-2', stockId: 'stock-2', stockIdLocked: true, position: { x: 210, y: 10, z: 0 },
    })
    const wcs = makeWcs({
      stockId: 'stock-1', cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      origin: expectedCorner({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }, 2, 0, 'top'),
    })
    installProject({
      geometry: [partOn2], stocks: [explicit1, explicit2],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed1, fixed2]),
    })
    const before = currentOrigin()
    useCamStore.getState().updateGeometryTransform('geo-2', { x: 250, y: 50, z: 9 }, { x: 0, y: 0, z: 0 })
    // fixed mode -> applyAutoStockToSetups no-ops; not a snap -> snap applier skips.
    expect(currentOrigin()).toEqual(before)
  })

  it('part_feature (snap on stock-1 part): moving an UNRELATED part does NOT move the WCS', () => {
    const fixed1 = fixedStockItem({ id: 'stock-1' })
    const fixed2 = fixedStockItem({ id: 'stock-2', position: { x: 200, y: 0, z: 0 } })
    const explicit1 = explicitStock('stock-1', 'S1', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    const explicit2 = explicitStock('stock-2', 'S2', { x: 200, y: 0, z: 0 }, { x: 300, y: 100, z: 12 })
    const partA = makeCurvesGeo({ id: 'geo-A', stockId: 'stock-1', position: { x: 0, y: 0, z: 0 } })
    const partB = makeCurvesGeo({
      id: 'geo-B', stockId: 'stock-2', stockIdLocked: true, position: { x: 210, y: 10, z: 0 },
    })
    const wcs = makeWcs({
      snapGeoId: 'geo-A', snapLocalPt: { x: 5, y: 7, z: 0 }, origin: { x: 5, y: 7, z: 0 },
    })
    installProject({
      geometry: [partA, partB], stocks: [explicit1, explicit2],
      setups: [makeSetup(wcs)], sceneStock: makeFixedSceneStock([fixed1, fixed2]),
    })
    useCamStore.getState().updateGeometryTransform('geo-B', { x: 250, y: 50, z: 9 }, { x: 0, y: 0, z: 0 })
    expect(currentOrigin()).toEqual({ x: 5, y: 7, z: 0 })  // bound to geo-A, untouched
  })
})

// =============================================================================
// ROW: MODEL ITEM PLACEMENT MOVE (bore-bound origin, WO-294)
//
// A setup origin bound to a picked bore wall on a MODELED body is a
// part_feature binding (originBinding.featureRef.kind 'bore_center'), but its
// part's pose lives in project.modelItemPlacements, not geo.position/rotation
// (updateGeometryTransform refuses model-origin rows by construction). Its
// re-derivation trigger is therefore updateModelItemPlacement, not
// updateGeometryTransform - the matrix cell this WO adds.
// =============================================================================

describe('event: model item Placement move (bore-bound origin)', () => {
  function boreWcs(over: Partial<WCS> = {}): WCS {
    return makeWcs({
      snapGeoId: 'geo-model', snapLocalPt: { x: 10, y: 12, z: 10 },
      origin: { x: 10, y: 12, z: 10 }, // placement at identity to start
      originBinding: {
        kind: 'part_feature',
        geoId: 'geo-model',
        featureRef: {
          kind: 'bore_center',
          geoId: 'geo-model', bodyId: 'F1', modelItemId: 'legacy', faceStableId: 'F1:wall',
          localCenter: { x: 10, y: 12, z: 10 }, diameter: 8,
        },
      },
      ...over,
    })
  }

  it('part_feature (bore): the WCS re-derives when the model item it lives on moves', () => {
    const geo = makeModelGeo()
    const placements: ModelItemPlacementRecord[] = [
      { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ]
    installProject({
      geometry: [geo], stocks: [], setups: [makeSetup(boreWcs())],
      sceneStock: makeAutoSceneStock(), modelItemPlacements: placements,
    })
    useCamStore.getState().updateModelItemPlacement('legacy', undefined, { x: 30, y: 40, z: 2 }, { x: 0, y: 0, z: 0 })
    // No rotation -> origin = localCenter + new position.
    expect(currentOrigin()).toEqual({ x: 40, y: 52, z: 12 })
  })

  it('a stock move/resize does NOT move a bore-bound origin', () => {
    const geo = makeModelGeo()
    const placements: ModelItemPlacementRecord[] = [
      { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
    ]
    const fixed = fixedStockItem()
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    installProject({
      geometry: [geo], stocks: [explicit], setups: [makeSetup(boreWcs())],
      sceneStock: makeFixedSceneStock([fixed]), modelItemPlacements: placements,
    })
    useCamStore.getState().moveFixedStockLive('stock-1', { x: 99, y: 99, z: 99 })
    expect(currentOrigin()).toEqual({ x: 10, y: 12, z: 10 })
    useCamStore.getState().updateFixedStock('stock-1', { width: 80, height: 60, depth: 20 })
    expect(currentOrigin()).toEqual({ x: 10, y: 12, z: 10 })
  })
})

// =============================================================================
// NAMED REGRESSIONS
// =============================================================================

describe('B10: add a 3D part -> auto stock thickens -> corner-pinned WCS z follows', () => {
  it('a corner-pinned (top-face) WCS z rises when a taller 3D part joins the auto stock', () => {
    const flat = makeMeshGeo({ id: 'geo-flat', boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 40, z: 4 }) })
    const sceneStock = makeAutoSceneStock()
    const box0 = deriveAutoStockBounds([flat], sceneStock)!
    const wcs = makeWcs({
      cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      origin: expectedCorner(box0.min, box0.max, 2, 0, 'top'),
    })
    installProject({
      geometry: [flat], stocks: [derivedStock()],
      setups: [makeSetup(wcs)], sceneStock,
    })
    const z0 = currentOrigin().z
    // Add a taller part (z extent 0..20). addGeometry -> applyAutoStockToSetups.
    const tall = makeMeshGeo({ id: 'geo-tall', boundingBox: bbox({ x: 5, y: 5, z: 0 }, { x: 30, y: 30, z: 20 }) })
    useCamStore.getState().addGeometry(tall)
    const z1 = currentOrigin().z
    // New top = max part z (20) + autoOffsetZTop (1) = 21; old was 4 + 1 = 5.
    expect(z0).toBeCloseTo(5, 9)
    expect(z1).toBeCloseTo(21, 9)
    expect(z1).toBeGreaterThan(z0)  // the z FOLLOWED the thickening
  })
})

describe('B18: switch auto->fixed -> corner WCS jumps to the fixed-stock corner', () => {
  it('a corner-pinned WCS re-derives onto the fixed-stock corner on mode switch', () => {
    const geo = makeCurvesGeo({ position: { x: 0, y: 0, z: 0 } })  // 50x50 part
    const fixed = fixedStockItem({ width: 100, height: 100, depth: 12, position: { x: 0, y: 0, z: 0 } })
    // Start in AUTO; WCS pinned to the auto-box front-left-top corner.
    const sceneStock = makeFixedSceneStock([fixed], { mode: 'auto' }) as SceneStock
    const autoBox = deriveAutoStockBounds([geo], { ...sceneStock, mode: 'auto' })!
    const wcs = makeWcs({
      stockId: 'stock-1', cornerRow: 2, cornerCol: 0, cornerFace: 'top',
      origin: expectedCorner(autoBox.min, autoBox.max, 2, 0, 'top'),
    })
    const explicit = explicitStock('stock-1', 'Stock', { x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 })
    installProject({
      geometry: [geo], stocks: [explicit],
      setups: [makeSetup(wcs)],
      sceneStock: { ...sceneStock, mode: 'auto' },
    })
    const autoOrigin = currentOrigin()
    // Switch INTO fixed mode -> applyFixedStocksToSetups re-derives from the
    // fixed-stock corner (applyAutoStockToSetups would no-op in fixed mode).
    useCamStore.getState().updateSceneStock({ mode: 'fixed' })
    const want = expectedCorner({ x: 0, y: 0, z: 0 }, { x: 100, y: 100, z: 12 }, 2, 0, 'top')
    expect(currentOrigin()).toEqual(want)
    // The auto box (52 wide incl. offsets) differs from the 100-wide fixed stock,
    // so the WCS genuinely JUMPED.
    expect(currentOrigin()).not.toEqual(autoOrigin)
  })
})

// =============================================================================
// TASK 2 GUARD: SetupModal write sites keep wcs.originBinding FRESH.
// (Asserted at the deriveOriginBinding mapping level, which SetupModal mirrors;
//  see SetupModal.handleSave. Proves corner/snap/manual picks each map to the
//  matching originBinding so the field is never stale relative to the legacy
//  fields it is derived from.)
// =============================================================================

describe('Task 2: originBinding stays in sync with a re-picked legacy binding', () => {
  it('corner re-pick -> originBinding kind stock_corner with matching corner fields', () => {
    const wcs: WCS = makeWcs({
      stockId: 'stock-9', cornerRow: 1, cornerCol: 2, cornerFace: 'bottom',
      originBinding: { kind: 'manual' },  // stale from a prior manual pick
    })
    const fresh = syncOriginBinding(wcs)
    expect(fresh).toEqual({
      kind: 'stock_corner', stockId: 'stock-9', cornerRow: 1, cornerCol: 2, cornerFace: 'bottom',
    })
  })

  it('AUTO-mode corner re-pick (corner set, no explicit stockId) -> stock_corner bound to DERIVED_STOCK_ID', () => {
    // SetupModal auto mode: corner pick with no selected/auto fixed stock writes
    // cornerRow/Col/Face but NO stockId. This must map to the derived stock, not
    // 'manual' — otherwise a reader trusting originBinding stops re-deriving it.
    const wcs: WCS = makeWcs({
      cornerRow: 0, cornerCol: 1, cornerFace: 'top',
      originBinding: { kind: 'manual' },  // stale from a prior manual pick
    })
    const fresh = syncOriginBinding(wcs)
    expect(fresh).toEqual({
      kind: 'stock_corner', stockId: DERIVED_STOCK_ID, cornerRow: 0, cornerCol: 1, cornerFace: 'top',
    })
  })

  it('snap re-pick -> originBinding kind part_feature/vertex with matching localPt', () => {
    const wcs: WCS = makeWcs({
      snapGeoId: 'geo-7', snapLocalPt: { x: 1, y: 2, z: 3 },
      originBinding: { kind: 'stock_corner', stockId: 'old', cornerRow: 0, cornerCol: 0, cornerFace: 'top' },
    })
    const fresh = syncOriginBinding(wcs)
    expect(fresh).toEqual({
      kind: 'part_feature', geoId: 'geo-7', featureRef: { kind: 'vertex', localPt: { x: 1, y: 2, z: 3 } },
    })
  })

  it('manual/gizmo re-pick -> originBinding kind manual', () => {
    const wcs: WCS = makeWcs({
      originBinding: { kind: 'part_feature', geoId: 'gone', featureRef: { kind: 'vertex', localPt: { x: 0, y: 0, z: 0 } } },
    })
    expect(syncOriginBinding(wcs)).toEqual({ kind: 'manual' })
  })
})

// The exact mapping migrateHierarchy.deriveOriginBinding implements and that
// SetupModal.handleSave mirrors at the write site. Keyed on wcs.stockId for the
// stock_corner branch so a migrated load and a fresh pick agree. Mirrored here
// so the test asserts the contract the write sites satisfy.
import { deriveOriginBindingForTest, DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
function syncOriginBinding(wcs: WCS): import('../../types').OriginBinding {
  return deriveOriginBindingForTest(wcs)
}
