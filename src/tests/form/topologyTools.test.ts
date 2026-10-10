// Form stage 3: insert edge loop, crease / uncrease, mirror symmetry.

import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import { cageEdges, edgeKey, type Cage } from '../../form/cage'
import { validateCage } from '../../form/halfEdge'
import { boxCage, cylinderCage, planeCage } from '../../form/starters'
import { creaseTargets, edgeRing, insertEdgeLoop, setCreased } from '../../form/edgeLoop'
import { findPairs, mirrorSelection, symmetrize, unpairedCount } from '../../form/symmetry'
import { useFormStore } from '../../form/formStore'

const at = (cage: Cage, pred: (p: number[]) => boolean) => cage.positions.findIndex((p) => pred(p))
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9

describe('edge ring and insert edge loop', () => {
  it('a vertical edge of a box rings the box horizontally and closes; the loop splits every ring quad', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    // vertical edge on the front face (y = -20), at x = 0, from z = 0 to z = 20
    const a = at(cage, (p) => near(p[0], 0) && near(p[1], -20) && near(p[2], 0))
    const b = at(cage, (p) => near(p[0], 0) && near(p[1], -20) && near(p[2], 20))
    const ring = edgeRing(cage, edgeKey(a, b))
    expect(ring.closed).toBe(true)
    // around the box the lower band has 8 vertical edges
    expect(ring.edges).toHaveLength(8)
    const r = insertEdgeLoop(cage, edgeKey(a, b))!
    expect(r.newPoints).toHaveLength(8)
    expect(r.loopEdges).toHaveLength(8)
    expect(r.cage.faces).toHaveLength(24 + 8)
    expect(validateCage(r.cage, true).problems).toEqual([])
    // the new loop sits half way up the lower band
    for (const p of r.newPoints) expect(r.cage.positions[p][2]).toBeCloseTo(10, 9)
  })

  it('a ring that meets an n-gon cap stops there; the cap gains the new point and stays valid', () => {
    const cage = cylinderCage({ segments: { x: 8, y: 1, z: 2 } })
    // a horizontal (around) edge in the middle ring: its ring runs vertically into both caps
    const a = at(cage, (p) => near(p[2], 15) && near(p[1], 0) && p[0] > 0)
    const loop = cage.faces.find((f) => f.includes(a) && f.length === 4)!
    const i = loop.indexOf(a)
    const nb = [loop[(i + 1) % 4], loop[(i + 3) % 4]].find((q) => near(cage.positions[q][2], 15))!
    const ring = edgeRing(cage, edgeKey(a, nb))
    expect(ring.closed).toBe(false)
    const r = insertEdgeLoop(cage, edgeKey(a, nb))!
    expect(validateCage(r.cage, true).problems).toEqual([])
    const caps = r.cage.faces.filter((f) => f.length > 4)
    expect(caps).toHaveLength(2)
    expect(caps.every((f) => f.length === 9)).toBe(true)
  })

  it('on an open plane the ring ends at the boundary', () => {
    const cage = planeCage({ segments: { x: 3, y: 3, z: 1 } })
    const a = at(cage, (p) => near(p[0], -10) && near(p[1], -30))
    const b = at(cage, (p) => near(p[0], 10) && near(p[1], -30))
    const r = insertEdgeLoop(cage, edgeKey(a, b))!
    expect(r.newPoints).toHaveLength(4)
    expect(r.cage.faces).toHaveLength(9 + 3)
    expect(validateCage(r.cage).problems).toEqual([])
  })

  it('a creased ring edge stays creased on both halves', () => {
    const base = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const a = at(base, (p) => near(p[0], 0) && near(p[1], -20) && near(p[2], 0))
    const b = at(base, (p) => near(p[0], 0) && near(p[1], -20) && near(p[2], 20))
    const cage = setCreased(base, [edgeKey(a, b)], true)
    const r = insertEdgeLoop(cage, edgeKey(a, b))!
    const m = r.newPoints.find((p) => near(r.cage.positions[p][0], 0) && near(r.cage.positions[p][1], -20))!
    expect(r.cage.creases).toContain(edgeKey(a, m))
    expect(r.cage.creases).toContain(edgeKey(m, b))
    expect(r.cage.creases).not.toContain(edgeKey(a, b))
  })
})

describe('crease / uncrease', () => {
  it('creases selected edges and every edge of selected faces; uncrease removes them; non-edges are ignored', () => {
    const cage = boxCage({ segments: { x: 1, y: 1, z: 1 } })
    const top = cage.faces.findIndex((f) => f.every((p) => cage.positions[p][2] > 39))
    const targets = creaseTargets(cage, { edges: [], faces: [top] })
    expect(targets).toHaveLength(4)
    const creased = setCreased(cage, [...targets, edgeKey(0, 999)], true)
    expect(creased.creases).toHaveLength(4)
    expect(validateCage(creased, true).ok).toBe(true)
    const back = setCreased(creased, [targets[0]], false)
    expect(back.creases).toHaveLength(3)
    expect(back.creases).not.toContain(targets[0])
  })
})

describe('mirror symmetry', () => {
  it('pairs every point of a symmetric starter; points on the plane are seam points', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const pairs = findPairs(cage, 'x')
    expect(unpairedCount(pairs)).toBe(0)
    let seams = 0
    cage.positions.forEach((p, i) => {
      const j = pairs.partner[i]
      if (near(p[0], 0)) { expect(j).toBe(i); seams++ }
      else expect(cage.positions[j]).toEqual([-p[0], p[1], p[2]])
    })
    expect(seams).toBeGreaterThan(0)
  })

  it('symmetrize: the moved side wins, its partner mirrors it, seam points stay on the plane', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const pairs = findPairs(cage, 'x')
    const p = at(cage, (q) => near(q[0], 20) && near(q[1], 20) && near(q[2], 40))
    const s = at(cage, (q) => near(q[0], 0) && near(q[1], 0) && near(q[2], 40))
    const moved = { ...cage, positions: cage.positions.map((q, i) => (i === p ? [30, 25, 50] : i === s ? [4, 0, 45] : q) as [number, number, number]) }
    const out = symmetrize(moved, pairs, [p, s])
    expect(out.positions[pairs.partner[p]]).toEqual([-30, 25, 50])
    expect(out.positions[s]).toEqual([0, 0, 45])
  })

  it('mirrorSelection adds the mirror of points, edges and faces', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const pairs = findPairs(cage, 'x')
    const right = cage.faces.findIndex((f) => f.every((q) => near(cage.positions[q][0], 20)))
    const sel = mirrorSelection(cage, pairs, { points: [], edges: [], faces: [right] })
    expect(sel.faces).toHaveLength(2)
    const left = sel.faces.find((f) => f !== right)!
    expect(cage.faces[left].every((q) => near(cage.positions[q][0], -20))).toBe(true)
  })
})

describe('store: symmetric move, extrude and loop', () => {
  beforeEach(() => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: boxCage({ segments: { x: 2, y: 2, z: 2 } }) })
  })

  it('a move of a +X point moves its -X partner as its mirror image', () => {
    const st = useFormStore.getState()
    st.setSymmetry('x')
    const cage = st.cage
    const p = at(cage, (q) => near(q[0], 20) && near(q[1], 20) && near(q[2], 40))
    const partner = at(cage, (q) => near(q[0], -20) && near(q[1], 20) && near(q[2], 40))
    st.select({ kind: 'point', index: p }, false)
    st.beginMove({ extrude: false })
    st.moveBy(new THREE.Matrix4().makeTranslation(5, 0, 7).elements)
    st.endDrag()
    const after = useFormStore.getState().cage
    expect(after.positions[p]).toEqual([25, 20, 47])
    expect(after.positions[partner]).toEqual([-25, 20, 47])
    // one undo step for the whole move
    useFormStore.getState().undo()
    expect(useFormStore.getState().cage.positions[partner]).toEqual([-20, 20, 40])
  })

  it('without symmetry the partner stays put', () => {
    const st = useFormStore.getState()
    st.setSymmetry(null)
    const cage = st.cage
    const p = at(cage, (q) => near(q[0], 20) && near(q[1], 20) && near(q[2], 40))
    const partner = at(cage, (q) => near(q[0], -20) && near(q[1], 20) && near(q[2], 40))
    st.select({ kind: 'point', index: p }, false)
    st.beginMove({ extrude: false })
    st.moveBy(new THREE.Matrix4().makeTranslation(5, 0, 7).elements)
    st.endDrag()
    expect(useFormStore.getState().cage.positions[partner]).toEqual([-20, 20, 40])
  })

  it('an extrude of a +X face with symmetry extrudes the -X face too, and pulls it out as a mirror', () => {
    const st = useFormStore.getState()
    st.setSymmetry('x')
    const cage = st.cage
    const face = cage.faces.findIndex((f) => f.every((q) => near(cage.positions[q][0], 20)) && f.every((q) => cage.positions[q][2] <= 20 && cage.positions[q][1] <= 0))
    st.select({ kind: 'face', index: face }, false)
    st.beginMove({ extrude: true })
    st.moveBy(new THREE.Matrix4().makeTranslation(10, 0, 0).elements)
    st.endDrag()
    const after = useFormStore.getState().cage
    expect(after.faces).toHaveLength(24 + 8)
    expect(validateCage(after, true).problems).toEqual([])
    const xs = after.positions.map((q) => q[0])
    expect(Math.max(...xs)).toBeCloseTo(30, 9)
    expect(Math.min(...xs)).toBeCloseTo(-30, 9)
  })

  it('insert loop and crease act on the selection (and its mirror with symmetry)', () => {
    const st = useFormStore.getState()
    st.setSymmetry('x')
    const cage = st.cage
    // a horizontal edge on the +X face: its ring runs vertically over the top and down -X (one ring, split once)
    const a = at(cage, (q) => near(q[0], 20) && near(q[1], -20) && near(q[2], 20))
    const b = at(cage, (q) => near(q[0], 20) && near(q[1], 0) && near(q[2], 20))
    st.select({ kind: 'edge', key: edgeKey(a, b) }, false)
    st.insertLoop()
    const looped = useFormStore.getState()
    expect(looped.cage.faces.length).toBeGreaterThan(24)
    expect(validateCage(looped.cage, true).problems).toEqual([])
    expect(looped.selection.edges.length).toBeGreaterThan(0)
    looped.crease(true)
    expect(useFormStore.getState().cage.creases.length).toBeGreaterThanOrEqual(looped.selection.edges.length)
    const creasedEdges = new Set(useFormStore.getState().cage.creases)
    expect(cageEdges(useFormStore.getState().cage).some(([x, y]) => creasedEdges.has(edgeKey(x, y)))).toBe(true)
  })
})
