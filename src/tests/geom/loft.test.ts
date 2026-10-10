// GEO-5 acceptance #2 (loft: coaxial-rect prismatoid EXACT; 3-section
// determinism; sections<2 / open-section refusals naming the sketchId), #8
// (wasm-handle lifecycle). REAL occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { ProfileRegion, LoftRequest } from '../../geom/geom-service.ts'

function plane(z: number): ProfileRegion['plane'] {
  return { origin: { x: 0, y: 0, z }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }
}

// Centered rectangle w x d at height z.
function rectSection(sketchId: string, w: number, d: number, z: number): ProfileRegion {
  const hw = w / 2, hd = d / 2
  return {
    sketchId,
    plane: plane(z),
    loops: [[
      { kind: 'line', a: [-hw, -hd], b: [hw, -hd], srcId: `${sketchId}.e0` },
      { kind: 'line', a: [hw, -hd], b: [hw, hd], srcId: `${sketchId}.e1` },
      { kind: 'line', a: [hw, hd], b: [-hw, hd], srcId: `${sketchId}.e2` },
      { kind: 'line', a: [-hw, hd], b: [-hw, -hd], srcId: `${sketchId}.e3` },
    ]],
  }
}

describe('makeLoft (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#2 two coaxial rectangles, ruled=true -> prismatoid analytic EXACT', async () => {
    const a = 20, b = 10, c = 10, d = 6, h = 12
    const req: LoftRequest = {
      featureId: 'F1',
      sections: [rectSection('S1', a, b, 0), rectSection('S2', c, d, h)],
      ruled: true, op: 'newBody',
    }
    const r = await engine.makeLoft(req)
    expect(r.ok).toBe(true)
    const A1 = a * b, A2 = c * d
    const Am = ((a + c) / 2) * ((b + d) / 2)
    const prism = (h / 6) * (A1 + 4 * Am + A2)
    const vol = await engine.measure(r.body!, 'volume')
    expect(Math.abs(vol.value - prism) / prism).toBeLessThan(1e-6)

    const dm = r.elementMap!
    // 4 ruled side bands (band 0) + 2 caps, each with inline geometry.
    expect(dm.generated).toContain('F1:LFT:S1:capStart')
    expect(dm.generated).toContain('F1:LFT:S1:capEnd')
    expect(dm.generated.filter((id) => /:LFT:S1\.e\d:s0:side/.test(id)).length).toBe(4)
    for (const id of dm.generated) expect(dm.geometry![id]).toBeDefined()
    await engine.disposeAll()
  }, 60_000)

  it('#2 a 3-section loft regenerates deterministically (byte-identical id sets)', async () => {
    const mk = (): Promise<import('../../geom/geom-service.ts').OpResult> => engine.makeLoft({
      featureId: 'F2',
      sections: [rectSection('A', 20, 20, 0), rectSection('B', 12, 12, 8), rectSection('C', 6, 6, 16)],
      ruled: true, op: 'newBody',
    })
    const x = await mk(); const y = await mk()
    expect(x.ok).toBe(true)
    expect([...x.elementMap!.generated].sort()).toEqual([...y.elementMap!.generated].sort())
    // two bands present (s0 between A,B and s1 between B,C).
    expect(x.elementMap!.generated.some((id) => id.includes(':s0:side'))).toBe(true)
    expect(x.elementMap!.generated.some((id) => id.includes(':s1:side'))).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('#2 DIAGNOSTICS: <2 sections and an open section loop are refused naming the sketchId', async () => {
    const one = await engine.makeLoft({ featureId: 'F3', sections: [rectSection('S1', 10, 10, 0)], ruled: true, op: 'newBody' })
    expect(one.ok).toBe(false)
    expect(one.diagnostics[0].code).toBe('LOFT_FAILED')
    expect(String(one.diagnostics[0].params!.reason)).toContain('2')

    const open: ProfileRegion = { sketchId: 'SO', plane: plane(4), loops: [[{ kind: 'line', a: [0, 0], b: [5, 0], srcId: 'SO.e0' }]] }
    const ro = await engine.makeLoft({ featureId: 'F4', sections: [rectSection('S1', 10, 10, 0), open], ruled: true, op: 'newBody' })
    expect(ro.ok).toBe(false)
    expect(ro.diagnostics[0].code).toBe('OPEN_PROFILE')
    expect(String(ro.diagnostics[0].params!.sketchId)).toBe('SO')
    expect(String(ro.diagnostics[0].params!.reason).toLowerCase()).not.toContain('webassembly')
  }, 60_000)

  it('#8 WASM-HANDLE LIFECYCLE: a refused loft (open section) leaks no kernel handles', async () => {
    const baseline = engine.debugKernelShapeCount()
    const open: ProfileRegion = { sketchId: 'SO', plane: plane(4), loops: [[{ kind: 'line', a: [0, 0], b: [5, 0], srcId: 'SO.e0' }]] }
    const r = await engine.makeLoft({ featureId: 'F5', sections: [rectSection('S1', 10, 10, 0), open], ruled: true, op: 'newBody' })
    expect(r.ok).toBe(false)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    expect(engine.debugTransientCount()).toBe(0)
  }, 60_000)
})
