import { describe, expect, it } from 'vitest'
import { buildBufferGeometry, buildEdgeLineGeometry, validateTessBuffers } from '../../viewport3d/tessGeometry'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'
import type { TessBuffers } from '../../geom/geom-service'

describe('validateTessBuffers', () => {
  it('accepts a well-formed fixture', () => {
    expect(() => validateTessBuffers(makeBoxTessBuffers())).not.toThrow()
  })

  it('rejects position length not divisible by 3', () => {
    const tess = makeBoxTessBuffers()
    const bad: TessBuffers = { ...tess, position: tess.position.slice(0, tess.position.length - 1) }
    expect(() => validateTessBuffers(bad)).toThrow(/xyz triples/)
  })

  it('rejects a normal array of mismatched length', () => {
    const tess = makeBoxTessBuffers()
    const bad: TessBuffers = { ...tess, normal: new Float32Array(3) }
    expect(() => validateTessBuffers(bad)).toThrow(/normal length/)
  })

  it('rejects an out-of-range index value', () => {
    const tess = makeBoxTessBuffers()
    const index = tess.index.slice()
    index[0] = 999999
    expect(() => validateTessBuffers({ ...tess, index })).toThrow(/out of range/)
  })

  it('rejects a triFace length mismatched with triangle count', () => {
    const tess = makeBoxTessBuffers()
    const bad: TessBuffers = { ...tess, triFace: tess.triFace.slice(0, tess.triFace.length - 1) }
    expect(() => validateTessBuffers(bad)).toThrow(/triFace length/)
  })

  it('rejects a triFace value outside faceIds range', () => {
    const tess = makeBoxTessBuffers()
    const triFace = tess.triFace.slice()
    triFace[0] = 999
    expect(() => validateTessBuffers({ ...tess, triFace })).toThrow(/faceIds/)
  })

  it('rejects edgeOffsets whose length is not edgeIds.length + 1', () => {
    const tess = makeBoxTessBuffers()
    const bad: TessBuffers = { ...tess, edgeOffsets: tess.edgeOffsets.slice(0, tess.edgeOffsets.length - 1) }
    expect(() => validateTessBuffers(bad)).toThrow(/edgeOffsets length/)
  })

  it('rejects non-monotonic edgeOffsets', () => {
    const tess = makeBoxTessBuffers()
    const edgeOffsets = tess.edgeOffsets.slice()
    edgeOffsets[2] = edgeOffsets[1] - 1
    expect(() => validateTessBuffers({ ...tess, edgeOffsets })).toThrow(/monotonic/)
  })

  it('rejects edgeClasses that extend past edgeIds', () => {
    const tess = makeBoxTessBuffers()
    const edgeClasses = Array.from({ length: tess.edgeIds.length + 1 }, () => 'regular' as const)
    expect(() => validateTessBuffers({ ...tess, edgeClasses })).toThrow(/edgeClasses length/)
  })

  it('accepts a shorter optional classification prefix for adapting legacy producers', () => {
    const tess = makeBoxTessBuffers()
    expect(() => validateTessBuffers({ ...tess, edgeClasses: ['regular'] })).not.toThrow()
  })

  it('accepts an edgeless body (zero edges)', () => {
    const tess = makeBoxTessBuffers()
    const empty: TessBuffers = {
      ...tess,
      edgePositions: new Float32Array(0),
      edgeOffsets: new Uint32Array([0]),
      edgeIds: [],
    }
    expect(() => validateTessBuffers(empty)).not.toThrow()
  })
})

describe('buildBufferGeometry', () => {
  it('wires position/normal/index attributes with the right shape, zero-copy', () => {
    const tess = makeBoxTessBuffers()
    const geometry = buildBufferGeometry(tess)
    const position = geometry.getAttribute('position')
    const normal = geometry.getAttribute('normal')
    const index = geometry.getIndex()

    expect(position.itemSize).toBe(3)
    expect(normal.itemSize).toBe(3)
    expect(position.count).toBe(tess.position.length / 3)
    expect(normal.count).toBe(tess.normal.length / 3)
    expect(index).not.toBeNull()
    expect(index!.count).toBe(tess.index.length)

    // Zero-copy: same underlying TypedArray instance, not a clone.
    expect(position.array).toBe(tess.position)
    expect(normal.array).toBe(tess.normal)
    expect(index!.array).toBe(tess.index)

    geometry.dispose()
  })
})

describe('buildEdgeLineGeometry', () => {
  it('produces 2 points per straight box edge (12 edges -> 24 verts)', () => {
    const tess = makeBoxTessBuffers()
    const geometry = buildEdgeLineGeometry(tess)
    const position = geometry.getAttribute('position')
    expect(position.count).toBe(tess.edgeIds.length * 2)
    geometry.dispose()
  })

  it('does not bleed a segment across the boundary between two edges', () => {
    // Two 2-point edges back to back: [A,B] then [C,D]. A naive flat-dump
    // reading of edgePositions would pair (B,C) into a spurious segment;
    // edgeOffsets must keep them apart.
    const tess: TessBuffers = {
      position: new Float32Array(0),
      normal: new Float32Array(0),
      index: new Uint32Array(0),
      triFace: new Uint32Array(0),
      faceIds: [],
      edgePositions: new Float32Array([
        0, 0, 0, /* A */ 1, 0, 0, /* B */
        10, 0, 0, /* C */ 11, 0, 0, /* D */
      ]),
      edgeOffsets: new Uint32Array([0, 2, 4]),
      edgeIds: ['e0', 'e1'],
    }
    const geometry = buildEdgeLineGeometry(tess)
    const arr = geometry.getAttribute('position').array as Float32Array
    // Exactly 2 segments (4 points): (A,B) and (C,D), never (B,C).
    expect(arr.length).toBe(12)
    expect([...arr.slice(0, 3)]).toEqual([0, 0, 0])
    expect([...arr.slice(3, 6)]).toEqual([1, 0, 0])
    expect([...arr.slice(6, 9)]).toEqual([10, 0, 0])
    expect([...arr.slice(9, 12)]).toEqual([11, 0, 0])
    geometry.dispose()
  })

  it('handles a curved edge with more than 2 polyline points', () => {
    const tess: TessBuffers = {
      position: new Float32Array(0),
      normal: new Float32Array(0),
      index: new Uint32Array(0),
      triFace: new Uint32Array(0),
      faceIds: [],
      edgePositions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0, 3, 0, 0]),
      edgeOffsets: new Uint32Array([0, 4]),
      edgeIds: ['curve0'],
    }
    const geometry = buildEdgeLineGeometry(tess)
    // 4 points -> 3 consecutive segments -> 6 verts.
    expect(geometry.getAttribute('position').count).toBe(6)
    geometry.dispose()
  })

  it('collapses only seam segments without shifting later edge slots', () => {
    const tess: TessBuffers = {
      position: new Float32Array(0),
      normal: new Float32Array(0),
      index: new Uint32Array(0),
      triFace: new Uint32Array(0),
      faceIds: [],
      edgePositions: new Float32Array([
        0, 0, 0, 1, 0, 0, 2, 0, 0,
        10, 0, 0, 11, 0, 0,
      ]),
      edgeOffsets: new Uint32Array([0, 3, 5]),
      edgeIds: ['seam', 'regular'],
      edgeClasses: ['seam', 'regular'],
    }
    const geometry = buildEdgeLineGeometry(tess)
    const rendered = [...geometry.getAttribute('position').array]

    expect(rendered).toEqual([
      0, 0, 0, 0, 0, 0,
      1, 0, 0, 1, 0, 0,
      10, 0, 0, 11, 0, 0,
    ])
    expect(geometry.getAttribute('position').count).toBe(6)
    geometry.dispose()
  })

  it('renders persisted legacy edge polylines without inventing stable IDs', () => {
    const geometry = buildEdgeLineGeometry({
      edgePositions: new Float32Array([0, 0, 0, 1, 0, 0, 2, 0, 0]),
      edgeOffsets: new Uint32Array([0, 3]),
    })
    expect(geometry.getAttribute('position').count).toBe(4)
    geometry.dispose()
  })

  it('returns an empty (not null) geometry for an edgeless body', () => {
    const tess = makeBoxTessBuffers()
    const empty: TessBuffers = { ...tess, edgePositions: new Float32Array(0), edgeOffsets: new Uint32Array([0]), edgeIds: [] }
    const geometry = buildEdgeLineGeometry(empty)
    expect(geometry.getAttribute('position').count).toBe(0)
    geometry.dispose()
  })
})
