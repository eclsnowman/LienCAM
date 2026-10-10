// MSH-4-BOOLEAN-EDIT: pure helpers - the honesty classifier (planar => EXACT,
// curved => APPROXIMATE), world-bake parity, and the consistent feedback copy.
import { describe, expect, it } from 'vitest'
import type { ModelBodyDisplay } from '../../types'
import {
  classifyModelBodyFidelity,
  worldBakedMesh,
  bakePoseIntoPositions,
  booleanResultName,
  booleanOpLabel,
  booleanOpConnector,
  booleanConsoleMessage,
  booleanHoverLabel,
  fidelityWord,
  fidelityExplanation,
  describeBooleanFailure,
  exceedsOperandTriangleLimit,
  MODEL_DISPLAY_CHORD_TOLERANCE_MM,
  MAX_BOOLEAN_OPERAND_TRIANGLES,
} from '../../lib/cam/booleanMeshModel'

/** A watertight box display: 6 planar faces, 2 triangles each, per-face ids. */
function boxDisplay(size = 10, merged = false): ModelBodyDisplay {
  const s = size
  const positions = [
    0, 0, 0, s, 0, 0, s, s, 0, 0, s, 0, // 0-3 bottom
    0, 0, s, s, 0, s, s, s, s, 0, s, s, // 4-7 top
  ]
  const indices = [
    0, 2, 1, 0, 3, 2, // bottom (-Z)  face0
    4, 5, 6, 4, 6, 7, // top (+Z)     face1
    0, 1, 5, 0, 5, 4, // front (-Y)   face2
    2, 3, 7, 2, 7, 6, // back (+Y)    face3
    0, 4, 7, 0, 7, 3, // left (-X)    face4
    1, 2, 6, 1, 6, 5, // right (+X)   face5
  ]
  // merged=true forces two differently-oriented faces to share one id, so that
  // "face" is non-coplanar => the classifier must report it curved.
  const triFace = merged
    ? [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4]
    : [0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5]
  const faceIds = (merged ? ['f0', 'f1', 'f2', 'f3', 'f4'] : ['f0', 'f1', 'f2', 'f3', 'f4', 'f5'])
  return {
    positions, normals: new Array(positions.length).fill(0), indices,
    edgePositions: [], edgeOffsets: [],
    bbox: { min: [0, 0, 0], max: [s, s, s] }, faceIds, triFace,
  }
}

/** An open hexagonal-prism WALL as ONE face id: 6 segments, differing normals,
 *  all triFace=0 -> the classifier must call that single face curved. */
function cylinderWallDisplay(r = 5, h = 10, seg = 6): ModelBodyDisplay {
  const positions: number[] = []
  for (let i = 0; i < seg; i++) {
    const a = (2 * Math.PI * i) / seg
    positions.push(r * Math.cos(a), r * Math.sin(a), 0) // bottom ring
  }
  for (let i = 0; i < seg; i++) {
    const a = (2 * Math.PI * i) / seg
    positions.push(r * Math.cos(a), r * Math.sin(a), h) // top ring
  }
  const indices: number[] = []
  const triFace: number[] = []
  for (let i = 0; i < seg; i++) {
    const bi = i, bj = (i + 1) % seg, ti = seg + i, tj = seg + ((i + 1) % seg)
    indices.push(bi, bj, tj, bi, tj, ti)
    triFace.push(0, 0)
  }
  return {
    positions, normals: new Array(positions.length).fill(0), indices,
    edgePositions: [], edgeOffsets: [],
    bbox: { min: [-r, -r, 0], max: [r, r, h] }, faceIds: ['wall'], triFace,
  }
}

describe('classifyModelBodyFidelity (MSH-4 honesty engine)', () => {
  it('a planar/prismatic body (all faces flat) is EXACT', () => {
    const f = classifyModelBodyFidelity(boxDisplay())
    expect(f.exact).toBe(true)
    expect(f.curvedFaceCount).toBe(0)
    expect(f.planarFaceCount).toBe(6)
  })

  it('a body with a curved face (varying normals under one face id) is APPROXIMATE', () => {
    const f = classifyModelBodyFidelity(cylinderWallDisplay())
    expect(f.exact).toBe(false)
    expect(f.curvedFaceCount).toBeGreaterThanOrEqual(1)
  })

  it('merging two differently-oriented box faces into one id makes it curved', () => {
    const f = classifyModelBodyFidelity(boxDisplay(10, true))
    expect(f.exact).toBe(false)
    expect(f.curvedFaceCount).toBe(1)
  })

  it('missing per-face identity is treated conservatively as APPROXIMATE (never overclaims exact)', () => {
    const d = boxDisplay()
    const f = classifyModelBodyFidelity({ ...d, faceIds: undefined, triFace: undefined })
    expect(f.exact).toBe(false)
    expect(f.reason).toMatch(/per-face identity is unavailable/)
  })
})

describe('worldBakedMesh / bakePoseIntoPositions (viewport parity)', () => {
  it('identity pose passes positions through unchanged', () => {
    const out = bakePoseIntoPositions([1, 2, 3, 4, 5, 6], { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } })
    expect(Array.from(out)).toEqual([1, 2, 3, 4, 5, 6])
  })

  it('translation shifts every vertex', () => {
    const out = bakePoseIntoPositions([1, 0, 0], { position: { x: 10, y: 20, z: 30 }, rotation: { x: 0, y: 0, z: 0 } })
    expect(out[0]).toBeCloseTo(11)
    expect(out[1]).toBeCloseTo(20)
    expect(out[2]).toBeCloseTo(30)
  })

  it('a 90deg Z rotation maps +X to +Y (THREE Euler XYZ parity)', () => {
    const out = bakePoseIntoPositions([1, 0, 0], { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 90 } })
    expect(out[0]).toBeCloseTo(0)
    expect(out[1]).toBeCloseTo(1)
    expect(out[2]).toBeCloseTo(0)
  })

  it('worldBakedMesh returns typed buffers (Float32Array / Uint32Array)', () => {
    const m = worldBakedMesh([0, 0, 0], [0], { position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } })
    expect(m.positions).toBeInstanceOf(Float32Array)
    expect(m.indices).toBeInstanceOf(Uint32Array)
  })
})

describe('feedback copy (single source, all surfaces agree)', () => {
  const prov = { op: 'difference' as const, sourceMeshId: 'm', sourceMeshName: 'scan_v3', modelBodyId: 'b', modelBodyName: 'Block', triangleCount: 24, volumeMm3: 875, curvedFaceCount: 0 }

  it('op labels + connectors + result name', () => {
    expect(booleanOpLabel('difference')).toBe('Subtract')
    expect(booleanOpLabel('union')).toBe('Union')
    expect(booleanOpLabel('intersect')).toBe('Intersect')
    expect(booleanOpConnector('difference')).toBe('minus')
    expect(booleanResultName('scan_v3', 'difference')).toBe('scan_v3 (subtract)')
    expect(booleanResultName('scan_v3', 'union')).toBe('scan_v3 (union)')
  })

  it('exact vs approximate wording is honest and distinct', () => {
    expect(fidelityWord(false)).toBe('Exact')
    expect(fidelityWord(true)).toBe('Approximate')
    expect(fidelityExplanation(false)).toMatch(/only the geometry type changed/)
    expect(fidelityExplanation(true)).toMatch(/curved surfaces/)
  })

  it('hover label + console message name both operands and the fidelity', () => {
    expect(booleanHoverLabel(prov, false)).toBe('scan_v3 minus Block, exact (only the geometry type changed (flat faces are exact))')
    expect(booleanConsoleMessage('scan_v3 (subtract)', true)).toMatch(/approximate/)
    expect(booleanConsoleMessage('scan_v3 (subtract)', false)).toMatch(/exact/)
  })

  it('the internal display-fidelity constant is a small positive number, never user-facing', () => {
    expect(MODEL_DISPLAY_CHORD_TOLERANCE_MM).toBeGreaterThan(0)
    expect(MODEL_DISPLAY_CHORD_TOLERANCE_MM).toBeLessThan(1)
  })
})

describe('Stage 3 guards (named refusals + perf ceiling)', () => {
  it('maps a bare "Not manifold" kernel error to a readable, named refusal (keeps the original)', () => {
    const msg = describeBooleanFailure(new Error('Not manifold'))
    expect(msg).toMatch(/not a closed, watertight solid/)
    expect(msg).toMatch(/Not manifold/)
  })
  it('routes a brep-vs-brep refusal to the Model workspace tool', () => {
    expect(describeBooleanFailure(new Error('brep-vs-brep boolean refused'))).toMatch(/Model workspace/)
  })
  it('passes any other failure through as "Boolean failed: ..."', () => {
    expect(describeBooleanFailure(new Error('boom'))).toBe('Boolean failed: boom')
  })
  it('exceedsOperandTriangleLimit fires only past the ceiling', () => {
    expect(exceedsOperandTriangleLimit(10, 10)).toBe(false)
    expect(exceedsOperandTriangleLimit(MAX_BOOLEAN_OPERAND_TRIANGLES, MAX_BOOLEAN_OPERAND_TRIANGLES)).toBe(false)
    expect(exceedsOperandTriangleLimit(MAX_BOOLEAN_OPERAND_TRIANGLES + 1, 0)).toBe(true)
    expect(exceedsOperandTriangleLimit(0, MAX_BOOLEAN_OPERAND_TRIANGLES + 1)).toBe(true)
  })
})
