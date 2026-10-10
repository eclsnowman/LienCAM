// @vitest-environment jsdom
// Form stage 24: a mirror plane the operator places - moved along its axis, or
// through the selection (halfway between two points, or through three or more).

import { beforeEach, describe, expect, it } from 'vitest'
import * as THREE from 'three'
import type { Cage, Vec3 } from '../../form/cage'
import { boxCage } from '../../form/starters'
import { findPairs, mirrorPlaneFrom, symmetrize, unpairedCount } from '../../form/symmetry'
import { makeFormFeaturePayload } from '../../form/formBody'
import { useFormStore } from '../../form/formStore'

const close = (a: Vec3, b: Vec3, tol = 1e-9) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) < tol
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const reflect = (p: Vec3, n: Vec3, at: number): Vec3 => { const d = 2 * (dot(n, p) - at); return [p[0] - d * n[0], p[1] - d * n[1], p[2] - d * n[2]] }

/** a 2 x 2 x 2 box turned 30 degrees round Z and moved to (15, -5, 0): symmetric across a tilted plane through its centre, not across any axis plane */
function turnedBox(): { cage: Cage; normal: Vec3; at: number } {
  const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
  const a = Math.PI / 6, cs = Math.cos(a), sn = Math.sin(a)
  const positions = c.positions.map((p) => [p[0] * cs - p[1] * sn + 15, p[0] * sn + p[1] * cs - 5, p[2]] as Vec3)
  // the box's own X = 0 plane, turned and moved with it
  const normal: Vec3 = [cs, sn, 0]
  return { cage: { ...c, positions }, normal, at: dot(normal, [15, -5, 0]) }
}

describe('placing a mirror plane from points', () => {
  it('two points: the plane halfway between them maps one onto the other', () => {
    const a: Vec3 = [1, 2, 3], b: Vec3 = [5, 9, -1]
    const plane = mirrorPlaneFrom([a, b])!
    expect(plane.mode).toBe('p')
    expect(close(reflect(a, plane.normal, plane.at), b)).toBe(true)
  })

  it('two points square across an axis plane give that axis\'s mirror, moved along it', () => {
    expect(mirrorPlaneFrom([[2, 4, 1], [12, 4, 1]])).toMatchObject({ mode: 'x', at: 7 })
    expect(mirrorPlaneFrom([[0, 0, 30], [0, 0, 10]])).toMatchObject({ mode: 'z', at: 20 })
  })

  it('three or more points: the plane through them, reading the same whichever way round they are given', () => {
    const { cage, normal, at } = turnedBox()
    const seam = cage.positions.filter((p) => Math.abs(dot(normal, p) - at) < 1e-9)
    expect(seam.length).toBeGreaterThanOrEqual(3)
    const plane = mirrorPlaneFrom(seam)!
    const back = mirrorPlaneFrom([...seam].reverse())!
    expect(plane.mode).toBe('p')
    expect(Math.abs(dot(plane.normal, normal))).toBeCloseTo(1, 9)
    expect(plane.normal).toEqual(back.normal)
    expect(plane.deviation).toBeLessThan(1e-9)
  })

  it('points on one line, or in one place, fix no plane', () => {
    expect(mirrorPlaneFrom([[0, 0, 0], [1, 1, 1], [2, 2, 2]])).toBeNull()
    expect(mirrorPlaneFrom([[3, 3, 3], [3, 3, 3]])).toBeNull()
    expect(mirrorPlaneFrom([[3, 3, 3]])).toBeNull()
  })
})

describe('a placed plane pairs and mirrors points', () => {
  it('a turned box pairs every point across its tilted plane (and no axis plane pairs them)', () => {
    const { cage, normal, at } = turnedBox()
    expect(unpairedCount(findPairs(cage, 'p', at, normal))).toBe(0)
    for (const axis of ['x', 'y'] as const) expect(unpairedCount(findPairs(cage, axis, 0))).toBeGreaterThan(0)
  })

  it('moving a point moves its partner to its mirror image; a seam point pulled off the plane goes back onto it', () => {
    const { cage, normal, at } = turnedBox()
    const pairs = findPairs(cage, 'p', at, normal)
    const p = pairs.seam.findIndex((v, i) => v === 0 && dot(normal, cage.positions[i]) > at)
    const s = pairs.seam.findIndex((v) => v === 1)
    const moved = cage.positions.map((q) => [...q] as Vec3)
    moved[p] = [moved[p][0] + 3, moved[p][1] - 1, moved[p][2] + 2]
    moved[s] = [moved[s][0] + normal[0] * 4, moved[s][1] + normal[1] * 4, moved[s][2] + 1]
    const out = symmetrize({ ...cage, positions: moved }, pairs, [p, s])
    expect(close(out.positions[pairs.partner[p]], reflect(out.positions[p], normal, at))).toBe(true)
    expect(Math.abs(dot(normal, out.positions[s]) - at)).toBeLessThan(1e-9)
    // it kept its move along the plane
    expect(out.positions[s][2]).toBeCloseTo(cage.positions[s][2] + 1, 9)
  })
})

describe('the Form store', () => {
  beforeEach(() => {
    useFormStore.getState().openSession({ featureId: null, name: 'F', cage: turnedBox().cage })
  })
  const st = () => useFormStore.getState()

  it('Mirror between with a point and its partner selected places the plane between them; a move then mirrors across it', () => {
    const { cage, normal, at } = turnedBox()
    const a = cage.positions.findIndex((p) => dot(normal, p) - at > 1)
    const b = cage.positions.findIndex((p) => close(p, reflect(cage.positions[a], normal, at), 1e-6))
    st().setSelection({ points: [a, b], edges: [], faces: [] })
    st().mirrorFromSelection()
    expect(st().symmetry).toBe('p')
    expect(Math.abs(dot(st().symmetryNormal!, normal))).toBeCloseTo(1, 9)
    expect(st().notice).toMatch(/^Mirror plane .*: \d+ seam points stay on the plane$/)
    st().setSelection({ points: [a], edges: [], faces: [] })
    st().beginMove({ extrude: false })
    st().moveBy([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 2, 3, 4, 1])
    st().endDrag()
    const P = st().cage.positions
    expect(close(P[b], reflect(P[a], st().symmetryNormal!, st().symmetryAt), 1e-6)).toBe(true)
  })

  it('the plane row moves the plane along its normal: moved off the centre, points lose their partners and say so', () => {
    const { cage, normal, at } = turnedBox()
    st().setSelection({ points: cage.positions.map((_, i) => i).filter((i) => Math.abs(dot(normal, cage.positions[i]) - at) < 1e-9), edges: [], faces: [] })
    st().mirrorFromSelection()
    st().setSymmetryAt(st().symmetryAt + 5)
    expect(st().notice).toMatch(/no mirror partner and move alone$/)
    st().setSymmetryAt(st().symmetryAt - 5)
    expect(st().notice).not.toMatch(/alone/)
  })

  it('Mirror X then the plane row: a box standing at X = 7 pairs once the plane is moved to 7', () => {
    const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    st().openSession({ featureId: null, name: 'F', cage: { ...c, positions: c.positions.map((p) => [p[0] + 7, p[1], p[2]] as Vec3) } })
    st().setSymmetry('x')
    expect(st().notice).toMatch(/move alone$/)
    st().setSymmetryAt(7)
    expect(st().notice).toBe('Mirror X at X = 7: 8 seam points stay on the plane')
  })

  it('nothing selected, or points on one line: the notice says what to pick and the symmetry stays as it was', () => {
    st().setSelection({ points: [], edges: [], faces: [] })
    st().mirrorFromSelection()
    expect(st().symmetry).toBeNull()
    expect(st().notice).toMatch(/Select two points/)
  })

  it('a placed plane is kept with the feature and comes back when the form is edited again', () => {
    const { cage, normal, at } = turnedBox()
    const payload = makeFormFeaturePayload('F', cage, 0.05, 'p', at, normal)
    expect(payload.symmetryNormal).toEqual(normal)
    expect(payload.symmetryAt).toBe(at)
    expect(makeFormFeaturePayload('F', cage, 0.05, 'x', 3, normal).symmetryNormal).toBeUndefined()
    st().openSession({ featureId: 'FRM1', name: 'F', cage, symmetry: payload.symmetry, symmetryAt: payload.symmetryAt, symmetryNormal: payload.symmetryNormal })
    expect(st().symmetry).toBe('p')
    expect(st().symmetryNormal).toEqual(normal)
  })
})

describe('the overlay draws the plane', () => {
  it('a square round the form on the plane while a mirror is on, gone when it is off', async () => {
    const { FormOverlay } = await import('../../form/formOverlay')
    const overlay = new FormOverlay({
      addObject: () => {}, removeObject: () => {}, requestRender: () => {},
      camera: () => new THREE.PerspectiveCamera(), canvas: document.createElement('canvas'),
    })
    const { cage, normal, at } = turnedBox()
    const base = { cage, topologyVersion: 1, displayMode: 'both' as const, dragging: false }
    overlay.update({ ...base, mirror: { normal, at } })
    const shown = overlay.mirrorShown()!
    expect(Math.abs(dot(shown.normal, normal))).toBeCloseTo(1, 6)
    expect(Math.abs(dot(normal, shown.centre) - at)).toBeLessThan(1e-6)
    expect(shown.size).toBeGreaterThan(40)
    overlay.update({ ...base, mirror: null })
    expect(overlay.mirrorShown()).toBeNull()
    overlay.dispose()
  })
})
