// WO-2082: the Model screen's STL Push/Pull carries the chamfers that border
// the picked face instead of trying to hold every triangle of a chamfer ring
// on its old plane. This is Operator's actual imported part and the production
// planning entry used by the tool, not a hand-built mesh sent to the kernel.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { buildStlModelBodyModel, type StlModelFeature } from '../../components/model3d/workbench/stlModelBody'
import { planStlFeatureEdits } from '../../components/model3d/workbench/stlFeatureEdits'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import { createMeshEditRecord } from '../../mesh/edit'
import { recognizeEdgeBlends, recognizeMeshFeatures } from '../../mesh/recognition'
import { weldMesh } from '../../mesh/recognition/topology'
import type { MeshBuffers, Vec3 } from '../../mesh/types'

const fixtureUrl = new URL('./fixtures/obj_1_Platte C.stl', import.meta.url)
const fixtureBytes = readFileSync(fixtureUrl)

function welded(mesh: MeshBuffers): MeshBuffers {
  const w = weldMesh(mesh)
  return { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
}

function health(mesh: MeshBuffers) {
  return analyzeMesh(welded(mesh), { checkSelfIntersections: true })
}

function cornersOfSourceFacets(
  mesh: MeshBuffers,
  sourceFacetIds: Uint32Array,
  wantedSourceIds: readonly number[],
): Vec3[] {
  const wanted = new Set(wantedSourceIds)
  const out: Vec3[] = []
  sourceFacetIds.forEach((sourceId, facet) => {
    if (!wanted.has(sourceId)) return
    for (let corner = 0; corner < 3; corner++) {
      const at = mesh.indices[facet * 3 + corner] * 3
      out.push([mesh.positions[at], mesh.positions[at + 1], mesh.positions[at + 2]])
    }
  })
  return out
}

function topFace(features: readonly StlModelFeature[]): StlModelFeature {
  const found = features
    .filter((feature) => feature.target.family === 'flat' && feature.target.face.plane.normal[2] > 0.999)
    .sort((a, b) => {
      const faceA = a.target.family === 'flat' ? a.target.face : null
      const faceB = b.target.family === 'flat' ? b.target.face : null
      return (faceB?.plane.point[2] ?? -Infinity) - (faceA?.plane.point[2] ?? -Infinity)
    })[0]
  if (!found) throw new Error('the named fixture no longer has its upward top face')
  return found
}

function expectSameMeasurements(after: readonly number[], before: readonly number[]): void {
  expect(after).toHaveLength(before.length)
  after.forEach((value, index) => expect(value).toBeCloseTo(before[index], 9))
}

function expectSourceFacetsMovedBy(
  before: { mesh: MeshBuffers; sourceFacetIds: Uint32Array },
  after: { mesh: MeshBuffers; sourceFacetIds: Uint32Array },
  sourceFacetIds: readonly number[],
  distanceMm: number,
): void {
  const oldCorners = cornersOfSourceFacets(before.mesh, before.sourceFacetIds, sourceFacetIds)
  const newCorners = cornersOfSourceFacets(after.mesh, after.sourceFacetIds, sourceFacetIds)
  expect(newCorners).toHaveLength(oldCorners.length)
  newCorners.forEach((point, index) => {
    expect(point[0]).toBeCloseTo(oldCorners[index][0], 5)
    expect(point[1]).toBeCloseTo(oldCorners[index][1], 5)
    expect(point[2] - oldCorners[index][2]).toBeCloseTo(distanceMm, 5)
  })
}

describe('WO-2082: STL Push/Pull beside chamfers', () => {
  const before = buildStlModelBodyModel({
    geoId: 'wo-2082-platte',
    name: 'obj_1_Platte C.stl',
    bytes: fixtureBytes,
    meshEdits: [],
  })
  const top = topFace(before.features)
  const plan = planStlFeatureEdits(
    { mesh: before.mesh, sourceFacetIds: before.sourceFacetIds, roundFeatures: before.roundFeatures },
    [{ tool: 'push-pull', feature: top, distanceMm: 2 }],
  )

  const successfulPlan = () => {
    if (!plan.ok) throw new Error(plan.reason)
    return plan
  }

  it('pulls the named imported top face +2 mm through the Model tool production entry', () => {
    const moved = successfulPlan()
    expect(moved.edits).toHaveLength(1)

    const oldTop = cornersOfSourceFacets(before.mesh, before.sourceFacetIds, top.sourceFacetIds)
    const newTop = cornersOfSourceFacets(moved.mesh, moved.sourceFacetIds, top.sourceFacetIds)
    expect(oldTop.length).toBeGreaterThan(0)
    expect(newTop).toHaveLength(oldTop.length)
    expect(Math.min(...newTop.map((point) => point[2])) - Math.min(...oldTop.map((point) => point[2])))
      .toBeCloseTo(2, 5)
  })

  it('keeps the chamfers and chamfered holes their own size, and leaves a closed solid', () => {
    const moved = successfulPlan()

    const beforeBlends = recognizeEdgeBlends(before.mesh, before.sourceFacetIds).blends
      .filter((blend) => blend.kind === 'chamfer')
    const afterBlends = recognizeEdgeBlends(moved.mesh, moved.sourceFacetIds).blends
      .filter((blend) => blend.kind === 'chamfer')
    expect(afterBlends).toHaveLength(beforeBlends.length)
    afterBlends.forEach((blend, index) => {
      expectSameMeasurements(blend.setbackMm ?? [], beforeBlends[index].setbackMm ?? [])
    })

    const topZ = Math.max(...cornersOfSourceFacets(before.mesh, before.sourceFacetIds, top.sourceFacetIds)
      .map((point) => point[2]))
    const topChamfers = beforeBlends.filter((blend) => Math.max(
      ...cornersOfSourceFacets(before.mesh, before.sourceFacetIds, blend.sourceFacetIds).map((point) => point[2]),
    ) > topZ - 0.1)
    expect(topChamfers.length).toBeGreaterThan(0)
    topChamfers.forEach((blend) => expectSourceFacetsMovedBy(before, moved, blend.sourceFacetIds, 2))

    const beforeHoles = recognizeMeshFeatures(before.mesh, before.sourceFacetIds).features
      .filter((feature) => feature.kind === 'chamfered-hole')
    const afterHoles = recognizeMeshFeatures(moved.mesh, moved.sourceFacetIds).features
      .filter((feature) => feature.kind === 'chamfered-hole')
    expect(beforeHoles.length).toBeGreaterThan(0)
    expect(afterHoles).toHaveLength(beforeHoles.length)
    afterHoles.forEach((hole, index) => {
      expectSameMeasurements(hole.diametersMm, beforeHoles[index].diametersMm)
      expect(hole.depthMm - beforeHoles[index].depthMm).toBeCloseTo(2, 5)
    })
    for (const hole of beforeHoles) {
      const topCone = hole.bands.find((band) => band.surface === 'cone' && Math.max(
        ...cornersOfSourceFacets(before.mesh, before.sourceFacetIds, band.sourceFacetIds).map((point) => point[2]),
      ) > topZ - 0.1)
      expect(topCone).toBeDefined()
      expectSourceFacetsMovedBy(before, moved, topCone!.sourceFacetIds, 2)
    }

    const beforeHealth = health(before.mesh)
    const afterHealth = health(moved.mesh)
    expect(beforeHealth.watertight).toBe(true)
    expect(afterHealth.watertight).toBe(true)
    expect(afterHealth.nonManifoldEdgeCount).toBe(0)
    expect(afterHealth.windingConflictEdgeCount).toBe(0)
    expect(afterHealth.selfIntersections).toBe(false)
    expect(measureMesh(welded(moved.mesh)).signedVolume).toBeGreaterThan(0)
  })

  it('Undo restores the original imported mesh when the journal entry is absent', () => {
    const moved = successfulPlan()
    const edit = moved.edits[0].edit
    const record = createMeshEditRecord(before.mesh, {
      ...edit,
      sourceFacetIds: before.sourceFacetIds,
    })
    const applied = buildStlModelBodyModel({
      geoId: 'wo-2082-platte',
      name: 'obj_1_Platte C.stl',
      bytes: fixtureBytes,
      meshEdits: [record],
    })
    const restored = buildStlModelBodyModel({
      geoId: 'wo-2082-platte',
      name: 'obj_1_Platte C.stl',
      bytes: fixtureBytes,
      meshEdits: [],
    })
    expect(applied.mesh.positions).not.toEqual(before.mesh.positions)
    expect(restored.mesh.positions).toEqual(before.mesh.positions)
    expect(restored.mesh.indices).toEqual(before.mesh.indices)
  })
})
