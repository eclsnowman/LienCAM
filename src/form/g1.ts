// Form - G1 (tangent-plane continuity) where the exact solid's faces meet at
// an extraordinary point.
//
// exactStep writes one C1 bicubic B-spline face per first-level quad. Every
// extraordinary point (valence other than 4) sits at a corner of those faces,
// and each edge leaving it is a face boundary. Loop & Schaefer's patches meet
// with one tangent plane AT the point, but along the first span of each
// boundary leaving it the two faces' cross-boundary derivatives do not lie in
// one plane: a kink of up to a few degrees (2.4 at a valence-8 point), which
// the zebra display shows as a star.
//
// This moves the poles one row in from those boundaries, over the first spans
// round each extraordinary point, so that both faces' cross-boundary
// derivatives lie in the plane of the shared tangent: at samples along each
// boundary, N . D_A = N . D_B = 0 with N the mean of the two normals. It is a
// least-squares problem, linear once N is frozen, re-solved a few times as N
// settles, with a small pull toward the original poles so the shape stays put.
// The boundary curves themselves (shared by both faces) are not touched, so
// the solid stays watertight; nothing away from extraordinary points moves.
// Creases come from the cage's flags: a creased boundary is no constraint. A
// guard keeps every point honest: if the pass would change a crease's angle
// there or leave a smooth boundary worse, that point's poles go back (at the
// points on a crease measured so far, it always would: they keep Loop and
// Schaefer's surface).

import type { Vec3 } from './cage'
import { edgeKey } from './cage'

/** A face's Bezier pole grid: poles[gu * n + gv], n = 3 m + 1 poles along each side (m spans). */
export interface PoleGrid {
  poles: Vec3[]
  /** first-level corner points, corner k at grid corner (0,0), (n-1,0), (n-1,n-1), (0,n-1) */
  corners: number[]
}

/** Spans next to each extraordinary point whose inner poles may move. */
const SPANS = 2
/** Samples per span along each boundary. */
const SAMPLES = 10
const ITERATIONS = 10
/** Pull toward the original poles, relative to the typical cross derivative squared. */
const PULL = 1e-6

/** Replace every span-join pole by the midpoint the C1 representation implies (the surface actually written). */
export function impliedGrid(grid: readonly Vec3[], n: number): Vec3[] {
  const P = grid.map((p) => [p[0], p[1], p[2]] as Vec3)
  const mid = (a: Vec3, b: Vec3): Vec3 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2, (a[2] + b[2]) / 2]
  const join = (i: number) => i > 0 && i < n - 1 && i % 3 === 0
  for (let u = 0; u < n; u++) if (!join(u)) for (let v = 0; v < n; v++) if (join(v)) P[u * n + v] = mid(P[u * n + v - 1], P[u * n + v + 1])
  for (let u = 0; u < n; u++) if (join(u)) for (let v = 0; v < n; v++) P[u * n + v] = mid(P[(u - 1) * n + v], P[(u + 1) * n + v])
  return P
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]); return l > 0 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0] }
const bern3 = (t: number) => { const s = 1 - t; return [s * s * s, 3 * s * s * t, 3 * s * t * t, t * t * t] }
const bern2 = (t: number) => { const s = 1 - t; return [s * s, 2 * s * t, t * t] }

/** One face's view of a boundary leaving an extraordinary corner: pole index (along, depth) -> grid index. */
interface SideView {
  root: number
  at: (along: number, depth: number) => number
}

/** A boundary leaving an extraordinary point, as seen from the two faces on it; `key` is edgeKey of its two corners. */
interface EvSide { a: SideView; b: SideView; key: string }

function sideViews(grids: readonly PoleGrid[], n: number): Map<number, EvSide[]> {
  // corner k's grid position and its two directions (along the side to corner k+1, and to corner k-1)
  const C = [[0, 0], [n - 1, 0], [n - 1, n - 1], [0, n - 1]]
  const step = (from: number, to: number): [number, number] => {
    const du = Math.sign(C[to][0] - C[from][0]), dv = Math.sign(C[to][1] - C[from][1])
    return [du, dv]
  }
  const view = (root: number, k: number, toward: number): SideView => {
    const [cu, cv] = C[k]
    const [au, av] = step(k, toward)
    const other = toward === (k + 1) % 4 ? (k + 3) % 4 : (k + 1) % 4
    const [du, dv] = step(k, other)
    return { root, at: (along, depth) => (cu + au * along + du * depth) * n + (cv + av * along + dv * depth) }
  }
  const bySide = new Map<string, Array<{ root: number; k: number; toward: number }>>()
  const around = new Map<number, number>()
  grids.forEach((g, r) => {
    for (let k = 0; k < 4; k++) {
      around.set(g.corners[k], (around.get(g.corners[k]) ?? 0) + 1)
      for (const toward of [(k + 1) % 4, (k + 3) % 4]) {
        const key = `${g.corners[k]}>${g.corners[toward]}`
        bySide.set(key, [...(bySide.get(key) ?? []), { root: r, k, toward }])
      }
    }
  })
  const out = new Map<number, EvSide[]>()
  for (const [key, list] of bySide) {
    const ev = Number(key.split('>')[0])
    if (around.get(ev) === 4 || list.length !== 2) continue
    const [A, B] = list
    out.set(ev, [...(out.get(ev) ?? []), { a: view(A.root, A.k, A.toward), b: view(B.root, B.k, B.toward), key: edgeKey(ev, grids[A.root].corners[A.toward]) }])
  }
  return out
}

/** Boundary tangent, cross derivative and normal of one face at `s` spans along a side (s in [0, spans]). */
function frame(P: readonly Vec3[], v: SideView, s: number): { T: Vec3; D: Vec3 } {
  const q = Math.min(Math.floor(s), Math.max(0, Math.ceil(s) - 1))
  const u = s - q
  const b3 = bern3(u), b2 = bern2(u)
  const T: Vec3 = [0, 0, 0], D: Vec3 = [0, 0, 0]
  for (let i = 0; i < 3; i++) {
    const d = sub(P[v.at(3 * q + i + 1, 0)], P[v.at(3 * q + i, 0)])
    for (let c = 0; c < 3; c++) T[c] += 3 * b2[i] * d[c]
  }
  for (let i = 0; i < 4; i++) {
    const d = sub(P[v.at(3 * q + i, 1)], P[v.at(3 * q + i, 0)])
    for (let c = 0; c < 3; c++) D[c] += 3 * b3[i] * d[c]
  }
  return { T, D }
}

const angleDeg = (a: Vec3, b: Vec3) => Math.acos(Math.max(-1, Math.min(1, dot(unit(a), unit(b))))) * 180 / Math.PI

/** Normals of the two faces on an extraordinary side at `s`: A's is T x D_A; B's (D_B points the other way) D_B x T. */
function normals(implied: readonly Vec3[][], side: EvSide, s: number): { nA: Vec3; nB: Vec3 } {
  const fa = frame(implied[side.a.root], side.a, s), fb = frame(implied[side.b.root], side.b, s)
  return { nA: unit(cross(fa.T, fa.D)), nB: unit(cross(fb.D, fa.T)) }
}

/**
 * The largest angle between the two faces' normals along every smooth
 * boundary leaving an extraordinary point (its first `spans` spans; the whole
 * boundary by default), in degrees, on the implied grids - the surface as
 * written. Creases are the cage's (`creaseSides`, edgeKey of a boundary's two
 * corners), never guessed from the angle: a boundary the G1 pass broke still
 * counts.
 */
export function extraordinarySeamDeg(grids: readonly PoleGrid[], n: number, creaseSides: ReadonlySet<string> = new Set(), spans = (n - 1) / 3, skip: ReadonlySet<number> = new Set()): number {
  const views = sideViews(grids, n)
  for (const ev of skip) views.delete(ev)
  const implied = impliedFor(grids, n, rootsOf(views.values()))
  const m = (n - 1) / 3
  let worst = 0
  for (const sides of views.values()) {
    for (const side of sides) {
      if (creaseSides.has(side.key)) continue
      for (let q = 0; q <= Math.min(spans, m) * SAMPLES; q++) {
        const { nA, nB } = normals(implied, side, q / SAMPLES)
        worst = Math.max(worst, angleDeg(nA, nB))
      }
    }
  }
  return worst
}

/** The angle across every crease boundary leaving an extraordinary point, at each sample (to show a crease kept its angle). */
function creaseAngles(grids: readonly PoleGrid[], n: number, creaseSides: ReadonlySet<string>): number[] {
  const views = sideViews(grids, n)
  const implied = impliedFor(grids, n, rootsOf(views.values()))
  const m = (n - 1) / 3
  const out: number[] = []
  for (const sides of views.values()) {
    for (const side of sides) {
      if (!creaseSides.has(side.key)) continue
      for (let q = 0; q <= m * SAMPLES; q++) { const { nA, nB } = normals(implied, side, q / SAMPLES); out.push(angleDeg(nA, nB)) }
    }
  }
  return out
}

/** The faces the boundaries leaving extraordinary points run between. */
function rootsOf(views: Iterable<EvSide[]>): Set<number> {
  const out = new Set<number>()
  for (const sides of views) for (const side of sides) { out.add(side.a.root); out.add(side.b.root) }
  return out
}

/**
 * The implied grids of just the given faces (a sparse array, indexed by face):
 * the pass reads only the faces round one extraordinary point at a time, and
 * building every face's grid for each of them was most of a large form's
 * Finish (Form stage 25).
 */
function impliedFor(grids: readonly PoleGrid[], n: number, roots: Iterable<number>): Vec3[][] {
  const out: Vec3[][] = []
  for (const r of roots) out[r] = impliedGrid(grids[r].poles, n)
  return out
}

/** Solve A x = b (dense, symmetric positive definite) by Gaussian elimination with partial pivoting. */
function solve(A: Float64Array, b: Float64Array, N: number): Float64Array {
  const M = A.slice(), x = b.slice()
  for (let c = 0; c < N; c++) {
    let p = c
    for (let r = c + 1; r < N; r++) if (Math.abs(M[r * N + c]) > Math.abs(M[p * N + c])) p = r
    if (p !== c) { for (let k = 0; k < N; k++) { const t = M[c * N + k]; M[c * N + k] = M[p * N + k]; M[p * N + k] = t } const t = x[c]; x[c] = x[p]; x[p] = t }
    const d = M[c * N + c] || 1e-300
    for (let r = c + 1; r < N; r++) {
      const f = M[r * N + c] / d
      if (f === 0) continue
      for (let k = c; k < N; k++) M[r * N + k] -= f * M[c * N + k]
      x[r] -= f * x[c]
    }
  }
  for (let c = N - 1; c >= 0; c--) {
    let s = x[c]
    for (let k = c + 1; k < N; k++) s -= M[c * N + k] * x[k]
    x[c] = s / (M[c * N + c] || 1e-300)
  }
  return x
}

/**
 * Make the faces round every extraordinary point meet with one tangent plane
 * along the first spans of the boundaries leaving it (see the file header).
 * Returns new grids (the input is not changed) and the seam angle before and
 * after, in degrees. Points in `skip` are left alone (g1Exact.ts solves them)
 * and not measured after.
 */
export function g1AtExtraordinary(grids: readonly PoleGrid[], n: number, creaseSides: ReadonlySet<string> = new Set(), skip: ReadonlySet<number> = new Set()): { grids: PoleGrid[]; beforeDeg: number; afterDeg: number; maxMoveMm: number; surfaceMoveMm: number; creaseChangeDeg: number } {
  const m = (n - 1) / 3
  const spans = Math.min(SPANS, m)
  // poles are replaced, never changed in place: a shallow copy of each grid is enough
  const out: PoleGrid[] = grids.map((g) => ({ poles: g.poles.slice(), corners: g.corners.slice() }))
  const beforeDeg = extraordinarySeamDeg(grids, n, creaseSides)
  const isJoin = (i: number) => i > 0 && i < n - 1 && i % 3 === 0
  for (const [ev, sides0] of sideViews(out, n)) {
    if (skip.has(ev)) continue
    const local = rootsOf([sides0])
    // a crease (the cage's flag) is a corner on purpose: no constraint (the guard below keeps its angle);
    // a boundary already G1 (a flat region; a cylinder side's rim point, 1e-6 deg off by rounding) needs
    // nothing. Below 1e-4 deg the solve improves nothing (its own floor) and only moves poles by ~1e-7 mm,
    // which breaks the exact C1 joins face packing needs: a one-ring cylinder side packed into 10 faces, not 2
    const implied0 = impliedFor(out, n, local)
    const sides = sides0.filter((side) => {
      if (creaseSides.has(side.key)) return false
      let local = 0
      for (let q = 1; q <= spans * SAMPLES; q++) { const { nA, nB } = normals(implied0, side, q / SAMPLES); local = Math.max(local, angleDeg(nA, nB)) }
      return local > 1e-4
    })
    if (sides.length === 0) continue
    // variables: depth-1 poles (not span joins) over the first spans, on both faces of every side
    const varIndex = new Map<string, number>()
    const vars: Array<{ root: number; g: number }> = []
    const addVar = (v: SideView, along: number) => {
      const g = v.at(along, 1)
      const key = `${v.root}:${g}`
      if (!varIndex.has(key)) { varIndex.set(key, vars.length); vars.push({ root: v.root, g }) }
    }
    for (const side of sides) for (const v of [side.a, side.b]) for (let a = 1; a < 3 * spans; a++) if (!isJoin(a)) addVar(v, a)
    if (vars.length === 0) continue
    const N = vars.length * 3
    const original = vars.map(({ root, g }) => out[root].poles[g].slice() as Vec3)
    let scale = 0
    for (let it = 0; it < ITERATIONS; it++) {
      const implied = impliedFor(out, n, local)
      const AtA = new Float64Array(N * N), Atb = new Float64Array(N)
      // D(s) = sum_i 3 B_i(u) (P(3q+i, 1) - P(3q+i, 0)); a join pole at depth 1 is the midpoint of its neighbours
      const addRows = (v: SideView, s: number, Nrm: Vec3, weight: number) => {
        const q = Math.min(Math.floor(s), Math.max(0, Math.ceil(s) - 1))
        const b3 = bern3(s - q)
        const coef = new Map<number, number>()
        let rhs = 0
        const P = implied[v.root]
        const addPole = (along: number, w: number) => {
          const key = `${v.root}:${v.at(along, 1)}`
          const vi = varIndex.get(key)
          if (vi !== undefined) coef.set(vi, (coef.get(vi) ?? 0) + w)
          else rhs -= w * dot(Nrm, P[v.at(along, 1)])
        }
        for (let i = 0; i < 4; i++) {
          const a = 3 * q + i
          const w = 3 * b3[i]
          rhs += w * dot(Nrm, P[v.at(a, 0)])
          if (isJoin(a)) { addPole(a - 1, w / 2); addPole(a + 1, w / 2) } else addPole(a, w)
        }
        // residual N . D = sum coef_v (N . x_v) - rhs  -> row over 3 coords per variable
        const idx: number[] = [], val: number[] = []
        rhs *= weight
        for (const [vi, w] of coef) for (let c = 0; c < 3; c++) { idx.push(vi * 3 + c); val.push(weight * w * Nrm[c]) }
        for (let x = 0; x < idx.length; x++) {
          Atb[idx[x]] += val[x] * rhs
          for (let y = 0; y < idx.length; y++) AtA[idx[x] * N + idx[y]] += val[x] * val[y]
        }
      }
      for (const side of sides) {
        for (let k = 1; k <= spans * SAMPLES; k++) {
          const s = k / SAMPLES
          const fa = frame(implied[side.a.root], side.a, s), fb = frame(implied[side.b.root], side.b, s)
          if (it === 0) scale = Math.max(scale, dot(fa.D, fa.D), dot(fb.D, fb.D))
          const Nrm = unit([...unit(cross(fa.T, fa.D))].map((x, c) => x + unit(cross(fb.D, fa.T))[c]) as Vec3)
          // weighted by the cross derivatives' lengths, so the residual is an angle: near the corner, where
          // they are short, a large angle must cost as much as anywhere else
          const ref = Math.sqrt(Math.max(scale, 1e-12))
          addRows(side.a, s, Nrm, ref / Math.max(Math.hypot(...fa.D), 1e-9 * ref))
          addRows(side.b, s, Nrm, ref / Math.max(Math.hypot(...fb.D), 1e-9 * ref))
        }
      }
      const pull = PULL * Math.max(scale, 1e-12)
      for (let vi = 0; vi < vars.length; vi++) for (let c = 0; c < 3; c++) { AtA[(vi * 3 + c) * N + vi * 3 + c] += pull; Atb[vi * 3 + c] += pull * original[vi][c] }
      const x = solve(AtA, Atb, N)
      vars.forEach(({ root, g }, vi) => { out[root].poles[g] = [x[vi * 3], x[vi * 3 + 1], x[vi * 3 + 2]] })
    }
    // the guard: this point's smooth boundaries must end up no worse, and its creases keep their angle;
    // otherwise its poles go back
    const localWorst = (grid: readonly PoleGrid[]) => {
      const implied = impliedFor(grid, n, local)
      let worst = 0
      for (const side of sides) for (let q = 0; q <= m * SAMPLES; q++) { const { nA, nB } = normals(implied, side, q / SAMPLES); worst = Math.max(worst, angleDeg(nA, nB)) }
      return worst
    }
    const localCrease = (grid: readonly PoleGrid[]) => {
      const implied = impliedFor(grid, n, local)
      const angles: number[] = []
      for (const side of sides0) if (creaseSides.has(side.key)) for (let q = 0; q <= m * SAMPLES; q++) { const { nA, nB } = normals(implied, side, q / SAMPLES); angles.push(angleDeg(nA, nB)) }
      return angles
    }
    const before: PoleGrid[] = []
    for (const r of local) before[r] = { poles: out[r].poles.slice(), corners: out[r].corners }
    vars.forEach(({ root, g }, vi) => { before[root].poles[g] = original[vi] })
    const creaseBefore = localCrease(before), creaseAfter = localCrease(out)
    const creaseMoved = creaseBefore.some((a, i) => Math.abs(a - creaseAfter[i]) > 0.01)
    if (creaseMoved || localWorst(out) > localWorst(before) + 1e-9) vars.forEach(({ root, g }, vi) => { out[root].poles[g] = original[vi] })
  }
  let maxMoveMm = 0
  out.forEach((g, r) => g.poles.forEach((p, i) => { const o = grids[r].poles[i]; maxMoveMm = Math.max(maxMoveMm, Math.hypot(p[0] - o[0], p[1] - o[1], p[2] - o[2])) }))
  // how far the written surface itself moved (the implied grids, sampled over each changed face)
  let surfaceMoveMm = 0
  const m2 = (n - 1) / 3
  out.forEach((g, r) => {
    if (g.poles.every((p, i) => p === grids[r].poles[i] || (p[0] === grids[r].poles[i][0] && p[1] === grids[r].poles[i][1] && p[2] === grids[r].poles[i][2]))) return
    const A = impliedGrid(grids[r].poles, n), B = impliedGrid(g.poles, n)
    for (let su = 0; su <= 24; su++) for (let sv = 0; sv <= 24; sv++) {
      const pa = evalGrid(A, n, m2, su / 24, sv / 24), pb = evalGrid(B, n, m2, su / 24, sv / 24)
      surfaceMoveMm = Math.max(surfaceMoveMm, Math.hypot(pa[0] - pb[0], pa[1] - pb[1], pa[2] - pb[2]))
    }
  })
  const creaseBefore = creaseAngles(grids, n, creaseSides), creaseAfter = creaseAngles(out, n, creaseSides)
  const creaseChangeDeg = creaseBefore.reduce((w, a, i) => Math.max(w, Math.abs(a - creaseAfter[i])), 0)
  return { grids: out, beforeDeg, afterDeg: extraordinarySeamDeg(out, n, creaseSides, undefined, skip), maxMoveMm, surfaceMoveMm, creaseChangeDeg }
}

/** A point of a face's implied Bezier grid at (u, v) in [0, 1]^2. */
export function evalGrid(P: readonly Vec3[], n: number, m: number, u: number, v: number): Vec3 {
  const qu = Math.min(m - 1, Math.floor(u * m)), qv = Math.min(m - 1, Math.floor(v * m))
  const bu = bern3(u * m - qu), bv = bern3(v * m - qv)
  const out: Vec3 = [0, 0, 0]
  for (let i = 0; i < 4; i++) for (let j = 0; j < 4; j++) {
    const p = P[(3 * qu + i) * n + 3 * qv + j], w = bu[i] * bv[j]
    out[0] += w * p[0]; out[1] += w * p[1]; out[2] += w * p[2]
  }
  return out
}
