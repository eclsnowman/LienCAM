// GEO-5 acceptance #1 (sweep: fixed-orientation straight A*L; frenet 90deg-arc
// quarter-torus; constructed side/cap lineage), #5 (diagnostics), #7 (element
// map), #8 (wasm-handle lifecycle). REAL occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { ProfileRegion, PathChain, SweepRequest } from '../../geom/geom-service.ts'

// XY-plane basis (normal +Z, xDir +X).
const xy: ProfileRegion['plane'] = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }

// Square profile side S at 2D corner (0,0)->(S,S), area S*S.
function squareProfile(sketchId: string, S: number): ProfileRegion {
  return {
    sketchId,
    plane: xy,
    loops: [[
      { kind: 'line', a: [0, 0], b: [S, 0], srcId: `${sketchId}.e0` },
      { kind: 'line', a: [S, 0], b: [S, S], srcId: `${sketchId}.e1` },
      { kind: 'line', a: [S, S], b: [0, S], srcId: `${sketchId}.e2` },
      { kind: 'line', a: [0, S], b: [0, 0], srcId: `${sketchId}.e3` },
    ]],
  }
}

function circleProfile(sketchId: string, r: number): ProfileRegion {
  return {
    sketchId,
    plane: xy,
    loops: [[{ kind: 'arc', c: [0, 0], r, a0: 0, a1: Math.PI * 2, ccw: true, srcId: `${sketchId}.c0` }]],
  }
}

// Straight path along +Z of length L (2D line in a YZ-mapped plane).
function straightPath(sketchId: string, L: number): PathChain {
  return {
    sketchId,
    plane: { origin: { x: 0, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } },
    segments: [{ kind: 'line', a: [0, 0], b: [0, L], srcId: `${sketchId}.p0` }],
  }
}

// 90deg arc path in the XY plane: center (0,R), r=R, from -90deg to 0deg (ccw).
function arcPath(sketchId: string, R: number): PathChain {
  return {
    sketchId,
    plane: xy,
    segments: [{ kind: 'arc', c: [0, R], r: R, a0: -Math.PI / 2, a1: 0, ccw: true, srcId: `${sketchId}.a0` }],
  }
}

describe('makeSweep (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#1a fixed orientation, straight path length L, closed profile area A -> volume A*L', async () => {
    const S = 10, L = 30
    const req: SweepRequest = {
      featureId: 'F1', profile: squareProfile('S1', S), path: straightPath('P1', L),
      orientation: 'fixed', op: 'newBody',
    }
    const r = await engine.makeSweep(req)
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    const expected = S * S * L
    expect(Math.abs(vol.value - expected) / expected).toBeLessThan(1e-6)

    const dm = r.elementMap!
    // 4 side faces (one per profile edge x the single path segment) + 2 caps.
    for (const e of ['e0', 'e1', 'e2', 'e3']) {
      expect(dm.generated).toContain(`F1:SWP:S1.${e}xP1.p0:side`)
    }
    expect(dm.generated).toContain('F1:SWP:S1:capStart')
    expect(dm.generated).toContain('F1:SWP:S1:capEnd')
    for (const id of dm.generated) expect(dm.geometry![id]).toBeDefined()
    // caps at z=0 and z=L.
    expect(dm.geometry!['F1:SWP:S1:capStart'].centroid.z).toBeCloseTo(0, 4)
    expect(dm.geometry!['F1:SWP:S1:capEnd'].centroid.z).toBeCloseTo(L, 4)
    await engine.disposeAll()
  }, 60_000)

  it('#1b frenet along a 90deg arc (radius R) with a circular profile (radius r) -> quarter-torus analytic', async () => {
    const r = 2, R = 20
    const req: SweepRequest = {
      featureId: 'F2', profile: circleProfile('C1', r), path: arcPath('PA', R),
      orientation: 'frenet', op: 'newBody',
    }
    const res = await engine.makeSweep(req)
    expect(res.ok).toBe(true)
    const vol = await engine.measure(res.body!, 'volume')
    const analytic = Math.PI * r * r * (Math.PI / 2) * R
    expect(Math.abs(vol.value - analytic) / analytic).toBeLessThan(1e-6)
    const dm = res.elementMap!
    // one torus side wall from the single circular profile segment.
    expect(dm.generated).toContain('F2:SWP:C1.c0xPA.a0:side')
    expect(await engine.classifyFace(res.body!, 'F2:SWP:C1.c0xPA.a0:side')).toBe('torus')
    expect(dm.generated).toContain('F2:SWP:C1:capStart')
    expect(dm.generated).toContain('F2:SWP:C1:capEnd')
    await engine.disposeAll()
  }, 60_000)

  it('#5 DETERMINISM golden: two runs produce byte-identical id sets (not enumeration order)', async () => {
    const mk = (): Promise<import('../../geom/geom-service.ts').OpResult> => engine.makeSweep({
      featureId: 'F1', profile: squareProfile('S1', 10), path: straightPath('P1', 30), orientation: 'fixed', op: 'newBody',
    })
    const a = await mk(); const b = await mk()
    expect([...a.elementMap!.generated].sort()).toEqual([...b.elementMap!.generated].sort())
    expect(a.elementMap!.generated.every((id) => /:SWP:/.test(id))).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('#1 sweep as a cut TOOL into a box removes exactly the swept volume', async () => {
    const box = (await engine.makeBox('B1', { x: 40, y: 40, z: 40 })).body!
    // a 6x6 square swept 40 through the box along +Z from z=0.
    const req: SweepRequest = {
      featureId: 'F3', profile: { sketchId: 'S3', plane: xy, loops: squareProfile('S3', 6).loops },
      path: straightPath('P3', 40), orientation: 'fixed', op: 'cut', target: box,
    }
    const r = await engine.makeSweep(req)
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    expect(Math.abs(vol.value - (40 * 40 * 40 - 6 * 6 * 40)) / (40 * 40 * 40)).toBeLessThan(1e-6)
    await engine.disposeAll()
  }, 60_000)

  it('#5 DIAGNOSTICS: closed path refused, open profile refused, fixed-on-curved refused; body untouched', async () => {
    // closed path (a square loop handed as a PathChain)
    const closed: PathChain = {
      sketchId: 'PC', plane: xy,
      segments: [
        { kind: 'line', a: [0, 0], b: [10, 0], srcId: 'PC.p0' },
        { kind: 'line', a: [10, 0], b: [10, 10], srcId: 'PC.p1' },
        { kind: 'line', a: [10, 10], b: [0, 10], srcId: 'PC.p2' },
        { kind: 'line', a: [0, 10], b: [0, 0], srcId: 'PC.p3' },
      ],
    }
    const rc = await engine.makeSweep({ featureId: 'F4', profile: circleProfile('C4', 1), path: closed, orientation: 'frenet', op: 'newBody' })
    expect(rc.ok).toBe(false)
    expect(rc.diagnostics[0].code).toBe('SWEEP_FAILED')
    expect(String(rc.diagnostics[0].params!.reason)).toContain('closed')
    expect(String(rc.diagnostics[0].params!.reason).toLowerCase()).not.toContain('webassembly')

    // open profile (single unterminated line "loop")
    const openProf: ProfileRegion = { sketchId: 'SO', plane: xy, loops: [[{ kind: 'line', a: [0, 0], b: [10, 0], srcId: 'SO.e0' }]] }
    const ro = await engine.makeSweep({ featureId: 'F5', profile: openProf, path: straightPath('P5', 10), orientation: 'fixed', op: 'newBody' })
    expect(ro.ok).toBe(false)
    expect(ro.diagnostics[0].code).toBe('OPEN_PROFILE')
    expect(String(ro.diagnostics[0].params!.reason)).toContain('SO')

    // fixed orientation on a curved path
    const rf = await engine.makeSweep({ featureId: 'F6', profile: circleProfile('C6', 2), path: arcPath('PA6', 20), orientation: 'fixed', op: 'newBody' })
    expect(rf.ok).toBe(false)
    expect(rf.diagnostics[0].code).toBe('SWEEP_FAILED')
    expect(String(rf.diagnostics[0].params!.reason).toLowerCase()).toContain('fixed')
  }, 60_000)

  it('#8 WASM-HANDLE LIFECYCLE: a refused sweep leaks no kernel handles', async () => {
    const baseline = engine.debugKernelShapeCount()
    const openProf: ProfileRegion = { sketchId: 'SO', plane: xy, loops: [[{ kind: 'line', a: [0, 0], b: [10, 0], srcId: 'SO.e0' }]] }
    const r = await engine.makeSweep({ featureId: 'F7', profile: openProf, path: straightPath('P7', 10), orientation: 'fixed', op: 'newBody' })
    expect(r.ok).toBe(false)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    expect(engine.debugTransientCount()).toBe(0)
  }, 60_000)
})
