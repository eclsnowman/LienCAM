// WO-3170 Slice A: adapter controls, not editing/CAM delivery claims.
import { describe, expect, it } from 'vitest'
import {
  fromLoops, fromMeshRecognition, fromModelVerdicts, fromStepCylinders, recognisedFeatureList,
  type FaceDescriptor, type FeatureSourceScope, type MeshBlendLike, type MeshRegionLike,
  type MeshRoundLike, type ModelVerdictLike,
} from '../../kernel/features'

const frame = { kind: 'geometry-native', entityId: 'part-a' } as const
const scope: FeatureSourceScope = {
  projectId: 'project-a', sourceGeometryId: 'geometry-a', sourceFormat: 'step',
  modelItemId: 'item-a', bodyId: 'body-a', geometryVersion: 12,
}
const model: ModelVerdictLike = {
  featureKey: 'hole:7:11:20:0:0:1:3', featureClass: 'counterboreStack', removable: true,
  faceIds: ['narrow', 'wide'], counterboreFaceIds: ['wide'],
  params: { diameter: 6, depth: 20, axisX: 0, axisY: 0, axisZ: 1,
    counterboreDiameter: 12, counterboreDepth: 5, radiusCount: 2, openings: 3 },
}
const faces: Record<string, FaceDescriptor> = {
  wide: { surface: 'cylinder', areaMm2: 60 * Math.PI, centroid: [7, 11, 17.5], axis: [0, 0, 1] },
  narrow: { surface: 'cylinder', areaMm2: 90 * Math.PI, centroid: [7, 11, 7.5], axis: [0, 0, 1] },
}
const round: MeshRoundLike = {
  id: 'blind-hole-2', kind: 'blind-hole', axis: { origin: [7, 11, 0], direction: [0, 0, 1] },
  diameterMm: 6, diametersMm: [6], depthMm: 8, maxDeviationMm: 0.03, coreRadiusMm: 2.97,
  bands: [{ surface: 'cylinder', diameterMm: 6, axialRangeMm: [0, 8], maxDeviationMm: 0.03, sourceFacetIds: [2, 3] }],
  sourceFacetIds: [2, 3, 4],
}
const meshList = (feature = round) => recognisedFeatureList(frame, 'stl-mesh', () =>
  fromMeshRecognition({ features: [feature], toleranceMm: 0.1 }))
const modelList = (verdict = model, geometry = faces) => recognisedFeatureList(frame, 'model-kernel', () =>
  fromModelVerdicts([verdict], geometry), scope)

describe('WO-3170 shared recognition evidence', () => {
  it('preserves source scope and native frame without putting scope in geometric ids', () => {
    const result = modelList()
    expect(result.scope).toEqual(scope)
    expect(result.frame).toEqual(frame)
    const other = recognisedFeatureList(frame, 'model-kernel', () => fromModelVerdicts([model], faces),
      { ...scope, projectId: 'other-project', geometryVersion: 13 })
    expect(other.features[0].id).toBe(result.features[0].id)
    expect(other.scope).not.toEqual(result.scope)
  })

  it('retains model verdict, wide-wall references and supplied face evidence as a detached snapshot', () => {
    const input = structuredClone(model), geometry = structuredClone(faces)
    const result = modelList(input, geometry)
    expect(result.features[0].evidence).toEqual({
      source: 'model-kernel', depthProvenance: 'recognizer-parameter-estimate', verdict: model, faces,
    })
    geometry.wide = { ...geometry.wide, centroid: [99, 99, 99] }
    expect(result.features[0].evidence).toMatchObject({ faces })
    expect(result.features[0].evidence).not.toBe(input)
  })

  it('labels R2 loop depth as a parameter estimate without changing the legacy depth contract', () => {
    const result = modelList({ featureKey: 'loop:7:11:20', featureClass: 'pocket', removable: true,
      faceIds: ['wide'], params: { spanX: 10, spanY: 8, depth: 4 } })
    expect(result.features[0].depth).toEqual({ evidence: 'measured', depthMm: 4 })
    expect(result.features[0].evidence?.depthProvenance).toBe('recognizer-parameter-estimate')
  })

  it('retains refused/unclassified source diagnostics and labels absent depth unknown', () => {
    const verdict = { ...model, featureKey: 'hole-refused:1', removable: false,
      featureClass: 'blindHole', refuseReason: 'unread wall', params: {} }
    const result = modelList(verdict)
    expect(result.features[0].type).toBe('unclassified')
    expect(result.features[0].evidence).toMatchObject({
      depthProvenance: 'unknown', verdict: { removable: false, refuseReason: 'unread wall' },
    })
  })

  it('retains the unplaced counterbore note when wide-face geometry is missing', () => {
    const result = modelList(model, {})
    expect(result.features[0].note).toMatch(/step is carried unplaced/)
    expect(result.features[0].geometry).toMatchObject({ bands: [] })
    expect(result.features[0].evidence).toMatchObject({ verdict: { counterboreFaceIds: ['wide'] } })
  })

  it('preserves every STEP stack span and its analytic depth provenance', () => {
    const cylinders = [
      { center: [7, 11] as [number, number], diameter: 12, topZ: 20, bottomZ: 15, through: false },
      { center: [7, 11] as [number, number], diameter: 6, topZ: 15, bottomZ: 0, through: true },
    ]
    const result = recognisedFeatureList(frame, 'step-cylinder-scan', () => fromStepCylinders(cylinders))
    expect(result.features[0].evidence).toEqual({ source: 'step-cylinder-scan',
      depthProvenance: 'analytic-cylinder-span', cylinders })
    expect(result.features[0].depth).toEqual({ evidence: 'measured', depthMm: 20 })
  })

  it('preserves mesh fit, conservative core, band witnesses and query tolerance', () => {
    expect(meshList().features[0].evidence).toEqual({ source: 'stl-mesh', kind: 'round',
      depthProvenance: 'fitted-mesh', feature: round, query: { toleranceMm: 0.1 } })
  })

  it('keeps fit-error-only changes out of geometric ids while retaining changed evidence', () => {
    const before = meshList().features[0]
    const after = meshList({ ...round, maxDeviationMm: 0.07, coreRadiusMm: 2.93,
      bands: [{ ...round.bands[0], maxDeviationMm: 0.07 }] }).features[0]
    expect(after.id).toBe(before.id)
    expect(after.evidence).not.toEqual(before.evidence)
  })

  it('keeps missing mesh fit error unknown instead of manufacturing zero', () => {
    const { maxDeviationMm: _error, coreRadiusMm: _core, ...withoutFit } = round
    void _error; void _core
    const result = meshList({ ...withoutFit, bands: [{ surface: 'cylinder', diameterMm: 6, axialRangeMm: [0, 8] }] })
    expect(result.features[0].evidence).toMatchObject({ depthProvenance: 'fitted-mesh', feature: { axis: withoutFit.axis } })
    expect(result.features[0].evidence).not.toHaveProperty('feature.maxDeviationMm')
    expect(result.features[0].evidence).not.toHaveProperty('feature.bands.0.maxDeviationMm')
  })

  it('retains region floor witnesses, clear corners, blend fit and query diagnostics', () => {
    const region: MeshRegionLike = { id: 'drafted-pocket-10', kind: 'drafted-pocket',
      floorNormal: [0, 0, 1], corners: [[0, 0, 0], [10, 0, 0], [10, 8, 0], [0, 8, 0]],
      clearCorners: [[1, 1, 0], [9, 1, 0], [9, 7, 0], [1, 7, 0]], wallDraftDeg: [-5, -5, -5, -5],
      lengthMm: 10, widthMm: 8, depthMm: 4, maxDeviationMm: 0.01,
      floorSourceFacetIds: [10, 11], sourceFacetIds: [10, 11, 12] }
    const blend: MeshBlendLike = { id: 'fillet-20', kind: 'fillet', shape: 'concave',
      radiusMm: 1, includedAngleDeg: 90, lengthMm: 10, maxDeviationMm: 0.02, tangencyErrorMm: 0.005,
      edgeLine: { ends: [[0, 0, 0], [10, 0, 0]] }, sourceFacetIds: [20, 21] }
    const refusals = [{ reason: 'nonplanar floor', facetCount: 2, sourceFacetIds: [30, 31] }]
    const result = recognisedFeatureList(frame, 'stl-mesh', () => fromMeshRecognition(
      { features: [], draftedPockets: [region], toleranceMm: 0.1, refusals }, [blend]))
    expect(result.features.find(f => f.type === 'draftedPocket')?.evidence).toMatchObject({
      kind: 'region', depthProvenance: 'fitted-mesh', feature: region, query: { toleranceMm: 0.1, refusals },
    })
    expect(result.features.find(f => f.type === 'fillet')?.evidence).toMatchObject({
      kind: 'blend', depthProvenance: 'unknown', feature: blend,
    })
  })

  it('still changes ids when shoulder, depth or dimensions change', () => {
    const id = modelList().features[0].id
    const changes: Record<string, number>[] = [{ counterboreDepth: 6 }, { depth: 21 }, { diameter: 7 }]
    for (const changed of changes) {
      expect(modelList({ ...model, params: { ...model.params, ...changed } }).features[0].id).not.toBe(id)
    }
    expect(meshList({ ...round, depthMm: 9, bands: [{ ...round.bands[0], axialRangeMm: [0, 9] }] }).features[0].id)
      .not.toBe(meshList().features[0].id)
  })

  it('keeps 2D depth parameter-only and preserves loop/layer provenance', () => {
    const loop = { id: 'loop-a', layerId: 'layer-a', type: 'hole', closed: true,
      points: [{ x: 0, y: 0 }, { x: 4, y: 0 }, { x: 4, y: 3 }, { x: 0, y: 3 }] }
    const result = recognisedFeatureList(frame, 'sketch-2d', () => fromLoops([loop]))
    expect(result.features[0].depth).toEqual({ evidence: 'from-parameters' })
    expect(result.features[0].evidence).toEqual({ source: 'sketch-2d', depthProvenance: 'operation-parameters', loop })
  })

  it('preserves scope on producer failure and remains backward compatible without scope', () => {
    const result = recognisedFeatureList(frame, 'model-kernel', () => { throw Error('stale body') }, scope)
    expect(result.scope).toEqual(scope)
    expect(result.features).toEqual([])
    expect(result.notes).toHaveLength(1)
    expect(recognisedFeatureList(frame, 'model-kernel', () => fromModelVerdicts([model])).scope).toBeUndefined()
  })
})
