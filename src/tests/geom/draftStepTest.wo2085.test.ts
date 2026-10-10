import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

const FIXTURES = join(process.cwd(), 'src/tests/geom/fixtures')
const BREP_FIXTURES = join(process.cwd(), 'test_fixtures/brep')
const NEUTRAL_FACE = 'IMP1:step:face#0'
const DRAFT_FACE = 'IMP1:step:face#1'

function fileBytes(path: string): ArrayBuffer {
  const bytes = readFileSync(path)
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength)
}

describe('WO-2085 draft on Step Test With Holes', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('drafts the recorded side face 3 deg from the recorded neutral face into a valid closed solid and preserves the Undo source', async () => {
    const kernelShapesBefore = engine.debugKernelShapeCount()
    const imported = await engine.importStep(fileBytes(join(FIXTURES, 'step-test-with-holes.step')), 'IMP1')
    expect(imported.bodies, JSON.stringify(imported.diagnostics)).toHaveLength(1)
    const source = imported.bodies[0].handle
    const snapshots = engine.snapshotsFor(source)
    const neutral = snapshots[NEUTRAL_FACE]
    const drafted = snapshots[DRAFT_FACE]

    // These are the exact faces picked in headed run S1. Keep the identity
    // assertions so an import-order change cannot silently test an easier wall.
    expect(neutral).toMatchObject({ type: 'plane' })
    expect(neutral.normal?.[2]).toBeGreaterThan(0.999)
    expect(drafted).toMatchObject({ type: 'plane' })
    expect(Math.abs(drafted.normal?.[2] ?? 1)).toBeLessThan(1e-6)

    const volumeBefore = (await engine.measure(source, 'volume')).value
    const result = await engine.applyDraft({
      featureId: 'D1',
      body: source,
      faces: [DRAFT_FACE],
      angleDeg: 3,
      neutralPlane: {
        origin: { x: neutral.centroid[0], y: neutral.centroid[1], z: neutral.centroid[2] },
        normal: { x: neutral.normal![0], y: neutral.normal![1], z: neutral.normal![2] },
      },
      pullDir: { x: 0, y: 0, z: 1 },
    })

    expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
    expect(result.body).toBeDefined()
    expect(Object.keys(engine.snapshotsFor(result.body!))).toHaveLength(Object.keys(snapshots).length)
    const draftedNormal = result.elementMap!.geometry![DRAFT_FACE].normal!
    expect(Math.abs(Math.abs(draftedNormal.z) - Math.sin(Math.PI / 60))).toBeLessThan(1e-5)
    expect((await engine.measure(result.body!, 'volume')).value).not.toBeCloseTo(volumeBefore, 8)

    const step = await engine.exportStep([result.body!])
    const kernel = await OcctKernel.init()
    let roundTrip: ShapeHandle | undefined
    try {
      roundTrip = kernel.importStep(step)
      expect(kernel.isValid(roundTrip)).toBe(true)
      expect(kernel.isSolid(roundTrip)).toBe(true)
    } finally {
      if (roundTrip !== undefined) kernel.release(roundTrip)
      kernel[Symbol.dispose]()
    }

    // Bodies are immutable. Discarding the drafted handle is the engine-side
    // Undo transition; the original imported handle must still be unchanged.
    await engine.dispose(result.body!)
    expect((await engine.measure(source, 'volume')).value).toBeCloseTo(volumeBefore, 8)
    expect(engine.snapshotsFor(source)).toEqual(snapshots)
    await engine.disposeAll()
    expect(engine.debugKernelShapeCount()).toBe(kernelShapesBefore)
  }, 180_000)

  for (const [name, file] of [
    ['plate holes', 'fix_plate_holes.step'],
    ['boss taper', 'fix_boss_taper.step'],
  ] as const) {
    it(`keeps the working ${name} imported draft valid`, async () => {
      const imported = await engine.importStep(fileBytes(join(BREP_FIXTURES, file)), 'CONTROL')
      expect(imported.bodies, JSON.stringify(imported.diagnostics)).toHaveLength(1)
      const source = imported.bodies[0].handle
      const snapshots = engine.snapshotsFor(source)
      const neutral = Object.entries(snapshots)
        .filter(([, snapshot]) => snapshot.type === 'plane' && (snapshot.normal?.[2] ?? 0) > 0.999)
        .sort((a, b) => b[1].centroid[2] - a[1].centroid[2])[0]
      const side = Object.entries(snapshots)
        .filter(([, snapshot]) => snapshot.type === 'plane' && Math.abs(snapshot.normal?.[2] ?? 1) < 1e-6)
        .sort((a, b) => b[1].area - a[1].area)[0]
      expect(neutral).toBeDefined()
      expect(side).toBeDefined()

      const result = await engine.applyDraft({
        featureId: `CONTROL-${name}`,
        body: source,
        faces: [side[0]],
        angleDeg: 3,
        neutralPlane: {
          origin: { x: neutral[1].centroid[0], y: neutral[1].centroid[1], z: neutral[1].centroid[2] },
          normal: { x: neutral[1].normal![0], y: neutral[1].normal![1], z: neutral[1].normal![2] },
        },
        pullDir: { x: 0, y: 0, z: 1 },
      })

      expect(result.ok, JSON.stringify(result.diagnostics)).toBe(true)
      expect(result.body).toBeDefined()
      expect((await engine.measure(result.body!, 'volume')).value).toBeGreaterThan(0)
      await engine.disposeAll()
    }, 180_000)
  }
})
