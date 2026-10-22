import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { expect } from 'vitest'

// postAll's browser entry point, example discovery, workers, assets and pinned
// dependencies. Keep GOLD in the inputs: a baseline transition needs fresh proof.
export const emissionInputs = ['examples', 'docs/machine/profiles', 'test_fixtures', 'vendor',
  'src/tests/benchmark', 'tools/examples', 'tools/lib/is-main.mjs', 'index.html', 'public',
  'package.json', 'package-lock.json']
export const git = (...args: string[]) => execFileSync('git', args, {
  encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
})
export const sha256 = (bytes: string | Buffer) => createHash('sha256').update(bytes).digest('hex')
type TreeEntry = { path: string; mode: string; blob: string }
export type EmissionIdentity = { production: TreeEntry[]; inputs: TreeEntry[] }
export type InputHash = { path: string; sha256: string }
export type EmissionResult = {
  files: { filename: string; operations: number; bytes: number; sha256: string }[]
  differences: string[]
}
export type EmissionReceipt = {
  source: string; identity: EmissionIdentity; inputs: InputHash[]; result: EmissionResult
}

export function emissionIdentityAt(source: string): EmissionIdentity {
  const entries = git('ls-tree', '-rz', '--full-tree', source, '--', 'src', ...emissionInputs)
    .split('\0').filter(Boolean).map(line => {
      const [metadata, path] = line.split('\t')
      const [mode, , blob] = metadata.split(' ')
      return { path, mode, blob }
    }).sort((a, b) => a.path.localeCompare(b.path))
  return {
    production: entries.filter(entry => entry.path.startsWith('src/') && !entry.path.startsWith('src/tests/')),
    inputs: entries.filter(entry => !entry.path.startsWith('src/') || entry.path.startsWith('src/tests/benchmark/')),
  }
}

export function emissionInputHashes(): InputHash[] {
  return git('ls-files', '-z', '--', ...emissionInputs).split('\0').filter(Boolean).sort()
    .map(path => ({ path, sha256: sha256(readFileSync(path)) }))
}

export function expectEquivalentEmissionSources(recorded: EmissionIdentity, current: EmissionIdentity): void {
  expect(current.production, 'recorded main production tree changed').toEqual(recorded.production)
  expect(current.inputs, 'recorded main consumed-input tree changed').toEqual(recorded.inputs)
}

export function expectEmissionReceiptSource(receipt: EmissionReceipt, currentSource: string): void {
  expect(receipt.source).toMatch(/^[a-f0-9]{40}$/)
  // Never accept an edited receipt digest or relabel its original source.
  expect(receipt.identity).toEqual(emissionIdentityAt(receipt.source))
  expectEquivalentEmissionSources(receipt.identity, emissionIdentityAt(currentSource))
}

export function expectEmissionCheckout(source: string): void {
  expect(git('diff', source, '--', 'src', ':!src/tests')).toBe('')
  expect(git('diff', source, '--', ...emissionInputs)).toBe('')
  expect(git('ls-files', '--others', '--exclude-standard', '--', 'src', ':!src/tests')).toBe('')
  expect(git('ls-files', '--others', '--exclude-standard', '--', ...emissionInputs)).toBe('')
}

export function expectCurrentEmission(current: EmissionResult, historical: EmissionResult): void {
  expect(current.files).toHaveLength(45)
  expect(current.files, 'every emitted byte must retain its inherited hash').toEqual(historical.files)
  // Historical differences describe old GOLD, not today's approved baseline.
  // postAll(check:true) must measure a clean current GOLD on every live capture.
  expect(current.differences, 'current saved GOLD must be clean').toEqual([])
}

export function expectMainEmission(receipt: EmissionReceipt, currentSource: string,
  inputs: InputHash[], result: EmissionResult): void {
  expectEmissionReceiptSource(receipt, currentSource)
  expect(inputs, 'actual consumed input bytes changed since main capture').toEqual(receipt.inputs)
  expectCurrentEmission(result, receipt.result)
  expect(receipt.result.differences).toEqual([])
}
