// Opt-in original-main control for a historical baseline discrepancy.
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { expect, it } from 'vitest'
import { planChain, scoreChain } from '../benchmark/chainRunner'
import { alpha3Chains } from '../benchmark/registry'

it.skipIf(process.env.WO2904_ORACLE_CONTROL !== '1')('compares the first live production M-SET-1 cell with the historical baseline', async () => {
  const chain = alpha3Chains()[0]
  const planned = await planChain(chain)
  const scored = await scoreChain(chain, planned)
  const row = scored.rows[0]
  const baseline = JSON.parse(readFileSync('src/tests/benchmark/baseline.alpha3.json', 'utf8'))
  const expected = baseline.rows.find((candidate: { key: string }) => candidate.key === row.key).metrics['M-SET-1']
  const actual = row.metrics['M-SET-1']
  const label = process.env.WO2904_CONTROL_LABEL === 'main' ? 'main' : 'branch'
  const source = process.env.WO2904_CONTROL_SOURCE ?? execFileSync('git',
    label === 'main' ? ['merge-base', 'HEAD', 'main'] : ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  writeFileSync(`src/tests/evidence/WO-2904/oracle-${label}.json`, JSON.stringify({ source,
    sourceMethod: label === 'main' ? 'Starting main store/index.ts and generationFingerprint.ts substituted in the same worktree; kernel skeleton is unconsumed.' : 'Committed branch source',
    key: row.key, moveCount: planned.steps[0].moves.length, actual, expected }, null, 2) + '\n')
  expect(typeof actual === 'number' ? { value: actual } : actual)
    .toEqual(expected.value === null ? { value: null, reason: expected.reason } : { value: expected.value })
}, 300_000)
