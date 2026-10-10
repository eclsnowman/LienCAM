// WO-1217 -- the scorecard: bands, the committed baseline, and the delta table.
//
// The byte fingerprint on the 2D corpus says CHANGED and stops there. This says
// BETTER, WORSE or UNCHANGED, per metric, per row, with the numbers next to the
// verdict -- which is why a deliberate improvement here updates the baseline with
// its reason in the same commit instead of waiting for Operator's picture verdict.
//
// TWO THINGS ARE NOT CELLS. Max gouge below the surface and stock-to-leave are
// ASSERTS: a run that gouges fails whatever the delta table says.
//
// The metric REGISTRY and its completeness invariant live in `metricRegistry.ts`
// (both this file and the chain runner need them, and a shared module is how they
// avoid an import cycle). Everything there is re-exported here, so a caller only
// ever imports from the scorecard.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import type { ChainResult, ScorecardRow } from './chainRunner'
import { isNotApplicable, metricNumber, specFor, type MetricBand, type MetricValue } from './metricRegistry'

export * from './metricRegistry'

/**
 * The metrics that must be byte-identical between two runs of the same code.
 * A not-applicable cell is included, REASON AND ALL: the reason is part of what
 * the run claims, so a run that starts refusing to measure something -- or that
 * refuses it for a different reason -- breaks determinism rather than sliding
 * past it.
 */
export function deterministicMetrics(row: ScorecardRow): Record<string, MetricValue> {
  const out: Record<string, MetricValue> = {}
  for (const [name, value] of Object.entries(row.metrics)) {
    if (!specFor(name).timing) out[name] = value
  }
  return out
}

export interface BaselineCell {
  /** `null` means the row declared this metric not applicable; `reason` says why. */
  value: number | null
  reason?: string
  band: MetricBand
}

/** A baseline cell as the committed JSON carries it, from a live metric value. */
function baselineCell(name: string, value: MetricValue): BaselineCell {
  const band = specFor(name).band
  return isNotApplicable(value) ? { value: null, reason: value.reason, band } : { value, band }
}

export interface BaselineRow {
  key: string
  opType: string
  toolId: string
  toolDiameterMm: number
  metrics: Record<string, BaselineCell>
  planMs: BaselineCell
  asserts: ScorecardRow['asserts']
}

export interface Baseline {
  schema: 1
  tier: string
  generatedAt: string
  /** WHY this baseline says what it says. Regeneration refuses without one. */
  reason: string
  rows: BaselineRow[]
}

export function baselineFromRows(tier: string, rows: readonly ScorecardRow[], reason: string, generatedAt: string): Baseline {
  return {
    schema: 1,
    tier,
    generatedAt,
    reason,
    rows: rows.map((row) => ({
      key: row.key,
      opType: row.opType,
      toolId: row.toolId,
      toolDiameterMm: row.toolDiameterMm,
      metrics: Object.fromEntries(
        Object.entries(row.metrics).map(([name, value]) => [name, baselineCell(name, value)]),
      ),
      planMs: { value: row.planMs, band: specFor('planMs').band },
      asserts: row.asserts,
    })),
  }
}

export function readBaseline(path: string): Baseline | undefined {
  if (!existsSync(path)) return undefined
  const parsed = JSON.parse(readFileSync(path, 'utf-8')) as Baseline
  if (parsed.schema !== 1) throw new Error(`benchmark baseline ${path}: unknown schema ${parsed.schema}`)
  return parsed
}

export function writeBaseline(path: string, baseline: Baseline): void {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8')
}

/**
 * `n/a` is a verdict in its own right: both sides declared the metric not
 * applicable, for the same reason. It is not `unchanged` -- an unchanged cell is
 * two measurements that agree, and conflating the two is how an unmeasured metric
 * hides inside a green run.
 *
 * A metric that STARTED being measured reads `new`; one that STOPPED reads `gone`.
 * Both are unmatched, both fail the smoke test, and `gone` is the loud one: it is
 * a measurement the harness used to make and no longer does.
 */
export type CellVerdict = 'better' | 'worse' | 'unchanged' | 'changed' | 'new' | 'gone' | 'n/a'

export interface CellDelta {
  metric: string
  baseline: number | undefined
  current: number | undefined
  delta: number | undefined
  verdict: CellVerdict
  /** Why the cell is `n/a`, or why the two sides' reasons differ. */
  note?: string
}

export interface RowDelta {
  key: string
  present: 'both' | 'current-only' | 'baseline-only'
  cells: CellDelta[]
}

export interface ScorecardDelta {
  rows: RowDelta[]
  better: number
  worse: number
  unchanged: number
  changed: number
  missing: number
  /** Cells both sides declared not applicable, with matching reasons. */
  notApplicable: number
}

function withinBand(baseline: number, current: number, band: MetricBand): boolean {
  const tolerance = Math.max(band.abs, Math.abs(baseline) * band.pct)
  return Math.abs(current - baseline) <= tolerance
}

export function compareToBaseline(rows: readonly ScorecardRow[], baseline: Baseline): ScorecardDelta {
  const byKey = new Map(baseline.rows.map((row) => [row.key, row]))
  const delta: ScorecardDelta = {
    rows: [], better: 0, worse: 0, unchanged: 0, changed: 0, missing: 0, notApplicable: 0,
  }

  for (const row of rows) {
    const base = byKey.get(row.key)
    byKey.delete(row.key)
    if (!base) {
      delta.rows.push({ key: row.key, present: 'current-only', cells: [] })
      delta.missing++
      continue
    }
    const names = [...new Set([...Object.keys(base.metrics), ...Object.keys(row.metrics), 'planMs'])].sort()
    const cells: CellDelta[] = []
    for (const metric of names) {
      const spec = specFor(metric)
      const baseCell = metric === 'planMs' ? base.planMs : base.metrics[metric]
      const currentCell: MetricValue | undefined = metric === 'planMs' ? row.planMs : row.metrics[metric]
      if (baseCell === undefined && currentCell === undefined) continue
      const currentValue = currentCell === undefined ? undefined : metricNumber(currentCell)
      const currentReason =
        currentCell !== undefined && isNotApplicable(currentCell) ? currentCell.reason : undefined

      // A metric absent from ONE side entirely -- a registry that grew, or a
      // baseline written before the metric existed. Unmatched either way.
      if (baseCell === undefined) {
        cells.push({
          metric, baseline: undefined, current: currentValue, delta: undefined, verdict: 'new',
          ...(currentReason ? { note: currentReason } : {}),
        })
        delta.missing++
        continue
      }
      if (currentCell === undefined) {
        cells.push({ metric, baseline: baseCell.value ?? undefined, current: undefined, delta: undefined, verdict: 'gone' })
        delta.missing++
        continue
      }

      // Reasoned absences. Both sides not applicable is `n/a`; a reason that
      // MOVED is direction-neutral news a human reads, not a silent match.
      if (baseCell.value === null || currentReason !== undefined) {
        if (baseCell.value === null && currentReason !== undefined) {
          if (baseCell.reason === currentReason) {
            cells.push({ metric, baseline: undefined, current: undefined, delta: undefined, verdict: 'n/a', note: currentReason })
            delta.notApplicable++
          } else {
            cells.push({
              metric, baseline: undefined, current: undefined, delta: undefined, verdict: 'changed',
              note: `reason changed: "${baseCell.reason ?? '(none)'}" -> "${currentReason}"`,
            })
            delta.changed++
          }
          continue
        }
        // One side measures it and the other does not: a coverage change, and the
        // direction matters. Started measuring -> `new`; stopped -> `gone`.
        if (baseCell.value === null) {
          cells.push({
            metric, baseline: undefined, current: currentValue, delta: undefined, verdict: 'new',
            note: `was not applicable: "${baseCell.reason ?? '(none)'}"`,
          })
        } else {
          cells.push({
            metric, baseline: baseCell.value, current: undefined, delta: undefined, verdict: 'gone',
            note: `now not applicable: "${currentReason ?? '(none)'}"`,
          })
        }
        delta.missing++
        continue
      }

      const numericCurrent = currentValue as number
      const band = baseCell.band ?? spec.band
      const difference = numericCurrent - baseCell.value
      let verdict: CellVerdict
      if (withinBand(baseCell.value, numericCurrent, band)) {
        verdict = 'unchanged'
        delta.unchanged++
      } else if (spec.direction === 'neutral') {
        verdict = 'changed'
        delta.changed++
      } else if ((spec.direction === 'lower' && difference < 0) || (spec.direction === 'higher' && difference > 0)) {
        verdict = 'better'
        delta.better++
      } else {
        verdict = 'worse'
        delta.worse++
      }
      cells.push({ metric, baseline: baseCell.value, current: numericCurrent, delta: difference, verdict })
    }
    delta.rows.push({ key: row.key, present: 'both', cells })
  }

  for (const orphan of byKey.values()) {
    delta.rows.push({ key: orphan.key, present: 'baseline-only', cells: [] })
    delta.missing++
  }
  return delta
}

function fixed(value: number | undefined, places = 3): string {
  if (value === undefined) return '-'
  if (Number.isInteger(value)) return String(value)
  return value.toFixed(places)
}

function pad(text: string, width: number, right = false): string {
  return right ? text.padStart(width) : text.padEnd(width)
}

/**
 * The table a human reads. Plain ASCII, one block per scorecard row, one line per
 * metric: baseline, current, delta and the verdict word.
 */
export function formatDeltaTable(rows: readonly ScorecardRow[], delta: ScorecardDelta, title: string): string {
  const byKey = new Map(rows.map((row) => [row.key, row]))
  const lines: string[] = []
  lines.push(`=== ${title} ===`)
  for (const rowDelta of delta.rows) {
    const row = byKey.get(rowDelta.key)
    if (rowDelta.present === 'baseline-only') {
      lines.push(`ROW ${rowDelta.key}: IN BASELINE, NOT RUN`)
      continue
    }
    if (rowDelta.present === 'current-only') {
      lines.push(`ROW ${rowDelta.key}: RUN, NOT IN BASELINE (add it to the baseline with a reason)`)
      continue
    }
    lines.push('')
    lines.push(`ROW ${rowDelta.key}  [${row?.opType ?? '?'} , ${fixed(row?.toolDiameterMm)} mm]`)
    // Wide enough for the longest metric name the registry can produce, so the
    // number columns stay aligned instead of shunting right on one row.
    const widths = { metric: 26, base: 14, current: 14, delta: 14 }
    lines.push(
      `  ${pad('metric', widths.metric)}${pad('baseline', widths.base, true)}` +
        `${pad('current', widths.current, true)}${pad('delta', widths.delta, true)}  verdict`,
    )
    for (const cell of rowDelta.cells) {
      lines.push(
        `  ${pad(cell.metric, widths.metric)}${pad(fixed(cell.baseline), widths.base, true)}` +
          `${pad(fixed(cell.current), widths.current, true)}` +
          `${pad(cell.delta === undefined ? '-' : `${cell.delta >= 0 ? '+' : ''}${fixed(cell.delta)}`, widths.delta, true)}` +
          `  ${cell.verdict}${cell.note ? ` -- ${cell.note}` : ''}`,
      )
    }
    if (row) {
      lines.push(
        `  ASSERTS (never cells): max gouge ${fixed(row.asserts.maxGougeMm, 4)} mm ` +
          `(allowed ${fixed(row.asserts.gougeToleranceMm, 4)}), least material left under a cut ` +
          `${fixed(row.asserts.minCutMarginMm, 4)} mm (required ${fixed(row.asserts.stockToLeaveMm, 4)}), ` +
          `${row.asserts.samplesOverPart} samples over the part of which ` +
          `${row.asserts.cutSamplesOverPart} cutting, ` +
          `${row.asserts.steepInteriorSamplesSkipped} steep interior samples skipped`,
      )
    }
  }
  lines.push('')
  lines.push(
    `SUMMARY: ${delta.better} better, ${delta.worse} worse, ${delta.unchanged} unchanged, ` +
      `${delta.changed} changed (direction-neutral), ${delta.notApplicable} not applicable ` +
      `(reasoned, both sides), ${delta.missing} unmatched`,
  )
  const worse = delta.rows.flatMap((rowDelta) =>
    rowDelta.cells.filter((cell) => cell.verdict === 'worse').map((cell) => `${rowDelta.key}/${cell.metric}`),
  )
  if (worse.length > 0) lines.push(`WORSE: ${worse.join(', ')}`)
  return lines.join('\n')
}

/** Every cell whose verdict is one of `verdicts`, as `rowKey/metric`. */
export function cellsWithVerdict(delta: ScorecardDelta, ...verdicts: CellVerdict[]): string[] {
  const wanted = new Set(verdicts)
  return delta.rows.flatMap((rowDelta) =>
    rowDelta.cells.filter((cell) => wanted.has(cell.verdict)).map((cell) => `${rowDelta.key}/${cell.metric}`),
  )
}

/** Stopwatch movement is informational; structural appearance/disappearance is not. */
export function cellMovementIsMeaningful(cell: CellDelta): boolean {
  return cell.verdict === 'new' || cell.verdict === 'gone' || !specFor(cell.metric).timing
}

/** Timing-safe counterpart to `cellsWithVerdict` for behavioral assertions. */
export function cellsWithMeaningfulVerdict(delta: ScorecardDelta, ...verdicts: CellVerdict[]): string[] {
  const wanted = new Set(verdicts)
  return delta.rows.flatMap((rowDelta) =>
    rowDelta.cells
      .filter((cell) => wanted.has(cell.verdict) && cellMovementIsMeaningful(cell))
      .map((cell) => `${rowDelta.key}/${cell.metric}`),
  )
}

/**
 * Cells that must stop a landing gate. Stopwatch movement remains visible in the
 * delta table but cannot decide the gate; a stopwatch appearing or disappearing
 * is still a structural change and therefore fails like any other unmatched cell.
 */
export function cellsFailingLandingGate(delta: ScorecardDelta): string[] {
  return delta.rows.flatMap((rowDelta) =>
    rowDelta.cells
      .filter((cell) => {
        if (cell.verdict === 'better' || cell.verdict === 'unchanged' || cell.verdict === 'n/a') return false
        return cellMovementIsMeaningful(cell)
      })
      .map((cell) => `${rowDelta.key}/${cell.metric}=${cell.verdict}`),
  )
}

/**
 * The chain totals line. One row per chain: what the whole chain costs, which is
 * the number a human compares between two branches at a glance. The per-operation
 * rows above are the diagnosis; this is the headline, and it is printed rather
 * than computed and dropped -- a total nobody reads can regress silently.
 */
export function formatChainTotals(results: readonly ChainResult[]): string {
  const lines: string[] = ['=== chain totals ===']
  lines.push(`  ${pad('chain', 34)}${pad('moves', 12, true)}${pad('flown mm', 14, true)}` +
    `${pad('cut time ms', 14, true)}${pad('plan ms', 12, true)}`)
  for (const result of results) {
    lines.push(
      `  ${pad(result.chainId, 34)}${pad(fixed(result.totals.moves), 12, true)}` +
        `${pad(fixed(result.totals.flownDistanceMm), 14, true)}` +
        `${pad(fixed(result.totals.cutTimeMs), 14, true)}` +
        `${pad(fixed(result.totals.planMs), 12, true)}`,
    )
  }
  return lines.join('\n')
}
