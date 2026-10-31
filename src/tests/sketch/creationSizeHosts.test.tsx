// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as THREE from 'three'
import { Sketcher, sketcherTools, sketcherToolStore } from '../../lib/sketch/sketcher'
import { SketchDrawValueInput } from '../../lib/sketch/sketcher/overlays/SketchDrawValueInput'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type { Sketch } from '../../lib/sketch/types'
import type { SketchWorkerRequestMsg, SketchWorkerResponseMsg } from '../../lib/sketch/solver/protocol'
const wrapper = await createGcsWrapper()
// Only replace the transport: every response is produced by real planegcs.
class SolverTransport {
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  postMessage(msg: SketchWorkerRequestMsg) {
    const { requestId, sketch } = msg.payload
    queueMicrotask(() => {
      const out = solveSketchOnWrapper(wrapper, sketch)
      this.onmessage?.({ data: out.ok ? { type: 'SKETCH_SOLVE_COMPLETE', requestId, entities: out.entities, status: out.status, computeTimeMs: 0 }
        : { type: 'SKETCH_SOLVE_FAILED', requestId, reason: out.reason, message: out.message, status: out.status } })
    })
  }
  terminate() {}
}
vi.stubGlobal('Worker', SolverTransport)
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} })
const savedFiles: string[] = []
vi.stubGlobal('liencamHost', { saveFile: async (_name: string, data: string) => { savedFiles.push(data); return 'creation.camproject' } })
const { camSketchDocumentPort: cam, useCamStore } = await import('../../store')
const { createCamOverlaysPort } = await import('../../components/viewport/camOverlaysPort')
const { workbenchSketchDocumentPort: part, __resetSketchDocumentPort, syncSketchSessionFromDag } = await import('../../components/model3d/workbench/workbenchSketchDocumentPort')
const { sketchSessionStore: session } = await import('../../components/model3d/workbench/sketchSessionStore')
const { workbenchOverlaysPort } = await import('../../components/model3d/workbench/workbenchOverlaysPort')
const { FeatureDag, CommandHistory, RegenScheduler, ElementMap } = await import('../../doc')
const { BASE_PLANE_FRAMES } = await import('../../components/model3d/workbench/basePlanes')
let sketcher: Sketcher | null = null
let root: HTMLDivElement | null = null
const blank = (): Sketch => ({ id: 'creation-host', layerId: 'creation-layer', entities: [], constraints: [], dimensions: [], solveStatus: null })
afterEach(() => { act(() => sketcher?.dispose()); sketcher = null; cleanup(); root?.remove(); session.__reset(); __resetSketchDocumentPort() })
for (const host of ['CAM', 'Part'] as const) describe(`${host} creation dimensions through actual host ports`, () => {
  it.each([
    { tool: 'rect-corner', square: false }, { tool: 'rect-center', square: false },
    { tool: 'rect-corner', square: true }, { tool: 'rect-center', square: true },
  ] as const)('$tool square=$square solves, drives geometry and survives one undo/redo and reopen', async ({ tool, square }) => {
    sketcherToolStore.__reset()
    const dag = new FeatureDag(), history = new CommandHistory(dag)
    const initial = blank(), nodeId = 'creation-sketch'
    if (host === 'CAM') {
      act(() => { useCamStore.getState().startNewSketch() })
      useCamStore.setState({ sketchHistory: [], sketchFuture: [], projectHistory: [], projectFuture: [] })
    } else {
      dag.insertNode({ id: nodeId, kind: 'sketch', consumes: [], refs: [], payload: { sketch: initial } }, 0)
      session.bindDeps({ dag, history, scheduler: new RegenScheduler(dag, new ElementMap()), wrapper,
        notice: () => undefined, onDocumentChanged: () => undefined, onHistoryStep: () => undefined })
      session.begin(nodeId, BASE_PLANE_FRAMES.xy, initial); __resetSketchDocumentPort()
    }
    const port = host === 'CAM' ? cam : part
    const sketch = () => port.getSketch()!
    root = document.createElement('div'); const canvas = document.createElement('canvas'); root.appendChild(canvas); document.body.appendChild(root)
    sketcher = new Sketcher({ domElement: canvas, container: root, overlayHost: root,
      overlayRoot: new THREE.Group(), camera: new THREE.OrthographicCamera(), controls: { enableRotate: false },
      clientToPlaneWorld: (x, y) => ({ x, y }), worldPerPixel: () => .01,
      saveCameraPose: () => ({}), restoreCameraPose() {}, frameNormalToPlane() {} })
    sketcher.setDocumentPort(port); sketcher.enter()
    const surface = () => ({ worldToScreen: (x: number, y: number) => ({ x, y }), getLastSketchCursor: () => sketcher!.getLastCursor() })
    // Use Part's production overlay hooks/commands, replacing only projection;
    // reuse the actual host hooks/commands and replace just the surface getter.
    const overlayPort = host === 'CAM' ? createCamOverlaysPort(surface)
      : { ...workbenchOverlaysPort, getSurface: surface }
    render(<SketchDrawValueInput port={overlayPort} />, { container: root.appendChild(document.createElement('div')) })
    act(() => { sketcherTools.armTool(tool); sketcherTools.click({ x: 10, y: 10 }, .1, null, false)
      canvas.dispatchEvent(new MouseEvent('pointermove', { clientX: 25, clientY: square ? 25 : 20, bubbles: true })) })
    const w = root.querySelector<HTMLInputElement>('input[aria-label="Width"]')!
    const h = root.querySelector<HTMLInputElement>('input[aria-label="Height"]')!
    expect(w).not.toBeNull()
    const size = tool === 'rect-center' ? 30 : 15
    act(() => w.focus()); fireEvent.input(w, { target: { value: square ? String(size) : '50' } })
    if (square) fireEvent.keyDown(w, { key: 'Enter', shiftKey: true })
    else {
      fireEvent.keyDown(w, { key: 'Tab' }); fireEvent.input(h, { target: { value: '30' } }); fireEvent.keyDown(h, { key: 'Enter' })
    }
    await waitFor(() => expect(sketch().solveStatus).not.toBeNull())
    expect(sketch().solveStatus!.conflicting).toEqual([])
    expect(sketch().dimensions.map(d => d.value)).toEqual(square ? [size] : [50, 30])
    expect(sketch().constraints.filter(c => c.kind === 'equal')).toHaveLength(square ? 1 : 0)
    const saved = structuredClone(sketch())
    const undo = () => { if (host === 'CAM') useCamStore.getState().undo(); else { history.undo(); syncSketchSessionFromDag() } }
    const redo = () => { if (host === 'CAM') useCamStore.getState().redo(); else { history.redo(); syncSketchSessionFromDag() } }
    act(undo); expect(sketch().dimensions).toHaveLength(0)
    act(redo); await waitFor(() => expect(sketch().solveStatus).not.toBeNull())
    expect(sketch().entities.map(e => e.id)).toEqual(saved.entities.map(e => e.id))
    expect(sketch().dimensions).toEqual(saved.dimensions)
    // Editing a dimension must pull the actual side, rather than only a label.
    const edited = { ...sketch(), dimensions: sketch().dimensions.map((d, i) => i === 0 ? { ...d, value: 60 } : d) }
    const solved = solveSketchOnWrapper(wrapper, edited)
    expect(solved.ok).toBe(true)
    if (!solved.ok) throw new Error(solved.message)
    const line = solved.entities.find(e => e.id === saved.entities.find(e => e.kind === 'line' && !e.construction)!.id)!
    expect(line.kind).toBe('line')
    if (line.kind === 'line') expect(Math.hypot(line.end.x - line.start.x, line.end.y - line.start.y)).toBeCloseTo(60, 4)
    if (square) {
      const other = solved.entities.filter(e => e.kind === 'line' && !e.construction)[1]
      expect(other.kind).toBe('line')
      if (other.kind === 'line') expect(Math.hypot(other.end.x - other.start.x, other.end.y - other.start.y)).toBeCloseTo(60, 4)
    }
    if (host === 'CAM') {
      const layerId = sketch().layerId
      act(() => useCamStore.getState().finishSketch())
      const owner = useCamStore.getState().project.geometry.find(g => g.layers2d?.some(l => l.id === layerId))!
      // Drive actual Save and load, replacing only the external file chooser.
      savedFiles.length = 0
      await act(async () => { expect(await useCamStore.getState().saveProjectToFile()).toBe('saved') })
      expect(savedFiles).toHaveLength(1)
      expect(savedFiles[0]).not.toContain('creationSize')
      await act(async () => { await useCamStore.getState().loadProjectFromFile(savedFiles[0]) })
      act(() => { useCamStore.getState().openSketchForLayer(layerId, owner.id) })
      expect(sketch().dimensions).toEqual(saved.dimensions)
    } else {
      const payload = JSON.parse(JSON.stringify(dag.getNode(nodeId)!.payload))
      act(() => session.begin(nodeId, BASE_PLANE_FRAMES.xy, payload.sketch))
      expect(sketch().dimensions).toEqual(saved.dimensions)
    }
    expect(JSON.stringify(sketch())).not.toContain('creationSize')
  })
})
