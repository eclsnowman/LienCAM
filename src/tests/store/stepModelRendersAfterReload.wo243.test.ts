// @vitest-environment jsdom

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import { createElement, Fragment } from 'react'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import type { ImportedGeometry } from '../../types'
import type { CNCViewport as RealCNCViewport } from '../../lib/viewport/CNCViewport'
import type { CachedStepDisplay, StepDisplayTessellation } from '../../lib/stepCache'
import { typedMock } from '../support/typedMock'

const mem = new Map<string, string>()
const memStorage: Storage = {
  get length() { return mem.size },
  clear: () => mem.clear(),
  getItem: (key) => mem.get(key) ?? null,
  key: (index) => Array.from(mem.keys())[index] ?? null,
  removeItem: (key) => { mem.delete(key) },
  setItem: (key, value) => { mem.set(key, String(value)) },
}
Object.defineProperty(globalThis, 'localStorage', { value: memStorage, configurable: true })

const cache = vi.hoisted(() => ({
  raw: new Map<string, ArrayBuffer>(),
  displays: new Map<string, CachedStepDisplay>(),
  sha256: 'ab'.repeat(32),
}))

vi.mock('../../lib/stepCache', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../lib/stepCache')>()
  return typedMock<typeof import('../../lib/stepCache')>({
    ...actual,
    computeStepSha256: vi.fn(async () => cache.sha256),
    cacheStep: vi.fn(async (id: string, bytes: ArrayBuffer) => {
      cache.raw.set(id, bytes)
      cache.displays.delete(id)
    }),
    loadCachedStep: vi.fn(async (id: string) => cache.raw.get(id) ?? null),
    cacheStepDisplay: vi.fn(async (
      id: string,
      model: BrepModelPayload,
      sourceSha256: string,
      tessellation: StepDisplayTessellation | null,
    ) => {
      cache.displays.set(id, {
        payload: model, sourceSha256, tessellation, displayContractVersion: 1,
        byteLength: 0, updatedAt: 0,
      })
    }),
    loadCachedStepDisplay: vi.fn(async (id: string) => cache.displays.get(id) ?? null),
  })
})

type AddBrepModelCall = [string, BrepModelPayload, string, unknown, unknown, string | undefined]
let addBrepModelCalls: AddBrepModelCall[] = []

vi.mock('../../lib/viewport/CNCViewport', () => {
  const METHODS = [
    'add2DGeometry', 'addModelBody', 'addSTL', 'applyNavPreset', 'clearCarvedStock',
    'clearPartLoopsOnFacePlane', 'clearScene', 'dispose', 'enterSketchView',
    'exitSketchView', 'markCameraUserPositioned', 'partPointToScreen', 'rebuildStock',
    'removeSTL', 'renderToolpath', 'restoreCameraState',
    'restoreSelectedPartAfterSceneRestore', 'resumeRender', 'saveCameraState',
    'setAxesVisible', 'setBrepPickMode', 'setCameraChangeHandler', 'setGridSpacing',
    'setGridVisible', 'setHiddenToolpathRoles', 'setMachineTravel', 'setMachineVisible',
    'setMoveSelectCallback', 'setPartProjectedLoops', 'setPartTransform',
    'setSectionView', 'setSeedOutlineVisible', 'setSelectedPart', 'setShadingMode',
    'setSetupSupportPlane', 'setSketchDocumentPort', 'setSketchEditingLayer', 'setSketchMenuPort',
    'setSketchOverlayHost', 'setSketchUndoSink', 'setStockVisible', 'setSTLVisible',
    'setToolpathVisible', 'setWCSOrigin', 'setWorkpieceVisible', 'showCarvedStock',
    'suspendRender', 'updateHeightPlanes', 'updateSketch',
  ] as const

  // eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- deliberate: the stub class takes its method types from the real viewport
  interface CNCViewport extends Pick<RealCNCViewport, typeof METHODS[number]> {}
  // eslint-disable-next-line @typescript-eslint/no-unsafe-declaration-merging -- deliberate: the stub class takes its method types from the real viewport
  class CNCViewport {
    constructor() {
      for (const method of METHODS) {
        ;(this as Record<string, unknown>)[method] = vi.fn()
      }
    }
    addBrepModel(...args: AddBrepModelCall) {
      addBrepModelCalls.push(args)
    }
  }

  // WO-1052 FINDING: CNCViewport's private static members are nominally
  // untypeable from outside its own declaration (see
  // owningStockViewportPick.ui64.test.tsx). Left untyped.
  return { CNCViewport }
})

vi.mock('../../components/viewport/ViewCube', () => typedMock<typeof import('../../components/viewport/ViewCube')>({
  ViewCube: () => createElement(Fragment),
}))

const { Viewport } = await import('../../components/viewport/Viewport')
const {
  persistMerge,
  persistPartialize,
  useCamStore,
} = await import('../../store')
const {
  arrayBufferToBase64,
  encodeBrepModelPayload,
  hydrateCachesFromBinaries,
} = await import('../../lib/projectBinaries')

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

function stepGeometry(): ImportedGeometry {
  return {
    id: 'wo243-step',
    name: 'Reloaded STEP',
    filename: 'reloaded.step',
    type: 'brep',
    format: 'step',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 },
      size: { x: 1, y: 1, z: 0 }, center: { x: 0.5, y: 0.5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    hidden: false,
  }
}

afterEach(() => {
  cleanup()
  cache.raw.clear()
  cache.displays.clear()
  addBrepModelCalls = []
  mem.clear()
  vi.restoreAllMocks()
})

describe('WO-243 Viewport startup restore waits for durable project hydration', () => {
  it('draws the persisted loaded:true STEP only after the real Viewport receives onFinishHydration', async () => {
    const bytes = new TextEncoder().encode('ISO-10303-21; WO-243').buffer
    const stepDisplay = encodeBrepModelPayload(payload(), cache.sha256, null)
    expect(stepDisplay).not.toBeNull()
    await hydrateCachesFromBinaries({
      'wo243-step': { step: arrayBufferToBase64(bytes), stepDisplay: stepDisplay! },
    })

    act(() => { useCamStore.getState().newProject() })
    const baseline = useCamStore.getState()
    const fileProject = {
      ...structuredClone(baseline.project),
      id: 'wo243-project',
      geometry: [stepGeometry()],
      setups: [],
    }
    act(() => { useCamStore.setState({ project: fileProject }) })
    const persisted = persistPartialize(useCamStore.getState())
    const reloaded = persistMerge(persisted, baseline)
    act(() => { useCamStore.getState().newProject() })

    let finishHydration: ((state: ReturnType<typeof useCamStore.getState>) => void) | undefined
    const unsubscribe = vi.fn()
    vi.spyOn(useCamStore.persist, 'hasHydrated').mockReturnValue(false)
    vi.spyOn(useCamStore.persist, 'onFinishHydration').mockImplementation((listener) => {
      finishHydration = listener
      return unsubscribe
    })

    render(createElement(Viewport))
    expect(addBrepModelCalls).toEqual([])

    act(() => { useCamStore.setState(reloaded) })
    expect(addBrepModelCalls).toEqual([])

    act(() => { finishHydration?.(useCamStore.getState()) })
    await waitFor(() => expect(addBrepModelCalls).toHaveLength(1))
    expect(addBrepModelCalls[0][0]).toBe('wo243-step')
    expect(addBrepModelCalls[0][1].mesh.indices).toHaveLength(3)
    expect(useCamStore.getState().project.geometry[0]).toMatchObject({
      id: 'wo243-step', loaded: true, hidden: false, format: 'step',
    })

    cleanup()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })
})
