// GEO-1 integration test — REAL occt-wasm kernel in Node (WO acceptance #5).
// Covers the init+box+cut+tessellate+dispose round trip, the cut lineage delta
// (acceptance #3), and the golden determinism gate (acceptance #4).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { collectTransferables } from '../../geom/worker/transfer.ts'
import type { BodyHandle, OpResult } from '../../geom/geom-service.ts'

const V = { x: 40, y: 20, z: 10 }

describe('GeomEngine (real occt-wasm kernel)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
  }, 60_000)

  afterAll(async () => {
    // GEO-1-R1.1: tear the kernel down deterministically at end-of-file (not just
    // disposeAll) so the wasm module is released rather than left for GC — keeps
    // heavy kernel state out of the vitest worker->main RPC window.
    await engine.disposeKernel()
  })

  it('init reports progress phases and kernel info', async () => {
    const phases: Array<[number, string]> = []
    const info = await engine.init((pct, phase) => phases.push([pct, phase]))
    expect(info.backend).toBe('occt-wasm')
    expect(info.capabilities.defeature).toBe(false) // verified broken (gotcha #2)
    expect(phases.length).toBeGreaterThanOrEqual(2)
    expect(phases[phases.length - 1]).toEqual([100, 'geom:ready'])
  }, 60_000)

  it('makeBox -> valid body with 6 generated face ids', async () => {
    const r = await engine.makeBox('F1', V)
    expect(r.ok).toBe(true)
    expect(r.body).toBeDefined()
    expect(r.elementMap?.generated.length).toBe(6)
    expect(r.elementMap?.generated).toContain('F1:BOX:zMax')
    const vol = await engine.measure(r.body!, 'volume')
    expect(vol.value).toBeCloseTo(40 * 20 * 10, 3)
    await engine.dispose(r.body!)
  }, 60_000)

  it('tessellate returns correct, self-consistent, transferable buffers', async () => {
    const box = (await engine.makeBox('FT', V)).body!
    const t = await engine.tessellate(box, { deflection: 0.1 })
    expect(t.position.length).toBeGreaterThan(0)
    expect(t.index.length % 3).toBe(0)
    // triFace is parallel to triangles and indexes into faceIds
    expect(t.triFace.length).toBe(t.index.length / 3)
    expect(Math.max(...t.triFace)).toBeLessThan(t.faceIds.length)
    expect(t.faceIds.length).toBe(6) // a box has 6 faces
    expect(t.faceIds.every((id) => id.startsWith('FT:BOX:'))).toBe(true)
    expect(t.edgePositions.length).toBeGreaterThan(0)
    // BK-18: edgeOffsets is a full CSR table with a trailing sentinel, so its
    // length is edgeIds.length + 1 and the last entry is the total edge-point
    // count (viewport3d/tessGeometry.ts validateTessBuffers requires exactly this).
    expect(t.edgeOffsets.length).toBe(t.edgeIds.length + 1)
    expect(t.edgeOffsets[t.edgeOffsets.length - 1]).toBe(t.edgePositions.length / 3)
    // buffers are fresh + detachable (zero-copy across the worker boundary)
    const list = collectTransferables(t)
    structuredClone(t, { transfer: list })
    expect(t.position.buffer.byteLength).toBe(0)
    await engine.dispose(box)
  }, 60_000)

  it('cutWithHistory emits a spec-conformant ElementMapDelta', async () => {
    const target = (await engine.makeBox('F1', V)).body!
    const tool = (await engine.makeBox('F2', { x: 10, y: 10, z: 20 })).body!
    const cut: OpResult = await engine.applyBoolean({ featureId: 'F3', op: 'cut', target, tools: [tool] })
    expect(cut.ok).toBe(true)
    const dm = cut.elementMap!
    // brand-new tool walls are named F3:CUT:new#k
    expect(dm.generated.some((id) => id.startsWith('F3:CUT:new#'))).toBe(true)
    // modified entries are keyed by the target's box ids
    expect(Object.keys(dm.modified).every((id) => id.startsWith('F1:BOX:'))).toBe(true)
    expect(Object.keys(dm.modified).length).toBeGreaterThan(0)
    // volume = 40*20*10 - overlap(10*10*10)
    const vol = await engine.measure(cut.body!, 'volume')
    expect(vol.value).toBeCloseTo(40 * 20 * 10 - 10 * 10 * 10, 2)
    // every result face is named (no UNMAPPED) and every id is well-formed
    const tess = await engine.tessellate(cut.body!, { deflection: 0.2 })
    expect(tess.faceIds.every((id) => /^(F1:BOX:|F3:CUT:)/.test(id))).toBe(true)
    await engine.disposeAll()
  }, 60_000)

  it('multi-tool cut releases every transient fused shape (no leak) on BOTH the success and failure paths', async () => {
    // R1.3: a multi-tool cut folds tools with k.fuse(), minting transient shapes
    // that are not #bodies records. They must be released in a finally on both
    // paths. debugTransientCount() must be 0 after each call, and the kernel's
    // shapeCount must return to baseline once every body is disposed.
    // --- SUCCESS path: two overlapping tools cut from the target ---
    const target = (await engine.makeBox('F1', V)).body!
    const toolA = (await engine.makeBox('F2', { x: 8, y: 8, z: 20 })).body!
    const toolB = (await engine.makeBox('F2b', { x: 12, y: 12, z: 20 })).body!
    const cut = await engine.applyBoolean({ featureId: 'F3', op: 'cut', target, tools: [toolA, toolB] })
    expect(cut.ok).toBe(true)
    expect(engine.debugTransientCount()).toBe(0) // fused tool was released
    await engine.disposeAll()

    // --- FAILURE path: a real multi-tool cut that throws mid-fold AFTER a
    // transient has already been minted. Disposing the 3rd tool makes the
    // fold's #rec() throw on iteration 2, by which point fuse(gA,gB) has minted a
    // live transient. The finally MUST release it. ---
    const t2 = (await engine.makeBox('G1', V)).body!
    const gA = (await engine.makeBox('G2', { x: 8, y: 8, z: 20 })).body!
    const gB = (await engine.makeBox('G3', { x: 8, y: 8, z: 20 })).body!
    const gC = (await engine.makeBox('G4', { x: 8, y: 8, z: 20 })).body!
    await engine.dispose(gC) // gC is now an unknown handle -> fold throws on it
    const failed = await engine.applyBoolean({ featureId: 'G5', op: 'cut', target: t2, tools: [gA, gB, gC] })
    expect(failed.ok).toBe(false)
    expect(failed.elementMap).toBeUndefined() // non-mutating failure omits elementMap (ruling 3)
    expect(engine.debugTransientCount()).toBe(0) // the fuse(gA,gB) transient was released despite the throw

    // Kernel-level proof that release() ACTUALLY ran (not just the tracker
    // cleared): the failure path creates EXACTLY one fused transient root and
    // nothing else (cutWithHistory never runs, so no result body / no face
    // enumeration). Repeating it must leave the kernel's live-shape count flat —
    // a skipped release would leak one root per iteration.
    const scBefore = engine.debugKernelShapeCount()
    for (let i = 0; i < 10; i++) {
      const f = await engine.applyBoolean({ featureId: 'G6', op: 'cut', target: t2, tools: [gA, gB, gC] })
      expect(f.ok).toBe(false)
    }
    expect(engine.debugKernelShapeCount()).toBe(scBefore) // no per-iteration leak
    expect(engine.debugTransientCount()).toBe(0)
    await engine.disposeAll()
  }, 90_000)

  it('golden determinism: box -> cut twice yields byte-identical id sets', async () => {
    async function buildIds(): Promise<string[]> {
      const target = (await engine.makeBox('F1', V)).body!
      const tool = (await engine.makeBox('F2', { x: 10, y: 10, z: 20 })).body!
      const cut = await engine.applyBoolean({ featureId: 'F3', op: 'cut', target, tools: [tool] })
      const tess = await engine.tessellate(cut.body!, { deflection: 0.2 })
      const delta = cut.elementMap!
      const ids = new Set<string>([
        ...tess.faceIds,
        ...delta.generated,
        ...delta.deleted,
        ...Object.keys(delta.modified),
        ...Object.values(delta.modified).flat(),
        ...tess.edgeIds,
      ])
      await engine.disposeAll()
      return [...ids].sort()
    }
    const run1 = await buildIds()
    const run2 = await buildIds()
    expect(run2).toEqual(run1)
    expect(run1.length).toBeGreaterThan(6)
  }, 90_000)

  it('resolve is exact for live ids and lost for unknown ones', async () => {
    const box = (await engine.makeBox('FR', V)).body!
    const [hit] = await engine.resolve(box, ['FR:BOX:zMax'])
    expect(hit.status).toBe('exact')
    expect(hit.type).toBe('face')
    expect(typeof hit.localIndex).toBe('number')
    const [miss] = await engine.resolve(box, ['NOPE:BOX:zMax'])
    expect(miss.status).toBe('lost')
    expect(await engine.classifyFace(box, 'FR:BOX:zMax')).toBe('plane')
    await engine.dispose(box)
  }, 60_000)

  it('STEP export/import and BREP serialize/restore round-trip', async () => {
    const box = (await engine.makeBox('FS', V)).body!
    const step = await engine.exportStep([box])
    expect(step.byteLength).toBeGreaterThan(0)
    const imported = await engine.importStep(step, 'IMP1')
    expect(imported.bodies.length).toBeGreaterThanOrEqual(1)
    expect(imported.bodies[0].elementMap.generated[0]).toBe('IMP1:step:face#0')

    const brep = await engine.serializeBody(box)
    const restored: BodyHandle = await engine.restoreBody(brep, {
      featureId: 'FS', modified: {}, generated: ['FS:BOX:zMax'], deleted: [],
    })
    const vol = await engine.measure(restored, 'volume')
    expect(vol.value).toBeCloseTo(40 * 20 * 10, 2)
    await engine.disposeAll()
  }, 60_000)

  it('companion snapshot map is retrievable alongside the delta', async () => {
    const box = (await engine.makeBox('FC', V)).body!
    const snaps = engine.snapshotsFor(box)
    expect(Object.keys(snaps)).toContain('FC:BOX:zMax')
    const s = snaps['FC:BOX:zMax']
    expect(s.type).toBe('plane')
    expect(s.area).toBeCloseTo(40 * 20, 2)
    await engine.dispose(box)
  }, 60_000)
})
