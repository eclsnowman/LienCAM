// @vitest-environment jsdom
//
// WO-370: a model edit that advances the current body leaf may keep the CAM
// geometry row id and restart the leaf-local GeometryCache version at the same
// number. The store already contains the fresh display in that case. This test
// mounts the real CAM Viewport and proves it must repaint from that new display
// immediately, without relying on a page reload or a manual REGEN ALL.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createElement, Fragment } from 'react'
import type { ImportedGeometry, ModelBodyDisplay } from '../../types'
import type { CNCViewport as RealCNCViewport } from '../../lib/viewport/CNCViewport'
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

type AddModelBodyCall = [string, ModelBodyDisplay]
let addModelBodyCalls: AddModelBodyCall[] = []

vi.mock('../../lib/viewport/CNCViewport', () => {
  const METHODS = [
    'add2DGeometry', 'addSTL', 'applyNavPreset', 'clearCarvedStock',
    'clearPartLoopsOnFacePlane', 'clearScene', 'dispose', 'enterSketchView',
    'exitSketchView', 'markCameraUserPositioned', 'partPointToScreen',
    'rebuildStock', 'removeSTL', 'renderToolpath', 'restoreCameraState',
    'restoreSelectedPartAfterSceneRestore', 'resumeRender', 'saveCameraState',
    'setAxesVisible', 'setBrepPickMode', 'setCameraChangeHandler',
    'setGridSpacing', 'setGridVisible', 'setHiddenToolpathRoles',
    'setMachineTravel', 'setMachineVisible', 'setMoveSelectCallback',
    'setPartLoopsOnFacePlane', 'setPartProjectedLoops', 'setPartTransform',
    'setSectionView', 'setSeedOutlineVisible', 'setSelectedPart',
    'setSetupSupportPlane', 'setShadingMode', 'setSketchDocumentPort', 'setSketchEditingLayer',
    'setSketchMenuPort', 'setSketchOverlayHost', 'setSketchUndoSink',
    'setStockVisible', 'setSTLVisible', 'setToolpathVisible', 'setWCSOrigin',
    'setWorkpieceVisible', 'showCarvedStock', 'suspendRender',
    'updateHeightPlanes', 'updateSketch',
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
    addModelBody(id: string, display: ModelBodyDisplay) {
      addModelBodyCalls.push([id, display])
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
const { useCamStore } = await import('../../store')

function display(tag: number): ModelBodyDisplay {
  return {
    positions: [tag, 0, 0, tag + 1, 0, 0, tag + 1, 1, 0],
    normals: [0, 0, 1, 0, 0, 1, 0, 0, 1],
    indices: [0, 1, 2],
    edgePositions: [tag, 0, 0, tag + 1, 0, 0],
    edgeOffsets: [0, 2],
    bbox: { min: [tag, 0, 0], max: [tag + 1, 1, 0] },
  }
}

function modelGeo(bodyId: string, tag: number): ImportedGeometry {
  return {
    id: 'modelbody:item-a:F1',
    name: 'Extrude F1',
    filename: 'Extrude F1',
    type: 'model',
    format: 'model',
    boundingBox: {
      min: { x: tag, y: 0, z: 0 },
      max: { x: tag + 1, y: 1, z: 0 },
      size: { x: 1, y: 1, z: 0 },
      center: { x: tag + 0.5, y: 0.5, z: 0 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    modelItemId: 'item-a',
    modelBody: {
      ref: {
        bodyId,
        lineageId: 'F1',
        stableIds: [`${bodyId}:F0`],
        // Each new leaf has its own cache generation, so F3:v1 -> F4:v1 is a
        // valid edit even though the numeric version does not change.
        version: 1,
      },
      display: display(tag),
    },
  }
}

beforeEach(() => {
  addModelBodyCalls = []
  act(() => { useCamStore.getState().newProject() })
})

afterEach(() => {
  cleanup()
  vi.clearAllMocks()
})

describe('WO-370 stale Setup model body', () => {
  it('repaints a stable CAM row when Finish publishes a new body leaf at the same cache version', () => {
    act(() => {
      useCamStore.setState((state) => ({
        project: {
          ...state.project,
          geometry: [modelGeo('F3', 0)],
          modelItems: [{ id: 'item-a', name: 'Part', documentState: 'authored' }],
          modelItemPlacements: [{
            modelItemId: 'item-a',
            position: { x: 0, y: 0, z: 0 },
            rotation: { x: 0, y: 0, z: 0 },
          }],
        },
      } as never))
    })
    render(createElement(Viewport))

    expect(addModelBodyCalls.some(([, bodyDisplay]) => bodyDisplay.positions[0] === 0)).toBe(true)
    const callsBeforeEdit = addModelBodyCalls.length

    // This is the state immediately after the edit and Finish: the durable CAM
    // row is already authoritative and fresh (F4/tag 7), but its stable row id,
    // display-presence bit, and leaf-local version number all equal the prior
    // values. Setup must still observe and draw the changed body.
    act(() => {
      useCamStore.setState((state) => ({
        project: { ...state.project, geometry: [modelGeo('F4', 7)] },
      }))
    })

    expect(
      addModelBodyCalls.slice(callsBeforeEdit).some(([, bodyDisplay]) => bodyDisplay.positions[0] === 7),
    ).toBe(true)
  })
})
