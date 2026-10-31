import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../../doc'
import { createDocumentArchive, loadDocumentArchive } from '../../../doc/persist'
import { seedGenesisNodes, NODE_ID_BY_BASE_PLANE } from '../../../components/model3d/workbench/basePlanes'
import { resolveOpenChainProfileSelector } from '../../../components/model3d/workbench/regionSelector'
import { resolveOpenChainProfileSelector as resolveHeadless } from '../../../lib/cam/modelWorkbenchHelpers'
import { reverseSweepPathSelector, type SketchChainPathSelector } from '../../../geom/sweep-path'

describe('WO-3236 open-chain Extrude archive', () => {
  it.each([false, true])('round-trips entity identity, order and direction (reversed: %s)', (reversed) => {
    const dag = new FeatureDag()
    seedGenesisNodes(dag)
    const planeNodeId = NODE_ID_BY_BASE_PLANE.xy
    dag.insertNode({ id: 'S', kind: 'sketch', consumes: [planeNodeId], payload: { planeNodeId, sketch: { id: 'S', entities: [
      { id: 'right', kind: 'line', start: { x: 10, y: 0 }, end: { x: 20, y: 0 }, construction: false },
      { id: 'left', kind: 'line', start: { x: 0, y: 0 }, end: { x: 10, y: 0 }, construction: false },
    ], constraints: [], dimensions: [] } } })
    const forward: SketchChainPathSelector = { kind: 'sketch-chain', sketchId: 'S', steps: [{ entityId: 'left', forward: true }, { entityId: 'right', forward: true }] }
    const profileSelector = reversed ? reverseSweepPathSelector(forward) : forward
    dag.insertNode({ id: 'F', kind: 'feature', consumes: ['S'], payload: { opType: 'extrude', sketchId: 'S', profileSelector, distance: 10, direction: 'up', boolMode: 'newBody' } })
    const restored = loadDocumentArchive(createDocumentArchive({ dag, elementMapDeltas: [] }))
    const feature = restored.dag.getNode('F')!
    expect(restored.migrationsApplied).toEqual([])
    expect(feature.payload.profileSelector).toEqual(profileSelector)
    expect(feature.consumes).toEqual(['S'])
    const lookup = (id: string) => restored.dag.getNode(id)
    const resolution = resolveOpenChainProfileSelector(feature.payload.profileSelector, lookup)
    expect(resolution.ok).toBe(true)
    if (!resolution.ok) throw new Error(resolution.diagnostic.message)
    expect(resolution.path.segments.map(s => s.srcId)).toEqual(reversed ? ['right', 'left'] : ['left', 'right'])
    expect(resolution.path.segments[0]).toMatchObject({ kind: 'line', a: reversed ? [20, 0] : [0, 0] })
    expect(resolveHeadless(feature.payload.profileSelector, lookup)).toEqual(resolution)
  })
})
