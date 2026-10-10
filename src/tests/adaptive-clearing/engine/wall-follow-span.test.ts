// Phase A diagnostic gate for the "integral wall-follow" feature: the engage-walker now
// recovers the boundary span it traverses between passes and stores it on the link record
// (AdaptivePass 'link'.boundarySpan), UNUSED for now. This test proves the recovered span
// is well-formed and rides the cutRegion boundary -- WITHOUT changing any emitted toolpath.

import { describe, it, expect, beforeAll } from 'vitest'
import { ensureEngineClipperReady, type Loop, type Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type AdaptivePass } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

// Point-to-polyline (closed loops) distance, mirroring the FreeCAD winding the engine
// uses (segment i runs path[i-1]..path[i]). Local copy so the test is self-contained.
function distToLoops(p: Pt, loops: Loop[]): number {
  let min = Infinity
  for (const loop of loops) {
    const n = loop.length
    for (let i = 0; i < n; i++) {
      const a = loop[(i - 1 + n) % n], b = loop[i]
      const lx = b.x - a.x, ly = b.y - a.y
      const lsq = lx * lx + ly * ly
      let t = lsq === 0 ? 0 : ((p.x - a.x) * lx + (p.y - a.y) * ly) / lsq
      t = t < 0 ? 0 : t > 1 ? 1 : t
      const dx = p.x - (a.x + t * lx), dy = p.y - (a.y + t * ly)
      const d = Math.hypot(dx, dy)
      if (d < min) min = d
    }
  }
  return min
}

describe('engage-walker recovers a wall-follow span (Phase A, inert)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('at least one link carries a boundarySpan riding the cutRegion boundary', () => {
    // A square is a multi-pass single region: the engagement-limited spiral runs out
    // partway and the engage-walker advances along the boundary to the next material
    // several times -> several inter-pass links, each carrying a recovered wall span.
    const square: Loop = [{ x: 0, y: 0 }, { x: 60, y: 0 }, { x: 60, y: 60 }, { x: 0, y: 60 }]
    const params = { toolRadius: 2, stepOver: 0.5, tolerance: 0.1, helixDiameter: 3, stockToLeave: 0 }
    const res = processFeature({ boundary: square }, params)
    expect(res.stats.aborted).toBeUndefined()

    const links = res.passes.filter((p): p is Extract<AdaptivePass, { type: 'link' }> => p.type === 'link')
    expect(links.length).toBeGreaterThan(0)

    const spanned = links.filter(l => l.boundarySpan !== undefined)
    // The wall-follow recovery must actually fire on this fixture.
    expect(spanned.length).toBeGreaterThan(0)

    const tol = 1e-3      // exact-endpoint tolerance (mm)
    const rideTol = 0.1   // how close each span point must lie to the boundary (mm)

    for (const link of spanned) {
      const span = link.boundarySpan!
      expect(span.length).toBeGreaterThanOrEqual(2)

      // The span END is the link END point: both are the walker's CURRENT point (the next
      // pass's start), so they must coincide exactly. This is the load-bearing endpoint --
      // it proves the recovered span terminates precisely where the next pass begins.
      // (The span START is the walker's boundary location where the forward walk BEGAN; it
      // does NOT equal the link START, which is the previous cut's interior last toolpath
      // point. The link records the cut-to-cut jump; the span records the boundary walk.
      // The "rides the boundary" check below validates the span start instead.)
      const last = span[span.length - 1]
      const linkEnd = link.points[1]
      expect(Math.hypot(last.x - linkEnd.x, last.y - linkEnd.y)).toBeLessThan(tol)

      // Every span point -- including the first -- rides the cutRegion boundary (it is, by
      // construction, a boundary polyline). Tight tolerance proves it is the wall, not some
      // unrelated geometry.
      for (const p of span) {
        expect(distToLoops(p, res.cutRegion)).toBeLessThan(rideTol)
      }
    }
  }, 60_000)
})
