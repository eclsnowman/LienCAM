// WO-1880 -- a metric that measured nothing says so.
//
// WO-1877 finding H1: metrics.ts:697 used to end with
// `minLinkClearanceMm: Number.isFinite(minLinkClearance) ? minLinkClearance : 0`.
// A pass whose every sample cuts has no non-cutting sample to report a
// clearance for, and 0 is the WORST value a higher-is-better metric can show
// -- so two rows that measured nothing at all (stepped-boss/finish-3-ball,
// boss-taper-step/finish-3-ball: every sample is cutting) read "worse" when
// nothing got worse.
//
// These tests pin the collector's own signal (NaN, not 0 -- metrics.ts is the
// only file that carries the fallback, so that is where the negative control
// lives: reverting `Number.NaN` back to `0` makes `Number.isNaN(...)` false
// and the first test below fails), the conversion into the registry's
// reasoned-absence shape (`linkClearanceMetric`), and that the scorecard
// actually reads the result as "not applicable" rather than "worse" -- the
// whole point of the fix. The last test reads the committed full baseline
// directly, so it fails if the two named rows are ever regenerated back to 0.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

import type { CutterSpec, PartMesh } from '../../cam3d/kernel/types'
import type { ToolpathMove } from '../../types'

import type { ScorecardRow } from './chainRunner'
import { linkClearanceMetric, NO_LINK_CLEARANCE_SAMPLE_REASON, samplePath, surfaceMetrics } from './metrics'
import { isNotApplicable, notApplicable, type MetricValue } from './metricRegistry'
import { baselineFromRows, compareToBaseline } from './scorecard'

/** Stock footprint the synthetic paths run in, mm -- generous enough that every
 *  XY below stays over the plate. */
const STOCK_MIN = -30
const STOCK_MAX = 30

/** 6 mm flat cutter. */
const CUTTER: CutterSpec = { kind: 'flat', diameter: 6 }

/**
 * A flat plate filling the stock footprint with its face at z = 0 (same shape
 * as collectorTruth.test.ts's fixture): a drop anywhere over it contacts at
 * exactly 0, so the margin a sample reports IS its own z.
 */
function flatPlate(): PartMesh {
  return {
    positions: new Float32Array([
      STOCK_MIN, STOCK_MIN, 0,
      STOCK_MAX, STOCK_MIN, 0,
      STOCK_MAX, STOCK_MAX, 0,
      STOCK_MIN, STOCK_MAX, 0,
    ]),
    indices: new Uint32Array([0, 1, 2, 0, 2, 3]),
    bounds: { min: [STOCK_MIN, STOCK_MIN, 0], max: [STOCK_MAX, STOCK_MAX, 0] },
    source: 'fixture',
  }
}

/** A minimal scorecard row carrying only the one cell these tests compare. */
function rowWithLinkClearance(minLinkClearanceMm: MetricValue): ScorecardRow {
  return {
    key: 'wo1880/fixture/row',
    partId: 'wo1880-fixture-part',
    setupLabel: 'top',
    stepId: 'fixture-step',
    toolId: 'fixture-tool',
    scopeId: 'whole',
    opType: 'fixture',
    toolDiameterMm: 6,
    metrics: { minLinkClearanceMm },
    planMs: 0,
    asserts: {
      maxGougeMm: 0,
      minCutMarginMm: 0,
      stockToLeaveMm: 0,
      gougeToleranceMm: 0,
      samplesOverPart: 0,
      cutSamplesOverPart: 0,
      steepInteriorSamplesSkipped: 0,
    },
  }
}

describe('WO-1880 minLinkClearanceMm: a metric that measured nothing says so', () => {
  it('a pass whose samples are all cutting -> NaN from the collector, null-with-reason on the scorecard, never worse', async () => {
    // Two consecutive 'cut' moves and no startPoint: the first move contributes
    // only its own endpoint (cutting, since its role is 'cut'), and the second
    // is interpolated entirely along a cutting move. No sample here is a link.
    const moves: ToolpathMove[] = [
      { type: 'feed', role: 'cut', x: -10, y: 0, z: 0.5 },
      { type: 'feed', role: 'cut', x: 10, y: 0, z: 0.5 },
    ]
    const surface = await surfaceMetrics({
      mesh: flatPlate(),
      cutter: CUTTER,
      samples: samplePath(moves, 0.25),
      shrinkMm: 0.05,
    })

    expect(surface.samplesOverPart).toBeGreaterThan(0)
    expect(surface.cutSamplesOverPart).toBe(surface.samplesOverPart)
    expect(Number.isNaN(surface.minLinkClearanceMm)).toBe(true)

    const cell = linkClearanceMetric(surface.minLinkClearanceMm)
    expect(isNotApplicable(cell)).toBe(true)
    if (isNotApplicable(cell)) expect(cell.reason).toBe(NO_LINK_CLEARANCE_SAMPLE_REASON)

    // The scorecard: a baseline that ALSO declares it not applicable, for the
    // SAME reason, must compare as `n/a` -- never `worse`.
    const row = rowWithLinkClearance(cell)
    const baseline = baselineFromRows(
      'test',
      [rowWithLinkClearance(notApplicable(NO_LINK_CLEARANCE_SAMPLE_REASON))],
      'WO-1880 fixture',
      new Date().toISOString(),
    )
    const delta = compareToBaseline([row], baseline)
    const linkCell = delta.rows[0].cells.find((c) => c.metric === 'minLinkClearanceMm')
    expect(linkCell?.verdict).toBe('n/a')
    expect(delta.worse).toBe(0)
  })

  it('a pass with one non-cutting sample at 13 mm -> 13, unchanged', async () => {
    // First move is a rapid with no startPoint: it contributes exactly ONE
    // sample (its own endpoint), marked non-cutting because 'rapid' is not a
    // stock-cutting role. Every sample after it is interpolated along the
    // second, cutting move.
    const moves: ToolpathMove[] = [
      { type: 'rapid', role: 'rapid', x: -10, y: 0, z: 13 },
      { type: 'feed', role: 'cut', x: 10, y: 0, z: 0.5 },
    ]
    const surface = await surfaceMetrics({
      mesh: flatPlate(),
      cutter: CUTTER,
      samples: samplePath(moves, 0.25),
      shrinkMm: 0.05,
    })

    expect(surface.minLinkClearanceMm).toBeCloseTo(13, 6)
    const cell = linkClearanceMetric(surface.minLinkClearanceMm)
    expect(cell).toBeCloseTo(13, 6)
  })

  it('the two rows WO-1877 finding H1 named read null-with-reason in the committed full baseline, not 0', () => {
    const path = join(process.cwd(), 'src/tests/benchmark/baseline.full.json')
    const baseline = JSON.parse(readFileSync(path, 'utf-8')) as {
      rows: { key: string; metrics: Record<string, { value: number | null; reason?: string }> }[]
    }
    const namedRowKeys = [
      'stepped-boss/top/finish-3-ball/bm-ball-3/whole',
      'boss-taper-step/top/finish-3-ball/bm-ball-3/whole',
    ]
    for (const key of namedRowKeys) {
      const row = baseline.rows.find((candidate) => candidate.key === key)
      expect(row, key).toBeDefined()
      const cell = row!.metrics.minLinkClearanceMm
      expect(cell.value, `${key} minLinkClearanceMm.value`).toBeNull()
      expect(cell.reason, `${key} minLinkClearanceMm.reason`).toBe(NO_LINK_CLEARANCE_SAMPLE_REASON)
    }
  })
})
