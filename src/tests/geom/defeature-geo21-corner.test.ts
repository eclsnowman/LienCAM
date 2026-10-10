// GEO-21-R1 (BK-63) acceptance harness — real 87-face vendor plate
// (step-test-with-holes.step) + a kernel-built chamfered box, real kernel, real
// engine consumer.
//
// WHAT R1 OVERTURNED. GEO-21 shipped deliverable 2 as DISPROVEN: it measured that
// flipping the 12 bands removable made all 12 heals fail inside the corner untrim,
// and concluded no single-band construction could rebuild a box-corner cap. The
// measurement was real; the conclusion was not. It proved only that ONE
// construction fails — sharpCornerWire's flanking-edge crossing — and GEO-21's own
// report named the candidate it never tried: retrim the cap against the EXTENDED
// HOST planes. That construction works, and this file is its proof.
//
// WHY THE OLD ONE COLLAPSED, in one line: the rebuilt corner Q is a property of the
// HOSTS (it is where their sharp line pierces the end face's plane), not of the end
// face's own flanking edges. Those two agree whenever the flanks lie in the host
// planes — every ordinary end face, which is why GEO-7 worked — and disagree at a
// box-corner cap, whose flanks are shared with the two OTHER bands and converge on
// the far vertex. Deriving Q from the hosts makes both topologies one construction.
//
// THE THIRD BAND. Retrimming alone is not enough: by the third removal at a corner
// the cap's only surviving neighbours are three WALLS meeting at the very vertex the
// cap cuts off, so retrimming leaves a spurious facet chopping the box corner (§3
// pins the exact stray-facet signature R1 removed). Such a cap is DROPPED and the
// third wall rebuilds to the restored vertex. Nothing detects "the third band" by
// counting: the collapsed state is proven on the geometry, and sequential
// re-recognition (defeatureBatch's own loop) walks the corner into it.
//
// §5 is the mutation proof. Evidence under coordination/evidence/GEO-21/R1/.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle } from '../../geom/geom-service.ts'
import { gatherFaces, recognizeFeatures, healRemoval, releaseFaceRecs, cornerRefusalReason } from '../../geom/worker/defeature.ts'
import type { FaceRec, RecognizedFeature, CornerUntrimFailKind } from '../../geom/worker/defeature.ts'

const FIX = join(process.cwd(), 'src/tests/geom/fixtures')
const PLATE = 'step-test-with-holes.step'
const HM = 1 << 30
function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIX, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}
/** local re-implementation of the recognizer's own bbox + axis-aligned test, so
 *  the expectation is derived from GEOMETRY here rather than from the code under
 *  test agreeing with itself. */
function bodyBBox(recs: FaceRec[]) {
  const bb = { xmin: Infinity, ymin: Infinity, zmin: Infinity, xmax: -Infinity, ymax: -Infinity, zmax: -Infinity }
  for (const r of recs) {
    bb.xmin = Math.min(bb.xmin, r.bbox.xmin); bb.ymin = Math.min(bb.ymin, r.bbox.ymin); bb.zmin = Math.min(bb.zmin, r.bbox.zmin)
    bb.xmax = Math.max(bb.xmax, r.bbox.xmax); bb.ymax = Math.max(bb.ymax, r.bbox.ymax); bb.zmax = Math.max(bb.zmax, r.bbox.zmax)
  }
  return bb
}
function isAxisAlignedOnBBox(f: FaceRec, bb: ReturnType<typeof bodyBBox>): boolean {
  const n = f.normal
  if (!(Math.abs(n.x) > 0.99 || Math.abs(n.y) > 0.99 || Math.abs(n.z) > 0.99)) return false
  const eps = 1e-3, c = f.centroid
  return Math.abs(c.x - bb.xmin) < eps || Math.abs(c.x - bb.xmax) < eps ||
    Math.abs(c.y - bb.ymin) < eps || Math.abs(c.y - bb.ymax) < eps ||
    Math.abs(c.z - bb.zmin) < eps || Math.abs(c.z - bb.zmax) < eps
}

describe('GEO-21-R1 (BK-63): box-corner chamfer bands — host-plane corner retrim + collapsed-cap drop', () => {
  let k: OcctKernel
  let shape: ShapeHandle
  let recs: FaceRec[]
  let feats: RecognizedFeature[]
  let chamfers: RecognizedFeature[]
  let bb: ReturnType<typeof bodyBBox>
  let byHash: Map<number, FaceRec>

  beforeAll(async () => {
    k = await OcctKernel.init()
    shape = k.importStep(fixtureBytes(PLATE))
    recs = gatherFaces(k, shape)
    bb = bodyBBox(recs)
    byHash = new Map(recs.map((r) => [r.hash, r]))
    feats = recognizeFeatures(k, shape, recs)
    chamfers = feats.filter((f) => f.type === 'chamferPlanar')
  }, 120_000)
  afterAll(() => {
    try { releaseFaceRecs(k, recs) } catch { /* */ }
    try { k.release(shape) } catch { /* */ }
    try { k[Symbol.dispose]() } catch { /* */ }
  })

  // ---- §1 DELIVERABLE 1: F2 pair disambiguation, asserted by PAIR IDENTITY ----
  it('#1 identifies the STRUCTURAL host pair on every one of the 12 bands (pair identities, not ok:true)', () => {
    expect(chamfers.length).toBe(12)

    for (const c of chamfers) {
      const band = byHash.get(c.dropHashes[0])!
      expect(band).toBeDefined()
      const nbrs = band.neighbours.map((h) => byHash.get(h)!).filter(Boolean)

      // the fixture's own geometry says which two neighbours are the structural
      // walls (axis-aligned on the body bbox) and which two are the tilted
      // corner caps — GEO-20 fact F2, re-derived here from the FaceRecs.
      const structural = nbrs.filter((n) => isAxisAlignedOnBBox(n, bb)).map((n) => n.hash).sort((a, b) => a - b)
      const caps = nbrs.filter((n) => !isAxisAlignedOnBBox(n, bb)).map((n) => n.hash).sort((a, b) => a - b)

      // non-vacuous: the ambiguity this WO resolves must actually be present —
      // 4 planar neighbours, 2 structural + 2 corner caps, on EVERY band.
      expect(nbrs.length).toBe(4)
      expect(structural.length).toBe(2)
      expect(caps.length).toBe(2)

      // THE DELIVERABLE: the identified host pair is exactly the structural pair.
      expect(c.hostPair).toBeDefined()
      expect([...c.hostPair!].sort((a, b) => a - b)).toEqual(structural)
      // and provably NOT a pair involving a corner cap (the pre-GEO-21 ambiguity).
      for (const capHash of caps) expect(c.hostPair).not.toContain(capHash)

      // R1: the pair is not merely identified, it is BUILDABLE — the band carries a
      // real untrim plan against exactly that pair, and promises removal.
      expect(c.removable).toBe(true)
      expect(c.refuseReason).toBeUndefined()
      expect(c.untrimPlan).toBeDefined()
      expect([c.untrimPlan!.planeA, c.untrimPlan!.planeB].sort((a, b) => a - b)).toEqual(structural)
      // on the ORIGINAL body every cap still has three bands on it, so nothing is a
      // collapsed corner yet: both caps are RETRIMMED, none dropped.
      expect([...c.untrimPlan!.endFaces].sort((a, b) => a - b)).toEqual(caps)
      expect(c.untrimPlan!.cornerDrops ?? []).toEqual([])
      expect(c.dropHashes).toEqual([band.hash])
    }
  }, 120_000)

  // ---- §2 the shared corner cap (F3) and the double-claim BK-63 names ----
  it('#2 each cap is shared by exactly 3 bands, and healing two of them TOGETHER refuses rather than rebuilding the cap twice', () => {
    const capShare = new Map<number, string[]>()
    for (const c of chamfers) {
      const band = byHash.get(c.dropHashes[0])!
      for (const h of band.neighbours) {
        const n = byHash.get(h)
        if (!n || isAxisAlignedOnBBox(n, bb)) continue
        if (!capShare.has(h)) capShare.set(h, [])
        capShare.get(h)!.push(c.key)
      }
    }
    // 8 box corners, each cap contested by exactly the 3 bands meeting there (F3).
    expect(capShare.size).toBe(8)
    for (const [, keys] of capShare) expect(keys.length).toBe(3)

    // BK-63's hazard is REAL now that the bands are removable: three bands each name
    // the same cap as an end face, so a single heal call given two of them would
    // rebuild that cap twice (second plan wins) while dropping both bands — a valid
    // solid built from a plan that was silently discarded. It must FAIL CLOSED.
    const [capHash, keys] = [...capShare.entries()][0]
    expect(keys.length).toBe(3)
    const a = chamfers.find((c) => c.key === keys[0])!
    const b = chamfers.find((c) => c.key === keys[1])!
    // non-vacuous: these two really do both claim the same cap.
    expect(a.untrimHashes).toContain(capHash)
    expect(b.untrimHashes).toContain(capHash)

    const scratch: ShapeHandle[] = []
    const together = healRemoval(k, shape, [a, b], scratch, recs)
    for (const s of scratch) { try { k.release(s) } catch { /* */ } }
    expect(together.ok).toBe(false)
    expect(together.reason).toMatch(/both rebuild face/)
    expect(together.reason).toMatch(/one at a time/)
  }, 120_000)

  // ---- §3 DELIVERABLE 2: select-all on the PLATE heals every band, and the corner
  //         caps are GONE — the analytic post-heal form of a fully de-chamfered box.
  it('#3 select-all: all 12 bands heal BY KEY, every corner cap vanishes, and the plate returns to an exactly sharp box', () => {
    const wanted = chamfers.map((c) => c.key).sort()
    expect(wanted.length).toBe(12)

    // defeatureBatch's own loop: re-gather + re-recognize + re-match by featureKey
    // before EVERY heal. That sequence is what walks each corner from "three bands"
    // to the collapsed state the cap drop needs — no ordering is imposed here.
    const healedKeys: string[] = []
    let cur = k.copy(shape)
    const v0 = k.getVolume(shape)
    for (const key of wanted) {
      const curRecs = gatherFaces(k, cur)
      const scratch: ShapeHandle[] = []
      try {
        const match = recognizeFeatures(k, cur, curRecs).find((f) => f.key === key)
        expect(match, `band ${key} must still be found on the regenerated body`).toBeDefined()
        expect(match!.removable, `band ${key} must still be removable: ${match!.refuseReason}`).toBe(true)
        const heal = healRemoval(k, cur, [match!], scratch, curRecs)
        // (i) EVERY band, BY KEY, heals — never a count.
        expect(heal.ok, `band ${key} failed to heal: ${heal.ok ? '' : heal.reason}`).toBe(true)
        expect(Number.isFinite(heal.volumeDelta)).toBe(true)
        healedKeys.push(key)
        for (const s of scratch) { if (s !== heal.shape) { try { k.release(s) } catch { /* */ } } }
        try { k.release(cur) } catch { /* */ }
        cur = heal.shape!
      } finally { releaseFaceRecs(k, curRecs) }
    }
    expect(healedKeys.sort()).toEqual(wanted)

    // (ii) THE POST-HEAL FORM. An 8-corner box with all 12 edges chamfered returns
    // to a SHARP box: the caps do not survive "once" in some retrimmed form — they
    // must be GONE. Face census + exact analytic face geometry, not "valid solid".
    const finalRecs = gatherFaces(k, cur)
    expect(k.isValid(cur)).toBe(true)
    expect(k.isSolid(cur)).toBe(true)
    // 87 original - 12 bands - 8 caps. Pins the exact defect R1 removed: retrimming
    // (rather than dropping) the third band's cap leaves 8 stray 0.866mm^2 facets
    // chopping the box corners, and this census reads 75 instead of 67.
    expect(finalRecs.length).toBe(67)
    const stray = finalRecs.filter((r) => r.type === 'plane' && r.area < 1)
    expect(stray.map((r) => Number(r.area.toFixed(4)))).toEqual([])

    // the four side walls and the floor are now the FULL sharp rectangles of an
    // 80 x 80 x 14 box (they measured 79 x 13 = 1027 and 79 x 79 = 6241 while the
    // chamfers were there), and every restored corner is a real box vertex.
    const planes = finalRecs.filter((r) => r.type === 'plane')
    const walls = planes.filter((r) => Math.abs(Math.abs(r.normal.z)) < 0.01 && r.area > 500)
    expect(walls.length).toBe(4)
    for (const w of walls) expect(w.area).toBeCloseTo(80 * 14, 6)
    const floor = planes.find((r) => r.normal.z < -0.99 && r.area > 500)!
    expect(floor.area).toBeCloseTo(80 * 80, 6)
    // the holed top face keeps ALL 13 hole loops: untrimming a face rebuilds it from
    // its OUTER wire, so without the inner-wire re-attach the plate's holes would be
    // silently FILLED here (the sew then reports solid=false, +3146mm^3).
    const top = planes.find((r) => r.normal.z > 0.99 && r.innerLoops > 0)!
    expect(top.innerLoops).toBe(13)

    // (iii) the volume delta is the material the chamfers actually removed. The
    // plate's imported chamfers are NOT an ideal 0.5 chamfer (a kernel chamfer of the
    // same 80x80x14 box removes 86.3333; this fixture's measure 86.8106 — a fixture
    // property, disclosed in the report), so the ANALYTIC assertion lives on the
    // kernel-built box in #4, where the expected value is exact. What is analytic
    // HERE is the post-heal solid itself: sharp-box faces to 1e-6, asserted above.
    const delta = k.getVolume(cur) - v0
    expect(delta).toBeCloseTo(86.8106, 3)
    releaseFaceRecs(k, finalRecs)
    try { k.release(cur) } catch { /* */ }
  }, 300_000)

  // ---- §4 DELIVERABLE 2(iii): the ANALYTIC volume, on geometry whose exact answer
  //         is known in closed form — a kernel-built chamfered box.
  it('#4 a chamfered box heals back to the EXACT sharp box: 6 faces and the closed-form chamfer volume', () => {
    const [L, W, H, D] = [20, 16, 10, 0.5]
    const box = k.makeBox(L, W, H)
    const edges = k.getSubShapes(box, 'edge')
    expect(edges.length).toBe(12)
    const solid = k.chamferWithHistory(box, edges, D, [], HM).result
    for (const e of edges) { try { k.release(e) } catch { /* */ } }

    // closed form: 12 edge prisms of cross-section D^2/2, less the 8 corners where
    // the three prisms and the corner cap overlap ((2/3)D^3 each). Derived here, not
    // read back from the code under test, and cross-checked against the kernel's own
    // chamfer by the non-vacuity assertion below.
    const analytic = (D * D / 2) * (4 * L + 4 * W + 4 * H) - 8 * (2 / 3) * (D * D * D)
    const v0 = k.getVolume(solid)
    // non-vacuous: the fixture really is chamfered by exactly that much.
    expect(L * W * H - v0).toBeCloseTo(analytic, 6)

    let cur = k.copy(solid), healed = 0
    for (;;) {
      const curRecs = gatherFaces(k, cur)
      const scratch: ShapeHandle[] = []
      try {
        const t = recognizeFeatures(k, cur, curRecs).find((f) => f.type === 'chamferPlanar' && f.removable)
        if (!t) break
        const heal = healRemoval(k, cur, [t], scratch, curRecs)
        expect(heal.ok, `heal ${t.key} failed: ${heal.ok ? '' : heal.reason}`).toBe(true)
        healed++
        for (const s of scratch) { if (s !== heal.shape) { try { k.release(s) } catch { /* */ } } }
        try { k.release(cur) } catch { /* */ }
        cur = heal.shape!
      } finally { releaseFaceRecs(k, curRecs) }
    }
    expect(healed).toBe(12)

    const finalRecs = gatherFaces(k, cur)
    expect(k.isValid(cur)).toBe(true)
    expect(k.isSolid(cur)).toBe(true)
    // a sharp box and nothing else: 6 faces, exact areas, exact volume.
    expect(finalRecs.length).toBe(6)
    const areas = finalRecs.map((r) => Number(r.area.toFixed(6))).sort((a, b) => a - b)
    expect(areas).toEqual([L * H, L * H, W * H, W * H, L * W, L * W].sort((a, b) => a - b))
    expect(k.getVolume(cur)).toBeCloseTo(L * W * H, 6)
    // THE ANALYTIC DELTA (deliverable 2(iii)): the summed heal delta equals the
    // closed-form chamfer volume — not merely positive or finite.
    expect(k.getVolume(cur) - v0).toBeCloseTo(analytic, 9)
    releaseFaceRecs(k, finalRecs)
    try { k.release(cur); k.release(solid); k.release(box) } catch { /* */ }
  }, 300_000)

  // ---- §4b AUDIT MAJOR 2: a corner failure says only what it PROVED ----
  //
  // GEO-21 mapped EVERY cornerUntrimPoints null — six distinct construction failures —
  // onto one confident diagnosis: "a shared corner facet ... where three fillets/
  // chamfers meet". A generic null never established that topology, so any other band
  // whose corner construction failed got a confidently WRONG story. R1 returns a
  // structured kind and derives the text from it. This asserts the mapping directly
  // (it is a pure function), so every kind is covered — not just the ones this
  // fixture happens to reach.
  it('#4b every corner-failure kind renders distinct, honest text that never claims the three-band topology', () => {
    const kinds: CornerUntrimFailKind[] = [
      'endFaceBoundaryUnreadable', 'noSharedEdgeWithRemovedFace', 'removedFaceCoversEndFace',
      'noContiguousRun', 'degenerateRun', 'hostPlanesParallel', 'hostLineParallelToEndFace',
      'sharpCornerOutsideBody', 'flankingEdgesParallel', 'rebuiltBoundaryDegenerate',
    ]
    const seen = new Set<string>()
    for (const kind of kinds) {
      const text = cornerRefusalReason(kind, `end face @(1,2,3) hit ${kind}`)
      // DISTINCT: no two kinds collapse to the same story (the GEO-21 defect).
      expect(seen.has(text)).toBe(false)
      seen.add(text)
      // HONEST: never asserts the specific three-band corner topology, which none of
      // these kinds proves.
      expect(text).not.toMatch(/three fillets\/chamfers meet/)
      expect(text).not.toMatch(/shared corner facet/)
      // NAMED: carries the kind, so a bug report says which construction gave out.
      expect(text).toContain(kind)
      // renders in the picker row (DefeatureDialog.tsx:167): one line, bounded.
      expect(text).not.toContain('\n')
      expect(text.length).toBeLessThanOrEqual(240)
    }
    expect(seen.size).toBe(kinds.length)
  })

  // ---- §5 the ENGINE consumer: select-all through the real batch path ----
  //
  // MUTATION PROOF (charter §6) for the construction this WO delivers, recorded in
  // coordination/evidence/GEO-21/R1/:
  //   mutation-01-RED.log   — the host-derived corner disabled (cornerUntrimPoints'
  //                           host-pair branch forced onto GEO-21's flanking-edge
  //                           crossing) => EXIT CODE: 1.
  //   mutation-02-GREEN.log — source restored byte-identical from the committed
  //                           preimage => EXIT CODE: 0.
  it('#5 select-all via the real engine: all 12 bands are accepted and healed, none refused', async () => {
    const engine = new GeomEngine()
    await engine.init()
    try {
      const { bodies } = await engine.importStep(fixtureBytes(PLATE), 'GEO21')
      const b: BodyHandle = bodies[0].handle
      const verdicts = await engine.recognizeFeatures(b)
      const chamferVerdicts = verdicts.filter((v) => v.featureClass === 'chamferPlanar')
      expect(chamferVerdicts.length).toBe(12)
      expect(chamferVerdicts.every((v) => v.removable === true)).toBe(true)

      const res = await engine.defeatureBatch({ featureId: 'DEF1', body: b })
      const report = res.report!
      expect(report).toBeDefined()

      // WO-2079: this pocket owns four absorbed b-spline surfaces, but only the
      // two narrow upper edge blends are independently removable. The two broad
      // side walls remain part of the pocket; advertising them as fillets made
      // select-all report two native no-ops. Pin the actual fillet rows by
      // geometry-derived feature key.
      const absorbed = verdicts.filter((v) => v.params.surfaceKind === 'bspline' && v.params.absorbedBy === 'loop:0:0:0')
      expect(absorbed.length).toBe(4)
      const importedFilletKeys = absorbed.filter((v) => v.removable).map((v) => v.featureKey).sort()
      expect(importedFilletKeys).toEqual([
        'absorbed:bspline:loop:0:0:0:-0.0001:-11.6428:-0.2514',
        'absorbed:bspline:loop:0:0:0:-0.0057:11.6421:-0.2514',
      ])
      expect(absorbed.filter((v) => !v.removable).length).toBe(2)

      // (i) an entry for EVERY band BY featureKey, each healed — never a count.
      const chamferItems = report.items.filter((i) => i.featureClass === 'chamferPlanar')
      expect(chamferItems.map((i) => i.featureKey).sort()).toEqual(chamferVerdicts.map((v) => v.featureKey).sort())
      for (const i of chamferItems) expect(i.healed, `${i.featureKey}: ${i.reason}`).toBe(true)
      const importedFilletItems = report.items.filter((i) => importedFilletKeys.includes(i.featureKey))
      expect(importedFilletItems.map((i) => i.featureKey).sort()).toEqual(importedFilletKeys)
      expect(importedFilletItems.every((i) => i.healed)).toBe(true)
      expect(report.refused).toBe(0)

      // non-vacuous, pinned to a MEASURED count: 26. Pre-R1 this plate healed 20 —
      // the 12 bands all refused, and the 8 corner caps came through as standalone
      // `sliver` rows that healed on their own. R1 hands each cap to the band that
      // owns it (+12 bands, -8 slivers), so no sliver is emitted for a claimed cap.
      // That -8 is the point of the claim fix: leaving those rows in place made
      // select-all remove the band first and then report 8 "feature not found on the
      // regenerated body" rows — removals silently dropped inside a "successful" batch.
      // WO-2079 adds the two independently removable pocket fillets pinned above.
      expect(report.healed).toBe(26)
      expect(verdicts.filter((v) => v.featureClass === 'sliver').length).toBe(0)
      expect(report.items.some((i) => (i.reason ?? '').includes('feature not found'))).toBe(false)
      expect(Number.isFinite(report.totalVolumeDelta)).toBe(true)

      // the ONE pre-existing non-heal on this fixture is the pocket, fail-LOUD
      // already and outside this WO's fence (measured identical before and after —
      // coordination/evidence/GEO-21/diag-batch-before.json). Pinned so GEO-21-R1
      // cannot hide behind it and a NEW failure of any class still turns this red.
      const notHealed = report.items.filter((i) => !i.healed)
      expect(notHealed.length).toBe(1)
      expect(notHealed[0].featureClass).toBe('pocket')
      expect(notHealed[0].reason).toMatch(/did not reach a watertight solid/)

      // the pre-R1 post-promise kernel failure string must never reach a user.
      for (const i of report.items) expect(i.reason ?? '').not.toMatch(/corner untrim of end face/)
    } finally {
      await engine.disposeKernel()
    }
  }, 300_000)
})
