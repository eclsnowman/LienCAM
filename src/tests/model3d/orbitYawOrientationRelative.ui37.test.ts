// @vitest-environment jsdom
//
// WO UI-37 (Operator, T-UI34 step 5 + follow-up "check ALL rotational axes"):
// the free orbit is VIEW-RELATIVE (trackball) -- it rotates about the camera's
// CURRENT view axes, so NO rotational axis inverts from any pose, including
// over-the-top / upside-down. Drives the REAL installFreeOrbit against a REAL
// OrbitControls (same jsdom harness as workbenchMiddleDragFreeOrbit.test.ts).
//
// Can-fail: a world-Z-anchored yaw (the previous behavior, and the felt bug)
// rotates the screen-up about world Z as you drag horizontally, so across a
// large horizontal sweep the up vector SWINGS by the whole azimuth -- the
// "up preserved across the sweep" assertions below would fail. A view-relative
// yaw is a rotation ABOUT the current up, so up is preserved exactly, from any
// pose including Operator's over-the-top one.

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createNavPresetController } from '../../lib/viewport/navPresetController'
import { installFreeOrbit } from '../../components/model3d/sceneRuntime'

function pointerEvent(type: string, props: { clientX: number; clientY: number; button?: number }): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...props })
  Object.defineProperty(e, 'pointerId', { value: 1 })
  Object.defineProperty(e, 'pointerType', { value: 'mouse' })
  return e
}

function makeControls(): { controls: OrbitControls; camera: THREE.PerspectiveCamera; canvas: HTMLCanvasElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true })
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }) as DOMRect
  ;(canvas as unknown as { setPointerCapture(id: number): void }).setPointerCapture = () => {}
  ;(canvas as unknown as { releasePointerCapture(id: number): void }).releasePointerCapture = () => {}

  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  camera.up.set(0, 0, 1)
  camera.position.set(85, -85, 65)
  const controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 0, 0)
  controls.enableDamping = false
  controls.update()
  return { controls, camera, canvas }
}

/**
 * A single horizontal-drag gesture. Returns the camera.up captured right after
 * the FIRST move (once installFreeOrbit has seeded + orthonormalized the basis)
 * and after the LAST move, plus the start/end positions -- so a caller can
 * assert up is preserved ACROSS the sweep (view-relative yaw about current up).
 */
function horizontalSweep(canvas: HTMLCanvasElement, camera: THREE.PerspectiveCamera) {
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 400, clientY: 300, button: 0 }))
  canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 440, clientY: 300, button: 0 }))
  const upSeeded = camera.up.clone().normalize()
  const posSeeded = camera.position.clone()
  for (let i = 2; i <= 12; i++) {
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 400 + i * 40, clientY: 300, button: 0 }))
  }
  const upEnd = camera.up.clone().normalize()
  const posEnd = camera.position.clone()
  canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 880, clientY: 300, button: 0 }))
  return { upSeeded, upEnd, posSeeded, posEnd }
}

describe('UI-37 view-relative (trackball) orbit -- all axes relative, no over-the-top inversion', () => {
  it("over the top (Operator's reported pose), a horizontal sweep rotates about the CURRENT up -- up is preserved, not swung", () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)
    const free = installFreeOrbit(controls, camera, canvas)

    // Operator's exact over-the-top debug-scene pose (up.z < 0 = upside-down).
    controls.target.set(60, 35, 8)
    camera.position.set(89.63876205853495, 126.21873004980806, 194.5521028338033)
    camera.up.set(-0.24127110189173975, 0.8863932121094573, -0.39508901391740153)
    controls.update()
    expect(camera.up.z, 'setup: over the top / upside-down').toBeLessThan(0)

    const { upSeeded, upEnd, posSeeded, posEnd } = horizontalSweep(canvas, camera)
    // View-relative yaw is about the current up -> up preserved across the whole
    // sweep. World-Z yaw would swing up by the full azimuth (dot << 1) = the bug.
    expect(upEnd.dot(upSeeded), 'up preserved across a large horizontal sweep over the top').toBeGreaterThan(0.999)
    expect(camera.up.z, 'still over the top after horizontal drag (yaw did not right the camera)').toBeLessThan(0)
    expect(posEnd.distanceTo(posSeeded), 'horizontal drag actually orbits').toBeGreaterThan(1)
    expect(posEnd.distanceTo(controls.target), 'radius preserved').toBeCloseTo(posSeeded.distanceTo(controls.target), 3)

    free.dispose(); nav.dispose(); controls.dispose()
  })

  it('upright, a horizontal sweep also rotates about the current up (up preserved) -- consistent from every pose', () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)
    const free = installFreeOrbit(controls, camera, canvas)

    const { upSeeded, upEnd, posSeeded, posEnd } = horizontalSweep(canvas, camera)
    expect(upEnd.dot(upSeeded), 'up preserved across the upright horizontal sweep').toBeGreaterThan(0.999)
    expect(posEnd.distanceTo(posSeeded), 'orbits').toBeGreaterThan(1)

    free.dispose(); nav.dispose(); controls.dispose()
  })

  it('a pure vertical drag tilts the up (pitch about the current right axis) -- the axis that carries you over the top', () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)
    const free = installFreeOrbit(controls, camera, canvas)

    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 400, clientY: 300, button: 0 }))
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 400, clientY: 320, button: 0 }))
    const upSeeded = camera.up.clone().normalize()
    for (let i = 2; i <= 8; i++) canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 400, clientY: 300 + i * 20, button: 0 }))
    const upEnd = camera.up.clone().normalize()
    canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 400, clientY: 460, button: 0 }))

    expect(upEnd.dot(upSeeded), 'vertical drag tilts up (pitch changes orientation)').toBeLessThan(0.999)
    expect(Number.isFinite(camera.up.x) && Number.isFinite(camera.up.y) && Number.isFinite(camera.up.z)).toBe(true)

    free.dispose(); nav.dispose(); controls.dispose()
  })
})
