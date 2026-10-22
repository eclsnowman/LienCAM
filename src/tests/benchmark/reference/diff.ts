// WO-3009 comparability and the per-family diff report. A reference row is an
// input to "good", never an oracle (alpha3-17 A.7): where it beats the current
// row by more than the band, the band is re-examined; a reference row that
// fails a hard metric is recorded and nothing of it is copied.
import type { Tool } from '../../../types'
import type { ScorecardRow } from '../chainRunner'
import { isNotApplicable, specFor, type MetricValue } from '../metricRegistry'
import type { ReferenceRow } from './rows'
import type { ReferenceParams } from './store'

const SAME_MM = 1e-3

/** Reasons the reference program is NOT comparable with the A.5 row (empty = comparable). */
export function notComparable(params: ReferenceParams, row: { tool: Tool; box: ReferenceParams['stock'] }): string[] {
  const reasons: string[] = []
  if (params.tool.type !== row.tool.type) reasons.push(`tool type ${params.tool.type} differs from the A.5 row's ${row.tool.type}`)
  if (Math.abs(params.tool.diameterMm - row.tool.diameter) > SAME_MM) reasons.push(`tool diameter ${params.tool.diameterMm} mm differs from the A.5 row's ${row.tool.diameter} mm`)
  const corner = row.tool.cornerRadius ?? 0
  if (Math.abs((params.tool.cornerRadiusMm ?? 0) - corner) > SAME_MM) reasons.push(`tool corner radius ${params.tool.cornerRadiusMm ?? 0} mm differs from the A.5 row's ${corner} mm`)
  for (const side of ['minX', 'minY', 'minZ', 'maxX', 'maxY', 'maxZ'] as const) {
    if (!(Math.abs(params.stock?.[side] - row.box[side]) <= SAME_MM)) reasons.push(`stock ${side} ${params.stock?.[side]} mm differs from the A.5 row's ${row.box[side]} mm`)
  }
  return reasons
}

export type CellVerdict = 'reference better beyond band' | 'reference worse beyond band' | 'within band' | 'changed (neutral metric)' | 'n/a'
export interface CellCompare { cell: string; current: MetricValue; reference: MetricValue; band: number; verdict: CellVerdict }
export interface RowDiff {
  key: string; family: string
  /** Hard metrics the reference row fails: recorded, never copied. */
  referenceHardFails: string[]
  /** Cells where the reference beats the current row by more than the band: the band is re-examined. */
  reopen: string[]
  cells: CellCompare[]
}

function compareCell(cell: string, current: MetricValue, reference: MetricValue): CellCompare {
  if (isNotApplicable(current) || isNotApplicable(reference)) return { cell, current, reference, band: 0, verdict: 'n/a' }
  const spec = specFor(cell)
  const band = Math.max(spec.band.pct * Math.abs(current), spec.band.abs)
  const delta = reference - current
  if (Math.abs(delta) <= band) return { cell, current, reference, band, verdict: 'within band' }
  if (spec.direction === 'neutral') return { cell, current, reference, band, verdict: 'changed (neutral metric)' }
  const better = spec.direction === 'lower' ? delta < 0 : delta > 0
  return { cell, current, reference, band, verdict: better ? 'reference better beyond band' : 'reference worse beyond band' }
}

export function diffRow(current: ScorecardRow, reference: ReferenceRow): RowDiff {
  const cells = Object.keys(current.metrics).sort().map(cell => compareCell(cell, current.metrics[cell], reference.metrics[cell] ?? { value: null, reason: 'missing on the reference row' }))
  const referenceHardFails = Object.entries(reference.hardVerdicts ?? {}).filter(([, verdict]) => verdict === 'FAIL').map(([cell]) => cell)
  return { key: current.key, family: current.opType, referenceHardFails,
    reopen: referenceHardFails.length ? [] : cells.filter(c => c.verdict === 'reference better beyond band').map(c => c.cell), cells }
}

/** Per-family report: rows grouped by operation family. */
export function familyReport(diffs: readonly RowDiff[]): Record<string, RowDiff[]> {
  const out: Record<string, RowDiff[]> = {}
  for (const diff of diffs) (out[diff.family] ??= []).push(diff)
  return out
}
