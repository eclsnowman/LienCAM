// @vitest-environment jsdom
//
// WO UI-79 F-C (Operator verdict T-UI57-PUSHPULL, finding F-C): "after dragging with
// the mouse it gets stuck on orbiting the part until I click in empty space".
//
// This is a CONSTRUCTED REPRO on the REAL controller: a real three.js
// OrbitControls (the exact instance sceneRuntime.ts builds -- `new
// OrbitControls(camera, canvas)`) sharing the SAME canvas as a real
// PushPullGizmo, wired to the SAME `onDraggingChange -> setOrbitEnabled(!dragging)`
// the parent uses. It drives Operator's repro literally -- grab the handle, drag,
// release, then move the mouse with NO button held -- and asserts the camera
// does NOT orbit.
//
// Root cause (proven by this file going RED when the fix is disabled): on the
// pointerdown that grabs the handle, OrbitControls (still enabled that instant
// -- the parent disables orbit only a step later, in onDraggingChange) LATCHES a
// rotate: it captures the pointer and installs pointermove/up listeners on the
// DOCUMENT (OrbitControls.js r184, onPointerDown). The gizmo's own pointerup
// stopPropagation then starves OrbitControls' document-level pointerup, so it
// never unwinds -- it stays in state ROTATE with orbit re-enabled on release,
// and the next buttonless move orbits until an empty-space click finally
// delivers a pointerup to the document. The gizmo's F-C fix
// (claimPointerExclusively: a synthetic pointercancel un-latches OrbitControls
// BEFORE the gizmo takes its own capture) removes that latch, so this test is
// GREEN.

import { describe, it, expect, afterEach } from 'vitest'
import { render, cleanup } from '@testing-library/react'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { PushPullGizmo } from '../../components/model3d/gizmos'

afterEach(cleanup)

/** Real OrbitControls + a canvas the way sceneRuntime builds them, minus WebGL.
 *  jsdom implements no Pointer Capture API and a zero-size layout, and
 *  OrbitControls does NOT try/catch either -- so both are stubbed to plausible
 *  values (the same technique PushPullGizmo.test.tsx uses for its own rect). */
function orbitHarness(distance = 150) {
  const scene = new THREE.Scene()
  const camera = new THREE.PerspectiveCamera(50, 800 / 600, 0.1, 2000)
  camera.position.set(10 + distance, 5, 0) // side-on to the face normal (+Z), face origin (10,5,0)
  camera.lookAt(10, 5, 0)
  camera.updateMatrixWorld(true)

  const canvas = document.createElement('div')
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => ({}),
  })
  Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true })
  const captured = new Set<number>()
  ;(canvas as unknown as { setPointerCapture(id: number): void }).setPointerCapture = (id) => { captured.add(id) }
  ;(canvas as unknown as { releasePointerCapture(id: number): void }).releasePointerCapture = (id) => { captured.delete(id) }
  ;(canvas as unknown as { hasPointerCapture(id: number): boolean }).hasPointerCapture = (id) => captured.has(id)
  document.body.appendChild(canvas)

  const controls = new OrbitControls(camera, canvas)
  const face = { origin: { x: 10, y: 5, z: 0 }, normal: { x: 0, y: 0, z: 1 } }
  return { scene, camera, canvas, controls, face }
}

/** clientX/clientY that projects (via the SAME camera) onto a world point. */
function screenPointFor(camera: THREE.Camera, world: THREE.Vector3): { x: number; y: number } {
  const ndc = world.clone().project(camera)
  return { x: ((ndc.x + 1) / 2) * 800, y: ((1 - ndc.y) / 2) * 600 }
}

function firePointer(target: EventTarget, type: string, x: number, y: number, pointerId = 1): void {
  target.dispatchEvent(new PointerEvent(type, { clientX: x, clientY: y, pointerId, button: 0, bubbles: true, cancelable: true }))
}

describe('PushPullGizmo x real OrbitControls (WO UI-79 F-C: orbit-stuck-after-drag)', () => {
  it("after a handle drag + release, a BUTTONLESS mouse move does NOT orbit the camera (Operator's stuck-orbit repro)", () => {
    const h = orbitHarness()
    // The parent's real wiring: orbit is enabled iff not dragging.
    render(
      <PushPullGizmo
        scene={h.scene}
        camera={h.camera}
        domElement={h.canvas}
        face={h.face}
        onDraggingChange={(dragging) => { h.controls.enabled = !dragging }}
      />,
    )

    const down = screenPointFor(h.camera, new THREE.Vector3(10, 5, 4)) // grab the shaft at +4
    const move = screenPointFor(h.camera, new THREE.Vector3(10, 5, 9)) // drag to +9

    // Grab the handle. OrbitControls latches a rotate on this very pointerdown;
    // the gizmo's F-C fix un-latches it before taking the drag.
    firePointer(h.canvas, 'pointerdown', down.x, down.y)
    firePointer(h.canvas, 'pointermove', move.x, move.y) // the drag
    firePointer(h.canvas, 'pointerup', move.x, move.y)    // RELEASE (stops drag; no commit)

    // Orbit has been handed back (dragging-false), the viewport should be neutral.
    expect(h.controls.enabled).toBe(true)
    const posAfterRelease = h.camera.position.clone()
    const quatAfterRelease = h.camera.quaternion.clone()

    // Operator's repro: move the mouse with NO button held. On the document, where
    // OrbitControls installs its move listener while a gesture is live.
    firePointer(document, 'pointermove', 300, 120)
    firePointer(document, 'pointermove', 380, 220)
    h.controls.update() // apply any pending controls delta (there must be none)

    // THE fix: the camera has not moved -- orbit is not stuck on.
    expect(h.camera.position.distanceTo(posAfterRelease)).toBeLessThan(1e-6)
    expect(h.camera.quaternion.angleTo(quatAfterRelease)).toBeLessThan(1e-6)

    h.controls.dispose()
  })
})
