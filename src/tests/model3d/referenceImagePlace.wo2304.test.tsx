// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { resetDocumentHolder, collectDocumentArchive, stashLoadedDocument } from '../../doc/documentHolder'
import { useCamStore } from '../../store'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { stubCanvas2d } from './stubCanvas2d'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import { referenceImageFrame, type ReferenceImagePayload } from '../../referenceImage/referenceImage'
import { localToWorld } from '../../sketch3d/planeMath'
import { imageToPlane } from '../../referenceImage/place'
import { mintRectangleSketch } from './mintRectangleSketch'
import { WORKBENCH_INJECTED_ENTITY_IDS } from '../../components/model3d/workbench/workbenchOriginAnchor'

let restoreCanvas: () => void
beforeEach(() => {
  restoreCanvas = stubCanvas2d(); resetDocumentHolder(); useCamStore.getState().newProject()
  useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, displayUnits: 'mm' } }))
  vi.stubGlobal('Image', class { constructor() {
    const image = document.createElement('img')
    Object.defineProperties(image, { naturalWidth: { get: () => 1000 }, naturalHeight: { get: () => 500 }, src: { set() { queueMicrotask(() => image.onload?.(new Event('load'))) } } })
    return image
  } })
})
afterEach(() => { cleanup(); restoreCanvas(); vi.unstubAllGlobals(); resetDocumentHolder() })
const hooks = () => window.__solidsWorkbenchHooks!
const payload = () => hooks().dag.getNode('reference-image:1')!.payload as ReferenceImagePayload
function quad(runtime: FakeSceneRuntime) {
  let found: THREE.Mesh | undefined
  runtime.scene.traverse((o) => { if (o.name === 'reference-image-quad') found = o as THREE.Mesh })
  return found!
}
async function mount() {
  const runtime = createFakeSceneRuntime()
  runtime.camera.position.set(0, 0, 100)
  runtime.camera.lookAt(0, 0, 0)
  runtime.camera.updateMatrixWorld()
  runtime.projectToCanvasResult = { x: 400, y: 300 }
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  const canvas = screen.getByTestId('solids-workbench-canvas') as HTMLCanvasElement
  Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) })
  Object.defineProperty(canvas.parentElement, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) })
  return runtime
}
async function insert(runtime: FakeSceneRuntime) {
  fireEvent.change(screen.getByTestId('reference-image-input'), { target: { files: [new File(['picture'], 'ruler.png', { type: 'image/png' })] } })
  await waitFor(() => expect(quad(runtime)).toBeTruthy())
  await waitFor(() => expect(hooks().scheduler.statusOf('reference-image:1')).toBe('ok'))
  fireEvent.contextMenu(screen.getByTestId('feature-row-reference-image:1'))
  fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
}
async function xy(runtime: FakeSceneRuntime) {
  fireEvent.click(screen.getByTestId('workbench-new-sketch'))
  runtime.rayOverride = { origin: { x: 10, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('reference-image-insert')).toBeTruthy())
  await insert(runtime)
}
function planePixel(runtime: FakeSceneRuntime, point: { x: number; y: number }) {
  const world = localToWorld(referenceImageFrame(hooks().dag, payload())!, point)
  runtime.camera.updateMatrixWorld()
  const p = new THREE.Vector3(world.x, world.y, world.z).project(runtime.camera)
  return { clientX: (p.x + 1) * 400, clientY: (1 - p.y) * 300 }
}
function markWorld(runtime: FakeSceneRuntime, fraction: number) {
  const mesh = quad(runtime)
  mesh.updateWorldMatrix(true, false)
  const width = (mesh.geometry as THREE.PlaneGeometry).parameters.width
  return new THREE.Vector3(width * (fraction - 0.5), 0, 0).applyMatrix4(mesh.matrixWorld)
}
async function picks(runtime: FakeSceneRuntime) {
  fireEvent.click(screen.getByTestId('reference-image-calibrate'))
  const image = payload()
  for (const fraction of [0.1, 0.6]) fireEvent.click(screen.getByTestId('solids-workbench-canvas'), planePixel(runtime, imageToPlane(image, { x: image.widthMm * (fraction - 0.5), y: 0 })))
  await waitFor(() => expect(screen.getByLabelText('Real distance')).toBeTruthy())

}
async function enter(distance: string) {
  await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Real distance')))
  const input = screen.getByLabelText('Real distance')
  fireEvent.change(input, { target: { value: distance } }); fireEvent.keyDown(input, { key: 'Enter' })
  await act(async () => {})
}
async function assertDistance(runtime: FakeSceneRuntime, mm: number) {
  await waitFor(() => expect(markWorld(runtime, 0.1).distanceTo(markWorld(runtime, 0.6))).toBeCloseTo(mm, 3))
}

async function field(label: string, value: string) {
  const input = screen.getByLabelText(label)
  await act(async () => { input.focus() })
  fireEvent.change(input, { target: { value } }); fireEvent.keyDown(input, { key: 'Enter' })
  await act(async () => {})
}
async function pose(runtime: FakeSceneRuntime, x: number, y: number, angle: number) {
  await waitFor(() => {
    const mesh = quad(runtime)
    expect(mesh.position.x).toBeCloseTo(x, 6); expect(mesh.position.y).toBeCloseTo(y, 6)
    expect(mesh.rotation.z * 180 / Math.PI).toBeCloseTo(angle, 6)
  })
  await assertDistance(runtime, 250)
}
async function drag(runtime: FakeSceneRuntime, start: { x: number; y: number }, end: { x: number; y: number }, release = true) {
  const canvas = screen.getByTestId('solids-workbench-canvas')
  for (const [type, at] of [['pointerdown', start], ['pointermove', end], ...(release ? [['pointerup', end]] : [])] as [string, { x: number; y: number }][]) {
    await act(async () => { canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...planePixel(runtime, at), button: 0 })) })
  }
}
describe('WO-2304 placement through the real Model screen', () => {
  it('places a locked calibrated picture, previews one drag, flips in place, undoes every edit and reopens', async () => {
    const runtime = await mount(); await xy(runtime)
    await picks(runtime); await enter('250'); await assertDistance(runtime, 250)
    fireEvent.click(screen.getByTestId('reference-image-lock-scale'))
    await waitFor(() => expect(payload().scaleLocked).toBe(true))
    const initial = payload().center!, steps = [{ x: 40, y: initial.y, angle: 0 }, { x: 40, y: -15, angle: 0 }, { x: 40, y: -15, angle: 30 }]
    await field('X', '40'); await pose(runtime, 40, initial.y, 0)
    await field('Y', '-15'); await pose(runtime, 40, -15, 0)
    await field('Angle', '30'); await pose(runtime, 40, -15, 30)
    const distance = { width: payload().widthMm, height: payload().heightMm }
    const historyLength = hooks().history.checkpoint().past.length
    await drag(runtime, { x: 40, y: -15 }, { x: 45, y: -15 }, false)
    await pose(runtime, 45, -15, 30)
    expect(Number((screen.getByLabelText('X') as HTMLInputElement).value)).toBeCloseTo(45)
    expect(payload().center!.x).toBe(40)
    expect(hooks().history.checkpoint().past.length).toBe(historyLength)
    expect(hooks().buildDebugSceneExport().skipped).toContain("open 'reference-image' dialog's unsaved draft field values")
    const canvas = screen.getByTestId('solids-workbench-canvas')
    for (const type of ['pointermove', 'pointerup']) await act(async () => {
      canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...planePixel(runtime, { x: 50, y: -15 }), button: 0 }))
    })
    await pose(runtime, 50, -15, 30)
    expect(hooks().history.checkpoint().past.length).toBe(historyLength + 1)
    const left = markWorld(runtime, 0.1), center = markWorld(runtime, 0.5)
    fireEvent.click(screen.getByTestId('reference-image-flip-horizontal'))
    await waitFor(() => expect(quad(runtime).scale.x).toBe(-1))
    expect(markWorld(runtime, 0.9).distanceTo(left)).toBeLessThan(0.001)
    expect(markWorld(runtime, 0.5).distanceTo(center)).toBeLessThan(0.001)
    await assertDistance(runtime, 250)
    fireEvent.click(screen.getByTestId('reference-image-flip-vertical'))
    await waitFor(() => expect(quad(runtime).scale.y).toBe(-1)); await assertDistance(runtime, 250)
    const saved = { ...payload() }
    for (const expected of [
      { x: 50, y: -15, angle: 30, h: true, v: false },
      { x: 50, y: -15, angle: 30, h: false, v: false },
      { x: 40, y: -15, angle: 30, h: false, v: false },
      { ...steps[1], h: false, v: false }, { ...steps[0], h: false, v: false },
      { x: initial.x, y: initial.y, angle: 0, h: false, v: false },
    ]) {
      fireEvent.click(screen.getByTestId('workbench-undo')); await pose(runtime, expected.x, expected.y, expected.angle)
      expect(quad(runtime).scale.x).toBe(expected.h ? -1 : 1); expect(quad(runtime).scale.y).toBe(expected.v ? -1 : 1)
    }
    for (let i = 0; i < 6; i++) { fireEvent.click(screen.getByTestId('workbench-redo')); await act(async () => {}) }
    await pose(runtime, 50, -15, 30); expect(payload()).toEqual(saved)
    expect(payload().widthMm).toBe(distance.width); expect(payload().heightMm).toBe(distance.height)
    const archive = collectDocumentArchive()!
    cleanup(); resetDocumentHolder(); stashLoadedDocument(archive)
    const reopened = await mount(); await pose(reopened, 50, -15, 30); expect(payload()).toEqual(saved)
    fireEvent.contextMenu(screen.getByTestId('feature-row-reference-image:1')); fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    await act(async () => { useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, displayUnits: 'inch' } })) })
    await field('X', '2'); await pose(reopened, 50.8, -15, 30)
  }, 90_000)

  it('cancels a preview without history and lets the Line tool trace when the palette is closed', async () => {
    const runtime = await mount(); await xy(runtime)
    await picks(runtime); await enter('250'); await field('X', '40'); await field('Y', '-15'); await field('Angle', '30')
    const before = { ...payload() }, count = hooks().history.checkpoint().past.length
    await drag(runtime, { x: 40, y: -15 }, { x: 50.000002, y: -15 }, false); await pose(runtime, 50.000002, -15, 30)
    expect((screen.getByLabelText('X') as HTMLInputElement).value).toBe('50')
    fireEvent.keyDown(document, { key: 'Escape' }); await pose(runtime, 40, -15, 30)
    expect(payload()).toEqual(before); expect(hooks().history.checkpoint().past.length).toBe(count)
    await drag(runtime, { x: 40, y: -15 }, { x: 50, y: -15 }, false)
    fireEvent.click(screen.getByTestId('reference-image-close')); await pose(runtime, 40, -15, 30)
    expect(hooks().buildDebugSceneExport().skipped).not.toContain("open 'reference-image' dialog's unsaved draft field values")
    fireEvent.click(screen.getByTestId('workbench-package-tool-line'))
    for (const at of [{ x: 40, y: -15 }, { x: 50, y: -15 }]) for (const type of ['pointermove', 'pointerdown', 'pointerup']) await act(async () => {
      screen.getByTestId('solids-workbench-canvas').dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...planePixel(runtime, at), button: 0 }))
    })
    await waitFor(() => expect(sketchSessionStore.getState().sketch!.entities.filter((e) => e.kind === 'line' && !WORKBENCH_INJECTED_ENTITY_IDS.has(e.id))).toHaveLength(1))
    expect(payload()).toEqual(before)
  }, 90_000)

  it('moves, turns, flips and recalibrates on a box top face without leaving its support plane', async () => {
    const runtime = await mount()
    await act(async () => { await mintRectangleSketch({ width: '40', height: '20', offset: '10' }) })
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
    const input = screen.getByTestId('extrude-distance').querySelector('input')!
    fireEvent.change(input, { target: { value: '20' } }); fireEvent.blur(input)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeTruthy(), { timeout: 20_000 })
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas')); fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    await waitFor(() => expect(screen.getByTestId('reference-image-insert')).toBeTruthy()); await insert(runtime)
    await picks(runtime); await enter('250'); fireEvent.click(screen.getByTestId('reference-image-lock-scale'))
    await field('X', '40'); await field('Y', '-15'); await field('Angle', '30'); await pose(runtime, 40, -15, 30)
    await drag(runtime, { x: 40, y: -15 }, { x: 50, y: -15 }); await pose(runtime, 50, -15, 30)
    for (const axis of ['horizontal', 'vertical']) { fireEvent.click(screen.getByTestId(`reference-image-flip-${axis}`)); await act(async () => {}); await assertDistance(runtime, 250) }
    expect(markWorld(runtime, 0.1).z).toBeCloseTo(20); expect(markWorld(runtime, 0.6).z).toBeCloseTo(20)
    fireEvent.click(screen.getByTestId('reference-image-lock-scale'))
    await picks(runtime); await enter('250'); await assertDistance(runtime, 250)
    expect(markWorld(runtime, 0.1).z).toBeCloseTo(20)
  }, 90_000)
})

