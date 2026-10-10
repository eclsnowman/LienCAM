// Form - knot removal: the exact solid's B-splines written with only the knots
// their shape needs.
//
// exactStep.ts builds each face from Bezier patches three refinement levels
// down, so a smooth first-level quad arrives as 4 x 4 spans, and a packed face
// of many quads as hundreds. Wherever the surface is ONE cubic across a span
// join (a join the refinement put inside a regular cage face) that knot is not
// needed at all; wherever it is C2 (a regular cage edge) it needs multiplicity
// 1, not the 2 the C1 form carries. Removing those knots (Tiller, The NURBS
// Book A5.8, one knot at a time, every row of the net at once) gives the same
// surface with a small fraction of the poles - a regular region ends with about
// one pole per cage point. Joins at extraordinary points and creases fail the
// removal test by far more than the tolerance and keep their knots.

import type { Vec3 } from './cage'

/** A B-spline over rows of degree `degree` (3 when absent): every row shares the knot vector `knots` (clamped: degree + 1 equal knots at each end). */
export interface KnotRows {
  knots: number[]
  rows: Vec3[][]
  degree?: number
}

/**
 * Remove every interior knot (or one level of its multiplicity) that each row
 * can lose with its poles moving at most `tol`; returns the reduced rows, how
 * many knot removals were made, and the sum of the worst row's error over
 * those removals (a bound on how far the curves moved).
 */
export function removeKnots(input: KnotRows, tol: number, keep: ReadonlySet<number> = new Set()): KnotRows & { removed: number; moved: number } {
  const P = input.degree ?? 3
  let knots = input.knots.slice()
  let rows = input.rows.map((r) => r.slice())
  let removed = 0, moved = 0
  for (let changed = true; changed;) {
    changed = false
    // distinct interior knot values, each tried until it will not go
    for (let r = P + 1; r < knots.length - P - 1; r++) {
      if (knots[r + 1] === knots[r]) continue // r must be the knot's LAST index
      const u = knots[r]
      let s = 1
      while (r - s >= 0 && knots[r - s] === u) s++
      // a kept knot may drop to multiplicity 1, never go
      if (s === 1 && keep.has(u)) continue
      const tries: Array<{ temp: Vec3[]; err: number }> = []
      let worst = 0
      for (const row of rows) {
        const t = removalCheck(knots, row, r, s, u, P)
        if (!(t.err <= tol)) { worst = Infinity; break }
        worst = Math.max(worst, t.err)
        tries.push(t)
      }
      if (worst > tol) continue
      moved += worst
      rows = rows.map((row, k) => applyRemoval(row, tries[k].temp, r, s, P))
      knots = [...knots.slice(0, r), ...knots.slice(r + 1)]
      removed++
      changed = true
      r-- // the next knot has moved down into r
    }
  }
  return { knots, rows, degree: P, removed, moved }
}

/** The poles one removal of knot u (last index r, multiplicity s) would give one row, and how far its check point misses. */
function removalCheck(U: readonly number[], row: readonly Vec3[], r: number, s: number, u: number, P: number): { temp: Vec3[]; err: number } {
  const ord = P + 1
  const first = r - P, last = r - s
  const off = first - 1
  const temp: Vec3[] = new Array(last + 2 - off)
  temp[0] = row[off]
  temp[last + 1 - off] = row[last + 1]
  let i = first, j = last, ii = 1, jj = last - off
  while (j - i > 0) {
    const ai = (u - U[i]) / (U[i + ord] - U[i])
    const aj = (u - U[j]) / (U[j + ord] - U[j])
    temp[ii] = lin(row[i], temp[ii - 1], 1 / ai, -(1 - ai) / ai)
    temp[jj] = lin(row[j], temp[jj + 1], 1 / (1 - aj), -aj / (1 - aj))
    i++; ii++; j--; jj--
  }
  if (j - i < 0) return { temp, err: dist(temp[ii - 1], temp[jj + 1]) }
  const ai = (u - U[i]) / (U[i + ord] - U[i])
  return { temp, err: dist(row[i], lin(temp[ii + 1], temp[ii - 1], ai, 1 - ai)) }
}

/** The row with the removal made: the new poles in, Tiller's "first control point out" dropped. */
function applyRemoval(row: readonly Vec3[], temp: readonly Vec3[], r: number, s: number, P: number): Vec3[] {
  const first = r - P, last = r - s, off = first - 1
  const out = row.slice()
  for (let i = first, j = last; j - i > 0; i++, j--) { out[i] = temp[i - off]; out[j] = temp[j - off] }
  out.splice(Math.floor((2 * r - s - P) / 2), 1)
  return out
}

/**
 * A surface of degree p each way (3 when absent) given as a C1 Bezier net (nu x
 * nv poles, (u, v) at bezier[u * nv + v], span joins included) reduced to the
 * knots it needs, u then v. poles[a][b]: a along u, b along v.
 */
export function reduceSurface(bezier: readonly Vec3[], nu: number, nv: number, tol: number, minSpans = 0, p = 3): { uKnots: number[]; vKnots: number[]; poles: Vec3[][]; moved: number } {
  const ku = keepC1(nu, p), kv = keepC1(nv, p)
  // at least `minSpans` spans stay each way (knots kept at multiplicity 1 at least, evenly): the kernel's volume
  // integration wants them (exactStep.ts). c1Knots puts the span joins at 0, 1, ..., spans
  const kept = (spans: number) => {
    const every = minSpans > 0 ? Math.max(1, Math.floor(spans / minSpans)) : 0
    return new Set(every > 0 ? Array.from({ length: Math.floor(spans / every) + 1 }, (_, i) => i * every) : [])
  }
  const alongU = removeKnots({ knots: c1Knots((nu - 1) / p, p), rows: kv.map((j) => ku.map((i) => bezier[i * nv + j])), degree: p }, tol, kept((nu - 1) / p))
  const count = alongU.rows[0].length
  const alongV = removeKnots({ knots: c1Knots((nv - 1) / p, p), rows: Array.from({ length: count }, (_, a) => alongU.rows.map((row) => row[a])), degree: p }, tol, kept((nv - 1) / p))
  return { uKnots: alongU.knots, vKnots: alongV.knots, poles: alongV.rows, moved: alongU.moved + alongV.moved }
}

/** A curve of degree p (3 when absent) given as a C1 Bezier chain (joins included) reduced to the knots it needs. */
export function reduceCurve(bezier: readonly Vec3[], tol: number, p = 3): { knots: number[]; poles: Vec3[]; moved: number } {
  const r = removeKnots({ knots: c1Knots((bezier.length - 1) / p, p), rows: [keepC1(bezier.length, p).map((i) => bezier[i])], degree: p }, tol)
  return { knots: r.knots, poles: r.rows[0], moved: r.moved }
}

/** Indices of a degree-p Bezier chain of `count` poles kept in its C1 form: all but the span joins' corner poles. */
export function keepC1(count: number, p = 3): number[] {
  return Array.from({ length: count }, (_, i) => i).filter((i) => i === 0 || i === count - 1 || i % p !== 0)
}

/** The knot vector as STEP writes it: distinct values and their multiplicities. */
export function knotRuns(knots: readonly number[]): { values: number[]; mults: number[] } {
  const values: number[] = [], mults: number[] = []
  for (const k of knots) {
    if (values.length > 0 && values[values.length - 1] === k) mults[mults.length - 1]++
    else { values.push(k); mults.push(1) }
  }
  return { values, mults }
}

/** The clamped knot vector of a degree-p C1 Bezier chain of `spans` spans (interior knots of multiplicity p - 1), over 0..spans. */
export function c1Knots(spans: number, p = 3): number[] {
  const k: number[] = new Array(p + 1).fill(0)
  for (let i = 1; i < spans; i++) for (let r = 0; r < p - 1; r++) k.push(i)
  for (let r = 0; r <= p; r++) k.push(spans)
  return k
}

/** A point of a B-spline row of degree P (3 when absent) at parameter t (de Boor). */
export function evalRow(knots: readonly number[], row: readonly Vec3[], t: number, P = 3): Vec3 {
  const n = row.length - 1
  let k = P
  while (k < n && knots[k + 1] <= t) k++
  const d = Array.from({ length: P + 1 }, (_, j) => row[k - P + j].slice() as Vec3)
  for (let r = 1; r <= P; r++) {
    for (let j = P; j >= r; j--) {
      const i = k - P + j
      const a = (t - knots[i]) / (knots[i + P + 1 - r] - knots[i])
      d[j] = lin(d[j], d[j - 1], a, 1 - a)
    }
  }
  return d[P]
}

function lin(a: Vec3, b: Vec3, x: number, y: number): Vec3 {
  return [a[0] * x + b[0] * y, a[1] * x + b[1] * y, a[2] * x + b[2] * y]
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
