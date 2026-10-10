// WO-1218 full whole-part scorecard. It is deliberately separate from smoke:
// the full matrix is informative Tier 2 evidence, not a per-WO gate.
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

import { allRows, planChains, scoreChains, type ScorecardRow } from './chainRunner'
import { isNotApplicable, specFor } from './metricRegistry'
import { chainsForTier, rowKeysForTier } from './registry'
import { baselineFromRows, cellsFailingLandingGate, compareToBaseline, readBaseline, writeBaseline } from './scorecard'

const TIER = 'full'
const BASELINE_PATH = join(process.cwd(), 'src/tests/benchmark/baseline.full.json')

// Operator ruling 2026-10-03: "Keep full-clear, record the difference".
const FULL_CLEAR_TWIN_REASON =
  'Micrometre tessellation differences are amplified where outside-in full-clear rings collapse beside the part ' +
  '(WO-2145 route, introducing landing 6c5f1eb5d). Both paths pass the gouge check. WO-2169 straightening adds ' +
  'three band crossings; Windows adds worstZFlipRatePct too. Diagnosis: ' +
  'wo/WO-2477 src/tests/evidence/WO-2477/diagnosis.md. Measurements and host-specific pairs: ' +
  'src/tests/evidence/WO-2475/attribution.md. Operator ruling 2026-10-03 retained full-clear.'

/**
 * Known STEP/mesh feature-block twin divergences: exempted from the gate
 * with the measured delta and the order / decision explaining them. A NEW
 * divergence -- any pair not listed, or a listed pair that gets WORSE -- is
 * NOT exempt and still fails the gate. Do not widen a band to add an entry
 * here; only a measured, understood, filed gap belongs in this table.
 */
const KNOWN_TWIN_GAPS: Readonly<Record<string, { measuredDelta: number; followUp: string; reason: string }>> = {
  'finish-3-ball/distinctCutZValues': {
    measuredDelta: 24,
    followUp: 'WO-1225',
    reason:
      'the 3 mm ball finish metric counts Z heights from the two equivalent triangle soups, so it is sensitive to ' +
      'their global topology rather than an analytic-surface accuracy error (98 vs 122). At the production 0.025 mm ' +
      'STEP deflection, the drafted wall and every boss plane are two triangles, exactly like the procedural quads; ' +
      'the STEP mesh is actually smaller overall (1,863 triangles versus 2,078). Every other metric on this row, and ' +
      'every metric on every other feature-block row, agrees within band.',
  },
  // WO-2475: union of the pairs outside band on Windows main (9) and
  // Spark (5), each capped at the larger observed delta, not a blanket band.
  'rough-6-flat/moves': {
    measuredDelta: 34,
    followUp: 'WO-2477; Operator ruling 2026-10-03',
    reason: FULL_CLEAR_TWIN_REASON,
  },
  'rough-6-flat/liftedLinks': {
    measuredDelta: 2,
    followUp: 'WO-2477; Operator ruling 2026-10-03',
    reason: FULL_CLEAR_TWIN_REASON,
  },
  'rough-6-flat/retracts': {
    measuredDelta: 2,
    followUp: 'WO-2477; Operator ruling 2026-10-03',
    reason: FULL_CLEAR_TWIN_REASON,
  },
  'rough-6-flat/rapidRepositions': {
    measuredDelta: 2,
    followUp: 'WO-2477; Operator ruling 2026-10-03',
    reason: FULL_CLEAR_TWIN_REASON,
  },
  'rough-6-flat/entryCutLengthMm': {
    measuredDelta: 12.049995 - 5.249996,
    followUp: 'WO-2477; Operator ruling 2026-10-03',
    reason: FULL_CLEAR_TWIN_REASON,
  },
  'rough-6-flat/flips': {
    measuredDelta: 19,
    followUp: 'WO-2477; Operator ruling 2026-10-03',
    reason: FULL_CLEAR_TWIN_REASON,
  },
  'rough-6-flat/flipRatePct': {
    measuredDelta: 16.204691 - 15.057637,
    followUp: 'WO-2477; Operator ruling 2026-10-03',
    reason: FULL_CLEAR_TWIN_REASON,
  },
  'rough-6-flat/worstZFlipRatePct': {
    measuredDelta: 29.552239 - 27.554180,
    followUp: 'WO-2477; Operator ruling 2026-10-03',
    reason: FULL_CLEAR_TWIN_REASON,
  },
  'rough-6-flat/p95FlipDeg': {
    measuredDelta: 82.993502 - 54.402287,
    followUp: 'WO-2477; Operator ruling 2026-10-03',
    reason: FULL_CLEAR_TWIN_REASON,
  },
}
const chains = chainsForTier(TIER)
let rows: ScorecardRow[] = []
let planMs = 0

beforeAll(async () => {
  const started = Date.now()
  const planned = await planChains(chains)
  planMs = Date.now() - started
  rows = allRows(await scoreChains(chains, planned))
}, 900_000)

describe('WO-1218 full benchmark scorecard', () => {
  it('runs every declared whole-part row through the application entry point', () => {
    expect(rows.map((row) => row.key)).toEqual(rowKeysForTier(TIER))
    expect(new Set(rows.map((row) => row.partId))).toEqual(new Set([
      'feature-block-mesh', 'feature-block-step', 'engagement-pocket', 'stepped-boss', 'boss-taper-step',
    ]))
    console.log(`[WO-1218] benchmark:full: ${rows.length} rows, ${chains.length} chains, planning ${planMs} ms`)
  })

  it('holds every full row to its gouge and stock-to-leave assertions', () => {
    for (const row of rows) {
      expect(row.asserts.maxGougeMm, `${row.key} gouge`).toBeLessThanOrEqual(row.asserts.gougeToleranceMm)
      expect(row.asserts.minCutMarginMm, `${row.key} stock to leave`)
        .toBeGreaterThanOrEqual(row.asserts.stockToLeaveMm - row.asserts.gougeToleranceMm)
    }
  })

  it('keeps the STEP and mesh feature-block twins within the published metric bands', () => {
    const meshRows = rows.filter((row) => row.partId === 'feature-block-mesh')
    const stepRows = rows.filter((row) => row.partId === 'feature-block-step')
    expect(meshRows.map((row) => row.stepId)).toEqual(stepRows.map((row) => row.stepId))
    expect(meshRows.length).toBeGreaterThan(0)
    // Collect every out-of-band pair before failing: a loop that throws on the
    // FIRST divergence only ever prints one metric, and a reader who fixes it
    // learns about the next gap one round at a time (round-2 audit finding).
    const outOfBand: string[] = []
    for (let i = 0; i < meshRows.length; i++) {
      const mesh = meshRows[i], step = stepRows[i]
      expect(Object.keys(mesh.metrics).sort()).toEqual(Object.keys(step.metrics).sort())
      for (const metric of Object.keys(mesh.metrics)) {
        const meshValue = mesh.metrics[metric]
        const stepValue = step.metrics[metric]
        if (isNotApplicable(meshValue) || isNotApplicable(stepValue)) {
          expect(stepValue, `${step.stepId}/${metric} applicability`).toEqual(meshValue)
          continue
        }
        const band = specFor(metric).band
        const tolerance = Math.max(band.abs, Math.abs(meshValue) * band.pct)
        const delta = Math.abs(meshValue - stepValue)
        if (delta > tolerance) {
          const known = KNOWN_TWIN_GAPS[`${step.stepId}/${metric}`]
          if (known && delta <= known.measuredDelta) continue
          outOfBand.push(`${step.stepId}/${metric}: mesh ${meshValue} vs step ${stepValue} (delta ${delta}, band ${tolerance})`)
        }
      }
    }
    expect(outOfBand, 'every out-of-band metric pair, not just the first').toEqual([])
  })

  it('compares every full row with its committed baseline', () => {
    const reason = process.env.BENCHMARK_BASELINE_REASON
    if (process.env.UPDATE_BENCHMARK_BASELINE === '1') {
      if (!reason?.trim()) throw new Error('Set BENCHMARK_BASELINE_REASON before regenerating the full baseline.')
      writeBaseline(BASELINE_PATH, baselineFromRows(TIER, rows, reason.trim(), new Date().toISOString()))
      return
    }
    const baseline = readBaseline(BASELINE_PATH)
    if (!baseline) throw new Error('No full benchmark baseline. Regenerate it with UPDATE_BENCHMARK_BASELINE=1.')
    const delta = compareToBaseline(rows, baseline)
    expect(cellsFailingLandingGate(delta)).toEqual([])
    expect(delta.rows.every((row) => row.present === 'both')).toBe(true)
  })
})
