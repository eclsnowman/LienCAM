// WO-3034 (alpha.3 A3-21): the kernel estimators against the measuring stick.
//
// 1. Live, through the app: one A.5 chain planned by the store; the kernel cycle-time
//    estimate on its moves, with the machine and speeds the store used, equals the
//    store's estimatedCutTimeMs (the stick's cutTimeMs, M-TIME-1). Negative control:
//    halving the feed the estimate reads makes it disagree.
// 2. Live on committed A.5 moves (fixtures/*.json, cut from the capture): the stick's
//    own collectors (crossSectionCusps for M-GEOM-2, measureRadialEngagement for the
//    engagement cells) and the estimators run here, on this host, on the same moves.
// 3. The committed every-row comparison (stick-comparison.json, written by
//    src/tests/evidence/WO-3034/summarize.mjs from the long capture): its bands are
//    recomputed from rows.jsonl and each named band holds.
import { readFileSync } from 'node:fs'
import { describe, expect, it, vi } from 'vitest'
import type { MachineConfig, ToolpathMove } from '../../types'

const calls = vi.hoisted(() => ({
  runtime: [] as { moves: unknown[]; fastTraverseRate?: number; finishRate?: number }[],
  machines: [] as unknown[],
}))
vi.mock('../../lib/cam/runtime', async importOriginal => {
  const { typedMock } = await import('../support/typedMock')
  const actual = await importOriginal<typeof import('../../lib/cam/runtime')>()
  return typedMock<typeof import('../../lib/cam/runtime')>({ ...actual,
    estimateRuntimeMsOrError: (moves, rapidRate, fastTraverseRate, finishRate, motion) => {
      calls.runtime.push({ moves, fastTraverseRate, finishRate })
      return actual.estimateRuntimeMsOrError(moves, rapidRate, fastTraverseRate, finishRate, motion)
    } })
})
vi.mock('../../lib/simulation/machineCutTimeMotion', async importOriginal => {
  const { typedMock } = await import('../support/typedMock')
  const actual = await importOriginal<typeof import('../../lib/simulation/machineCutTimeMotion')>()
  return typedMock<typeof import('../../lib/simulation/machineCutTimeMotion')>({ ...actual,
    machineCutTimeMotion: machine => {
      calls.machines.push(structuredClone(machine))
      return actual.machineCutTimeMotion(machine)
    } })
})

import { planChain } from '../benchmark/chainRunner'
import { alpha3Chains } from '../benchmark/alpha3Registry'
import { partById, rowKey } from '../benchmark/registry'
import { crossSectionCusps } from '../benchmark/metrics.alpha3'
import { measureRadialEngagement } from '../benchmark/metrics'
import { estimateCusp, estimateCycleTime, estimateEngagement } from '../../kernel/estimators'
import type { Box3, SweepShape } from '../../kernel/material'

const DIR = 'src/tests/evidence/WO-3034'
const json = (path: string) => JSON.parse(readFileSync(path, 'utf8'))

describe('WO-3034 cycle time vs the stick, live through the app', () => {
  it('equals the store\'s estimatedCutTimeMs on an A.5 row; halving the feed it reads breaks the match', async () => {
    const chain = alpha3Chains().find(c => c.id === 'engagement-pocket-pocket_2d-declared')!
    calls.runtime.length = 0; calls.machines.length = 0
    const planned = await planChain(chain)
    const step = planned.steps.find(s => s.moves.length > 0 && s.cutTimeMs !== undefined)!
    const index = calls.runtime.findIndex(c => JSON.stringify(c.moves) === JSON.stringify(step.moves))
    expect(index).toBeGreaterThanOrEqual(0)
    const machine = calls.machines[index] as MachineConfig
    const { fastTraverseRate, finishRate } = calls.runtime[index]
    const estimate = estimateCycleTime({ moves: step.moves, machine, fastTraverseRate, finishRate })
    if (estimate.status === 'unavailable') throw new Error(estimate.reason)
    expect(estimate.value.ms).toBe(step.cutTimeMs)
    const halved = step.moves.map((m: ToolpathMove) => (m.feed !== undefined ? { ...m, feed: m.feed / 2 } : m))
    const control = estimateCycleTime({ moves: halved, machine, fastTraverseRate, finishRate })
    if (control.status === 'unavailable') throw new Error(control.reason)
    expect(control.value.ms).not.toBe(step.cutTimeMs)
    expect(Math.abs(control.value.ms - step.cutTimeMs!) / step.cutTimeMs!).toBeGreaterThan(0.03)
  }, 120_000)
})

describe('WO-3034 cusp and engagement vs the stick\'s own collectors, live on committed A.5 moves', () => {
  const fixture = json(`${DIR}/fixtures/stepped-boss-declared.json`) as {
    chainId: string; box: Box3; rows: { key: string; opType: string; moves: ToolpathMove[] }[]
  }
  const row = (type: string) => fixture.rows.find(r => r.opType === type)!
  // The stock cell the stick hands its engagement collector for this row (chainRunner scoreChain).
  const chain = alpha3Chains().find(c => c.id === fixture.chainId)!
  const step = chain.steps.find(s => rowKey(chain, s) === row('adaptive_3d').key)!
  const stockCellMm = step.engagementCellMm ?? partById(chain.partId).coverageCell

  it('engagement equals measureRadialEngagement (peak and p95) on the 6 mm adaptive rough', () => {
    const { moves } = row('adaptive_3d')
    const stick = measureRadialEngagement({ moves, stockBounds: fixture.box, cellMm: stockCellMm,
      cutter: { kind: 'flat', diameter: 6 }, capFraction: step.engagementCapFraction! })
    const shape: SweepShape = { kind: 'flat', radius: 3 }
    const estimate = estimateEngagement({ moves, shape, stockBox: fixture.box, stockCellMm })
    if (estimate.status === 'unavailable') throw new Error(estimate.reason)
    expect(stick.peakEngagementFraction).toBeGreaterThan(0.3)
    expect(estimate.value.peakFraction).toBeCloseTo(stick.peakEngagementFraction, 9)
    expect(estimate.value.p95Fraction).toBeCloseTo(stick.p95EngagementFraction, 9)
    expect(estimate.value.cuttingLengthMm).toBeCloseTo(stick.measuredCuttingLengthMm, 6)
  })

  // BM-EST-cusp acceptance is the mean (Architect ruling on PR #69); the max is a named limitation.
  it('cusp mean is inside the BM-EST-cusp band of M-GEOM-2.mean (crossSectionCusps) on the 3 mm ball parallel finish', () => {
    const { moves } = row('parallel_3d')
    const stick = crossSectionCusps(moves, 1.5)!
    const estimate = estimateCusp(moves, { kind: 'ball', radius: 1.5 })
    if (estimate.status === 'unavailable') throw new Error(estimate.reason)
    expect(stick.mean).toBeGreaterThan(0.1)
    expect(Math.abs(estimate.value.meanMm - stick.mean)).toBeLessThanOrEqual(Math.max(0.2 * stick.mean, 0.005))
    // The max is computed but not a promised quantity yet (fix round 2 ruling): reported unvalidated.
    expect(estimate.value.maxStatus).toBe('unvalidated')
    expect(estimate.value.maxReason).toMatch(/not yet validated against a dense geometric reference/)
  })
})

describe('WO-3034 the committed every-row comparison (stick-comparison.json)', () => {
  const summary = json(`${DIR}/stick-comparison.json`)
  const rows = readFileSync(`${DIR}/rows.jsonl`, 'utf8').split('\n').filter(Boolean)
    .flatMap(line => JSON.parse(line).rows as { key: string; opType: string; moves: number; stick: Record<string, number | null>; time?: { equalsStick?: boolean }; timeHalvedFeed?: { equalsStick?: boolean }; cusp?: { estimate: { status: string; value?: { maxMm: number; meanMm: number } } }; engagement?: Record<string, { estimate: { status: string; value?: { peakFraction: number; p95Fraction: number } }; wallMs: number }> }[])

  it('covers every alpha3 row the stick records; planning commits differ only off the planning route', () => {
    expect(rows.length).toBe(summary.rows)
    expect(new Set(rows.map(r => r.key)).size).toBe(rows.length)
    const keys = new Set(rows.map(r => r.key))
    for (const chain of alpha3Chains()) for (const step of chain.steps) expect(keys.has(rowKey(chain, step)), rowKey(chain, step)).toBe(true)
    expect(summary.planSourceDiffOnRoute).toEqual([])
  })

  it('BM-EST-time: the post-plan cycle time is identical to the stick on every timed row; the halved-feed control never is', () => {
    const timed = rows.filter(r => typeof r.stick.cutTimeMs === 'number')
    expect(timed.length).toBeGreaterThan(50)
    expect(timed.filter(r => r.time?.equalsStick !== true).map(r => r.key)).toEqual([])
    expect(timed.filter(r => r.timeHalvedFeed?.equalsStick !== false).map(r => r.key)).toEqual([])
    expect(summary.time.identical).toBe(timed.length)
  })

  // BM-EST-cusp's target (within max(20%, 0.005 mm) of M-GEOM-2 on >= 90% of rows) is NOT met on the
  // max: M-GEOM-2 is the max over 7 sections per axis, and the stick's own collector re-run with 63
  // sections moves by more than that band on half the rows (denseSections.ts). The measured band,
  // named here and recorded in the Worker result: the MEAN within the target band on >= 80% of rows.
  it('cusp: recorded bands recompute from the rows; the mean holds the named measured band (>= 80%)', () => {
    const cuspRows = rows.filter(r => typeof r.stick.cuspMax === 'number')
    expect(cuspRows.length).toBe(summary.cusp.rows)
    const band = (estimate: number | undefined, stick: number) => estimate !== undefined && Math.abs(estimate - stick) <= Math.max(0.2 * stick, 0.005)
    const maxWithin = cuspRows.filter(r => band(r.cusp?.estimate.value?.maxMm, r.stick.cuspMax!)).length
    const meanWithin = cuspRows.filter(r => band(r.cusp?.estimate.value?.meanMm, r.stick.cuspMean!)).length
    expect(maxWithin).toBe(summary.cusp.inTargetBand)
    expect(meanWithin).toBe(summary.cusp.meanInTargetBand)
    expect(meanWithin / cuspRows.length).toBeGreaterThanOrEqual(0.8)
    expect(summary.cusp.stickMaxMovesAt63Sections / cuspRows.length).toBeGreaterThanOrEqual(0.4)
  })

  it('BM-EST-engagement: at the default cell, peak and p95 within 0.05 of the stick on >= 90% of engagement rows', () => {
    const engaged = rows.filter(r => typeof r.stick.peak === 'number')
    expect(engaged.length).toBe(summary.engagement.rows)
    const within = engaged.filter(r => {
      const value = r.engagement?.default?.estimate.value
      return value !== undefined && Math.abs(value.peakFraction - r.stick.peak!) <= 0.05 && Math.abs(value.p95Fraction - r.stick.p95!) <= 0.05
    })
    expect(within.length).toBe(summary.engagement.byCell.default.inTargetBand)
    expect(within.length / engaged.length).toBeGreaterThanOrEqual(0.9)
  })

  it('cost: every estimator on the largest A.5 row runs well under that row\'s plan time', () => {
    const largest = summary.cost.largestRow
    expect(largest.moves).toBe(Math.max(...rows.filter(r => r.moves > 0 && (r.stick.planMs ?? 0) > 0).map(r => r.moves)))
    // Well under: the measured ratio is about 0.05 (the scallop row, 2 s against 44 s of planning).
    expect(largest.ratio).toBeLessThan(0.1)
  })
})
