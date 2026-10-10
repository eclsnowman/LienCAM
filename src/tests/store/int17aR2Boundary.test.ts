// INT-17A-R2: the three audit-FAIL cures, reproduced FIRST as failing tests
// (audit coordination/reports/INT-17A-R1.audit.json).
//
// C1 - the R1 exclusion sat at resolveOpGeometrySources, which is where an op's
//      geometryId becomes its SOURCE ROWS. But the height/coordinate resolvers
//      are handed the WHOLE project.geometry collection separately
//      (store/index.ts geometryForResolve), so a loop-bearing model-origin row
//      re-entered the compute path there and made a LEGITIMATE op fail. That is
//      the fail-CLOSED half of the same defect; the fail-OPEN half is an op that
//      names a modeled body directly and gets a silent empty resolution instead
//      of a refusal the user can read.
//
//      Per the binding DECISIONS.md 2026-07-18 SKC-59 class rule, the cure is a
//      BOUNDARY GUARD at the data's arrival point, not a wider reader census:
//      computeGeometryScope() runs where each compute resolver RECEIVES the
//      collection, so every caller - present, future, or aliased through a
//      parameter - is covered by construction and no enumeration is needed.
//
// C2 - the durable display cache stored a bare display under a bare geometry id.
//      It therefore accepted a payload derived from ANY ModelBodyRef version,
//      accepted one written by a DIFFERENT project that reused the same
//      modelbody:F1 id, and grew without bound.
//
// These tests drive the REAL modules. The cache tests in particular stand on a
// fake IDB PRIMITIVE (src/tests/helpers/fakeIndexedDB.ts) rather than a vi.mock
// of the cache itself, because R1's mock-the-module-under-test is precisely why
// no test ever exercised the accept rule the audit found missing.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ImportedGeometry, ModelBodyDisplay, PhysicalStock, Setup, SceneStock } from '../../types'
import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'

const {
  resolveOwningStock, resolveTopZ, resolveModelBottomZ,
  computeGeometryScope, ModelOriginComputeError,
} = await import('../../store/dispatchGeo')

const {
  cacheModelBodyDisplay, loadCachedModelBodyDisplay, removeCachedModelBodyDisplay,
  pruneModelBodyDisplayCache, selectModelBodyCacheEvictions,
  MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES, MODEL_BODY_DISPLAY_CACHE_MAX_BYTES,
  MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE, modelBodyCacheKey,
} = await import('../../lib/modelBodyDisplayCache')

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const bbox = { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 } }

/** An ordinary loop-bearing 2D part, assigned to a stock - a LEGITIMATE source. */
function loopGeo(id: string, stockId: string, z = 0): ImportedGeometry {
  return {
    id, name: `Part ${id}`, format: 'dxf', type: '2d',
    position: { x: 0, y: 0, z }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { ...bbox.min }, max: { ...bbox.max } },
    stockId,
    loops: [{ id: `${id}-l0`, layerId: 'L0', points: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ], closed: true, type: 'polyline' }],
    layers2d: [{ id: 'L0', name: 'L0', color: '#fff', visible: true }],
  } as unknown as ImportedGeometry
}

/**
 * The audit's hostile row: model ORIGIN wearing every shape a loops/type gate
 * looks at, carrying NO stockId (Stage 1 refuses to stock-bind it, R1 C3) and
 * sitting HIGH in Z so a leaked aggregate is visible as a wrong number, not just
 * a thrown error.
 */
function hostileModelGeo(id = 'mg1', z = 500): ImportedGeometry {
  return {
    id, name: 'Model F1', format: 'model', type: 'brep',
    position: { x: 0, y: 0, z }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: -50 }, max: { x: 10, y: 10, z: 50 } },
    loops: [{ id: `${id}-l0`, layerId: 'L0', points: [
      { x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 },
    ], closed: true, type: 'polyline' }],
    layers2d: [{ id: 'L0', name: 'L0', color: '#fff', visible: true }],
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:F0'], version: 3 } },
  } as unknown as ImportedGeometry
}

const stockA: PhysicalStock = {
  id: 'stock-a', name: 'Stock A', mode: 'explicit',
  position: { x: 0, y: 0, z: -12 },
  bounds: { size: { x: 100, y: 100, z: 12 } },
} as unknown as PhysicalStock

const setup = {
  id: 's1', name: 'Setup 1',
  wcs: { origin: { x: 0, y: 0, z: 0 }, stockId: 'stock-a' },
} as unknown as Setup

const sceneStock = {
  mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1,
  fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [], autoStocks: [],
} as unknown as SceneStock

// ─────────────────────────────────────────────────────────────────────────────
// C1 - the compute boundary guard
// ─────────────────────────────────────────────────────────────────────────────

describe('C1 boundary guard: model-origin rows cannot re-enter coordinate/height resolution', () => {
  it('resolveOwningStock("__all__") RESOLVES a legitimate op with a modeled body present', () => {
    // THE AUDIT REPRO. The modeled body is loop-bearing and (correctly, per R1
    // C3) carries no stockId, so the "__all__" unassigned check named it and
    // threw - blocking an operation that has a perfectly good single owner.
    const geometry = [loopGeo('a', 'stock-a'), loopGeo('b', 'stock-a'), hostileModelGeo()]
    const owning = resolveOwningStock('__all__', geometry, [stockA])
    expect(owning.id).toBe('stock-a')
  })

  it('resolveTopZ("stock_top","__all__") resolves instead of throwing on the modeled body', () => {
    const geometry = [loopGeo('a', 'stock-a'), loopGeo('b', 'stock-a'), hostileModelGeo()]
    const z = resolveTopZ('stock_top', 0, setup, sceneStock, geometry, '__all__', [stockA])
    // Explicit stock: top = position.z + size.z = -12 + 12 = 0, WCS-relative 0.
    expect(z).toBeCloseTo(0, 6)
  })

  it('the modeled body does not CONTRIBUTE to an "__all__" model_top aggregate', () => {
    // Fail-open half: the hostile row sits at z=500 with bbox.max.z=50, so if it
    // leaked into the Math.max the plane would land at 550 instead of the real
    // parts' 5. A wrong reference plane is a wrong cut, not just a blocked op.
    const geometry = [loopGeo('a', 'stock-a'), loopGeo('b', 'stock-a'), hostileModelGeo()]
    const z = resolveTopZ('model_top', 0, setup, sceneStock, geometry, '__all__', [stockA])
    expect(z).toBeCloseTo(5, 6)
  })

  it('the modeled body does not CONTRIBUTE to an "__all__" model_bottom aggregate', () => {
    // The hostile row's world bottom is 500 + (-50) = 450; the real parts' is 0.
    // A leak here would only show up as a too-high bottom plane, so assert the
    // real value rather than "not 450".
    const geometry = [loopGeo('a', 'stock-a'), loopGeo('b', 'stock-a'), hostileModelGeo('mg1', -500)]
    const z = resolveModelBottomZ(geometry, '__all__', 0, [stockA])
    expect(z).toBeCloseTo(0, 6)
  })

  it('a DIRECT geometryId naming a modeled body is refused BY NAME, not silently', () => {
    // R1 made this resolve to an empty source list - a silent block. The WO's
    // C1 requires the same NAMED, user-visible refusal the picker shows.
    const geometry = [loopGeo('a', 'stock-a'), hostileModelGeo()]
    let thrown: unknown
    try { resolveOwningStock('mg1', geometry, [stockA]) } catch (e) { thrown = e }
    expect(thrown).toBeInstanceOf(ModelOriginComputeError)
    expect((thrown as Error).message).toContain('Model F1')
    expect((thrown as Error).message).toContain('read-only projection')
  })

  it('resolveTopZ refuses a picked_plane datum that belongs to a modeled body', () => {
    // The plane reference is a SECOND way an op reads a modeled row's coordinate
    // frame, and it never goes through geometryId. Scoping the collection alone
    // would turn it into a misleading "no surface has been picked" error, so the
    // guard takes the referenced id too.
    const geometry = [loopGeo('a', 'stock-a'), hostileModelGeo()]
    expect(() => resolveTopZ(
      'picked_plane', 0, setup, sceneStock, geometry, 'a', [stockA], [],
      { geoId: 'mg1', faceIndex: 0, localZ: 2 },
    )).toThrow(ModelOriginComputeError)
  })

  it('computeGeometryScope is the ONE named seam, and is idempotent', () => {
    const geometry = [loopGeo('a', 'stock-a'), hostileModelGeo()]
    const once = computeGeometryScope(geometry, '__all__')
    expect(once.map((g) => g.id)).toEqual(['a'])
    // Idempotent: the resolvers nest (resolveTopZ -> resolveOwningStock), so a
    // second application must be a no-op rather than a second policy decision.
    expect(computeGeometryScope(once, '__all__').map((g) => g.id)).toEqual(['a'])
  })

  it('an ordinary project is BYTE-UNCHANGED by the guard (no-regression control)', () => {
    // Non-vacuity control: with no modeled row present the scope is the identity
    // and every resolver returns exactly what it returned before this WO.
    const geometry = [loopGeo('a', 'stock-a'), loopGeo('b', 'stock-a')]
    expect(computeGeometryScope(geometry, '__all__')).toEqual(geometry)
    expect(resolveOwningStock('__all__', geometry, [stockA]).id).toBe('stock-a')
    expect(resolveTopZ('model_top', 0, setup, sceneStock, geometry, '__all__', [stockA])).toBeCloseTo(5, 6)
    expect(resolveModelBottomZ(geometry, '__all__', 0, [stockA])).toBeCloseTo(0, 6)
  })

  it('an unassigned ORDINARY part still fail-louds (the guard did not blunt ADR-0003)', () => {
    // The cure removes modeled rows from the unassigned check. It must NOT
    // remove genuine unassigned parts - that check is the B22 correctness win.
    const orphan = loopGeo('c', 'stock-a')
    delete (orphan as { stockId?: string }).stockId
    const geometry = [loopGeo('a', 'stock-a'), orphan, hostileModelGeo()]
    expect(() => resolveOwningStock('__all__', geometry, [stockA]))
      .toThrow(/not assigned to an existing stock/)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// C2 - cache lifecycle: version safety, bound, project cleanup
// ─────────────────────────────────────────────────────────────────────────────

function display(tag = 0, size = 3): ModelBodyDisplay {
  const positions: number[] = []
  for (let i = 0; i < size; i++) positions.push(tag + i, 0, 0)
  return {
    positions,
    normals: positions.map(() => 1),
    indices: [0, 1, 2],
    edgePositions: [0, 0, 0, 1, 0, 0],
    edgeOffsets: [0, 2],
    bbox: { min: [tag, 0, 0], max: [1, 1, 0] },
  }
}

const scope = (over: Partial<{ projectId: string; geometryId: string; bodyId: string; version: number }> = {}) => ({
  projectId: 'proj-1', geometryId: 'modelbody:F1', bodyId: 'F1', version: 1, ...over,
})

describe('C2 cache lifecycle', () => {
  let idb: FakeIndexedDBHandle

  beforeEach(() => { idb = installFakeIndexedDB() })
  afterEach(() => { idb.restore(); vi.restoreAllMocks() })

  const stored = () => idb.records(MODEL_BODY_DISPLAY_CACHE_DB, MODEL_BODY_DISPLAY_CACHE_STORE)

  it('a round trip at the SAME ref version hits', async () => {
    await cacheModelBodyDisplay(scope(), display(7))
    const got = await loadCachedModelBodyDisplay(scope())
    expect(got?.positions[0]).toBe(7)
  })

  it('THE AUDIT REPRO: a STALE ref version is a MISS, not an accepted payload', async () => {
    // R1 stored a bare display under the geometry id and restoreScene patched
    // whatever it found onto the current ref. So a body re-derived to version 2
    // while the cache still held version 1's tessellation restored the OLD
    // shape onto the NEW ref - a silently wrong render with no way to notice.
    await cacheModelBodyDisplay(scope({ version: 1 }), display(1))
    const got = await loadCachedModelBodyDisplay(scope({ version: 2 }))
    expect(got).toBeNull()
  })

  it('a stale-version record is REMOVED on the miss, not left to accumulate', async () => {
    await cacheModelBodyDisplay(scope({ version: 1 }), display(1))
    expect(stored().size).toBe(1)
    await loadCachedModelBodyDisplay(scope({ version: 2 }))
    expect(stored().size).toBe(0)
  })

  it('a DIFFERENT project reusing the same modelbody:F1 id does not collide', async () => {
    // modelbody:<bodyId> ids restart at F1 in every project, so an unscoped key
    // let project B restore project A's tessellation.
    await cacheModelBodyDisplay(scope({ projectId: 'proj-1' }), display(1))
    await cacheModelBodyDisplay(scope({ projectId: 'proj-2' }), display(2))
    expect((await loadCachedModelBodyDisplay(scope({ projectId: 'proj-1' })))?.positions[0]).toBe(1)
    expect((await loadCachedModelBodyDisplay(scope({ projectId: 'proj-2' })))?.positions[0]).toBe(2)
    expect(stored().size).toBe(2)
  })

  it('a body id mismatch under the same geometry id is a MISS', async () => {
    await cacheModelBodyDisplay(scope({ bodyId: 'F1' }), display(1))
    expect(await loadCachedModelBodyDisplay(scope({ bodyId: 'F9' }))).toBeNull()
  })

  it('a record written by an OLDER schema is a miss, not a crash', async () => {
    // The R1 record shape was a bare ModelBodyDisplay with no envelope at all.
    // A browser profile that ran R1 still has those rows; reading one must not
    // throw and must not be accepted.
    stored().set(modelBodyCacheKey('proj-1', 'modelbody:F1'), display(5))
    expect(await loadCachedModelBodyDisplay(scope())).toBeNull()
  })

  it('the cache is BOUNDED: writing past the cap evicts the least-recently-written', async () => {
    const cap = MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES
    for (let i = 0; i < cap; i++) {
      await cacheModelBodyDisplay(scope({ geometryId: `g${i}`, bodyId: `B${i}` }), display(i))
    }
    expect(stored().size).toBe(cap)
    await cacheModelBodyDisplay(scope({ geometryId: 'gNEW', bodyId: 'BNEW' }), display(999))
    expect(stored().size).toBeLessThanOrEqual(cap)
    // The NEWEST write survives and the OLDEST is the one that went.
    expect((await loadCachedModelBodyDisplay(scope({ geometryId: 'gNEW', bodyId: 'BNEW' })))?.positions[0]).toBe(999)
    expect(await loadCachedModelBodyDisplay(scope({ geometryId: 'g0', bodyId: 'B0' }))).toBeNull()
  })

  it('the eviction POLICY is pure and honours the byte budget too', () => {
    // The byte budget cannot be driven end-to-end without allocating tens of MB
    // of fixture, so the policy that enforces it is exported and tested here
    // directly; the COUNT cap above is the end-to-end proof that the policy is
    // actually wired into the write path.
    const big = Math.ceil(MODEL_BODY_DISPLAY_CACHE_MAX_BYTES / 2) + 1
    const index = [
      { key: 'old', savedAt: 1, bytes: big },
      { key: 'mid', savedAt: 2, bytes: big },
      { key: 'new', savedAt: 3, bytes: big },
    ]
    const evict = selectModelBodyCacheEvictions(index, {
      maxEntries: MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES,
      maxBytes: MODEL_BODY_DISPLAY_CACHE_MAX_BYTES,
    })
    // Two of these three already exceed the budget, so the two oldest go.
    expect(evict).toEqual(['old', 'mid'])
    // Nothing to do when both bounds hold (non-vacuity control).
    expect(selectModelBodyCacheEvictions(
      [{ key: 'a', savedAt: 1, bytes: 10 }],
      { maxEntries: MODEL_BODY_DISPLAY_CACHE_MAX_ENTRIES, maxBytes: MODEL_BODY_DISPLAY_CACHE_MAX_BYTES },
    )).toEqual([])
  })

  it('project lifecycle cleanup drops every record the incoming project does not own', async () => {
    await cacheModelBodyDisplay(scope({ projectId: 'proj-1', geometryId: 'keep' }), display(1))
    await cacheModelBodyDisplay(scope({ projectId: 'proj-1', geometryId: 'drop' }), display(2))
    await cacheModelBodyDisplay(scope({ projectId: 'proj-OLD', geometryId: 'keep' }), display(3))

    await pruneModelBodyDisplayCache('proj-1', new Set(['keep']))

    expect([...stored().keys()]).toEqual([modelBodyCacheKey('proj-1', 'keep')])
  })

  it('removal is project-scoped (deleting in one project keeps the other)', async () => {
    await cacheModelBodyDisplay(scope({ projectId: 'proj-1' }), display(1))
    await cacheModelBodyDisplay(scope({ projectId: 'proj-2' }), display(2))
    await removeCachedModelBodyDisplay('proj-1', 'modelbody:F1')
    expect(await loadCachedModelBodyDisplay(scope({ projectId: 'proj-1' }))).toBeNull()
    expect(await loadCachedModelBodyDisplay(scope({ projectId: 'proj-2' }))).not.toBeNull()
  })

  it('a write failure (quota) REJECTS rather than reporting a phantom store', async () => {
    // The contract at the call site is fire-and-forget, but the module itself
    // must not resolve on a failed put - a swallowed rejection here is how a
    // caller ends up believing a payload is recoverable when it is not.
    idb.failNextWrite()
    await expect(cacheModelBodyDisplay(scope(), display(1))).rejects.toThrow(/Quota/)
    expect(stored().size).toBe(0)
  })
})
