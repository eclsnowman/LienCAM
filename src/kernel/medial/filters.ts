// WO-3038 (alpha.3 A3-07): the medial-axis filters, generalised from today's V-carve pruning
// (src/lib/cam/vcarve2d/medialAxis.ts, read-only) into declared rules. Thresholds come from
// parameters.ts at today's values.
//
// 1. Secondary-edge removal: a Delaunay edge joining CONSECUTIVE samples on one contour is a
//    piece of the boundary; its dual edge crosses the boundary and is dropped. That removes
//    every spur a point-sampled Voronoi diagram grows perpendicular to each boundary segment.
// 2. Spur pruning, in two phases: peel leaves whose separation angle is below the corner
//    angle (sampling noise toward a polygonised arc's vertices), then prune leaf branches
//    shorter than the prune length, except a branch into a CONVEX corner, which is kept and
//    later extended to the corner with r = 0. A component is never pruned to nothing: its
//    deepest node stays as a single point.
// 3. Radius trim: split a chain where its clearance radius crosses a bound (the V-carve flat
//    radius), keeping the part at or below it, with the crossing point interpolated.
//    (The radius refinement against the true boundary is part of construction.)

import { MEDIAL_PARAMETERS as P } from './parameters'
import type { AxisNode, AxisPath, CandidateEdge, GraphNode } from './contracts'

/** Filter 1: the kept edges, in their construction order. */
export function removeSecondaryEdges(edges: readonly CandidateEdge[]): CandidateEdge[] {
  return edges.filter(e => !e.secondary)
}

/** Add `edges` to the nodes' adjacency, in order. */
export function connect(nodes: GraphNode[], edges: readonly CandidateEdge[]): void {
  for (const { a, b } of edges) {
    nodes[a].adj.push(b)
    nodes[b].adj.push(a)
  }
}

export function degree(nodes: readonly GraphNode[], id: number): number {
  let d = 0
  for (const n of nodes[id].adj) if (nodes[n].alive) d++
  return d
}

export function chainLength(nodes: readonly GraphNode[], ids: readonly number[]): number {
  let len = 0
  for (let i = 1; i < ids.length; i++) len += Math.hypot(nodes[ids[i]].x - nodes[ids[i - 1]].x, nodes[ids[i]].y - nodes[ids[i - 1]].y)
  return len
}

/** Walk from a leaf inward until a junction (degree != 2) or a dead end. */
export function leafChain(nodes: readonly GraphNode[], leaf: number): number[] {
  const chain = [leaf]
  let prev = -1, cur = leaf
  for (;;) {
    let next = -1
    for (const n of nodes[cur].adj) if (nodes[n].alive && n !== prev) { next = n; break }
    if (next < 0) break
    const d = degree(nodes, next)
    if (d !== 2) { chain.push(next); break }
    chain.push(next)
    prev = cur; cur = next
    if (chain.length > nodes.length) break
  }
  return chain
}

/** Filter 2a: peel leaves whose separation angle is below `minSeparation` (radians), until
 *  stable. A branch a polygonised arc grows toward one of its vertices has a separation of a
 *  degree or two all the way in, so it peels back to the true axis; a corner branch keeps
 *  the corner angle and survives. */
export function peelLowSeparationLeaves(nodes: GraphNode[], minSeparation: number): void {
  let peeled = true
  let guard = 0
  while (peeled && guard++ < P.peelGuard.value) {
    peeled = false
    for (let id = 0; id < nodes.length; id++) {
      const n = nodes[id]
      if (!n.alive || n.corner || n.sep >= minSeparation) continue
      if (degree(nodes, id) === 1) { n.alive = false; peeled = true }
    }
  }
}

/** Filter 2b: prune leaf branches shorter than `pruneLength` that do not end in a convex
 *  corner, until stable. A two-leaf component keeps only its deepest node. */
export function pruneShortLeaves(nodes: GraphNode[], pruneLength: number): void {
  let changed = true
  let guard = 0
  while (changed && guard++ < P.pruneGuard.value) {
    changed = false
    for (let id = 0; id < nodes.length; id++) {
      const n = nodes[id]
      if (!n.alive || degree(nodes, id) !== 1 || n.corner) continue
      const chain = leafChain(nodes, id)
      const end = chain[chain.length - 1]
      if (chainLength(nodes, chain) >= pruneLength) continue
      if (degree(nodes, end) <= 1) {
        const keep = chain.reduce((best, c) => (nodes[c].r > nodes[best].r ? c : best), chain[0])
        for (const c of chain) if (c !== keep) nodes[c].alive = false
        changed = true
        continue
      }
      for (let i = 0; i < chain.length - 1; i++) nodes[chain[i]].alive = false
      changed = true
    }
  }
}

/** Filter 2: spur pruning, both phases. */
export function pruneSpurs(nodes: GraphNode[], pruneLength: number, minSeparation: number): void {
  peelLowSeparationLeaves(nodes, minSeparation)
  pruneShortLeaves(nodes, pruneLength)
}

/** Filter 3: radius trim. The pieces of `path` whose radius is at or below `rMax`, split at
 *  the interpolated crossings. A closed chain starts at its widest point so the seam falls
 *  outside the kept part and never splits one piece in two. Re-hosts today's V-carve
 *  splitByRadius (src/lib/cam/vcarve2d/index.ts:105). */
export function trimByRadius(path: AxisPath, rMax: number): AxisNode[][] {
  let base = path.points
  if (path.closed && base.length > 1) {
    let widest = 0
    for (let i = 1; i < base.length; i++) if (base[i].r > base[widest].r) widest = i
    base = [...base.slice(widest), ...base.slice(0, widest)]
  }
  const pts = path.closed && base.length > 1 ? [...base, base[0]] : base
  const runs: AxisNode[][] = []
  let cur: AxisNode[] = []
  const flush = () => { if (cur.length >= 1) runs.push(cur); cur = [] }
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]
    const inside = p.r <= rMax
    if (i > 0) {
      const q = pts[i - 1]
      const qInside = q.r <= rMax
      if (qInside !== inside) {
        const t = (rMax - q.r) / (p.r - q.r)
        const x = { x: q.x + (p.x - q.x) * t, y: q.y + (p.y - q.y) * t, r: rMax }
        if (qInside) { cur.push(x); flush() } else { cur.push(x) }
      }
    }
    if (inside) cur.push(p)
    else if (cur.length) flush()
  }
  flush()
  return runs.filter(r => r.length >= 1)
}
