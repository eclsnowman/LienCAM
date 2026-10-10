// WO-1091 DIAGNOSTIC: the Bar lift landing at ~(124, -52) -- what the gate sees there.
//
// Measurement only, skipped unless WO1091_PROBE is set:
//   WO1091_PROBE=1 npx vitest run src/tests/adaptive-clearing/engine/_wo1091-probe.test.ts

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

describe('WO-1091 probe', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it.skipIf(!process.env.WO1091_PROBE)('dumps the lift-landing decisions per fixture', () => {
    const only = process.env.WO1091_FIX ? process.env.WO1091_FIX.split(',').map(Number) : null
    for (const meta of FIXTURE_META) {
      if (only && !only.includes(meta.fix)) continue
      const { boundary, holes } = loadGtFixture(meta.fix)
      const warn = console.warn
      const warns: string[] = []
      console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }
      let res
      try { res = processFeature({ boundary, holes }, CORPUS_PARAMS) } finally { console.warn = warn }
      const lifts = res.passes.filter(p => p.type === 'link' && p.jumpType === 2) as Extract<AdaptivePass, { type: 'link' }>[]
      console.log(`=== fix${meta.fix} ${meta.name}: ${lifts.length} lifts, ${lifts.filter(l => l.helixDescent).length} helix descents`)
      for (const l of lifts) {
        console.log(`  lift ${l.points[0].x.toFixed(2)},${l.points[0].y.toFixed(2)} -> ${l.points[1].x.toFixed(2)},${l.points[1].y.toFixed(2)}`
          + (l.helixDescent ? ` HELIX@(${l.helixDescent.center.x.toFixed(2)},${l.helixDescent.center.y.toFixed(2)})r${l.helixDescent.radius.toFixed(2)}` : '')
          + ` reason=${(l as { liftReason?: string }).liftReason ?? '-'}`)
      }
      for (const w of warns.filter(w => w.includes('[lift-landing]') || w.includes('[side-'))) console.log('  W ' + w)
    }
    expect(true).toBe(true)
  }, 2_400_000)

  // WO-1091 audit round 2: what the MACHINE runs at Bar's landing, before and after the
  // emitted-shape fix. "Before" is exact, not reconstructed: the planner output is identical
  // apart from the `clearAirLanding` flag, so stripping the flag off a copy of the same plan
  // replays precisely the move stream attempt 1 emitted. Writes the evidence text file:
  //   WO1091_EMIT=1 npx vitest run src/tests/adaptive-clearing/engine/_wo1091-probe.test.ts
  it.skipIf(!process.env.WO1091_EMIT)('dumps the emitted motion at the Bar landing, before vs after', () => {
    const ctx: EmitContext = {
      heights: { clearanceZ: 15, retractZ: 5, feedZ: 1, topZ: 0, bottomZ: -2 },
      feeds: {
        feedRate: 1000, plungeRate: 300, rampRate: 450, leadInRate: 700,
        leadOutRate: 800, fastTraverseRate: 5000, finishRate: 900,
      },
      stepdown: 2, helixAngleDeg: 3, millingDirection: 'climb',
    }
    const { boundary, holes } = loadGtFixture(4)
    const warn = console.warn
    console.warn = () => {}
    let res
    try { res = processFeature({ boundary, holes }, CORPUS_PARAMS) } finally { console.warn = warn }

    const lift = res.passes.find(p => p.type === 'link' && p.jumpType === 2) as Extract<AdaptivePass, { type: 'link' }>
    const landing = lift.points[1]
    const flagged = !!lift.clearAirLanding

    // The same plan with the flag removed = attempt 1's emitter input, exactly.
    const stripped = {
      ...res,
      passes: res.passes.map(p => (p === lift ? { ...lift, clearAirLanding: undefined } : p)),
    }

    const window = (moves: ReturnType<typeof emitFeature>): string[] => {
      const i = moves.findIndex(m => Math.hypot(m.x - landing.x, m.y - landing.y) <= 1e-6 && Math.abs(m.z + 2) <= 1e-9)
      return moves.slice(Math.max(0, i - 2), i + 8).map((m, k) =>
        `  ${k === 2 ? '->' : '  '} ${m.type.padEnd(5)} x=${m.x.toFixed(3).padStart(9)} y=${m.y.toFixed(3).padStart(9)} `
        + `z=${m.z.toFixed(3).padStart(7)} role=${String(m.role).padEnd(13)} feed=${m.feed ?? '-'}`)
    }

    const out = [
      'WO-1091: THE EMITTED MOTION AT BAR\'S CLEAR-AIR LANDING',
      '',
      `Fixture Bar (gt_fix4) at the corpus settings. Landing (${landing.x.toFixed(2)}, ${landing.y.toFixed(2)}).`,
      `Planner flag clearAirLanding = ${flagged}. Rates are distinct so each move names its own rule:`,
      '  feedRate 1000  plungeRate 300  rampRate 450  leadInRate 700.',
      'The "->" row is the move that reaches the level depth at the landing XY.',
      '',
      'BEFORE (audit FAIL -- planner landed in air, emit still drilled and cut the engage):',
      ...window(emitFeature(stripped, ctx)),
      '',
      'AFTER (the side entry\'s own shape: rapid over, RAPID DOWN through air, engage at leadInRate):',
      ...window(emitFeature(res, ctx)),
      '',
    ].join('\n')
    fs.writeFileSync('src/tests/evidence/WO-1091/emitted-landing.txt', out)
    console.log(out)
    expect(flagged).toBe(true)
  }, 2_400_000)
})
