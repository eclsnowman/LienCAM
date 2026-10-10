// @vitest-environment jsdom
//
// Face by clicks, stage 44: chain mode (each face starts the next on its last edge: two clicks a face), a work
// plane from one of the form's own faces (Alt+click), and Alt+click reaching the store through FormInteraction.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Vec3 } from '../../form/cage'
import type { FaceClick } from '../../form/faceByClicks'
import { rayOnPlane } from '../../form/faceByClicks'
import { validateCage } from '../../form/halfEdge'
import { useFormStore } from '../../form/formStore'
import { boxCage } from '../../form/starters'
import { FormInteraction, type FormInteractionHost } from '../../components/model3d/form/formInteraction'
import type { FormOverlay } from '../../form/formOverlay'
import type { CagePick } from '../../form/pick'
import type { TransformControlsAdapter } from '../../components/model3d/gizmos/TransformControlsAdapter'

const st = () => useFormStore.getState()
const at = (x: number, y: number): FaceClick => ({ at: [x, y, 0] })

describe('chain mode', () => {
  beforeEach(() => { st().openSession({ featureId: null, name: 'F' }) })

  it('Chain with the tool off starts Face chained; after 4 corners the next draft already holds the last two', () => {
    st().toggleFaceChain()
    expect(st().faceTool).toMatchObject({ replace: false, chain: true })
    st().startFaceTool({ replace: true, chain: true })
    for (const c of [at(0, 0), at(10, 0), at(10, 10), at(0, 10)]) st().addFaceClick(c)
    expect(st().cage.faces).toHaveLength(1)
    const f = st().cage.faces[0]
    const P = st().cage.positions
    const carried = st().faceTool!.clicks
    expect(carried).toHaveLength(2)
    // the last two corners, in the order clicked: (10, 10) then (0, 10); the next corner goes beside (0, 10)
    expect(carried.map((c) => ('point' in c ? P[c.point] : null))).toEqual([[10, 10, 0], [0, 10, 0]])
    expect(f).toEqual(expect.arrayContaining(carried.map((c) => ('point' in c ? c.point : -1))))
    expect(st().notice).toMatch(/chained on its last edge: click the next 2 corners/)
  })

  it('a strip clicked back and forth: two clicks a face, each next corner beside the last one; one valid sheet', () => {
    st().startFaceTool({ replace: true, chain: true })
    for (const c of [at(0, 0), at(10, 0), at(10, 10), at(0, 10)]) st().addFaceClick(c)
    // up the left side then across, up the right side then across
    for (const c of [at(0, 20), at(10, 20), at(10, 30), at(0, 30)]) st().addFaceClick(c)
    expect(st().cage.faces).toHaveLength(3)
    expect(st().cage.positions).toHaveLength(8)
    expect(validateCage(st().cage, false).problems).toEqual([])
  })

  it('chain off again: back to 4 corners a face, nothing carried', () => {
    st().startFaceTool({ replace: true, chain: true })
    st().toggleFaceChain()
    expect(st().faceTool!.chain).toBe(false)
    for (const c of [at(0, 0), at(10, 0), at(10, 10), at(0, 10)]) st().addFaceClick(c)
    expect(st().faceTool!.clicks).toEqual([])
  })
})

describe('a work plane from a face of the form', () => {
  beforeEach(() => { st().openSession({ featureId: null, name: 'F', cage: boxCage({ size: { x: 40, y: 40, z: 30 }, segments: { x: 1, y: 1, z: 1 } }) }) })

  it("a box's top face: the work plane is Z = 30 facing up; clicks land on it", () => {
    const top = st().cage.faces.findIndex((f) => f.every((p) => st().cage.positions[p][2] === 30))
    st().startFaceTool({ replace: false })
    st().setFacePlaneFromFace(top)
    const plane = st().faceTool!.plane
    expect(plane.normal[2]).toBeCloseTo(1, 9)
    expect(rayOnPlane([5, 5, 100], [0, 0, -1], plane)).toEqual([5, 5, 30])
    expect(st().notice).toBe(`Face: the work plane is now the plane of face ${top + 1} (0 of 4 corners so far)`)
  })
})

describe('Alt+click in the view', () => {
  let canvas: HTMLCanvasElement
  let interaction: FormInteraction
  let under: CagePick | null = null
  const overlay = { pickAt: () => under, mirrorHitAt: () => null, rayAt: () => ({ origin: [0, 0, 100] as Vec3, dir: [0, 0, -1] as Vec3 }), setHighlight: () => {} } as unknown as FormOverlay
  const adapter = () => ({ object: undefined, enabled: true, axis: null, addEventListener: () => {}, removeEventListener: () => {}, attach: () => {}, detach: () => {}, setMode: () => {}, setSpace: () => {}, getHelper: () => new THREE.Object3D(), dispose: () => {} }) as unknown as TransformControlsAdapter
  beforeEach(() => {
    canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, width: 400, height: 300, right: 400, bottom: 300, x: 0, y: 0 } as DOMRect)
    document.body.appendChild(canvas)
    // a camera above the box, looking down on it
    const cam = new THREE.PerspectiveCamera(50, 4 / 3, 0.1, 1000)
    cam.position.set(0, 0, 100)
    cam.updateMatrixWorld(true)
    const host: FormInteractionHost = { canvas, camera: () => cam, addObject: () => {}, removeObject: () => {}, requestRender: () => {}, setOrbitEnabled: () => {} }
    st().openSession({ featureId: null, name: 'F', cage: boxCage({ size: { x: 40, y: 40, z: 30 }, segments: { x: 1, y: 1, z: 1 } }) })
    interaction = new FormInteraction(host, overlay, adapter)
  })
  afterEach(() => { interaction.dispose(); canvas.remove() })
  const click = (alt: boolean) => {
    canvas.dispatchEvent(new MouseEvent('pointerdown', { clientX: 50, clientY: 50, button: 0, altKey: alt, bubbles: true }))
    canvas.dispatchEvent(new MouseEvent('pointerup', { clientX: 50, clientY: 50, button: 0, altKey: alt, bubbles: true }))
  }

  it('Alt+click on a face with the Face tool on sets the work plane (no corner); a plain click on it is a corner', () => {
    const top = st().cage.faces.findIndex((f) => f.every((p) => st().cage.positions[p][2] === 30))
    under = { kind: 'face', index: top }
    st().startFaceTool({ replace: false })
    click(true)
    expect(st().faceTool!.planeWords).toBe(`the plane of face ${top + 1}`)
    expect(st().faceTool!.clicks).toHaveLength(0)
    click(false)
    expect(st().faceTool!.clicks).toHaveLength(1)
  })
})
