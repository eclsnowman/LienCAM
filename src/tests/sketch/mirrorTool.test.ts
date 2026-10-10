// Sketch mirror tool (Stage 6 chunk 2): mirrored copies (exact
// reflection, arc winding flipped to keep the stored-CCW convention) +
// planegcs SYMMETRIC constraints binding each mirrored point pair about
// the axis line — so dragging an original moves its mirror PARAMETRICALLY
// (verified against the real solver, not just the constructed geometry).

import { describe, it, expect } from 'vitest'
import {
  mirrorEntities, mirrorClick, type MirrorChainState,
} from '../../lib/sketch/tools/mirrorTool'
import { confirmToolStep, escapeTool } from '../../lib/sketch/tools/toolMachine'
import { createGcsWrapper } from '../../lib/planegcs/planegcsLoader'
import { solveSketchOnWrapper } from '../../lib/sketch/solver/gcsMapping'
import type {
  Vec2, Sketch, SketchEntity, SketchConstraint,
  SketchArcEntity, SketchLineEntity,
} from '../../lib/sketch/types'

let n = 0
const newId = () => `m-${n++}`

function line(
  id: string, x1: number, y1: number, x2: number, y2: number,
  construction = false,
): SketchLineEntity {
  return {
    id, kind: 'line', construction,
    start: { x: x1, y: y1 }, end: { x: x2, y: y2 },
  }
}

function arcPt(a: SketchArcEntity, angle: number): Vec2 {
  return {
    x: a.center.x + a.radius * Math.cos(angle),
    y: a.center.y + a.radius * Math.sin(angle),
  }
}

describe('mirrorEntities - geometry', () => {
  // Vertical construction axis at x = 20.
  const axis = line('ax', 20, -5, 20, 25, true)

  it('mirrors a rectangle to its exact reflection', () => {
    const ents: SketchEntity[] = [
      line('b', 0, 0, 10, 0),
      line('r', 10, 0, 10, 8),
      line('t', 10, 8, 0, 8),
      line('l', 0, 8, 0, 0),
      axis,
    ]
    const r = mirrorEntities(ents, ['b', 'r', 't', 'l'], 'ax', newId)
    expect(typeof r).not.toBe('string')
    if (typeof r === 'string') return
    expect(r.entities).toHaveLength(4)
    // x -> 40 - x, y unchanged.
    const mb = r.entities[0] as SketchLineEntity
    expect(mb.start.x).toBeCloseTo(40, 9)
    expect(mb.start.y).toBeCloseTo(0, 9)
    expect(mb.end.x).toBeCloseTo(30, 9)
    expect(mb.end.y).toBeCloseTo(0, 9)
    const mr = r.entities[1] as SketchLineEntity
    expect(mr.start.x).toBeCloseTo(30, 9)
    expect(mr.end.x).toBeCloseTo(30, 9)
    expect(mr.end.y).toBeCloseTo(8, 9)
    // 2 symmetric constraints per line, all about the axis.
    const syms = r.constraints.filter((c) => c.kind === 'symmetric')
    expect(syms).toHaveLength(8)
    for (const c of syms) {
      if (c.kind === 'symmetric') expect(c.axis).toBe('ax')
    }
    // No constraint between source entities themselves and nothing else.
    expect(r.constraints).toHaveLength(8)
  })

  it('flips arc winding correctly: stored CCW, endpoints reflected', () => {
    // CCW quarter arc from 0 to 90 deg, R5 at (5,5).
    const src: SketchArcEntity = {
      id: 'a1', kind: 'arc', construction: false,
      center: { x: 5, y: 5 }, radius: 5,
      startAngle: 0, endAngle: Math.PI / 2,
    }
    const r = mirrorEntities([src, axis], ['a1'], 'ax', newId)
    if (typeof r === 'string') throw new Error(r)
    const m = r.entities[0] as SketchArcEntity
    expect(m.kind).toBe('arc')
    expect(m.center.x).toBeCloseTo(35, 9)
    expect(m.center.y).toBeCloseTo(5, 9)
    expect(m.radius).toBe(5)
    // Stored CCW: sweep must be the same 90 deg, not 270.
    const sweep = ((m.endAngle - m.startAngle) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
    expect(sweep).toBeCloseTo(Math.PI / 2, 9)
    // Winding flip: source START (10,5) reflects to the mirrored END
    // (30,5); source END (5,10) reflects to the mirrored START (35,10).
    const mStart = arcPt(m, m.startAngle)
    const mEnd = arcPt(m, m.endAngle)
    expect(mEnd.x).toBeCloseTo(30, 9)
    expect(mEnd.y).toBeCloseTo(5, 9)
    expect(mStart.x).toBeCloseTo(35, 9)
    expect(mStart.y).toBeCloseTo(10, 9)
    // The symmetric pairs encode that crossover.
    const syms = r.constraints.filter((c) => c.kind === 'symmetric')
    expect(syms).toHaveLength(3) // start<->end, end<->start, center<->center
    const pair = (site: string) =>
      syms.find((c) => c.kind === 'symmetric' && c.a.site === site)
    expect(pair('start')).toMatchObject({ b: { site: 'end' } })
    expect(pair('end')).toMatchObject({ b: { site: 'start' } })
    expect(pair('center')).toMatchObject({ b: { site: 'center' } })
  })

  it('circle copy gets symmetric center + equal radius', () => {
    const ents: SketchEntity[] = [
      { id: 'c1', kind: 'circle', construction: false, center: { x: 6, y: 3 }, radius: 2.5 },
      axis,
    ]
    const r = mirrorEntities(ents, ['c1'], 'ax', newId)
    if (typeof r === 'string') throw new Error(r)
    const m = r.entities[0]
    expect(m.kind).toBe('circle')
    if (m.kind !== 'circle') return
    expect(m.center.x).toBeCloseTo(34, 9)
    expect(m.center.y).toBeCloseTo(3, 9)
    expect(m.radius).toBe(2.5)
    expect(r.constraints.map((c) => c.kind).sort()).toEqual(['equal', 'symmetric'])
  })

  it('axis in the set is skipped; non-line axis rejected', () => {
    const ents: SketchEntity[] = [line('a', 0, 0, 5, 0), axis]
    const r = mirrorEntities(ents, ['a', 'ax'], 'ax', newId)
    if (typeof r === 'string') throw new Error(r)
    expect(r.entities).toHaveLength(1)
    const bad = mirrorEntities(
      [...ents, { id: 'c1', kind: 'circle', construction: false, center: { x: 0, y: 0 }, radius: 1 }],
      ['a'], 'c1', newId)
    expect(bad).toMatch(/axis must be a line/)
  })
})

describe('mirrorClick - gestures', () => {
  const ents: SketchEntity[] = [
    line('a', 0, 0, 10, 0),
    line('ax', 20, -5, 20, 25, true),
  ]

  it('a null chain never instant-mirrors from a stale selection (tool-first bug)', () => {
    // Pre-selection is seeded into the chain at ARM time now; a click with
    // a null chain ALWAYS accumulates, never consuming selectedIds as an
    // instant axis pick. selectedIds is ignored here.
    const r = mirrorClick(null, ents, ['a'], { x: 20, y: 10 }, 0.5, newId)
    expect(r.commit).toBeNull() // NOT an instant mirror
    // The click hit the construction axis line 'ax' -> with an empty set
    // it explains itself (select entities first); it does not commit.
    expect(r.notice).toMatch(/select entities/)
  })

  it('click-accumulate: entity clicks toggle the set, construction line executes', () => {
    const first = mirrorClick(null, ents, [], { x: 5, y: 0 }, 0.5, newId)
    expect(first.chain).toEqual({ kind: 'mirror', ids: ['a'] })
    expect(first.commit).toBeNull()
    // Re-click removes it again.
    const toggled = mirrorClick(first.chain, ents, [], { x: 5, y: 0 }, 0.5, newId)
    expect(toggled.chain).toEqual({ kind: 'mirror', ids: [] })
    // Construction-line click with the set populated executes.
    const done = mirrorClick(first.chain, ents, [], { x: 20, y: 10 }, 0.5, newId)
    expect(done.notice).toBeNull()
    expect(done.chain).toBeNull()
    expect(done.commit!.entities).toHaveLength(1)
  })

  it('axis click with an empty set explains itself', () => {
    const r = mirrorClick(
      { kind: 'mirror', ids: [] }, ents, [], { x: 20, y: 10 }, 0.5, newId)
    expect(r.commit).toBeNull()
    expect(r.notice).toMatch(/select entities/)
  })
})

// USER-REPORTED DEFECT (STATUS.md KNOWN ISSUES, 2026-06-11): in
// click-accumulate mode, clicking a REGULAR line as the intended axis
// silently toggled it into the set — no commit, no notice, no ghost: a
// dead end ("mirror does not work"). The fix: the toggle now NAMES the
// way out, and Enter (confirmToolStep) closes the set so the next click
// is the axis pick where ANY line works — the pattern tools' gesture.
describe('mirrorClick - regular-line axis in accumulate mode (user defect)', () => {
  const regularAxis = line('rax', 20, -5, 20, 25, false)
  const ents: SketchEntity[] = [
    line('a', 0, 0, 10, 0),
    line('b', 0, 4, 10, 4),
    regularAxis,
  ]

  it('clicking a regular line with a populated set toggles it in WITH a notice naming Enter', () => {
    const r = mirrorClick(
      { kind: 'mirror', ids: ['a'] }, ents, [], { x: 20, y: 10 }, 0.5, newId)
    expect(r.commit).toBeNull()
    expect(r.chain).toMatchObject({ kind: 'mirror', ids: ['a', 'rax'] })
    expect(r.notice).toMatch(/Enter/)
    expect(r.notice).toMatch(/AXIS/i)
  })

  it('Enter closes the set; the next click mirrors about ANY line (regular included)', () => {
    // Accumulate two entities, then confirm (the Enter path).
    const advanced = confirmToolStep({
      tool: 'mirror', chain: { kind: 'mirror', ids: ['a', 'b'] },
    })
    expect(advanced).not.toBeNull()
    expect(advanced!.chain).toMatchObject({ kind: 'mirror', confirmed: true })
    // Axis click on the REGULAR line now commits the mirror.
    const r = mirrorClick(
      advanced!.chain as MirrorChainState,
      ents, [], { x: 20, y: 10 }, 0.5, newId)
    expect(r.notice).toBeNull()
    expect(r.chain).toBeNull()
    expect(r.commit).not.toBeNull()
    expect(r.commit!.entities).toHaveLength(2)
    const m = r.commit!.entities[0] as SketchLineEntity
    expect(m.start.x).toBeCloseTo(40, 9) // x -> 40 - x about x=20
    // A miss after confirm keeps the closed set for the retry.
    const miss = mirrorClick(
      advanced!.chain as MirrorChainState,
      ents, [], { x: 99, y: 99 }, 0.5, newId)
    expect(miss.chain).toMatchObject({ kind: 'mirror', confirmed: true })
    expect(miss.notice).toMatch(/click a LINE/)
  })

  it('Enter is a no-op on an empty set; CLOSES a seeded (open) set; Esc reopens a confirmed set', () => {
    // Empty set: nothing to close.
    expect(confirmToolStep({
      tool: 'mirror', chain: { kind: 'mirror', ids: [] },
    })).toBeNull()
    // Seeded (pre-selected) set is OPEN now: Enter closes it -> confirmed.
    const seededClose = confirmToolStep({
      tool: 'mirror', chain: { kind: 'mirror', ids: ['a'], seeded: true, confirmed: false },
    })
    expect(seededClose).not.toBeNull()
    expect(seededClose!.chain).toMatchObject({
      kind: 'mirror', ids: ['a'], seeded: true, confirmed: true,
    })
    // Esc reopens a confirmed set (keeps the operands).
    const esc = escapeTool({
      tool: 'mirror', chain: { kind: 'mirror', ids: ['a', 'b'], confirmed: true },
    })
    expect(esc.consumed).toBe(true)
    expect(esc.state.chain).toMatchObject({
      kind: 'mirror', ids: ['a', 'b'], confirmed: false,
    })
  })
})

describe('mirror - solver loopback (real planegcs)', () => {
  it('moving an original endpoint pulls the mirror with it', async () => {
    // Line 'a' mirrored about the fixed construction axis at x=20, then
    // the ORIGINAL is moved (the "drag"): grounded at its NEW position.
    // The solve must relocate the MIRROR to the reflection of the new
    // position — the symmetric constraints do the work.
    const axis = line('ax', 20, -5, 20, 25, true)
    const src = line('a', 0, 0, 10, 0)
    const r = mirrorEntities([src, axis], ['a'], 'ax', newId)
    if (typeof r === 'string') throw new Error(r)

    // "Drag": the original moves up and right by (1, 3).
    const moved = line('a', 1, 3, 11, 3)
    const constraints: SketchConstraint[] = [
      ...r.constraints,
      // Ground the axis and the moved original (the drag's outcome).
      { id: newId(), kind: 'fix', entityId: 'ax' },
      { id: newId(), kind: 'fix', entityId: 'a' },
    ]
    const sketch: Sketch = {
      id: 'sk', layerId: 'layer',
      entities: [moved, axis, ...r.entities],
      constraints, dimensions: [],
      solveStatus: null,
    }
    const gcs = await createGcsWrapper()
    const out = solveSketchOnWrapper(gcs, sketch)
    expect(out.ok).toBe(true)
    if (!out.ok) return
    const mirrorId = r.idMap.get('a')!
    const m = out.entities.find((e) => e.id === mirrorId) as SketchLineEntity
    // Reflection of the MOVED line about x=20: start (39,3), end (29,3).
    expect(m.start.x).toBeCloseTo(39, 6)
    expect(m.start.y).toBeCloseTo(3, 6)
    expect(m.end.x).toBeCloseTo(29, 6)
    expect(m.end.y).toBeCloseTo(3, 6)
  })
})
