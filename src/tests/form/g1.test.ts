// Form: G1 where the exact solid's faces meet at an extraordinary point (stage 13).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { edgeKey, type Cage, type Vec3 } from '../../form/cage'
import { setCreased } from '../../form/edgeLoop'
import { boxCage, cylinderCage, torusCage } from '../../form/starters'
import { formStep } from '../../form/exactStep'
import { findPairs, symmetrize } from '../../form/symmetry'
import { tessellateForm } from '../../form/finish'
import { GeomEngine } from '../../geom/worker/geom-engine'

/** the stage 10 lobed knob: the default cylinder (valence 8 at both cap centres), Circular 4, one middle-ring point 8 mm out */
function lobedKnob(): Cage {
  const c = cylinderCage()
  const z = c.positions.map((q) => q[2]).sort((a, b) => a - b)
  const mid = z[Math.floor(z.length / 2)]
  const p = c.positions.findIndex((q) => Math.abs(q[2] - mid) < 1e-9 && q[0] > 19)
  const moved = c.positions.map((q) => [...q] as Vec3)
  moved[p] = [moved[p][0] + 8, moved[p][1], moved[p][2]]
  return symmetrize({ ...c, positions: moved }, findPairs(c, 'c4'), [p])
}
const fiveSided = () => cylinderCage({ segments: { x: 5, y: 1, z: 2 } })
const box = () => boxCage({ segments: { x: 2, y: 2, z: 2 } })

function meshVolume(P: Float64Array, I: Uint32Array): number {
  let v = 0
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3
    v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6
  }
  return v
}

describe('G1 at extraordinary points', () => {
  const CASES: Array<[string, () => Cage, number, number]> = [
    // name, cage, the kink it had (at least), the most it may keep, degrees
    ['the lobed knob (valence 8 cap centres, valence 3 rim points)', lobedKnob, 2, 0.05],
    ['a 5-sided cylinder (valence 5 cap centres)', fiveSided, 0.4, 0.01],
    ['a box (valence 3 corners)', box, 0.4, 0.005],
  ]
  for (const [name, make, before, after] of CASES) {
    it(`${name}: the faces meeting there go from a kink of over ${before} degrees to under ${after}, moving the surface under 0.2 mm`, () => {
      const s = formStep(make(), 'F', 3)
      expect(s.g1BeforeDeg).toBeGreaterThan(before)
      expect(s.g1AfterDeg).toBeLessThan(after)
      expect(s.g1SurfaceMoveMm).toBeLessThan(0.2)
    })
  }

  // the audit's creased cages (WO-2150): a crease ending at, or running through, extraordinary points
  const boxOneCrease = () => { const c = boxCage(); return setCreased(c, [edgeKey(c.faces[0][0], c.faces[0][1])], true) }
  const creasedSides = (segments: number) => {
    const c = cylinderCage({ segments: { x: segments, y: 1, z: 2 } })
    // the side edges above cage point 0, rim to rim
    const col = c.positions.map((p, i) => [p, i] as const).filter(([p]) => Math.abs(p[0] - c.positions[0][0]) < 1e-9 && Math.abs(p[1] - c.positions[0][1]) < 1e-9).sort((a, b) => a[0][2] - b[0][2]).map(([, i]) => i)
    return setCreased(c, col.slice(1).map((p, k) => edgeKey(col[k], p)), true)
  }
  // each with the same cage uncreased: a crease is no licence to move the surface more
  const CREASED: Array<[string, () => Cage, () => Cage]> = [
    ['a box with one creased edge (ending at valence-3 corners)', boxOneCrease, () => boxCage()],
    ['the default cylinder with its side edges creased rim to rim', () => creasedSides(8), () => cylinderCage()],
    ['a 32-segment cylinder with its side edges creased', () => creasedSides(32), () => cylinderCage({ segments: { x: 32, y: 1, z: 2 } })],
  ]
  for (const [name, make, plain] of CREASED) {
    it(`${name}: the creases keep their angle, the smooth boundaries end up no worse, the surface moves no more than uncreased`, () => {
      const s = formStep(make(), 'C', 3)
      expect(s.g1CreaseChangeDeg).toBeLessThan(0.01)
      expect(s.g1AfterDeg).toBeLessThanOrEqual(s.g1BeforeDeg + 1e-9)
      expect(s.g1SurfaceMoveMm).toBeLessThanOrEqual(formStep(plain(), 'P', 3).g1SurfaceMoveMm + 0.01)
    })
  }

  it('the report counts every smooth boundary, however large its kink: a 32-segment cylinder\'s valence-32 cap centre shows over 20 degrees before', () => {
    const s = formStep(cylinderCage({ segments: { x: 32, y: 1, z: 2 } }), 'C', 3)
    expect(s.g1BeforeDeg).toBeGreaterThan(20)
    expect(s.g1AfterDeg).toBeLessThan(1)
  })

  it('a form with no extraordinary point (a torus) is left exactly as it was', () => {
    const s = formStep(torusCage(), 'T', 3)
    expect(s.g1BeforeDeg).toBe(0)
    expect(s.g1MoveMm).toBe(0)
  })
})

describe('the G1 solid in the kernel (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })

  const boxCreased = () => { const c = boxCage(); return setCreased(c, [edgeKey(c.faces[0][0], c.faces[0][1])], true) }
  for (const [name, make] of [['the lobed knob', lobedKnob], ['the 5-sided cylinder', fiveSided], ['a box with one creased edge', boxCreased]] as const) {
    it(`${name} still reads back as ONE closed solid enclosing the limit surface's volume`, async () => {
      const cage = make()
      const res = await engine.importStep(new TextEncoder().encode(formStep(cage, 'F', 3).text).buffer as ArrayBuffer, 'FRM1')
      expect(res.bodies).toHaveLength(1)
      const volume = (await engine.measure(res.bodies[0].handle, 'volume')).value
      const t = tessellateForm(cage, 0.002, 400_000)
      const expected = meshVolume(t.positions, t.indices)
      expect(Math.abs(volume - expected) / expected).toBeLessThan(5e-4)
    }, 180_000)
  }
})
