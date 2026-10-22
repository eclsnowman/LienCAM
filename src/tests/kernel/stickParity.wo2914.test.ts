// Explicit WO-2914 live before/after capture; opt-in only.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { planChain, scoreChain } from '../benchmark/chainRunner'
import { alpha3Chains } from '../benchmark/registry'
import { baselineFromRows, type BaselineRow } from '../benchmark/scorecard'
import { specFor } from '../benchmark/metricRegistry'
import { expiredProof, sameSource } from './productionIdentity.wo2914'
const phase = process.env.WO2914_STICK
const evidence = 'src/tests/evidence/WO-2914'
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


if (!phase) it('WO-2914 current production sticks match the inherited source', ctx => {
  const inherited = JSON.parse(readFileSync('src/tests/evidence/WO-2906/stick-after.json', 'utf8'))
  const current = JSON.parse(readFileSync(`${evidence}/stick-current.json`, 'utf8'))
  expect(current.complete).toBe(true)
  expect(current.rowCount).toBe(220)
  expect(current.moveHashes).toHaveLength(56)
  expect(current.rows).toEqual(inherited.rows)
  expect(current.moveHashes).toEqual(inherited.moveHashes)
  if (!sameSource([current.source])) return ctx.skip(expiredProof('WO-2914', 'WO2914_STICK=current'))
})
it.skipIf(!phase)('WO-2914 captures 220 production rows and per-step move hashes', async () => {
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const rows: BaselineRow[] = []
  const moveHashes: object[] = []
  for (const chain of alpha3Chains()) {
    const planned = await planChain(chain)
    moveHashes.push({ chain: chain.id, steps: planned.steps.map(step => ({
      id: step.stepId, status: step.status, count: step.moves.length, sha256: digest(step.moves),
    })) })
    const result = await scoreChain(chain, planned)
    rows.push(...baselineFromRows('alpha3', result.rows, 'WO-2914 parity', '').rows)
    console.log(`WO-2914 ${phase}: ${chain.id}; ${rows.length}/220 rows`)
  }
  const capture = { source, complete: true, rowCount: rows.length,
    rows: rows.map(row => ({ key: row.key, sha256: digest(nonTiming(row)) })), moveHashes }
  writeFileSync(`${evidence}/stick-current.json`, JSON.stringify(capture, null, 2) + '\n')
  expect(rows).toHaveLength(220)
  const inherited = JSON.parse(readFileSync('src/tests/evidence/WO-2906/stick-after.json', 'utf8'))
  expect(capture.rows).toEqual(inherited.rows)
  expect(capture.moveHashes).toEqual(inherited.moveHashes)
}, 3_600_000)
