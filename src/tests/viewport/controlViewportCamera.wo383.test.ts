import * as THREE from 'three'
import { describe, expect, it, vi } from 'vitest'
import { CNCViewport } from '../../lib/viewport/CNCViewport'

interface PartialViewportInternals {
  camera: THREE.OrthographicCamera
  controls: {
    target: THREE.Vector3
    enableDamping: boolean
    update: ReturnType<typeof vi.fn>
  }
  container: { clientWidth: number; clientHeight: number }
  frustumSize: number
  cameraUserPositioned: boolean
}

function makeViewport() {
  const camera = new THREE.OrthographicCamera(-200, 200, 100, -100, -10000, 10000)
  camera.position.set(420, -310, 260)
  camera.up.set(0, 0, 1)
  const target = new THREE.Vector3(10, 20, 30)
  camera.lookAt(target)
  camera.updateMatrixWorld(true)

  const internals: PartialViewportInternals = {
    camera,
    controls: { target, enableDamping: true, update: vi.fn() },
    container: { clientWidth: 800, clientHeight: 400 },
    frustumSize: 200,
    cameraUserPositioned: true,
  }
  const viewport = Object.create(CNCViewport.prototype) as CNCViewport
  Object.assign(viewport as unknown as PartialViewportInternals, internals)
  return { viewport, camera, controls: internals.controls }
}

describe('WO-383 orthographic extent fitting', () => {
  it('preserves view direction, centers the target, and contains every bound corner', () => {
    const { viewport, camera, controls } = makeViewport()
    const before = camera.position.clone().sub(controls.target).normalize()
    const bounds = {
      min: { x: -300, y: -200, z: -100 },
      max: { x: 0, y: 0, z: 0 },
    }

    expect(viewport.fitBoundsPreservingView(bounds)).toBe(true)

    const after = camera.position.clone().sub(controls.target).normalize()
    expect(after.dot(before)).toBeCloseTo(1, 10)
    expect(controls.target.toArray()).toEqual([-150, -100, -50])
    expect(camera.zoom).toBe(1)
    expect(controls.enableDamping).toBe(true)

    for (let i = 0; i < 8; i += 1) {
      const projected = new THREE.Vector3(
        (i & 1) ? bounds.max.x : bounds.min.x,
        (i & 2) ? bounds.max.y : bounds.min.y,
        (i & 4) ? bounds.max.z : bounds.min.z,
      ).project(camera)
      expect(Math.abs(projected.x)).toBeLessThanOrEqual(1)
      expect(Math.abs(projected.y)).toBeLessThanOrEqual(1)
    }
  })

  it('refuses non-finite or inverted bounds without moving the camera', () => {
    const { viewport, camera } = makeViewport()
    const before = camera.position.clone()

    expect(viewport.fitBoundsPreservingView({
      min: { x: 10, y: 0, z: 0 },
      max: { x: 0, y: 10, z: 10 },
    })).toBe(false)
    expect(viewport.fitBoundsPreservingView({
      min: { x: 0, y: 0, z: 0 },
      max: { x: Number.NaN, y: 10, z: 10 },
    })).toBe(false)
    expect(camera.position.equals(before)).toBe(true)
  })
})
