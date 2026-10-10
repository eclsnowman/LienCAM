// WO-2118: Shell on the STL export of Step Test With Holes gives the STEP
// route's answer (WO-2107, src/tests/geom/shellByConstruction.wo2107.test.ts).
//
// The part: 80 x 80 x 14 mm, twelve 5 mm blind holes (8, 10 and 13 mm deep)
// and a 10 mm deep pocket round an island, all opened through the top, every
// edge chamfered 0.5 mm. Shelling it open at the top by moving every face in
// (WO-2090's direct shell) came back in 11 pieces at 2.5 mm - the re-check's
// S8 - where the STEP route builds one piece. The STL route now builds it the
// STEP route's way when the direct shell would split: the block hollowed, a
// wall kept round each hole and pocket, cut from the part as it was.
//
// Through the planning entry the Model screen's Shell calls (`stlShellShape`,
// then `planStlShapeEdit`) and the resolver every route replays a journal with
// (`buildStlModelBodyModel`). Nothing here hands the kernel a hand-built
// payload.

import { readFileSync } from 'node:fs'
import { beforeAll, describe, expect, it } from 'vitest'

import { buildStlModelBodyModel, type StlModelBodyModel } from '../../components/model3d/workbench/stlModelBody'
import { planStlShapeEdit, stlFaceRef, stlShellShape } from '../../components/model3d/workbench/stlFeatureEdits'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import { createMeshEditRecord, describeMeshEdit, primeBoringKernel } from '../../mesh/edit'
import { recognizeMeshFeatures } from '../../mesh/recognition'
import { weldMesh } from '../../mesh/recognition/topology'
import type { MeshBuffers } from '../../mesh/types'

const fixtureBytes = readFileSync(new URL('../fixtures/WO-2080/export-step-test-with-holes.stl', import.meta.url))
const NAME = 'export-step-test-with-holes.stl'
const part = (meshEdits: unknown[] = []) =>
  buildStlModelBodyModel({ geoId: 'wo-2118-step-test', name: NAME, bytes: fixtureBytes, meshEdits: meshEdits as never[] })

/** The STEP route's shelled volumes (WO-2107's own run,
 *  src/tests/evidence/WO-2107/out-engine-shell.txt), mm3. */
const STEP_VOLUME: Record<number, number> = { 2.5: 42493.442, 3: 48796.603 }

function welded(mesh: MeshBuffers): MeshBuffers {
  const w = weldMesh(mesh)
  return { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
}
const volume = (mesh: MeshBuffers) => measureMesh(welded(mesh)).signedVolume
function expectClosedSolid(mesh: MeshBuffers): void {
  const health = analyzeMesh(welded(mesh), { checkSelfIntersections: true })
  expect(health.warnings).toEqual([])
  expect(health.watertight).toBe(true)
  expect(health.nonManifoldEdgeCount).toBe(0)
  expect(health.windingConflictEdgeCount).toBe(0)
  expect(health.selfIntersections).toBe(false)
  expect(measureMesh(welded(mesh)).componentCount).toBe(1)
}

/** The top face, as the Model screen offers it on a click. */
function topFace(model: StlModelBodyModel) {
  const tops = model.features.filter((f) => f.target.family === 'flat' && stlFaceRef(model, f).normal[2] > 0.9999)
  const face = tops.find((f) => Math.abs(stlFaceRef(model, f).point[2]) < 1e-6)
  if (face === undefined) throw new Error('no top face at Z 0')
  return face
}

const shell = (model: StlModelBodyModel, thickness: number) => planStlShapeEdit(model.mesh, stlShellShape(model, [topFace(model)], thickness))

beforeAll(async () => { await primeBoringKernel() })

describe('WO-2118: Shell on the STL of Step Test With Holes builds where the STEP does', () => {
  for (const thickness of [2.5, 3]) {
    it(`${thickness} mm: one entry, one closed solid, the STEP route's volume, every hole still the part's own`, () => {
      const before = part()
      const sourceVolume = volume(before.mesh)
      const plan = shell(before, thickness)
      if (!plan.ok) throw new Error(plan.reason)
      expect(plan.edits).toHaveLength(1)
      expectClosedSolid(plan.mesh)

      // Hollowed to the STEP route's volume, less than 1% over it: the mesh
      // keeps the top chamfer's own offset where the STEP route had taken the
      // chamfers off to hollow the block (decide-and-log in the work order).
      const shelled = volume(plan.mesh)
      expect(shelled).toBeLessThan(sourceVolume * 0.7)
      expect(shelled).toBeGreaterThan(STEP_VOLUME[thickness])
      expect(shelled).toBeLessThan(STEP_VOLUME[thickness] * 1.01)

      // Cut from the part as it was: every blind hole still reads as the same
      // hole (the walls are kept round them, not re-made).
      const holes = (mesh: MeshBuffers) => recognizeMeshFeatures(mesh).features
        .filter((f) => f.kind === 'blind-hole')
        .map((f) => `${f.diameterMm.toFixed(2)} x ${f.depthMm.toFixed(2)} at ${f.axis.origin[0].toFixed(2)}, ${f.axis.origin[1].toFixed(2)}`)
        .sort()
      expect(holes(before.mesh)).toHaveLength(12)
      expect(holes(plan.mesh)).toEqual(holes(before.mesh))
    }, 120_000)
  }

  it('replays from the journal to the same part, says what it did, and Undo restores the import', () => {
    const before = part()
    const plan = shell(before, 2.5)
    if (!plan.ok) throw new Error(plan.reason)
    const record = createMeshEditRecord(before.mesh, { ...plan.edits[0].edit, id: 'wo2118-shell', sourceFacetIds: before.sourceFacetIds })
    expect(describeMeshEdit(record)).toMatch(/^Shelled to a 2\.50 mm wall, 1 face open at /)
    const applied = part([JSON.parse(JSON.stringify(record))])
    expect(applied.stopped).toBeUndefined()
    expect(applied.mesh.positions).toEqual(plan.mesh.positions)
    expect(applied.mesh.indices).toEqual(plan.mesh.indices)
    const restored = part()
    expect(restored.mesh.positions).toEqual(before.mesh.positions)
    expect(restored.mesh.indices).toEqual(before.mesh.indices)
  }, 120_000)

  it('1 mm splits as the STEP does: the message names the 10 pieces and the thinnest one-piece wall, which then builds', () => {
    const before = part()
    const plan = shell(before, 1)
    expect(plan.ok).toBe(false)
    const reason = plan.ok ? '' : plan.reason
    expect(reason).toContain('A 1 mm shell would split the part into 10 separate pieces')
    const named = /The thinnest wall that keeps it one piece is ([\d.]+) mm\./.exec(reason)
    expect(named, reason).not.toBeNull()
    const onePiece = Number(named![1])
    // The STEP route names 2.3 mm; the mesh keeps the top chamfer's offset,
    // which reaches the walls round the holes by the outside edge sooner.
    expect(onePiece).toBeGreaterThan(1)
    expect(onePiece).toBeLessThanOrEqual(2.5)
    expect(reason).toContain('Nothing was changed.')

    const retry = shell(before, onePiece)
    if (!retry.ok) throw new Error(retry.reason)
    expectClosedSolid(retry.mesh)
    // A tenth thinner still splits: it is the thinnest.
    const thinner = shell(before, Math.round((onePiece - 0.1) * 10) / 10)
    expect(thinner.ok).toBe(false)
    // The part the Model screen holds is untouched by the refusal.
    expect(part().mesh.positions).toEqual(before.mesh.positions)
  }, 180_000)

  it('a wall thick enough to turn the direct inside out (4 mm) is built by construction too', () => {
    const before = part()
    const plan = shell(before, 4)
    if (!plan.ok) throw new Error(plan.reason)
    expectClosedSolid(plan.mesh)
    expect(volume(plan.mesh)).toBeLessThan(volume(before.mesh))
  }, 120_000)
})
