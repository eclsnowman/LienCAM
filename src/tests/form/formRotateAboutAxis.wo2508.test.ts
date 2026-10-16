// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { createElement } from 'react'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useFormStore } from '../../form/formStore'
import { boxCage } from '../../form/starters'
import { edgeKey, type Vec3 } from '../../form/cage'
import { centroidOf, selectionPoints } from '../../form/topology'
import { FormOverlay } from '../../form/formOverlay'
import { FormInteraction } from '../../components/model3d/form/formInteraction'
import { FormPanel } from '../../components/model3d/form/FormPanel'
import type { FormSession } from '../../components/model3d/form/useFormSession'

const st = () => useFormStore.getState()
const positions = () => st().cage.positions.map((p) => [...p] as Vec3)
const top = () => st().cage.faces.flatMap((f, i) => f.every((p) => st().cage.positions[p][2] === 40) ? [i] : [])
function selectTop() { st().setSelection({ points: [], edges: [], faces: top() }); st().setTransformMode('rotate') }
function edge() {
  const f = st().cage.faces[top()[0]]
  return { kind: 'edge' as const, key: edgeKey(f[0], f[1]) }
}
function chooseEdge() { st().chooseRotationAxis('edge'); st().pickRotationAxis(edge()) }
function expectPoint(actual: Vec3, expected: Vec3) { expected.forEach((v, k) => expect(actual[k]).toBeCloseTo(v, 8)) }
// Independent quarter-turn oracle: no production matrix or transform helper.
function quarter(p: Vec3, o: Vec3, axis: 'x' | 'y' | 'z'): Vec3 {
  const [x, y, z] = p.map((v, k) => v - o[k])
  const q = axis === 'x' ? [x, -z, y] : axis === 'y' ? [z, y, -x] : [-y, x, z]
  return q.map((v, k) => v + o[k]) as Vec3
}
beforeEach(() => {
  st().openSession({ featureId: null, name: 'Axis test', cage: boxCage() })
  st().setSoftRadius(0)
  st().setSymmetry(null)
})
afterEach(cleanup)

describe('WO-2508 fixed line rotation', () => {
  it('turns selected faces 90 deg about their edge, retaining hinge points and every unselected point', () => {
    selectTop(); chooseEdge()
    const before = positions(), ids = selectionPoints(st().cage, st().selection), axis = st().rotationAxis!
    const [a, b] = edge().key.split(':').map(Number)
    expect(axis.direction).toEqual([1, 0, 0])
    st().rotateSelection()
    before.forEach((p, i) => expectPoint(positions()[i], ids.includes(i) ? quarter(p, axis.origin, 'x') : p))
    expectPoint(positions()[a], before[a]); expectPoint(positions()[b], before[b])
    expect(st().history.past).toHaveLength(1)
    expect(st().rotationAxis).toEqual(axis)
    // A second turn uses the same line, not the now moved selection centre.
    st().rotateSelection()
    ids.forEach((i) => expectPoint(positions()[i], quarter(quarter(before[i], axis.origin, 'x'), axis.origin, 'x')))
    st().undo(); st().undo(); expect(positions()).toEqual(before)
    expect(st().rotationAxis).toBeNull()
    st().redo(); ids.forEach((i) => expectPoint(positions()[i], quarter(before[i], axis.origin, 'x')))
  })
  it.each(['x', 'y', 'z'] as const)('%s through a picked cage point leaves that point fixed and turns the selected faces', (axis) => {
    selectTop()
    const before = positions(), ids = selectionPoints(st().cage, st().selection), point = ids[0]
    st().chooseRotationAxis(axis); st().pickRotationAxis({ kind: 'point', index: point })
    st().rotateSelection()
    before.forEach((p, i) => expectPoint(positions()[i], ids.includes(i) ? quarter(p, before[point], axis) : p))
  })
  it('handles an oblique cage edge and a negative typed angle', () => {
    const c = boxCage(), turn = new THREE.Matrix4().makeRotationZ(Math.PI / 6)
    c.positions = c.positions.map((p) => new THREE.Vector3(...p).applyMatrix4(turn).toArray() as Vec3)
    st().openSession({ featureId: null, name: 'Oblique', cage: c }); selectTop(); chooseEdge()
    const before = positions(), axis = st().rotationAxis!, ids = selectionPoints(st().cage, st().selection)
    st().setRotationAngle(-90); st().rotateSelection()
    // Dot product along the line and distance from it are invariant for every point.
    const d = new THREE.Vector3(...axis.direction), o = new THREE.Vector3(...axis.origin)
    ids.forEach((i) => {
      const p = new THREE.Vector3(...before[i]).sub(o), q = new THREE.Vector3(...positions()[i]).sub(o)
      expect(q.dot(d)).toBeCloseTo(p.dot(d), 8)
      expect(q.clone().cross(d).length()).toBeCloseTo(p.clone().cross(d).length(), 8)
      if (p.clone().cross(d).length() > 1e-6) expect(p.clone().cross(q).dot(d)).toBeLessThan(0)
    })
  })
  it('typed centre rotation turns about the selection centroid', () => {
    selectTop(); const before = positions(), ids = selectionPoints(st().cage, st().selection), o = centroidOf(st().cage, ids)
    st().setRotationCentreAxis('y'); st().rotateSelection()
    ids.forEach((i) => expectPoint(positions()[i], quarter(before[i], o, 'y')))
  })
  it('repair F2 cancels the Y point instruction on Move -> Scale -> Rotate', () => {
    selectTop(); st().chooseRotationAxis('y')
    expect(st().notice).toBe('Click a cage point for the Y axis; Esc cancels')
    st().setTransformMode('translate'); st().setTransformMode('scale'); st().setTransformMode('rotate')
    expect(st().rotationPick).toBeNull(); expect(st().rotationAxis).toBeNull()
    expect(st().notice).toBeNull()
  })
  it.each(['move', 'scale', 'selection', 'positions'] as const)('repair F2 clears only the current axis instruction on %s', (route) => {
    for (const picked of [false, true]) {
      selectTop(); st().chooseRotationAxis('y')
      if (picked) st().pickRotationAxis({ kind: 'point', index: 0 })
      if (route === 'move') st().setTransformMode('translate')
      if (route === 'scale') st().setTransformMode('scale')
      if (route === 'selection') st().select(null, false)
      if (route === 'positions') st().applyCage(st().cage, { topology: false, record: false })
      expect(st().rotationPick).toBeNull(); expect(st().rotationAxis).toBeNull()
      expect(st().notice).toBeNull()
    }
  })
  it.each(['move', 'scale', 'selection', 'positions', 'cancel'] as const)('repair F2 preserves unrelated tool feedback on %s', (route) => {
    for (const picked of [false, true]) {
      selectTop(); st().chooseRotationAxis('y')
      if (picked) st().pickRotationAxis({ kind: 'point', index: 0 })
      st().setNotice('Symmetry off')
      if (route === 'move') st().setTransformMode('translate')
      if (route === 'scale') st().setTransformMode('scale')
      if (route === 'selection') st().select(null, false)
      if (route === 'positions') st().applyCage(st().cage, { topology: false, record: false })
      if (route === 'cancel') st().chooseRotationAxis(null)
      expect(st().rotationPick).toBeNull(); expect(st().rotationAxis).toBeNull()
      expect(st().notice).toBe('Symmetry off')
    }
  })
  it('repair F2 preserves replacement tool feedback and completed rotation history', () => {
    selectTop(); st().chooseRotationAxis('y'); st().subdivideSelection()
    expect(st().rotationPick).toBeNull(); expect(st().notice).toMatch(/^Subdivided /)
    st().chooseRotationAxis('y'); st().startFaceTool({ replace: false })
    expect(st().rotationPick).toBeNull(); expect(st().notice).toMatch(/^Face:/)
    st().stopFaceTool(); selectTop(); chooseEdge(); st().rotateSelection()
    const notice = st().notice
    expect(notice).toMatch(/^Rotated /)
    st().select(null, false); expect(st().rotationAxis).toBeNull(); expect(st().notice).toBe(notice)
  })
  it('wrong picks and zero-length edges retain pick mode and do not alter selection/history', () => {
    selectTop(); const sel = st().selection, before = positions()
    st().chooseRotationAxis('edge'); st().pickRotationAxis({ kind: 'face', index: top()[0] })
    st().pickRotationAxis({ kind: 'edge', key: '0:0' }); st().rotateSelection()
    expect(st().rotationPick).toBe('edge'); expect(st().rotationAxis).toBeNull()
    expect(st().selection).toBe(sel); expect(positions()).toEqual(before); expect(st().history.past).toHaveLength(0)
    st().chooseRotationAxis('x'); st().pickRotationAxis(edge()); expect(st().rotationPick).toBe('x')
  })
  it.each(['selection', 'topology', 'positions', 'move', 'scale', 'close', 'open', 'face'] as const)('clears the line on %s changes', (route) => {
    selectTop(); chooseEdge()
    if (route === 'selection') st().select(null, false)
    if (route === 'topology') st().subdivideSelection()
    if (route === 'positions') st().applyCage(st().cage, { topology: false, record: false })
    if (route === 'move') st().setTransformMode('translate')
    if (route === 'scale') st().setTransformMode('scale')
    if (route === 'close') st().closeSession()
    if (route === 'open') st().openSession({ featureId: null, name: 'Next' })
    if (route === 'face') st().startFaceTool({ replace: false })
    expect(st().rotationAxis).toBeNull(); expect(st().rotationPick).toBeNull()
  })
  it.each(['x', 'c4'] as const)('retains the existing %s symmetry mapping for the primary selection and its partners', (symmetry) => {
    st().setSymmetry(symmetry)
    const point = st().cage.positions.findIndex((p) => p[0] === 20 && p[1] === 20 && p[2] === 40)
    st().setSelection({ points: [point], edges: [], faces: [] }); st().setTransformMode('rotate')
    st().chooseRotationAxis('z'); st().pickRotationAxis({ kind: 'point', index: 0 })
    const origin = st().rotationAxis!.origin, before = positions(), wanted = quarter(before[point], origin, 'z')
    st().rotateSelection(); expectPoint(positions()[point], wanted)
    before.forEach((p, i) => {
      if (symmetry === 'x' && p[0] === -20 && p[1] === 20 && p[2] === 40) expectPoint(positions()[i], [-wanted[0], wanted[1], wanted[2]])
      if (symmetry === 'c4' && p[2] === 40 && Math.abs(p[0]) === 20 && Math.abs(p[1]) === 20) {
        const angle = Math.atan2(p[1], p[0]) - Math.PI / 4, c = Math.cos(angle), s = Math.sin(angle)
        expectPoint(positions()[i], [wanted[0] * c - wanted[1] * s, wanted[0] * s + wanted[1] * c, wanted[2]])
      }
      if (symmetry === 'x' && p[0] === 0) expect(positions()[i][0]).toBe(0)
    })
  })
  it('uses the existing numeric control and Apply without a dialog', () => {
    selectTop(); chooseEdge()
    st().setRotationAngle(15)
    const before = positions()
    render(createElement(FormPanel, { session: { cancel() {}, finish() {} } as unknown as FormSession }))
    const input = screen.getByRole('textbox', { name: 'Rotation angle' })
    fireEvent.change(input, { target: { value: '90' } }); fireEvent.keyDown(input, { key: 'Enter' })
    fireEvent.click(screen.getByTestId('form-rotation-apply'))
    expect(positions()).not.toEqual(before); expect(st().rotationAngle).toBe(90)
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.change(screen.getByTestId('form-rotation-axis'), { target: { value: 'y' } })
    expect(st().rotationPick).toBe('y'); expect(st().rotationAxis).toBeNull()
    expect((screen.getByTestId('form-rotation-apply') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.change(screen.getByTestId('form-rotation-axis'), { target: { value: 'centre' } })
    expect(st().rotationPick).toBeNull()
  })
})

describe('WO-2508 viewport picking and ring', () => {
  let canvas: HTMLCanvasElement, overlay: FormOverlay, interaction: FormInteraction, scene: THREE.Scene, camera: THREE.OrthographicCamera
  const frame = () => { camera.updateMatrixWorld(true); scene.updateMatrixWorld(true) }
  function pointer(type: string, x: number, y: number, buttons = 0) {
    const e = new MouseEvent(type, { clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons, bubbles: true })
    Object.defineProperty(e, 'pointerId', { value: 1 }); Object.defineProperty(e, 'pointerType', { value: 'mouse' }); canvas.dispatchEvent(e); frame()
  }
  beforeEach(() => {
    canvas = document.createElement('canvas'); document.body.appendChild(canvas)
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1200, height: 900 } as DOMRect)
    canvas.setPointerCapture = () => {}; canvas.releasePointerCapture = () => {}
    scene = new THREE.Scene(); camera = new THREE.OrthographicCamera(-70, 70, 52.5, -52.5, 1, 200000)
    camera.position.set(60000, -60000, 64000); camera.up.set(0, 0, 1); camera.lookAt(0, 0, 20); camera.updateProjectionMatrix(); frame()
    const host = { canvas, camera: () => camera, addObject: (o: THREE.Object3D) => { scene.add(o) }, removeObject: (o: THREE.Object3D) => { scene.remove(o) }, requestRender() {}, setOrbitEnabled() {} }
    overlay = new FormOverlay(host)
    overlay.update({ cage: st().cage, topologyVersion: st().topologyVersion, displayMode: 'cage', dragging: false })
    interaction = new FormInteraction(host, overlay)
    selectTop(); frame()
  })
  afterEach(() => { interaction.dispose(); overlay.dispose(); canvas.remove() })
  it.each(['x', 'y', 'z'] as const)('a viewport point click picks %s without altering the selected faces', (axis) => {
    const point = st().cage.faces[top()[0]][0], q = overlay.screenOf(st().cage.positions[point]), selection = st().selection
    expect(overlay.pickAt(q.x, q.y)).toEqual({ kind: 'point', index: point })
    st().chooseRotationAxis(axis)
    pointer('pointerdown', q.x, q.y, 1); pointer('pointerup', q.x, q.y)
    expect(st().rotationAxis?.label).toBe(`${axis.toUpperCase()} through point ${point}`)
    expect(st().selection).toBe(selection)
  })
  it('pointer cancellation abandons the press, retaining pick mode for a fresh click', () => {
    const selection = st().selection
    st().chooseRotationAxis('edge')
    pointer('pointerdown', 500, 400, 1); pointer('pointercancel', 500, 400); pointer('pointerup', 500, 400)
    expect(st().rotationAxis).toBeNull(); expect(st().rotationPick).toBe('edge'); expect(st().selection).toBe(selection)
  })
  it('a canvas edge click chooses the line without selecting the edge; Esc restores centre and keeps the face selection', () => {
    const pick = edge(), [a, b] = pick.key.split(':').map(Number), p = st().cage.positions[a], q = st().cage.positions[b]
    const mid = p.map((v, k) => (v + q[k]) / 2) as Vec3, screen = overlay.screenOf(mid), sel = st().selection
    expect(overlay.pickAt(screen.x, screen.y)).toEqual(pick)
    st().chooseRotationAxis('edge')
    pointer('pointerdown', screen.x, screen.y, 1); pointer('pointerup', screen.x, screen.y)
    expect(st().rotationAxis?.label).toBe(`edge ${pick.key}`); expect(st().selection).toBe(sel)
    expect(scene.getObjectByName('form-rotation-axis')?.visible).toBe(true)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    expect(st().rotationAxis).toBeNull(); expect(st().selection).toBe(sel)
    expect(scene.getObjectByName('form-rotation-axis')?.visible).toBe(false)
    st().chooseRotationAxis('y'); window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(st().rotationPick).toBeNull(); expect(st().selection).toBe(sel)
  })
  it('dragging the single ring turns about the picked edge, with on-axis points stationary', () => {
    chooseEdge(); frame()
    const before = positions(), axis = st().rotationAxis!, c = overlay.screenOf(axis.origin)
    let handle: { x: number; y: number } | null = null
    for (let r = 5; r < 250 && !handle; r += 4) for (let a = 0; a < 360 && !handle; a += 8) {
      const x = c.x + r * Math.cos(a * Math.PI / 180), y = c.y + r * Math.sin(a * Math.PI / 180)
      pointer('pointermove', x, y)
      if (interaction.gizmoAxis() === 'Z') handle = { x, y }
    }
    expect(handle).not.toBeNull()
    const h = handle!, dx = h.x - c.x, dy = h.y - c.y, l = Math.hypot(dx, dy)
    pointer('pointerdown', h.x, h.y, 1)
    for (let k = 1; k <= 12; k++) pointer('pointermove', h.x - dy / l * 30 * k / 12, h.y + dx / l * 30 * k / 12, 1)
    pointer('pointerup', h.x - dy / l * 30, h.y + dx / l * 30)
    expect(st().dragging).toBe(false); expect(positions()).not.toEqual(before)
    const d = new THREE.Vector3(...axis.direction), o = new THREE.Vector3(...axis.origin)
    selectionPoints(st().cage, st().selection).forEach((i) => {
      const p = new THREE.Vector3(...before[i]).sub(o), q = new THREE.Vector3(...positions()[i]).sub(o)
      expect(q.dot(d)).toBeCloseTo(p.dot(d), 7); expect(q.clone().cross(d).length()).toBeCloseTo(p.clone().cross(d).length(), 7)
      if (p.clone().cross(d).length() < 1e-8) expectPoint(positions()[i], before[i])
    })
    expect(st().rotationAxis).toEqual(axis)
    st().undo(); expect(positions()).toEqual(before)
  })
})
