// Form - exact G1 where the exact solid's faces meet at an extraordinary point.
//
// g1.ts nudges bicubic poles until the faces round an extraordinary point meet
// within about 0.02 deg; bicubic patches cannot do better, because the G1
// conditions round the point over-determine them. Here the corner patch of
// every first-level quad at such a point is raised to degree 5 and its inner
// poles solved so that, along every boundary leaving the point,
//
//   D_A(t) + D_B(t) = g0 (1 - t)^2 c'(t),    g0 = 2 cos(2 pi / valence)
//
// holds as a polynomial identity: D_A, D_B the two faces' cross-boundary
// derivatives, c the shared boundary curve (kept of degree 4, so both sides
// are of degree 5). That is G1 exactly, not to a tolerance: the normals agree
// to rounding. The (1 - t)^2 lets the patch meet its ordinary neighbours with
// their C1 unchanged (its last two rows of poles on the far sides stay those of
// the bicubic patch raised to degree 5). A blend linear in t, or degree 4,
// meets the vertex-enclosure obstruction: round a point of even valence the
// twist conditions need an alternating sum of fixed poles to vanish, and in
// general it does not.
//
// The constraints are linear in the poles and the same for x, y and z; the
// poles are moved as little as possible (least squares) to satisfy them.

import type { Vec3 } from './cage'
import { edgeKey } from './cage'
import type { PoleGrid } from './g1'

const D = 5 // degree of the corner patches
const FREE = 4 // local rows 0..3 move; rows 4, 5 keep the neighbours' C1

/** A degree-5 corner patch: poles[i * 6 + j], i along the root side from corner k toward k+1, j toward k-1. */
export interface CornerPatch {
  root: number
  corner: number
  poles: Vec3[]
}

export interface ExactG1Result {
  patches: CornerPatch[]
  /** extraordinary points solved, and those left alone (a crease through them, or not closed round) */
  solved: number
  skipped: number
  /** the largest angle between the two faces' normals along the boundaries leaving solved points, degrees */
  seamDeg: number
  /** the same on the bicubic patches, before */
  beforeDeg: number
  /** the farthest a constraint the solve could not meet was from being met, mm (0: every one met) */
  inconsistencyMm: number
  /** how far the corner patches' surfaces moved from the bicubic ones, mm (sampled) */
  surfaceMoveMm: number
  /** the largest mismatch of a corner patch's cross derivative with its ordinary neighbour's, on the far sides */
  c1MismatchMm: number
}

const binom = (a: number, b: number) => { let r = 1; for (let i = 1; i <= b; i++) r = r * (a - b + i) / i; return r }
const bern = (d: number, t: number) => Array.from({ length: d + 1 }, (_, i) => binom(d, i) * t ** i * (1 - t) ** (d - i))

/** Raise a bicubic Bezier patch (4 x 4, [i * 4 + j]) to degree 5 each way (6 x 6). */
export function elevate3to5(P: readonly Vec3[]): Vec3[] {
  const w = (i: number, j: number) => (j < 0 || j > 3 || i - j < 0 || i - j > 2 ? 0 : binom(3, j) * binom(2, i - j) / binom(5, i))
  const out: Vec3[] = []
  for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) {
    const q: Vec3 = [0, 0, 0]
    for (let a = 0; a < 4; a++) for (let b = 0; b < 4; b++) {
      const c = w(i, a) * w(j, b)
      if (c === 0) continue
      const p = P[a * 4 + b]
      q[0] += c * p[0]; q[1] += c * p[1]; q[2] += c * p[2]
    }
    out.push(q)
  }
  return out
}

/** A point of a degree-d Bezier patch ((d+1)^2 poles, [i * (d+1) + j]) and its two partial derivatives. */
export function patchFrame(P: readonly Vec3[], d: number, u: number, v: number): { p: Vec3; du: Vec3; dv: Vec3 } {
  const bu = bern(d, u), bv = bern(d, v), du1 = bern(d - 1, u), dv1 = bern(d - 1, v)
  const p: Vec3 = [0, 0, 0], du: Vec3 = [0, 0, 0], dv: Vec3 = [0, 0, 0]
  const at = (i: number, j: number) => P[i * (d + 1) + j]
  for (let i = 0; i <= d; i++) for (let j = 0; j <= d; j++) {
    const q = at(i, j), w = bu[i] * bv[j]
    for (let c = 0; c < 3; c++) p[c] += w * q[c]
  }
  for (let i = 0; i < d; i++) for (let j = 0; j <= d; j++) {
    const a = at(i + 1, j), b = at(i, j), w = d * du1[i] * bv[j]
    for (let c = 0; c < 3; c++) du[c] += w * (a[c] - b[c])
  }
  for (let i = 0; i <= d; i++) for (let j = 0; j < d; j++) {
    const a = at(i, j + 1), b = at(i, j), w = d * bu[i] * dv1[j]
    for (let c = 0; c < 3; c++) dv[c] += w * (a[c] - b[c])
  }
  return { p, du, dv }
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0] }
const angleDeg = (a: Vec3, b: Vec3) => {
  // atan2 of |a x b| and a . b: accurate for tiny angles, where acos is not
  const ua = unit(a), ub = unit(b)
  return Math.atan2(Math.hypot(...cross(ua, ub)), dot(ua, ub)) * 180 / Math.PI
}

/** Grid index of local pole (i, j) of root corner k: i along the side toward k+1, j toward k-1. */
function localIndex(n: number, k: number): (i: number, j: number) => number {
  const C = [[0, 0], [n - 1, 0], [n - 1, n - 1], [0, n - 1]]
  const dir = (to: number) => [Math.sign(C[to][0] - C[k][0]), Math.sign(C[to][1] - C[k][1])]
  const [au, av] = dir((k + 1) % 4), [bu, bv] = dir((k + 3) % 4)
  const [cu, cv] = C[k]
  return (i, j) => (cu + au * i + bu * j) * n + (cv + av * i + bv * j)
}

/** A corner patch's view of one boundary leaving the point: local (along, depth) -> (i, j). */
type Orient = (along: number, depth: number) => [number, number]
const ALONG_I: Orient = (a, d) => [a, d]
const ALONG_J: Orient = (a, d) => [d, a]

/**
 * The extraordinary points the exact solve takes: every boundary leaving the
 * point is smooth (no crease) and shared by two faces, and no face there is
 * flat (`flat[root]`: a flat root is written as a plane, bounded by the
 * bicubic curves, and g1.ts leaves a flat point as it is anyway).
 */
export function exactG1Points(grids: readonly PoleGrid[], creaseSides: ReadonlySet<string>, flat: readonly boolean[]): Set<number> {
  const valence = new Map<number, number>()
  for (const g of grids) for (const c of g.corners) valence.set(c, (valence.get(c) ?? 0) + 1)
  const bad = new Set<number>()
  const sideCount = new Map<string, number>()
  grids.forEach((g, r) => g.corners.forEach((c, k) => {
    if (valence.get(c) === 4) return
    if (flat[r]) bad.add(c)
    for (const o of [g.corners[(k + 1) % 4], g.corners[(k + 3) % 4]]) {
      const key = edgeKey(c, o)
      if (creaseSides.has(key)) bad.add(c)
      sideCount.set(`${c}>${key}`, (sideCount.get(`${c}>${key}`) ?? 0) + 1)
    }
  }))
  for (const [k, count] of sideCount) if (count !== 2) bad.add(Number(k.split('>')[0]))
  const out = new Set<number>()
  for (const [c, v] of valence) if (v !== 4 && v >= 3 && !bad.has(c)) out.add(c)
  return out
}

/**
 * Degree-5 corner patches, G1 exactly round every smooth extraordinary point
 * of a closed form (see the file header). `grids` are the bicubic root grids
 * (exactStep.rootGrids), unchanged.
 */
export function exactG1Corners(grids: readonly PoleGrid[], n: number, creaseSides: ReadonlySet<string> = new Set(), only?: ReadonlySet<number>): ExactG1Result {
  // corner patches round each extraordinary point
  const valence = new Map<number, number>()
  for (const g of grids) for (const c of g.corners) valence.set(c, (valence.get(c) ?? 0) + 1)
  const around = new Map<number, Array<{ root: number; k: number }>>()
  grids.forEach((g, root) => g.corners.forEach((c, k) => { if (valence.get(c) !== 4) around.set(c, [...(around.get(c) ?? []), { root, k }]) }))

  const patches: CornerPatch[] = []
  let solved = 0, skipped = 0, seamDeg = 0, beforeDeg = 0, inconsistencyMm = 0, surfaceMoveMm = 0, c1MismatchMm = 0
  for (const [ev, list] of around) {
    if (only !== undefined && !only.has(ev)) continue
    const N = list.length
    // the boundaries leaving the point: each must be shared by exactly two of its corner patches, and smooth
    const bySide = new Map<string, Array<{ p: number; o: Orient }>>()
    list.forEach(({ root, k }, p) => {
      const g = grids[root]
      bySide.set(edgeKey(ev, g.corners[(k + 1) % 4]), [...(bySide.get(edgeKey(ev, g.corners[(k + 1) % 4])) ?? []), { p, o: ALONG_I }])
      bySide.set(edgeKey(ev, g.corners[(k + 3) % 4]), [...(bySide.get(edgeKey(ev, g.corners[(k + 3) % 4])) ?? []), { p, o: ALONG_J }])
    })
    const sides = [...bySide.entries()]
    if (N < 3 || sides.length !== N || sides.some(([key, s]) => s.length !== 2 || creaseSides.has(key))) { skipped++; continue }

    // the bicubic corner patches raised to degree 5: their far rows are fixed, rows 0..3 move
    const raised = list.map(({ root, k }) => {
      const at = localIndex(n, k)
      const P: Vec3[] = []
      for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) P.push(grids[root].poles[at(i, j)])
      return { bicubic: P, poles: elevate3to5(P) }
    })
    const U = N * FREE * FREE
    const varOf = (p: number, i: number, j: number) => (i < FREE && j < FREE ? p * FREE * FREE + i * FREE + j : -1)
    const pole = (p: number, i: number, j: number) => raised[p].poles[i * 6 + j]

    // rows: coefficients over the unknowns and a right-hand side per coordinate
    const rows: Array<{ a: Float64Array; b: Vec3 }> = []
    const row = () => ({ a: new Float64Array(U), b: [0, 0, 0] as Vec3 })
    const put = (r: { a: Float64Array; b: Vec3 }, p: number, i: number, j: number, w: number) => {
      const v = varOf(p, i, j)
      if (v >= 0) r.a[v] += w
      else { const q = pole(p, i, j); r.b[0] -= w * q[0]; r.b[1] -= w * q[1]; r.b[2] -= w * q[2] }
    }
    const g0 = 2 * Math.cos(2 * Math.PI / N)
    for (const [, [A, B]] of sides) {
      const a = (along: number, depth: number): [number, number, number] => [A.p, ...A.o(along, depth)]
      const b = (along: number, depth: number): [number, number, number] => [B.p, ...B.o(along, depth)]
      // one boundary curve: B's poles on it are A's
      for (let i = 0; i < FREE; i++) { const r = row(); put(r, ...a(i, 0), 1); put(r, ...b(i, 0), -1); rows.push(r) }
      // the curve is of degree 4: its fifth difference vanishes
      { const r = row(); for (let i = 0; i <= D; i++) put(r, ...a(i, 0), (-1) ** i * binom(D, i)); rows.push(r) }
      // D_A + D_B - g0 (1-t)^2 c' = 0 at D + 1 values of t: a degree-5 polynomial, so everywhere
      for (let s = 0; s <= D; s++) {
        const t = s / D, r = row()
        const b5 = bern(D, t), b4 = bern(D - 1, t), gam = g0 * (1 - t) ** 2
        for (let i = 0; i <= D; i++) {
          put(r, ...a(i, 1), D * b5[i]); put(r, ...a(i, 0), -D * b5[i])
          put(r, ...b(i, 1), D * b5[i]); put(r, ...b(i, 0), -D * b5[i])
        }
        for (let i = 0; i < D; i++) { put(r, ...a(i + 1, 0), -gam * D * b4[i]); put(r, ...a(i, 0), gam * D * b4[i]) }
        rows.push(r)
      }
    }

    // least change: x = x0 + Q^T (d - Q x0), Q the rows orthonormalized (modified Gram-Schmidt, twice)
    const x: Vec3[] = []
    for (let p = 0; p < N; p++) for (let i = 0; i < FREE; i++) for (let j = 0; j < FREE; j++) x.push([...pole(p, i, j)] as Vec3)
    const Q: Array<{ a: Float64Array; b: Vec3 }> = []
    const scale = Math.max(1, ...x.map((q) => Math.hypot(...q)))
    for (const r0 of rows) {
      const r = { a: r0.a.slice(), b: [...r0.b] as Vec3 }
      const norm0 = Math.hypot(...r.a)
      for (let pass = 0; pass < 2; pass++) {
        for (const q of Q) {
          let f = 0
          for (let v = 0; v < U; v++) f += q.a[v] * r.a[v]
          if (f === 0) continue
          for (let v = 0; v < U; v++) r.a[v] -= f * q.a[v]
          for (let c = 0; c < 3; c++) r.b[c] -= f * q.b[c]
        }
      }
      const norm = Math.hypot(...r.a)
      // dependent on the rows before it (or on no moving pole at all): it must already be met, checked below
      if (norm <= 1e-9 * Math.max(norm0, 1e-300)) continue
      for (let v = 0; v < U; v++) r.a[v] /= norm
      for (let c = 0; c < 3; c++) r.b[c] /= norm
      Q.push(r)
    }
    for (const q of Q) {
      const f: Vec3 = [...q.b] as Vec3
      for (let v = 0; v < U; v++) { if (q.a[v] === 0) continue; for (let c = 0; c < 3; c++) f[c] -= q.a[v] * x[v][c] }
      for (let v = 0; v < U; v++) { if (q.a[v] === 0) continue; for (let c = 0; c < 3; c++) x[v][c] += q.a[v] * f[c] }
    }
    // every row met? (a dependent row the solve could not use shows here), in mm of the row's unit weight
    for (const r of rows) {
      const f: Vec3 = [-r.b[0], -r.b[1], -r.b[2]]
      let w = 1
      for (let v = 0; v < U; v++) { if (r.a[v] === 0) continue; w = Math.max(w, Math.abs(r.a[v])); for (let c = 0; c < 3; c++) f[c] += r.a[v] * x[v][c] }
      inconsistencyMm = Math.max(inconsistencyMm, Math.hypot(...f) / w / scale)
    }

    // write the solved poles back; a shared pole is the mean of its copies (equal to rounding)
    const out = raised.map((r) => r.poles.map((q) => [...q] as Vec3))
    for (let p = 0; p < N; p++) for (let i = 0; i < FREE; i++) for (let j = 0; j < FREE; j++) out[p][i * 6 + j] = x[varOf(p, i, j)]
    list.forEach(({ root, k }, p) => patches.push({ root, corner: k, poles: out[p] }))
    solved++

    // measure: the seam along every boundary, the C1 with the ordinary neighbours, the move
    const frameOf = (p: number, o: Orient, t: number, P = out[p], d = D) => {
      const [u, v] = o(t, 0)
      const f = patchFrame(P, d, u, v)
      // along the boundary and into the face, in this patch's (along, depth) terms
      return o === ALONG_I ? { T: f.du, Dp: f.dv } : { T: f.dv, Dp: f.du }
    }
    for (const [, [A, B]] of sides) {
      for (let s = 0; s <= 64; s++) {
        const t = s / 64
        const fa = frameOf(A.p, A.o, t), fb = frameOf(B.p, B.o, t)
        if (Math.hypot(...fa.T) < 1e-12) continue
        seamDeg = Math.max(seamDeg, angleDeg(cross(fa.T, fa.Dp), cross(fb.Dp, fa.T)))
        const ga = frameOf(A.p, A.o, t, raised[A.p].bicubic, 3), gb = frameOf(B.p, B.o, t, raised[B.p].bicubic, 3)
        beforeDeg = Math.max(beforeDeg, angleDeg(cross(ga.T, ga.Dp), cross(gb.Dp, ga.T)))
      }
    }
    list.forEach(({ root, k }, p) => {
      const at = localIndex(n, k)
      const Pn = grids[root].poles
      for (let s = 0; s <= 16; s++) {
        const t = s / 16
        // far side i = 1 of the corner patch against the patch beyond it (local rows 3..6), and j likewise
        const f = patchFrame(out[p], D, 1, t)
        const nb: Vec3[] = []
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) nb.push(Pn[at(3 + i, j)])
        const g = patchFrame(nb, 3, 0, t)
        c1MismatchMm = Math.max(c1MismatchMm, Math.hypot(...sub(f.p, g.p)), Math.hypot(...sub(f.du, g.du)))
        const f2 = patchFrame(out[p], D, t, 1)
        const nb2: Vec3[] = []
        for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) nb2.push(Pn[at(i, 3 + j)])
        const g2 = patchFrame(nb2, 3, t, 0)
        c1MismatchMm = Math.max(c1MismatchMm, Math.hypot(...sub(f2.p, g2.p)), Math.hypot(...sub(f2.dv, g2.dv)))
        for (let s2 = 0; s2 <= 16; s2++) {
          const a = patchFrame(out[p], D, t, s2 / 16).p, b = patchFrame(raised[p].bicubic, 3, t, s2 / 16).p
          surfaceMoveMm = Math.max(surfaceMoveMm, Math.hypot(...sub(a, b)))
        }
      }
    })
  }
  return { patches, solved, skipped, seamDeg, beforeDeg, inconsistencyMm, surfaceMoveMm, c1MismatchMm }
}

/**
 * A root's bicubic C1 Bezier grid (n x n, [u * n + v], its implied form: every span join midway) raised to degree 5
 * span by span ((5m + 1)^2 poles, m = (n - 1) / 3), with its solved corner patches put in. Still C1 at every span
 * join: raising keeps the surface, and a corner patch meets its neighbours C1 (its far rows are theirs).
 */
export function raiseRootGrid(poles: readonly Vec3[], n: number, corners: readonly CornerPatch[]): Vec3[] {
  const m = (n - 1) / 3, n5 = 5 * m + 1
  const out: Vec3[] = new Array(n5 * n5)
  for (let a = 0; a < m; a++) for (let b = 0; b < m; b++) {
    const P: Vec3[] = []
    for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) P.push(poles[(3 * a + i) * n + 3 * b + j])
    const Q = elevate3to5(P)
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) out[(5 * a + i) * n5 + 5 * b + j] = Q[i * 6 + j]
  }
  for (const c of corners) {
    const at = localIndex(n5, c.corner)
    for (let i = 0; i < 6; i++) for (let j = 0; j < 6; j++) out[at(i, j)] = c.poles[i * 6 + j]
  }
  return out
}

/** A C1 Bezier chain of degree 3 (3 s + 1 poles) raised to degree 5 (5 s + 1 poles), span by span. */
export function raiseChain(poles: readonly Vec3[]): Vec3[] {
  const s = (poles.length - 1) / 3
  const out: Vec3[] = [poles[0]]
  for (let q = 0; q < s; q++) {
    const P = [0, 1, 2, 3].map((i) => poles[3 * q + i])
    // degree 3 -> 5: Q_i = sum_j C(3, j) C(2, i - j) / C(5, i) P_j
    for (let i = 1; i <= 5; i++) {
      const v: Vec3 = [0, 0, 0]
      for (let j = Math.max(0, i - 2); j <= Math.min(3, i); j++) {
        const w = binom(3, j) * binom(2, i - j) / binom(5, i)
        v[0] += w * P[j][0]; v[1] += w * P[j][1]; v[2] += w * P[j][2]
      }
      out.push(v)
    }
  }
  return out
}
