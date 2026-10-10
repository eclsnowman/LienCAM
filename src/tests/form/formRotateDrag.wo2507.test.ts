// @vitest-environment jsdom
//
// WO-2507 (Operator ruling 2026-10-03): "Does rotate not work on faces? Trying to grab the rotation handle doesn't seem to
// work." Four faces selected in Form, Rotate on, the rings drawn at their centre - and a drag on a ring did nothing.
//
// Cause: three's TransformControls turns a ring by (drag in world units) x 20 / (gizmo to camera distance). The
// Model screen's camera is orthographic and its depth safety parks it tens of metres back so nothing clips (the
// real app, measured: ~87 m), so a drag turned thousandths of a degree; zooming in made it slower still.
//
// These tests drive the production path: real FormInteraction with the real TransformControls adapter, real
// FormOverlay, real formStore - a hover finds the green (Y) ring, then press, moves, release reach the gizmo
// through the canvas, objectChange reaches formStore moveBy. The camera is the app's: orthographic, parked far.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { useFormStore } from '../../form/formStore'
import { FormInteraction, type FormInteractionHost } from '../../components/model3d/form/formInteraction'
import { FormOverlay } from '../../form/formOverlay'
import { boxCage } from '../../form/starters'
import { centroidOf, selectionPoints } from '../../form/topology'
import type { Vec3 } from '../../form/cage'
import { createDefaultTransformControlsAdapter } from '../../components/model3d/gizmos/TransformControlsAdapter'

const st = () => useFormStore.getState()
const W = 1200, H = 900
const HALF_HEIGHT = 43
/** how far back the Model screen's depth safety parked the orthographic camera in the real app */
const PARKED = 87000
const VIEW = new THREE.Vector3(1, -1, 1.07).normalize()
const deg = (r: number) => (r * 180) / Math.PI

let canvas: HTMLCanvasElement
let camera: THREE.OrthographicCamera
let overlay: FormOverlay
let interaction: FormInteraction
let scene: THREE.Scene

function pointer(type: string, x: number, y: number, button: number, buttons: number): void {
  const e = new MouseEvent(type, { clientX: x, clientY: y, button, buttons, bubbles: true, cancelable: true })
  Object.defineProperty(e, 'pointerType', { value: 'mouse' })
  Object.defineProperty(e, 'pointerId', { value: 1 })
  canvas.dispatchEvent(e)
}
/** what a render does first: the gizmo's handles are placed and sized for the camera */
function frame(): void {
  camera.updateMatrixWorld(true)
  scene.updateMatrixWorld(true)
}
const hover = (x: number, y: number) => { pointer('pointermove', x, y, -1, 0); frame() }
/** a real mouse drag: press, moves on the way (button -1, as browsers send them), release */
function drag(from: { x: number; y: number }, to: { x: number; y: number }, steps = 12): void {
  hover(from.x, from.y)
  pointer('pointerdown', from.x, from.y, 0, 1)
  for (let k = 1; k <= steps; k++) pointer('pointermove', from.x + (to.x - from.x) * k / steps, from.y + (to.y - from.y) * k / steps, -1, 1)
  pointer('pointerup', to.x, to.y, 0, 0)
  frame()
}
function placeCamera(target: Vec3, zoom: number): void {
  const t = new THREE.Vector3(...target)
  camera.position.copy(t).addScaledVector(VIEW, PARKED)
  camera.up.set(0, 0, 1)
  camera.zoom = zoom
  camera.lookAt(t)
  camera.updateProjectionMatrix()
  frame()
}
/** the screen spot (canvas px) where the hovered gizmo handle reads `axis`, scanning out from (cx, cy) */
function findHandle(axis: string, cx: number, cy: number): { x: number; y: number } {
  for (let r = 4; r <= 260; r += 3) {
    for (let a = 0; a < 360; a += 4) {
      const q = { x: cx + r * Math.cos((a * Math.PI) / 180), y: cy + r * Math.sin((a * Math.PI) / 180) }
      hover(q.x, q.y)
      if (interaction.gizmoAxis() === axis) return q
    }
  }
  throw new Error(`no ${axis} handle found`)
}
const topFaces = () => {
  const c = st().cage, zMax = Math.max(...c.positions.map((p) => p[2]))
  return c.faces.flatMap((f, i) => (f.every((p) => Math.abs(c.positions[p][2] - zMax) < 1e-9) ? [i] : []))
}
const positions = () => st().cage.positions.map((p) => [...p] as Vec3)
/** a point's angle round the Y axis through `c` (in the XZ plane) */
const angleY = (p: Vec3, c: Vec3) => Math.atan2(p[2] - c[2], p[0] - c[0])
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a))

beforeEach(() => {
  canvas = document.createElement('canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 } as DOMRect)
  canvas.setPointerCapture = () => {}
  canvas.releasePointerCapture = () => {}
  document.body.appendChild(canvas)
  camera = new THREE.OrthographicCamera(-HALF_HEIGHT * W / H, HALF_HEIGHT * W / H, HALF_HEIGHT, -HALF_HEIGHT, 859, 181000)
  scene = new THREE.Scene()
  st().openSession({ featureId: null, name: 'F', cage: boxCage() })
  st().setSymmetry(null)
  const host: FormInteractionHost = {
    canvas, camera: () => camera, addObject: (o) => { scene.add(o) }, removeObject: (o) => { scene.remove(o) },
    requestRender: () => {}, setOrbitEnabled: () => {},
  }
  overlay = new FormOverlay({ canvas, camera: () => camera, addObject: () => {}, removeObject: () => {}, requestRender: () => {} })
  interaction = new FormInteraction(host, overlay)
})
afterEach(() => {
  interaction.dispose()
  overlay.dispose()
  canvas.remove()
})

/** Four top faces selected, Rotate on, camera on their centre: drag the green ring 30 px along its turn. */
function rotateTopFaces(zoom: number) {
  const faces = topFaces()
  expect(faces.length).toBe(4)
  st().setSelection({ points: [], edges: [], faces })
  st().setTransformMode('rotate')
  const sel = selectionPoints(st().cage, st().selection)
  const c = centroidOf(st().cage, sel)
  placeCamera(c, zoom)
  const centre = overlay.screenOf(c)
  const ring = findHandle('Y', centre.x, centre.y)
  // along the ring: square to the line from the centre
  const out = { x: ring.x - centre.x, y: ring.y - centre.y }, l = Math.hypot(out.x, out.y)
  const before = positions()
  drag(ring, { x: ring.x - (out.y / l) * 30, y: ring.y + (out.x / l) * 30 })
  return { faces, sel, c, before, after: positions() }
}

describe('WO-2507: dragging a Rotate ring turns the Form selection about its centre', () => {
  it('the green ring turns the four selected faces round Y through their centre; the rest of the cage stays put', () => {
    const { faces, sel, c, before, after } = rotateTopFaces(1)
    expect(st().dragging).toBe(false)
    const turns: number[] = []
    before.forEach((p, i) => {
      if (!sel.includes(i)) { expect(after[i]).toEqual(p); return }
      // a Y turn keeps each point's Y and its distance from the axis
      expect(after[i][1]).toBeCloseTo(p[1], 9)
      expect(Math.hypot(after[i][0] - c[0], after[i][2] - c[2])).toBeCloseTo(Math.hypot(p[0] - c[0], p[2] - c[2]), 6)
      if (Math.abs(p[0] - c[0]) > 1e-6) turns.push(wrap(angleY(after[i], c) - angleY(p, c)))
    })
    expect(turns.length).toBe(6)
    // a 30 px drag on a 900 px view turns the selection by tens of degrees (three's perspective feel), not 0.03
    expect(Math.abs(deg(turns[0]))).toBeGreaterThan(15)
    expect(Math.abs(deg(turns[0]))).toBeLessThan(90)
    for (const t of turns) expect(t).toBeCloseTo(turns[0], 9)
    // the selection is unchanged and the gizmo goes back to its centre
    expect(st().selection.faces).toEqual(faces)
    // Undo puts the points back
    st().undo()
    expect(positions()).toEqual(before)
  })

  it('zoomed in 8x the same drag turns the same angle: the ring rate follows what is seen, not the zoom', () => {
    const at = (zoom: number) => {
      const { sel, c, before, after } = rotateTopFaces(zoom)
      const i = sel.find((p) => Math.abs(before[p][0] - c[0]) > 1e-6)!
      const turn = wrap(angleY(after[i], c) - angleY(before[i], c))
      st().undo()
      return turn
    }
    const one = at(1), eight = at(8)
    expect(Math.abs(deg(one))).toBeGreaterThan(15)
    expect(eight).toBeCloseTo(one, 6)
  })
})

describe('WO-2507: Move, Scale and a perspective camera are exactly as three.js does them', () => {
  /** the same pointer gesture through a bare TransformControls and through the adapter, on the same camera */
  function compare(cam: THREE.Camera, mode: 'translate' | 'rotate' | 'scale', axis: string) {
    const run = (controls: TransformControls) => {
      const target = new THREE.Object3D()
      const scene = new THREE.Scene()
      scene.add(target)
      controls.setMode(mode)
      controls.attach(target)
      scene.add(controls.getHelper())
      const c = controls as unknown as { axis: string | null; pointerDown(p: unknown): void; pointerMove(p: unknown): void; pointerUp(p: unknown): void }
      // as a hover does: the handle is named, then a frame turns the drag plane to suit it before the press
      c.axis = axis
      scene.updateMatrixWorld(true)
      c.pointerDown({ x: 0.1, y: 0.1, button: 0 })
      c.pointerMove({ x: 0.16, y: 0.13, button: -1 })
      c.pointerUp({ x: 0.16, y: 0.13, button: 0 })
      const out = { p: target.position.toArray(), q: target.quaternion.toArray(), s: target.scale.toArray() }
      controls.dispose()
      return out
    }
    return { bare: run(new TransformControls(cam, canvas)), adapter: run(createDefaultTransformControlsAdapter(cam, canvas) as unknown as TransformControls) }
  }

  it('Move and Scale with the parked orthographic camera, and Rotate with a perspective camera, are untouched', () => {
    placeCamera([0, 0, 10], 2)
    const persp = new THREE.PerspectiveCamera(45, W / H, 0.1, 5000)
    persp.position.set(80, -80, 90)
    persp.lookAt(0, 0, 10)
    persp.updateMatrixWorld(true)
    for (const [cam, mode, axis] of [[camera, 'translate', 'Z'], [camera, 'translate', 'XY'], [camera, 'scale', 'X'], [camera, 'scale', 'XYZ'], [persp, 'rotate', 'Y'], [persp, 'rotate', 'XYZE'], [persp, 'translate', 'X']] as const) {
      const { bare, adapter } = compare(cam, mode, axis)
      expect(adapter, `${mode} ${axis}`).toEqual(bare)
      // the gesture did something, so the match means something
      expect(JSON.stringify(bare), `${mode} ${axis} moved`).not.toBe(JSON.stringify({ p: [0, 0, 0], q: [0, 0, 0, 1], s: [1, 1, 1] }))
    }
  })

  it('with the parked orthographic camera a bare TransformControls ring barely turns - the defect the adapter fixes', () => {
    placeCamera([0, 0, 10], 1)
    const { bare, adapter } = compare(camera, 'rotate', 'Y')
    const turn = (q: number[]) => deg(2 * Math.acos(Math.min(1, Math.abs(q[3]))))
    expect(turn(bare.q)).toBeLessThan(0.1)
    expect(turn(adapter.q)).toBeGreaterThan(5)
  })
})
