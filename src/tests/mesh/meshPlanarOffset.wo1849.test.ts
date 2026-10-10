// WO-1849: push or pull a flat face on an STL.
//
// Rule 6: nothing here hand-builds a MeshBuffers and hands it to an engine.
// Every fixture is written as REAL binary STL bytes the way a slicer would and
// parsed back through the product's `importStl`; every face is PICKED through
// WO-1854's own door (`src/mesh/recognition`, never `topology.ts` behind it);
// every edit is minted with the framework's `createMeshEditRecord` and applied
// by `replayMeshEdits` - the registry path WO-1845 built and the one
// `resolveEditedStlMesh` runs on every route. The toolpath case runs the
// product's `acquirePartMesh` + `computeParallel3dMoves` against a real
// BvhKernel.
//
// ON WELDING, as WO-1850 says it: an STL is a triangle soup and `analyzeMesh`
// builds its topology from VERTEX INDICES, so an imported plate is "not
// watertight" too - every edge is unique. `welded()` re-indexes by exact
// coordinate and changes not one number; the watertight/outward/
// self-intersection assertions run on that, before AND after, so the
// comparison is like for like.
//
// The stepped block is WO-1854's own fixture, copied rather than imported: a
// vitest file that imports another test file would run that file's module
// mocks and its suites. That is the precedent WO-1850 and WO-1854 both set.

import { beforeAll, describe, expect, it } from 'vitest'
import { analyzeMesh, measureMesh } from '../../mesh/analysis'
import { exportBinaryStl, importStl } from '../../mesh/stl'
import {
  createMeshEditRecord,
  describeMeshEdit,
  flatFaceMoveOutcome,
  getMeshEditOperation,
  moveFlatFace,
  moveFlatFaceOperation,
  replayMeshEdits,
  sourceFacetIdsOf,
  MOVE_FLAT_FACE_KIND,
  type MeshEditRecord,
} from '../../mesh/edit'
import { recognizeFlatFaces, type RecognizedFlatFace } from '../../mesh/recognition'
import { weldMesh } from '../../mesh/recognition/topology'
import type { MeshBuffers, Vec3 } from '../../mesh/types'
import { cylinderApprox } from './fixtures'
import {
  acquirePartMesh,
  computeParallel3dMoves,
  xyBoundsRing,
  DEFAULT_PARALLEL3D_PARAMS,
} from '../../cam3d/integration/parallel3dOperation'
import { BvhKernel } from '../../cam3d/kernel/bvhKernel'
import { Cam3dDispatcher } from '../../cam3d/worker/dispatcher'
import { Cam3dClient, type WorkerLike } from '../../cam3d/worker/client'
import type { Cam3dRequest, Cam3dResponse } from '../../cam3d/worker/protocol'
import type { ToolpathMove } from '../../types'
import { makeTool } from '../post/helpers'

// ---------------------------------------------------------------- fixtures

class Soup {
  private readonly coords: number[] = []
  tri(a: Vec3, b: Vec3, c: Vec3): void { this.coords.push(...a, ...b, ...c) }
  /** two triangles for the quad a-b-c-d, normal by the given winding */
  quad(a: Vec3, b: Vec3, c: Vec3, d: Vec3): void { this.tri(a, b, c); this.tri(a, c, d) }
  mesh(): MeshBuffers {
    const positions = Float32Array.from(this.coords)
    const indices = new Uint32Array(positions.length / 3)
    for (let i = 0; i < indices.length; i++) indices[i] = i
    return { positions, indices }
  }
  bytes(): ArrayBuffer { return exportBinaryStl(this.mesh()).bytes }
}

const STEP_Y = 20
/** WO-1854's stepped block, 60 x 20 in plan: four treads of 15 mm at Z 12, 6,
 *  12 and 3, split so every wall meets its neighbours exactly. */
const STEP_COLUMNS: Array<{ x0: number, x1: number, top: number }> = [
  { x0: 0, x1: 15, top: 12 },
  { x0: 15, x1: 30, top: 6 },
  { x0: 30, x1: 45, top: 12 },
  { x0: 45, x1: 60, top: 3 },
]
const STEP_LEVELS = [0, 3, 6, 12]

function steppedBlock(): ArrayBuffer {
  const soup = new Soup()
  const bands = (za: number, zb: number): Array<[number, number]> => {
    const cuts = STEP_LEVELS.filter((z) => z >= za && z <= zb)
    return cuts.slice(0, -1).map((z, k) => [z, cuts[k + 1]] as [number, number])
  }
  for (const column of STEP_COLUMNS) {
    const { x0, x1, top } = column
    soup.quad([x0, 0, 0], [x0, STEP_Y, 0], [x1, STEP_Y, 0], [x1, 0, 0])
    soup.quad([x0, 0, top], [x1, 0, top], [x1, STEP_Y, top], [x0, STEP_Y, top])
    for (const [za, zb] of bands(0, top)) {
      soup.quad([x0, 0, za], [x1, 0, za], [x1, 0, zb], [x0, 0, zb])
      soup.quad([x0, STEP_Y, za], [x0, STEP_Y, zb], [x1, STEP_Y, zb], [x1, STEP_Y, za])
    }
  }
  const heightAt = (index: number): number => STEP_COLUMNS[index]?.top ?? 0
  for (let boundary = 0; boundary <= STEP_COLUMNS.length; boundary++) {
    const x = boundary === 0 ? STEP_COLUMNS[0].x0 : STEP_COLUMNS[boundary - 1].x1
    const left = boundary === 0 ? 0 : heightAt(boundary - 1)
    const right = heightAt(boundary)
    if (left === right) continue
    const facesPlusX = left > right
    for (const [za, zb] of bands(Math.min(left, right), Math.max(left, right))) {
      if (facesPlusX) soup.quad([x, 0, za], [x, STEP_Y, za], [x, STEP_Y, zb], [x, 0, zb])
      else soup.quad([x, 0, za], [x, 0, zb], [x, STEP_Y, zb], [x, STEP_Y, za])
    }
  }
  return soup.bytes()
}

const POCKET_X = [0, 20, 40, 60]
const POCKET_Y = [0, 10, 30, 40]
const POCKET_TOP = 12
const POCKET_FLOOR = 8

/**
 * A 60 x 40 x 12 plate with a 20 x 20 pocket 4 mm deep in the middle of it.
 *
 * Every face is split on the same grid as the faces it meets, so there is no
 * T-junction anywhere and the whole shell welds by exact coordinate: the top
 * is the eight cells of a 3 x 3 grid with the middle one missing, the bottom
 * is all nine, and each outer wall is split to match the cells beside it.
 */
function pocketPlate(): ArrayBuffer {
  const soup = new Soup()
  const up = (x0: number, x1: number, y0: number, y1: number, z: number): void =>
    soup.quad([x0, y0, z], [x1, y0, z], [x1, y1, z], [x0, y1, z])
  const down = (x0: number, x1: number, y0: number, y1: number, z: number): void =>
    soup.quad([x0, y0, z], [x0, y1, z], [x1, y1, z], [x1, y0, z])

  for (let i = 0; i < 3; i++) {
    for (let j = 0; j < 3; j++) {
      const [x0, x1] = [POCKET_X[i], POCKET_X[i + 1]]
      const [y0, y1] = [POCKET_Y[j], POCKET_Y[j + 1]]
      down(x0, x1, y0, y1, 0)
      if (i !== 1 || j !== 1) up(x0, x1, y0, y1, POCKET_TOP)
    }
  }
  // the pocket: floor facing up, four walls facing into the empty space
  up(POCKET_X[1], POCKET_X[2], POCKET_Y[1], POCKET_Y[2], POCKET_FLOOR)
  const [px0, px1] = [POCKET_X[1], POCKET_X[2]]
  const [py0, py1] = [POCKET_Y[1], POCKET_Y[2]]
  soup.quad([px0, py0, POCKET_FLOOR], [px0, py1, POCKET_FLOOR], [px0, py1, POCKET_TOP], [px0, py0, POCKET_TOP])
  soup.quad([px1, py0, POCKET_FLOOR], [px1, py0, POCKET_TOP], [px1, py1, POCKET_TOP], [px1, py1, POCKET_FLOOR])
  soup.quad([px0, py0, POCKET_FLOOR], [px0, py0, POCKET_TOP], [px1, py0, POCKET_TOP], [px1, py0, POCKET_FLOOR])
  soup.quad([px0, py1, POCKET_FLOOR], [px1, py1, POCKET_FLOOR], [px1, py1, POCKET_TOP], [px0, py1, POCKET_TOP])

  // the four outer walls, split on the same grid
  for (let i = 0; i < 3; i++) {
    const [x0, x1] = [POCKET_X[i], POCKET_X[i + 1]]
    soup.quad([x0, 0, 0], [x1, 0, 0], [x1, 0, POCKET_TOP], [x0, 0, POCKET_TOP])
    soup.quad([x0, 40, 0], [x0, 40, POCKET_TOP], [x1, 40, POCKET_TOP], [x1, 40, 0])
  }
  for (let j = 0; j < 3; j++) {
    const [y0, y1] = [POCKET_Y[j], POCKET_Y[j + 1]]
    soup.quad([0, y0, 0], [0, y0, POCKET_TOP], [0, y1, POCKET_TOP], [0, y1, 0])
    soup.quad([60, y0, 0], [60, y1, 0], [60, y1, POCKET_TOP], [60, y0, POCKET_TOP])
  }
  return soup.bytes()
}

/**
 * A DRAFTED block: 60 x 40 at the bottom, 40 x 20 at the top, 10 mm tall - so
 * all four walls lean in at 45 degrees. This is the fixture the rim re-solve
 * exists for: raising the top face straight up would tear every wall off its
 * own plane, and the corner of the top face has to slide IN along the draft
 * instead.
 */
function draftedBlock(): ArrayBuffer {
  const soup = new Soup()
  const bottom: Vec3[] = [[0, 0, 0], [60, 0, 0], [60, 40, 0], [0, 40, 0]]
  const top: Vec3[] = [[10, 10, 10], [50, 10, 10], [50, 30, 10], [10, 30, 10]]
  soup.quad(bottom[0], bottom[3], bottom[2], bottom[1])
  soup.quad(top[0], top[1], top[2], top[3])
  for (let k = 0; k < 4; k++) {
    const j = (k + 1) % 4
    soup.quad(bottom[k], bottom[j], top[j], top[k])
  }
  return soup.bytes()
}

/** A 32-sided cylinder, 20 mm across and 10 tall: a flat top face whose
 *  neighbour is NOT planar. */
function cylinderPart(): ArrayBuffer {
  return exportBinaryStl(cylinderApprox(10, 10, 32)).bytes
}

// ----------------------------------------------------------------- helpers

/** An STL's own topology, welded by exact coordinate - what `analyzeMesh`
 *  needs before it can say anything about a triangle soup. */
function welded(mesh: MeshBuffers): MeshBuffers {
  const w = weldMesh(mesh)
  return { positions: Float32Array.from(w.positions), indices: Uint32Array.from(w.facets) }
}

function health(mesh: MeshBuffers) {
  return analyzeMesh(welded(mesh), { checkSelfIntersections: true })
}

function measures(mesh: MeshBuffers) {
  return measureMesh(welded(mesh))
}

interface Part {
  mesh: MeshBuffers
  sourceFacetIds: Uint32Array
  faces: RecognizedFlatFace[]
}

/** The part as the product sees it: parsed from bytes, with every flat face it
 *  PROVES, through the recognition door WO-1854 put them behind. */
function part(bytes: ArrayBuffer): Part {
  const parsed = importStl(bytes)
  const sourceFacetIds = sourceFacetIdsOf(parsed.mesh)
  return { mesh: parsed.mesh, sourceFacetIds, faces: recognizeFlatFaces(parsed.mesh, sourceFacetIds).faces }
}

/** The current-mesh facet indices a picked face's source ids name. */
function facetsOf(face: RecognizedFlatFace, sourceFacetIds: Uint32Array): number[] {
  const wanted = new Set(face.sourceFacetIds)
  const out: number[] = []
  sourceFacetIds.forEach((id, facet) => { if (wanted.has(id)) out.push(facet) })
  return out
}

/** One face of a part, named the way an operator would: which way it looks and
 *  where it sits (in the recentred frame the recogniser reports). */
function faceAt(from: Part, normal: Vec3, along: number, at: number): RecognizedFlatFace {
  const found = from.faces.find(
    (f) => f.plane.normal.every((n, i) => Math.abs(n - normal[i]) < 1e-6)
      && Math.abs(f.plane.point[along] - at) < 1e-6,
  )
  if (!found) {
    throw new Error(`no face facing ${normal.join(',')} at ${'xyz'[along]} ${at} - the fixture changed`)
  }
  return found
}

/** Mint the edit and replay it, exactly as the application does. */
function moveThroughTheJournal(
  from: Part,
  face: RecognizedFlatFace,
  distanceMm: number,
  extra: Record<string, unknown> = {},
): { record: MeshEditRecord, mesh: MeshBuffers, sourceFacetIds: Uint32Array } {
  const record = createMeshEditRecord(from.mesh, {
    kind: MOVE_FLAT_FACE_KIND,
    facets: facetsOf(face, from.sourceFacetIds),
    parameters: { distanceMm, ...extra },
    sourceFacetIds: from.sourceFacetIds,
  })
  const replayed = replayMeshEdits(from.mesh, [record])
  expect(replayed.stopped).toBeUndefined()
  expect(replayed.appliedCount).toBe(1)
  return { record, mesh: replayed.mesh, sourceFacetIds: replayed.sourceFacetIds }
}

/** Every corner of every facet the given source ids name, in the mesh frame. */
function cornersOfSourceFacets(mesh: MeshBuffers, sourceFacetIds: Uint32Array, ids: readonly number[]): Vec3[] {
  const wanted = new Set(ids)
  const out: Vec3[] = []
  sourceFacetIds.forEach((id, facet) => {
    if (!wanted.has(id)) return
    for (let c = 0; c < 3; c++) {
      const at = mesh.indices[facet * 3 + c] * 3
      out.push([mesh.positions[at], mesh.positions[at + 1], mesh.positions[at + 2]])
    }
  })
  return out
}

// ------------------------------------------- the acceptance: raise a top face

describe('WO-1849: raising a flat face moves every facet of it to the new plane', () => {
  const bytes = steppedBlock()
  const before = part(bytes)
  // the tread at X -22.5 (the left-hand column), 15 x 20 mm at Z 12
  const top = faceAt(before, [0, 0, 1], 2, 12)
  const moved = moveThroughTheJournal(before, top, 2)
  const after = part(exportBinaryStl(moved.mesh).bytes)

  it('the picked face sits exactly 2 mm higher, every facet of it', () => {
    expect(top.areaMm2).toBeCloseTo(15 * STEP_Y, 3)
    const corners = cornersOfSourceFacets(moved.mesh, moved.sourceFacetIds, top.sourceFacetIds)
    expect(corners.length).toBe(top.facetCount * 3)
    for (const [, , z] of corners) expect(Math.abs(z - 14)).toBeLessThanOrEqual(1e-6)
  })

  it('the part is still closed, still outward and still does not cross itself', () => {
    const was = health(before.mesh)
    const now = health(moved.mesh)
    expect(was.watertight).toBe(true)
    expect(now.watertight).toBe(true)
    expect(now.selfIntersections).toBe(false)
    expect(now.nonManifoldEdgeCount).toBe(0)
    expect(now.windingConflictEdgeCount).toBe(0)
    expect(measures(moved.mesh).signedVolume).toBeGreaterThan(0)
  })

  it('the part gained exactly the face area times the distance', () => {
    const gained = measures(moved.mesh).volume - measures(before.mesh).volume
    expect(gained).toBeCloseTo(top.areaMm2 * 2, 2)
  })

  it('the faces beside it stretched and stayed flat', () => {
    // WO-1854's own door is the support check: the walls and the sides are
    // still faces, still on their own planes, and the two side faces grew by
    // exactly the 15 x 2 mm the tread rose.
    const sides = after.faces.filter((f) => Math.abs(Math.abs(f.plane.normal[1]) - 1) < 1e-9)
    expect(sides).toHaveLength(2)
    for (const side of sides) {
      expect(side.maxDeviationMm).toBeLessThanOrEqual(1e-6)
      expect(side.areaMm2).toBeCloseTo(495 + 15 * 2, 2)
    }
    // the wall between the raised tread and the one at Z 6 - at X -15 in the
    // recentred frame - is now 8 mm tall where it was 6
    const wall = after.faces.find(
      (f) => Math.abs(f.plane.normal[0] - 1) < 1e-9 && Math.abs(f.plane.point[0] + 15) < 1e-6,
    )
    expect(wall).toBeDefined()
    expect(wall!.maxDeviationMm).toBeLessThanOrEqual(1e-6)
    expect(wall!.areaMm2).toBeCloseTo(8 * STEP_Y, 2)
  })

  it('the tread keeps its name: the same source facets, at the new height', () => {
    const raised = after.faces.find((f) => Math.abs(f.plane.point[2] - 14) < 1e-6)
    expect(raised).toBeDefined()
    expect(raised!.sourceFacetIds).toEqual(top.sourceFacetIds)
    expect(raised!.areaMm2).toBeCloseTo(top.areaMm2, 3)
  })

  it('the journal says what it did, in words', () => {
    expect(describeMeshEdit(moved.record)).toBe('Pulled a flat face out 2.00 mm')
  })
})

// ------------------------------------------- the acceptance: deepen a pocket

describe('WO-1849: lowering a pocket floor deepens the pocket the same way', () => {
  const bytes = pocketPlate()
  const before = part(bytes)
  // the pocket floor: facing up, at Z 8, in the recentred frame
  const floor = faceAt(before, [0, 0, 1], 2, POCKET_FLOOR)
  const moved = moveThroughTheJournal(before, floor, -1)
  const after = part(exportBinaryStl(moved.mesh).bytes)

  it('the floor is 1 mm lower and the pocket is 1 mm deeper', () => {
    expect(floor.areaMm2).toBeCloseTo(20 * 20, 3)
    const corners = cornersOfSourceFacets(moved.mesh, moved.sourceFacetIds, floor.sourceFacetIds)
    for (const [, , z] of corners) expect(Math.abs(z - (POCKET_FLOOR - 1))).toBeLessThanOrEqual(1e-6)
    const lowered = after.faces.find((f) => Math.abs(f.plane.point[2] - (POCKET_FLOOR - 1)) < 1e-6)
    expect(lowered).toBeDefined()
    expect(lowered!.areaMm2).toBeCloseTo(20 * 20, 3)
  })

  it('the part lost exactly the floor area times the distance, and is still a solid', () => {
    const lost = measures(before.mesh).volume - measures(moved.mesh).volume
    expect(lost).toBeCloseTo(floor.areaMm2 * 1, 2)
    const now = health(moved.mesh)
    expect(now.watertight).toBe(true)
    expect(now.selfIntersections).toBe(false)
    expect(measures(moved.mesh).signedVolume).toBeGreaterThan(0)
  })

  it('the pocket walls are 1 mm taller and still flat', () => {
    const walls = after.faces.filter((f) => Math.abs(f.plane.normal[2]) < 1e-9)
    // four outer walls and four pocket walls
    expect(walls).toHaveLength(8)
    for (const wall of walls) expect(wall.maxDeviationMm).toBeLessThanOrEqual(1e-6)
    const pocketWalls = walls.filter((f) => f.areaMm2 < 200)
    expect(pocketWalls).toHaveLength(4)
    for (const wall of pocketWalls) expect(wall.areaMm2).toBeCloseTo(20 * 5, 2)
  })

  it('the journal says what it did, in words', () => {
    expect(describeMeshEdit(moved.record)).toBe('Pushed a flat face in 1.00 mm')
  })
})

// ------------------------------ as far as it actually goes, said with a number

describe('WO-1849: a move that would drive the face through another one stops where it arrives', () => {
  const bytes = pocketPlate()
  const before = part(bytes)
  const floor = faceAt(before, [0, 0, 1], 2, POCKET_FLOOR)
  const facets = facetsOf(floor, before.sourceFacetIds)

  it('says how far it can go, and why, before anything is recorded', () => {
    const outcome = flatFaceMoveOutcome(before.mesh, facets, -20)
    expect(outcome.refusal).toBeNull()
    // 8 mm of plate under the floor: it stops a hundredth short of the bottom
    expect(outcome.appliedMm).toBe(-7.99)
    expect(outcome.note).toContain('7.99 mm')
    expect(outcome.note).toContain('20.00 mm')
    expect(outcome.note).toContain('reaches the face in front of it at 8.00 mm')
  })

  it('a move that fits says nothing at all', () => {
    const outcome = flatFaceMoveOutcome(before.mesh, facets, -1)
    expect(outcome).toEqual({ requestedMm: -1, appliedMm: -1, note: null, refusal: null })
  })

  it('the part it leaves is a solid, with a floor 0.01 mm above the bottom', () => {
    const moved = moveThroughTheJournal(before, floor, -20)
    const corners = cornersOfSourceFacets(moved.mesh, moved.sourceFacetIds, floor.sourceFacetIds)
    for (const [, , z] of corners) expect(z).toBeCloseTo(0.01, 6)
    const now = health(moved.mesh)
    expect(now.watertight).toBe(true)
    expect(now.selfIntersections).toBe(false)
    expect(measures(moved.mesh).signedVolume).toBeGreaterThan(0)
    // and the panel line carries the number the operator actually got
    const record = createMeshEditRecord(before.mesh, {
      kind: MOVE_FLAT_FACE_KIND, facets, parameters: { distanceMm: -20, reachedMm: -7.99 },
    })
    expect(describeMeshEdit(record)).toBe(
      'Pushed a flat face in 7.99 mm (20.00 mm asked for; it reaches the face beside it there)',
    )
  })

  it('EXACTLY the room it has is still a stop-short, not a landing on the face below', () => {
    // The audit's one-value hole: 8 mm of plate under the floor, and the
    // operator types the plate thickness he read off the drawing. `-8.0001`
    // clamped; `-8` used to pass straight through and land the floor flat on
    // the bottom face, which is not a solid and said nothing about it.
    expect(POCKET_FLOOR).toBe(8)
    const outcome = flatFaceMoveOutcome(before.mesh, facets, -POCKET_FLOOR)
    expect(outcome.refusal).toBeNull()
    expect(outcome.appliedMm).toBe(-7.99)
    expect(outcome.note).toContain('7.99 mm')
    expect(outcome.note).toContain('8.00 mm')

    const moved = moveThroughTheJournal(before, floor, -POCKET_FLOOR)
    for (const [, , z] of cornersOfSourceFacets(moved.mesh, moved.sourceFacetIds, floor.sourceFacetIds)) {
      expect(z).toBeCloseTo(0.01, 6)
    }
    const now = health(moved.mesh)
    expect(now.watertight).toBe(true)
    expect(now.nonManifoldEdgeCount).toBe(0)
    expect(now.selfIntersections).toBe(false)
    expect(measures(moved.mesh).signedVolume).toBeGreaterThan(0)
  })

  it('and the same at the FOLD limit, pulling the floor up flush with the rim', () => {
    // The other side of the same equality, and the other limit: the pocket
    // walls are exactly 4 mm tall, so +4 is the distance at which they close
    // up. At equality that must clamp too, not hand back a plate with four
    // zero-area walls in it.
    const wallMm = POCKET_TOP - POCKET_FLOOR
    expect(wallMm).toBe(4)
    const outcome = flatFaceMoveOutcome(before.mesh, facets, wallMm)
    expect(outcome.refusal).toBeNull()
    expect(outcome.appliedMm).toBe(3.99)
    expect(outcome.note).toContain('3.99 mm')

    const moved = moveThroughTheJournal(before, floor, wallMm)
    const now = health(moved.mesh)
    expect(now.watertight).toBe(true)
    expect(now.nonManifoldEdgeCount).toBe(0)
    expect(measures(moved.mesh).signedVolume).toBeGreaterThan(0)
  })

  it('NEGATIVE CONTROL: without the stop it would go through the bottom of the plate', () => {
    // The same 20 mm with the limit ignored is what a naive translation does,
    // and it is exactly what the check above exists to prevent: the floor
    // would sit 12 mm BELOW the plate's own bottom face.
    expect(POCKET_FLOOR - 20).toBeLessThan(0)
    const moved = moveThroughTheJournal(before, floor, -20)
    const lowest = Math.min(...cornersOfSourceFacets(moved.mesh, moved.sourceFacetIds, floor.sourceFacetIds)
      .map(([, , z]) => z))
    expect(lowest).toBeGreaterThan(0)
  })
})

// ------------------------------------------ the rim re-solve, and its control

describe('WO-1849: a drafted wall keeps its plane because the rim is re-solved', () => {
  const bytes = draftedBlock()
  const before = part(bytes)
  const top = faceAt(before, [0, 0, 1], 2, 10)
  const moved = moveThroughTheJournal(before, top, 2)
  const after = part(exportBinaryStl(moved.mesh).bytes)

  it('the top face rises 2 mm and SHRINKS, because its corners slid in along the draft', () => {
    expect(top.areaMm2).toBeCloseTo(40 * 20, 3)
    const corners = cornersOfSourceFacets(moved.mesh, moved.sourceFacetIds, top.sourceFacetIds)
    for (const [, , z] of corners) expect(Math.abs(z - 12)).toBeLessThanOrEqual(1e-6)
    const xs = corners.map(([x]) => x)
    const ys = corners.map(([, y]) => y)
    // 45 degrees of draft: 2 mm up is 2 mm in on every side
    expect(Math.min(...xs)).toBeCloseTo(12, 5)
    expect(Math.max(...xs)).toBeCloseTo(48, 5)
    expect(Math.min(...ys)).toBeCloseTo(12, 5)
    expect(Math.max(...ys)).toBeCloseTo(28, 5)
  })

  it('all four drafted walls are still flat, and the part is still a solid', () => {
    const walls = after.faces.filter((f) => Math.abs(f.plane.normal[2]) < 0.999)
    expect(walls).toHaveLength(4)
    for (const wall of walls) expect(wall.maxDeviationMm).toBeLessThanOrEqual(1e-5)
    const now = health(moved.mesh)
    expect(now.watertight).toBe(true)
    expect(now.selfIntersections).toBe(false)
    expect(now.windingConflictEdgeCount).toBe(0)
    expect(measures(moved.mesh).signedVolume).toBeGreaterThan(0)
  })

  it('NEGATIVE CONTROL: skip the rim re-solve and the side-planarity check fails', () => {
    const facets = facetsOf(top, before.sourceFacetIds)
    // the one step removed: every vertex just translates, which is Next's
    // `normal` mode used where `reconstruct` is needed.
    expect(() => moveFlatFace(before.mesh, facets, 2, { resolveNeighbours: false }))
      .toThrow(/tilt the face beside it .* off its own plane/)
    // and with the re-solve in place the same call goes through
    expect(() => moveFlatFace(before.mesh, facets, 2)).not.toThrow()
  })

  it('a drafted wall itself can be pushed out, and the faces it meets stay flat', () => {
    const wall = before.faces.find((f) => f.plane.normal[1] < -0.7)
    expect(wall).toBeDefined()
    const out = moveThroughTheJournal(before, wall!, 1)
    const grown = part(exportBinaryStl(out.mesh).bytes)
    expect(health(out.mesh).watertight).toBe(true)
    expect(measures(out.mesh).volume).toBeGreaterThan(measures(before.mesh).volume)
    for (const face of grown.faces) expect(face.maxDeviationMm).toBeLessThanOrEqual(1e-4)
  })
})

// ---------------------------------------- neighbours that are not planar at all

describe('WO-1849: a face whose neighbour is a curved surface', () => {
  // Next has three modes and this port is all three at once (see the file
  // header): a rim vertex slides along whatever its own neighbours allow. A
  // tessellated cylinder wall is not planar, but each facet of it IS, and
  // every one of them runs along the move - so the top face rises and the
  // cylinder simply gets taller. Nothing is refused that the software can do.
  const bytes = cylinderPart()
  const before = part(bytes)

  it('the top of a cylinder pulls up 3 mm and the wall stays where it was', () => {
    const top = faceAt(before, [0, 0, 1], 2, 10)
    const moved = moveThroughTheJournal(before, top, 3)
    const corners = cornersOfSourceFacets(moved.mesh, moved.sourceFacetIds, top.sourceFacetIds)
    for (const [, , z] of corners) expect(Math.abs(z - 13)).toBeLessThanOrEqual(1e-5)
    const now = health(moved.mesh)
    expect(now.watertight).toBe(true)
    expect(now.selfIntersections).toBe(false)
    const gained = measures(moved.mesh).volume - measures(before.mesh).volume
    expect(gained).toBeCloseTo(top.areaMm2 * 3, 2)
    // the radius did not change: the wall facets each stayed on their own plane
    const radii = cornersOfSourceFacets(moved.mesh, moved.sourceFacetIds, top.sourceFacetIds)
      .filter(([x, y]) => Math.hypot(x, y) > 1e-6)
      .map(([x, y]) => Math.hypot(x, y))
    expect(Math.min(...radii)).toBeCloseTo(10, 4)
    expect(Math.max(...radii)).toBeCloseTo(10, 4)
  })
})

// ------------------------------------------------- what it will not pretend to

describe('WO-1849: what it refuses, and it refuses nothing else', () => {
  const before = part(steppedBlock())
  const top = faceAt(before, [0, 0, 1], 2, 12)
  const facets = facetsOf(top, before.sourceFacetIds)

  it('facets from two different faces are not one flat face, and it says so', () => {
    const other = faceAt(before, [0, 0, -1], 2, 0)
    const mixed = [...facets, ...facetsOf(other, before.sourceFacetIds)]
    const outcome = flatFaceMoveOutcome(before.mesh, mixed, 1)
    expect(outcome.refusal).toMatch(/not all face the same way|not one flat face/)
    expect(outcome.refusal).toContain('Nothing was changed.')
  })

  it('a distance that is not a measurement is named, not swallowed', () => {
    expect(flatFaceMoveOutcome(before.mesh, facets, Number.NaN).refusal)
      .toContain('is not a distance LienCAM can move a face by')
  })

  it('the operation is registered, and it takes no parameter it was not given', () => {
    expect(getMeshEditOperation(MOVE_FLAT_FACE_KIND)).toBe(moveFlatFaceOperation)
    expect(() => moveFlatFaceOperation.validate({ distanceMm: 1, colour: 'red' }))
      .toThrow(/does not take colour/)
    expect(() => moveFlatFaceOperation.validate({})).toThrow(/not a measurement/)
    expect(moveFlatFaceOperation.validate({ distanceMm: -2, reachedMm: -1.5 }))
      .toEqual({ distanceMm: -2, reachedMm: -1.5 })
  })

  it('a record from another version of this edit stops replay instead of meaning something else', () => {
    const record = createMeshEditRecord(before.mesh, {
      kind: MOVE_FLAT_FACE_KIND, facets, parameters: { distanceMm: 1 },
    })
    const stale = { ...record, version: record.version + 1 }
    const replayed = replayMeshEdits(before.mesh, [stale])
    expect(replayed.appliedCount).toBe(0)
    expect(replayed.stopped?.reason).toContain('version')
    expect(replayed.mesh).toBe(before.mesh)
  })
})

// ------------------------------------------------------ through Parallel 3D

describe('WO-1849: through Parallel 3D, the path follows the new height', () => {
  // The whole point of editing an STL: the CUTTER has to see the change. This
  // runs the product's own CAM route - `acquirePartMesh` (the seam every store
  // compute site goes through) into `computeParallel3dMoves` against a real
  // BvhKernel - over the tread that was raised.
  const bytes = steppedBlock()
  let record: MeshEditRecord
  beforeAll(() => {
    const before = part(bytes)
    const top = faceAt(before, [0, 0, 1], 2, 12)
    record = createMeshEditRecord(before.mesh, {
      kind: MOVE_FLAT_FACE_KIND,
      facets: facetsOf(top, before.sourceFacetIds),
      parameters: { distanceMm: 2 },
    })
  })

  function makeClient(): Cam3dClient {
    const kernel = new BvhKernel()
    const fakeWorker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message: unknown): void { dispatcher.handle(message as Cam3dRequest) },
      terminate(): void { /* in-process channel */ },
    }
    const dispatcher = new Cam3dDispatcher(kernel, (msg: Cam3dResponse) => {
      fakeWorker.onmessage?.({ data: msg } as MessageEvent)
    })
    return new Cam3dClient(fakeWorker)
  }

  async function movesOver(edits: MeshEditRecord[]): Promise<ToolpathMove[]> {
    const partMesh = await acquirePartMesh({ format: 'stl', bytes, meshEdits: edits }, 0.05)
    const topZ = partMesh.bounds.max[2]
    const result = await computeParallel3dMoves({
      partMesh,
      tool: makeTool({ id: 't-ball2', name: 'Ball d2', type: 'ball_end_mill', diameter: 2, toolNumber: 1 }),
      params: { ...DEFAULT_PARALLEL3D_PARAMS, stepover: 1, angleDeg: 0, tolerance: 0.05 },
      resolvedHeights: {
        clearanceZ: topZ + 10, retractZ: topZ + 2, feedZ: topZ + 2,
        topZ, retractZ2: undefined, bottomZ: partMesh.bounds.min[2], stockTopZ: topZ,
      } as unknown as Parameters<typeof computeParallel3dMoves>[0]['resolvedHeights'],
      // just over the raised tread, so this stays a seconds-long fixture. The
      // CAM part mesh is in the FILE's own frame (importStlToPartMesh moves
      // nothing), so the left-hand tread is x 0..15, y 0..20.
      boundary: [xyBoundsRing({ minX: 3, minY: 4, maxX: 12, maxY: 16 })],
      boundaryKind: 'selection',
      client: makeClient(),
    })
    return result.moves
  }

  /** How high the cutter is driven over the tread it is cutting. */
  const cuttingTop = (moves: ToolpathMove[]): number => {
    const cutting = moves.filter((m) => m.x > 3 && m.x < 12 && m.y > 4 && m.y < 16)
    expect(cutting.length).toBeGreaterThan(0)
    return Math.max(...cutting.map((m) => m.z))
  }

  it('the tool rides 2 mm higher over the face that was pulled up', async () => {
    const plain = cuttingTop(await movesOver([]))
    const edited = cuttingTop(await movesOver([record]))
    // a 2 mm ball sits with its TIP on the face, so the tip height is the
    // face height: 12 before, 14 after.
    expect(plain).toBeCloseTo(12, 1)
    expect(edited).toBeCloseTo(14, 1)
    expect(edited - plain).toBeCloseTo(2, 1)
  }, 180_000)
})
