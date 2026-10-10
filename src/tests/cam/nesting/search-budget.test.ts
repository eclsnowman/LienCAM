/* R1.1 (INT-H1-R1 rework, BK-7 audit blocker): the wall-clock bailout removed
 * in d4022b6 was replaced by a FIXED generation cap alone, which is NOT a
 * bound on dense-part runtime - every individual in every generation is
 * always fully evaluated regardless of how expensive each evaluation is (the
 * BMG x12 perf gate ran >120s before this fix, see coordination/reports/
 * INT-H1.audit.json). This file proves the actual replacement: NfpBudget
 * (placement.ts), a deterministic NFP-computation-cost meter threaded through
 * packNest's GA loop as `req.searchBudget` (types.ts) / DEFAULT_SEARCH_BUDGET
 * (index.ts). It is a PURE function of the input geometry (ringA.length *
 * ringB.length per NFP call) - never wall-clock - so it bounds runtime
 * identically on any machine under any load.
 *
 * Uses a SYNTHETIC dense part (a many-vertex circle approximation) rather than
 * the real BMG.dxf fixture (perf.test.ts) so this test is fast, self-
 * contained, and does not depend on Sample Parts/BMG.dxf. CAUTION for anyone
 * extending this file: an EFFECTIVELY UNBOUNDED budget (e.g.
 * Number.MAX_SAFE_INTEGER) on this fixture is the exact multi-minute hang
 * this WO fixes (~80 dense evaluations at ~290k cost units each) - never run
 * that automatically; the "does the check matter" proof is a MANUAL revert
 * (recorded in the WO completion report), not a CI assertion.
 */
import { describe, it, expect } from 'vitest'
import type { Vec2 } from '../../../types/index'
import { packNest, placeParts, sheetRect, NfpBudget } from '../../../lib/cam/nesting'
import type { NestPart, NestRequest, PlacementPart } from '../../../lib/cam/nesting'

/** A convex N-vertex polygon approximating a circle (geometric CCW). Cheap to
 *  describe but EXPENSIVE for the NFP orbit (placement.ts/nfp.ts are ~O(n*m)
 *  in ring vertex count) - a synthetic stand-in for a dense imported part like
 *  BMG.dxf (~50-80 simplified verts) without needing the DXF fixture. */
function denseCircle(id: string, radius: number, n: number): NestPart {
  const outer: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI
    outer.push({ x: radius + radius * Math.cos(a), y: radius + radius * Math.sin(a) })
  }
  return { id, outer, holes: [] }
}

const DENSE_VERTS = 80

function denseFixtureReq(searchBudget: number | undefined): NestRequest {
  return {
    parts: [{ part: denseCircle('gear', 15, DENSE_VERTS), quantity: 10 }],
    sheet: { width: 200, height: 200 },
    style: 'ninety',
    // zero spacing: no clipper offset-grow, so the ring the GA/placement
    // worker sees stays exactly DENSE_VERTS verts (a round-join offset would
    // add many more, muddying the vertex-product cost estimate below).
    spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
    solver: { kind: 'fixSheet' },
    seed: 42,
    // curveTolerance: 0 keeps the dense ring un-simplified (this test targets
    // the GA generation loop's budget, not the simplify.ts proxy collapse
    // perf.test.ts already covers).
    curveTolerance: 0,
    searchBudget,
  }
}

describe('nesting packer: deterministic search budget (BK-7 rework, INT-H1-R1)', () => {
  it('placeParts (unit level): a tiny budget bails mid-pass, leaving instances unplaced, cost never exceeds budget by more than one in-flight NFP call', async () => {
    // packNest's clipper2-wasm init is required by placeParts' union() call in
    // its obstacle-NFP branch (2nd+ part); route through a trivial packNest
    // call first so the engine is ready before calling placeParts directly.
    await packNest({
      parts: [],
      sheet: { width: 10, height: 10 },
      style: 'ninety',
      spacing: { partGap: 0, sheetMargin: 0, windowGap: 0 },
      solver: { kind: 'fixSheet' },
      seed: 1,
    })

    const part = denseCircle('gear', 15, DENSE_VERTS)
    const sheet = sheetRect(200, 200)
    const parts: PlacementPart[] = Array.from({ length: 10 }, (_, i) => ({
      partId: part.id,
      instanceId: `gear#${i}`,
      outer: part.outer,
      rotationDeg: 0,
    }))
    // one full pass with NO budget places every instance (the fixture fits
    // comfortably on 200x200 with no partGap) - the baseline this test bounds.
    const unrestricted = placeParts(parts, sheet)
    expect(unrestricted.placed.length).toBe(10)

    // a budget far smaller than one full pass needs (a single part-vs-part NFP
    // between two 80-vertex rings alone costs 80*80=6400 units) stops the pass
    // early: fewer instances placed, no overlap risk taken (ADR 0003 fallback).
    const TINY_BUDGET = 5000
    const budget = new NfpBudget(TINY_BUDGET)
    const bounded = placeParts(parts, sheet, budget)
    expect(bounded.placed.length).toBeLessThan(10)
    expect(budget.exhausted).toBe(true)
    // consumed <= budget, up to the single in-flight call that tripped it
    // (spend() is charged before the exhaustion check on the NEXT iteration,
    // so the overshoot is bounded by one call's cost, not unbounded growth).
    const consumed = TINY_BUDGET - budget.remainingUnits
    expect(consumed).toBeLessThanOrEqual(TINY_BUDGET + DENSE_VERTS * DENSE_VERTS)
  }, 45_000) // clipper2-wasm init alone measured ~10.6s isolated; generous bound
  // for full-suite parallel contention (same flake class as winding-cw.test.ts).

  it('packNest (integration level): a small explicit searchBudget keeps a dense synthetic fixture fast and demonstrably short of a larger-budget search', async () => {
    // "larger" here is still bounded (50,000 units, a few seconds at most) -
    // NOT an unbounded/full search, which for this 10-instance dense fixture
    // would run ~80 evaluations at ~290k cost units EACH (multiple minutes) -
    // exactly the class of hang this WO removes. Never widen this to an
    // effectively-unbounded budget in an automated test.
    const t0 = performance.now()
    const larger = await packNest(denseFixtureReq(50_000))
    const msLarger = performance.now() - t0

    const t1 = performance.now()
    const tiny = await packNest(denseFixtureReq(5_000))
    const msTiny = performance.now() - t1

    // the smaller budget stops with fewer parts placed than the larger one -
    // proof the budget actually gates how much search happens.
    expect(tiny.placements.length).toBeLessThan(larger.placements.length)
    // both complete in a sane time (the "no multi-minute hang" proof - BMG x12
    // took >120s unbounded per the audit; here even the larger of the two
    // budgets stays in the single-digit seconds).
    expect(msLarger).toBeLessThan(15_000)
    expect(msTiny).toBeLessThan(5_000)
  }, 30_000)

  it('determinism holds under a searchBudget: identical seed + budget => byte-identical placements', async () => {
    const req = denseFixtureReq(8_000)
    const a = await packNest(req)
    const b = await packNest(req)
    expect(b).toEqual(a)
  }, 20_000)
})
