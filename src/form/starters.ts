// Form - starter cages: box, cylinder, sphere (quadball), torus, plane.
//
// Every starter sits on the XY plane (lowest point at Z = 0) centred on the Z
// axis, so a finished form lands on the setup's table the way a part would.
// Faces run counter-clockwise seen from outside; closed starters validate
// closed.

import type { Cage, Vec3 } from './cage'
import { edgeKey } from './cage'

export type StarterKind = 'box' | 'cylinder' | 'sphere' | 'torus' | 'plane'

export interface StarterOptions {
  /** overall size in mm: box/plane width (X), depth (Y), height (Z); cylinder
   *  and sphere use x as the diameter and z as the height; torus x as the outer
   *  diameter and z as the tube's diameter */
  size?: { x: number; y: number; z: number }
  /** segment counts: box/plane per axis; cylinder x = around, z = along; sphere x = per cube edge; torus x = around, z = round the tube */
  segments?: { x: number; y: number; z: number }
}

export const STARTER_DEFAULTS: Record<StarterKind, Required<StarterOptions>> = {
  box: { size: { x: 40, y: 40, z: 40 }, segments: { x: 2, y: 2, z: 2 } },
  cylinder: { size: { x: 40, y: 40, z: 30 }, segments: { x: 8, y: 1, z: 2 } },
  sphere: { size: { x: 40, y: 40, z: 40 }, segments: { x: 2, y: 2, z: 2 } },
  torus: { size: { x: 50, y: 50, z: 16 }, segments: { x: 8, y: 1, z: 4 } },
  plane: { size: { x: 60, y: 60, z: 0 }, segments: { x: 4, y: 4, z: 1 } },
}

/** Merges points that land on the same spot (grids meeting at cube edges). */
class PointPool {
  positions: Vec3[] = []
  private byKey = new Map<string, number>()
  add(p: Vec3): number {
    const key = p.map((c) => Math.round(c * 1e6)).join(',')
    const hit = this.byKey.get(key)
    if (hit !== undefined) return hit
    const i = this.positions.length
    this.positions.push([p[0], p[1], p[2]])
    this.byKey.set(key, i)
    return i
  }
}

/** A grid of quads spanning origin + s*u + t*v, faces facing u x v. */
function addGrid(pool: PointPool, faces: number[][], origin: Vec3, u: Vec3, v: Vec3, nu: number, nv: number): void {
  const ids: number[][] = []
  for (let j = 0; j <= nv; j++) {
    const row: number[] = []
    for (let i = 0; i <= nu; i++) {
      const s = i / nu, t = j / nv
      row.push(pool.add([
        origin[0] + s * u[0] + t * v[0],
        origin[1] + s * u[1] + t * v[1],
        origin[2] + s * u[2] + t * v[2],
      ]))
    }
    ids.push(row)
  }
  for (let j = 0; j < nv; j++) {
    for (let i = 0; i < nu; i++) faces.push([ids[j][i], ids[j][i + 1], ids[j + 1][i + 1], ids[j + 1][i]])
  }
}

function seg(n: number | undefined, min: number): number {
  return Math.max(min, Math.round(n ?? min))
}

/** A box cage from -1..1 in each axis, then scaled; the six sides are grids. */
function unitBox(nx: number, ny: number, nz: number): { pool: PointPool; faces: number[][] } {
  const pool = new PointPool()
  const faces: number[][] = []
  // each side: origin corner, u, v with u x v pointing outward
  addGrid(pool, faces, [-1, -1, -1], [0, 2, 0], [2, 0, 0], ny, nx) // bottom (-Z)
  addGrid(pool, faces, [-1, -1, 1], [2, 0, 0], [0, 2, 0], nx, ny) // top (+Z)
  addGrid(pool, faces, [-1, -1, -1], [2, 0, 0], [0, 0, 2], nx, nz) // front (-Y)
  addGrid(pool, faces, [-1, 1, -1], [0, 0, 2], [2, 0, 0], nz, nx) // back (+Y)
  addGrid(pool, faces, [-1, -1, -1], [0, 0, 2], [0, 2, 0], nz, ny) // left (-X)
  addGrid(pool, faces, [1, -1, -1], [0, 2, 0], [0, 0, 2], ny, nz) // right (+X)
  return { pool, faces }
}

export function boxCage(opts: StarterOptions = {}): Cage {
  const d = STARTER_DEFAULTS.box
  const size = opts.size ?? d.size
  const s = opts.segments ?? d.segments
  const { pool, faces } = unitBox(seg(s.x, 1), seg(s.y, 1), seg(s.z, 1))
  const positions = pool.positions.map(([x, y, z]) => [x * size.x / 2, y * size.y / 2, (z + 1) * size.z / 2] as Vec3)
  return { positions, faces, creases: [] }
}

export function sphereCage(opts: StarterOptions = {}): Cage {
  const d = STARTER_DEFAULTS.sphere
  const size = opts.size ?? d.size
  const n = seg((opts.segments ?? d.segments).x, 1)
  const { pool, faces } = unitBox(n, n, n)
  const positions = pool.positions.map(([x, y, z]) => {
    const len = Math.hypot(x, y, z)
    return [x / len * size.x / 2, y / len * size.y / 2, (z / len + 1) * size.z / 2] as Vec3
  })
  return { positions, faces, creases: [] }
}

export function cylinderCage(opts: StarterOptions = {}): Cage {
  const d = STARTER_DEFAULTS.cylinder
  const size = opts.size ?? d.size
  const s = opts.segments ?? d.segments
  const around = seg(s.x, 3)
  const along = seg(s.z, 1)
  const rx = size.x / 2, ry = size.y / 2
  const positions: Vec3[] = []
  const ring = (k: number) => k * around
  for (let k = 0; k <= along; k++) {
    const z = (k / along) * size.z
    for (let i = 0; i < around; i++) {
      const t = (2 * Math.PI * i) / around
      positions.push([rx * Math.cos(t), ry * Math.sin(t), z])
    }
  }
  const faces: number[][] = []
  for (let k = 0; k < along; k++) {
    for (let i = 0; i < around; i++) {
      const j = (i + 1) % around
      faces.push([ring(k) + i, ring(k) + j, ring(k + 1) + j, ring(k + 1) + i])
    }
  }
  // caps: one n-gon each (Catmull-Clark turns it into a quad fan round a centre point)
  const bottom: number[] = []
  const top: number[] = []
  for (let i = 0; i < around; i++) {
    bottom.push(ring(0) + (around - i) % around)
    top.push(ring(along) + i)
  }
  faces.push(bottom, top)
  return { positions, faces, creases: [] }
}

/** A torus lying on the table: every point has four edges, so its whole limit surface is regular. */
export function torusCage(opts: StarterOptions = {}): Cage {
  const d = STARTER_DEFAULTS.torus
  const size = opts.size ?? d.size
  const s = opts.segments ?? d.segments
  const around = seg(s.x, 3)
  const tube = seg(s.z, 3)
  const r = size.z / 2
  const R = Math.max(r * 1.01, size.x / 2 - r)
  const positions: Vec3[] = []
  for (let i = 0; i < around; i++) {
    const u = (2 * Math.PI * i) / around
    for (let j = 0; j < tube; j++) {
      const v = (2 * Math.PI * j) / tube
      positions.push([(R + r * Math.cos(v)) * Math.cos(u), (R + r * Math.cos(v)) * Math.sin(u), r + r * Math.sin(v)])
    }
  }
  const id = (i: number, j: number) => (i % around) * tube + (j % tube)
  const faces: number[][] = []
  for (let i = 0; i < around; i++) for (let j = 0; j < tube; j++) faces.push([id(i, j), id(i + 1, j), id(i + 1, j + 1), id(i, j + 1)])
  return { positions, faces, creases: [] }
}

export function planeCage(opts: StarterOptions = {}): Cage {
  const d = STARTER_DEFAULTS.plane
  const size = opts.size ?? d.size
  const s = opts.segments ?? d.segments
  const pool = new PointPool()
  const faces: number[][] = []
  addGrid(pool, faces, [-size.x / 2, -size.y / 2, 0], [size.x, 0, 0], [0, size.y, 0], seg(s.x, 1), seg(s.y, 1))
  return { positions: pool.positions, faces, creases: [] }
}

export function starterCage(kind: StarterKind, opts: StarterOptions = {}): Cage {
  switch (kind) {
    case 'box': return boxCage(opts)
    case 'cylinder': return cylinderCage(opts)
    case 'sphere': return sphereCage(opts)
    case 'torus': return torusCage(opts)
    case 'plane': return planeCage(opts)
  }
}

/** Crease every edge of the cage whose two points both sit at height z (a flat bottom rim). */
export function creaseRimAt(cage: Cage, z: number): Cage {
  const creases = new Set(cage.creases)
  for (const face of cage.faces) {
    for (let i = 0; i < face.length; i++) {
      const a = face[i], b = face[(i + 1) % face.length]
      if (Math.abs(cage.positions[a][2] - z) < 1e-9 && Math.abs(cage.positions[b][2] - z) < 1e-9) creases.add(edgeKey(a, b))
    }
  }
  return { ...cage, creases: [...creases] }
}
