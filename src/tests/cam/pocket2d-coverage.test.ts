import { describe, expect, it } from 'vitest'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { ensureClipperReady, offsetLoop } from '../../lib/cam/face2d/clipperOffset'
import { centroid, distToPolyBoundary, ensureCCW, pointInPolygon, signedArea } from '../../lib/cam/geometry'
import type { LoopData, PocketParams, PocketWorkerPayload } from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool, ToolpathMove } from '../../types'

await ensureClipperReady()

type Pt2 = { x: number; y: number }

const TOOL_RADIUS = 3
const BOTTOM_Z = -5

function makeTool(): Tool {
  return {
    id: 'tool-pocket-coverage', name: '6 mm flat endmill', type: 'flat_end_mill',
    diameter: TOOL_RADIUS * 2, fluteLength: 20, shankDiameter: 6, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: {
      default: { rpm: 12000, feedRate: 900, plungeRate: 250, depthOfCut: 5, stepover: 2.4 },
    },
  } as Tool
}

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute',
  retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute',
  bottomHeight: BOTTOM_Z, bottomHeightMode: 'absolute',
}

const linking: LinkingParams = {
  entryType: 'ramp_linear', rampAngle: 3, rampLength: 8,
  leadInRadius: 0, leadOutRadius: 0,
  retractType: 'minimum', transitionType: 'avoid_stock',
}

function rectangle(
  id: string, x0: number, y0: number, x1: number, y1: number,
  type: 'contour' | 'hole' = 'contour',
): LoopData {
  return {
    id, closed: true, type,
    points: [{ x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 }],
  }
}

function circle(id: string, cx: number, cy: number, radius: number, count = 72): LoopData {
  return {
    id, closed: true, type: 'hole',
    points: Array.from({ length: count }, (_, i) => {
      const angle = 2 * Math.PI * i / count
      return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
    }),
  }
}

const OUTER = rectangle('outer', 0, 0, 62, 40)
const ISLAND_CENTER = { x: 31, y: 20 }
const ISLAND_RADIUS = 7
const ISLAND = circle('island', ISLAND_CENTER.x, ISLAND_CENTER.y, ISLAND_RADIUS)
const NARROW_OUTER = rectangle('narrow-outer', 0, 0, 40, 40)
// The right-side physical gaps are 6.6 mm (machinable with R3 + 0.2 stock)
// and 5.5 mm (not machinable: the two protected cutter envelopes overlap).
const NARROW_FEASIBLE_ISLAND = rectangle('narrow-feasible', 26, 14, 33.4, 26, 'hole')
const NARROW_IMPOSSIBLE_ISLAND = rectangle('narrow-impossible', 26, 14, 34.5, 26, 'hole')
const CLOSE_ISLAND_A = rectangle('close-island-a', 8, 14, 14, 26, 'hole')
const CLOSE_ISLAND_B = rectangle('close-island-b', 19.5, 14, 25.5, 26, 'hole')
const CONCAVE_OUTER: LoopData = {
  id: 'concave-outer', closed: true, type: 'contour',
  points: [
    { x: 0, y: 0 }, { x: 100, y: 0 }, { x: 100, y: 100 }, { x: 0, y: 100 },
    { x: 0, y: 70 }, { x: 70, y: 70 }, { x: 70, y: 30 }, { x: 0, y: 30 },
  ],
}
const CONCAVE_ISLAND: LoopData = {
  id: 'concave-island', closed: true, type: 'hole',
  points: [
    { x: 10, y: 10 }, { x: 85, y: 10 }, { x: 85, y: 90 }, { x: 10, y: 90 },
    { x: 10, y: 82 }, { x: 77, y: 82 }, { x: 77, y: 18 }, { x: 10, y: 18 },
  ],
}
const CROSSING_ISLAND = rectangle('crossing-island', 35, 12, 45, 28, 'hole')

function makePayload(overrides: {
  stockToLeave?: number
  finishContour?: boolean
  loops?: LoopData[]
  stayDown?: boolean
  direction?: 'climb' | 'conventional'
  fillStrategy?: 'outside_in' | 'inside_out'
  entryType?: LinkingParams['entryType']
} = {}): PocketWorkerPayload {
  const stockToLeave = overrides.stockToLeave ?? 0.2
  const passes: PassParams = {
    stepdown: 5, stepover: 2.4, stockToLeave,
    floorStockToLeave: 0, finishPasses: 1, springPasses: 0,
  }
  const params: PocketParams = {
    geometryId: 'geometry', loopIds: (overrides.loops ?? [OUTER, ISLAND]).map(loop => loop.id),
    direction: overrides.direction ?? 'climb', orderStrategy: 'by_depth',
    fillStrategy: overrides.fillStrategy ?? 'outside_in',
    floorStockToLeave: 0, finishContour: overrides.finishContour ?? false,
    helixDiameter: 80, overlapMm: 0.5, stepoverLeadIn: 'arc',
    stayDown: overrides.stayDown ?? false, stayDownLift: 0.6,
  }
  return {
    opId: 'op-pocket-coverage', setupId: 'setup', params, heights, passes,
    linking: {
      ...linking,
      entryType: overrides.entryType ??
        (overrides.fillStrategy === 'inside_out' ? 'ramp_helical' : 'ramp_linear'),
    },
    tool: makeTool(), loops: overrides.loops ?? [OUTER, ISLAND],
    wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function distancePointToSegment(point: Pt2, a: Pt2, b: Pt2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  const rawT = lengthSq < 1e-12 ? 0 : ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  const t = Math.max(0, Math.min(1, rawT))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

function distanceToBottomFeedPath(point: Pt2, moves: ToolpathMove[]): number {
  let best = Infinity
  for (let i = 1; i < moves.length; i++) {
    const from = moves[i - 1]
    const to = moves[i]
    if (to.type !== 'feed') continue
    if (Math.abs(from.z - BOTTOM_Z) > 1e-7 || Math.abs(to.z - BOTTOM_Z) > 1e-7) continue
    best = Math.min(best, distancePointToSegment(point, from, to))
  }
  return best
}

function bottomEngagedPoints(moves: ToolpathMove[]): Pt2[] {
  return moves
    .filter(move => move.type === 'feed' && Math.abs(move.z - BOTTOM_Z) <= 1e-7)
    .map(move => ({ x: move.x, y: move.y }))
}

function distanceToClosedPath(point: Pt2, path: Pt2[]): number {
  let best = Infinity
  for (let i = 0; i < path.length; i++)
    best = Math.min(best, distancePointToSegment(point, path[i], path[(i + 1) % path.length]))
  return best
}

function longestBottomCutRunNearPath(moves: ToolpathMove[], path: Pt2[], tolerance: number): Pt2[] {
  let current: Pt2[] = []
  let longest: Pt2[] = []
  for (const move of moves) {
    const point = { x: move.x, y: move.y }
    const matches = move.type === 'feed' && move.role === 'cut' &&
      Math.abs(move.z - BOTTOM_Z) <= 1e-7 && distanceToClosedPath(point, path) <= tolerance
    if (matches) {
      current.push(point)
      if (current.length > longest.length) longest = [...current]
    } else {
      current = []
    }
  }
  return longest
}

function bottomFeedSweepSamples(moves: ToolpathMove[], maxStep = 0.05): Pt2[] {
  const samples: Pt2[] = []
  for (let i = 1; i < moves.length; i++) {
    const from = moves[i - 1]
    const to = moves[i]
    if (to.type !== 'feed') continue
    if (Math.abs(from.z - BOTTOM_Z) > 1e-7 || Math.abs(to.z - BOTTOM_Z) > 1e-7) continue
    const length = Math.hypot(to.x - from.x, to.y - from.y)
    const steps = Math.max(1, Math.ceil(length / maxStep))
    for (let step = 0; step <= steps; step++) {
      const t = step / steps
      samples.push({ x: from.x + t * (to.x - from.x), y: from.y + t * (to.y - from.y) })
    }
  }
  return samples
}

describe('Pocket 2D coverage and linking regressions', () => {
  it('derives every rough and finish ring direction from the selected tool hand', () => {
    const build = (direction: 'climb' | 'conventional', cutHand: 'right' | 'left') => {
      const p = makePayload({ direction, loops: [OUTER], finishContour: true })
      p.tool = { ...p.tool, cutHand }
      return buildPocketToolpath(p)
    }
    const rightClimb = build('climb', 'right')
    const rightConventional = build('conventional', 'right')
    expect(rightClimb).not.toEqual(rightConventional)
    expect(build('climb', 'left')).toEqual(rightConventional)
    expect(build('conventional', 'left')).toEqual(rightClimb)
  })

  it('emits every exact vertex of a rectangular offset ring instead of shortcutting corners', () => {
    const moves = buildPocketToolpath(makePayload({ loops: [OUTER], finishContour: false }))
    const inset = TOOL_RADIUS + 0.2
    const expectedCorners = [
      { x: inset, y: inset },
      { x: 62 - inset, y: inset },
      { x: 62 - inset, y: 40 - inset },
      { x: inset, y: 40 - inset },
    ]
    const cutPoints = moves.filter(move => move.role === 'cut' && Math.abs(move.z - BOTTOM_Z) <= 1e-7)

    for (const corner of expectedCorners) {
      const exact = cutPoints.some(move =>
        Math.abs(move.x - corner.x) <= 1e-9 && Math.abs(move.y - corner.y) <= 1e-9)
      expect(exact, `missing exact offset corner (${corner.x}, ${corner.y})`).toBe(true)
    }
  })

  it('sweeps the complete rough island boundary, including both equators', () => {
    const stock = 0.2
    const moves = buildPocketToolpath(makePayload({ stockToLeave: stock, finishContour: false }))
    const materialBoundaryRadius = ISLAND_RADIUS + stock

    for (let degrees = 0; degrees < 360; degrees += 10) {
      const angle = degrees * Math.PI / 180
      const target = {
        x: ISLAND_CENTER.x + materialBoundaryRadius * Math.cos(angle),
        y: ISLAND_CENTER.y + materialBoundaryRadius * Math.sin(angle),
      }
      expect(
        distanceToBottomFeedPath(target, moves),
        `rough island wall is not swept at ${degrees} degrees`,
      ).toBeLessThanOrEqual(TOOL_RADIUS + 0.01)
    }
  })

  it('emits a complete island finish contour at the tool-radius centerline', () => {
    const stock = 0.8
    const moves = buildPocketToolpath(makePayload({ stockToLeave: stock, finishContour: true }))
    const finishLoops = offsetLoop(
      ensureCCW(ISLAND.points as Pt2[]) as Pt2[],
      TOOL_RADIUS,
      0,
    )
    expect(finishLoops.length).toBeGreaterThan(0)

    // A full finish contour must pass close to every vertex of the exact finish
    // offset. The rough island contour is 0.8 mm farther out and cannot satisfy it.
    for (const expected of finishLoops[0] as Pt2[]) {
      expect(
        distanceToBottomFeedPath(expected, moves),
        `island finish centerline is missing near (${expected.x}, ${expected.y})`,
      ).toBeLessThanOrEqual(0.03)
    }
  })

  it.each([
    { direction: 'climb' as const, expectedSign: -1 },
    { direction: 'conventional' as const, expectedSign: 1 },
  ])('winds the island finish contour correctly for $direction milling', ({ direction, expectedSign }) => {
    const moves = buildPocketToolpath(makePayload({
      stockToLeave: 0.8,
      finishContour: true,
      direction,
    }))
    const finishPath = offsetLoop(
      ensureCCW(ISLAND.points as Pt2[]) as Pt2[],
      TOOL_RADIUS,
      0,
    )[0] as Pt2[]
    const finishRun = longestBottomCutRunNearPath(moves, finishPath, 0.03)

    expect(finishRun.length).toBeGreaterThan(50)
    expect(Math.sign(signedArea(finishRun))).toBe(expectedSign)
  })

  it('never puts an engaged endpoint inside the island gouge keepout', () => {
    const moves = buildPocketToolpath(makePayload({ stockToLeave: 0.8, finishContour: true }))
    const keepOutLoops = offsetLoop(
      ensureCCW(ISLAND.points as Pt2[]) as Pt2[],
      TOOL_RADIUS - 0.01,
      0,
    )
    expect(keepOutLoops.length).toBeGreaterThan(0)
    const gouges = bottomEngagedPoints(moves).filter(point => pointInPolygon(point, keepOutLoops[0] as Pt2[]))
    expect(gouges).toEqual([])
  })

  it('finishes the profile-ramp cleanup lap before the first stepover', () => {
    const moves = buildPocketToolpath(makePayload({ finishContour: false }))
    const lastEntryIndex = moves.reduce(
      (latest, move, index) => move.role === 'ramp' ? index : latest,
      -1,
    )
    expect(lastEntryIndex).toBeGreaterThanOrEqual(0)
    const firstStepoverIndex = moves.findIndex(
      (move, index) => index > lastEntryIndex && move.role === 'stepover',
    )
    expect(firstStepoverIndex).toBeGreaterThan(lastEntryIndex + 1)

    const cleanupMoves = moves.slice(lastEntryIndex + 1, firstStepoverIndex)
    expect(cleanupMoves.every(move => move.type === 'feed' && move.role === 'cut')).toBe(true)
    expect(cleanupMoves.every(move => Math.abs(move.z - BOTTOM_Z) <= 1e-7)).toBe(true)
    expect(cleanupMoves.some(move => move.role === 'plunge' || move.type === 'rapid')).toBe(false)
  })

  it('keeps the entire cutter sweep between both walls in a narrow but machinable gap', () => {
    const stock = 0.2
    const moves = buildPocketToolpath(makePayload({
      loops: [NARROW_OUTER, NARROW_FEASIBLE_ISLAND],
      stockToLeave: stock,
      finishContour: false,
    }))
    // Physical no-gouge invariant: the complete cutter disk, not just its
    // centerline endpoints, must remain clear of both walls. The polygonized
    // round offset may consume a few microns of nominal rough stock at corners,
    // so wall safety is asserted against the actual cutter radius.
    const requiredClearance = TOOL_RADIUS - 0.01
    const sweepSamples = bottomFeedSweepSamples(moves)
    expect(sweepSamples.length).toBeGreaterThan(0)

    for (const point of sweepSamples) {
      const outerClearance = -distToPolyBoundary(point, NARROW_OUTER.points as Pt2[])
      const islandClearance = distToPolyBoundary(point, NARROW_FEASIBLE_ISLAND.points as Pt2[])
      expect(outerClearance).toBeGreaterThanOrEqual(requiredClearance)
      expect(islandClearance).toBeGreaterThanOrEqual(requiredClearance)
    }
  })

  it('fails loudly when a full island contour cannot fit through the physical gap', () => {
    expect(() => buildPocketToolpath(makePayload({
      loops: [NARROW_OUTER, NARROW_IMPOSSIBLE_ISLAND],
      stockToLeave: 0.2,
      finishContour: true,
    }))).toThrowError(/island clearance is too narrow.*wall-overcutting toolpath/i)
  })

  it('fails loudly when complete contours for two close islands would overlap', () => {
    expect(() => buildPocketToolpath(makePayload({
      loops: [NARROW_OUTER, CLOSE_ISLAND_A, CLOSE_ISLAND_B],
      stockToLeave: 0.2,
      finishContour: false,
    }))).toThrowError(/clearance between islands is too narrow.*incomplete island toolpath/i)
  })

  it('keeps a valid concave island whose arithmetic centroid lies in the outer notch', () => {
    const islandCentroid = centroid(CONCAVE_ISLAND.points as Pt2[])
    expect(pointInPolygon(islandCentroid, CONCAVE_OUTER.points as Pt2[])).toBe(false)

    const payload = makePayload({
      loops: [CONCAVE_OUTER, CONCAVE_ISLAND],
      stockToLeave: 0.2,
      finishContour: false,
    })
    payload.linking = { ...linking, entryType: 'ramp_linear' }
    const moves = buildPocketToolpath(payload)
    const roughIslandPaths = offsetLoop(
      ensureCCW(CONCAVE_ISLAND.points as Pt2[]) as Pt2[],
      TOOL_RADIUS + 0.2,
      0,
    )
    expect(roughIslandPaths.length).toBeGreaterThan(0)
    for (const path of roughIslandPaths) for (const point of path)
      expect(distanceToBottomFeedPath(point, moves)).toBeLessThanOrEqual(0.03)

    const sweepSamples = bottomFeedSweepSamples(moves)
    expect(sweepSamples.length).toBeGreaterThan(0)
    for (const point of sweepSamples) {
      expect(-distToPolyBoundary(point, CONCAVE_OUTER.points as Pt2[]))
        .toBeGreaterThanOrEqual(TOOL_RADIUS - 0.01)
      expect(distToPolyBoundary(point, CONCAVE_ISLAND.points as Pt2[]))
        .toBeGreaterThanOrEqual(TOOL_RADIUS - 0.01)
    }
  })

  it('fails loudly when a selected island crosses and is unassigned to the outer boundary', () => {
    expect(() => buildPocketToolpath(makePayload({
      loops: [NARROW_OUTER, CROSSING_ISLAND],
      stockToLeave: 0.2,
      finishContour: false,
    }))).toThrowError(/selected island loop.*not fully contained.*Refusing to silently omit/i)
  })
})
