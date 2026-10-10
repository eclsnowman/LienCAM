// Form: a face by clicks (Fusion Form's Face) - corners clicked on a work plane
// or on the form's own points make faces, one at a time.

import { beforeEach, describe, expect, it } from 'vitest'
import type { Cage, Vec3 } from '../../form/cage'
import { planeCage } from '../../form/starters'
import { addClickedFace, rayOnPlane, type FaceClick } from '../../form/faceByClicks'
import { validateCage } from '../../form/halfEdge'
import { useFormStore } from '../../form/formStore'

const XY = { origin: [0, 0, 0] as Vec3, normal: [0, 0, 1] as Vec3 }
const at = (x: number, y: number, z = 0): FaceClick => ({ at: [x, y, z] })
const square = (x0: number, y0: number, s = 10): FaceClick[] => [at(x0, y0), at(x0 + s, y0), at(x0 + s, y0 + s), at(x0, y0 + s)]
const normalOf = (c: Cage, f: number): Vec3 => {
  const P = c.faces[f].map((i) => c.positions[i]), n: Vec3 = [0, 0, 0]
  P.forEach((a, i) => { const b = P[(i + 1) % P.length]; n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1]) })
  return n
}
const empty: Cage = { positions: [], faces: [], creases: [] }

describe('addClickedFace', () => {
  it('four clicks on XY, clockwise or not, make one quad facing +Z (the work plane\'s normal)', () => {
    for (const clicks of [square(0, 0), [...square(0, 0)].reverse()]) {
      const r = addClickedFace(empty, clicks, XY) as { cage: Cage }
      expect(r.cage.faces).toHaveLength(1)
      expect(r.cage.positions).toHaveLength(4)
      expect(normalOf(r.cage, 0)[2]).toBeGreaterThan(0)
    }
  })

  it('a face on two points of a face already there shares its edge, wound the other way along it: one valid sheet', () => {
    const first = (addClickedFace(empty, square(0, 0), XY) as { cage: Cage }).cage
    // the right edge of the first square is points 1 and 2; clicked in either order
    for (const order of [[1, 2], [2, 1]]) {
      const clicks: FaceClick[] = [{ point: order[0] }, at(20, order[0] === 1 ? 0 : 10), at(20, order[0] === 1 ? 10 : 0), { point: order[1] }]
      const r = addClickedFace(first, clicks, XY) as { cage: Cage }
      expect(r.cage.positions).toHaveLength(6)
      expect(validateCage(r.cage, false).problems).toEqual([])
      expect(normalOf(r.cage, 1)[2]).toBeGreaterThan(0)
    }
  })

  it('a shared edge decides the winding even against the work plane: next to a face turned to -Z, the new face turns to -Z too', () => {
    const down = (addClickedFace(empty, square(0, 0), { origin: [0, 0, 0], normal: [0, 0, -1] }) as { cage: Cage }).cage
    expect(normalOf(down, 0)[2]).toBeLessThan(0)
    for (const order of [[1, 2], [2, 1]]) {
      const clicks: FaceClick[] = [{ point: order[0] }, at(20, order[0] === 1 ? 0 : 10), at(20, order[0] === 1 ? 10 : 0), { point: order[1] }]
      const r = addClickedFace(down, clicks, XY) as { cage: Cage }
      expect(validateCage(r.cage, false).problems).toEqual([])
      expect(normalOf(r.cage, 1)[2]).toBeLessThan(0)
    }
  })

  it('replace: the face alone, a new form, even when it snaps to points of the old one', () => {
    const plane = planeCage()
    const r = addClickedFace(plane, [{ point: 0 }, at(100, 0), at(100, 100), at(0, 100)], XY, true) as { cage: Cage }
    expect(r.cage.faces).toHaveLength(1)
    expect(r.cage.positions).toHaveLength(4)
    expect(r.cage.positions[r.cage.faces[0][0]]).toEqual(plane.positions[0])
  })

  it('refused only when it cannot be: a repeated corner, corners on one line, a third face on an edge, a face turned against its neighbours', () => {
    expect(addClickedFace(empty, [at(0, 0), at(10, 0), at(0, 0), at(0, 10)], XY)).toEqual({ reason: 'A face needs three or more different corners' })
    expect(addClickedFace(empty, [at(0, 0), at(10, 0), at(20, 0), at(30, 0)], XY)).toMatchObject({ reason: expect.stringMatching(/on one line/) })
    // a strip of two faces, then a third on their shared edge
    let c = (addClickedFace(empty, square(0, 0), XY) as { cage: Cage }).cage
    c = (addClickedFace(c, [{ point: 1 }, at(20, 0), at(20, 10), { point: 2 }], XY) as { cage: Cage }).cage
    expect(addClickedFace(c, [{ point: 1 }, { point: 2 }, at(10, 5, 10)], XY)).toMatchObject({ reason: expect.stringMatching(/already joins two faces/) })
  })

  it('rayOnPlane: where a ray meets the plane; none running along it or pointing away', () => {
    expect(rayOnPlane([5, 5, 10], [0, 0, -1], XY)).toEqual([5, 5, 0])
    expect(rayOnPlane([5, 5, 10], [1, 0, 0], XY)).toBeNull()
    expect(rayOnPlane([5, 5, 10], [0, 0, 1], XY)).toBeNull()
  })
})

describe('the Face tool in the store', () => {
  const st = () => useFormStore.getState()
  beforeEach(() => { st().openSession({ featureId: null, name: 'F' }) })

  it('Face (a new form): nothing changes until the 4th corner; then the form IS that face, and the tool stays on for the next', () => {
    const before = st().cage
    st().startFaceTool({ replace: true })
    for (const c of square(0, 0).slice(0, 3)) st().addFaceClick(c)
    expect(st().cage).toBe(before)
    expect(st().notice).toBe('Face: 3 of 4 corners (Enter makes a triangle of 3, Esc stops)')
    st().addFaceClick(square(0, 0)[3])
    expect(st().cage.faces).toHaveLength(1)
    expect(st().faceTool).toMatchObject({ replace: false, clicks: [] })
    expect(st().notice).toMatch(/^Added a face with 4 corners as a new form/)
    // the next face shares the first one's right edge
    for (const c of [{ point: 1 }, at(20, 0), at(20, 10), { point: 2 }] as FaceClick[]) st().addFaceClick(c)
    expect(st().cage.faces).toHaveLength(2)
    expect(st().cage.positions).toHaveLength(6)
    // one undo step per face
    st().undo()
    expect(st().cage.faces).toHaveLength(1)
  })

  it('Undo or Redo during a face draft clears its corners (they named points of the form before the undo); the next face still works', () => {
    st().startFaceTool({ replace: true })
    for (const c of square(0, 0)) st().addFaceClick(c)
    // a draft that snaps to the new face's points, then Undo takes that face away
    for (const c of [{ point: 1 }, { point: 2 }] as FaceClick[]) st().addFaceClick(c)
    st().undo()
    expect(st().faceTool?.clicks).toEqual([])
    for (const c of [at(100, 0), at(110, 0), at(105, 8)]) expect(() => st().addFaceClick(c)).not.toThrow()
    expect(() => st().finishFaceDraft()).not.toThrow()
    expect(st().cage.faces.at(-1)).toHaveLength(3)
    st().undo()
    st().addFaceClick(at(200, 0))
    st().redo()
    expect(st().cage.faces.at(-1)).toHaveLength(3)
    expect(st().faceTool?.clicks).toEqual([])
  })

  it('any other new topology under a face draft (Delete, a starter) clears its corners too; the next face still works', () => {
    st().startFaceTool({ replace: true })
    for (const c of square(0, 0)) st().addFaceClick(c)
    for (const c of square(0, 20)) st().addFaceClick(c)
    // a draft on the second face's points, then Delete takes that face (and its points) away
    for (const c of [{ point: 5 }, { point: 6 }] as FaceClick[]) st().addFaceClick(c)
    st().setSelection({ points: [], edges: [], faces: [1] })
    st().deleteSelectedFaces()
    expect(st().faceTool?.clicks).toEqual([])
    for (const c of [at(100, 0), at(110, 0), at(105, 8)]) expect(() => st().addFaceClick(c)).not.toThrow()
    expect(() => st().finishFaceDraft()).not.toThrow()
    // a starter replaces the whole form under a draft
    st().addFaceClick({ point: 0 })
    st().newFromStarter('box')
    expect(st().faceTool?.clicks).toEqual([])
  })

  it('Add face: faces join the form there; Enter with 3 corners makes a triangle; Esc stops the tool', () => {
    const n = st().cage.faces.length
    st().startFaceTool({ replace: false })
    for (const c of [at(100, 0), at(110, 0), at(105, 8)]) st().addFaceClick(c)
    st().finishFaceDraft()
    expect(st().cage.faces).toHaveLength(n + 1)
    expect(st().cage.faces[n]).toHaveLength(3)
    st().stopFaceTool()
    expect(st().faceTool).toBeNull()
    // the result stays in the status line (WO-2499)
    expect(st().notice).toBe('Face tool off - 1 face added')
  })

  it('Enter with fewer than 3 corners says so; a refused face clears the corners and says why', () => {
    st().startFaceTool({ replace: true })
    st().addFaceClick(at(0, 0))
    st().finishFaceDraft()
    expect(st().notice).toBe('Face: 1 of 4 corners; a face needs at least 3')
    for (const c of [at(10, 0), at(20, 0), at(30, 0)]) st().addFaceClick(c)
    expect(st().notice).toMatch(/on one line.*the corners are cleared, click again$/)
    expect(st().faceTool?.clicks).toEqual([])
  })

  it('a work plane from a sketch: the notice names it, and clicks land on it', () => {
    st().startFaceTool({ replace: true, plane: { origin: [0, 0, 5], normal: [0, 0, 1] }, planeWords: 'the plane of Sketch 1' })
    expect(st().notice).toMatch(/^Face: click 4 corners on the plane of Sketch 1/)
    expect(rayOnPlane([1, 2, 30], [0, 0, -1], st().faceTool!.plane)).toEqual([1, 2, 5])
  })

  it('leaving the session turns the tool off', () => {
    st().startFaceTool({ replace: false })
    st().closeSession()
    expect(st().faceTool).toBeNull()
  })

  it('the face it made is selected, so a move or extrude can follow at once', () => {
    st().startFaceTool({ replace: true })
    for (const c of square(0, 0)) st().addFaceClick(c)
    expect(st().selection.faces).toEqual([0])
    expect(st().cage.creases).toEqual([])
  })
})
