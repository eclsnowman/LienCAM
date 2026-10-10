import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createLocalGeomService } from '../../geom'
import { resetDocumentHolder, stashLoadedDocument } from '../../doc/documentHolder'
import { BASE_PLANE_XY_NODE_ID } from '../../doc/genesis'
import { finalizeSeedArchive, newSeededModelDag } from '../../doc/seedModelArchive'
import type { Sketch, SketchEntity } from '../../lib/sketch/sketcher'
import {
  __setModelBodyHeadlessClientFactoryForTests,
  recognizeModelBodyHoles,
} from '../../lib/cam/modelBodyHoleRecognition'

function sketch(id: string, entities: SketchEntity[]): Sketch {
  return { id, layerId: 'L1', entities, constraints: [], dimensions: [], solveStatus: null }
}

function rectangle(width: number, height: number): SketchEntity[] {
  return [
    { id: 'plate-0', kind: 'line', construction: false, start: { x: 0, y: 0 }, end: { x: width, y: 0 } },
    { id: 'plate-1', kind: 'line', construction: false, start: { x: width, y: 0 }, end: { x: width, y: height } },
    { id: 'plate-2', kind: 'line', construction: false, start: { x: width, y: height }, end: { x: 0, y: height } },
    { id: 'plate-3', kind: 'line', construction: false, start: { x: 0, y: height }, end: { x: 0, y: 0 } },
  ]
}

describe('WO-1084 headless CAM hole recognition uses every whole-sketch region', () => {
  beforeEach(() => {
    resetDocumentHolder()
    __setModelBodyHeadlessClientFactoryForTests(() => createLocalGeomService())
  })

  afterEach(() => {
    __setModelBodyHeadlessClientFactoryForTests(null)
    resetDocumentHolder()
  })

  it('replays one seven-circle whole-sketch Remove feature as seven recognized holes', async () => {
    const dag = newSeededModelDag()
    const plateSketchId = 'sketch3d:PLATE'
    const holeSketchId = 'sketch3d:HOLES'
    const centers = [
      [15, 15], [40, 15], [65, 15], [85, 15],
      [25, 50], [50, 50], [75, 50],
    ] as const
    const circles: SketchEntity[] = centers.map(([x, y], index) => ({
      id: `circle-${index + 1}`,
      kind: 'circle',
      construction: false,
      center: { x, y },
      radius: 3,
    }))

    dag.insertNode({
      id: plateSketchId,
      kind: 'sketch',
      consumes: [BASE_PLANE_XY_NODE_ID],
      refs: [],
      payload: { sketch: sketch('PLATE', rectangle(100, 80)), planeNodeId: BASE_PLANE_XY_NODE_ID },
    })
    dag.insertNode({
      id: 'PLATE-EXTRUDE',
      kind: 'feature',
      consumes: [plateSketchId],
      refs: [],
      payload: {
        opType: 'extrude', sketchId: plateSketchId, profileSelector: { kind: 'whole-sketch' },
        distance: 20, direction: 'up', boolMode: 'newBody',
      },
    })
    dag.insertNode({
      id: holeSketchId,
      kind: 'sketch',
      consumes: [BASE_PLANE_XY_NODE_ID],
      refs: [],
      payload: { sketch: sketch('HOLES', circles), planeNodeId: BASE_PLANE_XY_NODE_ID },
    })
    dag.insertNode({
      id: 'SEVEN-HOLE-CUT',
      kind: 'feature',
      consumes: [holeSketchId, 'PLATE-EXTRUDE'],
      refs: [],
      payload: {
        opType: 'extrude', sketchId: holeSketchId, profileSelector: { kind: 'whole-sketch' },
        distance: 15, direction: 'up', boolMode: 'remove', targetFeatureId: 'PLATE-EXTRUDE',
      },
    })

    stashLoadedDocument(finalizeSeedArchive(dag))
    const holes = (await recognizeModelBodyHoles('SEVEN-HOLE-CUT')).filter((feature) =>
      feature.featureClass === 'blindHole' || feature.featureClass === 'throughHole' || feature.featureClass === 'counterboreStack',
    )
    expect(holes).toHaveLength(7)
  }, 60_000)
})
