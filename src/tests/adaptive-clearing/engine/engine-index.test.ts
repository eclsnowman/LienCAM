import { describe, it, expect, beforeAll, vi } from 'vitest'
import { buildAdaptiveClearingToolpath } from '../../../lib/cam/adaptiveClearing2d/engine'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type FeatureResult } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import type { ACWorkerPayload } from '../../../lib/cam/types'
import type { Tool, ToolpathMove } from '../../../types'

vi.mock('../../../lib/cam/adaptiveClearing2d/engine/processFeature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lib/cam/adaptiveClearing2d/engine/processFeature')>()
  const { typedMock } = await import('../../support/typedMock')
  return typedMock<typeof import('../../../lib/cam/adaptiveClearing2d/engine/processFeature')>({
    ...actual,
    processFeature: vi.fn(actual.processFeature),
  })
})

// A minimal Ø6 tool with default feeds/speeds (only the fields the engine reads).
const tool = {
  id: 't1', name: 'EM6', type: 'flat', diameter: 6, fluteLength: 20, shankDiameter: 6,
  overallLength: 50, numberOfFlutes: 3, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { feedRate: 1200, plungeRate: 400, rampFeedrate: 600, rpm: 10000 } },
} as unknown as Tool

function squarePocketPayload(): ACWorkerPayload {
  return {
    opId: 'op1', setupId: 's1',
    params: {
      geometryId: 'g1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6,
      // WO-1896: bit false = climb, the material-right stream these fixtures were measured on
      // (it was mislabelled conventional before climb was fixed to keep material right).
      stepDistance: 1, thetaMax: Math.PI / 3, climb: false, rampAngle: 3, completionTolerance: 1,
      helixDiameter: 90, tolerance: 0.02,
    },
    heights: {
      clearanceHeight: 15, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
      topHeight: 0, topHeightMode: 'absolute', bottomHeight: -6, bottomHeightMode: 'absolute',
    },
    passes: { stepdown: 3, stepover: 1.2, stockToLeave: 0, finishPasses: 0, springPasses: 0 },
    linking: {
      entryType: 'ramp_helical', rampAngle: 3, rampLength: 10, leadInRadius: 1, leadOutRadius: 1,
      retractType: 'full', transitionType: 'safe_height',
    },
    tool,
    // 20x20 square pocket (CCW outer boundary). Kept small so the 2D clear stays
    // fast pending the cleared-bounding-box perf optimization.
    loops: [{ id: 'L0', closed: true, type: 'boundary', points: [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
    ] }],
    wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function translateAbsoluteCoordinates(move: ToolpathMove, origin: { x: number; y: number }): ToolpathMove {
  return {
    ...move,
    x: move.x + origin.x,
    y: move.y + origin.y,
    ...(typeof move.cx === 'number' ? { cx: move.cx + origin.x } : {}),
    ...(typeof move.cy === 'number' ? { cy: move.cy + origin.y } : {}),
  }
}

function emptyFeatureResult(): FeatureResult {
  return {
    startPoint: { x: 0, y: 0 },
    entries: [],
    passes: [],
    finishClearedRegions: [],
    cleared: [],
    cutRegion: [],
    residual: [],
    stats: {
      passes: 0, points: 0, cacheHits: 0, cacheMisses: 0,
      residualArea: 0, residualMaxInscribedR: 0,
    },
  }
}

describe('buildAdaptiveClearingToolpath (engine entry)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('plans in the authored feature-local frame and restores world XY exactly once', async () => {
    const localPayload = squarePocketPayload()
    const explicitLocalPayload = squarePocketPayload()
    explicitLocalPayload.loopOrigins = { L0: { x: 0, y: 0 } }

    const origin = { x: -270.887, y: 46.79499999999997 }
    const placedPayload = squarePocketPayload()
    placedPayload.loops = placedPayload.loops.map(loop => ({
      ...loop,
      points: loop.points.map(point => ({
        x: point.x + origin.x,
        y: point.y + origin.y,
      })),
    }))
    placedPayload.loopOrigins = { L0: origin }

    const localMoves = await buildAdaptiveClearingToolpath(localPayload)
    const explicitLocalMoves = await buildAdaptiveClearingToolpath(explicitLocalPayload)
    const placedMoves = await buildAdaptiveClearingToolpath(placedPayload)

    expect(JSON.stringify(explicitLocalMoves)).toBe(JSON.stringify(localMoves))
    expect(placedMoves).toHaveLength(localMoves.length)
    for (let index = 0; index < localMoves.length; index += 1) {
      const expectedPlaced = translateAbsoluteCoordinates(localMoves[index], origin)
      expect(JSON.stringify(placedMoves[index]), `placed move ${index}`)
        .toBe(JSON.stringify(expectedPlaced))
    }
  }, 120_000)

  it('classifies translated holes entirely in each candidate feature frame', async () => {
    // At this magnitude the world-frame shoelace centroid of the 3x3 hole is
    // catastrophically displaced and the old classifier drops the hole.
    const origin = { x: 134_217_728, y: 134_217_728 }
    const translate = (points: Array<{ x: number; y: number }>) =>
      points.map(point => ({ x: point.x + origin.x, y: point.y + origin.y }))
    const outer = [
      { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
    ]
    const inner = [
      { x: 2, y: 2 }, { x: 10, y: 2 }, { x: 10, y: 10 }, { x: 2, y: 10 },
    ]
    const hole = [
      { x: 4, y: 4 }, { x: 7, y: 4 }, { x: 7, y: 7 }, { x: 4, y: 7 },
    ]
    const payload = squarePocketPayload()
    payload.loops = [
      { id: 'outer', closed: true, type: 'boundary', points: translate(outer) },
      { id: 'inner', closed: true, type: 'boundary', points: translate(inner) },
      { id: 'hole', closed: true, type: 'hole', points: translate(hole) },
    ]
    payload.loopOrigins = { outer: origin, inner: origin, hole: origin }

    const process = vi.mocked(processFeature)
    process.mockClear()
    process
      .mockReturnValueOnce(emptyFeatureResult())
      .mockReturnValueOnce(emptyFeatureResult())

    await buildAdaptiveClearingToolpath(payload)

    expect(process).toHaveBeenCalledTimes(2)
    expect(process.mock.calls[0][0]).toEqual({ boundary: outer, holes: [] })
    expect(process.mock.calls[1][0]).toEqual({ boundary: inner, holes: [hole] })
  })

  it('selects the largest hole-only fallback boundary by feature-local area', async () => {
    // These loops have local areas 133 and 152, but world-frame cancellation at
    // this placement reports 256 and 0 respectively and selects the wrong one.
    const origin = { x: 1_073_741_824, y: 1_073_741_824 }
    const translate = (points: Array<{ x: number; y: number }>) =>
      points.map(point => ({ x: point.x + origin.x, y: point.y + origin.y }))
    const smaller = [
      { x: 0, y: 0 }, { x: 7, y: 0 }, { x: 7, y: 19 }, { x: 0, y: 19 },
    ]
    const larger = [
      { x: 0, y: 7 }, { x: 19, y: 7 }, { x: 19, y: 15 }, { x: 0, y: 15 },
    ]
    const payload = squarePocketPayload()
    payload.loops = [
      { id: 'smaller', closed: true, type: 'hole', points: translate(smaller) },
      { id: 'larger', closed: true, type: 'hole', points: translate(larger) },
    ]
    payload.loopOrigins = { smaller: origin, larger: origin }

    const process = vi.mocked(processFeature)
    process.mockClear()
    process.mockReturnValueOnce(emptyFeatureResult())

    await buildAdaptiveClearingToolpath(payload)

    expect(process).toHaveBeenCalledTimes(1)
    expect(process.mock.calls[0][0]).toEqual({ boundary: larger, holes: [smaller] })
  })

  it('restores absolute arc centres for a finish-only lap with tangent leads', async () => {
    const finishOnly: FeatureResult = {
      startPoint: { x: 0, y: 0 },
      entries: [],
      passes: [{
        type: 'finish',
        points: [
          { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 },
          { x: 0, y: 20 }, { x: 0, y: 0 },
        ],
      }],
      finishClearedRegions: ['inside'],
      cleared: [],
      cutRegion: [],
      residual: [],
      stats: {
        passes: 1, points: 5, cacheHits: 0, cacheMisses: 0,
        residualArea: 0, residualMaxInscribedR: 0,
      },
    }
    vi.mocked(processFeature)
      .mockReturnValueOnce(finishOnly)
      .mockReturnValueOnce(finishOnly)

    const localPayload = squarePocketPayload()
    localPayload.params.wallFinish = true
    const origin = { x: 137.25, y: -84.5 }
    const placedPayload = squarePocketPayload()
    placedPayload.params.wallFinish = true
    placedPayload.loops = placedPayload.loops.map(loop => ({
      ...loop,
      points: loop.points.map(point => ({
        x: point.x + origin.x,
        y: point.y + origin.y,
      })),
    }))
    placedPayload.loopOrigins = { L0: origin }

    const localMoves = await buildAdaptiveClearingToolpath(localPayload)
    const placedMoves = await buildAdaptiveClearingToolpath(placedPayload)
    const localArcs = localMoves.filter(move =>
      (move.type === 'arc_cw' || move.type === 'arc_ccw') &&
      typeof move.cx === 'number' && typeof move.cy === 'number')

    expect(localArcs.length).toBeGreaterThan(0)
    expect(placedMoves).toHaveLength(localMoves.length)
    for (let index = 0; index < localMoves.length; index += 1) {
      expect(JSON.stringify(placedMoves[index]), `placed arc fixture move ${index}`)
        .toBe(JSON.stringify(translateAbsoluteCoordinates(localMoves[index], origin)))
    }
  }, 120_000)

  it('translates the legacy ACParams.climb bit into physical helix direction', async () => {
    const conventionalPayload = squarePocketPayload()
    conventionalPayload.params.climb = true
    const climbPayload = squarePocketPayload()
    climbPayload.params.climb = false
    const leftHandClimbPayload = squarePocketPayload()
    leftHandClimbPayload.params.climb = false
    leftHandClimbPayload.tool = { ...leftHandClimbPayload.tool, cutHand: 'left' }

    const conventionalHelix = (await buildAdaptiveClearingToolpath(conventionalPayload))
      .filter(m => m.role === 'helix')
    const climbHelix = (await buildAdaptiveClearingToolpath(climbPayload))
      .filter(m => m.role === 'helix')
    const leftHandClimbHelix = (await buildAdaptiveClearingToolpath(leftHandClimbPayload))
      .filter(m => m.role === 'helix')

    const curvatureSign = (moves: typeof climbHelix): number => {
      let cross = 0
      for (let i = 1; i + 1 < moves.length; i++) {
        const ax = moves[i].x - moves[i - 1].x
        const ay = moves[i].y - moves[i - 1].y
        const bx = moves[i + 1].x - moves[i].x
        const by = moves[i + 1].y - moves[i].y
        cross += ax * by - ay * bx
      }
      return Math.sign(cross)
    }

    expect(conventionalHelix.length).toBeGreaterThan(2)
    expect(climbHelix.length).toBe(conventionalHelix.length)
    // WO-1896: the helix bores into surrounding material; climb keeps it on the right -> CCW.
    expect(curvatureSign(conventionalHelix)).toBe(-1)
    expect(curvatureSign(climbHelix)).toBe(1)
    expect(leftHandClimbHelix.length).toBe(climbHelix.length)
    expect(curvatureSign(leftHandClimbHelix)).toBe(-1)
  }, 120_000)

  it('clears a square pocket: helix entry, cuts, multi-depth, returns to clearance', async () => {
    const moves = await buildAdaptiveClearingToolpath(squarePocketPayload())

    expect(moves.length).toBeGreaterThan(20)
    expect(moves[0]).toMatchObject({ type: 'rapid' }) // safe approach first
    expect(moves.some(m => m.role === 'helix')).toBe(true)
    expect(moves.some(m => m.role === 'cut')).toBe(true)

    // Last move returns to clearance (absolute Z = clearanceHeight + wcsOrigin.z = 15).
    expect(moves[moves.length - 1]).toMatchObject({ type: 'rapid', z: 15, role: 'rapid' })

    // Every Z is bounded by [bottomZ, clearanceZ].
    for (const m of moves) {
      expect(m.z).toBeGreaterThanOrEqual(-6 - 1e-6)
      expect(m.z).toBeLessThanOrEqual(15 + 1e-6)
    }

    // Two depth levels (top 0 -> bottom -6, stepdown 3): cut Zs at -3 and -6.
    const cutZs = new Set(moves.filter(m => m.role === 'cut').map(m => Math.round(m.z * 1000) / 1000))
    expect(cutZs.has(-3)).toBe(true)
    expect(cutZs.has(-6)).toBe(true)
  }, 120_000)

  // SKC-47-R2 truth-fix: this used to assert a silent console.warn + [] return —
  // genuinely silent end-to-end (unlike Face/Pocket, AC's 'geometry' branch has no
  // store-level pre-dispatch guard), the exact live user-facing defect the R1 audit
  // named. AC now fails loud at the builder boundary (ADR 0003).
  it('throws a named refusal when there is no closed feature, never a silent empty return', async () => {
    const p = squarePocketPayload()
    p.loops = [{ id: 'open', closed: false, type: 'boundary', points: [{ x: 0, y: 0 }, { x: 10, y: 0 }] }]
    await expect(buildAdaptiveClearingToolpath(p)).rejects.toThrow(/Adaptive Clearing:.*no closed loop/i)
  })

  it('machines ONLY the selected loop, not the largest loop or unselected holes', async () => {
    // Small selected square A at origin, a LARGER unselected square B far to the right,
    // and a hole H inside A. With loopIds = [A], the engine must clear A only -- not pick
    // B as the boundary (it is larger), and not treat H as an island.
    const p = squarePocketPayload()
    p.params.loopIds = ['A']
    p.loops = [
      { id: 'A', closed: true, type: 'boundary', points: [{ x: 0, y: 0 }, { x: 24, y: 0 }, { x: 24, y: 24 }, { x: 0, y: 24 }] },
      { id: 'H', closed: true, type: 'hole', points: [{ x: 9, y: 9 }, { x: 15, y: 9 }, { x: 15, y: 15 }, { x: 9, y: 15 }] },
      { id: 'B', closed: true, type: 'boundary', points: [{ x: 100, y: 0 }, { x: 160, y: 0 }, { x: 160, y: 60 }, { x: 100, y: 60 }] },
    ]
    const moves = await buildAdaptiveClearingToolpath(p)
    const cuts = moves.filter(m => m.role === 'cut')
    expect(cuts.length).toBeGreaterThan(0)
    // Every cut stays inside A's footprint (with tool slop) -> B was not machined.
    for (const m of cuts) {
      expect(m.x).toBeGreaterThanOrEqual(-3)
      expect(m.x).toBeLessThanOrEqual(27)
    }
    // The hole H was not selected, so the fill should pass over its centre (not avoid it
    // as an island): at least one cut lands within H's interior.
    const insideH = cuts.some(m => m.x > 9.5 && m.x < 14.5 && m.y > 9.5 && m.y < 14.5)
    expect(insideH).toBe(true)
  }, 120_000)

  it('machines every disjoint All Parts contour in deterministic source order', async () => {
    const p = squarePocketPayload()
    p.params.geometryId = '__all__'
    p.heights.bottomHeight = -3
    p.loops = [
      { id: 'right-first', closed: true, type: 'contour', points: [
        { x: 60, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 20 }, { x: 60, y: 20 },
      ] },
      { id: 'left-second', closed: true, type: 'contour', points: [
        { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
      ] },
    ]

    const cuts = (await buildAdaptiveClearingToolpath(p)).filter(m => m.role === 'cut')
    const rightCutIndexes = cuts.flatMap((m, i) => m.x > 50 ? [i] : [])
    const leftCutIndexes = cuts.flatMap((m, i) => m.x < 30 ? [i] : [])

    expect(rightCutIndexes.length).toBeGreaterThan(0)
    expect(leftCutIndexes.length).toBeGreaterThan(0)
    expect(Math.max(...rightCutIndexes)).toBeLessThan(Math.min(...leftCutIndexes))
  }, 120_000)

  it('threads the minimum helix radius and falls back safely for invalid values', async () => {
    const belowFloor = squarePocketPayload()
    belowFloor.params.minHelixRadius = 3
    const plungeMoves = await buildAdaptiveClearingToolpath(belowFloor)
    expect(plungeMoves.some(m => m.role === 'helix')).toBe(false)
    expect(plungeMoves.some(m => m.role === 'plunge')).toBe(true)

    const loweredFloor = squarePocketPayload()
    loweredFloor.params.minHelixRadius = 0.01
    expect((await buildAdaptiveClearingToolpath(loweredFloor)).some(m => m.role === 'helix')).toBe(true)

    const invalidFloor = squarePocketPayload()
    invalidFloor.params.helixDiameter = 2
    invalidFloor.params.minHelixRadius = Number.NaN
    const invalidMoves = await buildAdaptiveClearingToolpath(invalidFloor)
    expect(invalidMoves.some(m => m.role === 'helix')).toBe(false)
    expect(invalidMoves.some(m => m.role === 'plunge')).toBe(true)
  }, 120_000)

  it('floor-finishes each disjoint feature once in deterministic source-order blocks', async () => {
    const p = squarePocketPayload()
    p.params.geometryId = '__all__'
    p.params.floorFinish = true
    p.heights.bottomHeight = -3
    p.passes.floorStockToLeave = 1
    p.loops = [
      { id: 'right-first', closed: true, type: 'contour', points: [
        { x: 60, y: 0 }, { x: 80, y: 0 }, { x: 80, y: 20 }, { x: 60, y: 20 },
      ] },
      { id: 'left-second', closed: true, type: 'contour', points: [
        { x: 0, y: 0 }, { x: 20, y: 0 }, { x: 20, y: 20 }, { x: 0, y: 20 },
      ] },
    ]

    const moves = await buildAdaptiveClearingToolpath(p)
    const indexes = (predicate: (move: typeof moves[number]) => boolean): number[] =>
      moves.flatMap((move, index) => predicate(move) ? [index] : [])
    const roughCut = (move: typeof moves[number]): boolean =>
      move.z === -2 && (move.role === 'cut' || move.role === 'wall_follow')
    const floorCut = (move: typeof moves[number]): boolean =>
      move.z === -3 && move.role === 'finish'

    const rightRough = indexes(move => roughCut(move) && move.x > 50)
    const rightFloor = indexes(move => floorCut(move) && move.x > 50)
    const leftRough = indexes(move => roughCut(move) && move.x < 30)
    const leftFloor = indexes(move => floorCut(move) && move.x < 30)

    expect(rightRough.length).toBeGreaterThan(0)
    expect(leftRough.length).toBeGreaterThan(0)
    expect(rightFloor).toHaveLength(rightRough.length)
    expect(leftFloor).toHaveLength(leftRough.length)
    expect(rightFloor.map(index => [moves[index].x, moves[index].y]))
      .toEqual(rightRough.map(index => [moves[index].x, moves[index].y]))
    expect(leftFloor.map(index => [moves[index].x, moves[index].y]))
      .toEqual(leftRough.map(index => [moves[index].x, moves[index].y]))

    expect(Math.max(...rightRough)).toBeLessThan(Math.min(...rightFloor))
    expect(Math.max(...rightFloor)).toBeLessThan(Math.min(...leftRough))
    expect(Math.max(...leftRough)).toBeLessThan(Math.min(...leftFloor))
  }, 120_000)

  it('threads configured wall-finish lead radii through the resolved lead roles and rates', async () => {
    const p = squarePocketPayload()
    p.params.wallFinish = true
    p.heights.bottomHeight = -3
    p.linking.leadInRadius = 1
    p.linking.leadOutRadius = 1.5
    p.feedrateOverride = {
      enabled: true,
      rpm: 10000,
      feedRate: 1200,
      plungeRate: 400,
      rampFeedrate: 600,
      leadInFeedrate: 321,
      leadOutFeedrate: 654,
      fastTraverseFeedrate: 5000,
      finishFeedrate: 777,
    }

    const moves = await buildAdaptiveClearingToolpath(p)

    // WO-1061 RE-PIN (was: an arc_ccw lead_in followed by an arc_ccw lead_out).
    // WO-449 (8527e3fe) gates every connection into a wall-finish lap. On this square pocket
    // the roughing wall-follow already ends ON the lap's start corner, so the gate resolves to
    // a 0.014mm tangent keep-down step at the lead-in rate instead of an arc that would be a
    // detour through cleared air; the lap then closes on itself and retracts vertically at the
    // closing point, so no lead-out arc is emitted either. Measured stream (probe r4,
    // src/tests/evidence/WO-1061/_probe-engine-index.test.ts):
    //   [714] cut       feed 1200 (3.010, 3.010)   <- rough wall-follow ends on the contour
    //   [715] lead_in   feed  321 (3.000, 3.000)   <- the gated connection, at the lead-in rate
    //   [716..720] finish feed undefined, the closed lap (3,3)->(17,3)->(17,17)->(3,17)->(3,3)
    //   [721] rapid z15 at (3.000, 3.000)
    // What this test exists for is the RATE and ROLE threading, and that is what is pinned:
    // the configured lead-in rate reaches the resolved lead move, the lap itself carries no
    // feed override, and if a lead-out is ever resolved it carries the configured lead-out rate.
    // WO-1061 FIX ROUND: the rate is asserted ON the lap-entry move itself, not on "some
    // lead_in somewhere earlier". Finding an unrelated lead_in that still carries 321 while
    // the actual gated lap entry lost its configured feed is exactly the hole that closes here.
    const leadIn = moves.filter(m => m.role === 'lead_in')
    expect(leadIn.length).toBeGreaterThan(0)
    const firstFinish = moves.findIndex(m => m.role === 'finish')
    expect(firstFinish).toBeGreaterThan(0)

    // The lap is entered by the gated connection, never by a bare feed at depth from elsewhere
    // (that is the WO-449 defect, pinned here on this fixture too) -- and THAT move is the one
    // that has to carry the configured lead-in rate.
    const beforeLap = moves[firstFinish - 1]
    expect(beforeLap.role).toBe('lead_in')
    expect(beforeLap.feed).toBe(321)
    expect(Math.hypot(beforeLap.x - moves[firstFinish].x, beforeLap.y - moves[firstFinish].y))
      .toBeLessThan(1e-6)

    // ...and that holds for EVERY wall-finish lap in the stream, not just the first one.
    const lapStarts = moves.flatMap((m, i) =>
      m.role === 'finish' && i > 0 && moves[i - 1].role !== 'finish' ? [i] : [])
    expect(lapStarts.length).toBeGreaterThan(0)
    for (const i of lapStarts) {
      expect(moves[i - 1].role, `lap at move ${i} is not entered by a lead`).toBe('lead_in')
      expect(moves[i - 1].feed, `lap entry at move ${i - 1} lost the configured lead-in rate`)
        .toBe(321)
    }

    // Any lead-out that IS resolved must carry the configured lead-out rate.
    for (const m of moves.filter(x => x.role === 'lead_out')) expect(m.feed).toBe(654)

    const lap = moves.filter(m => m.role === 'finish')
    expect(lap.length).toBeGreaterThan(2)
    expect(lap.every(m => m.feed === undefined)).toBe(true)
  }, 120_000)

  it('falls back safely when tangent wall-finish leads would cross a nearby island', async () => {
    const p = squarePocketPayload()
    p.params.wallFinish = true
    p.heights.bottomHeight = -3
    p.linking.leadInRadius = 5
    p.linking.leadOutRadius = 5
    p.loops = [
      { id: 'outer', closed: true, type: 'boundary', points: [
        { x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 30 }, { x: 0, y: 30 },
      ] },
      { id: 'near-island', closed: true, type: 'hole', points: [
        { x: 10, y: 10 }, { x: 20, y: 10 }, { x: 20, y: 20 }, { x: 10, y: 20 },
      ] },
    ]

    const rejected = await buildAdaptiveClearingToolpath(p)

    expect(rejected.some(m => m.role === 'finish')).toBe(true)

    // WO-1061 RE-PIN (was: no lead ROLE may appear at all). "No lead role" was a proxy for
    // "the r5 tangent lead arcs were refused"; since the WO-439..445 batch the gated WO-449
    // connection into each lap also carries role lead_in, so the proxy fires on moves that are
    // not leads at all. What this test is about is SAFETY, so it is now measured directly:
    // no lead ARC is taken, and no lead-role move brings the tool anywhere near the island.
    expect(rejected.some(m =>
      (m.role === 'lead_in' || m.role === 'lead_out')
      && (m.type === 'arc_cw' || m.type === 'arc_ccw'))).toBe(false)

    // Tool-centre clearance from the 10x10 island for every lead-role move, endpoints and the
    // chords between them. Measured at HEAD: worst overlap -6.885mm on endpoints and -4.885mm
    // sampled along the chords -- i.e. the tool never comes within 4.8mm of the island.
    const R = p.tool.diameter / 2
    const islandOverlap = (x: number, y: number): number =>
      R - Math.hypot(Math.max(10 - x, 0, x - 20), Math.max(10 - y, 0, y - 20))
    let worst = -Infinity
    let worstAt = ''
    rejected.forEach((m, i) => {
      if (m.role !== 'lead_in' && m.role !== 'lead_out') return
      const prev = rejected[i - 1] ?? m
      for (let t = 0; t <= 1.0001; t += 0.02) {
        const x = prev.x + (m.x - prev.x) * t
        const y = prev.y + (m.y - prev.y) * t
        const o = islandOverlap(x, y)
        if (o > worst) { worst = o; worstAt = `move#${i} ${m.role} at (${x.toFixed(3)}, ${y.toFixed(3)})` }
      }
    })
    expect(worst, `a wall-finish lead sweeps the island: ${worstAt}`).toBeLessThan(0)
  }, 120_000)

  // WO-2038 RE-PIN: this used to pin a zero-stock "spring replay" - the whole floor level
  // cut a second time at the same Z under the finish role. Operator at the machine, 09-26:
  // "why is it repeating the Adaptive at the final Z step down?" With no floor stock the
  // rough level already cleared the floor, so floor finishing ON now emits exactly the
  // floor-finishing-OFF stream: the floor level once, no finish-role replay.
  it('clears the floor once when floor finishing has zero floor stock (no air replay)', async () => {
    const p = squarePocketPayload()
    p.params.floorFinish = true
    p.heights.bottomHeight = -3
    p.passes.floorStockToLeave = 0
    const off = squarePocketPayload()
    off.params.floorFinish = false
    off.heights.bottomHeight = -3
    off.passes.floorStockToLeave = 0

    const moves = await buildAdaptiveClearingToolpath(p)
    expect(moves).toEqual(await buildAdaptiveClearingToolpath(off))
    expect(moves.filter(m => m.role === 'cut' && m.z === -3).length).toBeGreaterThan(0)
    expect(moves.filter(m => m.role === 'finish' && m.z === -3)).toHaveLength(0)
    expect(moves[moves.length - 1]).toMatchObject({ type: 'rapid', z: 15, role: 'rapid' })
  }, 120_000)

  it('floor-finish replay promotes exactly the rough floor-level geometry when floor stock is left', async () => {
    const p = squarePocketPayload()
    p.params.floorFinish = true
    p.heights.bottomHeight = -3
    p.passes.floorStockToLeave = 1

    const moves = await buildAdaptiveClearingToolpath(p)
    const roughPrimary = moves.filter(m => m.role === 'cut' && m.z === -2)
    const roughWallFollow = moves.filter(m => m.role === 'wall_follow' && m.z === -2)
    const roughFloorCutting = moves.filter(
      m => m.z === -2 && (m.role === 'cut' || m.role === 'wall_follow'),
    )
    const floor = moves.filter(m => m.role === 'finish' && m.z === -3)

    expect(roughPrimary.length).toBeGreaterThan(0)
    // WO-410 FOLD (re-pinned 2026-08-21): integralWallFollow defaults true at this API layer
    // (engine/index.ts), and this plain square pocket's floor level used to substitute 6
    // jumpType-2 lifts for wall-follow rides. Under the honest cleared-state contract those
    // substitutions no longer cleared the B8 engagement gate on this fixture at the floor
    // level -- zero wall-follows, not six.
    // WO-1061 RE-PIN (0 -> 14): the WO-439..445 wall-cleanup batch (2026-08-20) restored
    // wall-follow rides at this level; the count is a COUNT, not the invariant. The invariant
    // this test actually cares about -- floor-finish promotes exactly the rough wall-follow
    // geometry, nothing else -- is the two assertions below and holds at 14 exactly as it did
    // at 0 (measured: roughPrimary 457, wall-follow 14, floor 471 = 457 + 14, identical XY).
    // WO-1178 RE-PIN (14 -> 8): rings now ride the wall they touch inside the cut pass, so six
    // of this level's cusp wall-follow rides have nothing left to scrub and are not emitted
    // (a cusp ride is also load-gated now). The invariant below is unchanged.
    // WO-1178 ATTEMPT 3 RE-PIN (8 -> 6): where the next cut starts a short way ahead of the
    // prior cut's end on the same wall, the two overlapping cusp rides are now ONE forward ride
    // (Operator's Tee finding); two of this level's ride pairs collapse that way. The departure
    // fillet off a planted wall start is emitted as a 'lead' (role lead_in), never a
    // wall-follow, so it does not count here. The invariant below is unchanged.
    // WO-2038: the same depth-agnostic planned stream, now roughed at -2 (floor stock 1)
    // and replayed at the true floor -3.
    expect(roughWallFollow).toHaveLength(6)
    expect(floor.length - roughPrimary.length).toBe(roughWallFollow.length)
    // The extra floor-finish points are the exact rough wall-follow geometry promoted
    // to the finish role/rate, not a duplicate adaptive cut pass.
    expect(floor.map(m => [m.x, m.y])).toEqual(roughFloorCutting.map(m => [m.x, m.y]))
    expect(floor.every(m => m.feed === undefined)).toBe(true)
    expect(moves[moves.length - 1]).toMatchObject({ type: 'rapid', z: 15, role: 'rapid' })
  }, 120_000)
})
