// WO MODEL-WORKSPACE-STL-EXPORT: pure helper tests for modelStlExport.ts.
//
// The merge/rebase/refusal/encode behavior is unit-tested here WITHOUT
// mounting the 10k-line SolidsWorkbenchPage -- the page only owns live-kernel
// handle resolution + re-tessellation, then hands fresh TessBuffers to
// composeWorkbenchStl/mergeTessellatedBodies (see SolidsWorkbenchPage.stlExport
// .test.tsx for the UI-level eligibility/filename/MIME/missing-handle cases).

import { describe, expect, it } from 'vitest'
import { composeWorkbenchStl, mergeTessellatedBodies, type StlBodyInput } from '../../components/model3d/modelStlExport'
import { importStl } from '../../mesh/stl'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'

function boxInput(featureId: string, center: { x: number; y: number; z: number }): StlBodyInput {
  return { featureId, tess: makeBoxTessBuffers({ featureId, center }) }
}

/** Binary STL triangle count lives at header offset 80 (little-endian uint32). */
function triangleCountOf(bytes: ArrayBuffer): number {
  return new DataView(bytes).getUint32(80, true)
}

describe('WO MODEL-WORKSPACE-STL-EXPORT: pure multi-body STL composition', () => {
  it('one body produces a parseable deterministic binary STL', () => {
    const input = boxInput('F1', { x: 0, y: 0, z: 0 })
    const a = composeWorkbenchStl([input])
    const b = composeWorkbenchStl([input])
    // deterministic: byte-identical on repeat
    expect(new Uint8Array(a.bytes)).toEqual(new Uint8Array(b.bytes))
    // a box is 12 triangles (6 faces x 2)
    expect(a.triangleCount).toBe(12)
    expect(triangleCountOf(a.bytes)).toBe(12)
    // parseable: round-trips through importStl as binary with matching counts
    const parsed = importStl(a.bytes)
    expect(parsed.format).toBe('binary')
    expect(parsed.report.triangleCount).toBe(12)
    expect(parsed.mesh.indices.length / 3).toBe(12)
  })

  it('two bodies merge with rebased indices, correct triangle count, and separated bounds', () => {
    const a = boxInput('F1', { x: 0, y: 0, z: 0 })
    const b = boxInput('F2', { x: 1000, y: 0, z: 0 })
    const aVerts = a.tess.position.length / 3
    const aTris = a.tess.index.length / 3
    const bTris = b.tess.index.length / 3

    const merged = mergeTessellatedBodies([a, b])
    // correct triangle + vertex counts (sum of both bodies)
    expect(merged.indices.length / 3).toBe(aTris + bTris)
    expect(merged.positions.length / 3).toBe(aVerts + b.tess.position.length / 3)
    // first body's indices unchanged (base 0)
    for (let i = 0; i < a.tess.index.length; i++) {
      expect(merged.indices[i]).toBe(a.tess.index[i])
    }
    // second body's indices rebased by the accumulated prior vertex count
    for (let i = 0; i < b.tess.index.length; i++) {
      expect(merged.indices[a.tess.index.length + i]).toBe(aVerts + b.tess.index[i])
    }
    // separated bounds: merged positions span BOTH boxes (x in [-20,20] and [980,1020])
    let minX = Infinity
    let maxX = -Infinity
    for (let i = 0; i < merged.positions.length; i += 3) {
      if (merged.positions[i] < minX) minX = merged.positions[i]
      if (merged.positions[i] > maxX) maxX = merged.positions[i]
    }
    expect(minX).toBe(-20)
    expect(maxX).toBe(1020)
    // encode + round-trip: both bodies present (counts sum, volume doubles)
    const out = composeWorkbenchStl([a, b])
    expect(out.triangleCount).toBe(aTris + bTris)
    expect(triangleCountOf(out.bytes)).toBe(aTris + bTris)
    const parsed = importStl(out.bytes)
    expect(parsed.report.triangleCount).toBe(aTris + bTris)
    // one box = 40x20x10 = 8000; two disjoint boxes = 16000
    expect(parsed.measures.volume).toBeCloseTo(16000, 5)
    expect(parsed.measures.bbox.min[0]).toBeCloseTo(-20, 5)
    expect(parsed.measures.bbox.max[0]).toBeCloseTo(1020, 5)
  })

  it('refuses empty input by name', () => {
    expect(() => composeWorkbenchStl([])).toThrow(/no body to export/)
  })

  it('refuses zero triangles by name', () => {
    const empty: StlBodyInput = {
      featureId: 'F1',
      tess: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), index: new Uint32Array(0) },
    }
    expect(() => composeWorkbenchStl([empty])).toThrow(/zero triangles/)
  })

  it('refuses non-finite positions by name', () => {
    const bad: StlBodyInput = {
      featureId: 'F1',
      tess: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, NaN, 0, 1]), index: new Uint32Array([0, 1, 2]) },
    }
    expect(() => composeWorkbenchStl([bad])).toThrow(/non-finite/)
  })

  it('refuses indices out of vertex range by name', () => {
    const bad: StlBodyInput = {
      featureId: 'F1',
      tess: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), index: new Uint32Array([0, 1, 5]) },
    }
    expect(() => composeWorkbenchStl([bad])).toThrow(/out of vertex range/)
  })

  it('refuses incomplete triangles (index count not divisible by 3) by name', () => {
    const bad: StlBodyInput = {
      featureId: 'F1',
      tess: { position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), index: new Uint32Array([0, 1]) },
    }
    expect(() => composeWorkbenchStl([bad])).toThrow(/not divisible by 3|incomplete triangle/)
  })

  it('does not mutate input tessellation buffers', () => {
    const input = boxInput('F1', { x: 0, y: 0, z: 0 })
    const posSnapshot = new Float32Array(input.tess.position)
    const idxSnapshot = new Uint32Array(input.tess.index)
    composeWorkbenchStl([input, boxInput('F2', { x: 100, y: 0, z: 0 })])
    expect(input.tess.position).toEqual(posSnapshot)
    expect(input.tess.index).toEqual(idxSnapshot)
  })
})
