// Form - topology operations on the cage. Every operation is a pure
// Cage -> Cage function; the Form store validates the result (halfEdge.ts)
// before it replaces the cage, and records the old cage for undo.

import type { Cage, Vec3 } from './cage'
import { cloneCage, edgeKey, parseEdgeKey, remapWeights } from './cage'

/** What is selected on the cage. Mixed selections are allowed. */
export interface CageSelection {
  points: number[]
  /** edge keys (edgeKey(a, b)) */
  edges: string[]
  faces: number[]
}

export const EMPTY_SELECTION: CageSelection = { points: [], edges: [], faces: [] }

export function isSelectionEmpty(s: CageSelection): boolean {
  return s.points.length === 0 && s.edges.length === 0 && s.faces.length === 0
}

/** Every cage point a selection moves: its points, both ends of its edges, every corner of its faces. */
export function selectionPoints(cage: Cage, s: CageSelection): number[] {
  const out = new Set<number>()
  for (const p of s.points) if (p >= 0 && p < cage.positions.length) out.add(p)
  for (const key of s.edges) {
    const [a, b] = parseEdgeKey(key)
    out.add(a)
    out.add(b)
  }
  for (const f of s.faces) for (const p of cage.faces[f] ?? []) out.add(p)
  return [...out].sort((a, b) => a - b)
}

export function centroidOf(cage: Cage, points: readonly number[]): Vec3 {
  const c: Vec3 = [0, 0, 0]
  if (points.length === 0) return c
  for (const p of points) for (let k = 0; k < 3; k++) c[k] += cage.positions[p][k]
  return [c[0] / points.length, c[1] / points.length, c[2] / points.length]
}

/** Area-weighted outward normal of a set of faces (Newell), normalised; [0,0,1] when degenerate. */
export function facesNormal(cage: Cage, faces: readonly number[]): Vec3 {
  let nx = 0, ny = 0, nz = 0
  for (const f of faces) {
    const loop = cage.faces[f]
    for (let i = 0; i < loop.length; i++) {
      const a = cage.positions[loop[i]]
      const b = cage.positions[loop[(i + 1) % loop.length]]
      nx += (a[1] - b[1]) * (a[2] + b[2])
      ny += (a[2] - b[2]) * (a[0] + b[0])
      nz += (a[0] - b[0]) * (a[1] + b[1])
    }
  }
  const len = Math.hypot(nx, ny, nz)
  return len > 1e-12 ? [nx / len, ny / len, nz / len] : [0, 0, 1]
}

/**
 * Apply a 4x4 column-major matrix (three.js Matrix4.elements order) to the
 * given points, reading from `from` (the positions when the drag began) so a
 * drag never accumulates rounding.
 */
export function transformPoints(cage: Cage, from: readonly Vec3[], points: readonly number[], m: ArrayLike<number>, weights?: readonly number[]): Cage {
  const positions = cage.positions.slice()
  points.forEach((p, i) => {
    const [x, y, z] = from[i]
    const w = m[3] * x + m[7] * y + m[11] * z + m[15] || 1
    const t: Vec3 = [
      (m[0] * x + m[4] * y + m[8] * z + m[12]) / w,
      (m[1] * x + m[5] * y + m[9] * z + m[13]) / w,
      (m[2] * x + m[6] * y + m[10] * z + m[14]) / w,
    ]
    // a soft point goes part of the way: from + weight * (moved - from)
    const k = weights?.[i] ?? 1
    positions[p] = k === 1 ? t : [x + k * (t[0] - x), y + k * (t[1] - y), z + k * (t[2] - z)]
  })
  return { ...cage, positions }
}

/**
 * Soft modification: every other point within `radius` of the selection
 * follows a move part of the way - weight 1 at the selection falling smoothly
 * to 0 at the radius (1 - 3t^2 + 2t^3 of the straight-line distance to the
 * nearest selected point, t = distance / radius).
 */
export function softWeights(cage: Cage, points: readonly number[], radius: number): Map<number, number> {
  const out = new Map<number, number>()
  if (!(radius > 0) || points.length === 0) return out
  const chosen = new Set(points)
  cage.positions.forEach((q, i) => {
    if (chosen.has(i)) return
    let d = Infinity
    for (const p of points) {
      const s = cage.positions[p]
      d = Math.min(d, Math.hypot(q[0] - s[0], q[1] - s[1], q[2] - s[2]))
    }
    const t = d / radius
    if (t < 1) out.set(i, 1 - 3 * t * t + 2 * t * t * t)
  })
  return out
}

export interface ExtrudeResult {
  cage: Cage
  /** the extruded faces (same indices as before: they keep their slot, their points moved) */
  faces: number[]
  /** the points that ride with the extruded faces (new copies on the region's rim, plus its interior points) */
  movedPoints: number[]
  /** the new side faces */
  sideFaces: number[]
}

/**
 * Extrude a region of faces: points on the region's rim are copied, the
 * region's faces move onto the copies, and one side quad joins each rim edge
 * to its copy. The copies start where the originals are; the caller moves
 * `movedPoints` (the drag does that). Orientation is kept: a side quad runs
 * the rim edge in the direction the region's face ran it.
 */
export function extrudeFaces(cage: Cage, faceIds: readonly number[]): ExtrudeResult {
  const region = new Set(faceIds.filter((f) => f >= 0 && f < cage.faces.length))
  const next = cloneCage(cage)
  if (region.size === 0) return { cage: next, faces: [], movedPoints: [], sideFaces: [] }

  // faces around each point, to tell rim points from interior ones
  const facesOfPoint = new Map<number, number[]>()
  cage.faces.forEach((loop, f) => {
    for (const p of loop) {
      const list = facesOfPoint.get(p)
      if (list) list.push(f)
      else facesOfPoint.set(p, [f])
    }
  })
  // how many region faces use each undirected edge
  const regionEdgeUse = new Map<string, number>()
  cage.faces.forEach((loop, f) => {
    for (let i = 0; i < loop.length; i++) {
      const key = edgeKey(loop[i], loop[(i + 1) % loop.length])
      if (region.has(f)) regionEdgeUse.set(key, (regionEdgeUse.get(key) ?? 0) + 1)
    }
  })

  // points on a rim edge (a region edge used by one region face, open edges included)
  const onRim = new Set<number>()
  for (const f of region) {
    const loop = cage.faces[f]
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      if ((regionEdgeUse.get(edgeKey(a, b)) ?? 0) === 1) { onRim.add(a); onRim.add(b) }
    }
  }
  const copyOf = new Map<number, number>()
  const moved = new Set<number>()
  for (const f of region) {
    for (const p of cage.faces[f]) {
      if (copyOf.has(p) || moved.has(p)) continue
      const interior = !onRim.has(p) && (facesOfPoint.get(p) ?? []).every((g) => region.has(g))
      if (interior) {
        moved.add(p)
      } else {
        const q = next.positions.length
        next.positions.push([cage.positions[p][0], cage.positions[p][1], cage.positions[p][2]])
        copyOf.set(p, q)
        moved.add(q)
      }
    }
  }
  const mapped = (p: number) => copyOf.get(p) ?? p

  const sideFaces: number[] = []
  for (const f of region) {
    const loop = cage.faces[f]
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i]
      const b = loop[(i + 1) % loop.length]
      const key = edgeKey(a, b)
      // a rim edge: used by exactly one region face (an open edge of the cage counts too)
      if ((regionEdgeUse.get(key) ?? 0) !== 1) continue
      sideFaces.push(next.faces.length)
      next.faces.push([a, b, mapped(b), mapped(a)])
    }
    next.faces[f] = loop.map(mapped)
  }

  // creases inside the region follow the region's points; rim creases stay on the rim
  next.creases = cage.creases.map((key) => {
    const [a, b] = parseEdgeKey(key)
    return (regionEdgeUse.get(key) ?? 0) >= 2 ? edgeKey(mapped(a), mapped(b)) : key
  })
  next.weights = remapWeights(cage.weights, (key) => {
    const [a, b] = parseEdgeKey(key)
    return (regionEdgeUse.get(key) ?? 0) >= 2 ? edgeKey(mapped(a), mapped(b)) : key
  })
  if (next.weights === undefined) delete next.weights

  return { cage: next, faces: [...region].sort((x, y) => x - y), movedPoints: [...moved].sort((x, y) => x - y), sideFaces }
}
