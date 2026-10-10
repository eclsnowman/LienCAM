// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import type { ImportedGeometry } from '../../types'
import type { CNCViewport as RealCNCViewport } from '../../lib/viewport/CNCViewport'
import { createFakeSceneRuntime } from '../model3d/fakeSceneRuntime'
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

type PartSelect = (id: string | null) => void
type StockSelect = (id: string | null, assignmentPartId?: string | null) => void
let partSelect: PartSelect | null = null
let stockSelect: StockSelect | null = null
let referenceHost: ReturnType<RealCNCViewport['referenceImageHost']> | undefined
let referenceReceiver: unknown = null
let cncInstance: unknown = null

vi.mock('../../lib/viewport/CNCViewport', () => {
  const METHODS = [
    'add2DGeometry', 'addModelBody', 'addSTL', 'applyNavPreset', 'clearCarvedStock',
    'clearPartLoopsOnFacePlane', 'clearScene', 'dispose', 'enterSketchView',
    'exitSketchView', 'markCameraUserPositioned',
    'partPointToScreen', 'rebuildStock', 'renderToolpath', 'restoreCameraState',
    'restoreSelectedPartAfterSceneRestore', 'resumeRender', 'saveCameraState',
    'setAxesVisible', 'setBrepPickMode', 'setMoveSelectCallback',
    'setCameraChangeHandler', 'setGridSpacing', 'setGridVisible',
    'setHiddenToolpathRoles', 'setMachineTravel', 'setMachineVisible',
    'setPartProjectedLoops', 'setPartTransform', 'setSectionView',
    'setSeedOutlineVisible', 'setSelectedPart', 'setShadingMode', 'setSketchDocumentPort',
    'setSketchEditingLayer', 'setSketchMenuPort', 'setSketchOverlayHost',
    'setSetupSupportPlane', // WO-227 (8381d758): setup fixture support planes
    'setSketchUndoSink', 'setStockVisible', 'setToolpathVisible', 'setWCSOrigin',
    'setWorkpieceVisible', 'showCarvedStock', 'suspendRender', 'removeSTL',
    'updateHeightPlanes', 'updateSketch',
  ]

  class CNCViewport {
    constructor(
      _container: HTMLElement,
      _onFaceSelect: unknown,
      _onPartTransform: unknown,
      onPartSelect: PartSelect,
      onStockSelect: StockSelect,
    ) {
      partSelect = onPartSelect
      stockSelect = onStockSelect
      cncInstance = this
      if (referenceHost) {
        Object.defineProperty(this, 'referenceImageHost', {
          value: function (this: unknown) { referenceReceiver = this; return referenceHost },
        })
      }
      for (const method of METHODS) {
        ;(this as Record<string, unknown>)[method] = vi.fn()
      }
    }
  }

  return { CNCViewport }
})

// FINDING (WO-1052): the CNCViewport mock above cannot be wrapped in
// typedMock. The real CNCViewport class (src/lib/viewport/CNCViewport.ts)
// declares many `private`/`private static` members (e.g. the static
// MOVE_PICK_TOLERANCE_PX), and TypeScript's private-member nominal typing
// means no class outside that declaration - however many public methods it
// stubs - can ever be assignable to `typeof CNCViewport`; tsc reports the
// missing privates as soon as any are absent, before it even reaches the
// public members this mock exists to stub. Extending the real class instead
// would run its real constructor (a real THREE.WebGLRenderer/OrbitControls
// setup requiring a live container and GL context), which is exactly what
// this mock exists to avoid in jsdom. Left untyped; see mockContractBaseline.ts.
vi.mock('../../components/viewport/ViewCube', () => typedMock<typeof import('../../components/viewport/ViewCube')>({ ViewCube: () => <></> }))

const { Viewport } = await import('../../components/viewport/Viewport')
const { useCamStore } = await import('../../store')
const { referenceImage2dUi } = await import('../../components/panels/sketch/ReferenceImage2d')

function part(id: string): ImportedGeometry {
  return {
    id,
    name: 'Part',
    filename: 'part.dxf',
    type: 'curves_2d',
    format: 'dxf',
    loaded: true,
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 10, y: 10, z: 0 },
      size: { x: 10, y: 10, z: 0 },
      center: { x: 5, y: 5, z: 0 },
    },
    loops: [{
      id: 'loop-1',
      points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
      closed: true,
      type: 'contour',
      layerId: 'L1',
      area: 100,
    }],
    layers2d: [{ id: 'L1', name: 'Layer', color: '#00e5ff', visible: true }],
  } as ImportedGeometry
}

beforeEach(() => {
  partSelect = null
  stockSelect = null
  referenceHost = undefined
  referenceReceiver = null
  cncInstance = null
  act(() => {
    useCamStore.getState().newProject()
    useCamStore.getState().addFixedStock({
      id: 'stock-target',
      name: 'Target block',
      width: 50,
      height: 50,
      depth: 10,
      position: { x: 100, y: 0, z: 0 },
    })
    useCamStore.getState().addGeometry(part('part-1'))
    useCamStore.getState().setSelectedGeometry('part-1')
  })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('UI-64 owning-stock viewport assignment', () => {
  it('assigns the selected part, then preserves ordinary tri-exclusive stock selection', () => {
    render(<Viewport />)
    expect(partSelect).not.toBeNull()
    expect(stockSelect).not.toBeNull()
    // A host without the optional image capability still mounts and selects.
    expect(referenceImage2dUi.getState().host).toBeNull()

    // Exact CNCViewport stock-click order: clear its part selection first,
    // then deliver the stock hit with the part that was selected at click time.
    act(() => {
      partSelect!(null)
      stockSelect!('stock-target', 'part-1')
    })

    const state = useCamStore.getState()
    const assigned = state.project.geometry.find((geo) => geo.id === 'part-1')
    expect(assigned?.stockId).toBe('stock-target')
    expect(assigned?.stockIdLocked).toBe(true)
    expect(state.viewer.selectedGeometryId).toBeNull()
    expect(state.viewer.selectedNestId).toBeNull()
    expect(state.viewer.selectedStockId).toBe('stock-target')
  })

  it('publishes an available reference-image host with its receiver and clears it on unmount', () => {
    referenceHost = { runtime: createFakeSceneRuntime(), canvas: document.createElement('canvas') }
    const { unmount } = render(<Viewport />)
    expect(referenceReceiver).toBe(cncInstance)
    expect(referenceImage2dUi.getState().host).toBe(referenceHost)
    expect(stockSelect).not.toBeNull()
    unmount()
    expect(referenceImage2dUi.getState().host).toBeNull()
  })
})
