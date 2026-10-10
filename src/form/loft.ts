// Form - Loft: a form through two or more sketch profiles.
//
// Each profile is resampled to the same number of points, evenly by length,
// and taken into model space on its sketch's plane. The rings are turned to
// face one way along the loft (the direction from the first profile's centre to
// the last's) and each is rotated to line up with the one before (least total
// distance), so the band does not twist. Rings are added between profiles,
// straight across, about as far apart as the points round a ring. Closed
// profiles get a flat cap at each end (rims creased); open ones make a sheet.
// Last, Pull (shapeTools pullToLimit) moves the profile rings so the smooth
// skin passes through every profile, not just near it.
//
// Rails: open sketch curves from the first profile to the last (railOf says
// which sketches are rails). Each ties the ring point nearest its start; every
// ring between the profiles is placed so its tied points lie on the rails: one
// rail sets the ring's size (a scale about its centre, and its place along the
// loft), two set size, turn and place (the similarity taking the two tied
// points onto the two rails), and any more rail puts its own tied point on it.
// The tied points are pulled with the profiles, so the skin follows the rails.

import type { Cage, Vec3 } from './cage'
import { edgeKey } from './cage'
import type { PlaneFrame, SketchPath } from './pipe'
import { capFaces, cageVolume, planeMap } from './profile'
import { pullToLimit } from './shapeTools'

type P2 = [number, number]

export interface LoftProfile { path: SketchPath; frame: PlaneFrame }

/**
 * A cage lofted through `profiles` (sketch coordinates on their frames), or why
 * not. `count` points round each ring.
 */
export function loftCage(profiles: readonly LoftProfile[], count = 32, rails: readonly LoftProfile[] = []): { cage: Cage; rings: number; between: number; pulledMm: number; railed: number } | { reason: string } {
  if (profiles.length < 2) return { reason: 'Loft needs two or more profiles' }
  const closed = profiles[0].path.closed
  if (profiles.some((p) => p.path.closed !== closed)) return { reason: 'Loft joins profiles that are all closed or all open, not a mix' }
  const n = Math.max(3, Math.round(count))
  // each profile: n points evenly by length, in model space
  const rings2: P2[][] = profiles.map((p) => resample(p.path.points.map((q) => [q[0], q[1]] as P2), closed, n))
  const rings: Vec3[][] = rings2.map((pts, k) => { const m = planeMap(profiles[k].frame); return pts.map((q) => m.at(q)) })
  const centre = (r: Vec3[]) => [0, 1, 2].map((c) => r.reduce((a, p) => a + p[c], 0) / r.length) as Vec3
  const along = sub(centre(rings[rings.length - 1]), centre(rings[0]))
  if (!(Math.hypot(...along) > 1e-9)) return { reason: 'The profiles are all in one place: a loft needs them apart' }
  // one way round along the loft; each ring lined up with the one before
  const order2 = rings2.map((r) => r)
  for (let k = 0; k < rings.length; k++) {
    if (closed && dot(newell(rings[k]), along) < 0) { rings[k] = [...rings[k]].reverse(); order2[k] = [...order2[k]].reverse() }
    if (k === 0) continue
    const prev = rings[k - 1]
    let best = 0, bestLen = Infinity
    const shifts = closed ? n : 1
    for (let s = 0; s < shifts; s++) {
      let len = 0
      for (let i = 0; i < n; i++) len += dist(prev[i], rings[k][(i + s) % n])
      if (len < bestLen) { bestLen = len; best = s }
    }
    // an open profile may run the other way: take it reversed when that lines up better
    if (!closed) {
      const rev = [...rings[k]].reverse()
      let lenRev = 0
      for (let i = 0; i < n; i++) lenRev += dist(prev[i], rev[i])
      if (lenRev < bestLen) { rings[k] = rev; order2[k] = [...order2[k]].reverse() }
    }
    rings[k] = [...rings[k].slice(best), ...rings[k].slice(0, best)]
    order2[k] = [...order2[k].slice(best), ...order2[k].slice(0, best)]
  }
  // each rail in model space, run from the first profile, tied to the first ring's point nearest its start,
  // and where on it each profile's tied point sits (arc length). Only a rail that still runs from the first profile
  // to the last shapes the loft: one that ends short (a profile added past its end) would fold the rings beyond it.
  const railTies = rails.filter((rail) => railOf(profiles, rail)).map((rail) => {
    const m = planeMap(rail.frame)
    let pts = rail.path.points.map((q) => m.at([q[0], q[1]]))
    const nearFirst = (p: Vec3) => Math.min(...rings[0].map((q) => dist(p, q)))
    if (nearFirst(pts[pts.length - 1]) < nearFirst(pts[0])) pts = [...pts].reverse()
    let column = 0
    rings[0].forEach((q, i) => { if (dist(q, pts[0]) < dist(rings[0][column], pts[0])) column = i })
    const line = polyline(pts)
    return { line, column, atProfile: rings.map((r) => line.nearest(r[column])) }
  })
  // rings between the profiles, straight across, about as far apart as the points round a ring
  const spacing = rings.reduce((a, r) => a + perimeter(r, closed), 0) / rings.length / n
  const all: Vec3[][] = [rings[0]]
  const profileRing: number[] = [0]
  let between = 0
  for (let k = 1; k < rings.length; k++) {
    const gap = dist(centre(rings[k - 1]), centre(rings[k]))
    const steps = Math.min(16, Math.max(1, Math.round(gap / Math.max(spacing, 1e-9))))
    const axis = unit(sub(centre(rings[k]), centre(rings[k - 1])))
    for (let j = 1; j < steps; j++) {
      const f = j / steps
      const straight = rings[k - 1].map((p, i) => [p[0] + (rings[k][i][0] - p[0]) * f, p[1] + (rings[k][i][1] - p[1]) * f, p[2] + (rings[k][i][2] - p[2]) * f] as Vec3)
      const onRails = railTies.map((t) => t.line.at(t.atProfile[k - 1] + (t.atProfile[k] - t.atProfile[k - 1]) * f))
      all.push(railTies.length === 0 ? straight : ringOnRails(straight, railTies.map((t) => t.column), onRails, axis))
      between++
    }
    profileRing.push(all.length)
    all.push(rings[k])
  }
  const R = all.length
  const at = (k: number, i: number) => k * n + (closed ? i % n : i)
  const positions: Vec3[] = all.flat()
  const faces: number[][] = []
  for (let k = 0; k + 1 < R; k++) for (let i = 0; i < (closed ? n : n - 1); i++) faces.push([at(k, i), at(k, i + 1), at(k + 1, i + 1), at(k + 1, i)])
  const creases: string[] = []
  if (closed) {
    for (const [k, pts2] of [[0, order2[0]], [R - 1, order2[order2.length - 1]]] as const) {
      const ring = Array.from({ length: n }, (_, i) => at(k, i))
      // capFaces wants its loop counter-clockwise in the profile's own plane
      const ccw = signedArea(pts2) >= 0
      let cap = capFaces(ccw ? pts2 : [...pts2].reverse(), ccw ? ring : [...ring].reverse())
      const [a, b] = [cap[0][0], cap[0][1]]
      if (faces.some((f) => f.some((q, j) => q === a && f[(j + 1) % f.length] === b))) cap = cap.map((f) => [...f].reverse())
      faces.push(...cap)
      for (let i = 0; i < n; i++) creases.push(edgeKey(ring[i], ring[(i + 1) % n]))
    }
  }
  let cage: Cage = { positions, faces, creases }
  if (closed && cageVolume(cage) < 0) cage = { ...cage, faces: cage.faces.map((f) => [...f].reverse()) }
  // the skin through every profile: pull the profile rings' points to where they are
  const onProfiles = profileRing.flatMap((k) => Array.from({ length: n }, (_, i) => at(k, i)))
  // and the rails: every ring's tied points
  const onRails = railTies.flatMap((t) => Array.from({ length: R }, (_, k) => at(k, t.column)))
  const pulled = pullToLimit(cage, [...new Set([...onProfiles, ...onRails])])
  if (pulled !== null) cage = pulled.cage
  return { cage, rings: R, between, pulledMm: pulled?.before ?? 0, railed: railTies.length }
}

/**
 * Whether `candidate` is a rail for a loft through `profiles`: an open curve
 * whose two ends lie on the first and last profiles (within 5% of the loft's
 * length, at least 1 mm), in either direction.
 */
export function railOf(profiles: readonly LoftProfile[], candidate: LoftProfile): boolean {
  if (profiles.length < 2 || candidate.path.closed || candidate.path.points.length < 2) return false
  const model = (p: LoftProfile) => { const m = planeMap(p.frame); return p.path.points.map((q) => m.at([q[0], q[1]])) }
  const first = model(profiles[0]), last = model(profiles[profiles.length - 1]), rail = model(candidate)
  const mid = (r: Vec3[]) => [0, 1, 2].map((c) => r.reduce((a, p) => a + p[c], 0) / r.length) as Vec3
  const tol = Math.max(1, 0.05 * dist(mid(first), mid(last)))
  const near = (p: Vec3, r: Vec3[]) => polyline(profiles[0].path.closed ? [...r, r[0]] : r).distance(p) <= tol
  const a = rail[0], b = rail[rail.length - 1]
  return (near(a, first) && near(b, last)) || (near(b, first) && near(a, last))
}

/**
 * A ring (straight across between two profiles) placed on the rails: its
 * points `columns` go to `targets`. One rail: scaled about its centre (the
 * size across the loft `axis`) and moved along the axis. Two or more: the
 * similarity taking the first two tied points onto the first two targets.
 * Then every tied point is put exactly on its target.
 */
function ringOnRails(ring: readonly Vec3[], columns: readonly number[], targets: readonly Vec3[], axis: Vec3): Vec3[] {
  let out: Vec3[]
  if (columns.length === 1) {
    const c = [0, 1, 2].map((k) => ring.reduce((a, p) => a + p[k], 0) / ring.length) as Vec3
    const perp = (v: Vec3): Vec3 => sub(v, scale(axis, dot(v, axis)))
    const from = perp(sub(ring[columns[0]], c)), to = perp(sub(targets[0], c))
    const s = Math.hypot(...from) > 1e-9 ? Math.hypot(...to) / Math.hypot(...from) : 1
    const shift = scale(axis, dot(sub(targets[0], ring[columns[0]]), axis))
    out = ring.map((p) => add(add(c, scale(sub(p, c), s)), shift))
  } else {
    const a = ring[columns[0]], b = ring[columns[1]]
    const u = sub(b, a), v = sub(targets[1], targets[0])
    const s = Math.hypot(...u) > 1e-9 ? Math.hypot(...v) / Math.hypot(...u) : 1
    const turn = rotationBetween(unit(u), unit(v))
    out = ring.map((p) => add(targets[0], scale(turn(sub(p, a)), s)))
  }
  columns.forEach((col, i) => { out[col] = targets[i] })
  return out
}

/** The smallest rotation taking unit vector u onto unit vector v (half a turn about a square axis when opposite). */
function rotationBetween(u: Vec3, v: Vec3): (p: Vec3) => Vec3 {
  const c = dot(u, v)
  let k = cross(u, v)
  let sn = Math.hypot(...k)
  if (sn < 1e-12) {
    if (c > 0) return (p) => p
    k = cross(u, Math.abs(u[0]) < 0.9 ? [1, 0, 0] : [0, 1, 0])
    sn = 0
  }
  const axis = unit(k), co = sn === 0 ? -1 : c, si = sn === 0 ? 0 : sn
  return (p) => add(add(scale(p, co), scale(cross(axis, p), si)), scale(axis, dot(axis, p) * (1 - co)))
}

/** A polyline measured by arc length: the point at a length, the length of the nearest point, the distance to it. */
function polyline(pts: readonly Vec3[]): { at: (u: number) => Vec3; nearest: (p: Vec3) => number; distance: (p: Vec3) => number } {
  const cum = [0]
  for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist(pts[i - 1], pts[i]))
  const closest = (p: Vec3) => {
    let best = { u: 0, d: Infinity }
    for (let i = 1; i < pts.length; i++) {
      const a = pts[i - 1], e = sub(pts[i], a), l2 = dot(e, e)
      const t = l2 > 0 ? Math.max(0, Math.min(1, dot(sub(p, a), e) / l2)) : 0
      const d = dist(p, add(a, scale(e, t)))
      if (d < best.d) best = { u: cum[i - 1] + t * (cum[i] - cum[i - 1]), d }
    }
    return best
  }
  return {
    at: (u) => {
      const w = Math.max(0, Math.min(cum[cum.length - 1], u))
      let i = 1
      while (i < cum.length - 1 && cum[i] < w) i++
      const f = cum[i] > cum[i - 1] ? (w - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0
      return add(pts[i - 1], scale(sub(pts[i], pts[i - 1]), f))
    },
    nearest: (p) => closest(p).u,
    distance: (p) => closest(p).d,
  }
}

/** `n` points evenly by length along a polyline (closed: round the loop, no repeat of the first). */
function resample(pts: readonly P2[], closed: boolean, n: number): P2[] {
  const P = closed ? [...pts, pts[0]] : [...pts]
  const cum = [0]
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + Math.hypot(P[i][0] - P[i - 1][0], P[i][1] - P[i - 1][1]))
  const total = cum[cum.length - 1]
  const out: P2[] = []
  const count = closed ? n : n - 1
  for (let j = 0; j < n; j++) {
    const s = (total * j) / count
    let i = 1
    while (i < cum.length - 1 && cum[i] < s) i++
    const f = cum[i] > cum[i - 1] ? (s - cum[i - 1]) / (cum[i] - cum[i - 1]) : 0
    out.push([P[i - 1][0] + (P[i][0] - P[i - 1][0]) * f, P[i - 1][1] + (P[i][1] - P[i - 1][1]) * f])
  }
  return out
}

function signedArea(pts: readonly P2[]): number {
  let a = 0
  for (let i = 0; i < pts.length; i++) { const p = pts[i], q = pts[(i + 1) % pts.length]; a += p[0] * q[1] - q[0] * p[1] }
  return a / 2
}

function perimeter(r: readonly Vec3[], closed: boolean): number {
  let l = 0
  for (let i = 0; i + (closed ? 0 : 1) < r.length; i++) l += dist(r[i], r[(i + 1) % r.length])
  return l
}

function newell(pts: readonly Vec3[]): Vec3 {
  const n: Vec3 = [0, 0, 0]
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length]
    n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1])
  }
  return n
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, k: number): Vec3 => [a[0] * k, a[1] * k, a[2] * k]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]) || 1; return [a[0] / l, a[1] / l, a[2] / l] }
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
