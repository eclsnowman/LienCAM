// WO-1090 diagnostic probe (underscore prefix = not CI-gated; kept as the order's measurement
// harness). Censuses the wall-clean unjoinable-transition ladder across the nine-fixture corpus
// plus the two fixtures whose invariants WO-1069 regressed, and prints each fixture's
// fingerprint so a shape change is visible without regenerating any baseline.
import { describe, it, beforeAll, expect, vi } from 'vitest'
import * as fs from 'fs'
import * as crypto from 'crypto'
import { ensureEngineClipperReady, type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type ProcessParams, type AdaptivePass } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { loadGtFixture, CANONICAL_PARAMS } from './_goodspec-helpers'

const TAG = process.env.WO1090_TAG ?? 'now'
// WO-1093 rule (applied by WO-1280): _probe-<tag>.txt is written ONLY under WRITE_EVIDENCE=1;
// a bare run skips and says so (it used to rewrite the tracked _probe-now.txt every suite run).
const WRITE_EVIDENCE = process.env.WRITE_EVIDENCE === '1'

function fingerprint(res: { startPoint: unknown; entries: unknown; passes: AdaptivePass[] }): string {
  return crypto.createHash('sha256')
    .update(JSON.stringify({ startPoint: res.startPoint, entries: res.entries, passes: res.passes }))
    .digest('hex').slice(0, 16)
}

function summarize(label: string, res: { startPoint: unknown; entries: unknown; passes: AdaptivePass[] }, lines: string[]): string[] {
  const lifts = res.passes.filter(p => p.type === 'link' && p.jumpType === 2).length
  const micro = res.passes.filter(p => p.type === 'link' && p.jumpType === 2 && p.microLift).length
  const out = [`${label}: hash=${fingerprint(res)} passes=${res.passes.length} lifts=${lifts} micro=${micro}`]
  for (const l of lines.filter(l => /wall-clean\]|wallCleanLoop\]/.test(l))) out.push('    ' + l)
  return out
}

function run<T>(fn: (record: string[]) => T): { value: T; lines: string[] } {
  const lines: string[] = []
  const spy = vi.spyOn(console, 'warn').mockImplementation((...a: unknown[]) => { lines.push(a.map(String).join(' ')) })
  try { return { value: fn(lines), lines } } finally { spy.mockRestore() }
}

describe('WO-1090 probe', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  it('corpus + regressed-fixture census', (ctx) => {
    if (!WRITE_EVIDENCE) return ctx.skip('not regenerating WO-1090 probe census: WRITE_EVIDENCE unset (WO-1093 rule)')
    const out: string[] = []
    for (let fix = 0; fix <= 8; fix++) {
      const { boundary, holes, helixDiameter, name } = loadGtFixture(fix)
      const { value, lines } = run(() => processFeature({ boundary, holes }, { ...CANONICAL_PARAMS, helixDiameter }))
      out.push(...summarize(`fix${fix} ${name}`, value, lines))
    }

    {
      const d = JSON.parse(fs.readFileSync('test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_two_island.json', 'utf8'))
      const boundary = (d.boundary as number[][]).map(([x, y]) => ({ x, y })) as Loop
      const holes = ((d.islands ?? []) as number[][][]).map(isl => isl.map(([x, y]) => ({ x, y }))) as Loop[]
      const params = d.params as Partial<ProcessParams> | undefined
      const { value, lines } = run(() => processFeature({ boundary, holes }, {
        toolRadius: params?.toolRadius ?? 3, stepOver: params?.stepOver ?? 0.25, tolerance: params?.tolerance ?? 0.1,
        helixDiameter: d.helix?.diameter ?? 3, stockToLeave: params?.stockToLeave ?? 0,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
      }))
      out.push(...summarize('gt_two_island', value, lines))
    }

    {
      const SIZE = 120, ISLR = 20, TOOLR = 3
      const square: Loop = [{ x: 0, y: 0 }, { x: SIZE, y: 0 }, { x: SIZE, y: SIZE }, { x: 0, y: SIZE }]
      const island: Loop = []
      for (let i = 0; i < 180; i++) { const a = 2 * Math.PI * i / 180; island.push({ x: SIZE / 2 + ISLR * Math.cos(a), y: SIZE / 2 + ISLR * Math.sin(a) }) }
      const { value, lines } = run(() => processFeature({ boundary: square, holes: [island] }, {
        toolRadius: TOOLR, stepOver: 0.25, tolerance: 0.1, helixDiameter: TOOLR * 2 * 0.9, stockToLeave: 0,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25, wallFinish: true,
      }))
      out.push(...summarize('b8-island-repro', value, lines))
    }

    fs.mkdirSync('src/tests/evidence/WO-1090', { recursive: true })
    fs.writeFileSync(`src/tests/evidence/WO-1090/_probe-${TAG}.txt`, out.join('\n') + '\n')
    console.log(out.join('\n'))
    expect(true).toBe(true)
  }, 1_800_000)
})
