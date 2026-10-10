// Polygon + straight slot tools (Stage 6, PLAN 3.5 CREATE v1).
//
// Same pure-machine contract as rectTools.ts: a click either advances the
// in-progress chain or returns a ToolCommit; the document is never touched
// here, and the preview is built from the SAME geometry builders the
// commit uses, so the preview always IS what the next click commits.
//
//   polygon: click CENTER -> move sets the inscribed/circumscribed radius
//            AND rotation with a live N-gon preview -> click
//            commits N chained lines.
//   slot:    click cap center A -> click cap center B (axis) -> move sets
//            the half-width with a full slot outline preview -> click
//            commits 2 parallel lines + 2 semicircular end arcs.
//
// Constraint doctrine (minimal but honest):
//   polygon: N coincident corner constraints closing the chain + N-1
//            equal-length constraints between consecutive sides. NOTE
//            (honest): equal sides + closure pin the shape family but do
//            NOT fully rigidify regularity for N >= 4 (a rhombus has
//            four equal sides); interior-angle constraints are
//            deliberately omitted per the minimal-set doctrine.
//   slot:    4 coincident (caps meet the lines at their shared endpoints)
//            + 4 tangent (each cap tangent to BOTH lines — a true slot)
//            + 1 equal radius between the caps. With the arcs' internal
//            rules this leaves exactly the 5 physical DoF of a rigid
//            slot: position (2), rotation (1), length (1), radius (1).
//            The lines are parallel by construction and held so by the
//            tangency network — no separate parallel constraint needed.

import type { Vec2, SketchEntity, SketchConstraint } from '../types'
import type { ToolCommit } from './toolMachine'
import { arcThrough3Points, tessellateArc } from './arcTools'
import { definingSlotCenterline, definingArcSlotCenterline } from './definingGeometry'

// ---- Polygon ---------------------------------------------------------------

/** In-progress polygon (chain payload after the center click). */
export interface PolygonChainState {
  kind: 'polygon'
  center: Vec2
}

export type PolygonMode = 'inscribed' | 'circumscribed'

/**
 * Regular polygon vertices. Inscribed mode puts vertex 0 at the cursor.
 * Circumscribed mode treats the cursor as the midpoint of side 0, so its
 * distance from center is the apothem.
 */
export function polygonVertices(
  center: Vec2,
  cursor: Vec2,
  sides: number,
  mode: PolygonMode = 'inscribed',
): Vec2[] {
  const pickedRadius = Math.hypot(cursor.x - center.x, cursor.y - center.y)
  const a0 = Math.atan2(cursor.y - center.y, cursor.x - center.x)
  const halfStep = Math.PI / sides
  const r = mode === 'circumscribed'
    ? pickedRadius / Math.cos(halfStep)
    : pickedRadius
  const firstAngle = mode === 'circumscribed' ? a0 - halfStep : a0
  const out: Vec2[] = []
  for (let k = 0; k < sides; k++) {
    const a = firstAngle + (k * 2 * Math.PI) / sides
    out.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) })
  }
  return out
}

/**
 * N chained lines + the Stage 6 constraint set: N coincident corners
 * (including the closing joint) and N-1 equal-length constraints between
 * consecutive sides.
 */
export function buildPolygonCommit(
  center: Vec2,
  cursor: Vec2,
  sides: number,
  construction: boolean,
  newId: () => string,
  mode: PolygonMode = 'inscribed',
): ToolCommit {
  const verts = polygonVertices(center, cursor, sides, mode)
  const entities: SketchEntity[] = []
  const ids: string[] = []
  for (let i = 0; i < sides; i++) {
    const id = newId()
    ids.push(id)
    const s = verts[i]
    const e = verts[(i + 1) % sides]
    entities.push({
      id,
      kind: 'line',
      construction,
      start: { x: s.x, y: s.y },
      end: { x: e.x, y: e.y },
    })
  }
  const referenceCircleId = newId()
  const referenceCircle: SketchEntity = {
    id: referenceCircleId,
    kind: 'circle',
    construction: true,
    center: { x: center.x, y: center.y },
    radius: Math.hypot(cursor.x - center.x, cursor.y - center.y),
  }

  const constraints: SketchConstraint[] = []
  // Corner chain (closing included): line i's end meets line (i+1)'s start.
  for (let i = 0; i < sides; i++) {
    constraints.push({
      id: newId(),
      kind: 'coincident',
      a: { entityId: ids[i], site: 'end' },
      b: { entityId: ids[(i + 1) % sides], site: 'start' },
    })
  }
  // Equal length between consecutive sides — N-1 of them chains every
  // side to side 0 transitively; the Nth would be redundant.
  for (let i = 0; i < sides - 1; i++) {
    constraints.push({ id: newId(), kind: 'equal', a: ids[i], b: ids[i + 1] })
  }

  // The reference circle is persistent, construction-only, and solver-tied.
  // Inscribed vertices lie on it; circumscribed sides are tangent to it.
  // Dimensioning the circle resizes the polygon while preserving its family.
  for (let i = 0; i < sides; i++) {
    constraints.push(mode === 'inscribed'
      ? {
          id: newId(),
          kind: 'point_on_object',
          point: { entityId: ids[i], site: 'start' },
          object: referenceCircleId,
        }
      : {
          id: newId(),
          kind: 'tangent',
          a: ids[i],
          b: referenceCircleId,
        })
  }
  return { entities: [...entities, referenceCircle], constraints }
}

export interface PolygonClickResult {
  chain: PolygonChainState | null
  commit: ToolCommit | null
}

/**
 * First click anchors the center; the second click (the cursor = vertex 0)
 * commits unless degenerate (radius within the click tolerance). `sides`
 * comes from the toolbox input (>= 3; the store clamps).
 */
export function polygonClick(
  chain: PolygonChainState | null,
  world: Vec2,
  closeTol: number,
  sides: number,
  construction: boolean,
  newId: () => string,
  mode: PolygonMode = 'inscribed',
): PolygonClickResult {
  if (!chain) {
    return {
      chain: { kind: 'polygon', center: { x: world.x, y: world.y } },
      commit: null,
    }
  }
  if (Math.hypot(world.x - chain.center.x, world.y - chain.center.y) <= closeTol) {
    return { chain, commit: null }
  }
  return {
    chain: null,
    commit: buildPolygonCommit(chain.center, world, sides, construction, newId, mode),
  }
}

/** Closed (n+1)-point outline for the rubber band; null while degenerate. */
export function polygonPreview(
  chain: PolygonChainState,
  cursor: Vec2,
  sides: number,
  mode: PolygonMode = 'inscribed',
): Vec2[] | null {
  if (
    Math.hypot(cursor.x - chain.center.x, cursor.y - chain.center.y) < 1e-9
  ) return null
  const verts = polygonVertices(chain.center, cursor, sides, mode)
  return [...verts, { x: verts[0].x, y: verts[0].y }]
}

// ---- Straight slot ---------------------------------------------------------

/** In-progress slot: cap center A, then cap center B, then the width click. */
export interface SlotChainState {
  kind: 'slot'
  /** First cap center. */
  a: Vec2
  /** Second cap center; null until the second click lands. */
  b: Vec2 | null
}

/** Slot outline geometry for cap centers a/b and cap radius r (half-width).
 *  Shared by preview and commit. Sites: each line runs CAP-A-side ->
 *  CAP-B-side on its own side; arcs are canonical CCW (types.ts), so the
 *  cap at B spans [theta-pi/2, theta+pi/2] (bulging away from A) and the
 *  cap at A spans [theta+pi/2, theta+3pi/2]. */
export function slotGeometry(a: Vec2, b: Vec2, r: number) {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  const u = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
  const n = { x: -u.y, y: u.x }
  const theta = Math.atan2(u.y, u.x)
  return {
    theta,
    lineTop:    { start: { x: a.x + r * n.x, y: a.y + r * n.y },
                  end:   { x: b.x + r * n.x, y: b.y + r * n.y } },
    lineBottom: { start: { x: b.x - r * n.x, y: b.y - r * n.y },
                  end:   { x: a.x - r * n.x, y: a.y - r * n.y } },
    // CCW sweep through theta: bulges away from A (the +u side).
    arcB: { center: { x: b.x, y: b.y }, radius: r,
            startAngle: theta - Math.PI / 2, endAngle: theta + Math.PI / 2 },
    // CCW sweep through theta+pi: bulges away from B (the -u side).
    arcA: { center: { x: a.x, y: a.y }, radius: r,
            startAngle: theta + Math.PI / 2, endAngle: theta + (3 * Math.PI) / 2 },
  }
}

/**
 * 2 lines + 2 semicircle cap arcs with the true-slot constraint set:
 * 4 coincident joints, 4 tangencies (each cap tangent to both lines),
 * 1 equal cap radius.
 */
export function buildSlotCommit(
  a: Vec2,
  b: Vec2,
  r: number,
  construction: boolean,
  newId: () => string,
): ToolCommit {
  const g = slotGeometry(a, b, r)
  const topId = newId()
  const bottomId = newId()
  const arcBId = newId()
  const arcAId = newId()

  const entities: SketchEntity[] = [
    { id: topId, kind: 'line', construction,
      start: g.lineTop.start, end: g.lineTop.end },
    { id: bottomId, kind: 'line', construction,
      start: g.lineBottom.start, end: g.lineBottom.end },
    { id: arcBId, kind: 'arc', construction,
      center: g.arcB.center, radius: g.arcB.radius,
      startAngle: g.arcB.startAngle, endAngle: g.arcB.endAngle },
    { id: arcAId, kind: 'arc', construction,
      center: g.arcA.center, radius: g.arcA.radius,
      startAngle: g.arcA.startAngle, endAngle: g.arcA.endAngle },
  ]

  // Cap-to-line joints. Arc point sites are angle-derived: an arc's
  // 'start' sits at startAngle, 'end' at endAngle. arcB: start = B-side
  // bottom, end = B-side top. arcA: start = A-side top, end = A-side
  // bottom (see slotGeometry sweeps).
  const constraints: SketchConstraint[] = [
    { id: newId(), kind: 'coincident',
      a: { entityId: topId, site: 'end' },      b: { entityId: arcBId, site: 'end' } },
    { id: newId(), kind: 'coincident',
      a: { entityId: arcBId, site: 'start' },   b: { entityId: bottomId, site: 'start' } },
    { id: newId(), kind: 'coincident',
      a: { entityId: bottomId, site: 'end' },   b: { entityId: arcAId, site: 'end' } },
    { id: newId(), kind: 'coincident',
      a: { entityId: arcAId, site: 'start' },   b: { entityId: topId, site: 'start' } },
    // Both caps tangent to both sides — the true-slot condition.
    { id: newId(), kind: 'tangent', a: topId,    b: arcBId },
    { id: newId(), kind: 'tangent', a: bottomId, b: arcBId },
    { id: newId(), kind: 'tangent', a: topId,    b: arcAId },
    { id: newId(), kind: 'tangent', a: bottomId, b: arcAId },
    // Equal cap radii: without it the caps could solve to different radii
    // (a valid tangent network, but not a slot).
    { id: newId(), kind: 'equal', a: arcAId, b: arcBId },
  ]

  // C2: persistent construction CENTERLINE — two cap-center points (each
  // coincident to its cap arc's center) joined by a construction line. Tree
  // structure: DoF-neutral, no redundancy. Appended after the cut entities.
  const def = definingSlotCenterline(
    { center: g.arcA.center, arcId: arcAId },
    { center: g.arcB.center, arcId: arcBId },
    newId,
  )
  return { entities: [...entities, ...def.entities], constraints: [...constraints, ...def.constraints] }
}

export interface SlotClickResult {
  chain: SlotChainState | null
  commit: ToolCommit | null
}

/** Perpendicular distance from p to the infinite line through a-b. */
function distToAxis(a: Vec2, b: Vec2, p: Vec2): number {
  const len = Math.hypot(b.x - a.x, b.y - a.y)
  if (len < 1e-12) return Math.hypot(p.x - a.x, p.y - a.y)
  return Math.abs(
    ((b.x - a.x) * (a.y - p.y) - (a.x - p.x) * (b.y - a.y)) / len
  )
}

/**
 * Three clicks: cap center A, cap center B (degenerate-axis clicks are
 * ignored), then the width click (cursor's perpendicular distance to the
 * axis = cap radius = half the slot width; a click ON the axis is
 * degenerate and ignored).
 */
export function slotClick(
  chain: SlotChainState | null,
  world: Vec2,
  closeTol: number,
  construction: boolean,
  newId: () => string,
): SlotClickResult {
  if (!chain) {
    return { chain: { kind: 'slot', a: { x: world.x, y: world.y }, b: null }, commit: null }
  }
  if (chain.b === null) {
    if (Math.hypot(world.x - chain.a.x, world.y - chain.a.y) <= closeTol) {
      return { chain, commit: null } // zero-length axis
    }
    return { chain: { kind: 'slot', a: chain.a, b: { x: world.x, y: world.y } }, commit: null }
  }
  const r = distToAxis(chain.a, chain.b, world)
  if (r <= closeTol) {
    return { chain, commit: null } // zero-width slot
  }
  return { chain: null, commit: buildSlotCommit(chain.a, chain.b, r, construction, newId) }
}

/** Tessellated cap arc (CCW from a0 to a1), endpoints exact. */
function arcPoints(center: Vec2, r: number, a0: number, a1: number, steps = 16): Vec2[] {
  const pts: Vec2[] = []
  for (let i = 0; i <= steps; i++) {
    const a = a0 + ((a1 - a0) * i) / steps
    pts.push({ x: center.x + r * Math.cos(a), y: center.y + r * Math.sin(a) })
  }
  return pts
}

/** Slot preview: axis rubber band after the first click, full outline
 *  while the width click is pending (cursor distance = cap radius). */
export function slotPreview(chain: SlotChainState, cursor: Vec2): Vec2[] | null {
  if (chain.b === null) {
    return [chain.a, { x: cursor.x, y: cursor.y }]
  }
  const r = distToAxis(chain.a, chain.b, cursor)
  if (r < 1e-9) return [chain.a, chain.b] // on-axis: show the axis
  const g = slotGeometry(chain.a, chain.b, r)
  // Walk the outline: top line A->B, cap B (top -> bottom, i.e. the arc
  // traversed end -> start), bottom line B->A, cap A (top half reversed).
  return [
    g.lineTop.start,
    g.lineTop.end,
    ...arcPoints(g.arcB.center, r, g.arcB.endAngle, g.arcB.startAngle),
    g.lineBottom.start,
    g.lineBottom.end,
    ...arcPoints(g.arcA.center, r, g.arcA.endAngle, g.arcA.startAngle),
    g.lineTop.start,
  ]
}

// ---- Arc slot (Tier 2c) ----------------------------------------------------
//
// A slot whose CENTERLINE is a circular arc. The centerline arc is defined
// by 3 clicks exactly like the 3-point arc tool (start, end, then a point
// the arc passes through), and a 4th click sets the slot WIDTH as the
// cursor's perpendicular distance to the centerline (= the cap radius =
// half the slot width). The outline is 4 arcs:
//
//   outer    concentric arc at radius centerRadius + halfWidth
//   inner    concentric arc at radius centerRadius - halfWidth
//   capEnd   semicircle at the centerline END point (angle a1)
//   capStart semicircle at the centerline START point (angle a0)
//
// Same emission style as the straight slot (a set of arc entities + a
// minimal-but-honest constraint network), so it bakes through the SAME
// generic line/arc chaining path (bake.ts) with no special case.
//
// Constraint doctrine (matching the straight slot's true-slot precedent):
//   4 coincident joints closing the outline loop, 1 concentric (inner and
//   outer share the centerline center), 1 equal cap radii, 4 tangent
//   (WO-1465: each cap arc tangent to its adjoining outer/inner body arc,
//   so the boundary joins can't kink). The construction centerline's
//   radius tracks the body's half-width (see definingArcSlotCenterline);
//   only its angular span stays free — full parametric rigidity of the
//   sweep is a later pass.

/** In-progress arc slot: centerline start, then end, then the through point,
 *  then the width click. */
export interface ArcSlotChainState {
  kind: 'slotArc'
  /** Click 1: centerline arc start. */
  start: Vec2
  /** Click 2: centerline arc end; null until placed. */
  end: Vec2 | null
  /** Click 3: a point the centerline arc passes through; null until placed. */
  thru: Vec2 | null
}

/** One arc of the outline (center + radius + CCW-increasing angle span;
 *  angle span is suitable both for entity storage and direct tessellation). */
export interface ArcSpec {
  center: Vec2
  radius: number
  startAngle: number
  endAngle: number
}

export interface ArcSlotGeometry {
  center: Vec2
  centerRadius: number
  /** Centerline span: a0 and a0 + sweep (sweep in (0, 2*pi]). */
  startAngle: number
  sweep: number
  outer: ArcSpec
  inner: ArcSpec
  capStart: ArcSpec
  capEnd: ArcSpec
}

const TWO_PI = Math.PI * 2
function norm2pi(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

/**
 * Arc-slot outline geometry for a centerline arc through start/end/thru and a
 * half-width (cap radius). Null when the three centerline points are
 * (near-)collinear (no arc), the half-width is non-positive, or the
 * half-width is >= the centerline radius (the inner arc would invert).
 */
export function arcSlotGeometry(
  start: Vec2, end: Vec2, thru: Vec2, halfWidth: number, tol: number,
): ArcSlotGeometry | null {
  const built = arcThrough3Points(start, end, thru, tol)
  if (!built) return null
  const C = built.center
  const R = built.radius
  if (halfWidth <= 0 || halfWidth >= R) return null
  // CCW span from a0 to a0 + sweep (the intended arc through `thru`).
  const a0 = built.startAngle
  const sweep = norm2pi(built.endAngle - built.startAngle) || TWO_PI
  const a1 = a0 + sweep
  // Centerline endpoints (the cap centers).
  const P0 = { x: C.x + R * Math.cos(a0), y: C.y + R * Math.sin(a0) }
  const P1 = { x: C.x + R * Math.cos(a1), y: C.y + R * Math.sin(a1) }
  return {
    center: { x: C.x, y: C.y },
    centerRadius: R,
    startAngle: a0,
    sweep,
    // Concentric body arcs, CCW a0 -> a1.
    outer: { center: { x: C.x, y: C.y }, radius: R + halfWidth, startAngle: a0, endAngle: a1 },
    inner: { center: { x: C.x, y: C.y }, radius: R - halfWidth, startAngle: a0, endAngle: a1 },
    // capEnd: semicircle at P1 from outer.end (a1) CCW to inner.end (a1+pi).
    capEnd: { center: P1, radius: halfWidth, startAngle: a1, endAngle: a1 + Math.PI },
    // capStart: semicircle at P0 from inner.start (a0+pi) CCW to outer.start (a0+2pi).
    capStart: { center: P0, radius: halfWidth, startAngle: a0 + Math.PI, endAngle: a0 + TWO_PI },
  }
}

function arcEntity(
  id: string, spec: ArcSpec, construction: boolean,
): SketchEntity {
  return {
    id, kind: 'arc', construction,
    center: { x: spec.center.x, y: spec.center.y }, radius: spec.radius,
    startAngle: spec.startAngle, endAngle: spec.endAngle,
  }
}

/**
 * 4 outline arcs + the minimal-but-honest arc-slot constraint set (4
 * coincident joints, 1 concentric, 1 equal cap radii). Null on the same
 * degenerate inputs arcSlotGeometry rejects.
 */
export function buildArcSlotCommit(
  start: Vec2, end: Vec2, thru: Vec2, halfWidth: number, tol: number,
  construction: boolean, newId: () => string,
): ToolCommit | null {
  const g = arcSlotGeometry(start, end, thru, halfWidth, tol)
  if (!g) return null
  const outerId = newId()
  const innerId = newId()
  const capStartId = newId()
  const capEndId = newId()

  const entities: SketchEntity[] = [
    arcEntity(outerId, g.outer, construction),
    arcEntity(innerId, g.inner, construction),
    arcEntity(capEndId, g.capEnd, construction),
    arcEntity(capStartId, g.capStart, construction),
  ]

  // Arc point sites are angle-derived: 'start' sits at startAngle, 'end' at
  // endAngle. The four joints close the outline loop:
  //   outer.end == capEnd.start, capEnd.end == inner.end,
  //   inner.start == capStart.start, capStart.end == outer.start.
  const constraints: SketchConstraint[] = [
    { id: newId(), kind: 'coincident',
      a: { entityId: outerId, site: 'end' },   b: { entityId: capEndId, site: 'start' } },
    { id: newId(), kind: 'coincident',
      a: { entityId: capEndId, site: 'end' },   b: { entityId: innerId, site: 'end' } },
    { id: newId(), kind: 'coincident',
      a: { entityId: innerId, site: 'start' },  b: { entityId: capStartId, site: 'start' } },
    { id: newId(), kind: 'coincident',
      a: { entityId: capStartId, site: 'end' }, b: { entityId: outerId, site: 'start' } },
    // Inner and outer body arcs share the centerline center.
    { id: newId(), kind: 'concentric', a: innerId, b: outerId },
    // Equal cap radii: both caps stay the same half-width.
    { id: newId(), kind: 'equal', a: capStartId, b: capEndId },
    // WO-1465: boundary tangency at all 4 joints (matching the straight
    // slot's true-slot doctrine) -- without these the coincident joints
    // alone let the caps meet the body at a kink, which is exactly the
    // 1.1-2.0deg tangent mismatch BUG-493 found once the centerline radius
    // was edited off the as-drawn value.
    { id: newId(), kind: 'tangent', a: outerId, b: capEndId },
    { id: newId(), kind: 'tangent', a: innerId, b: capEndId },
    { id: newId(), kind: 'tangent', a: innerId, b: capStartId },
    { id: newId(), kind: 'tangent', a: outerId, b: capStartId },
  ]

  // C2: persistent construction CENTERLINE ARC (concentric to the outer body
  // arc -> center tracks; radius/diameter-dimensionable) + two cap-center
  // construction points (each coincident to its cap arc's center). WO-1465:
  // the centerline's radius now TRACKS the body's half-width (see
  // definingArcSlotCenterline) instead of sitting as a disconnected free
  // DoF; only its angular span stays free. Appended after the cut.
  const def = definingArcSlotCenterline(
    { center: g.capStart.center, arcId: capStartId },
    { center: g.capEnd.center, arcId: capEndId },
    { arcId: outerId, startAt: { x: g.center.x + g.outer.radius * Math.cos(g.outer.startAngle),
                                  y: g.center.y + g.outer.radius * Math.sin(g.outer.startAngle) } },
    { arcId: innerId, startAt: { x: g.center.x + g.inner.radius * Math.cos(g.inner.startAngle),
                                  y: g.center.y + g.inner.radius * Math.sin(g.inner.startAngle) } },
    { center: g.center, radius: g.centerRadius,
      startAngle: g.startAngle, endAngle: g.startAngle + g.sweep },
    newId,
  )
  return { entities: [...entities, ...def.entities], constraints: [...constraints, ...def.constraints] }
}

export interface ArcSlotClickResult {
  chain: ArcSlotChainState | null
  commit: ToolCommit | null
  notice: string | null
}

/**
 * Four clicks: centerline start, centerline end (a degenerate zero-length
 * click is ignored), a through point that shapes the centerline arc (a
 * collinear click that forms no arc is ignored), then the width click
 * (perpendicular distance to the centerline = cap radius; zero-width or
 * over-wide clicks are ignored — fail-loud, ADR-0003).
 */
export function arcSlotClick(
  chain: ArcSlotChainState | null,
  world: Vec2,
  closeTol: number,
  construction: boolean,
  newId: () => string,
): ArcSlotClickResult {
  if (!chain) {
    return {
      chain: { kind: 'slotArc', start: { x: world.x, y: world.y }, end: null, thru: null },
      commit: null, notice: null,
    }
  }
  if (chain.end === null) {
    if (Math.hypot(world.x - chain.start.x, world.y - chain.start.y) <= closeTol) {
      return { chain, commit: null, notice: null } // zero-length centerline
    }
    return { chain: { ...chain, end: { x: world.x, y: world.y } }, commit: null, notice: null }
  }
  if (chain.thru === null) {
    // The through point must form an actual arc (not collinear).
    if (arcThrough3Points(chain.start, chain.end, world, closeTol) === null) {
      return { chain, commit: null, notice: null }
    }
    return { chain: { ...chain, thru: { x: world.x, y: world.y } }, commit: null, notice: null }
  }
  // Width click: half-width = cursor's perpendicular distance to the centerline.
  const center = arcThrough3Points(chain.start, chain.end, chain.thru, closeTol)
  if (!center) return { chain, commit: null, notice: null }
  const halfWidth = Math.abs(
    Math.hypot(world.x - center.center.x, world.y - center.center.y) - center.radius,
  )
  if (halfWidth <= closeTol) {
    return {
      chain, commit: null,
      notice: 'Arc slot: that width is zero - move off the centerline to set a usable width',
    }
  }
  if (halfWidth >= center.radius) {
    return {
      chain, commit: null,
      notice: `Arc slot: that width is too wide for this centerline radius (max ${center.radius.toFixed(3)} mm) - the inner boundary would invert`,
    }
  }
  const commit = buildArcSlotCommit(
    chain.start, chain.end, chain.thru, halfWidth, closeTol, construction, newId,
  )
  if (!commit) return { chain, commit: null, notice: null }
  return { chain: null, commit, notice: null }
}

/** Arc-slot preview: a straight rubber band to the cursor before the
 *  centerline is defined, the live centerline arc while the through point is
 *  pending, then the full outline while the width click is pending. */
export function arcSlotPreview(chain: ArcSlotChainState, cursor: Vec2): Vec2[] | null {
  if (chain.end === null) {
    return [chain.start, { x: cursor.x, y: cursor.y }]
  }
  if (chain.thru === null) {
    const arc = arcThrough3Points(chain.start, chain.end, cursor, 0)
    if (!arc) return [chain.start, { x: cursor.x, y: cursor.y }, chain.end]
    return tessellateArc(arc)
  }
  const center = arcThrough3Points(chain.start, chain.end, chain.thru, 0)
  if (!center) return [chain.start, chain.thru, chain.end]
  const halfWidth = Math.abs(
    Math.hypot(cursor.x - center.center.x, cursor.y - center.center.y) - center.radius,
  )
  if (halfWidth < 1e-9 || halfWidth >= center.radius) {
    return tessellateArc(center) // degenerate width: show the centerline
  }
  const g = arcSlotGeometry(chain.start, chain.end, chain.thru, halfWidth, 0)!
  // Walk the closed outline: outer (a0->a1), capEnd (outer.end->inner.end),
  // inner reversed (inner.end->inner.start), capStart (inner.start->outer.start).
  return [
    ...arcPoints(g.outer.center, g.outer.radius, g.outer.startAngle, g.outer.endAngle),
    ...arcPoints(g.capEnd.center, g.capEnd.radius, g.capEnd.startAngle, g.capEnd.endAngle),
    ...arcPoints(g.inner.center, g.inner.radius, g.inner.endAngle, g.inner.startAngle),
    ...arcPoints(g.capStart.center, g.capStart.radius, g.capStart.startAngle, g.capStart.endAngle),
  ]
}
