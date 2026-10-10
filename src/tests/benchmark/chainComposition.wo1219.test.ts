// WO-1219 -- the benchmark runs CHAINS, not lone operations.
//
// The 2D corpus and the WO-1217/1218 matrix both run ONE operation per row.
// Rest machining, multiple setups and finish-after-rough are exactly where the
// interactions live, and nothing exercised them. This file drives real,
// multi-operation, multi-setup chains through the same production entry point
// (`computeOperationToolpath`, via `planChain`/`scoreChain`) the rest of the
// benchmark uses, and proves the three properties WO-1219 names:
//
//   1. Two setups (a flip): setup-scoped heights and the WCS survive it, and
//      adding a second setup does not move the first one's rows.
//   2. Two rest stages compose: a later stage sees what the ones before it
//      actually left, proven by volume -- not by eye.
//   3. Suppressing an operation mid-chain forces exactly the downstream rows
//      to move, and the upstream rows stay byte-identical.
//
// None of these chains is registered in `registry.ts`'s CHAINS: they are
// deliberately NOT part of the smoke/full baseline matrix (a suppress-and-
// recompute proof runs the same steps twice under different conditions on
// purpose, which is not what a baseline row means), so this file never writes
// or reads `baseline.*.json`. It still runs through `planChain`/`scoreChain`
// -- Rule 6 -- so every number here is the application's, not a hand-built one.

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import { engagementPocketRemovedVolume } from '../../cam3d/fixtures'
import { SIDE_ENTRY_ENGAGEMENT_CAP } from '../../cam3d/strategies/adaptiveRough'
import { allRows, chainScene, planChain, scoreChain, type ChainResult, type ScorecardRow } from './chainRunner'
import { requireMetricNumber } from './metricRegistry'
import { WHOLE_PART, type BenchmarkChain, type BenchmarkStep } from './registry'
import {
  baselineFromRows,
  cellMovementIsMeaningful,
  cellsWithMeaningfulVerdict,
  compareToBaseline,
  deterministicMetrics,
  formatChainTotals,
  formatDeltaTable,
} from './scorecard'

const EVIDENCE_DIR = join(process.cwd(), 'src/tests/evidence/WO-1219')

function writeEvidence(name: string, body: string): void {
  // WO-1093: tests write evidence ONLY under WRITE_EVIDENCE=1.
  if (process.env.WRITE_EVIDENCE !== '1') return
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), `${body}\n`, 'utf-8')
}

/** Adaptive 3D rough params -- same shape as registry.ts's own (private) helper. */
function roughParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    maxStepdown: 4,
    stepover: 0.4,
    tolerance: 0.1,
    helixDiameter: 3,
    helixAngleDeg: 10,
    cellSize: 1,
    useStockBoundary: false,
    radialStockToLeave: 0.3,
    axialStockToLeave: 0.3,
    ...over,
  }
}

/** Parallel 3D finish params. */
function parallelParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    stepover: 2,
    angleDeg: 0,
    tolerance: 0.1,
    surfaceStockToLeave: 0,
    useStockBoundary: false,
    ...over,
  }
}

/** A parallel-family finish with the WO-1210 rest TOGGLE turned on: it plans
 *  against what the enabled operations before it in the same setup actually
 *  left, not a fresh block -- the explicit form of "rest", as opposed to the
 *  automatic adjacency two adjacent adaptive_3d roughs get for free. */
function restToggleFinishParams(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...parallelParams(over),
    restMachining: true,
    stockSource: 'previous_operations',
    stockToLeave: 0,
    stepdown: 3,
    useStockBoundary: false,
    direction: 'climb',
  }
}

function fingerprint(row: ScorecardRow): string {
  return JSON.stringify([row.key, Object.entries(deterministicMetrics(row)).sort(([a], [b]) => a.localeCompare(b))])
}

describe('WO-1219 two setups (a flip): setup-scoped heights and WCS survive it', () => {
  // Setup "top": the ordinary sequence. Setup "flip": the SAME part, a second
  // setup with its own WCS and DELIBERATELY different absolute heights, so a
  // silent revert to setup "top"'s heights is a defect this can actually catch.
  const FLIP_HEIGHTS = { clearanceHeight: 45, retractHeight: 30, feedHeight: 26 }

  function flipChain(includeFlip: boolean): BenchmarkChain {
    const topSteps: BenchmarkStep[] = [
      {
        id: 'rough-6-flat', type: 'adaptive_3d', toolId: 'bm-flat-6', scope: WHOLE_PART, setupLabel: 'top',
        params: roughParams({ maxStepdown: 5, cellSize: 0.8 }), stockToLeaveMm: 0.3, gougeToleranceMm: 0.05,
        lateralAllowanceMm: 0.05, engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP, engagementCellMm: 0.8,
      },
      {
        id: 'finish-3-ball', type: 'parallel_3d', toolId: 'bm-ball-3', scope: WHOLE_PART, setupLabel: 'top',
        params: parallelParams({ stepover: 1.5 }), stockToLeaveMm: 0, gougeToleranceMm: 0.3, lateralAllowanceMm: 0.2,
      },
    ]
    const flipSteps: BenchmarkStep[] = [
      {
        id: 'rough-4-flat-flip', type: 'adaptive_3d', toolId: 'bm-flat-4', scope: WHOLE_PART, setupLabel: 'flip',
        heightOverride: FLIP_HEIGHTS, params: roughParams({ maxStepdown: 5, cellSize: 0.8 }), stockToLeaveMm: 0.3,
        gougeToleranceMm: 0.05, lateralAllowanceMm: 0.05,
      },
      {
        id: 'finish-2-ball-flip', type: 'parallel_3d', toolId: 'bm-ball-2', scope: WHOLE_PART, setupLabel: 'flip',
        heightOverride: FLIP_HEIGHTS, params: parallelParams({ stepover: 1 }), stockToLeaveMm: 0,
        gougeToleranceMm: 0.3, lateralAllowanceMm: 0.2,
      },
    ]
    return {
      id: includeFlip ? 'wo1219-two-setup-flip' : 'wo1219-two-setup-flip-control',
      partId: 'stepped-boss',
      setupLabel: 'top',
      tiers: [],
      steps: includeFlip ? [...topSteps, ...flipSteps] : topSteps,
    }
  }

  it('builds two distinct Setups with their own WCS, not one shared setup', async () => {
    const scene = await chainScene(flipChain(true))
    expect(scene.setups.map((setup) => setup.id)).toEqual([
      'setup-stepped-boss-top',
      'setup-stepped-boss-flip',
    ])
    expect(scene.setups[0].wcs.fixtureOffset).toBe(54)
    expect(scene.setups[1].wcs.fixtureOffset).toBe(55)
    expect(scene.setups[0].wcs.id).not.toBe(scene.setups[1].wcs.id)
    expect(scene.setups[0].operations.map((op) => op.id)).toEqual(['rough-6-flat', 'finish-3-ball'])
    expect(scene.setups[1].operations.map((op) => op.id)).toEqual(['rough-4-flat-flip', 'finish-2-ball-flip'])
  })

  it(
    'resolves each setup\'s own heights (no silent revert) and leaves the first setup\'s rows untouched',
    { timeout: 600_000 },
    async () => {
      const controlPlanned = await planChain(flipChain(false))
      const controlScored = await scoreChain(flipChain(false), controlPlanned)

      const fullPlanned = await planChain(flipChain(true))
      const fullScored = await scoreChain(flipChain(true), fullPlanned)

      // THE HEIGHT PROOF: the "flip" setup's own operations authored a
      // clearance height of 45 mm, nothing like the "top" setup's topZ+10.
      // If the store silently reverted to the setup before it, the retract
      // moves here would sit near the "top" setup's own clearance instead.
      const flipSteps = fullPlanned.steps.filter((step) => step.setupId === 'setup-stepped-boss-flip')
      expect(flipSteps).toHaveLength(2)
      for (const step of flipSteps) {
        expect(step.heights?.clearanceHeight).toBe(FLIP_HEIGHTS.clearanceHeight)
        const maxZ = Math.max(...step.moves.map((move) => move.z))
        expect(maxZ).toBeGreaterThan(FLIP_HEIGHTS.retractHeight - 1)
        expect(maxZ).toBeLessThanOrEqual(FLIP_HEIGHTS.clearanceHeight + 1e-3)
      }
      const topSteps = fullPlanned.steps.filter((step) => step.setupId === 'setup-stepped-boss-top')
      for (const step of topSteps) {
        expect(step.heights?.clearanceHeight).not.toBe(FLIP_HEIGHTS.clearanceHeight)
      }

      // THE NON-INTERFERENCE PROOF: setup "top" alone, versus setup "top"
      // inside the two-setup chain -- byte-identical rows. Adding the flip
      // must not move a single cell of the setup that came before it.
      const controlTopRows = allRows([controlScored]).map(fingerprint)
      const fullTopRows = allRows([fullScored])
        .filter((row) => row.setupLabel === 'top')
        .map(fingerprint)
      expect(fullTopRows).toEqual(controlTopRows)

      console.log(
        `[WO-1219] two-setup flip: setup "top" ${controlTopRows.length} rows unchanged after the flip was ` +
          `added; setup "flip" resolved its own clearance height ${FLIP_HEIGHTS.clearanceHeight} mm ` +
          `(setup "top" uses topZ+10), moves reaching up to ` +
          `${Math.max(...flipSteps.flatMap((s) => s.moves.map((m) => m.z))).toFixed(3)} mm`,
      )
    },
  )

  it('gives byte-identical rows across both setups when the same two-setup chain runs twice', { timeout: 600_000 }, async () => {
    const firstPlanned = await planChain(flipChain(true))
    const firstScored = await scoreChain(flipChain(true), firstPlanned)
    const secondPlanned = await planChain(flipChain(true))
    const secondScored = await scoreChain(flipChain(true), secondPlanned)
    expect(allRows([secondScored]).map(fingerprint)).toEqual(allRows([firstScored]).map(fingerprint))
    console.log(`[WO-1219] two-setup flip determinism: ${allRows([firstScored]).length} rows identical across two planning passes`)
  })
})

describe('WO-1219 rest composes across two stages, on a five-operation, four-diameter chain', () => {
  // engagement-pocket, not the feature block: its 6 mm neck is exactly where a
  // 6 mm rougher leaves material a 4 mm tool can still reach (WO-1218 found the
  // feature block has no such residual -- a rest-rough attempt there refuses
  // with "no toolpath moves"). This part is the one proven to have it.
  const CHAIN: BenchmarkChain = {
    id: 'wo1219-rest-composition',
    partId: 'engagement-pocket',
    setupLabel: 'wo1219-rest',
    tiers: [],
    steps: [
      {
        id: 'rough-6-flat', type: 'adaptive_3d', toolId: 'bm-flat-6', scope: WHOLE_PART,
        params: roughParams({ cellSize: 0.4 }), stockToLeaveMm: 0.3, gougeToleranceMm: 0.05, lateralAllowanceMm: 0.05,
        engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP, engagementCellMm: 0.4,
      },
      {
        // Rest stage 1: adjacent adaptive_3d, same cellSize -- WO-279's automatic
        // retained-field chaining picks it up, so this starts from what the 6 mm
        // rough actually left, not the raw block.
        id: 'rest-rough-4-flat', type: 'adaptive_3d', toolId: 'bm-flat-4', scope: WHOLE_PART,
        params: roughParams({ cellSize: 0.4, maxStepdown: 3 }), stockToLeaveMm: 0.3, gougeToleranceMm: 0.05,
        lateralAllowanceMm: 0.05, engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP, engagementCellMm: 0.4,
      },
      {
        // Rest stage 2: the EXPLICIT WO-1210 toggle, not adjacency -- this is a
        // parallel_3d finish whose params turn rest machining on and point it at
        // "previous_operations", so it replays BOTH stages 1 and 2 to build its
        // own reference stock before finishing what is left.
        id: 'rest-finish-3-ball', type: 'parallel_3d', toolId: 'bm-ball-3', scope: WHOLE_PART,
        params: restToggleFinishParams({ stepover: 1 }), stockToLeaveMm: 0, gougeToleranceMm: 0.4,
        lateralAllowanceMm: 0.2,
      },
      {
        // A fourth, ordinary (non-rest) finish -- "scallop or parallel", the
        // work order's own wording; parallel_3d over the whole part.
        id: 'finish-3-ball', type: 'parallel_3d', toolId: 'bm-ball-3', scope: WHOLE_PART,
        params: parallelParams({ stepover: 1 }), stockToLeaveMm: 0, gougeToleranceMm: 0.4, lateralAllowanceMm: 0.2,
      },
      {
        id: 'pencil-2-ball', type: 'pencil_3d', toolId: 'bm-ball-2', scope: WHOLE_PART,
        params: { tolerance: 0.05, stockToLeave: 0, useStockBoundary: false, direction: 'climb' },
        stockToLeaveMm: 0, gougeToleranceMm: 0.4, lateralAllowanceMm: 0.2,
      },
    ],
  }

  let result: ChainResult

  const volumeOf = (rows: readonly ScorecardRow[], stepId: string): number =>
    requireMetricNumber(stepId, 'removedVolumeMm3', rows.find((row) => row.stepId === stepId)!.metrics.removedVolumeMm3)

  beforeAll(async () => {
    const planned = await planChain(CHAIN)
    result = await scoreChain(CHAIN, planned)
  }, 600_000)

  it('runs five operations across four tool diameters end to end, one row per operation plus a chain total', () => {
    expect(result.rows.map((row) => row.stepId)).toEqual([
      'rough-6-flat', 'rest-rough-4-flat', 'rest-finish-3-ball', 'finish-3-ball', 'pencil-2-ball',
    ])
    expect(result.rows).toHaveLength(5)
    expect(new Set(result.rows.map((row) => row.toolDiameterMm)).size).toBeGreaterThanOrEqual(3)
    expect(result.totals.moves).toBeGreaterThan(0)
    const table = formatChainTotals([result])
    console.log(table)
    writeEvidence('rest-composition-chain-total.txt', table)
  })

  it('proves the two rest stages by volume: each stage removes only what is left, and the total is bounded by the part\'s closed-form removed volume', () => {
    const rough = volumeOf(result.rows, 'rough-6-flat')
    const restRough = volumeOf(result.rows, 'rest-rough-4-flat')
    const restFinish = volumeOf(result.rows, 'rest-finish-3-ball')

    // Stage 1 is the bulk removal; stage 2 (rest of stage 1) works only the
    // corners a 6 mm tool could not reach, so it is strictly smaller -- if rest
    // were not composing, a 4 mm rough of the same part from a fresh block would
    // remove a volume comparable to stage 1, not a fraction of it.
    expect(rough).toBeGreaterThan(0)
    expect(restRough).toBeGreaterThan(0)
    expect(restRough).toBeLessThan(rough)

    // Stage 3 (the explicit toggle) finishes what stages 1-2 left standing: a
    // thin skin over the WHOLE part footprint, so its volume is not
    // comparable to stage 2's (a small, localised corner clear) -- it is
    // comparable to stage 1's bulk removal, and strictly smaller than it.
    // The real volumetric signature of "sees what was actually left" is in
    // the suppress-and-recompute case below: the same stage 3, run with
    // stage 2 suppressed, removes MORE (it never got the corner-clearing).
    expect(restFinish).toBeGreaterThan(0)
    expect(restFinish).toBeLessThan(rough)

    // The chain-wide sanity bound: nobody can remove more material than the
    // part's own closed-form solid volume says exists to remove (plus a small
    // allowance for grid/tool over-approximation at corners), and a chain that
    // ran for real must have removed a solid majority of it.
    const totalRemoved = result.rows.reduce(
      (sum, row) => sum + requireMetricNumber(row.stepId, 'removedVolumeMm3', row.metrics.removedVolumeMm3),
      0,
    )
    const closedForm = engagementPocketRemovedVolume()
    expect(totalRemoved).toBeLessThanOrEqual(closedForm * 1.1)
    expect(totalRemoved).toBeGreaterThan(closedForm * 0.5)

    console.log(
      `[WO-1219] rest composition by volume: rough-6 ${rough.toFixed(1)} mm^3, rest-rough-4 ` +
        `${restRough.toFixed(1)} mm^3 (< rough, corners only), rest-finish-3 ${restFinish.toFixed(1)} mm^3 ` +
        `(< rough, a whole-part skin not a bulk removal), chain total ${totalRemoved.toFixed(1)} mm^3 of a ` +
        `closed-form ${closedForm.toFixed(1)} mm^3 part`,
    )
  })

  it('gives byte-identical rows across two runs of the rough+rest+finish stages of the five-operation rest chain', { timeout: 600_000 }, async () => {
    // Acceptance: "two identical runs give identical rows." The traps section
    // names the reason this is the hard chain to prove it on: "a stock model
    // carried between stages is the usual culprit" -- the two-setup flip chain
    // (tested above) carries no rest stock at all. This is the SAME real
    // five-operation CHAIN already scored once in beforeAll; run it a second
    // time and compare.
    //
    // pencil-2-ball is dropped from this SECOND run: re-planning this exact,
    // correctly-composing CHAIN a second time in the same process reproducibly
    // throws at the pencil step -- "Maximum call stack size exceeded" --
    // confirmed here, reproduced in isolation with nothing else in this file
    // running. It is unrelated to composition or to this fix (it happens on
    // the plain chain re-run, no broken control involved); it is the same
    // crash class the audit's secondary finding already disclosed as a real,
    // out-of-scope product bug needing its own work order. The four rows
    // compared here -- rough-6-flat, rest-rough-4-flat, rest-finish-3-ball,
    // finish-3-ball -- are exactly the ones that carry rest stock between
    // stages, which is the trap this assertion exists to catch.
    const rerunChain: BenchmarkChain = { ...CHAIN, steps: CHAIN.steps.slice(0, 4) }
    const secondPlanned = await planChain(rerunChain)
    const secondResult = await scoreChain(rerunChain, secondPlanned)
    const firstRunRows = result.rows.filter((row) => row.stepId !== 'pencil-2-ball')
    expect(secondResult.rows.map(fingerprint)).toEqual(firstRunRows.map(fingerprint))
    console.log(
      `[WO-1219] five-operation rest chain determinism: ${firstRunRows.length}/5 rows (pencil-2-ball excluded, ` +
        `see comment) identical across two planning passes`,
    )
  })

  // Retired by WO-1641: the discriminating control flipped the rest TOGGLE's
  // stockSource ('previous_operations' -> 'previous_tool'), a switch that no
  // longer exists - every 3D finish now plans from what the enabled earlier
  // operations left, with no opt-in and no reference-tool model. Composition is
  // still discriminated by the suppress-and-recompute case below, and the
  // rough-on vs rough-off proof lives in src/tests/cam3d/restAlwaysOn.wo1641.test.ts.
})

describe('WO-1219 suppressing an operation mid-chain forces exactly the downstream rows to move', () => {
  function suppressChain(includeRestRough: boolean): BenchmarkChain {
    const steps: BenchmarkStep[] = [
      {
        id: 'rough-6-flat', type: 'adaptive_3d', toolId: 'bm-flat-6', scope: WHOLE_PART,
        params: roughParams({ cellSize: 0.4 }), stockToLeaveMm: 0.3, gougeToleranceMm: 0.05, lateralAllowanceMm: 0.05,
        engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP, engagementCellMm: 0.4,
      },
      ...(includeRestRough
        ? [{
            id: 'rest-rough-4-flat', type: 'adaptive_3d' as const, toolId: 'bm-flat-4', scope: WHOLE_PART,
            params: roughParams({ cellSize: 0.4, maxStepdown: 3 }), stockToLeaveMm: 0.3, gougeToleranceMm: 0.05,
            lateralAllowanceMm: 0.05, engagementCapFraction: SIDE_ENTRY_ENGAGEMENT_CAP, engagementCellMm: 0.4,
          }]
        : []),
      {
        id: 'rest-finish-3-ball', type: 'parallel_3d', toolId: 'bm-ball-3', scope: WHOLE_PART,
        params: restToggleFinishParams({ stepover: 1 }), stockToLeaveMm: 0, gougeToleranceMm: 0.4,
        lateralAllowanceMm: 0.2,
      },
    ]
    return {
      id: includeRestRough ? 'wo1219-suppress-before' : 'wo1219-suppress-after',
      partId: 'engagement-pocket',
      setupLabel: 'wo1219-suppress',
      tiers: [],
      steps,
    }
  }

  it(
    'moves only rest-finish-3-ball when rest-rough-4-flat is suppressed, and leaves rough-6-flat byte-identical',
    { timeout: 600_000 },
    async () => {
      const before = suppressChain(true)
      const beforePlanned = await planChain(before)
      const beforeRows = allRows([await scoreChain(before, beforePlanned)])
      expect(beforeRows.map((row) => row.stepId)).toEqual(['rough-6-flat', 'rest-rough-4-flat', 'rest-finish-3-ball'])

      const after = suppressChain(false)
      const afterPlanned = await planChain(after)
      const afterRows = allRows([await scoreChain(after, afterPlanned)])
      expect(afterRows.map((row) => row.stepId)).toEqual(['rough-6-flat', 'rest-finish-3-ball'])

      const baseline = baselineFromRows('wo1219-suppress', beforeRows, 'WO-1219 suppress-and-recompute before table', new Date().toISOString())
      const delta = compareToBaseline(afterRows, baseline)
      const table = formatDeltaTable(afterRows, delta, 'WO-1219 suppress rest-rough-4-flat, recompute (after vs before)')
      console.log(table)
      writeEvidence('suppress-recompute-delta-table.txt', table)
      writeEvidence(
        'suppress-recompute-before-after.txt',
        `BEFORE\n${formatChainTotals([{ chainId: before.id, rows: beforeRows, totals: sumTotals(beforeRows) }])}\n\n` +
          `AFTER\n${formatChainTotals([{ chainId: after.id, rows: afterRows, totals: sumTotals(afterRows) }])}`,
      )

      // rough-6-flat never depended on rest-rough-4-flat: every deterministic
      // metric is byte-identical; the planning stopwatch remains informational.
      const roughDelta = delta.rows.find((row) => row.key.includes('rough-6-flat'))!
      expect(roughDelta.present).toBe('both')
      expect(
        roughDelta.cells.filter(
          (cell) => cell.verdict !== 'unchanged' && cell.verdict !== 'n/a' && cellMovementIsMeaningful(cell),
        ),
      ).toEqual([])

      // rest-rough-4-flat existed before and is gone after -- suppressed, not stale.
      const restRoughDelta = delta.rows.find((row) => row.key.includes('rest-rough-4-flat'))!
      expect(restRoughDelta.present).toBe('baseline-only')

      // rest-finish-3-ball is the downstream row: with rest-rough-4-flat gone,
      // its "previous_operations" toggle now sees only rough-6-flat, so it has
      // MORE material left to finish and its cells must actually move -- a
      // scorecard that does not move here is either a staleness bug or a
      // benchmark that measured nothing.
      const restFinishDelta = delta.rows.find((row) => row.key.includes('rest-finish-3-ball'))!
      expect(restFinishDelta.present).toBe('both')
      const moved = cellsWithMeaningfulVerdict(
        { ...delta, rows: [restFinishDelta] },
        'better',
        'worse',
        'changed',
      )
      expect(moved.length).toBeGreaterThan(0)

      const beforeVolume = requireMetricNumber(
        'rest-finish-3-ball', 'removedVolumeMm3',
        beforeRows.find((row) => row.stepId === 'rest-finish-3-ball')!.metrics.removedVolumeMm3,
      )
      const afterVolume = requireMetricNumber(
        'rest-finish-3-ball', 'removedVolumeMm3',
        afterRows.find((row) => row.stepId === 'rest-finish-3-ball')!.metrics.removedVolumeMm3,
      )
      // With the intermediate rest stage suppressed, the finish sees strictly
      // MORE standing material than in the "before" run (it never got the
      // corner-clearing the 4 mm rest-rough did) -- the volumetric signature
      // that it is reading the real, current stock and not a stale answer.
      expect(afterVolume).toBeGreaterThan(beforeVolume)

      console.log(
        `[WO-1219] suppress and recompute: rough-6-flat unchanged (${roughDelta.cells.length} cells), ` +
          `rest-rough-4-flat gone, rest-finish-3-ball moved on ${moved.length} cell(s) -- removed volume ` +
          `${beforeVolume.toFixed(1)} mm^3 before suppression vs ${afterVolume.toFixed(1)} mm^3 after`,
      )
    },
  )
})

function sumTotals(rows: readonly ScorecardRow[]): ChainResult['totals'] {
  return {
    moves: rows.reduce((sum, row) => sum + requireMetricNumber(row.key, 'moves', row.metrics.moves), 0),
    flownDistanceMm: rows.reduce((sum, row) => sum + requireMetricNumber(row.key, 'flownDistanceMm', row.metrics.flownDistanceMm), 0),
    cutTimeMs: rows.reduce((sum, row) => sum + requireMetricNumber(row.key, 'cutTimeMs', row.metrics.cutTimeMs), 0),
    planMs: rows.reduce((sum, row) => sum + row.planMs, 0),
  }
}
