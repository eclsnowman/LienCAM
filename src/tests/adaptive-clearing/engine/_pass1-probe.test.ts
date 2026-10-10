// PROBE TOOL (root-cause, large-area bug): inspect the FIRST few cut passes of the
// GOOD 300x200 case to see how pass 1 ends (wall reach vs mid-material truncation by
// MAX_POINTS_PER_PASS). Complements _clipper-large-coord-probe.test.ts.
//
//   $env:PROBE='1'; npx vitest run src/tests/adaptive-clearing/engine/_pass1-probe.test.ts --testTimeout=600000
import { describe, it, beforeAll } from 'vitest'
import { ensureEngineClipperReady, type Pt } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

describe.runIf(!!process.env.PROBE)('pass-1 anatomy, good 300x200 case', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  it('reports how the first cut passes end', () => {
    const W = 300, H = 200
    const boundary = [{ x: 0, y: 0 }, { x: W, y: 0 }, { x: W, y: H }, { x: 0, y: H }]
    const res = processFeature({ boundary, holes: [] }, {
      toolRadius: 2, stepOver: 0.25, tolerance: 0.1, helixDiameter: 3, stockToLeave: 0.5,
    })
    const inset = 2.55 // toolRadius + finishStock: cutRegion walls
    const distToWall = (p: Pt) => Math.min(p.x - inset, p.y - inset, W - inset - p.x, H - inset - p.y)
    const cuts = res.passes.filter(p => p.type === 'cut') as { points: Pt[] }[]
    /* eslint-disable no-console */
    console.log(`300x200: cutPasses=${cuts.length} totalPoints=${res.stats.points} aborted=${res.stats.aborted ?? 'no'}`)
    for (let k = 0; k < Math.min(cuts.length, 5); k++) {
      const pts = cuts[k].points
      let len = 0
      for (let i = 1; i < pts.length; i++) len += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
      const s = pts[0], e = pts[pts.length - 1]
      console.log(`  cut[${k}]: pts=${pts.length} len=${len.toFixed(0)}mm start=(${s.x.toFixed(1)},${s.y.toFixed(1)}) end=(${e.x.toFixed(1)},${e.y.toFixed(1)}) endDistToWall=${distToWall(e).toFixed(2)}mm`)
    }
    /* eslint-enable no-console */
  }, 600000)
})
