// B11 (docs/planning/POST-MERGE-WORKPLAN.md): hand-typing a Z value in the
// properties panel + Enter LOOKED committed - the displayed value (store
// position) changed and the store-derived auto stock reacted - but the ACTUAL
// part dropped to the workspace floor. Root cause: CNCViewport.setPartTransform
// clamped the THREE group Z to 0 for 2D geometry ("is2D ? 0 : position.z"),
// and add2DGeometry re-clamped Z on every scene rebuild (undo / project open).
// The gizmo path never clamps (it moves the group directly), so the two input
// paths disagreed: display said 10, actual was 0.
//
// These tests drive the REAL user path:
//   - the panel's exported commit handler commitTransformAxis - the exact
//     function the X/Y/Z inputs call on Enter/blur, and
//   - the REAL CNCViewport.setPartTransform / add2DGeometry methods, bound to
//     a minimal viewport instance holding real THREE groups (the full class
//     needs WebGL; the methods under test only need the group maps).
// Display (store) and actual (group) are asserted EQUAL - the bug was
// display-says-10 / actual-0, so divergence is exactly what must fail here.

import * as THREE from 'three'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { useCamStore } from '../../store'
import { commitTransformAxis } from '../../components/panels/PropertiesPanel'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { deriveAutoStockBounds } from '../../store/dispatchGeo'
import type {
  ImportedGeometry, SceneStock, Setup, Operation, WCS,
  HeightParams, PassParams, LinkingParams, Loop2D,
} from '../../types'

// -- Minimal real-method viewport ------------------------------------------------
// Object.create(CNCViewport.prototype) + the private fields the methods under
// test touch. setPartTransform / add2DGeometry / remove2DGeometry execute the
// REAL production code against real THREE.Group instances; the render-only
// collaborators (rebuildStock, camera fit, selectables) are no-op stubs.

// Structural handle for the methods/fields the tests touch (intersecting with
// CNCViewport itself collapses to never - partGroups is private there).
interface VpUnderTest {
  setPartTransform: CNCViewport['setPartTransform']
  add2DGeometry: CNCViewport['add2DGeometry']
  geometry2dGroups: Map<string, THREE.Group>
  partGroups: Map<string, THREE.Group>
}

function makeVp(): VpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    partGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(),
    sketchEditLayerId: null,
    selectedPartId: null,
    workpieceGroup: new THREE.Group(),
    rebuildStock: () => {},
    updateSelectableObjects: () => {},
    fitCameraToObject: () => {},
  })
  return vp as VpUnderTest
}

// -- Store fixtures (autoStock.test.ts conventions) -------------------------------

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

function makeMeshGeo(over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'geo-3d', name: 'Part', filename: 'part.stl', type: 'mesh', format: 'stl',
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

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

const heights: HeightParams = {
  clearanceHeight: 30, clearanceHeightMode: 'absolute',
  retractHeight: 20, feedHeight: 15,
  topHeight: 0, topHeightMode: 'stock_top',
  bottomHeight: -3, bottomHeightMode: 'absolute',
}
const passes: PassParams = {
  stepdown: 2, stepover: 1.6, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 10,
  leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
}

// A READY op directly referencing the moved geometry: the panel input path
// must mark it outdated, exactly like the gizmo path does.
function makeReadyOpOn(geoId: string): Operation {
  return {
    id: 'op-1', name: 'Op', type: 'contour_2d', enabled: true, status: 'ready',
    toolId: 'tool-1', geometrySelections: [],
    heights, passes, linking,
    params: { geometryId: geoId, loopIds: [] },
    toolpathMoves: [],
  }
}

function makeSetup(operations: Operation[]): Setup {
  const wcs: WCS = {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
  }
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

function installScene(geometry: ImportedGeometry[], operations: Operation[] = []): void {
  useCamStore.setState(s => ({
    project: {
      ...s.project,
      geometry,
      sceneStock: autoStock,
      setups: [makeSetup(operations)],
    },
    projectHistory: [],
    sketchHistory: [],
    canUndo: false,
  }))
}

const state = () => useCamStore.getState()
const storeGeo = (id: string) => state().project.geometry.find(g => g.id === id)!

describe('B11: typed Z in the properties panel moves the ACTUAL part', () => {
  let vp: ReturnType<typeof makeVp>

  beforeEach(() => {
    vp = makeVp()
    // The panel commit handler reaches the viewport through the same global
    // handle the app uses (window.__cncViewport).
    vi.stubGlobal('window', { __cncViewport: vp })
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('2D part: store z, viewport group z, and auto-stock base ALL move (display === actual)', () => {
    const geo = make2DGeo()
    installScene([geo], [makeReadyOpOn(geo.id)])
    const group = new THREE.Group()                    // 2D part group on the table
    vp.geometry2dGroups.set(geo.id, group)

    // User types "10" into the Z input and presses Enter -> TransformInput
    // parses and calls the panel commit handler for the Z axis.
    commitTransformAxis(storeGeo(geo.id), 'position', 'z', 10)

    // Display source (the panel reads geo.position.z from the store)...
    expect(storeGeo(geo.id).position.z).toBe(10)
    // ...and the ACTUAL rendered part. Before the fix the group stayed at 0.
    expect(group.position.z).toBe(10)
    // The catcher for this bug class: display and actual must never diverge.
    expect(group.position.z).toBe(storeGeo(geo.id).position.z)

    // Derived auto-stock base follows the part up (H1 R4 "stock follows reality").
    const b = deriveAutoStockBounds(state().project.geometry, state().project.sceneStock)!
    expect(b.min.z).toBeCloseTo(10, 9)

    // The ready op referencing this geometry goes outdated on the PANEL path
    // (it already did on the gizmo path).
    expect(state().project.setups[0].operations[0].status).toBe('outdated')
    expect(state().project.setups[0].operations[0].toolpathMoves).toBeUndefined()
  })

  it('3D part: typed Z passes through unchanged (no regression on the mesh path)', () => {
    const geo = makeMeshGeo()
    installScene([geo])
    const group = new THREE.Group()
    vp.partGroups.set(geo.id, group)

    commitTransformAxis(storeGeo(geo.id), 'position', 'z', 7.5)

    expect(storeGeo(geo.id).position.z).toBe(7.5)
    expect(group.position.z).toBe(7.5)
  })

  it('typed X/Y keep the existing Z (axis commit only changes its own axis)', () => {
    const geo = make2DGeo({ position: { x: 0, y: 0, z: 4 } })
    installScene([geo])
    const group = new THREE.Group()
    group.position.set(0, 0, 4)
    vp.geometry2dGroups.set(geo.id, group)

    commitTransformAxis(storeGeo(geo.id), 'position', 'x', 3)

    expect(storeGeo(geo.id).position).toEqual({ x: 3, y: 0, z: 4 })
    expect(group.position.z).toBe(4)
  })

  it('scene rebuild (add2DGeometry: undo / project open path) keeps the stored Z', () => {
    // After an undo or a project open, Viewport re-adds 2D geometry from the
    // store via add2DGeometry(geo.position). The old clamp re-dropped the
    // part to the floor here even when the store said z=10.
    vp.add2DGeometry(
      'geo-2d',
      [{ id: 'loop-1', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true, layerId: 'L1' }],
      [{ id: 'L1', color: '#00e5ff', visible: true }],
      { x: 1, y: 2, z: 10 },
      { x: 0, y: 0, z: 0 },
    )
    const group = vp.geometry2dGroups.get('geo-2d')!
    expect(group.position.z).toBe(10)
    expect(group.position.x).toBe(1)
    expect(group.position.y).toBe(2)
  })
})
