// Form: Flatten and Straighten (stage 17).

import { describe, expect, it } from 'vitest'
import { edgeKey, type Cage, type Vec3 } from '../../form/cage'
import { boxCage, planeCage } from '../../form/starters'
import { edgeChains, flattenPoints, lineDeviation, planeDeviation, principalAxes, straightenChains } from '../../form/shapeTools'
import { tessellateForm } from '../../form/finish'
import { useFormStore } from '../../form/formStore'

const box4 = () => boxCage({ segments: { x: 4, y: 4, z: 4 } })
const at = (c: Cage, x: number, y: number, z: number) => c.positions.findIndex((p) => Math.abs(p[0] - x) < 1e-9 && Math.abs(p[1] - y) < 1e-9 && Math.abs(p[2] - z) < 1e-9)
const moved = (c: Cage, moves: Array<[number, Vec3]>): Cage => {
  const positions = c.positions.map((p) => [p[0], p[1], p[2]] as Vec3)
  for (const [i, d] of moves) positions[i] = [positions[i][0] + d[0], positions[i][1] + d[1], positions[i][2] + d[2]]
  return { ...c, positions }
}
const skinPoints = (c: Cage): Vec3[] => {
  const P = tessellateForm(c, 0.01).positions
  const out: Vec3[] = []
  for (let i = 0; i < P.length; i += 3) out.push([P[i], P[i + 1], P[i + 2]])
  return out
}

/** a 4 x 4 x 4 box whose top's inner nine points are raised into a dome (centre 8 mm, the rest 4 mm) */
function domed(): { cage: Cage; top: number[] } {
  const c = box4()
  const moves: Array<[number, Vec3]> = []
  for (const x of [-10, 0, 10]) for (const y of [-10, 0, 10]) moves.push([at(c, x, y, 40), [0, 0, x === 0 && y === 0 ? 8 : 4]])
  const cage = moved(c, moves)
  return { cage, top: cage.positions.map((p, i) => [p, i] as const).filter(([p]) => p[2] >= 40).map(([, i]) => i) }
}

describe('Flatten', () => {
  it('puts a domed top on one plane, and the smooth skin over its inner region comes out flat', () => {
    const { cage, top } = domed()
    expect(top).toHaveLength(25)
    const inner = (c: Cage) => skinPoints(c).filter((p) => Math.abs(p[0]) <= 10 && Math.abs(p[1]) <= 10 && p[2] > 30)
    const beforeSkin = inner(cage)
    const r = flattenPoints(cage, top)!
    expect(r.before).toBeGreaterThan(3)
    expect(Math.abs(r.normal[2])).toBeCloseTo(1, 9)
    const pts = top.map((p) => r.cage.positions[p])
    expect(planeDeviation(pts, r.centre, r.normal)).toBeLessThan(1e-9)
    // the plane is the least-squares one: the mean height of the 25 points
    expect(r.centre[2]).toBeCloseTo(40 + (8 + 8 * 4) / 25, 9)
    expect(planeDeviation(beforeSkin, r.centre, r.normal)).toBeGreaterThan(1)
    expect(planeDeviation(inner(r.cage), r.centre, r.normal)).toBeLessThan(1e-6)
  })

  it('finds a tilted plane: noisy points near it land on it, the normal within half a degree', () => {
    const s = planeCage({ size: { x: 30, y: 30, z: 0 }, segments: { x: 3, y: 3, z: 1 } })
    const a = 0.5 // rotate about X by ~28.6 deg, then lift 5 mm
    const tilt = (p: Vec3): Vec3 => [p[0], p[1] * Math.cos(a) - p[2] * Math.sin(a), p[1] * Math.sin(a) + p[2] * Math.cos(a) + 5]
    const noise = [0.3, -0.2, 0.25, -0.35, 0.1, 0, -0.1, 0.2, -0.3, 0.15, 0.05, -0.25, 0.3, -0.05, 0.1, -0.2]
    const n0: Vec3 = [0, -Math.sin(a), Math.cos(a)]
    const c: Cage = { ...s, positions: s.positions.map((p, i) => { const q = tilt(p as Vec3); return [q[0] + n0[0] * noise[i], q[1] + n0[1] * noise[i], q[2] + n0[2] * noise[i]] as Vec3 }) }
    const r = flattenPoints(c, c.positions.map((_, i) => i))!
    expect(planeDeviation(r.cage.positions, r.centre, r.normal)).toBeLessThan(1e-9)
    expect(Math.acos(Math.min(1, Math.abs(r.normal[0] * n0[0] + r.normal[1] * n0[1] + r.normal[2] * n0[2]))) * 180 / Math.PI).toBeLessThan(0.5)
  })

  it('needs three points', () => {
    expect(flattenPoints(box4(), [0, 1])).toBeNull()
  })
})

describe('Straighten', () => {
  /** the front face's middle column x = 0, y = -20, z 0..40: its edges, bent out unevenly */
  function bentColumn() {
    const c0 = box4()
    const ids = [0, 10, 20, 30, 40].map((z) => at(c0, 0, -20, z))
    const cage = moved(c0, [[ids[1], [0, -6, 3]], [ids[2], [0, -8, 0]], [ids[3], [0, -3, 0]]])
    const edges = ids.slice(1).map((p, i) => edgeKey(ids[i], p))
    return { cage, ids, edges }
  }

  it('an edge chain goes onto the line between its ends, each point at its share of the chain length', () => {
    const { cage, ids, edges } = bentColumn()
    const P = ids.map((p) => cage.positions[p])
    const cum = [0]
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1], P[i][2] - P[i - 1][2]))
    const r = straightenChains(cage, edges)!
    expect(r.lines).toBe(1)
    expect(r.moved).toBe(3)
    expect(r.before).toBeGreaterThan(7)
    ids.forEach((p, i) => {
      expect(r.cage.positions[p][0]).toBeCloseTo(0, 9)
      expect(r.cage.positions[p][1]).toBeCloseTo(-20, 9)
      expect(r.cage.positions[p][2]).toBeCloseTo((40 * cum[i]) / cum[cum.length - 1], 9)
    })
  })

  it('with the column straight again the skin down the middle of that face is flat', () => {
    const { cage, edges } = bentColumn()
    const mid = (c: Cage) => skinPoints(c).filter((p) => Math.abs(p[0]) < 1 && p[2] > 12 && p[2] < 28 && p[1] < -15)
    const before = Math.max(...mid(cage).map((p) => Math.abs(p[1] + 20)))
    const after = Math.max(...mid(straightenChains(cage, edges)!.cage).map((p) => Math.abs(p[1] + 20)))
    expect(before).toBeGreaterThan(1)
    expect(after).toBeLessThan(1e-6)
  })

  it('selected points with no edges go onto their best-fit line, keeping their order', () => {
    const s = planeCage({ size: { x: 30, y: 30, z: 0 }, segments: { x: 3, y: 3, z: 1 } })
    const row = [at(s, -15, -5, 0), at(s, -5, -5, 0), at(s, 5, -5, 0), at(s, 15, -5, 0)]
    const c = moved(s, [[row[1], [0, 2, 1]], [row[2], [0, -1, -2]]])
    const r = straightenChains(c, [], row)!
    const P = row.map((p) => r.cage.positions[p])
    const { centre, axes } = principalAxes(P)
    expect(lineDeviation(P, centre, axes[2])).toBeLessThan(1e-9)
    expect(P.map((p) => p[0])).toEqual([...P.map((p) => p[0])].sort((a, b) => a - b))
  })

  it('a closed loop is counted, not moved; loops alone give null', () => {
    const c = box4()
    const loop: string[] = []
    for (const f of c.faces) for (let i = 0; i < f.length; i++) { const a = f[i], b = f[(i + 1) % f.length]; if (c.positions[a][2] === 20 && c.positions[b][2] === 20) loop.push(edgeKey(a, b)) }
    const chains = edgeChains(loop)
    expect(chains).toHaveLength(1)
    expect(chains[0].kind).toBe('loop')
    expect(straightenChains(c, loop)).toBeNull()
    // plus a chain across the top (it shares no point with the loop)
    const top = [-20, -10, 0, 10, 20].map((x) => at(c, x, 0, 40))
    const both = straightenChains(c, [...loop, ...top.slice(1).map((p, i) => edgeKey(top[i], p))])!
    expect(both.loops).toBe(1)
    expect(both.lines).toBe(1)
  })
})

describe('the store', () => {
  it('Flatten says how far off the points were, keeps mirror symmetry, and undoes in one step', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: box4() })
    const st = useFormStore.getState()
    st.setSymmetry('x')
    // raise (10, 0, 40); its mirror (-10, 0, 40) follows
    st.setSelection({ points: [at(st.cage, 10, 0, 40)], edges: [], faces: [] })
    st.beginMove({ extrude: false })
    st.moveBy([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 6, 1])
    st.endDrag()
    const c = useFormStore.getState().cage
    expect(c.positions[at(box4(), -10, 0, 40)][2]).toBeCloseTo(46, 9)
    // flatten the +X half of the top row y = 0 plus a tilted neighbour: only +X points picked
    const pick = [at(box4(), 10, 0, 40), at(box4(), 20, 0, 40), at(box4(), 10, 10, 40), at(box4(), 10, -10, 40)]
    useFormStore.getState().setSelection({ points: pick, edges: [], faces: [] })
    useFormStore.getState().flattenSelection()
    const after = useFormStore.getState()
    expect(after.notice).toMatch(/^Flattened 4 points onto their plane \(the farthest was \d+\.\d\d mm off it\)$/)
    for (const p of pick) {
      const q = after.cage.positions[p]
      const m = after.cage.positions[at(box4(), -box4().positions[p][0], box4().positions[p][1], 40)]
      expect(m[0]).toBeCloseTo(-q[0], 9)
      expect(m[1]).toBeCloseTo(q[1], 9)
      expect(m[2]).toBeCloseTo(q[2], 9)
    }
    after.undo()
    expect(useFormStore.getState().cage.positions[at(box4(), 10, 0, 40)][2]).toBeCloseTo(46, 9)
  })

  it('Straighten notices: done, loops only, nothing selected', () => {
    useFormStore.getState().openSession({ featureId: null, name: 'T', cage: box4() })
    const c = useFormStore.getState().cage
    const loop: string[] = []
    for (const f of c.faces) for (let i = 0; i < f.length; i++) { const a = f[i], b = f[(i + 1) % f.length]; if (c.positions[a][2] === 20 && c.positions[b][2] === 20) loop.push(edgeKey(a, b)) }
    useFormStore.getState().setSelection({ points: [], edges: loop, faces: [] })
    useFormStore.getState().straightenSelection()
    expect(useFormStore.getState().notice).toBe('A closed loop has no two ends to run a line between; Flatten makes it planar')
    useFormStore.getState().setSelection({ points: [], edges: [], faces: [] })
    useFormStore.getState().straightenSelection()
    expect(useFormStore.getState().notice).toBe('Select a chain of edges (or three or more points) to straighten')
    const ids = [0, 10, 20].map((z) => at(c, 0, -20, z))
    useFormStore.getState().setSelection({ points: [], edges: [edgeKey(ids[0], ids[1])], faces: [] })
    const history = useFormStore.getState().history
    useFormStore.getState().straightenSelection()
    expect(useFormStore.getState().notice).toBe('One edge is already straight - select two or more edges in a row (or three or more points).')
    expect(useFormStore.getState().cage).toBe(c)
    expect(useFormStore.getState().history).toBe(history)
    useFormStore.getState().setSelection({ points: [], edges: [edgeKey(ids[0], ids[1]), edgeKey(ids[1], ids[2])], faces: [] })
    useFormStore.getState().straightenSelection()
    expect(useFormStore.getState().notice).toBe('Straightened 1 line, 1 point moved (the farthest was 0.00 mm off)')
  })
})
