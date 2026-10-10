// WO-1847: LienCAM fills a hole, or cuts a boss off flush, on an STL.
//
// Rule 6: nothing here hand-builds a MeshBuffers and hands it to an engine.
// Every fixture is written as REAL binary STL bytes the way a slicer would and
// parsed back through `importStl`; every edit is minted with the framework's
// own `createMeshEditRecord` and applied by `replayMeshEdits` - the registry
// path WO-1845 built and the one `resolveEditedStlMesh` runs on every route.
// The toolpath case goes further and runs the product's `acquirePartMesh` +
// `computeParallel3dMoves` against a real BvhKernel.
//
// The fixture builders below are the same plate WO-1846 proves its four
// features on, restated here rather than imported: a vitest file that imports
// another test file would run that file's mocks and its suites.
//
// ON WELDING, said once: an STL is a triangle soup, and `analyzeMesh` builds
// its topology from VERTEX INDICES (src/mesh/analysis.ts:117-127). So the plate
// as imported is "not watertight" too - every edge is unique. `welded()` below
// re-indexes a mesh by exact coordinate and changes not one number; the
// watertight/manifold/winding assertions run on that, before AND after, so the
// comparison is like for like.

import { describe, expect, it } from 'vitest'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import { exportBinaryStl, importStl } from '../../mesh/stl'
import {
  createMeshEditRecord,
  NO_SOURCE_FACET,
  replayMeshEdits,
  resolveEditedStlMesh,
  sourceFacetIdsOf,
  REMOVE_ROUND_FEATURE_KIND,
  roundFeatureRemovalRefusal,
  type MeshEditRecord,
} from '../../mesh/edit'
import { removeFacets } from '../../mesh/edit/operations/boundaryCap'
import { recognizeMeshFeatures, describeFeature, type RecognizedFeature } from '../../mesh/recognition'
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
function acceptancePlate(segments = N): ArrayBuffer {
  const soup = new Soup()
  const topRingRadius = [3, 5, 6, 6]
  for (let cell = 0; cell < 4; cell++) {
    const [cx, cy] = CELLS[cell]
    const outerTop = squareRing(cx, cy, HALF, THICK, segments)
    const outerBottom = squareRing(cx, cy, HALF, 0, segments)
    annulus(soup, ring(cx, cy, topRingRadius[cell], THICK, segments), outerTop, true)
    if (cell === 3) disk(soup, outerBottom, [cx, cy, 0], false)
    else annulus(soup, ring(cx, cy, 3, 0, segments), outerBottom, false)

    if (cell === 0) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, THICK, segments), false)
    } else if (cell === 1) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, 8, segments), false)
      annulus(soup, ring(cx, cy, 3, 8, segments), ring(cx, cy, 5, 8, segments), true)
      wall(soup, ring(cx, cy, 5, 8, segments), ring(cx, cy, 5, THICK, segments), false)
    } else if (cell === 2) {
      wall(soup, ring(cx, cy, 3, 0, segments), ring(cx, cy, 3, 9, segments), false)
      wall(soup, ring(cx, cy, 3, 9, segments), ring(cx, cy, 6, THICK, segments), false)
    } else {
      wall(soup, ring(cx, cy, 6, THICK, segments), ring(cx, cy, 6, THICK + 5, segments), true)
      disk(soup, ring(cx, cy, 6, THICK + 5, segments), [cx, cy, THICK + 5], true)
    }
  }
  const outline = squareRing(0, 0, 2 * HALF, 0, segments * 2)
  const outlineTop = squareRing(0, 0, 2 * HALF, THICK, segments * 2)
  wall(soup, outline, outlineTop, true)
  return soup.bytes()
}

/** One plate, one blind hole: 8 mm across, 6 mm deep, flat bottom. */
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

/** One plate, one 6 mm bore chamfered at BOTH faces (90 degrees, 3 mm each),
 *  which is what WO-1846 calls a chamfered hole. */
function chamferedHolePlate(): ArrayBuffer {
  const soup = new Soup()
  const outerTop = squareRing(0, 0, HALF, THICK, N)
  const outerBottom = squareRing(0, 0, HALF, 0, N)
  annulus(soup, ring(0, 0, 6, THICK, N), outerTop, true)
  annulus(soup, ring(0, 0, 6, 0, N), outerBottom, false)
  wall(soup, ring(0, 0, 6, 0, N), ring(0, 0, 3, 3, N), false)
  wall(soup, ring(0, 0, 3, 3, N), ring(0, 0, 3, 9, N), false)
  wall(soup, ring(0, 0, 3, 9, N), ring(0, 0, 6, THICK, N), false)
  wall(soup, outerBottom, outerTop, true)
  return soup.bytes()
}

/**
 * A closed sphere of radius 10, centred on the origin: curved everywhere, so
 * most of its rims are genuinely not flat.
 *
 * Wound OUTWARD and consistently, which WO-1846's copy of this fixture is not
 * (it has 96 winding-conflict edges at the two pole rings; nothing there reads
 * them, because it only asserts that a sphere proves no round feature). This
 * file asserts on watertightness and winding, so it needs a clean sphere - and
 * measured: `analyzeMesh` reports 0 conflicts and `measureMesh` a POSITIVE
 * signed volume on it, both pinned below.
 */
const SPHERE_RINGS = 24
const SPHERE_SEGMENTS = 48
function spherePlate(): ArrayBuffer {
  const soup = new Soup()
  const at = (i: number, k: number): Vec3 => {
    const phi = (Math.PI * i) / SPHERE_RINGS
    const theta = (2 * Math.PI * k) / SPHERE_SEGMENTS
    return [10 * Math.sin(phi) * Math.cos(theta), 10 * Math.sin(phi) * Math.sin(theta), 10 * Math.cos(phi)]
  }
  for (let i = 0; i < SPHERE_RINGS; i++) {
    for (let k = 0; k < SPHERE_SEGMENTS; k++) {
      const j = (k + 1) % SPHERE_SEGMENTS
      if (i === 0) soup.tri(at(0, 0), at(1, k), at(1, j))
      else if (i === SPHERE_RINGS - 1) soup.tri(at(SPHERE_RINGS, 0), at(i, j), at(i, k))
      else soup.quad(at(i, k), at(i + 1, k), at(i + 1, j), at(i, j))
    }
  }
  return soup.bytes()
}

/** The first facet of band `i`, segment `k` of `spherePlate` (the pole fan
 *  takes the first SPHERE_SEGMENTS facets, then two per quad). */
const sphereFacet = (i: number, k: number): number =>
  SPHERE_SEGMENTS + ((i - 1) * SPHERE_SEGMENTS + k) * 2

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

interface Removal {
  record: MeshEditRecord
  before: ReturnType<typeof recognizeMeshFeatures>
  after: ReturnType<typeof recognizeMeshFeatures>
  sourceMesh: MeshBuffers
  mesh: MeshBuffers
  sourceFacetIds: Uint32Array
  feature: RecognizedFeature
  capFacetCount: number
}

/**
 * Remove one recognised feature from an STL, through the framework: parse the
 * bytes, recognise, mint a record against the resolved mesh, replay it.
 */
function removeFeature(bytes: ArrayBuffer, kind: RecognizedFeature['kind']): Removal {
  const resolved = resolveEditedStlMesh(bytes, undefined)
  const before = recognizeMeshFeatures(resolved.mesh, resolved.sourceFacetIds)
  const feature = before.features.find((f) => f.kind === kind)
  if (!feature) throw new Error(`the fixture has no ${kind}; it has ${before.features.map((f) => f.kind).join(', ') || 'nothing'}`)
  const facets = facetsOf(feature, resolved.sourceFacetIds)
  const record = createMeshEditRecord(resolved.mesh, {
    kind: REMOVE_ROUND_FEATURE_KIND,
    facets,
    parameters: { feature: kind, diameterMm: feature.diameterMm },
    sourceFacetIds: resolved.sourceFacetIds,
  })
  const replayed = replayMeshEdits(resolved.mesh, [record])
  expect(replayed.stopped).toBeUndefined()
  expect(replayed.appliedCount).toBe(1)
  const after = recognizeMeshFeatures(replayed.mesh, replayed.sourceFacetIds)
  let capFacetCount = 0
  replayed.sourceFacetIds.forEach((id) => { if (id === NO_SOURCE_FACET) capFacetCount++ })
  return {
    record, before, after, feature, capFacetCount,
    sourceMesh: resolved.mesh, mesh: replayed.mesh, sourceFacetIds: replayed.sourceFacetIds,
  }
}

/** Volume of a regular `n`-gon prism of circumradius `r` and height `h` - the
 *  tessellated hole's volume, not the ideal cylinder's. */
const prismVolume = (r: number, h: number, n = N): number => (n / 2) * r * r * Math.sin((2 * Math.PI) / n) * h

/** Volume of a tessellated cone frustum between circumradii `r0` and `r1`. */
function frustumVolume(r0: number, r1: number, h: number, n = N): number {
  const k = (n / 2) * Math.sin((2 * Math.PI) / n)
  return (k * h * (r0 * r0 + r0 * r1 + r1 * r1)) / 3
}

// -------------------------------------------------------------------- tests

describe('WO-1847: the through hole is filled flush, and the part stays closed', () => {
  const bytes = acceptancePlate()
  const removal = removeFeature(bytes, 'through-hole')

  it('the result is watertight, manifold and consistently wound', () => {
    const after = health(removal.mesh)
    expect(after.watertight).toBe(true)
    expect(after.boundaryEdgeCount).toBe(0)
    expect(after.nonManifoldEdgeCount).toBe(0)
    expect(after.windingConflictEdgeCount).toBe(0)
    expect(after.degenerateTriangleCount).toBe(0)
    // and the source it was made from was closed too, so the fill is what
    // kept it closed rather than the fixture being closed either way.
    expect(health(removal.sourceMesh).watertight).toBe(true)
  })

  it('it is still the same solid, wound outward', () => {
    const measures = measureMesh(welded(removal.mesh))
    expect(measures.signedVolume).toBeGreaterThan(0)
    expect(measures.componentCount).toBe(1)
  })

  it('the part gains exactly the hole back', () => {
    const before = measureMesh(welded(removal.sourceMesh)).volume
    const after = measureMesh(welded(removal.mesh)).volume
    const expected = prismVolume(3, THICK)
    expect(after - before).toBeCloseTo(expected, 3)
  })

  it('WO-1846 no longer finds it, and the other three are untouched', () => {
    expect(removal.before.features.map((f) => f.kind).sort())
      .toEqual(['boss', 'counterbore', 'countersink', 'through-hole'])
    expect(removal.after.features.map((f) => f.kind).sort())
      .toEqual(['boss', 'counterbore', 'countersink'])
    for (const kind of ['boss', 'counterbore', 'countersink'] as const) {
      const was = removal.before.features.find((f) => f.kind === kind)!
      const now = removal.after.features.find((f) => f.kind === kind)!
      expect(now.sourceFacetIds).toEqual(was.sourceFacetIds)
      expect(now.diameterMm).toBeCloseTo(was.diameterMm, 9)
      expect(now.depthMm).toBeCloseTo(was.depthMm, 9)
    }
  })

  it('every output facet is a source facet or is marked as added by this edit', () => {
    const sourceCount = removal.sourceMesh.indices.length / 3
    let descended = 0
    removal.sourceFacetIds.forEach((id) => {
      if (id === NO_SOURCE_FACET) return
      expect(id).toBeLessThan(sourceCount)
      descended++
    })
    expect(descended + removal.capFacetCount).toBe(removal.mesh.indices.length / 3)
    // two rims closed, each a 64-gon fan of 62 triangles
    expect(removal.capFacetCount).toBe(2 * (N - 2))
    // nothing survived twice and nothing that was removed came back
    const removed = new Set(removal.record.facets)
    const survivors = new Set<number>()
    removal.sourceFacetIds.forEach((id) => { if (id !== NO_SOURCE_FACET) survivors.add(id) })
    expect(survivors.size).toBe(descended)
    for (const facet of removed) expect(survivors.has(facet)).toBe(false)
  })

  it('reads in plain words', () => {
    expect(removal.record.kind).toBe(REMOVE_ROUND_FEATURE_KIND)
    const lines = [describeFeature(removal.feature)]
    expect(lines[0]).toMatch(/through hole 6\.00 mm/)
  })

  it('NEGATIVE CONTROL: skip the cap step and the part is not watertight', () => {
    const stripped = removeFacets(removal.sourceMesh, new Set(removal.record.facets))
    const report = health(stripped.mesh)
    expect(report.watertight).toBe(false)
    expect(report.holeCount).toBe(2)
    expect(report.boundaryEdgeCount).toBe(2 * N)
  })
})

describe('WO-1847: every other hole in the family fills the same way', () => {
  const cases: Array<{
    kind: RecognizedFeature['kind']
    bytes: () => ArrayBuffer
    /** signed change in volume the fill must produce, mm^3 */
    deltaMm3: number
    /** how many rims the removal opens */
    rims: number
  }> = [
    { kind: 'counterbore', bytes: acceptancePlate, rims: 2, deltaMm3: prismVolume(3, 8) + prismVolume(5, 4) },
    { kind: 'countersink', bytes: acceptancePlate, rims: 2, deltaMm3: prismVolume(3, 9) + frustumVolume(3, 6, 3) },
    // a boss is material ADDED to the plate, so cutting it off flush removes it
    { kind: 'boss', bytes: acceptancePlate, rims: 1, deltaMm3: -prismVolume(6, 5) },
    { kind: 'blind-hole', bytes: blindHolePlate, rims: 1, deltaMm3: prismVolume(4, 6) },
    { kind: 'chamfered-hole', bytes: chamferedHolePlate, rims: 2, deltaMm3: prismVolume(3, 6) + 2 * frustumVolume(3, 6, 3) },
  ]

  for (const testCase of cases) {
    describe(testCase.kind, () => {
      const removal = removeFeature(testCase.bytes(), testCase.kind)

      it('leaves a closed, outward, single-shell part', () => {
        const report = health(removal.mesh)
        expect(report.watertight).toBe(true)
        expect(report.nonManifoldEdgeCount).toBe(0)
        expect(report.windingConflictEdgeCount).toBe(0)
        const measures = measureMesh(welded(removal.mesh))
        expect(measures.signedVolume).toBeGreaterThan(0)
        expect(measures.componentCount).toBe(1)
      })

      it('changes the volume by the feature, within tessellation tolerance', () => {
        const before = measureMesh(welded(removal.sourceMesh)).volume
        const after = measureMesh(welded(removal.mesh)).volume
        expect(after - before).toBeCloseTo(testCase.deltaMm3, 3)
      })

      it('WO-1846 no longer finds it', () => {
        expect(removal.before.features.some((f) => f.kind === testCase.kind)).toBe(true)
        expect(removal.after.features.some((f) => f.kind === testCase.kind)).toBe(false)
      })

      it('the cap is new geometry, one fan per rim', () => {
        expect(removal.capFacetCount).toBe(testCase.rims * (N - 2))
      })

      it('NEGATIVE CONTROL: skipping the cap opens exactly those rims', () => {
        const stripped = removeFacets(removal.sourceMesh, new Set(removal.record.facets))
        const report = health(stripped.mesh)
        expect(report.watertight).toBe(false)
        expect(report.holeCount).toBe(testCase.rims)
      })
    })
  }
})

describe('WO-1847: a rim that cannot be closed flat is refused, and nothing changes', () => {
  const mesh = importStl(spherePlate()).mesh
  // Two facets of the same latitude band, one segment apart, sharing one edge.
  // Their four corners sit on two different pairs of longitudes, so the rim
  // they leave genuinely does not lie in any plane.
  const BENT: [number, number] = [sphereFacet(12, 0) + 1, sphereFacet(12, 1)]
  // Two facets that touch at ONE corner only: the rim pinches there instead of
  // closing into a ring.
  const PINCHED: [number, number] = [sphereFacet(12, 0), sphereFacet(12, 1)]

  it('the fixture itself is closed and wound outward, so the assertions below mean something', () => {
    const report = health(mesh)
    expect(report.watertight).toBe(true)
    expect(report.windingConflictEdgeCount).toBe(0)
    expect(measureMesh(welded(mesh)).signedVolume).toBeGreaterThan(0)
  })

  it('says what it cannot do, and says how far out of flat the rim is', () => {
    const refusal = roundFeatureRemovalRefusal(mesh, BENT)
    expect(refusal).not.toBeNull()
    expect(refusal as string).toMatch(/can only close an opening whose rim lies flat in one plane/)
    const bend = Number(/bends (\d+\.\d+) mm/.exec(refusal ?? '')?.[1])
    expect(bend).toBeGreaterThan(0.001)
  })

  it('a rim that branches instead of closing is refused too', () => {
    expect(roundFeatureRemovalRefusal(mesh, PINCHED) as string)
      .toMatch(/branches instead of closing into one ring/)
  })

  it('replay STOPS at it and leaves the mesh exactly as it was', () => {
    const record = createMeshEditRecord(mesh, {
      kind: REMOVE_ROUND_FEATURE_KIND,
      facets: [...BENT],
      parameters: { feature: 'through-hole' },
      id: 'medit-not-flat',
    })
    const errors: string[] = []
    const spy = console.error
    console.error = (...args: unknown[]) => { errors.push(String(args[0])) }
    let replayed
    try {
      replayed = replayMeshEdits(mesh, [record])
    } finally {
      console.error = spy
    }
    expect(replayed.appliedCount).toBe(0)
    expect(replayed.stopped?.reason).toMatch(/lies flat in one plane/)
    expect(replayed.mesh).toBe(mesh)
    expect(errors.join('\n')).toMatch(/could not be replayed/)
  })

  it('POSITIVE CONTROL: one facet of the same sphere caps fine, so the refusal is about the rim', () => {
    // A three-corner rim is flat by definition; the fill puts the very same
    // triangle back, so the sphere stays closed and its volume is unchanged.
    expect(roundFeatureRemovalRefusal(mesh, [BENT[0]])).toBeNull()
    const record = createMeshEditRecord(mesh, {
      kind: REMOVE_ROUND_FEATURE_KIND,
      facets: [BENT[0]],
      parameters: { feature: 'through-hole' },
      id: 'medit-one-facet',
    })
    const replayed = replayMeshEdits(mesh, [record])
    expect(replayed.appliedCount).toBe(1)
    const report = health(replayed.mesh)
    expect(report.watertight).toBe(true)
    expect(report.windingConflictEdgeCount).toBe(0)
    expect(measureMesh(welded(replayed.mesh)).volume)
      .toBeCloseTo(measureMesh(welded(mesh)).volume, 6)
  })
})

describe('WO-1847: the record refuses what it is not', () => {
  const bytes = acceptancePlate()
  const mesh = importStl(bytes).mesh

  it('refuses a parameter it does not have, by name', () => {
    expect(() => createMeshEditRecord(mesh, {
      kind: REMOVE_ROUND_FEATURE_KIND, facets: [0],
      parameters: { feature: 'through-hole', depthMm: 4 },
    })).toThrow(/does not take depthMm/)
  })

  it('refuses a feature kind LienCAM does not recognise', () => {
    expect(() => createMeshEditRecord(mesh, {
      kind: REMOVE_ROUND_FEATURE_KIND, facets: [0], parameters: { feature: 'slot' },
    })).toThrow(/is not one LienCAM recognises/)
  })

  it('refuses a diameter that is not a measurement', () => {
    expect(() => createMeshEditRecord(mesh, {
      kind: REMOVE_ROUND_FEATURE_KIND, facets: [0],
      parameters: { feature: 'boss', diameterMm: Number.NaN },
    })).toThrow(/is not a measurement/)
  })

  it('a record from another version of this edit does not replay as this one', () => {
    const record = createMeshEditRecord(mesh, {
      kind: REMOVE_ROUND_FEATURE_KIND, facets: [0], parameters: { feature: 'through-hole' },
    })
    const spy = console.error
    console.error = () => {}
    const replayed = replayMeshEdits(mesh, [{ ...record, version: record.version + 1 }])
    console.error = spy
    expect(replayed.appliedCount).toBe(0)
    expect(replayed.stopped?.reason).toMatch(/version/)
  })
})

describe('WO-1847: the toolpath stops plunging into the hole that was filled', () => {
  // The whole point of editing an STL: the CUTTER has to see the change. This
  // runs the product's own CAM route - `acquirePartMesh` (the one seam all six
  // store compute sites go through) into `computeParallel3dMoves` against a
  // real BvhKernel - on the plate before and after the edit, and asks where the
  // tool went inside the hole's footprint.
  const bytes = acceptancePlate()
  const removal = removeFeature(bytes, 'through-hole')
  const [HX, HY] = CELLS[0]
  const HOLE_RADIUS = 3
  const blindBytes = blindHolePlate()
  const blindRemoval = removeFeature(blindBytes, 'blind-hole')

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

  async function movesOver(
    source: ArrayBuffer,
    edits: MeshEditRecord[],
    centre: [number, number],
  ): Promise<ToolpathMove[]> {
    const partMesh = await acquirePartMesh({ format: 'stl', bytes: source, meshEdits: edits }, 0.05)
    const top = partMesh.bounds.max[2]
    const result = await computeParallel3dMoves({
      partMesh,
      tool: makeTool({ id: 't-ball2', name: 'Ball d2', type: 'ball_end_mill', diameter: 2, toolNumber: 1 }),
      params: { ...DEFAULT_PARALLEL3D_PARAMS, stepover: 0.4, angleDeg: 0, tolerance: 0.05 },
      resolvedHeights: {
        clearanceZ: top + 10, retractZ: top + 2, feedZ: top + 2,
        topZ: top, bottomZ: partMesh.bounds.min[2], stockTopZ: top,
      },
      // just the hole's own cell, so this stays a seconds-long fixture
      boundary: [xyBoundsRing({
        minX: centre[0] - 10, minY: centre[1] - 10, maxX: centre[0] + 10, maxY: centre[1] + 10,
      })],
      boundaryKind: 'selection',
      client: makeClient(),
    })
    return result.moves
  }

  /** Moves whose tool centre is inside a bore's footprint. */
  const inside = (moves: ToolpathMove[], centre: [number, number], radius: number) =>
    moves.filter((m) => Math.hypot(m.x - centre[0], m.y - centre[1]) <= radius)

  it('BEFORE the edit the cutter goes below the plate top inside the bore', async () => {
    const moves = inside(await movesOver(bytes, [], [HX, HY]), [HX, HY], HOLE_RADIUS)
    expect(moves.length).toBeGreaterThan(0)
    expect(moves.some((m) => m.z < THICK - 0.05)).toBe(true)
  }, 120_000)

  it('AFTER the edit no move goes below the plate top inside that footprint', async () => {
    const moves = inside(await movesOver(bytes, [removal.record], [HX, HY]), [HX, HY], HOLE_RADIUS)
    expect(moves.length).toBeGreaterThan(0)
    for (const move of moves) {
      expect(
        move.z,
        `a ${move.type}/${move.role ?? '-'} move sits at z=${move.z.toFixed(3)} inside the filled hole`,
      ).toBeGreaterThanOrEqual(THICK - 0.05)
    }
  }, 120_000)

  it('a BLIND hole is the plain plunge: 5 mm deep before, gone after', async () => {
    // A blind hole has a floor, so the ball really does drive to the bottom of
    // it; through the 6 mm of a through hole there is nothing to drop onto and
    // the pass simply breaks. This is the plunge in the WO's words.
    const before = inside(await movesOver(blindBytes, [], [0, 0]), [0, 0], 4)
    const lowest = Math.min(...before.map((m) => m.z))
    expect(lowest).toBeLessThan(7) // the floor sits at z = 6
    const after = inside(await movesOver(blindBytes, [blindRemoval.record], [0, 0]), [0, 0], 4)
    expect(after.length).toBeGreaterThan(0)
    for (const move of after) {
      expect(move.z, `a move sits at z=${move.z.toFixed(3)} inside the filled blind hole`)
        .toBeGreaterThanOrEqual(THICK - 0.05)
    }
  }, 120_000)

  it('and the part the cutter was driven around is the EDITED part', async () => {
    const plain = await acquirePartMesh({ format: 'stl', bytes }, 0.05)
    const edited = await acquirePartMesh({ format: 'stl', bytes, meshEdits: [removal.record] }, 0.05)
    // the fill is 2 fans of 62 in place of 128 wall facets: fewer triangles,
    // and the same outside envelope.
    expect(edited.indices.length).toBeLessThan(plain.indices.length)
    expect(edited.bounds).toEqual(plain.bounds)
  }, 120_000)
})

describe('WO-1847: the edit rides through the resolver every route uses', () => {
  it('resolveEditedStlMesh replays it, and the re-exported bytes parse back to the same part', () => {
    const bytes = acceptancePlate()
    const removal = removeFeature(bytes, 'through-hole')
    const resolved = resolveEditedStlMesh(bytes, [removal.record])
    expect(resolved.stopped).toBeUndefined()
    expect(resolved.appliedCount).toBe(1)
    expect(resolved.mesh.indices.length).toBe(removal.mesh.indices.length)

    const round = importStl(exportBinaryStl(resolved.mesh).bytes)
    expect(round.mesh.indices.length).toBe(resolved.mesh.indices.length)
    expect(health(round.mesh).watertight).toBe(true)
    // the ids the panel highlights with are the file's own triangle numbers
    expect(resolved.sourceFacetIds.length).toBe(resolved.mesh.indices.length / 3)
    expect(sourceFacetIdsOf(resolved.mesh).length).toBe(resolved.sourceFacetIds.length)
  })
})
