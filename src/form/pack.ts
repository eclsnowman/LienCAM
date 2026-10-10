// Form - face packing: neighbouring first-level quads of the exact solid joined
// into one B-spline face.
//
// exactStep.ts builds one bicubic B-spline per first-level quad, C1 inside
// (its span joins keep their corner poles out, knots of multiplicity 2). Two
// quads side by side are ONE such surface exactly when their join is C1 in the
// same sense: every pole on the join lies midway between the poles on either
// side of it. Then the join poles drop out like any span join and the two grids
// are one grid with the spans of both - the same surface, fewer faces. Joins
// through ordinary points pass (the patch rules put them midway); joins at an
// extraordinary point (the G1 pass moves the poles beside it) and creases do
// not, so they stay face boundaries - as in Rhino's packed ToNURBS.
//
// Packs are rectangles of quads grown from a seed while a whole row or column
// joins; a pack never wraps round onto itself (a face whose rim meets itself
// would need a seam edge).

import type { Vec3 } from './cage'
import { edgeKey } from './cage'

export interface PackRoot {
  /** Bezier poles, n x n, (u, v) at poles[u * n + v] */
  poles: Vec3[]
  /** first-level corner points, corner k at (u, v) = (0,0), (1,0), (1,1), (0,1) */
  corners: number[]
}

/** a quad placed in a pack: its side k lies on the pack cell's side (k + rot) % 4; cell sides 0 v-min, 1 u-max, 2 v-max, 3 u-min */
export interface PackCell { root: number; rot: number }

export interface Pack {
  /** cells[i][j]: i along the pack's u, j along its v */
  cells: PackCell[][]
  /** Bezier poles, nu x nv, (u, v) at poles[u * nv + v]; join poles included */
  poles: Vec3[]
  nu: number
  nv: number
}

/**
 * Rectangles of quads that are one C1 B-spline each. `eligible[r]` false keeps
 * quad r out (a plane, written as such). `tol` is the largest distance a join
 * pole may sit from the midpoint and still count as C1 (mm).
 */
export function packRoots(roots: PackRoot[], n: number, eligible: boolean[], tol: number): { packs: Pack[]; maxJoinMm: number } {
  const sides = new Map<string, Array<{ root: number; side: number }>>()
  roots.forEach((g, r) => {
    if (!eligible[r]) return
    for (let k = 0; k < 4; k++) {
      const key = edgeKey(g.corners[k], g.corners[(k + 1) % 4])
      sides.set(key, [...(sides.get(key) ?? []), { root: r, side: k }])
    }
  })
  /** the quad across cell side d of `cell`, placed consistently, or null */
  const across = (cell: PackCell, d: number): PackCell | null => {
    const g = roots[cell.root]
    const k = (d - cell.rot + 4) % 4
    const a = g.corners[k], b = g.corners[(k + 1) % 4]
    const on = sides.get(edgeKey(a, b)) ?? []
    if (on.length !== 2) return null
    const o = on.find((s) => !(s.root === cell.root && s.side === k))
    if (o === undefined || o.root === cell.root) return null
    const h = roots[o.root]
    // an outward-consistent neighbour runs the shared side the other way
    if (h.corners[o.side] !== b || h.corners[(o.side + 1) % 4] !== a) return null
    return { root: o.root, rot: ((d + 2) - o.side + 8) % 4 }
  }
  /** writes cell's poles into a grid of height nv at cell offset (ci, cj) */
  const place = (cell: PackCell, out: Vec3[], nv: number, ci: number, cj: number) => placeGrid(roots[cell.root].poles, n, cell.rot, out, nv, ci, cj)
  let maxJoinMm = 0
  /** how far the join between a and b (b across a's side d) is from C1; Infinity when their shared poles differ */
  const joinGap = (a: PackCell, b: PackCell, d: number): number => {
    const alongU = d === 1 || d === 3
    const nu = alongU ? 2 * n - 1 : n, nv = alongU ? n : 2 * n - 1
    const grid: Vec3[] = new Array(nu * nv)
    const first = d === 1 || d === 2 ? a : b, second = first === a ? b : a
    place(first, grid, nv, 0, 0)
    const shared: Vec3[] = []
    for (let t = 0; t < n; t++) shared.push(alongU ? grid[(n - 1) * nv + t] : grid[t * nv + n - 1])
    place(second, grid, nv, alongU ? 1 : 0, alongU ? 0 : 1)
    let gap = 0
    for (let t = 0; t < n; t++) {
      const at = (s: number) => (alongU ? grid[(n - 1 + s) * nv + t] : grid[t * nv + n - 1 + s])
      const p = at(0)
      if (dist(p, shared[t]) > tol) return Infinity
      const lo = at(-1), hi = at(1)
      gap = Math.max(gap, dist(p, [(lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, (lo[2] + hi[2]) / 2]))
    }
    return gap
  }
  const joins = (a: PackCell, b: PackCell, d: number) => {
    const gap = joinGap(a, b, d)
    if (gap > tol) return false
    maxJoinMm = Math.max(maxJoinMm, gap)
    return true
  }
  const same = (a: PackCell | null, b: PackCell) => a !== null && a.root === b.root && a.rot === b.rot

  const taken = new Uint8Array(roots.length)
  const packs: Pack[] = []
  for (let seed = 0; seed < roots.length; seed++) {
    if (!eligible[seed] || taken[seed]) continue
    let cells: PackCell[][] = [[{ root: seed, rot: 0 }]]
    const inPack = new Set([seed])
    for (let grew = true; grew;) {
      grew = false
      for (let d = 0; d < 4; d++) {
        const A = cells.length, B = cells[0].length
        // the row or column of cells along side d
        const edge: PackCell[] = d === 0 ? cells.map((c) => c[0]) : d === 1 ? cells[A - 1] : d === 2 ? cells.map((c) => c[B - 1]) : cells[0]
        const line: PackCell[] = []
        const seen = new Set<number>()
        let ok = true
        for (let t = 0; t < edge.length && ok; t++) {
          const c = across(edge[t], d)
          if (c === null || taken[c.root] || inPack.has(c.root) || seen.has(c.root) || !joins(edge[t], c, d)) { ok = false; break }
          // along the line, each new cell joins the one before it
          if (t > 0) {
            const along = d === 0 || d === 2 ? 1 : 2
            if (!same(across(line[t - 1], along), c) || !joins(line[t - 1], c, along)) { ok = false; break }
          }
          seen.add(c.root)
          line.push(c)
        }
        if (!ok) continue
        const next = d === 0 ? cells.map((col, i) => [line[i], ...col]) : d === 1 ? [...cells, line] : d === 2 ? cells.map((col, i) => [...col, line[i]]) : [line, ...cells]
        if (!simpleRim(next, roots)) continue
        cells = next
        for (const c of line) inPack.add(c.root)
        grew = true
      }
    }
    for (const r of inPack) taken[r] = 1
    const A = cells.length, B = cells[0].length
    const nu = A * (n - 1) + 1, nv = B * (n - 1) + 1
    const poles: Vec3[] = new Array(nu * nv)
    cells.forEach((col, i) => col.forEach((c, j) => place(c, poles, nv, i, j)))
    packs.push({ cells, poles, nu, nv })
  }
  return { packs, maxJoinMm }
}

/** Writes one quad's n x n grid, turned `rot` quarter turns, into a pack grid of height nv at cell offset (ci, cj). */
export function placeGrid(poles: readonly Vec3[], n: number, rot: number, out: Vec3[], nv: number, ci: number, cj: number): void {
  for (let u = 0; u < n; u++) for (let v = 0; v < n; v++) {
    let x = u, y = v
    for (let t = 0; t < rot; t++) { const nx = n - 1 - y; y = x; x = nx }
    out[(ci * (n - 1) + x) * nv + cj * (n - 1) + y] = poles[u * n + v]
  }
}

/** The pack's rim, as quad sides in loop order: bottom left to right, right side up, top right to left, left side down. */
export function packRim(cells: PackCell[][]): Array<{ cell: PackCell; side: number }> {
  const A = cells.length, B = cells[0].length
  const out: Array<{ cell: PackCell; side: number }> = []
  const at = (cell: PackCell, d: number) => out.push({ cell, side: (d - cell.rot + 4) % 4 })
  for (let i = 0; i < A; i++) at(cells[i][0], 0)
  for (let j = 0; j < B; j++) at(cells[A - 1][j], 1)
  for (let i = A - 1; i >= 0; i--) at(cells[i][B - 1], 2)
  for (let j = B - 1; j >= 0; j--) at(cells[0][j], 3)
  return out
}

/** no corner point twice on the rim: the pack does not meet itself */
function simpleRim(cells: PackCell[][], roots: PackRoot[]): boolean {
  const seen = new Set<number>()
  for (const { cell, side } of packRim(cells)) {
    const a = roots[cell.root].corners[side]
    if (seen.has(a)) return false
    seen.add(a)
  }
  return true
}

function dist(a: Vec3, b: Vec3): number {
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2])
}
