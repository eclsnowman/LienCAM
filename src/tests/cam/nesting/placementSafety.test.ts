import { beforeAll, describe, expect, it } from 'vitest'
import { ensureEngineClipperReady } from '../../../lib/cam/adaptiveClearing2d/engine/clipperEngine'
import { validatePlacementSafety } from '../../../lib/cam/nesting/placementSafety'
import type { NestPart, Placement } from '../../../lib/cam/nesting'

function square(id: string): NestPart {
  return {
    id,
    holes: [],
    outer: [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
  }
}

function placement(
  partId: string,
  instanceId: string,
  x: number,
  y: number,
  rotationDeg = 0,
): Placement {
  return { partId, instanceId, x, y, rotationDeg, depth: 0 }
}

beforeAll(async () => {
  await ensureEngineClipperReady()
})

describe('validatePlacementSafety', () => {
  it('rejects transformed overlaps and sheet escapes', () => {
    const parts = [{ part: square('a') }, { part: square('b') }, { part: square('c') }]
    const result = validatePlacementSafety(
      parts,
      [
        placement('a', 'a#0', 2, 2),
        placement('b', 'b#0', 7, 2),
        placement('c', 'c#0', 25, 2),
      ],
      { width: 30, height: 20 },
      2,
    )

    expect(result.placements.map((item) => item.instanceId)).toEqual(['a#0'])
    expect(result.rejected.map((item) => item.instanceId)).toEqual(['b#0', 'c#0'])
  })

  it('accepts edge-touching parts when no gap is requested', () => {
    const parts = [{ part: square('a') }, { part: square('b') }]
    const result = validatePlacementSafety(
      parts,
      [placement('a', 'a#0', 0, 0), placement('b', 'b#0', 10, 0)],
      { width: 20, height: 10 },
      0,
    )
    expect(result.rejected).toEqual([])
    expect(result.placements).toHaveLength(2)
  })

  it('accepts parts that meet the requested gap exactly', () => {
    const parts = [{ part: square('a') }, { part: square('b') }]
    const result = validatePlacementSafety(
      parts,
      [placement('a', 'a#0', 0, 0), placement('b', 'b#0', 13, 0)],
      { width: 23, height: 10 },
      0,
      3,
    )
    expect(result.rejected).toEqual([])
    expect(result.placements).toHaveLength(2)
  })

  it('rejects a part 0.22 mm closer than the requested gap', () => {
    const parts = [{ part: square('a') }, { part: square('b') }]
    const result = validatePlacementSafety(
      parts,
      [placement('a', 'a#0', 0, 0), placement('b', 'b#0', 12.78, 0)],
      { width: 30, height: 10 },
      0,
      3,
    )
    expect(result.placements.map((item) => item.instanceId)).toEqual(['a#0'])
    expect(result.rejected.map((item) => item.instanceId)).toEqual(['b#0'])
  })

  it('accepts a part 0.005 mm closer than the requested gap', () => {
    const parts = [{ part: square('a') }, { part: square('b') }]
    const result = validatePlacementSafety(
      parts,
      [placement('a', 'a#0', 0, 0), placement('b', 'b#0', 12.995, 0)],
      { width: 30, height: 10 },
      0,
      3,
    )
    expect(result.rejected).toEqual([])
    expect(result.placements).toHaveLength(2)
  })

  it('rejects rotated multi-object placements that violate the requested part gap', () => {
    const horizontal: NestPart = {
      id: 'horizontal',
      holes: [],
      outer: [
        { x: 20, y: 30 },
        { x: 32, y: 30 },
        { x: 32, y: 36 },
        { x: 20, y: 36 },
      ],
    }
    const vertical: NestPart = {
      id: 'vertical',
      holes: [],
      outer: [
        { x: -8, y: 4 },
        { x: -2, y: 4 },
        { x: -2, y: 16 },
        { x: -8, y: 16 },
      ],
    }
    const result = validatePlacementSafety(
      [{ part: horizontal }, { part: vertical }],
      [
        placement('horizontal', 'horizontal#0', -15, -25),
        // Rotates to a 12x6 rectangle whose left edge is only 2 mm from the
        // accepted part's right edge. The solids do not overlap, but the
        // requested 3 mm clearance is violated.
        placement('vertical', 'vertical#0', 35, 13, 90),
      ],
      { width: 40, height: 20 },
      1,
      3,
    )

    expect(result.placements.map((item) => item.instanceId)).toEqual(['horizontal#0'])
    expect(result.rejected.map((item) => item.instanceId)).toEqual(['vertical#0'])
  })
})
