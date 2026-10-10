// WO SKC-5 acceptance criterion 1: "Face stable-ID exact bind: sketch on a
// picked planar face binds via ElementMap single-face resolution (integration
// test, real kernel)." Mirrors measureLogic.realKernel.integration.test.ts's
// own GeomEngine bootstrap exactly (WO UI-4's established pattern for this
// codebase's real-occt-wasm integration tests).

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { FeatureDag } from '../../doc/dag'
import { ElementMap } from '../../doc/element-map'
import { RegenScheduler } from '../../doc/regen'
import { applyFeatureDelta } from '../../doc/replay'
import { createFacePlaneDatumNode, makeDatumPlaneExecutor, type DatumPlanePayload } from '../../sketch3d/datumPlane'

describe('face-plane datum against a real occt-wasm box (AC #1)', () => {
  let engine: GeomEngine

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  it('binds a picked planar face exactly and computes a frame matching its real centroid/normal', async () => {
    const size = { x: 40, y: 20, z: 10 }
    const result = await engine.makeBox('F1', size)
    expect(result.ok).toBe(true)
    const handle = result.body!
    const delta = result.elementMap!
    const planarIds = Object.keys(delta.geometry ?? {}).filter((id) => delta.geometry![id].surfaceType === 'plane')
    expect(planarIds.length).toBe(6)
    // The +Z (top) face: real occt-wasm makeBox spans [0,size] per axis (its
    // near corner sits at the origin, not centered), so the top face's
    // centroid is at (size.x/2, size.y/2, size.z) with normal (0,0,1).
    const topId = planarIds.find((id) => Math.abs(delta.geometry![id].centroid.z - size.z) < 1e-6 && (delta.geometry![id].normal?.z ?? 0) > 0.9)
    expect(topId).toBeDefined()
    if (topId === undefined) throw new Error('unreachable')

    const dag = new FeatureDag()
    const map = new ElementMap()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    applyFeatureDelta(map, delta)

    const datumId = createFacePlaneDatumNode(dag, { id: 'SK1', ownerId: 'F1', faceId: topId })
    const scheduler = new RegenScheduler(dag, map)
    const executor = makeDatumPlaneExecutor(dag, map)
    scheduler.markDirty(datumId)
    const pass = await scheduler.run(async (node) => (node.kind === 'datum' ? executor(node) : { ok: true, diagnostics: [] }))

    expect(pass.executed).toContain(datumId)
    expect(scheduler.statusOf(datumId)).toBe('ok')
    const node = dag.getNode(datumId)!
    expect(node.degraded).toBe(false)
    // Single-face exact bind, per ElementMap.resolve's 4-step algorithm.
    expect(node.refs).toEqual([{
      id: topId,
      kind: 'single-face',
      role: 'supportFace',
      elementType: 'face',
    }])

    const frame = (node.payload as DatumPlanePayload).lastGoodFrame!
    expect(frame.origin.x).toBeCloseTo(size.x / 2, 6)
    expect(frame.origin.y).toBeCloseTo(size.y / 2, 6)
    expect(frame.origin.z).toBeCloseTo(size.z, 6)
    expect(frame.normal.z).toBeCloseTo(1, 6)
    // Deterministic projected-model-X policy: a Z-normal plane projects
    // world +X cleanly, unchanged.
    expect(frame.xDir.x).toBeCloseTo(1, 6)
    expect(frame.xDir.y).toBeCloseTo(0, 6)

    await engine.dispose(handle)
  }, 60_000)
})
