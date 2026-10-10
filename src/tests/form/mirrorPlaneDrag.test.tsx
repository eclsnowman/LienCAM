// @vitest-environment jsdom
//
// Form: the mirror-plane drag gesture in FormInteraction, with a stub overlay (what the pointer is over)
// and a stub gizmo. A press on the bare plane grabs it and holds orbit off; moves slide it along its
// normal; release lets go. A press on the cage, on the gizmo, with no mirror, a circular symmetry or the
// Face tool on grabs nothing.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { FormInteraction, type FormInteractionHost } from '../../components/model3d/form/formInteraction'
import type { FormOverlay } from '../../form/formOverlay'
import type { CagePick } from '../../form/pick'
import type { Vec3 } from '../../form/cage'
import { useFormStore } from '../../form/formStore'
import type { TransformControlsAdapter } from '../../components/model3d/gizmos/TransformControlsAdapter'

// the view: a camera on -Y looking +Y, so a pointer at screen x reads world x = x - 100 (the plane has normal +X)
const toWorldX = (x: number) => x - 100
let cageUnder: CagePick | null = null
let gizmoAxis: string | null = null
const overlay = {
  pickAt: () => cageUnder,
  mirrorHitAt: (x: number): { point: Vec3; ray: { origin: Vec3; dir: Vec3 } } | null => {
    const s = useFormStore.getState()
    return Math.abs(toWorldX(x) - s.symmetryAt) < 5 ? { point: [s.symmetryAt, 0, 30], ray: { origin: [toWorldX(x), -100, 30], dir: [0, 1, 0] } } : null
  },
  rayAt: (x: number) => ({ origin: [toWorldX(x), -100, 30] as Vec3, dir: [0, 1, 0] as Vec3 }),
  setHighlight: () => {},
} as unknown as FormOverlay

function stubAdapter(): TransformControlsAdapter {
  return {
    object: undefined, enabled: true,
    get axis() { return gizmoAxis },
    addEventListener: () => {}, removeEventListener: () => {}, attach: () => {}, detach: () => {},
    setMode: () => {}, setSpace: () => {}, getHelper: () => new THREE.Object3D(), dispose: () => {},
  } as unknown as TransformControlsAdapter
}

let canvas: HTMLCanvasElement
let orbit: boolean[]
let interaction: FormInteraction
const pointer = (type: string, x: number) => canvas.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: 50, button: 0, buttons: type === 'pointerup' ? 0 : 1, bubbles: true }))

beforeEach(() => {
  canvas = document.createElement('canvas')
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0 } as DOMRect)
  document.body.appendChild(canvas)
  orbit = []
  const host: FormInteractionHost = {
    canvas, camera: () => new THREE.PerspectiveCamera(), addObject: () => {}, removeObject: () => {}, requestRender: () => {},
    setOrbitEnabled: (on) => { orbit.push(on) },
  }
  cageUnder = null
  gizmoAxis = null
  useFormStore.getState().openSession({ featureId: null, name: 'F' })
  useFormStore.getState().setSymmetry('x')
  interaction = new FormInteraction(host, overlay, stubAdapter)
})
afterEach(() => { interaction.dispose(); canvas.remove() })

describe('dragging the mirror plane', () => {
  it('press on the bare plane, drag, release: the plane follows along X, orbit off for the drag and back on after', () => {
    expect(useFormStore.getState().symmetryAt).toBe(0)
    useFormStore.getState().setSelection({ points: [1], edges: [], faces: [] })
    pointer('pointerdown', 100)
    expect(interaction.draggingMirror()).toBe(true)
    expect(orbit).toEqual([false])
    pointer('pointermove', 112.5)
    expect(useFormStore.getState().symmetryAt).toBe(12.5)
    pointer('pointermove', 130)
    pointer('pointerup', 130)
    expect(useFormStore.getState().symmetryAt).toBe(30)
    expect(interaction.draggingMirror()).toBe(false)
    expect(orbit).toEqual([false, true])
    // the release is not also a click (a click on empty space would clear the selection)
    expect(useFormStore.getState().selection.points).toEqual([1])
  })

  it('the cage wins: a press on a cage point that lies on the plane selects it, and the plane stays', () => {
    cageUnder = { kind: 'point', index: 0 }
    pointer('pointerdown', 100)
    expect(interaction.draggingMirror()).toBe(false)
    pointer('pointermove', 120)
    pointer('pointerup', 100)
    expect(useFormStore.getState().symmetryAt).toBe(0)
    expect(orbit).toEqual([])
  })

  it('nothing to grab: off the plane, on the gizmo, no mirror, a circular symmetry, or the Face tool on', () => {
    pointer('pointerdown', 150)
    expect(interaction.draggingMirror()).toBe(false)
    pointer('pointerup', 150)
    gizmoAxis = 'X'
    pointer('pointerdown', 100)
    expect(interaction.draggingMirror()).toBe(false)
    pointer('pointerup', 100)
    gizmoAxis = null
    useFormStore.getState().startFaceTool({ replace: false })
    pointer('pointerdown', 100)
    expect(interaction.draggingMirror()).toBe(false)
    pointer('pointerup', 100)
    useFormStore.getState().stopFaceTool()
    useFormStore.getState().setSymmetry('c4')
    pointer('pointerdown', 100)
    expect(interaction.draggingMirror()).toBe(false)
    pointer('pointerup', 100)
    useFormStore.getState().setSymmetry(null)
    pointer('pointerdown', 100)
    expect(interaction.draggingMirror()).toBe(false)
    expect(orbit).toEqual([])
  })
})
