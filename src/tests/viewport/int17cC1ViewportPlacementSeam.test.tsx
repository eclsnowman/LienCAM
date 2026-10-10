// @vitest-environment jsdom
//
// INT-17C Stage C1 step 3a (preflight extraction-order step 3a): the CAM
// viewport draw path (Viewport.tsx:1098) now resolves a model row's world
// pose through resolveModelItemPlacement instead of reading
// geo.position/geo.rotation directly. This is the "byte-identical render;
// regression-tested" gate the preflight names - it mounts the REAL <Viewport/>
// component (CNCViewport itself is mocked; jsdom has no WebGL) and asserts
// addModelBody receives EXACTLY the stored position/rotation, including a
// non-identity value, proving the new seam is a faithful pass-through and not
// a silently-substituted identity constant.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, waitFor } from '@testing-library/react'
import type { ImportedGeometry, ModelBodyDisplay } from '../../types'
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

type AddModelBodyCall = [string, ModelBodyDisplay, string, unknown, unknown, string | undefined]
let addModelBodyCalls: AddModelBodyCall[] = []

vi.mock('../../lib/viewport/CNCViewport', () => {
  const METHODS = [
    'add2DGeometry', 'addSTL', 'applyNavPreset', 'clearCarvedStock',
    'clearPartLoopsOnFacePlane', 'clearScene', 'dispose', 'enterSketchView',
    'exitSketchView', 'markCameraUserPositioned',
    'partPointToScreen', 'rebuildStock', 'renderToolpath', 'restoreCameraState',
    'restoreSelectedPartAfterSceneRestore', 'resumeRender', 'saveCameraState',
    'setAxesVisible', 'setBrepPickMode', 'setMoveSelectCallback',
    'setCameraChangeHandler', 'setGridSpacing', 'setGridVisible',
    'setHiddenToolpathRoles', 'setMachineTravel', 'setMachineVisible',
    'setPartProjectedLoops', 'setPartTransform', 'setSectionView',
    'setSeedOutlineVisible', 'setSelectedPart', 'setSetupSupportPlane', 'setShadingMode', 'setSketchDocumentPort',
    'setSketchEditingLayer', 'setSketchMenuPort', 'setSketchOverlayHost',
    'setSketchUndoSink', 'setStockVisible', 'setToolpathVisible', 'setWCSOrigin',
    'setWorkpieceVisible', 'showCarvedStock', 'suspendRender', 'removeSTL',
    'updateHeightPlanes', 'updateSketch', 'setSTLVisible',
  ]

  class CNCViewport {
    constructor() {
      for (const method of METHODS) {
        ;(this as Record<string, unknown>)[method] = vi.fn()
      }
    }
    addModelBody(...args: AddModelBodyCall) {
      addModelBodyCalls.push(args)
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
const { LEGACY_MODEL_ITEM_ID } = await import('../../doc/documentHolder')

function display(): ModelBodyDisplay {
  return {
    positions: [0, 0, 0, 1, 0, 0, 1, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    edgePositions: [0, 0, 0, 1, 0, 0],
    edgeOffsets: [0, 2],
    bbox: { min: [0, 0, 0], max: [1, 1, 0] },
  }
}

/** A model-backed row carrying a NON-identity pose. Stage C1 ships no UI that
 *  writes one (every real row is identity today per the preflight), but the
 *  seam itself must not special-case identity - see modelItemPlacement.test.ts. */
function modelGeo(id: string, position: { x: number; y: number; z: number }): ImportedGeometry {
  return {
    id, name: 'Bracket', filename: '', type: 'brep', format: 'model',
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 1, y: 1, z: 0 }, size: { x: 1, y: 1, z: 0 }, center: { x: 0.5, y: 0.5, z: 0 } },
    position, rotation: { x: 0, y: 0, z: 15 }, loaded: true,
    modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 }, display: display() },
  } as ImportedGeometry
}

beforeEach(() => {
  addModelBodyCalls = []
  act(() => { useCamStore.getState().newProject() })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('INT-17C Stage C1 step 3a / Stage C2: Viewport draw path resolves pose through resolveModelItemPlacement, fed from the REAL Project.modelItemPlacements registry', () => {
  it('an identity-pose model row draws with identity pose (byte-identical to the pre-seam read)', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [modelGeo('modelbody:b1', { x: 0, y: 0, z: 0 })],
          // Stage C2: the lookup's source is the persisted registry, not the
          // row's own position/rotation -- seed the matching record here.
          modelItemPlacements: [{
            modelItemId: LEGACY_MODEL_ITEM_ID, bodyId: 'b1',
            position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 15 },
          }],
        },
      } as never))
    })
    render(<Viewport />)

    // The draw effect may run more than once across commits (an existing,
    // unrelated Viewport.tsx re-render characteristic, not something this
    // step changes) - every call for this row must agree on the SAME pose,
    // which is what this gate actually needs to prove.
    expect(addModelBodyCalls.length).toBeGreaterThanOrEqual(1)
    for (const [id, , , position, rotation] of addModelBodyCalls) {
      expect(id).toBe('modelbody:b1')
      expect(position).toEqual({ x: 0, y: 0, z: 0 })
      expect(rotation).toEqual({ x: 0, y: 0, z: 15 })
    }
  })

  it('a non-identity-pose model row draws with that EXACT pose - the seam is a real read, not a hardcoded identity stub', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [modelGeo('modelbody:b1', { x: 12, y: -4, z: 0.5 })],
          modelItemPlacements: [{
            modelItemId: LEGACY_MODEL_ITEM_ID, bodyId: 'b1',
            position: { x: 12, y: -4, z: 0.5 }, rotation: { x: 0, y: 0, z: 15 },
          }],
        },
      } as never))
    })
    render(<Viewport />)

    expect(addModelBodyCalls.length).toBeGreaterThanOrEqual(1)
    for (const [, , , position] of addModelBodyCalls) {
      expect(position).toEqual({ x: 12, y: -4, z: 0.5 })
    }
  })

  it('a model row with NO Placement record is refused loud (invariant 4) and does not crash the draw of other bodies', () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [
            modelGeo('modelbody:b1', { x: 0, y: 0, z: 0 }),
            { ...modelGeo('modelbody:b2', { x: 0, y: 0, z: 0 }), modelBody: { ref: { bodyId: 'b2', stableIds: ['b2:F0'], version: 1 }, display: display() } },
          ],
          // Only b1 has a resolvable Placement; b2 has none.
          modelItemPlacements: [{
            modelItemId: LEGACY_MODEL_ITEM_ID, bodyId: 'b1',
            position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 15 },
          }],
        },
      } as never))
    })
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    render(<Viewport />)

    expect(addModelBodyCalls.some(([id]) => id === 'modelbody:b1')).toBe(true)
    expect(addModelBodyCalls.some(([id]) => id === 'modelbody:b2')).toBe(false)
    expect(errorSpy).toHaveBeenCalled()
    errorSpy.mockRestore()
  })

  it('rebuilds a retained CAM body when its authoritative color changes or clears while the viewport stays mounted', async () => {
    act(() => {
      useCamStore.setState((s) => ({
        project: {
          ...s.project,
          geometry: [{
            ...modelGeo('modelbody:b1', { x: 0, y: 0, z: 0 }),
            color: '#112233',
          }],
          modelItemPlacements: [{
            modelItemId: LEGACY_MODEL_ITEM_ID, bodyId: 'b1',
            position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 15 },
          }],
        },
      } as never))
    })
    render(<Viewport />)

    await waitFor(() => {
      expect(addModelBodyCalls.some(([, , , , , color]) => color === '#112233')).toBe(true)
    })

    const callsBeforeSet = addModelBodyCalls.length
    act(() => {
      useCamStore.getState().updateGeometryColor('modelbody:b1', '#ff8800')
    })
    await waitFor(() => {
      expect(addModelBodyCalls.slice(callsBeforeSet).some(([, , , , , color]) => color === '#ff8800')).toBe(true)
    })

    const callsBeforeClear = addModelBodyCalls.length
    act(() => {
      useCamStore.getState().updateGeometryColor('modelbody:b1', undefined)
    })
    await waitFor(() => {
      expect(addModelBodyCalls.slice(callsBeforeClear).some(([, , , , , color]) => color === undefined)).toBe(true)
    })
  })
})
