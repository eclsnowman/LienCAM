// GEO-4 acceptance #3 (shell analytic volume + watertight round trip + inner
// faces w/ constructed lineage), #5 (determinism), #6 (element-map deltas),
// #7b (diagnostics), #9 (WASM-handle lifecycle). REAL occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

const W = 40, H = 20, D = 10

describe('applyShell (real occt-wasm kernel)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('#3 box with top face removed: analytic hollow volume, inner faces w/ constructed lineage', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const thickness = 2
    const r = await engine.applyShell({ featureId: 'F2', body: box.body!, removeFaces: ['F1:BOX:zMax'], thickness })
    expect(r.ok).toBe(true)
    const dm = r.elementMap!

    const vol = await engine.measure(r.body!, 'volume')
    const outerVol = W * H * D
    const innerVol = (W - 2 * thickness) * (H - 2 * thickness) * (D - thickness)
    const analytic = outerVol - innerVol
    expect(Math.abs(vol.value - analytic) / analytic).toBeLessThan(1e-6)

    // inner offset companions for every remaining (non-removed) face.
    for (const orig of ['F1:BOX:xMin', 'F1:BOX:xMax', 'F1:BOX:yMin', 'F1:BOX:yMax', 'F1:BOX:zMin']) {
      const innerId = `F2:SHL:${orig}:inner`
      expect(dm.generated).toContain(innerId)
      expect(await engine.classifyFace(r.body!, innerId)).toBe('plane')
      expect(dm.geometry![innerId]).toBeDefined()
    }
    // the removed face retrims into a rim but KEEPS its id (1:1 retrim).
    expect(dm.modified['F1:BOX:zMax']).toEqual(['F1:BOX:zMax'])
    expect(dm.geometry!['F1:BOX:zMax']).toBeDefined()
    await engine.disposeAll()
  }, 60_000)

  it('#3 watertight: exportStep -> reimport round trip keeps face count', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const r = await engine.applyShell({ featureId: 'F2', body: box.body!, removeFaces: ['F1:BOX:zMax'], thickness: 2 })
    expect(r.ok).toBe(true)
    const originalFaceCount = Object.keys(r.elementMap!.geometry!).length
    expect(originalFaceCount).toBe(11) // 5 unchanged + 1 rim + 5 inner companions

    const bytes = await engine.exportStep([r.body!])
    const imported = await engine.importStep(bytes, 'IMP1')
    expect(imported.bodies.length).toBe(1)
    expect(imported.bodies[0].elementMap.generated.length).toBe(originalFaceCount)
    await engine.disposeAll()
  }, 60_000)

  it('#5 DETERMINISM golden: two runs produce byte-identical generated id sets', async () => {
    const mk = async () => {
      const box = await engine.makeBox('F1', { x: W, y: H, z: D })
      return engine.applyShell({ featureId: 'F2', body: box.body!, removeFaces: ['F1:BOX:zMax'], thickness: 2 })
    }
    const a = await mk()
    const b = await mk()
    expect([...a.elementMap!.generated].sort()).toEqual([...b.elementMap!.generated].sort())
    await engine.disposeAll()
  }, 60_000)

  it('DIAGNOSTICS: kernel shell abort -> SHELL_FAILED naming the face + thickness, no invented cause or raw kernel text, body unchanged', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const volBefore = (await engine.measure(box.body!, 'volume')).value

    // thickness=10 reliably aborts inside the kernel. The facade does not
    // expose OCCT's native failure status, so the diagnostic must describe the
    // observed construction boundary without guessing why it stopped.
    const r = await engine.applyShell({ featureId: 'F2', body: box.body!, removeFaces: ['F1:BOX:zMax'], thickness: 10 })
    expect(r.ok).toBe(false)
    const diag = r.diagnostics[0]
    expect(diag.code).toBe('SHELL_FAILED')
    const message = String(diag.params!.reason)
    expect(message).toContain('F1:BOX:zMax')
    expect(message).toContain('10')
    expect(message).toContain('stopped while constructing inward offsets')
    expect(message).not.toContain('exceeds the local wall geometry')
    expect(message.toLowerCase()).not.toContain('webassembly')

    const volAfter = (await engine.measure(box.body!, 'volume')).value
    expect(volAfter).toBe(volBefore)
    await engine.disposeAll()
  }, 60_000)

  it('DIAGNOSTICS: a thickness that produces a near-zero (garbage) hollow is ALSO SHELL_FAILED, not a silently-wrong success', async () => {
    // Verified empirically: thickness=12 on this box does NOT throw and
    // passes isValid(), yet removes essentially zero material (occt-wasm
    // silently returns a degenerate result past the true feasibility
    // boundary) -- the volume-delta backstop must catch this class too.
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const r = await engine.applyShell({ featureId: 'F2', body: box.body!, removeFaces: ['F1:BOX:zMax'], thickness: 12 })
    expect(r.ok).toBe(false)
    expect(r.diagnostics[0].code).toBe('SHELL_FAILED')
    await engine.disposeAll()
  }, 60_000)

  it('#9 WASM-HANDLE LIFECYCLE: the infeasible-thickness error path leaks no kernel handles', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const baseline = engine.debugKernelShapeCount()
    const r = await engine.applyShell({ featureId: 'F2', body: box.body!, removeFaces: ['F1:BOX:zMax'], thickness: 10 })
    expect(r.ok).toBe(false)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    expect(engine.debugTransientCount()).toBe(0)
    await engine.disposeAll()
  }, 60_000)
})
