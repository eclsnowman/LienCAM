// WO-1850: LienCAM bores a hole on an STL to a new diameter.
//
// Rule 6: nothing here hand-builds a MeshBuffers and hands it to an engine.
// Every fixture is written as REAL binary STL bytes the way a slicer would and
// parsed back through `importStl`; every edit is minted with the framework's
// own `createMeshEditRecord` and applied by `replayMeshEdits` - the registry
// path WO-1845 built and the one `resolveEditedStlMesh` runs on every route.
// The toolpath case goes further and runs the product's `acquirePartMesh` +
// `computeParallel3dMoves` against a real BvhKernel.
//
// The fixture builders below are the same plate WO-1846 proves its features on
// and WO-1847 edits, restated here rather than imported: a vitest file that
// imports another test file would run that file's mocks and its suites.
//
// ON WELDING, said once: an STL is a triangle soup, and `analyzeMesh` builds
// its topology from VERTEX INDICES. So the plate as imported is "not
// watertight" too - every edge is unique. `welded()` below re-indexes a mesh
// by exact coordinate and changes not one number; the watertight/manifold/
// winding assertions run on that, before AND after, so the comparison is like
// for like.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import { exportBinaryStl, importStl } from '../../mesh/stl'
import {
  createMeshEditRecord,
  NO_SOURCE_FACET,
  replayMeshEdits,
  resolveEditedStlMesh,
  boreSegments,
  enlargeHoleOperation,
  enlargeHoleRefusal,
  holeBreaksInto,
  primeBoringKernel,
  describeMeshEdit,
  ENLARGE_HOLE_KIND,
  type MeshEditRecord,
} from '../../mesh/edit'
import { setSharedManifoldModule, sharedManifoldModule } from '../../mesh/manifoldOps'
import { recognizeMeshFeatures, type RecognizedFeature } from '../../mesh/recognition'
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
  mesh(): MeshBuffers {
    const positions = Float32Array.from(this.coords)
    const indices = new Uint32Array(positions.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    return { positions, indices }
  }
  bytes(): ArrayBuffer { return exportBinaryStl(this.mesh()).bytes }
}

function ring(cx: number, cy: number, r: number, z: number, n: number): Vec3[] {
  return Array.from({ length: n }, (_, k) => {
    const t = (2 * Math.PI * k) / n
    return [cx + r * Math.cos(t), cy + r * Math.sin(t), z] as Vec3
  })
}

function squareRing(cx: number, cy: number, s: number, z: number, n: number): Vec3[] {
  const per = n / 8
  return Array.from({ length: n }, (_, k) => {
    const segment = Math.floor(k / per)
    const f = (k % per) / per
    const xy: Array<[number, number]> = [
      [s, s * f], [s * (1 - f), s], [-s * f, s], [-s, s * (1 - f)],
      [-s, -s * f], [-s * (1 - f), -s], [s * f, -s], [s, -s * (1 - f)],
    ]
    return [cx + xy[segment][0], cy + xy[segment][1], z] as Vec3
  })
}

function annulus(soup: Soup, inner: Vec3[], outer: Vec3[], up: boolean): void {
  const n = inner.length
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    if (up) { soup.tri(inner[k], outer[k], outer[j]); soup.tri(inner[k], outer[j], inner[j]) }
    else { soup.tri(inner[k], outer[j], outer[k]); soup.tri(inner[k], inner[j], outer[j]) }
  }
}

function wall(soup: Soup, lower: Vec3[], upper: Vec3[], outward: boolean): void {
  const n = lower.length
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    if (outward) { soup.tri(lower[k], lower[j], upper[j]); soup.tri(lower[k], upper[j], upper[k]) }
    else { soup.tri(lower[k], upper[k], upper[j]); soup.tri(lower[k], upper[j], lower[j]) }
  }
}

function disk(soup: Soup, loop: Vec3[], centre: Vec3, up: boolean): void {
  const n = loop.length
  for (let k = 0; k < n; k++) {
    const j = (k + 1) % n
    if (up) soup.tri(centre, loop[k], loop[j])
    else soup.tri(centre, loop[j], loop[k])
  }
}

const N = 64
const HALF = 20
const THICK = 12
const CELLS: Array<[number, number]> = [[-HALF, -HALF], [HALF, -HALF], [-HALF, HALF], [HALF, HALF]]

/** WO-1846's acceptance plate: 80 x 80 x 12 mm, four cells, one feature each.
 *  cell 0 a 6 mm through hole; cell 1 a 10/6 counterbore 4 mm deep; cell 2 a
 *  6 mm hole with a 90 degree countersink; cell 3 a 12 mm boss 5 mm tall. */
function acceptancePlate(): ArrayBuffer {
  const soup = new Soup()
  const topRingRadius = [3, 5, 6, 6]
  for (let cell = 0; cell < 4; cell++) {
    const [cx, cy] = CELLS[cell]
    const outerTop = squareRing(cx, cy, HALF, THICK, N)
    const outerBottom = squareRing(cx, cy, HALF, 0, N)
    annulus(soup, ring(cx, cy, topRingRadius[cell], THICK, N), outerTop, true)
    if (cell === 3) disk(soup, outerBottom, [cx, cy, 0], false)
    else annulus(soup, ring(cx, cy, 3, 0, N), outerBottom, false)

    if (cell === 0) {
      wall(soup, ring(cx, cy, 3, 0, N), ring(cx, cy, 3, THICK, N), false)
    } else if (cell === 1) {
      wall(soup, ring(cx, cy, 3, 0, N), ring(cx, cy, 3, 8, N), false)
      annulus(soup, ring(cx, cy, 3, 8, N), ring(cx, cy, 5, 8, N), true)
      wall(soup, ring(cx, cy, 5, 8, N), ring(cx, cy, 5, THICK, N), false)
    } else if (cell === 2) {
      wall(soup, ring(cx, cy, 3, 0, N), ring(cx, cy, 3, 9, N), false)
      wall(soup, ring(cx, cy, 3, 9, N), ring(cx, cy, 6, THICK, N), false)
    } else {
      wall(soup, ring(cx, cy, 6, THICK, N), ring(cx, cy, 6, THICK + 5, N), true)
      disk(soup, ring(cx, cy, 6, THICK + 5, N), [cx, cy, THICK + 5], true)
    }
  }
  wall(soup, squareRing(0, 0, 2 * HALF, 0, N * 2), squareRing(0, 0, 2 * HALF, THICK, N * 2), true)
  return soup.bytes()
}

/** One plate, one blind hole: 8 mm across, 6 mm deep, flat bottom at z = 6. */
function blindHolePlate(): ArrayBuffer {
  const soup = new Soup()
  const outerTop = squareRing(0, 0, HALF, THICK, N)
  const outerBottom = squareRing(0, 0, HALF, 0, N)
  annulus(soup, ring(0, 0, 4, THICK, N), outerTop, true)
  disk(soup, outerBottom, [0, 0, 0], false)
  wall(soup, ring(0, 0, 4, 6, N), ring(0, 0, 4, THICK, N), false)
  disk(soup, ring(0, 0, 4, 6, N), [0, 0, 6], true)
  wall(soup, outerBottom, outerTop, true)
  return soup.bytes()
}

// ------------------------------------------------------------------ helpers

/** Re-index a soup by EXACT coordinate. No number changes; this only gives
 *  `analyzeMesh` the shared-vertex topology its edge map is built on. */
function welded(mesh: MeshBuffers): MeshBuffers {
  const w = weldMesh(mesh)
  return { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
}

function health(mesh: MeshBuffers) {
  return analyzeMesh(welded(mesh), { checkSelfIntersections: false })
}

/** The current-mesh facet indices a recognised feature's source ids name. */
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

interface Bore {
  record: MeshEditRecord
  before: ReturnType<typeof recognizeMeshFeatures>
  after: ReturnType<typeof recognizeMeshFeatures>
  sourceMesh: MeshBuffers
  mesh: MeshBuffers
  sourceFacetIds: Uint32Array
  feature: RecognizedFeature
  addedFacetCount: number
}

/**
 * Bore one recognised feature of an STL to a new diameter, through the
 * framework: parse the bytes, recognise, mint a record against the resolved
 * mesh, replay it.
 */
function bore(bytes: ArrayBuffer, kind: RecognizedFeature['kind'], diameterMm: number, pick = 0): Bore {
  const resolved = resolveEditedStlMesh(bytes, undefined)
  const before = recognizeMeshFeatures(resolved.mesh, resolved.sourceFacetIds)
  const candidates = before.features.filter((f) => f.kind === kind)
  const feature = candidates[pick]
  if (!feature) {
    throw new Error(`the fixture has no ${kind} #${pick}; it has ${before.features.map((f) => f.kind).join(', ') || 'nothing'}`)
  }
  const record = createMeshEditRecord(resolved.mesh, {
    kind: ENLARGE_HOLE_KIND,
    facets: facetsOf(feature, resolved.sourceFacetIds),
    parameters: parametersFor(feature, diameterMm),
    sourceFacetIds: resolved.sourceFacetIds,
  })
  const replayed = replayMeshEdits(resolved.mesh, [record])
  expect(replayed.stopped).toBeUndefined()
  expect(replayed.appliedCount).toBe(1)
  const after = recognizeMeshFeatures(replayed.mesh, replayed.sourceFacetIds)
  let addedFacetCount = 0
  replayed.sourceFacetIds.forEach((id) => { if (id === NO_SOURCE_FACET) addedFacetCount++ })
  return {
    record, before, after, feature, addedFacetCount,
    sourceMesh: resolved.mesh, mesh: replayed.mesh, sourceFacetIds: replayed.sourceFacetIds,
  }
}

/** How far a measured diameter may sit from the one that was typed: the bore
 *  is a polygon with its corners ON the circle, so what WO-1846 fits to it
 *  lands between the chord midpoints and the corners. `CHORD_BUDGET_MM` in
 *  enlargeHole.ts holds that to 0.005 mm of radius; 0.01 mm of diameter is
 *  that, both ways. This is the acceptance's "within chord tolerance". */
const CHORD_BAND_MM = 0.01
const expectDiameter = (measured: number, asked: number): void => {
  expect(Math.abs(measured - asked), `measured ${measured.toFixed(4)} mm, asked ${asked} mm`)
    .toBeLessThanOrEqual(CHORD_BAND_MM)
}

/** Volume of a regular `n`-gon prism of circumradius `r` and height `h` - the
 *  tessellated hole's volume, not the ideal cylinder's. */
const prismVolume = (r: number, h: number, n: number): number =>
  (n / 2) * r * r * Math.sin((2 * Math.PI) / n) * h

// The kernel is loaded ONCE for the file: replay is synchronous, so the wasm
// module has to be in place before the first edit is applied.
beforeAll(async () => { await primeBoringKernel() }, 120_000)

// -------------------------------------------------------------------- tests

describe('WO-1850: the 6 mm through hole is bored out to 8 mm', () => {
  const bytes = acceptancePlate()
  let bored: Bore
  beforeAll(() => { bored = bore(bytes, 'through-hole', 8) })

  it('the result is watertight, manifold and consistently wound', () => {
    const after = health(bored.mesh)
    expect(after.watertight).toBe(true)
    expect(after.boundaryEdgeCount).toBe(0)
    expect(after.nonManifoldEdgeCount).toBe(0)
    expect(after.windingConflictEdgeCount).toBe(0)
    expect(after.degenerateTriangleCount).toBe(0)
    // and the part it was cut from was closed too, so the bore is what kept
    // it closed rather than the fixture being closed either way.
    expect(health(bored.sourceMesh).watertight).toBe(true)
  })

  it('it is still one solid, wound outward', () => {
    const measures = measureMesh(welded(bored.mesh))
    expect(measures.signedVolume).toBeGreaterThan(0)
    expect(measures.componentCount).toBe(1)
  })

  it('WO-1846 now finds an 8 mm through hole on the same axis', () => {
    const grown = bored.after.features.filter((f) => f.kind === 'through-hole')
    expect(grown).toHaveLength(1)
    expectDiameter(grown[0].diameterMm, 8)
    expect(grown[0].depthMm).toBeCloseTo(THICK, 3)
    const axis = grown[0].axis
    expect(Math.abs(axis.direction[2])).toBeCloseTo(1, 6)
    expect(axis.origin[0]).toBeCloseTo(bored.feature.axis.origin[0], 3)
    expect(axis.origin[1]).toBeCloseTo(bored.feature.axis.origin[1], 3)
  })

  it('the other three features are untouched', () => {
    expect(bored.before.features.map((f) => f.kind).sort())
      .toEqual(['boss', 'counterbore', 'countersink', 'through-hole'])
    expect(bored.after.features.map((f) => f.kind).sort())
      .toEqual(['boss', 'counterbore', 'countersink', 'through-hole'])
    for (const kind of ['boss', 'counterbore', 'countersink'] as const) {
      const was = bored.before.features.find((f) => f.kind === kind)!
      const now = bored.after.features.find((f) => f.kind === kind)!
      expect(now.diameterMm).toBeCloseTo(was.diameterMm, 6)
      expect(now.depthMm).toBeCloseTo(was.depthMm, 6)
      expect(now.sourceFacetIds).toEqual(was.sourceFacetIds)
    }
  })

  it('the part loses exactly the annulus between the two bores', () => {
    const was = measureMesh(welded(bored.sourceMesh)).volume
    const now = measureMesh(welded(bored.mesh)).volume
    const removed = prismVolume(4, THICK, boreSegments(4)) - prismVolume(3, THICK, N)
    expect(was - now).toBeCloseTo(removed, 2)
  })

  it('every output facet maps to a source facet or is marked added by this edit', () => {
    const sourceFacets = bored.sourceMesh.indices.length / 3
    expect(bored.sourceFacetIds.length).toBe(bored.mesh.indices.length / 3)
    let descended = 0
    bored.sourceFacetIds.forEach((id) => {
      if (id === NO_SOURCE_FACET) return
      expect(id).toBeLessThan(sourceFacets)
      descended++
    })
    // both kinds are really present: the plate's own facets came through with
    // their file triangle numbers, and the new wall is marked added.
    expect(descended).toBeGreaterThan(0)
    expect(bored.addedFacetCount).toBeGreaterThan(0)
    expect(descended + bored.addedFacetCount).toBe(bored.sourceFacetIds.length)
  })

  it('NEGATIVE CONTROL: bore the same hole to 6.20 mm and the 8 mm reading is gone', () => {
    // The cutter radius is what the 8 mm assertion above rests on. Cut with a
    // barely-larger one instead and WO-1846 measures 6.20, not 8 - so that
    // assertion is reading the bore, not the fixture.
    const control = bore(bytes, 'through-hole', 6.2)
    const grown = control.after.features.filter((f) => f.kind === 'through-hole')
    expect(grown).toHaveLength(1)
    expectDiameter(grown[0].diameterMm, 6.2)
    expect(Math.abs(grown[0].diameterMm - 8)).toBeGreaterThan(CHORD_BAND_MM)
  })

  it('the panel line says what was done', () => {
    expect(describeMeshEdit(bored.record)).toBe('Bored the 6.00 mm through hole out to 8.00 mm')
  })
})

describe('WO-1850: a blind hole keeps its depth and its floor', () => {
  const bytes = blindHolePlate()
  let bored: Bore
  beforeAll(() => { bored = bore(bytes, 'blind-hole', 10) })

  it('the result is closed and still one solid', () => {
    const after = health(bored.mesh)
    expect(after.watertight).toBe(true)
    expect(after.windingConflictEdgeCount).toBe(0)
    expect(measureMesh(welded(bored.mesh)).componentCount).toBe(1)
  })

  it('it is a 10 mm blind hole, still 6 mm deep', () => {
    expectDiameter(bored.feature.diameterMm, 8)
    expect(bored.feature.depthMm).toBeCloseTo(6, 3)
    const now = bored.after.features.filter((f) => f.kind === 'blind-hole')
    expect(now).toHaveLength(1)
    expectDiameter(now[0].diameterMm, 10)
    expect(now[0].depthMm).toBeCloseTo(6, 3)
  })

  it('the floor is still the same plane, at z = 6', () => {
    // Measured off the mesh, not off the recogniser: the lowest material
    // inside the new bore's footprint, ABOVE the plate's own bottom face
    // (which is a full disk at z = 0 and runs under the bore either way).
    let lowest = Infinity
    const mesh = bored.mesh
    for (let v = 0; v < mesh.positions.length / 3; v++) {
      const x = mesh.positions[v * 3]
      const y = mesh.positions[v * 3 + 1]
      const z = mesh.positions[v * 3 + 2]
      if (z > 1e-6 && Math.hypot(x, y) <= 4.99) lowest = Math.min(lowest, z)
    }
    expect(lowest).toBeCloseTo(6, 3)
  })

  it('the part loses exactly the annulus, floor to face', () => {
    const was = measureMesh(welded(bored.sourceMesh)).volume
    const now = measureMesh(welded(bored.mesh)).volume
    const removed = prismVolume(5, 6, boreSegments(5)) - prismVolume(4, 6, N)
    expect(was - now).toBeCloseTo(removed, 2)
  })
})

describe('WO-1850: a bore that breaks through is CARRIED OUT, and LienCAM says what it broke into', () => {
  // The acceptance case LIENCAM.md rule 11 is about: the software CAN cut
  // this, so it cuts it, and the operator is TOLD. Two halves, both measured
  // on the real plate: what the report names, and that the cut happens.
  const bytes = acceptancePlate()
  const resolved = resolveEditedStlMesh(bytes, undefined)
  const found = recognizeMeshFeatures(resolved.mesh, resolved.sourceFacetIds)
  const hole = found.features.find((f) => f.kind === 'through-hole')!

  it('at 8 mm it breaks into nothing, and says so', () => {
    expect(holeBreaksInto(hole, found.features, 8)).toEqual([])
  })

  it('at 90 mm it names the two features it reaches and not the one it does not', () => {
    // the cells sit 40 mm apart on each axis. A 45 mm radius reaches the
    // counterbore and the countersink (40 mm away, 3 mm radius each) and
    // stops short of the boss on the far diagonal (56.6 mm away, 6 mm).
    const named = holeBreaksInto(hole, found.features, 90).map((f) => f.kind).sort()
    expect(named).toEqual(['counterbore', 'countersink'])
  })

  it('and a bore that cuts clean through two outside walls is not refused', () => {
    // 50 mm across, from a hole 20 mm in from two edges of an 80 mm plate:
    // the wall is gone on two sides. Nothing stops it.
    const facets = facetsOf(hole, resolved.sourceFacetIds)
    expect(enlargeHoleRefusal(resolved.mesh, facets, parametersFor(hole, 50))).toBeNull()
    const bored = bore(bytes, 'through-hole', 50)
    expect(bored.record.kind).toBe(ENLARGE_HOLE_KIND)
    const after = health(bored.mesh)
    expect(after.watertight).toBe(true)
    expect(after.windingConflictEdgeCount).toBe(0)
    expect(measureMesh(welded(bored.mesh)).signedVolume).toBeGreaterThan(0)
    // and it really did take the corner out: more than the annulus a bore
    // wholly inside the plate would have removed.
    const was = measureMesh(welded(bored.sourceMesh)).volume
    const now = measureMesh(welded(bored.mesh)).volume
    expect(was - now).toBeGreaterThan(prismVolume(3, THICK, N))
  })
})

describe('WO-1850: a smaller diameter is carried out, not refused', () => {
  const bytes = blindHolePlate()
  let shrunk: Bore
  beforeAll(() => { shrunk = bore(bytes, 'blind-hole', 6) })

  it('ONE journal entry does the fill and the bore', () => {
    // rule 11 / architect audit item 1: the software has both halves, so it
    // uses them. One record is one undo step, the way the operator thinks of
    // it.
    expect(describeMeshEdit(shrunk.record)).toBe('Filled the 8.00 mm blind hole and bored 6.00 mm')
    const resolved = resolveEditedStlMesh(bytes, [shrunk.record])
    expect(resolved.stopped).toBeUndefined()
    expect(resolved.appliedCount).toBe(1)
  })

  it('the hole really is 6 mm now, still 6 mm deep, and the part is closed', () => {
    const now = shrunk.after.features.filter((f) => f.kind === 'blind-hole')
    expect(now).toHaveLength(1)
    expectDiameter(now[0].diameterMm, 6)
    expect(now[0].depthMm).toBeCloseTo(6, 3)
    const after = health(shrunk.mesh)
    expect(after.watertight).toBe(true)
    expect(after.windingConflictEdgeCount).toBe(0)
  })

  it('the part GAINS material, which a subtraction alone could never do', () => {
    const was = measureMesh(welded(shrunk.sourceMesh)).volume
    const now = measureMesh(welded(shrunk.mesh)).volume
    expect(now).toBeGreaterThan(was)
    const gained = prismVolume(4, 6, N) - prismVolume(3, 6, boreSegments(3))
    expect(now - was).toBeCloseTo(gained, 2)
  })
})

describe('WO-1850: what the software genuinely cannot do, and only that', () => {
  const bytes = acceptancePlate()
  const resolved = resolveEditedStlMesh(bytes, undefined)
  const found = recognizeMeshFeatures(resolved.mesh, resolved.sourceFacetIds)
  const hole = found.features.find((f) => f.kind === 'through-hole')!
  const facets = facetsOf(hole, resolved.sourceFacetIds)

  it('the diameter it already has is nothing to bore, and says so plainly', () => {
    const refusal = enlargeHoleRefusal(resolved.mesh, facets, parametersFor(hole, hole.diameterMm))
    expect(refusal).toMatch(/already .* mm across, so there is nothing to bore/)
  })

  it('a boss is not a hole', () => {
    const boss = found.features.find((f) => f.kind === 'boss')!
    expect(() => enlargeHoleOperation.validate(parametersFor(boss, 20)))
      .toThrow(/not a hole/)
  })

  it('a diameter that is not a measurement is refused before it is recorded', () => {
    expect(() => enlargeHoleOperation.validate({ ...parametersFor(hole, 8), diameterMm: -1 }))
      .toThrow(/not a measurement/)
    expect(() => createMeshEditRecord(resolved.mesh, {
      kind: ENLARGE_HOLE_KIND, facets, parameters: { ...parametersFor(hole, 8), diameterMm: 0 },
    })).toThrow(/not a measurement/)
  })

  it('nothing else is refused: a bore bigger than the part still goes through', () => {
    expect(enlargeHoleRefusal(resolved.mesh, facets, parametersFor(hole, 30))).toBeNull()
  })
})

describe('WO-1850: the edit rides through the resolver every route uses', () => {
  it('resolveEditedStlMesh replays it and the re-exported bytes parse back to the same part', () => {
    const bytes = acceptancePlate()
    const bored = bore(bytes, 'through-hole', 8)
    const resolved = resolveEditedStlMesh(bytes, [bored.record])
    expect(resolved.stopped).toBeUndefined()
    expect(resolved.appliedCount).toBe(1)
    expect(resolved.mesh.indices.length).toBe(bored.mesh.indices.length)

    const round = importStl(exportBinaryStl(resolved.mesh).bytes)
    expect(round.mesh.indices.length).toBe(resolved.mesh.indices.length)
    expect(health(round.mesh).watertight).toBe(true)
    expect(resolved.sourceFacetIds.length).toBe(resolved.mesh.indices.length / 3)
  })

  it('replay is deterministic: the same record over the same bytes twice is the same mesh', () => {
    const bytes = blindHolePlate()
    const bored = bore(bytes, 'blind-hole', 10)
    const first = exportBinaryStl(resolveEditedStlMesh(bytes, [bored.record]).mesh).bytes
    const second = exportBinaryStl(resolveEditedStlMesh(bytes, [bored.record]).mesh).bytes
    expect(new Uint8Array(first)).toEqual(new Uint8Array(second))
  })
})

describe('WO-1850: a saved bore replays on a cold reload, with nobody priming anything', () => {
  // The defect the 2026-09-23 audit found and this round closes: a bore the
  // operator saved yesterday is replayed in a FRESH process - he reloads the
  // project and asks for a toolpath. Nothing on that route knows the bore
  // needs a wasm kernel, so nothing primed one, replay stopped at the bore,
  // and CAM (R1), the store's chains and feature targets (R2) and the panel
  // all cut/measured/listed the UN-bored part. The fix is that the edit module
  // starts its own kernel as it is evaluated, so every route that can replay a
  // journal - each of them reaches replay through src/mesh/edit - has it
  // loading from the moment the process exists.
  const bytes = blindHolePlate()
  let saved: MeshEditRecord

  beforeAll(() => { saved = JSON.parse(JSON.stringify(bore(bytes, 'blind-hole', 10).record)) as MeshEditRecord })

  it('a process that has only imported src/mesh/edit ends up with a boring kernel, unasked', async () => {
    vi.resetModules()
    // A FRESH module graph: its own registry, its own kernel slot, and - this
    // is the point - not one call to primeBoringKernel anywhere below.
    const freshEdit = await import('../../mesh/edit')
    const freshOps = await import('../../mesh/manifoldOps')
    await vi.waitFor(
      () => { expect(freshOps.sharedManifoldModule(), 'nothing primed the boring kernel').not.toBeNull() },
      { timeout: 60_000, interval: 20 },
    )

    // The journal off the project file, replayed cold.
    const resolved = freshEdit.resolveEditedStlMesh(bytes, [saved])
    expect(resolved.stopped).toBeUndefined()
    expect(resolved.appliedCount).toBe(1)

    // ...and it really is the bored part, not the file's own 8 mm hole.
    const found = recognizeMeshFeatures(resolved.mesh, resolved.sourceFacetIds)
    const hole = found.features.find((f) => f.kind === 'blind-hole')
    expect(hole, 'the cold replay lost the blind hole').toBeDefined()
    expectDiameter(hole!.diameterMm, 10)
    expect(hole!.depthMm).toBeCloseTo(6, 3)

    // ADR-0051 R1, the route the CUTTER comes down: CAM's own entry point, in
    // that same fresh graph, hands back the bored part and not the file's.
    const freshCam = await import('../../cam3d/integration/parallel3dOperation')
    const coldPart = await freshCam.acquirePartMesh({ format: 'stl', bytes, meshEdits: [saved] }, 0.05)
    const warmPart = await acquirePartMesh({ format: 'stl', bytes, meshEdits: [saved] }, 0.05)
    const unedited = await acquirePartMesh({ format: 'stl', bytes, meshEdits: [] }, 0.05)
    expect(coldPart.indices.length, 'the cold CAM route got the un-bored part')
      .not.toBe(unedited.indices.length)
    expect(coldPart.indices.length).toBe(warmPart.indices.length)
    expect(Array.from(coldPart.positions)).toEqual(Array.from(warmPart.positions))
  }, 120_000)

  it('NEGATIVE CONTROL: take the kernel away and the same journal stops at the bore', () => {
    const module = sharedManifoldModule()
    try {
      setSharedManifoldModule(null)
      const cold = resolveEditedStlMesh(bytes, [saved])
      expect(cold.appliedCount).toBe(0)
      expect(cold.stopped?.kind).toBe(ENLARGE_HOLE_KIND)
      // Which is exactly what the reload used to look like - so the test above
      // is reading the module's own priming, not a kernel left over from the
      // rest of this file.
    } finally {
      setSharedManifoldModule(module)
    }
  })

  it('and the kernel is handed back to a later caller even after it was taken away', async () => {
    const module = sharedManifoldModule()
    try {
      setSharedManifoldModule(null)
      await primeBoringKernel()
      expect(sharedManifoldModule()).not.toBeNull()
      const again = resolveEditedStlMesh(bytes, [saved])
      expect(again.stopped).toBeUndefined()
      expect(again.appliedCount).toBe(1)
    } finally {
      if (!sharedManifoldModule()) setSharedManifoldModule(module)
    }
  })
})

describe('WO-1850: through Parallel 3D, the path follows the larger hole', () => {
  // The whole point of editing an STL: the CUTTER has to see the change. This
  // runs the product's own CAM route - `acquirePartMesh` (the one seam all six
  // store compute sites go through) into `computeParallel3dMoves` against a
  // real BvhKernel - on the blind-hole plate before and after the bore, and
  // asks how far out from the axis the tool is still driven to the floor.
  const bytes = blindHolePlate()
  let bored: Bore
  beforeAll(() => { bored = bore(bytes, 'blind-hole', 10) })

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
      params: { ...DEFAULT_PARALLEL3D_PARAMS, stepover: 0.4, angleDeg: 0, tolerance: 0.05 },
      resolvedHeights: {
        clearanceZ: top + 10, retractZ: top + 2, feedZ: top + 2,
        topZ: top, bottomZ: partMesh.bounds.min[2], stockTopZ: top,
      },
      // just the hole's own patch, so this stays a seconds-long fixture
      boundary: [xyBoundsRing({ minX: -10, minY: -10, maxX: 10, maxY: 10 })],
      boundaryKind: 'selection',
      client: makeClient(),
    })
    return result.moves
  }

  /** How far from the axis the tool still reaches the floor of the bore. */
  const floorReach = (moves: ToolpathMove[]): number => Math.max(
    ...moves.filter((m) => m.z < 8).map((m) => Math.hypot(m.x, m.y)),
  )

  it('the cutter reaches a full millimetre further out after the bore', async () => {
    const before = floorReach(await movesOver([]))
    const after = floorReach(await movesOver([bored.record]))
    // a 2 mm ball in an 8 mm bore can sit 4 - 1 = 3 mm off axis and still be
    // down at the floor; in a 10 mm bore, 5 - 1 = 4 mm.
    expect(before).toBeGreaterThan(2.5)
    expect(before).toBeLessThan(3.2)
    expect(after).toBeGreaterThan(3.5)
    expect(after).toBeLessThan(4.2)
    expect(after - before).toBeGreaterThan(0.8)
  }, 180_000)
})

