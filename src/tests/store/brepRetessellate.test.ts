// F3: live B-rep re-tessellation when the render-fidelity (brepTessellationQuality)
// Settings tier changes. retessellateBrepParts re-reads each loaded STEP part's
// cached bytes through the model worker at the NEW deflection and swaps the mesh
// in the viewport, preserving placement/color/hidden. These tests drive the real
// helper against a recording viewport double, mocking the IndexedDB + worker
// boundaries (loadCachedStep / readStep) that have no node equivalent.
//
// Asserted: STEP-only (STL/2D untouched), nest-owned seeds skipped, missing bytes
// surface a named error (ADR 0003) without swapping, and the stale-result guard
// (isCurrent) both stops the loop early AND drops a superseded in-flight result.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ImportedGeometry } from '../../types'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import { typedMock } from '../support/typedMock'

// Mock the IndexedDB + worker seams the helper imports.
const loadCachedStep = vi.fn<(id: string) => Promise<ArrayBuffer | null>>()
const cacheStepDisplay = vi.fn<() => Promise<void>>()
const readStep = vi.fn<() => Promise<BrepModelPayload>>()
const setBrepPayload = vi.fn()

vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  STEP_DISPLAY_CONTRACT_VERSION: 1,
  computeStepSha256: async () => '34'.repeat(32),
  loadCachedStep: (id: string) => loadCachedStep(id),
  cacheStepDisplay: () => cacheStepDisplay(),
}))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', () => typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
  readStep: () => readStep(),
  setBrepPayload: (...a: unknown[]) => setBrepPayload(...a),
}))
// quality.ts reads the live store for the deflection; stub it to a fixed value so
// the helper never touches the real store/worker.
vi.mock('../../lib/cam/geometry/occt/model/quality', () => typedMock<typeof import('../../lib/cam/geometry/occt/model/quality')>({
  deflectionForQuality: () => ({ linearDeflection: 0.025, angularDeflection: 0.12 }),
  DEFAULT_BREP_QUALITY: 'balanced',
}))
// FINDING (left untouched, still untyped): the real `useCamStore` export is a
// zustand `UseBoundStore<StoreApi<CamStore>>` - a CALLABLE hook with attached
// getState/setState/subscribe/persist statics. This factory returns a plain
// object literal ({ getState: () => ({...}) }), which has no call signature,
// so it cannot be assigned to Partial<typeof import('../../store')> regardless
// of what `getState` returns - the mismatch is on the export's own top-level
// shape (function vs. object), not fixable without constructing a real
// zustand store in place of this lightweight stub.
vi.mock('../../store', () => ({
  useCamStore: {
    getState: () => ({ appSettings: { brepTessellationQuality: 'high' } }),
  },
}))

import { retessellateBrepParts, type RestoreViewport } from '../../lib/viewport/restoreScene'

const fakePayload = (): BrepModelPayload =>
  ({
    mesh: {
      positions: new Float32Array(0), normals: new Float32Array(0),
      indices: new Uint32Array(0), faceRanges: new Uint32Array(0),
    },
    edges: { positions: new Float32Array(0), edgeRanges: new Uint32Array(0) },
    faceTypes: new Uint8Array(0), faceCount: 0,
    bbox: { min: [0, 0, 0], max: [1, 1, 1] },
  } as unknown as BrepModelPayload)

interface RecVp extends RestoreViewport {
  added: Array<{ id: string; pos?: { x: number; y: number; z: number } }>
  hidden: string[]
}
function makeVp(): RecVp {
  const added: RecVp['added'] = []
  const hidden: string[] = []
  return {
    added, hidden,
    addBrepModel: (id, _p, _n, pos) => { added.push({ id, pos }) },
    addModelBody: (id, _d, _n, pos) => { added.push({ id, pos }) },
    setSTLVisible: (id, visible) => { if (!visible) hidden.push(id) },
    addSTL: async () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 } }),
    setPartLoopsOnFacePlane: () => {},
    setPartProjectedLoops: () => {},
    add2DGeometry: () => {},
  }
}

function stepGeo(id: string, extra: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id, name: id, filename: `${id}.step`, type: 'brep', format: 'step',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    loaded: true, ...extra,
  } as ImportedGeometry
}
function stlGeo(id: string): ImportedGeometry {
  return { ...stepGeo(id), type: 'mesh', format: 'stl' } as ImportedGeometry
}

const hooks = () => ({ patchGeometry: vi.fn(), setBrepImportError: vi.fn() })

describe('F3: retessellateBrepParts', () => {
  beforeEach(() => {
    loadCachedStep.mockReset()
    cacheStepDisplay.mockReset()
    readStep.mockReset()
    setBrepPayload.mockReset()
    loadCachedStep.mockResolvedValue(new ArrayBuffer(8))
    cacheStepDisplay.mockResolvedValue()
    readStep.mockResolvedValue(fakePayload())
  })

  it('re-tessellates every loaded STEP part and swaps it in the viewport', async () => {
    const vp = makeVp()
    await retessellateBrepParts(vp, [stepGeo('a'), stepGeo('b')], hooks())
    expect(vp.added.map((x) => x.id).sort()).toEqual(['a', 'b'])
    expect(readStep).toHaveBeenCalledTimes(2)
    expect(setBrepPayload).toHaveBeenCalledTimes(2)
  })

  it('ignores STL and 2D parts (B-rep only)', async () => {
    const vp = makeVp()
    await retessellateBrepParts(vp, [stlGeo('stl'), stepGeo('step')], hooks())
    expect(vp.added.map((x) => x.id)).toEqual(['step'])
    expect(loadCachedStep).toHaveBeenCalledTimes(1)
  })

  it('skips nest-owned seed sources', async () => {
    const vp = makeVp()
    await retessellateBrepParts(
      vp, [stepGeo('seed'), stepGeo('normal')], hooks(), [], new Set(['seed']),
    )
    expect(vp.added.map((x) => x.id)).toEqual(['normal'])
  })

  it('preserves hidden state', async () => {
    const vp = makeVp()
    await retessellateBrepParts(vp, [stepGeo('h', { hidden: true })], hooks())
    expect(vp.hidden).toContain('h')
  })

  it('surfaces a named error when cached bytes are missing, without swapping', async () => {
    loadCachedStep.mockResolvedValue(null)
    const vp = makeVp()
    const h = hooks()
    await retessellateBrepParts(vp, [stepGeo('gone')], h)
    expect(vp.added).toHaveLength(0)
    expect(h.setBrepImportError).toHaveBeenCalledTimes(1)
    expect(readStep).not.toHaveBeenCalled()
  })

  it('no-ops when no B-rep parts are loaded', async () => {
    const vp = makeVp()
    await retessellateBrepParts(vp, [stlGeo('only-stl')], hooks())
    expect(vp.added).toHaveLength(0)
    expect(loadCachedStep).not.toHaveBeenCalled()
  })

  it('stale guard: stops the loop early when superseded before a part starts', async () => {
    const vp = makeVp()
    await retessellateBrepParts(
      vp, [stepGeo('a'), stepGeo('b')], hooks(), [], new Set(),
      () => false,   // already superseded: nothing should run
    )
    expect(vp.added).toHaveLength(0)
    expect(loadCachedStep).not.toHaveBeenCalled()
  })

  it('stale guard: drops a superseded result after the async round-trip', async () => {
    // isCurrent passes the pre-load check (so the worker runs) but flips false
    // before the result is swapped in -> the now-stale mesh must NOT be attached.
    let calls = 0
    const isCurrent = () => { calls += 1; return calls === 1 }  // true once, then false
    const vp = makeVp()
    await retessellateBrepParts(vp, [stepGeo('a')], hooks(), [], new Set(), isCurrent)
    expect(readStep).toHaveBeenCalledTimes(1)   // the worker did run
    expect(vp.added).toHaveLength(0)            // but the stale result was dropped
  })
})
