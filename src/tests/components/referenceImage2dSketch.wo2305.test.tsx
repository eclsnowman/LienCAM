// @vitest-environment jsdom
import { readFileSync } from 'node:fs'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import * as THREE from 'three'
import { SketchToolbox } from '../../components/panels/sketch/SketchToolbox'
import { ReferenceImage2dScene, referenceImage2dUi } from '../../components/panels/sketch/ReferenceImage2d'
import { useCamStore } from '../../store'
import { createFakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { dispositionFor } from '../ui/support/overlayKeyMap'
import { stubCanvas2d } from '../model3d/stubCanvas2d'

let restore: () => void
beforeEach(() => {
  restore = stubCanvas2d()
  useCamStore.getState().newProject()
  useCamStore.getState().setViewerMode('sketch')
  vi.spyOn(useCamStore.getState(), 'solveSketch').mockImplementation(() => {})
  referenceImage2dUi.setState({ host: null, id: null, calibrating: false })
  vi.stubGlobal('Image', class { constructor() {
    const image = document.createElement('img')
    Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 200 },
      src: { set() { queueMicrotask(() => image.onload?.(new Event('load'))) } } })
    return image
  } })
})
afterEach(() => { cleanup(); restore(); vi.unstubAllGlobals() })
const current = () => useCamStore.getState().project.referenceImages2d![0]
describe('WO-2305 real 2D Sketch toolbox', () => {
  it('calibrates a selected 50 mm line to 100 mm through the shared tool and moves a locked image by pointer', async () => {
    const runtime = createFakeSceneRuntime()
    runtime.projectToCanvasResult = { x: 400, y: 300 }
    runtime.camera.position.set(0, 0, 100); runtime.camera.lookAt(0, 0, 0); runtime.camera.updateMatrixWorld()
    const canvas = document.createElement('canvas')
    canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} })
    const container = document.createElement('div'); container.append(canvas); document.body.append(container)
    useCamStore.getState().insertReferenceImage2d({ id: 'reference-image:2d:calibrate', payload: {
      datumType: 'reference-image', name: 'Ruler.png', planeNodeId: 'cam:xy',
      image: { dataUrl: 'data:image/png;base64,AQID', fileName: 'Ruler.png', widthPx: 400, heightPx: 200 }, widthMm: 100, heightMm: 50, opacity: 0.5,
    } })
    const sketch = useCamStore.getState().activeSketch!
    useCamStore.setState({ activeSketch: { ...sketch, entities: [{ id: 'ruler-line', kind: 'line', start: { x: -25, y: 0 }, end: { x: 25, y: 0 }, construction: false }] }, sketchSelectedIds: ['ruler-line'] })
    referenceImage2dUi.setState({ id: current().id })
    render(<><SketchToolbox /><ReferenceImage2dScene host={{ runtime, canvas }} active /></>)
    fireEvent.click(screen.getByTestId('reference-image-calibrate'))
    const distance = await screen.findByLabelText('Real distance')
    fireEvent.change(distance, { target: { value: '100' } })
    fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }))
    await waitFor(() => expect(current().payload.widthMm).toBeCloseTo(200))
    expect(current().payload.heightMm).toBeCloseTo(100)
    fireEvent.click(screen.getByTestId('reference-image-lock-scale'))
    const before = current().payload.center!
    await act(async () => {
      canvas.dispatchEvent(new MouseEvent('pointerdown', { button: 0, clientX: 400, clientY: 300, bubbles: true }))
      document.dispatchEvent(new MouseEvent('pointermove', { clientX: 440, clientY: 300, bubbles: true }))
    })
    expect(current().payload.center).toEqual(before)
    await act(async () => document.dispatchEvent(new MouseEvent('pointerup', { clientX: 440, clientY: 300, bubbles: true })))
    expect(current().payload.center!.x).toBeGreaterThan(before.x)
    expect(current().payload).toMatchObject({ widthMm: 200, heightMm: 100, scaleLocked: true })
    container.remove()
  })
  it('adds a separate underlay, reuses opacity/visibility/lock/pose controls and releases the canvas to drawing', async () => {
    const runtime = createFakeSceneRuntime()
    const canvas = document.createElement('canvas')
    const container = document.createElement('div'); container.append(canvas); document.body.append(container)
    render(<><SketchToolbox /><ReferenceImage2dScene host={{ runtime, canvas }} active /></>)
    expect(screen.getByTestId('cam-sketch-import-into-sketch')).toBeTruthy()
    expect(screen.queryByTestId('reference-image-palette')).toBeNull()
    expect(screen.queryByTestId('reference-image-insert')).toBeNull()
    fireEvent.click(screen.getByTestId('cam-sketch-import-into-sketch'))
    const importWindow = screen.getByRole('dialog', { name: 'Import into sketch' })
    expect(within(importWindow).getByTestId('reference-image-insert')).toHaveProperty('textContent', 'Reference image (tracing underlay)')
    const file = new File([readFileSync('src/tests/evidence/WO-2302/trace-400x200.png')], 'Ruler.png', { type: 'image/png' })
    Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer })
    fireEvent.change(screen.getByTestId('reference-image-input'), { target: { files: [file] } })
    await waitFor(() => expect(current().payload.opacity).toBe(0.5))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByTestId('reference-image-palette').closest('.sketch-toolbox')).toBeNull()
    expect(getComputedStyle(screen.getByRole('complementary', { name: 'Reference image controls' })).position).toBe('fixed')
    expect(dispositionFor('components/panels/sketch/ReferenceImage2d.tsx:ReferenceImage2dControls > aside.reference-image2d-controls'), 'the independent image panel needs an adjudicated census entry').toBeDefined()
    const quads = () => { const objects: THREE.Object3D[] = []; runtime.scene.traverse((o) => { if (o.name === 'reference-image-quad') objects.push(o) }); return objects }
    await waitFor(() => expect(quads()).toHaveLength(1))
    expect((quads()[0] as THREE.Mesh).material).toMatchObject({ opacity: 0.5, depthWrite: false })
    fireEvent.click(screen.getByTestId('reference-image-visible'))
    await waitFor(() => expect(quads()).toHaveLength(0))
    act(() => useCamStore.getState().undo())
    await waitFor(() => expect(quads()).toHaveLength(1))
    fireEvent.click(screen.getByTestId('reference-image-lock-scale'))
    expect(current().payload.scaleLocked).toBe(true)
    expect(screen.queryByTestId('reference-image-calibrate')).toBeNull()
    const angle = screen.getByLabelText('Angle')
    fireEvent.focus(angle); fireEvent.change(angle, { target: { value: '30' } }); fireEvent.blur(angle)
    fireEvent.click(screen.getByTestId('reference-image-flip-horizontal'))
    fireEvent.click(screen.getByTestId('reference-image-flip-vertical'))
    expect(current().payload).toMatchObject({ angleDeg: 30, flipHorizontal: true, flipVertical: true, scaleLocked: true })
    fireEvent.click(screen.getByTestId('reference-image-close'))
    expect(referenceImage2dUi.getState().id).toBeNull()
    expect(useCamStore.getState().activeSketch?.entities.filter((e) => !e.construction)).not.toContainEqual(expect.objectContaining({ kind: 'image' }))
    container.remove()
  })
})
