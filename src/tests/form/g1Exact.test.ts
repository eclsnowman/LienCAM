// Form: exact G1 at extraordinary points - degree-5 corner patches (stage 48 the solve, stage 49 in the export).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Cage, Vec3 } from '../../form/cage'
import { boxCage, cylinderCage } from '../../form/starters'
import { formStep, rootGrids } from '../../form/exactStep'
import { GeomEngine } from '../../geom/worker/geom-engine'
import { tessellateForm } from '../../form/finish'
import { exactG1Corners } from '../../form/g1Exact'
import { findPairs, symmetrize } from '../../form/symmetry'

function lobedKnob(): Cage {
  const c = cylinderCage()
  const z = c.positions.map((q) => q[2]).sort((a, b) => a - b)
  const mid = z[Math.floor(z.length / 2)]
  const p = c.positions.findIndex((q) => Math.abs(q[2] - mid) < 1e-9 && q[0] > 19)
  const moved = c.positions.map((q) => [...q] as Vec3)
  moved[p] = [moved[p][0] + 8, moved[p][1], moved[p][2]]
  return symmetrize({ ...c, positions: moved }, findPairs(c, 'c4'), [p])
}

describe('exact G1 corner patches', () => {
  const CASES: Array<[string, () => Cage]> = [
    ['a box (valence 3)', () => boxCage({ segments: { x: 2, y: 2, z: 2 } })],
    ['a 5-sided cylinder (valence 5)', () => cylinderCage({ segments: { x: 5, y: 1, z: 2 } })],
    ['a 6-sided cylinder (valence 6)', () => cylinderCage({ segments: { x: 6, y: 1, z: 2 } })],
    ['the lobed knob (valence 8 and 3)', lobedKnob],
  ]
  for (const [name, make] of CASES) {
    it(`${name}: the faces round each extraordinary point meet with one tangent plane, exactly`, () => {
      const g = rootGrids(make(), 3)
      const r = exactG1Corners(g.roots, g.n, g.creaseSides)
      expect(r.solved).toBeGreaterThan(0)
      expect(r.skipped).toBe(0)
      // the bicubic corner patches kink by 0.48 to 2.4 deg; the degree-5 ones meet to rounding (1e-11 deg measured)
      expect(r.beforeDeg).toBeGreaterThan(0.4)
      expect(r.seamDeg).toBeLessThan(1e-8)
      // every constraint met (1e-15 measured), the ordinary neighbours' C1 kept (1e-13), the surface moved little (0.056 at most)
      expect(r.inconsistencyMm).toBeLessThan(1e-9)
      expect(r.c1MismatchMm).toBeLessThan(1e-9)
      expect(r.surfaceMoveMm).toBeLessThan(0.1)
    })
  }
})

const box = () => boxCage({ segments: { x: 2, y: 2, z: 2 } })
const cyl6 = () => cylinderCage({ segments: { x: 6, y: 1, z: 2 } })

describe('exact G1 in the export (stage 49)', () => {
  const CASES: Array<[string, () => Cage, number]> = [
    ['a box', box, 8],
    ['a 6-sided cylinder', cyl6, 14],
    ['the lobed knob', lobedKnob, 18],
  ]
  for (const [name, make, points] of CASES) {
    it(`${name}: every extraordinary point solved exactly; the same faces and edges as the bicubic file, those holding a corner patch at degree 5`, () => {
      const e = formStep(make(), 'F', 3)
      const b = formStep(make(), 'F', 3, true, true, false)
      expect(e.exactG1Points).toBe(points)
      expect(e.exactG1SeamDeg).toBeLessThan(1e-8)
      expect(b.exactG1Points).toBe(0)
      expect(b.g1AfterDeg).toBeGreaterThan(1e-4)
      expect([e.bsplineFaces, e.planarFaces, e.edges]).toEqual([b.bsplineFaces, b.planarFaces, b.edges])
      expect(e.degree5Faces).toBeGreaterThan(0)
      expect(e.text).toContain("B_SPLINE_SURFACE_WITH_KNOTS('',5,5,")
      // the surface moves less than the bicubic pass moved it
      expect(e.g1SurfaceMoveMm).toBeLessThan(0.1)
    })
  }
})

function meshVolume(P: Float64Array, I: Uint32Array): number {
  let v = 0
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3
    v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6
  }
  return v
}

describe('the exact-G1 solid in the kernel (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })
  const bytes = (t: string) => new TextEncoder().encode(t).buffer as ArrayBuffer
  /** the largest angle between two faces' normals where the kernel's mesh has one point on both (a face boundary), degrees */
  const seamFromMesh = async (text: string, id: string) => {
    const res = await engine.importStep(bytes(text), id)
    const t = await engine.tessellate(res.bodies[0].handle, { deflection: 0.05 })
    const at = new Map<string, Array<{ f: number; n: [number, number, number] }>>()
    for (let tri = 0; tri < t.index.length / 3; tri++) {
      const f = t.triFace[tri]
      for (let c = 0; c < 3; c++) {
        const v = t.index[tri * 3 + c]
        const key = [0, 1, 2].map((k) => Math.round(t.position[v * 3 + k] * 1e4)).join(',')
        const n: [number, number, number] = [t.normal[v * 3], t.normal[v * 3 + 1], t.normal[v * 3 + 2]]
        at.set(key, [...(at.get(key) ?? []), { f, n }])
      }
    }
    let worst = 0
    for (const list of at.values()) for (const a of list) for (const b of list) {
      if (a.f === b.f) continue
      const la = Math.hypot(...a.n), lb = Math.hypot(...b.n)
      const d = (a.n[0] * b.n[0] + a.n[1] * b.n[1] + a.n[2] * b.n[2]) / (la * lb)
      const x = [a.n[1] * b.n[2] - a.n[2] * b.n[1], a.n[2] * b.n[0] - a.n[0] * b.n[2], a.n[0] * b.n[1] - a.n[1] * b.n[0]]
      worst = Math.max(worst, Math.atan2(Math.hypot(...x) / (la * lb), d) * 180 / Math.PI)
    }
    return { res, worst }
  }
  for (const [name, make] of [['the lobed knob', lobedKnob], ['a 6-sided cylinder', cyl6]] as const) {
    it(`${name}: ONE closed solid enclosing the limit surface's volume; the kernel's own normals agree across every face boundary`, async () => {
      const cage = make()
      const e = formStep(cage, 'F', 3), b = formStep(cage, 'F', 3, true, true, false)
      const ne = await seamFromMesh(e.text, 'FRM1'), nb = await seamFromMesh(b.text, 'FRM2')
      expect(ne.res.bodies).toHaveLength(1)
      expect(ne.res.bodies[0].elementMap.generated).toHaveLength(e.bsplineFaces + e.planarFaces)
      const volume = (await engine.measure(ne.res.bodies[0].handle, 'volume')).value
      const t = tessellateForm(cage, 0.002, 400_000)
      const expected = meshVolume(t.positions, t.indices)
      expect(Math.abs(volume - expected) / expected).toBeLessThan(5e-4)
      // the kernel's normals are single precision; measured, the bicubic file's star points show through them at
      // 0.0104 deg (knob) and 0.0023 deg (6-sided), the degree-5 file's faces round to the same normals (7e-12 deg)
      expect(nb.worst).toBeGreaterThan(1e-3)
      expect(ne.worst).toBeLessThan(1e-5)
    }, 240_000)
  }
})
