// Sketch linear + circular pattern tools (Stage 6 chunk 2): N-1 copies
// at exact translated/rotated positions, each copy internally
// constraint-complete (constraints whose operands all live inside the
// pattern set are duplicated per copy with remapped ids), NO
// inter-instance constraints (documented v1 scope), ids collision-free,
// construction excluded.

import { describe, it, expect } from 'vitest'
import {
  linearPattern, circularPattern,
  linearPatternClick, circularPatternClick,
  linearPatternPreview, circularPatternPreview,
  linearPatternApply, circularPatternApply,
  type LinearPatternChainState, type CircularPatternChainState,
} from '../../lib/sketch/tools/patternTools'
import type {
  SketchEntity, SketchConstraint,
  SketchArcEntity, SketchCircleEntity, SketchLineEntity,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `p-${n++}`

function line(
  id: string, x1: number, y1: number, x2: number, y2: number,
  construction = false,
): SketchLineEntity {
  return {
    id, kind: 'line', construction,
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
  }
}

function circle(id: string, cx: number, cy: number, r: number): SketchCircleEntity {
  return { id, kind: 'circle', construction: false, center: { x: cx, y: cy }, radius: r }
}

// 2-line corner at (10,0) joined by a coincident, plus an UNRELATED
// constraint half-outside the set (must NOT be duplicated).
function cornerDoc(): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
  const entities: SketchEntity[] = [
    line('a', 0, 0, 10, 0),
    line('b', 10, 0, 10, 6),
    line('x', 0, 20, 10, 20), // outside the pattern set
  ]
  const constraints: SketchConstraint[] = [
    { id: 'c-corner', kind: 'coincident',
      a: { entityId: 'a', site: 'end' }, b: { entityId: 'b', site: 'start' } },
    { id: 'c-outside', kind: 'parallel', a: 'a', b: 'x' },
    { id: 'c-h', kind: 'horizontal', line: 'a' },
  ]
  return { entities, constraints }
}

describe('linearPattern', () => {
  it('3x of a 2-line corner: exact positions + duplicated internal constraints', () => {
    const { entities, constraints } = cornerDoc()
    const r = linearPattern(entities, constraints, ['a', 'b'], 3, { x: 15, y: 5 }, newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    // 2 copies x 2 entities.
    expect(r.entities).toHaveLength(4)
    const ls = r.entities.filter((e): e is SketchLineEntity => e.kind === 'line')
    // Copy 1 of 'a': (15,5)->(25,5); copy 2: (30,10)->(40,10).
    expect(ls[0].start).toEqual({ x: 15, y: 5 })
    expect(ls[0].end).toEqual({ x: 25, y: 5 })
    expect(ls[2].start).toEqual({ x: 30, y: 10 })
    expect(ls[2].end).toEqual({ x: 40, y: 10 })
    // Copy 1 of 'b': (25,5)->(25,11).
    expect(ls[1].start).toEqual({ x: 25, y: 5 })
    expect(ls[1].end).toEqual({ x: 25, y: 11 })
    // Internal constraints per copy: the corner coincident + the
    // horizontal — NOT the parallel to the outside line.
    const coincs = r.constraints.filter((c) => c.kind === 'coincident')
    const horiz = r.constraints.filter((c) => c.kind === 'horizontal')
    expect(coincs).toHaveLength(2)
    expect(horiz).toHaveLength(2)
    expect(r.constraints.filter((c) => c.kind === 'parallel')).toHaveLength(0)
    // The duplicated coincident references THAT copy's entities (a.end
    // touches b.start within each copy).
    const copyIds = r.entities.map((e) => e.id)
    for (const c of coincs) {
      if (c.kind !== 'coincident') continue
      expect(copyIds).toContain(c.a.entityId)
      expect(copyIds).toContain(c.b.entityId)
      expect(c.a.site).toBe('end')
      expect(c.b.site).toBe('start')
    }
  })

  it('id remap is collision-free across copies, sources, and constraints', () => {
    const { entities, constraints } = cornerDoc()
    const r = linearPattern(entities, constraints, ['a', 'b'], 4, { x: 12, y: 0 }, newId)
    if (typeof r === 'string') throw new Error(r)
    const all = [
      ...entities.map((e) => e.id),
      ...constraints.map((c) => c.id),
      ...r.entities.map((e) => e.id),
      ...r.constraints.map((c) => c.id),
    ]
    expect(new Set(all).size).toBe(all.length)
  })

  it('rejects count < 2 and a zero step vector', () => {
    const { entities, constraints } = cornerDoc()
    expect(linearPattern(entities, constraints, ['a'], 1, { x: 5, y: 0 }, newId))
      .toMatch(/count/)
    expect(linearPattern(entities, constraints, ['a'], 3, { x: 0, y: 0 }, newId))
      .toMatch(/zero/)
  })

  it('construction entities are excluded from the set', () => {
    const ents = [line('c', 0, 0, 5, 0, true)]
    expect(linearPattern(ents, [], ['c'], 3, { x: 5, y: 0 }, newId))
      .toMatch(/nothing to pattern/)
  })
})

describe('circularPattern', () => {
  it('4x of a circle around a center: positions exact (90 deg steps)', () => {
    const ents = [circle('c1', 30, 20, 3)]
    const r = circularPattern(ents, [], ['c1'], 4, { x: 20, y: 20 }, Math.PI / 2, newId)
    if (typeof r === 'string') throw new Error(r)
    expect(r.entities).toHaveLength(3)
    const centers = r.entities.map((e) => (e as SketchCircleEntity).center)
    // (30,20) rotated about (20,20) by 90/180/270 deg.
    expect(centers[0].x).toBeCloseTo(20, 9)
    expect(centers[0].y).toBeCloseTo(30, 9)
    expect(centers[1].x).toBeCloseTo(10, 9)
    expect(centers[1].y).toBeCloseTo(20, 9)
    expect(centers[2].x).toBeCloseTo(20, 9)
    expect(centers[2].y).toBeCloseTo(10, 9)
    for (const e of r.entities) expect((e as SketchCircleEntity).radius).toBe(3)
    // A lone circle has no internal constraints to duplicate.
    expect(r.constraints).toHaveLength(0)
  })

  it('rotates arc angles with the copy (winding preserved)', () => {
    const arc: SketchArcEntity = {
      id: 'a1', kind: 'arc', construction: false,
      center: { x: 10, y: 0 }, radius: 2, startAngle: 0, endAngle: Math.PI / 2,
    }
    const r = circularPattern([arc], [], ['a1'], 2, { x: 0, y: 0 }, Math.PI, newId)
    if (typeof r === 'string') throw new Error(r)
    const m = r.entities[0] as SketchArcEntity
    expect(m.center.x).toBeCloseTo(-10, 9)
    expect(m.center.y).toBeCloseTo(0, 9)
    expect(m.startAngle).toBeCloseTo(Math.PI, 9)
    expect(m.endAngle).toBeCloseTo((3 * Math.PI) / 2, 9)
  })
})

describe('pattern click gestures (set - Confirm - place)', () => {
  const doc = cornerDoc()

  it('linear: clicks toggle the set; misses NEVER advance the phase', () => {
    const c1 = linearPatternClick(null, doc.entities, { x: 5, y: 0 }, 0.5)
    expect(c1.chain).toEqual({
      kind: 'linpat', ids: ['a'], confirmed: false, anchor: null, vector: null,
    })
    const c2 = linearPatternClick(c1.chain, doc.entities, { x: 10, y: 3 }, 0.5)
    expect(c2.chain?.ids).toEqual(['a', 'b'])
    // A miss does NOT anchor — it tells the user about Confirm (this
    // was the silent-hijack bug: placement clicks landing on geometry
    // toggled the set instead of placing).
    const c3 = linearPatternClick(c2.chain, doc.entities, { x: 50, y: 50 }, 0.5)
    expect(c3.chain?.confirmed).toBe(false)
    expect(c3.chain?.anchor).toBeNull()
    expect(c3.notice).toMatch(/Confirm/)
    // Clicking a set member again removes it.
    const c4 = linearPatternClick(c3.chain, doc.entities, { x: 10, y: 3 }, 0.5)
    expect(c4.chain?.ids).toEqual(['a'])
  })

  it('linear: confirmed set -> anchor -> vector lock -> apply commits', () => {
    const chain: LinearPatternChainState = {
      kind: 'linpat', ids: ['a', 'b'], confirmed: true, anchor: null, vector: null,
    }
    const a = linearPatternClick(chain, doc.entities, { x: 50, y: 50 }, 0.5)
    expect(a.chain?.anchor).toEqual({ x: 50, y: 50 })
    // Even a click ON an entity places now — the set is closed.
    const v = linearPatternClick(a.chain, doc.entities, { x: 65, y: 55 }, 0.5)
    expect(v.chain?.vector).toEqual({ x: 15, y: 5 })
    // Re-click re-places the vector end.
    const v2 = linearPatternClick(v.chain, doc.entities, { x: 62, y: 50 }, 0.5)
    expect(v2.chain?.vector).toEqual({ x: 12, y: 0 })
    // Overlay OK commits at the live count.
    const r = linearPatternApply(v.chain!, doc.entities, doc.constraints, 3, newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    expect(r.entities).toHaveLength(4)
    const first = r.entities[0] as SketchLineEntity
    expect(first.start).toEqual({ x: 15, y: 5 }) // a + (15,5)
  })

  it('linear preview-equals-commit: ghosts match the applied copies', () => {
    const chain: LinearPatternChainState = {
      kind: 'linpat', ids: ['a', 'b'], confirmed: true,
      anchor: { x: 50, y: 50 }, vector: { x: 15, y: 5 },
    }
    const ghosts = linearPatternPreview(chain, doc.entities, { x: 0, y: 0 }, 3)!
    const r = linearPatternApply(chain, doc.entities, doc.constraints, 3, newId)
    if (typeof r === 'string') throw new Error(r)
    expect(ghosts).toHaveLength(r.entities.length)
    ghosts.forEach((g, i) => {
      const c = r.entities[i]
      if (g.kind === 'line' && c.kind === 'line') {
        expect(g.start).toEqual(c.start)
        expect(g.end).toEqual(c.end)
      }
    })
    // Before the vector locks, the ghost follows the cursor.
    const live = linearPatternPreview(
      { ...chain, vector: null }, doc.entities, { x: 62, y: 50 }, 3)!
    expect((live[0] as SketchLineEntity).start).toEqual({ x: 12, y: 0 })
  })

  it('circular: confirmed set -> center click locks; ghost ring follows the cursor first', () => {
    const ents = [circle('c1', 30, 20, 3)]
    const chain: CircularPatternChainState = {
      kind: 'circpat', ids: ['c1'], confirmed: true, center: null,
    }
    // Ghost ring about the CURSOR before any click.
    const live = circularPatternPreview(chain, ents, { x: 20, y: 20 }, 4, Math.PI / 2)!
    expect(live).toHaveLength(3)
    expect((live[0] as SketchCircleEntity).center.x).toBeCloseTo(20, 9)
    expect((live[0] as SketchCircleEntity).center.y).toBeCloseTo(30, 9)
    // Click locks the center (no commit yet).
    const r = circularPatternClick(chain, ents, { x: 20, y: 20 }, 0.5)
    expect(r.chain?.center).toEqual({ x: 20, y: 20 })
    // Overlay OK commits — the SAME positions the ghost showed.
    const c = circularPatternApply(r.chain!, ents, [], 4, Math.PI / 2, newId)
    if (typeof c === 'string') throw new Error(c)
    expect(c.entities).toHaveLength(3)
    expect((c.entities[0] as SketchCircleEntity).center.x).toBeCloseTo(20, 9)
    expect((c.entities[0] as SketchCircleEntity).center.y).toBeCloseTo(30, 9)
  })

  it('construction clicks explain the exclusion; idle empty click is quiet', () => {
    const ents = [line('c', 0, 0, 5, 0, true)]
    const r = linearPatternClick(null, ents, { x: 2, y: 0 }, 0.5)
    expect(r.notice).toMatch(/construction/)
    const idle = circularPatternClick(null, ents, { x: 50, y: 50 }, 0.5)
    expect(idle.chain).toBeNull()
    expect(idle.notice).toBeNull()
  })

  it('apply without a placed vector/center refuses with a reason', () => {
    const lin: LinearPatternChainState = {
      kind: 'linpat', ids: ['a'], confirmed: true, anchor: { x: 0, y: 0 }, vector: null,
    }
    expect(linearPatternApply(lin, doc.entities, [], 3, newId)).toMatch(/vector/)
    const circ: CircularPatternChainState = {
      kind: 'circpat', ids: ['a'], confirmed: true, center: null,
    }
    expect(circularPatternApply(circ, doc.entities, [], 4, Math.PI / 2, newId))
      .toMatch(/center/)
  })
})
