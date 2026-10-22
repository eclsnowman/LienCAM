// @vitest-environment jsdom
//
// WO-3055 (rule 11): the Properties Heights line of an operation whose geometry
// is a MODELED BODY previews through the same model-origin resolver compute
// uses. Before this order the preview resolved sources with
// resolveOpGeometrySources, which drops every format:'model' row, so a ready
// model-body Chamfer showed "Chamfer edge loop 'modelbody:...' no longer exists
// in the selected geometry scope" while the op computed ready and cut.
//
// Chamfer runs through the REAL op-picker (the WO-1941 fixture: body F1 with a
// 10x10 inner edge loop), then the store previews the op it saved. Drill is a
// store-level op on a modeled body that carries a detected-hole snapshot.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildDrillBoreSmartHeightIntent, deriveDrillBoreFeatureBindings } from '../../lib/cam/smartHeights'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  ImportedGeometry, ModelItemPlacementRecord, Operation, Setup,
} from '../../types'
import type { ChamferWorkerPayload } from '../../lib/cam/types'

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

const { buildChamferToolpath } = await import('../../lib/cam/chamfer2d')
const {
  checkHolderClearanceForToolpath, operationLabelForRequestType, trimToolpathToToolReach, wantsToolReachTrim,
} = await import('../../lib/cam/holderClearanceGate')

/** toolpathWorker.ts's response path, verbatim in effect: build, then trim to
 *  the tool's reach when the request carries the part/clearance/workholding. */
function runLikeTheWorker(type: string, payload: ChamferWorkerPayload): unknown[] {
  const moves = buildChamferToolpath(payload)
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

interface CapturedRequest { type: string; payload: ChamferWorkerPayload & { opId: string } }
let workerRequests: CapturedRequest[] = []
class ChamferEngineWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(data: CapturedRequest): void {
    workerRequests.push(data)
    let response: unknown
    try {
      const moves = data.type === 'COMPUTE_CHAMFER'
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
Object.defineProperty(globalThis, 'Worker', { value: ChamferEngineWorker, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const { MODEL_EDGE_PICK_VIEWPORT_CAPABILITY } = await import('../../store/modelEdgeChainBinding')

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
/** Walls plus a solid TOP face at TOP_Z: the part whose edges are chamfered. */
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

const STOCK_ID = 'wo3055-stock'
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

/** The SAME square drawn as a sketch: a flat curves_2d part placed ON the
 *  body's top (Z 10), so its "geometry face" datum is the plane the picked
 *  edges lie on - the like-for-like sketch a chamfer of those edges needs. */
function sketch(): ImportedGeometry {
  return {
    id: SKETCH_ID, name: 'Sketch of the edges', filename: 'sketch.dxf',
    type: 'curves_2d', format: 'dxf', loaded: true,
    position: { x: 0, y: 0, z: TOP_Z }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: bbox([-INNER_HALF, -INNER_HALF, 0], [INNER_HALF, INNER_HALF, 0]),
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
      id: 'chamfer-90', name: 'CHAMFER90', type: 'chamfer_mill', diameter: 6,
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
async function createChamfer() {
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText('CHAMFER90'))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => expect(screen.getByTestId('chamfer-height-policy')).toBeTruthy())
  await waitFor(() => {
    expect(createButton().disabled, `Create disabled: ${createButton().getAttribute('data-tooltip')} / ` +
      `${screen.getByTestId('chamfer-height-policy').textContent}`).toBe(false)
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


function drillBody(): ImportedGeometry {
  const circle = Array.from({ length: 32 }, (_, i) => {
    const a = 2 * Math.PI * i / 32
    return { x: 10 + 3 * Math.cos(a), y: 10 + 3 * Math.sin(a) }
  })
  return {
    ...modelBody(),
    loops: [{ id: DRILL_LOOP, layerId: 'holes', points: circle, closed: true, type: 'contour', area: Math.PI * 9 }],
    layers2d: [{
      id: 'holes', name: 'Holes', color: '#fff', visible: true, frame: 'geometry_local',
      holes: [{ center: [10, 10], diameter: 6, topZ: TOP_Z, bottomZ: 4, through: false, loopId: DRILL_LOOP }],
    }],
  } as unknown as ImportedGeometry
}

function drillOperation(body: ImportedGeometry): Operation {
  const derived = deriveDrillBoreFeatureBindings([body], [DRILL_LOOP], 'drill')
  if (!derived.ok) throw new Error(derived.refusals[0].message)
  const safety = {
    clearance: { reference: 'wcs_plane', offset: 30, provenance: 'user' },
    retract: { reference: 'wcs_plane', offset: 25, provenance: 'user' },
    feed: { reference: 'wcs_plane', offset: 22, provenance: 'user' },
  } as never
  return {
    id: 'drill-1', name: 'Drill 1', type: 'drill', enabled: true, status: 'pending',
    toolId: 'drill-tool', geometrySelections: [DRILL_LOOP],
    heights: {
      clearanceHeight: -999, clearanceHeightMode: 'absolute',
      retractHeight: -999, feedHeight: -999,
      topHeight: -999, topHeightMode: 'absolute',
      bottomHeight: -999, bottomHeightMode: 'absolute',
    },
    smartHeight: {
      kind: 'smart_v2',
      intent: buildDrillBoreSmartHeightIntent({
        operationType: 'drill', setupId: 'setup-1', safetyIntent: safety, mode: 'detected_features',
        features: derived.bindings.map((binding) => ({
          loopId: binding.loopId, feature: binding.feature,
          topMachineMm: binding.topMm + body.position.z, floorMachineMm: binding.floorMm + body.position.z,
          fingerprint: binding.evidenceFingerprint,
        })),
      }),
    },
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {
      entryType: 'plunge', rampAngle: 0, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params: {
      geometryId: body.id, loopIds: [DRILL_LOOP], cycleType: 'simple', peckDepth: 2, chipBreakRetract: 1,
      dwell: 0, retractMode: 'retract', sortStrategy: 'none', perHoleDepth: false,
    },
  } as unknown as Operation
}

function loadDrill(body: ImportedGeometry, op: Operation): void {
  seedProject()
  const current = useCamStore.getState()
  const setup = { ...current.project.setups[0], operations: [op] }
  useCamStore.setState({
    toolLibrary: [{
      id: 'drill-tool', name: '6 mm drill', type: 'drill', diameter: 6, fluteLength: 25, shankDiameter: 6,
      overallLength: 60, numberOfFlutes: 2, angleFromAxisDeg: 59, tipDiameter: 0,
    } as never],
    project: { ...current.project, geometry: [body], setups: [setup] },
  })
}

const DRILL_LOOP = 'wo3055-hole'

/** The preview's plan carries the same planes compute persisted on the op. */
function expectPlanMatchesComputed(
  plan: Awaited<ReturnType<ReturnType<typeof useCamStore.getState>['previewOperationSmartHeightPlan']>>,
  computed: Operation,
): void {
  const wcs = computed.resolvedHeights!.wcs
  expect({
    clearance: plan.safety.clearance.wcsMm, retract: plan.safety.retract.wcsMm,
    feed: plan.safety.feed.wcsMm, top: plan.machining.materialStart.wcsMm,
  }).toEqual({ clearance: wcs.clearance, retract: wcs.retract, feed: wcs.feed, top: wcs.top })
}

describe('WO-3055: the Smart-Height preview resolves a model-body source like compute', () => {
  it('a ready model-body Chamfer previews without the false refusal, with the heights compute resolved', async () => {
    seedProject()
    openWizard('2D Chamfer', MODEL_ID)
    pickEdges(INNER_EDGE_IDS)
    await createChamfer()
    const op = await waitReady(ops()[0].id)

    const plan = await useCamStore.getState().previewOperationSmartHeightPlan('setup-1', op)
    expectPlanMatchesComputed(plan, op)
  })

  it('a model-body Drill previews without the false refusal, with the heights compute resolved', async () => {
    const body = drillBody()
    const op = drillOperation(body)
    loadDrill(body, op)
    await useCamStore.getState().computeOperationToolpath('setup-1', op.id)
    const computed = ops().find((o) => o.id === op.id)!
    expect(computed.status, `errorMessage: ${computed.errorMessage}`).toBe('ready')

    const plan = await useCamStore.getState().previewOperationSmartHeightPlan('setup-1', computed)
    expectPlanMatchesComputed(plan, computed)
  })
})
