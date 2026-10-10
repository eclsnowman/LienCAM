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
import { workbenchSketchDocumentPort } from '../../components/model3d/workbench/workbenchSketchDocumentPort'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import { referenceImageFrame, type ReferenceImagePayload } from '../../referenceImage/referenceImage'
import { localToWorld } from '../../sketch3d/planeMath'
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
  const image = payload(), center = image.center ?? { x: 0, y: 0 }
  for (const fraction of [0.1, 0.6]) fireEvent.click(screen.getByTestId('solids-workbench-canvas'), planePixel(runtime, { x: center.x + image.widthMm * (fraction - 0.5), y: center.y }))
  await waitFor(() => expect(screen.getByLabelText('Real distance')).toBeTruthy())
  const markers: THREE.Mesh[] = []
  runtime.scene.getObjectByName('reference-image-calibration')!.traverse((o) => {
    if (o.name === 'reference-image-calibration-mark') markers.push(o as THREE.Mesh)
  })
  expect(markers).toHaveLength(2)
  markers.forEach((mark, i) => {
    expect(mark.position.x).toBeCloseTo(center.x + image.widthMm * ([0.1, 0.6][i] - 0.5), 6)
    expect(mark.position.y).toBeCloseTo(center.y, 6)
    expect((mark.material as THREE.MeshBasicMaterial).depthTest).toBe(false)
    expect(mark.renderOrder).toBeGreaterThan(quad(runtime).renderOrder)
  })
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

describe('WO-2303 calibration through the real Model screen', () => {
  it('anchors the first mark, preserves aspect, uses mm and inches, and undoes each calibration', async () => {
    const runtime = await mount(); await xy(runtime)
    const original = { ...payload() }, first = markWorld(runtime, 0.1)
    await picks(runtime); await enter('250'); await assertDistance(runtime, 250)
    expect(markWorld(runtime, 0.1).distanceTo(first)).toBeLessThan(0.001)
    expect(payload().widthMm / payload().heightMm).toBe(2)
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(payload().widthMm).toBe(original.widthMm))
    fireEvent.click(screen.getByTestId('workbench-redo')); await assertDistance(runtime, 250)
    await act(async () => { useCamStore.setState((s) => ({ appSettings: { ...s.appSettings, displayUnits: 'inch' } })) })
    await picks(runtime)
    expect((screen.getByLabelText('Real distance') as HTMLInputElement).value).toBe((250 / 25.4).toFixed(4))
    await enter('4'); await assertDistance(runtime, 101.6)
    expect(markWorld(runtime, 0.1).distanceTo(first)).toBeLessThan(0.001)
  }, 90_000)

  it('cancels both pick stages and entry, snaps invalid values once, locks both routes, and reopens the saved image', async () => {
    const runtime = await mount(); await xy(runtime)
    const original = { ...payload() }
    fireEvent.click(screen.getByTestId('reference-image-calibrate')); fireEvent.keyDown(document, { key: 'Escape' })
    expect(payload()).toEqual(original)
    fireEvent.click(screen.getByTestId('reference-image-calibrate'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'), planePixel(runtime, { x: 0, y: 0 }))
    fireEvent.keyDown(document, { key: 'Escape' }); expect(payload()).toEqual(original)
    await picks(runtime); await enter('0')
    await waitFor(() => expect(Number((screen.getByLabelText('Real distance') as HTMLInputElement).value)).toBeCloseTo(original.widthMm / 2, 3))
    expect(useCamStore.getState().consoleEvents.filter((e) => e.message.startsWith('Real distance:'))).toHaveLength(1)
    await enter('text')
    expect(useCamStore.getState().consoleEvents.filter((e) => e.message.startsWith('Real distance:'))).toHaveLength(2)
    await waitFor(() => expect(screen.getByLabelText('Real distance')).toBeTruthy())
    for (const draft of ['0', 'text']) {
      // Invalid input remounts the entry. Wait for its real focus lifecycle,
      // rather than blurring a replacement before its queued focus runs.
      await waitFor(() => expect(document.activeElement).toBe(screen.getByLabelText('Real distance')))
      const field = screen.getByLabelText('Real distance')
      fireEvent.change(field, { target: { value: draft } }); fireEvent.blur(field)
      await waitFor(() => expect(Number((screen.getByLabelText('Real distance') as HTMLInputElement).value)).toBeCloseTo(original.widthMm / 2, 3))
    }
    expect(useCamStore.getState().consoleEvents.filter((e) => e.message.startsWith('Real distance:'))).toHaveLength(4)
    fireEvent.keyDown(screen.getByLabelText('Real distance'), { key: 'Escape' }); expect(payload()).toEqual(original)
    await picks(runtime); await enter('250'); await assertDistance(runtime, 250)
    fireEvent.click(screen.getByTestId('reference-image-lock-scale'))
    await waitFor(() => expect(payload().scaleLocked).toBe(true))
    expect(screen.queryByTestId('reference-image-calibrate')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('feature-row-reference-image:1'))
    expect(screen.queryByTestId('tree-context-menu-calibrate')).toBeNull()
    fireEvent.click(screen.getByTestId('tree-context-menu-lock-scale'))
    await waitFor(() => expect(payload().scaleLocked).toBe(false))
    expect(screen.getByTestId('reference-image-calibrate')).toBeTruthy()
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(payload().scaleLocked).toBe(true))
    const saved = { ...payload() }, archive = collectDocumentArchive()!
    cleanup(); resetDocumentHolder(); stashLoadedDocument(archive)
    const reopened = await mount()
    await assertDistance(reopened, 250); expect(payload()).toEqual(saved)
    fireEvent.contextMenu(screen.getByTestId('feature-row-reference-image:1'))
    expect(screen.queryByTestId('tree-context-menu-calibrate')).toBeNull()
  }, 90_000)

  it('retires a calibration on dialog replacement and restarts with fresh picks', async () => {
    const runtime = await mount(); await xy(runtime)
    const original = { ...payload() }
    fireEvent.click(screen.getByTestId('reference-image-calibrate'))
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'), planePixel(runtime, { x: 0, y: 0 }))
    expect(hooks().buildDebugSceneExport().skipped).toContain("open 'reference-image' dialog's unsaved draft field values")
    // Restart the active gesture: its previous first pick must not survive.
    fireEvent.click(screen.getByTestId('reference-image-calibrate'))
    expect(screen.getByTestId('reference-image-calibration-prompt').textContent).toContain('first mark')
    fireEvent.click(screen.getByTestId('reference-image-close'))
    expect(screen.queryByTestId('reference-image-calibration-prompt')).toBeNull()
    fireEvent.contextMenu(screen.getByTestId('feature-row-reference-image:1'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    expect(screen.queryByTestId('reference-image-calibration-prompt')).toBeNull()
    await picks(runtime)
    // Lock during the value-entry stage must dispose that stage and its ink.
    fireEvent.click(screen.getByTestId('reference-image-lock-scale'))
    await waitFor(() => expect(payload().scaleLocked).toBe(true))
    expect(screen.queryByTestId('reference-image-distance-entry')).toBeNull()
    expect(runtime.scene.getObjectByName('reference-image-calibration')).toBeUndefined()
    expect(payload().widthMm).toBe(original.widthMm)
    fireEvent.click(screen.getByTestId('reference-image-lock-scale'))
    await waitFor(() => expect(screen.getByTestId('reference-image-calibrate')).toBeTruthy())
    fireEvent.click(screen.getByTestId('reference-image-calibrate'))
    expect(screen.getByTestId('reference-image-calibration-prompt').textContent).toContain('first mark')
    fireEvent.keyDown(document, { key: 'Escape' })
  }, 90_000)

  it('uses an ordinary drawn selected line without altering its ends or adding calibration geometry', async () => {
    const runtime = await mount(); await xy(runtime)
    fireEvent.click(screen.getByTestId('reference-image-close'))
    fireEvent.click(screen.getByTestId('workbench-package-tool-line'))
    const image = payload()
    const canvas = screen.getByTestId('solids-workbench-canvas')
    const pixels = [0.1, 0.6].map((fraction) => planePixel(runtime, { x: image.widthMm * (fraction - 0.5), y: image.heightMm * 0.1 }))
    for (const at of pixels) await act(async () => {
      for (const type of ['pointermove', 'pointerdown', 'pointerup']) canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, ...at, button: 0 }))
    })
    fireEvent.keyDown(canvas, { key: 'Escape' })
    fireEvent.click(screen.getByTestId('workbench-package-tool-select'))
    const lines = () => sketchSessionStore.getState().sketch!.entities.filter((e) => e.kind === 'line' && !WORKBENCH_INJECTED_ENTITY_IDS.has(e.id))
    await waitFor(() => expect(lines()).toHaveLength(1))
    const before = structuredClone(lines()[0])
    // Use the package's canonical selection port; the line itself came from real pointer drawing.
    await act(async () => { workbenchSketchDocumentPort.setSelection([before.id]) })
    expect(sketchSessionStore.getState().selectedIds).toContain(before.id)
    fireEvent.contextMenu(screen.getByTestId('feature-row-reference-image:1'))
    fireEvent.click(screen.getByTestId('tree-context-menu-calibrate'))
    await waitFor(() => expect(screen.getByLabelText('Real distance')).toBeTruthy())
    if (before.kind !== 'line') throw new Error('Expected drawn line')
    const fractions = [before.start, before.end].map((p) => ({ x: p.x / image.widthMm, y: p.y / image.heightMm }))
    await enter('120')
    await waitFor(() => {
      const mesh = quad(runtime); mesh.updateWorldMatrix(true, false)
      const geometry = (mesh.geometry as THREE.PlaneGeometry).parameters
      const marks = fractions.map((p) => new THREE.Vector3(p.x * geometry.width, p.y * geometry.height, 0).applyMatrix4(mesh.matrixWorld))
      expect(marks[0].distanceTo(marks[1])).toBeCloseTo(120, 3)
    })
    expect(lines()).toEqual([before])
  }, 90_000)

  it('calibrates on a box top face using its own plane and keeps the image when sketch editing is canceled', async () => {
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
    await waitFor(() => expect(screen.getByTestId('reference-image-insert')).toBeTruthy())
    await insert(runtime)
    const first = markWorld(runtime, 0.1)
    await picks(runtime); await enter('250'); await assertDistance(runtime, 250)
    expect(markWorld(runtime, 0.1).z).toBeCloseTo(20)
    expect(markWorld(runtime, 0.1).distanceTo(first)).toBeLessThan(0.001)
    fireEvent.click(screen.getByTestId('reference-image-close'))
    fireEvent.click(screen.getByTestId('workbench-cancel-package-sketch'))
    await assertDistance(runtime, 250)
  }, 90_000)
})
