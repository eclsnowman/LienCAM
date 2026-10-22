// WO-2870 manual before/after capture of the P0 measuring stick (one run).
// WO2870_OUT=<file> npx vitest run --config src/tests/benchmark/wo2870Compare.vitest.config.mts
import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { allRows, planChain, scoreChain } from './chainRunner'
import { alpha3Chains } from './registry'
import { deterministicMetrics } from './scorecard'

describe('WO-2870 before/after capture', () => {
  it('scores every alpha3 chain once and writes the deterministic rows', async () => {
    const out = process.env.WO2870_OUT
    expect(out, 'WO2870_OUT names the output file').toBeTruthy()
    const results = []
    for (const chain of alpha3Chains()) results.push(await scoreChain(chain, await planChain(chain)))
    const rows = allRows(results).map(row => ({
      key: row.key, opType: row.opType, status: row.status, operatorText: row.operatorText,
      metrics: deterministicMetrics(row),
    }))
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const dirty = execFileSync('git', ['status', '--porcelain', 'src/lib'], { encoding: 'utf8' }).trim()
    writeFileSync(out!, JSON.stringify({ source, dirtySrcLib: dirty, rows }, null, 2) + '\n')
  }, 3_600_000)
})
