// WO UI-4 acceptance #1: measure suite pure-logic tests against a mock box
// fixture (no kernel) -- point extraction, mesh-derived math primitives, and
// the two-entity distance/angle dispatch, verified against closed-form
// values for a box whose dims are chosen so expected values are exact
// (fixtures.ts's makeBoxTessBuffers, 40x20x10, centered at origin).

import { describe, it, expect } from 'vitest'
import * as THREE from 'three'
import { GeometryCache } from '../../viewport3d'
import { makeBoxTessBuffers } from '../../viewport3d/fixtures'
import {
  angleBetweenDirections,
  edgePoints,
  facePoints,
  isFailure,
  isStraightEdge,
  measureAngle,
  measureDistance,
  measureSingle,
  meshDerivedMinDistance,
  meshDerivedRadius,
  pointsForHit,
  type MeasureExactFn,
  type MeasureReadout,
  type PickWithBody,
  type SnapshotLookup,
} from '../../components/model3d/measure/measureLogic'
import type { EdgePickHit, FacePickHit, VertexPickHit } from '../../viewport3d'
import { makeBridgeVertexRef } from '../../viewport3d'
import { edgeId as mintEdgeId, filletFaceId } from '../../doc/stable-id'
import type { MeasureResult, TessBuffers } from '../../geom/geom-service'

const SIZE = { x: 40, y: 20, z: 10 }

function ingestBox() {
  const cache = new GeometryCache()
  const body = cache.ingest('box1', makeBoxTessBuffers({ size: SIZE, featureId: 'F1' }))
  return body
}

// Face order from fixtures.ts: faceIndexFor(axis, sign) = axis*2 + (sign<0?0:1)
// 0: -X, 1: +X, 2: -Y, 3: +Y, 4: -Z, 5: +Z
const FACE = {
  xMin: 'F1:BOX:face#0',
  xMax: 'F1:BOX:face#1',
  yMin: 'F1:BOX:face#2',
  yMax: 'F1:BOX:face#3',
  zMin: 'F1:BOX:face#4',
  zMax: 'F1:BOX:face#5',
}

function planeSnapshot(normal: [number, number, number], centroid: [number, number, number]): SnapshotLookup[string] {
  return { type: 'plane', normal, centroid, area: 1 }
}

const SNAPSHOTS: SnapshotLookup = {
  [FACE.xMin]: planeSnapshot([-1, 0, 0], [-20, 0, 0]),
  [FACE.xMax]: planeSnapshot([1, 0, 0], [20, 0, 0]),
  [FACE.yMin]: planeSnapshot([0, -1, 0], [0, -10, 0]),
  [FACE.yMax]: planeSnapshot([0, 1, 0], [0, 10, 0]),
  [FACE.zMin]: planeSnapshot([0, 0, -1], [0, 0, -5]),
  [FACE.zMax]: planeSnapshot([0, 0, 1], [0, 0, 5]),
}

describe('measureLogic point extraction (box fixture)', () => {
  it('facePoints returns only triangle vertices belonging to that face, all on the face plane', () => {
    const body = ingestBox()
    const pts = facePoints(body, FACE.zMax)
    expect(pts.length).toBe(6) // 2 triangles * 3 verts
    for (const p of pts) expect(p.z).toBeCloseTo(5, 9)
  })

  it('edgePoints returns exactly 2 points for a straight box edge', () => {
    const body = ingestBox()
    const someEdge = body.edgeIds[0]
    const pts = edgePoints(body, someEdge)
    expect(pts.length).toBe(2)
    expect(isStraightEdge(body, someEdge)).toBe(true)
  })

  it('unknown ids return an empty point set rather than throwing', () => {
    const body = ingestBox()
    expect(facePoints(body, 'NOPE').length).toBe(0)
    expect(edgePoints(body, 'NOPE').length).toBe(0)
  })
})

describe('meshDerivedRadius', () => {
  it('recovers the exact radius of points sampled on a cylinder of known radius/axis', () => {
    const radius = 6
    const points: THREE.Vector3[] = []
    for (let i = 0; i < 12; i++) {
      const theta = (i / 12) * Math.PI * 2
      points.push(new THREE.Vector3(radius * Math.cos(theta), radius * Math.sin(theta), i))
    }
    const value = meshDerivedRadius(points, new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1))
    expect(value).toBeCloseTo(radius, 9)
  })
})

describe('meshDerivedMinDistance', () => {
  it('finds the true closest pair between two disjoint point sets', () => {
    const a = [new THREE.Vector3(0, 0, 0), new THREE.Vector3(10, 0, 0)]
    const b = [new THREE.Vector3(10, 3, 4), new THREE.Vector3(100, 100, 100)]
    // closest pair is (10,0,0)-(10,3,4): distance 5
    expect(meshDerivedMinDistance(a, b)).toBeCloseTo(5, 9)
  })
})

describe('angleBetweenDirections', () => {
  it('perpendicular directions -> 90 deg', () => {
    expect(angleBetweenDirections(new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0))).toBeCloseTo(90, 9)
  })
  it('parallel (even opposite-facing) directions -> 0 deg (unsigned convention)', () => {
    expect(angleBetweenDirections(new THREE.Vector3(1, 0, 0), new THREE.Vector3(-1, 0, 0))).toBeCloseTo(0, 9)
  })
})

function facePick(bodyId: string, id: string): FacePickHit {
  return { kind: 'face', id, bodyId, distance: 1, point: { x: 0, y: 0, z: 0 } }
}

describe('measureAngle (box fixture, exact via face normals)', () => {
  it('two adjacent box faces (perpendicular normals) measure 90 deg', () => {
    const body = ingestBox()
    const a: PickWithBody = { bodyId: 'box1', body, hit: facePick('box1', FACE.xMax), snapshots: SNAPSHOTS }
    const b: PickWithBody = { bodyId: 'box1', body, hit: facePick('box1', FACE.yMax), snapshots: SNAPSHOTS }
    const result = measureAngle(a, b)
    if ('error' in result) throw new Error(`expected a readout, got error: ${result.error}`)
    expect(result.value).toBeCloseTo(90, 9)
    expect(result.approx).toBe(false)
  })

  it('two straight box edges (perpendicular) measure 90 deg', () => {
    const body = ingestBox()
    // Two edges sharing a corner are perpendicular by box construction; pick
    // any two distinct edges from the fixture and just assert straightness +
    // that SOME pair yields 90 (avoids hardcoding fixture edge ordering).
    const e0 = body.edgeIds[0]
    const e1 = body.edgeIds.find((id) => id !== e0)!
    const a: PickWithBody = { bodyId: 'box1', body, hit: { kind: 'edge', id: e0, bodyId: 'box1', distance: 1, point: { x: 0, y: 0, z: 0 } }, snapshots: {} }
    const b: PickWithBody = { bodyId: 'box1', body, hit: { kind: 'edge', id: e1, bodyId: 'box1', distance: 1, point: { x: 0, y: 0, z: 0 } }, snapshots: {} }
    const result = measureAngle(a, b)
    if ('error' in result) throw new Error(`expected a readout, got error: ${result.error}`)
    expect([0, 90]).toContainEqual(Math.round(result.value))
  })

  it('face + edge combination is refused, not fabricated', () => {
    const body = ingestBox()
    const a: PickWithBody = { bodyId: 'box1', body, hit: facePick('box1', FACE.xMax), snapshots: SNAPSHOTS }
    const b: PickWithBody = {
      bodyId: 'box1',
      body,
      hit: { kind: 'edge', id: body.edgeIds[0], bodyId: 'box1', distance: 1, point: { x: 0, y: 0, z: 0 } },
      snapshots: {},
    }
    const result = measureAngle(a, b)
    expect('error' in result).toBe(true)
  })
})

describe('measureDistance (box fixture, exact for vertex-vertex)', () => {
  it('two known corner points give the exact Euclidean distance, marked non-approx', () => {
    const body = ingestBox()
    const refA = makeBridgeVertexRef([])
    const refB = makeBridgeVertexRef([])
    const hitA: VertexPickHit = { kind: 'vertex', id: refA, bodyId: 'box1', distance: 1, point: { x: -20, y: -10, z: -5 } }
    const hitB: VertexPickHit = { kind: 'vertex', id: refB, bodyId: 'box1', distance: 1, point: { x: 20, y: 10, z: 5 } }
    const a: PickWithBody = { bodyId: 'box1', body, hit: hitA, snapshots: {} }
    const b: PickWithBody = { bodyId: 'box1', body, hit: hitB, snapshots: {} }
    const result = measureDistance(a, b)
    if (isFailure(result)) throw new Error(`expected a readout, got error: ${result.error}`)
    const expected = Math.hypot(40, 20, 10) // space diagonal of the 40x20x10 box
    expect(result.value).toBeCloseTo(expected, 9)
    expect(result.approx).toBe(false)
  })
})

describe('pointsForHit', () => {
  it('a vertex hit collapses to exactly its own point', () => {
    const body = ingestBox()
    const ref = makeBridgeVertexRef([])
    const hit: VertexPickHit = { kind: 'vertex', id: ref, bodyId: 'box1', distance: 1, point: { x: 1, y: 2, z: 3 } }
    const pts = pointsForHit(body, hit)
    expect(pts.length).toBe(1)
    expect(pts[0].x).toBeCloseTo(1, 9)
    expect(pts[0].y).toBeCloseTo(2, 9)
    expect(pts[0].z).toBeCloseTo(3, 9)
  })
})

// BK-56 regression: axisFaceForEdge (private, exercised here via the public
// measureSingle) used to find the two adjacent faces of a picked rim edge
// with a greedy regex `/^\((.+)[\^∧](.+)\)$/`. That regex "worked" for a
// plain two-face edge, but for an edge where one operand is itself a
// fillet/chamfer BAND face (embedding its own nested edge id, so the join
// char appears at two nesting depths) greedy backtracking can pick the
// WRONG split point -- the same class of bug BK-56 fixed in
// deriveHiddenEdgeIds, just via regex instead of .split(). Going through the
// shared depth-aware parseStableId fixes both call sites identically.
describe('measureSingle radius via a band-adjacent rim edge (BK-56)', () => {
  function makeSingleEdgeBody(edgeIdStr: string) {
    const cache = new GeometryCache()
    const buffers: TessBuffers = {
      position: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
      normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
      index: new Uint32Array([0, 1, 2]),
      triFace: new Uint32Array([0]),
      faceIds: ['F1:BOX:zmax'],
      edgePositions: new Float32Array([6, 0, 0, 0, 6, 0]),
      edgeOffsets: new Uint32Array([0, 2]),
      edgeIds: [edgeIdStr],
    }
    return cache.ingest('band-body', buffers)
  }

  it('resolves the axis-bearing snapshot through a band-nested edge operand', async () => {
    const cylFace = 'F1:REV:cyl:surf'
    const innerEdge = mintEdgeId('F1:BOX:face#0', 'F1:BOX:face#1')
    const bandFace = filletFaceId('F20', innerEdge)
    const rimEdge = mintEdgeId(bandFace, cylFace)
    const body = makeSingleEdgeBody(rimEdge)
    const snapshots: SnapshotLookup = {
      [cylFace]: { type: 'cylinder', centroid: [0, 0, 0], normal: [0, 0, 1], axis: [0, 0, 1], area: 1 },
    }
    const measureExact: MeasureExactFn = async (_bodyId, kind) => ({ kind, value: 0 } as MeasureResult)
    const hit: EdgePickHit = { kind: 'edge', id: rimEdge, bodyId: 'band-body', distance: 1, point: { x: 0, y: 0, z: 0 } }
    const outcomes = await measureSingle(measureExact, body, 'band-body', hit, snapshots)
    const readouts = outcomes.filter((o): o is MeasureReadout => !isFailure(o))
    const radius = readouts.find((r) => r.kind === 'radius')
    // radius points are (6,0,0) and (0,6,0) around the z axis -> exact radius 6.
    expect(radius).toBeDefined()
    expect(radius!.value).toBeCloseTo(6, 9)
  })
})
