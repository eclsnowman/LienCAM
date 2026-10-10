// INT-17A-R3 RED-FIRST REPRO of the round-3 audit's two REPRODUCIBLE findings
// (coordination/reports/INT-17A-R2.audit.json, findings C1 and C3).
//
// Same discipline as int17aR2Repro.test.ts: every test below asserts the CURED
// behaviour using ONLY APIs that already exist on the pre-cure tree, so the file
// COMPILES AND RUNS against the tree the auditor found. Each failure is the
// defect itself, and the controls at the end pass in BOTH runs, which is what
// proves the RED is the bypass rather than a broken harness.
//
// Findings reproduced:
//   C1. The model-origin compute guard is not at the narrowest SHARED operation
//       boundary. parallel_3d and adaptive_3d branch and return at
//       src/store/index.ts:6320/6348, both BEFORE computeGeometryScope runs at
//       :6390, and they select their part through `geometrySelections[0]`
//       (index.ts:1032/1391) rather than `params.geometryId`. A modeled body
//       named by a 3D op therefore never reaches the named Stage 1 refusal; it
//       falls into the incidental format check at index.ts:1052/1411 and reads
//       as "needs an STL or STEP solid, but ... is model".
//   C3. The 64 MB / 512-entry cache bound is not TRANSACTIONALLY enforced. The
//       payload is committed in one transaction and enforceBounds evicts in a
//       second, so an enforcement failure between them leaves the store
//       committed OVER the advertised cap - silently, and permanently, because
//       nothing re-runs enforcement for a record that is already in.
//
// C2 (the audit's third finding) is NOT reproduced here, and that is deliberate
// and honest: C2 is a proof-strength finding, not a code defect. The no-op
// Worker stub made int17aR2OpCompute.test.ts vacuous, but the PRODUCT behaviour
// it claimed was in fact correct. There is no RED to record for it, so the cure
// is a stronger test (int17aR3OpCompute.test.ts) rather than a source change,
// and its non-vacuity is proven by mutation instead of by a RED repro.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type {
  ImportedGeometry, ModelBodyDisplay, Operation, PhysicalStock, Project,
  SceneStock, Setup, Tool, Vec3, BoundingBox, WCS, HeightParams, PassParams,
  LinkingParams, OperationType,
} from '../../types'
import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'
import { smartHeightAuthorityFixture } from '../helpers/smartHeightAuthorityFixture'
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

const { useCamStore } = await import('../../store')
const { DERIVED_STOCK_ID } = await import('../../store/migrateHierarchy')
const {
  cacheModelBodyDisplay,
  modelBodyCacheKey,
  MODEL_BODY_DISPLAY_CACHE_DB,
  MODEL_BODY_DISPLAY_CACHE_STORE,
  MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES,
} = await import('../../lib/modelBodyDisplayCache')

// ─── fixtures ────────────────────────────────────────────────────────────────

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

/** A legitimate loop-bearing 2D part on the derived stock. */
function ordinaryGeo(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 10, y: 10, z: 0 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    stockId: DERIVED_STOCK_ID, stockIdLocked: true,
    loops: [{
      id: `${id}-loop`,
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as unknown as ImportedGeometry
}

/** The hostile row: model ORIGIN wearing type 'brep' and real loops. */
function hostileModelGeo(): ImportedGeometry {
  return {
    id: 'modelbody:F1', name: 'Model F1', filename: '', type: 'brep', format: 'model',
    boundingBox: bbox({ x: 0, y: 0, z: -50 }, { x: 10, y: 10, z: 50 }),
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{
      id: 'modelbody:F1-loop',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true, type: 'contour', layerId: 'L1', area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 1 } },
  } as unknown as ImportedGeometry
}

function derivedStock(): PhysicalStock {
  return {
    id: DERIVED_STOCK_ID, name: 'Auto Stock 1', mode: 'derived',
    bounds: bbox({ x: -2, y: -2, z: 0 }, { x: 12, y: 12, z: 1 }),
    position: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}

const sceneStock: SceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [],
} as unknown as SceneStock

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'relative',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'stock_top',
  bottomHeight: -5, bottomHeightMode: 'absolute',
}
const passes: PassParams = {
  stepdown: 1.5, stepover: 3, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 2, rampLength: 5,
  leadInRadius: 1.5, leadOutRadius: 1, retractType: 'full', transitionType: 'safe_height',
}

const tool = {
  id: 'tool-1', name: 'EM6', type: 'flat_end_mill', diameter: 6,
  fluteLength: 20, shankDiameter: 6, overallLength: 50, numberOfFlutes: 2,
} as Tool

/** Build an op of `type`, naming `geometryId` through whichever field that
 *  family actually reads: 3D families read geometrySelections[0], 2.5D families
 *  read params.geometryId. That asymmetry IS finding C1.
 *
 *  Commit 2e5678b7: a valid smart_v2 envelope is now the ONLY runtime height
 *  authority, checked before this file's guard, so every op here needs one
 *  stamped or it dies on that boundary instead of the one this file exists
 *  to prove. All three families this file drives (parallel_3d, adaptive_3d,
 *  contour_2d) have a live Smart Height V2 policy. */
function makeOp(type: OperationType, geometryId: string): Operation {
  const is3d = type.endsWith('_3d')
  return {
    id: 'op-1', name: `Op ${type}`, type, enabled: true, status: 'ready',
    toolId: 'tool-1',
    geometrySelections: is3d ? [geometryId] : [],
    heights: structuredClone(heights),
    passes: structuredClone(passes),
    linking: structuredClone(linking),
    params: is3d
      ? { stepover: 1, angleDeg: 0 }
      : { geometryId, side: 'outside', direction: 'climb' },
    smartHeight: smartHeightAuthorityFixture(type, {
      setupId: 'setup-1', heights, geometryIds: [geometryId],
    }),
  } as unknown as Operation
}

function makeSetup(op: Operation): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs: {
      id: 'wcs-1', label: 'G54', fixtureOffset: 54, origin: { x: 0, y: 0, z: 0 },
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    } as WCS,
    stock: {
      type: 'rectangular', width: 100, height: 100, depth: 12,
      offsetX: 2, offsetY: 2, offsetZTop: 1, offsetZBottom: 0, material: 'al',
    },
    operations: [op], notes: '',
  } as unknown as Setup
}

function installProject(geometry: ImportedGeometry[], op: Operation): void {
  useCamStore.setState((s) => ({
    toolLibrary: [tool],
    project: {
      ...s.project,
      geometry,
      stocks: [derivedStock()],
      setups: [makeSetup(op)],
      sceneStock,
    } as Project,
  }))
}

const currentOp = (): Operation => useCamStore.getState().project.setups[0].operations[0]

/** The named guard outcome, as it renders today. Matching on this exact
 *  phrasing is the point: the 3D families DO error on something today (an
 *  unnamed, misleading message absent the guard), and an assertion on "did it
 *  error" alone would pass in both runs and prove nothing.
 *  CAM-BINDING Stage 1 changed the OUTCOME from a hard 'error' to the named
 *  'unsupported' state (a modeled body is now a legal declared source - see
 *  the status assertions below), so the phrasing changed with it; this repro
 *  file's job (proving the 3D families reach the SAME named guard the 2.5D
 *  control already did) is otherwise unchanged. */
const NAMED_REFUSAL = /sources modeled geometry "Model F1"/

describe('INT-17A-R3 repro C1: 3D op families bypass the named model-origin guard', () => {
  let OrigWorker: typeof Worker | undefined

  beforeEach(() => {
    OrigWorker = (globalThis as { Worker?: typeof Worker }).Worker
    ;(globalThis as { Worker?: unknown }).Worker = class {
      onmessage: ((e: unknown) => void) | null = null
      onerror: ((e: unknown) => void) | null = null
      postMessage(): void { /* no-op: no legitimate 2.5D compute runs in this file */ }
      terminate(): void { /* no-op */ }
    }
  })
  afterEach(() => {
    ;(globalThis as { Worker?: unknown }).Worker = OrigWorker
    vi.restoreAllMocks()
  })

  it('parallel_3d naming a modeled body reaches the named compute boundary (CAM-BINDING Stage 1: unsupported, not error)', async () => {
    installProject([ordinaryGeo('g1', 'Part A'), hostileModelGeo()],
      makeOp('parallel_3d', 'modelbody:F1'))

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status).toBe('unsupported')
    // RED on the pre-cure tree: the message is the incidental format check
    // ("parallel_3d needs an STL or STEP solid, but "Model F1" is model"),
    // not the named guard message every other family produces.
    expect(currentOp().errorMessage ?? '').toMatch(NAMED_REFUSAL)
    expect(currentOp().toolpathMoves ?? []).toHaveLength(0)
  })

  it('adaptive_3d naming a modeled body reaches the named compute boundary (CAM-BINDING Stage 1: unsupported, not error)', async () => {
    installProject([ordinaryGeo('g1', 'Part A'), hostileModelGeo()],
      makeOp('adaptive_3d', 'modelbody:F1'))

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status).toBe('unsupported')
    expect(currentOp().errorMessage ?? '').toMatch(NAMED_REFUSAL)
    expect(currentOp().toolpathMoves ?? []).toHaveLength(0)
  })

  it('CONTROL: contour_2d naming a modeled body already reaches the named guard', async () => {
    // Passes in BOTH runs. This is what makes the two failures above a MISSING
    // GUARD on the 3D branches rather than a harness that cannot see any guard.
    installProject([ordinaryGeo('g1', 'Part A'), hostileModelGeo()],
      makeOp('contour_2d', 'modelbody:F1'))

    await useCamStore.getState().computeOperationToolpath('setup-1', 'op-1')

    expect(currentOp().status).toBe('unsupported')
    expect(currentOp().errorMessage ?? '').toMatch(NAMED_REFUSAL)
  })
})

describe('INT-17A-R3 repro C3: the cache bound is not transactionally enforced', () => {
  let idb: FakeIndexedDBHandle

  beforeEach(() => { idb = installFakeIndexedDB() })
  afterEach(() => { idb.restore(); vi.restoreAllMocks() })

  const display = (): ModelBodyDisplay => ({
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    indices: new Uint32Array([0, 1, 2]),
    edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
    edgeOffsets: new Uint32Array([0, 2]),
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }),
  } as unknown as ModelBodyDisplay)

  const rowCount = (): number =>
    idb.records(MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE).size

  it('an eviction failure never leaves the store committed over the entry cap', async () => {
    // Seed the store exactly AT the cap with rows this build recognises, so the
    // very next write must evict exactly one row to stay legal.
    const cap = MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES
    for (let i = 0; i < cap; i++) {
      idb.seed(
        MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE,
        modelBodyCacheKey('proj-1', `modelbody:S${i}`),
        {
          schema: 2, projectId: 'proj-1', geometryId: `modelbody:S${i}`,
          bodyId: `S${i}`, version: 1, savedAt: 1000 + i, bytes: 1024,
          display: display(),
        },
      )
    }
    expect(rowCount()).toBe(cap)

    // Force the ENFORCEMENT half to fail, not the payload write.
    idb.failNextDelete()

    // The caller's contract is fire-and-forget, so a rejection here is fine and
    // expected - what is NOT fine is the store being left over cap either way.
    await cacheModelBodyDisplay(
      { projectId: 'proj-1', geometryId: 'modelbody:NEW', bodyId: 'NEW', version: 1 },
      display(),
    ).catch(() => { /* loud failure is an acceptable outcome; over-bound is not */ })

    // RED on the pre-cure tree: the put committed in its own transaction, the
    // eviction transaction aborted, and cap+1 rows are now permanently stored.
    expect(rowCount()).toBeLessThanOrEqual(cap)
  })

  it('CONTROL: an ordinary write at the cap evicts and stays at the cap', async () => {
    // Passes in BOTH runs: the eviction policy and its wiring already work when
    // nothing fails. That is what isolates the failure above to the TRANSACTION
    // BOUNDARY rather than to the policy.
    const cap = MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES
    for (let i = 0; i < cap; i++) {
      idb.seed(
        MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE,
        modelBodyCacheKey('proj-1', `modelbody:S${i}`),
        {
          schema: 2, projectId: 'proj-1', geometryId: `modelbody:S${i}`,
          bodyId: `S${i}`, version: 1, savedAt: 1000 + i, bytes: 1024,
          display: display(),
        },
      )
    }

    await cacheModelBodyDisplay(
      { projectId: 'proj-1', geometryId: 'modelbody:NEW', bodyId: 'NEW', version: 1 },
      display(),
    )

    expect(rowCount()).toBe(cap)
    expect(
      idb.records(MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE)
        .has(modelBodyCacheKey('proj-1', 'modelbody:NEW')),
    ).toBe(true)
  })
})
