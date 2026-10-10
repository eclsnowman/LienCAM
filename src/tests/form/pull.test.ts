// Form: Pull - the smooth surface through the selected cage points, where they are now.

import { beforeEach, describe, expect, it } from 'vitest'
import type { Cage, Vec3 } from '../../form/cage'
import { edgeKey } from '../../form/cage'
import { boxCage, sphereCage } from '../../form/starters'
import { setCreased } from '../../form/edgeLoop'
import { pullToLimit } from '../../form/shapeTools'
import { applyRows, cagePositionArray, levelFromCage, limitRows, refine, type Level } from '../../form/subdivide'
import { tessellateForm } from '../../form/finish'
import { useFormStore } from '../../form/formStore'

/**
 * Where the surface point a cage point names really is, found independently of
 * pullToLimit (which reads it three levels down): five refinement steps (a cage
 * point keeps its index each time), then the limit mask at that finer level.
 */
function limitOf(cage: Cage): Float64Array {
  let level: Level = levelFromCage(cage)
  let P = cagePositionArray(cage)
  for (let k = 0; k < 5; k++) { const r = refine(level); P = applyRows(r.rows, P); level = r.level }
  return applyRows(limitRows(level), P)
}
const at = (L: Float64Array, i: number): Vec3 => [L[i * 3], L[i * 3 + 1], L[i * 3 + 2]]
const dist = (a: Vec3, b: readonly number[]) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
const volume = (c: Cage) => {
  const t = tessellateForm(c, 0.05)
  const P = t.positions, I = t.indices
  let v = 0
  for (let i = 0; i < I.length; i += 3) {
    const x = I[i] * 3, y = I[i + 1] * 3, z = I[i + 2] * 3
    v += (P[x] * (P[y + 1] * P[z + 2] - P[y + 2] * P[z + 1]) - P[x + 1] * (P[y] * P[z + 2] - P[y + 2] * P[z]) + P[x + 2] * (P[y] * P[z + 1] - P[y + 1] * P[z])) / 6
  }
  return v
}

describe('pullToLimit', () => {
  it('every point of the sphere starter: the surface then passes through the cage points (checked three levels down), and swells to reach them', () => {
    const c = sphereCage()
    const r = pullToLimit(c, c.positions.map((_, i) => i))!
    expect(r.before).toBeGreaterThan(1)
    expect(r.after).toBeLessThan(1e-4)
    const L = limitOf(r.cage)
    for (let i = 0; i < c.positions.length; i++) expect(dist(at(L, i), c.positions[i])).toBeLessThan(1e-3)
    expect(volume(r.cage)).toBeGreaterThan(volume(c) * 1.05)
  })

  it('only the given points move, and the surface passes through them; the rest of the cage is as it was', () => {
    const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const top = c.positions.map((p, i) => [p, i] as const).filter(([p]) => p[2] > 39).map(([, i]) => i)
    const r = pullToLimit(c, top)!
    const L = limitOf(r.cage)
    for (const i of top) expect(dist(at(L, i), c.positions[i])).toBeLessThan(1e-3)
    c.positions.forEach((p, i) => { if (!top.includes(i)) expect(r.cage.positions[i]).toEqual(p) })
  })

  it('a creased edge: its points follow the crease rule and land their surface on the targets (within 0.1 mm next to where the crease ends, where subdivision settles slowly)', () => {
    const b = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const c = setCreased(b, [edgeKey(b.faces[0][0], b.faces[0][1]), edgeKey(b.faces[0][1], b.faces[0][2])], true)
    const all = c.positions.map((_, i) => i)
    const r = pullToLimit(c, all)!
    expect(r.after).toBeLessThan(1e-4)
    const L = limitOf(r.cage)
    // measured 0.061 mm against five levels; every point away from the crease's ends within 1e-3
    const worst = Math.max(...all.map((i) => dist(at(L, i), c.positions[i])))
    expect(worst).toBeLessThan(0.1)
    const ends = new Set(c.creases.flatMap((k) => k.split(':').map(Number)))
    const near = new Set([...ends, ...c.faces.filter((f) => f.some((p) => ends.has(p))).flat()])
    for (const i of all) if (!near.has(i)) expect(dist(at(L, i), c.positions[i])).toBeLessThan(1e-3)
  })

  it('nothing given: null', () => {
    expect(pullToLimit(boxCage(), [])).toBeNull()
  })
})

describe('Pull in the store', () => {
  const st = () => useFormStore.getState()
  beforeEach(() => { st().openSession({ featureId: null, name: 'F', cage: sphereCage() }) })

  it('nothing selected pulls the whole form, one undo step, and says how close the surface now is', () => {
    const before = st().cage
    st().setSelection({ points: [], edges: [], faces: [] })
    st().pullSelection()
    expect(st().notice).toMatch(/^Pulled the surface through all \d+ points \(it was up to [\d.]+ mm off them\)$/)
    expect(st().cage).not.toBe(before)
    st().undo()
    expect(st().cage.positions).toEqual(before.positions)
  })

  it('with Mirror X on, pulling one side pulls its mirror side the same way', () => {
    st().setSymmetry('x')
    const c = st().cage
    const plus = c.positions.map((p, i) => [p, i] as const).filter(([p]) => p[0] > 1).map(([, i]) => i)
    st().setSelection({ points: plus, edges: [], faces: [] })
    st().pullSelection()
    const P = st().cage.positions
    const pairs = c.positions.map((p) => c.positions.findIndex((q) => Math.abs(q[0] + p[0]) < 1e-9 && Math.abs(q[1] - p[1]) < 1e-9 && Math.abs(q[2] - p[2]) < 1e-9))
    for (const i of plus) {
      const j = pairs[i]
      expect(j).toBeGreaterThanOrEqual(0)
      expect(P[j][0]).toBeCloseTo(-P[i][0], 9)
      expect(P[j][1]).toBeCloseTo(P[i][1], 9)
      expect(P[j][2]).toBeCloseTo(P[i][2], 9)
    }
  })
})
