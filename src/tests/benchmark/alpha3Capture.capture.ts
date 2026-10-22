// Manual capture only; intentionally outside WO-2899's landing test-slice.
// ALPHA3_BASELINE=1 ALPHA3_WRITE_EVIDENCE=1 UPDATE_BENCHMARK_BASELINE=1
// BENCHMARK_BASELINE_REASON='<reason>' npx vitest run --config src/tests/benchmark/alpha3Capture.vitest.config.mts
import { execFileSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { allRows, planChain, scoreChain } from './chainRunner'
import { alpha3Chains } from './registry'
import { baselineFromRows, deterministicMetrics, readBaseline, writeBaseline } from './scorecard'

const evidence = 'src/tests/evidence/WO-2899'
const baselinePath = 'src/tests/benchmark/baseline.alpha3.json'
const source = () => execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
function save(name: string, value: unknown) {
  if (process.env.ALPHA3_WRITE_EVIDENCE !== '1') return
  mkdirSync(evidence, { recursive: true })
  writeFileSync(join(evidence, name), JSON.stringify(value, null, 2) + '\n')
}

describe('WO-2899 manual baseline capture', () => {
  it('captures two runs of one source with identical non-timing values and reasons', async () => {
    const commit = source()
    const chains = alpha3Chains()
    const run = async () => {
      const results = []
      for (const chain of chains) {
        const result = await scoreChain(chain, await planChain(chain))
        results.push(result)
        console.log(`[WO-2899] ${chain.id}: ${result.rows.map(row => row.status).join(',')}`)
      }
      return allRows(results)
    }
    const first = await run()
    save('baseline-run1.json', { source: commit, rows: first })
    const second = await run()
    save('baseline-run2.json', { source: commit, rows: second })
    const deterministic = (rows: typeof first) => rows.map(row => ({
      key: row.key, engineId: row.engineId, status: row.status, operatorText: row.operatorText,
      parameterMode: row.parameterMode, defaultProduction: row.defaultProduction,
      sourceWcsOrigin: row.sourceWcsOrigin, settings: row.settings, material: row.material, toolRecipe: row.toolRecipe, settingsRuleIds: row.settingsRuleIds,
      metrics: deterministicMetrics(row), asserts: row.assertsMeasured === false ? undefined : row.asserts,
    }))
    save('determinism.json', { source: commit, runs: 2, rowCount: first.length,
      first: deterministic(first), second: deterministic(second) })
    expect(source()).toBe(commit)
    expect(deterministic(second)).toEqual(deterministic(first))
    const summary = Object.fromEntries([...new Set(first.map(row => row.opType))].map(type => [type,
      first.filter(row => row.opType === type).map(row => ({ key: row.key, status: row.status,
        operatorText: row.operatorText, reasons: [...new Set(Object.values(row.metrics)
          .flatMap(value => typeof value === 'number' ? [] : [value.reason]))],
      })),
    ]))
    save('na-by-family.json', summary)
    if (process.env.UPDATE_BENCHMARK_BASELINE === '1') {
      const reason = process.env.BENCHMARK_BASELINE_REASON?.trim()
      expect(reason, 'baseline regeneration requires BENCHMARK_BASELINE_REASON').toBeTruthy()
      writeBaseline(baselinePath, { ...baselineFromRows('alpha3', first, reason!, new Date().toISOString()),
        sourceCommit: commit,
      } as ReturnType<typeof baselineFromRows>)
    } else {
      const baseline = readBaseline(baselinePath)
      expect(baseline?.rows.map(row => row.key)).toEqual(first.map(row => row.key))
    }
  }, 3_600_000)
})
