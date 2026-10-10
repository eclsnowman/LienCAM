import { describe, expect, it } from 'vitest'
import type { FeatureVerdict } from '../../geom/geom-service'
import type { GeometrySnapshot } from '../../geom'
import type { ImportedGeometry, ModelItemPlacementRecord } from '../../types'
import {
  deriveModelBodyBoreTarget,
  modelBoreLoopId,
  ModelBodyDeriveError,
} from '../../lib/cam/modelBodyDerive'

const geo = {
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

function snapshot(patch: Partial<GeometrySnapshot> = {}): GeometrySnapshot {
  return {
    type: 'cylinder', centroid: [10, 12, 7], normal: [1, 0, 0], area: 150,
    axis: [0, 0, 1], axisPoint: [10, 12, 0], radius: 4,
    ...patch,
  }
}

describe('Q-87 modeled-body Bore selected-wall adapter', () => {
  it('derives axis, diameter, world top/bottom/depth and an ephemeral bore loop', () => {
    const result = deriveModelBodyBoreTarget(geo, placements, 'F1:wall', snapshot(), [hole()])

    expect(result.target).toMatchObject({
      axis: [0, 0, 1], centerX: 15, centerY: 10,
      diameter: 8, topZ: 17, bottomZ: 11, depth: 6,
    })
    expect(result.localTopZ).toBe(10)
    expect(result.localBottomZ).toBe(4)
    expect(result.loop.id).toBe(modelBoreLoopId('F1:wall'))
    expect(result.cylinder).toMatchObject({
      kind: 'bore', diameter: 8, topZ: 17, bottomZ: 11,
      loopId: result.loop.id,
    })
  })

  it('refuses a non-cylinder face explicitly', () => {
    expect(() => deriveModelBodyBoreTarget(
      geo, placements, 'F1:wall', snapshot({ type: 'plane' }), [hole()],
    )).toThrow(/not cylindrical/i)
  })

  it('refuses missing analytic cylinder facts explicitly', () => {
    expect(() => deriveModelBodyBoreTarget(
      geo, placements, 'F1:wall', snapshot({ radius: undefined }), [hole()],
    )).toThrow(/missing.*radius/i)
  })

  it('refuses an external boss explicitly', () => {
    const boss = { ...hole(), featureClass: 'boss' } as unknown as FeatureVerdict
    expect(() => deriveModelBodyBoreTarget(
      geo, placements, 'F1:wall', snapshot(), [boss],
    )).toThrow(/external boss/i)
  })

  it('refuses unproven and ambiguous internal walls explicitly', () => {
    expect(() => deriveModelBodyBoreTarget(
      geo, placements, 'F1:wall', snapshot(), [hole(['F1:other'])],
    )).toThrow(/not proven.*internal/i)

    expect(() => deriveModelBodyBoreTarget(
      geo, placements, 'F1:wall', snapshot(), [hole(), { ...hole(), featureKey: 'second' }],
    )).toThrow(/ambiguous/i)
  })

  it('refuses a selected counterbore wall whose radius is not the recognized cutting diameter', () => {
    expect(() => deriveModelBodyBoreTarget(
      geo, placements, 'F1:wall', snapshot({ radius: 6 }), [hole()],
    )).toThrow(ModelBodyDeriveError)
    expect(() => deriveModelBodyBoreTarget(
      geo, placements, 'F1:wall', snapshot({ radius: 6 }), [hole()],
    )).toThrow(/diameter.*does not match/i)
  })
})
