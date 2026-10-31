// WO-3229 (WO-3172 Draft B): stable face identity of the right-corner chain
// sweep. Side faces are named by their (profile entity x path entity) pair and
// the caps by the path's start and end, so edits that keep the entities keep
// the ids, and edits that change the entities change exactly those ids.
// Requests without `transition` keep today's pipe sweep, geometry and ids.
// REAL occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { ElementMap } from '../../doc/element-map.ts'
import type { OpResult, PathChain, ProfileRegion, SweepRequest } from '../../geom/geom-service.ts'

const xy: PathChain['plane'] = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
const yz: ProfileRegion['plane'] = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } }

function square(sketchId: string): ProfileRegion {
  return {
    sketchId, plane: yz, loops: [[
      { kind: 'line', a: [-1, -1], b: [1, -1], srcId: `${sketchId}.e0` },
      { kind: 'line', a: [1, -1], b: [1, 1], srcId: `${sketchId}.e1` },
      { kind: 'line', a: [1, 1], b: [-1, 1], srcId: `${sketchId}.e2` },
      { kind: 'line', a: [-1, 1], b: [-1, -1], srcId: `${sketchId}.e3` },
    ]],
  }
}
function tube(sketchId: string, r: number): ProfileRegion {
  return { sketchId, plane: yz, loops: [[{ kind: 'arc', c: [0, 0], r, a0: 0, a1: Math.PI * 2, ccw: true, srcId: `${sketchId}.c0` }]] }
}
/** Line segments with explicit srcIds: [srcId, from, to]. */
function lines(sketchId: string, segs: Array<[string, [number, number], [number, number]]>): PathChain {
  return { sketchId, plane: xy, segments: segs.map(([srcId, a, b]) => ({ kind: 'line' as const, a, b, srcId })) }
}
function quarterArc(sketchId: string, R: number): PathChain {
  return { sketchId, plane: xy, segments: [{ kind: 'arc', c: [0, R], r: R, a0: -Math.PI / 2, a1: 0, ccw: true, srcId: `${sketchId}.a0` }] }
}
const L = (sketchId: string): PathChain => lines(sketchId, [[`${sketchId}.p0`, [0, 0], [20, 0]], [`${sketchId}.p1`, [20, 0], [20, 20]]])
function req(featureId: string, profile: ProfileRegion, path: PathChain, extra: Partial<SweepRequest> = {}): SweepRequest {
  return { featureId, profile, path, orientation: 'frenet', op: 'newBody', transition: 'rightCorner', ...extra }
}

describe('right-corner chain sweep face identity (WO-3229)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 120_000)
  afterAll(async () => { await engine.disposeKernel() })

  const ids = (r: OpResult): string[] => [...r.elementMap!.generated].sort()
  const centroid = (r: OpResult, id: string): [number, number, number] => {
    const c = r.elementMap!.geometry![id].centroid
    return [c.x, c.y, c.z]
  }

  it('legacy axis requests retain geometry and stable IDs with transition omitted', async () => {
    const legacy = (profile: ProfileRegion, path: PathChain): SweepRequest => ({ featureId: 'F8', profile, path, orientation: 'frenet', op: 'newBody' })
    // Straight square: the pipe sweep's volume and its exact id set.
    const straight = await engine.makeSweep(legacy(square('S8'), lines('P9', [['P8.p0', [0, 0], [20, 0]]])))
    expect(straight.ok).toBe(true)
    expect(Math.abs((await engine.measure(straight.body!, 'volume')).value - 80)).toBeLessThan(1e-9)
    expect(ids(straight)).toEqual(['F8:SWP:S8.e0xP8.p0:side', 'F8:SWP:S8.e1xP8.p0:side', 'F8:SWP:S8.e2xP8.p0:side', 'F8:SWP:S8.e3xP8.p0:side', 'F8:SWP:S8:capEnd', 'F8:SWP:S8:capStart'])
    // Quarter arc tube: unchanged volume and ids.
    const arc = await engine.makeSweep(legacy(tube('C8', 2), quarterArc('PA8', 20)))
    expect(arc.ok).toBe(true)
    expect(Math.abs((await engine.measure(arc.body!, 'volume')).value - 394.7841760435743) / 394.7841760435743).toBeLessThan(1e-9)
    expect(ids(arc)).toEqual(['F8:SWP:C8.c0xPA8.a0:side', 'F8:SWP:C8:capEnd', 'F8:SWP:C8:capStart'])
    // A kinked square path stays today's refusal: nothing new leaks into requests without the selector.
    const kinked = await engine.makeSweep(legacy(square('S8'), L('P8')))
    expect(kinked.ok).toBe(false)
    expect(String(kinked.diagnostics[0].params!.reason)).toContain('degenerate (zero-volume) solid')
    // `transition: undefined` is the same request as an omitted selector.
    const undef = await engine.makeSweep({ ...legacy(tube('C8', 2), quarterArc('PA8', 20)), transition: undefined })
    expect(ids(undef)).toEqual(ids(arc))
    expect(undef.elementMap!.geometry).toEqual(arc.elementMap!.geometry)
    await engine.disposeAll()
  }, 120_000)

  it('multi-edge square profile maps every planar side separately from exactly two caps', async () => {
    const r = await engine.makeSweep(req('F9', square('S9'), L('P9')))
    expect(r.ok).toBe(true)
    const all = ids(r)
    const sides = all.filter((id) => id.endsWith(':side'))
    expect(sides).toEqual(['p0', 'p1'].flatMap((p) => [0, 1, 2, 3].map((e) => `F9:SWP:S9.e${e}xP9.${p}:side`)).sort())
    expect(all.filter((id) => /:cap(Start|End)$/.test(id))).toEqual(['F9:SWP:S9:capEnd', 'F9:SWP:S9:capStart'])
    expect(all).toHaveLength(10)
    for (const id of all) expect(r.elementMap!.geometry![id].surfaceType).toBe('plane')
    // A side wall of the second leg is planar and faces along the START tangent
    // (+X): orientation alone would have called it a cap. It is a side.
    const g = r.elementMap!.geometry!['F9:SWP:S9.e1xP9.p1:side']
    expect(Math.abs(g.normal!.x)).toBeGreaterThan(1 - 1e-9)
    expect(centroid(r, 'F9:SWP:S9.e1xP9.p1:side')[0]).toBeCloseTo(19, 9)
    // Deterministic: a second run gives the same ids and the same geometry.
    const again = await engine.makeSweep(req('F9', square('S9'), L('P9')))
    expect(ids(again)).toEqual(all)
    expect(again.elementMap!.geometry).toEqual(r.elementMap!.geometry)
    await engine.disposeAll()
  }, 120_000)

  it('arc radius edit retains source-pair side IDs and updates bound face snapshots', async () => {
    const em = new ElementMap()
    const ref = 'F10:SWP:C10.c0xPA10.a0:side'
    const a = await engine.makeSweep(req('F10', tube('C10', 2), quarterArc('PA10', 20)))
    em.applyDelta(a.elementMap!, a.elementMap!.geometry)
    expect(em.resolve(ref).status).toBe('exact')
    const before = em.snapshotOf(ref)!
    // Edit: same sketch entity, radius 20 -> 30.
    const b = await engine.makeSweep(req('F10', tube('C10', 2), quarterArc('PA10', 30)))
    expect(ids(b)).toEqual(ids(a))
    em.applyDelta(b.elementMap!, b.elementMap!.geometry)
    const r = em.resolve(ref)
    expect(r.status).toBe('exact')
    expect(r.via).toBe('exact')
    const after = em.snapshotOf(ref)!
    expect(after.surfaceType).toBe('torus')
    // torus side area 4*pi^2*R*r/4 follows the edited radius.
    expect(before.area).toBeCloseTo(Math.PI * Math.PI * 20 * 2, 6)
    expect(after.area).toBeCloseTo(Math.PI * Math.PI * 30 * 2, 6)
    expect(em.snapshotOf('F10:SWP:C10:capEnd')!.centroid.x).toBeCloseTo(30, 9)
    await engine.disposeAll()
  }, 120_000)

  it('path reversal assigns caps by travel direction and never rebinds a deleted side', async () => {
    const fwd = await engine.makeSweep(req('F11', tube('C11', 1), L('P11')))
    expect(fwd.ok).toBe(true)
    // Same entities, drawn the other way round.
    const rev = await engine.makeSweep(req('F11', tube('C11', 1), lines('P11', [['P11.p1', [20, 20], [20, 0]], ['P11.p0', [20, 0], [0, 0]]])))
    expect(rev.ok).toBe(true)
    expect(ids(rev)).toEqual(ids(fwd))
    const dist = (p: [number, number, number], q: [number, number, number]): number => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
    expect(dist(centroid(fwd, 'F11:SWP:C11:capStart'), [0, 0, 0])).toBeLessThan(1e-6)
    expect(dist(centroid(rev, 'F11:SWP:C11:capStart'), [20, 20, 0])).toBeLessThan(1e-6)
    expect(dist(centroid(rev, 'F11:SWP:C11:capEnd'), [0, 0, 0])).toBeLessThan(1e-6)
    // Delete P11.p0: its side id is gone and is not handed to another face.
    const em = new ElementMap()
    em.applyDelta(fwd.elementMap!, fwd.elementMap!.geometry)
    const cut = await engine.makeSweep(req('F11', tube('C11', 1), lines('P11', [['P11.p1', [20, 0], [20, 20]]])))
    expect(cut.ok).toBe(true)
    expect(ids(cut)).toEqual(['F11:SWP:C11.c0xP11.p1:side', 'F11:SWP:C11:capEnd', 'F11:SWP:C11:capStart'])
    const gone = ids(fwd).filter((id) => !ids(cut).includes(id))
    expect(gone).toEqual(['F11:SWP:C11.c0xP11.p0:side'])
    em.applyDelta({ ...cut.elementMap!, deleted: gone }, cut.elementMap!.geometry)
    expect(em.has('F11:SWP:C11.c0xP11.p0:side')).toBe(false)
    // the surviving leg keeps its id on its own geometry (x = 20 wall).
    expect(centroid(cut, 'F11:SWP:C11.c0xP11.p1:side')[0]).toBeCloseTo(20, 9)
    await engine.disposeAll()
  }, 120_000)

  it('split merged and removed generating entities disclose changed face identity', async () => {
    const run = async (path: PathChain): Promise<string[]> => {
      const r = await engine.makeSweep(req('F12', square('S12'), path))
      expect(r.ok).toBe(true)
      const out = ids(r)
      await engine.disposeAll()
      return out
    }
    const side = (p: string): string[] => [0, 1, 2, 3].map((e) => `F12:SWP:S12.e${e}x${p}:side`)
    const base = await run(L('P12'))
    // Split P12.p0 into two collinear entities: its ids are replaced, not reused.
    const split = await run(lines('P12', [['P12.p0a', [0, 0], [10, 0]], ['P12.p0b', [10, 0], [20, 0]], ['P12.p1', [20, 0], [20, 20]]]))
    expect(base.filter((id) => !split.includes(id)).sort()).toEqual(side('P12.p0').sort())
    expect(split.filter((id) => !base.includes(id)).sort()).toEqual([...side('P12.p0a'), ...side('P12.p0b')].sort())
    // Merge both legs' entity ids back into one straight entity: new id, old ones gone.
    const merged = await run(lines('P12', [['P12.m', [0, 0], [20, 0]], ['P12.p1', [20, 0], [20, 20]]]))
    expect(split.filter((id) => !merged.includes(id)).sort()).toEqual([...side('P12.p0a'), ...side('P12.p0b')].sort())
    expect(merged.filter((id) => !split.includes(id)).sort()).toEqual(side('P12.m').sort())
    // Remove a profile edge's entity by renaming it: only that edge's sides change.
    const prof = square('S12')
    prof.loops[0][2] = { ...prof.loops[0][2], srcId: 'S12.top' }
    const r = await engine.makeSweep(req('F12', prof, L('P12')))
    const renamed = ids(r)
    expect(base.filter((id) => !renamed.includes(id)).sort()).toEqual(['F12:SWP:S12.e2xP12.p0:side', 'F12:SWP:S12.e2xP12.p1:side'])
    expect(renamed.filter((id) => !base.includes(id)).sort()).toEqual(['F12:SWP:S12.topxP12.p0:side', 'F12:SWP:S12.topxP12.p1:side'])
    await engine.disposeAll()
  }, 120_000)
})
