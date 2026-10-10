// Form stage 5: the exact CAD solid - B-spline faces through the kernel's STEP import.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import { boxCage, creaseRimAt, cylinderCage, planeCage, sphereCage, torusCage } from '../../form/starters'
import { bridge, thicken } from '../../form/topoTools'
import { formStep } from '../../form/exactStep'
import { buildFormBody, makeFormFeaturePayload } from '../../form/formBody'
import { tessellateForm } from '../../form/finish'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'
import type { Cage } from '../../form/cage'
import { withoutSmoothFormFacetEdges } from '../../form/formEdges'
import { validateCage } from '../../form/halfEdge'

const knob = () => creaseRimAt(cylinderCage({ size: { x: 40, y: 40, z: 25 }, segments: { x: 8, y: 1, z: 2 } }), 0)

function meshVolume(P: Float64Array, I: Uint32Array): number {
  let v = 0
  for (let i = 0; i < I.length; i += 3) {
    const a = I[i] * 3, b = I[i + 1] * 3, c = I[i + 2] * 3
    v += (P[a] * (P[b + 1] * P[c + 2] - P[b + 2] * P[c + 1]) - P[a + 1] * (P[b] * P[c + 2] - P[b + 2] * P[c]) + P[a + 2] * (P[b] * P[c + 1] - P[b + 1] * P[c])) / 6
  }
  return v
}

const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

describe('the exact solid of a form (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 120_000)
  afterAll(async () => {
    await engine.disposeKernel()
  })

  const throughHole = () => {
    const c = boxCage({ segments: { x: 3, y: 3, z: 3 } })
    const centre = (z: number) => c.faces.findIndex((f) => f.every((p) => Math.abs(c.positions[p][2] - z) < 1e-9) && f.every((p) => Math.abs(c.positions[p][0]) < 7 && Math.abs(c.positions[p][1]) < 7))
    return bridge(c, centre(40), centre(0))!
  }
  const CASES: Array<[string, () => Cage]> = [
    ['knob', knob], ['sphere', () => sphereCage()], ['box', () => boxCage({ segments: { x: 2, y: 2, z: 2 } })],
    ['box with a bridged hole through it (genus 1)', throughHole], ['thickened plane (creased rims)', () => thicken(planeCage({ segments: { x: 3, y: 3, z: 1 } }), 3)!],
  ]
  for (const [name, make] of CASES) {
    it(`${name}: reads back as ONE closed solid enclosing the limit surface's volume`, async () => {
      const cage = make()
      const step = formStep(cage, name, 3)
      const res = await engine.importStep(bytes(step.text), 'FRM1')
      expect(res.bodies).toHaveLength(1)
      const volume = (await engine.measure(res.bodies[0].handle, 'volume')).value
      const t = tessellateForm(cage, 0.002, 400_000)
      const expected = meshVolume(t.positions, t.indices)
      expect(Math.abs(volume - expected) / expected).toBeLessThan(2e-4)
      expect(res.bodies[0].elementMap.generated).toHaveLength(step.bsplineFaces + step.planarFaces)
      expect(res.bodies[0].elementMap.generated.every((id) => /^FRM1:step:face#\d+$/.test(id))).toBe(true)
    }, 180_000)
  }

  it('a torus: every point ordinary, so every patch is the limit surface exactly; one solid with a hole', async () => {
    const cage = torusCage()
    expect(validateCage(cage, true).problems).toEqual([])
    const step = formStep(cage, 'Torus', 3)
    expect(step.exactPatches).toBe(step.patches)
    const res = await engine.importStep(bytes(step.text), 'FRM1')
    expect(res.bodies).toHaveLength(1)
    const volume = (await engine.measure(res.bodies[0].handle, 'volume')).value
    const t = tessellateForm(cage, 0.002, 400_000)
    expect(Math.abs(volume - meshVolume(t.positions, t.indices)) / volume).toBeLessThan(2e-4)
  }, 180_000)

  it('the knob: B-spline sides (packed: 18, one face per region its valence-8 cap centre and rim bound), ONE planar bottom, and a fillet runs along its creased rim', async () => {
    const step = formStep(knob(), 'Knob', 3)
    expect(step.planarFaces).toBe(1)
    expect(step.bsplineFaces).toBe(18)
    const res = await engine.importStep(bytes(step.text), 'FRM1')
    const body = res.bodies[0].handle
    const kinds = await Promise.all(res.bodies[0].elementMap.generated.map((id) => engine.classifyFace(body, id)))
    expect(kinds.filter((k) => k === 'plane')).toHaveLength(1)
    expect(kinds.filter((k) => k === 'bspline')).toHaveLength(18)
    // the rim: every edge lying on Z = 0
    const tess = await engine.tessellate(body, DISPLAY_TESS_QUALITY)
    const rim: string[] = []
    for (let e = 0; e + 1 < tess.edgeOffsets.length; e++) {
      let onBottom = true
      for (let q = tess.edgeOffsets[e]; q < tess.edgeOffsets[e + 1]; q++) if (Math.abs(tess.edgePositions[q * 3 + 2]) > 1e-3) { onBottom = false; break }
      if (onBottom) rim.push(tess.edgeIds[e])
    }
    expect(rim.length).toBeGreaterThan(0)
    const before = (await engine.measure(body, 'volume')).value
    const filleted = await engine.applyFillet({ featureId: 'FIL1', body, edges: rim, radius: 2, propagateTangent: true })
    expect(filleted.ok).toBe(true)
    const after = (await engine.measure(filleted.body!, 'volume')).value
    // a 2 mm round along a ~113 mm rim takes off (1 - pi/4) r^2 per mm: ~97 mm^3
    expect(before - after).toBeGreaterThan(60)
    expect(before - after).toBeLessThan(130)
  }, 180_000)

  it('the exact knob draws its creased rim, not the seams between its smooth faces', async () => {
    const res = await engine.importStep(bytes(formStep(knob(), 'Knob', 3).text), 'FRM1')
    const tess = await engine.tessellate(res.bodies[0].handle, DISPLAY_TESS_QUALITY)
    const shown = withoutSmoothFormFacetEdges(tess)
    expect(shown.edgeIds.length).toBeGreaterThan(0)
    expect(tess.edgeIds.length).toBeGreaterThan(shown.edgeIds.length)
    // what stays is the rim: every kept edge lies on Z = 0
    for (let p = 2; p < shown.edgePositions.length; p += 3) expect(Math.abs(shown.edgePositions[p])).toBeLessThan(1e-3)
  }, 180_000)

  it('the knob shells (1.5 mm walls, open at its flat bottom): its faces offset, as C1 surfaces do', async () => {
    const res = await engine.importStep(bytes(formStep(knob(), 'Knob', 3).text), 'FRM1')
    const body = res.bodies[0].handle
    const ids = res.bodies[0].elementMap.generated
    const kinds = await Promise.all(ids.map((id) => engine.classifyFace(body, id)))
    const shelled = await engine.applyShell({ featureId: 'SH1', body, removeFaces: [ids[kinds.indexOf('plane')]], thickness: 1.5 })
    expect(shelled.ok).toBe(true)
    const solidVolume = (await engine.measure(body, 'volume')).value
    const wallVolume = (await engine.measure(shelled.body!, 'volume')).value
    // walls of 1.5 mm over ~3,300 mm^2 of skin: a few thousand mm^3, far less than the solid
    expect(wallVolume).toBeGreaterThan(2000)
    expect(wallVolume).toBeLessThan(solidVolume / 3)
  }, 180_000)

  it('a STEP export of the exact solid carries its B-spline surfaces', async () => {
    const res = await engine.importStep(bytes(formStep(knob(), 'Knob', 3).text), 'FRM1')
    const out = new TextDecoder().decode(await engine.exportStep([res.bodies[0].handle]))
    expect((out.match(/B_SPLINE_SURFACE_WITH_KNOTS/g) ?? []).length).toBeGreaterThanOrEqual(18)
  }, 180_000)

  it('a form feature replays into the exact solid, and into the faceted one when the exact read fails', async () => {
    const payload = makeFormFeaturePayload('Knob', knob(), 0.05)
    const exact = await buildFormBody(engine, payload, 'FRM1')
    expect(exact.ok).toBe(true)
    expect(exact.diagnostics.find((d) => d.params?.surface !== undefined)?.params?.surface).toBe('exact')
    const failing = { ...engine, importStep: async () => ({ bodies: [], diagnostics: [] }), makeSolidFromPlanarFaces: engine.makeSolidFromPlanarFaces.bind(engine), measure: engine.measure.bind(engine), dispose: engine.dispose.bind(engine) }
    const faceted = await buildFormBody(failing, payload, 'FRM1')
    expect(faceted.ok).toBe(true)
    const info = faceted.diagnostics.find((d) => d.params?.surface !== undefined)?.params
    expect(info?.surface).toBe('faceted')
    expect(String(info?.reason)).toMatch(/0 bodies/)
  }, 180_000)
})
