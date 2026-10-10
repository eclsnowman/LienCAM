// WO-1581: split also works on ellipses, elliptical arcs and splines —
// extends WO-1567's split tool (splitTool.wo1567.test.ts covers line/arc/
// circle). Exercises the same click-path entry point (splitClick).

import { describe, it, expect } from 'vitest'
import { splitClick, type SketchDoc, type SplitChainState } from '../../lib/sketch/tools/splitTool'
import { ellipticalArcSweep, ellipsePointAt } from '../../lib/sketch/ellipse'
import { splinePointAt, nearestParamOnSpline } from '../../lib/sketch/spline'
import { constraintRefIds, dimensionRefIds } from '../../lib/sketch/refIds'
import type {
  SketchEntity, SketchConstraint, SketchDimension,
  SketchEllipticalArcEntity, SketchSplineEntity,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `new-${n++}`

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

describe('splitClick - elliptical-arc target (one click, like an arc)', () => {
  it('an elliptical arc split at its parameter midpoint yields two arcs whose spans sum to the original', () => {
    const e: SketchEntity = {
      id: 'A', kind: 'elliptical-arc', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
      startParam: 0, endParam: Math.PI,
    }
    const d = doc([e])
    const mid = ellipsePointAt(e as SketchEllipticalArcEntity, Math.PI / 2)
    const r = splitClick(null, d, mid, 0.5, newId)
    expect(r.chain).toBeNull()
    const t = r.transform!
    expect(t.entities).toHaveLength(2)
    const a = t.entities.find((x) => x.id === 'A') as SketchEllipticalArcEntity
    const b = t.entities.find((x) => x.id !== 'A') as SketchEllipticalArcEntity
    expect(a.kind).toBe('elliptical-arc')
    expect(b.kind).toBe('elliptical-arc')
    const sweepA = ellipticalArcSweep(a.startParam, a.endParam)
    const sweepB = ellipticalArcSweep(b.startParam, b.endParam)
    expect(sweepA + sweepB).toBeCloseTo(Math.PI, 6)

    // Solver-inert kind: fixed in place, NOT a coincident joint.
    expect(t.constraints.filter((c) => c.kind === 'coincident')).toHaveLength(0)
    expect(t.constraints.filter((c) => c.kind === 'fix')).toHaveLength(2)
    expect(r.notice).toMatch(/solver-inert/i)
    assertNoDangling(t)
  })

  it('a click that snaps to an existing endpoint changes nothing and explains why', () => {
    const d = doc([{
      id: 'A', kind: 'elliptical-arc', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
      startParam: 0, endParam: Math.PI,
    } as SketchEntity])
    const r = splitClick(null, d, { x: 10, y: 0 }, 0.5, newId)
    expect(r.transform).toBeNull()
    expect(r.notice).toMatch(/endpoint/i)
  })
})

describe('splitClick - full ellipse target (two-point stage, like a circle)', () => {
  it('two clicks split a full ellipse into two elliptical arcs covering it, fixed at both points', () => {
    const e: SketchEntity = {
      id: 'E', kind: 'ellipse', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
    }
    const d = doc([e])
    const first = { x: 10, y: 0 }                                  // param 0
    const second = ellipsePointAt(e, Math.PI) // param PI

    const staged = splitClick(null, d, first, 0.5, newId)
    expect(staged.transform).toBeNull()
    expect(staged.chain).toEqual<SplitChainState>({ kind: 'split', targetId: 'E', first })
    expect(staged.notice).toMatch(/second point/i)
    expect(staged.notice).toMatch(/ellipse/i)

    const r = splitClick(staged.chain, d, second, 0.5, newId)
    expect(r.chain).toBeNull()
    const t = r.transform!
    expect(t.entities).toHaveLength(2)
    const a = t.entities.find((x) => x.id === 'E') as SketchEllipticalArcEntity
    const b = t.entities.find((x) => x.id !== 'E') as SketchEllipticalArcEntity
    expect(a.kind).toBe('elliptical-arc')
    expect(b.kind).toBe('elliptical-arc')
    const sweepA = ellipticalArcSweep(a.startParam, a.endParam)
    const sweepB = ellipticalArcSweep(b.startParam, b.endParam)
    expect(sweepA + sweepB).toBeCloseTo(2 * Math.PI, 6)

    expect(t.constraints.filter((c) => c.kind === 'coincident')).toHaveLength(0)
    expect(t.constraints.filter((c) => c.kind === 'fix')).toHaveLength(4)
    assertNoDangling(t)
  })

  it('a second point matching the first stays staged and explains why', () => {
    const d = doc([{
      id: 'E', kind: 'ellipse', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
    } as SketchEntity])
    const staged = splitClick(null, d, { x: 10, y: 0 }, 0.5, newId)
    const r = splitClick(staged.chain, d, { x: 10, y: 0 }, 0.5, newId)
    expect(r.transform).toBeNull()
    expect(r.chain).not.toBeNull()
    expect(r.notice).toMatch(/matches the first/i)
  })
})

describe('splitClick - open spline target (one click)', () => {
  function openSpline(): SketchEntity {
    return {
      id: 'S', kind: 'spline', construction: false, closed: false,
      points: [{ x: 0, y: 0 }, { x: 5, y: 8 }, { x: 10, y: 0 }, { x: 15, y: -6 }, { x: 20, y: 0 }],
    }
  }

  it('a 5-point open spline split near its middle yields two splines matching the original within 0.001mm at 50 samples, joined coincident', () => {
    const src = openSpline() as SketchSplineEntity
    const d = doc([src])
    const clickPoint = splinePointAt(src.points, false, 1.7) // partway through segment 1
    const r = splitClick(null, d, clickPoint, 0.5, newId)
    expect(r.chain).toBeNull()
    const t = r.transform!
    expect(t.entities).toHaveLength(2)
    const a = t.entities.find((x) => x.id === 'S') as SketchSplineEntity
    const b = t.entities.find((x) => x.id !== 'S') as SketchSplineEntity
    expect(a.kind).toBe('spline')
    expect(b.kind).toBe('spline')
    expect(a.closed).toBe(false)
    expect(b.closed).toBe(false)

    // The pieces meet exactly (bit-identical resample of the same point).
    expect(a.points[a.points.length - 1]).toEqual(b.points[0])

    // Together they trace the ORIGINAL curve within 0.001mm at 50 samples.
    const maxQ = src.points.length - 1
    // The split parameter is wherever nearestParamOnSpline actually resolved
    // the click to (not assumed bit-exact to the 1.7 the click aimed for).
    const splitQ = nearestParamOnSpline(src.points, false, clickPoint)
    for (let i = 0; i <= 50; i++) {
      const q = (maxQ * i) / 50
      const expected = splinePointAt(src.points, false, q)
      // Find which piece covers this q: piece A covers [0, splitQ], piece B [splitQ, maxQ].
      const onA = q <= splitQ
      const localMax = onA ? splitQ : maxQ - splitQ
      const localQ = onA ? q : q - splitQ
      const piece = onA ? a : b
      const got = splinePointAt(piece.points, false, (localQ / localMax) * (piece.points.length - 1))
      expect(Math.hypot(got.x - expected.x, got.y - expected.y)).toBeLessThan(0.001)
    }

    const coincident = t.constraints.filter((c) => c.kind === 'coincident')
    expect(coincident).toHaveLength(1)
    const joint = coincident[0]
    if (joint.kind === 'coincident') {
      expect([joint.a, joint.b]).toContainEqual({ entityId: 'S', site: 'end' })
      expect([joint.a, joint.b]).toContainEqual({ entityId: b.id, site: 'start' })
    }
    assertNoDangling(t)
  })

  it('a click that snaps to an existing endpoint changes nothing and explains why', () => {
    const d = doc([openSpline()])
    const r = splitClick(null, d, { x: 0, y: 0 }, 0.5, newId)
    expect(r.transform).toBeNull()
    expect(r.notice).toMatch(/endpoint/i)
  })
})

describe('splitClick - closed spline target (two-point stage, like a circle)', () => {
  function closedSpline(): SketchEntity {
    return {
      id: 'S', kind: 'spline', construction: false, closed: true,
      points: [{ x: 10, y: 0 }, { x: 0, y: 10 }, { x: -10, y: 0 }, { x: 0, y: -10 }],
    }
  }

  it('two clicks split a closed spline into two open splines covering it, joined coincident at both points', () => {
    const src = closedSpline() as SketchSplineEntity
    const d = doc([src])
    const first = splinePointAt(src.points, true, 0.5)
    const second = splinePointAt(src.points, true, 2.5)

    const staged = splitClick(null, d, first, 0.5, newId)
    expect(staged.transform).toBeNull()
    expect(staged.chain).toEqual<SplitChainState>({ kind: 'split', targetId: 'S', first })
    expect(staged.notice).toMatch(/second point/i)

    const r = splitClick(staged.chain, d, second, 0.5, newId)
    expect(r.chain).toBeNull()
    const t = r.transform!
    expect(t.entities).toHaveLength(2)
    const a = t.entities.find((x) => x.id === 'S') as SketchSplineEntity
    const b = t.entities.find((x) => x.id !== 'S') as SketchSplineEntity
    expect(a.closed).toBe(false)
    expect(b.closed).toBe(false)

    const coincident = t.constraints.filter((c) => c.kind === 'coincident')
    expect(coincident).toHaveLength(2)
    assertNoDangling(t)
  })

  it('a second point matching the first stays staged and explains why', () => {
    const d = doc([closedSpline()])
    const staged = splitClick(null, d, { x: 10, y: 0 }, 0.5, newId)
    const r = splitClick(staged.chain, d, { x: 10, y: 0 }, 0.5, newId)
    expect(r.transform).toBeNull()
    expect(r.chain).not.toBeNull()
    expect(r.notice).toMatch(/matches the first/i)
  })

  it('a coincident constraint on the seam is dropped with a notice when the seam ends up interior to a piece (not silently re-anchored)', () => {
    const src = closedSpline() as SketchSplineEntity
    const line: SketchEntity = {
      id: 'L', kind: 'line', construction: false,
      start: { x: 10, y: 0 }, end: { x: 20, y: 0 },
    }
    const coincident: SketchConstraint = {
      id: 'C', kind: 'coincident',
      a: { entityId: 'L', site: 'start' }, b: { entityId: 'S', site: 'start' },
    }
    const d = doc([src, line], [coincident])
    // Same repro as the audit: neither cut lands on the seam (param 0), so
    // it is strictly interior to one piece after the split.
    const first = splinePointAt(src.points, true, 1)
    const second = splinePointAt(src.points, true, 2)

    const staged = splitClick(null, d, first, 0.5, newId)
    const r = splitClick(staged.chain, d, second, 0.5, newId)
    const t = r.transform!

    // No piece keeps the seam as an addressable endpoint, so per the
    // WO-1567 rule ("constraints on an endpoint follow the piece that keeps
    // that endpoint") the constraint must be DROPPED — never left pointing
    // at a piece's cut point, which would silently drag L to the wrong place
    // on the next solve.
    expect(t.constraints.some((c) => c.id === 'C')).toBe(false)
    expect(r.notice).toMatch(/seam/i)
    assertNoDangling(t)

    // L itself is untouched — dropping the constraint must not move it.
    const lOut = t.entities.find((e) => e.id === 'L') as SketchEntity & { start: { x: number; y: number } }
    expect(lOut.start).toEqual({ x: 10, y: 0 })
  })

  it('a split landing exactly on the seam keeps the seam constraint on the piece that still has it as an endpoint', () => {
    const src = closedSpline() as SketchSplineEntity
    const line: SketchEntity = {
      id: 'L', kind: 'line', construction: false,
      start: { x: 10, y: 0 }, end: { x: 20, y: 0 },
    }
    const coincident: SketchConstraint = {
      id: 'C', kind: 'coincident',
      a: { entityId: 'L', site: 'start' }, b: { entityId: 'S', site: 'start' },
    }
    const d = doc([src, line], [coincident])
    const first = src.points[0] // exactly the seam -> q1 snaps to 0
    const second = splinePointAt(src.points, true, 2)

    const staged = splitClick(null, d, first, 0.5, newId)
    const r = splitClick(staged.chain, d, second, 0.5, newId)
    const t = r.transform!

    const kept = t.constraints.find((c) => c.id === 'C')
    expect(kept).toBeDefined()
    if (kept?.kind === 'coincident') {
      expect([kept.a, kept.b]).toContainEqual({ entityId: 'L', site: 'start' })
      expect([kept.a, kept.b]).toContainEqual({ entityId: 'S', site: 'start' })
    }
    assertNoDangling(t)
  })
})

describe('splitClick - Undo restores the original (immutability check)', () => {
  it('the source document arrays are never mutated by a split', () => {
    const original = openSplineFrozen()
    const d = doc([original])
    const before = JSON.parse(JSON.stringify(d))
    splitClick(null, d, splinePointAt((original as SketchSplineEntity).points, false, 1.5), 0.5, newId)
    expect(d).toEqual(before)
  })

  function openSplineFrozen(): SketchEntity {
    return {
      id: 'S', kind: 'spline', construction: false, closed: false,
      points: [{ x: 0, y: 0 }, { x: 5, y: 8 }, { x: 10, y: 0 }],
    }
  }
})
