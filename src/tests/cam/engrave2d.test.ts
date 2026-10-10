import { describe, it, expect } from 'vitest'
import { buildEngraveToolpath } from '../../lib/cam/engrave2d'
import { toolHalfAngleRad } from '../../lib/cam/geometry'
import type { EngraveParams, EngraveWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams } from '../../types'

// ── Fixtures ───────────────────────────────────────────────────────────────────

function makeTool(over: Partial<Tool> = {}): Tool {
  return {
    id: 't1', name: 'engraver', type: 'flat_end_mill',
    diameter: 3, fluteLength: 12, shankDiameter: 3, overallLength: 40,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 18000, feedRate: 1200, plungeRate: 300 } },
    ...over,
  } as Tool
}

function makeHeights(bottom = -2): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  }
}

const passes = (stepdown = 5): PassParams => ({
  stepdown, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0,
})

const linking = (over: Partial<LinkingParams> = {}): LinkingParams => ({
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height', ...over,
})

function makeParams(over: Partial<EngraveParams> = {}): EngraveParams {
  return {
    geometryId: '', loopIds: [], includeOpen: true, includeClosed: true,
    mode: 'trace', depthModel: 'constant',
    side: 'center', sideOffset: 0, axialOffset: 0,
    targetLineWidth: 0, useWidthForDepth: false,
    direction: 'as_drawn', tolerance: 0.01,
    ...over,
  }
}

const openLine: LoopData = {
  id: 'L', closed: false, type: 'open',
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 20, y: 0 }],
}
const closedRect: LoopData = {
  id: 'R', closed: true, type: 'contour',
  points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }],
}

function payload(params: EngraveParams, loops: LoopData[],
  heights = makeHeights(), pp = passes(), link = linking()): EngraveWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params, heights, passes: pp, linking: link,
    tool: makeTool(), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

type Move = ReturnType<typeof buildEngraveToolpath>[number]
const cuts = (m: Move[]) => m.filter(x => x.role === 'cut')

// ── Tests ────────────────────────────────────────────────────────────────────

describe('Engrave/Trace — open curve', () => {
  const moves = buildEngraveToolpath(payload(makeParams(), [openLine]))

  it('rides the source points at cut depth', () => {
    const c = cuts(moves)
    expect(c.map(p => p.x)).toEqual([0, 10, 20])
    expect(c.every(p => p.z === -2)).toBe(true)
  })

  it('starts with a rapid entry and ends with a rapid retract', () => {
    expect(moves[0].type).toBe('rapid')
    expect(moves[moves.length - 1].type).toBe('rapid')
  })
})

describe('Engrave/Trace — closed-loop acceptance', () => {
  it('derives closed-loop winding from tool hand and physical cut selection', () => {
    const build = (direction: 'climb' | 'conventional', cutHand: 'right' | 'left') => {
      const p = payload(makeParams({ direction }), [closedRect])
      p.tool = { ...p.tool, cutHand }
      return buildEngraveToolpath(p)
    }
    const rightClimb = build('climb', 'right')
    const rightConventional = build('conventional', 'right')
    expect(rightClimb).not.toEqual(rightConventional)
    expect(build('climb', 'left')).toEqual(rightConventional)
    expect(build('conventional', 'left')).toEqual(rightClimb)
  })

  it('traces a closed loop when includeClosed is on', () => {
    const moves = buildEngraveToolpath(payload(makeParams({ includeClosed: true }), [closedRect]))
    expect(cuts(moves).length).toBeGreaterThan(0)
  })

  it('skips closed loops when includeClosed is off', () => {
    const moves = buildEngraveToolpath(payload(makeParams({ includeClosed: false, includeOpen: true }), [closedRect]))
    expect(moves.length).toBe(0)
  })
})

describe('Engrave/Trace — sideways offset', () => {
  it('shifts the cut path off the source line', () => {
    const moves = buildEngraveToolpath(payload(makeParams({ side: 'left', sideOffset: 1 }), [openLine]))
    const maxAbsY = Math.max(...cuts(moves).map(c => Math.abs(c.y)))
    expect(maxAbsY).toBeGreaterThan(0.5)
  })
})

describe('Engrave/Trace — multi-depth', () => {
  const moves = buildEngraveToolpath(payload(makeParams(), [openLine], makeHeights(-6), passes(2)))

  it('produces one Z pass per stepdown level (ceil(6/2) = 3)', () => {
    expect(moves.filter(m => m.role === 'plunge').length).toBe(3)
  })

  it('reaches exactly the bottom depth on the final pass', () => {
    expect(Math.min(...cuts(moves).map(c => c.z))).toBe(-6)
  })
})

describe('Engrave/Trace — V-engrave depth from width', () => {
  // angleFromAxisDeg is the per-side half-angle (from axis). A 15°/side tool (= 30°
  // included) yields a 2.0mm surface width at depth 2 / (2·tan(15°)) ≈ 3.732mm.
  it('derives depth = topZ - width / (2·tan(angleFromAxisDeg))', () => {
    const tool = makeTool({ type: 'v_bit', angleFromAxisDeg: 15 })
    const p = payload(makeParams({ mode: 'engrave', useWidthForDepth: true, targetLineWidth: 2 }), [openLine])
    p.tool = tool
    const moves = buildEngraveToolpath(p)
    const tanHalf = Math.tan(15 * Math.PI / 180)   // half of the 30° included angle
    const expected = 0 - 2 / (2 * tanHalf)         // ≈ -3.7320508
    expect(Math.min(...cuts(moves).map(c => c.z))).toBeCloseTo(expected, 3)
  })

  it('a 90° V-bit engraving a 2.0mm width cuts exactly 1.0mm deep (tan(45°)=1)', () => {
    const tool = makeTool({ type: 'v_bit', angleFromAxisDeg: 45 })
    const p = payload(makeParams({ mode: 'engrave', useWidthForDepth: true, targetLineWidth: 2 }), [openLine])
    p.tool = tool
    const moves = buildEngraveToolpath(p)
    expect(Math.min(...cuts(moves).map(c => c.z))).toBeCloseTo(-1.0, 6)
  })

  it('toolHalfAngleRad pins the from-axis half-angle convention (no halving)', () => {
    expect(toolHalfAngleRad(45)).toBeCloseTo(Math.PI / 4, 12)  // 45°/side -> PI/4 directly
    expect(toolHalfAngleRad(undefined)).toBeCloseTo(59 * Math.PI / 180, 12)  // default 59 (= 118 included)
  })

  // The derived bottom is ALWAYS below top for a positive width + tip angle, so
  // the store's R3 ordering check skips the bottom-vs-top test in this mode. This
  // pins the invariant that makes that skip safe: even when the user's leftover
  // bottom sits AT or ABOVE top (the old "dummy bottom" that used to block
  // dispatch), the worker still cuts below top from the derived depth.
  it('derives a below-top bottom even when heights.bottomHeight >= top (dummy bottom)', () => {
    const tool = makeTool({ type: 'v_bit', angleFromAxisDeg: 45 })
    // bottom = +2 sits ABOVE top (0): this is the leftover value the old
    // validation rejected with "Bottom at or above top".
    const p = payload(
      makeParams({ mode: 'engrave', useWidthForDepth: true, targetLineWidth: 2 }),
      [openLine], makeHeights(2),
    )
    p.tool = tool
    const moves = buildEngraveToolpath(p)
    // 90° V-bit, 2.0mm width -> 1.0mm deep, i.e. z = -1.0 (below top 0).
    expect(Math.min(...cuts(moves).map(c => c.z))).toBeCloseTo(-1.0, 6)
  })
})

describe('Engrave/Trace — arc lead-in', () => {
  it('emits lead_in arc moves before the first cut', () => {
    const moves = buildEngraveToolpath(payload(makeParams(), [openLine], makeHeights(), passes(), linking({ leadInRadius: 2 })))
    const firstLeadIn = moves.findIndex(m => m.role === 'lead_in')
    const firstCut    = moves.findIndex(m => m.role === 'cut')
    expect(firstLeadIn).toBeGreaterThanOrEqual(0)
    expect(firstLeadIn).toBeLessThan(firstCut)
  })
})

describe('Engrave/Trace — degenerate input', () => {
  it('returns no moves and reports progress complete for a sub-2-point curve', () => {
    let last = 0
    const onept: LoopData = { id: 'P', closed: false, type: 'open', points: [{ x: 1, y: 1 }] }
    const moves = buildEngraveToolpath(payload(makeParams(), [onept]), f => { last = f })
    expect(moves.length).toBe(0)
    expect(last).toBe(1)
  })
})
