// Form: face packing on convert - neighbouring first-level quads written as one
// B-spline face wherever their join is C1, the same surface in fewer faces.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { edgeKey, type Cage } from '../../form/cage'
import { setCreased } from '../../form/edgeLoop'
import { boxCage, creaseRimAt, cylinderCage, sphereCage, torusCage } from '../../form/starters'
import { formStep } from '../../form/exactStep'
import { GeomEngine } from '../../geom/worker/geom-engine'

const knob = () => creaseRimAt(cylinderCage({ size: { x: 40, y: 40, z: 25 }, segments: { x: 8, y: 1, z: 2 } }), 0)
const box = () => boxCage({ segments: { x: 2, y: 2, z: 2 } })
const bytes = (text: string) => new TextEncoder().encode(text).buffer as ArrayBuffer

/** per face of a STEP file, the edge curves its loop runs along */
function faceEdges(text: string): string[][] {
  const body = new Map<string, string>()
  for (const m of text.matchAll(/^(#\d+)=(.*);$/gm)) body.set(m[1], m[2])
  const refs = (text: string) => [...text.matchAll(/#\d+/g)].map((r) => r[0])
  const of = (e: string) => refs(body.get(e) ?? '')
  const out: string[][] = []
  for (const [, b] of body) {
    if (!b.startsWith('ADVANCED_FACE')) continue
    // ADVANCED_FACE -> FACE_OUTER_BOUND -> EDGE_LOOP -> ORIENTED_EDGEs -> EDGE_CURVE
    const loop = of(refs(b)[0])[0]
    out.push(of(loop).map((oe) => of(oe)[0]))
  }
  return out
}

describe('face packing', () => {
  // name, cage, curved faces unpacked, packed (at most), edges packed (at most)
  const CASES: Array<[string, () => Cage, number, number, number]> = [
    // one face per side of the cube-like cage: the 8 valence-3 corners bound them
    ['the sphere starter', () => sphereCage(), 96, 6, 12],
    ['a 2 x 2 x 2 box', box, 96, 6, 12],
    // every point ordinary: only a face must not meet itself, so a few faces
    ['the torus', () => torusCage(), 128, 4, 8],
    // (44 edges before stage 46: the G1 pass no longer nudges the rim's already-smooth joins, so the greedy packs
    // fall one edge differently - the same 18 faces, the same G1 angle)
    ['the knob (valence-8 cap centre, creased rim)', knob, 72, 18, 45],
  ]
  for (const [name, make, unpacked, packed, edges] of CASES) {
    it(`${name}: ${unpacked} quad faces pack into ${packed}, the dropped join poles within 1e-9 mm of where C1 puts them`, () => {
      const plain = formStep(make(), 'P', 3, false)
      const s = formStep(make(), 'F', 3)
      expect(plain.bsplineFaces).toBe(unpacked)
      expect(s.bsplineFaces).toBeLessThanOrEqual(packed)
      expect(s.planarFaces).toBe(plain.planarFaces)
      expect(s.edges).toBeLessThanOrEqual(edges)
      expect(s.edges).toBeLessThan(plain.edges)
      expect(s.packJoinMm).toBeLessThan(1e-9)
      // Euler: a closed solid of genus g has V - E + F = 2 - 2g
      const vertices = (s.text.match(/VERTEX_POINT/g) ?? []).length
      const genus = name.startsWith('the torus') ? 1 : 0
      expect(vertices - s.edges + s.bsplineFaces + s.planarFaces).toBe(2 - 2 * genus)
      // no face meets itself (a pack wrapped round a ring would run a seam edge twice); every edge borders two faces
      const faces = faceEdges(s.text)
      expect(faces).toHaveLength(s.bsplineFaces + s.planarFaces)
      const uses = new Map<string, number>()
      for (const f of faces) {
        expect(new Set(f).size).toBe(f.length)
        for (const e of f) uses.set(e, (uses.get(e) ?? 0) + 1)
      }
      expect(uses.size).toBe(s.edges)
      expect([...uses.values()].every((k) => k === 2)).toBe(true)
    })
  }

  it('a crease stays a face boundary: a box with one creased edge keeps that edge between two faces', () => {
    const c = boxCage()
    const creased = setCreased(c, [edgeKey(c.faces[0][0], c.faces[0][1])], true)
    expect(formStep(creased, 'C', 3).bsplineFaces).toBeGreaterThan(formStep(c, 'P', 3).bsplineFaces)
  })

  it('joins at an extraordinary point stay face boundaries: a 5-sided cylinder packs round its valence-5 cap centres, not across them', () => {
    const s = formStep(cylinderCage({ segments: { x: 5, y: 1, z: 2 } }), 'F', 3)
    // each cap has 5 corners at its centre: at least 5 faces meet there
    expect(s.bsplineFaces).toBeGreaterThanOrEqual(10)
    expect(s.bsplineFaces).toBeLessThan(formStep(cylinderCage({ segments: { x: 5, y: 1, z: 2 } }), 'P', 3, false).bsplineFaces)
  })
})

describe('the packed solid in the kernel (real occt-wasm)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })

  const SOLIDS: Array<[string, () => Cage]> = [['the sphere starter', () => sphereCage()], ['the torus', () => torusCage()], ['the knob', knob], ['a 5-sided cylinder', () => cylinderCage({ segments: { x: 5, y: 1, z: 2 } })]]
  for (const [name, make] of SOLIDS) {
    it(`${name}: ONE solid with the packed face count, the same volume and area as unpacked`, async () => {
      const packed = formStep(make(), 'F', 3)
      const plain = formStep(make(), 'F', 3, false)
      const a = await engine.importStep(bytes(packed.text), 'FRM1')
      const b = await engine.importStep(bytes(plain.text), 'FRM2')
      expect(a.bodies).toHaveLength(1)
      expect(a.bodies[0].elementMap.generated).toHaveLength(packed.bsplineFaces + packed.planarFaces)
      // the surface is the same to 1e-9 mm (the pole test above); what differs is the kernel's
      // integration over other faces: measured, 1.2e-5 at most (torus), while each file's volume is
      // up to 1.25e-4 off a 0.001 mm tessellation of the limit surface
      for (const q of ['volume', 'area'] as const) {
        const va = (await engine.measure(a.bodies[0].handle, q)).value
        const vb = (await engine.measure(b.bodies[0].handle, q)).value
        expect(Math.abs(va - vb) / vb).toBeLessThan(3e-5)
      }
    }, 180_000)
  }
})
