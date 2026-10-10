// @vitest-environment jsdom
//
// WO UI-23 (C4) + UI-23-R1 (audit finding 3, "non-production tests"):
// perspective/orthographic swap. The prior version of this file REIMPLEMENTED
// setCameraProjection's math in a test-local perspectiveToOrthographic
// helper, so a regression in the real formula could not fail it. This
// version instead calls buildProjectionSwapCamera -- the literal function
// setCameraProjection (sceneRuntime.ts) now delegates to -- directly against
// real THREE.PerspectiveCamera/OrthographicCamera instances. No
// WebGLRenderer is needed for this math (only createDefaultSceneRuntime's
// renderer construction needs a real GL context, which jsdom lacks); the
// OrbitControls/gate-rebuild half of setCameraProjection is production
// plumbing around this same function, not reimplemented here.

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  buildProjectionSwapCamera,
  captureDebugCameraState,
  distanceForRadius,
  restoreDebugCameraState,
} from '../../components/model3d/sceneRuntime'

function createTestOrbitControls(camera: THREE.Camera, target: THREE.Vector3): OrbitControls {
  const controls = new OrbitControls(camera, document.createElement('canvas'))
  controls.target.copy(target)
  controls.update()
  return controls
}

function rebindTestOrbitControls(
  camera: THREE.Camera,
  controls: OrbitControls,
  target: THREE.Vector3,
): OrbitControls {
  controls.dispose()
  return createTestOrbitControls(camera, target)
}

describe('WO UI-23 (C4): projection swap preserves the apparent view (production buildProjectionSwapCamera)', () => {
  it('the orbit target stays exactly centered (NDC 0,0) across a perspective -> orthographic swap', () => {
    const target = new THREE.Vector3(5, -3, 2)
    const persp = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
    persp.up.set(0, 0, 1)
    persp.position.set(105, -83, 67)
    persp.lookAt(target)
    persp.updateProjectionMatrix()
    persp.updateMatrixWorld(true)

    const ortho = buildProjectionSwapCamera(persp, target, 'orthographic', 800 / 600) as THREE.OrthographicCamera
    ortho.updateMatrixWorld(true)
    const ndc = target.clone().project(ortho)
    expect(ndc.x).toBeCloseTo(0, 6)
    expect(ndc.y).toBeCloseTo(0, 6)
    // dot(viewDir, normal) contract, C3/C4's shared "final camera pose" ask:
    // the swap must not have altered the view DIRECTION, only the projection.
    const viewDirBefore = target.clone().sub(persp.position).normalize()
    const viewDirAfter = target.clone().sub(ortho.position).normalize()
    expect(viewDirAfter.dot(viewDirBefore)).toBeCloseTo(1, 6)
  })

  it('a point on the target plane keeps the SAME projected pixel across the swap (zoom scale preserved)', () => {
    const target = new THREE.Vector3(0, 0, 0)
    const persp = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
    persp.up.set(0, 0, 1)
    persp.position.set(85, -85, 65)
    persp.lookAt(target)
    persp.updateProjectionMatrix()
    persp.updateMatrixWorld(true)

    // A point offset from target, in the plane perpendicular to the view
    // direction at the target's depth -- exactly the "an object at the target
    // plane subtends the same fraction of the viewport" contract.
    const viewDir = persp.position.clone().sub(target).normalize()
    const worldUp = new THREE.Vector3(0, 0, 1)
    const right = new THREE.Vector3().crossVectors(viewDir, worldUp).normalize()
    const offPoint = target.clone().addScaledVector(right, 8)

    const ndcBefore = offPoint.clone().project(persp)

    const ortho = buildProjectionSwapCamera(persp, target, 'orthographic', 800 / 600) as THREE.OrthographicCamera
    ortho.updateMatrixWorld(true)
    const ndcAfter = offPoint.clone().project(ortho)

    expect(ndcAfter.x).toBeCloseTo(ndcBefore.x, 3)
    expect(ndcAfter.y).toBeCloseTo(ndcBefore.y, 3)
  })

  it('swapping back orthographic -> perspective reproduces the SAME apparent framing (round trip)', () => {
    const target = new THREE.Vector3(0, 0, 0)
    const persp = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
    persp.up.set(0, 0, 1)
    persp.position.set(85, -85, 65)
    persp.lookAt(target)
    persp.updateProjectionMatrix()
    persp.updateMatrixWorld(true)

    const viewDir = persp.position.clone().sub(target).normalize()
    const right = new THREE.Vector3().crossVectors(viewDir, new THREE.Vector3(0, 0, 1)).normalize()
    const offPoint = target.clone().addScaledVector(right, 8)
    const ndcOriginal = offPoint.clone().project(persp)

    const ortho = buildProjectionSwapCamera(persp, target, 'orthographic', 800 / 600) as THREE.OrthographicCamera
    ortho.updateMatrixWorld(true)
    const perspBack = buildProjectionSwapCamera(ortho, target, 'perspective', 800 / 600) as THREE.PerspectiveCamera
    perspBack.updateMatrixWorld(true)
    const ndcBack = offPoint.clone().project(perspBack)

    expect(ndcBack.x).toBeCloseTo(ndcOriginal.x, 3)
    expect(ndcBack.y).toBeCloseTo(ndcOriginal.y, 3)
    // Target still centered.
    expect(target.clone().project(perspBack).x).toBeCloseTo(0, 6)
    expect(target.clone().project(perspBack).y).toBeCloseTo(0, 6)
  })

  it('distanceForRadius: orthographic branch never divides by a perspective FOV (no NaN when camera has no .fov)', () => {
    const ortho = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 2000)
    const dist = distanceForRadius(ortho, 25)
    expect(Number.isFinite(dist)).toBe(true)
    expect(dist).toBeGreaterThan(0)
  })

  it('UI-34: production debug capture keeps every orthographic frustum field', () => {
    const camera = new THREE.OrthographicCamera(-91, 109, 70, -50, 0.25, 3200)
    camera.position.set(123, -77, 61)
    camera.up.set(0.2, 0.1, 1)
    camera.zoom = 1.75
    const target = { x: 5, y: 5, z: 5 }

    expect(captureDebugCameraState(camera, target)).toEqual({
      position: { x: 123, y: -77, z: 61 },
      target,
      up: { x: 0.2, y: 0.1, z: 1 },
      projection: 'orthographic',
      left: -91,
      right: 109,
      top: 70,
      bottom: -50,
      zoom: 1.75,
      near: 0.25,
      far: 3200,
    })
  })

  it('UI-34-R1: the first orbit uses the restored non-Z-up axis', () => {
    const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 2000)
    camera.position.set(40, -30, 20)
    camera.up.set(0, 0, 1)
    const target = new THREE.Vector3(0, 0, 0)
    let controls = createTestOrbitControls(camera, target)
    const restoredUp = new THREE.Vector3(0.2, 0.1, 1).normalize()
    const state = {
      projection: 'orthographic' as const,
      position: { x: 10, y: 0, z: 0 },
      target: { x: 0, y: 0, z: 0 },
      up: { x: restoredUp.x, y: restoredUp.y, z: restoredUp.z },
      left: -91,
      right: 109,
      top: 70,
      bottom: -50,
      zoom: 1.75,
      near: 0.25,
      far: 3200,
    }

    controls = restoreDebugCameraState(
      camera,
      controls,
      state,
      (previous, restoredTarget) => rebindTestOrbitControls(camera, previous, restoredTarget),
    )

    const expectedCamera = camera.clone() as THREE.OrthographicCamera
    const expectedControls = createTestOrbitControls(expectedCamera, controls.target)
    const beforeOrbit = camera.position.clone()
    controls.rotateLeft(0.1)
    controls.update()
    expectedControls.rotateLeft(0.1)
    expectedControls.update()

    expect(camera.position.distanceTo(beforeOrbit)).toBeGreaterThan(0.01)
    expect(camera.position.distanceTo(expectedCamera.position)).toBeLessThan(1e-10)
    controls.dispose()
    expectedControls.dispose()
  })

  it('UI-34-R1: production restore preserves perspective camera state', () => {
    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000)
    camera.position.set(40, -30, 20)
    camera.up.set(0, 0, 1)
    let controls = createTestOrbitControls(camera, new THREE.Vector3())
    const state = {
      projection: 'perspective' as const,
      position: { x: 83, y: -41, z: 29 },
      target: { x: 7, y: 2, z: -3 },
      up: { x: 0.25, y: 0.5, z: 1 },
      fov: 37,
    }

    controls = restoreDebugCameraState(
      camera,
      controls,
      state,
      (previous, restoredTarget) => rebindTestOrbitControls(camera, previous, restoredTarget),
    )

    const restored = captureDebugCameraState(camera, controls.target)
    expect(restored.projection).toBe('perspective')
    if (restored.projection !== 'perspective') throw new Error('production restore changed projection')
    expect(restored.position.x).toBeCloseTo(state.position.x, 12)
    expect(restored.position.y).toBeCloseTo(state.position.y, 12)
    expect(restored.position.z).toBeCloseTo(state.position.z, 12)
    expect(restored.target.x).toBeCloseTo(state.target.x, 12)
    expect(restored.target.y).toBeCloseTo(state.target.y, 12)
    expect(restored.target.z).toBeCloseTo(state.target.z, 12)
    expect(restored.up).toEqual(state.up)
    expect(restored.fov).toBe(state.fov)
    controls.dispose()
  })
})
