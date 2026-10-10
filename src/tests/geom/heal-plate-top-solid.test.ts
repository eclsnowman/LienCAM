// GEO-11 (BK-97) — a blind hole drilled in the PLATE TOP of a body carrying fused
// extrude-add bosses must heal to a genuine watertight SOLID, not a silent shell.
//
// Root cause (see coordination/evidence/GEO-11/ and defeature.ts): a fused boss
// raises the body's bbox above the plate top, so the plate top reads !onBodyBBox
// and its area-weighted centroid sits on the drilled hole's axis. The blind-hole
// recognizer's CENTROID-only cap test then mis-tagged the whole plate top as the
// hole's FLOOR and dropped it into `dropHashes`. `healRemoval` skips dropped faces
// before it reaches the host-untrim branch, so the plate top was removed entirely
// and never rebuilt — the sew closed into an open-topped shell (valid:true,
// solid:false), which the engine reported as success on nothing.
//
// The fix (defeature.ts `capWithinFootprint`) gates a cap on its full radial
// EXTENT from the hole axis, not just its centroid: a real floor/shoulder fits
// inside the bore footprint; a structural slab reaches far past it and is kept.
//
// #p1 KERNEL   healRemoval on the raw composite -> isValid && isSolid, vol restored.
// #p2 ENGINE   defeatureBatch on the same body -> ok, +delta, plate-top lineage kept.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { recognizeFeatures, healRemoval, gatherFaces, releaseFaceRecs } from '../../geom/worker/defeature.ts'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, ProfileRegion, StableId, DefeatureResult } from '../../geom/geom-service.ts'
import type { GeometrySnapshot } from '../../geom/worker/internal-types.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'

const PLATE = { x: 60, y: 30, z: 12 }
const PAD_Z = 18  // plate top (12) + pad height (6)

// ---------------------------------------------------------------------------
// #p1 KERNEL — the crisp valid&&solid assertion against the real occt-wasm kernel.
// ---------------------------------------------------------------------------
describe('GEO-11 plate-top heal is a watertight solid (raw kernel)', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* */ } })

  it('#p1 blind hole in the plate top of a two-boss body heals to a SOLID with restored volume', () => {
    // 60x30x12 plate with two 15x20x6 pads fused on top at x=[5,20],[40,55], y=[5,25].
    const plate = k.makeBox(60, 30, 12)
    const pad1 = k.translate(k.makeBox(15, 20, 6), 5, 5, 12)
    const pad2 = k.translate(k.makeBox(15, 20, 6), 40, 5, 12)
    const body = k.fuse(k.fuse(plate, pad1), pad2)
    const v0 = k.getVolume(body)               // 21600 + 2*1800 = 25200
    expect(Math.abs(v0 - 25200), `two-boss body volume (got ${v0})`).toBeLessThan(1e-3)

    // Blind hole d=5, depth 3, drilled DOWN into the plate top between the pads.
    const tool = k.translate(k.makeCylinder(2.5, 6), 30, 15, 9)
    const drilled = k.cut(body, tool)
    const vDrilled = k.getVolume(drilled)
    expect(vDrilled).toBeLessThan(v0)          // material removed by the hole

    const recs = gatherFaces(k, drilled)
    const feats = recognizeFeatures(k, drilled, recs)
    const holes = feats.filter((f) => f.removable && (f.type === 'blindHole' || f.type === 'throughHole'))
    expect(holes.length, 'the drilled plate-top blind hole is recognized and removable').toBe(1)

    const scratch: ShapeHandle[] = []
    const heal = healRemoval(k, drilled, holes, scratch, recs)

    // THE GATE (fails against pre-fix code — the host slab was dropped -> shell):
    expect(heal.ok, `heal must succeed: ${heal.reason ?? ''}`).toBe(true)
    const healed = heal.shape as ShapeHandle
    expect(healed, 'a healed shape is returned on success').toBeDefined()
    expect(k.isSolid(healed), 'healed result is a solid, not a shell').toBe(true)
    expect(k.isValid(healed), 'healed result is a valid solid').toBe(true)

    const vHealed = k.getVolume(healed)
    expect(Number.isFinite(vHealed), 'healed volume is finite').toBe(true)
    expect(vHealed, 'healed volume is positive').toBeGreaterThan(0)
    // filling the blind hole restores the sharp two-boss body -> back to v0.
    expect(Math.abs(vHealed - v0), `volume restored to ${v0} (got ${vHealed})`).toBeLessThan(1e-3)
    // volumeDelta is the material added back = the hole volume pi*2.5^2*3 ~ 58.90.
    expect(heal.volumeDelta, 'positive material-added-back delta').toBeGreaterThan(0)
    expect(Math.abs((heal.volumeDelta as number) - Math.PI * 2.5 * 2.5 * 3)).toBeLessThan(0.5)

    for (const s of scratch) if (s !== healed) { try { k.release(s) } catch { /* */ } }
    try { k.release(healed) } catch { /* */ }
    releaseFaceRecs(k, recs)
    try { k.release(drilled) } catch { /* */ }
    try { k.release(body) } catch { /* */ }
  }, 120_000)
})

// ---------------------------------------------------------------------------
// #p2 ENGINE — same body through the app engine, in heal-lineage-coplanar's
// conventions: the heal succeeds AND the plate-top lineage is consistent.
// ---------------------------------------------------------------------------
type Snaps = Record<StableId, GeometrySnapshot>

async function twoPadPlate(engine: GeomEngine): Promise<BodyHandle> {
  const base = (await engine.makeBox('F1', PLATE)).body!
  const padA: ProfileRegion = { sketchId: 'SA', plane: xyPlane(12), loops: [rectLoop('SA', 5, 5, 20, 25)] }
  const withA = (await engine.makeExtrude({ featureId: 'PA', profile: padA, end: { kind: 'blind', distance: 6 }, op: 'add', target: base })).body!
  const padB: ProfileRegion = { sketchId: 'SB', plane: xyPlane(12), loops: [rectLoop('SB', 40, 5, 55, 25)] }
  return (await engine.makeExtrude({ featureId: 'PB', profile: padB, end: { kind: 'blind', distance: 6 }, op: 'add', target: withA })).body!
}

/** the plate TOP face: planar, +Z, centroid at z=12 (below the z=18 pad tops). */
function plateTop(s: Snaps): [StableId, GeometrySnapshot] {
  const hit = (Object.entries(s) as Array<[StableId, GeometrySnapshot]>)
    .find(([, g]) => g.type === 'plane' && Math.abs(g.centroid[2] - 12) < 1e-6 && g.normal[2] > 0.9)
  if (!hit) throw new Error('plate top face not found')
  return hit
}
function padTops(s: Snaps): Array<[StableId, GeometrySnapshot]> {
  return (Object.entries(s) as Array<[StableId, GeometrySnapshot]>)
    .filter(([, g]) => g.type === 'plane' && Math.abs(g.centroid[2] - PAD_Z) < 1e-6 && g.normal[2] > 0.9)
    .sort((a, b) => a[1].centroid[0] - b[1].centroid[0])
}

describe('GEO-11 plate-top heal lineage (engine, real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#p2 defeatureBatch heals the plate-top hole to a solid and keeps plate-top + pad-top lineage', async () => {
    let b = await twoPadPlate(engine)
    const s0 = engine.snapshotsFor(b)
    const topId = plateTop(s0)[0]
    const topCentroid = plateTop(s0)[1].centroid
    const padTopIdsBefore = padTops(s0).map(([id]) => id)
    expect(padTopIdsBefore.length).toBe(2)

    // drill a blind hole into the plate top, between the two pads.
    b = (await engine.makeHole({
      featureId: 'H', body: b, face: topId,
      points: [{ x: topCentroid[0], y: topCentroid[1], z: 12 }],
      style: { kind: 'simple', diameter: 5 }, depth: { kind: 'blind', distance: 3 },
    })).body!
    const before = engine.snapshotsFor(b)
    expect(before[topId], 'plate top survives the drill with its id').toBeDefined()

    const verdicts = await engine.recognizeFeatures(b)
    const hole = verdicts.find((v) => v.featureClass === 'blindHole')
    expect(hole, 'the plate-top blind hole is recognized').toBeDefined()

    const r: DefeatureResult = await engine.defeatureBatch({ featureId: 'DF', body: b, featureKeys: [hole!.featureKey] })
    // THE GATE (pre-fix: defeatureBatch reports ok:false — 0 of 1 healed, the heal
    // could not reach a watertight solid):
    expect(r.ok, `defeature must succeed: ${JSON.stringify(r.diagnostics ?? [])}`).toBe(true)
    expect(r.report!.healed, 'exactly one feature healed').toBe(1)
    expect(r.report!.failed, 'no heal failures').toBe(0)
    // filling the hole ADDS material back -> positive, finite delta.
    expect(Number.isFinite(r.report!.totalVolumeDelta)).toBe(true)
    expect(r.report!.totalVolumeDelta, 'material added back is positive').toBeGreaterThan(0)

    const after = engine.snapshotsFor(r.body!)
    // the plate top was rebuilt (its hole loop removed -> area grew) but KEPT its id.
    expect(after[topId], 'plate top keeps its id across the heal').toBeDefined()
    expect(after[topId].area, 'plate top area grew back (hole loop removed)').toBeGreaterThan(before[topId].area)
    expect(r.elementMap!.modified[topId], 'plate top is reported modified, mapped to itself').toEqual([topId])
    // the two pad tops are UNTOUCHED: same ids, not modified, no DELF re-mint.
    const padTopIdsAfter = padTops(after).map(([id]) => id)
    expect(padTopIdsAfter).toEqual(padTopIdsBefore)
    for (const id of padTopIdsBefore) expect(r.elementMap!.modified[id]).toBeUndefined()
    expect(r.elementMap!.generated.filter((id) => id.includes(':DELF:heal#'))).toEqual([])

    await engine.disposeAll()
  }, 120_000)
})
