// Form: Pull onto a body - the form's surface onto another body's (display) mesh.

import { beforeEach, describe, expect, it } from 'vitest'
import type { Cage, Vec3 } from '../../form/cage'
import { boxCage, sphereCage } from '../../form/starters'
import { closestOnTriangle, closestPointIndex, type MeshLike } from '../../form/closestPoint'
import { pullOntoMesh } from '../../form/shapeTools'
import { applyRows, cagePositionArray, levelFromCage, limitRows, refine, type Level } from '../../form/subdivide'
import { useFormStore } from '../../form/formStore'

/** a sphere's triangle mesh (lat-long), radius r about c */
function sphereMesh(r: number, c: Vec3, seg = 48): MeshLike {
  const position: number[] = [], index: number[] = []
  for (let i = 0; i <= seg; i++) for (let j = 0; j <= seg; j++) {
    const th = (Math.PI * i) / seg, ph = (2 * Math.PI * j) / seg
    position.push(c[0] + r * Math.sin(th) * Math.cos(ph), c[1] + r * Math.sin(th) * Math.sin(ph), c[2] + r * Math.cos(th))
  }
  for (let i = 0; i < seg; i++) for (let j = 0; j < seg; j++) {
    const a = i * (seg + 1) + j, b = a + seg + 1
    index.push(a, b, a + 1, a + 1, b, b + 1)
  }
  return { position, index }
}
function limitOf(cage: Cage): Float64Array {
  let level: Level = levelFromCage(cage)
  let P = cagePositionArray(cage)
  for (let k = 0; k < 5; k++) { const r = refine(level); P = applyRows(r.rows, P); level = r.level }
  return applyRows(limitRows(level), P)
}

describe('closest point on a mesh', () => {
  it('a triangle: inside, beyond an edge, beyond a corner', () => {
    const a: Vec3 = [0, 0, 0], b: Vec3 = [10, 0, 0], c: Vec3 = [0, 10, 0]
    expect(closestOnTriangle([2, 2, 5], a, b, c)).toEqual([2, 2, 0])
    expect(closestOnTriangle([5, -3, 0], a, b, c)).toEqual([5, 0, 0])
    expect(closestOnTriangle([-4, -4, 1], a, b, c)).toEqual([0, 0, 0])
  })

  it('a sphere mesh: points inside and outside find the surface, as a search of every triangle does', () => {
    const m = sphereMesh(30, [0, 0, 20])
    const idx = closestPointIndex(m)
    const brute = (q: Vec3) => {
      let best = Infinity
      for (let t = 0; t < m.index.length / 3; t++) {
        const v = (k: number): Vec3 => { const i = m.index[t * 3 + k] * 3; return [m.position[i], m.position[i + 1], m.position[i + 2]] }
        const p = closestOnTriangle(q, v(0), v(1), v(2))
        best = Math.min(best, Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]))
      }
      return best
    }
    for (const q of [[0, 0, 20], [5, 3, 25], [40, 0, 20], [-10, 50, 60], [100, 100, 100]] as Vec3[]) expect(idx.closest(q).distance).toBeCloseTo(brute(q), 9)
  })
})

describe('pullOntoMesh', () => {
  it('the sphere starter (skin +-16.5) onto a sphere of radius 25: every pulled surface point lands on it (to its mesh), the form swells to it', () => {
    const c = sphereCage()
    const m = closestPointIndex(sphereMesh(25, [0, 0, 20], 96))
    const r = pullOntoMesh(c, c.positions.map((_, i) => i), m)!
    expect(r.before).toBeGreaterThan(5)
    expect(r.after).toBeLessThan(0.05)
    const L = limitOf(r.cage)
    for (let i = 0; i < c.positions.length; i++) expect(Math.abs(Math.hypot(L[i * 3], L[i * 3 + 1], L[i * 3 + 2] - 20) - 25)).toBeLessThan(0.1)
  })

  it('only the given points move', () => {
    const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const top = c.positions.map((p, i) => [p, i] as const).filter(([p]) => p[2] > 39).map(([, i]) => i)
    const r = pullOntoMesh(c, top, closestPointIndex(sphereMesh(40, [0, 0, 0])))!
    c.positions.forEach((p, i) => { if (!top.includes(i)) expect(r.cage.positions[i]).toEqual(p) })
  })
})

describe('Pull onto a body in the store', () => {
  const st = () => useFormStore.getState()
  beforeEach(() => { st().openSession({ featureId: null, name: 'F', cage: sphereCage() }) })

  it('nothing selected pulls every point, one undo step, and the notice names the body and how close it is now', () => {
    const before = st().cage
    st().setSelection({ points: [], edges: [], faces: [] })
    st().pullOntoBody(sphereMesh(25, [0, 0, 20], 96), 'Ball')
    expect(st().notice).toMatch(/^Pulled the surface at all 26 points onto Ball: within 0\.0\d mm of its display mesh \(it was up to [\d.]+ mm off\)$/)
    st().undo()
    expect(st().cage.positions).toEqual(before.positions)
  })
})
