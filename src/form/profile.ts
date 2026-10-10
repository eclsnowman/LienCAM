// Form - a form from a sketch profile.
//
//   sketchProfile  the profile Extrude and Revolve use: the sketch's longest
//                  closed curve, else its longest curve, in sketch coordinates
//   extrudeProfileCage  rings of the profile stacked along the sketch normal;
//                  a closed profile gets a flat cap at each end (rims creased)
//   revolveProfileCage  the profile turned round an axis in its plane: a
//                  construction line when the sketch has one, else a sketch axis
//                  the profile does not cross; points on the axis weld into poles;
//                  a full turn or part of one (then flat end caps, rims creased)
//
// Sketch corners (a turn of more than CORNER_DEG) stay corners: they are always
// sample points and the cage edges running from them are creased. Between
// corners the profile is sampled evenly and each run of cage points is solved
// (Jacobi, as for Pipe) so the smooth skin's cross-section passes through the
// profile rather than cutting inside it. Each run gets the fewest spans whose
// skin stays within the chord tolerance of the profile (WO-2500): a straight
// side is one span, a curve as many as it needs, never more than the old even
// spacing gave. An extrude is two spans tall (one middle ring to shape by).
// Round a revolve the ring radius is padded by 3 / (2 + cos(2 pi / n)) for the
// same reason as the solve.

import type { Cage, Vec3 } from './cage'
import { edgeKey } from './cage'
import type { SketchEntity } from '../lib/sketch/types'
import { pathLength, sketchPaths, type PlaneFrame, type SketchPath } from './pipe'
import { weldByDistance } from './topoTools'
import { DEFAULT_CHORD_TOLERANCE_MM } from './finish'

type P2 = [number, number]

const CORNER_DEG = 25
const LOCAL: PlaneFrame = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 }, xDir: { x: 1, y: 0, z: 0 } }

/** The profile Extrude / Revolve use, in sketch coordinates (z = 0): the longest closed curve, else the longest. */
export function sketchProfile(entities: readonly SketchEntity[]): SketchPath | null {
  const paths = sketchPaths(entities, LOCAL)
  return paths.find((p) => p.closed) ?? paths[0] ?? null
}

/** Sketch coordinates -> model coordinates on the sketch's plane; `n` the plane's unit normal. */
export function planeMap(frame: PlaneFrame): { at: (p: P2, h?: number) => Vec3; dir: (d: P2) => Vec3; n: Vec3 } {
  const nl = Math.hypot(frame.normal.x, frame.normal.y, frame.normal.z) || 1
  const n: Vec3 = [frame.normal.x / nl, frame.normal.y / nl, frame.normal.z / nl]
  const xl = Math.hypot(frame.xDir.x, frame.xDir.y, frame.xDir.z) || 1
  const x: Vec3 = [frame.xDir.x / xl, frame.xDir.y / xl, frame.xDir.z / xl]
  const y: Vec3 = [n[1] * x[2] - n[2] * x[1], n[2] * x[0] - n[0] * x[2], n[0] * x[1] - n[1] * x[0]]
  const dir = (d: P2): Vec3 => [x[0] * d[0] + y[0] * d[1], x[1] * d[0] + y[1] * d[1], x[2] * d[0] + y[2] * d[1]]
  const at = (p: P2, h = 0): Vec3 => {
    const v = dir(p)
    return [frame.origin.x + v[0] + n[0] * h, frame.origin.y + v[1] + n[1] * h, frame.origin.z + v[2] + n[2] * h]
  }
  return { at, dir, n }
}

const d2 = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1])

/**
 * The profile sampled for a cage: every corner kept, even spacing between, each
 * run between corners in the fewest spans whose skin is within `tol` mm of the
 * profile (a straight side: one), at most the spans of `perLoop` points round
 * the whole profile (48 keeps the ripple an interpolating spline makes at a
 * line-arc join to 0.04 mm on a 50 x 30 plate, 24 left 0.12 mm). `corner[i]`
 * marks corners; an open profile's two ends count as corners.
 */
export function sampleProfile(path: SketchPath, perLoop = 48, tol = DEFAULT_CHORD_TOLERANCE_MM): { pts: P2[]; corner: boolean[] } {
  const P: P2[] = path.points.map((p) => [p[0], p[1]])
  // drop repeated points (a chain's joins)
  const Q: P2[] = P.filter((p, i) => i === 0 || d2(p, P[i - 1]) > 1e-9)
  if (path.closed && Q.length > 1 && d2(Q[0], Q[Q.length - 1]) <= 1e-9) Q.pop()
  const m = Q.length
  const isCorner = Q.map((q, i) => {
    if (!path.closed && (i === 0 || i === m - 1)) return true
    const a = Q[(i - 1 + m) % m], b = Q[(i + 1) % m]
    const u: P2 = [q[0] - a[0], q[1] - a[1]], v: P2 = [b[0] - q[0], b[1] - q[1]]
    const turn = Math.abs(Math.atan2(u[0] * v[1] - u[1] * v[0], u[0] * v[0] + u[1] * v[1]))
    return turn > (CORNER_DEG * Math.PI) / 180
  })
  const L = pathLength(path)
  const spacing = L / Math.max(4, perLoop)
  const corners = isCorner.map((c, i) => (c ? i : -1)).filter((i) => i >= 0)
  // runs from corner to corner (a closed profile with no corner is one run round)
  const starts = corners.length > 0 ? corners : [0]
  const pts: P2[] = [], corner: boolean[] = []
  const runs = path.closed ? starts.length : starts.length - 1
  for (let r = 0; r < runs; r++) {
    const s = starts[r]
    const e = path.closed ? starts[(r + 1) % starts.length] : starts[r + 1]
    const run: P2[] = [Q[s]]
    for (let i = (s + 1) % m; ; i = (i + 1) % m) { run.push(Q[i]); if (i === e) break }
    if (corners.length === 0 && run.length > 1 && d2(run[0], run[run.length - 1]) > 1e-9) run.push(Q[s])
    const cum = [0]
    for (let i = 1; i < run.length; i++) cum.push(cum[i - 1] + d2(run[i - 1], run[i]))
    const round = corners.length === 0
    const least = round ? 8 : 1
    const most = Math.max(least, Math.round(cum[cum.length - 1] / spacing))
    const refs = runReference(run, round, spacing / 4)
    let spans = least
    while (spans < most && runDeviation(evenly(run, cum, spans), round, refs, tol) > tol) spans++
    const even = evenly(run, cum, spans)
    for (let k = 0; k < spans; k++) { pts.push(even[k]); corner.push(k === 0 && !round) }
  }
  if (!path.closed) { pts.push(Q[m - 1]); corner.push(true) }
  return { pts, corner }
}

/** `spans` + 1 points evenly along a run (`cum` its running length), both ends included. */
function evenly(run: readonly P2[], cum: readonly number[], spans: number): P2[] {
  const len = cum[cum.length - 1]
  const out: P2[] = []
  let seg = 1
  for (let k = 0; k <= spans; k++) {
    const t = (len * k) / spans
    while (seg < run.length - 1 && cum[seg] < t) seg++
    const f = cum[seg] > cum[seg - 1] ? (t - cum[seg - 1]) / (cum[seg] - cum[seg - 1]) : 0
    out.push([run[seg - 1][0] + (run[seg][0] - run[seg - 1][0]) * f, run[seg - 1][1] + (run[seg][1] - run[seg - 1][1]) * f])
  }
  return out
}

/**
 * Points on the true profile to hold a run's skin to: every vertex, and along each
 * straight piece a point every `step` mm. A chord of an arc (a neighbour of the
 * same length, turned) adds none between its ends: the arc bows off the chord.
 */
function runReference(run: readonly P2[], round: boolean, step: number): P2[] {
  const V = round ? run.slice(0, -1) : [...run]
  const n = V.length
  const segs = round ? n : n - 1
  const dir = (i: number): P2 => { const a = V[i], b = V[(i + 1) % n]; return [b[0] - a[0], b[1] - a[1]] }
  const chord = (i: number) => [i - 1, i + 1].some((j) => {
    if (!round && (j < 0 || j >= segs)) return false
    const u = dir(i), v = dir((j + n) % n)
    const lu = Math.hypot(u[0], u[1]), lv = Math.hypot(v[0], v[1])
    return Math.abs(lu - lv) <= 1e-6 * lu && Math.abs(u[0] * v[1] - u[1] * v[0]) > 1e-9 * lu * lv
  })
  const out: P2[] = [...V]
  for (let i = 0; i < segs; i++) {
    if (chord(i)) continue
    const a = V[i], u = dir(i)
    const k = Math.ceil(Math.hypot(u[0], u[1]) / Math.max(step, 1e-9))
    for (let q = 1; q < k; q++) out.push([a[0] + (u[0] * q) / k, a[1] + (u[1] * q) / k])
  }
  return out
}

/**
 * How far the skin's cross-section over one run strays from `refs`: cage points
 * solved through `even` (its ends fixed unless the run goes `round`), the curve
 * subdivision makes of them (ends fixed, other points 1-6-1 / 8, edges halved)
 * five levels down and pushed to the limit (1-4-1 / 6), and the worst distance
 * from a reference point to it. Stops counting once past `tol`.
 */
function runDeviation(even: readonly P2[], round: boolean, refs: readonly P2[], tol: number): number {
  const S = round ? even.slice(0, -1) : [...even]
  const end = (i: number, n: number) => !round && (i === 0 || i === n - 1)
  const mix = (A: readonly P2[], w: number) => A.map((q, i) => {
    if (end(i, A.length)) return q
    const a = A[(i - 1 + A.length) % A.length], b = A[(i + 1) % A.length]
    return [(a[0] + w * q[0] + b[0]) / (w + 2), (a[1] + w * q[1] + b[1]) / (w + 2)] as P2
  })
  let C = interpolateProfile(S, S.map((_, i) => end(i, S.length)), round)
  for (let l = 0; l < 5; l++) {
    const V = mix(C, 6), next: P2[] = []
    for (let i = 0; i < C.length; i++) {
      next.push(V[i])
      if (round || i < C.length - 1) { const b = C[(i + 1) % C.length]; next.push([(C[i][0] + b[0]) / 2, (C[i][1] + b[1]) / 2]) }
    }
    C = next
  }
  const L = mix(C, 4)
  const segs = round ? L.length : L.length - 1
  let worst = 0
  for (const p of refs) {
    let best = Infinity
    for (let i = 0; i < segs; i++) {
      const a = L[i], b = L[(i + 1) % L.length]
      const ux = b[0] - a[0], uy = b[1] - a[1], uu = ux * ux + uy * uy
      const t = uu > 0 ? Math.min(1, Math.max(0, ((p[0] - a[0]) * ux + (p[1] - a[1]) * uy) / uu)) : 0
      best = Math.min(best, Math.hypot(p[0] - a[0] - ux * t, p[1] - a[1] - uy * t))
    }
    worst = Math.max(worst, best)
    if (worst > tol) break
  }
  return worst
}

/**
 * Cage points whose cubic B-spline (the skin's cross-section) passes through
 * `pts`: corners stay put, runs between them are solved; a closed profile with
 * no corner is solved all the way round.
 */
export function interpolateProfile(pts: readonly P2[], corner: readonly boolean[], closed: boolean): P2[] {
  const m = pts.length
  let Q = pts.map((p) => [p[0], p[1]] as P2)
  for (let it = 0; it < 80; it++) {
    Q = Q.map((q, i) => {
      if (corner[i]) return q
      if (!closed && (i === 0 || i === m - 1)) return q
      const a = Q[(i - 1 + m) % m], b = Q[(i + 1) % m]
      return [(6 * pts[i][0] - a[0] - b[0]) / 4, (6 * pts[i][1] - a[1] - b[1]) / 4] as P2
    })
  }
  return Q
}

function signedArea(pts: readonly P2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1] }
  return a / 2
}

/** Cap faces for a counter-clockwise loop of ring indices: one n-gon when every corner sees the centroid, else ear-clipped triangles. */
export function capFaces(pts: readonly P2[], ring: readonly number[]): number[][] {
  const n = pts.length
  const c: P2 = [pts.reduce((s, p) => s + p[0], 0) / n, pts.reduce((s, p) => s + p[1], 0) / n]
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
  if (pts.every((p, i) => cross(c, p, pts[(i + 1) % n]) > 1e-12)) return [[...ring]]
  const idx = pts.map((_, i) => i)
  const tris: number[][] = []
  while (idx.length > 3) {
    let cut = -1
    for (let k = 0; k < idx.length && cut < 0; k++) {
      const [a, b, d] = [idx[(k - 1 + idx.length) % idx.length], idx[k], idx[(k + 1) % idx.length]]
      if (cross(pts[a], pts[b], pts[d]) <= 1e-12) continue
      const inside = idx.some((j) => j !== a && j !== b && j !== d && cross(pts[a], pts[b], pts[j]) >= 0 && cross(pts[b], pts[d], pts[j]) >= 0 && cross(pts[d], pts[a], pts[j]) >= 0)
      if (!inside) cut = k
    }
    if (cut < 0) cut = 0
    const [a, b, d] = [idx[(cut - 1 + idx.length) % idx.length], idx[cut], idx[(cut + 1) % idx.length]]
    tris.push([ring[a], ring[b], ring[d]])
    idx.splice(cut, 1)
  }
  tris.push(idx.map((i) => ring[i]))
  return tris
}

export interface ProfileCageInfo {
  cage: Cage
  /** profile samples (cage points per ring) */
  around: number
  corners: number
}

/**
 * Extrude a profile (sketch coordinates) `height` mm along the sketch normal
 * (a negative height goes the other way). A closed profile gets flat caps
 * with creased rims; an open one makes an open sheet.
 */
export function extrudeProfileCage(path: SketchPath, frame: PlaneFrame, height: number, perLoop = 48): ProfileCageInfo {
  let { pts, corner } = sampleProfile(path, perLoop)
  if (path.closed && signedArea(pts) < 0) { pts = [...pts].reverse(); corner = [...corner].reverse() }
  const up = height >= 0
  const h = Math.abs(height) || 1
  const Q = interpolateProfile(pts, corner, path.closed)
  const n = Q.length
  // the sides are straight up the height: two spans, a middle ring to shape by
  const K = 2
  const map = planeMap(frame)
  const positions: Vec3[] = []
  for (let k = 0; k <= K; k++) for (let j = 0; j < n; j++) positions.push(map.at(Q[j], ((up ? 1 : -1) * h * k) / K))
  const at = (k: number, j: number) => k * n + (j % n)
  const faces: number[][] = []
  const spans = path.closed ? n : n - 1
  for (let k = 0; k < K; k++) {
    for (let j = 0; j < spans; j++) {
      // a counter-clockwise profile, then along the normal: faces outward
      const f = [at(k, j), at(k, j + 1), at(k + 1, j + 1), at(k + 1, j)]
      faces.push(up ? f : [...f].reverse())
    }
  }
  const creases: string[] = []
  if (path.closed) {
    const bottom = Array.from({ length: n }, (_, j) => at(0, j)), top = Array.from({ length: n }, (_, j) => at(K, j))
    const caps = capFaces(pts, top)
    const low = capFaces(pts, bottom).map((f) => [...f].reverse())
    faces.push(...(up ? [...low, ...caps] : [...caps.map((f) => [...f].reverse()), ...low.map((f) => [...f].reverse())]))
    for (const ring of [bottom, top]) for (let j = 0; j < n; j++) creases.push(edgeKey(ring[j], ring[(j + 1) % n]))
  }
  for (let j = 0; j < n; j++) if (corner[j] && (path.closed || (j > 0 && j < n - 1))) for (let k = 0; k < K; k++) creases.push(edgeKey(at(k, j), at(k + 1, j)))
  return { cage: { positions, faces, creases }, around: n, corners: corner.filter(Boolean).length }
}

export interface RevolveAxis {
  /** a point on the axis and its direction, sketch coordinates */
  a: P2
  d: P2
  label: string
}

/**
 * The axis Revolve turns a profile round: the sketch's first construction line
 * the profile does not cross, else its Y axis, else its X axis, else a line
 * along Y touching the profile's left side.
 */
export function revolveAxis(entities: readonly SketchEntity[], path: SketchPath): RevolveAxis {
  const pts: P2[] = path.points.map((p) => [p[0], p[1]])
  const unit2 = (v: P2): P2 => { const l = Math.hypot(v[0], v[1]) || 1; return [v[0] / l, v[1] / l] }
  const candidates: RevolveAxis[] = []
  for (const e of entities) {
    if (e.kind === 'line' && e.construction && d2([e.start.x, e.start.y], [e.end.x, e.end.y]) > 1e-9) {
      candidates.push({ a: [e.start.x, e.start.y], d: unit2([e.end.x - e.start.x, e.end.y - e.start.y]), label: 'the construction line' })
    }
  }
  candidates.push({ a: [0, 0], d: [0, 1], label: 'the sketch Y axis' }, { a: [0, 0], d: [1, 0], label: 'the sketch X axis' })
  const span = Math.max(1, ...pts.map((p) => Math.hypot(p[0], p[1])))
  const oneSide = (ax: RevolveAxis) => {
    const s = pts.map((p) => (p[0] - ax.a[0]) * ax.d[1] - (p[1] - ax.a[1]) * ax.d[0])
    const tol = 1e-6 * span
    return s.every((v) => v >= -tol) || s.every((v) => v <= tol)
  }
  const hit = candidates.find(oneSide)
  if (hit) return hit
  const minX = Math.min(...pts.map((p) => p[0]))
  return { a: [minX, 0], d: [0, 1], label: 'a line along Y at the profile\'s left edge' }
}

/**
 * Revolve a profile (sketch coordinates) round `axis`: a full turn, or
 * `angleDeg` degrees, with `segments` cage spans round. Profile points on the
 * axis weld into poles, so a half outline closes into a solid of revolution.
 * Short of a full turn a closed profile gets a flat cap at each end (rims
 * creased) and an open one makes an open sheet. Faces point outward.
 */
export function revolveProfileCage(path: SketchPath, frame: PlaneFrame, axis: RevolveAxis, segments = 16, perLoop = 48, angleDeg = 360): ProfileCageInfo & { poles: number } {
  const { pts, corner } = sampleProfile(path, perLoop)
  const Q = interpolateProfile(pts, corner, path.closed)
  const n = Math.max(3, Math.round(segments))
  const angle = Math.min(360, Math.max(1, angleDeg))
  const full = angle >= 360 - 1e-9
  const rings = full ? n : n + 1
  const step = ((angle * Math.PI) / 180) / n
  const map = planeMap(frame)
  // axis frame in model space: A + D s + (E cos t + N sin t) r
  const D = map.dir(axis.d)
  let side = 0
  for (const p of pts) { const s = (p[0] - axis.a[0]) * axis.d[1] - (p[1] - axis.a[1]) * axis.d[0]; if (Math.abs(s) > Math.abs(side)) side = s }
  const e2: P2 = side >= 0 ? [axis.d[1], -axis.d[0]] : [-axis.d[1], axis.d[0]]
  const E = map.dir(e2)
  const N = map.n
  const A = map.at(axis.a)
  // round the turn the skin passes inside its ring points by this much; the end rings of a part turn are
  // the cap rims (creased, so the skin runs through them) and stay on the profile
  const pad = 3 / (2 + Math.cos(step))
  const scale = Math.max(1, ...pts.map((p) => Math.hypot(p[0] - axis.a[0], p[1] - axis.a[1])))
  const m = Q.length
  const positions: Vec3[] = []
  const onAxis: number[] = []
  for (let i = 0; i < m; i++) {
    const v: P2 = [Q[i][0] - axis.a[0], Q[i][1] - axis.a[1]]
    const s = v[0] * axis.d[0] + v[1] * axis.d[1]
    const r = Math.max(0, v[0] * e2[0] + v[1] * e2[1])
    const pole = r <= 1e-6 * scale
    for (let j = 0; j < rings; j++) {
      const t = step * j
      const rim = !full && path.closed && (j === 0 || j === rings - 1)
      const rr = pole ? 0 : r * (rim ? 1 : pad)
      const c = Math.cos(t) * rr, sn = Math.sin(t) * rr
      positions.push([A[0] + D[0] * s + E[0] * c + N[0] * sn, A[1] + D[1] * s + E[1] * c + N[1] * sn, A[2] + D[2] * s + E[2] * c + N[2] * sn])
      if (pole) onAxis.push(i * rings + j)
    }
  }
  const at = (i: number, j: number) => (i % m) * rings + (full ? j % n : j)
  let faces: number[][] = []
  for (let i = 0; i < (path.closed ? m : m - 1); i++) for (let j = 0; j < n; j++) faces.push([at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)])
  const creases: string[] = []
  for (let i = 0; i < m; i++) if (corner[i] && (path.closed || (i > 0 && i < m - 1))) for (let j = 0; j < n; j++) creases.push(edgeKey(at(i, j), at(i, j + 1)))
  if (!full && path.closed) {
    // the two end caps, wound against the side faces they meet so the cage stays one way round
    const ccw = signedArea(pts) >= 0
    const loopPts = ccw ? pts : [...pts].reverse()
    for (const j of [0, rings - 1]) {
      const ring = Array.from({ length: m }, (_, i) => at(i, j))
      let cap = capFaces(loopPts, ccw ? ring : [...ring].reverse())
      const [a, b] = [cap[0][0], cap[0][1]]
      const sideRuns = faces.some((f) => f.some((q, k) => q === a && f[(k + 1) % f.length] === b))
      if (sideRuns) cap = cap.map((f) => [...f].reverse())
      faces.push(...cap)
      for (let i = 0; i < m; i++) creases.push(edgeKey(ring[i], ring[(i + 1) % m]))
    }
  }
  let cage: Cage = { positions, faces, creases }
  let poles = 0
  if (onAxis.length > 0) {
    const w = weldByDistance(cage, onAxis, 1e-6 * scale)
    if (w !== null) { cage = w.cage; poles = w.points.filter((p) => p >= 0).length }
  }
  // outward: flip every face when the enclosed volume comes out negative (an open sheet has no inside)
  if ((full || path.closed) && cageVolume(cage) < 0) {
    faces = cage.faces.map((f) => [...f].reverse())
    cage = { ...cage, faces }
  }
  return { cage, around: m, corners: corner.filter(Boolean).length, poles }
}

/** Signed volume the cage's faces enclose (fan triangles); its sign says which way they face. */
export function cageVolume(cage: Cage): number {
  const P = cage.positions
  let v = 0
  for (const f of cage.faces) {
    for (let i = 1; i + 1 < f.length; i++) {
      const a = P[f[0]], b = P[f[i]], c = P[f[i + 1]]
      v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    }
  }
  return v
}
