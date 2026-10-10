// GEO-5 acceptance #3 (hole: simple/counterbore/countersink volume deltas match
// the analytic for blind + throughAll; wall/floor ids derived from featureId +
// point index, stable across reruns; point-off-face refusal naming face id +
// point index with the body unchanged), #8 (wasm-handle lifecycle). REAL
// occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import type { HoleRequest, Vec3 } from '../../geom/geom-service.ts'

const BOX = { x: 40, y: 20, z: 10 }
const TOP = 'F1:BOX:zMax'
// three points on the top face (z=10).
const P3: Vec3[] = [{ x: 10, y: 10, z: 10 }, { x: 20, y: 10, z: 10 }, { x: 30, y: 10, z: 10 }]

async function freshBox(engine: GeomEngine): Promise<number> {
  return (await engine.makeBox('F1', BOX)).body! as unknown as number
}

describe('makeHole (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#3 simple blind hole x3: volume delta = 3 cylinders; wall+floor ids per point index', async () => {
    const box = await freshBox(engine)
    const v0 = (await engine.measure(box as never, 'volume')).value
    const d = 6, depth = 5
    const req: HoleRequest = { featureId: 'H1', body: box as never, face: TOP, points: P3, style: { kind: 'simple', diameter: d }, depth: { kind: 'blind', distance: depth } }
    const r = await engine.makeHole(req)
    expect(r.ok).toBe(true)
    const v1 = (await engine.measure(r.body!, 'volume')).value
    const removed = 3 * Math.PI * (d / 2) ** 2 * depth
    expect(Math.abs((v0 - v1) - removed) / removed).toBeLessThan(1e-6)
    const dm = r.elementMap!
    for (let i = 0; i < 3; i++) {
      expect(dm.generated).toContain(`H1:HOL:i${i}:wall`)
      expect(dm.generated).toContain(`H1:HOL:i${i}:floor`)
    }
    for (const id of dm.generated) expect(dm.geometry![id]).toBeDefined()
    // top face survived with its id (hole punched, retrim keeps id).
    expect(dm.modified[TOP]).toEqual([TOP])
    await engine.disposeAll()
  }, 60_000)

  it('#3 simple hole ids are stable across reruns (derived from point index, not enumeration)', async () => {
    const mk = async (): Promise<string[]> => {
      const box = await freshBox(engine)
      const r = await engine.makeHole({ featureId: 'H1', body: box as never, face: TOP, points: P3, style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 5 } })
      return [...r.elementMap!.generated].sort()
    }
    expect(await mk()).toEqual(await mk())
    await engine.disposeAll()
  }, 60_000)

  it('#3 counterbore blind: volume delta = cb cylinder + main cylinder below', async () => {
    const box = await freshBox(engine)
    const v0 = (await engine.measure(box as never, 'volume')).value
    const d = 6, cbD = 9, cbDepth = 2, depth = 5
    const r = await engine.makeHole({ featureId: 'H2', body: box as never, face: TOP, points: P3, style: { kind: 'counterbore', diameter: d, cbDiameter: cbD, cbDepth }, depth: { kind: 'blind', distance: depth } })
    expect(r.ok).toBe(true)
    const v1 = (await engine.measure(r.body!, 'volume')).value
    const perHole = Math.PI * (cbD / 2) ** 2 * cbDepth + Math.PI * (d / 2) ** 2 * (depth - cbDepth)
    const removed = 3 * perHole
    expect(Math.abs((v0 - v1) - removed) / removed).toBeLessThan(1e-6)
    await engine.disposeAll()
  }, 60_000)

  it('#3 countersink blind: volume delta = cone frustum + cylinder below', async () => {
    const box = await freshBox(engine)
    const v0 = (await engine.measure(box as never, 'volume')).value
    const d = 6, csD = 9, csAngleDeg = 90, depth = 5
    const r = await engine.makeHole({ featureId: 'H3', body: box as never, face: TOP, points: P3, style: { kind: 'countersink', diameter: d, csDiameter: csD, csAngleDeg }, depth: { kind: 'blind', distance: depth } })
    expect(r.ok).toBe(true)
    const v1 = (await engine.measure(r.body!, 'volume')).value
    const R = csD / 2, rr = d / 2
    const coneH = (R - rr) / Math.tan((csAngleDeg / 2) * Math.PI / 180)
    const frustum = (Math.PI * coneH / 3) * (R * R + R * rr + rr * rr)
    const perHole = frustum + Math.PI * rr * rr * (depth - coneH)
    const removed = 3 * perHole
    expect(Math.abs((v0 - v1) - removed) / removed).toBeLessThan(1e-6)
    await engine.disposeAll()
  }, 60_000)

  it('#3 simple throughAll: volume delta = 3 cylinders through the full thickness', async () => {
    const box = await freshBox(engine)
    const v0 = (await engine.measure(box as never, 'volume')).value
    const d = 6
    const r = await engine.makeHole({ featureId: 'H4', body: box as never, face: TOP, points: P3, style: { kind: 'simple', diameter: d }, depth: { kind: 'throughAll' } })
    expect(r.ok).toBe(true)
    const v1 = (await engine.measure(r.body!, 'volume')).value
    const removed = 3 * Math.PI * (d / 2) ** 2 * BOX.z
    expect(Math.abs((v0 - v1) - removed) / removed).toBeLessThan(1e-6)
    await engine.disposeAll()
  }, 60_000)

  it('#3 DIAGNOSTICS: a point NOT on the face -> HOLE_FAILED naming face id + point index; body unchanged', async () => {
    const box = await freshBox(engine)
    const v0 = (await engine.measure(box as never, 'volume')).value
    const pts: Vec3[] = [{ x: 10, y: 10, z: 10 }, { x: 10, y: 10, z: 5 }, { x: 30, y: 10, z: 10 }]
    const r = await engine.makeHole({ featureId: 'H5', body: box as never, face: TOP, points: pts, style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 5 } })
    expect(r.ok).toBe(false)
    const diag = r.diagnostics[0]
    expect(diag.code).toBe('HOLE_FAILED')
    const msg = String(diag.params!.reason)
    expect(msg).toContain(TOP)
    expect(msg).toContain('index 1')
    expect(msg.toLowerCase()).not.toContain('webassembly')
    expect(msg.toLowerCase()).not.toContain('[object')
    // body unchanged.
    const v1 = (await engine.measure(box as never, 'volume')).value
    expect(v1).toBe(v0)
    await engine.disposeAll()
  }, 60_000)

  it('#3 GEO-5-R1.1: a coplanar point OUTSIDE the trimmed face -> HOLE_FAILED (face id + point index); body unchanged', async () => {
    const box = await freshBox(engine)
    const v0 = (await engine.measure(box as never, 'volume')).value
    // index 1 is on the top plane (z=10) but x=100 is well OUTSIDE the 40x20
    // trimmed face -- projectPointOnFace alone (distance ~ 0) would silently
    // accept it and cut nothing (the pre-R1 silent-no-op defect).
    const pts: Vec3[] = [{ x: 10, y: 10, z: 10 }, { x: 100, y: 10, z: 10 }, { x: 30, y: 10, z: 10 }]
    const r = await engine.makeHole({ featureId: 'H7', body: box as never, face: TOP, points: pts, style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 5 } })
    expect(r.ok).toBe(false)
    const diag = r.diagnostics[0]
    expect(diag.code).toBe('HOLE_FAILED')
    const msg = String(diag.params!.reason)
    expect(msg).toContain(TOP)
    expect(msg).toContain('index 1')
    expect(msg.toLowerCase()).not.toContain('webassembly')
    expect(msg.toLowerCase()).not.toContain('[object')
    // body byte-unchanged (no elementMap emitted on a non-mutating failure).
    expect(r.elementMap).toBeUndefined()
    const v1 = (await engine.measure(box as never, 'volume')).value
    expect(v1).toBe(v0)
    await engine.disposeAll()
  }, 60_000)

  it('#8 GEO-5-R1.2 WASM-HANDLE LIFECYCLE (SUCCESS path): all three hole styles return to baseline after dispose', async () => {
    // The committed #8 test only drives the ERROR path; the countersink cone
    // tool leaked two circle-edge handles per point on the SUCCESS path (never
    // released because only the wires were tracked). Drive each style's success
    // path and prove the kernel returns to baseline after disposing the body.
    const box = await freshBox(engine)
    const baseline = engine.debugKernelShapeCount()
    const styles: HoleRequest['style'][] = [
      { kind: 'simple', diameter: 6 },
      { kind: 'counterbore', diameter: 6, cbDiameter: 9, cbDepth: 2 },
      { kind: 'countersink', diameter: 6, csDiameter: 9, csAngleDeg: 90 },
    ]
    for (const style of styles) {
      const r = await engine.makeHole({ featureId: 'HL', body: box as never, face: TOP, points: P3, style, depth: { kind: 'blind', distance: 5 } })
      expect(r.ok).toBe(true)
      await engine.dispose(r.body!)
      expect(engine.debugKernelShapeCount()).toBe(baseline)
      expect(engine.debugTransientCount()).toBe(0)
    }
    await engine.disposeAll()
  }, 60_000)

  it('#8 WASM-HANDLE LIFECYCLE: the point-off-face error path leaks no kernel handles', async () => {
    const box = await freshBox(engine)
    const baseline = engine.debugKernelShapeCount()
    const pts: Vec3[] = [{ x: 10, y: 10, z: 5 }]
    const r = await engine.makeHole({ featureId: 'H6', body: box as never, face: TOP, points: pts, style: { kind: 'simple', diameter: 6 }, depth: { kind: 'blind', distance: 5 } })
    expect(r.ok).toBe(false)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    expect(engine.debugTransientCount()).toBe(0)
    await engine.disposeAll()
  }, 60_000)
})
