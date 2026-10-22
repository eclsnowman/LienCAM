// Explicit WO-2904 parity capture. Not a directory-wide desk suite.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { planChain, scoreChain } from '../benchmark/chainRunner'
import { alpha3Chains } from '../benchmark/registry'
import { baselineFromRows, type BaselineRow } from '../benchmark/scorecard'
import { specFor } from '../benchmark/metricRegistry'

const enabled = process.env.WO2904_BASELINE === '1'
const evidence = 'src/tests/evidence/WO-2904'
const baseline = JSON.parse(readFileSync('src/tests/benchmark/baseline.alpha3.json', 'utf8')) as { rows: BaselineRow[] }
const nonTiming = (row: BaselineRow) => {
  const { planMs: _planMs, ...rest } = row
  void _planMs
  return { ...rest, metrics: Object.fromEntries(Object.entries(row.metrics).filter(([name]) => !specFor(name).timing)) }
}

describe('WO-2904 current-engine baseline parity', () => {
  it.skipIf(!enabled)('reruns all 220 production rows and compares every non-timing cell without rewriting the baseline', async () => {
    const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
    const rows: BaselineRow[] = []
    for (const chain of alpha3Chains()) {
      const result = await scoreChain(chain, await planChain(chain))
      rows.push(...baselineFromRows('alpha3', result.rows, 'WO-2904 comparison only', '').rows)
      writeFileSync(`${evidence}/baseline-current.json`, JSON.stringify({ source, chainsCompleted: chain.id,
        rows, complete: false }, null, 2) + '\n')
      console.log(`WO-2904 parity: ${chain.id}; ${rows.length}/220 rows`)
    }
    const actual = JSON.parse(JSON.stringify(rows.map(nonTiming)))
    const expected = baseline.rows.map(nonTiming)
    const differences = actual.flatMap((row: BaselineRow, index: number) =>
      JSON.stringify(row) === JSON.stringify(expected[index]) ? [] : [{ key: row.key, actual: row, expected: expected[index] }])
    writeFileSync(`${evidence}/baseline-current.json`, JSON.stringify({ source, complete: true, rows }, null, 2) + '\n')
    writeFileSync(`${evidence}/baseline-comparison.json`, JSON.stringify({ source, rowCount: rows.length,
      excluded: 'Only metrics marked timing by metricRegistry and row planMs', differences }, null, 2) + '\n')
    expect(rows).toHaveLength(220)
    // Deep equality ignores object key ordering, unlike the diagnostic above.
    expect(actual).toEqual(expected)
  }, 3_600_000)
})
