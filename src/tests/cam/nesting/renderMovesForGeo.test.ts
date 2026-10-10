/* Tests for the two PURE render-gate helpers shared by the toolpath viewport
 * and the simulation panel (P6 Item 3a / step-7 re-render fix):
 *   - renderMovesForGeo(localMoves, geo): a non-seed (or absent) geo returns the
 *     SAME array reference unchanged (byte-identical contract); a seed geo
 *     (ownerNestId set) offsets the moves onto its slot pose.
 *   - seedPoseKeyForGeo(geo): "" for a non-seed/absent geo (so render keys stay
 *     byte-identical to before); a stable string for a seed geo that CHANGES
 *     when the seed position or rotation changes.
 */

import { describe, it, expect } from 'vitest'
import type { ImportedGeometry, ToolpathMove } from '../../../types/index'
import {
  renderMovesForGeo,
  seedPoseKeyForGeo,
} from '../../../lib/cam/nesting/instanceToolpath'

// Minimal ImportedGeometry fixture: only the fields the helpers read
// (position, rotation, ownerNestId) need to be meaningful.
function geo(partial: Partial<ImportedGeometry>): ImportedGeometry {
  return {
    id: 'g1',
    name: 'g',
    type: 'stl',
    loops: [],
    position: { x: 0, y: 0, z: 0 },
    rotation: { x: 0, y: 0, z: 0 },
    ...partial,
  } as ImportedGeometry
}

const sampleMoves: ToolpathMove[] = [
  { type: 'feed', x: 3, y: 4, z: -1, feed: 500, role: 'cut' },
  { type: 'arc_cw', x: 5, y: 6, z: -1, cx: 4, cy: 5 },
]

describe('renderMovesForGeo - non-seed pass-through (byte-identical)', () => {
  it('returns the SAME array reference for a geo without ownerNestId', () => {
    const g = geo({ position: { x: 10, y: 20, z: 0 } }) // no ownerNestId
    const out = renderMovesForGeo(sampleMoves, g)
    expect(out).toBe(sampleMoves) // same reference -> byte-identical
  })

  it('returns the SAME array reference when geo is undefined', () => {
    const out = renderMovesForGeo(sampleMoves, undefined)
    expect(out).toBe(sampleMoves)
  })
})

describe('renderMovesForGeo - seed geo offsets onto slot pose', () => {
  it('translates moves by the seed position for a zero-rotation seed', () => {
    const g = geo({
      ownerNestId: 'nest1',
      position: { x: 100, y: 200, z: 0 },
      rotation: { x: 0, y: 0, z: 0 },
    })
    const out = renderMovesForGeo(sampleMoves, g)
    expect(out).not.toBe(sampleMoves) // a new array
    // pure translation: endpoint shifted by position
    expect(out[0].x).toBeCloseTo(103, 9)
    expect(out[0].y).toBeCloseTo(204, 9)
    expect(out[0].z).toBe(-1)
    expect(out[0].feed).toBe(500)
    expect(out[0].role).toBe('cut')
    // arc center also shifted; type/handedness preserved
    expect(out[1].type).toBe('arc_cw')
    expect(out[1].cx).toBeCloseTo(104, 9)
    expect(out[1].cy).toBeCloseTo(205, 9)
    // input not mutated
    expect(sampleMoves[0].x).toBe(3)
  })
})

describe('seedPoseKeyForGeo - empty for non-seed (byte-identical key)', () => {
  it('returns "" for a geo without ownerNestId', () => {
    expect(seedPoseKeyForGeo(geo({ position: { x: 5, y: 6, z: 0 } }))).toBe('')
  })

  it('returns "" when geo is undefined', () => {
    expect(seedPoseKeyForGeo(undefined)).toBe('')
  })
})

describe('seedPoseKeyForGeo - changes when seed pose changes', () => {
  it('changes when the seed position changes', () => {
    const a = seedPoseKeyForGeo(
      geo({ ownerNestId: 'n', position: { x: 10, y: 20, z: 0 } }),
    )
    const b = seedPoseKeyForGeo(
      geo({ ownerNestId: 'n', position: { x: 11, y: 20, z: 0 } }),
    )
    expect(a).not.toBe('')
    expect(b).not.toBe(a)
  })

  it('changes when the seed Z rotation changes', () => {
    const a = seedPoseKeyForGeo(
      geo({ ownerNestId: 'n', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 } }),
    )
    const b = seedPoseKeyForGeo(
      geo({ ownerNestId: 'n', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 90 } }),
    )
    expect(b).not.toBe(a)
  })
})
