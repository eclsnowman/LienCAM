// Sketch -> Loop2D bake (PLAN.md 3.1 / Stage 5, ADR-0016).
//
// Pure function: a Sketch document in, Loop2D[] out. This is the ONE
// boundary between the parametric sketch world and the CAM layer — the
// operation contract (ADR 0001) never sees sketch types. Baked loops are
// indistinguishable from DXF-imported ones:
//
//   - points[]    dense polyline; arcs densified at the same 0.5 mm step
//                 the DXF importer / loop optimizer use (sampleArc).
//   - segments[]  exact line/arc geometry (LoopSegment), starting at
//                 points[0]. Closed loops INCLUDE the closing segment
//                 (last segment.to === points[0]) so no entity's arc/line
//                 identity is lost; a standalone circle is a single
//                 full-circle arc segment (loopOptimizer convention).
//   - type        contour/hole by CONTAINMENT NESTING (even depth =
//                 contour, odd = hole), then the points are oriented to
//                 match the repo-wide winding convention (CCW = contour,
//                 CW = hole, path2d.ts) so consumers that read winding
//                 agree with consumers that read type.
//
// Chaining uses the constraint graph AND geometric coincidence: coincident
// constraints union endpoint sites exactly (including transitively through
// excluded entities like points), and any two curve endpoints within
// `epsilon` are unioned too (drawn-but-unconstrained chains). Construction
// entities and bare point entities never bake (PLAN 3.4).

import type { Loop2D, LoopSegment, Vec2 } from '../../types'
import type {
  Sketch, SketchArcEntity, SketchConstraint, SketchEntity, SketchLineEntity,
  SketchEllipseEntity, SketchEllipticalArcEntity, SketchSplineEntity,
  SketchTextEntity,
} from './types'
import { expandBlocksForGeometry } from './blocks'
import { signedArea } from '../geometry/path2d'
import { sampleArc } from '../geometry/loopOptimizer'
import {
  tessellateEllipse, tessellateEllipticalArc, ellipticalArcSweepRaw,
  ELLIPTICAL_ARC_DEGENERATE_EPS,
} from './ellipse'
import { tessellateSpline, SPLINE_TESS_STEP_MM } from './spline'
import { textToWorldPolylines, isDegenerateText } from './text'
import { outlineTextToWorldContours } from './textOutline'
import {
  resolveTextPath, textOnPathToWorldPolylines, outlineTextOnPathToWorldContours,
} from './textOnPath'

// Same endpoint-join tolerance as the DXF importer (path2d JOIN_TOL).
const DEFAULT_EPSILON = 0.05
// Arc densification step, mm — matches dxfImporter segLenMM and the
// loopOptimizer resample default.
const ARC_STEP_MM = 0.5
const TWO_PI = Math.PI * 2

export interface BakeOptions {
  /** Endpoint coincidence tolerance in mm (default 0.05, DXF JOIN_TOL). */
  epsilon?: number
  /** Loop id factory (injectable for deterministic tests). */
  newId?: () => string
}

export interface BakeResult {
  loops: Loop2D[]
  /** Non-construction curve entities that baked (lines/arcs/circles). */
  bakedEntities: number
  /** Entities excluded from the bake (construction + bare points). */
  excludedEntities: number
  /** Closed-loop pairs whose outlines CROSS (WO-1479): neither contains the
   *  other, so contour/hole cannot express the pair and neither counts toward
   *  the other's nesting depth. Each id names a loop in `loops`. */
  crossingLoops: Array<{ a: string; b: string }>
}

// ---- Geometry helpers ------------------------------------------------------

// Containment tolerance, mm: a sample this close to the other loop's boundary
// is ON it (touching), never inside or outside.
const CONTAIN_EPS = 1e-6

interface Box { minX: number; minY: number; maxX: number; maxY: number }

function boxOf(pts: Vec2[]): Box {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of pts) {
    if (p.x < minX) minX = p.x
    if (p.x > maxX) maxX = p.x
    if (p.y < minY) minY = p.y
    if (p.y > maxY) maxY = p.y
  }
  return { minX, minY, maxX, maxY }
}

function boxesOverlap(a: Box, b: Box): boolean {
  return a.minX <= b.maxX + CONTAIN_EPS && b.minX <= a.maxX + CONTAIN_EPS
    && a.minY <= b.maxY + CONTAIN_EPS && b.minY <= a.maxY + CONTAIN_EPS
}

/** +1 strictly inside the closed polygon, -1 strictly outside, 0 on its boundary. */
function classifyPoint(p: Vec2, poly: Vec2[]): -1 | 0 | 1 {
  let inside = false
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const a = poly[j], b = poly[i]
    const dx = b.x - a.x, dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2)) : 0
    if (Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy)) <= CONTAIN_EPS) return 0
    if ((b.y > p.y) !== (a.y > p.y) && p.x < (a.x - b.x) * (p.y - b.y) / (a.y - b.y) + b.x) {
      inside = !inside
    }
  }
  return inside ? 1 : -1
}

/** Side of p relative to the line a->b: +1 / -1, or 0 when within CONTAIN_EPS. */
function sideOf(a: Vec2, b: Vec2, p: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len = Math.hypot(dx, dy)
  if (len === 0) return 0
  const d = (dx * (p.y - a.y) - dy * (p.x - a.x)) / len
  return Math.abs(d) <= CONTAIN_EPS ? 0 : Math.sign(d)
}

/** True when the two closed boundaries properly cross (touching does not count). */
function boundariesCross(a: Vec2[], b: Vec2[], bBox: Box): boolean {
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length]
    if (Math.max(p.x, q.x) < bBox.minX || Math.min(p.x, q.x) > bBox.maxX
      || Math.max(p.y, q.y) < bBox.minY || Math.min(p.y, q.y) > bBox.maxY) continue
    for (let j = 0; j < b.length; j++) {
      const r = b[j], s = b[(j + 1) % b.length]
      const d1 = sideOf(p, q, r), d2 = sideOf(p, q, s)
      if (d1 === 0 || d2 === 0 || d1 === d2) continue
      const d3 = sideOf(r, s, p), d4 = sideOf(r, s, q)
      if (d3 !== 0 && d4 !== 0 && d3 !== d4) return true
    }
  }
  return false
}

/**
 * Where closed loop `a`'s region sits against closed loop `b`'s: 'inside'
 * (every vertex and edge midpoint inside or on b, at least one strictly
 * inside, no boundary crossing), 'crossing' (samples on both sides, or the
 * boundaries properly cross), else 'outside'.
 */
function relateLoops(a: Vec2[], aBox: Box, b: Vec2[], bBox: Box): 'inside' | 'outside' | 'crossing' {
  if (!boxesOverlap(aBox, bBox)) return 'outside'
  let inside = false, outside = false
  for (let i = 0; i < a.length; i++) {
    const p = a[i], q = a[(i + 1) % a.length]
    for (const s of [p, { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 }]) {
      const c = classifyPoint(s, b)
      if (c > 0) inside = true
      else if (c < 0) outside = true
    }
    if (inside && outside) return 'crossing'
  }
  if (boundariesCross(a, b, bBox)) return 'crossing'
  return inside ? 'inside' : 'outside'
}

function arcEndpoint(a: SketchArcEntity, site: 'start' | 'end'): Vec2 {
  const ang = site === 'start' ? a.startAngle : a.endAngle
  return { x: a.center.x + a.radius * Math.cos(ang), y: a.center.y + a.radius * Math.sin(ang) }
}

/** CCW sweep of an arc entity, normalized to (0, 2pi]. */
function arcSweep(a: SketchArcEntity): number {
  let s = a.endAngle - a.startAngle
  while (s <= 0) s += TWO_PI
  return s
}

// A circular arc or a line always contributes exactly ONE Edge (one edgeIdx)
// carrying both its terminals, so the self-weld guard below (sourceId match)
// coincides with the OLD edgeIdx-match guard for them: their own start/end
// pairing was always excluded, and stays excluded — only an elliptical arc's
// synthetic expansion (many edgeIdx, one sourceId) needed the widened guard.
// This path is unchanged by SKC-48-R1.

// Same degenerate-sweep rule as sketchProfile.ts's ellipticalArcSweepNorm /
// DEGENERATE_EPS (src/components/model3d/workbench/sketchProfile.ts:146,
// 152-153,174-176): measure the RAW eccentric-angle delta modulo 2*pi
// (ellipse.ts's shared ellipticalArcSweepRaw), never remapped to a full
// turn — a start===end elliptical arc is a zero-length degenerate, not a
// full ellipse. (The creation-time click guard, ellipseTools.ts, uses a
// different, closeTol-scaled measure — see ellipticalArcSweepRaw's doc.)

// ---- Union-find ------------------------------------------------------------

class UnionFind {
  private parent = new Map<string, string>()
  find(k: string): string {
    let r = this.parent.get(k)
    if (r === undefined) { this.parent.set(k, k); return k }
    if (r === k) return k
    r = this.find(r)
    this.parent.set(k, r)
    return r
  }
  union(a: string, b: string): void {
    const ra = this.find(a), rb = this.find(b)
    if (ra !== rb) this.parent.set(ra, rb)
  }
}

// ---- Chain model -----------------------------------------------------------

type CurveEntity = SketchLineEntity | SketchArcEntity

interface Edge {
  entity: CurveEntity
  start: Vec2 // geometric coordinates of the 'start' terminal
  end: Vec2
}

/** One traversal step: an edge walked forward (start->end) or backward. */
interface Step {
  edge: Edge
  forward: boolean
}

function stepFrom(s: Step): Vec2 { return s.forward ? s.edge.start : s.edge.end }
function stepTo(s: Step): Vec2 { return s.forward ? s.edge.end : s.edge.start }

/** Reverse a whole traversal (used to normalize closed-loop winding). */
function reverseChain(steps: Step[]): Step[] {
  return steps.slice().reverse().map((s) => ({ edge: s.edge, forward: !s.forward }))
}

/** Emit the LoopSegment for one step (the implicit 'from' is the previous
 *  vertex). Arc entities are stored CCW start->end, so walking one
 *  backward makes it a CLOCKWISE LoopSegment arc. */
function stepSegment(s: Step): LoopSegment {
  const e = s.edge.entity
  if (e.kind === 'line') return { type: 'line', to: stepTo(s) }
  return {
    type: 'arc',
    to: stepTo(s),
    center: { x: e.center.x, y: e.center.y },
    radius: e.radius,
    clockwise: !s.forward,
  }
}

/** Dense polyline points contributed by one step, EXCLUDING its start
 *  vertex (the caller seeds the chain's first point). */
function stepPoints(s: Step): Vec2[] {
  const e = s.edge.entity
  if (e.kind === 'line') return [stepTo(s)]
  const sweep = arcSweep(e)
  return s.forward
    ? sampleArc(e.center.x, e.center.y, e.radius, e.startAngle, sweep, ARC_STEP_MM)
    : sampleArc(e.center.x, e.center.y, e.radius, e.endAngle, -sweep, ARC_STEP_MM)
}

// ---- Chain extraction (shared: bake + the offset tool) ----------------------

/** One step of a traversed entity chain, public form (the offset tool
 *  consumes this; bake keeps its internal Edge-based steps). */
export interface ChainStep {
  entity: CurveEntity
  forward: boolean
}

export interface EntityChain {
  steps: ChainStep[]
  closed: boolean
}

interface ExtractedChains {
  // `branched`: some node the walk passed through joins more than two curve
  // ends, so the greedy walk below chose one branch (read only by
  // chainComponentContaining; bake and chainContaining ignore it).
  chains: { steps: Step[]; closed: boolean; branched: boolean }[]
  circles: { center: Vec2; radius: number }[]
  // Full ellipses bake as a polygonal approximation (no ellipse LoopSegment
  // exists): a closed line-segment loop; they never chain with line/arc edges.
  ellipses: SketchEllipseEntity[]
  // Elliptical arcs to bake as STANDALONE open polygonal loops — populated
  // only in the non-expand (chainContaining / offset-tool) path. In the BAKE
  // path (expandEllipticalArcs=true) each elliptical arc is instead tessellated
  // into synthetic line Edges that thread through the chain walker with adjacent
  // lines/arcs (SKC-48), so this array is EMPTY there.
  ellipticalArcs: SketchEllipticalArcEntity[]
  // Count of elliptical-arc entities that baked (expanded OR standalone) — the
  // bakedEntities tally counts each arc as ONE entity, never its ~162 synthetic
  // tessellation segments.
  ellipticalArcCount: number
  // Splines bake as polygonal approximations too (no spline LoopSegment
  // exists): a closed spline -> closed line-segment loop, an open spline ->
  // open line-segment loop. They never chain with line/arc edges in v1.
  splines: SketchSplineEntity[]
  // Single-line text bakes to one OPEN polyline loop PER glyph stroke (the
  // engrave op consumes open curves). Never chains with line/arc edges.
  texts: SketchTextEntity[]
  edgeCount: number
  excludedEntities: number
}

/** Line segments joining consecutive polyline points; `closed` appends the
 *  closing segment back to points[0]. Used for the ellipse polygonal bake. */
function polylineSegments(points: Vec2[], closed: boolean): LoopSegment[] {
  const segs: LoopSegment[] = []
  for (let i = 1; i < points.length; i++) segs.push({ type: 'line', to: { ...points[i] } })
  if (closed && points.length > 0) segs.push({ type: 'line', to: { ...points[0] } })
  return segs
}

/** Steps 1-4 of the bake: partition entities, union coincident/geometric
 *  endpoint terminals, and walk out the chains. Shared by bakeSketch and
 *  chainContaining so the offset tool's notion of "the chain you clicked" can
 *  never disagree with what would bake — with ONE deliberate divergence
 *  (SKC-48): `expandEllipticalArcs` tessellates each elliptical arc into
 *  synthetic line Edges so a partial ellipse can chain with adjacent
 *  lines/arcs into a closed loop. bakeSketch passes `true` (cross-workspace
 *  parity — an arc+chord D-shape bakes to ONE closed loop). chainContaining
 *  passes `false` (default): the offset tool keeps its v1 behavior — an
 *  elliptical arc never enters the offset chain (it would otherwise commit
 *  hundreds of tessellation lines), and offset-tool ellipse support is a
 *  separate booked WO. Standalone full-ellipse behavior is UNCHANGED either
 *  way. */
function extractChains(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  epsilon: number,
  expandEllipticalArcs: boolean = false,
): ExtractedChains {
  // 1. Partition entities. Construction and bare points never chain.
  const edges: Edge[] = []
  const circles: { center: Vec2; radius: number }[] = []
  const ellipses: SketchEllipseEntity[] = []
  const ellipticalArcsStandalone: SketchEllipticalArcEntity[] = []
  const ellipticalArcsToExpand: SketchEllipticalArcEntity[] = []
  const splines: SketchSplineEntity[] = []
  const texts: SketchTextEntity[] = []
  let ellipticalArcCount = 0
  let excludedEntities = 0
  // Terminals eligible for the epsilon geometric-coincidence scan. A real
  // line/arc edge contributes BOTH its terminals; a synthetic elliptical-arc
  // segment contributes ONLY the arc's two TRUE endpoints (interior
  // tessellation joints are pre-unioned EXACTLY below and excluded here, so a
  // stray curve near an interior vertex can never weld into the arc).
  //
  // `sourceId` is the ORIGINAL entity id — for a real line/arc edge that is
  // its own entity.id (one edge per id, so this never changes prior
  // behavior); for a synthetic elliptical-arc segment it is the arc's own
  // id (`e.id`), shared by that arc's FIRST and LAST synthetic edge even
  // though they carry different edgeIdx values. The scan below must key off
  // sourceId, not edgeIdx: a lone arc's two true endpoints live on different
  // synthetic edges, so an edgeIdx-only guard lets them epsilon-weld to each
  // other and fabricate a closed loop out of a single open entity (SKC-48-R1
  // blocker). Two DIFFERENT entities are never expected to share a
  // sourceId, so this is strictly narrower than the old edgeIdx check.
  const epsilonTerminals: { edgeIdx: number; site: 'start' | 'end'; sourceId: string }[] = []
  const pushEdge = (
    edge: Edge, eligibleSites: readonly ('start' | 'end')[], sourceId: string,
  ): void => {
    const idx = edges.length
    edges.push(edge)
    for (const site of eligibleSites) epsilonTerminals.push({ edgeIdx: idx, site, sourceId })
  }
  for (const e of entities) {
    if (e.construction || e.kind === 'point') { excludedEntities++; continue }
    // A block is one rigid object, never part of a loose chain. bakeSketch
    // flattens blocks into world members BEFORE calling this (expandBlocksForGeometry),
    // so a block only reaches here via chainContaining (offset tool) -- exclude
    // it rather than let it fall through to the arc path.
    if (e.kind === 'block') { excludedEntities++; continue }
    if (e.kind === 'circle') {
      if (e.radius > epsilon) circles.push({ center: e.center, radius: e.radius })
      else excludedEntities++
      continue
    }
    if (e.kind === 'ellipse') {
      if (e.majorRadius > epsilon && e.minorRadius > epsilon) ellipses.push(e)
      else excludedEntities++
      continue
    }
    if (e.kind === 'elliptical-arc') {
      // Zero/near-zero sweep (start === end) is degenerate — NOT a full turn.
      // ellipticalArcSweep (ellipse.ts) deliberately remaps s<=0 to a full
      // 2*pi turn for point-sampling callers; that remap is wrong here and
      // was the equal-parameter half of the SKC-48-R1 blocker (the sampler
      // would silently tessellate a full ellipse for a zero-sweep arc).
      // Reject on the RAW delta instead, matching cross-workspace parity
      // rule byte-for-byte (sketchProfile.ts DEGENERATE_EPS=1e-9 /
      // ellipticalArcSweepNorm, src/components/model3d/workbench/
      // sketchProfile.ts:146,152-153,174-176).
      const rawSweep = ellipticalArcSweepRaw(e.startParam, e.endParam)
      if (e.majorRadius > epsilon && e.minorRadius > epsilon
          && rawSweep > ELLIPTICAL_ARC_DEGENERATE_EPS) {
        ellipticalArcCount++
        if (expandEllipticalArcs) ellipticalArcsToExpand.push(e)
        else ellipticalArcsStandalone.push(e)
      } else excludedEntities++
      continue
    }
    if (e.kind === 'spline') {
      // Needs >= 2 distinct points to span any length.
      if (e.points.length >= 2) splines.push(e)
      else excludedEntities++
      continue
    }
    if (e.kind === 'text') {
      // Degenerate (empty/whitespace string or height<=0) bakes nothing.
      if (!isDegenerateText(e.text, e.height)) texts.push(e)
      else excludedEntities++
      continue
    }
    if (e.kind === 'line') {
      if (Math.hypot(e.end.x - e.start.x, e.end.y - e.start.y) <= 1e-9) {
        excludedEntities++
        continue
      }
      pushEdge({ entity: e, start: e.start, end: e.end }, ['start', 'end'], e.id)
      continue
    }
    // arc
    pushEdge(
      { entity: e, start: arcEndpoint(e, 'start'), end: arcEndpoint(e, 'end') },
      ['start', 'end'], e.id,
    )
  }

  // Real line/arc edge count, captured BEFORE synthetic elliptical-arc edges
  // are appended — the bakedEntities tally counts each arc as ONE, never ~162.
  const edgeCount = edges.length

  // 1b. Expand each elliptical arc into a chain of synthetic `line` Edges from
  //     the SHARED tessellateEllipticalArc sampler (mirroring the 3D modeling workspace
  //     tessellatedLineEntities pattern, sketchProfile.ts). Each synthetic edge
  //     carries a UNIQUE per-segment id (`${e.id}~ell${i}`) so its terminal
  //     keys are distinct union-find nodes. Consecutive synthetic edges share
  //     the exact vertex object, so interior joints are pre-unioned EXACTLY
  //     (never epsilon, never a constraint); only the arc's two TRUE endpoints
  //     participate in the epsilon scan and the constraint bridge.
  interface ArcBridge { realStartKey: string; firstStartKey: string; realEndKey: string; lastEndKey: string }
  const arcBridges: ArcBridge[] = []
  const interiorUnions: [string, string][] = []
  for (const e of ellipticalArcsToExpand) {
    const pts = tessellateEllipticalArc(e, e.startParam, e.endParam)
    // pts is an OPEN polyline (>= 17 points): pts.length - 1 synthetic segments.
    let firstStartKey = ''
    let lastEndKey = ''
    let prevEndKey: string | null = null
    for (let i = 0; i + 1 < pts.length; i++) {
      const synthId = `${e.id}~ell${i}`
      const synth: SketchLineEntity = {
        id: synthId, kind: 'line', construction: false, start: pts[i], end: pts[i + 1],
      }
      const isFirst = i === 0
      const isLast = i + 2 >= pts.length
      const eligible: ('start' | 'end')[] = []
      if (isFirst) eligible.push('start')
      if (isLast) eligible.push('end')
      pushEdge({ entity: synth, start: pts[i], end: pts[i + 1] }, eligible, e.id)
      const startKey = `${synthId}:start`
      const endKey = `${synthId}:end`
      if (isFirst) firstStartKey = startKey
      if (isLast) lastEndKey = endKey
      if (prevEndKey !== null) interiorUnions.push([prevEndKey, startKey])
      prevEndKey = endKey
    }
    arcBridges.push({
      realStartKey: `${e.id}:start`, firstStartKey,
      realEndKey: `${e.id}:end`, lastEndKey,
    })
  }

  // 2. Union endpoint terminals.
  //    Node key = `${entityId}:${site}` so coincident constraints union the
  //    EXACT sites they name — including transitively through entities that
  //    do not bake (a point entity joining two lines still joins them).
  const uf = new UnionFind()
  const terminalKey = (edge: Edge, site: 'start' | 'end') => `${edge.entity.id}:${site}`

  for (const c of constraints) {
    if (c.kind !== 'coincident') continue
    uf.union(`${c.a.entityId}:${c.a.site}`, `${c.b.entityId}:${c.b.site}`)
  }
  // Constraint bridge (SKC-48): coincident constraints name the REAL arc sites
  // (`${id}:start`/`${id}:end`), which no synthetic edge terminal carries —
  // union them onto the synthetic chain's true-endpoint terminals so a
  // constraint-closed D-shape threads through the graph even when the chord
  // sits geometrically far from the arc (both `:start` AND `:end` are required;
  // dropping either leaves the constraint case open — mutation-proofed).
  for (const br of arcBridges) {
    uf.union(br.realStartKey, br.firstStartKey)
    uf.union(br.realEndKey, br.lastEndKey)
  }
  // Interior tessellation joints: EXACT pre-union (consecutive synthetic edges
  // share the vertex) — never epsilon, never a constraint.
  for (const [a, b] of interiorUnions) uf.union(a, b)

  // Geometric coincidence within epsilon (O(n^2); sketches are small). Only
  // epsilon-eligible terminals participate (real line/arc endpoints + each
  // arc's two TRUE endpoints); interior synthetic joints are excluded by
  // construction. Terminals sharing a sourceId are NEVER epsilon-unioned —
  // this is a SOURCE-ENTITY guard, not merely "not the same edge": a lone
  // elliptical arc's two true endpoints sit on different synthetic edgeIdx
  // values but the SAME source entity, and a short-sweep arc can bring them
  // within epsilon of each other. Unioning them would weld the arc's own
  // start to its own end and fabricate a closed region out of a single open
  // entity (SKC-48-R1 blocker) — same-entity self-closure must come ONLY
  // from an explicit coincident constraint naming both its own sites (not
  // supported today), never from geometric proximity.
  for (let i = 0; i < epsilonTerminals.length; i++) {
    const ti = epsilonTerminals[i]
    const pi = ti.site === 'start' ? edges[ti.edgeIdx].start : edges[ti.edgeIdx].end
    for (let j = i + 1; j < epsilonTerminals.length; j++) {
      const tj = epsilonTerminals[j]
      if (tj.sourceId === ti.sourceId) continue
      const pj = tj.site === 'start' ? edges[tj.edgeIdx].start : edges[tj.edgeIdx].end
      if (Math.hypot(pi.x - pj.x, pi.y - pj.y) <= epsilon) {
        uf.union(terminalKey(edges[ti.edgeIdx], ti.site), terminalKey(edges[tj.edgeIdx], tj.site))
      }
    }
  }

  // 3. Adjacency: node root -> terminals of unused edges.
  interface Terminal { edgeIdx: number; site: 'start' | 'end' }
  const adjacency = new Map<string, Terminal[]>()
  const addTerminal = (root: string, t: Terminal) => {
    const arr = adjacency.get(root)
    if (arr) arr.push(t)
    else adjacency.set(root, [t])
  }
  edges.forEach((edge, i) => {
    addTerminal(uf.find(terminalKey(edge, 'start')), { edgeIdx: i, site: 'start' })
    addTerminal(uf.find(terminalKey(edge, 'end')), { edgeIdx: i, site: 'end' })
  })

  // 4. Extract chains. Open chains first (seed at degree-1 nodes) so a
  //    closed walk never starts mid-way along an open run; leftovers are
  //    closed chains. Degree->2 junctions: the walk takes the first unused
  //    terminal (v1 behavior, same spirit as the DXF greedy join).
  const used = new Array<boolean>(edges.length).fill(false)
  const nodeOf = (edgeIdx: number, site: 'start' | 'end') =>
    uf.find(terminalKey(edges[edgeIdx], site))
  const degree = (root: string) =>
    (adjacency.get(root) ?? []).filter((t) => !used[t.edgeIdx]).length
  const takeNext = (root: string): Terminal | null => {
    for (const t of adjacency.get(root) ?? []) if (!used[t.edgeIdx]) return t
    return null
  }

  const isJunction = (root: string) => (adjacency.get(root) ?? []).length > 2
  const walk = (seed: Terminal): { steps: Step[]; closed: boolean; branched: boolean } => {
    const steps: Step[] = []
    const startNode = nodeOf(seed.edgeIdx, seed.site)
    let branched = isJunction(startNode)
    let t: Terminal | null = seed
    let atNode = startNode
    while (t) {
      used[t.edgeIdx] = true
      const forward = t.site === 'start'
      steps.push({ edge: edges[t.edgeIdx], forward })
      atNode = nodeOf(t.edgeIdx, forward ? 'end' : 'start')
      if (isJunction(atNode)) branched = true
      if (atNode === startNode) return { steps, closed: true, branched }
      t = takeNext(atNode)
    }
    return { steps, closed: false, branched }
  }

  const chains: { steps: Step[]; closed: boolean; branched: boolean }[] = []
  // Open-chain seeds: terminals whose node has remaining degree 1.
  for (let i = 0; i < edges.length; i++) {
    if (used[i]) continue
    for (const site of ['start', 'end'] as const) {
      if (!used[i] && degree(nodeOf(i, site)) === 1) {
        chains.push(walk({ edgeIdx: i, site }))
        break
      }
    }
  }
  // Remaining edges form closed chains.
  for (let i = 0; i < edges.length; i++) {
    if (!used[i]) chains.push(walk({ edgeIdx: i, site: 'start' }))
  }

  return {
    chains, circles, ellipses, ellipticalArcs: ellipticalArcsStandalone,
    ellipticalArcCount, splines, texts,
    edgeCount, excludedEntities,
  }
}

/**
 * The chain containing `entityId` (coincident-constraint + geometric
 * endpoint chaining, EXACTLY the bake's), or null when the entity does
 * not chain (construction, point, circle, or unknown id). Standalone
 * circles are not chains — the caller handles them directly.
 */
export function chainContaining(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  entityId: string,
  epsilon: number = DEFAULT_EPSILON,
): EntityChain | null {
  const ch = chainComponentContaining(entities, constraints, entityId, epsilon)
  return ch === null ? null : { steps: ch.steps, closed: ch.closed }
}

/** chainContaining's chain plus whether it is the UNIQUE ordered path through
 *  its connected component. */
export interface ChainComponent extends EntityChain {
  /** true when a node on this chain joins more than two curve ends: the walk
   *  picked one branch, so the chain is one possible path, not the only one. */
  branched: boolean
}

/** Same extraction and the same chain as chainContaining, with the branch
 *  flag a caller needs before it may treat the chain as unambiguous. */
export function chainComponentContaining(
  entities: readonly SketchEntity[],
  constraints: readonly SketchConstraint[],
  entityId: string,
  epsilon: number = DEFAULT_EPSILON,
): ChainComponent | null {
  const { chains } = extractChains(entities, constraints, epsilon)
  for (const ch of chains) {
    if (ch.steps.some((s) => s.edge.entity.id === entityId)) {
      return {
        steps: ch.steps.map((s) => ({ entity: s.edge.entity, forward: s.forward })),
        closed: ch.closed,
        branched: ch.branched,
      }
    }
  }
  return null
}

// ---- Bake ------------------------------------------------------------------

export function bakeSketch(sketch: Sketch, opts: BakeOptions = {}): BakeResult {
  const epsilon = opts.epsilon ?? DEFAULT_EPSILON
  const newId = opts.newId ?? (() => crypto.randomUUID())
  const layerId = sketch.layerId

  // Blocks (SKC-BLOCKS) bake by flattening into their WORLD member geometry +
  // internal constraints, then running the IDENTICAL loop bake loose entities
  // use. Doing this here (not a special path) is what makes a baked block
  // indistinguishable from its exploded loose form -- the ADR-0019 stable-id
  // guarantee across group/explode/scale.
  const flat = expandBlocksForGeometry(sketch.entities, sketch.constraints, sketch.blockDefs)

  const {
    chains, circles, ellipses, ellipticalArcs, ellipticalArcCount, splines, texts,
    edgeCount, excludedEntities,
  } = extractChains(flat.entities, flat.constraints, epsilon, /* expandEllipticalArcs */ true)

  // 5. Tessellate chains (provisional orientation = traversal order).
  const emit = (steps: Step[], closed: boolean): { points: Vec2[]; segments: LoopSegment[] } => {
    const points: Vec2[] = [stepFrom(steps[0])]
    const segments: LoopSegment[] = []
    for (const s of steps) {
      points.push(...stepPoints(s))
      segments.push(stepSegment(s))
    }
    if (closed) {
      // Loop2D convention (path2d): closed loops do not repeat the first
      // point. The closing SEGMENT stays (its 'to' is the first vertex),
      // retargeted onto points[0] exactly so segment and polyline agree.
      points.pop()
      segments[segments.length - 1] = { ...segments[segments.length - 1], to: points[0] }
    }
    return { points, segments }
  }

  interface RawLoop {
    steps: Step[] | null // null = standalone circle / ellipse polyline
    circle?: { center: Vec2; radius: number }
    /** Set for ellipse / elliptical-arc loops: the ordered polyline points
     *  (closed loops carry no duplicate first point). Winding reversal just
     *  reverses this list and rebuilds the line segments. */
    polyline?: Vec2[]
    closed: boolean
    points: Vec2[]
    segments: LoopSegment[]
  }

  const raw: RawLoop[] = []
  for (const ch of chains) {
    const { points, segments } = emit(ch.steps, ch.closed)
    raw.push({ steps: ch.steps, closed: ch.closed, points, segments })
  }
  for (const c of circles) {
    // CCW full circle starting at angle 0; winding normalized below.
    const start = { x: c.center.x + c.radius, y: c.center.y }
    const pts = [start, ...sampleArc(c.center.x, c.center.y, c.radius, 0, TWO_PI, ARC_STEP_MM)]
    pts.pop() // closed: no duplicate of the first point
    raw.push({
      steps: null,
      circle: c,
      closed: true,
      points: pts,
      segments: [{ type: 'arc', to: start, center: { ...c.center }, radius: c.radius, clockwise: false }],
    })
  }
  // Full ellipses: closed polygonal loop (line segments). Drop the closing
  // duplicate point so it matches the Loop2D closed convention.
  for (const e of ellipses) {
    const pts = tessellateEllipse(e)
    pts.pop() // remove the repeated first point
    raw.push({
      steps: null, polyline: pts, closed: true, points: pts,
      segments: polylineSegments(pts, true),
    })
  }
  // Elliptical arcs: STANDALONE open polygonal loop (line segments, no closing
  // edge). In the BAKE path this array is EMPTY — elliptical arcs are expanded
  // into synthetic chainable Edges above (extractChains, expandEllipticalArcs)
  // so they thread with neighbours into closed loops (SKC-48). This fallback
  // only fires if the sampler ever runs in non-expand mode.
  for (const e of ellipticalArcs) {
    const pts = tessellateEllipticalArc(e, e.startParam, e.endParam)
    raw.push({
      steps: null, polyline: pts, closed: false, points: pts,
      segments: polylineSegments(pts, false),
    })
  }
  // Splines: closed -> closed polygonal loop (drop the duplicate closing
  // point to match the Loop2D closed convention); open -> open polygonal loop.
  for (const e of splines) {
    const pts = tessellateSpline(e.points, e.closed, SPLINE_TESS_STEP_MM, e.form)
    if (e.closed) {
      pts.pop() // remove the repeated first point
      raw.push({
        steps: null, polyline: pts, closed: true, points: pts,
        segments: polylineSegments(pts, true),
      })
    } else {
      raw.push({
        steps: null, polyline: pts, closed: false, points: pts,
        segments: polylineSegments(pts, false),
      })
    }
  }
  // Text bakes by font style:
  //  - 'single-line': each glyph stroke -> one OPEN polyline loop (the engrave
  //    op consumes open curves). One text entity yields many open loops.
  //  - 'outline': each glyph CONTOUR and interior HOLE -> one CLOSED polyline
  //    loop. Contour/hole typing is left to the containment-nesting pass below
  //    (an 'O' = outer contour at depth 0 + inner hole at depth 1), exactly as
  //    for any other closed geometry -- no special-casing here.
  for (const e of texts) {
    // TEXT-ON-PATH: a resolvable pathId warps the local layout onto the curve;
    // a missing/unsampleable pathId falls back to the free layout + a notice.
    const path = resolveTextPath(e, sketch.entities)
    if (e.fontStyle === 'outline') {
      const contours = path
        ? outlineTextOnPathToWorldContours(e, path)
        : outlineTextToWorldContours(
            e.text, e.height, e.at, e.rotation ?? 0,
            {
              fontFamily: e.fontFamily, mirrored: e.mirrored,
              letterSpacingMm: e.letterSpacingMm,
            },
          )
      for (const c of contours) {
        if (c.points.length < 3) continue
        raw.push({
          steps: null, polyline: c.points, closed: true, points: c.points,
          segments: polylineSegments(c.points, true),
        })
      }
    } else {
      const strokes = path
        ? textOnPathToWorldPolylines(e, path)
        : textToWorldPolylines(
            e.text, e.height, e.at, e.rotation ?? 0,
            { mirrored: e.mirrored, letterSpacingMm: e.letterSpacingMm },
          )
      for (const pts of strokes) {
        if (pts.length < 2) continue
        raw.push({
          steps: null, polyline: pts, closed: false, points: pts,
          segments: polylineSegments(pts, false),
        })
      }
    }
  }

  // 6. Contour/hole typing by containment nesting (even depth = contour,
  //    odd = hole) — winding as drawn carries no meaning in a sketch.
  //    WO-1479: a loop counts as inside another only when its WHOLE region
  //    is (boundary contact allowed), never because one sampled vertex tests
  //    inside. Crossing outlines are not a contour/hole pair: neither counts
  //    toward the other's depth, and the pair is named in crossingLoops.
  const loopIds = raw.map(() => newId())
  const closedIdx = raw.flatMap((r, i) => (r.closed ? [i] : []))
  const boxes = new Map(closedIdx.map((i) => [i, boxOf(raw[i].points)]))
  const depths = new Map(closedIdx.map((i) => [i, 0]))
  const crossingLoops: Array<{ a: string; b: string }> = []
  for (let m = 0; m < closedIdx.length; m++) {
    for (let k = m + 1; k < closedIdx.length; k++) {
      const i = closedIdx[m], j = closedIdx[k]
      const ij = relateLoops(raw[i].points, boxes.get(i)!, raw[j].points, boxes.get(j)!)
      const ji = ij === 'inside'
        ? 'outside'
        : relateLoops(raw[j].points, boxes.get(j)!, raw[i].points, boxes.get(i)!)
      if (ij === 'crossing' || ji === 'crossing') {
        crossingLoops.push({ a: loopIds[i], b: loopIds[j] })
        continue
      }
      if (ij === 'inside') depths.set(i, depths.get(i)! + 1)
      if (ji === 'inside') depths.set(j, depths.get(j)! + 1)
    }
  }

  // 7. Normalize winding to the repo convention (path2d: CCW = contour,
  //    CW = hole) so type and winding never disagree downstream.
  const loops: Loop2D[] = raw.map((r, i) => {
    if (!r.closed) {
      return {
        id: loopIds[i], points: r.points, closed: false, type: 'open' as const,
        layerId, area: 0, segments: r.segments,
      }
    }
    const type = depths.get(i)! % 2 === 0 ? ('contour' as const) : ('hole' as const)
    const area = signedArea(r.points)
    const wantCCW = type === 'contour'
    let { points, segments } = r
    if ((area >= 0) !== wantCCW) {
      if (r.steps) {
        ;({ points, segments } = emit(reverseChain(r.steps), true))
      } else if (r.polyline) {
        // Ellipse polygonal loop: reverse the point order, rebuild segments.
        points = [...r.polyline].reverse()
        segments = polylineSegments(points, true)
      } else {
        // Standalone circle: re-sample clockwise.
        const c = r.circle!
        const start = { x: c.center.x + c.radius, y: c.center.y }
        points = [start, ...sampleArc(c.center.x, c.center.y, c.radius, 0, -TWO_PI, ARC_STEP_MM)]
        points.pop()
        segments = [{ type: 'arc', to: start, center: { ...c.center }, radius: c.radius, clockwise: true }]
      }
    }
    return {
      id: loopIds[i], points, closed: true, type, layerId,
      area: Math.abs(signedArea(points)), segments,
    }
  })

  return {
    loops,
    bakedEntities:
      edgeCount + circles.length + ellipses.length + ellipticalArcCount
      + splines.length + texts.length,
    excludedEntities,
    crossingLoops,
  }
}
