// Arc tools (Stage 3 chunk 2): 3-point arc, center-point arc, tangent arc.
//
// Same pure-machine contract as toolMachine.ts. Document arcs sweep CCW
// from startAngle to endAngle (types.ts canonical winding); every
// constructor below normalizes to that, and the previews tessellate the
// SAME analytic arc the click commits — preview and committed arc are
// identical by construction.
//
//   arc-3pt:     click start -> click end -> live preview of the arc
//                through start/end passing the cursor -> click commits
//   arc-center:  click center -> click start (sets radius + start angle)
//                -> live preview sweeping CCW to the cursor -> click sets
//                the end angle and commits
//   arc-tangent: click an EXISTING line/arc ENDPOINT (within tolerance) ->
//                live preview of the arc leaving tangent from it -> click
//                the arc's other end -> commits the arc PLUS a tangent
//                constraint and a coincident at the shared endpoint
//
// The solver side needs nothing new: gcsMapping already auto-adds the
// internal id:rules arc_rules constraint for every arc entity and maps
// 'tangent' line/arc and arc/arc pairs (Stage 1).

import type { Vec2, SketchEntity, SketchConstraint, SketchArcEntity } from '../types'
import type { ToolCommit } from './toolMachine'
import { circumcircle } from './circleTools'
import { arcSamplePoints, PREVIEW_ARC_DENSITY } from '../sketcher/geometry/arcTessellation'

const TWO_PI = Math.PI * 2

/** Normalize an angle into [0, 2*PI). */
function norm(a: number): number {
  return ((a % TWO_PI) + TWO_PI) % TWO_PI
}

// ---- Chain payloads -------------------------------------------------------

/** Tangent-arc anchor: the picked endpoint of an existing line/arc. */
export interface TangentFrom {
  entityId: string
  site: 'start' | 'end'
  /** Endpoint position (world mm). */
  point: Vec2
  /** Unit direction of travel LEAVING the entity at that endpoint. */
  dir: Vec2
}

export type ArcChainState =
  | { kind: 'arc'; mode: '3pt'; start: Vec2; end: Vec2 | null }
  | { kind: 'arc'; mode: 'center'; center: Vec2; start: Vec2 | null }
  | { kind: 'arc'; mode: 'tangent'; from: TangentFrom }

// ---- Analytic arc construction --------------------------------------------

/** An arc in document form plus which angular end the FIRST clicked point
 *  landed on ('start' = startAngle end, 'end' = endAngle end) — needed to
 *  aim the tangent tool's coincident constraint after CCW normalization. */
export interface BuiltArc {
  center: Vec2
  radius: number
  startAngle: number
  endAngle: number
  firstPointSite: 'start' | 'end'
}

/**
 * Arc from `s` to `e` passing through `thru`, CCW-normalized. Null when
 * the three points are (near-)collinear per `tol` (see circumcircle).
 */
export function arcThrough3Points(s: Vec2, e: Vec2, thru: Vec2, tol: number): BuiltArc | null {
  const c = circumcircle(s, thru, e, tol)
  if (!c) return null
  const aS = Math.atan2(s.y - c.center.y, s.x - c.center.x)
  const aE = Math.atan2(e.y - c.center.y, e.x - c.center.x)
  const aT = Math.atan2(thru.y - c.center.y, thru.x - c.center.x)
  // Does the CCW path s -> e pass through `thru`? Compare CCW offsets.
  const ccw = norm(aT - aS) <= norm(aE - aS)
  return ccw
    ? { center: c.center, radius: c.radius, startAngle: aS, endAngle: aE, firstPointSite: 'start' }
    : { center: c.center, radius: c.radius, startAngle: aE, endAngle: aS, firstPointSite: 'end' }
}

/**
 * Arc leaving `from.point` with tangent direction `from.dir`, ending at
 * `to`. The center sits on the normal of the tangent at the start point;
 * equal distance to both ends fixes it. Null when `to` is (within `tol`)
 * ON the tangent line — no finite arc exists there.
 */
export function tangentArcTo(from: TangentFrom, to: Vec2, tol: number): BuiltArc | null {
  const v = { x: to.x - from.point.x, y: to.y - from.point.y }
  const n = { x: -from.dir.y, y: from.dir.x } // left normal of the tangent
  const offAxis = v.x * n.x + v.y * n.y       // signed distance from tangent line
  if (Math.abs(offAxis) <= tol) return null
  const d = (v.x * v.x + v.y * v.y) / (2 * offAxis)
  const center = { x: from.point.x + n.x * d, y: from.point.y + n.y * d }
  const radius = Math.abs(d)
  const a0 = Math.atan2(from.point.y - center.y, from.point.x - center.x)
  const a1 = Math.atan2(to.y - center.y, to.x - center.x)
  // CCW travel tangent at the start point; if it matches the leaving
  // direction the arc runs CCW from the picked endpoint, else store it
  // reversed (document arcs are canonical CCW).
  const ccwTravel = -Math.sin(a0) * from.dir.x + Math.cos(a0) * from.dir.y > 0
  return ccwTravel
    ? { center, radius, startAngle: a0, endAngle: a1, firstPointSite: 'start' }
    : { center, radius, startAngle: a1, endAngle: a0, firstPointSite: 'end' }
}

/** Tessellate a CCW arc for preview rendering. Travel order: when the
 *  first clicked point is the endAngle end, points run end->start so the
 *  polyline still starts at the anchored point under the cursor.
 *
 *  WO SKC-14 (BK-88): the sweep walk itself now lives in exactly one module
 *  (sketcher/geometry/arcTessellation.ts). This function is the CAM-side
 *  adapter over it -- density policy + the firstPointSite travel-order rule.
 *  sketch3d's sampleArcPoints delegates to this same function, which is what
 *  lets arcCanonical.test.ts assert FULL-RANGE point agreement. */
export function tessellateArc(arc: BuiltArc): Vec2[] {
  const pts = arcSamplePoints(arc, PREVIEW_ARC_DENSITY)
  if (arc.firstPointSite === 'end') pts.reverse()
  return pts
}

// ---- Endpoint picking (tangent tool) ---------------------------------------

/** Position of a line/arc endpoint site. */
function endpointAt(e: SketchEntity, site: 'start' | 'end'): Vec2 | null {
  if (e.kind === 'line') return site === 'start' ? e.start : e.end
  if (e.kind === 'arc') {
    const a = site === 'start' ? e.startAngle : e.endAngle
    return { x: e.center.x + e.radius * Math.cos(a), y: e.center.y + e.radius * Math.sin(a) }
  }
  return null // points and circles have no endpoints
}

/** Unit direction of travel LEAVING entity `e` at the given endpoint:
 *  for a line, away from the other endpoint; for a CCW arc, the forward
 *  CCW tangent at 'end' and the reversed tangent at 'start'. */
function leavingDir(e: SketchEntity, site: 'start' | 'end'): Vec2 | null {
  if (e.kind === 'line') {
    const v = site === 'end'
      ? { x: e.end.x - e.start.x, y: e.end.y - e.start.y }
      : { x: e.start.x - e.end.x, y: e.start.y - e.end.y }
    const len = Math.hypot(v.x, v.y)
    if (len === 0) return null
    return { x: v.x / len, y: v.y / len }
  }
  if (e.kind === 'arc') {
    const a = site === 'start' ? e.startAngle : e.endAngle
    const ccw = { x: -Math.sin(a), y: Math.cos(a) }
    return site === 'end' ? ccw : { x: -ccw.x, y: -ccw.y }
  }
  return null
}

/** Nearest line/arc endpoint within `tol` of the click, with its leaving
 *  tangent direction; null when nothing qualifies. */
export function pickTangentFrom(
  entities: readonly SketchEntity[], world: Vec2, tol: number,
): TangentFrom | null {
  let best: TangentFrom | null = null
  let bestDist = tol
  for (const e of entities) {
    for (const site of ['start', 'end'] as const) {
      const p = endpointAt(e, site)
      if (!p) continue
      const dist = Math.hypot(world.x - p.x, world.y - p.y)
      if (dist > bestDist) continue
      const dir = leavingDir(e, site)
      if (!dir) continue
      bestDist = dist
      best = { entityId: e.id, site, point: { x: p.x, y: p.y }, dir }
    }
  }
  return best
}

// ---- Click behavior ---------------------------------------------------------

export interface ArcClickResult {
  chain: ArcChainState | null
  commit: ToolCommit | null
  notice: string | null
}

function commitArc(
  arc: BuiltArc, construction: boolean, newId: () => string,
  extraConstraints?: (arcId: string) => SketchConstraint[],
): ToolCommit {
  const id = newId()
  const entity: SketchArcEntity = {
    id,
    kind: 'arc',
    construction,
    center: { x: arc.center.x, y: arc.center.y },
    radius: arc.radius,
    startAngle: arc.startAngle,
    endAngle: arc.endAngle,
  }
  return { entities: [entity], constraints: extraConstraints ? extraConstraints(id) : [] }
}

export function arcClick(
  chain: ArcChainState | null,
  mode: ArcChainState['mode'],
  world: Vec2,
  closeTol: number,
  construction: boolean,
  newId: () => string,
  entities: readonly SketchEntity[],
): ArcClickResult {
  switch (mode) {
    case '3pt': {
      const c = chain?.mode === '3pt' ? chain : null
      if (!c) {
        return { chain: { kind: 'arc', mode: '3pt', start: { x: world.x, y: world.y }, end: null }, commit: null, notice: null }
      }
      if (!c.end) {
        if (Math.hypot(world.x - c.start.x, world.y - c.start.y) <= closeTol) {
          return { chain: c, commit: null, notice: null }
        }
        return { chain: { ...c, end: { x: world.x, y: world.y } }, commit: null, notice: null }
      }
      const arc = arcThrough3Points(c.start, c.end, world, closeTol)
      if (!arc) {
        return {
          chain: c, commit: null,
          notice: 'Arc: that third point is collinear with the endpoints - no arc there',
        }
      }
      return { chain: null, commit: commitArc(arc, construction, newId), notice: null }
    }

    case 'center': {
      const c = chain?.mode === 'center' ? chain : null
      if (!c) {
        return { chain: { kind: 'arc', mode: 'center', center: { x: world.x, y: world.y }, start: null }, commit: null, notice: null }
      }
      if (!c.start) {
        if (Math.hypot(world.x - c.center.x, world.y - c.center.y) <= closeTol) {
          return { chain: c, commit: null, notice: null } // zero radius
        }
        return { chain: { ...c, start: { x: world.x, y: world.y } }, commit: null, notice: null }
      }
      const radius = Math.hypot(c.start.x - c.center.x, c.start.y - c.center.y)
      const startAngle = Math.atan2(c.start.y - c.center.y, c.start.x - c.center.x)
      const endAngle = Math.atan2(world.y - c.center.y, world.x - c.center.x)
      // Zero-sweep guard in arc length so it scales with the radius.
      if (norm(endAngle - startAngle) * radius <= closeTol) {
        return { chain: c, commit: null, notice: null }
      }
      return {
        chain: null,
        commit: commitArc(
          { center: c.center, radius, startAngle, endAngle, firstPointSite: 'start' },
          construction, newId,
        ),
        notice: null,
      }
    }

    case 'tangent': {
      const c = chain?.mode === 'tangent' ? chain : null
      if (!c) {
        // First click must land on an existing line/arc endpoint; misses
        // are ignored (the tool stays armed, nothing anchors).
        const from = pickTangentFrom(entities, world, closeTol)
        if (!from) return { chain: null, commit: null, notice: null }
        return { chain: { kind: 'arc', mode: 'tangent', from }, commit: null, notice: null }
      }
      const arc = tangentArcTo(c.from, world, closeTol)
      if (!arc) {
        return {
          chain: c, commit: null,
          notice: 'Tangent arc: that point is on the tangent line - no finite arc exists there',
        }
      }
      return {
        chain: null,
        commit: commitArc(arc, construction, newId, (arcId) => [
          {
            id: newId(),
            kind: 'coincident',
            a: { entityId: c.from.entityId, site: c.from.site },
            b: { entityId: arcId, site: arc.firstPointSite },
          },
          { id: newId(), kind: 'tangent', a: c.from.entityId, b: arcId },
        ]),
        notice: null,
      }
    }
  }
}

/** Preview polyline for the in-progress arc at the cursor: the exact arc
 *  the next click commits, with straight-line fallbacks while the arc is
 *  not yet determined (or is degenerate at this cursor). */
export function arcPreview(chain: ArcChainState, cursor: Vec2): Vec2[] | null {
  switch (chain.mode) {
    case '3pt': {
      if (!chain.end) return [chain.start, { x: cursor.x, y: cursor.y }]
      const arc = arcThrough3Points(chain.start, chain.end, cursor, 0)
      if (!arc) return [chain.start, { x: cursor.x, y: cursor.y }, chain.end]
      return tessellateArc(arc)
    }
    case 'center': {
      if (!chain.start) return [chain.center, { x: cursor.x, y: cursor.y }]
      const radius = Math.hypot(chain.start.x - chain.center.x, chain.start.y - chain.center.y)
      const startAngle = Math.atan2(chain.start.y - chain.center.y, chain.start.x - chain.center.x)
      const endAngle = Math.atan2(cursor.y - chain.center.y, cursor.x - chain.center.x)
      return tessellateArc({ center: chain.center, radius, startAngle, endAngle, firstPointSite: 'start' })
    }
    case 'tangent': {
      const arc = tangentArcTo(chain.from, cursor, 0)
      if (!arc) return [chain.from.point, { x: cursor.x, y: cursor.y }]
      return tessellateArc(arc)
    }
  }
}
