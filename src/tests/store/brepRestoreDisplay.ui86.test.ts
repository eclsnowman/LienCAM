import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ImportedGeometry } from '../../types'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import type { CachedStepDisplay } from '../../lib/stepCache'
import { typedMock } from '../support/typedMock'

const SOURCE_SHA256 = '12'.repeat(32)

const seams = vi.hoisted(() => ({
  display: null as CachedStepDisplay | null,
  raw: new ArrayBuffer(16) as ArrayBuffer | null,
  loadDisplay: vi.fn(),
  loadRaw: vi.fn(),
  cacheDisplay: vi.fn(),
  readStep: vi.fn(),
  setPayload: vi.fn(),
}))

vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  STEP_DISPLAY_CONTRACT_VERSION: 1,
  computeStepSha256: vi.fn(async () => SOURCE_SHA256),
  loadCachedStepDisplay: vi.fn(async (id: string) => {
    seams.loadDisplay(id)
    return seams.display
  }),
  loadCachedStep: vi.fn(async (id: string) => {
    seams.loadRaw(id)
    return seams.raw
  }),
  cacheStepDisplay: vi.fn(async (
    id: string, payload: BrepModelPayload, sourceSha256: string, tessellation: unknown,
  ) => {
    seams.cacheDisplay(id, payload, sourceSha256, tessellation)
  }),
}))
vi.mock('../../lib/cam/geometry/occt/model/modelClient', () => typedMock<typeof import('../../lib/cam/geometry/occt/model/modelClient')>({
  readStep: vi.fn(async () => seams.readStep()),
  setBrepPayload: vi.fn((...args: unknown[]) => seams.setPayload(...args)),
  getBrepPayload: vi.fn(),
}))
vi.mock('../../lib/cam/geometry/occt/model/quality', () => typedMock<typeof import('../../lib/cam/geometry/occt/model/quality')>({
  deflectionForQuality: () => ({ linearDeflection: 0.1, angularDeflection: 0.2 }),
  DEFAULT_BREP_QUALITY: 'balanced',
}))
vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  loadCachedSTL: vi.fn(async () => null),
}))
vi.mock('../../lib/geometry2dCache', () => typedMock<typeof import('../../lib/geometry2dCache')>({
  load2DGeometry: vi.fn(async () => null),
}))
vi.mock('../../lib/modelBodyDisplayCache', () => typedMock<typeof import('../../lib/modelBodyDisplayCache')>({
  loadCachedModelBodyDisplay: vi.fn(async () => null),
}))
// FINDING (left untouched, still untyped): the real `useCamStore` export is a
// zustand `UseBoundStore<StoreApi<CamStore>>` - a CALLABLE hook with attached
// getState/setState/subscribe/persist statics. This factory returns a plain
// object literal ({ getState: () => ({...}) }), which has no call signature at
// all, so it cannot be assigned to Partial<typeof import('../../store')> no
// matter how the `getState` return shape is adjusted - the mismatch is on the
// export's own top-level type (function vs. object), not on a property inside
// it, so genuinely typing the module without constructing a real zustand store
// is not possible here.
vi.mock('../../store', () => ({
  useCamStore: {
    getState: () => ({
      appSettings: { brepTessellationQuality: 'balanced' },
      project: { modelItemPlacements: [] },
    }),
  },
}))

import { restoreGeometryToViewport, type RestoreViewport } from '../../lib/viewport/restoreScene'

function payload(): BrepModelPayload {
  return {
    faceCount: 1,
    edgeCount: 1,
    solidCount: 1,
    bbox: { min: [0, 0, 0], max: [1, 1, 0] },
    mesh: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      faceRanges: new Uint32Array([0, 3]),
    },
    edges: {
      positions: new Float32Array([0, 0, 0, 1, 0, 0]),
      edgeRanges: new Uint32Array([0, 2]),
    },
    faceTypes: new Uint8Array([0]),
  }
}

function geometry(extra: Partial<ImportedGeometry> = {}): ImportedGeometry {
  return {
    id: 'step-1',
    name: 'Bracket',
    filename: 'Bracket.step',
    type: 'brep',
    format: 'step',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 }, center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position: { x: 4, y: 5, z: 6 },
    rotation: { x: 0.1, y: 0.2, z: 0.3 },
    color: '#123456',
    loaded: true,
    ...extra,
  } as ImportedGeometry
}

function viewport(onAdd?: (id: string, payload: BrepModelPayload) => void) {
  const addBrepModel = vi.fn(onAdd)
  const setSTLVisible = vi.fn()
  const vp: RestoreViewport = {
    addBrepModel,
    setSTLVisible,
    addSTL: vi.fn(async () => ({
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 1 },
    })),
    setPartLoopsOnFacePlane: vi.fn(),
    setPartProjectedLoops: vi.fn(),
    addModelBody: vi.fn(),
    add2DGeometry: vi.fn(),
  }
  return { vp, addBrepModel, setSTLVisible }
}

const hooks = () => ({ patchGeometry: vi.fn(), setBrepImportError: vi.fn() })

beforeEach(() => {
  seams.display = null
  seams.raw = new ArrayBuffer(16)
  seams.loadDisplay.mockReset()
  seams.loadRaw.mockReset()
  seams.cacheDisplay.mockReset()
  seams.readStep.mockReset()
  seams.setPayload.mockReset()
  seams.readStep.mockReturnValue(payload())
})

describe('UI-86 fast STEP scene restore', () => {
  it('draws a valid cached display with selection arrays and never calls readStep', async () => {
    const cached = payload()
    seams.display = {
      displayContractVersion: 1,
      sourceSha256: SOURCE_SHA256,
      tessellation: { linearDeflection: 0.1, angularDeflection: 0.2 },
      payload: cached,
      byteLength: 0,
      updatedAt: 0,
    }
    const { vp, addBrepModel, setSTLVisible } = viewport()
    const geo = geometry({ hidden: true })

    await restoreGeometryToViewport(vp, [geo], hooks())

    expect(seams.loadRaw).toHaveBeenCalledWith('step-1') // digest identity check only
    expect(seams.readStep).not.toHaveBeenCalled()
    expect(seams.setPayload).toHaveBeenCalledWith('step-1', cached, {
      displayContractVersion: 1,
      sourceSha256: SOURCE_SHA256,
      tessellation: { linearDeflection: 0.1, angularDeflection: 0.2 },
    })
    expect(addBrepModel).toHaveBeenCalledWith(
      'step-1', cached, 'Bracket', geo.position, geo.rotation, '#123456',
    )
    expect(setSTLVisible).toHaveBeenCalledWith('step-1', false)
    expect(cached.mesh.faceRanges).toEqual(new Uint32Array([0, 3]))
    expect(cached.edges.edgeRanges).toEqual(new Uint32Array([0, 2]))
  })

  it('falls back to readStep when display is absent and seeds the durable display', async () => {
    const parsed = payload()
    seams.readStep.mockReturnValue(parsed)
    const { vp, addBrepModel } = viewport((_id, displayed) => {
      // CNCViewport.addBrepModel performs the legacy AO bake synchronously and
      // attaches it to this same payload before restore persists the display.
      displayed.mesh.ao = new Float32Array([1, 0.8, 0.6])
    })

    await restoreGeometryToViewport(vp, [geometry()], hooks())

    expect(seams.loadRaw).toHaveBeenCalledWith('step-1')
    expect(seams.readStep).toHaveBeenCalledTimes(1)
    expect(seams.setPayload).toHaveBeenCalledWith('step-1', parsed)
    expect(seams.cacheDisplay).toHaveBeenCalledWith(
      'step-1', parsed, SOURCE_SHA256,
      { linearDeflection: 0.1, angularDeflection: 0.2 },
    )
    expect(parsed.mesh.ao).toEqual(new Float32Array([1, 0.8, 0.6]))
    expect(addBrepModel).toHaveBeenCalledWith(
      'step-1', parsed, 'Bracket',
      { x: 4, y: 5, z: 6 }, { x: 0.1, y: 0.2, z: 0.3 }, '#123456',
    )
  })

  it('upgrades an old cached display after its one AO bake without parsing STEP', async () => {
    const cached = payload()
    seams.display = {
      displayContractVersion: 1,
      sourceSha256: SOURCE_SHA256,
      tessellation: null,
      payload: cached,
      byteLength: 0,
      updatedAt: 0,
    }
    const { vp } = viewport((_id, displayed) => {
      displayed.mesh.ao = new Float32Array([1, 0.8, 0.6])
    })

    await restoreGeometryToViewport(vp, [geometry()], hooks())

    expect(seams.readStep).not.toHaveBeenCalled()
    expect(seams.cacheDisplay).toHaveBeenCalledWith(
      'step-1', cached, SOURCE_SHA256, null,
    )
    expect(cached.mesh.ao).toEqual(new Float32Array([1, 0.8, 0.6]))
  })

  it('treats a corrupt durable payload as a cache miss', async () => {
    seams.display = {
      displayContractVersion: 1,
      sourceSha256: SOURCE_SHA256,
      tessellation: null,
      payload: { ...payload(), faceCount: 2 },
      byteLength: 0,
      updatedAt: 0,
    }
    const { vp } = viewport()

    await restoreGeometryToViewport(vp, [geometry()], hooks())

    expect(seams.readStep).toHaveBeenCalledTimes(1)
    expect(seams.cacheDisplay).toHaveBeenCalledTimes(1)
  })

  it('drops a superseded open after async cache checks and before scene mutation', async () => {
    seams.display = {
      displayContractVersion: 1,
      sourceSha256: SOURCE_SHA256,
      tessellation: null,
      payload: payload(),
      byteLength: 0,
      updatedAt: 0,
    }
    let checks = 0
    const isCurrent = () => ++checks < 3
    const { vp, addBrepModel } = viewport()

    await restoreGeometryToViewport(
      vp, [geometry()], hooks(), [], new Set(), undefined, isCurrent,
    )

    expect(addBrepModel).not.toHaveBeenCalled()
    expect(seams.setPayload).not.toHaveBeenCalled()
    expect(seams.readStep).not.toHaveBeenCalled()
  })
})
