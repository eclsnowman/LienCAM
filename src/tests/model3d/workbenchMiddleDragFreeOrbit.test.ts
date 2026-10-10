// @vitest-environment jsdom
//
// WO UI-23 (C1 + C2, Operator's hands-on findings): middle-drag orbit / ctrl+
// middle-drag pan, and free (pole-continuous) orbit -- both against a REAL
// OrbitControls + the REAL shared navPresetController, same pattern as
// workbenchNavRightDragOrbit.test.ts (that file's own template comment).
//
// jsdom notes: same as workbenchNavRightDragOrbit.test.ts -- OrbitControls
// attaches native pointer listeners and calls setPointerCapture, which jsdom
// lacks (stubbed as no-ops); jsdom has no PointerEvent, so a MouseEvent with
// pointerId/pointerType defined stands in (OrbitControls only reads those two
// fields plus button/clientX/clientY/modifiers).

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createNavPresetController } from '../../lib/viewport/navPresetController'
import {
  applyPresetCameraView,
  applyWorkbenchMiddleDragOverride,
  foldPolarAngle,
  installFreeOrbit,
  willResolveToRotate,
  zUpOffsetFromSpherical,
  zUpSphericalFromOffset,
} from '../../components/model3d/sceneRuntime'
import { NAV_PRESETS, type NavPresetId } from '../../types'

function pointerEvent(
  type: string,
  props: { clientX: number; clientY: number; button?: number; ctrlKey?: boolean },
): MouseEvent {
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

function drag(
  canvas: HTMLCanvasElement,
  button: number,
  points: Array<{ x: number; y: number }>,
  opts?: { ctrlKey?: boolean },
): void {
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: points[0].x, clientY: points[0].y, button, ctrlKey: opts?.ctrlKey }))
  for (let i = 1; i < points.length; i++) {
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: points[i].x, clientY: points[i].y, button, ctrlKey: opts?.ctrlKey }))
  }
  const last = points[points.length - 1]
  canvas.dispatchEvent(pointerEvent('pointerup', { clientX: last.x, clientY: last.y, button, ctrlKey: opts?.ctrlKey }))
}

describe('WO UI-23 C1: workbench middle-drag = orbit, Ctrl+middle-drag = pan (liencnc-default only)', () => {
  it('applyWorkbenchMiddleDragOverride maps MIDDLE to ROTATE on liencnc-default only', () => {
    for (const presetId of Object.keys(NAV_PRESETS) as NavPresetId[]) {
      const mouseButtons: { MIDDLE?: THREE.MOUSE | null } = { MIDDLE: THREE.MOUSE.DOLLY }
      applyWorkbenchMiddleDragOverride(mouseButtons, presetId)
      if (presetId === 'liencnc-default') expect(mouseButtons.MIDDLE).toBe(THREE.MOUSE.ROTATE)
      else expect(mouseButtons.MIDDLE).toBe(THREE.MOUSE.DOLLY) // untouched
    }
  })

  it('a real middle-drag orbits: camera pose changes, orbit target stays fixed', () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)
    applyWorkbenchMiddleDragOverride(controls.mouseButtons, 'liencnc-default')
    expect(controls.mouseButtons.MIDDLE).toBe(THREE.MOUSE.ROTATE)

    const before = camera.position.clone()
    drag(canvas, 1, [{ x: 400, y: 300 }, { x: 480, y: 300 }])
    expect(camera.position.distanceTo(before)).toBeGreaterThan(1e-3)
    expect(controls.target.length()).toBeLessThan(1e-9) // rotate, not pan: target untouched
    nav.dispose()
    controls.dispose()
  })

  it('Ctrl+middle-drag pans: orbit target moves (OrbitControls\' own modifier swap, no extra remap code)', () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)
    applyWorkbenchMiddleDragOverride(controls.mouseButtons, 'liencnc-default')

    const beforePos = camera.position.clone()
    drag(canvas, 1, [{ x: 400, y: 300 }, { x: 480, y: 300 }], { ctrlKey: true })
    expect(controls.target.length()).toBeGreaterThan(1e-3) // pan: target moved
    expect(camera.position.distanceTo(beforePos)).toBeGreaterThan(1e-3)
    nav.dispose()
    controls.dispose()
  })

  it('a middle CLICK (zero travel) leaves the camera pose unchanged (no perceptible orbit)', () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)
    applyWorkbenchMiddleDragOverride(controls.mouseButtons, 'liencnc-default')

    const beforePos = camera.position.clone()
    const beforeTarget = controls.target.clone()
    drag(canvas, 1, [{ x: 400, y: 300 }, { x: 400, y: 300 }])
    // Unlike RIGHT (which the sketch override arms to null until a drag
    // exceeds a pixel threshold, so a click never even reaches update()),
    // MIDDLE latches ROTATE at pointerdown same as today's stock mapping --
    // a zero-delta move still round-trips position through OrbitControls'
    // spherical<->cartesian conversion, so this asserts NO PERCEPTIBLE
    // movement (tight tolerance), not bit-exact equality (never a property
    // of this button, before or after this override).
    expect(camera.position.distanceTo(beforePos)).toBeLessThan(1e-9)
    expect(controls.target.distanceTo(beforeTarget)).toBeLessThan(1e-9)
    nav.dispose()
    controls.dispose()
  })

  it('every OTHER preset\'s mouseButtons mapping is byte-unchanged by the override', () => {
    const { controls, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    for (const presetId of Object.keys(NAV_PRESETS) as NavPresetId[]) {
      nav.apply(presetId, false, false)
      const before = JSON.stringify(controls.mouseButtons)
      applyWorkbenchMiddleDragOverride(controls.mouseButtons, presetId)
      if (presetId === 'liencnc-default') {
        expect(controls.mouseButtons.MIDDLE).toBe(THREE.MOUSE.ROTATE)
      } else {
        expect(JSON.stringify(controls.mouseButtons), presetId).toBe(before)
      }
    }
    nav.dispose()
    controls.dispose()
  })
})

describe('WO UI-23 C2: foldPolarAngle / zUp spherical helpers (pure)', () => {
  it('phi within [0, PI] folds to itself with no theta flip', () => {
    for (const phi of [0, 0.001, Math.PI / 2, Math.PI - 0.001, Math.PI]) {
      const { phi: folded, thetaFlip } = foldPolarAngle(phi)
      expect(folded).toBeCloseTo(phi, 9)
      expect(thetaFlip).toBe(false)
    }
  })

  it('phi just past PI (crossed one pole) mirrors back with a theta flip', () => {
    const { phi, thetaFlip } = foldPolarAngle(Math.PI + 0.3)
    expect(phi).toBeCloseTo(Math.PI - 0.3, 9)
    expect(thetaFlip).toBe(true)
  })

  it('phi past 2*PI (crossed both poles, back to start) folds with no flip', () => {
    const { phi, thetaFlip } = foldPolarAngle(2 * Math.PI + 0.4)
    expect(phi).toBeCloseTo(0.4, 9)
    expect(thetaFlip).toBe(false)
  })

  it('negative phi (dragging the other way past the near pole) mirrors correctly', () => {
    const { phi, thetaFlip } = foldPolarAngle(-0.3)
    expect(phi).toBeCloseTo(0.3, 9)
    expect(thetaFlip).toBe(true)
  })

  it('zUpSphericalFromOffset / zUpOffsetFromSpherical round-trip', () => {
    const offset = { x: 30, y: -40, z: 50 }
    const { radius, theta, phi } = zUpSphericalFromOffset(offset)
    const back = zUpOffsetFromSpherical(radius, theta, phi)
    expect(back.x).toBeCloseTo(offset.x, 9)
    expect(back.y).toBeCloseTo(offset.y, 9)
    expect(back.z).toBeCloseTo(offset.z, 9)
  })
})

describe('WO UI-23 C2: willResolveToRotate mirrors OrbitControls\' own modifier swap', () => {
  const NONE = { shift: false, ctrl: false, meta: false }
  const CTRL = { shift: false, ctrl: true, meta: false }
  it('bare ROTATE is a rotate; modified ROTATE swaps away (becomes pan)', () => {
    expect(willResolveToRotate(THREE.MOUSE.ROTATE, NONE)).toBe(true)
    expect(willResolveToRotate(THREE.MOUSE.ROTATE, CTRL)).toBe(false)
  })
  it('bare PAN is not a rotate; modified PAN swaps IN to rotate', () => {
    expect(willResolveToRotate(THREE.MOUSE.PAN, NONE)).toBe(false)
    expect(willResolveToRotate(THREE.MOUSE.PAN, CTRL)).toBe(true)
  })
  it('DOLLY and null never resolve to rotate, modifiers or not', () => {
    expect(willResolveToRotate(THREE.MOUSE.DOLLY, NONE)).toBe(false)
    expect(willResolveToRotate(THREE.MOUSE.DOLLY, CTRL)).toBe(false)
    expect(willResolveToRotate(null, NONE)).toBe(false)
    expect(willResolveToRotate(undefined, CTRL)).toBe(false)
  })
})

describe('WO UI-23 C2: free orbit -- continues through the pole (no jam, no NaN)', () => {
  it.each(['top', 'bottom'] as const)(
    'WO UI-29 B6: %s exact-pole preset starts a bounded, finite orbit path',
    (view) => {
      const { controls, camera, canvas } = makeControls()
      const nav = createNavPresetController(controls, canvas)
      nav.apply('liencnc-default', false, false)
      const freeOrbit = installFreeOrbit(controls, camera, canvas)

      applyPresetCameraView(camera, controls, view)
      const expectedAxis = new THREE.Vector3(0, 0, view === 'top' ? 1 : -1)
      const radius0 = camera.position.distanceTo(controls.target)
      const initialAxis = camera.position.clone().sub(controls.target).normalize()
      expect(initialAxis.dot(expectedAxis), `${view} still faces exactly down its axis`).toBeCloseTo(1, 10)
      expect(camera.position.x, `${view} exact-pole x`).toBeCloseTo(controls.target.x, 12)
      expect(camera.position.y, `${view} exact-pole y`).toBeCloseTo(controls.target.y, 12)
      expect(camera.up.equals(new THREE.Vector3(0, 1, 0)), `${view} uses deterministic +Y screen-up`).toBe(true)

      const quats: THREE.Quaternion[] = [camera.quaternion.clone()]
      const rights: THREE.Vector3[] = [new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)]
      const ups: THREE.Vector3[] = [new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)]
      const positions: THREE.Vector3[] = [camera.position.clone()]

      let y = 300
      canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 400, clientY: y, button: 0 }))
      const STEP_PX = 3
      for (let i = 0; i < 60; i++) {
        y += STEP_PX
        canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 400, clientY: y, button: 0 }))
        quats.push(camera.quaternion.clone())
        rights.push(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion))
        ups.push(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion))
        positions.push(camera.position.clone())
      }
      canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 400, clientY: y, button: 0 }))

      const expectedStepRad = (2 * Math.PI * STEP_PX) / 600
      const jumpBound = expectedStepRad * 10
      for (let i = 0; i < positions.length; i++) {
        const values = [...positions[i].toArray(), ...quats[i].toArray(), ...rights[i].toArray(), ...ups[i].toArray()]
        expect(values.every(Number.isFinite), `${view} frame ${i} has finite pose and basis data`).toBe(true)
        expect(positions[i].distanceTo(controls.target), `${view} frame ${i} preserves radius`).toBeCloseTo(radius0, 6)
        if (i === 0) continue
        expect(quats[i].angleTo(quats[i - 1]), `${view} frame ${i} quaternion step`).toBeLessThan(jumpBound)
        expect(rights[i].angleTo(rights[i - 1]), `${view} frame ${i} screen-right step`).toBeLessThan(jumpBound)
        expect(ups[i].angleTo(ups[i - 1]), `${view} frame ${i} screen-up step`).toBeLessThan(jumpBound)
      }
      expect(quats[0].angleTo(quats[quats.length - 1]), `${view} path is non-vacuous`).toBeGreaterThan(0.5)

      freeOrbit.dispose()
      nav.dispose()
      controls.dispose()
    },
  )

  it('WO UI-29 B6: a collinear pole-start camera.up is reseeded without a first-step basis flip', () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)
    const freeOrbit = installFreeOrbit(controls, camera, canvas)

    applyPresetCameraView(camera, controls, 'top')
    const beforeQuaternion = camera.quaternion.clone()
    const beforeRight = new THREE.Vector3(1, 0, 0).applyQuaternion(beforeQuaternion)
    const beforeUp = new THREE.Vector3(0, 1, 0).applyQuaternion(beforeQuaternion)
    // Preserve the valid screen frame but force the exact bad seed UI-29 found:
    // camera.up parallel to the target-to-camera direction at the north pole.
    camera.up.set(0, 0, 1)

    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 400, clientY: 300, button: 0 }))
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 400, clientY: 303, button: 0 }))
    canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 400, clientY: 303, button: 0 }))

    const afterRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
    const afterUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
    expect(camera.quaternion.toArray().every(Number.isFinite), 'finite first-step quaternion').toBe(true)
    expect(camera.quaternion.angleTo(beforeQuaternion), 'bounded first-step rotation').toBeLessThan(Math.PI / 4)
    expect(afterRight.dot(beforeRight), 'screen-right does not mirror').toBeGreaterThan(0)
    expect(afterUp.dot(beforeUp), 'screen-up does not mirror').toBeGreaterThan(0)

    freeOrbit.dispose()
    nav.dispose()
    controls.dispose()
  })

  it.each(['top', 'bottom'] as const)(
    'WO UI-29-R1: %s exact-pole NaN camera.up reseeds a finite bounded first step',
    (view) => {
      const { controls, camera, canvas } = makeControls()
      const nav = createNavPresetController(controls, canvas)
      nav.apply('liencnc-default', false, false)
      const freeOrbit = installFreeOrbit(controls, camera, canvas)

      applyPresetCameraView(camera, controls, view)
      const beforeQuaternion = camera.quaternion.clone()
      const beforeRight = new THREE.Vector3(1, 0, 0).applyQuaternion(beforeQuaternion)
      const beforeUp = new THREE.Vector3(0, 1, 0).applyQuaternion(beforeQuaternion)
      const radius0 = camera.position.distanceTo(controls.target)
      camera.up.set(Number.NaN, 0, 1)

      canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 400, clientY: 300, button: 0 }))
      canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 400, clientY: 303, button: 0 }))
      canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 400, clientY: 303, button: 0 }))

      const afterRight = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
      const afterUp = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
      expect(camera.quaternion.toArray().every(Number.isFinite), `${view} finite quaternion`).toBe(true)
      expect(afterRight.toArray().every(Number.isFinite), `${view} finite screen-right`).toBe(true)
      expect(afterUp.toArray().every(Number.isFinite), `${view} finite screen-up`).toBe(true)
      expect(camera.position.distanceTo(controls.target), `${view} preserves radius`).toBeCloseTo(radius0, 6)
      expect(camera.quaternion.angleTo(beforeQuaternion), `${view} bounded quaternion step`).toBeLessThan(Math.PI / 4)
      expect(afterRight.angleTo(beforeRight), `${view} bounded screen-right step`).toBeLessThan(Math.PI / 4)
      expect(afterUp.angleTo(beforeUp), `${view} bounded screen-up step`).toBeLessThan(Math.PI / 4)
      expect(camera.quaternion.angleTo(beforeQuaternion), `${view} orbit step is non-vacuous`).toBeGreaterThan(1e-4)

      freeOrbit.dispose()
      nav.dispose()
      controls.dispose()
    },
  )

  it('WO UI-29-R1: a non-finite view direction refuses pointerdown before stock rotate can consume it', () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)
    const freeOrbit = installFreeOrbit(controls, camera, canvas)

    const beforeQuaternion = camera.quaternion.clone()
    camera.position.x = Number.NaN
    const down = pointerEvent('pointerdown', { clientX: 400, clientY: 300, button: 0 })
    const accepted = canvas.dispatchEvent(down)
    canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 400, clientY: 303, button: 0 }))
    canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 400, clientY: 303, button: 0 }))

    expect(accepted, 'canceled pointerdown reports refusal to the dispatcher').toBe(false)
    expect(down.defaultPrevented, 'invalid pointerdown is canceled').toBe(true)
    expect(camera.quaternion.toArray().every(Number.isFinite), 'stock rotate did not poison the quaternion').toBe(true)
    expect(camera.quaternion.angleTo(beforeQuaternion), 'stock rotate never consumed the move').toBeLessThan(1e-12)

    freeOrbit.dispose()
    nav.dispose()
    controls.dispose()
  })

  it('WITHOUT installFreeOrbit, stock OrbitControls JAMS at the pole (documents the root cause)', () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)

    // One big drag straight down -- far more than enough phi delta (2*PI*dy/600)
    // to run the polar angle (~1.075 rad from +Z here) past the pole and pin it
    // at Spherical.makeSafe()'s EPS boundary.
    drag(canvas, 0, [{ x: 400, y: 300 }, { x: 400, y: 300 + 4000 }])
    const afterFirstJam = camera.position.clone()
    // Keep dragging further in the SAME direction: stock behavior discards the
    // extra delta once pinned at the safety boundary -- position stops moving.
    drag(canvas, 0, [{ x: 400, y: 300 }, { x: 400, y: 300 + 4000 }])
    expect(camera.position.distanceTo(afterFirstJam)).toBeLessThan(1e-9)
    nav.dispose()
    controls.dispose()
  })

  it('WITH installFreeOrbit, the SAME repeated past-pole drag keeps moving the camera -- no jam', () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)
    const freeOrbit = installFreeOrbit(controls, camera, canvas)

    const positions: THREE.Vector3[] = [camera.position.clone()]
    // 20 incremental steps of a real multi-move drag, several multiples of a
    // full pole-to-pole meridian sweep (PI rad) -- "as much as I want".
    let y = 300
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 400, clientY: y, button: 0 }))
    for (let i = 0; i < 20; i++) {
      y += 150
      canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 400, clientY: y, button: 0 }))
      positions.push(camera.position.clone())
    }
    canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 400, clientY: y, button: 0 }))

    // No jam: every consecutive pair of positions differs (camera keeps moving
    // the whole way through, including past where the stock test above jammed).
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].distanceTo(positions[i - 1]), `step ${i}`).toBeGreaterThan(1e-4)
    }
    // No NaN pose anywhere along the path.
    for (const p of positions) {
      expect(Number.isFinite(p.x) && Number.isFinite(p.y) && Number.isFinite(p.z), 'finite position').toBe(true)
    }
    // Orbit target untouched (a rotate, not a pan) and radius preserved
    // throughout (free orbit only changes angle, never distance).
    expect(controls.target.length()).toBeLessThan(1e-9)
    const radius0 = positions[0].distanceTo(controls.target)
    for (const p of positions) {
      expect(p.distanceTo(controls.target)).toBeCloseTo(radius0, 6)
    }
    freeOrbit.dispose()
    nav.dispose()
    controls.dispose()
  })

  it('azimuth (pure horizontal drag) stays exactly as continuous as before -- no theta-flip regression', () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)
    const freeOrbit = installFreeOrbit(controls, camera, canvas)

    const radius0 = camera.position.distanceTo(controls.target)
    let x = 400
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: x, clientY: 300, button: 0 }))
    const positions: THREE.Vector3[] = []
    for (let i = 0; i < 12; i++) {
      x += 300 // a full horizontal sweep several times over
      canvas.dispatchEvent(pointerEvent('pointermove', { clientX: x, clientY: 300, button: 0 }))
      positions.push(camera.position.clone())
    }
    canvas.dispatchEvent(pointerEvent('pointerup', { clientX: x, clientY: 300, button: 0 }))
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i].distanceTo(positions[i - 1]), `step ${i}`).toBeGreaterThan(1e-4)
    }
    for (const p of positions) expect(p.distanceTo(controls.target)).toBeCloseTo(radius0, 6)
    freeOrbit.dispose()
    nav.dispose()
    controls.dispose()
  })

  it('WO UI-23-R1 (audit blocker 1, mutation-pinned): orientation rolls through the pole -- no single-frame quaternion jump > 90deg', () => {
    // Reproduces the auditor's constructed adversarial pole-crossing probe
    // (+/-1e-6-class phi neighborhood, finite position but a PI-radian
    // quaternion jump on the pre-fix code): start a few degrees off the
    // north pole and drag through it with FINE-GRAINED per-event steps (3px
    // -- realistic single pointermove travel, not the coarse 150px steps the
    // no-jam position test above uses), sampling the camera's orientation
    // every frame.
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    nav.apply('liencnc-default', false, false)
    const freeOrbit = installFreeOrbit(controls, camera, canvas)

    const target = controls.target
    const radius = 80
    const phiStart = 0.05 // ~2.9deg off the pole
    camera.position.set(target.x + radius * Math.sin(phiStart), target.y, target.z + radius * Math.cos(phiStart))
    camera.up.set(0, 0, 1)
    camera.lookAt(target)
    controls.update()

    const quats: THREE.Quaternion[] = [camera.quaternion.clone()]
    const rights: THREE.Vector3[] = [new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion)]
    const ups: THREE.Vector3[] = [new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion)]
    let y = 300
    canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: 400, clientY: y, button: 0 }))
    const STEP_PX = 3
    for (let i = 0; i < 60; i++) {
      y += STEP_PX
      canvas.dispatchEvent(pointerEvent('pointermove', { clientX: 400, clientY: y, button: 0 }))
      quats.push(camera.quaternion.clone())
      rights.push(new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion))
      ups.push(new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion))
    }
    canvas.dispatchEvent(pointerEvent('pointerup', { clientX: 400, clientY: y, button: 0 }))

    // Bound tied to the frame's own rotation step: at clientHeight=600 and a
    // constant 3px vertical step, OrbitControls' rotateSpeed=1 default
    // produces a phi delta of 2*PI*3/600 rad (~1.8deg) per step; a
    // continuous roll produces a per-frame ORIENTATION delta of the same
    // order (verified analytically: a pure-elevation sweep is a rigid
    // rotation of the whole frame by exactly that angle, no extra roll
    // accumulates). A generous 10x margin absorbs floating-point/OrbitControls
    // internals without weakening the "no snap" assertion -- it is still
    // FAR under the audit's 90deg/PI-radian failure signature.
    const expectedStepRad = (2 * Math.PI * STEP_PX) / 600
    const jumpBound = Math.min(Math.PI / 2, expectedStepRad * 10)
    for (let i = 1; i < quats.length; i++) {
      const delta = quats[i].angleTo(quats[i - 1])
      expect(delta, `frame ${i} orientation jump`).toBeLessThan(Math.PI / 2) // literal audit bound: no single-frame jump > 90deg
      expect(delta, `frame ${i} orientation jump vs frame step`).toBeLessThan(jumpBound)
      // Same failure signature the auditor measured directly: screen-right/
      // screen-up must not invert frame-to-frame (dot -> -1 is the bug).
      expect(rights[i].dot(rights[i - 1]), `frame ${i} screen-right dot`).toBeGreaterThan(0)
      expect(ups[i].dot(ups[i - 1]), `frame ${i} screen-up dot`).toBeGreaterThan(0)
    }
    // Sanity: this drag sequence actually traverses meaningful rotation (not
    // a no-op path that would make the above assertions vacuous).
    expect(quats[0].angleTo(quats[quats.length - 1])).toBeGreaterThan(0.5)

    freeOrbit.dispose()
    nav.dispose()
    controls.dispose()
  })

  it('outside an active rotate gesture, installFreeOrbit is a no-op: a pan drag behaves identically to stock', () => {
    const stock = makeControls()
    const stockNav = createNavPresetController(stock.controls, stock.canvas)
    stockNav.apply('onshape', false, false) // onshape: MIDDLE=pan

    const free = makeControls()
    const freeNav = createNavPresetController(free.controls, free.canvas)
    freeNav.apply('onshape', false, false)
    const freeOrbit = installFreeOrbit(free.controls, free.camera, free.canvas)

    drag(stock.canvas, 1, [{ x: 400, y: 300 }, { x: 460, y: 340 }])
    drag(free.canvas, 1, [{ x: 400, y: 300 }, { x: 460, y: 340 }])
    expect(free.camera.position.x).toBeCloseTo(stock.camera.position.x, 9)
    expect(free.camera.position.y).toBeCloseTo(stock.camera.position.y, 9)
    expect(free.camera.position.z).toBeCloseTo(stock.camera.position.z, 9)
    expect(free.controls.target.equals(stock.controls.target)).toBe(true)

    freeOrbit.dispose()
    stockNav.dispose()
    freeNav.dispose()
    stock.controls.dispose()
    free.controls.dispose()
  })
})
