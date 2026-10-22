// Manual alpha3 baseline refresh; outside the landing slice, no env-gated skips.
// BENCHMARK_BASELINE_REASON='<reason>' npx vitest run --config src/tests/benchmark/collectorsCapture.vitest.config.mts
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { gzipSync, gunzipSync } from 'node:zlib'
import { expect, it } from 'vitest'
import { planChain, scoreChain, type ScorecardRow } from './chainRunner'
import { alpha3Chains } from './registry'
import { baselineFromRows, deterministicMetrics, readBaseline, writeBaseline } from './scorecard'
import { COLLECTOR_KEYS } from './metrics.alpha3'
const directory = 'src/tests/evidence/WO-2902'
const baselinePath = 'src/tests/benchmark/baseline.alpha3.json'
const save = (file: string, value: unknown) => writeFileSync(`${directory}/${file}`, JSON.stringify(value, null, 2) + '\n')
it('records deterministic collectors on production paths for every alpha3 row', async () => {
  const reason = process.env.BENCHMARK_BASELINE_REASON?.trim()
  expect(reason, 'BENCHMARK_BASELINE_REASON required').toBeTruthy()
  const source = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
  const original = readBaseline(baselinePath)!
  const rows: ScorecardRow[] = []
  const determinism: { chain: string; rows: number; digest: string }[] = []
  mkdirSync(directory, { recursive: true })
  mkdirSync(`${directory}/plans`, { recursive: true })
  const plannerHash = createHash('sha256').update(['chainRunner.ts', 'registry.ts', 'alpha3Registry.ts', 'alpha3Defaults.ts']
    .map(name => readFileSync(`src/tests/benchmark/${name}`, 'utf8')).join('\n')).digest('hex')
  for (const chain of alpha3Chains()) {
    const path = `${directory}/plans/${plannerHash.slice(0, 12)}-${chain.id}.json.gz`
    const cached = existsSync(path) ? JSON.parse(gunzipSync(readFileSync(path)).toString()) : undefined
    if (cached) {
      expect(cached.plannerHash).toBe(plannerHash)
      expect(cached.chain).toEqual(JSON.parse(JSON.stringify(chain)))
      expect(execFileSync('git', ['diff', '--name-only', cached.source, 'HEAD', '--', 'src', ':!src/tests'], { encoding: 'utf8' }).trim()).toBe('')
    }
    const planned = cached?.planned ?? await planChain(chain)
    if (!cached) writeFileSync(path, gzipSync(JSON.stringify({ source, plannerHash, chain, planned })))
    const before = JSON.stringify(planned)
    const first = await scoreChain(chain, planned)
    const second = await scoreChain(chain, planned)
    expect(JSON.stringify(planned)).toBe(before)
    const projection = (r: typeof first) => r.rows.map(row => ({ key: row.key, metrics: deterministicMetrics(row), observations: row.collectorObservations, hard: row.hardVerdicts }))
    expect(projection(second)).toEqual(projection(first))
    // Existing cells keep their original capture and values. Compare legacy
    // geometry here so an engine drift cannot be hidden by baseline refresh.
    for (const row of first.rows) {
      const old = original.rows.find(candidate => candidate.key === row.key)!
      expect(old, row.key).toBeTruthy()
      for (const key of ['moves', 'cutMoves', 'flownDistanceMm', 'cutLengthMm', 'rapidDistanceMm']) {
        const value = row.metrics[key], prior = old.metrics[key]
        if (typeof value === 'number' && prior.value !== null) expect(value, `${row.key}/${key}`).toBeCloseTo(prior.value, 5)
      }
    }
    rows.push(...first.rows)
    determinism.push({ chain: chain.id, rows: first.rows.length, digest: createHash('sha256').update(JSON.stringify(projection(first))).digest('hex') })
    save('collector-rows.partial.json', { source, rows })
    save('determinism.partial.json', { source, method: 'two independent scoreChain replays of each production-planned chain; engine determinism retained from WO-2899', chains: determinism })
    console.log(`[WO-2902] ${chain.id}: ${rows.length} rows saved`)
  }
  const fresh = baselineFromRows('alpha3', rows, reason!, new Date().toISOString())
  // Preserve every pre-existing cell including the settings observations from
  // WO-2900 (its persisted capture did not contain emitted moves).
  const baseline = { ...original, reason: reason!, generatedAt: fresh.generatedAt,
    rows: original.rows.map(old => {
      const row = fresh.rows.find(candidate => candidate.key === old.key)!
      return { ...old, metrics: { ...old.metrics, ...Object.fromEntries(COLLECTOR_KEYS.map(key => [key, row.metrics[key]])) },
        collectorObservations: row.collectorObservations, hardVerdicts: row.hardVerdicts }
    }) }
  writeBaseline(baselinePath, baseline)
  save('determinism.json', { source, rows: rows.length, families: new Set(rows.map(row => row.opType)).size, runs: 2,
    identicalNonTiming: true, method: 'two independent stock/collector replays of each production-planned chain; existing engine determinism retained from WO-2899', chains: determinism })
  save('na-by-family.json', Object.fromEntries([...new Set(rows.map(r => r.opType))].map(type => [type,
    rows.filter(r => r.opType === type).map(r => ({ key: r.key, reasons: Object.fromEntries(COLLECTOR_KEYS.flatMap(k => typeof r.metrics[k] === 'number' ? [] : [[k, r.metrics[k]]])) }))])))
}, 3_600_000)
