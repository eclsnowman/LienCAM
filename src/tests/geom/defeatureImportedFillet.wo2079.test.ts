import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BodyHandle, FeatureVerdict } from '../../geom/geom-service.ts'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

function fixtureBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(path)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

describe('WO-2079 imported STEP fillet removal', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  async function importOne(path: string, id: string): Promise<BodyHandle> {
    const result = await engine.importStep(fixtureBytes(path), id)
    expect(result.bodies.length, JSON.stringify(result.diagnostics)).toBe(1)
    return result.bodies[0].handle
  }

  function absorbedFillets(verdicts: FeatureVerdict[]): FeatureVerdict[] {
    return verdicts.filter((v) =>
      v.featureClass.startsWith('fillet') && typeof v.params.absorbedBy === 'string',
    )
  }

  it('removes one bspline pocket fillet from Step Test With Holes while the pocket stays', async () => {
    const body = await importOne(
      join(process.cwd(), 'src/tests/geom/fixtures/step-test-with-holes.step'),
      'STEP-HOLES',
    )
    const before = await engine.recognizeFeatures(body)
    const pocket = before.find((v) => v.featureClass === 'pocket')
    const absorbed = absorbedFillets(before)
    const fillets = absorbed.filter((v) => v.removable)

    expect(pocket).toBeDefined()
    expect(absorbed.length).toBe(4)
    expect(fillets.length, JSON.stringify(absorbed, null, 2)).toBe(2)
    expect(absorbed.filter((v) => !v.removable).length).toBe(2)
    expect(fillets.every((v) => v.effect === 'add')).toBe(true)

    const target = fillets[0]
    const removed = await engine.defeatureBatch({
      featureId: 'DF-STEP-HOLES',
      body,
      featureKeys: [target.featureKey],
    })
    expect(removed.ok, JSON.stringify({ diagnostics: removed.diagnostics, report: removed.report }, null, 2)).toBe(true)
    expect(removed.report).toMatchObject({ requested: 1, healed: 1, failed: 0, refused: 0 })

    const after = await engine.recognizeFeatures(removed.body!)
    expect(after.some((v) => v.featureClass === 'pocket')).toBe(true)
    expect(absorbedFillets(after).length).toBe(3)
    expect(Math.abs(removed.report!.totalVolumeDelta)).toBeGreaterThan(1e-6)
    expect((await engine.measure(removed.body!, 'volume')).value).not.toBe((await engine.measure(body, 'volume')).value)
    await engine.disposeAll()
  }, 120_000)

  it('removes one pocket corner fillet from fix_block_pocket while the pocket stays', async () => {
    const body = await importOne(
      join(process.cwd(), 'test_fixtures/brep/fix_block_pocket.step'),
      'FIX-POCKET',
    )
    const before = await engine.recognizeFeatures(body)
    const pocket = before.find((v) => v.featureClass === 'pocket')
    const fillets = absorbedFillets(before)

    expect(pocket).toBeDefined()
    expect(fillets.length, JSON.stringify(before, null, 2)).toBeGreaterThan(0)
    expect(fillets.every((v) => v.removable), JSON.stringify(fillets, null, 2)).toBe(true)
    expect(fillets.every((v) => v.effect === 'remove')).toBe(true)

    const target = fillets[0]
    const removed = await engine.defeatureBatch({
      featureId: 'DF-FIX-POCKET',
      body,
      featureKeys: [target.featureKey],
    })
    expect(removed.ok, JSON.stringify({ diagnostics: removed.diagnostics, report: removed.report }, null, 2)).toBe(true)
    expect(removed.report).toMatchObject({ requested: 1, healed: 1, failed: 0, refused: 0 })

    const after = await engine.recognizeFeatures(removed.body!)
    expect(after.some((v) => v.featureClass === 'pocket')).toBe(true)
    expect(absorbedFillets(after).length).toBeLessThan(fillets.length)
    expect(Math.abs(removed.report!.totalVolumeDelta)).toBeGreaterThan(1e-6)
    expect((await engine.measure(removed.body!, 'volume')).value).not.toBe((await engine.measure(body, 'volume')).value)
    await engine.disposeAll()
  }, 120_000)
})
