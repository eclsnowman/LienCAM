import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import type { BodyHandle, ProfileRegion, StableId } from '../../geom/geom-service.ts'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'

const BOX = { x: 60, y: 30, z: 10 }
const SHARP_VOLUME = BOX.x * BOX.y * BOX.z
const POCKET_VOLUME = 4 * 6 * 2
const TOP_Z = 10
const FLOOR_Z = 8
const Y0 = 12
const Y1 = 18
const GLYPHS = [
  { id: 'G1', x0: 10, x1: 14, key: 'loop:12:15:10' },
  { id: 'G2', x0: 28, x1: 32, key: 'loop:30:15:10' },
  { id: 'G3', x0: 46, x1: 50, key: 'loop:48:15:10' },
] as const

async function engravedPlate(engine: GeomEngine): Promise<BodyHandle> {
  const base = await engine.makeBox('BASE', BOX)
  expect(base.ok, JSON.stringify(base.diagnostics)).toBe(true)
  let body = base.body!

  for (const glyph of GLYPHS) {
    const profile: ProfileRegion = {
      sketchId: glyph.id,
      plane: xyPlane(FLOOR_Z),
      loops: [rectLoop(glyph.id, glyph.x0, Y0, glyph.x1, Y1)],
    }
    const cut = await engine.makeExtrude({
      featureId: `CUT-${glyph.id}`,
      profile,
      end: { kind: 'blind', distance: TOP_Z - FLOOR_Z },
      op: 'cut',
      target: body,
    })
    expect(cut.ok, JSON.stringify(cut.diagnostics)).toBe(true)
    body = cut.body!
  }

  return body
}

function sorted<T extends string>(values: Iterable<T>): T[] {
  return [...values].sort()
}

describe('Defeature engraved-text acceptance (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  let kernel: OcctKernel

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
    kernel = await OcctKernel.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
    try { kernel[Symbol.dispose]() } catch { /* already disposed */ }
  })

  it('recognizes and heals three same-host glyph pockets with complete lineage and a valid STEP round-trip', async () => {
    const engraved = await engravedPlate(engine)
    const engravedVolume = (await engine.measure(engraved, 'volume')).value
    expect(engravedVolume).toBeCloseTo(SHARP_VOLUME - 3 * POCKET_VOLUME, 6)

    const verdicts = await engine.recognizeFeatures(engraved)
    const glyphs = verdicts
      .filter((verdict) => verdict.featureClass === 'engravedText')
      .sort((a, b) => a.featureKey.localeCompare(b.featureKey))

    expect(glyphs).toHaveLength(3)
    expect(glyphs.map((glyph) => glyph.featureKey)).toEqual(GLYPHS.map((glyph) => glyph.key))
    expect(glyphs.every((glyph) => glyph.removable)).toBe(true)
    expect(glyphs.every((glyph) => glyph.effect === 'add')).toBe(true)

    const recognizedFaceIds = new Set<StableId>()
    for (const glyph of glyphs) {
      expect(glyph.faceIds).toHaveLength(5)
      expect(new Set(glyph.faceIds).size).toBe(5)
      for (const faceId of glyph.faceIds) {
        expect(recognizedFaceIds.has(faceId)).toBe(false)
        recognizedFaceIds.add(faceId)
      }
      expect(glyph.neighbourIds).toHaveLength(1)
    }
    expect(recognizedFaceIds.size).toBe(15)

    const hostIds = new Set(glyphs.flatMap((glyph) => glyph.neighbourIds))
    expect(hostIds.size).toBe(1)
    const [sharedHost] = [...hostIds]
    expect(sharedHost).toBeDefined()
    expect(glyphs.every((glyph) => glyph.neighbourIds[0] === sharedHost)).toBe(true)

    const healed = await engine.defeatureBatch({
      featureId: 'HEAL-TEXT',
      body: engraved,
      featureKeys: glyphs.map((glyph) => glyph.featureKey),
    })
    expect(
      healed.ok,
      JSON.stringify({ diagnostics: healed.diagnostics, report: healed.report }, null, 2),
    ).toBe(true)
    expect(healed.report).toMatchObject({
      requested: 3,
      healed: 3,
      failed: 0,
      refused: 0,
      items: glyphs.map((glyph) => ({
        featureKey: glyph.featureKey,
        featureClass: 'engravedText',
        healed: true,
        effect: 'add',
      })),
    })
    expect(healed.report!.totalVolumeDelta).toBeCloseTo(3 * POCKET_VOLUME, 6)

    const healedVolume = (await engine.measure(healed.body!, 'volume')).value
    expect(Number.isFinite(healedVolume)).toBe(true)
    expect(healedVolume).toBeCloseTo(SHARP_VOLUME, 6)

    const delta = healed.elementMap!
    expect(sorted(delta.deleted)).toEqual(sorted(recognizedFaceIds))
    expect(delta.deleted).toHaveLength(15)
    expect(delta.generated).toEqual([])
    expect(Object.keys(delta.modified)).toEqual([sharedHost])
    expect(delta.modified[sharedHost]).toEqual([sharedHost])
    expect(delta.deleted).not.toContain(sharedHost)
    for (const id of [...delta.deleted, ...Object.keys(delta.modified) as StableId[]]) {
      expect(delta.geometry?.[id], `missing geometry snapshot for ${id}`).toBeDefined()
    }

    const afterVerdicts = await engine.recognizeFeatures(healed.body!)
    expect(afterVerdicts.some((verdict) =>
      verdict.featureClass === 'engravedText' || verdict.featureClass === 'pocket',
    )).toBe(false)
    expect(Object.keys(engine.snapshotsFor(healed.body!))).toHaveLength(6)

    const step = await engine.exportStep([healed.body!])
    expect(step.byteLength).toBeGreaterThan(0)

    let rawRoundTrip: ShapeHandle | undefined
    try {
      rawRoundTrip = kernel.importStep(step)
      expect(kernel.isValid(rawRoundTrip)).toBe(true)
      expect(kernel.isSolid(rawRoundTrip)).toBe(true)
      const rawVolume = kernel.getVolume(rawRoundTrip)
      expect(Number.isFinite(rawVolume)).toBe(true)
      expect(rawVolume).toBeCloseTo(SHARP_VOLUME, 6)
    } finally {
      if (rawRoundTrip !== undefined) kernel.release(rawRoundTrip)
    }

    const imported = await engine.importStep(step, 'ROUNDTRIP')
    expect(imported.diagnostics.some((diagnostic) => diagnostic.severity === 'error')).toBe(false)
    expect(imported.bodies).toHaveLength(1)
    const importedBody = imported.bodies[0].handle
    const importedVolume = (await engine.measure(importedBody, 'volume')).value
    expect(Number.isFinite(importedVolume)).toBe(true)
    expect(importedVolume).toBeCloseTo(SHARP_VOLUME, 6)

    const tessellation = await engine.tessellate(importedBody, { deflection: 0.1 })
    expect(new Set(tessellation.faceIds).size).toBe(6)
    expect([...tessellation.position].every(Number.isFinite)).toBe(true)
    expect([...tessellation.normal].every(Number.isFinite)).toBe(true)

    await engine.disposeAll()
  }, 120_000)
})
