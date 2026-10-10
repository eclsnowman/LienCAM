// Integral wall-follow gate. Two layers:
//  (1) Unit: boundaryArcBetween is a pure helper -- exercise its three outcomes directly
//      (short shared-wall arc, arc-over-budget -> null, different-loop -> null).
//  (2) Integration: a square+island fixture produces jumpType-2 lifts whose endpoints share
//      a wall. With the flag OFF the pass stream is unchanged (ZERO wallfollow passes); with
//      the flag ON at least one such lift becomes a 'wallfollow' pass that rides cutRegion
//      and whose endpoints equal the original link's endpoints.

import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady, type Loop, type Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  processFeature,
  resolveIntegralWallFollowLengthFactor,
  type AdaptivePass,
  type ProcessParams,
} from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { boundaryArcBetween } from '../../../lib/cam/adaptiveClearing2d/engine/engagementPoint'

function circle(cx: number, cy: number, r: number, n = 120): Loop {
  const p: Loop = []
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }) }
  return p
}

// Point-to-polyline (closed loops) distance, mirroring the engine winding (segment i runs
// path[i-1]..path[i]). Self-contained so the test does not import engine internals.
function distToLoops(p: Pt, loops: Loop[]): number {
  let min = Infinity
  for (const loop of loops) {
    const n = loop.length
    for (let i = 0; i < n; i++) {
      const a = loop[(i - 1 + n) % n], b = loop[i]
      const lx = b.x - a.x, ly = b.y - a.y
      const lsq = lx * lx + ly * ly
      let t = lsq === 0 ? 0 : ((p.x - a.x) * lx + (p.y - a.y) * ly) / lsq
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const dx = p.x - (a.x + t * lx), dy = p.y - (a.y + t * ly)
      const d = Math.hypot(dx, dy)
      if (d < min) min = d
    }
  }
  return min
}

const polylineLen = (pts: Pt[]): number => {
  let len = 0
  for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return len
}

describe('boundaryArcBetween (pure helper)', () => {
  // A single 0..60 square loop. Two points just inside the bottom edge ride that edge.
  const square: Loop = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }]

  it('two points near the same edge -> short arc starting at p0, ending at p1', () => {
    const p0: Pt = { x: 10, y: 0.5 }
    const p1: Pt = { x: 40, y: 0.5 }
    const maxLen = 200
    const arc = boundaryArcBetween([square], p0, p1, maxLen)
    expect(arc).not.toBeNull()
    const a = arc!
    expect(a.length).toBeGreaterThanOrEqual(2)
    // Starts at p0 and ends at p1 exactly (literal endpoints).
    expect(Math.hypot(a[0].x - p0.x, a[0].y - p0.y)).toBeLessThan(1e-9)
    expect(Math.hypot(a[a.length - 1].x - p1.x, a[a.length - 1].y - p1.y)).toBeLessThan(1e-9)
    // Rides the edge (every point near the boundary).
    for (const p of a) expect(distToLoops(p, [square])).toBeLessThan(0.6)
    // Within the budget, and the SHORTER of the two arcs (straight skim ~30mm along the
    // bottom edge, not the ~210mm long way around).
    expect(polylineLen(a)).toBeLessThanOrEqual(maxLen)
    expect(polylineLen(a)).toBeLessThan(40)
  })

  it('short arc exceeds maxLen -> null', () => {
    const p0: Pt = { x: 10, y: 0.5 }
    const p1: Pt = { x: 40, y: 0.5 }
    // The genuine shorter arc is ~30mm; a 5mm budget rejects it.
    expect(boundaryArcBetween([square], p0, p1, 5)).toBeNull()
  })

  it('points on different loops -> null', () => {
    // Two disjoint squares. p0 hugs the first, p1 hugs the second -> not a shared wall.
    const sqA: Loop = [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]
    const sqB: Loop = [{ x: 100, y: 100 }, { x: 110, y: 100 }, { x: 110, y: 110 }, { x: 100, y: 110 }]
    const p0: Pt = { x: 5, y: 0.2 }
    const p1: Pt = { x: 105, y: 100.2 }
    expect(boundaryArcBetween([sqA, sqB], p0, p1, 1000)).toBeNull()
  })
})

// NOTE on determinism: the engine is now deterministic (identical inputs -> byte-identical
// pass streams; see determinism.test.ts). The historical run-to-run drift was Math.random
// probe angles in the steering search -- NOT clipper2-wasm, which is deterministic -- and
// is fixed by a fixed-seed PRNG per interpolator. The OFF-vs-ON proof below stays INTRINSIC
// (assert properties of ONE run) because it is the stronger formulation, not because a
// cross-run diff is unsound:
//  - FLAG OFF: the new 'wallfollow' variant is NEVER emitted (the OFF code path is the
//    unchanged push-the-link path; zero wallfollows == no behavior change), AND the fixture
//    has at least one convertible lift (so the ON case is not vacuous).
//  - FLAG ON: every emitted wallfollow rides cutRegion, starts at the PREVIOUS cut's last
//    point and ends at the NEXT cut's first point (the exact endpoints the replaced lift
//    used), and replaces a lift that would have been jumpType 2.
describe('integral wall-follow in processFeature', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  // A 60x60 square with a centered circular island. The engagement-limited fill leaves
  // inter-pass jumps; some are lifts (jumpType 2) whose two endpoints sit on the same wall.
  const square: Loop = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }]
  const island = circle(30, 30, 8)
  const baseParams: ProcessParams = { toolRadius: 2, stepOver: 0.5, tolerance: 0.1, helixDiameter: 3, stockToLeave: 0.5 }

  it('missing and invalid direct-ride factors resolve exactly to the historical 2.0', () => {
    expect(resolveIntegralWallFollowLengthFactor(undefined)).toBe(2)
    expect(resolveIntegralWallFollowLengthFactor(Number.NaN)).toBe(2)
    expect(resolveIntegralWallFollowLengthFactor(Number.POSITIVE_INFINITY)).toBe(2)
    expect(resolveIntegralWallFollowLengthFactor(0)).toBe(2)
    expect(resolveIntegralWallFollowLengthFactor(-1)).toBe(2)
    expect(resolveIntegralWallFollowLengthFactor(1.25)).toBe(1.25)
  })

  it('FLAG OFF: zero wallfollow passes (no behavior change) and a convertible lift exists', () => {
    const res = processFeature({ boundary: square, holes: [island] }, baseParams)
    expect(res.stats.aborted).toBeUndefined()

    // OFF never emits the new variant -> the OFF stream is exactly the pre-existing kinds.
    const wallfollows = res.passes.filter(p => p.type === 'wallfollow')
    expect(wallfollows.length).toBe(0)
    for (const p of res.passes) expect(['cut', 'link', 'entry', 'lead']).toContain(p.type)

    // The fixture actually has a convertible lift: a jumpType-2 link whose endpoints share a
    // wall within 200% of the chord. (Since the B8 gate, convertible no longer implies
    // CONVERTED -- at this 50% stepover both candidates are rejected as uncleared-rim plows;
    // the FLAG ON test exercises the conversion at 25% stepover instead.)
    const lifts = res.passes.filter((p): p is Extract<AdaptivePass, { type: 'link' }> =>
      p.type === 'link' && p.jumpType === 2)
    const convertible = lifts.filter(l => {
      const [a, b] = l.points
      const chord = Math.hypot(b.x - a.x, b.y - a.y)
      return boundaryArcBetween(res.cutRegion, a, b, 2 * chord) !== null
    })
    expect(convertible.length).toBeGreaterThan(0)
  }, 60_000)

  it('FLAG explicit-false behaves like the default (no flag): neither emits a wallfollow', () => {
    // false and undefined are both falsy, so both take the unchanged push-the-link path.
    // (The OFF guarantee is structural -- the new block is skipped -- and is proven by the
    // absence of the only thing it can add: a 'wallfollow' pass. The engine is deterministic
    // now -- the old "stochastic clipper" claim was wrong; the drift was Math.random probe
    // angles, since seeded -- so a cross-run diff would also hold, but the structural proof
    // is kept as the stronger, intent-revealing assertion.)
    const noFlag = processFeature({ boundary: square, holes: [island] }, baseParams)
    const off = processFeature({ boundary: square, holes: [island] }, { ...baseParams, integralWallFollow: false })
    expect(noFlag.passes.some(p => p.type === 'wallfollow')).toBe(false)
    expect(off.passes.some(p => p.type === 'wallfollow')).toBe(false)
    // Both streams contain ONLY the pre-existing pass kinds.
    for (const p of [...noFlag.passes, ...off.passes]) expect(['cut', 'link', 'entry', 'lead']).toContain(p.type)
  }, 60_000)

  it('CLEANUP makes NO keep-down-vs-lift decision (lift count == baseline, only adds rides)', () => {
    // wallCleanupAsWeGo (cusp cleanup) owns ONLY the arc-end rides. It must NOT decide
    // keep-down-vs-lift -- that is integralWallFollow's sole job. So with cleanup ON but
    // retract-elimination OFF, the LIFT count must equal the both-OFF baseline (cleanup adds
    // wall-follow cusp rides but never converts or introduces a lift). The lift count is the
    // policy-level signal (the cut count can differ between the two runs because cleanup
    // changes downstream geometry decisions), so we assert on lifts, not on total passes.
    //
    // NOTE: with integralWallFollow OFF, processFeature emits NO 'wallfollow' from retract-
    // elimination, so any 'wallfollow' present under CLEANUP-ONLY came purely from cusp cleanup.
    const baseline = processFeature({ boundary: square, holes: [island] }, baseParams)
    const cleanupOnly = processFeature({ boundary: square, holes: [island] }, { ...baseParams, wallCleanupAsWeGo: true })
    expect(baseline.stats.aborted).toBeUndefined()
    expect(cleanupOnly.stats.aborted).toBeUndefined()

    const liftCount = (r: typeof baseline) => r.passes.filter(p => p.type === 'link' && p.jumpType === 2).length
    // Cleanup did not change the keep-down-vs-lift policy: the lift count stays at the baseline
    // level. (The two runs use DIFFERENT params -- cleanup ON vs OFF -- so geometry-coupled
    // counts can legitimately differ by ~1 even though the engine itself is now deterministic
    // for identical inputs; keep the tiny absolute slack rather than asserting an exact match.
    // It still catches the conflated regression where cleanup forced its own lifts -- that
    // defect produced 159 lifts vs a single-digit baseline. Numeric tightening deferred.)
    expect(Math.abs(liftCount(cleanupOnly) - liftCount(baseline))).toBeLessThanOrEqual(2)
    // Cleanup DID add cusp rides (non-vacuous: this fixture reaches the wall at transitions).
    expect(cleanupOnly.passes.some(p => p.type === 'wallfollow')).toBe(true)
  }, 60_000)

  it('FLAG ON: every substituted ride is direction-correct (never the wrong-side short wall arc)', () => {
    // NOTE (B8 stay-down engagement gate, 2026-06-12): a convertible lift now converts only
    // when the substituted ride is ALSO engagement-safe over uncleared stock (sustained
    // effective width <= 1.5x stepover -- see processFeature rideOverloadsUncut and
    // staydown-engagement.test.ts). Run the ON case at 25% stepover, where the rim is thin
    // and safe rides survive, so the conversion path stays non-vacuously exercised.
    //
    // WO-410 FOLD (re-pinned 2026-08-21): `cleared`/`clearedBeforePass` now reflect only real
    // tool travel (expandCleared folds no phantom disk for a stalled pass), so the B8 gate's
    // rideOverloadsUncut judges this fixture's direct-ride arcs against an honest -- not
    // fiction-widened -- physical state. That flips several of this fixture's rides from
    // "gate-rejected" to "gate-accepted", so at this stepover the fixture no longer produces
    // zero wallfollows. "wrong-side" is a separate, still-live guarantee: `arcs` (processFeature
    // ~line 1893) is filtered by wallPointsMatchDirection BEFORE any length or overload check
    // runs, so every ride this rung can ever emit is already direction-correct by construction.
    // Assert that guarantee directly (every wallfollow point rides the cutRegion boundary)
    // instead of the stale zero-count.
    const on = processFeature({ boundary: square, holes: [island] }, { ...baseParams, stepOver: 0.25, integralWallFollow: true })
    expect(on.stats.aborted).toBeUndefined()

    const wallfollows = on.passes.filter((p): p is Extract<AdaptivePass, { type: 'wallfollow' }> => p.type === 'wallfollow')
    expect(wallfollows.length).toBeGreaterThan(0)
    for (const wf of wallfollows) for (const p of wf.points) expect(distToLoops(p, on.cutRegion)).toBeLessThan(0.6)
    // WO-438 (891de640; re-pinned 2026-08-24): this fixture's full-clearance connections
    // descended to tier-1 loopbacks, so require that fallback rung instead of jumpType-2.
    expect(on.passes.some(p => p.type === 'loopback')).toBe(true)
  }, 60_000)

  it('default/missing/invalid factors are byte-equal to explicit 2.0 output', () => {
    const feature = { boundary: square, holes: [island] }
    const authored = {
      ...baseParams,
      stepOver: 0.25,
      integralWallFollow: true,
    }
    const explicitDefault = processFeature(feature, {
      ...authored,
      integralWallFollowLengthFactor: 2,
    })
    const missing = processFeature(feature, authored)
    const invalid = processFeature(feature, {
      ...authored,
      integralWallFollowLengthFactor: Number.NaN,
    })

    expect(JSON.stringify(missing)).toBe(JSON.stringify(explicitDefault))
    expect(JSON.stringify(invalid)).toBe(JSON.stringify(explicitDefault))
  }, 60_000)

  it('length budget changes how many rides qualify, never a wall-follow on the wrong material side', () => {
    const feature = { boundary: square, holes: [island] }
    const authored = {
      ...baseParams,
      stepOver: 0.75,
      integralWallFollow: true,
    }
    // WO-438 (891de640; re-pinned 2026-08-24): tier-1 routing makes factors 1.0 and 1.1
    // vacuous at 25% stepover (both yield 13 wallfollows). At 75% stepover, factor 0.1 keeps
    // one connection as a tier-1 loopback while factor 1.0 admits its direct wall ride:
    // 31 vs 32 wallfollows, measured rather than guessed. Every admitted ride must still be
    // direction-correct; wallPointsMatchDirection gates `arcs` before length/overload do.
    const lower = processFeature(feature, {
      ...authored,
      integralWallFollowLengthFactor: 0.1,
    })
    const higher = processFeature(feature, {
      ...authored,
      integralWallFollowLengthFactor: 1,
    })

    const wallFollows = (r: typeof lower) => r.passes.filter(p => p.type === 'wallfollow')
    const lifts = (r: typeof lower) =>
      r.passes.filter(p => p.type === 'link' && p.jumpType === 2)
    const loopbacks = (r: typeof lower) => r.passes.filter(p => p.type === 'loopback')
    // WO-1178 re-pin (31 / 32 -> 0 / 0): at 75% stepover on this fixture no connection needs a
    // wall ride any more -- a pass rides the wall it touches inside the cut, the walker plants
    // the next start ahead of the stock, and every remaining connection is a tier-1 loopback
    // (4) or the one lift, identical at both factors. The budget has nothing left to choose
    // between here; what is still pinned is that it can never RAISE the connection tier
    // (loopbacks and lifts never grow with the factor) and that any ride it does admit is on
    // the wall and direction-correct (the loops below, and the FLAG ON case above).
    expect(wallFollows(lower)).toHaveLength(0)
    expect(wallFollows(higher)).toHaveLength(0)
    for (const r of [lower, higher]) for (const wf of wallFollows(r)) for (const p of wf.points) expect(distToLoops(p, r.cutRegion)).toBeLessThan(0.6)
    // A bigger wall-follow budget may trade a tier-1 loopback for a direct wall ride, never
    // add a full-clearance lift or otherwise raise the connection tier.
    expect(loopbacks(higher).length).toBeLessThanOrEqual(loopbacks(lower).length)
    expect(lifts(higher).length).toBe(lifts(lower).length)

    // The budget still owns eligibility only: cutting paths, entries, regions, residual, and
    // completion accounting are identical regardless of how many rides it admits. Only the
    // tier-1 loopback vs direct wall-follow connection choice differs.
    const nonConnections = (r: typeof lower) =>
      r.passes.filter(p => p.type !== 'link' && p.type !== 'wallfollow' && p.type !== 'loopback')
    expect(nonConnections(lower)).toEqual(nonConnections(higher))
    expect(lower.entries).toEqual(higher.entries)
    expect(lower.cleared).toEqual(higher.cleared)
    expect(lower.cutRegion).toEqual(higher.cutRegion)
    expect(lower.residual).toEqual(higher.residual)
    expect(lower.stats).toEqual(higher.stats)
  }, 60_000)
})
