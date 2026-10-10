// Auto-constraint inference on snap commit (Stage 3 chunk 3, PLAN 3.4:
// "Committed inferences become real constraints").
//
// PURE and headless-testable. While a tool chain is in progress the store
// records one PendingSnap per snapped click (the snap engine's
// inferences reference EXISTING entities only — the new geometry does not
// exist yet). When a click finally produces a ToolCommit, this module
// resolves each pending snap against the NEW entities in the commit and
// emits the real document constraints:
//
//   endpoint / center snap  -> coincident between the new entity's point
//                              site that landed on the snap and the
//                              existing entity's point site (shared
//                              point — geometry is never duplicated)
//   midpoint snap           -> midpoint(new point site, existing line)
//   intersection snap       -> point_on_object onto BOTH source curves
//   h-align / v-align       -> horizontal / vertical on the new line
//                              whose endpoints match the alignment pair;
//                              with `to` set (hover-wake remote
//                              alignment) the TWO-POINT horizontal /
//                              vertical between the new point site and
//                              the woken existing point instead
//
// When no new point site lands on the snap (e.g. a 3-point circle's rim
// click — the circle has only a center site) but the new CURVE passes
// through the snapped point, a coincident inference degrades to
// point_on_object(existing point site, new curve).
//
// Everything is deduplicated against the commit's own auto-constraints
// (chain-joining coincidents, the tangent arc's coincident+tangent, rect
// H/V sides), so snapping onto the point a tool wires up anyway never
// double-constrains.

import type {
  Vec2,
  SketchEntity,
  SketchConstraint,
  PointRef,
} from './types'
import type { SnapInference } from './snap'
import type { ToolCommit } from './tools/toolMachine'
import { ellipseFoci } from './ellipse'

/** One snapped click recorded while a chain is in progress. */
export interface PendingSnap {
  /** The snapped world position the click landed on. */
  point: Vec2
  inferences: SnapInference[]
  /** h/v-align only: the alignment reference point (chain previous). */
  alignFrom?: Vec2
}

// Snapped clicks land EXACTLY on the snap point and the tools copy click
// coordinates verbatim into the entities they build, so site matching is
// near-exact; the epsilon only absorbs analytic round-trips (circumcircle
// through a rim point, arc endpoint angle->position).
const EPS = 1e-6

function near(a: Vec2, b: Vec2): boolean {
  return Math.abs(a.x - b.x) <= EPS && Math.abs(a.y - b.y) <= EPS
}

/** All point sites a NEW entity exposes, with their current positions. */
function entitySites(e: SketchEntity): Array<{ ref: PointRef; at: Vec2 }> {
  switch (e.kind) {
    case 'block':
      // Solver-inert block: only the origin anchor is an addressable site.
      return [{ ref: { entityId: e.id, site: 'origin' }, at: e.origin }]
    case 'point':
      return [{ ref: { entityId: e.id, site: 'self' }, at: e.at }]
    case 'line':
      return [
        { ref: { entityId: e.id, site: 'start' }, at: e.start },
        { ref: { entityId: e.id, site: 'end' }, at: e.end },
      ]
    case 'circle':
      return [{ ref: { entityId: e.id, site: 'center' }, at: e.center }]
    case 'arc': {
      const at = (a: number): Vec2 => ({
        x: e.center.x + e.radius * Math.cos(a),
        y: e.center.y + e.radius * Math.sin(a),
      })
      return [
        { ref: { entityId: e.id, site: 'start' }, at: at(e.startAngle) },
        { ref: { entityId: e.id, site: 'end' }, at: at(e.endAngle) },
        { ref: { entityId: e.id, site: 'center' }, at: e.center },
      ]
    }
    case 'ellipse':
    case 'elliptical-arc': {
      // Center + the two foci are addressable sites (foci are materialized
      // as center-tied solver points by the gcs mapping). Collapsed foci
      // (circle-degenerate) are skipped — the center site owns that spot.
      const sites: Array<{ ref: PointRef; at: Vec2 }> = [
        { ref: { entityId: e.id, site: 'center' }, at: e.center },
      ]
      const foci = ellipseFoci(e)
      if (foci.length === 2) {
        sites.push({ ref: { entityId: e.id, site: 'focus1' }, at: foci[0] })
        sites.push({ ref: { entityId: e.id, site: 'focus2' }, at: foci[1] })
      }
      return sites
    }
    case 'spline':
      // Solver-inert: only the first through-point (anchor) is addressable.
      return [{ ref: { entityId: e.id, site: 'start' }, at: e.points[0] }]
    case 'text':
      // Solver-inert: only the baseline-left anchor is addressable.
      return [{ ref: { entityId: e.id, site: 'start' }, at: e.at }]
  }
}

/** First point site among the new entities that landed on `p`. */
function findSiteAt(entities: readonly SketchEntity[], p: Vec2): PointRef | null {
  for (const e of entities) {
    for (const s of entitySites(e)) {
      if (near(s.at, p)) return s.ref
    }
  }
  return null
}

/** Does the entity's CURVE pass through p (within EPS)? Used for the
 *  coincident -> point_on_object fallback (e.g. 3-pt circle rim snaps). */
function curvePassesThrough(e: SketchEntity, p: Vec2): boolean {
  switch (e.kind) {
    case 'block':
      // A block is a rigid container, not a snap curve (v1).
      return false
    case 'point':
      return false
    case 'line': {
      const dx = e.end.x - e.start.x
      const dy = e.end.y - e.start.y
      const len2 = dx * dx + dy * dy
      if (len2 === 0) return false
      let t = ((p.x - e.start.x) * dx + (p.y - e.start.y) * dy) / len2
      t = Math.max(0, Math.min(1, t))
      return Math.hypot(p.x - (e.start.x + t * dx), p.y - (e.start.y + t * dy)) <= EPS
    }
    case 'circle':
      return Math.abs(Math.hypot(p.x - e.center.x, p.y - e.center.y) - e.radius) <= EPS
    case 'arc': {
      if (Math.abs(Math.hypot(p.x - e.center.x, p.y - e.center.y) - e.radius) > EPS) {
        return false
      }
      const TWO_PI = Math.PI * 2
      const norm = (a: number) => ((a % TWO_PI) + TWO_PI) % TWO_PI
      const ang = Math.atan2(p.y - e.center.y, p.x - e.center.x)
      return norm(ang - e.startAngle) <= norm(e.endAngle - e.startAngle) + 1e-9
    }
    case 'ellipse':
    case 'elliptical-arc':
    case 'spline':
    case 'text':
      // Solver-inert: never report an ellipse/spline/text as a curve a point
      // lands ON (point_on_object is unsupported for them in the mapping; this
      // keeps the coincident -> point_on_object fallback from emitting a
      // constraint the solver would reject).
      return false
  }
}

function refsEqual(a: PointRef, b: PointRef): boolean {
  return a.entityId === b.entityId && a.site === b.site
}

/** Unordered coincident-pair duplicate check. */
function hasCoincident(cs: readonly SketchConstraint[], a: PointRef, b: PointRef): boolean {
  return cs.some(
    (c) =>
      c.kind === 'coincident' &&
      ((refsEqual(c.a, a) && refsEqual(c.b, b)) ||
        (refsEqual(c.a, b) && refsEqual(c.b, a)))
  )
}

function hasPointOnObject(
  cs: readonly SketchConstraint[], point: PointRef, object: string,
): boolean {
  return cs.some(
    (c) => c.kind === 'point_on_object' && refsEqual(c.point, point) && c.object === object
  )
}

function hasFix(cs: readonly SketchConstraint[], point: PointRef): boolean {
  return cs.some(
    (c) => c.kind === 'fix' && c.point !== undefined && refsEqual(c.point, point)
  )
}

function hasHV(
  cs: readonly SketchConstraint[], kind: 'horizontal' | 'vertical', line: string,
): boolean {
  return cs.some((c) => c.kind === kind && 'line' in c && c.line === line)
}

/** Unordered two-point horizontal/vertical duplicate check. */
function hasHVPoints(
  cs: readonly SketchConstraint[],
  kind: 'horizontal' | 'vertical',
  a: PointRef,
  b: PointRef,
): boolean {
  return cs.some(
    (c) =>
      c.kind === kind &&
      c.points !== undefined &&
      ((refsEqual(c.points[0], a) && refsEqual(c.points[1], b)) ||
        (refsEqual(c.points[0], b) && refsEqual(c.points[1], a)))
  )
}

function hasMidpoint(
  cs: readonly SketchConstraint[], point: PointRef, line: string,
): boolean {
  return cs.some(
    (c) => c.kind === 'midpoint' && refsEqual(c.point, point) && c.line === line
  )
}

/**
 * Resolve the pending snaps of a finished chain against the commit's new
 * entities. Returns ONLY the additional constraints (the caller appends
 * them to the commit's own constraints in the same undo step).
 */
export function inferenceConstraints(
  commit: ToolCommit,
  snaps: readonly PendingSnap[],
  newId: () => string,
): SketchConstraint[] {
  const out: SketchConstraint[] = []
  // Duplicate checks run against the commit's own constraints AND what
  // this pass has already emitted.
  const all = () => [...commit.constraints, ...out]

  for (const snap of snaps) {
    for (const inf of snap.inferences) {
      switch (inf.kind) {
        case 'coincident': {
          const site = findSiteAt(commit.entities, snap.point)
          if (site) {
            if (!hasCoincident(all(), site, inf.to)) {
              out.push({ id: newId(), kind: 'coincident', a: site, b: inf.to })
            }
            break
          }
          // No new point site landed there: if a new curve passes through
          // the snap, tie the EXISTING point onto that curve instead.
          const through = commit.entities.find((e) => curvePassesThrough(e, snap.point))
          if (through && !hasPointOnObject(all(), inf.to, through.id)) {
            out.push({
              id: newId(), kind: 'point_on_object', point: inf.to, object: through.id,
            })
          }
          break
        }

        case 'midpoint': {
          const site = findSiteAt(commit.entities, snap.point)
          if (site && !hasMidpoint(all(), site, inf.line)) {
            out.push({ id: newId(), kind: 'midpoint', point: site, line: inf.line })
          }
          break
        }

        case 'point_on_object': {
          const site = findSiteAt(commit.entities, snap.point)
          if (site && !hasPointOnObject(all(), site, inf.object)) {
            out.push({
              id: newId(), kind: 'point_on_object', point: site, object: inf.object,
            })
          }
          break
        }

        case 'grid': {
          const site = findSiteAt(commit.entities, snap.point)
          if (site && !hasFix(all(), site)) {
            out.push({ id: newId(), kind: 'fix', point: site })
          }
          break
        }

        case 'horizontal':
        case 'vertical': {
          // Two-point variant (hover-wake remote alignment): constrain
          // the NEW point site that landed on the snap to the woken
          // EXISTING point. Same Y = horizontal_pp, same X = vertical_pp.
          if (inf.to) {
            const site = findSiteAt(commit.entities, snap.point)
            if (site && !hasHVPoints(all(), inf.kind, site, inf.to)) {
              out.push({ id: newId(), kind: inf.kind, points: [site, inf.to] })
            }
            break
          }
          // Line variant: applies to the NEW line whose endpoints are the
          // alignment pair (snap point + alignment reference) in either
          // order.
          if (!snap.alignFrom) break
          const from = snap.alignFrom
          const line = commit.entities.find(
            (e) =>
              e.kind === 'line' &&
              ((near(e.start, from) && near(e.end, snap.point)) ||
                (near(e.start, snap.point) && near(e.end, from)))
          )
          if (line && !hasHV(all(), inf.kind, line.id)) {
            out.push({ id: newId(), kind: inf.kind, line: line.id })
          }
          break
        }
      }
    }
  }
  return out
}
