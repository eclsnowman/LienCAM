// Smart-dimension PLACEMENT resolver (live drag-to-place, Tier 1a).
//
// SINGLE source of truth for BOTH the live leader/witness preview (drawn
// through the toolOverlay dimGuides channel as the cursor moves) AND the
// final commit (the dropped dimension). Feeding both from one function is
// what guarantees the preview-equals-commit invariant: what you see while
// dragging is EXACTLY what lands on the click.
//
// What it adds over planDimension (which is orientation-blind): for the
// linear point-to-point cases it AUTO-PICKS the dimension orientation from
// the drag vector -- aligned (true distance), horizontal-measuring
// (distanceX), or vertical-measuring (distanceY) -- so a single click drop
// produces the dimension the user was dragging toward. Every other operand
// combination planDimension already disambiguates (point+line and parallel
// lines -> distancePL, two lines -> angle, circle/arc -> diameter/radius)
// flows through unchanged; this resolver only chooses orientation and
// builds the witness graphics for ALL of them.
//
// PURE module (toolMachine doctrine): no store, no three.js, no DOM. The
// witness/leader polylines mirror the committed leader geometry in
// sketchLayer.buildDimensionGraphics so the preview matches the result.

import type { Vec2, SketchEntity, SketchConstraint, SketchDimensionKind } from '../types'
import {
  planDimension, resolvePoint, dist, positiveArcSweep, selectAngleSector, selectAngle3Sector, linesParallel,
  lineAngle, angleOperandSegment, lineLineIntersection, ordinateForceAxis,
  type PlannedDimension, type DimOperandRef, type DimForceMode,
} from './dimTool'
import { ellipseAxisDimLeader, ellipseFocusSite, nearestPointOnEllipse } from '../ellipse'
import { arcSamplePoints, DIM_GUIDE_ARC_DENSITY } from '../sketcher/geometry/arcTessellation'
import {
  SKETCH_AXIS_X_ENTITY_ID,
  SKETCH_AXIS_Y_ENTITY_ID,
} from '../sketchAnchors'

// A linear feature within this angle of a world axis is treated as
// axis-aligned: 'aligned' is redundant there (a horizontal line wants a
// horizontal dimension, not an "aligned" one), so the aligned candidate is
// dropped and only horizontal/vertical remain. ~5 deg.
export const AXIS_ALIGNED_BAND_RAD = (5 * Math.PI) / 180

// SKC-72: the initial placement click is a convenience drop, not an
// unrestricted layout edit. Match stagedSizeDrag's established
// geometry-relative "sane" band; later label dragging remains unrestricted.
const INITIAL_OFFSET_FRACTION = 0.35
const INITIAL_OFFSET_MIN_MM = 0.5
const INITIAL_OFFSET_MAX_MM = 25

export function initialDimPlacementOffsetLimit(characteristicSpan: number): number {
  const finiteSpan = Number.isFinite(characteristicSpan) && characteristicSpan > 0
    ? characteristicSpan
    : 0
  return Math.max(
    INITIAL_OFFSET_MIN_MM,
    Math.min(INITIAL_OFFSET_MAX_MM, INITIAL_OFFSET_FRACTION * finiteSpan),
  )
}

function nearestOf(points: readonly Vec2[], cursor: Vec2): Vec2 {
  let best = points[0] ?? cursor
  let bestDistance = dist(best, cursor)
  for (let i = 1; i < points.length; i++) {
    const candidateDistance = dist(points[i], cursor)
    if (candidateDistance < bestDistance) {
      best = points[i]
      bestDistance = candidateDistance
    }
  }
  return best
}

function nearestOnSegment(cursor: Vec2, a: Vec2, b: Vec2): Vec2 {
  const dx = b.x - a.x
  const dy = b.y - a.y
  const lengthSquared = dx * dx + dy * dy
  if (lengthSquared <= 1e-18) return a
  const t = Math.max(0, Math.min(1,
    ((cursor.x - a.x) * dx + (cursor.y - a.y) * dy) / lengthSquared))
  return { x: a.x + t * dx, y: a.y + t * dy }
}

function entityFor(entities: readonly SketchEntity[], id: string): SketchEntity | undefined {
  return entities.find((entity) => entity.id === id)
}

function initialPlacementReference(
  entities: readonly SketchEntity[], plan: PlannedDimension, cursor: Vec2,
): { point: Vec2; span: number } {
  if (plan.kind === 'distance' || plan.kind === 'distanceX' || plan.kind === 'distanceY') {
    const a = resolvePoint(entities, plan.a)
    const b = resolvePoint(entities, plan.b)
    if (a && b) {
      const sameLine = plan.a.entityId === plan.b.entityId
        ? entityFor(entities, plan.a.entityId)
        : undefined
      return {
        point: sameLine?.kind === 'line'
          ? nearestOnSegment(cursor, sameLine.start, sameLine.end)
          : nearestOf([a, b], cursor),
        span: dist(a, b),
      }
    }
  }
  if (plan.kind === 'distancePL') {
    const point = resolvePoint(entities, plan.point)
    const line = entityFor(entities, plan.line)
    if (point && line?.kind === 'line') {
      const foot = nearestOnSegment(point, line.start, line.end)
      return {
        point: nearestOf([point, foot], cursor),
        span: Math.max(dist(line.start, line.end), dist(point, foot)),
      }
    }
  }
  // WO-1868: a three-point angle is measured AT its vertex, spanning its legs.
  if (plan.kind === 'angle3') {
    const v = resolvePoint(entities, plan.vertex)
    const pa = resolvePoint(entities, plan.a)
    const pb = resolvePoint(entities, plan.b)
    if (v && pa && pb) return { point: v, span: Math.max(dist(v, pa), dist(v, pb)) }
  }
  if (plan.kind === 'angle') {
    const a = entityFor(entities, plan.a)
    const b = entityFor(entities, plan.b)
    const sa = a ? angleOperandSegment(a) : null
    const sb = b ? angleOperandSegment(b) : null
    if (sa && sb) {
      const intersection = lineLineIntersection(sa, sb)
      if (intersection) {
        return {
          point: intersection,
          span: Math.max(dist(sa.start, sa.end), dist(sb.start, sb.end)),
        }
      }
    }
  }
  if (plan.kind === 'radius' || plan.kind === 'diameter' || plan.kind === 'arcLength') {
    const entity = entityFor(entities, plan.entityId)
    if (entity?.kind === 'circle') {
      const radialDistance = dist(entity.center, cursor)
      const radial = radialDistance > 1e-12
        ? {
            x: entity.center.x + entity.radius * (cursor.x - entity.center.x) / radialDistance,
            y: entity.center.y + entity.radius * (cursor.y - entity.center.y) / radialDistance,
          }
        : { x: entity.center.x + entity.radius, y: entity.center.y }
      return { point: radial, span: 2 * Math.abs(entity.radius) }
    }
    if (entity?.kind === 'arc') {
      const samples = arcSamplePoints(entity, DIM_GUIDE_ARC_DENSITY)
      return { point: nearestOf(samples, cursor), span: 2 * Math.abs(entity.radius) }
    }
  }
  if (
    plan.kind === 'majorRadius' ||
    plan.kind === 'minorRadius' ||
    plan.kind === 'focusDistance'
  ) {
    const entity = entityFor(entities, plan.entityId)
    if (entity?.kind === 'ellipse' || entity?.kind === 'elliptical-arc') {
      return {
        point: nearestPointOnEllipse(entity, cursor).point,
        span: 2 * Math.abs(entity.majorRadius),
      }
    }
  }
  if (plan.kind === 'd1xd2') {
    const entity = entityFor(entities, plan.entityId)
    if (entity?.kind === 'line') {
      return {
        point: nearestOnSegment(cursor, entity.start, entity.end),
        span: dist(entity.start, entity.end),
      }
    }
  }
  return { point: cursor, span: 0 }
}

// ---- WO-1867: the ordinate stack's common witness line ---------------------
//
// An ordinate stack reads the way a drawing's does only when every label in it
// sits on ONE line. That line is derived from the stack's DATUM ALONE -- X
// ordinates share the horizontal line ORDINATE_STACK_OFFSET_MM below the
// datum, Y ordinates share the vertical line the same distance to its left --
// so two ordinates from the same datum are co-linear BY CONSTRUCTION. No
// sibling lookup, no ordering dependence, and no drift when one of them is
// later deleted or its label dragged.
//
// The offset is measured from the DATUM rather than from the measured point on
// purpose: an offset chosen per point would put every label on its own line,
// which is the un-stacked fan this dimension kind exists to replace. A label
// can still be dragged anywhere afterwards -- this is only the drop position.
export const ORDINATE_STACK_OFFSET_MM = 10

/** Default label anchor for one ordinate: on the stack's common witness line,
 *  abreast of the measured point. */
export function ordinateStackAnchor(
  origin: Vec2, point: Vec2, axis: 'x' | 'y',
): Vec2 {
  return axis === 'x'
    ? { x: point.x, y: origin.y - ORDINATE_STACK_OFFSET_MM }
    : { x: origin.x - ORDINATE_STACK_OFFSET_MM, y: point.y }
}

/** Clamp only the first drop relative to the selected finite geometry. */
export function clampInitialDimPlacementAnchor(
  entities: readonly SketchEntity[], plan: PlannedDimension, cursor: Vec2,
): Vec2 {
  // WO-1867: an ORDINATE's drop position is not a free cursor placement at
  // all -- it is the stack's common witness line (ordinateStackAnchor). Pulling
  // it toward the geometry by the generic "sane offset" clamp would put each
  // label on its own line and destroy the stack, so the ordinate anchor passes
  // through as given.
  if (plan.kind === 'ordinate') return { x: cursor.x, y: cursor.y }
  const reference = initialPlacementReference(entities, plan, cursor)
  const offset = dist(reference.point, cursor)
  const limit = initialDimPlacementOffsetLimit(reference.span)
  if (!Number.isFinite(offset) || offset <= limit || offset <= 1e-12) {
    return { x: cursor.x, y: cursor.y }
  }
  const scale = limit / offset
  return {
    x: reference.point.x + (cursor.x - reference.point.x) * scale,
    y: reference.point.y + (cursor.y - reference.point.y) * scale,
  }
}

// How much to FAVOUR 'aligned' over the world-axis candidates when the feature
// is diagonal. The aligned cone is not an even three-way split: aligned wins as
// long as its angular distance to the drag is within (nearest world-axis
// distance + ALIGN_BIAS_RAD). This widens aligned's capture region so the
// natural perpendicular side-pull snaps to aligned easily, while a drag that is
// CLEARLY up/down or left/right (world-axis distance smaller than aligned's by
// more than the bias) still gives H/V. Tune here (~15-20 deg feels right).
export const ALIGN_BIAS_RAD = (18 * Math.PI) / 180

/** Default world tick for pure geometry callers without a camera.
 *  Both preview and committed painters rebuild guides in screen units;
 *  placement values and anchors do not depend on this cosmetic fallback. */
const DEFAULT_TICK_MM = 1.5

// ---- Arrowheads (mainstream-CAD dimension terminators) ---------------------
//
// Every dimension LINE now terminates in a small chevron arrowhead instead of
// a 45-deg witness tick (radius/diameter were bare lines with no terminator at
// all). An arrowhead is emitted as ONE 3-point polyline [barb, tip, barb]: the
// LineSegments flattener in sketchLayer draws it as the two barb strokes, and
// dimensionHitDistance walks the same two segments -- so preview, commit and
// hit-test share one construction. Sizes are expressed as multiples of the
// caller's `tick` unit (screen-px in both painters) so
// arrowheads stay a consistent on-screen size at any zoom.
const ARROW_ANGLE_RAD = (20 * Math.PI) / 180 // barb half-angle off the shaft
const ARROW_LEN_MULT = 2.6                    // arrowhead length = tick * this
const WITNESS_OVERSHOOT_MULT = 1.2            // witness extends past the dim line

/**
 * Chevron arrowhead as ONE polyline [barb1, tip, barb2]. `tip` is the point the
 * arrow touches (the arc surface, the ellipse vertex, or a dimension-line end);
 * `dir` is the direction the arrow POINTS (shaft -> tip). The two barbs sweep
 * back from the tip at +/- ARROW_ANGLE_RAD. Pure geometry -- rendered as two
 * strokes (barb1->tip, tip->barb2) by the segment flattener, so it reads as a
 * clean open arrowhead consistent with the line-based dimension render.
 */
export function arrowHead(tip: Vec2, dir: Vec2, len: number): Vec2[] {
  const dl = Math.hypot(dir.x, dir.y) || 1
  const ux = dir.x / dl, uy = dir.y / dl
  const ca = Math.cos(ARROW_ANGLE_RAD), sa = Math.sin(ARROW_ANGLE_RAD)
  // Barbs point BACK along the shaft (opposite the travel dir), splayed +/-.
  const bx = -ux, by = -uy
  const b1x = bx * ca - by * sa, b1y = bx * sa + by * ca
  const b2x = bx * ca + by * sa, b2y = -bx * sa + by * ca
  return [
    { x: tip.x + b1x * len, y: tip.y + b1y * len },
    { x: tip.x, y: tip.y },
    { x: tip.x + b2x * len, y: tip.y + b2y * len },
  ]
}

export type DimOrientation = 'aligned' | 'x' | 'y'

/** Undirected angular distance between two direction angles, folded to
 *  [0, pi/2] (a direction and its 180-deg reverse are the same axis). */
function axisDelta(a: number, b: number): number {
  let d = Math.abs(a - b) % Math.PI
  if (d > Math.PI / 2) d = Math.PI - d
  return d
}

/**
 * Orientation auto-pick for a two-point (or single-line) linear dimension,
 * chosen by the DRAG DIRECTION and the natural pull-away gesture: you pull the
 * label to the SIDE of a diagonal feature to
 * get an aligned dimension, NOT along it). Decide by which of three candidate
 * offset-axes the drag offset is closest to, as UNDIRECTED axes:
 *   - the feature NORMAL (a perpendicular SIDE pull)  -> 'aligned'
 *     (measures the true point-to-point distance)
 *   - the world Y axis (label dragged above/below)    -> 'x' (distanceX,
 *     a horizontal dimension line)
 *   - the world X axis (label dragged left/right)     -> 'y' (distanceY,
 *     a vertical dimension line)
 * When the segment itself is within AXIS_ALIGNED_BAND_RAD of a world axis the
 * 'aligned' candidate is DROPPED (redundant/meaningless -- a horizontal line
 * should give a horizontal dimension, not "aligned"), leaving only H/V.
 * With no drag yet (cursor on the segment) default to 'aligned' for a
 * diagonal, or the measuring axis for a near-axis segment.
 *
 * (This inverts the old rule, which returned 'aligned' only for a drag ALONG
 * the segment -- but the aligned label is placed by pulling PERPENDICULAR to
 * the feature, so 'aligned' was effectively unreachable from the gesture.)
 *
 * SKC-74 (Operator, from the road): the drag offset used to be measured from the
 * segment's fixed geometric MIDPOINT (`cursor - mid`). For a cursor that is
 * NOT near mid-height/mid-width -- e.g. picked near the TOP of a tall
 * vertical edge and dragged sideways at that same height -- the midpoint
 * reference baked in a large spurious ALONG-the-line component (the height
 * difference between the cursor and the segment's center) that a purely
 * sideways drag then had to overpower before the near-axis H/V pick would
 * flip, requiring a "comically far" sideways drag exactly proportional to
 * how far from mid-height/mid-width the cursor happened to be.
 *
 * Fixed for the NEAR-AXIS case (the reported scenario -- 'aligned' is not
 * even a candidate there) by measuring the offset from the cursor's OWN
 * perpendicular foot on the segment, clamped to the segment's own span
 * [0, len] (`nearAxisRef` below), instead of the fixed midpoint. Anywhere
 * BESIDE the segment -- the foot lands between its two ends, at any
 * height/position along it -- therefore measures a PURELY perpendicular
 * offset, so a sideways drag resolves the H/V pick immediately regardless of
 * where along the feature the cursor sits. Only a cursor genuinely PAST an
 * end (foot outside [0, len]) still carries a real along-the-line component
 * -- the deliberate "drag off the end" gesture the near-axis rule
 * intentionally treats as measuring the OTHER orientation (unchanged; see
 * the "near-axis segment DROPS aligned" test).
 *
 * The DIAGONAL (non-near-axis) path keeps the original fixed-midpoint
 * reference: there 'aligned' IS a candidate, decided by comparing the drag
 * direction to the feature's own NORMAL (see `dN` below) -- an offset
 * measured from the cursor's own foot is by construction always exactly
 * co-linear with that normal, which would make 'aligned' win unconditionally
 * for any beside-the-segment cursor and erase the deliberate, tested
 * "vertical/horizontal pull off a diagonal still gives H/V, not aligned"
 * behavior. Only the near-axis branch (where 'aligned' is unreachable
 * anyway) gets the position-independent fix.
 */
export function pickDimOrientation(pa: Vec2, pb: Vec2, cursor: Vec2): DimOrientation {
  const dx = pb.x - pa.x, dy = pb.y - pa.y
  const segAng = Math.atan2(dy, dx)
  // Is the segment (nearly) parallel to a world axis? Fold its own direction
  // to the angle-from-horizontal in [0, pi/2]: near 0 = horizontal, near
  // pi/2 = vertical. Either way 'aligned' is meaningless there.
  const segFromH = axisDelta(segAng, 0)
  const nearAxis =
    segFromH <= AXIS_ALIGNED_BAND_RAD ||
    segFromH >= Math.PI / 2 - AXIS_ALIGNED_BAND_RAD

  const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2 }
  let refX = mid.x, refY = mid.y
  if (nearAxis) {
    const len2 = dx * dx + dy * dy
    const t = len2 > 1e-18 ? ((cursor.x - pa.x) * dx + (cursor.y - pa.y) * dy) / len2 : 0
    const tc = Math.max(0, Math.min(1, t))
    refX = pa.x + dx * tc
    refY = pa.y + dy * tc
  }
  const offx = cursor.x - refX
  const offy = cursor.y - refY

  // No drag yet: default sensibly. Diagonal -> aligned; near-axis -> the
  // dimension that actually measures the feature (horizontal line -> 'x'
  // measuring its length; vertical line -> 'y').
  if (Math.hypot(offx, offy) < 1e-9) {
    if (!nearAxis) return 'aligned'
    return segFromH <= Math.PI / 4 ? 'x' : 'y'
  }

  const offAng = Math.atan2(offy, offx)
  // Distance from the drag direction to each candidate offset-axis. The
  // world-axis candidates are always in play; 'aligned' only when the feature
  // is genuinely diagonal.
  const dY = axisDelta(offAng, Math.PI / 2) // world Y axis -> 'x' (distanceX)
  const dX = axisDelta(offAng, 0)           // world X axis -> 'y' (distanceY)
  const worldBest: DimOrientation = dY <= dX ? 'x' : 'y'
  const worldDelta = Math.min(dY, dX)
  if (!nearAxis) {
    // Bias aligned so its capture cone is WIDER than an even three-way split:
    // aligned wins unless the drag is CLEARLY toward a world axis (its distance
    // beats aligned's by more than ALIGN_BIAS_RAD). H/V still win on a
    // decisive up/down or left/right pull.
    const dN = axisDelta(offAng, segAng + Math.PI / 2) // feature normal
    if (dN <= worldDelta + ALIGN_BIAS_RAD) return 'aligned'
  }
  return worldBest
}

export interface DimPlacementResult {
  /** Final dimension kind after orientation auto-pick. */
  kind: SketchDimensionKind
  /** Operand refs + value, ready for the commit ({...plan} -> dimension).
   *  plan.value === value. */
  plan: PlannedDimension
  /** Measured value (mm; radians for angle). distanceX/distanceY are
   *  normalized positive (operands ordered so b - a >= 0). */
  value: number
  /** The placement point: the live cursor (preview) and the click point
   *  (commit) are the same, so the dropped label sits where the preview
   *  showed it. */
  labelAnchor: Vec2
  /** Witness/leader polylines (world mm) for the dimGuides overlay,
   *  mirroring the committed leader so the preview matches the result. */
  guides: Vec2[][]
}

/**
 * Resolve the dimension to preview/commit for an operand set with the
 * cursor at `cursor`. Returns null when the operand set cannot dimension
 * yet (incomplete) or at all (rejected) -- the caller shows the textual
 * hint (dimPreview) and no witness lines in that case.
 */
export function resolveDimPlacement(
  entities: readonly SketchEntity[],
  operandIds: readonly DimOperandRef[],
  cursor: Vec2,
  opts: {
    tickWorld?: number
    forceOrientation?: DimForceMode | null
    /** Actual first-drop preview/commit path. Low-level guide callers may
     *  omit this when deliberately exercising an arbitrary anchor. */
    clampInitial?: boolean
  } = {},
  /** EXTENSION (optional, defaults to none): needed only to recognize a lone
   *  CHAMFER LINE operand (UI-50C d1xd2); every other operand set ignores it. */
  constraints: readonly SketchConstraint[] = [],
): DimPlacementResult | null {
  const out = planDimension(entities, operandIds, constraints)
  if (!out.ok) return null
  const base = out.plan
  const tick = opts.tickWorld ?? DEFAULT_TICK_MM

  // Only the point-to-point 'distance' plan (two points, or a single
  // line's own endpoints) carries an orientation choice. Everything else
  // is already disambiguated by planDimension. The Tab-forced orientation
  // (opts.forceOrientation) OVERRIDES the drag-vector auto-snap when set;
  // null/undefined falls back to pickDimOrientation. (distancePL keeps its
  // perpendicular orientation regardless -- see the distancePL guide.)
  // WO-1867: the ordinate modes are NOT an orientation of a two-operand pick
  // (they change what the next click means, and dimToolClick owns that path),
  // so they never reach the orientation auto-snap. Narrow them away by name
  // rather than letting an unrecognized mode fall through the `??` below and
  // silently resolve to 'aligned'.
  const forceOrientation: DimForceMode | null =
    ordinateForceAxis(opts.forceOrientation) ? null : (opts.forceOrientation ?? null)
  let plan: PlannedDimension = base
  if (base.kind === 'distance') {
    const pa = resolvePoint(entities, base.a)
    const pb = resolvePoint(entities, base.b)
    if (pa && pb) {
      if (forceOrientation === 'arcLength') return null
      const orient = forceOrientation ?? pickDimOrientation(pa, pb, cursor)
      if (orient === 'x') {
        // Order so value = b.x - a.x >= 0 (the 'difference' mapping wants
        // a signed value; the UI normalizes it positive).
        const [a, b, v] = pb.x >= pa.x
          ? [base.a, base.b, pb.x - pa.x]
          : [base.b, base.a, pa.x - pb.x]
        plan = { kind: 'distanceX', a, b, value: v }
      } else if (orient === 'y') {
        const [a, b, v] = pb.y >= pa.y
          ? [base.a, base.b, pb.y - pa.y]
          : [base.b, base.a, pa.y - pb.y]
        plan = { kind: 'distanceY', a, b, value: v }
      }
      // 'aligned' keeps the base distance plan untouched.
    }
  } else if (base.kind === 'radius' && forceOrientation === 'arcLength') {
    const e = entities.find((candidate) => candidate.id === base.entityId)
    if (!e || e.kind !== 'arc') return null
    plan = {
      kind: 'arcLength',
      entityId: e.id,
      value: e.radius * positiveArcSweep(e.startAngle, e.endAngle),
    }
  } else if (forceOrientation === 'arcLength') {
    // Unreachable from the tool machine for every non-Arc entity. Keep the
    // direct resolver boundary defensive too: no Circle/ellipse/point can be
    // coerced into an arc-length dimension by a caller-supplied mode.
    return null
  } else if (base.kind === 'angle') {
    // SKC-56: the anchor's SECTOR (which of the 4 regions the two lines'
    // intersection divides the plane into) picks the signed value fed to
    // the solver -- same helper dimGuides below uses, so the committed
    // value always matches the arc the preview showed at the click point.
    const ea = entities.find((e) => e.id === base.a)
    const eb = entities.find((e) => e.id === base.b)
    const eitherBlock = ea?.kind === 'block' || eb?.kind === 'block'
    if (eitherBlock) {
      // SKC-ROTATION-SOLVABLE: a block orientation cannot use the far/obtuse
      // sector (the solver refuses reverseB on a block, gcsMapping). Always
      // commit the NEAR sector -- the raw directed angle -- so the value is a
      // no-motion constraint the geometry already satisfies at create time.
      const segA = ea ? angleOperandSegment(ea) : null
      const segB = eb ? angleOperandSegment(eb) : null
      if (segA && segB) {
        plan = { kind: 'angle', a: base.a, b: base.b, value: lineAngle(segA, segB), reverseB: false }
      }
    } else {
      const sector = selectAngleSector(entities, base, cursor)
      // SKC-58B: carry the sector's reversed-operand orientation onto the plan
      // so the committed AngleDimension (built by ...placement.plan) reverses
      // operand B in the solver for a far/obtuse pick -> no-motion commit.
      if (sector) plan = { kind: 'angle', a: base.a, b: base.b, value: sector.value, reverseB: sector.reverseB }
    }
  } else if (base.kind === 'angle3' && !base.ccw) {
    // WO-1868: the SAME sector pick the two-line angle makes, on the
    // vertex->leg segments -- a far click commits the obtuse reading with
    // reverseB and NO motion (SKC-58B). An arc's ccw plan has one reading.
    const sector = selectAngle3Sector(entities, base, cursor)
    if (sector) plan = { ...base, value: sector.value, reverseB: sector.reverseB }
  } else if (base.kind === 'majorRadius' || base.kind === 'minorRadius') {
    // ELLIPSE major-vs-minor pick: like distance -> distanceX/distanceY, the
    // single-ellipse plan is orientation-blind (majorRadius); the DRAG choses
    // the axis. Pull the label toward the major-axis vertex -> major radius,
    // toward the minor-axis vertex -> minor radius. Decide in the ellipse's OWN
    // axis frame (rotate the cursor offset by -rotation): |lx| >= |ly| = major.
    // (No Tab override here -- forceOrientation is a linear-family concept.)
    const e = entities.find((x) => x.id === base.entityId)
    if (e && (e.kind === 'ellipse' || e.kind === 'elliptical-arc')) {
      const dx = cursor.x - e.center.x, dy = cursor.y - e.center.y
      const cos = Math.cos(e.rotation), sin = Math.sin(e.rotation)
      const lx = dx * cos + dy * sin
      const ly = -dx * sin + dy * cos
      plan = Math.abs(lx) >= Math.abs(ly)
        ? { kind: 'majorRadius', entityId: e.id, value: e.majorRadius }
        : { kind: 'minorRadius', entityId: e.id, value: e.minorRadius }
    }
  }

  // Orientation, angle sector, and ellipse-axis intent above use the RAW
  // cursor. Only the initial displayed/stored label anchor is bounded.
  const anchor = opts.clampInitial
    ? clampInitialDimPlacementAnchor(entities, plan, cursor)
    : { x: cursor.x, y: cursor.y }

  return {
    kind: plan.kind,
    plan,
    value: plan.value,
    labelAnchor: anchor,
    guides: dimGuides(entities, plan, anchor, tick),
  }
}

// ---- Witness / leader graphics (mirror buildDimensionGraphics) -------------
//
// Each committed leader in sketchLayer.buildDimensionGraphics is built from
// line SEGMENTS; here the same construction is emitted as polylines (Vec2[])
// for the dimGuides overlay channel. The anchor used here is the live cursor
// (= the stored labelAnchor on commit), so preview and result coincide.

function seg(ax: number, ay: number, bx: number, by: number): Vec2[] {
  return [{ x: ax, y: ay }, { x: bx, y: by }]
}

/** Perpendicular foot of point p projected onto the INFINITE line through
 *  the segment (clamped to the line, NOT the segment — matches the p2l
 *  distance the dimension constrains). Shared by the point-to-line guide
 *  and the committed-render path so preview === commit. */
export function perpFootOnLine(
  p: Vec2, line: { start: Vec2; end: Vec2 },
): Vec2 {
  const dx = line.end.x - line.start.x, dy = line.end.y - line.start.y
  const len2 = dx * dx + dy * dy
  const t = len2 > 0
    ? ((p.x - line.start.x) * dx + (p.y - line.start.y) * dy) / len2 : 0
  return { x: line.start.x + t * dx, y: line.start.y + t * dy }
}

/**
 * Witness/extension lines + the offset dimension BAR for an ALIGNED linear
 * dimension between a and b, with the bar carried OUT to the side by the
 * drag anchor (projected onto the segment normal). The bar slides along the
 * a-b direction; its length stays the true a-b distance. This is the SINGLE
 * construction behind BOTH the two-point 'distance' guide AND the
 * point-to-line 'distancePL' guide, so a point+line / parallel-line distance
 * gets the same movable, witness-lined bar a two-point distance always had
 * (the reported "clamped bar you cannot carry outside" fix). sketchLayer
 * mirrors this exact math for the committed render.
 */
export function placeLinearDim(
  a: Vec2, b: Vec2, anchor: Vec2, tick: number,
): Vec2[][] {
  const out: Vec2[][] = []
  const len = dist(a, b) || 1
  const dir = { x: (b.x - a.x) / len, y: (b.y - a.y) / len }
  const n = { x: -dir.y, y: dir.x }
  const off = (anchor.x - a.x) * n.x + (anchor.y - a.y) * n.y
  const a2 = { x: a.x + n.x * off, y: a.y + n.y * off }
  const b2 = { x: b.x + n.x * off, y: b.y + n.y * off }
  // Witness/extension lines run from the measured points to the dim line and
  // OVERSHOOT slightly past it (mainstream CAD convention). The witness starts
  // AT the geometry (no gap) so a click near the feature still hits the dim.
  const os = off >= 0 ? WITNESS_OVERSHOOT_MULT * tick : -WITNESS_OVERSHOOT_MULT * tick
  out.push(seg(a.x, a.y, a2.x + n.x * os, a2.y + n.y * os))
  out.push(seg(b.x, b.y, b2.x + n.x * os, b2.y + n.y * os))
  // The dimension line (bar) stays at index 2 (relied on by callers/tests).
  out.push(seg(a2.x, a2.y, b2.x, b2.y))
  // Arrowheads at both ends, pointing OUTWARD along the bar toward the witness
  // lines: the a-end arrow points -dir, the b-end arrow points +dir.
  const alen = ARROW_LEN_MULT * tick
  out.push(arrowHead(a2, { x: -dir.x, y: -dir.y }, alen))
  out.push(arrowHead(b2, dir, alen))
  return out
}

/** Radial-leader attachment for a circle/arc dimension. `arcPt` is where the
 *  ray center -> anchor pierces the arc; `radialDir` is the unit outward
 *  radial along that ray; `leaderDir` is the unit direction from arcPt TOWARD
 *  the label. Degenerate anchors are absorbed here so callers never see NaN:
 *  an anchor AT the center falls back to the 45-deg ray (the same ray the
 *  default label placement uses); an anchor exactly ON the arc keeps the
 *  outward radial as the leader axis so the arrowhead still has a direction;
 *  an anchor INSIDE the circle simply yields an inward-pointing leaderDir
 *  (the leader still runs arc -> label). Zero radius collapses arcPt onto
 *  the center, which stays finite. */
function radialLeader(
  center: Vec2, radius: number, anchor: Vec2,
): { arcPt: Vec2; radialDir: Vec2; leaderDir: Vec2 } {
  const dx = anchor.x - center.x, dy = anchor.y - center.y
  const len = Math.hypot(dx, dy)
  const radialDir = len > 1e-9
    ? { x: dx / len, y: dy / len }
    : { x: Math.SQRT1_2, y: Math.SQRT1_2 } // PI/4 fallback = default-label ray
  const arcPt = {
    x: center.x + radialDir.x * radius,
    y: center.y + radialDir.y * radius,
  }
  const lx = anchor.x - arcPt.x, ly = anchor.y - arcPt.y
  const ll = Math.hypot(lx, ly)
  const leaderDir = ll > 1e-9
    ? { x: lx / ll, y: ly / ll }
    : { x: radialDir.x, y: radialDir.y } // anchor ON the arc: radial axis
  return { arcPt, radialDir, leaderDir }
}

export function dimGuides(
  entities: readonly SketchEntity[],
  plan: PlannedDimension,
  anchor: Vec2,
  tick: number,
): Vec2[][] {
  const ent = (id: string) => entities.find((e) => e.id === id)
  const out: Vec2[][] = []

  switch (plan.kind) {
    case 'distance': {
      const a = resolvePoint(entities, plan.a)
      const b = resolvePoint(entities, plan.b)
      if (!a || !b) break
      for (const s of placeLinearDim(a, b, anchor, tick)) out.push(s)
      break
    }
    case 'distanceX': {
      const a = resolvePoint(entities, plan.a)
      const b = resolvePoint(entities, plan.b)
      if (!a || !b) break
      const y0 = anchor.y
      // Vertical witness lines (overshoot past the horizontal dim line).
      const ovA = (y0 >= a.y ? 1 : -1) * WITNESS_OVERSHOOT_MULT * tick
      const ovB = (y0 >= b.y ? 1 : -1) * WITNESS_OVERSHOOT_MULT * tick
      out.push(seg(a.x, a.y, a.x, y0 + ovA))
      out.push(seg(b.x, b.y, b.x, y0 + ovB))
      out.push(seg(a.x, y0, b.x, y0))
      // Arrowheads at the bar ends, pointing outward along the (horizontal) bar.
      const bd = b.x >= a.x ? 1 : -1
      const al = ARROW_LEN_MULT * tick
      out.push(arrowHead({ x: a.x, y: y0 }, { x: -bd, y: 0 }, al))
      out.push(arrowHead({ x: b.x, y: y0 }, { x: bd, y: 0 }, al))
      break
    }
    case 'distanceY': {
      const a = resolvePoint(entities, plan.a)
      const b = resolvePoint(entities, plan.b)
      if (!a || !b) break
      const x0 = anchor.x
      // Horizontal witness lines (overshoot past the vertical dim line).
      const ovA = (x0 >= a.x ? 1 : -1) * WITNESS_OVERSHOOT_MULT * tick
      const ovB = (x0 >= b.x ? 1 : -1) * WITNESS_OVERSHOOT_MULT * tick
      out.push(seg(a.x, a.y, x0 + ovA, a.y))
      out.push(seg(b.x, b.y, x0 + ovB, b.y))
      out.push(seg(x0, a.y, x0, b.y))
      // Arrowheads at the bar ends, pointing outward along the (vertical) bar.
      const bd = b.y >= a.y ? 1 : -1
      const al = ARROW_LEN_MULT * tick
      out.push(arrowHead({ x: x0, y: a.y }, { x: 0, y: -bd }, al))
      out.push(arrowHead({ x: x0, y: b.y }, { x: 0, y: bd }, al))
      break
    }
    // ORDINATE (WO-1867): the SAME witness-lines-plus-offset-bar construction
    // distanceX/distanceY draw, between the stack's DATUM and the measured
    // point, with the bar sitting on the stack's common witness line (the
    // anchor). Because every ordinate of a stack shares that line and the datum
    // end, their bars nest from one datum witness -- which is exactly what an
    // ordinate stack looks like on a drawing. Sharing the construction is also
    // what keeps the hit target, the preview and the committed render identical.
    case 'ordinate': {
      const o = resolvePoint(entities, plan.origin)
      const p = resolvePoint(entities, plan.point)
      if (!o || !p) break
      const al = ARROW_LEN_MULT * tick
      if (plan.axis === 'x') {
        const y0 = anchor.y
        const ovO = (y0 >= o.y ? 1 : -1) * WITNESS_OVERSHOOT_MULT * tick
        const ovP = (y0 >= p.y ? 1 : -1) * WITNESS_OVERSHOOT_MULT * tick
        out.push(seg(o.x, o.y, o.x, y0 + ovO))
        out.push(seg(p.x, p.y, p.x, y0 + ovP))
        out.push(seg(o.x, y0, p.x, y0))
        const bd = p.x >= o.x ? 1 : -1
        out.push(arrowHead({ x: o.x, y: y0 }, { x: -bd, y: 0 }, al))
        out.push(arrowHead({ x: p.x, y: y0 }, { x: bd, y: 0 }, al))
      } else {
        const x0 = anchor.x
        const ovO = (x0 >= o.x ? 1 : -1) * WITNESS_OVERSHOOT_MULT * tick
        const ovP = (x0 >= p.x ? 1 : -1) * WITNESS_OVERSHOOT_MULT * tick
        out.push(seg(o.x, o.y, x0 + ovO, o.y))
        out.push(seg(p.x, p.y, x0 + ovP, p.y))
        out.push(seg(x0, o.y, x0, p.y))
        const bd = p.y >= o.y ? 1 : -1
        out.push(arrowHead({ x: x0, y: o.y }, { x: 0, y: -bd }, al))
        out.push(arrowHead({ x: x0, y: p.y }, { x: 0, y: bd }, al))
      }
      break
    }
    case 'distancePL': {
      // Point-to-line (and parallel two-lines) distance now draws the SAME
      // movable offset bar as a two-point distance: treat the measured pair
      // as (the point, its perpendicular foot on the line) and slide the bar
      // along the line via the drag anchor. The bar's length stays the true
      // perpendicular distance; it carries OUTSIDE the features with witness
      // lines (the reported fix -- it used to clamp a fixed perpendicular).
      const p = resolvePoint(entities, plan.point)
      const l = ent(plan.line)
      if (!p || !l || l.kind !== 'line') break
      const pointOwner = ent(plan.point.entityId)
      const pointOwnerIsAxis = pointOwner?.kind === 'line' &&
        (pointOwner.id === SKETCH_AXIS_X_ENTITY_ID ||
          pointOwner.id === SKETCH_AXIS_Y_ENTITY_ID) &&
        linesParallel(pointOwner, l)
      if (pointOwnerIsAxis && pointOwner.kind === 'line') {
        // Compatibility for dimensions saved before axis operands were
        // normalized in planDimension. Their solver point may be the axis's
        // +/-100,000 mm endpoint. A line-to-line distance has no meaningful
        // endpoint, so draw its local perpendicular pair through the label
        // anchor instead of exposing that finite implementation detail.
        const featurePoint = perpFootOnLine(anchor, l)
        const axisPoint = perpFootOnLine(featurePoint, pointOwner)
        for (const s of placeLinearDim(axisPoint, featurePoint, anchor, tick)) out.push(s)
      } else {
        const foot = perpFootOnLine(p, l)
        for (const s of placeLinearDim(p, foot, anchor, tick)) out.push(s)
      }
      break
    }
    case 'radius': {
      // radial leader: a SHORT straight segment from the ARC to
      // the label, arrowhead AT the arc end pointing at the arc (away from the
      // label), and NOTHING drawn from the center. (The previous construction
      // -- one collinear center -> label segment -- was rejected: the label
      // sat far from the arc on a long diagonal with the text floating off
      // the line end.) The leader runs the FULL span into the label anchor
      // (the chip center): the label chip's near-opaque background hides the
      // overlap, so the line reads as running INTO the box. (A tick-scaled
      // stop-short gap was rejected -- the leader looked detached from the
      // value.)
      const e = ent(plan.entityId)
      if (!e || (e.kind !== 'circle' && e.kind !== 'arc')) break
      const { arcPt, leaderDir } = radialLeader(e.center, e.radius, anchor)
      const span = Math.hypot(anchor.x - arcPt.x, anchor.y - arcPt.y)
      if (span > 1e-9) {
        out.push(seg(arcPt.x, arcPt.y, anchor.x, anchor.y))
      }
      // Arrow tip touches the arc, pointing from the label's side INTO the
      // arc (-leaderDir): inward when the label is outside the circle,
      // outward when the label was dragged inside.
      out.push(arrowHead(arcPt, { x: -leaderDir.x, y: -leaderDir.y },
        ARROW_LEN_MULT * tick))
      break
    }
    case 'diameter': {
      // diameter leader, label-near like the radius case. Label
      // OUTSIDE the circle: a leader from the NEAR rim (the rim point on the
      // label's side) running the FULL span into the label anchor, one
      // arrowhead at that rim pointing into the circle -- no line ever
      // crosses the shape and no full through-line runs out to the label
      // (the rejected construction).
      // Label INSIDE the circle: the classic inside-placed diameter -- ONE
      // unbroken rim-to-rim line through the center along the label's ray
      // (the near-opaque label chip sits on top and hides the crossing; the
      // old split-around-the-label read detached), arrowheads at BOTH rims
      // pointing outward.
      const e = ent(plan.entityId)
      if (!e || (e.kind !== 'circle' && e.kind !== 'arc')) break
      const { arcPt, radialDir, leaderDir } = radialLeader(e.center, e.radius, anchor)
      const alen = ARROW_LEN_MULT * tick
      const len = Math.hypot(anchor.x - e.center.x, anchor.y - e.center.y)
      if (len > e.radius) {
        // Label OUTSIDE: same full-span leader as the radius case; arcPt IS
        // the near rim (ray center -> anchor pierces the arc on the label
        // side).
        const span = Math.hypot(anchor.x - arcPt.x, anchor.y - arcPt.y)
        if (span > 1e-9) {
          out.push(seg(arcPt.x, arcPt.y, anchor.x, anchor.y))
        }
        out.push(arrowHead(arcPt, { x: -leaderDir.x, y: -leaderDir.y }, alen))
      } else {
        // Label INSIDE (or on the rim): one full rim-to-rim through-line.
        const r = e.radius
        const at = (t: number): Vec2 => ({
          x: e.center.x + radialDir.x * t, y: e.center.y + radialDir.y * t,
        })
        const nearRim = at(-r), farRim = at(r)
        out.push(seg(nearRim.x, nearRim.y, farRim.x, farRim.y))
        out.push(arrowHead(nearRim, { x: -radialDir.x, y: -radialDir.y }, alen))
        out.push(arrowHead(farRim, radialDir, alen))
      }
      break
    }
    case 'arcLength': {
      // Draw the measured curve itself, with tangent arrowheads at both arc
      // endpoints and a short leader from the curve midpoint to the label.
      // The sampled sweep uses the same positive seam normalization as the
      // measured value and solver constraint.
      const e = ent(plan.entityId)
      if (!e || e.kind !== 'arc') break
      const sweep = positiveArcSweep(e.startAngle, e.endAngle)
      const end = e.startAngle + sweep
      out.push(arcSamplePoints(
        { center: e.center, radius: e.radius, startAngle: e.startAngle, endAngle: end },
        DIM_GUIDE_ARC_DENSITY,
      ))
      const startPt = {
        x: e.center.x + e.radius * Math.cos(e.startAngle),
        y: e.center.y + e.radius * Math.sin(e.startAngle),
      }
      const endPt = {
        x: e.center.x + e.radius * Math.cos(end),
        y: e.center.y + e.radius * Math.sin(end),
      }
      const startTangent = { x: -Math.sin(e.startAngle), y: Math.cos(e.startAngle) }
      const endTangent = { x: -Math.sin(end), y: Math.cos(end) }
      const alen = ARROW_LEN_MULT * tick
      out.push(arrowHead(startPt, { x: -startTangent.x, y: -startTangent.y }, alen))
      out.push(arrowHead(endPt, endTangent, alen))
      const mid = e.startAngle + sweep / 2
      const midPt = {
        x: e.center.x + e.radius * Math.cos(mid),
        y: e.center.y + e.radius * Math.sin(mid),
      }
      out.push(seg(midPt.x, midPt.y, anchor.x, anchor.y))
      break
    }
    case 'majorRadius':
    case 'minorRadius': {
      // Clean leader ALONG the chosen axis (respecting the ellipse rotation):
      // center -> the on-axis label point (the raw anchor projected onto the
      // axis line, so the leader can never sit at an odd off-axis angle). A
      // short witness tick marks the axis vertex where the leader meets the
      // outline. SAME helper the committed render uses -> preview === commit.
      const e = ent(plan.entityId)
      if (!e || (e.kind !== 'ellipse' && e.kind !== 'elliptical-arc')) break
      const axis = plan.kind === 'majorRadius' ? 'major' : 'minor'
      const { dir, vertex, label } = ellipseAxisDimLeader(e, axis, anchor)
      out.push(seg(e.center.x, e.center.y, label.x, label.y))
      // Arrowhead at the axis vertex pointing outward along the axis (replaces
      // the old perpendicular witness tick, for consistency with radius/diam).
      // The chevron TIP is the vertex -> guides[1][1] is the vertex point.
      out.push(arrowHead(vertex, dir, ARROW_LEN_MULT * tick))
      break
    }
    case 'focusDistance': {
      // Leader BETWEEN the two foci: the SAME movable, witness-lined offset bar
      // a two-point aligned distance uses (placeLinearDim), so the 2c dimension
      // reads like a length measured across the foci and can be carried out to
      // the side by the drag anchor. Foci derive from center + inert shape.
      const e = ent(plan.entityId)
      if (!e || (e.kind !== 'ellipse' && e.kind !== 'elliptical-arc')) break
      const f1 = ellipseFocusSite(e, 'focus1')
      const f2 = ellipseFocusSite(e, 'focus2')
      for (const s of placeLinearDim(f1, f2, anchor, tick)) out.push(s)
      break
    }
    case 'd1xd2': {
      // REFERENCE-ONLY chamfer setback pair (UI-50C): TWO short leaders, one
      // per measured endpoint (the chamfer line's OWN start = d1, end = d2 --
      // same convention measureChamferSetbacks uses), converging on the ONE
      // shared label (mirrors the angle dimension's two-ray-to-vertex style).
      // Only the chamfer line's own geometry is needed here -- the
      // theoretical corner itself is not drawn (it is construction geometry
      // already rendered by the sketch layer's own entity pass).
      const e = ent(plan.entityId)
      if (!e || e.kind !== 'line') break
      const alen = ARROW_LEN_MULT * tick
      for (const pt of [e.start, e.end]) {
        const span = Math.hypot(anchor.x - pt.x, anchor.y - pt.y)
        if (span < 1e-9) continue
        const dir = { x: (anchor.x - pt.x) / span, y: (anchor.y - pt.y) / span }
        out.push(seg(pt.x, pt.y, anchor.x, anchor.y))
        out.push(arrowHead(pt, { x: -dir.x, y: -dir.y }, alen))
      }
      break
    }
    case 'angle3': {
      // WO-1868: the two-line guide, on the vertex->leg segments. An arc's ccw
      // reading draws its own CCW sweep from leg A around to leg B.
      const v = resolvePoint(entities, plan.vertex)
      const pa = resolvePoint(entities, plan.a)
      const pb = resolvePoint(entities, plan.b)
      if (!v || !pa || !pb) break
      const rr = Math.max(Math.hypot(anchor.x - v.x, anchor.y - v.y), 1e-3)
      let ta: number, tb: number
      if (plan.ccw) {
        ta = Math.atan2(pa.y - v.y, pa.x - v.x)
        tb = Math.atan2(pb.y - v.y, pb.x - v.x)
        while (tb <= ta) tb += 2 * Math.PI
      } else {
        const sector = selectAngle3Sector(entities, plan, anchor)
        if (!sector || !sector.inter) break
        ta = sector.startAngle
        tb = sector.endAngle
      }
      out.push(arcSamplePoints({ center: v, radius: rr, startAngle: ta, endAngle: tb }, DIM_GUIDE_ARC_DENSITY))
      out.push(seg(v.x, v.y, v.x + rr * Math.cos(ta), v.y + rr * Math.sin(ta)))
      out.push(seg(v.x, v.y, v.x + rr * Math.cos(tb), v.y + rr * Math.sin(tb)))
      break
    }
    case 'angle': {
      // SKC-56: sector (which of the 4 regions the two lines' intersection
      // divides the plane into) follows the anchor via the SHARED helper --
      // never re-derived here, so the preview/commit/re-render can never
      // disagree on which pair of rays bounds the arc. Degenerate guard
      // (zero-length or near-parallel legs) unchanged: selectAngleSector
      // returns null when lineLineIntersection's length-normalized angular
      // test does (SKC-56-R1 major 1) -- no leader/arc, no NaN.
      const sector = selectAngleSector(entities, plan, anchor)
      if (!sector || !sector.inter) break
      const { inter, startAngle: ta, endAngle: tb } = sector
      const rr = Math.max(Math.hypot(anchor.x - inter.x, anchor.y - inter.y), 1e-3)
      // WO SKC-14 (BK-88): the guide arc is sampled by the one tessellator
      // (sketcher/geometry/arcTessellation.ts), at this preview's fixed 48 segments.
      out.push(
        arcSamplePoints(
          { center: inter, radius: rr, startAngle: ta, endAngle: tb },
          DIM_GUIDE_ARC_DENSITY,
        ),
      )
      out.push(seg(inter.x, inter.y, inter.x + rr * Math.cos(ta), inter.y + rr * Math.sin(ta)))
      out.push(seg(
        inter.x, inter.y,
        inter.x + rr * Math.cos(tb), inter.y + rr * Math.sin(tb),
      ))
      break
    }
  }
  return out
}
