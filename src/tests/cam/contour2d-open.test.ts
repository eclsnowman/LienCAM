import { describe, expect, it } from 'vitest'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import type {
  ContourParams,
  ContourWorkerPayload,
  LoopData,
} from '../../lib/cam/types'
import type {
  HeightParams,
  LinkingParams,
  PassParams,
  Tool,
  ToolpathMove,
} from '../../types'

await ensureClipperReady()

const STOCK_BOUNDS = {
  min: { x: 0, y: 0 },
  max: { x: 100, y: 100 },
}

function tool(): Tool {
  return {
    id: 'tool-1',
    name: '6mm flat',
    type: 'flat_end_mill',
    diameter: 6,
    fluteLength: 20,
    shankDiameter: 6,
    overallLength: 60,
    numberOfFlutes: 2,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {
      default: {
        rpm: 10000,
        feedRate: 1000,
        plungeRate: 300,
        depthOfCut: 2,
        stepover: 1.5,
        leadInFeedrate: 700,
        leadOutFeedrate: 650,
      },
    },
  } as Tool
}

function heights(bottomHeight = -2): HeightParams {
  return {
    clearanceHeight: 10,
    clearanceHeightMode: 'absolute',
    retractHeight: 5,
    feedHeight: 1,
    topHeight: 0,
    topHeightMode: 'absolute',
    bottomHeight,
    bottomHeightMode: 'absolute',
  }
}

const linking: LinkingParams = {
  entryType: 'plunge',
  rampAngle: 3,
  rampLength: 0,
  leadInRadius: 0,
  leadOutRadius: 0,
  retractType: 'full',
  transitionType: 'safe_height',
}

function passes(over: Partial<PassParams> = {}): PassParams {
  return {
    stepdown: 2,
    stepover: 1.5,
    stockToLeave: 0,
    finishPasses: 1,
    springPasses: 0,
    ...over,
  }
}

function params(over: Partial<ContourParams> = {}): ContourParams {
  return {
    pathType: 'open',
    openSide: 'right',
    side: 'outer',
    // WO-1896: cutter right of a chain drawn left-to-right leaves the part on its
    // left, which is conventional. The entry/exit fixtures below were written for
    // this 10 -> 90 travel, so the fixture selects the direction that produces it.
    direction: 'conventional',
    geometryId: 'geo-1',
    loopIds: [],
    tabs: false,
    ...over,
  }
}

function openLoop(over: Partial<LoopData> = {}): LoopData {
  return {
    id: 'open-1',
    closed: false,
    type: 'open',
    points: [{ x: 10, y: 50 }, { x: 90, y: 50 }],
    ...over,
  }
}

function closedLoop(): LoopData {
  return {
    id: 'closed-1',
    closed: true,
    type: 'contour',
    points: [
      { x: 20, y: 20 },
      { x: 80, y: 20 },
      { x: 80, y: 80 },
      { x: 20, y: 80 },
    ],
  }
}

function payload(over: Partial<ContourWorkerPayload> = {}): ContourWorkerPayload {
  return {
    opId: 'op-1',
    setupId: 'setup-1',
    params: params(),
    heights: heights(),
    passes: passes(),
    linking,
    tool: tool(),
    loops: [openLoop()],
    wcsOrigin: { x: 0, y: 0, z: 0 },
    stockBounds: STOCK_BOUNDS,
    ...over,
  }
}

function movesWithRole(moves: ToolpathMove[], role: string): ToolpathMove[] {
  return moves.filter(move => move.role === role)
}

describe('open contour side and travel contract', () => {
  it('reverses travel for a left-hand cutter without changing the selected physical side', () => {
    const build = (direction: 'climb' | 'conventional', cutHand: 'right' | 'left') =>
      buildContourToolpath(payload({
        params: params({ openSide: 'right', direction }),
        tool: { ...tool(), cutHand },
      }))
    const rightClimb = build('climb', 'right')
    const rightConventional = build('conventional', 'right')
    expect(rightClimb).not.toEqual(rightConventional)
    expect(build('climb', 'left')).toEqual(rightConventional)
    expect(build('conventional', 'left')).toEqual(rightClimb)
  })

  for (const testCase of [
    // WO-1896: climb keeps the chain (the part) on the cutter's right.
    { side: 'right', direction: 'conventional', y: 47, firstX: 10, lastX: 90 },
    { side: 'left', direction: 'climb', y: 53, firstX: 10, lastX: 90 },
    { side: 'left', direction: 'conventional', y: 53, firstX: 90, lastX: 10 },
    { side: 'right', direction: 'climb', y: 47, firstX: 90, lastX: 10 },
  ] as const) {
    it(`${testCase.side} + ${testCase.direction} preserves physical side and resolves travel`, () => {
      const moves = buildContourToolpath(payload({
        params: params({ openSide: testCase.side, direction: testCase.direction }),
      }))
      const leadIn = movesWithRole(moves, 'lead_in')[0]
      const cuts = movesWithRole(moves, 'cut')
      expect(leadIn).toMatchObject({ x: testCase.firstX, y: testCase.y })
      expect(cuts[cuts.length - 1]).toMatchObject({ x: testCase.lastX, y: testCase.y })
    })
  }

  it('defaults absent openSide to right', () => {
    const moves = buildContourToolpath(payload({
      params: params({ openSide: undefined }),
    }))
    expect(movesWithRole(moves, 'cut').every(move => move.y === 47)).toBe(true)
  })
})

describe('open contour safe entry and pass cycles', () => {
  it('plunges outside stock, uses dedicated lead rates, exits outside, then retracts there', () => {
    const moves = buildContourToolpath(payload())
    const entry = moves[0]
    const plunge = movesWithRole(moves, 'plunge')[0]
    const leadIn = movesWithRole(moves, 'lead_in')[0]
    const leadOut = movesWithRole(moves, 'lead_out')[0]
    expect(entry.x).toBeLessThan(-3)
    expect(plunge).toMatchObject({ x: entry.x, y: entry.y, feed: 300, role: 'plunge' })
    expect(leadIn).toMatchObject({ x: 10, y: 47, feed: 700, role: 'lead_in' })
    expect(leadOut.x).toBeGreaterThan(103)
    expect(leadOut.feed).toBe(650)
    const leadOutIndex = moves.indexOf(leadOut)
    expect(moves[leadOutIndex + 1]).toMatchObject({
      type: 'rapid', x: leadOut.x, y: leadOut.y, z: 5,
    })
    expect(moves[leadOutIndex + 2]).toMatchObject({
      type: 'rapid', x: leadOut.x, y: leadOut.y, z: 10,
    })
  })

  it('does not duplicate the lead-in endpoint as a zero-length cut', () => {
    const moves = buildContourToolpath(payload())
    const leadInIndex = moves.findIndex(move => move.role === 'lead_in')
    expect(moves[leadInIndex]).toMatchObject({ x: 10, y: 47 })
    expect(moves[leadInIndex + 1]).toMatchObject({ role: 'cut', x: 90, y: 47 })
    expect(movesWithRole(moves, 'cut')).toHaveLength(1)
  })

  it('gives every finish and spring repeat at every scheduled depth a fresh safe cycle', () => {
    const moves = buildContourToolpath(payload({
      heights: heights(-4),
      passes: passes({ finishPasses: 2, springPasses: 1 }),
    }))
    // Two finish repeats at -2, then two finish + one spring at final -4.
    expect(movesWithRole(moves, 'plunge')).toHaveLength(5)
    expect(movesWithRole(moves, 'lead_in')).toHaveLength(5)
    expect(movesWithRole(moves, 'lead_out')).toHaveLength(5)
    expect(movesWithRole(moves, 'lead_out').every(move => move.x > 103)).toBe(true)
    expect(movesWithRole(moves, 'plunge').map(move => move.z)).toEqual([-2, -2, -4, -4, -4])
  })

  it('uses separate stock-edge cycles and offsets for rough and finish paths', () => {
    const moves = buildContourToolpath(payload({
      heights: heights(-4),
      passes: passes({ stockToLeave: 0.5, finishPasses: 1 }),
    }))
    // Rough at -2/-4 plus one final-depth finish.
    expect(movesWithRole(moves, 'lead_in')).toHaveLength(3)
    expect(movesWithRole(moves, 'lead_out')).toHaveLength(3)
    const cutYs = new Set(movesWithRole(moves, 'cut').map(move => move.y))
    expect(cutYs).toEqual(new Set([46.5, 47]))
  })

  it('ignores closed-loop overlap for open chains', () => {
    const noOverlap = buildContourToolpath(payload({
      passes: passes({ overlapMm: 0 }),
    }))
    const largeOverlap = buildContourToolpath(payload({
      passes: passes({ overlapMm: 50 }),
    }))
    expect(largeOverlap).toEqual(noOverlap)
  })

  it('emits deterministic independent cycles and depths for two open loops', () => {
    const twoLoopPayload = payload({
      heights: heights(-6),
      loops: [
        openLoop({
          id: 'open-1',
          points: [{ x: 10, y: 30 }, { x: 90, y: 30 }],
        }),
        openLoop({
          id: 'open-2',
          points: [{ x: 20, y: 70 }, { x: 80, y: 70 }],
        }),
      ],
      loopBottoms: { 'open-1': -2, 'open-2': -4 },
    })
    const first = buildContourToolpath(twoLoopPayload)
    const second = buildContourToolpath(twoLoopPayload)
    expect(second).toEqual(first)
    expect(movesWithRole(first, 'plunge').map(move => move.z)).toEqual([-2, -2, -4])
    expect(movesWithRole(first, 'lead_in').map(move => [move.x, move.y])).toEqual([
      [10, 27],
      [20, 67],
      [20, 67],
    ])
    expect(movesWithRole(first, 'lead_out')).toHaveLength(3)
  })
})

describe('open contour fail-loud validation', () => {
  for (const entryType of ['ramp_linear', 'ramp_helical', 'arc'] as const) {
    it(`rejects unsupported ${entryType} entry before toolpath generation`, () => {
      expect(() => buildContourToolpath(payload({
        linking: { ...linking, entryType },
      }))).toThrow(new RegExp(
        `Open contour: entry type "${entryType}" is not supported\\. Choose Plunge`,
        'i',
      ))
    })
  }

  it('rejects missing and invalid stock bounds', () => {
    expect(() => buildContourToolpath(payload({ stockBounds: undefined })))
      .toThrow(/stock XY bounds are required/i)
    expect(() => buildContourToolpath(payload({
      stockBounds: { min: { x: 0, y: 0 }, max: { x: 0, y: 100 } },
    }))).toThrow(/stock XY bounds are invalid/i)
  })

  it('rejects tabs and chains with fewer than two usable points', () => {
    expect(() => buildContourToolpath(payload({
      params: params({ tabs: true }),
    }))).toThrow(/tabs are not supported/i)
    expect(() => buildContourToolpath(payload({
      loops: [openLoop({ points: [{ x: 10, y: 50 }, { x: 10, y: 50 }] })],
    }))).toThrow(/fewer than two usable points/i)
  })

  it('rejects stale, closed, and mixed explicit selections', () => {
    expect(() => buildContourToolpath(payload({
      params: params({ loopIds: ['missing'] }),
    }))).toThrow(/no longer exists/i)
    expect(() => buildContourToolpath(payload({
      params: params({ loopIds: ['closed-1'] }),
      loops: [openLoop(), closedLoop()],
    }))).toThrow(/closed or mixed profile/i)
    expect(() => buildContourToolpath(payload({
      params: params({ loopIds: ['open-1', 'closed-1'] }),
      loops: [openLoop(), closedLoop()],
    }))).toThrow(/closed or mixed profile/i)
  })

  it('rejects a chain outside stock whose endpoint tangent points back through stock', () => {
    expect(() => buildContourToolpath(payload({
      loops: [openLoop({
        points: [{ x: -10, y: 50 }, { x: -20, y: 50 }],
      })],
    }))).toThrow(/no safe outside lead fits/i)
  })

  it('accepts an already-outside endpoint whose tangent continues outward', () => {
    const moves = buildContourToolpath(payload({
      loops: [openLoop({
        points: [{ x: -10, y: 50 }, { x: 10, y: 50 }],
      })],
    }))
    expect(moves[0].x).toBeLessThan(-10)
    expect(movesWithRole(moves, 'lead_in')[0]).toMatchObject({ x: -10, y: 47 })
    expect(movesWithRole(moves, 'lead_out')[0].x).toBeGreaterThan(103)
  })

  it('extends diagonal entry and exit beyond the expanded stock at opposite corners', () => {
    const moves = buildContourToolpath(payload({
      loops: [openLoop({
        points: [{ x: 10, y: 10 }, { x: 90, y: 90 }],
      })],
    }))
    const entry = moves[0]
    const exit = movesWithRole(moves, 'lead_out')[0]
    expect(entry.x < -3 || entry.y < -3).toBe(true)
    expect(exit.x > 103 || exit.y > 103).toBe(true)
  })
})

describe('closed contour compatibility', () => {
  it("absent pathType is byte-identical to explicit pathType 'closed'", () => {
    const base = payload({
      params: params({
        pathType: undefined,
        openSide: undefined,
        loopIds: [],
      }),
      loops: [closedLoop()],
      passes: passes({ stockToLeave: 0.5, finishPasses: 1 }),
      stockBounds: undefined,
    })
    const explicit = {
      ...base,
      params: { ...base.params, pathType: 'closed' as const },
    }
    expect(buildContourToolpath(explicit)).toEqual(buildContourToolpath(base))
  })
})
