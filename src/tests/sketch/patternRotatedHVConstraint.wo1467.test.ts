// WO-1467 / BUG-495: a rotated pattern copy solves its shape away because
// its H/V constraints were never rotated. remapConstraint used to copy
// 'horizontal'/'vertical' onto every copy verbatim, asking the solver to
// pin an already-rigidly-rotated edge back onto a WORLD axis -- which it
// does by resizing/reshaping the rectangle instead of leaving the rigid
// copy alone. Fixed: axisConstraintKindAt keeps/swaps H/V only at a
// 90-degree-multiple rotation (where the copy's frame still coincides with
// an axis) and drops it otherwise, relying on the remaining internal
// constraints + the rigid coordinate transform to hold the shape.

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import { circularPattern } from '../../lib/sketch/tools/patternTools'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchConstraint, PointRef,
} from '../../lib/sketch/types'

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}

function sketch(entities: SketchEntity[], constraints: SketchConstraint[]): Sketch {
  return {
    id: 'sk', layerId: 'layer',
    entities, constraints, dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

// 4-edge H/V-constrained rectangle at (0,0)-(W,H), corners chained by
// coincident, exactly like BUG-495's repro shape (numbers changed for a
// tidy test fixture -- the defect is not sensitive to the exact size).
const W = 40, H = 20
function rectangle(): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
  const entities: SketchEntity[] = [
    line('l1', 0, 0, W, 0),   // bottom
    line('l2', W, 0, W, H),   // right
    line('l3', W, H, 0, H),   // top
    line('l4', 0, H, 0, 0),   // left
  ]
  const constraints: SketchConstraint[] = [
    { id: 'c12', kind: 'coincident', a: ref('l1', 'end'), b: ref('l2', 'start') },
    { id: 'c23', kind: 'coincident', a: ref('l2', 'end'), b: ref('l3', 'start') },
    { id: 'c34', kind: 'coincident', a: ref('l3', 'end'), b: ref('l4', 'start') },
    { id: 'c41', kind: 'coincident', a: ref('l4', 'end'), b: ref('l1', 'start') },
    { id: 'h1', kind: 'horizontal', line: 'l1' },
    { id: 'h3', kind: 'horizontal', line: 'l3' },
    { id: 'v2', kind: 'vertical', line: 'l2' },
    { id: 'v4', kind: 'vertical', line: 'l4' },
  ]
  return { entities, constraints }
}

function sideLengths(entities: SketchEntity[], ids: string[]): number[] {
  return ids.map((id) => {
    const e = entities.find((x) => x.id === id) as SketchLineEntity
    return Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y)
  })
}

let n = 0
const newId = () => `pc-${n++}`

describe('WO-1467: rotated pattern copy keeps its H/V-constrained shape', () => {
  it('remapConstraint drops H/V at a non-axis rotation, swaps it at 90deg', () => {
    const { entities, constraints } = rectangle()
    const r = circularPattern(
      entities, constraints, ['l1', 'l2', 'l3', 'l4'], 3, { x: 0, y: 0 }, Math.PI / 4, newId)
    if (typeof r === 'string') throw new Error(r)

    // Copy 1 (45deg, k=1): no valid world-axis expression -- dropped.
    const copy1Ids = new Set(r.entities.slice(0, 4).map((e) => e.id))
    const copy1HV = r.constraints.filter((c) =>
      (c.kind === 'horizontal' || c.kind === 'vertical') &&
      'line' in c && c.line !== undefined && copy1Ids.has(c.line))
    expect(copy1HV).toHaveLength(0)

    // Copy 2 (90deg, k=2): stays fully constrained, but horizontal and
    // vertical have swapped (the source's horizontal edges are now
    // vertical in the rotated copy's frame, and vice versa).
    const copy2 = r.entities.slice(4, 8)
    const copy2Ids = new Set(copy2.map((e) => e.id))
    const copy2Constraints = r.constraints.filter((c) =>
      (c.kind === 'horizontal' || c.kind === 'vertical') &&
      'line' in c && c.line !== undefined && copy2Ids.has(c.line))
    expect(copy2Constraints).toHaveLength(4)
    // l1/l3 (source horizontal) -> vertical; l2/l4 (source vertical) -> horizontal.
    const l1Copy = copy2[0].id, l2Copy = copy2[1].id, l3Copy = copy2[2].id, l4Copy = copy2[3].id
    const kindOf = (lineId: string) =>
      copy2Constraints.find((c) => 'line' in c && c.line === lineId)?.kind
    expect(kindOf(l1Copy)).toBe('vertical')
    expect(kindOf(l3Copy)).toBe('vertical')
    expect(kindOf(l2Copy)).toBe('horizontal')
    expect(kindOf(l4Copy)).toBe('horizontal')
  })

  it('BUG-495 repro: a 45deg copy solves as a rigid rotated rectangle, not a deformed square', async () => {
    const { entities, constraints } = rectangle()
    const r = circularPattern(
      entities, constraints, ['l1', 'l2', 'l3', 'l4'], 3, { x: 0, y: 0 }, Math.PI / 4, newId)
    if (typeof r === 'string') throw new Error(r)

    const doc = sketch(
      [...entities, ...r.entities],
      [...constraints, ...r.constraints],
    )
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, doc)
    expect(out.ok).toBe(true)
    if (!out.ok) return

    // Copy 1 (45deg): still the source's exact side lengths (rigid), not
    // resized down to a small axis-aligned square (the BUG-495 symptom).
    const copy1Ids = r.entities.slice(0, 4).map((e) => e.id)
    const lengths = sideLengths(out.entities, copy1Ids)
    for (const len of lengths) {
      expect([W, H]).toContainEqual(expect.closeTo(len, 3))
    }
    // Area check mirrors the WO's repro framing directly.
    const area = lengths[0] * lengths[1]
    expect(area).toBeCloseTo(W * H, 3)

    gcs.destroy_gcs_module()
  })

  it('a 90deg step still solves correctly (no regression at an axis-aligned rotation)', async () => {
    const { entities, constraints } = rectangle()
    const r = circularPattern(
      entities, constraints, ['l1', 'l2', 'l3', 'l4'], 2, { x: 0, y: 0 }, Math.PI / 2, newId)
    if (typeof r === 'string') throw new Error(r)

    const doc = sketch(
      [...entities, ...r.entities],
      [...constraints, ...r.constraints],
    )
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, doc)
    expect(out.ok).toBe(true)
    if (!out.ok) return

    const copyIds = r.entities.map((e) => e.id)
    const lengths = sideLengths(out.entities, copyIds)
    for (const len of lengths) {
      expect([W, H]).toContainEqual(expect.closeTo(len, 3))
    }
    expect(out.status.conflicting).toEqual([])

    gcs.destroy_gcs_module()
  })

  it('other internal constraint kinds (parallel) are unaffected -- remapped verbatim at any rotation', () => {
    const entities: SketchEntity[] = [line('a', 0, 0, 10, 0), line('b', 0, 5, 10, 5)]
    const constraints: SketchConstraint[] = [{ id: 'pa', kind: 'parallel', a: 'a', b: 'b' }]
    const r = circularPattern(entities, constraints, ['a', 'b'], 2, { x: 0, y: 0 }, Math.PI / 4, newId)
    if (typeof r === 'string') throw new Error(r)
    expect(r.constraints.filter((c) => c.kind === 'parallel')).toHaveLength(1)
  })
})
