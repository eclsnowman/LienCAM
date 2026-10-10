// GEO-1 kernel-free proof that tessellation buffers are TRANSFERABLE
// (contract rule 4 / WO acceptance #2): the transfer list names every payload
// buffer, and transferring them detaches the originals (zero-copy).
import { describe, it, expect } from 'vitest'
import { collectTransferables } from '../../geom/worker/transfer.ts'
import type { TessBuffers } from '../../geom/geom-service.ts'

function fakeTess(): TessBuffers {
  return {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    index: new Uint32Array([0, 1, 2]),
    triFace: new Uint32Array([0]),
    faceIds: ['F1:BOX:zMax'],
    edgePositions: new Float32Array([0, 0, 0, 1, 0, 0]),
    edgeOffsets: new Uint32Array([0]),
    edgeIds: ['(a∧b)'],
  }
}

describe('collectTransferables', () => {
  it('lists all six payload ArrayBuffers, deduped', () => {
    const t = fakeTess()
    const list = collectTransferables(t)
    expect(list.length).toBe(6)
    expect(list.every((b) => b instanceof ArrayBuffer)).toBe(true)
    expect(new Set(list).size).toBe(6)
    expect(list).toContain(t.position.buffer)
    expect(list).toContain(t.edgeOffsets.buffer)
  })

  it('transferring the list DETACHES the originals (proves zero-copy)', () => {
    const t = fakeTess()
    const list = collectTransferables(t)
    expect(t.position.buffer.byteLength).toBeGreaterThan(0)
    // structuredClone with a transfer list is the same mechanism postMessage /
    // Comlink.transfer use; a detached source buffer has byteLength 0.
    const clone = structuredClone(t, { transfer: list })
    // transferred data now lives in the clone; the source buffers are detached
    expect(clone.position.length).toBe(9)
    expect(t.position.buffer.byteLength).toBe(0)
    expect(t.normal.buffer.byteLength).toBe(0)
    expect(t.index.buffer.byteLength).toBe(0)
    expect(t.triFace.buffer.byteLength).toBe(0)
    expect(t.edgePositions.buffer.byteLength).toBe(0)
    expect(t.edgeOffsets.buffer.byteLength).toBe(0)
    // structured-clone-only fields survive intact
    expect(clone.faceIds).toEqual(['F1:BOX:zMax'])
    expect(clone.edgeIds).toEqual(['(a∧b)'])
  })
})
