// GEO-13 (BK-92 close-out): the blend end-plane BOUNDARY-RUN SPLICE.
// =====================================================================
// GEO-6X5 healed only the 9 ribbons whose end plane borders ONE channel (a unique kept
// `endArc`). The other 24 Tray ribbons sit on a LARGE end plane shared by several channels,
// where `endArc` is ambiguous, so they refused on the constructibility gate. GEO-12 built the
// boundary-run splice (walk the end boundary, replace the single removed-channel run with the
// sharp corner, keep every other channel's arc by handle) but its heal probe REUSED one
// imported shape handle across many heals, which corrupts the kernel session and made 32 of 33
// come back isValid=false — misread at the time as a "coincident-vertex degree-3" geometry
// blocker. GEO-13 bisected that: each ribbon healed from a FRESH import is individually valid;
// the splice was already correct. See coordination/evidence/GEO-13/BISECTION.md.
//
// This file pins: (a) all 33 heal individually valid OR refuse by name — asserted counts, zero
// isValid=false outputs; (b) the degree-2 splice-loop invariant (analyseSpliceLoop), including
// the force-injected coincident-vertex case the class ALLOWS but the Tray does not contain;
// (c) resolveEndSplice's enumerated structural refusals; (d) F1/F2 on the widened path.
//
// Fails-if guards (mutation-proved — see coordination/reports/GEO-13.report.json):
//   - DEGREE-2 GUARD: making analyseSpliceLoop skip its degree check makes
//     '#loop-degree3-refuses' pass a non-manifold wire -> the test fails.
//   - F2 (fixShape pcurve repair on the non-planar cylinder wall of a widened ribbon):
//     deleting it makes '#widened-ribbon-F2' report a wrong volume -> the test fails.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import type { ShapeHandle } from 'occt-wasm'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { FaceRec, BlendRibbonPlan, Vec3 } from '../../geom/worker/defeature.ts'
import {
  recognizeFeatures, healRemoval, gatherFaces, releaseFaceRecs, HM, __geo13internals,
  analyzeBlendRibbon, buildEdgeOwners,
} from '../../geom/worker/defeature.ts'
import type { AnalyticFrame } from '../../geom/worker/defeature.ts'

const { analyseSpliceLoop, orderedOuterEdges, resolveEndSplice, polesRadialBound, coneApex } = __geo13internals
const TARGET_KEY = 'curved:37.1437:-42.5:-7.8756'
const END_HANDLE = 1000 as unknown as ShapeHandle
const FIX = join(process.cwd(), 'src/tests/geom/fixtures')
function fixtureBytes(name: string): ArrayBuffer { const b = readFileSync(join(FIX, name)); return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
function loadStep(k: OcctKernel, name: string): ShapeHandle { return k.importStep(fixtureBytes(name)) }
function releaseAll(k: OcctKernel, hs: ShapeHandle[]): void { for (const h of hs) { try { k.release(h) } catch { /* */ } } }
function census(k: OcctKernel, s: ShapeHandle): { free: number; nonManifold: number } {
  const allE = k.getSubShapes(s, 'edge'); const degen = new Set<number>()
  for (const e of allE) { let len = NaN; try { len = k.getLength(e) } catch { /* */ } const vs = k.getSubShapes(e, 'vertex'); if (!(len > 1e-9) || vs.length < 2) degen.add(k.hashCode(e, HM)); releaseAll(k, vs) }
  releaseAll(k, allE)
  const fs = k.getSubShapes(s, 'face'); const tally = new Map<number, number>()
  for (const f of fs) { const es = k.getSubShapes(f, 'edge'); for (const e of es) { const h = k.hashCode(e, HM); if (!degen.has(h)) tally.set(h, (tally.get(h) ?? 0) + 1) } releaseAll(k, es) }
  releaseAll(k, fs)
  let free = 0, nm = 0; for (const c of tally.values()) { if (c === 1) free++; else if (c > 2) nm++ }
  return { free, nonManifold: nm }
}
function faceCount(k: OcctKernel, s: ShapeHandle): number { const f = k.getSubShapes(s, 'face'); const n = f.length; releaseAll(k, f); return n }

const ORIGINAL_FACES = 696

describe('GEO-13 blend end-plane boundary-run splice', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 60_000)
  afterAll(() => { try { (k as unknown as Disposable)[Symbol.dispose]() } catch { /* */ } })

  // ---- 1) ALL-33 ACCOUNTING: each ribbon, healed from a FRESH import, is individually valid
  //         OR refuses by name. Zero isValid=false outputs from any path (asserted). ----
  it('#all33 every recognized blend heals to an individually valid watertight solid or refuses by name', () => {
    // Enumerate keys once (throwaway import), then heal each from its OWN fresh import so no
    // original-face handle is reused across heals (that reuse is what corrupted GEO-12's probe).
    const s0 = loadStep(k, 'tray.step'); const r0 = gatherFaces(k, s0)
    const keys = recognizeFeatures(k, s0, r0).filter((f) => f.blendPlan).map((f) => f.key)
    releaseFaceRecs(k, r0); try { k.release(s0) } catch { /* */ }
    expect(keys.length, 'the widened class is all 33 analytically-solved Tray ribbons').toBe(33)

    let healedValid = 0
    const namedRefusals: string[] = []
    let invalidOutputs = 0
    for (const key of keys) {
      const shape = loadStep(k, 'tray.step'); const recs = gatherFaces(k, shape); const scratch: ShapeHandle[] = []
      try {
        const b = recognizeFeatures(k, shape, recs).find((f) => f.key === key)!
        const heal = healRemoval(k, shape, [b], scratch, recs)
        if (!heal.ok || !heal.shape) { expect(heal.reason, 'a refusal always names its reason').toBeTruthy(); namedRefusals.push(heal.reason!); continue }
        const solid = heal.shape
        const valid = k.isValid(solid), isSolid = k.isSolid(solid); const c = census(k, solid)
        if (valid && isSolid && c.free === 0 && c.nonManifold === 0) healedValid++
        else invalidOutputs++
        try { k.release(solid) } catch { /* */ }
      } finally { releaseAll(k, scratch); releaseFaceRecs(k, recs); try { k.release(shape) } catch { /* */ } }
    }
    // The direction GEO-13 promised: the coincident-vertex 24 move to HEALED, none refuse.
    expect(healedValid, 'all 33 recognized ribbons heal to an individually valid watertight solid').toBe(33)
    expect(namedRefusals.length, 'no recognized ribbon refuses at heal time on the Tray').toBe(0)
    // The charter bar that matters most here: a probe that cannot fail is not a gate. This is
    // asserted, not printed — an isValid=false solid escaping ANY path fails the run.
    expect(invalidOutputs, 'ZERO isValid=false / non-watertight solids emitted from any heal path').toBe(0)
    expect(healedValid + namedRefusals.length, 'no silent drops: every ribbon is healed or named').toBe(33)
  }, 600_000)

  // ---- 2) THE DEGREE-2 SPLICE-LOOP INVARIANT (analyseSpliceLoop), force-injected. ----
  // The Tray never produces a coincident vertex (proven by #all33 healing all 33 untouched),
  // but the class ALLOWS one, so the guard is exercised here on constructed edge lists.
  describe('#loop the spliced end wire must reconcile to ONE degree-2 loop or refuse by name', () => {
    // a 6-edge closed square-ish loop, every vertex degree 2. z held constant (a planar face).
    const square = (): Array<{ a: Vec3; b: Vec3 }> => [
      { a: { x: 0, y: 0, z: 0 }, b: { x: 2, y: 0, z: 0 } },
      { a: { x: 2, y: 0, z: 0 }, b: { x: 4, y: 0, z: 0 } },
      { a: { x: 4, y: 0, z: 0 }, b: { x: 4, y: 3, z: 0 } },
      { a: { x: 4, y: 3, z: 0 }, b: { x: 2, y: 3, z: 0 } },
      { a: { x: 2, y: 3, z: 0 }, b: { x: 0, y: 3, z: 0 } },
      { a: { x: 0, y: 3, z: 0 }, b: { x: 0, y: 0, z: 0 } },
    ]

    it('a clean single loop passes untouched', () => {
      const r = analyseSpliceLoop(square())
      expect(r.ok).toBe(true)
      if (r.ok) expect(r.keep.length, 'all six edges kept').toBe(6)
    })

    it('a zero-length degenerate tab (a coincident sharp/kept vertex) is MERGED, reconciling to degree 2', () => {
      // Insert a zero-length edge at (4,0,0): this is exactly the collapse GEO-12 anticipated —
      // a sharp tangency landing ON a kept vertex, leaving a lip of no length. The merge drops
      // it and hands the two neighbours' shared vertex straight through.
      const segs = square()
      segs.splice(2, 0, { a: { x: 4, y: 0, z: 0 }, b: { x: 4, y: 0, z: 0 } })
      const r = analyseSpliceLoop(segs)
      expect(r.ok, 'the zero-length tab is merged and the loop reconciles').toBe(true)
      if (r.ok) {
        expect(r.keep.length, 'six real edges survive; the degenerate tab is dropped').toBe(6)
        expect(r.keep.includes(2), 'the dropped edge is the zero-length one at index 2').toBe(false)
      }
    })

    it('#loop-degree3-refuses an irreducible degree-3 vertex REFUSES BY NAME (MUTATION ANCHOR)', () => {
      // A non-degenerate spur into the interior touches an existing vertex, forcing degree 3
      // with no zero-length tab to merge away. There is no single degree-2 loop; refuse.
      const segs = square()
      segs.push({ a: { x: 2, y: 0, z: 0 }, b: { x: 2, y: 1.5, z: 0 } })   // spur from (2,0) — a real edge
      const r = analyseSpliceLoop(segs)
      expect(r.ok, 'a degree-3 wire cannot be a face boundary').toBe(false)
      if (!r.ok) {
        expect(r.reason).toContain('degree-3 vertex')
        expect(r.reason, 'the refusal reports WHERE').toContain('(2,0,0)')
      }
    })

    it('a NON-FINITE vertex (NaN corner solve) REFUSES BY NAME — NaN>tol is false both ways', () => {
      const segs = square()
      segs[0] = { a: { x: NaN, y: 0, z: 0 }, b: { x: 2, y: 0, z: 0 } }
      const r = analyseSpliceLoop(segs)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('non-finite vertex')
    })

    it('TWO disjoint degree-2 loops (every vertex degree 2, but not ONE loop) REFUSES BY NAME', () => {
      // Two separate triangles: the degree census alone would pass. The single-loop walk catches it.
      const two: Array<{ a: Vec3; b: Vec3 }> = [
        { a: { x: 0, y: 0, z: 0 }, b: { x: 1, y: 0, z: 0 } }, { a: { x: 1, y: 0, z: 0 }, b: { x: 0, y: 1, z: 0 } }, { a: { x: 0, y: 1, z: 0 }, b: { x: 0, y: 0, z: 0 } },
        { a: { x: 5, y: 0, z: 0 }, b: { x: 6, y: 0, z: 0 } }, { a: { x: 6, y: 0, z: 0 }, b: { x: 5, y: 1, z: 0 } }, { a: { x: 5, y: 1, z: 0 }, b: { x: 5, y: 0, z: 0 } },
      ]
      const r = analyseSpliceLoop(two)
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('not a single loop')
    })

    it('a wire that collapses below 3 non-degenerate edges REFUSES BY NAME', () => {
      const r = analyseSpliceLoop([{ a: { x: 0, y: 0, z: 0 }, b: { x: 0, y: 0, z: 0 } }, { a: { x: 1, y: 1, z: 1 }, b: { x: 1, y: 1, z: 1 } }])
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toContain('collapses')
    })
  })

  // ---- 3) resolveEndSplice: enumerated STRUCTURAL refusals, on a mock kernel. ----
  // Each named refusal in the recognize-time constructibility check is exercised with a
  // controlled end-plane topology (the live Tray takes only the success path — proven by the
  // topology probe, all 33 SPLICEABLE=33 BAD=0 — so these paths need force-injection).
  describe('#endsplice resolveEndSplice names every structural refusal', () => {
    const END = 1000 as unknown as ShapeHandle
    // 8 points on a cyclic loop; edges P_i -> P_{i+1}. Edge handle == edge hash == index+1.
    const P: Vec3[] = [
      { x: 0, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }, { x: 4, y: 0, z: 0 }, { x: 6, y: 0, z: 0 },
      { x: 6, y: 4, z: 0 }, { x: 4, y: 4, z: 0 }, { x: 2, y: 4, z: 0 }, { x: 0, y: 4, z: 0 },
    ]
    // Build a mock kernel over an 8-edge outer wire. `owners` maps edge hash -> owner face hashes.
    function mock(opts: { wireCount?: number; wireThrows?: boolean }): OcctKernel {
      const OUTER = 3000 as unknown as ShapeHandle
      const wireCount = opts.wireCount ?? 1
      return {
        getSubShapes: (h: ShapeHandle, type: string): ShapeHandle[] => {
          if (opts.wireThrows && type === 'wire') throw new Error('mock: wires unreadable')
          if (type === 'wire' && h === END) return Array.from({ length: wireCount }, (_, i) => (2000 + i) as unknown as ShapeHandle)
          if (type === 'edge' && h === OUTER) return P.map((_, i) => (i + 1) as unknown as ShapeHandle)
          if (type === 'vertex') { const i = (h as unknown as number) - 1; return [(10000 + i) as unknown as ShapeHandle, (10000 + ((i + 1) % 8)) as unknown as ShapeHandle] }
          return []
        },
        outerWire: (): ShapeHandle => OUTER,
        vertexPosition: (v: ShapeHandle): Vec3 => P[(v as unknown as number) - 10000],
        hashCode: (e: ShapeHandle): number => e as unknown as number,
        release: (): void => { /* noop */ },
      } as unknown as OcctKernel
    }
    const endRec = (): FaceRec => ({ handle: END, hash: 999, type: 'plane', centroid: { x: 3, y: 2, z: 0 }, normal: { x: 0, y: 0, z: 1 }, area: 24, bbox: { xmin: 0, ymin: 0, zmin: 0, xmax: 6, ymax: 4, zmax: 0 }, innerLoops: 0, neighbours: [] })
    // corners flank the run [P1..P3] (edges 2,3): pBefore=P1, pAfter=P3. So farLips = P1, P3.
    const plan = (farA: Vec3, farB: Vec3): BlendRibbonPlan => ({
      torusHash: 1, blendRadius: 1, removeHashes: [7001], wallHashes: [], cylinderHash: 2, endPlaneHash: 999,
      arcCenter: { x: 0, y: 0, z: 0 }, arcDeep: { x: 0, y: 0, z: 0 },
      corners: [{ capHash: 0, ribCylHash: 0, sideHash: 0, overSideHash: 0, overEndHash: 0, tangency: farA, corner: farA, apex: farA, det: 0, residual: 0, concurrency: 0, farCyl: farA, farSide: farA, farLip: farA },
        { capHash: 0, ribCylHash: 0, sideHash: 0, overSideHash: 0, overEndHash: 0, tangency: farB, corner: farB, apex: farB, det: 0, residual: 0, concurrency: 0, farCyl: farB, farSide: farB, farLip: farB }] as BlendRibbonPlan['corners'],
    } as unknown as BlendRibbonPlan)
    // owners: an edge is a RUN edge iff its hash is in `runHashes` (mapped to the removed face 7001).
    const owners = (runHashes: number[]): Map<number, number[]> => { const m = new Map<number, number[]>(); for (const h of runHashes) m.set(h, [999, 7001]); return m }

    it('unreadable wire set refuses by name', () => {
      const r = resolveEndSplice(mock({ wireThrows: true }), endRec(), plan(P[1], P[3]), owners([]))
      expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toContain('unreadable')
    })
    it('an inner loop (wireCount != 1) refuses by name', () => {
      const r = resolveEndSplice(mock({ wireCount: 2 }), endRec(), plan(P[1], P[3]), owners([3, 4]))
      expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toContain('an inner loop is outside the class')
    })
    it('an end boundary with NO removal contact refuses by name', () => {
      const r = resolveEndSplice(mock({}), endRec(), plan(P[1], P[3]), owners([]))
      expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toContain('entirely untouched')
    })
    it('TWO separate boundary runs refuse by name', () => {
      // run edges 2 and 4 are non-contiguous around the 8-edge loop.
      const r = resolveEndSplice(mock({}), endRec(), plan(P[1], P[3]), owners([2, 4]))
      expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toContain('separate boundary runs')
    })
    it('a run not flanked by the two survivor lips refuses by name', () => {
      // run = edges 3,4 (P2..P4), flanked by P2 and P4 — but declare the far lips as P0,P5.
      const r = resolveEndSplice(mock({}), endRec(), plan(P[0], P[5]), owners([3, 4]))
      expect(r.ok).toBe(false); if (!r.ok) expect(r.reason).toContain('not flanked by the two recognized survivor lips')
    })
    it('a single run flanked by the two survivor lips SUCCEEDS (accept path)', () => {
      // run = edges 2,3 (P1..P3), flanked by P1 and P3 = the declared far lips.
      const r = resolveEndSplice(mock({}), endRec(), plan(P[1], P[3]), owners([2, 3]))
      expect(r.ok, r.ok ? '' : r.reason).toBe(true)
      if (r.ok) { expect(r.keptEdges.length, '8 edges minus the 2-edge run = 6 kept').toBe(6); expect(r.firstFar).toEqual(P[1]) }
    })
  })

  // ---- 4) orderedOuterEdges: structured failure on an un-walkable boundary. ----
  it('#ordered orderedOuterEdges returns null when the boundary does not chain into one loop', () => {
    const OUTER = 3000 as unknown as ShapeHandle
    // three disconnected edges: cannot form a closed loop.
    const segs = [[{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }], [{ x: 5, y: 5, z: 0 }, { x: 6, y: 5, z: 0 }], [{ x: 9, y: 9, z: 0 }, { x: 9, y: 8, z: 0 }]]
    const kmock = {
      outerWire: (): ShapeHandle => OUTER,
      getSubShapes: (h: ShapeHandle, type: string): ShapeHandle[] => {
        if (type === 'edge') return segs.map((_, i) => (i + 1) as unknown as ShapeHandle)
        if (type === 'vertex') { const i = (h as unknown as number) - 1; return [(100 + i * 2) as unknown as ShapeHandle, (101 + i * 2) as unknown as ShapeHandle] }
        return []
      },
      vertexPosition: (v: ShapeHandle): Vec3 => { const n = (v as unknown as number) - 100; return segs[Math.floor(n / 2)][n % 2] },
      release: (): void => { /* noop */ },
    } as unknown as OcctKernel
    expect(orderedOuterEdges(kmock, END_HANDLE)).toBeNull()
  })

  // ---- 4b) FOLD BK-110(b): polesRadialBound fail-closes a rational curve with falsy weights. ----
  // The bug: `nd.rational && nd.weights` guarded the positive-weight check only when weights
  // were truthy, so a curve flagged rational with undefined/empty weights SKIPPED the guard and
  // was treated as non-rational — an unverifiable pole-at-infinity could sail through. The fix
  // fail-closes: an unverifiable rational curve is unbounded (Infinity), never silently non-rational.
  describe('#poles polesRadialBound fail-closes an unverifiable rational curve (BK-110(b))', () => {
    const kmock = (nd: unknown): OcctKernel => ({ getNurbsCurveData: () => nd } as unknown as OcctKernel)
    const O = { x: 0, y: 0, z: 0 }; const Z = { x: 0, y: 0, z: 1 }
    // three poles at radius 3 from the z-axis; a NON-rational curve bounds them at 3.
    const poles = [3, 0, 0, 0, 3, 0, -3, 0, 0]
    it('rational:true with FALSY weights -> Infinity (cannot verify positivity, fail closed)', () => {
      expect(polesRadialBound(kmock({ rational: true, weights: undefined, poles }), 0 as unknown as ShapeHandle, O, Z, 0)).toBe(Infinity)
      expect(polesRadialBound(kmock({ rational: true, weights: [], poles }), 0 as unknown as ShapeHandle, O, Z, 0)).toBe(Infinity)
    })
    it('rational:true with a NON-POSITIVE weight -> Infinity', () => {
      expect(polesRadialBound(kmock({ rational: true, weights: [1, 0, 1], poles }), 0 as unknown as ShapeHandle, O, Z, 0)).toBe(Infinity)
      expect(polesRadialBound(kmock({ rational: true, weights: [1, -2, 1], poles }), 0 as unknown as ShapeHandle, O, Z, 0)).toBe(Infinity)
    })
    it('rational:true with a TRUNCATED weight vector (not one per pole) -> Infinity', () => {
      expect(polesRadialBound(kmock({ rational: true, weights: [1, 1], poles }), 0 as unknown as ShapeHandle, O, Z, 0)).toBe(Infinity)
    })
    it('rational:true with all-positive weights -> the finite radial bound (not over-tightened)', () => {
      const b = polesRadialBound(kmock({ rational: true, weights: [1, 1, 1], poles }), 0 as unknown as ShapeHandle, O, Z, 0)
      expect(Math.abs(b - 3), `bounded at pole radius 3, got ${b}`).toBeLessThan(1e-9)
    })
    it('CONTROL: a NON-rational curve is bounded at the pole radius (the guard does not fire)', () => {
      const b = polesRadialBound(kmock({ rational: false, weights: undefined, poles }), 0 as unknown as ShapeHandle, O, Z, 0)
      expect(Math.abs(b - 3)).toBeLessThan(1e-9)
    })
  })

  // ---- 5) F1/F2 on the WIDENED path: a newly-in-class ribbon (large shared end plane) ----
  //         heals through the same makeFaceOnSurface + fixShape(non-planar) + area>0 + isValid
  //         guards. Pins the volume so deleting the fixShape pcurve repair fails by name. ----
  it('#widened-ribbon-F2 a newly-widened ribbon (>8-edge end plane) heals valid through the F1/F2 guards', () => {
    const shape = loadStep(k, 'tray.step'); const recs = gatherFaces(k, shape); const scratch: ShapeHandle[] = []
    try {
      const feats = recognizeFeatures(k, shape, recs)
      const byHash = new Map<number, FaceRec>(recs.map((r) => [r.hash, r]))
      // pick an in-class ribbon whose END plane has MORE than 8 outer edges — i.e. one the old
      // recipe could NOT build (a large end plane shared by several channels).
      const widened = feats.filter((f) => f.blendPlan).map((f) => ({ f, end: byHash.get(f.blendPlan!.endPlaneHash)! }))
        .find(({ end }) => { const w = k.outerWire(end.handle); const es = k.getSubShapes(w, 'edge'); const n = es.length; releaseAll(k, es); try { k.release(w) } catch { /* */ } return n > 8 })
      expect(widened, 'the Tray has a large-shared-end-plane ribbon (the GEO-13 target class)').toBeDefined()
      const heal = healRemoval(k, shape, [widened!.f], scratch, recs)
      expect(heal.ok, `the widened ribbon heals: ${heal.reason ?? ''}`).toBe(true)
      const solid = heal.shape!; scratch.push(solid)
      expect(k.isValid(solid), 'F1/F2: the widened-ribbon solid is valid').toBe(true)
      expect(k.isSolid(solid)).toBe(true)
      expect(census(k, solid).free, 'watertight').toBe(0)
      expect(faceCount(k, solid), '696 - 5 removed').toBe(ORIGINAL_FACES - 5)
      // F2 anchor: sharpening a convex fillet adds material (positive delta). Deleting the
      // fixShape pcurve repair silently returns a zero-area cylinder wall and blows the volume.
      expect(heal.volumeDelta!, 'positive, bounded volume delta (not the 4821 zero-area mode)').toBeGreaterThan(1e-6)
      expect(heal.volumeDelta!, 'and physically small — one sharpened corner').toBeLessThan(20)
    } finally { releaseAll(k, scratch); releaseFaceRecs(k, recs); try { k.release(shape) } catch { /* */ } }
  }, 240_000)

  // ---- 6) OWED FIXTURE BK-96: a fabricated force-sewn SECOND, non-tangent boundary between ----
  //         two already-admitted ribbon members refuses by name via the NON-TREE branch. ----
  // GEO-12 answered this with a constructibility argument only (two G1-tangent analytic surfaces
  // are tangent along their whole intersection, so a second non-tangent boundary needs a third
  // trimming surface). This is the owed can-fail fixture: it FORCE-SEWS such a boundary. The two
  // fillet cylinders of the #223 ribbon (corners[0]/corners[1].ribCyl) are admitted via the
  // torus (tree edges) but are NOT adjacent to each other; we make them adjacent and inject a
  // real edge into their shared-edge set through a Proxy kernel (the GEO-6X5-R2 #8b technique).
  // The chain walk reaches that second boundary ONLY through the `ribbon.has(nh)` non-tree
  // branch — the exact path GEO-6X5-R2(c) added — and refuses within the bounded class.
  it('#bk96 a fabricated force-sewn non-tangent SECOND boundary between two members refuses by name', () => {
    const shape = loadStep(k, 'tray.step'); const recs = gatherFaces(k, shape)
    try {
      const byHash = new Map<number, FaceRec>(recs.map((r) => [r.hash, r]))
      const owners = buildEdgeOwners(k, recs)
      const target = recognizeFeatures(k, shape, recs).find((f) => f.key === TARGET_KEY)!
      const plan = target.blendPlan!
      const seed = byHash.get(plan.torusHash)!
      const cylA = byHash.get(plan.corners[0].ribCylHash)!
      const cylB = byHash.get(plan.corners[1].ribCylHash)!

      // The premise the fixture rests on, asserted so it cannot silently stop being one: the
      // two fillet cylinders are NOT normally adjacent, so the injected edge really is a SECOND,
      // non-tree boundary — the only way to reach it is the ribbon.has() branch.
      expect(cylA.neighbours.includes(cylB.hash), 'the two fillet cylinders are not normally adjacent').toBe(false)
      expect(cylB.neighbours.includes(cylA.hash)).toBe(false)

      // CONTROL: untouched, the ribbon is in-class (so the refusal below is caused by the
      // injected boundary and nothing else).
      expect(analyzeBlendRibbon(k, byHash, seed, new Map<number, AnalyticFrame | null>(), owners).ok,
        'control: the #223 ribbon is in-class on the untouched kernel').toBe(true)

      // Make cylA adjacent to cylB (the force-sew), and borrow a real non-degenerate edge to
      // stand in for the fabricated shared boundary.
      const modRecs = recs.map((r) => (r.hash === cylA.hash ? { ...r, neighbours: [...r.neighbours, cylB.hash] } : r))
      const modByHash = new Map<number, FaceRec>(modRecs.map((r) => [r.hash, r]))
      const es = k.getSubShapes(cylA.handle, 'edge')
      let borrowed: ShapeHandle | null = null
      for (const e of es) { if (borrowed === null && k.getLength(e) > 1e-9) borrowed = e; else { try { k.release(e) } catch { /* */ } } }
      expect(borrowed, 'a real non-degenerate edge is available to force-sew').not.toBeNull()

      const proxy = new Proxy(k, {
        get(t, prop) {
          if (prop === 'sharedEdges') return (a: ShapeHandle, b: ShapeHandle): ShapeHandle[] => {
            const hit = (a === cylA.handle && b === cylB.handle) || (a === cylB.handle && b === cylA.handle)
            return hit ? [borrowed!] : t.sharedEdges(a, b)
          }
          const v = Reflect.get(t, prop, t)
          return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v
        },
      }) as unknown as OcctKernel

      const res = analyzeBlendRibbon(proxy, modByHash, seed, new Map<number, AnalyticFrame | null>(), owners)
      expect(res.ok, 'a fabricated second non-tangent boundary is NOT a valid ribbon').toBe(false)
      if (!res.ok) {
        expect(res.reason, 'the refusal names the bounded class').toContain('bounded analytic blend-ribbon class')
        // The force-sewn junction of two cylinders that do not actually meet lies off cylB's
        // analytic frame — the G1-verification family rejects it. (A genuinely coincident but
        // transverse boundary would instead trip the 'not tangentially' sub-gate; GEO-12's
        // argument is that such a boundary is not constructible from the analytic pair at all.)
        expect(res.reason, 'the non-tree boundary is rejected by the G1-verification gate').toMatch(/off the analytic frames|not tangentially/)
      }
      try { k.release(borrowed!) } catch { /* */ }
    } finally { releaseFaceRecs(k, recs); try { k.release(shape) } catch { /* */ } }
  }, 180_000)

  // ---- 7) OWED FIXTURE F6: the cone-runout-cap "is it actually a cone (has an apex)?" gate. ----
  // On the Tray every runout cap is a full cone, so coneApex() always finds the apex and the
  // `if (!apex) refuse` gate is guarded by code reading alone. This reaches the gate directly:
  // a TRUNCATED cone (type 'cone', but no degenerate apex edge) returns null — the runout is not
  // a cone — while a full cone yields its apex vertex.
  it('#f6 coneApex refuses a truncated cone (no apex) and finds the apex of a full cone', () => {
    const scratch: ShapeHandle[] = []
    const coneFace = (r1: number, r2: number): FaceRec => {
      const solid = k.makeCone(r1, r2, 5); scratch.push(solid)
      const fs = k.getSubShapes(solid, 'face')
      let coneF: ShapeHandle | null = null
      for (const f of fs) { let t = ''; try { t = k.surfaceType(f) } catch { /* */ } if (t === 'cone' && coneF === null) { coneF = f } else { scratch.push(f) } }
      expect(coneF, `makeCone(${r1},${r2},5) exposes a cone lateral face`).not.toBeNull()
      scratch.push(coneF!)
      return { handle: coneF!, hash: 1, type: 'cone', centroid: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, area: 1, bbox: { xmin: -r1, ymin: -r1, zmin: 0, xmax: r1, ymax: r1, zmax: 5 }, innerLoops: 0, neighbours: [] }
    }
    try {
      // full cone (apex at the top): the gate PASSES — an apex is found.
      const apex = coneApex(k, coneFace(3, 0))
      expect(apex, 'a full cone has a degenerate apex edge').not.toBeNull()
      expect(Number.isFinite(apex!.x) && Number.isFinite(apex!.y) && Number.isFinite(apex!.z), 'the apex is finite').toBe(true)
      // truncated cone (frustum): NO degenerate apex edge -> the gate REFUSES (null).
      expect(coneApex(k, coneFace(3, 1)), 'a truncated cone (no apex) reaches the not-a-cone gate').toBeNull()
    } finally { releaseAll(k, scratch) }
  }, 120_000)
})
