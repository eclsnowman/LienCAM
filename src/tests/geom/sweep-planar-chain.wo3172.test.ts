// WO-3229 (WO-3172 Draft B): right-corner sweep along a planar line/arc chain.
// Geometry is judged against closed-form solids, not against the kernel's own
// output: the body is copied out as BREP into an independent kernel and cut
// by exact planes, so the section areas are real sections of the result.
// REAL occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { OcctKernel, TransitionMode, type ShapeHandle } from 'occt-wasm'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { BodyHandle, OpResult, PathChain, ProfileRegion, SweepRequest } from '../../geom/geom-service.ts'

type V3 = [number, number, number]
const REL = 1e-6

// Path plane: world XY (normal +Z). Every path below starts at the origin
// heading +X, so with the profile plane's xDir = +Y the profile's 2D (u, v)
// lands at world (0, u, v): u is the left offset of travel, v the height.
const xy: PathChain['plane'] = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
const yz: ProfileRegion['plane'] = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } }

function circle(sketchId: string, r: number, c: [number, number] = [0, 0], srcId = `${sketchId}.c0`): ProfileRegion['loops'][number] {
  return [{ kind: 'arc', c, r, a0: 0, a1: Math.PI * 2, ccw: true, srcId }]
}
function rect(prefix: string, u0: number, v0: number, u1: number, v1: number): ProfileRegion['loops'][number] {
  return [
    { kind: 'line', a: [u0, v0], b: [u1, v0], srcId: `${prefix}.e0` },
    { kind: 'line', a: [u1, v0], b: [u1, v1], srcId: `${prefix}.e1` },
    { kind: 'line', a: [u1, v1], b: [u0, v1], srcId: `${prefix}.e2` },
    { kind: 'line', a: [u0, v1], b: [u0, v0], srcId: `${prefix}.e3` },
  ]
}
function profile(sketchId: string, ...loops: ProfileRegion['loops']): ProfileRegion {
  return { sketchId, plane: yz, loops }
}
/** Polyline path through 2D points. */
function poly(sketchId: string, pts: Array<[number, number]>): PathChain {
  return {
    sketchId, plane: xy,
    segments: pts.slice(1).map((b, i) => ({ kind: 'line' as const, a: pts[i], b, srcId: `${sketchId}.p${i}` })),
  }
}
function sweepReq(featureId: string, prof: ProfileRegion, path: PathChain, extra: Partial<SweepRequest> = {}): SweepRequest {
  return { featureId, profile: prof, path, orientation: 'frenet', op: 'newBody', transition: 'rightCorner', ...extra }
}

describe('right-corner sweep along a planar line/arc chain (WO-3229)', () => {
  let engine: GeomEngine
  let k: OcctKernel
  beforeAll(async () => {
    engine = new GeomEngine(); await engine.init()
    k = await OcctKernel.init()
  }, 120_000)
  afterAll(async () => {
    await engine.disposeKernel()
    k[Symbol.dispose]()
  })

  const rel = (a: number, b: number): number => Math.abs(a - b) / Math.abs(b)
  async function shapeOf(r: OpResult): Promise<ShapeHandle> {
    return k.fromBREPBinary(new Uint8Array(await engine.serializeBody(r.body as BodyHandle)))
  }
  /** Area of the solid's section by the plane through `o` with normal `n`,
   *  kept to the part of that plane within `reach` of `o`. */
  function sectionArea(s: ShapeHandle, o: V3, n: V3, reach = 6): number {
    const l = Math.hypot(...n); const nn: V3 = [n[0] / l, n[1] / l, n[2] / l]
    const a: V3 = Math.abs(nn[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0]
    const u: V3 = [nn[1] * a[2] - nn[2] * a[1], nn[2] * a[0] - nn[0] * a[2], nn[0] * a[1] - nn[1] * a[0]]
    const ul = Math.hypot(...u); const uu: V3 = [u[0] / ul, u[1] / ul, u[2] / ul]
    const w: V3 = [nn[1] * uu[2] - nn[2] * uu[1], nn[2] * uu[0] - nn[0] * uu[2], nn[0] * uu[1] - nn[1] * uu[0]]
    const at = (s1: number, s2: number) => ({ x: o[0] + reach * (s1 * uu[0] + s2 * w[0]), y: o[1] + reach * (s1 * uu[1] + s2 * w[1]), z: o[2] + reach * (s1 * uu[2] + s2 * w[2]) })
    const c = [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)]
    const face = k.makeFace(k.makeWire(c.map((p, i) => k.makeLineEdge(p, c[(i + 1) % 4]))))
    return k.getSurfaceArea(k.common(s, face))
  }
  function geometryOf(r: OpResult, id: string) {
    const g = r.elementMap!.geometry![id]
    expect(g, `geometry for ${id}`).toBeDefined()
    return g
  }
  const near = (p: { x: number; y: number; z: number }, q: V3, tol = 1e-6): void => {
    expect(Math.hypot(p.x - q[0], p.y - q[1], p.z - q[2])).toBeLessThan(tol)
  }

  it('quarter arc tube has analytic volume and three normal circular sections', async () => {
    const R = 20, r = 2
    const path: PathChain = { sketchId: 'PA', plane: xy, segments: [{ kind: 'arc', c: [0, R], r: R, a0: -Math.PI / 2, a1: 0, ccw: true, srcId: 'PA.a0' }] }
    const res = await engine.makeSweep(sweepReq('F1', profile('C1', circle('C1', r)), path))
    expect(res.ok).toBe(true)
    const vol = await engine.measure(res.body!, 'volume')
    expect(rel(vol.value, 394.7841760435743)).toBeLessThan(REL)
    const s = await shapeOf(res)
    for (const t of [0, Math.PI / 4, Math.PI / 2]) {
      // point on the arc at angle -90deg + t; the normal plane is the tangent plane.
      const o: V3 = [R * Math.sin(t), R - R * Math.cos(t), 0]
      const n: V3 = [Math.cos(t), Math.sin(t), 0]
      expect(rel(sectionArea(s, o, n), 12.566370614359172)).toBeLessThan(REL)
    }
    // the caps sit on the true endpoints, perpendicular to the end tangents.
    const cs = geometryOf(res, 'F1:SWP:C1:capStart'), ce = geometryOf(res, 'F1:SWP:C1:capEnd')
    near(cs.centroid, [0, 0, 0]); near(ce.centroid, [R, R, 0])
    expect(Math.abs(cs.normal!.x)).toBeGreaterThan(1 - 1e-9)
    expect(Math.abs(ce.normal!.y)).toBeGreaterThan(1 - 1e-9)
    await engine.disposeAll()
  }, 120_000)

  it('right miter follows both legs with analytic volume and bisector ellipse', async () => {
    const res = await engine.makeSweep(sweepReq('F2', profile('C2', circle('C2', 2)), poly('PL', [[0, 0], [20, 0], [20, 20]])))
    expect(res.ok).toBe(true)
    const vol = await engine.measure(res.body!, 'volume')
    expect(rel(vol.value, 502.6548245743669)).toBeLessThan(REL)
    const s = await shapeOf(res)
    expect(rel(sectionArea(s, [10, 0, 0], [1, 0, 0]), 4 * Math.PI)).toBeLessThan(REL)
    expect(rel(sectionArea(s, [20, 10, 0], [0, 1, 0]), 4 * Math.PI)).toBeLessThan(REL)
    // the mitre plane holds the corner and bisects the two tangents.
    expect(rel(sectionArea(s, [20, 0, 0], [1, 1, 0]), 4 * Math.PI * Math.SQRT2)).toBeLessThan(REL)
    // both legs reach their ends: end cap centred on the path end, facing +Y.
    near(geometryOf(res, 'F2:SWP:C2:capEnd').centroid, [20, 20, 0])
    // A right turn with the profile on the right (inside) of travel: square
    // u in [-3,-1] (q = -2): centroid travels 20 - 2 + 20 - 2 = 36, V = 4 * 36.
    const right = await engine.makeSweep(sweepReq('F2r', profile('S2', rect('S2', -3, -1, -1, 1)), poly('PR2', [[0, 0], [20, 0], [20, -20]])))
    expect(right.ok).toBe(true)
    expect(rel((await engine.measure(right.body!, 'volume')).value, 144)).toBeLessThan(REL)
    near(geometryOf(right, 'F2r:SWP:S2:capEnd').centroid, [18, -20, 0])
    await engine.disposeAll()
  }, 120_000)

  it('line arc line tangent chain preserves exact arcs and reaches both endpoints', async () => {
    const path: PathChain = {
      sketchId: 'PT', plane: xy, segments: [
        { kind: 'line', a: [0, 0], b: [10, 0], srcId: 'PT.p0' },
        { kind: 'arc', c: [10, 20], r: 20, a0: -Math.PI / 2, a1: 0, ccw: true, srcId: 'PT.a1' },
        { kind: 'line', a: [30, 20], b: [30, 30], srcId: 'PT.p2' },
      ],
    }
    const res = await engine.makeSweep(sweepReq('F3', profile('C3', circle('C3', 2)), path))
    expect(res.ok).toBe(true)
    const vol = await engine.measure(res.body!, 'volume')
    expect(rel(vol.value, 4 * Math.PI * (20 + 10 * Math.PI))).toBeLessThan(REL)
    expect(geometryOf(res, 'F3:SWP:C3.c0xPT.p0:side').surfaceType).toBe('cylinder')
    const tor = geometryOf(res, 'F3:SWP:C3.c0xPT.a1:side')
    expect(tor.surfaceType).toBe('torus')
    expect(geometryOf(res, 'F3:SWP:C3.c0xPT.p2:side').surfaceType).toBe('cylinder')
    near(geometryOf(res, 'F3:SWP:C3:capStart').centroid, [0, 0, 0])
    near(geometryOf(res, 'F3:SWP:C3:capEnd').centroid, [30, 30, 0])
    const s = await shapeOf(res)
    // a normal section in the middle of the arc is still the full circle.
    const t = Math.PI / 4
    expect(rel(sectionArea(s, [10 + 20 * Math.sin(t), 20 - 20 * Math.cos(t), 0], [Math.cos(t), Math.sin(t), 0]), 4 * Math.PI)).toBeLessThan(REL)
    // S-bend of two tangent arcs, ccw then cw, with the profile offset to the
    // right by 1: the offset centroid runs R - q on the ccw arc and R + q on the
    // cw arc, so the two offsets cancel and V = A * (10*pi/2) * 2 = 4 * 10*pi.
    const sbend: PathChain = {
      sketchId: 'PS', plane: xy, segments: [
        { kind: 'arc', c: [0, 10], r: 10, a0: -Math.PI / 2, a1: 0, ccw: true, srcId: 'PS.a0' },
        { kind: 'arc', c: [20, 10], r: 10, a0: Math.PI, a1: Math.PI / 2, ccw: false, srcId: 'PS.a1' },
      ],
    }
    const sb = await engine.makeSweep(sweepReq('F3s', profile('S3', rect('S3', -2, -1, 0, 1)), sbend))
    expect(sb.ok).toBe(true)
    expect(rel((await engine.measure(sb.body!, 'volume')).value, 40 * Math.PI)).toBeLessThan(REL)
    // end at (20, 20) heading +X: right of travel is -Y, so q = -1 lands at y = 19.
    near(geometryOf(sb, 'F3s:SWP:S3:capEnd').centroid, [20, 19, 0])
    expect(geometryOf(sb, 'F3s:SWP:S3.e0xPS.a1:side').surfaceType).toBe('plane')
    await engine.disposeAll()
  }, 120_000)

  it('asymmetric offset profile keeps the displayed start placement and transported axes', async () => {
    // Square u in [3,5], v in [0,2]: left of travel by 3..5, above the path by 0..2.
    const res = await engine.makeSweep(sweepReq('F4', profile('S4', rect('S4', 3, 0, 5, 2)), poly('P4', [[0, 0], [20, 0], [20, 20]])))
    expect(res.ok).toBe(true)
    // Left turn with the profile on the inside: the centroid (q = 4) travels
    // 20 - 4 + 20 - 4 = 32, so V = 4 * 32 exactly.
    const vol = await engine.measure(res.body!, 'volume')
    expect(rel(vol.value, 128)).toBeLessThan(REL)
    // Start: no recentring, the profile sits where the sketch put it.
    near(geometryOf(res, 'F4:SWP:S4:capStart').centroid, [0, 4, 1])
    // End: travel is +Y, so left is -X: the same offsets land at x = 20 - 4.
    near(geometryOf(res, 'F4:SWP:S4:capEnd').centroid, [16, 20, 1])
    // Transported axes: edge e1 (u = 5) is the inner wall at x = 15 on leg 2
    // and at y = 5 on leg 1; edge e2 (v = 2) stays the top face on both legs.
    expect(geometryOf(res, 'F4:SWP:S4.e1xP4.p1:side').centroid.x).toBeCloseTo(15, 9)
    expect(geometryOf(res, 'F4:SWP:S4.e1xP4.p0:side').centroid.y).toBeCloseTo(5, 9)
    expect(geometryOf(res, 'F4:SWP:S4.e2xP4.p0:side').centroid.z).toBeCloseTo(2, 9)
    expect(geometryOf(res, 'F4:SWP:S4.e2xP4.p1:side').centroid.z).toBeCloseTo(2, 9)
    await engine.disposeAll()
  }, 120_000)

  it('self crossing path backtracking and overlapping envelope never yield an accepted wrong solid', async () => {
    const tube = profile('C5', circle('C5', 1))
    const cases: Array<{ name: string; path: PathChain; prof?: ProfileRegion; reason: RegExp }> = [
      { name: 'crossing X', path: poly('PX', [[0, 0], [20, 0], [20, 10], [10, 10], [10, -10]]), reason: /runs into itself between segments PX\.p0 and PX\.p3/ },
      { name: 'exact reverse', path: poly('PR', [[0, 0], [10, 0], [5, 0]]), reason: /reverses direction between PR\.p0 and PR\.p1/ },
      { name: 'zero segment', path: poly('PZ', [[0, 0], [10, 0], [10, 0], [10, 10]]), reason: /PZ\.p1 has zero length/ },
      { name: 'tight U', path: poly('PU', [[0, 0], [20, 0], [20, 3], [0, 3]]), prof: profile('C6', circle('C6', 2)), reason: /PU\.p1 is too short/ },
      // Centrelines never cross and every leg passes the corner checks, but the
      // returning leg ends 1.5 mm from the first leg with a 2 mm wide tube.
      { name: 'overlapping envelope', path: poly('PV', [[0, 0], [20, 0], [20, 5], [0, 1.5]]), reason: /runs into itself between segments PV\.p0 and PV\.p2/ },
      // The kernel's right-corner joint where an arc meets a corner is not the
      // bisector mitre: it returns a valid solid of the wrong volume (r = 1:
      // 146.6 mm3 where the mitre gives 129.4). Such a joint is refused, in
      // both directions and both turns.
      {
        name: 'arc into a left corner',
        path: { sketchId: 'PK', plane: xy, segments: [
          { kind: 'arc', c: [0, 20], r: 20, a0: -Math.PI / 2, a1: 0, ccw: true, srcId: 'PK.a0' },
          { kind: 'line', a: [20, 20], b: [10, 20], srcId: 'PK.p1' },
        ] },
        reason: /arc PK\.a0 meets PK\.p1 at a corner/,
      },
      {
        name: 'line into an arc corner',
        path: { sketchId: 'PJ', plane: xy, segments: [
          { kind: 'line', a: [0, 0], b: [10, 0], srcId: 'PJ.p0' },
          { kind: 'arc', c: [0, 0], r: 10, a0: 0, a1: Math.PI / 2, ccw: true, srcId: 'PJ.a1' },
        ] },
        reason: /PJ\.p0 meets arc PJ\.a1 at a corner/,
      },
    ]
    for (const c of cases) {
      const res = await engine.makeSweep(sweepReq('F5', c.prof ?? tube, c.path))
      expect(res.ok, c.name).toBe(false)
      expect(res.body, c.name).toBeUndefined()
      expect(res.diagnostics[0].code).toBe('SWEEP_FAILED')
      expect(String(res.diagnostics[0].params!.reason), c.name).toMatch(c.reason)
    }
    // The kernel alone accepts the crossing X: a valid, solid, positive-volume
    // result. That is why validity and volume cannot be the check.
    const P = (x: number, y: number) => ({ x, y, z: 0 })
    const pts = [P(0, 0), P(20, 0), P(20, 10), P(10, 10), P(10, -10)]
    const spine = k.makeWire(pts.slice(1).map((p, i) => k.makeLineEdge(pts[i], p)))
    const raw = k.sweep(k.makeWire([k.makeCircleEdge(P(0, 0), { x: 1, y: 0, z: 0 }, 1)]), spine, TransitionMode.RightCorner)
    expect(k.isValid(raw)).toBe(true)
    expect(k.getVolume(raw)).toBeGreaterThan(0)
    await engine.disposeAll()
  }, 120_000)

  it('failed new mode leaves target and kernel handle count unchanged', async () => {
    const box = await engine.makeBox('B6', { x: 40, y: 40, z: 40 })
    const target = box.body!
    const before = (await engine.measure(target, 'volume')).value
    const ids = [...box.elementMap!.generated].sort()
    const shapes = engine.debugKernelShapeCount()
    for (const path of [poly('PX6', [[0, 0], [20, 0], [20, 10], [10, 10], [10, -10]]), poly('PR6', [[0, 0], [10, 0], [5, 0]])]) {
      const res = await engine.makeSweep(sweepReq('F6', profile('C6', circle('C6', 1)), path, { op: 'cut', target }))
      expect(res.ok).toBe(false)
      expect(res.body).toBeUndefined()
      expect(String(res.diagnostics[0].params!.reason).toLowerCase()).not.toContain('webassembly')
      expect(engine.debugKernelShapeCount()).toBe(shapes)
      expect(engine.debugTransientCount()).toBe(0)
    }
    // A transition this kernel does not build is refused, not run as the pipe.
    const unknown = await engine.makeSweep({ ...sweepReq('F6u', profile('C6', circle('C6', 1)), poly('PU6', [[0, 0], [20, 0]]), { op: 'cut', target }), transition: 'roundCorner' as unknown as 'rightCorner' })
    expect(unknown.ok).toBe(false)
    expect(String(unknown.diagnostics[0].params!.reason)).toContain("'roundCorner'")
    expect(engine.debugKernelShapeCount()).toBe(shapes)
    expect((await engine.measure(target, 'volume')).value).toBe(before)
    const still = await engine.measure(target, 'area', ids)
    expect(still.aux).toBeUndefined()
    // The same target still takes a good right-corner cut: an L tube inside the box.
    const inside: PathChain = { ...poly('PI6', [[0, 0], [20, 0], [20, 20]]), plane: { ...xy, origin: { x: 5, y: 5, z: 20 } } }
    const ok = await engine.makeSweep(sweepReq('F6b', profile('C6', circle('C6', 2)), inside, { op: 'cut', target }))
    expect(ok.ok).toBe(true)
    expect(rel((await engine.measure(ok.body!, 'volume')).value, before - 502.6548245743669)).toBeLessThan(REL)
    await engine.disposeAll()
  }, 120_000)

  it('closed profile with a hole preserves both loop volumes or reports the exact kernel limitation', async () => {
    const ring = profile('H7', circle('H7', 3, [0, 0], 'H7.o'), circle('H7', 1, [0, 0], 'H7.i'))
    const straight = await engine.makeSweep(sweepReq('F7', ring, poly('P7', [[0, 0], [20, 0]])))
    expect(straight.ok).toBe(true)
    expect(rel((await engine.measure(straight.body!, 'volume')).value, 160 * Math.PI)).toBeLessThan(REL)
    // both loops carry their own walls.
    expect(geometryOf(straight, 'F7:SWP:H7.oxP7.p0:side').surfaceType).toBe('cylinder')
    expect(geometryOf(straight, 'F7:SWP:H7.ixP7.p0:side').surfaceType).toBe('cylinder')
    // the hole survives the mitre too: annulus area 8*pi times 40.
    const bent = await engine.makeSweep(sweepReq('F8', ring, poly('P8', [[0, 0], [20, 0], [20, 20]])))
    expect(bent.ok).toBe(true)
    expect(rel((await engine.measure(bent.body!, 'volume')).value, 320 * Math.PI)).toBeLessThan(REL)
    const s = await shapeOf(bent)
    expect(rel(sectionArea(s, [20, 0, 0], [1, 1, 0]), 8 * Math.PI * Math.SQRT2)).toBeLessThan(REL)
    expect(rel(geometryOf(bent, 'F8:SWP:H7:capStart').area!, 8 * Math.PI)).toBeLessThan(REL)
    await engine.disposeAll()
  }, 120_000)
})
