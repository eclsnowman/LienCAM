// WO-1174: the medial axis the V-bit will ride, on shapes whose axis is known.
//
// Every assertion is geometric truth, not a snapshot: a rectangle's axis is
// its centre line with four corner branches and a centre radius of half the
// height; a disc collapses to one deepest point; an annulus is one closed ring
// at the middle radius; real font letters keep their counters; overlapping
// rectangles weld into a single region.

import { describe, it, expect, beforeAll } from 'vitest'
import { medialAxis, type AxisPath, type Region } from '../../lib/cam/vcarve2d/medialAxis'
import { buildRegions, regionContains } from '../../lib/cam/vcarve2d/regions'
import { ensureVCarveClipperReady } from '../../lib/cam/vcarve2d/clipper'
import { outlineTextToContours } from '../../lib/sketch/textOutline'

const rect = (w: number, h: number, x0 = 0, y0 = 0) => [
  { x: x0, y: y0 }, { x: x0 + w, y: y0 }, { x: x0 + w, y: y0 + h }, { x: x0, y: y0 + h },
]
const circle = (r: number, n = 180, cx = 0, cy = 0) =>
  Array.from({ length: n }, (_, i) => ({ x: cx + r * Math.cos(2 * Math.PI * i / n), y: cy + r * Math.sin(2 * Math.PI * i / n) }))

const allNodes = (paths: AxisPath[]) => paths.flatMap(p => p.points)
const maxR = (paths: AxisPath[]) => Math.max(...allNodes(paths).map(n => n.r))
const pathLength = (p: AxisPath) => {
  let l = 0
  const pts = p.closed ? [...p.points, p.points[0]] : p.points
  for (let i = 1; i < pts.length; i++) l += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return l
}

function distToBoundary(region: Region, x: number, y: number): number {
  let best = Infinity
  for (const loop of [region.outer, ...region.holes]) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      const dx = b.x - a.x, dy = b.y - a.y
      const l2 = dx * dx + dy * dy
      let t = l2 > 0 ? ((x - a.x) * dx + (y - a.y) * dy) / l2 : 0
      t = t < 0 ? 0 : t > 1 ? 1 : t
      best = Math.min(best, Math.hypot(a.x + t * dx - x, a.y + t * dy - y))
    }
  }
  return best
}

describe('medialAxis: rectangle', () => {
  const region: Region = { outer: rect(40, 10), holes: [] }
  const paths = medialAxis(region, { spacing: 0.2 })

  it('reaches half the height at the centre line', () => {
    expect(maxR(paths)).toBeCloseTo(5, 2)
    const centreLine = allNodes(paths).filter(n => Math.abs(n.r - 5) < 0.02)
    expect(centreLine.length).toBeGreaterThan(5)
    for (const n of centreLine) expect(Math.abs(n.y - 5)).toBeLessThan(0.03)
  })

  it('has exactly four corner branches ending at the corners with r = 0', () => {
    const cornerEnds = paths.filter(p => !p.closed).flatMap(p => [p.points[0], p.points[p.points.length - 1]])
      .filter(n => n.r === 0)
    expect(cornerEnds.length).toBe(4)
    const corners = rect(40, 10)
    for (const c of corners) {
      expect(cornerEnds.some(e => Math.abs(e.x - c.x) < 1e-9 && Math.abs(e.y - c.y) < 1e-9)).toBe(true)
    }
  })

  it('every node lies inside the region with r equal to its distance to the boundary', () => {
    for (const n of allNodes(paths)) {
      if (n.r === 0) continue
      expect(regionContains(region, n)).toBe(true)
      expect(Math.abs(distToBoundary(region, n.x, n.y) - n.r)).toBeLessThan(0.02)
    }
  })

  it('has no spurs: total axis length is the centre line plus four diagonals', () => {
    // centre line: 40 - 2*5 = 30; diagonals: 4 * 5*sqrt(2)
    const expected = 30 + 4 * 5 * Math.SQRT2
    const total = paths.reduce((s, p) => s + pathLength(p), 0)
    expect(Math.abs(total - expected) / expected).toBeLessThan(0.03)
  })
})

describe('medialAxis: disc and annulus', () => {
  it('a disc collapses to a single deepest point at the centre', () => {
    const paths = medialAxis({ outer: circle(6), holes: [] }, { spacing: 0.2 })
    const nodes = allNodes(paths)
    expect(nodes.length).toBeGreaterThan(0)
    const deepest = nodes.reduce((a, b) => (b.r > a.r ? b : a))
    expect(deepest.r).toBeCloseTo(6, 1)
    expect(Math.hypot(deepest.x, deepest.y)).toBeLessThan(0.15)
    // Everything that survives pruning is within a sample spacing of the centre.
    for (const n of nodes) expect(Math.hypot(n.x, n.y)).toBeLessThan(0.6)
  })

  it('an annulus is one closed ring at the middle radius', () => {
    const paths = medialAxis({ outer: circle(10), holes: [circle(6).reverse()] }, { spacing: 0.15 })
    const closed = paths.filter(p => p.closed)
    expect(closed.length).toBe(1)
    expect(paths.filter(p => !p.closed).length).toBe(0)
    for (const n of closed[0].points) {
      expect(Math.hypot(n.x, n.y)).toBeCloseTo(8, 1)
      expect(n.r).toBeCloseTo(2, 1)
    }
    expect(pathLength(closed[0])).toBeCloseTo(2 * Math.PI * 8, 0)
  })
})

describe('medialAxis: real font letters', () => {
  it('O keeps its counter: one closed ring, nodes between the two contours', () => {
    const contours = outlineTextToContours('O', 20)
    expect(contours.length).toBe(2)
    const outer = contours.find(c => !c.isHole)!.points
    const hole = contours.find(c => c.isHole)!.points
    const region: Region = { outer, holes: [hole] }
    const paths = medialAxis(region, { spacing: 0.15 })
    expect(paths.length).toBeGreaterThan(0)
    const closed = paths.filter(p => p.closed)
    expect(closed.length).toBe(1)
    for (const n of allNodes(paths)) {
      expect(regionContains(region, n)).toBe(true)
      expect(Math.abs(distToBoundary(region, n.x, n.y) - n.r)).toBeLessThan(0.03)
    }
  })

  it('A has a counter and three legs; every node is inside the glyph', () => {
    const contours = outlineTextToContours('A', 20)
    const outer = contours.find(c => !c.isHole)!.points
    const holes = contours.filter(c => c.isHole).map(c => c.points)
    expect(holes.length).toBe(1)
    const region: Region = { outer, holes }
    const paths = medialAxis(region, { spacing: 0.15 })
    expect(paths.length).toBeGreaterThan(2)
    for (const n of allNodes(paths)) {
      if (n.r === 0) continue
      expect(regionContains(region, n)).toBe(true)
      expect(Math.abs(distToBoundary(region, n.x, n.y) - n.r)).toBeLessThan(0.03)
    }
  })
})

describe('buildRegions: nesting and welding', () => {
  beforeAll(async () => { await ensureVCarveClipperReady() })

  it('a frame with a hole is one region with one hole', () => {
    const regions = buildRegions([rect(40, 30), rect(20, 10, 10, 10)])
    expect(regions.length).toBe(1)
    expect(regions[0].holes.length).toBe(1)
  })

  it('a loop inside a hole is a new carved region', () => {
    const regions = buildRegions([rect(40, 30), rect(20, 10, 10, 10), rect(4, 4, 18, 13)])
    expect(regions.length).toBe(2)
    const inner = regions.find(r => r.holes.length === 0)!
    expect(regionContains(inner, { x: 20, y: 15 })).toBe(true)
  })

  it('overlapping rectangles weld into one region', () => {
    const regions = buildRegions([rect(20, 10), rect(20, 10, 10, 5)])
    expect(regions.length).toBe(1)
    expect(regions[0].holes.length).toBe(0)
    expect(regionContains(regions[0], { x: 15, y: 7 })).toBe(true)
    expect(regionContains(regions[0], { x: 25, y: 12 })).toBe(true)
  })

  it('a smaller outline that only partly overlaps a bigger one is welded, not subtracted (audit finding 1)', () => {
    const regions = buildRegions([rect(30, 30), rect(25, 25, 10, 10)])
    expect(regions.length).toBe(1)
    expect(regions[0].holes.length).toBe(0)
    // The overlap and both tails are all carved area.
    expect(regionContains(regions[0], { x: 20, y: 20 })).toBe(true)
    expect(regionContains(regions[0], { x: 5, y: 5 })).toBe(true)
    expect(regionContains(regions[0], { x: 33, y: 33 })).toBe(true)
  })

  it('a hole that shares an edge with the outer becomes a notch: its area is not carved', () => {
    const regions = buildRegions([rect(40, 20), rect(10, 10, 15, 10)])
    expect(regions.length).toBe(1)
    expect(regionContains(regions[0], { x: 20, y: 15 })).toBe(false)
    expect(regionContains(regions[0], { x: 5, y: 15 })).toBe(true)
    expect(regionContains(regions[0], { x: 20, y: 5 })).toBe(true)
  })

  it('orientation of the input does not matter', () => {
    const a = buildRegions([rect(20, 10), rect(6, 4, 5, 3)])
    const b = buildRegions([rect(20, 10).reverse(), rect(6, 4, 5, 3).reverse()])
    expect(a.length).toBe(1); expect(b.length).toBe(1)
    expect(a[0].holes.length).toBe(1); expect(b[0].holes.length).toBe(1)
  })

  it('allowance grows and shrinks the carved area', () => {
    const grown = buildRegions([rect(20, 10)], { allowanceMm: 1 })
    const shrunk = buildRegions([rect(20, 10)], { allowanceMm: -1 })
    expect(regionContains(grown[0], { x: -0.5, y: 5 })).toBe(true)
    expect(regionContains(shrunk[0], { x: 0.5, y: 5 })).toBe(false)
  })
})
