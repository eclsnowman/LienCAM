import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildBoreToolpath } from '../../lib/cam/bore2d'
import { sampleArcMovesForLinearConsumers } from '../../lib/cam/toolpathArcSampling'
import type { BoreParams, BoreWorkerPayload, LoopData } from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool, ToolpathMove } from '../../types'

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

function circleLoop(id: string, dia = 12, cx = 0, cy = 0, n = 64): LoopData {
  const r = dia / 2
  const points = []
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
      { x: -5, y: -5 }, { x: 5, y: -5 },
      { x: 5, y: 5 }, { x: -5, y: 5 },
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

function makePayload(
  params: BoreParams,
  loops: LoopData[] = [circleLoop('b1')],
  opts: { heights?: HeightParams; tool?: Tool; boreBottoms?: Record<string, number>; wcsZ?: number } = {},
): BoreWorkerPayload {
  return {
    opId: 'op', setupId: 'su', params,
    heights: opts.heights ?? makeHeights(), passes, linking,
    tool: opts.tool ?? makeTool(), loops,
    wcsOrigin: { x: 0, y: 0, z: opts.wcsZ ?? 0 },
    ...(opts.boreBottoms ? { boreBottoms: opts.boreBottoms } : {}),
  }
}

function radiusFrom(m: ToolpathMove, cx = 0, cy = 0): number {
  return Math.hypot(m.x - cx, m.y - cy)
}

function nonRapidMoves(moves: ToolpathMove[]): ToolpathMove[] {
  return moves.filter(m => m.type !== 'rapid' && m.role !== 'rapid')
}

// Measures the ramp angle the generator actually produced, from the raw
// helix moves (rise over the XY arc length of one helical arc at the known
// orbit radius; WO-2039 made the helix arcs) - not from the pitch formula
// under test.
function measuredRampAngleDeg(moves: ToolpathMove[], cx: number, cy: number, radius: number): number {
  const i = moves.findIndex(m => m.role === 'helix' && (m.type === 'arc_cw' || m.type === 'arc_ccw') &&
    Math.abs(radiusFrom(m, cx, cy) - radius) < 0.005)
  expect(i).toBeGreaterThan(0)
  const [a, b] = [moves[i - 1], moves[i]]
  const sweep = 2 * Math.asin(Math.min(1, Math.hypot(b.x - a.x, b.y - a.y) / (2 * radius)))
  return Math.atan2(Math.abs(b.z - a.z), radius * sweep) * 180 / Math.PI
}

afterEach(() => vi.restoreAllMocks())

describe('buildBoreToolpath', () => {
  it('derives bore orbit direction from tool hand and physical cut selection', () => {
    const build = (direction: 'climb' | 'conventional', cutHand: 'right' | 'left') => {
      const p = makePayload(makeParams({ direction }))
      p.tool = { ...p.tool, cutHand }
      return buildBoreToolpath(p)
    }
    const rightClimb = build('climb', 'right')
    const rightConventional = build('conventional', 'right')
    expect(rightClimb).not.toEqual(rightConventional)
    expect(build('climb', 'left')).toEqual(rightConventional)
    expect(build('conventional', 'left')).toEqual(rightClimb)
  })

  it('emits exact circular arcs with roughing and finish roles at every depth', () => {
    const moves = buildBoreToolpath(makePayload(makeParams()))
    const arcs = moves.filter(m => m.type === 'arc_cw' || m.type === 'arc_ccw')
    expect(arcs.length).toBeGreaterThan(0)
    // WO-1896: climb keeps the surrounding bore wall on the cutter's right -> CCW orbit.
    expect(arcs.every(m => m.type === 'arc_ccw')).toBe(true)
    const finalFinish = arcs.filter(m => m.role === 'finish' && Math.abs(m.z + 4) < 1e-9)
    expect(finalFinish.length).toBeGreaterThan(0)
    for (const m of finalFinish) {
      expect(radiusFrom(m)).toBeCloseTo(3, 6)
      expect(m.feed).toBe(700)
    }
    expect(moves.some(m => m.role === 'helix')).toBe(true)
  })

  it('does not emit center-out stepover slots or overtravel the bore wall', () => {
    const tool = makeTool(6)
    const selectedDiameter = 13
    const moves = buildBoreToolpath(makePayload(
      makeParams({ targetDiameter: selectedDiameter }),
      [circleLoop('b1', selectedDiameter)],
      { tool },
    ))
    expect(moves.some(m => m.role === 'stepover' || m.role === 'fast_traverse')).toBe(false)
    const cutting = nonRapidMoves(moves).filter(m => m.z <= 1e-9)
    for (const move of cutting) {
      expect(radiusFrom(move)).toBeGreaterThan(1)
      expect(radiusFrom(move) + tool.diameter / 2).toBeLessThanOrEqual(selectedDiameter / 2 + 1e-6)
    }
  })

  it('samples render/sim arcs without changing the stored exact arc stream', () => {
    const moves = buildBoreToolpath(makePayload(makeParams(), [circleLoop('b1', 13)]))
    const sampled = sampleArcMovesForLinearConsumers(moves)
    expect(moves.some(m => m.type === 'arc_ccw')).toBe(true)
    expect(sampled.some(m => m.type === 'arc_cw' || m.type === 'arc_ccw')).toBe(false)
    expect(sampled.length).toBeGreaterThan(moves.length)
  })

  it('uses per-bore WCS-relative bottom depths', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const loops = [circleLoop('b1', 12, 0), circleLoop('b2', 12, 20)]
    const moves = buildBoreToolpath(makePayload(
      makeParams({ loopIds: ['b1', 'b2'], perBoreDepth: true }),
      loops,
      { boreBottoms: { b1: -2, b2: -5 }, wcsZ: 1 },
    ))
    const minZForBore = (x: number) => Math.min(...moves.filter(m => radiusFrom(m, x, 0) < 5).map(m => m.z))
    expect(minZForBore(0)).toBeCloseTo(-1, 6)
    expect(minZForBore(20)).toBeCloseTo(-4, 6)
  })

  it('honours the authored ramp angle on a small orbit instead of a floored pitch', () => {
    // Tool center orbit radius 0.1 mm (loop dia 6.2, tool dia 6): above the
    // 0.05 mm helix threshold but small enough that the retired 0.1 mm pitch
    // floor used to force it steeper than the authored 3 deg.
    const tool = makeTool(6)
    const moves = buildBoreToolpath(makePayload(
      makeParams(),
      [circleLoop('b1', 6.2)],
      { tool, heights: makeHeights(-1) },
    ))
    expect(moves.some(m => m.role === 'helix')).toBe(true)
    // No entry plunge to the -1 mm target depth (the initial feed-height ->
    // top-of-material plunge at z=0 is unrelated setup, not the bore entry).
    expect(moves.some(m => m.role === 'plunge' && Math.abs(m.z + 1) < 1e-6)).toBe(false)
    expect(measuredRampAngleDeg(moves, 0, 0, 0.1)).toBeCloseTo(3, 1)
  })

  it('WRITE_EVIDENCE=1 dumps the before/after entry moves for the WO-1379 picture', async () => {
    if (process.env.WRITE_EVIDENCE !== '1') return
    const { generateThreadHelix } = await import('../../lib/cam/threadHelix')
    const radius = 0.1
    const rampAngleDeg = 3
    const depth = 1

    // AFTER: the real, current buildBoreToolpath production entry point.
    const afterMoves = buildBoreToolpath(makePayload(
      makeParams(),
      [circleLoop('b1', 6.2)],
      { tool: makeTool(6), heights: makeHeights(-1) },
    ))
    const afterHelix = afterMoves.filter(m => m.role === 'helix' && radiusFrom(m) < radius + 0.005)

    // BEFORE: the retired 0.1 mm pitch floor, reconstructed with the SAME
    // (unmodified) generateThreadHelix production primitive enterDepth called
    // on main - only the pitch value differs from the current code.
    const tanAngle = Math.tan(Math.max(0.25, rampAngleDeg) * Math.PI / 180)
    const beforePitch = Math.max(0.1, 2 * Math.PI * radius * tanAngle)
    const beforeHelix = generateThreadHelix({
      cx: 0, cy: 0, radius, pitch: beforePitch,
      bottomZ: -depth, topZ: 0, dir: -1, descend: true, feed: 1, role: 'helix', startAngle: 0,
    })

    const { mkdirSync, writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const directory = join(process.cwd(), 'src/tests/evidence/WO-1379')
    mkdirSync(directory, { recursive: true })
    writeFileSync(join(directory, 'entry-moves.json'), `${JSON.stringify({
      radius, rampAngleDeg, depth,
      before: { pitch: beforePitch, angleDeg: Math.atan2(beforePitch / (2 * Math.PI), radius) * 180 / Math.PI, moves: beforeHelix },
      after: { angleDeg: measuredRampAngleDeg(afterMoves, 0, 0, radius), moves: afterHelix },
    }, null, 2)}\n`)
  })

  it('falls back to a plunge below the helix threshold and logs the orbit radius', () => {
    // Tool center orbit radius 0.04 mm (loop dia 6.08, tool dia 6): below the
    // 0.05 mm threshold, so the tool genuinely has no room to orbit.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const tool = makeTool(6)
    const moves = buildBoreToolpath(makePayload(
      makeParams(),
      [circleLoop('b1', 6.08)],
      { tool, heights: makeHeights(-1) },
    ))
    expect(moves.some(m => m.role === 'helix')).toBe(false)
    const plunge = moves.find(m => m.role === 'plunge' && Math.abs(m.z + 1) < 1e-6)
    expect(plunge).toBeDefined()
    expect(radiusFrom(plunge as ToolpathMove)).toBeCloseTo(0.04, 6)
    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy.mock.calls[0][0]).toMatch(/0\.040 mm/)
  })

  it('fails loud on non-round loops, oversized targets, and tools without clearance', () => {
    expect(() => buildBoreToolpath(makePayload(makeParams(), [squareLoop('sq')]))).toThrow(/not a sampled circle|not round/i)
    expect(() => buildBoreToolpath(makePayload(
      makeParams({ targetDiameter: 14 }), [circleLoop('b1', 13)],
    ))).toThrow(/exceeds selected diameter/i)
    expect(() => buildBoreToolpath(makePayload(
      makeParams(), [circleLoop('small', 6.02)], { tool: makeTool(6) },
    ))).toThrow(/too small/i)
  })
})
