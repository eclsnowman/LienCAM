import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { expect } from 'vitest'

/** True when `paths` are identical between the given revisions (or a revision
 * and the working tree). `git diff --quiet` never buffers the diff itself, so a
 * long-moved source cannot overflow the child-process buffer (ENOBUFS). */
export function sameSource(revs: string[], paths: string[] = ['src', ':!src/tests']): boolean {
  const run = spawnSync('git', ['diff', '--quiet', ...revs, '--', ...paths], { encoding: 'utf8' })
  if (run.status === 0) return true
  if (run.status === 1) return false
  throw new Error(`git diff --quiet ${revs.join(' ')} failed: ${run.error?.message ?? run.stderr}`)
}

/** Skip reason when a recorded receipt cannot speak for the current source. */
export const expiredProof = (wo: string, rerun: string) =>
  `${wo} receipt predates the current production source; re-record with ${rerun}`

/** Carry historical receipts forward only through a fresh, complete production
 * equality proof. Historical rows and GOLD remain untouched. Returns false when
 * production source has moved past the newest receipt: the recorded proof has
 * expired (not failed) and only a fresh live capture can speak for it. */
export function expectCurrentProductionIdentity(recordedSource: string): boolean {
  if (sameSource([recordedSource])) return true
  const inheritedSource = '4f9a67a9c7d84cd0dcbab97800d806023dca8fd5'
  const historical = JSON.parse(readFileSync('src/tests/evidence/WO-2906/stick-after.json', 'utf8'))
  const baseline = JSON.parse(readFileSync('src/tests/evidence/WO-2905/baseline-parity.json', 'utf8'))
  const inherited = JSON.parse(readFileSync('src/tests/evidence/WO-2906/paired-current-20261017/branch-capture.json', 'utf8'))
  const current = JSON.parse(readFileSync('src/tests/evidence/WO-2914/stick-current.json', 'utf8'))
  // The original 2906 capture predates two inherited geometry-cache changes.
  // Its fresh paired capture already proved equal output on this branch base.
  // Preserve that equality chain instead of pretending the old sources match.
  expect([historical.source, baseline.source]).toContain(recordedSource)
  expect(inherited.complete).toBe(true)
  expect(inherited.rowCount).toBe(220)
  expect(inherited.rows).toHaveLength(220)
  expect(inherited.moveHashes).toHaveLength(56)
  expect(inherited.rows).toEqual(historical.rows)
  expect(inherited.moveHashes).toEqual(historical.moveHashes)
  expect(inherited.rows).toEqual(baseline.rows.map((row: { key: string; actualSha256: string }) => ({
    key: row.key, sha256: row.actualSha256,
  })))
  expect(sameSource([inherited.source, inheritedSource])).toBe(true)
  expect(current.complete).toBe(true)
  expect(current.rowCount).toBe(220)
  expect(current.rows).toHaveLength(220)
  expect(current.moveHashes).toHaveLength(56)
  expect(current.rows).toEqual(inherited.rows)
  expect(current.moveHashes).toEqual(inherited.moveHashes)
  expect(current.source).toMatch(/^[a-f0-9]{40}$/)
  return sameSource([current.source]) && sameSource([inheritedSource], ['src/tests/benchmark'])
}
