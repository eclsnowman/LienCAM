// CAM-DRILL-ADAPTER: deriveModelBodyDrillTargets unit tests.
//
// HOW IT CAN FAIL (mutation-proof):
// 1. Drop world Placement bake (skip transformLoopPoints on centers) ->
//    translated-placement test expects centers shifted by +position.
// 2. Accept zero hole verdicts silently (return empty instead of throw) ->
//    no-holes refusal test fails.
// 3. Skip Z-axis tilt refusal on a hole angle -> tilted-axis refusal fails
//    (or centres wrong).
//
// Real-kernel fixture uses GeomEngine with through + blind holes on one plate.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import type { FeatureVerdict } from '../../geom/geom-service'
import {
  deriveModelBodyDrillTargets,
  ModelBodyDeriveError,
} from '../../lib/cam/modelBodyDerive'
import type { ImportedGeometry, ModelItemPlacementRecord, Vec3, BoundingBox } from '../../types'

function bbox(min: Vec3, max: Vec3): BoundingBox {
  return {
    min: { ...min }, max: { ...max },
    size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
    center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
  }
}

function modelGeo(id: string, bodyId: string): ImportedGeometry {
  return {
    id,
    name: id,
    filename: '',
    type: 'model',
    format: 'model',
    boundingBox: bbox({ x: 0, y: 0, z: 0 }, { x: 40, y: 20, z: 10 }),
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    loaded: true,
    modelItemId: 'legacy',
    modelBody: {
      ref: { bodyId, stableIds: [`${bodyId}:F0`], version: 1 },
      display: {
        positions: [0, 0, 0, 40, 0, 0, 40, 20, 0, 0, 20, 0],
        normals: [],
        indices: [0, 1, 2, 0, 2, 3],
        edgePositions: [],
        edgeOffsets: [],
        bbox: { min: [0, 0, 0], max: [40, 20, 10] },
      },
    },
  } as unknown as ImportedGeometry
}

const identityPlacement: ModelItemPlacementRecord[] = [
  { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } },
]

function syntheticVerdict(partial: Partial<FeatureVerdict> & Pick<FeatureVerdict, 'featureKey' | 'featureClass'>): FeatureVerdict {
  const baseParams: Record<string, number | string> = {
    diameter: 6,
    depth: 5,
    axisX: 0,
    axisY: 0,
    axisZ: 1,
    centerX: 10,
    centerY: 10,
    centerZ: 10,
    ...(partial.params ?? {}),
  }
  return {
    removable: true,
    effect: 'add',
    faceIds: [`face:${partial.featureKey}`],
    neighbourIds: [],
    ...partial,
    params: baseParams,
  }
}

describe('deriveModelBodyDrillTargets (CAM-DRILL-ADAPTER)', () => {
  it('maps two synthetic holes (through + blind) to centres, diameters, topZ bottoms', () => {
    const geo = modelGeo('g1', 'body-1')
    const verdicts: FeatureVerdict[] = [
      syntheticVerdict({
        featureKey: 'hole:10:5:10:0:0:1:3',
        featureClass: 'throughHole',
        params: { diameter: 6, depth: 10, axisX: 0, axisY: 0, axisZ: 1, centerX: 10, centerY: 5, centerZ: 10 },
        faceIds: ['F:through'],
      }),
      syntheticVerdict({
        featureKey: 'hole:30:15:10:0:0:1:2',
        featureClass: 'blindHole',
        params: { diameter: 4, depth: 5, axisX: 0, axisY: 0, axisZ: 1, centerX: 30, centerY: 15, centerZ: 10 },
        faceIds: ['F:blind'],
      }),
    ]
    const r = deriveModelBodyDrillTargets(geo, identityPlacement, verdicts)
    expect(r.targets).toHaveLength(2)
    const through = r.targets.find((t) => t.featureClass === 'throughHole')!
    const blind = r.targets.find((t) => t.featureClass === 'blindHole')!
    expect(through.centerX).toBeCloseTo(10, 5)
    expect(through.centerY).toBeCloseTo(5, 5)
    expect(through.diameter).toBeCloseTo(6, 5)
    expect(through.through).toBe(true)
    expect(through.topZ).toBeCloseTo(10, 5)
    expect(through.bottomZ).toBeCloseTo(0, 5)
    expect(blind.centerX).toBeCloseTo(30, 5)
    expect(blind.diameter).toBeCloseTo(4, 5)
    expect(blind.through).toBe(false)
    expect(blind.topZ).toBeCloseTo(10, 5)
    expect(blind.bottomZ).toBeCloseTo(5, 5)
    expect(r.loops).toHaveLength(2)
    expect(r.holes).toHaveLength(2)
    expect(r.z).toBeCloseTo(10, 5)
  })

  it('bakes world Placement translation into centre XY and Z', () => {
    const geo = modelGeo('g-move', 'body-move')
    const placements: ModelItemPlacementRecord[] = [
      { modelItemId: 'legacy', position: { x: 100, y: 50, z: 20 }, rotation: { x: 0, y: 0, z: 0 } },
    ]
    const verdicts = [
      syntheticVerdict({
        featureKey: 'hole:10:10:10:0:0:1:3',
        featureClass: 'blindHole',
        params: { diameter: 6, depth: 5, axisX: 0, axisY: 0, axisZ: 1, centerX: 10, centerY: 10, centerZ: 10 },
      }),
    ]
    const r = deriveModelBodyDrillTargets(geo, placements, verdicts)
    expect(r.targets[0].centerX).toBeCloseTo(110, 5)
    expect(r.targets[0].centerY).toBeCloseTo(60, 5)
    expect(r.targets[0].topZ).toBeCloseTo(30, 5)
    expect(r.targets[0].bottomZ).toBeCloseTo(25, 5)
  })

  it('refuses non-model geometry (ADR-0003)', () => {
    const geo = {
      ...modelGeo('g', 'b'),
      format: 'step',
      type: 'brep',
    } as unknown as ImportedGeometry
    expect(() => deriveModelBodyDrillTargets(geo, identityPlacement, [])).toThrow(ModelBodyDeriveError)
  })

  it('refuses when recognition found no drillable holes', () => {
    const geo = modelGeo('g-empty', 'body-empty')
    expect(() => deriveModelBodyDrillTargets(geo, identityPlacement, [])).toThrow(/no drill targets/i)
  })

  it('refuses tilted hole axes', () => {
    const geo = modelGeo('g-tilt', 'body-tilt')
    const verdicts = [
      syntheticVerdict({
        featureKey: 'hole:10:10:10:0.7:0:0.7:3',
        featureClass: 'blindHole',
        params: { diameter: 6, depth: 5, axisX: 0.7, axisY: 0, axisZ: 0.7, centerX: 10, centerY: 10, centerZ: 10 },
      }),
    ]
    expect(() => deriveModelBodyDrillTargets(geo, identityPlacement, verdicts)).toThrow(/tilted off Z|no drill targets/i)
  })

  it('refuses tilted Model Item Placement', () => {
    const geo = modelGeo('g-pl', 'body-pl')
    const placements: ModelItemPlacementRecord[] = [
      { modelItemId: 'legacy', position: { x: 0, y: 0, z: 0 }, rotation: { x: 30, y: 0, z: 0 } },
    ]
    const verdicts = [
      syntheticVerdict({ featureKey: 'hole:1:1:1:0:0:1:1', featureClass: 'blindHole' }),
    ]
    expect(() => deriveModelBodyDrillTargets(geo, placements, verdicts)).toThrow(/tilted/i)
  })

  it('parses centre from featureKey when params omit centerX', () => {
    const geo = modelGeo('g-key', 'body-key')
    const verdicts: FeatureVerdict[] = [{
      featureKey: 'hole:12.5:7.25:10:0:0:1:3',
      featureClass: 'throughHole',
      removable: true,
      effect: 'add',
      faceIds: ['F1'],
      neighbourIds: [],
      params: { diameter: 6, depth: 10, axisX: 0, axisY: 0, axisZ: 1 },
    }]
    const r = deriveModelBodyDrillTargets(geo, identityPlacement, verdicts)
    expect(r.targets[0].centerX).toBeCloseTo(12.5, 5)
    expect(r.targets[0].centerY).toBeCloseTo(7.25, 5)
  })
})

describe('deriveModelBodyDrillTargets real kernel fixture (through + blind)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('recognizes through + blind holes on one plate and maps both targets', async () => {
    const box = (await engine.makeBox('F1', { x: 40, y: 20, z: 10 })).body!
    const top = 'F1:BOX:zMax'
    const through = await engine.makeHole({
      featureId: 'H-THRU',
      body: box,
      face: top,
      points: [{ x: 10, y: 10, z: 10 }],
      style: { kind: 'simple', diameter: 6 },
      depth: { kind: 'throughAll' },
    })
    expect(through.ok).toBe(true)
    const both = await engine.makeHole({
      featureId: 'H-BLIND',
      body: through.body!,
      face: top,
      points: [{ x: 30, y: 10, z: 10 }],
      style: { kind: 'simple', diameter: 4 },
      depth: { kind: 'blind', distance: 5 },
    })
    expect(both.ok).toBe(true)
    const verdicts = await engine.recognizeFeatures(both.body!)
    const holeClasses = verdicts.filter((v) =>
      v.featureClass === 'throughHole' || v.featureClass === 'blindHole' || v.featureClass === 'counterboreStack',
    )
    expect(holeClasses.length).toBeGreaterThanOrEqual(2)

    const geo = modelGeo('kernel-plate', 'kernel-body')
    const r = deriveModelBodyDrillTargets(geo, identityPlacement, verdicts)
    expect(r.targets.length).toBeGreaterThanOrEqual(2)
    const hasThrough = r.targets.some((t) => t.through)
    const hasBlind = r.targets.some((t) => !t.through)
    expect(hasThrough).toBe(true)
    expect(hasBlind).toBe(true)
    for (const t of r.targets) {
      expect(t.diameter).toBeGreaterThan(0)
      expect(t.topZ).toBeGreaterThan(t.bottomZ)
      expect(Number.isFinite(t.centerX)).toBe(true)
      expect(Number.isFinite(t.centerY)).toBe(true)
    }
    await engine.disposeAll()
  }, 90_000)
})
