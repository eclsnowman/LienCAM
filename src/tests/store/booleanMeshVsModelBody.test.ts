// @vitest-environment jsdom
// MSH-4-BOOLEAN-EDIT Stage 1: the store action, driven through a REAL manifold-3d
// boolean (off the worker thread, injected - the MSH-4-MESHLAB-PROOF pattern).
// Proves the happy path (10mm mesh cube MINUS a 5mm corner Model box = 875 mm^3,
// a new static row, honest EXACT label for the planar body), the APPROXIMATE
// label path (curved body), named refusals, and Edit-replace-in-place.
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { typedMock } from '../support/typedMock'

// The STL cache is IndexedDB-backed; mock it so the action's loadCachedSTL/cacheSTL
// are deterministic and Worker/DB-free.
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  loadCachedSTL: vi.fn(),
  cacheSTL: vi.fn(async () => {}),
  removeCachedSTL: vi.fn(async () => {}),
}))

import { useCamStore } from '../../store'
import { loadCachedSTL } from '../../lib/stlCache'
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
function boxDisplay(s: number, merged = false): ModelBodyDisplay {
  const positions = boxPositions(s)
  const triFace = merged
    ? [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4]
    : [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]
  const faceIds = merged ? ['f0', 'f1', 'f2', 'f3', 'f4'] : ['f0', 'f1', 'f2', 'f3', 'f4', 'f5']
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
    },
  }))
}

beforeEach(() => {
  setCrossDomainBooleanRunnerForTests(realRunner)
  vi.mocked(loadCachedSTL).mockResolvedValue(exportBinaryStl(boxMesh(10)).bytes)
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    addSTL: async () => ({ min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 } }),
    setSelectedPart: () => {},
  }
})
afterAll(() => {
  setCrossDomainBooleanRunnerForTests(null)
  kernel.dispose()
})

describe('booleanMeshVsModelBody (MSH-4 Stage 1, real manifold)', () => {
  it('mesh cube MINUS planar model box = 875 mm^3, appended as an EXACT static row', async () => {
    seed(boxDisplay(5))
    const outcome = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'difference')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.approximate).toBe(false) // planar body => exact
    const geo = useCamStore.getState().project.geometry.find((g) => g.id === outcome.newId)
    expect(geo).toBeTruthy()
    expect(geo!.format).toBe('stl')
    expect(geo!.type).toBe('mesh')
    expect(geo!.name).toBe('cube (subtract)')
    expect(geo!.approximate).toBe(false)
    expect(geo!.booleanProvenance?.sourceMeshName).toBe('cube')
    expect(geo!.booleanProvenance?.modelBodyName).toBe('Block')
    expect(geo!.booleanProvenance!.volumeMm3).toBeCloseTo(875, 0)
    expect(geo!.booleanProvenance!.triangleCount).toBeGreaterThan(0)
    // success console event landed, no error surfaced.
    expect(useCamStore.getState().brepImportError).toBeNull()
    const events = useCamStore.getState().consoleEvents
    expect(events.some((e) => e.severity === 'success' && /created - exact/.test(e.message))).toBe(true)
  })

  it('a curved model body yields an APPROXIMATE row', async () => {
    seed(boxDisplay(5, true)) // merged faces => classifier reports curved
    const outcome = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'difference')
    expect(outcome.ok).toBe(true)
    if (!outcome.ok) return
    expect(outcome.approximate).toBe(true)
    const geo = useCamStore.getState().project.geometry.find((g) => g.id === outcome.newId)
    expect(geo!.approximate).toBe(true)
    expect(geo!.booleanProvenance!.curvedFaceCount).toBeGreaterThanOrEqual(1)
    expect(geo!.booleanProvenance!.volumeMm3).toBeCloseTo(875, 0) // geometry identical, only label differs
  })

  it('refuses BY NAME when the model body has no tessellation, minting no row', async () => {
    seed({ ...boxDisplay(5), positions: [], indices: [] })
    const before = useCamStore.getState().project.geometry.length
    const outcome = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'difference')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/no tessellated geometry yet/)
    expect(useCamStore.getState().brepImportError).toMatch(/no tessellated geometry yet/)
    expect(useCamStore.getState().project.geometry.length).toBe(before) // no row minted
    expect(useCamStore.getState().consoleEvents.some((e) => e.severity === 'error')).toBe(true)
  })

  it('refuses when the first operand is a model body, not an imported mesh', async () => {
    seed(boxDisplay(5))
    const outcome = await useCamStore.getState().booleanMeshVsModelBody('model1', 'model1', 'difference')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/is a Model body, not an imported mesh/)
  })

  it('refuses an empty result (disjoint intersect), minting no row', async () => {
    useCamStore.getState().newProject()
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [meshRow('mesh1', 'cube'), modelRow('model1', 'Block', boxDisplay(5))],
        modelItemPlacements: [{ modelItemId: 'legacy', position: { x: 100, y: 100, z: 100 }, rotation: { x: 0, y: 0, z: 0 } }],
      },
    }))
    const before = useCamStore.getState().project.geometry.length
    const outcome = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'intersect')
    expect(outcome.ok).toBe(false)
    if (outcome.ok) return
    expect(outcome.error).toMatch(/empty result/)
    expect(useCamStore.getState().project.geometry.length).toBe(before)
  })

  it('Edit re-run replaces the result row IN PLACE (same id, same count)', async () => {
    seed(boxDisplay(5))
    const first = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'difference')
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const countAfterFirst = useCamStore.getState().project.geometry.length
    const rerun = await useCamStore.getState().booleanMeshVsModelBody('mesh1', 'model1', 'union', first.newId)
    expect(rerun.ok).toBe(true)
    if (!rerun.ok) return
    expect(rerun.newId).toBe(first.newId) // same id
    expect(useCamStore.getState().project.geometry.length).toBe(countAfterFirst) // replaced, not appended
    const geo = useCamStore.getState().project.geometry.find((g) => g.id === first.newId)
    expect(geo!.booleanProvenance!.op).toBe('union')
    expect(geo!.name).toBe('cube (union)')
  })
})
