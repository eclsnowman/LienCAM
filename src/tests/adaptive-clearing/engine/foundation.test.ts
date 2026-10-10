// Phase 1 unit tests: the load model (toolGeometry) and the geom helpers.
// Pins the cut-area model to its analytic value so a future refactor that breaks
// engagement is caught here, not three phases later on a visual review.

import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady, diskPath, totalArea, difference } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import { rotate, centroid, cleanPath, closestPointOnPaths, segmentPathsIntersection } from '../../../lib/cam/adaptiveClearing2d/engine/geom'

beforeAll(async () => { await ensureEngineClipperReady() })

describe('toolGeometry load model', () => {
  // For two disks of radius r whose centres are r/2 apart, the swept crescent
  // (disk minus shifted disk) has analytic area (pi - lens) r^2 = 0.98948 r^2,
  // where the lens(d=r/2) = 2.15211 r^2. fullSlotAreaPerDist = crescent / (r/2).
  const r = 2.0
  const stepOver = 0.2

  it('referenceCutArea (crescent) matches the analytic two-disk value', () => {
    const a = diskPath({ x: 0, y: 0 }, r)
    const b = diskPath({ x: 0, y: r / 2 }, r)
    const crescent = totalArea(difference(a, b))
    const analytic = 0.98948 * r * r // 3.9579 mm^2 for r=2
    expect(crescent).toBeGreaterThan(analytic * 0.97)
    expect(crescent).toBeLessThan(analytic * 1.01)
  })

  it('fullSlotAreaPerDist = referenceCutArea / (r/2) ~= 1.979 r', () => {
    const tg = createToolGeometry(r, stepOver)
    expect(tg.fullSlotAreaPerDist).toBeGreaterThan(1.979 * r * 0.97)
    expect(tg.fullSlotAreaPerDist).toBeLessThan(1.979 * r * 1.02)
  })

  it('optimalCutAreaPerDist scales linearly with stepOver', () => {
    const tg2 = createToolGeometry(r, 0.2)
    const tg4 = createToolGeometry(r, 0.4)
    expect(tg2.optimalCutAreaPerDist).toBeCloseTo(0.2 * tg2.fullSlotAreaPerDist, 6)
    // doubling stepover doubles the target load
    expect(tg4.optimalCutAreaPerDist / tg2.optimalCutAreaPerDist).toBeCloseTo(2, 3)
  })

  it('cutArea against empty cleared ~= full swept crescent; against full cleared ~= 0', () => {
    const tg = createToolGeometry(r, stepOver)
    const from = { x: 0, y: 0 }, to = { x: 1, y: 0 }
    const open = tg.cutArea(from, to, [])
    expect(open.area).toBeGreaterThan(0)
    expect(open.areaPerDist).toBeCloseTo(open.area / 1, 6)
    // a huge cleared square covering the move -> nothing left to cut
    const bigCleared = [[{ x: -50, y: -50 }, { x: 50, y: -50 }, { x: 50, y: 50 }, { x: -50, y: 50 }]]
    const covered = tg.cutArea(from, to, bigCleared)
    expect(covered.area).toBeLessThan(1e-6)
  })

  it('displacement cache hits on repeated identical moves', () => {
    const tg = createToolGeometry(r, stepOver)
    tg.cutShape({ x: 0, y: 0 }, { x: 0.5, y: 0 })
    tg.cutShape({ x: 10, y: 10 }, { x: 10.5, y: 10 }) // same displacement (0.5,0)
    const { hits, misses } = tg.cacheStats()
    expect(misses).toBe(1)
    expect(hits).toBe(1)
  })
})

describe('geom helpers', () => {
  it('rotate turns +x to +y at +pi/2', () => {
    const v = rotate({ x: 1, y: 0 }, Math.PI / 2)
    expect(v.x).toBeCloseTo(0, 9)
    expect(v.y).toBeCloseTo(1, 9)
  })

  it('centroid of unit square is its centre', () => {
    const c = centroid([{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }])
    expect(c.x).toBeCloseTo(0.5, 9)
    expect(c.y).toBeCloseTo(0.5, 9)
  })

  it('cleanPath collapses collinear midpoints', () => {
    const line = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 2, y: 0 }, { x: 3, y: 0 }]
    const cleaned = cleanPath(line, 0.01)
    expect(cleaned.length).toBeLessThan(line.length)
    expect(cleaned[cleaned.length - 1]).toEqual({ x: 3, y: 0 })
  })

  it('closestPointOnPaths finds the nearest boundary point', () => {
    const square = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]]
    const { dist } = closestPointOnPaths(square, { x: 5, y: 3 })
    expect(dist).toBeCloseTo(3, 6) // nearest edge is the bottom (y=0)
  })

  it('segmentPathsIntersection finds the crossing of a ray leaving a box', () => {
    const square = [[{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 10 }, { x: 0, y: 10 }]]
    const hit = segmentPathsIntersection([{ x: 5, y: 5 }, { x: 5, y: 20 }], square)
    expect(hit).not.toBeNull()
    expect(hit!.x).toBeCloseTo(5, 6)
    expect(hit!.y).toBeCloseTo(10, 6)
  })
})
