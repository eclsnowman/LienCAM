// Form - symmetry: a mirror across a plane - X = 0, Y = 0, a Z plane, one of
// those moved along its axis, or any plane the operator places (mode 'p', its
// own normal) - or circular symmetry (N copies round the Z axis). A mirror
// plane is n . p = at.
//
// With symmetry on, every cage point is matched to its images under the
// symmetry's transforms (found by position): its mirror image, or its N - 1
// rotated copies. Points each transform leaves in place (on the mirror plane,
// on the Z axis) are seam points. After any move the moved point wins: its
// images are set from it, and seam points are held on the plane or axis.
// Selections are widened to their images before a topology command runs, so an
// extrude, crease or edge loop on one copy happens on all.

import type { Cage, Vec3 } from './cage'
import { cageBounds, edgeKey, parseEdgeKey } from './cage'
import type { CageSelection } from './topology'
import { principalAxes } from './shapeTools'

export type SymmetryAxis = 'x' | 'y' | 'z'
/** a mirror across an axis plane, 'p' a mirror across a placed plane (its normal kept beside it), or `c<N>`: N-fold circular symmetry round the Z axis */
export type SymmetryMode = SymmetryAxis | 'p' | `c${number}`
const AXIS_NORMAL: Record<SymmetryAxis, Vec3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] }

/** N for a circular mode (2..24), null for a mirror. */
export function circularCount(mode: SymmetryMode): number | null {
  if (mode === 'x' || mode === 'y' || mode === 'z' || mode === 'p') return null
  const n = Number(mode.slice(1))
  return Number.isInteger(n) && n >= 2 && n <= 24 ? n : null
}

export function isSymmetryMode(v: unknown): v is SymmetryMode {
  return v === 'x' || v === 'y' || v === 'z' || v === 'p' || (typeof v === 'string' && /^c\d+$/.test(v) && circularCount(v as SymmetryMode) !== null)
}

export interface SymmetryPairs {
  mode: SymmetryMode
  /** the mirror plane n . p = at (mirrors only; normal null for circular) */
  at: number
  normal: Vec3 | null
  /** images[t][p] = p's image under the t-th transform (p itself on the seam, -1 when none matches) */
  images: Int32Array[]
  /** images[0]: the mirror partner */
  partner: Int32Array
  seam: Uint8Array
}

/** A mirror's unit normal: its axis, or the placed plane's own (normalised); null for circular. */
export function mirrorNormal(mode: SymmetryMode, normal?: Vec3 | null): Vec3 | null {
  if (mode === 'x' || mode === 'y' || mode === 'z') return AXIS_NORMAL[mode]
  if (mode !== 'p') return null
  const l = normal ? Math.hypot(normal[0], normal[1], normal[2]) : 0
  return normal && l > 0 ? [normal[0] / l, normal[1] / l, normal[2] / l] : AXIS_NORMAL.x
}

/** signed distance of p from the plane n . p = at */
const side = (n: Vec3, at: number, p: Vec3) => n[0] * p[0] + n[1] * p[1] + n[2] * p[2] - at

/** The symmetry's transforms other than the identity. */
function transforms(mode: SymmetryMode, at: number, normal: Vec3 | null): Array<(p: Vec3) => Vec3> {
  const n = circularCount(mode)
  if (n === null) {
    const u = normal ?? AXIS_NORMAL.x
    return [(p) => { const d = 2 * side(u, at, p); return [p[0] - d * u[0], p[1] - d * u[1], p[2] - d * u[2]] }]
  }
  return Array.from({ length: n - 1 }, (_, i) => {
    const a = (2 * Math.PI * (i + 1)) / n, c = Math.cos(a), s = Math.sin(a)
    return (p: Vec3): Vec3 => [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]]
  })
}

function onSeam(normal: Vec3 | null, at: number, p: Vec3, tol: number): boolean {
  return normal !== null ? Math.abs(side(normal, at, p)) <= tol : Math.hypot(p[0], p[1]) <= tol
}

/** Match points to their images (tolerance relative to the cage size). A mirror's plane is n . p = at: n its axis, or `normal` for a placed plane ('p'). */
export function findPairs(cage: Cage, mode: SymmetryMode, at = 0, normal?: Vec3 | null): SymmetryPairs {
  const u = mirrorNormal(mode, normal)
  const { min, max } = cageBounds(cage)
  const size = Math.max(1e-9, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]))
  const tol = size * 1e-6
  const n = cage.positions.length
  const seam = new Uint8Array(n)
  for (let i = 0; i < n; i++) if (onSeam(u, at, cage.positions[i], tol * 10)) seam[i] = 1
  // points bucketed on a grid of cells far wider than the match distance: each image looks in the 27
  // cells round it, not at every point (a direct search was 0.56 s per move on a 3,500-point cage)
  const reach = tol * 20
  const cell = Math.max(reach * 4, size / Math.max(1, Math.cbrt(n)))
  const cellOf = (p: Vec3) => [Math.floor(p[0] / cell), Math.floor(p[1] / cell), Math.floor(p[2] / cell)]
  const buckets = new Map<string, number[]>()
  cage.positions.forEach((p, h) => {
    const key = cellOf(p).join(',')
    const list = buckets.get(key)
    if (list) list.push(h)
    else buckets.set(key, [h])
  })
  const images = transforms(mode, at, u).map((T) => {
    const image = new Int32Array(n).fill(-1)
    for (let i = 0; i < n; i++) {
      if (seam[i]) { image[i] = i; continue }
      const m = T(cage.positions[i])
      const [cx, cy, cz] = cellOf(m)
      // the nearest point within reach; ties to the highest index, as the direct search did
      let best = -1, bestD = reach
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const h of buckets.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          if (h === i) continue
          const d = Math.hypot(cage.positions[h][0] - m[0], cage.positions[h][1] - m[1], cage.positions[h][2] - m[2])
          if (d < bestD || (d === bestD && h > best)) { bestD = d; best = h }
        }
      }
      image[i] = best
    }
    return image
  })
  return { mode, at, normal: u, images, partner: images[0], seam }
}

/**
 * A mirror plane placed from points: two points - the plane halfway between
 * them that maps one onto the other; three or more - the plane through them
 * (best fit). A plane square to X, Y or Z comes back as that axis's mirror
 * moved along it; any other as a placed plane ('p'). Null when the points do
 * not fix a plane (coincident, or all on one line).
 */
export function mirrorPlaneFrom(points: readonly Vec3[]): { mode: SymmetryAxis | 'p'; at: number; normal: Vec3; deviation: number } | null {
  if (points.length < 2) return null
  let normal: Vec3, centre: Vec3, deviation = 0
  const span = points.reduce((m, p) => Math.max(m, Math.hypot(p[0] - points[0][0], p[1] - points[0][1], p[2] - points[0][2])), 0)
  if (!(span > 0)) return null
  if (points.length === 2) {
    const [a, b] = points
    const d: Vec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]]
    const l = Math.hypot(d[0], d[1], d[2])
    normal = [d[0] / l, d[1] / l, d[2] / l]
    centre = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
  } else {
    const fit = principalAxes(points)
    // all on one line: the two least spreads both vanish, no plane is fixed
    const second = fit.axes[1]
    const across = points.reduce((m, p) => {
      const q: Vec3 = [p[0] - fit.centre[0], p[1] - fit.centre[1], p[2] - fit.centre[2]]
      return Math.max(m, Math.abs(q[0] * second[0] + q[1] * second[1] + q[2] * second[2]))
    }, 0)
    if (across <= span * 1e-9) return null
    normal = fit.axes[0]
    centre = fit.centre
    deviation = points.reduce((m, p) => Math.max(m, Math.abs(side(normal, 0, p) - side(normal, 0, centre))), 0)
  }
  // the normal's largest component positive: the same plane always reads the same way round
  const big = [0, 1, 2].reduce((k, i) => (Math.abs(normal[i]) > Math.abs(normal[k]) ? i : k), 0)
  if (normal[big] < 0) normal = [-normal[0], -normal[1], -normal[2]]
  const at = side(normal, 0, centre)
  for (const axis of ['x', 'y', 'z'] as const) {
    if (normal[AXIS_NORMAL[axis].indexOf(1)] > 1 - 1e-9) return { mode: axis, at: centre[AXIS_NORMAL[axis].indexOf(1)], normal: AXIS_NORMAL[axis], deviation }
  }
  return { mode: 'p', at, normal, deviation }
}

/** How many points lack an image (a symmetric cage has none). */
export function unpairedCount(pairs: SymmetryPairs): number {
  let n = 0
  for (let p = 0; p < pairs.seam.length; p++) if (pairs.images.some((im) => im[p] < 0)) n++
  return n
}

/**
 * Make the cage symmetric after `moved` points changed. In each group of
 * images one moved point wins - one in `primary` (the operator's own pick)
 * first, then (mirror) the one on the plane's + side, else the lowest index -
 * and the others are set from it; every seam point is held on the plane or
 * axis.
 */
export function symmetrize(cage: Cage, pairs: SymmetryPairs, moved: readonly number[], primary: readonly number[] = moved): Cage {
  const T = transforms(pairs.mode, pairs.at, pairs.normal)
  const u = pairs.normal
  const positions = cage.positions.map((p) => [p[0], p[1], p[2]] as Vec3)
  const movedSet = new Set(moved)
  const primarySet = new Set(primary)
  const done = new Set<number>()
  for (const p of moved) {
    if (done.has(p) || pairs.seam[p]) continue
    const group = [p, ...pairs.images.map((im) => im[p])].filter((j) => j >= 0)
    for (const j of group) done.add(j)
    let candidates = group.filter((j) => movedSet.has(j))
    const picked = candidates.filter((j) => primarySet.has(j))
    if (picked.length > 0) candidates = picked
    const winner = u !== null
      ? (candidates.find((j) => side(u, pairs.at, cage.positions[j]) >= 0) ?? candidates[0])
      : Math.min(...candidates)
    pairs.images.forEach((im, t) => {
      const j = im[winner]
      if (j >= 0 && j !== winner) positions[j] = T[t](positions[winner])
    })
  }
  for (let i = 0; i < positions.length; i++) {
    if (!pairs.seam[i]) continue
    if (u !== null) {
      const d = side(u, pairs.at, positions[i])
      positions[i] = [positions[i][0] - d * u[0], positions[i][1] - d * u[1], positions[i][2] - d * u[2]]
    } else { positions[i][0] = 0; positions[i][1] = 0 }
  }
  return { ...cage, positions }
}

/** The selection plus its images (points by image, edges by their ends' images, faces by their corners' images). */
export function mirrorSelection(cage: Cage, pairs: SymmetryPairs, s: CageSelection): CageSelection {
  const points = new Set(s.points)
  const edges = new Set(s.edges)
  const faces = new Set(s.faces)
  const faceBySet = new Map<string, number>()
  cage.faces.forEach((loop, f) => faceBySet.set([...loop].sort((x, y) => x - y).join(','), f))
  for (const im of pairs.images) {
    for (const p of s.points) if (im[p] >= 0) points.add(im[p])
    for (const key of s.edges) {
      const [a, b] = parseEdgeKey(key)
      if (im[a] >= 0 && im[b] >= 0) edges.add(edgeKey(im[a], im[b]))
    }
    for (const f of s.faces) {
      const imaged = cage.faces[f].map((p) => im[p])
      if (imaged.some((p) => p < 0)) continue
      const hit = faceBySet.get([...imaged].sort((x, y) => x - y).join(','))
      if (hit !== undefined) faces.add(hit)
    }
  }
  const validEdges = new Set<string>()
  for (const loop of cage.faces) for (let i = 0; i < loop.length; i++) validEdges.add(edgeKey(loop[i], loop[(i + 1) % loop.length]))
  return {
    points: [...points].sort((a, b) => a - b),
    edges: [...edges].filter((e) => validEdges.has(e)),
    faces: [...faces].sort((a, b) => a - b),
  }
}
