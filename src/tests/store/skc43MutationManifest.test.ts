import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface MutationRecord {
  id: string
  file: string
  namedTest: string
  preimage: string
  mutation: string
}

const manifestPath = new URL('./fixtures/skc43-mutation-manifest.json', import.meta.url)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
  mutations: MutationRecord[]
}
const repoRoot = new URL('../../../', import.meta.url)
const normalize = (value: string): string => value.replace(/\r\n?/g, '\n')

describe('SKC-43 committed mutation preimages', () => {
  it('retains one reproducible source preimage for every required mutation', () => {
    expect(manifest.mutations.map((mutation) => mutation.id)).toEqual([
      'M1-redo-no-op',
      'M2-keep-redo-after-edit',
      'M3-drop-sketch-restore',
      'M4-drop-default-prevented-guard',
      'M5-construction-button-no-op',
      'M6-static-workbench-finish-title',
      'M7-fork-workbench-glyph-toggle',
    ])
  })

  it.each(manifest.mutations)('$id: production contains the normalized preimage', (record) => {
    const source = normalize(readFileSync(new URL(record.file, repoRoot), 'utf8'))
    expect(record.namedTest.length, `${record.id} has no named test`).toBeGreaterThan(0)
    expect(source, `${record.id} preimage drifted`).toContain(normalize(record.preimage))
  })
})
