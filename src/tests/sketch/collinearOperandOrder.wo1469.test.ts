// WO-1469: Collinear must converge regardless of which line was clicked
// first. BUG-499 (audit family K7): the collinear mapping composed
// parallel(a,b) + point_on_line_pl(a:start, b) unconditionally, privileging
// operand `a`'s :start point -- so selecting a FIXED reference line first,
// then a FREE line, pinned the fixed (immovable) point onto the free line's
// infinite line, which is worse-conditioned for DogLeg than the reverse
// (free point pinned onto the fixed line) even though both express the SAME
// feasible geometry. Reversing the click order used to change which point
// got pinned and therefore whether the solve converged.
//
// The fix (gcsMapping.ts collinear case): when exactly one operand is fully
// fixed, always pin the FREE line's point onto the FIXED line, independent
// of a/b assignment -- so both selection orders resolve to the identical
// primitive and converge identically. When neither or both operands are
// fully fixed, the original a-onto-b default is kept unchanged.

import { describe, it, expect } from 'vitest'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Sketch, SketchEntity, SketchLineEntity, SketchConstraint, SketchDimension,
} from '../../lib/sketch/types'

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchLineEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

function sketch(
  entities: SketchEntity[], constraints: SketchConstraint[], dimensions: SketchDimension[] = [],
): Sketch {
  return {
    id: 'sk', layerId: 'layer', entities, constraints, dimensions,
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

function isZeroLine(l: SketchLineEntity): boolean {
  return Math.hypot(l.end.x - l.start.x, l.end.y - l.start.y) < 1e-9
}

// Fixed reference line A: (0,0)-(10,0). Free line B: an offset+rotated
// segment found by a runtime probe against the raw wrapper (see WO-1469
// worker result) to FAIL with the pre-fix mapping when A is operand `a`
// (fixed-then-free selection order) and SUCCEED when B is operand `a`
// (free-then-fixed) -- i.e. a genuine order-dependent convergence case, not
// a hypothetical one.
const A_START = { x: 0, y: 0 }
const A_END = { x: 10, y: 0 }
const B_START = { x: 0.5358983848622452, y: 6 }
const B_END = { x: 7.464101615137755, y: 10 }

describe('collinear converges regardless of selection order (WO-1469 / BUG-499)', () => {
  it('fixed-then-free: converges to a nonzero line, fixed reference unchanged', async () => {
    const gcs = await createGcsWrapper()
    const sk = sketch(
      [line('A', A_START.x, A_START.y, A_END.x, A_END.y),
        line('B', B_START.x, B_START.y, B_END.x, B_END.y)],
      [
        { id: 'fxA', kind: 'fix', entityId: 'A' },
        { id: 'col', kind: 'collinear', a: 'A', b: 'B' }, // A (fixed) selected first
      ],
    )
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const a = solvedLine(out.entities, 'A')
    const b = solvedLine(out.entities, 'B')
    expect(a.start).toEqual(A_START)
    expect(a.end).toEqual(A_END)
    expect(isZeroLine(b)).toBe(false)
    expect(Math.abs(cross(a, b))).toBeLessThan(1e-6)
    expect(b.start.y).toBeCloseTo(0, 6)
    expect(b.end.y).toBeCloseTo(0, 6)
    expect(out.status.conflicting).toEqual([])
    gcs.destroy_gcs_module()
  })

  it('free-then-fixed: converges to the SAME nonzero line as the reverse order', async () => {
    const gcs = await createGcsWrapper()
    const sk = sketch(
      [line('A', A_START.x, A_START.y, A_END.x, A_END.y),
        line('B', B_START.x, B_START.y, B_END.x, B_END.y)],
      [
        { id: 'fxA', kind: 'fix', entityId: 'A' },
        { id: 'col', kind: 'collinear', a: 'B', b: 'A' }, // B (free) selected first
      ],
    )
    const out = solveSketchOnWrapper(gcs, sk)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const a = solvedLine(out.entities, 'A')
    const b = solvedLine(out.entities, 'B')
    expect(a.start).toEqual(A_START)
    expect(a.end).toEqual(A_END)
    expect(isZeroLine(b)).toBe(false)
    expect(Math.abs(cross(a, b))).toBeLessThan(1e-6)
    expect(b.start.y).toBeCloseTo(0, 6)
    expect(b.end.y).toBeCloseTo(0, 6)
    expect(out.status.conflicting).toEqual([])
    gcs.destroy_gcs_module()
  })

  it('large-offset free line still converges in both orders', async () => {
    const bigB = { start: { x: 2, y: 5000 }, end: { x: 9, y: 5008 } }
    for (const [aId, bId] of [['A', 'B'], ['B', 'A']] as const) {
      const gcs = await createGcsWrapper()
      const sk = sketch(
        [line('A', A_START.x, A_START.y, A_END.x, A_END.y),
          line('B', bigB.start.x, bigB.start.y, bigB.end.x, bigB.end.y)],
        [
          { id: 'fxA', kind: 'fix', entityId: 'A' },
          { id: 'col', kind: 'collinear', a: aId, b: bId },
        ],
      )
      const out = solveSketchOnWrapper(gcs, sk)
      expect(out.ok).toBe(true)
      if (out.ok) {
        const b = solvedLine(out.entities, 'B')
        expect(b.start.y).toBeCloseTo(0, 3)
        expect(b.end.y).toBeCloseTo(0, 3)
      }
      gcs.destroy_gcs_module()
    }
  })

  it('dimensioned free line (driving length) still converges in both orders', async () => {
    for (const [aId, bId] of [['A', 'B'], ['B', 'A']] as const) {
      const gcs = await createGcsWrapper()
      const sk = sketch(
        [line('A', A_START.x, A_START.y, A_END.x, A_END.y),
          line('B', B_START.x, B_START.y, B_END.x, B_END.y)],
        [
          { id: 'fxA', kind: 'fix', entityId: 'A' },
          { id: 'col', kind: 'collinear', a: aId, b: bId },
        ],
        [
          { id: 'lenB', kind: 'distance', driving: true,
            a: { entityId: 'B', site: 'start' }, b: { entityId: 'B', site: 'end' },
            value: Math.hypot(B_END.x - B_START.x, B_END.y - B_START.y) },
        ],
      )
      const out = solveSketchOnWrapper(gcs, sk)
      expect(out.ok).toBe(true)
      if (out.ok) {
        const b = solvedLine(out.entities, 'B')
        expect(b.start.y).toBeCloseTo(0, 3)
        expect(b.end.y).toBeCloseTo(0, 3)
      }
      gcs.destroy_gcs_module()
    }
  })

  it('a genuinely infeasible collinear still fails and rolls back, in both orders', async () => {
    // B's start is pinned by a coincident to a fixed point C that is OFF
    // line A -- collinear then demands B's start also lie on A, a real
    // over-constraint with a free variable in play (not the vacuous
    // both-fully-fixed case, where planegcs reports trivial success without
    // checking the fixed values actually agree).
    for (const [aId, bId] of [['A', 'B'], ['B', 'A']] as const) {
      const gcs = await createGcsWrapper()
      const sk: Sketch = {
        id: 'sk', layerId: 'layer',
        entities: [
          line('A', 0, 0, 10, 0), line('B', 4, 3, 9, 4),
          { id: 'C', kind: 'point', construction: false, at: { x: 5, y: 5 } },
        ],
        constraints: [
          { id: 'fxA', kind: 'fix', entityId: 'A' },
          { id: 'fxC', kind: 'fix', entityId: 'C' },
          { id: 'coin', kind: 'coincident',
            a: { entityId: 'B', site: 'start' }, b: { entityId: 'C', site: 'self' } },
          { id: 'col', kind: 'collinear', a: aId, b: bId },
        ],
        dimensions: [], solveStatus: { dof: 0, conflicting: [], redundant: [] },
      }
      const out = solveSketchOnWrapper(gcs, sk)
      expect(out.ok).toBe(false)
      gcs.destroy_gcs_module()
    }
  })
})
