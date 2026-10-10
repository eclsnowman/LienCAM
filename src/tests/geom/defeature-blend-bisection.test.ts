// GEO-14 item 3 — the SELF-REPRODUCING bisection probe for the GEO-13 root cause.
// =====================================================================
// coordination/reports/GEO-13.audit.json finding #2 held that
// coordination/evidence/GEO-13/BISECTION.md was NOT self-reproducing: it named
// '_geo13_one' and 'the same two ribbons' without preserving the probe, the companion
// ribbon, or the step order, so its position-2/position-4 narrative could not be
// independently reconstructed. This test IS that preserved probe. It names BOTH feature
// keys, fixes the exact step order, and pins the expected per-step results — a runnable,
// committed reconstruction of the finding.
//
// THE FINDING (GEO-13): the boundary-run splice is geometrically CORRECT — every Tray ribbon
// heals to an individually valid watertight solid from a FRESH import. The "invalid solid"
// GEO-12 saw was a PROBE ARTIFACT: reusing ORIGINAL face handles as makeFaceOnSurface/sew
// supports across many heals in ONE OcctKernel session corrupts the kernel session state, so
// a later heal's isValid() check spuriously fails even though the geometry (volumeDelta) is
// byte-identical to the valid fresh-import heal. Position/count dependence with CORRECT
// geometry == session-state corruption, not a geometry defect.
//
// THREE LEGS triangulate that root cause (each a can-fail assertion):
//   Leg 1 — FRESH, each ribbon its own import: both heal valid+watertight (capture deltas).
//   Leg 2 — FRESH-after-prior: heal B (fresh), THEN A (its OWN fresh import) — A stays valid.
//           Proves session AGE alone does not corrupt; a fresh support handle is clean.
//   Leg 3 — SHARED: ONE import, heal B then A on it — A refuses with valid=false but the
//           SAME volumeDelta as its fresh heal. Proves handle REUSE (not geometry) corrupts.
//
// HONEST RE-MEASURE (WO item 3): on this kernel the corruption manifests EARLIER than the
// GEO-13 BISECTION.md narrative (which needed 4 shared heals to flip #223 at position 4).
// Here #223 (ribbon A) refuses on the FIRST cross-ribbon shared heal (position 1) and at
// every later odd position. The essential finding is unchanged — fresh: valid; shared:
// refused with identical geometry — and the SHIPPING product is unaffected (it re-gathers
// from progressively-fresh output and never reuses a handle across heals). See
// coordination/evidence/GEO-14/bisection-signature.log for the full captured sequence.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { recognizeFeatures, healRemoval, gatherFaces, releaseFaceRecs, HM } from '../../geom/worker/defeature.ts'

const FIX = join(process.cwd(), 'src/tests/geom/fixtures')
function fixtureBytes(name: string): ArrayBuffer { const b = readFileSync(join(FIX, name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
function importTray(k: OcctKernel): ShapeHandle { return k.importStep(fixtureBytes('tray.step')) }
function releaseAll(k: OcctKernel, hs: ShapeHandle[]): void { for (const h of hs) { try { k.release(h) } catch { /* */ } } }
function census(k: OcctKernel, s: ShapeHandle): { free: number; nm: number } {
  const allE = k.getSubShapes(s, 'edge'); const degen = new Set<number>()
  for (const e of allE) { let len = NaN; try { len = k.getLength(e) } catch { /* */ } const vs = k.getSubShapes(e, 'vertex'); if (!(len > 1e-9) || vs.length < 2) degen.add(k.hashCode(e, HM)); releaseAll(k, vs) }
  releaseAll(k, allE)
  const fs = k.getSubShapes(s, 'face'); const tally = new Map<number, number>()
  for (const f of fs) { const es = k.getSubShapes(f, 'edge'); for (const e of es) { const h = k.hashCode(e, HM); if (!degen.has(h)) tally.set(h, (tally.get(h) ?? 0) + 1) } releaseAll(k, es) }
  releaseAll(k, fs)
  let free = 0, nm = 0; for (const c of tally.values()) { if (c === 1) free++; else if (c > 2) nm++ }
  return { free, nm }
}

// The two named ribbons. A is #223 (the GEO-13 subject); B is a distinct in-class ribbon on a
// DIFFERENT end plane, healed first on the shared shape so its supports are what corrupt A's.
const A_KEY = 'curved:37.1437:-42.5:-7.8756'          // #223
const B_KEY = 'curved:-12.6416:-25.5:-2.5542'         // companion (deterministic first key != A)

// Heal one named ribbon from a shape and report validity + geometry. `shape` is NOT mutated by
// healRemoval (it copies faces into the sew), so a fresh import per call = a clean support set.
type HealObs = { ok: boolean; valid: boolean; solid: boolean; free: number; nm: number; delta: number; reason: string }
function healOne(k: OcctKernel, shape: ShapeHandle, key: string): HealObs {
  const recs = gatherFaces(k, shape); const scratch: ShapeHandle[] = []
  try {
    const feat = recognizeFeatures(k, shape, recs).find((f) => f.key === key)
    if (!feat) throw new Error(`ribbon ${key} not recognized`)
    const heal = healRemoval(k, shape, [feat], scratch, recs)
    if (heal.ok && heal.shape) {
      const valid = k.isValid(heal.shape), solid = k.isSolid(heal.shape); const c = census(k, heal.shape)
      return { ok: true, valid, solid, free: c.free, nm: c.nm, delta: heal.volumeDelta ?? NaN, reason: '' }
    }
    // On the refused path the delta is reported in the reason (round(volumeDelta,3)).
    const m = /volumeDelta=([\-0-9.]+)/.exec(heal.reason ?? '')
    return { ok: false, valid: false, solid: false, free: -1, nm: -1, delta: m ? Number(m[1]) : NaN, reason: heal.reason ?? '' }
  } finally { releaseAll(k, scratch); releaseFaceRecs(k, recs) }
}

describe('GEO-14 blend heal bisection — shared-handle corruption reproduced (GEO-13 root cause)', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { (k as unknown as Disposable)[Symbol.dispose]() } catch { /* */ } })

  it('both named ribbons are recognized as in-class blend features (premise)', () => {
    const s = importTray(k); const recs = gatherFaces(k, s)
    try {
      const feats = recognizeFeatures(k, s, recs)
      const a = feats.find((f) => f.key === A_KEY), b = feats.find((f) => f.key === B_KEY)
      expect(a?.blendPlan, `${A_KEY} is an in-class ribbon`).toBeDefined()
      expect(b?.blendPlan, `${B_KEY} is an in-class ribbon`).toBeDefined()
      expect(a!.removable && b!.removable, 'both are removable').toBe(true)
    } finally { releaseFaceRecs(k, recs); try { k.release(s) } catch { /* */ } }
  }, 180_000)

  it('#bisect reproduces the finding: fresh -> valid; shared-handle -> refused with IDENTICAL geometry', () => {
    // ---- Leg 1: FRESH, each ribbon its OWN import. Both heal to a valid watertight solid. ----
    const sA = importTray(k); const freshA = healOne(k, sA, A_KEY); try { k.release(sA) } catch { /* */ }
    const sB = importTray(k); const freshB = healOne(k, sB, B_KEY); try { k.release(sB) } catch { /* */ }
    for (const [name, o] of [['A', freshA], ['B', freshB]] as const) {
      expect(o.ok, `fresh ${name} heals ok: ${o.reason}`).toBe(true)
      expect(o.valid && o.solid, `fresh ${name} is a valid solid`).toBe(true)
      expect(o.free === 0 && o.nm === 0, `fresh ${name} is watertight`).toBe(true)
      expect(Number.isFinite(o.delta), `fresh ${name} has a finite volumeDelta`).toBe(true)
    }
    // #223's fresh geometry is the ~8.813 material add the GEO-13 audit measured.
    expect(Math.abs(freshA.delta - 8.813), `fresh A delta ~ 8.813 (got ${freshA.delta})`).toBeLessThan(0.02)

    // ---- Leg 2: FRESH-after-prior. Heal B (fresh), THEN A on its OWN fresh import. A stays ----
    //             valid: session AGE alone does not corrupt — a fresh support handle is clean. ----
    const s2b = importTray(k); healOne(k, s2b, B_KEY); try { k.release(s2b) } catch { /* */ }
    const s2a = importTray(k); const afterPriorA = healOne(k, s2a, A_KEY); try { k.release(s2a) } catch { /* */ }
    expect(afterPriorA.ok && afterPriorA.valid, `A on its own fresh import stays valid after a prior heal: ${afterPriorA.reason}`).toBe(true)
    expect(Math.abs(afterPriorA.delta - freshA.delta), 'same geometry as leg 1').toBeLessThan(1e-6)

    // ---- Leg 3: SHARED. ONE import; heal B then A on it. A now REFUSES (valid=false) but with ----
    //             the SAME volumeDelta as its fresh heal -> handle REUSE, not geometry, corrupts. ----
    const shared = importTray(k)
    const sharedB = healOne(k, shared, B_KEY)     // step 0: B on the shared shape -> valid
    const sharedA = healOne(k, shared, A_KEY)     // step 1: A on the same shape   -> refused
    try { k.release(shared) } catch { /* */ }
    expect(sharedB.ok && sharedB.valid, 'B still heals valid at shared step 0').toBe(true)
    expect(sharedA.ok, 'A REFUSES on the shared shape (the corruption signature)').toBe(false)
    expect(sharedA.reason, 'the refusal is the final watertight gate reporting valid=false').toContain('valid=false')
    // THE crux: the refused shared heal carries the SAME geometry as the valid fresh heal.
    expect(Number.isFinite(sharedA.delta), 'the refusal reports a finite volumeDelta').toBe(true)
    expect(Math.abs(sharedA.delta - freshA.delta), `shared A delta (${sharedA.delta}) == fresh A delta (${freshA.delta}) -> session-state, not geometry`).toBeLessThan(0.02)
  }, 300_000)
})
