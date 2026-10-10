// Extend tool (interaction framework rework: two-step flow).
//
// Step 1: click a line or arc (anywhere on it — or one of its ends).
// Step 2: the extension PREVIEWS live: the cursor's direction from the
// picked entity chooses the end that extends AND the boundary it reaches
// (drag farther along the extension to reach farther boundaries); a
// ghost segment shows exactly what the click will add. The click
// commits. A circle is rejected up front (no end to extend).
//
// Candidates: intersections of the entity's own infinite line / full
// circle with every other non-construction entity's REAL span, strictly
// beyond the chosen end (same doctrine as trim: construction geometry
// neither cuts nor bounds).
//
// The moved endpoint keeps its id and site, so every existing constraint
// on it survives untouched — EXCEPT constraints that pin the endpoint at
// its OLD location, which are repaired instead of left to fight the
// solver (see repairMovedEndConstraints):
//   - coincident on the moved end (a fillet-arc joint, a corner partner)
//     CONVERTS to point_on_object(partner, target): the joint point stays
//     anchored at the "virtual corner" ON the now-longer curve, and an
//     entity-level tangent (which never referenced the endpoint) keeps
//     holding — the user's fillet stays tangent at the virtual
//     intersection while the line extends past it
//   - point_on_object / midpoint / symmetric / fix ANCHORED ON the moved
//     end are dropped: each one pins the endpoint somewhere it no longer
//     is, and keeping it would either snap the extension back or conflict
//   - length-style dims (distance/X/Y) touching the moved end are
//     re-measured: the value updates to the extended geometry instead of
//     silently fighting the landing constraint
// The landing gets a NEW constraint onto the boundary: coincident when it
// lands exactly on one of the boundary's own endpoints, point_on_object
// otherwise (parametric intent — the joint stays on the boundary through
// future solves).

import type {
  Vec2,
  PointRef,
  SketchEntity,
  SketchArcEntity,
  SketchCircleEntity,
  SketchLineEntity,
  SketchConstraint,
  SketchDimension,
} from '../types'
import { entityIntersections } from '../snap'
import { ellipseFocusSite } from '../ellipse'
import { measureDimension } from './dimTool'
import { pickCurve, tallyClauses, type SketchDoc, type SketchDocTransform } from './trimTool'
import { entityLabels } from '../browserModel'
import { constraintKindLabel } from '../constraintActions'
import { detachProjectedFixes, markProjectedGeometryDetached } from '../projectedEdit'

const TWO_PI = Math.PI * 2
// An intersection must lie strictly beyond the end to be a target.
const EPS_BEYOND = 1e-9
// Landing within this of a boundary endpoint upgrades to coincident.
const EPS_TOUCH = 1e-6

function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function arcSweep(e: SketchArcEntity): number {
  const s = norm(e.endAngle - e.startAngle)
  return s < 1e-9 ? TWO_PI : s
}

function arcPointAt(e: { center: Vec2; radius: number }, angle: number): Vec2 {
  return {
    x: e.center.x + e.radius * Math.cos(angle),
    y: e.center.y + e.radius * Math.sin(angle),
  }
}

// ---- Chain state (CHAINING payload) -----------------------------------------

export interface ExtendChainState {
  kind: 'extend'
  /** Entity picked in step 1 (line or arc). */
  targetId: string
}

export interface ExtendClickOutcome {
  chain: ExtendChainState | null
  transform: SketchDocTransform | null
  notice: string | null
}

// ---- Boundaries -----------------------------------------------------------------

/** Boundary entities the extension may land on (same doctrine as trim:
 *  construction geometry neither cuts nor bounds). */
function boundaries(doc: SketchDoc, targetId: string): SketchEntity[] {
  return doc.entities.filter(
    (e) => e.id !== targetId && !e.construction && e.kind !== 'point'
  )
}

// ---- Infinite-line extension targets -------------------------------------------

/** Unbounded parameter t of the infinite line through start->end
 *  (t = 0 at start, 1 at end) for every intersection with `other`'s
 *  ACTUAL span. Exact math — no big-segment approximation. */
function infiniteLineHits(
  line: SketchLineEntity, other: SketchEntity,
): Array<{ t: number; point: Vec2 }> {
  const dx = line.end.x - line.start.x
  const dy = line.end.y - line.start.y
  const len2 = dx * dx + dy * dy
  if (len2 <= 0) return []
  const out: Array<{ t: number; point: Vec2 }> = []

  if (other.kind === 'line') {
    const ex = other.end.x - other.start.x
    const ey = other.end.y - other.start.y
    const denom = dx * ey - dy * ex
    if (Math.abs(denom) < 1e-12) return [] // parallel
    const wx = other.start.x - line.start.x
    const wy = other.start.y - line.start.y
    const t = (wx * ey - wy * ex) / denom
    const u = (wx * dy - wy * dx) / denom
    if (u < 0 || u > 1) return [] // off the boundary's actual span
    out.push({ t, point: { x: line.start.x + t * dx, y: line.start.y + t * dy } })
    return out
  }

  if (other.kind === 'circle' || other.kind === 'arc') {
    // |start + tD - C|^2 = r^2
    const fx = line.start.x - other.center.x
    const fy = line.start.y - other.center.y
    const A = len2
    const B = 2 * (fx * dx + fy * dy)
    const C = fx * fx + fy * fy - other.radius * other.radius
    const disc = B * B - 4 * A * C
    if (disc < 0) return []
    const sq = Math.sqrt(disc)
    for (const t of [(-B - sq) / (2 * A), (-B + sq) / (2 * A)]) {
      const p = { x: line.start.x + t * dx, y: line.start.y + t * dy }
      if (other.kind === 'arc') {
        const rel = norm(Math.atan2(p.y - other.center.y, p.x - other.center.x) - other.startAngle)
        if (rel > arcSweep(other) + 1e-9) continue
      }
      if (out.length === 1 && Math.abs(out[0].t - t) < 1e-12) continue // tangent double root
      out.push({ t, point: p })
    }
  }
  return out
}

// ---- Candidates ------------------------------------------------------------------

/** One reachable extension target: extend `end` of the entity to land
 *  at `point` on `boundary`. `along` orders candidates outward from the
 *  end (line: |t| distance past the end; arc: angular travel). */
export interface ExtendCandidate {
  end: 'start' | 'end'
  point: Vec2
  boundary: SketchEntity
  along: number
  /** Line: unbounded t of the landing. Arc: absolute landing angle. */
  param: number
}

/** Every boundary landing reachable beyond either end of the target,
 *  per end sorted nearest-first. */
export function extendCandidates(
  doc: SketchDoc, target: SketchLineEntity | SketchArcEntity,
): ExtendCandidate[] {
  const out: ExtendCandidate[] = []
  if (target.kind === 'line') {
    for (const b of boundaries(doc, target.id)) {
      for (const hit of infiniteLineHits(target, b)) {
        if (hit.t > 1 + EPS_BEYOND) {
          out.push({ end: 'end', point: hit.point, boundary: b, along: hit.t - 1, param: hit.t })
        } else if (hit.t < -EPS_BEYOND) {
          out.push({ end: 'start', point: hit.point, boundary: b, along: -hit.t, param: hit.t })
        }
      }
    }
  } else {
    const sweep = arcSweep(target)
    // Targets live on the arc's own FULL circle, outside the current
    // sweep. Angular headroom: extending may not pass the OTHER end.
    const fullCircle: SketchCircleEntity = {
      id: '__extend__', kind: 'circle', construction: false,
      center: target.center, radius: target.radius,
    }
    const headroom = TWO_PI - sweep
    for (const b of boundaries(doc, target.id)) {
      for (const p of entityIntersections(fullCircle, b)) {
        const a = norm(Math.atan2(p.y - target.center.y, p.x - target.center.x))
        for (const end of ['end', 'start'] as const) {
          const travel = end === 'end' ? norm(a - target.endAngle) : norm(target.startAngle - a)
          if (travel <= EPS_BEYOND || travel >= headroom - EPS_BEYOND) continue
          out.push({ end, point: p, boundary: b, along: travel, param: a })
        }
      }
    }
  }
  out.sort((a, b) => a.along - b.along)
  return out
}

/**
 * The candidate the CURSOR selects: the cursor's position along the
 * extension chooses the end (which side of the entity it is on) and how
 * far to extend — the nearest candidate at-or-past the cursor, falling
 * back to the farthest when the cursor overshoots them all and to the
 * nearest when the cursor is still over the entity itself. Pure; the
 * preview and the commit resolve through this SAME function.
 */
export function resolveExtend(
  doc: SketchDoc, target: SketchLineEntity | SketchArcEntity, cursor: Vec2,
): ExtendCandidate | null {
  const all = extendCandidates(doc, target)
  if (all.length === 0) return null

  let end: 'start' | 'end'
  let cursorAlong: number // how far past the chosen end the cursor sits
  if (target.kind === 'line') {
    const dx = target.end.x - target.start.x
    const dy = target.end.y - target.start.y
    const len2 = dx * dx + dy * dy
    if (len2 <= 0) return null
    const t = ((cursor.x - target.start.x) * dx + (cursor.y - target.start.y) * dy) / len2
    end = t >= 0.5 ? 'end' : 'start'
    cursorAlong = end === 'end' ? Math.max(0, t - 1) : Math.max(0, -t)
  } else {
    const sweep = arcSweep(target)
    const rel = norm(
      Math.atan2(cursor.y - target.center.y, cursor.x - target.center.x) - target.startAngle,
    )
    if (rel <= sweep) {
      // Cursor over the arc itself: nearer end extends.
      end = rel >= sweep / 2 ? 'end' : 'start'
      cursorAlong = 0
    } else {
      // Cursor beyond the sweep: the end it is beyond extends.
      const beyondEnd = rel - sweep        // travel past endAngle
      const beyondStart = TWO_PI - rel     // travel past startAngle (CW)
      end = beyondEnd <= beyondStart ? 'end' : 'start'
      cursorAlong = end === 'end' ? beyondEnd : beyondStart
    }
  }

  const side = all.filter((c) => c.end === end)
  if (side.length === 0) return null
  // Nearest candidate at-or-past the cursor; overshoot = the farthest.
  for (const c of side) {
    if (c.along >= cursorAlong - EPS_BEYOND) return c
  }
  return side[side.length - 1]
}

// ---- Coincident-vs-point_on_object upgrade ---------------------------------------

/** Boundary point site at the landing point, if the landing is exactly a
 *  boundary endpoint (within EPS_TOUCH). Centers are NOT on the curve. */
function boundarySiteAt(boundary: SketchEntity, p: Vec2): PointRef | null {
  switch (boundary.kind) {
    case 'line':
      if (dist(p, boundary.start) <= EPS_TOUCH) return { entityId: boundary.id, site: 'start' }
      if (dist(p, boundary.end) <= EPS_TOUCH) return { entityId: boundary.id, site: 'end' }
      return null
    case 'arc': {
      if (dist(p, arcPointAt(boundary, boundary.startAngle)) <= EPS_TOUCH) {
        return { entityId: boundary.id, site: 'start' }
      }
      if (dist(p, arcPointAt(boundary, boundary.endAngle)) <= EPS_TOUCH) {
        return { entityId: boundary.id, site: 'end' }
      }
      return null
    }
    default:
      return null // circles have no curve endpoints
  }
}

function landingConstraint(
  newId: () => string, movedSite: PointRef, boundary: SketchEntity, p: Vec2,
): SketchConstraint {
  const site = boundarySiteAt(boundary, p)
  if (site) {
    return { id: newId(), kind: 'coincident', a: movedSite, b: site }
  }
  return { id: newId(), kind: 'point_on_object', point: movedSite, object: boundary.id }
}

// ---- Constraint repair on the moved endpoint ---------------------------------------
//
// Repair table for constraints touching the MOVED endpoint (everything
// not listed is kept verbatim — the endpoint keeps its id and site, so
// references stay valid; entity-level constraints like tangent never
// referenced the endpoint at all and survive by construction):
//
//   coincident(moved, other)   CONVERT -> point_on_object(other, target)
//                              The joint partner stays anchored ON the
//                              extended curve at the virtual corner; a
//                              fillet arc keeps its tangent + stays
//                              attached while the line grows past it.
//                              (Same-entity coincident is kept verbatim:
//                              there is no partner to re-anchor.)
//   point_on_object(moved, X)  DROP — it pinned the endpoint onto X; the
//                              endpoint deliberately moved off X, and the
//                              landing adds the new on-curve constraint.
//   midpoint(moved, L)         DROP — pinned the endpoint at L's midpoint.
//   symmetric(moved, ...)      DROP — pinned the endpoint at a mirror spot.
//   fix(moved)                 DROP — the user just moved the grounded
//                              point on purpose; keeping the ground would
//                              snap the extension back.
//   horizontal/vertical pair   KEEP — orientation intent, not a position
//                              pin (extension is along the same curve).
//   distance/X/Y dim on moved  RE-MEASURE — value updates to the extended
//                              geometry (a stale driving value would fight
//                              the landing constraint on the next solve).

/** One repair the extend made beyond moving the endpoint. The click
 *  layer turns these into the flash notice (repair transparency). */
export interface ExtendRepair {
  action: 'converted' | 'dropped' | 'remeasured'
  /** Constraint/dimension kind that was repaired. */
  kind: SketchConstraint['kind'] | SketchDimension['kind']
  /** Other entity involved (label lookup for notices), if any. */
  otherId: string | null
}

function refEq(a: PointRef, b: PointRef): boolean {
  return a.entityId === b.entityId && a.site === b.site
}

function repairMovedEndConstraints(
  constraints: readonly SketchConstraint[],
  moved: PointRef,
): { constraints: SketchConstraint[]; repairs: ExtendRepair[] } {
  const out: SketchConstraint[] = []
  const repairs: ExtendRepair[] = []
  for (const c of constraints) {
    switch (c.kind) {
      case 'coincident': {
        const hitsA = refEq(c.a, moved)
        const hitsB = refEq(c.b, moved)
        if (!hitsA && !hitsB) { out.push(c); break }
        const other = hitsA ? c.b : c.a
        if (other.entityId === moved.entityId) { out.push(c); break }
        out.push({ id: c.id, kind: 'point_on_object', point: other, object: moved.entityId })
        repairs.push({ action: 'converted', kind: 'coincident', otherId: other.entityId })
        break
      }
      case 'point_on_object':
        if (refEq(c.point, moved)) {
          repairs.push({ action: 'dropped', kind: c.kind, otherId: c.object })
        } else out.push(c)
        break
      case 'midpoint':
        if (refEq(c.point, moved)) {
          repairs.push({ action: 'dropped', kind: c.kind, otherId: c.line })
        } else out.push(c)
        break
      case 'symmetric':
        if (refEq(c.a, moved) || refEq(c.b, moved)) {
          repairs.push({
            action: 'dropped', kind: c.kind,
            otherId: refEq(c.a, moved) ? c.b.entityId : c.a.entityId,
          })
        } else out.push(c)
        break
      case 'fix':
        if (c.point && refEq(c.point, moved)) {
          repairs.push({ action: 'dropped', kind: c.kind, otherId: null })
        } else out.push(c)
        break
      case 'pierce':
        // WO-1865: extending the pierced end moves it off the crossing on purpose -- the pierce
        // is released (named in the notice) exactly like a Fix on that end.
        if (refEq(c.point, moved)) {
          repairs.push({ action: 'dropped', kind: c.kind, otherId: null })
        } else out.push(c)
        break
      default:
        out.push(c)
    }
  }
  return { constraints: out, repairs }
}

/** Coordinates of a point site against the given entity list. */
function sitePoint(entities: readonly SketchEntity[], ref: PointRef): Vec2 | null {
  const e = entities.find((x) => x.id === ref.entityId)
  if (!e) return null
  switch (e.kind) {
    case 'point':  return ref.site === 'self' ? e.at : null
    case 'line':   return ref.site === 'start' ? e.start
                      : ref.site === 'end' ? e.end
                      : ref.site === 'center'
                        ? { x: (e.start.x + e.end.x) / 2, y: (e.start.y + e.end.y) / 2 }
                        : null
    case 'circle': return ref.site === 'center' ? e.center : null
    case 'arc':
      if (ref.site === 'center') return e.center
      if (ref.site === 'start') return arcPointAt(e, e.startAngle)
      if (ref.site === 'end') return arcPointAt(e, e.endAngle)
      return null
    case 'ellipse':
    case 'elliptical-arc':
      // Center + derived foci (foci collapse onto the center when circle-
      // degenerate) — mirrors dimTool.resolvePoint so a dim whose OTHER end
      // is a focus still re-measures after an extend.
      if (ref.site === 'center') return e.center
      if (ref.site === 'focus1' || ref.site === 'focus2') return ellipseFocusSite(e, ref.site)
      return null
    case 'spline':
      return ref.site === 'start' ? e.points[0] : null
    case 'text':
      return ref.site === 'start' ? e.at : null
    case 'block':
      return ref.site === 'origin' ? e.origin : null
  }
}

function remeasureMovedEndDims(
  dimensions: readonly SketchDimension[],
  moved: PointRef,
  newEntities: readonly SketchEntity[],
): { dimensions: SketchDimension[]; repairs: ExtendRepair[] } {
  const out: SketchDimension[] = []
  const repairs: ExtendRepair[] = []
  for (const d of dimensions) {
    // WO-1867: an ordinate whose datum or measured point is the extended
    // endpoint re-measures against the new geometry, exactly like a length
    // dimension on that endpoint. Signed (point - origin along the axis) --
    // NOT abs'd like the length kinds below, because an ordinate's sign is its
    // direction from the datum and the solver mapping keeps it signed.
    if (d.kind === 'ordinate' && (refEq(d.origin, moved) || refEq(d.point, moved))) {
      const po = sitePoint(newEntities, d.origin)
      const pp = sitePoint(newEntities, d.point)
      if (po && pp) {
        out.push({ ...d, value: d.axis === 'x' ? pp.x - po.x : pp.y - po.y })
        const otherRef = refEq(d.origin, moved) ? d.point : d.origin
        repairs.push({ action: 'remeasured', kind: d.kind, otherId: otherRef.entityId })
        continue
      }
    }
    // WO-1868: a three-point angle with the extended endpoint as its vertex or
    // either leg point re-measures against the new geometry, in its own stored
    // sector (measureDimension keeps reverseB/ccw), so a driving angle does not
    // drag the extension back.
    if (d.kind === 'angle3' &&
        (refEq(d.vertex, moved) || refEq(d.a, moved) || refEq(d.b, moved))) {
      const value = measureDimension(newEntities, d)
      if (value !== null) {
        out.push({ ...d, value })
        const otherRef = !refEq(d.vertex, moved) ? d.vertex : d.a
        repairs.push({ action: 'remeasured', kind: d.kind, otherId: otherRef.entityId })
        continue
      }
    }
    if (
      (d.kind === 'distance' || d.kind === 'distanceX' || d.kind === 'distanceY') &&
      (refEq(d.a, moved) || refEq(d.b, moved))
    ) {
      const pa = sitePoint(newEntities, d.a)
      const pb = sitePoint(newEntities, d.b)
      if (pa && pb) {
        const value =
          d.kind === 'distance' ? dist(pa, pb) :
          d.kind === 'distanceX' ? Math.abs(pb.x - pa.x) : Math.abs(pb.y - pa.y)
        out.push({ ...d, value })
        const otherRef = refEq(d.a, moved) ? d.b : d.a
        repairs.push({ action: 'remeasured', kind: d.kind, otherId: otherRef.entityId })
        continue
      }
    }
    out.push(d)
  }
  return { dimensions: out, repairs }
}

// ---- Transform -------------------------------------------------------------------

export interface ExtendTransformResult {
  transform: SketchDocTransform
  /** Constraint repairs the extension performed (notice fodder). */
  repairs: ExtendRepair[]
}

/** Document transform applying `cand` to `target` (the commit), with the
 *  moved-endpoint constraint repairs applied (see the repair table). */
export function buildExtendTransform(
  doc: SketchDoc,
  target: SketchLineEntity | SketchArcEntity,
  cand: ExtendCandidate,
  newId: () => string,
): ExtendTransformResult {
  let entity: SketchEntity
  if (target.kind === 'line') {
    entity = cand.end === 'end'
      ? { ...target, end: { x: cand.point.x, y: cand.point.y } }
      : { ...target, start: { x: cand.point.x, y: cand.point.y } }
  } else {
    entity = cand.end === 'end'
      ? { ...target, endAngle: cand.param }
      : { ...target, startAngle: cand.param }
  }
  const movedSite: PointRef = { entityId: target.id, site: cand.end }
  const entities = doc.entities.map((e) => (e.id === target.id ? entity : e))
  const repaired = repairMovedEndConstraints(doc.constraints, movedSite)
  const dims = remeasureMovedEndDims(doc.dimensions, movedSite, entities)
  return {
    transform: {
      entities: markProjectedGeometryDetached(doc.entities, entities, [target.id]),
      constraints: detachProjectedFixes(doc.entities, [
        ...repaired.constraints,
        landingConstraint(newId, movedSite, cand.boundary, cand.point),
      ], [target.id]),
      dimensions: dims.dimensions,
    },
    repairs: [...repaired.repairs, ...dims.repairs],
  }
}

// ---- Ghost preview ----------------------------------------------------------------

/** Ghost polyline of the extension the cursor currently selects: from
 *  the moving endpoint to the landing (tessellated along the arc's own
 *  circle for arcs), or null when nothing resolves. The commit applies
 *  the SAME resolveExtend result, so ghost end == committed endpoint. */
export function extendPreview(
  chain: ExtendChainState, doc: SketchDoc, cursor: Vec2,
): Vec2[] | null {
  const target = doc.entities.find((e) => e.id === chain.targetId)
  if (!target || (target.kind !== 'line' && target.kind !== 'arc')) return null
  const cand = resolveExtend(doc, target, cursor)
  if (!cand) return null
  if (target.kind === 'line') {
    const from = cand.end === 'end' ? target.end : target.start
    return [{ x: from.x, y: from.y }, { x: cand.point.x, y: cand.point.y }]
  }
  // Arc: ghost rides the arc's own circle from the moving end to the
  // landing angle (CCW past the end; CW before the start).
  const fromAngle = cand.end === 'end' ? target.endAngle : target.startAngle
  const sweep = cand.end === 'end'
    ? norm(cand.param - fromAngle)
    : -norm(fromAngle - cand.param)
  const n = Math.max(8, Math.ceil((Math.abs(sweep) * target.radius) / 0.5))
  const pts: Vec2[] = []
  for (let i = 0; i <= n; i++) {
    pts.push(arcPointAt(target, fromAngle + (sweep * i) / n))
  }
  return pts
}

// ---- Repair notices ---------------------------------------------------------------
//
// Repair TRANSPARENCY: every repair beyond moving the endpoint is
// summarized in the commit flash — the joint conversion, every dropped
// pin, every re-measured dim. No repairs = null notice (the generic
// "Extended ..." flash speaks instead).

function extendRepairNotice(
  doc: SketchDoc, targetId: string, repairs: readonly ExtendRepair[],
): string | null {
  if (repairs.length === 0) return null
  const labels = entityLabels(doc.entities)
  const label = labels.get(targetId) ?? 'entity'
  const clauses = repairs.map((r) => {
    const other = r.otherId ? labels.get(r.otherId) ?? 'entity' : null
    switch (r.action) {
      case 'converted':
        return `${other ?? 'joint'} stays joined at the virtual corner`
      case 'dropped':
        return other
          ? `dropped ${constraintKindLabel(r.kind)} to ${other} (endpoint moved)`
          : `dropped ${constraintKindLabel(r.kind)} (endpoint moved)`
      case 'remeasured':
        return `re-measured ${constraintKindLabel(r.kind)} dim`
    }
  })
  return `Extended ${label}: ${tallyClauses(clauses).join(', ')}`
}

// ---- Click behavior -----------------------------------------------------------------

/**
 * CLICK(p) for the armed extend tool (two-step flow):
 *   - no chain: pick the entity to extend (a circle is rejected with a
 *     notice; an empty click is quiet)
 *   - chain: commit the extension the cursor direction selects (the
 *     same resolution the ghost previewed); nothing reachable on that
 *     side explains itself and keeps the pick
 */
export function extendClick(
  chain: ExtendChainState | null,
  doc: SketchDoc,
  world: Vec2,
  tol: number,
  newId: () => string = () => crypto.randomUUID(),
): ExtendClickOutcome {
  if (!chain) {
    const target = pickCurve(doc.entities, world, tol)
    if (!target) return { chain: null, transform: null, notice: null }
    if (target.kind === 'circle') {
      return {
        chain: null, transform: null,
        notice: 'Extend: a circle is closed - it has no end to extend',
      }
    }
    if (target.kind === 'point') return { chain: null, transform: null, notice: null }
    return { chain: { kind: 'extend', targetId: target.id }, transform: null, notice: null }
  }

  const target = doc.entities.find((e) => e.id === chain.targetId)
  if (!target || (target.kind !== 'line' && target.kind !== 'arc')) {
    return { chain: null, transform: null, notice: 'Extend: the picked entity is gone' }
  }
  const cand = resolveExtend(doc, target, world)
  if (!cand) {
    return {
      chain, transform: null,
      notice: 'Extend: nothing in that direction to extend to - move toward a boundary (Esc to re-pick)',
    }
  }
  const built = buildExtendTransform(doc, target, cand, newId)
  return {
    chain: null,
    transform: built.transform,
    notice: extendRepairNotice(doc, target.id, built.repairs),
  }
}
