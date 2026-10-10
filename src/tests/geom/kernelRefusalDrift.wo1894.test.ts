/**
 * WO-1894 probe: does the kernel drift after many refused operations?
 * LienCAM-next measured a 480-byte wasm stack shift per caught native
 * exception in occt-wasm 3.6.1, after which BREP serialization failed.
 * Drives the real GeomEngine (the object the geometry worker exposes over
 * Comlink; the worker adds nothing but the message hop) through 256 refused
 * fillets, then a normal boolean, a BREP save and a restore.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { edgeId } from '../../geom/worker/stable-id.ts'

const REFUSALS = 256

describe('WO-1894 kernel refusal drift (real occt-wasm kernel)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('256 refused fillets, then boolean + BREP save + restore all still work', async () => {
    const box = await engine.makeBox('F1', { x: 40, y: 20, z: 10 })
    const edge = edgeId(['F1:BOX:xMin', 'F1:BOX:yMin'], '0')
    const volBefore = (await engine.measure(box.body!, 'volume')).value

    const codes = new Set<string>()
    let refused = 0
    for (let i = 0; i < REFUSALS; i++) {
      const r = await engine.applyFillet({ featureId: `R${i}`, body: box.body!, edges: [edge], radius: 25, propagateTangent: true })
      if (!r.ok) refused++
      codes.add(r.diagnostics[0].code)
    }
    expect(refused).toBe(REFUSALS)

    const before = await engine.serializeBody(box.body!)
    const other = await engine.makeBox('B2', { x: 10, y: 10, z: 30 })
    const fused = await engine.applyBoolean({ featureId: 'U1', op: 'fuse', target: box.body!, tools: [other.body!] })
    const volAfter = fused.ok ? (await engine.measure(fused.body!, 'volume')).value : NaN
    const bytes = await engine.serializeBody(fused.ok ? fused.body! : box.body!)
    const restored = await engine.restoreBody(bytes, fused.elementMap!).catch((e) => e)

    mkdirSync('src/tests/evidence/WO-1894', { recursive: true })
    writeFileSync('src/tests/evidence/WO-1894/probe-result.json', JSON.stringify({
      refusals: refused, codes: [...codes], volBefore, booleanOk: fused.ok, volAfter,
      brepBytesBefore: before.byteLength, brepBytesAfter: bytes.byteLength,
      restoreOk: !(restored instanceof Error),
    }, null, 2))

    expect(fused.ok).toBe(true)
    expect(volAfter).toBeGreaterThan(volBefore)
    expect(bytes.byteLength).toBeGreaterThan(0)
    expect(restored).not.toBeInstanceOf(Error)
  }, 120_000)
})
