// Form - Pipe: a tube cage along a sketch curve.
//
//   sketchPaths  a sketch's curves (lines, arcs, circles, splines, ellipses) as
//                3D point chains: pieces meeting end to end are joined, in the
//                order the curve runs, whatever order they were drawn in
//   pipeCage     rings of `sides` points round the chain - frames that do not
//                twist (rotation-minimising) - joined by quads; an open chain's ends are
//                capped by one face each, their rims creased so the ends stay
//                crisp. The cage radius is padded so the smooth skin (which
//                sits inside its cage) comes out at the radius asked for. A
//                closed path that is not flat brings its frame back round
//                turned; the turn is spread evenly along the loop, so the last
//                ring meets the first untwisted.
//   joinPaths    two open chains joined end to end (either way round) into one,
//                closed when the far ends meet too: curves on different
//                sketch planes make one 3D path

import type { Cage, Vec3 } from './cage'
import { edgeKey } from './cage'
import type { SketchEntity } from '../lib/sketch/types'
import { tessellateSpline } from '../lib/sketch/spline'

export interface PlaneFrame {
  origin: { x: number; y: number; z: number }
  normal: { x: number; y: number; z: number }
  xDir: { x: number; y: number; z: number }
}

export interface SketchPath {
  points: Vec3[]
  closed: boolean
}

type P2 = [number, number]

/** Points along one sketch entity (sketch-local), start to end; null for what is not a curve. */
function entityPolyline(e: SketchEntity): { pts: P2[]; closed: boolean } | null {
  const arcPts = (cx: number, cy: number, r: number, a0: number, a1: number): P2[] => {
    const n = Math.max(2, Math.ceil(Math.abs(a1 - a0) / (Math.PI / 24)))
    return Array.from({ length: n + 1 }, (_, i) => { const a = a0 + ((a1 - a0) * i) / n; return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as P2 })
  }
  const ellipsePts = (cx: number, cy: number, ra: number, rb: number, rot: number, t0: number, t1: number): P2[] => {
    const n = Math.max(2, Math.ceil(Math.abs(t1 - t0) / (Math.PI / 24)))
    const c = Math.cos(rot), s = Math.sin(rot)
    return Array.from({ length: n + 1 }, (_, i) => {
      const t = t0 + ((t1 - t0) * i) / n
      const x = ra * Math.cos(t), y = rb * Math.sin(t)
      return [cx + x * c - y * s, cy + x * s + y * c] as P2
    })
  }
  switch (e.kind) {
    case 'line': return { pts: [[e.start.x, e.start.y], [e.end.x, e.end.y]], closed: false }
    case 'arc': {
      let a1 = e.endAngle
      while (a1 <= e.startAngle) a1 += Math.PI * 2
      return { pts: arcPts(e.center.x, e.center.y, e.radius, e.startAngle, a1), closed: false }
    }
    case 'circle': return { pts: arcPts(e.center.x, e.center.y, e.radius, 0, Math.PI * 2).slice(0, -1), closed: true }
    case 'ellipse': return { pts: ellipsePts(e.center.x, e.center.y, e.majorRadius, e.minorRadius, e.rotation, 0, Math.PI * 2).slice(0, -1), closed: true }
    case 'elliptical-arc': {
      let t1 = e.endParam
      while (t1 <= e.startParam) t1 += Math.PI * 2
      return { pts: ellipsePts(e.center.x, e.center.y, e.majorRadius, e.minorRadius, e.rotation, e.startParam, t1), closed: false }
    }
    case 'spline': {
      const pts = tessellateSpline(e.points, e.closed, undefined, e.form).map((p) => [p.x, p.y] as P2)
      if (e.closed && pts.length > 1 && Math.hypot(pts[0][0] - pts[pts.length - 1][0], pts[0][1] - pts[pts.length - 1][1]) < 1e-9) pts.pop()
      return { pts, closed: e.closed }
    }
    default: return null
  }
}

/**
 * The curves of a sketch as 3D chains, longest first. Construction geometry is
 * left out; pieces whose ends meet (within `tol` mm) are joined into one chain.
 */
export function sketchPaths(entities: readonly SketchEntity[], frame: PlaneFrame, tol = 1e-4): SketchPath[] {
  const pieces: Array<{ pts: P2[]; closed: boolean }> = []
  for (const e of entities) {
    if (e.construction) continue
    const p = entityPolyline(e)
    if (p !== null && p.pts.length >= 2) pieces.push(p)
  }
  const near = (a: P2, b: P2) => Math.hypot(a[0] - b[0], a[1] - b[1]) <= tol
  const chains: Array<{ pts: P2[]; closed: boolean }> = pieces.filter((p) => p.closed)
  const open = pieces.filter((p) => !p.closed)
  const used = new Set<number>()
  const endsAt = (pt: P2, skip: number) => open.findIndex((q, i) => i !== skip && !used.has(i) && (near(q.pts[0], pt) || near(q.pts[q.pts.length - 1], pt)))
  // start from a piece with a free end, so an open chain is walked from one of its ends
  const order = open.map((_, i) => i).sort((a, b) => Number(endsAt(open[b].pts[0], b) < 0) - Number(endsAt(open[a].pts[0], a) < 0))
  for (const s of order) {
    if (used.has(s)) continue
    used.add(s)
    let pts = [...open[s].pts]
    for (const atEnd of [true, false]) {
      for (;;) {
        const tip = atEnd ? pts[pts.length - 1] : pts[0]
        const k = endsAt(tip, -1)
        if (k < 0) break
        used.add(k)
        let q = open[k].pts
        if (atEnd) { if (!near(q[0], tip)) q = [...q].reverse(); pts = [...pts, ...q.slice(1)] }
        else { if (!near(q[q.length - 1], tip)) q = [...q].reverse(); pts = [...q.slice(0, -1), ...pts] }
      }
    }
    const closed = pts.length > 3 && near(pts[0], pts[pts.length - 1])
    if (closed) pts.pop()
    chains.push({ pts, closed })
  }
  const n = frame.normal, x = frame.xDir
  const y = { x: n.y * x.z - n.z * x.y, y: n.z * x.x - n.x * x.z, z: n.x * x.y - n.y * x.x }
  const yl = Math.hypot(y.x, y.y, y.z) || 1
  const to3 = (p: P2): Vec3 => [
    frame.origin.x + x.x * p[0] + (y.x / yl) * p[1],
    frame.origin.y + x.y * p[0] + (y.y / yl) * p[1],
    frame.origin.z + x.z * p[0] + (y.z / yl) * p[1],
  ]
  return chains
    .map((c) => ({ points: c.pts.map(to3), closed: c.closed }))
    .sort((a, b) => pathLength(b) - pathLength(a))
}

export function pathLength(path: SketchPath): number {
  const P = path.points
  let L = 0
  for (let i = 1; i < P.length; i++) L += dist(P[i - 1], P[i])
  if (path.closed && P.length > 1) L += dist(P[P.length - 1], P[0])
  return L
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? scale(a, 1 / l) : [0, 0, 0] }
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

/** `count` points at equal arc length along the path (a closed path's last point is not its first). */
function resample(path: SketchPath, count: number): Vec3[] {
  const P = path.closed ? [...path.points, path.points[0]] : path.points
  const cum = [0]
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + dist(P[i - 1], P[i]))
  const L = cum[cum.length - 1]
  const out: Vec3[] = []
  const steps = path.closed ? count : count - 1
  let seg = 1
  for (let k = 0; k < count; k++) {
    const s = (L * k) / steps
    while (seg < P.length - 1 && cum[seg] < s) seg++
    const t = cum[seg] > cum[seg - 1] ? (s - cum[seg - 1]) / (cum[seg] - cum[seg - 1]) : 0
    out.push([P[seg - 1][0] + (P[seg][0] - P[seg - 1][0]) * t, P[seg - 1][1] + (P[seg][1] - P[seg - 1][1]) * t, P[seg - 1][2] + (P[seg][2] - P[seg - 1][2]) * t])
  }
  return out
}

export interface PipeOptions {
  /** the tube's radius, mm */
  radius: number
  /** points round each ring (default 8) */
  sides?: number
  /** ring spacing along the path, mm (default 1.5 x radius) */
  spacing?: number
}

/** A tube cage round `path` (see the file header). */
export function pipeCage(path: SketchPath, opts: PipeOptions): Cage {
  const n = Math.max(3, Math.round(opts.sides ?? 8))
  const L = pathLength(path)
  const spacing = Math.max(opts.spacing ?? opts.radius * 1.5, L / 400)
  const count = Math.max(path.closed ? 3 : 2, Math.round(L / spacing) + (path.closed ? 0 : 1))
  const C = resample(path, count)
  const m = C.length
  const tangent = (i: number): Vec3 => {
    const a = path.closed ? C[(i - 1 + m) % m] : C[Math.max(0, i - 1)]
    const b = path.closed ? C[(i + 1) % m] : C[Math.min(m - 1, i + 1)]
    return unit(sub(b, a))
  }
  const T = C.map((_, i) => tangent(i))
  // first normal: across the path's plane where it has one (a planar sketch curve), else any perpendicular
  let u0: Vec3 = [0, 0, 0]
  for (let i = 1; i < m && Math.hypot(...u0) < 1e-9; i++) u0 = cross(T[0], T[i])
  if (Math.hypot(...u0) < 1e-9) u0 = cross(T[0], Math.abs(T[0][2]) < 0.9 ? [0, 0, 1] : [1, 0, 0])
  u0 = unit(u0)
  // rotation-minimising frames by double reflection (Wang et al. 2008)
  const U: Vec3[] = [u0]
  for (let i = 0; i + 1 < (path.closed ? m + 1 : m); i++) {
    const a = C[i % m], b = C[(i + 1) % m], ta = T[i % m], tb = T[(i + 1) % m]
    const v1 = sub(b, a), c1 = dot(v1, v1)
    if (c1 < 1e-18) { U.push(U[i]); continue }
    const rL = sub(U[i], scale(v1, (2 / c1) * dot(v1, U[i])))
    const tL = sub(ta, scale(v1, (2 / c1) * dot(v1, ta)))
    const v2 = sub(tb, tL), c2 = dot(v2, v2)
    U.push(unit(c2 < 1e-18 ? rL : sub(rL, scale(v2, (2 / c2) * dot(v2, rL)))))
  }
  // a planar curve comes back round a closed path untwisted; a 3D one comes back turned about the start's
  // tangent by some angle: spread the opposite turn evenly along the loop so the last ring meets the first
  if (path.closed && U.length > m) {
    const back = U[m], v0 = cross(T[0], U[0])
    const turn = Math.atan2(dot(back, v0), dot(back, U[0]))
    for (let i = 1; i < m; i++) {
      const a = (-turn * i) / m, t = T[i], u = U[i], w = cross(t, u)
      U[i] = unit([u[0] * Math.cos(a) + w[0] * Math.sin(a), u[1] * Math.cos(a) + w[1] * Math.sin(a), u[2] * Math.cos(a) + w[2] * Math.sin(a)])
    }
  }
  U.length = m
  // a ring of cage points on a circle of radius R has a limit curve of radius R (2 + cos(2 pi / n)) / 3
  const R = opts.radius * 3 / (2 + Math.cos((2 * Math.PI) / n))
  const positions: Vec3[] = []
  for (let i = 0; i < m; i++) {
    const v = cross(T[i], U[i])
    for (let j = 0; j < n; j++) {
      const a = (2 * Math.PI * j) / n
      const d = [U[i][0] * Math.cos(a) + v[0] * Math.sin(a), U[i][1] * Math.cos(a) + v[1] * Math.sin(a), U[i][2] * Math.cos(a) + v[2] * Math.sin(a)]
      positions.push([C[i][0] + d[0] * R, C[i][1] + d[1] * R, C[i][2] + d[2] * R])
    }
  }
  // along the path the skin follows a cubic B-spline of each column of cage points, (Q[i-1] + 4 Q[i] +
  // Q[i+1]) / 6, which cuts inside every bend: move each column so that spline passes through the ring
  // points (Jacobi on the diagonally dominant system; an open path's end rings are crease rims and stay)
  for (let j = 0; j < n; j++) {
    const target = Array.from({ length: m }, (_, i) => positions[i * n + j])
    let Q = target.map((q) => [...q] as Vec3)
    for (let it = 0; it < 60; it++) {
      Q = Q.map((q, i) => {
        if (!path.closed && (i === 0 || i === m - 1)) return q
        const a = Q[(i - 1 + m) % m], b = Q[(i + 1) % m]
        return [(6 * target[i][0] - a[0] - b[0]) / 4, (6 * target[i][1] - a[1] - b[1]) / 4, (6 * target[i][2] - a[2] - b[2]) / 4] as Vec3
      })
    }
    Q.forEach((q, i) => { positions[i * n + j] = q })
  }
  const at = (i: number, j: number) => (i % m) * n + (j % n)
  const faces: number[][] = []
  for (let i = 0; i < (path.closed ? m : m - 1); i++) {
    // (U, V, T) is right-handed: round the ring (j -> j+1), then along T, faces outward
    for (let j = 0; j < n; j++) faces.push([at(i, j), at(i, j + 1), at(i + 1, j + 1), at(i + 1, j)])
  }
  const creases: string[] = []
  if (!path.closed) {
    const first = Array.from({ length: n }, (_, j) => at(0, j))
    const last = Array.from({ length: n }, (_, j) => at(m - 1, j))
    faces.push([...first].reverse(), last)
    for (const ring of [first, last]) for (let j = 0; j < n; j++) creases.push(edgeKey(ring[j], ring[(j + 1) % n]))
  }
  return { positions, faces, creases }
}

/** A straight path along X through the origin, `length` mm long - Pipe's start when no sketch curve is picked. */
/**
 * `b` joined onto `a` where one of b's ends meets one of a's (within `tol`
 * mm), turned round as needed; closed when the other two ends meet too. Null
 * when either is closed or no ends meet.
 */
export function joinPaths(a: SketchPath, b: SketchPath, tol = 0.01): SketchPath | null {
  if (a.closed || b.closed || a.points.length < 2 || b.points.length < 2) return null
  const d = (p: Vec3, q: Vec3) => Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
  const aS = a.points[0], aE = a.points[a.points.length - 1], bS = b.points[0], bE = b.points[b.points.length - 1]
  let pts: Vec3[] | null = null
  if (d(aE, bS) <= tol) pts = [...a.points, ...b.points.slice(1)]
  else if (d(aE, bE) <= tol) pts = [...a.points, ...[...b.points].reverse().slice(1)]
  else if (d(aS, bE) <= tol) pts = [...b.points, ...a.points.slice(1)]
  else if (d(aS, bS) <= tol) pts = [...[...b.points].reverse(), ...a.points.slice(1)]
  if (pts === null) return null
  if (pts.length > 3 && d(pts[0], pts[pts.length - 1]) <= tol) return { points: pts.slice(0, -1), closed: true }
  return { points: pts, closed: false }
}

export function straightPath(length = 60): SketchPath {
  return { points: [[-length / 2, 0, 0], [length / 2, 0, 0]], closed: false }
}

/** The radius of the path's tightest bend (through each point and its neighbours), mm; Infinity for a straight path. A tube wider than this folds on itself there. */
export function tightestBend(path: SketchPath): number {
  const P = path.points
  let bend = Infinity
  const m = P.length
  for (let i = 0; i < m; i++) {
    if (!path.closed && (i === 0 || i === m - 1)) continue
    const a = P[(i - 1 + m) % m], b = P[i], c = P[(i + 1) % m]
    const ab = dist(a, b), bc = dist(b, c), ca = dist(c, a)
    const area2 = Math.hypot(...cross(sub(b, a), sub(c, a)))
    if (area2 > 1e-12) bend = Math.min(bend, (ab * bc * ca) / (2 * area2))
  }
  return bend
}

/**
 * Pipe's starting radius for a path: a twelfth of its length, kept under 0.6 x
 * its tightest bend (so the tube does not fold inside a bend), 0.5 to 10 mm, to
 * the half millimetre. The cage scales like any other afterwards.
 */
export function defaultPipeRadius(path: SketchPath): number {
  const r = Math.min(pathLength(path) / 12, 0.6 * tightestBend(path), 10)
  return Math.max(0.5, Math.round(r * 2) / 2)
}
