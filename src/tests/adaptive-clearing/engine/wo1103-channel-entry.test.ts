// WO-1103 GATE: a long thin pocket starts its spiral near an end and is cut one way.
//
// WO-1100 measured why Bar (gt_fix4) retracts mid-pocket: the entry sits at the region's
// deepest point, which in a 21.30 x 62.83 mm channel is the MIDDLE. The spiral saturates
// across the width at r = 10.65 mm and strands ~21 mm of pocket at EACH end, so the walk has
// to cross from one end of that disk to the other over standing stock -- 9.21 mm2 of it,
// peaking at 5.8x the keep-down cap -- and every rung of the ladder correctly refuses to do
// that at depth. Fusion enters 20.7 mm nearer the top end and never turns round.
//
// These are behavioural assertions on the emitted path, not on the source: where the entry
// lands, how many times the roughing pass leaves the floor, and how wide the widest cut is.
// The byte-stability fingerprint and the WO-1103 census cover the other eight fixtures.

import { describe, it, beforeAll, expect } from 'vitest'
import * as fs from 'fs'
import {
  ensureEngineClipperReady, offsetClosed, offsetOpenRound, union, difference, intersection,
  diskPath, netArea, type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import { processFeature, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const TR = 2.0
const ARC_TOL = 0.02
/** The nine `Adaptive Clearing - *` operations in Adaptive Clearing Shapes.camproject carry
 *  these: 4 mm flat end mill, 1.60 mm stepover, 0.5 mm stock, wall finish on, climb. */
const CORPUS: ProcessParams = {
  toolRadius: TR, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
  integralWallFollow: true, integralWallFollowLengthFactor: 2, wallCleanupAsWeGo: true,
  loopbackFilletPct: 25, wallFinish: true, millingDirection: 'climb',
}
const STEP_OVER_MM = CORPUS.stepOver * TR * 2 // 1.60

function loadGt(fix: number): { boundary: Loop; holes: Loop[] } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
  }
}
function run(fix: number) {
  const warn = console.warn
  console.warn = () => {}
  try { return processFeature(loadGt(fix), CORPUS) } finally { console.warn = warn }
}
const plen = (pts: Pt[]): number => {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return L
}
/** Replay the emitted path the way the WO-1087 census does it -- sweep each pass at the tool
 *  radius, intersect with target-minus-cleared, divide by length -- and return the two load
 *  numbers WO-1103's acceptance is written in: the widest effective cut, and the total length
 *  of roughing cut moves. Identical arithmetic to `_wo1103-bar-measure.test.ts`, which is what
 *  wrote the committed before/after evidence. */
function replay(res: ReturnType<typeof processFeature>): { widestCut: number; cutLength: number } {
  const target: Loops = offsetClosed(res.cutRegion, TR, ARC_TOL)
  let cleared: Loops = []
  for (const e of res.entries) if (e.radius > 0) cleared = union(cleared, diskPath(e.point, e.radius + TR, ARC_TOL))
  let worst = 0
  let cutLength = 0
  for (const p of res.passes) {
    if (p.type !== 'cut' && p.type !== 'wallfollow' && p.type !== 'lead') continue
    if (p.points.length < 2) continue
    const L = plen(p.points)
    if (L < 1e-9) continue
    const sweep = offsetOpenRound(p.points, TR, ARC_TOL)
    if (!sweep.length) continue
    const uncut = difference(target, cleared)
    const bite = uncut.length ? intersection(sweep, uncut) : []
    if (p.type === 'cut') {
      // WO-1178: the engine's own sustained-load measure (rideOverloadsUncut / contourOverCap)
      // keeps a 2 mm denominator for any window shorter than 2 mm. A per-pass average over a
      // sub-millimetre corner crumb divides its first crescent by half a millimetre (2.03
      // mm2/mm on a 0.52 mm pass at the bottom-left corner) and says nothing about the load the
      // steering holds; the same clamp here keeps this pin denominated as the engine is.
      const w = bite.length ? Math.abs(netArea(bite)) / Math.max(L, 2.0) : 0
      if (w > worst) worst = w
      cutLength += L
    }
    cleared = union(cleared, sweep)
  }
  return { widestCut: worst, cutLength }
}

/** Bar's roughing cut length on `main`, i.e. the path with the centroid entry and the retract:
 *  1103.60 mm, committed in `src/tests/evidence/WO-1103/before-bar.json`. WO-1103's acceptance
 *  is "total cut length not longer than today's", so this is a ceiling, not a pin. */
// WO-1178 re-pin, 1103.60 -> 1260: the rings now ride the walls they touch (into the corners and
// along the thin rim), so wall stretches that used to be ridden by ungated cusp and gap-fill
// rides are cut inside the passes -- measured 1252.37 mm of cut against the 1103.60 the centroid
// entry spent, while the Bar's wall-ride length fell 277.2 -> 253.6 mm and it roughs with zero
// retracts (src/tests/evidence/WO-1178/corpus/). A ceiling, so a shorter path never fails this.
const CUT_LENGTH_BEFORE_MM = 1260

describe('WO-1103 channel entry', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('Bar enters near one end of the channel and never retracts', () => {
    const res = run(4)
    expect(res.stats.aborted ?? null).toBeNull()

    // ONE entry, and it is a helix (nothing here may turn Bar into a plunge).
    expect(res.entries.length).toBe(1)
    expect(res.entries[0].mode).toBe('helix')

    // Where it is. cutRegion is x[122.03, 143.33] y[-73.28, -10.44]: the channel runs in y,
    // and the old entry sat at the centroid, y = -41.86. The new one must be up at the +y
    // end -- within ONE stepover of Fusion's own (132.68, -21.16), which is the order's own
    // criterion, and where the saturating disk stops being able to strand work behind the
    // walk. Measured: (132.68, -19.81), 1.35 mm out of the 1.60 mm allowance.
    const entry = res.entries[0].point
    expect(entry.x).toBeCloseTo(132.68, 1)
    expect(Math.hypot(entry.x - 132.68, entry.y - -21.16)).toBeLessThanOrEqual(STEP_OVER_MM)
    // and unambiguously NOT the middle any more.
    expect(Math.abs(entry.y - -41.86)).toBeGreaterThan(20)

    // THE POINT OF THE ORDER: the roughing pass leaves the floor zero times. jumpType 2 is
    // the lift; jumpType 1 is a keep-down link and is not one.
    const lifts = res.passes.filter(p => p.type === 'link' && p.jumpType === 2) as Extract<AdaptivePass, { type: 'link' }>[]
    expect(lifts.map(l => `${l.points[0].x.toFixed(2)},${l.points[0].y.toFixed(2)}`)).toEqual([])

    // No entry other than the first descends: one helix, no lift-landing helix, no re-seed.
    expect(res.passes.filter(p => p.type === 'entry').length).toBe(1)

    // Load: the widest roughing cut stays at or under the setpoint the steering holds, and
    // the relocation is not paid for in travel -- the order's "total cut length not longer
    // than today's". Measured: widest 1.4604 mm2/mm, cut length 1094.70 mm against the 1103.60
    // mm the centroid entry spent. Both are ceilings, so an improvement never fails this.
    const setpoint = createToolGeometry(TR, CORPUS.stepOver, ARC_TOL).optimalCutAreaPerDist
    expect(setpoint).toBeCloseTo(1.573, 3)
    const { widestCut, cutLength } = replay(res)
    expect(widestCut).toBeLessThanOrEqual(setpoint)
    expect(cutLength).toBeLessThanOrEqual(CUT_LENGTH_BEFORE_MM)

    // ...and the shorter path is NOT bought by roughing less. `residualArea` alone cannot tell
    // the two apart: it rises 14.945 -> 19.320 mm2 here, but every one of those extra mm2 is
    // FINISH-BAND stock (11.305 -> 15.680), which is what `wallFinish: true` deliberately
    // leaves for the finish pass. What the WALKER skipped is unchanged to three decimals --
    // 3.639 mm2, largest leftover circle 0.350 mm, identical to main. These two are the guard
    // on the cut-length ceiling above: without them a future change could satisfy it by
    // abandoning stock. Ceilings, so removing more material never fails this.
    // WO-1178 attempt 3 re-pin (3.64 -> 4.10): with tangent wall joins the last corner nibble
    // ends a fraction of a millimetre further from each apex (measured 4.078 mm2; the four
    // corner squares, nothing else -- every wall strip is finish-band stock and is in the
    // FINISH-BAND number). Residual after the wall stack is unchanged at 0.023 mm2
    // (src/tests/evidence/WO-1178/census.md).
    expect(res.stats.residualWalkerArea).toBeLessThanOrEqual(4.1)
    expect(res.stats.residualMaxInscribedR).toBeLessThanOrEqual(0.35)

    // Cut count against Fusion's 38 on the same part (gt-census.md). WO-1178 re-pin, 41 -> 46:
    // the rings now nibble each corner progressively (four short arcs into every corner, as
    // Fusion's own recording does at its top corners) instead of leaving a triangle for the
    // wall rides; measured 44 at these settings (src/tests/evidence/WO-1178/_probe).
    const cuts = res.passes.filter(p => p.type === 'cut').length
    expect(cuts).toBeGreaterThanOrEqual(35)
    expect(cuts).toBeLessThanOrEqual(46)
  }, 300000)

  it('declines a bent pocket: Boomerang keeps its deepest-point entry', () => {
    // Boomerang's saturated disk strands work too, but its two stranded lobes point 100 deg
    // apart (dot -0.20), so entering at one "end" would only move the seam. The rule must
    // read that and leave the entry alone -- this is the guard on the whole other eight.
    const res = run(8)
    expect(res.entries.length).toBeGreaterThanOrEqual(1)
    expect(res.entries[0].point.x).toBeCloseTo(-93.45, 1)
    expect(res.entries[0].point.y).toBeCloseTo(121.67, 1)
  }, 300000)
})
