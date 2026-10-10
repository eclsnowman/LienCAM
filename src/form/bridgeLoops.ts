// Form - Bridge two edge loops or two face sets.
//
//   openLoops      a cage's open borders through given edges, as ordered chains
//                  running the way a new face beside them must run (against the
//                  one face each edge already has)
//   bridgeOpenings join two such chains - closed loops or open chains - with a
//                  band of faces, `segments` rings long: quads where the two
//                  have as many points, else a zip of quads and triangles by
//                  share of length
//   bridgeFaceSets remove two face sets and bridge the openings they leave
//
// A bridge between two loops of the same form makes a handle or a hole through
// it; between two pieces it joins them. Orientation is kept: every new face runs
// each open edge against the face already on it.
//
// The band's rings follow a curve (Hermite) that leaves each opening the way
// the surface there faces: a closed opening or face set along its normal,
// turned toward the other opening (or outward when the two sit side by side);
// an open border along the surface running on across it, when that heads
// toward the other opening (else straight). Two faces on a
// box's top arch into a handle; two opposite faces run straight through. With
// both ends aimed at each other the curve is the straight band exactly.

import type { Cage, Vec3 } from './cage'
import { edgeKey } from './cage'
import { compactWithMap } from './topoTools'

export interface OpenChain {
  /** points in the order a new face beside the chain runs them */
  points: number[]
  closed: boolean
}

const dist = (a: Vec3, b: Vec3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])

function edgeUses(cage: Cage): Map<string, Array<[number, number]>> {
  const uses = new Map<string, Array<[number, number]>>()
  for (const loop of cage.faces) {
    for (let i = 0; i < loop.length; i++) {
      const u = loop[i], v = loop[(i + 1) % loop.length]
      const k = edgeKey(u, v)
      const l = uses.get(k)
      if (l) l.push([u, v]); else uses.set(k, [[u, v]])
    }
  }
  return uses
}

/**
 * The open borders through `edges` (edges with one face; others ignored), as
 * chains. Each runs v -> u where its face runs u -> v. A point where the
 * chain would branch ends it.
 */
export function openLoops(cage: Cage, edges: readonly string[]): OpenChain[] {
  const uses = edgeUses(cage)
  const next = new Map<number, number>()
  const prev = new Map<number, number>()
  for (const k of new Set(edges)) {
    const u = uses.get(k)
    if (u === undefined || u.length !== 1) continue
    const [a, b] = u[0]
    // the new face runs b -> a
    if (next.has(b) || prev.has(a)) continue
    next.set(b, a)
    prev.set(a, b)
  }
  const seen = new Set<number>()
  const out: OpenChain[] = []
  // open chains first: start where nothing leads in
  for (const start of [...next.keys()].sort((x, y) => x - y)) {
    if (prev.has(start) || seen.has(start)) continue
    const pts = [start]
    seen.add(start)
    let cur = start
    while (next.has(cur)) { cur = next.get(cur)!; if (seen.has(cur)) break; pts.push(cur); seen.add(cur) }
    out.push({ points: pts, closed: false })
  }
  for (const start of [...next.keys()].sort((x, y) => x - y)) {
    if (seen.has(start)) continue
    const pts = [start]
    seen.add(start)
    let cur = next.get(start)!
    while (cur !== start && !seen.has(cur)) { pts.push(cur); seen.add(cur); cur = next.get(cur)! }
    out.push({ points: pts, closed: cur === start })
  }
  return out
}

/** Share of length at each point of a chain (0 at its first point; a closed chain's total includes the wrap). */
function shares(P: readonly Vec3[], closed: boolean): number[] {
  const cum = [0]
  for (let i = 1; i < P.length; i++) cum.push(cum[i - 1] + dist(P[i - 1], P[i]))
  const total = cum[cum.length - 1] + (closed ? dist(P[P.length - 1], P[0]) : 0)
  return cum.map((c) => (total > 0 ? c / total : 0))
}

/** The point at share `t` along a chain. */
function at(P: readonly Vec3[], closed: boolean, t: number): Vec3 {
  const Q = closed ? [...P, P[0]] : [...P]
  const s = shares(Q, false)
  let i = 1
  while (i < Q.length - 1 && s[i] < t) i++
  const f = s[i] > s[i - 1] ? (t - s[i - 1]) / (s[i] - s[i - 1]) : 0
  const a = Q[i - 1], b = Q[i]
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f]
}

/** Faces joining U to V (V already reversed and aligned so V[i] faces U[i]): quads when as long, else a zip by share. */
function zip(U: readonly number[], V: readonly number[], P: readonly Vec3[], closed: boolean): number[][] {
  const faces: number[][] = []
  const nU = U.length, nV = V.length
  if (nU === nV) {
    for (let i = 0; i < (closed ? nU : nU - 1); i++) faces.push([U[i], U[(i + 1) % nU], V[(i + 1) % nV], V[i]])
    return faces
  }
  const tU = shares(U.map((p) => P[p]), closed), tV = shares(V.map((p) => P[p]), closed)
  const endU = closed ? nU : nU - 1, endV = closed ? nV : nV - 1
  const tu = (i: number) => (i >= nU ? 1 : tU[i]), tv = (j: number) => (j >= nV ? 1 : tV[j])
  let i = 0, j = 0
  while (i < endU || j < endV) {
    const nextU = i < endU ? tu(i + 1) : Infinity, nextV = j < endV ? tv(j + 1) : Infinity
    if (i < endU && (j >= endV || nextU <= nextV)) { faces.push([U[i], U[(i + 1) % nU], V[j % nV]]); i++ }
    else { faces.push([U[i % nU], V[(j + 1) % nV], V[j]]); j++ }
  }
  return faces
}

/**
 * Join chains A and B (as openLoops gives them) with a band `segments` rings
 * long. Both closed or both open. Returns the cage (points appended) and the
 * new faces' indices, or null when the chains cannot be joined (one open and
 * one closed, a point shared, fewer than two points). `twist` turns a closed B
 * that many points further round than the lined-up start, so the band spirals
 * (open borders have ends to meet and take no twist).
 */
export function bridgeOpenings(cage: Cage, A: OpenChain, B: OpenChain, segments = 1, twist = 0): { cage: Cage; faces: number[] } | null {
  if (A.closed !== B.closed || A.points.length < 2 || B.points.length < 2) return null
  if (A.points.some((p) => B.points.includes(p))) return null
  const closed = A.closed
  const P = cage.positions.map((p) => [p[0], p[1], p[2]] as Vec3)
  // B runs the other way along the band; a closed B is turned to line up with A
  let Bv = [...B.points].reverse()
  if (closed) {
    let best = 0, bestLen = Infinity
    const n = Bv.length
    for (let k = 0; k < n; k++) {
      let len = 0
      if (n === A.points.length) for (let i = 0; i < n; i++) len += dist(P[A.points[i]], P[Bv[(i + k) % n]])
      else len = dist(P[A.points[0]], P[Bv[k]])
      if (len < bestLen) { bestLen = len; best = k }
    }
    const k0 = (((best + Math.round(twist)) % n) + n) % n
    Bv = [...Bv.slice(k0), ...Bv.slice(0, k0)]
  }
  const S = Math.max(1, Math.round(segments))
  const long = A.points.length >= Bv.length ? A.points : Bv
  const tLong = shares(long.map((p) => P[p]), closed)
  const pa = A.points.map((p) => P[p]), pb = Bv.map((p) => P[p])
  const [ta, tb] = bandTangents(cage, A, B)
  const rings: number[][] = [A.points]
  for (let k = 1; k < S; k++) {
    const f = k / S
    // Hermite: h00 a + h01 b + h10 ta + h11 tb
    const h00 = 2 * f ** 3 - 3 * f ** 2 + 1, h01 = -2 * f ** 3 + 3 * f ** 2, h10 = f ** 3 - 2 * f ** 2 + f, h11 = f ** 3 - f ** 2
    const ring: number[] = []
    for (const t of tLong) {
      const a = at(pa, closed, t), b = at(pb, closed, t)
      ring.push(P.length)
      P.push([0, 1, 2].map((c) => h00 * a[c] + h01 * b[c] + h10 * ta[c] + h11 * tb[c]) as Vec3)
    }
    rings.push(ring)
  }
  rings.push(Bv)
  const added: number[][] = []
  for (let k = 0; k < S; k++) added.push(...zip(rings[k], rings[k + 1], P, closed))
  const faces = [...cage.faces.map((f) => f.slice()), ...added]
  const first = cage.faces.length
  return { cage: { ...cage, positions: P, faces }, faces: added.map((_, i) => first + i) }
}

/**
 * The band's end tangents (direction of travel at A and at B; each as long as
 * the gap between the two openings' centres when aimed along it, up to twice
 * that when square to it). Each opening faces a way: a
 * closed chain along its Newell normal (the normal a face filling it would
 * have, which for a face set's outline is the set's own), an open chain along
 * the surface running on across it (from each border face's centre to its
 * border edge). A closed opening is left that way when it leads toward B or
 * square to it (side by side: outward), else the other way; an open one only
 * when it leads toward B, else straight. B is arrived at likewise.
 * An opening that faces no way (the directions cancel) is left straight.
 */
function bandTangents(cage: Cage, A: OpenChain, B: OpenChain): [Vec3, Vec3] {
  const P = cage.positions
  const mid = (pts: readonly number[]) => [0, 1, 2].map((c) => pts.reduce((s, p) => s + P[p][c], 0) / pts.length) as Vec3
  const cA = mid(A.points), cB = mid(B.points)
  const d: Vec3 = [cB[0] - cA[0], cB[1] - cA[1], cB[2] - cA[2]]
  const L = Math.hypot(...d)
  if (L < 1e-12) return [[0, 0, 0], [0, 0, 0]]
  const straight: Vec3 = [d[0] / L, d[1] / L, d[2] / L]
  const faces = (c: OpenChain): Vec3 => {
    const n: Vec3 = [0, 0, 0]
    if (c.closed) {
      c.points.forEach((p, i) => {
        const a = P[p], b = P[c.points[(i + 1) % c.points.length]]
        n[0] += (a[1] - b[1]) * (a[2] + b[2]); n[1] += (a[2] - b[2]) * (a[0] + b[0]); n[2] += (a[0] - b[0]) * (a[1] + b[1])
      })
    } else {
      const faceOf = new Map<string, number>()
      cage.faces.forEach((loop, fi) => loop.forEach((u, i) => { const k = edgeKey(u, loop[(i + 1) % loop.length]); if (!faceOf.has(k)) faceOf.set(k, fi) }))
      for (let i = 0; i + 1 < c.points.length; i++) {
        const u = c.points[i], v = c.points[i + 1]
        const f = faceOf.get(edgeKey(u, v))
        if (f === undefined) continue
        const fc = mid(cage.faces[f])
        for (let k = 0; k < 3; k++) n[k] += (P[u][k] + P[v][k]) / 2 - fc[k]
      }
    }
    const l = Math.hypot(...n)
    return l < 1e-9 ? [0, 0, 0] : [n[0] / l, n[1] / l, n[2] / l]
  }
  const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
  const eps = 1e-6
  const nA = faces(A), nB = faces(B)
  const neg = (v: Vec3): Vec3 => [-v[0], -v[1], -v[2]]
  // a closed opening may be left either way along its normal (a hole goes in, a handle comes out); an open
  // border only onward across it, and only when that heads toward the other opening (else straight: the
  // surface's own onward direction pointing away would fold the band back over the sheet)
  const leave = Math.hypot(...nA) === 0 ? straight
    : A.closed ? (dot(nA, straight) >= -eps ? nA : neg(nA))
      : (dot(nA, straight) > eps ? nA : straight)
  const arrive = Math.hypot(...nB) === 0 ? straight
    : B.closed ? (dot(nB, straight) <= eps ? neg(nB) : nB)
      : (dot(nB, straight) < -eps ? neg(nB) : straight)
  // as long as the gap when aimed along it (the straight band exactly), up to twice it when square to it (a
  // handle then rises about half the gap, near a half circle)
  const kA = L * (2 - Math.abs(dot(leave, straight))), kB = L * (2 - Math.abs(dot(arrive, straight)))
  return [[leave[0] * kA, leave[1] * kA, leave[2] * kA], [arrive[0] * kB, arrive[1] * kB, arrive[2] * kB]]
}

/** Connected face sets (faces sharing an edge) of `faces`. */
export function faceSets(cage: Cage, faces: readonly number[]): number[][] {
  const inSet = new Set(faces)
  const parent = new Map<number, number>([...inSet].map((f) => [f, f]))
  const find = (f: number): number => { let r = f; while (parent.get(r) !== r) r = parent.get(r)!; parent.set(f, r); return r }
  const byEdge = new Map<string, number>()
  for (const f of inSet) {
    const loop = cage.faces[f]
    for (let i = 0; i < loop.length; i++) {
      const k = edgeKey(loop[i], loop[(i + 1) % loop.length])
      const g = byEdge.get(k)
      if (g === undefined) byEdge.set(k, f); else parent.set(find(f), find(g))
    }
  }
  const groups = new Map<number, number[]>()
  for (const f of inSet) { const r = find(f); groups.set(r, [...(groups.get(r) ?? []), f]) }
  return [...groups.values()]
}

/**
 * The outline of a face set as one closed chain: the edges used once within
 * the set (open-border edges included), running the way the set's faces run
 * them - the way a band taking the set's place must. Null when the outline is
 * not one simple closed loop (a band round the form has two; a pinch has a
 * point twice).
 */
export function setOutline(cage: Cage, set: readonly number[]): OpenChain | null {
  const inSet = [...new Set(set)].filter((f) => cage.faces[f] !== undefined)
  const count = new Map<string, number>()
  for (const f of inSet) { const l = cage.faces[f]; for (let i = 0; i < l.length; i++) { const k = edgeKey(l[i], l[(i + 1) % l.length]); count.set(k, (count.get(k) ?? 0) + 1) } }
  const next = new Map<number, number>()
  for (const f of inSet) {
    const l = cage.faces[f]
    for (let i = 0; i < l.length; i++) {
      const u = l[i], v = l[(i + 1) % l.length]
      if (count.get(edgeKey(u, v)) !== 1) continue
      if (next.has(u)) return null
      next.set(u, v)
    }
  }
  if (next.size < 3) return null
  const start = Math.min(...next.keys())
  const points = [start]
  let cur = next.get(start)!
  while (cur !== start) { if (points.includes(cur) || !next.has(cur)) return null; points.push(cur); cur = next.get(cur)! }
  return points.length === next.size ? { points, closed: true } : null
}

/**
 * Bridge two face sets: both are removed and a band takes their place along
 * each set's outline - on a closed form a handle or a hole through, on an open
 * one (a set with edges on the open border, or two separate pieces) a tube.
 * Points only the removed faces used go. Null when either outline is not one
 * closed loop, or the two share a point.
 */
export function bridgeFaceSets(cage: Cage, setA: readonly number[], setB: readonly number[], segments = 1, twist = 0): { cage: Cage; faces: number[] } | null {
  const la = setOutline(cage, setA), lb = setOutline(cage, setB)
  if (la === null || lb === null) return null
  const drop = new Set([...setA, ...setB])
  const opened: Cage = { ...cage, faces: cage.faces.filter((_, f) => !drop.has(f)) }
  const r = bridgeOpenings(opened, la, lb, segments, twist)
  if (r === null) return null
  const { cage: out } = compactWithMap(r.cage)
  const n = out.faces.length, added = r.faces.length
  return { cage: out, faces: Array.from({ length: added }, (_, i) => n - added + i) }
}

/** The edge keys of an open chain (closing edge included when closed). */
export function chainEdges(c: OpenChain): string[] {
  const n = c.points.length
  return Array.from({ length: c.closed ? n : n - 1 }, (_, i) => edgeKey(c.points[i], c.points[(i + 1) % n]))
}

