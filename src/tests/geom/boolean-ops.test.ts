import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

describe('GeomEngine Boolean Union and Intersect', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('produces valid bodies with FUS/INT lineage and honest volumes', async () => {
    const target = (await engine.makeBox('BU1', { x: 40, y: 20, z: 10 })).body!
    const tool = (await engine.makeBox('BU2', { x: 10, y: 10, z: 20 })).body!

    const union = await engine.applyBoolean({ featureId: 'BUF', op: 'fuse', target, tools: [tool] })
    expect(union.ok).toBe(true)
    expect(union.body).toBeDefined()
    expect(union.elementMap?.featureId).toBe('BUF')
    expect(union.elementMap?.generated.some((id) => id.startsWith('BUF:FUS:'))).toBe(true)
    expect((await engine.measure(union.body!, 'volume')).value).toBeCloseTo(9_000, 2)

    const intersection = await engine.applyBoolean({ featureId: 'BUI', op: 'intersect', target, tools: [tool] })
    expect(intersection.ok).toBe(true)
    expect(intersection.body).toBeDefined()
    expect(intersection.elementMap?.featureId).toBe('BUI')
    expect(intersection.elementMap?.generated.some((id) => id.startsWith('BUI:INT:'))).toBe(true)
    expect((await engine.measure(intersection.body!, 'volume')).value).toBeCloseTo(1_000, 2)

    await engine.disposeAll()
  }, 60_000)
})
