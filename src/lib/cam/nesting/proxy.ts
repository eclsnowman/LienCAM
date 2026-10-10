/* The spacing PROXY ring every NFP / placement pass works on (WO-2480).
 *
 * A part is placed by its proxy: the source outline, simplified (simplify.ts)
 * and grown by half the part gap, so two proxies in contact leave the full gap
 * between the real outlines. That only holds if the proxy CONTAINS the real
 * outline grown by half the gap, and two approximations used to break it:
 *
 *  - simplification chords convex detail INWARD (a gear tooth tip sits up to the
 *    curve tolerance outside its simplified ring), and
 *  - clipper flattens each round-join arc into chords lying up to the offset's
 *    arc tolerance INSIDE the true arc.
 *
 * Both made the proxy slightly smaller than the clearance it stands for. The
 * independent final validator (placementSafety.ts) measures the REAL outlines,
 * so it then rejected poses the search had settled on: on the WO-2381 kit sheet
 * the gears came out 7.967 mm apart and a soft jaw 7.981 mm from a toe clamp
 * against an 8 mm gap, and those parts were reported unplaced though they fit.
 *
 * Now each simplified edge is pushed out by exactly as far as the real outline
 * crosses it (enclosingRing) - only that edge, only outward - so the ring the
 * offset grows contains the real outline, and every arc chord of the offset is
 * replaced by the two tangents that enclose its arc (circumscribeArcs). A pose
 * the search accepts is a pose the validator accepts. Edges simplification kept
 * and detail it removed from the INSIDE (a notch) add nothing: those stay exactly
 * half the gap out, as before (common-edge pairing depends on that, and a growth
 * applied everywhere refused neighbours that fit - WO-2480 audits). The gap
 * itself, the validator and its tolerance are as they were.
 */

import type { Vec2 } from '../../../types/index'
import { ensureCCW } from '../geometry'
import { offsetClosed } from '../adaptiveClearing2d/engine/clipperEngine'
import { polygonArea } from './geometry'
import { simplifyRing } from './simplify'

/** Arc flattening for the spacing offset. Each chord then gains a tangent point
 *  (circumscribeArcs), so arcs are drawn with half the chords offsetClosed's
 *  0.02 default would use and the ring keeps about the vertex count - the NFP
 *  orbit's cost - it had before; corners reserve at most about this much extra. */
const OFFSET_ARC_TOLERANCE = 0.08
/** A chord dipping less than this inside the offset distance is left alone. */
const CHORD_DIP_EPSILON = 1e-4
/** Clearance shortfall the final check ignores: clipper rounds to 0.1 micron and
 *  the validator allows 0.01 mm (placementSafety.ts). */
const SHORTFALL_EPSILON = 1e-3
/** A pushed-out corner further than this many times its push from the original
 *  vertex (nearly parallel neighbouring edges) is cut by a bevel instead. */
const MITER_LIMIT = 4

function closestOnSegment(p: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  const t = len2 <= 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2))
  return { x: a.x + t * dx, y: a.y + t * dy }
}

/** Nearest point to `p` on the closed ring's boundary, its distance, and the
 *  index of the edge (ring[i] -> ring[i + 1]) it lies on. */
function nearestOnRing(p: Vec2, ring: Vec2[]): { point: Vec2; distance: number; edge: number } {
  let point = ring[0]
  let distance = Infinity
  let edge = 0
  for (let i = 0; i < ring.length; i++) {
    const q = closestOnSegment(p, ring[i], ring[(i + 1) % ring.length])
    const d = Math.hypot(q.x - p.x, q.y - p.y)
    if (d < distance) {
      distance = d
      point = q
      edge = i
    }
  }
  return { point, distance, edge }
}

/** Even-odd ray cast; a point on the boundary may land either side. */
function inside(p: Vec2, ring: Vec2[]): boolean {
  let c = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i]
    const b = ring[j]
    if (a.y > p.y !== b.y > p.y && p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x) c = !c
  }
  return c
}

/** Distance from `p` to the ring's boundary: positive inside, negative outside. */
function signedDistance(p: Vec2, ring: Vec2[]): number {
  const d = nearestOnRing(p, ring).distance
  return inside(p, ring) ? d : -d
}

/**
 * How much room the proxy leaves around the real outline: the smallest distance
 * between the two boundaries, negative where the outline pokes out of the proxy
 * or the proxy dips into the outline. Two boundaries that do not cross are
 * closest at a vertex of one against an edge of the other, so checking the
 * vertices both ways covers it.
 */
export function proxyClearance(source: Vec2[], proxy: Vec2[]): number {
  let worst = Infinity
  for (const p of source) worst = Math.min(worst, signedDistance(p, proxy))
  for (const q of proxy) worst = Math.min(worst, -signedDistance(q, source))
  return worst
}

/** Largest loop of an offset result; throws on empty rather than degrading. */
function largestLoop(loops: Vec2[][]): Vec2[] {
  if (loops.length === 0) {
    throw new Error('nesting: spacing offset produced no loop (part too small for partGap)')
  }
  let best = loops[0]
  let bestArea = Math.abs(polygonArea(best))
  for (let i = 1; i < loops.length; i++) {
    const a = Math.abs(polygonArea(loops[i]))
    if (a > bestArea) {
      best = loops[i]
      bestArea = a
    }
  }
  return best
}

/**
 * The simplified ring with each edge moved out, parallel, by as far as the real
 * outline it replaced crosses it - so the result contains the real outline.
 * Edges the outline never crosses (kept edges, detail removed from the inside)
 * stay put, and a ring that needs no push comes back as `simple` itself. RDP
 * keeps source vertices, so each simplified edge's source run is known; a source
 * vertex still outside after the first push (it overhangs a neighbouring edge at
 * a corner) pushes the edge it is nearest to, for a few rounds. Whatever is still
 * short after that is caught by spacingProxy's clearance check.
 */
function enclosingRing(source: Vec2[], simple: Vec2[]): Vec2[] {
  const m = simple.length
  const at: number[] = []
  const start = source.indexOf(simple[0])
  if (start < 0) return simple
  for (let i = 0, j = 0; i < source.length && j < m; i++) {
    if (source[(start + i) % source.length] === simple[j]) at[j++] = (start + i) % source.length
  }
  if (at.length !== m) return simple

  // outward unit normal of each simplified edge, either winding (polygonArea is
  // SVGnest-signed: negative for a counter-clockwise ring)
  const sign = polygonArea(simple) < 0 ? 1 : -1
  const dir: Vec2[] = []
  const normal: Vec2[] = []
  for (let k = 0; k < m; k++) {
    const a = simple[k]
    const b = simple[(k + 1) % m]
    const len = Math.hypot(b.x - a.x, b.y - a.y) || 1
    dir.push({ x: (b.x - a.x) / len, y: (b.y - a.y) / len })
    normal.push({ x: (sign * (b.y - a.y)) / len, y: (-sign * (b.x - a.x)) / len })
  }
  const beyond = (p: Vec2, k: number) => (p.x - simple[k].x) * normal[k].x + (p.y - simple[k].y) * normal[k].y

  const push = new Array<number>(m).fill(0)
  for (let k = 0; k < m; k++) {
    for (let i = (at[k] + 1) % source.length; i !== at[(k + 1) % m]; i = (i + 1) % source.length) {
      push[k] = Math.max(push[k], beyond(source[i], k))
    }
  }

  let ring = simple
  for (let round = 0; round < 4; round++) {
    if (push.every((d) => d === 0)) return simple
    // owners[v]: the simplified edges whose (pushed) line ring vertex v lies on;
    // the ring edge v -> v+1 belongs to the edges both ends share
    const owners: number[][] = []
    const out: Vec2[] = []
    for (let k = 0; k < m; k++) {
      const prev = (k + m - 1) % m
      const s = simple[k]
      if (push[prev] === 0 && push[k] === 0) {
        out.push(s)
        owners.push([prev, k])
        continue
      }
      const p1 = { x: s.x + push[prev] * normal[prev].x, y: s.y + push[prev] * normal[prev].y }
      const p2 = { x: s.x + push[k] * normal[k].x, y: s.y + push[k] * normal[k].y }
      const cross = dir[prev].x * dir[k].y - dir[prev].y * dir[k].x
      const t = Math.abs(cross) < 1e-9 ? Infinity : ((p2.x - p1.x) * dir[k].y - (p2.y - p1.y) * dir[k].x) / cross
      const miter = { x: p1.x + t * dir[prev].x, y: p1.y + t * dir[prev].y }
      if (Number.isFinite(t) && Math.hypot(miter.x - s.x, miter.y - s.y) <= MITER_LIMIT * Math.max(push[prev], push[k])) {
        out.push(miter)
        owners.push([prev, k])
      } else {
        out.push(p1, p2)
        owners.push([prev, k], [prev, k])
      }
    }
    ring = out
    let moved = false
    for (const p of source) {
      if (signedDistance(p, ring) >= -1e-9) continue
      const { edge } = nearestOnRing(p, ring)
      const shared = owners[edge].filter((k) => owners[(edge + 1) % ring.length].includes(k))
      for (const k of shared.length > 0 ? shared : owners[edge]) {
        if (beyond(p, k) > push[k] + 1e-9) {
          push[k] = beyond(p, k)
          moved = true
        }
      }
    }
    if (!moved) return ring
  }
  return ring
}

/**
 * The proxy ring for a source outline: simplified to `curveTol`, its edges moved
 * out over whatever the simplification shaved off (enclosingRing), grown by
 * `grow` (half the part gap) with arcs enclosed, normalised to geometric CCW
 * (the winding the NFP orbit needs - see packNest). A simplified outline's proxy
 * is then measured against the real outline; should it still come up short
 * anywhere, the shortfall is added to the growth. An outline that is neither
 * simplified nor grown comes back as its own CCW ring.
 */
export function spacingProxy(outer: Vec2[], grow: number, curveTol: number): Vec2[] {
  const simple = simplifyRing(outer, curveTol)
  const hull = simple === outer ? simple : enclosingRing(outer, simple)
  let extra = 0
  let raw = hull
  for (let round = 0; round < 3; round++) {
    const reach = grow + extra
    raw = reach > 0 ? circumscribeArcs(largestLoop(offsetClosed([hull], reach, OFFSET_ARC_TOLERANCE)), hull, reach) : hull
    if (simple === outer) break // nothing was simplified away: the offset of the outline itself
    const shortfall = grow - proxyClearance(outer, raw)
    if (shortfall <= SHORTFALL_EPSILON) break
    extra += shortfall
  }
  return ensureCCW(raw)
}

/**
 * An offset ring with every round-join arc enclosed rather than inscribed. A
 * flattened arc's chord runs closer to the source than `reach`; its two ends
 * sit on the arc about the source point nearest the chord's midpoint, so the
 * tangents at those ends meet on that bisector at reach^2 / dip from the centre.
 * Inserting that point puts the whole arc inside the ring. Chords that already
 * keep `reach` (straight edges, concave joins) are untouched.
 */
function circumscribeArcs(offset: Vec2[], source: Vec2[], reach: number): Vec2[] {
  const out: Vec2[] = []
  for (let i = 0; i < offset.length; i++) {
    const a = offset[i]
    const b = offset[(i + 1) % offset.length]
    out.push(a)
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }
    const { point: centre, distance: dip } = nearestOnRing(mid, source)
    if (dip <= 0 || reach - dip <= CHORD_DIP_EPSILON) continue
    const scale = (reach * reach) / (dip * dip)
    out.push({ x: centre.x + (mid.x - centre.x) * scale, y: centre.y + (mid.y - centre.y) * scale })
  }
  return out
}
