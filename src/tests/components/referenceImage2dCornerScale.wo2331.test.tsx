// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import * as THREE from 'three'
import { SketchToolbox } from '../../components/panels/sketch/SketchToolbox'
import { ReferenceImage2dScene, referenceImage2dUi } from '../../components/panels/sketch/ReferenceImage2d'
import { useCamStore } from '../../store'
import { createFakeSceneRuntime } from '../model3d/fakeSceneRuntime'
import { stubCanvas2d } from '../model3d/stubCanvas2d'
import { imageToPlane } from '../../referenceImage/place'
import type { ReferenceImagePayload } from '../../referenceImage/referenceImage'

let restore: () => void
beforeEach(() => {
  restore = stubCanvas2d(); useCamStore.getState().newProject(); useCamStore.getState().setViewerMode('sketch')
  useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, displayUnits: 'mm' } }))
  vi.spyOn(useCamStore.getState(), 'solveSketch').mockImplementation(() => {})
  referenceImage2dUi.setState({ host: null, id: null, calibrating: false, preview: null })
  vi.stubGlobal('Image', class { constructor() {
    const image = document.createElement('img')
    Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 200 },
      src: { set() { queueMicrotask(() => image.onload?.(new Event('load'))) } } })
    return image
  } })
})
afterEach(() => { cleanup(); restore(); vi.unstubAllGlobals() })
const payload = () => useCamStore.getState().project.referenceImages2d![0].payload
const corner = (p: ReferenceImagePayload, x: number, y: number) => imageToPlane(p, { x: x * p.widthMm / 2, y: y * p.heightMm / 2 })
async function mount() {
  const runtime = createFakeSceneRuntime()
  runtime.camera.position.set(0, 0, 100); runtime.camera.lookAt(0, 0, 0); runtime.camera.updateMatrixWorld()
  const canvas = document.createElement('canvas'); document.body.append(canvas)
  canvas.getBoundingClientRect = () => ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON() {} })
  const pixel = (p: { x: number; y: number; z?: number }) => {
    const projected = new THREE.Vector3(p.x, p.y, p.z ?? 0).project(runtime.camera)
    return { x: (projected.x + 1) * 400, y: (1 - projected.y) * 300 }
  }
  runtime.projectToCanvas = pixel
  render(<><SketchToolbox /><ReferenceImage2dScene host={{ runtime, canvas }} active /></>)
  fireEvent.click(screen.getByTestId('cam-sketch-import-into-sketch'))
  const file = new File(['image'], 'trace.png', { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([1, 2, 3]).buffer })
  fireEvent.change(screen.getByTestId('reference-image-input'), { target: { files: [file] } })
  await waitFor(() => expect(screen.getAllByRole('button', { name: /Resize reference image corner/ })).toHaveLength(4))
  const event = async (type: string, point: { x: number; y: number }, target: Element = canvas) => {
    const at = pixel(point)
    await act(async () => target.dispatchEvent(new MouseEvent(type, { button: 0, bubbles: true, cancelable: true, clientX: at.x, clientY: at.y })))
  }
  return { runtime, canvas, event }
}

it('scales through the real 2D toolbox with live width, fixed anchor, one Undo, recalibration and save/reopen', async () => {
  const { canvas, event } = await mount()
  const before = payload(), anchor = corner(before, -1, -1), start = corner(before, 1, 1)
  const end = { x: anchor.x + (start.x - anchor.x) * 1.2, y: anchor.y + (start.y - anchor.y) * 1.2 }
  await event('pointerdown', start, screen.getByTestId('reference-image-corner-2'))
  await event('pointermove', end)
  expect(payload()).toEqual(before)
  expect(Number(screen.getByTestId('reference-image-width').textContent!.split(' ')[0])).toBeCloseTo(before.widthMm * 1.2, 2)
  await event('pointerup', end)
  expect(payload().widthMm).toBeCloseTo(before.widthMm * 1.2, 6)
  expect(payload().widthMm / payload().heightMm).toBeCloseTo(2, 8)
  expect(Math.hypot(corner(payload(), -1, -1).x - anchor.x, corner(payload(), -1, -1).y - anchor.y)).toBeLessThan(0.001)
  act(() => useCamStore.getState().undo()); expect(payload()).toEqual(before)
  act(() => useCamStore.getState().redo())
  const dragged = payload()
  let saved = ''
  Object.defineProperty(window, 'liencamHost', { configurable: true, value: { saveFile: async (_name: string, contents: string) => { saved = contents; return 'scale.camproject' } } })
  await act(async () => { await useCamStore.getState().saveProjectToFile(); useCamStore.getState().newProject(); await useCamStore.getState().loadProjectFromFile(saved) })
  expect(payload()).toEqual(dragged)
  act(() => { useCamStore.getState().setViewerMode('sketch'); referenceImage2dUi.setState({ id: useCamStore.getState().project.referenceImages2d![0].id }) })
  fireEvent.click(screen.getByTestId('reference-image-calibrate'))
  const current = payload()
  for (const x of [-0.2, 0.2]) {
    const at = imageToPlane(current, { x: current.widthMm * x, y: 0 })
    await event('click', at)
  }
  const distance = await screen.findByLabelText('Real distance')
  fireEvent.change(distance, { target: { value: '20' } }); fireEvent.click(screen.getByRole('button', { name: /^Apply$/ }))
  // Recalibration can take longer than waitFor's 1 s default on a loaded CI shard.
  await waitFor(() => expect(payload().widthMm * 0.4).toBeCloseTo(20, 3), { timeout: 10_000 })
  fireEvent.click(screen.getByTestId('reference-image-lock-scale'))
  expect(screen.queryByTestId('reference-image-corner-2')).toBeNull()
  const locked = payload()
  await event('pointerdown', corner(locked, 1, 1)); await event('pointermove', { x: 40, y: 40 }); await event('pointerup', { x: 40, y: 40 })
  expect(payload().widthMm).toBe(locked.widthMm); expect(payload().heightMm).toBe(locked.heightMm)
  canvas.remove(); Reflect.deleteProperty(window, 'liencamHost')
})

it('a held resize never lands on another image selected mid-drag at the same placement', async () => {
  const { canvas, event } = await mount()
  const file = new File(['image'], 'second.png', { type: 'image/png' })
  Object.defineProperty(file, 'arrayBuffer', { value: async () => new Uint8Array([4, 5, 6]).buffer })
  fireEvent.click(screen.getByTestId('cam-sketch-import-into-sketch'))
  fireEvent.change(screen.getByTestId('reference-image-input'), { target: { files: [file] } })
  await waitFor(() => expect(useCamStore.getState().project.referenceImages2d).toHaveLength(2))
  const [a, b] = useCamStore.getState().project.referenceImages2d!
  expect(b.payload.widthMm).toBe(a.payload.widthMm); expect(b.payload.center).toEqual(a.payload.center)
  act(() => referenceImage2dUi.setState({ id: a.id }))
  const start = corner(a.payload, 1, 1), anchor = corner(a.payload, -1, -1)
  const end = { x: anchor.x + (start.x - anchor.x) * 1.2, y: anchor.y + (start.y - anchor.y) * 1.2 }
  await event('pointerdown', start, screen.getByTestId('reference-image-corner-2')); await event('pointermove', end)
  act(() => referenceImage2dUi.setState({ id: b.id }))
  await event('pointerup', end)
  const [a2, b2] = useCamStore.getState().project.referenceImages2d!
  expect(b2.payload).toEqual(b.payload)
  expect(a2.payload).toEqual(a.payload)
  canvas.remove()
})

it('scales every corner after rotation and flips, and cancels on Escape, capture loss, lock, hide and close', async () => {
  const { canvas, event } = await mount()
  const id = useCamStore.getState().project.referenceImages2d![0].id
  for (const [i, x, y] of [[0, -1, -1], [1, 1, -1], [2, 1, 1], [3, -1, 1]]) {
    act(() => useCamStore.getState().updateReferenceImage2d(id, { payload: { ...payload(), angleDeg: 37, flipHorizontal: true, flipVertical: true } }))
    const before = payload(), anchor = corner(before, -x, -y), start = corner(before, x, y)
    const end = { x: anchor.x + (start.x - anchor.x) * 0.8, y: anchor.y + (start.y - anchor.y) * 0.8 }
    await event('pointerdown', start, screen.getByTestId(`reference-image-corner-${i}`)); await event('pointermove', end); await event('pointerup', end)
    expect(payload().widthMm).toBeCloseTo(before.widthMm * 0.8, 6)
    expect(corner(payload(), -x, -y).x).toBeCloseTo(anchor.x, 6); expect(corner(payload(), -x, -y).y).toBeCloseTo(anchor.y, 6)
  }
  for (const cancel of ['escape', 'capture', 'lock', 'hide', 'close']) {
    const before = payload(), start = corner(before, 1, 1)
    await event('pointerdown', start, screen.getByTestId('reference-image-corner-2')); await event('pointermove', { x: start.x + 10, y: start.y + 10 })
    if (cancel === 'escape') fireEvent.keyDown(document, { key: 'Escape' })
    if (cancel === 'capture') await event('lostpointercapture', start)
    if (cancel === 'lock') fireEvent.click(screen.getByTestId('reference-image-lock-scale'))
    if (cancel === 'hide') fireEvent.click(screen.getByTestId('reference-image-visible'))
    if (cancel === 'close') fireEvent.click(screen.getByTestId('reference-image-close'))
    await event('pointerup', { x: start.x + 20, y: start.y + 20 })
    expect(payload().widthMm).toBe(before.widthMm); expect(referenceImage2dUi.getState().preview).toBeNull()
    act(() => { useCamStore.getState().updateReferenceImage2d(id, { hidden: false, payload: { ...before, scaleLocked: false } }); referenceImage2dUi.setState({ id }) })
  }
  canvas.remove()
})
