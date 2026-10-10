// CAM-DRILL-FIX3: the height-plane matrix pinning the WHOLE model-source
// height-resolution family, not just drill's own defect. Enumerates every
// reference kind a Stage-2-legit op (drill/contour_2d/pocket_2d/bore/etc, the
// families guardOperationModelOrigin lets reach height resolution for a
// model-origin geometryId) can be configured with, and asserts one of two
// outcomes per cell:
//
//   PARITY  - the model-source resolution gives the IDENTICAL WCS-relative
//             value a REGULAR (real-geometry, explicit-stock) source resolves
//             for the SAME world geometry + SAME corner-pinned WCS config.
//             Parity is the ground truth (per this lane's mission): a
//             model-derived stock must not compute a materially different
//             answer than an equivalent regular stock would.
//   REFUSED - a typed, named error (ModelOriginComputeError) - a reference
//             kind Stage 2 does not support yet for a model-origin source
//             (model_top / geometry_face / picked_plane / model_bottom read
//             geo.position/boundingBox DIRECTLY with no Placement
//             composition - CAM-DRILL-FIX1's own documented boundary, and the
//             f4ba754be audit's "-50 hazard" class resolveModelBottomZ
//             deliberately stays strict against). Never a silent wrong Z.
//
// Geometry-free kinds (absolute/machine_floor/wcs_plane) are included for
// completeness - they touch no geometry at all by construction, so
// model-vs-regular parity is trivial (same formula, same inputs).
//
// stock_top/stock_bottom cells were fixed by CAM-DRILL-FIX1+FIX2 (already
// pinned by camDrillFix1.modelHeights.test.ts / camDrillFix2.retractResolve
// .test.ts) - reasserted here at the pure resolveTopZ level for a single
// source-of-truth matrix. selected_face cells are THIS lane's fix (also
// store-level-proven by camDrillFix3.selectedFaceModelAware.test.ts) -
// reasserted here at the pure resolveGeometryZToFramesModelAware level.

import { describe, it, expect } from 'vitest'
import {
  resolveTopZ, resolveModelBottomZ, resolveGeometryZToFramesModelAware,
  ModelOriginComputeError, OwningStockError,
} from '../../store/dispatchGeo'
import { DERIVED_STOCK_ID } from '../../store/migrateHierarchy'
import type { ImportedGeometry, PhysicalStock, Setup, SceneStock, ModelItemPlacementRecord, Vec3, BoundingBox } from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

// sceneStock with ZERO top padding, so a MODEL-derived stock's bounds equal
// its bare geometry bounds exactly - isolating the parity comparison from the
// (orthogonal, pre-existing, unrelated-to-this-lane) auto-offset padding
// CAM-DRILL-FIX3's OTHER test file already covers.
const sceneStockNoPad = {
  mode: 'auto', autoOffsetXY: 0, autoOffsetZTop: 0,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [], autoStocks: [],
} as unknown as SceneStock

// ── REGULAR (real-geometry) side: a plain 2D/step part on an EXPLICIT
// stock spanning world Z [0,10] - a real corner-pinned Setup's origin.z
// would sit at 10 (cornerFace 'top'), exactly what applyAutoStockToSetups
// keeps it pinned to (never stale for a real-geometry stock).
function regularGeo(): ImportedGeometry {
  return {
    id: 'reg1', name: 'Plate (real)', filename: 'plate.step', type: 'brep', format: 'step',
    boundingBox: bbox({ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: 'stock-real',
    loops: [], layers2d: [
      { id: 'L0', name: 'L0', color: '#fff', visible: true, frame: 'geometry_local',
        holes: [{ center: [0, 0], diameter: 6, topZ: 10, bottomZ: 0, through: true, loopId: 'reg1-l0' }] },
    ],
  } as unknown as ImportedGeometry
}
const regularStock: PhysicalStock = {
  id: 'stock-real', name: 'Stock (real)', mode: 'explicit',
  position: { x: -25, y: -20, z: 0 },
  bounds: { size: { x: 50, y: 40, z: 10 } },
} as unknown as PhysicalStock
const regularSetup: Setup = {
  id: 'setup-real', name: 'Setup (real)',
  wcs: {
    id: 'wcs-real', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 10 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    cornerRow: 0, cornerCol: 0, cornerFace: 'top', stockId: 'stock-real',
  } as unknown as Setup['wcs'],
} as unknown as Setup

// ── MODEL-SOURCE side: the SAME world bbox [0,10], via a model-only DERIVED
// stock (FIX1's single-stock owning machinery) and a Setup whose origin.z
// stays FROZEN at 0 (never re-derived - CAM-DRILL-FIX2's documented reality
// for a model-only derived stock) - proving parity holds DESPITE the
// staleness, not merely when it happens to be absent.
function modelGeo(): ImportedGeometry {
  return {
    id: 'mb1', name: 'Plate (model)', filename: '', type: 'model', format: 'model',
    boundingBox: bbox({ x: -20, y: -15, z: 0 }, { x: 20, y: 15, z: 10 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: 'legacy',
    modelBody: {
      ref: { bodyId: 'mb1-body', stableIds: ['mb1-body:F0'], version: 1 },
      display: {
        positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
        bbox: { min: [-20, -15, 0], max: [20, 15, 10] },
      },
    },
    loops: [], layers2d: [
      { id: 'L0', name: 'L0', color: '#fff', visible: true, frame: 'geometry_local',
        holes: [{ center: [0, 0], diameter: 6, topZ: 10, bottomZ: 0, through: true, loopId: 'mb1-l0' }] },
    ],
  } as unknown as ImportedGeometry
}
const modelDerivedStock: PhysicalStock = {
  id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
  bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }), // placeholder - real bounds derive from member geometry
  position: { x: 0, y: 0, z: 0 },
} as unknown as PhysicalStock
const modelSetup: Setup = {
  id: 'setup-model', name: 'Setup (model)',
  wcs: {
    id: 'wcs-model', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 }, // FROZEN/stale
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    cornerRow: 0, cornerCol: 0, cornerFace: 'top', stockId: DERIVED_STOCK_ID,
  } as unknown as Setup['wcs'],
} as unknown as Setup
const IDENTITY_PLACEMENT: ModelItemPlacementRecord[] =
  [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }]

describe('CAM-DRILL-FIX3 matrix: model-source height-plane resolution vs the regular-stock ground truth', () => {
  describe('geometry-free reference kinds - trivially identical by construction (no geometry touched)', () => {
    it('absolute and wcs_plane ignore the Setup entirely, so they DO resolve identically for a model vs regular geometryId', () => {
      for (const ref of ['absolute', 'wcs_plane'] as const) {
        const regular = resolveTopZ(ref, 3, regularSetup, sceneStockNoPad, [regularGeo()], 'reg1', [regularStock])
        const model = resolveTopZ(ref, 3, modelSetup, sceneStockNoPad, [modelGeo()], 'mb1', [modelDerivedStock], [], undefined, IDENTITY_PLACEMENT)
        expect(model).toBeCloseTo(regular, 9)
      }
    })

    it('machine_floor: SAME FORMULA (-setup.wcs.origin.z + offset) for a model geometryId as for a regular one - not the SAME VALUE here only because this matrix deliberately configures the two fixtures\' origin.z differently (10 vs the frozen 0), matching real-world Setup state, not a divergence in the formula itself', () => {
      const regular = resolveTopZ('machine_floor', 3, regularSetup, sceneStockNoPad, [regularGeo()], 'reg1', [regularStock])
      const model = resolveTopZ('machine_floor', 3, modelSetup, sceneStockNoPad, [modelGeo()], 'mb1', [modelDerivedStock], [], undefined, IDENTITY_PLACEMENT)
      expect(regular).toBeCloseTo(-regularSetup.wcs.origin.z + 3, 9)
      expect(model).toBeCloseTo(-modelSetup.wcs.origin.z + 3, 9)
    })
  })

  describe('stock_top / stock_bottom - CAM-DRILL-FIX1+FIX2 (already shipped, reasserted here)', () => {
    it.each([
      ['stock_top', 0] as const,
      // stock_bottom: 10mm below the top-pinned origin (the world bbox
      // spans [0,10]; the WCS origin sits at the world TOP per cornerFace
      // 'top') - NOT 0 (that would be stock_top's own invariant only).
      ['stock_bottom', -10] as const,
    ])('%s: model-derived stock PARITY with the regular explicit stock at identical world bounds (expect %d)', (ref, expected) => {
      const regular = resolveTopZ(ref, 0, regularSetup, sceneStockNoPad, [regularGeo()], 'reg1', [regularStock])
      const model = resolveTopZ(ref, 0, modelSetup, sceneStockNoPad, [modelGeo()], 'mb1', [modelDerivedStock], [], undefined, IDENTITY_PLACEMENT)
      expect(model).toBeCloseTo(regular, 6)
      expect(model).toBeCloseTo(expected, 6)
    })

    it('>1 stock: model source REFUSES loud (typed OwningStockError), never guesses which stock owns it', () => {
      const secondStock: PhysicalStock = { ...modelDerivedStock, id: 'stock-2' }
      expect(() => resolveTopZ(
        'stock_top', 0, modelSetup, sceneStockNoPad, [modelGeo()], 'mb1',
        [modelDerivedStock, secondStock], [], undefined, IDENTITY_PLACEMENT,
      )).toThrow(OwningStockError)
    })
  })

  describe('model_top / geometry_face / picked_plane - Stage 2 boundary, deliberately REFUSED for a model source', () => {
    it('model_top: REGULAR resolves a number; MODEL source throws ModelOriginComputeError', () => {
      const regular = resolveTopZ('model_top', 0, regularSetup, sceneStockNoPad, [regularGeo()], 'reg1', [regularStock])
      expect(Number.isFinite(regular)).toBe(true)
      expect(() => resolveTopZ(
        'model_top', 0, modelSetup, sceneStockNoPad, [modelGeo()], 'mb1',
        [modelDerivedStock], [], undefined, IDENTITY_PLACEMENT,
      )).toThrow(ModelOriginComputeError)
    })

    it('geometry_face: REGULAR resolves a number; MODEL source throws ModelOriginComputeError', () => {
      const regular = resolveTopZ('geometry_face', 0, regularSetup, sceneStockNoPad, [regularGeo()], 'reg1', [regularStock])
      expect(Number.isFinite(regular)).toBe(true)
      expect(() => resolveTopZ(
        'geometry_face', 0, modelSetup, sceneStockNoPad, [modelGeo()], 'mb1',
        [modelDerivedStock], [], undefined, IDENTITY_PLACEMENT,
      )).toThrow(ModelOriginComputeError)
    })

    it('picked_plane: MODEL source throws ModelOriginComputeError (arrival-point guard fires before the picked-plane branch is ever reached)', () => {
      expect(() => resolveTopZ(
        'picked_plane', 0, modelSetup, sceneStockNoPad, [modelGeo()], 'mb1',
        [modelDerivedStock], [], { geoId: 'mb1', faceIndex: 0, localZ: 5 }, IDENTITY_PLACEMENT,
      )).toThrow(ModelOriginComputeError)
    })
  })

  describe('model_bottom (resolveModelBottomZ) - deliberately STAYS STRICT (f4ba754be -50-hazard class), unchanged by this lane', () => {
    it('REGULAR resolves a number; MODEL source throws ModelOriginComputeError', () => {
      const regular = resolveModelBottomZ([regularGeo()], 'reg1', regularSetup.wcs.origin.z, [regularStock])
      expect(Number.isFinite(regular)).toBe(true)
      expect(() => resolveModelBottomZ(
        [modelGeo()], 'mb1', modelSetup.wcs.origin.z, [modelDerivedStock],
      )).toThrow(ModelOriginComputeError)
    })
  })

  describe('selected_face (top AND bottom) - THIS LANE\'S FIX (CAM-DRILL-FIX3)', () => {
    it('top: model-source PARITY with the regular source at an identical picked/derived local Z', () => {
      // A picked/derived TOP plane at local Z=10 (the plate's own top face) on
      // BOTH sources - the regular source's geo.position.z (0) already IS its
      // real world position; the model source's real position lives in the
      // Placement registry (identity here too, so both should agree exactly).
      const regular = resolveGeometryZToFramesModelAware(
        10, regularGeo(), regularSetup, [regularGeo()], sceneStockNoPad, [regularStock],
      )
      const model = resolveGeometryZToFramesModelAware(
        10, modelGeo(), modelSetup, [modelGeo()], sceneStockNoPad, [modelDerivedStock], IDENTITY_PLACEMENT,
      )
      expect(model.wcsZ).toBeCloseTo(regular.wcsZ, 6)
      expect(model.wcsZ).toBeCloseTo(0, 6) // corner-pinned to the same top plane
    })

    it('bottom: model-source PARITY with the regular source at an identical through-hole local Z', () => {
      const regular = resolveGeometryZToFramesModelAware(
        0, regularGeo(), regularSetup, [regularGeo()], sceneStockNoPad, [regularStock],
      )
      const model = resolveGeometryZToFramesModelAware(
        0, modelGeo(), modelSetup, [modelGeo()], sceneStockNoPad, [modelDerivedStock], IDENTITY_PLACEMENT,
      )
      expect(model.wcsZ).toBeCloseTo(regular.wcsZ, 6)
      expect(model.wcsZ).toBeCloseTo(-10, 6) // 10mm below the corner-pinned top
    })

    it('bottom: PLACEMENT-INVARIANT - a moved model body resolves the SAME WCS-relative bottom as the identity-placed one (proves real Placement composition, not identity)', () => {
      const moved: ModelItemPlacementRecord[] =
        [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 123 }, rotation: { x: 0, y: 0, z: 0 } }]
      const atIdentity = resolveGeometryZToFramesModelAware(
        0, modelGeo(), modelSetup, [modelGeo()], sceneStockNoPad, [modelDerivedStock], IDENTITY_PLACEMENT,
      )
      const atMoved = resolveGeometryZToFramesModelAware(
        0, modelGeo(), modelSetup, [modelGeo()], sceneStockNoPad, [modelDerivedStock], moved,
      )
      expect(atMoved.wcsZ).toBeCloseTo(atIdentity.wcsZ, 6)
      // CAM-DRILL-D3: hand-computed numeric anchor. The pin above is
      // resolver-vs-resolver (atMoved vs atIdentity) -- the EXACT shape that
      // let the FIX3 layer-3 defect hide: pre-fix, both sides collapsed to 0
      // identically (identity geo.position.z + stale origin.z 0), so the
      // equality passed even though both were wrong. Anchoring the literal
      // hand-computed value catches that:
      //   - modelGeo world bbox Z [0,10]; sceneStockNoPad has autoOffsetZTop=0,
      //     so the derived stock box max.z = 10 (no top padding).
      //   - modelSetup WCS is corner-pinned (row 0, col 0, face 'top') with a
      //     frozen origin.z = 0. effectiveWcsOriginZ for a corner-pinned top-
      //     face WCS returns box.max.z = 10.
      //   - localZ = 0 (through-hole bottom), identity placement z = 0 ->
      //     worldZ = 0 + 0 = 0.
      //   - wcsZ = worldZ - effectiveWcsZ = 0 - 10 = -10.
      //   Pre-FIX3 this was 0 (the layer-3 defect); -10 != 0 -> RED.
      expect(atIdentity.wcsZ).toBeCloseTo(-10, 6)
    })

    it('>1 stock: model source REFUSES loud (typed OwningStockError), never guesses', () => {
      const secondStock: PhysicalStock = { ...modelDerivedStock, id: 'stock-2' }
      expect(() => resolveGeometryZToFramesModelAware(
        0, modelGeo(), modelSetup, [modelGeo()], sceneStockNoPad,
        [modelDerivedStock, secondStock], IDENTITY_PLACEMENT,
      )).toThrow(OwningStockError)
    })

    it('a non-model geo is BYTE-IDENTICAL to plain resolveGeometryZToFrames (no behavior change for the regular-geometry case)', () => {
      const viaModelAware = resolveGeometryZToFramesModelAware(
        4, regularGeo(), regularSetup, [regularGeo()], sceneStockNoPad, [regularStock],
      )
      // regularSetup.wcs.origin.z (10) is used verbatim - the model-aware
      // wrapper never substitutes an "effective" WCS baseline for a
      // non-model geo, since applyAutoStockToSetups already keeps a REAL
      // stock's corner-pinned origin.z correct (no staleness to correct).
      expect(viaModelAware.wcsZ).toBeCloseTo(4 + regularGeo().position.z - regularSetup.wcs.origin.z, 9)
    })
  })
})
