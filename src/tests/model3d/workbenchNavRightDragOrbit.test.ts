// @vitest-environment jsdom
//
// WO UI-17 (Q-15, Operator-answered) + UI-17-R1 (audit finding 1): the
// OrbitControls half of right-drag orbit, now with the drag-threshold GATE in
// the camera path.
//
//   - On the liencnc-default preset, WITH the sketch-session override armed
//     AND the gate enabled (the exact wiring createDefaultSceneRuntime.applyNav
//     uses), a right-DRAG past the shared threshold really orbits: the camera
//     pose changes through a REAL OrbitControls + the REAL shared
//     navPresetController + the REAL gate (no fake mapping layer in between).
//   - AT-or-below the shared threshold (0px and the 4px boundary) the camera
//     pose is EXACTLY unchanged -- exact float equality, not a tolerance band
//     (WO UI-17-R1 hard constraint). The audit's 1-5px failure range is
//     covered by the 4px boundary case.
//   - Just past the threshold (6px) the camera orbits by the FULL travel, and
//     the gate's synthetic re-latch events do NOT bubble -- the frozen sketch
//     package measures contextmenu travel from a bubble-phase pointerdown on
//     the canvas's PARENT, so a bubbling synthetic would corrupt the menu
//     classification. (The menu halves themselves -- 4px opens, 6px does not
//     -- run against the REAL package in SolidsWorkbenchPage.ui17.test.tsx.)
//   - The gate threshold is pinned to the FROZEN package's private
//     RIGHT_DRAG_PAN_PX (one-source rule): a drift test parses the frozen
//     source and fails BY NAME if the two values ever diverge.
//   - Every OTHER preset's bindings are BYTE-UNCHANGED by the override, and
//     liencnc-default itself is byte-unchanged while no session is active.
//
// Also home to the pure sceneRuntime helper units: presetCameraPosition's
// documented pose table (AC5) and buildPlaneGrid's frame quaternion (AC6).
//
// jsdom notes: OrbitControls attaches native pointer listeners and calls
// setPointerCapture/releasePointerCapture, which jsdom lacks -- stubbed as
// no-ops. jsdom also has no PointerEvent; OrbitControls only reads
// pointerId/pointerType/button/clientX/clientY, so a MouseEvent with those
// two fields defined suffices (same trick the package mount tests use).

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createNavPresetController } from '../../lib/viewport/navPresetController'
import {
  applySketchRightDragOrbitOverride,
  buildPlaneGrid,
  createSketchRightDragOrbitGate,
  presetCameraPosition,
  RIGHT_DRAG_PAN_PX,
  type SketchRightDragOrbitGate,
} from '../../components/model3d/sceneRuntime'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import { NAV_PRESETS, type NavPresetId } from '../../types'

function pointerEvent(type: string, props: { clientX: number; clientY: number; button?: number }): MouseEvent {
  const e = new MouseEvent(type, { bubbles: true, cancelable: true, ...props })
  Object.defineProperty(e, 'pointerId', { value: 1 })
  Object.defineProperty(e, 'pointerType', { value: 'mouse' })
  return e
}

function makeControls(): {
  controls: OrbitControls
  camera: THREE.PerspectiveCamera
  canvas: HTMLCanvasElement
  container: HTMLElement
} {
  // The canvas sits inside a parent container, mirroring the workbench DOM:
  // the frozen sketch package's overlayHost (where it records the right-down
  // position for contextmenu classification) is the canvas's PARENT, reached
  // only by BUBBLING events -- the 6px boundary test asserts the gate's
  // synthetics never get there.
  const container = document.createElement('div')
  document.body.appendChild(container)
  const canvas = document.createElement('canvas')
  container.appendChild(canvas)
  Object.defineProperty(canvas, 'clientWidth', { value: 800, configurable: true })
  Object.defineProperty(canvas, 'clientHeight', { value: 600, configurable: true })
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600, x: 0, y: 0 }) as DOMRect
  ;(canvas as unknown as { setPointerCapture(id: number): void }).setPointerCapture = () => {}
  ;(canvas as unknown as { releasePointerCapture(id: number): void }).releasePointerCapture = () => {}

  const camera = new THREE.PerspectiveCamera(45, 800 / 600, 0.1, 2000)
  camera.up.set(0, 0, 1)
  camera.position.set(85, -85, 65)
  const controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 0, 0)
  controls.enableDamping = false
  controls.update()
  return { controls, camera, canvas, container }
}

/** The EXACT wiring createDefaultSceneRuntime.applyNav uses for an active
 *  sketch session on liencnc-default: preset first, then the armed override
 *  (RIGHT -> null), then the enabled gate. */
function armSessionOverride(controls: OrbitControls, canvas: HTMLCanvasElement): {
  nav: ReturnType<typeof createNavPresetController>
  gate: SketchRightDragOrbitGate
} {
  const nav = createNavPresetController(controls, canvas)
  const gate = createSketchRightDragOrbitGate(controls, canvas)
  nav.apply('liencnc-default', false, false)
  applySketchRightDragOrbitOverride(controls.mouseButtons, 'liencnc-default', true)
  gate.setEnabled(true)
  return { nav, gate }
}

/** Full camera pose: position + orientation + orbit target. "Unchanged" below
 *  means EXACT float equality on all three (WO UI-17-R1 hard constraint), not
 *  a tolerance band. */
function capturePose(camera: THREE.PerspectiveCamera, controls: OrbitControls): {
  position: THREE.Vector3
  quaternion: THREE.Quaternion
  target: THREE.Vector3
} {
  return {
    position: camera.position.clone(),
    quaternion: camera.quaternion.clone(),
    target: controls.target.clone(),
  }
}

function expectPoseExactlyUnchanged(
  camera: THREE.PerspectiveCamera,
  controls: OrbitControls,
  before: ReturnType<typeof capturePose>,
): void {
  expect(camera.position.equals(before.position)).toBe(true)
  expect(camera.quaternion.equals(before.quaternion)).toBe(true)
  expect(controls.target.equals(before.target)).toBe(true)
}

function rightDrag(canvas: HTMLCanvasElement, from: { x: number; y: number }, to: { x: number; y: number }): void {
  canvas.dispatchEvent(pointerEvent('pointerdown', { clientX: from.x, clientY: from.y, button: 2 }))
  canvas.dispatchEvent(pointerEvent('pointermove', { clientX: to.x, clientY: to.y, button: 2 }))
  canvas.dispatchEvent(pointerEvent('pointerup', { clientX: to.x, clientY: to.y, button: 2 }))
}

describe('WO UI-17 Q-15 / UI-17-R1: gated right-drag orbit inside a sketch session on liencnc-default only', () => {
  it('one-source rule: the gate threshold equals the FROZEN package\'s private RIGHT_DRAG_PAN_PX (drift pin)', () => {
    // The package is frozen, so its module-private constant cannot be
    // exported; this pin is what makes the host-side export ONE source
    // instead of a second magic number. FAILS-IF either side ever changes
    // without the other.
    const frozenSrc = readFileSync(
      join(__dirname, '..', '..', 'lib', 'sketch', 'sketcher', 'sketchInteraction.ts'),
      'utf8',
    )
    const m = frozenSrc.match(/const RIGHT_DRAG_PAN_PX\s*=\s*(\d+(?:\.\d+)?)/)
    expect(m, 'frozen sketchInteraction.ts no longer declares RIGHT_DRAG_PAN_PX').not.toBeNull()
    expect(Number(m![1])).toBe(RIGHT_DRAG_PAN_PX)
  })

  it('with the override armed + gate enabled, a right-DRAG past the threshold changes the camera pose (a real orbit)', () => {
    const { controls, camera, canvas } = makeControls()
    const { nav, gate } = armSessionOverride(controls, canvas)
    // R1: armed means RIGHT is UNMAPPED until the gate engages -- nothing for
    // OrbitControls to latch at pointerdown.
    expect(controls.mouseButtons.RIGHT).toBeNull()

    const before = camera.position.clone()
    rightDrag(canvas, { x: 400, y: 300 }, { x: 480, y: 300 }) // 80px, far past the 5px click threshold
    // FAILS-IF the override is not applied (liencnc-default RIGHT would PAN,
    // which moves target+position together -- the DIRECTION from target
    // changes only under a rotate) and FAILS-IF the gate never engages (RIGHT
    // stays null and nothing moves at all).
    const dirBefore = before.clone().sub(new THREE.Vector3(0, 0, 0)).normalize()
    const dirAfter = camera.position.clone().sub(controls.target).normalize()
    expect(camera.position.distanceTo(before)).toBeGreaterThan(1e-3)
    expect(dirAfter.angleTo(dirBefore)).toBeGreaterThan(1e-3)
    // A rotate keeps the target put; a pan would have dragged it.
    expect(controls.target.length()).toBeLessThan(1e-9)
    // Gesture over: the gate re-armed for the next press.
    expect(controls.mouseButtons.RIGHT).toBeNull()
    gate.dispose()
    nav.dispose()
    controls.dispose()
  })

  it('zero travel (a right CLICK) leaves the camera pose EXACTLY unchanged', () => {
    const { controls, camera, canvas } = makeControls()
    const { nav, gate } = armSessionOverride(controls, canvas)

    const before = capturePose(camera, controls)
    rightDrag(canvas, { x: 400, y: 300 }, { x: 400, y: 300 }) // zero travel
    expectPoseExactlyUnchanged(camera, controls, before)
    gate.dispose()
    nav.dispose()
    controls.dispose()
  })

  it('4px right-travel (below the shared threshold) leaves the camera pose EXACTLY unchanged', () => {
    // The audit's failure range: 1-5px travel rotated the camera by 5.03
    // units pre-R1 because ROTATE latched at pointerdown. FAILS-IF the gate's
    // threshold check is removed (the AC4 mutation) or the override maps
    // ROTATE immediately again.
    const { controls, camera, canvas } = makeControls()
    const { nav, gate } = armSessionOverride(controls, canvas)

    const before = capturePose(camera, controls)
    rightDrag(canvas, { x: 400, y: 300 }, { x: 404, y: 300 }) // 4px < RIGHT_DRAG_PAN_PX=5
    expectPoseExactlyUnchanged(camera, controls, before)
    // Still armed, not engaged: a 4px jitter is a menu click, not an orbit.
    expect(controls.mouseButtons.RIGHT).toBeNull()
    gate.dispose()
    nav.dispose()
    controls.dispose()
  })

  it('6px right-travel (past the shared threshold) orbits by the FULL travel, and the gate\'s synthetics never bubble', () => {
    const { controls, camera, canvas, container } = makeControls()
    const { nav, gate } = armSessionOverride(controls, canvas)

    // The frozen package's overlayHost contract: it sees right-downs ONLY via
    // bubble phase on the canvas's parent, and measures contextmenu travel
    // from the LAST one it saw. The gate's synthetic re-latch pointerdown is
    // dispatched at the ORIGINAL down point with bubbles:false -- if it ever
    // bubbled, the package would re-base its travel measurement and a >5px
    // drag would wrongly open the menu.
    const bubbledRightDowns: Array<{ x: number; y: number }> = []
    container.addEventListener('pointerdown', (e) => {
      if ((e as MouseEvent).button === 2) bubbledRightDowns.push({ x: (e as MouseEvent).clientX, y: (e as MouseEvent).clientY })
    })

    const before = capturePose(camera, controls)
    rightDrag(canvas, { x: 400, y: 300 }, { x: 406, y: 300 }) // 6px > RIGHT_DRAG_PAN_PX=5
    // The camera orbited: position moved, direction from target changed,
    // target stayed put (rotate, not pan). FAILS-IF the gate re-latches at
    // the CURRENT position instead of the original down point (delta would be
    // zero and nothing would move for a single-move 6px drag).
    const dirBefore = before.position.clone().sub(before.target).normalize()
    const dirAfter = camera.position.clone().sub(controls.target).normalize()
    expect(camera.position.distanceTo(before.position)).toBeGreaterThan(1e-3)
    expect(dirAfter.angleTo(dirBefore)).toBeGreaterThan(1e-3)
    expect(controls.target.length()).toBeLessThan(1e-9)
    // Exactly ONE bubbled right-down: the REAL one, at the true down point.
    expect(bubbledRightDowns).toEqual([{ x: 400, y: 300 }])
    // Gesture over: re-armed.
    expect(controls.mouseButtons.RIGHT).toBeNull()
    gate.dispose()
    nav.dispose()
    controls.dispose()
  })

  it('with the gate DISABLED (no session), the preset\'s own RIGHT mapping is live and a right-drag PANS (byte-identical baseline behavior)', () => {
    const { controls, camera, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)
    const gate = createSketchRightDragOrbitGate(controls, canvas)
    nav.apply('liencnc-default', false, false)
    applySketchRightDragOrbitOverride(controls.mouseButtons, 'liencnc-default', false)
    gate.setEnabled(false)
    expect(controls.mouseButtons.RIGHT).toBe(THREE.MOUSE.PAN)

    const beforePos = camera.position.clone()
    rightDrag(canvas, { x: 400, y: 300 }, { x: 480, y: 300 })
    // A pan drags the target along with the camera -- the at-rest behavior
    // the override must not leak into.
    expect(controls.target.length()).toBeGreaterThan(1e-3)
    expect(camera.position.distanceTo(beforePos)).toBeGreaterThan(1e-3)
    gate.dispose()
    nav.dispose()
    controls.dispose()
  })

  it("every OTHER preset's bindings are byte-unchanged by an active override; liencnc-default is byte-unchanged while inactive", () => {
    const { controls, canvas } = makeControls()
    const nav = createNavPresetController(controls, canvas)

    for (const presetId of Object.keys(NAV_PRESETS) as NavPresetId[]) {
      nav.apply(presetId, false, false)
      const before = JSON.stringify(controls.mouseButtons)
      // Session ACTIVE on a non-default preset: untouched.
      if (presetId !== 'liencnc-default') {
        applySketchRightDragOrbitOverride(controls.mouseButtons, presetId, true)
        expect(JSON.stringify(controls.mouseButtons), `${presetId} w/ session`).toBe(before)
      }
      // Session INACTIVE: untouched on every preset, including the default.
      applySketchRightDragOrbitOverride(controls.mouseButtons, presetId, false)
      expect(JSON.stringify(controls.mouseButtons), `${presetId} at rest`).toBe(before)
    }
    nav.dispose()
    controls.dispose()
  })
})

describe('WO UI-17 AC5: presetCameraPosition -- the documented pose table', () => {
  const target = { x: 3, y: -2, z: 5 }
  const dist = 100
  it.each([
    ['top',    { x: 3, y: -2, z: 105 }],
    ['front',  { x: 3, y: -102, z: 5 }],
    ['right',  { x: 103, y: -2, z: 5 }],
    ['back',   { x: 3, y: 98, z: 5 }],
    ['left',   { x: -97, y: -2, z: 5 }],
    ['bottom', { x: 3, y: -2, z: -95 }],
    ['iso',    { x: 3 + 70, y: -2 - 70, z: 5 + 50 }],
  ] as const)('%s pose vector', (view, expected) => {
    const pos = presetCameraPosition(view, target, dist)
    expect(pos.x).toBeCloseTo(expected.x, 9)
    expect(pos.y).toBeCloseTo(expected.y, 9)
    expect(pos.z).toBeCloseTo(expected.z, 9)
  })
})

describe('WO UI-17 AC6: buildPlaneGrid orients the GridHelper by the PlaneFrame', () => {
  it.each(['xy', 'xz', 'yz'] as const)('%s plane: local +Y lands on the normal, local +X on xDir, origin on the frame origin', (plane) => {
    const frame = BASE_PLANE_FRAMES[plane]
    const group = buildPlaneGrid(frame, 10, 200)
    const q = group.quaternion
    const yWorld = new THREE.Vector3(0, 1, 0).applyQuaternion(q)
    const xWorld = new THREE.Vector3(1, 0, 0).applyQuaternion(q)
    expect(yWorld.distanceTo(new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z))).toBeLessThan(1e-12)
    expect(xWorld.distanceTo(new THREE.Vector3(frame.xDir.x, frame.xDir.y, frame.xDir.z))).toBeLessThan(1e-12)
    expect(group.position.distanceTo(new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z))).toBeLessThan(1e-12)
    // Spacing -> divisions per the CNCViewport recipe: 200mm / 10mm = 20 divisions.
    const grid = group.children[0] as THREE.GridHelper
    expect(grid).toBeInstanceOf(THREE.GridHelper)
    // GridHelper builds (divisions + 1) * 2 line endpoints per axis pair -> 4 * (div + 1) vertices.
    const pos = grid.geometry.getAttribute('position')
    expect(pos.count).toBe(4 * (20 + 1))
  })
})
