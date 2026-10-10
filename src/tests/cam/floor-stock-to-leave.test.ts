// Shared axial (floor) stock-to-leave: PassParams.floorStockToLeave is the floor
// analog of the radial PassParams.stockToLeave. These tests assert, for each of the
// four cutting ops that have a floor (contour / pocket / adaptive / face):
//   - a non-zero passes.floorStockToLeave raises the deepest ROUGHING cut to
//     trueBottom + axial (floor stock is left on the bottom),
//   - axial = 0 (default) is byte-identical to the prior behavior,
//   - pocket/face still honor the LEGACY per-op field (params.floorStockToLeave)
//     when the shared field is absent, and the shared field WINS when both are set.

import { describe, it, expect, beforeAll } from 'vitest'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { buildFaceToolpath } from '../../lib/cam/face2d'
import { buildAdaptiveClearingToolpath } from '../../lib/cam/adaptiveClearing2d/engine'
import { ensureEngineClipperReady } from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type {
  ContourParams, ContourWorkerPayload,
  PocketParams, PocketWorkerPayload,
  FaceParams, FaceWorkerPayload,
  ACWorkerPayload, LoopData,
} from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

await ensureClipperReady()

const AXIAL = 1.5
const BOTTOM = -6

function flatTool(dia: number): Tool {
  return {
    id: 't1', name: 'flat', type: 'flat_end_mill',
    diameter: dia, fluteLength: 20, shankDiameter: dia, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 10000, feedRate: 1000, plungeRate: 300, rampFeedrate: 600, depthOfCut: 2, stepover: 1.5 } },
  } as unknown as Tool
}

function heights(bottom = BOTTOM): HeightParams {
  return {
    clearanceHeight: 15, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  }
}

const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

const square = (id: string, s: number): LoopData => ({
  id, closed: true, type: 'contour',
  points: [{ x: 0, y: 0 }, { x: s, y: 0 }, { x: s, y: s }, { x: 0, y: s }],
})

const cutZs = (moves: { role?: string; z?: number }[]): number[] =>
  moves.filter(m => m.role === 'cut' && typeof m.z === 'number').map(m => Math.round((m.z as number) * 1000) / 1000)
const deepest = (moves: { role?: string; z?: number }[]): number => Math.min(...cutZs(moves))

// ── Contour ──────────────────────────────────────────────────────────────────
// Roughing-only (finishPasses 0): the deepest cut is the rough floor, so floor
// stock raises it straight to trueBottom + axial.

describe('floorStockToLeave — contour2d (roughing-only)', () => {
  const passes = (over: Partial<PassParams> = {}): PassParams => ({
    stepdown: 2, stepover: 1.5, stockToLeave: 0.5, finishPasses: 0, springPasses: 0, ...over,
  })
  const params: ContourParams = { side: 'outer', direction: 'climb', geometryId: 'g', loopIds: [], tabs: false }
  const payload = (pp: PassParams): ContourWorkerPayload => ({
    opId: 'op', setupId: 'su', params, heights: heights(), passes: pp, linking,
    tool: flatTool(6), loops: [square('sq', 40)], wcsOrigin: { x: 0, y: 0, z: 0 },
  })

  it('raises the deepest cut to trueBottom + axial', () => {
    const moves = buildContourToolpath(payload(passes({ floorStockToLeave: AXIAL })))
    expect(deepest(moves)).toBeCloseTo(BOTTOM + AXIAL, 6)   // -4.5
  })

  it('axial = 0 cuts to the true bottom', () => {
    const moves = buildContourToolpath(payload(passes({ floorStockToLeave: 0 })))
    expect(deepest(moves)).toBeCloseTo(BOTTOM, 6)           // -6
  })

  it('axial = 0 is byte-identical to the field being absent (default)', () => {
    const withZero  = buildContourToolpath(payload(passes({ floorStockToLeave: 0 })))
    const without   = buildContourToolpath(payload(passes()))
    expect(withZero).toEqual(without)
  })
})

// ── Pocket ───────────────────────────────────────────────────────────────────
// Pocket raises the rough floor AND adds a final clean pass at the true bottom,
// so trueBottom + axial appears as a distinct ROUGHING cut level.

describe('floorStockToLeave — pocket2d', () => {
  const passes = (over: Partial<PassParams> = {}): PassParams => ({
    stepdown: 3, stepover: 1.5, stockToLeave: 0, finishPasses: 0, springPasses: 0, ...over,
  })
  const params = (over: Partial<PocketParams> = {}): PocketParams => ({
    geometryId: 'g', loopIds: [], direction: 'climb', orderStrategy: 'by_depth',
    fillStrategy: 'outside_in', floorStockToLeave: 0, finishContour: false,
    helixDiameter: 90, overlapMm: 0, stepoverLeadIn: 'none', stayDown: false, stayDownLift: 1.0, ...over,
  })
  const payload = (pp: PassParams, pa: PocketParams): PocketWorkerPayload => ({
    opId: 'op', setupId: 'su', params: pa, heights: heights(), passes: pp, linking,
    tool: flatTool(6), loops: [square('sq', 40)], wcsOrigin: { x: 0, y: 0, z: 0 },
  })

  it('shared field raises the rough floor to trueBottom + axial (clean pass still reaches bottom)', () => {
    const moves = buildPocketToolpath(payload(passes({ floorStockToLeave: AXIAL }), params()))
    const zs = new Set(cutZs(moves))
    expect(zs.has(BOTTOM + AXIAL)).toBe(true)   // -4.5 rough floor
    expect(zs.has(BOTTOM)).toBe(true)           // -6 clean pass
  })

  it('axial = 0 is byte-identical to the field being absent', () => {
    const withZero = buildPocketToolpath(payload(passes({ floorStockToLeave: 0 }), params()))
    const without  = buildPocketToolpath(payload(passes(), params()))
    expect(withZero).toEqual(without)
  })

  it('BACK-COMPAT: legacy per-op params.floorStockToLeave is honored when the shared field is absent', () => {
    const legacy = buildPocketToolpath(payload(passes(), params({ floorStockToLeave: AXIAL })))
    const shared = buildPocketToolpath(payload(passes({ floorStockToLeave: AXIAL }), params()))
    expect(shared).toEqual(legacy)
  })

  it('shared field WINS over the legacy per-op field', () => {
    const both    = buildPocketToolpath(payload(passes({ floorStockToLeave: AXIAL }), params({ floorStockToLeave: 99 })))
    const sharedOnly = buildPocketToolpath(payload(passes({ floorStockToLeave: AXIAL }), params({ floorStockToLeave: 0 })))
    expect(both).toEqual(sharedOnly)
  })
})

// ── Face ─────────────────────────────────────────────────────────────────────

describe('floorStockToLeave — face2d', () => {
  const passes = (over: Partial<PassParams> = {}): PassParams => ({
    stepdown: 3, stepover: 7, stockToLeave: 0, finishPasses: 0, springPasses: 0, ...over,
  })
  const params = (over: Partial<FaceParams> = {}): FaceParams => ({
    boundarySource: 'stock', geometryId: '__stock__', loopIds: [],
    stockOffset: 0, boundaryContainment: 'outside', avoidanceLoopIds: [],
    pattern: 'linear', passAngle: 0, direction: 'both_ways', fromOtherSide: false,
    passExtension: 5, chipThinning: false,
    bothSidesPerLevel: false, floorStockToLeave: 0, finishPass: false,
    entryType: 'plunge', leadInRadius: 0, leadOutRadius: 0,
    keepToolDown: true, maxStayDownDistance: Infinity, extendBeforeRetract: false,
    transition: 'straight', tolerance: 0.01, ...over,
  })
  const rect: LoopData = { id: 'r', closed: true, type: 'contour',
    points: [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 60 }, { x: 0, y: 60 }] }
  const payload = (pp: PassParams, pa: FaceParams): FaceWorkerPayload => ({
    opId: 'op', setupId: 'su', params: pa, heights: heights(), passes: pp, linking,
    tool: flatTool(10), loops: [rect], wcsOrigin: { x: 0, y: 0, z: 0 },
  })

  it('shared field raises the rough floor to trueBottom + axial', () => {
    const zs = new Set(cutZs(buildFaceToolpath(payload(passes({ floorStockToLeave: AXIAL }), params()))))
    expect(zs.has(BOTTOM + AXIAL)).toBe(true)   // -4.5
    expect(zs.has(BOTTOM)).toBe(true)           // -6 clean pass
  })

  it('axial = 0 is byte-identical to the field being absent', () => {
    const withZero = buildFaceToolpath(payload(passes({ floorStockToLeave: 0 }), params()))
    const without  = buildFaceToolpath(payload(passes(), params()))
    expect(withZero).toEqual(without)
  })

  it('BACK-COMPAT: legacy per-op field honored; shared field WINS', () => {
    const legacy = buildFaceToolpath(payload(passes(), params({ floorStockToLeave: AXIAL })))
    const shared = buildFaceToolpath(payload(passes({ floorStockToLeave: AXIAL }), params()))
    expect(shared).toEqual(legacy)
    const both = buildFaceToolpath(payload(passes({ floorStockToLeave: AXIAL }), params({ floorStockToLeave: 99 })))
    expect(both).toEqual(shared)
  })
})

// ── Adaptive clearing ──────────────────────────────────────────────────────────
// AC clears in depth levels; floor stock raises the clearing floor so the deepest
// level stops at trueBottom + axial.

describe('floorStockToLeave — adaptive clearing (engine)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  const payload = (floorStock?: number, floorFinish?: boolean): ACWorkerPayload => ({
    opId: 'op1', setupId: 's1',
    params: {
      geometryId: 'g1', loopIds: [], targetEngagement: 0.4, maxEngagement: 0.6,
      stepDistance: 1, thetaMax: Math.PI / 3, climb: true, rampAngle: 3, completionTolerance: 1,
      helixDiameter: 90, tolerance: 0.02,
      ...(floorFinish !== undefined ? { floorFinish } : {}),
    },
    heights: heights(),
    passes: { stepdown: 3, stepover: 1.2, stockToLeave: 0, finishPasses: 0, springPasses: 0,
      ...(floorStock !== undefined ? { floorStockToLeave: floorStock } : {}) },
    linking: { entryType: 'ramp_helical', rampAngle: 3, rampLength: 10, leadInRadius: 1, leadOutRadius: 1,
      retractType: 'full', transitionType: 'safe_height' },
    tool: flatTool(6),
    loops: [square('L0', 20)],
    wcsOrigin: { x: 0, y: 0, z: 0 },
  })

  it('raises the clearing floor to trueBottom + axial', async () => {
    const moves = await buildAdaptiveClearingToolpath(payload(AXIAL))
    expect(deepest(moves)).toBeCloseTo(BOTTOM + AXIAL, 6)   // -4.5
    // No cut goes below the raised floor.
    for (const z of cutZs(moves)) expect(z).toBeGreaterThanOrEqual(BOTTOM + AXIAL - 1e-6)
  }, 120_000)

  it('axial = 0 is byte-identical to the field being absent', async () => {
    const withZero = await buildAdaptiveClearingToolpath(payload(0))
    const without  = await buildAdaptiveClearingToolpath(payload(undefined))
    expect(withZero).toEqual(without)
    expect(deepest(without)).toBeCloseTo(BOTTOM, 6)         // -6
  }, 120_000)

  it('floor finish leaves the raised rough floor, then cleans once at trueBottom', async () => {
    const moves = await buildAdaptiveClearingToolpath(payload(AXIAL, true))
    expect(deepest(moves)).toBeCloseTo(BOTTOM + AXIAL, 6)

    const floorCuts = moves.filter(m => m.role === 'finish')
    expect(floorCuts.length).toBeGreaterThan(0)
    expect(floorCuts.every(m => m.z === BOTTOM && m.feed === undefined)).toBe(true)
    for (const m of moves) {
      expect(m.z).toBeGreaterThanOrEqual(BOTTOM - 1e-6)
      expect(m.z).toBeLessThanOrEqual(15 + 1e-6)
    }
  }, 120_000)

  it('floorFinish = false is byte-identical to the field being absent', async () => {
    const explicitFalse = await buildAdaptiveClearingToolpath(payload(AXIAL, false))
    const absent = await buildAdaptiveClearingToolpath(payload(AXIAL))
    expect(explicitFalse).toEqual(absent)
  }, 120_000)

  it('fails loud instead of full-depth floor cutting when axial stock consumes the cut depth', async () => {
    await expect(buildAdaptiveClearingToolpath(payload(Math.abs(BOTTOM), true)))
      .rejects.toThrow(/floorFinish.*no rough depth.*reduce floor stock/i)
  }, 120_000)
})
