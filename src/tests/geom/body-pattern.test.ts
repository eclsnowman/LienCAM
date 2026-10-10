// GEO-5 acceptance #4 (body pattern: linear N x seed ONE body; circular full
// circle; mirror; instance ids <fid>:PAT:i<n>:<childId>, determinism golden +
// FAILS-IF enumeration order; overlapping fuse valid single body vol < N x
// seed), #7 (element-map cross-lane resolve after a pattern modifies the seed),
// #8 (wasm-handle lifecycle). REAL occt-wasm kernel in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { ElementMap } from '../../doc/element-map.ts'
import type { PatternRequest } from '../../geom/geom-service.ts'

const SEED = { x: 10, y: 10, z: 10 } // vol 1000

describe('applyBodyPattern (real occt-wasm kernel)', () => {
  let engine: GeomEngine
  beforeAll(async () => { engine = new GeomEngine(); await engine.init() }, 60_000)
  afterAll(async () => { await engine.disposeKernel() })

  it('#4a linear count N non-overlapping -> volume N x seed, ONE body, PAT instance ids', async () => {
    const box = (await engine.makeBox('F1', SEED)).body!
    const req: PatternRequest = { featureId: 'PF', body: box, spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, count: 3, spacing: 20 } }
    const r = await engine.applyBodyPattern(req)
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    expect(Math.abs(vol.value - 3 * 1000) / 3000).toBeLessThan(1e-6)
    const dm = r.elementMap!
    // seed (i0) faces survive with their original ids; instances 1,2 are PAT ids.
    expect(dm.modified['F1:BOX:zMax']).toEqual(['F1:BOX:zMax'])
    for (const n of [1, 2]) {
      for (const tag of ['xMin', 'xMax', 'zMax']) {
        expect(dm.generated).toContain(`PF:PAT:i${n}:F1:BOX:${tag}`)
      }
    }
    for (const id of dm.generated) expect(dm.geometry![id]).toBeDefined()
    await engine.disposeAll()
  }, 60_000)

  it('#4a FAILS-IF: instance ids are derived from the parameter grid, not enumeration order', async () => {
    const box = (await engine.makeBox('F1', SEED)).body!
    const r = await engine.applyBodyPattern({ featureId: 'PF', body: box, spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, count: 3, spacing: 20 } })
    const g = r.elementMap!.geometry!
    // seed xMin centroid.x = 0; instance i1 -> +20; i2 -> +40. A face named by
    // kernel enumeration order would not land its id on the correct copy.
    expect(g['F1:BOX:xMin'].centroid.x).toBeCloseTo(0, 4)
    expect(g['PF:PAT:i1:F1:BOX:xMin'].centroid.x).toBeCloseTo(20, 4)
    expect(g['PF:PAT:i2:F1:BOX:xMin'].centroid.x).toBeCloseTo(40, 4)
    await engine.disposeAll()
  }, 60_000)

  it('#4a DETERMINISM golden: two identical runs produce byte-identical id sets', async () => {
    const mk = async (): Promise<string[]> => {
      const box = (await engine.makeBox('F1', SEED)).body!
      const r = await engine.applyBodyPattern({ featureId: 'PF', body: box, spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, count: 3, spacing: 20 } })
      return [...r.elementMap!.generated].sort()
    }
    const a = await mk(); const b = await mk()
    expect(a).toEqual(b)
    expect(a.every((id) => /^PF:PAT:i\d+:F1:BOX:/.test(id))).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('#4b circular pattern covering a full circle -> N x seed, ONE body', async () => {
    const box = (await engine.makeBox('F1', SEED)).body!
    // axis parallel to Z, offset well away from the box so instances do not overlap.
    const r = await engine.applyBodyPattern({
      featureId: 'PC', body: box,
      spec: { kind: 'circular', axis: { origin: { x: -20, y: 5, z: 0 }, dir: { x: 0, y: 0, z: 1 } }, count: 4, stepDeg: 90 },
    })
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    expect(Math.abs(vol.value - 4 * 1000) / 4000).toBeLessThan(1e-6)
    for (const n of [1, 2, 3]) expect(r.elementMap!.generated.some((id) => id.startsWith(`PC:PAT:i${n}:`))).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('#4c mirror about a PlaneDef -> two copies, one body', async () => {
    const box = (await engine.makeBox('F1', SEED)).body!
    const r = await engine.applyBodyPattern({
      featureId: 'PM', body: box,
      spec: { kind: 'mirror', plane: { origin: { x: 20, y: 0, z: 0 }, normal: { x: 1, y: 0, z: 0 }, xDir: { x: 0, y: 1, z: 0 } } },
    })
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    expect(Math.abs(vol.value - 2000) / 2000).toBeLessThan(1e-6)
    // mirrored copy sits at x 30..40 (reflection of 0..10 about x=20).
    expect(r.elementMap!.geometry!['PM:PAT:i1:F1:BOX:xMin'].centroid.x).toBeCloseTo(40, 4)
    await engine.disposeAll()
  }, 60_000)

  it('#4c overlapping instances still fuse to a valid single body with volume < N x seed', async () => {
    const box = (await engine.makeBox('F1', SEED)).body!
    // spacing 5 < box width 10 -> instances overlap.
    const r = await engine.applyBodyPattern({ featureId: 'PO', body: box, spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, count: 2, spacing: 5 } })
    expect(r.ok).toBe(true)
    const vol = await engine.measure(r.body!, 'volume')
    expect(vol.value).toBeGreaterThan(1000)
    expect(vol.value).toBeLessThan(2000) // measured, not assumed
    await engine.disposeAll()
  }, 60_000)

  it('#4c GEO-5-R1.3: overlapping pattern names EVERY surviving face (merged-source ids), deterministically, downstream-resolvable', async () => {
    // Pre-R1 this fuse minted a body whose y/z outer walls (merged from both
    // overlapping instances) had NO stable id -- only F1:BOX:xMin and
    // PO:PAT:i1:F1:BOX:xMax were named. stable-id-spec's no-silent-gaps rule now
    // requires a deterministic id on every surviving face or a loud failure.
    const runOnce = async (): Promise<{ named: string[]; mergedId: string }> => {
      const box = (await engine.makeBox('F1', SEED)).body!
      const r = await engine.applyBodyPattern({ featureId: 'PO', body: box, spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, count: 2, spacing: 5 } })
      expect(r.ok).toBe(true) // ok:true GUARANTEES 100% named coverage (else loud PATTERN_FAILED)
      const dm = r.elementMap!
      // every named id (survived seed + generated) has an inline snapshot.
      const named = [...Object.keys(dm.modified), ...dm.generated].sort()
      for (const id of named) expect(dm.geometry![id]).toBeDefined()
      // the two axial survivors keep clean 1:1 ids (the pre-R1 pair).
      expect(dm.modified['F1:BOX:xMin']).toEqual(['F1:BOX:xMin'])
      expect(dm.generated).toContain('PO:PAT:i1:F1:BOX:xMax')
      // the four coplanar-merged outer walls now carry deterministic
      // merged-source ids naming BOTH contributing instances (sorted, so
      // byte-identical across runs).
      const mergedIds = [
        'PO:PAT:merge:(i0:F1:BOX:yMin|i1:F1:BOX:yMin)',
        'PO:PAT:merge:(i0:F1:BOX:yMax|i1:F1:BOX:yMax)',
        'PO:PAT:merge:(i0:F1:BOX:zMin|i1:F1:BOX:zMin)',
        'PO:PAT:merge:(i0:F1:BOX:zMax|i1:F1:BOX:zMax)',
      ]
      for (const id of mergedIds) expect(dm.generated).toContain(id)
      await engine.dispose(r.body!)
      return { named, mergedId: mergedIds[0] }
    }
    const a = await runOnce()
    const b = await runOnce()
    // determinism: byte-identical named-id set across two independent runs.
    expect(a.named).toEqual(b.named)

    // downstream ElementMap resolves a MERGED face id -> exact.
    const box = await engine.makeBox('F1', SEED)
    const em = new ElementMap()
    em.applyDelta(box.elementMap!, box.elementMap!.geometry)
    const pat = await engine.applyBodyPattern({ featureId: 'PO', body: box.body!, spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, count: 2, spacing: 5 } })
    em.applyDelta(pat.elementMap!, pat.elementMap!.geometry)
    expect(em.resolve(a.mergedId).status).toBe('exact')
    await engine.disposeAll()
  }, 60_000)

  it('#4 DIAGNOSTICS: count < 2 and zero spacing are refused with PATTERN_FAILED', async () => {
    const box = (await engine.makeBox('F1', SEED)).body!
    const c1 = await engine.applyBodyPattern({ featureId: 'P1', body: box, spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, count: 1, spacing: 20 } })
    expect(c1.ok).toBe(false)
    expect(c1.diagnostics[0].code).toBe('PATTERN_FAILED')
    const c2 = await engine.applyBodyPattern({ featureId: 'P2', body: box, spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, count: 3, spacing: 0 } })
    expect(c2.ok).toBe(false)
    expect(c2.diagnostics[0].code).toBe('PATTERN_FAILED')
    expect(String(c2.diagnostics[0].params!.reason).toLowerCase()).toContain('spacing')
    await engine.disposeAll()
  }, 60_000)

  it('#7 cross-lane: a downstream bind resolves through doc/element-map.ts after a pattern modifies the seed', async () => {
    const box = await engine.makeBox('F1', SEED)
    const em = new ElementMap()
    em.applyDelta(box.elementMap!, box.elementMap!.geometry)
    const pat = await engine.applyBodyPattern({ featureId: 'PF', body: box.body!, spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, count: 3, spacing: 20 } })
    em.applyDelta(pat.elementMap!, pat.elementMap!.geometry)
    const r = em.resolve('F1:BOX:zMax')
    expect(r.status).toBe('exact')
    await engine.disposeAll()
  }, 60_000)

  it('#8 WASM-HANDLE LIFECYCLE: a successful pattern + dispose returns to baseline; refusal leaks nothing', async () => {
    const box = (await engine.makeBox('F1', SEED)).body!
    const baseline = engine.debugKernelShapeCount()
    const bad = await engine.applyBodyPattern({ featureId: 'PB', body: box, spec: { kind: 'linear', dir: { x: 0, y: 0, z: 0 }, count: 3, spacing: 5 } })
    expect(bad.ok).toBe(false)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    const ok = await engine.applyBodyPattern({ featureId: 'PG', body: box, spec: { kind: 'linear', dir: { x: 1, y: 0, z: 0 }, count: 3, spacing: 20 } })
    expect(ok.ok).toBe(true)
    await engine.dispose(ok.body!)
    expect(engine.debugKernelShapeCount()).toBe(baseline)
    expect(engine.debugTransientCount()).toBe(0)
    await engine.disposeAll()
  }, 60_000)
})
