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
//
// Symmetry turned on after the form was edited without it (WO-2955): turning
// it on changes nothing. The cage remembers where its points were before
// those edits (cage.symmetryReference) and pairs them there, so a point moved
// off its partner keeps it; a later move then mirrors only that move, and the
// earlier difference stays (propagateSymmetry). A pair the reference cannot
// vouch for - none, two candidates, not mutual - is never guessed: the point
// pairs by where it is now, as before, or moves alone.

import type { Cage, Vec3 } from './cage'
import { cageBounds, edgeKey, parseEdgeKey, symmetryReferenceOf } from './cage'
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

/** the cage's bounding-box diagonal (matching tolerances scale with it) */
function cageSize(cage: Cage): number {
  const { min, max } = cageBounds(cage)
  return Math.max(1e-9, Math.hypot(max[0] - min[0], max[1] - min[1], max[2] - min[2]))
}

function onSeam(normal: Vec3 | null, at: number, p: Vec3, tol: number): boolean {
  return normal !== null ? Math.abs(side(normal, at, p)) <= tol : Math.hypot(p[0], p[1]) <= tol
}

/** Match points to their images (tolerance relative to the cage size). A mirror's plane is n . p = at: n its axis, or `normal` for a placed plane ('p'). */
export function findPairs(cage: Cage, mode: SymmetryMode, at = 0, normal?: Vec3 | null): SymmetryPairs {
  return matchImages(cage, mode, at, normal, false)
}

/** findPairs; `unique`: an image with two or more points within reach is no match (-1), not the nearest. */
function matchImages(cage: Cage, mode: SymmetryMode, at: number, normal: Vec3 | null | undefined, unique: boolean): SymmetryPairs {
  const u = mirrorNormal(mode, normal)
  const size = cageSize(cage)
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
      let best = -1, bestD = reach, within = 0
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
        for (const h of buckets.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
          if (h === i) continue
          const d = Math.hypot(cage.positions[h][0] - m[0], cage.positions[h][1] - m[1], cage.positions[h][2] - m[2])
          if (d <= reach) within++
          if (d < bestD || (d === bestD && h > best)) { bestD = d; best = h }
        }
      }
      image[i] = unique && within > 1 ? -1 : best
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

/**
 * The pairs edits use (WO-2955): with a valid symmetry reference, points pair
 * by where they were there - by index, so a point moved while symmetry was off
 * keeps its partner. Only a reference image that is the one point within
 * reach and maps back to the same point counts. A point the reference pairs
 * with nothing pairs by where it is now (findPairs), with points the
 * reference left unpaired too.
 */
export function resolvePairs(cage: Cage, mode: SymmetryMode, at = 0, normal?: Vec3 | null): SymmetryPairs {
  const reference = symmetryReferenceOf(cage)
  if (reference === null) return findPairs(cage, mode, at, normal)
  const then = matchImages({ ...cage, positions: reference.positions }, mode, at, normal, true)
  // a point on the plane (axis) there but moved off it since is its own image no more: it pairs as any other
  const tol = cageSize(cage) * 1e-5
  const seamThen = then.seam.map((v, i) => (v && onSeam(then.normal, at, cage.positions[i], tol) ? 1 : 0))
  // transform t turns (t + 1) steps of the n (a mirror: itself); k - 1 - t turns back
  const k = then.images.length
  const mutual = then.images.map((im, t) => im.map((j, i) => (j < 0 || (j === i ? !seamThen[i] : then.images[k - 1 - t][j] !== i) ? -1 : j)))
  const bound = seamThen.map((v, i) => (v || mutual.some((im) => im[i] >= 0) ? 1 : 0))
  // the reference pairs every point: no point needs pairing by where it is now
  if (bound.every((v) => v === 1)) return { mode, at, normal: then.normal, images: mutual, partner: mutual[0], seam: seamThen }
  const now = findPairs(cage, mode, at, normal)
  const images = mutual.map((im, t) => im.map((j, i) => {
    if (bound[i]) return j
    const was = now.images[t][i]
    return was >= 0 && (was === i || !bound[was]) ? was : -1
  }))
  const seam = now.seam.map((v, i) => (bound[i] ? seamThen[i] : v))
  return { mode, at, normal: then.normal, images, partner: images[0], seam }
}

/** How far an image may be from its point's image and still be that image exactly (mm): far below the match reach. */
export function exactness(cage: Cage): number {
  return cageSize(cage) * 1e-9
}

const offPlane = (normal: Vec3 | null, at: number, p: Vec3) => (normal !== null ? Math.abs(side(normal, at, p)) : Math.hypot(p[0], p[1]))

/**
 * symmetrize for an edit that took the cage from `before` to `after`, keeping
 * what was already there (WO-2955). The winner of each group is chosen as
 * symmetrize chooses it. An image that sat exactly on the winner's image is
 * set from the winner (a symmetric form edits as it always has); one that did
 * not - an offset made while symmetry was off - keeps that offset and takes
 * the winner's NEW move, mirrored or turned: B + R(A' - A). A moved seam point
 * on the plane or axis is held there; one off it keeps its offset and moves
 * only along the plane (along the axis). Nothing else changes.
 */
export function propagateSymmetry(before: Cage, after: Cage, pairs: SymmetryPairs, moved: readonly number[], primary: readonly number[] = moved): Cage {
  const T = transforms(pairs.mode, pairs.at, pairs.normal)
  const u = pairs.normal
  const exact = exactness(before)
  const was = before.positions
  const positions = after.positions.map((p) => [p[0], p[1], p[2]] as Vec3)
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
      ? (candidates.find((j) => side(u, pairs.at, after.positions[j]) >= 0) ?? candidates[0])
      : Math.min(...candidates)
    const w0 = was[winner], w1 = positions[winner]
    T.forEach((turn, t) => {
      const j = pairs.images[t][winner]
      if (j < 0 || j === winner) return
      const image = turn(w0)
      if (Math.hypot(was[j][0] - image[0], was[j][1] - image[1], was[j][2] - image[2]) <= exact) { positions[j] = turn(w1); return }
      // the transform's linear part, applied to the winner's move
      const o = turn([0, 0, 0]), m = turn([w1[0] - w0[0], w1[1] - w0[1], w1[2] - w0[2]])
      positions[j] = [was[j][0] + m[0] - o[0], was[j][1] + m[1] - o[1], was[j][2] + m[2] - o[2]]
    })
  }
  for (let i = 0; i < positions.length; i++) {
    if (!pairs.seam[i]) continue
    const p = positions[i], q = was[i]
    if (p[0] === q[0] && p[1] === q[1] && p[2] === q[2]) continue
    if (offPlane(u, pairs.at, q) <= exact) {
      if (u !== null) { const d = side(u, pairs.at, p); positions[i] = [p[0] - d * u[0], p[1] - d * u[1], p[2] - d * u[2]] } else positions[i] = [0, 0, p[2]]
      continue
    }
    const d: Vec3 = [p[0] - q[0], p[1] - q[1], p[2] - q[2]]
    const k = u !== null ? u[0] * d[0] + u[1] * d[1] + u[2] * d[2] : 0
    const along: Vec3 = u !== null ? [d[0] - k * u[0], d[1] - k * u[1], d[2] - k * u[2]] : [0, 0, d[2]]
    positions[i] = [q[0] + along[0], q[1] + along[1], q[2] + along[2]]
  }
  return { ...after, positions }
}

/** How many points are paired but not exactly symmetric with their images (an offset an edit with symmetry off left). */
export function offsetCount(cage: Cage, pairs: SymmetryPairs): number {
  const T = transforms(pairs.mode, pairs.at, pairs.normal)
  const exact = exactness(cage)
  const P = cage.positions
  let n = 0
  for (let i = 0; i < P.length; i++) {
    if (pairs.seam[i]) { if (offPlane(pairs.normal, pairs.at, P[i]) > exact) n++; continue }
    if (T.some((turn, t) => { const j = pairs.images[t][i]; if (j < 0) return false; const m = turn(P[i]); return Math.hypot(P[j][0] - m[0], P[j][1] - m[1], P[j][2] - m[2]) > exact })) n++
  }
  return n
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
