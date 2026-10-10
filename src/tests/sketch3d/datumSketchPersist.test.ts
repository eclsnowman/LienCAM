import { describe, expect, it } from 'vitest'
import { FeatureDag } from '../../doc/dag'
import { ElementMap } from '../../doc/element-map'
import type { GeometrySnapshot } from '../../doc/element-map'
import { createDocumentArchive, loadDocumentArchive, type DocumentSaveInput } from '../../doc/persist'
import { boxFaceId } from '../../doc/stable-id'
import type { ElementMapDelta } from '../../geom/geom-service'
import { createFacePlaneDatumNode, datumPlaneNodeId, makeDatumPlaneExecutor, type DatumPlanePayload } from '../../sketch3d/datumPlane'
import { sketch3dNodeId, type Sketch3dNodePayload } from '../../sketch3d/regen'

// WO SKC-5 acceptance criterion 5: "Save/load round-trips the datum+sketch
// binding (ADR-0027 migration discipline; golden)." Mirrors doc/persist/
// persist.test.ts's own scripted-document + createDocumentArchive/
// loadDocumentArchive round-trip pattern.

const plane = (centroid: GeometrySnapshot['centroid'], area: number, normal: GeometrySnapshot['normal'] = { x: 0, y: 0, z: 1 }): GeometrySnapshot => ({
  surfaceType: 'plane',
  centroid,
  area,
  normal,
})

describe('save/load round-trips a face-plane datum + plane-bound sketch3d node', () => {
  it('refs, consumes, payload (frame/flipNormal/planeNodeId/externalRefs/profile/regions) all survive a full archive round trip', async () => {
    const TOP = boxFaceId('F1', 'zmax')
    const dag = new FeatureDag()
    const map = new ElementMap()
    dag.insertNode({ id: 'F1', kind: 'feature', consumes: [] })
    const boxDelta: ElementMapDelta = { featureId: 'F1', generated: [TOP], modified: {}, deleted: [], geometry: { [TOP]: plane({ x: 0, y: 0, z: 10 }, 100) } }
    map.applyDelta(boxDelta)

    const datumId = createFacePlaneDatumNode(dag, { id: 'SK1', ownerId: 'F1', faceId: TOP, flipNormal: true })
    const executor = makeDatumPlaneExecutor(dag, map)
    await executor(dag.getNode(datumId)!)

    const sketchId = sketch3dNodeId('SK1')
    const sketchPayload: Sketch3dNodePayload = {
      document: { id: 'SK1', entities: [{ id: 'SK1.ext0', kind: 'line', start: { x: -20, y: -10 }, end: { x: 20, y: -10 } }], constraints: [] },
      dimensionDiagnostics: [],
      planeNodeId: datumId,
      externalRefs: [{ sourceFaceId: TOP, entityIds: ['SK1.ext0'] }],
      profile: {
        sketchId: 'SK1',
        plane: { origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: -1 }, xDir: { x: 1, y: 0, z: 0 } },
        loops: [[{ kind: 'line', a: [-20, -10], b: [20, -10], srcId: 'SK1.ext0' }]],
      },
      regions: [
        {
          sketchId: 'SK1',
          plane: { origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: -1 }, xDir: { x: 1, y: 0, z: 0 } },
          loops: [[{ kind: 'line', a: [-20, -10], b: [20, -10], srcId: 'SK1.ext0' }]],
        },
        {
          sketchId: 'SK1',
          plane: { origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: -1 }, xDir: { x: 1, y: 0, z: 0 } },
          loops: [[{ kind: 'line', a: [1, 1], b: [2, 1], srcId: 'SK1.region2' }]],
        },
      ],
    }
    dag.insertNode({ id: sketchId, kind: 'sketch', consumes: [datumId], payload: sketchPayload })

    const input: DocumentSaveInput = { dag, elementMapDeltas: [boxDelta] }
    const bytes = createDocumentArchive(input)
    const loaded = loadDocumentArchive(bytes)

    const restoredDatum = loaded.dag.getNode(datumId)!
    expect(restoredDatum.kind).toBe('datum')
    expect(restoredDatum.consumes).toEqual(['F1'])
    expect(restoredDatum.refs).toEqual([{
      id: TOP,
      kind: 'single-face',
      role: 'supportFace',
      elementType: 'face',
    }])
    const restoredDatumPayload = restoredDatum.payload as DatumPlanePayload
    expect(restoredDatumPayload.datumType).toBe('plane')
    expect(restoredDatumPayload.planeKind).toBe('face-plane')
    expect(restoredDatumPayload.flipNormal).toBe(true)
    expect(restoredDatumPayload.lastGoodFrame).toEqual({ origin: { x: 0, y: 0, z: 10 }, normal: { x: 0, y: 0, z: -1 }, xDir: { x: 1, y: 0, z: 0 } })
    // Reference-resolution health is fresh from the replayed ElementMap
    // (loadDocumentArchive calls dag.regenerate(elementMap) itself), not a
    // frozen pre-save snapshot -- TOP is still live, so still exact.
    expect(restoredDatum.degraded).toBe(false)

    const restoredSketch = loaded.dag.getNode(sketchId)!
    expect(restoredSketch.kind).toBe('sketch')
    expect(restoredSketch.consumes).toEqual([datumId])
    const restoredSketchPayload = restoredSketch.payload as Sketch3dNodePayload
    expect(restoredSketchPayload.planeNodeId).toBe(datumId)
    expect(restoredSketchPayload.externalRefs).toEqual([{ sourceFaceId: TOP, entityIds: ['SK1.ext0'] }])
    expect(restoredSketchPayload.profile).toEqual(sketchPayload.profile)
    expect(restoredSketchPayload.regions).toEqual(sketchPayload.regions)
    expect(restoredSketchPayload.document).toEqual(sketchPayload.document)

    void datumPlaneNodeId
  })
})
