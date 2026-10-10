import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../../doc/dag'
import type { DagNodeSnapshot } from '../../../doc/dag'
import { ElementMap } from '../../../doc/element-map'
import { createDocumentArchive, loadDocumentArchive } from '../../../doc/persist'
import { RegenScheduler } from '../../../doc/regen'
import type { FeatureOp } from '../../../doc/regen'
import { boxFaceId } from '../../../doc/stable-id'
import type { ElementMapDelta } from '../../../geom/geom-service'
import {
  createFacePlaneDatumNode,
  createOffsetPlaneDatumNode,
  makeDatumPlaneExecutor,
  reattachFacePlaneDatum,
} from '../../../sketch3d/datumPlane'
import { plane } from './_helpers'

// WO-1402 (BUG-488): a support face reference that goes unresolved must degrade
// every plane-dependent node downstream of it -- the offset datum, its hosted
// sketch and the dependent solid -- in the FeatureStatus store the tree reads,
// whether or not those nodes re-executed this pass. Repair clears the chain.

const TOP = boxFaceId('F1', 'zmax')
const XMAX = boxFaceId('F1', 'xmax')

const delta = (p: Partial<ElementMapDelta> & { featureId: string }): ElementMapDelta => ({
  modified: {},
  generated: [],
  deleted: [],
  ...p,
})

const boxDelta = delta({
  featureId: 'F1',
  generated: [boxFaceId('F1', 'xmin'), XMAX, boxFaceId('F1', 'ymin'), boxFaceId('F1', 'ymax'), boxFaceId('F1', 'zmin'), TOP],
  geometry: {
    [TOP]: plane({ x: 0, y: 0, z: 10 }, 100),
    [XMAX]: plane({ x: 5, y: 0, z: 5 }, 80, { x: 1, y: 0, z: 0 }),
  },
})

const CHAIN = ['datum:SK1', 'datum:Off1', 'S1', 'F2'] as const
const DOWNSTREAM = ['datum:Off1', 'S1', 'F2'] as const

/** Box F1 -> face-plane datum on TOP -> offset datum -> hosted sketch -> extrusion,
 *  plus an unrelated feature F9 that shares no consumes edge with the chain. */
function buildChain(dag = new FeatureDag()): FeatureDag {
  dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
  createFacePlaneDatumNode(dag, { id: 'SK1', ownerId: 'F1', faceId: TOP })
  createOffsetPlaneDatumNode(dag, { id: 'Off1', parentPlaneNodeId: 'datum:SK1', distance: 5, name: 'Offset' })
  dag.insertNode({ id: 'S1', kind: 'sketch', consumes: ['datum:Off1'] })
  dag.insertNode({ id: 'F2', kind: 'feature', consumes: ['S1'] })
  dag.insertNode({ id: 'F9', kind: 'feature', consumes: [] })
  return dag
}

function executorFor(
  dag: FeatureDag,
  map: ElementMap,
  bodyOps: Record<string, () => { ok: boolean; elementMap?: ElementMapDelta }> = {},
  recorder: string[] = [],
): FeatureOp {
  const datum = makeDatumPlaneExecutor(dag, map)
  return async (node: DagNodeSnapshot) => {
    recorder.push(node.id)
    if (node.kind === 'datum') return datum(node)
    const op = bodyOps[node.id]
    if (op) return { ...op(), diagnostics: [] }
    return { ok: true, elementMap: node.id === 'F1' ? boxDelta : undefined, diagnostics: [] }
  }
}

async function buildClean(): Promise<{ dag: FeatureDag; map: ElementMap; scheduler: RegenScheduler }> {
  const dag = buildChain()
  const map = new ElementMap()
  const scheduler = new RegenScheduler(dag, map)
  scheduler.markDirty('F1')
  scheduler.markDirty('F9')
  await scheduler.run(executorFor(dag, map))
  for (const id of [...CHAIN, 'F1', 'F9']) expect(scheduler.statusOf(id)).toBe('ok')
  return { dag, map, scheduler }
}

function expectChainDegraded(scheduler: RegenScheduler): void {
  for (const id of CHAIN) {
    expect(scheduler.statusOf(id), id).toBe('degraded')
    expect(scheduler.diagnosticsOf(id).some((d) => d.code === 'REFERENCE_UNRESOLVED'), id).toBe(true)
  }
}

describe('WO-1402: a lost support reference degrades the whole plane-dependent chain', () => {
  it('a support face deleted by a feature the chain does not consume degrades nodes that never re-executed', async () => {
    const { dag, map, scheduler } = await buildClean()

    // F9 (no consumes edge to the chain) consumes TOP away. Only F9 re-executes.
    const recorder: string[] = []
    scheduler.markDirty('F9')
    const pass = await scheduler.run(
      executorFor(dag, map, { F9: () => ({ ok: true, elementMap: delta({ featureId: 'F9', deleted: [TOP] }) }) }, recorder),
    )
    expect(recorder).toEqual(['F9'])
    expect(pass.executed).toEqual(['F9'])
    expect(dag.getNode('datum:SK1')!.degraded).toBe(true)
    expectChainDegraded(scheduler)
    expect(scheduler.statusOf('F1')).toBe('ok')
    expect(scheduler.statusOf('F9')).toBe('ok')
  })

  it('a live edit that deletes the face degrades the offset datum, sketch and solid, not only the owning datum', async () => {
    const { dag, map, scheduler } = await buildClean()
    scheduler.markDirty('F1')
    await scheduler.run(executorFor(dag, map, { F1: () => ({ ok: true, elementMap: delta({ featureId: 'F1-shrink', deleted: [TOP] }) }) }))
    expectChainDegraded(scheduler)
    expect(scheduler.statusOf('F9')).toBe('ok')
  })

  it("File Open's initial pass reports the chain degraded when the support face is not produced", async () => {
    const { dag } = await buildClean()
    const loaded = loadDocumentArchive(createDocumentArchive({ dag, elementMapDeltas: [] }))
    const scheduler = new RegenScheduler(loaded.dag, loaded.elementMap)
    const noTop = delta({ featureId: 'F1', generated: [boxFaceId('F1', 'xmin'), XMAX] })
    for (const id of loaded.dag.nodeIds()) scheduler.markDirty(id)
    await scheduler.run(executorFor(loaded.dag, loaded.elementMap, { F1: () => ({ ok: true, elementMap: noTop }) }))
    expectChainDegraded(scheduler)
    expect(scheduler.statusOf('F1')).toBe('ok')
    expect(scheduler.statusOf('F9')).toBe('ok')
  })

  it('repairing the support reference clears the chain with no re-execution forced', async () => {
    const { dag, map, scheduler } = await buildClean()
    scheduler.markDirty('F9')
    await scheduler.run(executorFor(dag, map, { F9: () => ({ ok: true, elementMap: delta({ featureId: 'F9', deleted: [TOP] }) }) }))
    expectChainDegraded(scheduler)

    // Re-point the support at a live face; the next pass executes nothing.
    dag.setRefs('datum:SK1', [{ id: XMAX, kind: 'single-face', role: 'supportFace', elementType: 'face' }])
    const recorder: string[] = []
    const pass = await scheduler.run(executorFor(dag, map, {}, recorder))
    expect(recorder).toEqual([])
    expect(pass.executed).toEqual([])
    for (const id of CHAIN) {
      expect(scheduler.statusOf(id), id).toBe('ok')
      expect(scheduler.diagnosticsOf(id), id).toEqual([])
    }
  })

  it('repair through reattach + regen of the datum also clears the chain', async () => {
    const { dag, map, scheduler } = await buildClean()
    scheduler.markDirty('F1')
    await scheduler.run(executorFor(dag, map, { F1: () => ({ ok: true, elementMap: delta({ featureId: 'F1-shrink', deleted: [TOP] }) }) }))
    expectChainDegraded(scheduler)

    reattachFacePlaneDatum(dag, 'datum:SK1', { ownerId: 'F1', faceId: XMAX })
    scheduler.markDirty('datum:SK1')
    await scheduler.run(executorFor(dag, map))
    for (const id of CHAIN) expect(scheduler.statusOf(id), id).toBe('ok')
  })

  it("a node whose own op fails stays 'failed'; its dependents keep UPSTREAM_FAILED", async () => {
    const { dag, map, scheduler } = await buildClean()
    scheduler.markDirty('F1')
    await scheduler.run(
      executorFor(dag, map, {
        F1: () => ({ ok: true, elementMap: delta({ featureId: 'F1-shrink', deleted: [TOP] }) }),
        S1: () => ({ ok: false }),
      }),
    )
    expect(scheduler.statusOf('datum:SK1')).toBe('degraded')
    expect(scheduler.statusOf('datum:Off1')).toBe('degraded')
    expect(scheduler.statusOf('S1')).toBe('failed')
    expect(scheduler.diagnosticsOf('S1').some((d) => d.code === 'KERNEL_OP_FAILED')).toBe(true)
    expect(scheduler.statusOf('F2')).toBe('degraded')
    expect(scheduler.diagnosticsOf('F2').map((d) => d.code)).toEqual(['UPSTREAM_FAILED'])

    // A later pass that executes nothing must not rewrite either status.
    await scheduler.run(executorFor(dag, map))
    expect(scheduler.statusOf('S1')).toBe('failed')
    expect(scheduler.diagnosticsOf('F2').map((d) => d.code)).toEqual(['UPSTREAM_FAILED'])
  })

  it('an untouched branch beside the chain is unaffected', async () => {
    const { dag, map, scheduler } = await buildClean()
    scheduler.markDirty('F9')
    await scheduler.run(executorFor(dag, map, { F9: () => ({ ok: true, elementMap: delta({ featureId: 'F9', deleted: [TOP] }) }) }))
    for (const id of DOWNSTREAM) expect(scheduler.statusOf(id)).toBe('degraded')
    expect(scheduler.statusOf('F1')).toBe('ok')
    expect(scheduler.diagnosticsOf('F1')).toEqual([])
  })
})
