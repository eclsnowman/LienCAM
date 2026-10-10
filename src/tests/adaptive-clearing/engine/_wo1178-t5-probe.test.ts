// WO-1178 T5 PROBE (underscore = not CI): measure every emitted at-depth connection of one
// corpus operation with the ENGINE'S OWN sustained-load gate (rideOverloadsUncut) against the
// physical belief at the moment it executes (entries + every cut corridor emitted before it).
// Reports the rides that sustain more than the traverse bound and more than the cut cap.
//
// Run: WO1178_SHAPES=Bar npx vitest run src/tests/adaptive-clearing/engine/_wo1178-t5-probe.test.ts

import { describe, it, beforeAll } from 'vitest'
import {
  ensureEngineClipperReady, diskPath, offsetOpenRound, union, type Loops,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, rideOverloadsUncut } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import { projectFixture } from './_wo1178-fixture'

const SHAPES = (process.env.WO1178_SHAPES ?? 'Bar').split(',')
const atDepthConnection = (p: { type: string; jumpType?: number }): boolean =>
  p.type === 'wallfollow' || p.type === 'loopback' || p.type === 'lead' || (p.type === 'link' && p.jumpType === 1)

describe('WO-1178 T5 probe', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  for (const name of SHAPES) {
    it(`measures ${name}`, () => {
      const { boundary, holes, params } = projectFixture(name)
      const R = params.toolRadius
      const arcTol = Math.max(params.tolerance * 0.25, 0.01)
      const tool = createToolGeometry(R, params.stepOver, arcTol)
      const optimal = tool.optimalCutAreaPerDist
      const stepOverDistance = 2 * R * params.stepOver
      const engageMove = stepOverDistance / 4 + arcTol * 4
      const traverseCap = Math.max(arcTol, 1.5 * optimal * engageMove / 2.0)
      const rideCap = 1.5 * stepOverDistance
      const warn = console.warn; console.warn = () => {}
      let res
      try { res = processFeature({ boundary, holes }, params) } finally { console.warn = warn }
      let cleared: Loops = []
      const rows: string[] = []
      let overTraverse = 0, overRide = 0, overTraverseLen = 0
      res.passes.forEach((pass, index) => {
        if (pass.type === 'entry') { cleared = union(cleared, diskPath(pass.point, R + pass.radius, arcTol)); return }
        if (pass.type === 'cut') { cleared = union(cleared, offsetOpenRound(pass.points, R, arcTol)); return }
        if (pass.type === 'finish') { cleared = union(cleared, offsetOpenRound(pass.points, R, arcTol)); return }
        if (pass.type === 'link' && pass.jumpType === 2) return
        const t = rideOverloadsUncut(pass.points, cleared, R, traverseCap, arcTol)
        const c = rideOverloadsUncut(pass.points, cleared, R, rideCap, arcTol)
        // Physical truth: the ride sweeps its capsule; later moves are measured against it.
        if (pass.points.length >= 2) cleared = union(cleared, offsetOpenRound(pass.points, R, arcTol))
        const len = pass.points.reduce((s, p, i) => i ? s + Math.hypot(p.x - pass.points[i - 1].x, p.y - pass.points[i - 1].y) : 0, 0)
        if (t) { overTraverse++; overTraverseLen += len }
        if (c) overRide++
        if (t || c) rows.push(`${index} ${pass.type}${pass.type === 'link' ? pass.jumpType : ''} len ${len.toFixed(2)} traverse:${t ? t.width.toFixed(2) + '@(' + t.at.x.toFixed(1) + ',' + t.at.y.toFixed(1) + ')' : 'ok'} ride:${c ? c.width.toFixed(2) : 'ok'}`)
      })
      console.log(`[t5] ${name}: ${overTraverse} at-depth connections over the traverse bound ${traverseCap.toFixed(3)} (${overTraverseLen.toFixed(0)} mm), ${overRide} over the ride cap ${rideCap.toFixed(2)}`)
      for (const r of rows.slice(0, 60)) console.log(`[t5]   ${r}`)
      if (process.env.WO1178_T5_OUT) {
        // eslint-disable-next-line @typescript-eslint/no-require-imports -- sync probe inside a forEach callback; cannot await an import
        const fs = require('fs') as typeof import('fs')
        fs.mkdirSync(process.env.WO1178_T5_OUT, { recursive: true })
        fs.writeFileSync(`${process.env.WO1178_T5_OUT}/${name}.json`, JSON.stringify({
          name, traverseCap: +traverseCap.toFixed(3), rideCap: +rideCap.toFixed(3),
          connections: res.passes.filter(p => atDepthConnection(p)).length,
          overRideCap: overRide, overTraverseBound: overTraverse, overTraverseBoundMm: +overTraverseLen.toFixed(1), rows,
        }, null, 1))
      }
    }, 300_000)
  }
})
