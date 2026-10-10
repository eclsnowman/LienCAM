// GEO-4 acceptance #2 (chamfer exact prism volume), #5 (constructed lineage +
// determinism), #6 (element-map deltas), #7b implied (same diagnostic
// quality bar), #9 (WASM-handle lifecycle). REAL occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { edgeId } from '../../geom/worker/stable-id.ts'

const W = 40, H = 20, D = 10

describe('applyChamfer (real occt-wasm kernel)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('#2 single full-length box edge: exact prism volume (d*d/2*L), band face is a plane', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
    const distance = 3
    const r = await engine.applyChamfer({ featureId: 'F2', body: box.body!, edges: [edge], distance, propagateTangent: true })
    expect(r.ok).toBe(true)
    const dm = r.elementMap!

    const vol = await engine.measure(r.body!, 'volume')
    const removed = W * H * D - vol.value
    const analyticRemoved = ((distance * distance) / 2) * D
    expect(Math.abs(removed - analyticRemoved) / analyticRemoved).toBeLessThan(1e-6)

    const bandId = `F2:CHM:${edge}`
    expect(dm.generated).toContain(bandId)
    expect(await engine.classifyFace(r.body!, bandId)).toBe('plane')
    for (const id of [...dm.generated, ...Object.keys(dm.modified)]) expect(dm.geometry![id]).toBeDefined()
    await engine.disposeAll()
  }, 60_000)

  it('#5 DETERMINISM golden: two runs produce byte-identical generated id sets', async () => {
    const mk = async () => {
      const box = await engine.makeBox('F1', { x: W, y: H, z: D })
      const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
      return engine.applyChamfer({ featureId: 'F2', body: box.body!, edges: [edge], distance: 3, propagateTangent: true })
    }
    const a = await mk()
    const b = await mk()
    expect([...a.elementMap!.generated].sort()).toEqual([...b.elementMap!.generated].sort())
    await engine.disposeAll()
  }, 60_000)

  it('DIAGNOSTICS: infeasible chamfer distance -> CHAMFER_FAILED naming the edge + distance, no raw kernel text, body unchanged', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
    const volBefore = (await engine.measure(box.body!, 'volume')).value

    const r = await engine.applyChamfer({ featureId: 'F2', body: box.body!, edges: [edge], distance: 25, propagateTangent: true })
    expect(r.ok).toBe(false)
    const diag = r.diagnostics[0]
    expect(diag.code).toBe('CHAMFER_FAILED')
    const message = String(diag.params!.reason)
    expect(message).toContain(edge)
    expect(message).toContain('25')
    expect(message.toLowerCase()).not.toContain('webassembly')

    const volAfter = (await engine.measure(box.body!, 'volume')).value
    expect(volAfter).toBe(volBefore)
    await engine.disposeAll()
  }, 60_000)

  it('#R1.3 propagateTangent:false is refused (structured, names the edge, no raw kernel text, body unchanged)', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
    const volBefore = (await engine.measure(box.body!, 'volume')).value

    const r = await engine.applyChamfer({ featureId: 'F2', body: box.body!, edges: [edge], distance: 3, propagateTangent: false })
    expect(r.ok).toBe(false)
    expect(r.body).toBeUndefined()
    const diag = r.diagnostics[0]
    expect(diag.code).toBe('CHAMFER_FAILED')
    const message = String(diag.params!.reason)
    expect(message).toContain(edge)
    expect(message.toLowerCase()).toContain('propagat')
    expect(message.toLowerCase()).not.toContain('webassembly')
    expect(message.toLowerCase()).not.toContain('[object')

    const volAfter = (await engine.measure(box.body!, 'volume')).value
    expect(volAfter).toBe(volBefore)
    await engine.disposeAll()
  }, 60_000)

  it('#9 WASM-HANDLE LIFECYCLE: the infeasible-distance error path leaks no kernel handles', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
    const baseline = engine.debugKernelShapeCount()
    const r = await engine.applyChamfer({ featureId: 'F2', body: box.body!, edges: [edge], distance: 25, propagateTangent: true })
    expect(r.ok).toBe(false)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    expect(engine.debugTransientCount()).toBe(0)
    await engine.disposeAll()
  }, 60_000)
})
