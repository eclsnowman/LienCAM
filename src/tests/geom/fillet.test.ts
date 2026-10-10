// GEO-4 acceptance #1 (fillet analytic volume + tangent-chain propagation),
// #5 (constructed lineage + determinism), #6 (element-map deltas + cross-lane
// resolve), #7a (diagnostics), #9 (WASM-handle lifecycle). REAL occt-wasm
// kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { edgeId } from '../../geom/worker/stable-id.ts'
import { ElementMap } from '../../doc/element-map.ts'
import type { ProfileRegion } from '../../geom/geom-service.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'

const W = 40, H = 20, D = 10

describe('applyFillet (real occt-wasm kernel)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('#1 single full-length box edge: analytic quarter-cylinder-complement volume, band face is a cylinder', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    expect(box.ok).toBe(true)
    const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
    const radius = 3
    const r = await engine.applyFillet({ featureId: 'F2', body: box.body!, edges: [edge], radius, propagateTangent: true })
    expect(r.ok).toBe(true)
    const dm = r.elementMap!

    const vol = await engine.measure(r.body!, 'volume')
    const removed = W * H * D - vol.value
    const analyticRemoved = (radius * radius - (Math.PI * radius * radius) / 4) * D
    expect(Math.abs(removed - analyticRemoved) / analyticRemoved).toBeLessThan(0.01)

    const bandId = `F2:FIL:${edge}`
    expect(dm.generated).toContain(bandId)
    expect(await engine.classifyFace(r.body!, bandId)).toBe('cylinder')

    // every named id carries inline geometry (ICR-1 / criterion #6).
    for (const id of [...dm.generated, ...Object.keys(dm.modified)]) expect(dm.geometry![id]).toBeDefined()
    await engine.disposeAll()
  }, 60_000)

  it('#1 TANGENT-CHAIN propagation: one pick fillets the whole chain', async () => {
    // Two boxes (20x20x10 each) fused end-to-end into a 40x20x10 solid via
    // makeExtrude's op:'add' (a genuine boolean fuse, not a sketch-segment
    // ambiguity): the target's own y=0 wall (B1:BOX:yMin) and the tool's y=0
    // wall (F2:XTR:S2.e0:side) are COPLANAR and TANGENT across their shared
    // seam, so their two TOP edges are themselves tangent-continuous.
    // Filleting ONLY the target's top edge auto-propagates into the tool's
    // top edge too (verified empirically: occt-wasm's underlying
    // BRepFilletAPI_MakeFillet default Add() behavior) -- proven here by the
    // removed volume matching the FULL 40-length analytic, not half of it.
    const box1 = await engine.makeBox('B1', { x: 20, y: 20, z: 10 })
    const tool: ProfileRegion = { sketchId: 'S2', plane: xyPlane(0), loops: [rectLoop('S2', 20, 0, 40, 20)] }
    const fused = await engine.makeExtrude({ featureId: 'F2', profile: tool, end: { kind: 'blind', distance: 10 }, op: 'add', target: box1.body! })
    expect(fused.ok).toBe(true)
    const volBefore = (await engine.measure(fused.body!, 'volume')).value

    const edgeA = edgeId(['B1:BOX:yMin', 'B1:BOX:zMax'], '0')
    const radius = 2
    const r = await engine.applyFillet({ featureId: 'F3', body: fused.body!, edges: [edgeA], radius, propagateTangent: true })
    expect(r.ok).toBe(true)

    const edgeB = edgeId(['F2:XTR:S2.e0:side', 'F2:XTR:S2:capEnd'], '0')
    const bandA = `F3:FIL:${edgeA}`
    const bandB = `F3:FIL:${edgeB}`
    expect(r.elementMap!.generated).toContain(bandA)
    expect(r.elementMap!.generated).toContain(bandB)
    expect(await engine.classifyFace(r.body!, bandA)).toBe('cylinder')
    expect(await engine.classifyFace(r.body!, bandB)).toBe('cylinder')

    const volAfter = (await engine.measure(r.body!, 'volume')).value
    const fullLengthAnalytic = (radius * radius - (Math.PI * radius * radius) / 4) * 40
    expect(Math.abs((volBefore - volAfter) - fullLengthAnalytic) / fullLengthAnalytic).toBeLessThan(1e-6)
    await engine.disposeAll()
  }, 60_000)

  it('#5 DETERMINISM golden: two runs produce byte-identical generated id sets', async () => {
    const mk = async () => {
      const box = await engine.makeBox('F1', { x: W, y: H, z: D })
      const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
      return engine.applyFillet({ featureId: 'F2', body: box.body!, edges: [edge], radius: 3, propagateTangent: true })
    }
    const a = await mk()
    const b = await mk()
    expect([...a.elementMap!.generated].sort()).toEqual([...b.elementMap!.generated].sort())
    await engine.disposeAll()
  }, 60_000)

  it('#6 cross-lane: a downstream bind to a retrimmed wall resolves EXACT after a fillet touches an adjacent edge', async () => {
    const em = new ElementMap()
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    em.applyDelta(box.elementMap!, box.elementMap!.geometry)
    expect(em.resolve('F1:BOX:xMin').status).toBe('exact')

    const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
    const r = await engine.applyFillet({ featureId: 'F2', body: box.body!, edges: [edge], radius: 3, propagateTangent: true })
    expect(r.ok).toBe(true)
    em.applyDelta(r.elementMap!, r.elementMap!.geometry)

    // xMin is retrimmed (band cuts its corner) but KEEPS its id (1:1 retrim
    // convention) -- the downstream bind survives the fillet untouched.
    const res = em.resolve('F1:BOX:xMin')
    expect(res.status).toBe('exact')
    await engine.disposeAll()
  }, 60_000)

  it('#7a DIAGNOSTICS: infeasible fillet radius -> FILLET_RADIUS_TOO_LARGE naming the edge + radius, no raw kernel text, body unchanged', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
    const volBefore = (await engine.measure(box.body!, 'volume')).value

    const r = await engine.applyFillet({ featureId: 'F2', body: box.body!, edges: [edge], radius: 25, propagateTangent: true })
    expect(r.ok).toBe(false)
    expect(r.body).toBeUndefined()
    const diag = r.diagnostics[0]
    expect(diag.code).toBe('FILLET_RADIUS_TOO_LARGE')
    const message = String(diag.params!.reason)
    expect(message).toContain(edge)
    expect(message).toContain('25')
    expect(message.toLowerCase()).not.toContain('webassembly')
    expect(message.toLowerCase()).not.toContain('[object')

    // failed body is unchanged.
    const volAfter = (await engine.measure(box.body!, 'volume')).value
    expect(volAfter).toBe(volBefore)
    await engine.disposeAll()
  }, 60_000)

  it('#R1.3 propagateTangent:false is refused (structured, names the edge, no raw kernel text, body unchanged)', async () => {
    // occt-wasm 3.6.1 cannot suppress BRepFilletAPI's tangent-chain
    // propagation (proven empirically -- GEO-4 report). Rather than silently
    // rounding MORE than the caller asked for, propagateTangent:false is
    // refused loud. The true path is covered by every other test above.
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
    const volBefore = (await engine.measure(box.body!, 'volume')).value

    const r = await engine.applyFillet({ featureId: 'F2', body: box.body!, edges: [edge], radius: 3, propagateTangent: false })
    expect(r.ok).toBe(false)
    expect(r.body).toBeUndefined()
    const diag = r.diagnostics[0]
    // frozen v0.4 DiagCode has no dedicated FILLET_FAILED; FILLET_RADIUS_TOO_LARGE
    // is the contract's sole fillet-failure code (see geom-engine R1.3 note).
    expect(diag.code).toBe('FILLET_RADIUS_TOO_LARGE')
    const message = String(diag.params!.reason)
    expect(message).toContain(edge)
    expect(message.toLowerCase()).toContain('propagat')
    expect(message.toLowerCase()).not.toContain('webassembly')
    expect(message.toLowerCase()).not.toContain('[object')

    const volAfter = (await engine.measure(box.body!, 'volume')).value
    expect(volAfter).toBe(volBefore)
    await engine.disposeAll()
  }, 60_000)

  it('#9 WASM-HANDLE LIFECYCLE: the infeasible-radius error path leaks no kernel handles', async () => {
    const box = await engine.makeBox('F1', { x: W, y: H, z: D })
    const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
    const baseline = engine.debugKernelShapeCount()
    const r = await engine.applyFillet({ featureId: 'F2', body: box.body!, edges: [edge], radius: 25, propagateTangent: true })
    expect(r.ok).toBe(false)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    expect(engine.debugTransientCount()).toBe(0)
    await engine.disposeAll()
  }, 60_000)
})
