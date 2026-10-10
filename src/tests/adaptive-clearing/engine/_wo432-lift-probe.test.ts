// WO-432 LIFT PROBE (diagnostic; underscore = not CI). Runs one gt fixture at the
// canonical corpus settings, captures every console.warn, and attributes each
// jumpType-2 lift to its mechanism so the retract explosion has named sources.
//
// Run:  WO432_FIX=0 npx vitest run src/tests/adaptive-clearing/engine/_wo432-lift-probe.test.ts

import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import { ensureEngineClipperReady, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const FIX = Number(process.env.WO432_FIX ?? 0)

function loadGtFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name as string,
  }
}

describe(`WO-432 lift probe (gt_fix${FIX})`, () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('attributes every lift', () => {
    const { boundary, holes, helixDiameter, name } = loadGtFixture(FIX)
    const params: ProcessParams = {
      toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
      integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
    }
    const warns: string[] = []
    const warn = console.warn
    console.warn = (...a: unknown[]) => { warns.push(a.map(String).join(' ')) }
    let res
    try { res = processFeature({ boundary, holes }, params) } finally { console.warn = warn }

    const passes = res.passes
    const lifts: { i: number; from: string; to: string; len: number; prev: string; next: string }[] = []
    for (let i = 0; i < passes.length; i++) {
      const p = passes[i]
      if (p.type === 'link' && (p as Extract<AdaptivePass, { type: 'link' }>).jumpType === 2) {
        const pts = (p as Extract<AdaptivePass, { type: 'link' }>).points
        lifts.push({
          i,
          from: `(${pts[0].x.toFixed(1)}, ${pts[0].y.toFixed(1)})`,
          to: `(${pts[1].x.toFixed(1)}, ${pts[1].y.toFixed(1)})`,
          len: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
          prev: passes[i - 1]?.type ?? 'START',
          next: passes[i + 1]?.type ?? 'END',
        })
      }
    }

    const cat = (rx: RegExp) => warns.filter(w => rx.test(w)).length
    console.log(`\n[lift-probe] ${name}: passes=${passes.length} lifts=${lifts.length} entries=${res.entries.length} aborted=${res.stats.aborted ?? 'no'}`)
    console.log(`[lift-probe] warn counts: total=${warns.length}`)
    console.log(`  keep-down->lift (WO-410 gate): ${cat(/\[keep-down\] link .* lifting instead/)}`)
    console.log(`  B8 direct-ride rejected+routed: ${cat(/ROUTED AROUND on the alternate/)}`)
    console.log(`  B8 chord routed: ${cat(/ROUTED AROUND on the through-cleared/)}`)
    console.log(`  B8 rejection->lift: ${cat(/no boundary arc or through-cleared chord is safe -- lifting/)}`)
    console.log(`  lift-landing rejected: ${cat(/\[lift-landing\]/)}`)
    console.log(`  wall-clean rejections: ${cat(/\[wall-clean\]/)}`)
    console.log(`  reseed/walker warns: ${cat(/reseed|exhaust/i)}`)
    for (const L of lifts) console.log(`  lift@${L.i} ${L.from} -> ${L.to} len=${L.len.toFixed(1)} prev=${L.prev} next=${L.next}`)
    const unmatched = warns.filter(w => !/\[keep-down\]|\[integral-wallfollow\]|\[lift-landing\]|\[wall-clean\]/.test(w))
    console.log(`[lift-probe] other warns (${unmatched.length}):`)
    for (const w of unmatched.slice(0, 20)) console.log(`  ${w.slice(0, 220)}`)
    // full keep-down conversions, verbatim (they carry the measured width)
    for (const w of warns.filter(x => /\[keep-down\]/.test(x)).slice(0, 30)) console.log(`  KD: ${w.slice(0, 220)}`)
  }, 600_000)
})
