// GEO-2 acceptance #4 — ICR-1 wiring, cross-lane proof: a GEO-emitted
// ElementMapDelta with inline `geometry` (now produced by makeBox/
// applyBoolean/importStep, see geom-engine.ts) is fed to the DOC lane's
// ElementMap (src/doc/element-map.ts, READ-ONLY import per this WO's
// ownership manifest — GEO-2 owns src/geom/** and src/tests/geom/** only) and
// resolves a real geometric-fallback bind through it. Real occt-wasm kernel
// in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { ElementMap } from '../../doc/element-map.ts'

const V = { x: 40, y: 20, z: 10 }

describe('GEO delta w/ inline geometry -> doc/element-map.ts resolution (ICR-1 wiring)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('applyDelta(delta, delta.geometry) feeds the inline ICR-1 field straight into DOC resolution', async () => {
    const box = await engine.makeBox('F1', V)
    const delta = box.elementMap!
    expect(delta.geometry).toBeDefined()
    expect(Object.keys(delta.geometry!)).toEqual(expect.arrayContaining(['F1:BOX:zMax']))

    const em = new ElementMap()
    // The exact wiring GEO-2 closes: ElementMapDelta.geometry (ICR-1) IS a
    // DeltaSnapshots-shaped map (Record<StableId, GeometrySnapshot>), so it
    // can be handed straight to applyDelta's existing companion-map
    // parameter with no adapter/transform.
    em.applyDelta(delta, delta.geometry)

    const r = em.resolve('F1:BOX:zMax')
    expect(r.status).toBe('exact')
    expect(r.via).toBe('exact')
    await engine.dispose(box.body!)
  }, 60_000)

  it('a stale reference resolves via GEOMETRIC FALLBACK using GEO-emitted inline geometry', async () => {
    const em = new ElementMap()

    // F1: the "original" box whose zMax face a document reference is bound to.
    const box1 = await engine.makeBox('F1', V)
    em.applyDelta(box1.elementMap!, box1.elementMap!.geometry)

    // The reference to F1:BOX:zMax is later orphaned (e.g. a reorder deleted
    // the feature that owned it) -- no lineage successor recorded.
    em.applyDelta({ featureId: 'DEL1', modified: {}, generated: [], deleted: ['F1:BOX:zMax'] })
    expect(em.has('F1:BOX:zMax')).toBe(false)

    // F2: an independently-built box of the SAME size at the SAME implied
    // origin -- its zMax face is geometrically indistinguishable from F1's
    // (same centroid/area/normal) but carries a DIFFERENT stable id. This is
    // exactly the "no lineage path, geometry still matches" case the spec's
    // resolution step 3 exists for (docs/stable-id-spec.md).
    const box2 = await engine.makeBox('F2', V)
    em.applyDelta(box2.elementMap!, box2.elementMap!.geometry)

    const r = em.resolve('F1:BOX:zMax')
    expect(r.status).toBe('fallback')
    expect(r.via).toBe('geometric')
    expect(r.boundTo).toEqual(['F2:BOX:zMax'])
    expect(r.diagnostics.some((d) => d.code === 'REFERENCE_FALLBACK')).toBe(true)

    await engine.disposeAll()
  }, 60_000)

  it('applyBoolean (cut) also emits inline geometry for every id named in the delta', async () => {
    const target = (await engine.makeBox('G1', V)).body!
    const tool = (await engine.makeBox('G2', { x: 10, y: 10, z: 20 })).body!
    const cut = await engine.applyBoolean({ featureId: 'G3', op: 'cut', target, tools: [tool] })
    const delta = cut.elementMap!
    expect(delta.geometry).toBeDefined()
    for (const id of delta.generated) expect(delta.geometry![id]).toBeDefined()
    for (const [parent, children] of Object.entries(delta.modified)) {
      expect(delta.geometry![parent]).toBeDefined()
      for (const c of children) expect(delta.geometry![c]).toBeDefined()
    }
    for (const id of delta.deleted) expect(delta.geometry![id]).toBeDefined()

    const em = new ElementMap()
    em.applyDelta(delta, delta.geometry)
    expect(em.liveIds().length).toBeGreaterThan(0)
    await engine.disposeAll()
  }, 60_000)
})
