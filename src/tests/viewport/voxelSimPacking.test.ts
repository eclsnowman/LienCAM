// Axis-order guard for packDirtySubBox (ADR-0028 partial-upload perf path).
//
// packDirtySubBox compacts an INCLUSIVE dirty voxel sub-box into a staging buffer
// in x-fastest, then-y, then-z order -- the exact (w, h, d) layout
// gl.texSubImage3D expects. A transposed axis here would silently corrupt the
// uploaded field with no other test catching it, so this is its dedicated guard.

import { describe, it, expect } from 'vitest'
import { packDirtySubBox } from '../../lib/viewport/voxelSimTexture'

describe('packDirtySubBox', () => {
  it('packs an interior sub-box in x-fastest,then-y,then-z order', () => {
    // Field 4x3x2; value at each cell == its flat index idx = iz*nx*ny + iy*nx + ix
    // so packed values are unambiguous about which source cell they came from.
    const nx = 4
    const ny = 3
    const nz = 2
    const data = new Float32Array(nx * ny * nz)
    for (let i = 0; i < data.length; i++) data[i] = i

    // Non-trivial interior box: NOT the whole field and NOT touching x0/y0/z0.
    // ix: 1..2, iy: 0..1, iz: 1..1  -> w=2, h=2, d=1
    const box = { ix0: 1, iy0: 0, iz0: 1, ix1: 2, iy1: 1, iz1: 1 }

    // Oversized staging buffer to prove only w*h*d entries are written/read.
    const out = new Float32Array(64)
    const { w, h, d } = packDirtySubBox(data, nx, ny, nz, box, out)

    expect(w).toBe(2)
    expect(h).toBe(2)
    expect(d).toBe(1)

    // Expected order: iterate iz (1), then iy (0,1), then ix (1,2).
    // idx = iz*12 + iy*4 + ix.
    //  iz=1,iy=0,ix=1 -> 13 ; ix=2 -> 14
    //  iz=1,iy=1,ix=1 -> 17 ; ix=2 -> 18
    const expected = [13, 14, 17, 18]
    expect(Array.from(out.subarray(0, w * h * d))).toEqual(expected)
  })
})
