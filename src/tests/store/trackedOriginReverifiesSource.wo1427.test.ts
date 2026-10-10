// WO-1427: a "Tracking" origin must re-check its source, not just re-apply the
// source's placement to numbers frozen at pick time.
//
// Drives the REAL store write paths:
//   - syncModelBodies (the Model regen writer) deleting or resizing a body,
//   - removeGeometry + undo for a vertex-picked part,
// and asserts the setup's binding is disclosed unresolved (origin kept as
// last-known), or re-derived from the CURRENT bore through the same
// derivation the pick used. The kernel face facts are injected through the
// module's own test seams (setModelBodyFaceSnapshotReader /
// setModelBodyHoleRecognizer), the same seams readModelBodyFaceFacts reads.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { FeatureVerdict } from '../../geom/geom-service'
import type { GeometrySnapshot } from '../../geom'
import type { ImportedGeometry, ModelBodyDisplay, Setup, WCS, Vec3 } from '../../types'
import { typedMock } from '../support/typedMock'

vi.mock('../../lib/stlCache', () => typedMock<typeof import('../../lib/stlCache')>({
  cacheSTL: vi.fn(async () => {}), loadCachedSTL: vi.fn(async () => null), removeCachedSTL: vi.fn(async () => {}),
}))
vi.mock('../../lib/stepCache', () => typedMock<typeof import('../../lib/stepCache')>({
  cacheStep: vi.fn(async () => {}), loadCachedStep: vi.fn(async () => null), removeCachedStep: vi.fn(async () => {}),
}))

import { installFakeIndexedDB, type FakeIndexedDBHandle } from '../helpers/fakeIndexedDB'

const { useCamStore, resolveSetupBoreOriginPick, describeOriginSource, ORIGIN_SOURCE_DELETED } = await import('../../store')
const { resetDocumentHolder } = await import('../../doc/documentHolder')
const { setModelBodyFaceSnapshotReader, setModelBodyHoleRecognizer } = await import('../../lib/cam/modelBodyHoleRecognition')

// -- Kernel facts for one bore on body F1 (wo294's known-good numbers) -----

let boreDiameter = 8
let faceAvailable = true

function snapshot(): GeometrySnapshot {
  return {
    type: 'cylinder', centroid: [10, 12, 7], normal: [1, 0, 0], area: 150,
    axis: [0, 0, 1], axisPoint: [10, 12, 0], radius: boreDiameter / 2,
  }
}

function hole(): FeatureVerdict {
  return {
    featureKey: 'hole:10:12:10:0:0:1:4',
    featureClass: 'blindHole', removable: true, effect: 'add',
    faceIds: ['F1:wall'], neighbourIds: [],
    params: {
      diameter: boreDiameter, depth: 6,
      axisX: 0, axisY: 0, axisZ: 1,
      centerX: 10, centerY: 12, centerZ: 10,
    },
  }
}

function display(): ModelBodyDisplay {
  return {
    positions: [], normals: [], indices: [], edgePositions: [], edgeOffsets: [],
    bbox: { min: [0, 0, 0], max: [30, 30, 10] },
    faceIds: ['F1:top', 'F1:wall'], triFace: [],
  }
}

function syncBody(version: number): void {
  useCamStore.getState().syncModelBodies({
    live: [{ bodyId: 'F1', name: 'Plate' }],
    derived: [{ bodyId: 'F1', version, stableIds: ['F1:top', 'F1:wall'], display: display() }],
  })
}

function bodyRow(): ImportedGeometry {
  const geo = useCamStore.getState().project.geometry.find((g) => g.modelBody?.ref.bodyId === 'F1')
  expect(geo).toBeDefined()
  return geo!
}

function makeWcs(over: Partial<WCS>): WCS {
  return {
    id: 'wcs-1', label: 'G54', fixtureOffset: 54,
    origin: { x: 0, y: 0, z: 0 },
    xAxis: { x: 1, y: 0, z: 0 }, yAxis: { x: 0, y: 1, z: 0 }, zAxis: { x: 0, y: 0, z: 1 },
    ...over,
  }
}

function installSetup(wcs: WCS): void {
  const setup: Setup = {
    id: 'setup-1', name: 'Setup 1', wcs,
    stock: { type: 'rectangular', offsetX: 0, offsetY: 0, offsetZTop: 0, offsetZBottom: 0, material: 'aluminum' },
    operations: [], notes: '',
  }
  useCamStore.setState((s) => ({ project: { ...s.project, setups: [setup], activeSetupId: 'setup-1' } }))
}

function currentWcs(): WCS {
  return useCamStore.getState().project.setups[0].wcs
}

function partFeature(wcs: WCS) {
  const binding = wcs.originBinding
  if (binding?.kind !== 'part_feature') throw new Error(`expected a part_feature binding, got ${binding?.kind}`)
  return binding
}

const PLACEMENT: Vec3 = { x: 5, y: -2, z: 7 }

// Seed body F1, pick its bore as the setup origin exactly as SetupModal does,
// then move the item so the origin carries a real Placement.
function installTrackedBore(): void {
  syncBody(1)
  const picked = resolveSetupBoreOriginPick(
    bodyRow(), 'F1', 'F1:wall', snapshot(), [hole()], useCamStore.getState().project.modelItemPlacements ?? [],
  )
  installSetup(makeWcs({
    origin: picked.origin,
    snapGeoId: picked.snapGeoId, snapLocalPt: picked.snapLocalPt,
    originBinding: picked.originBinding,
  }))
  useCamStore.getState().updateModelItemPlacement('legacy', undefined, PLACEMENT, { x: 0, y: 0, z: 0 })
}

async function waitUntil(pred: () => boolean, what: string, ms = 5000): Promise<void> {
  const t0 = Date.now()
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`)
    await new Promise((r) => setTimeout(r, 5))
  }
}

let idb: FakeIndexedDBHandle
beforeEach(() => {
  resetDocumentHolder()
  idb = installFakeIndexedDB()
  vi.clearAllMocks()
  useCamStore.getState().newProject()
  boreDiameter = 8
  faceAvailable = true
  setModelBodyFaceSnapshotReader(async () => (faceAvailable ? snapshot() : undefined))
  setModelBodyHoleRecognizer(async () => [hole()])
})
afterEach(() => {
  setModelBodyFaceSnapshotReader(null)
  setModelBodyHoleRecognizer(null)
  idb.restore()
})

describe('WO-1427: a tracked origin re-verifies its source', () => {
  it('deleting the body a bore origin is bound to discloses the binding unresolved, origin kept', () => {
    installTrackedBore()
    const before = currentWcs()
    expect(partFeature(before).sourceUnresolved).toBeUndefined()

    // The Model tab deletes the body: the regen writer drops its row.
    useCamStore.getState().syncModelBodies({ live: [], derived: [] })
    expect(useCamStore.getState().project.geometry.some((g) => g.modelBody?.ref.bodyId === 'F1')).toBe(false)

    const after = currentWcs()
    const binding = partFeature(after)
    expect(binding.sourceUnresolved).toBe(ORIGIN_SOURCE_DELETED)
    expect(binding.featureRef).toEqual(partFeature(before).featureRef)
    expect(after.origin).toEqual(before.origin)
    const status = describeOriginSource(
      useCamStore.getState().project.geometry, binding.geoId, binding.featureRef.kind, binding.sourceUnresolved,
    )
    expect(status.state).toBe('unresolved')
  })

  it('deleting a vertex-picked part discloses unresolved, and undo restores the exact prior binding', () => {
    const part = {
      id: 'geo-v', name: 'Bracket', filename: 'bracket.svg', type: 'curves_2d', format: 'svg',
      loaded: true, position: { x: 3, y: 4, z: 0 }, rotation: { x: 0, y: 0, z: 0 },
      boundingBox: {
        min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 30, z: 0 },
        size: { x: 40, y: 30, z: 0 }, center: { x: 20, y: 15, z: 0 },
      },
    } as ImportedGeometry
    useCamStore.setState((s) => ({ project: { ...s.project, geometry: [part] } }))
    const localPt = { x: 40, y: 0, z: 0 }
    installSetup(makeWcs({
      origin: { x: 43, y: 4, z: 0 },
      snapGeoId: 'geo-v', snapLocalPt: localPt,
      originBinding: { kind: 'part_feature', geoId: 'geo-v', featureRef: { kind: 'vertex', localPt } },
    }))
    const priorBinding = structuredClone(currentWcs().originBinding)

    useCamStore.getState().removeGeometry('geo-v')

    const binding = partFeature(currentWcs())
    // Literal, not the exported constant: on a store without WO-1427 both
    // would be undefined and this line would pass vacuously.
    expect(binding.sourceUnresolved).toBe('the part it was picked on is no longer in the project')
    expect(ORIGIN_SOURCE_DELETED).toBe(binding.sourceUnresolved)
    expect(currentWcs().origin).toEqual({ x: 43, y: 4, z: 0 })

    useCamStore.getState().undo()

    expect(useCamStore.getState().project.geometry.some((g) => g.id === 'geo-v')).toBe(true)
    expect(currentWcs().originBinding).toEqual(priorBinding)
  })

  it('resizing the bound bore with no placement move updates the origin diameter through the regen', async () => {
    installTrackedBore()
    const before = partFeature(currentWcs())
    expect(before.featureRef.kind).toBe('bore_center')
    expect((before.featureRef as { diameter: number }).diameter).toBeCloseTo(8, 6)

    // Model tab: the bore's diameter dimension goes 8 -> 12, nothing moves.
    boreDiameter = 12
    syncBody(2)

    await waitUntil(
      () => (partFeature(currentWcs()).featureRef as { diameter: number }).diameter > 11,
      'the bore origin to re-read the resized face',
    )
    const after = currentWcs()
    const binding = partFeature(after)
    const fr = binding.featureRef as { diameter: number; localCenter: Vec3 }
    expect(fr.diameter).toBeCloseTo(12, 6)
    expect(binding.sourceUnresolved).toBeUndefined()
    expect(fr.localCenter.x).toBeCloseTo(10, 6)
    expect(fr.localCenter.y).toBeCloseTo(12, 6)
    expect(fr.localCenter.z).toBeCloseTo(10, 6)
    expect(after.origin.x).toBeCloseTo(10 + PLACEMENT.x, 6)
    expect(after.origin.y).toBeCloseTo(12 + PLACEMENT.y, 6)
    expect(after.origin.z).toBeCloseTo(10 + PLACEMENT.z, 6)
    const status = describeOriginSource(
      useCamStore.getState().project.geometry, binding.geoId, binding.featureRef.kind, binding.sourceUnresolved,
    )
    expect(status.state).toBe('tracking')
  })

  it('a regen after which the bound face can no longer be read discloses unresolved, never Tracking', async () => {
    installTrackedBore()
    const originBefore = currentWcs().origin

    faceAvailable = false
    syncBody(2)

    await waitUntil(() => partFeature(currentWcs()).sourceUnresolved !== undefined, 'the unresolved mark')
    expect(currentWcs().origin).toEqual(originBefore)
    const binding = partFeature(currentWcs())
    expect(describeOriginSource(
      useCamStore.getState().project.geometry, binding.geoId, binding.featureRef.kind, binding.sourceUnresolved,
    ).state).toBe('unresolved')
  })
})
