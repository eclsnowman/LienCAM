import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createLocalGeomService } from '../../geom/index.ts'
import type { FeatureVerdict, FilletRequest } from '../../geom/geom-service.ts'

interface ImportedFilletRequest extends FilletRequest {
  importedFeatureKey: string
}

function fixtureBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(path)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

function importedPocketFillets(verdicts: FeatureVerdict[]): FeatureVerdict[] {
  return verdicts.filter((verdict) =>
    verdict.removable &&
    verdict.featureKey.startsWith('absorbed:') &&
    verdict.featureClass.startsWith('fillet') &&
    typeof verdict.params.radius === 'number',
  )
}

describe('WO-2078 imported STEP fillet radius change', () => {
  let client: ReturnType<typeof createLocalGeomService>

  beforeAll(async () => {
    client = createLocalGeomService()
    await client.init()
  }, 60_000)

  afterAll(async () => {
    await client.disposeAll()
  })

  it('replaces one fix_block_pocket corner fillet at the analytic volume delta and leaves every unrelated edge id unchanged', async () => {
    const imported = await client.importStep(
      fixtureBytes(join(process.cwd(), 'test_fixtures/brep/fix_block_pocket.step')),
      'FIX-POCKET',
    )
    expect(imported.bodies.length, JSON.stringify(imported.diagnostics)).toBe(1)
    const body = imported.bodies[0].handle
    const beforeVerdicts = await client.recognizeFeatures(body)
    const target = importedPocketFillets(beforeVerdicts)[0]
    expect(target, JSON.stringify(beforeVerdicts, null, 2)).toBeDefined()

    const oldRadius = Number(target.params.radius)
    const newRadius = oldRadius + 0.5
    const targetFaceId = target.faceIds[0]
    const bandArea = Number(target.params.area)
    const filletLength = bandArea / (Math.PI * oldRadius / 2)
    const expectedVolumeDelta = filletLength * (1 - Math.PI / 4) * (newRadius ** 2 - oldRadius ** 2)
    const beforeVolume = (await client.measure(body, 'volume')).value
    const beforeEdges = (await client.tessellate(body, { deflection: 0.1 })).edgeIds

    const request: ImportedFilletRequest = {
      featureId: 'FILLET-CHANGE',
      body,
      edges: [targetFaceId],
      radius: newRadius,
      propagateTangent: true,
      importedFeatureKey: target.featureKey,
    }
    const changed = await client.applyFillet(request)
    expect(changed.ok, JSON.stringify(changed.diagnostics, null, 2)).toBe(true)
    expect(changed.body).toBeDefined()

    const afterVolume = (await client.measure(changed.body!, 'volume')).value
    expect(afterVolume - beforeVolume).toBeCloseTo(expectedVolumeDelta, 2)

    const afterEdges = (await client.tessellate(changed.body!, { deflection: 0.1 })).edgeIds
    const unrelated = (ids: readonly string[]) => [...ids].filter((id) => !id.includes(targetFaceId)).sort()
    expect(unrelated(afterEdges)).toEqual(unrelated(beforeEdges))

    const afterVerdicts = await client.recognizeFeatures(changed.body!)
    const changedTarget = afterVerdicts.find((verdict) => verdict.faceIds.includes(targetFaceId))
    expect(changedTarget?.params.radius).toBeCloseTo(newRadius, 6)
  }, 120_000)
})
