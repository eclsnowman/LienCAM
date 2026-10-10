// Form: Insert point, Subdivide, Weld.

import { describe, expect, it } from 'vitest'
import { edgeKey, parseEdgeKey, type Cage } from '../../form/cage'
import { boxCage, planeCage } from '../../form/starters'
import { splitEdges, subdivideFaces, weldPoints } from '../../form/topoTools'
import { setCreased } from '../../form/edgeLoop'
import { validateCage } from '../../form/halfEdge'
import { tessellateForm } from '../../form/finish'
import { useFormStore } from '../../form/formStore'

const box = () => boxCage({ segments: { x: 1, y: 1, z: 1 } })
const openEdges = (c: Cage) => {
  const count = new Map<string, number>()
  for (const loop of c.faces) for (let i = 0; i < loop.length; i++) { const k = edgeKey(loop[i], loop[(i + 1) % loop.length]); count.set(k, (count.get(k) ?? 0) + 1) }
  return [...count.values()].filter((n) => n === 1).length
}

describe('Insert point (split edges)', () => {
  it('puts a point in the middle of the edge, in both faces beside it; creased and weighted edges leave creased halves', () => {
    const c = box()
    const [a, b] = [c.faces[0][0], c.faces[0][1]]
    const key = edgeKey(a, b)
    const other = edgeKey(c.faces[0][1], c.faces[0][2])
    const marked = setCreased(setCreased(c, [key], true), [other], true, 1.5)
    const { cage, mid } = splitEdges(marked, [key, other])
    expect(validateCage(cage, true).problems).toEqual([])
    const m = mid.get(key)!
    expect(cage.positions[m]).toEqual([0, 1, 2].map((k) => (c.positions[a][k] + c.positions[b][k]) / 2))
    expect(cage.faces.filter((f) => f.includes(m))).toHaveLength(2)
    expect(cage.creases).toEqual(expect.arrayContaining([edgeKey(a, m), edgeKey(m, b)]))
    expect(cage.creases).not.toContain(key)
    const [p, q] = parseEdgeKey(other)
    const w = mid.get(other)!
    expect(cage.weights).toEqual({ [edgeKey(p, w)]: 1.5, [edgeKey(w, q)]: 1.5 })
  })
})

describe('Subdivide', () => {
  it('a face becomes one quad per corner round its centre; the faces beside it gain the edge middles, so the cage stays closed', () => {
    const c = box()
    const top = c.faces.findIndex((f) => f.every((p) => c.positions[p][2] === 40))
    const { cage, faces } = subdivideFaces(c, [top])
    expect(validateCage(cage, true).problems).toEqual([])
    expect(faces).toHaveLength(4)
    expect(faces.every((f) => cage.faces[f].length === 4)).toBe(true)
    expect(cage.faces).toHaveLength(6 - 1 + 4)
    expect(cage.positions).toHaveLength(8 + 4 + 1)
    // the four side faces each gained a side
    expect(cage.faces.filter((f) => f.length === 5)).toHaveLength(4)
    // the skin still closes and keeps the box's sense (outward)
    const t = tessellateForm(cage, 0.1)
    let v = 0
    for (let i = 0; i < t.indices.length; i += 3) {
      const P = t.positions, [x, y, z] = [t.indices[i] * 3, t.indices[i + 1] * 3, t.indices[i + 2] * 3]
      v += (P[x] * (P[y + 1] * P[z + 2] - P[y + 2] * P[z + 1]) - P[x + 1] * (P[y] * P[z + 2] - P[y + 2] * P[z]) + P[x + 2] * (P[y] * P[z + 1] - P[y + 1] * P[z])) / 6
    }
    expect(v).toBeGreaterThan(0)
  })
})

describe('Weld', () => {
  it('welding the two ends of an edge collapses it: its two faces become triangles, the cage stays closed', () => {
    const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const [a, b] = [c.faces[0][0], c.faces[0][1]]
    const r = weldPoints(c, [a, b])!
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.cage.positions).toHaveLength(c.positions.length - 1)
    expect(r.cage.faces.filter((f) => f.length === 3)).toHaveLength(2)
    expect(r.cage.positions[r.point]).toEqual([0, 1, 2].map((k) => (c.positions[a][k] + c.positions[b][k]) / 2))
  })

  it('welding two open sheets point to point along their facing sides stitches them into one sheet', () => {
    const left = planeCage({ size: { x: 20, y: 20, z: 0 }, segments: { x: 1, y: 1, z: 1 } })
    const shift = (c: Cage, dx: number): Cage => ({ ...c, positions: c.positions.map((p) => [p[0] + dx, p[1], p[2]]) })
    const a = shift(left, -10.5), b = shift(left, 10.5)
    const both: Cage = { positions: [...a.positions, ...b.positions], faces: [...a.faces, ...b.faces.map((f) => f.map((p) => p + a.positions.length))], creases: [] }
    expect(openEdges(both)).toBe(8)
    // the right side of the left sheet (x = -0.5) faces the left side of the right sheet (x = 0.5)
    let c: Cage = both
    for (const y of [-10, 10]) {
      const pair = [c.positions.findIndex((p) => Math.abs(p[0] + 0.5) < 1e-9 && Math.abs(p[1] - y) < 1e-9), c.positions.findIndex((p) => Math.abs(p[0] - 0.5) < 1e-9 && Math.abs(p[1] - y) < 1e-9)]
      c = weldPoints(c, pair)!.cage
    }
    expect(validateCage(c).problems).toEqual([])
    expect(c.positions).toHaveLength(6)
    expect(openEdges(c)).toBe(6)
  })

  it('needs two points', () => {
    expect(weldPoints(box(), [0])).toBeNull()
  })
})

describe('the store', () => {
  it('Insert point, Subdivide and Weld act on the selection and select what they made', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: box() })
    const st = useFormStore.getState()
    const key = edgeKey(st.cage.faces[0][0], st.cage.faces[0][1])
    st.select({ kind: 'edge', key }, false)
    st.insertPointOnSelection()
    const afterInsert = useFormStore.getState()
    expect(afterInsert.cage.positions).toHaveLength(9)
    expect(afterInsert.selection.points).toEqual([8])
    afterInsert.select({ kind: 'face', index: 1 }, false)
    afterInsert.subdivideSelection()
    const afterSub = useFormStore.getState()
    expect(afterSub.selection.faces.length).toBeGreaterThanOrEqual(4)
    const e = edgeKey(afterSub.cage.faces[0][0], afterSub.cage.faces[0][1])
    afterSub.select({ kind: 'edge', key: e }, false)
    const before = afterSub.cage.positions.length
    afterSub.weldSelection()
    expect(useFormStore.getState().cage.positions).toHaveLength(before - 1)
    expect(useFormStore.getState().notice).toMatch(/Welded 2 points/)
  })
})
