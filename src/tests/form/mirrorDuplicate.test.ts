// Form: Mirror duplicate - the form and its mirror image across a plane, joined along it.

import { beforeEach, describe, expect, it } from 'vitest'
import { edgeKey, type Cage } from '../../form/cage'
import { boxCage } from '../../form/starters'
import { mirrorDuplicate } from '../../form/mirrorDuplicate'
import { validateCage } from '../../form/halfEdge'
import { compactWithMap } from '../../form/topoTools'
import { useFormStore } from '../../form/formStore'

const box = () => boxCage({ size: { x: 40, y: 40, z: 40 }, segments: { x: 2, y: 2, z: 2 } })
/** the +X half of the box, open along X = 0 */
const openHalf = (): Cage => { const c = box(); return compactWithMap({ ...c, faces: c.faces.filter((f) => f.every((p) => c.positions[p][0] >= 0)) }).cage }
/** a closed box from X = 0 to 20 (one face on the plane X = 0) */
const closedHalf = (): Cage => { const c = boxCage({ size: { x: 20, y: 40, z: 40 }, segments: { x: 1, y: 2, z: 2 } }); return { ...c, positions: c.positions.map((p) => [p[0] + 10, p[1], p[2]]) } }
const key = (c: Cage) => c.positions.map((p) => p.map((v) => Math.round(v * 1e6) / 1e6).join(',')).sort().join(';')

describe('mirrorDuplicate', () => {
  it('a half box open along X = 0 becomes the whole box: closed, valid, the same points and faces as the full box', () => {
    const half = openHalf()
    expect(validateCage(half, true).ok).toBe(false)
    const r = mirrorDuplicate(half, [1, 0, 0], 0)
    expect(validateCage(r.cage, true).problems).toEqual([])
    const full = box()
    expect(r.cage.faces).toHaveLength(full.faces.length)
    expect(key(r.cage)).toBe(key(full))
    expect(r.seam).toBe(8)
    expect(r.across).toBe(0)
  })

  it('a closed half with a face on the plane: those faces join away, one closed box twice as wide', () => {
    const half = closedHalf()
    const r = mirrorDuplicate(half, [1, 0, 0], 0)
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.dropped).toBe(4)
    expect(r.cage.faces).toHaveLength(2 * half.faces.length - 2 * 4)
    const xs = r.cage.positions.map((p) => p[0])
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([-20, 20])
  })

  it('creases are mirrored with their edges; a point a hair off the plane is snapped onto it and shared', () => {
    const half = openHalf()
    const a = half.positions.findIndex((p) => p[0] === 20 && p[1] === 20 && p[2] === 40)
    const b = half.positions.findIndex((p) => p[0] === 20 && p[1] === 20 && p[2] === 20)
    const seamPoint = half.positions.findIndex((p) => p[0] === 0)
    const nudged: Cage = { ...half, creases: [edgeKey(a, b)], positions: half.positions.map((p, i) => i === seamPoint ? [1e-5, p[1], p[2]] : p) }
    const r = mirrorDuplicate(nudged, [1, 0, 0], 0)
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.cage.creases).toHaveLength(2)
    const ends = r.cage.creases.map((k) => k.split(':').map(Number).map((i) => r.cage.positions[i][0]))
    expect(ends.map((e) => e.every((x) => x === 20) || e.every((x) => x === -20))).toEqual([true, true])
    expect(r.cage.positions.filter((p) => p[0] === 0)).toHaveLength(8)
  })

  it('a form across the plane is still copied, and says how many points the copy overlaps', () => {
    const r = mirrorDuplicate(box(), [1, 0, 0], 10)
    expect(r.across).toBeGreaterThan(0)
  })
})

describe('Duplicate in the store', () => {
  const st = () => useFormStore.getState()
  beforeEach(() => { st().openSession({ featureId: null, name: 'F', cage: openHalf() }) })

  it('the starting box refuses the overlapping copy in plain words without changing the cage or history', () => {
    st().openSession({ featureId: null, name: 'F' })
    const { cage, history } = st()
    st().mirrorDuplicateForm()
    expect(st().notice).toBe('Duplicate mirrors half a form: this form already reaches across X = 0, so the copy would overlap it. Delete the faces on one side first, or move the mirror plane.')
    expect(st().cage).toBe(cage)
    expect(st().history).toBe(history)
    expect(st().symmetry).toBeNull()
  })

  it('with no mirror on: across X = 0, the whole form, the mirror left on with every point paired; one undo step', () => {
    st().mirrorDuplicateForm()
    expect(validateCage(st().cage, true).problems).toEqual([])
    expect(st().symmetry).toBe('x')
    expect(st().notice).toMatch(/^Mirrored a copy across the YZ plane \(X = 0; no mirror was on\): 8 seam points shared/)
    expect(st().notice).not.toMatch(/no mirror partner/)
    st().undo()
    expect(st().cage.faces).toHaveLength(openHalf().faces.length)
  })

  it('with a mirror on at X = 20 (the open half\'s outer face): across that plane; that face joins away, leaving a tube open at both ends', () => {
    st().setSymmetry('x')
    st().setSymmetryAt(20)
    st().mirrorDuplicateForm()
    const xs = st().cage.positions.map((p) => p[0])
    expect([Math.min(...xs), Math.max(...xs)]).toEqual([0, 40])
    expect(st().notice).toBe('Mirrored a copy across the mirror plane: 9 seam points shared; 4 faces on the plane joined away')
    expect(validateCage(st().cage, false).problems).toEqual([])
    expect(st().symmetryAt).toBe(20)
  })
})
