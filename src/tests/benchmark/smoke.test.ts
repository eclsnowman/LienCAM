// WO-1217 -- the benchmark smoke scorecard.
//
// What this file exists to do: run real operations on real parts through the
// APPLICATION'S OWN compute path and print what changed, in numbers, against a
// committed baseline. The 2D corpus's byte fingerprint can only say CHANGED; it
// has gone red on three legitimate improvements (WO-1198, WO-1211, WO-1214) and
// each time needed Operator's eye to regenerate. A scorecard with tolerance bands says
// BETTER, WORSE or UNCHANGED, so a deliberate improvement updates the baseline
// with its reason in the same commit.
//
// This file names no part, no tool and no operation type: everything comes from
// `registry.ts`, which is why adding a part or changing a tool diameter is a
// registry edit and nothing else.
//
// SMOKE ONLY (slice 1 of 4). Two parts, two operations each, planned twice for the
// determinism proof. WO-1218 fills the matrix; WO-1220 wires the gate.
//
// REGENERATING THE BASELINE -- an explicit path, never a plain test run
// (the WO-1093 rule; a test that rewrites its own baseline dirties main):
//
//   $env:UPDATE_BENCHMARK_BASELINE="1"
//   $env:BENCHMARK_BASELINE_REASON="WO-xxxx: why these numbers are the new truth"
//   npx vitest run src/tests/benchmark/
//
// It refuses to write without a reason.

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { beforeAll, describe, expect, it } from 'vitest'

import type { ToolpathMove } from '../../types'

import {
  allRows,
  planChains,
  scoreChains,
  type ChainResult,
  type PlannedChain,
  type ScorecardRow,
} from './chainRunner'
import { pathMetrics } from './metrics'
import { chainsForTier, rowKeysForTier } from './registry'
import {
  baselineFromRows,
  cellMovementIsMeaningful,
  cellsFailingLandingGate,
  cellsWithMeaningfulVerdict,
  compareToBaseline,
  deterministicMetrics,
  formatChainTotals,
  formatDeltaTable,
  isNotApplicable,
  readBaseline,
  requireMetricNumber,
  writeBaseline,
  REQUIRED_ROW_METRICS,
  type ScorecardDelta,
} from './scorecard'

const TIER = 'smoke'
const BASELINE_PATH = join(process.cwd(), 'src/tests/benchmark/baseline.smoke.json')
const EVIDENCE_DIR = join(process.cwd(), 'src/tests/evidence/WO-1217')

/**
 * Budget for ONE smoke pass of planning, ms. The file runs the matrix twice plus
 * three scoring passes and must stay under the work order's three minutes; a
 * single planning pass is the part that grows when someone adds a part, so it is
 * the number worth guarding. Deliberately not an assert on total suite wall time:
 * this box runs lanes concurrently and a wall-clock assert would fail on load
 * rather than on a defect.
 */
const SMOKE_PLAN_BUDGET_MS = 90_000

const chains = chainsForTier(TIER)

let firstPlan: PlannedChain[]
let secondPlan: PlannedChain[]
let firstPlanMs = 0
let secondPlanMs = 0
let firstScore: ChainResult[]
let secondScore: ChainResult[]

beforeAll(async () => {
  const t0 = Date.now()
  firstPlan = await planChains(chains)
  firstPlanMs = Date.now() - t0
  const t1 = Date.now()
  secondPlan = await planChains(chains)
  secondPlanMs = Date.now() - t1
  firstScore = await scoreChains(chains, firstPlan)
  secondScore = await scoreChains(chains, secondPlan)
}, 600_000)

/** Deterministic metrics of a run, keys sorted, as one comparable string. */
function fingerprint(rows: readonly ScorecardRow[]): string {
  return JSON.stringify(
    rows.map((row) => [
      row.key,
      Object.entries(deterministicMetrics(row)).sort(([a], [b]) => a.localeCompare(b)),
      row.asserts,
    ]),
  )
}

function writeEvidence(name: string, body: string): void {
  // WO-1093: tests write evidence ONLY under WRITE_EVIDENCE=1.
  if (process.env.WRITE_EVIDENCE !== '1') return
  mkdirSync(EVIDENCE_DIR, { recursive: true })
  writeFileSync(join(EVIDENCE_DIR, name), `${body}\n`, 'utf-8')
}

describe('WO-1217 benchmark smoke scorecard', () => {
  it('scores exactly the rows the registry declares, in registry order', () => {
    expect(allRows(firstScore).map((row) => row.key)).toEqual(rowKeysForTier(TIER))
    // Two parts, so the second smoke part really is being driven, and it got there
    // by a registry edit alone.
    expect(new Set(allRows(firstScore).map((row) => row.partId)).size).toBe(2)
  })

  it('carries every registry metric on every row, measured or reasoned', () => {
    // THE COMPLETENESS INVARIANT (WO-1217 audit round 4). The finish rows once
    // carried eleven fewer cells than the rough rows: no engagement, no regions.
    // Nothing went red, because a MISSING metric is invisible -- the baseline
    // encoded the omission and the tests encoded the baseline, so 21 tests passed
    // over two half-empty rows. This walks the registry against every row and
    // fails on an absent key, so the next omission fails loudly instead of pinning.
    const rows = allRows(firstScore)
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      const absent = REQUIRED_ROW_METRICS.filter((metric) => !(metric in row.metrics))
      expect(absent, `${row.key} is missing registry metric(s)`).toEqual([])
      // A reasoned absence must actually carry its reason: `null` on its own is
      // the same silence in a different shape.
      for (const metric of REQUIRED_ROW_METRICS) {
        const value = row.metrics[metric]
        if (!isNotApplicable(value)) {
          expect(Number.isFinite(value), `${row.key}/${metric} is not a measurement`).toBe(true)
          continue
        }
        expect(value.reason.trim().length, `${row.key}/${metric} is null with no reason`).toBeGreaterThan(20)
      }
    }

    // And the committed BASELINE carries them too. This is the half that was
    // actually broken: a baseline generated from incomplete rows pins the gap.
    const baseline = readBaseline(BASELINE_PATH)
    if (baseline) {
      for (const baseRow of baseline.rows) {
        const absent = REQUIRED_ROW_METRICS.filter((metric) => !(metric in baseRow.metrics))
        expect(absent, `baseline row ${baseRow.key} is missing registry metric(s)`).toEqual([])
        for (const [metric, cell] of Object.entries(baseRow.metrics)) {
          if (cell.value === null) {
            expect((cell.reason ?? '').trim().length, `baseline ${baseRow.key}/${metric} is null with no reason`)
              .toBeGreaterThan(20)
          }
        }
      }
    }

    const reasoned = rows.flatMap((row) =>
      REQUIRED_ROW_METRICS.filter((metric) => isNotApplicable(row.metrics[metric])).map(
        (metric) => `${row.key}/${metric}`,
      ),
    )
    console.log(
      `[WO-1217] completeness: ${REQUIRED_ROW_METRICS.length} registry metrics x ${rows.length} rows = ` +
        `${REQUIRED_ROW_METRICS.length * rows.length} cells, 0 absent, ${reasoned.length} reasoned absences` +
        `${reasoned.length > 0 ? ` (${reasoned.join(', ')})` : ''}`,
    )
  })

  it('never gouges the part and leaves the stock it promised', () => {
    const rows = allRows(firstScore)
    for (const row of rows) {
      // Teeth: a check that never stood over the part proves nothing.
      expect(row.asserts.samplesOverPart, `${row.key} sampled nothing over the part`).toBeGreaterThan(100)
      expect(
        row.asserts.cutSamplesOverPart,
        `${row.key} sampled no CUTTING move over the part`,
      ).toBeGreaterThan(100)
      expect(
        row.asserts.maxGougeMm,
        `${row.key} cut ${row.asserts.maxGougeMm} mm below the surface (allowed ${row.asserts.gougeToleranceMm})`,
      ).toBeLessThanOrEqual(row.asserts.gougeToleranceMm)
      expect(
        row.asserts.minCutMarginMm,
        `${row.key} left ${row.asserts.minCutMarginMm} mm under a cut where ${row.asserts.stockToLeaveMm} mm was required`,
      ).toBeGreaterThanOrEqual(row.asserts.stockToLeaveMm - row.asserts.gougeToleranceMm)
    }
    console.log(
      `[WO-1217] safety floor: ${rows
        .map(
          (row) =>
            `${row.key} gouge ${row.asserts.maxGougeMm.toFixed(4)}/${row.asserts.gougeToleranceMm} mm, ` +
            `left ${row.asserts.minCutMarginMm.toFixed(4)}/${row.asserts.stockToLeaveMm} mm`,
        )
        .join(' | ')}`,
    )
  })

  it('gives byte-identical rows when the same code runs twice', () => {
    // Every delta is noise unless this holds. Wall time is excluded by
    // construction: it is the one metric that cannot repeat.
    expect(fingerprint(allRows(secondScore))).toBe(fingerprint(allRows(firstScore)))
    console.log(
      `[WO-1217] determinism: ${allRows(firstScore).length} rows identical across two full ` +
        `planning passes (${firstPlanMs} ms and ${secondPlanMs} ms)`,
    )
  })

  it('plans a smoke pass inside its runtime budget', () => {
    expect(firstPlanMs).toBeLessThan(SMOKE_PLAN_BUDGET_MS)
    console.log(
      `[WO-1217] runtime: planning pass 1 ${firstPlanMs} ms, pass 2 ${secondPlanMs} ms, ` +
        `budget ${SMOKE_PLAN_BUDGET_MS} ms per pass`,
    )
  })

  it('prints a delta table against the committed baseline', () => {
    const rows = allRows(firstScore)

    if (process.env.UPDATE_BENCHMARK_BASELINE === '1') {
      const reason = process.env.BENCHMARK_BASELINE_REASON
      if (!reason || reason.trim().length === 0) {
        throw new Error(
          'Refusing to regenerate the benchmark baseline without a reason. Set ' +
            'BENCHMARK_BASELINE_REASON to what changed and why these numbers are now the truth.',
        )
      }
      writeBaseline(BASELINE_PATH, baselineFromRows(TIER, rows, reason.trim(), new Date().toISOString()))
      console.log(`[WO-1217] baseline REGENERATED at ${BASELINE_PATH}: ${reason.trim()}`)
      return
    }

    const baseline = readBaseline(BASELINE_PATH)
    if (!baseline) {
      throw new Error(
        `No benchmark baseline at ${BASELINE_PATH}. Generate one with ` +
          'UPDATE_BENCHMARK_BASELINE=1 and BENCHMARK_BASELINE_REASON set, and commit it.',
      )
    }
    const delta = compareToBaseline(rows, baseline)
    const table = formatDeltaTable(rows, delta, `benchmark ${TIER} vs baseline (${baseline.generatedAt})`)
    const totals = formatChainTotals(firstScore)
    console.log(table)
    console.log(totals)
    writeEvidence('delta-table-clean.txt', `${table}

${totals}`)

    // Same code, same numbers: every non-timing cell must sit inside its band, and
    // no row may be unmatched. An out-of-band cell is the harness doing its job --
    // read the table, decide whether it is an improvement, and if it is, regenerate
    // the baseline with the reason in the same commit.
    expect(cellsFailingLandingGate(delta)).toEqual([])
    expect(delta.rows.every((rowDelta) => rowDelta.present === 'both')).toBe(true)
    expect(delta.unchanged).toBeGreaterThan(0)
  })

  it('keeps improvements and stopwatch movement informational but fails structural timing changes', () => {
    const timingVerdicts: ScorecardDelta = {
      rows: [
        { key: 'timing-worse', present: 'both', cells: [
          { metric: 'planMs', baseline: 10, current: 1000, delta: 990, verdict: 'worse' },
        ] },
        { key: 'timing-changed', present: 'both', cells: [
          { metric: 'planMs', baseline: 10, current: 1000, delta: 990, verdict: 'changed' },
        ] },
        { key: 'timing-new', present: 'both', cells: [
          { metric: 'planMs', baseline: undefined, current: 10, delta: undefined, verdict: 'new' },
        ] },
        { key: 'timing-gone', present: 'both', cells: [
          { metric: 'planMs', baseline: 10, current: undefined, delta: undefined, verdict: 'gone' },
        ] },
        { key: 'deterministic-worse', present: 'both', cells: [
          { metric: 'moves', baseline: 10, current: 20, delta: 10, verdict: 'worse' },
        ] },
        { key: 'deterministic-better', present: 'both', cells: [
          { metric: 'moves', baseline: 20, current: 10, delta: -10, verdict: 'better' },
        ] },
      ],
      better: 1,
      worse: 2,
      unchanged: 0,
      changed: 1,
      missing: 2,
      notApplicable: 0,
    }

    expect(cellsFailingLandingGate(timingVerdicts)).toEqual([
      'timing-new/planMs=new',
      'timing-gone/planMs=gone',
      'deterministic-worse/moves=worse',
    ])
    expect(cellsWithMeaningfulVerdict(timingVerdicts, 'worse', 'changed')).toEqual([
      'deterministic-worse/moves',
    ])
    expect(cellsWithMeaningfulVerdict(timingVerdicts, 'new', 'gone')).toEqual([
      'timing-new/planMs',
      'timing-gone/planMs',
    ])
  })

  it('flips the right cells to worse when a link is deliberately lengthened', async () => {
    // WO-2201: the detour is compared to THIS run's own unmutated rows, built
    // into a baseline by the same baselineFromRows the committed file comes
    // from. Against the committed file it went red on the Spark after WO-2196:
    // that file is captured on x64, and the adaptive rough's IR differs between
    // x64 and arm64 (the WO-2096 finding) -- rough-6-flat flips read 48 on x64
    // and 42 on arm64 -- so "nothing else moved" caught the arch, not the
    // detour. The committed-baseline comparison is the delta-table test above.
    const baseline = baselineFromRows(TIER, allRows(firstScore), 'WO-2201 same-run reference', 'same-run')

    // The injected regression: a square detour bolted into ONE air link of ONE
    // operation, at the height the link already flies at. Nothing about where the
    // tool cuts changes, so this isolates the collectors, the bands and the delta
    // table -- the engine path is proven by the real rows above. WO-1217 offers
    // exactly this or a dropped tool diameter; this is the cheap one, and it does
    // not need a third planning pass.
    const target = firstPlan[0]
    const mutated: PlannedChain[] = [
      { ...target, steps: target.steps.map((step, index) => (index === 0 ? lengthenOneLink(step) : step)) },
      ...firstPlan.slice(1),
    ]
    const mutatedRows = allRows(await scoreChains(chains, mutated))
    const delta = compareToBaseline(mutatedRows, baseline)
    const table = formatDeltaTable(
      mutatedRows,
      delta,
      `benchmark ${TIER} with a ${DETOUR_MM} mm square detour injected into one air link`,
    )
    console.log(table)
    writeEvidence('delta-table-injected-regression.txt', table)

    const mutatedKey = mutatedRows[0].key
    // The detour is pure extra air: further flown, more rapid distance, more
    // repositions. All three are lower-is-better, so all three read `worse`.
    expect(cellsWithMeaningfulVerdict(delta, 'worse').sort()).toEqual(
      [
        `${mutatedKey}/flownDistanceMm`,
        `${mutatedKey}/rapidDistanceMm`,
        `${mutatedKey}/rapidRepositions`,
      ].sort(),
    )
    // And nothing else moved: not the cutting, not the coverage, not the other
    // operation in the chain, not the other part.
    expect(cellsWithMeaningfulVerdict(delta, 'better', 'changed', 'new', 'gone')).toEqual([])
    // The four extra waypoints sit INSIDE the 2% band on a 2000-move path, so
    // `moves` correctly reads unchanged. That is the tolerance band doing its job
    // and it is the whole difference from a byte fingerprint, which would have gone
    // red on all four rows.
    const movesCell = delta.rows
      .find((rowDelta) => rowDelta.key === mutatedKey)
      ?.cells.find((cell) => cell.metric === 'moves')
    expect(movesCell?.verdict).toBe('unchanged')
    expect(movesCell?.delta).toBe(4)
    for (const rowDelta of delta.rows) {
      if (rowDelta.key === mutatedKey) continue
      expect(
        rowDelta.cells.filter(
          (cell) => cell.verdict !== 'unchanged' && cell.verdict !== 'n/a' && cellMovementIsMeaningful(cell),
        ),
        `${rowDelta.key} moved and should not have`,
      ).toEqual([])
    }
    // The safety floor is untouched by an air detour, and it is still an assert.
    for (const row of mutatedRows) {
      expect(row.asserts.maxGougeMm).toBeLessThanOrEqual(row.asserts.gougeToleranceMm)
    }
  }, 300_000)

  it('sums each chain into a total the run prints', () => {
    // The chain total is the headline a human compares between two branches; the
    // per-operation rows are the diagnosis. A total that is computed and never
    // read can drift away from its rows in silence, so it is both printed (with
    // the delta table, above) and checked against the rows it claims to sum.
    for (const result of firstScore) {
      const sum = (metric: string): number =>
        result.rows.reduce((total, row) => total + requireMetricNumber(row.key, metric, row.metrics[metric]), 0)
      expect(result.rows.length).toBeGreaterThan(0)
      expect(result.totals.moves).toBe(sum('moves'))
      expect(result.totals.flownDistanceMm).toBeCloseTo(sum('flownDistanceMm'), 5)
      expect(result.totals.cutTimeMs).toBeCloseTo(sum('cutTimeMs'), 5)
      expect(result.totals.planMs).toBeCloseTo(
        result.rows.reduce((total, row) => total + row.planMs, 0),
        5,
      )
    }
    console.log(`[WO-1217] chain totals
${formatChainTotals(firstScore)}`)
  })

  it('counts a flip only against the heading at the SAME Z', () => {
    // WO-1214 measures the flip rate PER Z and quotes the reference as a band
    // across cutting levels. Grouping by maximal cutting run instead is a
    // different statistic: `plunge` is a cutting role, so such a run walks
    // through the plunge that ends one level and compares a heading up there
    // against a heading on the level below. This path is two levels that each
    // steer perfectly consistently -- level 1 turns left the whole way, level 2
    // turns right the whole way -- joined by a plunge. Per Z it contains no
    // steering reversal at all. Per cutting run it appears to contain one, at
    // the junction, which is a level change and not a steering decision.
    const twoLevels = [
      ...arcLevel(0, +1, 0),
      plungeTo(-2, ARC_RADIUS_MM, 0),
      ...arcLevel(-2, -1, 0),
    ]
    const clean = pathMetrics(twoLevels)
    expect(clean.turns).toBeGreaterThan(2 * MIN_TURNS_PER_Z)
    expect(clean.flips).toBe(0)
    expect(clean.flipRatePct).toBe(0)
    expect(clean.scoredZLevels).toBe(2)
    expect(clean.worstZFlipRatePct).toBe(0)
    expect(clean.bestZFlipRatePct).toBe(0)

    // And the statistic still DISCRIMINATES: one bad level is not diluted by a
    // good one, which is the whole reason the reference is quoted per level.
    const oneBadLevel = [
      ...arcLevel(0, +1, 0),
      plungeTo(-2, 0, 0),
      ...zigzagLevel(-2),
    ]
    const mixed = pathMetrics(oneBadLevel)
    expect(mixed.scoredZLevels).toBe(2)
    expect(mixed.worstZFlipRatePct).toBeGreaterThan(90)
    expect(mixed.bestZFlipRatePct).toBe(0)
    console.log(
      `[WO-1217] per-Z flips: two consistent levels -> ${mixed.scoredZLevels} levels, ` +
        `clean run ${clean.flips} flips over ${clean.turns} turns; one zigzag level -> ` +
        `worst ${mixed.worstZFlipRatePct.toFixed(1)}%, best ${mixed.bestZFlipRatePct.toFixed(1)}%`,
    )
  })

  it('leaves a readable evidence file when asked to', () => {
    if (process.env.WRITE_EVIDENCE !== '1') return
    expect(existsSync(join(EVIDENCE_DIR, 'delta-table-clean.txt'))).toBe(true)
  })
})

/** Side of the injected square detour, mm. Big enough to leave the distance bands. */
const DETOUR_MM = 120

/**
 * Bolt a square detour into the highest rapid in the path, and come back to where it
 * started. Purely additive: four extra waypoints at that rapid's own z -- the highest
 * air the path ever flies at, so the ring cannot touch the part -- and the move after
 * it resumes from exactly the point it did before. No cutting move, no plunge and no
 * link classification changes; only the air does.
 */
function lengthenOneLink(step: PlannedChain['steps'][number]): PlannedChain['steps'][number] {
  let index = -1
  for (let position = 0; position < step.moves.length; position++) {
    const move = step.moves[position]
    if (move.type !== 'rapid') continue
    if (index < 0 || move.z > step.moves[index].z) index = position
  }
  if (index < 0) throw new Error('benchmark: no air link to lengthen')
  const anchor = step.moves[index]
  const detour = [
    { ...anchor, x: anchor.x + DETOUR_MM },
    { ...anchor, x: anchor.x + DETOUR_MM, y: anchor.y + DETOUR_MM },
    { ...anchor, y: anchor.y + DETOUR_MM },
    { ...anchor },
  ]
  return {
    ...step,
    moves: [...step.moves.slice(0, index + 1), ...detour, ...step.moves.slice(index + 1)],
  }
}

/** Turn floor a Z level must clear before its flip rate is quoted -- the same
 *  number `metrics.ts` uses, restated here so the fixture is honestly sized. */
const MIN_TURNS_PER_Z = 20

const ARC_RADIUS_MM = 10
/** Points per synthetic level: comfortably past the turn floor. */
const ARC_POINTS = 40

function cutMove(x: number, y: number, z: number): ToolpathMove {
  return { type: 'feed', role: 'cut', x, y, z }
}

function plungeTo(z: number, x: number, y: number): ToolpathMove {
  return { type: 'feed', role: 'plunge', x, y, z }
}

/** One level of a circular arc, at a constant z, turning consistently one way. */
function arcLevel(z: number, direction: 1 | -1, startDeg: number): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  for (let index = 0; index < ARC_POINTS; index++) {
    const angle = ((startDeg + direction * index * 4) * Math.PI) / 180
    moves.push(cutMove(ARC_RADIUS_MM * Math.cos(angle), ARC_RADIUS_MM * Math.sin(angle), z))
  }
  return moves
}

/** One level that reverses its steering at every single segment. */
function zigzagLevel(z: number): ToolpathMove[] {
  const moves: ToolpathMove[] = []
  for (let index = 0; index < ARC_POINTS; index++) {
    moves.push(cutMove(index * 0.5, index % 2 === 0 ? 0.3 : -0.3, z))
  }
  return moves
}
