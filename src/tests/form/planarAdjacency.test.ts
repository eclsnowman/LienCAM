// The face-walk edge adjacency (src/geom/worker/planarAdjacency.ts) gives the
// SAME edge -> face map as occt-wasm's edgeToFaceMap on a faceted (all-planar)
// solid, and steps aside for curved or small bodies. Real kernel.

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { OcctKernel } from 'occt-wasm'
import { parseEdgeToFaceMap, planarEdgeAdjacency, PLANAR_WALK_MIN_FACES } from '../../geom/worker/planarAdjacency'
import { creaseRimAt, cylinderCage } from '../../form/starters'
import { tessellateForm } from '../../form/finish'

const HM = 1 << 30

function asSorted(adj: { adjacentFaces: Map<number, Set<number>> }) {
  return {
    faces: [...adj.adjacentFaces.entries()].map(([e, s]) => [e, [...s].sort((a, b) => a - b)] as const).sort((a, b) => a[0] - b[0]),
  }
}

describe('planar edge adjacency (face walk)', () => {
  let k: OcctKernel
  beforeAll(async () => { k = await OcctKernel.init() }, 120_000)
  afterAll(() => { try { k[Symbol.dispose]() } catch { /* ignore */ } })

  it('matches the kernel edgeToFaceMap exactly on a faceted knob solid', () => {
    const t = tessellateForm(creaseRimAt(cylinderCage({ size: { x: 40, y: 40, z: 25 }, segments: { x: 8, y: 1, z: 2 } }), 0), 0.2)
    const P = t.positions
    const v = (i: number) => ({ x: P[i * 3], y: P[i * 3 + 1], z: P[i * 3 + 2] })
    const faces = []
    for (let i = 0; i < t.indices.length; i += 3) faces.push(k.buildTriFace(v(t.indices[i]), v(t.indices[i + 1]), v(t.indices[i + 2])))
    const solid = k.sewAndSolidify(faces, 1e-4)
    expect(faces.length).toBeGreaterThan(PLANAR_WALK_MIN_FACES)
    const walk = planarEdgeAdjacency(k, solid, HM)
    expect(walk).not.toBeNull()
    const kernel = parseEdgeToFaceMap(k.edgeToFaceMap(solid, HM))
    const a = asSorted(walk!), b = asSorted(kernel)
    // every edge joins the same faces
    expect(a.faces).toEqual(b.faces)
    // and classifies the same way where tessellate reads occurrences (a seam:
    // one face, listed twice). The kernel lists some two-face edges twice;
    // occurrences never matters for those, so only the classification is compared.
    const seam = (adj: typeof walk, e: number) => adj!.adjacentFaces.get(e)!.size === 1 && adj!.occurrences.get(e) === 2
    for (const [e] of a.faces) expect(seam(walk, e)).toBe(seam(kernel, e))
    // a closed faceted solid: every edge joins exactly two faces
    expect([...walk!.adjacentFaces.values()].every((s) => s.size === 2)).toBe(true)
  }, 180_000)

  it('steps aside (null) for a curved body and for a small planar one', () => {
    expect(planarEdgeAdjacency(k, k.makeCylinder(5, 10), HM)).toBeNull()
    expect(planarEdgeAdjacency(k, k.makeBox(10, 10, 10), HM)).toBeNull()
  })
})
