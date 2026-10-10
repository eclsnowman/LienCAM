// Form: Mirror Z (at the form's mid-height) and circular symmetry round the Z axis.

import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../../form/cage'
import { boxCage, cylinderCage } from '../../form/starters'
import { findPairs, isSymmetryMode, mirrorSelection, symmetrize, unpairedCount } from '../../form/symmetry'
import { makeFormFeaturePayload } from '../../form/formBody'
import { useFormStore } from '../../form/formStore'

const cyl = () => cylinderCage({ size: { x: 40, y: 40, z: 30 }, segments: { x: 8, y: 1, z: 2 } })
const rot = (p: Vec3, k: number, n: number): Vec3 => { const a = (2 * Math.PI * k) / n; return [p[0] * Math.cos(a) - p[1] * Math.sin(a), p[0] * Math.sin(a) + p[1] * Math.cos(a), p[2]] }
const close = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < 1e-9

describe('circular symmetry', () => {
  it('an 8-segment cylinder has every point in a group of 8 round the Z axis (4 and 2 as well; 3 does not fit)', () => {
    for (const n of [8, 4, 2]) expect(unpairedCount(findPairs(cyl(), `c${n}`))).toBe(0)
    expect(unpairedCount(findPairs(cyl(), 'c3'))).toBe(cyl().positions.length)
  })

  it('moving one point moves its seven copies by the same move turned round the axis', () => {
    const c = cyl()
    const pairs = findPairs(c, 'c8')
    const p = c.positions.findIndex((q) => q[2] === 15 && q[0] > 19)
    const moved = c.positions.map((q) => [...q] as Vec3)
    moved[p] = [moved[p][0] + 6, moved[p][1] + 2, moved[p][2] + 3]
    const out = symmetrize({ ...c, positions: moved }, pairs, [p])
    for (let k = 1; k < 8; k++) expect(close(out.positions[pairs.images[k - 1][p]], rot(out.positions[p], k, 8))).toBe(true)
    // the other rings did not move
    const other = c.positions.findIndex((q) => q[2] === 0)
    expect(out.positions[other]).toEqual(c.positions[other])
  })

  it('a face selection widens to its copies all the way round', () => {
    const c = cyl()
    const side = c.faces.findIndex((f) => f.length === 4)
    const s = mirrorSelection(c, findPairs(c, 'c8'), { points: [], edges: [], faces: [side] })
    expect(s.faces).toHaveLength(8)
  })

  it('a point on the axis is held on it', () => {
    const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const centre = c.positions.findIndex((q) => q[0] === 0 && q[1] === 0 && q[2] === 40)
    const pairs = findPairs(c, 'c4')
    expect(pairs.seam[centre]).toBe(1)
    const moved = c.positions.map((q) => [...q] as Vec3)
    moved[centre] = [3, -2, 45]
    expect(symmetrize({ ...c, positions: moved }, pairs, [centre]).positions[centre]).toEqual([0, 0, 45])
  })
})

describe('Mirror Z', () => {
  it('mirrors across the plane through the form\'s mid-height, recorded when switched on', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: boxCage({ segments: { x: 2, y: 2, z: 2 } }) })
    const st = useFormStore.getState()
    st.setSymmetry('z')
    expect(useFormStore.getState().symmetryAt).toBe(20)
    expect(useFormStore.getState().notice).toMatch(/Mirror Z at Z = 20/)
    const top = st.cage.positions.findIndex((q) => q[0] === 20 && q[1] === 20 && q[2] === 40)
    const bottom = st.cage.positions.findIndex((q) => q[0] === 20 && q[1] === 20 && q[2] === 0)
    useFormStore.getState().setSelection({ points: [top], edges: [], faces: [] })
    useFormStore.getState().beginMove({ extrude: false })
    useFormStore.getState().moveBy([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 10, 1])
    useFormStore.getState().endDrag()
    const after = useFormStore.getState().cage.positions
    expect(after[top]).toEqual([25, 20, 50])
    expect(after[bottom]).toEqual([25, 20, -10])
  })

  it('the payload keeps the mode and the plane; editing again restores them', () => {
    const payload = makeFormFeaturePayload('T', boxCage(), 0.05, 'z', 20)
    expect(payload.symmetry).toBe('z')
    expect(payload.symmetryAt).toBe(20)
    expect(makeFormFeaturePayload('T', boxCage(), 0.05, 'c6').symmetryAt).toBeUndefined()
    expect(isSymmetryMode('c6')).toBe(true)
    expect(isSymmetryMode('c1')).toBe(false)
    expect(isSymmetryMode('q')).toBe(false)
    useFormStore.getState().openSession({ featureId: 'FRM1', name: 'T', cage: boxCage(), symmetry: payload.symmetry, symmetryAt: payload.symmetryAt })
    expect(useFormStore.getState().symmetry).toBe('z')
    expect(useFormStore.getState().symmetryAt).toBe(20)
    useFormStore.getState().setSymmetry(null)
  })
})

describe('the store with circular symmetry', () => {
  it('Circular turns on with as many copies as the form fits when the palette count does not fit, and off again', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: cyl() })
    useFormStore.setState({ circularCopies: 6 })
    useFormStore.getState().toggleCircular()
    expect(useFormStore.getState().symmetry).toBe('c8')
    expect(useFormStore.getState().circularCopies).toBe(8)
    expect(useFormStore.getState().notice).toMatch(new RegExp(`^Circular 8: 8 copies round the Z axis; 0 points stay on the axis; 6 copies do not fit this ${cyl().positions.length}-point cage$`))
    useFormStore.getState().toggleCircular()
    expect(useFormStore.getState().symmetry).toBeNull()
    useFormStore.setState({ circularCopies: 4 })
    useFormStore.getState().toggleCircular()
    expect(useFormStore.getState().symmetry).toBe('c4')
    expect(useFormStore.getState().notice).not.toContain('do not fit')
    useFormStore.getState().setSymmetry(null)
  })

  it('Circular keeps the copies in step through a move and an extrude, and the copies count re-applies it', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: cyl() })
    useFormStore.getState().setSymmetry('c8')
    expect(useFormStore.getState().notice).toMatch(/Circular 8: 8 copies round the Z axis/)
    const c = useFormStore.getState().cage
    const side = c.faces.findIndex((f) => f.length === 4 && f.every((p) => c.positions[p][2] >= 15))
    useFormStore.getState().setSelection({ points: [], edges: [], faces: [side] })
    const faces0 = c.faces.length
    useFormStore.getState().beginMove({ extrude: true })
    useFormStore.getState().moveBy([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, 0, 0, 1])
    useFormStore.getState().endDrag()
    const out = useFormStore.getState().cage
    // the face and its 7 copies make a closed band round the form: extruded together, the band gains a wall
    // along each of its two rims (8 + 8 faces); alone, the face would have gained 4
    expect(out.faces.length).toBe(faces0 + 16)
    expect(unpairedCount(findPairs(out, 'c8'))).toBe(0)
    useFormStore.getState().setCircularCopies(4)
    expect(useFormStore.getState().symmetry).toBe('c4')
    useFormStore.getState().setSymmetry(null)
  })
})
