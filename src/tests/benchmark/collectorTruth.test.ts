// WO-1217 attempt 2 -- THE COLLECTORS ARE TESTED AGAINST CLOSED-FORM TRUTH.
//
// The lane's first attempt shipped nine passing tests while two metrics were
// wrong, which means the suite tested the plumbing and never the numbers. This
// file is the missing half: every assertion here compares a collector's output
// with a value computed by hand from the geometry, and every one of them is
// arranged so that the specific defect the audit found FAILS it.
//
// Nothing here plans a toolpath. These are hand-built move lists, which Rule 6
// calls a CONTROL and never application truth -- that is exactly the right thing
// for a unit test of a measuring instrument, and the application truth lives in
// smoke.test.ts, which drives `computeOperationToolpath`.

import { describe, expect, it } from 'vitest'

import { measurePathEngagement } from '../../cam3d/rough'
import { SIDE_ENTRY_ENGAGEMENT_CAP } from '../../cam3d/strategies/adaptiveRough'
import { ZDexelField, type Box3 } from '../../cam3d/stock'
import type { CutterSpec, PartMesh } from '../../cam3d/kernel/types'
import {
  MOVE_MOTION_BY_ROLE,
  isStockCuttingRole,
  moveMotionForRole,
  type MoveMotion,
} from '../../lib/cam/stockCuttingRoles'
import type { MoveRole, ToolpathMove } from '../../types'

import { CHAINS } from './registry'
import {
  carveCoverage,
  measureRadialEngagement,
  pathMetrics,
  samplePath,
  surfaceMetrics,
  toIrMoves,
} from './metrics'
import {
  assertRowComplete,
  notApplicable,
  requireMetricNumber,
  specFor,
  REQUIRED_ROW_METRICS,
  type MetricValue,
} from './metricRegistry'

/** Stock block the synthetic paths run in: 60 x 60 x 5, top face at z = 0. */
const STOCK: Box3 = { minX: -30, minY: -30, minZ: -5, maxX: 30, maxY: 30, maxZ: 0 }

/** 6 mm flat cutter -- r = 3, so its full-slot cross-section is exactly D x depth. */
const CUTTER: CutterSpec = { kind: 'flat', diameter: 6 }
const CUTTER_RADIUS_MM = 3

/** Arc the test sweeps: a quarter circle of this radius about the origin. */
const ARC_RADIUS_MM = 10
/** Axial depth of the sweep below the stock top, mm. */
const CUT_DEPTH_MM = 1.25
/**
 * Coverage grid, mm. Fine enough that the column quantisation error is far
 * smaller than the arc-versus-chord difference the test is there to catch.
 */
const COVERAGE_CELL_MM = 0.1

/**
 * Volume a flat cutter of radius r removes sweeping a CIRCULAR ARC of radius R
 * through angle theta at a constant depth d below a flat stock top, mm^3.
 *
 * The swept footprint is the annulus sector between R-r and R+r over theta, plus
 * one half-disc at each end: a disc of radius r centred at distance R from the
 * origin lies wholly inside that annulus (every point is within r of R), and the
 * radial line through its centre bisects it exactly, so the part outside the
 * sector is precisely half a disc at each end.
 *
 *   area = (theta/2) * ((R+r)^2 - (R-r)^2) + pi*r^2 = 2*theta*R*r + pi*r^2
 */
function arcSweptVolumeMm3(R: number, r: number, theta: number, d: number): number {
  return d * (2 * theta * R * r + Math.PI * r * r)
}

/** The same for a STRAIGHT sweep of length L: a rectangle plus the two half-discs. */
function straightSweptVolumeMm3(L: number, r: number, d: number): number {
  return d * (2 * r * L + Math.PI * r * r)
}

/** A field over STOCK at the coverage cell, plus a surface far below it (nothing standing). */
function freshCoverage(): { field: ZDexelField; surfaceZ: Float64Array } {
  const field = ZDexelField.fromBox(STOCK, COVERAGE_CELL_MM)
  const surfaceZ = new Float64Array(field.top.length).fill(STOCK.minZ)
  return { field, surfaceZ }
}

/**
 * A flat plate filling the stock footprint with its face at z = 0: two
 * triangles, so a drop anywhere over it contacts at exactly 0 and the margin a
 * sample reports IS its own z. No fixture is needed to state that.
 */
function flatPlate(): PartMesh {
  return {
    positions: new Float32Array([
      STOCK.minX, STOCK.minY, 0,
      STOCK.maxX, STOCK.minY, 0,
      STOCK.maxX, STOCK.maxY, 0,
      STOCK.minX, STOCK.maxY, 0,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    bounds: { min: [STOCK.minX, STOCK.minY, 0], max: [STOCK.maxX, STOCK.maxY, 0] },
    source: 'fixture',
  }
}

/**
 * Position the tool at the arc start WITHOUT cutting, so the measurement isolates
 * the arc. A rapid is not a stock-cutting role, so it advances the cursor and
 * removes nothing -- which is the shared `isStockCuttingRole` authority the
 * collector now uses, and it is worth proving on the way past.
 */
function parkAt(x: number, y: number, z: number): ToolpathMove {
  return { type: 'rapid', role: 'rapid', x, y, z }
}

describe('WO-1217 coverage collector: an arc is measured as an arc', () => {
  it('matches the closed-form swept volume of a quarter circle', () => {
    const { field, surfaceZ } = freshCoverage()
    // Quarter circle counter-clockwise from (R, 0) to (0, R) about the origin.
    const moves: ToolpathMove[] = [
      parkAt(ARC_RADIUS_MM, 0, -CUT_DEPTH_MM),
      { type: 'arc_ccw', role: 'cut', x: 0, y: ARC_RADIUS_MM, z: -CUT_DEPTH_MM, cx: 0, cy: 0 },
    ]
    const measured = carveCoverage({ field, surfaceZ, cutter: CUTTER, moves }).removedVolumeMm3
    const truth = arcSweptVolumeMm3(ARC_RADIUS_MM, CUTTER_RADIUS_MM, Math.PI / 2, CUT_DEPTH_MM)

    // Quantisation bound, stated rather than tuned: a z-dexel field decides each
    // column by its centre, so the error lives in the one-cell-wide band along the
    // footprint's boundary. Perimeter x cell x depth is a generous ceiling on it.
    const perimeterMm =
      (Math.PI / 2) * (ARC_RADIUS_MM + CUTTER_RADIUS_MM) +
      (Math.PI / 2) * (ARC_RADIUS_MM - CUTTER_RADIUS_MM) +
      2 * Math.PI * CUTTER_RADIUS_MM
    const quantisationBoundMm3 = perimeterMm * COVERAGE_CELL_MM * CUT_DEPTH_MM

    expect(Math.abs(measured - truth)).toBeLessThan(quantisationBoundMm3)
    console.log(
      `[WO-1217] arc coverage: measured ${measured.toFixed(3)} mm3, closed form ${truth.toFixed(3)} mm3, ` +
        `error ${(measured - truth).toFixed(3)} mm3 inside the ${quantisationBoundMm3.toFixed(3)} mm3 grid bound`,
    )
  })

  it('and would NOT match it if the arc were replayed as its endpoint chord', () => {
    // The defect the audit measured, reproduced: the SAME start and end points,
    // emitted as a straight feed instead of an arc. If the collector ever loses
    // its arc handling again, the test above starts reporting this number.
    const { field, surfaceZ } = freshCoverage()
    const chordMoves: ToolpathMove[] = [
      parkAt(ARC_RADIUS_MM, 0, -CUT_DEPTH_MM),
      { type: 'feed', role: 'cut', x: 0, y: ARC_RADIUS_MM, z: -CUT_DEPTH_MM },
    ]
    const chord = carveCoverage({ field, surfaceZ, cutter: CUTTER, moves: chordMoves }).removedVolumeMm3
    const arcTruth = arcSweptVolumeMm3(ARC_RADIUS_MM, CUTTER_RADIUS_MM, Math.PI / 2, CUT_DEPTH_MM)
    const chordTruth = straightSweptVolumeMm3(
      Math.SQRT2 * ARC_RADIUS_MM,
      CUTTER_RADIUS_MM,
      CUT_DEPTH_MM,
    )

    // The chord replay is right about the chord and therefore wrong about the arc.
    expect(Math.abs(chord - chordTruth)).toBeLessThan(2)
    const underReadPct = ((arcTruth - chord) / arcTruth) * 100
    expect(underReadPct).toBeGreaterThan(5)
    console.log(
      `[WO-1217] chord control: ${chord.toFixed(3)} mm3 against the arc's ${arcTruth.toFixed(3)} mm3 -- ` +
        `an ${underReadPct.toFixed(1)}% under-read. The smoke rough paths are 28% arc moves.`,
    )
  })

  it('carves nothing for a move whose role does not cut stock', () => {
    // The teeth under "a rapid advances the cursor": if rapids carved, the arc
    // measurement above would be measuring the positioning move too.
    const { field, surfaceZ } = freshCoverage()
    const moves: ToolpathMove[] = [
      parkAt(-20, -20, -CUT_DEPTH_MM),
      parkAt(20, 20, -CUT_DEPTH_MM),
    ]
    expect(carveCoverage({ field, surfaceZ, cutter: CUTTER, moves }).removedVolumeMm3).toBe(0)
  })

  it('refuses an arc with no centre instead of degrading it to a chord', () => {
    const { field, surfaceZ } = freshCoverage()
    const moves: ToolpathMove[] = [
      parkAt(ARC_RADIUS_MM, 0, -CUT_DEPTH_MM),
      { type: 'arc_ccw', role: 'cut', x: 0, y: ARC_RADIUS_MM, z: -CUT_DEPTH_MM },
    ]
    expect(() => carveCoverage({ field, surfaceZ, cutter: CUTTER, moves })).toThrow(/cx\/cy/)
  })
})

describe('WO-1217 engagement collector: the engine measures it, in the engine unit', () => {
  /**
   * A straight full-width slot at a known depth. The cutter takes everything a
   * slot would take, so the sustained engagement is 1.0 of a full slot by
   * definition -- the fixed point the whole normalisation hangs on, and the one
   * an mm^2 cross-section cannot express without knowing the depth.
   */
  const SLOT_LENGTH_MM = 40
  const slotMoves: ToolpathMove[] = [
    parkAt(-SLOT_LENGTH_MM / 2, 0, -CUT_DEPTH_MM),
    { type: 'feed', role: 'cut', x: SLOT_LENGTH_MM / 2, y: 0, z: -CUT_DEPTH_MM },
  ]

  it('reads a full-width slot as a full slot, and a half-width pass as half of one', () => {
    const slot = measureRadialEngagement({
      moves: slotMoves,
      stockBounds: STOCK,
      cellMm: 0.25,
      cutter: CUTTER,
      capFraction: 0.75,
    })
    // Slightly over 1.0 is expected and documented: the entry and exit discs at the
    // ends of a move take more than the straight run and amortise away with length.
    expect(slot.peakEngagementFraction).toBeGreaterThan(0.95)
    expect(slot.peakEngagementFraction).toBeLessThan(1.15)
    expect(slot.measuredCuttingLengthMm).toBeCloseTo(SLOT_LENGTH_MM, 1)

    // Now cut a second pass alongside the first, offset by the cutter radius: half
    // the cutter runs in the groove it just made, so only half its width is in
    // fresh material. It is emitted as eight short segments rather than one long
    // move so the sliding window really slides -- one move is one window, and a
    // single-window path would not exercise the averaging at all.
    const twoPasses: ToolpathMove[] = [...slotMoves]
    twoPasses.push(parkAt(SLOT_LENGTH_MM / 2, CUTTER_RADIUS_MM, -CUT_DEPTH_MM))
    const SEGMENTS = 8
    for (let index = 1; index <= SEGMENTS; index++) {
      twoPasses.push({
        type: 'feed', role: 'cut',
        x: SLOT_LENGTH_MM / 2 - (SLOT_LENGTH_MM * index) / SEGMENTS,
        y: CUTTER_RADIUS_MM,
        z: -CUT_DEPTH_MM,
      })
    }
    const windows: number[] = []
    measurePathEngagement(toIrMoves(twoPasses), STOCK, 0.25, CUTTER, {
      capFraction: 1e-12,
      onOverCap: (hit) => {
        if (hit.y > 1) windows.push(hit.fraction)
      },
    })
    expect(windows.length).toBe(SEGMENTS)
    const secondPassPeak = Math.max(...windows)
    expect(secondPassPeak).toBeGreaterThan(0.4)
    expect(secondPassPeak).toBeLessThan(0.62)
    console.log(
      `[WO-1217] engagement unit: full slot ${slot.peakEngagementFraction.toFixed(3)} of a slot, ` +
        `a half-width second pass ${secondPassPeak.toFixed(3)}`,
    )
  })

  it('is NOT the axial-depth-dependent cross-section the audit rejected', () => {
    // The same radial bite at two different axial depths. A radial engagement
    // fraction must read the SAME on both; an mm^2 cross-section reads double.
    // This is the audit's finding, expressed as a test.
    const deep: ToolpathMove[] = [
      parkAt(-SLOT_LENGTH_MM / 2, 0, -2 * CUT_DEPTH_MM),
      { type: 'feed', role: 'cut', x: SLOT_LENGTH_MM / 2, y: 0, z: -2 * CUT_DEPTH_MM },
    ]
    const shallow = measureRadialEngagement({
      moves: slotMoves, stockBounds: STOCK, cellMm: 0.25, cutter: CUTTER, capFraction: 0.75,
    })
    const deeper = measureRadialEngagement({
      moves: deep, stockBounds: STOCK, cellMm: 0.25, cutter: CUTTER, capFraction: 0.75,
    })
    expect(deeper.peakEngagementFraction).toBeCloseTo(shallow.peakEngagementFraction, 2)
    console.log(
      `[WO-1217] depth independence: ${CUT_DEPTH_MM} mm deep reads ` +
        `${shallow.peakEngagementFraction.toFixed(4)}, ${2 * CUT_DEPTH_MM} mm deep reads ` +
        `${deeper.peakEngagementFraction.toFixed(4)} -- a cross-section in mm^2 would have doubled`,
    )
  })

  it('accounts over-cap length exactly as the engine does', () => {
    // The wrapper enumerates every window with a near-zero accounting threshold and
    // applies the real cap itself, so the P95 can be length-weighted over the whole
    // distribution. This pins that arithmetic against the engine's own answer: same
    // path, same cap, same over-cap length, or the enumeration trick is not sound.
    // The cap sits between the two engagements this path contains -- the first
    // pass slots at ~1.0 and the two stepped-over passes take ~0.5 -- so the
    // over-cap length is a genuine subset and the comparison has something to
    // disagree about.
    const CAP = 0.75
    const steppedPasses: ToolpathMove[] = [
      ...slotMoves,
      parkAt(SLOT_LENGTH_MM / 2, CUTTER_RADIUS_MM, -CUT_DEPTH_MM),
      { type: 'feed', role: 'cut', x: -SLOT_LENGTH_MM / 2, y: CUTTER_RADIUS_MM, z: -CUT_DEPTH_MM },
      parkAt(-SLOT_LENGTH_MM / 2, 2 * CUTTER_RADIUS_MM, -CUT_DEPTH_MM),
      { type: 'feed', role: 'cut', x: SLOT_LENGTH_MM / 2, y: 2 * CUTTER_RADIUS_MM, z: -CUT_DEPTH_MM },
    ]
    const wrapper = measureRadialEngagement({
      moves: steppedPasses, stockBounds: STOCK, cellMm: 0.25, cutter: CUTTER, capFraction: CAP,
    })
    const engine = measurePathEngagement(toIrMoves(steppedPasses), STOCK, 0.25, CUTTER, {
      capFraction: CAP,
    })
    expect(wrapper.engagementOverCapLengthMm).toBeCloseTo(engine.overCapLengthMm, 9)
    expect(wrapper.peakEngagementFraction).toBeCloseTo(engine.peakFraction, 9)
    expect(wrapper.measuredCuttingLengthMm).toBeCloseTo(engine.cuttingLengthMm, 9)
    // And the over-cap length is a real fraction of the path, not 0 or all of it --
    // a check that agrees trivially proves nothing.
    expect(wrapper.engagementOverCapPct).toBeGreaterThan(1)
    expect(wrapper.engagementOverCapPct).toBeLessThan(99)
    // The percentile sits inside the distribution it summarises.
    expect(wrapper.p95EngagementFraction).toBeGreaterThan(0)
    expect(wrapper.p95EngagementFraction).toBeLessThanOrEqual(wrapper.peakEngagementFraction)
    console.log(
      `[WO-1217] cap accounting: ${wrapper.engagementOverCapLengthMm.toFixed(3)} mm of ` +
        `${wrapper.measuredCuttingLengthMm.toFixed(3)} mm over a ${CAP} cap ` +
        `(${wrapper.engagementOverCapPct.toFixed(1)}%), engine says ` +
        `${engine.overCapLengthMm.toFixed(3)} mm; peak ${wrapper.peakEngagementFraction.toFixed(3)}, ` +
        `P95 ${wrapper.p95EngagementFraction.toFixed(3)}`,
    )
  })

  it('converts a persisted arc to IR without losing its centre', () => {
    // The other half of the arc fix: the engagement measure speaks IR, whose arc
    // centre is an offset from the arc START, while the app persists an absolute
    // one. Getting this backwards is silent -- the arc simply lands somewhere else.
    const ir = toIrMoves([
      parkAt(ARC_RADIUS_MM, 0, -CUT_DEPTH_MM),
      { type: 'arc_cw', role: 'cut', x: 0, y: ARC_RADIUS_MM, z: -CUT_DEPTH_MM, cx: 0, cy: 0 },
    ])
    expect(ir[1]).toMatchObject({ t: 'arc', cw: true, role: 'cut', i: -ARC_RADIUS_MM, j: 0 })
    expect(() =>
      toIrMoves([{ type: 'arc_cw', role: 'cut', x: 0, y: ARC_RADIUS_MM, z: -CUT_DEPTH_MM, cx: 0, cy: 0 }]),
    ).toThrow(/first move/)
  })
})


describe('WO-1217 stepover control: a stepover CUTS, and the collectors count it', () => {
  // The second audit's blocking finding, expressed as tests. `stepover` is
  // `true` in the application's exhaustive authority
  // (`src/lib/cam/stockCuttingRoles.ts`: "a stepover advances the cutter into
  // fresh stock -- it cuts") and the adaptive emitter emits them throughout a
  // rough. A private cutting set here omitted them, so they fell out of
  // cutMoves, cutLengthMm and -- the part with teeth -- the stock-to-leave
  // assert. Every number below is closed form and every one of them reads
  // differently if the stepover is dropped again.

  const PASS_LENGTH_MM = 40
  const STEPOVER_LENGTH_MM = 6
  const Z = -CUT_DEPTH_MM

  /** Two passes joined by a stepover, all at one depth. */
  const twoPassesWithStepover: ToolpathMove[] = [
    parkAt(-PASS_LENGTH_MM / 2, 0, Z),
    { type: 'feed', role: 'cut', x: PASS_LENGTH_MM / 2, y: 0, z: Z },
    { type: 'feed', role: 'stepover', x: PASS_LENGTH_MM / 2, y: STEPOVER_LENGTH_MM, z: Z },
    { type: 'feed', role: 'cut', x: -PASS_LENGTH_MM / 2, y: STEPOVER_LENGTH_MM, z: Z },
  ]

  it('counts the stepover in cutMoves and cutLengthMm, and ALSO as a feed link', () => {
    const metrics = pathMetrics(twoPassesWithStepover)
    // Three cutting moves, and the stepover's 6 mm is inside the cut length.
    // Dropping it reads 2 moves and 80 mm.
    expect(metrics.cutMoves).toBe(3)
    expect(metrics.cutLengthMm).toBeCloseTo(2 * PASS_LENGTH_MM + STEPOVER_LENGTH_MM, 9)
    // It is a link as well -- both are true, and neither count is a subset of
    // the other. The rapid park is air, not a feed link.
    expect(metrics.feedLinkMoves).toBe(1)
    // ...and it still closes the run between the two passes it joins, at depth:
    // one link, and it kept down. Counting it as a pass instead would report no
    // links at all on an adaptive rough and `keepDownRides` -- the number Operator
    // named as our advantage -- would read 0 forever.
    expect(metrics.links).toBe(1)
    expect(metrics.keepDownRides).toBe(1)
    expect(metrics.liftedLinks).toBe(0)
    console.log(
      `[WO-1217] stepover control: cutMoves ${metrics.cutMoves}, cutLengthMm ` +
        `${metrics.cutLengthMm.toFixed(3)} (${2 * PASS_LENGTH_MM} mm of passes + ` +
        `${STEPOVER_LENGTH_MM} mm of stepover), feedLinkMoves ${metrics.feedLinkMoves}`,
    )
  })

  it('carves the stepover out of the coverage field', () => {
    // The stepover alone, against the closed-form straight sweep. If it were
    // treated as a link the field would come back untouched.
    const { field, surfaceZ } = freshCoverage()
    const stepoverOnly: ToolpathMove[] = [
      parkAt(0, -STEPOVER_LENGTH_MM / 2, Z),
      { type: 'feed', role: 'stepover', x: 0, y: STEPOVER_LENGTH_MM / 2, z: Z },
    ]
    const measured = carveCoverage({ field, surfaceZ, cutter: CUTTER, moves: stepoverOnly })
      .removedVolumeMm3
    const truth = straightSweptVolumeMm3(STEPOVER_LENGTH_MM, CUTTER_RADIUS_MM, CUT_DEPTH_MM)
    const perimeterMm = 2 * STEPOVER_LENGTH_MM + 2 * Math.PI * CUTTER_RADIUS_MM
    const quantisationBoundMm3 = perimeterMm * COVERAGE_CELL_MM * CUT_DEPTH_MM

    expect(measured).toBeGreaterThan(0)
    expect(Math.abs(measured - truth)).toBeLessThan(quantisationBoundMm3)
    console.log(
      `[WO-1217] stepover coverage: measured ${measured.toFixed(3)} mm3, closed form ` +
        `${truth.toFixed(3)} mm3, inside the ${quantisationBoundMm3.toFixed(3)} mm3 grid bound`,
    )
  })

  it('lets a stepover FAIL the stock-to-leave assert without gouging', async () => {
    // The exact hole the audit named: a stepover that leaves less than the
    // required allowance but never breaks the finished surface. Over a flat
    // plate at z = 0, the passes ride 1.0 mm clear and the stepover comes down
    // to 0.1 mm. Nothing gouges. minCutMarginMm must be the stepover's 0.1 --
    // treating it as a link reports 1.0 and the run passes a 0.3 mm
    // stock-to-leave promise it actually broke.
    const PASS_MARGIN_MM = 1.0
    const STEPOVER_MARGIN_MM = 0.1
    const moves: ToolpathMove[] = [
      parkAt(-PASS_LENGTH_MM / 2, 0, PASS_MARGIN_MM),
      { type: 'feed', role: 'cut', x: PASS_LENGTH_MM / 2, y: 0, z: PASS_MARGIN_MM },
      {
        type: 'feed', role: 'stepover',
        x: PASS_LENGTH_MM / 2, y: STEPOVER_LENGTH_MM, z: STEPOVER_MARGIN_MM,
      },
      {
        type: 'feed', role: 'cut',
        x: -PASS_LENGTH_MM / 2, y: STEPOVER_LENGTH_MM, z: PASS_MARGIN_MM,
      },
    ]
    const surface = await surfaceMetrics({
      mesh: flatPlate(),
      cutter: CUTTER,
      samples: samplePath(moves, 0.25),
      shrinkMm: 0.05,
    })
    expect(surface.maxGougeMm).toBe(0)
    expect(surface.minCutMarginMm).toBeCloseTo(STEPOVER_MARGIN_MM, 6)
    // ...and it is NOT filed as link clearance, which is where it used to land.
    expect(surface.minLinkClearanceMm).toBeGreaterThan(STEPOVER_MARGIN_MM)
    console.log(
      `[WO-1217] stock-to-leave teeth: minCutMarginMm ${surface.minCutMarginMm.toFixed(4)} mm ` +
        `(the stepover), minLinkClearanceMm ${surface.minLinkClearanceMm.toFixed(4)} mm, ` +
        `maxGougeMm ${surface.maxGougeMm.toFixed(4)} mm`,
    )
  })

  it('still breaks the flip run at a stepover -- it links two passes', () => {
    // A stepover cuts, but it is the move BETWEEN passes, not steering within
    // one, and WO-1214's reference band was measured over `cut` moves. Two
    // three-segment zigzags joined by a stepover: 2 turns and 1 flip each, so 4
    // and 2. If the stepover joined the runs into one, the two headings across
    // it would be blessed as steering decisions and this reads 6 turns / 5
    // flips instead.
    const zigzag: ToolpathMove[] = [
      parkAt(0, 0, Z),
      { type: 'feed', role: 'cut', x: 10, y: 0, z: Z },
      { type: 'feed', role: 'cut', x: 10, y: 2, z: Z },
      { type: 'feed', role: 'cut', x: 20, y: 2, z: Z },
      { type: 'feed', role: 'stepover', x: 20, y: 8, z: Z },
      { type: 'feed', role: 'cut', x: 30, y: 8, z: Z },
      { type: 'feed', role: 'cut', x: 30, y: 10, z: Z },
      { type: 'feed', role: 'cut', x: 40, y: 10, z: Z },
    ]
    const metrics = pathMetrics(zigzag)
    expect(metrics.turns).toBe(4)
    expect(metrics.flips).toBe(2)
    expect(metrics.flipRatePct).toBeCloseTo(50, 9)
    // And the stepover is still cut length, in the same measurement.
    expect(metrics.cutMoves).toBe(7)
  })
})

// ---------------------------------------------------------------------------

describe('WO-1217 authority coupling: the harness reads production, it does not restate it', () => {
  // The fifth audit round named two seams where this file's neighbours held a
  // SECOND copy of an application fact -- the engagement cap, and the pass /
  // link / air motion table. Both now import from the production declaration.
  // These tests are the behavioural half of that: they fail if the harness ever
  // goes back to answering either question for itself, because they assert the
  // harness's OUTPUT against the production authority rather than against a
  // number written down here.

  it('scores engagement against the cap the strategy itself refuses over', () => {
    // Every registry step that declares a cap declares the strategy's own
    // promise. A hand-typed 0.75 in the registry reads identically today and
    // wrongly the day production moves the cap; this reads the moved value.
    const capped = CHAINS.flatMap((chain) => chain.steps)
      .filter((step) => step.engagementCapFraction !== undefined)
    expect(capped.length).toBeGreaterThan(0)
    for (const step of capped) {
      expect(step.engagementCapFraction).toBe(SIDE_ENTRY_ENGAGEMENT_CAP)
    }

    // ...and the number travels: a full-width slot is over the cap whatever the
    // cap is, and the row echoes the production value for the table to quote.
    const Z = -CUT_DEPTH_MM
    const slot: ToolpathMove[] = [
      parkAt(-20, 0, Z),
      { type: 'feed', role: 'cut', x: 20, y: 0, z: Z },
    ]
    const measured = measureRadialEngagement({
      moves: slot, stockBounds: STOCK, cellMm: 0.25, cutter: CUTTER,
      capFraction: SIDE_ENTRY_ENGAGEMENT_CAP,
    })
    expect(measured.engagementCapFraction).toBe(SIDE_ENTRY_ENGAGEMENT_CAP)
    expect(measured.peakEngagementFraction).toBeGreaterThan(SIDE_ENTRY_ENGAGEMENT_CAP)
    expect(measured.engagementOverCapLengthMm).toBeGreaterThan(0)
    console.log(
      `[WO-1217] cap coupling: ${capped.length} capped step(s) at the strategy's own ` +
        `${SIDE_ENTRY_ENGAGEMENT_CAP}; a full slot measures ` +
        `${measured.peakEngagementFraction.toFixed(3)} and books ` +
        `${measured.engagementOverCapLengthMm.toFixed(2)} mm over it`,
    )
  })

  it('classifies EVERY move role exactly as the production motion table does', () => {
    // One probe move of each role, sitting between two programmed passes at one
    // depth. What the counters do with it is read off the production tables, not
    // off a list written here -- so a role reclassified in
    // `src/lib/cam/stockCuttingRoles.ts` moves these counts with it, and a
    // private table in the harness makes this test go red.
    const Z = -CUT_DEPTH_MM
    const roles = Object.keys(MOVE_MOTION_BY_ROLE) as MoveRole[]
    expect(roles.length).toBeGreaterThan(0)

    const seen: Record<MoveMotion, number> = { pass: 0, link: 0, air: 0 }
    for (const role of roles) {
      const motion = moveMotionForRole(role)
      seen[motion]++
      const probe: ToolpathMove = {
        type: role === 'rapid' ? 'rapid' : 'feed',
        role, x: 20, y: 6, z: Z,
      }
      const metrics = pathMetrics([
        parkAt(0, 0, Z),
        { type: 'feed', role: 'cut', x: 10, y: 0, z: Z },
        probe,
        { type: 'feed', role: 'cut', x: 30, y: 6, z: Z },
      ])

      // A feed-rate link is counted as one, and ONLY a feed-rate link is.
      expect(metrics.feedLinkMoves, `feedLinkMoves for '${role}' (${motion})`)
        .toBe(motion === 'link' ? 1 : 0)
      // Traverse motion that translates in XY is a reposition, and only it is.
      expect(metrics.rapidRepositions, `rapidRepositions for '${role}' (${motion})`)
        .toBe(motion === 'air' ? 1 : 0)
      // A programmed pass joins the run; anything else breaks it into two passes
      // with one link between them, and this probe never rises, so it kept down.
      expect(metrics.links, `links for '${role}' (${motion})`)
        .toBe(motion === 'pass' ? 0 : 1)
      expect(metrics.keepDownRides, `keepDownRides for '${role}' (${motion})`)
        .toBe(motion === 'pass' ? 0 : 1)
      // ...and whether it CUTS is still the other production table's answer,
      // independently: a stepover is a link that cuts, a loop_back is not.
      expect(metrics.cutMoves, `cutMoves for '${role}' (${motion})`)
        .toBe(2 + (isStockCuttingRole(role) ? 1 : 0))
    }

    // The sweep is only worth anything if it actually exercised all three
    // classes; a table that collapsed to one motion would otherwise pass.
    expect(seen.pass).toBeGreaterThan(0)
    expect(seen.link).toBeGreaterThan(0)
    expect(seen.air).toBeGreaterThan(0)
    console.log(
      `[WO-1217] motion coupling: ${roles.length} production roles probed -- ` +
        `${seen.pass} pass, ${seen.link} link, ${seen.air} air`,
    )
  })

  it('refuses a role the production table does not classify', () => {
    // The harness cannot invent a default for a role production has not ruled
    // on -- that is how an unclassified role would silently stop being counted.
    expect(() => moveMotionForRole('teleport')).toThrow(/unknown move role/)
  })
})

// ---------------------------------------------------------------------------

describe('WO-1217 completeness invariant: an absent metric fails LOUDLY', () => {
  // Round 4 of this order's audit found the finish rows carrying no engagement and
  // no region cells. Nothing was red: the baseline encoded the omission and the
  // tests encoded the baseline. These are the teeth -- they prove the guard the
  // chain runner calls actually rejects the shape that shipped.

  /** A complete row: every registry metric present, all of them numbers. */
  function completeRow(): Record<string, MetricValue> {
    return Object.fromEntries(REQUIRED_ROW_METRICS.map((name) => [name, 0]))
  }

  it('accepts a row that carries every registry metric', () => {
    expect(() => assertRowComplete('control/row', completeRow())).not.toThrow()
    expect(REQUIRED_ROW_METRICS.length).toBeGreaterThan(30)
  })

  it('rejects the exact shape that shipped: engagement and region cells simply absent', () => {
    const gapped = completeRow()
    const dropped = [
      'peakEngagementFraction',
      'p95EngagementFraction',
      'engagementCapFraction',
      'engagementOverCapLengthMm',
      'engagementOverCapPct',
      'measuredCuttingLengthMm',
      'levelCount',
      'plannedRegions',
      'machinedRegions',
      'skippedRegions',
      'partialRegions',
    ]
    for (const name of dropped) delete gapped[name]
    // The finish rows carried 27 cells where the rough rows carried 38.
    expect(Object.keys(gapped).length).toBe(REQUIRED_ROW_METRICS.length - dropped.length)
    expect(() => assertRowComplete('finish/row', gapped)).toThrow(/11 registry metric\(s\) absent/)
    for (const name of dropped) {
      expect(() => assertRowComplete('finish/row', gapped)).toThrow(new RegExp(name))
    }
  })

  it('accepts the same row once each absence is declared with a reason', () => {
    const reasoned = completeRow()
    reasoned.peakEngagementFraction = notApplicable(
      'parallel_3d declares no engagement cap and the measure replays from uncut stock.',
    )
    expect(() => assertRowComplete('finish/row', reasoned)).not.toThrow()
    // But `null` on its own is the same silence wearing a different hat, so the
    // constructor refuses to make one without a reason.
    expect(() => notApplicable('   ')).toThrow(/needs a reason/)
  })

  it('rejects a metric nobody registered, rather than scoring it against a guessed band', () => {
    const stowaway = completeRow()
    stowaway.someMetricNobodyRegistered = 1
    expect(() => assertRowComplete('rough/row', stowaway)).toThrow(/not in the registry/)
    expect(() => specFor('someMetricNobodyRegistered')).toThrow(/not in METRIC_SPECS/)
  })

  it('rejects a metric that is present but is not a measurement', () => {
    const broken = completeRow()
    broken.uncutAreaMm2 = Number.NaN
    expect(() => assertRowComplete('rough/row', broken)).toThrow(/not a measurement/)
  })

  it('refuses to SUM a reasoned absence as zero', () => {
    // A chain total that treats "could not measure" as 0 under-reports the chain,
    // which is the same lie in a different place.
    expect(requireMetricNumber('row', 'cutTimeMs', 1234)).toBe(1234)
    expect(() => requireMetricNumber('row', 'cutTimeMs', notApplicable('no feed rate on this op'))).toThrow(
      /must be numeric here/,
    )
  })
})
