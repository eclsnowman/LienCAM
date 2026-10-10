import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { buildStlModelBodyModel } from '../../components/model3d/workbench/stlModelBody'
import { planStlFeatureEdits, StlMeshEditCommand } from '../../components/model3d/workbench/stlFeatureEdits'
import { prepareEdgeBlend } from '../../mesh/recognition/edgeBlends'
import { facetNormal, facetPoints, vertexAt, weldMesh } from '../../mesh/recognition/topology'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import { createMeshEditRecord, resolveEditedStlMesh, type MeshEditRecord } from '../../mesh/edit'
import type { MeshBuffers } from '../../mesh/types'

const bytes = readFileSync('src/tests/mesh/fixtures/obj_1_Platte C.stl')
const body = buildStlModelBodyModel({ geoId: 'platte', name: 'obj_1_Platte C.stl', bytes, meshEdits: [] })
const feature = body.features.find(f => f.kind === 'chamfer' && f.label === '0.50 mm x 45 deg chamfer, 42.49 mm long')!
const prepared = prepareEdgeBlend(body.mesh, feature.facets)
const weld = (mesh: MeshBuffers): MeshBuffers => {
  const w = weldMesh(mesh)
  return { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
}
function removal() {
  const plan = planStlFeatureEdits(body, [{ tool: 'defeature', feature }])
  expect(plan.ok, !plan.ok ? plan.reason : '').toBe(true)
  if (!plan.ok) throw new Error(plan.reason)
  return plan
}

describe('WO-2083: Model Defeature on the real imported Platte C', () => {
  it('removes the 0.50 mm x 45 deg, 42.49 mm chamfer to a closed sharp edge', () => {
    expect(feature.sourceFacetIds).toEqual([1373, 1374])
    const plan = removal()
    const mesh = weld(plan.mesh)
    expect(analyzeMesh(mesh)).toMatchObject({
      watertight: true, selfIntersections: false, boundaryEdgeCount: 0,
      nonManifoldEdgeCount: 0, windingConflictEdgeCount: 0,
      degenerateTriangleCount: 0, duplicateTriangleCount: 0,
    })
    const before = measureMesh(weld(body.mesh))
    const after = measureMesh(mesh)
    expect(after.componentCount).toBe(before.componentCount)
    expect(after.signedVolume).toBeGreaterThan(before.signedVolume)
    const w = weldMesh(plan.mesh)
    // The sharp edge is shared by two perpendicular support facets; its ends
    // are the intersection of those planes and the existing end planes.
    const endIds = prepared.edgeLine.ends.map(end => {
      for (let id = 0; id < w.vertexCount; id++) {
        const p = vertexAt(w, id)
        if (Math.hypot(...p.map((v, k) => v - end[k])) < 1e-5) return id
      }
      throw new Error('sharp-edge endpoint missing')
    })
    const edge = w.edges.find(e => endIds.includes(e.a) && endIds.includes(e.b))!
    expect(edge).toBeDefined()
    expect(edge.facets).toHaveLength(2)
    const [a, b] = edge.facets.map(f => facetNormal(w, f))
    expect(Math.abs(a.reduce((sum, v, k) => sum + v * b[k], 0))).toBeLessThan(1e-4)
    console.log(`Platte C: ${body.facetCount} -> ${w.facetCount} facets; volume added ${(after.volume - before.volume).toFixed(6)} mm3; closed sharp edge`)
  })

  it('preserves every original non-chamfer triangle and extends only its four neighboring planes', () => {
    const plan = removal()
    const source = prepared.welded
    const result = weldMesh(plan.mesh)
    const signature = (points: number[][]) => JSON.stringify(points)
    const originals = new Set<number>()
    for (let f = 0; f < source.facetCount; f++) {
      if (feature.facets.includes(f)) continue
      const descendants = Array.from(plan.sourceFacetIds).flatMap((id, out) => id === f ? [out] : [])
      const unchanged = descendants.find(out => signature(facetPoints(result, out)) === signature(facetPoints(source, f)))
      expect(unchanged, `original facet ${f} is unchanged`).toBeDefined()
      originals.add(unchanged!)
    }
    const neighbors = new Set([...prepared.supports, ...prepared.ends].flatMap(face => face.facets))
    for (let f = 0; f < result.facetCount; f++) {
      expect(feature.sourceFacetIds).not.toContain(plan.sourceFacetIds[f])
      if (originals.has(f)) continue
      expect(neighbors.has(plan.sourceFacetIds[f])).toBe(true)
      const n = facetNormal(source, plan.sourceFacetIds[f])
      const anchor = facetPoints(source, plan.sourceFacetIds[f])[0]
      for (const p of facetPoints(result, f)) {
        expect(Math.abs(p.reduce((sum, v, k) => sum + n[k] * (v - anchor[k]), 0))).toBeLessThan(1e-5)
      }
    }
    // Planning is pure, including the corner shared by the third side face.
    expect(body.mesh).toEqual(resolveEditedStlMesh(bytes, []).mesh)
  })

  it('replays the preview through the journal and restores the original on Model Undo and Redo', async () => {
    const plan = removal()
    const edits = plan.edits.map(p => p.edit)
    let journal: MeshEditRecord[] = edits.map((edit, i) => createMeshEditRecord(body.mesh, { ...edit, id: `remove-${i}` }))
    const resolved = () => resolveEditedStlMesh(bytes, journal)
    expect(resolved().stopped).toBeUndefined()
    expect(resolved().mesh).toEqual(plan.mesh)
    const command = new StlMeshEditCommand({
      async addMeshEdit(_geoId, edit) {
        const record = createMeshEditRecord(resolved().mesh, { ...edit, id: 'redo-chamfer' })
        journal.push(record)
        return record
      },
      async removeMeshEdit(_geoId, id) { journal = journal.filter(record => record.id !== id) },
      fail(message) { throw new Error(message) },
    }, body.geoId, edits, journal)
    command.undo()
    await command.settled()
    expect(journal).toHaveLength(0)
    expect(resolved().mesh).toEqual(body.mesh)
    command.do()
    await command.settled()
    expect(resolved().stopped).toBeUndefined()
    expect(resolved().mesh).toEqual(plan.mesh)
  })
})
