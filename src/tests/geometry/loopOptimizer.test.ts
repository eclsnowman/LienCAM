// Proves the geometry optimizer (fit arcs + merge lines) ACTUALLY transforms
// messy input into clean geometry - it had ZERO test coverage, and the concern
// (Operator 2026-06-16) was "I don't think this has ever actually happened".
//
// optimizeLoops returns each loop with `segments: LoopSegment[]` ('line' | 'arc')
// plus re-sampled `points`. We feed it deliberately messy input and assert the
// real transformation: collinear runs collapse to single line segments, and a
// sampled circle is recognised as arc geometry.

import { describe, it, expect } from 'vitest'
import { optimizeLoops } from '../../lib/geometry/loopOptimizer'
import type { Loop2D, Vec2 } from '../../types'

function loop(points: Vec2[], closed = true): Loop2D {
  return { id: 'L', points, closed, type: 'contour', layerId: 'lay', area: 0 }
}

// A square whose every edge is over-sampled with many COLLINEAR points - the
// "disjointed messy lines" case a clean import should reduce to 4 edges.
function oversampledSquare(side = 20, perEdge = 12): Vec2[] {
  const corners: Vec2[] = [
    { x: 0, y: 0 }, { x: side, y: 0 }, { x: side, y: side }, { x: 0, y: side },
  ]
  const pts: Vec2[] = []
  for (let i = 0; i < 4; i++) {
    const a = corners[i], b = corners[(i + 1) % 4]
    for (let k = 0; k < perEdge; k++) {
      pts.push({ x: a.x + (b.x - a.x) * k / perEdge, y: a.y + (b.y - a.y) * k / perEdge })
    }
  }
  return pts
}

// A circle sampled as a dense polygon - the arc-fitting case.
function circlePts(r = 10, n = 64): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i < n; i++) {
    const t = (2 * Math.PI * i) / n
    pts.push({ x: r * Math.cos(t), y: r * Math.sin(t) })
  }
  return pts
}

describe('geometry optimizer actually cleans messy geometry', () => {
  it('collapses over-sampled collinear edges to a few LINE segments', () => {
    const input = oversampledSquare() // 48 points
    const [out] = optimizeLoops([loop(input)], { tolerance: 0.05 })

    expect(out.segments).toBeDefined()
    // Every edge is straight -> only line segments, ~4 of them (allow wrap slack).
    expect(out.segments!.every((s) => s.type === 'line')).toBe(true)
    expect(out.segments!.length).toBeLessThanOrEqual(6)
    expect(out.segments!.length).toBeGreaterThanOrEqual(4)
    // Dramatic point reduction vs the 48-point input.
    expect(out.points.length).toBeLessThan(input.length)
    expect(out.points.length).toBeLessThanOrEqual(8)
  })

  it('recognises a sampled circle as ARC geometry (not 64 line chords)', () => {
    const input = circlePts(10, 64)
    const [out] = optimizeLoops([loop(input)], { tolerance: 0.05 })

    expect(out.segments).toBeDefined()
    expect(out.segments!.some((s) => s.type === 'arc')).toBe(true)
  })

  it('is NOT a passthrough - output points differ from messy input', () => {
    const input = oversampledSquare()
    const [out] = optimizeLoops([loop(input)], { tolerance: 0.05 })
    expect(out.points).not.toEqual(input)
  })

  it('leaves a tiny loop (<4 points) untouched', () => {
    const tri = loop([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 0, y: 1 }])
    const [out] = optimizeLoops([tri], { tolerance: 0.05 })
    expect(out.points.length).toBe(3)
  })

  it('handles an OPEN polyline (the DXF case) - merges collinear, no crash', () => {
    // An open L-shape, each leg over-sampled with collinear points.
    const pts: Vec2[] = []
    for (let k = 0; k <= 10; k++) pts.push({ x: k * 2, y: 0 })       // leg 1 (collinear)
    for (let k = 1; k <= 10; k++) pts.push({ x: 20, y: k * 2 })      // leg 2 (collinear)
    const [out] = optimizeLoops([loop(pts, /* closed */ false)], { tolerance: 0.05 })

    expect(out.segments).toBeDefined()
    expect(out.segments!.every((s) => s.type === 'line')).toBe(true)
    // Two straight legs -> a couple of line segments, far fewer than 21 points.
    expect(out.segments!.length).toBeLessThanOrEqual(3)
    expect(out.points.length).toBeLessThan(pts.length)
  })
})
