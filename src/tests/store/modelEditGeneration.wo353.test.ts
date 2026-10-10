// WO-353: a model edit must survive a reload without being reloaded.
//
// docs/research/model-edit-refresh-gap.md (WO-334) named three independent,
// unsynchronized persistence layers for one model-body edit -- the general
// store's `project.geometry` (layer a), the per-Model-Item document
// checkpoint (layer b, doc/persist/autosave.ts + doc/documentHolder.ts), and
// the model-body display cache (layer c, lib/modelBodyDisplayCache.ts) -- and
// warned that a reload can trust a layer that is behind the others,
// including the DANGEROUS case where layer (a) and (c) are SELF-CONSISTENT
// on a STALE generation while layer (b) has moved on (section 5's "silently
// reverted" danger: nothing looks wrong, but the mesh shown is not the user's
// last edit).
//
// This file proves the shared-generation cross-check this WO adds --
// src/doc/documentHolder.ts's peekDurableDocumentRevision +
// src/lib/viewport/restoreScene.ts's checkModelItemDocumentConsistency --
// closes that gap, and that the two "Do not" halves from the WO stay intact:
// nothing here silently trusts disk over memory to remove a refusal, and
// nothing here makes a genuinely inconsistent document stop refusing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ImportedGeometry, ModelBodyDisplay, Project, Setup } from '../../types'
import type { DerivedModelBody, LiveModelBody } from '../../lib/cam/modelBodyAdapter'
import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'

const { useCamStore, persistPartialize, persistMerge } = await import('../../store')
const {
  resetDocumentHolder,
  setDocumentStorage,
  registerLiveDocument,
  flushDocumentCheckpoint,
  peekDurableDocumentRevision,
} = await import('../../doc/documentHolder')
const { InMemoryDocumentStorage, readAutosaveSnapshot } = await import('../../doc/persist')
const { AutosaveController } = await import('../../doc/persist/autosave')
const { FeatureDag } = await import('../../doc/dag')
const restoreScene = await import('../../lib/viewport/restoreScene')
const { loadCachedModelBodyDisplay } = await import('../../lib/modelBodyDisplayCache')

const PROJECT_ID = 'p-wo353'

function display(tag = 0): ModelBodyDisplay {
  return {
    positions: [tag, 0, 0, 1, 0, 0, 1, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    edgePositions: [0, 0, 0, 1, 0, 0],
    edgeOffsets: [0, 2],
    bbox: { min: [tag, 0, 0], max: [1, 1, 0] },
  }
}
const derived = (bodyId: string, version = 1, tag = 0): DerivedModelBody =>
  ({ bodyId, version, stableIds: [`${bodyId}:F0`], display: display(tag) })
const live = (bodyId: string, name: string): LiveModelBody => ({ bodyId, name })

function makeDag(featureId: string, height: number): ReturnType<() => InstanceType<typeof FeatureDag>> {
  const dag = new FeatureDag()
  dag.insertNode({ id: featureId, kind: 'feature', payload: { opType: 'extrude', height } })
  return dag
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: PROJECT_ID, name: 'WO-353', version: '1.0.0',
    createdAt: '2026-08-13T00:00:00.000Z', updatedAt: '2026-08-13T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000, maxSpindleRpm: 24000,
      minSpindleRpm: 8000, spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry: [], setups: [], activeSetupId: null, activeOperationId: null,
    sceneStock: { mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1, fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [] },
    notes: '',
    ...over,
  } as Project
}

function modelEntries(): ImportedGeometry[] {
  return useCamStore.getState().project.geometry.filter((g) => g.format === 'model')
}

function fakeViewport() {
  const drawn: Array<{ id: string; tag: number }> = []
  const vp = {
    addSTL: vi.fn(async () => null),
    setSTLVisible: vi.fn(),
    setPartLoopsOnFacePlane: vi.fn(),
    setPartProjectedLoops: vi.fn(),
    addBrepModel: vi.fn(),
    add2DGeometry: vi.fn(),
    addModelBody: vi.fn((id: string, disp: ModelBodyDisplay) => {
      drawn.push({ id, tag: disp.positions[0] })
    }),
  }
  return { vp, drawn }
}

/** Yield one full macrotask boundary -- long enough for every microtask the
 *  fake IndexedDB queues (open -> upgrade -> transaction -> requests ->
 *  oncomplete, all `queueMicrotask`, never a real timer) to drain, so a
 *  fire-and-forget cache write (persistModelBodyDisplays' contract) is
 *  guaranteed to have landed before the next assertion. */
function flushAsync(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0))
}

/** Simulate a page reload: everything doc/documentHolder.ts holds IN MEMORY
 *  is wiped (live collectors, pending seeds, autosave controllers -- exactly
 *  what a real browser reload discards along with the whole JS heap), but
 *  the durable backend (this test's InMemoryDocumentStorage stand-in for
 *  OPFS) survives, and the general store rehydrates from whatever
 *  persistPartialize/persistMerge round trip `snapshot` captures -- the same
 *  technique src/tests/store/int17aModelBodySync.test.ts's
 *  SECTION-STALENESS-MARK case already uses for the localStorage-refresh
 *  axis. */
function reload(snapshot: unknown, storage: InstanceType<typeof InMemoryDocumentStorage>): void {
  resetDocumentHolder()
  setDocumentStorage(storage)
  const rehydrated = persistMerge(snapshot, useCamStore.getState())
  useCamStore.setState({ project: rehydrated.project })
}

let idb: FakeIndexedDBHandle
let storage: InstanceType<typeof InMemoryDocumentStorage>

beforeEach(() => {
  idb = installFakeIndexedDB()
  resetDocumentHolder()
  storage = new InMemoryDocumentStorage()
  setDocumentStorage(storage)
  useCamStore.setState({ project: makeProject() })
})

afterEach(() => {
  idb.restore()
})

describe('WO-353 acceptance 1: an edit committed immediately before reload survives the reload', () => {
  it('draws the LATEST edit after a full reload, once all three layers have landed', async () => {
    const itemId = 'item-a'
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: itemId, name: 'Item A', documentState: 'empty' }] },
    }))

    registerLiveDocument(() => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }), itemId)
    const checkpoint1 = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    useCamStore.getState().recordModelItemDocumentCheckpoint(itemId, checkpoint1!.revision)
    useCamStore.getState().syncModelBodies({
      modelItemId: itemId, live: [live('b1', 'Bracket')], derived: [derived('b1', 1, 0)],
    })
    await flushAsync()
    const geoId = modelEntries()[0].id

    // The edit: the document changes, its checkpoint flushes, and the body
    // re-derives -- all three writes land before the "reload" (the ordinary,
    // non-racing case this acceptance criterion is about).
    registerLiveDocument(() => ({ dag: makeDag('F1', 60), elementMapDeltas: [] }), itemId)
    const checkpoint2 = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    useCamStore.getState().recordModelItemDocumentCheckpoint(itemId, checkpoint2!.revision)
    useCamStore.getState().syncModelBodies({
      modelItemId: itemId, live: [live('b1', 'Bracket')], derived: [derived('b1', 2, 7)],
    })
    await flushAsync()

    const snapshot = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))
    reload(snapshot, storage)

    const { vp, drawn } = fakeViewport()
    await restoreScene.restoreGeometryToViewport(
      vp as never,
      useCamStore.getState().project.geometry,
      { patchGeometry: () => {}, setBrepImportError: () => {} } as never,
      [], new Set(), PROJECT_ID,
    )

    // The edit (tag 7), not the pre-edit generation (tag 0) -- the headline
    // symptom Operator reported, asserted on the restored state.
    expect(drawn).toEqual([{ id: geoId, tag: 7 }])
  })
})

describe('WO-353 acceptance 2: a partial write is detected and recovered, never silently trusted', () => {
  it('withholds a self-consistent-but-stale mesh when the document checkpoint moved on without the other two layers', async () => {
    const itemId = 'item-a'
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: itemId, name: 'Item A', documentState: 'empty' }] },
    }))

    registerLiveDocument(() => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }), itemId)
    const checkpoint1 = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    useCamStore.getState().recordModelItemDocumentCheckpoint(itemId, checkpoint1!.revision)
    useCamStore.getState().syncModelBodies({
      modelItemId: itemId, live: [live('b1', 'Bracket')], derived: [derived('b1', 1, 0)],
    })
    await flushAsync()
    const geoId = modelEntries()[0].id

    // The "a reload rehydrates to THIS" snapshot is captured BEFORE the
    // second edit -- simulating the general store's own async persistence
    // write racing the reload and never capturing the edit
    // (docs/research/model-edit-refresh-gap.md section 3a). Its ref.version
    // (1) and its documentRevision (1) are self-consistent WITH EACH OTHER
    // (same project snapshot instant) and the display cache genuinely holds
    // v1 too -- three layers, all agreeing, all stale.
    const staleSnapshot = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))

    // The second edit happens for real, and its document checkpoint lands
    // DURABLY -- an independent write, on its own schedule, unrelated to
    // whether/when the general store's own snapshot gets around to
    // capturing it. This is the layer that moved on without the other two.
    registerLiveDocument(() => ({ dag: makeDag('F1', 60), elementMapDeltas: [] }), itemId)
    const checkpoint2 = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    expect(checkpoint2!.revision).toBeGreaterThan(checkpoint1!.revision)

    // Prove the premise: the display cache really does still hold the STALE
    // v1 record, so an unguarded restore would hit it and draw it with
    // nothing to distinguish it from a correct restore.
    const staleHit = await loadCachedModelBodyDisplay({
      projectId: PROJECT_ID, geometryId: geoId, bodyId: 'b1', version: 1,
    })
    expect(staleHit?.positions[0]).toBe(0)

    reload(staleSnapshot, storage)
    // documentRevision rehydrated stale, matching the diagnosis: layer (a)
    // never captured the second checkpoint at all.
    expect(
      useCamStore.getState().project.modelItems!.find((m) => m.id === itemId)!.documentRevision,
    ).toBe(checkpoint1!.revision)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { vp, drawn } = fakeViewport()
    await restoreScene.restoreGeometryToViewport(
      vp as never,
      useCamStore.getState().project.geometry,
      { patchGeometry: () => {}, setBrepImportError: () => {} } as never,
      [], new Set(), PROJECT_ID,
    )

    // Detected: named, loud -- never a silent recovery.
    expect(warn.mock.calls.some(
      ([msg]) => typeof msg === 'string' && /WO-353/.test(msg) && /partial write/i.test(msg),
    )).toBe(true)
    // Recovered rather than trusted: the stale v1 mesh (tag 0) is never drawn.
    expect(drawn).toHaveLength(0)
    // The store's cached bookkeeping is reconciled to the durable truth (the
    // same "disk wins the number" precedent WO-348 already established for
    // openModelItem/flushModelItemDocument).
    expect(
      useCamStore.getState().project.modelItems!.find((m) => m.id === itemId)!.documentRevision,
    ).toBe(checkpoint2!.revision)
    warn.mockRestore()
  })

  it('a CAM operation already bound to the edited body still ambers correctly, unaffected by the recovery', async () => {
    // Closes the WO's own named reproduction gap: "an edit on a body that
    // already has a CAM operation bound to it through the full cycle" was
    // never measured by the WO-334 diagnosis. syncModelBodies' outdated-marking
    // (markModelBodyBoundOpsOutdated) and this WO's document-consistency
    // check are two independent passes over the SAME `project` -- proving
    // neither interferes with the other closes the gap with a real test
    // rather than an assumption.
    const itemId = 'item-a'
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [{ id: itemId, name: 'Item A', documentState: 'empty' }],
      },
    }))
    registerLiveDocument(() => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }), itemId)
    const checkpoint1 = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    useCamStore.getState().recordModelItemDocumentCheckpoint(itemId, checkpoint1!.revision)
    useCamStore.getState().syncModelBodies({
      modelItemId: itemId, live: [live('b1', 'Bracket')], derived: [derived('b1', 1, 0)],
    })
    await flushAsync()
    const geoId = modelEntries()[0].id

    const setup = {
      id: 'setup-1', name: 'Setup 1',
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
      },
      stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
      notes: '',
      operations: [{
        id: 'op-1', name: 'Pocket', type: 'pocket_2d', enabled: true, status: 'ready',
        toolId: 'tool-1', geometrySelections: [{ geometryId: geoId, loopIds: [] }],
        heights: {
          clearanceHeight: 15, clearanceHeightMode: 'absolute',
          retractHeight: 5, feedHeight: 2, topHeight: 0, topHeightMode: 'absolute',
          bottomHeight: -5, bottomHeightMode: 'absolute',
        },
        params: { geometryId: geoId },
        toolpathMoves: [{ type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' }],
      }],
    } as unknown as Setup
    useCamStore.setState((s) => ({ project: { ...s.project, setups: [setup], activeSetupId: 'setup-1' } }))

    const staleSnapshot = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))

    registerLiveDocument(() => ({ dag: makeDag('F1', 60), elementMapDeltas: [] }), itemId)
    const checkpoint2 = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    useCamStore.getState().syncModelBodies({
      modelItemId: itemId, live: [live('b1', 'Bracket')], derived: [derived('b1', 2, 7)],
    })
    await flushAsync()
    // The live (pre-reload) session already ambers the op on the real edit --
    // unaffected by anything this WO adds.
    expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('outdated')

    reload(staleSnapshot, storage)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { vp, drawn } = fakeViewport()
    await restoreScene.restoreGeometryToViewport(
      vp as never,
      useCamStore.getState().project.geometry,
      { patchGeometry: () => {}, setBrepImportError: () => {} } as never,
      [], new Set(), PROJECT_ID,
    )
    warn.mockRestore()

    // The partial write is still caught with a bound op in the picture...
    expect(drawn).toHaveLength(0)
    expect(
      useCamStore.getState().project.modelItems!.find((m) => m.id === itemId)!.documentRevision,
    ).toBe(checkpoint2!.revision)
    // ...and the pre-existing "green means a real toolpath" reconciliation
    // (CAM-12, persistPartialize + reconcileLoadedOpLifecycle -- an entirely
    // separate pass, unrelated to and out of scope for this WO) still runs
    // exactly as it would with no partial write at all: a 'ready' op with no
    // durable toolpath downgrades to 'outdated' with its stale moves cleared.
    // Two independent passes over the same reload, neither interfering with
    // the other.
    expect(useCamStore.getState().project.setups[0].operations[0].status).toBe('outdated')
    expect(useCamStore.getState().project.setups[0].operations[0].toolpathMoves).toBeUndefined()
  })

  it('also recovers rather than trusts the reverse mismatch: a cached revision AHEAD of what is durable (audit follow-up coverage gap)', async () => {
    const itemId = 'item-a'
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: itemId, name: 'Item A', documentState: 'empty' }] },
    }))

    registerLiveDocument(() => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }), itemId)
    const checkpoint1 = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    useCamStore.getState().recordModelItemDocumentCheckpoint(itemId, checkpoint1!.revision)
    useCamStore.getState().syncModelBodies({
      modelItemId: itemId, live: [live('b1', 'Bracket')], derived: [derived('b1', 1, 0)],
    })
    await flushAsync()

    // Force the cached bookkeeping AHEAD of what is actually durable -- the
    // mirror image of the durable-ahead-of-cached case above. The mechanism
    // that could produce this in production does not matter for this test:
    // the check must treat ANY mismatch the same way, in either direction --
    // never trust it, always reconcile to disk.
    useCamStore.getState().recordModelItemDocumentCheckpoint(itemId, checkpoint1!.revision + 5)

    const snapshot = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))
    reload(snapshot, storage)
    expect(
      useCamStore.getState().project.modelItems!.find((m) => m.id === itemId)!.documentRevision,
    ).toBe(checkpoint1!.revision + 5)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { vp, drawn } = fakeViewport()
    await restoreScene.restoreGeometryToViewport(
      vp as never,
      useCamStore.getState().project.geometry,
      { patchGeometry: () => {}, setBrepImportError: () => {} } as never,
      [], new Set(), PROJECT_ID,
    )

    expect(warn.mock.calls.some(
      ([msg]) => typeof msg === 'string' && /WO-353/.test(msg) && /partial write/i.test(msg),
    )).toBe(true)
    expect(drawn).toHaveLength(0)
    // Reconciled DOWN to the durable truth, not left at the impossible cached value.
    expect(
      useCamStore.getState().project.modelItems!.find((m) => m.id === itemId)!.documentRevision,
    ).toBe(checkpoint1!.revision)
    warn.mockRestore()
  })
})

describe('WO-353 audit fix: the consistency check must not fire on the in-session undo rebuild', () => {
  it('undo draws the restored pre-edit mesh instead of blanking it, leaves the revision undo just restored alone, and stashes nothing', async () => {
    const itemId = 'item-a'
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: itemId, name: 'Item A', documentState: 'empty' }] },
    }))

    registerLiveDocument(() => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }), itemId)
    const checkpoint1 = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    useCamStore.getState().recordModelItemDocumentCheckpoint(itemId, checkpoint1!.revision)
    useCamStore.getState().syncModelBodies({
      modelItemId: itemId, live: [live('b1', 'Bracket')], derived: [derived('b1', 1, 0)],
    })
    await flushAsync()
    const geoId = modelEntries()[0].id

    // The undo point: captured BEFORE the second edit, at documentRevision 1
    // (mirrors the app's real usage -- an edit action pushes history for the
    // state it is about to leave).
    useCamStore.getState().pushHistory()

    // The second edit happens for real and flushes durably (revision 2) --
    // exactly the audit's own A/B repro: an ordinary "edit, then Ctrl+Z"
    // leaves the restored (undo) snapshot's cached documentRevision (1)
    // legitimately behind the CURRENT durable revision (2), with nothing
    // ever having been lost.
    registerLiveDocument(() => ({ dag: makeDag('F1', 60), elementMapDeltas: [] }), itemId)
    const checkpoint2 = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    useCamStore.getState().recordModelItemDocumentCheckpoint(itemId, checkpoint2!.revision)
    useCamStore.getState().syncModelBodies({
      modelItemId: itemId, live: [live('b1', 'Bracket')], derived: [derived('b1', 2, 7)],
    })
    await flushAsync()
    expect(checkpoint2!.revision).toBeGreaterThan(checkpoint1!.revision)

    useCamStore.getState().undo()
    expect(
      useCamStore.getState().project.modelItems!.find((m) => m.id === itemId)!.documentRevision,
    ).toBe(checkpoint1!.revision)

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { vp, drawn } = fakeViewport()
    // Viewport.tsx's undo/viewportRefreshTrigger rebuild calls this with
    // checkDocumentConsistency=false (see restoreScene.ts's own comment on
    // that parameter) -- mirrored directly here, at the same tier every other
    // test in this file exercises restoreGeometryToViewport at.
    await restoreScene.restoreGeometryToViewport(
      vp as never,
      useCamStore.getState().project.geometry,
      { patchGeometry: () => {}, setBrepImportError: () => {} } as never,
      [], new Set(), PROJECT_ID, undefined, false,
    )

    // The undo-restored mesh (tag 0) draws -- not blanked, and not left
    // "undrawn until the Part workspace next regenerates".
    expect(drawn).toEqual([{ id: geoId, tag: 0 }])
    // The revision undo just restored is left alone, not snapped forward
    // over what undo intentionally reverted.
    expect(
      useCamStore.getState().project.modelItems!.find((m) => m.id === itemId)!.documentRevision,
    ).toBe(checkpoint1!.revision)
    // Never treated as a partial write: the check did not even run.
    expect(warn.mock.calls.some(
      ([msg]) => typeof msg === 'string' && /WO-353/.test(msg) && /partial write/i.test(msg),
    )).toBe(false)
    warn.mockRestore()
  })

  it('the same undo scenario WOULD have mis-fired with checkDocumentConsistency left at its boot default -- proving the flag, not luck, is what fixes it', async () => {
    const itemId = 'item-a'
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: itemId, name: 'Item A', documentState: 'empty' }] },
    }))

    registerLiveDocument(() => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }), itemId)
    const checkpoint1 = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    useCamStore.getState().recordModelItemDocumentCheckpoint(itemId, checkpoint1!.revision)
    useCamStore.getState().syncModelBodies({
      modelItemId: itemId, live: [live('b1', 'Bracket')], derived: [derived('b1', 1, 0)],
    })
    await flushAsync()

    useCamStore.getState().pushHistory()

    registerLiveDocument(() => ({ dag: makeDag('F1', 60), elementMapDeltas: [] }), itemId)
    const checkpoint2 = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    useCamStore.getState().recordModelItemDocumentCheckpoint(itemId, checkpoint2!.revision)
    useCamStore.getState().syncModelBodies({
      modelItemId: itemId, live: [live('b1', 'Bracket')], derived: [derived('b1', 2, 7)],
    })
    await flushAsync()

    useCamStore.getState().undo()

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { vp, drawn } = fakeViewport()
    // Same scenario, but calling with the boot default (no 8th argument) --
    // this is the exact shape of the audit's BLOCKER. Kept as a negative
    // control so a future regression that re-defaults this call site to
    // "checked" fails loudly here instead of only in production.
    await restoreScene.restoreGeometryToViewport(
      vp as never,
      useCamStore.getState().project.geometry,
      { patchGeometry: () => {}, setBrepImportError: () => {} } as never,
      [], new Set(), PROJECT_ID,
    )
    warn.mockRestore()

    expect(drawn).toHaveLength(0)
    expect(
      useCamStore.getState().project.modelItems!.find((m) => m.id === itemId)!.documentRevision,
    ).toBe(checkpoint2!.revision)
  })
})

describe('WO-353 acceptance 3: a genuinely inconsistent document still refuses (regression only)', () => {
  it('openModelItem still refuses loudly when the durable checkpoint identity does not match, unchanged by this WO', async () => {
    const itemId = 'item-b'
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItems: [{
          id: itemId, name: 'Item B', documentState: 'authored',
          // A storage key that can never be this item's own -- the identity
          // mismatch hydrateDocumentCheckpoint has always refused (WO-348's
          // own coverage, src/tests/doc/revisionMismatchRecovery.wo348.test.ts).
          documentStorageKey: 'project-other--model-other', documentRevision: 1,
        }],
      },
    }))

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await useCamStore.getState().openModelItem(itemId)
    expect(err.mock.calls.some(
      ([msg]) => typeof msg === 'string' && /\[openModelItem\] refused \(document-not-ready\)/.test(msg),
    )).toBe(true)
    // Never entered: the refusal left the workspace exactly where it was.
    expect(useCamStore.getState().activeModelItemId).not.toBe(itemId)
    err.mockRestore()
  })

  it('control: an ordinary matching checkpoint opens without any refusal', async () => {
    const itemId = 'item-c'
    useCamStore.setState((s) => ({
      project: { ...s.project, modelItems: [{ id: itemId, name: 'Item C', documentState: 'empty' }] },
    }))
    registerLiveDocument(() => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }), itemId)
    const checkpoint = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    useCamStore.getState().recordModelItemDocumentCheckpoint(itemId, checkpoint!.revision)

    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    await useCamStore.getState().openModelItem(itemId)
    expect(err).not.toHaveBeenCalled()
    expect(useCamStore.getState().activeModelItemId).toBe(itemId)
    err.mockRestore()
  })
})

describe('WO-353 documentHolder: peekDurableDocumentRevision', () => {
  it('is undefined before any checkpoint exists, and never throws', async () => {
    expect(await peekDurableDocumentRevision(PROJECT_ID, 'item-none')).toBeUndefined()
  })

  it('reflects the durable revision with no decode/hydrate side effect', async () => {
    const itemId = 'item-a'
    registerLiveDocument(() => ({ dag: makeDag('F1', 20), elementMapDeltas: [] }), itemId)
    const checkpoint = await flushDocumentCheckpoint(PROJECT_ID, itemId)
    expect(await peekDurableDocumentRevision(PROJECT_ID, itemId)).toBe(checkpoint!.revision)
  })
})

describe('WO-353 reproduction gap 1: the reload-after-idle timing window', () => {
  it('pins the exact debounce boundary the diagnosis did not sweep: idle < debounceMs never lands durably, idle >= debounceMs does', async () => {
    vi.useFakeTimers()
    try {
      const timingStorage = new InMemoryDocumentStorage()
      let content = 'v1'
      const controller = new AutosaveController({
        storage: timingStorage, documentId: 'timing-doc', debounceMs: 1000,
        save: async () => new TextEncoder().encode(content),
      })
      controller.markDirty()
      content = 'v2'
      controller.markDirty() // a second edit re-arms the debounce, exactly like markModelItemDocumentDirty on every DAG mutation

      // A reload landing strictly BEFORE the debounce elapses -- the "instant
      // reload" case docs/research/model-edit-refresh-gap.md section 1a
      // scripted against a real browser -- sees NOTHING durable yet, not
      // merely an old version.
      await vi.advanceTimersByTimeAsync(999)
      expect(await readAutosaveSnapshot(timingStorage, 'timing-doc')).toBeUndefined()

      // At/after debounceMs, the flush has fired and the edit is durable.
      await vi.advanceTimersByTimeAsync(2)
      const settled = await readAutosaveSnapshot(timingStorage, 'timing-doc')
      expect(settled?.unclean).toBe(true)
      controller.dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
