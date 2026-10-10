// @vitest-environment jsdom
//
// WO UI-30: Operator's real-app feel-check still sees a flip on the first orbit
// step after an exact Top/Bottom ViewCube snap. The UI-29 regression sampled
// only the final camera pose after pointermove returned. Production renders on
// every OrbitControls `change` event, so this repro records the basis at that
// same last-consumer boundary and refuses any transient mirror/roll.

import { describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import {
  applyPresetCameraView,
  applyWorkbenchMiddleDragOverride,
  installFreeOrbit,
} from '../../components/model3d/sceneRuntime'
import { createNavPresetController } from '../../lib/viewport/navPresetController'

function pointerEvent(
  type: string,
  props: { clientX: number; clientY: number; button: number },
): MouseEvent {
  const event = new MouseEvent(type, { bubbles: true, cancelable: true, ...props })
  Object.defineProperty(event, 'pointerId', { value: 1 })
  Object.defineProperty(event, 'pointerType', { value: 'mouse' })
  return event
}

function makeAppOrbitPath(): {
  camera: THREE.PerspectiveCamera
  canvas: HTMLCanvasElement
  controls: OrbitControls
  dispose(): void
} {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true })
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, width: 800, height: 600,
    right: 800, bottom: 600, x: 0, y: 0,
  }) as DOMRect
  ;(canvas as unknown as { setPointerCapture(id: number): void }).setPointerCapture = () => {}
  ;(canvas as unknown as { releasePointerCapture(id: number): void }).releasePointerCapture = () => {}

  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  camera.up.set(0, 0, 1)
  camera.position.set(85, -85, 65)
  const controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 0, 0)
  controls.enableDamping = false
  controls.update()

  const nav = createNavPresetController(controls, canvas)
  nav.apply('liencnc-default', false, false)
  applyWorkbenchMiddleDragOverride(controls.mouseButtons, 'liencnc-default')
  const freeOrbit = installFreeOrbit(controls, camera, canvas)

  return {
    camera,
    canvas,
    controls,
    dispose: () => {
      freeOrbit.dispose()
      nav.dispose()
      controls.dispose()
      canvas.remove()
    },
  }
}

interface CameraBasis {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  right: THREE.Vector3
  up: THREE.Vector3
}

function cameraBasis(camera: THREE.Camera): CameraBasis {
  return {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    right: new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion),
    up: new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion),
  }
}

describe('WO UI-30: Top/Bottom first-orbit render continuity', () => {
  it.each(['top', 'bottom'] as const)(
    '%s snap never emits a flipped basis during the first small middle-drag step',
    (view) => {
      const app = makeAppOrbitPath()
      applyPresetCameraView(app.camera, app.controls, view)
      const snapped = cameraBasis(app.camera)
      const rendered: CameraBasis[] = []

      // createDefaultSceneRuntime registers render at this same consumer:
      // controls.addEventListener('change', render).
      app.controls.addEventListener('change', () => rendered.push(cameraBasis(app.camera)))

      app.canvas.dispatchEvent(pointerEvent('pointerdown', {
        clientX: 400, clientY: 300, button: 1,
      }))
      app.canvas.dispatchEvent(pointerEvent('pointermove', {
        clientX: 400, clientY: 303, button: 1,
      }))
      app.canvas.dispatchEvent(pointerEvent('pointerup', {
        clientX: 400, clientY: 303, button: 1,
      }))

      expect(rendered.length, `${view} first step reaches the render consumer`).toBeGreaterThan(0)
      for (const [index, basis] of rendered.entries()) {
        const values = [
          ...basis.position.toArray(),
          ...basis.quaternion.toArray(),
          ...basis.right.toArray(),
          ...basis.up.toArray(),
        ]
        expect(values.every(Number.isFinite), `${view} render ${index} basis is finite`).toBe(true)
        expect(
          basis.quaternion.angleTo(snapped.quaternion),
          `${view} render ${index} quaternion remains continuous`,
        ).toBeLessThan(Math.PI / 2)
        expect(
          basis.right.dot(snapped.right),
          `${view} render ${index} screen-right does not mirror`,
        ).toBeGreaterThan(0)
        expect(
          basis.up.dot(snapped.up),
          `${view} render ${index} screen-up does not mirror`,
        ).toBeGreaterThan(0)

        // A vertical pointer delta must pitch in the plane containing the
        // snapped screen-up vector. Rotating in the orthogonal screen-right
        // plane is a 90deg axis discontinuity: the model yaws/rolls when the
        // user's hand requested pitch.
        const positionDelta = basis.position.clone().sub(snapped.position)
        const alongScreenUp = Math.abs(positionDelta.dot(snapped.up))
        const alongScreenRight = Math.abs(positionDelta.dot(snapped.right))
        expect(
          alongScreenUp,
          `${view} render ${index} vertical drag stays on the screen-up orbit axis`,
        ).toBeGreaterThan(alongScreenRight)
      }

      app.dispose()
    },
  )

  it('keeps the position-derived meridian just outside the pole guard', () => {
    const app = makeAppOrbitPath()
    applyPresetCameraView(app.camera, app.controls, 'top')
    const radius = app.camera.position.distanceTo(app.controls.target)
    const x = radius * 1e-6
    const z = Math.sqrt(radius * radius - x * x)
    app.camera.position.set(app.controls.target.x + x, app.controls.target.y, app.controls.target.z + z)
    app.camera.up.set(-z / radius, 0, x / radius)
    app.camera.lookAt(app.controls.target)
    app.controls.update()
    const before = app.camera.position.clone()

    app.canvas.dispatchEvent(pointerEvent('pointerdown', {
      clientX: 400, clientY: 300, button: 1,
    }))
    app.canvas.dispatchEvent(pointerEvent('pointermove', {
      clientX: 400, clientY: 303, button: 1,
    }))
    app.canvas.dispatchEvent(pointerEvent('pointerup', {
      clientX: 400, clientY: 303, button: 1,
    }))

    const delta = app.camera.position.clone().sub(before)
    expect(delta.toArray().every(Number.isFinite), 'outside-guard step stays finite').toBe(true)
    expect(Math.abs(delta.x), 'outside-guard step is non-vacuous').toBeGreaterThan(1e-4)
    expect(Math.abs(delta.x), 'outside-guard step stays on its original meridian').toBeGreaterThan(Math.abs(delta.y))

    app.dispose()
  })
})
