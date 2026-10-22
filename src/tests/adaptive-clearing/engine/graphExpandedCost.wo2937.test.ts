import { beforeAll, describe, expect, it, vi } from 'vitest'
import { readFileSync, writeFileSync } from 'node:fs'
import { gunzipSync, gzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import {
  ensureEngineClipperReady, offsetClosedTree, union, offsetOpenRound, difference, totalArea, type Pt, type Loops,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  buildClearedTrackGraph, planKeepDownRoute, planGatedLanding, contourOverCap, processFeature,
  type AdaptivePass, type Feature, type ProcessParams,
} from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const evidence = 'src/tests/evidence/WO-2937/'
const length = (pts: Pt[]) => pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0)
const box = [{ x: -20, y: -20 }, { x: 140, y: -20 }, { x: 140, y: 140 }, { x: -20, y: 140 }]
const tree = [{ contour: box, isHole: false, children: [] }]
const cut = (points: Pt[]): AdaptivePass => ({ type: 'cut', points })
const empty = new Set<number>()
const indexOf = (nodes: Pt[], p: Pt) => nodes.findIndex(q => q.x === p.x && q.y === p.y)

interface Capture {
  input: { a: Pt; b: Pt; priorTrack: Pt[]; priorMotion: Pt[]; toolRadius: number; stepOverDistance: number; arcTol: number; cap: number; maxLength: number }
  nodes: Pt[]; passes: AdaptivePass[]; clearedBeforePass: Loops; cutRegion: Loops
  feature: Feature; params: ProcessParams
}
const capture = (host: string): Capture => JSON.parse(gunzipSync(readFileSync(`${evidence}${host}-planner.json.gz`)).toString())

// Independent retained-region check. Segment samples must stay in the outer square
// and outside the nominal retained island with the FULL cutter, not just its centre.
function minIslandClearance(pts: Pt[]): number {
  let clearance = Infinity
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1], b = pts[i], dx = b.x - a.x, dy = b.y - a.y
    const t = Math.max(0, Math.min(1, ((60 - a.x) * dx + (60 - a.y) * dy) / (dx * dx + dy * dy || 1)))
    clearance = Math.min(clearance, Math.hypot(a.x + t * dx - 60, a.y + t * dy - 60) - 23)
  }
  return clearance
}

describe('WO-2937 graph prices the full motion it expands', () => {
  beforeAll(ensureEngineClipperReady)

  it.each([false, true])('charges full sampled track length in reverse=%s', reverse => {
    const pts = [{ x: 0, y: 0 }, { x: 0.1, y: 0.2 }, { x: 0, y: 10 }, { x: 0.5, y: 10 }, { x: 0.5, y: 0 }]
    const g = buildClearedTrackGraph([cut(pts)], 1, 0.5, tree, 0.01)!
    const a = reverse ? pts.at(-1)! : pts[0], b = reverse ? pts[0] : pts.at(-1)!
    const s = indexOf(g.nodes, a), t = indexOf(g.nodes, b)
    const route = g.shortestPath(a, [s], b, new Set([t]), 100, empty)!
    expect(length(g.expand(route))).toBeCloseTo(length(pts), 9)
    // Old spatial edge costs 0.5 but expands over 20 mm. A budget below
    // the actual replay must reject it even though its endpoints are near.
    expect(g.shortestPath(a, [s], b, new Set([t]), length(pts) - 0.001, empty)).toBeNull()
  })

  it.each([false, true])('finds the legal alternative rather than an over-budget wrapped pass, reverse=%s', reverse => {
    const wrap = [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0.5, y: 10 }, { x: 0.5, y: 0 }]
    const alternate = [{ x: 0, y: -0.5 }, { x: 0.5, y: -0.5 }]
    const g = buildClearedTrackGraph([cut(wrap), cut(alternate)], 1, 0.5, tree, 0.01)!
    const a = reverse ? wrap.at(-1)! : wrap[0], b = reverse ? wrap[0] : wrap.at(-1)!
    const sources = [indexOf(g.nodes, a)], sinks = new Set([indexOf(g.nodes, b)])
    const path = g.shortestPath(a, sources, b, sinks, 2, empty)!
    expect(path).not.toBeNull()
    expect(length(g.expand(path))).toBeLessThanOrEqual(2)
    expect(g.expand(path).some(p => p.y === -0.5)).toBe(true)
    for (let repeat = 0; repeat < 5; repeat++) expect(g.shortestPath(a, sources, b, sinks, 2, empty)).toEqual(path)
    const banned = new Set(path.slice(1).map((n, i) => g.edgeKey(path[i], n)))
    const next = g.shortestPath(a, sources, b, sinks, 2, banned)!
    expect(next).not.toBeNull()
    expect(length(g.expand(next))).toBeLessThanOrEqual(2)
    for (let i = 1; i < next.length; i++) expect(banned.has(g.edgeKey(next[i - 1], next[i]))).toBe(false)
  })

  it('replays closed same-pass wraps instead of cutting the seam chord', () => {
    const pts = [{ x: 0, y: 0 }, { x: 0, y: 3 }, { x: 3, y: 3 }, { x: 3, y: 0 }, { x: 0, y: 0 }]
    const g = buildClearedTrackGraph([cut(pts)], 1, 0.5, tree, 0.01)!
    const last = g.nodes.length - 1
    expect(length(g.expand([0, last]))).toBe(12)
    expect(length(g.expand([last, 0]))).toBe(12)
    expect(g.shortestPath(pts[0], [0], pts[0], new Set([last]), 11, empty)).toBeNull()
  })

  it('preserves cross-track and entry hops, and genuinely exhausted/disconnected results', () => {
    const passes: AdaptivePass[] = [{ type: 'entry', point: { x: 0, y: 0 }, radius: 1, mode: 'helix' }, cut([{ x: 0.5, y: 0 }, { x: 2, y: 0 }]), cut([{ x: 30, y: 0 }, { x: 31, y: 0 }])]
    const g = buildClearedTrackGraph(passes, 1, 0.5, tree, 0.01)!
    const p = g.shortestPath(g.nodes[0], [0], g.nodes[2], new Set([2]), 2.01, empty)!
    expect(length(g.expand(p))).toBeCloseTo(2)
    expect(g.shortestPath(g.nodes[0], [0], g.nodes[2], new Set([2]), 1.99, empty)).toBeNull()
    expect(g.shortestPath(g.nodes[0], [0], g.nodes[4], new Set([4]), 100, empty)).toBeNull()
    expect(buildClearedTrackGraph([], 1, 0.5, tree, 0.01)).toBeNull()
  })

  it.each([0.5, 2])('preserves the landing graph, departure/travel and routed fed-lead proofs with stockAbove=%s', stockAbove => {
    // WO-1178's independently pinned narrow slot: tangents gouge; only a
    // routed landing may keep down, with the configured engage bound intact.
    const rect = (x0: number, x1: number, y0: number, y1: number): Pt[] => [
      { x: x0, y: y0 }, { x: x1, y: y0 }, { x: x1, y: y1 }, { x: x0, y: y1 },
    ]
    const region = union(union([rect(0, 20, -10, 10)], [rect(20, 30, -0.5, 0.5)]), [rect(27.5, 28.5, 0.5, 8)])
    const cleared = union([rect(-2, 22, -12, 12)], [rect(18, 32, -2.5, 2 - stockAbove)])
    const along = (y: number, x0: number, x1: number): Pt[] => Array.from({ length: 7 }, (_, i) => ({ x: x0 + (x1 - x0) * i / 6, y }))
    const passes: AdaptivePass[] = [
      { type: 'entry', point: { x: 8, y: 6 }, radius: 1.9, mode: 'helix' },
      cut(along(6, 4, 16)), cut(along(-8, 16, 4)), cut(along(8, 16, 4)),
    ]
    const points = Array.from({ length: 8 }, (_, i) => ({ x: 28, y: i }))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let plan
    try {
      plan = planGatedLanding({ passes, clearedBeforePass: cleared, cutRegion: region,
        cutTree: offsetClosedTree(region, 0, 0.025), toolRadius: 2, helixRadius: 1.9,
        stepOverDistance: 1.6, arcTol: 0.025, landingUncutCap: 0.05,
        millingDirection: 'climb', points, boundarySpan: null, allowReseam: true,
      }, { x: 4, y: 8 }, points[0], points[1])
    } finally { warn.mockRestore() }
    if (stockAbove === 2) {
      expect(plan.keepDownApproach).toBeUndefined()
      expect(plan.helix).toBeDefined()
      return
    }
    const approach = plan.keepDownApproach!
    expect(approach).toBeDefined()
    expect(plan.helix).toBeUndefined()
    expect(totalArea(difference(offsetOpenRound(approach.travel, 2, 0.025), cleared))).toBeLessThan(0.005 * Math.PI * 4)
    const load = contourOverCap(approach.lead, cleared, 2, 1.6, 0.025, true)
    expect(load.overLen).toBe(0)
    expect(load.peak).toBeLessThanOrEqual(1.6)
    expect(load.maxStep).toBeLessThanOrEqual(1.6)
    expect(length([...(approach.departure ?? []), ...approach.travel, ...approach.lead])).toBeLessThan(3 * Math.hypot(24, -8))
  })

  for (const host of ['spark', 'windows']) {
    it(`${host} captured graph chooses an actually in-budget alternative`, () => {
      const c = capture(host), p = c.input
      const cutTree = offsetClosedTree(c.cutRegion, 0, p.arcTol)
      const g = buildClearedTrackGraph(c.passes, p.toolRadius, p.stepOverDistance, cutTree, 0.15)!
      expect(g.nodes).toEqual(c.nodes)
      const idx = g.shortestPath(p.a, g.near(p.a, 6), p.b, new Set(g.near(p.b, 6)), 110, empty)!
      expect(idx).not.toBeNull()
      const route = [p.a, ...g.expand(idx), p.b]
      expect(length(route)).toBeLessThan(110)
    })

    it(`${host} captured planner proves physical safety before accepting the alternative`, () => {
      const c = capture(host), p = c.input
      const cutTree = offsetClosedTree(c.cutRegion, 0, p.arcTol)
      const g = buildClearedTrackGraph(c.passes, p.toolRadius, p.stepOverDistance, cutTree, 0.15)!
      const run = (cleared = c.clearedBeforePass, maxLength = p.maxLength, air: ((pt: Pt) => number) | null = null) => planKeepDownRoute(p.a, p.b, p.priorTrack, p.priorMotion, g, cleared, cutTree, p.toolRadius, p.stepOverDistance, p.arcTol, p.cap, maxLength, air)
      const route = run()
      expect(route).not.toBeNull()
      expect(route!.length).toBeLessThan(110)
      expect(route!.length).toBeCloseTo(length(route!.points), 9)
      const load = contourOverCap(route!.points, c.clearedBeforePass, p.toolRadius, p.cap, p.arcTol, true)
      expect(load.overLen).toBe(0)
      expect(load.peak).toBeLessThanOrEqual(p.cap)
      expect(minIslandClearance(route!.points)).toBeGreaterThanOrEqual(0)
      for (const pt of route!.points) {
        expect(pt.x).toBeGreaterThanOrEqual(3 - 1e-8)
        expect(pt.x).toBeLessThanOrEqual(117 + 1e-8)
        expect(pt.y).toBeGreaterThanOrEqual(3 - 1e-8)
        expect(pt.y).toBeLessThanOrEqual(117 + 1e-8)
      }
      expect(run()).toEqual(route)
      expect(run([], p.maxLength)).toBeNull() // no already-cleared corridor
      expect(run(c.clearedBeforePass, 1)).toBeNull() // genuine budget exhaustion
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      try { expect(run(c.clearedBeforePass, p.maxLength, pt => pt.y > 15 && pt.y < 80 ? 100 : 0)).toBeNull() }
      finally { warn.mockRestore() }
      console.log('WO-2937 physical control', host, JSON.stringify({ length: route!.length, budget: p.maxLength, peak: load.peak, maxStep: load.maxStep, cap: p.cap, islandClearance: minIslandClearance(route!.points), pathSha256: createHash('sha256').update(JSON.stringify(route!.points)).digest('hex') }))
    })
  }

  it('records the unchanged B8 production feature entry without repinning its lift oracle', () => {
    const c = capture('spark'), warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let result
    try { result = processFeature(c.feature, c.params) } finally { warn.mockRestore() }
    expect(result.stats.aborted).toBeUndefined()
    const digest = createHash('sha256').update(JSON.stringify(result.passes)).digest('hex')
    console.log('WO-2937 feature identity', JSON.stringify({ passSha256: digest, passes: result.passes.length, lifts: result.passes.filter(p => p.type === 'link' && p.jumpType === 2).length }))
    if (process.env.WO2937_CAPTURE) writeFileSync(`${evidence}${process.env.WO2937_CAPTURE}-feature.json.gz`, gzipSync(JSON.stringify(result)))
  }, 300_000)
})
