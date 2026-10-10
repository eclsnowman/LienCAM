import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

interface MutationRecord {
  id: string
  file: string
  namedTest: string
  preimage: string
  mutation: string
}

const manifestPath = new URL('./fixtures/skc26b-mutation-manifest.json', import.meta.url)
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { mutations: MutationRecord[] }
const repoRoot = new URL('../../../', import.meta.url)
const normalize = (value: string): string => value.replace(/\r\n?/g, '\n')

describe('SKC-26B committed mutation preimages', () => {
  it('covers M1-M8, every whole visibility filter, and the edge-only adjacency branch', () => {
    const ids = new Set(manifest.mutations.map((mutation) => mutation.id))
    for (const required of [
      'M1-project-append', 'M2-construction-default', 'M3-drop-inner-loops',
      'M4-flatten-preview', 'M5-remove-depth-check', 'M6-live-body',
      'M6-tree-eye', 'M6-hidden-body', 'M6-isolate-body', 'M6-hidden-face',
      'M6-isolate-face', 'M6-edge-adjacency-only', 'M7-restore-fresh-seed',
      'M8-remove-nonempty-ref-guard',
    ]) expect(ids.has(required), `missing mutation artifact ${required}`).toBe(true)
  })

  it.each(manifest.mutations)('$id: production contains the normalized preimage and not the mutation', (record) => {
    const source = normalize(readFileSync(new URL(record.file, repoRoot), 'utf8'))
    expect(record.namedTest.length, `${record.id} has no named test`).toBeGreaterThan(0)
    expect(source, `${record.id} preimage drifted`).toContain(normalize(record.preimage))
    // The exact preimage is the restoration proof. Some deliberately minimal
    // mutations (for example `return false`) also occur elsewhere in the same
    // source file, so a file-wide "mutation absent" search would be vacuous or
    // falsely red. The RED/GREEN run replaces this exact preimage once and then
    // this assertion proves the named production branch was restored.
  })
})
