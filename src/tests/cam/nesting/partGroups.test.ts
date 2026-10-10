import { describe, expect, it } from 'vitest'
import type { Loop2D } from '../../../types'
import { groupLoopsByTopLevelOuter } from '../../../lib/cam/nesting/partGroups'

function loop(id: string, x: number, y: number, width: number, height: number): Loop2D {
  return {
    id,
    layerId: 'L',
    closed: true,
    type: 'contour',
    area: width * height,
    points: [
      { x, y },
      { x: x + width, y },
      { x: x + width, y: y + height },
      { x, y: y + height },
    ],
  }
}

describe('groupLoopsByTopLevelOuter', () => {
  it('makes disconnected outer outlines separate parts and keeps descendants together', () => {
    const left = loop('left', 0, 0, 30, 30)
    const leftHole = loop('left-hole', 5, 5, 20, 20)
    const leftIsland = loop('left-island', 10, 10, 5, 5)
    const right = loop('right', 50, 0, 20, 20)
    const groups = groupLoopsByTopLevelOuter(
      [leftHole, right, leftIsland, left],
      [leftHole, right, leftIsland, left],
    )

    expect(groups.map((group) => group.outer.id)).toEqual(['right', 'left'])
    expect(groups[0].loops.map((item) => item.id)).toEqual(['right'])
    expect(groups[1].loops.map((item) => item.id)).toEqual([
      'left',
      'left-hole',
      'left-island',
    ])
  })

  it('keeps an open internal feature with its containing outer', () => {
    const outer = loop('outer', 0, 0, 20, 20)
    const internal: Loop2D = {
      id: 'engrave',
      layerId: 'L',
      closed: false,
      type: 'open',
      area: 0,
      points: [{ x: 3, y: 4 }, { x: 15, y: 16 }],
    }

    const groups = groupLoopsByTopLevelOuter([outer], [outer, internal])
    expect(groups).toHaveLength(1)
    expect(groups[0].loops.map((item) => item.id)).toEqual(['outer', 'engrave'])
  })

  it('does not absorb an intersecting outline into a larger outline', () => {
    const a = loop('a', 0, 0, 20, 20)
    const crossing = loop('crossing', 15, 5, 10, 10)
    const groups = groupLoopsByTopLevelOuter([a, crossing])
    expect(groups.map((group) => group.outer.id)).toEqual(['a', 'crossing'])
  })
})
