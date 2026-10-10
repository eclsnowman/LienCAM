// Persistent CONSTRUCTION "defining geometry" for the generated shape tools
// (C2). Every generated tool (rect, polygon, slot, arc-slot) keeps the
// geometry that DEFINES it -- the center point, the slot centerline, the
// arc-slot centerline arc and its cap-center points -- as CONSTRUCTION
// entities that SURVIVE creation, render dashed, are EXCLUDED from the bake
// (bake.ts skips construction + points, so the cut Loop2D is unchanged), and
// can be dimensioned / constrained after the fact like any other entity. Built
// ONCE here and merged into each tool's ToolCommit by the builders.
//
// SOLVER SAFETY (this feeds the SHARED planegcs solver; ADR-0003 fail-loud):
//   - construction:true is FORCED on every entity here regardless of the
//     tool's draw-as-construction mode (a SOLID rect still gets a construction
//     center), so the defining geometry never leaks into the cut.
//   - The ties are MINIMAL and DoF-NEUTRAL / non-redundant by construction:
//       * A free construction POINT pinned by ONE coincident to a point that
//         ALREADY exists in the output (an arc 'center' site) adds 2 params +
//         2 equations = no DoF change and no redundancy.
//       * A centerline LINE whose endpoints are coincident to two such points
//         is a TREE (no cycle) -> DoF-neutral, no redundancy.
//       * The arc-slot centerline ARC is pinned ONLY by a `concentric` to the
//         body (so its CENTER tracks the slot). Its radius + angular span are
//         left as FREE DoF, parked at the as-drawn values by the solver's B23
//         free-DoF pass -- so the arc is radius/diameter-DIMENSIONABLE with NO
//         redundancy. Pinning its endpoints to the cap centers too would
//         double-determine the radius (arc through two equal-radius points
//         about a fixed center) -> a benign-but-noisy redundant advisory of
//         exactly the fillet-tangent kind C5 had to suppress; we AVOID it.
//   - The RECT center IS tied (D1): a CONSTRUCTION diagonal between two
//     opposite corners (its endpoints coincident to those corners) plus a
//     `midpoint` of the center on that diagonal. The diagonal is a TREE off
//     the existing corner points (endpoints pinned by 2 coincidents = -4 DoF
//     for +4 params) and the midpoint fully determines the center (+2 params
//     from the point, -2 from the midpoint's x/y). Net DoF change = 0 and no
//     cycle -> no redundancy; the center now tracks every corner edit. See
//     definingRectCenter.
//   - Polygon defining geometry is owned by polygonSlotTools: a construction
//     reference circle is tied to every vertex (inscribed) or side
//     (circumscribed), so its radius remains a driving, dimensionable value.

import type { SketchEntity, SketchConstraint, PointRef, Vec2 } from '../types'

/** Construction entities + the minimal constraints tying them to the output. */
export interface DefiningGeometry {
  entities: SketchEntity[]
  constraints: SketchConstraint[]
}

export const NO_DEFINING_GEOMETRY: DefiningGeometry = { entities: [], constraints: [] }

// ---- construction-forced constructors --------------------------------------

function constructionPoint(at: Vec2, id: string): SketchEntity {
  return { id, kind: 'point', construction: true, at: { x: at.x, y: at.y } }
}

function constructionLine(a: Vec2, b: Vec2, id: string): SketchEntity {
  return { id, kind: 'line', construction: true, start: { x: a.x, y: a.y }, end: { x: b.x, y: b.y } }
}

function constructionArc(
  center: Vec2, radius: number, startAngle: number, endAngle: number, id: string,
): SketchEntity {
  return { id, kind: 'arc', construction: true, center: { x: center.x, y: center.y }, radius, startAngle, endAngle }
}

function coincident(a: PointRef, b: PointRef, id: string): SketchConstraint {
  return { id, kind: 'coincident', a, b }
}

function concentric(a: string, b: string, id: string): SketchConstraint {
  return { id, kind: 'concentric', a, b }
}

function midpoint(line: string, point: PointRef, id: string): SketchConstraint {
  return { id, kind: 'midpoint', line, point }
}

const selfRef = (id: string): PointRef => ({ entityId: id, site: 'self' })
const centerRef = (id: string): PointRef => ({ entityId: id, site: 'center' })

// ---- rect: a TIED construction center (D1) --------------------------------
//
// A construction DIAGONAL line between two OPPOSITE corners, with its endpoints
// coincident to those corner points, plus the center pinned to the MIDPOINT of
// that diagonal. The midpoint of the diagonal between opposite corners IS the
// rectangle's geometric center for ANY rectangle (axis-aligned or rotated), so
// the center now tracks every corner edit.
//
// DoF-neutral (no over-constraint, no redundancy):
//   - diagonal: +4 params (two endpoints) - 4 (two coincidents pinning them to
//     the existing corner points) = 0; it is a TREE off the corners (no cycle).
//   - center: +2 params (the point) - 2 (the midpoint's x/y) = 0; fully
//     determined by the two diagonal endpoints, which are the corners.
// Both entities are forced construction (dashed, excluded from the bake). The
// B23 free-DoF parking pass sees these points as determined (their soft pins
// are redundant, tag -1, benign).
export function definingRectCenter(
  center: Vec2,
  cornerA: { at: Vec2; ref: PointRef },
  cornerB: { at: Vec2; ref: PointRef },
  newId: () => string,
): DefiningGeometry {
  const centerPt = newId(), diag = newId()
  return {
    entities: [
      constructionPoint(center, centerPt),
      constructionLine(cornerA.at, cornerB.at, diag),
    ],
    constraints: [
      coincident({ entityId: diag, site: 'start' }, cornerA.ref, newId()),
      coincident({ entityId: diag, site: 'end' }, cornerB.ref, newId()),
      midpoint(diag, selfRef(centerPt), newId()),
    ],
  }
}

// ---- slot: centerline = 2 cap-center points + a line connecting them -------
//
// Each cap-center point is coincident to its cap arc's center (benign: it sits
// where the arc center already is). The centerline line connects the two cap
// points. Tree structure -> DoF-neutral, no redundancy.
export function definingSlotCenterline(
  capA: { center: Vec2; arcId: string },
  capB: { center: Vec2; arcId: string },
  newId: () => string,
): DefiningGeometry {
  const pA = newId(), pB = newId(), line = newId()
  return {
    entities: [
      constructionPoint(capA.center, pA),
      constructionPoint(capB.center, pB),
      constructionLine(capA.center, capB.center, line),
    ],
    constraints: [
      coincident(selfRef(pA), centerRef(capA.arcId), newId()),
      coincident(selfRef(pB), centerRef(capB.arcId), newId()),
      coincident({ entityId: line, site: 'start' }, selfRef(pA), newId()),
      coincident({ entityId: line, site: 'end' }, selfRef(pB), newId()),
    ],
  }
}

// ---- arc-slot: centerline ARC (concentric to the body) + cap-center points -
//
// The centerline arc is concentric to a body arc (center tracks the slot) and
// seeded at the centerline radius/span (radius/diameter-dimensionable). Its
// endpoints are LEFT free (no coincident to the cap centers) to avoid the
// double-determined-radius redundancy -- they sit on the cap centers as drawn.
// Each cap-center point is coincident to its cap arc's center (benign).
//
// WO-1465: the centerline's radius must TRACK the body's half-width (outer
// and inner arc radii), not sit as a disconnected free DoF -- editing it used
// to leave the outer/inner radii untouched, which is what let the guide drift
// outside the slot body. Tie: outer.start and inner.start sit on the SAME ray
// from the shared center (both arcs start at the centerline's own startAngle,
// per arcSlotGeometry), so their midpoint is exactly the point at the true
// centerline radius. A construction line between those two EXISTING sites
// (tree off them, like definingRectCenter's diagonal: +4 params - 4
// coincident eqs = 0 net) plus a midpoint constraint pinning the centerline
// arc's OWN 'start' site to that midpoint consumes exactly the 2 DoF
// (radius, startAngle) the centerline arc's construction previously left
// free -- DoF-neutral, no redundancy against the body's own params. The
// centerline's endAngle (sweep) stays free, so it remains a distinct
// construction aid rather than a second, independently-drivable copy of the
// body (per the finding's own framing) -- only its radius is now driven.
export function definingArcSlotCenterline(
  capStart: { center: Vec2; arcId: string },
  capEnd: { center: Vec2; arcId: string },
  outer: { arcId: string; startAt: Vec2 },
  inner: { arcId: string; startAt: Vec2 },
  centerline: { center: Vec2; radius: number; startAngle: number; endAngle: number },
  newId: () => string,
): DefiningGeometry {
  const pS = newId(), pE = newId(), arc = newId(), halfWidthLine = newId()
  return {
    entities: [
      constructionPoint(capStart.center, pS),
      constructionPoint(capEnd.center, pE),
      constructionArc(centerline.center, centerline.radius, centerline.startAngle, centerline.endAngle, arc),
      constructionLine(outer.startAt, inner.startAt, halfWidthLine),
    ],
    constraints: [
      coincident(selfRef(pS), centerRef(capStart.arcId), newId()),
      coincident(selfRef(pE), centerRef(capEnd.arcId), newId()),
      concentric(arc, outer.arcId, newId()),
      coincident({ entityId: halfWidthLine, site: 'start' }, { entityId: outer.arcId, site: 'start' }, newId()),
      coincident({ entityId: halfWidthLine, site: 'end' }, { entityId: inner.arcId, site: 'start' }, newId()),
      midpoint(halfWidthLine, { entityId: arc, site: 'start' }, newId()),
    ],
  }
}
