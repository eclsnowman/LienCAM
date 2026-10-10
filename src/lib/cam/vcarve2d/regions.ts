// Closed drawing loops -> carve regions.
//
// A V-carve treats the selection the way a sign-maker reads it: nesting
// alternates. The outermost loops are carved; loops inside them are islands
// (letter counters, or letters standing in a carved field); loops inside
// those are carved again, and so on (even-odd nesting). Outlines that OVERLAP
// - script text, touching letters, a logo drawn in pieces - are welded into
// one region first so the bit never
// re-cuts a shared wall from both sides.
//
// Steps: orient each loop by its nesting parity, non-zero union (welds
// overlapping outers, keeps holes), optional allowance offset, then read the
// nesting tree back as regions (outer + direct holes).

import { loopArea, offsetTree, treeToOrientedLoops, unionNonZeroTree, type Loops, type PolyNode, type Pt } from './clipper'
import type { Region } from './medialAxis'

/** Even-odd nesting depth of every loop. A loop counts as inside another
 *  only when MOST of its vertices are: a partially overlapping outline (two
 *  letters of a script word) is a sibling to be welded, not a hole, however
 *  its first vertex happens to fall. A hole touching the outer still counts. */
function nestingDepths(loops: Loops): number[] {
  const depths = loops.map(() => 0)
  for (let i = 0; i < loops.length; i++) {
    for (let j = 0; j < loops.length; j++) {
      if (i === j) continue
      if (Math.abs(loopArea(loops[j])) <= Math.abs(loopArea(loops[i]))) continue
      let inside = 0
      for (const p of loops[i]) if (pointInLoop(p, loops[j]) || onLoop(p, loops[j], 1e-6)) inside++
      if (inside * 2 > loops[i].length) depths[i]++
    }
  }
  return depths
}

function pointInLoop(p: Pt, loop: Pt[]): boolean {
  let inside = false
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i], b = loop[j]
    if ((a.y > p.y) !== (b.y > p.y)) {
      const x = a.x + ((p.y - a.y) / (b.y - a.y)) * (b.x - a.x)
      if (x > p.x) inside = !inside
    }
  }
  return inside
}

function onLoop(p: Pt, loop: Pt[], eps: number): boolean {
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length]
    const dx = b.x - a.x, dy = b.y - a.y
    const l2 = dx * dx + dy * dy
    let t = l2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2 : 0
    t = t < 0 ? 0 : t > 1 ? 1 : t
    if (Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y) <= eps) return true
  }
  return false
}

function dedupe(loop: Pt[], eps: number): Pt[] {
  const out: Pt[] = []
  for (const p of loop) {
    const last = out[out.length - 1]
    if (last && Math.abs(last.x - p.x) <= eps && Math.abs(last.y - p.y) <= eps) continue
    out.push({ x: p.x, y: p.y })
  }
  while (out.length > 1) {
    const a = out[0], b = out[out.length - 1]
    if (Math.abs(a.x - b.x) <= eps && Math.abs(a.y - b.y) <= eps) out.pop()
    else break
  }
  return out
}

export function treeToRegions(nodes: PolyNode[]): Region[] {
  const regions: Region[] = []
  const walkOuter = (node: PolyNode) => {
    if (node.isHole) { for (const c of node.children) walkOuter(c); return }
    const outer = loopArea(node.contour) > 0 ? node.contour : [...node.contour].reverse()
    const holes: Pt[][] = []
    for (const h of node.children) {
      if (!h.isHole) { walkOuter(h); continue }
      holes.push(loopArea(h.contour) < 0 ? h.contour : [...h.contour].reverse())
      for (const inner of h.children) walkOuter(inner)
    }
    regions.push({ outer, holes })
  }
  for (const n of nodes) walkOuter(n)
  return regions
}

export interface BuildRegionsOptions {
  /** Signed outline offset (mm): positive grows the carved area. */
  allowanceMm?: number
  /** Chord tolerance for round offset joins (mm). */
  arcTol?: number
  /** Loops with less than this absolute area (mm^2) are ignored as noise. */
  minAreaMm2?: number
}

/**
 * Turn closed loops into welded, nested carve regions. Requires the V-carve
 * clipper module to be ready (the worker awaits it before calling).
 */
export function buildRegions(loops: Loops, opts: BuildRegionsOptions = {}): Region[] {
  const minArea = opts.minAreaMm2 ?? 1e-6
  const clean = loops.map(l => dedupe(l, 1e-9)).filter(l => l.length >= 3 && Math.abs(loopArea(l)) > minArea)
  if (clean.length === 0) return []
  const depths = nestingDepths(clean)
  const oriented: Loops = clean.map((loop, i) => {
    const wantCCW = depths[i] % 2 === 0
    return (loopArea(loop) > 0) === wantCCW ? loop : [...loop].reverse()
  })
  let tree = unionNonZeroTree(oriented)
  const allowance = opts.allowanceMm ?? 0
  if (allowance !== 0 && tree.length > 0) {
    tree = offsetTree(treeToOrientedLoops(tree), allowance, opts.arcTol ?? 0.01)
  }
  return treeToRegions(tree)
}

/** Oriented loops (outer CCW + holes CW) of one region, for clipper calls. */
export function regionLoops(region: Region): Loops {
  return [region.outer, ...region.holes]
}

/** Inward offset of a region by `inset`; returns the resulting regions
 *  (a concave region may split into several, or vanish). */
export function insetRegion(region: Region, inset: number, arcTol = 0.01): Region[] {
  if (inset <= 0) return [region]
  return treeToRegions(offsetTree(regionLoops(region), -inset, arcTol))
}

/** Bounding box of a region's outer contour. */
export function regionBounds(region: Region): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of region.outer) {
    if (p.x < minX) minX = p.x; if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y; if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

/** Point containment in a region (inside outer, outside every hole). */
export function regionContains(region: Region, p: Pt): boolean {
  if (!pointInLoop(p, region.outer)) return false
  for (const h of region.holes) if (pointInLoop(p, h)) return false
  return true
}

/** Total perimeter of a region (outer + holes), for sample budgeting. */
export function regionPerimeter(region: Region): number {
  let len = 0
  for (const c of regionLoops(region)) {
    for (let i = 0; i < c.length; i++) {
      const a = c[i], b = c[(i + 1) % c.length]
      len += Math.hypot(b.x - a.x, b.y - a.y)
    }
  }
  return len
}
