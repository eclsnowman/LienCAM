// WO-1087: WHERE THE SECOND HELIX IN OPERATOR'S THREE PICTURES ACTUALLY COMES FROM.
//
// The order's premise was that BootL, Bar and Triangle each drill a SECOND HELIX as a RE-SEED
// ENTRY, and that reseed() in processFeature.ts prefers a helix over a roll-in from cleared
// stock for any feature that started with a helix. The second half is true of the code. The
// first half is not true of these three parts. Measured today, three ways -- the gt fixtures
// at the byte-stability settings, the gt fixtures at the corpus project's own settings, and
// the corpus project driven through the app's own entry point (buildAdaptiveClearingToolpath)
// -- evidence/WO-1087/{census.tsv, helix-sources.json, project-helix-rings.json}:
//
//   - Of the nine corpus operations, exactly ONE still emits a second helix ramp today: Bar,
//     at (124.05, -51.93). It is a LIFT LANDING helix (link.helixDescent), planned by the
//     lift-landing gate when a retract lands on a mostly-uncut disk. reseed() never sees it.
//   - Triangle and BootL emit exactly ONE helix ramp each -- their first entry. The second
//     ring Operator's pictures 1 and 3 arrow at is already gone from today's engine.
//   - No corpus operation re-seeds at all at those settings, so the rule the order asked for
//     cannot be what any of the three pictures shows.
//   - BootL at the byte-stability settings is the only fixture in the corpus that
//     interior-re-seeds, and its two re-seeds are not corner remainders either: each holds
//     the FULL configured descent helix, i.e. open pockets that earn their own helix.
//
// These cases pin all four facts so the premise cannot be quietly re-assumed. What is left of
// Operator's complaint lives in the LIFT-LANDING gate, not in reseed().

import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type AdaptivePass, type ProcessParams, type FeatureResult } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { loadGtFixture, CANONICAL_PARAMS } from './_goodspec-helpers'

const TOOL_RADIUS = 2.0

/** The settings the nine `Adaptive Clearing - *` operations in
 *  `Example Projects/Adaptive Clearing Shapes.camproject` carry: 4 mm flat end mill, stepover
 *  1.6 mm (0.4 of diameter), 0.5 mm radial stock, helix 95% of diameter (= 3.8 mm), wall
 *  finish on, and CLIMB -- the ops persist climb:false, which resolveAdaptiveMillingDirection
 *  inverts to 'climb' and a right-hand cutter leaves there (WO-454's finding: every corpus
 *  render before it silently ran conventional). This is the run the three pictures came from. */
const CORPUS_PARAMS: ProcessParams = {
  toolRadius: TOOL_RADIUS, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
  integralWallFollow: true, integralWallFollowLengthFactor: 2, wallCleanupAsWeGo: true,
  loopbackFilletPct: 25, wallFinish: true, millingDirection: 'climb',
}

function run(fix: number, which: 'bytestab' | 'corpus'): FeatureResult {
  const { boundary, holes, helixDiameter } = loadGtFixture(fix)
  const params: ProcessParams = which === 'corpus'
    ? CORPUS_PARAMS
    : { ...CANONICAL_PARAMS, helixDiameter }
  const warn = console.warn
  console.warn = () => {}
  try { return processFeature({ boundary, holes }, params) } finally { console.warn = warn }
}

function helixLandings(res: FeatureResult): Extract<AdaptivePass, { type: 'link' }>[] {
  return res.passes.filter(p => p.type === 'link' && p.jumpType === 2 && !!p.helixDescent) as Extract<AdaptivePass, { type: 'link' }>[]
}

describe('WO-1087: the second helix in a pocket is a lift landing, not a re-seed', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('Bar: one entry, and the second ring was a LIFT landing -- which WO-1091 has since removed', () => {
    // Operator's picture 2. The arrow points at a ring on Bar's left strip. THIS ORDER'S FINDING
    // -- that the ring is a LIFT LANDING helix (link.helixDescent) planned by the lift-landing
    // gate, and that reseed() never sees it -- is what this case still pins, and it is what
    // WO-1091 acted on: the gate now lands that retract in the cleared air beside the seam and
    // leads in, so there is no helix descent to find any more. RE-PINNED, not weakened: the
    // half of the finding that was about reseed() (one entry, mode helix, no re-seed at these
    // settings) is unchanged, and the disappearance of the drill is asserted positively.
    // wo1091-side-landing.test.ts holds the replacement behaviour, including the measured
    // proof that the new descent stands in air.
    const res = run(4, 'corpus')
    const landings = helixLandings(res)
    console.log('Bar corpus:', res.entries.map(e => `${e.mode}@(${e.point.x.toFixed(2)},${e.point.y.toFixed(2)})`).join(' '),
      '| lift helix descents', landings.map(l => `(${l.helixDescent!.center.x.toFixed(2)},${l.helixDescent!.center.y.toFixed(2)})r${l.helixDescent!.radius.toFixed(2)}`).join(' '))
    expect(res.entries, 'Bar does not re-seed at the corpus settings').toHaveLength(1)
    expect(res.entries[0].mode).toBe('helix')
    expect(landings, "the second ring in Operator's Bar picture is gone (WO-1091)").toHaveLength(0)
  }, 120_000)

  it('Triangle and BootL emit no second helix at all today -- one entry, no lift helix landing', () => {
    // Operator's pictures 1 and 3 show a second ring on these two; today's engine does not
    // produce one. If a follow-on order needs to reproduce those pictures it has to start
    // from the state his screenshots were taken in, not from this corpus as it stands.
    for (const fix of [5, 6]) {
      const res = run(fix, 'corpus')
      expect(res.entries, `fix${fix}: no re-seed at the corpus settings`).toHaveLength(1)
      expect(res.entries[0].mode).toBe('helix')
      expect(helixLandings(res), `fix${fix}: no lift lands on a mostly-uncut disk`).toHaveLength(0)
    }
  }, 240_000)

  it('Bar and Triangle do not re-seed at the byte-stability settings either', () => {
    for (const fix of [4, 6]) {
      const res = run(fix, 'bytestab')
      expect(res.entries, `fix${fix} byte-stability entries`).toHaveLength(1)
      expect(res.entries[0].mode).toBe('helix')
    }
  }, 240_000)

  it('BootL: its two re-seeds are open pockets that hold the FULL configured helix, not corner remainders', () => {
    // This is why making reseed() prefer a roll-in from cleared stock for every feature (the
    // change the order asked for, kept in this branch's history at 86f40e74) DEGRADED BootL
    // instead of cleaning it up: these are not tool-width corner scraps reachable from cleared
    // air, they are pockets with room for the same descent helix the first entry used.
    const { helixDiameter } = loadGtFixture(5)
    const configuredHelixRadius = helixDiameter / 2
    const res = run(5, 'bytestab')
    console.log('BootL bytestab entries:', res.entries.map(e => `${e.mode}@(${e.point.x.toFixed(2)},${e.point.y.toFixed(2)})r${e.radius.toFixed(2)}`).join(' '))
    // WO-1178 re-pin, 3 -> 1: BootL no longer re-seeds at all. The two pockets that used to
    // need their own helix are reached by the engage walker now that a pass rides the wall it
    // touches instead of dying there, and the walker plants its starts ahead of the stock
    // (entries 3 -> 1 at both the tripwire and the byte-stability settings, corpus census in
    // src/tests/evidence/WO-1178/). What this case still guards: every entry BootL makes holds
    // the full configured helix.
    expect(res.entries).toHaveLength(1)
    for (const e of res.entries) {
      expect(e.mode).toBe('helix')
      expect(e.radius, `BootL entry at (${e.point.x.toFixed(2)}, ${e.point.y.toFixed(2)}) holds the configured helix`)
        .toBeGreaterThanOrEqual(configuredHelixRadius - 1e-6)
    }
  }, 120_000)
})
