// WO-1567: split a sketch line, arc or circle at a clicked point without
// deleting anything — trim's mirror image (both pieces survive, joined by
// a coincident constraint). Exercises the same click-path entry point
// (splitClick) trimTool.test.ts uses for trimAtPoint.

import { describe, it, expect } from 'vitest'
import { splitClick, type SketchDoc, type SplitChainState } from '../../lib/sketch/tools/splitTool'
import { arcSweep } from '../../lib/sketch/tools/trimTool'
import { constraintRefIds, dimensionRefIds } from '../../lib/sketch/refIds'
import type {
  SketchEntity, SketchConstraint, SketchDimension,
  SketchArcEntity, SketchLineEntity,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `new-${n++}`

function line(id: string, x1: number, y1: number, x2: number, y2: number): SketchEntity {
  return { id, kind: 'line', construction: false, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
}

function arc(
  id: string, cx: number, cy: number, r: number, startAngle: number, endAngle: number,
): SketchEntity {
  return {
    id, kind: 'arc', construction: false,
    center: { x: cx, y: cy }, radius: r, startAngle, endAngle,
  }
}

function circle(id: string, cx: number, cy: number, r: number): SketchEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius: r }
}

function doc(
  entities: SketchEntity[],
  constraints: SketchConstraint[] = [],
  dimensions: SketchDimension[] = [],
): SketchDoc {
  return { entities, constraints, dimensions }
}

function assertNoDangling(d: { entities: SketchEntity[]; constraints: SketchConstraint[]; dimensions: SketchDimension[] }) {
  const live = new Set(d.entities.map((e) => e.id))
  for (const c of d.constraints) {
    for (const ref of constraintRefIds(c)) {
      expect(live.has(ref), `constraint ${c.id} dangles on ${ref}`).toBe(true)
    }
  }
  for (const dim of d.dimensions) {
    for (const ref of dimensionRefIds(dim)) {
      expect(live.has(ref), `dimension ${dim.id} dangles on ${ref}`).toBe(true)
    }
  }
}

describe('splitClick - line target', () => {
  it('a horizontal-constrained 100mm line splits at x=30 into 30/70mm pieces, both horizontal, joined coincident', () => {
    const constraints: SketchConstraint[] = [
      { id: 'c-horiz', kind: 'horizontal', line: 'T' },
    ]
    const d = doc([line('T', 0, 0, 100, 0)], constraints)
    const r = splitClick(null, d, { x: 30, y: 0 }, 0.5, newId)
    expect(r.chain).toBeNull()
    const t = r.transform!
    expect(t.entities).toHaveLength(2)

    const a = t.entities.find((e) => e.id === 'T') as SketchLineEntity
    const b = t.entities.find((e) => e.id !== 'T') as SketchLineEntity
    expect(a.kind).toBe('line')
    expect(b.kind).toBe('line')
    expect(a.start).toEqual({ x: 0, y: 0 })
    expect(a.end.x).toBeCloseTo(30, 9)
    expect(b.start.x).toBeCloseTo(30, 9)
    expect(b.end).toEqual({ x: 100, y: 0 })

    // horizontal propagated to both pieces.
    const horiz = t.constraints.filter((c) => c.kind === 'horizontal')
    expect(horiz).toHaveLength(2)
    expect(horiz.map((c) => c.kind === 'horizontal' && c.line).sort()).toEqual(['T', b.id].sort())

    // Joined by exactly one coincident constraint at the cut.
    const coincident = t.constraints.filter((c) => c.kind === 'coincident')
    expect(coincident).toHaveLength(1)
    const joint = coincident[0]
    if (joint.kind === 'coincident') {
      expect([joint.a, joint.b]).toContainEqual({ entityId: 'T', site: 'end' })
      expect([joint.a, joint.b]).toContainEqual({ entityId: b.id, site: 'start' })
    }
    assertNoDangling(t)
  })

  it('a click that snaps to an existing endpoint changes nothing and explains why', () => {
    const d = doc([line('T', 0, 0, 100, 0)])
    const r = splitClick(null, d, { x: 0, y: 0 }, 0.5, newId)
    expect(r.transform).toBeNull()
    expect(r.notice).toMatch(/endpoint/i)
  })

  it('a length dimension spanning the original start/end is dropped, not stale-converted', () => {
    const dims: SketchDimension[] = [
      { id: 'd-len', kind: 'distance', driving: true, value: 100,
        a: { entityId: 'T', site: 'start' }, b: { entityId: 'T', site: 'end' } },
    ]
    const d = doc([line('T', 0, 0, 100, 0)], [], dims)
    const r = splitClick(null, d, { x: 30, y: 0 }, 0.5, newId)
    const t = r.transform!
    expect(t.dimensions.find((dim) => dim.id === 'd-len')).toBeUndefined()
    expect(r.notice).toMatch(/dropped/i)
    assertNoDangling(t)
  })

  it('an empty click is a quiet no-op', () => {
    const d = doc([line('T', 0, 0, 100, 0)])
    const r = splitClick(null, d, { x: 500, y: 500 }, 0.5, newId)
    expect(r.transform).toBeNull()
    expect(r.chain).toBeNull()
  })
})

describe('splitClick - arc target', () => {
  it('an arc split at its midpoint yields two arcs whose sweeps sum to the original', () => {
    // Half-circle: startAngle 0, endAngle PI, sweep = PI. Midpoint at PI/2.
    const d = doc([arc('A', 0, 0, 10, 0, Math.PI)])
    const mid = { x: 10 * Math.cos(Math.PI / 2), y: 10 * Math.sin(Math.PI / 2) }
    const r = splitClick(null, d, mid, 0.5, newId)
    const t = r.transform!
    expect(t.entities).toHaveLength(2)
    const a = t.entities.find((e) => e.id === 'A') as SketchArcEntity
    const b = t.entities.find((e) => e.id !== 'A') as SketchArcEntity
    expect(a.kind).toBe('arc')
    expect(b.kind).toBe('arc')
    expect(a.radius).toBe(10)
    expect(b.radius).toBe(10)
    const sweepA = arcSweep(a)
    const sweepB = arcSweep(b)
    expect(sweepA + sweepB).toBeCloseTo(Math.PI, 6)

    const coincident = t.constraints.filter((c) => c.kind === 'coincident')
    expect(coincident).toHaveLength(1)
    assertNoDangling(t)
  })

  it('equal-radius (arc/arc) survives split — trimming/splitting never changes the radius', () => {
    const constraints: SketchConstraint[] = [
      { id: 'c-eq', kind: 'equal', a: 'A', b: 'other' },
    ]
    const d = doc(
      [arc('A', 0, 0, 10, 0, Math.PI), arc('other', 50, 50, 10, 0, Math.PI)],
      constraints,
    )
    const mid = { x: 10 * Math.cos(Math.PI / 2), y: 10 * Math.sin(Math.PI / 2) }
    const r = splitClick(null, d, mid, 0.5, newId)
    const t = r.transform!
    expect(t.constraints.some((c) => c.id === 'c-eq')).toBe(true)
    assertNoDangling(t)
  })
})

describe('splitClick - circle target (two-point stage)', () => {
  it('two clicks split a circle into two arcs covering 360deg, joined at both points', () => {
    const d = doc([circle('C', 0, 0, 5)])
    const first = { x: 5, y: 0 }   // angle 0
    const second = { x: -5, y: 0 } // angle PI

    const staged = splitClick(null, d, first, 0.5, newId)
    expect(staged.transform).toBeNull()
    expect(staged.chain).toEqual<SplitChainState>({ kind: 'split', targetId: 'C', first })
    expect(staged.notice).toMatch(/second point/i)

    const r = splitClick(staged.chain, d, second, 0.5, newId)
    expect(r.chain).toBeNull()
    const t = r.transform!
    expect(t.entities).toHaveLength(2)
    const a = t.entities.find((e) => e.id === 'C') as SketchArcEntity
    const b = t.entities.find((e) => e.id !== 'C') as SketchArcEntity
    expect(a.kind).toBe('arc')
    expect(b.kind).toBe('arc')
    expect(a.radius).toBe(5)
    expect(b.radius).toBe(5)
    const sweepA = arcSweep(a)
    const sweepB = arcSweep(b)
    expect(sweepA + sweepB).toBeCloseTo(2 * Math.PI, 6)

    // Two coincident constraints — one at each of the two cut points.
    const coincident = t.constraints.filter((c) => c.kind === 'coincident')
    expect(coincident).toHaveLength(2)
    assertNoDangling(t)
  })

  it('Escape (dropping the chain) abandons the staged point — a fresh click re-stages', () => {
    const d = doc([circle('C', 0, 0, 5)])
    const staged = splitClick(null, d, { x: 5, y: 0 }, 0.5, newId)
    expect(staged.chain).not.toBeNull()
    // Simulate Esc: caller drops the chain (toolMachine's generic escapeTool
    // behavior for any non-null chain), then arms fresh.
    const restaged = splitClick(null, d, { x: 0, y: 5 }, 0.5, newId)
    expect(restaged.chain?.first).toEqual({ x: 0, y: 5 })
  })

  it('a second point matching the first stays staged and explains why', () => {
    const d = doc([circle('C', 0, 0, 5)])
    const staged = splitClick(null, d, { x: 5, y: 0 }, 0.5, newId)
    const r = splitClick(staged.chain, d, { x: 5, y: 0 }, 0.5, newId)
    expect(r.transform).toBeNull()
    expect(r.chain).not.toBeNull()
    expect(r.notice).toMatch(/matches the first/i)
  })
})

describe('splitClick - full ellipse (two-point stage, like a circle)', () => {
  // WO-1581: ellipse/elliptical-arc and spline are now split-able (see
  // splitTool.wo1581.test.ts) — a full ellipse stages a second point
  // exactly like a circle, so a single click still leaves transform null
  // and names the kind, same shape as the circle staging test above.
  it('a single click on a full ellipse stages the second point instead of splitting', () => {
    const d = doc([
      { id: 'E', kind: 'ellipse', construction: false,
        center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0 } as SketchEntity,
    ])
    const r = splitClick(null, d, { x: 10, y: 0 }, 0.5, newId)
    expect(r.transform).toBeNull()
    expect(r.notice).toMatch(/ellipse/i)
  })
})
