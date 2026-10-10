import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import type { ImportedGeometry, ModelItemPlacementRecord } from '../../types'
import type { ProfileRegion } from '../../geom/geom-service'
import { deriveModelBodyCircularOrigin } from '../../lib/cam/modelBodyDerive'
import { xyPlane } from '../geom/fixtures/profiles'

describe('WO-391 circular boss setup-origin endpoints', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('derives Top from the boss cap and Bottom from the boss-to-plate seam', async () => {
    const base = (await engine.makeBox('PLATE', { x: 40, y: 40, z: 10 })).body!
    const profile: ProfileRegion = {
      sketchId: 'ROUND_BOSS',
      plane: xyPlane(10),
      loops: [[{
        kind: 'arc', c: [20, 20], r: 6, a0: 0, a1: Math.PI * 2, ccw: true, srcId: 'ROUND_BOSS.c0',
      }]],
    }
    const body = (await engine.makeExtrude({
      featureId: 'ROUND_BOSS',
      profiles: [profile],
      end: { kind: 'blind', distance: 6 },
      op: 'add',
      target: base,
    })).body!

    const [verdicts, snapshots, tessellation] = await Promise.all([
      engine.recognizeFeatures(body),
      Promise.resolve(engine.snapshotsFor(body)),
      engine.tessellate(body, { deflection: 0.1 }),
    ])
    const boss = verdicts.find((verdict) => verdict.featureClass === 'boss')
    expect(boss).toBeDefined()
    const wallId = boss!.faceIds.find((faceId) => snapshots[faceId]?.type === 'cylinder')
    expect(wallId).toBeDefined()

    const positions = Array.from(tessellation.position)
    const display = {
      positions,
      normals: Array.from(tessellation.normal),
      indices: Array.from(tessellation.index),
      edgePositions: Array.from(tessellation.edgePositions),
      edgeOffsets: Array.from(tessellation.edgeOffsets),
      edgeIds: [...tessellation.edgeIds],
      faceIds: [...tessellation.faceIds],
      triFace: Array.from(tessellation.triFace),
      bbox: {
        min: [
          Math.min(...positions.filter((_value, index) => index % 3 === 0)),
          Math.min(...positions.filter((_value, index) => index % 3 === 1)),
          Math.min(...positions.filter((_value, index) => index % 3 === 2)),
        ] as [number, number, number],
        max: [
          Math.max(...positions.filter((_value, index) => index % 3 === 0)),
          Math.max(...positions.filter((_value, index) => index % 3 === 1)),
          Math.max(...positions.filter((_value, index) => index % 3 === 2)),
        ] as [number, number, number],
      },
    }

    const geometry = {
      id: 'modelbody:ROUND_BOSS',
      name: 'Round boss on plate',
      filename: '',
      type: 'model',
      format: 'model',
      loaded: true,
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
      boundingBox: { min: { x: 0, y: 0, z: 0 }, max: { x: 40, y: 40, z: 16 } },
      modelItemId: 'round-boss-item',
      modelBody: {
        ref: { bodyId: 'ROUND_BOSS', stableIds: display.faceIds, version: 1 },
        display,
      },
    } as unknown as ImportedGeometry
    const placements: ModelItemPlacementRecord[] = [{
      modelItemId: 'round-boss-item',
      position: { x: 0, y: 0, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    }]

    expect(deriveModelBodyCircularOrigin(
      geometry,
      placements,
      wallId!,
      snapshots[wallId!],
      verdicts,
    )).toEqual({
      faceKind: 'boss',
      center: [20, 20],
      topZ: 16,
      bottomZ: 10,
      diameter: 12,
    })

    await engine.disposeAll()
  }, 60_000)
})
