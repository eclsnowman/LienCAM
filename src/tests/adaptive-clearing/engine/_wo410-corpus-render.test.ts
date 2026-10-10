// WO-410 CORPUS RENDER (visual gate, diagnostic; underscore = not CI).
//
// Renders the nine gt corpus fixtures (gt_fix0..gt_fix8) at the canonical engine
// settings the WO-410 before/after measure used (R 2.0, stepOver 0.2, tol 0.1,
// stockToLeave 0.5, integralWallFollow, wallCleanupAsWeGo, loopbackFilletPct 25),
// one PNG per fixture, so Operator can SEE what the WO-410 engine change did to the
// paths. Run once at the pre-WO-410 engine (git checkout d6a13921 --
// src/lib/cam/adaptiveClearing2d) with CORPUS_TAG=before, once at HEAD with
// CORPUS_TAG=after; the stitcher in src/tests/evidence/WO-410/corpus/ pairs them.
//
// Legend (same as _b8-routearound-render): blue=cut, teal=wall ride kept down,
// amber=loopback, green=keep-down link, bright red=full-clearance lift/retract,
// orange=micro-lift (WO-437: a 2mm hop near the floor instead of a flight),
// magenta=wall-finishing contour (WO-443, only under CORPUS_WALLFINISH=1),
// WO-466: a finish-lap CONNECTION is not a pass and used to be invisible here -- a red
// RING marks a lap still entered by a tier-3 retract, and a WHITE stub marks one the
// tier-2.5 stop-short keeps down (its at-depth travel bright green, its fed tail white).
//
// WO-454 correction, from WO-452's headline finding: every corpus render/stat since WO-410
// silently used processFeature's conventional fallback, while the GOOD-Corpus project Operator
// judges resolves to climb. CORPUS_DIRECTION accepts climb | conventional and now defaults to
// climb deliberately. CORPUS_OUT_DIR must be explicit for committed evidence; when it is unset,
// the harness warns and writes only to the gitignored _corpus-scratch directory.
//
// WO-443 envs: CORPUS_STEPOVER (matched-settings runs, default 0.2) and CORPUS_WALLFINISH
// (=1 turns params.wallFinish on, default OFF so the default snapshot is unchanged).
//
// WO-445: the wall cleanup emits as 'finish' passes; res.finishPassOffsets says which
// offset each one rides. This harness reports `wallStack` (finish contour passes) as its
// own field next to `cuts`, and the Fusion comparison is shown BOTH ways -- cuts, and
// cuts+stack. Fusion's recordings exclude their own finish operation, so counting our
// stack AGAINST us is the honest side of the line.
//
// WO-447: WO-445's semi lap is GONE (Operator rejected riding the perimeter twice) -- the
// machining-load layer of the wall is now taken during ROUGHING by the completed
// wall-follow coverage: the wallCleanupAsWeGo transition rides, plus gap-fill rides over
// the stretches no transition reached. So finishPassOffsets reads 'wall' on every finish
// pass, and the harness reports instead:
//   - rideLen / fillLen / fillFrac  (getWallCoverStats): the total wall-follow ride length,
//     how much of it is gap-fill, and the gap-fill share of the boundary -- Operator's promise
//     that only the MISSED fraction gets ridden, measured.
//   - rimStandArea / rimStandDepth: the WO-446-style probe, moved into the harness. What
//     the TRUE-WALL pass actually meets beyond its designed finishStock skin, once every
//     emitted wall ride's own swept capsule is folded in. The coverage guarantee is that
//     this collapses to ~epsilon everywhere the tool fits.
//
// Run:  CORPUS_DIRECTION=climb CORPUS_OUT_DIR=src/tests/evidence/WO-410/corpus \
//         CORPUS_TAG=after npx vitest run \
//         src/tests/adaptive-clearing/engine/_wo410-corpus-render.test.ts

import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as zlib from 'zlib'
import {
  ensureEngineClipperReady, offsetClosed, offsetOpenRound, difference, intersection, union, netArea,
  type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, getWallCoverStats, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const SCRATCH_OUT_DIR = 'src/tests/evidence/_corpus-scratch'
const OUT_DIR = process.env.CORPUS_OUT_DIR ?? SCRATCH_OUT_DIR
if (process.env.CORPUS_OUT_DIR === undefined) {
  console.warn(`[WO-454 corpus] WARNING: CORPUS_OUT_DIR is unset; writing scratch output to ${SCRATCH_OUT_DIR}. Set CORPUS_OUT_DIR explicitly to preserve evidence.`)
}
const TAG = process.env.CORPUS_TAG ?? 'after'
const directionEnv = process.env.CORPUS_DIRECTION ?? 'climb'
if (directionEnv !== 'climb' && directionEnv !== 'conventional') {
  throw new Error(`CORPUS_DIRECTION must be "climb" or "conventional"; received "${directionEnv}"`)
}
const CORPUS_DIRECTION: NonNullable<ProcessParams['millingDirection']> = directionEnv
// WO-439 rebaseline: the Fusion recordings ran optimal load 1.6mm (0.4 x the 4mm tool) --
// ours defaulted 0.8mm (0.2D), an apples-to-oranges comparison Operator caught 2026-08-20.
// Override for matched-assumption runs; default unchanged (all prior evidence reproducible).
const STEP_OVER = Number(process.env.CORPUS_STEPOVER ?? 0.2)
// WO-443 nested cleanup step 2: run the corpus with the dedicated wall-finishing contour
// switched on, so the walker's credited-band skip is exercised. DEFAULT OFF -- the default
// snapshot stays byte-identical, exactly as CORPUS_STEPOVER above leaves it.
const WALL_FINISH = process.env.CORPUS_WALLFINISH === '1' || process.env.CORPUS_WALLFINISH === 'true'
// Fusion's own recorded pass count per fixture, fix0..fix8 (GOOD-SPEC section 5, [GT]:
// Comma 63, Kidney 79, SquareIsland 102, Tee 59, Bar 38, BootL 107, Triangle 60,
// Barbell 54, Boomerang 84). The gold standard the T2 tripwire is denominated in.
const FUSION_PASSES = [63, 79, 102, 59, 38, 107, 60, 54, 84]

function loadGtFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name as string,
  }
}

// ---- minimal PNG framebuffer (copied from _b8-routearound-render.test.ts) ----
class FB {
  buf: Uint8Array; w: number; h: number
  constructor(w: number, h: number, bg: [number, number, number]) {
    this.w = w; this.h = h
    this.buf = new Uint8Array(w * h * 4)
    for (let i = 0; i < w * h; i++) { this.buf[i * 4] = bg[0]; this.buf[i * 4 + 1] = bg[1]; this.buf[i * 4 + 2] = bg[2]; this.buf[i * 4 + 3] = 255 }
  }
  px(x: number, y: number, c: [number, number, number]) {
    x |= 0; y |= 0
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return
    const i = (y * this.w + x) * 4
    this.buf[i] = c[0]; this.buf[i + 1] = c[1]; this.buf[i + 2] = c[2]; this.buf[i + 3] = 255
  }
  dot(x: number, y: number, c: [number, number, number], r = 0) {
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) this.px(x + dx, y + dy, c)
  }
  line(x0: number, y0: number, x1: number, y1: number, c: [number, number, number], r = 0) {
    x0 |= 0; y0 |= 0; x1 |= 0; y1 |= 0
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0)
    const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1
    let err = dx + dy
    for (; ;) {
      this.dot(x0, y0, c, r)
      if (x0 === x1 && y0 === y1) break
      const e2 = 2 * err
      if (e2 >= dy) { err += dy; x0 += sx }
      if (e2 <= dx) { err += dx; y0 += sy }
    }
  }
  png(): Buffer {
    const raw = Buffer.alloc(this.h * (this.w * 4 + 1))
    for (let y = 0; y < this.h; y++) {
      raw[y * (this.w * 4 + 1)] = 0
      this.buf.subarray(y * this.w * 4, (y + 1) * this.w * 4).forEach((v, i) => { raw[y * (this.w * 4 + 1) + 1 + i] = v })
    }
    const idat = zlib.deflateSync(raw)
    const chunk = (type: string, data: Buffer) => {
      const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
      const t = Buffer.from(type, 'ascii')
      const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0)
      return Buffer.concat([len, t, data, crc])
    }
    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(this.w, 0); ihdr.writeUInt32BE(this.h, 4); ihdr[8] = 8; ihdr[9] = 6
    const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
    return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))])
  }
}
function crc32(buf: Buffer): number {
  let c = ~0
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xEDB88320 & -(c & 1))
  }
  return ~c
}

// ---- WO-447: WHAT THE TRUE-WALL PASS ACTUALLY MEETS (the coverage guarantee, measured) ----
//
// This is WO-446's measureRimLeftover probe, moved into the harness where the WO-447 Done-when
// asks for it. Two facts make the construction what it is:
//
//  1. The engine folds a GAP-FILL ride's swept capsule into `cleared`, but it has NEVER folded
//     the wall-follow TRANSITION rides emitted during the walk (those are proven under the ride
//     cap, not credited as clearance). A measure taken off `cleared` alone therefore
//     under-reports what the roughing physically removed along the wall. Fold every emitted
//     wall ride's own capsule HERE, in the measure, and the number reads as what the machine
//     really leaves for the finish lap.
//  2. targetRegion starts at the finishStock line, so everything counted is ABOVE THE SKIN.
//     The skin is the wall pass's designed load, not leftover.
//
//     standing = ((true-wall sweep ^ targetRegion) - cleared) - (every emitted wall ride capsule)
//
// depth is probed at 0.05 mm inward offsets of the REAL wall and reported FROM THE SKIN, exactly
// as WO-446's engine probe did (0 = the wall pass meets nothing but its skin). `reach*` restricts
// the same measure to the band a roughing-offset ride can physically reach (the cutRegion sweep)
// -- "everywhere the tool fits", the WO's own qualifier: material outside it is in a neck no
// roughing-offset contour has geometry in, and is the true-wall pass's business by geometry.
const RIM_PROBE_STEP = 0.05
const RIM_PROBE_AREA_EPS = 1e-3

function sweepOf(region: Loops, toolRadius: number, arcTol: number): Loops {
  if (region.length === 0) return []
  return difference(offsetClosed(region, toolRadius, arcTol), offsetClosed(region, -toolRadius, arcTol))
}

/** Union of the swept capsule of every emitted 'wallfollow' pass (open-round offset by the
 *  tool radius -- the same corridor the engine's own expandCleared folds for a cut). */
function wallRideSweep(passes: AdaptivePass[], toolRadius: number, arcTol: number): { sweep: Loops; length: number } {
  let sweep: Loops = []
  let length = 0
  for (const pass of passes) {
    if (pass.type !== 'wallfollow' || pass.points.length < 2) continue
    for (let i = 1; i < pass.points.length; i++) {
      length += Math.hypot(pass.points[i].x - pass.points[i - 1].x, pass.points[i].y - pass.points[i - 1].y)
    }
    const corridor = offsetOpenRound(pass.points, toolRadius, arcTol)
    if (corridor.length === 0) continue
    sweep = sweep.length === 0 ? corridor : union(sweep, corridor)
  }
  return { sweep, length }
}

/** Deepest inward offset from the real wall at which anything still stands in `standing`,
 *  reported as depth ABOVE the finishStock skin. 0 when nothing stands. */
function standingDepthAboveSkin(standing: Loops, feat: Loops, finishStock: number, toolRadius: number, arcTol: number): number {
  const area = (l: Loops) => Math.abs(netArea(l))
  if (standing.length === 0 || area(standing) <= RIM_PROBE_AREA_EPS) return 0
  let deepest = finishStock
  for (let d = finishStock + RIM_PROBE_STEP; d <= 2 * toolRadius + 1e-9; d += RIM_PROBE_STEP) {
    const inset = offsetClosed(feat, -d, arcTol)
    if (inset.length === 0) break
    const still = intersection(standing, inset)
    if (still.length === 0 || area(still) <= RIM_PROBE_AREA_EPS) break
    deepest = d
  }
  return Math.max(deepest - finishStock, 0)
}

/** Distance from p to the nearest point on any loop edge. */
function distToLoops(p: Pt, loops: Loops): number {
  let best = Infinity
  for (const lp of loops) {
    for (let i = 0; i < lp.length; i++) {
      const a = lp[i], b = lp[(i + 1) % lp.length]
      const abx = b.x - a.x, aby = b.y - a.y
      const L2 = abx * abx + aby * aby
      let t = L2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / L2 : 0
      t = Math.max(0, Math.min(1, t))
      const d = Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
      if (d < best) best = d
    }
  }
  return best === Infinity ? 0 : best
}

function measureFinalWallLoad(
  res: { cleared: Loops; cutRegion: Loops; passes: AdaptivePass[] },
  boundary: Loop,
  holes: Loop[],
  params: ProcessParams,
): {
  beforeRides: number; standing: number; depth: number
  reachStanding: number; reachDepth: number
  rideLength: number; residualAfterStack: number
} {
  const arcTol = Math.max(params.tolerance * 0.25, 0.01)
  const toolRadius = params.toolRadius
  const finishStock = params.tolerance / 2 + (params.stockToLeave ?? 0)
  const feat: Loops = difference([boundary], holes)
  const targetRegion = difference(offsetClosed([boundary], -finishStock, arcTol), offsetClosed(holes, finishStock, arcTol))
  // The true-wall tool-centre region and the roughing-offset tool-centre region.
  const wallRegion = difference(offsetClosed([boundary], -toolRadius, arcTol), offsetClosed(holes, toolRadius, arcTol))
  const wallSweep = sweepOf(wallRegion, toolRadius, arcTol)
  const reachSweep = finishStock > arcTol ? sweepOf(res.cutRegion, toolRadius, arcTol) : []
  const rides = wallRideSweep(res.passes, toolRadius, arcTol)
  const area = (l: Loops) => Math.abs(netArea(l))
  const beforeRides = difference(intersection(wallSweep, targetRegion), res.cleared)
  const standing = rides.sweep.length ? difference(beforeRides, rides.sweep) : beforeRides
  const reachStanding = reachSweep.length ? intersection(standing, reachSweep) : standing
  // What is STILL standing in the whole target region once the rides AND the true-wall lap have
  // gone by. The engine folds no 'finish' pass into `cleared` (WO-443's design), so fold both
  // sweeps here and the number reads as abandonment, which is what a wall-band residual is
  // often mistaken for.
  const swept = rides.sweep.length ? union(wallSweep, rides.sweep) : wallSweep
  const residualAfterStack = area(difference(difference(targetRegion, res.cleared), swept))
  return {
    beforeRides: area(beforeRides),
    standing: area(standing),
    depth: standingDepthAboveSkin(standing, feat, finishStock, toolRadius, arcTol),
    reachStanding: area(reachStanding),
    reachDepth: standingDepthAboveSkin(reachStanding, feat, finishStock, toolRadius, arcTol),
    rideLength: rides.length,
    residualAfterStack,
  }
}

describe(`WO-410 corpus render (${TAG})`, () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  const stats: Record<string, unknown>[] = []

  for (let fix = 0; fix <= 8; fix++) {
    it(`renders gt_fix${fix} (${TAG})`, () => {
      const { boundary, holes, helixDiameter, name } = loadGtFixture(fix)
      const params: ProcessParams = {
        toolRadius: 2.0, stepOver: STEP_OVER, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
        millingDirection: CORPUS_DIRECTION,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
        ...(WALL_FINISH ? { wallFinish: true } : {}),
      }
      const warn = console.warn; console.warn = () => {}
      const t0 = performance.now()
      let res
      try { res = processFeature({ boundary, holes }, params) } finally { console.warn = warn }
      const seconds = (performance.now() - t0) / 1000

      type LinkPass = Extract<AdaptivePass, { type: 'link' }>
      const liftLinks = res.passes.filter(p => p.type === 'link' && (p as LinkPass).jumpType === 2) as LinkPass[]
      const lifts = liftLinks.length
      // WO-437 tier 2: micro-lifts hop at 2mm instead of flying to clearance. Old engines
      // (before renders) have no microLift field -- every lift counts as clearance there.
      const microLifts = liftLinks.filter(p => (p as { microLift?: { z: number } }).microLift).length
      const clearanceLifts = lifts - microLifts
      // WO-435 T1 attribution, surfaced (WO-447): every tier-3 move must name which cheaper
      // tiers were tried and which proof failed. `liftReason` is attached NON-ENUMERABLE, so it
      // has to be read by direct property access -- exactly as goodspec-tripwires.test.ts does.
      // With it in the stats JSON a lift-count delta between two runs is attributable line by
      // line instead of by argument.
      const liftReasons = liftLinks.map(p => ({
        at: [Number(p.points[0].x.toFixed(2)), Number(p.points[0].y.toFixed(2))],
        to: [Number(p.points[1].x.toFixed(2)), Number(p.points[1].y.toFixed(2))],
        micro: !!(p as { microLift?: unknown }).microLift,
        reason: (p as { liftReason?: string }).liftReason ?? 'unattributed',
      }))
      const cuts = res.passes.filter(p => p.type === 'cut').length
      const entries = res.entries.length
      // WO-447 wall stack: every emitted finish pass. Since the semi lap is gone this is the
      // true-wall lap alone, and finishPassOffsets reads 'wall' on every entry.
      const offsets = res.finishPassOffsets ?? []
      const wallLaps = offsets.filter(o => o === 'wall').length
      const wallStack = res.passes.filter(p => p.type === 'finish').length
      // WO-449: every connection INTO a finish lap is now a GATED tier-3 retract, planned in
      // processFeature and replayed by emit at each level. These are FULL-CLEARANCE RETRACTS
      // and they are the honest cost of killing the bare feed that used to run at depth
      // between the laps (on SquareIsland, straight through the retained island). They do NOT
      // appear in `lifts` -- that counts jumpType-2 LINKS, and an approach is not a link -- so
      // they are counted and attributed separately here. T1 attribution is mandatory
      // (GOOD-SPEC section 6): `reason` names which cheaper tiers were tried, which proof
      // refused them, and which rung of the lift-landing gate answered.
      const approaches = res.finishApproaches ?? []
      // WO-466 SPLIT BY TIER. A tier-3 flight to clearance and a tier-2.5 connection that
      // never leaves the floor are not the same event and must never be summed (WO-453's
      // attempt-1 bar was rejected for exactly that conflation). `finishRetracts` keeps its
      // meaning -- flights only -- and the kept-down ones are counted beside it.
      const finishRetracts = approaches.filter(a => a && a.tier !== 'stopshort').length
      const finishStayDowns = approaches.filter(a => a && a.tier === 'stopshort').length
      const finishStayDownTravelLen = approaches.reduce((sum, a) => sum
        + (a?.tier === 'stopshort' && a.travel && a.travel.length >= 2
          ? Math.hypot(a.travel[1].x - a.travel[0].x, a.travel[1].y - a.travel[0].y) : 0), 0)
      const finishStayDownFedLen = approaches.reduce((sum, a) => sum
        + (a?.tier === 'stopshort' && a.feed && a.feed.length >= 2
          ? Math.hypot(a.feed[1].x - a.feed[0].x, a.feed[1].y - a.feed[0].y) : 0), 0)
      const finishHelixDescents = approaches.filter(a => a?.helix).length
      const finishReasons = approaches.map((a, k) => a
        ? { lap: k, tier: a.tier, at: [Number(a.descent.x.toFixed(2)), Number(a.descent.y.toFixed(2))], helix: !!a.helix, lead: a.lead?.length ?? 0, reason: a.reason }
        : { lap: k, reason: 'no connection (first pass of the feature)' })
      // WO-447 coverage bookkeeping, straight off the engine's own sink.
      const cover = getWallCoverStats()
      // WO-447 SHAPE TRIPWIRE. A 'wallfollow' pass is a sub-polyline of a cutRegion boundary
      // loop by construction, so its point-to-point steps are boundary facets -- millimetre
      // scale at production arcTol. A LONG step inside one is a straight line across open
      // field wearing a wall-ride's role tag, which is exactly the defect a picture gate is
      // supposed to catch. Report the worst step and where it is, per fixture.
      // Split the measure at the LAST 'cut' pass: on the gap-fill branch the full
      // cleanup-contour loop does not run, so every 'wallfollow' pass after that index is a
      // WO-447 gap ride and everything before it is a walk-time transition ride. That
      // separates a defect this WO introduced from one it inherited.
      let lastCutIdx = -1
      for (let i = 0; i < res.passes.length; i++) if (res.passes[i].type === 'cut') lastCutIdx = i
      let wallRideMaxStep = 0
      let wallRideMaxStepAt: [number, number] = [0, 0]
      let gapRideMaxStep = 0
      let gapRideMaxStepAt: [number, number] = [0, 0]
      // THE DECISIVE TEST for a long step inside a wall ride: is its MIDPOINT still on the
      // cutRegion boundary? A long step along a straight wall is one long boundary facet and
      // its midpoint sits on the wall (~0). A straight flight across open field wearing the
      // wall-ride role tag has a midpoint far off it.
      let wallRideMaxStepMidOffWall = 0
      let gapRideMaxStepMidOffWall = 0
      let wallRideWorstOffWall = 0, wallRideWorstOffWallLen = 0
      let wallRideWorstOffWallAt: [number, number] = [0, 0]
      let gapRideWorstOffWall = 0, gapRideWorstOffWallLen = 0
      let gapRideWorstOffWallAt: [number, number] = [0, 0]
      for (let pi = 0; pi < res.passes.length; pi++) {
        const pass = res.passes[pi]
        if (pass.type !== 'wallfollow') continue
        for (let i = 1; i < pass.points.length; i++) {
          const d = Math.hypot(pass.points[i].x - pass.points[i - 1].x, pass.points[i].y - pass.points[i - 1].y)
          const mid = { x: (pass.points[i].x + pass.points[i - 1].x) / 2, y: (pass.points[i].y + pass.points[i - 1].y) / 2 }
          const at: [number, number] = [Number(pass.points[i - 1].x.toFixed(2)), Number(pass.points[i - 1].y.toFixed(2))]
          if (d > wallRideMaxStep) { wallRideMaxStep = d; wallRideMaxStepAt = at; wallRideMaxStepMidOffWall = distToLoops(mid, res.cutRegion) }
          if (pi > lastCutIdx && d > gapRideMaxStep) { gapRideMaxStep = d; gapRideMaxStepAt = at; gapRideMaxStepMidOffWall = distToLoops(mid, res.cutRegion) }
          // The same test applied to EVERY step, not just the longest: the worst off-wall
          // midpoint anywhere in a wall ride, and which ride family it belongs to.
          if (d > 0.5) {
            const off = distToLoops(mid, res.cutRegion)
            if (off > wallRideWorstOffWall) { wallRideWorstOffWall = off; wallRideWorstOffWallAt = at; wallRideWorstOffWallLen = d }
            if (pi > lastCutIdx && off > gapRideWorstOffWall) { gapRideWorstOffWall = off; gapRideWorstOffWallAt = at; gapRideWorstOffWallLen = d }
          }
        }
      }
      // WO-443 step 3, the residual identity, asserted HERE (the evidence run) and not in
      // the engine hot path: residualWalker + residualFinishBand must equal the total
      // residual to clipper tolerance. With wallFinish off the band account is 0 and the
      // identity is exact by construction.
      const residualArea = res.stats.residualArea
      const residualWalkerArea = res.stats.residualWalkerArea ?? residualArea
      const residualFinishBandArea = res.stats.residualFinishBandArea ?? 0
      const residualIdentityErr = Math.abs(residualWalkerArea + residualFinishBandArea - residualArea)
      // WO-445 FINAL-PASS LOAD, the claim the whole WO rests on: after the semi lap, the
      // TRUE-WALL pass must meet at most ~finishStock of standing material. Measured, not
      // asserted. Material the wall pass meets that lies INSIDE targetRegion is by
      // definition deeper than the finishStock line, so:
      //   beforeSemi = (wall sweep ^ targetRegion) - cleared      (what WO-443 left it)
      //   afterSemi  = beforeSemi - semi sweep                    (what WO-445 leaves it)
      // Both sweeps are the same dilate-r-minus-erode-r band the engine credits. maxDepth
      // is the deepest inward offset from the true wall at which anything still stands in
      // afterSemi (probed at 0.05 mm, reported as 0 when nothing stands).
      const finalWallLoad = measureFinalWallLoad(res, boundary, holes, params)
      const line = {
        fix, name, tag: TAG, wallFinish: WALL_FINISH, stepOver: STEP_OVER,
        lifts, microLifts, clearanceLifts, cuts, entries,
        fusionPasses: FUSION_PASSES[fix], fusionRatio: Number((cuts / FUSION_PASSES[fix]).toFixed(3)),
        wallStack, wallLaps, cutsPlusStack: cuts + wallStack,
        finishRetracts, finishStayDowns, finishHelixDescents, finishReasons,
        finishStayDownTravelLen: Number(finishStayDownTravelLen.toFixed(3)),
        finishStayDownFedLen: Number(finishStayDownFedLen.toFixed(3)),
        // WO-447: the ride ledger. rideLen is every emitted 'wallfollow' pass end to end;
        // coverBoundaryLen/coverCoveredLen/coverFilledLen are the engine's own arc-length
        // account of the cutRegion boundary offered to gap-fill; fillFrac is the share of that
        // boundary the gap-fill rides had to ride (Operator's "only the missed fraction").
        rideLen: Number(finalWallLoad.rideLength.toFixed(2)),
        coverBoundaryLen: Number(cover.boundaryLen.toFixed(2)),
        coverCoveredLen: Number(cover.coveredLen.toFixed(2)),
        coverFilledLen: Number(cover.filledLen.toFixed(2)),
        coverFillFrac: cover.boundaryLen > 0 ? Number((cover.filledLen / cover.boundaryLen).toFixed(4)) : null,
        coverGaps: cover.gaps, coverFilled: cover.filled,
        coverSkippedShort: cover.skippedShort, coverSkippedEmpty: cover.skippedEmpty,
        coverRefusedApproach: cover.refusedApproach, coverRefusedOverload: cover.refusedOverload,
        coverRefusedDirection: cover.refusedDirection,
        // WO-447 the coverage guarantee, measured (see measureFinalWallLoad).
        finalWallDeepAreaBeforeRides: Number(finalWallLoad.beforeRides.toFixed(4)),
        rimStandArea: Number(finalWallLoad.standing.toFixed(4)),
        rimStandDepth: Number(finalWallLoad.depth.toFixed(3)),
        rimStandAreaToolFits: Number(finalWallLoad.reachStanding.toFixed(4)),
        rimStandDepthToolFits: Number(finalWallLoad.reachDepth.toFixed(3)),
        residualAfterStack: Number(finalWallLoad.residualAfterStack.toFixed(4)),
        liftReasons,
        wallRideMaxStep: Number(wallRideMaxStep.toFixed(3)), wallRideMaxStepAt,
        gapRideMaxStep: Number(gapRideMaxStep.toFixed(3)), gapRideMaxStepAt,
        wallRideMaxStepMidOffWall: Number(wallRideMaxStepMidOffWall.toFixed(4)),
        gapRideMaxStepMidOffWall: Number(gapRideMaxStepMidOffWall.toFixed(4)),
        wallRideWorstOffWall: Number(wallRideWorstOffWall.toFixed(4)),
        wallRideWorstOffWallLen: Number(wallRideWorstOffWallLen.toFixed(3)), wallRideWorstOffWallAt,
        gapRideWorstOffWall: Number(gapRideWorstOffWall.toFixed(4)),
        gapRideWorstOffWallLen: Number(gapRideWorstOffWallLen.toFixed(3)), gapRideWorstOffWallAt,
        aborted: res.stats.aborted ?? null,
        residualArea: Number(residualArea.toFixed(4)),
        residualWalkerArea: Number(residualWalkerArea.toFixed(4)),
        residualFinishBandArea: Number(residualFinishBandArea.toFixed(4)),
        residualIdentityErr: Number(residualIdentityErr.toFixed(6)),
        residualMaxInscribedR: Number(res.stats.residualMaxInscribedR.toFixed(4)),
        seconds: Number(seconds.toFixed(1)),
      }
      stats.push(line)
      console.log(`[corpus ${TAG}] fix${fix} ${name}: cuts=${cuts} (fusion ${FUSION_PASSES[fix]}, ${(cuts / FUSION_PASSES[fix]).toFixed(2)}x) stack=${wallStack} (wall ${wallLaps}) cuts+stack=${cuts + wallStack} rimStand=${finalWallLoad.beforeRides.toFixed(2)}->${finalWallLoad.standing.toFixed(2)} mm2 (depth ${finalWallLoad.depth.toFixed(2)}mm; toolFits ${finalWallLoad.reachStanding.toFixed(2)} mm2 / ${finalWallLoad.reachDepth.toFixed(2)}mm; residualAfterStack ${finalWallLoad.residualAfterStack.toFixed(2)}) ride=${finalWallLoad.rideLength.toFixed(1)}mm cover=${cover.coveredLen.toFixed(1)}/${cover.boundaryLen.toFixed(1)}mm fill=${cover.filledLen.toFixed(1)}mm (${cover.boundaryLen > 0 ? (100 * cover.filledLen / cover.boundaryLen).toFixed(1) : 'n/a'}%) gaps=${cover.gaps} filled=${cover.filled} short=${cover.skippedShort} empty=${cover.skippedEmpty} refused=${cover.refusedApproach}/${cover.refusedOverload}/${cover.refusedDirection} lifts=${lifts} (micro=${microLifts} clearance=${clearanceLifts}) finishRetracts=${finishRetracts} (helix ${finishHelixDescents}) finishStayDown=${finishStayDowns} (travel ${finishStayDownTravelLen.toFixed(2)}mm + fed ${finishStayDownFedLen.toFixed(2)}mm) entries=${entries} aborted=${res.stats.aborted ?? 'no'} residual=${residualArea.toFixed(3)} (walker ${residualWalkerArea.toFixed(3)} + band ${residualFinishBandArea.toFixed(3)}, err ${residualIdentityErr.toFixed(6)}) ${seconds.toFixed(1)}s`)

      // ---- render (viewport auto-fit) ----
      const xs = [...boundary, ...holes.flat()].map(p => p.x), ys = [...boundary, ...holes.flat()].map(p => p.y)
      const minX = Math.min(...xs), minY = Math.min(...ys)
      const span = Math.max(Math.max(...xs) - minX, Math.max(...ys) - minY)
      const arcTol = 0.05
      const pad = 4, S = 720 / (span + 2 * pad)
      const W = Math.ceil((span + 2 * pad) * S), H = Math.ceil((span + 2 * pad) * S)
      const T = (p: Pt): [number, number] => [(p.x - minX + pad) * S, ((span - (p.y - minY)) + pad) * S]
      const fb = new FB(W, H, [17, 17, 17])
      const drawLoop = (loop: Pt[], c: [number, number, number], close: boolean, r = 0) => {
        for (let i = 1; i < loop.length; i++) { const a = T(loop[i - 1]), b = T(loop[i]); fb.line(a[0], a[1], b[0], b[1], c, r) }
        if (close && loop.length > 2) { const a = T(loop[loop.length - 1]), b = T(loop[0]); fb.line(a[0], a[1], b[0], b[1], c, r) }
      }
      const finishStock = params.tolerance / 2 + (params.stockToLeave ?? 0)
      const target: Loops = difference(offsetClosed([boundary], -finishStock, arcTol), offsetClosed(holes, finishStock, arcTol))
      for (const loop of target) drawLoop(loop, [45, 45, 45], true)
      drawLoop(boundary, [150, 150, 150], true)
      for (const h of holes) drawLoop(h, [190, 130, 130], true)
      for (const loop of res.cutRegion) drawLoop(loop, [80, 80, 80], true)
      for (const p of res.passes) if (p.type === 'cut') drawLoop(p.points, [55, 95, 150], false)
      for (const p of res.passes) if (p.type === 'wallfollow') drawLoop(p.points, [0, 200, 155], false)
      // WO-443: the dedicated wall-finishing contour (only present under CORPUS_WALLFINISH)
      // draws MAGENTA, so the band it is credited with is visible against the rough passes.
      for (const p of res.passes) if (p.type === 'finish') drawLoop((p as Extract<AdaptivePass, { type: 'finish' }>).points, [210, 70, 210], false)
      for (const p of res.passes) if (p.type === 'loopback') drawLoop(p.points, [220, 160, 0], false)
      // WO-437: micro-lifts (2mm hop, stays near the floor) draw ORANGE; full-clearance
      // retracts stay BRIGHT RED -- so Operator reads cheap hops vs real flights at a glance.
      for (const p of res.passes) if (p.type === 'link' && (p as LinkPass).jumpType === 2 && !(p as { microLift?: unknown }).microLift) drawLoop((p as LinkPass).points, [255, 40, 40], false, 2)
      for (const p of res.passes) if (p.type === 'link' && (p as LinkPass).jumpType === 2 && (p as { microLift?: unknown }).microLift) drawLoop((p as LinkPass).points, [255, 150, 30], false, 2)
      for (const p of res.passes) if (p.type === 'link' && (p as Extract<AdaptivePass, { type: 'link' }>).jumpType === 1) drawLoop((p as Extract<AdaptivePass, { type: 'link' }>).points, [40, 160, 40], false)
      // WO-466: a 'lead' pass is an at-depth approach at FEED -- the stop-short rung's
      // engaged tail, and the lift-landing gate's tangent lead. Drawn WHITE so the fed
      // stretch is distinguishable from the traverse that precedes it.
      for (const p of res.passes) if (p.type === 'lead') drawLoop(p.points, [245, 245, 245], false, 1)
      // WO-466: THE FINISH-LAP CONNECTIONS, which are not passes and so were invisible.
      for (const a of approaches) {
        if (!a) continue
        if (a.tier === 'stopshort') {
          if (a.travel && a.travel.length >= 2) drawLoop(a.travel, [40, 230, 40], false, 1)
          if (a.feed && a.feed.length >= 2) drawLoop(a.feed, [245, 245, 245], false, 1)
          // A whole-chord stop-short is sub-millimetre; mark it so it is visible at all.
          const [px, py] = T(a.descent)
          fb.dot(px, py, [245, 245, 245], 2)
        } else {
          // A RED RING: the lap is still entered by a flight to clearance.
          const [px, py] = T(a.descent)
          for (let deg = 0; deg < 360; deg += 6) {
            const r = deg * Math.PI / 180
            fb.dot(px + Math.cos(r) * 6, py + Math.sin(r) * 6, [255, 40, 40], 1)
          }
        }
      }

      fs.mkdirSync(OUT_DIR, { recursive: true })
      const out = `${OUT_DIR}/fix${fix}_${name}_${TAG}.png`
      fs.writeFileSync(out, fb.png())
      fs.writeFileSync(`${OUT_DIR}/stats_${TAG}.json`, JSON.stringify(stats, null, 2))
      console.log(`wrote ${out} ${W}x${H}`)
    }, 600_000)
  }
})
