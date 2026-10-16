// @vitest-environment jsdom
//
// WO-114, through the REAL op-picker: picking a border contour on a MODELED
// BODY as an edge chain for a contour_2d operation - end to end - and proving
// it can NEVER be applied to a body it was not picked on.
//
// Nothing here calls deriveModelBodyEdges for the end-to-end assertions. Every
// one is driven through the surface the operator actually touches: render the
// real NewOperationModal, choose the modeled body as the source, click "Pick
// edges", receive the viewport's pick callbacks, click Done, click Create - and
// then read what the STORE persisted and what it handed the toolpath worker.
//
// (This file lives in src/tests/store/ rather than beside the other
// NewOperationModal tests in src/tests/components/ because WO-114's owned-paths
// cover src/tests/store/ and not src/tests/components/. It is a WIZARD test in
// every other respect - it renders the real modal - which is the layer WO-095's
// audit finding 4 said the proof had to live at. src/tests/store already
// carries a .tsx render test, runtimeEstimateLoad.sim7.test.tsx.)
//
// THE FIXTURE IS BUILT SO A WRONG EDGE IS VISIBLE. Body A carries two closed
// borders on the same top plane: a 40x40 OUTER square and a 10x10 INNER square
// (a hole). The operator picks the INNER four edges. A rebuild then re-emits
// the edge table in a DIFFERENT ORDER and moves the hole. Anything that binds
// edges positionally lands on the OUTER square instead - a 40mm contour where
// the operator asked for a 10mm one, which is the wrong-toolpath case in the
// flesh. Body B is a DIFFERENT 30x30 body, so a chain that leaks across a
// source switch is equally visible as a 30mm contour.

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

// ── the toolpath worker, intercepted at its own boundary ────────────────────
// The store hands the worker the FULLY RESOLVED, world-space loops it computed
// from the operation's bindings (payload.loops). That payload is therefore the
// exact answer to "which edges did this operation actually bind" - so this
// harness captures it and replies with a minimal completion, instead of running
// the real 2.5D planner whose offsetting maths is proven elsewhere and would
// only blur the geometry these assertions are about.
interface CapturedRequest { type: string; payload: { opId: string; loops?: Loop2D[] } }
let workerRequests: CapturedRequest[] = []
function installWorkerCapture() {
  workerRequests = []
  class CapturingWorker {
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
const { authorModelReference } = await import('../../components/modals/NewOperationModalBody')
const { useCamStore } = await import('../../store')
const { defaultHeightIntent } = await import('../../lib/cam/heightIntent')
const {
  modelBodyEdgeChainBindingCapability, modelBodyEdgeChainBindingSupported,
  modelBodyEdgePickOffered, viewportSupportsModelEdgePick, modelEdgeChainBodyMismatch,
  modelReferenceMatchesSource, MODEL_EDGE_PICK_VIEWPORT_CAPABILITY, MODEL_EDGE_CHAIN_ROLE,
} = await import('../../store/modelEdgeChainBinding')

const MODEL_ID = 'modelbody:F1'
const MODEL_B_ID = 'modelbody:F2'
const SHARED_BODY_ITEM_B_ID = 'modelbody:item-b:F1'
const BREP_ID = 'brep:S1'
const BODY_ID = 'F1'
const BODY_B_ID = 'F2'
const TOP_Z = 10

// Edge ids are DERIVED from the sorted adjacent-face-id pair, joined by the
// spec's U+2227 wedge (src/geom/worker/stable-id.ts EDGE_JOIN) - the same shape
// the real kernel emits, so resolvePersistedEdgeId parses these exactly as it
// parses live ones. (The kernel-driven proof that this holds against REAL
// occt-wasm geometry is modelEdgeChainKernelRebuild.wo114.test.ts.)
const wedge = (a: string, b: string) => `(${[a, b].sort().join('∧')})`
const TOP_FACE = 'F1:BOX:zmax'
const TOP_FACE_B = 'F2:BOX:zmax'
const OUTER_EDGE_IDS = ['xmin', 'xmax', 'ymin', 'ymax'].map((s) => wedge(`F1:BOX:${s}`, TOP_FACE))
const INNER_EDGE_IDS = ['xmin', 'xmax', 'ymin', 'ymax'].map((s) => wedge(`F1:HOLE:${s}`, TOP_FACE))
const B_EDGE_IDS = ['xmin', 'xmax', 'ymin', 'ymax'].map((s) => wedge(`F2:BOX:${s}`, TOP_FACE_B))

interface Pt2 { x: number; y: number }
function squareCorners(halfSize: number, cx: number, cy: number): Pt2[] {
  return [
    { x: cx - halfSize, y: cy - halfSize }, { x: cx + halfSize, y: cy - halfSize },
    { x: cx + halfSize, y: cy + halfSize }, { x: cx - halfSize, y: cy + halfSize },
  ]
}
/** One CSR edge entry per square side: a 2-point polyline at TOP_Z. */
function squareEdgePolylines(halfSize: number, cx: number, cy: number): number[][] {
  const pts = squareCorners(halfSize, cx, cy)
  return pts.map((a, i) => {
    const b = pts[(i + 1) % pts.length]
    return [a.x, a.y, TOP_Z, b.x, b.y, TOP_Z]
  })
}
/** Pack labelled polylines into the display's CSR edge arrays + id table. */
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
/** A closed wall mesh so the body has real tessellated geometry/bbox. */
function wallMesh(halfSize: number, z0: number, z1: number) {
  const pts = squareCorners(halfSize, 0, 0)
  const positions: number[] = []
  const indices: number[] = []
  for (let i = 0; i < pts.length; i++) {
    positions.push(pts[i].x, pts[i].y, z0)
    positions.push(pts[i].x, pts[i].y, z1)
  }
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    const b0 = 2 * i, t0 = 2 * i + 1, b1 = 2 * j, t1 = 2 * j + 1
    indices.push(b0, b1, t1, b0, t1, t0)
  }
  return { positions, indices }
}

const OUTER_HALF = 20
const INNER_HALF = 5
const B_HALF = 15

/** The as-picked edge table: outer four, then inner four. */
function initialEdgeTable() {
  return packEdges([
    ...squareEdgePolylines(OUTER_HALF, 0, 0).map((polyline, i) => ({ id: OUTER_EDGE_IDS[i], polyline })),
    ...squareEdgePolylines(INNER_HALF, 0, 0).map((polyline, i) => ({ id: INNER_EDGE_IDS[i], polyline })),
  ])
}

/**
 * A REBUILT body: the same faces survive (so every edge id survives), but the
 * kernel re-emits the table INTERLEAVED (outer, inner, outer, inner, ...) and
 * the hole has been moved to (HOLE_MOVED_X, 0). Interleaved deliberately: any
 * binding that resolves a picked edge by its POSITION in the table now lands on
 * a mixture of outer and inner sides, which is a different toolpath, not a
 * different ordering of the same one.
 */
const HOLE_MOVED_X = 12
function rebuiltEdgeTable() {
  const outer = squareEdgePolylines(OUTER_HALF, 0, 0)
  const inner = squareEdgePolylines(INNER_HALF, HOLE_MOVED_X, 0)
  return packEdges(outer.flatMap((polyline, i) => [
    { id: OUTER_EDGE_IDS[i], polyline },
    { id: INNER_EDGE_IDS[i], polyline: inner[i] },
  ]))
}

/** A rebuilt body whose HOLE WAS DELETED - the picked edges are gone for good. */
function holeDeletedEdgeTable() {
  return packEdges(
    squareEdgePolylines(OUTER_HALF, 0, 0).map((polyline, i) => ({ id: OUTER_EDGE_IDS[i], polyline })),
  )
}

function modelGeometry(
  edgeTable: ReturnType<typeof packEdges>,
  modelItemId = 'legacy',
): ImportedGeometry {
  const mesh = wallMesh(OUTER_HALF, 0, TOP_Z)
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
      min: { x: -OUTER_HALF, y: -OUTER_HALF, z: 0 },
      max: { x: OUTER_HALF, y: OUTER_HALF, z: TOP_Z },
      size: { x: 2 * OUTER_HALF, y: 2 * OUTER_HALF, z: TOP_Z },
      center: { x: 0, y: 0, z: TOP_Z / 2 },
    },
    modelItemId,
    modelBody: {
      ref: { bodyId: BODY_ID, stableIds: [TOP_FACE], version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: edgeTable.edgePositions, edgeOffsets: edgeTable.edgeOffsets,
        bbox: { min: [-OUTER_HALF, -OUTER_HALF, 0], max: [OUTER_HALF, OUTER_HALF, TOP_Z] },
        faceIds: [TOP_FACE],
        triFace: new Array(mesh.indices.length / 3).fill(0),
        edgeIds: edgeTable.edgeIds,
      },
    },
  } as unknown as ImportedGeometry
}

/** A real horizontal face payload for the direct machining-boundary writer.
 *  The edge-chain fixture above deliberately uses wall triangles and therefore
 *  cannot honestly stand in for a pickable flat face. */
function horizontalFaceModelGeometry(modelItemId: string): ImportedGeometry {
  const geo = modelGeometry(initialEdgeTable(), modelItemId)
  const positions = squareCorners(OUTER_HALF, 0, 0).flatMap((point) => [point.x, point.y, TOP_Z])
  return {
    ...geo,
    modelBody: {
      ...geo.modelBody!,
      display: {
        ...geo.modelBody!.display!,
        positions,
        indices: [0, 1, 2, 0, 2, 3],
        faceIds: [TOP_FACE],
        triFace: [0, 0],
      },
    },
  }
}

/** A second Model Item with its own kernel document. Its raw DAG body is also
 *  F1, which is legal and is the identity collision WO-225 must survive. */
function sharedRawBodyItemBGeometry(): ImportedGeometry {
  const geo = horizontalFaceModelGeometry('item-b')
  return {
    ...geo,
    id: SHARED_BODY_ITEM_B_ID,
    name: 'Item B shared F1',
    filename: 'Item B shared F1',
  }
}

/** Body B: a DIFFERENT modeled body (30x30), with its own identity and its own
 *  edge ids. The whole point of the source-switch assertion is that A's edge
 *  chain must never be applied to this. */
function modelGeometryB(): ImportedGeometry {
  const mesh = wallMesh(B_HALF, 0, TOP_Z)
  const edgeTable = packEdges(
    squareEdgePolylines(B_HALF, 0, 0).map((polyline, i) => ({ id: B_EDGE_IDS[i], polyline })),
  )
  return {
    id: MODEL_B_ID,
    name: 'Model F2',
    type: 'model',
    format: 'model',
    filename: 'Model F2',
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: -B_HALF, y: -B_HALF, z: 0 },
      max: { x: B_HALF, y: B_HALF, z: TOP_Z },
      size: { x: 2 * B_HALF, y: 2 * B_HALF, z: TOP_Z },
      center: { x: 0, y: 0, z: TOP_Z / 2 },
    },
    modelItemId: 'legacy',
    modelBody: {
      ref: { bodyId: BODY_B_ID, stableIds: [TOP_FACE_B], version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: edgeTable.edgePositions, edgeOffsets: edgeTable.edgeOffsets,
        bbox: { min: [-B_HALF, -B_HALF, 0], max: [B_HALF, B_HALF, TOP_Z] },
        faceIds: [TOP_FACE_B],
        triFace: new Array(mesh.indices.length / 3).fill(0),
        edgeIds: edgeTable.edgeIds,
      },
    },
  } as unknown as ImportedGeometry
}

const brepGeometry = () => ({
  id: BREP_ID,
  name: 'Imported STEP',
  type: 'brep',
  format: 'step',
  filename: 'part.step',
  loaded: true,
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  boundingBox: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
    size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
  },
  layers: [{ id: 'brep-layer', name: 'Imported profile', visible: true, locked: false }],
  loops: [{
    id: 'brep-contour',
    points: squareCorners(10, 10, 10),
    closed: true,
    type: 'contour',
    layerId: 'brep-layer',
    area: 400,
  }],
} as unknown as ImportedGeometry)

/** Seeds two fully re-synced modeled bodies (faceIds/triFace AND per-edge stable
 *  ids, so nothing about the payload is what withholds the pick) plus an
 *  imported B-rep, so the paths are compared side by side in one project. */
const WIZARD_STOCK_ID = 'wizard-stock'
/** One explicit, provable stock: 100 x 100 x 12 with its top at WCS z=0. */
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

function seedProject(
  modelItemId = 'legacy',
  primaryGeometry = modelGeometry(initialEdgeTable(), modelItemId),
) {
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      // Smart Height V2 (2e5678b7) proves the contour's material against the
      // Setup's bound stock before Create enables; the wizard needs one.
      stockId: WIZARD_STOCK_ID,
    },
    // Clearance well above the stock top, so these tests exercise the EDGE
    // BINDING rather than tripping the (unrelated, correct) clearance-below-
    // retract guard. Same device the Stage 5 machining-boundary wizard test uses.
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
    { modelItemId, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
  ]
  const current = useCamStore.getState()
  useCamStore.setState({
    project: {
      ...current.project,
      geometry: [primaryGeometry, modelGeometryB(), brepGeometry()].map(geometry => ({
        ...geometry, stockId: WIZARD_STOCK_ID,
      })),
      stocks: [wizardStock()],
      setups: [setup], activeSetupId: setup.id, modelItemPlacements,
    },
    toolLibrary: [{
      id: 't1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
      fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
    } as never],
  })
}

function seedTwoItemSharedBodyProject() {
  const itemA = horizontalFaceModelGeometry('item-a')
  const itemB = sharedRawBodyItemBGeometry()
  seedProject('item-a', itemA)
  act(() => {
    useCamStore.setState((state) => ({
      project: {
        ...state.project,
        geometry: [itemA, itemB, modelGeometryB(), brepGeometry()].map(geometry => ({
          ...geometry, stockId: WIZARD_STOCK_ID,
        })),
        modelItemPlacements: [
          { modelItemId: 'item-a', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
          { modelItemId: 'item-b', position: { x: 60, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
          { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
        ],
      },
    }))
  })
}

describe('WO-208: current model-reference writers preserve Model Item identity', () => {
  it('the modal serializer stamps every non-legacy reference role it authors', () => {
    for (const role of ['machining-boundary', 'drill-targets', 'bore-target'] as const) {
      expect(authorModelReference('item-a', BODY_ID, ['stable-1'], role)).toEqual({
        modelItemId: 'item-a',
        bodyId: BODY_ID,
        stableIds: ['stable-1'],
        role,
      })
    }
  })

  it('the direct store boundary writer stamps a non-legacy source item', () => {
    seedProject('item-a', horizontalFaceModelGeometry('item-a'))
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          setups: state.project.setups.map((setup) => ({
            ...setup,
            operations: [{
              id: 'op-boundary',
              name: 'Boundary',
              type: 'contour_2d',
              status: 'ready',
              params: { geometryId: MODEL_ID },
            } as unknown as Operation],
          })),
        },
      }))
      useCamStore.getState().setOperationMachiningBoundaryFace(
        'setup-1',
        'op-boundary',
        TOP_FACE,
      )
    })

    expect(currentOp().modelReferences).toEqual([{
      modelItemId: 'item-a',
      bodyId: BODY_ID,
      stableIds: [TOP_FACE],
      role: 'machining-boundary',
    }])
  })
})

/** Replace body A's display edge table - a model REBUILD as the store sees one.
 *  (The proof that this shape of change matches what the REAL kernel emits
 *  across an actual edit+rebuild is modelEdgeChainKernelRebuild.wo114.test.ts,
 *  which drives GeomEngine directly.) */
function rebuildBodyWith(edgeTable: ReturnType<typeof packEdges>) {
  act(() => {
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        // A rebuild changes the body, not what stock it sits on.
        geometry: s.project.geometry.map((g) => (g.id === MODEL_ID
          ? { ...modelGeometry(edgeTable), stockId: g.stockId }
          : g)),
      },
    }))
  })
}

// ── the viewport handle ─────────────────────────────────────────────────────
// Two variants, because the whole point of the capability probe is that the
// wizard behaves differently for a viewport that can report a modeled-body edge
// hit and one that cannot. `capable` is the contract WO-113 landed on the real
// CNCViewport; `legacy` is any older/stub handle.
type PickCallback = (
  sel: {
    geoId: string; kind: 'face' | 'edge'; index: number
    isModelEdge?: boolean; isModelFace?: boolean
  },
  nowSelected: boolean,
) => void
let capturedPickCallback: PickCallback | null = null
let setBrepPickModeSpy: ReturnType<typeof vi.fn>

function stubViewport({ edgePickCapable }: { edgePickCapable: boolean }) {
  capturedPickCallback = null
  setBrepPickModeSpy = vi.fn((kind: string | null, cb?: PickCallback | null) => {
    capturedPickCallback = kind !== null && cb ? cb : null
  })
  const handle: Record<string, unknown> = {
    clearScene: vi.fn(),
    rebuildStock: vi.fn(),
    setPartPickMode: vi.fn(),
    setSelectedPart: vi.fn(),
    setPickedLoops: vi.fn(),
    setPickedBrepSelections: vi.fn(),
    setBrepPickMode: setBrepPickModeSpy,
  }
  if (edgePickCapable) handle[MODEL_EDGE_PICK_VIEWPORT_CAPABILITY] = () => true
  ;(window as unknown as Record<string, unknown>).__cncViewport = handle
}

beforeEach(() => {
  workerRequests = []
  act(() => { useCamStore.getState().newProject() })
  stubViewport({ edgePickCapable: true })
})
afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

/** Open the wizard on a source. Contour is the default op type, and contour is
 *  one of the ops showPickEdges covers - so this is exactly the scenario:
 *  "choose one of the border contours as an edge to perform a contour op". */
function openWizardOn(geoId: string) {
  render(<NewOperationModal />)
  act(() => { useCamStore.getState().openModal('new-operation') })
  fireEvent.click(screen.getByText('Geometry'))
  selectSource(geoId)
}

/** Change the Source geometry dropdown - the exact control the operator uses,
 *  and the one whose handler (setGeoId) the WO-095 audit found did not clear
 *  the picked edge chain. */
function selectSource(geoId: string) {
  const select = screen.getByTestId('op-geometry-select') as HTMLSelectElement
  fireEvent.change(select, { target: { value: geoId } })
}

/** Drive a real pick of the four INNER border edges through the wizard: arm the
 *  picker with the button, let the viewport report four edge hits, click Done. */
function pickInnerBorderThroughWizard() {
  fireEvent.click(screen.getByTestId('model-pick-edges'))
  expect(setBrepPickModeSpy).toHaveBeenLastCalledWith('edge', expect.any(Function), MODEL_ID)
  expect(capturedPickCallback).not.toBeNull()
  const table = initialEdgeTable()
  for (const id of INNER_EDGE_IDS) {
    const index = table.edgeIds.indexOf(id)
    act(() => { capturedPickCallback!({ geoId: MODEL_ID, kind: 'edge', index, isModelEdge: true }, true) })
  }
  fireEvent.click(screen.getByTestId('model-edges-done'))
}

async function pickMachiningBoundaryThroughWizard(geoId: string, faceStableId: string, bodyName = 'Model F1') {
  fireEvent.click(screen.getByTestId('machining-boundary-pick'))
  expect(capturedPickCallback).not.toBeNull()
  act(() => {
    capturedPickCallback!({ geoId, kind: 'face', index: 0, isModelFace: true }, true)
  })
  // WO-2858: the readout names the body; the face key stays in the saved reference.
  await waitFor(() => {
    expect(screen.getByTestId('machining-boundary-readout').textContent).toContain(`Picked face on ${bodyName}`)
  })
  expect(screen.getByTestId('machining-boundary-readout').textContent).not.toContain(faceStableId)
}

// Commit 2e5678b7 made a valid Smart Height V2 envelope the only runtime
// authority: Create Operation stays disabled until the modal's own Contour
// preflight resolves one (NewOperationModalBody.tsx, the 'op-create' button's
// data-tooltip). Mounting the Heights tab and waiting it out here mirrors
// waitForContourHeightReady() in NewOperationModalLoops.smoke.test.tsx - the
// worked example for this exact gate.
async function createOperation() {
  fireEvent.click(screen.getByText('Tool'))
  fireEvent.click(screen.getByText('EM6'))
  fireEvent.click(screen.getByText('Heights'))
  await waitFor(() => {
    const refusal = screen.queryByTestId('contour-height-preflight-error')
    if (refusal) throw new Error(refusal.textContent ?? 'Contour Smart Height preflight refused without a message')
    const create = screen.getByTestId('op-create') as HTMLButtonElement
    expect(create.disabled, `Create disabled: ${create.getAttribute('data-tooltip')} | ${screen.queryByTestId('contour-height-preflight')?.textContent?.slice(0, 300)}`).toBe(false)
  })
  fireEvent.click(screen.getByTestId('op-create'))
}

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

async function reloadPersistedProject() {
  const persisted = mem.get('cnc-cam-project')
  expect(persisted, 'the operation was not written to persisted storage').toBeTruthy()
  await act(async () => {
    useCamStore.getState().newProject()
    mem.set('cnc-cam-project', persisted!)
    await useCamStore.persist.rehydrate()
  })
}

function loopsBBox(loops: Loop2D[]) {
  const pts = loops.flatMap((l) => l.points)
  return {
    minX: Math.min(...pts.map((p) => p.x)), maxX: Math.max(...pts.map((p) => p.x)),
    minY: Math.min(...pts.map((p) => p.y)), maxY: Math.max(...pts.map((p) => p.y)),
  }
}
/** The loops the store handed the worker for the LAST compute. */
function lastComputedLoops(): Loop2D[] {
  const last = workerRequests[workerRequests.length - 1]
  expect(last, 'no toolpath worker request was made').toBeTruthy()
  return last.payload.loops ?? []
}

describe('WO-114: the wizard never offers an edge pick it cannot honour', () => {
  it('a viewport that cannot report modeled-body edge hits gets NO Pick edges button', () => {
    stubViewport({ edgePickCapable: false })
    seedProject()
    openWizardOn(MODEL_ID)

    expect(screen.queryByTestId('model-pick-edges')).toBeNull()
    // ...while the derive block IS rendered, so the absence is edge-specific
    // and not "the whole block is hidden".
    expect(screen.getByTestId('brep-section-z')).toBeTruthy()
  })

  it('an imported B-rep source still offers its own Pick edges (existing path unchanged)', () => {
    stubViewport({ edgePickCapable: false })
    seedProject()
    openWizardOn(BREP_ID)

    expect(screen.getByTestId('brep-pick-edges')).toBeTruthy()
    // The modeled-body button is a DIFFERENT control: the brep path lands a
    // one-time Loop2D snapshot, this one persists a durable ModelReference.
    expect(screen.queryByTestId('model-pick-edges')).toBeNull()
  })

  it('both halves of the gate are named, and each one alone is not enough', () => {
    // The op-type half: only ops that bind a modeled body as a computable
    // profile can consume a picked chain. WO-1924 widened it from Contour to
    // the whole profile family (Pocket, Adaptive Clearing).
    for (const opType of ['contour_2d', 'pocket_2d', 'adaptive_clearing_2d'] as const) {
      expect(modelBodyEdgeChainBindingCapability(opType)).toEqual({ supported: true, reason: '' })
      expect(modelBodyEdgeChainBindingSupported(opType)).toBe(true)
    }
    // WO-1939 moved Engrave, WO-1940 V-carve and WO-1941 Chamfer to the supported side.
    for (const opType of ['thread_mill'] as const) {
      const capability = modelBodyEdgeChainBindingCapability(opType)
      expect(capability.supported).toBe(false)
      expect(capability.reason).toContain(opType) // refused BY NAME, not silently
    }
    // The viewport half.
    expect(viewportSupportsModelEdgePick({})).toBe(false)
    expect(viewportSupportsModelEdgePick(null)).toBe(false)
    expect(viewportSupportsModelEdgePick({ [MODEL_EDGE_PICK_VIEWPORT_CAPABILITY]: () => true })).toBe(true)
    // Neither half alone offers the pick.
    expect(modelBodyEdgePickOffered('contour_2d', {})).toBe(false)
    expect(modelBodyEdgePickOffered('thread_mill', { [MODEL_EDGE_PICK_VIEWPORT_CAPABILITY]: () => true })).toBe(false)
    expect(modelBodyEdgePickOffered('contour_2d', { [MODEL_EDGE_PICK_VIEWPORT_CAPABILITY]: () => true })).toBe(true)
  })

  it('the production CNCViewport really advertises the capability (WO-113), so this is not a stub-only path', async () => {
    const { CNCViewport } = await import('../../components/viewport/CNCViewport')
    // Probed through the SAME predicate the wizard uses, on the real class's
    // prototype - if WO-113's capability were removed, the button would vanish
    // in the product and this test would say so.
    expect(viewportSupportsModelEdgePick(CNCViewport.prototype)).toBe(true)
  })

  it('a capable viewport DOES get the button on a modeled body', () => {
    seedProject()
    openWizardOn(MODEL_ID)

    expect(screen.getByTestId('model-pick-edges')).toBeTruthy()
    expect(screen.getByTestId('model-edge-readout').textContent).toContain('No edges picked yet')
  })
})

describe('WO-114: picking a border contour on a modeled body, end to end', () => {
  it('picking the inner border and saving persists a durable edge-chain ModelReference', async () => {
    seedProject()
    openWizardOn(MODEL_ID)
    pickInnerBorderThroughWizard()

    expect(screen.queryByTestId('model-edge-pick-error')).toBeNull()
    expect(screen.getByTestId('model-edge-readout').textContent).toContain('4 edge(s) bound')

    await createOperation()
    await waitFor(() => { expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1) })

    expect(currentOp().modelReferences).toEqual([
      {
        bodyId: BODY_ID,
        modelItemId: 'legacy',
        stableIds: INNER_EDGE_IDS,
        role: MODEL_EDGE_CHAIN_ROLE,
      },
    ])
  })

  it('the operation really computes, and it computes THAT contour - not the whole body', async () => {
    seedProject()
    openWizardOn(MODEL_ID)
    pickInnerBorderThroughWizard()
    await createOperation()

    await waitFor(() => { expect(workerRequests.length).toBeGreaterThan(0) })
    await waitFor(() => {
      expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    })
    const bb = loopsBBox(lastComputedLoops())
    // The 10x10 inner border, NOT the 40x40 body outline the whole-body
    // profile default would have produced.
    expect(bb.maxX - bb.minX).toBeCloseTo(2 * INNER_HALF, 3)
    expect(bb.maxY - bb.minY).toBeCloseTo(2 * INNER_HALF, 3)
    expect((bb.maxX + bb.minX) / 2).toBeCloseTo(0, 3)
  })

  it('an OPEN pick (two edges of the square) is refused BY NAME and nothing is bound', () => {
    seedProject()
    openWizardOn(MODEL_ID)

    fireEvent.click(screen.getByTestId('model-pick-edges'))
    const table = initialEdgeTable()
    for (const id of INNER_EDGE_IDS.slice(0, 2)) {
      const index = table.edgeIds.indexOf(id)
      act(() => { capturedPickCallback!({ geoId: MODEL_ID, kind: 'edge', index, isModelEdge: true }, true) })
    }
    fireEvent.click(screen.getByTestId('model-edges-done'))

    expect(screen.getByTestId('model-edge-pick-error').textContent).toMatch(/do not form a closed chain/)
    expect(screen.getByTestId('model-edge-readout').textContent).toContain('No edges picked yet')
  })

  it('a hit that is not a modeled-body edge is refused rather than bound by index', () => {
    seedProject()
    openWizardOn(MODEL_ID)

    fireEvent.click(screen.getByTestId('model-pick-edges'))
    act(() => { capturedPickCallback!({ geoId: MODEL_ID, kind: 'edge', index: 0 }, true) })

    expect(screen.getByTestId('model-edge-pick-banner-error').textContent)
      .toMatch(/not a modeled-body edge/)
  })
})

// ---------------------------------------------------------------------------
// THE REQUIRED ASSERTION (WO-114's reason for existing).
//
// WO-095's audit, finding 3: after picking an edge chain on body A, switching
// Source to body B and saving persisted A's edge reference against B, and store
// compute silently fell through to B's whole-body profile. The operator gets a
// toolpath from geometry they never chose, with no error.
//
// Both layers are asserted, because either one alone leaves a live hole: the
// wizard (which must never MINT a mismatched reference) and store compute
// (which must never HONOUR one - every project saved before this fix can still
// carry one).
// ---------------------------------------------------------------------------
describe('WO-114 REQUIRED: a chain picked on body A can never be applied to body B', () => {
  it('switching Source from A to B drops the chain, SAYS SO, and saves no edge reference', async () => {
    seedProject()
    openWizardOn(MODEL_ID)
    pickInnerBorderThroughWizard()
    expect(screen.getByTestId('model-edge-readout').textContent).toContain('4 edge(s) bound')

    // The operator changes their mind about the source part.
    selectSource(MODEL_B_ID)

    // (a) The chain is no longer presented as bound...
    expect(screen.getByTestId('model-edge-readout').textContent).toContain('No edges picked yet')
    // (b) ...and the drop is SAID, naming both bodies, not silent.
    const notice = screen.getByTestId('model-edge-chain-dropped').textContent ?? ''
    expect(notice).toContain(BODY_ID)
    expect(notice).toContain('Model F2')
    expect(notice).toMatch(/NOT applied/)

    await createOperation()
    await waitFor(() => { expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1) })

    // (c) Nothing carrying A's edges was persisted against B.
    const refs = currentOp().modelReferences ?? []
    expect(refs.some((r) => r.role === MODEL_EDGE_CHAIN_ROLE)).toBe(false)
    expect(JSON.stringify(refs)).not.toContain(BODY_ID)

    // (d) The op computed B's OWN 30x30 profile - the honest whole-body default
    //     for a source with no binding - and reached it by an explicit drop,
    //     not by a find() that missed.
    await waitFor(() => {
      expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    })
    const bb = loopsBBox(lastComputedLoops())
    expect(bb.maxX - bb.minX).toBeCloseTo(2 * B_HALF, 3)
    expect(bb.maxY - bb.minY).toBeCloseTo(2 * B_HALF, 3)
  })

  it('switching Source to a NON-model part (imported B-rep) also drops it and says so', () => {
    seedProject()
    openWizardOn(MODEL_ID)
    pickInnerBorderThroughWizard()

    selectSource(BREP_ID)

    // The derive block for a brep source does not render the modeled-body pick
    // row at all, so the notice deliberately lives OUTSIDE that block - this is
    // exactly the case where a silent drop would be least visible.
    expect(screen.queryByTestId('model-pick-edges')).toBeNull()
    expect(screen.getByTestId('model-edge-chain-dropped').textContent).toMatch(/NOT applied/)
  })

  it('STORE: a saved model edge chain against a NON-model source refuses before computing that source', async () => {
    seedProject()
    openWizardOn(MODEL_ID)
    pickInnerBorderThroughWizard()
    await createOperation()
    await waitFor(() => { expect(currentOp().status).toBe('ready') })
    const opId = currentOp().id

    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          setups: s.project.setups.map((setup) => ({
            ...setup,
            operations: setup.operations.map((candidate) => candidate.id === opId ? {
              ...candidate,
              status: 'pending',
              toolpathMoves: undefined,
              params: { ...candidate.params, geometryId: BREP_ID },
            } : candidate) as Operation[],
          })),
        },
      }))
    })

    workerRequests = []
    await act(async () => {
      await useCamStore.getState().computeOperationToolpath('setup-1', opId)
    })

    expect(currentOp().status).toBe('unsupported')
    expect(currentOp().errorMessage).toContain('Imported STEP')
    expect(currentOp().errorMessage).toMatch(/picked edge chain/)
    expect(workerRequests).toHaveLength(0)
    expect(currentOp().toolpathMoves).toBeFalsy()
  })

  it('STORE: an already-saved op carrying body A\'s chain against body B REFUSES BY NAME - it never falls through to B\'s profile', async () => {
    // A project saved before this fix: the operation's source is body B, but
    // its persisted edge-chain reference names body A. That state is
    // unreachable through the FIXED wizard, so it is injected - which is
    // exactly what loading such a .camproject does.
    //
    // The op itself is authored by the REAL wizard on body B first, so it is a
    // fully-formed, computable operation (heights, height intent, tool, params).
    // That matters: it means this test's red, when the guard is removed, is the
    // actual defect - B's whole-body profile computed silently - and not an
    // incidental failure on a hand-built op shape.
    seedProject()
    openWizardOn(MODEL_B_ID)
    await createOperation()
    await waitFor(() => { expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1) })
    await waitFor(() => {
      expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    })
    // Baseline: with no binding at all, this op computes B's own 30x30 profile.
    // That is the geometry the silent fall-through would hand the operator.
    const baseline = loopsBBox(lastComputedLoops())
    expect(baseline.maxX - baseline.minX).toBeCloseTo(2 * B_HALF, 3)
    const opId = currentOp().id

    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          setups: s.project.setups.map((setup) => ({
            ...setup,
            operations: setup.operations.map((o) => (o.id === opId ? {
              ...o,
              status: 'pending',
              toolpathMoves: undefined,
              modelReferences: [
                { bodyId: BODY_ID, stableIds: INNER_EDGE_IDS, role: MODEL_EDGE_CHAIN_ROLE },
              ],
            } : o)) as unknown as Operation[],
          })),
        },
      }))
    })

    workerRequests = []
    await act(async () => {
      await useCamStore.getState().computeOperationToolpath('setup-1', opId)
    })

    const op = useCamStore.getState().project.setups[0].operations[0]
    expect(op.status).toBe('unsupported')
    // Named refusal: it says WHICH body the chain came from and which body the
    // op sources, so the operator can act on it.
    expect(op.errorMessage).toContain(BODY_ID)
    expect(op.errorMessage).toContain('Model F2')
    expect(op.errorMessage).toMatch(/picked edge chain/)
    // ...and, the load-bearing half: no toolpath was produced from B's profile.
    expect(workerRequests).toHaveLength(0)
    expect(op.toolpathMoves).toBeFalsy()
  })

  it('the mismatch predicate itself is the ONE shared answer both layers call', () => {
    const chain = { modelItemId: 'item-a', bodyId: 'F1', edgeStableIds: ['e0'] }
    expect(modelEdgeChainBodyMismatch(chain, { modelItemId: 'item-a', bodyId: 'F1' })).toBe(false)
    expect(modelEdgeChainBodyMismatch(chain, { modelItemId: 'item-a', bodyId: 'F2' })).toBe(true)
    // Raw body ids are only item-local: item B's F1 is a different body.
    expect(modelEdgeChainBodyMismatch(chain, { modelItemId: 'item-b', bodyId: 'F1' })).toBe(true)
    // A source with no body identity at all cannot own the chain either.
    expect(modelEdgeChainBodyMismatch(chain, undefined)).toBe(true)
    expect(modelEdgeChainBodyMismatch(chain, null)).toBe(true)
    // No chain held = nothing to mismatch.
    expect(modelEdgeChainBodyMismatch(null, { modelItemId: 'item-a', bodyId: 'F2' })).toBe(false)
    // Older references omit modelItemId and fall back to the legacy item only.
    const legacyChain = { bodyId: 'F1', edgeStableIds: ['e0'] }
    expect(modelEdgeChainBodyMismatch(legacyChain, { bodyId: 'F1' })).toBe(false)
    expect(modelEdgeChainBodyMismatch(legacyChain, { modelItemId: 'item-a', bodyId: 'F1' })).toBe(true)
  })
})

describe('WO-225 REQUIRED: every model-bound role follows compound source identity', () => {
  it.each([
    {
      caseName: 'another Model Item reusing raw body F1',
      targetGeoId: SHARED_BODY_ITEM_B_ID,
      targetItemId: 'item-b',
      targetBodyId: BODY_ID,
    },
    {
      caseName: 'a different body F2',
      targetGeoId: MODEL_B_ID,
      targetItemId: 'legacy',
      targetBodyId: BODY_B_ID,
    },
  ])('clears item A\'s machining boundary when Source changes to $caseName, including after save/reload', async ({
    targetGeoId, targetItemId, targetBodyId,
  }) => {
    seedTwoItemSharedBodyProject()
    openWizardOn(MODEL_ID)
    await pickMachiningBoundaryThroughWizard(MODEL_ID, TOP_FACE)
    expect(screen.getByTestId('machining-boundary-clear')).toBeTruthy()

    selectSource(targetGeoId)

    expect(screen.getByTestId('machining-boundary-readout').textContent).toContain('No face picked yet')
    expect(screen.queryByTestId('machining-boundary-clear')).toBeNull()
    await createOperation()
    await waitFor(() => {
      expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1)
    })
    await reloadPersistedProject()

    const reloaded = currentOp()
    expect((reloaded.params as { geometryId?: string }).geometryId).toBe(targetGeoId)
    expect(reloaded.modelReferences?.some((ref) => ref.role === 'machining-boundary') ?? false).toBe(false)
    const reloadedSource = useCamStore.getState().project.geometry.find((geo) => geo.id === targetGeoId)
    expect(reloadedSource?.modelItemId ?? 'legacy').toBe(targetItemId)
    expect(reloadedSource?.modelBody?.ref.bodyId).toBe(targetBodyId)
  })

  it.each([
    { role: 'machining-boundary' as const, label: /machining boundary/i },
    { role: 'drill-targets' as const, label: /drill targets/i },
    { role: 'bore-target' as const, label: /bore target/i },
  ])('save/reload refuses item A\'s persisted $role against item B even when both raw body ids are F1', async ({ role, label }) => {
    seedTwoItemSharedBodyProject()
    openWizardOn(SHARED_BODY_ITEM_B_ID)
    await createOperation()
    await waitFor(() => {
      expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1)
    })
    const opId = currentOp().id

    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          setups: state.project.setups.map((setup) => ({
            ...setup,
            operations: setup.operations.map((op) => op.id === opId ? {
              ...op,
              status: 'pending',
              toolpathMoves: undefined,
              modelReferences: [authorModelReference(
                'item-a', BODY_ID, [TOP_FACE], role,
              )],
            } : op) as Operation[],
          })),
        },
      }))
    })
    await reloadPersistedProject()

    workerRequests = []
    await act(async () => {
      await useCamStore.getState().computeOperationToolpath('setup-1', opId)
    })

    expect(currentOp().status).toBe('unsupported')
    expect(currentOp().errorMessage).toMatch(label)
    expect(currentOp().errorMessage).toContain('item-a')
    expect(currentOp().errorMessage).toContain('item-b')
    expect(currentOp().errorMessage).toContain('Item B shared F1')
    expect(currentOp().errorMessage).toMatch(/another item or body/i)
    expect(workerRequests).toHaveLength(0)
    expect(currentOp().toolpathMoves).toBeFalsy()
  })

  it('the shared identity predicate rejects same-body ids from different Model Items', () => {
    expect(modelReferenceMatchesSource(
      { modelItemId: 'item-a', bodyId: BODY_ID },
      { modelItemId: 'item-a', bodyId: BODY_ID },
    )).toBe(true)
    expect(modelReferenceMatchesSource(
      { modelItemId: 'item-a', bodyId: BODY_ID },
      { modelItemId: 'item-b', bodyId: BODY_ID },
    )).toBe(false)
    expect(modelReferenceMatchesSource(
      { bodyId: BODY_ID },
      { modelItemId: 'item-a', bodyId: BODY_ID },
    )).toBe(false)
  })
})

describe('WO-114: the binding survives a model rebuild, or refuses out loud', () => {
  async function readyOpBoundToInnerBorder() {
    seedProject()
    openWizardOn(MODEL_ID)
    pickInnerBorderThroughWizard()
    await createOperation()
    await waitFor(() => { expect(useCamStore.getState().project.setups[0].operations).toHaveLength(1) })
    await waitFor(() => {
      expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    })
    return currentOp().id
  }

  it('after a rebuild that re-orders the edge table and MOVES the hole, the same physical edges are bound', async () => {
    const opId = await readyOpBoundToInnerBorder()

    // The model is edited: the hole moves, and the kernel re-emits its edge
    // table inner-first. Every face survives, so every edge id survives.
    rebuildBodyWith(rebuiltEdgeTable())
    workerRequests = []
    await act(async () => { await useCamStore.getState().computeOperationToolpath('setup-1', opId) })

    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    const bb = loopsBBox(lastComputedLoops())
    // Still the 10x10 hole border - now at its NEW position. A positional
    // binding would have produced the 40x40 outer square instead.
    expect(bb.maxX - bb.minX).toBeCloseTo(2 * INNER_HALF, 3)
    expect(bb.maxY - bb.minY).toBeCloseTo(2 * INNER_HALF, 3)
    expect((bb.maxX + bb.minX) / 2).toBeCloseTo(HOLE_MOVED_X, 3)
    // A clean, exact re-bind says nothing - no spurious "we guessed" note.
    expect(currentOp().modelReferenceNote).toBeUndefined()
  })

  it('after a rebuild that DELETES the hole, the operation refuses BY NAME instead of cutting something else', async () => {
    const opId = await readyOpBoundToInnerBorder()
    const before = currentOp().toolpathMoves

    rebuildBodyWith(holeDeletedEdgeTable())
    workerRequests = []
    await act(async () => { await useCamStore.getState().computeOperationToolpath('setup-1', opId) })

    expect(currentOp().status).toBe('unsupported')
    expect(currentOp().errorMessage).toMatch(/picked edge chain/)
    expect(currentOp().errorMessage).toMatch(/no longer exists on this body's current/)
    expect(currentOp().errorMessage).toContain(INNER_EDGE_IDS[0])
    // It never fell back to the whole-body outline or the outer border.
    expect(workerRequests).toHaveLength(0)
    expect(before).toBeTruthy()
  })

  it('a lineage re-bind is honoured but REPORTED on the operation, never silent', async () => {
    const opId = await readyOpBoundToInnerBorder()

    // The hole's own side face was re-identified by the kernel (a rename that
    // keeps one edge on the same face pair): the persisted id is gone, but its
    // base pair still owns exactly ONE current edge, so lineage names the
    // survivor. That is a real answer - and one the operator must be told.
    const migratedId = `${INNER_EDGE_IDS[0]}@m1_2_3_l4`
    const rebuilt = rebuiltEdgeTable()
    rebuilt.edgeIds[rebuilt.edgeIds.indexOf(INNER_EDGE_IDS[0])] = migratedId
    rebuildBodyWith(rebuilt)
    workerRequests = []
    await act(async () => { await useCamStore.getState().computeOperationToolpath('setup-1', opId) })

    expect(currentOp().status, `errorMessage: ${currentOp().errorMessage}`).toBe('ready')
    expect(currentOp().modelReferenceNote).toMatch(/re-bound by lineage/)
    expect(currentOp().modelReferenceNote).toContain(INNER_EDGE_IDS[0])
    const bb = loopsBBox(lastComputedLoops())
    expect(bb.maxX - bb.minX).toBeCloseTo(2 * INNER_HALF, 3)
  })
})
