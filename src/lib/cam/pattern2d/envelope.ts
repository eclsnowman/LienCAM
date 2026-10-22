// pattern2d envelope - what the cutter removes around the tool-centre path (WO-2982).
//
// A pattern curve is the TOOL-CENTRE path. The cut footprint at depth d is a
// band of half-width h(d) around it (PLAN sec. 5): ball sqrt(d(2R-d)) capped at
// R; pointed tools tip/2 + d*tan(half-angle) capped at R; bull nose the flat
// plus the corner arc; every other cutter R. C1 (stays inside the region) and
// C2 (neighbouring passes stay distinct) are both measured on that footprint.
// They are REPORTED, never refused (Rule 11): the software can cut them.

import { toolHalfAngleRad } from '../geometry'
import type { Tool } from '../../../types'

export interface Pt { x: number; y: number }

/** A cut point: tool centre in world XY, its depth below the top and footprint half-width. */
export interface CutPoint extends Pt {
  t: number
  depth: number
  hw: number
}

const POINTED: ReadonlySet<Tool['type']> = new Set<Tool['type']>([
  'v_bit', 'chamfer_mill', 'spot_drill', 'drill', 'countersink', 'center_drill', 'tapered_endmill',
])

/** Half-width of the cut a tool leaves at depth `d` below the surface (mm). */
export function footprintHalfWidth(tool: Pick<Tool, 'type' | 'diameter' | 'cornerRadius' | 'angleFromAxisDeg' | 'tipDiameter'>, d: number): number {
  const R = tool.diameter / 2
  if (!(d > 0)) return 0
  if (tool.type === 'ball_end_mill') return d >= R ? R : Math.sqrt(d * (2 * R - d))
  if (tool.type === 'bull_nose') {
    const cr = Math.min(Math.max(tool.cornerRadius ?? 0, 0), R)
    return d >= cr ? R : R - cr + Math.sqrt(d * (2 * cr - d))
  }
  if (POINTED.has(tool.type)) {
    return Math.min(R, (tool.tipDiameter ?? 0) / 2 + d * Math.tan(toolHalfAngleRad(tool.angleFromAxisDeg)))
  }
  return R
}

// ── region (even-odd over every loop: an inner loop is a hole) ────────────────

function segDist(p: Pt, a: Pt, b: Pt): number {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const u = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return Math.hypot(a.x + u * dx - p.x, a.y + u * dy - p.y)
}

/** Distance from `p` to the region edge: positive inside, negative outside. */
export function insideDistance(p: Pt, region: Pt[][]): number {
  let inside = false
  let best = Infinity
  for (const loop of region) {
    const n = loop.length
    for (let i = 0, j = n - 1; i < n; j = i++) {
      const a = loop[j]
      const b = loop[i]
      if ((b.y > p.y) !== (a.y > p.y) && p.x < ((a.x - b.x) * (p.y - b.y)) / (a.y - b.y) + b.x) inside = !inside
      const d = segDist(p, a, b)
      if (d < best) best = d
    }
  }
  return inside ? best : -best
}

/** Signed area centroid of the region (holes subtract). */
export function regionCentroid(region: Pt[][]): Pt {
  let a = 0
  let cx = 0
  let cy = 0
  // Even-odd: orient each loop by nesting depth so holes subtract.
  for (const loop of region) {
    let la = 0
    let lx = 0
    let ly = 0
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const cross = loop[j].x * loop[i].y - loop[i].x * loop[j].y
      la += cross
      lx += (loop[j].x + loop[i].x) * cross
      ly += (loop[j].y + loop[i].y) * cross
    }
    const depth = region.filter(other => other !== loop && insideDistance(loop[0], [other]) > 0).length
    const sign = (depth % 2 === 0 ? 1 : -1) * Math.sign(la)
    a += sign * la
    cx += sign * lx
    cy += sign * ly
  }
  return a === 0 ? { x: 0, y: 0 } : { x: cx / (3 * a), y: cy / (3 * a) }
}

// ── segment-exact clipping and containment ────────────────────────────────────
//
// The machine cuts the CHORDS between samples, and a straight pass has only a
// few samples, so clipping and C1 work on whole segments, never on sample
// points alone: a segment's footprint is safe where it is inside the region
// and farther than its half-width from every region edge. A segment whose
// depth changes along it uses the larger end half-width (trims slightly more,
// never less).

interface Edge { a: Pt; b: Pt; minX: number; minY: number; maxX: number; maxY: number }

/** The region's edges in a uniform grid, built once per operation, so a
 *  segment only looks at the edges near it. */
export interface RegionEdges {
  edges: Edge[]
  cell: number
  minX: number
  minY: number
  maxX: number
  maxY: number
  grid: Map<number, number[]>
}

const gridKey = (gx: number, gy: number) => gx * 67_108_864 + gy

export function regionEdges(region: Pt[][]): RegionEdges {
  const edges: Edge[] = []
  for (const loop of region) {
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
      const a = loop[j]
      const b = loop[i]
      edges.push({ a, b, minX: Math.min(a.x, b.x), minY: Math.min(a.y, b.y), maxX: Math.max(a.x, b.x), maxY: Math.max(a.y, b.y) })
    }
  }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const e of edges) {
    minX = Math.min(minX, e.minX); minY = Math.min(minY, e.minY)
    maxX = Math.max(maxX, e.maxX); maxY = Math.max(maxY, e.maxY)
  }
  const span = Math.max(maxX - minX, maxY - minY)
  const cell = edges.length > 0 && span > 0 ? span / Math.max(1, Math.ceil(Math.sqrt(edges.length))) : 1
  const grid = new Map<number, number[]>()
  edges.forEach((e, id) => {
    for (let gx = Math.floor(e.minX / cell); gx <= Math.floor(e.maxX / cell); gx++) {
      for (let gy = Math.floor(e.minY / cell); gy <= Math.floor(e.maxY / cell); gy++) {
        const key = gridKey(gx, gy)
        let bucket = grid.get(key)
        if (!bucket) grid.set(key, (bucket = []))
        bucket.push(id)
      }
    }
  })
  return { edges, cell, minX, minY, maxX, maxY, grid }
}

/** Edges whose bounding box meets the box [x0, x1] x [y0, y1]. */
function edgesIn(idx: RegionEdges, x0: number, y0: number, x1: number, y1: number): Edge[] {
  x0 = Math.max(x0, idx.minX); y0 = Math.max(y0, idx.minY)
  x1 = Math.min(x1, idx.maxX); y1 = Math.min(y1, idx.maxY)
  if (x0 > x1 || y0 > y1) return []
  const gx0 = Math.floor(x0 / idx.cell)
  const gx1 = Math.floor(x1 / idx.cell)
  const gy0 = Math.floor(y0 / idx.cell)
  const gy1 = Math.floor(y1 / idx.cell)
  if ((gx1 - gx0 + 1) * (gy1 - gy0 + 1) > idx.edges.length) {
    return idx.edges.filter(e => e.maxX >= x0 && e.minX <= x1 && e.maxY >= y0 && e.minY <= y1)
  }
  const seen = new Set<number>()
  const out: Edge[] = []
  for (let gx = gx0; gx <= gx1; gx++) {
    for (let gy = gy0; gy <= gy1; gy++) {
      for (const id of idx.grid.get(gridKey(gx, gy)) ?? []) {
        if (seen.has(id)) continue
        seen.add(id)
        const e = idx.edges[id]
        if (e.maxX >= x0 && e.minX <= x1 && e.maxY >= y0 && e.minY <= y1) out.push(e)
      }
    }
  }
  return out
}

/** Distance from segment a-b to the nearest edge, widening the search box
 *  until an edge inside it is nearer than the box's pad (any edge outside the
 *  box is farther than the pad). */
function nearestEdgeDistance(a: Pt, b: Pt, idx: RegionEdges, startPad: number): number {
  let near = Infinity
  const limit = 2 * (idx.maxX - idx.minX + idx.maxY - idx.minY) + Math.hypot(b.x - a.x, b.y - a.y) + Math.hypot(a.x - idx.minX, a.y - idx.minY)
  for (let pad = Math.max(idx.cell, startPad); ; pad *= 2) {
    for (const e of nearEdges(a, b, idx, pad)) near = Math.min(near, segSegDist(a, b, e.a, e.b))
    if (near <= pad || pad > limit) return near
  }
}

function nearEdges(a: Pt, b: Pt, idx: RegionEdges, pad: number): Edge[] {
  return edgesIn(idx, Math.min(a.x, b.x) - pad, Math.min(a.y, b.y) - pad, Math.max(a.x, b.x) + pad, Math.max(a.y, b.y) + pad)
}

/** Even-odd inside test by a ray to +x, over the indexed edges it can meet. */
function insideRegion(p: Pt, idx: RegionEdges): boolean {
  let inside = false
  for (const e of edgesIn(idx, p.x, p.y, Infinity, p.y)) {
    const a = e.a
    const b = e.b
    if ((b.y > p.y) !== (a.y > p.y) && p.x < ((a.x - b.x) * (p.y - b.y)) / (a.y - b.y) + b.x) inside = !inside
  }
  return inside
}

/** u in [0, 1] where a + u(b - a) is closer than r to the segment e0-e1 (the
 *  open capsule is convex, so its trace on the line is one interval). */
function capsuleInterval(a: Pt, b: Pt, e0: Pt, e1: Pt, r: number): [number, number] | null {
  if (!(r > 0)) return null
  const dx = b.x - a.x
  const dy = b.y - a.y
  let lo = Infinity
  let hi = -Infinity
  const disc = (c: Pt) => {
    const fx = a.x - c.x
    const fy = a.y - c.y
    const A = dx * dx + dy * dy
    const B = 2 * (fx * dx + fy * dy)
    const C = fx * fx + fy * fy - r * r
    if (A === 0) {
      if (C < 0) { lo = Math.min(lo, 0); hi = Math.max(hi, 1) }
      return
    }
    const D = B * B - 4 * A * C
    if (D <= 0) return
    const sq = Math.sqrt(D)
    lo = Math.min(lo, (-B - sq) / (2 * A))
    hi = Math.max(hi, (-B + sq) / (2 * A))
  }
  disc(e0)
  disc(e1)
  const ex = e1.x - e0.x
  const ey = e1.y - e0.y
  const L = Math.hypot(ex, ey)
  if (L > 0) {
    const tx = ex / L
    const ty = ey / L
    let rlo = -Infinity
    let rhi = Infinity
    const band = (p0: number, p1: number, min: number, max: number) => {
      if (p1 === 0) {
        if (!(p0 > min && p0 < max)) { rlo = Infinity; rhi = -Infinity }
        return
      }
      const u0 = (min - p0) / p1
      const u1 = (max - p0) / p1
      rlo = Math.max(rlo, Math.min(u0, u1))
      rhi = Math.min(rhi, Math.max(u0, u1))
    }
    const fx = a.x - e0.x
    const fy = a.y - e0.y
    band(fx * tx + fy * ty, dx * tx + dy * ty, 0, L)
    band(-fx * ty + fy * tx, -dx * ty + dy * tx, -r, r)
    if (rlo < rhi) { lo = Math.min(lo, rlo); hi = Math.max(hi, rhi) }
  }
  lo = Math.max(lo, 0)
  hi = Math.min(hi, 1)
  return lo < hi ? [lo, hi] : null
}

/** u in (0, 1) where a -> b crosses e0-e1. */
function crossingParam(a: Pt, b: Pt, e0: Pt, e1: Pt): number | null {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const ex = e1.x - e0.x
  const ey = e1.y - e0.y
  const den = dx * ey - dy * ex
  if (den === 0) return null
  const fx = e0.x - a.x
  const fy = e0.y - a.y
  const u = (fx * ey - fy * ex) / den
  const v = (fx * dy - fy * dx) / den
  return u > 0 && u < 1 && v >= 0 && v <= 1 ? u : null
}

/**
 * The parts [u0, u1] of segment a -> b whose footprint (half-width hw) stays
 * inside the region: the line is cut at every edge capsule and every edge
 * crossing, and each remaining piece is wholly inside or wholly outside, which
 * its midpoint tells. Exact up to floating point.
 */
export function safeIntervals(a: Pt, b: Pt, hw: number, edges: RegionEdges): Array<[number, number]> {
  const bad: Array<[number, number]> = []
  const cuts = [0, 1]
  for (const e of nearEdges(a, b, edges, hw)) {
    const iv = capsuleInterval(a, b, e.a, e.b, hw)
    if (iv) { bad.push(iv); cuts.push(iv[0], iv[1]) }
    const u = crossingParam(a, b, e.a, e.b)
    if (u !== null) cuts.push(u)
  }
  cuts.sort((x, y) => x - y)
  const out: Array<[number, number]> = []
  for (let k = 0; k + 1 < cuts.length; k++) {
    const u0 = cuts[k]
    const u1 = cuts[k + 1]
    if (!(u1 > u0)) continue
    const um = (u0 + u1) / 2
    if (bad.some(([l, h]) => um > l && um < h)) continue
    if (!insideRegion({ x: a.x + (b.x - a.x) * um, y: a.y + (b.y - a.y) * um }, edges)) continue
    const last = out[out.length - 1]
    if (last && last[1] === u0) last[1] = u1
    else out.push([u0, u1])
  }
  return out
}

/**
 * Trim a run to the parts whose footprint stays inside the region, segment by
 * segment (see safeIntervals). `interp(a, b, u)` builds the cut point a
 * fraction u along a -> b.
 */
export function clipRun(run: CutPoint[], edges: RegionEdges, interp: (a: CutPoint, b: CutPoint, u: number) => CutPoint): CutPoint[][] {
  const out: CutPoint[][] = []
  let cur: CutPoint[] | null = null
  const close = () => {
    if (cur && cur.length >= 2) out.push(cur)
    cur = null
  }
  for (let i = 0; i + 1 < run.length; i++) {
    const a = run[i]
    const b = run[i + 1]
    const safe = safeIntervals(a, b, Math.max(a.hw, b.hw), edges)
    if (cur && !(safe.length > 0 && safe[0][0] === 0)) close()
    for (const [u0, u1] of safe) {
      if (!(cur && u0 === 0)) {
        close()
        cur = [u0 === 0 ? a : interp(a, b, u0)]
      }
      ;(cur as CutPoint[]).push(u1 === 1 ? b : interp(a, b, u1))
      if (u1 < 1) close()
    }
  }
  close()
  return out
}

function segSegDist(a: Pt, b: Pt, c: Pt, d: Pt): number {
  if (crossingParam(a, b, c, d) !== null) return 0
  return Math.min(segDist(a, c, d), segDist(b, c, d), segDist(c, a, b), segDist(d, a, b))
}

/**
 * C1: the smallest (inside distance - half-width) along every cut segment.
 * A segment inside the region uses the exact segment-to-edge distance (only
 * edges near enough to lower the worst value are looked at). A segment that
 * leaves it is measured at its ends first; only the segments
 * that could still go deeper than the worst so far (an inside distance moves
 * at most 1 mm per mm along a segment) are searched by branch and bound, to
 * within MARGIN_TOL.
 */
const MARGIN_TOL = 1e-4

export function containmentMargin(runs: CutPoint[][], edges: RegionEdges, step: number): number {
  const signed = (p: Pt, hw: number) => {
    const d = nearestEdgeDistance(p, p, edges, 2 * hw)
    return insideRegion(p, edges) ? d : -d
  }
  // Seed the worst value from every 64th point, so most segments can be
  // settled by a small search box: an edge farther than `cap` cannot lower it.
  let worst = Infinity
  for (const run of runs) for (let i = 0; i < run.length; i += 64) worst = Math.min(worst, signed(run[i], run[i].hw) - run[i].hw)
  const leaving: Array<{ a: Pt; b: Pt; hw: number; ends: number }> = []
  for (const run of runs) {
    for (let i = 0; i + 1 < run.length; i++) {
      const a = run[i]
      const b = run[i + 1]
      const hw = Math.max(a.hw, b.hw)
      if (insideRegion(a, edges)) {
        const cap = Math.max(0, worst + hw)
        let near = Infinity
        for (const e of nearEdges(a, b, edges, cap)) near = Math.min(near, segSegDist(a, b, e.a, e.b))
        if (near > 0) {
          worst = Math.min(worst, near - hw)
          continue
        }
      }
      const ends = Math.min(signed(a, hw), signed(b, hw)) - hw
      worst = Math.min(worst, ends)
      leaving.push({ a, b, hw, ends })
    }
  }
  // Branch and bound along each leaving segment, deepest ends first: a span
  // [u0, u1] cannot go below the mean of its end values minus half its length,
  // so only spans that could beat the worst so far by more than TOL are split.
  leaving.sort((p, q) => p.ends - q.ends)
  for (const { a, b, hw, ends } of leaving) {
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (ends - len / 2 >= worst - MARGIN_TOL) continue
    const at = (u: number) => signed({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u }, hw) - hw
    const stack: Array<[number, number, number, number]> = [[0, 1, at(0), at(1)]]
    while (stack.length > 0) {
      const [u0, u1, v0, v1] = stack.pop() as [number, number, number, number]
      if ((v0 + v1) / 2 - ((u1 - u0) * len) / 2 >= worst - MARGIN_TOL) continue
      const um = (u0 + u1) / 2
      const vm = at(um)
      worst = Math.min(worst, vm)
      if ((u1 - u0) * len > step / 64) stack.push([u0, um, v0, vm], [um, u1, vm, v1])
    }
  }
  return worst
}

/**
 * C2: smallest centre distance between two distinct passes, and the ridge left
 * between them (gap minus both footprint half-widths), measured segment to
 * segment. "Distinct" means another run, or the same run at least `exclude`
 * mm away along the path (half a groove circumference), so a segment's own
 * neighbourhood is never its neighbour. Searched with a uniform grid of
 * `reach`-sized cells up to `reach` mm; nothing within reach -> null.
 */
export function turnGap(runs: CutPoint[][], exclude: number, reach: number): { gap: number; ridge: number } | null {
  if (!(reach > 0)) return null
  const cell = reach
  const grid = new Map<number, number[]>()
  const cellKey = (gx: number, gy: number) => gx * 67_108_864 + gy
  const segRun: number[] = []
  const segIdx: number[] = []
  const segCells: number[][] = []
  const arc: number[][] = runs.map(run => {
    const s = [0]
    for (let i = 1; i < run.length; i++) s.push(s[i - 1] + Math.hypot(run[i].x - run[i - 1].x, run[i].y - run[i - 1].y))
    return s
  })
  // A segment goes into the cell of every point along it at half-cell spacing,
  // so any point of it lies within half a cell of a listed cell, and two
  // segments within `reach` of each other share cells two apart (a long
  // straight segment never floods its whole bounding box).
  runs.forEach((run, r) => {
    for (let i = 0; i + 1 < run.length; i++) {
      const a = run[i]
      const b = run[i + 1]
      const id = segRun.length
      segRun.push(r)
      segIdx.push(i)
      const cells: number[] = []
      const steps = Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (cell / 2))
      for (let k = 0; k <= steps; k++) {
        const u = steps === 0 ? 0 : k / steps
        const gx = Math.floor((a.x + (b.x - a.x) * u) / cell)
        const gy = Math.floor((a.y + (b.y - a.y) * u) / cell)
        const key = cellKey(gx, gy)
        if (cells.length > 0 && cells[cells.length - 2] === gx && cells[cells.length - 1] === gy) continue
        cells.push(gx, gy)
        let bucket = grid.get(key)
        if (!bucket) grid.set(key, (bucket = []))
        if (bucket[bucket.length - 1] !== id) bucket.push(id)
      }
      segCells.push(cells)
    }
  })
  const seen = new Int32Array(segRun.length).fill(-1)
  let gap = Infinity
  let ridge = Infinity
  for (let id = 0; id < segRun.length; id++) {
    const r = segRun[id]
    const i = segIdx[id]
    const a = runs[r][i]
    const b = runs[r][i + 1]
    const hwA = Math.max(a.hw, b.hw)
    const cells = segCells[id]
    for (let c = 0; c < cells.length; c += 2) {
      for (let ox = -2; ox <= 2; ox++) {
        for (let oy = -2; oy <= 2; oy++) {
          for (const other of grid.get(cellKey(cells[c] + ox, cells[c + 1] + oy)) ?? []) {
            if (other <= id || seen[other] === id) continue
            seen[other] = id
            const sr = segRun[other]
            const si = segIdx[other]
            if (sr === r && arc[r][si] - arc[r][i + 1] < exclude) continue
            const p = runs[sr][si]
            const q = runs[sr][si + 1]
            const d = segSegDist(a, b, p, q)
            if (d > reach) continue
            if (d < gap) gap = d
            const rg = d - hwA - Math.max(p.hw, q.hw)
            if (rg < ridge) ridge = rg
          }
        }
      }
    }
  }
  return gap === Infinity ? null : { gap, ridge }
}
