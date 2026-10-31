// WO-3195: holding tabs hold on every closed-contour route, roughing included.
//
// Measured against the emitted toolpath, not labels: each tab is a bridge of
// material across every kerf at its centre, from the part wall out to the
// waste (tool radius + stock to leave either side of the finish centreline).
// No cutting move may pass within one tool radius of that bridge while it is
// below the tab top - on any pass, rough or finish. The tabs themselves come
// from the same finish-contour preview the viewport tab editor uses.
//
// Route (a): a square whose Offset rough offset stays one region.
// Route (b): an hourglass (inner) whose rough offset splits at the neck while
// the finish stays one contour - the multi-region route.

import { describe, expect, it } from 'vitest'
import {
  buildContourToolpath,
  buildContourTabPlan,
  computeContourTabPreviewLoop,
  sampleTabPath,
} from '../../lib/cam/contour2d'
import { ensureClipperReady, offsetLoop } from '../../lib/cam/face2d/clipperOffset'
import type { ContourParams, ContourWorkerPayload, LoopData } from '../../lib/cam/types'
import type { HeightParams, LinkingParams, PassParams, Tool, ToolpathMove, Vec2 } from '../../types'

await ensureClipperReady()

const D = 6
const R = D / 2
const STOCK_BOTTOM = -6
const TAB_HEIGHT = 2
const TAB_TOP = STOCK_BOTTOM + TAB_HEIGHT
const TAB_WIDTH = 8

const tool: Tool = {
  id: 'tool', name: '6 mm flat', type: 'flat_end_mill', diameter: D, fluteLength: 20,
  shankDiameter: 6, overallLength: 60, numberOfFlutes: 2, material: 'carbide', coating: 'none', notes: '',
  feedsAndSpeeds: { default: { rpm: 10_000, feedRate: 1_000, plungeRate: 250, depthOfCut: 2, stepover: 2 } },
}

const heights: HeightParams = {
  clearanceHeight: 10, clearanceHeightMode: 'absolute', retractHeight: 5, feedHeight: 1,
  topHeight: 0, topHeightMode: 'absolute', bottomHeight: STOCK_BOTTOM, bottomHeightMode: 'absolute',
}

function linking(entryType: 'plunge' | 'ramp_linear'): LinkingParams {
  return {
    entryType, rampAngle: 10, rampLength: 10, leadInRadius: 0, leadOutRadius: 0,
    retractType: 'full', transitionType: 'safe_height',
  }
}

const square: LoopData = {
  id: 'square', closed: true, type: 'contour',
  points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }],
}

// Neck 8 mm wide: the finish offset (-3) keeps a 2 mm channel through it (one
// region); the rough offset (-5, stock to leave 2) pinches it into two lobes.
const hourglass: LoopData = {
  id: 'hg', closed: true, type: 'contour',
  points: [
    { x: 0, y: 0 }, { x: 40, y: 0 }, { x: 54, y: 16 }, { x: 66, y: 16 }, { x: 80, y: 0 },
    { x: 120, y: 0 }, { x: 120, y: 40 }, { x: 80, y: 40 }, { x: 66, y: 24 }, { x: 54, y: 24 },
    { x: 40, y: 40 }, { x: 0, y: 40 },
  ],
}

interface Case {
  loop: LoopData
  side: 'outer' | 'inner'
  stockToLeave: number
  entry: 'plunge' | 'ramp_linear'
  roughingStyle?: 'offset' | 'trochoidal'
  tabPoints?: Vec2[]
}

function finishPreview(c: Case) {
  const preview = computeContourTabPreviewLoop(c.loop.points, c.side, 'climb', D)
  if (!preview) throw new Error('fixture: finish contour must be one region')
  return preview
}

function nearestFraction(path: Vec2[], perimeter: number, p: Vec2): number {
  let best = Infinity
  let bestAlong = 0
  let along = 0
  for (let i = 0; i < path.length; i++) {
    const a = path[i]
    const b = path[(i + 1) % path.length]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    const t = len > 1e-12 ? Math.max(0, Math.min(1, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len))) : 0
    const d = Math.hypot(a.x + (b.x - a.x) * t - p.x, a.y + (b.y - a.y) * t - p.y)
    if (d < best) { best = d; bestAlong = along + t * len }
    along += len
  }
  return bestAlong / perimeter
}

function contourParams(c: Case): ContourParams {
  const params: ContourParams = {
    side: c.side, direction: 'climb', geometryId: 'g', loopIds: [], tabs: true,
    tabWidth: TAB_WIDTH, tabHeight: TAB_HEIGHT, tabCount: 4, tabShape: 'box',
    roughingStyle: c.roughingStyle ?? 'offset',
  }
  if (c.tabPoints) {
    const preview = finishPreview(c)
    params.tabLocations = { [c.loop.id]: c.tabPoints.map(p => nearestFraction(preview.path, preview.perimeter, p)) }
  }
  return params
}

function payload(c: Case): ContourWorkerPayload {
  const passes: PassParams = { stepdown: 1.5, stepover: 2, stockToLeave: c.stockToLeave, finishPasses: 1, springPasses: 0, overlapMm: 0 }
  return {
    opId: 'op', setupId: 'setup', params: contourParams(c), heights, passes, linking: linking(c.entry),
    tool, loops: [c.loop], wcsOrigin: { x: 0, y: 0, z: 0 }, stockBottomZ: STOCK_BOTTOM,
  }
}

/** The tab bridges: the centre of every finish tab interval and the line across
 *  all kerfs there (part wall side to waste side). */
function tabBridges(c: Case): Array<{ a: Vec2; b: Vec2 }> {
  const preview = finishPreview(c)
  const fractions = contourParams(c).tabLocations?.[c.loop.id]
  const plan = buildContourTabPlan(preview.path, {
    width: TAB_WIDTH, count: 4, tabTopZ: TAB_TOP, stockBottomZ: STOCK_BOTTOM, shape: 'box',
  }, Array.isArray(fractions) ? fractions : undefined)
  const half = R + c.stockToLeave
  return plan.intervals.map(({ start, end }) => {
    const mid = (start + end) / 2
    const centre = sampleTabPath(plan, mid)
    const p = sampleTabPath(plan, mid - 0.05)
    const q = sampleTabPath(plan, mid + 0.05)
    const len = Math.hypot(q.x - p.x, q.y - p.y)
    const n = { x: -(q.y - p.y) / len, y: (q.x - p.x) / len }
    return {
      a: { x: centre.x - n.x * half, y: centre.y - n.y * half },
      b: { x: centre.x + n.x * half, y: centre.y + n.y * half },
    }
  })
}

function segSegDistance(p1: Vec2, p2: Vec2, q1: Vec2, q2: Vec2): number {
  const cross = (o: Vec2, a: Vec2, b: Vec2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const d1 = cross(q1, q2, p1), d2 = cross(q1, q2, p2), d3 = cross(p1, p2, q1), d4 = cross(p1, p2, q2)
  if (((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0))) return 0
  const pointSeg = (p: Vec2, a: Vec2, b: Vec2) => {
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 > 1e-18 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
    return Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)
  }
  return Math.min(pointSeg(p1, q1, q2), pointSeg(p2, q1, q2), pointSeg(q1, p1, p2), pointSeg(q2, p1, p2))
}

/** Feed moves whose below-tab-top portion passes within one tool radius of a
 *  tab bridge: each one removes tab material. */
function movesThroughTabs(moves: ToolpathMove[], bridges: Array<{ a: Vec2; b: Vec2 }>): number {
  let count = 0
  for (let i = 1; i < moves.length; i++) {
    const m = moves[i]
    if (m.type !== 'feed') continue
    const prev = moves[i - 1]
    const za = prev.z, zb = m.z
    const limit = TAB_TOP - 1e-6
    if (za >= limit && zb >= limit) continue
    // Portion of the move strictly below the tab top (Z is linear along it).
    let t0 = 0, t1 = 1
    if (Math.abs(zb - za) > 1e-12) {
      const tc = (limit - za) / (zb - za)
      if (za >= limit) t0 = Math.max(0, tc)
      else if (zb >= limit) t1 = Math.min(1, tc)
    }
    const p1 = { x: prev.x + (m.x - prev.x) * t0, y: prev.y + (m.y - prev.y) * t0 }
    const p2 = { x: prev.x + (m.x - prev.x) * t1, y: prev.y + (m.y - prev.y) * t1 }
    if (bridges.some(br => segSegDistance(p1, p2, br.a, br.b) < R - 1e-6)) count++
  }
  return count
}

const routeA: Case[] = [
  { loop: square, side: 'outer', stockToLeave: 1, entry: 'plunge' },
  { loop: square, side: 'outer', stockToLeave: 1, entry: 'ramp_linear' },
  { loop: square, side: 'inner', stockToLeave: 1, entry: 'plunge' },
  { loop: square, side: 'inner', stockToLeave: 1, entry: 'ramp_linear' },
]

const lobeTabs: Vec2[] = [{ x: 0, y: 20 }, { x: 20, y: 0 }, { x: 120, y: 20 }, { x: 100, y: 40 }]
const routeB: Case[] = [
  { loop: hourglass, side: 'inner', stockToLeave: 2, entry: 'plunge', tabPoints: lobeTabs },
  { loop: hourglass, side: 'inner', stockToLeave: 2, entry: 'ramp_linear', tabPoints: lobeTabs },
]

// Finish runs only at the final depth; -4.5 (below the tab top) is a rough level.
const ROUGH_LEVEL = -4.5
const roughCuts = (moves: ToolpathMove[]) =>
  moves.filter(m => m.type === 'feed' && m.role === 'cut' && Math.abs(m.z - ROUGH_LEVEL) < 1e-6)

const name = (c: Case) => `${c.loop.id} ${c.side} ${c.roughingStyle ?? 'offset'} ${c.entry}`

describe('WO-3195 tabs hold on every contour route', () => {
  it('fixture: the square rough offset is one region; the hourglass rough splits, its finish does not', () => {
    expect(offsetLoop(square.points, R + 1, 0.01)).toHaveLength(1)
    expect(offsetLoop(square.points, -(R + 1), 0.01)).toHaveLength(1)
    expect(offsetLoop(hourglass.points, -R, 0.01)).toHaveLength(1)
    expect(offsetLoop(hourglass.points, -(R + 2), 0.01)).toHaveLength(2)
  })

  for (const c of routeA) {
    it(`route (a) single-region Offset roughing keeps every tab: ${name(c)}`, () => {
      const moves = buildContourToolpath(payload(c))
      // The cut really goes through the stock everywhere but the tabs.
      expect(moves.some(m => m.type === 'feed' && Math.abs(m.z - STOCK_BOTTOM) < 1e-6)).toBe(true)
      expect(roughCuts(moves).length).toBeGreaterThan(0)
      expect(movesThroughTabs(moves, tabBridges(c))).toBe(0)
    })
  }

  for (const c of routeB) {
    it(`route (b) split rough regions keep every tab: ${name(c)}`, () => {
      const moves = buildContourToolpath(payload(c))
      const deep = moves.filter(m => m.type === 'feed' && m.z < TAB_TOP - 1e-6)
      // Both lobes are roughed and finished below the tab top.
      expect(deep.some(m => m.x < 40)).toBe(true)
      expect(deep.some(m => m.x > 80)).toBe(true)
      expect(roughCuts(moves).some(m => m.x < 40)).toBe(true)
      expect(roughCuts(moves).some(m => m.x > 80)).toBe(true)
      expect(movesThroughTabs(moves, tabBridges(c))).toBe(0)
    })
  }

  // Audit 2026-10-28: with a large stock to leave the projected tabs cover the
  // whole (8 mm) rough loop. That loop is roughed down to the tab top and no
  // further - the material under it is tab - and the finish still runs.
  for (const entry of ['plunge', 'ramp_linear'] as const) {
    it(`a rough loop wholly under tabs stops at the tab top instead of refusing: square inner ${entry}`, () => {
      const c: Case = { loop: square, side: 'inner', stockToLeave: 16, entry }
      const moves = buildContourToolpath(payload(c))
      const rough = moves.filter(m => m.type === 'feed' && Math.abs(m.x - 20) < 1.5 && Math.abs(m.y - 20) < 1.5)
      expect(rough.length).toBeGreaterThan(0)
      expect(Math.min(...rough.map(m => m.z))).toBeCloseTo(TAB_TOP, 6)
      expect(moves.some(m => m.type === 'feed' && Math.abs(m.z - STOCK_BOTTOM) < 1e-6)).toBe(true)
      expect(movesThroughTabs(moves, tabBridges(c))).toBe(0)
    })
  }

  it('trochoidal roughing keeps its tabs (unchanged route)', () => {
    const c: Case = { loop: square, side: 'outer', stockToLeave: 1, entry: 'plunge', roughingStyle: 'trochoidal' }
    const moves = buildContourToolpath(payload(c))
    expect(movesThroughTabs(moves, tabBridges(c))).toBe(0)
  })
})
