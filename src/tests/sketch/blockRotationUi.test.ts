// SKC-ROTATION-SOLVABLE UI-planning gates: creating an orientation constraint
// or an angle dimension ON a block, in the SHARED sketch package (so both the
// CAM and Model-workspace sketchers get it -- parity by construction).
//
// The solver contribution is proven in blockRotationSolvable.test.ts; here we
// prove the pure PLANNING layer both hosts share turns a block selection/pick
// into the right constraint/dimension object:
//   (i)   planConstraintForSelection accepts a block as a line-like operand for
//         horizontal / vertical / parallel / perpendicular (and refuses it for
//         collinear, which the solver cannot express on a block),
//   (ii)  planDimension turns a block + reference line into an ANGLE dimension,
//   (iii) resolveDimPlacement commits that angle in the NEAR sector (reverseB
//         false -- the solver refuses the far sector on a block).

import { describe, it, expect } from 'vitest'
import { planConstraintForSelection } from '../../lib/sketch/constraintActions'
import { planDimension, angleOperandSegment, lineAngle } from '../../lib/sketch/tools/dimTool'
import { resolveDimPlacement } from '../../lib/sketch/tools/dimPlacement'
import { groupIntoBlock } from '../../lib/sketch/blocks'
import type {
  Sketch, SketchLineEntity, SketchConstraint, PointRef, SketchBlockEntity,
} from '../../lib/sketch/types'

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}
function ref(entityId: string, site: PointRef['site']): PointRef {
  return { entityId, site }
}
function rectEntities(): SketchLineEntity[] {
  return [
    line('l1', 0, 0, 40, 0), line('l2', 40, 0, 40, 30),
    line('l3', 40, 30, 0, 30), line('l4', 0, 30, 0, 0),
  ]
}
function rectConstraints(): SketchConstraint[] {
  return [
    { id: 'c12', kind: 'coincident', a: ref('l1', 'end'), b: ref('l2', 'start') },
    { id: 'c23', kind: 'coincident', a: ref('l2', 'end'), b: ref('l3', 'start') },
    { id: 'c34', kind: 'coincident', a: ref('l3', 'end'), b: ref('l4', 'start') },
    { id: 'c41', kind: 'coincident', a: ref('l4', 'end'), b: ref('l1', 'start') },
  ]
}
let seq = 0
const detId = () => `blk-${++seq}`

/** A grouped block plus a standalone reference line at `refDeg` degrees. */
function blockAndRefLine(refDeg: number): { sketch: Sketch; blockId: string } {
  const grouped = groupIntoBlock(
    { id: 'sk', layerId: 'L', entities: rectEntities(), constraints: rectConstraints(), dimensions: [], solveStatus: null },
    ['l1', 'l2', 'l3', 'l4'], detId)
  if (!grouped.ok) throw new Error('group refused')
  const a = (refDeg * Math.PI) / 180
  const lref = line('lref', 0, 0, 20 * Math.cos(a), 20 * Math.sin(a))
  return {
    sketch: { ...grouped.sketch, entities: [...grouped.sketch.entities, lref] },
    blockId: grouped.blockId,
  }
}

// ---- (i) constraint planning -----------------------------------------------

describe('SKC-ROTATION-SOLVABLE UI: constraint planning accepts a block orientation', () => {
  it('PARALLEL of a block and a reference line -> a parallel constraint between them', () => {
    const { sketch, blockId } = blockAndRefLine(30)
    const r = planConstraintForSelection(sketch, [blockId, 'lref'], 'parallel')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.constraints).toHaveLength(1)
    const c = r.constraints[0]
    expect(c.kind).toBe('parallel')
    if (c.kind !== 'parallel') return
    expect([c.a, c.b].sort()).toEqual([blockId, 'lref'].sort())
  })

  it('HORIZONTAL on a lone block -> a horizontal constraint on the block orientation line', () => {
    const { sketch, blockId } = blockAndRefLine(30)
    const r = planConstraintForSelection(sketch, [blockId], 'horizontal')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.constraints).toHaveLength(1)
    const c = r.constraints[0]
    expect(c.kind).toBe('horizontal')
    if (c.kind !== 'horizontal') return
    expect(c.line).toBe(blockId)
  })

  it('PERPENDICULAR of a block and a reference line -> a perpendicular constraint', () => {
    const { sketch, blockId } = blockAndRefLine(30)
    const r = planConstraintForSelection(sketch, [blockId, 'lref'], 'perpendicular')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.constraints[0].kind).toBe('perpendicular')
  })

  it('COLLINEAR refuses a block by name (the solver cannot express it on an orientation line)', () => {
    const { sketch, blockId } = blockAndRefLine(30)
    const r = planConstraintForSelection(sketch, [blockId, 'lref'], 'collinear')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/lines/i)
  })
})

// ---- (ii) angle dimension planning -----------------------------------------

describe('SKC-ROTATION-SOLVABLE UI: a block + line dimensions as an ANGLE', () => {
  it('planDimension(block, line) -> an angle plan whose value is the directed angle between them', () => {
    const { sketch, blockId } = blockAndRefLine(0) // block rotation 0, lref along +X
    const out = planDimension(sketch.entities, [blockId, 'lref'])
    expect(out.ok).toBe(true)
    if (!out.ok) return
    expect(out.plan.kind).toBe('angle')
    if (out.plan.kind !== 'angle') return
    // Both lie along +X at create time -> zero directed angle (a no-motion dim).
    expect(Math.abs(out.plan.value)).toBeLessThan(1e-9)
    expect([out.plan.a, out.plan.b].sort()).toEqual([blockId, 'lref'].sort())
  })

  it('the measured angle tracks the block rotation (block at 25deg vs +X line -> ~25deg)', () => {
    const { sketch, blockId } = blockAndRefLine(0)
    const rotated = sketch.entities.map((e) =>
      e.id === blockId ? { ...(e as SketchBlockEntity), rotation: (25 * Math.PI) / 180 } : e)
    const out = planDimension(rotated, ['lref', blockId]) // order: lref then block
    expect(out.ok).toBe(true)
    if (!out.ok || out.plan.kind !== 'angle') return
    expect(Math.abs(Math.abs(out.plan.value) - (25 * Math.PI) / 180)).toBeLessThan(1e-6)
  })
})

// ---- (iii) angle placement commits the NEAR sector -------------------------

describe('SKC-ROTATION-SOLVABLE UI: block angle commits in the near sector', () => {
  it('resolveDimPlacement never reverses operand B for a block angle (reverseB false)', () => {
    const { sketch, blockId } = blockAndRefLine(0)
    const rotated = sketch.entities.map((e) =>
      e.id === blockId ? { ...(e as SketchBlockEntity), rotation: (40 * Math.PI) / 180 } : e)
    // Drop the label anchor on the far side of the intersection -- for a real
    // line pair this could pick the obtuse sector; for a block it must not.
    const res = resolveDimPlacement(rotated, [blockId, 'lref'], { x: -30, y: -30 })
    expect(res).not.toBeNull()
    if (!res) return
    expect(res.plan.kind).toBe('angle')
    if (res.plan.kind !== 'angle') return
    expect(res.plan.reverseB ?? false).toBe(false)
    // Value is the raw directed angle between the two segments (no-motion).
    const segBlk = angleOperandSegment(rotated.find((e) => e.id === blockId)!)!
    const segRef = angleOperandSegment(rotated.find((e) => e.id === 'lref')!)!
    expect(Math.abs(res.plan.value - lineAngle(segBlk, segRef))).toBeLessThan(1e-9)
  })
})
