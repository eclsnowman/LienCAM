// @vitest-environment jsdom
//
// WO-3202 (WO-3170 Slice B) journey: Resize Hole and the picked-wall Bore read
// ONE revision-bound recognition result. Real workbench, real in-process
// occt-wasm kernel, the store's own Bore compute. The client is wrapped only
// to COUNT kernel calls: recognizeFeatures (recognition) apart from
// editFeature (the edit-time kernel revalidation, which must remain).
//
// Measured: the result token and common feature each consumer adapter
// selected (Resize Hole via the workbench hooks seam, Bore via
// readModelBodyFaceFacts' observer), the recognition calls for the resized
// body's revision, and the emitted Bore toolpath coordinates. After the Model
// tab closes, the Bore read is served by the evidence carried into the
// holder for that exact archive -- no kernel replay.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { waitForLoadedModel3d as waitFor } from './loadTolerantWaitFor'
import type { SolidsWorkbenchHooks } from '../../components/model3d'
import { createLocalGeomService, type GeomClient } from '../../geom'
import type { BodyHandle, FaceEditRequest, OpResult } from '../../geom/geom-service'
import { createFakeSceneRuntime, type FakeSceneRuntime } from './fakeSceneRuntime'
import { stubCanvas2d } from './stubCanvas2d'
import { mintRectangleSketch } from './mintRectangleSketch'
import type { FeatureResultSelection } from '../../lib/geometry/partFeatureBinding'
import type { ModelBodyFaceBinding } from '../../lib/cam/modelBodyHoleRecognition'
import type {
  BoundingBox, HeightParams, ImportedGeometry, ModelItemPlacementRecord, Operation, PhysicalStock, Project,
  SceneStock, Setup, Tool, ToolpathMove, Vec3, WCS,
} from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'

const memory = new Map<string, string>()
const memoryStorage: Storage = {
  get length() { return memory.size },
  clear: () => memory.clear(),
  getItem: (key: string) => memory.get(key) ?? null,
  key: (index: number) => Array.from(memory.keys())[index] ?? null,
  removeItem: (key: string) => { memory.delete(key) },
  setItem: (key: string, value: string) => { memory.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memoryStorage, configurable: true })

const { SolidsWorkbenchPage } = await import('../../components/model3d')
const { useCamStore } = await import('../../store')
const {
  readModelBodyFaceBinding,
  readModelBodyFaceFacts,
  __observeModelBodyFaceFactsForTests,
  __setModelBodyHeadlessClientFactoryForTests,
} = await import('../../lib/cam/modelBodyHoleRecognition')
const { archiveFeatureResultScope, getModelSession, resetDocumentHolder } = await import('../../doc/documentHolder')
const { buildBoreToolpath } = await import('../../lib/cam/bore2d')

// ── Kernel call accounting ────────────────────────────────────────────────

let recognized: BodyHandle[] = []
let holeEdits: FaceEditRequest[] = []
let headlessMounts = 0

function countingClient(): GeomClient {
  const real = createLocalGeomService()
  return {
    ...real,
    recognizeFeatures: (handle) => {
      recognized.push(handle)
      return real.recognizeFeatures(handle)
    },
    editFeature: async (request: FaceEditRequest): Promise<OpResult> => {
      if (request.kind === 'holeDiameter') holeEdits.push(request)
      return real.editFeature(request)
    },
  }
}

function recognitionsOf(handle: BodyHandle | undefined): number {
  return recognized.filter((h) => h === handle).length
}

// ── Bore compute: the store's worker runs the REAL Bore engine ───────────

interface WorkerRequest { type?: string; payload?: Record<string, unknown> & { opId: string }; request?: unknown }
let boreRequests: WorkerRequest[] = []
let boreMoves: ToolpathMove[] = []
let originalWorker: typeof Worker | undefined

class EngineWorker {
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: ((event: ErrorEvent) => void) | null = null
  postMessage(data: WorkerRequest): void {
    // The off-page post-process worker (store/toolpathPostprocess.ts): report
    // "cannot start a module worker" so it runs its own in-page fallback.
    if (data.request !== undefined) {
      queueMicrotask(() => this.onerror?.({ preventDefault() {} } as unknown as ErrorEvent))
      return
    }
    if (data.type !== 'COMPUTE_BORE' || data.payload === undefined) return
    boreRequests.push(data)
    const moves = buildBoreToolpath(data.payload as never)
    boreMoves = moves
    queueMicrotask(() => this.onmessage?.({
      data: { type: 'TOOLPATH_COMPLETE', opId: data.payload!.opId, moves, computeTimeMs: 1 },
    } as MessageEvent))
  }
  terminate(): void { /* no-op */ }
  addEventListener(): void { /* no-op */ }
  removeEventListener(): void { /* no-op */ }
}

let restoreCanvas2d: (() => void) | null = null
let observed: Array<{ facts: ModelBodyFaceBinding; bodyId: string; faceStableId: string }> = []
beforeEach(() => {
  memory.clear()
  resetDocumentHolder()
  restoreCanvas2d = stubCanvas2d()
  recognized = []
  holeEdits = []
  headlessMounts = 0
  boreRequests = []
  boreMoves = []
  observed = []
  // Optional call: the fail-first run on the pre-WO-3202 source lacks this seam.
  __observeModelBodyFaceFactsForTests?.((facts, bodyId, faceStableId) => { observed.push({ facts, bodyId, faceStableId }) })
  __setModelBodyHeadlessClientFactoryForTests(() => {
    headlessMounts++
    return createLocalGeomService()
  })
  originalWorker = globalThis.Worker
  ;(globalThis as { Worker?: unknown }).Worker = EngineWorker
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 100, y: 80, z: 30 } }),
  }
})
afterEach(() => {
  cleanup()
  restoreCanvas2d?.()
  restoreCanvas2d = null
  __observeModelBodyFaceFactsForTests?.(null)
  __setModelBodyHeadlessClientFactoryForTests(null)
  ;(globalThis as { Worker?: unknown }).Worker = originalWorker
  delete (window as unknown as Record<string, unknown>).__cncViewport
  resetDocumentHolder()
})

// ── Workbench drive (same seams as SolidsWorkbenchPage.resizeHole.test.tsx) ─

function hooks(): SolidsWorkbenchHooks {
  const value = window.__solidsWorkbenchHooks
  if (value === undefined) throw new Error('__solidsWorkbenchHooks not installed')
  return value
}

function harness(): { createSceneRuntime: () => FakeSceneRuntime; runtime: () => FakeSceneRuntime } {
  let runtime: FakeSceneRuntime | null = null
  const createSceneRuntime = (): FakeSceneRuntime => {
    const rt = createFakeSceneRuntime()
    rt.projectToCanvasResult = { x: 200, y: 200 }
    runtime = rt
    return rt
  }
  return { createSceneRuntime, runtime: () => runtime as FakeSceneRuntime }
}

function commitNumericField(testId: string, raw: string): void {
  const input = screen.getByTestId(testId).querySelector('input') as HTMLInputElement
  fireEvent.change(input, { target: { value: raw } })
  fireEvent.blur(input)
}

async function buildBox(): Promise<void> {
  await mintRectangleSketch({ width: '40', height: '20', offset: '10' })
  await waitFor(() => expect(screen.getByTestId('feature-row-SK1')).toBeTruthy())
  fireEvent.click(screen.getByTestId('workbench-extrude'))
  commitNumericField('extrude-distance', '20')
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
  await waitFor(() => expect(hooks().getBodyHandle('F1')).not.toBeUndefined(), { timeout: 20_000 })
}

async function drillBlindHole(rt: () => FakeSceneRuntime, x: number, y: number, diameter: string, depth: string): Promise<void> {
  fireEvent.click(screen.getByTestId('workbench-hole'))
  rt().rayOverride = { origin: { x, y, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
  await waitFor(() => expect(screen.getByTestId('hole-diameter')).toBeTruthy())
  commitNumericField('hole-diameter', diameter)
  commitNumericField('hole-blind-distance', depth)
  fireEvent.click(screen.getByTestId('dialog-shell-apply'))
}

async function settledResizeHint(): Promise<void> {
  await waitFor(() => expect(screen.getByTestId('solids-workbench-resizehole-hint')).toBeTruthy(), { timeout: 20_000 })
  await waitFor(
    () => expect(screen.getByTestId('solids-workbench-resizehole-hint').textContent).not.toMatch(/recognizing/i),
    { timeout: 20_000 },
  )
}

function pickHole(rt: () => FakeSceneRuntime, x: number, y: number): void {
  rt().rayOverride = { origin: { x, y, z: 100 }, direction: { x: 0, y: 0, z: -1 } }
  fireEvent.pointerMove(screen.getByTestId('solids-workbench-canvas'))
  fireEvent.click(screen.getByTestId('solids-workbench-canvas'))
}

/** What the Resize Hole adapter selected (captured, asserted later so the
 *  recognition counts are the first claim this journey tests). */
function selection(): FeatureResultSelection | null {
  return hooks().getResizeHoleFeatureSelection?.() ?? null
}

/** The resized hole's cylindrical wall: a kernel SNAPSHOT read (not a
 *  recognition call), the 8 mm cylinder on F3. */
async function wallFaceOf(handle: BodyHandle): Promise<string> {
  const snapshots = await hooks().client.snapshotsFor(handle)
  const walls = Object.entries(snapshots).filter(([, s]) => s.type === 'cylinder' && Math.abs((s.radius ?? 0) - 4) < 1e-6)
  expect(walls).toHaveLength(1)
  return walls[0][0]
}

// ── Setup -> Bore on the resized body ─────────────────────────────────────

const PLACEMENT: ModelItemPlacementRecord = {
  modelItemId: 'legacy', position: { x: 10, y: 5, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
}

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const stock: PhysicalStock = {
  id: 'stock-1', name: 'Stock 1', mode: 'explicit',
  bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 100, y: 80, z: 30 }),
  position: { x: 0, y: 0, z: 0 },
} as PhysicalStock

const boreTool: Tool = {
  id: 'wo3202-bore-tool', name: 'EM3', type: 'flat_end_mill', diameter: 3,
  fluteLength: 30, shankDiameter: 3, overallLength: 60, numberOfFlutes: 2,
} as Tool

function installBore(bodyId: string, faceId: string): string {
  const geo = {
    id: `modelbody:${bodyId}`, name: 'Box', filename: '', type: 'model', format: 'model',
    loaded: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 20, z: 20 }),
    stockId: stock.id, modelItemId: 'legacy',
    modelBody: { ref: { bodyId, stableIds: [], version: 1 } },
  } as unknown as ImportedGeometry
  const loopId = `mbore:${faceId}`
  const heights = {
    clearanceHeight: 40, clearanceHeightMode: 'absolute', retractHeight: 35, feedHeight: 32,
    topHeight: 0, topHeightMode: 'stock_top',
    bottomHeight: 0, bottomHeightMode: 'selected_face', selectedFaceZ: 0, bottomManual: false,
  }
  const params = {
    geometryId: geo.id, loopIds: [loopId], direction: 'climb', sortStrategy: 'nearest_neighbor',
    geometrySource: 'cylinder', targetDiameter: 8, perBoreDepth: true, perBoreDepthOverrides: {},
    heightReference: 'stock_top', planeOffset: -5,
  }
  const op = {
    id: 'wo3202-bore', name: 'Bore 1', type: 'bore', enabled: true, status: 'pending',
    toolId: boreTool.id, geometrySelections: [loopId],
    modelReferences: [{ bodyId, stableIds: [faceId], role: 'bore-target' }],
    heights,
    passes: { stepdown: 2, stepover: 1, stockToLeave: 0, floorStockToLeave: 0, finishPasses: 1, springPasses: 0 },
    linking: {
      entryType: 'ramp_helical', rampAngle: 3, rampLength: 10, leadInRadius: 0, leadOutRadius: 0,
      retractType: 'full', transitionType: 'safe_height',
    },
    params,
    smartHeight: smartHeightAuthorityFixture('bore', {
      setupId: 'setup-1', heights: heights as HeightParams, params, geometryIds: [geo.id],
      stockId: stock.id, explicitDepthMm: 5,
    }),
  } as unknown as Operation
  const setup = {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      stockId: stock.id,
    } as WCS,
    stock: {
      type: 'rectangular', width: 100, height: 80, depth: 30,
      offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum',
    },
    operations: [op], notes: '',
  } as Setup
  const sceneStock = {
    mode: 'fixed', autoOffsetXY: 0, autoOffsetZTop: 0,
    fixedWidth: 100, fixedHeight: 80, fixedDepth: 30, fixedStocks: [],
  } as SceneStock
  useCamStore.setState((state) => ({
    toolLibrary: [boreTool],
    project: {
      ...state.project,
      geometry: [geo], stocks: [stock], sceneStock,
      modelItemPlacements: [PLACEMENT],
      setups: [setup], activeSetupId: 'setup-1',
    } as Project,
  }))
  return op.id
}

function boreOp(): Operation {
  return useCamStore.getState().project.setups[0].operations[0]
}

/** XY centre and radius of the Bore's cutting moves at their deepest Z. */
function finishOrbit(moves: readonly ToolpathMove[]): { cx: number; cy: number; radius: number } {
  const cuts = moves.filter((m) => m.type !== 'rapid')
  const deepest = Math.min(...cuts.map((m) => m.z))
  const ring = cuts.filter((m) => Math.abs(m.z - deepest) < 1e-6)
  const xs = ring.map((m) => m.x)
  const ys = ring.map((m) => m.y)
  const cx = (Math.min(...xs) + Math.max(...xs)) / 2
  const cy = (Math.min(...ys) + Math.max(...ys)) / 2
  return { cx, cy, radius: Math.max(...ring.map((m) => Math.hypot(m.x - cx, m.y - cy))) }
}

describe('WO-3202: Resize Hole and picked Bore read one revision-bound feature result', () => {
  it('resize 6 -> 8, then Bore on the same wall: one recognition per revision, same token and feature at both consumers, the Bore cuts the new size', async () => {
    const h = harness()
    // The App-hosted workspace (embedded): its unmount stashes the document.
    useCamStore.setState({ workspace: 'part' })
    render(<SolidsWorkbenchPage embedded createClient={countingClient} createSceneRuntime={h.createSceneRuntime} />)
    await waitFor(() => expect(screen.getByTestId('solids-workbench-status').textContent).toMatch(/ready/i), { timeout: 20_000 })
    await buildBox()
    await drillBlindHole(h.runtime, 20, 5, '6', '8')
    await waitFor(() => expect(hooks().getBodyHandle('F2')).not.toBeUndefined(), { timeout: 20_000 })
    await waitFor(() => expect((screen.getByTestId('workbench-resize-hole') as HTMLButtonElement).disabled).toBe(false))

    // Resize Hole consumer, before the edit: the 6 mm hole on F2.
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await settledResizeHint()
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('6 mm')
    const before = selection()

    // Apply 8 mm through the existing preview/Apply path.
    const input = screen.getByTestId('resize-hole-anchor-entry-input') as HTMLInputElement
    fireEvent.change(input, { target: { value: '8' } })
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry-status').getAttribute('data-status')).toBe('ready'), { timeout: 20_000 })
    fireEvent.keyDown(input, { key: 'Enter' })
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull(), { timeout: 20_000 })
    const resizedId = hooks().dag.featureOrder().find((id) => hooks().dag.getNode(id)?.payload.opType === 'resizeHole')
    expect(resizedId).toBe('F3')
    // The edit-time kernel revalidation ran (editFeature), apart from recognition.
    expect(holeEdits.length).toBeGreaterThan(0)
    await settledResizeHint()

    // Resize Hole consumer, after the edit: the NEW result on F3.
    pickHole(h.runtime, 20, 5)
    await waitFor(() => expect(screen.getByTestId('resize-hole-anchor-entry')).toBeTruthy(), { timeout: 20_000 })
    expect(screen.getByTestId('resize-hole-anchor-entry-current').textContent).toContain('8 mm')
    const after = selection()
    fireEvent.keyDown(window, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByTestId('resize-hole-anchor-entry')).toBeNull())
    fireEvent.click(screen.getByTestId('workbench-resize-hole'))
    await waitFor(() => expect(screen.queryByTestId('solids-workbench-resizehole-hint')).toBeNull())

    const f3 = hooks().getBodyHandle('F3')
    expect(f3).not.toBeUndefined()
    expect(recognitionsOf(f3), 'F3 at this revision is recognized once').toBe(1)
    const wallId = await wallFaceOf(f3!)

    // Bore consumer: switch to Setup (the Model workspace stays mounted,
    // suspended), Bore -> Pick face (readModelBodyFaceFacts) and the store's
    // compute: both read the same result, no new recognition.
    useCamStore.getState().setWorkspace('cam')
    // readModelBodyFaceBinding: readModelBodyFaceFacts (the Pick face call)
    // plus the result it read; the pre-WO-3202 source only has the plain call.
    const readFace = (bodyId: string, faceId: string, item: string): Promise<ModelBodyFaceBinding> =>
      typeof readModelBodyFaceBinding === 'function'
        ? readModelBodyFaceBinding(bodyId, faceId, item)
        : readModelBodyFaceFacts(bodyId, faceId, item).then((facts) => ({ facts }))
    const picked = await readFace('F3', wallId, 'legacy')
    expect(picked.facts.snapshot.type).toBe('cylinder')
    expect(picked.facts.snapshot.radius).toBeCloseTo(4, 5)
    const opId = installBore('F3', wallId)
    observed = []
    await useCamStore.getState().computeOperationToolpath('setup-1', opId)
    expect(boreOp().status, `errorMessage: ${boreOp().errorMessage}`).toBe('ready')
    expect(recognitionsOf(f3), 'Bore pick and compute recognized nothing again').toBe(1)
    expect(headlessMounts).toBe(0)

    // Both consumer adapters hold the same token and common feature.
    expect(before?.token).toMatchObject({ route: 'live', modelItemId: 'legacy', bodyId: 'F2' })
    expect(before?.featureId).toMatch(/^feature:/)
    expect(after?.token).toMatchObject({ route: 'live', modelItemId: 'legacy', bodyId: 'F3' })
    expect(after!.token.revision).toBeGreaterThan(before!.token.revision)
    expect(after?.featureId).toMatch(/^feature:/)
    expect(after?.featureId).not.toBe(before?.featureId)
    const sessionResult = getModelSession('legacy')?.featureResults.completed(after!.token)
    expect(sessionResult?.features.features.find((f) => f.id === after!.featureId)?.references).toContain(wallId)
    expect(picked.result?.token).toEqual(after!.token)
    expect(picked.feature?.id).toBe(after!.featureId)
    expect(observed.map((o) => [o.bodyId, o.faceStableId])).toEqual([['F3', wallId]])
    expect(observed[0].facts.result?.token).toEqual(after!.token)
    expect(observed[0].facts.feature?.id).toBe(after!.featureId)

    // Emitted Bore toolpath: on the hole axis (placement honoured) and sized
    // for the NEW 8 mm wall with a 3 mm tool (orbit radius (8 - 3) / 2).
    expect(boreRequests).toHaveLength(1)
    const loops = (boreRequests[0].payload as unknown as { loops: Array<{ id: string }> }).loops
    expect(loops.map((l) => l.id)).toEqual([`mbore:${wallId}`])
    const orbit = finishOrbit(boreMoves)
    expect(orbit.cx).toBeCloseTo(20 + PLACEMENT.position.x, 2)
    expect(orbit.cy).toBeCloseTo(5 + PLACEMENT.position.y, 2)
    expect(orbit.radius).toBeCloseTo(2.5, 2)

    // Close the Model tab. The holder carries the session's committed result
    // into the archive it just captured; reopening Bore needs no replay.
    const recognitionsBeforeClose = recognized.length
    cleanup()
    const scope = archiveFeatureResultScope('legacy')
    expect(scope?.memo.completedResults().map((r) => r.token.bodyId).sort()).toContain('F3')
    const reread = await readFace('F3', wallId, 'legacy')
    expect(headlessMounts, 'the carried result served the read').toBe(0)
    expect(recognized.length).toBe(recognitionsBeforeClose)
    expect(reread.result?.token).toMatchObject({ route: 'archive', modelItemId: 'legacy', bodyId: 'F3', revision: scope!.serial })
    expect(reread.feature?.id).toBe(after!.featureId)
    expect(reread.facts.snapshot.radius).toBeCloseTo(4, 5)
  }, 180_000)
})
