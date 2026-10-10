// WO-1382: a work origin that says "Tracking" must actually follow the model.
//
// applyGeoSnapToSetups re-derives a bore/circle-tracked WCS origin after the
// model item moves. It used to apply only frame.rotation.z, so a body tilted
// about X or Y left the origin behind while the setup still reported Tracking.
// This drives the REAL store placement action (updateModelItemPlacement) and
// asserts the origin equals the FULL rigid-transform image of the feature's
// local centre, computed here by hand (independent of the store's formula) so
// the test cannot agree with a wrong implementation by construction.

import { describe, it, expect, beforeEach } from 'vitest'
import { useCamStore, resolveSetupBoreOriginPick } from '../../store'
import type { FeatureVerdict } from '../../geom/geom-service'
import type { GeometrySnapshot } from '../../geom'
import type { ImportedGeometry, ModelItemPlacementRecord, Setup, WCS, Project, Vec3 } from '../../types'

const geo = {
  id: 'modelbody:F1', name: 'Plate', filename: '', type: 'model', format: 'model',
  loaded: true, position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
  boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 30, y: 30, z: 10 } },
  modelItemId: 'legacy',
  modelBody: { ref: { bodyId: 'F1', stableIds: ['F1:wall'], version: 1 } },
} as unknown as ImportedGeometry

const basePlacements: ModelItemPlacementRecord[] = [{
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

// Hand-computed Euler 'XYZ' (R = Rx * Ry * Rz, three.js default) image of a
// local point plus translation -- written out explicitly so it is independent
// of rotationMatrixXYZ / the store formula under test.
function expectImage(local: Vec3, position: Vec3, rotation: Vec3): Vec3 {
  const d = (a: number) => (a * Math.PI) / 180
  const cx = Math.cos(d(rotation.x)), sx = Math.sin(d(rotation.x))
  const cy = Math.cos(d(rotation.y)), sy = Math.sin(d(rotation.y))
  const cz = Math.cos(d(rotation.z)), sz = Math.sin(d(rotation.z))
  return {
    x: cy * cz * local.x + (-cy * sz) * local.y + sy * local.z + position.x,
    y: (cx * sz + sx * sy * cz) * local.x + (cx * cz - sx * sy * sz) * local.y + (-sx * cy) * local.z + position.y,
    z: (sx * sz - cx * sy * cz) * local.x + (sx * cz + cx * sy * sz) * local.y + (cx * cy) * local.z + position.z,
  }
}

// Install the modeled body + its tracked bore origin, exactly as a real pick
// leaves the store (mirrors boreOriginBinding.wo294.test.ts).
function installTrackedBore(): { localCenter: Vec3; position: Vec3 } {
  const picked = resolveSetupBoreOriginPick(geo, 'F1', 'F1:wall', snapshot(), [hole()], basePlacements)
  const wcs = makeWcs({
    origin: picked.origin,
    snapGeoId: picked.snapGeoId, snapLocalPt: picked.snapLocalPt,
    originBinding: picked.originBinding,
  })
  installProject({ geometry: [geo], setups: [makeSetup(wcs)], modelItemPlacements: basePlacements })
  return { localCenter: { x: 10, y: 12, z: 10 }, position: { x: 5, y: -2, z: 7 } }
}

beforeEach(() => {
  installProject({})
})

describe('WO-1382: a tracked bore origin follows the full model placement', () => {
  it('tilted 30 deg about X, the WCS origin lands on the tilted hole centre (0.01 mm)', () => {
    const { localCenter, position } = installTrackedBore()
    const rotation: Vec3 = { x: 30, y: 0, z: 0 }

    useCamStore.getState().updateModelItemPlacement('legacy', undefined, position, rotation)

    const expected = expectImage(localCenter, position, rotation)
    const origin = currentWcs().origin
    expect(origin.x).toBeCloseTo(expected.x, 2)
    expect(origin.y).toBeCloseTo(expected.y, 2)
    expect(origin.z).toBeCloseTo(expected.z, 2)
    // Sanity: the tilt genuinely moved the origin off the pre-fix (z-only) result.
    expect(Math.abs(origin.z - (localCenter.z + position.z))).toBeGreaterThan(0.01)
  })

  it('tilted 30 deg about Y, the WCS origin lands on the tilted hole centre (0.01 mm)', () => {
    const { localCenter, position } = installTrackedBore()
    const rotation: Vec3 = { x: 0, y: 30, z: 0 }

    useCamStore.getState().updateModelItemPlacement('legacy', undefined, position, rotation)

    const expected = expectImage(localCenter, position, rotation)
    const origin = currentWcs().origin
    expect(origin.x).toBeCloseTo(expected.x, 2)
    expect(origin.y).toBeCloseTo(expected.y, 2)
    expect(origin.z).toBeCloseTo(expected.z, 2)
    expect(Math.abs(origin.x - (localCenter.x + position.x))).toBeGreaterThan(0.01)
  })

  it('a Z-only rotation still matches the pre-existing result', () => {
    const { localCenter, position } = installTrackedBore()

    useCamStore.getState().updateModelItemPlacement('legacy', undefined, position, { x: 0, y: 0, z: 90 })

    const origin = currentWcs().origin
    // R(90) about Z: x = -12, y = 10, z = 10 (matches wo294's own numbers).
    expect(origin.x).toBeCloseTo(-localCenter.y + position.x, 6)
    expect(origin.y).toBeCloseTo(localCenter.x + position.y, 6)
    expect(origin.z).toBeCloseTo(localCenter.z + position.z, 6)
  })
})
