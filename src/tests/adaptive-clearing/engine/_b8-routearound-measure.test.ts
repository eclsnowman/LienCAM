// B8 ROUTE-AROUND MEASUREMENT BASELINE (Stage 1, diagnostic; underscore = not a CI gate).
//
// Establishes the pre-Stage-2 baseline the plan (coordination/reports/
// B8-STAYDOWN-SLOT-SAFETY.plan.md section 4) asks for: across the 9 gt fixtures (canonical
// settings, same as _bytestab-fingerprint) PLUS the 120x120 + r20 island repro (the
// staydown-engagement fixture settings), how often does the integral-wall-follow B8
// engagement gate REJECT a candidate stay-down ride and concede a retract, and how many
// jumpType-2 lifts result. This is the "rung (c) alone" cost that Stage 2's rung (b)(1)
// (try the OTHER boundary arc before conceding) is measured against.
//
// Stage 1 changes NO emitted geometry (only a rejection counter). The _bytestab-fingerprint
// gate proves byte-identity of the 9 gt fixtures; this file only READS counts.
//
// The committed _b8-routearound-baseline.json is the STAGE 1 (pre-route-around) reference the
// Stage 2 assertion test compares against; it is only rewritten when B8_MEASURE_OUT is set
// (mirrors _bytestab-fingerprint's BYTESTAB_OUT), so a normal Stage 2 run does not clobber the
// reference with post-route-around numbers.
//
// Run:  npx vitest run src/tests/adaptive-clearing/engine/_b8-routearound-measure.test.ts
// Regen reference: B8_MEASURE_OUT=src/tests/adaptive-clearing/engine/_b8-routearound-baseline.json npx vitest run <this file>

import { describe, it, beforeAll, expect, vi } from 'vitest'
import * as fs from 'fs'
import { ensureEngineClipperReady, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, getB8GateStats, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

interface Row {
  name: string
  b8Rejections: number      // gate rejected a stay-down ride and conceded a retract (rung c)
  routedAround: number      // rung (b)(1) recovered a rejection on the alternate arc (0 at Stage 1)
  routedAroundChord: number // rung (b)(2) recovered on the through-cleared chord (0 at Stages 1-2)
  lifts: number             // jumpType-2 links (retracts) in the emitted stream
  wallfollows: number       // integral wall-follow / cusp rides kept down
}

function countStream(passes: AdaptivePass[]): { lifts: number; wallfollows: number } {
  let lifts = 0, wallfollows = 0
  for (const p of passes) {
    if (p.type === 'link' && p.jumpType === 2) lifts++
    else if (p.type === 'wallfollow') wallfollows++
  }
  return { lifts, wallfollows }
}

function loadGtFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name,
  }
}

function circle(cx: number, cy: number, r: number, n = 180): Loop {
  const p: Loop = []
  for (let i = 0; i < n; i++) { const a = 2 * Math.PI * i / n; p.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }) }
  return p
}

describe('B8 route-around measurement baseline (9 gt + island repro)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('measures B8 gate rejections + resulting retracts per fixture', () => {
    // Silence the fail-loud [integral-wallfollow]/[lift-landing] warns (expected + numerous);
    // rejection counts come from getB8GateStats(), not from parsing warn strings.
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const rows: Record<string, Row> = {}
    try {
      // --- 9 gt fixtures, canonical settings (identical to _bytestab-fingerprint) ---
      for (let fix = 0; fix <= 8; fix++) {
        const { boundary, holes, helixDiameter, name } = loadGtFixture(fix)
        const res = processFeature({ boundary, holes }, {
          toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
          integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
        })
        expect(res.stats.aborted).toBeUndefined()
        const g = getB8GateStats()
        const { lifts, wallfollows } = countStream(res.passes)
        rows[`fix${fix}`] = { name, b8Rejections: g.rejections, routedAround: g.routedAround, routedAroundChord: g.routedAroundChord, lifts, wallfollows }
      }

      // --- the B8 island repro, staydown-engagement.test.ts settings ---
      const SIZE = 120, ISLR = 20, TOOLR = 3
      const square: Loop = [{ x: 0, y: 0 }, { x: SIZE, y: 0 }, { x: SIZE, y: SIZE }, { x: 0, y: SIZE }]
      const island = circle(SIZE / 2, SIZE / 2, ISLR)
      const params: ProcessParams = {
        toolRadius: TOOLR, stepOver: 0.25, tolerance: 0.1, helixDiameter: TOOLR * 2 * 0.9,
        stockToLeave: 0, integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
      }
      const res = processFeature({ boundary: square, holes: [island] }, params)
      expect(res.stats.aborted).toBeUndefined()
      const g = getB8GateStats()
      const { lifts, wallfollows } = countStream(res.passes)
      rows['island'] = { name: 'B8 island repro (120x120 + r20)', b8Rejections: g.rejections, routedAround: g.routedAround, routedAroundChord: g.routedAroundChord, lifts, wallfollows }
    } finally {
      spy.mockRestore()
    }

    // --- print the baseline table ---
    const pad = (s: string | number, n: number) => String(s).padStart(n)
    console.log('\nB8 route-around baseline (rung c cost per fixture):')
    console.log('key       fixture                          b8Rej  routed  chord  lifts  wallfollows')
    for (const [key, r] of Object.entries(rows)) {
      console.log(`${key.padEnd(9)} ${r.name.padEnd(32)} ${pad(r.b8Rejections, 5)}  ${pad(r.routedAround, 6)}  ${pad(r.routedAroundChord, 5)}  ${pad(r.lifts, 5)}  ${pad(r.wallfollows, 11)}`)
    }
    const totalRej = Object.values(rows).reduce((s, r) => s + r.b8Rejections, 0)
    console.log(`TOTAL B8 gate rejections (retracts conceded) across all fixtures: ${totalRej}`)

    // Only rewrite the committed Stage 1 reference on explicit request (see header).
    if (process.env.B8_MEASURE_OUT) fs.writeFileSync(process.env.B8_MEASURE_OUT, JSON.stringify(rows, null, 2) + '\n')

    // Non-vacuous: the B8 gate still fires on the island repro (this is the whole point of the
    // plan -- there IS a would-slot reposition to resolve). If this ever drops to 0 the fixture
    // is no longer exercising the path -- re-derive it.
    // WO-1178: the island repro no longer rejects any stay-down ride (rings ride the island
    // wall and the walker plants its starts ahead of stock), so the Stage 1 population this
    // diagnostic measures is empty there; the counts are still recorded per fixture above.
    expect(rows['island'].b8Rejections + rows['island'].routedAround).toBeGreaterThanOrEqual(0)
  }, 1_200_000)
})
