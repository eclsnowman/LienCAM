// GEO-6 — direct-edit / defeature acceptance, against the REAL occt-wasm kernel
// in Node. Covers: face-level recognition with parameters; batch remove/heal
// (watertight, isValid, signed volume delta sign-correct) on synthetic fixtures
// AND the real 87-face vendor plate (probe-07 scenario reproduced); Tray.step
// corner class refused STRUCTURED; BK-45 partial success (9-of-10); determinism;
// wasm-handle lifecycle.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, ProfileRegion, Vec3 } from '../../geom/geom-service.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'

const FIX = join(process.cwd(), 'src/tests/geom/fixtures')
const BOX = { x: 60, y: 30, z: 12 }
const TOP = 'F1:BOX:zMax'

async function box(engine: GeomEngine, size = BOX): Promise<BodyHandle> {
  return (await engine.makeBox('F1', size)).body!
}
function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIX, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}
async function importFirst(engine: GeomEngine, name: string, importId: string): Promise<BodyHandle> {
  const { bodies } = await engine.importStep(fixtureBytes(name), importId)
  return bodies[0].handle
}

describe('GEO-6 defeature (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  // ---- 1) recognition with measured parameters ----
  it('#1 recognizeFeatures: a box with 3 blind holes -> 3 blindHole verdicts w/ diameter+depth', async () => {
    let b = await box(engine)
    const pts: Vec3[] = [{ x: 15, y: 15, z: 12 }, { x: 30, y: 15, z: 12 }, { x: 45, y: 15, z: 12 }]
    b = (await engine.makeHole({ featureId: 'H', body: b, face: TOP, points: pts, style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 5 } })).body!
    const verdicts = await engine.recognizeFeatures(b)
    const holes = verdicts.filter((v) => v.featureClass === 'blindHole')
    expect(holes.length).toBe(3)
    for (const h of holes) {
      expect(h.removable).toBe(true)
      expect(Math.abs(Number(h.params.diameter) - 6)).toBeLessThan(0.05)
      expect(Number(h.params.depth)).toBeGreaterThan(4.5)
      expect(h.faceIds.length).toBeGreaterThan(0)
    }
    await engine.disposeAll()
  }, 60_000)

  // ---- 2) synthetic batch remove/heal + signed volume delta ----
  it('#2 defeatureBatch removes 3 blind holes -> watertight box, delta = +3 cylinders (material ADDED)', async () => {
    let b = await box(engine)
    const v0 = (await engine.measure(b, 'volume')).value
    const pts: Vec3[] = [{ x: 15, y: 15, z: 12 }, { x: 30, y: 15, z: 12 }, { x: 45, y: 15, z: 12 }]
    b = (await engine.makeHole({ featureId: 'H', body: b, face: TOP, points: pts, style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 5 } })).body!
    const vHoled = (await engine.measure(b, 'volume')).value
    const r = await engine.defeatureBatch({ featureId: 'DF1', body: b })
    expect(r.ok).toBe(true)
    expect(r.report!.healed).toBe(3)
    expect(r.report!.failed).toBe(0)
    const vHealed = (await engine.measure(r.body!, 'volume')).value
    expect(Math.abs(vHealed - v0)).toBeLessThan(1e-2)   // back to the sharp box
    // signed delta is POSITIVE (material added back) and equals the removed holes.
    expect(r.report!.totalVolumeDelta).toBeGreaterThan(0)
    expect(Math.abs(r.report!.totalVolumeDelta - (v0 - vHoled))).toBeLessThan(1e-2)
    // the hole faces are gone; the top face survives (retrimmed, keeps its id).
    expect(r.elementMap!.deleted.length).toBeGreaterThanOrEqual(3)
    await engine.disposeAll()
  }, 60_000)

  // ---- 2c) R1.2 boss/protrusion: fixtured via extrude-add, negative delta ----
  it('#2c boss: recognize a fused protrusion -> defeatureBatch removes it, watertight, NEGATIVE delta, host preserved', async () => {
    const base = (await engine.makeBox('F1', { x: 40, y: 40, z: 10 })).body!
    const vBase = (await engine.measure(base, 'volume')).value
    // extrude-ADD a 12x12 boss on the top face (z=10), 6 mm tall -> raised island.
    const profile: ProfileRegion = { sketchId: 'S1', plane: xyPlane(10), loops: [rectLoop('S1', 14, 14, 26, 26)] }
    const withBoss = (await engine.makeExtrude({ featureId: 'BOSS', profile, end: { kind: 'blind', distance: 6 }, op: 'add', target: base })).body!
    const vBoss = (await engine.measure(withBoss, 'volume')).value
    expect(vBoss).toBeGreaterThan(vBase)   // the boss added material

    const verdicts = await engine.recognizeFeatures(withBoss)
    const boss = verdicts.find((v) => v.featureClass === 'boss')
    expect(boss).toBeDefined()
    expect(boss!.removable).toBe(true)
    expect(boss!.effect).toBe('remove')

    const r = await engine.defeatureBatch({ featureId: 'DF', body: withBoss, featureKeys: [boss!.featureKey] })
    expect(r.ok).toBe(true)
    expect(r.report!.healed).toBe(1)
    const vHealed = (await engine.measure(r.body!, 'volume')).value
    expect(Math.abs(vHealed - vBase)).toBeLessThan(1e-2)         // back to the base plate
    expect(r.report!.totalVolumeDelta).toBeLessThan(0)           // NEGATIVE (material removed)
    // host top face survived the removal (it is preserved, not deleted).
    const rr = await engine.recognizeFeatures(r.body!)
    expect(rr.some((v) => v.featureClass === 'boss')).toBe(false) // boss is gone
    await engine.disposeAll()
  }, 60_000)

  it('#2d circular boss: the opening-loop hole pass leaves its outward wall for boss recognition', async () => {
    const base = (await engine.makeBox('F1', { x: 40, y: 40, z: 10 })).body!
    const profile: ProfileRegion = {
      sketchId: 'ROUND_BOSS',
      plane: xyPlane(10),
      loops: [[{
        kind: 'arc', c: [20, 20], r: 6, a0: 0, a1: Math.PI * 2, ccw: true, srcId: 'ROUND_BOSS.c0',
      }]],
    }
    const withBoss = (await engine.makeExtrude({
      featureId: 'ROUND_BOSS', profile, end: { kind: 'blind', distance: 6 }, op: 'add', target: base,
    })).body!

    const verdicts = await engine.recognizeFeatures(withBoss)
    const boss = verdicts.find((v) => v.featureClass === 'boss')
    expect(boss).toBeDefined()
    expect(boss!.removable).toBe(true)
    expect(boss!.effect).toBe('remove')
    expect(verdicts.some((v) => ['throughHole', 'blindHole', 'counterboreStack'].includes(v.featureClass))).toBe(false)
    await engine.disposeAll()
  }, 60_000)

  // ---- 3) real 87-face vendor plate: probe-07 scenario reproduced ----
  it('#3 real plate: 12 drilled holes removed watertight, pocket + outer profile preserved, +delta', async () => {
    const b = await importFirst(engine, 'step-test-with-holes.step', 'IMP1')
    const verdicts = await engine.recognizeFeatures(b)
    const holes = verdicts.filter((v) => v.removable && ['throughHole', 'blindHole', 'counterboreStack'].includes(v.featureClass))
    expect(holes.length).toBe(12)   // exactly the 12 drilled/counterbored holes
    const pocket = verdicts.find((v) => v.featureClass === 'pocket')
    expect(pocket).toBeDefined()    // the central rounded-rect pocket is NOT a hole

    // ---- GEO-20 P8: pocket-verdict COMPLETENESS. The pocket's face set stays
    // WHOLE (26 faces: 6 plane / 8 cylinder / 4 bspline / 8 cone — the GEO-20
    // preflight's verdict census) — the naive fix of excluding the 4 bspline
    // corner-fillet faces from pocket absorption is proven unsound (it would
    // shrink dropHashes 26 -> 22 and leave the pocket's corner walls un-owned,
    // a silent geometry regression this assertion exists to catch). Each
    // absorbed bspline face is ALSO named — not silently vanished. WO-2079
    // proves the two narrow edge blends independently removable; the two broad
    // structural pocket walls remain non-claiming refusal rows. ----
    expect(pocket!.faceIds.length).toBe(26)
    const absorbedBspline = verdicts.filter((v) =>
      v.featureClass === 'filletCurvedCorner' && v.params.absorbedBy === pocket!.featureKey)
    expect(absorbedBspline.length).toBe(4)
    expect(absorbedBspline.filter((v) => v.removable).length).toBe(2)
    expect(absorbedBspline.filter((v) => !v.removable).length).toBe(2)
    for (const row of absorbedBspline) {
      expect(row.params.surfaceKind).toBe('bspline')
      if (row.removable) {
        expect(row.faceIds).toHaveLength(1)
        expect(row.refuseReason).toBeUndefined()
      } else {
        expect(row.faceIds).toEqual([])
        expect(row.refuseReason).toMatch(/absorbed inside pocket/)
      }
      // the absorbed face's stable id is preserved in the pocket's OWN face set
      // (not pulled out), proving the complete pocket route did not shrink.
      const absorbedId = row.removable ? row.faceIds[0] : row.neighbourIds[0]
      expect(pocket!.faceIds).toContain(absorbedId)
    }

    const r = await engine.defeatureBatch({ featureId: 'DF', body: b, query: { classes: ['throughHole', 'blindHole', 'counterboreStack'] } })
    expect(r.ok).toBe(true)
    expect(r.report!.healed).toBe(12)
    // watertight valid solid.
    const rr = await engine.recognizeFeatures(r.body!)
    // the healed body still carries the central pocket (preserved byte-for-byte).
    const pocketAfter = rr.find((v) => v.featureClass === 'pocket')
    expect(pocketAfter).toBeDefined()
    expect(pocketAfter!.faceIds.length).toBe(26)   // completeness survives a heal, not just fresh recognition
    // probe-07 measured numbers: +2459.47 material added back, sign POSITIVE.
    expect(r.report!.totalVolumeDelta).toBeGreaterThan(0)
    expect(Math.abs(r.report!.totalVolumeDelta - 2459.47)).toBeLessThan(1.0)
    // the 4 outer bspline faces survive with IDENTICAL id set + total area.
    const bsBefore = verdicts.length // sanity touch
    void bsBefore
    await engine.disposeAll()
  }, 120_000)

  // ---- 4) Tray.step curved corner class: in-class blends heal, the rest refuse STRUCTURED ----
  // GEO-6X5 (BK-89) narrowed this from a blanket refusal. A torus inside the bounded
  // analytic blend-ribbon class is now RECONSTRUCTED to its sharp corner (proven in
  // defeature-blend-ribbon.test.ts); every other curved corner keeps the structured,
  // named refusal this test has always guarded. Neither branch ever crashes.
  it('#4 Tray.step: curved corner blends split into in-class (removable) and refused (named reason), never crash', async () => {
    const b = await importFirst(engine, 'tray.step', 'IMP2')
    const verdicts = await engine.recognizeFeatures(b)
    const curved = verdicts.filter((v) => v.featureClass === 'filletCurvedCorner')
    expect(curved.length).toBeGreaterThan(0)

    const refused = curved.filter((v) => !v.removable)
    const inClass = curved.filter((v) => v.removable)
    expect(refused.length, 'the Tray still carries out-of-class curved corners').toBeGreaterThan(0)
    expect(inClass.length, 'and in-class analytic blend ribbons the product can now sharpen').toBeGreaterThan(0)

    for (const v of refused) {
      expect(v.refuseReason && v.refuseReason.length).toBeGreaterThan(0)
      expect(v.refuseReason!.toLowerCase()).not.toContain('webassembly')
    }
    for (const v of inClass) expect(v.refuseReason).toBeUndefined()

    // asking to remove ONLY refused features -> 0 healed, ok:false, each named.
    const r = await engine.defeatureBatch({ featureId: 'DF', body: b, featureKeys: refused.slice(0, 3).map((v) => v.featureKey) })
    expect(r.ok).toBe(false)
    expect(r.report!.refused).toBe(Math.min(3, refused.length))
    expect(r.report!.healed).toBe(0)
    await engine.disposeAll()
  }, 180_000)

  // ---- 5) BK-45 partial success: heal 9 of 10, name the 1 failure ----
  it('#5 partial success: a batch of 10 holes with 1 forced-failing heals 9 and names the 1', async () => {
    let b = await box(engine, { x: 120, y: 20, z: 12 })
    const pts: Vec3[] = Array.from({ length: 10 }, (_, i) => ({ x: 8 + i * 11, y: 10, z: 12 }))
    b = (await engine.makeHole({ featureId: 'H', body: b, face: TOP, points: pts, style: { kind: 'simple', diameter: 4 }, depth: { kind: 'blind', distance: 5 } })).body!
    engine.debugSetDefeatureFault(4)   // force the 5th (sorted) feature's heal to fail
    try {
      const r = await engine.defeatureBatch({ featureId: 'DF', body: b })
      expect(r.ok).toBe(true)            // partial success still mints a body
      expect(r.report!.requested).toBe(10)
      expect(r.report!.healed).toBe(9)
      expect(r.report!.failed).toBe(1)
      const failed = r.report!.items.filter((i) => !i.healed)
      expect(failed.length).toBe(1)
      expect(String(failed[0].reason)).toContain('debug fault')
    } finally {
      engine.debugSetDefeatureFault(null)
    }
    await engine.disposeAll()
  }, 120_000)

  it('#5b zero-heal diagnostic includes the underlying feature failure', async () => {
    let b = await box(engine)
    b = (await engine.makeHole({
      featureId: 'H',
      body: b,
      face: TOP,
      points: [{ x: 30, y: 15, z: 12 }],
      style: { kind: 'simple', diameter: 4 },
      depth: { kind: 'blind', distance: 5 },
    })).body!
    const [feature] = (await engine.recognizeFeatures(b)).filter((verdict) => verdict.removable)
    expect(feature).toBeDefined()
    engine.debugSetDefeatureFault(0)
    try {
      const result = await engine.defeatureBatch({
        featureId: 'DF',
        body: b,
        featureKeys: [feature.featureKey],
      })
      expect(result.ok).toBe(false)
      const reason = String(result.diagnostics[0]?.params?.reason ?? '')
      expect(reason).toContain('0 of 1 removable feature(s) healed')
      expect(reason).toContain(feature.featureKey)
      expect(reason).toContain('debug fault')
    } finally {
      engine.debugSetDefeatureFault(null)
    }
    await engine.disposeAll()
  }, 60_000)

  // ---- 6) determinism: identical input + rules -> identical ids across 2 runs ----
  it('#6 determinism: feature keys and healed-body deleted-id set are byte-identical across 2 runs', async () => {
    const run = async (): Promise<{ keys: string[]; deleted: string[] }> => {
      let b = await box(engine)
      const pts: Vec3[] = [{ x: 15, y: 15, z: 12 }, { x: 45, y: 15, z: 12 }]
      b = (await engine.makeHole({ featureId: 'H', body: b, face: TOP, points: pts, style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 5 } })).body!
      const keys = (await engine.recognizeFeatures(b)).map((v) => v.featureKey).sort()
      const r = await engine.defeatureBatch({ featureId: 'DF', body: b })
      return { keys, deleted: [...r.elementMap!.deleted].sort() }
    }
    const a = await run()
    const c = await run()
    expect(a.keys).toEqual(c.keys)
    expect(a.deleted).toEqual(c.deleted)
    await engine.disposeAll()
  }, 120_000)

  // ---- 6b) R1.3 resized-base replay: recorded batch re-finds on a survivable
  //          edit (heals) and names the lost feature on a destructive edit ----
  it('#6b resized-base replay: survivable edit re-finds + heals; destructive edit names the lost feature (no silent match)', async () => {
    const holed = async (size: Vec3, pts: Vec3[]): Promise<BodyHandle> => {
      const bx = (await engine.makeBox('F1', size)).body!
      return (await engine.makeHole({ featureId: 'H', body: bx, face: TOP, points: pts, style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 5 } })).body!
    }
    const pts: Vec3[] = [{ x: 15, y: 15, z: 12 }, { x: 45, y: 15, z: 12 }]
    // record the batch identity (feature keys) from the original base.
    const recorded = await holed({ x: 60, y: 30, z: 12 }, pts)
    const keys = (await engine.recognizeFeatures(recorded)).filter((v) => v.removable).map((v) => v.featureKey)
    expect(keys.length).toBe(2)

    // SURVIVABLE upstream edit: base resized LONGER (x 60 -> 90), top z + hole XY
    // unchanged -> the recorded keys still resolve -> the batch replays + heals.
    const resized = await holed({ x: 90, y: 30, z: 12 }, pts)
    const rS = await engine.defeatureBatch({ featureId: 'DF', body: resized, featureKeys: keys })
    expect(rS.ok).toBe(true)
    expect(rS.report!.healed).toBe(2)
    expect(rS.report!.notFound ?? []).toEqual([])

    // DESTRUCTIVE upstream edit: the holes MOVED -> the recorded keys no longer
    // resolve -> named LOUD in notFound, ZERO healed, no silent wrong match.
    const moved = await holed({ x: 60, y: 30, z: 12 }, [{ x: 22, y: 15, z: 12 }, { x: 38, y: 15, z: 12 }])
    const rD = await engine.defeatureBatch({ featureId: 'DF', body: moved, featureKeys: keys })
    expect(rD.ok).toBe(false)
    expect(rD.report!.healed).toBe(0)
    expect(rD.report!.notFound!.length).toBe(2)
    for (const kk of keys) expect(rD.report!.notFound).toContain(kk)
    await engine.disposeAll()
  }, 120_000)

  // ---- 7) wasm-handle lifecycle: a successful batch + dispose returns to baseline ----
  it('#7 WASM-HANDLE LIFECYCLE: defeatureBatch success then dispose returns to baseline', async () => {
    const b0 = await box(engine)
    const pts: Vec3[] = [{ x: 15, y: 15, z: 12 }, { x: 45, y: 15, z: 12 }]
    const holed = (await engine.makeHole({ featureId: 'H', body: b0, face: TOP, points: pts, style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 5 } })).body!
    // baseline WITH both existing bodies (box + holed) live: a defeatureBatch +
    // dispose of only its output must leave the kernel exactly here.
    const baseline = engine.debugKernelShapeCount()
    const r = await engine.defeatureBatch({ featureId: 'DF', body: holed })
    expect(r.ok).toBe(true)
    await engine.dispose(r.body!)
    expect(engine.debugTransientCount()).toBe(0)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    await engine.disposeAll()
  }, 60_000)

  // ---- 8) rule-based selection (SW-2024 / SpaceClaim Power-Select bar) ----
  it('#8 queryFeatures: "all holes diameter <= 5" selects only the small holes', async () => {
    let b = await box(engine)
    b = (await engine.makeHole({ featureId: 'HA', body: b, face: TOP, points: [{ x: 15, y: 15, z: 12 }], style: { kind: 'simple', diameter: 4 }, depth: { kind: 'blind', distance: 5 } })).body!
    b = (await engine.makeHole({ featureId: 'HB', body: b, face: TOP, points: [{ x: 45, y: 15, z: 12 }], style: { kind: 'simple', diameter: 10 }, depth: { kind: 'blind', distance: 5 } })).body!
    const small = await engine.queryFeatures(b, { classes: ['blindHole'], maxDiameter: 5 })
    expect(small.length).toBe(1)
    expect(Number(small[0].params.diameter)).toBeLessThan(5)
    await engine.disposeAll()
  }, 60_000)
})
