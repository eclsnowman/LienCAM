// INT-17A-R1: the four INDIRECT consumer-path bypasses the base round missed,
// reproduced FIRST as failing tests (audit coordination/reports/INT-17A.audit.json).
//
// Every case here is an entry that reaches a modeled body through a route the
// direct guard never sees: a rehydrate blob (C1), an `__all__` aggregation (C2),
// an `undefined`-becomes-default fallthrough (C3), a cascade delete (C4). Each
// test asserts the CURED behaviour and FAILS against the pre-cure tree, so the
// RED run is the repro and the GREEN run is the proof.
//
// The census that derived this consumer set from the code (rather than from the
// preflight's hand-listed seams) is coordination/reports/INT-17A-R1-evidence/
// consumer-census.md; every INCLUDES-model row there is covered below or named
// there as deliberately-allowed.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { Project, ImportedGeometry, ModelBodyDisplay } from '../../types'
import type { DerivedModelBody, LiveModelBody } from '../../lib/cam/modelBodyAdapter'
import { typedMock } from '../support/typedMock'

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
// There is no IndexedDB in this env. INT-17A-R2: this used to vi.mock the cache
// MODULE, which is exactly why R1 never exercised the accept rule the audit then
// found missing - the mock had no version logic, so no version logic was tested.
// Stub the IDB PRIMITIVE instead and let the real module run; these two tests
// therefore got STRONGER in R2, not weaker (they now cross the real record
// envelope, the real bound and the real project scoping).
import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'

const { useCamStore, persistPartialize, persistMerge, resolveOpGeometrySources } =
  await import('../../store')
const { restoreGeometryToViewport } = await import('../../lib/viewport/restoreScene')
const { assignGeometryToStocks, geometryBearingStockIds, pickDefaultSetupStock } =
  await import('../../store/stockAssignment')
const { DERIVED_STOCK_ID } = await import('../../store/migrateHierarchy')
const { isModelOriginGeometry } = await import('../../lib/cam/modelOrigin')
const { resetDocumentHolder } = await import('../../doc/documentHolder')
const {
  loadCachedModelBodyDisplay, MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE,
  modelBodyCacheKey,
} = await import('../../lib/modelBodyDisplayCache')

/** Drain the microtask queue AND the timer turn, so the store's fire-and-forget
 *  cache writes (open -> put -> bound enforcement, several hops) have settled.
 *  A bare `await Promise.resolve()` only covers the first hop. */
const flushCacheIo = () => new Promise((resolve) => setTimeout(resolve, 0))

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
  ({ bodyId, version, stableIds: [`${bodyId}:F0`, `${bodyId}:E0`], display: display(tag) })
const live = (bodyId: string, name: string): LiveModelBody => ({ bodyId, name })

const bbox = (min: [number, number, number], max: [number, number, number]) => ({
  min: { x: min[0], y: min[1], z: min[2] },
  max: { x: max[0], y: max[1], z: max[2] },
  size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
  center: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
})

/** A geometry row shaped like a legitimate 2D part (loops present). */
function loopGeo(id: string, over: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id, name: id, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox([0, 0, 0], [10, 10, 0]),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{ id: `${id}-l1`, layerId: `${id}-lay`, type: 'contour', area: 50,
              points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true }],
    ...over,
  } as ImportedGeometry
}

/** The HOSTILE model row the audit used: model origin, but wearing every shape
 *  a loop/type-based gate keys on. Origin is the only thing that gives it away. */
function hostileModelGeo(id = 'mg1'): ImportedGeometry {
  return {
    id, name: 'Extrude F1', filename: '', type: 'brep', format: 'model',
    boundingBox: bbox([0, 0, 0], [5, 5, 20]),
    position: { x: 0, y: 0, z: 7 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{ id: 'mg1-l1', layerId: 'mg1-lay', type: 'contour', area: 12.5,
              points: [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 5, y: 5 }], closed: true }],
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 }, display: display() },
  } as ImportedGeometry
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1', name: 'R1 Bypasses', version: '1.0.0',
    createdAt: '2026-07-18T00:00:00.000Z', updatedAt: '2026-07-18T00:00:00.000Z',
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

const modelEntries = (): ImportedGeometry[] =>
  useCamStore.getState().project.geometry.filter((g) => g.format === 'model')

let idb: FakeIndexedDBHandle
const displayStore = () => idb.records(MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE)

afterEach(() => { idb.restore() })

beforeEach(() => {
  resetDocumentHolder()
  idb = installFakeIndexedDB()
  vi.clearAllMocks()
  vi.stubGlobal('alert', vi.fn())
  useCamStore.setState({ project: makeProject() })
})

// ─────────────────────────────────────────────────────────────────────────────
// C1 - the browser-REFRESH rehydrate axis of B2a.
// The .camproject FILE axis was already green in round 1; this is the other one.
// ─────────────────────────────────────────────────────────────────────────────
describe('C1 refresh-rehydrate: a modeled entry draws after a plain browser refresh into CAM', () => {
  it('persistPartialize -> persistMerge -> restore DRAWS every modeled body, Part tab never mounted', async () => {
    useCamStore.getState().syncModelBodies({
      live: [live('b1', 'Bracket'), live('b2', 'Plate')],
      derived: [derived('b1', 1, 1), derived('b2', 1, 2)],
    })
    const idsBefore = modelEntries().map((g) => g.id)
    expect(idsBefore).toHaveLength(2)
    const projectId = useCamStore.getState().project.id
    // The store's fire-and-forget write has to land before the refresh, or the
    // restore below would be recovering from an empty cache and pass vacuously.
    await flushCacheIo()
    expect(displayStore().size).toBe(2)

    // THE REFRESH. Exactly what zustand's persist middleware does on reload:
    // serialize through partialize, then rebuild the store through merge. The
    // heavy display is stripped on the way out (quota / D-014) - unchanged.
    const blob = JSON.parse(JSON.stringify(persistPartialize(useCamStore.getState())))
    expect(blob.project.geometry.every((g: ImportedGeometry) =>
      g.format !== 'model' || g.modelBody?.display === undefined)).toBe(true)

    useCamStore.setState({ project: makeProject() })          // fresh page
    const rehydrated = persistMerge(blob, useCamStore.getState())
    useCamStore.setState(rehydrated)
    expect(modelEntries().map((g) => g.id)).toEqual(idsBefore)

    // Boot scene restore - the CAM Viewport mount effect's path. No Part tab, no
    // Model kernel, no regen pass: persisted data alone must draw the bodies.
    const addModelBody = vi.fn()
    const vp = {
      addSTL: vi.fn(async () => null), addModelBody, setSTLVisible: vi.fn(),
      setPartLoopsOnFacePlane: vi.fn(), setPartProjectedLoops: vi.fn(),
      add2DGeometry: vi.fn(), removeSTL: vi.fn(),
    }
    const patched: Array<[string, Partial<ImportedGeometry>]> = []
    await restoreGeometryToViewport(
      vp as never,
      useCamStore.getState().project.geometry,
      { patchGeometry: (id: string, p: Partial<ImportedGeometry>) => { patched.push([id, p]) } } as never,
      [], new Set(),
      // INT-17A-R2 C2: the restore is project-scoped now. This is the same
      // project that wrote the records, so the recovery must still succeed.
      projectId,
    )

    expect(addModelBody).toHaveBeenCalledTimes(2)
    for (const id of idsBefore) {
      expect(addModelBody).toHaveBeenCalledWith(id, expect.objectContaining({ positions: expect.any(Array) }),
        expect.any(String), expect.anything(), expect.anything(), undefined)
    }
    // And the recovered payload is written BACK onto the store entry, so the
    // rest of the app (live viewport key, a subsequent .camproject save) sees a
    // consistent entry rather than a half-hydrated one.
    expect(patched.map(([id]) => id).sort()).toEqual([...idsBefore].sort())
    expect(patched[0][1].modelBody?.display?.positions.length).toBeGreaterThan(0)
  })

  it('the durable cache is PURGED when a body is deleted (no unbounded growth)', async () => {
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'A')], derived: [derived('b1')] })
    const id = modelEntries()[0].id
    const projectId = useCamStore.getState().project.id
    await flushCacheIo()
    expect(displayStore().has(modelBodyCacheKey(projectId, id))).toBe(true)

    useCamStore.getState().syncModelBodies({ live: [], derived: [] })
    await flushCacheIo()
    expect(modelEntries()).toHaveLength(0)
    expect(displayStore().has(modelBodyCacheKey(projectId, id))).toBe(false)
  })

  it('INT-17A-R2 C2: a body re-derived to a NEW ref version does not restore the OLD shape', async () => {
    // The audit's version case, driven end to end through the real store and the
    // real restore rather than at the cache API. R1's mock could not express it.
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'Bracket')], derived: [derived('b1', 1, 1)] })
    const projectId = useCamStore.getState().project.id
    const id = modelEntries()[0].id
    await flushCacheIo()
    expect(await loadCachedModelBodyDisplay(
      { projectId, geometryId: id, bodyId: 'b1', version: 1 },
    )).not.toBeNull()

    // The Model tab re-derives the body: ref.version becomes 2 while the cache
    // still holds version 1's tessellation. A refresh must NOT draw the stale
    // shape onto the new ref.
    const stale = await loadCachedModelBodyDisplay(
      { projectId, geometryId: id, bodyId: 'b1', version: 2 },
    )
    expect(stale).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 - the `__all__` aggregation route around the B6 picker guard.
// ─────────────────────────────────────────────────────────────────────────────
describe('C2 __all__: All Parts never pulls a modeled body into an operation', () => {
  it('the AUTHORITATIVE compute-source resolution excludes model origin', () => {
    // Two legitimate loop-bearing parts (so All Parts is offered at all) plus the
    // hostile model row that wears loops + type:'brep'.
    const geometry = [loopGeo('a'), loopGeo('b'), hostileModelGeo()]

    // resolveOpGeometrySources IS the seam computeOperation uses to turn an op's
    // geometryId into its source rows - the AUTHORITATIVE resolution the audit
    // showed the picker guard did not cover. Asserting on it (not on a re-typed
    // copy of the predicate) is what makes this test bind to the real code path.
    const resolved = resolveOpGeometrySources(geometry, '__all__')
    expect(resolved.map((g) => g.id)).toEqual(['a', 'b'])
    expect(resolved.some((g) => g.format === 'model')).toBe(false)
    // The shared predicate is what did the refusing.
    expect(isModelOriginGeometry(hostileModelGeo())).toBe(true)
  })

  it('a DIRECT geometryId reference to a modeled body resolves to NOTHING either', () => {
    // The picker cannot offer it, but an op whose params were hand-edited, or
    // carried over from an older file, must not resolve it as a cut source.
    const geometry = [loopGeo('a'), hostileModelGeo()]
    expect(resolveOpGeometrySources(geometry, 'mg1')).toEqual([])
    expect(resolveOpGeometrySources(geometry, 'a').map((g) => g.id)).toEqual(['a'])
  })

  it('the All Parts COUNT uses the same predicate (no phantom loops in the label)', () => {
    const geometry = [loopGeo('a'), loopGeo('b'), hostileModelGeo()]
    const counted = resolveOpGeometrySources(geometry, '__all__')
      .reduce((n, g) => n + (g.loops?.filter((l) => l.closed).length ?? 0), 0)
    expect(counted).toBe(2)   // pre-cure: 3, the modeled body's loop included
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C3 - stock eligibility. An UNLOCKED modeled body still has no world bounds
// under the automatic containment path, so it still never falls through to
// the catch-all - CAM-BINDING Stage 3 only changed the DELIBERATE, LOCKED
// path (see the dedicated 'every stock-assignment ACCEPT path' test below).
// ─────────────────────────────────────────────────────────────────────────────
describe('C3 stock: an UNLOCKED modeled body is still not auto-swept into a stock (Stage 3 unchanged)', () => {
  const stocks = [
    { id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived' as const,
      bounds: bbox([0, 0, 0], [100, 100, 12]), position: { x: 0, y: 0, z: 0 } },
  ]

  it('assignGeometryToStocks does NOT fall through to the derived catch-all', () => {
    const out = assignGeometryToStocks([hostileModelGeo(), loopGeo('a')], stocks as never)
    const model = out.find((g) => g.format === 'model')!
    expect(model.stockId).toBeUndefined()          // pre-cure: DERIVED_STOCK_ID
    expect(out.find((g) => g.id === 'a')!.stockId).toBe(DERIVED_STOCK_ID)  // unchanged for real parts
  })

  it('an EXISTING model stockId (from an older blob) is CLEARED, not preserved', () => {
    const stale = { ...hostileModelGeo(), stockId: DERIVED_STOCK_ID } as ImportedGeometry
    const out = assignGeometryToStocks([stale], stocks as never)
    expect(out[0].stockId).toBeUndefined()
  })

  it('a modeled body does not make a stock geometry-BEARING (no setup-default skew)', () => {
    const project = {
      geometry: [{ ...hostileModelGeo(), stockId: DERIVED_STOCK_ID } as ImportedGeometry],
      stocks, nests: [],
    }
    expect(geometryBearingStockIds(project as never)).toEqual([])
    // With no real geometry bearing a stock, the default is the symbolic
    // catch-all - NOT a "one real candidate, bind silently" answer produced by
    // a modeled body that can never be cut.
    expect(pickDefaultSetupStock(project as never)).toEqual({ stockId: DERIVED_STOCK_ID })
  })

  it('CAM-BINDING Stage 3: every manual stock-assignment path now ACCEPTS a modeled entry, locked', () => {
    useCamStore.setState({ project: makeProject({ geometry: [hostileModelGeo()], stocks } as never) })
    const s = useCamStore.getState()
    // "Use this body as stock" - setStockMembership succeeds and locks it.
    expect(() => s.setStockMembership('mg1', DERIVED_STOCK_ID)).not.toThrow()
    expect(useCamStore.getState().project.geometry[0].stockId).toBe(DERIVED_STOCK_ID)
    expect(useCamStore.getState().project.geometry[0].stockIdLocked).toBe(true)

    // The locked assignment SURVIVES an unrelated auto-resort - the "two rules
    // fight" the old refusal existed to prevent no longer arises, because
    // assignGeometryToStocks now respects a LOCKED model row exactly like any
    // other locked geometry (stockAssignment.ts).
    const resorted = assignGeometryToStocks(useCamStore.getState().project.geometry, stocks as never)
    expect(resorted[0].stockId).toBe(DERIVED_STOCK_ID)
    expect(resorted[0].stockIdLocked).toBe(true)

    // Explicit "None" also succeeds and stays sticky (locked, no stockId).
    expect(() => useCamStore.getState().setGeometryNoStock('mg1')).not.toThrow()
    expect(useCamStore.getState().project.geometry[0].stockId).toBeUndefined()
    expect(useCamStore.getState().project.geometry[0].stockIdLocked).toBe(true)

    // setGeometryStock and setGeometryAutoStock (the other two manual setters)
    // accept it too.
    expect(() => useCamStore.getState().setGeometryStock('mg1', DERIVED_STOCK_ID)).not.toThrow()
    expect(useCamStore.getState().project.geometry[0].stockId).toBe(DERIVED_STOCK_ID)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C4 - delete integrity. Direct delete refuses; the CASCADE did not.
// ─────────────────────────────────────────────────────────────────────────────
describe('C4 delete: no cascade or bulk path deletes a modeled body', () => {
  it('FOLDER delete deletes AROUND a modeled entry and re-parents it to the root', () => {
    useCamStore.setState({ project: makeProject() })
    const folderId = useCamStore.getState().addGeometryFolder('Parts')
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'Bracket')], derived: [derived('b1')] })
    const modelId = modelEntries()[0].id
    useCamStore.setState((s) => ({
      project: { ...s.project, geometry: [...s.project.geometry, { ...loopGeo('a'), folderId }] },
    }))
    useCamStore.getState().setGeometryFolderId(modelId, folderId)
    expect(useCamStore.getState().project.geometry.filter((g) => g.folderId === folderId)).toHaveLength(2)

    useCamStore.getState().removeGeometryFolder(folderId)

    const after = useCamStore.getState().project.geometry
    expect(after.find((g) => g.id === 'a')).toBeUndefined()      // the real part IS deleted
    const survivor = after.find((g) => g.id === modelId)
    expect(survivor).toBeDefined()                               // the modeled body is NOT
    expect(survivor!.folderId ?? null).toBeNull()                // re-parented to the root
    expect(survivor!.modelBody?.display?.positions.length).toBeGreaterThan(0)  // card state intact
    expect(useCamStore.getState().project.geometryFolders ?? []).toHaveLength(0)
  })

  it('the STORE-level removeGeometry refuses a modeled entry BY NAME (backstop for every caller)', () => {
    useCamStore.getState().syncModelBodies({ live: [live('b1', 'A')], derived: [derived('b1')] })
    const id = modelEntries()[0].id
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    useCamStore.getState().removeGeometry(id)
    expect(modelEntries()).toHaveLength(1)                       // still there
    expect(err).toHaveBeenCalledWith(expect.stringContaining('refusing modeled geometry'))
    err.mockRestore()
  })

  it('an ORDINARY folder delete with no modeled entries is byte-unchanged (no regression)', () => {
    useCamStore.setState({ project: makeProject() })
    const folderId = useCamStore.getState().addGeometryFolder('Parts')
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [{ ...loopGeo('a'), folderId }, { ...loopGeo('b'), folderId }],
      },
    }))
    useCamStore.getState().removeGeometryFolder(folderId)
    expect(useCamStore.getState().project.geometry).toHaveLength(0)
    expect(useCamStore.getState().project.geometryFolders ?? []).toHaveLength(0)
  })
})
