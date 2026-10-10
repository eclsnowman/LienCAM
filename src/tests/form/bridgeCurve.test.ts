// Form: the Bridge band follows a curve that leaves each opening the way the surface there faces.

import { describe, expect, it } from 'vitest'
import { edgeKey, type Cage } from '../../form/cage'
import { boxCage, planeCage } from '../../form/starters'
import { bridgeFaceSets, bridgeOpenings, openLoops } from '../../form/bridgeLoops'
import { validateCage } from '../../form/halfEdge'

const box4 = () => boxCage({ segments: { x: 4, y: 4, z: 4 } })
const facesWhere = (c: Cage, on: (p: readonly number[]) => boolean) => c.faces.map((f, i) => [f, i] as const).filter(([f]) => f.every((p) => on(c.positions[p]))).map(([, i]) => i)
const onTop = (x0: number, x1: number) => (p: readonly number[]) => p[2] === 40 && p[0] >= x0 && p[0] <= x1 && Math.abs(p[1]) <= 10

describe('a curved bridge band', () => {
  it('two face sets side by side on a box top arch up into a handle: every new ring above the top, highest in the middle', () => {
    const c = box4()
    const r = bridgeFaceSets(c, facesWhere(c, onTop(-20, -10)), facesWhere(c, onTop(10, 20)), 6)!
    expect(validateCage(r.cage, true).problems).toEqual([])
    const newPts = r.cage.positions.filter((p) => p[2] > 40 + 1e-9)
    // 5 rings of 6 points (the 2 x 1 sets' outlines have 6 points) above the top
    expect(newPts.length).toBe(30)
    const top = Math.max(...newPts.map((p) => p[2]))
    // the arch rises about half the 30 mm gap (near a half circle)
    expect(top).toBeGreaterThan(52)
    expect(top).toBeLessThan(58)
    // highest at the middle of the gap (x = 0)
    const highest = newPts.filter((p) => Math.abs(p[2] - top) < 1e-9)
    for (const p of highest) expect(Math.abs(p[0])).toBeLessThan(5)
  })

  it('opposite faces (top to bottom) still run straight through: rings evenly spaced, square under each other', () => {
    const c = box4()
    const inner = (z: number) => (p: readonly number[]) => p[2] === z && Math.abs(p[0]) <= 10 && Math.abs(p[1]) <= 10
    const r = bridgeFaceSets(c, facesWhere(c, inner(40)), facesWhere(c, inner(0)), 4)!
    const added = r.cage.positions.slice(r.cage.positions.length - 24)
    expect([...new Set(added.map((p) => Math.round(p[2] * 1e6) / 1e6))].sort((a, b) => a - b)).toEqual([10, 20, 30])
    for (const p of added) expect(Math.max(Math.abs(p[0]), Math.abs(p[1]))).toBeCloseTo(10, 9)
  })

  it('two sheets edge to edge in one plane: the band runs flat across the gap (each border faces the other)', () => {
    const a = planeCage({ size: { x: 20, y: 20, z: 0 }, segments: { x: 2, y: 2, z: 1 } })
    const shift = (c: Cage, dx: number): Cage => ({ ...c, positions: c.positions.map((p) => [p[0] + dx, p[1], p[2]]) })
    const A = shift(a, -20), B = shift(a, 20)
    const n = A.positions.length
    const both: Cage = { positions: [...A.positions, ...B.positions], faces: [...A.faces, ...B.faces.map((f) => f.map((p) => p + n))], creases: [] }
    const edgesAt = (x: number) => both.faces.flatMap((f) => f.map((p, i) => [p, f[(i + 1) % f.length]] as const)).filter(([u, v]) => both.positions[u][0] === x && both.positions[v][0] === x).map(([u, v]) => edgeKey(u, v))
    const loops = openLoops(both, [...edgesAt(-10), ...edgesAt(10)])
    expect(loops).toHaveLength(2)
    const r = bridgeOpenings(both, loops[0], loops[1], 4)!
    expect(validateCage(r.cage).problems).toEqual([])
    const added = r.cage.positions.slice(both.positions.length)
    for (const p of added) expect(p[2]).toBeCloseTo(0, 9)
    expect([...new Set(added.map((p) => Math.round(p[0] * 1e6) / 1e6))].sort((x, y) => x - y)).toEqual([-5, 0, 5])
  })
})
