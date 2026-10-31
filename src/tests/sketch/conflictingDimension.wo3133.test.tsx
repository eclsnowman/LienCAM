// @vitest-environment jsdom
import { act, cleanup, fireEvent, render } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { Sketcher, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import { SketchDimensionOverlay } from '../../lib/sketch/sketcher/overlays/SketchDimensionOverlay'
import type { SketcherHost } from '../../lib/sketch/sketcher/ports'
import type { SketchWorkerRequestMsg, SketchWorkerResponseMsg } from '../../lib/sketch/solver/protocol'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'

// Replace transport only. Every verdict is from the production WASM solver;
// UI, dimension creation, store mutation, rejection and history are real.
const requests: { worker: SolverTransport; message: SketchWorkerRequestMsg }[] = []
class SolverTransport {
  onmessage?: (event: { data: SketchWorkerResponseMsg }) => void
  postMessage(message: SketchWorkerRequestMsg) {
    requests.push({ worker: this, message: structuredClone(message) })
  }
  terminate() {}
}
vi.stubGlobal('Worker', SolverTransport)
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
const { camSketchDocumentPort, useCamStore } = await import('../../store')
const { createCamOverlaysPort } = await import('../../components/viewport/camOverlaysPort')
const { sketchSessionStore } = await import('../../components/model3d/workbench/sketchSessionStore')
const { workbenchSketchDocumentPort, __resetSketchDocumentPort } = await import('../../components/model3d/workbench/workbenchSketchDocumentPort')
const { workbenchOverlaysPort } = await import('../../components/model3d/workbench/workbenchOverlaysPort')
const { CommandHistory, FeatureDag, RegenScheduler, ElementMap } = await import('../../doc')
const { BASE_PLANE_FRAMES, seedGenesisNodes } = await import('../../components/model3d/workbench/basePlanes')
let wrapper: Awaited<ReturnType<typeof createGcsWrapper>>
let sketcher: Sketcher
let root: HTMLDivElement
let canvas: HTMLCanvasElement
const store = () => useCamStore.getState()
const sketch = () => store().activeSketch!
const input = () => root.querySelector<HTMLInputElement>('input.sketch-dim-input')!
function key(key: string, target: EventTarget = document.activeElement ?? canvas) {
  act(() => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })) })
}
function flushSolver() {
  act(() => {
    for (let i = 0; requests.length; i++) {
      if (i > 30) throw new Error('Unexpected solve loop')
      const { worker, message } = requests.shift()!
      const { requestId, sketch } = message.payload
      const outcome = solveSketchOnWrapper(wrapper, sketch)
      const data: SketchWorkerResponseMsg = outcome.ok
        ? { type: 'SKETCH_SOLVE_COMPLETE', requestId, entities: outcome.entities, status: outcome.status, computeTimeMs: 0 }
        : { type: 'SKETCH_SOLVE_FAILED', requestId, reason: outcome.reason, message: outcome.message, status: outcome.status }
      worker.onmessage?.({ data })
    }
  })
}
function placeHeight(settle = true, labelX = 0) {
  act(() => {
    sketcherTools.armTool('smart-dimension')
    sketcherTools.click({ x: 10, y: 25 }, 0.1, null, false)
    sketcherTools.click({ x: labelX, y: 25 }, 0.1, null, false, () => {
      // The real pointer interaction supplies this undo sink on first mutation.
      const doc = sketchSessionStore.getState().active ? workbenchSketchDocumentPort : camSketchDocumentPort
      doc.beginStep()
    })
  })
  expect(input()).not.toBeNull()
  if (settle) flushSolver()
}
function enter(value: string, method = 'Enter') {
  fireEvent.change(input(), { target: { value } })
  if (method === 'blur') act(() => input().blur())
  else key('Enter')
  flushSolver()
}
function testHost(): SketcherHost {
  return {
    domElement: canvas, container: root, overlayHost: root, overlayRoot: new THREE.Group(),
    camera: new THREE.OrthographicCamera(), controls: { enableRotate: false },
    clientToPlaneWorld: (x, y) => ({ x, y }), worldPerPixel: () => 0.01,
    saveCameraPose: () => ({}), restoreCameraPose() {}, frameNormalToPlane() {},
  }
}
beforeAll(async () => { wrapper = await createGcsWrapper() })
afterAll(() => wrapper.destroy_gcs_module())
beforeEach(() => {
  requests.length = 0
  sketcherToolStore.__reset()
  useCamStore.setState(s => ({
    activeSketch: { id: 'wo3133', layerId: 'layer', entities: [], constraints: [], dimensions: [], solveStatus: null },
    sketchSelectedIds: [], sketchDimEditor: null, sketchHistory: [], sketchFuture: [],
    projectHistory: [], projectFuture: [], toolSlicesHistory: [], toolSlicesFuture: [], sketchNotice: null,
    viewer: { ...s.viewer, mode: 'sketch' }, appSettings: { ...s.appSettings, displayUnits: 'mm' },
  }))
  root = document.createElement('div'); canvas = document.createElement('canvas')
  root.appendChild(canvas); document.body.appendChild(root)
  const host = testHost()
  sketcher = new Sketcher(host)
  sketcher.setDocumentPort(camSketchDocumentPort)
  sketcher.setUndoSink({ beginGesture: () => store().pushHistory() })
  sketcher.enter()
  act(() => {
    sketcherTools.armTool('rect-corner')
    sketcherTools.click({ x: 10, y: 10 }, 0.1, null, false)
    sketcherTools.click({ x: 60, y: 40 }, 0.1, null, false)
    sketcherTools.escape()
  })
  flushSolver()
  render(<SketchDimensionOverlay port={createCamOverlaysPort(() => ({
    worldToScreen: (x, y) => ({ x, y }), getLastSketchCursor: () => ({ x: 0, y: 25 }),
  }))} />, { container: root.appendChild(document.createElement('div')) })
  placeHeight(); enter('30')
  expect(sketch().dimensions).toHaveLength(1)
  expect(sketch().dimensions[0].value).toBe(30)
})
afterEach(() => {
  act(() => sketcher.dispose()); cleanup(); root.remove()
  __resetSketchDocumentPort(); sketchSessionStore.__reset()
})
function histories() {
  const s = store()
  return { project: s.projectHistory, sketch: s.sketchHistory, tools: s.toolSlicesHistory,
    projectFuture: s.projectFuture, sketchFuture: s.sketchFuture, toolFuture: s.toolSlicesFuture,
    canUndo: s.canUndo, canRedo: s.canRedo }
}
function mountWorkbench() {
  // Transfer the rectangle actually authored above through the package UI.
  const initial = structuredClone(sketch())
  act(() => sketcher.dispose()); cleanup()
  const dag = new FeatureDag(); seedGenesisNodes(dag)
  const nodeId = 'sketch3d:wo3133'
  dag.insertNode({ id: nodeId, kind: 'sketch', consumes: [], refs: [], payload: { sketch: initial } })
  const history = new CommandHistory(dag)
  const notices: string[] = []; const touched: string[] = []
  sketchSessionStore.bindDeps({ dag, history, scheduler: new RegenScheduler(dag, new ElementMap()), wrapper,
    notice: message => notices.push(message), onDocumentChanged() {}, onHistoryStep: id => touched.push(id) })
  sketchSessionStore.setSurface({ worldToScreen: (x, y) => ({ x, y }), getLastSketchCursor: () => ({ x: 0, y: 25 }) })
  sketchSessionStore.begin(nodeId, BASE_PLANE_FRAMES.xy, initial)
  sketcher = new Sketcher(testHost())
  sketcher.setDocumentPort(workbenchSketchDocumentPort)
  sketcher.setUndoSink({ beginGesture: () => workbenchSketchDocumentPort.beginStep() })
  sketcher.enter()
  render(<SketchDimensionOverlay port={workbenchOverlaysPort} />, { container: root.appendChild(document.createElement('div')) })
  const storedSketch = () => dag.getNode(nodeId)!.payload.sketch as typeof initial
  const resync = () => act(() => sketchSessionStore.setState({ sketch: storedSketch() }))
  return { dag, nodeId, history, notices, touched, document: storedSketch, resync }
}

describe('WO-3133 conflicting dimension result through production UI and store', () => {
  it.each(['Enter', 'blur'])('rejects a newly placed contradictory height atomically on %s', method => {
    const before = structuredClone(sketch())
    const historyBefore = store().sketchHistory.slice()
    placeHeight(); enter('40', method)
    expect(store().sketchNotice).toMatch(/rejected.*conflicts/i)
    expect(sketch().dimensions, 'a rejected new 40 must not leave a phantom measured-30 dimension').toEqual(before.dimensions)
    expect(sketch().entities).toEqual(before.entities)
    expect(sketch().constraints).toEqual(before.constraints)
    expect(store().sketchHistory, 'rejection must not add authored undo states').toEqual(historyBefore)
    expect(store().sketchDimEditor).toBeNull()
  })
  it('preserves supported same-value redundancy and Escape of measured placement', () => {
    placeHeight(); enter('30')
    expect(sketch().dimensions).toHaveLength(2)
    expect(sketch().dimensions.every(d => d.driving && d.value === 30)).toBe(true)
    expect(sketch().solveStatus?.redundant.length).toBeGreaterThan(0)
    expect(store().sketchNotice ?? '').not.toMatch(/rejected/i)
    placeHeight(); key('Escape'); flushSolver()
    expect(sketch().dimensions).toHaveLength(3)
    expect(store().sketchDimEditor).toBeNull()
  })
  it('preserves successful editing of an existing dimension', () => {
    const id = sketch().dimensions[0].id
    act(() => store().openDimensionEditor(id))
    enter('40')
    expect(sketch().dimensions).toHaveLength(1)
    expect(sketch().dimensions[0].value).toBe(40)
    expect(store().sketchNotice ?? '').not.toMatch(/rejected/i)
  })
  it.each(['Enter', 'blur'])('rejects an in-flight measured placement on %s without keeping either history entry', method => {
    const before = structuredClone(sketch()); const history = histories()
    placeHeight(false); enter('40', method)
    expect(store().sketchNotice).toMatch(/rejected.*conflicts/i)
    expect(sketch().dimensions).toEqual(before.dimensions)
    expect(sketch().entities).toEqual(before.entities)
    expect(histories()).toEqual(history)
  })
  it('rejects first-digit placement before its measured solve and recovers with a supported dimension', () => {
    const before = structuredClone(sketch()); const history = histories()
    act(() => {
      sketcherTools.armTool('smart-dimension')
      sketcherTools.click({ x: 10, y: 25 }, 0.1, null, false)
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 0, clientY: 25, bubbles: true }))
    })
    key('4', canvas)
    expect(input().value).toBe('4')
    enter('40')
    expect(store().sketchNotice).toMatch(/rejected.*conflicts/i)
    expect(sketch().dimensions).toEqual(before.dimensions)
    expect(histories()).toEqual(history)
    placeHeight(); enter('30')
    expect(sketch().dimensions).toHaveLength(2)
    const accepted = structuredClone(sketch().dimensions)
    act(() => store().undo()); flushSolver()
    expect(sketch().dimensions).toEqual(before.dimensions)
    act(() => store().redo()); flushSolver()
    expect(sketch().dimensions).toEqual(accepted)
  })
  it('preserves paired redo after rejecting a placement, including at the history cap', () => {
    placeHeight(); enter('30')
    act(() => store().undo()); flushSolver()
    const before = histories()
    expect(store().canRedo).toBe(true)
    placeHeight(); enter('40')
    expect(histories()).toEqual(before)
    act(() => store().redo()); flushSolver()
    expect(sketch().dimensions).toHaveLength(2)
    act(() => { for (let i = 0; i < 205; i++) store().pushHistory() })
    const capped = histories()
    placeHeight(); enter('40')
    expect(histories()).toEqual(capped)
    expect(sketch().dimensions).toHaveLength(2)
  })
  it('does not resurrect a rejected dimension across bake and project reload', async () => {
    placeHeight(); enter('40')
    expect(sketch().dimensions).toHaveLength(1)
    let layerId = ''; let ownerId = ''
    act(() => {
      const layer = store().createSketchLayer(); layerId = layer.id
      const owner = store().project.geometry.find(g => g.layers2d?.some(l => l.id === layer.id))!
      ownerId = owner.id
      store().setActiveSketch({ ...sketch(), layerId, ownerGeometryId: ownerId })
    })
    flushSolver()
    act(() => store().bakeActiveSketch())
    const saved = JSON.stringify(store().project)
    await act(async () => store().loadProjectFromFile(saved))
    act(() => { expect(store().openSketchForLayer(layerId, ownerId)).toBe(true) })
    flushSolver()
    expect(sketch().dimensions).toHaveLength(1)
    expect(sketch().dimensions[0].value).toBe(30)
  })
  it.each(['Enter', 'blur'])('rejects the synchronous workbench initial value on %s in both document copies and history', method => {
    const wb = mountWorkbench()
    const before = structuredClone(wb.document())
    placeHeight(true, -15); enter('40', method)
    expect(wb.notices.at(-1)).toMatch(/not applied|conflict/i)
    expect(wb.document().dimensions).toEqual(before.dimensions)
    expect(sketchSessionStore.getState().sketch!.dimensions).toEqual(before.dimensions)
    expect(wb.document().entities).toEqual(before.entities)
    expect(wb.document().constraints).toEqual(before.constraints)
    expect(wb.history.size()).toBe(0)
    expect(wb.touched).toEqual([])
    expect(sketchSessionStore.getState().dimEditor).toBeNull()
    const reloaded = FeatureDag.restore(wb.dag.serialize())
    expect((reloaded.getNode(wb.nodeId)!.payload.sketch as typeof before).dimensions).toEqual(before.dimensions)
    placeHeight(true, -15); enter('30')
    expect(wb.document().dimensions).toHaveLength(2)
    expect(wb.history.size()).toBe(1)
    expect(wb.touched).toEqual([wb.nodeId])
    wb.history.undo(); wb.resync()
    expect(wb.document().dimensions).toEqual(before.dimensions)
    wb.history.redo(); wb.resync()
    expect(wb.document().dimensions).toHaveLength(2)
  })
  it('keeps workbench measured Escape, existing edits and reference placement semantics', () => {
    const wb = mountWorkbench()
    placeHeight(true, -15); key('Escape')
    expect(wb.document().dimensions).toHaveLength(2)
    expect(wb.history.size()).toBe(1)
    wb.history.undo(); wb.resync()
    expect(wb.document().dimensions).toHaveLength(1)
    act(() => workbenchSketchDocumentPort.openDimEditor(wb.document().dimensions[0].id))
    enter('40')
    expect(wb.document().dimensions[0].value).toBe(40)
    expect(wb.document().dimensions).toHaveLength(1)
    act(() => workbenchOverlaysPort.toggleDimensionDriving(wb.document().dimensions[0].id))
    expect(wb.document().dimensions[0].driving).toBe(false)
    act(() => workbenchSketchDocumentPort.openDimEditor(wb.document().dimensions[0].id))
    enter('50')
    expect(wb.document().dimensions[0].value).toBeCloseTo(40)
    expect(wb.document().dimensions[0].driving).toBe(false)
  })

})
