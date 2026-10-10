import { describe, expect, it } from 'vitest'
import type { ImportedGeometry, Layer2D, Loop2D } from '../../types'
import { deriveContourFeatureBindings } from '../../lib/cam/smartHeights'

function loop(id: string, layerId = 'layer-1'): Loop2D {
  return {
    id,
    layerId,
    name: id,
    points: [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }],
    closed: true,
    type: 'contour',
    area: 1,
  }
}

function geometry(options: {
  id?: string
  loops?: Loop2D[]
  layer?: Layer2D
  loopsVersion?: number
} = {}): ImportedGeometry {
  const id = options.id ?? 'geo-1'
  return {
    id,
    name: id,
    filename: `${id}.step`,
    type: 'brep',
    format: 'step',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 }, max: { x: 10, y: 10, z: 10 },
      size: { x: 10, y: 10, z: 10 }, center: { x: 5, y: 5, z: 5 },
    },
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    loops: options.loops ?? [loop('loop-1')],
    layers2d: [options.layer ?? {
      id: 'layer-1', name: 'Cylinder', color: '#fff', visible: true, frame: 'geometry_local',
      cylinders: [{
        center: [5, 5], diameter: 4, topZ: 8, bottomZ: 3,
        through: false, kind: 'boss', loopId: 'loop-1',
      }],
    }],
    loopsVersion: options.loopsVersion ?? 7,
  }
}

describe('Contour selected-feature evidence adapter', () => {
  it('derives a stable boss feature and its full axial extent', () => {
    const result = deriveContourFeatureBindings([geometry()], ['loop-1'])
    expect(result).toMatchObject({
      ok: true,
      bindings: [{
        loopId: 'loop-1',
        featureKind: 'boss',
        frame: 'geometry_local',
        topMm: 8,
        floorMm: 3,
        feature: {
          modelItemId: 'import:geo-1',
          bodyId: 'geo-1',
          featureKind: 'contour_boss',
          stableId: 'loop-1',
          sourceVersion: 7,
        },
      }],
    })
  })

  it('derives bore and detected-hole floors without using array position', () => {
    const boreLayer: Layer2D = {
      id: 'layer-1', name: 'Mixed', color: '#fff', visible: true, frame: 'geometry_local',
      cylinders: [{
        center: [2, 2], diameter: 2, topZ: 9, bottomZ: 4,
        through: false, kind: 'bore', loopId: 'bore-loop',
      }],
      holes: [{
        center: [6, 6], diameter: 1, topZ: 9, bottomZ: 1,
        through: true, loopId: 'hole-loop',
      }],
    }
    const result = deriveContourFeatureBindings([
      geometry({ loops: [loop('hole-loop'), loop('bore-loop')], layer: boreLayer }),
    ], ['bore-loop', 'hole-loop'])
    expect(result.ok && result.bindings.map(item => [item.loopId, item.featureKind, item.floorMm])).toEqual([
      ['bore-loop', 'bore', 4],
      ['hole-loop', 'hole', 1],
    ])
  })

  it('derives a selected planar face/edge loop at its plane', () => {
    const result = deriveContourFeatureBindings([geometry({
      layer: {
        id: 'layer-1', name: 'Face', color: '#fff', visible: true, frame: 'geometry_local',
        projectionPlane: {
          origin: { x: 0, y: 0, z: 6 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
      },
    })], ['loop-1'])
    expect(result).toMatchObject({
      ok: true,
      bindings: [{ featureKind: 'selected_plane', topMm: 6, floorMm: 6 }],
    })
  })

  it('gives legacy imported loops a valid version-1 identity', () => {
    const imported = geometry({
      layer: {
        id: 'layer-1', name: 'Imported plane', color: '#fff', visible: true,
        projectionPlane: {
          origin: { x: 0, y: 0, z: 0 },
          xAxis: { x: 1, y: 0, z: 0 },
          yAxis: { x: 0, y: 1, z: 0 },
          normal: { x: 0, y: 0, z: 1 },
        },
      },
    })
    delete imported.loopsVersion

    const result = deriveContourFeatureBindings([imported], ['loop-1'])
    expect(result).toMatchObject({
      ok: true,
      bindings: [{ feature: { sourceVersion: 1 } }],
    })
  })

  it('refuses a flat DXF/sketch curve with no physical endpoint', () => {
    const result = deriveContourFeatureBindings([geometry({
      layer: { id: 'layer-1', name: 'DXF', color: '#fff', visible: true },
    })], ['loop-1'])
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ loopId: 'loop-1', code: 'no_physical_endpoint' }],
    })
  })

  it('refuses duplicate loop identity across All Parts', () => {
    const result = deriveContourFeatureBindings([
      geometry({ id: 'geo-1' }), geometry({ id: 'geo-2' }),
    ], ['loop-1'])
    expect(result).toMatchObject({
      ok: false,
      refusals: [{ loopId: 'loop-1', code: 'ambiguous_loop' }],
    })
  })

  it('changes source identity when geometry facts change but not when placement changes', () => {
    const original = geometry()
    const moved = { ...original, position: { x: 25, y: 30, z: 12 } }
    const changed = geometry({
      layer: {
        ...original.layers2d![0],
        cylinders: [{ ...original.layers2d![0].cylinders![0], bottomZ: 2 }],
      },
    })
    const read = (value: ImportedGeometry) => {
      const result = deriveContourFeatureBindings([value], ['loop-1'])
      if (!result.ok) throw new Error(result.refusals[0].message)
      return result.bindings[0]
    }
    expect(read(moved).feature.sourceFingerprint).toBe(read(original).feature.sourceFingerprint)
    expect(read(changed).feature.sourceFingerprint).not.toBe(read(original).feature.sourceFingerprint)
  })
})
