// WO-1217 -- THE METRIC REGISTRY, and the completeness invariant that guards it.
//
// WHY THIS FILE EXISTS (WO-1217 audit round 4): the finish rows silently carried
// no engagement and no region metrics. Nothing caught it, because a MISSING metric
// is invisible -- the baseline encoded the omission and the tests encoded the
// baseline, so 21 tests passed over two half-empty rows.
//
//   THE INVARIANT: every scorecard row carries a value for EVERY metric in this
//   registry, or an explicit null with a `reason` string. A metric may never
//   simply be absent.
//
// It is stated ONCE, at the write path -- `assertRowComplete` runs in the chain
// runner before a row is pushed, so a metric added here fails the very next run
// loudly instead of being quietly dropped from two rows. `specFor` enforces the
// same rule in the other direction: an emitted metric that nobody registered
// throws rather than picking up a silent fallback band.
//
// "Not applicable" is a fine answer and it is auditable; silence is not.
//
// The registry lives apart from `scorecard.ts` so both the runner (which writes
// rows) and the scorecard (which compares them) can import it without a cycle.
// `scorecard.ts` re-exports it, so nothing outside needs to know that.

/**
 * Which way is good.
 * - `lower`  : fewer moves, less air, less time, fewer flips, less uncut stock.
 * - `higher` : more material actually machined; more KEEP-DOWN rides, because
 *              Operator names avoiding repositions as our advantage over Fusion
 *              (2026-09-05) and a smoothness fix that buys itself by lifting more
 *              often has failed.
 * - `neutral`: informative but not directional on its own -- printed as `changed`.
 */
export type MetricDirection = 'lower' | 'higher' | 'neutral'

export interface MetricBand {
  /** Fractional tolerance on the baseline value, e.g. 0.02 = 2%. */
  pct: number
  /** Absolute tolerance, same unit as the metric. The band is the LARGER of the two. */
  abs: number
}

export interface MetricSpec {
  direction: MetricDirection
  band: MetricBand
  /** True when the value is wall-clock and therefore not part of determinism. */
  timing?: boolean
  /**
   * True when the metric lives ON the row rather than inside `row.metrics` (wall
   * time is the only one). Row-level metrics are compared like any other cell but
   * are not part of the completeness walk over `row.metrics`.
   */
  rowLevel?: boolean
}

/**
 * A metric this row could not measure, and WHY. The reason is part of the row, so
 * it is committed into the baseline, printed in the delta table and compared
 * between runs: a reason that changes is a change a human reads.
 */
export interface MetricNotApplicable {
  value: null
  reason: string
}

/** Every cell of a scorecard row: a number, or an explicit, reasoned absence. */
export type MetricValue = number | MetricNotApplicable

/**
 * Bands are deliberately coarse on the smoke tier (WO-1217 section 5) -- it exists
 * to catch gross breakage in under three minutes, not to police the third decimal.
 * A structural metric (move counts, region counts) has a tight band because it is
 * an integer that only moves when something structural does.
 */
export const METRIC_SPECS: Record<string, MetricSpec> = {
  moves: { direction: 'lower', band: { pct: 0.02, abs: 2 } },
  cutMoves: { direction: 'lower', band: { pct: 0.02, abs: 2 } },
  flownDistanceMm: { direction: 'lower', band: { pct: 0.02, abs: 0.5 } },
  cutLengthMm: { direction: 'neutral', band: { pct: 0.02, abs: 0.5 } },
  rapidDistanceMm: { direction: 'lower', band: { pct: 0.05, abs: 1 } },
  links: { direction: 'neutral', band: { pct: 0.05, abs: 1 } },
  liftedLinks: { direction: 'lower', band: { pct: 0.05, abs: 1 } },
  keepDownRides: { direction: 'higher', band: { pct: 0.05, abs: 1 } },
  retracts: { direction: 'lower', band: { pct: 0.05, abs: 1 } },
  rapidRepositions: { direction: 'lower', band: { pct: 0.05, abs: 1 } },
  feedLinkMoves: { direction: 'lower', band: { pct: 0.05, abs: 1 } },
  // An entry takes a full disc by design, so fewer and shorter entries is less
  // of the heaviest cutting a path does.
  entryCutMoves: { direction: 'lower', band: { pct: 0.05, abs: 2 } },
  entryCutLengthMm: { direction: 'lower', band: { pct: 0.05, abs: 0.5 } },
  turns: { direction: 'neutral', band: { pct: 0.02, abs: 2 } },
  flips: { direction: 'lower', band: { pct: 0.05, abs: 2 } },
  flipRatePct: { direction: 'lower', band: { pct: 0.05, abs: 0.5 } },
  // Per Z, which is how WO-1214 quotes the reference band (0.2-4.7% across
  // Fusion's cutting levels). Worst and best bound our own band; the level count
  // is structural, so any change in it is worth reading.
  worstZFlipRatePct: { direction: 'lower', band: { pct: 0.05, abs: 0.5 } },
  bestZFlipRatePct: { direction: 'lower', band: { pct: 0.05, abs: 0.5 } },
  scoredZLevels: { direction: 'neutral', band: { pct: 0, abs: 0 } },
  maxFlipDeg: { direction: 'lower', band: { pct: 0.1, abs: 1 } },
  p95FlipDeg: { direction: 'lower', band: { pct: 0.1, abs: 1 } },
  distinctCutZValues: { direction: 'neutral', band: { pct: 0, abs: 0 } },
  levelCount: { direction: 'neutral', band: { pct: 0, abs: 0 } },
  // Sustained radial engagement, as a fraction of a full-width slot (the engine's
  // own unit -- see metrics.ts). A cap breach is what adaptive exists to prevent,
  // so the over-cap length carries the tightest band of the four: half a
  // millimetre of new slotting is worth reading.
  peakEngagementFraction: { direction: 'lower', band: { pct: 0.05, abs: 0.02 } },
  p95EngagementFraction: { direction: 'lower', band: { pct: 0.05, abs: 0.02 } },
  engagementOverCapLengthMm: { direction: 'lower', band: { pct: 0.05, abs: 0.5 } },
  engagementOverCapPct: { direction: 'lower', band: { pct: 0.05, abs: 0.2 } },
  // The cap itself is a declaration, not a measurement: it moves only when the
  // registry says so, and then it must be read.
  engagementCapFraction: { direction: 'neutral', band: { pct: 0, abs: 0 } },
  measuredCuttingLengthMm: { direction: 'neutral', band: { pct: 0.02, abs: 0.5 } },
  minLinkClearanceMm: { direction: 'higher', band: { pct: 0.1, abs: 0.02 } },
  uncutAreaMm2: { direction: 'lower', band: { pct: 0.05, abs: 1 } },
  machinedAreaMm2: { direction: 'higher', band: { pct: 0.05, abs: 1 } },
  removedVolumeMm3: { direction: 'neutral', band: { pct: 0.05, abs: 1 } },
  cutTimeMs: { direction: 'lower', band: { pct: 0.03, abs: 200 } },
  plannedRegions: { direction: 'neutral', band: { pct: 0, abs: 0 } },
  machinedRegions: { direction: 'higher', band: { pct: 0, abs: 0 } },
  skippedRegions: { direction: 'lower', band: { pct: 0, abs: 0 } },
  partialRegions: { direction: 'neutral', band: { pct: 0, abs: 0 } },
  // Wall time. The band is wide on purpose: this box runs lanes concurrently, so
  // a 40% swing is load and a 2x swing is WO-1198 happening again.
  planMs: { direction: 'lower', band: { pct: 0.6, abs: 400 }, timing: true, rowLevel: true },
}

/**
 * Every metric a row's `metrics` map must carry -- the registry minus the ones
 * that live on the row itself. Sorted, so a completeness failure reads the same
 * way every time.
 */
export const REQUIRED_ROW_METRICS: readonly string[] = Object.keys(METRIC_SPECS)
  .filter((name) => !METRIC_SPECS[name].rowLevel)
  .sort()

/**
 * The spec for a metric. THROWS for a metric nobody registered: a fallback band is
 * how an unregistered metric gets scored against a tolerance nobody chose, and a
 * cell judged against a guessed band is worse than no cell.
 */
export function specFor(metric: string): MetricSpec {
  const spec = METRIC_SPECS[metric]
  if (!spec) {
    throw new Error(
      `benchmark: metric "${metric}" is not in METRIC_SPECS. Register it in ` +
        'src/tests/benchmark/metricRegistry.ts with a direction and a band -- the registry is ' +
        'the list every row is checked against, so an unregistered metric has no invariant.',
    )
  }
  return spec
}

/** Declare that this row cannot carry this metric, and say why. */
export function notApplicable(reason: string): MetricNotApplicable {
  const trimmed = reason.trim()
  if (trimmed.length === 0) {
    throw new Error('benchmark: a not-applicable metric needs a reason. Silence is the bug this guards.')
  }
  return { value: null, reason: trimmed }
}

export function isNotApplicable(value: MetricValue): value is MetricNotApplicable {
  return typeof value !== 'number'
}

/** The number, or undefined when the row declared the metric not applicable. */
export function metricNumber(value: MetricValue | undefined): number | undefined {
  if (value === undefined) return undefined
  return isNotApplicable(value) ? undefined : value
}

/**
 * The number, or a throw. For the places that SUM a metric across rows: a total
 * that silently treats a not-applicable cell as zero is the same class of lie this
 * whole file exists to stop.
 */
export function requireMetricNumber(rowKey: string, metric: string, value: MetricValue | undefined): number {
  const numeric = metricNumber(value)
  if (numeric === undefined) {
    throw new Error(
      `benchmark row ${rowKey}: metric "${metric}" must be numeric here but is ` +
        `${value === undefined ? 'absent' : `not applicable (${(value as MetricNotApplicable).reason})`}.`,
    )
  }
  return numeric
}

/**
 * THE COMPLETENESS INVARIANT, checked at the one write path.
 *
 * The chain runner calls this before it pushes a row, so adding a metric to the
 * registry fails the very next run with the row and the metric named, instead of
 * producing rows that quietly lack it.
 */
export function assertRowComplete(rowKey: string, metrics: Readonly<Record<string, MetricValue>>): void {
  const absent = REQUIRED_ROW_METRICS.filter((name) => !(name in metrics))
  if (absent.length > 0) {
    throw new Error(
      `benchmark row ${rowKey}: ${absent.length} registry metric(s) absent: ${absent.join(', ')}. ` +
        'Every row carries every registry metric, as a number or as notApplicable("why"). ' +
        'A missing metric is invisible -- that is how WO-1217 shipped two half-empty rows.',
    )
  }
  const unregistered = Object.keys(metrics).filter((name) => !(name in METRIC_SPECS))
  if (unregistered.length > 0) {
    throw new Error(
      `benchmark row ${rowKey}: metric(s) not in the registry: ${unregistered.join(', ')}. ` +
        'Register them in metricRegistry.ts with a direction and a band.',
    )
  }
  for (const [name, value] of Object.entries(metrics)) {
    if (isNotApplicable(value)) continue
    if (!Number.isFinite(value)) {
      throw new Error(`benchmark row ${rowKey}: metric "${name}" is ${value}, which is not a measurement.`)
    }
  }
}
