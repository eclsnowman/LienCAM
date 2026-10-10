// Form stage 25: knot removal (knots.ts) - the same curves with only the knots their shape needs.

import { describe, expect, it } from 'vitest'
import type { Vec3 } from '../../form/cage'
import { c1Knots, evalRow, knotRuns, removeKnots } from '../../form/knots'

/** a cubic Bezier's point at t */
const bez = (P: Vec3[], t: number): Vec3 => {
  const s = 1 - t, w = [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t]
  return [0, 1, 2].map((k) => P.reduce((a, p, i) => a + p[k] * w[i], 0)) as Vec3
}
/** one cubic Bezier split into `spans` equal Bezier spans, as a C1 chain (join poles shared) */
function splitCubic(P: Vec3[], spans: number): Vec3[] {
  const out: Vec3[] = []
  for (let k = 0; k < spans; k++) {
    const a = k / spans, b = (k + 1) / spans
    // the span's Bezier poles by blossoming: f(a,a,a), f(a,a,b), f(a,b,b), f(b,b,b)
    const bl = (x: number, y: number, z: number): Vec3 => {
      let q = P.map((p) => p.slice() as Vec3)
      for (const t of [x, y, z]) q = q.slice(1).map((p, i) => [0, 1, 2].map((c) => q[i][c] * (1 - t) + p[c] * t) as Vec3)
      return q[0]
    }
    if (k === 0) out.push(bl(a, a, a))
    out.push(bl(a, a, b), bl(a, b, b), bl(b, b, b))
  }
  return out
}
/** the C1 form's poles of a Bezier chain: all but the joins */
const keep = (chain: Vec3[]) => chain.filter((_, i) => i === 0 || i === chain.length - 1 || i % 3 !== 0)
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

describe('knot removal', () => {
  it('one cubic split into 8 spans comes back as ONE span (4 poles), the same curve to 1e-12', () => {
    const P: Vec3[] = [[0, 0, 0], [10, 20, 5], [30, -10, 8], [40, 5, 0]]
    const chain = splitCubic(P, 8)
    const r = removeKnots({ knots: c1Knots(8), rows: [keep(chain)] }, 1e-9)
    expect(r.rows[0]).toHaveLength(4)
    expect(knotRuns(r.knots)).toEqual({ values: [0, 8], mults: [4, 4] })
    for (let t = 0; t <= 1.0001; t += 0.05) expect(dist(evalRow(r.knots, r.rows[0], t * 8), bez(P, t))).toBeLessThan(1e-12)
    expect(r.moved).toBeLessThan(1e-12)
  })

  it('two different cubics joined C1 keep the join knot (doubled): nothing to remove there', () => {
    const A: Vec3[] = [[0, 0, 0], [10, 10, 0], [20, 10, 0], [30, 0, 0]]
    // the second starts where A ends, tangent continuous (C1), bending the other way
    const B: Vec3[] = [[30, 0, 0], [40, -10, 0], [50, 20, 0], [60, 0, 0]]
    const chain = [...A, ...B.slice(1)]
    const r = removeKnots({ knots: c1Knots(2), rows: [keep(chain)] }, 1e-9)
    expect(r.removed).toBe(0)
    expect(r.rows[0]).toHaveLength(6)
  })

  it('a row fails -> no row loses the knot: every row of the net keeps the same knots', () => {
    const P: Vec3[] = [[0, 0, 0], [10, 20, 5], [30, -10, 8], [40, 5, 0]]
    const smooth = keep(splitCubic(P, 2))
    const kinked = keep([...P, [50, -30, 0], [60, 40, 0], [70, 0, 0]] as Vec3[])
    const r = removeKnots({ knots: c1Knots(2), rows: [smooth, kinked] }, 1e-9)
    expect(r.removed).toBe(0)
    expect(r.rows.map((x) => x.length)).toEqual([6, 6])
  })

  it('a C2 cubic B-spline refined to Bezier spans loses its refinement knots and drops the rest to multiplicity 1', () => {
    // a uniform C2 cubic with 7 poles (4 spans) - the kind a regular cage edge gives
    const ctrl: Vec3[] = [[0, 0, 0], [10, 15, 2], [20, -5, 4], [30, 12, 1], [40, 0, 6], [50, 18, 0], [60, 3, 3]]
    const U = [0, 0, 0, 0, 1, 2, 3, 4, 4, 4, 4]
    // its Bezier chain, 2 spans per knot span (8 spans): sampled points of the chain equal the spline
    const bezier: Vec3[] = []
    for (let k = 0; k < 8; k++) {
      const a = k / 2, b = (k + 1) / 2
      const f = (t: number) => evalRow(U, ctrl, t)
      // Bezier poles of the span [a, b] from four samples (the cubic through them)
      const q = [0, 1 / 3, 2 / 3, 1].map((s) => f(a + (b - a) * s))
      const p1 = [0, 1, 2].map((c) => (-5 * q[0][c] + 18 * q[1][c] - 9 * q[2][c] + 2 * q[3][c]) / 6) as Vec3
      const p2 = [0, 1, 2].map((c) => (2 * q[0][c] - 9 * q[1][c] + 18 * q[2][c] - 5 * q[3][c]) / 6) as Vec3
      if (k === 0) bezier.push(q[0])
      bezier.push(p1, p2, q[3])
    }
    const r = removeKnots({ knots: c1Knots(8).map((k) => k / 2), rows: [keep(bezier)] }, 1e-9)
    expect(r.rows[0]).toHaveLength(7)
    expect(knotRuns(r.knots)).toEqual({ values: [0, 1, 2, 3, 4], mults: [4, 1, 1, 1, 4] })
    for (let t = 0; t <= 4; t += 0.1) expect(dist(evalRow(r.knots, r.rows[0], t), evalRow(U, ctrl, t))).toBeLessThan(1e-9)
  })
})
