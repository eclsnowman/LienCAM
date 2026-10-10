import { readFileSync } from 'node:fs'
import { WORKBENCH_INJECTED_ENTITY_IDS } from '../../components/model3d/workbench/workbenchOriginAnchor'
import { SKETCH_Z } from '../../lib/sketch/sketcher/sketchLayer'
import { worldToLocal } from '../../sketch3d/planeMath'
import { stubCanvas2d } from './stubCanvas2d'
// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, act } from '@testing-library/react'
import * as THREE from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SolidsWorkbenchPage } from '../../components/model3d'
import { createLocalGeomService } from '../../geom'
import { resetDocumentHolder, collectDocumentArchive, stashLoadedDocument } from '../../doc/documentHolder'
import { loadDocumentArchive } from '../../doc/persist'
import { useCamStore } from '../../store'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import { sketchSessionStore } from '../../components/model3d/workbench/sketchSessionStore'
import { referenceImageFrame, type ReferenceImagePayload } from '../../referenceImage/referenceImage'
import { mintRectangleSketch } from './mintRectangleSketch'

let restoreCanvas: () => void
let dimensions = [400, 200]
beforeEach(() => {
  restoreCanvas = stubCanvas2d()
  resetDocumentHolder()
  useCamStore.getState().newProject()
  dimensions = [400, 200]
  vi.stubGlobal('Image', class {
    constructor() {
      const image = document.createElement('img')
      Object.defineProperties(image, { naturalWidth: { get: () => dimensions[0] }, naturalHeight: { get: () => dimensions[1] },
        src: { set() { queueMicrotask(() => image.onload?.(new Event('load'))) } } })
      return image
    }
  })
})
afterEach(() => { cleanup(); restoreCanvas(); vi.unstubAllGlobals(); resetDocumentHolder() })
const hooks = () => window.__solidsWorkbenchHooks!
const payload = () => hooks().dag.getNode('reference-image:1')!.payload as ReferenceImagePayload
function quads(runtime: FakeSceneRuntime): THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] {
  const result: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>[] = []
  runtime.scene.traverse((object) => { if (object.name === 'reference-image-quad') result.push(object as THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>) })
  return result
}
async function mount() {
  const runtime = createFakeSceneRuntime()
  runtime.camera.position.set(0, 0, 100)
  runtime.camera.lookAt(0, 0, 0)
  runtime.camera.updateMatrixWorld()
  render(<SolidsWorkbenchPage createClient={createLocalGeomService} createSceneRuntime={() => runtime} />)
  await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
  return runtime
}
async function insert(name = 'trace.png') {
  fireEvent.click(screen.getByTestId('reference-image-insert'))
  fireEvent.change(screen.getByTestId('reference-image-input'), { target: { files: [new File([readFileSync(`src/tests/evidence/WO-2302/${name.endsWith('.jpg') ? 'phone-4032x3024.jpg' : 'trace-400x200.png'}`)], name, { type: name.endsWith('.jpg') ? 'image/jpeg' : 'image/png' })] } })
  await waitFor(() => expect(screen.getByTestId('feature-row-reference-image:1').textContent).toContain(name))
  await waitFor(() => expect(hooks().scheduler.statusOf('reference-image:1')).toBe('ok'))
}
function corners(quad: THREE.Mesh) {
  quad.updateWorldMatrix(true, false)
  const positions = quad.geometry.getAttribute('position')
  return Array.from({ length: positions.count }, (_, i) => new THREE.Vector3().fromBufferAttribute(positions, i).applyMatrix4(quad.matrixWorld))
}
describe('WO-2302 reference image through the Model screen', () => {
  it('inserts on XY, edits opacity, hides undoably, draws over it, archives and reopens', async () => {
    const runtime = await mount()
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    runtime.rayOverride = { origin: { x: 10, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    await waitFor(() => expect(screen.getByTestId('reference-image-insert')).toBeTruthy())
    await insert()
    await waitFor(() => expect(quads(runtime)).toHaveLength(1))
    let quad = quads(runtime)[0]
    expect(quad.material.opacity).toBe(0.5)
    expect(quad.geometry.parameters.width / quad.geometry.parameters.height).toBe(2)
    const points = corners(quad)
    for (const point of points) expect(point.z).toBeCloseTo(0)
    expect(points.reduce((sum, p) => sum.add(p), new THREE.Vector3()).length()).toBeCloseTo(0)
    const ray = new THREE.Raycaster(new THREE.Vector3(0, 0, 10), new THREE.Vector3(0, 0, -1))
    expect(ray.intersectObject(quad)).toEqual([])
    fireEvent.contextMenu(screen.getByTestId('feature-row-reference-image:1'))
    fireEvent.click(screen.getByTestId('tree-context-menu-edit'))
    expect(hooks().buildDebugSceneExport().skipped).toContain("open 'reference-image' dialog's unsaved draft field values")
    expect((screen.getByLabelText('Opacity') as HTMLInputElement).value).toBe('50')
    const field = screen.getByLabelText('Opacity')
    fireEvent.focus(field); fireEvent.change(field, { target: { value: '30' } }); fireEvent.blur(field)
    await waitFor(() => expect(quads(runtime)[0]?.material.opacity).toBe(0.3))
    const clampCount = useCamStore.getState().consoleEvents.length
    fireEvent.focus(field); fireEvent.change(field, { target: { value: '140' } }); fireEvent.blur(field)
    await waitFor(() => expect(payload().opacity).toBe(1))
    expect(useCamStore.getState().consoleEvents.slice(clampCount).filter((e) => /Opacity/.test(e.message))).toHaveLength(1)
    fireEvent.focus(field); fireEvent.change(field, { target: { value: '30' } }); fireEvent.blur(field)
    await waitFor(() => expect(payload().opacity).toBe(0.3))
    const nameField = screen.getByLabelText('Reference image name')
    fireEvent.change(nameField, { target: { value: 'Tracing photo' } }); fireEvent.blur(nameField)
    await waitFor(() => expect(screen.getByTestId('feature-row-reference-image:1').textContent).toContain('Tracing photo'))
    fireEvent.click(screen.getByTestId('reference-image-close'))
    expect(hooks().buildDebugSceneExport().skipped).not.toContain("open 'reference-image' dialog's unsaved draft field values")

    // The real sketch interaction owns these clicks. The picture cannot enter its entity/snap census.
    const lineButton = screen.getByTestId('workbench-package-tool-line')
    fireEvent.click(lineButton)
    const canvas = screen.getByTestId('solids-workbench-canvas')
    Object.defineProperty(canvas, 'getBoundingClientRect', { value: () => ({ left: 0, top: 0, width: 800, height: 600, right: 800, bottom: 600 }) })
    for (const [clientX, clientY] of [[300, 250], [500, 350]]) {
      await act(async () => {
        for (const type of ['pointermove', 'pointerdown', 'pointerup']) canvas.dispatchEvent(new MouseEvent(type, { bubbles: true, cancelable: true, clientX, clientY, button: 0 }))
      })
    }
    const userLines = () => sketchSessionStore.getState().sketch!.entities.filter((e) => e.kind === 'line' && !WORKBENCH_INJECTED_ENTITY_IDS.has(e.id))
    await waitFor(() => expect(userLines()).toHaveLength(1))
    const line = userLines()[0]
    if (line.kind !== 'line') throw new Error('Expected a drawn line')
    const frame = sketchSessionStore.getState().frame!
    const expected = [[300, 250], [500, 350]].map(([x, y]) => {
      const ray = new THREE.Raycaster()
      ray.setFromCamera(new THREE.Vector2(x / 400 - 1, 1 - y / 300), runtime.camera)
      const normal = new THREE.Vector3(frame.normal.x, frame.normal.y, frame.normal.z)
      const origin = new THREE.Vector3(frame.origin.x, frame.origin.y, frame.origin.z).addScaledVector(normal, SKETCH_Z)
      const hit = ray.ray.intersectPlane(new THREE.Plane().setFromNormalAndCoplanarPoint(normal, origin), new THREE.Vector3())!
      return worldToLocal(frame, hit)
    })
    expect(line.start.x).toBeCloseTo(expected[0].x, 4)
    expect(line.start.y).toBeCloseTo(expected[0].y, 4)
    expect(line.end.x).toBeCloseTo(expected[1].x, 4)
    expect(line.end.y).toBeCloseTo(expected[1].y, 4)
    fireEvent.click(screen.getByTestId('feature-row-hide-reference-image:1'))
    await waitFor(() => expect(quads(runtime)).toHaveLength(0))
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(quads(runtime)).toHaveLength(1))
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(quads(runtime)).toHaveLength(0))
    const dataUrl = payload().image.dataUrl
    const archive = collectDocumentArchive()!
    const loaded = loadDocumentArchive(archive)
    expect(loaded.dag.getNode('reference-image:1')?.hidden).toBe(true)
    cleanup(); resetDocumentHolder(); stashLoadedDocument(archive)
    const reopened = await mount()
    await waitFor(() => expect(hooks().scheduler.statusOf('reference-image:1')).toBe('ok'))
    expect(payload().image.dataUrl).toBe(dataUrl)
    expect(payload().opacity).toBe(0.3)
    expect(quads(reopened)).toHaveLength(0)
    fireEvent.click(screen.getByTestId('feature-row-hide-reference-image:1'))
    await waitFor(() => expect(quads(reopened)[0]?.material.opacity).toBe(0.3))
    quad = quads(reopened)[0]
    expect(quad.material.map).not.toBeNull()
    expect(payload().name).toBe('Tracing photo')
    fireEvent.contextMenu(screen.getByTestId('feature-row-reference-image:1'))
    fireEvent.click(screen.getByTestId('tree-context-menu-delete'))
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    await waitFor(() => expect(quads(reopened)).toHaveLength(0))
    expect(hooks().dag.getNode('reference-image:1')).toBeUndefined()
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(quads(reopened)).toHaveLength(1))
  }, 90_000)

  it('inserts a phone JPG on a box top face and follows the face when the box grows', async () => {
    const runtime = await mount()
    await act(async () => { await mintRectangleSketch({ width: '40', height: '20', offset: '10' }) })
    await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
    fireEvent.click(screen.getByTestId('workbench-extrude'))
    await waitFor(() => expect(screen.getByTestId('extrude-distance')).toBeTruthy())
    const distance = screen.getByTestId('extrude-distance').querySelector('input')!
    fireEvent.change(distance, { target: { value: '20' } }); fireEvent.blur(distance)
    fireEvent.click(screen.getByTestId('dialog-shell-apply'))
    await waitFor(() => expect(hooks().getBodyHandle('F1')).toBeTruthy(), { timeout: 20_000 })
    runtime.rayOverride = { origin: { x: 30, y: 10, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
    fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
    fireEvent.click(screen.getByTestId('workbench-new-sketch'))
    await waitFor(() => expect(screen.getByTestId('reference-image-insert')).toBeTruthy())
    dimensions = [4032, 3024]
    await insert('phone.jpg')
    await waitFor(() => expect(quads(runtime)).toHaveLength(1))
    for (const point of corners(quads(runtime)[0])) expect(point.z).toBeCloseTo(20)
    expect((quads(runtime)[0].material.map!.image as { width: number }).width).toBe(2048)
    expect(payload().image).toMatchObject({ widthPx: 4032, heightPx: 3024 })
    const supportId = payload().planeNodeId
    expect(supportId).toBe('datum:reference-image:1')
    fireEvent.click(screen.getByTestId('workbench-cancel-package-sketch'))
    await waitFor(() => expect(screen.queryByTestId('workbench-finish-package-sketch')).toBeNull())
    await waitFor(() => expect(quads(runtime)).toHaveLength(1))
    expect(hooks().dag.getNode(supportId)).toBeTruthy()
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(quads(runtime)).toHaveLength(0))
    expect(hooks().dag.getNode(supportId)).toBeUndefined()
    fireEvent.click(screen.getByTestId('workbench-redo'))
    await waitFor(() => expect(quads(runtime)).toHaveLength(1))
    const box = hooks().dag.getNode('F1')!
    hooks().dag.setPayload('F1', { ...box.payload, distance: 35 })
    await act(async () => { await hooks().fullResync(['F1']) })
    await waitFor(() => expect(referenceImageFrame(hooks().dag, payload())?.origin.z).toBeCloseTo(35))
    await waitFor(() => expect(corners(quads(runtime)[0])[0].z).toBeCloseTo(35))
    expect(hooks().scheduler.diagnosticsOf('reference-image:1')).toEqual([])
    expect(hooks().getBodyHandle('reference-image:1')).toBeUndefined()
    fireEvent.contextMenu(screen.getByTestId('feature-row-reference-image:1'))
    fireEvent.click(screen.getByTestId('tree-context-menu-delete'))
    fireEvent.click(screen.getByTestId('tree-delete-confirm-confirm'))
    await waitFor(() => expect(quads(runtime)).toHaveLength(0))
    expect(hooks().dag.getNode(supportId)).toBeUndefined()
    fireEvent.click(screen.getByTestId('workbench-undo'))
    await waitFor(() => expect(quads(runtime)).toHaveLength(1))
  }, 90_000)
})
