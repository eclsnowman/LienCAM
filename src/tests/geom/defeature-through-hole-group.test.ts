import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

describe('Defeature recognized through-hole group', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('a clicked through-hole verdict heals its complete face group and preserves unrelated walls', async () => {
    const box = await engine.makeBox('F1', { x: 30, y: 20, z: 10 })
    expect(box.ok).toBe(true)
    const originalVolume = (await engine.measure(box.body!, 'volume')).value

    const holed = await engine.makeHole({
      featureId: 'H1',
      body: box.body!,
      face: 'F1:BOX:zMax',
      points: [{ x: 15, y: 10, z: 10 }],
      style: { kind: 'simple', diameter: 6 },
      depth: { kind: 'throughAll' },
    })
    expect(holed.ok).toBe(true)

    const verdicts = await engine.recognizeFeatures(holed.body!)
    const hole = verdicts.find((verdict) => verdict.featureClass === 'throughHole')
    expect(hole).toBeDefined()
    expect(hole!.removable).toBe(true)
    expect(hole!.faceIds.length).toBeGreaterThan(0)

    const deleted = await engine.defeatureBatch({
      featureId: 'DF1',
      body: holed.body!,
      featureKeys: [hole!.featureKey],
    })
    expect(deleted.ok, JSON.stringify(deleted.diagnostics)).toBe(true)
    expect(deleted.report).toMatchObject({
      requested: 1,
      healed: 1,
      failed: 0,
      refused: 0,
    })
    expect(deleted.report!.items[0]).toMatchObject({
      featureKey: hole!.featureKey,
      featureClass: 'throughHole',
      healed: true,
      effect: 'add',
    })
    expect(deleted.report!.totalVolumeDelta).toBeGreaterThan(0)
    expect(Math.abs((await engine.measure(deleted.body!, 'volume')).value - originalVolume)).toBeLessThan(1e-3)

    const [side] = await engine.resolve(deleted.body!, ['F1:BOX:xMin'])
    expect(side.status).not.toBe('lost')
    expect((await engine.recognizeFeatures(deleted.body!)).some((verdict) => verdict.featureClass === 'throughHole')).toBe(false)
    await engine.disposeAll()
  }, 60_000)
})
