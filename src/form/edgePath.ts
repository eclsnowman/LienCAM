// Form - Pipe along picked body edges: the edges' polylines (the Model screen's
// edge tessellation, one polyline per edge) chained end to end into one path.
//
//   longestEdgeChain  every edge whose end meets the chain's tip is joined on
//                     (joinPaths, either way round), the chain closing when it
//                     comes back round; an edge that is a loop by itself (a
//                     circle's edge) is a closed path of its own. Edges that do
//                     not all connect make several chains: the longest is the
//                     one Pipe follows, and the counts say how many were left.

import type { Vec3 } from './cage'
import { joinPaths, pathLength, type SketchPath } from './pipe'

export interface EdgeChain {
  path: SketchPath
  /** edges in the chain */
  edges: number
  /** edges picked (with at least two distinct points) */
  total: number
}

const near = (a: Vec3, b: Vec3, tol: number) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]) <= tol

/** One edge's polyline as a path: repeated points dropped; closed when it ends where it starts. */
function edgePiece(points: readonly Vec3[], tol: number): SketchPath | null {
  const pts: Vec3[] = []
  for (const p of points) if (pts.length === 0 || !near(pts[pts.length - 1], p, tol)) pts.push([p[0], p[1], p[2]])
  if (pts.length < 2) return null
  if (pts.length > 3 && near(pts[0], pts[pts.length - 1], tol)) return { points: pts.slice(0, -1), closed: true }
  return { points: pts, closed: false }
}

/** The longest chain of the picked edges (see the file header); null when no edge has two distinct points. */
export function longestEdgeChain(polylines: readonly (readonly Vec3[])[], tol = 1e-3): EdgeChain | null {
  const pieces = polylines.map((p) => edgePiece(p, tol)).filter((p): p is SketchPath => p !== null)
  if (pieces.length === 0) return null
  const ends = (p: SketchPath) => [p.points[0], p.points[p.points.length - 1]]
  // an end no other edge touches: an open chain is started there, so a branch point is walked through, not from
  const free = (i: number) => !pieces[i].closed && ends(pieces[i]).some((e) => !pieces.some((q, k) => k !== i && !q.closed && ends(q).some((f) => near(e, f, tol))))
  const order = pieces.map((_, i) => i).sort((a, b) => Number(free(b)) - Number(free(a)))
  const used = new Set<number>()
  let best: { path: SketchPath; edges: number } | null = null
  for (const s of order) {
    if (used.has(s)) continue
    used.add(s)
    let path = pieces[s], edges = 1
    for (let grown = !path.closed; grown && !path.closed;) {
      grown = false
      for (let k = 0; k < pieces.length && !path.closed; k++) {
        if (used.has(k)) continue
        const joined = joinPaths(path, pieces[k], tol)
        if (joined === null) continue
        used.add(k)
        path = joined
        edges++
        grown = true
      }
    }
    if (best === null || pathLength(path) > pathLength(best.path)) best = { path, edges }
  }
  return best === null ? null : { ...best, total: pieces.length }
}
