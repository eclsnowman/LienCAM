// @vitest-environment jsdom
//
// WO-1940, through the REAL op-picker: a V-carve takes its region from edges
// picked on a MODELED BODY and computes a real toolpath inside them, instead of
// refusing after the pick. A V-carve carves the area a CLOSED chain encloses,
// so an open chain is refused by name - never carved as a line.
//
// Every assertion runs through the surface the operator touches: render the
// real NewOperationModal, choose V-Carve and the modeled body, click "Pick
// edges", receive the viewport's pick callbacks, click Done, pick the V-bit,
// click Create, then read what the STORE persisted and what it posted to the
// toolpath worker. The worker stand-in runs the REAL V-carve engine
// (buildVCarveToolpath) on that payload and then the REAL tool-reach trim the
// production worker applies to every response (toolpathWorker.ts, WO-1565), so
// the moves compared below are what the app would store for that payload.
//
// THE COMPARISON: the same edges are also drawn as a sketch (a DXF-style
// curves_2d part carrying the same square) and V-carved the same way. The
// model-edge V-carve must cut the same XY path as the sketch V-carve.
//
// THE FIXTURE (the WO-1939 body): body F1 has a 40x40 outer border, a 10x10
// inner border and a two-segment open groove line on its top plane (Z 10). The
// whole-body outline is 40x40, so a chain dropped on the way to compute cannot
// pass for the picked 10x10 square.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  ImportedGeometry, Loop2D, ModelItemPlacementRecord, Operation, Setup,
} from '../../types'
import type { VCarveWorkerPayload } from '../../lib/cam/types'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { buildVCarveToolpath, ensureVCarveClipperReady } = await import('../../lib/cam/vcarve2d')
const { ensureClipperReady } = await import('../../lib/cam/face2d/clipperOffset')
const {
  checkHolderClearanceForToolpath, operationLabelForRequestType, trimToolpathToToolReach, wantsToolReachTrim,
} = await import('../../lib/cam/holderClearanceGate')

/** toolpathWorker.ts's response path, verbatim in effect: build, then trim to
 *  the tool's reach when the request carries the part/clearance/workholding. */
function runLikeTheWorker(type: string, payload: VCarveWorkerPayload): unknown[] {
  const moves = buildVCarveToolpath(payload)
  const p = payload as unknown as Record<string, never>
  if (wantsToolReachTrim(p)) {
    return [...trimToolpathToToolReach({
      operation: operationLabelForRequestType(type),
      moves, tool: payload.tool, holder: p.holder, stockBlock: p.stockBlock,
      clearancePart: p.clearancePart, remainingStock: p.remainingStock,
      noEarlierOperations: p.noEarlierOperations, clearanceAllowanceMm: p.clearanceAllowanceMm,
      workholding: p.workholding, wcsLabel: p.wcsLabel,
    }).moves]
  }
  const clearance = checkHolderClearanceForToolpath({
    operation: operationLabelForRequestType(type), moves, tool: payload.tool,
    holder: p.holder, stockBlock: p.stockBlock,
  })
  if (clearance.status === 'collision') throw new Error(clearance.message)
  return moves
}

interface Move { type: string; x?: number; y?: number; z?: number; role?: string }
interface CapturedRequest { type: string; payload: VCarveWorkerPayload & { opId: string } }
let workerRequests: CapturedRequest[] = []
class VCarveEngineWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(data: CapturedRequest): void {
    workerRequests.push(data)
    let response: unknown
    try {
      const moves = data.type === 'COMPUTE_VCARVE'
        ? runLikeTheWorker(data.type, data.payload)
        : [{ type: 'feed', x: 0, y: 0, z: -1, role: 'cut' }]
      response = { type: 'TOOLPATH_COMPLETE', opId: data.payload.opId, moves, computeTimeMs: 1 }
    } catch (err) {
      response = { type: 'TOOLPATH_ERROR', opId: data.payload.opId, error: (err as Error).message }
    }
    queueMicrotask(() => this.onmessage?.({ data: response }))
  }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
Object.defineProperty(globalThis, 'Worker', { value: VCarveEngineWorker, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const {
  modelBodyEdgeChainBindingCapability, modelEdgeChainAllowsOpenPaths,
  MODEL_EDGE_PICK_VIEWPORT_CAPABILITY, MODEL_EDGE_CHAIN_ROLE,
} = await import('../../store/modelEdgeChainBinding')

const MODEL_ID = 'modelbody:F1'
const SKETCH_ID = 'sketch-1'
const BODY_ID = 'F1'
const TOP_Z = 10
const OUTER_HALF = 20
const INNER_HALF = 5

const wedge = (a: string, b: string) => `(${[a, b].sort().join('∧')})`
const TOP_FACE = 'F1:BOX:zmax'
const SIDES = ['xmin', 'xmax', 'ymin', 'ymax']
const OUTER_EDGE_IDS = SIDES.map((s) => wedge(`F1:BOX:${s}`, TOP_FACE))
const INNER_EDGE_IDS = SIDES.map((s) => wedge(`F1:HOLE:${s}`, TOP_FACE))
const GROOVE_EDGE_IDS = ['a', 'b'].map((s) => wedge(`F1:GROOVE:${s}`, TOP_FACE))

interface Pt2 { x: number; y: number }
function squareCorners(halfSize: number): Pt2[] {
  return [
    { x: -halfSize, y: -halfSize }, { x: halfSize, y: -halfSize },
    { x: halfSize, y: halfSize }, { x: -halfSize, y: halfSize },
  ]
}
/** The open groove: (-15,10) -> (0,15) -> (15,10), two edges. */
const GROOVE: Pt2[] = [{ x: -15, y: 10 }, { x: 0, y: 15 }, { x: 15, y: 10 }]

function polylineEdges(pts: Pt2[], closed: boolean): number[][] {
  const count = closed ? pts.length : pts.length - 1
  return Array.from({ length: count }, (_, i) => {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    return [a.x, a.y, TOP_Z, b.x, b.y, TOP_Z]
  })
}
function packEdges(entries: Array<{ id: string; polyline: number[] }>) {
  const edgePositions: number[] = []
  const edgeOffsets: number[] = [0]
  const edgeIds: string[] = []
  for (const entry of entries) {
    edgePositions.push(...entry.polyline)
    edgeOffsets.push(edgePositions.length / 3)
    edgeIds.push(entry.id)
  }
  return { edgePositions, edgeOffsets, edgeIds }
}
/** Walls plus a solid TOP face at TOP_Z: the surface the V-carve cuts into. */
function wallMesh(halfSize: number) {
  const pts = squareCorners(halfSize)
  const positions: number[] = []
  const indices: number[] = []
  for (const p of pts) positions.push(p.x, p.y, 0, p.x, p.y, TOP_Z)
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    const b0 = 2 * i, t0 = 2 * i + 1, b1 = 2 * j, t1 = 2 * j + 1
    indices.push(b0, b1, t1, b0, t1, t0)
  }
  indices.push(1, 3, 5, 1, 5, 7, 0, 4, 2, 0, 6, 4)
  return { positions, indices }
}

const EDGE_TABLE = packEdges([
  ...polylineEdges(squareCorners(OUTER_HALF), true).map((polyline, i) => ({ id: OUTER_EDGE_IDS[i], polyline })),
  ...polylineEdges(squareCorners(INNER_HALF), true).map((polyline, i) => ({ id: INNER_EDGE_IDS[i], polyline })),
  ...polylineEdges(GROOVE, false).map((polyline, i) => ({ id: GROOVE_EDGE_IDS[i], polyline })),
])

const STOCK_ID = 'wo1940-stock'
const bbox = (min: [number, number, number], max: [number, number, number]) => ({
  min: { x: min[0], y: min[1], z: min[2] }, max: { x: max[0], y: max[1], z: max[2] },
  size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
  center: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
})

function modelBody(): ImportedGeometry {
  const mesh = wallMesh(OUTER_HALF)
  return {
    id: MODEL_ID, name: 'Model F1', type: 'model', format: 'model', filename: 'Model F1', loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: bbox([-OUTER_HALF, -OUTER_HALF, 0], [OUTER_HALF, OUTER_HALF, TOP_Z]),
    modelItemId: 'legacy',
    stockId: STOCK_ID,
    modelBody: {
      ref: { bodyId: BODY_ID, stableIds: [TOP_FACE], version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: EDGE_TABLE.edgePositions, edgeOffsets: EDGE_TABLE.edgeOffsets,
        bbox: { min: [-OUTER_HALF, -OUTER_HALF, 0], max: [OUTER_HALF, OUTER_HALF, TOP_Z] },
        faceIds: [TOP_FACE],
        triFace: new Array(mesh.indices.length / 3).fill(0),
        edgeIds: EDGE_TABLE.edgeIds,
      },
    },
  } as unknown as ImportedGeometry
}

/** The SAME square drawn as a sketch: a flat curves_2d part at the body's top. */
function sketch(): ImportedGeometry {
  return {
    id: SKETCH_ID, name: 'Sketch of the edges', filename: 'sketch.dxf',
    type: 'curves_2d', format: 'dxf', loaded: true,
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: bbox([-INNER_HALF, -INNER_HALF, TOP_Z], [INNER_HALF, INNER_HALF, TOP_Z]),
    stockId: STOCK_ID,
    loops: [{
      id: 'sketch-square', layerId: 'sketch-layer', closed: true, type: 'contour',
      points: squareCorners(INNER_HALF), area: (2 * INNER_HALF) ** 2,
    }],
    layers2d: [{ id: 'sketch-layer', name: 'Sketch', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry
}

function seedProject() {
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: STOCK_ID,
    },
    defaultHeightIntent: {
      ...defaultHeightIntent(),
      clearance: { reference: 'retract', offset: 22, provenance: 'user' },
    },
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 10,
      offsetX: 2, offsetY: 2, offsetZTop: 0, offsetZBottom: 0, material: 'al',
    },
    operations: [], notes: '',
  } as unknown as Setup
  const modelItemPlacements: ModelItemPlacementRecord[] = [
    { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
  ]
  const current = useCamStore.getState()
  useCamStore.setState({
    project: {
      ...current.project,
      geometry: [modelBody(), sketch()],
      stocks: [{
        id: STOCK_ID, name: 'Stock', mode: 'explicit' as const,
        bounds: bbox([-50, -50, 0], [50, 50, TOP_Z]),
        position: { x: -50, y: -50, z: 0 },
      }],
      setups: [setup], activeSetupId: setup.id, modelItemPlacements,
    },
    toolLibrary: [{
      id: 'vbit-90', name: 'VBIT90', type: 'v_bit', diameter: 6,
      tipDiameter: 0, angleFromAxisDeg: 45,
      fluteLength: 10, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
    } as never],
  })
}

type PickCallback = (
  sel: { geoId: string; kind: 'face' | 'edge'; index: number; isModelEdge?: boolean },
  nowSelected: boolean,
) => void
let capturedPickCallback: PickCallback | null = null

function stubViewport() {
  capturedPickCallback = null
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    clearScene: vi.fn(),
    rebuildStock: vi.fn(),
    setPartPickMode: vi.fn(),
    setSelectedPart: vi.fn(),
    setPickedLoops: vi.fn(),
    setPickedBrepSelections: vi.fn(),
    setBrepPickMode: vi.fn((kind: string | null, cb?: PickCallback | null) => {
      capturedPickCallback = kind !== null && cb ? cb : null
    }),
    [MODEL_EDGE_PICK_VIEWPORT_CAPABILITY]: () => true,
  }
}

beforeAll(async () => {
  await ensureVCarveClipperReady()
  await ensureClipperReady()
})
beforeEach(() => {
  workerRequests = []
  act(() => { useCamStore.getState().newProject() })
  stubViewport()
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

function openWizard(opLabel: string, geoId: string) {
  render(createElement(NewOperationModal))
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText(opLabel))
  fireEvent.click(screen.getByText('Geometry'))
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: geoId } })
}
function pickEdges(ids: readonly string[]) {
  fireEvent.click(screen.getByTestId('model-pick-edges'))
  expect(capturedPickCallback).not.toBeNull()
  for (const id of ids) {
    const index = EDGE_TABLE.edgeIds.indexOf(id)
    act(() => { capturedPickCallback!({ geoId: MODEL_ID, kind: 'edge', index, isModelEdge: true }, true) })
  }
  fireEvent.click(screen.getByTestId('model-edges-done'))
}
function createButton(): HTMLButtonElement {
  return screen.getByTestId('op-create') as HTMLButtonElement
}
async function createVCarve() {
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText('VBIT90'))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(screen.getByTestId('vcarve-height-policy')).toBeTruthy())
  await waitFor(() => {
    expect(createButton().disabled, `Create disabled: ${createButton().getAttribute('data-tooltip')}`).toBe(false)
  })
  const before = useCamStore.getState().project.setups[0].operations.length
  fireEvent.click(createButton())
  await waitFor(() => {
    expect(useCamStore.getState().project.setups[0].operations).toHaveLength(before + 1)
  })
}
const ops = (): Operation[] => useCamStore.getState().project.setups[0].operations
async function waitReady(opId: string): Promise<Operation> {
  await waitFor(() => {
    const op = ops().find((o) => o.id === opId)!
    expect(op.status, `errorMessage: ${op.errorMessage}`).toBe('ready')
  })
  return ops().find((o) => o.id === opId)!
}
function vcarveRequestFor(opId: string): CapturedRequest {
  const request = [...workerRequests].reverse().find((r) => r.payload.opId === opId)
  expect(request, `no toolpath worker request for ${opId}`).toBeTruthy()
  expect(request!.type).toBe('COMPUTE_VCARVE')
  return request!
}
const key = (x: number, y: number) => `${x.toFixed(3)},${y.toFixed(3)}`
/** Every XY the engine CUTS through (feed moves with role 'cut'). */
function cutXY(moves: readonly Move[]): Set<string> {
  return new Set(
    moves.filter((m) => m.type === 'feed' && m.role === 'cut' && m.x !== undefined && m.y !== undefined)
      .map((m) => key(m.x!, m.y!)),
  )
}
function toolpathOf(op: Operation): Move[] {
  return (op.toolpathMoves ?? []) as unknown as Move[]
}

describe('WO-1940: the edge-chain capability covers V-carve', () => {
  it('V-carve now binds a picked model edge chain; Thread-mill still refuses by name', () => {
    for (const opType of ['contour_2d', 'pocket_2d', 'adaptive_clearing_2d', 'engrave', 'vcarve'] as const) {
      expect(modelBodyEdgeChainBindingCapability(opType)).toEqual({ supported: true, reason: '' })
    }
    // WO-1941 moved Chamfer to the supported side (chamferModelEdge.wo1941.test.ts).
    for (const opType of ['thread_mill'] as const) {
      const capability = modelBodyEdgeChainBindingCapability(opType)
      expect(capability.supported).toBe(false)
      expect(capability.reason).toContain(opType)
    }
  })

  it('a V-carve chain must close; Engrave still follows open paths', () => {
    expect(modelEdgeChainAllowsOpenPaths('vcarve')).toBe(false)
    expect(modelEdgeChainAllowsOpenPaths('engrave')).toBe(true)
    expect(modelEdgeChainAllowsOpenPaths('contour_2d')).toBe(false)
  })
})

describe('WO-1940: a V-carve follows edges picked on a modeled body', () => {
  it('offers Pick edges for V-carve on a modeled body and names what it bound', () => {
    seedProject()
    openWizard('V-Carve', MODEL_ID)
    expect(screen.getByTestId('model-edge-readout').textContent).toContain('region to carve')
    pickEdges(INNER_EDGE_IDS)
    expect(screen.queryByTestId('model-edge-pick-error')).toBeNull()
    expect(screen.queryByTestId('model-edge-chain-dropped')).toBeNull()
    expect(screen.getByTestId('model-edge-readout').textContent).toBe('4 edge(s) bound as this V-carve region.')
  })

  it('a closed chain computes ready and cuts the same XY path as the same edges drawn in a sketch', async () => {
    seedProject()
    openWizard('V-Carve', MODEL_ID)
    pickEdges(INNER_EDGE_IDS)
    await createVCarve()

    const created = ops()[0]
    expect(created.type).toBe('vcarve')
    expect(created.modelReferences).toEqual([{
      bodyId: BODY_ID, modelItemId: 'legacy', stableIds: INNER_EDGE_IDS, role: MODEL_EDGE_CHAIN_ROLE,
    }])
    const op = await waitReady(created.id)

    const request = vcarveRequestFor(op.id)
    const sent: Loop2D[] = request.payload.loops as unknown as Loop2D[]
    const carved = sent.filter((loop) =>
      (request.payload.params.loopIds.length === 0 || request.payload.params.loopIds.includes(loop.id)) && loop.closed)
    expect(carved).toHaveLength(1)
    const xs = carved[0].points.map((p) => p.x), ys = carved[0].points.map((p) => p.y)
    // The 10x10 inner border - not the 40x40 whole-body outline.
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(2 * INNER_HALF, 3)
    expect(Math.max(...ys) - Math.min(...ys)).toBeCloseTo(2 * INNER_HALF, 3)

    const moves = toolpathOf(op)
    const modelCuts = cutXY(moves)
    expect(modelCuts.size).toBeGreaterThan(0)
    // Every cut stays inside the 10x10 region it carves.
    for (const k of modelCuts) {
      const [x, y] = k.split(',').map(Number)
      expect(Math.abs(x) <= INNER_HALF + 1e-3 && Math.abs(y) <= INNER_HALF + 1e-3, k).toBe(true)
    }
    // It is a carve, not a trace: it goes below the top surface.
    const cutZ = moves.filter((m) => m.type === 'feed' && m.role === 'cut').map((m) => m.z!)
    expect(Math.min(...cutZ)).toBeLessThan(TOP_Z - 0.5)

    // And it is the sketch's path: the same square drawn in a sketch, V-carved
    // through the same wizard, cuts the same XY set.
    cleanup()
    stubViewport()
    openWizard('V-Carve', SKETCH_ID)
    fireEvent.click(screen.getByRole('button', { name: /All loops/ }))
    await createVCarve()
    const sketchOp = await waitReady(ops()[ops().length - 1].id)
    const drawn = cutXY(toolpathOf(sketchOp))
    expect(drawn.size).toBeGreaterThan(0)
    expect([...modelCuts].sort()).toEqual([...drawn].sort())
  })

  it('an open chain is refused by name - never carved as a line', () => {
    seedProject()
    openWizard('V-Carve', MODEL_ID)
    pickEdges(GROOVE_EDGE_IDS)
    const error = screen.getByTestId('model-edge-pick-error').textContent ?? ''
    expect(error).toMatch(/do not form a closed chain/)
    expect(error).toMatch(/A V-carve needs a closed region/)
    // Nothing was bound, so nothing can be saved as a carve of the line.
    expect(screen.getByTestId('model-edge-readout').textContent).toContain('No edges picked yet')
  })

  it('Engrave still takes the same open chain as an open path', () => {
    seedProject()
    openWizard('Engrave / Trace', MODEL_ID)
    pickEdges(GROOVE_EDGE_IDS)
    expect(screen.queryByTestId('model-edge-pick-error')).toBeNull()
    expect(screen.getByTestId('model-edge-readout').textContent).toBe('2 edge(s) bound as this engrave path.')
  })
})
