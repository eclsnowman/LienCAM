// @vitest-environment jsdom
//
// WO-1427: what Edit Setup says about an origin's source.
//
// 1. A vertex pick captures no sketch-entity identity, so editing the driving
//    dimension that moves that corner cannot move the origin. Driven through
//    the REAL sketch path (openSketchForLayer -> commitDimensionValue -> real
//    planegcs solve via an in-process worker -> finishSketch): the origin stays
//    at its picked coordinate and is disclosed as a fixed point, not Tracking.
// 2. A bore/vertex origin whose source is gone renders "Not tracking", never
//    "Tracking: <raw uuid>".

import { createElement } from 'react'
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type { Sketch, SketchEntity, PointRef } from '../../lib/sketch/types'
import type { SketchWorkerRequestMsg, SketchWorkerResponseMsg } from '../../lib/sketch/solver/protocol'
import type { GcsWrapper } from '@salusoft89/planegcs'
import type { ImportedGeometry, Setup, WCS } from '../../types'

let wrapperPromise: Promise<GcsWrapper> | null = null
class LoopbackWorker {
  onmessage: ((e: { data: SketchWorkerResponseMsg }) => void) | null = null
  onerror: ((e: unknown) => void) | null = null
  postMessage(msg: SketchWorkerRequestMsg): void {
    void (async () => {
      wrapperPromise ??= createGcsWrapper()
      const wrapper = await wrapperPromise
      const { requestId, sketch } = msg.payload
      const out = msg.type === 'DRAG_SOLVE'
        ? solveSketchOnWrapper(wrapper, sketch, msg.payload.drag)
        : solveSketchOnWrapper(wrapper, sketch)
      const data: SketchWorkerResponseMsg = out.ok
        ? { type: 'SKETCH_SOLVE_COMPLETE', requestId, entities: out.entities, status: out.status, computeTimeMs: 0 }
        : { type: 'SKETCH_SOLVE_FAILED', requestId, reason: out.reason, message: out.message, status: out.status }
      this.onmessage?.({ data })
    })()
  }
  terminate(): void {}
}
vi.stubGlobal('Worker', LoopbackWorker)

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

let useCamStore: typeof import('../../store').useCamStore
let describeOriginSource: typeof import('../../store').describeOriginSource
let SetupModal: typeof import('../../components/modals/SetupModal').SetupModal

beforeAll(async () => {
  ;({ useCamStore, describeOriginSource } = await import('../../store'))
  ;({ SetupModal } = await import('../../components/modals/SetupModal'))
})

async function waitUntil(pred: () => boolean, what: string, ms = 10000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

const BBOX = {
  min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 30, z: 0 },
  size: { x: 40, y: 30, z: 0 }, center: { x: 20, y: 15, z: 0 },
}

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}

/** Fully defined 40 x 30 rectangle; `dw` drives the bottom edge's length, so
 *  editing it moves the right-hand corners. */
function rectSketch(): Sketch {
  return {
    id: 'sk', layerId: 'layer-sk', ownerGeometryId: 'geo-sk', solveStatus: null,
    entities: [line('l1', 0, 0, 40, 0), line('l2', 40, 0, 40, 30), line('l3', 40, 30, 0, 30), line('l4', 0, 30, 0, 0)],
    constraints: [
      { id: 'c12', kind: 'coincident', a: ref('l1', 'end'), b: ref('l2', 'start') },
      { id: 'c23', kind: 'coincident', a: ref('l2', 'end'), b: ref('l3', 'start') },
      { id: 'c34', kind: 'coincident', a: ref('l3', 'end'), b: ref('l4', 'start') },
      { id: 'c41', kind: 'coincident', a: ref('l4', 'end'), b: ref('l1', 'start') },
      { id: 'h1', kind: 'horizontal', line: 'l1' },
      { id: 'h3', kind: 'horizontal', line: 'l3' },
      { id: 'v2', kind: 'vertical', line: 'l2' },
      { id: 'v4', kind: 'vertical', line: 'l4' },
      { id: 'fx', kind: 'fix', point: ref('l1', 'start') },
    ],
    dimensions: [
      { id: 'dw', kind: 'distance', driving: true, value: 40, a: ref('l1', 'start'), b: ref('l1', 'end') },
      { id: 'dh', kind: 'distance', driving: true, value: 30, a: ref('l2', 'start'), b: ref('l2', 'end') },
    ],
  }
}

function makeWcs(over: Partial<WCS>): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    ...over,
  }
}

function makeSetup(wcs: WCS): Setup {
  return {
    id: 'setup-1', name: 'Setup 1', wcs,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'wood' },
    operations: [], notes: '',
  }
}

function openEditSetup(): void {
  render(createElement(SetupModal)) // .ts file: no JSX
  act(() => {
    useCamStore.setState({ activeModal: 'edit-setup', editingSetupId: 'setup-1' })
  })
}

beforeEach(() => {
  ;(window as unknown as Record<string, unknown>).__cncViewport = {
    getStockBounds: () => null,
    setWCSOrigin: () => {},
    exitWCSGizmoMode: () => {},
    exitStockCornerPickMode: () => {},
    exitVertexPickMode: () => {},
    setBrepPickMode: () => {},
    setZeroPointChoices: () => {},
  }
  useCamStore.setState((s) => ({
    activeModal: null,
    editingSetupId: null,
    activeSketch: null,
    sketchSolveStatus: null,
    sketchSelectedIds: [],
    sketchNotice: null,
    sketchDimEditor: null,
    sketchHistory: [],
    projectHistory: [],
    viewer: { ...s.viewer, mode: 'setup' as const, selectedGeometryId: null },
    project: { ...s.project, geometry: [], setups: [], stocks: [], activeSetupId: 'setup-1' },
  }))
})

afterEach(() => {
  cleanup()
  delete (window as unknown as Record<string, unknown>).__cncViewport
})

describe('WO-1427: Edit Setup discloses what an origin can actually claim', () => {
  it('a picked sketch corner stays a disclosed fixed point when the driving dimension moves that corner', async () => {
    const part = {
      id: 'geo-sk', name: 'Sketch plate', filename: '', type: 'curves_2d', format: 'svg',
      loaded: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      boundingBox: BBOX,
      layers2d: [{ id: 'layer-sk', name: 'Sketch', color: '#fff', visible: true, sourceType: 'sketch' }],
      loops: [{
        id: 'loop-sk', layerId: 'layer-sk', closed: true, type: 'contour', area: 1200,
        points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 30 }, { x: 0, y: 30 }],
      }],
      sketches: [rectSketch()],
    } as unknown as ImportedGeometry
    const corner = { x: 40, y: 0, z: 0 }
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [part],
        setups: [makeSetup(makeWcs({
          origin: corner, snapGeoId: 'geo-sk', snapLocalPt: corner,
          originBinding: { kind: 'part_feature', geoId: 'geo-sk', featureRef: { kind: 'vertex', localPt: corner } },
        }))],
      },
    }))

    expect(useCamStore.getState().openSketchForLayer('layer-sk', 'geo-sk')).toBe(true)
    await waitUntil(() => useCamStore.getState().sketchSolveStatus !== null, 'open solve')
    useCamStore.getState().commitDimensionValue('dw', 60)
    await waitUntil(() => {
      const l1 = useCamStore.getState().activeSketch?.entities.find((e) => e.id === 'l1')
      return l1?.kind === 'line' && Math.abs(l1.end.x - 60) < 1e-6
    }, 'the dimension edit to move the corner')
    useCamStore.getState().finishSketch()

    const state = useCamStore.getState()
    const baked = state.project.geometry.find((g) => g.id === 'geo-sk')!
    const xs = (baked.loops ?? []).filter((l) => l.layerId === 'layer-sk').flatMap((l) => l.points.map((p) => p.x))
    expect(Math.max(...xs)).toBeCloseTo(60, 6) // the authored corner really moved

    const wcs = state.project.setups[0].wcs
    expect(wcs.origin).toEqual(corner) // today's coordinate is preserved...
    const binding = wcs.originBinding
    expect(binding?.kind).toBe('part_feature')
    if (binding?.kind !== 'part_feature') return
    expect(binding.featureRef).toEqual({ kind: 'vertex', localPt: corner })
    // ...and disclosed as a fixed point, not as tracking the moved corner.
    expect(describeOriginSource(state.project.geometry, binding.geoId, binding.featureRef.kind, binding.sourceUnresolved))
      .toEqual({ state: 'fixed_point', sourceName: 'Sketch plate' })

    openEditSetup()
    const label = screen.getByTestId('setup-snap-picked').textContent ?? ''
    expect(label).toMatch(/Fixed point on Sketch plate/)
    expect(label).not.toMatch(/Tracking/)
  })

  it('a bore origin whose body was deleted reads "Not tracking", never "Tracking: <uuid>"', () => {
    const geoId = 'modelbody:7f3c2a90-deleted'
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [],
        setups: [makeSetup(makeWcs({
          origin: { x: 15, y: 10, z: 17 }, snapGeoId: geoId, snapLocalPt: { x: 10, y: 12, z: 10 },
          originBinding: {
            kind: 'part_feature', geoId,
            sourceUnresolved: 'the part it was picked on is no longer in the project',
            featureRef: {
              kind: 'bore_center', geoId, bodyId: 'F1', modelItemId: 'legacy', faceStableId: 'F1:wall',
              localCenter: { x: 10, y: 12, z: 10 }, diameter: 8,
            },
          },
        }))],
      },
    }))

    openEditSetup()
    const label = screen.getByTestId('setup-bore-picked').textContent ?? ''
    expect(label).toMatch(/Not tracking: the part it was picked on is no longer in the project/)
    expect(label).not.toMatch(/Tracking:/)
    expect(label).not.toContain(geoId)
  })

  it('a live, re-checked bore origin still reads "Tracking: <part name>"', () => {
    const geoId = 'modelbody:F1'
    const plate = {
      id: geoId, name: 'Plate', filename: '', type: 'model', format: 'model', loaded: true,
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, boundingBox: BBOX,
      modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:wall'], version: 1 } },
    } as unknown as ImportedGeometry
    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [plate],
        setups: [makeSetup(makeWcs({
          origin: { x: 15, y: 10, z: 17 }, snapGeoId: geoId, snapLocalPt: { x: 10, y: 12, z: 10 },
          originBinding: {
            kind: 'part_feature', geoId,
            featureRef: {
              kind: 'bore_center', geoId, bodyId: 'F1', modelItemId: 'legacy', faceStableId: 'F1:wall',
              localCenter: { x: 10, y: 12, z: 10 }, diameter: 8,
            },
          },
        }))],
      },
    }))

    openEditSetup()
    expect(screen.getByTestId('setup-bore-picked').textContent).toMatch(/Tracking: Plate/)
  })
})
