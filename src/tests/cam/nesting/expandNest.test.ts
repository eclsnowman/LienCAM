/* Unit tests for the P7 nest expander (ADR 0024 Amendment 1).
 *
 * Pure-function tests: synthetic seed-local move streams + placements, no
 * worker / store. Covers travel insertion + the safety invariant, copy
 * ordering (innermost-first then nearest-neighbor), both machiningOrder modes,
 * origin offset, byte-stability, and edge cases. */
import { describe, it, expect } from 'vitest'
import type { ToolpathMove, Vec2 } from '../../../types/index'
import type { Placement } from '../../../lib/cam/nesting/types'
import {
  expandNest,
  orderCopies,
  type SeedOpExpansionInput,
} from '../../../lib/cam/nesting/instanceToolpath'

const Z = { clearanceZ: 10, retractZ: 5, feedZ: 1 }

/** A self-contained seed-local op stream: approach high -> plunge -> cut ->
 *  retract high. Starts and ends at clearanceZ (10). */
const SELF_CONTAINED: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' },
  { type: 'feed', x: 0, y: 0, z: -2, feed: 100, role: 'plunge' },
  { type: 'feed', x: 5, y: 0, z: -2, feed: 200, role: 'cut' },
  { type: 'feed', x: 5, y: 5, z: -2, feed: 200, role: 'cut' },
  { type: 'rapid', x: 5, y: 5, z: 10, role: 'rapid' },
]

/** An op stream that ends LOW (no trailing retract) to force the expander to
 *  insert the retract leg of the inter-copy seam. */
const ENDS_LOW: ToolpathMove[] = [
  { type: 'rapid', x: 0, y: 0, z: 10, role: 'rapid' },
  { type: 'feed', x: 0, y: 0, z: -2, feed: 100, role: 'plunge' },
  { type: 'feed', x: 5, y: 5, z: -2, feed: 200, role: 'cut' },
]

function op(over: Partial<SeedOpExpansionInput> = {}): SeedOpExpansionInput {
  return {
    opId: 'op1',
    toolId: 't1',
    sourceGeometryId: 'srcA',
    localMoves: SELF_CONTAINED,
    ...Z,
    ...over,
  }
}

function placement(over: Partial<Placement> = {}): Placement {
  return { partId: 'srcA', instanceId: 'i1', x: 0, y: 0, rotationDeg: 0, depth: 0, ...over }
}

const ORIGIN: Vec2 = { x: 0, y: 0 }

describe('orderCopies', () => {
  it('puts innermost (deeper) placements first', () => {
    const host = placement({ instanceId: 'h', x: 0, y: 0, depth: 0 })
    const child = placement({ instanceId: 'c', x: 10, y: 10, depth: 1, windowParentId: 'h' })
    const ordered = orderCopies([host, child])
    expect(ordered.map((p) => p.instanceId)).toEqual(['c', 'h'])
  })

  it('nearest-neighbor within a tier is deterministic', () => {
    // start at smallest instanceId (i1 @0,0); nearest each step.
    const ps = [
      placement({ instanceId: 'i1', x: 0, y: 0 }),
      placement({ instanceId: 'i2', x: 1, y: 0 }),
      placement({ instanceId: 'i3', x: 5, y: 0 }),
      placement({ instanceId: 'i4', x: 2, y: 0 }),
    ]
    // i1(0) -> i2(1) -> i4(2) -> i3(5)
    expect(orderCopies(ps).map((p) => p.instanceId)).toEqual(['i1', 'i2', 'i4', 'i3'])
  })

  it('does not reorder across depth tiers (safety preserved)', () => {
    const ps = [
      placement({ instanceId: 'h1', x: 0, y: 0, depth: 0 }),
      placement({ instanceId: 'c1', x: 100, y: 100, depth: 1 }),
      placement({ instanceId: 'c2', x: 0, y: 0, depth: 1 }),
    ]
    const ordered = orderCopies(ps)
    // both depth-1 children before the depth-0 host, regardless of distance
    expect(ordered[ordered.length - 1].instanceId).toBe('h1')
    expect(ordered.slice(0, 2).every((p) => p.depth === 1)).toBe(true)
  })
})

describe('expandNest by-operation', () => {
  it('one section per op spanning all copies; copyCount correct', () => {
    const placements = [
      placement({ instanceId: 'i1', x: 0, y: 0 }),
      placement({ instanceId: 'i2', x: 100, y: 0 }),
    ]
    const { sections } = expandNest([op()], placements, ORIGIN, 'by-operation')
    expect(sections).toHaveLength(1)
    expect(sections[0].opId).toBe('op1')
    expect(sections[0].copyCount).toBe(2)
  })

  it('inserts an inter-copy travel seam between copies', () => {
    const placements = [
      placement({ instanceId: 'i1', x: 0, y: 0 }),
      placement({ instanceId: 'i2', x: 100, y: 0 }),
    ]
    const { moves } = expandNest([op()], placements, ORIGIN, 'by-operation')
    // more moves than two raw copies => a seam was inserted
    expect(moves.length).toBeGreaterThan(SELF_CONTAINED.length * 2)
    // a rapid that traverses from copy1 region to copy2 entry (x ~ 100) at safe Z
    const traverse = moves.find((m) => m.type === 'rapid' && m.x === 100 && m.z === 10)
    expect(traverse).toBeDefined()
  })

  it('inserts a retract leg when the previous copy ends low', () => {
    const placements = [
      placement({ instanceId: 'i1', x: 0, y: 0 }),
      placement({ instanceId: 'i2', x: 100, y: 0 }),
    ]
    const { moves } = expandNest(
      [op({ localMoves: ENDS_LOW })],
      placements,
      ORIGIN,
      'by-operation',
    )
    // ENDS_LOW last move is at (5,5,-2); the seam must retract straight up to
    // clearanceZ at that same XY before traversing.
    const idx = moves.findIndex((m) => m.x === 5 && m.y === 5 && m.z === -2)
    expect(idx).toBeGreaterThanOrEqual(0)
    const retract = moves[idx + 1]
    expect(retract).toMatchObject({ type: 'rapid', x: 5, y: 5, z: 10 })
  })

  it('safety invariant: no horizontal rapid below the safe retract height', () => {
    const placements = [
      placement({ instanceId: 'i1', x: 0, y: 0 }),
      placement({ instanceId: 'i2', x: 100, y: 0 }),
      placement({ instanceId: 'i3', x: 100, y: 100 }),
    ]
    const { moves } = expandNest([op({ localMoves: ENDS_LOW })], placements, ORIGIN, 'by-operation')
    for (let k = 1; k < moves.length; k++) {
      const a = moves[k - 1]
      const b = moves[k]
      const horizontal = b.x !== a.x || b.y !== a.y
      if (b.type === 'rapid' && horizontal) {
        expect(b.z).toBeGreaterThanOrEqual(Z.clearanceZ)
      }
    }
  })
})

describe('expandNest by-part', () => {
  const ops = [op({ opId: 'op1', toolId: 't1' }), op({ opId: 'op2', toolId: 't2' })]
  const placements = [
    placement({ instanceId: 'i1', x: 0, y: 0 }),
    placement({ instanceId: 'i2', x: 100, y: 0 }),
  ]

  it('orders part-major: all ops of copy1 then copy2', () => {
    const { sections } = expandNest(ops, placements, ORIGIN, 'by-part')
    // one section per (copy, op) pair = 4 sections
    expect(sections).toHaveLength(4)
    expect(sections.map((s) => s.opId)).toEqual(['op1', 'op2', 'op1', 'op2'])
    expect(sections.every((s) => s.copyCount === 1)).toBe(true)
  })

  it('by-operation on the same input is op-major (2 sections)', () => {
    const { sections } = expandNest(ops, placements, ORIGIN, 'by-operation')
    expect(sections.map((s) => s.opId)).toEqual(['op1', 'op2'])
    expect(sections.every((s) => s.copyCount === 2)).toBe(true)
  })
})

describe('expandNest origin + flatten', () => {
  it('applies the nest world origin to every move', () => {
    const origin: Vec2 = { x: 1000, y: 2000 }
    const { moves } = expandNest([op()], [placement({ x: 0, y: 0 })], origin, 'by-operation')
    // first move was local (0,0) at placement (0,0) -> world (1000,2000)
    expect(moves[0]).toMatchObject({ x: 1000, y: 2000 })
  })

  it('flattened moves equal sections concatenated', () => {
    const placements = [
      placement({ instanceId: 'i1', x: 0, y: 0 }),
      placement({ instanceId: 'i2', x: 100, y: 0 }),
    ]
    const exp = expandNest([op()], placements, ORIGIN, 'by-operation')
    expect(exp.moves).toEqual(exp.sections.flatMap((s) => s.moves))
  })
})

describe('expandNest determinism + edges', () => {
  it('is byte-stable across repeated calls', () => {
    const placements = [
      placement({ instanceId: 'i1', x: 0, y: 0 }),
      placement({ instanceId: 'i2', x: 100, y: 0 }),
      placement({ instanceId: 'i3', x: 100, y: 100 }),
    ]
    const a = expandNest([op()], placements, ORIGIN, 'by-operation')
    const b = expandNest([op()], placements, ORIGIN, 'by-operation')
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('empty ops -> empty expansion', () => {
    const exp = expandNest([], [placement()], ORIGIN, 'by-operation')
    expect(exp.sections).toHaveLength(0)
    expect(exp.moves).toHaveLength(0)
  })

  it('an op with no computed moves is skipped', () => {
    const exp = expandNest([op({ localMoves: [] })], [placement()], ORIGIN, 'by-operation')
    expect(exp.sections).toHaveLength(0)
    expect(exp.moves).toHaveLength(0)
  })

  it('a single copy gets no seam (moves == one instanced stream)', () => {
    const exp = expandNest([op()], [placement({ x: 0, y: 0 })], ORIGIN, 'by-operation')
    expect(exp.moves).toHaveLength(SELF_CONTAINED.length)
  })
})
