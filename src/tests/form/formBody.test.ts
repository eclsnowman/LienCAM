// Form -> Model body: the form feature's payload (the cage) replays into a
// closed kernel solid through makeSolidFromPlanarFaces on the REAL occt-wasm
// kernel, and Finish tessellation meets its tolerance.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine'
import { creaseRimAt, cylinderCage, sphereCage, planeCage } from '../../form/starters'
import { tessellateForm } from '../../form/finish'
import { FORM_BODY_MAX_TRIANGLES, formFaceSet, isFormFeaturePayload, makeFormFeaturePayload, planarRegions, faceRings } from '../../form/formBody'
import { validateCage } from '../../form/halfEdge'
import { WORKBENCH_BODY_OP_TYPES } from '../../components/model3d/bodyLineage'
import { withoutSmoothFormFacetEdges, isFormFacetId } from '../../form/formEdges'
import { DISPLAY_TESS_QUALITY } from '../../viewport3d/tessQuality'

/** Signed volume of a closed triangle mesh (divergence theorem). */
function meshVolume(positions: Float64Array, indices: Uint32Array): number {
  let v = 0
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3, b = indices[i + 1] * 3, c = indices[i + 2] * 3
    v += (positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1])
      - positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c])
      + positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c])) / 6
  }
  return v
}

/** The knob the stage-4 proof uses: a cylinder cage, flat creased bottom. */
function knobCage() {
  return creaseRimAt(cylinderCage({ size: { x: 40, y: 40, z: 25 }, segments: { x: 8, y: 1, z: 2 } }), 0)
}

describe('Finish tessellation', () => {
  it('refines until the measured chord meets the tolerance', () => {
    const coarse = tessellateForm(sphereCage(), 0.1)
    const fine = tessellateForm(sphereCage(), 0.02)
    expect(coarse.chordError).toBeLessThanOrEqual(0.1)
    expect(fine.chordError).toBeLessThanOrEqual(0.02)
    expect(fine.level).toBeGreaterThan(coarse.level)
    expect(fine.indices.length).toBeGreaterThan(coarse.indices.length)
    expect(fine.capped).toBe(false)
  })

  it('is closed and outward: positive volume, every edge shared by two triangles', () => {
    const t = tessellateForm(knobCage(), 0.05)
    expect(meshVolume(t.positions, t.indices)).toBeGreaterThan(0)
    const uses = new Map<string, number>()
    for (let i = 0; i < t.indices.length; i += 3) {
      for (let k = 0; k < 3; k++) {
        const a = t.indices[i + k], b = t.indices[i + (k + 1) % 3]
        const key = a < b ? `${a}:${b}` : `${b}:${a}`
        uses.set(key, (uses.get(key) ?? 0) + 1)
      }
    }
    expect([...uses.values()].every((n) => n === 2)).toBe(true)
  })

  it('a flat creased bottom stays exactly flat (no chord error counted in a flat region)', () => {
    const t = tessellateForm(knobCage(), 0.05)
    let minZ = Infinity
    for (let i = 2; i < t.positions.length; i += 3) minZ = Math.min(minZ, t.positions[i])
    expect(minZ).toBeCloseTo(0, 9)
    expect(t.chordError).toBeLessThanOrEqual(0.05)
  })

  it('stops at the triangle cap and says so', () => {
    const t = tessellateForm(knobCage(), 0.001, 20_000)
    expect(t.capped).toBe(true)
    expect(t.indices.length / 3).toBeLessThanOrEqual(20_000)
    expect(t.chordError).toBeGreaterThan(0.001)
  })
})

describe('the form feature payload', () => {
  it('carries a deep copy of the cage and round-trips its type check', () => {
    const cage = knobCage()
    const payload = makeFormFeaturePayload('Knob', cage, 0.01)
    cage.positions[0][0] = 999
    expect(payload.cage.positions[0][0]).not.toBe(999)
    expect(isFormFeaturePayload({ ...payload })).toBe(true)
    expect(isFormFeaturePayload({ opType: 'form', name: 'x' })).toBe(false)
    expect(WORKBENCH_BODY_OP_TYPES).toContain('form')
  })

  it('an open cage is refused by name (a body must be closed)', () => {
    const r = formFaceSet(makeFormFeaturePayload('Sheet', planeCage()), 'FRM1')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not a closed cage/)
  })
})

describe('flat regions become one face', () => {
  // a 3 x 3 grid of unit squares on Z = 0, two triangles each; `drop` leaves squares out
  function grid(drop: number[] = []) {
    const P: number[] = []
    for (let y = 0; y <= 3; y++) for (let x = 0; x <= 3; x++) P.push(x, y, 0)
    const I: number[] = []
    for (let y = 0; y < 3; y++) for (let x = 0; x < 3; x++) {
      if (drop.includes(y * 3 + x)) continue
      const a = y * 4 + x, b = a + 1, c = a + 5, d = a + 4
      I.push(a, b, c, a, c, d)
    }
    return { P, I }
  }

  it('a flat patch merges into one region with one boundary loop in the triangles\' winding', () => {
    const { P, I } = grid()
    const r = planarRegions(P, I)
    expect(r).toHaveLength(1)
    expect(r[0].triangles).toHaveLength(18)
    expect(r[0].loop).toHaveLength(12)
    // counter-clockwise seen from +Z, like the triangles
    let area = 0
    r[0].loop.forEach((p, i) => { const q = r[0].loop[(i + 1) % r[0].loop.length]; area += P[p * 3] * P[q * 3 + 1] - P[q * 3] * P[p * 3 + 1] })
    expect(area / 2).toBeCloseTo(9, 9)
  })

  it('a flat ring around a hole, or a pinch at a point, is left as triangles', () => {
    const holed = grid([4])
    expect(planarRegions(holed.P, holed.I)).toEqual([])
    // squares 4 and 8 out: the rest is one connected patch whose rim touches itself at (2, 2)
    const pinched = grid([4, 8])
    expect(planarRegions(pinched.P, pinched.I)).toEqual([])
  })
})

describe('the faces a tessellation goes to the kernel as', () => {
  /** Every edge of every face is shared by exactly two faces (no T-junction, no gap). */
  function watertight(rings: number[][]): boolean {
    const uses = new Map<string, number>()
    for (const r of rings) r.forEach((a, i) => {
      const b = r[(i + 1) % r.length]
      const key = a < b ? `${a}:${b}` : `${b}:${a}`
      uses.set(key, (uses.get(key) ?? 0) + 1)
    })
    return [...uses.values()].every((n) => n === 2)
  }

  it('a straight rim point stays where a curved neighbour still uses it (no T-junction)', () => {
    // a closed tent: flat 2 x 1 floor on Z = 0, roof from two apexes at different heights, so
    // the two roof triangles on the front edge (0,0)-(1,0)-(2,0) are NOT coplanar
    const P = [0, 0, 0, 1, 0, 0, 2, 0, 0, 0, 1, 0, 1, 1, 0, 2, 1, 0, 0.5, 0.5, 1, 1.5, 0.5, 2]
    const [a, b, c, d, e, f, t1, t2] = [0, 1, 2, 3, 4, 5, 6, 7]
    const I = [
      a, e, b, a, d, e, b, f, c, b, e, f, // floor (two quads, facing down)
      a, b, t1, b, c, t2, b, t2, t1, // front
      e, d, t1, f, e, t2, e, t1, t2, // back
      d, a, t1, c, f, t2, // ends
    ]
    const rings = faceRings(P, I)
    const floor = rings.find((r) => r.length > 3 && r.every((p) => P[p * 3 + 2] === 0))!
    expect(floor).toBeDefined()
    expect(floor).toContain(b)
    expect(floor).toContain(e)
    expect(watertight(rings)).toBe(true)
  })

  it('a straight rim point every face drops is gone (the knob\'s flat side strips are four-cornered)', () => {
    const t = tessellateForm(knobCage(), 0.05)
    const rings = faceRings(t.positions, t.indices)
    expect(watertight(rings)).toBe(true)
    const P = t.positions
    const straight = (r: number[], i: number) => {
      const [p, q, s] = [r[(i + r.length - 1) % r.length], r[i], r[(i + 1) % r.length]]
      const u = [0, 1, 2].map((k) => P[q * 3 + k] - P[p * 3 + k]), w = [0, 1, 2].map((k) => P[s * 3 + k] - P[p * 3 + k])
      return Math.hypot(u[1] * w[2] - u[2] * w[1], u[2] * w[0] - u[0] * w[2], u[0] * w[1] - u[1] * w[0]) < 1e-9
    }
    expect(rings.filter((r) => r.some((_, i) => straight(r, i)))).toEqual([])
    // the vertical strips above the creased bottom are four-cornered faces
    expect(rings.filter((r) => r.length === 4 && r.some((p) => P[p * 3 + 2] === 0)).length).toBeGreaterThan(0)
  })
})

describe('form feature -> kernel solid (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 120_000)
  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('a knob replays into a closed solid whose volume is the tessellation volume', async () => {
    const cage = knobCage()
    expect(validateCage(cage, true).ok).toBe(true)
    const faces = formFaceSet(makeFormFeaturePayload('Knob', cage, 0.05), 'FRM1')
    expect(faces.ok).toBe(true)
    if (!faces.ok) return
    // flat quads (the creased bottom) go as one face, curved quads as two triangles
    expect(faces.faceSet.faces.length).toBeLessThan(faces.tessellation.indices.length / 3)
    expect(faces.faceSet.faces.some((f) => f.outer.length === 4)).toBe(true)
    expect(faces.faceSet.faces.length).toBeLessThanOrEqual(FORM_BODY_MAX_TRIANGLES)
    const res = await engine.makeSolidFromPlanarFaces(faces.faceSet)
    expect(res.diagnostics.filter((d) => d.severity === 'error')).toEqual([])
    expect(res.ok).toBe(true)
    expect(res.body).toBeDefined()
    const vol = await engine.measure(res.body!, 'volume') as { value: number }
    const expected = meshVolume(faces.tessellation.positions, faces.tessellation.indices)
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(1e-6)
    // face ids are rooted at the feature id (convert-id grammar)
    expect(res.elementMap?.generated.length).toBe(faces.faceSet.faces.length)
    expect(res.elementMap?.generated.every((id) => /^FRM1:face#\d+$/.test(id))).toBe(true)
  }, 180_000)

  it('the flat creased bottom of a knob is ONE planar face of the solid (a Hole or a sketch lands on it)', async () => {
    const faces = formFaceSet(makeFormFeaturePayload('Knob', knobCage(), 0.05), 'FRM3')
    if (!faces.ok) throw new Error(faces.reason)
    const res = await engine.makeSolidFromPlanarFaces(faces.faceSet)
    expect(res.ok).toBe(true)
    const tess = await engine.tessellate(res.body!, DISPLAY_TESS_QUALITY)
    const onBottom = new Set<number>()
    for (let tri = 0; tri < tess.triFace.length; tri++) {
      const z = [0, 1, 2].map((k) => tess.position[tess.index[tri * 3 + k] * 3 + 2])
      if (z.every((v) => Math.abs(v) < 1e-9)) onBottom.add(tess.triFace[tri])
    }
    expect(onBottom.size).toBe(1)
    // and it is the disc under the knob: its area is the bottom's area
    const vol = await engine.measure(res.body!, 'volume') as { value: number }
    expect(vol.value).toBeCloseTo(meshVolume(faces.tessellation.positions, faces.tessellation.indices), 3)
  }, 180_000)

  it('the displayed edges of a form body are its crease, not its facets; other bodies keep every edge', async () => {
    const faces = formFaceSet(makeFormFeaturePayload('Knob', knobCage(), 0.1), 'FRM2')
    if (!faces.ok) throw new Error(faces.reason)
    const res = await engine.makeSolidFromPlanarFaces(faces.faceSet)
    expect(res.ok).toBe(true)
    const tess = await engine.tessellate(res.body!, DISPLAY_TESS_QUALITY)
    expect(tess.faceIds.every(isFormFacetId)).toBe(true)
    const shown = withoutSmoothFormFacetEdges(tess)
    const before = tess.edgeIds.length
    const after = shown.edgeIds.length
    expect(before).toBeGreaterThan(1000)
    expect(after).toBeGreaterThan(0)
    expect(after).toBeLessThan(before / 10)
    // what stays is the creased bottom rim: every kept edge lies on Z = 0
    for (let p = 2; p < shown.edgePositions.length; p += 3) expect(Math.abs(shown.edgePositions[p])).toBeLessThan(1e-3)
    expect(shown.edgeOffsets.length).toBe(shown.edgeIds.length + 1)

    const box = await engine.makeBox('BOX1', { x: 10, y: 10, z: 10 })
    const boxTess = await engine.tessellate(box.body!, DISPLAY_TESS_QUALITY)
    expect(withoutSmoothFormFacetEdges(boxTess)).toBe(boxTess)
  }, 180_000)
})
