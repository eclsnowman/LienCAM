// @vitest-environment jsdom
//
// WO-2996: Contour's closed rough/finish offsets go through the kernel geometry
// service (face compatibility profile) and nothing that is cut changes.
//
// Application route: the Contour is created in the New Operation dialog, its
// cases are set through the store's updateOperation, computed through
// computeOperationToolpath on the production toolpath worker (in-process), and
// posted through postProject with the UCCNC post. The only instrumentation is a
// pass-through recorder around the face clipper module's offsetLoop (every ring
// in and out) and around createGeometryService (which caller asked for which
// offset). Neither changes a value.
//
// The golden src/tests/evidence/WO-2996/contour-before.json was recorded at the
// starter commit (direct offsetLoop calls) with WO2996_RECORD=1; this file then
// checks the migrated source against it: identical offset calls and rings,
// identical moves, identical posted G-code, identical errors.

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry, Operation, PhysicalStock, Setup, Tool } from '../../types'
import { typedMock } from '../support/typedMock'

const memory = new Map<string, string>()
const storage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: key => memory.get(key) ?? null,
  key: index => Array.from(memory.keys())[index] ?? null,
  removeItem: key => { memory.delete(key) },
  setItem: (key, value) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true })

type Pt = { x: number; y: number }
interface OffsetCall { input: Pt[]; delta: number; minArea: number | undefined; output?: Pt[][]; error?: string }
const recorder = vi.hoisted(() => ({ calls: [] as unknown[], serviceOffsets: [] as string[], nativeError: null as Error | null }))

vi.mock('../../lib/cam/face2d/clipperOffset', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/cam/face2d/clipperOffset')>()
  return typedMock<typeof import('../../lib/cam/face2d/clipperOffset')>({
    ...real,
    offsetLoop: (loop: Pt[], delta: number, minArea?: number) => {
      const call: OffsetCall = { input: loop.map(p => ({ x: p.x, y: p.y })), delta, minArea }
      recorder.calls.push(call)
      try {
        if (recorder.nativeError) throw recorder.nativeError
        const output = real.offsetLoop(loop, delta, minArea)
        call.output = output.map(ring => ring.map(p => ({ x: p.x, y: p.y })))
        return output
      } catch (error) {
        call.error = error instanceof Error ? error.message : String(error)
        throw error
      }
    },
  })
})
vi.mock('../../kernel/geometry', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../kernel/geometry')>()
  return typedMock<typeof import('../../kernel/geometry')>({
    ...real,
    createGeometryService: backend => {
      const service = real.createGeometryService(backend)
      return {
        ...service,
        offset: (paths, delta, options) => {
          recorder.serviceOffsets.push(`${backend.profile.id}:${paths.map(p => (p.closed ? 'closed' : 'open')).join(',')}`)
          return service.offset(paths, delta, options)
        },
      }
    },
  })
})
const { deriveCylinders } = vi.hoisted(() => ({ deriveCylinders: vi.fn().mockResolvedValue([]) }))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', async (importOriginal) => typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
  ...(await importOriginal<typeof import('../../lib/cam/geometry/occt/model/modelClient')>()),
  deriveCylinders,
}))

// The production toolpath worker, run in this thread (WO-1610's harness).
const workerScope: {
  onmessage: ((event: MessageEvent) => unknown) | null
  postMessage: (data: unknown) => void
  location: Location
} = { onmessage: null, postMessage: () => {}, location: window.location }
const realSelf = globalThis.self
vi.stubGlobal('self', workerScope)
await import('../../lib/cam/toolpathWorker')
let activeWorker: { onmessage: ((event: MessageEvent) => void) | null } | null = null
workerScope.postMessage = data => activeWorker?.onmessage?.({ data } as MessageEvent)
class InProcessToolpathWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage(data: unknown): void {
    activeWorker = this
    void workerScope.onmessage?.({ data } as MessageEvent)
  }
  terminate(): void { /* in-process */ }
}

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { postProject } = await import('../../lib/post/postProject')
const { UCCNC_CONFIG } = await import('../../lib/post/dialects/uccnc')
const { createGeometryService, faceAdapter, selfIntersects } = await import('../../kernel/geometry')
const faceClipper = await import('../../lib/cam/face2d/clipperOffset')

const STARTER_GOLDEN = 'src/tests/evidence/WO-2996/contour-before.json'
// Full-revision bisect: 219165a483fc6ff0a19e10bc148dd809ea72198c
// (WO-3123) intentionally changed post start/restart framing. Keep the
// starter's exact cut/offset/error invariants alongside the new full post pin.
const GOLDEN = 'src/tests/evidence/WO-3213/contour-approved-approach.json'
const RECORD = process.env.WO2996_RECORD === '1'

const stock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 180, y: 120, z: 20 },
    size: { x: 180, y: 120, z: 20 }, center: { x: 90, y: 60, z: 10 },
  },
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const endMill = {
  id: 'tool-flat', name: 'Flat 6mm', type: 'flat_end_mill', diameter: 6,
  fluteLength: 25, shankDiameter: 6, overallLength: 60, numberOfFlutes: 2,
} as unknown as Tool

const square = (x: number, y: number, w: number, h: number): Pt[] =>
  [{ x, y }, { x: x + w, y }, { x: x + w, y: y + h }, { x, y: y + h }]
const area = (points: Pt[]) => Math.abs(points.reduce((sum, a, i) => {
  const b = points[(i + 1) % points.length]
  return sum + a.x * b.y - b.x * a.y
}, 0)) / 2
const loop = (id: string, points: Pt[]) => ({ id, layerId: 'layer-0', closed: true, type: 'contour', area: area(points), points })
// Sketch-local loops; the sketch sits at (10, 10) on a 180 x 120 stock.
const loops = [
  loop('ccw-rect', square(0, 0, 30, 20)),
  loop('cw-rect', [...square(40, 0, 30, 20)].reverse()),
  loop('concave-l', [{ x: 80, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 10 }, { x: 90, y: 10 }, { x: 90, y: 40 }, { x: 80, y: 40 }]),
  loop('island-outer', square(0, 30, 50, 50)),
  loop('island-inner', square(15, 45, 20, 20)),
  // Two 20 mm pads joined by a 4 mm neck: a 6 mm cutter inside pinches it in two.
  loop('dumbbell', [{ x: 60, y: 50 }, { x: 80, y: 50 }, { x: 80, y: 58 }, { x: 100, y: 58 }, { x: 100, y: 50 },
    { x: 120, y: 50 }, { x: 120, y: 70 }, { x: 100, y: 70 }, { x: 100, y: 62 }, { x: 80, y: 62 }, { x: 80, y: 70 }, { x: 60, y: 70 }]),
  // Smaller than the cutter: the inside offset collapses.
  loop('tiny', square(140, 0, 4, 4)),
  // A slanted, many-sided concave star (non-axis-aligned edges and round joins).
  loop('star', Array.from({ length: 14 }, (_, i) => {
    const r = i % 2 ? 7 : 16, a = (i * Math.PI) / 7 + 0.1
    return { x: 145 + r * Math.cos(a), y: 70 + r * Math.sin(a) }
  })),
  // Invalid closed geometry: too few points for a region.
  loop('two-point', [{ x: 130, y: 20 }, { x: 150, y: 25 }]),
]
const sketch = {
  id: 'sketch', name: 'Sketch', filename: 'Sketch.dxf', type: 'curves_2d', format: 'dxf',
  loaded: true, stockId: stock.id, loopsVersion: 1,
  position: { x: 10, y: 10, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 165, y: 90, z: 0 }, size: { x: 165, y: 90, z: 0 }, center: { x: 82.5, y: 45, z: 0 } },
  loops,
  layers2d: [{ id: 'layer-0', name: '0', color: '#fff', visible: true }],
} as unknown as ImportedGeometry

interface Case {
  name: string
  loopIds: string[]
  side: 'outer' | 'inner'
  direction: 'climb' | 'conventional'
  stockToLeave: number
  finishPasses: number
  contourFinishMode?: 'final' | 'each_stepdown'
  /** The native offset throws this (a WASM fault) - it must reach the operation as today. */
  nativeError?: string
}
const CASES: Case[] = [
  { name: 'outer climb rough+finish: CCW, CW, concave', loopIds: ['ccw-rect', 'cw-rect', 'concave-l'], side: 'outer', direction: 'climb', stockToLeave: 0.5, finishPasses: 1 },
  { name: 'outer conventional finish only: CCW, CW, concave', loopIds: ['ccw-rect', 'cw-rect', 'concave-l'], side: 'outer', direction: 'conventional', stockToLeave: 0, finishPasses: 1 },
  { name: 'inner climb rough+finish: CW, concave, island ring', loopIds: ['cw-rect', 'concave-l', 'island-outer'], side: 'inner', direction: 'climb', stockToLeave: 0.4, finishPasses: 1 },
  { name: 'outer around the island', loopIds: ['island-inner'], side: 'outer', direction: 'climb', stockToLeave: 0.3, finishPasses: 1, contourFinishMode: 'each_stepdown' },
  { name: 'inner pinch splits into two regions', loopIds: ['dumbbell'], side: 'inner', direction: 'climb', stockToLeave: 0.5, finishPasses: 1 },
  { name: 'outer concave star rough only', loopIds: ['star'], side: 'outer', direction: 'conventional', stockToLeave: 1.2, finishPasses: 0 },
  { name: 'inner concave star', loopIds: ['star'], side: 'inner', direction: 'climb', stockToLeave: 0.25, finishPasses: 1 },
  { name: 'inner collapse on a loop smaller than the cutter', loopIds: ['tiny'], side: 'inner', direction: 'climb', stockToLeave: 0.5, finishPasses: 1 },
  { name: 'outer on a two-point closed loop (invalid region)', loopIds: ['two-point'], side: 'outer', direction: 'climb', stockToLeave: 0.5, finishPasses: 1 },
  { name: 'inner on a two-point closed loop (invalid region)', loopIds: ['two-point'], side: 'inner', direction: 'climb', stockToLeave: 0, finishPasses: 1 },
  { name: 'native offset exception reaches the operation', loopIds: ['ccw-rect'], side: 'outer', direction: 'climb', stockToLeave: 0.5, finishPasses: 1, nativeError: 'clipper2 aborted (WO-2996 fixture fault)' },
]

const sha = (value: unknown) => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex')

interface CaseResult {
  name: string
  errorMessage: string
  moveCount: number
  movesSha: string
  gcodeSha: string | null
  gcodeLines: number
  offsetCalls: Array<{ inputSha: string; delta: number; minArea: number | undefined; rings: number[]; outputSha: string | null; error?: string }>
}

let operationId = ''
const results: CaseResult[] = []
const serviceRoutes: string[][] = []

function seed(): void {
  const setup = {
    id: 'setup-1', name: 'Setup 1', notes: '', operations: [],
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id, originBinding: { kind: 'stock_corner', stockId: stock.id, cornerIndex: 0 },
    },
    stock: null,
  } as unknown as Setup
  const state = useCamStore.getState()
  useCamStore.setState({
    toolLibrary: [endMill],
    project: { ...state.project, setups: [setup], activeSetupId: setup.id, stocks: [stock], geometry: [sketch] },
  } as never)
}

async function runCase(c: Case): Promise<CaseResult> {
  const before = useCamStore.getState().project.setups[0].operations.find(op => op.id === operationId)!
  act(() => useCamStore.getState().updateOperation('setup-1', operationId, {
    params: { ...before.params, loopIds: c.loopIds, side: c.side, direction: c.direction, tabs: false, contourFinishMode: c.contourFinishMode },
    passes: { ...before.passes, stockToLeave: c.stockToLeave, finishPasses: c.finishPasses },
  } as Partial<Operation>))
  recorder.calls.length = 0
  recorder.serviceOffsets.length = 0
  recorder.nativeError = c.nativeError ? new Error(c.nativeError) : null
  try {
    await act(() => useCamStore.getState().computeOperationToolpath('setup-1', operationId))
  } finally {
    recorder.nativeError = null
  }
  const state = useCamStore.getState()
  const operation = state.project.setups[0].operations.find(op => op.id === operationId)!
  const moves = operation.toolpathMoves ?? []
  let gcode: string | null = null
  if (!operation.errorMessage && moves.length) {
    const posted = postProject({ ...state.project, toolLibrary: state.toolLibrary }, state.project.setups, UCCNC_CONFIG,
      { mode: 'combined', pauseBetweenSetups: false, baseName: 'part', ext: 'nc' })
    gcode = posted.combined?.gcode ?? null
  }
  serviceRoutes.push([...recorder.serviceOffsets])
  return {
    name: c.name,
    errorMessage: operation.errorMessage ?? '',
    moveCount: moves.length,
    movesSha: sha(moves),
    gcodeSha: gcode === null ? null : sha(gcode),
    gcodeLines: gcode === null ? 0 : gcode.split('\n').length,
    offsetCalls: (recorder.calls as OffsetCall[]).map(call => ({
      inputSha: sha(call.input), delta: call.delta, minArea: call.minArea,
      rings: call.output?.map(ring => ring.length) ?? [], outputSha: call.output ? sha(call.output) : null,
      ...(call.error ? { error: call.error } : {}),
    })),
  }
}

beforeAll(async () => {
  ;(globalThis as { Worker?: unknown }).Worker = InProcessToolpathWorker
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 180, y: 120, z: 20 } }),
  }
  await faceClipper.ensureClipperReady()
  act(() => useCamStore.getState().newProject())
  act(() => useCamStore.getState().closeModal())
  seed()
  render(createElement(NewOperationModal))
  act(() => useCamStore.getState().openModal('new-operation'))
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText(endMill.name))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: sketch.id } })
  fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
  const create = screen.getByTestId('op-create') as HTMLButtonElement
  await waitFor(() => expect(create.disabled).toBe(false))
  fireEvent.click(create)
  await waitFor(() => expect(useCamStore.getState().project.setups[0].operations.length).toBe(1))
  const operation = useCamStore.getState().project.setups[0].operations[0]
  expect(operation.type).toBe('contour_2d')
  operationId = operation.id
  // WO-3213: Create starts a real asynchronous computation. Finish it before
  // changing the first case; the single in-process worker recorder models
  // sequential cases, not two concurrent requests sharing one message sink.
  await waitFor(() => expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('ready'))
  cleanup()
  for (const c of CASES) results.push(await runCase(c))
  if (RECORD) {
    mkdirSync('src/tests/evidence/WO-3213', { recursive: true })
    writeFileSync(GOLDEN, JSON.stringify({
      source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      command: 'WO2996_RECORD=1 WRITE_EVIDENCE=1 npx vitest run src/tests/cam/contourGeometryService.wo2996.test.ts',
      entry: 'NewOperationModal create -> updateOperation -> computeOperationToolpath (in-process toolpath worker) -> postProject UCCNC',
      cases: results,
    }, null, 1) + '\n')
  }
}, 600_000)

afterAll(() => {
  vi.stubGlobal('self', realSelf)
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-2996 Contour closed offsets through the kernel geometry service', () => {
  const golden = () => JSON.parse(readFileSync(GOLDEN, 'utf8')) as { source: string; cases: CaseResult[] }

  it('the cases cut, split, collapse and refuse as designed (the fixtures exercise every branch)', () => {
    const by = (name: string) => results.find(r => r.name.startsWith(name))!
    expect(by('outer climb').moveCount).toBeGreaterThan(0)
    expect(by('outer climb').gcodeSha).not.toBeNull()
    expect(by('inner pinch').offsetCalls.some(call => call.rings.length === 2)).toBe(true)
    expect(by('inner collapse').offsetCalls.some(call => call.rings.length === 0)).toBe(true)
    expect(results.flatMap(r => r.offsetCalls).every(call => call.minArea === 0.01)).toBe(true)
    expect(by('native offset exception').errorMessage).toContain('clipper2 aborted (WO-2996 fixture fault)')
    expect(by('native offset exception').moveCount).toBe(0)
  })

  it('offsets, moves and errors match the starter; G-code matches the approved WO-3123 approach', () => {
    const before = golden()
    expect(before.cases.map(c => c.name)).toEqual(CASES.map(c => c.name))
    const starter = JSON.parse(readFileSync(STARTER_GOLDEN, 'utf8')) as { cases: CaseResult[] }
    const cutInvariants = (cases: CaseResult[]) => cases.map(c => ({ ...c, gcodeSha: null, gcodeLines: 0 }))
    expect(cutInvariants(results)).toEqual(cutInvariants(starter.cases))
    expect(results).toEqual(before.cases)
  })

  it('every closed rough/finish offset reaches the native face offset through the service', () => {
    // One service offset (face profile, one closed path) per native offset call:
    // nothing on Contour's closed route reaches offsetLoop around the service.
    for (const [index, result] of results.entries()) {
      const routed = serviceRoutes[index]
      expect(routed.every(route => route === 'face:closed'), result.name).toBe(true)
      expect(routed.length, result.name).toBe(result.offsetCalls.length)
    }
  })

  it('zero and nonzero delta through the facade equal the direct call (facade control)', () => {
    const service = createGeometryService(faceAdapter(faceClipper))
    const ring = square(0, 0, 10, 10)
    expect(service.offset([{ id: 'z', closed: true, points: ring }], 0, { minArea: 0.01 }).value)
      .toEqual(faceClipper.offsetLoop(ring, 0, 0.01))
    expect(service.offset([{ id: 'r', closed: true, points: ring }], -1, { minArea: 0.01 }).value)
      .toEqual(faceClipper.offsetLoop(ring, -1, 0.01))
  })
})

// The service checks every closed path for self-crossing before it offsets. The
// pruned sweep must answer exactly what the full pair scan answered.
function pairScanSelfIntersects(input: Pt[]): boolean {
  const cross = (a: Pt, b: Pt, p: Pt) => (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x)
  const on = (a: Pt, b: Pt, p: Pt) => cross(a, b, p) === 0 && p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x)
    && p.y >= Math.min(a.y, b.y) && p.y <= Math.max(a.y, b.y)
  const first = input[0], last = input[input.length - 1]
  const loop = first && last && first.x === last.x && first.y === last.y ? input.slice(0, -1) : input
  const n = loop.length
  for (let i = 0; i < n; i++) {
    const a = loop[i], b = loop[(i + 1) % n]
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue
      const c = loop[j], d = loop[(j + 1) % n]
      if (on(a, b, c) || on(a, b, d) || on(c, d, a) || on(c, d, b)) return true
      if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return true
    }
  }
  return false
}

describe('WO-2996 the service self-crossing check answers as the full pair scan', () => {
  it('matches on random, grid-snapped, simple, touching and explicitly closed loops', () => {
    let seed = 2996
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647
    const shapes: Pt[][] = loops.map(l => l.points)
    for (let k = 0; k < 400; k++) {
      const n = 3 + Math.floor(random() * 12)
      // Grid snapping makes exact touches, shared vertices and collinear overlaps common.
      const snap = k % 2 === 0
      shapes.push(Array.from({ length: n }, () => ({
        x: snap ? Math.round(random() * 6) : random() * 100, y: snap ? Math.round(random() * 6) : random() * 100,
      })))
    }
    for (let k = 0; k < 40; k++) {
      const n = 20 + Math.floor(random() * 200)
      const ring = Array.from({ length: n }, (_, i) => ({ x: 30 * Math.cos((2 * Math.PI * i) / n), y: 30 * Math.sin((2 * Math.PI * i) / n) }))
      if (k % 4 === 1) ring.push({ ...ring[0] })
      if (k % 4 === 2) ring[Math.floor(n / 2)] = { x: 30, y: 0 } // reaches back to the first vertex
      if (k % 4 === 3) ring.splice(3, 0, { x: -30, y: 0.5 })    // a spike across the ring
      shapes.push(ring)
    }
    const answers = shapes.map(shape => [selfIntersects(shape), pairScanSelfIntersects(shape)])
    expect(answers.filter(([fast, full]) => fast !== full)).toEqual([])
    expect(answers.filter(([, full]) => full).length).toBeGreaterThan(50)
    expect(answers.filter(([, full]) => !full).length).toBeGreaterThan(50)
  })

  it('stays fast on a dense 20 000-point loop', () => {
    const n = 20000
    const ring = Array.from({ length: n }, (_, i) => ({ x: 50 * Math.cos((2 * Math.PI * i) / n), y: 50 * Math.sin((2 * Math.PI * i) / n) }))
    const started = performance.now()
    expect(selfIntersects(ring)).toBe(false)
    expect(performance.now() - started).toBeLessThan(1000)
  })
})
