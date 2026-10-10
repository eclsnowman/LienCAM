// WO-1087 BEFORE/AFTER CENSUS PROBE (measurement only -- asserts nothing about the change).
//
// Runs the 9 gt fixtures with the canonical bytestab settings and records, per fixture:
//   - entry modes (helix / plunge / side) and the total entry count
//   - lifts (jumpType-2 links), split micro / clearance
//   - pass count and the sha256 the bytestab gate pins, PLUS a sha256 over only the 'cut'
//     passes (the roughing cut path: the thing a re-pin must explain)
//   - residual area
//   - maxEngagement: the largest PER-PASS effective cut width over the cut passes, measured
//     by replaying every cut pass in order against the material model -- pass sweep =
//     offsetOpenRound(points, toolRadius), bite = sweep AND (targetRegion MINUS cleared),
//     width = biteArea / pathLength. Same currency as the B8 gate's "sustained effective
//     cut width"; it is a per-pass mean, so it under-reports an instantaneous spike but is
//     directly comparable before vs after, which is what the census is for.
//
// Not part of any gate, and SKIPPED unless asked for: the replay costs ~2 minutes over the
// nine fixtures, which no slice should pay on every run. Run it with WO1087_OUT set to a
// JSON path:
//   WO1087_OUT=src/tests/evidence/WO-1087/after.json \
//     npx vitest run src/tests/adaptive-clearing/engine/_wo1087-census.test.ts
// WO1087_FIX=<n>[,<n>...] restricts the run to those fixtures (fewer engine runs per
// process, for when the clipper2-wasm per-process run budget bites).

import { describe, it, beforeAll, expect } from 'vitest'
import * as fs from 'fs'
import * as crypto from 'crypto'
import {
  ensureEngineClipperReady, offsetOpenRound, offsetClosed, union, difference, intersection, diskPath,
  netArea, type Loop, type Loops, type Pt,
} from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { createToolGeometry } from '../../../lib/cam/adaptiveClearing2d/engine/toolGeometry'
import { processFeature, type AdaptivePass } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

const ARC_TOL = 0.02
const CORPUS = process.env.WO1087_PARAMS === 'corpus'

function loadFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name,
  }
}

function polylineLength(pts: { x: number; y: number }[]): number {
  let L = 0
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y)
  return L
}

export interface CensusRow {
  fix: number
  name: string
  hash: string
  cutHash: string
  passes: number
  entries: number
  helixEntries: number
  plungeEntries: number
  sideEntries: number
  entryModes: string
  entryPoints: string
  helixDescentLifts: number
  helixRingCount: number
  helixDescents: string
  /** Effective cut width of the first pass leaving each entry (see entryBites above). */
  entryBites: { mode: string; x: number; y: number; width: number }[]
  optimalCutAreaPerDist: number
  lifts: number
  microLifts: number
  clearanceLifts: number
  residualArea: number
  cutLength: number
  maxEngagement: number
  maxEngagementPass: number
  maxEngagementType: string
  maxCutEngagement: number
  /** The five widest 'cut' passes: index, chord length, effective width, start point. */
  worstCuts: { i: number; len: number; width: number; x: number; y: number }[]
  aborted: string | null
}

function census(fix: number): CensusRow {
  const { boundary, holes, helixDiameter, name } = loadFixture(fix)
  const toolRadius = 2.0
  // 'bytestab' = the settings the byte-stability gate pins. 'corpus' = the settings the
  // operations in `Example Projects/Adaptive Clearing Shapes.camproject` actually carry (4 mm
  // flat end mill, stepover 1.6 mm = 0.4 of diameter, 0.5 mm stock, helix 95% of diameter,
  // wall finish on, conventional) -- the run Operator's three pictures were taken from.
  const params = CORPUS
    ? {
        toolRadius, stepOver: 0.4, tolerance: 0.1, helixDiameter: 3.8, stockToLeave: 0.5,
        integralWallFollow: true, integralWallFollowLengthFactor: 2, wallCleanupAsWeGo: true,
        loopbackFilletPct: 25, wallFinish: true, millingDirection: 'climb' as const,
      }
    : {
        toolRadius, stepOver: 0.2, tolerance: 0.1, helixDiameter, stockToLeave: 0.5,
        integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
      }
  const warn = console.warn
  console.warn = () => {}
  let res
  try {
    res = processFeature({ boundary, holes }, params)
  } finally { console.warn = warn }

  const hash = crypto.createHash('sha256')
    .update(JSON.stringify({ startPoint: res.startPoint, entries: res.entries, passes: res.passes }))
    .digest('hex').slice(0, 16)
  const cutHash = crypto.createHash('sha256')
    .update(JSON.stringify(res.passes.filter(p => p.type === 'cut')))
    .digest('hex').slice(0, 16)

  const lifts = res.passes.filter(p => p.type === 'link' && p.jumpType === 2) as Extract<AdaptivePass, { type: 'link' }>[]
  const microLifts = lifts.filter(l => !!l.microLift).length
  // A LIFT can also drill a helix: when its landing disk is mostly uncut the lift-landing
  // gate plans a helix descent there (link.helixDescent). On screen that is the same orange
  // ring an entry helix draws, so the census has to tell the two apart.
  const helixDescentLifts = lifts.filter(l => !!l.helixDescent)
  const helixDescents = helixDescentLifts
    .map(l => `(${l.helixDescent!.center.x.toFixed(2)},${l.helixDescent!.center.y.toFixed(2)})r${l.helixDescent!.radius.toFixed(2)}`)
    .join(' ')
  const entryPoints = res.entries
    .map(e => `${e.mode}@(${e.point.x.toFixed(2)},${e.point.y.toFixed(2)})r${e.radius.toFixed(2)}`)
    .join(' ')

  // --- engagement replay -------------------------------------------------------------
  // targetRegion = the material a roughing pass may take = cutRegion dilated by R.
  const targetRegion: Loops = offsetClosed(res.cutRegion, toolRadius, ARC_TOL)
  let cleared: Loops = []
  // The entries' own descent disks are material the walk did not cut with a pass.
  for (const e of res.entries) {
    if (e.radius > 0) cleared = union(cleared, diskPath(e.point, e.radius + toolRadius, ARC_TOL))
  }
  let maxEngagement = 0
  let maxEngagementPass = -1
  // Split out the ROUGHING bite: 'cut' passes only. The corpus peak is otherwise always a
  // wall-follow ride or a lead, which is a different job with a different budget.
  let maxCutEngagement = 0
  let maxEngagementType = ''
  const cutSamples: { i: number; len: number; width: number; x: number; y: number }[] = []
  // The bite the walk actually takes AT an entry: the first pass whose first point IS the
  // entry point. For a roll-in ('side') that is the bounded engage getEngagePoint sized, so
  // this is the direct measurement of "the roll-in never exceeds the load setpoint".
  const entryBites: { mode: string; x: number; y: number; width: number }[] = []
  const entryAt = new Map<string, string>()
  const key = (pt: Pt) => `${pt.x.toFixed(6)},${pt.y.toFixed(6)}`
  for (const e of res.entries) entryAt.set(key(e.point), e.mode)
  res.passes.forEach((p, i) => {
    if (p.type !== 'cut' && p.type !== 'wallfollow' && p.type !== 'lead') return
    const pts = p.points
    if (pts.length < 2) return
    const len = polylineLength(pts)
    if (len < 1e-9) return
    const sweep = offsetOpenRound(pts, toolRadius, ARC_TOL)
    if (!sweep.length) return
    const uncut = difference(targetRegion, cleared)
    const bite = uncut.length ? intersection(sweep, uncut) : []
    const width = bite.length ? Math.abs(netArea(bite)) / len : 0
    if (width > maxEngagement) { maxEngagement = width; maxEngagementPass = i; maxEngagementType = p.type }
    if (p.type === 'cut') {
      if (width > maxCutEngagement) maxCutEngagement = width
      cutSamples.push({ i, len: Number(len.toFixed(3)), width, x: pts[0].x, y: pts[0].y })
    }
    const mode = entryAt.get(key(pts[0]))
    if (mode) { entryBites.push({ mode, x: pts[0].x, y: pts[0].y, width: Number(width.toFixed(4)) }); entryAt.delete(key(pts[0])) }
    cleared = union(cleared, sweep)
  })

  const modes = res.entries.map(e => e.mode)
  const cutLength = res.passes.reduce((sum, pass) =>
    pass.type === 'cut' ? sum + polylineLength(pass.points) : sum, 0)
  return {
    fix, name, hash, cutHash,
    passes: res.passes.length,
    entries: res.entries.length,
    helixEntries: modes.filter(m => m === 'helix').length,
    plungeEntries: modes.filter(m => m === 'plunge').length,
    sideEntries: modes.filter(m => m === 'side').length,
    entryModes: modes.join('|'),
    entryPoints,
    helixDescentLifts: helixDescentLifts.length,
    helixRingCount: modes.filter(mode => mode === 'helix').length + helixDescentLifts.length,
    helixDescents,
    entryBites,
    optimalCutAreaPerDist: Number(createToolGeometry(toolRadius, params.stepOver, ARC_TOL).optimalCutAreaPerDist.toFixed(4)),
    lifts: lifts.length,
    microLifts,
    clearanceLifts: lifts.length - microLifts,
    residualArea: Number(res.stats.residualArea.toFixed(4)),
    cutLength: Number(cutLength.toFixed(4)),
    maxEngagement: Number(maxEngagement.toFixed(4)),
    maxEngagementPass,
    maxEngagementType,
    maxCutEngagement: Number(maxCutEngagement.toFixed(4)),
    worstCuts: cutSamples.sort((a, b) => b.width - a.width).slice(0, 5)
      .map(c => ({ ...c, width: Number(c.width.toFixed(4)), x: Number(c.x.toFixed(2)), y: Number(c.y.toFixed(2)) })),
    aborted: res.stats.aborted ?? null,
  }
}

describe('WO-1087 reseed entry census (measurement only)', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  const asked = !!(process.env.WO1087_OUT || process.env.WO1087_FIX)
  it.skipIf(!asked)('records entry modes, lifts and peak engagement for the gt corpus', () => {
    const only = process.env.WO1087_FIX ? process.env.WO1087_FIX.split(',').map(Number) : null
    const out: Record<string, CensusRow> = {}
    for (let fix = 0; fix <= 8; fix++) {
      if (only && !only.includes(fix)) continue
      const row = census(fix)
      out[`fix${fix}`] = row
      console.log(`fix${fix} ${row.name}: rings ${row.helixRingCount} | lifts ${row.lifts} (micro ${row.microLifts}, helixDescent ${row.helixDescentLifts}: ${row.helixDescents}) | cutLength ${row.cutLength} | residual ${row.residualArea} | passes ${row.passes} | entries ${row.entryPoints} | maxEng ${row.maxEngagement}/${row.maxEngagementType} maxCut ${row.maxCutEngagement} (optimal ${row.optimalCutAreaPerDist}) | entryBites ${row.entryBites.map(b => `${b.mode}:${b.width}`).join(',')} | worstCuts ${row.worstCuts.map(c => `#${c.i} w${c.width} len${c.len} @(${c.x},${c.y})`).join(' ')} | hash ${row.hash} cutHash ${row.cutHash}`)
    }
    if (process.env.WO1087_OUT) {
      const p = process.env.WO1087_OUT
      const existing = fs.existsSync(p) ? JSON.parse(fs.readFileSync(p, 'utf8')) : {}
      fs.writeFileSync(p, JSON.stringify({ ...existing, ...out }, null, 2) + '\n')
    }
    expect(Object.keys(out).length).toBeGreaterThan(0)
  }, 2_400_000)
})
