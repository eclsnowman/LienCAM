// WO-1543: a model body whose Model Item Placement tilts it off the Z axis
// used to be refused by both Section at Z and the whole-body profile derive
// (LIENCAM rule 11 - the software CAN do both). The rule this file pins: a
// body at any placement gives the Section at Z / profile the operator would
// get by first applying that placement to the body, then cutting it at world
// Z or outlining it in world XY. Expected values here come from an
// independent convex-polytope slice of the placed block, never from the
// derive module's own slicing primitives.

import { describe, it, expect } from 'vitest'
import type { ImportedGeometry, Loop2D } from '../../types'
import type { ModelItemPlacementRegistryEntry } from '../../lib/cam/modelItemPlacement'
import { deriveModelBodyProfile, deriveModelBodySection } from '../../lib/cam/modelBodyDerive'
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

const placement = (geo: ImportedGeometry, position: Pt3, rotation: Pt3): ModelItemPlacementRegistryEntry[] => [
  { modelItemId: geo.modelItemId!, position, rotation },
]

function area(pts: readonly Pt2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const j = (i + 1) % pts.length
    a += pts[i].x * pts[j].y - pts[j].x * pts[i].y
  }
  return Math.abs(a) / 2
}
function bounds(pts: readonly Pt2[]) {
  return {
    minX: Math.min(...pts.map(p => p.x)), maxX: Math.max(...pts.map(p => p.x)),
    minY: Math.min(...pts.map(p => p.y)), maxY: Math.max(...pts.map(p => p.y)),
  }
}
/** Convex hull ordering of a point cloud around its centroid. */
function convexRing(pts: readonly Pt2[]): Pt2[] {
  const cx = pts.reduce((s, p) => s + p.x, 0) / pts.length
  const cy = pts.reduce((s, p) => s + p.y, 0) / pts.length
  return [...pts].sort((a, b) => Math.atan2(a.y - cy, a.x - cx) - Math.atan2(b.y - cy, b.x - cx))
}
/** Hull of a point set (monotone chain) - for the projected-corner outline. */
function hull(points: readonly Pt2[]): Pt2[] {
  const p = [...points].sort((a, b) => a.x - b.x || a.y - b.y)
  const cross = (o: Pt2, a: Pt2, b: Pt2) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x)
  const lower: Pt2[] = []
  for (const q of p) { while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], q) <= 0) lower.pop(); lower.push(q) }
  const upper: Pt2[] = []
  for (const q of [...p].reverse()) { while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], q) <= 0) upper.pop(); upper.push(q) }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)]
}

// A 40x20x10 block, local X -20..20, Y -10..10, Z 0..10.
const BLOCK_MIN = { x: -20, y: -10, z: 0 }
const BLOCK_MAX = { x: 20, y: 10, z: 10 }
const TILT_POSITION = { x: 5, y: -7, z: 3 }
const TILT_ROTATION = { x: 30, y: 0, z: 0 }

/** The block's 8 corners placed in world: its own Rx(30) then translation. */
function placedBlockCorners(): Pt3[] {
  const a = (30 * Math.PI) / 180
  const out: Pt3[] = []
  for (const x of [BLOCK_MIN.x, BLOCK_MAX.x]) for (const y of [BLOCK_MIN.y, BLOCK_MAX.y]) for (const z of [BLOCK_MIN.z, BLOCK_MAX.z]) {
    out.push({
      x: x + TILT_POSITION.x,
      y: y * Math.cos(a) - z * Math.sin(a) + TILT_POSITION.y,
      z: y * Math.sin(a) + z * Math.cos(a) + TILT_POSITION.z,
    })
  }
  return out
}

/** Independent slice of the placed (convex) block at world Z: intersect every
 *  box edge with the plane and order the hits into a convex ring. */
function independentSection(worldZ: number): Pt2[] {
  const c = placedBlockCorners()
  const hits: Pt2[] = []
  for (let i = 0; i < 8; i++) for (let j = i + 1; j < 8; j++) {
    // Box edges join corners differing in exactly one of the x/y/z bits.
    const diff = i ^ j
    if (diff !== 1 && diff !== 2 && diff !== 4) continue
    const p = c[i], q = c[j]
    if ((p.z - worldZ) * (q.z - worldZ) >= 0) continue
    const t = (worldZ - p.z) / (q.z - p.z)
    hits.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) })
  }
  return convexRing(hits)
}

const blockMesh = () => gridSolid([-20, 20], [-10, 10], [0, 10], () => true)

describe('WO-1543: a tilted model body sections and derives its profile', () => {
  it('Section at a world Z through a block tilted 30 deg about X matches an independent slice of the placed block', () => {
    const geo = modelGeo('tilt-block', blockMesh(), BLOCK_MIN, BLOCK_MAX)
    const zs = placedBlockCorners().map(p => p.z)
    const worldZ = (Math.min(...zs) + Math.max(...zs)) / 2

    const { loops, z } = deriveModelBodySection(geo, worldZ, placement(geo, TILT_POSITION, TILT_ROTATION))
    expect(z).toBe(worldZ)
    expect(loops).toHaveLength(1)
    expect(loops[0].type).toBe('contour')
    expect(loops[0].closed).toBe(true)

    const expected = independentSection(worldZ)
    expect(area(loops[0].points)).toBeCloseTo(area(expected), 0)
    expect(Math.abs(area(loops[0].points) - area(expected))).toBeLessThan(2)
    const got = bounds(loops[0].points), want = bounds(expected)
    for (const k of ['minX', 'maxX', 'minY', 'maxY'] as const) {
      expect(Math.abs(got[k] - want[k])).toBeLessThan(0.05)
    }
  })

  it('refuses a world Z outside the placed (tilted) body, naming the placed range', () => {
    const geo = modelGeo('tilt-block-range', blockMesh(), BLOCK_MIN, BLOCK_MAX)
    // Placed range is [-2.000, 16.660]; local range + position.z would be [3, 13].
    expect(() => deriveModelBodySection(geo, 16, placement(geo, TILT_POSITION, TILT_ROTATION))).not.toThrow()
    expect(() => deriveModelBodySection(geo, 20, placement(geo, TILT_POSITION, TILT_ROTATION)))
      .toThrow(/\[-2\.000, 16\.660\]/)
  })

  it('the tilted block\'s derived profile is its world-XY outline', () => {
    const geo = modelGeo('tilt-block-profile', blockMesh(), BLOCK_MIN, BLOCK_MAX)
    const { loops } = deriveModelBodyProfile(geo, placement(geo, TILT_POSITION, TILT_ROTATION))
    expect(loops).toHaveLength(1)
    expect(loops[0].type).toBe('contour')

    const expected = hull(placedBlockCorners().map(p => ({ x: p.x, y: p.y })))
    // 40 x (20 cos30 + 10 sin30) = 892.8 mm2 - the whole shadow, not a near-bottom sliver.
    expect(Math.abs(area(loops[0].points) - area(expected))).toBeLessThan(2)
    const got = bounds(loops[0].points), want = bounds(expected)
    for (const k of ['minX', 'maxX', 'minY', 'maxY'] as const) {
      expect(Math.abs(got[k] - want[k])).toBeLessThan(0.05)
    }
  })

  it('a tilted plate with a through-hole outlines as a contour plus the hole still seen through it', () => {
    // 40x20x10 plate with a 10x10 square hole along local Z. Tilted 30 deg
    // about X the opening seen from above is 10 x (10 cos30 - 10 sin30) = 36.6 mm2.
    const mesh = gridSolid([-20, -5, 5, 20], [-10, -5, 5, 10], [0, 10], (x, y) => !(Math.abs(x) < 5 && Math.abs(y) < 5))
    const geo = modelGeo('tilt-plate', mesh, BLOCK_MIN, BLOCK_MAX)
    const { loops } = deriveModelBodyProfile(geo, placement(geo, TILT_POSITION, TILT_ROTATION))
    const contours = loops.filter((l: Loop2D) => l.type === 'contour')
    const holes = loops.filter((l: Loop2D) => l.type === 'hole')
    expect(contours).toHaveLength(1)
    expect(holes).toHaveLength(1)
    expect(Math.abs(area(contours[0].points) - 892.82)).toBeLessThan(2)
    expect(Math.abs(area(holes[0].points) - 10 * (10 * Math.cos(Math.PI / 6) - 5))).toBeLessThan(1)
  })

  it('an upside-down (flipped 180 deg about X) body sections and profiles instead of refusing', () => {
    const geo = modelGeo('flip-block', blockMesh(), BLOCK_MIN, BLOCK_MAX)
    const p = placement(geo, { x: 0, y: 0, z: 10 }, { x: 180, y: 0, z: 0 })
    const section = deriveModelBodySection(geo, 5, p)
    expect(section.loops).toHaveLength(1)
    expect(Math.abs(area(section.loops[0].points) - 800)).toBeLessThan(1)
    const profile = deriveModelBodyProfile(geo, p)
    expect(profile.loops).toHaveLength(1)
    expect(Math.abs(area(profile.loops[0].points) - 800)).toBeLessThan(1)
  })

  it('an un-tilted body (Z-only rotation + translation) still slices locally and rotates the loops, exactly as before', () => {
    const mesh = blockMesh()
    const geo = modelGeo('upright-block', mesh, BLOCK_MIN, BLOCK_MAX)
    const pose = { position: { x: 4, y: -6, z: 2 }, rotation: { x: 0, y: 0, z: 37 } }
    const p = placement(geo, pose.position, pose.rotation)
    const positions = Float32Array.from(mesh.positions)
    const indices = Uint32Array.from(mesh.indices)
    const opts = { simplificationTolerance: 0.02, minPerimeter: 0.12 }

    const section = deriveModelBodySection(geo, 7, p)
    const localSection = projectSTLToLoops(positions, indices, { ...opts, sliceZ: 7 - pose.position.z }).loops
    expect(section.loops.map(l => l.points)).toEqual(localSection.map(l => transformLoopPoints(l.points, pose)))

    const profile = deriveModelBodyProfile(geo, p)
    const localProfile = projectSTLToLoops(positions, indices, opts).loops
    expect(profile.loops.map(l => l.points)).toEqual(localProfile.map(l => transformLoopPoints(l.points, pose)))
  })
})
