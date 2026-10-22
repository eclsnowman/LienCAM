import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { emissionIdentityAt, expectCurrentEmission, expectEmissionReceiptSource,
  expectEquivalentEmissionSources, expectMainEmission, git,
  type EmissionReceipt, type EmissionResult } from './emissionReceipt.wo2914'

const evidence = 'src/tests/evidence/WO-2914'
// Immutable, real production captures; no synthetic program stands in for the
// application. Controls mutate one receipt field, never product or machine code.
const original = JSON.parse(readFileSync(`${evidence}/integrated-main-gcode.json`, 'utf8'))
const main: EmissionReceipt = { ...original, identity: emissionIdentityAt(original.source) }
const historical: EmissionResult = JSON.parse(readFileSync(
  'src/tests/evidence/WO-2906/paired-current-20261017/branch-gcode.json', 'utf8'))

describe('WO-2914 independently adjudicated emission receipt controls', () => {
  it('accepts real metadata-only main movement without relabeling the capture', () => {
    // A moving branch can acquire production changes; this real revision only changed metadata.
    const currentSource = git('rev-parse', 'a883c5e4b332').trim()
    expect(currentSource).not.toBe(main.source)
    expectMainEmission(main, currentSource, main.inputs, main.result)
    expect(main.source).toBe('006e37d765a4cec2893fe80bc919b638004f7d56')
  })

  it('rejects the landed parent production change against the older capture', () => {
    expect(() => expectEmissionReceiptSource(main, 'd31207b60a'))
      .toThrow('production tree changed')
  })

  it('rejects changed production source even with identical emitted receipts', () => {
    const changed = structuredClone(main.identity)
    changed.production.find(entry => entry.path === 'src/store/index.ts')!.blob = '0'.repeat(40)
    expect(() => expectEquivalentEmissionSources(main.identity, changed)).toThrow('production tree changed')
  })

  it('rejects an actual different production revision', () => {
    expect(() => expectEmissionReceiptSource(main, '4f9a67a9c7d84cd0dcbab97800d806023dca8fd5'))
      .toThrow('production tree changed')
  })

  it('rejects changed consumed-input source even when production is identical', () => {
    const changed = structuredClone(main.identity)
    changed.inputs.find(entry => entry.path.endsWith('.camproject'))!.blob = '0'.repeat(40)
    expect(() => expectEquivalentEmissionSources(main.identity, changed)).toThrow('consumed-input tree changed')
  })

  it.each(['add', 'remove'] as const)('rejects a consumed-input path %s', action => {
    const changed = structuredClone(main.identity)
    if (action === 'add') changed.inputs.push({ path: 'examples/extra.camproject', mode: '100644', blob: '0'.repeat(40) })
    else changed.inputs.pop()
    expect(() => expectEquivalentEmissionSources(main.identity, changed)).toThrow('consumed-input tree changed')
  })

  it('rejects altered source identities in the recorded receipt itself', () => {
    const changed = structuredClone(main)
    changed.identity.production[0].blob = '0'.repeat(40)
    expect(() => expectEmissionReceiptSource(changed, main.source)).toThrow()
  })

  it('rejects changed actually consumed bytes even with identical Git trees and output', () => {
    const changed = structuredClone(main.inputs)
    changed[0].sha256 = '0'.repeat(64)
    expect(() => expectMainEmission(main, main.source, changed, main.result)).toThrow('actual consumed input bytes changed')
  })

  it('rejects an omitted consumed-byte record', () => {
    expect(() => expectMainEmission(main, main.source, main.inputs.slice(1), main.result))
      .toThrow('actual consumed input bytes changed')
  })

  it('accepts the landed GOLD transition while retaining the historical 20 differences', () => {
    const preserved = JSON.stringify(historical)
    expect(historical.differences).toHaveLength(20)
    expect(main.result.differences).toEqual([])
    expectCurrentEmission(main.result, historical)
    expect(JSON.stringify(historical)).toBe(preserved)
  })

  it('rejects changed emitted bytes after the GOLD transition', () => {
    const changed = structuredClone(main.result)
    changed.files[0].sha256 = '0'.repeat(64)
    expect(() => expectCurrentEmission(changed, historical)).toThrow('every emitted byte')
  })

  it.each(['missing', 'extra'] as const)('rejects %s emitted programs', kind => {
    const changed = structuredClone(main.result)
    if (kind === 'missing') changed.files.pop()
    else changed.files.push({ ...changed.files[0], filename: 'extra.nc' })
    expect(() => expectCurrentEmission(changed, historical)).toThrow()
  })

  it('rejects a current GOLD mismatch even when emitted bytes equal history', () => {
    const changed = structuredClone(main.result)
    changed.differences = [changed.files[0].filename]
    expect(() => expectCurrentEmission(changed, historical)).toThrow('current saved GOLD must be clean')
  })

  it('rejects an unclean main control rather than inheriting its GOLD mismatch', () => {
    const changed = structuredClone(main)
    changed.result.differences = [changed.result.files[0].filename]
    expect(() => expectMainEmission(changed, main.source, main.inputs, main.result)).toThrow()
  })
})
