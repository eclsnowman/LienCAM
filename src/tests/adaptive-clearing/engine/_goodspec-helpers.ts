// WO-435 GOODSPEC TRIPWIRE HELPERS. Shared fixture loader + canonical corpus settings +
// per-fixture spec metadata (region counts, Fusion pass counts) for the T1/T2/T3 tripwires
// wired in goodspec-tripwires.test.ts (GOOD-SPEC.md section 6). Copied loader/settings
// pattern from _wo410-corpus-render.test.ts (the picture-card harness).

import * as fs from 'fs'
import { type Loop } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, type AdaptivePass, type ProcessParams } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'

// Canonical corpus settings -- the settings the WO-410 picture cards used, per the WO.
export const CANONICAL_PARAMS: Omit<ProcessParams, 'helixDiameter'> = {
  toolRadius: 2.0, stepOver: 0.2, tolerance: 0.1, stockToLeave: 0.5,
  integralWallFollow: true, wallCleanupAsWeGo: true, loopbackFilletPct: 25,
}

// GOOD-SPEC section 6 working assumptions [OPERATOR TO RULE where noted].
export const ALLOWANCE = 4 // T1: lifts <= entries + (specRegions - 1) + ALLOWANCE
export const K = 3 // T2: passes <= K x Fusion's recorded count

export interface FixtureMeta {
  fix: number
  name: string
  /** AC-SPEC section G region count. Triangle/Boomerang have no stated AC-SPEC count --
   *  the WO says use the budget formula with regions=2, marked sampleMachineToRule. */
  specRegions: number
  sampleMachineToRule: boolean
  /** Fusion's recorded pass count (gt-census.md), gt_fix0..8 order. */
  fusionPasses: number
}

// gt_fix0..8 order (fixed by the JSON filenames), from gt-census.md's own per-fixture
// headers (### fixN -- Name) and the census table's spec-region-count column.
export const FIXTURE_META: FixtureMeta[] = [
  { fix: 0, name: 'CommaSpiral', specRegions: 1, sampleMachineToRule: false, fusionPasses: 63 },
  { fix: 1, name: 'Kidney', specRegions: 2, sampleMachineToRule: false, fusionPasses: 79 },
  { fix: 2, name: 'SquareIsland', specRegions: 4, sampleMachineToRule: false, fusionPasses: 102 },
  { fix: 3, name: 'Tee', specRegions: 4, sampleMachineToRule: false, fusionPasses: 59 },
  { fix: 4, name: 'Bar', specRegions: 1, sampleMachineToRule: false, fusionPasses: 38 },
  { fix: 5, name: 'BootL', specRegions: 5, sampleMachineToRule: false, fusionPasses: 107 },
  { fix: 6, name: 'Triangle', specRegions: 2, sampleMachineToRule: true, fusionPasses: 60 },
  { fix: 7, name: 'Barbell', specRegions: 1, sampleMachineToRule: false, fusionPasses: 54 },
  { fix: 8, name: 'Boomerang', specRegions: 2, sampleMachineToRule: true, fusionPasses: 84 },
]

export function loadGtFixture(fix: number): { boundary: Loop; holes: Loop[]; helixDiameter: number; name: string } {
  const d = JSON.parse(fs.readFileSync(`test_fixtures/adaptive-clearing/spirals/_cmp/_gt/gt_fix${fix}.json`, 'utf8'))
  return {
    boundary: (d.boundary as number[][]).map(([x, y]: number[]) => ({ x, y })),
    holes: (d.islands ?? []).map((isl: number[][]) => isl.map(([x, y]: number[]) => ({ x, y }))),
    helixDiameter: d.helix?.diameter ?? 3,
    name: d.name as string,
  }
}

type LinkPass = Extract<AdaptivePass, { type: 'link' }>

export interface GoodspecMeasurement {
  meta: FixtureMeta
  entries: number
  cuts: number
  /** Total jumpType-2 links, micro + clearance (WO-437). Reporting only -- T1's budget
   *  below counts ONLY clearanceLifts now; see GOOD-SPEC.md section 3 tier 2. */
  lifts: number
  /** WO-437 tier 2: jumpType-2 links whose direct corridor was proven clear at full tool
   *  width against clearedBeforePass and so hop at a small stay-down height instead of
   *  flying to full clearance (link.microLift set). */
  microLifts: number
  /** WO-437 tier 3: jumpType-2 links that fly to full clearance -- either the corridor
   *  proof failed, or (rarely) the landing needed a helix descent. lifts - microLifts. */
  clearanceLifts: number
  attributed: number
  unattributed: number
  /** liftReason strings for every unattributed (missing or 'unattributed-*') lift, with
   *  their pass index, for diagnosis. */
  unattributedDetail: { passIndex: number; reason: string | undefined }[]
  /** T1 budget: clearanceLifts (tier 3 ONLY, WO-437) <= entries + (specRegions - 1) + ALLOWANCE. */
  budget: number
  /** T2 target: cuts <= K x fusionPasses. */
  fusionTarget: number
  kMultiple: number // cuts / fusionPasses, for the printed table
  /** T3: a lift with no attributed reason is a forced reposition with no named cause --
   *  reuses the SAME liftReason plumbing as T1, so today this equals `unattributed`
   *  exactly (see file header note on why T3 is not tracked as an independent signal). */
  t3Violations: number
  aborted: string | null
}

export function measureGoodspecFixture(fix: number): GoodspecMeasurement {
  const meta = FIXTURE_META.find(m => m.fix === fix)
  if (!meta) throw new Error(`no FIXTURE_META for fix${fix}`)
  const { boundary, holes, helixDiameter } = loadGtFixture(fix)
  const params: ProcessParams = { ...CANONICAL_PARAMS, helixDiameter }
  const warn = console.warn
  console.warn = () => {}
  let res
  try { res = processFeature({ boundary, holes }, params) } finally { console.warn = warn }

  const cuts = res.passes.filter(p => p.type === 'cut').length
  const liftPasses: { passIndex: number; link: LinkPass }[] = []
  res.passes.forEach((p, passIndex) => {
    if (p.type === 'link' && (p as LinkPass).jumpType === 2) liftPasses.push({ passIndex, link: p as LinkPass })
  })
  const unattributedDetail: { passIndex: number; reason: string | undefined }[] = []
  let attributed = 0
  for (const { passIndex, link } of liftPasses) {
    const reason = link.liftReason
    if (reason && !reason.startsWith('unattributed')) attributed++
    else unattributedDetail.push({ passIndex, reason })
  }
  const lifts = liftPasses.length
  const microLifts = liftPasses.filter(({ link }) => !!link.microLift).length
  const clearanceLifts = lifts - microLifts
  const unattributed = unattributedDetail.length
  const entries = res.entries.length
  // WO-437: the budget counts ONLY tier-3 (full clearance) lifts now -- a micro-lift is a
  // cheaper tier than a clearance retract, so it no longer spends the T1 budget.
  const budget = entries + (meta.specRegions - 1) + ALLOWANCE
  const fusionTarget = K * meta.fusionPasses

  return {
    meta, entries, cuts, lifts, microLifts, clearanceLifts, attributed, unattributed, unattributedDetail,
    budget, fusionTarget, kMultiple: meta.fusionPasses > 0 ? cuts / meta.fusionPasses : NaN,
    t3Violations: unattributed, // T3 reuses the liftReason plumbing; see interface doc above
    aborted: res.stats.aborted ?? null,
  }
}
