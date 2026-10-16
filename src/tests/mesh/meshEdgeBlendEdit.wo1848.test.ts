// WO-1848: LienCAM takes a fillet or a chamfer off an edge, or gives the
// fillet a different radius.
//
// Rule 6: nothing here hand-builds a MeshBuffers and hands it to an engine.
// Every fixture is written as REAL binary STL bytes the way a slicer would and
// parsed back through `importStl`; every edit is minted with the framework's
// own `createMeshEditRecord` and applied by `replayMeshEdits` - the registry
// path WO-1845 built and the one `resolveEditedStlMesh` runs on every route.
// The toolpath case runs the product's `acquirePartMesh` +
// `computeParallel3dMoves` against a real BvhKernel.
//
// ON WELDING, said once (same as WO-1847's file): an STL is a triangle soup and
// `analyzeMesh` builds its topology from VERTEX INDICES, so the fixture as
// imported is "not watertight" too. `welded()` re-indexes by exact coordinate
// and changes not one number; the watertight/winding assertions run on that,
// before AND after, so the comparison is like for like.

import { describe, expect, it } from 'vitest'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import { exportBinaryStl, importStl } from '../../mesh/stl'
import {
  createMeshEditRecord,
  replayMeshEdits,
  resolveEditedStlMesh,
  restoreSharpEdge,
  sharpEdgeRestorationRefusal,
  blendRadiusChangeRefusal,
  RESTORE_SHARP_EDGE_KIND,
  CHANGE_BLEND_RADIUS_KIND,
  type MeshEditRecord,
} from '../../mesh/edit'
import { recognizeEdgeBlends, describeEdgeBlend, type RecognizedEdgeBlend } from '../../mesh/recognition'
import { weldMesh } from '../../mesh/recognition/topology'
import type { MeshBuffers, Vec3 } from '../../mesh/types'
import {
  acquirePartMesh,
  computeParallel3dMoves,
  xyBoundsRing,
  DEFAULT_PARALLEL3D_PARAMS,
} from '../../cam3d/integration/parallel3dOperation'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { ToolpathMove } from '../../types'
import { makeTool } from '../post/helpers'

// ---------------------------------------------------------------- fixtures

class Soup {
  private readonly coords: number[] = []
  tri(a: Vec3, b: Vec3, c: Vec3): void { this.coords.push(...a, ...b, ...c) }
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void { this.tri(a, b, c); this.tri(a, c, d) }
  mesh(): MeshBuffers {
    const positions = Float32Array.from(this.coords)
    const indices = new Uint32Array(positions.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    return { positions, indices }
  }
  bytes(): ArrayBuffer { return exportBinaryStl(this.mesh()).bytes }
}

const WIDTH = 60
const LENGTH = 40
const HEIGHT = 20
const FILLET_R = 3
const CHAMFER = 2
/** chords across the quarter round - a coarse CAD export, not a fine one */
const ARC = 8
/** where the prism is divided along its length, so the rails have interior
 *  corners of their own and the retarget has something to project */
const YS = [0, 10, 20, 30, 40]

/**
 * The block's cross-section in the x-z plane, counter-clockwise with the
 * material inside: 60 x 20, a 3 mm fillet on the x=60 / z=20 edge and a
 * 2 mm x 45 degree chamfer on the x=0 / z=20 edge. Every coordinate that
 * matters is exact in float32 - the theoretical sharp edges are x=60, z=20
 * and x=0, z=20 - so "the faces meet on the edge line" is a real assertion
 * and not a tolerance.
 */
function profile(): Array<[number, number]> {
  const out: Array<[number, number]> = [[0, 0], [WIDTH, 0], [WIDTH, HEIGHT - FILLET_R]]
  for (let k = 1; k <= ARC; k++) {
    const t = (Math.PI / 2) * (k / ARC)
    out.push([
      WIDTH - FILLET_R + FILLET_R * Math.cos(t),
      HEIGHT - FILLET_R + FILLET_R * Math.sin(t),
    ])
  }
  out.push([CHAMFER, HEIGHT])
  out.push([0, HEIGHT - CHAMFER])
  return out
}

function blockBytes(): ArrayBuffer {
  const soup = new Soup()
  const p = profile()
  for (let i = 0; i < p.length; i++) {
    const a = p[i]
    const b = p[(i + 1) % p.length]
    for (let j = 0; j + 1 < YS.length; j++) {
      soup.quad(
        [a[0], YS[j], a[1]], [a[0], YS[j + 1], a[1]],
        [b[0], YS[j + 1], b[1]], [b[0], YS[j], b[1]],
      )
    }
  }
  for (let i = 1; i + 1 < p.length; i++) {
    soup.tri([p[0][0], 0, p[0][1]], [p[i][0], 0, p[i][1]], [p[i + 1][0], 0, p[i + 1][1]])
    soup.tri([p[0][0], LENGTH, p[0][1]], [p[i + 1][0], LENGTH, p[i + 1][1]], [p[i][0], LENGTH, p[i][1]])
  }
  return soup.bytes()
}

const ring = (r: number, z: number, n: number): Vec3[] =>
  Array.from({ length: n }, (_, k) => {
    const t = (2 * Math.PI * k) / n
    return [r * Math.cos(t), r * Math.sin(t), z] as Vec3
  })

function wall(soup: Soup, lower: Vec3[], upper: Vec3[]): void {
  for (let k = 0; k < lower.length; k++) {
    const j = (k + 1) % lower.length
    soup.tri(lower[k], lower[j], upper[j])
    soup.tri(lower[k], upper[j], upper[k])
  }
}

function disk(soup: Soup, loop: Vec3[], centre: Vec3, up: boolean): void {
  for (let k = 0; k < loop.length; k++) {
    const j = (k + 1) % loop.length
    if (up) soup.tri(centre, loop[k], loop[j])
    else soup.tri(centre, loop[j], loop[k])
  }
}

const DISC_N = 48
const DISC_R = 20
const DISC_H = 20

/** A round bar 40 mm across and 20 mm tall with a 3 mm fillet where its flat
 *  top meets its ROUND side. The blend runs between a flat face and a curved
 *  one, which is the case this order's method cannot place an edge line for. */
function filletedDiscBytes(): ArrayBuffer {
  const soup = new Soup()
  const bottom = ring(DISC_R, 0, DISC_N)
  const sideTop = ring(DISC_R, DISC_H - FILLET_R, DISC_N)
  disk(soup, bottom, [0, 0, 0], false)
  wall(soup, bottom, sideTop)
  let previous = sideTop
  for (let k = 1; k <= ARC; k++) {
    const t = (Math.PI / 2) * (k / ARC)
    const next = ring(
      DISC_R - FILLET_R + FILLET_R * Math.cos(t),
      DISC_H - FILLET_R + FILLET_R * Math.sin(t),
      DISC_N,
    )
    wall(soup, previous, next)
    previous = next
  }
  disk(soup, previous, [0, 0, DISC_H], true)
  return soup.bytes()
}

/** The disc's torus band, by construction order: bottom fan, side wall, then
 *  one wall per chord, then the top fan. */
const DISC_BAND = Array.from({ length: ARC * 2 * DISC_N }, (_, i) => DISC_N + 2 * DISC_N + i)

// ------------------------------------------------------------------ helpers

function welded(mesh: MeshBuffers): MeshBuffers {
  const w = weldMesh(mesh)
  return { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
}

const health = (mesh: MeshBuffers) => analyzeMesh(welded(mesh), { checkSelfIntersections: false })

/** Area of a closed 2D ring, shoelace. The corner a blend took off is read off
 *  the fixture's OWN points, so the expected volume is the tessellated truth
 *  and not an ideal-cylinder approximation of it. */
function shoelace(points: ReadonlyArray<[number, number]>): number {
  let twice = 0
  for (let i = 0; i < points.length; i++) {
    const p = points[i]
    const q = points[(i + 1) % points.length]
    twice += p[0] * q[1] - q[0] * p[1]
  }
  return Math.abs(twice) / 2
}

const P = profile()
/** the material a sharp corner has and the 3 mm fillet does not */
const FILLET_CORNER_MM2 = shoelace([P[2], ...P.slice(3, 3 + ARC), [WIDTH, HEIGHT]])
/** the same for the 2 mm chamfer: a right triangle with 2 mm legs */
const CHAMFER_CORNER_MM2 = shoelace([P[P.length - 2], P[P.length - 1], [0, HEIGHT]])

/** The current-mesh facet indices a recognised blend's source ids name. */
function facetsOf(blend: RecognizedEdgeBlend, sourceFacetIds: Uint32Array): number[] {
  const wanted = new Set(blend.sourceFacetIds)
  const out: number[] = []
  sourceFacetIds.forEach((id, facet) => { if (wanted.has(id)) out.push(facet) })
  return out
}

/** Every distinct vertex of a mesh, as coordinates. */
function vertices(mesh: MeshBuffers): Vec3[] {
  const seen = new Map<string, Vec3>()
  for (let i = 0; i < mesh.positions.length; i += 3) {
    const p: Vec3 = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]
    seen.set(`${p[0]},${p[1]},${p[2]}`, p)
  }
  return [...seen.values()]
}

/** Distance from a point to the line through `origin` along unit `direction`. */
function toLine(p: Vec3, origin: Vec3, direction: Vec3): number {
  const d: Vec3 = [p[0] - origin[0], p[1] - origin[1], p[2] - origin[2]]
  const s = d[0] * direction[0] + d[1] * direction[1] + d[2] * direction[2]
  return Math.hypot(d[0] - s * direction[0], d[1] - s * direction[1], d[2] - s * direction[2])
}

interface Edit {
  record: MeshEditRecord
  before: ReturnType<typeof recognizeEdgeBlends>
  after: ReturnType<typeof recognizeEdgeBlends>
  blend: RecognizedEdgeBlend
  sourceMesh: MeshBuffers
  mesh: MeshBuffers
  facets: number[]
}

/** One edit on one recognised blend, through the framework end to end. */
function applyToBlend(
  bytes: ArrayBuffer,
  kind: RecognizedEdgeBlend['kind'],
  edit: { kind: string; parameters: (blend: RecognizedEdgeBlend) => Record<string, unknown> },
): Edit {
  const resolved = resolveEditedStlMesh(bytes, undefined)
  const before = recognizeEdgeBlends(resolved.mesh, resolved.sourceFacetIds)
  const blend = before.blends.find((b) => b.kind === kind)
  if (!blend) {
    throw new Error(`the fixture proves no ${kind}; it proves ${before.blends.map(describeEdgeBlend).join(' / ') || 'nothing'}`)
  }
  const facets = facetsOf(blend, resolved.sourceFacetIds)
  const record = createMeshEditRecord(resolved.mesh, {
    kind: edit.kind,
    facets,
    parameters: edit.parameters(blend),
    sourceFacetIds: resolved.sourceFacetIds,
  })
  const replayed = replayMeshEdits(resolved.mesh, [record])
  expect(replayed.stopped).toBeUndefined()
  expect(replayed.appliedCount).toBe(1)
  return {
    record, before, blend, facets,
    after: recognizeEdgeBlends(replayed.mesh, replayed.sourceFacetIds),
    sourceMesh: resolved.mesh, mesh: replayed.mesh,
  }
}

const removal = (kind: RecognizedEdgeBlend['kind']): Edit =>
  applyToBlend(blockBytes(), kind, {
    kind: RESTORE_SHARP_EDGE_KIND,
    parameters: (blend) => ({
      blend: blend.kind,
      sizeMm: blend.kind === 'fillet' ? blend.radiusMm : (blend.setbackMm ?? [0])[0],
    }),
  })

// -------------------------------------------------------------------- tests

describe('WO-1848: the block proves one fillet and one chamfer', () => {
  const bytes = blockBytes()
  const mesh = importStl(bytes).mesh
  const found = recognizeEdgeBlends(mesh)

  it('the fixture itself is closed, manifold and wound outward', () => {
    const report = health(mesh)
    expect(report.watertight).toBe(true)
    expect(report.nonManifoldEdgeCount).toBe(0)
    expect(report.windingConflictEdgeCount).toBe(0)
    expect(measureMesh(welded(mesh)).signedVolume).toBeGreaterThan(0)
  })

  it('exactly two blends, and nothing else on a block full of flat faces', () => {
    expect(found.blends.map((b) => b.kind).sort()).toEqual(['chamfer', 'fillet'])
  })

  it('the fillet is measured, not guessed', () => {
    const fillet = found.blends.find((b) => b.kind === 'fillet') as RecognizedEdgeBlend
    expect(fillet.radiusMm).toBeCloseTo(FILLET_R, 5)
    expect(fillet.shape).toBe('convex')
    expect(fillet.lengthMm).toBeCloseTo(LENGTH, 6)
    expect(fillet.includedAngleDeg).toBeCloseTo(90, 6)
    // the chord error of an 8-chord quarter round of radius 3
    expect(fillet.maxDeviationMm).toBeLessThan(0.02)
    expect(fillet.tangencyErrorMm).toBeLessThan(1e-4)
    expect(fillet.sourceFacetIds.length).toBe(ARC * (YS.length - 1) * 2)
    expect(describeEdgeBlend(fillet)).toMatch(/3\.00 mm fillet, 40\.00 mm long/)
  })

  it('the chamfer is measured too, in the words Operator uses for one', () => {
    const chamfer = found.blends.find((b) => b.kind === 'chamfer') as RecognizedEdgeBlend
    expect(chamfer.setbackMm?.[0]).toBeCloseTo(CHAMFER, 5)
    expect(chamfer.setbackMm?.[1]).toBeCloseTo(CHAMFER, 5)
    expect(chamfer.angleDeg).toBeCloseTo(45, 4)
    expect(chamfer.lengthMm).toBeCloseTo(LENGTH, 6)
    expect(describeEdgeBlend(chamfer)).toMatch(/2\.00 mm x 45 deg chamfer, 40\.00 mm long/)
  })

  it('the sharp edges it would restore are the block\'s own theoretical edges', () => {
    const fillet = found.blends.find((b) => b.kind === 'fillet') as RecognizedEdgeBlend
    for (const end of fillet.edgeLine.ends) {
      expect(end[0]).toBeCloseTo(WIDTH, 9)
      expect(end[2]).toBeCloseTo(HEIGHT, 9)
    }
    const chamfer = found.blends.find((b) => b.kind === 'chamfer') as RecognizedEdgeBlend
    for (const end of chamfer.edgeLine.ends) {
      expect(end[0]).toBeCloseTo(0, 9)
      expect(end[2]).toBeCloseTo(HEIGHT, 9)
    }
  })
})

describe('WO-1848: removing the fillet brings the sharp edge back', () => {
  const edit = removal('fillet')

  it('the part is still closed, manifold, one shell and wound outward', () => {
    const report = health(edit.mesh)
    expect(report.watertight).toBe(true)
    expect(report.boundaryEdgeCount).toBe(0)
    expect(report.nonManifoldEdgeCount).toBe(0)
    expect(report.windingConflictEdgeCount).toBe(0)
    expect(report.degenerateTriangleCount).toBe(0)
    const measures = measureMesh(welded(edit.mesh))
    expect(measures.signedVolume).toBeGreaterThan(0)
    expect(measures.componentCount).toBe(1)
  })

  it('the two faces now meet ON the theoretical edge line, within 1e-6 mm', () => {
    const { origin, direction } = edit.blend.edgeLine
    const corner = vertices(edit.mesh).filter(
      (p) => p[0] > WIDTH - FILLET_R - 1e-9 && p[2] > HEIGHT - FILLET_R - 1e-9,
    )
    expect(corner.length).toBe(YS.length)
    let worst = 0
    for (const p of corner) worst = Math.max(worst, toLine(p, origin, direction))
    expect(worst).toBeLessThanOrEqual(1e-6)
    // and they are the stations the two rails had, so nothing was invented
    expect(corner.map((p) => p[1]).sort((a, b) => a - b)).toEqual(YS)
  })

  it('the part gains exactly the corner the fillet took off', () => {
    const before = measureMesh(welded(edit.sourceMesh)).volume
    const after = measureMesh(welded(edit.mesh)).volume
    // 3 places, not more: an STL stores float32 coordinates, so a 79 mm^3
    // corner carries about 1e-6 of relative rounding through the measure.
    expect(after - before).toBeCloseTo(FILLET_CORNER_MM2 * LENGTH, 3)
  })

  it('that blend is gone and the chamfer is untouched', () => {
    expect(edit.after.blends.map((b) => b.kind)).toEqual(['chamfer'])
    const was = edit.before.blends.find((b) => b.kind === 'chamfer') as RecognizedEdgeBlend
    const now = edit.after.blends[0]
    expect(now.setbackMm?.[0]).toBeCloseTo(was.setbackMm?.[0] as number, 9)
    expect(now.lengthMm).toBeCloseTo(was.lengthMm, 9)
  })

  it('reads in plain words', () => {
    expect(edit.record.kind).toBe(RESTORE_SHARP_EDGE_KIND)
    expect(edit.record.parameters).toEqual({ blend: 'fillet', sizeMm: edit.blend.radiusMm })
  })

  it('NEGATIVE CONTROL: skip the vertex retarget and the edge line is not reached', () => {
    const stripped = restoreSharpEdge(edit.sourceMesh, edit.facets, { retargetVertices: false })
    const { origin, direction } = edit.blend.edgeLine
    const corner = vertices(stripped.mesh).filter(
      (p) => p[0] > WIDTH - FILLET_R - 1e-9 && p[2] > HEIGHT - FILLET_R - 1e-9,
    )
    let worst = 0
    for (const p of corner) worst = Math.max(worst, toLine(p, origin, direction))
    expect(worst).toBeGreaterThan(1e-6)
    // and the part is open where the blend was, which is the other half of it
    expect(health(stripped.mesh).watertight).toBe(false)
  })
})

describe('WO-1848: removing the chamfer brings its sharp edge back too', () => {
  const edit = removal('chamfer')

  it('closed, manifold, one shell, wound outward', () => {
    const report = health(edit.mesh)
    expect(report.watertight).toBe(true)
    expect(report.nonManifoldEdgeCount).toBe(0)
    expect(report.windingConflictEdgeCount).toBe(0)
    const measures = measureMesh(welded(edit.mesh))
    expect(measures.signedVolume).toBeGreaterThan(0)
    expect(measures.componentCount).toBe(1)
  })

  it('the faces meet on the x=0, z=20 edge within 1e-6 mm', () => {
    const { origin, direction } = edit.blend.edgeLine
    const corner = vertices(edit.mesh).filter((p) => p[0] < CHAMFER + 1e-9 && p[2] > HEIGHT - CHAMFER - 1e-9)
    expect(corner.length).toBe(YS.length)
    for (const p of corner) expect(toLine(p, origin, direction)).toBeLessThanOrEqual(1e-6)
  })

  it('the part gains exactly the corner the chamfer took off', () => {
    const before = measureMesh(welded(edit.sourceMesh)).volume
    const after = measureMesh(welded(edit.mesh)).volume
    expect(after - before).toBeCloseTo(CHAMFER_CORNER_MM2 * LENGTH, 4)
    expect(CHAMFER_CORNER_MM2).toBeCloseTo(2, 9)
  })

  it('the fillet is untouched', () => {
    expect(edit.after.blends.map((b) => b.kind)).toEqual(['fillet'])
    // the fit is float64 over the file's float32 coordinates, and it is
    // anchored on whichever vertex comes first, so 4 places is the truth here
    expect(edit.after.blends[0].radiusMm).toBeCloseTo(FILLET_R, 4)
  })
})

describe('WO-1848: the fillet becomes a 5 mm fillet', () => {
  const NEW_R = 5
  const edit = applyToBlend(blockBytes(), 'fillet', {
    kind: CHANGE_BLEND_RADIUS_KIND,
    parameters: (blend) => ({ radiusMm: NEW_R, fromRadiusMm: blend.radiusMm }),
  })

  it('closed, manifold, one shell, wound outward', () => {
    const report = health(edit.mesh)
    expect(report.watertight).toBe(true)
    expect(report.nonManifoldEdgeCount).toBe(0)
    expect(report.windingConflictEdgeCount).toBe(0)
    const measures = measureMesh(welded(edit.mesh))
    expect(measures.signedVolume).toBeGreaterThan(0)
    expect(measures.componentCount).toBe(1)
  })

  it('its facets now lie on a 5 mm round tangent to both faces', () => {
    const now = edit.after.blends.find((b) => b.kind === 'fillet') as RecognizedEdgeBlend
    expect(now.radiusMm).toBeCloseTo(NEW_R, 4)
    // the same whole-facet proof WO-1846's surfaces.ts applies to a bore: no
    // facet leaves the band of the fitted cylinder anywhere on its area, and
    // the fitted axis sits exactly one radius off each face.
    expect(now.maxDeviationMm).toBeLessThan(0.04)
    expect(now.tangencyErrorMm).toBeLessThan(1e-4)
    expect(now.shape).toBe('convex')
    expect(now.lengthMm).toBeCloseTo(LENGTH, 6)
  })

  it('the tangent lines moved and nothing else did', () => {
    // the round now starts at x = 55 on the top face and z = 15 on the wall
    const xs = vertices(edit.mesh).filter((p) => Math.abs(p[2] - HEIGHT) < 1e-6).map((p) => p[0])
    expect(Math.max(...xs)).toBeCloseTo(WIDTH - NEW_R, 4)
    const zs = vertices(edit.mesh).filter((p) => Math.abs(p[0] - WIDTH) < 1e-6).map((p) => p[2])
    expect(Math.max(...zs)).toBeCloseTo(HEIGHT - NEW_R, 4)
    // the chamfer at the other end of the same top face is exactly as it was
    const chamfer = edit.after.blends.find((b) => b.kind === 'chamfer') as RecognizedEdgeBlend
    expect(chamfer.setbackMm?.[0]).toBeCloseTo(CHAMFER, 5)
  })

  it('a bigger round takes more material off', () => {
    const before = measureMesh(welded(edit.sourceMesh)).volume
    const after = measureMesh(welded(edit.mesh)).volume
    expect(after).toBeLessThan(before)
    // scaling a corner cut about the sharp edge scales its area by k^2
    const k = NEW_R / FILLET_R
    expect(before - after).toBeCloseTo(FILLET_CORNER_MM2 * (k * k - 1) * LENGTH, 3)
  })

  it('reads in plain words', () => {
    expect(edit.record.kind).toBe(CHANGE_BLEND_RADIUS_KIND)
    expect(edit.record.parameters).toEqual({ radiusMm: NEW_R, fromRadiusMm: edit.blend.radiusMm })
  })

  it('a round too big for the face beside it says so, and changes nothing', () => {
    const resolved = resolveEditedStlMesh(blockBytes(), undefined)
    const blend = recognizeEdgeBlends(resolved.mesh, resolved.sourceFacetIds).blends
      .find((b) => b.kind === 'fillet') as RecognizedEdgeBlend
    const facets = facetsOf(blend, resolved.sourceFacetIds)
    // the wall below it is only 17 mm tall
    const refusal = blendRadiusChangeRefusal(resolved.mesh, facets, 30)
    expect(refusal).not.toBeNull()
    expect(refusal as string).toMatch(/only .* mm wide there/)
    expect(refusal as string).toMatch(/Nothing was changed/)
    expect(refusal as string).not.toMatch(/re-?export|re-?model|simplif|different file/i)
    expect(blendRadiusChangeRefusal(resolved.mesh, facets, NEW_R)).toBeNull()
  })
})

describe('WO-1848: a blend between a flat face and a round one', () => {
  // WO-1848 architect audit item 4 pinned a refusal here: this order's method
  // places the sharp edge where two PLANES meet, and a round bar's top edge
  // has no second plane. WO-2798 reads a fillet between a flat face and a
  // wall standing square to it whatever shape the wall runs round (the boss
  // foot, SFI-1/SDF-3), so LienCAM can do this edit now and does it
  // (LIENCAM.md rule 11).
  const bytes = filletedDiscBytes()
  const mesh = importStl(bytes).mesh
  /** the sharp-edged bar: a 48-gon prism, read off the fixture's own ring */
  const SHARP_PRISM_MM3 = 0.5 * DISC_N * DISC_R * DISC_R * Math.sin((2 * Math.PI) / DISC_N) * DISC_H

  it('the disc itself is closed and wound outward, so what follows means something', () => {
    const report = health(mesh)
    expect(report.watertight).toBe(true)
    expect(report.windingConflictEdgeCount).toBe(0)
    expect(measureMesh(welded(mesh)).signedVolume).toBeGreaterThan(0)
  })

  it('it is listed as a 3 mm convex fillet', () => {
    const listed = recognizeEdgeBlends(mesh).blends
    const band = new Set(DISC_BAND)
    const hits = listed.filter((b) => b.sourceFacetIds.some((id) => band.has(id)))
    expect(hits.length).toBe(1)
    expect(hits[0].kind).toBe('fillet')
    expect(hits[0].shape).toBe('convex')
    expect(hits[0].radiusMm).toBeCloseTo(FILLET_R, 3)
  })

  it('removing it applies: the part is the sharp prism, closed', () => {
    expect(sharpEdgeRestorationRefusal(mesh, DISC_BAND)).toBeNull()
    const stripped = restoreSharpEdge(mesh, DISC_BAND)
    const report = health(stripped.mesh)
    expect(report.watertight).toBe(true)
    expect(report.boundaryEdgeCount).toBe(0)
    expect(report.windingConflictEdgeCount).toBe(0)
    expect(measureMesh(welded(stripped.mesh)).volume).toBeCloseTo(SHARP_PRISM_MM3, 2)
  })

  it('replay applies it and the part is the sharp prism', () => {
    const record = createMeshEditRecord(mesh, {
      kind: RESTORE_SHARP_EDGE_KIND,
      facets: DISC_BAND,
      parameters: { blend: 'fillet', sizeMm: FILLET_R },
      id: 'medit-round-support',
    })
    const replayed = replayMeshEdits(mesh, [record])
    expect(replayed.stopped).toBeUndefined()
    expect(replayed.appliedCount).toBe(1)
    const report = health(replayed.mesh)
    expect(report.watertight).toBe(true)
    expect(report.boundaryEdgeCount).toBe(0)
    expect(measureMesh(welded(replayed.mesh)).volume).toBeCloseTo(SHARP_PRISM_MM3, 2)
  })
})

describe('WO-1848: the record refuses what it is not', () => {
  const mesh = importStl(blockBytes()).mesh

  it('refuses a parameter it does not have, by name', () => {
    expect(() => createMeshEditRecord(mesh, {
      kind: RESTORE_SHARP_EDGE_KIND, facets: [0], parameters: { blend: 'fillet', radiusMm: 3 },
    })).toThrow(/does not take radiusMm/)
  })

  it('refuses a blend kind that is neither', () => {
    expect(() => createMeshEditRecord(mesh, {
      kind: RESTORE_SHARP_EDGE_KIND, facets: [0], parameters: { blend: 'ogee' },
    })).toThrow(/is neither/)
  })

  it('refuses a radius that is not a measurement', () => {
    expect(() => createMeshEditRecord(mesh, {
      kind: CHANGE_BLEND_RADIUS_KIND, facets: [0], parameters: { radiusMm: Number.NaN },
    })).toThrow(/is not a measurement/)
  })

  it('a chamfer has no radius to change, and it says so', () => {
    const resolved = resolveEditedStlMesh(blockBytes(), undefined)
    const chamfer = recognizeEdgeBlends(resolved.mesh, resolved.sourceFacetIds).blends
      .find((b) => b.kind === 'chamfer') as RecognizedEdgeBlend
    const refusal = blendRadiusChangeRefusal(resolved.mesh, facetsOf(chamfer, resolved.sourceFacetIds), 4)
    expect(refusal as string).toMatch(/no radius to change/)
  })
})

describe('WO-1848: the edit rides through the resolver every route uses', () => {
  it('resolveEditedStlMesh replays it, and the re-exported bytes parse back to the same part', () => {
    const bytes = blockBytes()
    const edit = removal('fillet')
    const resolved = resolveEditedStlMesh(bytes, [edit.record])
    expect(resolved.stopped).toBeUndefined()
    expect(resolved.appliedCount).toBe(1)
    expect(resolved.mesh.indices.length).toBe(edit.mesh.indices.length)
    const round = importStl(exportBinaryStl(resolved.mesh).bytes)
    expect(health(round.mesh).watertight).toBe(true)
    expect(resolved.sourceFacetIds.length).toBe(resolved.mesh.indices.length / 3)
  })
})

describe('WO-1848: the finish path follows the sharp corner afterwards', () => {
  // The product's own CAM route - `acquirePartMesh` (the seam all six store
  // compute sites go through) into `computeParallel3dMoves` against a real
  // BvhKernel - over the block before and after the fillet comes off.
  const bytes = blockBytes()
  const edit = removal('fillet')

  function makeClient(): Cam3dClient {
    const kernel = new BvhKernel()
    const fakeWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest) },
      terminate(): void { /* in-process channel */ },
    }
    const dispatcher = new Cam3dDispatcher(kernel, (msg: Cam3dResponse) => {
      fakeWorker.onmessage?.({ data: msg } as MessageEvent)
    })
    return new Cam3dClient(fakeWorker)
  }

  async function movesOver(edits: MeshEditRecord[]): Promise<ToolpathMove[]> {
    const partMesh = await acquirePartMesh({ format: 'stl', bytes, meshEdits: edits }, 0.05)
    const top = partMesh.bounds.max[2]
    const result = await computeParallel3dMoves({
      partMesh,
      tool: makeTool({ id: 't-ball2', name: 'Ball d2', type: 'ball_end_mill', diameter: 2, toolNumber: 1 }),
      params: { ...DEFAULT_PARALLEL3D_PARAMS, stepover: 0.5, angleDeg: 0, tolerance: 0.05 },
      resolvedHeights: {
        clearanceZ: top + 10, retractZ: top + 2, feedZ: top + 2,
        topZ: top, bottomZ: partMesh.bounds.min[2], stockTopZ: top,
      },
      // just the filleted edge, so this stays a seconds-long fixture
      boundary: [xyBoundsRing({ minX: 50, minY: 14, maxX: 62, maxY: 26 })],
      boundaryKind: 'selection',
      client: makeClient(),
    })
    return result.moves
  }

  /** Moves whose tool centre sits over where the fillet used to be. */
  const overTheFillet = (moves: ToolpathMove[]) =>
    moves.filter((m) => m.x >= WIDTH - FILLET_R && m.x <= WIDTH && m.y >= 14 && m.y <= 26)

  it('BEFORE the edit the cutter rolls down over the round', async () => {
    const moves = overTheFillet(await movesOver([]))
    expect(moves.length).toBeGreaterThan(0)
    expect(moves.some((m) => m.z < HEIGHT - 0.05)).toBe(true)
  }, 120_000)

  it('AFTER the edit it stays up on the flat right to the corner', async () => {
    const moves = overTheFillet(await movesOver([edit.record]))
    expect(moves.length).toBeGreaterThan(0)
    for (const move of moves) {
      expect(
        move.z,
        `a ${move.type}/${move.role ?? '-'} move sits at z=${move.z.toFixed(3)} over the former fillet`,
      ).toBeGreaterThanOrEqual(HEIGHT - 0.05)
    }
  }, 120_000)

  it('and the part the cutter was driven around is the EDITED part', async () => {
    const plain = await acquirePartMesh({ format: 'stl', bytes }, 0.05)
    const edited = await acquirePartMesh({ format: 'stl', bytes, meshEdits: [edit.record] }, 0.05)
    expect(edited.indices.length).toBeLessThan(plain.indices.length)
    expect(edited.bounds.max[0]).toBeCloseTo(plain.bounds.max[0], 6)
    expect(edited.bounds.max[2]).toBeCloseTo(plain.bounds.max[2], 6)
  }, 120_000)
})
