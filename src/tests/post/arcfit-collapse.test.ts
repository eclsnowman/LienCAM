import { describe, it, expect } from 'vitest'
import { collapsePolyline, type CollapseParams } from '../../lib/post/arcfit'
import { maxRadialDeviation, sweepAngle } from '../../lib/post/arcfit/circleFit'
import type { ToolpathMove, Vec2 } from '../../types'

const PARAMS: CollapseParams = {
  arcTolerance: 0.05,
  minArcRadius: 0.5,
  maxArcRadius: 1e4,
  minSweepDeg: 2,
}

/** Build a feed move list that traces an arc of a circle (excluding the start point). */
function arcFeedMoves(
  cx: number,
  cy: number,
  r: number,
  count: number,
  a0: number,
  a1: number,
  feed = 100,
  z = 0,
): { startMove: ToolpathMove; moves: ToolpathMove[]; pts: Vec2[] } {
  const pts: Vec2[] = []
  for (let k = 0; k < count; k++) {
    const t = a0 + ((a1 - a0) * k) / (count - 1)
    pts.push({ x: cx + r * Math.cos(t), y: cy + r * Math.sin(t) })
  }
  // First point reached by a rapid (so it is a boundary / anchor); remaining as feed.
  const startMove: ToolpathMove = { type: 'rapid', x: pts[0].x, y: pts[0].y, z }
  const moves: ToolpathMove[] = pts.slice(1).map((p) => ({
    type: 'feed' as const,
    x: p.x,
    y: p.y,
    z,
    feed,
    role: 'cut' as const,
  }))
  return { startMove, moves, pts }
}

/** Perpendicular distance from p to the line segment chord a->b (point-fallback). */
function pointToChord(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(dx * (p.y - a.y) - dy * (p.x - a.x)) / Math.sqrt(lenSq)
}

/**
 * HONEST end-to-end tolerance gate. Reconstructs every emitted primitive in
 * order and measures the max deviation of EVERY original input point from the
 * primitive that covers it. Lines measure perpendicular chord distance; arcs
 * measure radial deviation from the emitted center. Original points are mapped
 * to primitives by walking forward, advancing to the next primitive once a
 * point matches that primitive's endpoint. Returns the worst deviation.
 */
function maxOriginalDeviation(originalPts: Vec2[], out: ToolpathMove[]): number {
  // Emitted vertices in order (each move's endpoint), with the first original
  // point as the implicit start of the first primitive.
  const same = (p: Vec2, m: ToolpathMove) =>
    Math.abs(p.x - m.x) < 1e-6 && Math.abs(p.y - m.y) < 1e-6

  let worst = 0
  let primStart = originalPts[0]
  let oi = 1 // next original point to account for
  for (const m of out) {
    // Skip the anchor/start move(s) that merely reproduce an original vertex.
    if (m.type === 'rapid') {
      primStart = { x: m.x, y: m.y }
      continue
    }
    const primEnd: Vec2 = { x: m.x, y: m.y }
    // Account for every original point up to and including this primitive's end.
    while (oi < originalPts.length) {
      const p = originalPts[oi]
      let dev: number
      if (m.type === 'arc_cw' || m.type === 'arc_ccw') {
        const r = Math.hypot(primStart.x - m.cx!, primStart.y - m.cy!)
        dev = Math.abs(Math.hypot(p.x - m.cx!, p.y - m.cy!) - r)
      } else {
        dev = pointToChord(p, primStart, primEnd)
      }
      if (dev > worst) worst = dev
      const reachedEnd = same(p, m)
      oi++
      if (reachedEnd) break
    }
    primStart = primEnd
  }
  return worst
}

describe('collapsePolyline', () => {
  it('collapses a dense quarter circle into ONE arc move', () => {
    const { startMove, moves, pts } = arcFeedMoves(0, 0, 10, 16, 0, Math.PI / 2)
    const out = collapsePolyline([startMove, ...moves], PARAMS)

    // Rapid anchor preserved, then exactly one arc.
    expect(out[0]).toEqual(startMove)
    const arcs = out.filter((m) => m.type === 'arc_cw' || m.type === 'arc_ccw')
    expect(arcs).toHaveLength(1)

    const arc = arcs[0]
    // CCW quarter (angles increase) => arc_ccw.
    expect(arc.type).toBe('arc_ccw')
    expect(arc.cx).toBeCloseTo(0, 2)
    expect(arc.cy).toBeCloseTo(0, 2)
    // Endpoint preserved.
    expect(arc.x).toBeCloseTo(pts[pts.length - 1].x, 6)
    expect(arc.y).toBeCloseTo(pts[pts.length - 1].y, 6)
    // Carries feed and role.
    expect(arc.feed).toBe(100)
    expect(arc.role).toBe('cut')

    // Original points lie within tolerance of the emitted arc center/radius.
    const r = Math.hypot(pts[0].x - arc.cx!, pts[0].y - arc.cy!)
    expect(maxRadialDeviation(pts, arc.cx!, arc.cy!, r)).toBeLessThanOrEqual(PARAMS.arcTolerance)
  })

  it('detects clockwise winding for a CW quarter circle', () => {
    // Angles decrease => clockwise.
    const { startMove, moves } = arcFeedMoves(0, 0, 10, 16, Math.PI / 2, 0)
    const out = collapsePolyline([startMove, ...moves], PARAMS)
    const arcs = out.filter((m) => m.type === 'arc_cw' || m.type === 'arc_ccw')
    expect(arcs).toHaveLength(1)
    expect(arcs[0].type).toBe('arc_cw')
  })

  it('splits a full circle into MULTIPLE arcs each <= 180deg (no 360 arc)', () => {
    const { startMove, moves } = arcFeedMoves(0, 0, 10, 64, 0, 2 * Math.PI)
    const out = collapsePolyline([startMove, ...moves], PARAMS)

    const arcs = out.filter((m) => m.type === 'arc_cw' || m.type === 'arc_ccw')
    expect(arcs.length).toBeGreaterThanOrEqual(2)

    // Reconstruct the start point of each arc to verify every sweep <= 180deg.
    let prev: Vec2 = { x: startMove.x, y: startMove.y }
    for (const m of out) {
      if (m.type === 'arc_cw' || m.type === 'arc_ccw') {
        const dir = m.type === 'arc_ccw' ? 'ccw' : 'cw'
        const sweep = sweepAngle(prev, { x: m.x, y: m.y }, m.cx!, m.cy!, dir)
        expect(sweep).toBeLessThanOrEqual(Math.PI + 1e-6)
      }
      prev = { x: m.x, y: m.y }
    }
  })

  it('keeps a circle tighter than minArcRadius as feed moves (no arc)', () => {
    // r = 0.2 < minArcRadius 0.5.
    const { startMove, moves } = arcFeedMoves(0, 0, 0.2, 24, 0, 2 * Math.PI)
    const out = collapsePolyline([startMove, ...moves], PARAMS)
    const arcs = out.filter((m) => m.type === 'arc_cw' || m.type === 'arc_ccw')
    expect(arcs).toHaveLength(0)
    // All collapsed motion stays as feed lines.
    expect(out.filter((m) => m.type === 'feed').length).toBeGreaterThan(0)
  })

  it('collapses a collinear feed run to a single line move', () => {
    const start: ToolpathMove = { type: 'rapid', x: 0, y: 0, z: 0 }
    const moves: ToolpathMove[] = [1, 2, 3, 4, 5].map((x) => ({
      type: 'feed' as const,
      x,
      y: 0,
      z: 0,
      feed: 100,
      role: 'cut' as const,
    }))
    const out = collapsePolyline([start, ...moves], PARAMS)
    expect(out[0]).toEqual(start)
    const feeds = out.slice(1)
    expect(feeds).toHaveLength(1)
    expect(feeds[0].type).toBe('feed')
    expect(feeds[0].x).toBeCloseTo(5, 6)
    expect(feeds[0].y).toBeCloseTo(0, 6)
  })

  it('passes rapids through unchanged at their position', () => {
    const start: ToolpathMove = { type: 'rapid', x: 0, y: 0, z: 0 }
    const run1: ToolpathMove[] = [1, 2, 3].map((x) => ({
      type: 'feed' as const,
      x,
      y: 0,
      z: 0,
      feed: 100,
      role: 'cut' as const,
    }))
    const rapid: ToolpathMove = { type: 'rapid', x: 10, y: 10, z: 0 }
    const run2: ToolpathMove[] = [11, 12, 13].map((x) => ({
      type: 'feed' as const,
      x,
      y: 10,
      z: 0,
      feed: 100,
      role: 'cut' as const,
    }))
    const out = collapsePolyline([start, ...run1, rapid, ...run2], PARAMS)

    const rapids = out.filter((m) => m.type === 'rapid')
    expect(rapids).toHaveLength(2)
    // The mid rapid is preserved exactly.
    expect(out).toContainEqual({ type: 'rapid', x: 10, y: 10, z: 0 })
  })

  it('passes helix-role feed moves through unchanged', () => {
    const start: ToolpathMove = { type: 'rapid', x: 10, y: 0, z: 5 }
    // A helical descent: feed-typed but role 'helix' -> never collapsed.
    const helix: ToolpathMove[] = []
    for (let k = 1; k <= 12; k++) {
      const t = (k * Math.PI) / 6
      helix.push({
        type: 'feed',
        x: 10 * Math.cos(t),
        y: 10 * Math.sin(t),
        z: 5 - k * 0.25,
        feed: 80,
        role: 'helix',
      })
    }
    const out = collapsePolyline([start, ...helix], PARAMS)
    // No arcs produced; every helix move survives unchanged.
    expect(out.filter((m) => m.type === 'arc_cw' || m.type === 'arc_ccw')).toHaveLength(0)
    expect(out).toEqual([start, ...helix])
  })

  it('does NOT arc-fit a z-varying feed run', () => {
    // A circular XY path but with z climbing > arcTolerance: must stay feed.
    const start: ToolpathMove = { type: 'rapid', x: 10, y: 0, z: 0 }
    const moves: ToolpathMove[] = []
    for (let k = 1; k <= 16; k++) {
      const t = (k * (Math.PI / 2)) / 16
      moves.push({
        type: 'feed',
        x: 10 * Math.cos(t),
        y: 10 * Math.sin(t),
        z: k * 0.1, // climbs well beyond 0.05 tolerance
        feed: 100,
        role: 'cut',
      })
    }
    const out = collapsePolyline([start, ...moves], PARAMS)
    expect(out.filter((m) => m.type === 'arc_cw' || m.type === 'arc_ccw')).toHaveLength(0)
    // Original feed moves emitted unchanged.
    expect(out).toEqual([start, ...moves])
  })

  it('splits runs at a feed-value change (boundary)', () => {
    const start: ToolpathMove = { type: 'rapid', x: 0, y: 0, z: 0 }
    const slow: ToolpathMove[] = [1, 2, 3].map((x) => ({
      type: 'feed' as const,
      x,
      y: 0,
      z: 0,
      feed: 100,
      role: 'cut' as const,
    }))
    const fast: ToolpathMove[] = [4, 5, 6].map((x) => ({
      type: 'feed' as const,
      x,
      y: 0,
      z: 0,
      feed: 300, // different feed -> separate run
      role: 'cut' as const,
    }))
    const out = collapsePolyline([start, ...slow, ...fast], PARAMS)
    const feeds = out.filter((m) => m.type === 'feed')
    // Two collapsed line segments, one per feed value, each retaining its feed.
    expect(feeds).toHaveLength(2)
    expect(feeds[0].feed).toBe(100)
    expect(feeds[0].x).toBeCloseTo(3, 6)
    expect(feeds[1].feed).toBe(300)
    expect(feeds[1].x).toBeCloseTo(6, 6)
  })

  it('keeps EVERY original point within tolerance, even ones DP drops (honest end-to-end gate)', () => {
    // Regression for the tolerance-correctness gap (R3 3.5): DP runs at
    // 0.5*arcTolerance and a dropped point can sit up to ~1.5*tol off a
    // primitive fitted only to the DP-kept subset. These 9 points (found by
    // search) have an interior original point ~0.176mm off the circle fitted to
    // the DP-kept subset alone -- 3.5x the 0.05mm tolerance -- while the kept
    // subset's own radial deviation is only ~0.037mm. Validating against the
    // kept subset (the old behavior) would emit a single arc and silently move
    // that real point out of tolerance. Validating against the original span
    // (the fix) must refuse to span it.
    const raw: Vec2[] = [
      { x: 6.80962, y: 1.1378 },
      { x: 6.80575, y: 1.83454 },
      { x: 6.66252, y: 2.51688 },
      { x: 6.52397, y: 3.20837 },
      { x: 6.15829, y: 3.81234 },
      { x: 5.76389, y: 4.38398 },
      { x: 5.36872, y: 4.9507 },
      { x: 4.99084, y: 5.55354 },
      { x: 4.38267, y: 5.91993 },
    ]
    const start: ToolpathMove = { type: 'rapid', x: raw[0].x, y: raw[0].y, z: 0 }
    const moves: ToolpathMove[] = raw.slice(1).map((p) => ({
      type: 'feed' as const,
      x: p.x,
      y: p.y,
      z: 0,
      feed: 100,
      role: 'cut' as const,
    }))
    const out = collapsePolyline([start, ...moves], PARAMS)

    // The honest gate: NO emitted primitive may deviate more than arcTolerance
    // from ANY original input point it replaces.
    const worst = maxOriginalDeviation(raw, out)
    expect(worst).toBeLessThanOrEqual(PARAMS.arcTolerance)
  })

  it('also honors the all-points-within-tol gate on a clean dense quarter circle', () => {
    // Sanity: the gate must also pass on a well-behaved arc (no false alarm).
    const { startMove, moves, pts } = arcFeedMoves(0, 0, 10, 24, 0, Math.PI / 2)
    const out = collapsePolyline([startMove, ...moves], PARAMS)
    expect(maxOriginalDeviation(pts, out)).toBeLessThanOrEqual(PARAMS.arcTolerance)
  })

  it('does NOT arc-fit a sparse right-angle corner (reproduces the bulge bug)', () => {
    // Two long straight feed edges meeting at a 90deg corner: (0,0)->(60,0)->
    // (60,60). The 3 points lie on a perfect circle (center 30,30, r~42.4) so
    // the radial-deviation check alone passes and a single ~180deg arc bulging
    // ~17.6mm off the true straight path would be emitted (the BootL bug). The
    // arc-to-chord (sagitta) guard must reject it: expect TWO feed lines, ZERO
    // arcs.
    const start: ToolpathMove = { type: 'rapid', x: 0, y: 0, z: 0 }
    const corner: ToolpathMove[] = [
      { type: 'feed', x: 60, y: 0, z: 0, feed: 100, role: 'cut' },
      { type: 'feed', x: 60, y: 60, z: 0, feed: 100, role: 'cut' },
    ]
    const out = collapsePolyline([start, ...corner], PARAMS)
    expect(out.filter((m) => m.type === 'arc_cw' || m.type === 'arc_ccw')).toHaveLength(0)
    const feeds = out.filter((m) => m.type === 'feed')
    expect(feeds).toHaveLength(2)
    expect(feeds[0].x).toBeCloseTo(60, 6)
    expect(feeds[0].y).toBeCloseTo(0, 6)
    expect(feeds[1].x).toBeCloseTo(60, 6)
    expect(feeds[1].y).toBeCloseTo(60, 6)
  })

  it('keeps a closed right-angle box outline as all lines (no arcs at corners)', () => {
    // 4 right-angle corners of a 60x60 box back to origin. Every edge is a long
    // straight feed; each corner must stay a sharp line junction, never an arc.
    const start: ToolpathMove = { type: 'rapid', x: 0, y: 0, z: 0 }
    const box: ToolpathMove[] = [
      { type: 'feed', x: 60, y: 0, z: 0, feed: 100, role: 'cut' },
      { type: 'feed', x: 60, y: 60, z: 0, feed: 100, role: 'cut' },
      { type: 'feed', x: 0, y: 60, z: 0, feed: 100, role: 'cut' },
      { type: 'feed', x: 0, y: 0, z: 0, feed: 100, role: 'cut' },
    ]
    const out = collapsePolyline([start, ...box], PARAMS)
    expect(out.filter((m) => m.type === 'arc_cw' || m.type === 'arc_ccw')).toHaveLength(0)
    const feeds = out.filter((m) => m.type === 'feed')
    // Four distinct straight edges (one collapsed line per box side).
    expect(feeds).toHaveLength(4)
  })

  it('STILL collapses a densely-sampled genuine arc (regression: fix does not break real arcs)', () => {
    // ~30 points on a real circle radius 20, sweep ~120deg, as feed moves. The
    // sagitta between consecutive dense samples is tiny (well within tolerance),
    // so the arc must still collapse to a SINGLE arc move -- proving the guard
    // only rejects sparse corners, not legitimate AC-style dense arcs.
    const { startMove, moves, pts } = arcFeedMoves(0, 0, 20, 30, 0, (2 * Math.PI) / 3)
    const out = collapsePolyline([startMove, ...moves], PARAMS)
    const arcs = out.filter((m) => m.type === 'arc_cw' || m.type === 'arc_ccw')
    expect(arcs).toHaveLength(1)
    expect(arcs[0].cx).toBeCloseTo(0, 1)
    expect(arcs[0].cy).toBeCloseTo(0, 1)
    expect(maxOriginalDeviation(pts, out)).toBeLessThanOrEqual(PARAMS.arcTolerance)
  })

  it('does not mutate input moves', () => {
    const start: ToolpathMove = { type: 'rapid', x: 0, y: 0, z: 0 }
    const moves: ToolpathMove[] = [1, 2, 3].map((x) => ({
      type: 'feed' as const,
      x,
      y: 0,
      z: 0,
      feed: 100,
      role: 'cut' as const,
    }))
    const snapshot = JSON.stringify([start, ...moves])
    collapsePolyline([start, ...moves], PARAMS)
    expect(JSON.stringify([start, ...moves])).toBe(snapshot)
  })
})
