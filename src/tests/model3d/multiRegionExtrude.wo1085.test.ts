import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import { BASE_PLANE_FRAMES } from '../../components/model3d/workbench/basePlanes'
import { extractSketchProfile } from '../../components/model3d/workbench/sketchProfile'
import { regionProfileSelector, resolveProfileSelector } from '../../components/model3d/workbench/regionSelector'

function sketch(id: string, entities: SketchEntity[]): Sketch {
  return { id, layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null }
}

function rectangle(width: number, height: number): SketchEntity[] {
  return [
    { id: 'plate-1', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: width, y: 0 } },
    { id: 'plate-2', kind: 'line', construction: false, start: { x: width, y: 0 }, end: { x: width, y: height } },
    { id: 'plate-3', kind: 'line', construction: false, start: { x: width, y: height }, end: { x: 0, y: height } },
    { id: 'plate-4', kind: 'line', construction: false, start: { x: 0, y: height }, end: { x: 0, y: 0 } },
  ]
}

describe('WO-1085 real-kernel multi-region Remove', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('cuts only three picked circles from seven, with the expected volume and three recognized holes', async () => {
    const plateDepth = 20
    const cutDepth = 15
    const radius = 3
    const centers = [
      [15, 15], [40, 15], [65, 15], [85, 15],
      [25, 50], [50, 50], [75, 50],
    ] as const
    const circles: SketchEntity[] = centers.map(([x, y], index) => ({
      id: `circle-${index + 1}`,
      kind: 'circle',
      construction: false,
      center: { x, y },
      radius,
    }))

    const plateProfile = await extractSketchProfile(sketch('PLATE', rectangle(100, 80)), BASE_PLANE_FRAMES.xy, 'PLATE')
    const holeProfiles = await extractSketchProfile(sketch('HOLES', circles), BASE_PLANE_FRAMES.xy, 'HOLES')
    expect(plateProfile.ok).toBe(true)
    expect(holeProfiles.ok).toBe(true)
    if (!plateProfile.ok || !holeProfiles.ok) return
    expect(holeProfiles.regions).toHaveLength(7)

    const picked = [holeProfiles.regions[0], holeProfiles.regions[2], holeProfiles.regions[5]]
    const selector = {
      kind: 'regions' as const,
      regions: picked.map((region) => {
        const single = regionProfileSelector(region, holeProfiles.regions)
        if (single.kind !== 'region') throw new Error('expected one region selector')
        return { signature: single.signature, ...(single.ordinal === undefined ? {} : { ordinal: single.ordinal }) }
      }),
    }
    const resolved = resolveProfileSelector(holeProfiles.regions, selector)
    expect(resolved.ok).toBe(true)
    if (!resolved.ok) return

    const plate = await engine.makeExtrude({
      featureId: 'PLATE-EXTRUDE',
      profiles: plateProfile.regions,
      end: { kind: 'blind', distance: plateDepth },
      op: 'newBody',
    })
    expect(plate.ok).toBe(true)
    if (!plate.ok || plate.body === undefined) return

    const cut = await engine.makeExtrude({
      featureId: 'THREE-HOLE-CUT',
      profiles: resolved.profiles,
      end: { kind: 'blind', distance: cutDepth },
      op: 'cut',
      target: plate.body,
    })
    expect(cut.ok).toBe(true)
    if (!cut.ok || cut.body === undefined) return

    const volume = await engine.measure(cut.body, 'volume')
    const expectedVolume = 100 * 80 * plateDepth - 3 * Math.PI * radius * radius * cutDepth
    expect(Math.abs(volume.value - expectedVolume) / expectedVolume).toBeLessThan(0.001)

    const holes = (await engine.recognizeFeatures(cut.body)).filter((feature) =>
      feature.featureClass === 'blindHole' ||
      feature.featureClass === 'throughHole' ||
      feature.featureClass === 'counterboreStack',
    )
    expect(holes).toHaveLength(3)

    await engine.dispose(cut.body)
    await engine.dispose(plate.body)
  }, 60_000)
})
