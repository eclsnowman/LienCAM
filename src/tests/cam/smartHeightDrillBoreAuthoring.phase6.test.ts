import { describe, expect, it } from 'vitest'
import {
  buildDrillBoreAuthoringIntent,
  drillBoreSmartHeightDraftFromIntent,
  rebuildDrillBoreSmartHeightSafetyIntent,
} from '../../lib/cam/smartHeights'
import type { HeightIntentV1, ImportedGeometry, Layer2D, Loop2D } from '../../types'

const safety: Pick<HeightIntentV1, 'clearance' | 'retract' | 'feed'> = {
  clearance: { reference: 'retract', offset: 5, provenance: 'default' },
  retract: { reference: 'stock_top', offset: 3, provenance: 'default' },
  feed: { reference: 'top', offset: 1, provenance: 'default' },
}

const circle = (id: string, layerId: string): Loop2D => ({
  id, layerId, closed: true, type: 'contour', area: Math.PI * 4,
  points: [{ x: -2, y: 0 }, { x: 0, y: 2 }, { x: 2, y: 0 }, { x: 0, y: -2 }],
})

const geometry = (id: string, loops: Loop2D[], layers2d: Layer2D[]): ImportedGeometry => ({
  id, name: id, filename: `${id}.step`, type: 'brep', format: 'step',
  boundingBox: {
    min: { x: -2, y: -2, z: 0 }, max: { x: 2, y: 2, z: 10 },
    size: { x: 4, y: 4, z: 10 }, center: { x: 0, y: 0, z: 5 },
  },
  position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  loaded: true, loops, layers2d,
}) as ImportedGeometry

describe('Drill/Bore Smart Height authoring compiler', () => {
  it('authors durable detected-feature authority and stable manual overrides', () => {
    const loop = circle('hole-1', 'holes')
    const source = geometry('part', [loop], [{
      id: 'holes', name: 'Holes', color: '#fff', visible: true,
      holes: [{ center: [0, 0], diameter: 4, topZ: 10, bottomZ: 3, through: false, loopId: loop.id }],
    }])
    const intent = buildDrillBoreAuthoringIntent({
      operationType: 'drill', setupId: 'setup-1', safetyIntent: safety,
      geometries: [source], selectedLoopIds: [loop.id],
      draft: { mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 },
      perFeatureEndOverridesWcsMm: { [loop.id]: -8 },
    })
    expect(intent.policy).toEqual({ operationType: 'drill', variant: 'detected_features' })
    expect(intent.machining.scope.value).toMatchObject({ kind: 'selected_features', features: [{ stableId: loop.id }] })
    expect(intent.featureOverrides).toMatchObject([{ cutterCenterEnd: { offsetMm: -8 } }])
    expect(drillBoreSmartHeightDraftFromIntent(intent, 'drill').mode).toBe('detected_features')
  })

  it('refuses flat and mixed circles in detected mode instead of inventing depth', () => {
    const physical = circle('hole-1', 'curves')
    const flat = circle('circle-2', 'curves')
    const source = geometry('part', [physical, flat], [{
      id: 'curves', name: 'Curves', color: '#fff', visible: true,
      holes: [{ center: [0, 0], diameter: 4, topZ: 10, bottomZ: 3, through: false, loopId: physical.id }],
    }])
    expect(() => buildDrillBoreAuthoringIntent({
      operationType: 'drill', setupId: 'setup-1', safetyIntent: safety,
      geometries: [source], selectedLoopIds: [physical.id, flat.id],
      draft: { mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 },
    })).toThrow(/flat circle with no proven physical floor/i)
  })

  it('authors explicit Material Start and Target End for flat 2D circles', () => {
    const loop = circle('circle-1', 'curves')
    const source = geometry('dxf', [loop], [{
      id: 'curves', name: 'Curves', color: '#fff', visible: true,
    }])
    const intent = buildDrillBoreAuthoringIntent({
      operationType: 'bore', setupId: 'setup-1', safetyIntent: safety,
      geometries: [source], selectedLoopIds: [loop.id],
      draft: { mode: 'explicit_depth', explicitStartWcsMm: 2, explicitEndWcsMm: -12 },
    })
    expect(intent.policy).toEqual({ operationType: 'bore', variant: 'explicit_depth' })
    expect(intent.machining.scope.value).toEqual({ kind: 'selected_geometry', geometryIds: ['dxf'] })
    expect(drillBoreSmartHeightDraftFromIntent(intent, 'bore')).toEqual({
      mode: 'explicit_depth', explicitStartWcsMm: 2, explicitEndWcsMm: -12,
    })
  })

  it('refuses ambiguous loop ownership in explicit mode', () => {
    const loop = circle('same', 'curves')
    const layer = { id: 'curves', name: 'Curves', color: '#fff', visible: true }
    expect(() => buildDrillBoreAuthoringIntent({
      operationType: 'drill', setupId: 'setup-1', safetyIntent: safety,
      geometries: [geometry('a', [loop], [layer]), geometry('b', [loop], [layer])],
      selectedLoopIds: [loop.id],
      draft: { mode: 'explicit_depth', explicitStartWcsMm: 0, explicitEndWcsMm: -5 },
    })).toThrow(/more than one geometry source/i)
  })

  it('rebuilds safety without changing stable feature scope or overrides', () => {
    const loop = circle('hole-1', 'holes')
    const source = geometry('part', [loop], [{
      id: 'holes', name: 'Holes', color: '#fff', visible: true,
      holes: [{ center: [0, 0], diameter: 4, topZ: 10, bottomZ: 3, through: false, loopId: loop.id }],
    }])
    const intent = buildDrillBoreAuthoringIntent({
      operationType: 'drill', setupId: 'setup-1', safetyIntent: safety,
      geometries: [source], selectedLoopIds: [loop.id],
      draft: { mode: 'detected_features', explicitStartWcsMm: 0, explicitEndWcsMm: -5 },
      perFeatureEndOverridesWcsMm: { [loop.id]: -8 },
    })
    const next = rebuildDrillBoreSmartHeightSafetyIntent({
      intent, operationType: 'drill', setupId: 'setup-1',
      safetyIntent: {
        ...safety,
        clearance: { reference: 'wcs_plane', offset: 40, provenance: 'user' },
      },
    })
    expect(next.safety.clearance).toMatchObject({ reference: 'wcs_plane', offsetMm: 40 })
    expect(next.machining).toEqual(intent.machining)
    expect(next.featureOverrides).toEqual(intent.featureOverrides)
  })
})
