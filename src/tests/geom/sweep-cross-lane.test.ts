// GEO-3 acceptance #4 — element-map deltas w/ CONSTRUCTED lineage, cross-lane:
// an extrude's ElementMapDelta (inline geometry, ICR-1) is fed to the DOC lane's
// ElementMap (src/doc/element-map.ts, READ-ONLY import per the ownership
// manifest) and a downstream bind RE-RESOLVES after a profile edit — because a
// side face's stable id is derived from its generating sketch entity, not from
// geometry, so the id holds while the geometry moves. REAL occt-wasm in Node.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { ElementMap } from '../../doc/element-map.ts'
import type { ProfileRegion } from '../../geom/geom-service.ts'
import { rectLoop, xyPlane } from './fixtures/profiles.ts'

function rect(sketchId: string, w: number, h: number): ProfileRegion {
  return { sketchId, plane: xyPlane(0), loops: [rectLoop(sketchId, 0, 0, w, h)] }
}

describe('extrude delta -> doc/element-map.ts (constructed lineage survives a profile edit)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('#4 a downstream bind to a side face resolves EXACT after the profile edit moves that face', async () => {
    const em = new ElementMap()

    // Feature F1: extrude a 40x20 rectangle. A downstream reference binds to the
    // right wall (edge e1, at x=40).
    const a = await engine.makeExtrude({ featureId: 'F1', profile: rect('S1', 40, 20), end: { kind: 'blind', distance: 8 }, op: 'newBody' })
    em.applyDelta(a.elementMap!, a.elementMap!.geometry)
    const ref = 'F1:XTR:S1.e1:side'
    let r = em.resolve(ref)
    expect(r.status).toBe('exact')
    expect(em.snapshotOf(ref)!.centroid.x).toBeCloseTo(40, 4)
    await engine.dispose(a.body!)

    // Profile EDIT: same sketch entities, right wall pushed out to x=50. A
    // regeneration re-runs the feature under the SAME featureId + srcIds, so the
    // constructed id `F1:XTR:S1.e1:side` is reproduced identically even though
    // its geometry moved.
    const b = await engine.makeExtrude({ featureId: 'F1', profile: rect('S1', 50, 20), end: { kind: 'blind', distance: 8 }, op: 'newBody' })
    expect(b.elementMap!.generated).toContain(ref)
    em.applyDelta(b.elementMap!, b.elementMap!.geometry)

    // The downstream bind STILL resolves exact — the edit re-resolved through
    // the stable id — and the bound geometry now reflects the moved wall (x=50).
    r = em.resolve(ref)
    expect(r.status).toBe('exact')
    expect(r.via).toBe('exact')
    expect(em.snapshotOf(ref)!.centroid.x).toBeCloseTo(50, 4)
    await engine.dispose(b.body!)
  }, 60_000)

  it('#4 an orphaned side face falls back GEOMETRICALLY to an equivalent wall of an independent extrude', async () => {
    const em = new ElementMap()

    const f1 = await engine.makeExtrude({ featureId: 'F1', profile: rect('S1', 40, 20), end: { kind: 'blind', distance: 8 }, op: 'newBody' })
    em.applyDelta(f1.elementMap!, f1.elementMap!.geometry)

    // The reference is orphaned (its feature was deleted; no lineage successor).
    em.applyDelta({ featureId: 'DEL', modified: {}, generated: [], deleted: ['F1:XTR:S1.e1:side'] })
    expect(em.has('F1:XTR:S1.e1:side')).toBe(false)

    // An independent extrude builds a geometrically-identical right wall under a
    // DIFFERENT feature id — the resolver's geometric fallback (spec step 3),
    // fed by GEO-emitted inline snapshots, binds the orphan to it.
    const f2 = await engine.makeExtrude({ featureId: 'F2', profile: rect('S1', 40, 20), end: { kind: 'blind', distance: 8 }, op: 'newBody' })
    em.applyDelta(f2.elementMap!, f2.elementMap!.geometry)

    const r = em.resolve('F1:XTR:S1.e1:side')
    expect(r.status).toBe('fallback')
    expect(r.via).toBe('geometric')
    expect(r.boundTo).toEqual(['F2:XTR:S1.e1:side'])
    expect(r.diagnostics.some((d) => d.code === 'REFERENCE_FALLBACK')).toBe(true)
    await engine.disposeAll()
  }, 60_000)
})
