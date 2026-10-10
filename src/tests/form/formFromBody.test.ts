// Form: start a form from an existing body - the path before stage 34's remesh
// (formFromBody(mesh, { remesh: false })), kept as the control; the default is
// proven in remesh.test.ts.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import { formFromBody } from '../../form/fromMesh'
import { formStep } from '../../form/exactStep'
import { validateCage } from '../../form/halfEdge'

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('a form from a body (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })

  const exactVolume = async (cage: Parameters<typeof formStep>[0]) => {
    const res = await engine.importStep(bytes(formStep(cage, 'F', 3).text), 'FRM9')
    expect(res.bodies).toHaveLength(1)
    return (await engine.measure(res.bodies[0].handle, 'volume')).value
  }

  it('a box comes back as itself: six flat faces, every edge creased, the same volume', async () => {
    const box = await engine.makeBox('B', { x: 30, y: 30, z: 20 })
    const t = await engine.tessellate(box.body!, { deflection: 0.5, angularDeflection: 0.5 })
    const r = formFromBody(t, { remesh: false })
    expect(r.flatFaces).toBe(6)
    expect(r.cage.faces).toHaveLength(6)
    expect(r.cage.creases).toHaveLength(12)
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(await exactVolume(r.cage)).toBeCloseTo(18000, 3)
  }, 180_000)

  it('a cylinder: flat ends kept, the curved side smooth, sharp rims creased, close to the volume', async () => {
    const cyl = await engine.debugMakeCylinder('C', 10, 20)
    const t = await engine.tessellate(cyl.body!, { deflection: 0.2, angularDeflection: 0.3 })
    const r = formFromBody(t, { remesh: false })
    expect(r.flatFaces).toBe(2)
    expect(r.curvedTriangles).toBeGreaterThan(8)
    expect(validateCage(r.cage, true).problems).toEqual([])
    const v = await exactVolume(r.cage)
    const truth = Math.PI * 100 * 20
    // inside its cage, like any subdivision surface: a little smaller, within a few percent
    expect(v).toBeLessThan(truth)
    expect(v).toBeGreaterThan(truth * 0.9)
  }, 180_000)

  it('a box with a corner notched out by a cylinder: flat faces kept whole, the curved notch smooth, one closed form', async () => {
    // the kernel's box and cylinder both grow from the origin: the cylinder takes a quarter-round notch out of a corner
    const box = await engine.makeBox('B2', { x: 30, y: 30, z: 20 })
    const cyl = await engine.debugMakeCylinder('C2', 5, 20)
    const cut = await engine.applyBoolean({ featureId: 'X', op: 'cut', target: box.body!, tools: [cyl.body!] })
    expect(cut.ok).toBe(true)
    const t = await engine.tessellate(cut.body!, { deflection: 0.3, angularDeflection: 0.4 })
    const r = formFromBody(t, { remesh: false })
    expect(validateCage(r.cage, true).problems).toEqual([])
    expect(r.flatFaces).toBe(6)
    expect(r.curvedTriangles).toBeGreaterThan(0)
    const v = await exactVolume(r.cage)
    const truth = 30 * 30 * 20 - (Math.PI * 25 / 4) * 20
    expect(Math.abs(v - truth) / truth).toBeLessThan(0.02)
  }, 180_000)
})
