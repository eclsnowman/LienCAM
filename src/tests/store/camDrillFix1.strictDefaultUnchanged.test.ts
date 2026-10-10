// CAM-DRILL-FIX1 regression pin: proves the narrow model-source opt-in added
// to resolveTopZ's stock_top/stock_bottom branch (src/store/dispatchGeo.ts)
// does NOT relax the strict default for any other consumer:
//
//  1. resolveModelBottomZ ('model_bottom' / bottomHeightMode 'model_bottom')
//     is UNTOUCHED - still refuses a directly-referenced model-origin
//     geometryId, and still ignores a stock-bound model row's LOCAL bbox for
//     '__all__' (the f4ba754be / mistral-stock-heights audit's -50 hazard
//     case, reproduced here directly rather than only via the existing
//     modelStockHeights.test.ts coverage, so THIS lane's own gate proves it).
//  2. resolveTopZ's OTHER reference kinds (model_top, geometry_face,
//     picked_plane) for a directly-referenced model geometryId still THROW
//     ModelOriginComputeError - the new branch is scoped to stock_top/
//     stock_bottom only, exactly as CAM-DRILL-FIX1.report.md documents.
//
// MUTATION-PROOF: routing resolveModelBottomZ (or resolveTopZ's model_top/
// geometry_face branches) through the new model-source carve-out would flip
// test 1's expectation from 0 to -50 (or make test 2/3 stop throwing) -
// exactly the audit's own reproduction shape.

import { describe, it, expect } from 'vitest'
import type { ImportedGeometry, PhysicalStock, SceneStock, Setup } from '../../types'
import {
  resolveTopZ, resolveModelBottomZ, ModelOriginComputeError,
} from '../../store/dispatchGeo'

function createModelGeometry(
  id: string,
  name: string,
  bbox: { min: [number, number, number]; max: [number, number, number] },
  stockId?: string,
): ImportedGeometry {
  return {
    id, name, type: 'model', format: 'model',
    modelItemId: 'item1',
    modelBody: {
      ref: { bodyId: 'body1', stableIds: [], version: 1 },
      display: { bbox, positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [] },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    stockId,
    loops: [{ id: 'loop1', points: [], closed: true, type: 'contour', layerId: 'layer1', area: 0 }],
    boundingBox: {
      min: { x: bbox.min[0], y: bbox.min[1], z: bbox.min[2] },
      max: { x: bbox.max[0], y: bbox.max[1], z: bbox.max[2] },
      size: {
        x: bbox.max[0] - bbox.min[0], y: bbox.max[1] - bbox.min[1], z: bbox.max[2] - bbox.min[2],
      },
      center: {
        x: (bbox.max[0] + bbox.min[0]) / 2, y: (bbox.max[1] + bbox.min[1]) / 2, z: (bbox.max[2] + bbox.min[2]) / 2,
      },
    },
    filename: '', loaded: true,
  } as unknown as ImportedGeometry
}

function createNonModelGeometry(
  id: string,
  name: string,
  bbox: { min: { x: number; y: number; z: number }; max: { x: number; y: number; z: number } },
  stockId?: string,
): ImportedGeometry {
  return {
    id, name, type: 'curves_2d', format: 'dxf',
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    stockId, stockIdLocked: true,
    loops: [{ id: 'loop1', points: [], closed: true, type: 'contour', layerId: 'layer1', area: 0 }],
    boundingBox: {
      min: bbox.min, max: bbox.max,
      size: { x: bbox.max.x - bbox.min.x, y: bbox.max.y - bbox.min.y, z: bbox.max.z - bbox.min.z },
      center: {
        x: (bbox.max.x + bbox.min.x) / 2, y: (bbox.max.y + bbox.min.y) / 2, z: (bbox.max.z + bbox.min.z) / 2,
      },
    },
    filename: '', loaded: true,
  } as unknown as ImportedGeometry
}

function derivedStock(id: string, name: string): PhysicalStock {
  return {
    id, name, mode: 'derived',
    bounds: { min: { x: 0, y: 0, z: 0 }, max: { x: 0, y: 0, z: 0 }, size: { x: 0, y: 0, z: 0 }, center: { x: 0, y: 0, z: 0 } },
    position: { x: 0, y: 0, z: 0 }, workOffset: { x: 0, y: 0, z: 0 },
  } as unknown as PhysicalStock
}

const sceneStock = {
  mode: 'auto', autoOffsetXY: 5, autoOffsetZTop: 5, autoStocks: [], fixedStocks: [],
  fixedWidth: 0, fixedHeight: 0, fixedDepth: 0,
} as unknown as SceneStock

function setup(wcsZ = 0): Setup {
  return {
    id: 'setup1', name: 'Setup 1',
    wcs: {
      id: 'wcs1', label: 'WCS 1', origin: { x: 0, y: 0, z: wcsZ }, fixtureOffset: 0,
      xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    },
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: '' },
    operations: [], notes: '',
  } as unknown as Setup
}

describe('CAM-DRILL-FIX1 regression pin: strict default unchanged for other consumers', () => {
  it('resolveModelBottomZ (model_bottom) still ignores a stock-bound model row\'s LOCAL bbox for __all__ (audit -50 hazard, unchanged)', () => {
    const dxfGeo = createNonModelGeometry(
      'dxf1', 'DXF Part',
      { min: { x: -50, y: -50, z: 0 }, max: { x: 50, y: 50, z: 0 } },
      'stock1',
    )
    const modelGeo = createModelGeometry(
      'model1', 'Tall Model Body',
      { min: [-20, -15, -50], max: [20, 15, 10] },
      'stock1',
    )
    const stock = derivedStock('stock1', 'Stock 1')

    const bottomDxfOnly = resolveModelBottomZ([dxfGeo], '__all__', 0, [stock], [])
    const bottomWithModelRow = resolveModelBottomZ([dxfGeo, modelGeo], '__all__', 0, [stock], [])

    expect(bottomDxfOnly).toBe(0)
    // NOT -50 - proves the model row's LOCAL (unplaced) bbox is still not
    // contributing, exactly as before CAM-DRILL-FIX1.
    expect(bottomWithModelRow).toBe(0)
  })

  it('resolveModelBottomZ still THROWS when a model body is directly referenced by id', () => {
    const modelGeo = createModelGeometry('model1', 'Model 1', { min: [-20, -15, 0], max: [20, 15, 10] })
    expect(() =>
      resolveModelBottomZ([modelGeo], 'model1', 0, [], []),
    ).toThrow(ModelOriginComputeError)
  })

  it('resolveTopZ "model_top" for a directly-referenced model geometryId still THROWS (new opt-in is stock_top/stock_bottom ONLY)', () => {
    const modelGeo = createModelGeometry('model1', 'Model 1', { min: [-20, -15, 0], max: [20, 15, 10] })
    const stock = derivedStock('stock1', 'Stock 1')
    expect(() =>
      resolveTopZ('model_top', 0, setup(), sceneStock, [modelGeo], 'model1', [stock], []),
    ).toThrow(ModelOriginComputeError)
  })

  it('resolveTopZ "geometry_face" for a directly-referenced model geometryId still THROWS', () => {
    const modelGeo = createModelGeometry('model1', 'Model 1', { min: [-20, -15, 0], max: [20, 15, 10] })
    const stock = derivedStock('stock1', 'Stock 1')
    expect(() =>
      resolveTopZ('geometry_face', 0, setup(), sceneStock, [modelGeo], 'model1', [stock], []),
    ).toThrow(ModelOriginComputeError)
  })

  it('resolveTopZ "picked_plane" whose datum geoId is a model body still THROWS', () => {
    const modelGeo = createModelGeometry('model1', 'Model 1', { min: [-20, -15, 0], max: [20, 15, 10] })
    const nonModelGeo = createNonModelGeometry(
      'part1', 'Part 1',
      { min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 5 } },
    )
    const stock = derivedStock('stock1', 'Stock 1')
    expect(() =>
      resolveTopZ(
        'picked_plane', 0, setup(), sceneStock, [modelGeo, nonModelGeo], 'part1', [stock], [],
        { geoId: 'model1', faceIndex: 0, localZ: 0 },
      ),
    ).toThrow(ModelOriginComputeError)
  })
})
