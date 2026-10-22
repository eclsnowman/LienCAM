import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sanitizeTriangleMesh } from '../../cam3d/input/sanitize'
import { planChain, scoreChain, chainScene, type ScorecardRow } from './chainRunner'
import { alpha3Chains, rowKeysForTier } from './registry'
import { baselineFromRows, deterministicMetrics, readBaseline } from './scorecard'
import { SETTINGS_KEYS } from './settingsMetrics.alpha3'
import { COLLECTOR_KEYS } from './metrics.alpha3'

const evidence = 'src/tests/evidence/WO-2899'
const baselinePath = 'src/tests/benchmark/baseline.alpha3.json'
const source = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
function save(name: string, value: unknown) {
  if (process.env.ALPHA3_WRITE_EVIDENCE !== '1') return
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n')
}

// Focused negative control targets this assertion using the unmodified main runner.
describe('WO-2899 refusal rows', () => {
  // WO-2922: the form-cylinder default rough now generates (it entered from the side through the stock), so this row is ready.
  it('records the real form-cylinder default rough as ready M-PART-4 PASS', async () => {
    const chain = alpha3Chains().find(chain => chain.id === 'form-cylinder-default')!
    const planned = await planChain(chain)
    expect(planned.steps[0].status).toBe('ready')
    expect(planned.steps[0].operatorText).not.toContain('Nothing was generated')
    const result = await scoreChain(chain, planned)
    expect(result.rows[0].defaultProduction).toBe('PASS')
    expect(result.rows[0].metrics['M-PART-4']).toBe(1)
    expect(result.rows[0].engineId).toBe('current')
    expect(result.rows[0].operatorText).toBe(planned.steps[0].operatorText)
    // WO-3025: tool2 is the real 3 mm library flat (was bm-flat-4, n/a), so every row is measured.
    expect(result.unmeasuredTotals).toBeUndefined()
    save('form-cylinder.json', { source: source(), planned, result })
  }, 300_000)

  it('records torus, box and sphere PASS on the default starter controls', async () => {
    // WO-2922: torus default now generates (PASS); box and sphere unchanged.
    for (const [part, expected] of [['torus', 'PASS'], ['box', 'PASS'], ['sphere', 'PASS']] as const) {
      const chain = alpha3Chains().find(chain => chain.id === `form-${part}-default`)!
      const planned = await planChain(chain)
      const result = await scoreChain(chain, planned)
      save(`form-${part}.json`, { source: source(), status: result.rows[0].status,
        operatorText: result.rows[0].operatorText, moves: planned.steps[0].moves.length,
        defaultProduction: result.rows[0].defaultProduction })
      expect(result.rows[0].defaultProduction).toBe(expected)
      expect(result.rows[0].metrics['M-PART-4']).toBe(expected === 'PASS' ? 1 : 0)

    }
  }, 300_000)

  it('matches the regenerated sphere bounds to the production browser readback', async () => {
    const actual = JSON.parse(readFileSync(`${evidence}/sphere-current-result.json`, 'utf8'))
    const scene = await chainScene(alpha3Chains().find(chain => chain.id === 'form-sphere-default')!)
    const display = actual.geometry[0].modelBody.display
    console.log('[WO-2899] sphere mesh parity', JSON.stringify({
      generatedBounds: scene.mesh.bounds, browserBounds: display.bbox,
      generatedVertices: scene.mesh.positions.length, browserVertices: display.positions.length,
      generatedIndices: scene.mesh.indices.length, browserIndices: display.indices.length,
      box: scene.box,
    }))
    const clean = sanitizeTriangleMesh(Float32Array.from(display.positions), Uint32Array.from(display.indices))
    expect(Array.from(scene.mesh.positions)).toEqual(Array.from(clean.positions))
    expect(Array.from(scene.mesh.indices)).toEqual(Array.from(clean.indices))
    expect(scene.mesh.bounds.min).toEqual(Object.values(actual.geometry[0].boundingBox.min))
    expect(scene.mesh.bounds.max).toEqual(Object.values(actual.geometry[0].boundingBox.max))
  }, 120_000)

  it('matches the captured production sphere task without changing its geometry or method', async () => {
    const actual = JSON.parse(readFileSync(`${evidence}/sphere-current-result.json`, 'utf8'))
    const base = alpha3Chains().find(chain => chain.id === 'form-sphere-default')!
    const setup = actual.projectInputs.setups[0]
    const op = setup.operations[0]
    const chain = { ...base, alpha3: { material: setup.stock.material, project: actual.projectInputs },
      steps: [{ ...base.steps[0], setupLabel: 'setup1-default', authoredSetupId: setup.id,
        authoredOperation: op, params: op.params }],
    }
    const planned = await planChain(chain)
    save('captured-sphere-task.json', { source: source(), status: planned.steps[0].status,
      operatorText: planned.steps[0].operatorText, moves: planned.steps[0].moves.length })
    expect(planned.steps[0].status).toBe('ready')
  }, 300_000)

  it('drives the authored H-pocket loop picks through production', async () => {
    // WO-3025: with its island a hole the declared H-pocket plans nothing (WO-3019 item 2, owned by WO-3024).
    const chain = alpha3Chains().find(chain => chain.id === 'engagement-pocket-adaptive_clearing_2d-default')!
    const planned = await planChain(chain)
    save('planar-picks.json', { source: source(), status: planned.steps[0].status,
      operatorText: planned.steps[0].operatorText, moves: planned.steps[0].moves.length })
    expect(planned.steps[0].status).toBe('ready')
    expect(planned.steps[0].moves.length).toBeGreaterThan(0)
  }, 300_000)

  it('drives the sign text engrave picks with parent geometry height authority', async () => {
    const chain = alpha3Chains().find(chain => chain.id === 'ex05-name-sign-default')!
    const planned = await planChain(chain)
    const index = chain.steps.findIndex(step => step.type === 'engrave')
    save('engrave-picks.json', { source: source(), status: planned.steps[index].status,
      operatorText: planned.steps[index].operatorText, moves: planned.steps[index].moves.length })
    expect(planned.steps[index].status).toBe('ready')
    expect(planned.steps[index].moves.length).toBeGreaterThan(0)
  }, 300_000)

  it('spikes production mesh acquisition for the three newly driven finishing families', async () => {
    for (const type of ['waterline_3d', 'scallop_3d', 'steep_shallow_3d']) {
      const chain = alpha3Chains().find(chain => chain.steps[0].type === type && chain.id.endsWith('-declared') && !chain.alpha3?.project)!
      const planned = await planChain(chain)
      // An unsupported kernel is an explicit row outcome, never a substituted path.
      expect(planned.steps).toHaveLength(chain.steps.length)
      expect(planned.steps[0].status).toBeDefined()
      expect(planned.steps[0].status === 'ready' || Boolean(planned.steps[0].operatorText)).toBe(true)
      save(`mesh-spike-${type}.json`, { source: source(), chainId: chain.id,
        status: planned.steps[0].status, operatorText: planned.steps[0].operatorText,
        moves: planned.steps[0].moves.length })
    }
  }, 300_000)

  it('covers all sixteen families with unique keys in both parameter modes', () => {
    const chains = alpha3Chains()
    expect(new Set(chains.flatMap(chain => chain.steps.map(step => step.type))).size).toBe(16)
    const keys = rowKeysForTier('alpha3')
    expect(new Set(keys).size).toBe(keys.length)
    for (const chain of chains) {
      expect(chain.alpha3).toBeDefined()
      for (const step of chain.steps) expect(['default', 'declared']).toContain(step.parameterMode)
    }
  })

  it('verifies the committed two-pass non-timing record, reasons and baseline', () => {
    // The original full first-pass rows were lost during dispatch recovery;
    // its complete non-timing projection and the full second pass survived.
    const record = JSON.parse(readFileSync(`${evidence}/determinism.json`, 'utf8'))
    const second: { source: string; rows: ScorecardRow[] } = JSON.parse(
      readFileSync(`${evidence}/baseline-run2.json`, 'utf8'))
    const baseline = readBaseline(baselinePath)!
    expect(record.runs).toBe(2)
    expect(record.source).toMatch(/^[a-f0-9]{40}$/)
    expect(second.source).toBe(record.source)
    expect(baseline.sourceCommit).toBe(record.source)
    expect(record.rowCount).toBe(220)
    expect(record.first).toHaveLength(record.rowCount)
    expect(record.second).toHaveLength(record.rowCount)
    expect(second.rows).toHaveLength(record.rowCount)
    expect(record.second).toEqual(record.first)
    const projection = second.rows.map(row => ({
      key: row.key, engineId: row.engineId, status: row.status, operatorText: row.operatorText,
      parameterMode: row.parameterMode, defaultProduction: row.defaultProduction,
      sourceWcsOrigin: row.sourceWcsOrigin, settings: row.settings, material: row.material,
      toolRecipe: row.toolRecipe, settingsRuleIds: row.settingsRuleIds,
      metrics: deterministicMetrics(row), asserts: row.assertsMeasured === false ? undefined : row.asserts,
    }))
    // Compare the persisted JSON representation (absent optional fields omitted).
    expect(JSON.parse(JSON.stringify(projection))).toEqual(record.second)
    expect(second.rows.map(row => row.key).sort()).toEqual(rowKeysForTier('alpha3').sort())
    expect(new Set(second.rows.map(row => row.opType)).size).toBe(16)
    expect(new Set(second.rows.map(row => row.engineId))).toEqual(new Set(['current']))
    for (const row of second.rows) {
      for (const value of Object.values(row.metrics)) {
        if (typeof value !== 'number') expect(value.reason.trim().length).toBeGreaterThan(0)
      }
    }
    expect(baseline.reason.trim().length).toBeGreaterThan(0)
    // WO-2900/2902 append settings/collector measurements to the historical
    // engine capture. Compare EVERY original engine cell and its metadata;
    // the separate collector capture owns the added cells, not a new engine run.
    const addedKeys = new Set<string>([...SETTINGS_KEYS, ...COLLECTOR_KEYS])
    for (const [index, row] of baseline.rows.entries()) {
      const originalKeys = Object.keys(second.rows[index].metrics)
      expect(Object.keys(row.metrics).filter(key => !originalKeys.includes(key)).sort())
        .toEqual([...addedKeys].sort())
    }
    const engineBaseline = { ...baseline, rows: baseline.rows.map(row => {
      const { settingsMeasurement: _settings, collectorObservations: _observations, hardVerdicts: _verdicts, ...engineRow } = row
      void _settings; void _observations; void _verdicts
      return { ...engineRow, metrics: Object.fromEntries(Object.entries(row.metrics).filter(([key]) => !addedKeys.has(key))) }
    }) }
    const expected = {
      ...baselineFromRows('alpha3', second.rows, baseline.reason, baseline.generatedAt),
      sourceCommit: record.source,
    }
    const { rows: actualRows, ...actualHeader } = engineBaseline
    const { rows: expectedRows, ...expectedHeader } = expected
    expect(actualHeader).toEqual(expectedHeader)
    expect(actualRows).toHaveLength(expectedRows.length)
    for (const [index, row] of actualRows.entries()) {
      expect(row, row.key).toEqual(expectedRows[index])
    }
  })
})
