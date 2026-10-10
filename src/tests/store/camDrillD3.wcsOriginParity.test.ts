// CAM-DRILL-D3: formula-drift tripwire tying effectiveWcsOriginZ (dispatchGeo.ts)
// to cornerOriginFromBox (store/index.ts:325-338) on the SAME box. Both compute
// the Z baseline a corner-pinned WCS resolves against:
//   - cornerOriginFromBox (private, store/index.ts) WRITES a corner-pinned WCS's
//     origin.z at stock-update time (applyAutoStockToSetups, index.ts:397-447).
//   - effectiveWcsOriginZ (exported, dispatchGeo.ts:1069-1078) MIRRORS that same
//     formula at READ time for a model-only stock whose origin.z is stale
//     (CAM-DRILL-FIX2/FIX3). If either formula drifts (e.g. someone flips the
//     cornerFace ternary in one but not the other), the parity breaks.
//
// Approach: drive the REAL store (useCamStore) so the REAL cornerOriginFromBox
// runs inside applyAutoStockToSetups and writes wcs.origin.z. Then call the REAL
// effectiveWcsOriginZ with the SAME box (computed via the exported
// deriveStockBounds -- the same function applyAutoStockToSetups calls internally
// for a derived stock) and assert the Z values agree. Both sides are the real
// implementations -- no local formula mirror that could itself drift. The
// existing wcsRederivation/autoStockClobber/explicitStockMove tests already
// exercise cornerOriginFromBox through the store with a LOCAL mirror; this test
// is the first to tie that output to effectiveWcsOriginZ directly.
//
// Scope: test files ONLY. No production code changed. cornerOriginFromBox stays
// private; the store's public addGeometry action is the seam that surfaces its
// real output.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore } from '../../store'
import { effectiveWcsOriginZ } from '../../store/dispatchGeo'
import { deriveStockBounds } from '../../store/stockAssignment'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import type {
  ImportedGeometry, PhysicalStock, Setup, SceneStock, WCS,
  BoundingBox, Vec3, Project,
} from '../../types'

// -- Fixtures ------------------------------------------------------------------

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// A regular (real-geometry) 3D part. World bbox Z [0,10], XY [10,60]x[20,70].
// No stockId -- assignStocks routes it to the sole derived (catch-all) stock,
// making it a member whose world bounds drive deriveStockBounds. Using a
// non-model mesh (not a model-origin body) keeps this test focused on the
// Z-baseline formula parity, independent of FIX1/FIX3's Placement composition.
function memberGeo(): ImportedGeometry {
  return {
    id: 'geo-member', name: 'Part3D', filename: 'part.stl', type: 'mesh', format: 'stl',
    boundingBox: bbox({ x: 10, y: 20, z: 0 }, { x: 60, y: 70, z: 10 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  } as unknown as ImportedGeometry
}

// Distinct offsets so the padded box is unambiguously not the raw geometry box
// (autoOffsetXY=5 pads each XY side, autoOffsetZTop=3 pads the top; the base
// is unpadded). The derived stock box from the member above:
//   min = { 10-5, 20-5, 0 } = { 5, 15, 0 }
//   max = { 60+5, 70+5, 10+3 } = { 65, 75, 13 }
// So box.min.z = 0, box.max.z = 13.
const sceneStock = {
  mode: 'auto', autoOffsetXY: 5, autoOffsetZTop: 3,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [], autoStocks: [],
} as unknown as SceneStock

function makeDerivedStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
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
  } as unknown as Setup
}

function installProject(over: Partial<Project>): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [], setups: [], stocks: [],
      activeSetupId: 'setup-1', activeOperationId: null,
      ...over,
    },
  }))
}

beforeEach(() => {
  installProject({})
})

// All 9 corner positions (row 0-2 back->front, col 0-2 left->right) x both
// faces = 18 configs. cornerOriginFromBox's Z depends only on cornerFace (top
// -> max.z, bottom -> min.z); effectiveWcsOriginZ mirrors that same dependency.
// Row/col vary the X/Y corner position (which effectiveWcsOriginZ ignores for Z
// but cornerOriginFromBox computes) -- included to confirm the Z parity holds
// regardless of which corner is picked.
const CORNER_CONFIGS: Array<[number, number, 'top' | 'bottom']> = [
  [0, 0, 'top'], [0, 1, 'top'], [0, 2, 'top'],
  [1, 0, 'top'], [1, 1, 'top'], [1, 2, 'top'],
  [2, 0, 'top'], [2, 1, 'top'], [2, 2, 'top'],
  [0, 0, 'bottom'], [0, 1, 'bottom'], [0, 2, 'bottom'],
  [1, 0, 'bottom'], [1, 1, 'bottom'], [1, 2, 'bottom'],
  [2, 0, 'bottom'], [2, 1, 'bottom'], [2, 2, 'bottom'],
]

describe('CAM-DRILL-D3: effectiveWcsOriginZ vs cornerOriginFromBox Z parity on the same box', () => {
  describe('corner-pinned WCS (both formulas active) -- store-driven, both implementations real', () => {
    it.each(CORNER_CONFIGS)(
      'corner (row=%i, col=%i, face=%s): wcs.origin.z written by cornerOriginFromBox === effectiveWcsOriginZ(wcs, box)',
      (row, col, face) => {
        // Install a project with a corner-pinned WCS bound to the sole derived
        // stock, origin deliberately stale at z=0 (the state a fresh Setup
        // starts in before any stock re-derivation runs). No geometry yet.
        const wcs = makeWcs({
          stockId: DERIVED_STOCK_ID,
          cornerRow: row, cornerCol: col, cornerFace: face,
          origin: { x: 0, y: 0, z: 0 },
        })
        installProject({
          geometry: [], stocks: [makeDerivedStock()],
          setups: [makeSetup(wcs)], sceneStock,
        })
        // addGeometry -> assignStocks (member -> derived stock) ->
        // rederiveDerivedStockBounds -> applyAutoStockToSetups ->
        //   deriveStockBounds(stock, geometry, offsets, ...) -> box
        //   cornerOriginFromBox(box, row, col, face) -> writes wcs.origin
        useCamStore.getState().addGeometry(memberGeo())

        const project = useCamStore.getState().project
        const setup = project.setups[0]
        const stocks = project.stocks ?? []
        // The SAME box applyAutoStockToSetups used: deriveStockBounds is the
        // exported function the applier calls internally for a derived stock
        // (index.ts:440). placementRecords omitted (defaults to NO_PLACEMENTS =
        // []; the member is a non-model mesh, so placements do not affect it).
        const box = deriveStockBounds(stocks[0], project.geometry, sceneStock)
        expect(box, 'deriveStockBounds must produce a box for the member geometry').toBeDefined()
        const b = box!

        // CORE PARITY: the REAL cornerOriginFromBox output (written into
        // wcs.origin.z by applyAutoStockToSetups) must equal the REAL
        // effectiveWcsOriginZ output computed from the same box + same corner
        // config. If either formula drifts, this assertion breaks.
        const effectiveZ = effectiveWcsOriginZ(setup.wcs, b)
        expect(setup.wcs.origin.z).toBeCloseTo(effectiveZ, 9)

        // Explicit formula check: top face -> box.max.z, bottom -> box.min.z.
        // Pins the face->bound mapping both implementations share, so a ternary
        // flip in either one is caught independently of the parity above.
        const expectedFaceZ = face === 'top' ? b.max.z : b.min.z
        expect(effectiveZ).toBeCloseTo(expectedFaceZ, 9)
        expect(setup.wcs.origin.z).toBeCloseTo(expectedFaceZ, 9)
      },
    )
  })

  describe('non-corner-pinned WCS -- effectiveWcsOriginZ falls through to raw origin.z (no corner formula to mirror, matching applyAutoStockToSetups own guard at index.ts:416)', () => {
    it('no cornerRow/cornerCol: effectiveWcsOriginZ returns wcs.origin.z unchanged', () => {
      const wcs = makeWcs({ origin: { x: 1, y: 2, z: 7 } })
      const box = bbox({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: 10 })
      expect(effectiveWcsOriginZ(wcs, box)).toBe(7)
    })

    it('vertex-snapped (snapGeoId set): effectiveWcsOriginZ returns wcs.origin.z unchanged -- the snap mechanism owns this WCS, not the corner formula', () => {
      const wcs = makeWcs({
        cornerRow: 0, cornerCol: 0, cornerFace: 'top', snapGeoId: 'geo-snap',
        origin: { x: 1, y: 2, z: 7 },
      })
      const box = bbox({ x: 0, y: 0, z: 0 }, { x: 50, y: 50, z: 10 })
      // cornerRow/cornerCol ARE set, but snapGeoId is too -> not corner-pinned
      // (mirrors applyAutoStockToSetups's own `snapGeoId` guard).
      expect(effectiveWcsOriginZ(wcs, box)).toBe(7)
    })

    it('bounds undefined: effectiveWcsOriginZ returns wcs.origin.z unchanged (no box to mirror against)', () => {
      const wcs = makeWcs({
        cornerRow: 0, cornerCol: 0, cornerFace: 'top',
        origin: { x: 0, y: 0, z: 7 },
      })
      expect(effectiveWcsOriginZ(wcs, undefined)).toBe(7)
    })
  })
})
