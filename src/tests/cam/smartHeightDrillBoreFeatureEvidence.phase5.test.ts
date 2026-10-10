import { describe, expect, it } from 'vitest'
import type { FeatureVerdict } from '../../geom/geom-service'
import { deriveModelBodyDrillTargets } from '../../lib/cam/modelBodyDerive'
import { deriveDrillBoreFeatureBindings } from '../../lib/cam/smartHeights'
import type { ImportedGeometry, Layer2D, Loop2D, ModelItemPlacementRecord } from '../../types'

const circle = (id: string, layerId: string, z = 0): Loop2D => ({
  id,
  layerId,
  closed: true,
  type: 'contour',
  area: Math.PI * 9,
  points: Array.from({ length: 16 }, (_, index) => {
    const angle = 2 * Math.PI * index / 16
    return { x: 10 + 3 * Math.cos(angle), y: 10 + 3 * Math.sin(angle), z }
  }),
})

const imported = (
  id: string,
  loop: Loop2D,
  layer: Layer2D,
): ImportedGeometry => ({
  id,
  name: id,
  filename: `${id}.step`,
  type: 'brep',
  format: 'step',
  boundingBox: {
    min: { x: 0, y: 0, z: 0 }, max: { x: 20, y: 20, z: 10 },
    size: { x: 20, y: 20, z: 10 }, center: { x: 10, y: 10, z: 5 },
  },
  position: { x: 0, y: 0, z: 0 },
  rotation: { x: 0, y: 0, z: 0 },
  loaded: true,
  loops: [loop],
  layers2d: [layer],
}) as ImportedGeometry

const modelGeo = (): ImportedGeometry => ({
  ...imported('model-geo', circle('placeholder', 'placeholder'), {
    id: 'placeholder', name: 'placeholder', color: '#fff', visible: true,
  }),
  type: 'model',
  format: 'model',
  modelItemId: 'item-1',
  modelBody: {
    ref: { bodyId: 'body-1', stableIds: ['body-1:F0'], version: 7 },
    display: {
      positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
      bbox: { min: [0, 0, 0], max: [20, 20, 10] },
    },
  },
}) as ImportedGeometry

const verdict = (faceIds = ['body-1:hole-wall']): FeatureVerdict => ({
  featureKey: 'hole:10:10:10:0:0:1:3',
  featureClass: 'blindHole',
  removable: true,
  effect: 'add',
  faceIds,
  neighbourIds: [],
  params: {
    diameter: 6, depth: 5, axisX: 0, axisY: 0, axisZ: 1,
    centerX: 10, centerY: 10, centerZ: 10,
  },
})

function modelBindingGeometry(
  placement: ModelItemPlacementRecord,
  loopId: string,
  faceIds = ['body-1:hole-wall'],
): ImportedGeometry {
  const result = deriveModelBodyDrillTargets(modelGeo(), [placement], [verdict(faceIds)])
  const loop = { ...result.loops[0], id: loopId, layerId: 'model-holes' }
  return {
    ...modelGeo(),
    loops: [loop],
    layers2d: [{
      id: 'model-holes', name: 'Model holes', color: '#fff', visible: true,
      derived: true, frame: 'geometry_local',
      holes: [{ ...result.holes[0], loopId }],
    }],
  }
}

describe('Drill/Bore stable physical feature bindings', () => {
  it('binds imported mixed-depth holes and refuses plain circles', () => {
    const holeLoop = circle('hole-1', 'holes')
    const holeGeo = imported('part', holeLoop, {
      id: 'holes', name: 'Holes', color: '#fff', visible: true, frame: 'geometry_local',
      holes: [{ center: [10, 10], diameter: 6, topZ: 10, bottomZ: 4, through: false, loopId: 'hole-1' }],
    })
    const result = deriveDrillBoreFeatureBindings([holeGeo], ['hole-1'], 'drill')
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.bindings[0]).toMatchObject({
      loopId: 'hole-1', frame: 'geometry_local', topMm: 10, floorMm: 4,
      featureKind: 'hole',
    })

    const flat = imported('dxf', circle('circle-1', 'curves'), {
      id: 'curves', name: 'Curves', color: '#fff', visible: true,
    })
    const refused = deriveDrillBoreFeatureBindings([flat], ['circle-1'], 'drill')
    expect(refused).toMatchObject({ ok: false, refusals: [{ code: 'no_physical_feature' }] })
  })

  it('allows a selected internal cylinder for Bore but refuses holes and bosses', () => {
    const boreLoop = circle('bore-1', 'cylinders')
    const boreGeo = imported('part', boreLoop, {
      id: 'cylinders', name: 'Cylinders', color: '#fff', visible: true,
      cylinders: [{
        center: [10, 10], diameter: 6, topZ: 10, bottomZ: 2,
        through: false, kind: 'bore', loopId: 'bore-1',
      }],
    })
    expect(deriveDrillBoreFeatureBindings([boreGeo], ['bore-1'], 'bore').ok).toBe(true)

    const bossGeo = imported('boss', circle('boss-1', 'bosses'), {
      id: 'bosses', name: 'Bosses', color: '#fff', visible: true,
      cylinders: [{
        center: [10, 10], diameter: 6, topZ: 10, bottomZ: 2,
        through: false, kind: 'boss', loopId: 'boss-1',
      }],
    })
    expect(deriveDrillBoreFeatureBindings([bossGeo], ['boss-1'], 'bore'))
      .toMatchObject({ ok: false, refusals: [{ code: 'wrong_feature_kind' }] })

    const holeGeo = imported('hole', circle('hole-1', 'holes'), {
      id: 'holes', name: 'Holes', color: '#fff', visible: true,
      holes: [{ center: [10, 10], diameter: 6, topZ: 10, bottomZ: 2, through: false, loopId: 'hole-1' }],
    })
    expect(deriveDrillBoreFeatureBindings([holeGeo], ['hole-1'], 'bore'))
      .toMatchObject({ ok: false, refusals: [{ code: 'wrong_feature_kind' }] })
  })

  it('keeps Model feature identity stable across wizard/live loop ids and placement changes', () => {
    const identity: ModelItemPlacementRecord = {
      modelItemId: 'item-1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    }
    const moved: ModelItemPlacementRecord = {
      ...identity, position: { x: 50, y: 20, z: 8 },
    }
    const wizard = deriveDrillBoreFeatureBindings(
      [modelBindingGeometry(identity, 'wizard-content-id')], ['wizard-content-id'], 'drill',
    )
    const live = deriveDrillBoreFeatureBindings(
      [modelBindingGeometry(moved, 'mdh:live-feature-key')], ['mdh:live-feature-key'], 'drill',
    )
    expect(wizard.ok).toBe(true)
    expect(live.ok).toBe(true)
    if (!wizard.ok || !live.ok) return
    expect(live.bindings[0].feature).toEqual(wizard.bindings[0].feature)
    expect(live.bindings[0].loopId).not.toBe(wizard.bindings[0].loopId)
    expect(live.bindings[0].topMm).toBe(wizard.bindings[0].topMm + 8)
    expect(live.bindings[0].floorMm).toBe(wizard.bindings[0].floorMm + 8)
    expect(live.bindings[0].frame).toBe('world')
  })

  it('changes topology fingerprint when the recognized face set is replaced', () => {
    const placement: ModelItemPlacementRecord = {
      modelItemId: 'item-1', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
    }
    const before = deriveDrillBoreFeatureBindings(
      [modelBindingGeometry(placement, 'loop-before')], ['loop-before'], 'drill',
    )
    const after = deriveDrillBoreFeatureBindings(
      [modelBindingGeometry(placement, 'loop-after', ['body-1:replacement-wall'])], ['loop-after'], 'drill',
    )
    expect(before.ok).toBe(true)
    expect(after.ok).toBe(true)
    if (!before.ok || !after.ok) return
    expect(after.bindings[0].feature.stableId).toBe(before.bindings[0].feature.stableId)
    expect(after.bindings[0].feature.sourceFingerprint)
      .not.toBe(before.bindings[0].feature.sourceFingerprint)
  })

  it('refuses duplicate loop and duplicate physical-feature mappings', () => {
    const loop = circle('same-loop', 'holes')
    const layer: Layer2D = {
      id: 'holes', name: 'Holes', color: '#fff', visible: true,
      holes: [{ center: [10, 10], diameter: 6, topZ: 10, bottomZ: 2, through: false, loopId: 'same-loop' }],
    }
    const duplicateLoop = deriveDrillBoreFeatureBindings(
      [imported('part-a', loop, layer), imported('part-b', loop, layer)], ['same-loop'], 'drill',
    )
    expect(duplicateLoop).toMatchObject({ ok: false, refusals: [{ code: 'ambiguous_loop' }] })
    expect(deriveDrillBoreFeatureBindings([imported('part-a', loop, layer)], ['same-loop', 'same-loop'], 'drill'))
      .toMatchObject({ ok: false, refusals: [{ code: 'ambiguous_loop' }] })
  })
})
