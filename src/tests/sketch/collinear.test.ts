// Collinear constraint (Tier 3b): two lines lie on the SAME infinite line.
// planegcs has no collinear primitive, so the mapping expresses it as the
// documented composition parallel + point-on-line (ADR-0003). These tests
// cover BOTH the mapping shape (the two primitives) and the solved
// behavior (same direction + endpoint-on-line, DoF drops by 2). Mirrors
// solver.test.ts (real GcsWrapper) and constraintApply selection-plan style.

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import {
  solveSketchOnWrapper, sketchToGcsPrimitives,
} from '../../lib/sketch/solver/gcsMapping'
import { planConstraintForSelection } from '../../lib/sketch/constraintActions'
import { constraintRefIds } from '../../lib/sketch/refIds'
import { BADGE_TEXT } from '../../lib/sketch/sketcher/sketchLayer'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchConstraint,
} from '../../lib/sketch/types'

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

function sketch(entities: SketchEntity[], constraints: SketchConstraint[]): Sketch {
  return {
    id: 'sk', layerId: 'layer', entities, constraints, dimensions: [],
    solveStatus: { dof: 0, conflicting: [], redundant: [] },
  }
}

function solvedLine(entities: SketchEntity[], id: string): SketchLineEntity {
  const e = entities.find((x) => x.id === id)
  if (!e || e.kind !== 'line') throw new Error(`no line ${id}`)
  return e
}

function cross(a: SketchLineEntity, b: SketchLineEntity): number {
  const ax = a.end.x - a.start.x, ay = a.end.y - a.start.y
  const bx = b.end.x - b.start.x, by = b.end.y - b.start.y
  return ax * by - ay * bx
}

// ---- a. mapping shape -------------------------------------------------------

describe('collinear mapping (parallel + point-on-line composition)', () => {
  it('emits BOTH a parallel and a point_on_line_pl primitive, owned by the constraint', () => {
    const sk = sketch(
      [line('A', 0, 0, 10, 0), line('B', 0, 3, 8, 4)],
      [{ id: 'col', kind: 'collinear', a: 'A', b: 'B' }],
    )
    const prims = sketchToGcsPrimitives(sk)
    const parallel = prims.find((p) => p.type === 'parallel')
    const onLine = prims.find((p) => p.type === 'point_on_line_pl')
    expect(parallel).toBeDefined()
    expect(onLine).toBeDefined()
    // Both ids derive from the document constraint id (so conflict
    // diagnosis maps them back to the one 'col' constraint).
    expect((parallel as { id: string }).id.startsWith('col')).toBe(true)
    expect((onLine as { id: string }).id.startsWith('col')).toBe(true)
    // The point-on-line drops A's start endpoint onto line B's infinite line.
    expect(onLine).toMatchObject({ p_id: 'A:start', l_id: 'B' })
    expect(parallel).toMatchObject({ l1_id: 'A', l2_id: 'B' })
  })

  it('refIds reports both lines; the badge glyph is defined and distinct', () => {
    const c: SketchConstraint = { id: 'col', kind: 'collinear', a: 'A', b: 'B' }
    expect(constraintRefIds(c)).toEqual(['A', 'B'])
    // Glyph exists and does not collide with parallel/perpendicular/midpoint.
    expect(BADGE_TEXT.collinear).toBeTruthy()
    expect(BADGE_TEXT.collinear).not.toBe(BADGE_TEXT.parallel)
    expect(BADGE_TEXT.collinear).not.toBe(BADGE_TEXT.perpendicular)
    expect(BADGE_TEXT.collinear).not.toBe(BADGE_TEXT.midpoint)
  })
})

// ---- b. solved behavior -----------------------------------------------------

describe('collinear solve behavior', () => {
  it('makes two offset parallel-ish lines collinear: same direction AND endpoint on line', async () => {
    const gcs = await createGcsWrapper()
    // A grounded on y=0; B offset (+3/+4) and slightly rotated.
    const sk = sketch(
      [line('A', 0, 0, 10, 0), line('B', 2, 3, 8, 4)],
      [
        { id: 'fxA', kind: 'fix', entityId: 'A' },
        { id: 'col', kind: 'collinear', a: 'A', b: 'B' },
      ],
    )
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const a = solvedLine(out.entities, 'A')
    const b = solvedLine(out.entities, 'B')
    // Same direction (parallel): cross product ~ 0.
    expect(Math.abs(cross(a, b))).toBeLessThan(1e-6)
    // On A's infinite line (y = 0): both B endpoints land on it.
    expect(b.start.y).toBeCloseTo(0, 6)
    expect(b.end.y).toBeCloseTo(0, 6)
    expect(out.status.conflicting).toEqual([])
    gcs.destroy_gcs_module()
  })

  it('drops DoF by exactly 2 versus the same sketch without the constraint', async () => {
    const gcs = await createGcsWrapper()
    const ents = (): SketchEntity[] => [line('A', 0, 0, 10, 0), line('B', 2, 3, 8, 4)]
    const without = sketch(ents(), [{ id: 'fxA', kind: 'fix', entityId: 'A' }])
    const withCol = sketch(ents(), [
      { id: 'fxA', kind: 'fix', entityId: 'A' },
      { id: 'col', kind: 'collinear', a: 'A', b: 'B' },
    ])
    const r0 = solveSketchOnWrapper(gcs, without)
    const r1 = solveSketchOnWrapper(gcs, withCol)
    expect(r0.ok && r1.ok).toBe(true)
    if (!r0.ok || !r1.ok) return
    // A fixed -> 0 free; B has 4 free params; collinear removes 2.
    expect(r0.status.dof).toBe(4)
    expect(r1.status.dof).toBe(2)
    expect(r1.status.redundant).toEqual([])
    gcs.destroy_gcs_module()
  })

  it('two FREE lines become collinear (no grounding): direction + offset satisfied', async () => {
    const gcs = await createGcsWrapper()
    const sk = sketch(
      [line('A', 0, 0, 10, 0), line('B', 1, 5, 9, 6)],
      [{ id: 'col', kind: 'collinear', a: 'A', b: 'B' }],
    )
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const a = solvedLine(out.entities, 'A')
    const b = solvedLine(out.entities, 'B')
    // Same direction.
    expect(Math.abs(cross(a, b))).toBeLessThan(1e-6)
    // A's start lies on B's infinite line: signed perpendicular distance ~ 0.
    const bx = b.end.x - b.start.x, by = b.end.y - b.start.y
    const blen = Math.hypot(bx, by)
    const perp = ((a.start.x - b.start.x) * by - (a.start.y - b.start.y) * bx) / blen
    expect(Math.abs(perp)).toBeLessThan(1e-6)
    // Two free lines (8 params) - 2 = 6 DoF remain.
    expect(out.status.dof).toBe(6)
    gcs.destroy_gcs_module()
  })
})

// ---- c. selection plan ------------------------------------------------------

describe('planConstraintForSelection - collinear', () => {
  const sk = sketch(
    [line('l1', 0, 0, 10, 0), line('l2', 0, 5, 10, 5), line('l3', 0, 9, 10, 9),
      { id: 'circ', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 1 }],
    [],
  )

  it('two lines -> one collinear constraint between them', () => {
    const r = planConstraintForSelection(sk, ['l1', 'l2'], 'collinear')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.constraints).toHaveLength(1)
    expect(r.constraints[0]).toMatchObject({ kind: 'collinear', a: 'l1', b: 'l2' })
  })

  it('three lines -> two constraints, all sharing the first line', () => {
    const r = planConstraintForSelection(sk, ['l1', 'l2', 'l3'], 'collinear')
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.constraints).toHaveLength(2)
    for (const c of r.constraints) {
      expect(c.kind).toBe('collinear')
      expect((c as Extract<SketchConstraint, { kind: 'collinear' }>).a).toBe('l1')
    }
  })

  it('rejects a non-line operand (a line + a circle)', () => {
    const r = planConstraintForSelection(sk, ['l1', 'circ'], 'collinear')
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.reason).toMatch(/two or more lines/)
  })
})
