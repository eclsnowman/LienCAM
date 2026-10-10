// @vitest-environment jsdom
// MSH-4-OPERAND-CACHE (booked docs/planning/POST-MERGE-WORKPLAN.md, vetted
// coordination/reports/OPEN-QUEUE-VET.report.md item 1): booleanMeshVsModelBody
// unconditionally re-read + re-parsed the cached STL and re-resolved +
// re-world-baked the model body's display tessellation on EVERY call, even an
// Edit re-run against the IDENTICAL operand pair. This file pins:
//   1. cache-hit reuse - a repeat call against the same (meshGeoId, modelGeoId)
//      pair, including the Edit re-run path, does NOT re-read/re-parse the STL
//      or re-bake either operand.
//   2. invalidation on mesh placement change - moving the mesh operand forces
//      a recompute and the boolean result reflects the NEW position (not a
//      stale bake).
//   3. invalidation on model-item placement change - same, for the model side.
//   4. invalidation on model retessellation (a fresh `display` object) - same.
//   5. result-identity - a cache HIT produces byte-identical geometry to a
//      cold MISS (the cache changes speed, never correctness).
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  loadCachedSTL: vi.fn(),
  cacheSTL: vi.fn(async () => {}),
  removeCachedSTL: vi.fn(async () => {}),
}))

// Wrap (not replace) the real implementations so behavior is unchanged but
// call counts are observable - the RED->GREEN signal for cache-hit reuse.
vi.mock('../../mesh/stl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../mesh/stl')>()
  return typedMock<typeof import('../../mesh/stl')>({ ...actual, importStl: vi.fn(actual.importStl) })
})
vi.mock('../../lib/cam/booleanMeshModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/cam/booleanMeshModel')>()
  return typedMock<typeof import('../../lib/cam/booleanMeshModel')>({ ...actual, worldBakedMesh: vi.fn(actual.worldBakedMesh) })
})

import { useCamStore } from '../../store'
import { loadCachedSTL } from '../../lib/stlCache'
import { importStl } from '../../mesh/stl'
import { worldBakedMesh } from '../../lib/cam/booleanMeshModel'
import {
  ManifoldKernel,
  crossDomainBooleanMesh,
  exportBinaryStl,
  type MeshBuffers,
} from '../../mesh'
import type { ManifoldWasmModule } from '../../mesh/manifoldKernel'
import {
  setCrossDomainBooleanRunnerForTests,
  type CrossDomainBooleanRunner,
} from '../../mesh/browserMeshClient'
import type { ImportedGeometry, ModelBodyDisplay } from '../../types'

async function nodeManifoldFactory(): Promise<ManifoldWasmModule> {
  const pkg = (await import('manifold-3d')) as { default?: (opts?: unknown) => Promise<ManifoldWasmModule> } | ((opts?: unknown) => Promise<ManifoldWasmModule>)
  const factory = typeof pkg === 'function' ? pkg : pkg.default
  if (factory === undefined) throw new Error('manifold-3d default factory export was not found')
  return factory({})
}

const kernel = new ManifoldKernel(nodeManifoldFactory)
const realRunner: CrossDomainBooleanRunner = {
  async crossDomainBoolean(left, right, params) {
    const module = await kernel.getModule({ requireManifold: true })
    return crossDomainBooleanMesh(module, left, right, params)
  },
}

/** Outward-wound, watertight box [0..s]^3, 12 triangles, per-face ids. */
function boxIndices() {
  return [
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    2, 3, 7, 2, 7, 6, 0, 4, 7, 0, 7, 3, 1, 2, 6, 1, 6, 5,
  ]
}
function boxPositions(s: number) {
  return [0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, 0, 0, s, s, 0, s, s, s, s, 0, s, s]
}
function boxMesh(s: number): MeshBuffers {
  return { positions: new Float32Array(boxPositions(s)), indices: new Uint32Array(boxIndices()) }
}
function boxDisplay(s: number): ModelBodyDisplay {
  const positions = boxPositions(s)
  const triFace = [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]
  const faceIds = ['f0', 'f1', 'f2', 'f3', 'f4', 'f5']
  return {
    positions, normals: new Array(positions.length).fill(0), indices: boxIndices(),
    edgePositions: [], edgeOffsets: [], bbox: { min: [0, 0, 0], max: [s, s, s] }, faceIds, triFace,
  }
}

function meshRow(id: string, name: string): ImportedGeometry {
  return {
    id, name, filename: `${name}.stl`, type: 'mesh', format: 'stl',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 }, size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
  }
}
function modelRow(id: string, name: string, display: ModelBodyDisplay): ImportedGeometry {
  return {
    id, name, filename: name, type: 'model', format: 'model',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 5, y: 5, z: 5 }, size: { x: 5, y: 5, z: 5 }, center: { x: 2.5, y: 2.5, z: 2.5 } },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: 'legacy',
    modelBody: { ref: { bodyId: 'B1', stableIds: [], version: 1 }, display },
  }
}

function seed(modelDisplay: ModelBodyDisplay) {
  useCamStore.getState().newProject()
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [meshRow('mesh1', 'cube'), modelRow('model1', 'Block', modelDisplay)],
      modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
      // Empty stocks: this file's cache-hit pins assert object-reference
      // stability of mesh1/model1 ACROSS repeated boolean calls. A non-empty
      // (default derived) stock list is an orthogonal concern - it would
      // settle mesh1's stockId from undefined on the first addGeometry the
      // boolean's own result row triggers (a one-time reference churn, real
      // in the app too, but unrelated to operand caching) and make the
      // cache-hit assertions depend on stock-membership timing instead of on
      // the cache itself. Stock assignment is exercised by its own suite.
      stocks: [],
    },
  }))
}

beforeEach(() => {
  setCrossDomainBooleanRunnerForTests(realRunner)
  vi.mocked(loadCachedSTL).mockResolvedValue(exportBinaryStl(boxMesh(10)).bytes)
  vi.mocked(importStl).mockClear()
  vi.mocked(worldBakedMesh).mockClear()
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    addSTL: async () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }),
    setSelectedPart: () => {},
  }
})
afterAll(() => {
  setCrossDomainBooleanRunnerForTests(null)
  kernel.dispose()
})

describe('booleanMeshVsModelBody operand cache (MSH-4-OPERAND-CACHE)', () => {
  it('cache-hit: a second call against the SAME pair skips the STL read/parse and both world-bakes', async () => {
    seed(boxDisplay(5))
    const first = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'difference')
    expect(first.ok).toBe(true)
    expect(vi.mocked(loadCachedSTL).mock.calls.length).toBe(1)
    expect(vi.mocked(importStl).mock.calls.length).toBe(1)
    expect(vi.mocked(worldBakedMesh).mock.calls.length).toBe(2) // one mesh operand + one model operand

    const second = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'difference')
    expect(second.ok).toBe(true)
    // No additional STL read/parse or bake happened on the repeat call.
    expect(vi.mocked(loadCachedSTL).mock.calls.length).toBe(1)
    expect(vi.mocked(importStl).mock.calls.length).toBe(1)
    expect(vi.mocked(worldBakedMesh).mock.calls.length).toBe(2)

    if (!first.ok || !second.ok) return
    const geoA = useCamStore.getState().project.geometry.find((g) => g.id === first.newId)!
    const geoB = useCamStore.getState().project.geometry.find((g) => g.id === second.newId)!
    // Result-identity: a cache hit must be byte-identical to the cold miss.
    expect(geoB.booleanProvenance!.volumeMm3).toBeCloseTo(geoA.booleanProvenance!.volumeMm3, 9)
    expect(geoB.booleanProvenance!.triangleCount).toBe(geoA.booleanProvenance!.triangleCount)
    expect(geoB.approximate).toBe(geoA.approximate)
  })

  it('cache-hit: the Edit re-run path (replaceResultId) also skips re-read/re-parse/re-bake', async () => {
    seed(boxDisplay(5))
    const first = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'difference')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    vi.mocked(loadCachedSTL).mockClear()
    vi.mocked(importStl).mockClear()
    vi.mocked(worldBakedMesh).mockClear()

    const rerun = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'union', first.newId)
    expect(rerun.ok).toBe(true)
    if (!rerun.ok) return
    expect(rerun.newId).toBe(first.newId)
    expect(vi.mocked(loadCachedSTL).mock.calls.length).toBe(0)
    expect(vi.mocked(importStl).mock.calls.length).toBe(0)
    expect(vi.mocked(worldBakedMesh).mock.calls.length).toBe(0)
  })

  it('invalidation: moving the mesh operand forces a recompute and the result reflects the NEW position', async () => {
    seed(boxDisplay(5))
    // Both boxes share the origin corner -> intersect is the model box, 125 mm^3.
    const first = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'intersect')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.ok && useCamStore.getState().project.geometry.find((g) => g.id === first.newId)?.booleanProvenance?.volumeMm3).toBeCloseTo(125, 0)

    // Move the mesh cube far away from the model box.
    useCamStore.getState().updateGeometryTransform('mesh1', { x: 200, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    vi.mocked(loadCachedSTL).mockClear()
    vi.mocked(importStl).mockClear()
    vi.mocked(worldBakedMesh).mockClear()

    const second = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'intersect')
    // A stale cache would still report the OLD (overlapping) position and
    // wrongly succeed with ~125 mm^3; the boxes no longer overlap so this
    // MUST refuse as an empty result.
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error).toMatch(/empty result/)
    // The move forced a genuine recompute (cache invalidated), not a hang-on-stale-hit.
    expect(vi.mocked(loadCachedSTL).mock.calls.length).toBe(1)
    expect(vi.mocked(importStl).mock.calls.length).toBe(1)
  })

  it('invalidation: moving the model item placement forces a recompute and the result reflects the NEW placement', async () => {
    seed(boxDisplay(5))
    const first = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'intersect')
    expect(first.ok).toBe(true)

    // Replace (not mutate) the placements array with the item moved far away.
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 200, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }],
      },
    }))
    vi.mocked(worldBakedMesh).mockClear()

    const second = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'intersect')
    expect(second.ok).toBe(false)
    if (second.ok) return
    expect(second.error).toMatch(/empty result/)
    expect(vi.mocked(worldBakedMesh).mock.calls.length).toBeGreaterThan(0) // model operand re-baked
  })

  it('invalidation: a fresh display object (retessellation) forces a recompute and the result reflects the NEW body', async () => {
    seed(boxDisplay(5))
    const first = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'intersect')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(useCamStore.getState().project.geometry.find((g) => g.id === first.newId)?.booleanProvenance?.volumeMm3).toBeCloseTo(125, 0)

    // Simulate a retessellation: a brand-new display object, smaller box.
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: s.project.geometry.map((g) =>
          g.id === 'model1' && g.modelBody
            ? { ...g, modelBody: { ref: g.modelBody.ref, display: boxDisplay(2) } }
            : g,
        ),
      },
    }))
    vi.mocked(worldBakedMesh).mockClear()

    const second = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'intersect')
    expect(second.ok).toBe(true)
    if (!second.ok) return
    const geo = useCamStore.getState().project.geometry.find((g) => g.id === second.newId)
    // 2mm box fully inside the 10mm cube -> intersect volume 8 mm^3, NOT the
    // stale 125 mm^3 the old (5mm) display would have produced.
    expect(geo!.booleanProvenance!.volumeMm3).toBeCloseTo(8, 0)
    expect(vi.mocked(worldBakedMesh).mock.calls.length).toBeGreaterThan(0)
  })
})
