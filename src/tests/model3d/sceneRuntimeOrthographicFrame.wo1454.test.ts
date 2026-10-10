// @vitest-environment jsdom
//
// WO-1454: frameBox() only ever moved camera.position/controls.target. For a
// perspective camera that IS the framing control, but an orthographic
// camera's apparent size is its frustum/zoom (distanceForRadius's own
// comment says so) -- so opening a model in orthographic left the viewport
// showing whatever frustum the camera happened to have before, cropping the
// newly-framed body. This drives applyFrameBox -- the ACTUAL function
// frameBox (sceneRuntime.ts) delegates to, extracted the same way
// applyOrientNormalToPoint already is -- directly against a real
// THREE.Camera, no WebGLRenderer/canvas needed for the math itself.

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { applyFrameBox, distanceForRadius } from '../../components/model3d/sceneRuntime'

function fakeControls(target: THREE.Vector3): { target: THREE.Vector3; update(): void } {
  let updateCalls = 0
  return {
    target,
    update() {
      updateCalls += 1
      void updateCalls
    },
  }
}

describe('WO-1454: applyFrameBox orthographic frustum fit', () => {
  it('resizes an orthographic camera frustum so the whole box fits (not just position/target)', () => {
    // A tiny leftover frustum, as if the camera had previously been framing
    // a much smaller body -- exactly the "cropped face" repro.
    const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 2000)
    camera.position.set(0, 0, 100)
    camera.up.set(0, 1, 0)
    camera.lookAt(0, 0, 0)
    camera.zoom = 2.5
    camera.updateProjectionMatrix()
    const controls = fakeControls(new THREE.Vector3(0, 0, 0))

    // A 600 x 400 x 150 assembly, centered at the origin -- the WO's own
    // repro numbers.
    const min = { x: -300, y: -200, z: -75 }
    const max = { x: 300, y: 200, z: 75 }

    applyFrameBox(camera, controls, min, max, 800, 600)

    // Camera looks straight down world Z here, so its local right/up axes
    // line up with world X/Y -- the box's world-space half-extents are
    // directly comparable to the frustum's world-space half-extents.
    const worldHalfWidth = (camera.right - camera.left) / 2 / camera.zoom
    const worldHalfHeight = (camera.top - camera.bottom) / 2 / camera.zoom
    expect(worldHalfWidth).toBeGreaterThanOrEqual(300)
    expect(worldHalfHeight).toBeGreaterThanOrEqual(200)
    expect(camera.zoom).toBe(1)
  })

  it('keeps the aspect ratio baked into left/right vs top/bottom', () => {
    const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 2000)
    camera.position.set(0, 0, 100)
    camera.up.set(0, 1, 0)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    const controls = fakeControls(new THREE.Vector3(0, 0, 0))

    applyFrameBox(camera, controls, { x: -50, y: -50, z: -10 }, { x: 50, y: 50, z: 10 }, 1600, 900)

    const halfWidth = (camera.right - camera.left) / 2
    const halfHeight = (camera.top - camera.bottom) / 2
    expect(halfWidth / halfHeight).toBeCloseTo(1600 / 900, 6)
  })

  it('preserves the current viewing direction for an orthographic camera', () => {
    const camera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.1, 2000)
    camera.position.set(40, -40, 30)
    camera.up.set(0, 0, 1)
    camera.lookAt(0, 0, 0)
    camera.updateProjectionMatrix()
    const controls = fakeControls(new THREE.Vector3(0, 0, 0))
    const originalDirection = camera.position.clone().sub(controls.target).normalize()

    applyFrameBox(camera, controls, { x: 90, y: 90, z: 90 }, { x: 110, y: 110, z: 110 }, 800, 600)

    const newDirection = camera.position.clone().sub(controls.target).normalize()
    expect(newDirection.dot(originalDirection)).toBeCloseTo(1, 6)
    expect(controls.target.x).toBeCloseTo(100, 6)
    expect(controls.target.y).toBeCloseTo(100, 6)
    expect(controls.target.z).toBeCloseTo(100, 6)
  })

  it('leaves the perspective camera path unchanged (position/target only, via the shared distanceForRadius formula)', () => {
    const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
    camera.position.set(85, -85, 65)
    camera.up.set(0, 0, 1)
    camera.lookAt(0, 0, 0)
    const controls = fakeControls(new THREE.Vector3(0, 0, 0))

    const min = { x: -50, y: -50, z: -25 }
    const max = { x: 50, y: 50, z: 25 }
    const radius = Math.max(new THREE.Vector3(100, 100, 50).length() / 2, 1e-3)
    const expectedDistance = distanceForRadius(camera, radius)

    applyFrameBox(camera, controls, min, max, 800, 600)

    expect(camera.position.distanceTo(controls.target)).toBeCloseTo(expectedDistance, 6)
    expect(controls.target.x).toBeCloseTo(0, 6)
    expect(controls.target.y).toBeCloseTo(0, 6)
    expect(controls.target.z).toBeCloseTo(0, 6)
    expect(camera.fov).toBe(45)
  })
})
