// Form stage 5: the limit surface as bicubic Bezier patches.

import { describe, expect, it } from 'vitest'
import type { Cage, Vec3 } from '../../form/cage'
import { boxCage, creaseRimAt, cylinderCage, sphereCage } from '../../form/starters'
import { evalPatch, exactSurface, patchNormal, refinedLevel } from '../../form/exact'
import { applyRows, limitRows, refine } from '../../form/subdivide'
import { edgeKey } from '../../form/cage'

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/**
 * The true limit surface at a patch's centre (0.5, 0.5) and its four edge
 * midpoints: one more Catmull-Clark step puts a point there (the face point,
 * the edge points), and the limit mask takes it onto the surface.
 */
function limitSamples(cage: Cage, levels: number) {
  const { level, positions } = refinedLevel(cage, levels)
  const r = refine(level)
  const finer = applyRows(r.rows, positions)
  const lim = applyRows(limitRows(r.level), finer)
  const at = (i: number): Vec3 => [lim[i * 3], lim[i * 3 + 1], lim[i * 3 + 2]]
  return level.faces.map((loop, f) => {
    const [c00, c10, c11, c01] = loop
    const edge = (a: number, b: number) => at(r.edgePoint.get(edgeKey(a, b))!)
    return [
      { u: 0.5, v: 0.5, p: at(r.facePoint[f]) },
      { u: 0.5, v: 0, p: edge(c00, c10) },
      { u: 1, v: 0.5, p: edge(c10, c11) },
      { u: 0.5, v: 1, p: edge(c11, c01) },
      { u: 0, v: 0.5, p: edge(c01, c00) },
      { u: 0, v: 0, p: at(c00) },
    ]
  })
}

const knob = () => creaseRimAt(cylinderCage({ size: { x: 40, y: 40, z: 25 }, segments: { x: 8, y: 1, z: 2 } }), 0)
const CAGES: Array<[string, () => Cage]> = [
  ['box', () => boxCage({ segments: { x: 2, y: 2, z: 2 } })],
  ['sphere', () => sphereCage()],
  ['creased knob', knob],
]

describe('exact surface: bicubic Bezier patches', () => {
  for (const [name, make] of CAGES) {
    it(`${name}: every patch flagged exact IS the limit surface; the others stay close`, () => {
      const cage = make()
      const s = exactSurface(cage, 2)
      const samples = limitSamples(cage, 2)
      expect(s.patches).toHaveLength(samples.length)
      let exact = 0, worstExact = 0, worstOther = 0
      s.patches.forEach((patch, f) => {
        if (patch.exact) {
          exact++
          for (const q of samples[f]) worstExact = Math.max(worstExact, dist(evalPatch(patch.points, q.u, q.v), q.p))
          return
        }
        // an irregular patch is parametrised differently from the limit surface near its
        // extraordinary point; what matters is how far OFF the surface it is: the centre's
        // offset along the limit surface's normal there (from the four edge-midpoint samples)
        const [c, e0, e1, e2, e3] = samples[f]
        const a = [0, 1, 2].map((k) => e2.p[k] - e0.p[k]), b = [0, 1, 2].map((k) => e3.p[k] - e1.p[k])
        const n = [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
        const l = Math.hypot(n[0], n[1], n[2])
        const m = evalPatch(patch.points, 0.5, 0.5)
        worstOther = Math.max(worstOther, Math.abs((m[0] - c.p[0]) * n[0] + (m[1] - c.p[1]) * n[1] + (m[2] - c.p[2]) * n[2]) / l)
      })
      expect(exact).toBeGreaterThan(s.patches.length / 2)
      expect(worstExact).toBeLessThan(1e-9)
      // irregular patches (around an extraordinary point, a crease end): off the surface by well under 0.1 mm on a 40 mm part
      expect(worstOther).toBeLessThan(0.1)
    })
  }

  it('neighbouring patches share their boundary control points exactly (watertight)', () => {
    for (const [, make] of CAGES) {
      const cage = make()
      const { level } = refinedLevel(cage, 2)
      const s = exactSurface(cage, 2)
      // boundary of patch f along its loop edge k, as control points from loop[k] to loop[k+1]
      const rows = [[0, 4, 8, 12], [12, 13, 14, 15], [15, 11, 7, 3], [3, 2, 1, 0]]
      const byEdge = new Map<string, Vec3[][]>()
      level.faces.forEach((loop, f) => {
        for (let k = 0; k < 4; k++) {
          const a = loop[k], b = loop[(k + 1) % 4]
          const pts = rows[k].map((i) => s.patches[f].points[i])
          const list = byEdge.get(edgeKey(a, b)) ?? []
          list.push(a < b ? pts : [...pts].reverse())
          byEdge.set(edgeKey(a, b), list)
        }
      })
      for (const list of byEdge.values()) {
        expect(list).toHaveLength(2)
        expect(list[0]).toEqual(list[1])
      }
    }
  })

  it('a creased flat bottom stays exactly flat; the patches meet with a corner across the rim and smoothly elsewhere', () => {
    const cage = knob()
    const s = exactSurface(cage, 2)
    const { level } = refinedLevel(cage, 2)
    const bottom = s.patches.filter((p) => p.points.every((q) => Math.abs(q[2]) < 1e-6))
    expect(bottom.length).toBeGreaterThan(0)
    for (const p of bottom) for (const q of p.points) expect(Math.abs(q[2])).toBeLessThan(1e-12)
    // across each edge: the surface normals of the two patches at the edge's middle
    const mid = [[0.5, 0], [1, 0.5], [0.5, 1], [0, 0.5]]
    const normals = new Map<string, Vec3[]>()
    level.faces.forEach((loop, f) => {
      for (let k = 0; k < 4; k++) {
        const key = edgeKey(loop[k], loop[(k + 1) % 4])
        normals.set(key, [...(normals.get(key) ?? []), patchNormal(s.patches[f].points, mid[k][0], mid[k][1])])
      }
    })
    const angle = (a: Vec3, b: Vec3) => (Math.acos(Math.max(-1, Math.min(1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]))) * 180) / Math.PI
    const exactEdge = new Set<string>()
    level.faces.forEach((loop, f) => {
      if (s.patches[f].exact) for (let k = 0; k < 4; k++) exactEdge.add(edgeKey(loop[k], loop[(k + 1) % 4]))
    })
    let rim = 0, smooth = 0, worstRegular = 0, worstNearEv = 0
    for (const [key, [a, b]] of normals) {
      if (level.creases.has(key)) { expect(angle(a, b)).toBeGreaterThan(30); rim++; continue }
      smooth++
      // an edge with an exact patch on either side joins tangent-continuously; only edges
      // wholly among irregular patches (around an extraordinary point) carry a small kink
      if (exactEdge.has(key)) worstRegular = Math.max(worstRegular, angle(a, b))
      else worstNearEv = Math.max(worstNearEv, angle(a, b))
    }
    expect(worstRegular).toBeLessThan(1e-4)
    expect(worstNearEv).toBeLessThan(2)
    expect(rim).toBeGreaterThan(0)
    expect(smooth).toBeGreaterThan(rim)
  })
})
