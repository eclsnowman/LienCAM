import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildStlModelBodyModel } from '../../components/model3d/workbench/stlModelBody'
import { planStlFeatureEdits, stlToolAccepts } from '../../components/model3d/workbench/stlFeatureEdits'
import { createMeshEditRecord } from '../../mesh/edit'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import { recognizeEdgeBlends } from '../../mesh/recognition'
import { weldMesh } from '../../mesh/recognition/topology'
import type { MeshBuffers } from '../../mesh/types'

const bytes = readFileSync(resolve(__dirname, '../fixtures/WO-2081/export-fix-block-pocket.stl'))
const model = () => buildStlModelBodyModel({ geoId: 'pocket', name: 'Pocket', bytes, meshEdits: undefined })

function closedVolume(mesh: MeshBuffers): number {
  const w = weldMesh(mesh)
  const welded = { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
  const health = analyzeMesh(welded, { checkSelfIntersections: false })
  expect(health.watertight).toBe(true)
  expect(health.nonManifoldEdgeCount).toBe(0)
  expect(health.windingConflictEdgeCount).toBe(0)
  const volume = measureMesh(welded).signedVolume
  expect(volume).toBeGreaterThan(0)
  return volume
}

describe('WO-2081: imported pocket corner fillets', () => {
  it('lists all four complete corner bands in the Model screen', () => {
    const body = model()
    const fillets = body.features.filter((f) => f.kind === 'fillet')
    expect(fillets).toHaveLength(4)
    expect(recognizeEdgeBlends(body.mesh, body.sourceFacetIds).blends).toHaveLength(4)
    for (const f of fillets) {
      expect(f.sourceFacetIds).toHaveLength(18)
      expect(f.facets).toHaveLength(18)
      expect(f.target.family).toBe('blend')
      if (f.target.family !== 'blend') throw new Error('Expected blend target')
      expect(f.target.blend.shape).toBe('concave')
      expect(f.target.blend.radiusMm).toBeCloseTo(6, 4)
      expect(f.target.blend.lengthMm).toBeCloseTo(8, 4)
      expect(f.target.blend.includedAngleDeg).toBeCloseTo(90, 4)
      expect(stlToolAccepts('fillet', f)).toBe(true)
      expect(stlToolAccepts('defeature', f)).toBe(true)
      for (const facet of f.facets) expect(body.features[body.featureOfFacet[facet]].id).toBe(f.id)
    }
  })

  it.each([0, 1, 2, 3])('changes corner %i to 3 mm through the Model tool and journal', (index) => {
    const body = model()
    const feature = body.features.filter((f) => f.kind === 'fillet')[index]
    expect(feature).toBeDefined()
    const plan = planStlFeatureEdits(body, [{ tool: 'fillet', feature, radiusMm: 3 }])
    expect(plan.ok, JSON.stringify(plan)).toBe(true)
    if (!plan.ok) throw new Error(plan.reason)
    expect(plan.edits).toHaveLength(1)
    const record = createMeshEditRecord(body.mesh, { ...plan.edits[0].edit, sourceFacetIds: body.sourceFacetIds })
    const after = buildStlModelBodyModel({ geoId: 'pocket', name: 'Pocket', bytes, meshEdits: [record] })
    expect(after.stopped).toBeUndefined()
    expect(after.mesh.positions).toEqual(plan.mesh.positions)
    expect(after.mesh.indices).toEqual(plan.mesh.indices)
    const blends = recognizeEdgeBlends(after.mesh, after.sourceFacetIds).blends
    expect(blends).toHaveLength(4)
    for (const blend of blends) expect(blend.radiusMm).toBeCloseTo(blend.id === feature.id ? 3 : 6, 4)
    expect(blends.find((b) => b.id === feature.id)).toBeDefined()
    expect(closedVolume(after.mesh)).toBeLessThan(closedVolume(body.mesh))
  })

  it.each([0, 1, 2, 3])('removes corner %i through Defeature and journal', (index) => {
    const body = model()
    const feature = body.features.filter((f) => f.kind === 'fillet')[index]
    expect(feature).toBeDefined()
    const plan = planStlFeatureEdits(body, [{ tool: 'defeature', feature }])
    expect(plan.ok, JSON.stringify(plan)).toBe(true)
    if (!plan.ok) throw new Error(plan.reason)
    const record = createMeshEditRecord(body.mesh, { ...plan.edits[0].edit, sourceFacetIds: body.sourceFacetIds })
    const after = buildStlModelBodyModel({ geoId: 'pocket', name: 'Pocket', bytes, meshEdits: [record] })
    expect(after.stopped).toBeUndefined()
    expect(after.mesh.positions).toEqual(plan.mesh.positions)
    const blends = recognizeEdgeBlends(after.mesh, after.sourceFacetIds).blends
    expect(blends).toHaveLength(3)
    expect(blends.some((b) => b.id === feature.id)).toBe(false)
    for (const blend of blends) expect(blend.radiusMm).toBeCloseTo(6, 4)
    expect(closedVolume(after.mesh)).toBeLessThan(closedVolume(body.mesh))
  })
})
