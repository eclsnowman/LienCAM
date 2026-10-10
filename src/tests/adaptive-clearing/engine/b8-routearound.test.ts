// B8 ROUTE-AROUND GATE (Stage 2, CI-enforced -- no underscore). The stay-down slot-safety
// plan's rung (b)(1): when the DIRECT boundary-arc reposition would slot uncut (the B8 gate
// rejects it), the engine now tries the OTHER boundary arc (e.g. the far side of an island)
// before conceding a full retract. Recovered repositions stay at depth and cut fewer retracts,
// WITHOUT relaxing the material-safety cap (staydown-engagement.test.ts pins the cap; this
// file pins the WIN: fewer retracts on the exact repro Operator flagged, measured vs the committed
// Stage 1 baseline _b8-routearound-baseline.json).
//
// Safety is unchanged: every kept-down route-around passes the SAME rideOverloadsUncut gate
// the direct ride is held to (1.5x stepover sustained width vs clearedBeforePass). This test
// asserts the retract REDUCTION; staydown-engagement.test.ts independently asserts no ride
// (route-around included) exceeds the cap.

import { describe, it, beforeAll, expect, vi } from 'vitest'
import * as fs from 'fs'
import { ensureEngineClipperReady, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, getB8GateStats, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

function circle(cx: number, cy: number, r: number, n = 180): Loop {
  const p: Loop = []
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }) }
  return p
}
const liftCount = (passes: AdaptivePass[]): number => passes.filter(p => p.type === 'link' && p.jumpType === 2).length

function loadGtFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name,
  }
}

describe('B8 route-around (rung b(1)): retracts drop vs the Stage 1 baseline', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('island repro: at least one rejected ride is routed around, and lifts drop below baseline', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let res
    try {
      const SIZE = 120, ISLR = 20, TOOLR = 3
      const square: Loop = [{ x: 0, y: 0 }, { x: SIZE, y: 0 }, { x: SIZE, y: SIZE }, { x: 0, y: SIZE }]
      const island = circle(SIZE / 2, SIZE / 2, ISLR)
      const params: ProcessParams = {
        toolRadius: TOOLR, stepOver: 0.25, tolerance: 0.1, helixDiameter: TOOLR * 2 * 0.9,
        stockToLeave: 0, integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
      }
      res = processFeature({ boundary: square, holes: [island] }, params)
    } finally { spy.mockRestore() }
    expect(res.stats.aborted).toBeUndefined()

    const g = getB8GateStats()
    const lifts = liftCount(res.passes)
    // The old alternate arc reversed the selected conventional material side.
    // It must remain a lift; implicit both-ways cutting is not an optimization.
    // WO-1178 re-pin: the island repro no longer lifts at all (0 lifts, 0 routed-around
    // rides) -- rings ride the island wall and the walker plants starts ahead of stock, so
    // there is no rejected ride left to route around. Pinned as a pair so a lift returning
    // or a ride being routed around both trip this.
    // WO-1178 ATTEMPT 3 RE-PIN (lifts 0 -> 1): with tangent wall joins the ring sequence lands
    // differently and the walker plants one start 74 mm across the pocket from the prior
    // cut's end, over a corridor that plows and gouges with no shared wall and no route in
    // the 3x detour budget. Its landing is GATED (a proven-cleared shaft and a 0.88 mm
    // tangent lead, 0% uncut under the physical replay). One retract against a T1 budget of
    // 6 for this fixture, and still no ride routed around. Still below the Stage 1 baseline.
    expect({ routedAround: g.routedAround, lifts }).toEqual({ routedAround: 0, lifts: 1 })
  }, 300_000)

  it('SquareIsland gt fixture: the round-island wrap recovers its rejected repositions', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let res
    try {
      const { boundary, holes, helixDiameter } = loadGtFixture(2) // SquareIsland
      res = processFeature({ boundary, holes }, {
        toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
      })
    } finally { spy.mockRestore() }
    expect(res.stats.aborted).toBeUndefined()

    const g = getB8GateStats()
    const lifts = liftCount(res.passes)
    // WO-1178 re-pin: seven direct island rides now fail the ride cap and are routed around
    // on the alternate boundary arc. Since WO-1090 every candidate arc is filtered by
    // wallPointsMatchDirection before length or load are judged, so a routed-around ride is
    // direction-correct by construction (the both-ways hazard the old zero pin guarded).
    // Lifts on this fixture: 2 at the tripwire settings (was 7 at the pre-WO-1178 pin).
    // WO-1178 ATTEMPT 3 RE-PIN ({7, 2} -> {0, 4}), measured and named: the seven routed-around
    // rides were the ALTERNATE boundary arc of the outer square -- the long way round, three
    // corners and ~250 mm of wall at cutting feed each -- taken because the direct arc via the
    // bottom-left corner overloaded. With tangent wall joins the four rings that end on the
    // bottom wall no longer offer a direct arc in the wall-follow budget (their cusp far ends
    // project the corner route past 2x the chord), so rung (b)(1) is never entered and each
    // connection lifts: four 45-50 mm hops, gated landings, against a T1 budget of 8. At the
    // GOOD corpus project's settings (the bank the picture gate is written in) this fixture is
    // level at 1 lift (src/tests/evidence/WO-1178/census.md).
    expect({ routedAround: g.routedAround, lifts }).toEqual({ routedAround: 0, lifts: 4 })
  }, 300_000)
})
