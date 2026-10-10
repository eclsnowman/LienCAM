import { describe, expect, it } from 'vitest'
import { GeometryCache } from '../../viewport3d'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'
import {
  EDGE_POLYLINE_REFUSAL_REASONS,
  FACE_BOUNDARY_LOOPS_REFUSAL_REASONS,
  edgePolyline,
  faceBoundaryLoops,
  faceOuterBoundaryLoop,
  type EdgePolylineRefusalReason,
  type EdgePolylineResult,
  type FaceBoundaryLoopsRefusalReason,
  type FaceBoundaryLoopsResult,
} from '../../components/model3d/workbench/faceBoundary'
import { edgeIdCollisions } from '../../components/model3d/measure/edgeIdCollisions'
import { EDGE_JOIN } from '../../doc/stable-id'
import { worldToLocal } from '../../sketch3d/planeMath'
import type { PlaneFrame } from '../../sketch3d/planeMath'
import type { TessBuffers } from '../../geom/geom-service'

// Shared face/edge projection extraction, including the legacy outer-loop
// compatibility seam used only when old nonempty external refs are reattached.
// Uses the SAME mock box fixture (viewport3d/fixtures.ts) the picking/
// highlight test suites already trust, per this codebase's own convention
// (no kernel dependency for a pure boundary-chaining test).
//
// GEO-16 Fold 1: faceOuterBoundaryLoop now returns a DISCRIMINATED result
// (FaceBoundaryResult) so a HARMFUL edge-id-collision refusal is distinguished
// from a benign no-clean-loop, and the caller can name the cause. The collision
// fixture below is MUTATION-PROVABLE: removing the collision guard line flips the
// discriminant from 'edge-id-collision' to 'no-clean-loop', failing the assert
// (the GEO-15-R1 held-MAJOR fixture could not, because both refusals were bare
// `undefined`).

describe('faceOuterBoundaryLoop', () => {
  it('chains a box face\'s 4 edges into one closed 4-point loop', () => {
    const size = { x: 40, y: 20, z: 10 }
    const tess = makeBoxTessBuffers({ size, center: { x: 0, y: 0, z: 0 }, featureId: 'F1' })
    const cache = new GeometryCache()
    const body = cache.ingest('box1', tess)

    // Face #5 is +Z (see fixtures.ts's faceIndexFor: axis*2 + (sign<0?0:1), axis 2 = z).
    const topFaceId = 'F1:BOX:face#5'
    const frame: PlaneFrame = { origin: { x: 0, y: 0, z: size.z / 2 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
    const res = faceOuterBoundaryLoop(body, topFaceId, (p) => worldToLocal(frame, p))
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected a clean boundary loop')
    const loop = res.loop
    expect(loop.length).toBe(4)
    for (const p of loop) expect(p.z).toBeCloseTo(size.z / 2, 6)
    // The 4 corners should span the face's known extents.
    const xs = loop.map((p) => p.x).sort((a, b) => a - b)
    const ys = loop.map((p) => p.y).sort((a, b) => a - b)
    expect(xs[0]).toBeCloseTo(-size.x / 2, 6)
    expect(xs[3]).toBeCloseTo(size.x / 2, 6)
    expect(ys[0]).toBeCloseTo(-size.y / 2, 6)
    expect(ys[3]).toBeCloseTo(size.y / 2, 6)
  })

  it('refuses (no-clean-loop) for a face id with no edges (never throws)', () => {
    const tess = makeBoxTessBuffers({ featureId: 'F1' })
    const cache = new GeometryCache()
    const body = cache.ingest('box1', tess)
    const frame: PlaneFrame = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
    const res = faceOuterBoundaryLoop(body, 'F1:BOX:face#99', (p) => worldToLocal(frame, p))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.reason).toBe('no-clean-loop')
  })

  const frame: PlaneFrame = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }

  // GEO-16 Fold 1 (guard-killing fixture -- MUTATION PROVABLE): one of face#0's
  // boundary edges is a COLLIDING stable id (two physical edges named `dup`). WITH
  // the collision guard the result is the discriminated 'edge-id-collision'
  // naming the id + count; WITHOUT the guard the duplicate-segment boundary falls
  // through to chainIntoLoops, which rejects the degree-broken vertices and
  // yields 'no-clean-loop'. The two discriminants differ, so deleting the guard
  // line fails the `reason === 'edge-id-collision'` assert. (The pre-GEO-16
  // fixture asserted only `undefined`, which BOTH paths returned -- hence the
  // GEO-15-R1 held major.)
  it('refuses with a NAMED edge-id-collision when a boundary edge of the queried face is a colliding id', () => {
    const dup = `(F1:BOX:face#0${EDGE_JOIN}F1:BOX:face#1)`
    const other = `(F1:BOX:face#0${EDGE_JOIN}F1:BOX:face#2)`
    const buffers: TessBuffers = {
      position: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
      normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      index: new Uint32Array([0, 1, 2]),
      triFace: new Uint32Array([0]),
      faceIds: ['F1:BOX:face#0'],
      edgePositions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 0, 0, 10, 0, 10, 0, 0, 0, 10, 0]),
      edgeOffsets: new Uint32Array([0, 2, 4, 6]),
      edgeIds: [dup, dup, other], // two physical edges named `dup` -> boundary collision on face#0
    }
    const body = new GeometryCache().ingest('dup-boundary', buffers)
    // The collision the guard keys on is observable through the shared helper
    // (this line also fails if edgeIdCollisions is neutered).
    expect(edgeIdCollisions(body.edgeIds, [dup]).length).toBeGreaterThan(0)

    const res = faceOuterBoundaryLoop(body, 'F1:BOX:face#0', (p) => worldToLocal(frame, p))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    // The DISCRIMINANT is the mutation lever: 'edge-id-collision', NOT the
    // generic 'no-clean-loop' the without-guard path returns.
    expect(res.reason).toBe('edge-id-collision')
    if (res.reason !== 'edge-id-collision') throw new Error('unreachable')
    // ...and it names the colliding id + count for the caller's notification.
    expect(res.collisions.map((c) => c.id)).toContain(dup)
    expect(res.collisions.find((c) => c.id === dup)!.count).toBe(2)
  })

  it('a collision NOT on the queried face\'s boundary does not block it (a collision you did not pick)', () => {
    const size = { x: 40, y: 20, z: 10 }
    const tess = makeBoxTessBuffers({ size, featureId: 'F1' })
    // A duplicate edge naming faces #0/#1 (both x-side faces) -- never one of
    // face#5's (+Z) boundary edges, which pair face#5 with the side faces.
    const foreignDup = `(F1:BOX:face#0${EDGE_JOIN}F1:BOX:face#1)`
    const last = tess.edgeOffsets[tess.edgeOffsets.length - 1]
    const body = new GeometryCache().ingest('box-foreign-dup', {
      ...tess,
      edgePositions: new Float32Array([...tess.edgePositions, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0]),
      edgeOffsets: new Uint32Array([...tess.edgeOffsets, last + 2, last + 4]),
      edgeIds: [...tess.edgeIds, foreignDup, foreignDup],
    })
    // The body genuinely carries the collision...
    expect(edgeIdCollisions(body.edgeIds, [foreignDup]).length).toBeGreaterThan(0)
    // ...yet face#5's boundary (which does not include it) still resolves cleanly.
    const res = faceOuterBoundaryLoop(body, 'F1:BOX:face#5', (p) => worldToLocal(frame, p))
    expect(res.ok).toBe(true)
    if (!res.ok) throw new Error('expected a clean boundary loop')
    expect(res.loop.length).toBe(4)
  })
})

function faceWithHoleBuffers(): { buffers: TessBuffers; faceId: string; outerEdgeId: string } {
  const faceId = 'F1:FACE:face#0'
  const outer = [
    [-10, -10, 0, 10, -10, 0],
    [10, -10, 0, 10, 10, 0],
    [10, 10, 0, -10, 10, 0],
    [-10, 10, 0, -10, -10, 0],
  ]
  const inner = [
    [-2, -2, 0, 2, -2, 0],
    [2, -2, 0, 2, 2, 0],
    [2, 2, 0, -2, 2, 0],
    [-2, 2, 0, -2, -2, 0],
  ]
  const edges = [...outer, ...inner]
  const edgeIds = edges.map((_, index) => `(${faceId}${EDGE_JOIN}F1:FACE:face#${index + 1})`)
  return {
    faceId,
    outerEdgeId: edgeIds[0],
    buffers: {
      position: new Float32Array([-10, -10, 0, 10, -10, 0, 10, 10, 0]),
      normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      index: new Uint32Array([0, 1, 2]),
      triFace: new Uint32Array([0]),
      faceIds: [faceId],
      edgePositions: new Float32Array(edges.flat()),
      edgeOffsets: new Uint32Array(edges.map((_, index) => index * 2).concat(edges.length * 2)),
      edgeIds,
    },
  }
}

describe('all-loop and edge extraction', () => {
  const projectXY = (p: { x: number; y: number }) => ({ x: p.x, y: p.y })

  it('returns a face outer loop plus its hole, outer first', () => {
    const fixture = faceWithHoleBuffers()
    const body = new GeometryCache().ingest('face-with-hole', fixture.buffers)
    const result = faceBoundaryLoops(body, fixture.faceId, projectXY)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected refusal: ${result.reason}`)
    expect(result.loops).toHaveLength(2)
    expect(result.loops.map((loop) => loop.length)).toEqual([4, 4])
    const areas = result.loops.map((loop) => Math.abs(loop.reduce((sum, point, index) => {
      const next = loop[(index + 1) % loop.length]
      return sum + point.x * next.y - next.x * point.y
    }, 0) / 2))
    expect(areas).toEqual([400, 16])
  })

  it('returns one open cached edge polyline without adding a closing point', () => {
    const fixture = faceWithHoleBuffers()
    const body = new GeometryCache().ingest('edge-source', fixture.buffers)
    const result = edgePolyline(body, fixture.outerEdgeId, projectXY)
    expect(result.ok).toBe(true)
    if (!result.ok) throw new Error(`unexpected refusal: ${result.reason}`)
    expect(result.points).toEqual([
      { x: -10, y: -10, z: 0 },
      { x: 10, y: -10, z: 0 },
    ])
  })

  it('refuses non-finite and projected-collapsed edge data by name', () => {
    const fixture = faceWithHoleBuffers()
    const body = new GeometryCache().ingest('invalid-edge', fixture.buffers)
    body.edgePositions[0] = Number.NaN
    const nonFinite = edgePolyline(body, fixture.outerEdgeId, projectXY)
    expect(nonFinite).toMatchObject({ ok: false, reason: 'non-finite-point' })

    body.edgePositions[0] = -10
    const collapsed = edgePolyline(body, fixture.outerEdgeId, () => ({ x: 0, y: 0 }))
    expect(collapsed).toMatchObject({ ok: false, reason: 'collapsed-projection' })
  })

  it('refuses an unchainable face without returning a partial outer loop', () => {
    const fixture = faceWithHoleBuffers()
    const body = new GeometryCache().ingest('broken-face', fixture.buffers)
    // Break one outer endpoint so its two incident vertices have degree one.
    body.edgePositions[3] = 9
    const result = faceBoundaryLoops(body, fixture.faceId, projectXY)
    expect(result).toMatchObject({ ok: false, reason: 'unchainable-face' })
  })
})

type EdgeRefusalFixture = () => EdgePolylineResult
type FaceRefusalFixture = () => FaceBoundaryLoopsResult

function duplicateEdgeFixture() {
  const fixture = faceWithHoleBuffers()
  const start = fixture.buffers.edgeOffsets[0]
  const end = fixture.buffers.edgeOffsets[1]
  const duplicatePoints = fixture.buffers.edgePositions.slice(start * 3, end * 3)
  const edgePositions = new Float32Array(fixture.buffers.edgePositions.length + duplicatePoints.length)
  edgePositions.set(fixture.buffers.edgePositions)
  edgePositions.set(duplicatePoints, fixture.buffers.edgePositions.length)
  const edgeOffsets = new Uint32Array(fixture.buffers.edgeOffsets.length + 1)
  edgeOffsets.set(fixture.buffers.edgeOffsets)
  edgeOffsets[edgeOffsets.length - 1] = fixture.buffers.edgeOffsets[fixture.buffers.edgeOffsets.length - 1] + (end - start)
  return {
    ...fixture,
    buffers: {
      ...fixture.buffers,
      edgePositions,
      edgeOffsets,
      edgeIds: [...fixture.buffers.edgeIds, fixture.outerEdgeId],
    },
  }
}

function degenerateFaceLoopFixture(): { body: ReturnType<GeometryCache['ingest']>; faceId: string } {
  const faceId = 'F1:FACE:face#0'
  const edgeA = `(${faceId}${EDGE_JOIN}F1:FACE:face#1)`
  const edgeB = `(${faceId}${EDGE_JOIN}F1:FACE:face#2)`
  const buffers: TessBuffers = {
    position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    index: new Uint32Array([0, 1, 2]),
    triFace: new Uint32Array([0]),
    faceIds: [faceId],
    // Two differently named A-B edges form a closed chain with only two
    // distinct vertices. This reaches degenerate-face-loop after chaining.
    edgePositions: new Float32Array([0, 0, 0, 10, 0, 0, 0, 0, 0, 10, 0, 0]),
    edgeOffsets: new Uint32Array([0, 2, 4]),
    edgeIds: [edgeA, edgeB],
  }
  return { body: new GeometryCache().ingest('degenerate-face-loop', buffers), faceId }
}

const projectXY = (point: { x: number; y: number }) => ({ x: point.x, y: point.y })

const edgeRefusalFixtures = {
  'edge-not-found': () => {
    const fixture = faceWithHoleBuffers()
    return edgePolyline(new GeometryCache().ingest('edge-not-found', fixture.buffers), 'missing-edge', projectXY)
  },
  'edge-id-collision': () => {
    const fixture = duplicateEdgeFixture()
    return edgePolyline(new GeometryCache().ingest('edge-collision', fixture.buffers), fixture.outerEdgeId, projectXY)
  },
  'non-finite-point': () => {
    const fixture = faceWithHoleBuffers()
    const body = new GeometryCache().ingest('edge-non-finite', fixture.buffers)
    body.edgePositions[0] = Number.NaN
    return edgePolyline(body, fixture.outerEdgeId, projectXY)
  },
  'degenerate-edge': () => {
    const fixture = faceWithHoleBuffers()
    const body = new GeometryCache().ingest('edge-degenerate', fixture.buffers)
    body.edgePositions.set(body.edgePositions.slice(0, 3), 3)
    return edgePolyline(body, fixture.outerEdgeId, projectXY)
  },
  'collapsed-projection': () => {
    const fixture = faceWithHoleBuffers()
    return edgePolyline(
      new GeometryCache().ingest('edge-collapsed', fixture.buffers),
      fixture.outerEdgeId,
      () => ({ x: 0, y: 0 }),
    )
  },
} satisfies Record<EdgePolylineRefusalReason, EdgeRefusalFixture>

const faceRefusalFixtures = {
  'edge-id-collision': () => {
    const fixture = duplicateEdgeFixture()
    return faceBoundaryLoops(new GeometryCache().ingest('face-collision', fixture.buffers), fixture.faceId, projectXY)
  },
  'no-boundary-edges': () => {
    const fixture = faceWithHoleBuffers()
    return faceBoundaryLoops(new GeometryCache().ingest('face-no-edges', fixture.buffers), 'missing-face', projectXY)
  },
  'non-finite-point': () => {
    const fixture = faceWithHoleBuffers()
    const body = new GeometryCache().ingest('face-non-finite', fixture.buffers)
    body.edgePositions[0] = Number.NaN
    return faceBoundaryLoops(body, fixture.faceId, projectXY)
  },
  'degenerate-edge': () => {
    const fixture = faceWithHoleBuffers()
    const body = new GeometryCache().ingest('face-degenerate-edge', fixture.buffers)
    body.edgePositions.set(body.edgePositions.slice(0, 3), 3)
    return faceBoundaryLoops(body, fixture.faceId, projectXY)
  },
  'unchainable-face': () => {
    const fixture = faceWithHoleBuffers()
    const body = new GeometryCache().ingest('face-unchainable', fixture.buffers)
    body.edgePositions[3] = 9
    return faceBoundaryLoops(body, fixture.faceId, projectXY)
  },
  'degenerate-face-loop': () => {
    const fixture = degenerateFaceLoopFixture()
    return faceBoundaryLoops(fixture.body, fixture.faceId, projectXY)
  },
  'collapsed-projection': () => {
    const fixture = faceWithHoleBuffers()
    return faceBoundaryLoops(
      new GeometryCache().ingest('face-collapsed', fixture.buffers),
      fixture.faceId,
      (point) => ({ x: point.x, y: 0 }),
    )
  },
} satisfies Record<FaceBoundaryLoopsRefusalReason, FaceRefusalFixture>

describe('derived exhaustive extraction refusal census', () => {
  it('fixture keys exactly match both production refusal domains', () => {
    expect(Object.keys(edgeRefusalFixtures).sort()).toEqual([...EDGE_POLYLINE_REFUSAL_REASONS].sort())
    expect(Object.keys(faceRefusalFixtures).sort()).toEqual([...FACE_BOUNDARY_LOOPS_REFUSAL_REASONS].sort())
  })

  it.each(EDGE_POLYLINE_REFUSAL_REASONS)('edgePolyline refuses %s by name', (reason) => {
    const result = edgeRefusalFixtures[reason]()
    expect(result).toMatchObject({ ok: false, reason })
  })

  it.each(FACE_BOUNDARY_LOOPS_REFUSAL_REASONS)('faceBoundaryLoops refuses %s by name', (reason) => {
    const result = faceRefusalFixtures[reason]()
    expect(result).toMatchObject({ ok: false, reason })
  })
})
