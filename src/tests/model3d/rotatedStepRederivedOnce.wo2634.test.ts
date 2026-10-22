// @vitest-environment jsdom
//
// WO-2634: a rotated STEP part keeps its operations. Operator ruling 2026-10-06: "Yes and
// if we are rediriving it every rotation that would be dumb."
//
//   production New Operation (Drill on the part's detected holes) -> Create
//   -> store.updateGeometryTransform (the ONE committed-rotation seam)
//   -> store.computeOperationToolpath -> REAL toolpathWorker.ts -> postProject(UCCNC)
//
// The only stand-in is the Worker thread (node has none): the stub hands each
// request to the real worker module in-process (WO-2516's harness).
//
// Fixture: a 60 x 40 x 10 mm STEP plate, the stock exactly around it, work zero
// on its top (machine Z 10). Its detected holes: one through hole at model
// (15, 10) - off centre in Y, so turning the plate over about X moves it - and
// a face layer (model top, z 10) holding one CCW rectangle. Turned upside down
// about X with position (0, 40, 10) the plate fills the same stock: model
// (x, y, z) -> world (x, 40 - y, 10 - z), so the hole is at world (15, 30).

import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'
import type { WorkerRequestMsg, WorkerResponseMsg } from '../../lib/cam/types'
import type { ImportedGeometry, Operation, PhysicalStock, Setup, Tool, Vec2 } from '../../types'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size }, clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null, key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) }, setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { UCCNC_CONFIG } = await import('../../lib/post')
const { postProject } = await import('../../lib/post/postProject')

type WorkerSelf = {
  postMessage: (msg: WorkerResponseMsg) => void
  onmessage: ((event: { data: WorkerRequestMsg }) => Promise<void>) | null
  location: Location
}
let deliver: ((msg: WorkerResponseMsg) => void) | null = null
const workerSelf: WorkerSelf = {
  postMessage: (msg) => { deliver?.(msg) }, onmessage: null, location: window.location,
}

class InProcessToolpathWorker {
  onmessage: ((event: { data: unknown }) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  constructor(_url: unknown, _opts?: unknown) { /* the real module is already loaded */ }
  postMessage(request: WorkerRequestMsg): void {
    deliver = (msg) => this.onmessage?.({ data: msg })
    void workerSelf.onmessage!({ data: request })
  }
  terminate(): void { /* no thread to stop */ }
}

const POINT = 2.5 / Math.tan(59 * Math.PI / 180)
const PLATE = 10
const PART = 'plate'
const FLIPPED_POSITION = { x: 0, y: 40, z: PLATE }

const tool = {
  id: 'drill-5', name: '5 mm Drill', toolNumber: 1, type: 'drill', diameter: 5, tipDiameter: 0, angleFromAxisDeg: 59,
  fluteLength: 30, shankDiameter: 5, overallLength: 70, numberOfFlutes: 2, material: 'hss', coating: 'none',
  notes: '', feedsAndSpeeds: { default: { rpm: 3000, feedRate: 300, plungeRate: 150, depthOfCut: 2, stepover: 1 } },
} as unknown as Tool

const box = (z: number) => ({
  min: { x: 0, y: 0, z: 0 }, max: { x: 60, y: 40, z },
  size: { x: 60, y: 40, z }, center: { x: 30, y: 20, z: z / 2 },
})

const stock = {
  id: 'stock-1', name: 'Plate', mode: 'explicit', bounds: box(PLATE), position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

function circle(cx: number, cy: number, r: number): Vec2[] {
  return Array.from({ length: 48 }, (_, k) => ({
    x: cx + r * Math.cos((2 * Math.PI * k) / 48), y: cy + r * Math.sin((2 * Math.PI * k) / 48),
  }))
}

const RECT: Vec2[] = [{ x: 10, y: 5 }, { x: 30, y: 5 }, { x: 30, y: 15 }, { x: 10, y: 15 }]

/** The plate as deriveBrepLayer lands it: model-frame layers (geometry_local). */
function plate(withFace = true): ImportedGeometry {
  const plane = (z: number) => ({
    origin: { x: 0, y: 0, z }, xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, normal: { x: 0, y: 0, z: 1 },
  })
  return {
    id: PART, name: 'Plate.step', filename: 'Plate.step', type: 'brep', format: 'step',
    // Locked to its stock: a tilted plate pokes out of the exact-fit box, and
    // this order is about its features, not about stock membership.
    loaded: true, stockId: stock.id, stockIdLocked: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: box(PLATE),
    loops: [
      { id: 'hole-1', layerId: 'holes', closed: true, type: 'contour', area: Math.PI * 6.25, points: circle(15, 10, 2.5) },
      ...(withFace ? [{ id: 'top-face', layerId: 'face', closed: true, type: 'contour', area: 200, points: RECT }] : []),
    ],
    layers2d: [
      {
        id: 'holes', name: 'Holes (1)', color: '#fff', visible: true, derived: true,
        frame: 'geometry_local', projectionPlane: plane(PLATE),
        holes: [{ center: [15, 10], diameter: 5, topZ: PLATE, bottomZ: 0, through: true, loopId: 'hole-1' }],
      },
      ...(withFace ? [{
        id: 'face', name: 'Face 3', color: '#0f0', visible: true, derived: true,
        frame: 'geometry_local', projectionPlane: plane(PLATE),
      }] : []),
    ],
  } as unknown as ImportedGeometry
}

function seed(withFace = true): void {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: PLATE },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
  } as unknown as Setup
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [tool],
    toolpathBatch: null,
    project: {
      ...state.project, setups: [setup], activeSetupId: setup.id, activeOperationId: undefined,
      stocks: [stock], geometry: [plate(withFace)], toolLibrary: [tool],
    },
  } as never)
}

/** Production New Operation: Drill, the 5 mm drill, every loop of the plate
 *  (seeded with its hole layer only). */
async function createDrill(): Promise<Operation> {
  seed(false)
  render(createElement(NewOperationModal))
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText('Drill'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(tool.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: PART } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(screen.getByTestId('resolved-height-plan')).not.toBeNull())
  fireEvent.click(screen.getByTestId('op-create'))
  const operations = useCamStore.getState().project.setups[0].operations
  expect(operations.length, screen.queryByTestId('drill-bore-height-preflight')?.textContent ?? '').toBe(1)
  cleanup()
  return operations[0]
}

/** Recompute through the real worker; the op as it ended up. */
async function recompute(opId: string): Promise<Operation> {
  await useCamStore.getState().computeOperationToolpath('setup-1', opId)
  return useCamStore.getState().project.setups[0].operations.find(op => op.id === opId)!
}

/** Post the op (UCCNC); its drill cycle lines and deepest Z. */
function post(opId: string): { tipZ: number; drillLines: string[] } {
  const project = useCamStore.getState().project
  const posted = postProject(project, [project.setups[0]], UCCNC_CONFIG, {
    mode: 'separate', pauseBetweenSetups: false, baseName: 'wo2634', ext: 'nc',
    selectedOpIds: { 'setup-1': [opId] },
  })
  expect(posted.diagnostics.filter(d => d.level === 'error')).toEqual([])
  const result = posted.files![0].result
  const span = result.operationSpans!.find(s => s.opId === opId)!
  const gcode = result.gcode.split('\n').slice(span.startLine - 1, span.endLine)
  const zs = gcode.flatMap(line => {
    const m = /\bZ(-?[\d.]+)/.exec(line.replace(/\(.*?\)/g, ''))
    return m ? [Number(m[1])] : []
  })
  return { tipZ: Math.min(...zs), drillLines: gcode.filter(line => /\bG8[1-3]\b/.test(line)) }
}

const part = () => useCamStore.getState().project.geometry.find(g => g.id === PART)!
const layer = (id: string) => part().layers2d!.find(l => l.id === id)!
const loop = (id: string) => part().loops!.find(l => l.id === id)!
const signedArea = (pts: Vec2[]) =>
  pts.reduce((sum, p, i) => { const q = pts[(i + 1) % pts.length]; return sum + p.x * q.y - q.x * p.y }, 0) / 2
const xyOf = (line: string) => ({
  x: Number(/\bX(-?[\d.]+)/.exec(line)?.[1]), y: Number(/\bY(-?[\d.]+)/.exec(line)?.[1]),
})

const evidence: Record<string, unknown> = {}
const ORIGINAL_WORKER = globalThis.Worker
const ORIGINAL_SELF = globalThis.self

beforeAll(async () => {
  ;(globalThis as { Worker: unknown }).Worker = InProcessToolpathWorker
  ;(globalThis as { self: unknown }).self = workerSelf
  await import('../../lib/cam/toolpathWorker')
}, 120_000)
afterAll(() => {
  ;(globalThis as { Worker: unknown }).Worker = ORIGINAL_WORKER
  ;(globalThis as { self: unknown }).self = ORIGINAL_SELF
  console.info('[WO-2634] evidence', JSON.stringify(evidence))
})
beforeEach(() => {
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
  seed()
})
afterEach(cleanup)

describe('WO-2634: a STEP part turned upside down keeps its operations', () => {
  it('the hole drill computes on the turned part, at the hole\'s new place, same depth', async () => {
    const op = await createDrill()
    expect((await recompute(op.id)).status).toBe('ready')
    const upright = post(op.id)
    evidence.upright = upright
    expect(upright.drillLines.length).toBe(1)
    expect(xyOf(upright.drillLines[0])).toEqual({ x: 15, y: 10 })

    act(() => useCamStore.getState().updateGeometryTransform(PART, FLIPPED_POSITION, { x: 180, y: 0, z: 0 }))
    const turned = await recompute(op.id)
    evidence.turnedStatus = turned.status
    evidence.turnedError = turned.errorMessage
    expect(turned.errorMessage ?? '').not.toMatch(/re-import/i)
    expect(turned.status, turned.errorMessage).toBe('ready')
    const flipped = post(op.id)
    evidence.flipped = flipped
    expect(flipped.drillLines.length).toBe(1)
    const at = xyOf(flipped.drillLines[0])
    expect(at.x).toBeCloseTo(15, 3)
    expect(at.y).toBeCloseTo(30, 3)
    // A through hole either way up: the same depth through the same plate.
    expect(flipped.tipZ).toBeCloseTo(upright.tipZ, 3)
    expect(flipped.tipZ).toBeLessThan(-PLATE - POINT + 1e-6)
  }, 120_000)
})

describe('WO-2634: re-derived once, when the rotation is committed', () => {
  it('turning over re-derives every layer once into the new orientation, loop ids kept', () => {
    const before = part().loopsVersion ?? 0
    act(() => useCamStore.getState().updateGeometryTransform(PART, FLIPPED_POSITION, { x: 180, y: 0, z: 0 }))
    expect(part().loopsVersion).toBe(before + 1)
    expect(part().projectionStale).not.toBe(true)

    // Holes: world coordinates on a level world plane.
    const holes = layer('holes')
    expect(holes.frame).toBeUndefined()
    expect(holes.projectionPlane!.normal).toEqual({ x: 0, y: 0, z: 1 })
    const hole = holes.holes![0]
    expect(hole.loopId).toBe('hole-1')
    expect(hole.center[0]).toBeCloseTo(15, 9)
    expect(hole.center[1]).toBeCloseTo(30, 9)
    expect(hole.topZ).toBeCloseTo(PLATE, 9)
    expect(hole.bottomZ).toBeCloseTo(0, 9)
    expect(hole.through).toBe(true)

    // The top face is now the underside (world Z 0), mirrored in Y, still CCW.
    const face = layer('face')
    expect(face.projectionPlane!.origin.z).toBeCloseTo(0, 9)
    const rect = loop('top-face').points
    expect(signedArea(rect)).toBeCloseTo(200, 6)
    const ys = rect.map(p => p.y).sort((a, b) => a - b)
    expect(ys[0]).toBeCloseTo(25, 9)
    expect(ys[3]).toBeCloseTo(35, 9)

    // Nothing re-derives without a committed change: compute-time reads and a
    // zero-delta commit (click without moving) leave the layers alone.
    const settled = part().loopsVersion
    act(() => useCamStore.getState().updateGeometryTransform(PART, FLIPPED_POSITION, { x: 180, y: 0, z: 0 }))
    expect(part().loopsVersion).toBe(settled)

    // A move of the turned part re-derives once more, following it.
    act(() => useCamStore.getState().updateGeometryTransform(PART, { x: 5, y: 40, z: PLATE }, { x: 180, y: 0, z: 0 }))
    expect(part().loopsVersion).toBe(settled! + 1)
    expect(layer('holes').holes![0].center[0]).toBeCloseTo(20, 9)
  })

  it('turned back upright, the layers are the model-frame layers they started as', () => {
    const start = plate()
    act(() => useCamStore.getState().updateGeometryTransform(PART, FLIPPED_POSITION, { x: 180, y: 0, z: 0 }))
    act(() => useCamStore.getState().updateGeometryTransform(PART, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }))
    const holes = layer('holes')
    expect(holes.frame).toBe('geometry_local')
    expect(holes.projectionPlane!.origin.z).toBeCloseTo(PLATE, 9)
    const hole = holes.holes![0]
    expect(hole.center[0]).toBeCloseTo(15, 9)
    expect(hole.center[1]).toBeCloseTo(10, 9)
    expect(hole.topZ).toBeCloseTo(PLATE, 9)
    expect(hole.bottomZ).toBeCloseTo(0, 9)
    const rect = loop('top-face').points
    start.loops!.find(l => l.id === 'top-face')!.points.forEach((p, i) => {
      expect(rect[i].x).toBeCloseTo(p.x, 9)
      expect(rect[i].y).toBeCloseTo(p.y, 9)
    })
  })

  it('a real tilt leaves the features in model form and compute says why, with no re-import', async () => {
    const op = await createDrill()
    // The compute Create starts must finish before the tilt; otherwise its
    // late result lands after the recompute below and outdates the op.
    await waitFor(() => expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('ready'))
    act(() => useCamStore.getState().updateGeometryTransform(PART, { x: 0, y: 0, z: 0 }, { x: 30, y: 0, z: 0 }))
    expect(layer('holes').frame).toBe('geometry_local')
    const tilted = await recompute(op.id)
    evidence.tiltedError = tilted.errorMessage
    expect(tilted.status).toBe('error')
    expect(tilted.errorMessage).toContain('no longer face straight up')
    expect(tilted.errorMessage).not.toMatch(/re-import/i)
  }, 120_000)
})
