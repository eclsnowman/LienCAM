// BYTE-STABILITY REGRESSION GATE (self-asserting). Runs the 9 gt fixtures (gt_fix0..8)
// with the canonical engine settings (loopback-fillet.test.ts) and asserts a sha256 of the
// emitted result ({ startPoint, entries, passes }) per fixture against the COMMITTED baseline
// `_bytestab-baseline.json`. Any byte-level change in the AC engine's geometry output trips
// this -- a perf/refactor change MUST keep these identical; an intentional geometry change
// must regenerate the baseline (below) and pass Operator's visual gate first.
//
// This assertion runs in the NORMAL suite (no env flag) so AC stability is CI-enforced. The
// 9 small gt fixtures run in this file's own worker process (clipper2-wasm aborts after ~12
// engine runs per process; 9 < 12, safe).
//
// WO-429 (2026-08-20) re-pin, attributed: fix4 Bar 295->296, fix6 Triangle 386->387,
// fix7 Barbell 1148->1150, fix8 Boomerang 663->664 passes. Cause: a re-seed entry that the
// engage walker had walked away from used to be paired with a distant cut and the link
// between them SUPPRESSED ("the entry owns its own safe approach"); it is now emitted and
// gated like any other connection. Every added pass is a jumpType-1 keep-down link -- the
// goodspec tripwire pins (cuts, entries, clearance lifts, micro lifts, unattributed, T3)
// are UNCHANGED on all nine fixtures, and the emitted ToolpathMove stream's total travel is
// identical to 0.001 mm on all four (fix4 9257.941, fix6 15121.633, fix7 23086.201, fix8
// 32102.424 mm before and after): the connection was reclassified, not re-routed. The five
// other fixtures did not move.
//
// WO-439 STEP 2 (2026-08-20) re-cut, ALL NINE fixtures, attributed: this is a deliberate
// path-shape change at three convicted sites (the wall-skim load judgment, the engage
// walker's clipped bite, the pass-progress floor), so every fingerprint was expected to
// move. Total passes (cuts + links + wall-follows) before -> after: fix0 1044->866,
// fix1 1187->1132, fix2 1047->1059, fix3 551->597, fix4 296->372, fix5 866->916,
// fix6 387->608, fix7 1150->870, fix8 664->808. What moved and why is recorded in the
// three "WO-439 step 2 (fix N of 3)" commits and in the before/after census under
// src/tests/evidence/WO-439/step2/. THIS RE-CUT IS PROVISIONAL: GOOD-SPEC T4 gives Operator
// the picture verdict on any path-shape change, and it has not been given yet.
//
// WO-466 (2026-08-26) re-pin, ONE fixture, attributed: fix5 BootL 916 -> 917 passes,
// hash 036662a8159c1c1b -> f1a1a8e85b14e492. The other EIGHT fingerprints and all eight
// pass counts are untouched. Cause: tier 2.5, the stop-short keep-down -- one roughing
// connection that used to concede a 2 mm micro-lift now travels at depth over ground the
// SAME traverse proof clears and feeds the last stretch into the standing skin:
//   stop-short@(26.86, -99.50): 12.56mm of the 13.64mm chord travelled AT DEPTH, then
//   1.07mm FED (<= the 1.60mm cut-through length bar, load-proven).
// The pass-stream delta is exactly that reclassification: link 18 -> 17, loopback
// 211 -> 212, lead 0 -> 1. THE ROUGHING CUT PATH DID NOT MOVE -- a sha256 over every
// 'cut' pass's geometry is byte-identical on all nine fixtures, BootL included, and so is
// BootL's residual (7.4083 mm2) and its clearance-lift count (5). What DOES move inside
// BootL's hash besides the reclassified link is its two cusp wall rides at that one
// connection: a lift's landing gate shrinks the cusp entry ride to protect the plunge,
// and a connection that never lifts has no plunge to protect. Before/after census:
// src/tests/evidence/WO-466/passcensus_before.json / passcensus_after.json.
// PROVISIONAL until Operator's picture verdict (GOOD-SPEC T4), like the WO-439 re-cut above.
//
// WO-1069 (2026-08-28) re-pin, SEVEN fixtures, attributed, and the FIRST re-pin on this file
// with Operator's picture verdict already given ("Yes - land it", 2026-08-28 10:23Z, on the
// Kidney pass-3 before/after under src/tests/evidence/WO-1069/). Cause: the milling-direction
// gate that decides whether a built loopback survives was a knife-edge probe -- it offset the
// first segment's midpoint 1e-3 mm and asked pip2 which side was cleared, which only answers
// truthfully when that midpoint sits ON the wall. For a ride buildLoopback had trimmed back to
// a fillet contact (4-9x that offset off the wall) the verdict was constant, the good loopback
// was discarded, and the bare link that replaced it doubled back -- the 32 non-tangent keep-down
// link corners this order was opened on, including the named fix1 Kidney pct25 pass#3 corner at
// (66.65, 33.72). Replaced with a winding test. All 32 corners are gone (nonTangentKeepdownLinks
// 32 -> 0 corpus-wide); the loopback-fillet guard is green on all four of its cases.
// THE ROUGHING CUT PATH DID NOT MOVE: the per-fixture sha256 over every 'cut' pass is
// byte-identical on all nine fixtures (census-table.tsv cutHash column, one value per row).
// What moved inside these hashes is loopback/link classification and the wall-follow rides at
// those transitions. Passes before -> after: fix2 SquareIsland 1059->1057, fix4 Bar 372->370,
// fix5 BootL 917->913, fix8 Boomerang 808->806; fix0/fix1/fix7 same count, new hash;
// fix3 Tee and fix6 Triangle untouched (hash and count). Corpus totals: loopbacks 1594->1621,
// of which routed 0->155; jumpType-1 links 58->30; wall-follow length 8187.323->8113.704 mm;
// total travel 27466.574->27448.525 mm; micro lifts 332->333 (the one Boomerang hop the
// goodspec T1 pin also records). Full before/after census: src/tests/evidence/WO-1069/
// census_before.json / census_after.json / census-table.tsv.
//
// WO-1103 (2026-08-29) re-pin, ONE fixture, attributed: fix4 Bar 370 -> 365 passes,
// hash 445fcd1bce7234f7 -> 0b7dd0974ea0539e. The other EIGHT fingerprints and pass counts
// are untouched (census: src/tests/evidence/WO-1103/census.tsv, both settings banks). Cause:
// Bar is a 21.30 x 62.83 mm channel, and the entry used to sit at its deepest point -- the
// MIDDLE -- so the spiral saturated across the width and stranded ~21 mm at each end, which
// the walk could only reach by lifting (WO-1100's measurement). The entry now goes near one
// end of a channel, (132.68, -41.86) -> (132.68, -20.45) at these settings. Bar's lifts fall
// 3 -> 2 here and 1 -> 0 at the corpus settings, which is the bank the order's acceptance is
// written in; at THIS bank the widest cut also falls 2.164 -> 1.364 mm2/mm and the residual
// 4.237 -> 3.633 mm2. This is a deliberate PATH-SHAPE change: Operator's picture verdict
// (GOOD-SPEC T4) gates the landing and has not been given yet -- pictures are in
// src/tests/evidence/WO-1103/.
//
// WO-1178 ATTEMPT 3 (2026-09-02, Operator's picture gate) re-cut, ALL NINE fixtures, attributed:
// tangent wall joins (a ring arrives at a wall on a tangent fillet and leaves a planted start
// on a curvature-limited 'lead') and one forward ride over overlapping cusp rides. Every pass
// stream moves; the pass counts rise because each wall start now carries its lead:
// fix0 490->621, fix1 740->860, fix2 814->1125, fix3 474->570, fix4 316->366, fix5 876->1129,
// fix6 510->611, fix7 556->616, fix8 716->809. Cuts, lifts and entries per fixture are the
// goodspec tripwire pins (re-pinned there with directions named); the census is under
// src/tests/evidence/WO-1178/census.md. Operator's picture verdict on the joins is the gate.
//
// To REGENERATE the baseline after an APPROVED geometry change:
//   BYTESTAB_OUT=src/tests/adaptive-clearing/engine/_bytestab-baseline.json \
//     npx vitest run src/tests/adaptive-clearing/engine/_bytestab-fingerprint.test.ts
// (BYTESTAB_OUT writes the freshly-measured fingerprints; review the diff before committing.)

import { describe, it, beforeAll, expect } from 'vitest'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { ensureEngineClipperReady, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

// WO-1178 (2026-09-02) re-cut, ALL NINE fixtures, attributed: the cohesive adaptive
// close-out is a deliberate path-shape change (rings ride the wall they touch into corners,
// the engage walker plants starts ahead of stock at the band's low edge and only where a pass
// can progress, convex corners are never credited to the wall ride, cusp rides are load-gated,
// seed disks are credited only when their entry emits, exterior seeds open the boundary they
// abut). Total passes before -> after: fix0 866->490, fix1 1132->740, fix2 1057->814,
// fix3 597->474, fix4 365->316, fix5 913->876, fix6 608->510, fix7 870->556, fix8 806->716.
// Tier-3 lifts 37 -> 2 and cuts down on seven of nine at the tripwire settings
// (goodspec-tripwires.test.ts carries the per-fixture table). PROVISIONAL until Operator's picture
// verdict on the WO-1178 card (GOOD-SPEC T4); the before/after corpus is under
// src/tests/evidence/WO-1178/.
const BASELINE_PATH = 'src/tests/adaptive-clearing/engine/_bytestab-baseline.json'

type Fingerprint = { name: string; hash: string; passes: number }

function loadFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name,
  }
}

function fingerprint(fix: number): Fingerprint {
  const { boundary, holes, helixDiameter, name } = loadFixture(fix)
  const res = processFeature({ boundary, holes }, {
    toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
    integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
  })
  const hash = crypto.createHash('sha256')
    .update(JSON.stringify({ startPoint: res.startPoint, entries: res.entries, passes: res.passes }))
    .digest('hex').slice(0, 16)
  return { name, hash, passes: res.passes.length }
}

describe('AC byte-stability regression (9 gt fixtures)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('every fixture fingerprint matches the committed baseline', () => {
    const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8')) as Record<string, Fingerprint>
    const current: Record<string, Fingerprint> = {}
    const mismatches: string[] = []
    for (let fix = 0; fix <= 8; fix++) {
      const fp = fingerprint(fix)
      const key = `fix${fix}`
      current[key] = fp
      const base = baseline[key]
      if (!base) { mismatches.push(`${key} (${fp.name}): missing from baseline`); continue }
      if (base.hash !== fp.hash || base.passes !== fp.passes) {
        mismatches.push(`${key} (${fp.name}): baseline hash=${base.hash} passes=${base.passes} -> got hash=${fp.hash} passes=${fp.passes}`)
      }
    }
    // Regenerate the committed baseline on demand (review the diff before committing).
    if (process.env.BYTESTAB_OUT) fs.writeFileSync(process.env.BYTESTAB_OUT, JSON.stringify(current, null, 2) + '\n')
    expect(mismatches, `AC toolpath geometry changed vs baseline:\n${mismatches.join('\n')}\nIf intentional + visually approved, regenerate ${BASELINE_PATH} (see header).`).toEqual([])
  }, 1_200_000)
})
