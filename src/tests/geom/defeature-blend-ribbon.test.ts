// GEO-6X5 (BK-89) — adoption of the GEO-6X4 Path C proof: bounded analytic
// blend-ribbon defeaturing in the product.
// =====================================================================
// The pre-GEO-6X5 recognizer refused EVERY torus ("parallel-kernel class").
// GEO-6X4 proved the sharp corner IS reconstructible with the exposed kernel
// primitives once (a) the corner is solved on a structurally TRANSVERSAL surface
// triple and (b) the rebuilt face on a non-planar support gets its pcurves back.
// These tests pin both, plus the class boundary that keeps everything else refused.
//
// Fails-if guards (WO GEO-6X5 acceptance criterion 3 — both mutation-proved, see
// coordination/reports/GEO-6X5.report.json > mutationProofs):
//   - MANDATORY GUARD 1 (F2): deleting the `fixShape()` pcurve repair in
//     rebuildBlendWalls() makes #1 fail — makeFaceOnSurface() returns a SILENT
//     zero-area face on the cylinder wall; the body still sews CLOSED and solid,
//     with volDelta 4821.54 instead of 8.813.
//   - MANDATORY GUARD 2 (F1): solving the corner on the (cylinder, sidePlane,
//     endPlane) triple that CORNER-BLEND-RESEARCH.md step 4 prescribed makes #1
//     fail — that triple is singular by construction, and a perturbed seed makes
//     it merely ill-conditioned, so Newton returns a wrong point with no signal.
//   - MANDATORY GUARD 3 (GEO-6X5-R1, audit major 1): accepting a same-radius
//     neighbour without verifying G1 tangency makes #6 fail. Note that #1-#5 all
//     still PASS under that mutation — the Tray contains no same-radius transverse
//     neighbour, so only the synthetic negative in #6 can hold this gate honest.
//     That is precisely how the missing gate survived into the audit.
//   - MANDATORY GUARD 4 (GEO-6X5-R2, audit major): SKIPPING a same-radius neighbour
//     whose analytic frame will not derive (`if (!fr) continue`) makes #7 fail. A gate
//     you can walk around is not a gate: verifying tangency wherever you look is not the
//     same as looking everywhere. #1-#6 all still PASS under that mutation.
//   - MANDATORY GUARD 5 (GEO-6X5-R2, audit minor): counting measureG1()'s samples in
//     ONE aggregate instead of per shared edge makes #8 fail. With an aggregate, a
//     readable edge's samples vouch for an unreadable edge between the same two faces,
//     and that second boundary goes unverified while the pair reports success.
//   - MANDATORY GUARD 6 (GEO-6X5-R3, audit major): removing the per-sample finite-guard in
//     measureG1() makes #8c/#8d fail. A returned point or normal can be non-finite WITHOUT
//     throwing (curvePointAtParam handing back NaN, or an analytic frame computing a NaN
//     normal); without the guard, that sample is counted as usable and a NaN rides all the
//     way into the returned G1Measure, which the caller's `> tolerance` comparisons then
//     treat as tangent (NaN > tol is false either way) — an unmeasurable boundary admitted.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AnalyticFrame, CylFrame, FaceRec, PlaneFrame } from '../../geom/worker/defeature.ts'
import {
  recognizeFeatures, healRemoval, gatherFaces, releaseFaceRecs, HM,
  analyzeBlendRibbon, buildEdgeOwners, measureG1,
} from '../../geom/worker/defeature.ts'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

const FIX = join(process.cwd(), 'src/tests/geom/fixtures')

/** The GEO-6X4 probe target: Tray.step face #223, the R=1 fillet ribbon around the
 *  mouth of the radius-12 U-channel. Its geometry-derived key is stable across runs. */
const TARGET_KEY = 'curved:37.1437:-42.5:-7.8756'
const TARGET_AREA = 61.011      // mm^2, the torus band area (GEO-6X4 premise gate P1)
const ORIGINAL_FACES = 696
const HEALED_FACES = 691        // 696 - 5 (3 ribbon + 2 runout cones)
const VOL_DELTA = 8.813         // mm^3, POSITIVE: sharpening a rounded CONVEX edge adds material

/** The named gate GEO-6X5-R1 added: a same-radius neighbour that is not G1-tangent. */
const G1_GATE = 'not tangentially'

/** The named gates GEO-6X5-R2 added, one per path on which G1 cannot be VERIFIED. */
const CYL_FRAME_GATE = 'a same-radius adjacent cylinder\'s analytic frame could not be derived'
const TORUS_FRAME_GATE = 'an adjacent torus\'s analytic frame could not be derived'
const TORUS_MINOR_GATE = 'an adjacent torus\'s minor radius could not be derived'
const UNSAMPLEABLE_GATE = 'no sampleable tangent data'
const CLASS_PREFIX = 'bounded analytic blend-ribbon class'

function fixtureBytes(name: string): ArrayBuffer {
  const buf = readFileSync(join(FIX, name))
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)
}
function loadStep(k: OcctKernel, name: string): ShapeHandle { return k.importStep(fixtureBytes(name)) }
/** geom-engine's own rounding, replicated so the heal-match-key census below is exact. */
const r3 = (v: number): number => Math.round(v * 1000) / 1000
function releaseAll(k: OcctKernel, hs: ShapeHandle[]): void { for (const h of hs) { try { k.release(h) } catch { /* */ } } }
function faceCount(k: OcctKernel, s: ShapeHandle): number {
  const f = k.getSubShapes(s, 'face'); const n = f.length; releaseAll(k, f); return n
}

/**
 * REAL closedness census (GEO-6X4 lib.mjs). Every edge occurrence across all faces is
 * tallied by kernel hash; a closed manifold uses each edge exactly twice (a cylinder/
 * torus SEAM edge twice within its OWN face). DEGENERATE edges (surface poles/apexes:
 * zero length, one vertex) are legitimately used once and MUST be excluded — counting
 * the untouched Tray's 109 of them as free edges made the metric unpassable, and a
 * metric that can never pass is not a metric.
 */
function census(k: OcctKernel, s: ShapeHandle): { free: number; nonManifold: number; degenerate: number } {
  const allE = k.getSubShapes(s, 'edge')
  const degenerate = new Set<number>()
  try {
    for (const e of allE) {
      let len = NaN
      try { len = k.getLength(e) } catch { /* */ }
      const vs = k.getSubShapes(e, 'vertex')
      const nv = vs.length
      releaseAll(k, vs)
      if (!(len > 1e-9) || nv < 2) degenerate.add(k.hashCode(e, HM))
    }
  } finally { releaseAll(k, allE) }
  const fs = k.getSubShapes(s, 'face')
  const tally = new Map<number, number>()
  try {
    for (const f of fs) {
      const es = k.getSubShapes(f, 'edge')
      for (const e of es) {
        const h = k.hashCode(e, HM)
        if (degenerate.has(h)) continue
        tally.set(h, (tally.get(h) ?? 0) + 1)
      }
      releaseAll(k, es)
    }
  } finally { releaseAll(k, fs) }
  let free = 0, nonManifold = 0
  for (const c of tally.values()) { if (c === 1) free++; else if (c > 2) nonManifold++ }
  return { free, nonManifold, degenerate: degenerate.size }
}

/** Independent physical cross-check of the signed volume delta (GEO-6X4 probe 03 step 7):
 *  Pappus on the (square minus quarter-disc) fillet cross-section, swept a half-turn at
 *  the centroid radius, plus the two straight fillet runs. The two runout-cone corners
 *  contribute a small POSITIVE remainder the model does not cover, so the measured delta
 *  must EXCEED the main term slightly — a two-sided band, not a one-sided inequality. */
function pappusBand(r: number, R: number): { lo: number; hi: number } {
  const Ax = r * r * (1 - Math.PI / 4)                 // fillet cross-section area
  const uBar = r / (6 * (1 - Math.PI / 4))             // its centroid offset
  const rhoBar = (R + r) - uBar                        // sweep radius of that centroid
  const main = Ax * Math.PI * rhoBar + Ax * 2 * r      // half-turn sweep + two straight runs
  return { lo: main, hi: main * 1.15 }
}

// ---------------------------------------------------------------------------
// GEO-6X5-R1 synthetic negative: a SAME-RADIUS but TRANSVERSE torus/cylinder junction.
//
// The audit's major 1: the chain walk admitted a neighbour on surface type + equal radius
// + adjacency alone, none of which imply the G1 tangency the removal class is defined by.
// These primitives build the counterexample the Tray does not contain.
// ---------------------------------------------------------------------------
const SYN_R = 10        // torus major radius
const SYN_r = 2         // torus MINOR radius == the transverse rods' radius. That equality is the point.

/**
 * A quarter-tube: the torus of (R, r) trimmed to v in [0, pi/2] — outer equator up to the
 * top of the tube. The trim is NOT cosmetic: `torusFrame()` derives the minor radius from
 * three v-samples and needs cos(v0) != cos(v2), so a FULL torus (v in [0, 2pi]) yields no
 * frame at all and would refuse on the wrong gate. A quarter tube frames cleanly and
 * `frameConsistent` holds, which is what puts this fixture on the G1 gate's doorstep.
 *
 * Faces: the torus band, a flat annulus at z=0, and the r=R core cylinder.
 */
function quarterTube(k: OcctKernel, scratch: ShapeHandle[]): ShapeHandle {
  const t = k.makeTorus(SYN_R, SYN_r); scratch.push(t)
  const below = k.makeBoxFromCorners({ x: -30, y: -30, z: -30 }, { x: 30, y: 30, z: 0 }); scratch.push(below)
  const upper = k.cut(t, below); scratch.push(upper)          // keep z >= 0
  const core = k.makeCylinder(SYN_R, 40); scratch.push(core)
  const coreDn = k.translate(core, 0, 0, -20); scratch.push(coreDn)
  const q = k.cut(upper, coreDn); scratch.push(q)              // keep rho >= R
  return q
}

/**
 * The quarter-tube with TWO vertical rods of radius exactly `SYN_r` driven into its outer
 * shoulder at u = +/-90 deg. Each rod's axis is offset 3 mm outboard of the torus spine, so
 * where it meets the torus its normal is ~63 deg off the torus normal: a hard edge, not a
 * blend. Yet each rod is a CYLINDER, of the torus's exact minor radius, ADJACENT to it.
 *
 * Two rods, not one, on purpose. With the G1 gate removed the chain walk admits both, and
 * the resulting ribbon is 1 torus + 2 same-radius cylinders = exactly 3 faces — so the
 * downstream chain-shape gates (`toriInChain !== 1`, `ribbon.size !== 3`, two cylinders)
 * ALL PASS on a junction with no tangency anywhere in it. The count gates were never a
 * tangency proxy; only a normal comparison is.
 */
function transverseJunction(k: OcctKernel, scratch: ShapeHandle[]): ShapeHandle {
  const q = quarterTube(k, scratch)
  let body = q
  for (const sy of [1, -1]) {
    const rod0 = k.makeCylinder(SYN_r, 4); scratch.push(rod0)
    const rod = k.translate(rod0, 0, sy * 13, -1); scratch.push(rod)
    body = k.fuse(body, rod); scratch.push(body)
  }
  return body
}

/** One heal of the target blend, measured end to end. Releases everything it allocates. */
function healTarget(k: OcctKernel): {
  isValid: boolean; isSolid: boolean; free: number; nonManifold: number
  faceCount: number; volDelta: number; volume: number; stepRoundTrip?: { isValid: boolean; isSolid: boolean; faceCount: number; free: number }
} {
  const shape = loadStep(k, 'tray.step')
  const recs = gatherFaces(k, shape)
  const scratch: ShapeHandle[] = []
  try {
    const feats = recognizeFeatures(k, shape, recs)
    const target = feats.find((f) => f.key === TARGET_KEY)
    if (!target) throw new Error('target blend not recognized')
    const heal = healRemoval(k, shape, [target], scratch, recs)
    if (!heal.ok || !heal.shape) throw new Error(`heal failed: ${heal.reason}`)
    const solid = heal.shape
    scratch.push(solid)
    const c = census(k, solid)
    return {
      isValid: k.isValid(solid), isSolid: k.isSolid(solid),
      free: c.free, nonManifold: c.nonManifold,
      faceCount: faceCount(k, solid), volDelta: heal.volumeDelta!, volume: k.getVolume(solid),
    }
  } finally { releaseAll(k, scratch); releaseFaceRecs(k, recs); try { k.release(shape) } catch { /* */ } }
}

describe('GEO-6X5 bounded analytic blend-ribbon defeaturing', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { (k as unknown as Disposable)[Symbol.dispose]() } catch { /* */ } })

  // ---- 1) THE FIXTURE: Tray.step face #223 through the real product path ----
  it('#1 Tray.step face #223: the blend ribbon heals to a VALID, WATERTIGHT, CHANGED solid', () => {
    const shape = loadStep(k, 'tray.step')
    const recs = gatherFaces(k, shape)
    const scratch: ShapeHandle[] = []
    try {
      expect(faceCount(k, shape), 'the untouched Tray is the 696-face body GEO-6X2/6X4 measured').toBe(ORIGINAL_FACES)

      const feats = recognizeFeatures(k, shape, recs)
      const blends = feats.filter((f) => f.type === 'filletCurvedCorner')
      const inClass = blends.filter((f) => f.removable)

      // The target is the ONE in-class blend with the probe's band area — this pins face #223.
      const byArea = inClass.filter((f) => Math.abs(Number(f.params.area) - TARGET_AREA) < 0.01)
      expect(byArea.length, 'face #223 is uniquely identified among in-class blends by its band area').toBe(1)
      const target = byArea[0]
      expect(target.key, 'the geometry-derived key still resolves the GEO-6X4 probe target').toBe(TARGET_KEY)

      // the bounded class: 5 faces dropped (3 ribbon + 2 cone runouts), 8 walls rebuilt.
      expect(target.dropHashes.length, 'minimal consistent removal set is 5 faces (GEO-6X4 F3)').toBe(5)
      expect(target.neighbourHashes.length, '8 wall faces are rebuilt').toBe(8)
      expect(target.blendPlan, 'an in-class blend carries a solved reconstruction plan').toBeDefined()
      const plan = target.blendPlan!
      expect(plan.torusHash, 'the seed torus leads dropHashes (faceIds[0] stays the torus)').toBe(target.dropHashes[0])
      expect(plan.blendRadius).toBeCloseTo(1, 9)
      expect(plan.corners.length).toBe(2)

      // GUARD 2, recorded: the corner triple is transversal (|det| = sin 45deg) and EXACT.
      for (const c of plan.corners) {
        expect(Math.abs(c.det), 'the (end, side, chamfer) triple is structurally transversal').toBeCloseTo(Math.SQRT1_2, 6)
        expect(c.residual, 'three planes -> affine system -> exact solve').toBeLessThan(1e-9)
        expect(c.concurrency, 'the FOURTH chamfer plane passes through the same corner point').toBeLessThan(1e-6)
      }

      // ---- the heal, through the product's own healRemoval() ----
      const heal = healRemoval(k, shape, [target], scratch, recs)
      expect(heal.ok, `heal must reach a solid: ${heal.reason ?? ''}`).toBe(true)
      const solid = heal.shape!
      scratch.push(solid)

      expect(k.isValid(solid), 'isValid').toBe(true)
      expect(k.isSolid(solid), 'isSolid').toBe(true)
      const c = census(k, solid)
      expect(c.free, 'watertight: a real free-edge census, not a valid+isSolid proxy').toBe(0)
      expect(c.nonManifold, 'no non-manifold edges').toBe(0)
      expect(c.degenerate, 'exactly the two cone apex edges left with faces 455/631 (109 -> 107)').toBe(107)
      expect(faceCount(k, solid), '696 - 5 removed').toBe(HEALED_FACES)
      expect(heal.faceCount).toBe(HEALED_FACES)

      // signed volume delta: POSITIVE, because the fillet rounded a CONVEX material edge.
      const vd = heal.volumeDelta!
      expect(Math.abs(vd - VOL_DELTA), `volDelta ${vd} != ${VOL_DELTA} +/- 1e-2`).toBeLessThan(1e-2)
      expect(vd, 'CHANGED from the input (the native kernel path returns volDelta 0)').toBeGreaterThan(1e-6)

      // independent cross-check: the Pappus identity, as a test-time invariant.
      const band = pappusBand(plan.blendRadius, Number(target.params.cylinderRadius))
      expect(vd, `Pappus main term ${band.lo.toFixed(4)} must be a strict lower bound`).toBeGreaterThan(band.lo)
      expect(vd, 'the unmodelled runout-cone remainder is small').toBeLessThan(band.hi)

      // STEP artifacts are proven by RE-IMPORT + geometric assertions, never byte hash
      // (DECISIONS / GEO-6X4 ARCHITECT-ADDENDUM: occt STEP export is not byte-deterministic,
      // and git's line-ending normalization rewrites the bytes at commit).
      const stp = k.exportStep(solid)
      const reimported = k.importStep(stp)
      scratch.push(reimported)
      expect(k.isValid(reimported), 're-imported artifact is valid').toBe(true)
      expect(k.isSolid(reimported), 're-imported artifact is a solid').toBe(true)
      expect(faceCount(k, reimported)).toBe(HEALED_FACES)
      expect(census(k, reimported).free, 're-imported artifact is watertight').toBe(0)
      // STEP write/read tolerance moves the volume by ~0.02 mm^3 — reported, not hidden.
      expect(Math.abs(k.getVolume(reimported) - k.getVolume(solid))).toBeLessThan(0.05)
    } finally { releaseAll(k, scratch); releaseFaceRecs(k, recs); try { k.release(shape) } catch { /* */ } }
  }, 180_000)

  // ---- 2) NEGATIVE FIXTURE: everything outside the class refuses STRUCTURED ----
  it('#2 blends OUTSIDE the class refuse STRUCTURED (named gate) — never approximated, never crashed', () => {
    const shape = loadStep(k, 'tray.step')
    const recs = gatherFaces(k, shape)
    const scratch: ShapeHandle[] = []
    try {
      const feats = recognizeFeatures(k, shape, recs)
      const blends = feats.filter((f) => f.type === 'filletCurvedCorner')
      const inClass = blends.filter((f) => f.removable)
      const refused = blends.filter((f) => !f.removable)

      // The Tray's 59 tori split cleanly across the class boundary. Pinned, so a
      // recognizer that quietly widens (or collapses) the class fails here.
      // GEO-13 (BK-92 close-out): the boundary-run END-PLANE SPLICE widened the class from 9
      // to 33 — the 24 ribbons that used to refuse on the ambiguous-endArc constructibility
      // gate (a large end plane shared by several channels) now rebuild that face by walking
      // its boundary and splicing the sharp corner into the single removed-channel run, keeping
      // every other channel's arc by its original handle. All 33 heal to individually valid
      // watertight solids and compose (tests #5 / #5b).
      expect(inClass.length, '33 tori are the reconstructible blend-ribbon class after the GEO-13 end-splice widening').toBe(33)

      for (const f of refused) {
        expect(f.refuseReason, 'a refusal always names its reason').toBeTruthy()
        expect(f.refuseReason!.toLowerCase()).not.toContain('webassembly')
        expect(f.blendPlan, 'a refused blend never carries a reconstruction plan').toBeUndefined()
        expect(f.dropHashes.length, 'a refused blend consumes only its own face').toBe(1)
      }

      // Every refusal — torus or band — names the bounded class it fell outside of.
      expect(refused.every((f) => f.refuseReason!.includes('bounded analytic blend-ribbon class')),
        'every refusal names the class boundary').toBe(true)

      // 30 refusals = 26 out-of-class TORI + the 4 curved-neighbour fillet BANDS (cylinders
      // whose neighbour is curved). GEO-6X5 replaces the blanket torus refusal; a band that
      // belongs to an in-class ribbon is consumed in step 0 and never reaches the band lane.
      // GEO-13: the 24 ambiguous-end-plane refusals moved OUT of the refused set (now healed),
      // dropping torus refusals from 50 to 26.
      const torusRefusals = refused.filter((f) => f.refuseReason!.startsWith('torus corner blend outside'))
      const bandRefusals = refused.filter((f) => f.refuseReason!.startsWith('fillet band with a curved neighbour'))
      expect(torusRefusals.length + bandRefusals.length, 'the two refusal families partition the refusals').toBe(refused.length)
      expect(torusRefusals.length).toBe(26)
      expect(bandRefusals.length).toBe(4)
      expect(inClass.length + torusRefusals.length, 'every one of the Tray\'s 59 tori is classified').toBe(59)

      // The three distinct out-of-class shapes the Tray still contains, each caught by
      // the gate that names it — none approximated:
      //  (a) a CHAINED MULTI-TORUS ribbon (two tori G1-chained through a fillet cylinder),
      //  (b) a ribbon whose runout is a BSPLINE, not a cone: the tangent chain never
      //      reaches its second fillet cylinder, so it is 2 faces, not 3,
      //  (c) a ribbon whose walls include SIX chamfer planes, not four (10 walls).
      // GEO-13 retired the fourth family (the large-shared-end-plane ribbons): the boundary-run
      // splice reconstructs that face, so `notWirable` is now empty — those 24 heal instead of
      // refusing. `removable` stays honest because the splice's own constructibility check
      // (resolveEndSplice) runs at recognize time and the degree-2 loop guard runs at heal time.
      const multiTorus = refused.filter((f) => f.refuseReason!.includes('tori — a chained multi-torus ribbon'))
      const shortChain = refused.filter((f) => f.refuseReason!.includes('the tangent chain is'))
      const wrongWalls = refused.filter((f) => f.refuseReason!.includes('wall faces — the class rebuilds exactly 8'))
      const notWirable = refused.filter((f) => f.refuseReason!.includes('cannot be uniquely re-wired'))
      expect(multiTorus.length, 'chained multi-torus ribbons refuse on the tangent-chain gate').toBe(14)
      expect(shortChain.length, 'bspline (non-cone) runouts refuse on the tangent-chain gate').toBe(4)
      expect(wrongWalls.length, 'six-chamfer ribbons refuse on the wall-count gate').toBe(8)
      expect(notWirable.length, 'GEO-13: no ribbon refuses on the old ambiguous-end-plane gate — the splice heals them').toBe(0)
      expect(multiTorus.length + shortChain.length + wrongWalls.length + notWirable.length).toBe(torusRefusals.length)

      // GEO-6X5-R1 SCAN: the G1 gate is load-bearing but changes NOTHING on this part.
      // The calibration probe measured every one of the Tray's 156 same-radius shared
      // boundaries at a G1 deviation <= 4.441e-16 (2 machine epsilon) — every same-radius
      // adjacency here really is tangent, so no refusal migrates into the G1 family and the
      // four counts above stay exactly as GEO-6X5 pinned them. Were the gate mis-tuned tight,
      // in-class would collapse below 9 and this scan would name the culprit.
      expect(refused.filter((f) => f.refuseReason!.includes(G1_GATE)).length,
        'no Tray blend is refused by the G1 gate — its same-radius neighbours are genuinely tangent').toBe(0)

      // ...and the heal REFUSES rather than approximating or throwing.
      const heal = healRemoval(k, shape, [torusRefusals[0]], scratch, recs)
      expect(heal.ok).toBe(false)
      expect(heal.shape, 'no solid is produced for a refused feature').toBeUndefined()
      expect(heal.reason).toContain('not removable')
      expect(heal.reason).toContain('bounded analytic blend-ribbon class')
    } finally { releaseAll(k, scratch); releaseFaceRecs(k, recs); try { k.release(shape) } catch { /* */ } }
  }, 180_000)

  // ---- 3) DETERMINISM: identical geometry metrics across two consecutive runs ----
  it('#3 determinism: two consecutive heals of the same blend agree on every geometry metric', () => {
    const a = healTarget(k)
    const b = healTarget(k)
    expect(a.isValid).toBe(true)
    expect(b).toEqual(a)
    // pinned, so a silent drift shows up here and not only as "the two runs agreed".
    expect(a.faceCount).toBe(HEALED_FACES)
    expect(a.free).toBe(0)
    expect(Math.abs(a.volDelta - VOL_DELTA)).toBeLessThan(1e-2)
  }, 240_000)

  // ---- 5) removable => healable, and the class COMPOSES ----
  // The recognizer must never promise what the heal cannot deliver. GEO-13 widened the class
  // to all 33 analytically-solved ribbons via the end-plane boundary-run splice; the contract
  // is unchanged and stronger: every one of the 33 the recognizer marks removable heals to an
  // individually valid watertight solid (asserted per step below), and all 33 compose into one
  // watertight valid solid. (Historically only 9 healed and the other 24 refused at recognize
  // time on the ambiguous-endArc gate; the splice reconstructs that face instead.)
  it('#5 every in-class blend the recognizer promises actually heals, and 33 of them compose into one watertight solid', () => {
    let shape = loadStep(k, 'tray.step')
    const v0 = k.getVolume(shape)
    let healed = 0
    try {
      for (let guard = 0; guard < 40; guard++) {
        const recs = gatherFaces(k, shape)
        const scratch: ShapeHandle[] = []
        let next: ShapeHandle | null = null
        try {
          const target = recognizeFeatures(k, shape, recs).find((f) => f.blendPlan)
          if (target) {
            const heal = healRemoval(k, shape, [target], scratch, recs)
            // THE CONTRACT: a feature the recognizer marked removable heals. No exceptions.
            expect(heal.ok, `blend ${target.key} was promised removable but the heal refused: ${heal.reason}`).toBe(true)
            next = heal.shape!
          }
        } finally {
          for (const s of scratch) if (s !== next) { try { k.release(s) } catch { /* */ } }
          releaseFaceRecs(k, recs)
        }
        if (next === null) break
        try { k.release(shape) } catch { /* */ }
        shape = next
        healed++
      }

      expect(healed, 'the Tray carries 33 reconstructible blend ribbons after the GEO-13 widening').toBe(33)
      expect(k.isValid(shape), 'the cascaded solid is valid').toBe(true)
      expect(k.isSolid(shape), 'the cascaded solid is a solid').toBe(true)
      expect(census(k, shape).free, 'the cascaded solid is watertight — 33 sharpened corners, no free edges').toBe(0)
      expect(census(k, shape).nonManifold).toBe(0)
      expect(faceCount(k, shape), '696 - 33 blends x 5 faces').toBe(ORIGINAL_FACES - 33 * 5)
      // 33 convex fillets sharpened => material added back.
      const vd = k.getVolume(shape) - v0
      expect(Math.abs(vd - 147.4005), `cascaded volDelta ${vd}`).toBeLessThan(1e-2)
      expect(vd).toBeGreaterThan(VOL_DELTA)
    } finally { try { k.release(shape) } catch { /* */ } }
  }, 360_000)

  // ---- 6) GEO-6X5-R1: type + radius + adjacency are NOT sufficient. G1 is verified. ----
  //
  // MANDATORY GUARD 3 (audit major 1) — mutation-proved: replacing the G1 comparison in
  // analyzeBlendRibbon()'s chain walk with unconditional acceptance makes this test fail.
  // Both transverse rods then walk into the candidate removal set, the chain-shape gates
  // pass (1 torus + 2 same-radius cylinders = 3 faces), and the blend refuses instead on
  // an unrelated "0 cone runout cap(s)" count. See coordination/evidence/GEO-6X5/.
  it('#6 a same-radius but TRANSVERSE torus/cylinder junction is refused by the G1 gate', () => {
    const scratch: ShapeHandle[] = []
    try {
      // ---- CONTROL: the bare quarter-tube. Same torus, same frame, NO same-radius
      //      neighbour. It must refuse on the chain-LENGTH gate, never on G1 — otherwise
      //      the fixture below would prove nothing about the rods.
      const control = quarterTube(k, scratch)
      const cRecs = gatherFaces(k, control)
      try {
        const cBlends = recognizeFeatures(k, control, cRecs).filter((f) => f.type === 'filletCurvedCorner')
        expect(cBlends.length, 'the quarter-tube carries exactly one torus').toBe(1)
        expect(cBlends[0].removable).toBe(false)
        expect(cBlends[0].refuseReason, 'the control refuses for a want of ribbon cylinders').toContain('the tangent chain is 1 face(s)')
        expect(cBlends[0].refuseReason, 'the control does NOT reach the G1 gate').not.toContain(G1_GATE)
      } finally { releaseFaceRecs(k, cRecs) }

      // ---- THE NEGATIVE: same quarter-tube, plus two same-radius TRANSVERSE rods.
      const body = transverseJunction(k, scratch)
      const recs = gatherFaces(k, body)
      try {
        // The preconditions the pre-R1 walk accepted on, asserted structurally so this
        // fixture cannot silently stop being the counterexample it claims to be:
        const tori = recs.filter((f) => f.type === 'torus')
        expect(tori.length, 'exactly one torus seeds the walk').toBe(1)
        const seed = tori[0]
        const sameRadiusNbrs = seed.neighbours
          .map((h) => recs.find((x) => x.hash === h)!)
          .filter((n) => n.type === 'cylinder' && Math.abs(n.radius! - SYN_r) < 1e-6)
        expect(sameRadiusNbrs.length,
          'TYPE cylinder + RADIUS == torus minor radius + ADJACENT to the torus: exactly the two rods').toBe(2)
        // ...and with those two admitted, the chain would be 3 faces / 2 cylinders / 1 torus:
        // every downstream chain-shape count gate satisfied by a junction with zero tangency.

        const blends = recognizeFeatures(k, body, recs).filter((f) => f.refuseReason?.startsWith('torus corner blend outside'))
        expect(blends.length, 'the seed torus produces exactly one verdict').toBe(1)
        const v = blends[0]

        expect(v.removable, 'a transverse same-radius neighbour is NOT a blend ribbon').toBe(false)
        expect(v.blendPlan, 'a refused blend never carries a reconstruction plan').toBeUndefined()
        expect(v.dropHashes.length, 'a refused blend consumes only its own face').toBe(1)
        expect(v.refuseReason, 'the refusal still names the bounded class').toContain('bounded analytic blend-ribbon class')
        expect(v.refuseReason, 'and it names the G1 gate specifically').toContain(G1_GATE)

        // The gate reports what it measured, not just that it fired.
        const ang = /meets the chain at ([\d.]+) deg/.exec(v.refuseReason!)
        expect(ang, 'the G1 refusal reports the measured junction angle').toBeTruthy()
        expect(Number(ang![1]), 'the rods meet the torus at a hard edge, ~63 deg').toBeGreaterThan(60)

        const dev = /G1 deviation ([\d.e+-]+) >/.exec(v.refuseReason!)
        expect(dev, 'the G1 refusal reports the measured deviation').toBeTruthy()
        // 0.5 vs the 4.441e-16 the calibration probe measured on every genuine Tray ribbon
        // boundary: the tangent and transverse populations are ~15 decades apart, so the
        // 1e-9 tolerance is not a knob anyone has to tune.
        expect(Number(dev![1]), 'a transverse junction deviates by O(1), not by round-off').toBeGreaterThan(0.5)
      } finally { releaseFaceRecs(k, recs) }
    } finally { releaseAll(k, scratch) }
  }, 180_000)

  // ---- 7) GEO-6X5-R2: a candidate whose frame will not derive cannot be SKIPPED ----
  //
  // MANDATORY GUARD 4 (audit major) — mutation-proved. R1's walk did
  //     const fr = frameOf(k, nb, cache); if (!fr) continue
  // so a neighbour that satisfied every admission criterion (cylinder, radius == r,
  // adjacent) but whose analytic frame failed to derive left the walk WITHOUT ever being
  // measured. The chain then closed one member short and refused on a chain-SHAPE gate —
  // a plausible-looking refusal that says nothing about tangency — or, on a longer ribbon,
  // silently narrowed to exactly the 3 faces the class expects.
  //
  // A cylinder's radius has a second, frame-independent source: the kernel's own
  // getFaceCylinderData, read once into FaceRec.radius by gatherFaces(). Candidacy is
  // settled from THAT, before any frame is required, so a same-radius neighbour can no
  // longer duck the measurement by failing to frame.
  //
  // The seam: frameOf() reads `cache` first and returns a cached `null` as "no frame".
  // Pre-seeding the cache denies the frame of exactly ONE face, through the real
  // production code path, with no kernel mocking and no edit to defeature.ts.
  it('#7 a same-radius neighbour whose analytic frame will not derive REFUSES, never skips', () => {
    const shape = loadStep(k, 'tray.step')
    const recs = gatherFaces(k, shape)
    try {
      const byHash = new Map<number, FaceRec>(recs.map((r) => [r.hash, r]))
      const owners = buildEdgeOwners(k, recs)
      const feats = recognizeFeatures(k, shape, recs)

      // ---- 7a) CYLINDER: the audit's exact error path. ----
      const target = feats.find((f) => f.key === TARGET_KEY)
      expect(target?.blendPlan, 'the target in-class ribbon seeds this test').toBeDefined()
      const plan = target!.blendPlan!
      const seed = byHash.get(plan.torusHash)!
      const ribCyl = byHash.get(plan.corners[0].ribCylHash)!

      // The preconditions the R1 walk skipped on, asserted structurally: this face really is
      // a CYLINDER, really is ADJACENT to the seed, and its radius really is available
      // independently of any frame — which is what makes the skip indefensible.
      expect(ribCyl.type, 'the denied member is a cylinder').toBe('cylinder')
      expect(seed.neighbours, 'and it is adjacent to the seed torus').toContain(ribCyl.hash)
      expect(Number.isFinite(ribCyl.radius!), 'FaceRec.radius comes from getFaceCylinderData, not from the frame').toBe(true)
      expect(Math.abs(ribCyl.radius! - plan.blendRadius), 'and it equals the blend radius r').toBeLessThan(1e-6)

      // CONTROL: with frames derived normally this very ribbon is IN CLASS. So the refusal
      // below is caused by the denied frame and by nothing else.
      expect(analyzeBlendRibbon(k, byHash, seed, new Map(), owners).ok,
        'control: the target ribbon is in-class when every frame derives').toBe(true)

      const deniedCyl = new Map<number, AnalyticFrame | null>([[ribCyl.hash, null]])
      const rc = analyzeBlendRibbon(k, byHash, seed, deniedCyl, owners)
      expect(rc.ok, 'an unverifiable same-radius member must never be admitted').toBe(false)
      if (rc.ok) throw new Error('unreachable')
      expect(rc.reason, 'the refusal still names the bounded class').toContain(CLASS_PREFIX)
      expect(rc.reason, 'and names the unverified-G1 gate for a cylinder').toContain(CYL_FRAME_GATE)
      // Under the R1 skip this refused on a chain-SHAPE count instead: the denied member
      // simply vanished from the ribbon. Pin the difference, or the mutation is invisible.
      expect(rc.reason, 'NOT a chain-shape gate — the member did not vanish, it refused').not.toContain('the tangent chain is')

      // ---- 7b) TORUS, no frame: the same fail-closed policy (WO fix 2). ----
      // A multi-torus seed reaches a second torus through a fillet cylinder. Deny every
      // torus frame but the seed's, and the walk must refuse on the torus gate rather than
      // quietly dropping the neighbour and mis-reporting the chain's shape.
      const multi = feats.find((f) => f.refuseReason?.includes('tori — a chained multi-torus ribbon'))
      expect(multi, 'the Tray carries chained multi-torus ribbons (14 of them)').toBeDefined()
      const mSeed = byHash.get(multi!.dropHashes[0])!
      expect(analyzeBlendRibbon(k, byHash, mSeed, new Map(), owners).ok,
        'control: this seed is refused (it is a chained multi-torus)').toBe(false)

      const denyOtherTori = (frame: AnalyticFrame | null): Map<number, AnalyticFrame | null> =>
        new Map(recs.filter((r) => r.type === 'torus' && r.hash !== mSeed.hash).map((r) => [r.hash, frame]))

      const rt = analyzeBlendRibbon(k, byHash, mSeed, denyOtherTori(null), owners)
      expect(rt.ok).toBe(false)
      if (rt.ok) throw new Error('unreachable')
      expect(rt.reason, 'an adjacent torus with no derivable frame refuses, it is not skipped').toContain(TORUS_FRAME_GATE)

      // ---- 7c) TORUS, frame present but its minor radius is NOT trustworthy. ----
      // `frameConsistent: false` means two independent minor-radius derivations disagreed.
      // R1 turned that into NaN and fell through the radius gate to `continue` — i.e. an
      // adjacent torus of UNKNOWN radius was treated as a proven non-member.
      const inconsistent: AnalyticFrame = {
        kind: 'torus', center: { x: 0, y: 0, z: 0 }, axisDir: { x: 0, y: 0, z: 1 },
        majorR: 10, minorR: 1, frameConsistent: false,
      }
      const ri = analyzeBlendRibbon(k, byHash, mSeed, denyOtherTori(inconsistent), owners)
      expect(ri.ok).toBe(false)
      if (ri.ok) throw new Error('unreachable')
      expect(ri.reason, 'an adjacent torus whose minor radius will not derive refuses too').toContain(TORUS_MINOR_GATE)
    } finally { releaseFaceRecs(k, recs); try { k.release(shape) } catch { /* */ } }
  }, 180_000)

  // ---- 8) GEO-6X5-R2: one unreadable shared edge among several must refuse ----
  //
  // MANDATORY GUARD 5 (audit minor). measureG1() counted samples in ONE aggregate across
  // the whole shared-edge set. Two analytic faces can share more than one edge; with an
  // aggregate, five samples drawn from a readable edge satisfied "did we measure anything?"
  // on behalf of an unreadable one, and that second shared boundary was never verified
  // while the pair reported success. The requirement is now PER non-degenerate shared edge.
  //
  // A genuinely DEGENERATE edge (a surface pole/apex, zero length) is different: it carries
  // no tangent data and is correctly skipped. 8a pins both halves — the tightening, and the
  // fact that it did not over-tighten onto degenerate edges.
  it('#8 measureG1 requires samples from EVERY non-degenerate shared edge, not just one', () => {
    // ---- 8a) UNIT, on a mocked kernel: the semantics, isolated. ----
    interface EdgeSpec { len: number; lengthThrows?: boolean; paramsThrow?: boolean; pointThrows?: boolean; pointNaN?: boolean }
    const flatFace = (h: number): FaceRec => ({
      handle: h as ShapeHandle, hash: h, type: 'plane',
      centroid: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, area: 1,
      bbox: { xmin: 0, ymin: 0, zmin: 0, xmax: 1, ymax: 1, zmax: 0 }, innerLoops: 0, neighbours: [],
    })
    // Two coincident planes: perfectly tangent, so any null can only come from sampling.
    const PL: PlaneFrame = { kind: 'plane', point: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, d: 0 }

    const released: number[] = []
    const mock = (edges: EdgeSpec[]): OcctKernel => ({
      sharedEdges: () => edges.map((_, i) => (i + 1) as ShapeHandle),
      getLength: (h: ShapeHandle) => {
        const e = edges[(h as number) - 1]
        if (e.lengthThrows) throw new Error('mock: edge length unreadable')
        return e.len
      },
      curveParameters: (h: ShapeHandle) => {
        if (edges[(h as number) - 1].paramsThrow) throw new Error('mock: no curve')
        return { first: 0, last: 1 }
      },
      curvePointAtParam: (h: ShapeHandle, t: number) => {
        if (edges[(h as number) - 1].pointThrows) throw new Error('mock: point unreadable')
        // GEO-6X5-R3: the auditor's actual proof — a point returned WITHOUT throwing, but
        // non-finite. No exception fires, so only a finite-check on the value itself catches it.
        if (edges[(h as number) - 1].pointNaN) return { x: NaN, y: 0, z: 0 }
        return { x: t, y: 0, z: 0 }   // on z=0, i.e. on BOTH frames
      },
      release: (h: ShapeHandle) => { released.push(h as number) },
    } as unknown as OcctKernel)

    const run = (edges: EdgeSpec[]) => measureG1(mock(edges), flatFace(101), PL, flatFace(102), PL)

    // one readable edge: five interior samples, tangent.
    const one = run([{ len: 5 }])
    expect(one).not.toBeNull()
    expect(one!.samples).toBe(5)
    expect(one!.edges).toBe(1)
    expect(one!.dev).toBeCloseTo(0, 15)

    // two readable edges: BOTH measured. (The aggregate counter also passes this — it is the
    // control, not the guard.)
    const two = run([{ len: 5 }, { len: 3 }])
    expect(two).not.toBeNull()
    expect(two!.samples).toBe(10)
    expect(two!.edges).toBe(2)

    // THE GUARD: a second, non-degenerate shared edge that yields ZERO usable samples. The
    // first edge's five samples must NOT vouch for it.
    expect(run([{ len: 5 }, { len: 3, pointThrows: true }]),
      'a non-degenerate shared edge with no usable samples leaves that boundary unverified').toBeNull()
    expect(run([{ len: 3, pointThrows: true }, { len: 5 }]),
      'order must not matter: the unreadable edge is first here').toBeNull()

    // ---- 8c) GEO-6X5-R3: a returned POINT that is non-finite, WITHOUT throwing. This is
    // the auditor's exact reproduction (defeature.ts:948) — curvePointAtParam hands back
    // {x:NaN,y:0,z:0} and no exception ever fires, so only a value check catches it.
    expect(run([{ len: 5, pointNaN: true }]),
      'a NaN sample point makes every sample on this edge unusable, so the edge yields none').toBeNull()
    expect(run([{ len: 5 }, { len: 3, pointNaN: true }]),
      'a readable edge must not vouch for a sibling edge whose points are all NaN').toBeNull()

    // ---- 8d) GEO-6X5-R3: a finite point, but a non-finite NORMAL — the same class of bug,
    // one layer downstream. frameNormalAt's own null-check (`norm(n) < 0.5 ? null : n`) does
    // NOT catch this: Math.hypot on NaN components is NaN, and `NaN < 0.5` is false, so a
    // NaN-laden vector is returned as if it were a real normal. A corrupt CylFrame (NaN baked
    // into axisDir) reproduces it from otherwise-finite sample points.
    const CY_NAN: CylFrame = {
      kind: 'cylinder', axisPoint: { x: 0, y: 0, z: 0 }, axisDir: { x: 0, y: 0, z: NaN }, radius: 1, uSpan: 0,
    }
    expect(measureG1(mock([{ len: 5 }]), flatFace(101), CY_NAN, flatFace(102), PL),
      'a finite sample point through a corrupt frame that yields a NaN normal must not be admitted').toBeNull()

    // An edge whose LENGTH cannot be read is unverifiable — it is NOT evidence of degeneracy.
    expect(run([{ len: 5 }, { len: 3, lengthThrows: true }])).toBeNull()
    // ...nor is a curve we cannot parameterize.
    expect(run([{ len: 5 }, { len: 3, paramsThrow: true }])).toBeNull()

    // NOT over-tightened: a genuinely degenerate (zero-length pole/apex) edge carries no
    // tangent data and is correctly skipped, so the pair still verifies on the real edge.
    const withPole = run([{ len: 5 }, { len: 0 }])
    expect(withPole, 'a zero-length pole edge is skipped, not refused').not.toBeNull()
    expect(withPole!.edges).toBe(1)
    expect(withPole!.degenerateEdges).toBe(1)
    // ...but a pair sharing ONLY degenerate edges has nothing to verify, so it refuses.
    expect(run([{ len: 0 }])).toBeNull()

    // Every edge handed out is released on every path, including each early `return null`.
    // Eleven mock()-backed calls above, handing out
    // 1 + 2 + 2 + 2 + 1 + 2 + 1 + 2 + 2 + 2 + 1 = 18 edges (the 8c/8d additions contribute
    // 1 + 2 + 1 = 4 on top of the original 8a's 14).
    expect(released.length, 'no shared-edge handle leaks, on any return path').toBe(18)

    // ---- 8b) INTEGRATION, on the REAL kernel: the null reaches the named refusal. ----
    // A proxy adds ONE extra, real, non-degenerate edge to the torus<->fillet-cylinder
    // shared-edge set and makes that one edge unevaluable. Everything else is the live
    // kernel and the live recognizer.
    const shape = loadStep(k, 'tray.step')
    const recs = gatherFaces(k, shape)
    try {
      const byHash = new Map<number, FaceRec>(recs.map((r) => [r.hash, r]))
      const owners = buildEdgeOwners(k, recs)
      const target = recognizeFeatures(k, shape, recs).find((f) => f.key === TARGET_KEY)
      const plan = target!.blendPlan!
      const seed = byHash.get(plan.torusHash)!
      const ribCyl = byHash.get(plan.corners[0].ribCylHash)!

      expect(analyzeBlendRibbon(k, byHash, seed, new Map(), owners).ok,
        'control: on the untouched kernel this ribbon is in-class').toBe(true)

      const poisoned = new Set<number>()
      const proxy = new Proxy(k, {
        get(t, prop) {
          if (prop === 'sharedEdges') return (a: ShapeHandle, b: ShapeHandle): ShapeHandle[] => {
            const real = t.sharedEdges(a, b)
            const hit = (a === seed.handle && b === ribCyl.handle) || (a === ribCyl.handle && b === seed.handle)
            if (!hit) return real
            // borrow a real, non-degenerate edge off the seed face and mark it unevaluable
            const es = t.getSubShapes(seed.handle, 'edge')
            let extra: ShapeHandle | null = null
            for (const e of es) {
              if (extra === null && t.getLength(e) > 1e-9) extra = e
              else { try { t.release(e) } catch { /* */ } }
            }
            if (extra === null) return real
            poisoned.add(extra as number)
            return [...real, extra]
          }
          if (prop === 'curvePointAtParam') return (e: ShapeHandle, p: number) => {
            if (poisoned.has(e as number)) throw new Error('proxy: this shared edge cannot be evaluated')
            return t.curvePointAtParam(e, p)
          }
          if (prop === 'release') return (h: ShapeHandle) => { poisoned.delete(h as number); t.release(h) }
          const v = Reflect.get(t, prop, t)
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
        },
      })

      const res = analyzeBlendRibbon(proxy, byHash, seed, new Map(), owners)
      expect(res.ok, 'the readable edge must not vouch for the unreadable one').toBe(false)
      if (res.ok) throw new Error('unreachable')
      expect(res.reason).toContain(CLASS_PREFIX)
      expect(res.reason, 'the whole blend refuses, naming the unverified boundary').toContain(UNSAMPLEABLE_GATE)

      // ---- 8e) GEO-6X5-R3, same integration rig: the extra edge returns a NaN point
      // WITHOUT throwing (the auditor's exact reproduction), and must reach the SAME named
      // refusal as 8b's thrown-exception case — proving the finite-guard, not the try/catch,
      // is what closes this path.
      const poisonedNaN = new Set<number>()
      const proxyNaN = new Proxy(k, {
        get(t, prop) {
          if (prop === 'sharedEdges') return (a: ShapeHandle, b: ShapeHandle): ShapeHandle[] => {
            const real = t.sharedEdges(a, b)
            const hit = (a === seed.handle && b === ribCyl.handle) || (a === ribCyl.handle && b === seed.handle)
            if (!hit) return real
            const es = t.getSubShapes(seed.handle, 'edge')
            let extra: ShapeHandle | null = null
            for (const e of es) {
              if (extra === null && t.getLength(e) > 1e-9) extra = e
              else { try { t.release(e) } catch { /* */ } }
            }
            if (extra === null) return real
            poisonedNaN.add(extra as number)
            return [...real, extra]
          }
          if (prop === 'curvePointAtParam') return (e: ShapeHandle, p: number) => {
            if (poisonedNaN.has(e as number)) return { x: NaN, y: 0, z: 0 }
            return t.curvePointAtParam(e, p)
          }
          if (prop === 'release') return (h: ShapeHandle) => { poisonedNaN.delete(h as number); t.release(h) }
          const v = Reflect.get(t, prop, t)
          return typeof v === 'function' ? (v as (...a: unknown[]) => unknown).bind(t) : v
        },
      })

      const resNaN = analyzeBlendRibbon(proxyNaN, byHash, seed, new Map(), owners)
      expect(resNaN.ok, 'a NaN-returning (non-throwing) point on the extra edge must not be admitted either').toBe(false)
      if (resNaN.ok) throw new Error('unreachable')
      expect(resNaN.reason).toContain(CLASS_PREFIX)
      expect(resNaN.reason, 'the whole blend refuses, naming the unmeasurable boundary').toContain(UNSAMPLEABLE_GATE)
    } finally { releaseFaceRecs(k, recs); try { k.release(shape) } catch { /* */ } }
  }, 180_000)

  // ---- 4) WIRING OWNER: the app-facing geom service surface reaches the new class ----
  it('#4 integration: GeomEngine.defeatureBatch heals the blend through the geom service surface', async () => {
    const engine = new GeomEngine()
    await engine.init()
    try {
      const { bodies } = await engine.importStep(fixtureBytes('tray.step'), 'IMP-6X5')
      const body = bodies[0].handle
      const v0 = (await engine.measure(body, 'volume')).value

      // PRE-EXISTING lineage-key collision, measured on the ORIGINAL import — entirely
      // independent of defeaturing. geom-engine's healMatchKey() keys a PLANAR face on
      // (normal, plane offset) alone: no centroid, no area. The Tray's repeated pockets
      // put many coplanar faces on one key, and #assignHealedIds' origByKey map keeps only
      // ONE id per key, so the rest can never be matched back after ANY heal. GEO-6X5 is
      // the first heal that ever produced a body from this part (every torus was refused
      // before), so it EXPOSES this; it does not cause it. geom-engine.ts is outside this
      // work order's ownership — the finding is carried in GEO-6X5.report.json instead.
      const geom = bodies[0].elementMap.geometry!
      const faceIdsAll = Object.keys(geom).filter((id) => id.includes(':face#'))
      const keyOf = (g: (typeof geom)[string]): string => {
        if (g.surfaceType === 'plane' && g.normal) {
          const n = g.normal, c = g.centroid
          return `P|${r3(n.x)}|${r3(n.y)}|${r3(n.z)}|${r3(n.x * c.x + n.y * c.y + n.z * c.z)}`
        }
        const a = g.axis ?? { x: 0, y: 0, z: 0 }
        return `${g.surfaceType}|${r3(g.centroid.x)}|${r3(g.centroid.y)}|${r3(g.centroid.z)}|${r3(g.area)}|${r3(a.x)}|${r3(a.y)}|${r3(a.z)}`
      }
      const distinct = new Set(faceIdsAll.map((id) => keyOf(geom[id])))
      const collisionExcess = faceIdsAll.length - distinct.size
      expect(faceIdsAll.length).toBe(ORIGINAL_FACES)
      expect(collisionExcess, 'the original Tray already carries colliding heal-match keys').toBeGreaterThan(0)

      const verdicts = await engine.recognizeFeatures(body)
      const blends = verdicts.filter((v) => v.featureClass === 'filletCurvedCorner')
      const target = blends.find((v) => v.featureKey === TARGET_KEY)
      expect(target, 'the app-facing verdict list carries the in-class blend').toBeDefined()
      expect(target!.removable, 'and reports it REMOVABLE (it was blanket-refused before GEO-6X5)').toBe(true)
      expect(target!.refuseReason).toBeUndefined()
      expect(target!.faceIds.length, '5 dropped faces resolve to stable ids').toBe(5)

      // out-of-class blends still surface as refusals on the same app-facing list.
      expect(blends.some((v) => !v.removable && v.refuseReason!.includes('bounded analytic blend-ribbon class'))).toBe(true)

      const r = await engine.defeatureBatch({ featureId: 'DF-6X5', body, featureKeys: [TARGET_KEY] })
      expect(r.ok, `defeatureBatch must heal the blend: ${JSON.stringify(r.report?.items ?? r.diagnostics)}`).toBe(true)
      expect(r.report!.healed).toBe(1)
      expect(r.report!.failed).toBe(0)
      expect(r.report!.refused).toBe(0)
      expect(Math.abs(r.report!.totalVolumeDelta - VOL_DELTA)).toBeLessThan(1e-2)

      // the healed body is a real, measurable body on the service surface.
      const v1 = (await engine.measure(r.body!, 'volume')).value
      expect(Math.abs((v1 - v0) - VOL_DELTA)).toBeLessThan(1e-2)
      // The 5 ribbon/cap faces are the ones actually removed — and they are EXACTLY the
      // faces GEO-6X4 named: Tray face #222/#223/#224 (ribbon) + #455/#631 (runout cones).
      const del = r.elementMap!.deleted
      const gen = r.elementMap!.generated
      expect(target!.faceIds.sort()).toEqual(
        ['IMP-6X5:step:face#222', 'IMP-6X5:step:face#223', 'IMP-6X5:step:face#224', 'IMP-6X5:step:face#455', 'IMP-6X5:step:face#631'],
      )
      for (const id of target!.faceIds) expect(del, `dropped face ${id} is reported deleted`).toContain(id)

      // NO GEOMETRY IS LOST: every deletion beyond the 5 real removals is matched 1:1 by a
      // re-minted face id. 696 originals -> 691 survivors: deleted - generated == 5.
      expect(del.length - gen.length, 'deleted minus re-minted equals the 5 truly removed faces').toBe(5)

      // HISTORY, kept as a measured record: keyOf above replicates the LEGACY pre-BK-91
      // planar heal-match key ((normal, offset) only), under which the raw Tray carries 86
      // colliding keys — the churn class that re-minted ~87 ids per heal until GEO-6X6
      // gave the engine's planar branch centroid+area (BK-91). Post-fix, the ONLY re-mint
      // is the rebuilt CHANNEL CYLINDER (its area-bearing key legitimately changes when
      // the wall is untrimmed to the sharp arc); the 7 rebuilt PLANAR walls keep their
      // ids and are reported `modified`. Nothing here is unexplained.
      expect(collisionExcess, 'LEGACY (pre-BK-91) key collisions on the original Tray - the churn class GEO-6X6 eliminated').toBe(86)
      expect(gen.length, 'only the rebuilt cylinder re-mints; the 86 legacy collisions no longer churn (GEO-6X6/BK-91)').toBe(1)
      expect(Object.keys(r.elementMap!.modified).length, 'retrimmed survivors keep their ids').toBeGreaterThanOrEqual(7)
    } finally { await engine.disposeAll(); await engine.disposeKernel() }
  }, 240_000)
})
