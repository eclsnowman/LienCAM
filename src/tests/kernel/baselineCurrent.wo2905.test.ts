import { expectCurrentProductionIdentity, expiredProof, sameSource } from './productionIdentity.wo2914'
// Normal gates check the recorded live proof; WO2905_BASELINE=1 reruns the engines.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { planChain, scoreChain } from '../benchmark/chainRunner'
import { alpha3Chains } from '../benchmark/registry'
import { baselineFromRows, type BaselineRow } from '../benchmark/scorecard'
import { specFor } from '../benchmark/metricRegistry'

const enabled = process.env.WO2905_BASELINE === '1'
const evidence = 'src/tests/evidence/WO-2905'
const oldLive = JSON.parse(readFileSync('src/tests/evidence/WO-2904/baseline-current.json', 'utf8')) as {
  source: string; complete: boolean; rows: BaselineRow[]
}
const baseline = JSON.parse(readFileSync('src/tests/benchmark/baseline.alpha3.json', 'utf8')) as { rows: BaselineRow[] }
const nonTiming = (row: BaselineRow) => {
  const { planMs: _planMs, ...rest } = row
  void _planMs
  return JSON.parse(JSON.stringify({ ...rest,
    metrics: Object.fromEntries(Object.entries(row.metrics).filter(([name]) => !specFor(name).timing)),
  }))
}
// Stable object-key ordering for readable source-independent receipts.
const canonical = (value: unknown): string => JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === 'object' && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([a], [b]) => a.localeCompare(b))) : entry)
const digest = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex')

if (!enabled) it('WO-2905 recorded live proof covers 220 unchanged production rows with matching non-timing hashes', ctx => {
  const recorded = JSON.parse(readFileSync(`${evidence}/baseline-parity.json`, 'utf8')) as {
    source: string; mainControl: string; startingSource: string; complete: boolean; rowCount: number
    rows: { key: string; actualSha256: string; mainSha256: string }[]
    liveDifferences: unknown[]
  }
  expect(recorded.complete).toBe(true)
  expect(oldLive.complete).toBe(true)
  expect(recorded.source).toMatch(/^[a-f0-9]{40}$/)
  expect(recorded.mainControl).toBe(oldLive.source)
  expect(recorded.startingSource).toBe('f13bcae3257724cd33322724b29a0ffba2ca3109')
  // The evidence is historical execution, usable only while production source
  // equals the captured revision. Evidence/test/WO edits do not invalidate it.
  if (!expectCurrentProductionIdentity(recorded.source)) return ctx.skip(expiredProof('WO-2905', 'WO2905_BASELINE=1'))
  expect(sameSource([recorded.source], ['src/tests/benchmark'])).toBe(true)
  expect(sameSource([oldLive.source, recorded.startingSource],
    ['src/store/index.ts', 'src/lib/cam', 'src/cam3d', 'src/tests/benchmark'])).toBe(true)
  expect(recorded.rowCount).toBe(220)
  expect(oldLive.rows).toHaveLength(220)
  expect(new Set(oldLive.rows.map(row => row.key)).size).toBe(220)
  // Recompute the control hashes instead of trusting two matching strings in
  // the receipt. Exact array equality also rejects omitted/reordered/extra rows.
  expect(recorded.rows).toEqual(oldLive.rows.map(row => ({
    key: row.key, actualSha256: digest(nonTiming(row)), mainSha256: digest(nonTiming(row)),
  })))
  expect(recorded.liveDifferences).toEqual([])
})
else it('WO-2905 reruns 220 production rows and preserves every non-timing cell from the pinned live main control', async () => {
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  // This main control predates WO-2905; its engine, store and benchmark files
  // must still be the same as the WO's starting source. Enforce that precondition.
  expect(execFileSync('git', ['diff', oldLive.source, 'f13bcae3257724cd33322724b29a0ffba2ca3109', '--',
    'src/store/index.ts', 'src/lib/cam', 'src/cam3d', 'src/tests/benchmark'], { encoding: 'utf8' })).toBe('')
  expect(oldLive.complete).toBe(true)
  const rows: BaselineRow[] = []
  const moveHashes: object[] = []
  for (const chain of alpha3Chains()) {
    const planned = await planChain(chain)
    moveHashes.push({ chain: chain.id, steps: planned.steps.map(step => ({
      id: step.stepId, status: step.status, count: step.moves.length, sha256: digest(step.moves),
    })) })
    const result = await scoreChain(chain, planned)
    rows.push(...baselineFromRows('alpha3', result.rows, 'WO-2905 comparison only', '').rows)
    writeFileSync(`${evidence}/baseline-progress.json`, JSON.stringify({ source,
      complete: false, lastChain: chain.id, rowCount: rows.length }) + '\n')
    console.log(`WO-2905 parity: ${chain.id}; ${rows.length}/220 rows`)
  }
  const actual = rows.map(nonTiming)
  const old = oldLive.rows.map(nonTiming)
  const historical = baseline.rows.map(nonTiming)
  const differences = (expected: typeof actual) => actual.flatMap((row, index) => {
    const target = expected[index]
    if (canonical(row) === canonical(target)) return []
    return [{ key: row.key, fields: Object.keys({ ...row, ...target }).filter(name => name !== 'metrics' && canonical(row[name]) !== canonical(target?.[name])),
      metrics: Object.keys(row.metrics).flatMap(name => canonical(row.metrics[name]) === canonical(target?.metrics[name])
        ? [] : [{ name, actual: row.metrics[name], expected: target?.metrics[name] }]) }]
  })
  const liveDifferences = differences(old)
  const historicalDifferences = differences(historical)
  writeFileSync(`${evidence}/baseline-parity.json`, JSON.stringify({ source, mainControl: oldLive.source,
    startingSource: 'f13bcae3257724cd33322724b29a0ffba2ca3109', complete: true,
    rowCount: rows.length, excluded: 'planMs and metrics marked timing by metricRegistry only',
    rows: actual.map((row, index) => ({ key: row.key, actualSha256: digest(row), mainSha256: digest(old[index]) })),
    liveDifferences, historicalDifferences, moveHashes,
  }, null, 2) + '\n')
  writeFileSync(`${evidence}/baseline-progress.json`, JSON.stringify({ source, complete: true, rowCount: rows.length }) + '\n')
  expect(rows).toHaveLength(220)
  expect(actual).toEqual(old)
}, 3_600_000)
