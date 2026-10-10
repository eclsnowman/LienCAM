// GEO-6X6 (BK-91) — face-id lineage across a heal, on bodies that actually carry
// COPLANAR TWINS, against the real occt-wasm kernel.
//
// The pre-fix matcher keyed planar faces on `P|normal|offset` alone, so the two
// pad tops of a two-pad plate shared one map slot: whichever probe came first
// won the id and the other was re-minted as `<fid>:DELF:heal#j`. No synthetic
// fixture in the suite had two distinct coplanar faces on one solid, so nothing
// caught it. These three fixtures do.
//
//   #g1 COLLISION  heal an UNRELATED feature -> zero untouched-face re-mints
//   #g2 REBUILT    heal that untrims a planar face -> face KEEPS its id, modified[]
//   #g3 AMBIGUITY  two coplanar faces BOTH rebuilt -> mutual-nearest, deterministic
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine, exactMatchKey, planeSupportKey } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, ProfileRegion, StableId, OpResult } from '../../geom/geom-service.ts'
import type { GeometrySnapshot } from '../../geom/worker/internal-types.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'

const PLATE = { x: 60, y: 30, z: 12 }
const PAD_Z = 18            // plate top (12) + pad height (6)
const TOP: StableId = 'F1:BOX:zMax' as StableId

type Snaps = Record<StableId, GeometrySnapshot>

/** 60x30x12 plate with two 15x20 pads fused on top, 6 mm tall, at x=[5,20] and
 *  x=[40,55]. The pad TOPS are two distinct faces on the SAME plane (z=18); so
 *  are the two y=5 walls and the two y=25 walls. Three collision groups. */
async function twoPadPlate(engine: GeomEngine): Promise<BodyHandle> {
  const base = (await engine.makeBox('F1', PLATE)).body!
  const padA: ProfileRegion = { sketchId: 'SA', plane: xyPlane(12), loops: [rectLoop('SA', 5, 5, 20, 25)] }
  const withA = (await engine.makeExtrude({ featureId: 'PA', profile: padA, end: { kind: 'blind', distance: 6 }, op: 'add', target: base })).body!
  const padB: ProfileRegion = { sketchId: 'SB', plane: xyPlane(12), loops: [rectLoop('SB', 40, 5, 55, 25)] }
  return (await engine.makeExtrude({ featureId: 'PB', profile: padB, end: { kind: 'blind', distance: 6 }, op: 'add', target: withA })).body!
}

/** The planar faces at z=PAD_Z with normal +Z: the two pad tops. */
function padTops(s: Snaps): Array<[StableId, GeometrySnapshot]> {
  return (Object.entries(s) as Array<[StableId, GeometrySnapshot]>)
    .filter(([, g]) => g.type === 'plane' && Math.abs(g.centroid[2] - PAD_Z) < 1e-6 && g.normal[2] > 0.9)
    .sort((a, b) => a[1].centroid[0] - b[1].centroid[0])
}

/** How many faces sit in a plane-support group that holds MORE THAN ONE face —
 *  i.e. the population the pre-fix key collided. */
function collidingFaceCount(s: Snaps): number {
  const groups = new Map<string, number>()
  for (const g of Object.values(s)) {
    const k = planeSupportKey(g)
    if (k) groups.set(k, (groups.get(k) ?? 0) + 1)
  }
  let n = 0
  for (const c of groups.values()) if (c > 1) n += c
  return n
}

/** ids whose exact snapshot key is present BEFORE and AFTER: the untouched faces. */
function untouchedKeys(before: Snaps, after: Snaps): string[] {
  const a = new Set(Object.values(after).map(exactMatchKey))
  return Object.values(before).map(exactMatchKey).filter((k) => a.has(k))
}
function idByExactKey(s: Snaps): Map<string, StableId> {
  const m = new Map<string, StableId>()
  for (const [id, g] of Object.entries(s) as Array<[StableId, GeometrySnapshot]>) m.set(exactMatchKey(g), id)
  return m
}

describe('GEO-6X6 heal lineage on coplanar twins (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  // ---- #g1 COLLISION: heal an unrelated feature, nothing untouched re-mints ----
  it('#g1 collision fixture: healing an unrelated hole re-mints ZERO untouched faces', async () => {
    let b = await twoPadPlate(engine)
    // The feature to heal lives in pad A. Pad B's top is UNTOUCHED and is pad A's
    // top's coplanar twin, so the pre-fix key hands both tops one map slot: the
    // untouched twin either loses its id to a `DF1:DELF:heal#j` re-mint or, worse,
    // is bound to pad A's id. (A hole in the PLATE top would be the more obvious
    // unrelated feature, but healRemoval cannot close it watertight on this
    // composite body — `valid=true, solid=false` — a defeature.ts limitation this
    // WO does not own. Pad A's hole heals cleanly and collides identically.)
    const padTopA = padTops(engine.snapshotsFor(b))[0]
    b = (await engine.makeHole({
      featureId: 'H', body: b, face: padTopA[0], points: [{ x: padTopA[1].centroid[0], y: padTopA[1].centroid[1], z: PAD_Z }],
      style: { kind: 'simple', diameter: 5 }, depth: { kind: 'blind', distance: 3 },
    })).body!
    const before = engine.snapshotsFor(b)

    // the fixture really does carry the collision the WO describes: two pad tops
    // on z=18, two yMin walls on y=5, two yMax walls on y=25.
    expect(collidingFaceCount(before)).toBeGreaterThanOrEqual(6)
    const topsBefore = padTops(before)
    expect(topsBefore.length).toBe(2)
    expect(planeSupportKey(topsBefore[0][1])).toBe(planeSupportKey(topsBefore[1][1]))
    expect(topsBefore[0][0]).not.toBe(topsBefore[1][0])
    const untouchedTwin = topsBefore[1]      // pad B's top: byte-identical across the heal

    const verdicts = await engine.recognizeFeatures(b)
    const hole = verdicts.find((v) => v.featureClass === 'blindHole')
    expect(hole).toBeDefined()
    const r: OpResult = await engine.defeatureBatch({ featureId: 'DF1', body: b, featureKeys: [hole!.featureKey] })
    expect(r.ok).toBe(true)
    const after = engine.snapshotsFor(r.body!)

    // 1) every pre-heal id of an UNTOUCHED (byte-identical) face is present post-heal,
    //    bound to the SAME id.
    const beforeIds = idByExactKey(before), afterIds = idByExactKey(after)
    const untouched = untouchedKeys(before, after)
    expect(untouched.length).toBeGreaterThan(10)
    const remints: string[] = []
    for (const k of untouched) if (beforeIds.get(k) !== afterIds.get(k)) remints.push(`${beforeIds.get(k)} -> ${afterIds.get(k)}`)
    expect(remints).toEqual([])

    // 2) modified[] holds no byte-identical survivor.
    for (const id of Object.keys(r.elementMap!.modified) as StableId[]) {
      if (before[id] && after[id]) expect(Math.abs(before[id].area - after[id].area)).toBeGreaterThan(1e-6)
    }

    // 3) both pad tops kept their ids. The untouched twin was NOT re-minted and
    //    NOT bound to its rebuilt sibling's id; the rebuilt one is modified[].
    const topsAfter = padTops(after)
    expect(topsAfter.map(([id]) => id)).toEqual(topsBefore.map(([id]) => id))
    expect(after[untouchedTwin[0]]).toBeDefined()
    expect(after[untouchedTwin[0]].area).toBeCloseTo(untouchedTwin[1].area, 9)
    expect(r.elementMap!.modified[untouchedTwin[0]]).toBeUndefined()
    expect(r.elementMap!.modified[topsBefore[0][0]]).toEqual([topsBefore[0][0]])
    expect(r.elementMap!.generated.filter((id) => id.includes(':DELF:heal#'))).toEqual([])
    await engine.disposeAll()
  }, 120_000)

  // ---- #g2 REBUILT: the untrimmed planar face keeps its id (property 2) ----
  it('#g2 rebuilt fixture: the untrimmed top face KEEPS its id and lands in modified[]', async () => {
    const b0 = (await engine.makeBox('F1', PLATE)).body!
    const b = (await engine.makeHole({
      featureId: 'H', body: b0, face: TOP, points: [{ x: 30, y: 15, z: 12 }],
      style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 5 },
    })).body!
    const before = engine.snapshotsFor(b)
    expect(before[TOP]).toBeDefined()

    const r = await engine.defeatureBatch({ featureId: 'DF2', body: b })
    expect(r.ok).toBe(true)
    const after = engine.snapshotsFor(r.body!)

    // the top face was rebuilt (its hole loop was removed -> area grew) ...
    expect(after[TOP]).toBeDefined()                                    // ... but kept its id
    expect(after[TOP].area).toBeGreaterThan(before[TOP].area)
    expect(r.elementMap!.modified[TOP]).toEqual([TOP])                  // and is reported modified
    expect(r.elementMap!.deleted).not.toContain(TOP)
    await engine.disposeAll()
  }, 120_000)

  // ---- #g3 AMBIGUITY: two coplanar faces BOTH rebuilt ----
  // Documented resolution rule: the plane-support fallback sees 2 leftover
  // originals and 2 leftover probes on plane z=18. It binds only MUTUAL-nearest
  // centroid pairs. Removing an interior hole loop does not move a face's bbox
  // centroid, so each rebuilt top is at distance ~0 from its own original and
  // ~30 mm from its twin -> both pairs bind, no swap, nothing refused.
  it('#g3 ambiguity fixture: two coplanar rebuilt faces resolve by mutual-nearest, both keep ids', async () => {
    const run = async (): Promise<{ tops: Array<[StableId, GeometrySnapshot]>; modified: string[]; generated: string[] }> => {
      let b = await twoPadPlate(engine)
      const s0 = engine.snapshotsFor(b)
      const tops = padTops(s0)
      expect(tops.length).toBe(2)
      // drill one blind hole into EACH pad top -> healing both rebuilds both.
      for (const [id, g] of tops) {
        b = (await engine.makeHole({
          featureId: `HH${Math.round(g.centroid[0])}`, body: b, face: id,
          points: [{ x: g.centroid[0], y: g.centroid[1], z: PAD_Z }],
          style: { kind: 'simple', diameter: 5 }, depth: { kind: 'blind', distance: 3 },
        })).body!
      }
      const before = engine.snapshotsFor(b)
      const topsBefore = padTops(before)
      expect(topsBefore.length).toBe(2)
      expect(planeSupportKey(topsBefore[0][1])).toBe(planeSupportKey(topsBefore[1][1]))

      const verdicts = await engine.recognizeFeatures(b)
      const holes = verdicts.filter((v) => v.featureClass === 'blindHole' && v.removable)
      expect(holes.length).toBe(2)
      const r = await engine.defeatureBatch({ featureId: 'DF3', body: b, featureKeys: holes.map((h) => h.featureKey) })
      expect(r.ok).toBe(true)
      const after = engine.snapshotsFor(r.body!)
      const topsAfter = padTops(after)

      // both tops were rebuilt (area grew) AND kept their original ids: the
      // ambiguous support resolved, and it resolved WITHOUT swapping them.
      expect(topsAfter.map(([id]) => id)).toEqual(topsBefore.map(([id]) => id))
      for (let i = 0; i < 2; i++) {
        expect(topsAfter[i][1].area).toBeGreaterThan(topsBefore[i][1].area)
        expect(Math.abs(topsAfter[i][1].centroid[0] - topsBefore[i][1].centroid[0])).toBeLessThan(1e-6)
        expect(r.elementMap!.modified[topsAfter[i][0]]).toEqual([topsAfter[i][0]])
      }
      const out = {
        tops: topsAfter,
        modified: Object.keys(r.elementMap!.modified).sort(),
        generated: [...r.elementMap!.generated].sort(),
      }
      await engine.disposeAll()
      return out
    }

    // deterministic across runs: same ids, same paths, same delta.
    const a = await run()
    const c = await run()
    expect(c.tops.map(([id]) => id)).toEqual(a.tops.map(([id]) => id))
    expect(c.modified).toEqual(a.modified)
    expect(c.generated).toEqual(a.generated)
  }, 180_000)
})
