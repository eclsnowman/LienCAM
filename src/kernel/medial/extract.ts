// WO-3038 (alpha.3 A3-07): reading the filtered graph as chains, re-hosted from today's V-carve
// axis (src/lib/cam/vcarve2d/medialAxis.ts, read-only). A leaf on a corner branch is extended
// to the corner itself with r = 0, so a V-bit rises to the surface exactly at the tip.

import { MEDIAL_PARAMETERS as P } from './parameters'
import { distPointSegment } from './construct'
import { degree } from './filters'
import type { AxisNode, AxisPath, GraphNode } from './contracts'

/** Drop consecutive coincident nodes: four co-circular samples split into two Delaunay
 *  triangles with the same circumcentre, which would otherwise appear twice in a chain. */
export function dedupe(points: AxisNode[]): AxisNode[] {
  const eps = P.dedupeEps.value
  const out: AxisNode[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) < eps && Math.abs(last.y - p.y) < eps) {
      if (p.r < last.r) out[out.length - 1] = p
      continue
    }
    out.push(p)
  }
  return out
}

/** Douglas-Peucker on position and radius together. */
export function simplify(input: AxisNode[], tol: number): AxisNode[] {
  const points = dedupe(input)
  if (tol <= 0 || points.length < 3) return points
  const keep = new Uint8Array(points.length)
  keep[0] = 1; keep[points.length - 1] = 1
  const stack: [number, number][] = [[0, points.length - 1]]
  while (stack.length) {
    const [s, e] = stack.pop()!
    let worst = -1, worstD = tol
    for (let i = s + 1; i < e; i++) {
      const d = distPointSegment(points[i].x, points[i].y, points[s], points[e])
      const dr = Math.abs(points[i].r - ((points[s].r + points[e].r) / 2))
      const m = Math.max(d, dr)
      if (m > worstD) { worstD = m; worst = i }
    }
    if (worst >= 0) { keep[worst] = 1; stack.push([s, worst], [worst, e]) }
  }
  const out: AxisNode[] = []
  for (let i = 0; i < points.length; i++) if (keep[i]) out.push(points[i])
  return out
}

/** Maximal chains of the live graph: between junctions and leaves first, then pure cycles. */
export function extractPaths(nodes: readonly GraphNode[], simplifyTol: number): AxisPath[] {
  const paths: AxisPath[] = []
  const visitedEdge = new Set<string>()
  const key = (a: number, b: number) => (a < b ? `${a}:${b}` : `${b}:${a}`)
  const toNode = (id: number): AxisNode => ({ x: nodes[id].x, y: nodes[id].y, r: nodes[id].r })

  const walk = (start: number, next: number): number[] => {
    const chain = [start, next]
    visitedEdge.add(key(start, next))
    let prev = start, cur = next
    while (degree(nodes, cur) === 2) {
      let nxt = -1
      for (const n of nodes[cur].adj) if (nodes[n].alive && n !== prev) { nxt = n; break }
      if (nxt < 0 || visitedEdge.has(key(cur, nxt))) break
      visitedEdge.add(key(cur, nxt))
      chain.push(nxt)
      prev = cur; cur = nxt
      if (chain.length > nodes.length + 1) break
    }
    return chain
  }

  for (let id = 0; id < nodes.length; id++) {
    if (!nodes[id].alive) continue
    const d = degree(nodes, id)
    if (d === 2) continue
    if (d === 0) {
      paths.push({ points: [toNode(id)], closed: false })
      continue
    }
    for (const n of nodes[id].adj) {
      if (!nodes[n].alive || visitedEdge.has(key(id, n))) continue
      const chain = walk(id, n)
      let pts = chain.map(toNode)
      const first = nodes[chain[0]], last = nodes[chain[chain.length - 1]]
      if (degree(nodes, chain[0]) === 1 && first.corner) pts = [{ ...first.corner, r: 0 }, ...pts]
      if (degree(nodes, chain[chain.length - 1]) === 1 && last.corner) pts = [...pts, { ...last.corner, r: 0 }]
      paths.push({ points: simplify(pts, simplifyTol), closed: false })
    }
  }
  for (let id = 0; id < nodes.length; id++) {
    if (!nodes[id].alive || degree(nodes, id) !== 2) continue
    const n0 = nodes[id].adj.find(n => nodes[n].alive && !visitedEdge.has(key(id, n)))
    if (n0 === undefined) continue
    const chain = walk(id, n0)
    if (chain.length >= 3 && chain[chain.length - 1] === chain[0]) chain.pop()
    paths.push({ points: simplify(chain.map(toNode), simplifyTol), closed: true })
  }
  return paths
}
