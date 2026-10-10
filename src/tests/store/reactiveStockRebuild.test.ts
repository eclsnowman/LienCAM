// FIX A+B (stock-model refactor aftermath): addGeometry updates the store's
// project.geometry / stocks / sceneStock but never called the viewport's
// rebuildStock, and NO React effect watched those slices - so the FIRST
// imported part's auto-stock box did not appear until a LATER stock action
// forced a rebuild (via a DesignTree handler), and moving a stock-tied part did
// not live-refresh the box.
//
// The fix adds a reactive useEffect in the React Viewport COMPONENT
// (src/components/viewport/Viewport.tsx) keyed on a stable primitive derived
// from project.stocks + sceneStock + geometry; on change it calls
// viewportRef.current.rebuildStock(project.sceneStock).
//
// HEADLESS LIMITATION: the real CNCViewport constructor (used by Viewport.tsx
// on mount) needs WebGL + a DOM canvas, so the React Viewport component cannot
// be mounted under jsdom - the reactive effect itself cannot be executed in a
// headless test (same constraint documented in projectOpen.test.ts, which also
// drives a fake VP rather than mounting Viewport.tsx). This is therefore a
// STORE-PATH test (projectOpen pattern): it proves the data contract the
// reactive effect depends on - that addGeometry / a part MOVE leave the store's
// sceneStock in a state which, when handed to rebuildStock (the exact call the
// effect makes), renders a correctly-sized stock box. The effect's hook
// placement (above any early return, coexisting with the mount/undo rebuild
// effects) is verified by review per feedback_render_gate_ui_changes.

import * as THREE from 'three'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { useCamStore } from '../../store'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { ReloadableViewport } from '../../lib/viewport/restoreScene'
import type { ImportedGeometry, SceneStock } from '../../types'

interface VpUnderTest extends ReloadableViewport {
  stockGroup: THREE.Group
  rebuildCalls: number
}

// Minimal real-method viewport: rebuildStock runs production code against a real
// THREE group; a counter records how many times the (effect-equivalent) call
// fired. (Mirrors projectOpen.test.ts makeVp.)
function makeVp(): VpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    partGroups: new Map<string, THREE.Group>(),
    // rebuildStock now ends with applyShadingMode(), which iterates these (the
    // real CNCViewport inits them as class fields; the stub must mirror that).
    partMaterials: new Map(),
    materialBaselines: new Map(),
    currentShadingMode: 'shaded-edges',
    fixedStockBoxes: new Map<string, THREE.Group>(),
    // rebuildStock now calls updateSelectableObjects (stock boxes became
    // viewport-pickable); that method also traverses these group maps + the
    // selectable array, so the fake must mirror the real constructor's inits.
    geometry2dGroups: new Map<string, THREE.Group>(),
    _worldPlaneLoopGroups: new Map<string, THREE.Group>(),
    _geoLocalLoopGroups: new Map<string, THREE.Group>(),
    // updateSelectableObjects now also traverses nestGroups to make seed-slot
    // loop lines pickable (P6 Item B), so the fake must mirror that init too.
    nestGroups: new Map<string, THREE.Group>(),
    selectableObjects: [],
    _stockBounds: null,
    wcsFixed: false,
    workpieceGroup: new THREE.Group(),
    stockGroup: new THREE.Group(),
    toolpathGroup: new THREE.Group(),
    wcsGroup: new THREE.Group(),
    currentStockConfig: {
      mode: 'auto', autoOffsetXY: 5, autoOffsetZTop: 5,
      fixedWidth: 100, fixedHeight: 100, fixedDepth: 50, fixedStocks: [],
    },
    colors: {
      stock: 0x556677, stockEdge: 0x8899aa,
      workpiece: 0x999999, workpieceEdge: 0xcccccc,
      xAxis: 0xff0000, yAxis: 0x00ff00, zAxis: 0x0000ff, wcsOrigin: 0xffd700,
    },
    rebuildCalls: 0,
    // B14: `act_newProject()` now drives the REAL clearScene() (newProject()
    // reaches the viewport through reloadProjectScene, projectOpen.test.ts
    // pattern) - clearScene() touches these collaborators unconditionally
    // (exitLayOnFaceMode/exitSlicePlaneMode reach `this.renderer`, which this
    // headless stub has none of), so they need the same no-op/empty-collection
    // stubs projectOpen.test.ts's makeVp() already carries for the identical
    // reason.
    projectedLoopGroups: new Map<string, THREE.Group>(),
    geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(),
    pickedBrepKeys: new Set<string>(),
    brepHighlights: new Map(),
    brepHoverKey: null,
    brepHoverObj: null,
    selectedPartId: null,
    sketchEditLayerId: null,
    transformControls: { detach: () => {} },
    updateSelectableObjects: () => {},
    fitCameraToObject: () => {},
    exitLayOnFaceMode: () => {},
    exitSlicePlaneMode: () => {},
    exitWCSGizmoMode: () => {},
    exitStockGizmoMode: () => {},
    exitVertexPickMode: () => {},
    clear2DGizmoProxy: () => {},
  })
  // Wrap rebuildStock to count effect-equivalent calls while still running the
  // real method body.
  const realRebuild = CNCViewport.prototype.rebuildStock as (s: SceneStock) => void
  vp.rebuildStock = function (this: VpUnderTest, s: SceneStock) {
    this.rebuildCalls++
    realRebuild.call(this, s)
  }
  return vp as VpUnderTest
}

function makeStlGeo(id: string, max: number, pos = { x: 0, y: 0, z: 0 }): ImportedGeometry {
  return {
    id, name: id, filename: `${id}.stl`, type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: max, y: max, z: max },
      size: { x: max, y: max, z: max }, center: { x: max / 2, y: max / 2, z: max / 2 },
    },
    position: pos, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}

const state = () => useCamStore.getState()
const stockBox = (vp: VpUnderTest) => new THREE.Box3().setFromObject(vp.stockGroup)

// Drive what the reactive Viewport effect does on a store change: hand the
// CURRENT project.sceneStock to the viewport handle's rebuildStock.
function fireReactiveRebuild(vp: VpUnderTest) {
  vp.rebuildStock(state().project.sceneStock)
}

describe('FIX A+B: a geometry import/move leaves sceneStock ready to rebuild a sized stock box', () => {
  let vp: VpUnderTest

  beforeEach(() => {
    vp = makeVp()
    vi.stubGlobal('window', { __cncViewport: vp })
    act_newProject()
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  function act_newProject() {
    state().newProject()
  }

  it('importing the FIRST part makes the default auto stock derive a non-empty box on rebuild', () => {
    // Before any geometry: the default auto stock is zero-volume (no members),
    // so a rebuild produces no stock box.
    fireReactiveRebuild(vp)
    expect(vp.stockGroup.children.length).toBe(0)

    // Import the first part (the bug: this used to leave the box invisible until
    // a later stock action).
    state().addGeometry(makeStlGeo('geo-1', 10))

    // The effect-equivalent rebuild now renders a sized box from the member +
    // default offsets - the data the reactive effect feeds rebuildStock.
    fireReactiveRebuild(vp)
    expect(vp.stockGroup.children.length).toBeGreaterThan(0)
    const sb = stockBox(vp)
    expect(sb.max.x - sb.min.x).toBeGreaterThan(10)  // grew past the 10mm part (offsets)
  })

  it('moving a stock-tied part re-wraps the stock box (live refresh data path)', () => {
    state().addGeometry(makeStlGeo('geo-move', 10, { x: 0, y: 0, z: 0 }))
    fireReactiveRebuild(vp)
    const before = stockBox(vp)

    // Move the part +50 in X (PropertiesPanel / gizmo path).
    state().updateGeometryTransform('geo-move', { x: 50, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    fireReactiveRebuild(vp)
    const after = stockBox(vp)

    // The wrapped stock box followed the part (its max.x shifted right).
    expect(after.max.x).toBeGreaterThan(before.max.x + 40)
  })
})
