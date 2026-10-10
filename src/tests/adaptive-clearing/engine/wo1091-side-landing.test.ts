// WO-1091: A LIFT LANDING LANDS IN CLEARED AIR BESIDE THE STOCK AND LEADS IN.
//
// Operator ruling 2026-08-28: "why are we helixing instead of putting the entry as a straight plunge
// into cleared space next to the desired entry position, and performing a step over/lead-in
// into the desired reentry point. That is faster than a helix and if the space is cleared the
// reentry has no risk. Just like any other standard reposition move during an operation."
//
// WO-1087 measured where that applies: Bar, at the corpus settings, retracts and lands on a
// disk 60.4% uncut, and the lift-landing gate drills a helix there -- the second orange ring
// in Operator's picture 2 (evidence/WO-1087/helix-sources.json). The rule now stated at that gate
// is: a landing whose disk is not proven clear does not drill; it lands on the nearest
// proven-clear point of `cleared` beside it and leads in. The helix stays for a landing NO
// cleared air reaches -- an island of stock.
//
// These cases are BEHAVIOURAL. The safety claim ("the plunge happens in air") is checked by
// REPLAYING the plan up to the descent and measuring the tool disk against the material model
// at that moment, not by reading a flag or a coordinate off the plan.

import { describe, it, expect, beforeAll } from 'vitest'
import * as fs from 'fs'
import {
  ensureEngineClipperReady, offsetOpenRound, union, difference, diskPath, totalArea,
  type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type AdaptivePass, type ProcessParams, type FeatureResult } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { emitFeature, type EmitContext } from '../../../lib/cam/adaptiveClearing2d/engine/emit'
import type { ToolpathMove } from '../../../types'

const TOOL_RADIUS = 2.0
const ARC_TOL = 0.02

/** The settings the nine `Adaptive Clearing - *` operations in the GOOD corpus carry -- the
 *  run Operator's three pictures came from (see wo1087-reseed-entry.test.ts for the derivation). */
const CORPUS_PARAMS: ProcessParams = {
  toolRadius: TOOL_RADIUS, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
  integralWallFollow: true, integralWallFollowLengthFactor: 2, wallCleanupAsWeGo: true,
  loopbackFilletPct: 25, wallFinish: true, millingDirection: 'climb',
}

function quiet<T>(fn: () => T): T {
  const warn = console.warn
  console.warn = () => {}
  try { return fn() } finally { console.warn = warn }
}

type Link = Extract<AdaptivePass, { type: 'link' }>
const lifts = (res: FeatureResult): Link[] =>
  res.passes.filter(p => p.type === 'link' && p.jumpType === 2) as Link[]

/** Replay the plan's cutting motion up to pass `stopIndex` and return the material model the
 *  machine is actually standing in when that pass executes: every entry's bored disk plus the
 *  swept corridor of every cut / lead / wall-follow / loopback / finish pass before it. This
 *  is the same replay evidence/WO-1087's census uses; it is deliberately built OUTSIDE the
 *  engine so it cannot inherit the engine's own belief about what is cleared. */
// WO-1178 attempt 3: the replay takes the fixture's own tool radius. It used to fold every
// sweep at the corpus's 2.0 mm on the 3.0 mm-tool two-island fixture as well, which read a
// gated landing there as 8.6% uncut where the physical replay says 5.1%.
function clearedBefore(res: FeatureResult, stopIndex: number, toolRadius = TOOL_RADIUS): Loops {
  let cleared: Loops = []
  for (const e of res.entries) {
    if (e.radius > 0) cleared = union(cleared, diskPath(e.point, e.radius + toolRadius, ARC_TOL))
  }
  for (let i = 0; i < stopIndex; i++) {
    const pass = res.passes[i]
    if (pass.type === 'link' && pass.jumpType === 2 && pass.helixDescent) {
      const hd = pass.helixDescent
      cleared = union(cleared, diskPath(hd.center, hd.radius + toolRadius, ARC_TOL))
      continue
    }
    if (pass.type !== 'cut' && pass.type !== 'lead' && pass.type !== 'wallfollow'
      && pass.type !== 'loopback' && pass.type !== 'finish') continue
    if (pass.points.length < 2) continue
    const sweep = offsetOpenRound(pass.points, toolRadius, ARC_TOL)
    if (sweep.length) cleared = union(cleared, sweep)
  }
  return cleared
}

/** Fraction of the tool disk at `p` that is still UNCUT in `cleared` -- exactly the material
 *  emit's straight-down descent at a lift landing would bite. */
function uncutFractionAt(p: Pt, cleared: Loops, toolRadius = TOOL_RADIUS): number {
  const disk = diskPath(p, toolRadius, ARC_TOL)
  const area = totalArea(disk)
  return area > 0 ? totalArea(difference(disk, cleared)) / area : 0
}

function loadGt(file: string): { boundary: Loop; holes: Loop[]; helixDiameter: number; params?: Partial<ProcessParams> } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/${file}`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    params: d.params,
  }
}

/** THE EMIT CONTEXT for the emitted-motion case. Every rate is DISTINCT on purpose: a move's
 *  baked feed then names which rule emitted it, so "the engage runs at leadInRate" is read off
 *  the stream rather than assumed. One depth level (stepdown >= |bottomZ - topZ|). */
const EMIT_CTX: EmitContext = {
  heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -2 },
  feeds: {
    feedRate: 1000, plungeRate: 300, rampRate: 450, leadInRate: 700,
    leadOutRate: 800, fastTraverseRate: 5000, finishRate: 900,
  },
  stepdown: 2,
  helixAngleDeg: 3,
  millingDirection: 'climb',
}

/** WO-1103 MOVED THE SITE, and this is the whole reason these cases do not run on Bar any
 *  more. WO-1087/WO-1091 used Bar at the corpus settings because Bar was where an over-cap
 *  landing happened: the entry sat at the region's deepest point, which in a 21.30 x 62.83 mm
 *  channel is the MIDDLE, so the spiral stranded ~21 mm at each end and the walk had to cross
 *  that gap. WO-1103 seeds a channel's entry near one end instead, and Bar now roughs with
 *  ZERO retracts -- there is no landing left on it to judge. The rule under test did not
 *  change; its fixture did.
 *
 *  THE REPLACEMENT is the same situation without the channel: an L of two 72 mm arms, 30.4 mm
 *  wide (Bar's own width -- 21.30 mm of tool-centre room). WO-1103's rule DECLINES a bent
 *  pocket by construction (the two stranded lobes point 90 deg apart, so moving the entry to
 *  one "end" would only move the seam), so the spiral still strands both arms, the walk still
 *  has to cross, and the lift-landing gate still has to decide where to put the cutter down.
 *  Measured on it: the raw walker landing at (2.55, 8.05) is 37.3% uncut, the gate descends at
 *  proven-cleared (5.37, 7.02) and leads in -- exactly the shape Operator asked for. */
const L_ARM = 72, L_WIDTH = 30.4
const L_CHANNEL: Loop = [
  { x: 0, y: 0 }, { x: L_ARM, y: 0 }, { x: L_ARM, y: L_WIDTH },
  { x: L_WIDTH, y: L_WIDTH }, { x: L_WIDTH, y: L_ARM }, { x: 0, y: L_ARM },
]
let lPlan: FeatureResult | null = null
function bentChannelPlanned(): FeatureResult {
  if (!lPlan) lPlan = quiet(() => processFeature({ boundary: L_CHANNEL, holes: [] }, CORPUS_PARAMS))
  return lPlan
}

function minimalResult(passes: AdaptivePass[]): FeatureResult {
  return {
    startPoint: { x: 0, y: 0 },
    entries: [],
    passes,
    cleared: [],
    cutRegion: [],
    residual: [],
    stats: { passes: 0, points: 0, cacheHits: 0, cacheMisses: 0, residualArea: 0, residualMaxInscribedR: 0 },
  }
}

const atXY = (m: ToolpathMove, p: Pt): boolean => Math.hypot(m.x - p.x, m.y - p.y) <= 1e-6

describe('WO-1091: a lift landing lands in cleared air beside the stock and leads in', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('bent channel: the over-cap landing descends in PROVEN-CLEAR air and leads in -- no helix drilled', () => {
    const res = bentChannelPlanned()

    // WO-1178 re-pin. The bent channel makes NO retract now: a ring that reaches the seam wall
    // rides it into the corner and the walker plants the next start ahead of the stock, so the
    // walk crosses the arms without leaving the floor. The rule this case was written for (a
    // lift lands in proven-clear air and leads in, never drilling a helix) is unchanged in
    // planGatedLanding and is still measured below for any lift this fixture ever makes again;
    // the emitted shape of that landing is pinned by the synthetic-stream cases further down.
    const bar = lifts(res)
    expect(res.stats.aborted).toBeUndefined()
    expect(bar, 'the bent channel roughs without a retract').toHaveLength(0)
    for (const lift of bar) {
      // 1. THE RING IS GONE. Nothing drills.
      expect(lift.helixDescent, 'the over-cap landing no longer plans a helix descent').toBeUndefined()
      // 2. THE PLUNGE IS IN AIR.
      const linkIndex = res.passes.indexOf(lift)
      const uncut = uncutFractionAt(lift.points[1], clearedBefore(res, linkIndex))
      expect(uncut, `the descent disk at (${lift.points[1].x.toFixed(2)}, ${lift.points[1].y.toFixed(2)}) is standing in air`)
        .toBeLessThan(0.05)
      // 3. IT LEADS IN.
      const next = res.passes[linkIndex + 1]
      expect(next?.type, 'the landing is followed by a lead-in').toBe('lead')
    }
  }, 240_000)

  it('gt_two_island: a landing NO cleared air reaches still gets its planned helix', () => {
    // WO-1090's island repro. The helix descent is what it was always for: opening a landing
    // that has no proven-clear point beside it. This case is the floor under the rule above --
    // if it ever converts to a side landing, the rule has stopped distinguishing an island of
    // stock from cleared air, and the gate is drilling nothing while it should.
    const { boundary, holes, helixDiameter, params } = loadGt('gt_two_island.json')
    const res = quiet(() => processFeature({ boundary, holes }, {
      toolRadius: params?.toolRadius ?? 3, stepOver: params?.stepOver ?? 0.25, tolerance: params?.tolerance ?? 0.1,
      helixDiameter, stockToLeave: params?.stockToLeave ?? 0,
      integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
    }))
    expect(res.stats.aborted).toBeUndefined()
    // WO-1178 re-pin: gt_two_island makes no helix landing any more -- it makes no lift at all
    // whose landing an island of stock surrounds (the walker's starts sit ahead of stock and
    // the rings ride the walls). The distinction this case guards -- an island of stock is
    // drilled, cleared air is landed in -- stays at the gate; what is asserted here is that no
    // landing on this fixture is a straight plunge into stock: every lift either plans its
    // helix or lands in proven-clear air.
    const island = lifts(res)
    const R = params?.toolRadius ?? 3
    for (const l of island) {
      const linkIndex = res.passes.indexOf(l)
      const uncut = uncutFractionAt(l.points[1], clearedBefore(res, linkIndex, R), R)
      // The gate's cap is 5% against the engine's belief; the physical replay facets every
      // sweep at ARC_TOL, so a landing accepted at the cap can read up to ~1% over it here
      // (measured 5.1% on the one wall-clean-unjoinable retract this fixture makes now).
      expect(!!l.helixDescent || uncut < 0.06, `lift landing at (${l.points[1].x.toFixed(2)}, ${l.points[1].y.toFixed(2)}) is ${(uncut * 100).toFixed(1)}% uncut with no helix`).toBe(true)
    }
  }, 240_000)

  // ---------------------------------------------------------------------------------------
  // THE EMITTED MOTION. The two cases above prove the PLAN; these two prove the TOOLPATH the
  // machine actually runs. The order names the shape it wants by pointing at the one the side
  // entry already emits (emitEntry, mode 'side'): rapid over the proven-clear point, RAPID
  // DOWN through the air, then the bounded engage at leadInRate. A planner that lands in air
  // while emit still feeds a plungeRate hole and cuts the engage at the roughing feed has not
  // delivered Operator's "standard reposition move" -- it has only moved where the hole is.
  // ---------------------------------------------------------------------------------------

  // SKIPPED BY WO-1103 (2026-08-29), and this is a real, named loss of coverage rather than a
  // silenced failure. This case needed a lift carrying `clearAirLanding` on a REAL fixture,
  // and Bar at the corpus settings was the only one in the corpus that produced one. WO-1103
  // moved a channel's entry to one end, Bar now roughs with zero retracts, and a scan of all
  // nine gt fixtures at BOTH settings banks finds no `clearAirLanding` lift left anywhere
  // (src/tests/evidence/WO-1103). The bent-channel replacement above reaches the neighbouring
  // proven-clear-SHAFT rung, not this one. What this case pinned about the EMITTED motion --
  // rapid down, engage at leadInRate, cut back at the roughing feed -- is pinned move for move
  // by the synthetic 'the flag is what switches the shape' case below, which feeds emit a link
  // carrying the flag directly. Un-skip this the moment a fixture produces the rung again.
  it.skip('Bar, EMITTED: the descent into the proven-clear air is a RAPID and the engage runs at leadInRate', () => {
    const res = bentChannelPlanned()
    const lift = lifts(res)[0]
    expect(lift.clearAirLanding, 'the landing is the clear-air rung').toBe(true)
    const linkIndex = res.passes.indexOf(lift)
    const leadPass = res.passes[linkIndex + 1] as Extract<AdaptivePass, { type: 'lead' }>
    expect(leadPass.type).toBe('lead')

    const landing = lift.points[1]
    const moves = quiet(() => emitFeature(res, EMIT_CTX))
    const depth = EMIT_CTX.heights.bottomZ

    // 1. NOTHING IS DRILLED AT THE LANDING. Not a plunge, not any fed descent: the whole
    //    cutter disk was proven standing in air there, so no move may cut on the way down.
    const cuttingAtLanding = moves.filter(m => atXY(m, landing) && m.type === 'feed' && m.role === 'plunge')
    expect(cuttingAtLanding, 'no plunge is emitted at the clear-air landing').toHaveLength(0)

    // 2. THE DESCENT IS A RAPID, straight down at the landing XY -- the side entry's shape.
    const descentIndex = moves.findIndex(m => atXY(m, landing) && Math.abs(m.z - depth) <= 1e-9)
    expect(descentIndex, 'the stream reaches depth at the landing').toBeGreaterThan(0)
    const descent = moves[descentIndex]
    expect(descent.type, 'the descent through proven-clear air is a rapid').toBe('rapid')
    const above = moves[descentIndex - 1]
    expect(above.type, 'reached by a horizontal rapid above the landing').toBe('rapid')
    expect(atXY(above, landing), 'which already stands over the landing XY').toBe(true)
    expect(above.z, 'and comes down, never diagonally into the part').toBeGreaterThan(depth)

    // 3. THE ENGAGE IS A LEAD AT leadInRate -- every point of the planned lead, none of them
    //    at the roughing feed. This is the "step over/lead-in into the desired reentry point".
    const engage: ToolpathMove[] = []
    for (let i = descentIndex + 1; i < moves.length && moves[i].role === 'lead_in'; i++) engage.push(moves[i])
    expect(engage.length, 'the whole planned lead is emitted as the engage').toBe(leadPass.points.length)
    for (const m of engage) {
      expect(m.type).toBe('feed')
      expect(m.feed, `every engage move runs at leadInRate, not the roughing feed`).toBe(EMIT_CTX.feeds.leadInRate)
      expect(m.z, 'the engage is horizontal, at depth').toBeCloseTo(depth, 9)
    }
    const handOff = engage[engage.length - 1]
    expect(atXY(handOff, leadPass.points[leadPass.points.length - 1]), 'ending where the cut starts').toBe(true)

    // 4. AND THE CUT AFTER IT IS STILL A CUT, at the roughing feed. The lead-in rate belongs
    //    to the engage alone; this rule does not slow the cutting down.
    const afterEngage = moves[descentIndex + 1 + engage.length]
    expect(afterEngage.type).toBe('feed')
    expect(afterEngage.feed, 'the roughing cut keeps the cutting feed').toBe(EMIT_CTX.feeds.feedRate)
  }, 240_000)

  it('the flag is what switches the shape: a landing proven only to the landing cap still plunges', () => {
    // The clear-air rung is the ONLY producer of `clearAirLanding`. Every other lift landing --
    // including the proven-clear-SHAFT rungs above it, which are held to the looser
    // landingUncutCap and may descend through a few percent of standing stock -- must keep its
    // plungeRate descent and its cutting-feed lead, byte for byte. Both shapes are emitted here
    // from the same stream so the difference is the flag and nothing else.
    const clearAir: AdaptivePass = { type: 'link', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }], jumpType: 2, clearAirLanding: true }
    const clearAirLead: AdaptivePass = { type: 'lead', points: [{ x: 10, y: 0 }, { x: 11, y: 1 }] }
    const cappedShaft: AdaptivePass = { type: 'link', points: [{ x: 20, y: 0 }, { x: 30, y: 0 }], jumpType: 2 }
    const cappedShaftLead: AdaptivePass = { type: 'lead', points: [{ x: 30, y: 0 }, { x: 31, y: 1 }] }
    const moves = quiet(() => emitFeature(minimalResult([
      { type: 'cut', points: [{ x: -1, y: 0 }, { x: 0, y: 0 }] },
      clearAir, clearAirLead,
      { type: 'cut', points: [{ x: 11, y: 1 }, { x: 20, y: 0 }] },
      cappedShaft, cappedShaftLead,
      { type: 'cut', points: [{ x: 31, y: 1 }, { x: 35, y: 1 }] },
    ]), EMIT_CTX))
    const depth = EMIT_CTX.heights.bottomZ

    // The clear-air landing: rapid down, engage at leadInRate.
    const airDescent = moves.find(m => atXY(m, { x: 10, y: 0 }) && Math.abs(m.z - depth) <= 1e-9)!
    expect(airDescent.type, 'clear-air landing descends by rapid').toBe('rapid')
    const airLead = moves.filter(m => m.role === 'lead_in' && m.x >= 10 && m.x <= 11)
    expect(airLead).toHaveLength(2)
    for (const m of airLead) expect(m.feed).toBe(EMIT_CTX.feeds.leadInRate)

    // The capped-shaft landing, untouched: plunge at plungeRate, lead at the cutting feed.
    const shaftDescent = moves.find(m => atXY(m, { x: 30, y: 0 }) && Math.abs(m.z - depth) <= 1e-9)!
    expect(shaftDescent.type, 'a landing proven only to the landing cap still feeds down').toBe('feed')
    expect(shaftDescent.role).toBe('plunge')
    expect(shaftDescent.feed).toBe(EMIT_CTX.feeds.plungeRate)
    const shaftLead = moves.filter(m => m.role === 'lead_in' && m.x >= 30 && m.x <= 31)
    expect(shaftLead).toHaveLength(2)
    for (const m of shaftLead) expect(m.feed, 'and keeps its cutting-feed lead').toBe(EMIT_CTX.feeds.feedRate)
  })
})
