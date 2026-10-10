// B2 (docs/planning/POST-MERGE-WORKPLAN.md): after File > Open of a
// .camproject, geometry + stock were INVISIBLE in the Setup view until a
// sketch bake or a page refresh forced a full scene reload. Root cause: the
// scene rebuild for project open was a React effect keyed on project.id
// (Viewport.tsx), so re-opening a file whose id matched the current project
// (the smoke-test repro: save -> reload page -> open it back) performed NO
// rebuild at all, and even id-changing opens skipped rebuildStock - the stock
// shown depended on the viewport's stale currentStockConfig.
//
// Fix: loadProjectFromFile drives reloadProjectScene (clear -> restore
// geometry -> rebuildStock from the PROJECT's sceneStock) unconditionally,
// through the same window.__cncViewport handle the New button and DesignTree
// stock handlers already use. These tests drive the REAL user path:
//   - the real store action loadProjectFromFile (what File > Open calls with
//     the file's text), against
//   - REAL CNCViewport methods (clearScene / add2DGeometry / rebuildStock /
//     buildWCSIndicator) bound to a minimal instance with real THREE groups
//     (typedZTransform.test.ts pattern - the full class needs WebGL).
// End state asserted: geometry groups exist in the scene AND are visible,
// stock is built - the same end state the page-refresh (mount restore) path
// produces.

import * as THREE from 'three'
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { useCamStore } from '../../store'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import {
  restoreGeometryToViewport,
  type ReloadableViewport,
} from '../../lib/viewport/restoreScene'
import type { ImportedGeometry, Project, SceneStock, Loop2D } from '../../types'

// -- Minimal real-method viewport ------------------------------------------------
// Object.create(CNCViewport.prototype) + the private fields the REAL methods
// under test touch. clearScene, add2DGeometry, remove2DGeometry, rebuildStock,
// buildStockBox and buildWCSIndicator all execute production code against real
// THREE groups. Interaction-mode/gizmo collaborators are no-op stubs (they
// need a renderer/DOM).

interface VpUnderTest extends ReloadableViewport {
  workpieceGroup: THREE.Group
  stockGroup: THREE.Group
  geometry2dGroups: Map<string, THREE.Group>
  partGroups: Map<string, THREE.Group>
}

function makeVp(): VpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  Object.assign(vp, {
    // group maps + scene groups (real)
    partGroups: new Map<string, THREE.Group>(),
    partMaterials: new Map<string, unknown>(),
    // rebuildStock now ends with applyShadingMode(); the stock-fill traverse
    // reads these (real CNCViewport inits them as class fields).
    materialBaselines: new Map(),
    currentShadingMode: 'shaded-edges',
    projectedLoopGroups: new Map<string, THREE.Group>(),
    geometry2dGroups: new Map<string, THREE.Group>(),
    geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(),
    // clearScene() now disposes nests too; the real CNCViewport always inits
    // this Map as a class field, so the stub must provide it (mirrors the
    // reactiveStockRebuild stub).
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
    // render/DOM collaborators - no-op stubs
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

// -- Project fixture (what saveProjectToFile serializes) ---------------------------

const autoStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
}

function makeDxfGeo(): ImportedGeometry {
  const loop: Loop2D = {
    id: 'loop-1',
    points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
    closed: true, type: 'contour', layerId: 'L1', area: 100,
  }
  return {
    id: 'geo-dxf', name: 'Plate', filename: 'plate.dxf', type: 'curves_2d', format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: [loop],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  }
}

// An STL entry whose cached bytes are unreachable (no IndexedDB in node):
// the restore must tolerate the miss and keep going (part stays unloaded).
function makeStlGeo(): ImportedGeometry {
  return {
    id: 'geo-stl', name: 'Body', filename: 'body.stl', type: 'mesh', format: 'stl',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 },
      size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
  }
}

function makeProjectFile(id = 'proj-file'): string {
  const project: Project = {
    id, name: 'Saved Project', version: '1.0.0',
    createdAt: '2026-06-11T00:00:00.000Z', updatedAt: '2026-06-11T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 },
      rapidRate: 5000, maxSpindleRpm: 24000, minSpindleRpm: 8000,
      spindleDirection: 'cw', toolChanger: 'manual', coolant: false,
      axisLimits: {
        x: { maxCutting: 3000, maxRapid: 5000 },
        y: { maxCutting: 3000, maxRapid: 5000 },
        z: { maxCutting: 1000, maxRapid: 3000 },
      },
      notes: '',
    },
    toolLibrary: [], geometry: [makeStlGeo(), makeDxfGeo()], setups: [],
    activeSetupId: null, activeOperationId: null,
    sceneStock: autoStock, notes: '',
  }
  return JSON.stringify(project)
}

const state = () => useCamStore.getState()

/** The async restore inside loadProjectFromFile resolves in microtasks (the
 *  dxf path has no real I/O; the stl path rejects immediately without
 *  IndexedDB). One macrotask turn settles it. */
const flush = () => new Promise<void>((r) => setTimeout(r, 0))

const stockBox = (vp: VpUnderTest) => new THREE.Box3().setFromObject(vp.stockGroup)

describe('B2: File > Open rebuilds the viewport scene (geometry visible + stock built)', () => {
  let vp: VpUnderTest

  beforeEach(() => {
    vp = makeVp()
    // The store action reaches the viewport through the same global handle
    // the app uses (window.__cncViewport, published by Viewport.tsx).
    vi.stubGlobal('window', { __cncViewport: vp })
    vi.stubGlobal('alert', vi.fn())
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [], setups: [], sceneStock: autoStock },
      projectHistory: [], sketchHistory: [], canUndo: false,
    }))
  })

  afterAll(() => {
    vi.unstubAllGlobals()
  })

  it('open: geometry group is in the scene and visible, stock is rebuilt from the file sceneStock', async () => {
    state().loadProjectFromFile(makeProjectFile())
    expect(state().project.id).toBe('proj-file')   // store took the project
    await flush()

    // Geometry group exists in the scene graph...
    const group = vp.geometry2dGroups.get('geo-dxf')
    expect(group).toBeDefined()
    expect(vp.workpieceGroup.children).toContain(group)
    // ...and is VISIBLE (group + every loop line material).
    expect(group!.visible).toBe(true)
    expect(vp.workpieceGroup.visible).toBe(true)
    group!.traverse((c) => {
      if (c instanceof THREE.Line) {
        expect((c.material as THREE.Material).visible).toBe(true)
      }
    })

    // Stock was rebuilt: auto stock from the 10x10 loop + the FILE's offsets
    // (XY pad 2 -> -2..12), not the viewport's stale currentStockConfig (pad 5).
    expect(vp.stockGroup.children.length).toBeGreaterThan(0)
    const sb = stockBox(vp)
    expect(sb.min.x).toBeCloseTo(-2, 6)
    expect(sb.max.x).toBeCloseTo(12, 6)
    expect(sb.min.y).toBeCloseTo(-2, 6)
    expect(sb.max.y).toBeCloseTo(12, 6)
  })

  it('re-opening the SAME project id still rebuilds (the old id-keyed effect skipped it)', async () => {
    state().loadProjectFromFile(makeProjectFile('proj-same'))
    await flush()
    const g1 = vp.geometry2dGroups.get('geo-dxf')
    expect(g1).toBeDefined()

    // Save -> reload -> "Open it back": same id as the project already loaded.
    state().loadProjectFromFile(makeProjectFile('proj-same'))
    await flush()
    const g2 = vp.geometry2dGroups.get('geo-dxf')
    expect(g2).toBeDefined()
    expect(g2).not.toBe(g1)                      // a real rebuild happened
    expect(vp.workpieceGroup.children).toContain(g2)
    expect(vp.stockGroup.children.length).toBeGreaterThan(0)
  })

  it('File > New (cleared scene) then Open repopulates geometry AND stock', async () => {
    // The New button: store reset + direct clearScene (TopToolbar.tsx).
    state().newProject()
    vp.clearScene()
    expect(vp.workpieceGroup.children.length).toBe(0)
    expect(vp.stockGroup.children.length).toBe(0)

    state().loadProjectFromFile(makeProjectFile())
    await flush()
    expect(vp.geometry2dGroups.get('geo-dxf')).toBeDefined()
    expect(vp.workpieceGroup.children.length).toBeGreaterThan(0)
    expect(vp.stockGroup.children.length).toBeGreaterThan(0)
  })

  it('open ends in the same scene state the page-refresh (mount restore) path produces', async () => {
    state().loadProjectFromFile(makeProjectFile())
    await flush()

    // Refresh equivalent: what Viewport's mount effect runs against a fresh
    // viewport (restoreGeometryToViewport -> rebuildStock(project.sceneStock)).
    const vpRefresh = makeVp()
    const s = state()
    await restoreGeometryToViewport(vpRefresh, s.project.geometry, {
      patchGeometry: s.patchGeometry, setBrepImportError: s.setBrepImportError,
    })
    vpRefresh.rebuildStock(s.project.sceneStock)

    // Same geometry groups in the scene...
    const openIds = [...vp.geometry2dGroups.keys()].sort()
    const refreshIds = [...vpRefresh.geometry2dGroups.keys()].sort()
    expect(openIds).toEqual(refreshIds)
    // ...and the same stock box.
    const a = stockBox(vp), b = stockBox(vpRefresh)
    expect(a.min.distanceTo(b.min)).toBeCloseTo(0, 6)
    expect(a.max.distanceTo(b.max)).toBeCloseTo(0, 6)
  })

  it('an invalid file is rejected without touching the scene', async () => {
    state().loadProjectFromFile(makeProjectFile())
    await flush()
    const before = vp.geometry2dGroups.get('geo-dxf')

    state().loadProjectFromFile('{"not":"a project"}')
    await flush()
    expect(vp.geometry2dGroups.get('geo-dxf')).toBe(before)  // untouched
    expect(state().project.id).toBe('proj-file')
  })

  // CAM-BINDING Stage 5 (charter RISK 2, load-boundary rehydration gap): a
  // REAL File > Open must start every opened project's ModelReferences
  // UNVERIFIED against the live kernel, regardless of what status they were
  // saved with - postProject.ts's own backstop (postProject.test.ts) proves
  // what THAT refuses; this proves loadProjectFromFile is the thing that
  // actually sets it, through the real production entry point.
  it('File > Open sets modelRefsVerifiedSinceLoad FALSE, even though it started true', async () => {
    useCamStore.setState({ modelRefsVerifiedSinceLoad: true })
    state().loadProjectFromFile(makeProjectFile())
    await flush()
    expect(state().project.id).toBe('proj-file')
    expect(state().modelRefsVerifiedSinceLoad).toBe(false)
  })

  it('an INVALID file does NOT touch modelRefsVerifiedSinceLoad (refused before any mutation)', async () => {
    useCamStore.setState({ modelRefsVerifiedSinceLoad: true })
    state().loadProjectFromFile('{"not":"a project"}')
    await flush()
    expect(state().modelRefsVerifiedSinceLoad).toBe(true) // untouched by the refused open
  })
})
