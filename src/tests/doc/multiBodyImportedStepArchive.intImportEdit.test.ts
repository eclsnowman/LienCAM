// INT-IMPORT-EDIT stage 3 (multi-body STEP): the HEADLESS multi-body seed
// builder (buildMultiBodyImportedStepModelArchive) unit-tested against the LIVE
// document shapes -- no React, no canvas, no kernel.
//
// The gate: a multi-body STEP wrap must replay as N editable base bodies in ONE
// Model Item. That means the seed archive must round-trip through the real
// loadDocumentArchive loader and carry ONE import node PER solid (ids IMP1..IMPn),
// each in the EXACT create-shape the interactive import mints PLUS the `bodyIndex`
// the executor uses to pick bodies[i] instead of refusing the multi-body file.

import { describe, it, expect } from 'vitest'
import {
  buildImportedStepModelArchive,
  buildMultiBodyImportedStepModelArchive,
  type ImportedStepBodySeed,
} from '../../doc/promoteImportedStepModel'
import { loadDocumentArchive } from '../../doc/persist'
import {
  ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID,
} from '../../doc/genesis'

function seed(bodyIndex: number, over: Partial<ImportedStepBodySeed> = {}): ImportedStepBodySeed {
  return { fileName: 'assembly.step', cacheKey: `key-${bodyIndex}`, name: `Part (${bodyIndex + 1})`, bodyIndex, ...over }
}

describe('INT-IMPORT-EDIT stage 3: buildMultiBodyImportedStepModelArchive', () => {
  it('seeds genesis + ONE import node per solid, ids IMP1..IMPn, each carrying its bodyIndex', () => {
    const bytes = buildMultiBodyImportedStepModelArchive([
      seed(0, { cacheKey: 'k0', name: 'Assembly' }),
      seed(1, { cacheKey: 'k1', name: 'Assembly (2)' }),
      seed(2, { cacheKey: 'k2', name: 'Assembly (3)' }),
    ])
    const dag = loadDocumentArchive(bytes).dag

    // Genesis fixtures present.
    for (const id of [ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID]) {
      expect(dag.getNode(id)).toBeDefined()
    }

    // One import node per solid, ids IMP1..IMP3.
    for (let i = 0; i < 3; i++) {
      const node = dag.getNode(`IMP${i + 1}`)
      expect(node, `IMP${i + 1}`).toBeDefined()
      expect(node!.kind).toBe('import')
      expect(node!.consumes).toEqual([])
      const payload = node!.payload as { fileName?: string; cacheKey?: string; name?: string; bodyIndex?: number }
      expect(payload.fileName).toBe('assembly.step')
      expect(payload.cacheKey).toBe(`k${i}`)
      expect(payload.bodyIndex).toBe(i)  // the pick index the executor reads
    }
    // Names distinguish the solids; solid 1 keeps the base name.
    expect((dag.getNode('IMP1')!.payload as { name?: string }).name).toBe('Assembly')
    expect((dag.getNode('IMP3')!.payload as { name?: string }).name).toBe('Assembly (3)')
  })

  it('each solid gets its OWN cache key (independent byte-copy lifetimes, no shared purge)', () => {
    const bytes = buildMultiBodyImportedStepModelArchive([seed(0, { cacheKey: 'a' }), seed(1, { cacheKey: 'b' })])
    const dag = loadDocumentArchive(bytes).dag
    const k0 = (dag.getNode('IMP1')!.payload as { cacheKey?: string }).cacheKey
    const k1 = (dag.getNode('IMP2')!.payload as { cacheKey?: string }).cacheKey
    expect(k0).toBe('a')
    expect(k1).toBe('b')
    expect(k0).not.toBe(k1)
  })

  it('a single-element fanout carries a bodyIndex (0), unlike the single-body builder which omits it', () => {
    const multi = loadDocumentArchive(buildMultiBodyImportedStepModelArchive([seed(0, { cacheKey: 'x', name: 'P' })])).dag
    expect((multi.getNode('IMP1')!.payload as { bodyIndex?: number }).bodyIndex).toBe(0)

    // The original single-body builder deliberately mints NO bodyIndex, so the
    // executor keeps its one-body-only refusal for a plain STEP import.
    const single = loadDocumentArchive(buildImportedStepModelArchive({ fileName: 'p.step', cacheKey: 'x', name: 'P' })).dag
    expect((single.getNode('IMP1')!.payload as { bodyIndex?: number }).bodyIndex).toBeUndefined()
  })
})
