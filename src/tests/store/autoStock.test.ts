// H1 commit B (docs/planning/HEIGHTS-AUDIT-AND-PLAN.md, rule R4 "stock
// follows reality"): the AUTO stock derives its Z span from the combined
// geometry bounds (base = min Z, top = max Z + zTop allowance) instead of a
// base hardcoded to the table, and corner-pinned WCS re-derive whenever the
// derived auto bounds change - fixing two user-confirmed bugs:
//   H0  - geometry moved up in Z under auto stock left the stock base at z=0
//         and stranded the corner-pinned work zero at the old stock top.
//   B10 - adding a taller model grew the auto stock but the WCS stayed put
//         until the user re-picked the setup corner.
//
// Two layers of coverage (dispatchHeights.test.ts style):
//   1. Pure helpers: deriveAutoStockBounds / geometryWorldBounds / resolveTopZ
//      auto-mode branch.
//   2. Store integration: the REAL store actions (updateGeometryTransform,
//      addGeometry, updateSceneStock) re-derive corner-pinned WCS and outdate
//      dependent ready ops; fixed stock and vertex-snapped WCS are untouched.

import { describe, it, expect } from 'vitest'
import {
  deriveAutoStockBounds, geometryWorldBounds, resolveTopZ,
} from '../../store/dispatchGeo'
import { useCamStore } from '../../store'
import type {
  ImportedGeometry, SceneStock, FixedStockItem, Setup, Operation,
  HeightParams, PassParams, LinkingParams, Loop2D, WCS,
} from '../../types'

// -- Shared fixtures -----------------------------------------------------------
// World picture (auto mode): one 50x50x10 mesh centered on the origin sitting
// on the table. autoOffsetXY 2 / autoOffsetZTop 1 derive the stock box
// min(-27,-27,0) .. max(27,27,11). Front-left-top corner = (-27,-27,11).

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

// A READY op that does NOT reference the moved geometry, so any 'outdated'
// flip in these tests comes from the WCS re-derivation alone (outdateOps),
// never from outdateOpsReferencingGeo.
function makeReadyOp(): Operation {
  return {
    id: 'op-1', name: 'Op', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    heights: makeHeights(), passes, linking,
    params: { geometryId: 'geo-unrelated', loopIds: [] },
    toolpathMoves: [],
  }
}

function makeCornerWcs(origin: { x: number; y: number; z: number }): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin,
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    cornerRow: 2, cornerCol: 0, cornerFace: 'top',   // front-left, top face
  }
}

// AUTO-STOCK-BOTTOM: a WCS pinned to the BOTTOM face re-derives origin.z from
// bounds.min.z, so editing autoOffsetZBottom shifts the work zero down by the
// allowance (the flip / backside-machining origin).
function makeCornerWcsBottom(origin: { x: number; y: number; z: number }): WCS {
  return {
    ...makeCornerWcs(origin),
    cornerFace: 'bottom',   // front-left, bottom face -> origin.z = bounds.min.z
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

function installScene(parts: {
  geometry: ImportedGeometry[]
  sceneStock: SceneStock
  setups: Setup[]
}): void {
  useCamStore.setState(s => ({
    project: { ...s.project, ...parts },
  }))
}

const state = () => useCamStore.getState()
const wcsAfter = () => state().project.setups[0].wcs
const opAfter = () => state().project.setups[0].operations[0]

// -- 1. Pure helpers -----------------------------------------------------------

describe('deriveAutoStockBounds', () => {
  it('3D mesh: base follows geometry min Z, top = max Z + zTop, XY padded', () => {
    const b = deriveAutoStockBounds([makeMeshGeo()], makeAutoSceneStock())!
    expect(b.min).toEqual({ x: -27, y: -27, z: 0 })
    expect(b.max).toEqual({ x: 27, y: 27, z: 11 })
  })

  it('raised geometry raises the BASE with it (H0: never a thicker block from z=0)', () => {
    const b = deriveAutoStockBounds(
      [makeMeshGeo({ position: { x: 0, y: 0, z: 5 } })], makeAutoSceneStock())!
    expect(b.min.z).toBeCloseTo(5, 9)
    expect(b.max.z).toBeCloseTo(16, 9)
  })

  it('pure-2D all-z0 scene: stock top = zTop above the plane, NO render-lift leak', () => {
    // The 0.3mm Z2D render lift must NOT enter the logical stock top (Operator
    // 2026-06-13): a flat DXF on z=0 with zTop=5 gives top EXACTLY 5, so the
    // WCS on the top corner is 5.0 and a Geometry+0 bottom is -5.0.
    const b = deriveAutoStockBounds([make2DGeo()], makeAutoSceneStock())!
    expect(b.min).toEqual({ x: -OFF_XY, y: -OFF_XY, z: 0 })
    expect(b.max.x).toBeCloseTo(10 + OFF_XY, 9)
    expect(b.max.y).toBeCloseTo(10 + OFF_XY, 9)
    expect(b.max.z).toBeCloseTo(Z_TOP, 9)
  })

  it('returns null in fixed mode and when no geometry contributes bounds', () => {
    expect(deriveAutoStockBounds([makeMeshGeo()], makeAutoSceneStock({ mode: 'fixed' }))).toBeNull()
    expect(deriveAutoStockBounds([], makeAutoSceneStock())).toBeNull()
    // Sketch container with no baked loops + legacy STL with a zero bbox: skipped
    expect(deriveAutoStockBounds([
      make2DGeo({ loops: [] }),
      makeMeshGeo({ boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
        size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
      } }),
    ], makeAutoSceneStock())).toBeNull()
  })

  // -- AUTO-STOCK-BOTTOM: explicit bottom allowance for flip / backside machining
  it('positive autoOffsetZBottom extends ONLY min.z downward (top unchanged)', () => {
    const b = deriveAutoStockBounds([makeMeshGeo()], makeAutoSceneStock({ autoOffsetZBottom: 5 }))!
    expect(b.min).toEqual({ x: -27, y: -27, z: -5 }) // geometry min 0 minus 5mm allowance
    expect(b.max).toEqual({ x: 27, y: 27, z: 11 })  // top unchanged (max Z 10 + Z_TOP 1)
  })

  it('zero / missing autoOffsetZBottom preserves the prior base === min Z behavior', () => {
    // Explicit zero: byte-identical to HEAD (no bottom pad).
    const b0 = deriveAutoStockBounds([makeMeshGeo()], makeAutoSceneStock({ autoOffsetZBottom: 0 }))!
    expect(b0.min.z).toBe(0)
    expect(b0.max.z).toBe(11)
    // Omitted (undefined): the back-compat path old projects take; ?? 0 -> same.
    const bUndef = deriveAutoStockBounds([makeMeshGeo()], makeAutoSceneStock())!
    expect(bUndef.min.z).toBe(0)
    expect(bUndef.max.z).toBe(11)
  })

  it('raised geometry + bottom allowance: base follows the raised min Z then pads down (AT6)', () => {
    const b = deriveAutoStockBounds(
      [makeMeshGeo({ position: { x: 0, y: 0, z: 10 } })],
      makeAutoSceneStock({ autoOffsetZBottom: 3 }),
    )!
    expect(b.min.z).toBeCloseTo(7, 9)  // raised min 10 minus 3mm bottom allowance
    expect(b.max.z).toBeCloseTo(21, 9) // raised max 20 plus Z_TOP 1
  })
})

describe('geometryWorldBounds', () => {
  it('mesh: rotates the local bbox corners (exact for 90-degree Z rotations)', () => {
    const geo = makeMeshGeo({
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 20, z: 10 },
        size: { x: 50, y: 20, z: 10 }, center: { x: 25, y: 10, z: 5 },
      },
      rotation: { x: 0, y: 0, z: 90 },
    })
    const b = geometryWorldBounds(geo)!
    // (x,y) -> (-y,x): x span 0..50 -> y 0..50; y span 0..20 -> x -20..0
    expect(b.min.x).toBeCloseTo(-20, 9)
    expect(b.max.x).toBeCloseTo(0, 9)
    expect(b.min.y).toBeCloseTo(0, 9)
    expect(b.max.y).toBeCloseTo(50, 9)
    expect(b.min.z).toBeCloseTo(0, 9)
    expect(b.max.z).toBeCloseTo(10, 9)
  })

  it('2D: tight XY from transformed loop points, flat AT position.z (no render lift)', () => {
    const b = geometryWorldBounds(make2DGeo({ position: { x: 5, y: 0, z: 2 } }))!
    expect(b.min).toEqual({ x: 5, y: 0, z: 2 })
    expect(b.max.x).toBeCloseTo(15, 9)
    expect(b.max.z).toBeCloseTo(2, 9)   // flat on its plane; Z2D lift is render-only
  })
})

describe('resolveTopZ auto-stock branch', () => {
  // Leftover fixedStocks in project data must NOT be read in auto mode (they
  // are not displayed); the derived auto box is the reference.
  const leftoverFixed: FixedStockItem = {
    id: 'stock-old', name: 'Old', width: 100, height: 100, depth: 99,
    position: { x: 0, y: 0, z: 0 },
  }
  const sceneStock = makeAutoSceneStock({ fixedStocks: [leftoverFixed] })
  const geo = makeMeshGeo()
  const setup = makeSetup(makeCornerWcs({ x: -27, y: -27, z: 11 }), [])

  it('stock_top reads the derived auto top (WCS-relative), not fixedStocks', () => {
    // Derived top world 11, WCS z 11 -> 0; offset -1.5 rides through.
    expect(resolveTopZ('stock_top', 0, setup, sceneStock, [geo], 'geo-1')).toBeCloseTo(0, 9)
    expect(resolveTopZ('stock_top', -1.5, setup, sceneStock, [geo], 'geo-1')).toBeCloseTo(-1.5, 9)
  })

  it('stock_bottom reads the derived auto base', () => {
    // Base world 0, WCS z 11 -> -11.
    expect(resolveTopZ('stock_bottom', 0, setup, sceneStock, [geo], 'geo-1')).toBeCloseTo(-11, 9)
  })

  it('falls back to the WCS plane when no geometry contributes bounds', () => {
    expect(resolveTopZ('stock_top', 2, setup, sceneStock, [], 'geo-1')).toBeCloseTo(2, 9)
  })

  it('Operator ruling 2026-06-13: flat 2D on z=0, WCS on the 5mm auto top -> Geometry+0 bottom = -5.0', () => {
    const sStock = makeAutoSceneStock()              // zTop = Z_TOP (5)
    const geo2d  = make2DGeo()                        // flat loops on z=0
    const top    = deriveAutoStockBounds([geo2d], sStock)!.max.z
    expect(top).toBeCloseTo(Z_TOP, 9)                 // 5.0, NOT 5.3 (no render-lift leak)
    const s = makeSetup(makeCornerWcs({ x: -OFF_XY, y: -OFF_XY, z: top }), [])
    // "Geometry" reference + 0 offset = the lines' plane (machine 0) expressed
    // relative to the WCS on the stock top = exactly -5.0. Everything relative
    // to the WCS, no 0.3 contamination.
    expect(resolveTopZ('geometry_face', 0, s, sStock, [geo2d], 'geo-2d')).toBeCloseTo(-Z_TOP, 9)
  })
})

// -- 2. Store integration ------------------------------------------------------

describe('auto-stock WCS re-derivation (store actions)', () => {
  it('H0: gizmo Z move re-derives the corner-pinned WCS and outdates ready ops', () => {
    installScene({
      geometry: [makeMeshGeo()],
      sceneStock: makeAutoSceneStock(),
      setups: [makeSetup(makeCornerWcs({ x: -27, y: -27, z: 11 }), [makeReadyOp()])],
    })
    state().updateGeometryTransform('geo-1', { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 })

    // Stock base follows to z=5 (store-derived), top to 16; corner WCS follows.
    const b = deriveAutoStockBounds(state().project.geometry, state().project.sceneStock)!
    expect(b.min.z).toBeCloseTo(5, 9)
    expect(wcsAfter().origin).toEqual({ x: -27, y: -27, z: 16 })
    expect(opAfter().status).toBe('outdated')
    expect(opAfter().toolpathMoves).toBeUndefined()
  })

  it('B10: adding a taller model grows the stock AND moves the WCS - no corner re-pick', () => {
    installScene({
      geometry: [makeMeshGeo()],
      sceneStock: makeAutoSceneStock(),
      setups: [makeSetup(makeCornerWcs({ x: -27, y: -27, z: 11 }), [makeReadyOp()])],
    })
    state().addGeometry(makeMeshGeo({
      id: 'geo-tall',
      boundingBox: {
        min: { x: -10, y: -10, z: 0 }, max: { x: 10, y: 10, z: 25 },
        size: { x: 20, y: 20, z: 25 }, center: { x: 0, y: 0, z: 12.5 },
      },
    }))

    const b = deriveAutoStockBounds(state().project.geometry, state().project.sceneStock)!
    expect(b.max.z).toBeCloseTo(26, 9)
    expect(wcsAfter().origin.z).toBeCloseTo(26, 9)
    expect(wcsAfter().origin.x).toBeCloseTo(-27, 9)
    expect(opAfter().status).toBe('outdated')
  })

  it('pure-2D guard: an XY-only move keeps base z 0 / top = zTop, WCS follows in XY only', () => {
    installScene({
      geometry: [make2DGeo()],
      sceneStock: makeAutoSceneStock(),
      setups: [makeSetup(
        makeCornerWcs({ x: -OFF_XY, y: -OFF_XY, z: Z_TOP }),
        [makeReadyOp()],
      )],
    })
    state().updateGeometryTransform('geo-2d', { x: 3, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })

    const b = deriveAutoStockBounds(state().project.geometry, state().project.sceneStock)!
    expect(b.min.z).toBe(0)                          // base stays on the table
    expect(b.max.z).toBeCloseTo(Z_TOP, 9)            // top = zTop, no render-lift leak
    expect(wcsAfter().origin.x).toBeCloseTo(3 - OFF_XY, 9)   // corner follows in X
    expect(wcsAfter().origin.z).toBeCloseTo(Z_TOP, 9)
  })

  it('updateSceneStock: raising autoOffsetZTop moves the top-face WCS', () => {
    installScene({
      geometry: [makeMeshGeo()],
      sceneStock: makeAutoSceneStock(),
      setups: [makeSetup(makeCornerWcs({ x: -27, y: -27, z: 11 }), [makeReadyOp()])],
    })
    state().updateSceneStock({ autoOffsetZTop: 3 })
    expect(wcsAfter().origin.z).toBeCloseTo(13, 9)
    expect(opAfter().status).toBe('outdated')
  })

  it('AUTO-STOCK-BOTTOM: raising autoOffsetZBottom shifts the BOTTOM-face WCS down by the allowance (AT5)', () => {
    // Default box (-27,-27,0)..(27,27,11); bottom front-left corner = (-27,-27,0).
    installScene({
      geometry: [makeMeshGeo()],
      sceneStock: makeAutoSceneStock(),
      setups: [makeSetup(makeCornerWcsBottom({ x: -27, y: -27, z: 0 }), [makeReadyOp()])],
    })
    expect(wcsAfter().origin.z).toBeCloseTo(0, 9) // baseline: no bottom allowance
    state().updateSceneStock({ autoOffsetZBottom: 5 })
    // Base extends to z=-5, so the bottom-face work zero follows down by 5mm.
    expect(wcsAfter().origin.z).toBeCloseTo(-5, 9)
    expect(wcsAfter().origin.x).toBeCloseTo(-27, 9) // XY corner unchanged
    expect(wcsAfter().origin.y).toBeCloseTo(-27, 9)
    expect(opAfter().status).toBe('outdated')
  })

  it('Operator ruling 2026-06-13: switching to FIXED mode re-derives the corner-pinned WCS to the fixed-stock corner', () => {
    const fixed: FixedStockItem = {
      id: 'fs-1', name: 'Stock 1', width: 100, height: 80, depth: 12,
      position: { x: 10, y: 20, z: 0 },
    }
    installScene({
      geometry: [makeMeshGeo()],
      // Start in AUTO with the WCS pinned to the auto corner (-27,-27,11).
      sceneStock: makeAutoSceneStock({ fixedStocks: [fixed] }),
      setups: [makeSetup(makeCornerWcs({ x: -27, y: -27, z: 11 }), [makeReadyOp()])],
    })
    state().updateSceneStock({ mode: 'fixed' })
    // Front-left (row 2 / col 0), top face of the fixed box
    // (10,20,0)..(110,100,12) = (10, 20, 12). Before the fix the auto applier
    // was a no-op in fixed mode and the WCS stayed at (-27,-27,11).
    expect(wcsAfter().origin.x).toBeCloseTo(10, 9)
    expect(wcsAfter().origin.y).toBeCloseTo(20, 9)
    expect(wcsAfter().origin.z).toBeCloseTo(12, 9)
  })

  it('fixed stock is untouched by geometry moves (no WCS churn, op stays ready)', () => {
    const stock: FixedStockItem = {
      id: 'stock-1', name: 'Stock', width: 100, height: 100, depth: 12,
      position: { x: 0, y: 0, z: 0 },
    }
    const wcs: WCS = { ...makeCornerWcs({ x: 0, y: 0, z: 12 }), stockId: 'stock-1' }
    installScene({
      geometry: [makeMeshGeo()],
      sceneStock: makeAutoSceneStock({ mode: 'fixed', fixedStocks: [stock] }),
      setups: [makeSetup(wcs, [makeReadyOp()])],
    })
    state().updateGeometryTransform('geo-1', { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 })

    expect(wcsAfter().origin).toEqual({ x: 0, y: 0, z: 12 })
    expect(opAfter().status).toBe('ready')
  })

  it('vertex-snapped WCS keeps its snap behavior (never corner re-derived)', () => {
    const snapWcs: WCS = {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54,
      origin: { x: 10, y: 10, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      snapGeoId: 'geo-1', snapLocalPt: { x: 10, y: 10, z: 0 },
    }
    installScene({
      geometry: [makeMeshGeo()],
      sceneStock: makeAutoSceneStock(),
      setups: [makeSetup(snapWcs, [makeReadyOp()])],
    })
    state().updateGeometryTransform('geo-1', { x: 0, y: 0, z: 5 }, { x: 0, y: 0, z: 0 })

    // applyGeoSnapToSetups (existing mechanism) tracks the vertex: z follows
    // the geometry, XY stays the local vertex - NOT the stock corner.
    expect(wcsAfter().origin).toEqual({ x: 10, y: 10, z: 5 })
  })
})
