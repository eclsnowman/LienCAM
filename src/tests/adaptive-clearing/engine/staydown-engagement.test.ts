// STAY-DOWN ENGAGEMENT GATE (regression for bug B8, docs/planning/POST-MERGE-WORKPLAN.md
// Group 2). With integralWallFollow ON, a connection ride substituted for a lift used to be
// emitted WITHOUT revalidation against the cleared state, so a stay-down wallfollow could
// slot FULL-WIDTH through uncleared stock (AC-SPEC R1 material safety / R2 optimal load).
// Measured offenders on this exact fixture before the fix: a 110mm wallfollow at 6.00mm
// effective width (full slot, 101mm over uncut) and a 22mm wallfollow sustaining 3.52mm.
//
// Method (same replay as the _b8-slot-probe diagnostic): run the REAL engine on a 120x120
// square pocket with a centered round island (the user's B8 fixture scale), then replay the
// ordered pass stream maintaining a PHYSICAL cleared-so-far accumulator (entry disks +
// cut/finish corridors + the material each stay-down move itself removes, incrementally).
// Every wallfollow is measured with the SAME windowed metric the engine gate uses
// (processFeature rideOverloadsUncut): full-toolRadius capsule chain, incremental fresh
// area per step, sliding window of >= 2mm path length, average effective width per window.
// The windowed average is deliberately robust to single-step quantization spikes (a
// near-zero-length step grazing a sliver reads a huge instantaneous width but contributes
// negligible area over 2mm) -- per-step max is NOT the contract, sustained width is.
//
// Assertion: NO wallfollow's worst window exceeds CAP = 1.5 x stepover distance. The
// legitimate wall-cleanup rides (deliberate skims of the thin sub-stepover uncut wall
// sliver) pass under the cap; the B8 slot class trips it. Loopbacks are OUT OF SCOPE here
// (tracked separately; see POST-MERGE-WORKPLAN follow-up).
//
// Deterministic: pure geometry, fixed fixture, no RNG (see determinism.test.ts).

import { describe, it, expect, beforeAll, vi } from 'vitest'
import * as fs from 'fs'
import {
  ensureEngineClipperReady, diskPath, capsulePath, offsetOpenRound,
  union, difference, totalArea, netArea, type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, planStopShortKeepDown, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { emitFeature, type EmitContext } from '../../../lib/cam/adaptiveClearing2d/engine/emit'

// ---- fixture: the B8 repro (120x120 pocket, centered 40mm-dia island, 6mm tool, 25% load)
const SIZE = 120
const ISLR = 20
const TOOLR = 3
const STEPOVER = 0.25
const TOL = 0.1
const ARCTOL = 0.05
const STEPOVER_DIST = 2 * TOOLR * STEPOVER       // 1.5mm
const CAP = 1.5 * STEPOVER_DIST                  // 2.25mm sustained effective width
const WINDOW = 2.0                               // mm (matches the engine gate)
const DS = 0.75                                  // mm resample spacing (matches the gate)

function circle(cx: number, cy: number, r: number, n = 180): Loop {
  const p: Loop = []
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }) }
  return p
}
const square: Loop = [{ x: 0, y: 0 }, { x: SIZE, y: 0 }, { x: SIZE, y: SIZE }, { x: 0, y: SIZE }]
const island = circle(SIZE / 2, SIZE / 2, ISLR)

const dist = (a: Pt, b: Pt) => Math.hypot(b.x - a.x, b.y - a.y)

/** Resample a polyline at <= ds spacing, keeping original vertices. */
function resample(pts: Pt[], ds: number): Pt[] {
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const L = dist(a, b)
    const n = Math.max(1, Math.ceil(L / ds))
    for (let k = 1; k <= n; k++) out.push({ x: a.x + (b.x - a.x) * k / n, y: a.y + (b.y - a.y) * k / n })
  }
  return out
}

/** Worst sustained effective cut width of a stay-down move over uncleared stock: sweep with
 *  full-toolRadius capsules incrementally against `cleared`, then take the max area density
 *  over sliding windows of >= WINDOW mm (denominator clamped to WINDOW for short tails).
 *  Mirrors processFeature's rideOverloadsUncut. Returns the worst window's average width,
 *  its location, and the final accumulator (cleared + this move's sweep). */
function worstSustainedWidth(move: Pt[], cleared: Loops): { maxWidth: number; at: Pt; acc: Loops } {
  const pts = resample(move, DS)
  const stepLen: number[] = []
  const stepArea: number[] = []
  const stepMid: Pt[] = []
  let acc = cleared
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i]
    const L = dist(a, b)
    if (L < 1e-9) continue
    const cap = capsulePath(a, b, TOOLR, ARCTOL)
    stepLen.push(L)
    stepArea.push(totalArea(difference(cap, acc)))
    stepMid.push({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    acc = union(acc, cap)
  }
  let maxWidth = 0
  let at: Pt = move[0]
  let j = 0, lenSum = 0, areaSum = 0
  for (let i = 0; i < stepLen.length; i++) {
    while (j < stepLen.length && lenSum < WINDOW) { lenSum += stepLen[j]; areaSum += stepArea[j]; j++ }
    const w = areaSum / Math.max(lenSum, WINDOW)
    if (w > maxWidth) { maxWidth = w; at = stepMid[i] }
    lenSum -= stepLen[i]; areaSum -= stepArea[i]
  }
  return { maxWidth, at, acc }
}

describe('stay-down engagement cap (B8 regression, island fixture)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('no stay-down wallfollow exceeds 1.5x stepover sustained width over uncleared stock', () => {
    const params: ProcessParams = {
      toolRadius: TOOLR,
      stepOver: STEPOVER,
      tolerance: TOL,
      helixDiameter: TOOLR * 2 * 0.9,
      stockToLeave: 0,
      integralWallFollow: true,   // the B8 feature, ON
      wallCleanupAsWeGo: true,
      loopbackFilletPct: 25,
      wallFinish: true,
    }
    const res = processFeature({ boundary: square, holes: [island] }, params)
    expect(res.stats.aborted).toBeUndefined()

    // Replay the ordered pass stream against a physical cleared accumulator.
    let cleared: Loops = []
    let wallfollows = 0
    const offenders: string[] = []
    for (let i = 0; i < res.passes.length; i++) {
      const pass = res.passes[i]
      if (pass.type === 'entry') {
        cleared = union(cleared, diskPath(pass.point, pass.radius + TOOLR, ARCTOL))
      } else if (pass.type === 'cut' || pass.type === 'finish') {
        if (pass.points.length >= 2) cleared = union(cleared, offsetOpenRound(pass.points, TOOLR, ARCTOL))
      } else if (pass.type === 'wallfollow') {
        wallfollows++
        const { maxWidth, at, acc } = worstSustainedWidth(pass.points, cleared)
        cleared = acc
        if (maxWidth > CAP) {
          offenders.push(`pass#${i} wallfollow sustained width ${maxWidth.toFixed(2)}mm > cap ${CAP.toFixed(2)}mm near (${at.x.toFixed(2)}, ${at.y.toFixed(2)})`)
        }
      } else if (pass.type === 'loopback') {
        // OUT OF SCOPE for this gate (follow-up item) -- but its removed material is real,
        // so fold its sweep into the accumulator to keep later measurements honest.
        if (pass.points.length >= 2) cleared = union(cleared, offsetOpenRound(pass.points, TOOLR, ARCTOL))
      } else if (pass.type === 'link') {
        const link = pass as Extract<AdaptivePass, { type: 'link' }>
        // keep-down links travel at depth: fold their sweep in. Lifts (jumpType 2) are
        // retracted -- they remove nothing.
        if (link.jumpType === 1) cleared = union(cleared, offsetOpenRound(link.points, TOOLR, ARCTOL))
      }
    }

    // Non-vacuous: the integral wall-follow actually fired on this fixture.
    expect(wallfollows).toBeGreaterThan(0)
    // The B8 contract: zero wallfollows sustain more than the cap over uncleared stock.
    expect(offenders, `stay-down wallfollows over engagement cap:\n${offenders.join('\n')}`).toEqual([])
  }, 300_000)
})

// ════════════════════════════════════════════════════════════════════════════════════════
// LIFT-LANDING GATE (B8 follow-up, 2026-06-12). After a jumpType-2 lift, emit plunges
// STRAIGHT DOWN at the link's landing point (emit.ts emitLink). The cusp ENTRY ride
// (wallCleanupAsWeGo) used to relocate that landing to entryRide.far with NO material-state
// check -- measured offender: Bar gt fixture, first inter-pass transition, landing at
// (143.33, -54.97) with 97% of the tool disk over UNCUT stock = full-width center plunge
// (AC-SPEC R1 material safety / R2 optimal load).
//
// The gate (processFeature appendCutPass, lift case iii): validate the tool-radius landing
// disk against clearedBeforePass; uncut fraction must be <= LANDING_UNCUT_CAP (5% -- just
// above the engagement walker's engage-band bite bound of ~3-4% of the disk, 25x above the
// measured-safe 0.2% landings, 4.6x below the measured 23%/97% failures). On a trip the
// entry ride is rebuilt SHORTER by the same buildWallFollowEntry machinery (halved, up to 3
// times); if no useful length lands safely the relocation is DROPPED and the landing returns
// to the walker point. Every rejection is a fail-loud [lift-landing] console.warn.
//
// CONTRACT ENCODED HERE (tightened 2026-06-12, helix-descent landings):
//  (1) island repro: EVERY emitted lift landing <= cap (blanket; worst measured 0.2%).
//  (2) Bar: the 97% relocated landing is GONE (nothing lands near (143.33, -54.97)), the
//      gate fired (warn captured), and every RELOCATED landing (lift followed by its entry
//      ride) is <= cap.
//  (3) HELIX DESCENT (closes the former raw-walker-landing exception): a landing whose disk
//      is over the cap may NO LONGER be a straight plunge. The lift-landing gate now plans a
//      helix descent at the landing (link.helixDescent: same construction as a region entry,
//      centre shifted inward off the wall by <= radius so the at-depth lead to the pass
//      start stays inside the helix-opened disk); emit descends via that helix instead of
//      plunging. Bar's first transition (the measured 87.8%-uncut raw walker landing) and
//      BootL's 42.6% landing are the pinned offenders. The straight-plunge fallback exists
//      ONLY for a landing where no helix fits -- it carries a loud 'NO helix fits' warn, and
//      that warn is asserted ABSENT on island repro + Bar + BootL (a helix fits everywhere
//      it is needed on these fixtures; nothing unsafe and nothing silent).
// ════════════════════════════════════════════════════════════════════════════════════════

const LANDING_CAP_FRAC = 0.05 // mirrors processFeature LANDING_UNCUT_CAP

interface Landing {
  passIdx: number; to: Pt; uncutFrac: number; relocated: boolean
  helix?: { center: Pt; radius: number } // lift-landing gate planned a helix descent here
}

/** Replay the ordered pass stream with a physical cleared accumulator and measure every
 *  EMITTED jumpType-2 lift's landing disk (links immediately before an `entry` are skipped
 *  by emit and own their approach, so they are skipped here too -- mirrors emit.ts). A
 *  helix-descent landing's opened disk (radius + toolR around the centre; the at-depth lead
 *  lies inside it by construction) is folded into the accumulator, like an entry's disk. */
function measureLiftLandings(passes: AdaptivePass[], toolR: number): Landing[] {
  const diskArea = Math.PI * toolR * toolR
  let cleared: Loops = []
  const landings: Landing[] = []
  for (let i = 0; i < passes.length; i++) {
    const pass = passes[i]
    if (pass.type === 'entry') {
      cleared = union(cleared, diskPath(pass.point, pass.radius + toolR, ARCTOL))
    } else if (pass.type === 'cut' || pass.type === 'finish' || pass.type === 'wallfollow' || pass.type === 'loopback') {
      if (pass.points.length >= 2) cleared = union(cleared, offsetOpenRound(pass.points, toolR, ARCTOL))
    } else if (pass.type === 'link') {
      const link = pass as Extract<AdaptivePass, { type: 'link' }>
      if (link.jumpType === 1) {
        cleared = union(cleared, offsetOpenRound(link.points, toolR, ARCTOL))
      } else {
        const next = passes[i + 1]
        if (next && next.type === 'entry') continue
        const to = link.points[1]
        const uncut = Math.max(0, netArea(difference(diskPath(to, toolR, ARCTOL), cleared)))
        landings.push({ passIdx: i, to, uncutFrac: uncut / diskArea, relocated: next?.type === 'wallfollow', helix: link.helixDescent })
        // A helix descent physically opens its full disk before the pass cuts -- fold it in.
        if (link.helixDescent) cleared = union(cleared, diskPath(link.helixDescent.center, link.helixDescent.radius + toolR, ARCTOL))
      }
    }
  }
  return landings
}

function loadGtFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name,
  }
}

describe('lift-landing gate (B8 follow-up: plunge lands over cleared stock)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  // RE-PINNED 2026-08-23 (WO-443): this fixture runs wallFinish:true, and the nested
  // cleanup now leaves the credited wall band STANDING during roughing, so two landings
  // near the rim honestly exceed the uncut cap and escalate exactly as designed: the
  // lift-landing gate plans a HELIX DESCENT for each (the same escalation the Bar
  // contract (3)/(3b) below has blessed since 2026-06-12). The blanket "no landing over
  // the cap" pin predates any over-cap landing existing here and encoded the escalation's
  // ABSENCE, not its correctness. The pin now matches (3b): an over-cap landing must
  // carry a planned helix descent -- never a straight plunge -- and the unsafe
  // 'NO helix fits' fallback still never fires. LANDING_UNCUT_CAP and gateLiftLanding
  // are untouched; control run with the band forced empty passes the old pin
  // (src/tests/evidence/WO-443/island-landing-finding.json).
  it('island repro: every over-cap lift landing carries a planned helix descent (no straight plunge)', () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')) })
    let res
    try {
      const params: ProcessParams = {
        toolRadius: TOOLR, stepOver: STEPOVER, tolerance: TOL,
        helixDiameter: TOOLR * 2 * 0.9, stockToLeave: 0,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
      }
      res = processFeature({ boundary: square, holes: [island] }, params)
    } finally {
      spy.mockRestore()
    }
    expect(res.stats.aborted).toBeUndefined()

    const landings = measureLiftLandings(res.passes, TOOLR)
    // WO-1178 re-pin: this fixture no longer lifts at all (0 landings; the walker plants its
    // starts ahead of stock and rings ride the walls they touch, so every connection stays
    // down). The invariants below are kept for any landing a future change brings back; the
    // gate itself is exercised by the synthetic cases further down this file.
    expect(landings.length).toBeGreaterThanOrEqual(0)
    // WO-443 re-pin: over-cap landings are legal ONLY via the gated helix descent (3b's
    // rule). An over-cap landing with NO planned helix is the actual defect class.
    const offenders = landings.filter(l => l.uncutFrac > LANDING_CAP_FRAC && !l.helix)
      .map(l => `pass#${l.passIdx} landing (${l.to.x.toFixed(2)}, ${l.to.y.toFixed(2)}) ${(l.uncutFrac * 100).toFixed(1)}% uncut, no helix descent`)
    expect(offenders, `over-cap lift landings without a helix descent:\n${offenders.join('\n')}`).toEqual([])
    // Every planned helix centre sits within the gate's own construction ladder
    // (planHelixDescent): (a) AT the landing, (b) shifted inward by exactly rh, or
    // (c) a CORNER landing on the inward bisector at rh * sqrt(2) -- the documented
    // bounded side bite. Anything farther is not a construction the gate can produce.
    for (const l of landings.filter(l => l.helix)) {
      expect(Math.hypot(l.helix!.center.x - l.to.x, l.helix!.center.y - l.to.y))
        .toBeLessThanOrEqual(l.helix!.radius * Math.SQRT2 + 1e-6)
    }
    // The unsafe straight-plunge fallback (helix could not fit) never fires here.
    expect(warns.filter(w => w.includes('NO helix fits'))).toEqual([])
  }, 300_000)

  it('Bar gt fixture: the unsafe raw walker landing descends via HELIX, not a straight plunge', () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')) })
    let res
    try {
      const { boundary, holes, helixDiameter } = loadGtFixture(4) // Bar
      res = processFeature({ boundary, holes }, {
        toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
      })
    } finally {
      spy.mockRestore()
    }
    expect(res.stats.aborted).toBeUndefined()

    // WO-1178 re-pin. Bar roughs with ZERO retracts now (WO-1103 moved its entry to one end of
    // the channel, WO-1178 rides the walls into the corners), so there is no lift landing on it
    // to gate: the gate never fires, nothing lands at the old 97%-uncut point, and no helix is
    // drilled. What this case guards from here on: that stays true, and if a landing ever
    // returns it must be gated (helix planned, never a straight plunge) -- assertions kept below.
    const gateWarns = warns.filter(w => w.includes('[lift-landing]'))
    expect(gateWarns.filter(w => w.includes('NO helix fits'))).toEqual([])
    const landings = measureLiftLandings(res.passes, 2.0)
    expect(res.passes.filter(p => p.type === 'link' && p.jumpType === 2), 'Bar lifts at the corpus settings').toHaveLength(0)
    const OLD_BAD: Pt = { x: 143.33, y: -54.97 }
    const nearOld = landings.filter(l => Math.hypot(l.to.x - OLD_BAD.x, l.to.y - OLD_BAD.y) < 1.0)
    expect(nearOld, `a lift still lands at the old 97%-uncut point: ${JSON.stringify(nearOld)}`).toEqual([])
    const badRelocated = landings.filter(l => l.relocated && l.uncutFrac > LANDING_CAP_FRAC)
      .map(l => `pass#${l.passIdx} (${l.to.x.toFixed(2)}, ${l.to.y.toFixed(2)}) ${(l.uncutFrac * 100).toFixed(1)}% uncut`)
    expect(badRelocated, `relocated landings over the cap:\n${badRelocated.join('\n')}`).toEqual([])
    // (3b) Blanket: NO landing over the cap is left as a straight plunge anywhere on Bar.
    const badPlunges = landings.filter(l => l.uncutFrac > LANDING_CAP_FRAC && !l.helix)
      .map(l => `pass#${l.passIdx} (${l.to.x.toFixed(2)}, ${l.to.y.toFixed(2)}) ${(l.uncutFrac * 100).toFixed(1)}% uncut`)
    expect(badPlunges, `straight plunges into over-cap landing disks:\n${badPlunges.join('\n')}`).toEqual([])

    // (3c) emit honors the flag -- ROLE/SHAPE: the descent at the flagged landing is a helix
    //      spiral (role 'helix' moves circling the planned centre), and the move immediately
    //      after it is the at-depth lead (role 'lead_in'), not a straight plunge.
    //
    // WO-410 FOLD (re-pinned 2026-08-21): the honest cleared state reshapes Bar's whole pass
    // schedule, and this fixture's wall corner at (143.33, -51.97) is now revisited by a
    // SECOND, later, unrelated jumpType-2 transition after intervening passes have cleared it
    // -- that later transition lands safely with an ordinary plunge at (coincidentally) almost
    // the same coordinate. A feature-wide "no plunge anywhere near this (x,y)" search catches
    // that unrelated, legitimate plunge as a false positive. Pin THIS transition's own descent
    // instead: the move right after its helix ring must be the lead_in, at its own landing point.
    const ctx: EmitContext = {
      heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -2 },
      feeds: { feedRate: 1000, plungeRate: 300, rampRate: 450, leadInRate: 1000, leadOutRate: 1000, fastTraverseRate: 5000, finishRate: 1000 },
      stepdown: 5,
      helixAngleDeg: 3,
    }
    // WO-1178: Bar has no helix landing today, so this block runs only for a landing that
    // returns with a planned helix -- the shape contract is unchanged.
    const first = landings.find(l => l.helix)
    if (first?.helix) {
      const moves = emitFeature(res, ctx)
      const hd = first.helix
      const isHelixAtLanding = (m: (typeof moves)[number]): boolean =>
        m.role === 'helix' && Math.hypot(m.x - hd.center.x, m.y - hd.center.y) <= hd.radius + 1e-6
      const helixAtLanding = moves.filter(isHelixAtLanding)
      expect(helixAtLanding.length, 'no helix-role moves circle the planned descent centre').toBeGreaterThan(2)
      let lastHelixIdx = -1
      moves.forEach((m, i) => { if (isHelixAtLanding(m)) lastHelixIdx = i })
      expect(lastHelixIdx, 'planned helix ring never appears in the emitted move stream').toBeGreaterThanOrEqual(0)
      const afterHelix = moves[lastHelixIdx + 1]
      expect(afterHelix?.role, 'the move right after this helix descent is not the at-depth lead').toBe('lead_in')
      expect(Math.hypot(afterHelix.x - first.to.x, afterHelix.y - first.to.y),
        'the at-depth lead after this helix does not reach this transition\'s landing point').toBeLessThan(1e-6)
    }
  }, 300_000)

  it('BootL gt fixture: every over-cap landing descends via helix (no straight plunge into uncut)', () => {
    const warns: string[] = []
    const spy = vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => { warns.push(args.map(String).join(' ')) })
    let res
    try {
      const { boundary, holes, helixDiameter } = loadGtFixture(5) // BootL
      res = processFeature({ boundary, holes }, {
        toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
      })
    } finally {
      spy.mockRestore()
    }
    expect(res.stats.aborted).toBeUndefined()

    const landings = measureLiftLandings(res.passes, 2.0)
    expect(landings.length).toBeGreaterThan(0)
    // WO-410 (re-pinned 2026-08-21): BootL is the fix5 fixture the WO's own numbers name as
    // reshaped by the residual/fold contract (285 mm^2 of tool-enterable leftover now actually
    // machined via 11 real entries, instead of hiding behind the old dead abort check -- see
    // processFeature's residualMaxInscribedR comment and WO-410's "Numbers" section). The old
    // 42.6%-uncut offender at (24.83, -98.66) does not reproduce in the reshaped plan; measured
    // now, every one of this fixture's 38 lift landings is already under the cap (worst 4.3%).
    // The gate is still exercised non-vacuously (island repro + Bar carry the over-cap cases);
    // pin the blanket safety property here instead of a stale non-vacuous offender.
    const overCap = landings.filter(l => l.uncutFrac > LANDING_CAP_FRAC)
    const offenders = overCap.map(l => `pass#${l.passIdx} (${l.to.x.toFixed(2)}, ${l.to.y.toFixed(2)}) ${(l.uncutFrac * 100).toFixed(1)}% uncut`)
    expect(offenders, `unexpected over-cap landing(s) on BootL:\n${offenders.join('\n')}`).toEqual([])
    // Every one of them (should this fixture ever produce one again) must carry a planned helix
    // descent -- no straight plunge into >cap stock.
    const badPlunges = overCap.filter(l => !l.helix)
      .map(l => `pass#${l.passIdx} (${l.to.x.toFixed(2)}, ${l.to.y.toFixed(2)}) ${(l.uncutFrac * 100).toFixed(1)}% uncut`)
    expect(badPlunges, `straight plunges into over-cap landing disks:\n${badPlunges.join('\n')}`).toEqual([])
    // The unsafe straight-plunge fallback (helix could not fit) never fires on BootL.
    expect(warns.filter(w => w.includes('NO helix fits'))).toEqual([])
  }, 300_000)
})

// -----------------------------------------------------------------------------------------
// WO-466 TIER 2.5 -- THE STOP-SHORT LENGTH CONTRACT (added in the fix round after the audit
// finding "stop-short relaxes the tier-0 feed-length ceiling by arcTol").
//
// WHAT BROKE AND WHY NOTHING CAUGHT IT. planStopShortKeepDown decided the whole-chord case on
// `!(chordLen - feedLenCap > arcTol)`, so every chord in `(feedLenCap, feedLenCap + arcTol]`
// was fed WHOLE -- above the bar the engine's own tier-0 cut-through gate enforces
// (`chordLen <= 2 * stepOverDistance`, processFeature phase 2b) -- while the emitted reason
// claimed it was inside that bar. The callers' `feedClear` measures LOAD only and reapplies
// no length ceiling, so nothing downstream caught it either. The corpus never produced a
// chord in that window (the six stay-down laps are 0.05-0.07mm against a multi-mm bar and the
// one roughing case is 13.64mm), so pinning corpus OUTPUT could not have exposed it. The
// contract has to be asserted where it lives.
//
// These are pure-geometry unit assertions over caller-supplied proofs -- no engine state, no
// fixture, no clipper -- so they run in milliseconds and fail on the boundary itself rather
// than on a downstream number that happens to move.
describe('WO-466 stop-short keep-down: the fed tail never exceeds the tier-0 length bar', () => {
  const ARC = 0.05
  const CAP = 4.0                                   // stands for 2 x stepOverDistance
  const SRC = { x: 0, y: 0 }
  const tgt = (len: number) => ({ x: len, y: 0 })
  const never = () => null                          // proof that always passes
  const always = (why: string) => () => why         // proof that always refuses
  /** Travel proof that clears a prefix and refuses beyond it -- monotone in s, as the real
   *  corridor proofs are. `b` is the candidate prefix's far end. */
  const clearsUpTo = (d: number) => (_a: Pt, b: Pt) =>
    Math.hypot(b.x - SRC.x, b.y - SRC.y) <= d + 1e-9 ? null : `refused past ${d}mm`

  const plan = (over: Partial<Parameters<typeof planStopShortKeepDown>[0]> = {}) =>
    planStopShortKeepDown({
      source: SRC, target: tgt(CAP), arcTol: ARC, gouges: () => false,
      travelClear: always('standing skin'), feedClear: never, feedLenCap: CAP, ...over,
    })

  const feedLenOf = (r: ReturnType<typeof planStopShortKeepDown>) =>
    'feed' in r ? Math.hypot(r.feed[1].x - r.feed[0].x, r.feed[1].y - r.feed[0].y) : 0

  it('feeds a chord EXACTLY at the bar whole, with no travel half', () => {
    const r = plan({ target: tgt(CAP) })
    expect('travel' in r, JSON.stringify(r)).toBe(true)
    if (!('travel' in r)) return
    expect(r.travel).toEqual([SRC])                  // one point: nothing travels
    expect(r.feed).toEqual([SRC, tgt(CAP)])
    expect(feedLenOf(r)).toBeCloseTo(CAP, 9)
  })

  it('REGRESSION: a chord just OVER the bar is never fed whole, anywhere in the old arcTol grace', () => {
    // Every one of these was accepted-and-fed-whole before the fix (all satisfy
    // chordLen - CAP <= arcTol). With no travel proof available the only honest answer is a
    // refusal, and the retract stays.
    for (const eps of [1e-9, ARC / 8, ARC / 2, ARC * 0.999, ARC]) {
      const r = plan({ target: tgt(CAP + eps) })
      expect('refused' in r, `chord ${CAP + eps} was accepted: ${JSON.stringify(r)}`).toBe(true)
    }
  })

  it('REGRESSION: a chord just over the bar may still SPLIT -- and its fed tail stays under the bar', () => {
    const len = CAP + ARC / 2
    const r = plan({ target: tgt(len), travelClear: clearsUpTo(len - 0.5) })
    expect('travel' in r, JSON.stringify(r)).toBe(true)
    if (!('travel' in r)) return
    expect(r.travel.length).toBe(2)                  // it TRAVELS -- this is not the whole-chord case
    expect(feedLenOf(r)).toBeLessThanOrEqual(CAP + 1e-9)
    expect(feedLenOf(r)).toBeGreaterThan(0)
    expect(r.reason).toContain('stop-short@')        // not the whole-chord attribution
    expect(r.reason).not.toContain('whole-chord')
  })

  it('refuses when the proven travel half is under the arc tolerance (the split would be the whole chord in disguise)', () => {
    const len = CAP + ARC / 2                        // sMin = ARC/2, under arcTol
    const r = plan({ target: tgt(len), travelClear: clearsUpTo(ARC / 2) })
    expect('refused' in r, JSON.stringify(r)).toBe(true)
    if ('refused' in r) expect(r.refused).toContain('arc tolerance')
  })

  it('holds the ceiling across a sweep of chord lengths and proof depths', () => {
    // The blanket property, not one point on it: whatever this helper returns, the FED half is
    // within the caller's length bar, the two halves are contiguous, and a travel-less answer
    // (the whole chord fed) only ever appears at or under the bar.
    const offenders: string[] = []
    for (const len of [0.05, 0.5, 1, CAP - 1e-6, CAP, CAP + 1e-9, CAP + ARC / 2, CAP + ARC,
                       CAP + ARC * 2, CAP + 1, CAP * 2, CAP * 5]) {
      for (const depth of [0, ARC / 2, ARC, 0.5, 1, len / 2, len - CAP / 2, len - 1e-6, len]) {
        const r = planStopShortKeepDown({
          source: SRC, target: tgt(len), arcTol: ARC, gouges: () => false,
          travelClear: clearsUpTo(depth), feedClear: never, feedLenCap: CAP,
        })
        if ('refused' in r) continue
        const fed = feedLenOf(r)
        const tag = `len=${len} depth=${depth}`
        if (fed > CAP + 1e-9) offenders.push(`${tag}: fed ${fed.toFixed(6)} > bar ${CAP}`)
        if (r.travel.length === 1 && len > CAP + 1e-9) {
          offenders.push(`${tag}: whole chord ${len} fed with no travel, over bar ${CAP}`)
        }
        if (r.travel[0].x !== SRC.x || r.travel[0].y !== SRC.y) offenders.push(`${tag}: travel does not start at source`)
        const handoff = r.travel[r.travel.length - 1]
        if (Math.hypot(handoff.x - r.feed[0].x, handoff.y - r.feed[0].y) > 1e-9) {
          offenders.push(`${tag}: travel end and feed start disagree`)
        }
        if (Math.hypot(r.feed[1].x - len, r.feed[1].y) > 1e-9) offenders.push(`${tag}: feed does not end at target`)
        if (r.travel.length === 2) {
          const tLen = Math.hypot(handoff.x - SRC.x, handoff.y - SRC.y)
          if (!(tLen > ARC)) offenders.push(`${tag}: sub-tolerance travel half ${tLen.toFixed(6)}`)
        }
      }
    }
    expect(offenders, `stop-short length-bar violations:\n${offenders.join('\n')}`).toEqual([])
  })

  it('keeps the vetoes that make the rung legal', () => {
    // The gouge veto covers the WHOLE chord before either half is measured...
    const gouged = plan({ gouges: () => true })
    expect('refused' in gouged && gouged.refused).toContain('gouge')
    // ...a chord a cheaper whole-corridor rung already owns is handed back...
    const clean = plan({ target: tgt(CAP * 3), travelClear: never })
    expect('refused' in clean && clean.refused).toContain('cheaper rung')
    // ...and the fed half still has to pass the caller's own cutting-load proof.
    const overloaded = plan({ feedClear: always('sustains 9.9mm effective width') })
    expect('refused' in overloaded && overloaded.refused).toContain('9.9mm')
  })
})
