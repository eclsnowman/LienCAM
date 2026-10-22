// WO-3009 acceptance (1): a current-engine P0 row, posted through every
// shipping dialect and re-imported by the independent reader, scores the same
// non-timing cells. Two comparisons, both recorded:
//  - against the PROGRAM VIEW of the native moves (positions, arc centres,
//    posted feeds, no roles) scored the same way: every cell, within the
//    scorecard's own band; this isolates post + reader + normaliser.
//  - against the native ENGINE row: every cell that differs must differ in
//    the program view too, i.e. the difference is the roles a G-code file
//    cannot carry, never the reader.
import type { Tool, ToolpathMove } from '../../../types'
import { emitProgram } from '../../../lib/post/emit'
import { BUILT_IN_DIALECTS } from '../../../lib/post'
import { applyResolvedMoveFeed, resolveFeedrates } from '../../../lib/cam/feedrates'
import { collapsePolyline } from '../../../lib/post/arcfit'
import { makeMachine, makeOp, makeWcs } from '../../post/helpers'
import type { PlannedStep, ScorecardRow } from '../chainRunner'
import { isNotApplicable, specFor, type MetricValue } from '../metricRegistry'
import { normaliseProgram } from './normalise'
import { parseProgram } from './parse'
import { programView } from './roles'

export const DIALECTS = BUILT_IN_DIALECTS.filter(config => config.builtin)
/** Cells built on the cycle-time estimate. */
export const CYCLE_TIME_CELLS = new Set(['cutTimeMs', 'M-AIR-2', 'M-TIME-3'])
const RAPID_RATE = 8000

/** Post one planned step exactly as the M-PROG-4 collector does (metrics.alpha3.ts). */
export function postStep(plan: PlannedStep, tool: Tool, opType: string, dialectId: string): string {
  const config = DIALECTS.find(c => c.id === dialectId)
  if (!config) throw new Error(`unknown dialect ${dialectId}`)
  const feeds = resolveFeedrates(tool, plan.settings?.feedrateOverride, RAPID_RATE)
  const machine = makeMachine({ id: 'liencnc-v2', rapidRate: RAPID_RATE, travel: { x: 738, y: 724.5, z: 129.2 } })
  const op = makeOp({ id: plan.stepId, type: opType as ReturnType<typeof makeOp>['type'], toolId: tool.id, ...plan.settings, toolpathMoves: plan.moves })
  const result = emitProgram({ machine, setup: { wcs: plan.sourceWcs ?? makeWcs({ origin: plan.sourceWcsOrigin ?? { x: 0, y: 0, z: 0 } }), operations: [{ op, tool, feeds,
    spindle: { rpm: plan.settings?.feedrateOverride?.enabled ? plan.settings.feedrateOverride.rpm : tool.feedsAndSpeeds.default?.rpm ?? 0, dir: 'cw' },
    coolant: 'none', moves: plan.moves }] } }, config)
  const errors = result.diagnostics.filter(d => d.level === 'error')
  if (errors.length) throw new Error(`post ${dialectId}: ${errors.map(d => d.message).join('; ')}`)
  return result.lines.join('\n') + '\n'
}

export function reimport(program: string, plan: PlannedStep) {
  return normaliseProgram(parseProgram(program), { originMm: plan.sourceWcsOrigin ?? { x: 0, y: 0, z: 0 } })
}

export function nativeProgramView(plan: PlannedStep, tool: Tool): ToolpathMove[] {
  return programView(plan.moves, resolveFeedrates(tool, plan.settings?.feedrateOverride, RAPID_RATE))
}

/**
 * The geometry a dialect WRITES for a step, computed without reading the file:
 * the production arc fit (collapsePolyline) with that dialect's own limits, as
 * emit.ts applies it to the feed-resolved moves, then the program view.
 */
export function postedGeometryView(plan: PlannedStep, tool: Tool, dialectId: string): ToolpathMove[] {
  const config = DIALECTS.find(c => c.id === dialectId)!
  const feeds = resolveFeedrates(tool, plan.settings?.feedrateOverride, RAPID_RATE)
  const resolved = plan.moves.map(move => applyResolvedMoveFeed(move, feeds))
  const caps = config.capabilities
  const walked = caps.arcs ? collapsePolyline(resolved, { arcTolerance: config.options.arcTolerance ?? 0.05,
    minArcRadius: caps.minArcRadius, maxArcRadius: caps.maxArcRadius ?? 1e4, minSweepDeg: caps.minSweepDeg ?? 2 }) : resolved
  // Modal suppression: a block whose written X/Y/Z equal the previous block's
  // at the dialect's resolution changes no word, so no block is written.
  const origin = plan.sourceWcsOrigin ?? { x: 0, y: 0, z: 0 }
  const scale = 10 ** config.format.xyzDecimals
  const written = (m: ToolpathMove) => [m.x - origin.x, m.y - origin.y, m.z - origin.z].map(v => Math.round(v * scale)).join(',')
  let last = ''
  return programView(walked, feeds).filter(move => {
    const at = written(move)
    const keep = at !== last || move.type === 'arc_cw' || move.type === 'arc_ccw'
    last = at
    return keep
  })
}

/** Count cells: compared exactly ("identical counts"), never within a band. */
export const COUNT_CELLS = new Set(['moves', 'cutMoves', 'links', 'liftedLinks', 'keepDownRides', 'retracts', 'rapidRepositions',
  'feedLinkMoves', 'entryCutMoves', 'turns', 'flips', 'scoredZLevels', 'distinctCutZValues',
  'levelCount', 'plannedRegions', 'machinedRegions', 'skippedRegions', 'partialRegions', 'M-ENTRY-1', 'M-ENTRY-3'])

export interface CellDiff { cell: string; a: number | string; b: number | string; band: number }

const NUMBER = /-?\d+(?:\.\d+)?(?:e[-+]?\d+)?/gi
/** Two reasons agree when their words match and every number they quote agrees to 1e-4 relative (1e-3 absolute). */
function sameReason(a: string, b: string): boolean {
  if (a.replace(NUMBER, '#') !== b.replace(NUMBER, '#')) return false
  const x = a.match(NUMBER) ?? [], y = b.match(NUMBER) ?? []
  return x.every((v, i) => Math.abs(Number(v) - Number(y[i])) <= Math.max(1e-4 * Math.abs(Number(v)), 1e-3))
}

/**
 * The scorecard's cells (row.metrics; asserts are "never cells", scorecard.ts)
 * of `b` that differ from `a` beyond the registry band of that metric.
 */
export function cellDiffs(a: Pick<ScorecardRow, 'metrics'>, b: Pick<ScorecardRow, 'metrics'>, skip: ReadonlySet<string> = new Set()): { compared: number; diffs: CellDiff[] } {
  const diffs: CellDiff[] = []
  let compared = 0
  for (const cell of [...new Set([...Object.keys(a.metrics), ...Object.keys(b.metrics)])].sort()) {
    if (skip.has(cell)) continue
    compared++
    const x = a.metrics[cell], y = b.metrics[cell]
    const show = (v: MetricValue | undefined) => v === undefined ? 'missing' : isNotApplicable(v) ? v.reason : v
    if (x === undefined || y === undefined || isNotApplicable(x) || isNotApplicable(y)) {
      const p = show(x), q = show(y)
      if (typeof p !== 'string' || typeof q !== 'string' || !sameReason(p, q)) diffs.push({ cell, a: p, b: q, band: 0 })
      continue
    }
    const band = COUNT_CELLS.has(cell) ? 0 : Math.max(specFor(cell).band.pct * Math.abs(x), specFor(cell).band.abs)
    if (Math.abs(x - y) > band) diffs.push({ cell, a: x, b: y, band })
  }
  return { compared, diffs }
}

/** Largest relative deviation over numeric cells present in both rows, for the record. */
export function maxRelativeDeviation(a: Pick<ScorecardRow, 'metrics'>, b: Pick<ScorecardRow, 'metrics'>): { cell: string; relative: number } {
  const left = a.metrics, right = b.metrics
  let worst = { cell: '', relative: 0 }
  for (const [cell, x] of Object.entries(left)) {
    const y = right[cell]
    if (typeof x !== 'number' || typeof y !== 'number' || x === y) continue
    const relative = Math.abs(x - y) / Math.max(Math.abs(x), Math.abs(y), 1e-9)
    if (relative > worst.relative) worst = { cell, relative }
  }
  return worst
}
