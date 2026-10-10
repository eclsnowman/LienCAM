// Phase 3 correctness gate: the pass loop actually clears a single region.
// A circle is the simplest single-region case. We assert the engine: finds a start
// point, emits cut passes, COVERS the material that should be removed, and never
// GOUGES past the finish-stock wall.

import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady, offsetClosed, intersection, difference, totalArea, pointInPolygon, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

function circle(cx: number, cy: number, r: number, n = 180): Loop {
  const pts: Loop = []
  for (let i = 0; i < n; i++) {
    const a = (2 * Math.PI * i) / n
    pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) })
  }
  return pts
}

describe('processFeature clears a single region (circle)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('finds a start, emits passes, covers the region, and does not gouge', () => {
    const R = 20
    const params = { toolRadius: 2, stepOver: 0.2, tolerance: 0.1, helixDiameter: 3, stockToLeave: 0 }
    const res = processFeature({ boundary: circle(0, 0, R) }, params)

    expect(res.startPoint).not.toBeNull()
    const cutPasses = res.passes.filter(p => p.type === 'cut')
    expect(cutPasses.length).toBeGreaterThan(0)
    expect(res.stats.aborted).toBeUndefined()

    // The material that SHOULD be removed = feature minus the radial finish stock.
    const finishStock = params.tolerance / 2 + params.stockToLeave
    const targetRegion = offsetClosed([circle(0, 0, R)], -finishStock)
    const targetArea = totalArea(targetRegion)
    const coveredArea = totalArea(intersection(res.cleared, targetRegion))
    const coverage = coveredArea / targetArea
    expect(coverage).toBeGreaterThan(0.9) // clears at least 90% of the pocket

    // No gouge: cleared must stay (essentially) within the target region. Allow a
    // small slack for arc faceting on the disk/capsule polygons.
    const gouge = totalArea(difference(res.cleared, targetRegion))
    expect(gouge / targetArea).toBeLessThan(0.02)

    // Honest gap gate (replaces trusting % coverage): a circle has no sharp corners,
    // so after the finishing contour pass there must be NO uncut pocket the tool could
    // reach -- worst-gap radius far below the tool radius, essentially just facet noise.
    expect(res.stats.residualMaxInscribedR).toBeLessThan(0.25)
    expect(res.stats.residualMaxInscribedR).toBeLessThan(params.toolRadius)
  }, 60_000)
})

describe('processFeature terminates a repeated closed lap', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('finishes a near-tool-width circular pocket without running to the point cap', () => {
    const startedAt = performance.now()
    const res = processFeature({ boundary: circle(-25, 0, 7.15, 84) }, {
      toolRadius: 4.76,
      stepOver: 0.4,
      tolerance: 0.05,
      helixDiameter: 3,
      stockToLeave: 0,
      millingDirection: 'climb',
      integralWallFollow: true,
      integralWallFollowLengthFactor: 2,
      loopbackFilletPct: 25,
      landingUncutCap: 0.08,
    })

    expect(res.startPoint).not.toBeNull()
    expect(res.passes.filter(pass => pass.type === 'cut').length).toBeGreaterThan(0)
    expect(res.stats.aborted).toBeUndefined()
    expect(res.stats.points).toBeLessThan(1000)
    expect(performance.now() - startedAt).toBeLessThan(1000)
  })
})

describe('processFeature keep-down links never gouge the finish stock (island)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('no jumpType-1 link centre enters the island tool-centre keep-out', () => {
    const square: Loop = [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 40, y: 40 }, { x: 0, y: 40 }]
    const island = circle(20, 20, 6)
    const params = { toolRadius: 2, stepOver: 0.5, tolerance: 0.1, helixDiameter: 3, stockToLeave: 0.5 }
    const res = processFeature({ boundary: square, holes: [island] }, params)
    expect(res.stats.aborted).toBeUndefined()

    // The tool centre must stay outside the island grown by toolRadius + finishStock --
    // a kept-down link entering this disk would drive the tool edge into the 0.5mm band.
    const finishStock = params.tolerance / 2 + params.stockToLeave
    const keepOut = offsetClosed([island], params.toolRadius + finishStock)[0]
    expect(keepOut).toBeDefined()

    const keepDownLinks = res.passes.filter(p => p.type === 'link' && p.jumpType === 1) as
      { type: 'link'; points: [{ x: number; y: number }, { x: number; y: number }] }[]
    expect(keepDownLinks.length).toBeGreaterThan(0) // the optimization is actually exercised

    for (const link of keepDownLinks) {
      const [a, b] = link.points
      const d = Math.hypot(b.x - a.x, b.y - a.y)
      const n = Math.max(2, Math.ceil(d / 1))
      for (let i = 0; i <= n; i++) {
        const t = i / n
        const p = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
        expect(pointInPolygon(p, keepOut)).not.toBe(1) // never inside the island keep-out
      }
    }
  }, 60_000)
})
