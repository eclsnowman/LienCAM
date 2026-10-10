// WO-2223: Construct, second wave. A plane through three points, through two edges, tangent to a
// cylindrical face; a Point datum at a vertex, a circle's centre, or where an edge meets a plane.
// The math for each pick, then the datums through the real regen scheduler and ElementMap: they
// follow their faces when the body moves, keep their place when a face is lost (degraded, not
// guessed), survive save and load, and existing construction planes are untouched.

import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import { ElementMap } from '../../doc/element-map'
import { RegenScheduler } from '../../doc/regen'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist'
import type { GeometrySnapshot, Vec3 } from '../../geom/geom-service'
import {
  buildPickedPlaneDatumNodeInput,
  buildPointDatumNodeInput,
  circleCentre,
  computeDatumPoint,
  computePickedPlane,
  isPointDatumPayload,
  lineMeetsPlane,
  makeDatumPointExecutor,
  pickedPlaneFrame,
  pointOfNode,
  tangentSeed,
  type PickedPlaneState,
} from '../../sketch3d/datumConstruct'
import {
  buildConstructionPlaneDatumNodeInput,
  constructionPlaneFrame,
  isOffsetPlaneDatumPayload,
  makeDatumPlaneExecutor,
  type OffsetPlaneDatumPayload,
} from '../../sketch3d/datumPlane'
import type { AxisFaceGeometry } from '../../sketch3d/datumAxis'
import type { PlaneFrame } from '../../sketch3d/planeMath'

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
const close = (a: Vec3, b: [number, number, number], digits = 9) => {
  expect(a.x).toBeCloseTo(b[0], digits); expect(a.y).toBeCloseTo(b[1], digits); expect(a.z).toBeCloseTo(b[2], digits)
}
const plane = (centroid: Vec3, normal: Vec3): GeometrySnapshot => ({ surfaceType: 'plane', centroid, normal, area: 100 })
const cylinder = (centroid: Vec3, axis: Vec3): GeometrySnapshot => ({ surfaceType: 'cylinder', centroid, axis, area: 100 })
/** signed distance of p from the frame's plane */
const offPlane = (frame: PlaneFrame, p: Vec3): number =>
  (p.x - frame.origin.x) * frame.normal.x + (p.y - frame.origin.y) * frame.normal.y + (p.z - frame.origin.z) * frame.normal.z
const frameOf = (dag: FeatureDag, id: string): PlaneFrame => (dag.getNode(id)!.payload as OffsetPlaneDatumPayload).lastGoodFrame!

describe('the picked planes', () => {
  it('through three points: holds all three, X along the first to the second, normal by the right hand', () => {
    const state: PickedPlaneState = { kind: 'three-points', points: [v(0, 0, 10), v(30, 0, 10), v(0, 20, 16)] }
    const r = pickedPlaneFrame(state, false)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    for (const p of state.points) expect(offPlane(r.frame, p)).toBeCloseTo(0, 9)
    close(r.frame.xDir, [1, 0, 0])
    // (B - A) x (C - A) = (30,0,0) x (0,20,6) = (0,-180,600)
    const n = Math.hypot(180, 600)
    close(r.frame.normal, [0, -180 / n, 600 / n])
    close(r.frame.origin, [10, 20 / 3, 12])
    const flipped = pickedPlaneFrame(state, true)
    if (!flipped.ok) throw new Error('flip refused')
    close(flipped.frame.normal, [0, 180 / n, -600 / n])
    close(flipped.frame.xDir, [1, 0, 0])
  })

  it('three points on one line cannot make a plane, and says so', () => {
    expect(pickedPlaneFrame({ kind: 'three-points', points: [v(0, 0, 0), v(1, 1, 1), v(5, 5, 5)] }, false)).toEqual({ ok: false, reason: 'the three points are on one line' })
  })

  it('through two edges: meeting edges, parallel edges, and skew edges (holds the first, parallel to the second)', () => {
    const meeting = pickedPlaneFrame({ kind: 'two-edges', lines: [
      { origin: v(0, 0, 10), dir: v(1, 0, 0), length: 30 },
      { origin: v(0, 0, 10), dir: v(0, 0.6, 0.8), length: 10 },
    ] }, false)
    if (!meeting.ok) throw new Error('meeting refused')
    expect(offPlane(meeting.frame, v(17, 0, 10))).toBeCloseTo(0, 9)
    expect(offPlane(meeting.frame, v(0, 6, 18))).toBeCloseTo(0, 9)
    close(meeting.frame.xDir, [1, 0, 0])

    // two parallel top edges of a block, front (y 0) and back (y 20), both at z 10
    const parallel = pickedPlaneFrame({ kind: 'two-edges', lines: [
      { origin: v(0, 0, 10), dir: v(1, 0, 0), length: 30 },
      { origin: v(0, 20, 10), dir: v(1, 0, 0), length: 30 },
    ] }, false)
    if (!parallel.ok) throw new Error('parallel refused')
    close(parallel.frame.normal, [0, 0, 1])
    close(parallel.frame.origin, [15, 10, 10])

    // a diagonal of the top and an edge of the bottom: the plane through the top edge
    const skew = pickedPlaneFrame({ kind: 'two-edges', lines: [
      { origin: v(0, 0, 10), dir: v(1, 0, 0), length: 30 },
      { origin: v(0, 20, 0), dir: v(0, 1, 0), length: 10 },
    ] }, false)
    if (!skew.ok) throw new Error('skew refused')
    expect(offPlane(skew.frame, v(99, 0, 10))).toBeCloseTo(0, 9)
    close(skew.frame.normal, [0, 0, 1])

    expect(pickedPlaneFrame({ kind: 'two-edges', lines: [
      { origin: v(0, 0, 0), dir: v(1, 0, 0), length: 5 },
      { origin: v(10, 0, 0), dir: v(-1, 0, 0), length: 5 },
    ] }, false)).toEqual({ ok: false, reason: 'the two edges are on one line' })
  })

  it('tangent to a cylinder: touches it where clicked, normal outward, X along the axis', () => {
    const shaft: AxisFaceGeometry = { surfaceType: 'cylinder', centroid: v(9, 4, 20), axis: v(0, 0, 1), axisPoint: v(5, 5, 0), radius: 6 }
    // a click on the +X side of the shaft (a tessellated point slightly inside the true surface)
    const seed = tangentSeed(shaft, v(10.9, 5, 12))
    expect(seed).toBeDefined()
    if (seed === undefined) return
    const r = pickedPlaneFrame(seed, false)
    if (!r.ok) throw new Error('tangent refused')
    close(r.frame.origin, [11, 5, 12])
    close(r.frame.normal, [1, 0, 0])
    close(r.frame.xDir, [0, 0, 1])
    // a flat face given for a tangent plane: its own plane (rule 11)
    const flatSeed = tangentSeed(plane(v(0, 0, 10), v(0, 0, 1)), v(3, 4, 10))
    if (flatSeed === undefined) throw new Error('flat refused')
    const flat = pickedPlaneFrame(flatSeed, false)
    if (!flat.ok) throw new Error('flat frame refused')
    close(flat.frame.normal, [0, 0, 1])
    expect(offPlane(flat.frame, v(-50, 70, 10))).toBeCloseTo(0, 9)
    // any other surface: square to the clicked triangle, held there
    const other = tangentSeed({ surfaceType: 'sphere' as AxisFaceGeometry['surfaceType'], centroid: v(0, 0, 0) }, v(1, 2, 3), v(0, 2, 0))
    if (other === undefined) throw new Error('other refused')
    close(other.radial, [0, 1, 0])
    close(other.point, [1, 2, 3])
  })

  it('a tangent plane keeps its angle round the shaft when the shaft moves and grows', () => {
    const seed = tangentSeed({ surfaceType: 'cylinder', centroid: v(0, 0, 0), axis: v(0, 0, 1), axisPoint: v(0, 0, 0), radius: 5 }, v(0, -5, 3))!
    const r = computePickedPlane({ kind: 'tangent', flipNormal: false }, [
      { role: 'tangentFace', geometry: { surfaceType: 'cylinder', centroid: v(20, 0, 0), axis: v(0, 0, -1), axisPoint: v(20, 0, 99), radius: 8 } },
    ], seed)
    if (!r.ok) throw new Error('refused')
    close(r.frame.origin, [20, -8, 3])
    close(r.frame.normal, [0, -1, 0])
    // the axis's sign follows the last one (a kernel axis has none of its own)
    close(r.frame.xDir, [0, 0, 1])
  })

  it('a construction plane from picks never takes the parent-plane path', () => {
    const r = constructionPlaneFrame({ kind: 'three-points', flipNormal: false }, [])
    expect(r.ok).toBe(false)
  })
})

describe('the point', () => {
  it('a vertex: where its flat faces meet, from where it was picked', () => {
    const r = computeDatumPoint({ kind: 'vertex' }, [
      { role: 'pointFace', geometry: plane(v(0, 5, 5), v(-1, 0, 0)) },
      { role: 'pointFace', geometry: plane(v(5, 0, 5), v(0, -1, 0)) },
      { role: 'pointFace', geometry: plane(v(5, 5, 10), v(0, 0, 1)) },
    ], { point: v(0.1, -0.2, 10.3) })
    expect(r).toMatchObject({ ok: true })
    if (r.ok) close(r.point, [0, 0, 10])
  })

  it('a circle centre: the round face\'s axis where it meets the flat face beside it', () => {
    const faces: AxisFaceGeometry[] = [
      { surfaceType: 'cylinder', centroid: v(18, 10, 11), axis: v(0, 0, 1), axisPoint: v(15, 10, -40) },
      plane(v(20, 10, 16), v(0, 0, 1)),
    ]
    close(circleCentre(faces, v(14.9, 10.2, 16)), [15, 10, 16])
    // a round face alone: its axis point nearest the start
    close(circleCentre([faces[0]], v(17, 3, 7)), [15, 10, 7])
    const r = computeDatumPoint({ kind: 'circle-centre' }, faces.map((geometry) => ({ role: 'pointFace' as const, geometry })), { point: v(15.2, 9.8, 16) })
    if (r.ok) close(r.point, [15, 10, 16])
    else throw new Error('refused')
  })

  it('an edge meets a plane; a round edge\'s centre line meets it too; parallel never meets', () => {
    // the front top edge (z 10, y 0, along X) meets the plane x = 12
    const r = computeDatumPoint({ kind: 'edge-plane', lineKind: 'edge' }, [
      { role: 'lineA', geometry: plane(v(20, 15, 10), v(0, 0, 1)) },
      { role: 'lineA', geometry: plane(v(20, 0, 5), v(0, -1, 0)) },
    ], { line: { origin: v(0, 0, 10), dir: v(1, 0, 0), length: 40 } }, { origin: v(12, 0, 0), normal: v(1, 0, 0) })
    if (!r.ok) throw new Error('refused')
    close(r.point, [12, 0, 10])
    const round = computeDatumPoint({ kind: 'edge-plane', lineKind: 'cylinder' }, [
      { role: 'lineA', geometry: { surfaceType: 'cylinder', centroid: v(16, 10, 11), axis: v(0, 0, 1), axisPoint: v(15, 10, 0) } },
    ], {}, { origin: v(0, 0, 0), normal: v(0, 0, 1) })
    if (!round.ok) throw new Error('round refused')
    close(round.point, [15, 10, 0])
    expect(computeDatumPoint({ kind: 'edge-plane', lineKind: 'edge' }, [], { line: { origin: v(0, 0, 10), dir: v(1, 0, 0), length: 4 } }, { origin: v(0, 0, 0), normal: v(0, 0, 1) }))
      .toEqual({ ok: false, reason: 'the edge runs parallel to the plane - they never meet' })
    expect(lineMeetsPlane({ origin: v(0, 0, 5), dir: v(0, 0, -2) }, { origin: v(0, 0, 0), normal: v(0, 0, 1) })).toEqual(v(0, 0, 0))
  })
})

describe('the second-wave datums through the regen scheduler', () => {
  // a block feature F1: top z = 10, front y = 0, left x = 0, right x = 30, back y = 20, a shaft
  const TOP = 'F1:XTR:cap:end'
  const FRONT = 'F1:XTR:S1.e1:side'
  const LEFT = 'F1:XTR:S1.e4:side'
  const RIGHT = 'F1:XTR:S1.e2:side'
  const BACK = 'F1:XTR:S1.e3:side'
  const SHAFT = 'F1:XTR:S2.e1:side'
  const deltaFor = (lift: number, shaftX = 50) => ({
    featureId: 'F1',
    modified: {},
    generated: [TOP, FRONT, LEFT, RIGHT, BACK, SHAFT],
    deleted: [],
    geometry: {
      [TOP]: plane(v(15, 10, 10 + lift), v(0, 0, 1)),
      [FRONT]: plane(v(15, 0, 5), v(0, -1, 0)),
      [LEFT]: plane(v(0, 10, 5), v(-1, 0, 0)),
      [RIGHT]: plane(v(30, 10, 5), v(1, 0, 0)),
      [BACK]: plane(v(15, 20, 5), v(0, 1, 0)),
      [SHAFT]: cylinder(v(shaftX, 10, 5), v(0, 0, 1)),
    },
  })
  const XY: PlaneFrame = { origin: v(0, 0, 0), normal: v(0, 0, 1), xDir: v(1, 0, 0) }
  const build = () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', name: 'Block' } })
    dag.insertNode({ id: 'datum:BASE', kind: 'datum', payload: { datumType: 'plane', planeKind: 'base-plane', basePlane: 'yz', lastGoodFrame: { origin: v(0, 0, 0), normal: v(1, 0, 0), xDir: v(0, 1, 0) } } })
    // three top corners: front-left, front-right, back-left
    dag.insertNode(buildPickedPlaneDatumNodeInput({
      id: 'RP1', name: 'Top by corners', definition: { kind: 'three-points', flipNormal: false },
      faces: [
        { role: 'pointA', faceId: TOP }, { role: 'pointA', faceId: FRONT }, { role: 'pointA', faceId: LEFT },
        { role: 'pointB', faceId: TOP }, { role: 'pointB', faceId: FRONT }, { role: 'pointB', faceId: RIGHT },
        { role: 'pointC', faceId: TOP }, { role: 'pointC', faceId: BACK }, { role: 'pointC', faceId: LEFT },
      ],
      ownerIds: ['F1'],
      seed: { kind: 'three-points', points: [v(0, 0, 10), v(30, 0, 10), v(0, 20, 10)] },
    }).input)
    // the front top edge and the back bottom edge: a slanted plane through the block
    dag.insertNode(buildPickedPlaneDatumNodeInput({
      id: 'RP2', name: 'Slant', definition: { kind: 'two-edges', flipNormal: false, lineKinds: ['edge', 'edge'] },
      faces: [{ role: 'lineA', faceId: TOP }, { role: 'lineA', faceId: FRONT }, { role: 'lineB', faceId: BACK }],
      ownerIds: ['F1'],
      seed: { kind: 'two-edges', lines: [{ origin: v(0, 0, 10), dir: v(1, 0, 0), length: 30 }, { origin: v(0, 20, 0), dir: v(1, 0, 0), length: 30 }] },
    }).input)
    // tangent to a radius-4 shaft on its -Y side
    dag.insertNode(buildPickedPlaneDatumNodeInput({
      id: 'RP3', name: 'Tangent', definition: { kind: 'tangent', flipNormal: true },
      faces: [{ role: 'tangentFace', faceId: SHAFT }], ownerIds: ['F1'],
      seed: { kind: 'tangent', point: v(50, 6, 5), radial: v(0, -1, 0), axis: v(0, 0, 1), centre: v(50, 10, 5) },
    }).input)
    dag.insertNode(buildPointDatumNodeInput({
      id: 'PT1', name: 'Corner', definition: { kind: 'vertex' },
      faces: [{ role: 'pointFace', faceId: TOP }, { role: 'pointFace', faceId: RIGHT }, { role: 'pointFace', faceId: BACK }],
      consumes: ['F1'], seed: v(30, 20, 10),
    }).input)
    dag.insertNode(buildPointDatumNodeInput({
      id: 'PT2', name: 'Edge meets YZ', definition: { kind: 'edge-plane', lineKind: 'edge' },
      faces: [{ role: 'lineA', faceId: TOP }, { role: 'lineA', faceId: BACK }],
      consumes: ['F1', 'datum:BASE'], seed: v(0, 20, 10), seedLine: { origin: v(0, 20, 10), dir: v(1, 0, 0), length: 30 },
    }).input)
    return dag
  }
  const run = async (dag: FeatureDag, map: ElementMap, dirty: string[]) => {
    const scheduler = new RegenScheduler(dag, map)
    for (const id of dirty) scheduler.markDirty(id)
    const planes = makeDatumPlaneExecutor(dag, map)
    const points = makeDatumPointExecutor(dag, map)
    await scheduler.run(async (node) => node.payload.datumType === 'point' ? points(node) : planes(node))
    return scheduler
  }

  it('each datum resolves from its faces', async () => {
    const dag = build()
    const s = await run(dag, new ElementMap().applyDelta(deltaFor(0)), ['F1'])
    for (const id of ['datum:RP1', 'datum:RP2', 'datum:RP3', 'datum:PT1', 'datum:PT2']) expect(s.statusOf(id)).toBe('ok')
    const top = frameOf(dag, 'datum:RP1')
    close(top.normal, [0, 0, 1])
    expect(offPlane(top, v(99, -40, 10))).toBeCloseTo(0, 9)
    const slant = frameOf(dag, 'datum:RP2')
    expect(offPlane(slant, v(7, 0, 10))).toBeCloseTo(0, 9)
    expect(offPlane(slant, v(3, 20, 0))).toBeCloseTo(0, 9)
    // the shaft's centroid is on its axis here; with no radius from the host the picked one holds
    const tangent = frameOf(dag, 'datum:RP3')
    close(tangent.origin, [50, 6, 5])
    close(tangent.normal, [0, 1, 0])
    close(pointOfNode(dag, 'datum:PT1')!, [30, 20, 10])
    close(pointOfNode(dag, 'datum:PT2')!, [0, 20, 10])
  })

  it('the block grows 5 taller and the shaft moves: every datum follows; a lost face keeps the place and degrades', async () => {
    const dag = build()
    await run(dag, new ElementMap().applyDelta(deltaFor(0)), ['F1'])
    await run(dag, new ElementMap().applyDelta(deltaFor(5, 70)), ['F1'])
    close(frameOf(dag, 'datum:RP1').origin, [10, 20 / 3, 15])
    expect(offPlane(frameOf(dag, 'datum:RP2'), v(1, 0, 15))).toBeCloseTo(0, 9)
    close(frameOf(dag, 'datum:RP3').origin, [70, 6, 5])
    close(pointOfNode(dag, 'datum:PT1')!, [30, 20, 15])
    close(pointOfNode(dag, 'datum:PT2')!, [0, 20, 15])
    const gone = new ElementMap().applyDelta({ ...deltaFor(9), generated: [FRONT, LEFT, RIGHT, BACK, SHAFT] })
    const s = await run(dag, gone, ['F1'])
    expect(s.statusOf('datum:RP1')).toBe('degraded')
    expect(s.statusOf('datum:PT1')).toBe('degraded')
    close(pointOfNode(dag, 'datum:PT1')!, [30, 20, 15])
    close(frameOf(dag, 'datum:RP1').origin, [10, 20 / 3, 15])
  })

  it('saved and loaded, every datum comes back and rebuilds the same', async () => {
    const dag = build()
    await run(dag, new ElementMap().applyDelta(deltaFor(0)), ['F1'])
    const restored = loadDocumentArchive(createDocumentArchive({ dag, elementMapDeltas: [] })).dag
    for (const id of ['datum:RP1', 'datum:RP2', 'datum:RP3']) expect(isOffsetPlaneDatumPayload(restored.getNode(id)!.payload)).toBe(true)
    for (const id of ['datum:PT1', 'datum:PT2']) expect(isPointDatumPayload(restored.getNode(id)!.payload)).toBe(true)
    await run(restored, new ElementMap().applyDelta(deltaFor(0)), ['F1'])
    const same = (a: Vec3, b: Vec3) => close(a, [b.x, b.y, b.z])
    for (const id of ['datum:RP1', 'datum:RP2', 'datum:RP3']) {
      const a = frameOf(restored, id), b = frameOf(dag, id)
      same(a.origin, b.origin); same(a.normal, b.normal); same(a.xDir, b.xDir)
    }
    for (const id of ['datum:PT1', 'datum:PT2']) same(pointOfNode(restored, id)!, pointOfNode(dag, id)!)
  })

  it('a plane picked on the block is a parent like any other: an offset plane follows it', async () => {
    const dag = build()
    dag.insertNode(buildConstructionPlaneDatumNodeInput({ id: 'RP4', parentPlaneNodeIds: ['datum:RP1'], definition: { kind: 'offset', distance: 7, flipNormal: false }, name: 'Above the top' }).input)
    await run(dag, new ElementMap().applyDelta(deltaFor(0)), ['F1'])
    expect(frameOf(dag, 'datum:RP4').origin.z).toBeCloseTo(17, 9)
    await run(dag, new ElementMap().applyDelta(deltaFor(5)), ['F1'])
    expect(frameOf(dag, 'datum:RP4').origin.z).toBeCloseTo(22, 9)
  })

  it('an edge that turns parallel to its plane fails by name; the point is kept', async () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', name: 'Block' } })
    dag.insertNode({ id: 'datum:FLOOR', kind: 'datum', payload: { datumType: 'plane', planeKind: 'base-plane', basePlane: 'xy', lastGoodFrame: XY } })
    dag.insertNode(buildPointDatumNodeInput({
      id: 'PT9', name: 'Never meets', definition: { kind: 'edge-plane', lineKind: 'edge' },
      faces: [{ role: 'lineA', faceId: TOP }, { role: 'lineA', faceId: FRONT }],
      consumes: ['F1', 'datum:FLOOR'], seed: v(0, 0, 10), seedLine: { origin: v(0, 0, 10), dir: v(1, 0, 0), length: 30 },
    }).input)
    const s = await run(dag, new ElementMap().applyDelta(deltaFor(0)), ['F1'])
    expect(s.statusOf('datum:PT9')).toBe('failed')
    close(pointOfNode(dag, 'datum:PT9')!, [0, 0, 10])
  })
})
