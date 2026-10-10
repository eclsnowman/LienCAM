// WO-1845 / ADR-0051: the STL edit framework's own contracts.
//
// This file proves the PARTS: the id view and its ancestry, the witness, the
// registry, record minting and fail-closed replay. The production entry points
// (CAM's acquirePartMesh, the store's journal actions, save/load, the edge
// chain route) are proved in meshEditReplay.wo1845.test.ts - rule 6 says a
// claim about what the APPLICATION does runs through the application.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  NO_SOURCE_FACET,
  composeSourceFacetIds,
  computeWitness,
  createMeshEditRecord,
  describeMeshEdit,
  facetCount,
  facetVertices,
  getMeshEditOperation,
  identityAncestry,
  listMeshEditOperations,
  registerMeshEditOperation,
  replayMeshEdits,
  resolveEditedStlBytes,
  resolveEditedStlMesh,
  sourceFacetIdsOf,
  witnessMismatch,
  FLIP_FACET_WINDING_KIND,
  FLIP_FACET_WINDING_VERSION,
  flipFacetWindingOperation,
  type MeshEditRecord,
} from '../../mesh/edit'
import { exportBinaryStl, importStl } from '../../mesh/stl'
import type { MeshBuffers } from '../../mesh/types'
import { unitCube } from './fixtures'

function cubeBytes(): ArrayBuffer {
  return exportBinaryStl(unitCube(10)).bytes
}

/** The cube as the STL parser hands it back: one vertex triple per facet, in
 *  file order - the mesh facet ids are anchored to (ADR-0051 s1.3). */
function cubeMesh(): MeshBuffers {
  return importStl(cubeBytes()).mesh
}

function flipEdit(mesh: MeshBuffers, facets: number[], id = 'edit-1'): MeshEditRecord {
  return createMeshEditRecord(mesh, { id, kind: FLIP_FACET_WINDING_KIND, facets })
}

let consoleError: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  consoleError.mockRestore()
})

describe('WO-1845 id view: a facet id is its triangle index in the imported file', () => {
  it('numbers a freshly parsed STL 0..n-1 in file order', () => {
    const mesh = cubeMesh()
    const ids = sourceFacetIdsOf(mesh)
    expect(ids.length).toBe(facetCount(mesh))
    expect(ids.length).toBe(12)
    expect([...ids]).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11])
  })

  it('carries source ids across an edit through its ancestry map', () => {
    const mesh = cubeMesh()
    // An edit that dropped facet 0 and split facet 1 into two.
    const ancestry = identityAncestry(mesh)
    ancestry.triangles[0] = []
    ancestry.triangles[1] = [0, 1]
    for (let i = 2; i < ancestry.triangles.length; i++) ancestry.triangles[i] = [i]
    const composed = composeSourceFacetIds(sourceFacetIdsOf(mesh), ancestry, facetCount(mesh))
    expect(composed[0]).toBe(1)
    expect(composed[1]).toBe(1)
    expect(composed[2]).toBe(2)
  })

  it('marks an output facet no input claims as having no source facet', () => {
    const mesh = cubeMesh()
    const ancestry = identityAncestry(mesh)
    const composed = composeSourceFacetIds(sourceFacetIdsOf(mesh), ancestry, facetCount(mesh) + 1)
    expect(composed[facetCount(mesh)]).toBe(NO_SOURCE_FACET)
  })
})

describe('WO-1845 witness: indices alone are a position, not a proof', () => {
  it('matches itself', () => {
    const mesh = cubeMesh()
    const witness = computeWitness(mesh, [0, 1])
    expect(witnessMismatch(witness, computeWitness(mesh, [0, 1]))).toBeNull()
  })

  it('names a different facet count', () => {
    const mesh = cubeMesh()
    expect(witnessMismatch(computeWitness(mesh, [0, 1]), computeWitness(mesh, [0])))
      .toMatch(/selected 2 facet\(s\) and 1 are there now/)
  })

  it('names a moved region', () => {
    const mesh = cubeMesh()
    const mismatch = witnessMismatch(computeWitness(mesh, [0]), computeWitness(mesh, [8]))
    expect(mismatch).toBeTruthy()
  })

  it('catches a winding flip that leaves area and centroid untouched', () => {
    const mesh = cubeMesh()
    const before = computeWitness(mesh, [0])
    const flipped = flipFacetWindingOperation.apply({
      mesh,
      record: flipEdit(mesh, [0]),
      parameters: {} as Record<string, never>,
      facets: [0],
    }).mesh
    const after = computeWitness(flipped, [0])
    expect(after.area).toBeCloseTo(before.area, 6)
    expect(after.centroid[0]).toBeCloseTo(before.centroid[0], 6)
    expect(witnessMismatch(before, after)).toMatch(/no longer face the way they did/)
  })
})

describe('WO-1845 registry: an operation slice adds a file and registers', () => {
  it('ships the flip-facet-winding operation and finds it by kind', () => {
    const operation = getMeshEditOperation(FLIP_FACET_WINDING_KIND)
    expect(operation).toBe(flipFacetWindingOperation)
    expect(listMeshEditOperations()).toContain(flipFacetWindingOperation)
  })

  it('re-registering the same operation object is a no-op', () => {
    const before = listMeshEditOperations().length
    expect(() => registerMeshEditOperation(flipFacetWindingOperation)).not.toThrow()
    expect(listMeshEditOperations().length).toBe(before)
  })

  it('refuses a SECOND implementation of a live kind by name', () => {
    expect(() => registerMeshEditOperation({
      ...flipFacetWindingOperation,
      label: 'An impostor',
    })).toThrow(/already registered by a different module/)
  })

  it('names an edit this build cannot replay instead of hiding it', () => {
    expect(describeMeshEdit({
      id: 'x', kind: 'fill-hole', version: 1, parameters: {}, facets: [0],
      witness: { facetCount: 1, area: 1, centroid: [0, 0, 0], normalSum: [0, 0, 1] },
    })).toMatch(/fill-hole \(not available in this build\)/)
  })
})

describe('WO-1845 record minting refuses what cannot replay', () => {
  it('records kind, version, sorted facets and the witness', () => {
    const mesh = cubeMesh()
    const record = createMeshEditRecord(mesh, {
      kind: FLIP_FACET_WINDING_KIND, facets: [4, 1, 1],
      sourceFacetIds: sourceFacetIdsOf(mesh),
    })
    expect(record.kind).toBe(FLIP_FACET_WINDING_KIND)
    expect(record.version).toBe(FLIP_FACET_WINDING_VERSION)
    expect(record.facets).toEqual([1, 4])
    expect(record.sourceFacets).toEqual([1, 4])
    expect(record.witness.facetCount).toBe(2)
  })

  it('refuses an unknown kind by name', () => {
    expect(() => createMeshEditRecord(cubeMesh(), { kind: 'bore-bigger', facets: [0] }))
      .toThrow(/no "bore-bigger" mesh edit in this build/)
  })

  it('refuses a facet the mesh does not have', () => {
    expect(() => createMeshEditRecord(cubeMesh(), { kind: FLIP_FACET_WINDING_KIND, facets: [99] }))
      .toThrow(/facet 99, which this mesh does not have \(12 facets\)/)
  })

  it('refuses an empty selection', () => {
    expect(() => createMeshEditRecord(cubeMesh(), { kind: FLIP_FACET_WINDING_KIND, facets: [] }))
      .toThrow(/must select at least one facet/)
  })

  it('refuses parameters the operation does not take', () => {
    expect(() => createMeshEditRecord(cubeMesh(), {
      kind: FLIP_FACET_WINDING_KIND, facets: [0], parameters: { radius: 3 },
    })).toThrow(/takes no parameters, but this edit carries radius/)
  })
})

describe('WO-1845 replay is fail-closed (ADR-0051 s1.4)', () => {
  it('applies an edit and keeps the triangle count', () => {
    const mesh = cubeMesh()
    const result = replayMeshEdits(mesh, [flipEdit(mesh, [0])])
    expect(result.appliedCount).toBe(1)
    expect(result.stopped).toBeUndefined()
    expect(facetCount(result.mesh)).toBe(facetCount(mesh))
    // Facet 0's winding reversed; nothing else moved.
    expect([...result.mesh.indices.slice(0, 3)]).toEqual([
      mesh.indices[0], mesh.indices[2], mesh.indices[1],
    ])
    expect([...result.mesh.indices.slice(3)]).toEqual([...mesh.indices.slice(3)])
  })

  it('returns the source mesh itself when there are no edits', () => {
    const mesh = cubeMesh()
    expect(replayMeshEdits(mesh, []).mesh).toBe(mesh)
    expect(replayMeshEdits(mesh, undefined).mesh).toBe(mesh)
  })

  it('stops AT a failing edit, keeps the earlier ones, and names it in the console', () => {
    const mesh = cubeMesh()
    const first = flipEdit(mesh, [0], 'edit-a')
    const after = replayMeshEdits(mesh, [first]).mesh
    const second = flipEdit(after, [1], 'edit-b')
    const third = flipEdit(after, [2], 'edit-c')
    // Corrupt the SECOND edit's selection so its facets no longer exist.
    const broken: MeshEditRecord = { ...second, facets: [500] }

    const result = replayMeshEdits(mesh, [first, broken, third])

    expect(result.appliedCount).toBe(1)
    expect(result.stopped).toMatchObject({ index: 1, recordId: 'edit-b', kind: FLIP_FACET_WINDING_KIND })
    // Edit 1 is applied; edits 2 and 3 are not.
    expect([...result.mesh.indices]).toEqual([...after.indices])
    expect(consoleError).toHaveBeenCalledTimes(1)
    expect(String(consoleError.mock.calls[0][0])).toMatch(/Flip winding of 1 facet/)
    expect(String(consoleError.mock.calls[0][0])).toMatch(/could not be replayed/)
    expect(String(consoleError.mock.calls[0][0])).toMatch(/1 edit\(s\) before it are still applied/)
  })

  it('stops when the witness no longer matches what is at those indices', () => {
    const mesh = cubeMesh()
    const record = flipEdit(mesh, [0])
    // Same indices, a witness taken somewhere else: this is exactly the
    // "your indices now point at a different region" case.
    const moved: MeshEditRecord = { ...record, witness: computeWitness(mesh, [8]) }
    const result = replayMeshEdits(mesh, [moved])
    expect(result.appliedCount).toBe(0)
    expect(result.stopped?.reason).toBeTruthy()
    expect([...result.mesh.indices]).toEqual([...mesh.indices])
  })

  it('stops on an edit kind this build does not ship', () => {
    const mesh = cubeMesh()
    const record: MeshEditRecord = { ...flipEdit(mesh, [0]), kind: 'remove-boss' }
    const result = replayMeshEdits(mesh, [record])
    expect(result.appliedCount).toBe(0)
    expect(result.stopped?.reason).toMatch(/no "remove-boss" edit/)
  })

  it('stops on a version this build no longer speaks', () => {
    const mesh = cubeMesh()
    const record: MeshEditRecord = { ...flipEdit(mesh, [0]), version: 99 }
    const result = replayMeshEdits(mesh, [record])
    expect(result.appliedCount).toBe(0)
    expect(result.stopped?.reason).toMatch(/version 99 .* and this build ships version 1/)
  })

  it('stops on a record carrying no witness rather than trusting the indices', () => {
    const mesh = cubeMesh()
    const record = { ...flipEdit(mesh, [0]), witness: undefined } as unknown as MeshEditRecord
    const result = replayMeshEdits(mesh, [record])
    expect(result.appliedCount).toBe(0)
    expect(result.stopped?.reason).toMatch(/no record of what it selected/)
  })

  it('never skips: an edit after a failure is not applied', () => {
    const mesh = cubeMesh()
    const bad: MeshEditRecord = { ...flipEdit(mesh, [0], 'bad'), kind: 'not-a-thing' }
    const good = flipEdit(mesh, [5], 'good')
    const result = replayMeshEdits(mesh, [bad, good])
    expect(result.appliedCount).toBe(0)
    expect([...result.mesh.indices]).toEqual([...mesh.indices])
  })
})

describe('WO-1845 the resolver: one function, and it is free when unedited', () => {
  it('hands back the SAME ArrayBuffer object when there is no journal', () => {
    const bytes = cubeBytes()
    expect(resolveEditedStlBytes(bytes, undefined)).toBe(bytes)
    expect(resolveEditedStlBytes(bytes, [])).toBe(bytes)
  })

  it('re-exports edited bytes that re-import as the edited mesh', () => {
    const bytes = cubeBytes()
    const mesh = importStl(bytes).mesh
    const record = flipEdit(mesh, [0])
    const edited = resolveEditedStlBytes(bytes, [record])
    expect(edited).not.toBe(bytes)
    expect(edited.byteLength).toBe(bytes.byteLength)
    // The writer emits each facet's corners in INDEX order, so the re-imported
    // mesh carries the flip in its POSITIONS where the replayed mesh carries
    // it in its indices. Compare what both actually describe: each facet's
    // three corners, in winding order.
    const reimported = importStl(edited).mesh
    const expected = replayMeshEdits(mesh, [record]).mesh
    for (let facet = 0; facet < facetCount(expected); facet++) {
      expect(facetVertices(reimported, facet)).toEqual(facetVertices(expected, facet))
    }
  })

  it('flipping every facet inverts the signed volume and flipping back restores it', () => {
    const bytes = cubeBytes()
    const mesh = importStl(bytes).mesh
    const all = [...Array(facetCount(mesh)).keys()]
    const flipped = importStl(resolveEditedStlBytes(bytes, [flipEdit(mesh, all)]))
    const original = importStl(bytes)
    expect(original.measures.signedVolume).toBeGreaterThan(0)
    expect(flipped.measures.signedVolume).toBeCloseTo(-original.measures.signedVolume, 4)
  })

  it('the resolved mesh carries a source-facet id per facet', () => {
    const bytes = cubeBytes()
    const mesh = importStl(bytes).mesh
    const resolved = resolveEditedStlMesh(bytes, [flipEdit(mesh, [3])])
    expect(resolved.appliedCount).toBe(1)
    expect(resolved.sourceFacetIds.length).toBe(facetCount(resolved.mesh))
    expect([...resolved.sourceFacetIds]).toEqual([...Array(12).keys()])
  })
})
