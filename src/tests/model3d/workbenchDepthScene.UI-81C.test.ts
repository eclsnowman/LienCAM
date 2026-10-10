// @vitest-environment jsdom
//
// WO UI-81C: the no-body Model workspace must fit camera depth to every
// visible scene object. This file starts with Operator's privacy-safe debug-scene
// export because it is the natural failure: the sketch fits the orthographic
// X/Y window, but one real corner is behind the camera and clipped by near.

import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import sampleMachineDebugScene from '../../../test_fixtures/evidence/UI-81C/operator-debug-scene-summary.json'
import {
  DepthExtentRoots,
  VisibleSceneDepthLifecycle,
  VisibleBodyBoundsCache,
  createCameraSceneSafety,
  createVisibleSceneObjectEnrollment,
} from '../../components/model3d/sceneRuntime'

const disposables: Array<() => void> = []

afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.()
})

function disposeObject(root: THREE.Object3D): void {
  root.traverse((obj) => {
    const renderable = obj as Partial<THREE.Mesh>
    renderable.geometry?.dispose()
    const materials = Array.isArray(renderable.material) ? renderable.material : [renderable.material]
    for (const material of materials) material?.dispose()
  })
}

function cameraControls(target: THREE.Vector3): Parameters<typeof createCameraSceneSafety>[0]['controls'] {
  return {
    target,
    mouseButtons: {},
    touches: {},
    enabled: true,
    enablePan: true,
    addEventListener: () => {},
    removeEventListener: () => {},
  } as unknown as Parameters<typeof createCameraSceneSafety>[0]['controls']
}

function exactDebugCamera(): THREE.OrthographicCamera {
  const { camera: source } = sampleMachineDebugScene
  // The summary records the visible world window, not raw left/right/top/bottom.
  // For an orthographic camera: visible span = frustum span / zoom.
  const halfWidth = source.visibleWorldWidth * source.zoom * 0.5
  const halfHeight = source.visibleWorldHeight * source.zoom * 0.5
  const camera = new THREE.OrthographicCamera(
    -halfWidth,
    halfWidth,
    halfHeight,
    -halfHeight,
    source.near,
    source.far,
  )
  camera.position.set(source.position.x, source.position.y, source.position.z)
  camera.up.set(0, 0, 1)
  camera.zoom = source.zoom
  camera.lookAt(source.target.x, source.target.y, source.target.z)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return camera
}

function debugSceneRoots(): { scene: THREE.Scene; roots: THREE.Object3D[]; clippedCorner: THREE.Vector3 } {
  const { profileBounds } = sampleMachineDebugScene.scene
  const scene = new THREE.Scene()

  const originGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(25, 0, 0),
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 25, 0),
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 25),
  ])
  const origin = new THREE.LineSegments(originGeometry, new THREE.LineBasicMaterial())
  origin.name = 'origin'
  origin.userData.genesisNodeId = 'origin'

  const datum = new THREE.Mesh(
    new THREE.PlaneGeometry(80, 80),
    new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
  )
  datum.name = 'datum:XY'
  datum.userData.genesisNodeId = 'datum:XY'

  const clippedCorner = new THREE.Vector3(profileBounds.maxX, profileBounds.minY, profileBounds.z)
  const sketchGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(profileBounds.minX, profileBounds.minY, profileBounds.z),
    clippedCorner,
    new THREE.Vector3(profileBounds.maxX, profileBounds.maxY, profileBounds.z),
    new THREE.Vector3(profileBounds.minX, profileBounds.maxY, profileBounds.z),
  ])
  const sketch = new THREE.LineLoop(sketchGeometry, new THREE.LineBasicMaterial())
  sketch.name = 'sketch3d:SK1'
  sketch.userData.workbenchSketchNodeId = 'sketch3d:SK1'

  const roots = [origin, datum, sketch]
  scene.add(...roots)
  scene.updateMatrixWorld(true)
  disposables.push(() => roots.forEach(disposeObject))
  return { scene, roots, clippedCorner }
}

function objectCornerDepths(camera: THREE.Camera, object: THREE.Object3D): number[] {
  const bounds = new THREE.Box3().setFromObject(object)
  const depths: number[] = []
  for (let i = 0; i < 8; i += 1) {
    const corner = new THREE.Vector3(
      (i & 1) === 0 ? bounds.min.x : bounds.max.x,
      (i & 2) === 0 ? bounds.min.y : bounds.max.y,
      (i & 4) === 0 ? bounds.min.z : bounds.max.z,
    ).applyMatrix4(camera.matrixWorldInverse)
    depths.push(-corner.z)
  }
  return depths
}

function depthRow(camera: THREE.Camera, object: THREE.Object3D): {
  object: string
  boundsMin: number[]
  boundsMax: number[]
  minDepth: number
  maxDepth: number
} {
  const bounds = new THREE.Box3().setFromObject(object)
  const depths = objectCornerDepths(camera, object)
  return {
    object: object.name,
    boundsMin: bounds.min.toArray(),
    boundsMax: bounds.max.toArray(),
    minDepth: Math.min(...depths),
    maxDepth: Math.max(...depths),
  }
}

function boxObject(name: string, size: number, center: THREE.Vector3): THREE.Mesh {
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size, size, size),
    new THREE.MeshBasicMaterial(),
  )
  mesh.name = name
  mesh.position.copy(center)
  mesh.updateWorldMatrix(true, false)
  disposables.push(() => disposeObject(mesh))
  return mesh
}

function productionRootCensus(): Array<{ className: string; root: THREE.Object3D }> {
  const lineGeometry = (): THREE.BufferGeometry => new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(-5, -5, 0),
    new THREE.Vector3(5, 5, 0),
    new THREE.Vector3(-5, 5, 0),
    new THREE.Vector3(5, -5, 0),
  ])
  const lineMaterial = (): THREE.LineBasicMaterial => new THREE.LineBasicMaterial()

  const origin = new THREE.Group()
  origin.name = 'origin'
  origin.userData.genesisNodeId = 'origin'
  origin.add(new THREE.LineSegments(lineGeometry(), lineMaterial()))

  const datum = new THREE.Group()
  datum.name = 'datum-plane'
  datum.userData.genesisNodeId = 'datum:XY'
  datum.add(
    new THREE.LineLoop(lineGeometry(), lineMaterial()),
    new THREE.Mesh(
      new THREE.PlaneGeometry(10, 10),
      new THREE.MeshBasicMaterial({ side: THREE.DoubleSide }),
    ),
  )

  const finishedSketch = new THREE.LineLoop(lineGeometry(), lineMaterial())
  finishedSketch.name = 'finished-sketch'
  finishedSketch.userData.workbenchSketchNodeId = 'sketch3d:finished'

  // The live sketch host adds an otherwise untagged Group whose children are
  // the active sketch layer/grid. This case proves enrollment is all-object,
  // not accidentally limited to the three legacy userData classifiers.
  const activeSketchGrid = new THREE.Group()
  activeSketchGrid.name = 'active-sketch-grid-root'
  activeSketchGrid.add(new THREE.LineSegments(lineGeometry(), lineMaterial()))

  const body = new THREE.Mesh(
    new THREE.BoxGeometry(10, 10, 10),
    new THREE.MeshBasicMaterial(),
  )
  body.name = 'body-mesh'
  body.userData.workbenchFeatureId = 'F1'

  const edgeOverlay = new THREE.LineSegments(lineGeometry(), lineMaterial())
  edgeOverlay.name = 'edge-overlay'
  edgeOverlay.userData.workbenchFeatureId = 'F1'

  const preview = new THREE.Mesh(
    new THREE.SphereGeometry(5),
    new THREE.MeshBasicMaterial(),
  )
  preview.name = 'preview'
  preview.userData.workbenchFeatureId = 'preview:F1'

  const census = [
    { className: 'origin', root: origin },
    { className: 'datum plane', root: datum },
    { className: 'finished sketch', root: finishedSketch },
    { className: 'active-sketch/grid root', root: activeSketchGrid },
    { className: 'body mesh', root: body },
    { className: 'edge overlay', root: edgeOverlay },
    { className: 'preview', root: preview },
  ]
  census.forEach(({ root }, index) => {
    root.position.z = -index * 1_000
    root.updateWorldMatrix(true, true)
    disposables.push(() => disposeObject(root))
  })
  return census
}

describe('UI-81C exact no-body debug-scene depth failure', () => {
  it('fits the visible origin, XY datum, and finished sketch while preserving orthographic framing', () => {
    const camera = exactDebugCamera()
    const target = new THREE.Vector3(
      sampleMachineDebugScene.camera.target.x,
      sampleMachineDebugScene.camera.target.y,
      sampleMachineDebugScene.camera.target.z,
    )
    const { roots, clippedCorner } = debugSceneRoots()
    const cameraSpaceBefore = clippedCorner.clone().applyMatrix4(camera.matrixWorldInverse)
    const ndcBefore = clippedCorner.clone().project(camera)

    expect(cameraSpaceBefore.z, 'committed corner camera-space Z').toBeCloseTo(
      sampleMachineDebugScene.independentProjectionCheck.clippedCorner.cameraSpaceZ,
      10,
    )
    expect(-cameraSpaceBefore.z, 'committed corner starts behind the eye').toBeLessThan(camera.near)
    expect(ndcBefore.z, 'committed corner is clipped by the near plane').toBeCloseTo(
      sampleMachineDebugScene.independentProjectionCheck.clippedCorner.ndc.z,
      10,
    )

    const depthExtentRoots = new DepthExtentRoots()
    for (const root of roots) depthExtentRoots.register(root)
    const controls = cameraControls(target)
    const safety = createCameraSceneSafety({
      getCamera: () => camera,
      controls,
      canvas: document.createElement('div'),
      boundsCache: new VisibleBodyBoundsCache(),
      depthExtentRoots,
    })
    disposables.push(() => safety.dispose())

    const positionBefore = camera.position.clone()
    const quaternionBefore = camera.quaternion.clone()
    const upBefore = camera.up.clone()
    const zoomBefore = camera.zoom
    const xyBefore = { x: ndcBefore.x, y: ndcBefore.y }
    const tableBefore = roots.map((root) => depthRow(camera, root))
    const result = safety.onBoundsChanged()

    expect(result?.ok, 'no-body visible scene receives an automatic depth fit').toBe(true)
    expect(camera.position.distanceTo(positionBefore), 'orthographic camera retreats behind the sketch').toBeGreaterThan(0)
    expect(controls.target.equals(target), 'orbit target stays unchanged').toBe(true)
    expect(camera.quaternion.equals(quaternionBefore), 'orientation stays unchanged').toBe(true)
    expect(camera.up.equals(upBefore), 'roll/up stays unchanged').toBe(true)
    expect(camera.zoom, 'orthographic zoom stays unchanged').toBe(zoomBefore)

    const ndcAfter = clippedCorner.clone().project(camera)
    expect(ndcAfter.x, 'apparent X framing stays unchanged').toBeCloseTo(xyBefore.x, 12)
    expect(ndcAfter.y, 'apparent Y framing stays unchanged').toBeCloseTo(xyBefore.y, 12)
    for (const root of roots) {
      for (const depth of objectCornerDepths(camera, root)) {
        expect(depth, `${root.name}: corner clears near`).toBeGreaterThanOrEqual(camera.near)
        expect(depth, `${root.name}: corner clears far`).toBeLessThanOrEqual(camera.far)
      }
    }
    console.info(`UI-81C_DEBUG_DEPTH_TABLE ${JSON.stringify({
      projection: 'orthographic',
      cameraBefore: {
        position: positionBefore.toArray(),
        target: target.toArray(),
        near: sampleMachineDebugScene.camera.near,
        far: sampleMachineDebugScene.camera.far,
      },
      clippedCornerBefore: {
        world: clippedCorner.toArray(),
        cameraSpaceZ: cameraSpaceBefore.z,
        depth: -cameraSpaceBefore.z,
        ndcZ: ndcBefore.z,
        clipOwner: 'near',
      },
      cameraAfter: {
        position: camera.position.toArray(),
        target: controls.target.toArray(),
        near: camera.near,
        far: camera.far,
      },
      before: tableBefore,
      after: roots.map((root) => depthRow(camera, root)),
      work: depthExtentRoots.lastWorkProbe(),
    })}`)
  })
})

describe('UI-81C scale-separated scene ranges', () => {
  it('the default runtime add/remove boundary enrolls every representative visible root', () => {
    const camera = new THREE.OrthographicCamera(-50, 50, 50, -50, 0.25, 3200)
    camera.position.set(0, 0, 100)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    const baseline = { near: camera.near, far: camera.far }
    const scene = new THREE.Scene()
    const depthExtentRoots = new DepthExtentRoots()
    const safety = createCameraSceneSafety({
      getCamera: () => camera,
      controls: cameraControls(new THREE.Vector3()),
      canvas: document.createElement('div'),
      boundsCache: new VisibleBodyBoundsCache(),
      depthExtentRoots,
    })
    const lifecycle = new VisibleSceneDepthLifecycle(depthExtentRoots, safety)
    let renderRequests = 0
    const enrollment = createVisibleSceneObjectEnrollment({
      scene,
      depthLifecycle: lifecycle,
      requestRender: () => { renderRequests += 1 },
    })
    disposables.push(() => safety.dispose())
    const census = productionRootCensus()

    census.forEach(({ className, root }, index) => {
      enrollment.addObject(root)
      scene.updateMatrixWorld(true)
      expect(root.parent, `${className}: addObject attaches the production root`).toBe(scene)
      expect(depthExtentRoots.size(), `${className}: addObject registers the production root`).toBe(index + 1)

      const measured = depthExtentRoots.perRootBoxes().find((entry) => entry.name === root.name)
      expect(measured, `${className}: contributes a finite depth box`).toBeDefined()
      expect(
        [...measured!.box.min.toArray(), ...measured!.box.max.toArray()].every(Number.isFinite),
        `${className}: depth box values are finite`,
      ).toBe(true)
      for (const enrolled of census.slice(0, index + 1)) {
        for (const depth of objectCornerDepths(camera, enrolled.root)) {
          expect(Number.isFinite(depth), `${enrolled.className}: camera depth is finite`).toBe(true)
          expect(depth, `${enrolled.className}: corner clears near after ${className} add`).toBeGreaterThanOrEqual(camera.near)
          expect(depth, `${enrolled.className}: corner clears far after ${className} add`).toBeLessThanOrEqual(camera.far)
        }
      }
    })
    expect(depthExtentRoots.lastWorkProbe()).toMatchObject({
      registeredRoots: census.length,
      renderedRoots: census.length,
    })
    expect(camera.far, 'the distant preview expands the owned slab beyond the external baseline').toBeGreaterThan(baseline.far)

    census.slice().reverse().forEach(({ className, root }, reverseIndex) => {
      enrollment.removeObject(root)
      expect(root.parent, `${className}: removeObject detaches the production root`).toBeNull()
      expect(depthExtentRoots.size(), `${className}: removeObject unregisters the production root`)
        .toBe(census.length - reverseIndex - 1)
      if (reverseIndex < census.length - 1) {
        for (const remaining of census.slice(0, census.length - reverseIndex - 1)) {
          for (const depth of objectCornerDepths(camera, remaining.root)) {
            expect(depth, `${remaining.className}: remaining corner clears near`).toBeGreaterThanOrEqual(camera.near)
            expect(depth, `${remaining.className}: remaining corner clears far`).toBeLessThanOrEqual(camera.far)
          }
        }
      }
    })
    expect({ near: camera.near, far: camera.far }, 'final removal restores the prior external slab')
      .toEqual(baseline)
    expect(renderRequests, 'each add and remove requests one production render').toBe(census.length * 2)
    expect(scene.children).toEqual([])
    console.info(`UI-81C-R1_DEFAULT_RUNTIME_CENSUS ${JSON.stringify({
      classes: census.map(({ className, root }) => ({ className, rootName: root.name })),
      baseline,
      final: { near: camera.near, far: camera.far },
      renderRequests,
    })}`)
  })

  it.each(['orthographic', 'perspective'] as const)(
    '%s keeps a 0.001 mm local body and a 1000 mm object one million mm away inside depth',
    (projection) => {
      const camera = projection === 'orthographic'
        ? new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 2000)
        : new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
      camera.position.set(0, 0, 100)
      camera.lookAt(0, 0, 0)
      camera.updateProjectionMatrix()
      camera.updateMatrixWorld(true)

      const scene = new THREE.Scene()
      const localBody = boxObject('local-body-0.001mm', 0.001, new THREE.Vector3())
      const distantSketch = boxObject(
        'distant-user-geometry-1000mm',
        1000,
        new THREE.Vector3(1_000_000, -1_000_000, -1_000_000),
      )
      distantSketch.userData.workbenchSketchNodeId = 'sketch3d:distant'
      scene.add(localBody, distantSketch)
      scene.updateMatrixWorld(true)

      const boundsCache = new VisibleBodyBoundsCache()
      boundsCache.register(localBody)
      const depthExtentRoots = new DepthExtentRoots()
      depthExtentRoots.register(distantSketch)
      const controls = cameraControls(new THREE.Vector3())
      const safety = createCameraSceneSafety({
        getCamera: () => camera,
        controls,
        canvas: document.createElement('div'),
        boundsCache,
        depthExtentRoots,
      })
      disposables.push(() => safety.dispose())

      const result = safety.onBoundsChanged()
      expect(result?.ok, `${projection}: production fit succeeds`).toBe(true)
      expect(Number.isFinite(camera.near) && camera.near > 0).toBe(true)
      expect(Number.isFinite(camera.far) && camera.far > camera.near).toBe(true)
      for (const object of [localBody, distantSketch]) {
        for (const depth of objectCornerDepths(camera, object)) {
          expect(depth, `${projection}/${object.name}: corner clears near`).toBeGreaterThanOrEqual(camera.near)
          expect(depth, `${projection}/${object.name}: corner clears far`).toBeLessThanOrEqual(camera.far)
        }
      }
      console.info(`UI-81C_SCALE_DEPTH_TABLE ${JSON.stringify({
        projection,
        near: camera.near,
        far: camera.far,
        cameraPosition: camera.position.toArray(),
        objects: [depthRow(camera, localBody), depthRow(camera, distantSketch)],
        work: depthExtentRoots.lastWorkProbe(),
      })}`)
    },
  )

  it('perspective refuses behind-eye geometry by name without applying the orthographic retreat', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
    camera.position.set(0, 0, 10)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    const positionBefore = camera.position.clone()
    const planesBefore = { near: camera.near, far: camera.far }

    const scene = new THREE.Scene()
    const behindEye = boxObject('perspective-behind-eye', 2, new THREE.Vector3(0, 0, 20))
    behindEye.userData.workbenchSketchNodeId = 'sketch3d:behind-eye'
    scene.add(behindEye)
    scene.updateMatrixWorld(true)
    const roots = new DepthExtentRoots()
    roots.register(behindEye)
    const refusals: string[] = []
    const safety = createCameraSceneSafety({
      getCamera: () => camera,
      controls: cameraControls(new THREE.Vector3()),
      canvas: document.createElement('div'),
      boundsCache: new VisibleBodyBoundsCache(),
      depthExtentRoots: roots,
      onRefusal: (reason) => refusals.push(reason),
    })
    disposables.push(() => safety.dispose())

    expect(safety.onBoundsChanged()).toEqual({
      ok: false,
      reason: 'camera-depth-refused-perspective-behind-eye',
    })
    expect(refusals).toEqual(['camera-depth-refused-perspective-behind-eye'])
    expect(camera.position.equals(positionBefore)).toBe(true)
    expect({ near: camera.near, far: camera.far }).toEqual(planesBefore)
  })
})

describe('UI-81C refresh-work bound', () => {
  it('does one object-count traversal per refresh and zero unchanged bbox recomputes regardless of far range', () => {
    const scene = new THREE.Scene()
    const root = new THREE.Group()
    root.name = 'three-renderables'
    root.userData.workbenchSketchNodeId = 'sketch3d:work-probe'
    for (let i = 0; i < 3; i += 1) {
      const geometry = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(i, 0, 0),
        new THREE.Vector3(i + 1, 1, 1),
      ])
      const material = new THREE.LineBasicMaterial()
      root.add(new THREE.Line(geometry, material))
    }
    scene.add(root)
    scene.updateMatrixWorld(true)
    disposables.push(() => disposeObject(root))

    const roots = new DepthExtentRoots()
    roots.register(root)
    expect(roots.snapshot().ok).toBe(true) // warm geometry bounding boxes
    expect(roots.snapshot().ok).toBe(true)
    const local = roots.lastWorkProbe()

    root.position.set(1_000_000_000, -1_000_000_000, -1_000_000_000)
    root.updateWorldMatrix(true, true)
    expect(roots.snapshot().ok).toBe(true)
    const far = roots.lastWorkProbe()

    expect(local).toEqual({
      registeredRoots: 1,
      renderedRoots: 1,
      visitedObjects: 4,
      geometryBoundsReads: 3,
      boundingBoxRecomputes: 0,
    })
    expect(far).toEqual(local)
    console.info(`UI-81C_WORK_PROBE ${JSON.stringify({ local, far })}`)
  })
})
