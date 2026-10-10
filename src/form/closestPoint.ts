// Form - the closest point on a triangle mesh (a body's display tessellation),
// for Pull onto a body. Triangles are bucketed on a grid; a query searches
// shells of cells outward from its own until no nearer triangle can remain.

import type { Vec3 } from './cage'

export interface MeshLike { position: ArrayLike<number>; index: ArrayLike<number> }

export interface ClosestPointIndex {
  /** the nearest point of the mesh to `q`, and its distance */
  closest(q: Vec3): { point: Vec3; distance: number }
}

export function closestPointIndex(mesh: MeshLike): ClosestPointIndex {
  const P = mesh.position, I = mesh.index
  const T = Math.floor(I.length / 3)
  const lo: Vec3 = [Infinity, Infinity, Infinity], hi: Vec3 = [-Infinity, -Infinity, -Infinity]
  for (let i = 0; i < P.length; i += 3) for (let c = 0; c < 3; c++) { lo[c] = Math.min(lo[c], P[i + c]); hi[c] = Math.max(hi[c], P[i + c]) }
  const size = Math.max(1e-9, hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2])
  // cells sized by the cube root of the triangle count: a query from well inside or outside the body
  // crosses few empty cells (square-root sizing, finer, made those queries scan tens of thousands)
  const cell = size / Math.max(1, Math.round(Math.cbrt(Math.max(1, T))))
  const key = (x: number, y: number, z: number) => `${x},${y},${z}`
  const buckets = new Map<string, number[]>()
  const cellOf = (v: number, c: number) => Math.floor((v - lo[c]) / cell)
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, d = I[t * 3 + 2] * 3
    const mn = [0, 1, 2].map((c) => cellOf(Math.min(P[a + c], P[b + c], P[d + c]), c))
    const mx = [0, 1, 2].map((c) => cellOf(Math.max(P[a + c], P[b + c], P[d + c]), c))
    for (let x = mn[0]; x <= mx[0]; x++) for (let y = mn[1]; y <= mx[1]; y++) for (let z = mn[2]; z <= mx[2]; z++) {
      const k = key(x, y, z)
      const list = buckets.get(k)
      if (list) list.push(t)
      else buckets.set(k, [t])
    }
  }
  const span = [0, 1, 2].map((c) => cellOf(hi[c], c) + 1)
  const vert = (i: number): Vec3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]]
  return {
    closest(q) {
      const qc = [0, 1, 2].map((c) => cellOf(q[c], c))
      let best: Vec3 = vert(I[0]), bestD = Infinity
      const seen = new Set<number>()
      // shells of cells round the query's cell; stop once the shell is farther than the best found
      const far = Math.max(...[0, 1, 2].map((c) => Math.max(Math.abs(qc[c]), Math.abs(span[c] - qc[c])))) + 1
      for (let r = 0; r <= far; r++) {
        if (bestD < (r - 1) * cell) break
        for (let x = qc[0] - r; x <= qc[0] + r; x++) for (let y = qc[1] - r; y <= qc[1] + r; y++) for (let z = qc[2] - r; z <= qc[2] + r; z++) {
          if (Math.max(Math.abs(x - qc[0]), Math.abs(y - qc[1]), Math.abs(z - qc[2])) !== r) continue
          for (const t of buckets.get(key(x, y, z)) ?? []) {
            if (seen.has(t)) continue
            seen.add(t)
            const p = closestOnTriangle(q, vert(I[t * 3]), vert(I[t * 3 + 1]), vert(I[t * 3 + 2]))
            const d = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2])
            if (d < bestD) { bestD = d; best = p }
          }
        }
      }
      return { point: best, distance: bestD }
    },
  }
}

/** The nearest point of triangle abc to p (Ericson, Real-Time Collision Detection 5.1.5). */
export function closestOnTriangle(p: Vec3, a: Vec3, b: Vec3, c: Vec3): Vec3 {
  const ab = sub(b, a), ac = sub(c, a), ap = sub(p, a)
  const d1 = dot(ab, ap), d2 = dot(ac, ap)
  if (d1 <= 0 && d2 <= 0) return a
  const bp = sub(p, b), d3 = dot(ab, bp), d4 = dot(ac, bp)
  if (d3 >= 0 && d4 <= d3) return b
  const vc = d1 * d4 - d3 * d2
  if (vc <= 0 && d1 >= 0 && d3 <= 0) { const v = d1 / (d1 - d3); return add(a, scale(ab, v)) }
  const cp = sub(p, c), d5 = dot(ab, cp), d6 = dot(ac, cp)
  if (d6 >= 0 && d5 <= d6) return c
  const vb = d5 * d2 - d1 * d6
  if (vb <= 0 && d2 >= 0 && d6 <= 0) { const w = d2 / (d2 - d6); return add(a, scale(ac, w)) }
  const va = d3 * d6 - d5 * d4
  if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) { const w = (d4 - d3) / ((d4 - d3) + (d5 - d6)); return add(b, scale(sub(c, b), w)) }
  const denom = 1 / (va + vb + vc)
  return add(a, add(scale(ab, vb * denom), scale(ac, vc * denom)))
}

const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s]
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
