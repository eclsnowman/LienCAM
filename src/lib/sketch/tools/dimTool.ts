// Smart dimension tool (Stage 4, PLAN.md 3.4).
//
// ONE tool; what it dimensions follows the selection (selection-driven behavior):
//   line          -> length   (distance between its own endpoints)
//   line + line   -> angle    (or distance if parallel within epsilon)
//   circle        -> diameter
//   arc           -> radius
//   point + point -> distance
//   point + line  -> distance (perpendicular point-to-line)
//
// PURE module following toolMachine's pattern: no store, no three.js, no
// DOM. Clicks RETURN what to commit (plus a rejection reason when the
// operand set is invalid — never a silent no-op); the store applies it.
//
// distance-X/Y variant: when a two-point distance's points are H- or
// V-aligned, the plain 'distance' kind is still created (it constrains
// the same single freedom). An explicit X/Y axis lock is a future
// MODIFIER on this tool (latch while placing) —
// deliberately NOT part of this commit; the distanceX/distanceY document
// kinds and their solver mapping already exist, so the modifier will
// slot in without a document-format change.

import type {
  Vec2, PointRef, PointSite, SketchEntity, SketchConstraint,
  SketchDimension, SketchDimensionKind,
} from '../types'
import { toDisplay, type Units } from '../../ui/unitFormat'
import { resolveDimPlacement, ordinateStackAnchor } from './dimPlacement'
import { nearestPointOnEllipse, distanceToEllipticalArc, ellipseFocusSite } from '../ellipse'
import { distanceToTextBBox } from '../text'
import { distanceToOutlineTextBBox } from '../textOutline'
import {
  resolveChamferCorner, measureChamferSetbacks, isChamferSetbackLine, resolveFilletCornerSite,
} from './theoreticalCorner'
import { centerPointForEntity } from '../centerReferences'
import {
  SKETCH_AXIS_X_ENTITY_ID,
  SKETCH_AXIS_Y_ENTITY_ID,
} from '../sketchAnchors'

/** A focus point site ('focus1' / 'focus2') on an ellipse / elliptical-arc. */
function isFocusSite(site: PointSite | null): site is 'focus1' | 'focus2' {
  return site === 'focus1' || site === 'focus2'
}

// Two lines whose directions differ by less than this (or by less than
// this from a half-turn — antiparallel lines are parallel too) dimension
// as DISTANCE instead of angle. Tight on purpose: only lines that are
// effectively parallel (solver-constrained, or drawn with H/V snap)
// qualify; visually-almost-parallel freehand lines still get an angle —
// constrain them parallel first if distance was the intent.
export const PARALLEL_EPS_RAD = 1e-3

// Operand pick is ENLARGED once a chain is in progress: the 2nd+ operand is
// usually a thin line and an 8px hit is easy to miss, so widen the hit
// radius. A miss used to fall through to "empty space" and silently commit a
// one-operand dim (the reported bug); enlarging the hit radius makes the
// intended second pick land.
export const OPERAND_PICK_SCALE = 1.5
// A placement click within this band of an UNPICKED entity is treated as a
// NEAR-MISS (the user was aiming at that entity, not placing): the tool stays
// armed and hints, it never commits a partial dimension by accident. Beyond
// this band the click is genuine open space and commits (ADR-0003: no silent
// fallback to a wrong commit). A click near an ALREADY-picked operand still
// places (you may want the label close to the geometry you measured).
export const PLACEMENT_MARGIN_SCALE = 2.5

// ---- In-progress operand set (CHAINING payload) ---------------------------

/** Mode override for a dimension family. The LINEAR family uses aligned/x/y;
 *  a single true circular arc uses arcLength to switch its default Radius
 *  dimension to Arc length. null/undefined = the family's default. The same
 *  Tab gesture cycles both families. */
export type DimForceMode =
  | 'aligned' | 'x' | 'y' | 'arcLength'
  // WO-1867: the ORDINATE stack modes. Unlike the others these are not a
  // re-orientation of a two-operand pick -- they change what the NEXT clicks
  // mean: the single already-picked point becomes the stack's DATUM, and every
  // following point click drops one ordinate from it and re-arms.
  | 'ordinateX' | 'ordinateY'

/** The world axis an ordinate force mode measures along, or null when the mode
 *  is not an ordinate one. The one place the mode-to-axis mapping lives. */
export function ordinateForceAxis(
  mode: DimForceMode | null | undefined,
): 'x' | 'y' | null {
  return mode === 'ordinateX' ? 'x' : mode === 'ordinateY' ? 'y' : null
}

/** A dimension operand. A BARE STRING = the WHOLE entity was picked (a line
 *  BODY, a circle, an arc, a point entity) — the pick-tool default. A
 *  `{ entityId, site }` object = the user EXPLICITLY snapped a specific POINT
 *  SITE on that entity (a line endpoint / vertex, an arc-or-circle center, a
 *  spline start-point, a point's 'self'): the operand then acts as a POINT at
 *  that site, NOT the whole entity. This is what turns "corner + line" into a
 *  point-to-line distance instead of a line-body + line-body angle. */
export interface DimOperand {
  entityId: string
  site: PointSite
}
export type DimOperandRef = string | DimOperand

/** Entity id of an operand regardless of whole-entity vs explicit-point form. */
export function opEntityId(o: DimOperandRef): string {
  return typeof o === 'string' ? o : o.entityId
}
/** Explicit point site of an operand, or null when the whole entity was picked. */
export function opSite(o: DimOperandRef): PointSite | null {
  return typeof o === 'string' ? null : o.site
}

export interface DimChainState {
  kind: 'dim'
  /** Operands clicked so far, in click order. A bare string is a whole-entity
   *  pick; a { entityId, site } is an explicitly-snapped point (see DimOperand).
   *  In an ORDINATE mode (forceMode ordinateX/ordinateY, WO-1867) this holds
   *  exactly ONE operand and it is the stack's DATUM: no extra chain field is
   *  needed, so the generic tool machine carries the stack state unchanged. */
  operandIds: DimOperandRef[]
  /** Tab-forced family mode; null/undefined = that family's default. */
  forceMode?: DimForceMode | null
}

/** Cycle the active dimension family's override under the Tab hotkey. */
export function cycleDimForceMode(
  cur: DimForceMode | null | undefined,
  family: 'linear' | 'arc' | 'ordinate' = 'linear',
): DimForceMode | null {
  if (family === 'arc') return cur === 'arcLength' ? null : 'arcLength'
  // WO-1867: one picked POINT has no two-operand orientation to cycle, so Tab
  // there used to do nothing at all. That free gesture slot now arms the
  // ordinate stack: X ordinates -> Y ordinates -> back to the ordinary
  // accumulate-a-second-operand behavior.
  if (family === 'ordinate') {
    return cur === 'ordinateX' ? 'ordinateY' : cur === 'ordinateY' ? null : 'ordinateX'
  }
  switch (cur) {
    case 'aligned': return 'x'
    case 'x':       return 'y'
    case 'y':       return null
    default:        return 'aligned' // null / undefined (auto) -> aligned
  }
}

/** Positive counter-clockwise sweep carried by the SketchArcEntity contract.
 *  The seam-crossing case (for example 3pi/2 -> pi/2) therefore measures pi,
 *  never a negative length. */
export function positiveArcSweep(startAngle: number, endAngle: number): number {
  let sweep = endAngle - startAngle
  while (sweep <= 0) sweep += Math.PI * 2
  return sweep
}

// ---- Geometry helpers ------------------------------------------------------

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

export function resolvePoint(
  entities: readonly SketchEntity[], ref: PointRef,
): Vec2 | null {
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
    case 'arc': {
      if (ref.site === 'center') return e.center
      if (ref.site === 'start' || ref.site === 'end') {
        const ang = ref.site === 'start' ? e.startAngle : e.endAngle
        return { x: e.center.x + e.radius * Math.cos(ang),
                 y: e.center.y + e.radius * Math.sin(ang) }
      }
      return null
    }
    case 'ellipse':
    case 'elliptical-arc':
      // Center is a real solver point; foci derive from center + inert shape
      // (collapsed onto the center for a circle-degenerate ellipse).
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

/** Perpendicular distance from p to the INFINITE line through the
 *  segment — matches the planegcs p2l_distance the dim constrains. */
export function pointLineDistance(p: Vec2, line: { start: Vec2; end: Vec2 }): number {
  const dx = line.end.x - line.start.x
  const dy = line.end.y - line.start.y
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return dist(p, line.start)
  return Math.abs(dx * (p.y - line.start.y) - dy * (p.x - line.start.x)) / len
}

/** Oriented angle from line a's direction to line b's direction, in
 *  (-pi, pi] — the same atan2(cross, dot) convention planegcs
 *  l2l_angle_ll constrains, so a measured value round-trips through the
 *  solver without moving geometry. */
export function lineAngle(
  a: { start: Vec2; end: Vec2 }, b: { start: Vec2; end: Vec2 },
): number {
  const ax = a.end.x - a.start.x, ay = a.end.y - a.start.y
  const bx = b.end.x - b.start.x, by = b.end.y - b.start.y
  return Math.atan2(ax * by - ay * bx, ax * bx + ay * by)
}

export function linesParallel(
  a: { start: Vec2; end: Vec2 }, b: { start: Vec2; end: Vec2 },
): boolean {
  const ang = Math.abs(lineAngle(a, b))
  return ang <= PARALLEL_EPS_RAD || Math.PI - ang <= PARALLEL_EPS_RAD
}

// SKC-ROTATION-SOLVABLE: the length of the synthetic direction segment a BLOCK
// contributes to an angle dimension. Only its DIRECTION matters (the segment is
// never rendered as geometry); it mirrors the gcs orient line's fixed radius so
// the measured value round-trips through the solver without moving anything.
export const BLOCK_ORIENT_SEGMENT_LEN = 10

/** The DIRECTION SEGMENT an angle-dimension operand contributes: a real line's
 *  own endpoints, or a BLOCK's solver-owned orientation (origin -> a point along
 *  its current rotation). Returns null for any other entity kind. This is what
 *  lets the smart-dimension tool MEASURE and DRIVE a block's rotation with an
 *  ordinary angle dimension -- the same operand gcsMapping resolves to the
 *  block's :orient line, so preview/commit/solve agree on the angle. */
export function angleOperandSegment(e: SketchEntity): { start: Vec2; end: Vec2 } | null {
  if (e.kind === 'line') return { start: e.start, end: e.end }
  if (e.kind === 'block') {
    return {
      start: e.origin,
      end: {
        x: e.origin.x + Math.cos(e.rotation) * BLOCK_ORIENT_SEGMENT_LEN,
        y: e.origin.y + Math.sin(e.rotation) * BLOCK_ORIENT_SEGMENT_LEN,
      },
    }
  }
  return null
}

// Zero-length leg guard for lineLineIntersection's angular test below (mm) --
// a degenerate (coincident-endpoint) line carries no direction at all, so it
// is rejected before the parallel test can divide by its near-zero length.
const MIN_LEG_LENGTH = 1e-9
// Near-parallel threshold for lineLineIntersection, expressed as sin(angle
// between the two lines' directions) rather than a raw cross-product
// magnitude (SKC-56-R1 major 1). The raw-denom form (|d1||d2|*sin(theta)
// compared to a fixed 1e-9) was SCALE-DEPENDENT: two long lines separated by
// a genuinely tiny angle produced a large-magnitude denominator purely from
// their length and slipped past the guard (1000 mm legs at 1e-12 rad ->
// denom ~1e-6, five orders of magnitude over the old threshold). Dividing by
// |d1|*|d2| first makes the test pure angle, independent of leg length.
const MIN_SIN_ANGLE = 1e-9

/** Infinite-line intersection of two segments, or null when the legs are
 *  degenerate (near-zero length) or near-parallel — a LENGTH-NORMALIZED
 *  angular test, so the guard fires at the same angle regardless of how long
 *  the two lines are (shared by the angle sector helper below and
 *  dimPlacement's guides). */
export function lineLineIntersection(
  a: { start: Vec2; end: Vec2 }, b: { start: Vec2; end: Vec2 },
): Vec2 | null {
  const d1x = a.end.x - a.start.x, d1y = a.end.y - a.start.y
  const d2x = b.end.x - b.start.x, d2y = b.end.y - b.start.y
  const lenA = Math.hypot(d1x, d1y), lenB = Math.hypot(d2x, d2y)
  if (lenA < MIN_LEG_LENGTH || lenB < MIN_LEG_LENGTH) return null
  const denom = d1x * d2y - d1y * d2x
  if (Math.abs(denom) / (lenA * lenB) < MIN_SIN_ANGLE) return null
  const t = ((b.start.x - a.start.x) * d2y - (b.start.y - a.start.y) * d2x) / denom
  return { x: a.start.x + t * d1x, y: a.start.y + t * d1y }
}

const TWO_PI = Math.PI * 2
function norm2pi(x: number): number {
  const v = x % TWO_PI
  return v < 0 ? v + TWO_PI : v
}

/** Reference to the two lines an angle dimension (or its in-progress plan)
 *  measures -- the structural shape both AngleDimension and the 'angle'
 *  PlannedDimension share. */
export interface AngleSectorRef { a: string; b: string }

export interface AngleSector {
  /** Signed value to store on the dimension / feed to gcsMapping (fully
   *  directed -- see the WO SKC-56 design note). The anchor's SECTOR (which
   *  of the 4 regions the two infinite lines' intersection divides the plane
   *  into) selects between the atan2 short-way value (`theta`, the sector
   *  directly between the lines' own a-end/b-end directions -- ALWAYS a no-op
   *  solve, since it is exactly the lines' current measured relationship) and
   *  the far/obtuse value.
   *
   *  SKC-58B: the far value is the SIGNED directed angle for a REVERSED
   *  operand B (`theta - sign(theta)*pi`, e.g. -145deg for theta=+35deg),
   *  paired with `reverseB=true` below -- NOT the old unsigned supplement
   *  `pi - |theta|`. The old supplement was fed to the DIRECTED l2l_angle_ll
   *  against unchanged operands, so the current geometry (directed +35) did
   *  NOT satisfy it and the solver rotated the line to the supplement on
   *  commit (the SKC-58 bug Operator rejected). The reversed-operand value IS
   *  satisfied by the as-drawn geometry, so the obtuse pick commits with NO
   *  motion. |value| still equals the obtuse magnitude 180-|theta|, so the
   *  positive-sweep label (formatDimensionValue) is unchanged. */
  value: number
  /** SKC-58B: true iff `value` is the reversed-operand far/obtuse form and
   *  the solver mapping must build the angle constraint with operand B's
   *  direction reversed (gcsMapping's 'angle' case). false for the near
   *  sector (operands in start->end order, the pre-SKC-58B path). Copied onto
   *  the committed AngleDimension.reverseB by every write site. */
  reverseB: boolean
  /** Infinite-line intersection, or null when the lines are degenerate
   *  (near-zero length) or (near-)parallel -- callers render/store nothing
   *  (existing degenerate guard: lineLineIntersection's length-normalized
   *  angular test, SKC-56-R1 major 1). */
  inter: Vec2 | null
  /** CCW arc bounds (world radians) for the render -- endAngle - startAngle
   *  is always in (0, pi]. Computed directly from the CURRENT (a, b)
   *  geometry + anchor (never from `value`), so the preview is correct on
   *  every pointermove even before a solve has caught up to a stored
   *  `value` that just changed sector. */
  startAngle: number
  endAngle: number
  /** true when `anchor` carries no reliable near/far side information: it is
   *  null, sits exactly at the two lines' shared vertex, or sits exactly ON
   *  one of the two lines (SKC-56-R1 major 2). `value` still holds the
   *  short-way default in this case (the correct behavior for a fresh
   *  CREATION or an unlabeled reference measurement, P6) -- but a caller
   *  preserving a COMMITTED sector (angleLabelDragValueOverride) must treat
   *  this as "no crossing detected" and keep the dimension's current value
   *  instead of comparing it against the fallback, or a committed far-sector
   *  dimension would be silently pulled back to the near sector the instant
   *  the label crosses a boundary. */
  onBoundary: boolean
}

/** Directed angle (atan2(cross, dot), (-pi, pi]) from vertex->a to vertex->b
 *  for a three-point angle's CURRENT geometry, or null when a site does not
 *  resolve or a leg has no length. */
export function angle3Theta(
  entities: readonly SketchEntity[], d: { vertex: PointRef; a: PointRef; b: PointRef },
): number | null {
  const v = resolvePoint(entities, d.vertex)
  const a = resolvePoint(entities, d.a)
  const b = resolvePoint(entities, d.b)
  if (!v || !a || !b) return null
  if (dist(v, a) < MIN_LEG_LENGTH || dist(v, b) < MIN_LEG_LENGTH) return null
  return lineAngle({ start: v, end: a }, { start: v, end: b })
}

/** Sector for a three-point angle at `anchor`: the SAME selectSectorForSegments
 *  rule the two-line kind uses, on the vertex->leg segments. */
export function selectAngle3Sector(
  entities: readonly SketchEntity[],
  legs: { vertex: PointRef; a: PointRef; b: PointRef }, anchor: Vec2 | null,
): AngleSector | null {
  const v = resolvePoint(entities, legs.vertex)
  const a = resolvePoint(entities, legs.a)
  const b = resolvePoint(entities, legs.b)
  if (!v || !a || !b) return null
  return selectSectorForSegments({ start: v, end: a }, { start: v, end: b }, anchor)
}

/**
 * SKC-59-R4: the reversed-operand sign/value convention -- the ONE formula
 * that turns a raw directed angle `theta` (lineAngle's atan2(cross, dot),
 * never 0 for a non-degenerate/non-parallel pair) into the SIGNED value a
 * sector pick stores. Near sector: `theta` unchanged. Far/obtuse sector:
 * `theta - sign(theta)*pi` -- the reversed-operand directed angle the
 * as-drawn geometry already satisfies (see selectAngleSector's own doc for
 * the full derivation; signedAngleEditValue above documents the same
 * convention from the edit side). Factored out so selectAngleSector (the
 * PRODUCER, which derives a value from live geometry) and the gcsMapping
 * boundary guard (the VALIDATOR, SKC-59-R4, which checks a value ALREADY on
 * a dimension has not drifted from what this formula would produce) read
 * the identical formula -- a guard reimplementing its own copy is exactly
 * the "second definition" the WO forbids.
 */
export function angleSectorValue(theta: number, reverseB: boolean): number {
  return reverseB ? theta - Math.sign(theta) * Math.PI : theta
}

/**
 * SKC-59-R5 (blocker C1): the ONE sign-convention predicate for a stored
 * angle-dimension value. Factored OUT of signedAngleEditValue (below) so
 * that function and this guard consume the identical rule instead of each
 * deciding the sign of a value on its own -- the R4 audit's exact blocker:
 * this guard derived its expected-sign rule from angleSectorValue while
 * signedAngleEditValue kept an untouched inline copy of the same decision.
 * 0 and -0 both read as the positive sign, matching signedAngleEditValue's
 * "treat a 0/-0 current value as the positive (near) sector" contract.
 */
export function angleValueSign(value: number): 1 | -1 {
  return value < 0 ? -1 : 1
}

/**
 * SKC-59-R4/R5 boundary guard predicate: true iff `value`'s sign is
 * consistent with the reversed-operand convention angleSectorValue defines
 * above, given the CURRENT `theta` (lineAngle(a, b)) between the dimension's
 * two lines. Only meaningful for reverseB=true -- a near-sector value's sign
 * equals theta's OWN sign (either polarity is valid depending on how the
 * lines were drawn), so there is nothing to contradict; the gcsMapping guard
 * only calls this for reverseB=true dims, matching the WO's exact scope.
 *
 * SKC-59-R5 (major C2): the R4 version bypassed the whole check -- for
 * EITHER sign -- whenever theta fell within PARALLEL_EPS_RAD (1e-3 rad) of
 * 0 or +-pi, a tolerance BAND the audit correctly flagged as a bypass
 * window (a genuinely wrong-signed value at, say, theta=+0.0001 sailed
 * through unvalidated). The math only actually collapses at the three
 * EXACT points theta=0, theta=+pi, theta=-pi: angleSectorValue's far target
 * there is a rotation of exactly +-pi (theta=0) or exactly 0 (theta=+-pi),
 * and +pi/-pi (equally +0/-0) denote the SAME physical rotation, so the
 * stored sign carries no information at those three points ONLY and both
 * are accepted unconditionally. One ULP away from any of them the target
 * has a well-defined, single-valued sign (see angleSectorValue) and is
 * validated normally below -- no bypass range survives.
 */
export function reversedAngleValueSignValid(theta: number, value: number): boolean {
  if (theta === 0 || theta === Math.PI || theta === -Math.PI) return true
  const expected = angleSectorValue(theta, true)
  return angleValueSign(value) === angleValueSign(expected)
}

/**
 * SHARED sector selection for a two-line angle dimension (WO SKC-56):
 * which of the 4 regions the two infinite lines' intersection divides the
 * plane into contains `anchor`, the signed solver-facing value for that
 * sector, and the CCW arc bounds to render. ONE implementation for BOTH
 * dimGuides' 'angle' case (dimPlacement.ts) and measureDimension's 'angle'
 * case below -- two independent reimplementations that could diverge is an
 * audit fail per the WO's own preflight.
 *
 * `anchor === null` (no live cursor / no labelAnchor yet) skips the sector
 * test entirely and returns the atan2 short-way value/arc -- the P6
 * degenerate default ("keep the previous sector, or default short-way at
 * creation"), and exactly today's pre-WO behavior for a fresh reference
 * measurement with no label placed.
 */
export function selectAngleSector(
  entities: readonly SketchEntity[], plan: AngleSectorRef, anchor: Vec2 | null,
): AngleSector | null {
  // Resolve each operand to its direction segment: a real line, or a block's
  // solver-owned orientation (SKC-ROTATION-SOLVABLE). Any other kind -> null.
  const ea = entities.find((e) => e.id === plan.a)
  const eb = entities.find((e) => e.id === plan.b)
  if (!ea || !eb) return null
  const a = angleOperandSegment(ea)
  const b = angleOperandSegment(eb)
  if (!a || !b) return null
  return selectSectorForSegments(a, b, anchor)
}

/** The sector core shared by the two-line angle and the WO-1868 three-point
 *  angle (whose two "lines" are the vertex->leg segments): ONE implementation
 *  of the near/far rule so the two kinds can never disagree about SKC-58B. */
export function selectSectorForSegments(
  a: { start: Vec2; end: Vec2 }, b: { start: Vec2; end: Vec2 }, anchor: Vec2 | null,
): AngleSector | null {
  const inter = lineLineIntersection(a, b)
  if (!inter) return null
  const dax = a.end.x - a.start.x, day = a.end.y - a.start.y
  const dbx = b.end.x - b.start.x, dby = b.end.y - b.start.y
  const theta = Math.atan2(dax * dby - day * dbx, dax * dbx + day * dby)
  const daAng = Math.atan2(day, dax)
  const dbAng = Math.atan2(dby, dbx)

  let far = false
  let anchorAng = daAng
  // SKC-56-R1 major 2: EXPLICIT boundary/vertex classification. `far` alone
  // cannot distinguish "the anchor is genuinely in the near sector" from
  // "the anchor carries no side information at all" -- both leave `far`
  // false. A committed-drag caller needs to tell those apart (major 2's
  // required fix), so onBoundary is tracked separately and returned
  // alongside `value`.
  let onBoundary = anchor === null
  if (anchor !== null) {
    const axv = anchor.x - inter.x, ayv = anchor.y - inter.y
    const anchorLen = Math.hypot(axv, ayv)
    if (anchorLen < 1e-9) {
      onBoundary = true // exactly at the shared vertex
    } else {
      anchorAng = Math.atan2(ayv, axv)
      // Degenerate guard (P6): the anchor sitting exactly ON one of the two
      // lines carries no usable side information for THAT line -- treat it
      // like "no anchor" (short-way default) rather than divide by a
      // near-zero cross product or flicker between sectors at the boundary.
      const sideA = dax * ayv - day * axv
      const sideB = dbx * ayv - dby * axv
      const scale = Math.max(1, anchorLen)
      const onLine = Math.abs(sideA) < 1e-9 * scale || Math.abs(sideB) < 1e-9 * scale
      if (onLine) {
        onBoundary = true
      } else {
        const signA = sideA >= 0 ? 1 : -1
        const signB = sideB >= 0 ? 1 : -1
        far = signA === signB
      }
    }
  }
  // SKC-58B: near sector = the raw directed angle (no-op solve). Far/obtuse
  // sector = the SIGNED directed angle for a REVERSED operand B, which the
  // as-drawn geometry ALREADY satisfies (paired with reverseB below so
  // gcsMapping reverses B). `theta - sign(theta)*pi` is the normalization of
  // `theta + pi` into (-pi, pi]: for theta=+35deg -> -145deg, for
  // theta=-35deg -> +145deg. |value| = pi - |theta| (the obtuse magnitude),
  // so the positive-sweep label is unchanged. theta is never 0 in the far
  // branch (parallel/degenerate lines are rejected by lineLineIntersection
  // above, so `far` cannot be true with theta==0). SKC-59-R4: this formula
  // now lives in angleSectorValue (byte-identical expression, just factored
  // out) so the gcsMapping boundary guard shares this exact computation.
  const value = angleSectorValue(theta, far)

  // Render rays: sort the 4 breakpoints {+da, +db, -da, -db} and find the
  // interval containing the anchor's OWN angle -- a pure function of the
  // CURRENT geometry, independent of `value`/`far` above (see the AngleSector
  // doc comment), so it is correct even mid-drag before any solve runs.
  const rays = [daAng, dbAng, daAng + Math.PI, dbAng + Math.PI].map(norm2pi).sort((x, y) => x - y)
  const phiN = norm2pi(anchorAng)
  let startAngle = rays[0], endAngle = rays[1]
  for (let i = 0; i < 4; i++) {
    const lo = rays[i], hi = rays[(i + 1) % 4]
    const hiAdj = hi > lo ? hi : hi + TWO_PI
    const phiAdj = phiN >= lo ? phiN : phiN + TWO_PI
    if (phiAdj >= lo && phiAdj < hiAdj) { startAngle = lo; endAngle = hiAdj; break }
  }
  return { value, inter, startAngle, endAngle, onBoundary, reverseB: far }
}

/**
 * Value override for a committed angle dimension's label being dragged to
 * `anchor`, or null when the drag stays within the CURRENT sector (move-
 * only -- the existing labelAnchor-only behavior). Shared by both hosts'
 * label-drag write sites (WO SKC-56 design point 3) so the "did the label
 * cross into a different sector" test can never diverge between them.
 * Non-angle dimensions (and a degenerate/near-parallel angle dimension)
 * always return null. A BOUNDARY/vertex anchor (SKC-56-R1 major 2) also
 * returns null: selectAngleSector's `onBoundary` flag means the anchor
 * carries no reliable near/far side information, so its `value` is only the
 * short-way CREATION default, not a genuine sector crossing -- treating that
 * fallback as real would silently pull a committed FAR-sector dimension back
 * to the near sector the instant the label is dragged onto a line or vertex.
 *
 * SKC-58B: the override now carries `reverseB` alongside `value` -- a near->far
 * crossing must flip BOTH (the reversed-operand orientation is what makes the
 * new far value a no-motion constraint; writing the value without reverseB
 * would feed a directed angle the geometry does not satisfy and drag the line).
 * A crossing is detected when EITHER the value or the reverseB orientation
 * changes (a near<->far crossing always changes both; the >1e-9 value guard
 * alone cannot see a pure orientation flip at the theta=90deg degenerate).
 */
export interface AngleSectorOverride { value: number; reverseB: boolean }

export function angleLabelDragValueOverride(
  entities: readonly SketchEntity[], d: SketchDimension, anchor: Vec2,
): AngleSectorOverride | null {
  // WO-1868: a three-point angle follows its label across sectors exactly like
  // the two-line kind (an arc's ccw included angle has one reading: no sectors).
  if (d.kind !== 'angle' && !(d.kind === 'angle3' && !d.ccw)) return null
  const sector = d.kind === 'angle3'
    ? selectAngle3Sector(entities, d, anchor)
    : selectAngleSector(entities, d, anchor)
  if (!sector || sector.onBoundary) return null
  const valueChanged = Math.abs(sector.value - d.value) > 1e-9
  const orientationChanged = sector.reverseB !== (d.reverseB ?? false)
  return valueChanged || orientationChanged
    ? { value: sector.value, reverseB: sector.reverseB }
    : null
}

/**
 * SKC-59-R1 (blocker C1): the single point of truth that normalizes a TYPED
 * angle-dimension value back into the dimension's SIGNED solver convention.
 *
 * The numeric value box (and the arc label) is a positive MAGNITUDE -- the label
 * is `|value|` (formatDimensionText abs's it, AngleDimension.reverseB doc). But
 * the STORED angle value is SIGNED, and the sign encodes the SECTOR/SIDE the
 * user is looking at: a far/obtuse pick stores the negative reversed-operand
 * directed angle (selectAngleSector: `theta - sign(theta)*pi`, e.g. -143deg for
 * a line directed +37deg), a near pick stores the directed angle's own sign.
 * Typing a new magnitude changes only the MAGNITUDE, never the sector -- the
 * sector is changed by dragging the label (angleLabelDragValueOverride), never
 * by the number box. So an edited magnitude must INHERIT the current value's
 * sign.
 *
 * Without this, both hosts wrote the raw typed magnitude while retaining
 * reverseB: Operator's far dim stored at -143deg took a typed +120, kept
 * reverseB=true, and the reversed-operand constraint drove the line to the
 * MIRROR branch (directed -60 instead of the intended +60 -- the dim still
 * reads 120, but the line jumps to the wrong side of the reference).
 *
 * Both host accept paths (CAM store.commitDimensionValue and the workbench
 * workbenchOverlaysPort.commitDimensionValue) call THIS function so they cannot
 * diverge. Non-angle dimensions are unsigned magnitudes and are returned
 * unchanged. Idempotent: a value that already carries the correct sign
 * (`sign(dim.value) * |dim.value|`) is returned unchanged, so an internal caller
 * that already passes the signed value (e.g. a far label-drag remeasure re-entry)
 * is a no-op.
 */
export function signedAngleEditValue(dim: SketchDimension, typedValue: number): number {
  if (dim.kind !== 'angle' && dim.kind !== 'angle3') return typedValue
  // dim.value is never 0 for an angle dim (parallel/degenerate lines are
  // rejected at creation), but treat a 0/-0 current value as the positive
  // (near) sector so the sign is always well-defined. SKC-59-R5: the sign
  // decision itself now lives in angleValueSign (factored out, shared with
  // the gcsMapping boundary guard below) -- this is no longer a second,
  // independent definition of the same rule.
  return angleValueSign(dim.value) * Math.abs(typedValue)
}

// ---- Measurement -----------------------------------------------------------

/**
 * Measured value of a dimension against the CURRENT entity geometry
 * (mm; radians for angles), or null when a reference cannot be resolved.
 * Used to pre-fill new dimensions and to keep reference (driven)
 * dimensions tracking after every solve.
 *
 * `constraints` is an EXTENSION (optional, defaults to none) needed only by
 * 'd1xd2' (its theoretical-corner lookup walks the coincident/point_on_object
 * graph); every other kind ignores it, so existing entities-only callers are
 * unaffected. For 'd1xd2' this reports d1 only (the base `value` field's
 * convention) -- callers that need BOTH setbacks use measureChamferSetbacks
 * directly (theoreticalCorner.ts).
 */
export function measureDimension(
  entities: readonly SketchEntity[], d: SketchDimension,
  constraints: readonly SketchConstraint[] = [],
): number | null {
  const ent = (id: string) => entities.find((e) => e.id === id)
  switch (d.kind) {
    case 'distance': {
      const a = resolvePoint(entities, d.a)
      const b = resolvePoint(entities, d.b)
      return a && b ? dist(a, b) : null
    }
    case 'distanceX': {
      const a = resolvePoint(entities, d.a)
      const b = resolvePoint(entities, d.b)
      return a && b ? b.x - a.x : null // signed, mirrors the 'difference' mapping
    }
    case 'distanceY': {
      const a = resolvePoint(entities, d.a)
      const b = resolvePoint(entities, d.b)
      return a && b ? b.y - a.y : null
    }
    // ORDINATE (WO-1867): the signed offset of the measured point from the
    // stack's DATUM along the named axis -- the same quantity the 'difference'
    // primitive holds, so a reference ordinate's re-measured readout and a
    // driving one's solver value are the same number by construction.
    case 'ordinate': {
      const o = resolvePoint(entities, d.origin)
      const p = resolvePoint(entities, d.point)
      if (!o || !p) return null
      return d.axis === 'x' ? p.x - o.x : p.y - o.y
    }
    case 'distancePL': {
      const p = resolvePoint(entities, d.point)
      const l = ent(d.line)
      return p && l && l.kind === 'line' ? pointLineDistance(p, l) : null
    }
    case 'angle': {
      // SKC-56: the sector (which of the 4 regions the two lines' current
      // intersection divides the plane into) follows the dimension's own
      // labelAnchor -- same helper dimGuides uses, so a reference dim's
      // re-measured value after every solve never disagrees with what its
      // label is drawn over. No labelAnchor yet (fresh, unlabeled) falls
      // back to the atan2 short-way value (today's behavior, unchanged).
      const sector = selectAngleSector(entities, d, d.labelAnchor ?? null)
      return sector ? sector.value : null
    }
    // THREE-POINT angle (WO-1868): the directed angle vertex->a to vertex->b in
    // the dimension's OWN stored sector (reverseB / ccw), never re-derived from
    // the label -- so a reference dim's remeasure and a driving dim's solver
    // value are the same number, and no write path can desync value from
    // orientation (the store's generic value-only snap stays valid).
    case 'angle3': {
      const theta = angle3Theta(entities, d)
      if (theta === null) return null
      // ccw = an arc's included angle: the CCW sweep in (0, 2pi], so a
      // 270-degree arc reads 270, not the near-sector 90.
      if (d.ccw) return theta < 0 ? theta + TWO_PI : theta
      return angleSectorValue(theta, d.reverseB ?? false)
    }
    case 'radius': {
      const e = ent(d.entityId)
      return e && (e.kind === 'circle' || e.kind === 'arc') ? e.radius : null
    }
    case 'diameter': {
      const e = ent(d.entityId)
      return e && (e.kind === 'circle' || e.kind === 'arc') ? e.radius * 2 : null
    }
    case 'arcLength': {
      const e = ent(d.entityId)
      return e && e.kind === 'arc'
        ? e.radius * positiveArcSweep(e.startAngle, e.endAngle)
        : null
    }
    // Inert ellipse dims: report the current axis radius (both the full
    // ellipse and the elliptical arc carry majorRadius/minorRadius).
    case 'majorRadius': {
      const e = ent(d.entityId)
      return e && (e.kind === 'ellipse' || e.kind === 'elliptical-arc') ? e.majorRadius : null
    }
    case 'minorRadius': {
      const e = ent(d.entityId)
      return e && (e.kind === 'ellipse' || e.kind === 'elliptical-arc') ? e.minorRadius : null
    }
    // Focus-to-focus: the current inter-focal distance 2c (foci derive from
    // center + inert shape). A circle-degenerate ellipse collapses both foci
    // onto the center -> 0 (no two distinct foci).
    case 'focusDistance': {
      const e = ent(d.entityId)
      if (!e || (e.kind !== 'ellipse' && e.kind !== 'elliptical-arc')) return null
      return dist(ellipseFocusSite(e, 'focus1'), ellipseFocusSite(e, 'focus2'))
    }
    // REFERENCE-ONLY chamfer setback pair (ADR-0003 inert fork, UI-50C): d1
    // only (base `value` convention) -- measureChamferSetbacks reports both.
    case 'd1xd2': {
      const m = measureChamferSetbacks(entities, constraints, d.entityId)
      return m ? m.d1 : null
    }
  }
}

/** Atomic (value, reverseB) remeasurement of an angle dimension against the
 *  CURRENT geometry -- the SHARED accessor EVERY host write path uses so the
 *  sector-derived signed value and the reversed-operand orientation can never
 *  be updated apart (SKC-58B blocker 1). A near pick returns {theta, false};
 *  a far/obtuse pick returns {theta-sign(theta)*pi, true}, both from ONE
 *  selectAngleSector call keyed on the dimension's own labelAnchor. Returns
 *  null for a non-angle dim or an unresolvable/degenerate sector (caller keeps
 *  the prior value). measureDimension reports the value alone for the many
 *  callers that do not touch orientation; this is the companion for the write
 *  paths that DO (remeasureReferenceDimensions and the driving->reference
 *  toggle's eager value snap). */
export function measureAngleDimension(
  entities: readonly SketchEntity[], d: SketchDimension,
): { value: number; reverseB: boolean } | null {
  if (d.kind !== 'angle') return null
  const sector = selectAngleSector(entities, d, d.labelAnchor ?? null)
  return sector ? { value: sector.value, reverseB: sector.reverseB } : null
}

// ---- Display formatting ----------------------------------------------------

/** Formatted dimension value text — shared by the committed-label
 *  renderer (sketchLayer dimensionDisplay) and the tool's cursor preview
 *  so they can never disagree. Reference (driven) dims are parenthesized
 *  per CAD convention.
 *
 *  LINEAR kinds (distance/distanceX/distanceY/distancePL/radius/diameter)
 *  store millimeters and are converted to the display units at the edge
 *  here (ADR-0022): mm = identity at 2 decimals (today's behavior, exact);
 *  inch divides by 25.4 and shows 4 decimals so a sub-mm length stays
 *  legible. ANGLE is degrees and is unit-invariant — never converted. */
export function formatDimensionValue(
  kind: SketchDimensionKind, value: number, driving: boolean,
  units: Units = 'mm',
): string {
  // Linear dims: convert mm -> display units, then fix decimals per unit.
  const lin = (v: number) => toDisplay(v, units).toFixed(units === 'inch' ? 4 : 2)
  let text: string
  switch (kind) {
    case 'distance':
    case 'distanceX':
    case 'distanceY':
    // An ORDINATE reads as the bare offset from its datum, the way an ordinate
    // stack reads on a drawing. The value is SIGNED (below/left of the datum is
    // negative) and is shown as stored -- a magnitude that disagreed with the
    // geometry would be the plausible-but-wrong output ADR-0003 forbids.
    case 'ordinate':
    case 'distancePL': text = lin(value); break
    case 'radius':      text = `R${lin(value)}`; break
    case 'diameter':    text = `D${lin(value)}`; break
    case 'arcLength':   text = `Larc ${lin(value)}`; break
    // Spaced "Rmaj "/"Rmin " so the axis is legible at a glance and the value
    // reads cleanly apart from the prefix (which is which is otherwise unclear).
    case 'majorRadius': text = `Rmaj ${lin(value)}`; break
    case 'minorRadius': text = `Rmin ${lin(value)}`; break
    // "2c " prefix: the value IS the inter-focal distance 2c (foci-to-foci).
    case 'focusDistance': text = `2c ${lin(value)}`; break
    // SKC-56/SKC-58B: the STORED value is the signed solver-facing convention
    // -- selectAngleSector's raw `theta` for a near pick, or the reversed-
    // operand signed far value `theta - sign(theta)*pi` (paired with
    // reverseB=true) for a far/obtuse pick, NOT the old unsigned supplement
    // `pi - |theta|`. The sector-crossing sign/orientation choice is internal
    // only and never shown -- the label is always the POSITIVE sweep magnitude
    // |value| (the current convention), which is identical for either far
    // representation because |theta - sign(theta)*pi| == pi - |theta|.
    case 'angle':
    case 'angle3':   text = `${((Math.abs(value) * 180) / Math.PI).toFixed(1)} deg`; break
    // 'd1xd2' is TWO-valued (d1 + d2) -- this single-value formatter cannot
    // carry d2, so it refuses loudly by name instead of silently printing d1
    // alone (ADR-0003: no plausible-but-wrong output). Every real caller
    // (dimensionDisplay, dimPreview) special-cases 'd1xd2' to
    // formatChamferSetbackValue before reaching here.
    case 'd1xd2':
      throw new TwoValueDimensionKindError(kind)
    default: throw new UnknownSketchDimensionKindError(kind)
  }
  return driving ? text : `(${text})`
}

/** Both setback values for the reference-only chamfer d1xd2 dimension
 *  (UI-50C). Shares formatDimensionValue's mm/inch edge conversion and
 *  driving-parenthesization so the two never disagree stylistically. */
export function formatChamferSetbackValue(
  d1: number, d2: number, driving: boolean, units: Units = 'mm',
): string {
  const lin = (v: number) => toDisplay(v, units).toFixed(units === 'inch' ? 4 : 2)
  const text = `${lin(d1)} x ${lin(d2)}`
  return driving ? text : `(${text})`
}

/** Named runtime refusal for malformed documents that evade TypeScript. */
export class UnknownSketchDimensionKindError extends Error {
  constructor(kind: unknown) {
    super(`unknown sketch dimension kind '${String(kind)}'`)
    this.name = 'UnknownSketchDimensionKindError'
  }
}

/** Thrown when a TWO-valued dimension kind (currently only 'd1xd2') reaches
 *  the single-value formatDimensionValue -- a caller bug, never a document
 *  condition. Use formatChamferSetbackValue instead. */
export class TwoValueDimensionKindError extends Error {
  constructor(kind: unknown) {
    super(`sketch dimension kind '${String(kind)}' is two-valued - ` +
      'use formatChamferSetbackValue, not formatDimensionValue')
    this.name = 'TwoValueDimensionKindError'
  }
}

/** Re-measure every display-only reference dimension against solved geometry.
 *  The original array and objects are preserved when no value changed. Both
 *  sketch hosts call this one helper after a successful solve, so reference
 *  dimensions can never drift into host-specific behavior.
 *
 *  `constraints` is an EXTENSION (optional, defaults to none) needed only by
 *  'd1xd2', which carries TWO measured fields (value=d1, d2) -- it is
 *  special-cased here rather than routed through the single-value
 *  measureDimension. */
export function remeasureReferenceDimensions(
  entities: readonly SketchEntity[], dimensions: SketchDimension[],
  constraints: readonly SketchConstraint[] = [],
): SketchDimension[] {
  let changed = false
  const next = dimensions.map((d) => {
    // WO-1858: d1xd2 is an ordinary dimension kind now -- a DRIVING one holds
    // both setbacks through the compound solver mapping and must not have its
    // value overwritten by a measurement, exactly like every other driving
    // kind. Only the reference case below re-measures, and it measures BOTH
    // fields (value=d1, d2), which the single-value measureDimension cannot.
    if (d.driving) return d
    if (d.kind === 'd1xd2') {
      const m = measureChamferSetbacks(entities, constraints, d.entityId)
      if (!m) return d
      if (Math.abs(m.d1 - d.value) <= 1e-9 && Math.abs(m.d2 - d.d2) <= 1e-9) return d
      changed = true
      return { ...d, value: m.d1, d2: m.d2 }
    }
    // SKC-58B blocker 1: an angle reference dim must remeasure its sector-
    // derived signed value AND its reverseB orientation ATOMICALLY from ONE
    // selectAngleSector result. When OTHER constraints move the lines so the
    // fixed label crosses the near<->far boundary, the signed value and the
    // reversed-operand orientation change TOGETHER (a far pick stores
    // theta-sign(theta)*pi with reverseB=true; a near pick stores theta with
    // reverseB=false). Writing the value through the generic measureDimension
    // path alone would leave a STALE reverseB, so re-enabling driving would map
    // a directed angle the current geometry no longer satisfies and rotate/flip
    // it 180deg -- violating Operator's no-motion bar. The unchanged-value/
    // orientation-changed case (the theta=90deg boundary, where |value| is
    // unchanged but the sector orientation flips) is caught by the reverseB
    // comparison, not the value guard. reverseB is always written EXPLICITLY
    // (never omitted): a near remeasure of a previously-far dim must CLEAR the
    // stored reverseB, and an object spread that dropped the key would preserve
    // the stale true.
    if (d.kind === 'angle') {
      const m = measureAngleDimension(entities, d)
      if (!m) return d
      const curReverseB = d.reverseB ?? false
      if (m.reverseB === curReverseB && Math.abs(m.value - d.value) <= 1e-9) return d
      changed = true
      return { ...d, value: m.value, reverseB: m.reverseB }
    }
    const value = measureDimension(entities, d, constraints)
    if (value === null || Math.abs(value - d.value) <= 1e-9) return d
    changed = true
    return { ...d, value }
  })
  return changed ? next : dimensions
}

// ---- Mode labels (live cursor MODE readout) --------------------------------
//
// The on-screen cursor preview names the RESOLVED orientation so placement is
// never a blind interactive op (Operator's rule: live feedback for every op). The
// label maps 1:1 from the resolved dimension kind — the SAME kind the witness
// lines and the commit use — so the shown mode can never disagree with what
// lands on click.

export type DimModeLabel =
  | 'Aligned' | 'Horizontal' | 'Vertical' | 'Perpendicular'
  | 'Radius' | 'Diameter' | 'Major radius' | 'Minor radius' | 'Angle'
  | 'Focus distance' | 'Arc length' | 'D1 x D2' | 'Ordinate'

const KIND_MODE_LABEL: Record<SketchDimensionKind, DimModeLabel> = {
  distance:  'Aligned',
  distanceX: 'Horizontal',
  distanceY: 'Vertical',
  // WO-1867: ONE label for both axes -- the axis lives in a field, not in the
  // kind, and this map is keyed by kind. The live cursor preview names the
  // axis separately (ordinateModeText) so the operator still sees which one
  // the next click will drop.
  ordinate:  'Ordinate',
  distancePL: 'Perpendicular',
  angle:     'Angle',
  angle3:    'Angle',
  radius:    'Radius',
  diameter:  'Diameter',
  arcLength: 'Arc length',
  majorRadius: 'Major radius',
  minorRadius: 'Minor radius',
  focusDistance: 'Focus distance',
  d1xd2: 'D1 x D2',
}

/** Runtime kind order derived from the one exhaustive production label map.
 *  Consumers such as the browser must use this rather than maintain a second
 *  hand-written dimension-kind list. */
export const DIMENSION_KINDS = Object.freeze(
  Object.keys(KIND_MODE_LABEL) as SketchDimensionKind[],
)

/** Human MODE label for a resolved dimension kind (cursor preview + tests). */
export function dimModeLabel(kind: SketchDimensionKind): DimModeLabel {
  return KIND_MODE_LABEL[kind]
}

/** The linear two-point/single-line family. */
export function isLinearDimKind(kind: SketchDimensionKind): boolean {
  return kind === 'distance' || kind === 'distanceX' || kind === 'distanceY'
}

/** Kinds whose placement mode can be changed by the existing Tab gesture. */
export function isDimKindTabCyclable(kind: SketchDimensionKind): boolean {
  return isLinearDimKind(kind) || kind === 'radius' || kind === 'arcLength'
}

// ---- Type inference --------------------------------------------------------

/** A fully inferred dimension, minus id/labelAnchor (the placement click
 *  supplies those). `value` is the measured value. */
export type PlannedDimension =
  | { kind: 'distance'; a: PointRef; b: PointRef; value: number }
  // distanceX/distanceY are NEVER produced by planDimension (which is
  // orientation-blind); the placement resolver (dimPlacement.ts) rewrites
  // a two-point/line 'distance' plan into one of these from the drag
  // vector. Same a/b refs, value normalized positive (b - a >= 0).
  | { kind: 'distanceX'; a: PointRef; b: PointRef; value: number }
  | { kind: 'distanceY'; a: PointRef; b: PointRef; value: number }
  // ORDINATE (WO-1867): also never produced by planDimension -- an ordinate is
  // not an inference over an operand PAIR, it is what the ordinate-stack mode
  // makes of one datum plus each clicked point (planOrdinateDimension below).
  | { kind: 'ordinate'; origin: PointRef; point: PointRef; axis: 'x' | 'y'; value: number }
  | { kind: 'distancePL'; point: PointRef; line: string; value: number }
  // SKC-58B: `reverseB` rides the plan so the anchor's far/obtuse sector pick
  // (selectAngleSector) reaches the committed AngleDimension through the
  // `...placement.plan` spread -- the near sector omits it (false).
  | { kind: 'angle'; a: string; b: string; value: number; reverseB?: boolean }
  // WO-1868: three point sites (vertex first), or one arc's (center, start, end)
  // with `ccw` set. Sector orientation rides the plan exactly like 'angle'.
  | { kind: 'angle3'; vertex: PointRef; a: PointRef; b: PointRef; value: number; reverseB?: boolean; ccw?: boolean }
  | { kind: 'radius'; entityId: string; value: number }
  | { kind: 'diameter'; entityId: string; value: number }
  | { kind: 'arcLength'; entityId: string; value: number }
  // majorRadius is the ORIENTATION-BLIND default for a single ellipse (like
  // 'distance' is for two points); resolveDimPlacement rewrites it to
  // minorRadius when the label is pulled toward the minor axis.
  | { kind: 'majorRadius'; entityId: string; value: number }
  | { kind: 'minorRadius'; entityId: string; value: number }
  // Two foci of ONE ellipse -> the inter-focal distance 2c (direct-edit).
  | { kind: 'focusDistance'; entityId: string; value: number }
  // A single CHAMFER LINE -> its d1/d2 setback pair (reference-only,
  // UI-50C); value = d1, d2 = d2. The chamfer-line default (over the
  // generic 'distance'/length every other line gets) fires only when
  // resolveChamferCorner resolves a theoretical corner for it.
  | { kind: 'd1xd2'; entityId: string; value: number; d2: number }

export type DimPlanOutcome =
  | { ok: true; plan: PlannedDimension }
  | {
      ok: false
      reason: string
      /** true = the set is a valid PREFIX (another operand can complete
       *  it); false = no further click can fix it (rejected). */
      incomplete: boolean
    }

/**
 * Infer the dimension for an operand set, per doctrine. Pure function of
 * the CURRENT geometry — the parallel test decides angle-vs-distance for
 * line pairs at inference time.
 *
 * `constraints` is an EXTENSION (optional, defaults to none) needed only to
 * recognize a lone CHAMFER LINE pick (its theoretical-corner lookup walks
 * the coincident/point_on_object graph, UI-50C); every other combination
 * ignores it, so existing entities-only callers are unaffected. A caller
 * that OMITS the parameter entirely (e.g. dimForceFamily's Tab-cycle probe,
 * which is deliberately constraints-blind and untouched by this WO) is not
 * "opting in" to chamfer-identity resolution at all and keeps the
 * unconditional plain-distance default for a lone line, even one carrying
 * chamferSetback identity -- this is distinct from passing an
 * intentionally EMPTY array, which DOES opt in (and, for an
 * identity-bearing line, will correctly refuse by name when the rig is
 * absent from that empty set).
 */
export function planDimension(
  entities: readonly SketchEntity[], operandIds: readonly DimOperandRef[],
  constraints?: readonly SketchConstraint[],
): DimPlanOutcome {
  const constraintsProvided = constraints !== undefined
  const cs = constraints ?? []
  // Classify each operand up front: is it acting as a POINT (an explicitly
  // snapped endpoint/vertex/center/spline-start, or a bare point entity) or as
  // a LINE BODY (a bare line)? The point identity is what turns corner + line
  // into a point-to-line distance instead of an angle.
  interface ClassifiedOp {
    ref: DimOperandRef
    entity: SketchEntity
    /** non-null = this operand is a POINT at this site. */
    point: PointRef | null
    /** true = this operand is a whole LINE body (angle / distancePL target). */
    lineBody: boolean
    /** true = the operand carried an EXPLICIT point site (vs a point entity). */
    explicit: boolean
  }
  const ops: ClassifiedOp[] = []
  for (const ref of operandIds) {
    const id = opEntityId(ref)
    const e = entities.find((x) => x.id === id)
    if (!e) return { ok: false, reason: `unknown entity '${id}'`, incomplete: false }
    const site = opSite(ref)
    let point: PointRef | null = null
    let explicit = false
    if (site != null) {
      // Explicit point pick: honor it only when the site resolves to a REAL
      // coordinate (line start/end, arc/circle center, arc endpoints, spline
      // 'start', point 'self'). A site that cannot resolve (an inert spline
      // through-point has no solver site) degrades to a whole-entity pick.
      // ON-PATH text's anchor resolves (to the ignored free anchor) but a gcs
      // dim on it would not move the visible glyphs -- refuse it here so it is
      // never dimensioned wrong (ADR-0033 root-find is the eventual path).
      const dimmableText = e.kind !== 'text' || e.pathId == null
      if (dimmableText && resolvePoint(entities, { entityId: id, site })) {
        point = { entityId: id, site }
        explicit = true
      }
    }
    let lineBody = false
    if (!point) {
      if (e.kind === 'point') point = { entityId: id, site: 'self' }
      // FREE text picked as a whole entity -> its baseline anchor point (the
      // one gcs point a text carries). On-path text never reaches here (it is
      // unpickable in pickDimOperand).
      else if (e.kind === 'text' && e.pathId == null) point = { entityId: id, site: 'start' }
      else if (e.kind === 'line') lineBody = true
      // SKC-ROTATION-SOLVABLE: a whole block picked as an operand acts as its
      // orientation line -- an angle dimension against it DRIVES the block's
      // solver-owned rotation (gcsMapping resolves it to the block's :orient line).
      else if (e.kind === 'block') lineBody = true
    }
    ops.push({ ref, entity: e, point, lineBody, explicit })
  }

  if (ops.length === 0) {
    return { ok: false, reason: 'click an entity to dimension', incomplete: true }
  }

  if (ops.length === 1) {
    const o = ops[0]
    // An explicitly-picked POINT (or a bare point entity) on its own waits for
    // a partner — a single point cannot dimension. A bare LINE/circle/arc body
    // dimensions on its own (length / diameter / radius).
    if (o.point && (o.explicit || o.entity.kind === 'point')) {
      return { ok: false, reason: 'add a second point or a line', incomplete: true }
    }
    const e = o.entity
    switch (e.kind) {
      case 'line': {
        // A CHAMFER LINE (durable identity, UI-50C-R1 major 1) defaults to
        // its d1/d2 setback pair when its theoretical corner resolves,
        // exactly like a lone arc defaults to radius and a lone ellipse
        // defaults to majorRadius -- an entity-kind (here, entity-CONTEXT)
        // default. Explicitly picking the line's own two endpoints
        // (point+point) still reaches plain 'distance' regardless.
        //
        // The refusal only carries meaning once the system KNOWS the line
        // IS a chamfer: an ORDINARY line (no chamferSetback identity) never
        // calls resolveChamferCorner at all and keeps the unchanged length
        // default below (also a valid prefix: line+line and line+point
        // continue it) -- a hand-drawn or polyline-segment line whose
        // endpoints structurally resemble the rig must not be
        // misdiagnosed. A line that DOES carry chamfer identity but cannot
        // resolve its corner (no-theoretical-corner / parallel-legs) is a
        // NAMED REFUSE reaching the caller here, never a silent distance
        // fallback (the WO's own citation of the acceptance gap).
        if (constraintsProvided && isChamferSetbackLine(e)) {
          const corner = resolveChamferCorner(entities, cs, e.id)
          if (!corner.ok) {
            return { ok: false, incomplete: false,
              reason: `chamfer setback dimension: theoretical corner unresolved (${corner.reason})` }
          }
          const m = measureChamferSetbacks(entities, cs, e.id)
          if (!m) {
            return { ok: false, incomplete: false,
              reason: 'chamfer setback dimension: theoretical corner unresolved (measurement failed)' }
          }
          return { ok: true,
            plan: { kind: 'd1xd2', entityId: e.id, value: m.d1, d2: m.d2 } }
        }
        return { ok: true, plan: { kind: 'distance', // length = distance between its own endpoints
          a: { entityId: e.id, site: 'start' },
          b: { entityId: e.id, site: 'end' },
          value: dist(e.start, e.end) } }
      }
      case 'circle':
        return { ok: true, plan: { kind: 'diameter', entityId: e.id, value: e.radius * 2 } }
      case 'arc':
        return { ok: true, plan: { kind: 'radius', entityId: e.id, value: e.radius } }
      case 'ellipse':
      case 'elliptical-arc':
        // Single ellipse -> a major/minor radius dim. Default to majorRadius
        // (orientation-blind); resolveDimPlacement switches to minorRadius when
        // the label is dragged toward the minor axis (major-vs-minor pick UX).
        return { ok: true, plan: { kind: 'majorRadius', entityId: e.id, value: e.majorRadius } }
      default:
        return { ok: false, reason: 'add a second point or a line', incomplete: true }
    }
  }

  if (ops.length === 2) {
    const [a, b] = ops

    // Two FOCI of the SAME ellipse -> the focus-to-focus (2c) dimension, a
    // DIRECT-EDIT that resizes the ellipse (checked BEFORE the generic two-point
    // distance below, which would otherwise measure the same pair as an inert
    // distance). Two foci of DIFFERENT ellipses, or a focus + any other point,
    // fall through to that generic path unchanged.
    if (a.point && b.point &&
        a.point.entityId === b.point.entityId &&
        isFocusSite(a.point.site) && isFocusSite(b.point.site) &&
        a.point.site !== b.point.site) {
      const e = a.entity
      if (e.kind === 'ellipse' || e.kind === 'elliptical-arc') {
        return { ok: true, plan: { kind: 'focusDistance', entityId: e.id,
          value: dist(ellipseFocusSite(e, 'focus1'), ellipseFocusSite(e, 'focus2')) } }
      }
    }

    // Two POINTS (explicit endpoints/vertices/centers, or bare point entities)
    // -> straight distance between them.
    if (a.point && b.point) {
      if (a.point.entityId === b.point.entityId && a.point.site === b.point.site) {
        return { ok: false, incomplete: false,
          reason: 'pick two different points to dimension a distance' }
      }
      const pa = resolvePoint(entities, a.point)
      const pb = resolvePoint(entities, b.point)
      if (!pa || !pb) {
        return { ok: false, incomplete: false, reason: 'a picked point has no position' }
      }
      return { ok: true, plan: { kind: 'distance',
        a: a.point, b: b.point, value: dist(pa, pb) } }
    }

    // POINT (explicit endpoint / vertex / center, or point entity) + LINE body
    // -> perpendicular point-to-line distance (distancePL). This is the fix:
    // an explicitly-snapped corner + a line measures the offset, not an angle.
    const pt = a.point ? a : b.point ? b : null
    const lnBody = a.lineBody ? a : b.lineBody ? b : null
    if (pt && lnBody && pt !== lnBody && pt.point) {
      const line = lnBody.entity
      if (line.kind === 'line') {
        // Same-line degenerate guard: the picked endpoint lies ON the very line
        // being measured -> the distance is identically zero (and solver
        // singular). Reject with a reason rather than emit a useless dim.
        if (pt.point.entityId === line.id) {
          return { ok: false, incomplete: false,
            reason: 'that point lies on the line - pick a different line to measure to' }
        }
        const p = resolvePoint(entities, pt.point)
        if (!p) return { ok: false, incomplete: false, reason: 'a picked point has no position' }
        return { ok: true, plan: { kind: 'distancePL',
          point: pt.point, line: line.id, value: pointLineDistance(p, line) } }
      }
    }

    // Two LINE BODIES -> angle, or perpendicular distance when parallel.
    // A block operand contributes its orientation line (SKC-ROTATION-SOLVABLE):
    // a pair involving a block is ALWAYS an angle (a block has no perpendicular-
    // distance meaning), and its direction comes from angleOperandSegment.
    if (a.lineBody && b.lineBody) {
      const la = a.entity, lb = b.entity
      const segA = angleOperandSegment(la)
      const segB = angleOperandSegment(lb)
      const eitherBlock = la.kind === 'block' || lb.kind === 'block'
      if (eitherBlock && segA && segB) {
        return { ok: true, plan: { kind: 'angle', a: la.id, b: lb.id, value: lineAngle(segA, segB) } }
      }
      if (la.kind === 'line' && lb.kind === 'line') {
        if (linesParallel(la, lb)) {
          // The injected axes are deliberately 200,000 mm long. Persisting an
          // axis endpoint as the point operand makes the solver value correct,
          // but makes the renderer draw witness lines from that remote endpoint
          // into an ordinary sketch. Normalize the order so the finite user
          // line supplies the point and the axis remains the infinite-line
          // target, regardless of click order.
          const laIsAxis = la.id === SKETCH_AXIS_X_ENTITY_ID ||
            la.id === SKETCH_AXIS_Y_ENTITY_ID
          const lbIsAxis = lb.id === SKETCH_AXIS_X_ENTITY_ID ||
            lb.id === SKETCH_AXIS_Y_ENTITY_ID
          const pointLine = laIsAxis && !lbIsAxis ? lb : la
          const targetLine = pointLine === la ? lb : la
          const point: PointRef = { entityId: pointLine.id, site: 'start' }
          return { ok: true, plan: { kind: 'distancePL', point, line: targetLine.id,
            value: pointLineDistance(pointLine.start, targetLine) } }
        }
        return { ok: true, plan: { kind: 'angle', a: la.id, b: lb.id,
          value: lineAngle(la, lb) } }
      }
    }

    // An ARC picked twice (its whole body both times) -> its INCLUDED angle: the
    // three-point angle at the arc's own (center, start, end) sites, read as the
    // counter-clockwise sweep (WO-1868 -- one mechanism for both).
    if (a.entity.kind === 'arc' && b.entity.id === a.entity.id && !a.point && !b.point) {
      const arc = a.entity
      return { ok: true, plan: { kind: 'angle3',
        vertex: { entityId: arc.id, site: 'center' },
        a: { entityId: arc.id, site: 'start' },
        b: { entityId: arc.id, site: 'end' },
        value: positiveArcSweep(arc.startAngle, arc.endAngle), ccw: true } }
    }

    return { ok: false, incomplete: false,
      reason: `cannot dimension ${a.entity.kind} + ${b.entity.kind} ` +
        '(use line, two lines, circle, arc, two points, or point + line)' }
  }

  // THREE POINT sites -> the angle at the FIRST pick (the vertex) between the
  // directions to the second and third (WO-1868). The legs are only directions:
  // any addressable point sites work, no whole line entity is needed. The
  // near/far sector is chosen later, by the placement click.
  if (ops.length === 3 && ops.every((o) => o.point)) {
    const [v, a, b] = ops.map((o) => o.point!)
    const same = (p: PointRef, q: PointRef) => p.entityId === q.entityId && p.site === q.site
    if (same(v, a) || same(v, b) || same(a, b)) {
      return { ok: false, incomplete: false,
        reason: 'pick three different points: the vertex, then a point on each leg' }
    }
    const theta = angle3Theta(entities, { vertex: v, a, b })
    if (theta === null) {
      return { ok: false, incomplete: false,
        reason: 'a leg has no length - the vertex and a leg point are at the same spot' }
    }
    const pv = resolvePoint(entities, v)!, pa = resolvePoint(entities, a)!, pb = resolvePoint(entities, b)!
    if (!lineLineIntersection({ start: pv, end: pa }, { start: pv, end: pb })) {
      return { ok: false, incomplete: false,
        reason: 'the two legs lie along one line - there is no angle to dimension' }
    }
    return { ok: true, plan: { kind: 'angle3', vertex: v, a, b, value: theta } }
  }

  return { ok: false, reason: 'too many operands - place or press Esc', incomplete: false }
}

/**
 * The POINT SITE an operand acts as for an ordinate stack, or null when the
 * operand names no single point. An explicit snap keeps its own site; a bare
 * point entity is its own location; a bare circle or arc is its center (its
 * only unambiguous point, the same implied-point rule the constraint buttons
 * use). A line BODY has no unambiguous point -- start/end/center would be a
 * guess -- so it returns null and the gesture is simply not offered for it.
 */
export function ordinatePointRef(
  entities: readonly SketchEntity[], op: DimOperandRef,
): PointRef | null {
  const id = opEntityId(op)
  const site = opSite(op)
  if (site != null) {
    const ref: PointRef = { entityId: id, site }
    return resolvePoint(entities, ref) ? ref : null
  }
  const e = entities.find((candidate) => candidate.id === id)
  if (!e) return null
  if (e.kind === 'point') return { entityId: id, site: 'self' }
  if (e.kind === 'circle' || e.kind === 'arc') return { entityId: id, site: 'center' }
  return null
}

/** Which existing Tab-cycle family is reachable for the current operands.
 *  Only a single bare circular Arc can reach the arc family. A Circle,
 *  elliptical-arc, line, point, or any malformed combination returns null,
 *  proving arcLength is unreachable through the gesture for those shapes.
 *
 *  WO-1867 adds the ORDINATE family: ONE explicitly SNAPPED point (a vertex,
 *  a point entity's own site, a circle/arc center snap) can become a stack
 *  DATUM. A whole-entity pick (a bare circle outline, a bare point entity id)
 *  keeps exactly the family it had before -- null -- so the UI-50B census is
 *  unchanged (architect re-scope 2026-09-23). Checked AFTER the arc family so
 *  a lone arc keeps its established arc-length cycle. */
export function dimForceFamily(
  entities: readonly SketchEntity[], operandIds: readonly DimOperandRef[],
): 'linear' | 'arc' | 'ordinate' | null {
  if (operandIds.length === 1 && typeof operandIds[0] === 'string') {
    const e = entities.find((candidate) => candidate.id === operandIds[0])
    if (e?.kind === 'arc') return 'arc'
  }
  const out = planDimension(entities, operandIds)
  if (out.ok && out.plan.kind === 'distance') return 'linear'
  if (operandIds.length === 1 && opSite(operandIds[0]) != null &&
    ordinatePointRef(entities, operandIds[0])) return 'ordinate'
  return null
}

// ---- Picking ---------------------------------------------------------------

/**
 * Entity under the cursor for operand accumulation, or null (= empty
 * space, the placement click). Point entities win over curves within
 * tolerance — they usually sit ON other geometry and would be
 * unreachable otherwise (mirrors the viewport's pick priority).
 */
export function pickDimOperand(
  entities: readonly SketchEntity[], world: Vec2, tol: number,
): string | null {
  let bestPoint: { id: string; d: number } | null = null
  let bestCurve: { id: string; d: number } | null = null
  for (const e of entities) {
    if (e.kind === 'point') {
      const d = dist(world, e.at)
      if (d <= tol && (!bestPoint || d < bestPoint.d)) bestPoint = { id: e.id, d }
      continue
    }
    // FREE text is dimmable by its anchor (site 'start'): a H/V position dim
    // on that gcs point moves the text. The PICK target is the whole text
    // BOX (the big target from the 8e2f834 pick fix), but the operand
    // resolves to the baseline anchor in classifyOperands. ON-PATH text is
    // NOT dimmable here -- its anchor is the ignored free anchor, so a gcs
    // dim would not move the visible glyphs (that needs the ADR-0033
    // sketch-level along-arc root-find, a separate item); it falls to the
    // Infinity curve branch below (unpickable) rather than dimension wrong.
    if (e.kind === 'text' && e.pathId == null) {
      const dText = e.fontStyle === 'outline'
        ? distanceToOutlineTextBBox(e.text, e.height, e.at, e.rotation ?? 0, world, e.fontFamily)
        : distanceToTextBBox(e.text, e.height, e.at, e.rotation ?? 0, world)
      if (dText <= tol && (!bestPoint || dText < bestPoint.d)) bestPoint = { id: e.id, d: dText }
      continue
    }
    let d: number
    switch (e.kind) {
      case 'line':
        d = segDistance(world, e.start, e.end)
        break
      case 'circle':
        d = Math.abs(dist(world, e.center) - e.radius)
        break
      case 'arc':
        d = arcDistance(world, e)
        break
      case 'ellipse':
        // Distance to the ellipse OUTLINE so a single ellipse is pickable as a
        // dim operand (-> major/minor radius). Mirrors circle/arc's outline hit.
        d = nearestPointOnEllipse(e, world).dist
        break
      case 'elliptical-arc':
        d = distanceToEllipticalArc(e, e.startParam, e.endParam, world)
        break
      case 'spline':
      case 'text':
      case 'block':
        // v1: no spline/text/block CURVE dimension kind. Not pickable for
        // curve-dimensioning (a block is dimensioned via its origin point).
        d = Infinity
        break
    }
    if (d <= tol && (!bestCurve || d < bestCurve.d)) bestCurve = { id: e.id, d }
  }
  return bestPoint?.id ?? bestCurve?.id ?? null
}

type DimCenterPick =
  | { kind: 'none' }
  | { kind: 'hit'; operand: DimOperand }
  | { kind: 'ambiguous' }

/** Typed center-site operand under the cursor. Ordinary persisted point
 * entities retain priority when they coincide with a derived center node.
 * Multiple qualifying centers refuse under the same rule as SketchLayer
 * instead of choosing whichever owner appears first in the document. */
function pickDimCenterOperand(
  entities: readonly SketchEntity[],
  world: Vec2,
  tol: number,
  includeLineCenters: boolean,
): DimCenterPick {
  if (entities.some((e) => e.kind === 'point' && dist(world, e.at) <= tol)) {
    return { kind: 'none' }
  }
  const candidates: DimOperand[] = []
  for (const entity of entities) {
    if (entity.kind === 'line' && !includeLineCenters) continue
    const center = centerPointForEntity(entity)
    if (!center) continue
    const d = dist(world, center)
    if (d <= tol) candidates.push({ entityId: entity.id, site: 'center' })
  }
  if (candidates.length === 0) return { kind: 'none' }
  if (candidates.length === 1) return { kind: 'hit', operand: candidates[0] }
  return { kind: 'ambiguous' }
}

function segDistance(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x, dy = b.y - a.y
  const len2 = dx * dx + dy * dy
  let t = len2 > 0 ? ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2 : 0
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy))
}

function arcDistance(p: Vec2, e: Extract<SketchEntity, { kind: 'arc' }>): number {
  const ang = Math.atan2(p.y - e.center.y, p.x - e.center.x)
  let sweep = e.endAngle - e.startAngle
  while (sweep <= 0) sweep += Math.PI * 2
  let rel = ang - e.startAngle
  while (rel < 0) rel += Math.PI * 2
  if (rel <= sweep) return Math.abs(dist(p, e.center) - e.radius)
  const s = { x: e.center.x + e.radius * Math.cos(e.startAngle),
              y: e.center.y + e.radius * Math.sin(e.startAngle) }
  const en = { x: e.center.x + e.radius * Math.cos(e.endAngle),
               y: e.center.y + e.radius * Math.sin(e.endAngle) }
  return Math.min(dist(p, s), dist(p, en))
}

// ---- Click behavior ----------------------------------------------------------

export interface DimClickOutcome {
  chain: DimChainState | null
  /** Dimension to commit (the placement click in empty space). Driving,
   *  value = measured, labelAnchor = the click point. */
  dimension: SketchDimension | null
  /** Rejection reason for the store's notice — never a silent no-op. */
  notice: string | null
}

/**
 * CLICK(p) for the armed smart-dimension tool:
 *   - click on an entity: accumulate it into the operand set (rejected
 *     with a named reason when the combination can never dimension)
 *   - click in EMPTY space with a valid operand set: commit the inferred
 *     dimension; the click point becomes the stored label anchor
 *   - click in empty space with an incomplete set: notice, set kept
 *   - Esc clears the operand set (handled by the generic machine ESC)
 */
export function dimToolClick(
  chain: DimChainState | null,
  world: Vec2,
  tol: number,
  entities: readonly SketchEntity[],
  newId: () => string,
  /** The point the cursor SNAPPED to when the store's snap engine resolved a
   *  real point SITE (endpoint / vertex / center / spline-start). When this
   *  sits under the click, the operand is recorded as that explicit POINT (so
   *  a corner + a line becomes a point-to-line distance, not an angle).
   *  Explicit null is the real interactive "no point snap" path and keeps
   *  visible line-center markers addressable. Omitted undefined preserves the
   *  legacy programmatic whole-line midpoint behavior for direct callers. */
  explicit?: { point: Vec2; ref: PointRef } | null,
  /** EXTENSION (optional, defaults to none): needed only to recognize a lone
   *  CHAMFER LINE pick (UI-50C d1xd2); every other pick ignores it. */
  constraints: readonly SketchConstraint[] = [],
  /** Whether visible line-center markers are addressable dim operands
   *  (SKC-62 repair 3: true exactly when entity snapping is disabled).
   *  When absent, falls back to the explicit===null heuristic so direct
   *  callers keep their established behavior. */
  lineCentersAddressable?: boolean,
): DimClickOutcome {
  const ops = chain?.operandIds ?? []
  // Enlarge the operand hit radius once at least one operand is picked, so the
  // second pick on a thin line lands instead of slipping into placement.
  const operandTol = ops.length > 0 ? tol * OPERAND_PICK_SCALE : tol
  // Honor an explicit snapped point when it sits under the click (the snap
  // radius is slightly wider than the pick radius, so gate on the enlarged
  // operand tolerance — a snap the user aimed at is always within it).
  const explicitRef: PointRef | null =
    explicit && explicit.ref && dist(explicit.point, world) <= tol * OPERAND_PICK_SCALE
      ? explicit.ref
      : null
  let explicitOp: DimOperand | null = explicitRef
    ? { entityId: explicitRef.entityId, site: explicitRef.site }
    : null
  // SKC-75: an explicit vertex snap on a FILLET-TRIMMED line endpoint
  // redirects the operand to the theoretical (untrimmed) corner's phantom
  // point instead of the trimmed site, so a NEW dimension placed on a
  // filleted corner measures the ORIGINAL corner-to-corner span the fillet
  // cut into -- not the shortened straight segment (Operator's report: driving
  // that span keeps the rectangle's outer size fixed while the fillet grows
  // or shrinks). Only 'start'/'end' line sites can be fillet-trimmed.
  // detected===false (the overwhelming majority: an ordinary vertex) leaves
  // explicitOp untouched; detected===true but unresolved FAILS LOUD
  // (ADR-0003) rather than silently keeping the trimmed site.
  if (explicitRef && (explicitRef.site === 'start' || explicitRef.site === 'end')) {
    const detection = resolveFilletCornerSite(entities, constraints, explicitRef.entityId, explicitRef.site)
    if (detection.detected) {
      if (!detection.ok) {
        return { chain, dimension: null,
          notice: `Smart dimension: fillet theoretical corner unresolved (${detection.reason})` }
      }
      explicitOp = {
        entityId: detection.corner.phantomRef.entityId,
        site: detection.corner.phantomRef.site,
      }
    }
  }
  const centerPick: DimCenterPick = explicitOp
    ? { kind: 'hit', operand: explicitOp }
    : pickDimCenterOperand(entities, world, operandTol,
        lineCentersAddressable ?? (explicit === null))
  if (centerPick.kind === 'ambiguous') {
    return {
      chain,
      dimension: null,
      notice: 'Smart dimension: more than one center is under the cursor - zoom in or separate the geometry',
    }
  }
  const centerOp = centerPick.kind === 'hit' ? centerPick.operand : null
  const hitId = centerOp?.entityId ?? pickDimOperand(entities, world, operandTol)

  // ---- WO-1867: the ORDINATE stack -----------------------------------------
  // In an ordinate mode the chain's single operand is the stack's DATUM and
  // every following point click drops ONE ordinate from it, then RE-ARMS with
  // the same datum -- that is the "pick an origin, then pick any number of
  // points" flow, and it needs no new chain field and no tool-machine change
  // (a click may return a dimension AND keep its chain). Runs before the
  // ordinary accumulate/placement paths below because in this mode a click on
  // an entity commits rather than accumulating.
  const ordinateAxis = ordinateForceAxis(chain?.forceMode ?? null)
  if (ordinateAxis && ops.length === 1) {
    const originRef = ordinatePointRef(entities, ops[0])
    const originAt = originRef ? resolvePoint(entities, originRef) : null
    if (!originRef || !originAt) {
      // The gesture is only offered for a resolvable datum, so this is a
      // document that changed under an armed stack. Say so instead of
      // silently dropping back to another dimension kind (ADR-0003).
      return { chain: null, dimension: null,
        notice: 'Ordinate: the datum point is no longer there - pick a new one' }
    }
    if (!hitId) {
      return { chain, dimension: null,
        notice: 'Ordinate: click a point to dimension from the datum, or press Esc to finish' }
    }
    const pointRef = ordinatePointRef(entities, centerOp ?? hitId)
    const pointAt = pointRef ? resolvePoint(entities, pointRef) : null
    if (!pointRef || !pointAt) {
      return { chain, dimension: null,
        notice: 'Ordinate: pick a point, a circle or an arc center to measure from the datum' }
    }
    if (pointRef.entityId === originRef.entityId && pointRef.site === originRef.site) {
      return { chain, dimension: null,
        notice: 'Ordinate: that is the datum itself - pick another point' }
    }
    const value = ordinateAxis === 'x' ? pointAt.x - originAt.x : pointAt.y - originAt.y
    return {
      // The datum stays armed: the next click is the next ordinate of the
      // SAME stack, which is what makes a hole pattern one gesture.
      chain: { kind: 'dim', operandIds: [ops[0]], forceMode: chain?.forceMode ?? null },
      dimension: {
        kind: 'ordinate', id: newId(), driving: true, value,
        origin: originRef, point: pointRef, axis: ordinateAxis,
        // The stack's common witness line is derived from the DATUM alone, so
        // every ordinate of this stack lands on it without looking at its
        // siblings (dimPlacement.ordinateStackAnchor).
        labelAnchor: ordinateStackAnchor(originAt, pointAt, ordinateAxis),
      },
      notice: null,
    }
  }

  if (hitId) {
    const candSite = centerOp ? centerOp.site : null
    const dup = ops.find((o) => opEntityId(o) === hitId)
    if (dup) {
      // Same entity already picked. EXCEPTION: two DISTINCT foci of ONE ellipse
      // are legitimately different points (they drive the focus-to-focus 2c
      // dimension), so a second, DIFFERENT focus SITE on the same ellipse is let
      // through to planDimension; every other same-entity re-pick is still
      // rejected. Feedback instead of a silent swallow (ADR-0003) — and the
      // "corner + its OWN line body" degenerate is caught downstream by
      // planDimension's point-lies-on-the-line guard.
      const bothFoci = isFocusSite(candSite) && isFocusSite(opSite(dup)) &&
        candSite !== opSite(dup)
      // WO-1868: a three-point angle's sites often share ONE entity (a line's two
      // ends, an arc's center and end), so a different explicit SITE of an
      // already-picked entity is a new point, not a repeat; and an ARC picked a
      // second time (whole body) asks for its included angle.
      const otherSite = candSite !== null && ops.every((o) =>
        opEntityId(o) !== hitId || (opSite(o) !== null && opSite(o) !== candSite))
      const arcTwice = candSite === null && ops.length === 1 && typeof ops[0] === 'string' &&
        entities.find((e) => e.id === hitId)?.kind === 'arc'
      if (!bothFoci && !otherSite && !arcTwice) {
        return { chain, dimension: null,
          notice: 'Smart dimension: that entity is already picked' }
      }
    }
    const candidate: DimOperandRef[] = [...ops, centerOp ?? hitId]
    const out = planDimension(entities, candidate, constraints)
    if (out.ok || out.incomplete) {
      // Carry the Tab-forced orientation forward as operands accumulate.
      // Only attach forceMode when actually forced, so the default (auto)
      // chain stays a bare { kind, operandIds }.
      const fm = chain?.forceMode ?? null
      const next: DimChainState = fm
        ? { kind: 'dim', operandIds: candidate, forceMode: fm }
        : { kind: 'dim', operandIds: candidate }
      return { chain: next, dimension: null, notice: null }
    }
    return { chain, dimension: null, notice: `Smart dimension: ${out.reason}` }
  }

  // Empty space: placement (or an idle click when nothing is selected yet).
  if (ops.length === 0) return { chain, dimension: null, notice: null }

  // Near-miss guard: the click landed close to an UNPICKED entity (within a
  // generous margin) but outside the operand hit radius. The user was aiming
  // at that entity, not placing -- stay armed and hint, never commit a
  // one-operand dim by accident. A click near an already-picked operand falls
  // through to commit (placing the label close to the measured geometry).
  const nearId = pickDimOperand(entities, world, tol * PLACEMENT_MARGIN_SCALE)
  if (nearId && !ops.some((o) => opEntityId(o) === nearId)) {
    return { chain, dimension: null,
      notice: 'Smart dimension: pick the second entity, or click in open space to place' }
  }

  const out = planDimension(entities, ops, constraints)
  if (!out.ok) {
    return { chain, dimension: null, notice: `Smart dimension: ${out.reason}` }
  }
  // The placement resolver picks the orientation (aligned / horizontal /
  // vertical) from the drag vector -- unless Tab forced one -- and is the
  // SAME function the live preview uses, so the dropped dimension matches
  // what was previewed. out.ok guarantees a non-null result here.
  const placement = resolveDimPlacement(entities, ops, world,
    { forceOrientation: chain?.forceMode ?? null, clampInitial: true }, constraints)!
  const dimension: SketchDimension = {
    ...placement.plan,
    id: newId(),
    // A freshly placed d1xd2 lands as a REFERENCE (WO-1858 decision): the
    // chamfer tool already gives every corner it cuts two DRIVING setback
    // distance dimensions, so an auto-driving pair would be redundant with
    // them on the common corner and the placement's own verdict solve would
    // throw it straight back out. The operator flips the toggle to drive it,
    // which is accepted now. Every other kind keeps driving-on-commit.
    driving: placement.plan.kind !== 'd1xd2',
    value: placement.value,
    labelAnchor: placement.labelAnchor,
  }
  return { chain: null, dimension, notice: null }
}

// ---- Cursor preview ----------------------------------------------------------

export interface DimPreview {
  /** Label text beside the cursor (measured value, or the hint). */
  text: string
  /** true = incomplete-set hint (styled differently from a value). */
  hint: boolean
  /** Human MODE label for the resolved orientation (Aligned / Horizontal /
   *  Vertical / Perpendicular / Radius / Diameter / Angle), or null in the
   *  hint state (no valid dimension yet). */
  mode: DimModeLabel | null
  /** Show the "Tab: H / V / Aligned" affordance — LINEAR family only (the
   *  only kinds Tab cycles). Never set for perpendicular/radius/diameter/angle. */
  showTabHint: boolean
}

/** Live preview of the inferred dimension for the current operand set, or
 *  null when the tool has no operands yet. When a live `cursor` is supplied
 *  the value AND mode are driven by resolveDimPlacement — the SAME resolver
 *  the witness lines and the commit use — so the shown value/mode reflect the
 *  ACTUAL resolved orientation (including a Tab-forced one) and match what
 *  lands on click (preview === commit). Without a cursor (before the first
 *  pointermove) it falls back to the orientation-blind plan so a value/hint
 *  still appears. `units` formats the value at the display edge (mm = identity).
 *  `forceMode` overrides chain.forceMode when provided (the store may carry the
 *  Tab state separately); otherwise chain.forceMode is honored. */
export function dimPreview(
  entities: readonly SketchEntity[], chain: DimChainState | null,
  units: Units = 'mm',
  cursor: Vec2 | null = null,
  forceMode: DimForceMode | null | undefined = undefined,
  /** EXTENSION (optional, defaults to none): needed only to recognize a lone
   *  CHAMFER LINE operand (UI-50C d1xd2); every other operand set ignores it. */
  constraints: readonly SketchConstraint[] = [],
): DimPreview | null {
  if (!chain || chain.operandIds.length === 0) return null
  const force: DimForceMode | null =
    (forceMode !== undefined ? forceMode : chain.forceMode) ?? null

  // WO-1867: with an ordinate stack armed, the next click drops an ordinate
  // from the datum -- it does not complete a two-operand pick. Without this the
  // preview showed the generic "pick a second entity" hint, which names the
  // wrong gesture. Show the live measured offset the click would commit
  // (resolveDimPlacement cannot: it plans from an operand SET, and an armed
  // stack is one operand plus a cursor).
  const armedAxis = ordinateForceAxis(force)
  if (armedAxis && chain.operandIds.length === 1) {
    const originRef = ordinatePointRef(entities, chain.operandIds[0])
    const originAt = originRef ? resolvePoint(entities, originRef) : null
    const mode: DimModeLabel | null = originAt ? 'Ordinate' : null
    if (!originAt) {
      return { text: 'the ordinate datum is no longer there', hint: true, mode, showTabHint: false }
    }
    if (!cursor) {
      return { text: `ordinate ${armedAxis.toUpperCase()}: click a point`,
        hint: true, mode, showTabHint: true }
    }
    const offset = armedAxis === 'x' ? cursor.x - originAt.x : cursor.y - originAt.y
    return { text: formatDimensionValue('ordinate', offset, true, units),
      hint: false, mode, showTabHint: true }
  }

  // Live cursor: resolve the ACTUAL orientation/kind (same fn the witness
  // lines + commit use) so value + mode are exactly what will be dropped.
  if (cursor) {
    const placement = resolveDimPlacement(entities, chain.operandIds, cursor,
      { forceOrientation: force, clampInitial: true }, constraints)
    if (placement) {
      return {
        text: placement.plan.kind === 'd1xd2'
          ? formatChamferSetbackValue(placement.plan.value, placement.plan.d2, true, units)
          : formatDimensionValue(placement.kind, placement.value, true, units),
        hint: false,
        mode: dimModeLabel(placement.kind),
        showTabHint: isDimKindTabCyclable(placement.kind),
      }
    }
    // resolveDimPlacement returned null (incomplete/invalid) -> fall through
    // to the plan-based hint below.
  }

  const out = planDimension(entities, chain.operandIds, constraints)
  if (out.ok) {
    return {
      text: out.plan.kind === 'd1xd2'
        ? formatChamferSetbackValue(out.plan.value, out.plan.d2, true, units)
        : formatDimensionValue(out.plan.kind, out.plan.value, true, units),
      hint: false,
      mode: dimModeLabel(out.plan.kind),
      showTabHint: isDimKindTabCyclable(out.plan.kind),
    }
  }
  return { text: out.reason, hint: true, mode: null, showTabHint: false }
}
