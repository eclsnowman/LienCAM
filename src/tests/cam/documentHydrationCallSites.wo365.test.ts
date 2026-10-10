// @vitest-environment jsdom
//
// WO-365: WO-362 fixed exactly ONE call site (SetupModal's bore-pick click
// handler) for the reachability gap it found -- an ordinary browser refresh
// rehydrates `project` (modelItems incl. documentStorageKey) via Zustand's
// persistMerge, a boundary that never touches documentHolder's in-memory
// maps, so any READ path that never visits the Model tab this page load asks
// collectDocumentArchive() for a document nothing in this load ever stashed
// and misreports "no 3D model to read" on a project whose model is plainly
// on screen. WO-362 named the other call sites and correctly left them alone
// (out of its lane). This WO wires the same self-heal
// (`ensureDocumentArchiveHydrated`, documentHolder.ts) into the five it owns:
//
//   - NewOperationModalBody.tsx: the model bore-wall face pick (readModelBodyFaceFacts)
//   - NewOperationModalBody.tsx: the Detect-holes model-face rebind (recognizeModelBodyHoles)
//   - store/index.ts: deriveBrepLayer's 'holes' kind (recognizeModelBodyHoles)
//   - store/index.ts: computeOperationToolpath's drill-targets re-derive (recognizeModelBodyHoles)
//   - store/index.ts: computeOperationToolpath's bore-target re-derive (readModelBodyFaceFacts)
//
// Same fixture, same technique as WO-362's own test
// (boreZeroUnresolvedOwner.wo362.test.ts): load the real project file (a
// genuine durable checkpoint), simulate a refresh (resetDocumentHolder(),
// same storage backend), then read. The two store/index.ts call sites that
// share BYTE-IDENTICAL wiring (recognizeModelBodyHoles at the drill-targets
// branch and readModelBodyFaceFacts at the bore-target branch -- both
// `resolveOwningModelItemId(refGeo) ?? LEGACY_MODEL_ITEM_ID` then
// `ensureDocumentArchiveHydrated` then the read call) are covered by ONE
// direct test of the bore-target branch below; the drill-targets branch was
// verified by reading the diff, not given a second, structurally-redundant
// harness.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, cleanup, act, fireEvent, waitFor } from '@testing-library/react'
import { createElement } from 'react'
import * as fs from 'node:fs'
import * as path from 'node:path'
import type { Operation, Setup, PhysicalStock, SceneStock, Tool, BoundingBox, Vec3, HeightParams } from '../../types'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
import { typedMock } from '../support/typedMock'

// No real IndexedDB in this env; loadProjectFromFile's binary-cache hydrate
// reads through these (same shim as boreZeroUnresolvedOwner.wo362.test.ts).
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

// jsdom's built-in localStorage is broken under vitest's node launch flags;
// the Zustand store uses persist() which writes on every set(). Minimal
// in-memory Storage shim BEFORE importing the store (same precedent as
// boreZeroOwnerResolution.wo355.test.ts / boreZeroUnresolvedOwner.wo362.test.ts).
const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  removeItem: (k: string) => { mem.delete(k) },
  setItem: (k: string, v: string) => { mem.set(k, String(v)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const { NewOperationModal } = await import('../../components/modals/NewOperationModal')
const { useCamStore } = await import('../../store')
const { createLocalGeomService } = await import('../../geom')
const {
  resetDocumentHolder, setDocumentStorage, collectDocumentArchive,
} = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage } = await import('../../doc/persist')
const { __setModelBodyHeadlessClientFactoryForTests } = await import('../../lib/cam/modelBodyHoleRecognition')
const { modelBoreLoopId } = await import('../../lib/cam/modelBodyDerive')
const { DERIVED_STOCK_ID } = await import('../../store/migrateHierarchy')

const FIXTURE_PATH = path.resolve(
  __dirname, '../evidence/WO-362/operator-boss-pick-refuses.camproject',
)

// Operator's own file (WO-362's fixture, read-only here). The modeled body row
// (DAG "F3")'s face 6 is the bore wall (dia 15) - confirmed by direct kernel
// recognition against this exact fixture (boreZeroUnresolvedOwner.wo362.test.ts).
const BORE_FACE_INDEX = 6

function readFixtureText(): string {
  return fs.readFileSync(FIXTURE_PATH, 'utf8')
}

type PickSelection = { geoId: string; kind: 'face' | 'edge'; index: number; isModelFace?: boolean }
type PickCallback = (sel: PickSelection) => void

function installVpMock(): { getCallback: () => PickCallback | null } {
  let callback: PickCallback | null = null
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 50, y: 50, z: 5 } }),
    setBrepPickMode: (kind: 'face' | 'edge' | null, cb?: PickCallback | null) => {
      callback = kind === null ? null : (cb ?? null)
    },
  }
  return { getCallback: () => callback }
}

beforeEach(() => {
  resetDocumentHolder()
  __setModelBodyHeadlessClientFactoryForTests(() => createLocalGeomService())
  act(() => { useCamStore.getState().closeModal() })
})

afterEach(() => {
  cleanup()
  __setModelBodyHeadlessClientFactoryForTests(null)
  resetDocumentHolder()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-365: NewOperationModalBody\'s model bore-wall pick (readModelBodyFaceFacts)', () => {
  it('REPRODUCES the reachability gap: after a simulated refresh, the durable checkpoint is real but nothing in this page load has hydrated it', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    await useCamStore.getState().loadProjectFromFile(readFixtureText())
    const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!
    const modelItemId = modelGeo.modelItemId ?? 'legacy'

    resetDocumentHolder()
    setDocumentStorage(storage)

    expect(collectDocumentArchive(modelItemId)).toBeUndefined()
    const item = useCamStore.getState().project.modelItems?.find((m) => m.id === modelItemId)
    expect(item?.documentState).toBe('authored')
    expect(item?.documentStorageKey).toBeTruthy()
  })

  it('the bore-wall pick self-heals from the durable checkpoint and binds the picked face', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    await useCamStore.getState().loadProjectFromFile(readFixtureText())
    const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!
    const faceStableId = modelGeo.modelBody?.display?.faceIds?.[BORE_FACE_INDEX]
    expect(faceStableId).toBeTruthy()

    // Simulate a browser refresh: documentHolder's in-memory maps are wiped
    // (a fresh JS module on the new page load) but durable storage and the
    // rehydrated project state (modelItems incl. documentStorageKey) survive.
    resetDocumentHolder()
    setDocumentStorage(storage)

    // Smart Height V2 (commit 2e5678b7): Bore's authority proves the target
    // geometry belongs to the ACTIVE Setup's stock. The fixture's default
    // active setup ('Setup 2') owns a different stock than the model body -
    // point activeSetupId at the setup that actually owns it, same as an
    // operator would by having that Setup selected before opening the modal.
    const owningSetupId = useCamStore.getState().project.setups
      .find((s) => s.wcs.stockId === modelGeo.stockId)?.id
    expect(owningSetupId).toBeTruthy()
    act(() => {
      useCamStore.setState((s) => ({ project: { ...s.project, activeSetupId: owningSetupId ?? null } }))
    })

    // Fixing the stock-ownership gap above (so the modal's Save actually
    // fires) reaches a real post-create computeToolpath call
    // (NewOperationModalBody.tsx's handleCreate) that previously never ran -
    // stub Worker (wo114's own precedent, reused from the compute-path
    // describe block below) so that unstubbed `new Worker(...)` doesn't
    // throw an unhandled rejection in jsdom.
    installWorkerCapture()

    const vp = installVpMock()
    render(createElement(NewOperationModal))
    act(() => { useCamStore.getState().openModal('new-operation') })

    // Type tab is the default; pick the Bore operation type.
    fireEvent.click(screen.getByText('Bore'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: modelGeo.id } })

    fireEvent.click(screen.getByTestId('brep-pick-face'))
    await waitFor(() => expect(vp.getCallback()).not.toBeNull())
    act(() => {
      vp.getCallback()!({ geoId: modelGeo.id, kind: 'face', index: BORE_FACE_INDEX, isModelFace: true })
    })

    await waitFor(
      () => expect(screen.queryByTestId('model-bore-pick-status')).toBeNull(),
      { timeout: 15_000 },
    )
    // The exact false refusal this WO exists to remove must never appear.
    expect(screen.queryByTestId('brep-derive-error')).toBeNull()

    // Create the operation and read what the store actually persisted - the
    // decisive proof, not a UI vibe (WO-114's own precedent for this modal).
    fireEvent.click(screen.getByText('Tool'))
    const toolOption = useCamStore.getState().toolLibrary[0]
    expect(toolOption).toBeTruthy()
    fireEvent.click(screen.getByText(toolOption!.name))
    // Smart Height V2 (commit 2e5678b7): Save is gated on the live Drill/Bore
    // preview resolving (drillBoreHeightValid, NewOperationModalBody.tsx) -
    // wait for the button itself (the preview panel lives on the Geometry
    // tab, currently not shown) or the click below is a silent no-op and the
    // LAST op in the setup stays whatever the fixture project already had.
    await waitFor(
      () => expect((screen.getByTestId('op-create') as HTMLButtonElement).disabled).toBe(false),
      { timeout: 15_000 },
    )
    fireEvent.click(screen.getByTestId('op-create'))

    const setup = useCamStore.getState().project.setups.find((s) => s.id === useCamStore.getState().project.activeSetupId)
    const op = setup?.operations.at(-1)
    expect(op?.type).toBe('bore')
    const boreRef = op?.modelReferences?.find((r) => r.role === 'bore-target')
    expect(boreRef?.bodyId).toBe(modelGeo.modelBody?.ref.bodyId)
    expect(boreRef?.stableIds).toEqual([faceStableId])
  }, 30_000)

  it('when the checkpoint is genuinely gone (not merely un-hydrated), the pick refuses by name - never a silent dead end, never a crash', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    await useCamStore.getState().loadProjectFromFile(readFixtureText())
    const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!

    // A DIFFERENT (empty) durable backend: the rehydrated project still names
    // a documentStorageKey, but nothing durable is actually reachable under
    // it - e.g. the browser's storage was cleared.
    resetDocumentHolder()
    setDocumentStorage(new InMemoryDocumentStorage())

    const vp = installVpMock()
    render(createElement(NewOperationModal))
    act(() => { useCamStore.getState().openModal('new-operation') })
    fireEvent.click(screen.getByText('Bore'))
    fireEvent.click(screen.getByText('Geometry'))
    fireEvent.change(screen.getByTestId('op-geometry-select'), { target: { value: modelGeo.id } })

    fireEvent.click(screen.getByTestId('brep-pick-face'))
    await waitFor(() => expect(vp.getCallback()).not.toBeNull())
    act(() => {
      vp.getCallback()!({ geoId: modelGeo.id, kind: 'face', index: BORE_FACE_INDEX, isModelFace: true })
    })

    await waitFor(() => expect(screen.getByTestId('brep-derive-error')).toBeTruthy(), { timeout: 15_000 })
    const message = screen.getByTestId('brep-derive-error').textContent ?? ''
    expect(message.length).toBeGreaterThan(0)
    // Names the item, same as the "genuinely nothing durable" case this
    // module already refused correctly before this WO (regenerateModelBodyHeadless).
    expect(message).toMatch(/legacy|model item|checkpoint/i)
  }, 30_000)
})

describe('WO-365: store/index.ts deriveBrepLayer\'s Detect-holes derive (recognizeModelBodyHoles)', () => {
  it('recovers from the durable checkpoint after a simulated refresh', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    await useCamStore.getState().loadProjectFromFile(readFixtureText())
    const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!

    resetDocumentHolder()
    setDocumentStorage(storage)
    expect(collectDocumentArchive(modelGeo.modelItemId ?? 'legacy')).toBeUndefined()

    await expect(
      useCamStore.getState().deriveBrepLayer(modelGeo.id, 'holes'),
    ).resolves.toBeUndefined()

    const after = useCamStore.getState().project.geometry.find((g) => g.id === modelGeo.id)!
    expect((after.layers2d ?? []).some((l) => l.name.startsWith('Model holes'))).toBe(true)
    expect(useCamStore.getState().brepImportError).toBeNull()
  }, 30_000)

  it('when the checkpoint is genuinely gone, the derive refuses by name - never hangs or crashes', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    await useCamStore.getState().loadProjectFromFile(readFixtureText())
    const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!

    resetDocumentHolder()
    setDocumentStorage(new InMemoryDocumentStorage())

    await expect(
      useCamStore.getState().deriveBrepLayer(modelGeo.id, 'holes'),
    ).rejects.toThrow()
    expect(useCamStore.getState().brepImportError).toMatch(/legacy|model item|checkpoint/i)
  }, 30_000)
})

// ─── computeOperationToolpath's compute-time bore-target replay ───────────
// Structurally identical wiring to the drill-targets branch a few lines
// above it in store/index.ts (both:
// `resolveOwningModelItemId(refGeo) ?? LEGACY_MODEL_ITEM_ID`, then
// `ensureDocumentArchiveHydrated`, then the read call) - one direct test of
// this branch stands for both; see the file header.

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

const wo365BoreTool: Tool = {
  id: 'wo365-bore-tool', name: 'WO-365 EM3', type: 'flat_end_mill', diameter: 3,
  fluteLength: 20, shankDiameter: 3, overallLength: 50, numberOfFlutes: 2,
} as Tool

function makeWo365BoreOp(geometryId: string, bodyId: string, faceStableId: string): Operation {
  const loopId = modelBoreLoopId(faceStableId)
  const heights = {
    clearanceHeight: 15, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 5,
    topHeight: 0, topHeightMode: 'stock_top',
    bottomHeight: 0, bottomHeightMode: 'selected_face', selectedFaceZ: 0,
    bottomManual: false,
  }
  const params = {
    geometryId, loopIds: [loopId], direction: 'climb', sortStrategy: 'nearest_neighbor',
    geometrySource: 'cylinder', targetDiameter: 7, perBoreDepth: true,
    perBoreDepthOverrides: {},
    heightReference: 'stock_top', planeOffset: -5,
  }
  return {
    id: 'wo365-bore-op', name: 'WO-365 Bore', type: 'bore', enabled: true, status: 'ready',
    toolId: wo365BoreTool.id, geometrySelections: [loopId],
    modelReferences: [{ bodyId, stableIds: [faceStableId], role: 'bore-target' }],
    heights,
    passes: {
      stepdown: 2, stepover: 3, stockToLeave: 0, floorStockToLeave: 0,
      finishPasses: 1, springPasses: 0, overlapMm: 0,
    },
    linking: {
      entryType: 'ramp_helical', rampAngle: 3, rampLength: 10,
      leadInRadius: 0, leadOutRadius: 0, retractType: 'full', transitionType: 'safe_height',
    },
    params,
    smartHeight: smartHeightAuthorityFixture('bore', {
      setupId: 'wo365-setup-1', heights: heights as HeightParams, params, geometryIds: [geometryId],
      stockId: DERIVED_STOCK_ID, explicitDepthMm: 5,
    }),
  } as unknown as Operation
}

function makeWo365Setup(op: Operation): Setup {
  return {
    id: 'wo365-setup-1', name: 'WO-365 Setup',
    wcs: {
      id: 'wo365-wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      cornerRow: 0, cornerCol: 0, cornerFace: 'top', stockId: DERIVED_STOCK_ID,
    } as unknown as Setup['wcs'],
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 50,
      offsetX: 5, offsetY: 5, offsetZTop: 5, offsetZBottom: 0, material: 'al',
    },
    operations: [op], notes: '',
  } as unknown as Setup
}

// A minimal, always-completes stand-in Worker (wo114's own precedent,
// modelEdgeChainWizard.wo114.test.tsx) - this test is about whether the
// STORE self-heals the document, not about the real 2.5D bore planner.
interface CapturedRequest { type: string; payload: { opId: string } }
let workerRequests: CapturedRequest[] = []
function installWorkerCapture(): void {
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

describe('WO-365: store/index.ts computeOperationToolpath\'s bore-target re-derive (readModelBodyFaceFacts)', () => {
  it('recovers from the durable checkpoint after a simulated refresh - the compute path, not just the pick', async () => {
    const storage = new InMemoryDocumentStorage()
    setDocumentStorage(storage)
    await useCamStore.getState().loadProjectFromFile(readFixtureText())
    const modelGeo = useCamStore.getState().project.geometry.find((g) => g.format === 'model')!
    const bodyId = modelGeo.modelBody!.ref.bodyId
    const faceStableId = modelGeo.modelBody!.display!.faceIds![BORE_FACE_INDEX]!

    const op = makeWo365BoreOp(modelGeo.id, bodyId, faceStableId)
    useCamStore.setState((s) => ({
      toolLibrary: [...s.toolLibrary, wo365BoreTool],
      project: {
        ...s.project,
        stocks: [{
          id: DERIVED_STOCK_ID, name: 'WO-365 Auto Stock', mode: 'derived',
          bounds: bbox({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
          position: { x: 0, y: 0, z: 0 },
        } as unknown as PhysicalStock],
        sceneStock: {
          mode: 'auto', autoOffsetXY: 5, autoOffsetZTop: 5, autoOffsetZBottom: 0,
          fixedWidth: 100, fixedHeight: 100, fixedDepth: 50, fixedStocks: [], autoStocks: [],
        } as unknown as SceneStock,
        setups: [makeWo365Setup(op)],
        activeSetupId: 'wo365-setup-1',
      },
    }))

    // Simulate the refresh AFTER the binding was persisted and BEFORE compute
    // runs - exactly Operator's real sequence (pick+save one session, refresh,
    // then compute in a later one).
    resetDocumentHolder()
    setDocumentStorage(storage)
    expect(collectDocumentArchive(modelGeo.modelItemId ?? 'legacy')).toBeUndefined()

    installWorkerCapture()
    await useCamStore.getState().computeOperationToolpath('wo365-setup-1', 'wo365-bore-op')

    const computed = useCamStore.getState().project.setups
      .find((s) => s.id === 'wo365-setup-1')?.operations.find((o) => o.id === 'wo365-bore-op')
    expect(computed?.status, `errorMessage: ${computed?.errorMessage}`).toBe('ready')
    expect(workerRequests).toHaveLength(1)
  }, 30_000)
})
