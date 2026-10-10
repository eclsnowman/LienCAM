// Form: Unweld - cut the cage open along selected edges, or round selected faces (stage 16).

import { describe, expect, it } from 'vitest'
import { edgeKey, type Cage } from '../../form/cage'
import { boxCage, planeCage } from '../../form/starters'
import { unweldEdges } from '../../form/topoTools'
import { setCreased } from '../../form/edgeLoop'
import { validateCage } from '../../form/halfEdge'
import { useFormStore } from '../../form/formStore'

const openEdges = (c: Cage) => {
  const count = new Map<string, number>()
  for (const loop of c.faces) for (let i = 0; i < loop.length; i++) { const k = edgeKey(loop[i], loop[(i + 1) % loop.length]); count.set(k, (count.get(k) ?? 0) + 1) }
  return [...count.values()].filter((n) => n === 1).length
}
/** faces joined through shared edges: how many separate pieces */
const pieces = (c: Cage) => {
  const parent = c.faces.map((_, i) => i)
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])))
  const byEdge = new Map<string, number>()
  c.faces.forEach((loop, f) => loop.forEach((p, i) => { const k = edgeKey(p, loop[(i + 1) % loop.length]); const g = byEdge.get(k); if (g === undefined) byEdge.set(k, f); else parent[find(f)] = find(g) }))
  return new Set(c.faces.map((_, f) => find(f))).size
}
/** the edges between points of `c` matching `on` */
const edgesWhere = (c: Cage, on: (p: [number, number, number]) => boolean) => {
  const out = new Set<string>()
  for (const loop of c.faces) for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]
    if (on(c.positions[a] as [number, number, number]) && on(c.positions[b] as [number, number, number])) out.add(edgeKey(a, b))
  }
  return [...out]
}

describe('unweldEdges', () => {
  it('a closed loop of edges round a box separates it into two open pieces, nothing moved', () => {
    const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const ring = edgesWhere(c, (p) => p[2] === 20)
    expect(ring).toHaveLength(8)
    const r = unweldEdges(c, ring)!
    expect(validateCage(r.cage).problems).toEqual([])
    expect(r.split).toBe(8)
    expect(r.opened).toHaveLength(16)
    expect(openEdges(r.cage)).toBe(16)
    expect(pieces(r.cage)).toBe(2)
    // every new point sits on one it was copied from
    for (const p of r.cage.positions.slice(c.positions.length)) expect(p[2]).toBe(20)
  })

  it('an open chain inside the form becomes a slit: its middle doubles, its ends stay joined', () => {
    const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    // the top face's middle line along X: (-20,0,40) - (0,0,40) - (20,0,40), ends on the box's top edges
    const chain = edgesWhere(c, (p) => p[2] === 40 && p[1] === 0)
    expect(chain).toHaveLength(2)
    const r = unweldEdges(c, chain)!
    expect(validateCage(r.cage).problems).toEqual([])
    expect(r.split).toBe(1)
    expect(openEdges(r.cage)).toBe(4)
    expect(pieces(r.cage)).toBe(1)
  })

  it('a lone edge inside the form has nothing to open; edges on an open border are ignored', () => {
    const c = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const one = edgesWhere(c, (p) => p[2] === 40 && p[1] === 0 && p[0] >= 0)
    expect(unweldEdges(c, one)).toBeNull()
    const sheet = planeCage({ size: { x: 20, y: 20, z: 0 }, segments: { x: 1, y: 1, z: 1 } })
    expect(unweldEdges(sheet, edgesWhere(sheet, () => true))).toBeNull()
  })

  it('a chain from open border to open border cuts a sheet in two', () => {
    const sheet = planeCage({ size: { x: 20, y: 20, z: 0 }, segments: { x: 2, y: 2, z: 1 } })
    const middle = edgesWhere(sheet, (p) => Math.abs(p[0]) < 1e-9)
    expect(middle).toHaveLength(2)
    const r = unweldEdges(sheet, middle)!
    expect(validateCage(r.cage).problems).toEqual([])
    expect(r.split).toBe(3)
    expect(pieces(r.cage)).toBe(2)
  })

  it('a creased or weighted cut edge stays creased or weighted on both sides', () => {
    const c0 = boxCage({ segments: { x: 2, y: 2, z: 2 } })
    const ring = edgesWhere(c0, (p) => p[2] === 20)
    const c = setCreased(setCreased(c0, [ring[0]], true), [ring[1]], true, 2)
    const r = unweldEdges(c, ring)!
    expect(validateCage(r.cage).problems).toEqual([])
    expect(r.cage.creases).toHaveLength(2)
    expect(Object.values(r.cage.weights ?? {})).toEqual([2, 2])
  })
})

describe('the store', () => {
  it('selected faces are cut free round their border; undo puts them back', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: boxCage({ segments: { x: 2, y: 2, z: 2 } }) })
    const st = useFormStore.getState()
    const top = st.cage.faces.map((f, i) => [f, i] as const).filter(([f]) => f.every((p) => st.cage.positions[p][2] === 40)).map(([, i]) => i)
    expect(top).toHaveLength(4)
    st.setSelection({ points: [], edges: [], faces: top })
    st.unweldSelection()
    const after = useFormStore.getState()
    expect(after.notice).toBe('Unwelded: the 4 selected faces cut free (8 points doubled)')
    expect(pieces(after.cage)).toBe(2)
    expect(after.selection.edges).toHaveLength(16)
    after.undo()
    expect(pieces(useFormStore.getState().cage)).toBe(1)
  })

  it('says what to select, and says when a selection has nothing to open', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: boxCage({ segments: { x: 2, y: 2, z: 2 } }) })
    const st = useFormStore.getState()
    st.setSelection({ points: [], edges: [], faces: [] })
    st.unweldSelection()
    expect(useFormStore.getState().notice).toBe('Select edges (a chain, or a loop) or faces to unweld')
    const one = edgesWhere(st.cage, (p) => p[2] === 40 && p[1] === 0 && p[0] >= 0)
    useFormStore.getState().setSelection({ points: [], edges: one, faces: [] })
    const before = useFormStore.getState().cage
    useFormStore.getState().unweldSelection()
    expect(useFormStore.getState().cage).toBe(before)
    expect(useFormStore.getState().notice).toMatch(/^Nothing to open there/)
  })
})
