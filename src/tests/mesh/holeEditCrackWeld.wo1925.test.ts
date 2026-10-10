// WO-1925: a hole found across a mesh crack can be bored.
//
// WO-1889 taught recognition to weld hairline cracks (a seam column an exporter
// wrote twice, 1e-5 mm apart) before it looks for holes, so it LISTS the 6 mm
// through hole in cracked-through-hole.stl. The bore edit (WO-1850) handed the
// same part to the boolean kernel exactly as imported; the kernel welds by
// exact position only, saw the crack as an open edge and refused "Not
// manifold". Found, yet not editable. This order hands the kernel the part the
// way recognition saw it.
//
// Rule 6: every fixture is REAL STL BYTES off disk (WO-1889's generated files,
// src/tests/evidence/WO-1889/generate.mjs), parsed by the product's
// `resolveEditedStlMesh`; every bore is minted with `createMeshEditRecord` and
// applied by `replayMeshEdits` - the path every route resolves an STL through.

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'
import { analyzeMesh } from '../../mesh/analysis'
import {
  createMeshEditRecord,
  enlargeHole,
  enlargeHoleOperation,
  enlargeHoleRefusal,
  primeBoringKernel,
  replayMeshEdits,
  resolveEditedStlMesh,
  ENLARGE_HOLE_KIND,
} from '../../mesh/edit'
import { booleanMeshWithAncestry, sharedManifoldModule } from '../../mesh/manifoldOps'
import { recognizeMeshFeatures, type RecognizedFeature } from '../../mesh/recognition'
import { weldMesh } from '../../mesh/recognition/topology'
import type { MeshBuffers } from '../../mesh/types'

const DIR = 'src/tests/evidence/WO-1889'

function bytesOf(name: string): ArrayBuffer {
  const buf = readFileSync(`${DIR}/${name}`)
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
}

/** Re-index by EXACT coordinate (no number changes) so `analyzeMesh`'s edge
 *  map sees shared corners - an STL is a triangle soup. */
function welded(mesh: MeshBuffers): MeshBuffers {
  const w = weldMesh(mesh)
  return { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
}

function facetsOf(feature: RecognizedFeature, sourceFacetIds: Uint32Array): number[] {
  const wanted = new Set(feature.sourceFacetIds)
  const out: number[] = []
  sourceFacetIds.forEach((id, facet) => { if (wanted.has(id)) out.push(facet) })
  return out
}

function parametersFor(feature: RecognizedFeature, diameterMm: number): Record<string, unknown> {
  return {
    feature: feature.kind,
    fromDiameterMm: feature.diameterMm,
    diameterMm,
    axisOrigin: [...feature.axis.origin],
    axisDirection: [...feature.axis.direction],
  }
}

/** Recognise `kind` on the file, then bore it through the framework. */
function bore(name: string, kind: RecognizedFeature['kind'], diameterMm: number) {
  const resolved = resolveEditedStlMesh(bytesOf(name), undefined)
  const before = recognizeMeshFeatures(resolved.mesh, resolved.sourceFacetIds)
  const feature = before.features.find((f) => f.kind === kind)
  if (!feature) throw new Error(`${name} has no ${kind}; it has ${before.features.map((f) => f.kind).join(', ')}`)
  const facets = facetsOf(feature, resolved.sourceFacetIds)
  const parameters = parametersFor(feature, diameterMm)
  const refusal = enlargeHoleRefusal(resolved.mesh, facets, parameters)
  const record = createMeshEditRecord(resolved.mesh, {
    kind: ENLARGE_HOLE_KIND, facets, parameters, sourceFacetIds: resolved.sourceFacetIds,
  })
  const replayed = replayMeshEdits(resolved.mesh, [record])
  const direct = enlargeHole(resolved.mesh, facets, enlargeHoleOperation.validate(parameters))
  return { resolved, before, feature, facets, refusal, replayed, direct }
}

/** Every byte of what the edit produced: the mesh, the file-triangle ids each
 *  output facet descends from, and the full triangle + vertex ancestry. */
function fingerprint(result: ReturnType<typeof bore>): string {
  const hash = createHash('sha256')
  const { mesh, sourceFacetIds } = result.replayed
  hash.update(new Uint8Array(mesh.positions.buffer, mesh.positions.byteOffset, mesh.positions.byteLength))
  hash.update(new Uint8Array(mesh.indices.buffer, mesh.indices.byteOffset, mesh.indices.byteLength))
  hash.update(new Uint8Array(sourceFacetIds.buffer, sourceFacetIds.byteOffset, sourceFacetIds.byteLength))
  hash.update(JSON.stringify(result.direct.ancestry))
  return hash.digest('hex')
}

// Replay is synchronous; the wasm kernel is loaded once, up front.
beforeAll(async () => { await primeBoringKernel() }, 120_000)

describe('WO-1925: the crack-spanning 6 mm through hole is bored to 8 mm', () => {
  let bored: ReturnType<typeof bore>
  beforeAll(() => { bored = bore('cracked-through-hole.stl', 'through-hole', 8) })

  it('the fixture really is cracked: recognition found the hole only by welding two corners', () => {
    expect(bored.before.crackWeldsClosed).toBe(2)
    expect(bored.before.ambiguousCrackWelds).toBe(0)
    expect(bored.feature.diameterMm).toBeCloseTo(6, 2)
    // exact welding leaves it open - four open edges down the seam
    expect(analyzeMesh(welded(bored.resolved.mesh), { checkSelfIntersections: false }).watertight).toBe(false)
  })

  it('CONTROL: the kernel refuses the part exactly as imported - that is the refusal removed', () => {
    const module = sharedManifoldModule()!
    const cube: MeshBuffers = (() => {
      const c = [[0, 0, 0], [1, 0, 0], [1, 1, 0], [0, 1, 0], [0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]]
      const t = [0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7]
      return { positions: Float32Array.from(c.flat()), indices: Uint32Array.from(t) }
    })()
    expect(() => booleanMeshWithAncestry(module, bored.resolved.mesh, cube, { operation: 'difference' }))
      .toThrow(/not ?manifold/i)
  })

  it('the panel pre-check no longer refuses it', () => {
    expect(bored.refusal).toBeNull()
  })

  it('replay applies the bore, and the result is a closed, manifold, outward solid', () => {
    expect(bored.replayed.stopped).toBeUndefined()
    expect(bored.replayed.appliedCount).toBe(1)
    const health = analyzeMesh(welded(bored.replayed.mesh), { checkSelfIntersections: false })
    expect(health.watertight).toBe(true)
    expect(health.boundaryEdgeCount).toBe(0)
    expect(health.nonManifoldEdgeCount).toBe(0)
    expect(health.windingConflictEdgeCount).toBe(0)
  })

  it('recognition now finds an 8 mm through hole, 12 mm deep, on the same axis', () => {
    const after = recognizeMeshFeatures(bored.replayed.mesh, bored.replayed.sourceFacetIds)
    const holes = after.features.filter((f) => f.kind === 'through-hole')
    expect(holes).toHaveLength(1)
    expect(Math.abs(holes[0].diameterMm - 8)).toBeLessThanOrEqual(0.01)
    expect(holes[0].depthMm).toBeCloseTo(12, 3)
    expect(holes[0].axis.origin[0]).toBeCloseTo(bored.feature.axis.origin[0], 3)
    expect(holes[0].axis.origin[1]).toBeCloseTo(bored.feature.axis.origin[1], 3)
    // the bore cut through the crack, so the result has nothing left to weld
    expect(after.crackWeldsClosed).toBe(0)
  })

  it('ancestry still names the imported part: one entry per file facet and per file corner', () => {
    const { resolved, direct, replayed } = bored
    expect(direct.ancestry.triangles).toHaveLength(resolved.mesh.indices.length / 3)
    expect(direct.ancestry.vertices).toHaveLength(resolved.mesh.positions.length / 3)
    const outFacets = replayed.mesh.indices.length / 3
    for (const list of direct.ancestry.triangles) for (const out of list) expect(out).toBeLessThan(outFacets)
    // the part's own outer corners came through: every corner away from the
    // bore (radius > 4.5 mm about the axis) maps to at least one output vertex
    const [ox, oy] = bored.feature.axis.origin
    let farCorners = 0
    for (let v = 0; v < resolved.mesh.positions.length / 3; v++) {
      const r = Math.hypot(resolved.mesh.positions[v * 3] - ox, resolved.mesh.positions[v * 3 + 1] - oy)
      if (r < 4.5) continue
      farCorners++
      expect(direct.ancestry.vertices[v].length, `corner ${v}`).toBeGreaterThan(0)
    }
    expect(farCorners).toBeGreaterThan(0)
  })
})

// The fill-then-bore half runs the part through the kernel twice; both passes
// must take the crack-welded part. What recognition then reads back off a 4 mm
// bore in this 40 mm plate is WO-1850's business, not this order's: the
// crack-free plate refuses the same read-back today, byte for byte (see the
// worker result), so it is not asserted here.
describe('WO-1925: shrinking the crack-spanning hole (fill, then bore) is carried out', () => {
  it('bores 6 -> 4 mm: no refusal, applied, and the result is a closed solid', () => {
    const bored = bore('cracked-through-hole.stl', 'through-hole', 4)
    expect(bored.refusal).toBeNull()
    expect(bored.replayed.stopped).toBeUndefined()
    expect(bored.replayed.appliedCount).toBe(1)
    const health = analyzeMesh(welded(bored.replayed.mesh), { checkSelfIntersections: false })
    expect(health.watertight).toBe(true)
    expect(health.nonManifoldEdgeCount).toBe(0)
    expect(health.degenerateTriangleCount).toBe(0)
  })
})

describe('WO-1925: an AMBIGUOUS crack is still refused, by name', () => {
  it('three copies of one corner are not guessed shut, and the bore says why it was not cut', () => {
    // The same 6 mm hole as the clean crack, but recognition cannot find it
    // (WO-1889 2b), so aim with the clean fixture's own axis and pick the bore
    // wall facets geometrically.
    const aim = bore('cracked-through-hole.stl', 'through-hole', 8).feature
    const mesh = resolveEditedStlMesh(bytesOf('ambiguous-crack-hole.stl'), undefined).mesh
    const [ox, oy] = aim.axis.origin
    const facets: number[] = []
    for (let f = 0; f < mesh.indices.length / 3; f++) {
      let r = 0
      for (let c = 0; c < 3; c++) {
        const v = mesh.indices[f * 3 + c] * 3
        r = Math.max(r, Math.hypot(mesh.positions[v] - ox, mesh.positions[v + 1] - oy))
      }
      if (r < 3.01) facets.push(f)
    }
    expect(facets.length).toBeGreaterThan(0)
    const refusal = enlargeHoleRefusal(mesh, facets, parametersFor(aim, 8))
    expect(refusal).toMatch(/not a closed solid/)
    expect(refusal).toMatch(/could not weld shut/)
    expect(refusal).toMatch(/Nothing was changed/)
  })
})

// NEGATIVE CONTROL. On a mesh with no crack the edit must be byte-identical to
// what the exact-weld path produced before this order. The pins below were
// taken from main's enlargeHole.ts (commit e7e9ba5d8, before WO-1925) with this
// same `fingerprint`, by checking that file out in this worktree and running
// this file; see the WO's worker result for the command.
describe('WO-1925 NEGATIVE CONTROL: a crack-free part edits byte for byte as before', () => {
  it('the crack-free plate has nothing for the crack weld to close', () => {
    const mesh = resolveEditedStlMesh(bytesOf('plain-plate.stl'), undefined).mesh
    expect(weldMesh(mesh, 0.001).crackWelds).toBe(0)
  })

  it('boring its 6 mm through hole to 8 mm is unchanged', () => {
    const bored = bore('plain-plate.stl', 'through-hole', 8)
    expect(bored.replayed.stopped).toBeUndefined()
    expect(fingerprint(bored)).toBe(PIN_GROW)
  })

  it('filling-and-boring it to 4 mm is unchanged', () => {
    const bored = bore('plain-plate.stl', 'through-hole', 4)
    expect(bored.replayed.stopped).toBeUndefined()
    expect(fingerprint(bored)).toBe(PIN_SHRINK)
  })

  it('boring its countersink to 8 mm is unchanged', () => {
    const bored = bore('plain-plate.stl', 'countersink', 8)
    expect(bored.replayed.stopped).toBeUndefined()
    expect(fingerprint(bored)).toBe(PIN_COUNTERSINK)
  })
})

const PIN_GROW = '136aceadadc794cf11053ba44edef324f9d5ad9d4420eda047cac3cd0baff96e'
const PIN_SHRINK = 'bf767c907eeaf931753d43636474c671bf514ae3758ec38d99e0e61714f7d39c'
const PIN_COUNTERSINK = '9900b1a92cfe32fc96a2a72381ca2b76d673356a1fefcde68240680a1cf8e4ff'
