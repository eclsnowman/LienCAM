// WO-2119: Push/Pull moves a face whose rim meets a curved blend.
//
// The re-check's S8: on the STL export of Step Test With Holes (80 x 80 x 14,
// twelve blind holes and a pocket round an island through the top, every edge
// chamfered 0.5 mm) Push/Pull of the top face said "This face meets 3 faces at
// one of its corners and they do not stay met when it moves - a curved rim
// reads this way ... Nothing was changed." Two things stood in the way:
//   - the outer 0.5 mm chamfer ring closes on a small corner-cap triangle at
//     each corner, so it is not a straight blend the recogniser proves; nothing
//     carried it, and each outer corner met two chamfers and the cap at once.
//   - the pocket's curved wall is a ring of chords a few thousandths off
//     vertical (the STL's top and bottom stations do not line up), so the
//     stretched chords failed a planarity proof no chord of a curve can pass.
// Now the chamfers at the rim ride with the face at their own size, as the STEP
// route does, and the walls below them stretch.
//
// Everything runs through the Model screen's own planning entry
// (`planStlFeatureEdits`) and the resolver every route replays a journal with
// (`buildStlModelBodyModel`). The two small parts are written as real binary
// STL bytes and read back through that same resolver.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { buildStlModelBodyModel, type StlModelBodyModel } from '../../components/model3d/workbench/stlModelBody'
import { planStlFeatureEdits, stlFaceRef, type StlEditPlan } from '../../components/model3d/workbench/stlFeatureEdits'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import { createMeshEditRecord, describeMeshEdit } from '../../mesh/edit'
import { weldMesh } from '../../mesh/recognition/topology'
import { exportBinaryStl } from '../../mesh/stl'
import type { MeshBuffers, Vec3 } from '../../mesh/types'

const STEP_TEST = readFileSync(new URL('../fixtures/WO-2080/export-step-test-with-holes.stl', import.meta.url))
const STEP_TEST_NAME = 'export-step-test-with-holes.stl'

const model = (bytes: Uint8Array | ArrayBuffer, name: string, meshEdits: unknown[] = []) =>
  buildStlModelBodyModel({ geoId: `wo-2119-${name}`, name, bytes: bytes as never, meshEdits: meshEdits as never[] })

function welded(mesh: MeshBuffers): MeshBuffers {
  const w = weldMesh(mesh)
  return { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
}

function expectClosedSolid(mesh: MeshBuffers): void {
  const health = analyzeMesh(welded(mesh), { checkSelfIntersections: true })
  expect(health.watertight).toBe(true)
  expect(health.nonManifoldEdgeCount).toBe(0)
  expect(health.windingConflictEdgeCount).toBe(0)
  expect(health.selfIntersections).toBe(false)
  const measures = measureMesh(welded(mesh))
  expect(measures.componentCount).toBe(1)
  expect(measures.signedVolume).toBeGreaterThan(0)
}

/** The highest upward flat face, as the Model screen offers it on a click. */
function topFace(part: StlModelBodyModel) {
  const face = part.features
    .filter((f) => f.target.family === 'flat' && stlFaceRef(part, f).normal[2] > 0.9999)
    .sort((a, b) => stlFaceRef(part, b).point[2] - stlFaceRef(part, a).point[2])[0]
  if (face === undefined) throw new Error('the part has no upward flat face')
  return face
}

const pushPull = (part: StlModelBodyModel, distanceMm: number): StlEditPlan => planStlFeatureEdits(
  { mesh: part.mesh, sourceFacetIds: part.sourceFacetIds, roundFeatures: part.roundFeatures },
  [{ tool: 'push-pull', feature: topFace(part), distanceMm }],
)

function moved(plan: StlEditPlan) {
  if (!plan.ok) throw new Error(plan.reason)
  return plan
}

/** Every corner of every facet, before and after, matched by source facet. */
function cornerPairs(before: StlModelBodyModel, after: { mesh: MeshBuffers; sourceFacetIds: Uint32Array }) {
  const byId = new Map<number, number>()
  before.sourceFacetIds.forEach((id, facet) => byId.set(id, facet))
  const at = (mesh: MeshBuffers, facet: number, corner: number): Vec3 => {
    const i = mesh.indices[facet * 3 + corner] * 3
    return [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]]
  }
  const pairs: Array<{ was: Vec3; now: Vec3 }> = []
  after.sourceFacetIds.forEach((id, facet) => {
    const old = byId.get(id)
    if (old === undefined) return
    for (let c = 0; c < 3; c++) pairs.push({ was: at(before.mesh, old, c), now: at(after.mesh, facet, c) })
  })
  return pairs
}

// ------------------------------------------------------- the named part

describe('WO-2119: Push/Pull the top face of the STL export of Step Test With Holes', () => {
  const before = model(STEP_TEST, STEP_TEST_NAME)
  const top = topFace(before)

  it('the face picked is the 80 x 80 top at Z 0', () => {
    expect(stlFaceRef(before, top).point[2]).toBeCloseTo(0, 6)
    expect(top.sourceFacetIds.length).toBeGreaterThan(100)
  })

  for (const distanceMm of [1, -1]) {
    describe(`by ${distanceMm > 0 ? '+' : ''}${distanceMm} mm`, () => {
      const plan = pushPull(before, distanceMm)

      it('moves, and the journal says so', () => {
        const done = moved(plan)
        expect(done.edits).toHaveLength(1)
        expect(done.edits[0].note).toBeUndefined()
        const record = createMeshEditRecord(before.mesh, { ...done.edits[0].edit, id: 'wo2119' })
        expect(describeMeshEdit(record)).toBe(
          `${distanceMm > 0 ? 'Pulled' : 'Pushed'} a flat face ${distanceMm > 0 ? 'out' : 'in'} 1.00 mm`,
        )
      })

      it('the top face and every chamfer on its rim ride with it; the walls below stretch', () => {
        const pairs = cornerPairs(before, moved(plan))
        expect(pairs.length).toBe(before.mesh.indices.length)
        let riding = 0
        let still = 0
        for (const { was, now } of pairs) {
          // x and y never change: every chamfer keeps its size, every wall its outline
          expect(Math.abs(now[0] - was[0])).toBeLessThan(1e-4)
          expect(Math.abs(now[1] - was[1])).toBeLessThan(1e-4)
          if (was[2] > -0.5 - 1e-3) {
            // the top face and the 0.5 mm chamfers round it: the outer ring,
            // its corner caps, the pocket rim and the twelve hole mouths
            expect(now[2] - was[2]).toBeCloseTo(distanceMm, 4)
            riding++
          } else {
            expect(now[2]).toBeCloseTo(was[2], 5)
            still++
          }
        }
        expect(riding).toBeGreaterThan(0)
        expect(still).toBeGreaterThan(0)
      })

      it('the outer corner that stopped it moves exactly with the face, cap and all', () => {
        const pairs = cornerPairs(before, moved(plan))
        const corner = pairs.find(({ was }) =>
          Math.abs(was[0] + 39.5) < 1e-3 && Math.abs(was[1] + 39.5) < 1e-3 && Math.abs(was[2]) < 1e-3)
        expect(corner).toBeDefined()
        expect(corner!.now[2]).toBeCloseTo(distanceMm, 4)
        const capFoot = pairs.find(({ was }) =>
          Math.abs(was[0] + 40) < 1e-3 && Math.abs(was[1] + 39.5) < 1e-3 && Math.abs(was[2] + 0.5) < 1e-3)
        expect(capFoot).toBeDefined()
        expect(capFoot!.now[2]).toBeCloseTo(-0.5 + distanceMm, 4)
      })

      it('leaves a closed, outward, single solid whose volume changed the right way', () => {
        const done = moved(plan)
        expectClosedSolid(done.mesh)
        const change = measureMesh(welded(done.mesh)).signedVolume - measureMesh(welded(before.mesh)).signedVolume
        expect(Math.sign(change)).toBe(Math.sign(distanceMm))
      })
    })
  }

  it('Undo restores the part: the journal without the entry resolves to the imported mesh', () => {
    const done = moved(pushPull(before, 1))
    const record = createMeshEditRecord(before.mesh, { ...done.edits[0].edit, sourceFacetIds: before.sourceFacetIds })
    const applied = model(STEP_TEST, STEP_TEST_NAME, [record])
    expect(applied.mesh.positions).toEqual(done.mesh.positions)
    const undone = model(STEP_TEST, STEP_TEST_NAME, [])
    expect(undone.mesh.positions).toEqual(before.mesh.positions)
    expect(undone.mesh.indices).toEqual(before.mesh.indices)
  })
})

// ------------------------------------------ a curved rim with no chamfer

class Soup {
  private readonly coords: number[] = []
  tri(a: Vec3, b: Vec3, c: Vec3): void { this.coords.push(...a, ...b, ...c) }
  bytes(): ArrayBuffer {
    const positions = Float32Array.from(this.coords)
    const indices = new Uint32Array(positions.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    return exportBinaryStl({ positions, indices }).bytes
  }
}

/**
 * A round plate 40 mm across and 10 mm thick with a 10 mm bore straight
 * through it, 24 chords each way. The bore's bottom ring is turned half a
 * chord against its top ring, as STL writers often leave it, so every chord of
 * the bore leans a few thousandths off vertical and each top-rim vertex of the
 * bore touches three of them at once. The top face's rim is that curve.
 */
function plateWithOffsetBore(): ArrayBuffer {
  const soup = new Soup()
  const n = 24
  const at = (r: number, k: number, z: number): Vec3 => {
    const a = (2 * Math.PI * (((k % n) + n) % n)) / n // station n IS station 0, bit for bit
    return [r * Math.cos(a), r * Math.sin(a), z]
  }
  for (let i = 0; i < n; i++) {
    const j = i + 1
    // top annulus, upward
    soup.tri(at(5, i, 10), at(20, i, 10), at(20, j, 10))
    soup.tri(at(5, i, 10), at(20, j, 10), at(5, j, 10))
    // outer wall, outward
    soup.tri(at(20, i, 0), at(20, j, 0), at(20, j, 10))
    soup.tri(at(20, i, 0), at(20, j, 10), at(20, i, 10))
    // bottom annulus, downward; the bore's bottom ring sits at half stations
    soup.tri(at(20, i, 0), at(5, i + 0.5, 0), at(20, j, 0))
    soup.tri(at(20, i, 0), at(5, i - 0.5, 0), at(5, i + 0.5, 0))
    // the bore, facing its own axis
    soup.tri(at(5, i, 10), at(5, j, 10), at(5, i + 0.5, 0))
    soup.tri(at(5, i, 10), at(5, i + 0.5, 0), at(5, i - 0.5, 0))
  }
  return soup.bytes()
}

describe('WO-2119: a top face whose rim is a curved bore, with no chamfer', () => {
  const before = model(plateWithOffsetBore(), 'offset-bore.stl')

  it('the fixture is a closed solid', () => {
    expectClosedSolid(before.mesh)
  })

  for (const distanceMm of [2, -3]) {
    it(`moves the top ${distanceMm} mm: the bore keeps its outline and only gets ${distanceMm > 0 ? 'taller' : 'shorter'}`, () => {
      const done = moved(pushPull(before, distanceMm))
      for (const { was, now } of cornerPairs(before, done)) {
        expect(Math.abs(now[0] - was[0])).toBeLessThan(1e-4)
        expect(Math.abs(now[1] - was[1])).toBeLessThan(1e-4)
        expect(now[2]).toBeCloseTo(was[2] > 5 ? was[2] + distanceMm : was[2], 4)
      }
      expectClosedSolid(done.mesh)
    })
  }
})

// ---------------------------------- a corner it truly cannot work out

/**
 * A 45 degree frustum, 4 x 4 at the foot and 2 x 2 on top, with one corner
 * capped by a small leaning triangle between the two drafted walls. Moving the
 * top would have to keep that corner on both walls AND on the cap, and those
 * three planes meet in no single line - and no proved chamfer says the cap
 * rides with the face.
 */
function cappedFrustum(): ArrayBuffer {
  const soup = new Soup()
  const B0: Vec3 = [-2, -2, 0]
  const B1: Vec3 = [2, -2, 0]
  const B2: Vec3 = [2, 2, 0]
  const B3: Vec3 = [-2, 2, 0]
  const T0: Vec3 = [-1, -1, 1]
  const T1: Vec3 = [1, -1, 1]
  const T2: Vec3 = [1, 1, 1]
  const T3: Vec3 = [-1, 1, 1]
  const A: Vec3 = [1.5, 1, 0.5]
  const C: Vec3 = [1, 1.5, 0.5]
  soup.tri(B0, B2, B1); soup.tri(B0, B3, B2)
  soup.tri(T0, T1, T2); soup.tri(T0, T2, T3)
  soup.tri(B0, B1, T1); soup.tri(B0, T1, T0)
  soup.tri(B3, B0, T0); soup.tri(B3, T0, T3)
  soup.tri(B1, B2, A); soup.tri(B1, A, T2); soup.tri(B1, T2, T1)
  soup.tri(B2, B3, C); soup.tri(B3, T3, C); soup.tri(T3, T2, C)
  soup.tri(T2, A, C)
  soup.tri(A, B2, C)
  return soup.bytes()
}

describe('WO-2119: when a corner truly cannot be worked out, the refusal says which one', () => {
  const before = model(cappedFrustum(), 'capped-frustum.stl')

  it('the fixture is a closed solid', () => {
    expectClosedSolid(before.mesh)
  })

  it('names the corner by its coordinates, and changes nothing', () => {
    const plan = pushPull(before, 0.2)
    expect(plan.ok).toBe(false)
    if (plan.ok) return
    expect(plan.reason).toMatch(/where that corner would go \(at X 1\.00 Y 1\.00 Z 1\.00\)\. Nothing was changed\.$/)
  })
})
