import { describe, it, expect } from 'vitest'
import { buildThreadMillToolpath } from '../../lib/cam/threadmill2d'
import { fitCircle } from '../../lib/cam/geometry'
import type { ThreadMillParams, ThreadMillWorkerPayload, LoopData } from '../../lib/cam/types'
import type { Tool, HeightParams, PassParams, LinkingParams, ToolpathMove, Vec2 } from '../../types'

// WO-1512 (BUG-417): threadmill2d's orbit center came straight from
// centroid() - a vertex mean biased by sample density along the loop. These
// tests pin the fix: the thread orbit must center on the analytic circle
// fit, not the vertex mean.

function makeTool(diameter = 6): Tool {
  return {
    id: 't1', name: `O${diameter} thread mill`, type: 'thread_mill',
    diameter, fluteLength: 30, shankDiameter: diameter, overallLength: 60,
    numberOfFlutes: 3, material: 'carbide', coating: 'none', notes: '',
    feedsAndSpeeds: { default: { rpm: 6000, feedRate: 400, plungeRate: 120, depthOfCut: 5, stepover: 1 } },
  } as Tool
}

function makeHeights(top = 0, bottom = -9): HeightParams {
  return {
    clearanceHeight: 10, clearanceHeightMode: 'absolute',
    retractHeight: 5, feedHeight: 1,
    topHeight: top, topHeightMode: 'absolute',
    bottomHeight: bottom, bottomHeightMode: 'absolute',
  }
}

const passes: PassParams = {
  stepdown: 5, stepover: 1, stockToLeave: 0, finishPasses: 0, springPasses: 0,
}

const linking: LinkingParams = {
  entryType: 'plunge', rampAngle: 3, rampLength: 0, leadInRadius: 0, leadOutRadius: 0,
  retractType: 'full', transitionType: 'safe_height',
}

// Unevenly sampled hole loop: dense on one arc, sparse on the opposite arc.
function unevenHoleLoop(id: string, dia: number, cx: number, cy: number): LoopData {
  const r = dia / 2
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

function evenHoleLoop(id: string, dia: number, cx: number, cy: number, n: number): LoopData {
  const r = dia / 2
  const points: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const a = (i / n) * 2 * Math.PI
    points.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return { id, closed: true, type: 'contour', points }
}

function squareHoleLoop(id: string): LoopData {
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

function makeParams(over: Partial<ThreadMillParams> = {}): ThreadMillParams {
  return {
    geometryId: 'g1', loopIds: [],
    threadKind: 'internal', majorDiameter: 10, pitch: 1.5,
    handedness: 'right', cutDirection: 'climb',
    roughingPasses: 1, springPasses: 0,
    leadInOut: 'arc', compensation: 'computer',
    ...over,
  }
}

function makePayload(params: ThreadMillParams, loops: LoopData[]): ThreadMillWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params, heights: makeHeights(), passes, linking,
    tool: makeTool(), loops, wcsOrigin: { x: 0, y: 0, z: 0 },
  }
}

function radiusFrom(m: ToolpathMove, cx: number, cy: number): number {
  return Math.hypot(m.x - cx, m.y - cy)
}

describe('buildThreadMillToolpath — WO-1512 circle-fit center', () => {
  it('centers the thread orbit on the analytic circle fit, not the vertex mean', () => {
    const cx = 3, cy = -6
    const loop = unevenHoleLoop('h1', 8.5, cx, cy)
    const fit = fitCircle(loop.points)

    const moves = buildThreadMillToolpath(makePayload(makeParams(), [loop]))
    const helix = moves.filter(m => m.role === 'helix')
    expect(helix.length).toBeGreaterThan(0)
    for (const m of helix) {
      expect(Math.hypot(m.x - fit.center.x, m.y - fit.center.y)).toBeCloseTo(
        Math.hypot(helix[0].x - fit.center.x, helix[0].y - fit.center.y), 3,
      )
    }
    expect(fit.center.x).toBeCloseTo(cx, 3)
    expect(fit.center.y).toBeCloseTo(cy, 3)

    // Every plunge/rapid/lead move must key off the fit center too, not a
    // biased vertex mean elsewhere.
    const plunge = moves.find(m => m.role === 'plunge')!
    expect(plunge.x).toBeCloseTo(cx, 3)
    expect(plunge.y).toBeCloseTo(cy, 3)
  })

  it('resolves the same thread center for the same physical hole at different sample density', () => {
    const cx = 5, cy = -2
    const sparse = buildThreadMillToolpath(makePayload(makeParams(), [evenHoleLoop('h1', 8.5, cx, cy, 9)]))
    const dense = buildThreadMillToolpath(makePayload(makeParams(), [evenHoleLoop('h1', 8.5, cx, cy, 200)]))
    const uneven = buildThreadMillToolpath(makePayload(makeParams(), [unevenHoleLoop('h1', 8.5, cx, cy)]))

    const plungeXY = (moves: ToolpathMove[]) => {
      const p = moves.find(m => m.role === 'plunge')!
      return { x: p.x, y: p.y }
    }
    const a = plungeXY(sparse), b = plungeXY(dense), c = plungeXY(uneven)
    expect(a.x).toBeCloseTo(b.x, 3)
    expect(a.y).toBeCloseTo(b.y, 3)
    expect(a.x).toBeCloseTo(c.x, 3)
    expect(a.y).toBeCloseTo(c.y, 3)
  })

  it('threads a non-circular loop around its fitted center instead of refusing it (rule 11)', () => {
    // The orbit is a circle about the center whatever the selected loop's shape,
    // so the software can cut it - the audit-era roundness refusal was invented.
    // Major 12 mm: the 10 mm square leaves material to thread (the existing
    // "hole already at or above the major diameter" check is a real one).
    const moves = buildThreadMillToolpath(makePayload(makeParams({ majorDiameter: 12 }), [squareHoleLoop('sq')]))
    expect(moves.filter(m => m.role === 'helix').length).toBeGreaterThan(0)
    const plunge = moves.find(m => m.role === 'plunge')!
    expect(plunge.x).toBeCloseTo(0, 3)
    expect(plunge.y).toBeCloseTo(0, 3)
  })

  it('downstream helix/lead moves orbit the fit center, not the old biased centroid', () => {
    const cx = -8, cy = 2
    const loop = unevenHoleLoop('h1', 8.5, cx, cy)
    const fit = fitCircle(loop.points)
    const moves = buildThreadMillToolpath(makePayload(makeParams(), [loop]))

    // Every helix point sits at the SAME radius from the fit center (the
    // orbit radius R): a wrong (biased) center would make this radius wobble
    // as the helix sweeps around the loop.
    const helix = moves.filter(m => m.role === 'helix')
    expect(helix.length).toBeGreaterThan(0)
    const radii = helix.map(m => radiusFrom(m, fit.center.x, fit.center.y))
    const meanR = radii.reduce((a, b) => a + b, 0) / radii.length
    for (const r of radii) {
      expect(r).toBeCloseTo(meanR, 3)
    }
  })
})
