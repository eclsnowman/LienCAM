// WO-3024 (B): adaptive planning got faster and plans exactly what it planned before.
// 1. Live oracle, any host: two recorded 3D-adaptive level requests (the knob's declared row and
//    the Form cylinder's default row, level 0) are planned with the fast ride measures and with
//    the full ones (every ride measured step by step against the whole cleared set, as before
//    WO-3024). The results must be the same bytes, and the fast run must really have skipped
//    steps. On the host the record was made on, both must also equal the engine before WO-3024.
// 2. The measuring-stick record (src/tests/evidence/WO-3024/stick-identity.json): the whole stick
//    planned before and after on one machine. Every adaptive step's moves are the same bytes and
//    the P0 rows differ in nothing but planning time. The record names the engine source it was
//    made on, so it goes stale (and this fails) when the engine changes without a new run.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { gunzipSync } from 'node:zlib'
import { beforeAll, describe, expect, it } from 'vitest'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { processFeature, RIDE_MEASURE } from '../../../lib/cam/adaptiveClearing2d/engine/processFeature'
import { alpha3Chains } from '../../benchmark/registry'

const EVIDENCE = 'src/tests/evidence/WO-3024'
const sha = (text: string | Buffer): string => createHash('sha256').update(text).digest('hex')
const host = `${platform()}-${arch()}`

interface OracleRecord { host: string; engineSource: string; requests: Record<string, string> }
interface StickRow { chain: string; stepId: string; type: string; before: { status: string; operatorText?: string; moveCount: number; movesSha: string }; after: StickRow['before'] }
interface StickRecord {
  host: string
  before: { source: string }
  after: { source: string }
  engineSha: Record<string, string>
  adaptiveRows: StickRow[]
  p0: { chains: number; rows: number; cellsCompared: number; differences: number }
}

describe('WO-3024 faster adaptive plans the same moves', () => {
  beforeAll(async () => { await ensureEngineClipperReady() })

  const oracle = JSON.parse(readFileSync(`${EVIDENCE}/oracle/old-engine.json`, 'utf8')) as OracleRecord
  for (const name of Object.keys(oracle.requests)) {
    it(`${name}: fast and full ride measures plan the same bytes`, () => {
      const { feature, params } = JSON.parse(gunzipSync(readFileSync(`${EVIDENCE}/oracle/${name}.json.gz`)).toString('utf8'))
      const warn = console.warn
      console.warn = () => {}
      let fast: string, full: string
      try {
        RIDE_MEASURE.skippedSteps = 0
        fast = JSON.stringify(processFeature(feature, params))
        expect(RIDE_MEASURE.skippedSteps, 'the fast ride measure skipped proven-safe steps').toBeGreaterThan(0)
        RIDE_MEASURE.local = false
        full = JSON.stringify(processFeature(feature, params))
      } finally {
        RIDE_MEASURE.local = true
        console.warn = warn
      }
      expect(sha(fast), 'fast measure = full measure').toBe(sha(full))
      // Host-bound: float results of the old engine were recorded on one platform only.
      if (host === oracle.host) expect(sha(fast), `same as the engine at ${oracle.engineSource}`).toBe(oracle.requests[name])
    }, 120_000)
  }

  it('the measuring stick before and after: every adaptive step identical, P0 differs only in time', () => {
    const record = JSON.parse(readFileSync(`${EVIDENCE}/stick-identity.json`, 'utf8')) as StickRecord
    for (const [file, recorded] of Object.entries(record.engineSha)) {
      expect(sha(readFileSync(file)), `the stick record was made on this ${file}`).toBe(recorded)
    }
    const adaptive = alpha3Chains().flatMap(chain => chain.steps
      .filter(step => step.type === 'adaptive_clearing_2d' || step.type === 'adaptive_3d')
      .map(step => `${chain.id} ${step.id}`))
    expect(record.adaptiveRows.map(row => `${row.chain} ${row.stepId}`).sort(), 'every adaptive step of the stick is in the record').toEqual(adaptive.sort())
    for (const row of record.adaptiveRows) {
      expect(row.after, `${row.chain} ${row.stepId} plans the same moves`).toEqual(row.before)
    }
    expect(record.p0.differences, 'P0 non-timing differences').toBe(0)
    expect(record.p0.chains).toBe(alpha3Chains().length)
  })
})
