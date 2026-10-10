import { describe, expect, it } from 'vitest'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { ensureClipperReady, offsetLoop } from '../../lib/cam/face2d/clipperOffset'
import { ensureCCW, largestLoop, pointInPolygon, signedArea } from '../../lib/cam/geometry'
import type { LoopData, PocketParams, PocketWorkerPayload } from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool, ToolpathMove } from '../../types'

await ensureClipperReady()

type Pt2 = { x: number; y: number }

const TOOL_RADIUS = 3
const STOCK_TO_LEAVE = 0.2
const RASTER_STEP = 0.1

function rectangle(id: string, width: number, height: number): LoopData {
  return rectangleAt(id, 0, 0, width, height)
}

function rectangleAt(
  id: string, x0: number, y0: number, width: number, height: number,
): LoopData {
  return {
    id,
    closed: true,
    type: 'contour',
    points: [
      { x: x0, y: y0 }, { x: x0 + width, y: y0 },
      { x: x0 + width, y: y0 + height }, { x: x0, y: y0 + height },
    ],
  }
}

function circle(
  id: string, type: 'contour' | 'hole', cx: number, cy: number, radius: number,
  samples = 72,
): LoopData {
  return {
    id,
    closed: true,
    type,
    points: Array.from({ length: samples }, (_, index) => {
      const angle = 2 * Math.PI * index / samples
      return { x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) }
    }),
  }
}

function makeTool(fluteLength = 30, diameter = TOOL_RADIUS * 2): Tool {
  return {
    id: 'profile-ramp-tool',
    name: '6 mm flat endmill',
    type: 'flat_end_mill',
    diameter,
    fluteLength,
    shankDiameter: diameter,
    overallLength: Math.max(60, fluteLength + 20),
    numberOfFlutes: 2,
    material: 'carbide',
    coating: 'none',
    notes: '',
    feedsAndSpeeds: {
      default: {
        rpm: 12000,
        feedRate: 900,
        plungeRate: 250,
        depthOfCut: 2,
        stepover: 2.4,
      },
    },
  } as Tool
}

function makePayload(overrides: {
  entryType?: LinkingParams['entryType']
  rampAngle?: number
  direction?: 'climb' | 'conventional'
  orderStrategy?: 'by_depth' | 'by_region'
  bottomZ?: number
  stepdown?: number
  stepover?: number
  stockToLeave?: number
  floorStockToLeave?: number
  overlapMm?: number
  loops?: LoopData[]
  tool?: Tool
} = {}): PocketWorkerPayload {
  const loops = overrides.loops ?? [rectangle('outer', 30, 20)]
  const heights: HeightParams = {
    clearanceHeight: 10,
    clearanceHeightMode: 'absolute',
    retractHeight: 5,
    feedHeight: 1,
    topHeight: 0,
    topHeightMode: 'absolute',
    bottomHeight: overrides.bottomZ ?? -4,
    bottomHeightMode: 'absolute',
  }
  const passes: PassParams = {
    stepdown: overrides.stepdown ?? 2,
    stepover: overrides.stepover ?? 2.4,
    stockToLeave: overrides.stockToLeave ?? STOCK_TO_LEAVE,
    floorStockToLeave: overrides.floorStockToLeave ?? 0,
    finishPasses: 1,
    springPasses: 0,
  }
  const params: PocketParams = {
    geometryId: 'geometry',
    loopIds: loops.map(loop => loop.id),
    direction: overrides.direction ?? 'climb',
    orderStrategy: overrides.orderStrategy ?? 'by_depth',
    fillStrategy: 'outside_in',
    floorStockToLeave: 0,
    finishContour: false,
    helixDiameter: 80,
    overlapMm: overrides.overlapMm ?? 0,
    stepoverLeadIn: 'none',
    stayDown: false,
    stayDownLift: 0.5,
  }
  const linking: LinkingParams = {
    entryType: overrides.entryType ?? 'ramp_linear',
    rampAngle: overrides.rampAngle ?? 2,
    rampLength: 10,
    leadInRadius: 0,
    leadOutRadius: 0,
    retractType: 'minimum',
    transitionType: 'avoid_stock',
  }
  return {
    opId: 'outside-in-entry',
    setupId: 'setup',
    params,
    heights,
    passes,
    linking,
    tool: overrides.tool ?? makeTool(),
    loops,
    wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

interface RampGroup {
  start: number
  end: number
  targetZ: number
}

function rampGroups(moves: ToolpathMove[]): RampGroup[] {
  const groups: RampGroup[] = []
  for (let index = 0; index < moves.length; index++) {
    if (moves[index].role !== 'ramp') continue
    const start = index
    while (index + 1 < moves.length && moves[index + 1].role === 'ramp') index++
    groups.push({ start, end: index, targetZ: moves[index].z })
  }
  return groups
}

function segmentLength(a: ToolpathMove, b: ToolpathMove): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

function segmentIntersectionT(a: Pt2, b: Pt2, c: Pt2, d: Pt2): number | null {
  const abX = b.x - a.x
  const abY = b.y - a.y
  const cdX = d.x - c.x
  const cdY = d.y - c.y
  const denominator = abX * cdY - abY * cdX
  if (Math.abs(denominator) < 1e-12) return null
  const t = ((c.x - a.x) * cdY - (c.y - a.y) * cdX) / denominator
  const u = ((c.x - a.x) * abY - (c.y - a.y) * abX) / denominator
  if (t < -1e-9 || t > 1 + 1e-9 || u < -1e-9 || u > 1 + 1e-9) return null
  return Math.max(0, Math.min(1, t))
}

function segmentEntersPolygon(a: Pt2, b: Pt2, polygon: Pt2[]): boolean {
  const splitTs = [0, 1]
  for (let edge = 0; edge < polygon.length; edge++) {
    const hit = segmentIntersectionT(a, b, polygon[edge], polygon[(edge + 1) % polygon.length])
    if (hit !== null) splitTs.push(hit)
  }
  splitTs.sort((left, right) => left - right)
  for (let index = 1; index < splitTs.length; index++) {
    if (splitTs[index] - splitTs[index - 1] <= 1e-10) continue
    const t = (splitTs[index] + splitTs[index - 1]) / 2
    if (pointInPolygon({
      x: a.x + t * (b.x - a.x),
      y: a.y + t * (b.y - a.y),
    }, polygon)) return true
  }
  return false
}

function distancePointToSegment(point: Pt2, a: Pt2, b: Pt2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSq = dx * dx + dy * dy
  const rawT = lengthSq < 1e-12 ? 0 : ((point.x - a.x) * dx + (point.y - a.y) * dy) / lengthSq
  const t = Math.max(0, Math.min(1, rawT))
  return Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy))
}

function distanceToClosedPath(point: Pt2, path: Pt2[]): number {
  let best = Infinity
  for (let index = 0; index < path.length; index++)
    best = Math.min(best, distancePointToSegment(point, path[index], path[(index + 1) % path.length]))
  return best
}

// Rasterizes the exact swept capsule (stadium shape) of a tool-radius disk
// dragged along a segment, by testing each candidate grid cell's center
// against distance-to-segment directly. Mathematically equivalent to (and
// more precise than) sampling many points along the segment and rasterizing
// a full disk at each one -- that finely-sampled-disk approach was measured
// (2026-07-22, isolated 3-run median) to cost ~13.6s of this file's ~14.0s
// test-execution time, because adjacent disks at a 0.05 mm sample spacing
// against a 3 mm tool radius overlap by >98%, so the same cells were being
// re-inserted into the Set thousands of times per segment. Direct capsule
// rasterization touches each candidate cell exactly once.
function addSegmentSweep(cells: Set<string>, from: Pt2, to: Pt2): void {
  const minX = Math.floor((Math.min(from.x, to.x) - TOOL_RADIUS) / RASTER_STEP)
  const maxX = Math.ceil((Math.max(from.x, to.x) + TOOL_RADIUS) / RASTER_STEP)
  const minY = Math.floor((Math.min(from.y, to.y) - TOOL_RADIUS) / RASTER_STEP)
  const maxY = Math.ceil((Math.max(from.y, to.y) + TOOL_RADIUS) / RASTER_STEP)
  for (let ix = minX; ix <= maxX; ix++) {
    for (let iy = minY; iy <= maxY; iy++) {
      const x = (ix + 0.5) * RASTER_STEP
      const y = (iy + 0.5) * RASTER_STEP
      if (distancePointToSegment({ x, y }, from, to) <= TOOL_RADIUS + 1e-9)
        cells.add(`${ix},${iy}`)
    }
  }
}

function rasterSweep(moves: ToolpathMove[], start: number, end: number): Set<string> {
  const cells = new Set<string>()
  for (let index = start; index <= end; index++) {
    const from = moves[index - 1]
    const to = moves[index]
    if (!from || !to) continue
    addSegmentSweep(cells, from, to)
  }
  return cells
}

function isCoveredWithinRasterResolution(cell: string, covered: Set<string>): boolean {
  const [x, y] = cell.split(',').map(Number)
  for (let dx = -1; dx <= 1; dx++)
    for (let dy = -1; dy <= 1; dy++)
      if (covered.has(`${x + dx},${y + dy}`)) return true
  return false
}

function assertProfileRampDepthContract(
  moves: ToolpathMove[], group: RampGroup, expectedSurfaceZ: number,
  cleanupLengthBounds: { min: number; max: number } = { min: 60, max: 90 },
): void {
  const approach = moves[group.start - 1]
  expect(approach.type).toBe('rapid')
  expect(approach.z).toBeCloseTo(expectedSurfaceZ, 9)

  const ramp = moves.slice(group.start, group.end + 1)
  expect(ramp.every(move => move.role === 'ramp')).toBe(true)
  expect(ramp.every((move, index) => index === 0 || move.z <= ramp[index - 1].z + 1e-9)).toBe(true)
  expect(ramp.at(-1)?.z).toBeCloseTo(group.targetZ, 9)

  const firstStepover = moves.findIndex(
    (move, index) => index > group.end && move.role === 'stepover',
  )
  expect(firstStepover).toBeGreaterThan(group.end + 1)
  const cleanup = moves.slice(group.end + 1, firstStepover)
  expect(cleanup.length).toBeGreaterThan(20)
  expect(cleanup.every(move => move.type === 'feed' && move.role === 'cut')).toBe(true)
  expect(cleanup.every(move => Math.abs(move.z - group.targetZ) <= 1e-9)).toBe(true)

  const rampEnd = moves[group.end]
  const cleanupEnd = moves[firstStepover - 1]
  expect(Math.hypot(cleanupEnd.x - rampEnd.x, cleanupEnd.y - rampEnd.y)).toBeLessThan(1e-6)

  let cleanupLength = 0
  for (let index = group.end + 1; index < firstStepover; index++)
    cleanupLength += segmentLength(moves[index - 1], moves[index])
  expect(cleanupLength).toBeGreaterThan(cleanupLengthBounds.min)
  expect(cleanupLength).toBeLessThan(cleanupLengthBounds.max)

  // Physical cutter-sweep proof at 0.1 mm raster resolution. Every cell swept
  // by the descending cutter must be swept again by the at-depth cleanup lap
  // before the first stepover. Neighbor tolerance is <= 0.142 mm diagonally.
  const rampSweep = rasterSweep(moves, group.start, group.end)
  const cleanupSweep = rasterSweep(moves, group.end + 1, firstStepover - 1)
  const uncovered = [...rampSweep].filter(cell => !isCoveredWithinRasterResolution(cell, cleanupSweep))
  expect(uncovered, `uncovered ramp footprint at Z ${group.targetZ}`).toEqual([])
}

describe.each([
  { direction: 'climb' as const, orderStrategy: 'by_depth' as const },
  { direction: 'conventional' as const, orderStrategy: 'by_depth' as const },
  { direction: 'climb' as const, orderStrategy: 'by_region' as const },
  { direction: 'conventional' as const, orderStrategy: 'by_region' as const },
])('Pocket 2D outside-in Profile Ramp: $direction, $orderStrategy', ({ direction, orderStrategy }) => {
  const moves = buildPocketToolpath(makePayload({ direction, orderStrategy }))
  const groups = rampGroups(moves)

  it('starts each depth at the current material surface and never emits helix/plunge', () => {
    expect(groups.map(group => group.targetZ)).toEqual([-2, -4])
    expect(moves.some(move => move.role === 'helix' || move.role === 'plunge')).toBe(false)
    expect(moves[groups[0].start - 1].z).toBeCloseTo(0, 9)
    expect(moves[groups[1].start - 1].z).toBeCloseTo(-2, 9)
  })

  it('physically recuts every descending cutter footprint before any stepover', () => {
    assertProfileRampDepthContract(moves, groups[0], 0)
    assertProfileRampDepthContract(moves, groups[1], -2)
  })
})

describe('Pocket 2D outside-in Profile Ramp on complex outer geometry', () => {
  it('recuts the complete descending footprint on a concave pocket before stepover', () => {
    const concave: LoopData = {
      id: 'concave-outer',
      closed: true,
      type: 'contour',
      points: [
        { x: 0, y: 0 }, { x: 36, y: 0 }, { x: 36, y: 30 }, { x: 0, y: 30 },
        { x: 0, y: 20 }, { x: 20, y: 20 }, { x: 20, y: 10 }, { x: 0, y: 10 },
      ],
    }
    const moves = buildPocketToolpath(makePayload({
      bottomZ: -2,
      loops: [concave],
    }))
    const [group] = rampGroups(moves)
    expect(group).toBeDefined()
    assertProfileRampDepthContract(moves, group, 0, { min: 100, max: 180 })
  })

  it('closes the planned first lobe before moving to another split-generation lobe', () => {
    const splitOuter: LoopData = {
      id: 'split-outer',
      closed: true,
      type: 'contour',
      points: [
        { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 45, y: 14 }, { x: 50, y: 0 },
        { x: 110, y: 0 }, { x: 110, y: 30 }, { x: 50, y: 30 }, { x: 45, y: 16 },
        { x: 40, y: 30 }, { x: 0, y: 30 },
      ],
    }
    const firstGeneration = offsetLoop(
      ensureCCW(splitOuter.points as Pt2[]) as Pt2[],
      -(TOOL_RADIUS + STOCK_TO_LEAVE),
      0,
    ) as Pt2[][]
    expect(firstGeneration.length).toBeGreaterThanOrEqual(2)
    const areas = firstGeneration
      .map(loop => Math.abs(signedArea(loop)))
      .sort((left, right) => right - left)
    expect(areas[0] - areas[1]).toBeGreaterThan(1)
    const actualLargestFirstRing = largestLoop(firstGeneration)

    const moves = buildPocketToolpath(makePayload({
      bottomZ: -2,
      loops: [splitOuter],
    }))
    const [group] = rampGroups(moves)
    expect(group).toBeDefined()
    const firstNonCut = moves.findIndex(
      (move, index) => index > group.end && move.role !== 'cut',
    )
    expect(firstNonCut).toBeGreaterThan(group.end + 1)
    const cleanup = moves.slice(group.end + 1, firstNonCut)
    expect(cleanup.every(move => move.type === 'feed' && move.role === 'cut')).toBe(true)
    for (const move of moves.slice(group.start, group.end + 1))
      expect(distanceToClosedPath(move, actualLargestFirstRing)).toBeLessThan(1e-6)
    const rampEnd = moves[group.end]
    const cleanupEnd = moves[firstNonCut - 1]
    expect(Math.hypot(cleanupEnd.x - rampEnd.x, cleanupEnd.y - rampEnd.y)).toBeLessThan(1e-6)
    expect(moves[firstNonCut].type).toBe('rapid')

    const rampSweep = rasterSweep(moves, group.start, group.end)
    const cleanupSweep = rasterSweep(moves, group.end + 1, firstNonCut - 1)
    expect([...rampSweep].filter(cell => !isCoveredWithinRasterResolution(cell, cleanupSweep)))
      .toEqual([])
  })

  it('gives each disjoint outer region its own ramp and cleanup without a cross-region stepover', () => {
    const left = rectangleAt('left-region', 0, 0, 30, 20)
    const right = rectangleAt('right-region', 50, 0, 30, 20)
    const moves = buildPocketToolpath(makePayload({
      bottomZ: -2,
      loops: [left, right],
    }))
    const groups = rampGroups(moves)
    expect(groups).toHaveLength(2)
    for (const group of groups)
      assertProfileRampDepthContract(moves, group, 0)

    for (let index = 1; index < moves.length; index++) {
      if (moves[index].role !== 'stepover') continue
      expect(segmentLength(moves[index - 1], moves[index])).toBeLessThan(15)
    }
    const betweenEntries = moves.slice(groups[0].end + 1, groups[1].start)
    expect(betweenEntries.some(move => move.type === 'rapid' && move.z >= 10)).toBe(true)
  })
})

describe('Pocket 2D outside-in entry compatibility and edge cases', () => {
  it('plunges at the scheduled first-ring start and immediately cuts that ring', () => {
    const moves = buildPocketToolpath(makePayload({ entryType: 'plunge', bottomZ: -2 }))
    const plungeIndex = moves.findIndex(move => move.role === 'plunge')
    expect(plungeIndex).toBeGreaterThan(1)
    expect(moves.some(move => move.role === 'ramp' || move.role === 'helix')).toBe(false)

    const plunge = moves[plungeIndex]
    expect(moves[plungeIndex - 1].x).toBeCloseTo(plunge.x, 9)
    expect(moves[plungeIndex - 1].y).toBeCloseTo(plunge.y, 9)
    const inset = TOOL_RADIUS + STOCK_TO_LEAVE
    const distanceToExpectedRing = Math.min(
      Math.abs(plunge.x - inset), Math.abs(plunge.x - (30 - inset)),
      Math.abs(plunge.y - inset), Math.abs(plunge.y - (20 - inset)),
    )
    expect(distanceToExpectedRing).toBeLessThan(0.02)

    const firstStepover = moves.findIndex(
      (move, index) => index > plungeIndex && move.role === 'stepover',
    )
    expect(firstStepover).toBeGreaterThan(plungeIndex + 1)
    const firstLap = moves.slice(plungeIndex + 1, firstStepover)
    expect(firstLap.every(move => move.type === 'feed' && move.role === 'cut')).toBe(true)
    expect(Math.hypot(
      moves[firstStepover - 1].x - plunge.x,
      moves[firstStepover - 1].y - plunge.y,
    )).toBeLessThan(1e-6)
  })

  it('keeps a plunge start outside the expanded island keep-out', () => {
    const outer = rectangle('outer-with-island', 40, 30)
    const island = circle('island', 'hole', 20, 15, 4)
    const moves = buildPocketToolpath(makePayload({
      entryType: 'plunge',
      bottomZ: -2,
      loops: [outer, island],
    }))
    const plunge = moves.find(move => move.role === 'plunge')
    expect(plunge).toBeDefined()
    const keepOut = offsetLoop(
      ensureCCW(island.points as Pt2[]) as Pt2[],
      TOOL_RADIUS + STOCK_TO_LEAVE - 0.01,
      0,
    )[0]
    expect(keepOut).toBeDefined()
    expect(pointInPolygon({ x: plunge!.x, y: plunge!.y }, keepOut as Pt2[])).toBe(false)
  })

  it('emits every crossed corner so no ramp chord enters an expanded island keep-out', () => {
    const outer = rectangle('corner-repro-outer', 30, 20)
    const island = circle('corner-repro-island', 'hole', 28.9, 18.9, 0.05, 96)
    const moves = buildPocketToolpath(makePayload({
      bottomZ: -1,
      stepdown: 1,
      stepover: 0.4,
      stockToLeave: 0,
      rampAngle: 0.5,
      loops: [outer, island],
      tool: makeTool(10, 1),
    }))
    const [group] = rampGroups(moves)
    expect(group).toBeDefined()

    const expandedKeepOut = offsetLoop(
      ensureCCW(island.points as Pt2[]) as Pt2[],
      0.5,
      0,
    )[0] as Pt2[]
    expect(expandedKeepOut).toBeDefined()
    for (let index = group.start; index <= group.end; index++) {
      const from = moves[index - 1]
      const to = moves[index]
      expect(
        segmentEntersPolygon(from, to, expandedKeepOut),
        `ramp segment ${index - 1}->${index} entered the expanded island keep-out`,
      ).toBe(false)
    }

    // The historical sampler jumped diagonally across this exact corner.
    expect(moves.slice(group.start, group.end + 1).some(move =>
      Math.abs(move.x - 29.5) < 1e-9 && Math.abs(move.y - 19.5) < 1e-9)).toBe(true)
  })

  it('emits every overlap corner so cleanup cannot chord through an island keep-out', () => {
    const outer = rectangle('overlap-corner-outer', 30, 20)
    const island = circle('overlap-corner-island', 'hole', 28.9, 18.9, 0.05, 96)
    const moves = buildPocketToolpath(makePayload({
      bottomZ: -1,
      stepdown: 1,
      stepover: 2.4,
      stockToLeave: 0,
      overlapMm: 96,
      rampAngle: 0.5,
      loops: [outer, island],
      tool: makeTool(10, 1),
    }))
    const [group] = rampGroups(moves)
    expect(group).toBeDefined()

    const firstStepover = moves.findIndex(
      (move, index) => index > group.end && move.role === 'stepover',
    )
    expect(firstStepover).toBeGreaterThan(group.end + 1)
    const rampEnd = moves[group.end]
    const cleanupReturn = moves.findIndex((move, index) =>
      index > group.end && index < firstStepover &&
      Math.hypot(move.x - rampEnd.x, move.y - rampEnd.y) < 1e-6)
    expect(cleanupReturn).toBeGreaterThan(group.end)
    expect(cleanupReturn).toBeLessThan(firstStepover - 1)
    const overlapEnd = moves.findIndex((move, index) =>
      index > cleanupReturn && index < firstStepover &&
      Math.hypot(move.x - rampEnd.x, move.y - rampEnd.y) < 1e-6)
    expect(overlapEnd).toBeGreaterThan(cleanupReturn)

    const expandedKeepOut = offsetLoop(
      ensureCCW(island.points as Pt2[]) as Pt2[],
      0.5,
      0,
    )[0] as Pt2[]
    expect(expandedKeepOut).toBeDefined()
    for (let index = cleanupReturn + 1; index <= overlapEnd; index++) {
      expect(
        segmentEntersPolygon(moves[index - 1], moves[index], expandedKeepOut),
        `overlap segment ${index - 1}->${index} ` +
        `(${moves[index - 1].x.toFixed(4)},${moves[index - 1].y.toFixed(4)}) -> ` +
        `(${moves[index].x.toFixed(4)},${moves[index].y.toFixed(4)}) ` +
        'entered the expanded island keep-out',
      ).toBe(false)
    }

    expect(moves.slice(cleanupReturn + 1, overlapEnd + 1).some(move =>
      Math.abs(move.x - 29.5) < 1e-9 && Math.abs(move.y - 19.5) < 1e-9)).toBe(true)
  })

  it('uses each floor-stock target as the next profile-ramp material surface', { timeout: 30_000 }, () => {
    const moves = buildPocketToolpath(makePayload({
      bottomZ: -4,
      stepdown: 2,
      floorStockToLeave: 1,
    }))
    const groups = rampGroups(moves)
    expect(groups.map(group => group.targetZ)).toEqual([-2, -3, -4])
    expect(groups.map(group => moves[group.start - 1].z)).toEqual([0, -2, -3])
    assertProfileRampDepthContract(moves, groups[0], 0)
    assertProfileRampDepthContract(moves, groups[1], -2)
    assertProfileRampDepthContract(moves, groups[2], -3)
  })

  it('emits 0.5 mm overlap only after cleanup returns and before stepover', () => {
    const moves = buildPocketToolpath(makePayload({
      bottomZ: -2,
      overlapMm: 0.5,
    }))
    const [group] = rampGroups(moves)
    const rampEnd = moves[group.end]
    const firstStepover = moves.findIndex(
      (move, index) => index > group.end && move.role === 'stepover',
    )
    expect(firstStepover).toBeGreaterThan(group.end + 2)

    let cleanupTravel = 0
    let cleanupReturn = -1
    for (let index = group.end + 1; index < firstStepover; index++) {
      cleanupTravel += segmentLength(moves[index - 1], moves[index])
      if (cleanupTravel > 10 && Math.hypot(
        moves[index].x - rampEnd.x,
        moves[index].y - rampEnd.y,
      ) < 1e-6) {
        cleanupReturn = index
        break
      }
    }
    expect(cleanupReturn).toBeGreaterThan(group.end)
    expect(cleanupReturn).toBeLessThan(firstStepover - 1)

    let overlapTravel = 0
    for (let index = cleanupReturn + 1; index < firstStepover; index++) {
      expect(moves[index].role).toBe('cut')
      overlapTravel += segmentLength(moves[index - 1], moves[index])
    }
    expect(overlapTravel).toBeCloseTo(0.5, 6)
  })

  it('rejects legacy outside-in Helix instead of silently changing its motion', () => {
    expect(() => buildPocketToolpath(makePayload({ entryType: 'ramp_helical' })))
      .toThrowError(/entry type.*ramp_helical.*not compatible.*outside_in.*Profile Ramp or Plunge/i)
  })

  it('completes a requested ramp longer than ten ring revolutions without plunging', () => {
    const moves = buildPocketToolpath(makePayload({
      bottomZ: -3,
      stepdown: 3,
      rampAngle: 0.5,
      loops: [rectangle('small-outer', 12, 12)],
    }))
    const [group] = rampGroups(moves)
    expect(group).toBeDefined()
    expect(moves.some(move => move.role === 'plunge')).toBe(false)
    let rampTravel = 0
    for (let index = group.start; index <= group.end; index++)
      rampTravel += segmentLength(moves[index - 1], moves[index])
    const expectedRingPerimeter = 4 * (12 - 2 * (TOOL_RADIUS + STOCK_TO_LEAVE))
    expect(rampTravel / expectedRingPerimeter).toBeGreaterThan(10)
    expect(moves[group.end].z).toBeCloseTo(-3, 9)

    const firstAfterCleanup = moves.findIndex(
      (move, index) => index > group.end && move.role !== 'cut',
    )
    expect(firstAfterCleanup).toBeGreaterThan(group.end + 1)
    expect(moves.slice(group.end + 1, firstAfterCleanup)
      .every(move => move.role === 'cut' && Math.abs(move.z + 3) <= 1e-9)).toBe(true)
  })

  it('fails preflight instead of replacing an over-budget profile ramp with a plunge', () => {
    expect(() => buildPocketToolpath(makePayload({
      bottomZ: -1000,
      stepdown: 1000,
      rampAngle: 0.5,
      loops: [rectangle('preflight-outer', 12, 12)],
      tool: makeTool(1200),
    }))).toThrowError(/Profile Ramp requires.*exceed.*150000-move safety limit.*silent plunge/i)
  })

  it('fails loud when a near-limit ramp leaves too little budget for the remaining rings', () => {
    expect(() => buildPocketToolpath(makePayload({
      bottomZ: -2545,
      stepdown: 2545,
      stepover: 0.1,
      rampAngle: 0.5,
      loops: [rectangle('near-limit-outer', 30, 20)],
      tool: makeTool(2600),
    }))).toThrowError(
      /150000-move safety limit while cutting a scheduled pocket ring.*silently truncated or partial/i,
    )
  })
})
