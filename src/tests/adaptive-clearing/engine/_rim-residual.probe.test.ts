// WO-410 probe (opt-in): run one gt corpus fixture through processFeature with the
// canonical engine settings and print the HONEST residual by piece (area, centroid,
// max inscribed radius) plus the entries and abort state. Used to chase standing
// rims/lobes the belief used to hide behind the phantom cleared disk.
//
//   RIM_PROBE=<fix#> npx vitest run src/tests/adaptive-clearing/engine/_rim-residual.probe.test.ts
import { describe, it, beforeAll } from 'vitest'
import * as fs from 'node:fs'
import { ensureEngineClipperReady, offsetClosed, difference, loopArea, netArea, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const FIX = process.env.RIM_PROBE
describe.skipIf(!FIX)('rim residual probe', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  it('prints the honest residual by piece', { timeout: 600000 }, () => {
    const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${FIX}.json`, 'utf8'))
    const boundary: Loop = (d.boundary as number[][]).map(([x, y]) => ({ x, y }))
    const holes: Loop[] = (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y })))
    const res = processFeature({ boundary, holes }, {
      toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter: d.helix?.diameter ?? 3, stockToLeave: 0.5,
      integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
    })
    console.log(`[rim] ${d.name}: ${res.passes.length} passes, entries ${res.entries.length}, aborted ${res.stats.aborted ?? 'no'}, residual ${res.stats.residualArea.toFixed(1)} mm^2, maxInscribedR ${res.stats.residualMaxInscribedR}`)
    for (const e of res.entries) console.log(`[rim]   entry ${e.mode} at (${e.point.x.toFixed(2)}, ${e.point.y.toFixed(2)}) r ${e.radius.toFixed(2)}`)
    const pieces = res.residual
      .map((loop) => ({ loop, a: loopArea(loop) }))
      .sort((u, v) => Math.abs(v.a) - Math.abs(u.a))
    for (const piece of pieces.slice(0, 12)) {
      const cx = piece.loop.reduce((t, q) => t + q.x, 0) / piece.loop.length
      const cy = piece.loop.reduce((t, q) => t + q.y, 0) / piece.loop.length
      // Max inscribed radius of this one piece (coarse: decremental inward offset).
      let inscribed = 0
      for (let r = 0.1; r <= 3.0; r += 0.1) {
        if (offsetClosed([piece.loop], -r).length === 0) break
        inscribed = r
      }
      console.log(`[rim]   piece ${piece.a.toFixed(1)} mm^2 near (${cx.toFixed(1)}, ${cy.toFixed(1)}) inscribedR ~${inscribed.toFixed(1)}`)
    }
    // How much of the residual is REAL material the tool can reach (the WO-409 completeness measure)?
    const featLoops = [boundary, ...holes]
    const reachable = offsetClosed(res.cutRegion, 2.0, 0.025)
    const realLeft = difference(reachable, res.cleared)
    console.log(`[rim] reachable real leftover: ${Math.abs(netArea(realLeft)).toFixed(1)} mm^2 (feature loops ${featLoops.length})`)
  })
})
