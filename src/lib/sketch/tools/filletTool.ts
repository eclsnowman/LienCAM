// Sketch fillet tool (Stage 6 chunk 1, PLAN.md 3.5 MODIFY v1).
//
// Armed tool with a radius input in the toolbox. Click two lines — or a
// SHARED CORNER POINT where two line endpoints meet (rectangle corners) —
// and a tangent arc of the given radius is inserted at the corner:
//   - both lines are trimmed back to the exact tangency points
//   - the arc is constructed analytically tangent to BOTH lines (TRUE
//     fillet: center equidistant from both infinite lines at R, touch
//     points on the perpendicular feet) — tangency is geometric fact,
//     the constraints then preserve it through future solves
//   - tangent + coincident constraints are added on BOTH joints
//   - the corner's own coincident constraint (the two corner sites) is
//     removed; everything else survives
//   - a radius that does not fit the corner is rejected with a notice
//     naming the maximum usable radius — never a silent no-op
//
// PURE module following the toolMachine pattern: clicks RETURN the
// replacement document arrays; the store applies them as one undo step.

import type {
  Vec2,
  PointRef,
  SketchEntity,
  SketchArcEntity,
  SketchLineEntity,
  SketchConstraint,
  SketchDimension,
} from '../types'
import {
  trimCircularFilletHost,
  trimGeneralFilletHost,
  type CircularFilletHost,
  type CircularFilletHostTrim,
  type GeneralFilletHost,
  type GeneralFilletHostTrim,
  type SketchDoc,
  type SketchDocTransform,
} from './trimTool'
import { arcSamplePoints, GHOST_ARC_DENSITY } from '../sketcher/geometry/arcTessellation'
import { buildTheoreticalCorner, refEq } from './theoreticalCorner'
import {
  detachProjectedFixes,
  markProjectedGeometryDetached,
  projectedProvenance,
} from '../projectedEdit'
import { classifyChainMax, type ChainMaxResult, type StagedSizeDragRegion } from './stagedSizeDrag'
import { curveDistance, entityIntersections } from '../snap'
import { ellipseParamFromPoint, ellipsePointAt, ellipticalArcSweep } from '../ellipse'
import {
  nearestParamOnSpline, splineAsThroughPoints, splineDerivativeAt, splineHasControlSites, splinePointAt,
} from '../spline'

const TWO_PI = Math.PI * 2
const EPS_LEN = 1e-6   // mm: a trimmed line may not collapse below this
const EPS_TOUCH = 1e-6 // mm: two endpoints within this form a corner
const EPS_ANG = 1e-9   // rad: parallel / degenerate angle guard
const EPS_PARAM = 1e-9 // native curve parameter ordering guard
const EPS_CORNER = 1e-4 // mm: a re-resolved corner point within this of a
                        // staged corner's `at` is the SAME corner (unselect)
// SKC-46-R1 (BLOCKER 1): filletLines rejects any radius with tDist >= availMin - EPS_LEN, so a
// "ceiling" reported as the exact tDist==availMin boundary is unusable -- staging it, then
// recomputing radius/tan(half) on Apply, can float-round back to >= availMin - EPS_LEN (the
// auditor's 3.9999999999999996-on-a-4mm-corner case). Reserving a MARGIN double the constructor's
// own EPS_LEN keeps every seeded ceiling strictly inside the accept region after that round trip.
// SKC-46-R2 (named ruling, R1 audit minor, OUT OF SCOPE this round): this fixed 2e-6mm margin is
// sized for machining-scale coordinates (sub-meter parts); it loses meaning as a safety buffer once
// sketch coordinates approach ~1e10mm, where float64 ULP spacing itself exceeds the margin. Left
// unbounded deliberately -- outside any real machining domain -- rather than silently dropped.
const CEILING_MARGIN = 2 * EPS_LEN

function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

// ---- Chain state (CHAINING payload) -----------------------------------------

/** One accumulated corner: the two lines plus the side hints that chose
 *  the kept side of each (the clicks, or the far endpoints for corner /
 *  selection picks). `at` is the corner location (display + dedup). */
export interface FilletCornerPick {
  aId: string
  bId: string
  hintA: Vec2
  hintB: Vec2
  at: Vec2
}

export interface FilletChainState {
  kind: 'fillet'
  /** Corners accumulated for the batch apply (overlay Apply commits
   *  them ALL as one undo step). */
  corners: FilletCornerPick[]
  /** Line clicked but not yet paired with a second line. */
  pendingLineId: string | null
  /** Where the pending line was clicked (kept-side hint). */
  pendingClick: Vec2 | null
}

export interface FilletClickOutcome {
  chain: FilletChainState | null
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

function pickFilletHost(
  entities: readonly SketchEntity[], world: Vec2, tol: number,
): GeneralFilletHost | null {
  let best: { e: GeneralFilletHost; d: number } | null = null
  for (const e of entities) {
    if (e.kind !== 'line' && e.kind !== 'arc' && e.kind !== 'circle' &&
        e.kind !== 'ellipse' && e.kind !== 'elliptical-arc' && e.kind !== 'spline') continue
    const d = e.kind === 'line'
      ? segDistance(world, e.start, e.end)
      : curveDistance(e, world)
    if (d <= tol && (!best || d < best.d)) best = { e, d }
  }
  return best?.e ?? null
}

interface Corner {
  a: SketchLineEntity | SketchArcEntity
  b: SketchLineEntity | SketchArcEntity
  /** The shared corner location (the coincident endpoints). */
  at: Vec2
}

function openHostEndpoints(
  host: SketchLineEntity | SketchArcEntity,
): Array<{ site: 'start' | 'end'; p: Vec2 }> {
  if (host.kind === 'line') {
    return [{ site: 'start', p: host.start }, { site: 'end', p: host.end }]
  }
  return [
    { site: 'start', p: {
      x: host.center.x + host.radius * Math.cos(host.startAngle),
      y: host.center.y + host.radius * Math.sin(host.startAngle),
    } },
    { site: 'end', p: {
      x: host.center.x + host.radius * Math.cos(host.endAngle),
      y: host.center.y + host.radius * Math.sin(host.endAngle),
    } },
  ]
}

/** Shared corner under the cursor: two line/arc endpoints (from different
 * hosts) that sit on the same spot within EPS_TOUCH, nearest the click. */
function pickCorner(
  entities: readonly SketchEntity[], world: Vec2, tol: number,
): Corner | null {
  const ends: Array<{ host: SketchLineEntity | SketchArcEntity; p: Vec2 }> = []
  for (const e of entities) {
    if (e.kind !== 'line' && e.kind !== 'arc') continue
    for (const { p } of openHostEndpoints(e)) {
      if (dist(p, world) <= tol) ends.push({ host: e, p })
    }
  }
  let best: { corner: Corner; d: number } | null = null
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (ends[i].host.id === ends[j].host.id) continue
      if (dist(ends[i].p, ends[j].p) > EPS_TOUCH) continue
      const d = dist(ends[i].p, world)
      if (!best || d < best.d) {
        best = { corner: { a: ends[i].host, b: ends[j].host, at: ends[i].p }, d }
      }
    }
  }
  return best?.corner ?? null
}

// ---- Fillet construction ---------------------------------------------------------

interface TrimSide {
  line: SketchLineEntity
  /** Unit direction from the corner toward the KEPT side. */
  dir: Vec2
  /** Endpoint that moves to the tangency point. */
  movedSite: 'start' | 'end'
  /** Usable length from the corner along the kept direction. */
  avail: number
}

/** Infinite-line intersection of two lines, or null when parallel. */
function lineLineIntersection(a: SketchLineEntity, b: SketchLineEntity): Vec2 | null {
  const dax = a.end.x - a.start.x, day = a.end.y - a.start.y
  const dbx = b.end.x - b.start.x, dby = b.end.y - b.start.y
  const denom = dax * dby - day * dbx
  if (Math.abs(denom) < 1e-12) return null
  const wx = b.start.x - a.start.x, wy = b.start.y - a.start.y
  const t = (wx * dby - wy * dbx) / denom
  return { x: a.start.x + t * dax, y: a.start.y + t * day }
}

/** Resolve which side of `line` is KEPT (the side of the hint point,
 *  measured from the corner C) and how much length is available. */
function trimSide(line: SketchLineEntity, C: Vec2, hint: Vec2): TrimSide | null {
  const dx = line.end.x - line.start.x
  const dy = line.end.y - line.start.y
  const len = Math.hypot(dx, dy)
  if (len <= EPS_LEN) return null
  const ux = dx / len, uy = dy / len
  const tC = (C.x - line.start.x) * ux + (C.y - line.start.y) * uy
  const tH = (hint.x - line.start.x) * ux + (hint.y - line.start.y) * uy
  if (Math.abs(tH - tC) <= EPS_LEN) return null // hint AT the corner: ambiguous
  const keepEnd = tH > tC // kept side runs toward line.end
  const dir = keepEnd ? { x: ux, y: uy } : { x: -ux, y: -uy }
  const far = keepEnd ? line.end : line.start
  const avail = (far.x - C.x) * dir.x + (far.y - C.y) * dir.y
  if (avail <= EPS_LEN) return null // the whole line is on the other side
  return { line, dir, movedSite: keepEnd ? 'start' : 'end', avail }
}

export interface FilletResult {
  transform: SketchDocTransform
  /** The created arc (the caller may select/highlight it). */
  arcId: string
  /** Construction point at the untrimmed host-line intersection. */
  phantomPointId: string
  /** The driving radius dimension created on the arc, or null when the
   *  caller asked NOT to add one (batch apply links extra arcs by an
   *  equal-radius constraint to a single shared driving dim instead). */
  radiusDimId: string | null
}

export interface FilletOptions {
  /** Add a DRIVING radius dimension on the new arc (default true). The
   *  fillet radius is otherwise a free degree of freedom — without a
   *  dimension the arc cannot be resized after the fact, which is exactly
   *  the editability gap this closes. Batch apply passes false for the
   *  follower corners and ties them to the lead arc with an equal-radius
   *  constraint (one driving dim drives the whole set). */
  radiusDim?: boolean
}

/**
 * SKC-75: re-anchor any EXISTING dimension whose endpoint/point PointRef
 * targets one of the two corner sites a fillet is ABOUT to trim
 * (`siteA`/`siteB`) onto the theoretical corner's phantom point instead.
 *
 * Without this, a length dimension carrying `{a: {line, site: 'end'}, ...}`
 * silently keeps resolving to that SAME site after the fillet -- but
 * buildTheoreticalCorner has already moved the real line's endpoint IN to
 * the tangency point (the visible trim), so the dimension's measured/driven
 * span silently becomes the TRIMMED corner-to-corner distance instead of the
 * original one. A DRIVING dimension then fights the fillet: solving
 * trimmed-distance == 120 pushes the corner back OUT, growing the whole
 * rectangle by (fillet radius) per re-driven side -- Operator's exact report.
 *
 * Only `distance` / `distanceX` / `distanceY` / `ordinate` (two PointRef
 * endpoints each) and `distancePL` (one PointRef point) carry a site-level PointRef that could
 * land on a trimmed corner; every other dimension kind references a whole
 * ENTITY by id (radius/diameter/angle/etc.) and is structurally unaffected.
 * Byte-stable (returns the SAME array/dimension references) when nothing
 * needs re-anchoring, matching this module's existing convention.
 */
export function reanchorDimensionsToTheoreticalCorner(
  dimensions: readonly SketchDimension[],
  siteA: PointRef | null,
  siteB: PointRef | null,
  phantomRef: PointRef,
): SketchDimension[] {
  const remap = (ref: PointRef): PointRef =>
    (siteA !== null && refEq(ref, siteA)) || (siteB !== null && refEq(ref, siteB))
      ? phantomRef
      : ref
  let changed = false
  const next = dimensions.map((d) => {
    if (d.kind === 'distance' || d.kind === 'distanceX' || d.kind === 'distanceY') {
      const a = remap(d.a), b = remap(d.b)
      if (a === d.a && b === d.b) return d
      changed = true
      return { ...d, a, b }
    }
    // WO-1867: an ordinate's datum OR its measured point can be the corner the
    // fillet just trimmed in. Without this it would keep resolving to the moved
    // endpoint and a driving ordinate would fight the fillet back out, the same
    // way a driving distance did before this re-anchoring existed.
    if (d.kind === 'ordinate') {
      const origin = remap(d.origin), point = remap(d.point)
      if (origin === d.origin && point === d.point) return d
      changed = true
      return { ...d, origin, point }
    }
    // WO-1868: any of a three-point angle's vertex / leg points can be the
    // trimmed-in corner; re-anchor them to the phantom like a distance does.
    if (d.kind === 'angle3') {
      const vertex = remap(d.vertex), a = remap(d.a), b = remap(d.b)
      if (vertex === d.vertex && a === d.a && b === d.b) return d
      changed = true
      return { ...d, vertex, a, b }
    }
    if (d.kind === 'distancePL') {
      const point = remap(d.point)
      if (point === d.point) return d
      changed = true
      return { ...d, point }
    }
    return d
  })
  return changed ? next : (dimensions as SketchDimension[])
}

/**
 * Insert a tangent fillet arc of `radius` at the corner of lines a/b.
 * `hintA`/`hintB` choose the kept side of each line (the clicks, or the
 * far endpoints for a shared-corner click). Returns the transform or a
 * rejection string (parallel / does not fit, with the max usable radius).
 *
 * The arc carries two TANGENT constraints (one per leg) that hold the
 * tangency through future solves, two endpoint COINCIDENTs that close the
 * profile, and — by default — a DRIVING RADIUS dimension. The radius
 * dimension is the arc's adjustable freedom: editing it resizes the
 * fillet (the tangents slide their touch points along the legs to suit).
 */
function filletLinePair(
  doc: SketchDoc,
  aId: string,
  bId: string,
  hintA: Vec2,
  hintB: Vec2,
  radius: number,
  newId: () => string = () => crypto.randomUUID(),
  opts: FilletOptions = {},
): FilletResult | string {
  const addRadiusDim = opts.radiusDim ?? true
  if (!(radius > 0)) return 'Fillet: radius must be positive'
  const a = doc.entities.find((e) => e.id === aId)
  const b = doc.entities.find((e) => e.id === bId)
  if (!a || a.kind !== 'line' || !b || b.kind !== 'line') {
    return 'Fillet: both picks must be lines'
  }
  const C = lineLineIntersection(a, b)
  if (!C) return 'Fillet: the lines are parallel - no corner to fillet'

  const sideA = trimSide(a, C, hintA)
  const sideB = trimSide(b, C, hintB)
  if (!sideA || !sideB) return 'Fillet: could not resolve the corner sides'

  // Corner opening angle between the two kept directions.
  const cosT = Math.max(-1, Math.min(1, sideA.dir.x * sideB.dir.x + sideA.dir.y * sideB.dir.y))
  const theta = Math.acos(cosT)
  if (theta <= EPS_ANG || Math.PI - theta <= EPS_ANG) {
    return 'Fillet: the lines are collinear - no corner to fillet'
  }

  // Tangency distance from the corner along each line, and the fit check.
  const half = theta / 2
  const tDist = radius / Math.tan(half)
  const availMin = Math.min(sideA.avail, sideB.avail)
  if (tDist >= availMin - EPS_LEN) {
    const maxR = Math.tan(half) * availMin
    return `Fillet: R${radius} does not fit this corner - max usable radius is ${maxR.toFixed(2)} mm`
  }

  const TA: Vec2 = { x: C.x + sideA.dir.x * tDist, y: C.y + sideA.dir.y * tDist }
  const TB: Vec2 = { x: C.x + sideB.dir.x * tDist, y: C.y + sideB.dir.y * tDist }

  // Arc center: along the angle bisector, R/sin(theta/2) from the corner.
  const bisX = sideA.dir.x + sideB.dir.x
  const bisY = sideA.dir.y + sideB.dir.y
  const bisLen = Math.hypot(bisX, bisY)
  const O: Vec2 = {
    x: C.x + (bisX / bisLen) * (radius / Math.sin(half)),
    y: C.y + (bisY / bisLen) * (radius / Math.sin(half)),
  }

  // CCW winding: the fillet sweeps pi - theta (< pi), so exactly one of
  // the two orderings is the short CCW way around.
  const aA = norm(Math.atan2(TA.y - O.y, TA.x - O.x))
  const aB = norm(Math.atan2(TB.y - O.y, TB.x - O.x))
  const startsAtA = norm(aB - aA) <= Math.PI
  const arcId = newId()
  const arc: SketchArcEntity = {
    id: arcId,
    kind: 'arc',
    construction: a.construction && b.construction,
    provenance: projectedProvenance(a, b),
    center: O,
    radius,
    startAngle: startsAtA ? aA : aB,
    endAngle: startsAtA ? aB : aA,
  }
  const phantomPointId = newId()

  // The corner's own coincident (the two moved sites) is consumed by the
  // fillet; every other constraint survives.
  const cornerSiteA: PointRef = { entityId: a.id, site: sideA.movedSite }
  const cornerSiteB: PointRef = { entityId: b.id, site: sideB.movedSite }

  // Both joints: location-exact coincident AND tangent (hard rule:
  // every joint 1-for-1 coincident and 100 percent tangent).
  const joints: SketchConstraint[] = [
    { id: newId(), kind: 'coincident',
      a: { entityId: arcId, site: startsAtA ? 'start' : 'end' }, b: cornerSiteA },
    { id: newId(), kind: 'coincident',
      a: { entityId: arcId, site: startsAtA ? 'end' : 'start' }, b: cornerSiteB },
    { id: newId(), kind: 'tangent', a: arcId, b: a.id },
    { id: newId(), kind: 'tangent', a: arcId, b: b.id },
  ]
  const theoretical = buildTheoreticalCorner(doc, {
    hostA: a,
    hostB: b,
    corner: C,
    trimA: { site: sideA.movedSite, at: TA },
    trimB: { site: sideB.movedSite, at: TB },
    phantomPointId,
    hostAPinId: newId(),
    hostBPinId: newId(),
  })

  // SKC-75 (Operator, from the road, chrome_6EtNqzI0jj.png): a length dimension
  // anchored at a CORNER SITE the fillet is trimming (cornerSiteA/B) is
  // re-anchored to the theoretical corner's phantom point, so the driven
  // corner-to-corner span stays the pre-fillet distance -- fillet then trims
  // INTO that theoretical corner without forcing the whole rectangle to grow
  // by the fillet radius per side. See reanchorDimensionsToTheoreticalCorner
  // for the full rationale.
  const reanchoredDimensions = reanchorDimensionsToTheoreticalCorner(
    doc.dimensions, cornerSiteA, cornerSiteB, theoretical.phantomRef,
  )

  // Driving radius dimension (the editable size). Label sits on the arc at
  // its mid-sweep so it reads beside the fillet. Omitted when the caller
  // links this arc to a shared dim via equal-radius (batch apply).
  const dimensions: SketchDimension[] = [...reanchoredDimensions]
  let radiusDimId: string | null = null
  if (addRadiusDim) {
    radiusDimId = newId()
    const midAngle = arc.startAngle + norm(arc.endAngle - arc.startAngle) / 2
    dimensions.push({
      id: radiusDimId,
      kind: 'radius',
      driving: true,
      value: radius,
      entityId: arcId,
      labelAnchor: {
        x: O.x + radius * Math.cos(midAngle),
        y: O.y + radius * Math.sin(midAngle),
      },
    })
  }

  return {
    transform: {
      entities: markProjectedGeometryDetached(
        doc.entities,
        [...theoretical.entities, arc],
        [a.id, b.id],
      ),
      constraints: detachProjectedFixes(doc.entities, [
        ...theoretical.constraints,
        ...joints,
        ...theoretical.pinConstraints,
      ], [a.id, b.id]),
      dimensions,
    },
    arcId,
    phantomPointId,
    radiusDimId,
  }
}

// ---- Circular-host fillet construction --------------------------------------

interface OffsetLine {
  kind: 'line'
  point: Vec2
  dir: Vec2
  normal: Vec2
}

interface OffsetCircle {
  kind: 'circle'
  center: Vec2
  radius: number
  /** Direction from host center to tangency relative to center-to-locus. */
  radialSign: 1 | -1
}

type OffsetLocus = OffsetLine | OffsetCircle

interface CircularCandidate {
  center: Vec2
  tangentA: Vec2
  tangentB: Vec2
  trimA: CircularFilletHostTrim
  trimB: CircularFilletHostTrim
  score: number
}

function hostTangent(host: GeneralFilletHost, at: Vec2): Vec2 | null {
  if (host.kind === 'line') {
    const x = host.end.x - host.start.x, y = host.end.y - host.start.y
    const len = Math.hypot(x, y)
    return len > EPS_LEN ? { x: x / len, y: y / len } : null
  }
  if (host.kind === 'arc' || host.kind === 'circle') {
    const x = at.x - host.center.x, y = at.y - host.center.y
    const len = Math.hypot(x, y)
    return len > EPS_LEN ? { x: -y / len, y: x / len } : null
  }
  const d = nativeDerivative(host, nativeParam(host, at))
  const len = Math.hypot(d.x, d.y)
  return len > EPS_LEN ? { x: d.x / len, y: d.y / len } : null
}

function selectSharpIntersection(
  a: GeneralFilletHost, b: GeneralFilletHost, hintA: Vec2, hintB: Vec2,
): Vec2 | string {
  if ((a.kind === 'arc' || a.kind === 'circle') &&
      (b.kind === 'arc' || b.kind === 'circle') &&
      dist(a.center, b.center) <= EPS_LEN) {
    return 'Fillet: the circular hosts are concentric - no unique corner'
  }
  const intersections = entityIntersections(a, b)
  if (intersections.length === 0) {
    return 'Fillet: the selected curve spans are disjoint'
  }
  const ranked = intersections
    .map((point) => ({ point, score: dist(point, hintA) + dist(point, hintB) }))
    .sort((x, y) => x.score - y.score)
  if (ranked.length > 1 && Math.abs(ranked[1].score - ranked[0].score) <= EPS_TOUCH) {
    return 'Fillet: the picks are ambiguous between two intersections'
  }
  const corner = ranked[0].point
  const ta = hostTangent(a, corner), tb = hostTangent(b, corner)
  if (!ta || !tb) return 'Fillet: a selected host is degenerate'
  if (Math.abs(ta.x * tb.y - ta.y * tb.x) <= EPS_ANG) {
    return 'Fillet: the hosts are tangent at the corner but have no room for a fillet'
  }
  return corner
}

function offsetLoci(host: CircularFilletHost, radius: number): OffsetLocus[] {
  if (host.kind === 'line') {
    const dx = host.end.x - host.start.x, dy = host.end.y - host.start.y
    const len = Math.hypot(dx, dy)
    if (len <= EPS_LEN) return []
    const dir = { x: dx / len, y: dy / len }
    const left = { x: -dir.y, y: dir.x }
    return [-1, 1].map((side) => {
      const normal = { x: left.x * side, y: left.y * side }
      return {
        kind: 'line' as const,
        point: {
          x: host.start.x + normal.x * radius,
          y: host.start.y + normal.y * radius,
        },
        dir,
        normal,
      }
    })
  }
  const loci: OffsetCircle[] = []
  for (const delta of [-radius, radius]) {
    const signed = host.radius + delta
    if (Math.abs(signed) <= EPS_LEN) continue
    loci.push({
      kind: 'circle',
      center: host.center,
      radius: Math.abs(signed),
      radialSign: signed > 0 ? 1 : -1,
    })
  }
  return loci
}

function infiniteLineCircleIntersections(line: OffsetLine, circle: OffsetCircle): Vec2[] {
  const fx = line.point.x - circle.center.x
  const fy = line.point.y - circle.center.y
  const along = fx * line.dir.x + fy * line.dir.y
  const closest = {
    x: line.point.x - along * line.dir.x,
    y: line.point.y - along * line.dir.y,
  }
  const d2 = (closest.x - circle.center.x) ** 2 + (closest.y - circle.center.y) ** 2
  const h2 = circle.radius * circle.radius - d2
  if (h2 < -EPS_LEN) return []
  const h = Math.sqrt(Math.max(0, h2))
  if (h <= EPS_LEN) return [closest]
  return [
    { x: closest.x - h * line.dir.x, y: closest.y - h * line.dir.y },
    { x: closest.x + h * line.dir.x, y: closest.y + h * line.dir.y },
  ]
}

function offsetIntersections(a: OffsetLocus, b: OffsetLocus): Vec2[] {
  if (a.kind === 'line' && b.kind === 'line') {
    const la: SketchLineEntity = {
      id: '__a__', kind: 'line', construction: true,
      start: a.point, end: { x: a.point.x + a.dir.x, y: a.point.y + a.dir.y },
    }
    const lb: SketchLineEntity = {
      id: '__b__', kind: 'line', construction: true,
      start: b.point, end: { x: b.point.x + b.dir.x, y: b.point.y + b.dir.y },
    }
    const point = lineLineIntersection(la, lb)
    return point ? [point] : []
  }
  if (a.kind === 'line' && b.kind === 'circle') return infiniteLineCircleIntersections(a, b)
  if (a.kind === 'circle' && b.kind === 'line') return infiniteLineCircleIntersections(b, a)

  const ca = a as OffsetCircle, cb = b as OffsetCircle
  const dx = cb.center.x - ca.center.x, dy = cb.center.y - ca.center.y
  const d = Math.hypot(dx, dy)
  if (d <= EPS_LEN || d > ca.radius + cb.radius + EPS_LEN ||
      d < Math.abs(ca.radius - cb.radius) - EPS_LEN) return []
  const along = (ca.radius ** 2 - cb.radius ** 2 + d ** 2) / (2 * d)
  const h = Math.sqrt(Math.max(0, ca.radius ** 2 - along ** 2))
  const mid = {
    x: ca.center.x + along * dx / d,
    y: ca.center.y + along * dy / d,
  }
  if (h <= EPS_LEN) return [mid]
  return [
    { x: mid.x - h * dy / d, y: mid.y + h * dx / d },
    { x: mid.x + h * dy / d, y: mid.y - h * dx / d },
  ]
}

function tangentOnHost(host: CircularFilletHost, locus: OffsetLocus, center: Vec2): Vec2 {
  if (host.kind === 'line') {
    const line = locus as OffsetLine
    const along = (center.x - host.start.x) * line.dir.x +
      (center.y - host.start.y) * line.dir.y
    return {
      x: host.start.x + along * line.dir.x,
      y: host.start.y + along * line.dir.y,
    }
  }
  const circle = locus as OffsetCircle
  const dx = center.x - host.center.x, dy = center.y - host.center.y
  const len = Math.hypot(dx, dy)
  return {
    x: host.center.x + host.radius * circle.radialSign * dx / len,
    y: host.center.y + host.radius * circle.radialSign * dy / len,
  }
}

function solveCircularCandidates(
  a: CircularFilletHost,
  b: CircularFilletHost,
  corner: Vec2,
  hintA: Vec2,
  hintB: Vec2,
  radius: number,
): CircularCandidate[] {
  const candidates: CircularCandidate[] = []
  for (const locusA of offsetLoci(a, radius)) {
    for (const locusB of offsetLoci(b, radius)) {
      for (const center of offsetIntersections(locusA, locusB)) {
        if (candidates.some((candidate) => dist(candidate.center, center) <= EPS_TOUCH)) continue
        const tangentA = tangentOnHost(a, locusA, center)
        const tangentB = tangentOnHost(b, locusB, center)
        const trimA = trimCircularFilletHost(a, corner, tangentA, hintA)
        if (typeof trimA === 'string') continue
        const trimB = trimCircularFilletHost(b, corner, tangentB, hintB)
        if (typeof trimB === 'string') continue
        candidates.push({
          center,
          tangentA,
          tangentB,
          trimA,
          trimB,
          score: dist(tangentA, hintA) + dist(tangentB, hintB),
        })
      }
    }
  }
  return candidates.sort((x, y) => x.score - y.score)
}

interface NativeCandidate {
  center: Vec2
  tangentA: Vec2
  tangentB: Vec2
  trimA: GeneralFilletHostTrim
  trimB: GeneralFilletHostTrim
  score: number
}

function nativeMax(host: GeneralFilletHost): number {
  if (host.kind === 'line') return 1
  if (host.kind === 'arc') return norm(host.endAngle - host.startAngle) || TWO_PI
  if (host.kind === 'elliptical-arc') return ellipticalArcSweep(host.startParam, host.endParam)
  if (host.kind === 'spline') return host.closed ? host.points.length : Math.max(0, host.points.length - 1)
  return TWO_PI
}

function nativePoint(host: GeneralFilletHost, q: number): Vec2 {
  if (host.kind === 'line') return {
    x: host.start.x + q * (host.end.x - host.start.x),
    y: host.start.y + q * (host.end.y - host.start.y),
  }
  if (host.kind === 'circle') return {
    x: host.center.x + host.radius * Math.cos(q), y: host.center.y + host.radius * Math.sin(q),
  }
  if (host.kind === 'arc') return {
    x: host.center.x + host.radius * Math.cos(host.startAngle + q),
    y: host.center.y + host.radius * Math.sin(host.startAngle + q),
  }
  if (host.kind === 'ellipse') return ellipsePointAt(host, q)
  if (host.kind === 'elliptical-arc') return ellipsePointAt(host, host.startParam + q)
  return splinePointAt(host.points, host.closed, q, host.form)
}

function nativeDerivative(host: GeneralFilletHost, q: number): Vec2 {
  if (host.kind === 'line') return { x: host.end.x - host.start.x, y: host.end.y - host.start.y }
  if (host.kind === 'circle' || host.kind === 'arc') {
    const a = host.kind === 'arc' ? host.startAngle + q : q
    return { x: -host.radius * Math.sin(a), y: host.radius * Math.cos(a) }
  }
  if (host.kind === 'ellipse' || host.kind === 'elliptical-arc') {
    const t = host.kind === 'elliptical-arc' ? host.startParam + q : q
    const c = Math.cos(host.rotation), s = Math.sin(host.rotation)
    const x = -host.majorRadius * Math.sin(t), y = host.minorRadius * Math.cos(t)
    return { x: x * c - y * s, y: x * s + y * c }
  }
  return splineDerivativeAt(host.points, host.closed, q, host.form)
}

function nativeParam(host: GeneralFilletHost, p: Vec2): number {
  if (host.kind === 'line') {
    const dx = host.end.x - host.start.x, dy = host.end.y - host.start.y
    const l2 = dx * dx + dy * dy
    return l2 > 0 ? ((p.x - host.start.x) * dx + (p.y - host.start.y) * dy) / l2 : 0
  }
  if (host.kind === 'circle') return norm(Math.atan2(p.y - host.center.y, p.x - host.center.x))
  if (host.kind === 'arc') return norm(Math.atan2(p.y - host.center.y, p.x - host.center.x) - host.startAngle)
  if (host.kind === 'ellipse') return ellipseParamFromPoint(host, p)
  if (host.kind === 'elliptical-arc') return norm(ellipseParamFromPoint(host, p) - host.startParam)
  return nearestParamOnSpline(host.points, host.closed, p, host.form)
}

function nativeKeep(host: GeneralFilletHost, corner: Vec2, hint: Vec2): 'forward' | 'backward' | null {
  const c = nativeParam(host, corner), h = nativeParam(host, hint)
  if (host.kind === 'circle' || host.kind === 'ellipse' || (host.kind === 'spline' && host.closed)) {
    const f = norm(h - c), b = norm(c - h)
    if (Math.abs(f - b) <= EPS_ANG) return null
    return f < b ? 'forward' : 'backward'
  }
  if (Math.abs(h - c) <= 1e-9) return null
  return h > c ? 'forward' : 'backward'
}

function boundedParam(host: GeneralFilletHost, q: number): number {
  if (host.kind === 'circle' || host.kind === 'ellipse' || (host.kind === 'spline' && host.closed)) {
    const max = nativeMax(host)
    return ((q % max) + max) % max
  }
  return Math.max(0, Math.min(nativeMax(host), q))
}

function offsetPoint(host: GeneralFilletHost, q: number, side: number, radius: number): Vec2 | null {
  const p = nativePoint(host, q), d = nativeDerivative(host, q)
  const len = Math.hypot(d.x, d.y)
  if (len <= EPS_LEN) return null
  return { x: p.x - side * radius * d.y / len, y: p.y + side * radius * d.x / len }
}

function solveNativeCandidates(
  a: GeneralFilletHost, b: GeneralFilletHost, corner: Vec2,
  hintA: Vec2, hintB: Vec2, radius: number,
): NativeCandidate[] | string {
  if ((a.kind === 'spline' && a.closed) || (b.kind === 'spline' && b.closed)) {
    return 'Fillet: closed spline ambiguity'
  }
  const keepA = nativeKeep(a, corner, hintA), keepB = nativeKeep(b, corner, hintB)
  if (!keepA || !keepB) return 'Fillet: a kept curve side is ambiguous'
  const cA = nativeParam(a, corner), cB = nativeParam(b, corner)
  const dirA = keepA === 'forward' ? 1 : -1, dirB = keepB === 'forward' ? 1 : -1
  const derivativeA = nativeDerivative(a, cA), derivativeB = nativeDerivative(b, cB)
  const speedA = Math.max(EPS_LEN, Math.hypot(derivativeA.x, derivativeA.y))
  const speedB = Math.max(EPS_LEN, Math.hypot(derivativeB.x, derivativeB.y))
  const stepA = Math.max(1e-4, radius / speedA), stepB = Math.max(1e-4, radius / speedB)
  const out: NativeCandidate[] = []
  for (const sideA of [-1, 1]) for (const sideB of [-1, 1]) {
    let qa = boundedParam(a, cA + dirA * stepA)
    let qb = boundedParam(b, cB + dirB * stepB)
    let converged = false
    for (let iter = 0; iter < 40; iter++) {
      const oa = offsetPoint(a, qa, sideA, radius), ob = offsetPoint(b, qb, sideB, radius)
      if (!oa || !ob) break
      const fx = oa.x - ob.x, fy = oa.y - ob.y
      if (Math.hypot(fx, fy) <= 1e-7) { converged = true; break }
      const ha = Math.max(1e-6, nativeMax(a) * 1e-6)
      const hb = Math.max(1e-6, nativeMax(b) * 1e-6)
      const oa2 = offsetPoint(a, boundedParam(a, qa + ha), sideA, radius)
      const ob2 = offsetPoint(b, boundedParam(b, qb + hb), sideB, radius)
      if (!oa2 || !ob2) break
      const j00 = (oa2.x - oa.x) / ha, j10 = (oa2.y - oa.y) / ha
      const j01 = -(ob2.x - ob.x) / hb, j11 = -(ob2.y - ob.y) / hb
      const detJ = j00 * j11 - j01 * j10
      if (Math.abs(detJ) <= 1e-12) break
      const da = (-fx * j11 + j01 * fy) / detJ
      const db = (-j00 * fy + fx * j10) / detJ
      qa = boundedParam(a, qa + Math.max(-0.5, Math.min(0.5, da)))
      qb = boundedParam(b, qb + Math.max(-0.5, Math.min(0.5, db)))
    }
    if (!converged) continue
    const centerA = offsetPoint(a, qa, sideA, radius), centerB = offsetPoint(b, qb, sideB, radius)
    if (!centerA || !centerB || dist(centerA, centerB) > 1e-5) continue
    const tangentA = nativePoint(a, qa), tangentB = nativePoint(b, qb)
    const trimA = trimGeneralFilletHost(a, corner, tangentA, hintA)
    const trimB = trimGeneralFilletHost(b, corner, tangentB, hintB)
    if (typeof trimA === 'string' || typeof trimB === 'string') continue
    const center = { x: (centerA.x + centerB.x) / 2, y: (centerA.y + centerB.y) / 2 }
    if (out.some((x) => dist(x.center, center) <= EPS_TOUCH)) continue
    out.push({ center, tangentA, tangentB, trimA, trimB,
      score: dist(tangentA, hintA) + dist(tangentB, hintB) })
  }
  return out.sort((x, y) => x.score - y.score)
}

function refineNativePair(
  a: GeneralFilletHost, b: GeneralFilletHost, qa0: number, qb0: number,
  sideA: number, sideB: number, radius: number,
): { center: Vec2; tangentA: Vec2; tangentB: Vec2 } | null {
  let qa = qa0, qb = qb0
  for (let iter = 0; iter < 50; iter++) {
    const oa = offsetPoint(a, qa, sideA, radius), ob = offsetPoint(b, qb, sideB, radius)
    if (!oa || !ob) return null
    const fx = oa.x - ob.x, fy = oa.y - ob.y
    if (Math.hypot(fx, fy) <= 1e-7) return {
      center: { x: (oa.x + ob.x) / 2, y: (oa.y + ob.y) / 2 },
      tangentA: nativePoint(a, qa), tangentB: nativePoint(b, qb),
    }
    const ha = Math.max(1e-6, nativeMax(a) * 1e-6), hb = Math.max(1e-6, nativeMax(b) * 1e-6)
    const oa2 = offsetPoint(a, boundedParam(a, qa + ha), sideA, radius)
    const ob2 = offsetPoint(b, boundedParam(b, qb + hb), sideB, radius)
    if (!oa2 || !ob2) return null
    const j00 = (oa2.x - oa.x) / ha, j10 = (oa2.y - oa.y) / ha
    const j01 = -(ob2.x - ob.x) / hb, j11 = -(ob2.y - ob.y) / hb
    const detJ = j00 * j11 - j01 * j10
    if (Math.abs(detJ) <= 1e-12) return null
    qa = boundedParam(a, qa + Math.max(-0.5, Math.min(0.5, (-fx * j11 + j01 * fy) / detJ)))
    qb = boundedParam(b, qb + Math.max(-0.5, Math.min(0.5, (-j00 * fy + fx * j10) / detJ)))
  }
  return null
}

/** Follow the same local theoretical intersection after either native host
 * changes. Lines and circular/elliptical arcs are extended to their native
 * infinite/full curves; splines use their retained, untrimmed source. */
function refineTheoreticalIntersection(
  a: GeneralFilletHost, b: GeneralFilletHost, seed: Vec2,
): Vec2 | null {
  let qa = nativeParam(a, seed), qb = nativeParam(b, seed)
  const bound = (host: GeneralFilletHost, q: number): number => {
    if (host.kind === 'line') return q
    if (host.kind === 'spline') return Math.max(0, Math.min(nativeMax(host), q))
    const max = nativeMax(host)
    return ((q % max) + max) % max
  }
  for (let iter = 0; iter < 50; iter++) {
    const pa = nativePoint(a, qa), pb = nativePoint(b, qb)
    const fx = pa.x - pb.x, fy = pa.y - pb.y
    if (Math.hypot(fx, fy) <= 1e-8) {
      return { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }
    }
    const da = nativeDerivative(a, qa), db = nativeDerivative(b, qb)
    const detJ = db.x * da.y - da.x * db.y
    if (Math.abs(detJ) <= 1e-12) return null
    const stepA = (fx * db.y - db.x * fy) / detJ
    const stepB = (-da.x * fy + fx * da.y) / detJ
    qa = bound(a, qa + Math.max(-1, Math.min(1, stepA)))
    qb = bound(b, qb + Math.max(-1, Math.min(1, stepB)))
  }
  return null
}

function rebuildSplineAt(
  host: Extract<GeneralFilletHost, { kind: 'spline' }>, tangent: Vec2,
  keep: 'forward' | 'backward',
): Extract<GeneralFilletHost, { kind: 'spline' }> {
  const source = host.filletSourcePoints ?? host.points
  const q = nearestParamOnSpline(source, false, tangent)
  const d = splineDerivativeAt(source, false, q), dl = Math.hypot(d.x, d.y) || 1
  const u = { x: d.x / dl, y: d.y / dl }
  const helper = Math.max(EPS_LEN * 10, Math.min(0.1, dist(source[0], source[source.length - 1]) * 1e-3))
  const points = keep === 'forward'
    ? [tangent, { x: tangent.x + u.x * helper, y: tangent.y + u.y * helper }, ...source.slice(Math.floor(q) + 1)]
    : [...source.slice(0, Math.ceil(q)), { x: tangent.x - u.x * helper, y: tangent.y - u.y * helper }, tangent]
  return { ...host, points: points.filter((p, i) => i === 0 || dist(p, points[i - 1]) > EPS_LEN),
    filletSourcePoints: source.map((p) => ({ ...p })) }
}

const SPLINE_TRIM_CONFLICT = 'Fillet: spline endpoint trims cannot coexist'
const SPLINE_TRIM_RECONCILE_FAILURE = 'Fillet: spline endpoint trims cannot be reconciled'

interface SplineEndpointTrim {
  tangent: Vec2
  keep: 'forward' | 'backward'
}

/** Rebuild a spline once from every active endpoint descriptor. Rebuilding
 * descriptor-by-descriptor loses the opposite endpoint because each rebuild
 * intentionally starts from filletSourcePoints. */
function rebuildSplineWithTrims(
  host: Extract<GeneralFilletHost, { kind: 'spline' }>,
  trims: readonly SplineEndpointTrim[],
): Extract<GeneralFilletHost, { kind: 'spline' }> | string {
  const forward = trims.filter((trim) => trim.keep === 'forward')
  const backward = trims.filter((trim) => trim.keep === 'backward')
  if (forward.length > 1 || backward.length > 1) return SPLINE_TRIM_CONFLICT
  if (trims.length === 1) return rebuildSplineAt(host, trims[0].tangent, trims[0].keep)
  if (trims.length === 0) return host

  const source = host.filletSourcePoints ?? host.points
  const start = forward[0], end = backward[0]
  if (!start || !end || source.length < 2) return SPLINE_TRIM_CONFLICT
  const startParam = nearestParamOnSpline(source, false, start.tangent)
  const endParam = nearestParamOnSpline(source, false, end.tangent)
  if (startParam + EPS_PARAM >= endParam) return SPLINE_TRIM_CONFLICT

  const endpoint = (q: number): { unit: Vec2; helper: number } | null => {
    const derivative = splineDerivativeAt(source, false, q)
    const length = Math.hypot(derivative.x, derivative.y)
    if (length <= EPS_LEN) return null
    return {
      unit: { x: derivative.x / length, y: derivative.y / length },
      helper: Math.max(EPS_LEN * 10,
        Math.min(0.1, dist(source[0], source[source.length - 1]) * 1e-3)),
    }
  }
  const startData = endpoint(startParam), endData = endpoint(endParam)
  if (!startData || !endData) return SPLINE_TRIM_CONFLICT
  const points = [
    start.tangent,
    { x: start.tangent.x + startData.unit.x * startData.helper,
      y: start.tangent.y + startData.unit.y * startData.helper },
    ...source.slice(Math.floor(startParam) + 1, Math.ceil(endParam)),
    { x: end.tangent.x - endData.unit.x * endData.helper,
      y: end.tangent.y - endData.unit.y * endData.helper },
    end.tangent,
  ]
  const deduped = points.filter((point, index) => index === 0 || dist(point, points[index - 1]) > EPS_LEN)
  if (deduped.length < 2) return SPLINE_TRIM_CONFLICT
  return { ...host, points: deduped, filletSourcePoints: source.map((point) => ({ ...point })) }
}

/** Rebuild specialized ellipse/spline fillets after PlaneGCS has solved the
 * ordinary network and driving radius. This is deterministic from durable
 * arc metadata and preserves native host representations. */
function reconcileCurveFilletsChecked(entities: readonly SketchEntity[]): SketchEntity[] | string {
  let out = [...entities]
  const splineTrims = new Map<string, SplineEndpointTrim[]>()
  const replace = (entity: SketchEntity): void => {
    out = out.map((candidate) => candidate.id === entity.id ? entity : candidate)
  }
  const fillets = out.filter((entity): entity is SketchArcEntity =>
    entity.kind === 'arc' && entity.curveFillet !== undefined)
    .sort((a, b) => a.id.localeCompare(b.id))
  for (const fillet of fillets) {
    if (fillet.kind !== 'arc' || !fillet.curveFillet) continue
    const meta = fillet.curveFillet
    const hostA = out.find((e) => e.id === meta.hostAId)
    const hostB = out.find((e) => e.id === meta.hostBId)
    const valid = (e: SketchEntity | undefined): e is GeneralFilletHost => !!e &&
      (e.kind === 'line' || e.kind === 'arc' || e.kind === 'circle' || e.kind === 'ellipse' ||
        e.kind === 'elliptical-arc' || e.kind === 'spline')
    const touchesSpline = hostA?.kind === 'spline' || hostB?.kind === 'spline'
    if (!valid(hostA) || !valid(hostB) || hostA.kind === 'circle' || hostB.kind === 'circle') {
      if (touchesSpline) return SPLINE_TRIM_RECONCILE_FAILURE
      continue
    }
    const source = (host: GeneralFilletHost): GeneralFilletHost => {
      if (host.kind === 'elliptical-arc') return { ...host, kind: 'ellipse' }
      if (host.kind === 'spline' && host.filletSourcePoints) return { ...host, points: host.filletSourcePoints }
      return host
    }
    const sa = source(hostA), sb = source(hostB)
    const theoreticalSource = (host: GeneralFilletHost): GeneralFilletHost => {
      const native = source(host)
      if (native.kind === 'arc') return { ...native, kind: 'circle' }
      return native
    }
    const phantom = out.find((e) => e.id === meta.theoreticalPointId)
    const theoretical = phantom?.kind === 'point'
      ? refineTheoreticalIntersection(theoreticalSource(hostA), theoreticalSource(hostB), phantom.at)
      : null
    const arcPoint = (site: 'start' | 'end'): Vec2 => ({
      x: fillet.center.x + fillet.radius * Math.cos(site === 'start' ? fillet.startAngle : fillet.endAngle),
      y: fillet.center.y + fillet.radius * Math.sin(site === 'start' ? fillet.startAngle : fillet.endAngle),
    })
    const oldA = arcPoint(meta.arcAAtStart ? 'start' : 'end')
    const oldB = arcPoint(meta.arcAAtStart ? 'end' : 'start')
    const qa = nativeParam(sa, oldA), qb = nativeParam(sb, oldB)
    const side = (host: GeneralFilletHost, q: number, at: Vec2): number => {
      const d = nativeDerivative(host, q), l = Math.hypot(d.x, d.y) || 1
      const dot = (fillet.center.x - at.x) * (-d.y / l) + (fillet.center.y - at.y) * (d.x / l)
      return dot >= 0 ? 1 : -1
    }
    const solved = refineNativePair(sa, sb, qa, qb, side(sa, qa, oldA), side(sb, qb, oldB), fillet.radius)
    if (!solved || !theoretical || phantom?.kind !== 'point') {
      if (touchesSpline) return SPLINE_TRIM_RECONCILE_FAILURE
      continue
    }
    const updateHost = (host: GeneralFilletHost, tangent: Vec2, keep: 'forward' | 'backward'): SketchEntity => {
      if (host.kind === 'line') return { ...host, [keep === 'forward' ? 'start' : 'end']: tangent }
      if (host.kind === 'arc') {
        const angle = norm(Math.atan2(tangent.y - host.center.y, tangent.x - host.center.x))
        return keep === 'forward' ? { ...host, startAngle: angle } : { ...host, endAngle: angle }
      }
      if (host.kind === 'elliptical-arc') {
        const p = ellipseParamFromPoint(host, tangent)
        return keep === 'forward' ? { ...host, startParam: p } : { ...host, endParam: p }
      }
      if (host.kind === 'spline') {
        const trims = splineTrims.get(host.id) ?? []
        trims.push({ tangent, keep })
        splineTrims.set(host.id, trims)
        return host
      }
      return host
    }
    replace(updateHost(hostA, solved.tangentA, meta.hostAKeep))
    replace(updateHost(hostB, solved.tangentB, meta.hostBKeep))
    const aAngle = norm(Math.atan2(solved.tangentA.y - solved.center.y, solved.tangentA.x - solved.center.x))
    const bAngle = norm(Math.atan2(solved.tangentB.y - solved.center.y, solved.tangentB.x - solved.center.x))
    replace({ ...fillet, center: solved.center,
      startAngle: meta.arcAAtStart ? aAngle : bAngle,
      endAngle: meta.arcAAtStart ? bAngle : aAngle })
    replace({ ...phantom, at: theoretical })
  }
  for (const [hostId, trims] of [...splineTrims].sort(([a], [b]) => a.localeCompare(b))) {
    const host = out.find((entity): entity is Extract<GeneralFilletHost, { kind: 'spline' }> =>
      entity.id === hostId && entity.kind === 'spline')
    if (!host) continue
    const rebuilt = rebuildSplineWithTrims(host, trims)
    if (typeof rebuilt === 'string') return rebuilt
    replace(rebuilt)
  }
  return out
}

export function reconcileCurveFillets(entities: readonly SketchEntity[]): SketchEntity[] {
  const reconciled = reconcileCurveFilletsChecked(entities)
  return typeof reconciled === 'string' ? [...entities] : reconciled
}

function consumedRef(host: GeneralFilletHost, trim: GeneralFilletHostTrim | CircularFilletHostTrim): PointRef | null {
  return trim.consumedSite
    ? { entityId: host.id, site: trim.consumedSite }
    : null
}

function filletNativePair(
  doc: SketchDoc, a: GeneralFilletHost, b: GeneralFilletHost,
  hintA: Vec2, hintB: Vec2, radius: number, newId: () => string,
  opts: FilletOptions,
): FilletResult | string {
  const sharp = selectSharpIntersection(a, b, hintA, hintB)
  if (typeof sharp === 'string') return sharp
  const candidates = solveNativeCandidates(a, b, sharp, hintA, hintB, radius)
  if (typeof candidates === 'string') return candidates
  if (candidates.length === 0) return `Fillet: R${radius} has no fit on the selected native curve spans`
  if (candidates.length > 1 && Math.abs(candidates[1].score - candidates[0].score) <= EPS_TOUCH) {
    return 'Fillet: the picks are ambiguous between multiple local solutions'
  }
  const chosen = candidates[0]
  const aa = norm(Math.atan2(chosen.tangentA.y - chosen.center.y, chosen.tangentA.x - chosen.center.x))
  const ba = norm(Math.atan2(chosen.tangentB.y - chosen.center.y, chosen.tangentB.x - chosen.center.x))
  const startsAtA = norm(ba - aa) <= Math.PI
  const arcId = newId()
  const phantomPointId = newId()
  const arc: SketchArcEntity = {
    id: arcId, kind: 'arc', construction: a.construction && b.construction,
    center: chosen.center, radius,
    startAngle: startsAtA ? aa : ba, endAngle: startsAtA ? ba : aa,
    curveFillet: {
      hostAId: a.id, hostBId: b.id,
      theoreticalPointId: phantomPointId,
      hostAKeep: chosen.trimA.keep, hostBKeep: chosen.trimB.keep,
      arcAAtStart: startsAtA,
    },
  }
  const jointA: PointRef = { entityId: a.id, site: chosen.trimA.jointSite }
  const jointB: PointRef = { entityId: b.id, site: chosen.trimB.jointSite }
  const joints: SketchConstraint[] = [
    { id: newId(), kind: 'coincident', a: { entityId: arcId, site: startsAtA ? 'start' : 'end' }, b: jointA },
    { id: newId(), kind: 'coincident', a: { entityId: arcId, site: startsAtA ? 'end' : 'start' }, b: jointB },
    { id: newId(), kind: 'tangent', a: arcId, b: a.id },
    { id: newId(), kind: 'tangent', a: arcId, b: b.id },
  ]
  const theoretical = buildTheoreticalCorner(doc, {
    hostA: a, hostB: b, corner: sharp,
    trimA: { site: chosen.trimA.jointSite, at: chosen.tangentA,
      replacement: chosen.trimA.entity, consumedSite: chosen.trimA.consumedSite },
    trimB: { site: chosen.trimB.jointSite, at: chosen.tangentB,
      replacement: chosen.trimB.entity, consumedSite: chosen.trimB.consumedSite },
    phantomPointId, hostAPinId: newId(), hostBPinId: newId(),
  })
  const dimensions = reanchorDimensionsToTheoreticalCorner(
    doc.dimensions, consumedRef(a, chosen.trimA), consumedRef(b, chosen.trimB), theoretical.phantomRef,
  )
  const nextDimensions = [...dimensions]
  let radiusDimId: string | null = null
  if (opts.radiusDim ?? true) {
    radiusDimId = newId()
    const mid = arc.startAngle + norm(arc.endAngle - arc.startAngle) / 2
    nextDimensions.push({ id: radiusDimId, kind: 'radius', driving: true, value: radius,
      entityId: arcId, labelAnchor: {
        x: arc.center.x + radius * Math.cos(mid), y: arc.center.y + radius * Math.sin(mid),
      } })
  }
  const transform: SketchDocTransform = {
    entities: [...theoretical.entities, arc],
    constraints: [...theoretical.constraints, ...joints, ...theoretical.pinConstraints],
    dimensions: nextDimensions,
  }
  const reconciled = reconcileCurveFilletsChecked(transform.entities)
  if (typeof reconciled === 'string') return reconciled
  return { transform: { ...transform, entities: reconciled }, arcId, phantomPointId, radiusDimId }
}

function filletCircularPair(
  doc: SketchDoc,
  a: CircularFilletHost,
  b: CircularFilletHost,
  hintA: Vec2,
  hintB: Vec2,
  radius: number,
  newId: () => string,
  opts: FilletOptions,
): FilletResult | string {
  const sharp = selectSharpIntersection(a, b, hintA, hintB)
  if (typeof sharp === 'string') return sharp
  const candidates = solveCircularCandidates(a, b, sharp, hintA, hintB, radius)
  if (candidates.length === 0) {
    return `Fillet: R${radius} has no fit on the selected curve spans`
  }
  if (candidates.length > 1 &&
      Math.abs(candidates[1].score - candidates[0].score) <= EPS_TOUCH) {
    return 'Fillet: the picks are ambiguous between internal/external solutions'
  }
  const chosen = candidates[0]
  const aAngle = norm(Math.atan2(
    chosen.tangentA.y - chosen.center.y,
    chosen.tangentA.x - chosen.center.x,
  ))
  const bAngle = norm(Math.atan2(
    chosen.tangentB.y - chosen.center.y,
    chosen.tangentB.x - chosen.center.x,
  ))
  const startsAtA = norm(bAngle - aAngle) <= Math.PI
  const arcId = newId()
  const arc: SketchArcEntity = {
    id: arcId,
    kind: 'arc',
    construction: a.construction && b.construction,
    center: chosen.center,
    radius,
    startAngle: startsAtA ? aAngle : bAngle,
    endAngle: startsAtA ? bAngle : aAngle,
  }
  const phantomPointId = newId()
  const jointA: PointRef = { entityId: a.id, site: chosen.trimA.jointSite }
  const jointB: PointRef = { entityId: b.id, site: chosen.trimB.jointSite }
  const joints: SketchConstraint[] = [
    { id: newId(), kind: 'coincident',
      a: { entityId: arcId, site: startsAtA ? 'start' : 'end' }, b: jointA },
    { id: newId(), kind: 'coincident',
      a: { entityId: arcId, site: startsAtA ? 'end' : 'start' }, b: jointB },
    { id: newId(), kind: 'tangent', a: arcId, b: a.id },
    { id: newId(), kind: 'tangent', a: arcId, b: b.id },
  ]
  const theoretical = buildTheoreticalCorner(doc, {
    hostA: a,
    hostB: b,
    corner: sharp,
    trimA: {
      site: chosen.trimA.jointSite,
      at: chosen.tangentA,
      replacement: chosen.trimA.entity,
      consumedSite: chosen.trimA.consumedSite,
    },
    trimB: {
      site: chosen.trimB.jointSite,
      at: chosen.tangentB,
      replacement: chosen.trimB.entity,
      consumedSite: chosen.trimB.consumedSite,
    },
    phantomPointId,
    hostAPinId: newId(),
    hostBPinId: newId(),
  })
  const dimensions = reanchorDimensionsToTheoreticalCorner(
    doc.dimensions,
    consumedRef(a, chosen.trimA),
    consumedRef(b, chosen.trimB),
    theoretical.phantomRef,
  )
  let radiusDimId: string | null = null
  const nextDimensions = [...dimensions]
  if (opts.radiusDim ?? true) {
    radiusDimId = newId()
    const midAngle = arc.startAngle + norm(arc.endAngle - arc.startAngle) / 2
    nextDimensions.push({
      id: radiusDimId,
      kind: 'radius',
      driving: true,
      value: radius,
      entityId: arcId,
      labelAnchor: {
        x: arc.center.x + radius * Math.cos(midAngle),
        y: arc.center.y + radius * Math.sin(midAngle),
      },
    })
  }
  return {
    transform: {
      entities: [...theoretical.entities, arc],
      constraints: [...theoretical.constraints, ...joints, ...theoretical.pinConstraints],
      dimensions: nextDimensions,
    },
    arcId,
    phantomPointId,
    radiusDimId,
  }
}

/**
 * Insert a true circular fillet between any solver-backed line/circle/arc
 * pair. The historical name remains API-stable for existing callers.
 */
export function filletLines(
  doc: SketchDoc,
  aId: string,
  bId: string,
  hintA: Vec2,
  hintB: Vec2,
  radius: number,
  newId: () => string = () => crypto.randomUUID(),
  opts: FilletOptions = {},
): FilletResult | string {
  if (!(radius > 0)) return 'Fillet: radius must be positive'
  // WO-1861 decide-and-log: the fillet trims a spline by rebuilding it from
  // through-points (rebuildSplineAt / trimGeneralFilletHost), so a
  // control-point spline host is first re-expressed as the through-point
  // spline tracing the same curve. The committed host is that through-point
  // spline; its shape is unchanged, its control polygon is not kept.
  // WO-1862: a bezier chain host is re-expressed the same way.
  if (doc.entities.some((e) =>
    (e.id === aId || e.id === bId) && e.kind === 'spline' && splineHasControlSites(e.form))) {
    doc = {
      ...doc,
      entities: doc.entities.map((e) =>
        (e.id === aId || e.id === bId) && e.kind === 'spline' ? splineAsThroughPoints(e) : e),
    }
  }
  const a = doc.entities.find((entity) => entity.id === aId)
  const b = doc.entities.find((entity) => entity.id === bId)
  const isHost = (entity: SketchEntity | undefined): entity is GeneralFilletHost =>
    entity !== undefined &&
    (entity.kind === 'line' || entity.kind === 'arc' || entity.kind === 'circle' ||
      entity.kind === 'ellipse' || entity.kind === 'elliptical-arc' || entity.kind === 'spline')
  if (!isHost(a) || !isHost(b)) {
    return 'Fillet: both picks must be lines, arcs, circles, ellipses, or splines'
  }
  if (a.kind === 'line' && b.kind === 'line') {
    return filletLinePair(doc, aId, bId, hintA, hintB, radius, newId, opts)
  }
  if ((a.kind === 'line' || a.kind === 'arc' || a.kind === 'circle') &&
      (b.kind === 'line' || b.kind === 'arc' || b.kind === 'circle')) {
    return filletCircularPair(doc, a, b, hintA, hintB, radius, newId, opts)
  }
  return filletNativePair(doc, a, b, hintA, hintB, radius, newId, opts)
}

// ---- Accumulation helpers -----------------------------------------------------------

/** Kept-side hint for an open-host corner pick: away from the corner. */
function farOf(host: SketchLineEntity | SketchArcEntity, cornerAt: Vec2): Vec2 {
  const [start, end] = openHostEndpoints(host)
  return dist(start.p, cornerAt) <= dist(end.p, cornerAt) ? end.p : start.p
}

function samePair(c: FilletCornerPick, aId: string, bId: string): boolean {
  return (c.aId === aId && c.bId === bId) || (c.aId === bId && c.bId === aId)
}

/** A pick matches a staged corner when it is the SAME line pair, or when
 *  the resolved corner point lands within EPS_CORNER of the staged `at`
 *  (three lines through one point can resolve the same physical corner
 *  via a different pair). */
function sameCorner(c: FilletCornerPick, pick: FilletCornerPick): boolean {
  return samePair(c, pick.aId, pick.bId) || dist(c.at, pick.at) <= EPS_CORNER
}

/** Toggle a resolved corner in/out of the accumulated set: re-clicking an
 *  already-staged corner UNSELECTS it (Operator's verdict on 3dac35e) instead
 *  of duplicating it. Removing corners[0] naturally re-anchors the radius
 *  box to the next staged corner. */
function toggleCorner(
  corners: FilletCornerPick[], pick: FilletCornerPick,
): FilletCornerPick[] {
  return corners.some((c) => sameCorner(c, pick))
    ? corners.filter((c) => !sameCorner(c, pick))
    : [...corners, pick]
}

/** Corners seeded from a pre-selection: every SHARED CORNER among the
 *  selected lines (two selected-line endpoints within EPS_TOUCH). Side
 *  hints = the far endpoints (the kept sides of a corner pick). */
export function filletSeedFromSelection(
  entities: readonly SketchEntity[], selectedIds: readonly string[],
): FilletCornerPick[] {
  const hosts = selectedIds
    .map((id) => entities.find((e) => e.id === id))
    .filter((e): e is SketchLineEntity | SketchArcEntity =>
      e !== undefined && (e.kind === 'line' || e.kind === 'arc'))
  const corners: FilletCornerPick[] = []
  for (let i = 0; i < hosts.length; i++) {
    for (let j = i + 1; j < hosts.length; j++) {
      for (const { p: pa } of openHostEndpoints(hosts[i])) {
        for (const { p: pb } of openHostEndpoints(hosts[j])) {
          if (dist(pa, pb) > EPS_TOUCH) continue
          if (corners.some((c) => samePair(c, hosts[i].id, hosts[j].id))) continue
          corners.push({
            aId: hosts[i].id, bId: hosts[j].id,
            hintA: farOf(hosts[i], pa), hintB: farOf(hosts[j], pb),
            at: { x: pa.x, y: pa.y },
          })
        }
      }
    }
  }
  return corners
}

// ---- Preview + batch apply ------------------------------------------------------------

export interface FilletChainPreview {
  /** Tessellated preview arc per RESOLVABLE corner (current radius). */
  arcs: Vec2[][]
  /** The same resolvable preview arcs paired with their theoretical sharp
   *  corners. Pointer interaction consumes these regions instead of
   *  re-deriving fillet geometry in the gesture layer. */
  dragRegions: StagedSizeDragRegion[]
  /** Corner locations where the radius does NOT fit (skipped on Apply). */
  warnings: Vec2[]
  /** EVERY staged corner location (fit or not) — the viewport marks each
   *  with a selection ring so "which corners are staged" is unmistakable
   *  (Operator's verdict: selected fillets need a clear visual element). */
  corners: Vec2[]
  fits: number
  misfits: number
}

/** Max radius that fits BOTH lines at one corner (SKC-46 default-derivation clamp), or null when
 *  the corner cannot resolve at all (missing lines / parallel / collinear / degenerate side).
 *
 *  SKC-46-R1 (BLOCKER 1): this is the STRICT ceiling `filletLines` will actually accept, not the
 *  bare geometric max -- `availMin` is reduced by `CEILING_MARGIN` BEFORE the tan(half) projection
 *  into radius space, so every value at or below the return here satisfies `filletLines`'s own
 *  `tDist < availMin - EPS_LEN` accept rule with headroom for the radius->tDist->radius float
 *  round trip. Floored at 0 (never negative) so seeding still sees a real number, not a sign flip,
 *  on a corner too small for ANY margin -- `seedStagedSize` reads a sub-floor value as a refusal. */
export function filletMaxUsableRadius(
  doc: SketchDoc, aId: string, bId: string, hintA: Vec2, hintB: Vec2,
): number | null {
  const a = doc.entities.find((e) => e.id === aId)
  const b = doc.entities.find((e) => e.id === bId)
  const isHost = (entity: SketchEntity | undefined): entity is GeneralFilletHost =>
    entity !== undefined &&
    (entity.kind === 'line' || entity.kind === 'arc' || entity.kind === 'circle' ||
      entity.kind === 'ellipse' || entity.kind === 'elliptical-arc' || entity.kind === 'spline')
  if (!isHost(a) || !isHost(b)) return null
  if (a.kind !== 'line' || b.kind !== 'line') {
    let id = 0
    const fits = (candidate: number): boolean => typeof filletLines(
      doc, aId, bId, hintA, hintB, candidate,
      () => `__max_${id++}__`, { radiusDim: false },
    ) !== 'string'
    const hostScale = (host: GeneralFilletHost): number => {
      if (host.kind === 'line') return dist(host.start, host.end)
      if (host.kind === 'arc' || host.kind === 'circle') return host.radius
      if (host.kind === 'ellipse' || host.kind === 'elliptical-arc') return Math.max(host.majorRadius, host.minorRadius)
      return host.points.reduce((sum, p, i) => i ? sum + dist(host.points[i - 1], p) : 0, 0)
    }
    const scale = Math.max(1, hostScale(a), hostScale(b))
    // Begin above native trim sliver guards, but do not assume this global
    // host scale describes the local kept-span capacity. A huge-radius arc
    // can have only a short field-usable span: descend until one real fit is
    // established before `null` is allowed to mean unresolvable.
    let lo = Math.max(1e-4, scale * 1e-4)
    let hi = scale
    const initialFits = fits(lo)
    if (!initialFits) {
      let failed = lo
      let found = false
      for (let shrink = 0; shrink < 60 && lo > 1e-4; shrink++) {
        lo = Math.max(1e-4, lo / 2)
        if (fits(lo)) {
          hi = failed
          found = true
          break
        }
        failed = lo
      }
      if (!found) return null
    }
    if (initialFits) {
      for (let grow = 0; grow < 12 && fits(hi); grow++) {
        lo = hi
        hi *= 2
      }
      if (fits(hi)) return hi
    }
    for (let step = 0; step < 60; step++) {
      const mid = (lo + hi) / 2
      if (fits(mid)) lo = mid
      else hi = mid
    }
    return Math.max(0, lo - CEILING_MARGIN)
  }
  const C = lineLineIntersection(a, b)
  if (!C) return null
  const sideA = trimSide(a, C, hintA)
  const sideB = trimSide(b, C, hintB)
  if (!sideA || !sideB) return null
  const cosT = Math.max(-1, Math.min(1, sideA.dir.x * sideB.dir.x + sideA.dir.y * sideB.dir.y))
  const theta = Math.acos(cosT)
  if (theta <= EPS_ANG || Math.PI - theta <= EPS_ANG) return null
  const availMin = Math.min(sideA.avail, sideB.avail)
  const safeAvail = Math.max(0, availMin - CEILING_MARGIN)
  return Math.tan(theta / 2) * safeAvail
}

/** Max radius that fits EVERY staged corner in the chain (the min across corners), discriminated
 *  by `classifyChainMax` (SKC-46-R2) into no-corner / unresolvable / non-finite / sub-floor /
 *  finite-legal. This chain-level function is the ONLY site that knows `corners.length`, so it is
 *  the site that must distinguish "no corners staged" from "every staged corner is unresolvable"
 *  -- both collapsed to the same `null` before R2 (the R1 audit BLOCKER). Used to seed/clamp the
 *  shared radius scalar for a batch. */
export function filletChainMaxRadius(chain: FilletChainState, doc: SketchDoc): ChainMaxResult {
  const perCorner = chain.corners.map(
    (c) => filletMaxUsableRadius(doc, c.aId, c.bId, c.hintA, c.hintB),
  )
  return classifyChainMax(perCorner)
}

/** WO SKC-14 (BK-88): the sweep walk lives once, in
 *  sketcher/geometry/arcTessellation.ts. This keeps the fillet-ghost density
 *  policy (no chord longer than 0.5mm, >= 8 segments) that the private loop had. */
function tessellateArc(arc: SketchArcEntity): Vec2[] {
  return arcSamplePoints(arc, GHOST_ARC_DENSITY)
}

/**
 * Live preview of every accumulated corner at `radius`: a ghost arc per
 * resolvable corner (the SAME filletLines construction Apply uses — the
 * preview arc IS the committed arc), a warning marker per corner the
 * radius does not fit. Each corner previews against the pristine
 * document; Apply replays them sequentially, which only differs when
 * two fillets would overlap on a shared line — those skip at Apply time
 * with a named notice.
 */
// BK-136 (SKC-46 rider): the armed hover path (staged-drag hit-test) and the tool-overlay paint
// both call this with the SAME (chain, doc, radius) on the same pointermove tick, doubling an
// O(corners) fillet construction on every move. A size-1 memo, keyed on chain identity + radius +
// shallow entities/constraints/dimensions equality, collapses the two calls into one computation
// without changing either caller. `doc` differs by REFERENCE between call sites (the overlay path
// rebuilds a fresh `{entities: [...], ...}` object per render) but not by CONTENT, so the compare
// is per-array shallow equality rather than `===` on `doc` itself.
function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

let filletPreviewMemo: {
  chain: FilletChainState
  doc: SketchDoc
  radius: number
  result: FilletChainPreview
} | null = null

/** Test seam ONLY (SKC-46, BK-136 mutation proof): how many times the preview was actually
 *  COMPUTED (memo misses), never how many times `filletChainPreview` was CALLED. Production code
 *  never reads this. */
let filletPreviewComputeCount = 0
export function __filletPreviewComputeCount(): number {
  return filletPreviewComputeCount
}
export function __resetFilletChainPreviewMemo(): void {
  filletPreviewMemo = null
  filletPreviewComputeCount = 0
}

export function filletChainPreview(
  chain: FilletChainState, doc: SketchDoc, radius: number,
): FilletChainPreview {
  const memo = filletPreviewMemo
  if (
    memo && memo.chain === chain && memo.radius === radius &&
    shallowArrayEqual(memo.doc.entities, doc.entities) &&
    shallowArrayEqual(memo.doc.constraints, doc.constraints) &&
    shallowArrayEqual(memo.doc.dimensions, doc.dimensions)
  ) {
    return memo.result
  }
  filletPreviewComputeCount++
  const result = computeFilletChainPreview(chain, doc, radius)
  filletPreviewMemo = { chain, doc, radius, result }
  return result
}

function computeFilletChainPreview(
  chain: FilletChainState, doc: SketchDoc, radius: number,
): FilletChainPreview {
  const arcs: Vec2[][] = []
  const dragRegions: FilletChainPreview['dragRegions'] = []
  const warnings: Vec2[] = []
  const corners: Vec2[] = []
  let id = 0
  for (const c of chain.corners) {
    corners.push({ x: c.at.x, y: c.at.y })
    const r = filletLines(
      doc, c.aId, c.bId, c.hintA, c.hintB, radius,
      () => `__fp${id++}__`, { radiusDim: false })
    if (typeof r === 'string') {
      warnings.push({ x: c.at.x, y: c.at.y })
      continue
    }
    const arc = r.transform.entities.find(
      (e): e is SketchArcEntity => e.id === r.arcId && e.kind === 'arc',
    )
    if (arc) {
      const points = tessellateArc(arc)
      arcs.push(points)
      dragRegions.push({
        corner: { x: c.at.x, y: c.at.y },
        path: points,
      })
    }
  }
  return { arcs, dragRegions, warnings, corners, fits: arcs.length, misfits: warnings.length }
}

export interface FilletApplyResult {
  /** null = no corner could be filleted (nothing to commit). */
  transform: SketchDocTransform | null
  applied: number
  /** Skipped corners (radius does not fit / sequential overlap), with
   *  the line-pair ids for naming in the flash notice. */
  skipped: Array<{ pick: FilletCornerPick; reason: string }>
}

/** Resolve native spline endpoint claims against the untouched source before
 * sequential apply can trim away an intersection needed to name a conflict. */
function preflightSplineBatch(
  doc: SketchDoc,
  corners: readonly FilletCornerPick[],
  radius: number,
): { pick: FilletCornerPick; reason: string } | null {
  const claims = new Map<string, Set<'forward' | 'backward'>>()
  const occupiedIds = new Set([
    ...doc.entities.map((entity) => entity.id),
    ...doc.constraints.map((constraint) => constraint.id),
    ...doc.dimensions.map((dimension) => dimension.id),
  ])
  let nextProbeId = 0
  const probeId = (): string => {
    let id = ''
    do id = `__fillet_batch_preflight_${nextProbeId++}`
    while (occupiedIds.has(id))
    occupiedIds.add(id)
    return id
  }

  for (const corner of corners) {
    const a = doc.entities.find((entity) => entity.id === corner.aId)
    const b = doc.entities.find((entity) => entity.id === corner.bId)
    if (a?.kind !== 'spline' && b?.kind !== 'spline') continue
    const probe = filletLines(
      doc, corner.aId, corner.bId, corner.hintA, corner.hintB, radius, probeId,
      { radiusDim: false },
    )
    if (typeof probe === 'string') {
      if (probe === SPLINE_TRIM_CONFLICT || probe === SPLINE_TRIM_RECONCILE_FAILURE) {
        return { pick: corner, reason: probe }
      }
      continue
    }
    const arc = probe.transform.entities.find((entity) => entity.id === probe.arcId)
    if (arc?.kind !== 'arc' || !arc.curveFillet) continue
    const endpointClaims = [
      { hostId: arc.curveFillet.hostAId, keep: arc.curveFillet.hostAKeep },
      { hostId: arc.curveFillet.hostBId, keep: arc.curveFillet.hostBKeep },
    ] as const
    for (const claim of endpointClaims) {
      const host = doc.entities.find((entity) => entity.id === claim.hostId)
      if (host?.kind !== 'spline') continue
      const claimedEnds = claims.get(host.id) ?? new Set<'forward' | 'backward'>()
      if (claimedEnds.has(claim.keep)) {
        return { pick: corner, reason: SPLINE_TRIM_CONFLICT }
      }
      claimedEnds.add(claim.keep)
      claims.set(host.id, claimedEnds)
    }
  }
  return null
}

/**
 * Apply ALL accumulated corners at `radius`, sequentially against the
 * evolving document (one undo step at the store). Corners that cannot
 * resolve are skipped and reported, never silently dropped.
 */
export function filletApplyAll(
  doc: SketchDoc,
  corners: readonly FilletCornerPick[],
  radius: number,
  newId: () => string = () => crypto.randomUUID(),
): FilletApplyResult {
  const splineConflict = preflightSplineBatch(doc, corners, radius)
  if (splineConflict) {
    return { transform: null, applied: 0, skipped: [splineConflict] }
  }
  let current: SketchDoc = doc
  let applied = 0
  // The first corner that resolves becomes the LEAD: it carries the single
  // DRIVING radius dimension. Every following corner is tied to the lead by
  // an EQUAL-RADIUS constraint instead of its own dimension, so the whole
  // batch stays one radius and editing the lead dim resizes them together
  // (the standard CAD multi-fillet convention).
  let leadArcId: string | null = null
  const skipped: FilletApplyResult['skipped'] = []
  for (const c of corners) {
    const isLead = leadArcId === null
    const r = filletLines(
      current, c.aId, c.bId, c.hintA, c.hintB, radius, newId,
      { radiusDim: isLead })
    if (typeof r === 'string') {
      if (r === SPLINE_TRIM_CONFLICT || r === SPLINE_TRIM_RECONCILE_FAILURE) {
        return { transform: null, applied: 0, skipped: [{ pick: c, reason: r }] }
      }
      skipped.push({ pick: c, reason: r })
      continue
    }
    if (!isLead && leadArcId !== null) {
      // equal RADIUS for arc/arc -> planegcs equal_radius_aa (gcsMapping).
      const eq: SketchConstraint = {
        id: newId(), kind: 'equal', a: r.arcId, b: leadArcId,
      }
      current = { ...r.transform, constraints: [...r.transform.constraints, eq] }
    } else {
      current = r.transform
      leadArcId = r.arcId
    }
    applied++
  }
  return {
    transform: applied > 0
      ? {
          entities: [...current.entities],
          constraints: [...current.constraints],
          dimensions: [...current.dimensions],
        }
      : null,
    applied,
    skipped,
  }
}

// ---- Click behavior ----------------------------------------------------------------

/**
 * CLICK(p) for the armed fillet tool (accumulate-then-confirm flow):
 *   - click a SHARED CORNER (two coincident line endpoints): toggle that
 *     corner in/out of the set (the rectangle-corner gesture)
 *   - click a line, then another line: toggle THEIR corner (each click's
 *     position chooses the kept side -- click the side to keep)
 *   - every resolvable corner shows a live preview arc; the confirm
 *     overlay's Apply commits the whole set as one undo step
 *   - empty idle click is quiet; anything else explains itself
 */
export function filletClick(
  chain: FilletChainState | null,
  doc: SketchDoc,
  world: Vec2,
  tol: number,
): FilletClickOutcome {
  const corners = chain?.corners ?? []
  const pendingLineId = chain?.pendingLineId ?? null
  const pendingClick = chain?.pendingClick ?? null

  // Shared-corner gesture (only when no first line is pending — a
  // pending line means the user is mid line-pair).
  if (!pendingLineId) {
    const corner = pickCorner(doc.entities, world, tol)
    if (corner) {
      const next = toggleCorner(corners, {
        aId: corner.a.id, bId: corner.b.id,
        hintA: farOf(corner.a, corner.at), hintB: farOf(corner.b, corner.at),
        at: { x: corner.at.x, y: corner.at.y },
      })
      return {
        chain: { kind: 'fillet', corners: next, pendingLineId: null, pendingClick: null },
        notice: null,
      }
    }
  }

  const hit = pickFilletHost(doc.entities, world, tol)
  if (!hit) {
    if (!chain) return { chain: null, notice: null } // quiet idle click
    return {
      chain,
      notice: pendingLineId
        ? 'Fillet: click the second line of the corner (or Esc to cancel)'
        : 'Fillet: click more corners - or Apply in the overlay (Enter)',
    }
  }

  // First host of a pair (`pendingLineId` is retained for serialized state
  // compatibility even though it may now name a circular host).
  if (!pendingLineId) {
    return {
      chain: {
        kind: 'fillet', corners,
        pendingLineId: hit.id, pendingClick: { x: world.x, y: world.y },
      },
      notice: null,
    }
  }
  // Re-click on the pending line toggles it back off.
  if (hit.id === pendingLineId) {
    return {
      chain: { kind: 'fillet', corners, pendingLineId: null, pendingClick: null },
      notice: null,
    }
  }

  // Second host: resolve the local sharp intersection selected by both
  // picks. Circular pairs can have two intersections, so hints disambiguate.
  const a = doc.entities.find((e) => e.id === pendingLineId)
  if (!a || (a.kind !== 'line' && a.kind !== 'arc' && a.kind !== 'circle' &&
      a.kind !== 'ellipse' && a.kind !== 'elliptical-arc' && a.kind !== 'spline')) {
    return {
      chain: { kind: 'fillet', corners, pendingLineId: null, pendingClick: null },
      notice: 'Fillet: the first line is gone - pick again',
    }
  }
  const C = a.kind === 'line' && hit.kind === 'line'
    ? lineLineIntersection(a, hit)
    : selectSharpIntersection(a, hit, pendingClick ?? world, world)
  if (!C) return { chain, notice: 'Fillet: the lines are parallel - no corner to fillet' }
  if (typeof C === 'string') return { chain, notice: C }
  const next = toggleCorner(corners, {
    aId: pendingLineId, bId: hit.id,
    hintA: pendingClick ?? world,
    hintB: { x: world.x, y: world.y },
    at: C,
  })
  return {
    chain: { kind: 'fillet', corners: next, pendingLineId: null, pendingClick: null },
    notice: null,
  }
}
