// WO SKC-5: whole-pipeline proof against the real occt-wasm kernel + real
// planegcs solver -- exactly the recon's own regen ordering (docs/3d/
// SKETCH-PLANE-SYSTEM-RECON.md "Regen ordering", steps 1-7): pick a real
// planar face -> face-plane datum resolves a frame -> exercise the legacy boundary projection
// helper as FIXED sketch geometry (AC #7) -> sketch solves
// through the existing one-sketcher bridge -> ProfileRegion emitted on the
// datum's resolved plane (AC #1, #7). No mocked geometry anywhere in this
// file -- the box, its face boundary, the solve, and the region extraction
// are all the genuine subsystems.

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { GeomEngine } from '../../geom/worker/geom-engine.ts'
import { GeometryCache } from '../../viewport3d'
import { FeatureDag } from '../../doc/dag'
import { ElementMap } from '../../doc/element-map'
import { RegenScheduler } from '../../doc/regen'
import { applyFeatureDelta } from '../../doc/replay'
import type { DagNodeSnapshot, FeatureOp } from '../../doc'
import { createFacePlaneDatumNode, datumPlaneNodeId, makeDatumPlaneExecutor, type DatumPlanePayload } from '../../sketch3d/datumPlane'
import { commitSketch3dDocument, makeSketch3dExecutor, sketch3dNodeId, type Sketch3dNodePayload } from '../../sketch3d/regen'
import { projectFaceBoundaryToSketch } from '../../sketch3d/planeSketch'
import { worldToLocal } from '../../sketch3d/planeMath'
import { faceOuterBoundaryLoop } from '../../components/model3d/workbench/faceBoundary'
import { createSketch3dSolveService, type Sketch3dSolveService } from '../../sketch3d/solveService'

describe('face-plane sketch end-to-end (real kernel + real solver)', () => {
  let engine: GeomEngine
  const openServices: Sketch3dSolveService[] = []

  beforeAll(async () => {
    engine = new GeomEngine()
    await engine.init()
  }, 60_000)

  afterAll(async () => {
    await engine.disposeKernel()
  })

  afterEach(() => {
    while (openServices.length > 0) openServices.pop()?.dispose()
  })

  it('projects the real top-face boundary, solves it fixed, and emits a ProfileRegion on the resolved plane', async () => {
    const size = { x: 40, y: 20, z: 10 }
    const result = await engine.makeBox('F1', size)
    expect(result.ok).toBe(true)
    const handle = result.body!
    const boxDelta = result.elementMap!
    const topId = Object.keys(boxDelta.geometry ?? {}).find(
      (id) => boxDelta.geometry![id].surfaceType === 'plane' && (boxDelta.geometry![id].normal?.z ?? 0) > 0.9,
    )!
    expect(topId).toBeDefined()

    const tess = await engine.tessellate(handle, { deflection: 0.1 })
    const cache = new GeometryCache()
    const body = cache.ingest('box1', tess)

    const dag = new FeatureDag()
    const map = new ElementMap()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    applyFeatureDelta(map, boxDelta)

    const datumId = createFacePlaneDatumNode(dag, { id: 'SK1', ownerId: 'F1', faceId: topId })
    const datumExecutor = makeDatumPlaneExecutor(dag, map)
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty(datumId)
    await scheduler.run(async (node) => (node.kind === 'datum' ? datumExecutor(node) : { ok: true, diagnostics: [] }))
    const frame = (dag.getNode(datumId)!.payload as DatumPlanePayload).lastGoodFrame!

    const boundary = faceOuterBoundaryLoop(body, topId, (p) => worldToLocal(frame, p))
    expect(boundary.ok).toBe(true)
    if (!boundary.ok) throw new Error('expected a clean boundary loop')
    const worldLoop = boundary.loop
    expect(worldLoop.length).toBe(4)

    const projected = projectFaceBoundaryToSketch(frame, worldLoop, { sketchId: 'SK1', sourceFaceId: topId })
    expect(projected.entities.length).toBe(4)
    expect(projected.constraints.length).toBe(4) // AC #7: one fixed constraint per projected line
    const islandEntities = [
      { id: 'island-a', kind: 'line' as const, start: { x: 30, y: 0 }, end: { x: 35, y: 0 } },
      { id: 'island-b', kind: 'line' as const, start: { x: 35, y: 0 }, end: { x: 35, y: 5 } },
      { id: 'island-c', kind: 'line' as const, start: { x: 35, y: 5 }, end: { x: 30, y: 5 } },
      { id: 'island-d', kind: 'line' as const, start: { x: 30, y: 5 }, end: { x: 30, y: 0 } },
    ]
    const islandConstraints = islandEntities.map((entity, index) => ({
      id: `island-fixed-${index}`,
      kind: 'fixed' as const,
      entityId: entity.id,
    }))

    const solveService = await createSketch3dSolveService()
    openServices.push(solveService)

    const sketchExecutor: FeatureOp = makeSketch3dExecutor(dag, solveService, scheduler, map)
    const composite: FeatureOp = async (node: DagNodeSnapshot) => {
      if (node.kind === 'datum') return datumExecutor(node)
      if (node.kind === 'sketch') return sketchExecutor(node)
      return { ok: true, diagnostics: [] }
    }

    const pass = await commitSketch3dDocument(
      dag,
      scheduler,
      composite,
      {
        id: 'SK1',
        entities: [...projected.entities, ...islandEntities],
        constraints: [...projected.constraints, ...islandConstraints],
      },
      { planeNodeId: datumId, externalRefs: [projected.externalRef] },
    )

    const sketchId = sketch3dNodeId('SK1')
    expect(pass.executed).toContain(sketchId)
    expect(scheduler.statusOf(sketchId)).toBe('ok')

    const sketchNode = dag.getNode(sketchId)!
    expect(sketchNode.consumes).toContain(datumId)
    const payload = sketchNode.payload as Sketch3dNodePayload

    // The solve is fully fixed (DOF 0) -- every projected point is grounded,
    // nothing left for the solver to move (AC #7's "solver treats as fixed").
    expect(payload.solveResult?.dof).toBe(0)
    expect(payload.solveResult?.status === 'success' || payload.solveResult?.status === 'redundant').toBe(true)

    expect(payload.profile).toBeDefined()
    expect(payload.regions).toHaveLength(2)
    expect(payload.profile).toEqual(payload.regions![0])
    const profile = payload.profile!
    expect(profile.loops.length).toBe(1)
    expect(profile.loops[0].length).toBe(4)
    // The emitted profile's plane IS the datum's resolved frame (recon step
    // 7: "region extraction emits ProfileRegion with the datum frame").
    expect(profile.plane).toEqual(frame)

    await engine.dispose(handle)
    void datumPlaneNodeId
  }, 60_000)
})
