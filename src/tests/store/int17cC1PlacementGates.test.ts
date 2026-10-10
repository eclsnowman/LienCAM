// INT-17C Stage C1 step 3b/3c/3d (preflight extraction-order step 3, GO/NO-GO
// findings 4 and 5): the origin gates and shared-predicate unification closed
// alongside the Placement seam's wiring. Each `it` below is a named, can-fail
// test - remove the guard it targets and the corresponding assertion goes RED.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { ImportedGeometry, ModelBodyDisplay, Project, Setup, Vec3 } from '../../types'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}),
  loadCachedSTL: vi.fn(async () => null),
  removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}),
  loadCachedStep: vi.fn(async () => null),
  removeCachedStep: vi.fn(async () => {}),
}))

const { useCamStore } = await import('../../store')
const { geometryWorldBounds } = await import('../../store/dispatchGeo')
const { isModelOriginGeometry } = await import('../../lib/cam/modelOrigin')
const { resetDocumentHolder } = await import('../../doc/documentHolder')

function bbox(min: [number, number, number], max: [number, number, number]) {
  return {
    min: { x: min[0], y: min[1], z: min[2] },
    max: { x: max[0], y: max[1], z: max[2] },
    size: { x: max[0] - min[0], y: max[1] - min[1], z: max[2] - min[2] },
    center: { x: (min[0] + max[0]) / 2, y: (min[1] + max[1]) / 2, z: (min[2] + max[2]) / 2 },
  }
}

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

function modelGeo(id: string, position: Vec3 = { x: 0, y: 0, z: 0 }): ImportedGeometry {
  return {
    id, name: 'Bracket', filename: '', type: 'brep', format: 'model',
    boundingBox: bbox([0, 0, 0], [1, 1, 0]),
    position, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelBody: { ref: { bodyId: 'b1', stableIds: ['b1:F0'], version: 1 }, display: display() },
  } as ImportedGeometry
}

function plainGeo(id: string, position: Vec3 = { x: 0, y: 0, z: 0 }): ImportedGeometry {
  return {
    id, name: id, filename: `${id}.dxf`, type: 'curves_2d', format: 'dxf',
    boundingBox: bbox([0, 0, 0], [10, 10, 0]),
    position, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    loops: [{ id: `${id}-l1`, layerId: `${id}-lay`, type: 'contour', area: 50,
              points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }], closed: true }],
  } as ImportedGeometry
}

function makeProject(over: Partial<Project> = {}): Project {
  return {
    id: 'p1', name: 'INT-17C C1 Placement Gates', version: '1.0.0',
    createdAt: '2026-07-22T00:00:00.000Z', updatedAt: '2026-07-22T00:00:00.000Z',
    machine: {
      id: 'm-1', name: 'Router', type: 'gantry_router', controller: 'grbl',
      travel: { x: 800, y: 600, z: 100 }, rapidRate: 5000, maxSpindleRpm: 24000,
      minSpindleRpm: 8000, spindleDirection: 'cw', toolChanger: 'manual', coolant: false, notes: '',
    },
    toolLibrary: [], geometry: [], setups: [], activeSetupId: null, activeOperationId: null,
    sceneStock: { mode: 'auto', autoOffsetXY: 2, autoOffsetZTop: 1, fixedWidth: 100, fixedHeight: 100, fixedDepth: 12, fixedStocks: [] },
    notes: '',
    ...over,
  } as Project
}

beforeEach(() => {
  resetDocumentHolder()
  useCamStore.setState({ project: makeProject() })
})

describe('INT-17C Stage C1 step 3b: updateGeometryTransform refuses a modeled body (GO/NO-GO finding 4)', () => {
  it('throws, named, on a format:"model" row - mirrors setGeometryStock/refuseStockAssignmentForModelBody', () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [modelGeo('mg1')] } }))
    expect(() =>
      useCamStore.getState().updateGeometryTransform('mg1', { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    ).toThrow(/modeled geometry/i)
  })

  it('an ordinary row is unaffected - the gate is origin-keyed, not a blanket regression', () => {
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [plainGeo('g1')] } }))
    expect(() =>
      useCamStore.getState().updateGeometryTransform('g1', { x: 5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 }),
    ).not.toThrow()
    expect(useCamStore.getState().project.geometry[0].position).toEqual({ x: 5, y: 0, z: 0 })
  })
})

describe('INT-17C Stage C1 step 3c: applyGeoSnapToSetups skips a snap bound to a modeled body', () => {
  it('a setup snapped to a model-origin geo is NOT recomputed when an unrelated geo moves', () => {
    // The hazard this closes: applyGeoSnapToSetups looks up snapGeoId across
    // the WHOLE geometry array on every move, regardless of what actually
    // moved. Without the gate, ANY updateGeometryTransform call would recompute
    // (and outdate ops for) a setup snapped to a model row, from that row's
    // read-only projected pose - a real footgun once WCS feature bindings
    // reach model rows (preflight section 1e, GO/NO-GO finding 7 names this
    // as a future consumer this gate defends in advance).
    const untouchedOrigin: Vec3 = { x: 999, y: 999, z: 999 } // deliberately NOT what a recompute would produce
    const setup: Setup = {
      id: 'setup-1', name: 'Setup 1', notes: '', operations: [],
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54,
        origin: untouchedOrigin,
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
        snapGeoId: 'mg1',
        snapLocalPt: { x: 1, y: 1, z: 0 },
      },
      stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    } as Setup

    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [modelGeo('mg1', { x: 0, y: 0, z: 0 }), plainGeo('g1', { x: 0, y: 0, z: 0 })],
        setups: [setup],
        activeSetupId: 'setup-1',
      },
    }))

    // Move the UNRELATED plain geometry - this still runs applyGeoSnapToSetups
    // over the whole setups array.
    useCamStore.getState().updateGeometryTransform('g1', { x: 20, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })

    const after = useCamStore.getState().project.setups.find((s) => s.id === 'setup-1')!
    expect(after.wcs.origin).toEqual(untouchedOrigin)
  })

  it('control: the SAME snap setup DOES recompute when bound to an ordinary (non-model) geo', () => {
    // Proves the gate is origin-specific, not a general regression of the
    // snap-follow feature this WO must not disturb (WCS-nest/stock-move fix).
    const setup: Setup = {
      id: 'setup-1', name: 'Setup 1', notes: '', operations: [],
      wcs: {
        id: 'wcs-1', label: 'G54', fixtureOffset: 54,
        origin: { x: 1, y: 1, z: 0 },
        xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
        snapGeoId: 'g1',
        snapLocalPt: { x: 1, y: 1, z: 0 },
      },
      stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    } as Setup

    useCamStore.setState((s) => ({
      project: {
        ...s.project,
        geometry: [plainGeo('g1', { x: 0, y: 0, z: 0 })],
        setups: [setup],
        activeSetupId: 'setup-1',
      },
    }))

    useCamStore.getState().updateGeometryTransform('g1', { x: 20, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })

    const after = useCamStore.getState().project.setups.find((s) => s.id === 'setup-1')!
    expect(after.wcs.origin).toEqual({ x: 21, y: 1, z: 0 })
  })
})

describe('INT-17C Stage C1 step 3d: shared isModelOriginGeometry predicate, drive-by unification', () => {
  it('dispatchGeo.geometryWorldBounds still refuses a model row via the shared predicate (behavior unchanged)', () => {
    const geo = modelGeo('mg1')
    expect(isModelOriginGeometry(geo)).toBe(true)
    expect(geometryWorldBounds(geo)).toBeNull()
  })

  it('an ordinary mesh row still contributes bounds (predicate swap is behavior-identical)', () => {
    const geo = {
      id: 'g1', name: 'g1', filename: 'g1.stl', type: 'mesh', format: 'stl', loaded: true,
      boundingBox: bbox([0, 0, 0], [10, 10, 5]),
      position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    } as ImportedGeometry
    expect(geometryWorldBounds(geo)).not.toBeNull()
  })
})
