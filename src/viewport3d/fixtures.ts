// viewport3d: mock TessBuffers fixtures (WO UI-1 -- no kernel dependency).
//
// Every body in this WO's test suite comes from here, never from a real
// GeomService.tessellate() call (that's UI-2's job once GEO lane lands the
// worker). Mirrors the per-op id patterns in docs/stable-id-spec.md closely
// enough to exercise the picking/highlight code paths realistically, without
// claiming to BE the production id grammar (only the Document Service mints
// real document ids; this bridge only resolves picks to whatever ids are
// already present in the tessellation it was handed).

import type { TessBuffers } from '../geom/geom-service'
import { EDGE_JOIN } from '../doc/stable-id'

export interface BoxFixtureOptions {
  /** Full extents in mm. */
  size?: { x: number; y: number; z: number }
  /** Center of the box in world coords. */
  center?: { x: number; y: number; z: number }
  featureId?: string
}

export interface FilletedStepEdgeFixture {
  buffers: TessBuffers
  samples: Array<[number, number, number]>
}

const AXES = ['x', 'y', 'z'] as const

/** Face order: -X, +X, -Y, +Y, -Z, +Z. */
function faceIndexFor(axis: 0 | 1 | 2, sign: -1 | 1): number {
  return axis * 2 + (sign < 0 ? 0 : 1)
}

/**
 * A single mock box body: 6 faces (2 triangles each, per-face-unique
 * vertices so flat normals never blend across a hard edge -- the standard
 * way a B-rep kernel tessellates a planar-faced solid), 12 straight edges,
 * 8 corners (derivable by PickEngine's vertex-merge from the edge
 * endpoints). Winding is derived programmatically (cross product checked
 * against the known outward normal) rather than hand-verified, so a
 * transcription slip can't silently flip a face inside-out.
 */
export function makeBoxTessBuffers(opts: BoxFixtureOptions = {}): TessBuffers {
  const size = opts.size ?? { x: 40, y: 20, z: 10 }
  const center = opts.center ?? { x: 0, y: 0, z: 0 }
  const featureId = opts.featureId ?? 'F1'
  const half = [size.x / 2, size.y / 2, size.z / 2]

  const faceIds: string[] = []
  for (let f = 0; f < 6; f++) faceIds.push(`${featureId}:BOX:face#${f}`)

  const positions: number[] = []
  const normals: number[] = []
  const index: number[] = []
  const triFace: number[] = []

  // corner(axis fixed at sign*half[axis], other two axes at bSign/cSign)
  function corner(axis: 0 | 1 | 2, sign: -1 | 1, b: 0 | 1 | 2, bSign: -1 | 1, c: 0 | 1 | 2, cSign: -1 | 1): [number, number, number] {
    const p: [number, number, number] = [0, 0, 0]
    p[axis] = sign * half[axis]
    p[b] = bSign * half[b]
    p[c] = cSign * half[c]
    return p
  }

  for (let axis = 0 as 0 | 1 | 2; axis < 3; axis++) {
    const [b, c] = AXES.map((_, i) => i).filter((i) => i !== axis) as [0 | 1 | 2, 0 | 1 | 2]
    for (const sign of [-1, 1] as const) {
      const face = faceIndexFor(axis, sign)
      const outward: [number, number, number] = [0, 0, 0]
      outward[axis] = sign

      // Four corners of the quad, angle-sorted around its own center so they
      // form a simple (non-self-intersecting) loop regardless of axis choice.
      const raw: Array<[number, number, number]> = [
        corner(axis, sign, b, -1, c, -1),
        corner(axis, sign, b, 1, c, -1),
        corner(axis, sign, b, 1, c, 1),
        corner(axis, sign, b, -1, c, 1),
      ]
      const sorted = [...raw].sort((p, q) => Math.atan2(p[c], p[b]) - Math.atan2(q[c], q[b]))

      // Fix winding: cross(v1-v0, v2-v0) must point along `outward`.
      const v0 = sorted[0]
      const v1 = sorted[1]
      const v2 = sorted[2]
      const e1 = [v1[0] - v0[0], v1[1] - v0[1], v1[2] - v0[2]]
      const e2 = [v2[0] - v0[0], v2[1] - v0[1], v2[2] - v0[2]]
      const cross = [
        e1[1] * e2[2] - e1[2] * e2[1],
        e1[2] * e2[0] - e1[0] * e2[2],
        e1[0] * e2[1] - e1[1] * e2[0],
      ]
      const dot = cross[0] * outward[0] + cross[1] * outward[1] + cross[2] * outward[2]
      const quad = dot < 0 ? [sorted[0], sorted[3], sorted[2], sorted[1]] : sorted

      const base = positions.length / 3
      for (const p of quad) {
        positions.push(p[0] + center.x, p[1] + center.y, p[2] + center.z)
        normals.push(outward[0], outward[1], outward[2])
      }
      index.push(base, base + 1, base + 2, base, base + 2, base + 3)
      triFace.push(face, face)
    }
  }

  // 12 edges, hardcoded from box topology: a "varying-<axis>" edge holds the
  // other two axes fixed at a sign each; its two adjacent faces are the
  // faces of those other two axes (see fixtures.ts header + stable-id-spec
  // "unordered pair of adjacent face IDs" edge-id shape).
  const edgePositions: number[] = []
  const edgeOffsets: number[] = [0]
  const edgeIds: string[] = []

  function pushEdge(p0: [number, number, number], p1: [number, number, number], faceA: number, faceB: number): void {
    const idA = faceIds[faceA]
    const idB = faceIds[faceB]
    const [lo, hi] = idA < idB ? [idA, idB] : [idB, idA]
    // Spec joiner (EDGE_JOIN, docs/stable-id-spec.md), not an ASCII stand-in
    // -- R1.2 rework: UI4Demo's isolate/hide fix derives hidden edges by
    // parsing this id back into its adjacent face pair, same as production
    // (src/geom/worker/stable-id.ts's edgeId()), so this mock must emit the
    // real joiner too.
    edgeIds.push(`(${lo}${EDGE_JOIN}${hi})`)
    edgePositions.push(p0[0] + center.x, p0[1] + center.y, p0[2] + center.z)
    edgePositions.push(p1[0] + center.x, p1[1] + center.y, p1[2] + center.z)
    edgeOffsets.push(edgeOffsets[edgeOffsets.length - 1] + 2)
  }

  for (let axis = 0 as 0 | 1 | 2; axis < 3; axis++) {
    const [b, c] = AXES.map((_, i) => i).filter((i) => i !== axis) as [0 | 1 | 2, 0 | 1 | 2]
    for (const bSign of [-1, 1] as const) {
      for (const cSign of [-1, 1] as const) {
        const p0: [number, number, number] = [0, 0, 0]
        p0[axis] = -half[axis]
        p0[b] = bSign * half[b]
        p0[c] = cSign * half[c]
        const p1: [number, number, number] = [...p0] as [number, number, number]
        p1[axis] = half[axis]
        const faceB = faceIndexFor(b, bSign)
        const faceC = faceIndexFor(c, cSign)
        pushEdge(p0, p1, faceB, faceC)
      }
    }
  }

  return {
    position: new Float32Array(positions),
    normal: new Float32Array(normals),
    index: new Uint32Array(index),
    triFace: new Uint32Array(triFace),
    faceIds,
    edgePositions: new Float32Array(edgePositions),
    edgeOffsets: new Uint32Array(edgeOffsets),
    edgeIds,
  }
}

/** Supplied-shape-equivalent topology stress fixture: 27 edge groups,
 * including six 20-segment curves. Its 168 source points must expand to
 * exactly 141 independent rendered segments without cross-edge joins. */
export function makeFilletedStepEdgeFixture(): FilletedStepEdgeFixture {
  const edgePositions: number[] = []
  const edgeOffsets: number[] = []
  const edgeIds: string[] = []
  const samples: Array<[number, number, number]> = []
  for (let edge = 0; edge < 27; edge += 1) {
    edgeOffsets.push(edgePositions.length / 3)
    edgeIds.push(`filleted-step-edge-${edge}`)
    if (edge < 21) {
      const y = edge * 10
      edgePositions.push(0, y, 0, 10, y, 0)
      samples.push([5, y, 0])
      continue
    }
    const y = 300 + (edge - 21) * 10
    for (let point = 0; point < 21; point += 1) {
      const angle = (point / 20) * (Math.PI / 2)
      edgePositions.push(2 * Math.cos(angle), y, 2 * Math.sin(angle))
    }
    samples.push([Math.SQRT2, y, Math.SQRT2])
  }
  edgeOffsets.push(edgePositions.length / 3)
  return {
    samples,
    buffers: {
      position: new Float32Array([0, 0, -10, 1, 0, -10, 0, 1, -10]),
      normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      index: new Uint32Array([0, 1, 2]),
      triFace: new Uint32Array([0]),
      faceIds: ['filleted-step-face'],
      edgePositions: new Float32Array(edgePositions),
      edgeOffsets: new Uint32Array(edgeOffsets),
      edgeIds,
    },
  }
}

/**
 * A large single-face flat grid, >= the requested triangle count, for the
 * BVH-build + raycast performance guard (acceptance #5). One face, no
 * edges -- the perf test only exercises face picking, and a real body's
 * edge count is orders of magnitude below its triangle count anyway (see
 * PickEngine.ts header), so this fixture's edge/vertex arrays are
 * legitimately empty rather than a scope cut.
 */
export function makeLargeGridTessBuffers(minTriangleCount = 100_000, featureId = 'F1'): TessBuffers {
  const n = Math.ceil(Math.sqrt(minTriangleCount / 2))
  const verts = n + 1
  const size = 1000 // mm, arbitrary
  const step = size / n

  const position = new Float32Array(verts * verts * 3)
  const normal = new Float32Array(verts * verts * 3)
  for (let iy = 0; iy <= n; iy++) {
    for (let ix = 0; ix <= n; ix++) {
      const vi = iy * verts + ix
      position[vi * 3] = ix * step - size / 2
      position[vi * 3 + 1] = iy * step - size / 2
      position[vi * 3 + 2] = 0
      normal[vi * 3] = 0
      normal[vi * 3 + 1] = 0
      normal[vi * 3 + 2] = 1
    }
  }

  const triCount = n * n * 2
  const index = new Uint32Array(triCount * 3)
  const triFace = new Uint32Array(triCount)
  let t = 0
  for (let iy = 0; iy < n; iy++) {
    for (let ix = 0; ix < n; ix++) {
      const a = iy * verts + ix
      const b = a + 1
      const c = a + verts
      const d = c + 1
      index[t * 3] = a
      index[t * 3 + 1] = b
      index[t * 3 + 2] = c
      triFace[t] = 0
      t++
      index[t * 3] = b
      index[t * 3 + 1] = d
      index[t * 3 + 2] = c
      triFace[t] = 0
      t++
    }
  }

  return {
    position,
    normal,
    index,
    triFace,
    faceIds: [`${featureId}:GRID:face#0`],
    edgePositions: new Float32Array(0),
    edgeOffsets: new Uint32Array([0]),
    edgeIds: [],
  }
}
