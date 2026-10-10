// GEO-10 — editFeature V1 remove-and-re-cut re-drive, against the REAL occt-wasm
// kernel in Node. Covers the per-kind CLASS MATRIX (every kind x geometry class
// is SUPPORTED-with-test or REFUSED-with-diagnostics-test), stable-id resolver
// lineage (exact/fallback, never silent 'lost' for supported classes), analytic
// volume deltas, determinism (byte-identical serialized geometry), and the
// engine-level regen-integration equivalent (the edited body is a first-class
// input to downstream recognize/cut ops).
//
// CLASS MATRIX (asserted below; mirrored in coordination/reports/GEO-10.report.json).
// GEO-10-R1: every REFUSED pair has its OWN named diagnostics test (no pair is
// "covered by code guard only"); the faceOffset non-planar refusal is a single
// surfaceType!='plane' guard proven by three distinct curved surface types.
//   faceOffset   x planar block face (solid neighbours) .. SUPPORTED (#fo-pull, #fo-push)
//   faceOffset   x planar face w/ a HOLE (cyl neighbour) . SUPPORTED (#fo-holed-pull, #fo-holed-push)
//   faceOffset   x planar offset that breaks the solid ... REFUSED   (#fo-refuse-overcut)
//   faceOffset   x non-solid boolean outcome (isSolid) ... REFUSED   (#fo-refuse-nonsolid)
//   faceOffset   x cylinder wall (non-planar) ............ REFUSED   (#fo-refuse-cyl)
//   faceOffset   x cone wall (non-planar) ................ REFUSED   (#fo-refuse-cone)
//   faceOffset   x torus corner blend (Tray, non-planar) . REFUSED   (#fo-refuse-torus)
//   holeDiameter x throughHole ........................... SUPPORTED (#hd-through-grow/shrink)
//   holeDiameter x blindHole ............................. SUPPORTED (#hd-blind-grow)
//   holeDiameter x counterboreStack (cbore) .............. SUPPORTED (#hd-cbore-grow)
//   holeDiameter x counterboreStack (csink cone) ......... SUPPORTED (#hd-csink-grow)
//   holeDiameter x resize to non-positive radius ......... REFUSED   (#hd-refuse-nonpositive)
//   holeDiameter x pilot >= counterbore diameter ......... REFUSED   (#hd-refuse-pilot-exceeds)
//   holeDiameter x pocket (wrong kind) ................... REFUSED   (#hd-wrongkind)
//   pocketDepth  x pocket with a planar floor ............ SUPPORTED (#pd-deeper, #pd-shallower)
//   pocketDepth  x hole (wrong kind) ..................... REFUSED   (#pd-wrongkind)
// Determinism (byte-identical serializeBody) is proven PER supported edit kind:
//   faceOffset #fo-determinism | holeDiameter #hd-determinism | pocketDepth #pd-determinism.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, FeatureVerdict, StableId, ProfileRegion, OpResult } from '../../geom/geom-service.ts'
import type { FaceProbe, GeometrySnapshot } from '../../geom/worker/internal-types.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'

const FIX = join(process.cwd(), 'src/tests/geom/fixtures')
const BOX = { x: 60, y: 30, z: 12 }
const TOP: StableId = 'F1:BOX:zMax' as StableId
const PI = Math.PI

async function box(engine: GeomEngine, size = BOX): Promise<BodyHandle> {
  return (await engine.makeBox('F1', size)).body!
}
function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIX, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}
async function vol(engine: GeomEngine, b: BodyHandle): Promise<number> {
  return (await engine.measure(b, 'volume')).value
}
/** Drill one hole and return the recognized hole verdict + the holed body + the
 *  makeHole OpResult (its elementMap.geometry is a full result-face enumeration:
 *  surfaceType + centroid + normal per StableId — used to mine the cone face and
 *  the moved top face by geometry rather than a hard-coded id). */
async function holedBox(
  engine: GeomEngine,
  style: Parameters<GeomEngine['makeHole']>[0]['style'],
  depth: Parameters<GeomEngine['makeHole']>[0]['depth'],
  cls: FeatureVerdict['featureClass'][],
): Promise<{ body: BodyHandle; hole: FeatureVerdict; drill: OpResult }> {
  const b0 = await box(engine)
  const drill = await engine.makeHole({ featureId: 'H', body: b0, face: TOP, points: [{ x: 30, y: 15, z: 12 }], style, depth })
  const b = drill.body!
  const verdicts = await engine.recognizeFeatures(b)
  const hole = verdicts.find((v) => cls.includes(v.featureClass))!
  return { body: b, hole, drill }
}

describe('GEO-10 editFeature V1 (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  // ================= faceOffset (priority kind — UI-5 push-pull) =============

  it('#fo-pull: pull the top block face +2mm -> +area*delta volume, solid, id kept exact', async () => {
    const b = await box(engine)
    const v0 = await vol(engine, b)
    const r = await engine.editFeature({ featureId: 'E1', body: b, featureKey: TOP as string, delta: 2, kind: 'faceOffset' })
    expect(r.ok).toBe(true)
    const v1 = await vol(engine, r.body!)
    expect(v1 - v0).toBeCloseTo(BOX.x * BOX.y * 2, 2)          // 60*30*2 = 3600
    // the offset face keeps its id and now resolves EXACT on the new body.
    const [res] = await engine.resolve(r.body!, [TOP])
    expect(res.status).not.toBe('lost')
    expect(res.status).toBe('exact')
    // and it moved: the top face centroid is now at z ~ 14.
    const snap = r.elementMap!.geometry![TOP]
    expect(snap.centroid.z).toBeCloseTo(14, 3)
    await engine.disposeAll()
  }, 60_000)

  it('#fo-push: push the top block face -3mm -> -area*delta volume, solid, id kept exact', async () => {
    const b = await box(engine)
    const v0 = await vol(engine, b)
    const r = await engine.editFeature({ featureId: 'E1', body: b, featureKey: TOP as string, delta: -3, kind: 'faceOffset' })
    expect(r.ok).toBe(true)
    const v1 = await vol(engine, r.body!)
    expect(v1 - v0).toBeCloseTo(-BOX.x * BOX.y * 3, 2)         // -60*30*3 = -5400
    const [res] = await engine.resolve(r.body!, [TOP])
    expect(res.status).toBe('exact')
    await engine.disposeAll()
  }, 60_000)

  it('#fo-determinism: the same offset twice yields byte-identical serialized geometry', async () => {
    const runOnce = async (): Promise<Uint8Array> => {
      const b = await box(engine)
      const r = await engine.editFeature({ featureId: 'E1', body: b, featureKey: TOP as string, delta: 2, kind: 'faceOffset' })
      const bin = new Uint8Array(await engine.serializeBody(r.body!))
      await engine.disposeAll()
      return bin
    }
    const a = await runOnce()
    const c = await runOnce()
    expect(a.length).toBe(c.length)
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(true)
  }, 60_000)

  it('#fo-refuse-overcut: a planar offset that breaks the solid (out-of-class) refuses STRUCTURED', async () => {
    // push the top of a 12mm block DOWN by 20mm — the prism engulfs the whole
    // body, so the boolean cannot yield a rigid planar offset. Refused, not crashed.
    const b = await box(engine)
    const r = await engine.editFeature({ featureId: 'E1', body: b, featureKey: TOP as string, delta: -20, kind: 'faceOffset' })
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0].code).toBe('DEFEATURE_UNSUPPORTED')
    expect(r.body).toBeUndefined()
    await engine.disposeAll()
  }, 60_000)

  it('#fo-refuse-cyl: faceOffset on a CYLINDER wall face refuses STRUCTURED (named class)', async () => {
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'throughAll' }, ['throughHole'])
    // the hole wall is a cylinder face id — non-planar, out of the faceOffset class.
    const wallId = hole.faceIds[0]
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: wallId as string, delta: 1, kind: 'faceOffset' })
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0].code).toBe('DEFEATURE_UNSUPPORTED')
    expect(String(r.diagnostics[0].params!.surfaceType)).toBe('cylinder')
    expect(r.body).toBeUndefined()
    await engine.disposeAll()
  }, 60_000)

  it('#fo-refuse-torus: faceOffset on the Tray corner-blend (torus) refuses STRUCTURED', async () => {
    const { bodies } = await engine.importStep(fixtureBytes('tray.step'), 'IMP')
    const b = bodies[0].handle
    const verdicts = await engine.recognizeFeatures(b)
    const blend = verdicts.find((v) => v.featureClass === 'filletCurvedCorner')
    expect(blend).toBeDefined()
    const r = await engine.editFeature({ featureId: 'E1', body: b, featureKey: blend!.faceIds[0] as string, delta: 1, kind: 'faceOffset' })
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0].code).toBe('DEFEATURE_UNSUPPORTED')
    // the refusal names the curved surface class (torus), never a silent no-op.
    expect(String(r.diagnostics[0].params!.surfaceType)).toBe('torus')
    await engine.disposeAll()
  }, 120_000)

  it('#fo-refuse-cone: faceOffset on a CONE wall face refuses STRUCTURED (named class)', async () => {
    // A countersink hole contributes a real CONE face — offset it and prove the
    // single surfaceType!=plane guard names 'cone' (third curved representative,
    // alongside cylinder + torus, so no non-planar surface type is code-guard-only).
    const { drill } = await holedBox(
      engine,
      { kind: 'countersink', diameter: 6, csDiameter: 12, csAngleDeg: 90 },
      { kind: 'blind', distance: 8 },
      ['counterboreStack'],
    )
    const coneEntry = Object.entries(drill.elementMap!.geometry!).find(([, g]) => g.surfaceType === 'cone')
    expect(coneEntry).toBeDefined()
    const r = await engine.editFeature({ featureId: 'E1', body: drill.body!, featureKey: coneEntry![0], delta: 1, kind: 'faceOffset' })
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0].code).toBe('DEFEATURE_UNSUPPORTED')
    expect(String(r.diagnostics[0].params!.surfaceType)).toBe('cone')
    expect(r.body).toBeUndefined()
    await engine.disposeAll()
  }, 60_000)

  it('#fo-holed-pull: pull a HOLED top face +2mm -> +trimmedArea*delta, hole stays open, cyl wall id kept', async () => {
    // The audit-mandated cylindrical-neighbour proof (finding 3): offset a PLANAR
    // face that has a through-hole. The trimmed area is the block top MINUS the
    // hole, and the cylindrical wall (a neighbour whose height+area change) must
    // keep its stable id via the pair-by-offset concentric match.
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'throughAll' }, ['throughHole'])
    // the drilled top face keeps its id TOP (modified, not lost) — prove it first.
    const [top0] = await engine.resolve(body, [TOP])
    expect(top0.status).toBe('exact')
    const trimmedArea = BOX.x * BOX.y - PI * 3 * 3
    const v0 = await vol(engine, body)
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: TOP as string, delta: 2, kind: 'faceOffset' })
    expect(r.ok).toBe(true)
    const v1 = await vol(engine, r.body!)
    expect(v1 - v0).toBeCloseTo(trimmedArea * 2, 1)           // (1800 - 9pi) * 2
    // the moved planar top AND the old cylindrical wall id both resolve exact.
    const [topRes] = await engine.resolve(r.body!, [TOP])
    expect(topRes.status).toBe('exact')
    const wallRes = await engine.resolve(r.body!, hole.faceIds)
    expect(wallRes.every((x) => x.status !== 'lost')).toBe(true)
    // the hole is still OPEN through the taller block (recognized as a through-hole).
    const rr = await engine.recognizeFeatures(r.body!)
    expect(rr.some((v) => v.featureClass === 'throughHole')).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('#fo-holed-push: push a HOLED top face -2mm -> -trimmedArea*delta, hole stays open, cyl wall id kept', async () => {
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'throughAll' }, ['throughHole'])
    const trimmedArea = BOX.x * BOX.y - PI * 3 * 3
    const v0 = await vol(engine, body)
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: TOP as string, delta: -2, kind: 'faceOffset' })
    expect(r.ok).toBe(true)
    const v1 = await vol(engine, r.body!)
    expect(v1 - v0).toBeCloseTo(-trimmedArea * 2, 1)
    const [topRes] = await engine.resolve(r.body!, [TOP])
    expect(topRes.status).toBe('exact')
    const wallRes = await engine.resolve(r.body!, hole.faceIds)
    expect(wallRes.every((x) => x.status !== 'lost')).toBe(true)
    const rr = await engine.recognizeFeatures(r.body!)
    expect(rr.some((v) => v.featureClass === 'throughHole')).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('#fo-refuse-nonsolid: a valid-but-NON-SOLID offset outcome refuses STRUCTURED (isSolid hard gate)', async () => {
    // Finding 2: isSolid is a HARD success gate for faceOffset/pocketDepth. Drive
    // the non-solid path deterministically via the test fault (the #defeatureFault
    // / #sweepFaultAfterBoolean precedent) and prove it REFUSES, not succeeds.
    const b = await box(engine)
    engine.debugSetEditNonSolidFault(true)
    try {
      const r = await engine.editFeature({ featureId: 'E1', body: b, featureKey: TOP as string, delta: 2, kind: 'faceOffset' })
      expect(r.ok).toBe(false)
      expect(r.diagnostics[0].code).toBe('DEFEATURE_UNSUPPORTED')
      expect(String(r.diagnostics[0].params!.reason)).toMatch(/solid/i)
      expect(r.body).toBeUndefined()
    } finally {
      engine.debugSetEditNonSolidFault(false)
    }
    await engine.disposeAll()
  }, 60_000)

  // ================= holeDiameter (heal + re-cut) ============================

  it('#hd-through-grow: enlarge a through hole Ø6 -> Ø8, analytic volume, ids not lost', async () => {
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'throughAll' }, ['throughHole'])
    const v0 = await vol(engine, body)
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole.featureKey, delta: 2, kind: 'holeDiameter' })
    expect(r.ok).toBe(true)
    const v1 = await vol(engine, r.body!)
    // through hole in a 12mm slab: growing Ø6->Ø8 removes pi*(4^2-3^2)*12 more.
    expect(v1 - v0).toBeCloseTo(-PI * (16 - 9) * 12, 1)
    // the re-cut wall keeps the OLD hole face ids (exact or fallback — never lost).
    const res = await engine.resolve(r.body!, hole.faceIds)
    expect(res.every((x) => x.status !== 'lost')).toBe(true)
    // the recognizer sees the NEW diameter (regen-integration: downstream rebuild).
    const rr = await engine.recognizeFeatures(r.body!)
    const grown = rr.find((v) => v.featureClass === 'throughHole')!
    expect(Number(grown.params.diameter)).toBeCloseTo(8, 1)
    await engine.disposeAll()
  }, 60_000)

  it('#hd-through-shrink: shrink a through hole Ø6 -> Ø4, analytic volume added back', async () => {
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'throughAll' }, ['throughHole'])
    const v0 = await vol(engine, body)
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole.featureKey, delta: -2, kind: 'holeDiameter' })
    expect(r.ok).toBe(true)
    const v1 = await vol(engine, r.body!)
    expect(v1 - v0).toBeCloseTo(PI * (9 - 4) * 12, 1)          // material re-added
    const res = await engine.resolve(r.body!, hole.faceIds)
    expect(res.every((x) => x.status !== 'lost')).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('#hd-blind-grow: enlarge a blind hole Ø6xdepth5 -> Ø8, floor stays watertight', async () => {
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'blind', distance: 5 }, ['blindHole'])
    const v0 = await vol(engine, body)
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole.featureKey, delta: 2, kind: 'holeDiameter' })
    expect(r.ok).toBe(true)
    const v1 = await vol(engine, r.body!)
    expect(v1 - v0).toBeCloseTo(-PI * (16 - 9) * 5, 1)
    // both wall AND floor survive with mapped ids (no silent loss).
    const res = await engine.resolve(r.body!, hole.faceIds)
    expect(res.every((x) => x.status !== 'lost')).toBe(true)
    // still a single blind hole afterward (watertight, one floor).
    const rr = await engine.recognizeFeatures(r.body!)
    expect(rr.filter((v) => v.featureClass === 'blindHole').length).toBe(1)
    await engine.disposeAll()
  }, 60_000)

  it('#hd-cbore-grow: enlarge a counterbore pilot Ø6 -> Ø7, spotface preserved, analytic volume', async () => {
    const { body, hole } = await holedBox(
      engine,
      { kind: 'counterbore', diameter: 6, cbDiameter: 10, cbDepth: 3 },
      { kind: 'blind', distance: 10 },
      ['counterboreStack'],
    )
    const v0 = await vol(engine, body)
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole.featureKey, delta: 1, kind: 'holeDiameter' })
    expect(r.ok).toBe(true)
    const v1 = await vol(engine, r.body!)
    // pilot Ø6->Ø7 only removes extra material BELOW the counterbore (10-3 = 7mm),
    // where the pilot is the binding radius (cbore region already Ø10 > Ø7).
    expect(v1 - v0).toBeCloseTo(-PI * (3.5 * 3.5 - 3 * 3) * 7, 0)
    const res = await engine.resolve(r.body!, hole.faceIds)
    expect(res.every((x) => x.status !== 'lost')).toBe(true)
    // still a counterbore with the SAME spotface diameter (Ø10) and a bigger pilot.
    const rr = await engine.recognizeFeatures(r.body!)
    const cb = rr.find((v) => v.featureClass === 'counterboreStack')!
    expect(Number(cb.params.diameter)).toBeCloseTo(7, 1)
    await engine.disposeAll()
  }, 60_000)

  it('#hd-csink-grow: enlarge a countersink pilot Ø6 -> Ø7 and preserve its entry cone', async () => {
    const { body, hole, drill } = await holedBox(
      engine,
      { kind: 'countersink', diameter: 6, csDiameter: 12, csAngleDeg: 90 },
      { kind: 'blind', distance: 8 },
      ['counterboreStack'],
    )
    const v0 = await vol(engine, body)
    const beforeCones = Object.values(drill.elementMap!.geometry!).filter((g) => g.surfaceType === 'cone')
    expect(beforeCones).toHaveLength(1)
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole.featureKey, delta: 1, kind: 'holeDiameter' })
    expect(r.ok).toBe(true)
    expect(await vol(engine, r.body!)).toBeLessThan(v0)
    const resized = (await engine.recognizeFeatures(r.body!)).find((v) => v.featureClass === 'counterboreStack')
    expect(resized).toBeDefined()
    expect(Number(resized!.params.diameter)).toBeCloseTo(7, 1)
    const afterCones = Object.values(r.elementMap!.geometry!).filter((g) => g.surfaceType === 'cone')
    expect(afterCones).toHaveLength(1)
    expect(afterCones[0].area).toBeGreaterThan(beforeCones[0].area)
    const res = await engine.resolve(r.body!, hole.faceIds)
    expect(res.every((x) => x.status !== 'lost')).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('#hd-refuse-nonpositive: shrink a through hole below Ø0 refuses STRUCTURED', async () => {
    // delta -8 on a Ø6 pilot -> newR = 3 + (-4) = -1 <= 0 -> refused BEFORE any
    // heal/re-cut (the non-positive-radius guard, now with its own named test).
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'throughAll' }, ['throughHole'])
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole.featureKey, delta: -8, kind: 'holeDiameter' })
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0].code).toBe('DEFEATURE_UNSUPPORTED')
    expect(String(r.diagnostics[0].params!.reason)).toMatch(/not positive/i)
    expect(r.body).toBeUndefined()
    await engine.disposeAll()
  }, 60_000)

  it('#hd-refuse-pilot-exceeds: growing a counterbore pilot to meet the spotface refuses STRUCTURED', async () => {
    // pilot Ø6 -> Ø14 (delta +8, newR 7) meets/exceeds the Ø10 counterbore (cbR 5)
    // -> refused "would consume the spotface" (the pilot>=counterbore guard test).
    const { body, hole } = await holedBox(
      engine,
      { kind: 'counterbore', diameter: 6, cbDiameter: 10, cbDepth: 3 },
      { kind: 'blind', distance: 10 },
      ['counterboreStack'],
    )
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole.featureKey, delta: 8, kind: 'holeDiameter' })
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0].code).toBe('DEFEATURE_UNSUPPORTED')
    expect(String(r.diagnostics[0].params!.reason)).toMatch(/counterbore|spotface/i)
    expect(r.body).toBeUndefined()
    await engine.disposeAll()
  }, 60_000)

  it('#hd-determinism: the same holeDiameter grow twice yields byte-identical serialized geometry', async () => {
    // Finding 4: determinism proven on the REMOVE/HEAL/RE-CUT path (distinct from
    // faceOffset's boolean-prism path), byte-for-byte across two independent runs.
    const runOnce = async (): Promise<Uint8Array> => {
      const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'throughAll' }, ['throughHole'])
      const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole.featureKey, delta: 2, kind: 'holeDiameter' })
      expect(r.ok).toBe(true)
      const bin = new Uint8Array(await engine.serializeBody(r.body!))
      await engine.disposeAll()
      return bin
    }
    const a = await runOnce()
    const c = await runOnce()
    expect(a.length).toBe(c.length)
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(true)
  }, 120_000)

  // ================= pocketDepth (floor-face offset) ========================

  async function pocketBox(engine: GeomEngine): Promise<{ body: BodyHandle; pocket: FeatureVerdict }> {
    const b0 = await box(engine)
    // Cut a 20x20 pocket, 4mm deep, opening on the top face (floor at z=8). The
    // profile sits at z=8 and the tool extrudes UP to z=12 (blind is +normal), so
    // the subtract leaves a top-open 4mm pocket whose floor sits at z=8.
    const profile: ProfileRegion = { sketchId: 'S1', plane: xyPlane(8), loops: [rectLoop('S1', 20, 5, 40, 25)] }
    const b = (await engine.makeExtrude({ featureId: 'PK', profile, end: { kind: 'blind', distance: 4 }, op: 'cut', target: b0 })).body!
    const verdicts = await engine.recognizeFeatures(b)
    const pocket = verdicts.find((v) => v.featureClass === 'pocket')!
    return { body: b, pocket }
  }

  it('#pd-deeper: deepen a 20x20x4 pocket by +2mm -> -floorArea*delta, watertight', async () => {
    const { body, pocket } = await pocketBox(engine)
    const v0 = await vol(engine, body)
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: pocket.featureKey, delta: 2, kind: 'pocketDepth' })
    expect(r.ok).toBe(true)
    const v1 = await vol(engine, r.body!)
    expect(v1 - v0).toBeCloseTo(-20 * 20 * 2, 1)              // floor 400mm^2 x 2mm removed
    // pocket faces (walls + floor) all still resolve — no scar, no silent loss.
    const res = await engine.resolve(r.body!, pocket.faceIds)
    expect(res.every((x) => x.status !== 'lost')).toBe(true)
    const rr = await engine.recognizeFeatures(r.body!)
    expect(rr.filter((v) => v.featureClass === 'pocket').length).toBe(1)
    await engine.disposeAll()
  }, 60_000)

  it('#pd-shallower: shallow a 20x20x4 pocket by -2mm -> +floorArea*delta, no floor scar', async () => {
    const { body, pocket } = await pocketBox(engine)
    const v0 = await vol(engine, body)
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: pocket.featureKey, delta: -2, kind: 'pocketDepth' })
    expect(r.ok).toBe(true)
    const v1 = await vol(engine, r.body!)
    expect(v1 - v0).toBeCloseTo(20 * 20 * 2, 1)               // filled back 800mm^3
    const res = await engine.resolve(r.body!, pocket.faceIds)
    expect(res.every((x) => x.status !== 'lost')).toBe(true)
    // exactly one pocket remains, 2mm deep — watertight, no leftover floor sliver.
    const rr = await engine.recognizeFeatures(r.body!)
    const pk = rr.filter((v) => v.featureClass === 'pocket')
    expect(pk.length).toBe(1)
    // DIRECT scar check (minor finding): elementMap.geometry enumerates EVERY
    // result face (minus deleted). The old floor sat at z=8; after shallowing it
    // must be GONE — no planar face may remain at the old floor plane inside the
    // pocket footprint (20<=x<=40, 5<=y<=25). An internal/coincident remnant that
    // preserved volume + recognizer count would still be caught here.
    const geo = r.elementMap!.geometry!
    const deleted = new Set<string>(r.elementMap!.deleted as unknown as string[])
    const oldFloorRemnant = Object.entries(geo).filter(([id, g]) =>
      !deleted.has(id) && g.surfaceType === 'plane' && Math.abs(g.normal?.z ?? 0) > 0.9 &&
      Math.abs(g.centroid.z - 8) < 0.15 &&
      g.centroid.x > 20 && g.centroid.x < 40 && g.centroid.y > 5 && g.centroid.y < 25)
    expect(oldFloorRemnant).toEqual([])
    // and the new floor rides at z=10 (moved, not scarred-in-place).
    const newFloor = Object.values(geo).filter((g) =>
      g.surfaceType === 'plane' && Math.abs(g.normal?.z ?? 0) > 0.9 &&
      Math.abs(g.centroid.z - 10) < 0.15 &&
      g.centroid.x > 20 && g.centroid.x < 40 && g.centroid.y > 5 && g.centroid.y < 25)
    expect(newFloor.length).toBe(1)
    await engine.disposeAll()
  }, 60_000)

  it('#pd-determinism: the same pocket deepen twice yields byte-identical serialized geometry', async () => {
    // Finding 4: determinism proven on the FLOOR-OFFSET path (pocketDepth), the
    // separate boolean-prism core, byte-for-byte across two independent runs.
    const runOnce = async (): Promise<Uint8Array> => {
      const { body, pocket } = await pocketBox(engine)
      const r = await engine.editFeature({ featureId: 'E1', body, featureKey: pocket.featureKey, delta: 2, kind: 'pocketDepth' })
      expect(r.ok).toBe(true)
      const bin = new Uint8Array(await engine.serializeBody(r.body!))
      await engine.disposeAll()
      return bin
    }
    const a = await runOnce()
    const c = await runOnce()
    expect(a.length).toBe(c.length)
    expect(Buffer.from(a).equals(Buffer.from(c))).toBe(true)
  }, 120_000)

  // ================= wrong-kind refusals (matrix completeness) ==============

  it('#hd-wrongkind: holeDiameter on a POCKET key refuses STRUCTURED', async () => {
    const { body, pocket } = await pocketBox(engine)
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: pocket.featureKey, delta: 1, kind: 'holeDiameter' })
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0].code).toBe('DEFEATURE_UNSUPPORTED')
    expect(String(r.diagnostics[0].params!.featureClass)).toBe('pocket')
    await engine.disposeAll()
  }, 60_000)

  it('#pd-wrongkind: pocketDepth on a HOLE key refuses STRUCTURED', async () => {
    const { body, hole } = await holedBox(engine, { kind: 'simple', diameter: 6 }, { kind: 'throughAll' }, ['throughHole'])
    const r = await engine.editFeature({ featureId: 'E1', body, featureKey: hole.featureKey, delta: 1, kind: 'pocketDepth' })
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0].code).toBe('DEFEATURE_UNSUPPORTED')
    expect(String(r.diagnostics[0].params!.featureClass)).toBe('throughHole')
    await engine.disposeAll()
  }, 60_000)

  it('#unknown-body: editFeature on an unknown handle throws (handle validation)', async () => {
    await expect(engine.editFeature({ featureId: 'E1', body: 99999 as BodyHandle, featureKey: TOP as string, delta: 1, kind: 'faceOffset' }))
      .rejects.toThrow(/unknown BodyHandle/)
  }, 60_000)

  // ================= regen integration (engine-level equivalent) ============

  it('#regen: an edited body is a first-class input to a downstream cut op', async () => {
    // faceOffset pull the top up 5mm, THEN drill a hole into the edited body —
    // proving the edited body flows through to the next feature (the workbench
    // regen path EditFeaturePayloadCommand -> executor -> engine.editFeature is
    // proven separately by SolidsWorkbenchPage.downstreamRegen.test.tsx).
    const b = await box(engine)
    const e = await engine.editFeature({ featureId: 'E1', body: b, featureKey: TOP as string, delta: 5, kind: 'faceOffset' })
    expect(e.ok).toBe(true)
    // the top moved to z=17; drill a blind hole on the edited body's top face.
    const drilled = await engine.makeHole({ featureId: 'H2', body: e.body!, face: TOP, points: [{ x: 30, y: 15, z: 17 }], style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 5 } })
    expect(drilled.ok).toBe(true)
    const rr = await engine.recognizeFeatures(drilled.body!)
    expect(rr.some((v) => v.featureClass === 'blindHole')).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  // ========== GEO-6X6-R2: refusal survives to the LAST consumer ============
  //
  // The auditor's major: matchFacesToOriginals correctly REFUSES an
  // exact-duplicate bucket (mints + deletes, never mis-binds), but pass 3
  // (#assignEditedIds -> #pairByOffset / #pairByRole) used to receive that
  // refused bucket's leftovers anyway and bind them itself — faceOffset by
  // first-equal-area-plane, holeDiameter by sorted-zip — both order-dependent.
  // These tests drive the REAL, unchanged #pairByOffset/#pairByRole through
  // #assignEditedIds (debugAssignEditedIdsForTest — see its doc comment for
  // why a real kernel body can't carry an exact-duplicate face pair) and
  // assert the duplicate pair is REFUSED (minted+deleted) in BOTH probe
  // orders, while LEGITIMATE pass-3 work (a genuinely translated/re-cut face,
  // not part of any duplicate bucket) still binds by id, unaffected.

  function planeSnap(x: number, y: number, z: number, area: number, n: [number, number, number] = [0, 0, 1]): GeometrySnapshot {
    return { type: 'plane', centroid: [x, y, z], normal: n, area }
  }
  function cylSnap(x: number, y: number, z: number, area: number, axis: [number, number, number] = [0, 0, 1]): GeometrySnapshot {
    return { type: 'cylinder', centroid: [x, y, z], normal: [1, 0, 0], area, axis }
  }
  let nextFpHash = 1
  function fp(s: GeometrySnapshot): FaceProbe { return { hash: nextFpHash++, snapshot: s } }

  it('#pairoffset-dup-order: faceOffset pass-3 total-orders a distinguishable duplicate-key pair identically in BOTH probe orders, and still binds LEGIT through the real pass-3 path (auditor repro + R2 minor fix)', () => {
    // DUP_A/DUP_B: same exactMatchKey (cylinder keys on centroid+area+AXIS,
    // never `normal`) -> the shared matcher's pass 1 still refuses the whole
    // 2x2 bucket upstream (property 3, unchanged). But they are NOT a true
    // tie: their `normal` differs — a real, always-populated field
    // `exactMatchKey`/`compareSnapshots` leave unused for this type — so
    // GEO-6X6-R3's discriminator CAN total-order them; the COMPLETE
    // id-to-probe-hash map must come out identical in both orders.
    // LEGIT: GEO-6X6-R2 auditor's MINOR — its centroid now moves ALONG its
    // normal (z 12 -> 14) with area held CONSTANT, so neither pass 1
    // (centroid moved -> different exact key) nor pass 2 (offset moved ->
    // different plane-support key) can bind it; it only binds through the
    // REAL #pairByOffset pass-3 same-normal/closest-area rule — the path the
    // R2 report claimed to cover but didn't.
    const dupAxis: [number, number, number] = [0, 0, 1]
    const dupBase = (n: [number, number, number]): GeometrySnapshot => ({ type: 'cylinder', centroid: [20, 20, 18], normal: n, area: 100, axis: dupAxis })
    const dupSnapA = dupBase([1, 0, 0])
    const dupSnapB = dupBase([0, 1, 0])
    const origLegit = planeSnap(30, 15, 12, 600)      // pre-offset top face
    const origEntries = [
      { id: 'DUP_A' as StableId, snap: dupSnapA },
      { id: 'DUP_B' as StableId, snap: dupSnapB },
      { id: 'LEGIT' as StableId, snap: origLegit },
    ]
    const finalLegit = planeSnap(30, 15, 14, 600)      // pulled along its own normal: centroid moved, area UNCHANGED
    const run = (order: 'fwd' | 'rev') => {
      nextFpHash = 1
      const pDupA = fp({ ...dupSnapA }), pDupB = fp({ ...dupSnapB }), pLegit = fp(finalLegit)
      const finalProbes = order === 'fwd' ? [pDupA, pDupB, pLegit] : [pDupB, pDupA, pLegit]
      const assign = engine.debugAssignEditedIdsForTest(origEntries, finalProbes, 'E1', 'faceOffset')
      return { assign, pDupA, pDupB, pLegit }
    }
    const f = run('fwd'), r = run('rev')
    expect(f.assign.ok).toBe(true)
    expect(r.assign.ok).toBe(true)
    if (f.assign.ok && r.assign.ok) {
      // LEGIT: unaffected by probe order, bound via the real pass-3 rule.
      expect(f.assign.faceMap.get(f.pLegit.hash)).toBe('LEGIT')
      expect(r.assign.faceMap.get(r.pLegit.hash)).toBe('LEGIT')
      expect(f.assign.modified['LEGIT']).toEqual(['LEGIT'])
      // DUP_A/DUP_B: REFUSED by the matcher (mint+delete), never order-bound
      // — neither original id survives into faceMap in either order.
      expect([...f.assign.faceMap.values()]).not.toContain('DUP_A')
      expect([...f.assign.faceMap.values()]).not.toContain('DUP_B')
      expect(f.assign.deleted.sort()).toEqual(['DUP_A', 'DUP_B'])
      expect(f.assign.generated.length).toBe(2)
      // THE auditor's exact ask: the COMPLETE id-to-probe-hash map (by which
      // PHYSICAL face — dupSnapA's normal vs dupSnapB's — got which new id)
      // is identical in both orders, not just the generated COUNT.
      expect(f.assign.faceMap.get(f.pDupA.hash)).toBe(r.assign.faceMap.get(r.pDupA.hash))
      expect(f.assign.faceMap.get(f.pDupB.hash)).toBe(r.assign.faceMap.get(r.pDupB.hash))
      // and the two physical faces land on DIFFERENT new ids (a real total
      // order was found, not a coincidental collapse to one id).
      expect(f.assign.faceMap.get(f.pDupA.hash)).not.toBe(f.assign.faceMap.get(f.pDupB.hash))
    }
  })

  it('#pairrole-dup-order: holeDiameter pass-3 total-orders a distinguishable duplicate-key pair identically in BOTH probe orders (auditor repro)', () => {
    // S_A/S_B share the SAME exact-key bucket as far as `exactMatchKey`/
    // `compareSnapshots` are concerned (sphere type never reads `normal` into
    // its key, so centroid+area+type collide) -> the shared matcher still
    // refuses the whole 2x2 bucket upstream (property 3, unchanged). But the
    // two faces are NOT a true tie: their `normal` differs, a real field
    // `compareSnapshots` leaves unused for this type. GEO-6X6-R3's
    // discriminator reads it, so the mint tail can total-order them — the
    // COMPLETE id-to-probe-hash map (which physical face gets which new id)
    // must come out IDENTICAL in both probe orders, never swapped.
    const axis: [number, number, number] = [0, 0, 1]
    const dupKeySnap = (n: [number, number, number]): GeometrySnapshot => ({ type: 'sphere', centroid: [5, 5, 5], normal: n, area: 11 })
    const snapA = dupKeySnap([1, 0, 0])
    const snapB = dupKeySnap([0, 1, 0])
    const origLegitWall = cylSnap(0, 0, 3, 90, axis)   // the hole's original wall face
    const origEntries = [
      { id: 'S_A' as StableId, snap: snapA },
      { id: 'S_B' as StableId, snap: snapB },
      { id: 'WALL' as StableId, snap: origLegitWall },
    ]
    const finalLegitWall = cylSnap(0, 0, 4, 120, axis)  // re-cut at new radius: area/centroid moved, same axis+concentric
    const run = (order: 'fwd' | 'rev') => {
      nextFpHash = 1
      const pA = fp({ ...snapA }), pB = fp({ ...snapB }), pWall = fp(finalLegitWall)
      const finalProbes = order === 'fwd' ? [pA, pB, pWall] : [pB, pA, pWall]
      const assign = engine.debugAssignEditedIdsForTest(origEntries, finalProbes, 'E1', 'holeDiameter', axis)
      return { assign, pA, pB, pWall }
    }
    const f = run('fwd'), r = run('rev')
    expect(f.assign.ok).toBe(true)
    expect(r.assign.ok).toBe(true)
    if (f.assign.ok && r.assign.ok) {
      expect(f.assign.faceMap.get(f.pWall.hash)).toBe('WALL')
      expect(r.assign.faceMap.get(r.pWall.hash)).toBe('WALL')
      expect(f.assign.modified['WALL']).toEqual(['WALL'])
      // Neither original refused id survives; both mint+delete, matching the
      // shared matcher's own refusal discipline.
      expect([...f.assign.faceMap.values()]).not.toContain('S_A')
      expect([...f.assign.faceMap.values()]).not.toContain('S_B')
      expect(f.assign.deleted.sort()).toEqual(['S_A', 'S_B'])
      expect(f.assign.generated.length).toBe(2)
      // THE auditor's exact ask: the COMPLETE id-to-probe-hash map (by which
      // PHYSICAL face — snapA's normal vs snapB's — got which new id) is
      // identical in both orders, not just the generated COUNT.
      expect(f.assign.faceMap.get(f.pA.hash)).toBe(r.assign.faceMap.get(r.pA.hash))
      expect(f.assign.faceMap.get(f.pB.hash)).toBe(r.assign.faceMap.get(r.pB.hash))
      // and the two physical faces land on DIFFERENT new ids (a real total
      // order was found, not a coincidental collapse to one id).
      expect(f.assign.faceMap.get(f.pA.hash)).not.toBe(f.assign.faceMap.get(f.pB.hash))
    }
  })

  it('#mint-true-tie: #assignEditedIds structured-refuses (never crashes, never silently mints) when mint candidates are a true total tie', () => {
    // Direct unit-level proof, independent of any upstream matcher plumbing:
    // two mint candidates identical on every field the discriminator reads
    // (type+centroid+area+normal, no axis) MUST refuse, not silently pick an
    // arbitrary order. No LEGIT/WALL face at all here — isolates the mint
    // tail's own tie-refusal from the matcher's pass-1/2 behavior.
    const tieSnap = planeSnap(1, 2, 3, 50, [0, 0, 1])
    const origEntries: Array<{ id: StableId; snap: GeometrySnapshot }> = []
    nextFpHash = 1
    const finalProbes = [fp({ ...tieSnap }), fp({ ...tieSnap })]
    const assign = engine.debugAssignEditedIdsForTest(origEntries, finalProbes, 'E9', 'faceOffset')
    expect(assign.ok).toBe(false)
    if (!assign.ok) {
      expect(assign.reason).toMatch(/true total tie/)
      expect(assign.reason).toContain('E9')
    }
  })

  it('#mint-nonfinite: #assignEditedIds structured-refuses (never orders on NaN) when a mint candidate has a non-finite geometry field', () => {
    const goodSnap = planeSnap(1, 2, 3, 50, [0, 0, 1])
    const badSnap = planeSnap(NaN, 2, 3, 50, [0, 0, 1])
    nextFpHash = 1
    const finalProbes = [fp(goodSnap), fp(badSnap)]
    const assign = engine.debugAssignEditedIdsForTest([], finalProbes, 'E9', 'faceOffset')
    expect(assign.ok).toBe(false)
    if (!assign.ok) {
      expect(assign.reason).toMatch(/non-finite/)
    }
  })
})
