import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { beforeAll, describe, expect, it } from 'vitest'

interface Hit { file: string; line: number; rule: string }
interface Result {
  actual: { files: number; counts: Record<string, number>; hits: Hit[] }
  permitted: Hit[]
  unexpected: [string, number][]
  missing: [string, number][]
}

// The raw scanner still reports scope blockers. Only unchanged code identifiers,
// embedded executable harnesses and shared artifact routes may remain. This is
// verification of the permitted scrub, not a claim that the slice is scan-clean.
describe('WO-2358 machine test personal-information scrub', () => {
  let result: Result
  beforeAll(() => {
    result = JSON.parse(execFileSync(process.execPath, [
      join(process.cwd(), 'src/tests/evidence/WO-2358/scrub.mjs'), 'check',
    ], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })) as Result
  }, 120_000)

  it('removes local paths, surname, private hostname, accounts, email and LAN addresses', () => {
    for (const rule of ['lien', 'c-users-path', 'd-dev-path', 'msys-d-dev-path', 'liencnc2', 'eclsnowman', 'eclien', 'email', 'rfc1918-ip']) {
      expect(result.actual.counts[`personal:${rule}`], rule).toBe(0)
    }
  })

  it('allows no owner-name attribution outside the explicitly protected code and artifact tokens', () => {
    expect(result.unexpected).toEqual([])
    expect(result.missing).toEqual([])
    expect(result.actual.hits.length).toBe(result.permitted.length)
  })
})
