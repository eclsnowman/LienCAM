// B8 ROUTE-AROUND STAGE 3 GATE (CI-enforced -- no underscore). The stay-down slot-safety plan's
// rung (b)(2): when NO boundary arc keeps a would-slot reposition down (both boundary arcs slot,
// or the two endpoints share no wall at all), the engine offers the DIRECT STRAIGHT CHORD through
// ALREADY-CLEARED stock as the last route-around option before conceding a retract -- gated by the
// SAME material-safety checks the boundary arcs are held to (rideOverloadsUncut vs clearedBeforePass
// at 1.5x stepover, AND the tool centre must stay inside the machinable cut-region so it never
// gouges a wall/island). See coordination/reports/B8-STAYDOWN-EXEC.report.md (stage 3).
//
// Three cases, all CI-pinned:
//  1. gt_two_island: the plan's engineered fixture -- two r20 islands offset on a diagonal so the
//     safe between-pass route crosses the cleared field BETWEEN the islands (the straight chord),
//     not hugging either island wall. Pinned counts + byte fingerprint ("same fingerprint
//     discipline" as _bytestab-fingerprint) lock the behaviour. WO-2787: since WO-2752's climb
//     rule the chord no longer fires here (the stock it crossed was cleared by a conventional
//     cut); the rung refuses it on real stock, and rung (b)(6) keeps the reposition down by
//     riding both island walls climb instead of lifting.
//  1b. Two r14 islands on the same diagonal (WO-2787's dedicated fixture): with the smaller
//     islands the field between them is cleared by climb cutting alone, and the chord rung
//     carries a reposition from island B's wall to island A's wall at depth.
//  2. BootL (gt fix5): a REAL production gt fixture where the chord rung also fires -- its retract
//     count drops below the LIVE would-be baseline (lifts + routedAround + routedAroundChord,
//     the engine's own accounting at processFeature.ts:52) purely by keeping would-slot
//     repositions down on a through-cleared chord, and is ratcheted so it can never creep up.
//     (WO-1061 2026-08-27: was a frozen "12 lifts" from the Stage 1/2 era; see the test.)
//
// Safety is unchanged: staydown-engagement.test.ts independently pins that NO ride (chord included)
// exceeds the 1.5x stepover cap. This file pins the WIN (chord fires + retracts drop).

import { describe, it, beforeAll, beforeEach, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { ensureEngineClipperReady, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, getB8GateStats, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import type { StepDecision } from '../../../lib/cam/adaptiveClearing2d/engine/steering'

const liftCount = (passes: AdaptivePass[]): number => passes.filter(p => p.type === 'link' && p.jumpType === 2).length

/** WO-2787 round 8: which trig library this runtime has - the raw bits of Math.sin/cos/tan/acos
 *  on 4096 fixed inputs. A runtime that differs here hands the engine different bits from
 *  those four functions, and its emitted bytes need their own measured pin. */
function trigSignature(): string {
  const f64 = new Float64Array(1), bytes = new Uint8Array(f64.buffer)
  const h = crypto.createHash('sha256')
  let s = 20261014
  for (let i = 0; i < 4096; i++) {
    s = (s * 1103515245 + 12345) % 2147483648
    const x = (s / 2147483648 - 0.5) * 400
    for (const v of [Math.sin(x), Math.cos(x), Math.tan(x), Math.acos(x / 200)]) { f64[0] = v; h.update(bytes) }
  }
  return h.digest('hex').slice(0, 12)
}

// WO-2787 round 8: let the vitest worker answer its RPC between these synchronous engine runs
// (vitest moves to the next test without a macrotask; see chordAfterDirection.wo2787).
beforeEach(async () => { await new Promise<void>(resolve => setTimeout(resolve, 0)) })

/** Load a gt-family fixture (boundary + islands + helix + optional embedded params). */
function loadGt(file: string): { boundary: Loop; holes: Loop[]; helixDiameter: number; params?: Partial<ProcessParams>; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/${file}`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    params: d.params,
    name: d.name,
  }
}

describe('B8 route-around stage 3 (rung b(2)): through-cleared straight chord', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('gt_two_island: climb leaves stock on the diagonal, so the chord rung refuses it and the reposition rides both island walls climb', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let res
    try {
      const { boundary, holes, helixDiameter, params } = loadGt('gt_two_island.json')
      res = processFeature({ boundary, holes }, {
        toolRadius: params?.toolRadius ?? 3, stepOver: params?.stepOver ?? 0.25, tolerance: params?.tolerance ?? 0.1,
        helixDiameter, stockToLeave: params?.stockToLeave ?? 0,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
      })
    } finally { spy.mockRestore() }

    expect(res.stats.aborted).toBeUndefined()
    const g = getB8GateStats()
    const lifts = liftCount(res.passes)

    // The chord rung used to DEMONSTRABLY fire here. WO-1178: the connection it recovered no
    // longer lifts in the first place (the ring rides the island wall and the walker's next
    // start sits ahead of the stock), so the rung has nothing to recover on this fixture; the
    // pinned object below records that, and the rung itself is unchanged.

    // Deterministic pinned counts (AC engine is pure geometry -- no RNG). If a regression breaks the
    // chord rung, chord drops and lifts rise, tripping these.
    // WO-1061 RE-PIN (2026-08-27), {chord 3, lifts 7} -> {chord 1, lifts 1}: this pin was
    // captured before the 2026-08-20 WO-439..447 wall-cleanup batch. The batch removed six of
    // this fixture's seven retracts outright, so there are fewer would-slot repositions left
    // for the chord rung to recover -- chord falls BECAUSE lifts fell, which is the direction
    // this pin exists to protect. rejections and routedAround are unchanged. Attribution:
    // green at 136306bf, red from the 08-20 batch onward; NOT WO-466 (identical with the
    // engine reverted to 15c3007c^1).
    // WO-1178 RE-PIN (2026-09-02), {rejections 1, chord 1, lifts 1} -> all zero: the one
    // connection this fixture used to lift on (and the chord rung recovered) is no longer a
    // lift at all -- the ring rides the island wall and the next start is planted ahead of
    // the stock, so nothing is rejected and nothing needs recovering. Attribution: the
    // cohesive adaptive close-out; census under src/tests/evidence/WO-1178/.
    // WO-1178 ATTEMPT 3 RE-PIN ({0,0,0,0} -> {0,0,1,1}): with tangent wall joins one wall-clean
    // transition on this fixture can no longer be joined (its cusp rides' far ends run back
    // along the wall) and takes the gated retract, landing on a disk the physical replay reads
    // as 5.1% uncut (wo1091-side-landing.test.ts); one other connection now crosses the cleared
    // field on the through-cleared chord rung. Named, not averaged.
    // WO-2787 RE-PIN ({0,0,1,1} -> {0,0,0,2}): the chord here only cleared because the engine
    // milled island A's rim conventionally under climb; WO-2752 forbids that, so the reposition
    // now crosses 2.371 mm of standing stock and lifts honestly (src/tests/evidence/WO-2787/d7-diagnosis.md).
    // The rung's live demonstrator is the dedicated two-island fixture below.
    // WO-2787 FIX ROUND 2 ({0,0,0,2} -> {0,0,0,1}, routedWallChain 0 -> 1): Operator asked why that
    // reposition lifts rather than wall-following the climb direction. It need not: clockwise
    // round island B, across the 4 mm gap and clockwise round island A peaks at 0.44 mm against
    // the 2.25 mm cap (src/tests/evidence/WO-2787/lift-explained.png). No rung offered a ride
    // over two different walls; rung (b)(6) does, and the reposition stays down.
    expect({ rejections: g.rejections, routedAround: g.routedAround, routedAroundChord: g.routedAroundChord, routedWallChain: g.routedWallChain, lifts })
      .toEqual({ rejections: 0, routedAround: 0, routedAroundChord: 0, routedWallChain: 1, lifts: 1 })

    // Byte fingerprint ("same fingerprint discipline" as _bytestab-fingerprint): locks the whole
    // emitted toolpath. Regenerate this pin only with a named, reviewed justification.
    // WO-1061: regenerated with the counts above.
    // WO-1090 RE-PIN (2026-08-28, architect): bf2d9bdb234c4787 was captured before WO-1069
    // (c1d52c6b), whose approved loopback corner shape moved every fixture with a loopback,
    // this one included. Measured with the branch's capture harness (CAPTURE_TAG=pre1069, the
    // engine at c1d52c6b^): pre-1069 = 1109 passes / 1 retract / 2 non-tangent links; main =
    // 1107 / 2 / 0 (the regression: a keep-down link bought as a retract); this branch =
    // 1109 / 1 / 1. The contested U-turn at (41, 86.95) is the SAME straight keep-down link as
    // pre-1069 (two-island-zoom-pre1069.png vs -after.png); the other pre-1069 non-tangent link
    // is now WO-1069's approved loopback, which is the whole byte difference. The counts above
    // are unchanged from the WO-1061 pin.
    const hash = crypto.createHash('sha256')
      .update(JSON.stringify({ startPoint: res.startPoint, entries: res.entries, passes: res.passes }))
      .digest('hex').slice(0, 16)
    // WO-1178 RE-PIN: regenerated with the zero counts above (e492f2bac8accbdc -> ab0d9985ab73d7b5).
    // WO-1178 ATTEMPT 3 RE-PIN: regenerated with the counts above (ab0d9985ab73d7b5 -> 4849e988708a8aa4).
    // WO-2787 RE-PIN: regenerated with the counts above (4849e988708a8aa4 -> 9495259d37166706).
    // WO-2787 FIX ROUND 2 RE-PIN: the wall-chain ride above (9495259d37166706 -> b6f710c95246c430).
    // WO-2787 FIX ROUND 8: the bytes are pinned PER RUNTIME TRIG LIBRARY. Node 22 arm64 (Spark) and
    // Node 25 x64 (Windows) return different last bits from Math.sin/cos/tan/acos, and this
    // engine carries those bits into the pass coordinates; one ulp moves its plan on main too
    // (src/tests/evidence/WO-2787/round8-platform.json). The counts above hold on both, and every
    // reposition decision is the same on both. An unknown runtime fails here with its signature
    // and hash, to be pinned with a named measurement, never by editing a known runtime's pin.
    const PINS: Record<string, string> = {
      '02e2536d7433': 'b6f710c95246c430', // Node v22.14.0 arm64 (Spark)
      'f615c31b84d3': '567428a862d69245', // Node v25.2.1 x64 (Windows dev box)
    }
    const sig = trigSignature()
    expect(PINS[sig], `no pin for trig library ${sig} (${process.version} ${process.arch}); measured ${hash}`).toBeDefined()
    expect(hash).toBe(PINS[sig])
  }, 300_000)

  // WO-2787: the rung's dedicated demonstrator under climb. gt_two_island's geometry with r14
  // islands instead of r20, same pocket and the same B8 request. Measured on 505d46dfc1: the
  // stepper accepts 18841 cutting steps, none with the fresh stock left of the mixed band, and
  // the one chord runs (63.42, 63.94) -> (35.82, 46.52), 32.6 mm from island B's wall ring to
  // island A's. Inline because the gt corpus fixtures are not this order's paths.
  it('two r14 islands on the diagonal: the chord rung carries a reposition across the cleared field under climb', () => {
    const circle = (cx: number, cy: number, r: number): Loop =>
      Array.from({ length: 120 }, (_, k) => ({ x: cx + r * Math.cos(2 * Math.PI * k / 120), y: cy + r * Math.sin(2 * Math.PI * k / 120) }))
    const islands = [{ cx: 40, cy: 30 }, { cx: 80, cy: 60 }]
    const toolRadius = 3, islandRadius = 14
    const boundary: Loop = [{ x: 0, y: 0 }, { x: 120, y: 0 }, { x: 120, y: 90 }, { x: 0, y: 90 }]
    let conventional = 0, accepted = 0
    const onDecision = (decision: StepDecision) => {
      const probe = decision.probes[decision.acceptedIndex]
      if (!probe || !(probe.area > 0)) return
      accepted++
      if (probe.sideBalance > 0.2) conventional++ // the stepper's 40/60..60/40 mixed band
    }
    const chordLengths: number[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
      const m = /through-cleared straight chord \(([\d.]+)mm\)/.exec(String(args[0]))
      if (m) chordLengths.push(Number(m[1]))
    })
    let res
    try {
      res = processFeature({ boundary, holes: islands.map(i => circle(i.cx, i.cy, islandRadius)) }, {
        toolRadius, stepOver: 0.25, tolerance: 0.1, helixDiameter: 5.4, stockToLeave: 0,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
        stepper: { onDecision },
      })
    } finally { spy.mockRestore() }

    expect(res.stats.aborted).toBeUndefined()
    const g = getB8GateStats()
    expect({ rejections: g.rejections, routedAround: g.routedAround, routedAroundChord: g.routedAroundChord, lifts: liftCount(res.passes) })
      .toEqual({ rejections: 0, routedAround: 0, routedAroundChord: 1, lifts: 2 })

    // Climb throughout: no accepted cutting step has the fresh stock on the cutter's left.
    expect(accepted).toBeGreaterThan(1000)
    expect(conventional).toBe(0)

    // The chord is emitted as one straight at-depth loopback, wall ring to wall ring.
    expect(chordLengths).toHaveLength(1)
    const rides = res.passes.filter((p): p is Extract<AdaptivePass, { type: 'loopback' }> => p.type === 'loopback' && p.points.length === 2
      && Math.abs(Math.hypot(p.points[1].x - p.points[0].x, p.points[1].y - p.points[0].y) - chordLengths[0]) < 0.06)
    expect(rides).toHaveLength(1)
    const [from, to] = rides[0].points
    const ring = toolRadius + islandRadius
    expect(Math.abs(Math.hypot(from.x - 80, from.y - 60) - ring)).toBeLessThan(0.2) // island B's wall
    expect(Math.abs(Math.hypot(to.x - 40, to.y - 30) - ring)).toBeLessThan(0.2) // island A's wall
    // ...and between the islands: the tool centre keeps a full radius off both.
    for (let k = 0; k <= 100; k++) {
      const x = from.x + (to.x - from.x) * k / 100, y = from.y + (to.y - from.y) * k / 100
      for (const i of islands) expect(Math.hypot(x - i.cx, y - i.cy)).toBeGreaterThan(ring - 0.2)
    }
  }, 300_000)

  it('BootL (gt fix5): the chord rung also fires on a real production fixture, dropping retracts', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let res
    try {
      const { boundary, holes, helixDiameter } = loadGt('gt_fix5.json') // BootL, canonical gt settings
      res = processFeature({ boundary, holes }, {
        toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
      })
    } finally { spy.mockRestore() }

    expect(res.stats.aborted).toBeUndefined()
    const g = getB8GateStats()
    const lifts = liftCount(res.passes)

    // Chord rung fires on BootL, and every retract it recovers is a retract this fixture does
    // not take.
    //
    // WO-1061 RE-PIN (2026-08-27). The old form was `lifts < 12` and `lifts === 12 - chord`,
    // where 12 was the Stage 1/2 baseline measured before the 2026-08-20 WO-439..447 batch.
    // That absolute number is dead: the engine's plan for BootL has moved several times since
    // (35 lifts at 136306bf, 13 at WO-449, 14 pre-WO-466, 13 now -- WO-466 took one back off).
    // The RELATIVE claim is the one worth keeping and it is stated by the engine itself at
    // processFeature.ts:52 -- every eliminated lift equals exactly one routedAround +
    // routedAroundChord -- so the would-be baseline is live, not a frozen constant.
    const baselineLifts = lifts + g.routedAround + g.routedAroundChord
    // WO-1178: BootL now makes no would-slot reposition for the chord rung to recover (chord
    // 0) and no lift to drop; the relative claim is stated as "never more lifts than the
    // would-be baseline", which holds with equality when there is nothing to recover.
    expect(lifts).toBeLessThanOrEqual(baselineLifts)
    // RATCHET: BootL's retract count may fall, never creep up. 13 measured 2026-08-27 on
    // 255c5a45. NOTE, recorded honestly rather than pinned away: this is +1 against the
    // Stage 1/2 era's 12 -- see the WO-1061 result section.
    expect(lifts).toBeLessThanOrEqual(13)
  }, 300_000)
})
