// @vitest-environment jsdom
//
// WO-1517: three mechanisms can supply a contour's machining boundary (saved
// loop ids, a bound model edge chain, a picked face), and BEFORE this fix each
// of the Create-button readiness check, the edit-save path and compute picked
// its own idea of which one was authoritative. This file proves the two
// operator-visible symptoms are gone:
//
//   BUG-463: a valid bound edge chain still left Create disabled with "no
//   loops selected" because the readiness check only ever looked at loop ids.
//   BUG-466: switching from a saved loop selection to a picked face left the
//   old loop id in params, and Save & Recompute refused citing that unrelated,
//   untouched loop instead of using the new, completely valid face boundary.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
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

// The store hands the worker the fully-resolved world-space loops it derived
// for whichever boundary is effective. Capturing at the worker's own boundary
// (same technique as modelEdgeChainWizard.wo114.test.tsx) proves what compute
// actually used without depending on the real clipper/offset engine.
interface CapturedRequest { type: string; payload: { opId: string; loops?: Loop2D[] } }
let workerRequests: CapturedRequest[] = []
function installWorkerCapture() {
  workerRequests = []
  class CapturingWorker {
    constructor(url: string | URL) {
      // WO-3085/3126 added separate postprocessing workers; this fake owns only toolpaths.
      if (!String(url).includes('toolpathWorker')) throw new Error('Use the production fallback for other workers')
    }
    onmessage: ((e: { data: unknown }) => void) | null = null
    onerror: ((e: unknown) => void) | null = null
    postMessage(data: CapturedRequest): void {
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
}
installWorkerCapture()

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const { MODEL_EDGE_PICK_VIEWPORT_CAPABILITY } = await import('../../store/modelEdgeChainBinding')

const MODEL_ID = 'modelbody:F1'
const BODY_ID = 'F1'
const TOP_Z = 10
const HALF = 10
const TOP_FACE = 'F1:BOX:zmax'
const wedge = (a: string, b: string) => `(${[a, b].sort().join('∧')})`
const EDGE_IDS = ['xmin', 'xmax', 'ymin', 'ymax'].map((s) => wedge(`F1:BOX:${s}`, TOP_FACE))

interface Pt2 { x: number; y: number }
function squareCorners(halfSize: number, cx: number, cy: number): Pt2[] {
  return [
    { x: cx - halfSize, y: cy - halfSize }, { x: cx + halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy + halfSize }, { x: cx - halfSize, y: cy + halfSize },
  ]
}
function squareEdgePolylines(halfSize: number, cx: number, cy: number): number[][] {
  const pts = squareCorners(halfSize, cx, cy)
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
function edgeTable() {
  return packEdges(squareEdgePolylines(HALF, 0, 0).map((polyline, i) => ({ id: EDGE_IDS[i], polyline })))
}
/** A flat top-cap face so a face pick (BUG-466) resolves on the SAME body. */
function topFaceMesh(): { positions: number[]; indices: number[] } {
  const pts = squareCorners(HALF, 0, 0)
  return { positions: pts.flatMap((p) => [p.x, p.y, TOP_Z]), indices: [0, 1, 2, 0, 2, 3] }
}
/** A saved section loop UNRELATED to the model edge chain / face - a real,
 *  pickable, closed sketch loop (Loop2D) so `closedLoops.length > 0` and the
 *  legacy per-loop selector is visible, exactly BUG-463's precondition. */
const SAVED_SECTION_LOOP_ID = 'sec:saved-loop'
function savedSectionLoop(): Loop2D {
  return {
    id: SAVED_SECTION_LOOP_ID, closed: true, type: 'contour',
    points: squareCorners(3, 30, 30), layerId: 'sketch', area: 36,
  } as unknown as Loop2D
}

const WIZARD_STOCK_ID = 'wizard-stock'
function wizardStock() {
  return {
    id: WIZARD_STOCK_ID, name: 'Wizard Stock', mode: 'explicit' as const,
    bounds: {
      min: { x: -50, y: -50, z: -12 }, max: { x: 50, y: 50, z: 0 },
      size: { x: 100, y: 100, z: 12 }, center: { x: 0, y: 0, z: -6 },
    },
    position: { x: -50, y: -50, z: -12 },
  }
}

function modelGeometry(): ImportedGeometry {
  const mesh = topFaceMesh()
  const table = edgeTable()
  return {
    id: MODEL_ID,
    name: 'Model F1',
    type: 'model',
    format: 'model',
    filename: 'Model F1',
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: -HALF, y: -HALF, z: 0 }, max: { x: HALF, y: HALF, z: TOP_Z },
      size: { x: 2 * HALF, y: 2 * HALF, z: TOP_Z }, center: { x: 0, y: 0, z: TOP_Z / 2 },
    },
    stockId: WIZARD_STOCK_ID,
    modelItemId: 'legacy',
    // BUG-463's precondition: a real, closed, pickable loop from an unrelated
    // saved section ALREADY present on the source, alongside the model body.
    loops: [savedSectionLoop()],
    modelBody: {
      ref: { bodyId: BODY_ID, stableIds: [TOP_FACE], version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: table.edgePositions, edgeOffsets: table.edgeOffsets,
        bbox: { min: [-HALF, -HALF, TOP_Z], max: [HALF, HALF, TOP_Z] },
        faceIds: [TOP_FACE], triFace: [0, 0],
        edgeIds: table.edgeIds,
      },
    },
  } as unknown as ImportedGeometry
}

function seedProject() {
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
      ...current.project, geometry: [modelGeometry()], stocks: [wizardStock()],
      setups: [setup], activeSetupId: setup.id, modelItemPlacements,
    },
    toolLibrary: [{
      id: 't1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
      fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
    } as never],
  })
}

type PickCallback = (
  sel: { geoId: string; kind: 'face' | 'edge'; index: number; isModelEdge?: boolean; isModelFace?: boolean },
  nowSelected: boolean,
) => void
let capturedPickCallback: PickCallback | null = null
let setBrepPickModeSpy: ReturnType<typeof vi.fn>
function stubViewport() {
  capturedPickCallback = null
  setBrepPickModeSpy = vi.fn((kind: string | null, cb?: PickCallback | null) => {
    capturedPickCallback = kind !== null && cb ? cb : null
  })
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    clearScene: vi.fn(),
    rebuildStock: vi.fn(),
    setPartPickMode: vi.fn(),
    setSelectedPart: vi.fn(),
    setPickedLoops: vi.fn(),
    setPickedBrepSelections: vi.fn(),
    setBrepPickMode: setBrepPickModeSpy,
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

function openWizardOnModelSource() {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Geometry'))
  const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
  fireEvent.change(select, { target: { value: MODEL_ID } })
  return select
}

/** Waits out the Smart Height V2 Contour preflight and clicks Create/Save. */
async function submitOperation() {
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText('EM6'))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => {
    const refusal = screen.queryByTestId('contour-height-preflight-error')
    if (refusal) throw new Error(refusal.textContent ?? 'Contour Smart Height preflight refused without a message')
    const create = screen.getByTestId('op-create') as HTMLButtonElement
    expect(create.disabled, `Create disabled: ${create.getAttribute('data-tooltip')}`).toBe(false)
  })
  fireEvent.click(screen.getByTestId('op-create'))
}

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

describe('WO-1517 BUG-463: a bound edge chain outranks an absent loop selection', () => {
  it('Create stays enabled and no "no loops selected" warning shows once a valid edge chain is bound', async () => {
    seedProject()
    openWizardOnModelSource()

    // The source has a real closed loop (the "saved section loop") - the
    // per-loop selector is visible and untouched (userClearedLoops defaults
    // true), exactly BUG-463's precondition.
    expect(screen.getByTestId('op-loops-empty-warn')).toBeTruthy()

    // Bind a valid 4-edge chain on the model body instead of picking a loop.
    fireEvent.click(screen.getByTestId('model-pick-edges'))
    expect(setBrepPickModeSpy).toHaveBeenLastCalledWith('edge', expect.any(Function), MODEL_ID)
    const table = edgeTable()
    for (const id of EDGE_IDS) {
      const index = table.edgeIds.indexOf(id)
      act(() => { capturedPickCallback!({ geoId: MODEL_ID, kind: 'edge', index, isModelEdge: true }, true) })
    }
    fireEvent.click(screen.getByTestId('model-edges-done'))
    expect(screen.queryByTestId('model-edge-pick-error')).toBeNull()
    await waitFor(() => {
      expect(screen.getByTestId('model-edge-readout').textContent).toContain('4 edge(s) bound')
    })

    // BUG-463: the readiness check must ask about the edge chain, not just
    // loop ids - the warning must be gone, and Create must not be blocked by it.
    expect(screen.queryByTestId('op-loops-empty-warn')).toBeNull()

    await submitOperation()
    await waitFor(() => { expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1) })
    expect(currentOp().modelReferences).toEqual([
      { bodyId: BODY_ID, modelItemId: 'legacy', stableIds: EDGE_IDS, role: 'edge-chain' },
    ])
    // Generates from the edge chain: the worker got the 20x20 border, not the
    // unrelated 6x6 saved section loop.
    await waitFor(() => { expect(workerRequests.length).toBeGreaterThan(0) })
    const loops = workerRequests[workerRequests.length - 1].payload.loops ?? []
    const pts = loops.flatMap((l) => l.points)
    expect(Math.max(...pts.map((p) => p.x)) - Math.min(...pts.map((p) => p.x))).toBeCloseTo(2 * HALF, 3)
  })
})

describe('WO-1517 BUG-466: a picked face outranks a stale saved loop id on Save & Recompute', () => {
  it('editing to a face boundary while an old loop id lingers in params still saves and computes', async () => {
    seedProject()
    openWizardOnModelSource()

    // Pick the machining-boundary face (the higher-precedence source).
    fireEvent.click(screen.getByTestId('machining-boundary-pick'))
    act(() => {
      capturedPickCallback!({ geoId: MODEL_ID, kind: 'face', index: 0, isModelFace: true }, true)
    })
    // WO-2858: the readout names the body; the saved reference below carries TOP_FACE.
    await waitFor(() => {
      expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('Picked face on Model F1')
    })
    expect(screen.getByTestId('machining-boundary-readout').textContent).not.toContain(TOP_FACE)
    await submitOperation()
    await waitFor(() => { expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1) })
    const opId = currentOp().id
    expect(currentOp().modelReferences).toEqual([
      { bodyId: BODY_ID, stableIds: [TOP_FACE], role: 'machining-boundary' },
    ])
    // The save path already cleared loopIds for this fresh save (the fix).
    expect((currentOp().params as { loopIds?: string[] }).loopIds).toEqual([])

    // Simulate what an operation saved BEFORE this fix (or hand-edited) could
    // carry: the durable face boundary intact, but a stale loop id left over
    // from an earlier, now-superseded, loop-based selection.
    act(() => {
      useCamStore.getState().closeModal()
      useCamStore.getState().updateOperation('setup-1', opId, {
        status: 'pending',
        toolpathMoves: undefined,
        errorMessage: undefined,
        params: { ...currentOp().params, loopIds: [SAVED_SECTION_LOOP_ID] },
      })
    })
    expect((currentOp().params as { loopIds?: string[] }).loopIds).toEqual([SAVED_SECTION_LOOP_ID])

    act(() => { useCamStore.getState().openEditOperation('setup-1', opId) })
    await waitFor(() => {
      expect(screen.getByText('Edit Operation', { exact: false })).toBeTruthy()
    })
    fireEvent.click(screen.getByText('Geometry'))
    // The face boundary is still what the wizard shows as bound (WO-2858: by body name).
    expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('Picked face on Model F1')
    expect(screen.getByTestId('machining-boundary-readout').textContent).not.toContain(TOP_FACE)

    workerRequests = []
    await submitOperation()

    // BUG-466: Save & Recompute must not refuse citing the unrelated, stale
    // section loop id - the face boundary is completely valid on its own.
    await waitFor(() => {
      expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    })
    expect(currentOp().errorMessage).toBeFalsy()
    expect((currentOp().params as { loopIds?: string[] }).loopIds).toEqual([])
    expect(currentOp().modelReferences).toEqual([
      { bodyId: BODY_ID, stableIds: [TOP_FACE], role: 'machining-boundary' },
    ])
  })
})

describe('WO-1517 acceptance 3: an explicitly empty selection still blocks Create', () => {
  it('no loop ids, no edge chain, no face: the warning still shows and Create stays refused', () => {
    seedProject()
    openWizardOnModelSource()

    expect(screen.getByTestId('op-loops-empty-warn')).toBeTruthy()
    fireEvent.click(screen.getByText('Tool'))
    fireEvent.click(screen.getByText('EM6'))
    fireEvent.click(screen.getByText('Geometry'))
    expect(screen.getByTestId('op-loops-empty-warn')).toBeTruthy()
    expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(true)
  })
})
