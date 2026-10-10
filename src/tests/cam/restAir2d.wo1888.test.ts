// WO-1888: a 2D pocket or contour pass whose whole swept area lies in material
// an earlier operation of the same setup already removed is skipped, with its
// plunge. A pass that touches any remaining material is untouched, and an
// operation with nothing before it is byte-identical to what it always was.
//
// The stock here is the SAME source the app uses: the block as a z-dexel field
// (createStockState at the store's 0.5 mm cell) with the earlier operation's own
// toolpath replayed into it (toolpathMovesToLinearSweeps + applyStockOperation),
// which is exactly what remainingStockBefore hands the worker on every request.

import { describe, expect, it } from 'vitest'
import { buildPocketToolpath } from '../../lib/cam/pocket2d'
import { buildContourToolpath } from '../../lib/cam/contour2d'
import { ensureClipperReady } from '../../lib/cam/face2d/clipperOffset'
import { skipAirOnlyPasses } from '../../lib/cam/restAir2d'
import {
  applyStockOperation, createStockState, type StockState,
} from '../../lib/cam/stockState'
import { toolpathMovesToLinearSweeps } from '../../cam3d/rough/replayStock'
import { highestMaterialOver } from '../../lib/cam/smartHeights/earlierMaterial'
import { estimateRuntimeMs } from '../../lib/cam/runtime'
import type {
  ContourParams, ContourWorkerPayload, LoopData, PocketParams, PocketWorkerPayload,
} from '../../lib/cam/types'
import type {
  HeightParams, LinkingParams, PassParams, Tool, ToolpathMove,
} from '../../types'

await ensureClipperReady()

const TOOL_DIAMETER = 6
const BOTTOM_Z = -5
const RAPID_RATE = 8000

/** The store's own remaining-stock grid (toolReachInputs.ts). */
const STOCK_CELL_MM = 0.5

const STOCK_BOUNDS = { minX: -4, minY: -5, minZ: -10, maxX: 66, maxY: 45, maxZ: 0 }

const POCKET: LoopData = {
  id: 'pocket-outer', closed: true, type: 'contour',
  points: [{ x: 0, y: 0 }, { x: 62, y: 0 }, { x: 62, y: 40 }, { x: 0, y: 40 }],
}

function makeTool(): Tool {
  return {
    id: 'tool-wo1888', name: '6 mm flat endmill', type: 'flat_end_mill',
    diameter: TOOL_DIAMETER, fluteLength: 20, shankDiameter: 6, overallLength: 60,
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

function pocketPayload(options: {
  stockToLeave: number
  remainingStock?: StockState
}): PocketWorkerPayload {
  const passes: PassParams = {
    stepdown: 5, stepover: 2.4, stockToLeave: options.stockToLeave,
    floorStockToLeave: 0, finishPasses: 1, springPasses: 0,
  }
  const params: PocketParams = {
    geometryId: 'geometry', loopIds: [POCKET.id],
    direction: 'climb', orderStrategy: 'by_depth', fillStrategy: 'outside_in',
    floorStockToLeave: 0, finishContour: false,
    helixDiameter: 80, overlapMm: 0, stepoverLeadIn: 'none',
    stayDown: false, stayDownLift: 0.6,
  }
  return {
    opId: 'op-wo1888', setupId: 'setup', params, heights, passes, linking,
    tool: makeTool(), loops: [POCKET], wcsOrigin: { x: 0, y: 0, z: 0 },
    ...(options.remainingStock ? { remainingStock: options.remainingStock } : {}),
  } as PocketWorkerPayload
}

/** A smaller closed loop well inside the pocket, at a shallower depth. */
const INNER: LoopData = {
  id: 'inner-loop', closed: true, type: 'contour',
  points: [{ x: 20, y: 10 }, { x: 42, y: 10 }, { x: 42, y: 30 }, { x: 20, y: 30 }],
}

function contourPayload(options: { remainingStock?: StockState }): ContourWorkerPayload {
  const passes: PassParams = {
    stepdown: 5, stepover: 2.4, stockToLeave: 0, finishPasses: 1, springPasses: 0,
  }
  const params: ContourParams = {
    side: 'inner', direction: 'climb', geometryId: 'geometry', loopIds: [INNER.id], tabs: false,
  }
  return {
    opId: 'op-wo1888-contour', setupId: 'setup', params,
    heights: { ...heights, bottomHeight: -3 }, passes,
    linking: { ...linking, entryType: 'plunge' },
    tool: makeTool(), loops: [INNER], wcsOrigin: { x: 0, y: 0, z: 0 },
    ...(options.remainingStock ? { remainingStock: options.remainingStock } : {}),
  } as ContourWorkerPayload
}

/** The solid block, on the grid the store uses. */
function solidStock(): StockState {
  return createStockState(STOCK_BOUNDS, STOCK_CELL_MM, 1_000_000)
}

/** The block with one earlier operation's own result replayed out of it. */
function stockAfter(moves: readonly ToolpathMove[]): StockState {
  const before = solidStock()
  const sweeps = toolpathMovesToLinearSweeps(moves, before.resolutionMm / 4)
  return applyStockOperation(
    before, sweeps.map(move => ({ move, cutter: { kind: 'flat', diameter: TOOL_DIAMETER } as const })),
  )
}

function cutLengthMm(moves: readonly ToolpathMove[]): number {
  let total = 0
  for (let index = 1; index < moves.length; index++) {
    const from = moves[index - 1]
    const to = moves[index]
    if (to.type === 'rapid') continue
    total += Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z)
  }
  return total
}

/** Distance from a point to the pocket boundary (a 62 x 40 rectangle at origin). */
function distanceToWall(point: { x: number; y: number }): number {
  return Math.min(point.x - 0, 62 - point.x, point.y - 0, 40 - point.y)
}

const roughingMoves = buildPocketToolpath(pocketPayload({ stockToLeave: 0.2 }))
const remainingAfterRoughing = stockAfter(roughingMoves)

describe('WO-1888 2D operations skip passes that only cut air', () => {
  it('drops the interior passes of a finishing pocket the roughing already cleared', () => {
    const without = buildPocketToolpath(pocketPayload({ stockToLeave: 0 }))
    const withRest = buildPocketToolpath(
      pocketPayload({ stockToLeave: 0, remainingStock: remainingAfterRoughing }),
    )

    const beforeCut = cutLengthMm(without)
    const afterCut = cutLengthMm(withRest)
    const beforeMs = estimateRuntimeMs(without, RAPID_RATE)
    const afterMs = estimateRuntimeMs(withRest, RAPID_RATE)

    // Recorded for the work order and the evidence picture.
    console.info(
      `WO-1888 pocket: cut ${beforeCut.toFixed(1)} -> ${afterCut.toFixed(1)} mm, ` +
        `cycle ${(beforeMs / 1000).toFixed(1)} -> ${(afterMs / 1000).toFixed(1)} s, ` +
        `moves ${without.length} -> ${withRest.length}`,
    )

    expect(afterCut).toBeLessThan(beforeCut * 0.75)
    expect(afterMs).toBeLessThan(beforeMs)
    expect(withRest.length).toBeLessThan(without.length)
  })

  it('keeps the wall pass, which still clips the 0.2 mm the roughing left', () => {
    const withRest = buildPocketToolpath(
      pocketPayload({ stockToLeave: 0, remainingStock: remainingAfterRoughing }),
    )

    // The finish ring runs one tool radius off the wall; the roughing ring ran
    // 0.2 mm further in, so that ring is the one with material still under it.
    const wallCuts = withRest.filter((move, index) =>
      index > 0 && move.type === 'feed' && Math.abs(move.z - BOTTOM_Z) < 1e-6 &&
      Math.abs(distanceToWall(move) - TOOL_DIAMETER / 2) < 0.05)
    expect(wallCuts.length).toBeGreaterThan(3)

    // ...and nothing is still cutting the middle of the pocket, which is gone.
    const centreCuts = withRest.filter(move =>
      move.type === 'feed' && move.z < 0 && distanceToWall(move) > 12)
    expect(centreCuts).toHaveLength(0)
  })

  it('keeps the floor passes when the roughing left stock on the floor (architect, 2026-09-23)', () => {
    // A roughing pocket that stops 0.2 mm above the floor (its own bottom is
    // 0.2 mm higher; this engine's floorStockToLeave adds a floor pass at full
    // depth inside the same op, so it would not leave stock). The finishing
    // pocket's interior rings still have material under them and must stay.
    const shallowRough = pocketPayload({ stockToLeave: 0.2 })
    shallowRough.heights = { ...shallowRough.heights, bottomHeight: BOTTOM_Z + 0.2 }
    const roughedWithFloor = stockAfter(buildPocketToolpath(shallowRough))
    const without = buildPocketToolpath(pocketPayload({ stockToLeave: 0 }))
    const withRest = buildPocketToolpath(
      pocketPayload({ stockToLeave: 0, remainingStock: roughedWithFloor }),
    )
    const centreCuts = withRest.filter(move =>
      move.type === 'feed' && Math.abs(move.z - BOTTOM_Z) < 1e-6 && distanceToWall(move) > 12)
    expect(centreCuts.length).toBeGreaterThan(0)
    expect(cutLengthMm(withRest)).toBeGreaterThan(cutLengthMm(without) * 0.9)
  })

  it('is byte-identical when nothing earlier removed anything', () => {
    const noRest = buildPocketToolpath(pocketPayload({ stockToLeave: 0 }))
    const solid = buildPocketToolpath(
      pocketPayload({ stockToLeave: 0, remainingStock: solidStock() }),
    )
    expect(solid).toEqual(noRest)

    const noRestContour = buildContourToolpath(contourPayload({}))
    const solidContour = buildContourToolpath(contourPayload({ remainingStock: solidStock() }))
    expect(solidContour).toEqual(noRestContour)
  })

  it('drops a contour whose whole profile an earlier pocket already removed', () => {
    const without = buildContourToolpath(contourPayload({}))
    const withRest = buildContourToolpath(
      contourPayload({ remainingStock: remainingAfterRoughing }),
    )
    console.info(
      `WO-1888 contour: cut ${cutLengthMm(without).toFixed(1)} -> ` +
        `${cutLengthMm(withRest).toFixed(1)} mm, moves ${without.length} -> ${withRest.length}`,
    )
    expect(cutLengthMm(without)).toBeGreaterThan(50)
    expect(cutLengthMm(withRest)).toBe(0)
    expect(withRest.every(move => move.type === 'rapid')).toBe(true)
  })

  it('never leaves a kept feed move starting somewhere the tool is not', () => {
    const withRest = buildPocketToolpath(
      pocketPayload({ stockToLeave: 0, remainingStock: remainingAfterRoughing }),
    )
    const without = buildPocketToolpath(pocketPayload({ stockToLeave: 0 }))

    // Every feed move that survived travels the SAME segment it travelled
    // before: same end point, and the same point before it.
    const segmentsBefore = new Set<string>()
    for (let index = 1; index < without.length; index++) {
      const from = without[index - 1]
      const to = without[index]
      if (to.type !== 'feed') continue
      segmentsBefore.add(
        `${from.x.toFixed(6)},${from.y.toFixed(6)},${from.z.toFixed(6)}->` +
        `${to.x.toFixed(6)},${to.y.toFixed(6)},${to.z.toFixed(6)}`,
      )
    }
    for (let index = 1; index < withRest.length; index++) {
      const from = withRest[index - 1]
      const to = withRest[index]
      if (to.type !== 'feed') continue
      expect(segmentsBefore).toContain(
        `${from.x.toFixed(6)},${from.y.toFixed(6)},${from.z.toFixed(6)}->` +
        `${to.x.toFixed(6)},${to.y.toFixed(6)},${to.z.toFixed(6)}`,
      )
    }
  })
})

describe('WO-1888 skipAirOnlyPasses, on a path built by hand', () => {
  const tool = makeTool()
  /** A block whose top half (above z = -5) is already gone everywhere. */
  function halfCleared(): StockState {
    const block = createStockState(
      { minX: -10, minY: -10, minZ: -10, maxX: 30, maxY: 30, maxZ: 0 }, STOCK_CELL_MM, 1_000_000,
    )
    return applyStockOperation(block, [{
      move: { x0: -20, y0: -20, z0: -5, x1: 40, y1: 40, z1: -5 },
      cutter: { kind: 'flat', diameter: 200 },
    }])
  }

  it('skips a whole pass with its plunge and lifts nothing that was already up', () => {
    const remaining = halfCleared()
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' },
      { type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' },
      { type: 'feed', x: 0, y: 0, z: -4, feed: 250, role: 'plunge' },
      { type: 'feed', x: 20, y: 0, z: -4, feed: 900, role: 'cut' },
      { type: 'rapid', x: 20, y: 0, z: 5, role: 'rapid' },
    ]
    const result = skipAirOnlyPasses({ moves, tool, remaining, retractZ: 5 })
    expect(result.passes).toBe(1)
    expect(result.skippedPasses).toBe(1)
    expect(result.moves.every(move => move.type === 'rapid')).toBe(true)
    // The tool was already at the retract plane, so no lift was added.
    expect(result.moves).toHaveLength(3)
    expect(result.cutLengthRemovedMm).toBeCloseTo(9 + 20, 6)
  })

  it('lifts to the retract plane when the skipped pass began down in the cut', () => {
    const remaining = halfCleared()
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' },
      { type: 'feed', x: 0, y: 0, z: -6, feed: 250, role: 'plunge' },
      { type: 'feed', x: 10, y: 0, z: -6, feed: 900, role: 'cut' },  // in material
      { type: 'feed', x: 10, y: 0, z: -4, feed: 900, role: 'stepover' },
      { type: 'feed', x: 20, y: 0, z: -4, feed: 900, role: 'cut' },  // air
      { type: 'rapid', x: 20, y: 0, z: 5, role: 'rapid' },
    ]
    const result = skipAirOnlyPasses({ moves, tool, remaining, retractZ: 5 })
    expect(result.skippedPasses).toBe(1)
    // The cutting pass at -6 and the link off it survived untouched; the air
    // pass after them is gone, and the tool lifts straight up where it stood.
    expect(result.moves.slice(0, 4)).toEqual(moves.slice(0, 4))
    expect(result.moves[4]).toEqual({ type: 'rapid', x: 10, y: 0, z: 5, role: 'rapid' })
    expect(result.moves).toHaveLength(6)
  })

  it('never splits a pass: an air first half of a cutting pass is kept', () => {
    const remaining = halfCleared()
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' },
      { type: 'feed', x: 0, y: 0, z: -4, feed: 250, role: 'plunge' },  // air
      { type: 'feed', x: 10, y: 0, z: -4, feed: 900, role: 'cut' },    // air
      { type: 'feed', x: 10, y: 0, z: -6, feed: 900, role: 'cut' },    // cuts
      { type: 'rapid', x: 10, y: 0, z: 5, role: 'rapid' },
    ]
    const result = skipAirOnlyPasses({ moves, tool, remaining, retractZ: 5 })
    expect(result.skippedPasses).toBe(0)
    expect(result.moves).toEqual(moves)
  })

  it('runs an air link at rapid, same endpoints, when the pass after it still cuts', () => {
    const remaining = halfCleared()
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' },
      { type: 'feed', x: 0, y: 0, z: -4, feed: 250, role: 'plunge' },     // air
      { type: 'feed', x: 10, y: 0, z: -4, feed: 900, role: 'cut' },       // air
      { type: 'feed', x: 10, y: 10, z: -4, feed: 900, role: 'stepover' }, // air
      { type: 'feed', x: 10, y: 10, z: -6, feed: 900, role: 'cut' },      // cuts
      { type: 'rapid', x: 10, y: 10, z: 5, role: 'rapid' },
    ]
    const result = skipAirOnlyPasses({ moves, tool, remaining, retractZ: 5 })
    // Nothing is dropped: the next kept move is a FEED, so dropping would move
    // where it starts from. The link is demoted instead.
    expect(result.skippedPasses).toBe(0)
    expect(result.rapidedLinks).toBe(1)
    expect(result.moves[3]).toEqual({ type: 'rapid', x: 10, y: 10, z: -4, role: 'rapid' })
    expect(result.moves).toHaveLength(moves.length)
    expect(result.moves.filter((_, index) => index !== 3)).toEqual(
      moves.filter((_, index) => index !== 3),
    )
  })

  /**
   * WO-1888 review: a corridor along y = 0 taken down to -5, with the block
   * still standing at 0 either side of it. A pass inside the corridor is air;
   * a traverse that leaves it is not.
   */
  function corridorCleared(): StockState {
    const block = createStockState(
      { minX: -10, minY: -10, minZ: -10, maxX: 30, maxY: 30, maxZ: 0 }, STOCK_CELL_MM, 1_000_000,
    )
    return applyStockOperation(block, [{
      move: { x0: -20, y0: 0, z0: -5, x1: 40, y1: 0, z1: -5 },
      cutter: { kind: 'flat', diameter: 20 },
    }])
  }

  /** The air pass, with the kept rapid after it aimed wherever the case needs. */
  function corridorPath(nextRapid: { x: number; y: number; z: number }): ToolpathMove[] {
    return [
      { type: 'rapid', x: 0, y: 0, z: -2, role: 'rapid' },
      { type: 'feed', x: 0, y: 0, z: -4, feed: 250, role: 'plunge' },
      { type: 'feed', x: 20, y: 0, z: -4, feed: 900, role: 'cut' },
      { type: 'rapid', ...nextRapid, role: 'rapid' },
    ]
  }

  it('drops the pass when the rapid it hands its start to stays over emptied space', () => {
    const moves = corridorPath({ x: 20, y: 0, z: -2 })
    const result = skipAirOnlyPasses({ moves, tool, remaining: corridorCleared(), retractZ: -2 })
    // The traverse (0,0,-2) -> (20,0,-2) runs the length of the corridor, whose
    // material is at -5. Proven air, so the pass goes.
    expect(result.skippedPasses).toBe(1)
    expect(result.moves).toEqual([moves[0], moves[3]])
  })

  it('keeps the pass when dropping it would rapid the tool through standing stock', () => {
    // Same air pass, same guards passed (block starts at a pass boundary, next
    // kept move is a rapid) - but the rapid now ends OUTSIDE the corridor. The
    // drop would move its start from (20,0) to (0,0) and sweep a diagonal at
    // z -2 across material standing at 0. That is the WO-1888 review defect.
    const moves = corridorPath({ x: 20, y: 20, z: -2 })
    const result = skipAirOnlyPasses({ moves, tool, remaining: corridorCleared(), retractZ: -2 })
    expect(result.skippedPasses).toBe(0)
    expect(result.moves).toEqual(moves)
  })

  it('judges that traverse at the lowest Z it can reach, not at the higher end', () => {
    // A rapid is not interpolated the way a feed is: the controller may finish
    // Z last. A rapid climbing from -2 to the clearance plane can therefore be
    // at -2 anywhere along its XY line, so the check is made at -2.
    const moves = corridorPath({ x: 20, y: 20, z: 8 })
    const result = skipAirOnlyPasses({ moves, tool, remaining: corridorCleared(), retractZ: -2 })
    expect(result.skippedPasses).toBe(0)
    expect(result.moves).toEqual(moves)
  })

  it('proves the traverse from the lift, not from where the pass began, when it lifts', () => {
    // Same geometry, but the retract plane is above the block, so the drop
    // lifts to +2 first and the traverse is judged there - clear of everything.
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 0, y: 0, z: -2, role: 'rapid' },
      { type: 'feed', x: 0, y: 0, z: -4, feed: 250, role: 'plunge' },
      { type: 'feed', x: 20, y: 0, z: -4, feed: 900, role: 'cut' },
      { type: 'rapid', x: 20, y: 20, z: 2, role: 'rapid' },
    ]
    const result = skipAirOnlyPasses({ moves, tool, remaining: corridorCleared(), retractZ: 2 })
    expect(result.skippedPasses).toBe(1)
    expect(result.moves).toEqual([
      moves[0], { type: 'rapid', x: 0, y: 0, z: 2, role: 'rapid' }, moves[3],
    ])
  })

  /**
   * Two earlier operations left a step: everything below y = 6 is down at -8,
   * everything above it at -5. Nothing here is untouched stock, so the only
   * question this fixture asks is which Z a link is judged at.
   */
  function steppedFloors(): StockState {
    const block = createStockState(
      { minX: -10, minY: -10, minZ: -12, maxX: 10, maxY: 30, maxZ: 0 }, STOCK_CELL_MM, 1_000_000,
    )
    return applyStockOperation(block, [
      {
        move: { x0: -20, y0: -2, z0: -8, x1: 20, y1: -2, z1: -8 },
        cutter: { kind: 'flat', diameter: 16 },
      },
      {
        move: { x0: -20, y0: 14, z0: -5, x1: 20, y1: 14, z1: -5 },
        cutter: { kind: 'flat', diameter: 16 },
      },
    ])
  }

  it('leaves a rising air link at feed when a rapid could take it across lower', () => {
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 0, y: -4, z: -2, role: 'rapid' },
      { type: 'feed', x: 0, y: -4, z: -6, feed: 250, role: 'plunge' },
      { type: 'feed', x: 0, y: 0, z: -6, feed: 900, role: 'cut' },
      // The link rises from -6 to -2 as it steps over the -5 floor. Interpolated
      // - which is what a FEED does - it is above that floor the whole way and
      // is air. Flat at -6 - which is what a RAPID may do, Z last - it is 1 mm
      // under it. It is emitted as a rapid, so it is judged as one: kept.
      { type: 'feed', x: 0, y: 8, z: -2, feed: 900, role: 'stepover' },
      { type: 'feed', x: 0, y: 8, z: -9, feed: 900, role: 'cut' },
      { type: 'rapid', x: 0, y: 8, z: -2, role: 'rapid' },
    ]
    const result = skipAirOnlyPasses({ moves, tool, remaining: steppedFloors(), retractZ: -2 })
    expect(result.skippedPasses).toBe(0)
    expect(result.rapidedLinks).toBe(0)
    expect(result.moves).toEqual(moves)
  })

  it('leaves a tool whose footprint a square does not describe entirely alone', () => {
    const remaining = halfCleared()
    const vbit = { ...makeTool(), type: 'v_bit' } as Tool
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 0, y: 0, z: 5, role: 'rapid' },
      { type: 'feed', x: 0, y: 0, z: -4, feed: 250, role: 'plunge' },
      { type: 'feed', x: 20, y: 0, z: -4, feed: 900, role: 'cut' },
      { type: 'rapid', x: 20, y: 0, z: 5, role: 'rapid' },
    ]
    const result = skipAirOnlyPasses({ moves, tool: vbit, remaining, retractZ: 5 })
    expect(result.skippedPasses).toBe(0)
    expect(result.moves).toEqual(moves)
  })
})

/**
 * WO-1888 review, reproduced through the real builders: a rapid after a dropped
 * pass keeps its target but inherits a new start, and the app's own Smart
 * heights can put the retract plane BELOW the stock top (a retract just above
 * an earlier operation's floor, WO-1609). The drop must not turn that rapid
 * into a traverse through material that is still standing.
 */
describe('WO-1888 a dropped pass never re-routes a rapid through standing stock', () => {
  const OPEN_BOUNDS = { minX: -4, minY: -5, minZ: -10, maxX: 66, maxY: 45, maxZ: 0 }

  /** An earlier operation took an L-shaped swath, 20 mm wide, down to -6. */
  function lSwathCleared(): StockState {
    const block = createStockState(OPEN_BOUNDS, STOCK_CELL_MM, 1_000_000)
    return applyStockOperation(block, [
      {
        move: { x0: 10, y0: -12, z0: -6, x1: 10, y1: 35, z1: -6 },
        cutter: { kind: 'flat', diameter: 20 },
      },
      {
        move: { x0: 10, y0: 35, z0: -6, x1: 75, y1: 35, z1: -6 },
        cutter: { kind: 'flat', diameter: 20 },
      },
    ])
  }

  const CHAIN: LoopData = {
    id: 'bent-chain', closed: false, type: 'contour',
    points: [{ x: 10, y: 5 }, { x: 10, y: 35 }, { x: 50, y: 35 }],
  }

  /** Retract and feed sit 1 mm down, just above the -6 floor the earlier op left. */
  function openPayload(remainingStock?: StockState): ContourWorkerPayload {
    return {
      opId: 'op-wo1888-open', setupId: 'setup',
      params: {
        side: 'inner', direction: 'climb', geometryId: 'geometry',
        loopIds: [CHAIN.id], tabs: false, openSide: 'right', pathType: 'open',
      } as ContourParams,
      heights: {
        ...heights, retractHeight: -1, feedHeight: -1,
        topHeight: -6, bottomHeight: -6,
      },
      passes: { stepdown: 5, stepover: 2.4, stockToLeave: 0, finishPasses: 1, springPasses: 0 },
      linking: { ...linking, entryType: 'plunge' },
      tool: makeTool(), loops: [CHAIN], wcsOrigin: { x: 0, y: 0, z: 0 },
      stockBounds: { min: { x: -4, y: -5, z: -10 }, max: { x: 66, y: 45, z: 0 } },
      ...(remainingStock ? { remainingStock } : {}),
    } as unknown as ContourWorkerPayload
  }

  /**
   * Every rapid segment that would sweep the cutter through material the
   * remaining stock still holds. A rapid may finish Z before or after XY, so
   * the lower of its two ends is the Z it must clear along its whole XY line.
   */
  function rapidsThroughMaterial(
    moves: readonly ToolpathMove[], stock: StockState,
  ): string[] {
    const reach = TOOL_DIAMETER / 2 + stock.resolutionMm
    const offenders: string[] = []
    for (let index = 1; index < moves.length; index++) {
      const to = moves[index]
      if (to.type !== 'rapid') continue
      const from = moves[index - 1]
      const z = Math.min(from.z, to.z)
      const samples = Math.max(1, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 0.25))
      for (let sample = 0; sample <= samples; sample++) {
        const t = sample / samples
        const x = from.x + (to.x - from.x) * t
        const y = from.y + (to.y - from.y) * t
        const top = highestMaterialOver(stock, {
          minX: x - reach, minY: y - reach, maxX: x + reach, maxY: y + reach,
        })
        if (top !== undefined && z < top - 1e-6) {
          offenders.push(
            `rapid (${from.x},${from.y},${from.z}) -> (${to.x},${to.y},${to.z}) ` +
            `is at z ${z} under material standing at ${top}`,
          )
          break
        }
      }
    }
    return offenders
  }

  it('keeps the pass rather than hand the retract rapid a line it never travelled', () => {
    const remaining = lSwathCleared()
    const withoutRest = buildContourToolpath(openPayload())
    const withRest = buildContourToolpath(openPayload(remaining))

    // The path IS air end to end - it runs inside the swath the earlier op
    // emptied - so the pass-level check alone would drop it. What stops the
    // drop is the traverse it would leave behind: the engine's retract rapid
    // to the far end of the chain would start from the entry instead of the
    // exit and cross the corner of the L, where the block still stands at 0.
    expect(withRest).toEqual(withoutRest)
    expect(withRest.some(move => move.type === 'feed')).toBe(true)
  })

  it('emits no rapid through standing material on that path', () => {
    const remaining = lSwathCleared()
    expect(rapidsThroughMaterial(buildContourToolpath(openPayload(remaining)), remaining))
      .toEqual([])
  })

  it('still drops the pass once the retract plane clears the stock top', () => {
    // Same chain, same emptied swath, retract at +5: now the inherited traverse
    // runs above the block and is provably air, so the air pass goes.
    const remaining = lSwathCleared()
    const payload = openPayload(remaining)
    const lifted = {
      ...payload, heights: { ...payload.heights, retractHeight: 5, feedHeight: 1 },
    } as ContourWorkerPayload
    const withRest = buildContourToolpath(lifted)
    expect(withRest.some(move => move.type === 'feed')).toBe(false)
    expect(rapidsThroughMaterial(withRest, remaining)).toEqual([])
  })
})
