import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildDrillToolpath } from '../../lib/cam/drill2d'
import { estimateRuntimeMs, estimateRuntimeMsOrError } from '../../lib/cam/runtime'
import type { DrillParams, DrillWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams, ToolpathMove } from '../../types'

// WO-1516 (BUG-408): a drill dwell must count in the cut-time estimate. Twelve
// holes on a 4 x 3 grid, 0.75 s G82 dwell each = 9 s of real pauses.

const RAPID = 5000

function makeTool(): Tool {
  return {
    id: 't1', name: 'drill 5', type: 'drill',
    diameter: 5, fluteLength: 30, shankDiameter: 5, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 8000, feedRate: 600, plungeRate: 150, depthOfCut: 5, stepover: 2 } },
  } as Tool
}

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: -10, bottomHeightMode: 'absolute',
}
const passes: PassParams = { stepdown: 5, stepover: 2, stockToLeave: 0, finishPasses: 0, springPasses: 0 }
const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

function holeLoop(id: string, cx: number, cy: number): LoopData {
  const s = 2
  return { id, closed: true, type: 'contour', points: [
    { x: cx - s, y: cy - s }, { x: cx + s, y: cy - s },
    { x: cx + s, y: cy + s }, { x: cx - s, y: cy + s },
  ] }
}

const LOOPS: LoopData[] = []
for (let r = 0; r < 3; r++) for (let c = 0; c < 4; c++) LOOPS.push(holeLoop(`h${r}${c}`, c * 20, r * 20))

function params(over: Partial<DrillParams> = {}): DrillParams {
  return {
    geometryId: 'g1', loopIds: [], cycleType: 'simple', peckDepth: 3, chipBreakRetract: 1, dwell: 0,
    retractMode: 'clearance', sortStrategy: 'none', ...over,
  }
}

function build(p: DrillParams, holeBottoms?: Record<string, number>): ToolpathMove[] {
  const payload: DrillWorkerPayload = {
    opId: 'op', setupId: 'su', params: p, heights, passes, linking,
    tool: makeTool(), loops: LOOPS, wcsOrigin: { x: 0, y: 0, z: 0 },
    ...(holeBottoms ? { holeBottoms } : {}),
  }
  return buildDrillToolpath(payload)
}

// Travel time the pre-WO-1516 estimator produced: segment length / speed only.
function travelOnlyMs(moves: ToolpathMove[]): number {
  let min = 0
  for (let i = 1; i < moves.length; i++) {
    const a = moves[i - 1], m = moves[i]
    const len = Math.hypot(m.x - a.x, m.y - a.y, m.z - a.z)
    min += len / (m.type === 'rapid' ? RAPID : m.feed!)
  }
  return min * 60000
}

afterEach(() => { vi.restoreAllMocks() })

describe('WO-1516 runtime estimate carries drill dwell', () => {
  it('12-hole dwell (0.75 s) estimates 9 s more than the same simple drill', () => {
    const simple = estimateRuntimeMs(build(params()), RAPID)
    const dwell = estimateRuntimeMs(build(params({ cycleType: 'dwell', dwell: 0.75 })), RAPID)
    expect(simple).toBeGreaterThan(0)
    expect(dwell - simple).toBeGreaterThanOrEqual(9000 - 1e-6)
    expect(dwell - simple).toBeCloseTo(9000, 6)
  })

  it('zero-dwell and simple drills estimate exactly their travel time, unchanged', () => {
    const simpleMoves = build(params())
    const zeroDwellMoves = build(params({ cycleType: 'dwell', dwell: 0 }))
    expect(zeroDwellMoves).toEqual(simpleMoves)
    expect(estimateRuntimeMs(zeroDwellMoves, RAPID)).toBeCloseTo(travelOnlyMs(simpleMoves), 6)
    expect(estimateRuntimeMs(simpleMoves, RAPID)).toBeCloseTo(travelOnlyMs(simpleMoves), 6)
  })

  it('mixed-depth simple drill estimate is its travel time, unchanged', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const moves = build(params(), { h00: -4, h01: -7, h12: -2 })
    expect(moves.some((m) => m.dwellMs !== undefined)).toBe(false)
    expect(estimateRuntimeMs(moves, RAPID)).toBeCloseTo(travelOnlyMs(moves), 6)
  })

  it('a mixed-depth dwell drill still adds one dwell per hole', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const bottoms = { h00: -4, h01: -7, h12: -2 }
    const simple = estimateRuntimeMs(build(params(), bottoms), RAPID)
    const dwell = estimateRuntimeMs(build(params({ cycleType: 'dwell', dwell: 0.75 }), bottoms), RAPID)
    expect(dwell - simple).toBeCloseTo(9000, 6)
  })

  it('refuses an invalid dwell by name instead of guessing', () => {
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      const moves: ToolpathMove[] = [
        { type: 'rapid', x: 0, y: 0, z: 1 },
        { type: 'feed', x: 0, y: 0, z: -1, feed: 100, role: 'plunge', dwellMs: bad },
      ]
      const res = estimateRuntimeMsOrError(moves, RAPID)
      expect(res.ms).toBeUndefined()
      expect(res.error).toMatch(/dwell/)
    }
  })
})
