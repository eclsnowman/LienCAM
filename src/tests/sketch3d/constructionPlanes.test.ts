// Construct tools beyond Offset plane: Midplane (two planes, parallel or meeting) and Plane at angle
// (a plane turned about its own X or Y axis). The frame math, then the datum node through the real
// regen scheduler: it follows its parents, survives save and load, and edits.

import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import { ElementMap } from '../../doc/element-map'
import { RegenScheduler } from '../../doc/regen'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist'
import {
  buildConstructionPlaneDatumNodeInput,
  isOffsetPlaneDatumPayload,
  makeDatumPlaneExecutor,
  type OffsetPlaneDatumPayload,
} from '../../sketch3d/datumPlane'
import { makeAngledPlaneFrame, makeMidplaneFrame } from '../../sketch3d/referencePlaneMath'
import type { PlaneFrame } from '../../sketch3d/planeMath'

const frame = (o: [number, number, number], n: [number, number, number], x: [number, number, number] = [1, 0, 0]): PlaneFrame => ({
  origin: { x: o[0], y: o[1], z: o[2] }, normal: { x: n[0], y: n[1], z: n[2] }, xDir: { x: x[0], y: x[1], z: x[2] },
})
const XY = frame([0, 0, 0], [0, 0, 1])
const close = (a: { x: number; y: number; z: number }, b: [number, number, number]) => {
  expect(a.x).toBeCloseTo(b[0], 9); expect(a.y).toBeCloseTo(b[1], 9); expect(a.z).toBeCloseTo(b[2], 9)
}
const signedDistance = (f: PlaneFrame, p: [number, number, number]) =>
  (p[0] - f.origin.x) * f.normal.x + (p[1] - f.origin.y) * f.normal.y + (p[2] - f.origin.z) * f.normal.z

describe('the frames', () => {
  it('Midplane of two parallel planes: halfway across, facing the first, whichever way the second faces', () => {
    for (const n2 of [[0, 0, 1], [0, 0, -1]] as const) {
      const r = makeMidplaneFrame(frame([3, 4, 2], [0, 0, 1]), frame([-7, 1, 12], [...n2]))
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.frame.origin.z).toBeCloseTo(7, 9)
      close(r.frame.normal, [0, 0, 1])
    }
  })

  it('Midplane of two planes that meet: through their shared line, halving the angle (every point on it is as far from one as the other)', () => {
    // XY and a plane through the X axis tilted 40 deg: the midplane is tilted 20 deg
    const t = (40 * Math.PI) / 180
    const tilted = frame([5, 0, 0], [0, -Math.sin(t), Math.cos(t)])
    const r = makeMidplaneFrame(XY, tilted)
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const h = t / 2
    close(r.frame.normal, [0, -Math.sin(h), Math.cos(h)])
    // the shared line (the X axis) lies in it
    expect(signedDistance(r.frame, [123, 0, 0])).toBeCloseTo(0, 9)
    // a point on it is equally far from both planes
    const y = 10, z = y * Math.tan(h), p: [number, number, number] = [2, y, z]
    expect(Math.abs(signedDistance(XY, p))).toBeCloseTo(Math.abs(signedDistance(tilted, p)), 9)
  })

  it('Plane at angle: about X keeps X and tilts the normal right-handed; about Y turns X with it; 90 deg about X on XY is the XZ plane', () => {
    const ax = makeAngledPlaneFrame(XY, 30, 'x')
    expect(ax.ok).toBe(true)
    if (!ax.ok) return
    close(ax.frame.xDir, [1, 0, 0])
    const c = Math.cos(Math.PI / 6), sn = Math.sin(Math.PI / 6)
    close(ax.frame.normal, [0, -sn, c])
    const ay = makeAngledPlaneFrame(XY, 30, 'y')
    if (!ay.ok) throw new Error('angle about y refused')
    close(ay.frame.normal, [sn, 0, c])
    close(ay.frame.xDir, [c, 0, -sn])
    const right = makeAngledPlaneFrame(frame([0, 0, 5], [0, 0, 1]), 90, 'x')
    if (!right.ok) throw new Error('90 deg refused')
    close(right.frame.normal, [0, -1, 0])
    close(right.frame.origin, [0, 0, 5])
    expect(makeAngledPlaneFrame(XY, 30, 'x', { flipNormal: true })).toMatchObject({ ok: true, frame: { normal: { z: -c } } })
  })

  it('refuses only a broken number or a broken parent frame', () => {
    expect(makeAngledPlaneFrame(XY, Number.NaN, 'x')).toEqual({ ok: false, reason: 'non-finite-angle' })
    expect(makeMidplaneFrame(frame([0, 0, 0], [0, 0, 0]), XY)).toEqual({ ok: false, reason: 'zero-parent-normal' })
  })
})

describe('the datum nodes through the regen scheduler', () => {
  const base = (id: string, f: PlaneFrame, basePlane: string) => ({
    id, kind: 'datum' as const, consumes: [], refs: [],
    payload: { datumType: 'plane', planeKind: 'base-plane', basePlane, lastGoodFrame: f },
  })
  const build = () => {
    const dag = new FeatureDag()
    dag.insertNode(base('datum:A', XY, 'xy'))
    dag.insertNode(base('datum:B', frame([0, 0, 20], [0, 0, 1]), 'xy'))
    dag.insertNode(buildConstructionPlaneDatumNodeInput({ id: 'M1', parentPlaneNodeIds: ['datum:A', 'datum:B'], definition: { kind: 'midplane', flipNormal: false }, name: 'Mid' }).input)
    dag.insertNode(buildConstructionPlaneDatumNodeInput({ id: 'G1', parentPlaneNodeIds: ['datum:M1'], definition: { kind: 'angle', angleDeg: 90, hinge: 'x', flipNormal: false }, name: 'Tilted' }).input)
    return dag
  }
  const run = async (dag: FeatureDag, dirty: string[]) => {
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    for (const id of dirty) scheduler.markDirty(id)
    await scheduler.run(makeDatumPlaneExecutor(dag, map))
    return scheduler
  }
  const frameOf = (dag: FeatureDag, id: string) => (dag.getNode(id)!.payload as OffsetPlaneDatumPayload).lastGoodFrame!

  it('a midplane between two planes, then a plane at 90 deg on it: both resolve and follow a moved parent', async () => {
    const dag = build()
    const s = await run(dag, ['datum:A', 'datum:B'])
    expect(s.statusOf('datum:M1')).not.toBe('failed')
    expect(frameOf(dag, 'datum:M1').origin.z).toBeCloseTo(10, 9)
    close(frameOf(dag, 'datum:G1').normal, [0, -1, 0])
    expect(frameOf(dag, 'datum:G1').origin.z).toBeCloseTo(10, 9)
    // move the second plane: the midplane and the plane on it follow
    dag.setPayload('datum:B', { ...dag.getNode('datum:B')!.payload, lastGoodFrame: frame([0, 0, 40], [0, 0, 1]) })
    await run(dag, ['datum:B'])
    expect(frameOf(dag, 'datum:M1').origin.z).toBeCloseTo(20, 9)
    expect(frameOf(dag, 'datum:G1').origin.z).toBeCloseTo(20, 9)
  })

  it('saved and loaded, the definitions come back and rebuild the same frames', async () => {
    const dag = build()
    await run(dag, ['datum:A', 'datum:B'])
    const restored = loadDocumentArchive(createDocumentArchive({ dag, elementMapDeltas: [] })).dag
    for (const id of ['datum:M1', 'datum:G1']) expect(isOffsetPlaneDatumPayload(restored.getNode(id)!.payload)).toBe(true)
    await run(restored, ['datum:A', 'datum:B'])
    expect(frameOf(restored, 'datum:M1')).toEqual(frameOf(dag, 'datum:M1'))
    expect(frameOf(restored, 'datum:G1')).toEqual(frameOf(dag, 'datum:G1'))
  })

  it('a midplane does not depend on which plane was picked first: its parents are read in sorted id order', async () => {
    const make = async (order: string[]) => {
      const dag = new FeatureDag()
      dag.insertNode(base('datum:A', XY, 'xy'))
      dag.insertNode(base('datum:B', frame([0, 0, 20], [0, 0, -1]), 'xy'))
      dag.insertNode(buildConstructionPlaneDatumNodeInput({ id: 'M', parentPlaneNodeIds: order, definition: { kind: 'midplane', flipNormal: false }, name: 'Mid' }).input)
      await run(dag, ['datum:A', 'datum:B'])
      return frameOf(dag, 'datum:M')
    }
    const ab = await make(['datum:A', 'datum:B'])
    expect(await make(['datum:B', 'datum:A'])).toEqual(ab)
    // facing datum:A (sorted first), even though the two planes face each other
    close(ab.normal, [0, 0, 1])
  })

  it('a midplane short a parent, or an angle with a malformed hinge, fails by name rather than guessing', async () => {
    const dag = new FeatureDag()
    dag.insertNode(base('datum:A', XY, 'xy'))
    dag.insertNode(buildConstructionPlaneDatumNodeInput({ id: 'M2', parentPlaneNodeIds: ['datum:A'], definition: { kind: 'midplane', flipNormal: false }, name: 'Half' }).input)
    const s = await run(dag, ['datum:A'])
    expect(s.statusOf('datum:M2')).toBe('failed')
    expect(isOffsetPlaneDatumPayload({ datumType: 'plane', planeKind: 'offset-plane', payloadSchema: 1, name: 'x', definition: { kind: 'angle', angleDeg: 5, hinge: 'z', flipNormal: false } })).toBe(false)
  })
})
