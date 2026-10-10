// Form stage 19: Delete edges - the faces either side of each edge merge; an
// edge loop goes whole (its points, left between two edges, go too).

import { describe, expect, it } from 'vitest'
import { edgeKey, type Cage } from '../../form/cage'
import { boxCage, planeCage } from '../../form/starters'
import { dissolveEdges } from '../../form/topoTools'
import { setCreased } from '../../form/edgeLoop'
import { validateCage } from '../../form/halfEdge'
import { useFormStore } from '../../form/formStore'

const edgesWhere = (c: Cage, on: (p: readonly number[]) => boolean) => {
  const out = new Set<string>()
  for (const loop of c.faces) for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]
    if (on(c.positions[a]) && on(c.positions[b])) out.add(edgeKey(a, b))
  }
  return [...out]
}
const box2 = () => boxCage({ segments: { x: 2, y: 2, z: 2 } })

describe('dissolveEdges', () => {
  it('deleting the edge loop round a box\'s middle leaves the box one segment tall there, closed', () => {
    const c = box2()
    const ring = edgesWhere(c, (p) => p[2] === 20)
    expect(ring).toHaveLength(8)
    const r = dissolveEdges(c, ring)!
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.removed).toBe(8)
    expect(r.points).toBe(8)
    expect(r.cage.positions).toHaveLength(26 - 8)
    expect(r.cage.faces).toHaveLength(24 - 8)
    expect(r.cage.positions.some((p) => p[2] === 20)).toBe(false)
    // the side faces are quads again, spanning the full height
    const sides = r.cage.faces.filter((f) => f.some((p) => r.cage.positions[p][2] === 0) && f.some((p) => r.cage.positions[p][2] === 40))
    expect(sides).toHaveLength(8)
    expect(sides.every((f) => f.length === 4)).toBe(true)
  })

  it('one edge inside the top merges its two quads into a hexagon; its ends keep their other edges', () => {
    const c = box2()
    const one = edgesWhere(c, (p) => p[2] === 40 && p[1] === 0 && p[0] >= 0)
    expect(one).toHaveLength(1)
    const r = dissolveEdges(c, one)!
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.points).toBe(0)
    expect(r.cage.faces).toHaveLength(23)
    expect(r.cage.faces.filter((f) => f.length === 6)).toHaveLength(1)
  })

  it('edges on an open border have one face and are left: null when nothing else is selected', () => {
    const sheet = planeCage({ size: { x: 20, y: 20, z: 0 }, segments: { x: 2, y: 2, z: 1 } })
    const border = edgesWhere(sheet, (p) => Math.abs(p[0]) === 10)
    expect(dissolveEdges(sheet, border)).toBeNull()
    // the sheet's middle line (x = 0): the quads either side merge
    const mid = edgesWhere(sheet, (p) => Math.abs(p[0]) < 1e-9)
    const r = dissolveEdges(sheet, mid)!
    expect(validateCage(r.cage).problems).toEqual([])
    expect(r.cage.faces).toHaveLength(2)
    // the centre point was left between two edges and is not on the border: it goes; the border ends stay
    expect(r.points).toBe(1)
  })

  it('removing a point joins its two edges into one, creased when both were', () => {
    const c0 = box2()
    // crease the vertical front edges above and below (20, -20, 20), then delete the middle loop
    const col = edgesWhere(c0, (p) => p[0] === 20 && p[1] === -20)
    expect(col).toHaveLength(2)
    const c = setCreased(c0, col, true)
    const r = dissolveEdges(c, edgesWhere(c, (p) => p[2] === 20))!
    expect(validateCage(r.cage, true).problems).toEqual([])
    const P = r.cage.positions
    const at = (x: number, y: number, z: number) => P.findIndex((p) => p[0] === x && p[1] === y && p[2] === z)
    expect(r.cage.creases).toEqual([edgeKey(at(20, -20, 0), at(20, -20, 40))])
  })
})

describe('the store', () => {
  it('Delete with edges selected dissolves them (and their mirrors); with faces selected it still opens the form', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: box2() })
    const st = useFormStore.getState()
    st.setSelection({ points: [], edges: edgesWhere(st.cage, (p) => p[2] === 20), faces: [] })
    st.deleteSelection()
    const after = useFormStore.getState()
    expect(after.notice).toBe('Deleted 8 edges: the faces either side merged; 8 points left between two edges removed')
    expect(after.cage.positions).toHaveLength(18)
    after.undo()
    expect(useFormStore.getState().cage.positions).toHaveLength(26)
    // Mirror X: one top edge at +X takes its mirror too
    useFormStore.getState().setSymmetry('x')
    const c = useFormStore.getState().cage
    useFormStore.getState().setSelection({ points: [], edges: edgesWhere(c, (p) => p[2] === 40 && p[1] === 0 && p[0] >= 0), faces: [] })
    useFormStore.getState().deleteSelection()
    // both halves of the top's middle line go; the centre point, left between two edges, goes too: two pentagons
    const m = useFormStore.getState().cage
    expect(m.faces.filter((f) => f.length === 5)).toHaveLength(2)
    expect(m.positions.some((p) => p[0] === 0 && p[1] === 0 && p[2] === 40)).toBe(false)
    // faces: an opening, as before
    useFormStore.getState().setSymmetry(null)
    useFormStore.getState().setSelection({ points: [], edges: [], faces: [0] })
    useFormStore.getState().deleteSelection()
    expect(useFormStore.getState().notice).toMatch(/^Deleted 1 face: the form is open there/)
  })

  it('border edges alone: says there is nothing to delete', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: planeCage({ size: { x: 20, y: 20, z: 0 }, segments: { x: 2, y: 2, z: 1 } }) })
    const c = useFormStore.getState().cage
    useFormStore.getState().setSelection({ points: [], edges: edgesWhere(c, (p) => Math.abs(p[0]) === 10), faces: [] })
    useFormStore.getState().deleteSelection()
    expect(useFormStore.getState().notice).toMatch(/^Nothing to delete there/)
  })
})
