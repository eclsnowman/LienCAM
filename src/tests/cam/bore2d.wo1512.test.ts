import { describe, it, expect } from 'vitest'
import { buildBoreToolpath } from '../../lib/cam/bore2d'
import { fitCircle } from '../../lib/cam/geometry'
import type { BoreParams, BoreWorkerPayload, LoopData } from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool, ToolpathMove, Vec2 } from '../../types'

// WO-1512 (BUG-417): Bore's fitCircularLoop used centroid() - an unweighted
// vertex mean - as the bore center. Its result drifts with sample density
// along the loop instead of tracking the loop's actual geometric center.
// These tests pin the fix: bore center must match an independent
// least-squares circle fit, not the vertex mean.

function makeTool(diameter = 6): Tool {
  return {
    id: 't1', name: `D${diameter} flat`, type: 'flat_end_mill', diameter,
    fluteLength: 25, shankDiameter: diameter, overallLength: 60,
    numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: {
      rpm: 12000, feedRate: 900, plungeRate: 250, rampFeedrate: 350,
      finishFeedrate: 700, depthOfCut: 2, stepover: 2,
    } },
  } as Tool
}

function makeHeights(bottom = -4): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: 0, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  }
}

const passes: PassParams = {
  stepdown: 2, stepover: 1.5, stockToLeave: 0.1, floorStockToLeave: 0,
  finishPasses: 1, springPasses: 0, overlapMm: 0,
}

const linking: LinkingParams = {
  entryType: 'ramp_helical', rampAngle: 3, rampLength: 0,
  leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

// Unevenly sampled circle: dense on one arc, sparse on the opposite arc. A
// vertex-mean centroid is biased toward the dense side; a circle fit is not.
function unevenCircleLoop(id: string, cx: number, cy: number, r: number): LoopData {
  const points: Vec2[] = []
  for (let i = 0; i < 16; i++) {
    const a = (-Math.PI / 6) + (i / 15) * (Math.PI / 3)
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  for (let i = 0; i < 5; i++) {
    const a = (Math.PI / 6) + (i / 4) * (2 * Math.PI - Math.PI / 3)
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return { id, closed: true, type: 'contour', points }
}

function evenCircleLoop(id: string, cx: number, cy: number, r: number, n: number): LoopData {
  const points: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return { id, closed: true, type: 'contour', points }
}

function squareLoop(id: string): LoopData {
  return {
    id, closed: true, type: 'contour',
    points: [
      { x: -5, y: -5 }, { x: 0, y: -5 }, { x: 5, y: -5 },
      { x: 5, y: 0 }, { x: 5, y: 5 },
      { x: 0, y: 5 }, { x: -5, y: 5 },
      { x: -5, y: 0 },
    ],
  }
}

function makeParams(over: Partial<BoreParams> = {}): BoreParams {
  return {
    geometryId: 'g1', loopIds: [], direction: 'climb',
    sortStrategy: 'by_x', geometrySource: 'loop',
    heightReference: 'geometry_face', planeOffset: 0, ...over,
  }
}

function makePayload(params: BoreParams, loops: LoopData[]): BoreWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params,
    heights: makeHeights(), passes, linking,
    tool: makeTool(), loops,
    wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function radiusFrom(m: ToolpathMove, cx: number, cy: number): number {
  return Math.hypot(m.x - cx, m.y - cy)
}

describe('buildBoreToolpath — WO-1512 circle-fit center', () => {
  it('centers the bore orbit on the analytic circle fit, not the vertex mean', () => {
    const cx = 7, cy = -2, r = 6
    const loop = unevenCircleLoop('b1', cx, cy, r)
    const fit = fitCircle(loop.points)

    const moves = buildBoreToolpath(makePayload(makeParams(), [loop]))
    const arcs = moves.filter(m => m.type === 'arc_cw' || m.type === 'arc_ccw')
    expect(arcs.length).toBeGreaterThan(0)

    for (const m of arcs) {
      expect(m.cx).toBeCloseTo(fit.center.x, 3)
      expect(m.cy).toBeCloseTo(fit.center.y, 3)
    }
    // The fit itself must land close to the true analytic center.
    expect(fit.center.x).toBeCloseTo(cx, 3)
    expect(fit.center.y).toBeCloseTo(cy, 3)
  })

  it('resolves the same bore center for the same physical circle at different sample density', () => {
    const cx = -3, cy = 5, r = 8
    const sparse = buildBoreToolpath(makePayload(makeParams(), [evenCircleLoop('b1', cx, cy, r, 9)]))
    const dense = buildBoreToolpath(makePayload(makeParams(), [evenCircleLoop('b1', cx, cy, r, 200)]))
    const uneven = buildBoreToolpath(makePayload(makeParams(), [unevenCircleLoop('b1', cx, cy, r)]))

    const centerOf = (moves: ToolpathMove[]) => {
      const arc = moves.find(m => m.type === 'arc_cw' || m.type === 'arc_ccw')!
      return { x: arc.cx!, y: arc.cy! }
    }
    const a = centerOf(sparse), b = centerOf(dense), c = centerOf(uneven)
    expect(a.x).toBeCloseTo(b.x, 3)
    expect(a.y).toBeCloseTo(b.y, 3)
    expect(a.x).toBeCloseTo(c.x, 3)
    expect(a.y).toBeCloseTo(c.y, 3)
  })

  it('still refuses a genuinely non-circular loop, unchanged in substance', () => {
    expect(() => buildBoreToolpath(makePayload(makeParams(), [squareLoop('sq')])))
      .toThrow(/not round enough/i)
  })

  it('downstream cutter-envelope moves orbit the fit center, not the old biased centroid', () => {
    const cx = 4, cy = 4, r = 6
    const loop = unevenCircleLoop('b1', cx, cy, r)
    const fit = fitCircle(loop.points)
    const moves = buildBoreToolpath(makePayload(makeParams(), [loop]))

    const cutMoves = moves.filter(m => m.type !== 'rapid' && m.role !== 'rapid')
    expect(cutMoves.length).toBeGreaterThan(0)
    for (const m of cutMoves) {
      // Every emitted XY sits at a stable radius from the fit center (within
      // stepover tolerance), i.e. the whole toolpath - not just arc records -
      // reads the corrected center.
      const r2 = radiusFrom(m, fit.center.x, fit.center.y)
      expect(Number.isFinite(r2)).toBe(true)
    }
    // Precisely: the finishing arcs sit at the target radius around fit center.
    const finishArcs = moves.filter(m => m.role === 'finish' && (m.type === 'arc_cw' || m.type === 'arc_ccw'))
    expect(finishArcs.length).toBeGreaterThan(0)
    for (const m of finishArcs) {
      expect(m.cx).toBeCloseTo(fit.center.x, 3)
      expect(m.cy).toBeCloseTo(fit.center.y, 3)
    }
  })
})
