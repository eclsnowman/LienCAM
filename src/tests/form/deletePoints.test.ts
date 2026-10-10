// Form: Delete on points - the faces round each point merge into one and the point goes.

import { beforeEach, describe, expect, it } from 'vitest'
import type { Cage } from '../../form/cage'
import { boxCage, planeCage } from '../../form/starters'
import { validateCage } from '../../form/halfEdge'
import { useFormStore } from '../../form/formStore'

const st = () => useFormStore.getState()
const find = (c: Cage, f: (p: readonly number[]) => boolean) => c.positions.findIndex(f)
const has = (c: Cage, p: readonly number[]) => c.positions.some((q) => q[0] === p[0] && q[1] === p[1] && q[2] === p[2])

describe('Delete on points', () => {
  beforeEach(() => { st().openSession({ featureId: null, name: 'F', cage: boxCage({ segments: { x: 2, y: 2, z: 2 } }) }) })

  it('the middle point of a box\'s top: its four faces become one 8-sided face, the point goes, the form stays closed', () => {
    const c = st().cage
    const v = find(c, (p) => p[0] === 0 && p[1] === 0 && p[2] === 40)
    st().setSelection({ points: [v], edges: [], faces: [] })
    st().deleteSelection()
    const n = st().cage
    expect(n.faces).toHaveLength(c.faces.length - 3)
    expect(n.positions).toHaveLength(c.positions.length - 1)
    expect(has(n, c.positions[v])).toBe(false)
    expect(n.faces.some((f) => f.length === 8)).toBe(true)
    expect(validateCage(n, true).problems).toEqual([])
    expect(st().notice).toBe('Deleted 1 point: the faces round it merged into one')
    expect(st().selection).toEqual({ points: [], edges: [], faces: [] })
  })

  it('a corner (three faces): they merge into one six-sided face; one undo brings it back', () => {
    const c = st().cage
    const v = find(c, (p) => p[0] === 20 && p[1] === 20 && p[2] === 40)
    st().setSelection({ points: [v], edges: [], faces: [] })
    st().deleteSelection()
    expect(st().cage.faces.some((f) => f.length === 6)).toBe(true)
    expect(validateCage(st().cage, true).problems).toEqual([])
    st().undo()
    expect(st().cage.positions).toEqual(c.positions)
  })

  it('with Mirror X on, the point\'s mirror image goes too', () => {
    st().setSymmetry('x')
    const c = st().cage
    const v = find(c, (p) => p[0] === 20 && p[1] === 0 && p[2] === 20)
    st().setSelection({ points: [v], edges: [], faces: [] })
    st().deleteSelection()
    expect(has(st().cage, [20, 0, 20])).toBe(false)
    expect(has(st().cage, [-20, 0, 20])).toBe(false)
    expect(st().notice).toMatch(/^Deleted 2 points: the faces round each merged into one/)
  })

  it('a point on an open border stays (its border edges hold it) and the notice says so; a border point alone deletes nothing', () => {
    st().openSession({ featureId: null, name: 'F', cage: planeCage({ segments: { x: 3, y: 3, z: 1 } }) })
    const c = st().cage
    const xs = [...new Set(c.positions.map((p) => p[0]))].sort((a, b) => a - b)
    const ys = [...new Set(c.positions.map((p) => p[1]))].sort((a, b) => a - b)
    const inner = find(c, (p) => p[0] === xs[1] && p[1] === ys[1])
    const edge = find(c, (p) => p[0] === xs[0] && p[1] === ys[1])
    st().setSelection({ points: [edge], edges: [], faces: [] })
    const before = st().cage
    st().deleteSelection()
    expect(st().cage).toBe(before)
    expect(st().notice).toMatch(/^Nothing to delete there: a point on the form's open border keeps its border edges/)
    st().setSelection({ points: [inner, edge], edges: [], faces: [] })
    st().deleteSelection()
    expect(has(st().cage, c.positions[inner])).toBe(false)
    expect(st().notice).toMatch(/^Deleted 1 point: .*; 1 on the open border stay/)
  })

  it('points with edges or faces also selected keep the old meaning (edges dissolve / faces delete)', () => {
    const c = st().cage
    st().setSelection({ points: [0], edges: [], faces: [0] })
    st().deleteSelection()
    expect(st().cage.faces).toHaveLength(c.faces.length - 1)
  })
})
