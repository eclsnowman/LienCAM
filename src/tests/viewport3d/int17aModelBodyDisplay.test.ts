// INT-17A Stage 1 gate G1 (display extraction, B2a): modelBodyDisplayFromCached
// reads a body's LIVE tessellation cache entry back out as the serializable
// display payload persisted on a CAM entry. Uses a REAL GeometryCache.ingest of
// synthetic TessBuffers (not a mock) so the extraction is proven against the
// exact BufferGeometry shape the Model tab produces.

import { describe, it, expect } from 'vitest'
import { GeometryCache } from '../../viewport3d/GeometryCache'
import { modelBodyDisplayFromCached } from '../../viewport3d/modelBodyDisplay'
import type { BodyId, TessBuffers } from '../../viewport3d/types'

function tess(overrides: Partial<TessBuffers> = {}): TessBuffers {
  return {
    position: new Float32Array([0, 0, 0, 2, 0, 0, 2, 3, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    index: new Uint32Array([0, 1, 2]),
    triFace: new Uint32Array([0]),
    faceIds: ['F0'],
    edgePositions: new Float32Array([0, 0, 0, 2, 0, 0, 2, 3, 0]),
    edgeOffsets: new Uint32Array([0, 3]),
    edgeIds: ['E0'],
    ...overrides,
  }
}

describe('INT-17A modelBodyDisplayFromCached', () => {
  it('extracts positions/normals/indices/edges + a finite bbox from a real cache entry', () => {
    const cache = new GeometryCache()
    const cached = cache.ingest('b1' as BodyId, tess())
    const d = modelBodyDisplayFromCached(cached)

    expect(d.positions).toEqual([0, 0, 0, 2, 0, 0, 2, 3, 0])
    expect(d.normals).toEqual([0, 0, 1, 0, 0, 1, 0, 0, 1])
    expect(d.indices).toEqual([0, 1, 2])
    expect(d.edgePositions).toEqual([0, 0, 0, 2, 0, 0, 2, 3, 0])
    expect(d.edgeOffsets).toEqual([0, 3])
    expect(d.edgeIds).toEqual(['E0'])
    // bbox is computed from the vertices (buildBufferGeometry computes none).
    expect(d.bbox.min).toEqual([0, 0, 0])
    expect(d.bbox.max).toEqual([2, 3, 0])
    // Everything JSON-serializable (plain number arrays), so it rides in .camproject.
    expect(() => JSON.stringify(d)).not.toThrow()
    expect(Array.isArray(d.positions)).toBe(true)
  })

  it('bbox is always FINITE, even for a zero-vertex (degenerate) body', () => {
    const cache = new GeometryCache()
    const cached = cache.ingest('b2' as BodyId, tess({
      position: new Float32Array([]),
      normal: new Float32Array([]),
      index: new Uint32Array([]),
      triFace: new Uint32Array([]),
      faceIds: [],
      edgePositions: new Float32Array([]),
      edgeOffsets: new Uint32Array([0]),
      edgeIds: [],
    }))
    const d = modelBodyDisplayFromCached(cached)
    // NaN>tol is false in BOTH directions (charter rule 3) - never let Infinity
    // poison a downstream bbox reader.
    for (const v of [...d.bbox.min, ...d.bbox.max]) expect(Number.isFinite(v)).toBe(true)
    expect(d.bbox.min).toEqual([0, 0, 0])
    expect(d.bbox.max).toEqual([0, 0, 0])
  })
})
