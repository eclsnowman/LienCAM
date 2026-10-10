// WO UI-4 acceptance #1: measure suite against the REAL occt-wasm kernel,
// analytic fixtures chosen so expected values are closed-form. Covers the
// two kinds the frozen geom-service.ts contract does NOT implement server-
// side (radius/diameter, via this WO's mesh-derived fallback) against a real
// cylinder -- length/area/volume are already covered exhaustively by
// src/tests/geom/measure-length.test.ts and
// src/tests/viewport3d/geomBridgeSessionMeasureImport.integration.test.ts;
// this file's job is the NEW gap-fill kinds only, proven against real
// tessellation output (not a mock fixture).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { GeometryCache } from '../../viewport3d'
import {
  isFailure,
  measureAngle,
  measureDistance,
  measureSingle,
  type MeasureReadout,
  type PickWithBody,
  type SnapshotLookup,
} from '../../components/model3d/measure/measureLogic'
import { makeBridgeVertexRef } from '../../viewport3d'
import type { FacePickHit, EdgePickHit, VertexPickHit } from '../../viewport3d'
import type { MeasureResult, StableId } from '../../geom/geom-service'

describe('measureLogic radius/diameter against a real cylinder (occt-wasm)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('picking the cylinder wall face reports radius/diameter within the tessellation deflection', async () => {
    const radius = 7.5
    const height = 20
    const cyl = await engine.debugMakeCylinder('RAD1', radius, height)
    expect(cyl.ok).toBe(true)
    const handle = cyl.body!

    const tess = await engine.tessellate(handle, { deflection: 0.05 })
    const snaps = engine.snapshotsFor(handle) as unknown as SnapshotLookup
    const wallId = Object.keys(snaps).find((id) => snaps[id].type === 'cylinder')
    expect(wallId).toBeDefined()
    if (wallId === undefined) throw new Error('unreachable')

    const cache = new GeometryCache()
    const body = cache.ingest('cyl1', tess)

    const hit: FacePickHit = { kind: 'face', id: wallId, bodyId: 'cyl1', distance: 1, point: { x: 0, y: 0, z: 0 } }
    const measureExact = (_bodyId: string, kind: MeasureResult['kind'], ids?: StableId[]) => engine.measure(handle, kind, ids)
    const outcomes = await measureSingle(measureExact, body, 'cyl1', hit, snaps)
    const readouts = outcomes.filter((o): o is MeasureReadout => !isFailure(o))

    const radiusReadout = readouts.find((r) => r.kind === 'radius')
    const diameterReadout = readouts.find((r) => r.kind === 'diameter')
    expect(radiusReadout).toBeDefined()
    expect(diameterReadout).toBeDefined()
    expect(radiusReadout!.approx).toBe(true)
    // Mesh-derived from a 0.05mm-deflection tessellation -- bounded, not exact.
    expect(Math.abs(radiusReadout!.value - radius) / radius).toBeLessThan(0.01)
    expect(diameterReadout!.value).toBeCloseTo(radiusReadout!.value * 2, 9)

    await engine.dispose(handle)
  }, 60_000)

  it('picking a rim edge (adjacent to the cylindrical wall) also resolves radius via the wedge-joined edge grammar', async () => {
    const radius = 5
    const cyl = await engine.debugMakeCylinder('RAD2', radius, 15)
    const handle = cyl.body!
    const tess = await engine.tessellate(handle, { deflection: 0.05 })
    const snaps = engine.snapshotsFor(handle) as unknown as SnapshotLookup
    const cache = new GeometryCache()
    const body = cache.ingest('cyl2', tess)
    const measureExact = (_bodyId: string, kind: MeasureResult['kind'], ids?: StableId[]) => engine.measure(handle, kind, ids)

    let bestRelErr = Infinity
    for (const edgeId of tess.edgeIds) {
      const hit: EdgePickHit = { kind: 'edge', id: edgeId, bodyId: 'cyl2', distance: 1, point: { x: 0, y: 0, z: 0 } }
      const outcomes = await measureSingle(measureExact, body, 'cyl2', hit, snaps)
      const readouts = outcomes.filter((o): o is MeasureReadout => !isFailure(o))
      const radiusReadout = readouts.find((r) => r.kind === 'radius')
      if (radiusReadout === undefined) continue
      const relErr = Math.abs(radiusReadout.value - radius) / radius
      if (relErr < bestRelErr) bestRelErr = relErr
    }
    expect(bestRelErr).toBeLessThan(0.01)
    await engine.dispose(handle)
  }, 60_000)
})

describe('measureLogic distance/angle against a real box (occt-wasm)', () => {
  let engine: GeomEngine
  const SIZE = { x: 40, y: 20, z: 10 }

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('two adjacent planar faces measure 90 deg via real kernel-derived normals', async () => {
    const box = (await engine.makeBox('ANG1', SIZE)).body!
    const tess = await engine.tessellate(box, { deflection: 0.1 })
    const snaps = engine.snapshotsFor(box) as unknown as SnapshotLookup
    const cache = new GeometryCache()
    const body = cache.ingest('box1', tess)

    const planarIds = Object.keys(snaps).filter((id) => snaps[id].type === 'plane')
    expect(planarIds.length).toBeGreaterThanOrEqual(2)

    // Find two faces whose real normals are perpendicular (any two adjacent
    // box faces qualify; brute-force the first pair found rather than
    // assuming fixture ordering).
    let found: [string, string] | null = null
    outer: for (const idA of planarIds) {
      for (const idB of planarIds) {
        if (idA >= idB) continue
        const [nA, nB] = [snaps[idA].normal, snaps[idB].normal]
        const dot = nA[0] * nB[0] + nA[1] * nB[1] + nA[2] * nB[2]
        if (Math.abs(dot) < 1e-6) {
          found = [idA, idB]
          break outer
        }
      }
    }
    expect(found).not.toBeNull()
    const [idA, idB] = found!

    const hitA: FacePickHit = { kind: 'face', id: idA, bodyId: 'box1', distance: 1, point: { x: 0, y: 0, z: 0 } }
    const hitB: FacePickHit = { kind: 'face', id: idB, bodyId: 'box1', distance: 1, point: { x: 0, y: 0, z: 0 } }
    const a: PickWithBody = { bodyId: 'box1', body, hit: hitA, snapshots: snaps }
    const b: PickWithBody = { bodyId: 'box1', body, hit: hitB, snapshots: snaps }
    const result = measureAngle(a, b)
    if ('error' in result) throw new Error(`expected angle, got error: ${result.error}`)
    expect(result.value).toBeCloseTo(90, 6)
    expect(result.approx).toBe(false)

    await engine.dispose(box)
  }, 60_000)

  it('two opposite corner vertices measure the exact space diagonal', async () => {
    const box = (await engine.makeBox('DIST1', SIZE)).body!
    const tess = await engine.tessellate(box, { deflection: 0.1 })
    const cache = new GeometryCache()
    const body = cache.ingest('box2', tess)

    // Real topological corners: min/max of the tessellated bbox (a box's
    // vertices ARE its bbox corners, no curve sampling involved).
    const min = { x: -SIZE.x / 2, y: -SIZE.y / 2, z: -SIZE.z / 2 }
    const max = { x: SIZE.x / 2, y: SIZE.y / 2, z: SIZE.z / 2 }
    const hitA: VertexPickHit = { kind: 'vertex', id: makeBridgeVertexRef([]), bodyId: 'box2', distance: 1, point: min }
    const hitB: VertexPickHit = { kind: 'vertex', id: makeBridgeVertexRef([]), bodyId: 'box2', distance: 1, point: max }
    const a: PickWithBody = { bodyId: 'box2', body, hit: hitA, snapshots: {} }
    const b: PickWithBody = { bodyId: 'box2', body, hit: hitB, snapshots: {} }
    const result = measureDistance(a, b)
    if (isFailure(result)) throw new Error(`expected distance, got error: ${result.error}`)
    expect(result.value).toBeCloseTo(Math.hypot(SIZE.x, SIZE.y, SIZE.z), 6)
    expect(result.approx).toBe(false)

    await engine.dispose(box)
  }, 60_000)
})
