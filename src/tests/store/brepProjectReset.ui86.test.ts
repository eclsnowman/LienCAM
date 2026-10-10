import { afterEach, describe, expect, it } from 'vitest'
import type { BrepModelPayload } from '../../lib/cam/geometry/occt/model/types'
import {
  getBrepPayload,
  getBrepPayloadRecord,
  resetBrepProjectState,
  setBrepPayload,
} from '../../lib/cam/geometry/occt/model/modelClient'

function payload(marker: number): BrepModelPayload {
  return {
    faceCount: 1,
    edgeCount: 0,
    solidCount: 1,
    bbox: { min: [marker, 0, 0], max: [marker + 1, 1, 0] },
    mesh: {
      positions: new Float32Array([marker, 0, 0, marker + 1, 0, 0, marker, 1, 0]),
      normals: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      indices: new Uint32Array([0, 1, 2]),
      faceRanges: new Uint32Array([0, 3]),
    },
    edges: { positions: new Float32Array(0), edgeRanges: new Uint32Array(0) },
    faceTypes: new Uint8Array([0]),
  }
}

afterEach(() => { resetBrepProjectState() })

describe('UI-86 B-rep project-boundary identity reset', () => {
  it('clears a same-geoId prior payload before the incoming project attaches', () => {
    const oldPayload = payload(1)
    setBrepPayload('same-id', oldPayload, {
      displayContractVersion: 1,
      sourceSha256: '11'.repeat(32),
      tessellation: null,
    })
    expect(getBrepPayload('same-id')).toBe(oldPayload)

    resetBrepProjectState()

    expect(getBrepPayload('same-id')).toBeUndefined()
    expect(getBrepPayloadRecord('same-id')).toBeUndefined()
    const incoming = payload(20)
    setBrepPayload('same-id', incoming, {
      displayContractVersion: 1,
      sourceSha256: '22'.repeat(32),
      tessellation: { linearDeflection: 0.1, angularDeflection: 0.2 },
    })
    expect(getBrepPayloadRecord('same-id')).toMatchObject({
      sourceSha256: '22'.repeat(32), payload: incoming,
    })
  })
})
