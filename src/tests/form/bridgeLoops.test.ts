// Form stage 20: Bridge two edge loops (openings, open borders) or two face sets.

import { describe, expect, it } from 'vitest'
import { edgeKey, type Cage } from '../../form/cage'
import { boxCage, planeCage } from '../../form/starters'
import { bridge, deleteFaces } from '../../form/topoTools'
import { bridgeFaceSets, bridgeOpenings, faceSets, openLoops } from '../../form/bridgeLoops'
import { validateCage } from '../../form/halfEdge'
import { tessellateForm } from '../../form/finish'
import { useFormStore } from '../../form/formStore'

const box4 = () => boxCage({ segments: { x: 4, y: 4, z: 4 } })
/** faces of `c` whose points all satisfy `on` */
const facesWhere = (c: Cage, on: (p: readonly number[]) => boolean) => c.faces.map((f, i) => [f, i] as const).filter(([f]) => f.every((p) => on(c.positions[p]))).map(([, i]) => i)
const inner = (z: number) => (p: readonly number[]) => p[2] === z && Math.abs(p[0]) <= 10 && Math.abs(p[1]) <= 10
const allEdges = (c: Cage) => [...new Set(c.faces.flatMap((f) => f.map((p, i) => edgeKey(p, f[(i + 1) % f.length]))))]
const euler = (c: Cage) => c.positions.length - allEdges(c).length + c.faces.length
const volume = (c: Cage) => {
  const t = tessellateForm(c, 0.3)
  const P = t.positions
  let v = 0
  for (let i = 0; i < t.indices.length; i += 3) {
    const [x, y, z] = [t.indices[i] * 3, t.indices[i + 1] * 3, t.indices[i + 2] * 3]
    v += (P[x] * (P[y + 1] * P[z + 2] - P[y + 2] * P[z + 1]) - P[x + 1] * (P[y] * P[z + 2] - P[y + 2] * P[z]) + P[x + 2] * (P[y] * P[z + 1] - P[y + 1] * P[z])) / 6
  }
  return v
}

describe('bridgeFaceSets', () => {
  it('two 2 x 2 face sets, top and bottom: a hole through the box, one ring of 8 quads; closed, outward, genus 1', () => {
    const c = box4()
    const top = facesWhere(c, inner(40)), bottom = facesWhere(c, inner(0))
    expect(top).toHaveLength(4)
    const r = bridgeFaceSets(c, top, bottom)!
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.faces).toHaveLength(8)
    expect(r.cage.faces).toHaveLength(96 - 8 + 8)
    // the centre point of each set, used only by its faces, is gone
    expect(r.cage.positions).toHaveLength(98 - 2)
    expect(euler(r.cage)).toBe(0)
    expect(volume(r.cage)).toBeGreaterThan(0)
    // no twist: every band quad's two sides run straight down (same x, y top and bottom)
    for (const f of r.faces) {
      const q = r.cage.faces[f].map((p) => r.cage.positions[p])
      const top = q.filter((p) => p[2] === 40), bottom = q.filter((p) => p[2] === 0)
      expect(top).toHaveLength(2)
      for (const t of top) expect(bottom.some((b) => b[0] === t[0] && b[1] === t[1])).toBe(true)
    }
  })

  it('segments put rings between, evenly', () => {
    const c = box4()
    const r = bridgeFaceSets(c, facesWhere(c, inner(40)), facesWhere(c, inner(0)), 3)!
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.faces).toHaveLength(24)
    const added = r.cage.positions.slice(96)
    expect(added).toHaveLength(16)
    expect([...new Set(added.map((p) => Math.round(p[2] * 1e6) / 1e6))].sort((a, b) => a - b)).toEqual([13.333333, 26.666667])
  })

  it('open forms (WO-2164 audit): a Plane starter\'s border face with an interior face, and two lone quads, bridge as the old two-face bridge did', () => {
    const sheet = planeCage({ size: { x: 40, y: 40, z: 0 }, segments: { x: 4, y: 4, z: 1 } })
    // lift the sheet's middle so the two faces are apart in Z too (a tube, not a flat fold)
    const lifted: Cage = { ...sheet, positions: sheet.positions.map((p) => [p[0], p[1], Math.abs(p[0]) < 11 && Math.abs(p[1]) < 11 ? 10 : 0]) }
    const border = lifted.faces.findIndex((f) => f.every((p) => lifted.positions[p][0] <= -10 && lifted.positions[p][1] <= -10))
    const interior = lifted.faces.findIndex((f) => f.every((p) => lifted.positions[p][0] >= 0 && lifted.positions[p][0] <= 10 && lifted.positions[p][1] >= 0 && lifted.positions[p][1] <= 10))
    const old = bridge(lifted, border, interior)!
    const r = bridgeFaceSets(lifted, [border], [interior])!
    expect(r).not.toBeNull()
    expect(validateCage(r.cage).problems).toEqual([])
    expect(r.faces).toHaveLength(4)
    expect(r.cage.faces).toHaveLength(old.faces.length)
    expect(r.cage.faces).toHaveLength(18)
    // two lone quads, two pieces
    const quad = (z: number): Cage => ({ positions: [[0, 0, z], [10, 0, z], [10, 10, z], [0, 10, z]], faces: [[0, 1, 2, 3]], creases: [] })
    const a = quad(0), b = quad(20)
    const two: Cage = { positions: [...a.positions, ...b.positions], faces: [[0, 1, 2, 3], [7, 6, 5, 4]], creases: [] }
    const oldTwo = bridge(two, 0, 1)!
    const t = bridgeFaceSets(two, [0], [1])!
    expect(t).not.toBeNull()
    expect(validateCage(t.cage).problems).toEqual([])
    expect(t.cage.faces).toHaveLength(oldTwo.faces.length)
    expect(t.cage.faces).toHaveLength(4)
    // and through the store, as the operator gets it
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: lifted })
    useFormStore.getState().setBridgeSegments(1)
    useFormStore.getState().setSelection({ points: [], edges: [], faces: [border, interior] })
    useFormStore.getState().bridgeSelection()
    expect(useFormStore.getState().notice).toBe('Bridged the two faces with 4 faces, 1 segment long')
    expect(useFormStore.getState().cage.faces).toHaveLength(18)
  })

  it('faceSets splits a selection into its connected sets', () => {
    const c = box4()
    expect(faceSets(c, [...facesWhere(c, inner(40)), ...facesWhere(c, inner(0))]).map((s) => s.length)).toEqual([4, 4])
  })
})

describe('bridgeOpenings', () => {
  it('the rims of two openings, as selected edges: the same hole through', () => {
    const c0 = box4()
    const holed = deleteFaces(c0, [...facesWhere(c0, inner(40)), ...facesWhere(c0, inner(0))])
    const loops = openLoops(holed, allEdges(holed))
    expect(loops.map((l) => [l.points.length, l.closed])).toEqual([[8, true], [8, true]])
    const r = bridgeOpenings(holed, loops[0], loops[1])!
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(euler(r.cage)).toBe(0)
    expect(volume(r.cage)).toBeGreaterThan(0)
  })

  it('openings of different lengths zip together with triangles, still closed and outward', () => {
    const c0 = box4()
    const one = c0.faces.findIndex((f) => f.every((p) => c0.positions[p][2] === 0 && c0.positions[p][0] >= 0 && c0.positions[p][0] <= 10 && c0.positions[p][1] >= 0 && c0.positions[p][1] <= 10))
    const holed = deleteFaces(c0, [...facesWhere(c0, inner(40)), one])
    const loops = openLoops(holed, allEdges(holed))
    expect(loops.map((l) => l.points.length).sort()).toEqual([4, 8])
    const r = bridgeOpenings(holed, loops[0], loops[1])!
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.faces.map((f) => r.cage.faces[f].length).filter((n) => n === 3)).toHaveLength(12)
    expect(volume(r.cage)).toBeGreaterThan(0)
  })

  it('two open borders (sheets side by side) join into one sheet', () => {
    const sheet = planeCage({ size: { x: 20, y: 20, z: 0 }, segments: { x: 1, y: 2, z: 1 } })
    const shift = (c: Cage, dx: number): Cage => ({ ...c, positions: c.positions.map((p) => [p[0] + dx, p[1], p[2]]) })
    const a = shift(sheet, -15), b = shift(sheet, 15)
    const both: Cage = { positions: [...a.positions, ...b.positions], faces: [...a.faces, ...b.faces.map((f) => f.map((p) => p + a.positions.length))], creases: [] }
    // the facing sides: x = -5 and x = 5
    const facing = allEdges(both).filter((k) => k.split(':').map(Number).every((p) => Math.abs(Math.abs(both.positions[p][0]) - 5) < 1e-9))
    const loops = openLoops(both, facing)
    expect(loops.map((l) => [l.points.length, l.closed])).toEqual([[3, false], [3, false]])
    const r = bridgeOpenings(both, loops[0], loops[1], 2)!
    expect(validateCage(r.cage).problems).toEqual([])
    expect(r.faces).toHaveLength(4)
    // one sheet now: its open edges are only the outline, 2 + 2 + 2 + 2 across the top and bottom, 2 + 2 at the ends
    const uses = new Map<string, number>()
    for (const f of r.cage.faces) for (let i = 0; i < f.length; i++) { const k = edgeKey(f[i], f[(i + 1) % f.length]); uses.set(k, (uses.get(k) ?? 0) + 1) }
    expect([...uses.values()].filter((n) => n === 1)).toHaveLength(12)
  })

  it('one closed opening and one open border cannot be joined', () => {
    const c0 = box4()
    const holed = deleteFaces(c0, facesWhere(c0, inner(40)))
    const loop = openLoops(holed, allEdges(holed))[0]
    expect(bridgeOpenings(holed, loop, { points: [0, 1, 2], closed: false })).toBeNull()
  })
})

describe('the store', () => {
  it('faces: bridges two face sets with the palette segments, selects the band, undo; notices', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: box4() })
    const st = useFormStore.getState()
    st.setBridgeSegments(2)
    st.setSelection({ points: [], edges: [], faces: [...facesWhere(st.cage, inner(40)), ...facesWhere(st.cage, inner(0))] })
    useFormStore.getState().bridgeSelection()
    const after = useFormStore.getState()
    expect(after.notice).toBe('Bridged the two face sets (4 and 4 faces) with 16 faces, 2 segments long')
    expect(after.selection.faces).toHaveLength(16)
    after.undo()
    expect(useFormStore.getState().cage.faces).toHaveLength(96)
    useFormStore.getState().setSelection({ points: [], edges: [], faces: facesWhere(useFormStore.getState().cage, inner(40)) })
    useFormStore.getState().bridgeSelection()
    expect(useFormStore.getState().notice).toBe('Bridge joins two separate face sets; the selected faces make 1')
    useFormStore.getState().setSelection({ points: [], edges: [], faces: [] })
    useFormStore.getState().bridgeSelection()
    expect(useFormStore.getState().notice).toMatch(/^Select two faces, two face sets, or the edges of two openings/)
    useFormStore.getState().setBridgeSegments(0)
    expect(useFormStore.getState().bridgeSegments).toBe(1)
  })

  it('edges: the rims of two openings bridge; unequal ones say how many triangles', () => {
    const c0 = box4()
    const one = c0.faces.findIndex((f) => f.every((p) => c0.positions[p][2] === 0 && c0.positions[p][0] >= 0 && c0.positions[p][0] <= 10 && c0.positions[p][1] >= 0 && c0.positions[p][1] <= 10))
    const holed = deleteFaces(c0, [...facesWhere(c0, inner(40)), one])
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: holed })
    useFormStore.getState().setBridgeSegments(1)
    useFormStore.getState().setSelection({ points: [], edges: allEdges(holed), faces: [] })
    useFormStore.getState().bridgeSelection()
    expect(useFormStore.getState().notice).toMatch(/^Bridged the two openings \((8 and 4|4 and 8) edges round\) with 12 faces, 1 segment long \(12 triangles where the two differ in length\)$/)
  })
})
