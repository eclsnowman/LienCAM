// WO-294: "a setup can take its zero from a bore" - a setup's origin can be a
// picked internal bore wall on a modeled body, X0/Y0 at the bore's axis
// centre, Z0 at its top rim, persisted as a durable part_feature/bore_center
// binding (not a one-time copy of three numbers).
//
// This drives the REAL store:
//   - resolveSetupBoreOriginPick (store/index.ts) is the ONE place the pick ->
//     origin/binding math lives; SetupModal's bore pick calls it after
//     readModelBodyFaceFacts resolves the live snapshot/verdicts.
//   - a refused pick (non-cylindrical / boss / missing facts) throws the SAME
//     named refusal deriveModelBodyBoreTarget already proves elsewhere
//     (modelBodyBoreDerive.q87.test.ts) and never touches the store.
//   - updateModelItemPlacement (the Stage C2 Placement write path) re-derives
//     a bore-bound setup origin through applyGeoSnapToSetups' bore_center
//     branch - the SAME re-derivation a vertex-snapped origin already rides,
//     extended rather than duplicated. The full trigger-matrix cell (stock
//     move/resize does NOT move it) lives in wcsRederivation.test.ts.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore, resolveSetupBoreOriginPick } from '../../store'
import type { FeatureVerdict } from '../../geom/geom-service'
import type { GeometrySnapshot } from '../../geom'
import type { ImportedGeometry, ModelItemPlacementRecord, Setup, WCS, Project } from '../../types'

// -- Fixtures (mirrors modelBodyBoreDerive.q87.test.ts's own known-good numbers) --

const geo = {
  id: 'modelbody:F1', name: 'Plate', filename: '', type: 'model', format: 'model',
  loaded: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 30, z: 10 } },
  modelItemId: 'legacy',
  modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:wall'], version: 1 } },
} as unknown as ImportedGeometry

const zeroRotationPlacements: ModelItemPlacementRecord[] = [{
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

// WO-336: a genuine boss pick also needs the body's per-face tessellation
// (deriveModelBodyCircularOrigin reads the wall's own top/bottom rim off its
// real triangles, never a bbox) -- `geo` above never carries `display`, so
// this is a SEPARATE fixture used only by the boss-acceptance test below,
// exactly mirroring circularFeatureZero.wo336.test.ts's own fixture.
const geoWithBossDisplay = {
  ...geo,
  modelBody: {
    ref: { bodyId: 'F1', stableIds: ['F1:wall'], version: 1 },
    display: {
      positions: [14, 12, 0, 6, 12, 0, 14, 12, 6, 6, 12, 6],
      normals: [], indices: [0, 1, 2, 1, 2, 3], edgePositions: [], edgeOffsets: [],
      bbox: { min: [6, 12, 0], max: [14, 12, 6] },
      faceIds: ['F1:wall'], triFace: [0, 0],
    },
  },
} as unknown as ImportedGeometry

function bossVerdict(patch: Partial<FeatureVerdict['params']> = {}): FeatureVerdict {
  return {
    featureKey: 'loop:10:12:0',
    featureClass: 'boss', removable: true, effect: 'remove',
    faceIds: ['F1:wall'], neighbourIds: [],
    params: { centerX: 10, centerY: 12, centerZ: 0, spanX: 8, spanY: 8, depth: 6, faceCount: 2, ...patch },
  }
}

function makeWcs(over: Partial<WCS> = {}): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    ...over,
  }
}

function makeSetup(wcs: WCS): Setup {
  return {
    id: 'setup-1', name: 'Setup 1',
    wcs,
    stock: {
      type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0,
      material: 'aluminum',
    } as Setup['stock'],
    operations: [], notes: '',
  }
}

function installProject(over: Partial<Project>): void {
  useCamStore.setState((s) => ({
    project: {
      ...s.project,
      geometry: [], setups: [], stocks: [],
      activeSetupId: 'setup-1', activeOperationId: null,
      ...over,
    },
  }))
}

function currentWcs(): WCS {
  return useCamStore.getState().project.setups[0].wcs
}

beforeEach(() => {
  installProject({})
})

describe('resolveSetupBoreOriginPick: a bore pick writes an origin and a durable binding', () => {
  it('derives the origin at the axis centre (X/Y) with Z at the top rim', () => {
    const picked = resolveSetupBoreOriginPick(geo, 'F1', 'F1:wall', snapshot(), [hole()], zeroRotationPlacements)
    // world centerX=15, centerY=10, topZ=17 (matches modelBodyBoreDerive.q87.test.ts).
    expect(picked.origin).toEqual({ x: 15, y: 10, z: 17 })
  })

  it('writes a binding recording the face stable id and the owning geometry', () => {
    const picked = resolveSetupBoreOriginPick(geo, 'F1', 'F1:wall', snapshot(), [hole()], zeroRotationPlacements)
    expect(picked.originBinding).toEqual({
      kind: 'part_feature',
      geoId: 'modelbody:F1',
      featureRef: {
        kind: 'bore_center',
        geoId: 'modelbody:F1',
        bodyId: 'F1',
        modelItemId: 'legacy',
        faceStableId: 'F1:wall',
        localCenter: { x: 10, y: 12, z: 10 },
        diameter: 8,
      },
    })
    // Legacy mirror fields (WO-294: rides the same re-derivation a
    // vertex-snapped origin uses) agree with the featureRef's local point.
    expect(picked.snapGeoId).toBe('modelbody:F1')
    expect(picked.snapLocalPt).toEqual({ x: 10, y: 12, z: 10 })
  })
})

describe('resolveSetupBoreOriginPick: refuse rather than guess', () => {
  it('throws for a non-cylindrical face and touches no store state', () => {
    const wcs = makeWcs({
      origin: { x: 15, y: 10, z: 17 },
      snapGeoId: 'modelbody:F1', snapLocalPt: { x: 10, y: 12, z: 10 },
      originBinding: {
        kind: 'part_feature', geoId: 'modelbody:F1',
        featureRef: {
          kind: 'bore_center', geoId: 'modelbody:F1', bodyId: 'F1', modelItemId: 'legacy',
          faceStableId: 'F1:wall', localCenter: { x: 10, y: 12, z: 10 }, diameter: 8,
        },
      },
    })
    installProject({ geometry: [geo], setups: [makeSetup(wcs)], modelItemPlacements: zeroRotationPlacements })
    const before = JSON.stringify(useCamStore.getState().project.setups)

    expect(() => resolveSetupBoreOriginPick(
      geo, 'F1', 'F1:wall', snapshot({ type: 'plane' }), [hole()], zeroRotationPlacements,
    )).toThrow(/not cylindrical/i)

    // Same origin, same binding: the refusal never reached the store.
    expect(JSON.stringify(useCamStore.getState().project.setups)).toBe(before)
    expect(currentWcs().origin).toEqual({ x: 15, y: 10, z: 17 })
  })

  it('throws for a boss verdict that carries no base-loop span facts to prove it is a full circular wall', () => {
    // A malformed/older-shaped 'boss' verdict (built from hole()'s params,
    // which never carries spanX/spanY) - refuse rather than guess, same as
    // every other missing-analytic-fact case here.
    const malformedBoss = { ...hole(), featureClass: 'boss' } as unknown as FeatureVerdict
    expect(() => resolveSetupBoreOriginPick(
      geo, 'F1', 'F1:wall', snapshot(), [malformedBoss], zeroRotationPlacements,
    )).toThrow(/missing its base-loop span facts/i)
  })

  it('throws for missing analytic cylinder facts', () => {
    expect(() => resolveSetupBoreOriginPick(
      geo, 'F1', 'F1:wall', snapshot({ radius: undefined }), [hole()], zeroRotationPlacements,
    )).toThrow(/missing.*radius/i)
  })
})

describe('resolveSetupBoreOriginPick: WO-336 - a boss is also a valid zero point', () => {
  it('accepts a genuine full-circle external boss and writes the same kind of durable binding a bore does', () => {
    const picked = resolveSetupBoreOriginPick(
      geoWithBossDisplay, 'F1', 'F1:wall', snapshot(), [bossVerdict()], zeroRotationPlacements,
    )
    // world centerX=15, centerY=10 (matches the bore case); topZ = mesh max
    // local Z (6) + placement position.z (7) = 13, read off the wall's own
    // triangles, never the boss verdict's crude depth estimate.
    expect(picked.origin).toEqual({ x: 15, y: 10, z: 13 })
    expect(picked.originBinding).toEqual({
      kind: 'part_feature',
      geoId: 'modelbody:F1',
      featureRef: {
        kind: 'bore_center',
        geoId: 'modelbody:F1',
        bodyId: 'F1',
        modelItemId: 'legacy',
        faceStableId: 'F1:wall',
        localCenter: { x: 10, y: 12, z: 6 }, // 13 - placement position.z (7)
        diameter: 8,
      },
    })
  })

  it('refuses a boss whose base loop does not match its own wall diameter (not a full circle)', () => {
    expect(() => resolveSetupBoreOriginPick(
      geoWithBossDisplay, 'F1', 'F1:wall', snapshot(), [bossVerdict({ spanX: 5 })], zeroRotationPlacements,
    )).toThrow(/not a full circular wall/i)
  })
})

describe('the bore binding rides its part\'s Placement (store/index.ts applyGeoSnapToSetups)', () => {
  it('moving the model item the bore lives on moves the origin', () => {
    const picked = resolveSetupBoreOriginPick(geo, 'F1', 'F1:wall', snapshot(), [hole()], zeroRotationPlacements)
    const wcs = makeWcs({
      origin: picked.origin,
      snapGeoId: picked.snapGeoId, snapLocalPt: picked.snapLocalPt,
      originBinding: picked.originBinding,
    })
    installProject({ geometry: [geo], setups: [makeSetup(wcs)], modelItemPlacements: zeroRotationPlacements })

    // Move the item to a NEW position with a 90deg Z rotation. Hand-computed
    // (independent of resolveSetupBoreOriginPick's own formula): world =
    // R(90)*localCenter + newPosition, localCenter = (10, 12, 10).
    //   x = 10*cos90 - 12*sin90 + 0 = -12
    //   y = 10*sin90 + 12*cos90 + 0 =  10
    //   z = 10 + 0 = 10
    useCamStore.getState().updateModelItemPlacement(
      'legacy', undefined, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 90 },
    )
    const origin = currentWcs().origin
    expect(origin.x).toBeCloseTo(-12, 6)
    expect(origin.y).toBeCloseTo(10, 6)
    expect(origin.z).toBeCloseTo(10, 6)
  })

  it('an unresolved Placement (body no longer in the registry) leaves the origin untouched', () => {
    const picked = resolveSetupBoreOriginPick(geo, 'F1', 'F1:wall', snapshot(), [hole()], zeroRotationPlacements)
    const wcs = makeWcs({
      origin: picked.origin,
      snapGeoId: picked.snapGeoId, snapLocalPt: picked.snapLocalPt,
      originBinding: picked.originBinding,
    })
    // Install with NO placement for 'legacy' at all -- a different item moves.
    installProject({
      geometry: [geo], setups: [makeSetup(wcs)],
      modelItemPlacements: [{ modelItemId: 'other-item', position: { x: 1, y: 1, z: 1 }, rotation: { x: 0, y: 0, z: 0 } }],
    })
    useCamStore.getState().updateModelItemPlacement(
      'other-item', undefined, { x: 9, y: 9, z: 9 }, { x: 0, y: 0, z: 0 },
    )
    expect(currentWcs().origin).toEqual(picked.origin)
  })
})
