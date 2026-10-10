// WO-2222: the Axis datum. The line math for each pick (a hole, an edge, two points), then the datum
// node through the real regen scheduler and ElementMap: it follows its faces when the body moves,
// keeps its line when a face is lost (degraded, not guessed), survives save and load, and a Plane at
// angle turns about it.

import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import { ElementMap } from '../../doc/element-map'
import { RegenScheduler } from '../../doc/regen'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist'
import type { GeometrySnapshot, Vec3 } from '../../geom/geom-service'
import {
  buildAxisDatumNodeInput,
  computeAxisLine,
  datumAxisLine,
  isAxisDatumPayload,
  makeDatumAxisExecutor,
  nearestPointOnPlanes,
  type AxisDatumPayload,
  type AxisLine,
} from '../../sketch3d/datumAxis'
import {
  buildConstructionPlaneDatumNodeInput,
  isOffsetPlaneDatumPayload,
  makeDatumPlaneExecutor,
  type OffsetPlaneDatumPayload,
} from '../../sketch3d/datumPlane'
import { makeAxisAngledPlaneFrame } from '../../sketch3d/referencePlaneMath'
import type { PlaneFrame } from '../../sketch3d/planeMath'

const v = (x: number, y: number, z: number): Vec3 => ({ x, y, z })
const close = (a: Vec3, b: [number, number, number], digits = 9) => {
  expect(a.x).toBeCloseTo(b[0], digits); expect(a.y).toBeCloseTo(b[1], digits); expect(a.z).toBeCloseTo(b[2], digits)
}
const plane = (centroid: Vec3, normal: Vec3): GeometrySnapshot => ({ surfaceType: 'plane', centroid, normal, area: 100 })
const cylinder = (centroid: Vec3, axis: Vec3): GeometrySnapshot => ({ surfaceType: 'cylinder', centroid, axis, area: 100 })
/** distance from p to the infinite line */
const offLine = (line: AxisLine, p: Vec3): number => {
  const d = { x: p.x - line.origin.x, y: p.y - line.origin.y, z: p.z - line.origin.z }
  const t = d.x * line.dir.x + d.y * line.dir.y + d.z * line.dir.z
  return Math.hypot(d.x - t * line.dir.x, d.y - t * line.dir.y, d.z - t * line.dir.z)
}

describe('the axis lines', () => {
  it('through a hole: the cylinder axis, drawn centred on the face, using the analytic axis point when the host has it', () => {
    const r = computeAxisLine('cylinder', [{ role: 'axisFace', geometry: { surfaceType: 'cylinder', centroid: v(13, 7, 5), axis: v(0, 0, 2), axisPoint: v(10, 7, -50) } }])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    close(r.axis.dir, [0, 0, 1])
    expect(offLine(r.axis, v(10, 7, 0))).toBeCloseTo(0, 9)
    // the drawn piece is centred where the face's centre projects onto the axis
    close({ x: r.axis.origin.x, y: r.axis.origin.y, z: r.axis.origin.z + r.axis.length / 2 }, [10, 7, 5])
  })

  it('a flat face picked for a hole axis gives its normal through its centre (the one axis a flat face has)', () => {
    const r = computeAxisLine('cylinder', [{ role: 'axisFace', geometry: plane(v(1, 2, 3), v(0, 1, 0)) }])
    expect(r).toMatchObject({ ok: true, axis: { dir: { x: 0, y: 1, z: 0 } } })
    if (!r.ok) return
    expect(offLine(r.axis, v(1, 99, 3))).toBeCloseTo(0, 9)
  })

  it('along an edge between two flat faces: exactly their line of intersection', () => {
    // the top (z = 10) and the front (y = 0) of a block meet along the line y = 0, z = 10
    const r = computeAxisLine('edge', [
      { role: 'edgeFace', geometry: plane(v(20, 15, 10), v(0, 0, 1)) },
      { role: 'edgeFace', geometry: plane(v(20, 0, 5), v(0, -1, 0)) },
    ])
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(Math.abs(r.axis.dir.x)).toBeCloseTo(1, 9)
    expect(offLine(r.axis, v(-300, 0, 10))).toBeCloseTo(0, 9)
  })

  it('a straight edge on a round shaft runs along the shaft axis, on the flat', () => {
    const r = computeAxisLine('edge', [
      { role: 'edgeFace', geometry: plane(v(0, 4, 10), v(0, 1, 0)) },
      { role: 'edgeFace', geometry: cylinder(v(0, 0, 10), v(0, 0, 1)) },
    ], { origin: v(3, 4, 0), dir: v(0, 0, 1), length: 20 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    close(r.axis.dir, [0, 0, 1])
    expect(r.axis.origin.y).toBeCloseTo(4, 9)
    expect(r.axis.origin.x).toBeCloseTo(3, 9)
  })

  it('two points: each vertex is where its three flat faces meet, first to second', () => {
    const r = computeAxisLine('two-points', [
      { role: 'pointA', geometry: plane(v(0, 5, 5), v(-1, 0, 0)) },
      { role: 'pointA', geometry: plane(v(5, 0, 5), v(0, -1, 0)) },
      { role: 'pointA', geometry: plane(v(5, 5, 0), v(0, 0, -1)) },
      { role: 'pointB', geometry: plane(v(30, 5, 5), v(1, 0, 0)) },
      { role: 'pointB', geometry: plane(v(15, 20, 5), v(0, 1, 0)) },
      { role: 'pointB', geometry: plane(v(15, 5, 10), v(0, 0, 1)) },
    ], { origin: v(0.2, 0.1, -0.3), dir: v(1, 0, 0), length: 29 })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    close(r.axis.origin, [0, 0, 0])
    expect(r.axis.length).toBeCloseTo(Math.hypot(30, 20, 10), 9)
    close(r.axis.dir, [30 / r.axis.length, 20 / r.axis.length, 10 / r.axis.length])
  })

  it('the nearest point on the planes: three give their corner, two their line, parallel duplicates are skipped', () => {
    const corner = nearestPointOnPlanes(v(9, 9, 9), [
      { normal: v(1, 0, 0), offset: 1 }, { normal: v(0, 1, 0), offset: 2 }, { normal: v(0, 0, 1), offset: 3 }, { normal: v(-1, 0, 0), offset: -1 },
    ])
    close(corner, [1, 2, 3])
    close(nearestPointOnPlanes(v(9, 9, 9), [{ normal: v(1, 0, 0), offset: 1 }, { normal: v(0, 1, 0), offset: 2 }]), [1, 2, 9])
  })

  it('a kernel axis has no preferred sign: a rebuild keeps the direction the last one had', () => {
    const prior: AxisLine = { origin: v(0, 0, -20), dir: v(0, 0, -1), length: 40 }
    const r = computeAxisLine('cylinder', [{ role: 'axisFace', geometry: cylinder(v(0, 0, 0), v(0, 0, 1)) }], prior)
    expect(r).toMatchObject({ ok: true, axis: { dir: { z: -1 }, length: 40 } })
  })

  it('refuses only what it cannot make: no face, faces that never meet, one point', () => {
    expect(computeAxisLine('cylinder', []).ok).toBe(false)
    expect(computeAxisLine('edge', [
      { role: 'edgeFace', geometry: plane(v(0, 0, 0), v(0, 0, 1)) },
      { role: 'edgeFace', geometry: plane(v(0, 0, 5), v(0, 0, -1)) },
    ]).ok).toBe(false)
    expect(computeAxisLine('two-points', [], { origin: v(1, 1, 1), dir: v(1, 0, 0), length: 0 }).ok).toBe(false)
  })

  it('Plane at angle about an axis: holds the axis, 0 deg faces the parent, positive turns right-handed', () => {
    const xy: PlaneFrame = { origin: v(0, 0, 0), normal: v(0, 0, 1), xDir: v(1, 0, 0) }
    // an axis along +X, lifted 5 above the XY plane
    const axis = { origin: v(-3, 0, 5), dir: v(1, 0, 0) }
    const flat = makeAxisAngledPlaneFrame(xy, axis, 0)
    expect(flat.ok).toBe(true)
    if (!flat.ok) return
    close(flat.frame.normal, [0, 0, 1])
    close(flat.frame.xDir, [1, 0, 0])
    close(flat.frame.origin, [0, 0, 5])
    const tilted = makeAxisAngledPlaneFrame(xy, axis, 90)
    if (!tilted.ok) throw new Error('90 deg refused')
    // right-handed about +X takes +Z to -Y
    close(tilted.frame.normal, [0, -1, 0])
    // an axis along the parent's normal: the parent's X direction stands in for its facing
    const upright = makeAxisAngledPlaneFrame(xy, { origin: v(4, 4, 0), dir: v(0, 0, 1) }, 0)
    if (!upright.ok) throw new Error('upright axis refused')
    close(upright.frame.normal, [1, 0, 0])
    expect(makeAxisAngledPlaneFrame(xy, axis, Number.NaN)).toEqual({ ok: false, reason: 'non-finite-angle' })
  })
})

describe('the axis datum through the regen scheduler', () => {
  // a body feature F1 that owns a hole wall and two block faces
  const HOLE = 'F1:XTR:S1.e1:side'
  const TOP = 'F1:XTR:cap:end'
  const FRONT = 'F1:XTR:S1.e2:side'
  const deltaFor = (holeX: number) => ({
    featureId: 'F1',
    modified: {},
    generated: [HOLE, TOP, FRONT],
    deleted: [],
    geometry: {
      [HOLE]: cylinder(v(holeX, 10, 5), v(0, 0, 1)),
      [TOP]: plane(v(20, 15, 10), v(0, 0, 1)),
      [FRONT]: plane(v(20, 0, 5), v(0, -1, 0)),
    },
  })
  const build = () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'F1', kind: 'feature', payload: { opType: 'extrude', name: 'Block' } })
    dag.insertNode(buildAxisDatumNodeInput({
      id: 'AX1', name: 'Hole axis', definition: { kind: 'cylinder', flip: false },
      faces: [{ role: 'axisFace', faceId: HOLE }], ownerIds: ['F1'],
      seed: { origin: v(12, 10, -15), dir: v(0, 0, 1), length: 30 },
    }).input)
    dag.insertNode(buildAxisDatumNodeInput({
      id: 'AX2', name: 'Edge axis', definition: { kind: 'edge', flip: true },
      faces: [{ role: 'edgeFace', faceId: TOP }, { role: 'edgeFace', faceId: FRONT }], ownerIds: ['F1'],
      seed: { origin: v(0, 0, 10), dir: v(1, 0, 0), length: 40 },
    }).input)
    dag.insertNode({ id: 'datum:BASE', kind: 'datum', payload: { datumType: 'plane', planeKind: 'base-plane', basePlane: 'xy', lastGoodFrame: { origin: v(0, 0, 0), normal: v(0, 0, 1), xDir: v(1, 0, 0) } } })
    dag.insertNode(buildConstructionPlaneDatumNodeInput({
      id: 'RP1', parentPlaneNodeIds: ['datum:BASE', 'datum:AX2'],
      definition: { kind: 'angle', angleDeg: 90, hinge: 'axis', flipNormal: false }, name: 'Tilted on the edge',
    }).input)
    return dag
  }
  const run = async (dag: FeatureDag, map: ElementMap, dirty: string[]) => {
    const scheduler = new RegenScheduler(dag, map)
    for (const id of dirty) scheduler.markDirty(id)
    const planes = makeDatumPlaneExecutor(dag, map)
    const axes = makeDatumAxisExecutor(dag, map)
    await scheduler.run(async (node) => node.payload.datumType === 'axis' ? axes(node) : planes(node))
    return scheduler
  }
  const lineOf = (dag: FeatureDag, id: string) => datumAxisLine(dag.getNode(id)!.payload as AxisDatumPayload)!

  it('a hole axis and an edge axis resolve from their faces; the flip reverses the edge axis; a plane turns about it', async () => {
    const dag = build()
    const map = new ElementMap().applyDelta(deltaFor(12))
    const s = await run(dag, map, ['F1'])
    expect(s.statusOf('datum:AX1')).toBe('ok')
    const hole = lineOf(dag, 'datum:AX1')
    expect(offLine(hole, v(12, 10, 0))).toBeCloseTo(0, 9)
    close(hole.dir, [0, 0, 1])
    const edge = lineOf(dag, 'datum:AX2')
    expect(offLine(edge, v(77, 0, 10))).toBeCloseTo(0, 9)
    close(edge.dir, [-1, 0, 0])
    // 90 deg right-handed about -X takes the XY normal (+Z) to +Y, through the edge
    const rp = (dag.getNode('datum:RP1')!.payload as OffsetPlaneDatumPayload).lastGoodFrame!
    close(rp.normal, [0, 1, 0])
    expect(rp.origin.z).toBeCloseTo(10, 9)
  })

  it('moving the hole moves the axis; losing the face keeps the last line and degrades rather than guessing', async () => {
    const dag = build()
    const map = new ElementMap().applyDelta(deltaFor(12))
    await run(dag, map, ['F1'])
    const moved = new ElementMap().applyDelta(deltaFor(31))
    await run(dag, moved, ['F1'])
    expect(offLine(lineOf(dag, 'datum:AX1'), v(31, 10, 0))).toBeCloseTo(0, 9)
    const gone = new ElementMap().applyDelta({ ...deltaFor(31), generated: [TOP, FRONT] })
    const s = await run(dag, gone, ['F1'])
    expect(s.statusOf('datum:AX1')).toBe('degraded')
    expect(offLine(lineOf(dag, 'datum:AX1'), v(31, 10, 0))).toBeCloseTo(0, 9)
  })

  it('saved and loaded, the axes and the plane on them come back and rebuild the same lines', async () => {
    const dag = build()
    const map = new ElementMap().applyDelta(deltaFor(12))
    await run(dag, map, ['F1'])
    const restored = loadDocumentArchive(createDocumentArchive({ dag, elementMapDeltas: [] })).dag
    for (const id of ['datum:AX1', 'datum:AX2']) expect(isAxisDatumPayload(restored.getNode(id)!.payload)).toBe(true)
    expect(isOffsetPlaneDatumPayload(restored.getNode('datum:RP1')!.payload)).toBe(true)
    await run(restored, new ElementMap().applyDelta(deltaFor(12)), ['F1'])
    for (const id of ['datum:AX1', 'datum:AX2']) {
      const a = lineOf(restored, id), b = lineOf(dag, id)
      close(a.origin, [b.origin.x, b.origin.y, b.origin.z]); close(a.dir, [b.dir.x, b.dir.y, b.dir.z])
    }
    expect((restored.getNode('datum:RP1')!.payload as OffsetPlaneDatumPayload).lastGoodFrame).toEqual((dag.getNode('datum:RP1')!.payload as OffsetPlaneDatumPayload).lastGoodFrame)
  })

  it('a plane at angle about an axis that is missing its axis fails by name', async () => {
    const dag = new FeatureDag()
    dag.insertNode({ id: 'datum:BASE', kind: 'datum', payload: { datumType: 'plane', planeKind: 'base-plane', basePlane: 'xy', lastGoodFrame: { origin: v(0, 0, 0), normal: v(0, 0, 1), xDir: v(1, 0, 0) } } })
    dag.insertNode(buildConstructionPlaneDatumNodeInput({ id: 'RP9', parentPlaneNodeIds: ['datum:BASE'], definition: { kind: 'angle', angleDeg: 10, hinge: 'axis', flipNormal: false }, name: 'No axis' }).input)
    const s = await run(dag, new ElementMap(), ['datum:BASE'])
    expect(s.statusOf('datum:RP9')).toBe('failed')
  })
})
