// @vitest-environment jsdom
//
// WO-1924, through the REAL op-picker: an edge chain picked on a MODELED BODY
// can bound a Pocket or an Adaptive Clearing operation, not only a Contour -
// with WO-114's op-type and source-switch protection unchanged.
//
// Every assertion is driven through the surface the operator touches: render
// the real NewOperationModal, choose the op type and the modeled body, click
// "Pick edges", receive the viewport's pick callbacks, click Done, click Create,
// then read what the STORE persisted and which loops it handed the toolpath
// worker.
//
// THE FIXTURE IS BUILT SO A WRONG BOUNDARY IS VISIBLE (same shape as
// modelEdgeChainWizard.wo114.test.tsx): body A carries a 40x40 OUTER border and
// a 10x10 INNER border on one top plane; the operator picks the INNER four
// edges. The whole-body profile default would hand the worker the 40x40 outline,
// so a chain that is dropped on the way to compute is a 40mm boundary, not a
// 10mm one. Body B is a different 30x30 body.
//
// (A .ts file, per WO-1924's owned-paths, so the modal is mounted with
// createElement rather than JSX.)

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createElement } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type {
  ImportedGeometry, Loop2D, ModelItemPlacementRecord, Operation, Setup,
} from '../../types'

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

// The store hands the worker the FULLY RESOLVED world-space loops it derived
// from the operation's bindings (payload.loops) - the exact answer to "which
// boundary did this operation bind". Captured here; the reply is a minimal
// completion so the op reaches 'ready'.
interface CapturedRequest { type: string; payload: { opId: string; loops?: Loop2D[] } }
let workerRequests: CapturedRequest[] = []
class CapturingWorker {
  onmessage: ((e: { data: unknown }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(data: CapturedRequest | { request: unknown }): void {
    // The off-page post-process worker (store/toolpathPostprocess.ts): report
    // "cannot start a module worker" so it runs its own in-page fallback.
    if ('request' in data) {
      queueMicrotask(() => this.onerror?.({ preventDefault() {} }))
      return
    }
    workerRequests.push(data)
    queueMicrotask(() => this.onmessage?.({
      data: {
        type: 'TOOLPATH_COMPLETE',
        opId: data.payload.opId,
        moves: [{ type: 'feed', x: 0, y: 0, z: -1, role: 'cut' }],
        computeTimeMs: 1,
      },
    }))
  }
  terminate(): void {}
  addEventListener(): void {}
  removeEventListener(): void {}
}
Object.defineProperty(globalThis, 'Worker', { value: CapturingWorker, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const {
  modelBodyEdgeChainBindingCapability, MODEL_EDGE_PICK_VIEWPORT_CAPABILITY, MODEL_EDGE_CHAIN_ROLE,
} = await import('../../store/modelEdgeChainBinding')

const MODEL_ID = 'modelbody:F1'
const MODEL_B_ID = 'modelbody:F2'
const BODY_ID = 'F1'
const BODY_B_ID = 'F2'
const TOP_Z = 10
const OUTER_HALF = 20
const INNER_HALF = 5
const B_HALF = 15

const wedge = (a: string, b: string) => `(${[a, b].sort().join('∧')})`
const TOP_FACE = 'F1:BOX:zmax'
const TOP_FACE_B = 'F2:BOX:zmax'
const SIDES = ['xmin', 'xmax', 'ymin', 'ymax']
const OUTER_EDGE_IDS = SIDES.map((s) => wedge(`F1:BOX:${s}`, TOP_FACE))
const INNER_EDGE_IDS = SIDES.map((s) => wedge(`F1:HOLE:${s}`, TOP_FACE))
const B_EDGE_IDS = SIDES.map((s) => wedge(`F2:BOX:${s}`, TOP_FACE_B))

interface Pt2 { x: number; y: number }
function squareCorners(halfSize: number): Pt2[] {
  return [
    { x: -halfSize, y: -halfSize }, { x: halfSize, y: -halfSize },
    { x: halfSize, y: halfSize }, { x: -halfSize, y: halfSize },
  ]
}
function squareEdgePolylines(halfSize: number): number[][] {
  const pts = squareCorners(halfSize)
  return pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length]
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
  return { positions, indices }
}

const EDGE_TABLE_A = packEdges([
  ...squareEdgePolylines(OUTER_HALF).map((polyline, i) => ({ id: OUTER_EDGE_IDS[i], polyline })),
  ...squareEdgePolylines(INNER_HALF).map((polyline, i) => ({ id: INNER_EDGE_IDS[i], polyline })),
])
const EDGE_TABLE_B = packEdges(
  squareEdgePolylines(B_HALF).map((polyline, i) => ({ id: B_EDGE_IDS[i], polyline })),
)

function modelBody(
  id: string, name: string, bodyId: string, topFace: string, halfSize: number,
  edgeTable: ReturnType<typeof packEdges>,
): ImportedGeometry {
  const mesh = wallMesh(halfSize)
  return {
    id, name, type: 'model', format: 'model', filename: name, loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: -halfSize, y: -halfSize, z: 0 },
      max: { x: halfSize, y: halfSize, z: TOP_Z },
      size: { x: 2 * halfSize, y: 2 * halfSize, z: TOP_Z },
      center: { x: 0, y: 0, z: TOP_Z / 2 },
    },
    modelItemId: 'legacy',
    stockId: WIZARD_STOCK_ID,
    modelBody: {
      ref: { bodyId, stableIds: [topFace], version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: edgeTable.edgePositions, edgeOffsets: edgeTable.edgeOffsets,
        bbox: { min: [-halfSize, -halfSize, 0], max: [halfSize, halfSize, TOP_Z] },
        faceIds: [topFace],
        triFace: new Array(mesh.indices.length / 3).fill(0),
        edgeIds: edgeTable.edgeIds,
      },
    },
  } as unknown as ImportedGeometry
}

const WIZARD_STOCK_ID = 'wizard-stock'
/** A Section-at-Z the wizard already landed on body A: one closed 40x40 loop.
 *  It makes the wizard's loop selector visible for a modeled body, which is the
 *  state where a cleared loop selection could block Create. */
const LANDED_SECTION_LOOP = {
  id: 'section-loop', points: squareCorners(OUTER_HALF), closed: true, type: 'contour',
  layerId: 'section-layer', area: (2 * OUTER_HALF) ** 2,
}

function seedProject({ landedSection = false }: { landedSection?: boolean } = {}) {
  const bodyA = modelBody(MODEL_ID, 'Model F1', BODY_ID, TOP_FACE, OUTER_HALF, EDGE_TABLE_A)
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: WIZARD_STOCK_ID,
    },
    defaultHeightIntent: {
      ...defaultHeightIntent(),
      clearance: { reference: 'retract', offset: 22, provenance: 'user' },
    },
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
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
      geometry: [
        landedSection
          ? ({ ...bodyA, loops: [LANDED_SECTION_LOOP] } as unknown as ImportedGeometry)
          : bodyA,
        modelBody(MODEL_B_ID, 'Model F2', BODY_B_ID, TOP_FACE_B, B_HALF, EDGE_TABLE_B),
      ],
      stocks: [{
        id: WIZARD_STOCK_ID, name: 'Wizard Stock', mode: 'explicit' as const,
        bounds: {
          min: { x: -50, y: -50, z: -12 }, max: { x: 50, y: 50, z: 0 },
          size: { x: 100, y: 100, z: 12 }, center: { x: 0, y: 0, z: -6 },
        },
        position: { x: -50, y: -50, z: -12 },
      }],
      setups: [setup], activeSetupId: setup.id, modelItemPlacements,
    },
    toolLibrary: [{
      id: 't1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
      fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
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

type ProfileOpLabel = '2D Pocket' | '2D Adaptive Clearing'

function openWizard(opLabel: ProfileOpLabel, geoId: string) {
  render(createElement(NewOperationModal))
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText(opLabel))
  fireEvent.click(screen.getByText('Geometry'))
  selectSource(geoId)
}
function selectSource(geoId: string) {
  fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: geoId } })
}
function pickInnerBorder() {
  fireEvent.click(screen.getByTestId('model-pick-edges'))
  expect(capturedPickCallback).not.toBeNull()
  for (const id of INNER_EDGE_IDS) {
    const index = EDGE_TABLE_A.edgeIds.indexOf(id)
    act(() => { capturedPickCallback!({ geoId: MODEL_ID, kind: 'edge', index, isModelEdge: true }, true) })
  }
  fireEvent.click(screen.getByTestId('model-edges-done'))
}
function createButton(): HTMLButtonElement {
  return screen.getByTestId('op-create') as HTMLButtonElement
}
async function createOperation() {
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText('EM6'))
  await waitFor(() => {
    expect(createButton().disabled, `Create disabled: ${createButton().getAttribute('data-tooltip')}`).toBe(false)
  })
  fireEvent.click(createButton())
  await waitFor(() => { expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1) })
}
const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]
function lastComputedLoops(): Loop2D[] {
  const last = workerRequests[workerRequests.length - 1]
  expect(last, 'no toolpath worker request was made').toBeTruthy()
  return last.payload.loops ?? []
}
function loopsBBox(loops: Loop2D[]) {
  const pts = loops.flatMap((l) => l.points)
  return {
    minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
  }
}

const PROFILE_CASES: Array<{ label: ProfileOpLabel; type: Operation['type']; readout: string }> = [
  { label: '2D Pocket', type: 'pocket_2d', readout: 'pocket boundary' },
  { label: '2D Adaptive Clearing', type: 'adaptive_clearing_2d', readout: 'clearing boundary' },
]

describe('WO-1924: the edge-chain capability covers the computable profile family', () => {
  it('Pocket and Adaptive Clearing are supported; thread mill still refuses by name', () => {
    // WO-1939 added Engrave to the supported set (engraveModelEdge.wo1939.test.ts);
    // WO-1941 added Chamfer (chamferModelEdge.wo1941.test.ts).
    for (const opType of ['contour_2d', 'pocket_2d', 'adaptive_clearing_2d', 'engrave'] as const) {
      expect(modelBodyEdgeChainBindingCapability(opType).supported).toBe(true)
    }
    for (const opType of ['thread_mill'] as const) {
      const capability = modelBodyEdgeChainBindingCapability(opType)
      expect(capability.supported).toBe(false)
      expect(capability.reason).toContain(opType)
    }
  })
})

describe.each(PROFILE_CASES)('WO-1924: a model edge chain bounds a $label', ({ label, type, readout }) => {
  it('offers Pick edges on a modeled body and names the bound boundary', () => {
    seedProject()
    openWizard(label, MODEL_ID)

    expect(screen.getByTestId('model-edge-readout').textContent).toContain('No edges picked yet')
    pickInnerBorder()

    expect(screen.queryByTestId('model-edge-pick-error')).toBeNull()
    expect(screen.getByTestId('model-edge-readout').textContent)
      .toBe(`4 edge(s) bound as this ${readout}.`)
  })

  it('saves the chain as a durable edge-chain reference and computes THAT boundary, not the whole body', async () => {
    seedProject()
    openWizard(label, MODEL_ID)
    pickInnerBorder()
    await createOperation()

    const op = currentOp()
    expect(op.type).toBe(type)
    expect(op.modelReferences).toEqual([{
      bodyId: BODY_ID, modelItemId: 'legacy', stableIds: INNER_EDGE_IDS, role: MODEL_EDGE_CHAIN_ROLE,
    }])
    // The chain supersedes any loop selection, so compute takes every chain loop.
    expect((op.params as { loopIds?: string[] }).loopIds).toEqual([])
    expect(op.geometrySelections).toEqual([])

    await waitFor(() => { expect(workerRequests.length).toBeGreaterThan(0) })
    await waitFor(() => {
      expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    })
    const bb = loopsBBox(lastComputedLoops())
    // The 10x10 inner border - NOT the 40x40 outline the whole-body default gives.
    expect(bb.maxX - bb.minX).toBeCloseTo(2 * INNER_HALF, 3)
    expect(bb.maxY - bb.minY).toBeCloseTo(2 * INNER_HALF, 3)
  })

  it('Create is ready once a chain is bound even when the body carries a landed section the loop selector lists', async () => {
    seedProject({ landedSection: true })
    openWizard(label, MODEL_ID)
    // The loop selector is live for this body, and the source switch cleared it.
    expect(screen.getByTestId('op-loops-empty-warn')).toBeTruthy()
    pickInnerBorder()
    // The bound chain is the boundary, so an empty loop selection is moot.
    expect(screen.queryByTestId('op-loops-empty-warn')).toBeNull()
    await createOperation()

    expect(currentOp().modelReferences?.[0]?.role).toBe(MODEL_EDGE_CHAIN_ROLE)
    await waitFor(() => {
      expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    })
    const bb = loopsBBox(lastComputedLoops())
    expect(bb.maxX - bb.minX).toBeCloseTo(2 * INNER_HALF, 3)
  })

  it('switching Source to another body drops the chain with the body-mismatch message and saves no edge reference', async () => {
    seedProject()
    openWizard(label, MODEL_ID)
    pickInnerBorder()

    selectSource(MODEL_B_ID)

    expect(screen.getByTestId('model-edge-readout').textContent).toContain('No edges picked yet')
    const notice = screen.getByTestId('model-edge-chain-dropped').textContent ?? ''
    expect(notice).toContain(BODY_ID)
    expect(notice).toContain('Model F2')
    expect(notice).toMatch(/NOT applied/)

    await createOperation()
    const refs = currentOp().modelReferences ?? []
    expect(refs.some((r) => r.role === MODEL_EDGE_CHAIN_ROLE)).toBe(false)
    expect(JSON.stringify(refs)).not.toContain(BODY_ID)

    await waitFor(() => {
      expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    })
    const bb = loopsBBox(lastComputedLoops())
    expect(bb.maxX - bb.minX).toBeCloseTo(2 * B_HALF, 3)
  })

  it('switching the op type to Engrave drops the chain and says so - never a silent apply', () => {
    seedProject()
    openWizard(label, MODEL_ID)
    pickInnerBorder()
    expect(screen.queryByTestId('model-edge-chain-dropped')).toBeNull()

    fireEvent.click(screen.getByText('Type & Name'))
    fireEvent.click(screen.getByText('Engrave / Trace'))
    fireEvent.click(screen.getByText('Geometry'))

    expect(screen.getByTestId('model-edge-chain-dropped').textContent).toMatch(/NOT applied/)
    expect(screen.queryByTestId('model-pick-edges')).toBeNull()
  })
})
