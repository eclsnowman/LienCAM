// WO-1103 BAR MEASUREMENT (measurement only; the gate lives in wo1103-channel-entry.test.ts).
//
// Prints, per settings bank, the numbers WO-1103's acceptance is written in: the entry point,
// jumpType-2 lifts, cut count, widest cut engagement and total cut length. Run it once with
// the engine change and once without (git checkout the engine file) to get the before/after
// pair.
//
// Measurement only, and skipped unless asked for (WO1103_MEASURE=1, or WO1103_OUT=<path>):
//   WO1103_OUT=src/tests/evidence/WO-1103/after-bar.json \
//     npx vitest run src/tests/adaptive-clearing/engine/_wo1103-bar-measure.test.ts
import { describe, it, beforeAll } from 'vitest'
import * as fs from 'fs'
import * as crypto from 'crypto'
import {
  ensureEngineClipperReady, offsetClosed, offsetOpenRound, union, difference, intersection,
  diskPath, netArea, type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const TR = 2.0
const ARC_TOL = 0.02
const FIX = 4 // Bar

function loadFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name as string,
  }
}
const plen = (pts: Pt[]): number => {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return L
}

function measure(bank: 'bytestab' | 'corpus'): Record<string, unknown> {
  const { boundary, holes, helixDiameter, name } = loadFixture(FIX)
  const params: ProcessParams = bank === 'corpus'
    ? {
        toolRadius: TR, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
        integralWallFollow: true, integralWallFollowLengthFactor: 2, wallCleanupAsWeGo: true,
        loopbackFilletPct: 25, wallFinish: true, millingDirection: 'climb',
      }
    : {
        toolRadius: TR, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
      }
  const warn = console.warn
  const warnings: string[] = []
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(' ')) }
  let res
  try { res = processFeature({ boundary, holes }, params) } finally { console.warn = warn }

  const lifts = res.passes.filter(p => p.type === 'link' && p.jumpType === 2) as Extract<AdaptivePass, { type: 'link' }>[]
  const cuts = res.passes.filter(p => p.type === 'cut')
  const targetRegion: Loops = offsetClosed(res.cutRegion, TR, ARC_TOL)
  let cleared: Loops = []
  for (const e of res.entries) if (e.radius > 0) cleared = union(cleared, diskPath(e.point, e.radius + TR, ARC_TOL))
  let maxCut = 0
  let cutLen = 0
  for (const p of res.passes) {
    if (p.type !== 'cut' && p.type !== 'wallfollow' && p.type !== 'lead') continue
    const L = plen(p.points)
    if (L < 1e-9 || p.points.length < 2) continue
    const sweep = offsetOpenRound(p.points, TR, ARC_TOL)
    if (!sweep.length) continue
    const uncut = difference(targetRegion, cleared)
    const bite = uncut.length ? intersection(sweep, uncut) : []
    const width = bite.length ? Math.abs(netArea(bite)) / L : 0
    if (p.type === 'cut') { if (width > maxCut) maxCut = width; cutLen += L }
    cleared = union(cleared, sweep)
  }
  return {
    bank, name,
    hash: crypto.createHash('sha256').update(JSON.stringify({ startPoint: res.startPoint, entries: res.entries, passes: res.passes })).digest('hex').slice(0, 16),
    entries: res.entries.map(e => `${e.mode}@(${e.point.x.toFixed(2)},${e.point.y.toFixed(2)})r${e.radius.toFixed(2)}`).join(' '),
    passes: res.passes.length,
    cuts: cuts.length,
    lifts: lifts.length,
    liftDetail: lifts.map(l => `(${l.points[0].x.toFixed(2)},${l.points[0].y.toFixed(2)})->(${l.points[l.points.length - 1].x.toFixed(2)},${l.points[l.points.length - 1].y.toFixed(2)}) ${l.liftReason ?? ''}`),
    maxCutEngagement: Number(maxCut.toFixed(4)),
    totalCutLength: Number(cutLen.toFixed(2)),
    residualArea: Number(res.stats.residualArea.toFixed(3)),
    // WO-1103 fix round: residualArea alone cannot tell "stock the walker skipped" from
    // "stock deliberately left in the wall-finish band". Split it, because the two are
    // judged differently -- the first is a defect, the second is the point of wallFinish.
    // (both are declared optional only for hand-built stubs; processFeature always sets them)
    residualWalkerArea: Number((res.stats.residualWalkerArea ?? NaN).toFixed(3)),
    residualFinishBandArea: Number((res.stats.residualFinishBandArea ?? NaN).toFixed(3)),
    residualMaxInscribedR: Number(res.stats.residualMaxInscribedR.toFixed(3)),
    aborted: res.stats.aborted ?? null,
    landingWarnings: warnings.filter(w => w.includes('lift-landing')),
  }
}

describe('WO-1103 Bar measurement', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })
  it.skipIf(!process.env.WO1103_MEASURE && !process.env.WO1103_OUT)('measures Bar at both banks', () => {
    const out: Record<string, unknown> = {}
    for (const bank of ['bytestab', 'corpus'] as const) {
      const m = measure(bank)
      out[bank] = m
      console.log(`\n--- ${bank} ---\n` + JSON.stringify(m, null, 2))
    }
    if (process.env.WO1103_OUT) fs.writeFileSync(process.env.WO1103_OUT, JSON.stringify(out, null, 2))
  }, 900000)
})
