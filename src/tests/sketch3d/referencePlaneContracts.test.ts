import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import { ElementMap } from '../../doc/element-map'
import { RegenScheduler } from '../../doc/regen'
import { createDocumentArchive, loadDocumentArchive } from '../../doc/persist'
import {
  createOffsetPlaneDatumNode,
  makeDatumPlaneExecutor,
  type OffsetPlaneDatumPayload,
} from '../../sketch3d/datumPlane'

const parentFrame = {
  origin: { x: 0, y: 0, z: 0 },
  normal: { x: 0, y: 0, z: 1 },
  xDir: { x: 1, y: 0, z: 0 },
}

function offsetDag(): { dag: FeatureDag; offsetId: string } {
  const dag = new FeatureDag()
  dag.insertNode({
    id: 'datum:Parent',
    kind: 'datum',
    consumes: [],
    refs: [],
    payload: { datumType: 'plane', planeKind: 'base-plane', basePlane: 'xy', lastGoodFrame: parentFrame },
  })
  const offsetId = createOffsetPlaneDatumNode(dag, {
    id: 'Offset1',
    parentPlaneNodeId: 'datum:Parent',
    distance: 8,
    name: 'Fixture offset',
  })
  return { dag, offsetId }
}

describe('typed stable reference contract', () => {
  it('preserves role and element type through clone, deterministic serialization, and restore', () => {
    const dag = new FeatureDag()
    dag.insertNode({
      id: 'P1',
      kind: 'datum',
      refs: [{ id: 'edge:1', kind: 'single-edge', role: 'axisLine', elementType: 'edge' }],
    })
    const serialized = dag.serialize()
    const restored = FeatureDag.restore(serialized)
    expect(restored.getNode('P1')!.refs).toEqual([
      { id: 'edge:1', kind: 'single-edge', role: 'axisLine', elementType: 'edge' },
    ])
    expect(restored.serialize()).toBe(serialized)
  })

  it('degrades a split single-edge instead of applying face snapshot heuristics', () => {
    const map = new ElementMap()
    map.applyDelta({ featureId: 'seed', modified: {}, generated: ['edge:old'], deleted: [] })
    map.applyDelta({
      featureId: 'split',
      modified: { 'edge:old': ['edge:a', 'edge:b'] },
      generated: [],
      deleted: [],
      geometry: {
        'edge:old': { surfaceType: 'plane', centroid: { x: 0, y: 0, z: 0 }, area: 1, normal: { x: 0, y: 0, z: 1 } },
        'edge:a': { surfaceType: 'plane', centroid: { x: 0.1, y: 0, z: 0 }, area: 1, normal: { x: 0, y: 0, z: 1 } },
        'edge:b': { surfaceType: 'plane', centroid: { x: 5, y: 0, z: 0 }, area: 1, normal: { x: 0, y: 0, z: 1 } },
      },
    })
    expect(map.resolve('edge:old', 'single-edge')).toMatchObject({ status: 'lost', boundTo: [] })
  })
})

describe('Offset Plane vertical slice', () => {
  it('recomputes from its parent and follows a distance edit', async () => {
    const { dag, offsetId } = offsetDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty('datum:Parent')
    await scheduler.run(makeDatumPlaneExecutor(dag, map))

    const first = dag.getNode(offsetId)!.payload as OffsetPlaneDatumPayload
    expect(first.lastGoodFrame?.origin).toEqual({ x: 0, y: 0, z: 8 })

    dag.setPayload(offsetId, { ...first, definition: { ...first.definition, distance: 15 } })
    scheduler.markDirty(offsetId)
    await scheduler.run(makeDatumPlaneExecutor(dag, map))
    const edited = dag.getNode(offsetId)!.payload as OffsetPlaneDatumPayload
    expect(edited.lastGoodFrame?.origin).toEqual({ x: 0, y: 0, z: 15 })
  })

  it('round-trips through the document archive and replays the derived frame', async () => {
    const { dag, offsetId } = offsetDag()
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty('datum:Parent')
    await scheduler.run(makeDatumPlaneExecutor(dag, map))

    const archive = createDocumentArchive({ dag, elementMapDeltas: [] })
    const loaded = loadDocumentArchive(archive)
    const loadedMap = loaded.elementMap
    const loadedScheduler = new RegenScheduler(loaded.dag, loadedMap)
    loadedScheduler.markDirty(offsetId)
    await loadedScheduler.run(makeDatumPlaneExecutor(loaded.dag, loadedMap))

    const payload = loaded.dag.getNode(offsetId)!.payload as OffsetPlaneDatumPayload
    expect(payload.definition).toEqual({ kind: 'offset', distance: 8, flipNormal: false })
    expect(payload.lastGoodFrame).toEqual({ ...parentFrame, origin: { x: 0, y: 0, z: 8 } })
    expect(loaded.dag.getNode(offsetId)!.consumes).toEqual(['datum:Parent'])
  })

  it('fails loudly when the persisted parent frame is degenerate', async () => {
    const { dag, offsetId } = offsetDag()
    const parent = dag.getNode('datum:Parent')!
    dag.setPayload(parent.id, {
      ...parent.payload,
      lastGoodFrame: { ...parentFrame, normal: { x: 0, y: 0, z: 0 } },
    })
    const map = new ElementMap()
    const scheduler = new RegenScheduler(dag, map)
    scheduler.markDirty(offsetId)
    await scheduler.run(makeDatumPlaneExecutor(dag, map))
    expect(scheduler.statusOf(offsetId)).toBe('failed')
    expect(scheduler.diagnosticsOf(offsetId)[0]?.params?.reason).toContain('zero-parent-normal')
  })
})
