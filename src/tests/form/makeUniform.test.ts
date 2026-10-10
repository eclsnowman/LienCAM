// Form stage 22: Make uniform - even out point spacing over the surface.

import { describe, expect, it } from 'vitest'
import { edgeKey, type Cage, type Vec3 } from '../../form/cage'
import { boxCage, planeCage, sphereCage } from '../../form/starters'
import { edgeLengthSpread, makeUniform } from '../../form/shapeTools'
import { setCreased } from '../../form/edgeLoop'
import { tessellateForm } from '../../form/finish'
import { useFormStore } from '../../form/formStore'

/** a fixed, repeatable jitter in [-1, 1] */
const jitter = (i: number, k: number) => Math.sin(i * 12.9898 + k * 78.233) * 0.5 + Math.sin(i * 4.1 + k * 1.7) * 0.5
const at = (c: Cage, x: number, y: number, z: number) => c.positions.findIndex((p) => Math.abs(p[0] - x) < 1e-9 && Math.abs(p[1] - y) < 1e-9 && Math.abs(p[2] - z) < 1e-9)

/** a 6 x 6 sheet (spacing 10) with its inner points pushed about in its plane by up to 4 mm */
function jumbledSheet(): { cage: Cage; inner: number[] } {
  const s = planeCage({ size: { x: 60, y: 60, z: 0 }, segments: { x: 6, y: 6, z: 1 } })
  const inner = s.positions.map((p, i) => [p, i] as const).filter(([p]) => Math.abs(p[0]) < 29 && Math.abs(p[1]) < 29).map(([, i]) => i)
  const positions = s.positions.map((p, i) => (inner.includes(i) ? [p[0] + 4 * jitter(i, 0), p[1] + 4 * jitter(i, 1), 0] : [...p]) as Vec3)
  return { cage: { ...s, positions }, inner }
}

describe('makeUniform', () => {
  it('a jumbled sheet evens out, stays in its plane, and its border stays put', () => {
    const { cage, inner } = jumbledSheet()
    const r = makeUniform(cage, cage.positions.map((_, i) => i))!
    expect(r.moved).toBe(25)
    expect(r.before).toBeGreaterThan(0.2)
    expect(r.after).toBeLessThan(0.05)
    for (const p of inner) expect(r.cage.positions[p][2]).toBeCloseTo(0, 12)
    cage.positions.forEach((p, i) => { if (!inner.includes(i)) expect(r.cage.positions[i]).toEqual(p) })
    // close to the even grid again
    for (const p of inner) {
      const q = r.cage.positions[p]
      expect(Math.abs(q[0] / 10 - Math.round(q[0] / 10))).toBeLessThan(0.05)
    }
  })

  it('on a curved form the shape keeps: a jumbled sphere cage evens out and its skin volume moves under 1.5%', () => {
    const s = sphereCage({ segments: { x: 4, y: 4, z: 4 } })
    // push each point along its surface (perpendicular to its radius) by up to 3 mm
    const positions = s.positions.map((p, i) => {
      const r = Math.hypot(p[0], p[1], p[2] - 20) || 1
      const n: Vec3 = [p[0] / r, p[1] / r, (p[2] - 20) / r]
      const j: Vec3 = [jitter(i, 0), jitter(i, 1), jitter(i, 2)]
      const d = j[0] * n[0] + j[1] * n[1] + j[2] * n[2]
      return [p[0] + 3 * (j[0] - n[0] * d), p[1] + 3 * (j[1] - n[1] * d), p[2] + 3 * (j[2] - n[2] * d)] as Vec3
    })
    const cage = { ...s, positions }
    const vol = (c: Cage) => {
      const t = tessellateForm(c, 0.3)
      const P = t.positions
      let v = 0
      for (let i = 0; i < t.indices.length; i += 3) {
        const [x, y, z] = [t.indices[i] * 3, t.indices[i + 1] * 3, t.indices[i + 2] * 3]
        v += (P[x] * (P[y + 1] * P[z + 2] - P[y + 2] * P[z + 1]) - P[x + 1] * (P[y] * P[z + 2] - P[y + 2] * P[z]) + P[x + 2] * (P[y] * P[z + 1] - P[y + 1] * P[z])) / 6
      }
      return v
    }
    const r = makeUniform(cage, cage.positions.map((_, i) => i))!
    expect(r.after).toBeLessThan(r.before * 0.6)
    expect(Math.abs(vol(r.cage) / vol(cage) - 1)).toBeLessThan(0.015)
  })

  it('points on a crease stay; so do points not given', () => {
    const { cage } = jumbledSheet()
    // the inner points that started at (-10, -10) and (0, -10) (found on the unjumbled sheet; same numbering)
    const s0 = planeCage({ size: { x: 60, y: 60, z: 0 }, segments: { x: 6, y: 6, z: 1 } })
    const i = at(s0, -10, -10, 0), j = at(s0, 0, -10, 0)
    const creased = setCreased(cage, [edgeKey(i, j)], true)
    const r = makeUniform(creased, creased.positions.map((_, k) => k))!
    expect(r.cage.positions[i]).toEqual(cage.positions[i])
    expect(r.cage.positions[j]).toEqual(cage.positions[j])
    const only = makeUniform(cage, [at(s0, 10, 10, 0)])!
    expect(only.moved).toBe(1)
    only.cage.positions.forEach((p, k) => { if (k !== at(s0, 10, 10, 0)) expect(p).toEqual(cage.positions[k]) })
  })

  it('nothing to move: null', () => {
    const s = planeCage({ size: { x: 20, y: 20, z: 0 }, segments: { x: 1, y: 1, z: 1 } })
    expect(makeUniform(s, [0, 1, 2, 3])).toBeNull()
  })
})

describe('the store', () => {
  it('with nothing selected the whole form evens out; the notice gives the spread; one undo; Mirror X kept', () => {
    const { cage } = jumbledSheet()
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage })
    useFormStore.getState().setSelection({ points: [], edges: [], faces: [] })
    useFormStore.getState().makeUniformSelection()
    const after = useFormStore.getState()
    // WO-2497: the notice also says how far the farthest point moved
    expect(after.notice).toMatch(/^Made 25 of the form's points uniform: edge length spread 0\.\d\d -> 0\.0\d, the farthest moved \d+\.\d\d mm \(points on the open border or on creases stay\)$/)
    expect(edgeLengthSpread(after.cage, after.cage.positions.map((_, i) => i))).toBeLessThan(edgeLengthSpread(cage, cage.positions.map((_, i) => i)))
    after.undo()
    expect(useFormStore.getState().cage.positions).toEqual(cage.positions)
    // Mirror X: a box's top, one side's inner point pushed; Uniform on the +X half keeps the mirror
    useFormStore.getState().openSession({ featureId: null, name: 'B', cage: boxCage({ segments: { x: 4, y: 4, z: 4 } }) })
    useFormStore.getState().setSymmetry('x')
    const c = useFormStore.getState().cage
    const p = at(c, 10, 10, 40)
    useFormStore.getState().setSelection({ points: [p], edges: [], faces: [] })
    useFormStore.getState().beginMove({ extrude: false })
    useFormStore.getState().moveBy([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 4, -3, 0, 1])
    useFormStore.getState().endDrag()
    useFormStore.getState().setSelection({ points: [p, at(c, 10, 0, 40), at(c, 10, -10, 40)], edges: [], faces: [] })
    useFormStore.getState().makeUniformSelection()
    const m = useFormStore.getState().cage
    // an unselected neighbour of the pushed point stays where it was (only the selection evens out)
    expect(m.positions[at(c, 0, 10, 40)]).toEqual([0, 10, 40])
    const q = m.positions[p], mirror = m.positions[at(c, -10, 10, 40)]
    expect(q[0]).toBeCloseTo(10, 0)
    expect(mirror[0]).toBeCloseTo(-q[0], 9)
    expect(mirror[1]).toBeCloseTo(q[1], 9)
  })

  it('WO-2497: an already even form (the starter sphere) moves nothing: says so, no undo step', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'S', cage: sphereCage() })
    useFormStore.getState().setSelection({ points: [], edges: [], faces: [] })
    const cage = useFormStore.getState().cage
    useFormStore.getState().makeUniformSelection()
    expect(useFormStore.getState().notice).toBe('Uniform: already even - nothing moved')
    expect(useFormStore.getState().cage).toBe(cage)
    expect(useFormStore.getState().history.past).toHaveLength(0)
  })

  it('all points fixed: says so', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: planeCage({ size: { x: 20, y: 20, z: 0 }, segments: { x: 1, y: 1, z: 1 } }) })
    useFormStore.getState().setSelection({ points: [], edges: [], faces: [] })
    useFormStore.getState().makeUniformSelection()
    expect(useFormStore.getState().notice).toBe('Nothing to even out: the form\'s points are all on the open border or on creases, which stay put')
  })
})
