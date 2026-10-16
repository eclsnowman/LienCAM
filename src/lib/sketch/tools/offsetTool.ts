// Sketch offset tool (Stage 6 chunk 2, PLAN.md 3.5 MODIFY v1).
//
// Armed tool with a distance input in the toolbox (default 2 mm). First
// click picks an entity and SELECTS its whole chain (the bake's
// coincident-endpoint chaining via chainContaining — what you offset is
// exactly what would bake as one loop). The preview then follows the
// cursor: the offset lands on the SIDE of the chain the cursor is on.
// The second click commits the offset as NEW entities.
//
// GEOMETRY POLICY (documented; the tests assert it):
//   - every entity is offset EXACTLY: a line offsets to a parallel line,
//     an arc to a concentric arc (radius +/- d), a circle to a concentric
//     circle. No tessellation, no re-fit — the v1 entity set (line/arc/
//     circle) offsets exactly in closed form, so the PLAN's
//     "clipper2 + re-fit arcs" tessellation path is reserved for future
//     curve types (splines) that have no exact offset.
//   - corners where consecutive offsets DIVERGE (the convex side) are
//     joined with a fillet arc of radius d centered on the original
//     corner — the true offset of a corner point.
//   - corners where consecutive offsets OVERLAP (the concave side) are
//     trimmed to their exact intersection; an offset too large to trim
//     (a piece collapses) is rejected with a notice, never emitted
//     self-intersected.
//   - tangent (smooth) joints stay tangent: endpoints are snapped exactly.
//   - a closed result is also checked AS A WHOLE (WO-1475): across a narrow
//     neck two non-adjacent pieces can cross while every corner trims
//     cleanly. Any crossing - or a local collapse - rebuilds the offset from
//     the untrimmed raw curve and keeps exactly the parts at the full
//     distance from the source, so a collapsed neck publishes its disjoint
//     regions as separate loops. A result that does not close into clean,
//     non-touching loops is refused, never emitted self-intersected.
//
// CONSTRAINTS: the new chain carries coincident constraints at its OWN
// joints (so it stays a chain through future solves) but NO constraints
// to the source -- a parametric offset constraint is out of scope
// for v1 (noted in PLAN 3.5). Construction entities never chain or
// offset (same exclusion as the bake).
//
// ASSOCIATIVITY (WO-1859, strengthened by WO-2616): offsetLink stores the
// source chain, distance, side and generated joint ownership. The staged
// dependency solver solves the source, evaluates THIS computeOffset, then
// solves downstream geometry against the result. Copy drags do not move;
// incompatible driving constraints are refused with Edit/Break guidance.
// Pure replay helpers remain available to preview distance/source edits. Their
// notes explain topology changes; the solver never publishes a stale offset
// when its stored piece topology can no longer represent the result.
//
// PURE module following the toolMachine pattern: clicks RETURN a commit;
// the store applies it as one undo step.

import type {
  Vec2,
  OffsetSourceRef,
  SketchEntity,
  SketchCircleEntity,
  SketchConstraint,
  SketchOffsetLink,
} from '../types'
import { chainContaining, type ChainStep } from '../bake'

const TWO_PI = Math.PI * 2
const EPS_JOIN = 1e-6 // mm: offset endpoints closer than this are one joint
const EPS_LEN = 1e-6  // mm: a trimmed piece may not collapse below this
const EPS_TURN = 1e-9 // |cross|: smaller = the joint is tangent/straight

function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function cross(a: Vec2, b: Vec2): number {
  return a.x * b.y - a.y * b.x
}

// ---- Chain state (CHAINING payload) -----------------------------------------

/** The selected offset source. Chains hold entity SNAPSHOTS (the chain is
 *  transient tool state; committing reads only these snapshots). */
export type OffsetSource =
  | { kind: 'chain'; steps: ChainStep[]; closed: boolean }
  | { kind: 'circle'; circle: SketchCircleEntity }

export interface OffsetChainState {
  kind: 'offset'
  source: OffsetSource
  /** Side locked by the second click (+1 = left of traversal, -1 =
   *  right); null while the cursor still chooses the side live. A
   *  locked side puts the flow in the confirm-overlay phase. */
  lockedSide: 1 | -1 | null
}

export interface OffsetClickOutcome {
  chain: OffsetChainState | null
  notice: string | null
}

// ---- Picking ------------------------------------------------------------------

function segDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function arcSweep(startAngle: number, endAngle: number): number {
  const s = norm(endAngle - startAngle)
  return s < 1e-12 ? TWO_PI : s
}

function curveDistance(e: SketchEntity, p: Vec2): number | null {
  switch (e.kind) {
    case 'point':
      return null
    case 'line':
      return segDistance(p, e.start, e.end)
    case 'circle':
      return Math.abs(dist(p, e.center) - e.radius)
    case 'arc': {
      const ang = norm(Math.atan2(p.y - e.center.y, p.x - e.center.x) - e.startAngle)
      if (ang <= arcSweep(e.startAngle, e.endAngle)) {
        return Math.abs(dist(p, e.center) - e.radius)
      }
      const s = arcPointAt(e.center, e.radius, e.startAngle)
      const en = arcPointAt(e.center, e.radius, e.endAngle)
      return Math.min(dist(p, s), dist(p, en))
    }
    // v1: ellipse/spline/text offset has no closed form; not offsettable.
    case 'ellipse':
    case 'elliptical-arc':
    case 'spline':
    case 'text':
    case 'block':
      return null
  }
}

function pickCurve(
  entities: readonly SketchEntity[], world: Vec2, tol: number,
): SketchEntity | null {
  let best: { e: SketchEntity; d: number } | null = null
  for (const e of entities) {
    if (e.kind === 'point') continue
    const d = curveDistance(e, world)
    if (d !== null && d <= tol && (!best || d < best.d)) best = { e, d }
  }
  return best?.e ?? null
}

function arcPointAt(center: Vec2, radius: number, angle: number): Vec2 {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }
}

// ---- Side resolution ------------------------------------------------------------

/** Which side of the chain the cursor is on: +1 = LEFT of the traversal
 *  direction, -1 = right. Found at the chain point nearest the cursor. */
export function chainSide(source: OffsetSource, cursor: Vec2): 1 | -1 {
  if (source.kind === 'circle') {
    // Inside the circle = shrink, outside = grow (handled by sign in
    // computeOffset: a CCW circle's left is inward).
    return dist(cursor, source.circle.center) < source.circle.radius ? 1 : -1
  }
  let best: { d: number; tangent: Vec2; at: Vec2 } | null = null
  for (const s of source.steps) {
    const e = s.entity
    if (e.kind === 'line') {
      const dx = e.end.x - e.start.x, dy = e.end.y - e.start.y
      const len2 = dx * dx + dy * dy
      let t = len2 > 0 ? ((cursor.x - e.start.x) * dx + (cursor.y - e.start.y) * dy) / len2 : 0
      t = Math.max(0, Math.min(1, t))
      const at = { x: e.start.x + t * dx, y: e.start.y + t * dy }
      const d = dist(cursor, at)
      const len = Math.hypot(dx, dy) || 1
      const u = s.forward ? { x: dx / len, y: dy / len } : { x: -dx / len, y: -dy / len }
      if (!best || d < best.d) best = { d, tangent: u, at }
    } else {
      // Clamp the cursor angle into the arc span.
      const sweep = arcSweep(e.startAngle, e.endAngle)
      const rel = norm(Math.atan2(cursor.y - e.center.y, cursor.x - e.center.x) - e.startAngle)
      const a = rel <= sweep
        ? e.startAngle + rel
        : (norm(rel - sweep) < norm(TWO_PI - rel) ? e.endAngle : e.startAngle)
      const at = arcPointAt(e.center, e.radius, a)
      const d = dist(cursor, at)
      // CCW tangent at a; reversed when the step traverses the arc CW.
      const t = s.forward
        ? { x: -Math.sin(a), y: Math.cos(a) }
        : { x: Math.sin(a), y: -Math.cos(a) }
      if (!best || d < best.d) best = { d, tangent: t, at }
    }
  }
  if (!best) return 1
  return cross(best.tangent, { x: cursor.x - best.at.x, y: cursor.y - best.at.y }) >= 0 ? 1 : -1
}

// ---- Offset construction ----------------------------------------------------------

/** A constructed offset piece in TRAVERSAL order. Lines carry traversal
 *  endpoints a->b; arcs stay in canonical CCW storage plus the traversal
 *  flag (forward = traversed CCW). */
type Piece =
  | { kind: 'line'; a: Vec2; b: Vec2 }
  | { kind: 'arc'; center: Vec2; radius: number; startAngle: number; endAngle: number; forward: boolean }

function pieceStart(p: Piece): Vec2 {
  if (p.kind === 'line') return p.a
  return arcPointAt(p.center, p.radius, p.forward ? p.startAngle : p.endAngle)
}

function pieceEnd(p: Piece): Vec2 {
  if (p.kind === 'line') return p.b
  return arcPointAt(p.center, p.radius, p.forward ? p.endAngle : p.startAngle)
}

/** Traversal start/end points of an ORIGINAL chain step. */
function stepEndpoints(s: ChainStep): { from: Vec2; to: Vec2 } {
  const e = s.entity
  if (e.kind === 'line') {
    return s.forward ? { from: e.start, to: e.end } : { from: e.end, to: e.start }
  }
  const a = arcPointAt(e.center, e.radius, e.startAngle)
  const b = arcPointAt(e.center, e.radius, e.endAngle)
  return s.forward ? { from: a, to: b } : { from: b, to: a }
}

/** Traversal tangent of an original step at its start or end. */
function stepTangent(s: ChainStep, at: 'from' | 'to'): Vec2 {
  const e = s.entity
  if (e.kind === 'line') {
    const len = dist(e.start, e.end) || 1
    const u = { x: (e.end.x - e.start.x) / len, y: (e.end.y - e.start.y) / len }
    return s.forward ? u : { x: -u.x, y: -u.y }
  }
  const fwd = s.forward
  const angle = (at === 'from') === fwd ? e.startAngle : e.endAngle
  return fwd
    ? { x: -Math.sin(angle), y: Math.cos(angle) }
    : { x: Math.sin(angle), y: -Math.cos(angle) }
}

// Infinite-primitive intersections (concave-corner trimming). Unlike the
// snap layer's entityIntersections these are NOT span-limited: the trim
// point can sit beyond a piece's current endpoint.

function infLineLine(
  a1: Vec2, a2: Vec2, b1: Vec2, b2: Vec2,
): Vec2[] {
  const dax = a2.x - a1.x, day = a2.y - a1.y
  const dbx = b2.x - b1.x, dby = b2.y - b1.y
  const denom = dax * dby - day * dbx
  if (Math.abs(denom) < 1e-12) return []
  const wx = b1.x - a1.x, wy = b1.y - a1.y
  const t = (wx * dby - wy * dbx) / denom
  return [{ x: a1.x + t * dax, y: a1.y + t * day }]
}

function infLineCircle(a1: Vec2, a2: Vec2, c: Vec2, r: number): Vec2[] {
  const dx = a2.x - a1.x, dy = a2.y - a1.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return []
  const ux = dx / len, uy = dy / len
  const t0 = (c.x - a1.x) * ux + (c.y - a1.y) * uy
  const foot = { x: a1.x + t0 * ux, y: a1.y + t0 * uy }
  const h2 = r * r - dist(foot, c) ** 2
  if (h2 < -1e-12) return []
  const h = h2 > 0 ? Math.sqrt(h2) : 0
  if (h === 0) return [foot]
  return [
    { x: foot.x - h * ux, y: foot.y - h * uy },
    { x: foot.x + h * ux, y: foot.y + h * uy },
  ]
}

function circleCircle(c1: Vec2, r1: number, c2: Vec2, r2: number): Vec2[] {
  const dx = c2.x - c1.x, dy = c2.y - c1.y
  const d = Math.hypot(dx, dy)
  if (d < 1e-12 || d > r1 + r2 + 1e-12 || d < Math.abs(r1 - r2) - 1e-12) return []
  const a = (r1 * r1 - r2 * r2 + d * d) / (2 * d)
  const h2 = r1 * r1 - a * a
  const h = h2 > 0 ? Math.sqrt(h2) : 0
  const mx = c1.x + (a * dx) / d
  const my = c1.y + (a * dy) / d
  if (h === 0) return [{ x: mx, y: my }]
  return [
    { x: mx - (h * dy) / d, y: my + (h * dx) / d },
    { x: mx + (h * dy) / d, y: my - (h * dx) / d },
  ]
}

function pieceIntersections(p1: Piece, p2: Piece): Vec2[] {
  if (p1.kind === 'line' && p2.kind === 'line') return infLineLine(p1.a, p1.b, p2.a, p2.b)
  if (p1.kind === 'line' && p2.kind === 'arc') {
    return infLineCircle(p1.a, p1.b, p2.center, p2.radius)
  }
  if (p1.kind === 'arc' && p2.kind === 'line') {
    return infLineCircle(p2.a, p2.b, p1.center, p1.radius)
  }
  if (p1.kind === 'arc' && p2.kind === 'arc') {
    return circleCircle(p1.center, p1.radius, p2.center, p2.radius)
  }
  return []
}

/** Move a piece's traversal END to X. Returns false when the piece would
 *  collapse (or invert). */
function trimEnd(p: Piece, X: Vec2): boolean {
  if (p.kind === 'line') {
    const len = dist(p.a, p.b) || 1
    const u = { x: (p.b.x - p.a.x) / len, y: (p.b.y - p.a.y) / len }
    const t = (X.x - p.a.x) * u.x + (X.y - p.a.y) * u.y
    if (t <= EPS_LEN) return false
    p.b = { x: X.x, y: X.y }
    return true
  }
  const oldSweep = arcSweep(p.startAngle, p.endAngle)
  const ang = Math.atan2(X.y - p.center.y, X.x - p.center.x)
  if (p.forward) p.endAngle = ang
  else p.startAngle = ang
  const s = arcSweep(p.startAngle, p.endAngle)
  return s > EPS_LEN && s <= oldSweep + 1e-9
}

/** Move a piece's traversal START to X (same collapse guard). */
function trimStart(p: Piece, X: Vec2): boolean {
  if (p.kind === 'line') {
    const len = dist(p.a, p.b) || 1
    const u = { x: (p.b.x - p.a.x) / len, y: (p.b.y - p.a.y) / len }
    const t = (X.x - p.a.x) * u.x + (X.y - p.a.y) * u.y
    if (t >= dist(p.a, p.b) - EPS_LEN) return false
    p.a = { x: X.x, y: X.y }
    return true
  }
  const oldSweep = arcSweep(p.startAngle, p.endAngle)
  const ang = Math.atan2(X.y - p.center.y, X.x - p.center.x)
  if (p.forward) p.startAngle = ang
  else p.endAngle = ang
  const s = arcSweep(p.startAngle, p.endAngle)
  return s > EPS_LEN && s <= oldSweep + 1e-9
}

/** Snap a piece's traversal start to an exact point (tangent joints). */
function snapStart(p: Piece, X: Vec2): void {
  if (p.kind === 'line') {
    p.a = { x: X.x, y: X.y }
    return
  }
  const ang = Math.atan2(X.y - p.center.y, X.x - p.center.x)
  if (p.forward) p.startAngle = ang
  else p.endAngle = ang
}

/** One connected run of offset pieces in traversal order. */
export interface OffsetLoop {
  pieces: Piece[]
  closed: boolean
}

export interface OffsetGeometry {
  /** Final pieces in traversal order (corner arcs included), loop after
   *  loop when the offset separates into several regions. */
  pieces: Piece[]
  closed: boolean
  /** The connected results: one, except for a closed chain whose offset
   *  separates into disjoint regions (a collapsed neck). */
  loops: OffsetLoop[]
}

function single(pieces: Piece[], closed: boolean): OffsetGeometry {
  return { pieces, closed, loops: [{ pieces, closed }] }
}

/**
 * Construct the exact offset of `source` at `distance` on `side`
 * (+1 = left of traversal, -1 = right). Returns the pieces or a
 * rejection string (collapse / arc inversion / impossible trim).
 */
export function computeOffset(
  source: OffsetSource, side: 1 | -1, distance: number,
): OffsetGeometry | string {
  if (!(distance > 0)) return 'Offset: distance must be positive'

  if (source.kind === 'circle') {
    const c = source.circle
    // side +1 = cursor inside = shrink (a CCW circle's left is inward).
    const r = side === 1 ? c.radius - distance : c.radius + distance
    if (r <= EPS_LEN) {
      return `Offset: ${distance.toFixed(2)} mm collapses this circle (R${c.radius.toFixed(2)})`
    }
    return single([{
      kind: 'arc', center: { ...c.center }, radius: r,
      startAngle: 0, endAngle: TWO_PI, forward: true,
    }], true)
  }

  const { steps, closed } = source
  if (steps.length === 0) return 'Offset: nothing to offset'

  const local = offsetLocally(steps, closed, side, distance)
  if (!closed) return typeof local === 'string' ? local : single(local, false)
  if (typeof local !== 'string' && !crossingCuts([local]).some((c) => c.length > 0)) {
    return single(local, true)
  }
  // The local construction collapsed or crosses itself: resolve the whole
  // result. Disjoint regions publish as separate loops; anything else refuses.
  const loops = separateRegions(steps, side, distance)
  if (loops) return { pieces: loops.flatMap((l) => l.pieces), closed: true, loops }
  if (typeof local === 'string') return local
  return `Offset: ${distance.toFixed(2)} mm collapses a narrow neck of this shape ` +
    `and the result does not separate into clean regions`
}

/** Step 1: the exact per-entity offsets, untrimmed. */
function exactOffsets(
  steps: ChainStep[], side: 1 | -1, distance: number,
): Piece[] | string {
  const pieces: Piece[] = []
  for (const s of steps) {
    const e = s.entity
    if (e.kind === 'line') {
      const len = dist(e.start, e.end)
      if (len <= EPS_LEN) return 'Offset: chain contains a zero-length line'
      // Left normal of the TRAVERSAL direction.
      const u = s.forward
        ? { x: (e.end.x - e.start.x) / len, y: (e.end.y - e.start.y) / len }
        : { x: (e.start.x - e.end.x) / len, y: (e.start.y - e.end.y) / len }
      const n = { x: -u.y * side * distance, y: u.x * side * distance }
      const { from, to } = stepEndpoints(s)
      pieces.push({
        kind: 'line',
        a: { x: from.x + n.x, y: from.y + n.y },
        b: { x: to.x + n.x, y: to.y + n.y },
      })
    } else {
      // Forward (CCW) traversal: left points toward the center, so the
      // left offset SHRINKS the radius; CW traversal is the mirror.
      const r = s.forward ? e.radius - side * distance : e.radius + side * distance
      if (r <= EPS_LEN) {
        return `Offset: ${distance} mm collapses an arc (R${e.radius.toFixed(2)})`
      }
      pieces.push({
        kind: 'arc', center: { ...e.center }, radius: r,
        startAngle: e.startAngle, endAngle: e.endAngle, forward: s.forward,
      })
    }
  }

  return pieces
}

/** Corner arc of radius `distance` centered on the original corner J,
 *  from e1 to s2, swept in the corner's turn direction. */
function cornerArc(J: Vec2, e1: Vec2, s2: Vec2, ccw: boolean, distance: number): Piece {
  const aFrom = Math.atan2(e1.y - J.y, e1.x - J.x)
  const aTo = Math.atan2(s2.y - J.y, s2.x - J.x)
  return {
    kind: 'arc', center: { x: J.x, y: J.y }, radius: distance,
    startAngle: ccw ? aFrom : aTo,
    endAngle: ccw ? aTo : aFrom,
    forward: ccw,
  }
}

/** Steps 1-2: the local construction, corner by corner. */
function offsetLocally(
  steps: ChainStep[], closed: boolean, side: 1 | -1, distance: number,
): Piece[] | string {
  const pieces = exactOffsets(steps, side, distance)
  if (typeof pieces === 'string') return pieces

  // 2. Join consecutive pieces at every original joint (and the closing
  //    joint of a closed chain). Joint policy per the header: snap when
  //    tangent, fillet-arc when diverging, intersection-trim when
  //    overlapping.
  const out: Piece[] = []
  const jointCount = closed ? pieces.length : pieces.length - 1
  for (let i = 0; i < pieces.length; i++) out.push(pieces[i])

  // Work joint by joint on the `out` array; corner arcs are spliced in
  // AFTER the loop (collect inserts to keep indices stable).
  const inserts: { after: Piece; arc: Piece }[] = []
  for (let j = 0; j < jointCount; j++) {
    const p1 = pieces[j]
    const p2 = pieces[(j + 1) % pieces.length]
    const e1 = pieceEnd(p1)
    const s2 = pieceStart(p2)
    if (dist(e1, s2) <= EPS_JOIN) {
      snapStart(p2, e1) // tangent joint: exact
      continue
    }
    const J = stepEndpoints(steps[j]).to // original corner
    const T1 = stepTangent(steps[j], 'to')
    const T2 = stepTangent(steps[(j + 1) % steps.length], 'from')
    const turn = cross(T1, T2)
    if (Math.abs(turn) <= EPS_TURN || side * turn < 0) {
      // Diverging corner (or numerically straight with a gap): fillet
      // arc of radius `distance` centered on the original corner. Sweep
      // direction = the corner's turn direction.
      inserts.push({ after: p1, arc: cornerArc(J, e1, s2, turn > 0, distance) })
    } else {
      // Overlapping corner: trim both pieces to their exact intersection
      // (the candidate nearest the original corner).
      const cands = pieceIntersections(p1, p2)
      if (cands.length === 0) {
        return 'Offset: cannot trim a corner at this distance (no intersection)'
      }
      let X = cands[0]
      for (const c of cands) if (dist(c, J) < dist(X, J)) X = c
      if (!trimEnd(p1, X) || !trimStart(p2, X)) {
        return `Offset: ${distance} mm is too large for this shape (a segment collapses)`
      }
    }
  }

  // Splice the corner arcs in (after their predecessor pieces).
  const final: Piece[] = []
  for (const p of out) {
    final.push(p)
    for (const ins of inserts) if (ins.after === p) final.push(ins.arc)
  }
  // A closing corner arc belongs after the LAST piece (it already is —
  // its predecessor is pieces[len-1]).

  return final
}

// ---- Whole-result topology (WO-1475) ------------------------------------------------
//
// The local construction only ever compares a piece with its neighbours.
// separateRegions resolves a closed offset as a whole: build the untrimmed
// raw offset curve, split every piece where any other piece crosses it,
// keep the sub-pieces lying at the full distance from the source (every
// point of a true offset boundary does; the parts across a collapsed neck
// or past a collapsed corner do not), and chain what survives into loops.

const EPS_CROSS = 1e-5 // mm: a crossing this close to a shared joint IS the joint

function pieceLength(p: Piece): number {
  return p.kind === 'line' ? dist(p.a, p.b) : p.radius * arcSweep(p.startAngle, p.endAngle)
}

/** Point at traversal fraction t (0 = traversal start, 1 = end). */
function pointAt(p: Piece, t: number): Vec2 {
  if (p.kind === 'line') {
    return { x: p.a.x + t * (p.b.x - p.a.x), y: p.a.y + t * (p.b.y - p.a.y) }
  }
  const sweep = arcSweep(p.startAngle, p.endAngle)
  return arcPointAt(p.center, p.radius,
    p.forward ? p.startAngle + t * sweep : p.endAngle - t * sweep)
}

/** The sub-piece between traversal fractions t0 < t1. */
function subPiece(p: Piece, t0: number, t1: number): Piece {
  if (p.kind === 'line') return { kind: 'line', a: pointAt(p, t0), b: pointAt(p, t1) }
  const sweep = arcSweep(p.startAngle, p.endAngle)
  return p.forward
    ? { ...p, center: { ...p.center },
        startAngle: p.startAngle + t0 * sweep, endAngle: p.startAngle + t1 * sweep }
    : { ...p, center: { ...p.center },
        startAngle: p.endAngle - t1 * sweep, endAngle: p.endAngle - t0 * sweep }
}

/** Traversal fraction of X along p, or null when X is off the piece. */
function fractionOn(p: Piece, X: Vec2): number | null {
  const len = pieceLength(p)
  if (!(len > 0)) return null
  let s: number
  if (p.kind === 'line') {
    s = ((X.x - p.a.x) * (p.b.x - p.a.x) + (X.y - p.a.y) * (p.b.y - p.a.y)) / len
  } else {
    const ang = Math.atan2(X.y - p.center.y, X.x - p.center.x)
    let rel = p.forward ? norm(ang - p.startAngle) : norm(p.endAngle - ang)
    if (rel * p.radius > len + EPS_CROSS && (TWO_PI - rel) * p.radius <= EPS_CROSS) rel -= TWO_PI
    s = rel * p.radius
  }
  if (s < -EPS_CROSS || s > len + EPS_CROSS) return null
  return Math.min(1, Math.max(0, s / len))
}

/** Where two collinear lines overlap, their endpoints touch the other. */
function collinearTouches(a: Piece & { kind: 'line' }, b: Piece & { kind: 'line' }): Vec2[] {
  const len = dist(a.a, a.b)
  if (!(len > 0)) return []
  const off = (q: Vec2) =>
    Math.abs((a.b.x - a.a.x) * (q.y - a.a.y) - (a.b.y - a.a.y) * (q.x - a.a.x)) / len
  if (off(b.a) > EPS_CROSS || off(b.b) > EPS_CROSS) return []
  return [a.a, a.b, b.a, b.b]
}

function pieceBox(p: Piece): { minX: number; minY: number; maxX: number; maxY: number } {
  if (p.kind === 'line') {
    return {
      minX: Math.min(p.a.x, p.b.x), minY: Math.min(p.a.y, p.b.y),
      maxX: Math.max(p.a.x, p.b.x), maxY: Math.max(p.a.y, p.b.y),
    }
  }
  return {
    minX: p.center.x - p.radius, minY: p.center.y - p.radius,
    maxX: p.center.x + p.radius, maxY: p.center.y + p.radius,
  }
}

/** Split fractions per piece (loops flattened in order) wherever pieces of
 *  the given closed loops cross or touch; a loop's own joints excluded. */
function crossingCuts(loops: Piece[][]): number[][] {
  const flat: { p: Piece; loop: number; idx: number }[] = []
  loops.forEach((pieces, loop) => pieces.forEach((p, idx) => flat.push({ p, loop, idx })))
  const boxes = flat.map((f) => pieceBox(f.p))
  const cuts: number[][] = flat.map(() => [])
  for (let i = 0; i < flat.length; i++) {
    for (let k = i + 1; k < flat.length; k++) {
      const bi = boxes[i], bk = boxes[k]
      if (bi.minX > bk.maxX + EPS_CROSS || bk.minX > bi.maxX + EPS_CROSS ||
          bi.minY > bk.maxY + EPS_CROSS || bk.minY > bi.maxY + EPS_CROSS) continue
      const A = flat[i], B = flat[k]
      const joints: Vec2[] = []
      if (A.loop === B.loop) {
        if (B.idx === A.idx + 1) joints.push(pieceEnd(A.p))
        if (A.idx === 0 && B.idx === loops[A.loop].length - 1) joints.push(pieceStart(A.p))
      }
      let hits = pieceIntersections(A.p, B.p)
      if (hits.length === 0 && A.p.kind === 'line' && B.p.kind === 'line') {
        hits = collinearTouches(A.p, B.p)
      }
      for (const X of hits) {
        if (joints.some((J) => dist(J, X) <= EPS_CROSS)) continue
        const ta = fractionOn(A.p, X)
        const tb = fractionOn(B.p, X)
        if (ta === null || tb === null) continue
        cuts[i].push(ta)
        cuts[k].push(tb)
      }
    }
  }
  return cuts
}

/** Distance from p to the nearest source entity. */
function sourceDistance(steps: ChainStep[], p: Vec2): number {
  let best = Infinity
  for (const s of steps) {
    const d = curveDistance(s.entity, p)
    if (d !== null && d < best) best = d
  }
  return best
}

function loopArea(pieces: Piece[]): number {
  const pts: Vec2[] = []
  for (const p of pieces) {
    const n = p.kind === 'line' ? 1 : Math.max(2, Math.ceil(arcSweep(p.startAngle, p.endAngle) / (Math.PI / 36)))
    for (let i = 0; i < n; i++) pts.push(pointAt(p, i / n))
  }
  let a = 0
  for (let i = 0; i < pts.length; i++) {
    const q = pts[(i + 1) % pts.length]
    a += pts[i].x * q.y - q.x * pts[i].y
  }
  return a / 2
}

/**
 * Resolve a closed chain's offset as a whole. Returns the disjoint loops
 * the offset separates into, or null when the result does not close into
 * clean, non-touching loops (or nothing survives).
 */
function separateRegions(
  steps: ChainStep[], side: 1 | -1, distance: number,
): OffsetLoop[] | null {
  const pieces = exactOffsets(steps, side, distance)
  if (typeof pieces === 'string') return null

  // The raw curve: exact offsets joined by a corner arc where they
  // diverge, and by two connectors through the original corner where they
  // overlap (the connectors lie inside the distance and never survive).
  const raw: Piece[] = []
  const n = pieces.length
  for (let j = 0; j < n; j++) {
    const p1 = pieces[j]
    const p2 = pieces[(j + 1) % n]
    raw.push(p1)
    const e1 = pieceEnd(p1)
    const s2 = pieceStart(p2)
    if (dist(e1, s2) <= EPS_JOIN) {
      snapStart(p2, e1)
      continue
    }
    const J = stepEndpoints(steps[j]).to
    const turn = cross(stepTangent(steps[j], 'to'), stepTangent(steps[(j + 1) % n], 'from'))
    if (Math.abs(turn) <= EPS_TURN || side * turn < 0) {
      raw.push(cornerArc(J, e1, s2, turn > 0, distance))
    } else {
      if (dist(e1, J) > EPS_JOIN) raw.push({ kind: 'line', a: e1, b: { x: J.x, y: J.y } })
      if (dist(J, s2) > EPS_JOIN) raw.push({ kind: 'line', a: { x: J.x, y: J.y }, b: s2 })
    }
  }

  // Split at every crossing; keep the sub-pieces at the full distance. A
  // sub-piece that is partly inside and partly at the distance is a
  // crossing we did not resolve: refuse rather than guess.
  const cuts = crossingCuts([raw])
  const minKeep = distance - 1e-6 * Math.max(1, distance)
  type Sub = { piece: Piece; src: number; t0: number; t1: number }
  const kept: Sub[] = []
  for (let i = 0; i < raw.length; i++) {
    const len = pieceLength(raw[i])
    const bounds = [0]
    for (const t of [...cuts[i]].sort((a, b) => a - b)) {
      if ((t - bounds[bounds.length - 1]) * len > EPS_JOIN && (1 - t) * len > EPS_JOIN) bounds.push(t)
    }
    bounds.push(1)
    for (let b = 0; b + 1 < bounds.length; b++) {
      const t0 = bounds[b], t1 = bounds[b + 1]
      const sub = subPiece(raw[i], t0, t1)
      const inside = [0.25, 0.5, 0.75].map((f) => sourceDistance(steps, pointAt(sub, f)) < minKeep)
      if (inside.every(Boolean)) continue
      if (inside.some(Boolean)) return null
      kept.push({ piece: sub, src: i, t0, t1 })
    }
  }
  if (kept.length === 0) return null

  // Chain the survivors: every end must meet exactly one start.
  const next = kept.map((k) => {
    const end = pieceEnd(k.piece)
    let hit = -1
    for (let o = 0; o < kept.length; o++) {
      if (dist(pieceStart(kept[o].piece), end) > EPS_CROSS) continue
      if (hit !== -1) return -1
      hit = o
    }
    return hit
  })
  if (next.includes(-1) || new Set(next).size !== next.length) return null

  const used = kept.map(() => false)
  const loops: OffsetLoop[] = []
  for (let s = 0; s < kept.length; s++) {
    if (used[s]) continue
    const merged: Sub[] = []
    for (let c = s; !used[c]; c = next[c]) {
      used[c] = true
      const sub = kept[c]
      const last = merged[merged.length - 1]
      // Re-join sub-pieces of one raw piece cut at a point nothing else used.
      if (last && last.src === sub.src && last.t1 === sub.t0) {
        merged[merged.length - 1] = {
          piece: subPiece(raw[sub.src], last.t0, sub.t1), src: sub.src, t0: last.t0, t1: sub.t1,
        }
      } else {
        merged.push(sub)
      }
    }
    if (merged.length > 1) {
      const first = merged[0], last = merged[merged.length - 1]
      if (last.src === first.src && last.t1 === first.t0) {
        merged[0] = {
          piece: subPiece(raw[first.src], last.t0, first.t1), src: first.src, t0: last.t0, t1: first.t1,
        }
        merged.pop()
      }
    }
    const out = merged.map((m) => m.piece)
    for (let i = 0; i < out.length; i++) snapStart(out[(i + 1) % out.length], pieceEnd(out[i]))
    if (Math.abs(loopArea(out)) <= EPS_LEN) return null
    loops.push({ pieces: out, closed: true })
  }

  // The published loops must neither cross nor touch - themselves or each other.
  if (crossingCuts(loops.map((l) => l.pieces)).some((c) => c.length > 0)) return null
  return loops
}

// ---- Commit / preview -----------------------------------------------------------

function pieceToEntity(p: Piece, id: string): SketchEntity {
  if (p.kind === 'line') {
    return {
      id, kind: 'line', construction: false,
      start: { x: p.a.x, y: p.a.y }, end: { x: p.b.x, y: p.b.y },
    }
  }
  const full = Math.abs(norm(p.endAngle - p.startAngle)) < 1e-12 &&
    Math.abs(p.endAngle - p.startAngle) > 1
  if (full) {
    // Full circle (the circle-source case round-trips to a circle).
    return {
      id, kind: 'circle', construction: false,
      center: { x: p.center.x, y: p.center.y }, radius: p.radius,
    }
  }
  return {
    id, kind: 'arc', construction: false,
    center: { x: p.center.x, y: p.center.y }, radius: p.radius,
    startAngle: norm(p.startAngle), endAngle: norm(p.endAngle),
  }
}

/** Traversal end site of a piece's ENTITY form ('end' of a line; for an
 *  arc, the CCW storage end when traversed forward, else the start). */
function endSite(p: Piece): 'start' | 'end' {
  if (p.kind === 'line') return 'end'
  return p.forward ? 'end' : 'start'
}

function startSite(p: Piece): 'start' | 'end' {
  if (p.kind === 'line') return 'start'
  return p.forward ? 'start' : 'end'
}

/**
 * Build the commit for an offset geometry: one entity per piece plus
 * coincident constraints chaining consecutive NEW entities within each
 * loop (none to the source, none between disjoint loops). A standalone
 * circle commits bare.
 *
 * `source` makes the result ASSOCIATIVE (WO-1859): every entity carries the
 * shared `offsetLink` describing the chain it came from. Omit it and the
 * commit is the pre-WO-1859 one-shot copy, byte for byte.
 */
export function offsetCommit(
  geo: OffsetGeometry, newId: () => string,
  source?: { source: OffsetSource; side: 1 | -1; distance: number },
): { entities: SketchEntity[]; constraints: SketchConstraint[] } {
  const link = source
    ? {
        id: newId(),
        source: offsetSourceRefs(source.source),
        closed: source.source.kind === 'circle' ? true : source.source.closed,
        distance: source.distance,
        side: source.side,
        loopSizes: geo.loops.map((l) => l.pieces.length),
        constraintIds: [] as string[],
      }
    : null
  let pieceIndex = 0
  const perLoop = geo.loops.map((loop) => loop.pieces.map((p) => {
    const e = pieceToEntity(p, newId())
    const index = pieceIndex++
    return link ? { ...e, offsetLink: { ...link, index } } : e
  }))
  const constraints: SketchConstraint[] = []
  geo.loops.forEach((loop, li) => {
    const entities = perLoop[li]
    if (entities.length < 2) return
    const jointCount = loop.closed ? entities.length : entities.length - 1
    for (let i = 0; i < jointCount; i++) {
      const a = entities[i]
      const b = entities[(i + 1) % entities.length]
      if (a.kind === 'circle' || b.kind === 'circle') continue
      constraints.push({
        id: newId(), kind: 'coincident',
        a: { entityId: a.id, site: endSite(loop.pieces[i]) },
        b: { entityId: b.id, site: startSite(loop.pieces[(i + 1) % loop.pieces.length]) },
      })
    }
  })
  if (link) link.constraintIds.push(...constraints.map(c => c.id))
  return { entities: perLoop.flat(), constraints }
}

/** Tessellated preview polyline of the offset, or null when the offset
 *  is rejected at this distance. A locked side previews that side; an
 *  unlocked chain follows the cursor's side live. The commit
 *  (offsetApply) builds from the SAME computeOffset, so the ghost is
 *  exactly what OK creates. */
export function offsetPreview(
  chain: OffsetChainState, cursor: Vec2, distance: number,
): Vec2[] | null {
  const side = chain.lockedSide ?? chainSide(chain.source, cursor)
  const geo = computeOffset(chain.source, side, distance)
  if (typeof geo === 'string') return null
  // A separated offset previews its loops one after another on the one
  // ghost polyline (toolOverlay draws a single ghost for this tool).
  const pts: Vec2[] = []
  for (const loop of geo.loops) {
    const first = pts.length
    for (const p of loop.pieces) {
      if (p.kind === 'line') {
        pts.push({ ...p.a }, { ...p.b })
      } else {
        const sweep = arcSweep(p.startAngle, p.endAngle)
        const n = Math.max(2, Math.ceil((sweep * p.radius) / 0.5))
        for (let i = 0; i <= n; i++) {
          const t = p.forward ? i / n : 1 - i / n
          const a = p.startAngle + sweep * t
          pts.push(arcPointAt(p.center, p.radius, a))
        }
      }
    }
    if (loop.closed && pts.length > first) pts.push({ ...pts[first] })
  }
  return pts
}

// ---- Selection seeding -----------------------------------------------------------

/** Offset source seeded from a pre-selection: the first selected
 *  non-construction curve picks its whole chain (circles are their own
 *  source) — the same source a step-1 click on it would build. */
export function offsetSeedFromSelection(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  selectedIds: readonly string[],
): OffsetSource | null {
  for (const id of selectedIds) {
    const e = entities.find((x) => x.id === id)
    if (!e || e.construction || e.kind === 'point') continue
    if (e.kind === 'circle') return { kind: 'circle', circle: e }
    const ch = chainContaining(entities, constraints, e.id)
    if (ch) return { kind: 'chain', steps: ch.steps, closed: ch.closed }
  }
  return null
}

// ---- Apply (confirm overlay OK) -----------------------------------------------------

/**
 * Build the commit for a SIDE-LOCKED chain at `distance` — the confirm
 * overlay's OK. Returns the commit or a rejection string (the overlay
 * keeps the flow alive so the user can adjust the distance).
 */
export function offsetApply(
  chain: OffsetChainState,
  distance: number,
  newId: () => string = () => crypto.randomUUID(),
): { entities: SketchEntity[]; constraints: SketchConstraint[] } | string {
  if (chain.lockedSide === null) return 'Offset: click the side to offset toward first'
  const geo = computeOffset(chain.source, chain.lockedSide, distance)
  if (typeof geo === 'string') return geo
  // WO-1859: born LINKED to the chain it was offset from.
  return offsetCommit(geo, newId, {
    source: chain.source, side: chain.lockedSide, distance,
  })
}

// ---- The associative link (WO-1859) --------------------------------------------------

/** The source chain of `source`, by id, in traversal order. */
export function offsetSourceRefs(source: OffsetSource): OffsetSourceRef[] {
  if (source.kind === 'circle') return [{ entityId: source.circle.id, forward: true }]
  return source.steps.map((s) => ({ entityId: s.entity.id, forward: s.forward }))
}

/** `e` with its associative link removed — the offset geometry is untouched,
 *  so breaking a link leaves every coordinate exactly where it was. */
export function withoutOffsetLink(e: SketchEntity): SketchEntity {
  if (e.offsetLink === undefined) return e
  const { offsetLink: _dropped, ...rest } = e
  return rest as SketchEntity
}

/**
 * Rebuild the LIVE offset source a link names, from the current entities.
 * Returns null when a source entity is gone or is no longer a curve the tool
 * can offset — the caller then drops the link rather than guessing.
 */
export function offsetSourceFromLink(
  entities: readonly SketchEntity[], link: SketchOffsetLink,
): OffsetSource | null {
  const byId = new Map(entities.map((e) => [e.id, e]))
  if (link.source.length === 0) return null
  if (link.source.length === 1) {
    const only = byId.get(link.source[0].entityId)
    // A circle never chains, so a one-entry source naming one IS the
    // standalone-circle case (the concentric-circle offset).
    if (only && only.kind === 'circle') return { kind: 'circle', circle: only }
  }
  const steps: ChainStep[] = []
  for (const ref of link.source) {
    const e = byId.get(ref.entityId)
    if (!e || (e.kind !== 'line' && e.kind !== 'arc')) return null
    steps.push({ entity: e, forward: ref.forward })
  }
  return { kind: 'chain', steps, closed: link.closed }
}

/** Rewrite one linked entity's geometry from a recomputed piece, keeping its
 *  id, construction flag and link. Returns null when the piece is a different
 *  kind of thing than the entity (the shape's topology changed). */
function rewriteFromPiece(e: SketchEntity, p: Piece): SketchEntity | null {
  const fresh = pieceToEntity(p, e.id)
  if (fresh.kind === 'line' && e.kind === 'line') {
    return { ...e, start: fresh.start, end: fresh.end }
  }
  if (fresh.kind === 'circle' && e.kind === 'circle') {
    return { ...e, center: fresh.center, radius: fresh.radius }
  }
  if (fresh.kind === 'arc' && e.kind === 'arc') {
    return {
      ...e, center: fresh.center, radius: fresh.radius,
      startAngle: fresh.startAngle, endAngle: fresh.endAngle,
    }
  }
  return null
}

function sameLoopSizes(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((n, i) => n === b[i])
}

/** What one link's re-offset did, for the console line. */
export interface OffsetLinkNote {
  linkId: string
  /** 'dropped' = the source is gone and the offset is now plain geometry;
   *  'kept' = the offset could not take the recomputed shape in place and
   *  stays exactly where it was. */
  outcome: 'dropped' | 'kept'
  message: string
}

export interface OffsetLinkRecompute {
  entities: SketchEntity[]
  /** Links that recomputed cleanly. */
  updatedLinkIds: string[]
  notes: OffsetLinkNote[]
}

/**
 * THE re-offset pass. Pure: recomputes every associative offset in `entities`
 * from the current source geometry and returns the rewritten array.
 *
 * Per link, exactly one of:
 *   - the source is gone / no longer offsettable -> the link is DROPPED and
 *     the geometry kept (deleting a source leaves the offset standing as
 *     ordinary geometry; nothing dangles, nothing is destroyed);
 *   - computeOffset refuses at this distance, or the recomputed shape has a
 *     different loop partition than the entity set -> the geometry is KEPT
 *     and a note explains what could not be carried. Never a crossed loop:
 *     computeOffset's WO-1475 whole-result rule is the only source of the
 *     geometry written here, so a collapsed neck either lands as the same
 *     partition of disjoint regions or is not written at all;
 *   - otherwise every piece is rewritten IN PLACE (same ids, same
 *     constraints, no second chain).
 */
export function recomputeOffsetLinks(
  entities: readonly SketchEntity[],
): OffsetLinkRecompute {
  // WO-2616: missing sources remove their dependent geometry. Explicit Break
  // remains the operation that converts an offset to independent geometry.
  const liveIds = new Set(entities.map(e => e.id))
  const removed = new Set<string>()
  let found = true
  while (found) {
    found = false
    for (const e of entities) if (e.offsetLink && !removed.has(e.id) &&
      e.offsetLink.source.some(ref => !liveIds.has(ref.entityId) || removed.has(ref.entityId))) {
      removed.add(e.id)
      found = true
    }
  }
  if (removed.size) {
    const result = recomputeOffsetLinks(entities.filter(e => !removed.has(e.id)))
    return { ...result, notes: [...result.notes, ...[...new Set(entities.filter(e => removed.has(e.id)).map(e => e.offsetLink!.id))].map(linkId => ({
      linkId, outcome: 'dropped' as const, message: `Offset link ${linkId}: source removed; dependent copies removed.`,
    }))] }
  }
  const groups = new Map<string, { link: SketchOffsetLink; at: number[] }>()
  entities.forEach((e, i) => {
    if (!e.offsetLink) return
    const g = groups.get(e.offsetLink.id)
    if (g) g.at.push(i)
    else groups.set(e.offsetLink.id, { link: e.offsetLink, at: [i] })
  })
  if (groups.size === 0) {
    return { entities: entities as SketchEntity[], updatedLinkIds: [], notes: [] }
  }

  const next = [...entities]
  const updatedLinkIds: string[] = []
  const notes: OffsetLinkNote[] = []
  for (const [linkId, { link, at }] of groups) {
    // Pieces are addressed by the link's own index, not by array order.
    const slot: (number | undefined)[] = []
    for (const i of at) slot[next[i].offsetLink!.index] = i
    const total = link.loopSizes.reduce((s, n) => s + n, 0)
    const complete = slot.length === total && slot.every((i) => i !== undefined)

    const source = offsetSourceFromLink(entities, link)
    if (!source) {
      for (const i of at) next[i] = withoutOffsetLink(next[i])
      notes.push({
        linkId, outcome: 'dropped',
        message: `Offset link ${linkId}: the geometry it was offset from is gone. ` +
          `The offset stays exactly where it is, as ordinary geometry.`,
      })
      continue
    }
    if (!complete) {
      // Part of the offset was deleted: what is left is no longer the shape
      // the link describes, so it becomes ordinary geometry too.
      for (const i of at) next[i] = withoutOffsetLink(next[i])
      notes.push({
        linkId, outcome: 'dropped',
        message: `Offset link ${linkId}: ${at.length} of ${total} offset pieces are left, ` +
          `so the offset no longer matches its source. It stays exactly where it is, ` +
          `as ordinary geometry.`,
      })
      continue
    }

    const geo = computeOffset(source, link.side, link.distance)
    if (typeof geo === 'string') {
      notes.push({
        linkId, outcome: 'kept',
        message: `Offset link ${linkId}: ${geo}. The offset stays where it is; ` +
          `edit the source or the offset distance to bring it back.`,
      })
      continue
    }
    const sizes = geo.loops.map((l) => l.pieces.length)
    if (!sameLoopSizes(sizes, link.loopSizes)) {
      notes.push({
        linkId, outcome: 'kept',
        message: `Offset link ${linkId}: at this source shape the ${link.distance} mm offset ` +
          `is ${sizes.length} loop${sizes.length === 1 ? '' : 's'} of ` +
          `${sizes.join('+')} pieces instead of ${link.loopSizes.length} of ` +
          `${link.loopSizes.join('+')}, which this offset's pieces cannot take in place. ` +
          `The offset stays where it is; offset the source again for the new shape.`,
      })
      continue
    }
    const rewritten: SketchEntity[] = []
    let ok = true
    for (let k = 0; k < total; k++) {
      const r = rewriteFromPiece(next[slot[k]!], geo.pieces[k])
      if (!r) { ok = false; break }
      rewritten.push(r)
    }
    if (!ok) {
      notes.push({
        linkId, outcome: 'kept',
        message: `Offset link ${linkId}: at this source shape a piece of the ` +
          `${link.distance} mm offset changes from a line to an arc or back, which this ` +
          `offset's pieces cannot take in place. The offset stays where it is; ` +
          `offset the source again for the new shape.`,
      })
      continue
    }
    for (let k = 0; k < total; k++) next[slot[k]!] = rewritten[k]
    updatedLinkIds.push(linkId)
  }
  return { entities: next, updatedLinkIds, notes }
}

// One console line per link whose situation CHANGED (COHESION s13: console,
// never a UI notice). A drag runs the re-offset on every solve tick, so a
// link that cannot be carried says so once and then stays quiet until
// something about it changes.
const reportedOffsetNotes = new Map<string, string>()

/** The re-offset as the solve pipeline uses it: recompute, then say in one
 *  console line what happened to any offset whose shape could not be carried. */
export function applyOffsetLinks(entities: readonly SketchEntity[]): SketchEntity[] {
  const r = recomputeOffsetLinks(entities)
  for (const id of r.updatedLinkIds) reportedOffsetNotes.delete(id)
  for (const note of r.notes) {
    if (reportedOffsetNotes.get(note.linkId) === note.message) continue
    reportedOffsetNotes.set(note.linkId, note.message)
    console.info(`[offset] ${note.message}`)
  }
  return r.entities
}

/** Test seam: forget which notes have already been said. */
export function resetOffsetLinkNoteLog(): void {
  reportedOffsetNotes.clear()
}

/** The link ids present on `ids` (a selection). */
export function offsetLinkIdsIn(
  entities: readonly SketchEntity[], ids: readonly string[],
): string[] {
  const wanted = new Set(ids)
  const out: string[] = []
  for (const e of entities) {
    if (e.offsetLink && wanted.has(e.id) && !out.includes(e.offsetLink.id)) {
      out.push(e.offsetLink.id)
    }
  }
  return out
}

/**
 * BREAK the named links: the offset geometry stays at the exact coordinates
 * it has and stops following its source. Returns null when nothing matched.
 */
export function breakOffsetLinks(
  entities: readonly SketchEntity[], linkIds: readonly string[],
): SketchEntity[] | null {
  const drop = new Set(linkIds)
  let hit = false
  const next = entities.map((e) => {
    if (!e.offsetLink || !drop.has(e.offsetLink.id)) return e
    hit = true
    return withoutOffsetLink(e)
  })
  return hit ? next : null
}

/**
 * Re-offset a LIVE link at a new distance, in place: the same entities move
 * to the new distance, so there is no second chain and no duplicate
 * constraint. Returns the rewritten entities, or a reason string when the
 * distance is impossible or the new shape cannot be taken in place (the
 * caller keeps the old distance and says why).
 */
export function setOffsetLinkDistance(
  entities: readonly SketchEntity[], linkIds: readonly string[], distance: number,
): SketchEntity[] | string {
  if (!(distance > 0) || !Number.isFinite(distance)) {
    return 'Offset: distance must be positive'
  }
  const wanted = new Set(linkIds)
  const retargeted = entities.map((e) =>
    e.offsetLink && wanted.has(e.offsetLink.id)
      ? { ...e, offsetLink: { ...e.offsetLink, distance } }
      : e)
  const r = recomputeOffsetLinks(retargeted)
  const refused = r.notes.filter((n) => wanted.has(n.linkId))
  if (refused.length > 0) return refused[0].message
  if (r.updatedLinkIds.length === 0) return 'Offset: no linked offset in the selection'
  return r.entities
}

// ---- Click behavior ----------------------------------------------------------------

/**
 * CLICK(p) for the armed offset tool (select - side - confirm flow):
 *   - first click picks an entity: its whole chain (bake chaining) is
 *     selected and the ghost preview follows the cursor's side; a
 *     circle is its own source
 *   - second click LOCKS the side under the cursor and opens the
 *     confirm overlay (editable distance, OK commits via offsetApply)
 *   - clicking again while locked re-locks to the new cursor side (the
 *     ghost flips - change your mind without Esc)
 *   - construction geometry is excluded (notice, not silence)
 */
export function offsetClick(
  chain: OffsetChainState | null,
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  world: Vec2,
  tol: number,
): OffsetClickOutcome {
  if (!chain) {
    const hit = pickCurve(entities, world, tol)
    if (!hit) return { chain: null, notice: null } // quiet idle click
    if (hit.construction) {
      return {
        chain: null,
        notice: 'Offset: construction geometry is excluded',
      }
    }
    if (hit.kind === 'circle') {
      return {
        chain: { kind: 'offset', source: { kind: 'circle', circle: hit }, lockedSide: null },
        notice: null,
      }
    }
    const ch = chainContaining(entities, constraints, hit.id)
    if (!ch) {
      return { chain: null, notice: 'Offset: nothing chains here' }
    }
    return {
      chain: {
        kind: 'offset',
        source: { kind: 'chain', steps: ch.steps, closed: ch.closed },
        lockedSide: null,
      },
      notice: null,
    }
  }

  // Lock (or re-lock) the side under the cursor; the confirm overlay
  // takes it from here.
  return {
    chain: { ...chain, lockedSide: chainSide(chain.source, world) },
    notice: null,
  }
}
