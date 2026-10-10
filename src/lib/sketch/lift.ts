// Loop2D -> sketch entities lift (PLAN.md 3.1 / Stage 5, ADR-0016).
//
// Pure function: a layer's Loop2D[] in, sketch entities + coincident
// constraints out. This is bake.ts's INVERSE and reuses its conventions
// exactly so lift(bake(x)) == x and bake(lift(loops)) == loops hold
// geometrically:
//
//   - LoopSegment line          -> SketchLineEntity (start = implicit
//                                  'from', end = segment.to)
//   - LoopSegment arc           -> SketchArcEntity. Arc entities sweep CCW
//                                  startAngle -> endAngle (types.ts), so a
//                                  clockwise segment stores its 'to' point
//                                  at the entity's START site and its
//                                  'from' at the END site — the same
//                                  mapping bake's stepSegment applies when
//                                  walking an arc backward.
//   - single full-circle arc    -> SketchCircleEntity (the loopOptimizer /
//     (closed, from == to)         bake convention for standalone circles)
//   - loop WITHOUT segments[]   -> chain of line entities between
//                                  consecutive points (closed loops close
//                                  back onto points[0])
//
// Every chain joint (consecutive endpoints; plus last->first on closed
// chains) gets a coincident constraint so the lifted geometry stays
// connected under solver edits. NO fix constraints are added — the user
// edits freely; under-defined blue is the correct state for a fresh lift
// (PLAN 3.1: lift is entry into parametric editing, not a freeze).
//
// STL-projected layers (Layer2D.projectionPlane set) are READ-ONLY per
// ADR-0011 — callers must not lift them; this module only converts loops.

import type { Loop2D, LoopSegment, Vec2 } from '../../types'
import type {
  CoincidentConstraint,
  PointSite,
  SketchArcEntity,
  SketchCircleEntity,
  SketchEntity,
  SketchLineEntity,
} from './types'

// Below this, a polyline edge is noise, not geometry (bake excludes lines
// of this length too, so skipping keeps the round-trip symmetric).
const MIN_EDGE_LEN = 1e-9
// from == to tolerance for detecting a full-circle arc segment.
const FULL_CIRCLE_EPS = 1e-6

export interface LiftOptions {
  /** Entity/constraint id factory (injectable for deterministic tests). */
  newId?: () => string
}

export interface LiftResult {
  entities: SketchEntity[]
  constraints: CoincidentConstraint[]
  /** Loops that produced at least one entity. */
  liftedLoops: number
  /** Loops skipped entirely (no usable geometry, e.g. < 2 distinct points). */
  skippedLoops: number
}

// ---- Helpers ---------------------------------------------------------------

function angleAt(center: Vec2, p: Vec2): number {
  return Math.atan2(p.y - center.y, p.x - center.x)
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y)
}

/** One lifted curve plus which entity SITE sits at the chain's 'from' and
 *  'to' joints (arcs walked clockwise swap start/end, see header). */
interface ChainLink {
  entity: SketchLineEntity | SketchArcEntity
  fromSite: PointSite
  toSite: PointSite
}

function liftSegment(
  from: Vec2,
  seg: LoopSegment,
  newId: () => string,
): ChainLink | null {
  if (seg.type === 'line') {
    if (dist(from, seg.to) <= MIN_EDGE_LEN) return null
    const entity: SketchLineEntity = {
      id: newId(),
      kind: 'line',
      construction: false,
      start: { x: from.x, y: from.y },
      end: { x: seg.to.x, y: seg.to.y },
    }
    return { entity, fromSite: 'start', toSite: 'end' }
  }
  // Arc. Entities store CCW start->end; a clockwise segment is the same
  // geometry traversed backward, so its endpoints map to swapped sites.
  const a0 = angleAt(seg.center, from)
  const a1 = angleAt(seg.center, seg.to)
  const entity: SketchArcEntity = {
    id: newId(),
    kind: 'arc',
    construction: false,
    center: { x: seg.center.x, y: seg.center.y },
    radius: seg.radius,
    startAngle: seg.clockwise ? a1 : a0,
    endAngle: seg.clockwise ? a0 : a1,
  }
  return seg.clockwise
    ? { entity, fromSite: 'end', toSite: 'start' }
    : { entity, fromSite: 'start', toSite: 'end' }
}

// ---- Lift ------------------------------------------------------------------

export function liftLoops(loops: Loop2D[], opts: LiftOptions = {}): LiftResult {
  const newId = opts.newId ?? (() => crypto.randomUUID())

  const entities: SketchEntity[] = []
  const constraints: CoincidentConstraint[] = []
  let liftedLoops = 0
  let skippedLoops = 0

  const coincide = (
    a: ChainLink, b: ChainLink, // joint: a's 'to' meets b's 'from'
  ): CoincidentConstraint => ({
    id: newId(),
    kind: 'coincident',
    a: { entityId: a.entity.id, site: a.toSite },
    b: { entityId: b.entity.id, site: b.fromSite },
  })

  for (const loop of loops) {
    // -- Standalone full circle: closed loop whose single arc segment
    //    returns to its own start (bake emits circles exactly this way).
    if (
      loop.closed &&
      loop.segments?.length === 1 &&
      loop.segments[0].type === 'arc' &&
      dist(loop.points[0], loop.segments[0].to) <= FULL_CIRCLE_EPS
    ) {
      const seg = loop.segments[0]
      const circle: SketchCircleEntity = {
        id: newId(),
        kind: 'circle',
        construction: false,
        center: { x: seg.center.x, y: seg.center.y },
        radius: seg.radius,
      }
      entities.push(circle)
      liftedLoops++
      continue
    }

    // -- Build the chain: exact segments when present, else the bare
    //    polyline as a line chain.
    const links: ChainLink[] = []
    if (loop.segments && loop.segments.length > 0) {
      let from = loop.points[0]
      for (const seg of loop.segments) {
        const link = liftSegment(from, seg, newId)
        if (link) links.push(link)
        from = seg.to
      }
    } else {
      const pts = loop.points
      const last = loop.closed ? pts.length : pts.length - 1
      for (let i = 0; i < last; i++) {
        const from = pts[i]
        const to = pts[(i + 1) % pts.length]
        const link = liftSegment(from, { type: 'line', to }, newId)
        if (link) links.push(link)
      }
    }

    if (links.length === 0) { skippedLoops++; continue }

    // -- Coincident constraints at chain joints: between consecutive
    //    links, plus the closing joint on closed loops. A closed loop of
    //    ONE entity (full-circle arc) has no joints to constrain.
    for (let i = 0; i < links.length - 1; i++) {
      constraints.push(coincide(links[i], links[i + 1]))
    }
    if (loop.closed && links.length > 1) {
      constraints.push(coincide(links[links.length - 1], links[0]))
    }

    entities.push(...links.map((l) => l.entity))
    liftedLoops++
  }

  return { entities, constraints, liftedLoops, skippedLoops }
}
