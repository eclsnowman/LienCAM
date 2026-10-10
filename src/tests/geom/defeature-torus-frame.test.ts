// GEO-12 (BK-92 auditor-confirmed prereq) — the perfect-torus frameConsistent gate.
// =====================================================================
// GEO-6X5-R2 audit round 3 named a REAL residual in torusFrame(): the
// `frameConsistent` cross-check derived its independent minor-radius from the FIXED
// (v0,v2) sample pair. On a PERFECT torus whose v-span is centred on pi/2 the sample
// fractions 0.1/0.9 are SYMMETRIC (v0=0.1pi, v2=0.9pi -> sin(v0)==sin(v2)), so that
// pair's sin difference — and its centre offset — vanish. The old code then:
//   - set minorRFromOffset = NaN (Math.abs(dsin) > 1e-9 was false), making
//     frameConsistent === false, so analyzeBlendRibbon refused a GENUINE torus on the
//     'inconsistent torus frame' gate; and
//   - fell to a sign-ambiguous cross-product axis, which can displace `center` by
//     2*r*sin(v1) and make even the downstream on-surface checks reject it ("or worse,
//     NaN-compared", the WO's phrase).
// GEO-12 derives the axis AND the cross-check from whichever sampled v-pair is best
// separated in sin. GEO-13 (BK-116(3)) correction: it does NOT rely on the mid sample v1
// being asymmetric with an end (it can be — see torusFrame's own comment); it relies only on
// at least one of the three pairs being well separated, which three distinct v-samples on a
// real torus always give, with a finite fail-closed fallback if every pair is degenerate. This
// file PINS that a symmetric-v-span perfect torus is eligible, and
// is the named regression the mutation proof breaks (revert torusFrame to the fixed
// (v0,v2) pair -> #t1/#t3 fail: coordination/reports/GEO-12.report.json > mutationProofs).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import {
  gatherFaces, releaseFaceRecs, frameOf, analyzeBlendRibbon, buildEdgeOwners,
} from '../../geom/worker/defeature.ts'
import type { AnalyticFrame, FaceRec, TorusFrame } from '../../geom/worker/defeature.ts'

const TOR_R = 10       // torus major radius
const TOR_r = 2        // torus minor radius

function releaseAll(k: OcctKernel, hs: ShapeHandle[]): void { for (const h of hs) { try { k.release(h) } catch { /* */ } } }

/**
 * A HALF-tube torus: makeTorus(R, r) trimmed to z >= 0 only. On the torus z = r sin v,
 * so z >= 0 keeps v in [0, pi] — a v-span centred on pi/2. torusFrame() samples v at
 * fractions 0.1/0.5/0.9 of the span, i.e. v0=0.1pi, v1=0.5pi, v2=0.9pi, and
 * sin(0.1pi) == sin(0.9pi) EXACTLY (supplementary angles). That is the SYMMETRIC pair
 * that made the old fixed-(v0,v2) cross-check degenerate. NB the QUARTER tube used in
 * defeature-blend-ribbon.test.ts additionally cuts rho >= R (v in [0, pi/2]), which is
 * NOT symmetric — so only this half tube exercises the bug.
 */
function halfTube(k: OcctKernel, scratch: ShapeHandle[]): ShapeHandle {
  const t = k.makeTorus(TOR_R, TOR_r); scratch.push(t)
  const below = k.makeBoxFromCorners({ x: -30, y: -30, z: -30 }, { x: 30, y: 30, z: 0 }); scratch.push(below)
  const upper = k.cut(t, below); scratch.push(upper)   // keep z >= 0  =>  v in [0, pi]
  return upper
}

/** A QUARTER tube: additionally cut rho >= R so v in [0, pi/2] — the non-symmetric
 *  control the pre-GEO-12 code already handled. Included so a regression to the axis/
 *  cross-check that breaks the normal span is caught here too, not only on Tray.step. */
function quarterTube(k: OcctKernel, scratch: ShapeHandle[]): ShapeHandle {
  const t = k.makeTorus(TOR_R, TOR_r); scratch.push(t)
  const below = k.makeBoxFromCorners({ x: -30, y: -30, z: -30 }, { x: 30, y: 30, z: 0 }); scratch.push(below)
  const upper = k.cut(t, below); scratch.push(upper)
  const core = k.makeCylinder(TOR_R, 40); scratch.push(core)
  const coreDn = k.translate(core, 0, 0, -20); scratch.push(coreDn)
  const q = k.cut(upper, coreDn); scratch.push(q)       // keep rho >= R  =>  v in [0, pi/2]
  return q
}

function torusRec(recs: FaceRec[]): FaceRec {
  const tori = recs.filter((r) => r.type === 'torus')
  if (tori.length !== 1) throw new Error(`expected exactly one torus face, found ${tori.length}`)
  return tori[0]
}

/** The three v-samples torusFrame() actually reads (0.1/0.5/0.9 of the measured span). */
function sampleVs(k: OcctKernel, f: ShapeHandle): { v0: number; v1: number; v2: number } {
  const uv = k.uvBounds(f)
  const sv = uv.vMax - uv.vMin
  return { v0: uv.vMin + sv * 0.1, v1: uv.vMin + sv * 0.5, v2: uv.vMax - sv * 0.1 }
}

describe('GEO-12 (BK-92 prereq): a symmetric-v-span perfect torus stays ELIGIBLE', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { (k as unknown as Disposable)[Symbol.dispose]() } catch { /* */ } })

  it('#t0 the half-tube fixture actually EXERCISES the symmetric (v0,v2) pair (non-vacuous)', () => {
    const scratch: ShapeHandle[] = []
    const shape = halfTube(k, scratch)
    const recs = gatherFaces(k, shape)
    try {
      const tor = torusRec(recs)
      const { v0, v2 } = sampleVs(k, tor.handle)
      // The precondition the whole prereq rests on: on this fixture the fixed (v0,v2)
      // pair is symmetric, so its sin difference is ~0 and the OLD offset derivation
      // divides by ~0 -> NaN. If this ever stops holding, #t1/#t3 are no longer proof.
      const dsin = Math.abs(Math.sin(v2) - Math.sin(v0))
      expect(dsin, `the (v0,v2) sin difference must be ~0 (symmetric span); measured ${dsin}`).toBeLessThan(1e-6)
    } finally { releaseFaceRecs(k, recs); releaseAll(k, scratch) }
  })

  it('#t1 the perfect torus frames CONSISTENT with finite center/axis and r,R recovered', () => {
    const scratch: ShapeHandle[] = []
    const shape = halfTube(k, scratch)
    const recs = gatherFaces(k, shape)
    try {
      const tor = torusRec(recs)
      const cache = new Map<number, AnalyticFrame | null>()
      const fr = frameOf(k, tor, cache)
      expect(fr, 'the torus frame derives').not.toBeNull()
      expect(fr!.kind).toBe('torus')
      const tf = fr as TorusFrame
      // ELIGIBLE: the whole point of the prereq — a genuine torus is NOT refused.
      expect(tf.frameConsistent, 'a genuine perfect torus must pass frameConsistent').toBe(true)
      // fail-closed data validation (charter bar 3): every accepted field is finite.
      for (const v of [tf.center.x, tf.center.y, tf.center.z, tf.axisDir.x, tf.axisDir.y, tf.axisDir.z, tf.majorR, tf.minorR]) {
        expect(Number.isFinite(v), 'every frame field is finite').toBe(true)
      }
      expect(Math.abs(tf.minorR - TOR_r), 'minor radius recovered').toBeLessThan(1e-6)
      expect(Math.abs(tf.majorR - TOR_R), 'major radius recovered').toBeLessThan(1e-6)
      // axis is a unit vector (the sign-ambiguous fallback would still be unit, but a
      // wrong-signed axis would displace center; the center check below pins that).
      expect(Math.abs(Math.hypot(tf.axisDir.x, tf.axisDir.y, tf.axisDir.z) - 1)).toBeLessThan(1e-6)
      // the true torus center sits on the z-axis at z=0 (makeTorus centers at origin);
      // a wrong-signed axis would put center at +/- 2*r*sin(v1) = +/-4 off. Pin it.
      expect(Math.hypot(tf.center.x, tf.center.y, tf.center.z), 'center at the torus origin, not displaced by a wrong-signed axis').toBeLessThan(1e-4)
    } finally { releaseFaceRecs(k, recs); releaseAll(k, scratch) }
  })

  it('#t3 a lone symmetric torus reaches recognition and refuses PAST the frame gate (exact string pinned)', () => {
    const scratch: ShapeHandle[] = []
    const shape = halfTube(k, scratch)
    const recs = gatherFaces(k, shape)
    try {
      const tor = torusRec(recs)
      const byHash = new Map<number, FaceRec>(recs.map((r) => [r.hash, r]))
      const owners = buildEdgeOwners(k, recs)
      const cache = new Map<number, AnalyticFrame | null>()
      const res = analyzeBlendRibbon(k, byHash, tor, cache, owners)
      // A lone torus is not a full blend ribbon, so it MUST refuse — but for a DOWNSTREAM
      // reason (no fillet cylinders / cone caps / walls), proving it passed frameConsistent.
      expect(res.ok, 'a lone torus is not an in-class ribbon').toBe(false)
      if (!res.ok) {
        expect(res.reason, 'a genuine torus must NOT be refused on the frame-consistency gate').not.toContain('inconsistent torus frame')
        // GEO-13 (BK-116(3)): pin the EXACT downstream refusal, not just "not the frame gate".
        // If a future change reroutes a passing-frame torus onto a different (or the frame)
        // gate, this breaks — the negative-only assertion above could not catch that.
        expect(res.reason, 'the lone half-tube torus refuses on the tangent-chain gate, one member short').toBe(
          'torus corner blend outside the bounded analytic blend-ribbon class (GEO-6X5): the tangent chain is 1 face(s) (0 cylinder(s)) — the class is one torus G1-chained to exactly two fillet cylinders of radius r',
        )
      }
    } finally { releaseFaceRecs(k, recs); releaseAll(k, scratch) }
  })

  it('#t4 CONTROL: the non-symmetric quarter tube still frames consistent (no normal-path regression)', () => {
    const scratch: ShapeHandle[] = []
    const shape = quarterTube(k, scratch)
    const recs = gatherFaces(k, shape)
    try {
      const tor = torusRec(recs)
      const cache = new Map<number, AnalyticFrame | null>()
      const fr = frameOf(k, tor, cache)
      expect(fr!.kind).toBe('torus')
      expect((fr as TorusFrame).frameConsistent, 'the already-handled non-symmetric span stays eligible').toBe(true)
      expect(Math.abs((fr as TorusFrame).minorR - TOR_r)).toBeLessThan(1e-6)
    } finally { releaseFaceRecs(k, recs); releaseAll(k, scratch) }
  })

  // GEO lane determinism criterion for NEW fixtures (GEO-12 audit major): a repeat-run
  // comparison, not just tolerance assertions. Two INDEPENDENT kernel constructions of the
  // same fixture must yield EXACTLY identical frame fields (Object.is, no tolerance) -
  // kernel-order/session effects would surface here as a bit-level mismatch.
  it('#t5 DETERMINISM: two independent constructions derive bit-identical torus frames', () => {
    const derive = (): TorusFrame => {
      const scratch: ShapeHandle[] = []
      const shape = halfTube(k, scratch)
      const recs = gatherFaces(k, shape)
      try {
        const fr = frameOf(k, torusRec(recs), new Map<number, AnalyticFrame | null>())
        expect(fr).not.toBeNull()
        expect(fr!.kind).toBe('torus')
        return fr as TorusFrame
      } finally { releaseFaceRecs(k, recs); releaseAll(k, scratch) }
    }
    const a = derive()
    const b = derive()
    const fields: Array<[string, number, number]> = [
      ['center.x', a.center.x, b.center.x], ['center.y', a.center.y, b.center.y], ['center.z', a.center.z, b.center.z],
      ['axisDir.x', a.axisDir.x, b.axisDir.x], ['axisDir.y', a.axisDir.y, b.axisDir.y], ['axisDir.z', a.axisDir.z, b.axisDir.z],
      ['majorR', a.majorR, b.majorR], ['minorR', a.minorR, b.minorR],
    ]
    for (const [name, va, vb] of fields) {
      expect(Object.is(va, vb), `${name} must be bit-identical across runs (${va} vs ${vb})`).toBe(true)
    }
    expect(a.frameConsistent, 'both runs consistent').toBe(b.frameConsistent)
  })
})
