import { expectCurrentProductionIdentity, expiredProof, sameSource } from './productionIdentity.wo2914'
// Explicit WO-2906 live before/after capture; opt-in only.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { planChain, scoreChain } from '../benchmark/chainRunner'
import { alpha3Chains } from '../benchmark/registry'
import { baselineFromRows, type BaselineRow } from '../benchmark/scorecard'
import { specFor } from '../benchmark/metricRegistry'
const phase = process.env.WO2906_PARITY
const evidence = 'src/tests/evidence/WO-2906'
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


if (!phase) it('WO-2906 recorded before/after proof covers the current production source', ctx => {
  const before = JSON.parse(readFileSync(`${evidence}/stick-before.json`, 'utf8'))
  const after = JSON.parse(readFileSync(`${evidence}/stick-after.json`, 'utf8'))
  expect(before.complete).toBe(true)
  expect(after.complete).toBe(true)
  expect(before.source).toMatch(/^[a-f0-9]{40}$/)
  expect(after.source).toMatch(/^[a-f0-9]{40}$/)
  expect(after.rowCount).toBe(220)
  expect(after.rows).toHaveLength(220)
  expect(after.moveHashes).toHaveLength(56)
  expect(after.rows).toEqual(before.rows)
  expect(after.moveHashes).toEqual(before.moveHashes)
  if (!expectCurrentProductionIdentity(after.source)) return ctx.skip(expiredProof('WO-2906', 'WO2906_PARITY=after'))
  expect(sameSource([after.source], ['src/tests/benchmark'])).toBe(true)
})
it.skipIf(!phase)('WO-2906 captures 220 production rows and per-step move hashes', async () => {
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const rows: BaselineRow[] = []
  const moveHashes: object[] = []
  for (const chain of alpha3Chains()) {
    const planned = await planChain(chain)
    moveHashes.push({ chain: chain.id, steps: planned.steps.map(step => ({
      id: step.stepId, status: step.status, count: step.moves.length, sha256: digest(step.moves),
    })) })
    const result = await scoreChain(chain, planned)
    rows.push(...baselineFromRows('alpha3', result.rows, 'WO-2906 parity', '').rows)
    console.log(`WO-2906 ${phase}: ${chain.id}; ${rows.length}/220 rows`)
  }
  const capture = { source, complete: true, rowCount: rows.length,
    rows: rows.map(row => ({ key: row.key, sha256: digest(nonTiming(row)) })), moveHashes }
  writeFileSync(`${evidence}/stick-${phase}.json`, JSON.stringify(capture, null, 2) + '\n')
  expect(rows).toHaveLength(220)
  if (phase === 'after') {
    const before = JSON.parse(readFileSync(`${evidence}/stick-before.json`, 'utf8'))
    expect(capture.rows).toEqual(before.rows)
    expect(capture.moveHashes).toEqual(before.moveHashes)
  }
}, 3_600_000)
