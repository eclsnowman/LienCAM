// Trim tool (Stage 6 chunk 1): clicked portion between nearest bounding
// intersections is removed; circle -> arc; no-intersection click deletes
// the whole entity with the deleteSelection cascade; surviving endpoints
// keep their constraints; new cut endpoints get point_on_object onto the
// boundary they were trimmed against.

import { describe, it, expect } from 'vitest'
import {
  trimAtPoint, trimSwipe, pickCurve, type SketchDoc,
} from '../../lib/sketch/tools/trimTool'
import { constraintRefIds, dimensionRefIds } from '../../lib/sketch/refIds'
import { bakeSketch } from '../../lib/sketch/bake'
import type {
  Sketch, SketchEntity, SketchConstraint, SketchDimension,
  SketchArcEntity, SketchLineEntity, SketchEllipticalArcEntity,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `new-${n++}`

function line(
  id: string, x1: number, y1: number, x2: number, y2: number,
  construction = false,
): SketchEntity {
  return { id, kind: 'line', construction, start: { x: x1, y: y1 }, end: { x: x2, y: y2 } }
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

describe('trimAtPoint - line targets', () => {
  // Horizontal target crossed by two verticals at x=3 and x=7.
  const base = () => doc([
    line('T', 0, 0, 10, 0),
    line('V1', 3, -5, 3, 5),
    line('V2', 7, -5, 7, 5),
  ])

  it('click between two crossings removes the middle, leaving two lines', () => {
    const r = trimAtPoint(base(), { x: 5, y: 0 }, 0.5, newId)
    expect(r.notice).toBeNull()
    const t = r.transform!
    const pieces = t.entities.filter((e) => e.kind === 'line' && (e.id === 'T' || e.id.startsWith('new-')))
    expect(pieces).toHaveLength(2)
    // Start-side piece keeps the original id and the original start.
    const a = t.entities.find((e) => e.id === 'T') as SketchLineEntity
    expect(a.start).toEqual({ x: 0, y: 0 })
    expect(a.end.x).toBeCloseTo(3, 9)
    // End-side piece is new and keeps the original end.
    const b = pieces.find((e) => e.id !== 'T') as SketchLineEntity
    expect(b.start.x).toBeCloseTo(7, 9)
    expect(b.end).toEqual({ x: 10, y: 0 })
    // Both new cut endpoints sit on the boundaries they were cut against.
    const poo = t.constraints.filter((c) => c.kind === 'point_on_object')
    expect(poo).toHaveLength(2)
    expect(poo.map((c) => c.kind === 'point_on_object' && c.object).sort())
      .toEqual(['V1', 'V2'])
    assertNoDangling(t)
  })

  it('click outside the crossings trims to the nearer end (one line left)', () => {
    const r = trimAtPoint(base(), { x: 1, y: 0 }, 0.5, newId)
    const t = r.transform!
    // Only the [3,10] side bounded toward the click survives... the click
    // at x=1 is bounded above by V1(x=3) only, so [0,3] is removed and
    // the surviving piece spans [3,10] keeping the original id.
    const a = t.entities.find((e) => e.id === 'T') as SketchLineEntity
    expect(a.start.x).toBeCloseTo(3, 9)
    expect(a.end).toEqual({ x: 10, y: 0 })
    expect(t.entities.filter((e) => e.id.startsWith('new-') && e.kind === 'line')).toHaveLength(0)
    assertNoDangling(t)
  })

  it('surviving endpoints keep constraints; moved end is rewritten; removed site cascades', () => {
    const constraints: SketchConstraint[] = [
      // On the surviving original start.
      { id: 'c-start', kind: 'coincident',
        a: { entityId: 'T', site: 'start' }, b: { entityId: 'V1', site: 'start' } },
      // On the original end — survives on the NEW second piece.
      { id: 'c-end', kind: 'horizontal',
        points: [{ entityId: 'T', site: 'end' }, { entityId: 'V2', site: 'end' }] },
      // Entity-level: stays valid via the retained id.
      { id: 'c-par', kind: 'parallel', a: 'T', b: 'V1' },
    ]
    const dims: SketchDimension[] = [
      { id: 'd-len', kind: 'distance', driving: true, value: 10,
        a: { entityId: 'T', site: 'start' }, b: { entityId: 'T', site: 'end' } },
    ]
    const r = trimAtPoint(doc(base().entities, constraints, dims), { x: 5, y: 0 }, 0.5, newId)
    const t = r.transform!
    const ids = t.constraints.map((c) => c.id)
    expect(ids).toContain('c-start')
    expect(ids).toContain('c-par')
    // c-end's T/end ref moved to the new piece.
    const cEnd = t.constraints.find((c) => c.id === 'c-end')
    expect(cEnd?.kind).toBe('horizontal')
    if (cEnd?.kind === 'horizontal') {
      expect(cEnd.points![0].entityId).not.toBe('T')
      expect(cEnd.points![0].site).toBe('end')
    }
    // The length dim CONVERTED to the kept original-id piece: it would be
    // stale measuring across the gap (start of A to end of B = the old
    // full length). It now measures piece A, value re-measured.
    const dLen = t.dimensions.find((d) => d.id === 'd-len')
    expect(dLen).toBeDefined()
    if (dLen?.kind === 'distance') {
      expect(dLen.a).toEqual({ entityId: 'T', site: 'start' })
      expect(dLen.b).toEqual({ entityId: 'T', site: 'end' })
      expect(dLen.value).toBeCloseTo(3, 9) // piece A spans [0,3]
    }
    assertNoDangling(t)
  })

  it('constraints on a REMOVED endpoint cascade away', () => {
    const constraints: SketchConstraint[] = [
      { id: 'c-gone', kind: 'coincident',
        a: { entityId: 'T', site: 'start' }, b: { entityId: 'V1', site: 'start' } },
    ]
    // Click left of V1: the [0,3] span (with the original start) is removed.
    const r = trimAtPoint(doc(base().entities, constraints), { x: 1, y: 0 }, 0.5, newId)
    const t = r.transform!
    expect(t.constraints.map((c) => c.id)).not.toContain('c-gone')
    assertNoDangling(t)
  })

  it('construction geometry does NOT act as a trim boundary', () => {
    const d = doc([
      line('T', 0, 0, 10, 0),
      line('C', 5, -5, 5, 5, true), // construction: not a boundary
    ])
    const r = trimAtPoint(d, { x: 7, y: 0.01 }, 0.5, newId)
    // No boundaries at all -> whole-entity delete.
    expect(r.transform!.entities.map((e) => e.id)).not.toContain('T')
    expect(r.transform!.entities.map((e) => e.id)).toContain('C')
  })

  it('no intersections = whole-entity delete with the cascade', () => {
    const constraints: SketchConstraint[] = [
      { id: 'c-h', kind: 'horizontal', line: 'T' },
    ]
    const r = trimAtPoint(doc([line('T', 0, 0, 10, 0)], constraints), { x: 5, y: 0 }, 0.5, newId)
    const t = r.transform!
    expect(t.entities).toHaveLength(0)
    expect(t.constraints).toHaveLength(0)
  })

  it('empty click is a quiet no-op', () => {
    const r = trimAtPoint(base(), { x: 50, y: 50 }, 0.5, newId)
    expect(r.transform).toBeNull()
    expect(r.notice).toBeNull()
  })
})

describe('trimAtPoint - circle and arc targets', () => {
  it('circle crossed by a line becomes ONE arc spanning the kept side', () => {
    const circle: SketchEntity = {
      id: 'C', kind: 'circle', construction: false,
      center: { x: 0, y: 0 }, radius: 5,
    }
    const cutter = line('L', -10, 0, 10, 0) // crosses at angle 0 and pi
    const r = trimAtPoint(doc([circle, cutter]), { x: 0, y: 5 }, 0.5, newId)
    const t = r.transform!
    const arc = t.entities.find((e) => e.id === 'C') as SketchArcEntity
    expect(arc.kind).toBe('arc')
    expect(arc.radius).toBe(5)
    // Click at the top (angle pi/2): the upper half [0, pi] is removed,
    // keeping the CCW arc from pi around to 2pi (the lower half).
    expect(arc.startAngle).toBeCloseTo(Math.PI, 9)
    expect(arc.endAngle).toBeCloseTo(0, 9)
    // Both cut endpoints constrained onto the cutter line.
    const poo = t.constraints.filter((c) => c.kind === 'point_on_object')
    expect(poo).toHaveLength(2)
    for (const c of poo) {
      if (c.kind === 'point_on_object') {
        expect(c.object).toBe('L')
        expect(c.point.entityId).toBe('C')
      }
    }
    assertNoDangling(t)
  })

  it('circle with fewer than two cuts is wholly deleted', () => {
    const circle: SketchEntity = {
      id: 'C', kind: 'circle', construction: false,
      center: { x: 0, y: 0 }, radius: 5,
    }
    const r = trimAtPoint(doc([circle]), { x: 0, y: 5 }, 0.5, newId)
    expect(r.transform!.entities).toHaveLength(0)
  })

  it('arc crossed once shrinks from the clicked end', () => {
    // Upper semicircle 0..pi, radius 5, crossed by a vertical at x=0
    // (angle pi/2). Click near the start (angle ~ pi/8).
    const arc: SketchArcEntity = {
      id: 'A', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI,
    }
    const cutter = line('V', 0, 0, 0, 10)
    const p = { x: 5 * Math.cos(Math.PI / 8), y: 5 * Math.sin(Math.PI / 8) }
    const r = trimAtPoint(doc([arc, cutter]), p, 0.5, newId)
    const t = r.transform!
    const kept = t.entities.find((e) => e.id === 'A') as SketchArcEntity
    // The [0, pi/2] span is removed; the kept arc runs pi/2 .. pi.
    expect(kept.startAngle).toBeCloseTo(Math.PI / 2, 9)
    expect(kept.endAngle).toBeCloseTo(Math.PI, 9)
    // The cut endpoint (new start) rides the cutter.
    const poo = t.constraints.filter((c) => c.kind === 'point_on_object')
    expect(poo).toHaveLength(1)
    if (poo[0].kind === 'point_on_object') {
      expect(poo[0].point).toEqual({ entityId: 'A', site: 'start' })
      expect(poo[0].object).toBe('V')
    }
    assertNoDangling(t)
  })

  it('arc crossed twice splits into two arcs', () => {
    const arc: SketchArcEntity = {
      id: 'A', kind: 'arc', construction: false,
      center: { x: 0, y: 0 }, radius: 5, startAngle: 0, endAngle: Math.PI,
    }
    // Two verticals crossing the upper semicircle at angles ~66deg/~114deg.
    const c1 = line('V1', 2, 0, 2, 10)
    const c2 = line('V2', -2, 0, -2, 10)
    const r = trimAtPoint(doc([arc, c1, c2]), { x: 0, y: 5 }, 0.5, newId)
    const t = r.transform!
    const arcs = t.entities.filter((e) => e.kind === 'arc') as SketchArcEntity[]
    expect(arcs).toHaveLength(2)
    const a = arcs.find((e) => e.id === 'A')!
    const b = arcs.find((e) => e.id !== 'A')!
    expect(a.startAngle).toBeCloseTo(0, 9)
    expect(a.endAngle).toBeCloseTo(Math.acos(2 / 5), 6)
    expect(b.startAngle).toBeCloseTo(Math.PI - Math.acos(2 / 5), 6)
    expect(b.endAngle).toBeCloseTo(Math.PI, 9)
    assertNoDangling(t)
  })
})

describe('trimSwipe', () => {
  it('a swipe trims every segment it crosses', () => {
    // Two horizontal rails crossed by three verticals; swipe horizontally
    // between the rails: every vertical's middle span is removed.
    const d = doc([
      line('R1', 0, 0, 20, 0),
      line('R2', 0, 10, 20, 10),
      line('V1', 5, -5, 5, 15),
      line('V2', 10, -5, 10, 15),
      line('V3', 15, -5, 15, 15),
    ])
    const r = trimSwipe(d, [{ x: 2, y: 5 }, { x: 18, y: 5 }], newId)
    const t = r.transform!
    // Each vertical split into 2 pieces: 3 originals -> 6 verticals.
    const verticals = t.entities.filter(
      (e) => e.kind === 'line' && Math.abs(e.start.x - e.end.x) < 1e-9
    ) as SketchLineEntity[]
    expect(verticals).toHaveLength(6)
    // No vertical still spans the swipe line y=5.
    for (const v of verticals) {
      const lo = Math.min(v.start.y, v.end.y)
      const hi = Math.max(v.start.y, v.end.y)
      expect(lo >= 10 - 1e-9 || hi <= 0 + 1e-9).toBe(true)
    }
    // 6 cut endpoints -> 6 point_on_object constraints onto the rails.
    expect(t.constraints.filter((c) => c.kind === 'point_on_object')).toHaveLength(6)
    assertNoDangling(t)
  })

  it('a swipe crossing nothing is a quiet no-op', () => {
    const d = doc([line('T', 0, 0, 10, 0)])
    const r = trimSwipe(d, [{ x: 0, y: 5 }, { x: 10, y: 5 }], newId)
    expect(r.transform).toBeNull()
    expect(r.notice).toBeNull()
  })
})

describe('pickCurve', () => {
  it('picks the nearest curve and ignores point entities', () => {
    const pt: SketchEntity = { id: 'P', kind: 'point', construction: false, at: { x: 5, y: 0 } }
    const d = [line('T', 0, 0, 10, 0), pt]
    expect(pickCurve(d, { x: 5, y: 0.1 }, 0.5)?.id).toBe('T')
    expect(pickCurve(d, { x: 5, y: 5 }, 0.5)).toBeNull()
  })

  it('picks an ellipse and an elliptical-arc as trim targets', () => {
    const ell: SketchEntity = {
      id: 'E', kind: 'ellipse', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
    }
    expect(pickCurve([ell], { x: 9.6, y: 0 }, 1)?.id).toBe('E')
  })
})

describe('trimAtPoint - ellipse targets (removed -> construction)', () => {
  const ellipse = (): SketchEntity => ({
    id: 'E', kind: 'ellipse', construction: false,
    center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
  })
  // Vertical cutter x=6 crosses the ellipse at (6, +/-4).
  const vcut = (): SketchEntity => line('L', 6, -20, 6, 20)
  // Eccentric params of the two crossings.
  const norm = (a: number) => ((a % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI)
  const pTop = Math.atan2(4 / 5, 6 / 10)          // (6, 4)
  const pBot = norm(Math.atan2(-4 / 5, 6 / 10))    // (6, -4)

  it('clicking the small +x side keeps a normal arc and re-emits the removed span as construction', () => {
    const d = doc([ellipse(), vcut()])
    // Click near the +x vertex (param 0) -> removes the short right span.
    const r = trimAtPoint(d, { x: 9.5, y: 0 }, 1, newId)
    const t = r.transform!
    const arcs = t.entities.filter(
      (e): e is SketchEllipticalArcEntity => e.kind === 'elliptical-arc',
    )
    expect(arcs).toHaveLength(2)

    // KEPT piece: original id, NOT construction, the big left span hi->lo.
    const kept = arcs.find((a) => a.id === 'E')!
    expect(kept).toBeDefined()
    expect(kept.construction).toBe(false)
    expect(kept.startParam).toBeCloseTo(pTop, 6)
    expect(kept.endParam).toBeCloseTo(pBot, 6)
    // Shape carried verbatim.
    expect(kept.majorRadius).toBe(10)
    expect(kept.minorRadius).toBe(5)
    expect(kept.center).toEqual({ x: 0, y: 0 })

    // REMOVED (clicked) piece: NEW id, CONSTRUCTION, the short right span lo->hi.
    const removed = arcs.find((a) => a.id !== 'E')!
    expect(removed.construction).toBe(true)
    expect(removed.startParam).toBeCloseTo(pBot, 6)
    expect(removed.endParam).toBeCloseTo(pTop, 6)
    expect(removed.majorRadius).toBe(10)

    // Ellipse endpoints are solver-inert -> no point_on_object emitted.
    expect(t.constraints.filter((c) => c.kind === 'point_on_object')).toHaveLength(0)
    assertNoDangling(t)
  })

  it('the removed construction arc is excluded from bake; only the kept span bakes', () => {
    const d = doc([ellipse(), vcut()])
    const t = trimAtPoint(d, { x: 9.5, y: 0 }, 1, newId).transform!
    // Bake only the ellipse pieces (drop the line cutter to isolate).
    const pieces = t.entities.filter((e) => e.kind === 'elliptical-arc')
    const sketch: Sketch = {
      id: 'sk', layerId: 'L', entities: pieces, constraints: [], dimensions: [],
      solveStatus: { dof: 0, conflicting: [], redundant: [] },
    }
    const baked = bakeSketch(sketch)
    expect(baked.excludedEntities).toBe(1) // the construction removed arc
    expect(baked.bakedEntities).toBe(1)    // only the kept arc
    expect(baked.loops).toHaveLength(1)
    expect(baked.loops[0].closed).toBe(false) // an elliptical arc is open
  })
})

describe('trimAtPoint - elliptical-arc targets', () => {
  it('trimming the middle of an elliptical arc splits it and re-emits the cut as construction', () => {
    // Upper half of ellipse a=10 b=5 (params 0..pi). Cutter y=3 crosses it
    // at x = +/-8 (both on the upper half).
    const arc: SketchEntity = {
      id: 'A', kind: 'elliptical-arc', construction: false,
      center: { x: 0, y: 0 }, majorRadius: 10, minorRadius: 5, rotation: 0,
      startParam: 0, endParam: Math.PI,
    }
    const cut = line('L', -20, 3, 20, 3)
    const pRight = Math.atan2(3 / 5, 8 / 10)   // (8, 3)   ~0.6435
    const pLeft = Math.atan2(3 / 5, -8 / 10)   // (-8, 3)  ~2.498
    // Click the TOP (param pi/2), between the two cuts -> middle removed.
    const r = trimAtPoint(doc([arc, cut]), { x: 0, y: 5 }, 0.5, newId)
    const t = r.transform!
    const arcs = t.entities.filter(
      (e): e is SketchEllipticalArcEntity => e.kind === 'elliptical-arc',
    )
    expect(arcs).toHaveLength(3)
    const kept = arcs.filter((a) => !a.construction)
    const removed = arcs.filter((a) => a.construction)
    expect(kept).toHaveLength(2)   // start-side + end-side kept spans
    expect(removed).toHaveLength(1)
    // Start-side kept keeps the original id from startParam(0) to the first cut.
    const startSide = kept.find((a) => a.id === 'A')!
    expect(startSide.startParam).toBeCloseTo(0, 6)
    expect(startSide.endParam).toBeCloseTo(pRight, 6)
    // Removed construction span runs across the top between the two cuts.
    expect(removed[0].startParam).toBeCloseTo(pRight, 6)
    expect(removed[0].endParam).toBeCloseTo(pLeft, 6)
    assertNoDangling(t)
  })
})
