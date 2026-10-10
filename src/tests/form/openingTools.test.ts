// Form: loop / ring select, delete faces, fill hole, bridge, thicken, soft modification.

import { beforeEach, describe, expect, it } from 'vitest'
import { edgeKey, type Cage } from '../../form/cage'
import { validateCage } from '../../form/halfEdge'
import { boxCage, planeCage } from '../../form/starters'
import { bridge, deleteFaces, edgeLoop, fillHole, openLoopThrough, thicken } from '../../form/topoTools'
import { useFormStore } from '../../form/formStore'
import { makeFormFeaturePayload } from '../../form/formBody'
import { skinLevels, SKIN_QUAD_BUDGET } from '../../form/formOverlay'
import { tessellateForm } from '../../form/finish'
import { softWeights } from '../../form/topology'
import * as THREE from 'three'

const at = (cage: Cage, pred: (p: number[]) => boolean) => cage.positions.findIndex((p) => pred(p))
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9
const eulerOf = (cage: Cage) => {
  const edges = new Set<string>()
  for (const f of cage.faces) for (let i = 0; i < f.length; i++) edges.add(edgeKey(f[i], f[(i + 1) % f.length]))
  return cage.positions.length - edges.size + cage.faces.length
}
function meshVolume(P: Float64Array, I: Uint32Array): number {
  let v = 0
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3
    v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6
  }
  return v
}

describe('edge loop', () => {
  it('runs straight on through ordinary points and closes round the box', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    // the vertical middle edge of the front face's lower half
    const a = at(cage, (p) => near(p[0], 0) && near(p[1], -20) && near(p[2], 0))
    const b = at(cage, (p) => near(p[0], 0) && near(p[1], -20) && near(p[2], 20))
    const loop = edgeLoop(cage, edgeKey(a, b))
    // up the front, over the top, down the back, under the bottom: 8 edges, back to the start
    expect(loop).toHaveLength(8)
    expect(new Set(loop).size).toBe(8)
    expect(loop.every((k) => k.split(':').every((p) => near(cage.positions[Number(p)][0], 0)))).toBe(true)
  })

  it('stops at a point that is not ordinary (a box corner has three edges)', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    // along the front bottom edge from its middle: the next points are corners
    const m = at(cage, (p) => near(p[0], 0) && near(p[1], -20) && near(p[2], 0))
    const c = at(cage, (p) => near(p[0], 20) && near(p[1], -20) && near(p[2], 0))
    const loop = edgeLoop(cage, edgeKey(m, c))
    expect(loop.length).toBeLessThan(8)
    expect(loop).toContain(edgeKey(m, c))
  })
})

describe('openings', () => {
  it('delete faces opens the form; fill hole closes it again with one face', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const top = cage.faces.findIndex((f) => f.every((p) => cage.positions[p][2] > 39) && f.some((p) => near(cage.positions[p][0], 20)) && f.some((p) => near(cage.positions[p][1], 20)))
    const opened = deleteFaces(cage, [top])
    expect(validateCage(opened).ok).toBe(true)
    expect(validateCage(opened, true).ok).toBe(false)
    expect(opened.faces).toHaveLength(cage.faces.length - 1)
    const rim = opened.faces.flatMap((f) => f.map((p, i) => edgeKey(p, f[(i + 1) % f.length]))).find((k) => openLoopThrough(opened, k) !== null)!
    expect(openLoopThrough(opened, rim)).toHaveLength(4)
    const closed = fillHole(opened, rim)!
    expect(validateCage(closed, true).problems).toEqual([])
    expect(closed.faces).toHaveLength(cage.faces.length)
    // same orientation as the rest: the smooth surface still encloses a positive volume
    expect(meshVolume(tessellateForm(closed, 0.5).positions, tessellateForm(closed, 0.5).indices)).toBeGreaterThan(0)
  })

  it('points no face uses any more are dropped by delete (a whole side of a plane)', () => {
    const cage = planeCage({ segments: { x: 2, y: 1, z: 1 } })
    const left = cage.faces.findIndex((f) => f.every((p) => cage.positions[p][0] <= 1e-9))
    const out = deleteFaces(cage, [left])
    expect(out.positions).toHaveLength(4)
    expect(validateCage(out).ok).toBe(true)
  })

  it('bridge joins two faces with a tube: a hole through the box (one handle)', () => {
    const cage = boxCage({ segments: { x: 3, y: 3, z: 3 } })
    const centre = (z: number) => cage.faces.findIndex((f) => f.every((p) => near(cage.positions[p][2], z)) && f.every((p) => Math.abs(cage.positions[p][0]) < 7 && Math.abs(cage.positions[p][1]) < 7))
    const top = centre(40), bottom = centre(0)
    expect(eulerOf(cage)).toBe(2)
    const out = bridge(cage, top, bottom)!
    expect(validateCage(out, true).problems).toEqual([])
    expect(out.faces).toHaveLength(cage.faces.length - 2 + 4)
    // V - E + F = 2 - 2g: a through hole is genus 1
    expect(eulerOf(out)).toBe(0)
    expect(meshVolume(tessellateForm(out, 0.5).positions, tessellateForm(out, 0.5).indices)).toBeGreaterThan(0)
  })

  it('bridge refuses faces with different side counts or a shared point', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const f0 = cage.faces[0]
    const touching = cage.faces.findIndex((f, i) => i !== 0 && f.some((p) => f0.includes(p)))
    expect(bridge(cage, 0, touching)).toBeNull()
  })

  it('thicken closes an open plane into a solid slab with crisp rims', () => {
    const cage = planeCage({ segments: { x: 3, y: 3, z: 1 } })
    const out = thicken(cage, 2)!
    expect(validateCage(out, true).problems).toEqual([])
    expect(out.positions).toHaveLength(cage.positions.length * 2)
    // 12 open edges on a 3 x 3 plane: 12 rim quads, 24 creased rim edges
    expect(out.faces).toHaveLength(9 * 2 + 12)
    expect(out.creases.length).toBeGreaterThanOrEqual(24)
    expect(meshVolume(tessellateForm(out, 0.2).positions, tessellateForm(out, 0.2).indices)).toBeGreaterThan(0)
    expect(thicken(boxCage(), 2)).toBeNull()
  })
})

describe('store actions', () => {
  beforeEach(() => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: boxCage({ segments: { x: 2, y: 2, z: 2 } }) })
    useFormStore.getState().setSymmetry(null)
  })

  it('Loop and Ring add to the selection', () => {
    const s = useFormStore.getState()
    const a = at(s.cage, (p) => near(p[0], 0) && near(p[1], -20) && near(p[2], 0))
    const b = at(s.cage, (p) => near(p[0], 0) && near(p[1], -20) && near(p[2], 20))
    s.select({ kind: 'edge', key: edgeKey(a, b) }, false)
    s.selectLoop()
    expect(useFormStore.getState().selection.edges).toHaveLength(8)
    s.select({ kind: 'edge', key: edgeKey(a, b) }, false)
    useFormStore.getState().selectRing()
    expect(useFormStore.getState().selection.edges).toHaveLength(8)
  })

  it('Delete, then Thicken: one undo step each, and the form is closed again', () => {
    const s = useFormStore.getState()
    const top = s.cage.faces.findIndex((f) => f.every((p) => s.cage.positions[p][2] > 39) && f.some((p) => near(s.cage.positions[p][0], 20)) && f.some((p) => near(s.cage.positions[p][1], 20)))
    s.select({ kind: 'face', index: top }, false)
    s.deleteSelectedFaces()
    expect(validateCage(useFormStore.getState().cage, true).ok).toBe(false)
    useFormStore.getState().setThickness(1.5)
    useFormStore.getState().thickenForm()
    const after = useFormStore.getState().cage
    expect(validateCage(after, true).problems).toEqual([])
    useFormStore.getState().undo()
    useFormStore.getState().undo()
    expect(useFormStore.getState().cage.faces).toHaveLength(24)
  })

  it('Bridge the two selected faces; Fill hole caps a selected rim edge', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: boxCage({ segments: { x: 3, y: 3, z: 3 } }) })
    const s = useFormStore.getState()
    const centre = (z: number) => s.cage.faces.findIndex((f) => f.every((p) => near(s.cage.positions[p][2], z)) && f.every((p) => Math.abs(s.cage.positions[p][0]) < 7 && Math.abs(s.cage.positions[p][1]) < 7))
    s.setSelection({ points: [], edges: [], faces: [centre(40), centre(0)] })
    useFormStore.getState().bridgeSelection()
    expect(eulerOf(useFormStore.getState().cage)).toBe(0)
    const c = useFormStore.getState().cage
    const side = c.faces.findIndex((f) => f.every((p) => near(c.positions[p][0], 20)))
    useFormStore.getState().setSelection({ points: [], edges: [], faces: [side] })
    useFormStore.getState().deleteSelectedFaces()
    const opened = useFormStore.getState().cage
    const rim = opened.faces.flatMap((f) => f.map((p, i) => edgeKey(p, f[(i + 1) % f.length]))).find((k) => openLoopThrough(opened, k) !== null)!
    useFormStore.getState().setSelection({ points: [], edges: [rim], faces: [] })
    useFormStore.getState().fillHoleAtSelection()
    expect(validateCage(useFormStore.getState().cage, true).problems).toEqual([])
  })
})

describe('soft modification', () => {
  it('weights fall smoothly from the selection to nothing at the radius', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const top = at(cage, (p) => near(p[0], 0) && near(p[1], 0) && near(p[2], 40))
    const w = softWeights(cage, [top], 25)
    // the top's edge midpoints are 20 away: t = 0.8, weight 1 - 3(0.64) + 2(0.512) = 0.104
    const mid = at(cage, (p) => near(p[0], 20) && near(p[1], 0) && near(p[2], 40))
    expect(w.get(mid)).toBeCloseTo(0.104, 9)
    // a bottom corner is far outside the radius
    expect(w.has(at(cage, (p) => near(p[0], 20) && near(p[1], 20) && near(p[2], 0)))).toBe(false)
    expect(softWeights(cage, [top], 0).size).toBe(0)
  })

  it('a move with a soft radius carries the neighbours part of the way, in one undo step', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: boxCage({ segments: { x: 2, y: 2, z: 2 } }) })
    const st = useFormStore.getState()
    st.setSymmetry(null)
    st.setSoftRadius(25)
    const cage = st.cage
    const top = at(cage, (p) => near(p[0], 0) && near(p[1], 0) && near(p[2], 40))
    const mid = at(cage, (p) => near(p[0], 20) && near(p[1], 0) && near(p[2], 40))
    const corner = at(cage, (p) => near(p[0], 20) && near(p[1], 20) && near(p[2], 0))
    st.select({ kind: 'point', index: top }, false)
    st.beginMove({ extrude: false })
    st.moveBy(new THREE.Matrix4().makeTranslation(0, 0, 10).elements)
    st.endDrag()
    const after = useFormStore.getState().cage
    expect(after.positions[top][2]).toBeCloseTo(50, 9)
    expect(after.positions[mid][2]).toBeCloseTo(40 + 10 * 0.104, 9)
    expect(after.positions[corner][2]).toBeCloseTo(0, 9)
    useFormStore.getState().undo()
    expect(useFormStore.getState().cage.positions[mid][2]).toBeCloseTo(40, 9)
    useFormStore.getState().setSoftRadius(0)
  })
})

describe('symmetry survives Finish -> Edit', () => {
  it('the payload carries the mirror; reopening the feature turns it back on; no mirror, no key', () => {
    const cage = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const payload = makeFormFeaturePayload('Sym', cage, 0.01, 'x')
    expect(payload.symmetry).toBe('x')
    expect('symmetry' in makeFormFeaturePayload('Plain', cage, 0.01, null)).toBe(false)
    useFormStore.getState().openSession({ featureId: 'FRM1', name: payload.name, cage: payload.cage, tolerance: payload.tolerance, symmetry: payload.symmetry ?? null })
    expect(useFormStore.getState().symmetry).toBe('x')
    // a new form starts without a mirror
    useFormStore.getState().openSession({ featureId: null, name: 'New' })
    expect(useFormStore.getState().symmetry).toBeNull()
  })
})

describe('smooth skin display level', () => {
  it('automatic picks the finest level in budget; a requested level is honoured, capped at 4x the budget', () => {
    const small = boxCage({ segments: { x: 2, y: 2, z: 2 } }) // 24 quads -> 96 at level 1
    expect(skinLevels(small)).toEqual({ rest: 4, drag: 3 })
    expect(skinLevels(small, 2)).toEqual({ rest: 2, drag: 1 })
    expect(skinLevels(small, 5)).toEqual({ rest: 5, drag: 4 })
    expect(skinLevels(small, 1)).toEqual({ rest: 1, drag: 1 })
    // a big cage: level 5 would be 4^4 x its level-1 quads - far past 4x the budget
    const big = boxCage({ segments: { x: 16, y: 16, z: 16 } })
    const level1 = big.faces.length * 4
    const got = skinLevels(big, 5).rest
    expect(level1 * 4 ** (got - 1)).toBeLessThanOrEqual(4 * SKIN_QUAD_BUDGET)
    expect(got).toBeLessThan(5)
  })
})

