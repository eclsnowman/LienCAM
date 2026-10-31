// WO-3244: GeomClient.transformBody mirrors ONE exact body (no fuse) and names
// every result face `<featureId>:PAT:i1:<sourceFaceId>`. REAL occt-wasm kernel
// in Node. The measurements come from a SECOND, independent kernel that loads
// the result's BREP: bounds, volume, centre of mass and point membership (a
// tiny probe cube cut from the solid removes material only where material is),
// never triangle counts.
//
// The body: box [0,10]x[0,6]x[0,4] minus notch [0,2]x[0,3]x[2,4] = 228 mm3,
// centroid (5.2105263158, 3.0789473684, 1.9473684211).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel, type ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, PlaneDef } from '../../geom/geom-service.ts'

const ABS = 1e-6
const REL_VOLUME = 1e-6
const CENTROID: [number, number, number] = [5.2105263158, 3.0789473684, 1.9473684211]

const plane = (origin: [number, number, number], normal: [number, number, number]): PlaneDef => ({
  origin: { x: origin[0], y: origin[1], z: origin[2] },
  normal: { x: normal[0], y: normal[1], z: normal[2] },
  xDir: { x: 0, y: 0, z: 1 },
})

describe('transformBody mirror (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  let oracle: OcctKernel
  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
    oracle = await OcctKernel.init()
  }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  /** The notched source body, built through the engine's own ops. */
  async function notchedBody(): Promise<BodyHandle> {
    const box = (await engine.makeBox('F1', { x: 10, y: 6, z: 4 })).body!
    const notchAtOrigin = (await engine.makeBox('N0', { x: 2, y: 3, z: 2 })).body!
    const notch = await engine.transformBody({ featureId: 'N1', body: notchAtOrigin, transform: { kind: 'translate', delta: { x: 0, y: 0, z: 2 } }, identity: 'copy' })
    expect(notch.ok).toBe(true)
    const cut = await engine.applyBoolean({ featureId: 'F2', op: 'cut', target: box, tools: [notch.body!] })
    expect(cut.ok).toBe(true)
    return cut.body!
  }

  /** Load a body into the independent oracle kernel. */
  async function oracleShape(h: BodyHandle): Promise<ShapeHandle> {
    return oracle.fromBREPBinary(new Uint8Array(await engine.serializeBody(h)))
  }

  /** Material at p? A 0.2 mm cube centred on p, cut from the solid. */
  function materialAt(shape: ShapeHandle, p: [number, number, number]): boolean {
    const h = 0.1
    const probe = oracle.makeBoxFromCorners({ x: p[0] - h, y: p[1] - h, z: p[2] - h }, { x: p[0] + h, y: p[1] + h, z: p[2] + h })
    const rest = oracle.cut(shape, probe)
    const removed = oracle.getVolume(shape) - oracle.getVolume(rest)
    oracle.release(probe)
    oracle.release(rest)
    return removed > 1e-4
  }

  it('reflects in x=20: bounds x 30..40, notch at x 38..40, volume and centroid exact', async () => {
    const src = await notchedBody()
    const srcShape = await oracleShape(src)
    expect(Math.abs(oracle.getVolume(srcShape) - 228) / 228).toBeLessThan(REL_VOLUME)
    const c0 = oracle.getCenterOfMass(srcShape)
    expect(Math.abs(c0.x - CENTROID[0])).toBeLessThan(ABS)
    expect(Math.abs(c0.y - CENTROID[1])).toBeLessThan(ABS)
    expect(Math.abs(c0.z - CENTROID[2])).toBeLessThan(ABS)

    const r = await engine.transformBody({ featureId: 'M', body: src, transform: { kind: 'mirror', plane: plane([20, 0, 0], [1, 0, 0]) }, identity: 'replace' })
    expect(r.ok).toBe(true)
    const shape = await oracleShape(r.body!)
    const b = oracle.getBoundingBox(shape, false)
    expect(Math.abs(b.xmin - 30)).toBeLessThan(ABS)
    expect(Math.abs(b.xmax - 40)).toBeLessThan(ABS)
    expect(Math.abs(b.ymin - 0)).toBeLessThan(ABS)
    expect(Math.abs(b.ymax - 6)).toBeLessThan(ABS)
    expect(Math.abs(b.zmin - 0)).toBeLessThan(ABS)
    expect(Math.abs(b.zmax - 4)).toBeLessThan(ABS)
    expect(Math.abs(oracle.getVolume(shape) - 228) / 228).toBeLessThan(REL_VOLUME)
    const c = oracle.getCenterOfMass(shape)
    expect(Math.abs(c.x - 34.7894736842)).toBeLessThan(ABS)
    expect(Math.abs(c.y - 3.0789473684)).toBeLessThan(ABS)
    expect(Math.abs(c.z - 1.9473684211)).toBeLessThan(ABS)
    // the notch moved to x 38..40, y 0..3, z 2..4
    expect(materialAt(shape, [39, 1, 3])).toBe(false)
    expect(materialAt(shape, [31, 1, 3])).toBe(true)
    expect(materialAt(shape, [39, 4.5, 3])).toBe(true)
    expect(materialAt(shape, [39, 1, 1])).toBe(true)
    // the source body is untouched
    expect(materialAt(srcShape, [1, 1, 3])).toBe(false)
    expect(materialAt(srcShape, [9, 1, 3])).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('an offset plane x=22 moves the reflection +4 mm', async () => {
    const src = await notchedBody()
    const r = await engine.transformBody({ featureId: 'M', body: src, transform: { kind: 'mirror', plane: plane([22, 0, 0], [1, 0, 0]) }, identity: 'replace' })
    expect(r.ok).toBe(true)
    const b = oracle.getBoundingBox(await oracleShape(r.body!), false)
    expect(Math.abs(b.xmin - 34)).toBeLessThan(ABS)
    expect(Math.abs(b.xmax - 44)).toBeLessThan(ABS)
    await engine.disposeAll()
  }, 60_000)

  it('an oblique plane through (2,0,0), normal (1,1,0)/sqrt2, maps the centroid by the reflection formula', async () => {
    const src = await notchedBody()
    const s = Math.SQRT1_2
    const r = await engine.transformBody({ featureId: 'M', body: src, transform: { kind: 'mirror', plane: plane([2, 0, 0], [s, s, 0]) }, identity: 'replace' })
    expect(r.ok).toBe(true)
    const shape = await oracleShape(r.body!)
    // (x,y,z) -> (2 - y, 2 - x, z): (3,4,5) -> (-2,-1,5)
    const map = (p: [number, number, number]): [number, number, number] => [2 - p[1], 2 - p[0], p[2]]
    expect(map([3, 4, 5])).toEqual([-2, -1, 5])
    const c = oracle.getCenterOfMass(shape)
    const want = map(CENTROID)
    expect(Math.abs(c.x - want[0])).toBeLessThan(ABS)
    expect(Math.abs(c.y - want[1])).toBeLessThan(ABS)
    expect(Math.abs(c.z - want[2])).toBeLessThan(ABS)
    expect(materialAt(shape, map([1, 1, 3]))).toBe(false)
    expect(materialAt(shape, map([9, 1, 3]))).toBe(true)
    expect(Math.abs(oracle.getVolume(shape) - 228) / 228).toBeLessThan(REL_VOLUME)
    await engine.disposeAll()
  }, 60_000)

  // Audit 10-29 (astra): a plane at 30 deg to YZ through (20,0,0) refused this
  // body with "1 face(s) of the moved body match no source face" - each face
  // was found by reflecting its bounding-box centre, which a reflection does
  // not carry for an asymmetric face. The names now come from the kernel's own
  // record of the move, so every face lands on the reflected copy of itself.
  it('a plane at 30 deg through (20,0,0) mirrors the notched body and names every face on its own reflection', async () => {
    const src = await notchedBody()
    const srcSnaps = engine.snapshotsFor(src)
    const n: [number, number, number] = [Math.sqrt(3) / 2, 0.5, 0]
    const o: [number, number, number] = [20, 0, 0]
    const reflect = (p: [number, number, number]): [number, number, number] => {
      const d = (p[0] - o[0]) * n[0] + (p[1] - o[1]) * n[1] + (p[2] - o[2]) * n[2]
      return [p[0] - 2 * d * n[0], p[1] - 2 * d * n[1], p[2] - 2 * d * n[2]]
    }
    const reflectDir = (v: [number, number, number]): [number, number, number] => {
      const d = v[0] * n[0] + v[1] * n[1] + v[2] * n[2]
      return [v[0] - 2 * d * n[0], v[1] - 2 * d * n[1], v[2] - 2 * d * n[2]]
    }
    const dot = (a: readonly number[], b: readonly number[]) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
    const r = await engine.transformBody({ featureId: 'M', body: src, transform: { kind: 'mirror', plane: plane(o, n) }, identity: 'replace' })
    expect(r.diagnostics).toEqual([{ code: 'OK', severity: 'info' }])
    expect(r.ok).toBe(true)
    const shape = await oracleShape(r.body!)
    expect(Math.abs(oracle.getVolume(shape) - 228) / 228).toBeLessThan(REL_VOLUME)
    const c = oracle.getCenterOfMass(shape)
    const want = reflect(CENTROID)
    expect(Math.abs(c.x - want[0])).toBeLessThan(ABS)
    expect(Math.abs(c.y - want[1])).toBeLessThan(ABS)
    expect(Math.abs(c.z - want[2])).toBeLessThan(ABS)
    expect(materialAt(shape, reflect([1, 1, 3]))).toBe(false)
    expect(materialAt(shape, reflect([9, 1, 3]))).toBe(true)
    // every source face named once, each on the reflection of ITS plane: same
    // area, reflected normal, and the reflected plane offset (every face of
    // this body is level or upright, so its box centre lies in its plane).
    const out = engine.snapshotsFor(r.body!)
    expect(Object.keys(out).sort()).toEqual(Object.keys(srcSnaps).map((id) => `M:PAT:i1:${id}`).sort())
    for (const [id, s] of Object.entries(srcSnaps)) {
      const m = out[`M:PAT:i1:${id}`]
      expect(m.type, id).toBe('plane')
      expect(Math.abs(m.area - s.area), id).toBeLessThan(1e-6)
      const wantN = reflectDir(s.normal)
      expect(Math.abs(Math.abs(dot(m.normal, wantN)) - 1), id).toBeLessThan(1e-9)
      expect(Math.abs(dot(wantN, m.centroid) - dot(wantN, reflect(s.centroid))), id).toBeLessThan(ABS)
    }
    await engine.disposeAll()
  }, 60_000)

  it('reflecting twice gives back the original body', async () => {
    const src = await notchedBody()
    const p = plane([20, 0, 0], [1, 0, 0])
    const once = await engine.transformBody({ featureId: 'M1', body: src, transform: { kind: 'mirror', plane: p }, identity: 'replace' })
    const twice = await engine.transformBody({ featureId: 'M2', body: once.body!, transform: { kind: 'mirror', plane: p }, identity: 'replace' })
    expect(twice.ok).toBe(true)
    const shape = await oracleShape(twice.body!)
    const b = oracle.getBoundingBox(shape, false)
    expect(Math.abs(b.xmin)).toBeLessThan(ABS)
    expect(Math.abs(b.xmax - 10)).toBeLessThan(ABS)
    const c = oracle.getCenterOfMass(shape)
    expect(Math.abs(c.x - CENTROID[0])).toBeLessThan(ABS)
    expect(materialAt(shape, [1, 1, 3])).toBe(false)
    expect(materialAt(shape, [9, 1, 3])).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('names every face <M>:PAT:i1:<source face>, replace records modified[source]=[result]', async () => {
    const src = await notchedBody()
    const srcIds = Object.keys(engine.snapshotsFor(src)).sort()
    const r = await engine.transformBody({ featureId: 'M', body: src, transform: { kind: 'mirror', plane: plane([20, 0, 0], [1, 0, 0]) }, identity: 'replace' })
    const dm = r.elementMap!
    expect(dm.generated).toEqual([])
    expect(dm.deleted).toEqual([])
    expect(Object.keys(dm.modified).sort()).toEqual(srcIds)
    for (const id of srcIds) expect(dm.modified[id]).toEqual([`M:PAT:i1:${id}`])
    expect(Object.keys(engine.snapshotsFor(r.body!)).sort()).toEqual(srcIds.map((id) => `M:PAT:i1:${id}`).sort())
    // each id lands on the reflected copy of ITS face, not an enumeration slot:
    // a source face at x=0 (xMin) reflects to x=40.
    const g = dm.geometry!
    expect(g['M:PAT:i1:F1:BOX:xMin'].centroid.x).toBeCloseTo(40, 6)
    expect(g['M:PAT:i1:F1:BOX:xMax'].centroid.x).toBeCloseTo(30, 6)
    // the same request twice names the same faces
    const again = await engine.transformBody({ featureId: 'M', body: src, transform: { kind: 'mirror', plane: plane([20, 0, 0], [1, 0, 0]) }, identity: 'replace' })
    expect(again.elementMap!.modified).toEqual(dm.modified)
    await engine.disposeAll()
  }, 60_000)

  it('copy identity lists the result faces as generated and modifies nothing', async () => {
    const src = await notchedBody()
    const r = await engine.transformBody({ featureId: 'M', body: src, transform: { kind: 'mirror', plane: plane([20, 0, 0], [1, 0, 0]) }, identity: 'copy' })
    expect(r.elementMap!.modified).toEqual({})
    expect(r.elementMap!.generated.length).toBe(Object.keys(engine.snapshotsFor(src)).length)
    await engine.disposeAll()
  }, 60_000)

  it('a tube (coaxial inner and outer walls share a centroid) and a thin plate are named by their own faces', async () => {
    const xy: PlaneDef = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
    const tube = await engine.makeExtrude({
      featureId: 'T',
      profiles: [{
        sketchId: 'ST', plane: xy,
        loops: [
          [{ kind: 'arc', c: [0, 0], r: 5, a0: 0, a1: Math.PI * 2, ccw: true, srcId: 'ST.outer' }],
          [{ kind: 'arc', c: [0, 0], r: 3, a0: 0, a1: Math.PI * 2, ccw: false, srcId: 'ST.inner' }],
        ],
      }],
      end: { kind: 'blind', distance: 8 },
      op: 'newBody',
    })
    expect(tube.ok).toBe(true)
    const srcSnaps = engine.snapshotsFor(tube.body!)
    const r = await engine.transformBody({ featureId: 'MT', body: tube.body!, transform: { kind: 'mirror', plane: plane([20, 0, 0], [1, 0, 0]) }, identity: 'replace' })
    expect(r.ok).toBe(true)
    const out = engine.snapshotsFor(r.body!)
    for (const [id, snap] of Object.entries(srcSnaps)) {
      const mirrored = out[`MT:PAT:i1:${id}`]
      expect(mirrored, id).toBeDefined()
      expect(mirrored.type).toBe(snap.type)
      expect(Math.abs(mirrored.area - snap.area)).toBeLessThan(1e-6 * Math.max(1, snap.area))
      if (snap.radius !== undefined) expect(mirrored.radius).toBeCloseTo(snap.radius, 9)
    }
    // a thin plate: top and bottom planes 0.5 mm apart with equal areas
    const plate = (await engine.makeBox('P0', { x: 100, y: 100, z: 0.5 })).body!
    const r1 = await engine.transformBody({ featureId: 'MP', body: plate, transform: { kind: 'mirror', plane: plane([0, 0, 10], [0, 0, 1]) }, identity: 'replace' })
    expect(r1.ok).toBe(true)
    expect(r1.elementMap!.geometry!['MP:PAT:i1:P0:BOX:zMax'].centroid.z).toBeCloseTo(19.5, 6)
    expect(r1.elementMap!.geometry!['MP:PAT:i1:P0:BOX:zMin'].centroid.z).toBeCloseTo(20, 6)
    await engine.disposeAll()
  }, 60_000)

  it('a zero plane normal fails with the structured diagnostic and a plain reason, leaving the source', async () => {
    const src = await notchedBody()
    const r = await engine.transformBody({ featureId: 'M', body: src, transform: { kind: 'mirror', plane: plane([20, 0, 0], [0, 0, 0]) }, identity: 'replace' })
    expect(r.ok).toBe(false)
    expect(r.body).toBeUndefined()
    expect(r.diagnostics[0].code).toBe('PATTERN_FAILED')
    expect(String(r.diagnostics[0].params?.reason)).toMatch(/plane has no direction/)
    expect(materialAt(await oracleShape(src), [9, 1, 3])).toBe(true)
    await engine.disposeAll()
  }, 60_000)
})
