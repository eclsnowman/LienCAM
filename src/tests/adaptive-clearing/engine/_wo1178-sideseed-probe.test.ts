// WO-1178 item 5 (WO-431) DIAGNOSIS PROBE (underscore = not CI): the outside-in side start on
// sideSeedStage1's fixture. Prints every pass, its end reason and what the walker/reseed did.
//
// Run: npx vitest run src/tests/adaptive-clearing/engine/_wo1178-sideseed-probe.test.ts

import { describe, it, beforeAll } from 'vitest'
import {
  ensureEngineClipperReady, intersection, netArea, type Loop, type Loops,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import {
  processFeature, setFragmentationCensus, getFragmentationCensus,
} from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { buildSideEntrySeed } from '../../../cam3d/rough/sideSeed'
import { ensureGeom2dReady, type Ring } from '../../../cam3d/geom2d'

describe('WO-1178 side-seed probe', () => {
  beforeAll(async () => { await ensureGeom2dReady(); await ensureEngineClipperReady() })

  it('dumps the side-start walk on the sideSeedStage1 fixture', () => {
    const footprint: Ring[] = [new Float64Array([-30, -30, 30, -30, 30, 30, -30, 30])]
    const toolRadius = 3
    const feat = {
      boundary: [{ x: -30, y: -30 }, { x: 30, y: -30 }, { x: 30, y: 30 }, { x: -30, y: 30 }] as Loop,
      holes: [[{ x: -5, y: -5 }, { x: -5, y: 5 }, { x: 5, y: 5 }, { x: 5, y: -5 }] as Loop],
    }
    const params = {
      toolRadius, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3, stockToLeave: 0,
      integralWallFollow: true, integralWallFollowLengthFactor: 2,
    }
    const seed: Loops = buildSideEntrySeed(footprint, toolRadius)
    const warnings: string[] = []
    const warn = console.warn
    console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) }
    setFragmentationCensus(true)
    let res
    try { res = processFeature(feat, { ...params, clearedSeed: seed }) } finally { console.warn = warn; setFragmentationCensus(false) }
    const census = getFragmentationCensus()
    const covered = netArea(intersection(res.cleared, res.cutRegion))
    const total = Math.abs(netArea(res.cutRegion))
    console.log(`[sideseed] entries ${JSON.stringify(res.entries)} passes ${res.passes.length} covered ${covered.toFixed(2)} / ${total.toFixed(2)} aborted ${res.stats.aborted}`)
    console.log(`[sideseed] startPoint ${JSON.stringify(res.startPoint)} cutRegion bbox ${JSON.stringify(res.cutRegion.map(l => [Math.min(...l.map(p => p.x)), Math.max(...l.map(p => p.x)), Math.min(...l.map(p => p.y)), Math.max(...l.map(p => p.y))]))}`)
    for (const p of res.passes.slice(0, 12)) {
      if (p.type === 'entry') { console.log(`[sideseed] entry ${JSON.stringify(p)}`); continue }
      const pts = p.points
      console.log(`[sideseed] ${p.type} n=${pts.length} from (${pts[0].x.toFixed(2)},${pts[0].y.toFixed(2)}) to (${pts[pts.length - 1].x.toFixed(2)},${pts[pts.length - 1].y.toFixed(2)})`)
    }
    for (const e of census.passEnds.slice(0, 12)) console.log(`[sideseed] passEnd ${JSON.stringify(e)}`)
    for (const r of census.reseeds) console.log(`[sideseed] reseed ${JSON.stringify(r)}`)
    for (const w of warnings.slice(0, 12)) console.log(`[sideseed] warn ${w.slice(0, 220)}`)
  }, 120_000)
})
