// WO-2506: Loop works on points - the ring of points through one or two selected points (a cylinder's cap
// ring from one of its points, a box's ring of edge-middle points) - and a box drag's points become the
// selection, are added to it (Shift) or taken out of it (Ctrl).

import { beforeEach, describe, expect, it } from 'vitest'
import { boxCage, cylinderCage } from '../../form/starters'
import { edgeLoop, pointLoop } from '../../form/topoTools'
import { applyPoints, useFormStore } from '../../form/formStore'
import type { Cage } from '../../form/cage'

const st = () => useFormStore.getState()
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6
const at = (c: Cage, f: (p: readonly number[]) => boolean) => c.positions.findIndex(f)
const sorted = (xs: readonly number[]) => [...xs].sort((a, b) => a - b)
// the default cylinder: 8 round, 2 along - rings of 8 at Z 0, 15 and 30, each cap one 8-sided face
const cyl = () => cylinderCage()
const ringAt = (c: Cage, z: number) => sorted(c.positions.flatMap((p, i) => (near(p[2], z) ? [i] : [])))

describe('pointLoop: the ring of points through the selected points', () => {
  it('one point of the cylinder base ring: the whole base ring of 8 (its cap rim)', () => {
    const c = cyl()
    expect(ringAt(c, 0)).toHaveLength(8)
    for (const p of ringAt(c, 0)) expect(sorted(pointLoop(c, [p])!)).toEqual(ringAt(c, 0))
  })

  it('two points of the base ring, neighbours or not: the same ring', () => {
    const c = cyl()
    const ring = ringAt(c, 0)
    expect(sorted(pointLoop(c, [ring[0], ring[1]])!)).toEqual(ring)
    expect(sorted(pointLoop(c, [ring[2], ring[5]])!)).toEqual(ring)
  })

  it('a point of the middle ring or the top ring: that ring', () => {
    const c = cyl()
    expect(sorted(pointLoop(c, [ringAt(c, 15)[3]])!)).toEqual(ringAt(c, 15))
    expect(sorted(pointLoop(c, [ringAt(c, 30)[6]])!)).toEqual(ringAt(c, 30))
  })

  it('a box: an edge-middle point gives the ring of 8 round the box through it', () => {
    const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    // the middle of the bottom front edge (X 0, Y -20, Z 0): the ring round the box in the plane X = 0
    const p = at(c, (q) => near(q[0], 0) && near(q[1], -20) && near(q[2], 0))
    const ring = pointLoop(c, [p])!
    expect(ring).toHaveLength(8)
    expect(ring.every((i) => near(c.positions[i][0], 0))).toBe(true)
  })

  it('a box face centre lies on two rings: one point is no answer, a neighbour beside it picks the ring', () => {
    const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const centre = at(c, (q) => near(q[0], 0) && near(q[1], -20) && near(q[2], 20))
    expect(pointLoop(c, [centre])).toBeNull()
    const beside = at(c, (q) => near(q[0], 0) && near(q[1], -20) && near(q[2], 0))
    const ring = pointLoop(c, [centre, beside])!
    expect(ring).toHaveLength(8)
    expect(ring.every((i) => near(c.positions[i][0], 0))).toBe(true)
  })

  it('points on no one ring: null (a base-ring point and a middle-ring point not above it; a box corner)', () => {
    const c = cyl()
    expect(pointLoop(c, [ringAt(c, 0)[0], ringAt(c, 15)[3]])).toBeNull()
    const box = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    expect(pointLoop(box, [at(box, (q) => near(q[0], -20) && near(q[1], -20) && near(q[2], 0))])).toBeNull()
    expect(pointLoop(c, [])).toBeNull()
  })

  it('the edge Loop is unchanged: an edge of the cylinder base rim still stops at its ends', () => {
    const c = cyl()
    const [a, b] = ringAt(c, 0)
    expect(edgeLoop(c, `${Math.min(a, b)}:${Math.max(a, b)}`)).toHaveLength(1)
    expect(edgeLoop(c, `${Math.min(a, b)}:${Math.max(a, b)}`, { rims: true })).toHaveLength(8)
  })
})

describe('Loop in the store, with points selected', () => {
  beforeEach(() => {
    st().openSession({ featureId: null, name: 'F', cage: cylinderCage() })
    st().setSymmetry(null)
  })

  it('one base-ring point: the whole ring is selected and the notice says so', () => {
    const ring = ringAt(st().cage, 0)
    st().select({ kind: 'point', index: ring[4] }, false)
    st().selectLoop()
    expect(sorted(st().selection.points)).toEqual(ring)
    expect(st().notice).toBe('Selected 8 points round the ring')
  })

  it('points on no one ring: the selection stays and the notice says why in plain words', () => {
    const before = { points: [ringAt(st().cage, 0)[0], ringAt(st().cage, 15)[3]], edges: [], faces: [] }
    st().setSelection(before)
    st().selectLoop()
    expect(st().selection).toEqual(before)
    expect(st().notice).toBe('No single ring runs through these points: select two neighbours on the ring you want')
  })

  it('nothing selected: the notice names points as well as edges', () => {
    st().setSelection({ points: [], edges: [], faces: [] })
    st().selectLoop()
    expect(st().notice).toBe('Select an edge or a point first: its loop runs straight on through the points around it')
  })
})

describe('box selection modes', () => {
  const sel = { points: [1, 2, 3], edges: ['4:5'], faces: [6] }
  it('a plain box replaces the selection with its points', () => {
    expect(applyPoints(sel, [7, 8, 8], 'replace')).toEqual({ points: [7, 8], edges: [], faces: [] })
    expect(applyPoints(sel, [], 'replace')).toEqual({ points: [], edges: [], faces: [] })
  })
  it('Shift adds its points, keeping what was selected', () => {
    expect(applyPoints(sel, [3, 9], 'add')).toEqual({ points: [1, 2, 3, 9], edges: ['4:5'], faces: [6] })
  })
  it('Ctrl takes its points out, leaving the rest', () => {
    expect(applyPoints(sel, [2, 9], 'remove')).toEqual({ points: [1, 3], edges: ['4:5'], faces: [6] })
  })
  it('the store action applies the mode', () => {
    st().openSession({ featureId: null, name: 'F', cage: cylinderCage() })
    st().selectPoints([0, 1, 2], 'replace')
    st().selectPoints([5], 'add')
    st().selectPoints([1], 'remove')
    expect(st().selection.points).toEqual([0, 2, 5])
  })
})
