// @vitest-environment jsdom
//
// WO UI-29 (Z1): exercise cursor-anchored wheel zoom through a REAL
// OrbitControls and the REAL shared navPresetController. The known world point
// is projected to an off-center cursor before the wheel step, then projected
// again afterward; a center-target dolly cannot satisfy this assertion.

import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { createNavPresetController } from '../../lib/viewport/navPresetController'
import { createWorkbenchNavController } from '../../components/model3d/sceneRuntime'

const WIDTH = 800
const HEIGHT = 600
const WORLD_POINT = new THREE.Vector3(12, 4, 0)

interface Harness {
  camera: THREE.PerspectiveCamera
  canvas: HTMLCanvasElement
  controls: OrbitControls
}

const liveHarnesses: Harness[] = []

function makeHarness(): Harness {
  const canvas = document.createElement('canvas')
  document.body.appendChild(canvas)
  Object.defineProperty(canvas, 'clientWidth', { value: WIDTH, configurable: true })
  Object.defineProperty(canvas, 'clientHeight', { value: HEIGHT, configurable: true })
  canvas.getBoundingClientRect = () => ({
    left: 0, top: 0, width: WIDTH, height: HEIGHT,
    right: WIDTH, bottom: HEIGHT, x: 0, y: 0,
  }) as DOMRect

  const camera = new THREE.PerspectiveCamera(45, WIDTH / HEIGHT, 0.1, 2000)
  camera.up.set(0, 0, 1)
  camera.position.set(85, -85, 65)
  const controls = new OrbitControls(camera, canvas)
  controls.target.set(0, 0, 0)
  controls.enableDamping = false
  controls.update()

  const harness = { camera, canvas, controls }
  liveHarnesses.push(harness)
  return harness
}

function project(camera: THREE.Camera, point: THREE.Vector3): THREE.Vector3 {
  camera.updateMatrixWorld(true)
  const ndc = point.clone().project(camera)
  expect(Number.isFinite(ndc.x)).toBe(true)
  expect(Number.isFinite(ndc.y)).toBe(true)
  expect(Number.isFinite(ndc.z)).toBe(true)
  return ndc
}

function wheelAtProjectedPoint(harness: Harness, deltaY: number): void {
  const ndc = project(harness.camera, WORLD_POINT)
  expect(Math.abs(ndc.x)).toBeLessThan(1)
  expect(Math.abs(ndc.y)).toBeLessThan(1)
  const clientX = (ndc.x + 1) * WIDTH / 2
  const clientY = (1 - ndc.y) * HEIGHT / 2
  harness.canvas.dispatchEvent(new WheelEvent('wheel', {
    clientX,
    clientY,
    deltaY,
    bubbles: true,
    cancelable: true,
  }))
}

afterEach(() => {
  for (const { controls, canvas } of liveHarnesses.splice(0)) {
    controls.dispose()
    canvas.remove()
  }
})

describe('WO UI-29 Z1: workbench wheel zoom follows the cursor', () => {
  it('keeps the shared controller default off and restores the prior control value on dispose', () => {
    const { controls, canvas } = makeHarness()
    expect(controls.zoomToCursor).toBe(false)

    controls.zoomToCursor = true
    const nav = createNavPresetController(controls, canvas)
    expect(controls.zoomToCursor).toBe(false)
    nav.dispose()
    expect(controls.zoomToCursor).toBe(true)
  })

  it('the default-off path retains stock target-centered zoom behavior', () => {
    const harness = makeHarness()
    const nav = createNavPresetController(harness.controls, harness.canvas)
    nav.apply('liencnc-default', false, false)
    const before = project(harness.camera, WORLD_POINT)

    wheelAtProjectedPoint(harness, 120)

    const after = project(harness.camera, WORLD_POINT)
    expect(after.distanceTo(before)).toBeGreaterThan(1e-4)
    nav.dispose()
  })

  it.each([
    { invertZoom: false, expectedDirection: 'out' as const },
    { invertZoom: true, expectedDirection: 'in' as const },
  ])('opt-in keeps the world point under the cursor while wheel zooms $expectedDirection', ({ invertZoom, expectedDirection }) => {
    const harness = makeHarness()
    const nav = createWorkbenchNavController(harness.controls, harness.canvas)
    nav.apply('liencnc-default', invertZoom, false)
    expect(harness.controls.zoomToCursor).toBe(true)

    const beforeNdc = project(harness.camera, WORLD_POINT)
    const beforeDistance = harness.camera.position.distanceTo(harness.controls.target)
    wheelAtProjectedPoint(harness, 120)
    const afterNdc = project(harness.camera, WORLD_POINT)
    const afterDistance = harness.camera.position.distanceTo(harness.controls.target)

    expect(Number.isFinite(afterDistance)).toBe(true)
    expect(Math.abs(afterDistance - beforeDistance)).toBeGreaterThan(1e-3)
    if (expectedDirection === 'out') expect(afterDistance).toBeGreaterThan(beforeDistance)
    else expect(afterDistance).toBeLessThan(beforeDistance)
    expect(afterNdc.x).toBeCloseTo(beforeNdc.x, 9)
    expect(afterNdc.y).toBeCloseTo(beforeNdc.y, 9)

    nav.dispose()
    expect(harness.controls.zoomToCursor).toBe(false)
  })
})
