// Form: Flatten onto a chosen plane - an X, Y or Z plane (through the points or
// at a typed position), the selected face's plane, or the mirror plane.

import { beforeEach, describe, expect, it } from 'vitest'
import type { Cage, Vec3 } from '../../form/cage'
import { boxCage } from '../../form/starters'
import { flattenPoints, principalAxes } from '../../form/shapeTools'
import { useFormStore } from '../../form/formStore'

/** a 2 x 2 x 2 box with every point nudged, so no face is flat and no plane is an axis plane */
function nudged(): Cage {
  const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
  return { ...c, positions: c.positions.map((p, i) => [p[0] + Math.sin(i * 1.3), p[1] + Math.cos(i * 0.7), p[2] + Math.sin(i * 2.1) * 1.5] as Vec3) }
}
const st = () => useFormStore.getState()
const top = (c: Cage) => c.positions.map((p, i) => [p, i] as const).filter(([p]) => p[2] > 35).map(([, i]) => i)
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]

describe('flattenPoints onto a given plane', () => {
  it('takes any number of points (one is enough) and reports how far the farthest was', () => {
    const c = nudged()
    const r = flattenPoints(c, [0], { origin: [0, 0, 7], normal: [0, 0, 2] })!
    expect(r.cage.positions[0][2]).toBeCloseTo(7, 12)
    expect(r.cage.positions[0].slice(0, 2)).toEqual(c.positions[0].slice(0, 2))
    expect(r.before).toBeCloseTo(Math.abs(c.positions[0][2] - 7), 12)
    expect(flattenPoints(c, [0, 1])).toBeNull()
  })
})

describe('Flatten onto, in the store', () => {
  beforeEach(() => {
    st().openSession({ featureId: null, name: 'F', cage: nudged() })
    st().setFlattenOnto('fit')
  })

  it('the Z plane through the points: every selected point at their mean height, nothing else moved', () => {
    const c = st().cage
    const pts = top(c)
    const mean = pts.reduce((a, p) => a + c.positions[p][2], 0) / pts.length
    st().setSelection({ points: pts, edges: [], faces: [] })
    st().setFlattenOnto('z')
    st().flattenSelection()
    const P = st().cage.positions
    for (const p of pts) expect(P[p][2]).toBeCloseTo(mean, 9)
    const other = c.positions.findIndex((_, i) => !pts.includes(i))
    expect(P[other]).toEqual(c.positions[other])
    expect(st().notice).toMatch(/^Flattened 9 points onto the Z plane at Z = [\d.]+ \(the farthest was [\d.]+ mm off it\)$/)
  })

  it('a typed position: the X plane at X = 25', () => {
    const pts = st().cage.positions.map((p, i) => [p, i] as const).filter(([p]) => p[0] > 15).map(([, i]) => i)
    st().setSelection({ points: pts, edges: [], faces: [] })
    st().setFlattenOnto('x')
    st().setFlattenAt(25)
    st().flattenSelection()
    for (const p of pts) expect(st().cage.positions[p][0]).toBeCloseTo(25, 12)
    expect(st().notice).toMatch(/onto the X plane at X = 25 /)
  })

  it('choosing another plane forgets the typed position', () => {
    st().setFlattenOnto('x')
    st().setFlattenAt(25)
    st().setFlattenOnto('y')
    expect(st().flattenAt).toBeNull()
  })

  it('the selected face\'s plane: other selected points go onto the plane of that (tilted) face', () => {
    const c = st().cage
    const f = c.faces.findIndex((loop) => loop.every((p) => c.positions[p][2] > 35))
    const extra = c.positions.findIndex((p) => p[2] < 5)
    st().setSelection({ points: [extra], edges: [], faces: [f] })
    st().setFlattenOnto('face')
    st().flattenSelection()
    const P = st().cage.positions
    // the plane is the FACE's (its corners as they were), not a fit through everything selected:
    // the far point lands on it
    const fit = principalAxes(c.faces[f].map((p) => c.positions[p]))
    const off = (q: Vec3) => Math.abs(dot(fit.axes[0], q) - dot(fit.axes[0], fit.centre))
    for (const p of [...c.faces[f], extra]) expect(off(P[p])).toBeLessThan(1e-9)
    expect(st().notice).toMatch(/onto the selected face's plane/)
  })

  it('the selected face\'s plane with no face selected: the notice says to pick one, nothing moves', () => {
    const before = st().cage
    st().setSelection({ points: top(before), edges: [], faces: [] })
    st().setFlattenOnto('face')
    st().flattenSelection()
    expect(st().cage).toBe(before)
    expect(st().notice).toBe('Select a face: its plane is the one the points go onto')
  })

  it('the mirror plane: points go onto the moved Mirror X plane; with no mirror on it flattens by best fit, as the list then shows', () => {
    const pts = top(st().cage)
    st().setSelection({ points: pts, edges: [], faces: [] })
    st().setFlattenOnto('mirror')
    const before = st().cage
    st().flattenSelection()
    expect(st().cage).not.toBe(before)
    expect(st().notice).not.toMatch(/Turn on a mirror|mirror plane/)
    const fitted = st().cage
    st().setFlattenOnto('fit')
    st().setSelection({ points: pts, edges: [], faces: [] })
    useFormStore.setState({ cage: before })
    st().flattenSelection()
    for (const p of pts) for (let k = 0; k < 3; k++) expect(fitted.positions[p][k]).toBeCloseTo(st().cage.positions[p][k], 9)
    st().setFlattenOnto('mirror')
    st().setSymmetry('x')
    st().setSymmetryAt(5)
    st().setSelection({ points: [pts[0]], edges: [], faces: [] })
    st().flattenSelection()
    expect(st().cage.positions[pts[0]][0]).toBeCloseTo(5, 12)
    expect(st().notice).toMatch(/onto the mirror plane/)
  })

  it('with Mirror X on, flattening one side onto a Z plane flattens its mirror partners too', () => {
    const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    // symmetric across X = 0, top points at uneven heights
    const positions = c.positions.map((p) => [p[0], p[1], p[2] > 35 ? p[2] + Math.abs(p[0]) / 10 + p[1] / 20 : p[2]] as Vec3)
    st().openSession({ featureId: null, name: 'F', cage: { ...c, positions } })
    st().setSymmetry('x')
    const plus = positions.map((p, i) => [p, i] as const).filter(([p]) => p[2] > 35 && p[0] > 1).map(([, i]) => i)
    st().setSelection({ points: plus, edges: [], faces: [] })
    st().setFlattenOnto('z')
    st().setFlattenAt(45)
    st().flattenSelection()
    const P = st().cage.positions
    const minus = positions.map((p, i) => [p, i] as const).filter(([p]) => p[2] > 35 && p[0] < -1).map(([, i]) => i)
    for (const p of [...plus, ...minus]) expect(P[p][2]).toBeCloseTo(45, 9)
  })
})
