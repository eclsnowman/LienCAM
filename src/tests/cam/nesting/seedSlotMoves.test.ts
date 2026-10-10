/* Tests for seedSlotMoves (P6 Item 3a) — the RENDER-ONLY offset that places a
 * nest seed op's LOCAL toolpath onto the seed's slot pose so it draws ON the
 * visible seed instead of at the world origin.
 *
 * src/lib/cam/nesting/instanceToolpath.ts: seedSlotMoves(localMoves, geometry)
 * applies the owned-seed geometry's position (x, y) + EFFECTIVE Z rotation to
 * each move endpoint AND absolute arc center, leaving z / feed / role /
 * engagement / type untouched. It reuses instanceMove's rotate+translate with a
 * zero nest origin.
 *
 * Gates:
 *   - POSE: a known local move + a geometry at a NON-ZERO position and 90deg Z
 *     rotation maps to the expected slot-world endpoint AND arc center.
 *   - FIELDS: type (arc_ccw stays arc_ccw), z, feed, role, engagement preserved.
 *   - PURITY: the input move object is not mutated.
 *   - IDENTITY: pos (0,0,0) + rot (0,0,0) returns geometrically unchanged moves.
 */

import { describe, it, expect } from 'vitest'
import type { ImportedGeometry, ToolpathMove, Vec3 } from '../../../types/index'
import { seedSlotMoves } from '../../../lib/cam/nesting/instanceToolpath'

/** Minimal owned-seed geometry: only the fields seedSlotMoves reads (id,
 *  position, rotation, ownerNestId) need realistic values; the rest satisfy the
 *  ImportedGeometry shape. */
function seedGeo(position: Vec3, rotation: Vec3): ImportedGeometry {
  return {
    id: 'seed-1',
    name: 'seed',
    filename: 'seed.dxf',
    type: 'curves_2d',
    format: 'dxf',
    boundingBox: {
      min: { x: 0, y: 0, z: 0 },
      max: { x: 1, y: 1, z: 1 },
      size: { x: 1, y: 1, z: 1 },
      center: { x: 0.5, y: 0.5, z: 0.5 },
    },
    position,
    rotation,
    loaded: true,
    ownerNestId: 'nest-1',
  }
}

describe('seedSlotMoves - non-zero pose with 90deg rotation', () => {
  it('rotates+translates endpoint and arc center onto the slot', () => {
    const geo = seedGeo({ x: 100, y: 200, z: 0 }, { x: 0, y: 0, z: 90 })
    const move: ToolpathMove = {
      type: 'arc_ccw',
      x: 3,
      y: 4,
      z: -2,
      cx: 1,
      cy: 0,
      feed: 600,
      role: 'cut',
      engagement: 0.5,
    }
    const [out] = seedSlotMoves([move], geo)

    // 90deg CCW rotation: (x,y) -> (-y, x), then + position.
    // endpoint (3,4) -> (-4, 3) -> (96, 203)
    expect(out.x).toBeCloseTo(96, 9)
    expect(out.y).toBeCloseTo(203, 9)
    // arc center (1,0) -> (0, 1) -> (100, 201)
    expect(out.cx).toBeCloseTo(100, 9)
    expect(out.cy).toBeCloseTo(201, 9)
  })

  it('preserves type, z, feed, role, engagement', () => {
    const geo = seedGeo({ x: 100, y: 200, z: 0 }, { x: 0, y: 0, z: 90 })
    const move: ToolpathMove = {
      type: 'arc_ccw',
      x: 3,
      y: 4,
      z: -2,
      cx: 1,
      cy: 0,
      feed: 600,
      role: 'cut',
      engagement: 0.5,
    }
    const [out] = seedSlotMoves([move], geo)
    expect(out.type).toBe('arc_ccw')
    expect(out.z).toBe(-2)
    expect(out.feed).toBe(600)
    expect(out.role).toBe('cut')
    expect(out.engagement).toBe(0.5)
  })
})

describe('seedSlotMoves - purity', () => {
  it('does not mutate the input move', () => {
    const geo = seedGeo({ x: 100, y: 200, z: 0 }, { x: 0, y: 0, z: 90 })
    const move: ToolpathMove = { type: 'feed', x: 3, y: 4, z: -2, cx: 1, cy: 0 }
    const snapshot = { ...move }
    seedSlotMoves([move], geo)
    expect(move).toEqual(snapshot)
  })
})

describe('seedSlotMoves - identity pose', () => {
  it('returns geometrically unchanged moves at pos 0 / rot 0', () => {
    const geo = seedGeo({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })
    const move: ToolpathMove = {
      type: 'feed',
      x: 3,
      y: 4,
      z: -2,
      cx: 1,
      cy: 0,
      feed: 600,
      role: 'cut',
    }
    const [out] = seedSlotMoves([move], geo)
    expect(out.x).toBeCloseTo(3, 9)
    expect(out.y).toBeCloseTo(4, 9)
    expect(out.cx).toBeCloseTo(1, 9)
    expect(out.cy).toBeCloseTo(0, 9)
    expect(out.z).toBe(-2)
    expect(out.feed).toBe(600)
  })
})
