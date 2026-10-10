// GEO-2 BK-10a — restoreBody() geometric-snapshot rebind. Real occt-wasm
// kernel in Node.
//
// FAILS-IF fixture: a plain box F1:BOX:{xMin,xMax,yMin,yMax,zMin,zMax}. Its
// centroid order and its lexical-id order are FULLY REVERSED:
//   centroid order (x,y,z ascending):  xMin, yMin, zMin, zMax, yMax, xMax
//   lexical id order ("xMax"<"xMin" since 'a'<'i', similarly y*/z*):
//                                       xMax, xMin, yMax, yMin, zMax, zMin
// The OLD Stage-1 algorithm (pair index i of centroid-sorted faces with index
// i of lexically-sorted ids) would therefore mis-bind EVERY SINGLE FACE of
// this box (xMin's geometry -> id "xMax", etc.) — i.e. it fails this fixture
// by construction, which is exactly what "FAILS-IF the rebind falls back to
// enumeration order" means. The new geometric-snapshot rebind (BK-10a) must
// bind every id to its OWN geometry regardless of either sort order.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'

const V = { x: 40, y: 20, z: 10 }

describe('restoreBody geometric-snapshot rebind (BK-10a)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('rebinds every box face to its OWN geometry, not centroid/lexical enumeration order', async () => {
    const box = await engine.makeBox('F1', V)
    expect(box.ok).toBe(true)
    expect(box.elementMap?.geometry).toBeDefined() // ICR-1 inline geometry

    const brep = await engine.serializeBody(box.body!)
    const restored = await engine.restoreBody(brep, box.elementMap!)
    const snaps = engine.snapshotsFor(restored)

    expect(snaps['F1:BOX:xMax'].centroid[0]).toBeCloseTo(40, 3)
    expect(snaps['F1:BOX:xMin'].centroid[0]).toBeCloseTo(0, 3)
    expect(snaps['F1:BOX:yMax'].centroid[1]).toBeCloseTo(20, 3)
    expect(snaps['F1:BOX:yMin'].centroid[1]).toBeCloseTo(0, 3)
    expect(snaps['F1:BOX:zMax'].centroid[2]).toBeCloseTo(10, 3)
    expect(snaps['F1:BOX:zMin'].centroid[2]).toBeCloseTo(0, 3)

    // Cross-check against the naive centroid-sort<->lexical-id-sort pairing
    // this fixture is designed to break: it would assign xMin's geometry
    // (centroid.x==0) to id "F1:BOX:xMax", which the assertion above already
    // rules out (xMax's restored centroid.x is 40, not 0).
    const vol = await engine.measure(restored, 'volume')
    expect(vol.value).toBeCloseTo(40 * 20 * 10, 3)
    await engine.disposeAll()
  }, 60_000)

  it('a cut-derived body (asymmetric, distinct fragment geometry) also rebinds correctly', async () => {
    const target = (await engine.makeBox('G1', V)).body!
    const tool = (await engine.makeBox('G2', { x: 10, y: 10, z: 20 })).body!
    const cut = await engine.applyBoolean({ featureId: 'G3', op: 'cut', target, tools: [tool] })
    expect(cut.ok).toBe(true)
    expect(cut.elementMap?.geometry).toBeDefined()

    const brep = await engine.serializeBody(cut.body!)
    const restored = await engine.restoreBody(brep, cut.elementMap!)
    const restoredSnaps = engine.snapshotsFor(restored)
    const originalSnaps = engine.snapshotsFor(cut.body!)

    // Every id present in both maps must land on geometry matching the
    // pre-restore snapshot (same centroid/area), proving the rebind used the
    // id's OWN geometry rather than an arbitrary enumeration slot.
    // GEO-2-R1.4: count skips and assert zero -- a silent `continue` on a
    // missing restored snapshot let a partial rebind failure on the cut body
    // pass unnoticed. All ids on a cut delta DO carry inline geometry
    // (ICR-1), so every one of them must resolve; a skip is now a failure.
    let skipped = 0
    for (const id of Object.keys(originalSnaps)) {
      const restoredSnap = restoredSnaps[id]
      if (!restoredSnap) {
        skipped++
        console.log('DIAG2 missing', id, 'inGeometry=', cut.elementMap!.geometry?.[id] !== undefined, JSON.stringify(cut.elementMap!.geometry?.[id]))
        continue
      }
      expect(restoredSnap.centroid[0]).toBeCloseTo(originalSnaps[id].centroid[0], 3)
      expect(restoredSnap.centroid[1]).toBeCloseTo(originalSnaps[id].centroid[1], 3)
      expect(restoredSnap.centroid[2]).toBeCloseTo(originalSnaps[id].centroid[2], 3)
      expect(restoredSnap.area).toBeCloseTo(originalSnaps[id].area, 3)
    }
    expect(skipped).toBe(0)
    await engine.disposeAll()
  }, 60_000)
})
