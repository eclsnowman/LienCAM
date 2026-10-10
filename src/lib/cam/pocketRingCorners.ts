// pocketRingCorners.ts - WO-2296: Pocket's clearing rings take their corners as arcs.
//
// A clearing ring's convex corners are sharp: an inward offset keeps every
// convex vertex pointed whatever the join type. A machine with modest
// acceleration stops at each one. With Rounded ring corners on, each such corner
// becomes a circular arc tangent to both of its edges, turning the way the ring
// turns, so the machine carries speed through it.
//
// What an arc skips. The arc pulls the cutter's centre in from the vertex, so
// the tip of the corner the sharp ring swept is no longer swept by this ring.
// On an interior ring the ring outside it already passes there (one stepover
// out, one tool radius wide), and in outside-in order it has already cut it. A
// corner is rounded only where that is PROVEN: every point the sharp corner swept
// and the arc does not must lie within one tool radius of another ring's cut
// path. A corner the proof fails for rounds smaller, down to sharp. The wall
// ring has nothing outside it, so its corners always stay sharp: the last
// material in a wall corner can only be reached by a cutter centre passing
// through the vertex along both edges - any clean-up of a rounded wall corner
// contains that same stop plus extra travel, so the sharp corner is the cheapest
// path that leaves nothing.
//
// Premise and method from PureCutCNC (Apache-2.0, Copyright 2026 Franja (Frank)
// Povazanj): offsetSmoothing.ts (a fillet on the emitted ring only, the offsets
// still computed from the exact region) and sweptCoverage.ts (a point is
// machined exactly when it lies within one tool radius of a cut centreline).
// Written for LienCAM: Y-up, mm, Pocket's own rings and island keep-outs; no
// PureCutCNC code is copied.
//
// Pure: no store, no clipper. Off is the caller not calling it.

import { CURVE_VERTEX_MAX_DEG } from '../simulation/achievableFeed'

type Pt = { x: number; y: number }

const DEG = Math.PI / 180

/** A vertex turning more than this is a corner; less is a sample of a curve -
 *  the cut-time model's own line (CURVE_VERTEX_MAX_DEG). */
export const RING_CORNER_MIN_TURN_DEG = CURVE_VERTEX_MAX_DEG
/** Each emitted arc sample turns at most this, so the arc reads as a curve. */
export const RING_CORNER_ARC_STEP_DEG = 4.5
/** A near-reversal is not a corner a fillet can serve. */
const MAX_TURN_DEG = 179
/** Radii tried, as fractions of the request, before a corner keeps its point. */
const RADIUS_LADDER = [1, 0.5, 0.25, 0.125] as const
const SAME_POINT = 1e-7

/** One convex vertex of a ring, a candidate for an arc. */
export interface RingCorner {
  /** Vertex index in the ring. */
  index: number
  vertex: Pt
  /** Turn at the vertex, radians, in (min turn, 179 deg]. */
  turn: number
  /** True when the ring turns counterclockwise here (Y-up). */
  left: boolean
  /** Largest radius whose tangent points stay on the half of each edge next to
   *  the vertex, so neighbouring corners never compete for one edge. */
  maxRadius: number
}

/** The arc that replaces a corner: tangent to both edges at entry and exit. */
export interface CornerArc {
  corner: RingCorner
  radius: number
  entry: Pt
  exit: Pt
  centre: Pt
  /** entry, the arc samples, exit - in ring order. */
  points: Pt[]
}

function signedArea(ring: readonly Pt[]): number {
  let area = 0
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    area += a.x * b.y - b.x * a.y
  }
  return area / 2
}

/**
 * The ring's convex corners: vertices turning more than the curve-sample limit
 * in the ring's own winding direction (left on a counterclockwise ring, right
 * on a clockwise one). A vertex turning against the winding is reflex - an arc
 * there would bulge outward, toward the wall - and is never a candidate.
 */
export function ringCorners(ring: readonly Pt[]): RingCorner[] {
  const n = ring.length
  if (n < 3) return []
  const area = signedArea(ring)
  if (Math.abs(area) < 1e-12) return []
  const out: RingCorner[] = []
  for (let i = 0; i < n; i++) {
    const prev = ring[(i - 1 + n) % n], vertex = ring[i], next = ring[(i + 1) % n]
    const ax = vertex.x - prev.x, ay = vertex.y - prev.y
    const bx = next.x - vertex.x, by = next.y - vertex.y
    const la = Math.hypot(ax, ay), lb = Math.hypot(bx, by)
    if (la < 1e-9 || lb < 1e-9) continue
    const cross = ax * by - ay * bx
    const turn = Math.atan2(Math.abs(cross), ax * bx + ay * by)
    if (turn <= RING_CORNER_MIN_TURN_DEG * DEG || turn > MAX_TURN_DEG * DEG) continue
    const left = cross > 0
    if (left !== area > 0) continue
    out.push({ index: i, vertex, turn, left, maxRadius: 0.5 * Math.min(la, lb) / Math.tan(turn / 2) })
  }
  return out
}

/** The arc of `radius` at `corner` (radius must not exceed corner.maxRadius). */
export function cornerArc(ring: readonly Pt[], corner: RingCorner, radius: number): CornerArc {
  const n = ring.length
  const prev = ring[(corner.index - 1 + n) % n], vertex = corner.vertex, next = ring[(corner.index + 1) % n]
  const la = Math.hypot(vertex.x - prev.x, vertex.y - prev.y)
  const lb = Math.hypot(next.x - vertex.x, next.y - vertex.y)
  const uIn = { x: (vertex.x - prev.x) / la, y: (vertex.y - prev.y) / la }
  const uOut = { x: (next.x - vertex.x) / lb, y: (next.y - vertex.y) / lb }
  const setback = radius * Math.tan(corner.turn / 2)
  const entry = { x: vertex.x - uIn.x * setback, y: vertex.y - uIn.y * setback }
  const exit = { x: vertex.x + uOut.x * setback, y: vertex.y + uOut.y * setback }
  // The centre sits on the side the ring turns toward: left of the incoming edge
  // for a counterclockwise turn, right of it for a clockwise one (Y-up).
  const normal = corner.left ? { x: -uIn.y, y: uIn.x } : { x: uIn.y, y: -uIn.x }
  const centre = { x: entry.x + normal.x * radius, y: entry.y + normal.y * radius }
  const start = Math.atan2(entry.y - centre.y, entry.x - centre.x)
  const sweep = corner.left ? corner.turn : -corner.turn
  const steps = Math.max(1, Math.ceil(corner.turn / (RING_CORNER_ARC_STEP_DEG * DEG)))
  const points: Pt[] = [entry]
  for (let k = 1; k < steps; k++) {
    const angle = start + sweep * k / steps
    points.push({ x: centre.x + radius * Math.cos(angle), y: centre.y + radius * Math.sin(angle) })
  }
  points.push(exit)
  return { corner, radius, entry, exit, centre, points }
}

/**
 * The ring with each corner whose radius is above zero replaced by its arc.
 * With no radius above zero the very same array is returned, so a ring nothing
 * changed on stays the object every other part of Pocket already knows.
 */
export function roundRing(ring: Pt[], corners: readonly RingCorner[], radii: readonly number[]): Pt[] {
  if (!radii.some(r => r > 0)) return ring
  const arcAt = new Map<number, CornerArc>()
  corners.forEach((corner, k) => { if (radii[k] > 0) arcAt.set(corner.index, cornerArc(ring, corner, radii[k])) })
  const out: Pt[] = []
  const push = (p: Pt) => {
    const last = out[out.length - 1]
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > SAME_POINT) out.push(p)
  }
  for (let i = 0; i < ring.length; i++) {
    const arc = arcAt.get(i)
    if (arc) for (const p of arc.points) push(p)
    else push(ring[i])
  }
  while (out.length > 1 &&
    Math.hypot(out[0].x - out[out.length - 1].x, out[0].y - out[out.length - 1].y) <= SAME_POINT) out.pop()
  return out
}

// -- Swept coverage ----------------------------------------------------------
//
// A point is cut when it lies within one tool radius of a cut path. Segments are
// bucketed into a grid one reach wide, each registered in every cell its
// reach-expanded box touches, so any segment within reach of a point is listed
// in that point's own cell.

interface Seg { ax: number; ay: number; bx: number; by: number }

function distToSeg(x: number, y: number, s: Seg): number {
  const dx = s.bx - s.ax, dy = s.by - s.ay
  const lenSq = dx * dx + dy * dy
  let t = lenSq < 1e-18 ? 0 : ((x - s.ax) * dx + (y - s.ay) * dy) / lenSq
  t = t < 0 ? 0 : t > 1 ? 1 : t
  return Math.hypot(s.ax + t * dx - x, s.ay + t * dy - y)
}

class SweptIndex {
  private readonly cells = new Map<string, Seg[]>()
  private readonly reach: number
  constructor(reach: number) { this.reach = reach }

  private key(ix: number, iy: number): string { return `${ix},${iy}` }

  add(seg: Seg): void {
    const r = this.reach
    const ix0 = Math.floor((Math.min(seg.ax, seg.bx) - r) / r), ix1 = Math.floor((Math.max(seg.ax, seg.bx) + r) / r)
    const iy0 = Math.floor((Math.min(seg.ay, seg.by) - r) / r), iy1 = Math.floor((Math.max(seg.ay, seg.by) + r) / r)
    for (let ix = ix0; ix <= ix1; ix++) {
      for (let iy = iy0; iy <= iy1; iy++) {
        const k = this.key(ix, iy)
        const list = this.cells.get(k)
        if (list) list.push(seg); else this.cells.set(k, [seg])
      }
    }
  }

  /** True when some segment lies within `limit` (<= reach) of (x, y). */
  within(x: number, y: number, limit: number): boolean {
    const list = this.cells.get(this.key(Math.floor(x / this.reach), Math.floor(y / this.reach)))
    if (!list) return false
    for (const s of list) if (distToSeg(x, y, s) <= limit) return true
    return false
  }
}

function pointInPolygon(p: Pt, poly: readonly Pt[]): boolean {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[i], b = poly[j]
    if ((a.y > p.y) !== (b.y > p.y) && p.x < (b.x - a.x) * (p.y - a.y) / (b.y - a.y) + a.x) inside = !inside
  }
  return inside
}

/** Add a closed ring's cut path, leaving out every stretch that lies inside an
 *  island keep-out (the ring cutter never feeds there). */
function addCutRing(index: SweptIndex, ring: readonly Pt[], islands: readonly Pt[][], piece: number): void {
  const inIsland = (p: Pt) => islands.some(island => pointInPolygon(p, island))
  for (let i = 0; i < ring.length; i++) {
    const a = ring[i], b = ring[(i + 1) % ring.length]
    const len = Math.hypot(b.x - a.x, b.y - a.y)
    if (len < 1e-12) continue
    const parts = islands.length > 0 ? Math.max(1, Math.ceil(len / piece)) : 1
    for (let k = 0; k < parts; k++) {
      const p = { x: a.x + (b.x - a.x) * k / parts, y: a.y + (b.y - a.y) * k / parts }
      const q = { x: a.x + (b.x - a.x) * (k + 1) / parts, y: a.y + (b.y - a.y) * (k + 1) / parts }
      if (islands.length > 0) {
        const mid = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }
        if (inIsland(p) || inIsland(q) || inIsland(mid)) continue
      }
      index.add({ ax: p.x, ay: p.y, bx: q.x, by: q.y })
    }
  }
}

function cross(ax: number, ay: number, bx: number, by: number): number { return ax * by - ay * bx }

function distToRay(x: number, y: number, o: Pt, through: Pt): number {
  const dx = through.x - o.x, dy = through.y - o.y
  const lenSq = dx * dx + dy * dy
  const t = Math.max(0, ((x - o.x) * dx + (y - o.y) * dy) / lenSq)
  return Math.hypot(o.x + t * dx - x, o.y + t * dy - y)
}

/**
 * True when everything the sharp corner sweeps and its arc does not is swept by
 * some other cut path in `all` - within `toolRadius - h`, sampled on an h grid.
 *
 * The material in question lies in the arc's sector, outside its circle (beyond
 * the arc toward the vertex). Every grid point within h of that region whose
 * stub distance is within reach and that its own ring does not already reach is
 * checked; a point of the true region then lies within 0.71 h of a checked
 * point that another path reaches with h to spare, so it is reached too.
 */
function skipIsCovered(
  arc: CornerArc, own: SweptIndex, all: SweptIndex, toolRadius: number, h: number,
): boolean {
  const vertex = arc.corner.vertex
  const stub: Seg[] = [
    { ax: arc.entry.x, ay: arc.entry.y, bx: vertex.x, by: vertex.y },
    { ax: vertex.x, ay: vertex.y, bx: arc.exit.x, by: arc.exit.y },
  ]
  const R = toolRadius
  const c = arc.centre
  const sign = arc.corner.left ? 1 : -1
  const e1x = arc.entry.x - c.x, e1y = arc.entry.y - c.y
  const e2x = arc.exit.x - c.x, e2y = arc.exit.y - c.y
  const reach = R + h
  const minX = Math.min(arc.entry.x, vertex.x, arc.exit.x) - reach
  const maxX = Math.max(arc.entry.x, vertex.x, arc.exit.x) + reach
  const minY = Math.min(arc.entry.y, vertex.y, arc.exit.y) - reach
  const maxY = Math.max(arc.entry.y, vertex.y, arc.exit.y) + reach
  for (let x = minX; x <= maxX + 1e-12; x += h) {
    for (let y = minY; y <= maxY + 1e-12; y += h) {
      const qx = x - c.x, qy = y - c.y
      if (Math.hypot(qx, qy) <= arc.radius - h) continue
      const inSector = sign * cross(e1x, e1y, qx, qy) >= 0 && sign * cross(qx, qy, e2x, e2y) >= 0
      if (!inSector && distToRay(x, y, c, arc.entry) > h && distToRay(x, y, c, arc.exit) > h) continue
      if (Math.min(distToSeg(x, y, stub[0]), distToSeg(x, y, stub[1])) > reach) continue
      if (own.within(x, y, R - h)) continue
      if (!all.within(x, y, R - h)) return false
    }
  }
  return true
}

export interface RoundRingsOptions {
  toolRadius: number
  /** Arc radius asked for; default the tool radius. */
  radius?: number
  /** Expanded island keep-outs: the ring cutter never feeds inside them. */
  islands?: Pt[][]
  /** Proof grid, mm; default toolRadius / 30 within [0.02, 0.1]. */
  grid?: number
}

/**
 * Round the corners of every ring of every generation where the rings around
 * them take what the arc skips. Returns generations of the same shape; a ring
 * with no rounded corner is the very same array object. Each corner starts at
 * the requested radius (or the largest its edges allow) and steps down the
 * ladder while the proof fails, ending sharp; a corner whose sharp corner or arc
 * touches an island keep-out stays sharp (the ring bridges around islands there).
 */
export function roundPocketRingCorners(generations: Pt[][][], options: RoundRingsOptions): Pt[][][] {
  const R = options.toolRadius
  if (!(R > 0)) return generations
  const request = options.radius ?? R
  const islands = options.islands ?? []
  const h = options.grid ?? Math.min(0.1, Math.max(0.02, R / 30))
  const minRadius = 0.1 * R
  const inIsland = (p: Pt) => islands.some(island => pointInPolygon(p, island))

  interface RingState { ring: Pt[]; corners: RingCorner[]; radii: number[]; rung: number[] }
  const states: RingState[][] = generations.map(gen => gen.map(ring => {
    const corners = ringCorners(ring)
    const rung = corners.map(() => 0)
    const radii = corners.map(corner => {
      const r = Math.min(request, corner.maxRadius)
      if (r < minRadius) return 0
      if (islands.length > 0) {
        const arc = cornerArc(ring, corner, r)
        const probe = [...arc.points, arc.corner.vertex]
        for (const [a, b] of [[arc.entry, corner.vertex], [corner.vertex, arc.exit]] as const) {
          const parts = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / h))
          for (let k = 1; k < parts; k++) probe.push({ x: a.x + (b.x - a.x) * k / parts, y: a.y + (b.y - a.y) * k / parts })
        }
        if (probe.some(inIsland)) return 0
      }
      return r
    })
    return { ring, corners, radii, rung }
  }))

  const piece = Math.max(h, R / 2)
  for (let pass = 0; pass < 64; pass++) {
    const rounded = states.map(gen => gen.map(s => roundRing(s.ring, s.corners, s.radii)))
    const all = new SweptIndex(R)
    for (const gen of rounded) for (const ring of gen) addCutRing(all, ring, islands, piece)
    let failed = false
    states.forEach((gen, g) => gen.forEach((s, k) => {
      if (!s.radii.some(r => r > 0)) return
      const own = new SweptIndex(R)
      addCutRing(own, rounded[g][k], islands, piece)
      s.corners.forEach((corner, c) => {
        if (s.radii[c] <= 0) return
        const arc = cornerArc(s.ring, corner, s.radii[c])
        if (skipIsCovered(arc, own, all, R, h)) return
        failed = true
        s.rung[c]++
        const next = s.rung[c] < RADIUS_LADDER.length
          ? Math.min(request * RADIUS_LADDER[s.rung[c]], corner.maxRadius) : 0
        s.radii[c] = next >= minRadius ? next : 0
      })
    }))
    if (!failed) return rounded
  }
  return generations
}
