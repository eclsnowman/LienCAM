// GEO-15-R1 (ICR-3 step 1) -- UI-side picked-edge-id collision guards.
//
// The audit (GEO-15.audit.json finding 1) found the original census omitted the
// UI-side pick->id->operation resolvers: measureLogic's edgePoints /
// isStraightEdge collapse a duplicate stable id to the FIRST physical polyline
// via body.edgeIds.indexOf, so measureSingle / measureDistance / measureAngle
// silently computed against the wrong physical twin. This suite pins the fix:
// a PICKED edge id that is duplicated on the body refuses BY NAME through
// measure's structured MeasureFailure (never a throw, never first-wins), while a
// UNIQUE pick on the SAME collision-carrying body still succeeds ("a collision
// you did not pick is not your problem").
//
// Pure-logic (no kernel): a hand-built mock CachedBody carrying a duplicate edge
// id -- the same shape the worker fixture (edge-id-collision.test.ts) proves on
// the real occt-wasm kernel, here isolated to the UI resolvers.

import { describe, expect, it } from 'vitest'
import { GeometryCache } from '../../viewport3d'
import type { EdgePickHit, VertexPickHit } from '../../viewport3d'
import { makeBridgeVertexRef } from '../../viewport3d'
import {
  isFailure,
  measureAngle,
  measureDistance,
  measureSingle,
  type MeasureExactFn,
  type PickWithBody,
} from '../../components/model3d/measure/measureLogic'
import { edgeIdCollisions } from '../../components/model3d/measure/edgeIdCollisions'
import { EDGE_JOIN } from '../../doc/stable-id'
import type { TessBuffers } from '../../geom/geom-service'

// Two edges carry DUP (a genuine face-pair-collapse collision); UNIQUE is a
// single physical edge on the SAME body.
const DUP = `(F1:BOX:face#0${EDGE_JOIN}F1:BOX:face#1)`
const UNIQUE = `(F1:BOX:face#2${EDGE_JOIN}F1:BOX:face#3)`

/** Mock body: one triangle face + three edges, two of which share DUP. */
function makeDupEdgeBody() {
  const cache = new GeometryCache()
  const buffers: TessBuffers = {
    position: new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 0]),
    normal: new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]),
    index: new Uint32Array([0, 1, 2]),
    triFace: new Uint32Array([0]),
    faceIds: ['F1:BOX:face#0'],
    // edge0 (DUP): (0,0,0)->(10,0,0); edge1 (DUP twin): (0,0,0)->(0,10,0);
    // edge2 (UNIQUE): (10,0,0)->(0,10,0). Distinct geometry, edges 0 & 1 share id.
    edgePositions: new Float32Array([
      0, 0, 0, 10, 0, 0,
      0, 0, 0, 0, 10, 0,
      10, 0, 0, 0, 10, 0,
    ]),
    edgeOffsets: new Uint32Array([0, 2, 4, 6]),
    edgeIds: [DUP, DUP, UNIQUE],
  }
  return cache.ingest('dup-body', buffers)
}

function edgeHit(id: string): EdgePickHit {
  return { kind: 'edge', id, bodyId: 'dup-body', distance: 1, point: { x: 0, y: 0, z: 0 } }
}

describe('GEO-15-R1 UI edge-id collision guards (measureLogic)', () => {
  it('edgeIdCollisions flags only the PICKED colliding id, never a collision the caller did not pick', () => {
    const body = makeDupEdgeBody()
    const picked = edgeIdCollisions(body.edgeIds, [DUP])
    expect(picked).toHaveLength(1)
    expect(picked[0].id).toBe(DUP)
    expect(picked[0].count).toBe(2)
    // A unique pick is never flagged, even though DUP collides elsewhere.
    expect(edgeIdCollisions(body.edgeIds, [UNIQUE])).toHaveLength(0)
  })

  it('measureSingle refuses a COLLIDING edge pick BY NAME, structurally, without ever calling the worker (no throw, no first-wins)', async () => {
    const body = makeDupEdgeBody()
    let workerCalls = 0
    const measureExact: MeasureExactFn = async (_bodyId, kind) => {
      workerCalls++
      return { kind, value: 123 }
    }
    const out = await measureSingle(measureExact, body, 'dup-body', edgeHit(DUP), {})
    expect(out).toHaveLength(1)
    expect(isFailure(out[0])).toBe(true)
    if (isFailure(out[0])) {
      expect(out[0].error).toContain(DUP)
      expect(out[0].error).toContain('2 distinct edges')
      expect(out[0].error.toLowerCase()).toContain('refus')
    }
    // The guard fired BEFORE any worker call -- proves it is not a first-wins
    // measurement of the wrong twin, and not a thrown error caught downstream.
    expect(workerCalls).toBe(0)
  })

  it('measureSingle does NOT over-refuse a UNIQUE edge pick on the same collision-carrying body', async () => {
    const body = makeDupEdgeBody()
    const measureExact: MeasureExactFn = async (_bodyId, kind) => ({ kind, value: 7 })
    const out = await measureSingle(measureExact, body, 'dup-body', edgeHit(UNIQUE), {})
    expect(out.some((o) => !isFailure(o) && o.kind === 'length')).toBe(true)
    expect(out.every((o) => !isFailure(o))).toBe(true)
  })

  it('measureDistance refuses when EITHER picked edge collides, and names it', () => {
    const body = makeDupEdgeBody()
    const a: PickWithBody = { bodyId: 'dup-body', body, hit: edgeHit(DUP), snapshots: {} }
    const b: PickWithBody = { bodyId: 'dup-body', body, hit: edgeHit(UNIQUE), snapshots: {} }
    const result = measureDistance(a, b)
    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) expect(result.error).toContain(DUP)
  })

  it('measureDistance does NOT over-refuse: a unique edge + a vertex on a collision-carrying body succeeds', () => {
    const body = makeDupEdgeBody()
    const vertexHit: VertexPickHit = { kind: 'vertex', id: makeBridgeVertexRef([]), bodyId: 'dup-body', distance: 1, point: { x: 0, y: 0, z: 0 } }
    const a: PickWithBody = { bodyId: 'dup-body', body, hit: edgeHit(UNIQUE), snapshots: {} }
    const b: PickWithBody = { bodyId: 'dup-body', body, hit: vertexHit, snapshots: {} }
    const result = measureDistance(a, b)
    expect(isFailure(result)).toBe(false)
  })

  it('measureAngle refuses two colliding edges, and names the collision', () => {
    const body = makeDupEdgeBody()
    const a: PickWithBody = { bodyId: 'dup-body', body, hit: edgeHit(DUP), snapshots: {} }
    const b: PickWithBody = { bodyId: 'dup-body', body, hit: edgeHit(DUP), snapshots: {} }
    const result = measureAngle(a, b)
    expect(isFailure(result)).toBe(true)
    if (isFailure(result)) expect(result.error).toContain(DUP)
  })

  it('measureAngle does NOT report a COLLISION failure for two unique straight edges (guard is precise)', () => {
    const body = makeDupEdgeBody()
    const a: PickWithBody = { bodyId: 'dup-body', body, hit: edgeHit(UNIQUE), snapshots: {} }
    const b: PickWithBody = { bodyId: 'dup-body', body, hit: edgeHit(UNIQUE), snapshots: {} }
    const result = measureAngle(a, b)
    // Same unique edge both sides -> angle 0, a real readout (never a collision
    // refusal). If it does fail for another reason it must NOT be the collision.
    if (isFailure(result)) expect(result.error).not.toContain('distinct edges')
    else expect(result.kind).toBe('angle')
  })
})
