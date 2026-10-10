// V6 (Operator): the Shift-square rectangle must stay square UNDER SOLVING, not
// just look square while dragging. buildRectCommit(..., forceSquare=true) adds
// ONE `equal` constraint tying a horizontal leg to a vertical leg; with the
// existing H/V + corner coincidents that is enough to force width == height.
//
// This drives the REAL planegcs solver: build a deliberately NON-square rect
// (20 x 10) with forceSquare on, fix a corner, then constrain ONE side to a
// value and confirm the solver pulls the OTHER side to match (square holds).
// The no-forceSquare control proves a normal rect is free to be non-square.

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { buildRectCommit } from '../../lib/sketch/tools/rectTools'
import type { Sketch, SketchConstraint, SketchLineEntity, PointRef } from '../../lib/sketch/types'
import type { GcsWrapper } from '@salusoft89/planegcs'

let wrapperP: Promise<GcsWrapper> | null = null
const getWrapper = () => (wrapperP ??= createGcsWrapper())

function ref(entityId: string, site: PointRef['site']): PointRef { return { entityId, site } }

function len(l: SketchLineEntity): number {
  return Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y)
}

/** A 20x10 rect (NON-square as-drawn) built with the given forceSquare flag,
 *  corner0 fixed, and the bottom (horizontal) side pinned to `sideLen` via a
 *  driving distance dimension. Returns the solved side lengths. */
async function solveWithSide(forceSquare: boolean, sideLen: number) {
  const wrapper = await getWrapper()
  let n = 0
  const commit = buildRectCommit({ x: 0, y: 0 }, { x: 20, y: 10 }, false, () => `r${n++}`, forceSquare)
  const ids = commit.entities.slice(0, 4).map((e) => e.id) // the four sides
  const sk: Sketch = {
    id: 'sk', layerId: 'layer',
    entities: commit.entities,
    constraints: [
      ...commit.constraints,
      { id: 'fix0', kind: 'fix', point: ref(ids[0], 'start') } as SketchConstraint,
    ],
    // Pin the bottom side length; the equal leg (if present) forces the side.
    dimensions: [
      { id: 'dw', kind: 'distance', driving: true, value: sideLen, a: ref(ids[0], 'start'), b: ref(ids[0], 'end') },
    ],
    solveStatus: null,
  }
  const out = solveSketchOnWrapper(wrapper, sk)
  expect(out.ok).toBe(true)
  if (!out.ok) throw new Error('solve failed')
  const line = (id: string) => out.entities.find((e): e is SketchLineEntity => e.id === id && e.kind === 'line')!
  return { width: len(line(ids[0])), height: len(line(ids[1])) }
}

describe('V6: Shift-square rectangle stays square under solving', () => {
  it('forceSquare rect: constraining one side pulls the other side EQUAL', async () => {
    const { width, height } = await solveWithSide(true, 30)
    expect(width).toBeCloseTo(30, 4)
    expect(height).toBeCloseTo(30, 4) // equal leg forced it square, not 10
  })

  it('normal rect (no forceSquare): the other side stays free (NOT forced equal)', async () => {
    const { width, height } = await solveWithSide(false, 30)
    expect(width).toBeCloseTo(30, 4)
    // No equal constraint -> height keeps its drawn value; it is NOT 30.
    expect(Math.abs(height - 30)).toBeGreaterThan(1)
  })
})
