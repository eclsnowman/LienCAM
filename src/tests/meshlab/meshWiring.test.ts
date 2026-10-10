import { describe, expect, it } from 'vitest'
import { cloneMesh, hollowGuardMessage, HOLLOW_TRIANGLE_GUARD, weldByPosition } from '../../components/meshlab'

function rawTriangleSoupCube(): { positions: Float32Array; indices: Uint32Array } {
  // Mirrors what importStl actually produces: 3 UNIQUE vertex slots per triangle, no sharing --
  // 12 triangles * 3 verts = 36 positions, even though the cube geometrically has only 8 corners.
  const corners = [
    [0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0],
    [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1],
  ]
  const faces = [
    [0, 2, 1], [0, 3, 2],
    [4, 5, 6], [4, 6, 7],
    [0, 1, 5], [0, 5, 4],
    [1, 2, 6], [1, 6, 5],
    [2, 3, 7], [2, 7, 6],
    [3, 0, 4], [3, 4, 7],
  ]
  const positions: number[] = []
  const indices: number[] = []
  let vertex = 0
  for (const face of faces) {
    for (const cornerIndex of face) {
      positions.push(...corners[cornerIndex])
      indices.push(vertex++)
    }
  }
  return { positions: new Float32Array(positions), indices: new Uint32Array(indices) }
}

describe('weldByPosition', () => {
  it('merges duplicated per-triangle vertices at the same position back into shared indices', () => {
    const soup = rawTriangleSoupCube()
    expect(soup.positions.length / 3).toBe(36) // 12 tris * 3, no sharing

    const welded = weldByPosition(soup)
    expect(welded.positions.length / 3).toBe(8) // the cube's real 8 corners
    expect(welded.indices.length).toBe(soup.indices.length) // triangle count unchanged
  })

  it('leaves an already-welded mesh unchanged in triangle count and vertex count', () => {
    const soup = rawTriangleSoupCube()
    const once = weldByPosition(soup)
    const twice = weldByPosition(once)
    expect(twice.positions.length).toBe(once.positions.length)
    expect(twice.indices.length).toBe(once.indices.length)
  })
})

describe('cloneMesh', () => {
  it('returns independent typed arrays with the same values', () => {
    const soup = rawTriangleSoupCube()
    const clone = cloneMesh(soup)
    expect(clone.positions).not.toBe(soup.positions)
    expect(clone.indices).not.toBe(soup.indices)
    expect(Array.from(clone.positions)).toEqual(Array.from(soup.positions))
    expect(Array.from(clone.indices)).toEqual(Array.from(soup.indices))
  })
})

describe('perf guards (BK-17a)', () => {
  it('hollowGuardMessage is null at/under the measured-safe threshold and a message above it', () => {
    expect(hollowGuardMessage(HOLLOW_TRIANGLE_GUARD)).toBeNull()
    expect(hollowGuardMessage(HOLLOW_TRIANGLE_GUARD + 1)).toMatch(/decimate/i)
  })
})
