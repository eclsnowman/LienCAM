// @vitest-environment jsdom
//
// WO-2183 (Operator, 2026-09-29): "If I rotate a form model around in the model
// space, it can start clipping the viewport. It looks like the front of the
// model closest to me gets cut off."
//
// Reproduced headless in the real Model screen (src/tests/evidence/WO-2183/):
// every camera-depth pass after a Form opened refused with
// 'camera-bounds-refused-nonfinite', so the near/far slab froze at the fit made
// before the form existed and orbiting pushed the near side of the skin in
// front of the near plane. The Form overlay always carries EMPTY geometries (no
// creased edges, no selection, no hover), and three.js measures an empty
// geometry as the empty box (+Infinity .. -Infinity) -- nothing to draw, which
// the depth pass mistook for corrupt geometry.
//
// These tests drive the production chain -- the scene enrollment the runtime's
// addObject uses, the camera-depth safety the orbit controls' change event
// calls, and the real FormOverlay -- then check every skin and cage vertex
// against the live camera's near/far, computed from the vertices themselves
// (not from the depth pass's own boxes).

import { afterEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import {
  DepthExtentRoots,
  VisibleBodyBoundsCache,
  VisibleSceneDepthLifecycle,
  createCameraSceneSafety,
  createVisibleSceneObjectEnrollment,
} from '../../components/model3d/sceneRuntime'
import { FormOverlay } from '../../form/formOverlay'
import { boxCage } from '../../form/starters'
import type { Cage, Vec3 } from '../../form/cage'

const disposables: Array<() => void> = []
afterEach(() => { while (disposables.length > 0) disposables.pop()?.() })

/** The Model screen's scene, camera and depth wiring, built the way createSceneRuntime builds them. */
function modelScreen(camera: THREE.PerspectiveCamera | THREE.OrthographicCamera) {
  const scene = new THREE.Scene()
  scene.add(camera)
  // the empty Model screen, seen from a distance
  camera.up.set(0, 0, 1)
  camera.position.set(200, -350, 230)
  camera.lookAt(0, 0, 0)
  camera.updateMatrixWorld(true)
  const target = new THREE.Vector3()
  const controls = {
    target, mouseButtons: {}, touches: {}, enabled: true, enablePan: true,
    addEventListener: () => {}, removeEventListener: () => {},
  } as unknown as Parameters<typeof createCameraSceneSafety>[0]['controls']
  const refusals: string[] = []
  const depthExtentRoots = new DepthExtentRoots()
  const safety = createCameraSceneSafety({
    getCamera: () => camera,
    controls,
    canvas: document.createElement('div'),
    boundsCache: new VisibleBodyBoundsCache(),
    depthExtentRoots,
    onRefusal: (reason) => refusals.push(reason),
  })
  disposables.push(() => safety.dispose())
  const objects = createVisibleSceneObjectEnrollment({
    scene,
    depthLifecycle: new VisibleSceneDepthLifecycle(depthExtentRoots, safety),
    requestRender: () => {},
  })
  // the origin glyph the Model screen shows before any form: the slab is first fitted to it
  const originGeometry = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0),
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 10, 0),
    new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 10),
  ])
  const origin = new THREE.LineSegments(originGeometry, new THREE.LineBasicMaterial())
  origin.userData.genesisNodeId = 'origin'
  disposables.push(() => { originGeometry.dispose(); (origin.material as THREE.Material).dispose() })
  objects.addObject(origin)

  const overlay = new FormOverlay({
    addObject: (o) => objects.addObject(o),
    removeObject: (o) => objects.removeObject(o),
    requestRender: () => {},
    camera: () => camera,
    canvas: document.createElement('canvas'),
  })
  disposables.push(() => overlay.dispose())

  /** orbit: put the eye at (azimuth, elevation) degrees round `centre`, `distance` away, as the orbit controls do, then fire their change */
  const orbit = (centre: THREE.Vector3, distance: number, azimuthDeg: number, elevationDeg: number) => {
    const az = THREE.MathUtils.degToRad(azimuthDeg)
    const el = THREE.MathUtils.degToRad(elevationDeg)
    target.copy(centre)
    camera.up.set(0, 0, 1)
    camera.position.set(
      centre.x + distance * Math.cos(el) * Math.cos(az),
      centre.y + distance * Math.cos(el) * Math.sin(az),
      centre.z + distance * Math.sin(el),
    )
    camera.lookAt(centre)
    camera.updateMatrixWorld(true)
    return safety.applyDepthSafety()
  }
  return { scene, overlay, orbit, refusals }
}

/** camera-space depth (distance in front of the eye) of every drawn vertex of `obj`, read from its position buffer */
function vertexDepths(obj: THREE.Object3D, camera: THREE.Camera): number[] {
  camera.updateMatrixWorld(true)
  obj.updateWorldMatrix(true, true)
  const depths: number[] = []
  const v = new THREE.Vector3()
  const position = (obj as THREE.Mesh).geometry.getAttribute('position')
  for (let i = 0; i < position.count; i += 1) {
    v.fromBufferAttribute(position, i).applyMatrix4(obj.matrixWorld).applyMatrix4(camera.matrixWorldInverse)
    depths.push(-v.z)
  }
  return depths
}

/** which of the form's drawn parts (skin, cage edges, cage points) reach outside the camera's near/far */
function cutParts(overlay: FormOverlay, camera: THREE.PerspectiveCamera | THREE.OrthographicCamera): string[] {
  const cut: string[] = []
  for (const name of ['form-skin', 'form-cage-edges', 'form-cage-points']) {
    const obj = overlay.root.getObjectByName(name)!
    const depths = vertexDepths(obj, camera)
    expect(depths.length).toBeGreaterThan(0)
    if (Math.min(...depths) < camera.near || Math.max(...depths) > camera.far) cut.push(name)
  }
  return cut
}

const box = (): Cage => boxCage({ segments: { x: 2, y: 2, z: 2 } })
/** Operator's picture: the Box's top corners pulled up and out */
const pulledTop = (cage: Cage): Cage => ({
  ...cage,
  positions: cage.positions.map((q) => (q[2] === 40 && q[0] !== 0 && q[1] !== 0 ? [q[0] * 2.5, q[1] * 2.5, 110] as Vec3 : q)),
})
const CENTRE = new THREE.Vector3(0, 0, 20)
const VIEWS: Array<[number, number]> = [[-60, 25], [-20, 10], [30, 40], [120, -15], [200, 70], [290, -50]]

describe('WO-2183: orbiting never cuts off the front of a Form model', () => {
  it('perspective: the whole skin and cage stay inside near/far at every orbit angle, close in and far out', () => {
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 2000)
    const { overlay, orbit, refusals } = modelScreen(camera)
    orbit(new THREE.Vector3(), 400, -60, 30) // the empty Model screen, seen from a distance
    overlay.update({ cage: box(), topologyVersion: 1, displayMode: 'both', dragging: false })
    for (const distance of [140, 90, 70]) {
      for (const [az, el] of VIEWS) {
        const result = orbit(CENTRE, distance, az, el)
        expect({ distance, az, el, ok: result?.ok }).toEqual({ distance, az, el, ok: true })
        expect({ distance, az, el, cut: cutParts(overlay, camera) }).toEqual({ distance, az, el, cut: [] })
      }
    }
    expect(refusals).toEqual([])
  })

  it('orthographic: the same, from every side', () => {
    const camera = new THREE.OrthographicCamera(-80, 80, 45, -45, 0.1, 2000)
    const { overlay, orbit, refusals } = modelScreen(camera)
    orbit(new THREE.Vector3(), 400, -60, 30)
    overlay.update({ cage: box(), topologyVersion: 1, displayMode: 'both', dragging: false })
    for (const [az, el] of VIEWS) {
      const result = orbit(CENTRE, 60, az, el)
      expect({ az, el, ok: result?.ok }).toEqual({ az, el, ok: true })
      expect({ az, el, cut: cutParts(overlay, camera) }).toEqual({ az, el, cut: [] })
    }
    expect(refusals).toEqual([])
  })

  it('after an edit pulls cage points outward, orbiting keeps the moved cage and skin inside near/far', () => {
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 2000)
    const { overlay, orbit, refusals } = modelScreen(camera)
    orbit(new THREE.Vector3(), 400, -60, 30)
    overlay.update({ cage: box(), topologyVersion: 1, displayMode: 'both', dragging: false })
    orbit(CENTRE, 140, -60, 25) // the depth pass has now measured the unedited cage
    // the edit, through the same drag path the gizmo drives: coarse skin while dragging, fine at rest
    overlay.update({ cage: pulledTop(box()), topologyVersion: 1, displayMode: 'both', dragging: true })
    overlay.update({ cage: pulledTop(box()), topologyVersion: 1, displayMode: 'both', dragging: false })
    const pulled = new THREE.Vector3(0, 0, 55)
    for (const distance of [260, 180]) {
      for (const [az, el] of VIEWS) {
        const result = orbit(pulled, distance, az, el)
        expect({ distance, az, el, ok: result?.ok }).toEqual({ distance, az, el, ok: true })
        expect({ distance, az, el, cut: cutParts(overlay, camera) }).toEqual({ distance, az, el, cut: [] })
      }
    }
    expect(refusals).toEqual([])
  })

  it('after Finish Form (the overlay leaves the scene) the depth pass fits what is left and refuses nothing', () => {
    const camera = new THREE.PerspectiveCamera(45, 16 / 9, 0.1, 2000)
    const { overlay, orbit, refusals } = modelScreen(camera)
    overlay.update({ cage: box(), topologyVersion: 1, displayMode: 'both', dragging: false })
    overlay.dispose()
    const result = orbit(CENTRE, 90, 30, 40)
    expect(result?.ok).toBe(true)
    expect(refusals).toEqual([])
  })
})
