// @vitest-environment jsdom
//
// 3MF export/import round trip -- DOMParser (used by import3mf) needs a browser-like global,
// hence jsdom here (unlike the rest of src/tests/mesh, which runs under plain Node).
import { describe, expect, it } from 'vitest'
import { export3mf, import3mf } from '../../components/meshlab'

function unitCube(): { positions: Float32Array; indices: Uint32Array } {
  return {
    positions: new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1]),
    indices: new Uint32Array([0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]),
  }
}

describe('3MF export/import', () => {
  it('exports non-empty bytes for a real mesh', () => {
    const cube = unitCube()
    const result = export3mf(cube)
    expect(result.bytes.byteLength).toBeGreaterThan(0)
    expect(result.triangleCount).toBe(12)
  })

  it('re-imports the exported bytes back to the same triangle/vertex counts and positions', () => {
    const cube = unitCube()
    const exported = export3mf(cube)
    const reimported = import3mf(exported.bytes)

    expect(reimported.indices.length / 3).toBe(exported.triangleCount)
    expect(reimported.positions.length / 3).toBe(cube.positions.length / 3)
    for (let i = 0; i < cube.positions.length; i++) {
      expect(reimported.positions[i]).toBeCloseTo(cube.positions[i], 5)
    }
    for (let i = 0; i < cube.indices.length; i++) {
      expect(reimported.indices[i]).toBe(cube.indices[i])
    }
  })

  it('produces a real ZIP container (PK magic bytes)', () => {
    const bytes = new Uint8Array(export3mf(unitCube()).bytes)
    expect(bytes[0]).toBe(0x50) // 'P'
    expect(bytes[1]).toBe(0x4b) // 'K'
  })

  it('throws on a non-3mf/non-zip buffer instead of silently returning an empty mesh', () => {
    const garbage = new TextEncoder().encode('not a zip file').buffer
    expect(() => import3mf(garbage)).toThrow()
  })
})
