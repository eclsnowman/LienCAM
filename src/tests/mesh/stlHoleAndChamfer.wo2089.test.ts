// WO-2089: the Model screen's Hole and Chamfer on an STL body.
//
// Operator's own imported part (Sample Parts/obj_1_Platte C.stl, the fixture copy)
// through the planning entries the Model screen's tools call -
// `stlHoleShape` / `findStlSharpEdge` + `stlChamferShape`, then
// `planStlShapeEdit` - and the resolver every route replays a journal with
// (`buildStlModelBodyModel` over `resolveEditedStlMesh`). Nothing here hands
// the kernel a hand-built payload: the edits are the ones the tools record.

import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildStlModelBodyModel } from '../../components/model3d/workbench/stlModelBody'
import {
  findStlSharpEdge,
  planStlShapeEdit,
  stlChamferShape,
  stlHoleShape,
  type StlHoleRequest,
} from '../../components/model3d/workbench/stlFeatureEdits'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import {
  BOOLEAN_BODY_KIND,
  booleanBodyOperation,
  createMeshEditRecord,
  describeMeshEdit,
  primeBoringKernel,
} from '../../mesh/edit'
import { recognizeMeshFeatures } from '../../mesh/recognition'
import { weldMesh } from '../../mesh/recognition/topology'
import type { MeshBuffers } from '../../mesh/types'

const fixtureBytes = readFileSync(new URL('./fixtures/obj_1_Platte C.stl', import.meta.url))
const NAME = 'obj_1_Platte C.stl'

function welded(mesh: MeshBuffers): MeshBuffers {
  const w = weldMesh(mesh)
  return { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
}
function volume(mesh: MeshBuffers): number {
  return measureMesh(welded(mesh)).signedVolume
}
function expectClosedSolid(mesh: MeshBuffers): void {
  const health = analyzeMesh(welded(mesh), { checkSelfIntersections: true })
  expect(health.watertight).toBe(true)
  expect(health.nonManifoldEdgeCount).toBe(0)
  expect(health.windingConflictEdgeCount).toBe(0)
  expect(health.selfIntersections).toBe(false)
  expect(measureMesh(welded(mesh)).componentCount).toBe(1)
}

const part = () => buildStlModelBodyModel({ geoId: 'wo-2089-platte', name: NAME, bytes: fixtureBytes, meshEdits: [] })

/** A spot on Platte C's top face (Z 4) clear of its five holes. */
const CLEAR_TOP = { x: 140, y: 120, z: 4 }
const UP = { x: 0, y: 0, z: 1 }

function hole(overrides: Partial<StlHoleRequest> = {}): StlHoleRequest {
  return { points: [CLEAR_TOP], normal: UP, style: { kind: 'simple', diameter: 6 }, depth: { kind: 'throughAll' }, ...overrides }
}

function planned(mesh: MeshBuffers, shape: ReturnType<typeof stlHoleShape>) {
  const plan = planStlShapeEdit(mesh, shape)
  if (!plan.ok) throw new Error(plan.reason)
  return plan
}

beforeAll(async () => { await primeBoringKernel() })

describe('WO-2089: Hole on Platte C', () => {
  it('drills a 6 mm through hole: one boolean-body entry, more facets, a closed solid, and it reads back as a 6 mm through hole', () => {
    const before = part()
    const shape = stlHoleShape(before.mesh, hole())
    // Through: the depth that reaches right through the 4 mm plate, plus 1 mm.
    expect(shape).toMatchObject({ operation: 'subtract', shape: 'hole', lengthMm: 5, through: true, diameterMm: 6 })
    const plan = planned(before.mesh, shape)
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0].edit.kind).toBe(BOOLEAN_BODY_KIND)
    expect(plan.mesh.indices.length / 3).toBeGreaterThan(before.facetCount)
    expectClosedSolid(plan.mesh)
    // Material removed is a 6 mm x 4 mm cylinder (a prism with corners on
    // the circle, so a hair under pi r^2 h).
    const removed = volume(before.mesh) - volume(plan.mesh)
    expect(removed).toBeGreaterThan(Math.PI * 9 * 4 * 0.99)
    expect(removed).toBeLessThan(Math.PI * 9 * 4)

    const found = recognizeMeshFeatures(plan.mesh).features.filter((f) => f.kind !== 'chamfered-hole')
    expect(found).toHaveLength(1)
    expect(found[0].kind).toBe('through-hole')
    expect(found[0].diameterMm).toBeCloseTo(6, 2)
    expect(found[0].depthMm).toBeCloseTo(4, 4)
    expect(found[0].axis.origin[0]).toBeCloseTo(140, 3)
    expect(found[0].axis.origin[1]).toBeCloseTo(120, 3)
    // The part's own five chamfered holes are untouched.
    expect(recognizeMeshFeatures(plan.mesh).features.filter((f) => f.kind === 'chamfered-hole')).toHaveLength(5)
  })

  it('drills blind, counterbored and countersunk holes that read back as what was asked', () => {
    const before = part()
    const blind = planned(before.mesh, stlHoleShape(before.mesh, hole({ depth: { kind: 'blind', distance: 3 } })))
    expectClosedSolid(blind.mesh)
    const blindFound = recognizeMeshFeatures(blind.mesh).features.filter((f) => f.kind !== 'chamfered-hole')
    expect(blindFound.map((f) => f.kind)).toEqual(['blind-hole'])
    expect(blindFound[0].diameterMm).toBeCloseTo(6, 2)
    expect(blindFound[0].depthMm).toBeCloseTo(3, 4)

    const cb = planned(before.mesh, stlHoleShape(before.mesh, hole({
      style: { kind: 'counterbore', diameter: 5, cbDiameter: 9, cbDepth: 2 },
    })))
    expectClosedSolid(cb.mesh)
    const cbFound = recognizeMeshFeatures(cb.mesh).features.filter((f) => f.kind !== 'chamfered-hole')
    expect(cbFound.map((f) => f.kind)).toEqual(['counterbore'])
    expect(cbFound[0].diametersMm[0]).toBeCloseTo(5, 2)
    expect(Math.max(...cbFound[0].diametersMm)).toBeCloseTo(9, 2)

    const cs = planned(before.mesh, stlHoleShape(before.mesh, hole({
      style: { kind: 'countersink', diameter: 5, csDiameter: 9, csAngleDeg: 90 },
    })))
    expectClosedSolid(cs.mesh)
    const csFound = recognizeMeshFeatures(cs.mesh).features.filter((f) => f.kind !== 'chamfered-hole')
    expect(csFound.map((f) => f.kind)).toEqual(['countersink'])
    expect(csFound[0].diameterMm).toBeCloseTo(5, 2)
    expect(Math.max(...csFound[0].diametersMm)).toBeCloseTo(9, 1)
  })

  it('a linear pattern of three is ONE entry that drills three holes', () => {
    const before = part()
    const points = [{ x: 136, y: 118, z: 4 }, { x: 142, y: 118, z: 4 }, { x: 148, y: 118, z: 4 }].map((p) => ({ ...p, x: p.x - 4 }))
    const plan = planned(before.mesh, stlHoleShape(before.mesh, hole({ points, style: { kind: 'simple', diameter: 3 } })))
    expect(plan.edits).toHaveLength(1)
    expectClosedSolid(plan.mesh)
    const found = recognizeMeshFeatures(plan.mesh).features.filter((f) => f.kind !== 'chamfered-hole')
    expect(found.map((f) => f.kind)).toEqual(['through-hole', 'through-hole', 'through-hole'])
    expect(describeMeshEdit(createMeshEditRecord(before.mesh, { ...plan.edits[0].edit, id: 'x', sourceFacetIds: before.sourceFacetIds })))
      .toBe('Drilled 3 x 3.00 mm holes, through at 132.00, 118.00, 4.00')
  })

  it('replays from the journal to the same part, says what it did, and Undo (the entry gone) restores the import', () => {
    const before = part()
    const plan = planned(before.mesh, stlHoleShape(before.mesh, hole()))
    const record = createMeshEditRecord(before.mesh, { ...plan.edits[0].edit, id: 'wo2089-hole', sourceFacetIds: before.sourceFacetIds })
    expect(describeMeshEdit(record)).toBe('Drilled a 6.00 mm hole, through at 140.00, 120.00, 4.00')
    const applied = buildStlModelBodyModel({ geoId: 'wo-2089-platte', name: NAME, bytes: fixtureBytes, meshEdits: [record] })
    expect(applied.stopped).toBeUndefined()
    expect(applied.mesh.positions).toEqual(plan.mesh.positions)
    expect(applied.mesh.indices).toEqual(plan.mesh.indices)
    // The Model screen's rebuilt body recognises the new hole.
    expect(applied.roundFeatures.some((f) => f.kind === 'through-hole' && Math.abs(f.diameterMm - 6) < 0.01)).toBe(true)
    const restored = buildStlModelBodyModel({ geoId: 'wo-2089-platte', name: NAME, bytes: fixtureBytes, meshEdits: [] })
    expect(restored.mesh.positions).toEqual(before.mesh.positions)
    expect(restored.mesh.indices).toEqual(before.mesh.indices)
  })
})

describe('WO-2089: Chamfer on Platte C', () => {
  // The top face's +X rim: the sharp edge between the top (Z 4) and the
  // part's own 0.5 mm edge chamfer, x = 157.5.
  const RIM = { x: 157.5, y: 148, z: 4 }

  it('a click beside the rim picks the whole straight edge between the two faces', () => {
    const before = part()
    const edge = findStlSharpEdge(before.mesh, { x: 157.45, y: 148, z: 4 }, 0.25)
    expect(edge).not.toBeNull()
    expect(edge!.operation).toBe('subtract')
    expect(edge!.start[0]).toBeCloseTo(157.5, 5)
    expect(edge!.end[0]).toBeCloseTo(157.5, 5)
    expect(edge!.start[2]).toBeCloseTo(4, 5)
    expect(edge!.end[2]).toBeCloseTo(4, 5)
    expect(edge!.lengthMm).toBeGreaterThan(19)
    // Nothing that far from any edge is picked.
    expect(findStlSharpEdge(before.mesh, CLEAR_TOP, 0.25)).toBeNull()
  })

  it('cuts a 0.3 mm chamfer on it: one boolean-body entry, a closed solid, the corner gone and a new flat between the faces', () => {
    const before = part()
    const edge = findStlSharpEdge(before.mesh, RIM, 0.25)!
    const shape = stlChamferShape([edge], 0.3)
    expect(() => booleanBodyOperation.validate(shape as unknown as Record<string, unknown>)).not.toThrow()
    const plan = planned(before.mesh, shape)
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0].edit.kind).toBe(BOOLEAN_BODY_KIND)
    expectClosedSolid(plan.mesh)
    // The corner between faces meeting at 135 degrees, 0.3 mm back on each:
    // a triangle of 0.5 d^2 sin(135) along the edge.
    const expected = 0.5 * 0.3 * 0.3 * Math.sin((135 * Math.PI) / 180) * edge.lengthMm
    const removed = volume(before.mesh) - volume(plan.mesh)
    expect(removed).toBeGreaterThan(expected * 0.9)
    expect(removed).toBeLessThan(expected * 1.1)
    // The new flat: halfway between the top's normal and the old chamfer's
    // (22.5 degrees off the top, facing +X), as wide as the chamfer's two
    // 0.3 mm setbacks make it (0.3 |t1 - t2|), the length of the edge.
    const t1 = edge.faceDirections[0]
    const t2 = edge.faceDirections[1]
    const width = 0.3 * Math.hypot(t1[0] - t2[0], t1[1] - t2[1], t1[2] - t2[2])
    const w = weldMesh(plan.mesh)
    const tilt = (22.5 * Math.PI) / 180
    let area = 0
    for (let f = 0; f < w.facetCount; f++) {
      const n = [w.normals[f * 3], w.normals[f * 3 + 1], w.normals[f * 3 + 2]]
      if (Math.abs(n[0] - Math.sin(tilt)) < 1e-3 && Math.abs(n[1]) < 1e-3 && Math.abs(n[2] - Math.cos(tilt)) < 1e-3) area += w.areas[f]
    }
    expect(area).toBeGreaterThan(width * edge.lengthMm * 0.97)
    expect(area).toBeLessThan(width * edge.lengthMm * 1.03)
    // The part had no such face before.
    const old = weldMesh(before.mesh)
    for (let f = 0; f < old.facetCount; f++) expect(Math.abs(old.normals[f * 3 + 2] - Math.cos(tilt)) < 1e-3).toBe(false)
  })

  it('an inside corner is filled, not cut: a block added on the top, then its base edge chamfered', () => {
    const before = part()
    const withBlock = planStlShapeEdit(before.mesh, {
      operation: 'add', shape: 'box', center: [140, 120, 6], size: [10, 10, 4],
    })
    if (!withBlock.ok) throw new Error(withBlock.reason)
    const edge = findStlSharpEdge(withBlock.mesh, { x: 145, y: 120, z: 4 }, 0.25)
    expect(edge).not.toBeNull()
    expect(edge!.operation).toBe('add')
    const plan = planned(withBlock.mesh, stlChamferShape([edge!], 1))
    expectClosedSolid(plan.mesh)
    // A 1 mm x 1 mm right triangle along the 10 mm edge is added.
    const added = volume(plan.mesh) - volume(withBlock.mesh)
    expect(added).toBeGreaterThan(0.5 * 10 * 0.95)
    expect(added).toBeLessThan(0.5 * 10 * 1.05)
  })

  it('replays from the journal, says what it did, and Undo restores the import', () => {
    const before = part()
    const plan = planned(before.mesh, stlChamferShape([findStlSharpEdge(before.mesh, RIM, 0.25)!], 0.3))
    const record = createMeshEditRecord(before.mesh, { ...plan.edits[0].edit, id: 'wo2089-chamfer', sourceFacetIds: before.sourceFacetIds })
    expect(describeMeshEdit(record)).toMatch(/^Chamfered 1 edge 0\.30 mm at 157\.50, /)
    const applied = buildStlModelBodyModel({ geoId: 'wo-2089-platte', name: NAME, bytes: fixtureBytes, meshEdits: [record] })
    expect(applied.stopped).toBeUndefined()
    expect(applied.mesh.indices).toEqual(plan.mesh.indices)
    const restored = buildStlModelBodyModel({ geoId: 'wo-2089-platte', name: NAME, bytes: fixtureBytes, meshEdits: [] })
    expect(restored.mesh.positions).toEqual(before.mesh.positions)
  })
})
