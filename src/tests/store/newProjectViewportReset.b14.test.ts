// B14 (docs/planning/POST-MERGE-WORKPLAN.md, found 2026-07-23 by the
// UI-BRAND-AFTERSET capture lane): the 3D viewport kept rendering the
// PREVIOUS project's mesh after File > New Project. newProject() reset the
// store correctly (project.geometry/setups empty) but never touched the
// viewport itself -- the only reset path was TopToolbar's onClick handler
// manually calling `window.__cncViewport.clearScene()` as a BOLTED-ON side
// effect immediately after `newProject()`. Any OTHER caller of newProject()
// (a test, a script, a future keyboard shortcut) skipped that side effect
// and left the old mesh drawn in workpieceGroup while every store-derived
// panel already reported an empty project -- reproduced via
// `window.__camStore.getState().newProject()` directly in
// coordination/reports/UI-BRAND-AFTERSET.report.md (workpieceGroup.children
// stayed 1 while project.geometry.length was 0).
//
// Fix: newProject() now drives the viewport itself, through the SAME
// reloadProjectScene() seam loadProjectFromFile() already uses (see
// projectOpen.test.ts) -- the shared full-store-reset reload primitive,
// reached via the same window.__cncViewport handle. This test drives the
// REAL store action (newProject(), with NO manual vp.clearScene() call
// alongside it -- that is precisely the fragile pattern being removed) and
// asserts the viewport ends up clean. It fails on the pre-fix code (the old
// newProject() had zero viewport-reset code) and passes on the fix.

import * as THREE from 'three'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { useCamStore } from '../../store'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import type { ReloadableViewport } from '../../lib/viewport/restoreScene'
import type { ImportedGeometry, SceneStock } from '../../types'

// Minimal real-method viewport (typedZTransform.test.ts / projectOpen.test.ts
// pattern): Object.create(CNCViewport.prototype) + the private fields the
// REAL clearScene()/rebuildStock() touch, with no-op stubs for the
// renderer/DOM-bound collaborators.
interface VpUnderTest extends ReloadableViewport {
  workpieceGroup: THREE.Group
  stockGroup: THREE.Group
  geometry2dGroups: Map<string, THREE.Group>
  partGroups: Map<string, THREE.Group>
}

function makeVp(): VpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    partGroups: new Map<string, THREE.Group>(),
    partMaterials: new Map<string, unknown>(),
    materialBaselines: new Map(),
    currentShadingMode: 'shaded-edges',
    projectedLoopGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(),
    nestGroups: new Map<string, THREE.Group>(),
    fixedStockBoxes: new Map<string, THREE.Group>(),
    pickedBrepKeys: new Set<string>(),
    brepHighlights: new Map(),
    brepHoverKey: null,
    brepHoverObj: null,
    selectedPartId: null,
    selectableObjects: [],
    sketchEditLayerId: null,
    wcsFixed: false,
    _stockBounds: null,
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
    transformControls: { detach: () => {} },
    updateSelectableObjects: () => {},
    fitCameraToObject: () => {},
    exitLayOnFaceMode: () => {},
    exitSlicePlaneMode: () => {},
    exitWCSGizmoMode: () => {},
    exitStockGizmoMode: () => {},
    exitVertexPickMode: () => {},
  })
  return vp as VpUnderTest
}

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

function makeStlGeo(): ImportedGeometry {
  return {
    id: 'geo-stl', name: 'Body', filename: 'body.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
  }
}

const state = () => useCamStore.getState()

describe('B14: File > New Project clears the 3D viewport (workpieceGroup), not just the store', () => {
  let vp: VpUnderTest

  beforeEach(() => {
    vp = makeVp()
    // The store action reaches the viewport through the same global handle
    // the app publishes it on (window.__cncViewport, Viewport.tsx) and
    // loadProjectFromFile already reads (projectOpen.test.ts).
    vi.stubGlobal('window', { __cncViewport: vp })
    vi.stubGlobal('alert', vi.fn())

    // Simulate a loaded project (like a loaded example project): a real part group
    // registered in BOTH partGroups (the tracked map clearScene() sweeps)
    // and workpieceGroup.children (the scene graph the user actually sees) --
    // exactly the "project loaded" state the bug's repro starts from.
    const staleGroup = new THREE.Group()
    staleGroup.name = 'geo-stl'
    vp.partGroups.set('geo-stl', staleGroup)
    vp.workpieceGroup.add(staleGroup)
    // A stock box too, so the regression covers "old stock stays drawn"
    // exactly as much as "old part stays drawn".
    vp.stockGroup.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1)))

    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [makeStlGeo()],
        setups: [],
        sceneStock: autoStock,
      },
      projectHistory: [], sketchHistory: [], canUndo: false,
    }))
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('newProject() ALONE (no manual vp.clearScene() alongside it) empties workpieceGroup', () => {
    expect(vp.workpieceGroup.children.length).toBe(1)   // sanity: stale mesh present pre-call

    // THE call under test. Deliberately just this one call -- no
    // vp.clearScene() companion call, unlike the old TopToolbar pattern.
    // That companion call is exactly what a caller OTHER than the New
    // button (a script, a test, a keyboard shortcut) would never remember
    // to make, which is the bug.
    state().newProject()

    expect(state().project.geometry.length).toBe(0)      // store reset (was already true pre-fix)
    expect(vp.workpieceGroup.children.length).toBe(0)     // THE regression: viewport must follow
    expect(vp.partGroups.size).toBe(0)
  })

  it('newProject() also clears stale stock geometry from the SAME reload', () => {
    expect(vp.stockGroup.children.length).toBeGreaterThan(0)
    state().newProject()
    // clearScene() empties stockGroup; a fresh default project has no
    // fixed stocks and (with no geometry) nothing for auto-stock to derive
    // from, so rebuildStock() leaves it empty rather than redrawing the
    // OLD project's box.
    expect(vp.stockGroup.children.length).toBe(0)
  })

  it('newProject() still performs the full store reset it always did (no regression the other way)', () => {
    useCamStore.setState({ activeModelItemId: 'stale-item' })
    state().newProject()
    expect(state().project.geometry).toEqual([])
    expect(state().project.setups).toEqual([])
    expect(state().activeModelItemId).toBeNull()
  })

  it('with NO viewport mounted yet, newProject() does not throw (fail-soft, matches loadProjectFromFile)', () => {
    vi.stubGlobal('window', {})
    expect(() => state().newProject()).not.toThrow()
    expect(state().project.geometry.length).toBe(0)
  })
})
