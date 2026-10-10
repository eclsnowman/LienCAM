// MSH-3 wiring / INT-IMPORT-EDIT stage 4: the HEADLESS seed builder
// (buildImportedMeshModelArchive) unit-tested against the LIVE document shapes
// -- no React, no canvas, no kernel. The STL sibling of the STEP archive test.
//
// The gate: the wrapped STL must replay as the model's editable base body on
// first mount. That means the seed archive must round-trip through the real
// loadDocumentArchive loader and carry ONE meshImport node (kind 'meshImport',
// payload { fileName, cacheKey, name }), on top of the genesis fixtures every
// workbench document is born with.

import { describe, it, expect } from 'vitest'
import { buildImportedMeshModelArchive } from '../../doc/promoteImportedMeshModel'
import { loadDocumentArchive } from '../../doc/persist'
import {
  ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID,
} from '../../doc/genesis'

describe('MSH-3 wiring: buildImportedMeshModelArchive', () => {
  it('seeds genesis + one meshImport node (fileName/cacheKey/name payload)', () => {
    const bytes = buildImportedMeshModelArchive({
      fileName: 'plate.stl', cacheKey: 'key-xyz', name: 'Plate',
    })
    const loaded = loadDocumentArchive(bytes)
    const dag = loaded.dag

    // Genesis fixtures present (Origin + XY/XZ/YZ), at the front.
    for (const id of [ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID]) {
      expect(dag.getNode(id)).toBeDefined()
    }

    // The one meshImport node, id CNV1 (nextId(dag,'CNV') in a fresh DAG; roots
    // the converted body's CNVn:face#i stable ids).
    const node = dag.getNode('CNV1')
    expect(node).toBeDefined()
    expect(node!.kind).toBe('meshImport')
    // A mesh import is a standalone body producer -- it consumes no datum.
    expect(node!.consumes).toEqual([])

    // The payload the executor's meshImport replay branch reads back.
    const payload = node!.payload as { fileName?: string; cacheKey?: string; name?: string }
    expect(payload.fileName).toBe('plate.stl')
    expect(payload.cacheKey).toBe('key-xyz')
    expect(payload.name).toBe('Plate')
  })

  it('the meshImport node sits AFTER the four genesis nodes in featureOrder()', () => {
    const bytes = buildImportedMeshModelArchive({ fileName: 'p.stl', cacheKey: 'k', name: 'P' })
    const order = loadDocumentArchive(bytes).dag.featureOrder()
    expect(order.slice(0, 4)).toEqual([
      ORIGIN_NODE_ID, BASE_PLANE_XY_NODE_ID, BASE_PLANE_XZ_NODE_ID, BASE_PLANE_YZ_NODE_ID,
    ])
    expect(order).toContain('CNV1')
    expect(order.indexOf('CNV1')).toBeGreaterThan(3)
  })
})
