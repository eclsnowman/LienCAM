// WO-2090: the Model screen's Shell and Draft on an STL body.
//
// The app's own STL export of test_fixtures/brep/fix_plate_holes.step (a
// 100 x 60 x 10 mm plate with six through holes; copy kept with this order's
// evidence) through the planning entries the Model screen's tools call -
// `stlShellShape` / `stlDraftShape`, then `planStlShapeEdit` - and the
// resolver every route replays a journal with (`buildStlModelBodyModel` over
// `resolveEditedStlMesh`). Nothing here hands the kernel a hand-built payload:
// the edits are the ones the tools record.

import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildStlModelBodyModel, type StlModelBodyModel } from '../../components/model3d/workbench/stlModelBody'
import {
  planStlShapeEdit,
  stlDraftShape,
  stlFaceRef,
  stlShellShape,
} from '../../components/model3d/workbench/stlFeatureEdits'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import {
  BOOLEAN_BODY_KIND,
  createMeshEditRecord,
  describeMeshEdit,
  primeBoringKernel,
} from '../../mesh/edit'
import { recognizeMeshFeatures } from '../../mesh/recognition'
import { weldMesh } from '../../mesh/recognition/topology'
import type { MeshBuffers } from '../../mesh/types'

const fixtureBytes = readFileSync(new URL('../evidence/WO-2090/export-fix-plate-holes.stl', import.meta.url))
const NAME = 'export-fix-plate-holes.stl'
const W = 100
const H = 60
const D = 10

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
function bounds(mesh: MeshBuffers): { min: number[]; max: number[] } {
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < mesh.positions.length; i += 3) {
    for (let a = 0; a < 3; a++) {
      min[a] = Math.min(min[a], mesh.positions[i + a])
      max[a] = Math.max(max[a], mesh.positions[i + a])
    }
  }
  return { min, max }
}
/** Corners of `mesh` lying on the plane x = `x` (to float32). */
function cornersAtX(mesh: MeshBuffers, x: number): number[][] {
  const out: number[][] = []
  for (let i = 0; i < mesh.positions.length; i += 3) {
    if (Math.abs(mesh.positions[i] - x) < 1e-4) out.push([mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]])
  }
  return out
}

const part = () => buildStlModelBodyModel({ geoId: 'wo-2090-plate', name: NAME, bytes: fixtureBytes, meshEdits: [] })

/** The flat face whose outward normal is `normal` and whose plane passes
 *  through `at` along it - as the Model screen offers it on a click. */
function flatFace(model: StlModelBodyModel, normal: [number, number, number], at: number) {
  const face = model.features.find((f) => {
    if (f.target.family !== 'flat') return false
    // (the recogniser's plane point is in its own recentred frame; the
    // recorded point is on the part as it stands)
    const { point, normal: n } = stlFaceRef(model, f)
    if (n[0] * normal[0] + n[1] * normal[1] + n[2] * normal[2] < 0.9999) return false
    return Math.abs(point[0] * normal[0] + point[1] * normal[1] + point[2] * normal[2] - at) < 1e-3
  })
  if (face === undefined) throw new Error(`no flat face ${normal.join(',')} @ ${at}`)
  return face
}

function planned(mesh: MeshBuffers, shape: Parameters<typeof planStlShapeEdit>[1]) {
  const plan = planStlShapeEdit(mesh, shape)
  if (!plan.ok) throw new Error(plan.reason)
  return plan
}

beforeAll(async () => { await primeBoringKernel() })

describe('WO-2090: Shell on the plate', () => {
  it('shells to a 2 mm wall opening the top face: one entry, a closed solid, the volume a 2 mm shell leaves', () => {
    const before = part()
    const top = flatFace(before, [0, 0, 1], D)
    const shape = stlShellShape(before, [top], 2)
    expect(shape).toMatchObject({ operation: 'subtract', shape: 'shell', thicknessMm: 2 })
    const plan = planned(before.mesh, shape)
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0].edit.kind).toBe(BOOLEAN_BODY_KIND)
    // The selection is the top face itself.
    const topFacets = before.mesh.indices.length / 3
    expect(plan.edits[0].edit.facets.length).toBe(top.target.family === 'flat' ? top.target.face.facetCount : -1)
    expect(plan.edits[0].edit.facets.length).toBeLessThan(topFacets)
    expectClosedSolid(plan.mesh)

    // What the cut took: the inside within the part - the plate shrunk 2 mm
    // on every side and off the bottom (8 mm tall up to the open top), less a
    // tube round each hole 2 mm wider than its bore. Each bore is a 36-sided
    // prism with its corners on the circle; moving every side out 2 mm puts
    // the corners at (r cos 5 deg + 2) / cos 5 deg.
    const holes = recognizeMeshFeatures(before.mesh).features.filter((f) => f.kind === 'through-hole')
    expect(holes).toHaveLength(6)
    const prismArea = (r: number) => 18 * r * r * Math.sin((2 * Math.PI) / 36)
    const c5 = Math.cos(Math.PI / 36)
    const tubes = holes.reduce((sum, h) => sum + prismArea((h.diameterMm / 2 * c5 + 2) / c5), 0)
    const inside = ((W - 4) * (H - 4) - tubes) * (D - 2)
    const removed = volume(before.mesh) - volume(plan.mesh)
    expect(Math.abs(removed - inside) / inside).toBeLessThan(1e-4)
    // The bounding box is still the part's.
    const box = bounds(plan.mesh)
    expect(box.min).toEqual([0, 0, 0])
    expect(box.max).toEqual([W, H, D])
  })
})

describe('WO-2090: Shell replays and undoes', () => {
  it('replays from the journal to the same part, says what it did, and Undo (the entry gone) restores the import', () => {
    const before = part()
    const plan = planned(before.mesh, stlShellShape(before, [flatFace(before, [0, 0, 1], D)], 2))
    const record = createMeshEditRecord(before.mesh, { ...plan.edits[0].edit, id: 'wo2090-shell', sourceFacetIds: before.sourceFacetIds })
    expect(describeMeshEdit(record)).toMatch(/^Shelled to a 2\.00 mm wall, 1 face open at /)
    // Plain JSON: it survives a project save.
    const saved = JSON.parse(JSON.stringify(record))
    const applied = buildStlModelBodyModel({ geoId: 'wo-2090-plate', name: NAME, bytes: fixtureBytes, meshEdits: [saved] })
    expect(applied.stopped).toBeUndefined()
    expect(applied.mesh.positions).toEqual(plan.mesh.positions)
    expect(applied.mesh.indices).toEqual(plan.mesh.indices)
    const restored = buildStlModelBodyModel({ geoId: 'wo-2090-plate', name: NAME, bytes: fixtureBytes, meshEdits: [] })
    expect(restored.mesh.positions).toEqual(before.mesh.positions)
    expect(restored.mesh.indices).toEqual(before.mesh.indices)
  })

  it('opens two faces at once (top and +X side): one entry, still one closed solid', () => {
    const before = part()
    const plan = planned(before.mesh, stlShellShape(before, [flatFace(before, [0, 0, 1], D), flatFace(before, [1, 0, 0], W)], 2))
    expect(plan.edits).toHaveLength(1)
    expectClosedSolid(plan.mesh)
    expect(volume(plan.mesh)).toBeLessThan(volume(before.mesh))
  })
})

describe('WO-2090: Draft on the plate', () => {
  const sideX = (model: StlModelBodyModel) => flatFace(model, [1, 0, 0], W)
  const t3 = Math.tan((3 * Math.PI) / 180)

  it('drafts the +X side 3 deg about the bottom (the neutral face): one entry, a closed solid, the side turned 3 deg', () => {
    const before = part()
    // The Draft dialog's pull, with the bottom as the neutral face: its own
    // normal (0, 0, -1), the neutral plane through it.
    const shape = stlDraftShape(before, [sideX(before)], {
      angleDeg: 3,
      pullDirection: { x: 0, y: 0, z: -1 },
      neutralPoint: { x: 50, y: 30, z: 0 },
    })
    expect(shape).toMatchObject({ operation: 'subtract', shape: 'draft', angleDeg: 3, pullDirection: [0, 0, -1], neutralPoint: [50, 30, 0] })
    const plan = planned(before.mesh, shape)
    expect(plan.edits).toHaveLength(1)
    expect(plan.edits[0].edit.kind).toBe(BOOLEAN_BODY_KIND)
    expectClosedSolid(plan.mesh)
    // Every facet is still there (only corners moved).
    expect(plan.mesh.indices.length).toBe(before.mesh.indices.length)

    // The side stays where it meets the neutral plane (x = 100 at z = 0) and
    // leans out 10 tan 3 deg at the top - the kernel's convention: the part
    // grows against the pull, away from the neutral face.
    const box = bounds(plan.mesh)
    expect(box.max[0]).toBeCloseTo(W + D * t3, 4)
    const onSideBottom = cornersAtX(plan.mesh, W).filter((c) => Math.abs(c[2]) < 1e-6)
    expect(onSideBottom.length).toBeGreaterThan(0)
    // The added wedge: 60 mm long, 10 mm tall, 10 tan 3 deg at the top.
    const added = volume(plan.mesh) - volume(before.mesh)
    expect(added).toBeCloseTo((H * D * D * t3) / 2, 2)
    // The side reads back as one flat face turned 3 deg from the pull.
    const after = buildStlModelBodyModel({
      geoId: 'wo-2090-plate', name: NAME, bytes: fixtureBytes,
      meshEdits: [createMeshEditRecord(before.mesh, { ...plan.edits[0].edit, id: 'wo2090-draft', sourceFacetIds: before.sourceFacetIds })],
    })
    expect(after.stopped).toBeUndefined()
    const drafted = after.features.find((f) => f.target.family === 'flat' && f.target.face.plane.normal[0] > 0.99)
    expect(drafted).toBeDefined()
    const n = drafted!.target.family === 'flat' ? drafted!.target.face.plane.normal : [0, 0, 0]
    expect(n[2]).toBeCloseTo(-Math.sin((3 * Math.PI) / 180), 5)
  })

  it('flipped (pull +Z from the bottom) the side leans in: material cut away, still closed', () => {
    const before = part()
    const plan = planned(before.mesh, stlDraftShape(before, [sideX(before)], {
      angleDeg: 3,
      pullDirection: { x: 0, y: 0, z: 1 },
      neutralPoint: { x: 50, y: 30, z: 0 },
    }))
    expectClosedSolid(plan.mesh)
    expect(bounds(plan.mesh).max[0]).toBe(W)
    const removed = volume(before.mesh) - volume(plan.mesh)
    expect(removed).toBeCloseTo((H * D * D * t3) / 2, 2)
  })

  it('with the top as the neutral face the side leans out at the bottom, the underside stays exactly flat, and all six holes still read as holes', () => {
    const before = part()
    const plan = planned(before.mesh, stlDraftShape(before, [sideX(before)], {
      angleDeg: 3, pullDirection: { x: 0, y: 0, z: 1 }, neutralPoint: { x: 50, y: 30, z: D },
    }))
    expectClosedSolid(plan.mesh)
    // The faces that do not move stay exactly on their planes: every corner
    // is at Z 0 or Z 10 to the bit. (A corner 3e-12 mm off the underside was
    // enough for the recogniser to lose five holes - measured.)
    for (let i = 2; i < plan.mesh.positions.length; i += 3) {
      expect(plan.mesh.positions[i] === 0 || plan.mesh.positions[i] === D).toBe(true)
    }
    expect(bounds(plan.mesh).max[0]).toBeCloseTo(W + D * t3, 4)
    const record = createMeshEditRecord(before.mesh, { ...plan.edits[0].edit, id: 'wo2090-draft-top', sourceFacetIds: before.sourceFacetIds })
    const after = buildStlModelBodyModel({ geoId: 'wo-2090-plate', name: NAME, bytes: fixtureBytes, meshEdits: [record] })
    expect(after.features.filter((f) => f.kind === 'through-hole')).toHaveLength(6)
    expect(after.features).toHaveLength(before.features.length)
  })

  it('replays from the journal, says what it did, and Undo restores the import', () => {
    const before = part()
    const plan = planned(before.mesh, stlDraftShape(before, [sideX(before)], {
      angleDeg: 3, pullDirection: { x: 0, y: 0, z: -1 }, neutralPoint: { x: 50, y: 30, z: 0 },
    }))
    const record = createMeshEditRecord(before.mesh, { ...plan.edits[0].edit, id: 'wo2090-draft', sourceFacetIds: before.sourceFacetIds })
    expect(describeMeshEdit(record)).toMatch(/^Drafted 1 face 3\.00 deg at /)
    const applied = buildStlModelBodyModel({ geoId: 'wo-2090-plate', name: NAME, bytes: fixtureBytes, meshEdits: [JSON.parse(JSON.stringify(record))] })
    expect(applied.stopped).toBeUndefined()
    expect(applied.mesh.positions).toEqual(plan.mesh.positions)
    const restored = buildStlModelBodyModel({ geoId: 'wo-2090-plate', name: NAME, bytes: fixtureBytes, meshEdits: [] })
    expect(restored.mesh.positions).toEqual(before.mesh.positions)
  })

  it('a face square to the pull has no side to draft: the plan says so and records nothing', () => {
    const before = part()
    const plan = planStlShapeEdit(before.mesh, stlDraftShape(before, [flatFace(before, [0, 0, 1], D)], {
      angleDeg: 3, pullDirection: { x: 0, y: 0, z: -1 }, neutralPoint: { x: 50, y: 30, z: 0 },
    }))
    expect(plan.ok).toBe(false)
    if (!plan.ok) expect(plan.reason).toMatch(/square to the pull direction/)
  })
})
