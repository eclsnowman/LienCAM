// FIX A regression: a part_feature (vertex-SNAP) WCS bound to a nest-owned SEED
// must follow the seed when the nest's BOUND SHEET stock moves.
//
// THE INVARIANT (Operator's rule):
//   - a WCS defined relative to the STOCK   follows the stock when it moves
//   - a WCS defined relative to the GEOMETRY follows the geometry
//   - a WCS defined relative to the MACHINE  (manual) never moves
//
// CONTEXT (owned-seed model): a nest owns a deep-copy SEED geometry
// (ImportedGeometry.ownerNestId === nest.id). The seed is explicit NO-STOCK. The
// nest binds to a FIXED sheet stock (NestRecord.boundStockId). Moving that bound
// stock runs moveFixedStockLive (gizmo drag) / updateFixedStock (typed edit),
// which call translateBoundNest to shift NestRecord.origin AND the owned-seed
// position, then run the WCS appliers.
//
// THE BUG (pre-fix):
//   - moveFixedStockLive ran applyGeoSnapToSetups on the PRE-shift geometry
//     (before translateBoundNest moved the seed), so a seed-snap WCS lagged the
//     move by the full delta.
//   - updateFixedStock ran NO snap applier at all, so a typed position edit on a
//     nest-bound stock never moved a seed-snap WCS.
//
// THE FIX: run applyGeoSnapToSetups on coupled.geometry (POST translateBoundNest)
// in BOTH actions, so the seed-snap WCS re-derives from the seed's NEW position.
//
// This file drives the REAL store actions and asserts, for a +dx/+dy fixture move:
//   - the seed-SNAP WCS origin tracks the seed by the move delta            (FIX A)
//   - a stock_corner WCS bound to the moved stock still rides by the delta  (unchanged)
//   - a MANUAL WCS does NOT move                                            (invariant)
// across BOTH moveFixedStockLive and updateFixedStock.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import type {
  ImportedGeometry, SceneStock, Setup, WCS, PhysicalStock, FixedStockItem,
  NestRecord, BoundingBox, Vec3, Project,
} from '../../types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const NEST_ID = 'nest-1'
const SHEET_ID = 'sheet-stock-1'
const SEED_ID = 'seed-geo-1'

// The seed's home position (its world XY anchor). The snap WCS is bound to a
// vertex at a known LOCAL offset from this; after a fixture move the snap origin
// must equal localPt + the seed's NEW position.
const SEED_POS_0: Vec3 = { x: 10, y: 20, z: 0 }
const SNAP_LOCAL: Vec3 = { x: 5, y: 7, z: 0 }
const SHEET_POS_0: Vec3 = { x: 0, y: 0, z: 0 }
const SHEET_W = 200, SHEET_H = 100, SHEET_D = 12

/** Owned-seed geometry: NO stock (explicit no-stock), ownerNestId set. */
function makeSeed(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: SEED_ID, name: 'Seed Part', filename: '', type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 30, y: 30, z: 0 }),
    position: { ...SEED_POS_0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    ownerNestId: NEST_ID,
    loops: [{
      id: 'loop-1',
      points: [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 }],
      closed: true, type: 'contour', layerId: 'L1', area: 900,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    ...over,
  } as ImportedGeometry
}

function makeFixedStock(): FixedStockItem {
  return {
    id: SHEET_ID, name: 'Nest Sheet',
    width: SHEET_W, height: SHEET_H, depth: SHEET_D,
    position: { ...SHEET_POS_0 },
  }
}

/** Explicit PhysicalStock twin for the fixed sheet (moveFixedStockLive fail-loud
 *  guard requires an explicit twin with the same id). */
function explicitTwin(): PhysicalStock {
  return {
    id: SHEET_ID, name: 'Nest Sheet', mode: 'explicit',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: SHEET_W, y: SHEET_H, z: SHEET_D }),
    position: { ...SHEET_POS_0 },
  }
}

function makeNest(): NestRecord {
  return {
    id: NEST_ID, name: 'Nest 1',
    sheet: { width: SHEET_W, height: SHEET_H },
    style: 'ninety',
    spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
    seed: 1,
    sources: [{ geometryId: SEED_ID, quantity: 1, ownedByNest: true }],
    placements: [],
    unplaced: [],
    utilization: 0,
    thickness: SHEET_D,
    boundStockId: SHEET_ID,
    origin: { x: 0, y: 0 },
  } as NestRecord
}

function makeSceneStock(): SceneStock {
  return {
    mode: 'auto',
    autoOffsetXY: 2, autoOffsetZTop: 1,
    fixedWidth: 100, fixedHeight: 100, fixedDepth: 12,
    fixedStocks: [makeFixedStock()],
    autoStocks: [],
  }
}

function makeWcs(id: string, fixtureOffset: number, over: Partial<WCS> = {}): WCS {
  return {
    id, label: `G${fixtureOffset}`, fixtureOffset,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    ...over,
  } as WCS
}

function makeSetup(id: string, wcs: WCS): Setup {
  return {
    id, name: id,
    wcs,
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    } as Setup['stock'],
    operations: [], notes: '',
  }
}

// The three setups under test:
//  - snapSetup: part_feature WCS snapped to a SEED vertex (follows the seed).
//  - cornerSetup: stock_corner WCS bound to the moved sheet (follows the stock).
//  - manualSetup: manual WCS (machine-relative; never moves).
function snapSetup(): Setup {
  const origin: Vec3 = {
    x: SNAP_LOCAL.x + SEED_POS_0.x,
    y: SNAP_LOCAL.y + SEED_POS_0.y,
    z: SNAP_LOCAL.z + SEED_POS_0.z,
  }
  return makeSetup('snap-setup', makeWcs('wcs-snap', 54, {
    origin,
    snapGeoId: SEED_ID,
    snapLocalPt: { ...SNAP_LOCAL },
    originBinding: {
      kind: 'part_feature', geoId: SEED_ID,
      featureRef: { kind: 'vertex', localPt: { ...SNAP_LOCAL } },
    },
  }))
}

// Front-left top corner of the sheet (row 2, col 0) = (min.x, min.y, max.z).
const CORNER_ORIGIN_0: Vec3 = { x: SHEET_POS_0.x, y: SHEET_POS_0.y, z: SHEET_POS_0.z + SHEET_D }
function cornerSetup(): Setup {
  return makeSetup('corner-setup', makeWcs('wcs-corner', 55, {
    origin: { ...CORNER_ORIGIN_0 },
    stockId: SHEET_ID,
    cornerRow: 2, cornerCol: 0, cornerFace: 'top',
    originBinding: { kind: 'stock_corner', stockId: SHEET_ID, cornerRow: 2, cornerCol: 0, cornerFace: 'top' },
  }))
}

const MANUAL_ORIGIN: Vec3 = { x: -50, y: -60, z: 3 }
function manualSetup(): Setup {
  return makeSetup('manual-setup', makeWcs('wcs-manual', 56, {
    origin: { ...MANUAL_ORIGIN },
    originBinding: { kind: 'manual' } as WCS['originBinding'],
  }))
}

function installNestScenario(): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [makeSeed()],
      stocks: [explicitTwin()],
      nests: [makeNest()],
      setups: [snapSetup(), cornerSetup(), manualSetup()],
      sceneStock: makeSceneStock(),
      activeSetupId: 'snap-setup',
      activeOperationId: null,
    } as Project,
  }))
}

function findSetup(id: string): Setup {
  return useCamStore.getState().project.setups.find((s) => s.id === id)!
}
function findSeed(): ImportedGeometry {
  return useCamStore.getState().project.geometry.find((g) => g.id === SEED_ID)!
}

const DX = 40, DY = 25
const EPS = 1e-6

function assertInvariantHolds(): void {
  // Seed rode by the delta.
  const seed = findSeed()
  expect(seed.position.x).toBeCloseTo(SEED_POS_0.x + DX, 4)
  expect(seed.position.y).toBeCloseTo(SEED_POS_0.y + DY, 4)

  // FIX A: seed-SNAP WCS tracks the seed (origin == localPt + NEW seed position).
  const snap = findSetup('snap-setup')
  expect(snap.wcs.origin.x).toBeCloseTo(SNAP_LOCAL.x + SEED_POS_0.x + DX, 4)
  expect(snap.wcs.origin.y).toBeCloseTo(SNAP_LOCAL.y + SEED_POS_0.y + DY, 4)

  // stock_corner WCS rides the moved sheet by the same delta (unchanged behavior).
  const corner = findSetup('corner-setup')
  expect(corner.wcs.origin.x).toBeCloseTo(CORNER_ORIGIN_0.x + DX, 4)
  expect(corner.wcs.origin.y).toBeCloseTo(CORNER_ORIGIN_0.y + DY, 4)

  // MANUAL WCS does NOT move (machine-relative).
  const manual = findSetup('manual-setup')
  expect(Math.abs(manual.wcs.origin.x - MANUAL_ORIGIN.x)).toBeLessThan(EPS)
  expect(Math.abs(manual.wcs.origin.y - MANUAL_ORIGIN.y)).toBeLessThan(EPS)
  expect(Math.abs(manual.wcs.origin.z - MANUAL_ORIGIN.z)).toBeLessThan(EPS)
}

beforeEach(() => {
  installNestScenario()
})

describe('FIX A: seed-snap WCS follows a nest-bound sheet move', () => {
  it('moveFixedStockLive (gizmo): snap follows seed, corner rides stock, manual fixed', () => {
    useCamStore.getState().moveFixedStockLive(SHEET_ID, {
      x: SHEET_POS_0.x + DX, y: SHEET_POS_0.y + DY, z: SHEET_POS_0.z,
    })
    assertInvariantHolds()
  })

  it('updateFixedStock (typed position edit): same invariant across all three modes', () => {
    useCamStore.getState().updateFixedStock(SHEET_ID, {
      position: { x: SHEET_POS_0.x + DX, y: SHEET_POS_0.y + DY, z: SHEET_POS_0.z },
    })
    assertInvariantHolds()
  })
})

describe('FIX A: a pure (non-position) edit does not move any WCS', () => {
  it('updateFixedStock with only a depth change leaves snap/corner/manual put', () => {
    // A re-thickness edit yields delta 0 -> translateBoundNest is a no-op and the
    // snap applier re-derives the SAME origin (byte-identical behavior).
    useCamStore.getState().updateFixedStock(SHEET_ID, { depth: SHEET_D + 3 })

    const seed = findSeed()
    expect(seed.position.x).toBeCloseTo(SEED_POS_0.x, 4)
    expect(seed.position.y).toBeCloseTo(SEED_POS_0.y, 4)

    const snap = findSetup('snap-setup')
    expect(snap.wcs.origin.x).toBeCloseTo(SNAP_LOCAL.x + SEED_POS_0.x, 4)
    expect(snap.wcs.origin.y).toBeCloseTo(SNAP_LOCAL.y + SEED_POS_0.y, 4)

    const manual = findSetup('manual-setup')
    expect(manual.wcs.origin.x).toBeCloseTo(MANUAL_ORIGIN.x, 4)
    expect(manual.wcs.origin.y).toBeCloseTo(MANUAL_ORIGIN.y, 4)
  })
})
