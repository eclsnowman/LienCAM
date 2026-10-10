// Medial axis of a planar region (outer contour + holes), for V-carving.
//
// The V-bit follows the medial axis: the set of points inside the region with
// two or more nearest boundary points. At each axis point the inscribed
// radius r is the distance to the boundary; a V-bit of half-angle a cuts both
// walls at once when its tip sits r / tan(a) below the surface. So the axis
// with its radii IS the toolpath, before depth clipping.
//
// Method: the Voronoi diagram of a dense boundary sampling approximates the
// medial axis (Brandt and Algazi 1994; Amenta, Bern and Eppstein 1998). We
// take the Delaunay triangulation of the samples (vendored Delaunator, exact
// orientation predicate), keep the triangles whose circumcentre lies inside
// the region - each such circumcircle is empty of samples, so it is an
// inscribed circle and its centre is an axis point with r = circumradius -
// and connect circumcentres of triangles that share a Delaunay edge. Two
// things keep the result clean:
//   1. A Delaunay edge joining CONSECUTIVE samples on one contour is a piece
//      of the boundary; its dual Voronoi edge crosses the boundary and is
//      dropped. That removes every "spur" a point-sampled Voronoi diagram
//      grows perpendicular to each boundary segment.
//   2. Leaf branches shorter than a few sample spacings are pruned, except
//      the branch into a CONVEX corner, which is the feature a V-carve
//      exists to reproduce: it is kept and extended to the corner itself
//      with r = 0, so the bit rises to the surface exactly at the tip.
// Radii are refined against the true boundary segments around the three
// defining samples, so depth does not depend on where the samples fell.
//
// Everything here is pure geometry: no heights, no tool, no moves.

import Delaunator, { orient2d } from './vendor/delaunator'

export interface Pt { x: number; y: number }

/** A region: one outer contour (counter-clockwise) and its holes (clockwise).
 *  No contour repeats its first point at the end. */
export interface Region {
  outer: Pt[]
  holes: Pt[][]
}

/** A point on the medial axis with its inscribed radius. */
export interface AxisNode extends Pt {
  r: number
}

/** A maximal chain of the axis between junctions or leaves; `closed` when the
 *  chain is a cycle with no junction (an annulus has exactly one). */
export interface AxisPath {
  points: AxisNode[]
  closed: boolean
}

export interface MedialAxisOptions {
  /** Boundary sample spacing (mm). Smaller is more faithful and slower. */
  spacing: number
  /** Leaf branches shorter than this (mm) are pruned unless they end in a
   *  convex corner. Default 3 x spacing. */
  pruneLength?: number
  /** Polyline simplification tolerance (mm) applied to each chain. Default
   *  spacing / 4. Zero disables. */
  simplifyTolerance?: number
  /** A contour vertex turning by at least this many degrees is a corner the
   *  bit rises into at the surface. Default 40: a font outline tessellated at
   *  eight divisions per curve turns by up to about 35 degrees at a vertex
   *  and must not grow a nick there, while a letter joint or serif turns by
   *  60 to 90. */
  cornerAngleDeg?: number
}

interface Site {
  x: number
  y: number
  ring: number
  index: number      // position along its ring's sample list
  vertex: boolean    // an original contour vertex (not a resample)
  convex: boolean    // original vertex where the region's interior angle < 180 deg
}

// ---------------------------------------------------------------------------
// Sampling
// ---------------------------------------------------------------------------

function signedArea(pts: Pt[]): number {
  let a = 0
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Drop repeated / near-coincident consecutive vertices and the duplicate
 *  closing vertex, and orient: outer CCW, holes CW. */
export function normalizeRegion(region: Region, eps = 1e-9): Region {
  const clean = (pts: Pt[], wantCCW: boolean): Pt[] => {
    const out: Pt[] = []
    for (const p of pts) {
      const last = out[out.length - 1]
      if (last && Math.abs(last.x - p.x) <= eps && Math.abs(last.y - p.y) <= eps) continue
      out.push({ x: p.x, y: p.y })
    }
    while (out.length > 1) {
      const a = out[0], b = out[out.length - 1]
      if (Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps) out.pop()
      else break
    }
    if (out.length >= 3 && (signedArea(out) > 0) !== wantCCW) out.reverse()
    return out
  }
  return {
    outer: clean(region.outer, true),
    holes: region.holes.map(h => clean(h, false)).filter(h => h.length >= 3),
  }
}

/** Resample every contour at `spacing`, keeping every original vertex. The
 *  rings array holds, per contour, the sample indices in order. */
function sampleRegion(region: Region, spacing: number, cornerAngleRad: number): { sites: Site[]; rings: number[][] } {
  const sites: Site[] = []
  const rings: number[][] = []
  const contours = [region.outer, ...region.holes]
  contours.forEach((pts, ring) => {
    const n = pts.length
    const ids: number[] = []
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], p = pts[(i + n - 1) % n]
      // Left turn = convex corner of the region (interior is on the left of
      // travel for a CCW outer and for a CW hole alike). A vertex of a
      // polygonised curve turns by a degree or two and is NOT a corner: only
      // a turn sharper than cornerAngleRad is one the bit must rise into.
      const ux = a.x - p.x, uy = a.y - p.y, vx = b.x - a.x, vy = b.y - a.y
      const cross = ux * vy - uy * vx
      const dot = ux * vx + uy * vy
      const turn = Math.atan2(Math.abs(cross), dot)
      const convex = cross > 1e-12 && turn >= cornerAngleRad
      ids.push(sites.length)
      sites.push({ x: a.x, y: a.y, ring, index: ids.length - 1, vertex: true, convex })
      const len = Math.hypot(b.x - a.x, b.y - a.y)
      const steps = Math.max(1, Math.ceil(len / spacing))
      for (let k = 1; k < steps; k++) {
        const t = k / steps
        ids.push(sites.length)
        sites.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, ring, index: ids.length - 1, vertex: false, convex: false })
      }
    }
    rings.push(ids)
  })
  return { sites, rings }
}

// ---------------------------------------------------------------------------
// Point-in-region with a segment grid (many queries against one boundary)
// ---------------------------------------------------------------------------

class SegmentGrid {
  private readonly minX: number
  private readonly minY: number
  private readonly cell: number
  private readonly cols: number
  private readonly rows: number
  private readonly cells: number[][]
  private readonly segA: Pt[] = []
  private readonly segB: Pt[] = []
  private readonly stamp: Uint32Array
  private query = 0

  constructor(contours: Pt[][], cell: number) {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const c of contours) for (const p of c) {
      if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
      if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
    }
    this.minX = minX - cell; this.minY = minY - cell
    this.cell = cell
    this.cols = Math.max(1, Math.ceil((maxX - this.minX) / cell) + 2)
    this.rows = Math.max(1, Math.ceil((maxY - this.minY) / cell) + 2)
    this.cells = new Array(this.cols * this.rows)
    for (const c of contours) {
      const n = c.length
      for (let i = 0; i < n; i++) {
        const a = c[i], b = c[(i + 1) % n]
        const id = this.segA.length
        this.segA.push(a); this.segB.push(b)
        const c0 = Math.floor((Math.min(a.x, b.x) - this.minX) / cell)
        const c1 = Math.floor((Math.max(a.x, b.x) - this.minX) / cell)
        const r0 = Math.floor((Math.min(a.y, b.y) - this.minY) / cell)
        const r1 = Math.floor((Math.max(a.y, b.y) - this.minY) / cell)
        for (let r = r0; r <= r1; r++) for (let col = c0; col <= c1; col++) {
          const k = r * this.cols + col
          ;(this.cells[k] ??= []).push(id)
        }
      }
    }
    this.stamp = new Uint32Array(this.segA.length)
  }

  /** Even-odd containment by a horizontal ray to +x. Points within `eps` of a
   *  segment count as outside (the axis never sits on the boundary). */
  contains(x: number, y: number, eps: number): boolean {
    const row = Math.floor((y - this.minY) / this.cell)
    if (row < 0 || row >= this.rows) return false
    const startCol = Math.floor((x - this.minX) / this.cell)
    if (startCol >= this.cols) return false
    this.query++
    let crossings = 0
    for (let col = Math.max(0, startCol); col < this.cols; col++) {
      const bucket = this.cells[row * this.cols + col]
      if (!bucket) continue
      for (const id of bucket) {
        if (this.stamp[id] === this.query) continue
        this.stamp[id] = this.query
        const a = this.segA[id], b = this.segB[id]
        if (distPointSegment(x, y, a, b) <= eps) return false
        // Half-open rule on y so a vertex exactly on the ray is counted once.
        if ((a.y > y) !== (b.y > y)) {
          const t = (y - a.y) / (b.y - a.y)
          const ix = a.x + t * (b.x - a.x)
          if (ix > x) crossings++
        }
      }
    }
    return (crossings & 1) === 1
  }
}

function distPointSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = a.x + t * dx - px, cy = a.y + t * dy - py
  return Math.hypot(cx, cy)
}

// ---------------------------------------------------------------------------
// Circumcircles
// ---------------------------------------------------------------------------

function circumcircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number):
  { x: number; y: number; r: number } | null {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < 1e-14) return null
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  return { x: ux, y: uy, r: Math.hypot(ux - ax, uy - ay) }
}

// ---------------------------------------------------------------------------
// Graph
// ---------------------------------------------------------------------------

interface GraphNode extends AxisNode {
  adj: number[]
  /** Convex original vertex among the defining sites, if any. */
  corner: Pt | null
  /** Separation angle (radians): the widest angle two of the node's touching
   *  boundary points subtend at it. 180 deg between two parallel walls, the
   *  corner angle on a corner branch, a degree or two on the branch a
   *  polygonised arc grows toward each of its vertices. */
  sep: number
  alive: boolean
}

function chainLength(nodes: GraphNode[], ids: number[]): number {
  let len = 0
  for (let i = 1; i < ids.length; i++) len += Math.hypot(nodes[ids[i]].x - nodes[ids[i - 1]].x, nodes[ids[i]].y - nodes[ids[i - 1]].y)
  return len
}

function degree(nodes: GraphNode[], id: number): number {
  let d = 0
  for (const n of nodes[id].adj) if (nodes[n].alive) d++
  return d
}

/** Walk from a leaf inward until a junction (degree != 2) or a dead end. */
function leafChain(nodes: GraphNode[], leaf: number): number[] {
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

/** Prune short leaf branches that do not end in a convex corner. Repeats
 *  until stable. A component is never pruned to nothing: its deepest node is
 *  kept as a single point (a disc carves to one dimple). */
function pruneSpurs(nodes: GraphNode[], pruneLength: number, minSeparation: number): void {
  // Phase 1: peel leaves whose separation angle is below the corner
  // threshold. A branch a polygonised arc grows toward one of its vertices
  // has a separation of a degree or two all the way in, so it peels back to
  // the true axis; a corner branch keeps the corner angle and survives.
  let peeled = true
  let peelGuard = 0
  while (peeled && peelGuard++ < 100_000) {
    peeled = false
    for (let id = 0; id < nodes.length; id++) {
      const n = nodes[id]
      if (!n.alive || n.corner || n.sep >= minSeparation) continue
      const d = degree(nodes, id)
      if (d === 1) { n.alive = false; peeled = true }
    }
  }
  // Phase 2: length-prune what is left.
  let changed = true
  let guard = 0
  while (changed && guard++ < 10_000) {
    changed = false
    for (let id = 0; id < nodes.length; id++) {
      const n = nodes[id]
      if (!n.alive || degree(nodes, id) !== 1 || n.corner) continue
      const chain = leafChain(nodes, id)
      const end = chain[chain.length - 1]
      // chain includes the junction (or the far leaf); measure up to it.
      if (chainLength(nodes, chain) >= pruneLength) continue
      const endDeg = degree(nodes, end)
      if (endDeg <= 1) {
        // A whole component: two leaves and nothing else. Keep the deeper end only.
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

/** Drop consecutive coincident nodes: four co-circular samples (a symmetric
 *  pair of straight edges) split into two Delaunay triangles with the same
 *  circumcentre, which would otherwise appear twice in a chain. */
function dedupe(points: AxisNode[]): AxisNode[] {
  const out: AxisNode[] = []
  for (const p of points) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) < 1e-9 && Math.abs(last.y - p.y) < 1e-9) {
      if (p.r < last.r) out[out.length - 1] = p
      continue
    }
    out.push(p)
  }
  return out
}

function simplify(input: AxisNode[], tol: number): AxisNode[] {
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

/** Extract maximal chains from the live graph. */
function extractPaths(nodes: GraphNode[], simplifyTol: number): AxisPath[] {
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

  // Chains between junctions/leaves first.
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
  // Pure cycles (every node degree 2): an annulus.
  for (let id = 0; id < nodes.length; id++) {
    if (!nodes[id].alive || degree(nodes, id) !== 2) continue
    const n0 = nodes[id].adj.find(n => nodes[n].alive && !visitedEdge.has(key(id, n)))
    if (n0 === undefined) continue
    const chain = walk(id, n0)
    if (chain.length >= 3 && chain[chain.length - 1] === chain[0]) chain.pop()
    const pts = chain.map(toNode)
    paths.push({ points: simplify(pts, simplifyTol), closed: true })
  }
  return paths
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

/**
 * Medial axis of one region. Contours must be simple and non-overlapping
 * (weld overlapping outlines first - see regions.ts).
 */
export function medialAxis(input: Region, opts: MedialAxisOptions): AxisPath[] {
  const region = normalizeRegion(input)
  if (region.outer.length < 3) return []
  const spacing = Math.max(1e-3, opts.spacing)
  const pruneLength = opts.pruneLength ?? 3 * spacing
  const simplifyTol = opts.simplifyTolerance ?? spacing / 4
  const cornerAngleRad = ((opts.cornerAngleDeg ?? 40) * Math.PI) / 180

  const { sites, rings } = sampleRegion(region, spacing, cornerAngleRad)
  if (sites.length < 3) return []
  const coords = new Float64Array(sites.length * 2)
  for (let i = 0; i < sites.length; i++) { coords[2 * i] = sites[i].x; coords[2 * i + 1] = sites[i].y }
  const del = new Delaunator(coords)
  const tri = del.triangles
  const half = del.halfedges
  const triCount = tri.length / 3

  const contours = [region.outer, ...region.holes]
  const grid = new SegmentGrid(contours, Math.max(spacing * 8, 0.5))
  const onBoundaryEps = spacing * 1e-3

  // Consecutive-sample test: is (i, j) a boundary segment of some ring?
  const ringLen = rings.map(r => r.length)
  const consecutive = (i: number, j: number): boolean => {
    const a = sites[i], b = sites[j]
    if (a.ring !== b.ring) return false
    const n = ringLen[a.ring]
    const d = (a.index - b.index + n) % n
    return d === 1 || d === n - 1
  }

  // Distance from a point to the boundary segments touching a site.
  const segDist = (px: number, py: number, s: Site): number => {
    const ring = rings[s.ring]
    const n = ring.length
    const prev = sites[ring[(s.index + n - 1) % n]]
    const next = sites[ring[(s.index + 1) % n]]
    return Math.min(distPointSegment(px, py, prev, s), distPointSegment(px, py, s, next))
  }

  // Nodes: one per interior triangle (index by triangle id; -1 when exterior).
  const nodeOf = new Int32Array(triCount).fill(-1)
  const nodes: GraphNode[] = []
  for (let t = 0; t < triCount; t++) {
    const i0 = tri[3 * t], i1 = tri[3 * t + 1], i2 = tri[3 * t + 2]
    const s0 = sites[i0], s1 = sites[i1], s2 = sites[i2]
    if (orient2d(s0.x, s0.y, s1.x, s1.y, s2.x, s2.y) === 0) continue
    const cc = circumcircle(s0.x, s0.y, s1.x, s1.y, s2.x, s2.y)
    if (!cc || !Number.isFinite(cc.r)) continue
    if (!grid.contains(cc.x, cc.y, onBoundaryEps)) continue
    let r = cc.r
    for (const s of [s0, s1, s2]) r = Math.min(r, segDist(cc.x, cc.y, s))
    let corner: Pt | null = null
    for (const s of [s0, s1, s2]) if (s.vertex && s.convex) { corner = { x: s.x, y: s.y }; break }
    const a0 = Math.atan2(s0.y - cc.y, s0.x - cc.x)
    const a1 = Math.atan2(s1.y - cc.y, s1.x - cc.x)
    const a2 = Math.atan2(s2.y - cc.y, s2.x - cc.x)
    const between = (p: number, q: number) => { const d = Math.abs(p - q) % (2 * Math.PI); return d > Math.PI ? 2 * Math.PI - d : d }
    const sep = Math.max(between(a0, a1), between(a1, a2), between(a0, a2))
    nodeOf[t] = nodes.length
    nodes.push({ x: cc.x, y: cc.y, r, adj: [], corner, sep, alive: true })
  }
  if (nodes.length === 0) return []

  // Edges: interior triangles across a non-boundary Delaunay edge.
  for (let e = 0; e < half.length; e++) {
    const twin = half[e]
    if (twin < 0 || twin < e) continue
    const ta = Math.floor(e / 3), tb = Math.floor(twin / 3)
    const na = nodeOf[ta], nb = nodeOf[tb]
    if (na < 0 || nb < 0) continue
    const p = tri[e], q = tri[twin]
    if (consecutive(p, q)) continue
    nodes[na].adj.push(nb)
    nodes[nb].adj.push(na)
  }

  pruneSpurs(nodes, pruneLength, cornerAngleRad)
  return extractPaths(nodes, simplifyTol)
}
