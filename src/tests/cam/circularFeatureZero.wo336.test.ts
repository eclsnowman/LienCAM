import { describe, expect, it } from 'vitest'
import type { FeatureVerdict } from '../../geom/geom-service'
import type { GeometrySnapshot } from '../../geom'
import type { ImportedGeometry, ModelItemPlacementRecord } from '../../types'
import {
  deriveModelBodyCircularOrigin,
  ModelBodyDeriveError,
} from '../../lib/cam/modelBodyDerive'

// A boss wall face (2 triangles, a rectangle standing in for the wall's
// tessellation) spanning local Z 0..6 -- min/max Z is all this derive reads
// from the mesh, so the exact XY layout is irrelevant.
const display = {
  positions: [
    14, 12, 0,
    6, 12, 0,
    14, 12, 6,
    6, 12, 6,
  ],
  normals: [],
  indices: [0, 1, 2, 1, 2, 3],
  edgePositions: [],
  edgeOffsets: [],
  bbox: { min: [6, 12, 0] as [number, number, number], max: [14, 12, 6] as [number, number, number] },
  faceIds: ['F1:wall'],
  triFace: [0, 0],
}

function geoWithDisplay(): ImportedGeometry {
  return {
    id: 'modelbody:F1', name: 'Plate', filename: '', type: 'model', format: 'model',
    loaded: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 30, z: 10 } },
    modelItemId: 'legacy',
    modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:wall'], version: 1 }, display },
  } as unknown as ImportedGeometry
}

const geoNoDisplay = {
  id: 'modelbody:F1', name: 'Plate', filename: '', type: 'model', format: 'model',
  loaded: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 30, z: 10 } },
  modelItemId: 'legacy',
  modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:wall'], version: 1 } },
} as unknown as ImportedGeometry

const placements: ModelItemPlacementRecord[] = [{
  modelItemId: 'legacy',
  position: { x: 5, y: -2, z: 7 },
  rotation: { x: 0, y: 0, z: 0 },
}]

function hole(faceIds = ['F1:wall']): FeatureVerdict {
  return {
    featureKey: 'hole:10:12:10:0:0:1:4',
    featureClass: 'blindHole', removable: true, effect: 'add',
    faceIds, neighbourIds: [],
    params: {
      diameter: 8, depth: 6,
      axisX: 0, axisY: 0, axisZ: 1,
      centerX: 10, centerY: 12, centerZ: 10,
    },
  }
}

function boss(patch: Partial<FeatureVerdict['params']> = {}, faceIds = ['F1:wall']): FeatureVerdict {
  return {
    featureKey: 'loop:10:12:0',
    featureClass: 'boss', removable: true, effect: 'remove',
    faceIds, neighbourIds: [],
    params: {
      centerX: 10, centerY: 12, centerZ: 0,
      spanX: 8, spanY: 8, depth: 6, faceCount: 2,
      ...patch,
    },
  }
}

function cylinderSnapshot(patch: Partial<GeometrySnapshot> = {}): GeometrySnapshot {
  return {
    type: 'cylinder', centroid: [10, 12, 3], normal: [1, 0, 0], area: 150,
    axis: [0, 0, 1], axisPoint: [10, 12, 0], radius: 4,
    ...patch,
  }
}

describe('WO-336 deriveModelBodyCircularOrigin', () => {
  it('accepts a full-circumference external boss and derives its centre/top/bottom honestly from the mesh, not a bbox', () => {
    const result = deriveModelBodyCircularOrigin(geoWithDisplay(), placements, 'F1:wall', cylinderSnapshot(), [boss()])
    expect(result).toEqual({
      faceKind: 'boss',
      center: [15, 10],
      topZ: 13,   // maxLocalZ (6) + placement.position.z (7)
      bottomZ: 7, // minLocalZ (0) + placement.position.z (7)
      diameter: 8,
    })
  })

  it('still resolves the existing internal-hole (bore) case, unchanged, through the same entry point', () => {
    const result = deriveModelBodyCircularOrigin(geoWithDisplay(), placements, 'F1:wall', cylinderSnapshot(), [hole()])
    expect(result).toEqual({
      faceKind: 'bore',
      center: [15, 10],
      topZ: 17,
      bottomZ: 11,
      diameter: 8,
    })
  })

  it('refuses a boss whose base-loop outline does not match its own wall diameter in both directions (a D-shaped/partial wall)', () => {
    expect(() => deriveModelBodyCircularOrigin(
      geoWithDisplay(), placements, 'F1:wall', cylinderSnapshot(), [boss({ spanX: 5 })],
    )).toThrow(/not a full circular wall/i)
  })

  it('refuses a boss wall whose analytic axis is tilted off Z', () => {
    expect(() => deriveModelBodyCircularOrigin(
      geoWithDisplay(), placements, 'F1:wall', cylinderSnapshot({ axis: [0, 0.2, 0.98] }), [boss()],
    )).toThrow(/tilted off Z/i)
  })

  it('refuses a boss when the body has no per-face tessellation identity yet to read a top rim from', () => {
    expect(() => deriveModelBodyCircularOrigin(
      geoNoDisplay, placements, 'F1:wall', cylinderSnapshot(), [boss()],
    )).toThrow(/per-face identity data/i)
  })

  it('refuses a recognized feature class with no single well-defined centre (e.g. a fillet)', () => {
    const fillet = { ...boss(), featureClass: 'filletPlanar' } as unknown as FeatureVerdict
    expect(() => deriveModelBodyCircularOrigin(
      geoWithDisplay(), placements, 'F1:wall', cylinderSnapshot(), [fillet],
    )).toThrow(/not a recognized bore or boss/i)
  })

  it('refuses a non-cylindrical face explicitly', () => {
    expect(() => deriveModelBodyCircularOrigin(
      geoWithDisplay(), placements, 'F1:wall', cylinderSnapshot({ type: 'plane' }), [boss()],
    )).toThrow(/not cylindrical/i)
  })

  it('refuses an unproven cylinder (matches no recognized feature) and an ambiguous one (matches more than one)', () => {
    expect(() => deriveModelBodyCircularOrigin(
      geoWithDisplay(), placements, 'F1:wall', cylinderSnapshot(), [boss({}, ['F1:other'])],
    )).toThrow(/not proven to be a recognized circular feature/i)

    expect(() => deriveModelBodyCircularOrigin(
      geoWithDisplay(), placements, 'F1:wall', cylinderSnapshot(), [boss(), { ...boss(), featureKey: 'second' }],
    )).toThrow(/ambiguous/i)
  })

  it('surfaces ModelBodyDeriveError as the thrown type for a boss refusal', () => {
    expect(() => deriveModelBodyCircularOrigin(
      geoWithDisplay(), placements, 'F1:wall', cylinderSnapshot(), [boss({ spanY: 2 })],
    )).toThrow(ModelBodyDeriveError)
  })
})
