// WO-435 GOODSPEC TRIPWIRES (T1 retract budget + attribution, T2 pass-count sanity, T3
// spiral continuity). GOOD-SPEC.md section 6, wired as CI-runnable tests so a behavior-
// reshaping engine change that lands without these passing is a process violation, not a
// judgment call (T6). Runs the nine gt corpus fixtures at canonical settings.
//
// WHY THESE ARE "PINNED", NOT "BUDGET-ASSERTED": T1's budget and T2's K-multiple are
// GOOD-SPEC working assumptions the engine does not meet on every fixture today (measured
// gap: current engine sits at 2.5-4x Fusion's pass count). Asserting `lifts <= budget`
// directly would either (a) fail out of the box on fixtures already over budget -- correct,
// but gives no way to tell "still over budget, unchanged" from "got worse" -- or (b) invite
// widening the budget to go green, which GOOD-SPEC and this WO explicitly forbid ("Never
// mask a red by widening a budget"). Instead each fixture's CURRENT measured lifts/cuts
// count is pinned as a literal expectation (recorded next to the real target, printed in
// the table below); any future engine change that moves the number -- regression OR
// improvement -- trips this test and must be reviewed and re-pinned deliberately. This is
// the same pattern as the byte-stability fingerprint test, applied to a coarser metric.
//
// ATTRIBUTION (T1's other half) and CONTINUITY (T3) are NOT pinned -- they are hard
// invariants asserted directly: every jumpType-2 link must carry a liftReason that is not
// an 'unattributed-*' fallback. See _goodspec-helpers.ts for the liftReason plumbing
// (processFeature.ts, WO-435) and the GoodspecMeasurement.t3Violations doc comment for why
// T3 currently reuses the SAME signal as T1's attribution count (an honest simplification,
// not a hidden gap -- see this file's reported findings).
//
// Run: npx vitest run src/tests/adaptive-clearing/engine/goodspec-tripwires.test.ts

import { describe, it, expect, beforeAll, afterEach } from 'vitest'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { FIXTURE_META, measureGoodspecFixture, ALLOWANCE, K, type GoodspecMeasurement } from './_goodspec-helpers'

// ---- PINNED current measured numbers (2026-08-20, this WO). Re-pin deliberately (with a
// dated comment on the diff) when a reviewed engine change moves a fixture's numbers. Never
// widen these to paper over a regression; never narrow the ALLOWANCE/K targets to make a
// pin look worse than it is. ----
// WO-437 (2026-08-22): the honest split. Total lifts (clearance + micro) is UNCHANGED from
// the pre-WO-437 PINNED_LIFTS on every fixture -- micro-lift only changes the Z height of an
// already-lifting link's two horizontal rapids, it never adds or removes a lift or a cut.
// T1's budget now counts ONLY PINNED_CLEARANCE_LIFTS (tier 3); PINNED_MICRO_LIFTS (tier 2)
// is reported, not budgeted, per GOOD-SPEC.md section 3.
// WO-439 STEP 2 (2026-08-20) RE-PIN -- READ THE DIRECTIONS, THEY ARE NOT ALL IMPROVEMENTS.
// Three convicted engine fixes landed (wall-skim judged by load; the engage walker's bite
// clipped to the material a pass can actually remove; the pass-progress floor made
// reachable). Full before/after census: src/tests/evidence/WO-439/step2/.
//
// ENTRIES (not pinned here, but the headline): 7->1 Bar, 10->1 Triangle, 11->3 BootL,
//   9->1 Boomerang, 6->1 Barbell, 2->1 Kidney, 2->1 Tee, 1->1 Comma, 1->1 SquareIsland.
//   Every extra entry was a fruitless-lap reseed; the walk now exhausts honestly.
// RESIDUAL (honesty, must never grow): Bar 16.449->4.237, Tee 23.689->5.455,
//   BootL 37.911->7.408, Barbell 0.016->0.008, Comma 2.205->2.200, Kidney 1.499->1.491,
//   Triangle 11.853->11.843, SquareIsland 3.633->3.633 mm2 -- eight better or level.
//   ONE GREW: Boomerang 4.758->5.819 mm2 (+1.06). Reported, not hidden.
//
// PIN MOVES, with direction:
// - CLEARANCE LIFTS (tier 3, the T1 budget) 76 -> 38 corpus-wide. BETTER on six
//   (Kidney 21->10, BootL 23->5, SquareIsland 9->7, Barbell 8->3, Boomerang 4->2,
//   Bar 3->1), level on one (Comma 2), WORSE on one (Tee 3->5).
// - MICRO LIFTS (tier 2, reported not budgeted) 82 -> 330. BETTER on five
//   (Triangle 17->2, Boomerang 16->1, Tee 8->1, Bar 9->2, BootL 12->8), WORSE on three
//   (Comma 2->74, Kidney 10->101, Barbell 8->141), level on SquareIsland (0).
//   CAUSE, measured: passes that used to die at zero motion on the wall and be DROPPED
//   (no cut, no connection emitted) now cut a real short rim pass, and each of those has
//   to be connected. The connection is refused at depth because the rim between them is
//   belief-uncut (T5, zero tolerance) and hops at the 2 mm micro-lift height instead of
//   flying to clearance. Honest, but it is more hopping than before.
// - CUTS (T2) WORSE ON ALL NINE: 263->277, 301->354, 264->267, 142->152, 79->94,
//   232->236, 106->154, 296->304, 174->203. K-multiple vs Fusion moved 4.17->4.40,
//   3.81->4.48, 2.59->2.62, 2.41->2.58, 2.08->2.47, 2.17->2.21, 1.77->2.57, 5.48->5.63,
//   2.07->2.42. THIS IS THE WRONG DIRECTION FOR T2 AND IS NOT CLAIMED AS PROGRESS. Part
//   of it is honest (the engine now removes material it used to abandon -- see the
//   residual line), but the census shows the rest is the walker still handing out
//   wall-band crumb starts inside its tiny engage band; closing that is a different site
//   (the walker's minimum-bite band / a tier-0 continue-on), not one of the three
//   convicted here. Re-pinned so the tripwire is LIVE again, with the regression named.
// - UNATTRIBUTED lifts and T3 violations: still ZERO on all nine. Hard invariants held.
//
// Pre-WO-439 pins, for the record:
//   clearance { 0:2, 1:21, 2:9, 3:3, 4:3, 5:23, 6:3, 7:8, 8:4 }
//   micro     { 0:2, 1:10, 2:0, 3:8, 4:9, 5:12, 6:17, 7:8, 8:16 }
//   cuts      { 0:263, 1:301, 2:264, 3:142, 4:79, 5:232, 6:106, 7:296, 8:174 }
//
// WO-438 (2026-08-20): a connection that used to fly now descends two further tier-1 rungs
// first -- the SAME wall ride rung (a) already offers, retried under the ancestor's
// keepToolDownDistRatio DETOUR budget instead of the wall-follow length factor; then a routed
// keep-down ride through the graph of ground the cutter has actually SWEPT (backtrack along
// its own track, AC-SPEC E.3). Every pin below moved in the IMPROVING direction only, and
// NOTHING ELSE MOVED: cuts, entries and the residual are byte-identical to the pre-WO-438
// engine on all nine fixtures -- a recovered connection changes how the tool GETS somewhere,
// never what it removes (measured: fix5 BootL real leftover 37.911 mm^2 before and after).
// Total lifts 233 -> 158; clearance lifts 110 -> 76; no fixture got worse on either count.
// Pre-WO-438 pins, for the record:
//   clearance { 0:3, 1:31, 2:20, 3:6, 4:3, 5:24, 6:4, 7:8, 8:11 }
//   micro     { 0:4, 1:28, 2:13, 3:8, 4:9, 5:14, 6:17, 7:13, 8:17 }
// WO-453 (2026-08-22) RE-PIN -- OPERATOR'S PICTURE VERDICT FIRST, THEN THIS.
// Landed only after Operator answered the picture gate on card
// Q-THE-LONG-FLYING-MOVE-ON-BOOTL-IS-1787288597331 with "Yes - land it". The
// pictures he judged are src/tests/evidence/WO-453/picture-gate/ (BootL and
// Tee, before and after, climb wf1).
//
// WHAT LANDED: closed cleanup and finish contours are now seamed where the
// tool already stands, instead of starting at whatever vertex the geometry
// happened to begin at. BootL climb wf1 is the headline: liftTravel
// 64.56 -> 0.00 mm, seamFlight 65.34 -> 0.78 mm, one clearance retract
// REMOVED, ride travel and residual byte-identical. Across all 72 cells:
// total travel -3816.51 mm, seam flight -3477.85 mm, residual worse in 0 of 72.
//
// FOUR PINS MOVE. Directions named, never averaged:
// - MICRO LIFTS (tier 2, reported not budgeted): CommaSpiral 74 -> 75,
//   BootL 8 -> 9, Barbell 141 -> 142. Each is one extra 2 mm hop near the
//   floor. A re-seamed contour starts at a different vertex, so the link into
//   it is a different link; where the new one crosses belief-uncut rim it hops
//   at micro height instead of flying to clearance. Itemised per cell in
//   src/tests/evidence/WO-453/.
// - CLEARANCE LIFTS (tier 3, the T1 budget): Barbell 3 -> 2. BETTER, and this
//   is the tier Operator watches.
//   Barbell moving on both counts is ONE event, not two: it traded a full
//   flight to safe Z for a 2 mm hop near the floor. That is the trade this
//   work order exists to make.
//
// A tier-3 flight and a tier-2 hop are NOT the same event and are deliberately
// not summed here. Conflating them is exactly what got this WO's first
// acceptance bar rejected.
//
// FOUR, not the THREE the audit listed - and the reason is worth keeping. The
// clearance assertion runs BEFORE the micro assertion in the same test, so
// Barbell's clearance failure short-circuited its own micro check and that
// second move could not be seen until the first was re-pinned. The audit
// reported what the test reported. Re-pin, re-run, and look again: a pin
// standing behind a failed pin is invisible.
//
// NOT MOVED, checked rather than assumed: cuts on all nine, entries,
// unattributed lifts (still zero), T3 violations (still zero), and every
// _bytestab pass count. Seven _bytestab hashes move while all nine pass counts
// stay identical -- the signature of a re-seam, not of different work.
//
// Pre-WO-453 pins, for the record:
//   clearance { 0:2, 1:10, 2:7, 3:5, 4:1, 5:5, 6:3, 7:3, 8:2 }
//   micro     { 0:74, 1:101, 2:0, 3:1, 4:2, 5:8, 6:2, 7:141, 8:1 }
//
// ---- WO-466 (2026-08-26) re-pin: ONE PIN, ONE FIXTURE, ONE CONNECTION ----
//
// WO-466 adds tier 2.5 to the connection ladder: where the ground is clear until a
// connection's last millimetres, travel at depth to where the proof stops clearing and
// FEED the engaged tail, instead of conceding a retract to cross ground already proven.
//
// MICRO LIFTS: BootL 9 -> 8. BETTER, and it is ONE named connection, not a drift:
//   [keepdown-stopshort] stop-short@(26.86, -99.50): 12.56mm of the 13.64mm chord
//   travelled AT DEPTH (proved clean by rung (b)(4)'s own traverse cap), then 1.07mm FED
//   into the standing skin (<= the 1.60mm cut-through length bar, load-proven).
// This is the connection Operator named on the WO-447 card ("BootL gained two retracts
// between far-apart wall rides"), taken at depth instead of hopped over.
//
// NOT MOVED, measured rather than assumed (src/tests/evidence/WO-466/passcensus_*.json):
// the ROUGHING CUT PATH is byte-identical on all NINE fixtures -- a sha256 over every
// 'cut' pass's geometry, in order, matches before and after everywhere, BootL included.
// So do clearance lifts (all nine), cuts (all nine), entries, unattributed (still zero),
// T3 violations (still zero) and residual (BootL 7.4083 mm2 before and after). Eight of
// the nine fixtures are unchanged in every field including the _bytestab hash.
// BootL's own pass stream moves by exactly one reclassified connection: link 18 -> 17,
// loopback 211 -> 212, lead 0 -> 1 (916 -> 917 passes). Its wall-ride GEOMETRY moves too,
// and that is the direct consequence of not lifting: a lift's landing gate shrinks the
// cusp entry ride to protect the plunge, and with no plunge there is nothing to protect,
// so the ride is emitted at full length.
//
// Pre-WO-466 pins, for the record:
//   micro     { 0:75, 1:101, 2:0, 3:1, 4:2, 5:9, 6:2, 7:142, 8:1 }
//
// ---- WO-1069 (2026-08-28) re-pin: ONE PIN, ONE FIXTURE, AND IT IS WORSE ----
//
// OPERATOR'S PICTURE VERDICT FIRST, THEN THIS: "Yes - land it", 2026-08-28 10:23Z, on the
// Kidney pct25 pass-3 before/after and the overviews in src/tests/evidence/WO-1069/.
//
// WHAT LANDED: the milling-direction gate that decides whether a built loopback survives
// was a knife-edge probe (offset the first segment's midpoint 1e-3 mm, ask pip2 which side
// is cleared). That only answers truthfully when the midpoint is ON the wall; for a ride
// buildLoopback had trimmed back to a fillet contact -- 4-9x that offset off the wall --
// the verdict was constant, the good loopback was thrown away, and the bare link that
// replaced it doubled back. Those doubling-back links are the 32 non-tangent keep-down
// corners WO-1069 was opened on (nonTangentKeepdownLinks 32 -> 0 corpus-wide). Replaced
// with a winding test, plus a fallback ladder for the transitions that have no tangent join
// at any radius: keep down on the plain cut-to-cut link if that corridor is proven clean,
// otherwise RETRACT. Never a kink.
//
// ONE PIN MOVES, and the direction is WORSE. Named, not averaged:
// - MICRO LIFTS (tier 2, reported not budgeted): Boomerang 1 -> 2. Corpus 332 -> 333.
//   It is the retract half of that ladder, once, corpus-wide: one Boomerang transition
//   whose kinked ride+link shape is now unreachable and whose plain-link corridor gouges
//   the finish stock, so it becomes a jumpType-2 link with liftReason
//   `wall-clean-unjoinable@(x, y)`. A 2 mm hop bought in exchange for a kink is the trade
//   this order exists to make, but it is still one more hop and is not claimed as progress.
//
// NOT MOVED, measured rather than assumed (src/tests/evidence/WO-1069/census-table.tsv):
// CLEARANCE LIFTS (the T1 budget) on all nine; CUTS (T2) on all nine; entries;
// unattributed (still zero); T3 violations (still zero). The ROUGHING CUT PATH is
// byte-identical on all nine fixtures -- a sha256 over every 'cut' pass, in order, matches
// before and after everywhere (census-table.tsv cutHash column). What moved inside the
// _bytestab hashes is loopback/link classification and the wall-follow rides at those
// transitions: loopbacks 1594 -> 1621 (of which routed 0 -> 155), jumpType-1 links 58 -> 30,
// wall-follow length 8187.323 -> 8113.704 mm, total travel 27466.574 -> 27448.525 mm.
//
// WO-1103 (2026-08-29) re-pin, ONE fixture, attributed: fix4 Bar micro lifts 2 -> 1 and cuts
// 94 -> 93. Bar's entry moved from the region centroid to one end of the channel (WO-1100
// measured why: a spiral grown at the centroid of a 21.30 x 62.83 mm pocket saturates across
// the width and strands ~21 mm at each end, and the walk can only reach the far end by
// lifting). Bar's CLEARANCE lifts are unchanged at 1 here and fall 1 -> 0 at the corpus
// settings, which is the bank the order's acceptance is written in; here one of the two
// tier-2 micro lifts the old centred spiral needed is no longer asked for. Bar's widest cut
// at THIS bank also falls 2.164 -> 1.364 mm2/mm and its residual 4.237 -> 3.633 mm2. No other
// fixture moved -- census: src/tests/evidence/WO-1103/census.tsv.
//
// Pre-WO-1069 pins, for the record:
//   micro     { 0:75, 1:101, 2:0, 3:1, 4:2, 5:8, 6:2, 7:142, 8:1 }
// ---- WO-1178 (2026-09-02) re-pin: ALL NINE fixtures, every pin, and the direction is named ----
//
// The cohesive adaptive close-out changes how rings advance (a pass rides the wall it touches
// into the corner rim instead of dying at the first contact), how the engage walker plants a
// start (exact projection, rising bite only, the band's low edge, a start must offer the
// progress bite), what the wall band is credited (never a convex corner), and what a cusp ride
// may do (held to the ride cap). Every fixture's plan moves. Diagnosis, census and pictures:
// src/tests/evidence/WO-1178/ (diagnosis.md, corpus/, corpus-canonical/, app-before/, app-after/).
//
// CLEARANCE LIFTS (tier 3, the T1 budget): 37 -> 2 corpus-wide. BETTER on eight
//   (Comma 2->0, Kidney 10->1, SquareIsland 7->1, Tee 5->0, Bar 1->0, BootL 5->0,
//   Triangle 3->0, Barbell 2->0, Boomerang 2->0), level on none, worse on none.
// MICRO LIFTS (tier 2, reported not budgeted): 333 -> 63. BETTER on all nine
//   (Comma 75->1, Kidney 101->32, SquareIsland 0->1 is the one WORSE cell: one 2 mm hop where
//   a clearance lift used to be -- the trade this ladder exists to make, still named; Tee 1->1
//   level; Bar 1->0; BootL 8->1; Triangle 2->1; Barbell 142->25; Boomerang 2->1).
// CUTS (T2): BETTER on seven (Comma 277->174, Kidney 354->246, SquareIsland 267->245,
//   Tee 152->139, Bar 93->89, Triangle 154->146, Barbell 304->200, Boomerang 203->197),
//   WORSE on one: BootL 236->249 (+13; the corner nibbles and the walker reaching two pockets
//   it used to re-seed -- entries 3 -> 1 on BootL). K-multiple corpus-wide 2.08-5.63 ->
//   2.34-3.70; Kidney and Barbell are still over K=3, Kidney 3.11 and Barbell 3.70.
// ENTRIES: BootL 3 -> 1; every other fixture 1 -> 1.
// UNATTRIBUTED lifts and T3 violations: still ZERO on all nine. Hard invariants held.
//
// Pre-WO-1178 pins, for the record:
//   clearance { 0:2, 1:10, 2:7, 3:5, 4:1, 5:5, 6:3, 7:2, 8:2 }
//   micro     { 0:75, 1:101, 2:0, 3:1, 4:1, 5:8, 6:2, 7:142, 8:2 }
//   cuts      { 0:277, 1:354, 2:267, 3:152, 4:93, 5:236, 6:154, 7:304, 8:203 }
// ---- WO-1178 ATTEMPT 3 (2026-09-02, Operator's picture gate) re-pin, directions named ----
//
// Two root causes fixed: a ring reaching a wall was clipped there and rode off along the
// tangent (a kink of the whole arrival angle), and a planted wall start was handed the
// stepper's full pi/4 clamp for its first step (13-45 degrees in one vertex); and two cusp
// rides overlapping on one wall were joined by a backward hop the ladder had to lift over.
// Rings now arrive on a tangent fillet, leave on a curvature-limited lead, and overlapping
// cusp rides collapse into one forward ride. Every plan moves; this bank (0.2D, conventional,
// wall finish off) measured:
// CLEARANCE LIFTS (tier 3, the T1 budget): 2 -> 6 corpus-wide. WORSE on two, named:
//   SquareIsland 1 -> 4 (four 45-50 mm hops from the bottom wall to the left wall; the old
//   plan's two lifts were bought with seven ~250 mm alternate-arc rides the long way round
//   the outer square, see b8-routearound.test.ts), BootL 0 -> 2 (two 24-34 mm plow+gouge
//   hops, gated landings). Level on the other seven. Every fixture inside its T1 budget.
//   At the GOOD corpus project's settings (0.4D, climb, wall finish on -- the bank the picture
//   gate is written in) tier-3 lifts are 3 -> 2 and no shape is worse (census.md).
// MICRO LIFTS (tier 2, reported not budgeted): 63 -> 59. Kidney 32 -> 35 WORSE (three more
//   0.2-0.5 mm hops on its concave wall), SquareIsland 1 -> 0, Tee 1 -> 0, Barbell 25 -> 21,
//   Boomerang 1 -> 0 BETTER; the rest level.
// CUTS (T2): BETTER on seven (Comma 174->168, SquareIsland 245->238, Tee 139->137,
//   Bar 89->87, BootL 249->245, Triangle 146->144, Barbell 200->191, Boomerang 197->192),
//   WORSE on one: Kidney 246 -> 247 (+1). Kidney and Barbell stay over K=3 (3.13, 3.54).
// ENTRIES, UNATTRIBUTED lifts and T3 violations: unchanged (1 each; zero; zero).
//
// Pre-attempt-3 pins, for the record:
//   clearance { 0:0, 1:1, 2:1, 3:0, 4:0, 5:0, 6:0, 7:0, 8:0 }
//   micro     { 0:1, 1:32, 2:1, 3:1, 4:0, 5:1, 6:1, 7:25, 8:1 }
//   cuts      { 0:174, 1:246, 2:245, 3:139, 4:89, 5:249, 6:146, 7:200, 8:197 }
const PINNED_CLEARANCE_LIFTS: Record<number, number> = {
  0: 0, 1: 1, 2: 4, 3: 0, 4: 0, 5: 2, 6: 0, 7: 0, 8: 0,
}
const PINNED_MICRO_LIFTS: Record<number, number> = {
  0: 1, 1: 35, 2: 0, 3: 0, 4: 0, 5: 1, 6: 1, 7: 21, 8: 0,
}
const PINNED_CUTS: Record<number, number> = {
  0: 168, 1: 247, 2: 238, 3: 137, 4: 87, 5: 245, 6: 144, 7: 191, 8: 192,
}
// Every fixture must have zero unattributed lifts. This is NOT pinned -- it is the hard
// invariant T1's "an unattributed lift is a red" requires. If this table ever needs a
// nonzero entry, that is itself the finding: report it, do not silence it.
const PINNED_UNATTRIBUTED: Record<number, number> = {
  0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0,
}

describe('GOOD-SPEC tripwires T1/T2/T3 (section 6)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  // TRIAGE 10-09: every fixture runs synchronously and the runner only awaits
  // microtasks between tests, so the worker never reads Vitest's RPC replies
  // until the file ends (~70 s here); the 60 s birpc timer then fires first and
  // the run exits 1 on "Timeout calling onTaskUpdate" with every test green.
  // One macrotask turn after each fixture lets the reply land.
  afterEach(() => new Promise<void>((resolve) => setImmediate(resolve)))

  const rows: GoodspecMeasurement[] = []

  for (const meta of FIXTURE_META) {
    it(`gt_fix${meta.fix} ${meta.name}: T1 attribution + budget, T2 pass-count, T3 continuity`, () => {
      const m = measureGoodspecFixture(meta.fix)
      rows.push(m)

      // ---- T1a: attribution mandatory. An unattributed lift is a red, full stop. ----
      expect(m.unattributed, `gt_fix${meta.fix} ${meta.name}: ${m.unattributed} unattributed lift(s): `
        + JSON.stringify(m.unattributedDetail)).toBe(PINNED_UNATTRIBUTED[meta.fix])

      // ---- T1b: retract budget. WO-437: PINNED to today's honest tier-3/tier-2 split; the
      // budget itself now counts ONLY clearanceLifts (tier 3). ----
      expect(m.clearanceLifts, `gt_fix${meta.fix} ${meta.name}: clearance lifts drifted from the pinned `
        + `${PINNED_CLEARANCE_LIFTS[meta.fix]} to ${m.clearanceLifts} (budget target ${m.budget} -- see table)`)
        .toBe(PINNED_CLEARANCE_LIFTS[meta.fix])
      expect(m.microLifts, `gt_fix${meta.fix} ${meta.name}: micro lifts drifted from the pinned `
        + `${PINNED_MICRO_LIFTS[meta.fix]} to ${m.microLifts}`).toBe(PINNED_MICRO_LIFTS[meta.fix])

      // ---- T2: pass-count sanity, PINNED to today's honest count (K x Fusion printed below). ----
      expect(m.cuts, `gt_fix${meta.fix} ${meta.name}: cuts drifted from the pinned ${PINNED_CUTS[meta.fix]} `
        + `to ${m.cuts} (K=${K} x Fusion ${meta.fusionPasses} = ${m.fusionTarget} target -- see table)`).toBe(PINNED_CUTS[meta.fix])

      // ---- T3: spiral continuity. Reuses the T1 attribution signal (see file header). ----
      expect(m.t3Violations, `gt_fix${meta.fix} ${meta.name}: ${m.t3Violations} forced-reposition(s) `
        + 'with no named reason').toBe(PINNED_UNATTRIBUTED[meta.fix])
    }, 120_000) // generous per-fixture timeout: the larger corpus fixtures take several seconds
  }

  it('prints the per-fixture table', () => {
    // Only meaningful once every fixture above has run; if fewer than 9 rows are present
    // some fixture test threw before pushing its row (see that test's failure for why).
    const header = 'fix name             entries lifts micro clear unattr budget(T1) withinT1 cuts fusionK(T2) withinT2 K-mult T3viol operator?'
    console.log('\n[goodspec-tripwires] ' + header)
    for (const m of rows.slice().sort((a, b) => a.meta.fix - b.meta.fix)) {
      const withinT1 = m.clearanceLifts <= m.budget ? 'yes' : 'NO'
      const withinT2 = m.cuts <= m.fusionTarget ? 'yes' : 'NO'
      console.log(
        `[goodspec-tripwires] ${String(m.meta.fix).padEnd(3)} ${m.meta.name.padEnd(16)} `
        + `${String(m.entries).padEnd(7)} ${String(m.lifts).padEnd(5)} ${String(m.microLifts).padEnd(5)} `
        + `${String(m.clearanceLifts).padEnd(5)} ${String(m.unattributed).padEnd(6)} `
        + `${String(m.budget).padEnd(11)} ${withinT1.padEnd(8)} ${String(m.cuts).padEnd(4)} `
        + `${String(m.fusionTarget).padEnd(11)} ${withinT2.padEnd(8)} ${m.kMultiple.toFixed(2).padEnd(6)} `
        + `${String(m.t3Violations).padEnd(6)} ${m.meta.sampleMachineToRule ? 'OPERATOR-TO-RULE' : ''}`,
      )
    }
    console.log(`[goodspec-tripwires] ALLOWANCE=${ALLOWANCE} K=${K}`)
    expect(rows.length).toBeGreaterThan(0)
  })
})
