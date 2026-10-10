// WO-1087 DIAGNOSTIC: every helix Operator can SEE in the GOOD corpus, and which planner made it.
//
// The pass stream is not what the viewport draws. `emitFeature` turns the plan into moves, and
// THREE different places emit a helix ramp:
//   1. a region ENTRY (AdaptiveEntry mode 'helix')            -- planned in processFeature
//   2. a LIFT LANDING on a mostly-uncut disk (link.helixDescent) -- the lift-landing gate
//   3. a WALL-FINISH LAP CONNECTION whose shaft is not proven clear (WO-449 approach.helix)
// Operator's three pictures show orange rings; this probe says which of the three each ring is,
// at the settings the corpus project itself carries (4 mm cutter, stepover 1.6 mm, 0.5 mm
// stock, helix 95% of diameter, wall finish ON, climb, one 2 mm depth level).
//
// Measurement only, skipped unless WO1087_HELIX is set:
//   WO1087_HELIX=1 npx vitest run src/tests/adaptive-clearing/engine/_wo1087-helix-source.test.ts

import { describe, it, beforeAll, expect } from 'vitest'
import * as fs from 'fs'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { emitFeature, type EmitContext } from '../../../lib/cam/adaptiveClearing2d/engine/emit'
import { loadGtFixture, FIXTURE_META } from './_goodspec-helpers'

const CORPUS_PARAMS: ProcessParams = {
  toolRadius: 2.0, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
  integralWallFollow: true, integralWallFollowLengthFactor: 2, wallCleanupAsWeGo: true,
  loopbackFilletPct: 25, wallFinish: true, millingDirection: 'climb',
}

// The Bar operation's own heights/feeds block, verbatim from the project file.
const CTX: EmitContext = {
  heights: { clearanceZ: 15, retractZ: 5, feedZ: 5, topZ: 0, bottomZ: -2 },
  feeds: { feedRate: 1000, plungeRate: 300, rampRate: 500, leadInRate: 500, leadOutRate: 500, fastTraverseRate: 5000, finishRate: 1000 },
  stepdown: 2,
  helixAngleDeg: 3,
}

interface Ring { x: number; y: number; moves: number; firstMoveIdx: number }

describe('WO-1087: which planner drew each orange ring', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it.skipIf(!process.env.WO1087_HELIX)('counts emitted helix ramps and attributes each one', () => {
    const report: Record<string, unknown> = {}
    for (const meta of FIXTURE_META) {
      const { boundary, holes } = loadGtFixture(meta.fix)
      const warn = console.warn
      const warns: string[] = []
      console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }
      let res, moves
      try {
        res = processFeature({ boundary, holes }, CORPUS_PARAMS)
        moves = emitFeature(res, CTX)
      } finally { console.warn = warn }

      // Group consecutive 'helix'-role moves into rings, and take each ring's centre as the
      // mean of its points (a helix ramp is a full circle of feed moves).
      const rings: Ring[] = []
      let cur: { xs: number[]; ys: number[]; first: number } | null = null
      moves.forEach((m, i) => {
        if (m.role === 'helix') {
          if (!cur) cur = { xs: [], ys: [], first: i }
          cur.xs.push(m.x); cur.ys.push(m.y)
        } else if (cur) {
          rings.push({
            x: cur.xs.reduce((a, b) => a + b, 0) / cur.xs.length,
            y: cur.ys.reduce((a, b) => a + b, 0) / cur.ys.length,
            moves: cur.xs.length, firstMoveIdx: cur.first,
          })
          cur = null
        }
      })

      const entries = res.entries.map(e => ({ mode: e.mode, x: e.point.x, y: e.point.y, r: e.radius }))
      const liftHelixes = (res.passes.filter(p => p.type === 'link' && p.jumpType === 2 && !!p.helixDescent) as Extract<AdaptivePass, { type: 'link' }>[])
        .map(l => ({ x: l.helixDescent!.center.x, y: l.helixDescent!.center.y, r: l.helixDescent!.radius }))

      // Attribute each emitted ring to the nearest planned helix source.
      const near = (r: Ring, pts: { x: number; y: number }[]) =>
        pts.some(p => Math.hypot(p.x - r.x, p.y - r.y) <= 0.75)
      const attributed = rings.map(r => {
        if (near(r, entries.filter(e => e.mode === 'helix'))) return 'entry'
        if (near(r, liftHelixes)) return 'lift-landing'
        return 'finish-lap-connection-or-unattributed'
      })

      report[`fix${meta.fix}`] = {
        name: meta.name, entries, liftHelixes,
        emittedRings: rings.map((r, i) => ({ x: Number(r.x.toFixed(2)), y: Number(r.y.toFixed(2)), source: attributed[i] })),
        finishConnectionWarns: warns.filter(w => w.includes('[finish-connection]')),
      }
      console.log(`fix${meta.fix} ${meta.name}: ${rings.length} emitted helix ring(s) -> `
        + rings.map((r, i) => `${attributed[i]}@(${r.x.toFixed(2)},${r.y.toFixed(2)})`).join(' '))
    }
    if (process.env.WO1087_HELIX_OUT) fs.writeFileSync(process.env.WO1087_HELIX_OUT, JSON.stringify(report, null, 2) + '\n')
    expect(Object.keys(report)).toHaveLength(9)
  }, 2_400_000)
})
