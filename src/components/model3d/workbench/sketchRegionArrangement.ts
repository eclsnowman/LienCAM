// WO BUG-MODEL-REGION-PICK (Operator, 2026-08-05 screenshot): "Pick a profile to extrude fails (and I
// don't want profiles), I want enclosed regions. It might be made up of several profiles."
//
// THE DEFECT THIS REPLACES. `src/sketch3d/regions.ts`'s `chainEntitiesIntoLoops` is a WHOLE-PROFILE
// chainer: it walks shared endpoints and THROWS on any vertex whose degree is not exactly 2. So a
// sketch is all-or-nothing at PROFILE granularity:
//   - one stray/dangling edge (a degree-1 vertex -- exactly the
//     "vertex 44.922379,-7.500000 has degree 1" in Operator's status bar) refuses the ENTIRE sketch, so
//     nothing at all is pickable even though several perfectly closed regions are on screen;
//   - two overlapping/abutting rectangles (a degree-3 or degree-4 vertex) refuse the same way, so the
//     enclosed sub-region their edges jointly bound can never be selected;
//   - two profiles that merely CROSS (no shared endpoint at all) chain into two whole loops, and the
//     lens/sub-region between them is not a region the user can pick -- it does not exist in the model.
//
// WHAT THIS MODULE DOES INSTEAD. It builds the planar ARRANGEMENT of the sketch's non-construction
// geometry and enumerates its bounded faces:
//   1. split every curve at every intersection with every other curve (line/line, line/circle-arc and
//      arc/arc, all closed form -- no tessellated approximation of the boundary itself);
//   2. fuse endpoints within VERTEX_TOL into shared arrangement vertices;
//   3. iteratively prune degree-1 edges -- stray geometry bounds nothing, so it is IGNORED rather
//      than fatal (Operator's case 1);
//   4. walk the half-edge graph with the standard "next = the outgoing edge immediately clockwise
//      from the incoming one" rule. Every bounded face falls out as a CCW cycle, so a face bounded by
//      edges from SEVERAL source profiles is a first-class region (Operator's cases 2 and 3);
//   5. classify nesting exactly as regions.ts already does -- even containment depth = a region's
//      outer boundary, odd = a hole of its nearest container -- through the SAME Clipper2 machinery
//      (cam3d/geom2d `boolean`/`area`/`netArea`), so hole containment and island-in-hole behave
//      identically to before.
//
// WHY IT LIVES HERE AND NOT IN src/sketch3d/regions.ts. regions.ts is the 3D-lab sketch3d path's
// engine (regen.ts drives it) and is OUTSIDE this WO's ownership. The Model workbench's accept point
// is sketchProfile.ts, in this directory, and it is the path that produced Operator's refusal. This
// module is therefore the workbench's region engine; regions.ts keeps the lab path byte-identical.
// Adopting the arrangement for the lab path too is a named follow-on, not a silent divergence: the
// two agree on every input regions.ts accepts (a set of simple closed loops arranges into exactly the
// same faces), and differ only where regions.ts throws.
//
// DETERMINISM. Curves are processed in sorted-srcId order, arrangement vertices are interned in that
// order, half-edges are visited in index order, every loop is rotated to its own minimum
// (srcId, start-point) segment, and the region list plus each region's hole list are sorted by a
// total key. Shuffling the input entity array therefore cannot change which regions come out, their
// contents, or their order.
//
// FROZEN CONTRACTS UNTOUCHED. Output is `ProfileRegion` exactly per geom-service.ts v0.4 (outer CCW,
// holes CW, exact line/arc segments carrying their source entity's srcId lineage). Tessellation is
// used ONLY for area/containment math, never emitted.

import { area, boolean as booleanRings, ensureGeom2dReady, netArea, type Ring } from '../../../cam3d/geom2d'
import type { ProfileRegion } from '../../../geom/geom-service'
import type { Sketch3dEntity } from '../../../sketch3d'

type ProfileLoop = ProfileRegion['loops'][number]
type ProfileSegment = ProfileLoop[number]
type Pt = [number, number]

const TWO_PI = Math.PI * 2
const HALF_PI = Math.PI / 2

/** Two endpoints closer than this fuse into ONE arrangement vertex. Same 1e-6 granularity
 *  regions.ts's `toFixed(6)` vertex key already assumed, but as a RADIUS rather than a bin, so two
 *  solver outputs 1e-12 apart can never land on opposite sides of a bin edge and split a closed loop
 *  into a false open one. */
const VERTEX_TOL = 1e-6
/** Parallel/tangency rejection for the closed-form intersections. */
const GEOM_EPS = 1e-12
/** A face below this |area| is a sliver produced by duplicated or tangent boundary, not a region. */
const AREA_EPS = 1e-9
const NESTING_SAMPLES_PER_TURN = 64

// ---------------------------------------------------------------------------
// Curves: the pre-arrangement view of one source entity.
// ---------------------------------------------------------------------------

interface CurveBase {
  /** The ORIGINAL sketch-entity id (or the adapter's synthetic tessellation id, which
   *  sketchProfile.ts rewrites back before the kernel boundary). */
  srcId: string
  /** Intersection parameters found on this curve, in its own [0, 1] parameter space. */
  splits: number[]
}

interface LineCurve extends CurveBase {
  kind: 'line'
  a: Pt
  b: Pt
}

/** Always a CCW sweep of `span` radians starting at `start` -- the canonical-CCW arc invariant
 *  draftEntities.ts/regions.ts already enforce. `closed` marks a full circle. */
interface ArcCurve extends CurveBase {
  kind: 'arc'
  c: Pt
  r: number
  start: number
  span: number
  /** The entity's own raw angles, emitted verbatim when the curve is never split. */
  a0: number
  a1: number
  closed: boolean
}

type Curve = LineCurve | ArcCurve

function positiveSpan(delta: number): number {
  let span = delta % TWO_PI
  if (span <= 1e-12) span += TWO_PI
  return span
}

function normalizeAngle(angle: number): number {
  const wrapped = angle % TWO_PI
  return wrapped < 0 ? wrapped + TWO_PI : wrapped
}

/** Non-construction line/arc/circle entities -> curves, in deterministic srcId order. */
function curvesOf(entities: readonly Sketch3dEntity[]): Curve[] {
  const curves: Curve[] = []
  for (const entity of entities) {
    if (entity.construction) continue
    if (entity.kind === 'line') {
      curves.push({
        kind: 'line',
        srcId: entity.id,
        splits: [],
        a: [entity.start.x, entity.start.y],
        b: [entity.end.x, entity.end.y],
      })
    } else if (entity.kind === 'circle') {
      curves.push({
        kind: 'arc',
        srcId: entity.id,
        splits: [],
        c: [entity.center.x, entity.center.y],
        r: entity.radius,
        start: 0,
        span: TWO_PI,
        a0: 0,
        a1: TWO_PI,
        closed: true,
      })
    } else if (entity.kind === 'arc') {
      curves.push({
        kind: 'arc',
        srcId: entity.id,
        splits: [],
        c: [entity.center.x, entity.center.y],
        r: entity.radius,
        start: entity.startAngle,
        span: positiveSpan(entity.endAngle - entity.startAngle),
        a0: entity.startAngle,
        a1: entity.endAngle,
        closed: false,
      })
    }
  }
  return curves.sort((x, y) => (x.srcId < y.srcId ? -1 : x.srcId > y.srcId ? 1 : 0))
}

function pointAt(curve: Curve, t: number): Pt {
  if (curve.kind === 'line') {
    return [curve.a[0] + (curve.b[0] - curve.a[0]) * t, curve.a[1] + (curve.b[1] - curve.a[1]) * t]
  }
  const angle = curve.start + curve.span * t
  return [curve.c[0] + curve.r * Math.cos(angle), curve.c[1] + curve.r * Math.sin(angle)]
}

/** The arc parameter of a world point, or null when the point is off this arc's sweep. The angular
 *  tolerance is VERTEX_TOL mapped through the radius, so "on the arc" means the same distance here
 *  as it does at the vertex table. */
function arcParamOf(curve: ArcCurve, p: Pt): number | null {
  const angleTol = Math.max(1e-9, VERTEX_TOL / Math.max(curve.r, VERTEX_TOL))
  const theta = Math.atan2(p[1] - curve.c[1], p[0] - curve.c[0])
  let delta = (theta - curve.start) % TWO_PI
  if (delta < 0) delta += TWO_PI
  // A point a hair BEFORE the start wraps to delta ~ 2*PI: that is the START (param 0), not the end.
  if (delta > TWO_PI - angleTol) delta = 0
  if (delta > curve.span + angleTol) return null
  return clampUnit(delta / curve.span)
}

// ---------------------------------------------------------------------------
// Closed-form intersections. Every hit is recorded as a parameter on BOTH curves;
// out-of-range and endpoint-coincident hits are filtered later by vertex interning.
// ---------------------------------------------------------------------------

function inUnit(t: number): boolean {
  return t >= -1e-9 && t <= 1 + 1e-9
}

function clampUnit(t: number): number {
  return t < 0 ? 0 : t > 1 ? 1 : t
}

function intersectLineLine(u: LineCurve, v: LineCurve): void {
  const rx = u.b[0] - u.a[0], ry = u.b[1] - u.a[1]
  const sx = v.b[0] - v.a[0], sy = v.b[1] - v.a[1]
  const denominator = rx * sy - ry * sx
  // Parallel or collinear. A collinear OVERLAP has no isolated crossing to split at; exactly
  // duplicated boundary is handled by edge de-duplication instead.
  if (Math.abs(denominator) < GEOM_EPS) return
  const qx = v.a[0] - u.a[0], qy = v.a[1] - u.a[1]
  const t = (qx * sy - qy * sx) / denominator
  const w = (qx * ry - qy * rx) / denominator
  if (!inUnit(t) || !inUnit(w)) return
  u.splits.push(clampUnit(t))
  v.splits.push(clampUnit(w))
}

function intersectLineArc(u: LineCurve, v: ArcCurve): void {
  const dx = u.b[0] - u.a[0], dy = u.b[1] - u.a[1]
  const fx = u.a[0] - v.c[0], fy = u.a[1] - v.c[1]
  const qa = dx * dx + dy * dy
  if (qa < GEOM_EPS) return
  const qb = 2 * (fx * dx + fy * dy)
  const qc = fx * fx + fy * fy - v.r * v.r
  const discriminant = qb * qb - 4 * qa * qc
  if (discriminant < 0) return
  const root = Math.sqrt(Math.max(discriminant, 0))
  for (const t of [(-qb - root) / (2 * qa), (-qb + root) / (2 * qa)]) {
    if (!inUnit(t)) continue
    const clamped = clampUnit(t)
    const w = arcParamOf(v, pointAt(u, clamped))
    if (w === null) continue
    u.splits.push(clamped)
    v.splits.push(clampUnit(w))
  }
}

function intersectArcArc(u: ArcCurve, v: ArcCurve): void {
  const dx = v.c[0] - u.c[0], dy = v.c[1] - u.c[1]
  const d = Math.hypot(dx, dy)
  // Concentric (including identical) circles never cross at isolated points.
  if (d < GEOM_EPS) return
  if (d > u.r + v.r + GEOM_EPS || d < Math.abs(u.r - v.r) - GEOM_EPS) return
  const base = (u.r * u.r - v.r * v.r + d * d) / (2 * d)
  const height = Math.sqrt(Math.max(u.r * u.r - base * base, 0))
  const mx = u.c[0] + (base * dx) / d, my = u.c[1] + (base * dy) / d
  const ox = (-dy * height) / d, oy = (dx * height) / d
  for (const p of [[mx + ox, my + oy] as Pt, [mx - ox, my - oy] as Pt]) {
    const t = arcParamOf(u, p)
    const w = arcParamOf(v, p)
    if (t === null || w === null) continue
    u.splits.push(clampUnit(t))
    v.splits.push(clampUnit(w))
  }
}

function splitAtIntersections(curves: Curve[]): void {
  for (let i = 0; i < curves.length; i++) {
    for (let j = i + 1; j < curves.length; j++) {
      const u = curves[i], v = curves[j]
      if (u.kind === 'line' && v.kind === 'line') intersectLineLine(u, v)
      else if (u.kind === 'line' && v.kind === 'arc') intersectLineArc(u, v)
      else if (u.kind === 'arc' && v.kind === 'line') intersectLineArc(v, u)
      else if (u.kind === 'arc' && v.kind === 'arc') intersectArcArc(u, v)
    }
  }
}

// ---------------------------------------------------------------------------
// Arrangement vertices: a tolerant spatial intern table (never a hard bin).
// ---------------------------------------------------------------------------

class VertexTable {
  readonly points: Pt[] = []
  private readonly cells = new Map<string, number[]>()

  intern(p: Pt): number {
    const cx = Math.round(p[0] / VERTEX_TOL)
    const cy = Math.round(p[1] / VERTEX_TOL)
    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        for (const index of this.cells.get(`${cx + dx},${cy + dy}`) ?? []) {
          const q = this.points[index]
          if (Math.hypot(q[0] - p[0], q[1] - p[1]) <= VERTEX_TOL) return index
        }
      }
    }
    const index = this.points.length
    this.points.push([p[0], p[1]])
    const key = `${cx},${cy}`
    const list = this.cells.get(key)
    if (list === undefined) this.cells.set(key, [index])
    else list.push(index)
    return index
  }
}

// ---------------------------------------------------------------------------
// Edges: one arrangement edge per split piece of a curve.
// ---------------------------------------------------------------------------

interface Edge {
  v0: number
  v1: number
  /** The exact emitted geometry, oriented v0 -> v1. */
  segment: ProfileSegment
  /** Outgoing tangent angle at v0 (walking v0 -> v1) and at v1 (walking v1 -> v0). */
  angle0: number
  angle1: number
}

function reverseSegment(segment: ProfileSegment): ProfileSegment {
  return segment.kind === 'line'
    ? { kind: 'line', a: segment.b, b: segment.a, srcId: segment.srcId }
    : { kind: 'arc', c: segment.c, r: segment.r, a0: segment.a1, a1: segment.a0, ccw: !segment.ccw, srcId: segment.srcId }
}

function lineEdge(curve: LineCurve, v0: number, v1: number, p0: Pt, p1: Pt): Edge {
  const angle0 = normalizeAngle(Math.atan2(p1[1] - p0[1], p1[0] - p0[0]))
  return {
    v0,
    v1,
    // The INTERNED vertex coordinates, so consecutive segments of a loop share an exact endpoint.
    segment: { kind: 'line', a: [p0[0], p0[1]], b: [p1[0], p1[1]], srcId: curve.srcId },
    angle0,
    angle1: normalizeAngle(angle0 + Math.PI),
  }
}

function arcEdge(curve: ArcCurve, v0: number, v1: number, t0: number, t1: number): Edge {
  const wholeCurve = !curve.closed && t0 === 0 && t1 === 1
  const theta0 = curve.start + curve.span * t0
  const theta1 = curve.start + curve.span * t1
  return {
    v0,
    v1,
    segment: {
      kind: 'arc',
      c: [curve.c[0], curve.c[1]],
      r: curve.r,
      // An unsplit arc emits its entity's own angles verbatim, so a sketch that arranges into the
      // same loops regions.ts chained produces byte-identical segments.
      a0: wholeCurve ? curve.a0 : theta0,
      a1: wholeCurve ? curve.a1 : theta1,
      ccw: true,
      srcId: curve.srcId,
    },
    // Tangent of a CCW arc is the radius rotated +90deg; walking the other way it is -90deg.
    angle0: normalizeAngle(theta0 + HALF_PI),
    angle1: normalizeAngle(theta1 - HALF_PI),
  }
}

interface Arrangement {
  edges: Edge[]
  /** Full circles that nothing crosses: already closed loops, never entered into the edge graph. */
  closedLoops: ProfileLoop[]
}

function buildArrangement(entities: readonly Sketch3dEntity[]): Arrangement {
  const curves = curvesOf(entities)
  splitAtIntersections(curves)

  const table = new VertexTable()
  const edges: Edge[] = []
  const closedLoops: ProfileLoop[] = []

  for (const curve of curves) {
    const raw = [...curve.splits].sort((a, b) => a - b)
    const params = curve.kind === 'arc' && curve.closed ? raw : [0, ...raw, 1]
    // Intern in parameter order and collapse anything that lands on the previous vertex: that is
    // both the "split coincides with an endpoint" case and the "two intersections within tolerance"
    // case, in one rule.
    const nodes: Array<{ t: number; v: number }> = []
    for (const t of params) {
      const v = table.intern(pointAt(curve, t))
      if (nodes.length > 0 && nodes[nodes.length - 1].v === v) continue
      nodes.push({ t, v })
    }

    if (curve.kind === 'arc' && curve.closed) {
      // The wrap-around duplicate the previous-node rule cannot see.
      if (nodes.length > 1 && nodes[nodes.length - 1].v === nodes[0].v) nodes.pop()
      // An uncrossed (or single-tangency) circle stays ONE closed loop, exactly as regions.ts emits
      // it -- no gratuitous split into half-arcs that would change the kernel's side-face count.
      if (nodes.length < 2) {
        closedLoops.push([{ kind: 'arc', c: [curve.c[0], curve.c[1]], r: curve.r, a0: 0, a1: TWO_PI, ccw: true, srcId: curve.srcId }])
        continue
      }
      for (let i = 0; i < nodes.length; i++) {
        const from = nodes[i]
        const to = nodes[(i + 1) % nodes.length]
        edges.push(arcEdge(curve, from.v, to.v, from.t, i + 1 < nodes.length ? to.t : to.t + 1))
      }
      continue
    }

    for (let i = 1; i < nodes.length; i++) {
      const from = nodes[i - 1]
      const to = nodes[i]
      edges.push(curve.kind === 'line'
        ? lineEdge(curve, from.v, to.v, table.points[from.v], table.points[to.v])
        : arcEdge(curve, from.v, to.v, from.t, to.t))
    }
  }

  return { edges: dedupeEdges(edges), closedLoops }
}

/** Exactly duplicated boundary (two entities drawn on top of each other) would leave two half-edges
 *  at an identical angle and split a real face into a zero-area sliver. Keep the first, in curve
 *  order, so the arrangement stays a simple graph. */
function dedupeEdges(edges: Edge[]): Edge[] {
  const seen = new Set<string>()
  const out: Edge[] = []
  for (const edge of edges) {
    const lo = Math.min(edge.v0, edge.v1)
    const hi = Math.max(edge.v0, edge.v1)
    const mid = segmentMidpoint(edge.segment)
    const key = `${lo}-${hi}|${mid[0].toFixed(6)},${mid[1].toFixed(6)}`
    if (seen.has(key)) continue
    seen.add(key)
    out.push(edge)
  }
  return out
}

function segmentMidpoint(segment: ProfileSegment): Pt {
  if (segment.kind === 'line') return [(segment.a[0] + segment.b[0]) / 2, (segment.a[1] + segment.b[1]) / 2]
  const span = segment.ccw ? positiveSpan(segment.a1 - segment.a0) : -positiveSpan(segment.a0 - segment.a1)
  const angle = segment.a0 + span / 2
  return [segment.c[0] + segment.r * Math.cos(angle), segment.c[1] + segment.r * Math.sin(angle)]
}

/** Stray geometry bounds nothing. Drop every edge with an endpoint of degree < 2, repeatedly (a
 *  chain of spurs peels one link per pass) -- the whole point of the WO: a dangling edge must be
 *  IGNORED, never fatal to the sketch's other, perfectly closed regions. */
function pruneDanglingEdges(edges: readonly Edge[]): Edge[] {
  let alive = edges.filter((edge) => edge.v0 !== edge.v1)
  for (;;) {
    const degree = new Map<number, number>()
    for (const edge of alive) {
      degree.set(edge.v0, (degree.get(edge.v0) ?? 0) + 1)
      degree.set(edge.v1, (degree.get(edge.v1) ?? 0) + 1)
    }
    const kept = alive.filter((edge) => (degree.get(edge.v0) ?? 0) >= 2 && (degree.get(edge.v1) ?? 0) >= 2)
    if (kept.length === alive.length) return kept
    alive = kept
  }
}

// ---------------------------------------------------------------------------
// Face traversal: the standard half-edge walk. Bounded faces come out CCW.
// ---------------------------------------------------------------------------

function traceFaces(edges: readonly Edge[]): ProfileLoop[] {
  const halfCount = edges.length * 2
  const sourceOf = (h: number): number => (h % 2 === 0 ? edges[h >> 1].v0 : edges[h >> 1].v1)
  const targetOf = (h: number): number => sourceOf(h ^ 1)
  const angleOf = (h: number): number => (h % 2 === 0 ? edges[h >> 1].angle0 : edges[h >> 1].angle1)
  const segmentOf = (h: number): ProfileSegment =>
    (h % 2 === 0 ? edges[h >> 1].segment : reverseSegment(edges[h >> 1].segment))

  const outgoing = new Map<number, number[]>()
  for (let h = 0; h < halfCount; h++) {
    const v = sourceOf(h)
    const list = outgoing.get(v)
    if (list === undefined) outgoing.set(v, [h])
    else list.push(h)
  }
  const slotOf = new Map<number, number>()
  for (const list of outgoing.values()) {
    list.sort((a, b) => (angleOf(a) - angleOf(b)) || (a - b))
    list.forEach((h, index) => slotOf.set(h, index))
  }

  // next(h) = at h's target, the outgoing half-edge immediately CLOCKWISE from h's own twin. This is
  // the rule that makes every bounded face a CCW cycle and every component's outer face CW.
  const nextOf = (h: number): number => {
    const twin = h ^ 1
    const list = outgoing.get(targetOf(h))!
    const slot = slotOf.get(twin)!
    return list[(slot - 1 + list.length) % list.length]
  }

  const visited = new Array<boolean>(halfCount).fill(false)
  const faces: ProfileLoop[] = []
  for (let start = 0; start < halfCount; start++) {
    if (visited[start]) continue
    const loop: ProfileLoop = []
    let h = start
    let closed = false
    for (let guard = 0; guard <= halfCount; guard++) {
      visited[h] = true
      loop.push(segmentOf(h))
      const next = nextOf(h)
      if (next === start) {
        closed = true
        break
      }
      // Unreachable in a well-formed arrangement (every half-edge belongs to exactly one face
      // cycle); a partial walk is discarded rather than emitted as a bogus region.
      if (visited[next]) break
      h = next
    }
    if (closed && area(tessellateLoopToRing(loop)) > AREA_EPS) faces.push(loop)
  }
  return faces
}

// ---------------------------------------------------------------------------
// Tessellation for area/containment math ONLY -- never emitted.
// ---------------------------------------------------------------------------

function sampleArc(segment: Extract<ProfileSegment, { kind: 'arc' }>): Pt[] {
  const span = segment.ccw ? positiveSpan(segment.a1 - segment.a0) : positiveSpan(segment.a0 - segment.a1)
  const steps = Math.max(2, Math.ceil((span / TWO_PI) * NESTING_SAMPLES_PER_TURN))
  const points: Pt[] = []
  for (let i = 0; i <= steps; i++) {
    const angle = segment.ccw
      ? segment.a0 + span * (i / steps)
      : segment.a0 - span * (i / steps)
    points.push([segment.c[0] + segment.r * Math.cos(angle), segment.c[1] + segment.r * Math.sin(angle)])
  }
  return points
}

function tessellateLoopToRing(loop: ProfileLoop): Ring {
  const points: Pt[] = []
  for (const segment of loop) {
    if (segment.kind === 'line') points.push(segment.a as Pt)
    else points.push(...sampleArc(segment).slice(0, -1))
  }
  const flat = new Float64Array(points.length * 2)
  points.forEach(([x, y], i) => {
    flat[2 * i] = x
    flat[2 * i + 1] = y
  })
  return flat
}

// ---------------------------------------------------------------------------
// Canonical orientation + total ordering (determinism).
// ---------------------------------------------------------------------------

function segmentStart(segment: ProfileSegment): Pt {
  return segment.kind === 'line'
    ? [segment.a[0], segment.a[1]]
    : [segment.c[0] + segment.r * Math.cos(segment.a0), segment.c[1] + segment.r * Math.sin(segment.a0)]
}

/** A key that is unique WITHIN one loop: an arrangement loop can hold several pieces of the same
 *  source entity (a rectangle edge split by a crossing line), so srcId alone no longer canonicalizes
 *  a rotation the way it did for whole-profile chaining. */
function segmentKey(segment: ProfileSegment): string {
  const [x, y] = segmentStart(segment)
  return `${segment.srcId}|${x.toFixed(6)},${y.toFixed(6)}`
}

function reverseLoop(loop: ProfileLoop): ProfileLoop {
  return loop.slice().reverse().map(reverseSegment)
}

function canonicalRotate(loop: ProfileLoop): ProfileLoop {
  let index = 0
  let best = segmentKey(loop[0])
  for (let i = 1; i < loop.length; i++) {
    const key = segmentKey(loop[i])
    if (key < best) {
      best = key
      index = i
    }
  }
  return [...loop.slice(index), ...loop.slice(0, index)]
}

/** Package convention (mirrors cam3d/geom2d/rings.ts and regions.ts): outer loops CCW, holes CW. */
function orientLoop(loop: ProfileLoop, desired: 'ccw' | 'cw'): ProfileLoop {
  const isCcw = area(tessellateLoopToRing(loop)) > 0
  return canonicalRotate((desired === 'ccw') === isCcw ? loop : reverseLoop(loop))
}

/** Ordered so a loop's position never depends on input order. The FIRST component is the minimum
 *  srcId regions.ts already sorted by, so single-loop-per-region sketches keep their existing region
 *  order (and therefore their existing regions[0] whole-sketch default). */
function loopOrderKey(loop: ProfileLoop): string {
  const minSrcId = loop.reduce((min, segment) => (segment.srcId < min ? segment.srcId : min), loop[0].srcId)
  const lineage = [...new Set(loop.map((segment) => segment.srcId))].sort().join('')
  return `${minSrcId}${lineage}${segmentKey(loop[0])}`
}

function compareLoops(a: ProfileLoop, b: ProfileLoop): number {
  const ka = loopOrderKey(a), kb = loopOrderKey(b)
  return ka < kb ? -1 : ka > kb ? 1 : 0
}

// ---------------------------------------------------------------------------
// Nesting classification (the SAME Clipper2 machinery regions.ts uses).
// ---------------------------------------------------------------------------

function reverseRing(ring: Ring): Ring {
  const n = ring.length / 2
  const out = new Float64Array(ring.length)
  for (let i = 0; i < n; i++) {
    out[2 * i] = ring[2 * (n - 1 - i)]
    out[2 * i + 1] = ring[2 * (n - 1 - i) + 1]
  }
  return out
}

function isContained(inner: Ring, outer: Ring): boolean {
  const a = area(outer) < 0 ? reverseRing(outer) : outer
  const b = area(inner) < 0 ? reverseRing(inner) : inner
  const innerArea = Math.abs(area(b))
  if (innerArea < AREA_EPS) return false
  const intersectionArea = Math.abs(netArea(booleanRings([a], [b], 'intersect')))
  return intersectionArea / innerArea > 0.999
}

function classifyAndBuildRegions(rawLoops: ProfileLoop[]): ProfileLoop[][] {
  const rings = rawLoops.map((loop) => tessellateLoopToRing(loop))
  const n = rawLoops.length
  const containers: number[][] = rawLoops.map(() => [])
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j && isContained(rings[j], rings[i])) containers[j].push(i)
    }
  }
  const depth = containers.map((list) => list.length)
  const parentOf = (j: number): number => {
    let best = -1
    let bestDepth = -1
    for (const i of containers[j]) {
      if (depth[i] > bestDepth) {
        bestDepth = depth[i]
        best = i
      }
    }
    return best
  }

  const regions = new Map<number, { outer: number; holes: number[] }>()
  for (let index = 0; index < n; index++) {
    if (depth[index] % 2 === 0) regions.set(index, { outer: index, holes: [] })
  }
  for (let index = 0; index < n; index++) {
    if (depth[index] % 2 !== 1) continue
    const region = regions.get(parentOf(index))
    // An odd-depth loop always has an even-depth nearest container by construction; a miss would be
    // a data-integrity error, so it is named rather than guessed at.
    if (region === undefined) {
      throw new Error(`sketch region arrangement: hole loop ${index} has no enclosing region (unexpected nesting).`)
    }
    region.holes.push(index)
  }

  return [...regions.values()]
    .map((region) => [
      orientLoop(rawLoops[region.outer], 'ccw'),
      ...region.holes.map((h) => orientLoop(rawLoops[h], 'cw')).sort(compareLoops),
    ])
    .sort((a, b) => compareLoops(a[0], b[0]))
}

// ---------------------------------------------------------------------------
// Public entry points.
// ---------------------------------------------------------------------------

/**
 * Every ENCLOSED face of the sketch's planar arrangement, unclassified and unoriented. Synchronous
 * and Clipper2-free, so `validateSketchForProfile` can answer "does this sketch enclose anything?"
 * without awaiting the wasm boot that nesting classification needs.
 *
 * An empty result is the honest "nothing is enclosed" answer -- stray, open, and branching geometry
 * all contribute what they can and are otherwise ignored.
 */
export function arrangementFaceLoops(entities: readonly Sketch3dEntity[]): ProfileLoop[] {
  const arrangement = buildArrangement(entities)
  const faces = traceFaces(pruneDanglingEdges(arrangement.edges))
  return [...faces, ...arrangement.closedLoops]
}

/**
 * The workbench's region list: every enclosed region of the sketch, with holes classified by
 * containment depth, emitted per the frozen geom-service.ts ProfileRegion contract.
 *
 * A region whose boundary is assembled from edges of SEVERAL source profiles is an ordinary member
 * of this list -- its `loops[0]` simply carries more than one distinct `srcId`, which is exactly what
 * regionSelector.ts's signature already keys a persisted selection by.
 */
export async function computeArrangementRegions(
  entities: readonly Sketch3dEntity[],
  sketchId: string,
  plane: ProfileRegion['plane'],
): Promise<ProfileRegion[]> {
  await ensureGeom2dReady()
  const rawLoops = arrangementFaceLoops(entities)
  if (rawLoops.length === 0) return []
  return classifyAndBuildRegions(rawLoops).map((loops) => ({ sketchId, plane, loops }))
}
