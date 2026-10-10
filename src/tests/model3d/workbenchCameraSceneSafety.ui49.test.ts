// @vitest-environment jsdom
//
// UI-49 production-backed camera depth and pivot safety. The immutable
// captured debug camera is imported verbatim; only the representative body
// mesh is constructed here because the capture intentionally contains no
// tessellation payload.

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import capturedScene from '../../../test_fixtures/evidence/UI-49/debug-scene-clipping-2026-07-12.json'
import {
  CameraDepthPolicy,
  DepthExtentRoots,
  SectionableCameraDepthLifecycle,
  VisibleBodyBoundsCache,
  captureDebugCameraState,
  createCameraSceneSafety,
  restoreDebugCameraState,
} from '../../components/model3d/sceneRuntime'

const capturedCamera = capturedScene.camera
if (capturedCamera.projection !== 'orthographic') throw new Error('UI-49 fixture: expected orthographic capture')

const disposables: Array<() => void> = []
afterEach(() => {
  while (disposables.length > 0) disposables.pop()?.()
  vi.restoreAllMocks()
})

function bodyMesh(size: THREE.Vector3, center = new THREE.Vector3()): THREE.Mesh {
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshBasicMaterial())
  mesh.position.copy(center)
  mesh.updateWorldMatrix(true, false)
  disposables.push(() => {
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
  })
  return mesh
}

function representativeNearOriginBody(): THREE.Mesh {
  return bodyMesh(new THREE.Vector3(60, 40, 10))
}

function canvas(width = 1000, height = 800): HTMLCanvasElement {
  const element = document.createElement('canvas')
  Object.defineProperty(element, 'clientWidth', { configurable: true, value: width })
  Object.defineProperty(element, 'clientHeight', { configurable: true, value: height })
  Object.defineProperty(element, 'setPointerCapture', { configurable: true, value: () => {} })
  Object.defineProperty(element, 'releasePointerCapture', { configurable: true, value: () => {} })
  Object.defineProperty(element, 'hasPointerCapture', { configurable: true, value: () => false })
  element.getBoundingClientRect = () => ({
    x: 0,
    y: 0,
    left: 0,
    top: 0,
    right: width,
    bottom: height,
    width,
    height,
    toJSON: () => ({}),
  })
  return element
}

function controlsFor(camera: THREE.Camera, element: HTMLCanvasElement, target: THREE.Vector3): OrbitControls {
  const controls = new OrbitControls(camera, element)
  controls.target.copy(target)
  controls.update()
  disposables.push(() => controls.dispose())
  return controls
}

function capturedOrthographicCamera(): { camera: THREE.OrthographicCamera; target: THREE.Vector3 } {
  const camera = new THREE.OrthographicCamera(
    capturedCamera.left,
    capturedCamera.right,
    capturedCamera.top,
    capturedCamera.bottom,
    capturedCamera.near,
    capturedCamera.far,
  )
  camera.position.set(capturedCamera.position.x, capturedCamera.position.y, capturedCamera.position.z)
  camera.up.set(capturedCamera.up.x, capturedCamera.up.y, capturedCamera.up.z)
  camera.zoom = capturedCamera.zoom
  const target = new THREE.Vector3(capturedCamera.target.x, capturedCamera.target.y, capturedCamera.target.z)
  camera.lookAt(target)
  camera.updateProjectionMatrix()
  camera.updateMatrixWorld(true)
  return { camera, target }
}

function cornerDepths(camera: THREE.Camera, bounds: THREE.Box3): number[] {
  camera.updateMatrixWorld(true)
  const depths: number[] = []
  for (let i = 0; i < 8; i += 1) {
    const p = new THREE.Vector3(
      (i & 1) === 0 ? bounds.min.x : bounds.max.x,
      (i & 2) === 0 ? bounds.min.y : bounds.max.y,
      (i & 4) === 0 ? bounds.min.z : bounds.max.z,
    ).applyMatrix4(camera.matrixWorldInverse)
    depths.push(-p.z)
  }
  return depths
}

function expectAllCornersDepthVisible(camera: THREE.Camera, bounds: THREE.Box3): void {
  const projection = camera as THREE.PerspectiveCamera | THREE.OrthographicCamera
  expect(projection.near, 'near is finite and positive').toBeGreaterThan(0)
  expect(projection.far, 'far is beyond near').toBeGreaterThan(projection.near)
  for (const depth of cornerDepths(camera, bounds)) {
    expect(depth, 'corner is in front of near').toBeGreaterThan(projection.near)
    expect(depth, 'corner is behind far').toBeLessThan(projection.far)
  }
}

function expectObjectDepthVisible(camera: THREE.Camera, object: THREE.Object3D, label: string): void {
  const bounds = new THREE.Box3().setFromObject(object)
  expect(bounds.isEmpty(), `${label}: object has drawable bounds`).toBe(false)
  for (const depth of cornerDepths(camera, bounds)) {
    expect(depth, `${label}: near corner is inside the active slab`).toBeGreaterThanOrEqual(
      (camera as THREE.PerspectiveCamera | THREE.OrthographicCamera).near,
    )
    expect(depth, `${label}: far corner is inside the active slab`).toBeLessThanOrEqual(
      (camera as THREE.PerspectiveCamera | THREE.OrthographicCamera).far,
    )
  }
}

function pointerEvent(
  type: 'pointerdown' | 'pointerup' | 'pointercancel',
  props: { button: number; pointerId?: number; ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean },
): PointerEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...props }) as PointerEvent
  Object.defineProperty(event, 'pointerId', { value: props.pointerId ?? 1 })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  return event
}

function dispatchPan(
  element: HTMLCanvasElement,
  duringGesture: () => void,
  props: { button?: number; ctrlKey?: boolean; shiftKey?: boolean; metaKey?: boolean } = {},
): void {
  const button = props.button ?? 2
  element.dispatchEvent(pointerEvent('pointerdown', { button, ...props }))
  duringGesture()
  element.dispatchEvent(pointerEvent('pointerup', { button, ...props }))
}

describe('UI-49 camera depth safety', () => {
  it('MUTATION behind-eye retreat: the immutable captured pose retreats and stays safe on a second controls change', () => {
    const { camera, target } = capturedOrthographicCamera()
    const element = canvas()
    const controls = controlsFor(camera, element, target)
    const cache = new VisibleBodyBoundsCache()
    const safety = createCameraSceneSafety({ getCamera: () => camera, controls, canvas: element, boundsCache: cache })
    disposables.push(() => safety.dispose())
    const mesh = representativeNearOriginBody()
    mesh.geometry.computeBoundingBox()
    const bounds = mesh.geometry.boundingBox?.clone()
    if (bounds === undefined) throw new Error('UI-49 fixture: missing representative bounds')

    const cameraTargetDistance = camera.position.distanceTo(target)
    const targetOriginDistance = target.length()
    const centerDepthBefore = cornerDepths(camera, new THREE.Box3(new THREE.Vector3(), new THREE.Vector3()))[0]
    expect(cameraTargetDistance, 'immutable camera-target distance').toBeCloseTo(209.76, 2)
    expect(targetOriginDistance, 'immutable target-origin distance').toBeCloseTo(281.34, 2)
    expect(centerDepthBefore, 'near-origin center starts behind the eye').toBeCloseTo(-39.46, 2)
    expect(cornerDepths(camera, bounds).some((depth) => depth <= 0), 'captured body is outside valid depth').toBe(true)

    const originalPosition = camera.position.clone()
    expect(safety.applyDepthSafety(), 'restore before bounds is a safe no-op').toBeNull()
    expect(camera.position.equals(originalPosition)).toBe(true)

    const left = camera.left
    const right = camera.right
    const top = camera.top
    const bottom = camera.bottom
    const zoom = camera.zoom
    const up = camera.up.clone()
    const quaternion = camera.quaternion.clone()
    cache.register(mesh)
    const corrected = safety.onBoundsChanged()
    expect(corrected?.ok).toBe(true)
    if (corrected === null || !corrected.ok) throw new Error('UI-49: captured correction refused')
    expect(corrected.corrected, 'captured pose requires behind-eye retreat').toBe(true)
    expect(corrected.retreatedBy, 'camera retreats a finite distance').toBeGreaterThan(39)
    expect(camera.left).toBe(left)
    expect(camera.right).toBe(right)
    expect(camera.top).toBe(top)
    expect(camera.bottom).toBe(bottom)
    expect(camera.zoom).toBe(zoom)
    expect(camera.up.equals(up), 'authored up/roll is unchanged').toBe(true)
    expect(camera.quaternion.equals(quaternion), 'orientation quaternion is unchanged').toBe(true)
    expectAllCornersDepthVisible(camera, bounds)

    const forward = camera.getWorldDirection(new THREE.Vector3())
    camera.position.addScaledVector(forward, corrected.minDepth + 10)
    camera.updateMatrixWorld(true)
    expect(cornerDepths(camera, bounds).some((depth) => depth <= 0), 'second interaction crosses the body').toBe(true)
    controls.dispatchEvent({ type: 'change' })
    expectAllCornersDepthVisible(camera, bounds)
  })

  it('fits perspective near/far around every corner without changing projection shape', () => {
    const camera = new THREE.PerspectiveCamera(37, 16 / 9, 0.1, 2000)
    camera.position.set(0, 0, 1)
    camera.lookAt(0, 0, 0)
    const bounds = new THREE.Box3(new THREE.Vector3(-3, -2, -4), new THREE.Vector3(3, 2, 0))
    const fov = camera.fov
    const aspect = camera.aspect
    const quaternion = camera.quaternion.clone()
    const result = new CameraDepthPolicy().apply(camera, bounds)
    expect(result.ok).toBe(true)
    expect(camera.fov).toBe(fov)
    expect(camera.aspect).toBe(aspect)
    expect(camera.quaternion.equals(quaternion)).toBe(true)
    expectAllCornersDepthVisible(camera, bounds)
  })

  it('unions visible registered bodies and never traverses geometry on controls changes', () => {
    const cache = new VisibleBodyBoundsCache()
    const left = bodyMesh(new THREE.Vector3(4, 6, 8), new THREE.Vector3(-10, 0, 0))
    const right = bodyMesh(new THREE.Vector3(10, 2, 2), new THREE.Vector3(20, 5, 0))
    const helper = new THREE.GridHelper(100, 10)
    const leftCompute = vi.spyOn(left.geometry, 'computeBoundingBox')
    const rightCompute = vi.spyOn(right.geometry, 'computeBoundingBox')

    cache.register(left)
    cache.register(right)
    let snapshot = cache.snapshot()
    expect(snapshot.ok).toBe(true)
    if (!snapshot.ok || snapshot.bounds === null) throw new Error('UI-49: expected body union')
    expect(snapshot.bounds.min.toArray()).toEqual([-12, -3, -4])
    expect(snapshot.bounds.max.toArray()).toEqual([25, 6, 4])
    expect(helper, 'helper exists but was never registered as a body').toBeInstanceOf(THREE.GridHelper)

    cache.setVisible(right, false)
    snapshot = cache.snapshot()
    if (!snapshot.ok || snapshot.bounds === null) throw new Error('UI-49: expected left-only union')
    expect(snapshot.bounds.min.toArray()).toEqual([-12, -3, -4])
    expect(snapshot.bounds.max.toArray()).toEqual([-8, 3, 4])

    cache.setVisible(right, true)
    cache.unregister(left)
    snapshot = cache.snapshot()
    if (!snapshot.ok || snapshot.bounds === null) throw new Error('UI-49: expected right-only union')
    expect(snapshot.bounds.min.toArray()).toEqual([15, 4, -1])
    expect(snapshot.bounds.max.toArray()).toEqual([25, 6, 1])

    const element = canvas()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
    camera.position.set(20, 5, 50)
    camera.lookAt(20, 5, 0)
    const controls = controlsFor(camera, element, new THREE.Vector3(20, 5, 0))
    const safety = createCameraSceneSafety({ getCamera: () => camera, controls, canvas: element, boundsCache: cache })
    disposables.push(() => safety.dispose())
    const leftCalls = leftCompute.mock.calls.length
    const rightCalls = rightCompute.mock.calls.length
    for (let i = 0; i < 20; i += 1) controls.dispatchEvent({ type: 'change' })
    expect(leftCompute).toHaveBeenCalledTimes(leftCalls)
    expect(rightCompute).toHaveBeenCalledTimes(rightCalls)
    helper.geometry.dispose()
    ;(helper.material as THREE.Material).dispose()
  })

  it('invalid visible bounds refuse by name and preserve the last valid camera state', () => {
    const cache = new VisibleBodyBoundsCache()
    const invalid = bodyMesh(new THREE.Vector3(1, 1, 1))
    vi.spyOn(invalid.geometry, 'computeBoundingBox').mockImplementation(() => {
      invalid.geometry.boundingBox = new THREE.Box3(
        new THREE.Vector3(Number.NaN, 0, 0),
        new THREE.Vector3(1, 1, 1),
      )
    })
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 1000)
    camera.position.set(0, 0, 100)
    camera.lookAt(0, 0, 0)
    const element = canvas()
    const controls = controlsFor(camera, element, new THREE.Vector3())
    const beforePosition = camera.position.clone()
    const beforeQuaternion = camera.quaternion.clone()
    const beforeNear = camera.near
    const beforeFar = camera.far
    const refusals: string[] = []
    const safety = createCameraSceneSafety({
      getCamera: () => camera,
      controls,
      canvas: element,
      boundsCache: cache,
      onRefusal: (reason) => refusals.push(reason),
    })
    disposables.push(() => safety.dispose())

    const update = cache.register(invalid)
    expect(update).toEqual({ ok: false, reason: 'camera-bounds-refused-nonfinite' })
    expect(safety.onBoundsChanged()).toEqual({ ok: false, reason: 'camera-bounds-refused-nonfinite' })
    expect(refusals).toEqual(['camera-bounds-refused-nonfinite'])
    expect(camera.position.equals(beforePosition)).toBe(true)
    expect(camera.quaternion.equals(beforeQuaternion)).toBe(true)
    expect(camera.near).toBe(beforeNear)
    expect(camera.far).toBe(beforeFar)

    const directInvalid = new CameraDepthPolicy().apply(camera, new THREE.Box3(
      new THREE.Vector3(Number.NEGATIVE_INFINITY, 0, 0),
      new THREE.Vector3(1, 1, 1),
    ))
    expect(directInvalid).toEqual({ ok: false, reason: 'camera-bounds-refused-nonfinite' })
    expect(camera.position.equals(beforePosition)).toBe(true)
  })
})

describe('UI-49 pan-end pivot hysteresis', () => {
  function pivotRig(): {
    camera: THREE.OrthographicCamera
    controls: OrbitControls
    element: HTMLCanvasElement
    safety: ReturnType<typeof createCameraSceneSafety>
  } {
    const element = canvas(1000, 800)
    const camera = new THREE.OrthographicCamera(-50, 50, 40, -40, 0.1, 1000)
    camera.position.set(0, 0, 100)
    camera.zoom = 1.25
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    const controls = controlsFor(camera, element, new THREE.Vector3())
    controls.mouseButtons.RIGHT = THREE.MOUSE.PAN
    const cache = new VisibleBodyBoundsCache()
    cache.register(bodyMesh(new THREE.Vector3(10, 10, 10)))
    const safety = createCameraSceneSafety({ getCamera: () => camera, controls, canvas: element, boundsCache: cache })
    safety.onBoundsChanged()
    disposables.push(() => safety.dispose())
    return { camera, controls, element, safety }
  }

  function setPanOffset(camera: THREE.Camera, controls: OrbitControls, x: number): void {
    camera.position.set(x, 0, 100)
    controls.target.set(x, 0, 0)
    camera.lookAt(controls.target)
    camera.updateMatrixWorld(true)
  }

  it('MUTATION pivot hysteresis: off/centered modes hold in the 8-12 percent band and cross at the named thresholds', () => {
    const { camera, controls, element, safety } = pivotRig()

    dispatchPan(element, () => setPanOffset(camera, controls, 20))
    expect(controls.target.x, 'far off-center pan keeps the remote pivot').toBe(20)
    expect(safety.isPivotCentered()).toBe(false)

    dispatchPan(element, () => setPanOffset(camera, controls, 6))
    expect(controls.target.x, 'off-center mode holds inside the 8-12 percent band').toBe(6)
    expect(safety.isPivotCentered()).toBe(false)

    const beforeEnterOffset = camera.position.clone().sub(controls.target)
    const beforeEnterQuaternion = camera.quaternion.clone()
    const beforeEnterUp = camera.up.clone()
    const beforeEnterZoom = camera.zoom
    dispatchPan(element, () => setPanOffset(camera, controls, 4))
    expect(controls.target.toArray(), 'enter <=8 percent snaps exactly to model center').toEqual([0, 0, 0])
    expect(camera.position.clone().sub(controls.target).distanceTo(beforeEnterOffset), 'camera-target offset preserved').toBeLessThan(1e-10)
    expect(camera.quaternion.equals(beforeEnterQuaternion), 'quaternion/roll preserved').toBe(true)
    expect(camera.up.equals(beforeEnterUp), 'up/roll preserved').toBe(true)
    expect(camera.zoom).toBe(beforeEnterZoom)
    expect(safety.isPivotCentered()).toBe(true)

    dispatchPan(element, () => setPanOffset(camera, controls, 6))
    expect(controls.target.x, 'centered mode holds inside the 8-12 percent band').toBe(6)
    expect(safety.isPivotCentered()).toBe(true)

    dispatchPan(element, () => setPanOffset(camera, controls, 8))
    expect(controls.target.x, 'crossing >12 percent releases without snapping').toBe(8)
    expect(safety.isPivotCentered()).toBe(false)

    dispatchPan(element, () => setPanOffset(camera, controls, 4))
    expect(controls.target.toArray(), 'returning to <=8 percent recaptures').toEqual([0, 0, 0])
    expect(safety.isPivotCentered()).toBe(true)
  })

  it('wheel and rotate never recapture, while a resolved modifier-pan does', () => {
    const { camera, controls, element } = pivotRig()
    dispatchPan(element, () => setPanOffset(camera, controls, 20))
    setPanOffset(camera, controls, 4)

    element.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: -100 }))
    expect(controls.target.x, 'wheel does not recapture').toBe(4)

    element.dispatchEvent(pointerEvent('pointerdown', { button: 0 }))
    element.dispatchEvent(pointerEvent('pointerup', { button: 0 }))
    expect(controls.target.x, 'rotate does not recapture').toBe(4)

    controls.mouseButtons.MIDDLE = THREE.MOUSE.ROTATE
    dispatchPan(element, () => {}, { button: 1, ctrlKey: true })
    expect(controls.target.toArray(), 'Ctrl+middle resolves ROTATE to PAN and recaptures').toEqual([0, 0, 0])
  })
})

describe('UI-49 listener lifecycle', () => {
  it('MUTATION controls-change refit: rebinds once, blocks recursive dispatch, and never mutates after dispose', () => {
    const element = canvas()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
    camera.position.set(0, 0, 50)
    camera.lookAt(0, 0, 0)
    const cache = new VisibleBodyBoundsCache()
    const mesh = bodyMesh(new THREE.Vector3(10, 10, 10))
    cache.register(mesh)
    const first = controlsFor(camera, element, new THREE.Vector3())
    let controlsChangeCount = 0
    let recurseOnce = true
    const safety = createCameraSceneSafety({
      getCamera: () => camera,
      controls: first,
      canvas: element,
      boundsCache: cache,
      onControlsChange: () => {
        controlsChangeCount += 1
        if (recurseOnce) {
          recurseOnce = false
          first.dispatchEvent({ type: 'change' })
        }
      },
    })
    disposables.push(() => safety.dispose())
    safety.onBoundsChanged()

    // Keep the lifecycle assertion on a supported perspective pose: UI-81C
    // refuses behind-eye perspective geometry rather than silently applying
    // the orthographic camera-retreat rule.
    camera.position.set(0, 0, 6)
    camera.updateMatrixWorld(true)
    first.dispatchEvent({ type: 'change' })
    expect(controlsChangeCount, 'recursive change dispatch is suppressed').toBe(1)
    mesh.geometry.computeBoundingBox()
    const bounds = mesh.geometry.boundingBox
    if (bounds === null) throw new Error('UI-49: missing listener test bounds')
    expectAllCornersDepthVisible(camera, bounds)

    const second = controlsFor(camera, element, first.target)
    safety.bindControls(second)
    const afterBind = controlsChangeCount
    first.dispatchEvent({ type: 'change' })
    expect(controlsChangeCount, 'old controls listener was removed').toBe(afterBind)
    second.dispatchEvent({ type: 'change' })
    expect(controlsChangeCount, 'new controls has one listener').toBe(afterBind + 1)
    safety.bindControls(second)
    second.dispatchEvent({ type: 'change' })
    expect(controlsChangeCount, 'same-controls rebind does not duplicate').toBe(afterBind + 2)

    safety.dispose()
    const disposedPosition = new THREE.Vector3(0, 0, 0)
    camera.position.copy(disposedPosition)
    camera.updateMatrixWorld(true)
    const targetBeforePointer = second.target.clone()
    second.dispatchEvent({ type: 'change' })
    element.dispatchEvent(pointerEvent('pointerdown', { button: 2 }))
    element.dispatchEvent(pointerEvent('pointerup', { button: 2 }))
    expect(camera.position.equals(disposedPosition), 'post-dispose change cannot mutate camera').toBe(true)
    expect(second.target.equals(targetBeforePointer), 'post-dispose pointer cannot mutate target').toBe(true)
    expect(controlsChangeCount).toBe(afterBind + 2)
  })
})

describe('UI-81B: the depth slab must not freeze at a stale fit once the body it was fitted to is gone', () => {
  it('MUTATION: deleting the ONLY registered body widens near/far back out instead of leaving them frozen at the deleted body\'s tight fit', () => {
    // Operator's literal repro: build a body away from the origin (an ordinary extrude), delete it, then
    // the origin/XY datum glyphs -- always drawn at the world origin regardless of where any body
    // sat -- must not still be clipped by a slab that was fitted to geometry which no longer exists.
    // applyDepthSafety's own comment ("No visible body => near/far are LEFT ALONE ... camera keeps
    // its wide construction defaults") only holds if near/far were NEVER narrowed. Once a body existed
    // and was fitted, the early return froze the STALE tight fit forever -- this is the render-
    // invalidation half of UI-81B: the scene graph stays correct (origin/planes are still there,
    // still visible=true) while the camera simply never draws that depth again until a refresh
    // rebuilds the runtime with fresh construction defaults.
    const element = canvas()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
    // Camera looks down -Z from (0,0,500) at the origin (depth 500). The body sits right in FRONT of
    // the camera (depth ~20) -- far apart in CAMERA-SPACE DEPTH from the origin, which a same-depth
    // placement (e.g. co-planar with the target) would not exercise.
    camera.position.set(0, 0, 500)
    camera.lookAt(0, 0, 0)
    const defaultNear = camera.near
    const defaultFar = camera.far
    const controls = controlsFor(camera, element, new THREE.Vector3(0, 0, 0))
    const cache = new VisibleBodyBoundsCache()
    const safety = createCameraSceneSafety({ getCamera: () => camera, controls, canvas: element, boundsCache: cache })
    disposables.push(() => safety.dispose())

    // A small body close to the camera (depth ~20) -- the extrude Operator built, then deleted.
    const body = bodyMesh(new THREE.Vector3(10, 10, 10), new THREE.Vector3(0, 0, 480))
    cache.register(body)
    const fitted = safety.onBoundsChanged()
    expect(fitted?.ok, 'the body fit succeeds').toBe(true)
    expect(camera.near, 'the fit narrows near away from the wide construction default').not.toBe(defaultNear)
    expect(camera.far, 'the fit narrows far away from the wide construction default').not.toBe(defaultFar)

    const originDepth = -new THREE.Vector3(0, 0, 0).applyMatrix4(camera.matrixWorldInverse).z
    expect(
      originDepth < camera.near || originDepth > camera.far,
      'PROVES the tight fit already excludes the origin depth (the exact clip this defect produces)',
    ).toBe(true)

    // Delete the body (mirrors disposeFeatureBody's runtime.unregisterSectionable -> onBoundsChanged).
    cache.unregister(body)
    safety.onBoundsChanged()

    expect(camera.near, 'near widens back to the safe default once no body justifies a narrow slab').toBe(defaultNear)
    expect(camera.far, 'far widens back to the safe default once no body justifies a narrow slab').toBe(defaultFar)
    const originDepthAfter = -new THREE.Vector3(0, 0, 0).applyMatrix4(camera.matrixWorldInverse).z
    expect(
      originDepthAfter >= camera.near && originDepthAfter <= camera.far,
      'the origin (and any ambient datum/grid drawn there) is visible again after the last body is gone',
    ).toBe(true)
  })

  it('the pre-existing UI-72 arm-A control is unaffected: a NEVER-fitted camera with a registered extent root and zero bodies stays a no-op', () => {
    // Guards the fix above against over-reaching: it must restore a STALE fit to construction
    // defaults, not start actively fitting to extent-roots-alone when no body ever existed (that
    // is the deliberate, already-tested UI-72 arm-A decision -- workbenchDepthExtent.ui72.test.ts
    // "with NO visible body the depth pass stays a no-op, extent registered or not").
    const element = canvas()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
    camera.position.set(0, 0, 500)
    camera.lookAt(0, 0, 0)
    const controls = controlsFor(camera, element, new THREE.Vector3(0, 0, 0))
    const cache = new VisibleBodyBoundsCache()
    const depthExtentRoots = new DepthExtentRoots()
    const safety = createCameraSceneSafety({ getCamera: () => camera, controls, canvas: element, boundsCache: cache, depthExtentRoots })
    disposables.push(() => safety.dispose())

    const scene = new THREE.Scene()
    const grid = bodyMesh(new THREE.Vector3(4000, 4000, 0.01), new THREE.Vector3(0, 0, -3000))
    scene.add(grid)
    depthExtentRoots.register(grid)
    expect(safety.onBoundsChanged(), 'zero bodies, never fitted before -> still a no-op').toBeNull()
    expect(camera.near).toBe(0.1)
    expect(camera.far).toBe(2000)
  })
})

describe('UI-81B-R1: authored depth slabs remain external baselines', () => {
  const authoredState = {
    position: { x: 0, y: 0, z: 500 },
    target: { x: 0, y: 0, z: 0 },
    up: { x: 0, y: 1, z: 0 },
    projection: 'orthographic' as const,
    left: -100,
    right: 100,
    top: 100,
    bottom: -100,
    zoom: 1,
    near: 0.25,
    far: 3200,
  }

  function authoredRig() {
    const element = canvas()
    const camera = new THREE.OrthographicCamera(-100, 100, 100, -100, 0.1, 2000)
    camera.position.set(0, 0, 500)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    camera.updateMatrixWorld(true)
    let controls = controlsFor(camera, element, new THREE.Vector3())
    const boundsCache = new VisibleBodyBoundsCache()
    const depthExtentRoots = new DepthExtentRoots()
    const safety = createCameraSceneSafety({
      getCamera: () => camera,
      controls,
      canvas: element,
      boundsCache,
      depthExtentRoots,
    })
    disposables.push(() => safety.dispose())
    controls = restoreDebugCameraState(camera, controls, authoredState, (previous, target) => {
      previous.dispose()
      const rebound = controlsFor(camera, element, target)
      safety.bindControls(rebound)
      return rebound
    })
    return { camera, controls, boundsCache, depthExtentRoots, safety }
  }

  it('RED A: production debug restore plus the real safety rebind preserves 0.25/3200 bit-identically', () => {
    const { camera, controls } = authoredRig()
    const restored = captureDebugCameraState(camera, controls.target)
    expect(
      restored.projection === 'orthographic'
        ? { near: restored.near, far: restored.far }
        : restored.projection,
      'authored 0.25/3200 must survive restoreDebugCameraState -> bindControls',
    ).toEqual({ near: 0.25, far: 3200 })
  })

  it('an external slab that replaces a temporary fit clears policy ownership instead of being reset as stale', () => {
    const element = canvas()
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
    camera.position.set(0, 0, 500)
    camera.lookAt(0, 0, 0)
    const controls = controlsFor(camera, element, new THREE.Vector3())
    const boundsCache = new VisibleBodyBoundsCache()
    const safety = createCameraSceneSafety({ getCamera: () => camera, controls, canvas: element, boundsCache })
    const sectionableDepth = new SectionableCameraDepthLifecycle(boundsCache, safety)
    disposables.push(() => safety.dispose())
    const body = bodyMesh(new THREE.Vector3(10, 10, 10), new THREE.Vector3(0, 0, 480))

    expect(sectionableDepth.register(body)?.ok).toBe(true)
    expect({ near: camera.near, far: camera.far }).not.toEqual({ near: 0.1, far: 2000 })

    camera.near = 0.5
    camera.far = 4800
    camera.updateProjectionMatrix()
    sectionableDepth.unregister(body)
    expect({ near: camera.near, far: camera.far }).toEqual({ near: 0.5, far: 4800 })
  })

  it('RED B: delete/unregister last body then open sketch restores the authored slab and one drawable scene', () => {
    const { camera, boundsCache, depthExtentRoots, safety } = authoredRig()
    const sectionableDepth = new SectionableCameraDepthLifecycle(boundsCache, safety)
    const scene = new THREE.Scene()
    const body = bodyMesh(new THREE.Vector3(10, 10, 10), new THREE.Vector3(0, 0, 480))
    body.name = 'stale-deleted-body'
    const bodyEdgesGeometry = new THREE.EdgesGeometry(body.geometry)
    const bodyEdgesMaterial = new THREE.LineBasicMaterial()
    const bodyEdges = new THREE.LineSegments(bodyEdgesGeometry, bodyEdgesMaterial)
    bodyEdges.position.copy(body.position)
    bodyEdges.name = 'stale-deleted-body-edges'
    disposables.push(() => {
      bodyEdgesGeometry.dispose()
      bodyEdgesMaterial.dispose()
    })

    const datum = bodyMesh(new THREE.Vector3(2, 2, 2), new THREE.Vector3(0, 0, 0))
    datum.name = 'live-ambient-datum'
    const survivorOutline = bodyMesh(new THREE.Vector3(40, 20, 0.01), new THREE.Vector3(0, 0, -250))
    survivorOutline.name = 'live-surviving-outline'
    scene.add(body, bodyEdges, datum, survivorOutline)

    const fitted = sectionableDepth.register(body)
    expect(fitted?.ok, 'create body -> production camera policy fits it').toBe(true)
    expect({ near: camera.near, far: camera.far }).not.toEqual({ near: 0.25, far: 3200 })

    scene.remove(body, bodyEdges)
    sectionableDepth.unregister(body)

    const grid = bodyMesh(new THREE.Vector3(400, 400, 0.01), new THREE.Vector3(0, 0, -500))
    grid.name = 'live-sketch-grid'
    const activeSketch = bodyMesh(new THREE.Vector3(60, 40, 0.01), new THREE.Vector3(0, 0, -1000))
    activeSketch.name = 'live-active-sketch'
    scene.add(grid, activeSketch)
    depthExtentRoots.register(grid)
    depthExtentRoots.register(activeSketch)
    safety.onBoundsChanged()
    scene.updateMatrixWorld(true)

    expect(
      { near: camera.near, far: camera.far },
      'delete/unregister -> open sketch restores the latest authored baseline',
    ).toEqual({ near: 0.25, far: 3200 })
    for (const [object, label] of [
      [datum, 'ambient datum'],
      [grid, 'sketch grid'],
      [activeSketch, 'active sketch primitive'],
      [survivorOutline, 'surviving outline'],
    ] as const) {
      expectObjectDepthVisible(camera, object, label)
    }
    expect(scene.getObjectByName('stale-deleted-body')).toBeUndefined()
    expect(scene.getObjectByName('stale-deleted-body-edges')).toBeUndefined()
    expect(scene.getObjectByName('live-surviving-outline')).toBe(survivorOutline)
  })

  it.each([
    ['non-finite', Number.NaN, 3200],
    ['unordered', 3200, 0.25],
  ])('invalid authored slab (%s) refuses by name without mutating the prior camera', (_label, near, far) => {
    const element = canvas()
    const camera = new THREE.OrthographicCamera(-20, 20, 20, -20, 0.5, 2400)
    camera.position.set(10, -20, 300)
    camera.up.set(0, 0, 1)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    let controls = controlsFor(camera, element, new THREE.Vector3())
    const before = captureDebugCameraState(camera, controls.target)

    expect(() => {
      controls = restoreDebugCameraState(
        camera,
        controls,
        { ...authoredState, near, far },
        (previous, target) => {
          previous.dispose()
          return controlsFor(camera, element, target)
        },
      )
    }).toThrowError('camera-depth-refused-invalid-authored-slab')
    expect(captureDebugCameraState(camera, controls.target)).toEqual(before)
  })
})
