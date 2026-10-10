// UI-75 -- the move gizmo must anchor on the SELECTED SKETCH's geometry, not at
// the world origin (Operator N-37: "Gizmo is still not over selected sketch to move
// it").
//
// WHY THIS SUITE EXISTS
//   CNCViewport.setSelectedPart used to attach TransformControls straight to the
//   selected geometry's THREE.Group. TransformControls draws at the attached
//   object's world origin, so the gizmo was always exactly `group.position`.
//   That is correct ONLY when a group's origin is its visible center -- an
//   invariant importers establish via centerLoops but which sketch-baked loops
//   deliberately do not hold (store/index.ts:4534-4544 states it and excludes
//   sketch layers). A sketch drawn away from the origin therefore lands its
//   gizmo hundreds of mm from the geometry. 2D geometry now attaches a
//   bounds-center PROXY whose world motion is replayed onto the real group.
//
// The behavior-defining selection and drag assertions here fail against the
// pre-fix resolver; the mutation proofs are recorded in
// coordination/evidence/UI-75/. One case is a documented exception: the
// sketch-lifecycle restoration-helper test survives the pre-fix mutation
// because it calls attach2DGizmoProxy directly rather than routing through
// the mutated setSelectedPart line (see mutationHonestyDisclosure in
// coordination/reports/UI-75.report.json).
//
// The sketch-lifecycle cases drive the REAL Sketcher through the REAL host
// callbacks rather than a stub, because the fix's correctness depends on an
// ORDERING fact inside Sketcher.exit() -- it nulls `session` BEFORE invoking
// onSessionExit, which is the only reason the mode gate lets the gizmo back.
// A stubbed sketcher would assert my stub's ordering, not the app's (charter
// item 4: settle ordering claims with a constructed test, never prose).

import * as THREE from 'three'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'
import { Sketcher } from '../../lib/sketch/sketcher'
import type { SketcherHost } from '../../lib/sketch/sketcher'
import type { SketchEntity } from '../../lib/sketch/types'
import type { ImportedGeometry, Layer2D, Loop2D } from '../../types'

class StubWorker {
  onmessage: ((e: unknown) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(): void {}
  terminate(): void {}
}

vi.stubGlobal('Worker', StubWorker)
vi.stubGlobal('localStorage', {
  getItem: () => null,
  setItem: () => undefined,
  removeItem: () => undefined,
})
vi.stubGlobal('window', {
  addEventListener: () => undefined,
  removeEventListener: () => undefined,
})

let useCamStore: typeof import('../../store').useCamStore

beforeAll(async () => {
  ;({ useCamStore } = await import('../../store'))
})

beforeEach(() => {
  useCamStore.getState().newProject()
})

class FakeTransformControls {
  object: THREE.Object3D | undefined
  attach(object: THREE.Object3D) { this.object = object; return this }
  detach() { this.object = undefined; return this }
  setMode(): void {}
}

interface VpUnderTest {
  add2DGeometry: CNCViewport['add2DGeometry']
  rebuild2DGeometry: CNCViewport['rebuild2DGeometry']
  remove2DGeometry: CNCViewport['remove2DGeometry']
  setSelectedPart: CNCViewport['setSelectedPart']
  setPartTransform: CNCViewport['setPartTransform']
  set2DLayerVisible: CNCViewport['set2DLayerVisible']
  restoreSelectedPartAfterSceneRestore: CNCViewport['restoreSelectedPartAfterSceneRestore']
  enterLayOnFaceMode: CNCViewport['enterLayOnFaceMode']
  exitLayOnFaceMode: CNCViewport['exitLayOnFaceMode']
  enterProjectPlaneMode: CNCViewport['enterProjectPlaneMode']
  exitProjectPlaneMode: CNCViewport['exitProjectPlaneMode']
  enterSketchView: CNCViewport['enterSketchView']
  exitSketchView: CNCViewport['exitSketchView']
  geometry2dGroups: Map<string, THREE.Group>
  partGroups: Map<string, THREE.Group>
  geometry2dGizmoProxy: THREE.Object3D | null
  selectedPartId: string | null
  transformControls: FakeTransformControls
  sketcher: Sketcher
  wcsGizmoSphere: THREE.Object3D | null
  handleTransformControlsChange: () => void
  handleTransformDraggingChanged: (event: { value: boolean }) => void
}

function makeVp(onTransform?: (...args: unknown[]) => void): VpUnderTest {
  const vp = Object.create(CNCViewport.prototype)
  const domElement = {
    style: {} as Record<string, string>,
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
    setPointerCapture: () => {},
    releasePointerCapture: () => {},
  }
  // Doubles as the sketcher's overlayHost (createSketcherHost resolves
  // `sketchOverlayHostEl ?? container`), which the real SketchInteraction
  // binds pointer listeners to on session enter.
  const container = {
    appendChild: () => {},
    removeChild: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }),
  }
  Object.assign(vp, {
    partGroups: new Map<string, THREE.Group>(),
    partMaterials: new Map(),
    // Harness repair: paintPartHighlight (nest-membership refactor, UI-61)
    // now dereferences these instance fields unconditionally, and the
    // Object.create harness bypasses class-field initializers.
    colors: { workpiece: 0x8899aa, workpieceEdge: 0x223344, selectedPart: 0xffaa00 },
    partPickPresentation: 'standard',
    partPickSelectedIds: new Set<string>(),
    partPickGlowGroups: new Map<string, THREE.Group>(),
    partPickHoverId: null,
    geometry2dGroups: new Map<string, THREE.Group>(),
    geometry2dLayerMats: new Map(),
    layer2dRequestedVisible: new Map(),
    sketchEditLayerId: null,
    selectedPartId: null,
    geometry2dGizmoProxy: null,
    geometry2dGizmoGroup: null,
    geometry2dGizmoLastWorld: new THREE.Matrix4(),
    workpieceGroup: new THREE.Group(),
    scene: new THREE.Scene(),
    camera: new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 1000),
    container,
    sketchOverlayHostEl: null,
    sketchHostView: null,
    transformControls: new FakeTransformControls(),
    controls: { enabled: true, enableRotate: true, mouseButtons: {}, touches: {}, update: () => {} },
    renderer: { domElement },
    interactionMode: 'normal',
    wcsGizmoSphere: null,
    stockGizmoSphere: null,
    stockGizmoId: null,
    rebuildStock: () => {},
    updateSelectableObjects: () => {},
    maybeAutoFit: () => {},
    highlight2D: () => {},
    highlightProjectedLoops: () => {},
    computeFaceOverlays: () => {},
    _buildProjectPlanePicker: () => {},
    getWorldPerPixel: () => 0.1,
    faceHighlightGroup: new THREE.Group(),
    faceOverlays: [],
    hoveredOverlayMesh: null,
    _projPlaneOverlay: null,
    stockGroup: new THREE.Group(),
    machineGroup: new THREE.Group(),
    toolpathGroup: new THREE.Group(),
    saveCameraState: () => ({ position: { x: 0, y: 0, z: 100 }, target: { x: 0, y: 0, z: 0 }, zoom: 1 }),
    restoreCameraState: () => {},
    setCameraView: () => {},
    clearSketchMarquee: () => {},
    setSketchToolPreview: () => {},
    setSketchSnapDisplay: () => {},
    setSketchToolOverlayDisplay: () => {},
    projectedLoopGroups: new Map(),
    _worldPlaneLoopGroups: new Map(),
    _geoLocalLoopGroups: new Map(),
    onPartTransformChange: onTransform,
  })
  vp.scene.add(vp.workpieceGroup)
  // Wire the REAL Sketcher through the REAL host factory, so enterSketchView /
  // exitSketchView run the production onSessionEnter/onSessionExit callbacks in
  // the production order.
  const makeHost = (CNCViewport.prototype as unknown as {
    createSketcherHost: (this: unknown) => SketcherHost
  }).createSketcherHost
  vp.sketcher = new Sketcher(makeHost.call(vp))
  return vp as VpUnderTest
}

function line(id: string, x0: number, y0: number, x1: number, y1: number): SketchEntity {
  return {
    id, kind: 'line', construction: false,
    start: { x: x0, y: y0 }, end: { x: x1, y: y1 },
  }
}

function addRectangle(prefix: string, x0: number, y0: number, x1: number, y1: number): void {
  const store = useCamStore.getState()
  store.addEntity(line(`${prefix}-b`, x0, y0, x1, y0))
  store.addEntity(line(`${prefix}-r`, x1, y0, x1, y1))
  store.addEntity(line(`${prefix}-t`, x1, y1, x0, y1))
  store.addEntity(line(`${prefix}-l`, x0, y1, x0, y0))
}

const layer: Layer2D = {
  id: 'layer-1', name: 'Layer', color: '#00e5ff', visible: true,
}

function loop(id: string, x0: number, y0: number, x1: number, y1: number): Loop2D {
  return {
    id, layerId: layer.id, type: 'contour', closed: true,
    area: (x1 - x0) * (y1 - y0),
    points: [
      { x: x0, y: y0 }, { x: x1, y: y0 },
      { x: x1, y: y1 }, { x: x0, y: y1 },
    ],
  }
}

function renderedCenter(group: THREE.Group): THREE.Vector3 {
  group.updateWorldMatrix(true, true)
  return new THREE.Box3().setFromObject(group).getCenter(new THREE.Vector3())
}

function expectVector(actual: THREE.Vector3, expected: { x: number; y: number; z: number }) {
  expect(actual.x).toBeCloseTo(expected.x, 6)
  expect(actual.y).toBeCloseTo(expected.y, 6)
  expect(actual.z).toBeCloseTo(expected.z, 6)
}

describe('2D move gizmo bounds-center proxy', () => {
  // Operator's exact bug: a sketch drawn away from the origin, selected after
  // Finish. Pre-fix the anchor sat at (0,0) -- the sketch container's pinned
  // position -- instead of the rectangle's center at x=20.
  it('anchors on a real off-origin sketch through Finish and asymmetric re-edit', () => {
    useCamStore.getState().startNewSketch()
    const layerId = useCamStore.getState().activeSketch!.layerId
    const ownerId = useCamStore.getState().activeSketch!.ownerGeometryId
    addRectangle('first', 10, 4, 30, 14)
    useCamStore.getState().finishSketch()

    const created = useCamStore.getState().project.geometry.find(
      (g) => g.id === ownerId,
    )!
    // WO-2189: new sketches own separate parts instead of a shared container.
    expect(created).toBeDefined()
    expect(created.layers2d?.map((l) => l.id)).toEqual([layerId])
    // The container really is pinned at the origin -- this is what made the
    // gizmo land there, and it must stay true (the fix must NOT move geometry).
    expectVector(
      new THREE.Vector3(created.position.x, created.position.y, created.position.z),
      { x: 0, y: 0, z: 0 },
    )

    const vp = makeVp()
    vp.add2DGeometry(created.id, created.loops!, created.layers2d!, created.position, created.rotation)
    vp.setSelectedPart(created.id)

    expect(vp.transformControls.object).toBe(vp.geometry2dGizmoProxy)
    expectVector(vp.geometry2dGizmoProxy!.position, renderedCenter(vp.geometry2dGroups.get(created.id)!))
    expect(vp.geometry2dGizmoProxy!.position.x).toBeCloseTo(20, 6)
    // The group itself is still at the origin: the anchor moved, the geometry did not.
    expect(vp.geometry2dGroups.get(created.id)!.position.x).toBeCloseTo(0, 6)

    expect(useCamStore.getState().openSketchForLayer(layerId, created.id)).toBe(true)
    addRectangle('second', 50, 4, 70, 14)
    useCamStore.getState().finishSketch()
    const edited = useCamStore.getState().project.geometry.find((g) => g.id === created.id)!
    const firstProxy = vp.geometry2dGizmoProxy
    vp.rebuild2DGeometry(edited.id, edited.loops!, edited.layers2d!)

    expect(vp.selectedPartId).toBe(edited.id)
    expect(vp.geometry2dGizmoProxy).not.toBe(firstProxy)
    expect(vp.transformControls.object).toBe(vp.geometry2dGizmoProxy)
    expectVector(vp.geometry2dGizmoProxy!.position, renderedCenter(vp.geometry2dGroups.get(edited.id)!))
    // Asymmetric growth: the anchor tracks the NEW center (40), not the old (20).
    expect(vp.geometry2dGizmoProxy!.position.x).toBeCloseTo(40, 6)
  })

  it('re-centers after a real imported setGeometryLoops edit and viewport rebuild', () => {
    const imported: ImportedGeometry = {
      id: 'imported-2d', name: 'Imported', filename: 'part.dxf',
      type: 'curves_2d', format: 'dxf', loaded: true,
      position: { x: 3, y: -2, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 0 },
        size: { x: 10, y: 10, z: 0 }, center: { x: 5, y: 5, z: 0 },
      },
      loops: [loop('before', 0, 0, 10, 10)], layers2d: [layer],
    }
    useCamStore.getState().addGeometry(imported)
    const vp = makeVp()
    vp.add2DGeometry(imported.id, imported.loops!, imported.layers2d!, imported.position, imported.rotation)
    vp.setSelectedPart(imported.id)
    // Composes the group transform (3) with the loop center (5) EXACTLY once.
    expect(vp.geometry2dGizmoProxy!.position.x).toBeCloseTo(8, 6)

    useCamStore.getState().setGeometryLoops(
      imported.id, [loop('after', 20, 0, 60, 10)], [layer],
    )
    const edited = useCamStore.getState().project.geometry.find((g) => g.id === imported.id)!
    vp.rebuild2DGeometry(edited.id, edited.loops!, edited.layers2d!)

    expectVector(vp.geometry2dGizmoProxy!.position, renderedCenter(vp.geometry2dGroups.get(imported.id)!))
    expect(vp.geometry2dGizmoProxy!.position.x).toBeCloseTo(43, 6)
  })

  // The double-offset trap: drag-end must persist the REAL group's transform,
  // never the proxy's bounds-center position.
  it('translates, rotates about center, resyncs typed edits, and persists the real group', () => {
    const onTransform = vi.fn()
    const vp = makeVp(onTransform)
    vp.add2DGeometry('part', [loop('shape', 10, 0, 30, 10)], [layer])
    vp.setSelectedPart('part')
    const proxy = vp.geometry2dGizmoProxy!
    const group = vp.geometry2dGroups.get('part')!

    proxy.position.x += 5
    vp.handleTransformControlsChange()
    expect(group.position.x).toBeCloseTo(5, 6)
    expectVector(renderedCenter(group), proxy.position)

    proxy.rotation.z = Math.PI / 2
    vp.handleTransformControlsChange()
    expect(group.rotation.z).toBeCloseTo(Math.PI / 2, 6)
    // Rotation happened ABOUT THE CENTER: the rendered center still coincides
    // with the proxy rather than swinging around the group's far-off origin.
    expectVector(renderedCenter(group), proxy.position)

    vp.handleTransformDraggingChanged({ value: false })
    expect(onTransform).toHaveBeenCalledTimes(1)
    const [id, position, rotation] = onTransform.mock.lastCall!
    expect(id).toBe('part')
    // The store receives the GROUP's transform, not the proxy's center -- this
    // is the assertion that would catch a double-offset regression.
    expect(position).toEqual({ x: group.position.x, y: group.position.y, z: group.position.z })
    expect((rotation as { x: number }).x).toBeCloseTo(0, 6)
    expect((rotation as { y: number }).y).toBeCloseTo(0, 6)
    expect((rotation as { z: number }).z).toBeCloseTo(90, 6)

    vp.setPartTransform('part', { x: 12, y: 7, z: 2 }, { x: 0, y: 0, z: 0 })
    expectVector(vp.geometry2dGizmoProxy!.position, renderedCenter(group))
    expect(vp.transformControls.object).toBe(vp.geometry2dGizmoProxy)
  })

  it('uses only effectively visible lines and follows layer visibility changes', () => {
    const nearLayer: Layer2D = { ...layer, id: 'near', visible: true }
    const farLayer: Layer2D = { ...layer, id: 'far', visible: false }
    const near = { ...loop('near-shape', 0, 0, 10, 10), layerId: nearLayer.id }
    const far = { ...loop('far-shape', 1000, 0, 1010, 10), layerId: farLayer.id }
    const vp = makeVp()
    vp.add2DGeometry('layered', [near, far], [nearLayer, farLayer])
    vp.setSelectedPart('layered')

    // A hidden layer 1000mm away must not drag the anchor off the visible shape.
    expect(vp.geometry2dGizmoProxy!.position.x).toBeCloseTo(5, 6)
    vp.set2DLayerVisible('layered', farLayer.id, true)
    expect(vp.geometry2dGizmoProxy!.position.x).toBeCloseTo(505, 6)
    vp.set2DLayerVisible('layered', nearLayer.id, false)
    expect(vp.geometry2dGizmoProxy!.position.x).toBeCloseTo(1005, 6)
    // Nothing visible -> fall back to the group origin (pre-UI-75 behaviour).
    vp.set2DLayerVisible('layered', farLayer.id, false)
    expectVector(vp.geometry2dGizmoProxy!.position, { x: 0, y: 0, z: 0 })
  })

  it('suspends only the 2D proxy for exclusive face and plane modes, then restores it', () => {
    const vp = makeVp()
    vp.add2DGeometry('part', [loop('shape', 10, 0, 30, 10)], [layer])
    vp.setSelectedPart('part')

    vp.enterLayOnFaceMode(() => {})
    expect(vp.selectedPartId).toBe('part')
    expect(vp.geometry2dGizmoProxy).toBeNull()
    expect(vp.transformControls.object).toBeUndefined()
    vp.exitLayOnFaceMode()
    expect(vp.transformControls.object).toBe(vp.geometry2dGizmoProxy)

    vp.enterProjectPlaneMode('part', () => {}, () => {})
    expect(vp.selectedPartId).toBe('part')
    expect(vp.geometry2dGizmoProxy).toBeNull()
    expect(vp.transformControls.object).toBeUndefined()
    vp.exitProjectPlaneMode()
    expect(vp.transformControls.object).toBe(vp.geometry2dGizmoProxy)

    // 3D CONTROL: a recentred (STL-style) mesh keeps its DIRECT attachment
    // through the same modes -- the suspend path must touch 2D only.
    const meshGroup = new THREE.Group()
    meshGroup.userData.originIsVisiblePivot = true   // what addSTL establishes
    vp.partGroups.set('mesh', meshGroup)
    vp.setSelectedPart('mesh')
    vp.enterLayOnFaceMode(() => {})
    expect(vp.transformControls.object).toBe(meshGroup)
    vp.exitLayOnFaceMode()
    expect(vp.transformControls.object).toBe(meshGroup)
  })

  it('atomically refuses async restore ownership and allows it after sketch exit', () => {
    const vp = makeVp()
    vp.add2DGeometry('part', [loop('shape', 10, 0, 30, 10)], [layer])
    const wcsSphere = new THREE.Object3D()
    vp.wcsGizmoSphere = wcsSphere
    vp.transformControls.attach(wcsSphere)

    // An async restore landing mid-WCS-edit must REFUSE, not steal the gizmo.
    expect(vp.restoreSelectedPartAfterSceneRestore('part')).toBe(false)
    expect(vp.transformControls.object).toBe(wcsSphere)
    expect(vp.geometry2dGizmoProxy).toBeNull()

    // Sketch mode is the other exclusive owner. Entering it really does detach
    // TransformControls (the real onSessionEnter hook), so the refusal here is
    // "no handle appears", not "the WCS handle survives".
    vp.wcsGizmoSphere = null
    vp.enterSketchView()
    expect(vp.transformControls.object).toBeUndefined()
    expect(vp.restoreSelectedPartAfterSceneRestore('part')).toBe(false)
    expect(vp.transformControls.object).toBeUndefined()
    expect(vp.geometry2dGizmoProxy).toBeNull()

    vp.exitSketchView()
    expect(vp.restoreSelectedPartAfterSceneRestore('part')).toBe(true)
    const restoredProxy = vp.geometry2dGizmoProxy
    expect(vp.transformControls.object).toBe(restoredProxy)
    // A restore for geometry that no longer exists refuses rather than
    // resurrecting a selection for a missing object.
    expect(vp.restoreSelectedPartAfterSceneRestore('deleted-id')).toBe(false)
    expect(vp.transformControls.object).toBe(restoredProxy)
  })

  // Drives the REAL Sketcher: this is the case that pins the ordering
  // dependency documented at CNCViewport.createSketcherHost's onSessionExit.
  // If Sketcher.exit() were reordered to fire the hook BEFORE nulling
  // `session`, the mode gate would refuse and the last assertion here would
  // fail instead of the gizmo silently never returning in production.
  it('uses the real sketch view lifecycle around an edited scene restore', () => {
    const vp = makeVp()
    vp.add2DGeometry('part', [loop('before', 10, 0, 30, 10)], [layer])
    vp.setSelectedPart('part')
    expect(vp.geometry2dGizmoProxy!.position.x).toBeCloseTo(20, 6)

    vp.enterSketchView()
    expect(vp.sketcher.isActive()).toBe(true)
    // Selection is RETAINED so Finish can restore it; only the handle goes.
    expect(vp.selectedPartId).toBe('part')
    expect(vp.geometry2dGizmoProxy).toBeNull()
    expect(vp.transformControls.object).toBeUndefined()

    vp.rebuild2DGeometry('part', [loop('after', 50, 0, 90, 10)], [layer])
    expect(vp.geometry2dGizmoProxy).toBeNull()
    expect(vp.transformControls.object).toBeUndefined()
    expect(vp.restoreSelectedPartAfterSceneRestore('part')).toBe(false)
    expect(vp.transformControls.object).toBeUndefined()

    vp.exitSketchView()
    expect(vp.sketcher.isActive()).toBe(false)
    // The rebuild DROPPED the selection (remove2DGeometry deselects, and
    // add2DGeometry's re-select is gated off inside sketch mode), so exit has
    // nothing to re-attach to. The async restore is what re-establishes it --
    // now at the EDITED center (70), not the stale one (20).
    expect(vp.geometry2dGizmoProxy).toBeNull()
    expect(vp.restoreSelectedPartAfterSceneRestore('part')).toBe(true)
    expect(vp.transformControls.object).toBe(vp.geometry2dGizmoProxy)
    expect(vp.geometry2dGizmoProxy!.position.x).toBeCloseTo(70, 6)
  })

  // The pure ordering proof, separated from the rebuild case above: when the
  // selection SURVIVES the sketch session, exiting must hand the gizmo straight
  // back with no async restore involved. This is the assertion that fails if
  // Sketcher.exit() is ever reordered to invoke onSessionExit BEFORE nulling
  // `session` -- the mode gate would refuse and the gizmo would never return.
  it('hands the gizmo back on sketch exit when the selection survived the session', () => {
    const vp = makeVp()
    vp.add2DGeometry('part', [loop('shape', 10, 0, 30, 10)], [layer])
    vp.setSelectedPart('part')
    expect(vp.geometry2dGizmoProxy!.position.x).toBeCloseTo(20, 6)

    vp.enterSketchView()
    expect(vp.sketcher.isActive()).toBe(true)
    expect(vp.selectedPartId).toBe('part')
    expect(vp.geometry2dGizmoProxy).toBeNull()

    vp.exitSketchView()
    expect(vp.sketcher.isActive()).toBe(false)
    expect(vp.geometry2dGizmoProxy).not.toBeNull()
    expect(vp.transformControls.object).toBe(vp.geometry2dGizmoProxy)
    expect(vp.geometry2dGizmoProxy!.position.x).toBeCloseTo(20, 6)
  })

  it('cleans up on deselect/removal, suppresses sketch attachment, and leaves 3D direct', () => {
    const vp = makeVp()
    vp.add2DGeometry('part', [loop('shape', 10, 0, 30, 10)], [layer])
    vp.setSelectedPart('part')
    const firstProxy = vp.geometry2dGizmoProxy!
    vp.setSelectedPart(null)
    expect(vp.geometry2dGizmoProxy).toBeNull()
    // No scene leak: the proxy is removed from the scene graph, not orphaned.
    expect(firstProxy.parent).toBeNull()
    expect(vp.transformControls.object).toBeUndefined()

    vp.setSelectedPart('part')
    vp.remove2DGeometry('part')
    expect(vp.selectedPartId).toBeNull()
    expect(vp.geometry2dGizmoProxy).toBeNull()

    vp.add2DGeometry('sketch-part', [loop('sketch', 20, 0, 40, 10)], [layer])
    vp.enterSketchView()
    vp.setSelectedPart('sketch-part')
    expect(vp.selectedPartId).toBe('sketch-part')
    expect(vp.geometry2dGizmoProxy).toBeNull()
    expect(vp.transformControls.object).toBeUndefined()

    vp.exitSketchView()
    const meshGroup = new THREE.Group()
    meshGroup.userData.originIsVisiblePivot = true   // what addSTL establishes
    vp.partGroups.set('mesh', meshGroup)
    vp.setSelectedPart('mesh')
    // A recentred (STL-style) mesh stays DIRECT -- no proxy is created for it.
    // Native-frame 3D groups (B-rep / model bodies) DO proxy now; that path is
    // covered by geometry3dMoveGizmoPivot.test.ts.
    expect(vp.transformControls.object).toBe(meshGroup)
    expect(vp.geometry2dGizmoProxy).toBeNull()

    vp.setSelectedPart('deleted-id')
    expect(vp.selectedPartId).toBeNull()
    expect(vp.transformControls.object).toBeUndefined()
  })
})
