import { beforeAll, describe, expect, it } from 'vitest'

import { ZDexelField, remainingAbove } from '../../cam3d/stock'
import { area, boolean, ensureGeom2dReady } from '../../cam3d/geom2d'
import { cutRegionAt, decomposeToComponents, ringToLoop } from '../../cam3d/rough'
import {
  processFeature,
  type AdaptivePass,
  type ProcessParams,
} from '../../lib/cam/adaptiveClearing2d/engine/processFeature'
import {
  ensureEngineClipperReady,
  type Loop,
} from '../../lib/cam/adaptiveClearing2d/engine/clipperEngine'

const CELL = 0.8
const SIZE = 64
const RADIUS = 12
const Z = 6

const PARAMS: ProcessParams = {
  toolRadius: 2,
  stepOver: 0.4,
  tolerance: 0.05,
  helixDiameter: 3,
  arcTol: 0.02,
  // WO-1896: the material-left stream these metrics were calibrated on; the rule now
  // names it conventional (climb keeps material on the cutter's right).
  millingDirection: 'conventional',
}

interface TurnMetrics {
  segments: number
  turns: number
  flips: number
  flipRatePct: number
  flipsOverOneDegree: number
  flipsOverFiveDegrees: number
  maxFlipDegrees: number
  p95FlipDegrees: number
}

function turnMetrics(passes: AdaptivePass[]): TurnMetrics {
  let segments = 0
  let turns = 0
  let flips = 0
  const flipDegrees: number[] = []
  for (const pass of passes) {
    if (pass.type !== 'cut') continue
    let lastSign = 0
    for (let index = 1; index < pass.points.length; index++) {
      const a = pass.points[index - 1]
      const b = pass.points[index]
      if (Math.hypot(b.x - a.x, b.y - a.y) <= 1e-9) continue
      segments++
      if (index < 2) continue
      const p = pass.points[index - 2]
      const ax = a.x - p.x
      const ay = a.y - p.y
      const bx = b.x - a.x
      const by = b.y - a.y
      const angle = Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
      if (Math.abs(angle) <= 1e-12) continue
      const sign = Math.sign(angle)
      turns++
      if (lastSign && sign !== lastSign) {
        flips++
        flipDegrees.push(Math.abs(angle) * 180 / Math.PI)
      }
      lastSign = sign
    }
  }
  flipDegrees.sort((a, b) => a - b)
  return {
    segments,
    turns,
    flips,
    flipRatePct: turns ? flips / turns * 100 : 0,
    flipsOverOneDegree: flipDegrees.filter((degrees) => degrees > 1).length,
    flipsOverFiveDegrees: flipDegrees.filter((degrees) => degrees > 5).length,
    maxFlipDegrees: flipDegrees.at(-1) ?? 0,
    p95FlipDegrees: flipDegrees[Math.floor(0.95 * Math.max(0, flipDegrees.length - 1))] ?? 0,
  }
}

function analyticCircle(cx: number, cy: number, radius: number, count = 256): Loop {
  const points: Loop = []
  // Holes are clockwise in both geom2d and the adaptive engine.
  for (let index = count - 1; index >= 0; index--) {
    const angle = index * 2 * Math.PI / count
    points.push({ x: cx + radius * Math.cos(angle), y: cy + radius * Math.sin(angle) })
  }
  return points
}

function radialMetrics(loop: Loop, analyticRadius: number): {
  equivalentRadius: number
  maxSelfRadialDeviation: number
  maxAnalyticRadialDeviation: number
  maxFacetLength: number
} {
  let twiceArea = 0
  let maxFacetLength = 0
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i]
    const b = loop[(i + 1) % loop.length]
    twiceArea += a.x * b.y - b.x * a.y
    maxFacetLength = Math.max(maxFacetLength, Math.hypot(b.x - a.x, b.y - a.y))
  }
  const equivalentRadius = Math.sqrt(Math.abs(twiceArea / 2) / Math.PI)
  let maxSelfRadialDeviation = 0
  let maxAnalyticRadialDeviation = 0
  for (let index = 0; index < loop.length; index++) {
    const a = loop[index]
    const b = loop[(index + 1) % loop.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const lengthSq = dx * dx + dy * dy
    const closestT = lengthSq > 0
      ? Math.max(0, Math.min(1, -(a.x * dx + a.y * dy) / lengthSq))
      : 0
    const minRadius = Math.hypot(a.x + closestT * dx, a.y + closestT * dy)
    const maxRadius = Math.max(Math.hypot(a.x, a.y), Math.hypot(b.x, b.y))
    maxSelfRadialDeviation = Math.max(
      maxSelfRadialDeviation,
      Math.abs(minRadius - equivalentRadius),
      Math.abs(maxRadius - equivalentRadius),
    )
    maxAnalyticRadialDeviation = Math.max(
      maxAnalyticRadialDeviation,
      Math.abs(minRadius - analyticRadius),
      Math.abs(maxRadius - analyticRadius),
    )
  }
  return {
    equivalentRadius,
    maxSelfRadialDeviation,
    maxAnalyticRadialDeviation,
    maxFacetLength,
  }
}

beforeAll(async () => {
  await Promise.all([ensureGeom2dReady(), ensureEngineClipperReady()])
})

describe('WO-1211 round-boss cut-path smoothness', () => {
  it('isolates cross-section facets from walker steering noise', async () => {
    const stock = ZDexelField.fromBox(
      { minX: -SIZE / 2, minY: -SIZE / 2, minZ: 0, maxX: SIZE / 2, maxY: SIZE / 2, maxZ: 10 },
      CELL,
    )
    const tops = new Float64Array(stock.nx * stock.ny)
    for (let j = 0; j < stock.ny; j++) {
      for (let i = 0; i < stock.nx; i++) {
        const x = stock.centerX(i)
        const y = stock.centerY(j)
        const radialSq = x * x + y * y
        tops[j * stock.nx + i] = radialSq < RADIUS * RADIUS
          ? Math.sqrt(RADIUS * RADIUS - radialSq)
          : 0
      }
    }
    const part = ZDexelField.fromColumnTops(
      { originX: stock.originX, originY: stock.originY, nx: stock.nx, ny: stock.ny, cell: stock.cell },
      tops,
      0,
    )
    const blockRegion = boolean(remainingAbove(stock, Z), remainingAbove(part, Z), 'difference')
    const interpolatedRegion = await cutRegionAt(stock, part, Z)
    const blockComponent = decomposeToComponents(blockRegion)[0]
    const interpolatedComponent = decomposeToComponents(interpolatedRegion)[0]
    expect(blockComponent.holes).toHaveLength(1)
    expect(interpolatedComponent.holes).toHaveLength(1)

    const boundary = [...analyticCircle(0, 0, SIZE / 2 - CELL)].reverse()
    const facetedHole = ringToLoop(blockComponent.holes[0])
    const smoothHole = ringToLoop(interpolatedComponent.holes[0])
    const faceted = processFeature({ boundary, holes: [facetedHole] }, PARAMS)
    const smooth = processFeature({ boundary, holes: [smoothHole] }, PARAMS)
    const facetedMetrics = turnMetrics(faceted.passes)
    const smoothMetrics = turnMetrics(smooth.passes)
    const analyticSectionRadius = Math.sqrt(RADIUS * RADIUS - Z * Z)
    const analyticSectionArea = Math.PI * analyticSectionRadius * analyticSectionRadius
    const analyticAreaTolerance = Math.PI * (
      (analyticSectionRadius + PARAMS.tolerance) ** 2 - analyticSectionRadius ** 2
    )
    const facetedRadial = radialMetrics(facetedHole, analyticSectionRadius)
    const smoothRadial = radialMetrics(smoothHole, analyticSectionRadius)

    console.log('[WO-1211 diagnostic]', JSON.stringify({
      cell: CELL,
      facetVertices: facetedHole.length,
      smoothVertices: smoothHole.length,
      analyticSectionRadius,
      analyticSectionArea,
      analyticAreaTolerance,
      facetedRadial,
      smoothRadial,
      faceted: facetedMetrics,
      smooth: smoothMetrics,
    }))

    expect(facetedMetrics.turns).toBeGreaterThan(0)
    expect(smoothMetrics.turns).toBeGreaterThan(0)
    expect(smoothRadial.maxAnalyticRadialDeviation).toBeLessThan(PARAMS.tolerance)
    expect(smoothMetrics.flipsOverFiveDegrees)
      .toBeLessThanOrEqual(Math.floor(facetedMetrics.flipsOverFiveDegrees / 2))
    expect(smoothMetrics.p95FlipDegrees).toBeLessThan(10)
    expect(Math.abs(
      Math.abs(area(interpolatedComponent.holes[0])) - analyticSectionArea,
    )).toBeLessThan(analyticAreaTolerance)
  }, 120_000)
})
