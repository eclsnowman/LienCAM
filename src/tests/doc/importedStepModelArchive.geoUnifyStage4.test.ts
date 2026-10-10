// GEO-UNIFY Stage 4 / INT-IMPORT-EDIT stage 1: the HEADLESS seed builder
// (buildImportedStepModelArchive) unit-tested against the LIVE document shapes
// -- no React, no canvas, no kernel.
//
// The gate: the wrapped STEP must replay as the model's editable base body on
// first mount. That means the seed archive must round-trip through the real
// loadDocumentArchive loader and carry ONE import node in the EXACT create-shape
// handleImportStepFileChange mints (kind 'import', payload { fileName, cacheKey,
// name }), on top of the genesis fixtures every workbench document is born with.

import { describe, it, expect } from 'vitest'
import { buildImportedStepModelArchive } from '../../doc/promoteImportedStepModel'
import { loadDocumentArchive } from '../../doc/persist'
import {
  ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID,
} from '../../doc/genesis'

describe('GEO-UNIFY Stage 4: buildImportedStepModelArchive', () => {
  it('seeds genesis + one import node in the EXACT create-shape (fileName/cacheKey/name payload)', () => {
    const bytes = buildImportedStepModelArchive({
      fileName: 'bracket.step', cacheKey: 'key-abc', name: 'Bracket',
    })
    const loaded = loadDocumentArchive(bytes)
    const dag = loaded.dag

    // Genesis fixtures present (Origin + XY/XZ/YZ), at the front.
    for (const id of [ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID]) {
      expect(dag.getNode(id)).toBeDefined()
    }

    // The one import node, id IMP1 (nextId(dag,'IMP') in a fresh DAG).
    const node = dag.getNode('IMP1')
    expect(node).toBeDefined()
    expect(node!.kind).toBe('import')
    // An import is a standalone body producer -- it consumes no datum.
    expect(node!.consumes).toEqual([])

    // The payload the executor's replay branch reads back, byte-identical to the
    // interactive import path.
    const payload = node!.payload as { fileName?: string; cacheKey?: string; name?: string }
    expect(payload.fileName).toBe('bracket.step')
    expect(payload.cacheKey).toBe('key-abc')
    expect(payload.name).toBe('Bracket')
  })

  it('the import node sits AFTER the four genesis nodes in featureOrder()', () => {
    const bytes = buildImportedStepModelArchive({ fileName: 'p.step', cacheKey: 'k', name: 'P' })
    const order = loadDocumentArchive(bytes).dag.featureOrder()
    expect(order.slice(0, 4)).toEqual([
      ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID,
    ])
    expect(order).toContain('IMP1')
    expect(order.indexOf('IMP1')).toBeGreaterThan(3)
  })
})
