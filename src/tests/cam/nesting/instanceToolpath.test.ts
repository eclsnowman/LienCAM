/* Tests for the PURE instanced-toolpath transform (ADR 0024 sections 2-3,
 * P6 Item 2). src/lib/cam/nesting/instanceToolpath.ts maps a nest seed op's
 * seed-local ToolpathMove[] into nest-world per placement, and orders the
 * placements innermost-first for the post (P7).
 *
 * Gates:
 *   - TRANSLATION: a known local move + a translation-only placement (with a
 *     NON-ZERO nest origin) maps to the expected world endpoint.
 *   - ROTATION: a 90deg placement rotates BOTH the endpoint and the absolute
 *     arc center; type (arc_cw stays arc_cw), feed, role, z are unchanged.
 *   - PURITY: instanceMove does not mutate the input move.
 *   - ORDERING: orderPlacementsInnermostFirst returns all depth-1 before all
 *     depth-0, with a deterministic instanceId tie-break; pure (input array
 *     unchanged).
 *   - EXPANSION: expandSourceMoves returns groups in innermost-first order.
 */

import { describe, it, expect } from 'vitest'
import type { ToolpathMove, Vec2 } from '../../../types/index'
import type { Placement } from '../../../lib/cam/nesting/types'
import {
  instanceMove,
  instanceMoves,
  orderPlacementsInnermostFirst,
  expandSourceMoves,
} from '../../../lib/cam/nesting/instanceToolpath'

function placement(
  partial: Partial<Placement> & Pick<Placement, 'instanceId'>,
): Placement {
  return {
    partId: 'p',
    x: 0,
    y: 0,
    rotationDeg: 0,
    depth: 0,
    ...partial,
  }
}

describe('instanceMove - translation only', () => {
  it('maps endpoint by world = origin + (placement.xy) + local', () => {
    const origin: Vec2 = { x: 100, y: 200 }
    const p = placement({ instanceId: 'a', x: 10, y: 20, rotationDeg: 0 })
    const move: ToolpathMove = { type: 'feed', x: 3, y: 4, z: -1, feed: 500 }

    const out = instanceMove(move, p, origin)
    // 100 + 10 + 3 = 113 ; 200 + 20 + 4 = 224
    expect(out.x).toBeCloseTo(113, 9)
    expect(out.y).toBeCloseTo(224, 9)
    expect(out.z).toBe(-1)
    expect(out.feed).toBe(500)
    expect(out.type).toBe('feed')
  })
})

describe('instanceMove - 90deg rotation', () => {
  it('rotates endpoint AND absolute arc center; preserves type/feed/role/z', () => {
    const origin: Vec2 = { x: 0, y: 0 }
    const p = placement({ instanceId: 'a', x: 0, y: 0, rotationDeg: 90 })
    const move: ToolpathMove = {
      type: 'arc_cw',
      x: 1,
      y: 0,
      z: -2,
      feed: 300,
      cx: 2,
      cy: 0,
      role: 'lead_in',
      engagement: 1.5,
    }

    const out = instanceMove(move, p, origin)
    // rotate (1,0) by +90deg -> (0, 1)
    expect(out.x).toBeCloseTo(0, 9)
    expect(out.y).toBeCloseTo(1, 9)
    // rotate arc center (2,0) by +90deg -> (0, 2)
    expect(out.cx).toBeCloseTo(0, 9)
    expect(out.cy).toBeCloseTo(2, 9)
    // untouched fields (ADR 0024 section 2)
    expect(out.type).toBe('arc_cw')
    expect(out.feed).toBe(300)
    expect(out.role).toBe('lead_in')
    expect(out.z).toBe(-2)
    expect(out.engagement).toBe(1.5)
  })

  it('applies rotation about the placement pose with a non-zero origin', () => {
    const origin: Vec2 = { x: 5, y: 7 }
    const p = placement({ instanceId: 'a', x: 10, y: 20, rotationDeg: 90 })
    const move: ToolpathMove = { type: 'feed', x: 1, y: 0, z: 0 }
    const out = instanceMove(move, p, origin)
    // rotate (1,0)->(0,1); + placement (10,20) -> (10,21); + origin (5,7) -> (15,28)
    expect(out.x).toBeCloseTo(15, 9)
    expect(out.y).toBeCloseTo(28, 9)
  })
})

describe('instanceMove - purity', () => {
  it('does not mutate the input move', () => {
    const origin: Vec2 = { x: 1, y: 1 }
    const p = placement({ instanceId: 'a', x: 5, y: 5, rotationDeg: 45 })
    const move: ToolpathMove = {
      type: 'arc_ccw',
      x: 3,
      y: 4,
      z: -1,
      feed: 200,
      cx: 1,
      cy: 1,
      role: 'finish',
    }
    const snapshot = JSON.parse(JSON.stringify(move))
    const out = instanceMove(move, p, origin)
    expect(move).toEqual(snapshot)
    expect(out).not.toBe(move)
  })

  it('omits cx/cy when the source move has no arc center', () => {
    const out = instanceMove(
      { type: 'feed', x: 1, y: 2, z: 0 },
      placement({ instanceId: 'a' }),
      { x: 0, y: 0 },
    )
    expect(out.cx).toBeUndefined()
    expect(out.cy).toBeUndefined()
  })
})

describe('instanceMoves', () => {
  it('maps every move and returns a new array', () => {
    const moves: ToolpathMove[] = [
      { type: 'rapid', x: 0, y: 0, z: 5 },
      { type: 'feed', x: 1, y: 1, z: -1 },
    ]
    const out = instanceMoves(moves, placement({ instanceId: 'a', x: 10, y: 0 }), {
      x: 0,
      y: 0,
    })
    expect(out).toHaveLength(2)
    expect(out[0].x).toBeCloseTo(10, 9)
    expect(out[1].x).toBeCloseTo(11, 9)
    expect(out).not.toBe(moves)
  })
})

describe('orderPlacementsInnermostFirst', () => {
  it('returns all depth-1 before all depth-0, instanceId tie-break, pure', () => {
    const input: Placement[] = [
      placement({ instanceId: 'h2', depth: 0 }),
      placement({ instanceId: 'c2', depth: 1 }),
      placement({ instanceId: 'h1', depth: 0 }),
      placement({ instanceId: 'c1', depth: 1 }),
    ]
    const inputSnapshot = input.map((p) => p.instanceId)
    const ordered = orderPlacementsInnermostFirst(input)

    // depth-1 first (c1, c2 by instanceId asc), then depth-0 (h1, h2)
    expect(ordered.map((p) => p.instanceId)).toEqual(['c1', 'c2', 'h1', 'h2'])
    expect(ordered.every((p, i) => i === 0 || ordered[i - 1].depth >= p.depth)).toBe(
      true,
    )
    // pure: input array order unchanged, new array returned
    expect(input.map((p) => p.instanceId)).toEqual(inputSnapshot)
    expect(ordered).not.toBe(input)
  })

  it('is deterministic across two calls', () => {
    const input: Placement[] = [
      placement({ instanceId: 'b', depth: 0 }),
      placement({ instanceId: 'a', depth: 1 }),
    ]
    const a = orderPlacementsInnermostFirst(input).map((p) => p.instanceId)
    const b = orderPlacementsInnermostFirst(input).map((p) => p.instanceId)
    expect(a).toEqual(b)
  })
})

describe('expandSourceMoves', () => {
  it('returns per-placement groups in innermost-first order', () => {
    const localMoves: ToolpathMove[] = [{ type: 'feed', x: 1, y: 0, z: -1 }]
    const placements: Placement[] = [
      placement({ instanceId: 'host', depth: 0, x: 0, y: 0 }),
      placement({ instanceId: 'child', depth: 1, x: 50, y: 0 }),
    ]
    const groups = expandSourceMoves(localMoves, placements, { x: 0, y: 0 })

    expect(groups).toHaveLength(2)
    // child (depth 1) first
    expect(groups[0].placement.instanceId).toBe('child')
    expect(groups[1].placement.instanceId).toBe('host')
    // child group moves were instanced at the child pose (x = 50 + 1)
    expect(groups[0].moves[0].x).toBeCloseTo(51, 9)
    expect(groups[1].moves[0].x).toBeCloseTo(1, 9)
  })
})
