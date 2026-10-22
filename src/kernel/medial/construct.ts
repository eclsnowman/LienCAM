// WO-3038 (alpha.3 A3-07): medial-axis construction, re-hosted from today's V-carve axis
// (src/lib/cam/vcarve2d/medialAxis.ts, read-only; copied, not moved).
//
// The Voronoi diagram of a dense boundary sampling approximates the medial axis (Brandt and
// Algazi 1994; Amenta, Bern and Eppstein 1998). The samples are triangulated (vendored
// Delaunator, exact orientation predicate); each triangle whose circumcentre lies inside the
// region has an empty circumcircle, so its centre is an axis vertex with r = circumradius,
// refined against the true boundary segments around the three samples so depth does not
// depend on where the samples fell. Two centres are joined when their triangles share a
// Delaunay edge (the dual Voronoi edge). The filters (filters.ts) decide which survive.

import Delaunator, { orient2d } from './vendor/delaunator'
import { MEDIAL_PARAMETERS as P } from './parameters'
import type { CandidateEdge, GraphNode, Pt, Region, Site } from './contracts'

function signedArea(pts: Pt[]): number {
  let a = 0
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n]
    a += p.x * q.y - q.x * p.y
  }
  return a / 2
}

/** Drop repeated / near-coincident consecutive vertices and the duplicate closing vertex,
 *  and orient: outer CCW, holes CW. */
export function normalizeRegion(region: Region, eps = P.normalizeEps.value): Region {
  const minVertices = P.minContourVertices.value
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
    if (out.length >= minVertices && (signedArea(out) > 0) !== wantCCW) out.reverse()
    return out
  }
  return {
    outer: clean(region.outer, true),
    holes: region.holes.map(h => clean(h, false)).filter(h => h.length >= minVertices),
  }
}

/** Resample every contour at `spacing`, keeping every original vertex. `rings` holds, per
 *  contour, the sample indices in order. */
export function sampleRegion(region: Region, spacing: number, cornerAngleRad: number): { sites: Site[]; rings: number[][] } {
  const sites: Site[] = []
  const rings: number[][] = []
  const contours = [region.outer, ...region.holes]
  contours.forEach((pts, ring) => {
    const n = pts.length
    const ids: number[] = []
    for (let i = 0; i < n; i++) {
      const a = pts[i], b = pts[(i + 1) % n], p = pts[(i + n - 1) % n]
      // Left turn = convex corner of the region (interior on the left for a CCW outer and a
      // CW hole alike); only a turn sharper than the corner angle is a corner.
      const ux = a.x - p.x, uy = a.y - p.y, vx = b.x - a.x, vy = b.y - a.y
      const cross = ux * vy - uy * vx
      const dot = ux * vx + uy * vy
      const turn = Math.atan2(Math.abs(cross), dot)
      const convex = cross > P.convexCrossEps.value && turn >= cornerAngleRad
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

export function distPointSegment(px: number, py: number, a: Pt, b: Pt): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const l2 = dx * dx + dy * dy
  let t = l2 > 0 ? ((px - a.x) * dx + (py - a.y) * dy) / l2 : 0
  t = t < 0 ? 0 : t > 1 ? 1 : t
  const cx = a.x + t * dx - px, cy = a.y + t * dy - py
  return Math.hypot(cx, cy)
}

/** Point-in-region with a segment grid (many queries against one boundary). */
export class SegmentGrid {
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

  /** Even-odd containment by a horizontal ray to +x. Points within `eps` of a segment count
   *  as outside (the axis never sits on the boundary). */
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

export function circumcircle(ax: number, ay: number, bx: number, by: number, cx: number, cy: number):
  { x: number; y: number; r: number } | null {
  const d = 2 * (ax * (by - cy) + bx * (cy - ay) + cx * (ay - by))
  if (Math.abs(d) < P.circumcircleDegenerate.value) return null
  const a2 = ax * ax + ay * ay, b2 = bx * bx + by * by, c2 = cx * cx + cy * cy
  const ux = (a2 * (by - cy) + b2 * (cy - ay) + c2 * (ay - by)) / d
  const uy = (a2 * (cx - bx) + b2 * (ax - cx) + c2 * (bx - ax)) / d
  return { x: ux, y: uy, r: Math.hypot(ux - ax, uy - ay) }
}

export interface Construction {
  sites: Site[]
  nodes: GraphNode[]
  /** Every dual edge between two interior centres, in Delaunay half-edge order. */
  edges: CandidateEdge[]
}

/** Inscribed-circle centres and every candidate dual edge of one normalised region. No
 *  filter has run: adjacency is empty until `connect` (filters.ts) adds the kept edges. */
export function construct(region: Region, spacing: number, cornerAngleRad: number): Construction {
  const { sites, rings } = sampleRegion(region, spacing, cornerAngleRad)
  if (sites.length < P.minContourVertices.value) return { sites, nodes: [], edges: [] }
  const coords = new Float64Array(sites.length * 2)
  for (let i = 0; i < sites.length; i++) { coords[2 * i] = sites[i].x; coords[2 * i + 1] = sites[i].y }
  const del = new Delaunator(coords)
  const tri = del.triangles
  const half = del.halfedges
  const triCount = tri.length / 3

  const contours = [region.outer, ...region.holes]
  const grid = new SegmentGrid(contours, Math.max(spacing * P.gridCellPerSpacing.value, P.gridCellMin.value))
  const onBoundaryEps = spacing * P.onBoundaryPerSpacing.value

  // Is (i, j) a boundary segment of some ring?
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

  const nodeOf = new Int32Array(triCount).fill(-1)
  const nodes: GraphNode[] = []
  for (let t = 0; t < triCount; t++) {
    const i0 = tri[3 * t], i1 = tri[3 * t + 1], i2 = tri[3 * t + 2]
    const s0 = sites[i0], s1 = sites[i1], s2 = sites[i2]
    if (orient2d(s0.x, s0.y, s1.x, s1.y, s2.x, s2.y) === 0) continue
    const cc = circumcircle(s0.x, s0.y, s1.x, s1.y, s2.x, s2.y)
    if (!cc || !Number.isFinite(cc.r)) continue
    if (!grid.contains(cc.x, cc.y, onBoundaryEps)) continue
    // Radius refinement: the inscribed radius against the true boundary segments.
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
    nodes.push({ x: cc.x, y: cc.y, r, circumradius: cc.r, adj: [], corner, sep, alive: true })
  }

  const edges: CandidateEdge[] = []
  if (nodes.length === 0) return { sites, nodes, edges }
  for (let e = 0; e < half.length; e++) {
    const twin = half[e]
    if (twin < 0 || twin < e) continue
    const na = nodeOf[Math.floor(e / 3)], nb = nodeOf[Math.floor(twin / 3)]
    if (na < 0 || nb < 0) continue
    edges.push({ a: na, b: nb, secondary: consecutive(tri[e], tri[twin]) })
  }
  return { sites, nodes, edges }
}
