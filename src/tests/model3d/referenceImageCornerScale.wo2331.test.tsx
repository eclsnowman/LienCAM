// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import * as THREE from 'three'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { resetDocumentHolder, collectDocumentArchive, stashLoadedDocument } from '../../doc/documentHolder'
import { useCamStore } from '../../store'
import { createFakeSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { stubCanvas2d } from './stubCanvas2d'
import { referenceImageFrame, type ReferenceImagePayload } from '../../referenceImage/referenceImage'
import { localToWorld } from '../../sketch3d/planeMath'
import { imageToPlane } from '../../referenceImage/place'

let restore: () => void
beforeEach(() => {
  restore = stubCanvas2d(); resetDocumentHolder(); useCamStore.getState().newProject()
  useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, displayUnits: 'mm' } }))
  vi.stubGlobal('Image', class { constructor() {
    const image = document.createElement('img')
    Object.defineProperties(image, { naturalWidth: { value: 400 }, naturalHeight: { value: 200 },
      src: { set() { queueMicrotask(() => image.onload?.(new Event('load'))) } } })
    return image
  } })
})
afterEach(() => { cleanup(); restore(); vi.unstubAllGlobals(); resetDocumentHolder() })
const hooks = () => window.__solidsWorkbenchHooks!
const payload = () => hooks().dag.getNode('reference-image:1')!.payload as ReferenceImagePayload
const corner = (p: ReferenceImagePayload, x: number, y: number) => imageToPlane(p, { x: x * p.widthMm / 2, y: y * p.heightMm / 2 })
async function mount(insert = true) {
  const runtime = createFakeSceneRuntime()
  runtime.camera.position.set(0, 0, 100); runtime.camera.lookAt(0, 0, 0); runtime.camera.updateMatrixWorld()
  const pixel = (world: { x: number; y: number; z: number }) => {
    const p = new THREE.Vector3(world.x, world.y, world.z).project(runtime.camera)
    return { x: (p.x + 1) * 400, y: (1 - p.y) * 300 }
  }
  runtime.projectToCanvas = pixel
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const canvas = screen.getByTestId('solids-workbench-canvas') as HTMLCanvasElement
  Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) })
  if (insert) {
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    runtime.rayOverride = { origin: { x: 10, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(canvas)
    await waitFor(() => expect(screen.getByTestId('reference-image-input')).toBeTruthy())
    fireEvent.change(screen.getByTestId('reference-image-input'), { target: { files: [new File(['picture'], 'trace.png', { type: 'image/png' })] } })
  }
  await waitFor(() => expect(hooks().scheduler.statusOf('reference-image:1')).toBe('ok'))
  fireEvent.contextMenu(screen.getByTestId('feature-row-reference-image:1')); fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
  // Reopen may frame the enlarged image differently; off-canvas handles remain
  // part of the selected picture but must not cover other application panels.
  await waitFor(() => expect(screen.getAllByTestId(/^reference-image-corner-\d$/)).toHaveLength(4))
  const event = async (type: string, point: { x: number; y: number }, target: Element = canvas) => {
    const at = pixel(localToWorld(referenceImageFrame(hooks().dag, payload())!, point))
    await act(async () => target.dispatchEvent(new MouseEvent(type, { button: 0, bubbles: true, cancelable: true, clientX: at.x, clientY: at.y })))
  }
  return { runtime, canvas, event }
}

it('scales the selected Model picture uniformly about the opposite corner, previews, undoes once, reopens and calibrates', async () => {
  const { event } = await mount()
  const before = payload(), anchor = corner(before, -1, -1), start = corner(before, 1, 1)
  const end = { x: anchor.x + (start.x - anchor.x) * 1.2, y: anchor.y + (start.y - anchor.y) * 1.2 }
  const count = hooks().history.checkpoint().past.length
  await event('pointerdown', start, screen.getByTestId('reference-image-corner-2')); await event('pointermove', end)
  expect(payload()).toEqual(before); expect(hooks().history.checkpoint().past.length).toBe(count)
  expect(Number(screen.getByTestId('reference-image-width').textContent!.split(' ')[0])).toBeCloseTo(before.widthMm * 1.2, 2)
  await event('pointerup', end)
  await waitFor(() => expect(payload().widthMm).toBeCloseTo(before.widthMm * 1.2, 6))
  expect(payload().widthMm / payload().heightMm).toBeCloseTo(2, 8)
  expect(corner(payload(), -1, -1).x).toBeCloseTo(anchor.x, 6); expect(corner(payload(), -1, -1).y).toBeCloseTo(anchor.y, 6)
  expect(hooks().history.checkpoint().past.length).toBe(count + 1)
  fireEvent.click(screen.getByTestId('workbench-undo')); await waitFor(() => expect(payload()).toEqual(before))
  fireEvent.click(screen.getByTestId('workbench-redo')); await waitFor(() => expect(payload().widthMm).toBeCloseTo(before.widthMm * 1.2, 6))
  const saved = payload(), archive = collectDocumentArchive()!
  cleanup(); resetDocumentHolder(); stashLoadedDocument(archive)
  const reopened = await mount(false); expect(payload()).toEqual(saved)
  fireEvent.click(screen.getByTestId('reference-image-calibrate'))
  for (const x of [-0.2, 0.2]) await reopened.event('click', imageToPlane(saved, { x: saved.widthMm * x, y: 0 }))
  await waitFor(() => expect(screen.getByLabelText('Real distance')).toBeTruthy())
  fireEvent.change(screen.getByLabelText('Real distance'), { target: { value: '20' } }); fireEvent.keyDown(screen.getByLabelText('Real distance'), { key: 'Enter' })
  await waitFor(() => expect(payload().widthMm * 0.4).toBeCloseTo(20, 3))
  fireEvent.click(screen.getByTestId('reference-image-lock-scale'))
  expect(screen.queryByTestId('reference-image-corner-2')).toBeNull()
  const locked = payload()
  await reopened.event('pointerdown', corner(locked, 1, 1)); await reopened.event('pointermove', { x: 40, y: 40 }); await reopened.event('pointerup', { x: 40, y: 40 })
  expect(payload().widthMm).toBe(locked.widthMm); expect(payload().heightMm).toBe(locked.heightMm)
}, 60_000)

it('cancels a Model scale preview without history and releases handles when the palette closes', async () => {
  const { event } = await mount()
  const before = payload(), start = corner(before, 1, 1), count = hooks().history.checkpoint().past.length
  await event('pointerdown', start); await event('pointermove', { x: start.x + 10, y: start.y + 10 })
  fireEvent.keyDown(document, { key: 'Escape' }); await event('pointerup', { x: start.x + 10, y: start.y + 10 })
  expect(payload()).toEqual(before); expect(hooks().history.checkpoint().past.length).toBe(count)
  fireEvent.click(screen.getByTestId('reference-image-close')); expect(screen.queryByTestId('reference-image-corner-2')).toBeNull()
}, 60_000)
