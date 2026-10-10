// Form - Flatten and Straighten.
//
//   flattenPoints    points onto their best-fit plane (least squares through
//                    them: the centroid, normal = the covariance's smallest axis),
//                    or onto a plane the operator chose (an axis plane, a face's,
//                    the mirror's)
//   pullToLimit      the cage moved so the smooth surface passes through the
//                    selected points where they are now:
//                    each point's limit position is read a few refinements down
//                    and the points are corrected until their limits land on
//                    the targets
//   pullOntoMesh     the same, onto another body: each surface point goes to
//                    the body's closest point
//   straightenChains each selected chain of edges onto the line between its two
//                    ends, its points keeping their share of the chain's length;
//                    selected points not on a chain onto their best-fit line
//
// Both move cage points only. Where every point round a region is on the plane
// (or line), the smooth skin there is flat (or straight) too.

import type { Cage, Vec3 } from './cage'
import { parseEdgeKey } from './cage'
import { applyRows, cagePositionArray, composeRows, levelFromCage, limitRows, refine, type SparseRows } from './subdivide'
import type { ClosestPointIndex } from './closestPoint'

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2])

/** Eigenvectors of a symmetric 3 x 3 matrix (Jacobi rotations), sorted by eigenvalue, smallest first. */
function eigen3(m: number[][]): { values: number[]; vectors: Vec3[] } {
  const a = m.map((r) => r.slice())
  const v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
  for (let sweep = 0; sweep < 50; sweep++) {
    const off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2])
    if (off < 1e-30) break
    for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
      if (Math.abs(a[p][q]) < 1e-300) continue
      const theta = (a[q][q] - a[p][p]) / (2 * a[p][q])
      const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.sqrt(theta * theta + 1))
      const c = 1 / Math.sqrt(t * t + 1), s = t * c
      for (let k = 0; k < 3; k++) {
        const akp = a[k][p], akq = a[k][q]
        a[k][p] = c * akp - s * akq
        a[k][q] = s * akp + c * akq
      }
      for (let k = 0; k < 3; k++) {
        const apk = a[p][k], aqk = a[q][k]
        a[p][k] = c * apk - s * aqk
        a[q][k] = s * apk + c * aqk
      }
      for (let k = 0; k < 3; k++) {
        const vkp = v[k][p], vkq = v[k][q]
        v[k][p] = c * vkp - s * vkq
        v[k][q] = s * vkp + c * vkq
      }
    }
  }
  const order = [0, 1, 2].sort((i, j) => a[i][i] - a[j][j])
  return { values: order.map((i) => a[i][i]), vectors: order.map((i) => [v[0][i], v[1][i], v[2][i]] as Vec3) }
}

/** Centroid and principal axes of a point set (axes[0] the least spread, axes[2] the most). */
export function principalAxes(pts: readonly Vec3[]): { centre: Vec3; axes: Vec3[] } {
  const n = Math.max(1, pts.length)
  const c: Vec3 = [0, 1, 2].map((k) => pts.reduce((s, p) => s + p[k], 0) / n) as Vec3
  const m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]]
  for (const p of pts) {
    const d = sub(p, c)
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) m[i][j] += d[i] * d[j]
  }
  return { centre: c, axes: eigen3(m).vectors }
}

/** Largest distance of the points from the plane through `centre` with unit `normal`. */
export function planeDeviation(pts: readonly Vec3[], centre: Vec3, normal: Vec3): number {
  return pts.reduce((w, p) => Math.max(w, Math.abs(dot(sub(p, centre), normal))), 0)
}

/** Largest distance of the points from the line through `a` along unit `dir`. */
export function lineDeviation(pts: readonly Vec3[], a: Vec3, dir: Vec3): number {
  return pts.reduce((w, p) => { const d = sub(p, a); const t = dot(d, dir); return Math.max(w, len([d[0] - dir[0] * t, d[1] - dir[1] * t, d[2] - dir[2] * t])) }, 0)
}

/**
 * Flatten: the points onto their best-fit plane, or onto `onto` (any number of
 * points). Null for fewer than three points without a plane. `before` is how
 * far the farthest was off that plane.
 */
export function flattenPoints(cage: Cage, points: readonly number[], onto?: { origin: Vec3; normal: Vec3 }): { cage: Cage; centre: Vec3; normal: Vec3; before: number } | null {
  const ids = [...new Set(points)].filter((p) => cage.positions[p] !== undefined)
  // a best fit needs three points to fix its plane; a chosen plane takes any
  if (ids.length < (onto ? 1 : 3)) return null
  const pts = ids.map((p) => cage.positions[p])
  let centre: Vec3, n: Vec3
  if (onto) {
    const l = len(onto.normal)
    if (!(l > 0)) return null
    centre = onto.origin
    n = [onto.normal[0] / l, onto.normal[1] / l, onto.normal[2] / l]
  } else {
    const fit = principalAxes(pts)
    centre = fit.centre
    n = fit.axes[0]
  }
  const before = planeDeviation(pts, centre, n)
  const positions = cage.positions.map((p) => [p[0], p[1], p[2]] as Vec3)
  for (const p of ids) {
    const q = positions[p]
    const d = dot(sub(q, centre), n)
    positions[p] = [q[0] - n[0] * d, q[1] - n[1] * d, q[2] - n[2] * d]
  }
  return { cage: { ...cage, positions }, centre, normal: n, before }
}

/** The selected edges as chains of points: open chains run end to end; closed ones are loops; branching sets are lumps. */
export function edgeChains(edges: readonly string[]): Array<{ points: number[]; kind: 'open' | 'loop' | 'branching' }> {
  const nbr = new Map<number, number[]>()
  for (const k of new Set(edges)) {
    const [a, b] = parseEdgeKey(k)
    nbr.set(a, [...(nbr.get(a) ?? []), b])
    nbr.set(b, [...(nbr.get(b) ?? []), a])
  }
  const seen = new Set<number>()
  const out: Array<{ points: number[]; kind: 'open' | 'loop' | 'branching' }> = []
  for (const start of [...nbr.keys()].sort((a, b) => a - b)) {
    if (seen.has(start)) continue
    const comp: number[] = []
    const stack = [start]
    seen.add(start)
    while (stack.length > 0) { const p = stack.pop()!; comp.push(p); for (const q of nbr.get(p) ?? []) if (!seen.has(q)) { seen.add(q); stack.push(q) } }
    const degree = (p: number) => nbr.get(p)!.length
    if (comp.some((p) => degree(p) > 2)) { out.push({ points: comp, kind: 'branching' }); continue }
    const ends = comp.filter((p) => degree(p) === 1)
    const first = ends.length > 0 ? Math.min(...ends) : Math.min(...comp)
    const walk = [first]
    let prev = -1, cur = first
    for (;;) {
      const next = nbr.get(cur)!.find((q) => q !== prev && !walk.includes(q))
      if (next === undefined) break
      walk.push(next)
      prev = cur
      cur = next
    }
    out.push({ points: walk, kind: ends.length === 0 ? 'loop' : 'open' })
  }
  return out
}

/**
 * Straighten: every open chain of `edges` onto the line between its ends, each
 * point at its share of the chain's length; `points` (and branching edge sets)
 * onto their best-fit line, keeping their order along it. Closed loops cannot
 * become a line and are counted, not moved. `before` is how far the farthest
 * point was off its line. Null when nothing could be straightened.
 */
export function straightenChains(cage: Cage, edges: readonly string[], points: readonly number[] = []): { cage: Cage; lines: number; moved: number; loops: number; before: number } | null {
  const positions = cage.positions.map((p) => [p[0], p[1], p[2]] as Vec3)
  let lines = 0, moved = 0, loops = 0, before = 0
  const onChains = new Set<number>()
  const loose: number[][] = []
  for (const c of edgeChains(edges)) {
    for (const p of c.points) onChains.add(p)
    if (c.kind === 'loop') { loops++; continue }
    if (c.kind === 'branching') { loose.push(c.points); continue }
    const P = c.points.map((p) => cage.positions[p])
    const a = P[0], b = P[P.length - 1]
    const ab = sub(b, a), L = len(ab)
    if (P.length < 3 || L < 1e-12) continue
    const dir: Vec3 = [ab[0] / L, ab[1] / L, ab[2] / L]
    before = Math.max(before, lineDeviation(P, a, dir))
    const cum = [0]
    for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + len(sub(P[i], P[i - 1])))
    const total = cum[cum.length - 1]
    c.points.forEach((p, i) => { if (i > 0 && i < P.length - 1) { const t = cum[i] / total; positions[p] = [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]; moved++ } })
    lines++
  }
  const rest = [...new Set(points)].filter((p) => cage.positions[p] !== undefined && !onChains.has(p))
  if (rest.length > 0) loose.push(rest)
  for (const ids of loose) {
    if (ids.length < 3) continue
    const P = ids.map((p) => cage.positions[p])
    const { centre, axes } = principalAxes(P)
    const dir = axes[2]
    before = Math.max(before, lineDeviation(P, centre, dir))
    ids.forEach((p, i) => { const t = dot(sub(P[i], centre), dir); positions[p] = [centre[0] + dir[0] * t, centre[1] + dir[1] * t, centre[2] + dir[2] * t]; moved++ })
    lines++
  }
  if (lines === 0) return null
  return { cage: { ...cage, positions }, lines, moved, loops, before }
}

/** Unit point normals: the average of each point's faces' (Newell) normals. */
function pointNormals(cage: Cage): Vec3[] {
  const n: Vec3[] = cage.positions.map(() => [0, 0, 0])
  for (const loop of cage.faces) {
    let nx = 0, ny = 0, nz = 0
    for (let i = 0; i < loop.length; i++) {
      const p = cage.positions[loop[i]], q = cage.positions[loop[(i + 1) % loop.length]]
      nx += (p[1] - q[1]) * (p[2] + q[2])
      ny += (p[2] - q[2]) * (p[0] + q[0])
      nz += (p[0] - q[0]) * (p[1] + q[1])
    }
    for (const p of loop) { n[p][0] += nx; n[p][1] += ny; n[p][2] += nz }
  }
  return n.map((v) => { const l = len(v); return l > 0 ? [v[0] / l, v[1] / l, v[2] / l] as Vec3 : v })
}

/** Coefficient of variation (spread / mean) of the lengths of the edges touching `points`. */
export function edgeLengthSpread(cage: Cage, points: readonly number[]): number {
  const set = new Set(points)
  const seen = new Set<string>()
  const lengths: number[] = []
  for (const loop of cage.faces) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      const k = a < b ? `${a}:${b}` : `${b}:${a}`
      if (seen.has(k) || (!set.has(a) && !set.has(b))) continue
      seen.add(k)
      lengths.push(len(sub(cage.positions[a], cage.positions[b])))
    }
  }
  if (lengths.length === 0) return 0
  const mean = lengths.reduce((s, v) => s + v, 0) / lengths.length
  const sd = Math.sqrt(lengths.reduce((s, v) => s + (v - mean) ** 2, 0) / lengths.length)
  return mean > 0 ? sd / mean : 0
}

/**
 * Make uniform: the points relax toward the average of their neighbours,
 * each move kept in the point's tangent plane (so spacing evens out without
 * flattening the shape), `iterations` times at half strength. Points on an
 * open border or a crease stay (they hold the form's outline and sharp
 * edges), as do points not given. Null when no point can move.
 */
export function makeUniform(cage: Cage, points: readonly number[], iterations = 20): { cage: Cage; moved: number; before: number; after: number } | null {
  const creased = new Set<number>()
  for (const k of cage.creases) for (const p of parseEdgeKey(k)) creased.add(p)
  const uses = new Map<string, number>()
  const nbrs: Array<Set<number>> = cage.positions.map(() => new Set<number>())
  for (const loop of cage.faces) {
    for (let i = 0; i < loop.length; i++) {
      const a = loop[i], b = loop[(i + 1) % loop.length]
      const k = a < b ? `${a}:${b}` : `${b}:${a}`
      uses.set(k, (uses.get(k) ?? 0) + 1)
      nbrs[a].add(b); nbrs[b].add(a)
    }
  }
  const border = new Set<number>()
  for (const [k, n] of uses) if (n === 1) for (const p of parseEdgeKey(k)) border.add(p)
  const free = [...new Set(points)].filter((p) => cage.positions[p] !== undefined && !border.has(p) && !creased.has(p) && nbrs[p].size > 0)
  if (free.length === 0) return null
  const before = edgeLengthSpread(cage, free)
  let positions = cage.positions.map((p) => [p[0], p[1], p[2]] as Vec3)
  for (let it = 0; it < iterations; it++) {
    const normals = pointNormals({ ...cage, positions })
    const next = positions.map((p) => [p[0], p[1], p[2]] as Vec3)
    for (const p of free) {
      const q = positions[p]
      const c: Vec3 = [0, 0, 0]
      for (const m of nbrs[p]) { c[0] += positions[m][0]; c[1] += positions[m][1]; c[2] += positions[m][2] }
      const k = nbrs[p].size
      const d: Vec3 = [(c[0] / k - q[0]) * 0.5, (c[1] / k - q[1]) * 0.5, (c[2] / k - q[2]) * 0.5]
      const n = normals[p]
      const dn = dot(d, n)
      next[p] = [q[0] + d[0] - n[0] * dn, q[1] + d[1] - n[1] * dn, q[2] + d[2] - n[2] * dn]
    }
    positions = next
  }
  const out: Cage = { ...cage, positions }
  return { cage: out, moved: free.length, before, after: edgeLengthSpread(out, free) }
}

/**
 * Refinement steps before a cage point's limit is read. The limit mask is exact
 * at any level for smooth and crease points, except next to where a crease ends
 * (a dart): there the crease settles only with refinement, about 2.4x closer
 * per level. Measured on a box with two creased edges against seven levels:
 * 0.34 mm read one level down, 0.060 mm at three, 0.010 mm at five. Three keeps
 * Pull quick on large cages; elsewhere it lands within 1e-4 mm.
 */
const LIMIT_LEVELS = 3

/** The limit-position mask of each cage point, over the cage points: `levels` refinements, the limit mask there, composed back. */
export function cageLimitRows(cage: Cage, levels: number): SparseRows {
  const steps: SparseRows[] = []
  let level = levelFromCage(cage)
  for (let k = 0; k < levels; k++) { const r = refine(level); steps.push(r.rows); level = r.level }
  // a cage point keeps its index through every refinement: its limit is row i of the finest level
  const full = limitRows(level)
  const V = cage.positions.length
  let rows: SparseRows = { offsets: full.offsets.slice(0, V + 1), index: full.index.slice(0, full.offsets[V]), weights: full.weights.slice(0, full.offsets[V]) }
  for (let k = steps.length - 1; k >= 0; k--) rows = composeRows(rows, steps[k])
  return rows
}

/**
 * Pull: move the given points so the smooth surface passes through where they
 * are now (their current positions are the targets). Only the given points
 * move; their limit positions depend on their neighbours too, so the
 * correction P += target - limit(P) is repeated until the worst miss is under
 * `tol` (mm) or `iterations` run out. `before` / `after`: the worst distance
 * from a target to the surface point it names. Null when no point is given.
 */
export function pullToLimit(cage: Cage, points: readonly number[], tol = 1e-4, iterations = 200): { cage: Cage; before: number; after: number; rounds: number } | null {
  const ids = [...new Set(points)].filter((p) => cage.positions[p] !== undefined)
  if (ids.length === 0) return null
  const limit = cageLimitRows(cage, LIMIT_LEVELS)
  const P = cagePositionArray(cage)
  const targets = ids.map((i) => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]] as Vec3)
  const before = worstMiss(applyRows(limit, P), ids, targets)
  const r = settle(limit, P, ids, targets, tol, iterations)
  return { cage: withPoints(cage, ids, P), before, after: r.miss, rounds: r.rounds }
}

/**
 * Pull onto a body: move the given points so the surface points they name lie
 * on `onto` (a body's triangle mesh). Each surface point's target is the
 * mesh's closest point to it, and the cage is corrected toward those targets as
 * Pull does; the corrected surface points are then on the mesh (a second round
 * would only slide them along it). `before` / `after`: the worst distance from
 * those surface points to the mesh.
 */
export function pullOntoMesh(cage: Cage, points: readonly number[], onto: ClosestPointIndex): { cage: Cage; before: number; after: number } | null {
  return pullOntoTargets(cage, points, (_, q) => onto.closest(q).point)
}

/**
 * Pull each given point's surface point onto its own target: `target(i, q)` is
 * where the surface point q of cage point i should be (the closest point of
 * whatever that point belongs to - a mesh, one face of it, an edge). One round,
 * as pullOntoMesh. `before` / `after`: the worst distance from those surface
 * points to their targets.
 */
export function pullOntoTargets(cage: Cage, points: readonly number[], target: (i: number, q: Vec3) => Vec3): { cage: Cage; before: number; after: number } | null {
  const ids = [...new Set(points)].filter((p) => cage.positions[p] !== undefined)
  if (ids.length === 0) return null
  const limit = cageLimitRows(cage, LIMIT_LEVELS)
  const P = cagePositionArray(cage)
  const at = (L: Float64Array, i: number): Vec3 => [L[i * 3], L[i * 3 + 1], L[i * 3 + 2]]
  const miss = (L: Float64Array, i: number) => { const q = at(L, i), t = target(i, q); return Math.hypot(t[0] - q[0], t[1] - q[1], t[2] - q[2]) }
  const L = applyRows(limit, P)
  const before = ids.reduce((w, i) => Math.max(w, miss(L, i)), 0)
  settle(limit, P, ids, ids.map((i) => target(i, at(L, i))), 1e-4, 200)
  const after = applyRows(limit, P)
  return { cage: withPoints(cage, ids, P), before, after: ids.reduce((w, i) => Math.max(w, miss(after, i)), 0) }
}

/** P += target - limit(P) on the given points until the worst miss is under `tol` or `iterations` run out (P changes in place). */
function settle(limit: SparseRows, P: Float64Array, ids: readonly number[], targets: readonly Vec3[], tol: number, iterations: number): { miss: number; rounds: number } {
  let L = applyRows(limit, P)
  let rounds = 0
  for (; rounds < iterations && worstMiss(L, ids, targets) > tol; rounds++) {
    ids.forEach((i, k) => { for (let c = 0; c < 3; c++) P[i * 3 + c] += targets[k][c] - L[i * 3 + c] })
    L = applyRows(limit, P, L)
  }
  return { miss: worstMiss(L, ids, targets), rounds }
}

function worstMiss(L: Float64Array, ids: readonly number[], targets: readonly Vec3[]): number {
  return ids.reduce((w, i, k) => Math.max(w, Math.hypot(L[i * 3] - targets[k][0], L[i * 3 + 1] - targets[k][1], L[i * 3 + 2] - targets[k][2])), 0)
}

/** The cage with the given points at their positions in P. */
function withPoints(cage: Cage, ids: readonly number[], P: Float64Array): Cage {
  const moved = new Set(ids)
  return { ...cage, positions: cage.positions.map((p, i) => (moved.has(i) ? [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]] as Vec3 : [p[0], p[1], p[2]] as Vec3)) }
}
