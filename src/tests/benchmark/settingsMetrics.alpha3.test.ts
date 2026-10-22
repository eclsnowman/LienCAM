import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Tool, ToolpathMove } from '../../types'
import { COLLECTOR_KEYS, collectAlpha3 } from './metrics.alpha3'
import { ZDexelField } from '../../cam3d/stock'
import { alpha3Chains, rowKeysForTier, toolById } from './registry'
import { planChain, scoreChain, type ScorecardRow } from './chainRunner'
import { assertAlpha3RowComplete, specFor } from './metricRegistry'
import { baselineFromRows, cellsFailingLandingGate, compareToBaseline, readBaseline, writeBaseline, type Baseline } from './scorecard'
import { SETTINGS_KEYS, SETTINGS_WINDOWS, collectSettings, coneDiameter, defaultRecipeEligible, effectiveDiameter,
  inputForRow, machineViolations, matchingRules, radialFactor, replaySettings, scallopStep, validateWindows,
  type SettingsInput, type WindowRule, type WindowTable } from './settingsMetrics.alpha3'

const tool: Tool = { id: 'control', name: 'control', type: 'flat_end_mill', diameter: 10,
  fluteLength: 20, shankDiameter: 10, overallLength: 50, numberOfFlutes: 2,
  material: 'carbide', coating: 'none', notes: '', feedsAndSpeeds: { default: {
    rpm: 18000, feedRate: 1800, plungeRate: 100, depthOfCut: 1, stepover: 1,
  } } }
// Analytic collector truth only; never a product/default recipe or a machine claim.
function rule(material = '6061'): WindowRule {
  return { id: `${material}-truth-fixture`, applies_to: { material, tool_type: 'flat_end_mill', diameter_mm: [10, 10], strategy: 'peripheral', tool_family: 'analytic-tool-family', machine: 'analytic-machine', flutes: [2], coating: 'none' },
    outputs: { vc_m_min: [244, 600], hex_mm: [0.025, 0.035], ae_frac_D: [0.1, 0.2], ap_frac_D: [0.1, 2] }, adjust: {},
    source: [{ url: 'https://www.harveyperformance.com/in-the-loupe/depth-of-cut/', supports: 'Relation reference; numeric bands in this unit fixture are analytic controls, not published recipes' }],
    evaluation: { tier: 'B', applicability: 'evaluated', outcome_evidence: 'analytic unit fixture only' },
    confidence: 'locally-confirmed', confirmedGood: true }
}
const table = (...rules: WindowRule[]): WindowTable => ({ ruleset: { id: 'unit-fixtures-only', version: '0.1.0', accessed: '2026-10-17' }, rules })
const input = (extras: Partial<SettingsInput> = {}): SettingsInput => ({ material: '6061', strategy: 'peripheral', tool,
  rpm: 18000, feed: 1800, aeMm: 1, apMm: 1, toolFamily: 'analytic-tool-family', machineId: 'analytic-machine', ...extras })
const move = (x: number, y = 0, z = 0, feed = 1000): ToolpathMove => ({ type: 'feed', x, y, z, feed, role: 'cut' })
const path = 'src/tests/benchmark/baseline.alpha3.json'
const capture = JSON.parse(readFileSync('src/tests/evidence/WO-2899/baseline-run2.json', 'utf8')) as { source: string; rows: ScorecardRow[] }
function scoreCapturedRows(): ScorecardRow[] {
  return capture.rows.map(row => {
    const spec = toolById(row.toolId)
    // Unavailable synthetic fixtures retain identity but no recipe is substituted.
    const libraryTool = spec.libraryTool ?? { ...tool, id: spec.id, type: spec.type, diameter: spec.diameter,
      fluteLength: spec.fluteLengthMm, numberOfFlutes: spec.type === 'ball_end_mill' ? 2 : 3,
      feedsAndSpeeds: { default: { rpm: 12000, feedRate: Math.round(200 * spec.diameter), plungeRate: Math.round(70 * spec.diameter), depthOfCut: spec.diameter / 2, stepover: spec.diameter * 0.4 } } }
    const scored = collectSettings({ ...inputForRow(row, libraryTool), synthetic: !spec.libraryTool })
    const collectors = collectAlpha3({ planned: { stepId: row.stepId, setupId: row.setupLabel, planMs: 0, moves: [] },
      tool: libraryTool, opType: row.opType, unavailable: 'WO-2900 persisted settings capture contains no emitted moves; collectors are measured separately by WO-2902' })
    return { ...row, metrics: { ...row.metrics, ...scored.metrics, ...collectors.metrics }, settingsMeasurement: scored.measurement }
  })
}

describe('WO-2900 settings measurements', () => {
  it('applies the 0.10 D radial chip-thinning factor at the intended assertion', () => {
    expect(radialFactor(10, 1), 'ae=0.10 D must thin the chip to 0.60 fz').toBeCloseTo(0.6, 12)
  })
  it.each([[2, 0.8], [4, Math.sqrt(0.96)], [5, 1], [6, 1], [10, 1], [0, 0]])('derives the factor at ae=%s mm', (ae, expected) => {
    expect(radialFactor(10, ae)).toBeCloseTo(expected, 12)
  })
  it.each([[10, 0, 0], [10, 1, 6], [10, 5, 10], [10, 6, 10], [6, 0.3, 2 * Math.sqrt(1.71)]])('derives ball contact D=%s ap=%s', (d, ap, expected) => {
    expect(effectiveDiameter(d, ap)).toBeCloseTo(expected, 12)
  })
  it('scores bull and length-weighted engaged-cone contact, never shank diameter', () => {
    expect(effectiveDiameter(10, 0.2, 1)).toBeCloseTo(9.2, 12)
    expect(effectiveDiameter(10, 1, 1)).toBe(10)
    expect(coneDiameter(0.2, 1, 90)).toBeCloseTo(2.2, 12)
    const coneTool = { ...tool, type: 'v_bit' as const }
    const r = { ...rule(), applies_to: { ...rule().applies_to, tool_type: 'v_bit' } }
    const scored = collectSettings(input({ tool: coneTool, replay: [
      { lengthMm: 9, feed: 1800, rpm: 18000, aeMm: 1, coneBand: { tipDiameter: 0.2, depth: 1, includedAngle: 90 } },
      { lengthMm: 1, feed: 3600, rpm: 18000, aeMm: 1, coneBand: { tipDiameter: 0.2, depth: 2, includedAngle: 90 } },
    ] }), table(r))
    expect(scored.metrics['M-SET-2']).toBeCloseTo(Math.PI * 18000 / 1000 * (2.2 * 0.9 + 4.2 * 0.1), 8)
    expect(scored.metrics['M-LOAD-6']).toBe(0)
    expect(collectSettings(input({ tool: coneTool }), table(r)).metrics['M-LOAD-6']).toMatchObject({ value: null })
  })
  it('counts 26000 rpm once, 18000 zero, and resolves feed components against the actual axes', () => {
    expect(machineViolations(26000, [])).toBe(1)
    expect(machineViolations(18000, [])).toBe(0)
    expect(machineViolations(7000, [])).toBe(1)
    expect(machineViolations(18000, [move(0), move(10, 0, 0, 9500)])).toBe(1)
    expect(machineViolations(18000, [move(0), move(0, 10, 0, 9500)])).toBe(0)
    expect(machineViolations(18000, [move(0), move(10, 10, 0, 12000)])).toBe(0)
    expect(machineViolations(18000, [move(0), move(0, 0, 10, 8500)])).toBe(1)
    expect(machineViolations(18000, [move(0), { ...move(0, 0, 0, 9500), type: 'arc_cw', cx: 5, cy: 0 }])).toBe(1)
    // A short near-zero-angle arc travels almost entirely along Y, below its
    // 10000 limit; it must not be charged against X's 9000 limit.
    expect(machineViolations(18000, [move(10), { ...move(10 * Math.cos(0.1), 10 * Math.sin(0.1), 0, 9500), type: 'arc_ccw', cx: 0, cy: 0 }])).toBe(0)
    expect(collectSettings(input({ rpm: 26000, emitted: [move(0)] })).metrics['M-SET-1']).toBe(1)
  })
  it('scores programmed fz, thinned hex, speed, fractional engagement and flute reach', () => {
    const scored = collectSettings(input(), table(rule()))
    expect(scored.measurement.fzMm).toBe(0.05)
    expect(scored.metrics['M-SET-3']).toBeCloseTo(0.03, 12)
    expect(scored.metrics['M-SET-2']).toBeCloseTo(180 * Math.PI, 8)
    expect(scored.metrics['M-SET-4']).toBe(0.1)
    expect(scored.metrics['M-SET-5']).toBe(0.1)
    expect(collectSettings(input({ apMm: 21 }), table(rule())).measurement.fluteLengthExceeded).toBe(true)
    const ball = collectSettings(input({ tool: { ...tool, type: 'ball_end_mill' }, apMm: 1 }), table({ ...rule(), applies_to: { ...rule().applies_to, tool_type: 'ball_end_mill' } }))
    expect(ball.measurement.effectiveDiameterMm).toBe(6)
    expect(ball.measurement.vcMMin).toBeCloseTo(108 * Math.PI, 8)
  })
  it('weights replay by length and records calibrated floor separately from chart chip load', () => {
    const r = rule(); r.outputs.hex_floor_mm = 0.025
    const replay = [{ lengthMm: 9, feed: 1800, rpm: 18000, aeMm: 1 }, { lengthMm: 1, feed: 900, rpm: 18000, aeMm: 1 }]
    const scored = collectSettings(input({ replay }), table(r))
    expect(scored.metrics['M-LOAD-6']).toBe(0.9)
    expect(scored.measurement.replayComparisons[0].belowFloorShare).toBe(0.1)
    const bad = collectSettings(input({ replay: [...replay, { ...replay[0], feed: 0 }] }), table(r))
    expect(bad.metrics['M-LOAD-6']).toMatchObject({ value: null })
  })
  it('replays actual stock, preserving zero windows and refusing unsupported contact models', () => {
    const bounds = { minX: 0, maxX: 20, minY: 0, maxY: 10, minZ: 0, maxZ: 2 }
    const stock = ZDexelField.fromBox(bounds, 0.5)
    const before = [...stock.top]
    const emitted = [{ ...move(0, 5, 1, 1800), type: 'rapid' as const }, move(20, 5, 1, 1800)]
    // Use a matching test-side rule only at the collector boundary; the replay
    // adapter runs only when the versioned shipped table provides a hex window.
    const control = input({ material: '6061', strategy: 'published-test', tool: { ...tool, diameter: 3.175 },
      machineId: 'sienci-mill-one', toolFamily: 'mill-one-published-1-8-two-flute', emitted })
    const samples = replaySettings(control, bounds, stock, { kind: 'flat', diameter: 3.175 })
    expect(samples?.reduce((sum, s) => sum + s.lengthMm, 0)).toBeCloseTo(20, 8)
    expect([...stock.top]).toEqual(before)
    const cleared = ZDexelField.fromBox(bounds, 0.5); cleared.top.fill(0)
    const zeros = replaySettings(control, bounds, cleared, { kind: 'flat', diameter: 3.175 })
    expect(zeros).toEqual([{ lengthMm: 20, aeMm: 0, feed: 1800, rpm: 18000 }])
    expect(replaySettings({ ...control, tool: { ...control.tool, type: 'ball_end_mill' } }, bounds, stock, { kind: 'ball', diameter: 3.175 })).toBeUndefined()
  })
  it('derives finishing stepover from the declared scallop target', () => {
    expect(scallopStep(5, 0.1)).toBeCloseTo(2 * Math.sqrt(0.99), 12)
    expect(scallopStep(5, 6)).toBeUndefined()
    const step = scallopStep(5, 0.1)!
    expect(collectSettings(input({ tool: { ...tool, type: 'ball_end_mill' }, finishingStepMm: step, scallopHeightMm: 0.1 })).metrics['M-SET-6']).toBe(1)
    expect(collectSettings(input({ finishingStepMm: step, scallopHeightMm: 0.1 })).metrics['M-SET-6']).toMatchObject({ value: null })
  })
  it('validates sources, tier, windows and calibration rather than guessing missing evidence', () => {
    expect(() => validateWindows(SETTINGS_WINDOWS)).not.toThrow()
    const r = rule()
    expect(() => validateWindows(table({ ...r, source: [] }))).toThrow(/source/)
    expect(() => validateWindows(table({ ...r, evaluation: { ...r.evaluation, tier: 'D' } }))).toThrow(/tier D/)
    expect(() => validateWindows(table({ ...r, outputs: { hex_floor_mm: 0.01 }, confirmedGood: false }))).toThrow(/floor/)
    expect(() => validateWindows(table({ ...r, outputs: { hex_mm: [0.1, 0.01] } }))).toThrow(/band/)
    expect(matchingRules(input({ material: 'hardwood' }))).toEqual([])
    expect(collectSettings(input({ material: 'hardwood' })).metrics['M-SET-3']).toEqual({ value: null, reason: 'n/a: no window' })
    expect(matchingRules(input({ material: 'maple', strategy: 'published-test', tool: { ...tool, diameter: 3.175 } }))).toEqual([])
  })
  it('reports distinct acetal windows without inventing a single consensus', () => {
    const scored = collectSettings(input({ material: 'acetal', tool: { ...tool, diameter: 6.35 }, toolFamily: 'published-hard-plastic-router-bit',
      replay: [{ lengthMm: 10, aeMm: 6.35, feed: 5000, rpm: 18000 }] }))
    expect(scored.measurement.comparisons.hex).toHaveLength(2)
    expect(scored.measurement.replayComparisons.map(c => c.share)).toEqual([0, 1])
    expect(scored.metrics['M-LOAD-6']).toMatchObject({ value: null, reason: expect.stringContaining('multiple windows') })
  })
  it.each(['6061', 'maple', 'acetal'])('scores sourced rigidity calibration for %s without a universal multiplier', material => {
    const r = rule(material)
    r.adjust.rigidity = { class: 'unit-calibrated-only', ae: 0.5, ap: 0.75, fz: 0.8 }
    r.applies_to.rigidity_class = 'unit-calibrated-only'
    const scored = collectSettings(input({ material, rigidityClass: 'unit-calibrated-only', aeMm: 0.5, apMm: 0.75 }), table(r))
    expect(scored.measurement.comparisons.ae[0].band).toEqual([0.05, 0.1])
    expect(scored.measurement.comparisons.ap[0].band).toEqual([0.07500000000000001, 1.5])
    expect(scored.measurement.comparisons.hex[0].band).toEqual([0.020000000000000004, 0.028000000000000004])
    expect(matchingRules(input({ material }), table(r))).toEqual([])
  })
  it('records optional spindle curve facts and never supplies a generic power floor', () => {
    expect(collectSettings(input()).measurement.power).toMatchObject({ value: null })
    const power = collectSettings(input({ rpm: 12000, power: { ratedKw: 2, ratedRpm: 24000, source: 'unit measured-curve control', minimumFraction: 0.25 } })).measurement.power
    expect(power).toEqual({ availableKw: 1, minimumRpm: 6000, belowMinimum: false, source: 'unit measured-curve control' })
  })
  it('preserves rule/version attribution separately from confirmed default eligibility', () => {
    const r = rule()
    expect(defaultRecipeEligible(r)).toBe(true)
    expect(defaultRecipeEligible({ ...r, confidence: 'published-tested', confirmedGood: false })).toBe(false)
    expect(collectSettings(input(), table(r)).metrics['M-SET-7']).toBe(0)
    expect(collectSettings(input({ provenance: { rpm: { ruleId: r.id, version: '0.1.0' }, feed: { ruleId: r.id, version: 'wrong' } } }), table(r)).metrics['M-SET-7']).toBe(0.25)
    const candidate = collectSettings(input({ provenance: { rpm: { ruleId: r.id, version: '0.1.0' } } }), table({ ...r, confidence: 'published-tested', confirmedGood: false }))
    expect(candidate.metrics['M-SET-7']).toBe(0.25)
    expect(candidate.measurement.confirmedDefaultShare).toBe(0)
    expect(defaultRecipeEligible({ ...r, applies_to: { ...r.applies_to, machine: undefined } })).toBe(false)
    expect(SETTINGS_WINDOWS.rules.some(defaultRecipeEligible)).toBe(false)
  })
  it('uses route units, override feeds and fallback labels without changing the input', () => {
    const row = capture.rows.find(row => row.opType === 'pocket_2d' && row.status === 'ready')!
    const spec = toolById(row.toolId)
    const resolved = inputForRow(row, spec.libraryTool!)
    expect(resolved.aeMm).toBe(row.settings!.passes.stepover)
    expect(resolved.apMm).toBe(row.settings!.passes.stepdown)
    const missingFeeds = { ...tool, feedsAndSpeeds: {} }
    const fallback = collectSettings(inputForRow({ opType: 'face', material: 'MDF' }, missingFeeds))
    expect(fallback.measurement.labels).toContain('fallback feed')
    expect(fallback.measurement.programmedFeed).toBe(300)
    expect(fallback.measurement.rpm).toBeUndefined()
  })
  it('keeps synthetic tools separate and every settings score informational', () => {
    expect(collectSettings(input({ synthetic: true })).measurement.labels).toContain('synthetic tool')
    for (const metric of SETTINGS_KEYS) {
      expect(specFor(metric).informational).toBe(true)
      expect(cellsFailingLandingGate({ rows: [{ key: 'control', present: 'both', cells: [
        { metric, baseline: 1, current: 2, delta: 1, verdict: 'worse' },
        { metric, baseline: 1, current: undefined, delta: undefined, verdict: 'gone' },
      ] }], better: 0, worse: 1, unchanged: 0, changed: 0, missing: 1, notApplicable: 0 })).toEqual([])
    }
  })
  it('scores all 220 production-captured rows twice deterministically and preserves the engine baseline', () => {
    const first = scoreCapturedRows(), second = scoreCapturedRows()
    expect(second).toEqual(first)
    expect(first.map(row => row.key).sort()).toEqual(rowKeysForTier('alpha3').sort())
    expect(new Set(first.map(row => row.opType)).size).toBe(16)
    for (const row of first) {
      assertAlpha3RowComplete(row.key, row.metrics)
      for (const key of SETTINGS_KEYS) {
        const value = row.metrics[key]
        if (typeof value !== 'number') expect(value.reason.length).toBeGreaterThan(0)
        else expect(Number.isFinite(value)).toBe(true)
      }
    }
    const original = readBaseline(path)!
    const engineOnly = { ...original, rows: original.rows.map(row => {
      const { settingsMeasurement: _settings, collectorObservations: _collectors, hardVerdicts: _hard, ...engineRow } = row
      void _settings; void _collectors; void _hard
      return { ...engineRow, metrics: Object.fromEntries(Object.entries(row.metrics).filter(([key]) => !(SETTINGS_KEYS as readonly string[]).includes(key) && !(COLLECTOR_KEYS as readonly string[]).includes(key))) }
    }) }
    expect(engineOnly).toEqual({ ...baselineFromRows('alpha3', capture.rows, original.reason, original.generatedAt), sourceCommit: capture.source })
    const result: Baseline = { ...baselineFromRows('alpha3', first, original.reason, original.generatedAt), sourceCommit: capture.source }
    if (process.env.UPDATE_BENCHMARK_BASELINE === '1') {
      const reason = process.env.BENCHMARK_BASELINE_REASON?.trim()
      expect(reason, 'baseline updates require BENCHMARK_BASELINE_REASON').toBeTruthy()
      writeBaseline(path, { ...result, reason: reason!, rows: result.rows.map(row => {
        const old = original.rows.find(candidate => candidate.key === row.key)!
        return { ...row, metrics: { ...row.metrics, ...Object.fromEntries(COLLECTOR_KEYS.map(key => [key, old.metrics[key]])) },
          collectorObservations: old.collectorObservations, hardVerdicts: old.hardVerdicts }
      }) })
    } else {
      // Compare the original settings contract; new collectors have their own
      // production captures and are never replaced by this move-less fixture.
      const settingsView = (baseline: Baseline) => ({ ...baseline, rows: baseline.rows.map(row => {
        const { collectorObservations: _collectors, hardVerdicts: _hard, ...view } = row
        void _collectors; void _hard
        return { ...view, metrics: Object.fromEntries(Object.entries(view.metrics).filter(([key]) => !(COLLECTOR_KEYS as readonly string[]).includes(key))) }
      }) })
      expect(settingsView(original)).toEqual(settingsView(result))
    }
  })
  it('collects settings at the production scoring boundary without mutating moves', async () => {
    const chain = alpha3Chains().find(chain => chain.id === 'feature-block-mesh-rough-finish-default')!
    const plan = await planChain(chain)
    const snapshot = JSON.stringify(plan)
    const result = await scoreChain(chain, plan)
    expect(JSON.stringify(plan)).toBe(snapshot)
    for (const row of result.rows) {
      assertAlpha3RowComplete(row.key, row.metrics)
      expect(row.settingsMeasurement?.labels).toContain(toolById(row.toolId).libraryTool ? 'library tool' : 'synthetic tool')
      expect(SETTINGS_KEYS.every(key => key in row.metrics)).toBe(true)
    }
    expect(compareToBaseline(result.rows, baselineFromRows('alpha3', result.rows, 'control', 'control')).missing).toBe(0)
  }, 180_000)
  it('keeps the new metric keys under tests', () => {
    // WO-2900's committed branch evidence owns production/GOLD preservation.
    // Runtime tests must also work after landing, with any checkout's main ref.
    const hits = execFileSync('rg', ['-l', 'M-SET-[1-7]|M-LOAD-6', 'src'], { encoding: 'utf8' }).trim().split('\n')
    // rg prints native separators (src\tests\... on Windows); compare in POSIX form.
    expect(hits.every(file => file.trim().split('\\').join('/').startsWith('src/tests/'))).toBe(true)

  })
})
