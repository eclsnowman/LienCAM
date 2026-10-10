// WO-1178 item 0 (WO-1141B): THE ROUTED KEEP-DOWN LANDING'S ENGAGEMENT BOUND, EXECUTED.
//
// The order fired because WO-1141B "met" its cap twice without measuring it, and the audit
// of attempt 3 found the same hole again: the all-gouge admission rung in planGatedLanding
// (`airCandidates > 0`, cap = the configured radial engagement, measured on the windowed peak
// with the sentinel bypassed AND on the deepest sub-step) had no executing test anywhere in
// the suite, because no corpus shape lifts onto a landing that needs the rung any more.
//
// So this is the rung's OWN fixture, driven through the exported gate with a stock state that
// reaches the rung by construction, not by luck:
//
//   - a cleared pocket (the blob), a narrow slot leaving it, and a leg turning +y off the
//     slot's far end. The landing is in the slot at the foot of the leg and the next cut heads
//     up the leg -- the chord in along the slot is PERPENDICULAR to the cut's tangent;
//   - the landing disk stands in stock (over the 5% landing cap) because the slot was only
//     part-cleared by an earlier operation: a band the caller's belief carries and no prior
//     motion vertex sits on (the 3D rougher's live stock and a `clearedSeed` both do this);
//   - every prior-motion vertex and the source sit far up the pocket, so every straight or
//     curved tangent lead the shaft rungs build crosses the slot's wall (all-gouge, zero
//     overloaded), and the WO-1091 clear-air rung's tangent leads all gouge too;
//   - whole-cutter-clear air stands in the blob right at the slot's mouth, so the routed rung
//     traverses it and measures the direct chord into the landing.
//
// Case 1 admits the chord at a measured 0.5 mm2/mm bite; case 2 leaves 2.2 mm of stock
// against the same chord -- under the 0.75-slot ceiling (3.0) the old rung would have taken
// it, under the configured engagement (1.6) the helix stays and the console names the bound.
// Every bite is recomputed here with contourOverCap against the physical stock, sentinel
// bypassed, independently of the number the gate printed.
//
// Run: npx vitest run src/tests/adaptive-clearing/engine/wo1178-routed-landing-bound.test.ts

import { describe, it, expect, beforeAll } from 'vitest'
import {
  ensureEngineClipperReady, offsetClosedTree, offsetOpenRound, union, difference, diskPath, totalArea,
  type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  planGatedLanding, contourOverCap,
  type AdaptivePass, type LandingGateContext,
} from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const R = 2
const STEP_OVER = 0.4
const STEP_OVER_DISTANCE = 2 * R * STEP_OVER // 1.6 mm: the configured radial engagement
const SIDE_LANDING_CAP = 0.75 * 2 * R // 3.0 mm2/mm: the 0.75-slot ceiling the overload case keeps
const ARC_TOL = 0.025
const HELIX_RADIUS = 1.9
const LANDING_UNCUT_CAP = 0.05

const rect = (x0: number, x1: number, y0: number, y1: number): Loop =>
  [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }]

/** Tool-centre region: blob + slot + leg. The slot is 1.0 mm of tool-centre room (a 5.0 mm
 *  physical slot for the 4 mm cutter with 0.5 mm radial stock), the leg the same. */
function buildRegion(): Loops {
  const blob = rect(0, 20, -10, 10)
  const slot = rect(20, 30, -0.5, 0.5)
  const leg = rect(27.5, 28.5, 0.5, 8)
  return union(union([blob], [slot]), [leg])
}

/** Physical stock state: the blob cleared to the cutter's edge, plus the slot band an earlier
 *  operation removed, whose top edge leaves `stockAbove` mm of stock against a lead running
 *  along the slot's axis (the cutter spans y in [-2, 2] there). */
function buildCleared(stockAbove: number): Loops {
  const blobCleared = rect(-2, 22, -12, 12)
  const band = rect(18, 32, -2.5, 2 - stockAbove)
  return union([blobCleared], [band])
}

/** Prior motion: an entry and three cuts far up the pocket. Every vertex is >= 6 mm off the
 *  slot's axis so no straight line from any of them reaches the landing inside the slot. */
function buildPasses(): AdaptivePass[] {
  const along = (y: number, x0: number, x1: number): Pt[] => {
    const pts: Pt[] = []
    const n = Math.abs(x1 - x0) / 2
    for (let i = 0; i <= n; i++) pts.push({ x: x0 + (x1 - x0) * i / n, y })
    return pts
  }
  return [
    { type: 'entry', point: { x: 8, y: 6 }, radius: HELIX_RADIUS, mode: 'helix' },
    { type: 'cut', points: along(6, 4, 16) },
    { type: 'cut', points: along(-8, 16, 4) },
    { type: 'cut', points: along(8, 16, 4) },
  ]
}

const SOURCE: Pt = { x: 4, y: 8 } // where the last cut ended: the tool's position now
const LANDING: Pt = { x: 28, y: 0 }
const NEXT_CUT: Pt[] = [0, 1, 2, 3, 4, 5, 6, 7].map(k => ({ x: 28, y: k }))

function gate(stockAbove: number): { plan: ReturnType<typeof planGatedLanding>; warnings: string[]; ctx: LandingGateContext } {
  const cutRegion = buildRegion()
  const ctx: LandingGateContext = {
    passes: buildPasses(),
    clearedBeforePass: buildCleared(stockAbove),
    cutRegion,
    cutTree: offsetClosedTree(cutRegion, 0, ARC_TOL),
    toolRadius: R,
    helixRadius: HELIX_RADIUS,
    stepOverDistance: STEP_OVER_DISTANCE,
    arcTol: ARC_TOL,
    landingUncutCap: LANDING_UNCUT_CAP,
    millingDirection: 'climb',
    points: NEXT_CUT,
    boundarySpan: null,
    allowReseam: true,
  }
  const warnings: string[] = []
  const warn = console.warn
  console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
  let plan: ReturnType<typeof planGatedLanding>
  try { plan = planGatedLanding(ctx, SOURCE, LANDING, NEXT_CUT[1]) } finally { console.warn = warn }
  return { plan, warnings, ctx }
}

const uncutFraction = (p: Pt, cleared: Loops): number => {
  const disk = diskPath(p, R, ARC_TOL)
  return totalArea(difference(disk, cleared)) / totalArea(disk)
}

const STAYING_DOWN = /\((\d+) gouged, (\d+) overloaded\) -- STAYING DOWN via (\S+): .* measuring ([\d.]+)mm2\/mm over the window and ([\d.]+)mm2\/mm at its deepest sub-step, both <= the ([\d.]+)mm2\/mm (configured radial engagement|0\.75-slot ceiling)/

describe('WO-1178 item 0: the routed keep-down landing is measured against the configured engagement', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('the fixture reaches the rung: the landing is over the cap, every tangent lead gouges, none is merely overloaded', () => {
    const { plan, warnings, ctx } = gate(0.5)
    // The landing disk stands in stock, so the gate had to decide something.
    expect(uncutFraction(LANDING, ctx.clearedBeforePass)).toBeGreaterThan(LANDING_UNCUT_CAP)
    // No shaft rung and no re-seam took it: those all print 'descending at proven-cleared'.
    expect(warnings.filter(w => w.includes('descending at proven-cleared'))).toEqual([])
    // The routed rung took it, after an ALL-GOUGE tangent verdict (the widened admission).
    const line = warnings.find(w => w.includes('STAYING DOWN via'))
    expect(line, warnings.join('\n')).toBeDefined()
    console.log(`[wo1178] ${line}`)
    const m = line!.match(STAYING_DOWN)
    expect(m, line).not.toBeNull()
    expect(Number(m![1]), 'tangent leads that left the region').toBeGreaterThan(0)
    expect(Number(m![2]), 'tangent leads refused on load alone').toBe(0)
    expect(m![7]).toBe('configured radial engagement')
    expect(Number(m![6])).toBeCloseTo(STEP_OVER_DISTANCE, 6)
    expect(plan.keepDownApproach).toBeDefined()
    expect(plan.helix).toBeUndefined()
    expect(plan.lead).toBeUndefined()
  })

  it('ADMITTED: the fed engage is under the configured engagement on the windowed peak and the deepest sub-step, measured on the physical stock', () => {
    const { plan, warnings, ctx } = gate(0.5)
    const approach = plan.keepDownApproach!
    expect(approach).toBeDefined()
    // 1. The traverse is through whole-cutter-clear stock: no material under it beyond the
    //    gate's own clear-air proof (SIDE_RESEED_CLEAR_UNCUT_MAX: 0.5% of the cutter disk,
    //    the faceting allowance a "whole cutter in air" point is held to).
    const clearAirAllowance = 0.005 * Math.PI * R * R
    const travelUncut = totalArea(difference(offsetOpenRound(approach.travel, R, ARC_TOL), ctx.clearedBeforePass))
    expect(travelUncut, 'mm2 of stock under the traverse').toBeLessThan(clearAirAllowance)
    // The departure (the fed disengage off the frontier, when the splitter emits one) runs
    // through the cleared pocket too: the ONLY material this approach removes is in the lead.
    if (approach.departure) {
      const departureUncut = totalArea(difference(offsetOpenRound(approach.departure, R, ARC_TOL), ctx.clearedBeforePass))
      expect(departureUncut, 'mm2 of stock under the departure').toBeLessThan(clearAirAllowance)
    }
    // 2. The lead ends on the requested landing and really cuts.
    const last = approach.lead[approach.lead.length - 1]
    expect(last.x).toBeCloseTo(LANDING.x, 9)
    expect(last.y).toBeCloseTo(LANDING.y, 9)
    const load = contourOverCap(approach.lead, ctx.clearedBeforePass, R, STEP_OVER_DISTANCE, ARC_TOL, true)
    expect(load.maxStep, 'deepest sub-step bite really cuts').toBeGreaterThan(0.3)
    // 3. THE BOUND: both measures under the configured engagement, sentinel bypassed.
    expect(load.overLen).toBe(0)
    expect(load.peak).toBeLessThanOrEqual(STEP_OVER_DISTANCE + 1e-6)
    expect(load.maxStep).toBeLessThanOrEqual(STEP_OVER_DISTANCE + 1e-6)
    // 4. The console's numbers ARE the measurement, not a printed promise.
    const m = warnings.find(w => w.includes('STAYING DOWN via'))!.match(STAYING_DOWN)!
    expect(Number(m![4])).toBeCloseTo(load.peak, 2)
    expect(Number(m![5])).toBeCloseTo(load.maxStep, 2)
    // 5. The plan's own landing is the requested one (the approach reaches it; the caller
    //    stamps the traverse + lead on the link).
    expect(plan.landing.x).toBeCloseTo(LANDING.x, 9)
    expect(plan.landing.y).toBeCloseTo(LANDING.y, 9)
    console.log(`[wo1178] routed landing admitted: ${approach.family}, lead ${approach.lead.length} pts, peak ${load.peak.toFixed(3)}, max sub-step ${load.maxStep.toFixed(3)} <= ${STEP_OVER_DISTANCE.toFixed(2)}`)
  })

  it('REFUSED: a chord that the 0.75-slot ceiling would admit is refused under the configured engagement, the helix stays, and the console names the bound', () => {
    const { plan, warnings, ctx } = gate(2.2)
    // The same fixture, all-gouge again -- so the bound in force is the configured engagement.
    expect(warnings.filter(w => w.includes('descending at proven-cleared'))).toEqual([])
    expect(warnings.filter(w => w.includes('STAYING DOWN via'))).toEqual([])
    expect(plan.keepDownApproach).toBeUndefined()
    expect(plan.lead).toBeUndefined()
    expect(plan.helix, 'the helix stays').toBeDefined()
    // The direct chord from the clear air at the slot's mouth to the landing, measured here:
    // over the configured engagement, under the slot ceiling. This is exactly the lead the
    // audited WO-1141B attempt would have admitted.
    const mouth = { x: 20 - R - ARC_TOL, y: 0 }
    expect(uncutFraction(mouth, ctx.clearedBeforePass)).toBeLessThan(0.005)
    const chord = contourOverCap([mouth, LANDING], ctx.clearedBeforePass, R, STEP_OVER_DISTANCE, ARC_TOL, true)
    expect(chord.maxStep).toBeGreaterThan(STEP_OVER_DISTANCE)
    expect(chord.peak).toBeGreaterThan(STEP_OVER_DISTANCE)
    expect(chord.peak).toBeLessThan(SIDE_LANDING_CAP)
    expect(chord.maxStep).toBeLessThan(SIDE_LANDING_CAP)
    // The helix line names what refused the keep-down: the configured engagement, by number.
    const helixLine = warnings.find(w => w.includes('descending via HELIX'))
    expect(helixLine, warnings.join('\n')).toBeDefined()
    console.log(`[wo1178] chord bite peak ${chord.peak.toFixed(3)} / sub-step ${chord.maxStep.toFixed(3)} (slot ceiling ${SIDE_LANDING_CAP.toFixed(2)}, engagement ${STEP_OVER_DISTANCE.toFixed(2)})\n[wo1178] ${helixLine}`)
    expect(helixLine).toMatch(/(\d+) routed keep-down lead\(s\) measured over the 1\.60mm2\/mm configured radial engagement/)
    expect(Number(helixLine!.match(/(\d+) routed keep-down lead\(s\)/)![1])).toBeGreaterThan(0)
    expect(helixLine).toMatch(/\d+ left cutRegion \(would gouge the finish wall\) and 0 exceeded/)
  })
})
