// B8 ROUTE-AROUND GATE (Stage 2, CI-enforced -- no underscore). The stay-down slot-safety
// plan's rung (b)(1): when the DIRECT boundary-arc reposition would slot uncut (the B8 gate
// rejects it), the engine now tries the OTHER boundary arc (e.g. the far side of an island)
// before conceding a full retract. Recovered repositions stay at depth and cut fewer retracts,
// WITHOUT relaxing the material-safety cap (staydown-engagement.test.ts pins the cap; this
// file pins the WIN: fewer retracts on the exact repro Operator flagged, measured vs the committed
// Stage 1 baseline _b8-routearound-baseline.json).
//
// Safety is unchanged: every kept-down route-around passes the SAME rideOverloadsUncut gate
// the direct ride is held to (1.5x stepover sustained width vs clearedBeforePass). This test
// asserts the retract REDUCTION; staydown-engagement.test.ts independently asserts no ride
// (route-around included) exceeds the cap.

import { describe, it, beforeAll, expect, vi } from 'vitest'
import * as fs from 'fs'
import { gunzipSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import { ensureEngineClipperReady, diskPath, offsetOpenRound, offsetClosedTree, union, type Loop, type Loops, type Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, getB8GateStats, contourOverCap, buildClearedTrackGraph, planKeepDownRoute, type AcceptedGraphRouteObserver, type AdaptivePass, type FeatureResult, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

function circle(cx: number, cy: number, r: number, n = 180): Loop {
  const p: Loop = []
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }) }
  return p
}
const liftCount = (passes: AdaptivePass[]): number => passes.filter(p => p.type === 'link' && p.jumpType === 2).length

// WO-2937: measure the actual production pass stream, including the graph traverses
// that now replace lifts. Replay only material already removed BEFORE each move.
// Backward cleared-track TRAVEL is legal; routedAround must still exclude the
// wrong-direction alternate CUTTING arc (WO-1090 / WO-1178).
type GraphRouteSnapshot = Parameters<AcceptedGraphRouteObserver>[0]
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex')

function assertRoutedTravel(res: FeatureResult, boundary: Loop, holes: Loop[], params: ProcessParams, graphRoutes: GraphRouteSnapshot[]): void {
  const radius = params.toolRadius
  const arcTol = params.arcTol ?? Math.max(params.tolerance * 0.25, 0.01)
  const step = 2 * radius * params.stepOver
  const optimal = createToolGeometry(radius, params.stepOver, arcTol).optimalCutAreaPerDist
  // Existing T5 one-engage-bite traverse bound, NOT the looser cutting cap.
  const cap = Math.max(arcTol, 1.5 * optimal * (step / 4 + arcTol * 4) / 2)
  const routed = new Set(res.routedLoopbackPassIndices)
  expect(routed.size, 'the keep-down win must include actual routed travel').toBeGreaterThan(0)
  let cleared: Loops = []
  for (const [index, pass] of res.passes.entries()) {
    if (pass.type === 'entry') {
      cleared = union(cleared, diskPath(pass.point, pass.radius + radius, arcTol))
      continue
    }
    if (pass.type === 'link' && pass.jumpType === 2) continue
    if (routed.has(index)) {
      expect(pass.type, `routed pass ${index} must remain travel`).toBe('loopback')
      const pts = pass.points
      const length = pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p.x - pts[i].x, p.y - pts[i].y), 0)
      const chord = Math.hypot(pts.at(-1)!.x - pts[0].x, pts.at(-1)!.y - pts[0].y)
      expect(length, `routed pass ${index}: unchanged 3x direct budget`).toBeLessThanOrEqual(3 * chord)
      const load = contourOverCap(pts, cleared, radius, cap, arcTol, true)
      expect(load.overLen, `routed pass ${index}: sustained traverse load`).toBe(0)
      expect(load.peak, `routed pass ${index}: traverse cap`).toBeLessThanOrEqual(cap)
    }
    if (pass.points.length >= 2) cleared = union(cleared, offsetOpenRound(pass.points, radius, arcTol))
  }
  // Preserve the accepted GRAPH-route clearance oracle. The original captures
  // also contain unrelated short backtracks; Astra's ruling and clearance proof
  // concern the 7/15 accepted graph paths, not every non-graph recovery family.
  // Match exact snapshots from THIS call, with no cross-platform coordinates or
  // numerical identity allowance. Non-graph recoveries keep their own oracle.
  expect(graphRoutes.length, 'same-run graph acceptance must be non-vacuous').toBeGreaterThan(0)
  const matched = new Set<number>()
  let minClearance = Infinity
  for (const accepted of graphRoutes) {
    const index = res.passes.findIndex((p, i) => !matched.has(i) && routed.has(i) && p.type === 'loopback'
      && p.points.length === accepted.points.length
      && p.points.every((q, j) => q.x === accepted.points[j].x && q.y === accepted.points[j].y))
    expect(index, 'every accepted graph candidate in this untimed fixture must be emitted as routed travel').toBeGreaterThanOrEqual(0)
    const current = res.passes[index]
    if (!current || current.type !== 'loopback') throw new Error('accepted graph path missing from production passes')
    matched.add(index)
    expect(accepted.length, 'same-run graph budget').toBeLessThanOrEqual(accepted.maxLength)
    let clearance = Infinity
    for (let i = 1; i < current.points.length; i++) {
      for (const loop of [boundary, ...holes]) {
        for (let j = 0; j < loop.length; j++) {
          clearance = Math.min(clearance, segmentDistance(current.points[i - 1], current.points[i], loop[j], loop[(j + 1) % loop.length]) - radius)
        }
      }
    }
    expect(clearance, 'accepted graph path: full-cutter boundary clearance').toBeGreaterThanOrEqual(0)
    minClearance = Math.min(minClearance, clearance)
  }
  console.log('WO-2937 same-run graph proof', JSON.stringify({ graphRoutes: matched.size, routedTravel: routed.size, minClearance, passesSha256: digest(res.passes) }))
}

// Independent geometry, matching the accepted independent-clearance.json method.
function segmentDistance(a: Pt, b: Pt, c: Pt, d: Pt): number {
  const cross = (p: Pt, q: Pt, r: Pt) => (q.x - p.x) * (r.y - p.y) - (q.y - p.y) * (r.x - p.x)
  if (cross(a, b, c) * cross(a, b, d) < 0 && cross(c, d, a) * cross(c, d, b) < 0) return 0
  const pointDistance = (p: Pt, q: Pt, r: Pt): number => {
    const dx = r.x - q.x, dy = r.y - q.y
    const t = Math.max(0, Math.min(1, ((p.x - q.x) * dx + (p.y - q.y) * dy) / (dx * dx + dy * dy || 1)))
    return Math.hypot(p.x - q.x - t * dx, p.y - q.y - t * dy)
  }
  return Math.min(pointDistance(a, c, d), pointDistance(b, c, d), pointDistance(c, a, b), pointDistance(d, a, b))
}

function loadGtFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name,
  }
}

describe('B8 route-around (rung b(1)): retracts drop vs the Stage 1 baseline', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('island repro: at least one rejected ride is routed around, and lifts drop below baseline', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let res
    const graphRoutes: GraphRouteSnapshot[] = []
    const SIZE = 120, ISLR = 20, TOOLR = 3
    const square: Loop = [{ x: 0, y: 0 }, { x: SIZE, y: 0 }, { x: SIZE, y: SIZE }, { x: 0, y: SIZE }]
    const island = circle(SIZE / 2, SIZE / 2, ISLR)
    const params: ProcessParams = {
      toolRadius: TOOLR, stepOver: 0.25, tolerance: 0.1, helixDiameter: TOOLR * 2 * 0.9,
      stockToLeave: 0, integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
    }
    try {
      // Same runtime, complete production result: observation cannot change any
      // pass, role, cleared/residual region, entry, approach or diagnostic result.
      const unobserved = digest(processFeature({ boundary: square, holes: [island] }, params))
      res = processFeature({ boundary: square, holes: [island] }, params, undefined, route => graphRoutes.push(route))
      expect(digest(res), 'observer on/off: complete feature result is byte-identical').toBe(unobserved)
    } finally { spy.mockRestore() }
    expect(res.stats.aborted).toBeUndefined()

    const g = getB8GateStats()
    const lifts = liftCount(res.passes)
    // WO-2937, independent oracle ruling: dd921c1e72 (Astra). The old
    // 1-lift pin assumed no legal route inside 3x direct. Pricing the full
    // expanded track finds a safe 98.110 mm route within 258.752 mm; retaining
    // that lift would require manufacturing an unnecessary retract. Accepted
    // b8-1-comparison.json / independent-clearance.json retain old/new evidence.
    // Keep the zero wrong-direction alternate-arc pin and require zero lifts;
    // also prove the current routed travel's budget, pre-move load and clearance.
    expect({ routedAround: g.routedAround, lifts }).toEqual({ routedAround: 0, lifts: 0 })
    assertRoutedTravel(res, square, [island], params, graphRoutes)
  }, 300_000)

  it('SquareIsland gt fixture: the round-island wrap recovers its rejected repositions', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let res
    const graphRoutes: GraphRouteSnapshot[] = []
    const { boundary, holes, helixDiameter } = loadGtFixture(2) // SquareIsland
    const params: ProcessParams = {
      toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
      integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
    }
    try {
      res = processFeature({ boundary, holes }, params, undefined, route => graphRoutes.push(route))
    } finally { spy.mockRestore() }
    expect(res.stats.aborted).toBeUndefined()

    const g = getB8GateStats()
    const lifts = liftCount(res.passes)
    // WO-2937, same independent ruling: the old 4-lift pin priced replayed
    // track arcs as chords and missed four legal graph traverses. The accepted
    // b8-2-comparison.json / independent-clearance.json show 11 -> 15 accepted
    // graph routes with unchanged 0.547733 mm minimum full-cutter clearance.
    // Zero lifts is the proved keep-down win, never permission to reverse a
    // cutting arc, overrun 3x direct, cross retained material or relax T5 load.
    expect({ routedAround: g.routedAround, lifts }).toEqual({ routedAround: 0, lifts: 0 })
    assertRoutedTravel(res, boundary, holes, params, graphRoutes)
  }, 300_000)

  it('graph measurement is isolated per call and cannot mutate planner data', () => {
    const c = JSON.parse(gunzipSync(fs.readFileSync('src/tests/evidence/WO-2937/spark-planner.json.gz')).toString()) as {
      input: { a: Pt; b: Pt; priorTrack: Pt[]; priorMotion: Pt[]; toolRadius: number; stepOverDistance: number; arcTol: number; cap: number; maxLength: number }
      passes: AdaptivePass[]; clearedBeforePass: Loops; cutRegion: Loops
    }
    const p = c.input
    const tree = offsetClosedTree(c.cutRegion, 0, p.arcTol)
    const graph = buildClearedTrackGraph(c.passes, p.toolRadius, p.stepOverDistance, tree, 0.15)!
    const run = (observer?: AcceptedGraphRouteObserver, maxLength = p.maxLength) => planKeepDownRoute(
      p.a, p.b, p.priorTrack, p.priorMotion, graph, c.clearedBeforePass, tree,
      p.toolRadius, p.stepOverDistance, p.arcTol, p.cap, maxLength, null, observer,
    )
    const baseline = run()
    expect(baseline, 'control must actually reach graph acceptance').not.toBeNull()
    const observe = vi.fn((snapshot: GraphRouteSnapshot) => {
      expect(snapshot.points).toEqual(baseline!.points)
      expect(Object.isFrozen(snapshot)).toBe(true)
      expect(Object.isFrozen(snapshot.points)).toBe(true)
      expect(snapshot.points.every(Object.isFrozen)).toBe(true)
      expect(Reflect.set(snapshot.points[0], 'x', 1e9)).toBe(false)
      expect(Reflect.set(snapshot.points, 'length', 0)).toBe(false)
      expect(Reflect.set(snapshot, 'length', 0)).toBe(false)
    })
    const measured = run(observe)
    expect(observe).toHaveBeenCalledTimes(1)
    expect(measured).toEqual(baseline)
    const snapshot = observe.mock.calls[0][0]
    expect(snapshot.points).not.toBe(measured!.points)
    expect(snapshot.points.every((pt, i) => pt !== measured!.points[i])).toBe(true)
    const second = vi.fn()
    expect(run(second)).toEqual(baseline)
    expect(second).toHaveBeenCalledTimes(1)
    expect(second.mock.calls[0][0]).not.toBe(snapshot)
    expect(run()).toEqual(baseline)
    expect(run(second, 1)).toBeNull()
    expect(observe).toHaveBeenCalledTimes(1)
    expect(second).toHaveBeenCalledTimes(1) // no retained listener; refused routes never notify
    const snapshotBeforeMutation = digest(snapshot)
    measured!.points[0].x += 1
    expect(digest(snapshot)).toBe(snapshotBeforeMutation) // no alias in the other direction either
  })

})
