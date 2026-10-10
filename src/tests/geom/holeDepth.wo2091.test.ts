// WO-2091 - change a recognized hole's depth on an imported STEP body.
// Tier 2 behaviour through the production GeomEngine import/recognize/edit path
// on the real occt-wasm kernel: test_fixtures/brep/fix_plate_holes.step is a
// 10 mm plate with six through holes (Ø6, Ø10, Ø3), entries on the top face.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { BodyHandle, FeatureVerdict, OpResult } from '../../geom/geom-service.ts'
import { GeomEngine, type HoleDepthEditRequest } from '../../geom/worker/geom-engine.ts'

const FIXTURE = join(process.cwd(), 'test_fixtures/brep/fix_plate_holes.step')
// Matched by x:y only: a through hole's key may name either opening.
const HOLE_D10 = 'hole:30:40:'
const HOLE_D6 = 'hole:20:20:'

function fixtureBytes(): ArrayBuffer {
  const bytes = readFileSync(FIXTURE)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

const cylinder = (diameter: number, length: number): number => Math.PI * (diameter / 2) ** 2 * length

describe('WO-2091 hole depth edit (real occt-wasm kernel)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeAll()
    await engine.disposeKernel()
  })

  const volume = async (body: BodyHandle): Promise<number> => (await engine.measure(body, 'volume')).value
  const holeAt = async (body: BodyHandle, prefix: string): Promise<FeatureVerdict> => {
    const hole = (await engine.recognizeFeatures(body)).find((v) => v.featureKey.startsWith(prefix))
    expect(hole, `hole ${prefix} must be recognized`).toBeDefined()
    return hole!
  }
  const editDepth = (body: BodyHandle, hole: FeatureVerdict, id: string, edit: { delta?: number; through?: boolean }): Promise<OpResult> => {
    const req: HoleDepthEditRequest = { featureId: id, body, featureKey: hole.featureKey, kind: 'holeDepth', delta: edit.delta ?? 0, ...(edit.through ? { through: true } : {}) }
    return engine.editFeature(req)
  }

  it('makes a through hole blind at 5 mm, deepens it 5 -> 8 mm, cuts it back through; the source body is untouched (Undo)', async () => {
    const imported = await engine.importStep(fixtureBytes(), 'WO2091')
    expect(imported.bodies).toHaveLength(1)
    const source = imported.bodies[0].handle
    const v0 = await volume(source)
    const through = await holeAt(source, HOLE_D10)
    expect(through.featureClass).toBe('throughHole')
    expect(Number(through.params.depth)).toBeCloseTo(10, 3)

    // through -> blind at 5 mm: material comes back below the new floor.
    const r1 = await editDepth(source, through, 'D1', { delta: 5 - 10 })
    expect(r1.ok, JSON.stringify(r1.diagnostics)).toBe(true)
    const b1 = r1.body!
    expect(await volume(b1) - v0).toBeCloseTo(cylinder(10, 5), 2)
    const blind5 = await holeAt(b1, HOLE_D10)
    expect(blind5.featureClass).toBe('blindHole')
    expect(Number(blind5.params.depth)).toBeCloseTo(5, 3)
    expect(Number(blind5.params.diameter)).toBeCloseTo(10, 3)

    // blind 5 -> 8 mm: the bottom moves down 3 mm, diameter kept.
    const r2 = await editDepth(b1, blind5, 'D2', { delta: 8 - 5 })
    expect(r2.ok, JSON.stringify(r2.diagnostics)).toBe(true)
    const b2 = r2.body!
    expect(await volume(b1) - await volume(b2)).toBeCloseTo(cylinder(10, 3), 2)
    const blind8 = await holeAt(b2, HOLE_D10)
    expect(blind8.featureClass).toBe('blindHole')
    expect(Number(blind8.params.depth)).toBeCloseTo(8, 3)
    expect(Number(blind8.params.diameter)).toBeCloseTo(10, 3)

    // blind -> through: back to the imported volume and a through hole.
    const r3 = await editDepth(b2, blind8, 'D3', { through: true })
    expect(r3.ok, JSON.stringify(r3.diagnostics)).toBe(true)
    const b3 = r3.body!
    expect(await volume(b3)).toBeCloseTo(v0, 2)
    expect((await holeAt(b3, HOLE_D10)).featureClass).toBe('throughHole')

    // editFeature never consumes its input: the source (Undo's replay target) is unchanged.
    expect(await volume(source)).toBe(v0)
    expect((await holeAt(source, HOLE_D10)).featureClass).toBe('throughHole')
  }, 120_000)

  it('makes a through hole blind at 4 mm; a depth past the far side cuts through', async () => {
    const imported = await engine.importStep(fixtureBytes(), 'WO2091B')
    const source = imported.bodies[0].handle
    const v0 = await volume(source)
    const hole = await holeAt(source, HOLE_D6)

    const r1 = await editDepth(source, hole, 'E1', { delta: 4 - 10 })
    expect(r1.ok, JSON.stringify(r1.diagnostics)).toBe(true)
    expect(await volume(r1.body!) - v0).toBeCloseTo(cylinder(6, 6), 2)
    const blind4 = await holeAt(r1.body!, HOLE_D6)
    expect(blind4.featureClass).toBe('blindHole')
    expect(Number(blind4.params.depth)).toBeCloseTo(4, 3)
    expect(Number(blind4.params.diameter)).toBeCloseTo(6, 3)

    const r2 = await editDepth(r1.body!, blind4, 'E2', { delta: 20 - 4 })
    expect(r2.ok, JSON.stringify(r2.diagnostics)).toBe(true)
    expect(await volume(r2.body!)).toBeCloseTo(v0, 2)
    expect((await holeAt(r2.body!, HOLE_D6)).featureClass).toBe('throughHole')
  }, 120_000)
})
