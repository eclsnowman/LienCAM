// @vitest-environment jsdom
//
// WO-2499: the click-by-click tools show the next step where the mouse is. Face / Add face / Chain: a marker
// where the next corner lands and a ghost of the face being drawn (corners so far plus the pointer), display
// only; Esc keeps the run's result in the status line; Chain counts the operator's own clicks. Loft: the
// profiles picked so far are outlined through the overlay.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import type { Vec3 } from '../../form/cage'
import type { FaceClick } from '../../form/faceByClicks'
import { useFormStore } from '../../form/formStore'
import { FormInteraction, type FormInteractionHost } from '../../components/model3d/form/formInteraction'
import { FormOverlay } from '../../form/formOverlay'
import type { TransformControlsAdapter } from '../../components/model3d/gizmos/TransformControlsAdapter'

const st = () => useFormStore.getState()
const at = (x: number, y: number): FaceClick => ({ at: [x, y, 0] })

describe('Esc keeps the result in the status line', () => {
  beforeEach(() => { st().openSession({ featureId: null, name: 'F' }) })

  it('none added: plain "Face tool off"', () => {
    st().startFaceTool({ replace: true })
    st().addFaceClick(at(0, 0))
    st().stopFaceTool()
    expect(st().notice).toBe('Face tool off')
  })

  it('one face: "Face tool off - 1 face added"; two: "... - 2 faces added"', () => {
    st().startFaceTool({ replace: true })
    for (const c of [at(0, 0), at(10, 0), at(10, 10), at(0, 10)]) st().addFaceClick(c)
    st().stopFaceTool()
    expect(st().notice).toBe('Face tool off - 1 face added')
    st().startFaceTool({ replace: false })
    for (const c of [at(20, 0), at(30, 0), at(30, 10), at(20, 10)]) st().addFaceClick(c)
    for (const c of [at(40, 0), at(50, 0), at(45, 8)]) st().addFaceClick(c)
    st().finishFaceDraft()
    st().stopFaceTool()
    expect(st().notice).toBe('Face tool off - 2 faces added')
  })

  it('a refused face is not counted; a new run of the tool counts from none', () => {
    st().startFaceTool({ replace: true })
    for (const c of [at(0, 0), at(10, 0), at(20, 0), at(30, 0)]) st().addFaceClick(c)
    expect(st().notice).toMatch(/on one line/)
    st().stopFaceTool()
    expect(st().notice).toBe('Face tool off')
  })
})

describe("Chain counts the operator's own clicks", () => {
  beforeEach(() => { st().openSession({ featureId: null, name: 'F' }) })

  it('one click on the next chained face reads "1 of 2 corners (chained ...)", never "3 of 4"', () => {
    st().startFaceTool({ replace: true, chain: true })
    // the first face takes four clicks of its own
    st().addFaceClick(at(0, 0))
    expect(st().notice).toBe('Face: 1 of 4 corners (Enter makes a triangle of 3, Esc stops)')
    for (const c of [at(10, 0), at(10, 10), at(0, 10)]) st().addFaceClick(c)
    expect(st().faceTool!.clicks).toHaveLength(2)
    st().addFaceClick(at(0, 20))
    expect(st().notice).toMatch(/^Face: 1 of 2 corners \(chained/)
    expect(st().notice).not.toMatch(/3 of 4/)
    st().addFaceClick(at(10, 20))
    expect(st().cage.faces).toHaveLength(2)
    expect(st().notice).toMatch(/chained on its last edge: click the next 2 corners/)
  })

  it('Enter on a chained face: with no click of its own it says one more is needed; with one it makes a triangle', () => {
    st().startFaceTool({ replace: true, chain: true })
    for (const c of [at(0, 0), at(10, 0), at(10, 10), at(0, 10)]) st().addFaceClick(c)
    st().finishFaceDraft()
    expect(st().notice).toBe('Face: 0 of 2 corners; a face needs at least 1 more')
    st().addFaceClick(at(5, 18))
    st().finishFaceDraft()
    expect(st().cage.faces).toHaveLength(2)
    expect(st().cage.faces[1]).toHaveLength(3)
  })

  it('an Undo under a chained draft clears the carried corners; the count starts from 4 again', () => {
    st().startFaceTool({ replace: true, chain: true })
    for (const c of [at(0, 0), at(10, 0), at(10, 10), at(0, 10)]) st().addFaceClick(c)
    st().undo()
    expect(st().faceTool).toMatchObject({ clicks: [], carried: 0 })
    st().addFaceClick(at(0, 0))
    expect(st().notice).toBe('Face: 1 of 4 corners (Enter makes a triangle of 3, Esc stops)')
  })
})

describe('the marker and the ghost face in the view', () => {
  let canvas: HTMLCanvasElement
  let interaction: FormInteraction
  let scene: THREE.Object3D[]
  const overlay = { pickAt: () => null, mirrorHitAt: () => null, rayAt: () => ({ origin: [0, 0, 100] as Vec3, dir: [0, 0, -1] as Vec3 }), setHighlight: () => {} } as unknown as FormOverlay
  const adapter = () => ({ object: undefined, enabled: true, axis: null, addEventListener: () => {}, removeEventListener: () => {}, attach: () => {}, detach: () => {}, setMode: () => {}, setSpace: () => {}, getHelper: () => new THREE.Object3D(), dispose: () => {} }) as unknown as TransformControlsAdapter
  const named = (name: string) => scene.find((o) => o.name === name)!
  const ghostTriangles = () => {
    const g = named('form-face-ghost') as THREE.Mesh
    return g.visible ? (g.geometry.getAttribute('position')?.count ?? 0) / 3 : 0
  }
  const markerShown = () => named('form-face-marker').visible
  const move = (x: number, y: number) => canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: x, clientY: y, bubbles: true }))
  const click = (x: number, y: number) => {
    canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: x, clientY: y, button: 0, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: x, clientY: y, button: 0, bubbles: true }))
  }

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0 })
    canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0 } as DOMRect)
    document.body.appendChild(canvas)
    const cam = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 1000)
    cam.position.set(0, 0, 100)
    cam.updateMatrixWorld(true)
    scene = []
    const host: FormInteractionHost = { canvas, camera: () => cam, addObject: (o) => { scene.push(o) }, removeObject: (o) => { scene = scene.filter((x) => x !== o) }, requestRender: () => {}, setOrbitEnabled: () => {} }
    st().openSession({ featureId: null, name: 'F' })
    interaction = new FormInteraction(host, overlay, adapter)
  })
  afterEach(() => { interaction.dispose(); canvas.remove(); vi.unstubAllGlobals() })

  it('tool off: no marker, no ghost; tool on: the marker follows the pointer before any click', () => {
    move(200, 150)
    expect(markerShown()).toBe(false)
    st().startFaceTool({ replace: true })
    expect(markerShown()).toBe(false)
    move(200, 150)
    expect(markerShown()).toBe(true)
    const pos = (named('form-face-marker') as THREE.Points).geometry.getAttribute('position')
    expect(pos.count).toBe(1)
    expect(pos.getZ(0)).toBeCloseTo(0, 6)
    expect(ghostTriangles()).toBe(0)
  })

  it('Face: 1 corner - a line, no ghost; 2 and 3 corners - the ghost follows the pointer; 4th - the face exists and the ghost resets', () => {
    st().startFaceTool({ replace: true })
    click(150, 100); move(250, 100)
    expect(ghostTriangles()).toBe(0)
    click(250, 100); move(250, 200)
    expect(ghostTriangles()).toBe(1)
    click(250, 200); move(150, 200)
    expect(ghostTriangles()).toBe(2)
    const before = (named('form-face-ghost') as THREE.Mesh).geometry.getAttribute('position').getX(5)
    move(140, 210)
    expect((named('form-face-ghost') as THREE.Mesh).geometry.getAttribute('position').getX(5)).not.toBeCloseTo(before, 6)
    click(150, 200)
    expect(st().cage.faces).toHaveLength(1)
    move(160, 220)
    expect(ghostTriangles()).toBe(0)
    expect(markerShown()).toBe(true)
  })

  it("Chain: the next face's ghost starts from the carried edge", () => {
    st().startFaceTool({ replace: true, chain: true })
    for (const [x, y] of [[150, 100], [250, 100], [250, 200], [150, 200]]) click(x, y)
    move(150, 280)
    expect(ghostTriangles()).toBe(1)
    const g = (named('form-face-ghost') as THREE.Mesh).geometry.getAttribute('position')
    const P = st().cage.positions
    const carried = st().faceTool!.clicks.map((c) => ('point' in c ? P[c.point] : c.at))
    for (const [v, c] of [[0, carried[0]], [1, carried[1]]] as const) {
      expect(g.getX(v)).toBeCloseTo(c[0], 4)
      expect(g.getY(v)).toBeCloseTo(c[1], 4)
    }
  })

  it('display only: not in the form or its undo history; gone when the tool is off, after Undo, when the pointer leaves', () => {
    st().startFaceTool({ replace: true })
    for (const [x, y] of [[150, 100], [250, 100], [250, 200], [150, 200]]) click(x, y)
    const cage = JSON.stringify(st().cage)
    const history = st().history
    click(150, 250); click(250, 250); move(200, 280)
    expect(ghostTriangles()).toBe(1)
    expect(JSON.stringify(st().cage)).toBe(cage)
    expect(st().history).toBe(history)
    expect(Object.keys(st().faceTool!).sort()).toEqual(['added', 'carried', 'chain', 'clicks', 'plane', 'planeWords', 'replace'])
    st().undo()
    move(200, 281)
    expect(ghostTriangles()).toBe(0)
    click(150, 250); click(250, 250); move(200, 280)
    canvas.dispatchEvent(new MouseEvent('pointerleave', { bubbles: true }))
    expect(markerShown()).toBe(false)
    expect(ghostTriangles()).toBe(0)
    move(200, 280)
    expect(ghostTriangles()).toBe(1)
    st().stopFaceTool()
    expect(markerShown()).toBe(false)
    expect(ghostTriangles()).toBe(0)
  })

  it('an orthographic view: a spot of the work plane behind the camera\'s own plane still takes the corner and the marker', () => {
    interaction.dispose()
    // looking down at 45 deg from (0, -50, 50); the work plane at Z = 60 lies partly behind the camera's plane
    const cam = new THREE.OrthographicCamera(-100, 100, 75, -75, 1, 500)
    cam.position.set(0, -50, 50)
    cam.lookAt(0, 0, 0)
    cam.updateMatrixWorld(true)
    const host: FormInteractionHost = { canvas, camera: () => cam, addObject: (o) => { scene.push(o) }, removeObject: (o) => { scene = scene.filter((x) => x !== o) }, requestRender: () => {}, setOrbitEnabled: () => {} }
    interaction = new FormInteraction(host, overlay, adapter)
    st().startFaceTool({ replace: true, plane: { origin: [0, 0, 60], normal: [0, 0, 1] }, planeWords: 'Z = 60' })
    move(200, 150)
    expect(markerShown()).toBe(true)
    click(200, 150)
    const c = st().faceTool!.clicks[0]
    expect(c !== undefined && 'at' in c ? c.at[2] : null).toBeCloseTo(60, 6)
    // the centre ray meets Z = 60 at (0, -60, 60): behind the camera's plane, which the ray's own start refused
    expect(c !== undefined && 'at' in c ? c.at[1] : 0).toBeCloseTo(-60, 6)
  })

  it('after a pan the marker and the ghost still pass the renderer\'s view culling where the pointer is', () => {
    // the renderer's own test: a frustum-culled object is drawn only when its bounds meet the camera's view
    const cam = interaction['host'].camera() as THREE.PerspectiveCamera
    const inView = (name: string) => {
      const o = named(name)
      o.updateMatrixWorld(true)
      const f = new THREE.Frustum().setFromProjectionMatrix(new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse))
      return o.frustumCulled && f.intersectsObject(o)
    }
    st().startFaceTool({ replace: true })
    click(150, 100); click(250, 100)
    move(200, 150)
    expect(inView('form-face-marker')).toBe(true)
    expect(inView('form-face-ghost')).toBe(true)
    // pan far enough that everything drawn before the pan is off view, then point again at the view's centre
    cam.position.set(400, 300, 100)
    cam.updateMatrixWorld(true)
    move(200, 150)
    const pos = (named('form-face-marker') as THREE.Points).geometry.getAttribute('position')
    expect(pos.getX(0)).toBeCloseTo(400, 4)
    expect(pos.getY(0)).toBeCloseTo(300, 4)
    expect(markerShown()).toBe(true)
    expect(inView('form-face-marker')).toBe(true)
    // the ghost reaches from the two corners left behind to the pointer, so part of it is still in view
    expect(ghostTriangles()).toBe(1)
    expect(inView('form-face-ghost')).toBe(true)
  })

  it('closing the session takes the marker and the ghost out of the scene', () => {
    st().startFaceTool({ replace: true })
    move(200, 150)
    interaction.dispose()
    expect(scene.some((o) => o.name === 'form-face-marker' || o.name === 'form-face-ghost')).toBe(false)
  })
})

describe("Loft's profile outlines in the overlay", () => {
  it('outlines the profiles given (closed ones round to the start, and filled); none clears them', () => {
    const canvas = document.createElement('canvas')
    const objects: THREE.Object3D[] = []
    const overlay = new FormOverlay({ addObject: (o) => { objects.push(o) }, removeObject: () => {}, requestRender: () => {}, camera: () => new THREE.PerspectiveCamera(), canvas })
    expect(overlay.profileOutlineSegments()).toBe(0)
    const square: Vec3[] = [[0, 0, 5], [10, 0, 5], [10, 10, 5], [0, 10, 5]]
    overlay.setProfileOutlines([{ points: square, closed: true }])
    expect(overlay.profileOutlineSegments()).toBe(4)
    // a closed profile is filled too (the sketch's own line covers the outline)
    expect(overlay.profileFillTriangles()).toBe(4)
    overlay.setProfileOutlines([{ points: square, closed: false }])
    expect(overlay.profileOutlineSegments()).toBe(3)
    expect(overlay.profileFillTriangles()).toBe(0)
    overlay.setProfileOutlines([])
    expect(overlay.profileOutlineSegments()).toBe(0)
    expect(overlay.profileFillTriangles()).toBe(0)
    overlay.dispose()
  })
})
