// @vitest-environment jsdom
//
// WO-2506: Form selects many points at once. A drag from empty space in the view draws a box; on release
// every cage point inside it the smooth skin does not hide is selected (Shift adds, Ctrl removes, a plain
// press with no move still clears). Real FormOverlay (picking, skin occlusion) and real FormInteraction
// pointer handling over a cylinder form; only the gizmo is a stub.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { act, cleanup, render, screen } from '@testing-library/react'
import { useFormStore } from '../../form/formStore'
import { FormInteraction, type FormInteractionHost } from '../../components/model3d/form/formInteraction'
import { FormOverlay } from '../../form/formOverlay'
import { FormPanel } from '../../components/model3d/form/FormPanel'
import { pointsInRect } from '../../form/pick'
import type { TransformControlsAdapter } from '../../components/model3d/gizmos/TransformControlsAdapter'

const st = () => useFormStore.getState()
const W = 400, H = 300
const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)
const ring = (z: number) => sorted(st().cage.positions.flatMap((p, i) => (Math.abs(p[2] - z) < 1e-6 ? [i] : [])))

function stubAdapter(): TransformControlsAdapter {
  return {
    object: undefined, enabled: true, axis: null,
    addEventListener: () => {}, removeEventListener: () => {}, attach: () => {}, detach: () => {},
    setMode: () => {}, setSpace: () => {}, getHelper: () => new THREE.Object3D(), dispose: () => {},
  } as unknown as TransformControlsAdapter
}

let canvas: HTMLCanvasElement
let camera: THREE.PerspectiveCamera
let overlay: FormOverlay
let interaction: FormInteraction
let orbit: boolean[]
// what reaches the document while a press is live: the orbit controls follow a drag from there
let documentMoves: number

const press = (type: 'pointerdown' | 'pointermove' | 'pointerup', x: number, y: number, mods: { shiftKey?: boolean; ctrlKey?: boolean; altKey?: boolean } = {}) =>
  canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true, ...mods }))
/** a real drag: press, a few moves on the way, release */
function drag(from: { x: number; y: number }, to: { x: number; y: number }, mods: { shiftKey?: boolean; ctrlKey?: boolean } = {}) {
  press('pointerdown', from.x, from.y, mods)
  for (let i = 1; i <= 4; i++) press('pointermove', from.x + (to.x - from.x) * i / 4, from.y + (to.y - from.y) * i / 4, mods)
  press('pointerup', to.x, to.y, mods)
}
function showScene(displayMode: 'both' | 'cage') {
  const s = st()
  overlay.update({ cage: s.cage, topologyVersion: s.topologyVersion, displayMode, dragging: false })
}
/** the screen box round some points, `pad` px wider each way */
function boxRound(points: readonly number[], pad = 12) {
  const at = points.map((p) => overlay.screenOf(st().cage.positions[p]))
  return {
    from: { x: Math.min(...at.map((q) => q.x)) - pad, y: Math.min(...at.map((q) => q.y)) - pad },
    to: { x: Math.max(...at.map((q) => q.x)) + pad, y: Math.max(...at.map((q) => q.y)) + pad },
  }
}
const onDocMove = () => { documentMoves++ }

beforeEach(() => {
  canvas = document.createElement('canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: W, height: H, right: W, bottom: H, x: 0, y: 0 } as DOMRect)
  document.body.appendChild(canvas)
  // under the cylinder (default: 40 across, 30 tall, rings at Z 0, 15, 30) looking up at its base: the base ring
  // is nearest, the rings above it sit inside it on screen, behind the base cap's skin
  camera = new THREE.PerspectiveCamera(50, W / H, 0.1, 1000)
  camera.position.set(0, 0, -40)
  camera.up.set(0, 1, 0)
  camera.lookAt(0, 0, 10)
  camera.updateMatrixWorld(true)
  orbit = []
  documentMoves = 0
  document.addEventListener('pointermove', onDocMove)
  st().openSession({ featureId: null, name: 'F' })
  st().setSymmetry(null)
  const host: FormInteractionHost = {
    canvas, camera: () => camera, addObject: () => {}, removeObject: () => {}, requestRender: () => {},
    setOrbitEnabled: (on) => { orbit.push(on) },
  }
  overlay = new FormOverlay({ canvas, camera: () => camera, addObject: () => {}, removeObject: () => {}, requestRender: () => {} })
  interaction = new FormInteraction(host, overlay, stubAdapter)
})
afterEach(() => {
  interaction.dispose()
  overlay.dispose()
  canvas.remove()
  document.removeEventListener('pointermove', onDocMove)
  cleanup()
})

describe('box select through the real overlay and pointer handling', () => {
  beforeEach(async () => {
    const { cylinderCage } = await import('../../form/starters')
    st().openSession({ featureId: null, name: 'F', cage: cylinderCage() })
    st().setSymmetry(null)
    showScene('both')
  })

  it('a box round the base ring, started on empty space, selects its 8 points - the skin hides the rings above', () => {
    const base = ring(0)
    const box = boxRound(base)
    // the press starts on empty space: no cage point, edge or face there
    expect(overlay.pickAt(box.from.x, box.from.y)).toBeNull()
    // the rings above project inside the box too: only the skin keeps them out
    const inBox = pointsInRect(st().cage, camera, W, H, box.from.x, box.from.y, box.to.x, box.to.y)
    expect(inBox.length).toBeGreaterThan(8)
    drag(box.from, box.to)
    expect(sorted(st().selection.points)).toEqual(base)
    expect(st().selection.edges).toEqual([])
    expect(st().selection.faces).toEqual([])
  })

  it('in Cage display nothing is hidden: every point in the box is taken', () => {
    showScene('cage')
    const box = boxRound(ring(0))
    const inBox = sorted(pointsInRect(st().cage, camera, W, H, box.from.x, box.from.y, box.to.x, box.to.y))
    drag(box.from, box.to)
    expect(sorted(st().selection.points)).toEqual(inBox)
    expect(inBox.length).toBe(st().cage.positions.length)
  })

  it('Ctrl-drag takes points out; Shift-drag adds them back; a plain click on empty space clears', () => {
    const base = ring(0)
    const box = boxRound(base)
    drag(box.from, box.to)
    // the half of the ring left of the view's centre line
    const centreX = overlay.screenOf([0, 0, 0]).x
    const left = base.filter((p) => overlay.screenOf(st().cage.positions[p]).x < centreX - 1)
    expect(left.length).toBeGreaterThan(0)
    const leftBox = boxRound(left)
    expect(overlay.pickAt(leftBox.from.x, leftBox.from.y)).toBeNull()
    drag(leftBox.from, { x: centreX - 2, y: leftBox.to.y }, { ctrlKey: true })
    expect(sorted(st().selection.points)).toEqual(base.filter((p) => !left.includes(p)))
    drag(leftBox.from, { x: centreX - 2, y: leftBox.to.y }, { shiftKey: true })
    expect(sorted(st().selection.points)).toEqual(base)
    // a press and release with no move on empty space: a click, which clears as it always has
    press('pointerdown', box.from.x, box.from.y)
    press('pointerup', box.from.x + 1, box.from.y + 1)
    expect(st().selection.points).toEqual([])
  })

  it('the box is drawn while dragged and gone after; the drag never reaches the orbit controls', () => {
    const box = boxRound(ring(0))
    press('pointerdown', box.from.x, box.from.y)
    // under the click slop: not yet a box
    press('pointermove', box.from.x + 2, box.from.y + 2)
    expect(document.querySelector('[data-testid="form-box-select"]')).toBeNull()
    press('pointermove', box.to.x, box.to.y)
    const shape = document.querySelector('[data-testid="form-box-select"]') as HTMLElement
    expect(shape).not.toBeNull()
    expect(parseFloat(shape.style.left)).toBeCloseTo(box.from.x, 6)
    expect(parseFloat(shape.style.width)).toBeCloseTo(box.to.x - box.from.x, 6)
    expect(interaction.draggingBox()).toBe(true)
    press('pointerup', box.to.x, box.to.y)
    expect(document.querySelector('[data-testid="form-box-select"]')).toBeNull()
    expect(interaction.draggingBox()).toBe(false)
    // the moves of a box drag stop at the canvas: the document (where the orbit controls follow a drag) sees none
    expect(documentMoves).toBe(0)
    // and the orbit switch is never touched
    expect(orbit).toEqual([])
    // a plain hover move still reaches the document
    canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 5, clientY: 5, buttons: 0, bubbles: true }))
    expect(documentMoves).toBe(1)
  })

  it('two fingers on empty space are a pinch or pan for the orbit controls: no box, the moves reach the document', () => {
    st().setSelection({ points: [3], edges: [], faces: [] })
    /** a touch pointer event: its own finger id, as a touch screen sends it */
    const finger = (type: 'pointerdown' | 'pointermove' | 'pointerup', id: number, x: number, y: number) => {
      const e = new MouseEvent(type, { clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true })
      Object.defineProperty(e, 'pointerId', { value: id })
      Object.defineProperty(e, 'pointerType', { value: 'touch' })
      canvas.dispatchEvent(e)
    }
    const a = { x: 10, y: 20 }, b = { x: 60, y: 20 }
    expect(overlay.pickAt(a.x, a.y)).toBeNull()
    expect(overlay.pickAt(b.x, b.y)).toBeNull()
    finger('pointerdown', 1, a.x, a.y)
    finger('pointerdown', 2, b.x, b.y)
    for (let k = 1; k <= 8; k++) {
      finger('pointermove', 1, a.x, a.y + 5 * k)
      finger('pointermove', 2, b.x + 5 * k, b.y + 5 * k)
    }
    expect(interaction.draggingBox()).toBe(false)
    expect(document.querySelector('[data-testid="form-box-select"]')).toBeNull()
    // every move of both fingers reaches the document, where the orbit controls follow them
    expect(documentMoves).toBe(16)
    finger('pointerup', 1, a.x, a.y + 40)
    finger('pointerup', 2, b.x + 40, b.y + 40)
    // the pinch selects nothing
    expect(st().selection.points).toEqual([3])
    // the second finger came down after the first had already moved past a click: still navigation, no box
    finger('pointerdown', 1, a.x, a.y)
    finger('pointermove', 1, a.x + 30, a.y + 30)
    expect(interaction.draggingBox()).toBe(true)
    finger('pointerdown', 2, b.x, b.y)
    expect(interaction.draggingBox()).toBe(false)
    expect(document.querySelector('[data-testid="form-box-select"]')).toBeNull()
    const before = documentMoves
    finger('pointermove', 1, a.x + 30, a.y + 60)
    finger('pointermove', 2, b.x, b.y + 30)
    expect(documentMoves).toBe(before + 2)
    finger('pointerup', 1, a.x + 30, a.y + 60)
    finger('pointerup', 2, b.x, b.y + 30)
    expect(st().selection.points).toEqual([3])
    // one finger alone afterwards is a box again, as a mouse drag is
    finger('pointerdown', 1, a.x, a.y)
    finger('pointermove', 1, a.x + 30, a.y + 30)
    expect(interaction.draggingBox()).toBe(true)
    finger('pointerup', 1, a.x + 30, a.y + 30)
  })

  it('a pinch whose fingers lift off the view leaves no finger behind: the next lone finger draws a box', () => {
    /** a touch pointer event sent to `on`: the canvas, or wherever the finger is when it lifts */
    const finger = (type: 'pointerdown' | 'pointermove' | 'pointerup', id: number, x: number, y: number, on: EventTarget = canvas, primary?: boolean) => {
      const e = new MouseEvent(type, { clientX: x, clientY: y, button: type === 'pointermove' ? -1 : 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true })
      Object.defineProperty(e, 'pointerId', { value: id })
      Object.defineProperty(e, 'pointerType', { value: 'touch' })
      if (primary !== undefined) Object.defineProperty(e, 'isPrimary', { value: primary })
      on.dispatchEvent(e)
    }
    const a = { x: 10, y: 20 }, b = { x: 60, y: 20 }
    // the pinch drops the first finger's capture; both fingers end outside the canvas and lift there
    finger('pointerdown', 1, a.x, a.y)
    finger('pointerdown', 2, b.x, b.y)
    finger('pointerup', 1, -150, 60, document.body)
    finger('pointerup', 2, -80, 60, document.body)
    finger('pointerdown', 3, a.x, a.y)
    finger('pointermove', 3, a.x + 30, a.y + 30)
    expect(interaction.draggingBox()).toBe(true)
    finger('pointerup', 3, a.x + 30, a.y + 30)
    // a lift the page never heard of (the window lost focus): the browser's primary mark on the next fresh
    // finger says no other finger is down
    finger('pointerdown', 4, a.x, a.y)
    finger('pointerdown', 5, b.x, b.y)
    finger('pointerdown', 6, a.x, a.y, canvas, true)
    finger('pointermove', 6, a.x + 30, a.y + 30)
    expect(interaction.draggingBox()).toBe(true)
    finger('pointerup', 6, a.x + 30, a.y + 30)
    // and a real second finger is still a pinch
    finger('pointerdown', 7, a.x, a.y, canvas, true)
    finger('pointerdown', 8, b.x, b.y, canvas, false)
    expect(interaction.draggingBox()).toBe(false)
    finger('pointerup', 7, a.x, a.y)
    finger('pointerup', 8, b.x, b.y)
  })

  it('Esc during a box drag drops it: nothing changes on release', () => {
    st().setSelection({ points: [3], edges: [], faces: [] })
    const box = boxRound(ring(0))
    press('pointerdown', box.from.x, box.from.y)
    press('pointermove', box.to.x, box.to.y)
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(document.querySelector('[data-testid="form-box-select"]')).toBeNull()
    expect(interaction.draggingBox()).toBe(false)
    // the rest of the held drag still never reaches the orbit controls, and draws no box again
    press('pointermove', box.to.x + 20, box.to.y + 20)
    expect(documentMoves).toBe(0)
    expect(document.querySelector('[data-testid="form-box-select"]')).toBeNull()
    press('pointerup', box.to.x, box.to.y)
    expect(st().selection.points).toEqual([3])
    // the selection's own Esc (clear) is not eaten once the box is gone
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    expect(st().selection.points).toEqual([])
  })

  it('a press on a cage point is no box: the point is selected and nothing is drawn', () => {
    const p = ring(0)[0]
    const s = overlay.screenOf(st().cage.positions[p])
    expect(overlay.pickAt(s.x, s.y)).toEqual({ kind: 'point', index: p })
    press('pointerdown', s.x, s.y)
    press('pointerup', s.x, s.y)
    expect(st().selection.points).toEqual([p])
    press('pointerdown', s.x, s.y)
    press('pointermove', s.x + 30, s.y + 30)
    expect(interaction.draggingBox()).toBe(false)
    expect(document.querySelector('[data-testid="form-box-select"]')).toBeNull()
    press('pointerup', s.x + 30, s.y + 30)
    // a drag from a point is not a click: the selection stays
    expect(st().selection.points).toEqual([p])
  })

  it('Alt held, or the Face tool on: a press on empty space draws no box', () => {
    const box = boxRound(ring(0))
    press('pointerdown', box.from.x, box.from.y, { altKey: true })
    press('pointermove', box.to.x, box.to.y, { altKey: true })
    expect(interaction.draggingBox()).toBe(false)
    press('pointerup', box.to.x, box.to.y, { altKey: true })
    st().startFaceTool({ replace: false })
    press('pointerdown', box.from.x, box.from.y)
    press('pointermove', box.to.x, box.to.y)
    expect(interaction.draggingBox()).toBe(false)
    press('pointerup', box.to.x, box.to.y)
    st().stopFaceTool()
  })

  /** move the selection 5 mm up (one gizmo drag, as the store sees it); which points rose */
  function liftSelection(): number[] {
    const before = st().cage.positions.map((p) => p[2])
    st().beginMove({ extrude: false })
    st().moveBy(new THREE.Matrix4().makeTranslation(0, 0, 5).elements)
    st().endDrag()
    return st().cage.positions.flatMap((p, i) => (Math.abs(p[2] - before[i] - 5) < 1e-6 ? [i] : []))
  }

  it('mirror symmetry follows a box selection as it follows a click: a move takes the mirror side too', () => {
    st().setSymmetry('x')
    const base = ring(0)
    const right = base.filter((p) => st().cage.positions[p][0] > 1)
    expect(right).toHaveLength(3)
    const box = boxRound(right)
    expect(overlay.pickAt(box.from.x, box.from.y)).toBeNull()
    drag(box.from, box.to)
    expect(sorted(st().selection.points)).toEqual(right)
    // the three right-hand points and their three mirror partners on the left
    const mirrored = base.filter((p) => Math.abs(st().cage.positions[p][0]) > 1)
    expect(sorted(liftSelection())).toEqual(mirrored)
  })

  it('circular symmetry follows a box selection too: one point boxed, its copies round Z move with it', () => {
    st().setSymmetry('c4')
    const base = ring(0)
    const p = base[0]
    const box = boxRound([p])
    expect(overlay.pickAt(box.from.x, box.from.y)).toBeNull()
    drag(box.from, box.to)
    expect(st().selection.points).toEqual([p])
    expect(sorted(liftSelection())).toEqual([0, 2, 4, 6].map((k) => base[k]))
  })

  it('Loop from box-selected ring points: the whole ring', () => {
    const base = ring(0)
    const box = boxRound(base.filter((p) => st().cage.positions[p][0] > 1))
    drag(box.from, box.to)
    st().selectLoop()
    expect(sorted(st().selection.points)).toEqual(base)
  })
})

describe('the selection line says how', () => {
  const session = {
    active: true, open: () => {}, finish: vi.fn(), cancel: vi.fn(), undo: () => {}, redo: () => {},
    canUndo: false, canRedo: false, railSections: [],
  }
  beforeEach(() => { window.localStorage.clear(); st().openSession({ featureId: null, name: 'Form 1' }) })
  afterEach(() => { cleanup(); st().closeSession() })

  it('one line: the mode sentence or what is selected, then the box hint; no pop-up', () => {
    render(<FormPanel session={session} />)
    const line = screen.getByTestId('form-selection').parentElement!
    expect(line.textContent).toBe('Move: click a point, edge or face to select it; Shift adds. Drag a box to select many points; Shift adds, Ctrl removes.')
    act(() => st().selectPoints([0, 1, 2], 'replace'))
    expect(line.textContent).toBe('Selected: 3 points. Drag a box to select many points; Shift adds, Ctrl removes.')
    act(() => st().setTransformMode('rotate'))
    act(() => st().setSelection({ points: [], edges: [], faces: [] }))
    expect(line.textContent).toBe('Rotate: click a point, edge or face to rotate it. Drag a box to select many points; Shift adds, Ctrl removes.')
    expect(document.querySelector('[role="dialog"]')).toBeNull()
  })
})
