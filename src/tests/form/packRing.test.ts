// Form stage 46: face packing is no longer broken by the G1 pass nudging joins that are already smooth. A one-ring
// cylinder side (From body's ruled ring, stage 45) is two B-spline faces - the fewest without a seam - not one per
// couple of quads; star points are still made G1.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import { FORM_FROM_BODY_TESS, formFromBody } from '../../form/fromMesh'
import { edgeKey, type Cage, type Vec3 } from '../../form/cage'
import { formStep } from '../../form/exactStep'
import { creaseRimAt, cylinderCage } from '../../form/starters'

/** a closed cylinder cage: n quads round one ring, both rims creased, n-gon caps */
function oneRing(n: number): Cage {
  const P: Vec3[] = []
  for (const z of [0, 30]) for (let i = 0; i < n; i++) { const a = (2 * Math.PI * i) / n; P.push([10 * Math.cos(a), 10 * Math.sin(a), z]) }
  const faces: number[][] = []
  for (let i = 0; i < n; i++) faces.push([i, (i + 1) % n, n + (i + 1) % n, n + i])
  faces.push(Array.from({ length: n }, (_, i) => n - 1 - i))
  faces.push(Array.from({ length: n }, (_, i) => n + i))
  const creases: string[] = []
  for (let i = 0; i < n; i++) { creases.push(edgeKey(i, (i + 1) % n)); creases.push(edgeKey(n + i, n + (i + 1) % n)) }
  return { positions: P, faces, creases }
}

describe('packing a ring', () => {
  for (const n of [8, 18]) {
    it(`a one-ring cylinder of ${n} quads: its side is 2 faces, the joins exactly C1, the G1 pass moving nothing there`, () => {
      const s = formStep(oneRing(n), 'F', 3)
      expect(s.planarFaces).toBe(2)
      expect(s.bsplineFaces).toBe(2)
      expect(s.packJoinMm).toBeLessThan(1e-9)
      expect(s.g1MoveMm).toBe(0)
    })
  }

  it('a star point is still made G1: the knob (valence-8 cap centre) keeps its tangent plane within 0.02 deg', () => {
    const cage = () => creaseRimAt(cylinderCage({ size: { x: 40, y: 40, z: 25 }, segments: { x: 8, y: 1, z: 2 } }), 0)
    // the bicubic G1 pass (still used where the exact solve is not: a crease or a flat face at the point)
    const s = formStep(cage(), 'F', 3, true, true, false)
    expect(s.g1MoveMm).toBeGreaterThan(0)
    expect(s.g1AfterDeg).toBeLessThan(0.02)
    expect(s.g1AfterDeg).toBeLessThan(s.g1BeforeDeg)
    // stage 49: the cap centre is solved exactly instead (degree-5 corner patches), and the pass moves nothing
    const e = formStep(cage(), 'F', 3)
    expect(e.exactG1Points).toBeGreaterThan(0)
    expect(e.exactG1SeamDeg).toBeLessThan(1e-8)
    expect(e.g1AfterDeg).toBeLessThan(0.02)
  })
})

describe('packed and reduced, the kernel still measures it right (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })
  const volume = async (text: string) => {
    const r = await engine.importStep(new TextEncoder().encode(text).buffer as ArrayBuffer, 'X')
    expect(r.bodies).toHaveLength(1)
    return (await engine.measure(r.bodies[0].handle, 'volume')).value
  }

  it('a cylinder From body (one ring): 2 packed side faces, the same volume as every quad on its own, unreduced', async () => {
    const cyl = await engine.debugMakeCylinder('C', 10, 30)
    const cage = formFromBody(await engine.tessellate(cyl.body!, FORM_FROM_BODY_TESS)).cage
    const lean = formStep(cage, 'F', 3)
    expect(lean.bsplineFaces).toBe(2)
    const plain = formStep(cage, 'P', 3, false, false)
    // a packed face reduced to one span up its height measured 0.15% off; at least 4 spans each way it matches
    expect(Math.abs((await volume(lean.text)) / (await volume(plain.text)) - 1)).toBeLessThan(3e-5)
  }, 180_000)
})
