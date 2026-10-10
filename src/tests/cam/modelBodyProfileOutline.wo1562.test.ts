// WO-1562: a model body's derived profile is its top-down outline (the body
// seen from world +Z), upright or tilted. A profile is cut from above, so a
// tool following the stem of an upright T under its flange would cut into the
// flange; before this, an upright body got a slice just above its bottom and a
// body tilted even 0.02 deg got its outline - the result jumped at the tilt
// threshold. Expected values are hand-computed from the fixture dimensions.

import { describe, it, expect } from 'vitest'
import type { ImportedGeometry, Loop2D } from '../../types'
import type { ModelItemPlacementRegistryEntry } from '../../lib/cam/modelItemPlacement'
import { deriveModelBodyProfile } from '../../lib/cam/modelBodyDerive'
import { projectSTLToLoops } from '../../lib/geometry/stlProjection'
import { transformLoopPoints } from '../../store/dispatchGeo'

interface Pt2 { x: number; y: number }
interface Pt3 { x: number; y: number; z: number }

/** Closed voxel-grid solid (every exterior cell face, two triangles each). */
function gridSolid(xs: number[], ys: number[], zs: number[], solid: (x: number, y: number, z: number) => boolean) {
  const nx = xs.length, ny = ys.length
  const positions: number[] = []
  for (const z of zs) for (const y of ys) for (const x of xs) positions.push(x, y, z)
  const v = (i: number, j: number, k: number) => i + nx * (j + ny * k)
  const filled = (i: number, j: number, k: number) =>
    i >= 0 && j >= 0 && k >= 0 && i < nx - 1 && j < ny - 1 && k < zs.length - 1 &&
    solid((xs[i] + xs[i + 1]) / 2, (ys[j] + ys[j + 1]) / 2, (zs[k] + zs[k + 1]) / 2)
  const indices: number[] = []
  const quad = (a: number, b: number, c: number, d: number) => indices.push(a, b, c, a, c, d)
  for (let k = 0; k < zs.length - 1; k++) for (let j = 0; j < ny - 1; j++) for (let i = 0; i < nx - 1; i++) {
    if (!filled(i, j, k)) continue
    if (!filled(i - 1, j, k)) quad(v(i, j, k), v(i, j + 1, k), v(i, j + 1, k + 1), v(i, j, k + 1))
    if (!filled(i + 1, j, k)) quad(v(i + 1, j, k), v(i + 1, j, k + 1), v(i + 1, j + 1, k + 1), v(i + 1, j + 1, k))
    if (!filled(i, j - 1, k)) quad(v(i, j, k), v(i, j, k + 1), v(i + 1, j, k + 1), v(i + 1, j, k))
    if (!filled(i, j + 1, k)) quad(v(i, j + 1, k), v(i + 1, j + 1, k), v(i + 1, j + 1, k + 1), v(i, j + 1, k + 1))
    if (!filled(i, j, k - 1)) quad(v(i, j, k), v(i + 1, j, k), v(i + 1, j + 1, k), v(i, j + 1, k))
    if (!filled(i, j, k + 1)) quad(v(i, j, k + 1), v(i, j + 1, k + 1), v(i + 1, j + 1, k + 1), v(i + 1, j, k + 1))
  }
  return { positions, indices }
}

function modelGeo(id: string, mesh: { positions: number[]; indices: number[] }, min: Pt3, max: Pt3): ImportedGeometry {
  return {
    id, name: id, filename: '', type: 'model', format: 'model',
    boundingBox: {
      min, max,
      size: { x: max.x - min.x, y: max.y - min.y, z: max.z - min.z },
      center: { x: (min.x + max.x) / 2, y: (min.y + max.y) / 2, z: (min.z + max.z) / 2 },
    },
    position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, loaded: true,
    modelItemId: `item-${id}`,
    modelBody: {
      ref: { bodyId: `${id}-body`, stableIds: [`${id}-body:F0`], version: 1 },
      display: {
        positions: mesh.positions, normals: [], indices: mesh.indices,
        edgePositions: [], edgeOffsets: [], bbox: { min, max },
      },
    },
  } as unknown as ImportedGeometry
}

const placed = (geo: ImportedGeometry, rotation: Pt3 = { x: 0, y: 0, z: 0 }, position: Pt3 = { x: 0, y: 0, z: 0 }):
  ModelItemPlacementRegistryEntry[] => [{ modelItemId: geo.modelItemId!, position, rotation }]

function area(pts: readonly Pt2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return Math.abs(a) / 2
}
function bounds(loops: readonly Loop2D[]) {
  const pts = loops.flatMap(l => l.points)
  return {
    minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)),
    minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)),
  }
}
const contours = (loops: readonly Loop2D[]) => loops.filter(l => l.type === 'contour')
const holes = (loops: readonly Loop2D[]) => loops.filter(l => l.type === 'hole')

const MIN = { x: -20, y: -10, z: 0 }
const XS = [-20, -5, 5, 20]
const YS = [-10, -5, 5, 10]
const inStem = (x: number, y: number) => Math.abs(x) < 5 && Math.abs(y) < 5

/** 10x10 stem (Z 0..10) under a 40x20 flange (Z 10..15). */
const tShape = () => modelGeo('t-shape', gridSolid(XS, YS, [0, 10, 15], (x, y, z) => z > 10 || inStem(x, y)), MIN, { x: 20, y: 10, z: 15 })
/** 40x20x10 plate with a 10x10 pocket open at the bottom, 6 deep. */
const bottomPocketPlate = () => modelGeo('bottom-pocket', gridSolid(XS, YS, [0, 6, 10], (x, y, z) => !(z < 6 && inStem(x, y))), MIN, { x: 20, y: 10, z: 10 })
/** 40x20x10 plate with a 10x10 through-hole. */
const throughHolePlate = () => modelGeo('through-hole', gridSolid(XS, YS, [0, 10], (x, y) => !inStem(x, y)), MIN, { x: 20, y: 10, z: 10 })

describe('WO-1562: the derived profile is the top-down outline at any tilt', () => {
  it('an upright T (flange on top) profiles as the 800 mm2 flange outline, and the same at 0.009 and 0.02 deg', () => {
    for (const tilt of [0, 0.009, 0.02]) {
      const geo = tShape()
      const { loops } = deriveModelBodyProfile(geo, placed(geo, { x: tilt, y: 0, z: 0 }))
      expect(contours(loops), `tilt ${tilt}`).toHaveLength(1)
      expect(holes(loops), `tilt ${tilt}`).toHaveLength(0)
      expect(Math.abs(area(loops[0].points) - 800), `tilt ${tilt}`).toBeLessThan(1)
      const b = bounds(loops)
      expect(b.maxX - b.minX, `tilt ${tilt}`).toBeCloseTo(40, 1)
      expect(b.maxY - b.minY, `tilt ${tilt}`).toBeCloseTo(20, 1)
    }
  })

  it('is continuous across the tilt threshold: 0 and 0.02 deg give the same outline within tolerance', () => {
    const geo = tShape()
    const upright = deriveModelBodyProfile(geo, placed(geo)).loops
    const tilted = deriveModelBodyProfile(geo, placed(geo, { x: 0.02, y: 0, z: 0 })).loops
    expect(upright.length).toBe(tilted.length)
    expect(Math.abs(area(upright[0].points) - area(tilted[0].points))).toBeLessThan(1)
    const a = bounds(upright), b = bounds(tilted)
    for (const k of ['minX', 'maxX', 'minY', 'maxY'] as const) expect(Math.abs(a[k] - b[k])).toBeLessThan(0.05)
  })

  it('an upright T rotated about Z and moved gets its flange outline rotated and moved', () => {
    const geo = tShape()
    const { loops } = deriveModelBodyProfile(geo, placed(geo, { x: 0, y: 0, z: 90 }, { x: 100, y: 50, z: 3 }))
    expect(contours(loops)).toHaveLength(1)
    expect(Math.abs(area(loops[0].points) - 800)).toBeLessThan(1)
    const b = bounds(loops)
    expect(b.minX).toBeCloseTo(90, 1)
    expect(b.maxX).toBeCloseTo(110, 1)
    expect(b.minY).toBeCloseTo(30, 1)
    expect(b.maxY).toBeCloseTo(70, 1)
  })

  it('a plate with a pocket open at the bottom has no hole, upright or tilted 0.02 deg', () => {
    for (const tilt of [0, 0.02]) {
      const geo = bottomPocketPlate()
      const { loops } = deriveModelBodyProfile(geo, placed(geo, { x: tilt, y: 0, z: 0 }))
      expect(contours(loops), `tilt ${tilt}`).toHaveLength(1)
      expect(holes(loops), `tilt ${tilt}`).toHaveLength(0)
      expect(Math.abs(area(loops[0].points) - 800), `tilt ${tilt}`).toBeLessThan(1)
    }
  })

  it('a through-hole plate keeps its hole, upright or tilted 0.02 deg', () => {
    for (const tilt of [0, 0.02]) {
      const geo = throughHolePlate()
      const { loops } = deriveModelBodyProfile(geo, placed(geo, { x: tilt, y: 0, z: 0 }))
      expect(contours(loops), `tilt ${tilt}`).toHaveLength(1)
      expect(holes(loops), `tilt ${tilt}`).toHaveLength(1)
      expect(Math.abs(area(contours(loops)[0].points) - 800), `tilt ${tilt}`).toBeLessThan(1)
      expect(Math.abs(area(holes(loops)[0].points) - 100), `tilt ${tilt}`).toBeLessThan(1)
    }
  })

  it('a hole counterbored from below keeps only the opening seen from above', () => {
    // 4x4 through-hole, widened to 10x10 for the bottom 4 mm.
    const xs = [-20, -5, -2, 2, 5, 20], ys = [-10, -5, -2, 2, 5, 10]
    const mesh = gridSolid(xs, ys, [0, 4, 10], (x, y, z) =>
      !(Math.abs(x) < 2 && Math.abs(y) < 2) && !(z < 4 && inStem(x, y)))
    const geo = modelGeo('under-counterbore', mesh, MIN, { x: 20, y: 10, z: 10 })
    const { loops } = deriveModelBodyProfile(geo, placed(geo))
    expect(holes(loops)).toHaveLength(1)
    expect(Math.abs(area(holes(loops)[0].points) - 16)).toBeLessThan(0.5)
  })

  it('a prismatic upright body gives exactly the slice it gave before (ids and points)', () => {
    const pose = { position: { x: 4, y: -6, z: 2 }, rotation: { x: 0, y: 0, z: 37 } }
    const opts = { simplificationTolerance: 0.02, minPerimeter: 0.12 }
    for (const geo of [throughHolePlate(), modelGeo('block', gridSolid([-20, 20], [-10, 10], [0, 10], () => true), MIN, { x: 20, y: 10, z: 10 })]) {
      const display = geo.modelBody!.display!
      const local = projectSTLToLoops(Float32Array.from(display.positions), Uint32Array.from(display.indices), opts).loops
      const { loops } = deriveModelBodyProfile(geo, placed(geo, pose.rotation, pose.position))
      const byId = (ls: ReadonlyArray<{ id: string; points: Pt2[] }>) => [...ls].sort((a, b) => a.id.localeCompare(b.id))
      expect(byId(loops.map(l => ({ id: l.id, points: l.points }))))
        .toEqual(byId(local.map(l => ({ id: l.id, points: transformLoopPoints(l.points, pose) }))))
    }
  })
})
