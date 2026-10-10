// Form: small gap-list items - a bridge's twist, and Pipe's radius setting.

import { describe, expect, it } from 'vitest'
import { edgeKey, type Cage, type Vec3 } from '../../form/cage'
import { boxCage } from '../../form/starters'
import { deleteFaces } from '../../form/topoTools'
import { bridgeFaceSets, bridgeOpenings, openLoops } from '../../form/bridgeLoops'
import { validateCage } from '../../form/halfEdge'
import { useFormStore } from '../../form/formStore'
import { defaultPipeRadius, straightPath, tightestBend, type SketchPath } from '../../form/pipe'

const box4 = () => boxCage({ segments: { x: 4, y: 4, z: 4 } })
const facesWhere = (c: Cage, on: (p: readonly number[]) => boolean) => c.faces.map((f, i) => [f, i] as const).filter(([f]) => f.every((p) => on(c.positions[p]))).map(([, i]) => i)
const inner = (z: number) => (p: readonly number[]) => p[2] === z && Math.abs(p[0]) <= 10 && Math.abs(p[1]) <= 10
const allEdges = (c: Cage) => [...new Set(c.faces.flatMap((f) => f.map((p, i) => edgeKey(p, f[(i + 1) % f.length]))))]
/** the band's edges that run from the top opening (z = 40) straight to the bottom one (z = 0) */
const rungs = (c: Cage, faces: number[]) => {
  const out: Array<[number[], number[]]> = []
  for (const f of faces) for (let i = 0; i < c.faces[f].length; i++) {
    const a = c.positions[c.faces[f][i]], b = c.positions[c.faces[f][(i + 1) % c.faces[f].length]]
    if (a[2] === 40 && b[2] === 0) out.push([a, b])
  }
  return out
}

describe('Bridge twist', () => {
  const holed = () => { const c = box4(); return deleteFaces(c, [...facesWhere(c, inner(40)), ...facesWhere(c, inner(0))]) }

  it('0 lines the openings up: every rung straight down (x and y the same at both ends)', () => {
    const c = holed()
    const [a, b] = openLoops(c, allEdges(c))
    const r = bridgeOpenings(c, a, b, 1, 0)!
    for (const [top, bottom] of rungs(r.cage, r.faces)) expect([top[0], top[1]]).toEqual([bottom[0], bottom[1]])
  })

  it('a twist of 2 turns the far opening two points round: no rung straight down, still closed and valid; a full turn (8) is back to lined up', () => {
    const c = holed()
    const [a, b] = openLoops(c, allEdges(c))
    const r = bridgeOpenings(c, a, b, 1, 2)!
    expect(validateCage(r.cage, true).problems).toEqual([])
    const rs = rungs(r.cage, r.faces)
    expect(rs.length).toBeGreaterThan(0)
    for (const [top, bottom] of rs) expect(top[0] === bottom[0] && top[1] === bottom[1]).toBe(false)
    expect(bridgeOpenings(c, a, b, 1, 8)).toEqual(bridgeOpenings(c, a, b, 1, 0))
    // and it turns the other way for -2
    expect(bridgeOpenings(c, a, b, 1, -2)).not.toEqual(r)
  })

  it('face sets take the twist too; open borders have ends to meet and ignore it', () => {
    const c = box4()
    const lined = bridgeFaceSets(c, facesWhere(c, inner(40)), facesWhere(c, inner(0)), 1, 0)!
    const turned = bridgeFaceSets(c, facesWhere(c, inner(40)), facesWhere(c, inner(0)), 1, 3)!
    expect(turned.cage.positions).toEqual(lined.cage.positions)
    expect(turned.cage.faces).not.toEqual(lined.cage.faces)
    expect(validateCage(turned.cage, true).problems).toEqual([])
  })

  it('the store keeps the twist whole, within -64..64', () => {
    const st = useFormStore.getState()
    st.setBridgeTwist(2.6); expect(useFormStore.getState().bridgeTwist).toBe(3)
    st.setBridgeTwist(500); expect(useFormStore.getState().bridgeTwist).toBe(64)
    st.setBridgeTwist(0)
  })
})

describe('Pipe radius', () => {
  it('a straight path has no bend to fold in; a quarter circle of radius 20 bends at 20 and starts well inside it', () => {
    expect(tightestBend(straightPath(60))).toBe(Infinity)
    const arc: SketchPath = { points: Array.from({ length: 17 }, (_, i) => { const a = (Math.PI / 2) * (i / 16); return [20 * Math.cos(a), 20 * Math.sin(a), 0] as Vec3 }), closed: false }
    expect(tightestBend(arc)).toBeCloseTo(20, 6)
    expect(defaultPipeRadius(arc)).toBeLessThanOrEqual(0.6 * 20)
  })

  it('the store keeps a positive radius; 0 or less means automatic', () => {
    const st = useFormStore.getState()
    st.setPipeRadius(4.5); expect(useFormStore.getState().pipeRadius).toBe(4.5)
    st.setPipeRadius(-3); expect(useFormStore.getState().pipeRadius).toBe(0)
    st.setPipeRadius(Number.NaN); expect(useFormStore.getState().pipeRadius).toBe(0)
  })
})
