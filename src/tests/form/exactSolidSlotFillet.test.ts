// Form stage 5: a fillet along a slot cut into an exact form, and the kernel after it.
//
// Its own file and its own kernel: on a kernel linked with the 64 KB default C stack this fillet
// overwrites the heap, and every later call in the same kernel fails - kept apart so that failure
// names itself instead of spilling into the other exact-solid tests.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import { creaseRimAt, cylinderCage } from '../../form/starters'
import { formStep } from '../../form/exactStep'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'

const knob = () => creaseRimAt(cylinderCage({ size: { x: 40, y: 40, z: 25 }, segments: { x: 8, y: 1, z: 2 } }), 0)
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('a fillet along a slot cut into an exact form (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 120_000)
  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('a slot cut across the crown, a fillet along its rim where the walls meet the form, and the kernel still works after', async () => {
    // the kernel's box grows from the origin: move the knob so a 4 mm box cuts straight across its crown
    const k = knob()
    const moved = { ...k, positions: k.positions.map((p) => [p[0] + 2, p[1] + 25, p[2] - 20] as [number, number, number]) }
    const res = await engine.importStep(bytes(formStep(moved, 'Knob', 3).text), 'FRM1')
    const box = await engine.makeBox('BOX1', { x: 4, y: 50, z: 40 })
    const cut = await engine.applyBoolean({ featureId: 'CUT1', op: 'cut', target: res.bodies[0].handle, tools: [box.body!] })
    expect(cut.ok).toBe(true)
    const tess = await engine.tessellate(cut.body!, DISPLAY_TESS_QUALITY)
    const rim: string[] = []
    for (let e = 0; e + 1 < tess.edgeOffsets.length; e++) {
      let onWall = true
      for (let q = tess.edgeOffsets[e]; q < tess.edgeOffsets[e + 1]; q++) {
        const x = tess.edgePositions[q * 3], z = tess.edgePositions[q * 3 + 2]
        if (!((Math.abs(x) < 1e-3 || Math.abs(x - 4) < 1e-3) && z > 1e-3)) { onWall = false; break }
      }
      if (onWall) rim.push(tess.edgeIds[e])
    }
    expect(rim.length).toBeGreaterThan(4)
    const filleted = await engine.applyFillet({ featureId: 'FIL2', body: cut.body!, edges: rim, radius: 0.5, propagateTangent: true })
    expect(filleted.ok).toBe(true)
    // the vendored kernel's 64 KB C stack overflowed into its heap here: the fillet "worked", then every
    // later call failed (memory access out of bounds). The next import must still work.
    const next = await engine.importStep(bytes(formStep(knob(), 'Knob', 3).text), 'FRM9')
    expect(next.diagnostics.filter((d) => d.severity === 'error'), 'the kernel broke after the fillet: is node_modules/occt-wasm the 8 MB-stack build (npm ci installs vendor/occt-wasm/occt-wasm-3.6.1-geo9-iges-history-stack.tgz)?').toEqual([])
    expect(next.bodies).toHaveLength(1)
  }, 180_000)
})
