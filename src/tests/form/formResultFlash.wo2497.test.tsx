// @vitest-environment jsdom
//
// WO-2497: after a Form tool runs, what it changed is drawn in its own colour for about two seconds with the
// move arrows held back; a click, drag or another tool ends it at once; a tool that changes nothing says so
// and does not flash. The flash is display only: never in the cage, the undo history or the saved form.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { edgeKey, type Cage } from '../../form/cage'
import { FormOverlay } from '../../form/formOverlay'
import { RESULT_FLASH_MS, useFormStore } from '../../form/formStore'
import { boxCage, planeCage, sphereCage } from '../../form/starters'
import { makeFormFeaturePayload } from '../../form/formBody'
import { FormInteraction, type FormInteractionHost } from '../../components/model3d/form/formInteraction'
import type { TransformControlsAdapter } from '../../components/model3d/gizmos/TransformControlsAdapter'
import { asNumber } from '../../theme/viewportColors'

const st = () => useFormStore.getState()
const open = (cage?: Cage) => st().openSession({ featureId: null, name: 'Form 1', cage })
const at = (c: Cage, x: number, y: number, z: number) => c.positions.findIndex((p) => Math.abs(p[0] - x) < 1e-9 && Math.abs(p[1] - y) < 1e-9 && Math.abs(p[2] - z) < 1e-9)
const topFace = (c: Cage) => c.faces.findIndex((f) => f.every((p) => c.positions[p][2] === 40))

let overlay: FormOverlay
let interaction: FormInteraction
let canvas: HTMLCanvasElement
let attached: boolean
let unsubscribe: () => void

function stubAdapter(): TransformControlsAdapter {
  return {
    object: undefined, enabled: true, axis: null,
    addEventListener: () => {}, removeEventListener: () => {},
    attach: () => { attached = true }, detach: () => { attached = false },
    setMode: () => {}, setSpace: () => {}, getHelper: () => new THREE.Object3D(), dispose: () => {},
  } as unknown as TransformControlsAdapter
}

beforeEach(() => {
  vi.useFakeTimers()
  open(boxCage({ segments: { x: 1, y: 1, z: 1 } }))
  canvas = document.createElement('canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0 } as DOMRect)
  document.body.appendChild(canvas)
  const host: FormInteractionHost = { canvas, camera: () => new THREE.PerspectiveCamera(), addObject: () => {}, removeObject: () => {}, requestRender: () => {}, setOrbitEnabled: () => {} }
  overlay = new FormOverlay(host)
  const push = () => { const s = st(); overlay.update({ cage: s.cage, topologyVersion: s.topologyVersion, displayMode: s.displayMode, dragging: s.dragging, skinLevel: 1 }) }
  unsubscribe = useFormStore.subscribe((s, prev) => { if (s.cage !== prev.cage || s.displayMode !== prev.displayMode) push() })
  push()
  attached = false
  interaction = new FormInteraction(host, overlay, stubAdapter)
})
afterEach(() => {
  interaction.dispose()
  unsubscribe()
  overlay.dispose()
  canvas.remove()
  st().clearResultFlash()
  st().setDisplayMode('both')
  vi.useRealTimers()
})

describe('WO-2497 a tool result flashes in its own colour', () => {
  it('Crease on the top face: its 4 rim edges flash, the arrows wait ~2 s, then return on the selection; the creases stay violet in Smooth display', () => {
    st().setDisplayMode('smooth')
    const top = topFace(st().cage)
    st().setSelection({ points: [], edges: [], faces: [top] })
    expect(attached).toBe(true)
    st().crease(true)
    const rim = st().cage.faces[top].map((p, i, f) => edgeKey(p, f[(i + 1) % f.length]))
    expect(st().resultFlash).toEqual({ points: [], edges: expect.arrayContaining(rim), faces: [] })
    expect(st().resultFlash!.edges).toHaveLength(4)
    expect(st().notice).toBe('Creased 4 edges')
    // drawn: 4 edge strokes and their 4 corners in the change colour, the amber selection waiting, no arrows
    expect(overlay.flashShown()).toEqual({ points: 4, edges: 4, faces: 0, color: asNumber('--vp-overlay-removal') })
    expect(attached).toBe(false)
    vi.advanceTimersByTime(1000)
    expect(overlay.flashShown()).not.toBeNull()
    expect(attached).toBe(false)
    vi.advanceTimersByTime(RESULT_FLASH_MS - 1000)
    expect(st().resultFlash).toBeNull()
    expect(overlay.flashShown()).toBeNull()
    expect(attached).toBe(true)
    // the creased rim is drawn violet in Smooth display, above the amber selection strokes
    const crease = overlay.root.getObjectByName('form-crease-edges') as THREE.LineSegments
    expect(crease.visible).toBe(true)
    expect(crease.geometry.getAttribute('position').count).toBe(8)
    expect((crease.material as THREE.LineBasicMaterial).color.getHex()).toBe(asNumber('--vp-seed'))
    const selectedEdges = overlay.root.children.flatMap((o) => o.children).filter((o) => o instanceof THREE.LineSegments) as THREE.LineSegments[]
    expect(selectedEdges.every((o) => o.renderOrder < crease.renderOrder)).toBe(true)
  })

  it('the change colour is told apart from the selection amber, the cage blue, the crease and mirror violet and the border green', () => {
    const change = asNumber('--vp-overlay-removal')
    for (const other of ['--vp-select-amber', '--vp-loop-default', '--vp-seed', '--vp-plane-feed', '--vp-brep-hover']) expect(change).not.toBe(asNumber(other))
  })

  it('Crease again on already creased edges: says so, no flash, no undo step', () => {
    const top = topFace(st().cage)
    st().setSelection({ points: [], edges: [], faces: [top] })
    st().crease(true)
    st().clearResultFlash()
    const steps = st().history.past.length
    const cage = st().cage
    st().crease(true)
    expect(st().notice).toBe('Crease: already creased - nothing changed')
    expect(st().resultFlash).toBeNull()
    expect(st().history.past.length).toBe(steps)
    expect(st().cage).toBe(cage)
    // a side edge (bottom corner to top corner) was never creased
    const side = edgeKey(at(cage, -20, -20, 0), at(cage, -20, -20, 40))
    expect(cage.creases).not.toContain(side)
    st().setSelection({ points: [], edges: [side], faces: [] })
    st().crease(false)
    expect(st().notice).toBe('Uncrease: already smooth - nothing changed')
    expect(st().history.past.length).toBe(steps)
  })

  it('a tool that changes nothing, pressed DURING a flash, ends the flash at once and the arrows return', () => {
    const top = topFace(st().cage)
    st().setSelection({ points: [], edges: [], faces: [top] })
    st().crease(true)
    expect(st().resultFlash).not.toBeNull()
    expect(attached).toBe(false)
    const cage = st().cage
    // the rail's Crease again within the two seconds: no canvas press, same form, same selection
    st().crease(true)
    expect(st().notice).toBe('Crease: already creased - nothing changed')
    expect(st().cage).toBe(cage)
    expect(st().resultFlash).toBeNull()
    expect(overlay.flashShown()).toBeNull()
    expect(attached).toBe(true)
    // the same for another tool that finds nothing to do (Uniform on the even box) during a fresh flash
    st().crease(false)
    expect(st().resultFlash).not.toBeNull()
    expect(attached).toBe(false)
    const uncreased = st().cage
    st().makeUniformSelection()
    expect(st().cage).toBe(uncreased)
    expect(st().resultFlash).toBeNull()
    expect(attached).toBe(true)
  })

  it('choosing Rotate, Scale or Move (even the one already on), the display or a tool setting DURING a flash ends it at once and the arrows return', () => {
    const top = topFace(st().cage)
    const flashThen = (choose: () => void) => {
      st().setSelection({ points: [], edges: [], faces: [top] })
      st().crease(!st().cage.creases.length)
      expect(st().resultFlash).not.toBeNull()
      expect(attached).toBe(false)
      const cage = st().cage
      choose()
      expect(st().cage).toBe(cage)
      expect(st().resultFlash).toBeNull()
      expect(overlay.flashShown()).toBeNull()
      expect(attached).toBe(true)
    }
    st().setTransformMode('translate')
    // the rail's Rotate and Scale buttons: no canvas press, same form, same selection
    flashThen(() => st().setTransformMode('rotate'))
    expect(st().transformMode).toBe('rotate')
    flashThen(() => st().setTransformMode('scale'))
    expect(st().transformMode).toBe('scale')
    // Scale again: the mode does not change, but pressing it asks for the arrows
    flashThen(() => st().setTransformMode('scale'))
    flashThen(() => st().setTransformMode('translate'))
    flashThen(() => st().setDisplayMode('smooth'))
    flashThen(() => st().setCreaseWeight(2))
    st().setCreaseWeight(0)
  })

  it('Insert point: the new point flashes; Weld: the merged point flashes', () => {
    const c = st().cage
    st().select({ kind: 'edge', key: edgeKey(c.faces[0][0], c.faces[0][1]) }, false)
    st().insertPointOnSelection()
    expect(st().resultFlash).toEqual({ points: [8], edges: [], faces: [] })
    expect(overlay.flashShown()).toMatchObject({ points: 1, edges: 0, faces: 0 })
    st().select({ kind: 'edge', key: edgeKey(st().cage.faces[1][0], st().cage.faces[1][1]) }, false)
    // a click ends the flash at once
    expect(st().resultFlash).toBeNull()
    st().weldSelection()
    expect(st().resultFlash).toEqual({ points: [st().selection.points[0]], edges: [], faces: [] })
    expect(attached).toBe(false)
  })

  it('Uniform after one point was dragged 5 mm: the points that moved flash; on an already even sphere: "already even - nothing moved", no flash, no undo step', () => {
    open(boxCage({ segments: { x: 4, y: 4, z: 4 } }))
    const p = at(st().cage, 10, 10, 40)
    st().setSelection({ points: [p], edges: [], faces: [] })
    st().beginMove({ extrude: false })
    st().moveBy([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1])
    st().endDrag()
    st().setSelection({ points: [], edges: [], faces: [] })
    const before = st().cage
    st().makeUniformSelection()
    const moved = st().resultFlash!.points
    expect(moved).toContain(p)
    // exactly the points that moved by 0.005 mm or more
    for (let i = 0; i < before.positions.length; i++) {
      const d = Math.hypot(...[0, 1, 2].map((k) => st().cage.positions[i][k] - before.positions[i][k]))
      expect(moved.includes(i)).toBe(d >= 0.005)
    }
    expect(st().notice).toMatch(/the farthest moved \d+\.\d\d mm/)

    // the starter sphere (the WO-2490 finding's "26 moved, 0.12 -> 0.12") is already even
    open(sphereCage())
    st().setSelection({ points: [], edges: [], faces: [] })
    const steps = st().history.past.length
    const cage = st().cage
    st().makeUniformSelection()
    expect(st().notice).toBe('Uniform: already even - nothing moved')
    expect(st().resultFlash).toBeNull()
    expect(st().history.past.length).toBe(steps)
    expect(st().cage).toBe(cage)
  })

  it('a press on the canvas, a drag start or another tool ends the flash at once', () => {
    const top = topFace(st().cage)
    st().setSelection({ points: [], edges: [], faces: [top] })
    st().crease(true)
    expect(st().resultFlash).not.toBeNull()
    canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 10, clientY: 10, button: 2, bubbles: true }))
    expect(st().resultFlash).toBeNull()
    expect(attached).toBe(true)

    st().crease(false)
    expect(st().resultFlash).not.toBeNull()
    st().beginDrag()
    expect(st().resultFlash).toBeNull()
    st().endDrag()

    st().crease(true)
    const first = st().resultFlash
    st().subdivideSelection()
    expect(st().resultFlash).not.toBe(first)
    expect(st().resultFlash!.faces).toHaveLength(4)
    // the first flash's timer does not cut the second one short
    vi.advanceTimersByTime(RESULT_FLASH_MS - 1)
    expect(st().resultFlash).not.toBeNull()
    vi.advanceTimersByTime(1)
    expect(st().resultFlash).toBeNull()
  })

  it('display only: undo, redo and the saved form are as without the flash', () => {
    open(planeCage({ size: { x: 40, y: 40, z: 0 }, segments: { x: 2, y: 2, z: 1 } }))
    const start = st().cage
    const c = st().cage
    const inner = at(c, 0, 0, 0)
    st().setSelection({ points: [inner, at(c, 20, 0, 0)], edges: [], faces: [] })
    st().weldSelection()
    expect(st().resultFlash).not.toBeNull()
    const welded = st().cage
    expect(JSON.stringify(welded)).not.toMatch(/flash/i)
    expect(JSON.stringify(makeFormFeaturePayload(st().name, welded, st().tolerance, null, 0, null))).not.toMatch(/flash/i)
    expect(st().history.past).toHaveLength(1)
    st().undo()
    expect(st().resultFlash).toBeNull()
    expect(st().cage.positions).toEqual(start.positions)
    st().redo()
    expect(st().cage.positions).toEqual(welded.positions)
  })
})
