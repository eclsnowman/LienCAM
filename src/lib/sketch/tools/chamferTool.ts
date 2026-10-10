// Sketch chamfer tool (Tier 3a MODIFY) — the straight-edge sibling of the
// fillet tool (filletTool.ts).
//
// Armed tool with a SETBACK distance input in the toolbox. Click two
// lines — or a SHARED CORNER POINT where two line endpoints meet — and an
// EQUAL-DISTANCE chamfer is cut across the corner:
//   - both lines are trimmed back by the setback distance d FROM the corner
//     along their kept side (equal-distance v1: the same d on both legs)
//   - a straight CHAMFER LINE is inserted joining the two trim points
//   - coincident constraints tie the chamfer line's endpoints to the two
//     moved corner sites (1-for-1 location-exact, exactly like the fillet's
//     joint coincidents — minus the tangent, a chamfer is a straight cut)
//   - the corner's own coincident constraint (the two corner sites) is
//     removed; everything else survives
//   - a setback that does not fit the corner (>= the available leg length)
//     is rejected with a notice naming the maximum usable setback — never a
//     silent no-op
//
// PURE module mirroring filletTool's structure: clicks RETURN the
// replacement document arrays; the store applies them as one undo step.
//
// FORK (v1 scope, ADR-0003): EQUAL-DISTANCE only. Asymmetric two-distance
// chamfers (d1 on leg A, d2 on leg B) and distance-plus-angle chamfers are
// deliberately NOT built here — they need a second input and a kept-leg
// designation in the UI. When added they slot in as new constructors
// beside chamferLines (the chain/preview/apply scaffolding is shared).

import type {
  Vec2,
  PointRef,
  SketchEntity,
  SketchLineEntity,
  SketchConstraint,
  SketchDimension,
} from '../types'
import type { SketchDoc, SketchDocTransform } from './trimTool'
import { buildTheoreticalCorner } from './theoreticalCorner'
import {
  detachProjectedFixes,
  markProjectedGeometryDetached,
  projectedProvenance,
} from '../projectedEdit'
import { classifyChainMax, type ChainMaxResult, type StagedSizeDragRegion } from './stagedSizeDrag'
import { lineAngle } from './dimTool'

const EPS_LEN = 1e-6   // mm: a trimmed line may not collapse below this
const EPS_TOUCH = 1e-6 // mm: two endpoints within this form a corner
// SKC-46-R1 (BLOCKER 1): chamferLines rejects any setback with `setback >= availMin - EPS_LEN`.
// Reserving a margin double that EPS_LEN keeps a seeded ceiling strictly inside the accept region
// -- see the matching filletTool.ts comment (chamfer's setback IS the compared quantity directly,
// no tan() round trip, but the same headroom keeps both tools' ceilings symmetric and safe).
// SKC-46-R2 (named ruling, R1 audit minor, OUT OF SCOPE this round): this fixed 2e-6mm margin is
// sized for machining-scale coordinates (sub-meter parts); it loses meaning as a safety buffer once
// sketch coordinates approach ~1e10mm, where float64 ULP spacing itself exceeds the margin. Left
// unbounded deliberately -- outside any real machining domain -- rather than silently dropped.
const CEILING_MARGIN = 2 * EPS_LEN
const EPS_ANG = 1e-9   // rad: parallel / degenerate angle guard

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

/** Rotate a vector by `angleRad` (counter-clockwise, standard math convention). */
function rotate(v: Vec2, angleRad: number): Vec2 {
  const c = Math.cos(angleRad), s = Math.sin(angleRad)
  return { x: v.x * c - v.y * s, y: v.x * s + v.y * c }
}

/** Infinite-line intersection of the ray p+t*dp with the ray q+s*dq, or null when parallel. */
function raysIntersection(p: Vec2, dp: Vec2, q: Vec2, dq: Vec2): Vec2 | null {
  const denom = dp.x * dq.y - dp.y * dq.x
  if (Math.abs(denom) < 1e-12) return null
  const wx = q.x - p.x, wy = q.y - p.y
  const t = (wx * dq.y - wy * dq.x) / denom
  return { x: p.x + t * dp.x, y: p.y + t * dp.y }
}

// ---- Chain state (CHAINING payload) -----------------------------------------

/** One accumulated corner: the two lines plus the side hints that chose
 *  the kept side of each (the clicks, or the far endpoints for corner /
 *  selection picks). `at` is the corner location (display + dedup). */
/** WO-1570: the chamfer input mode. Absent/'equal' is today's single-setback
 *  chamfer; the other two need a second scalar (d2 or the angle) carried
 *  alongside each staged corner (below) — a batch shares one mode, the
 *  confirm overlay writes it onto every staged corner at once so a mode
 *  switch or Swap never needs a re-pick. */
export type ChamferMode = 'equal' | 'two-distance' | 'distance-angle'

export interface ChamferCornerPick {
  aId: string
  bId: string
  hintA: Vec2
  hintB: Vec2
  at: Vec2
  /** WO-1570. Absent = equal-distance (today's v1 behavior, unchanged). */
  mode?: ChamferMode
  /** WO-1570 two-distance mode: setback on the SECOND leg (aId/bId order,
   *  or swapped below). The first leg's setback is the tool's existing
   *  single `setback` scalar (d1), reused unchanged across all three modes. */
  d2?: number
  /** WO-1570 distance-angle mode: angle in degrees from the first leg to
   *  the chamfer line. */
  angleDeg?: number
  /** WO-1570: exchange which leg is "first" (gets d1 / the distance)
   *  without re-picking the corner. */
  swapped?: boolean
}

export interface ChamferChainState {
  kind: 'chamfer'
  /** Corners accumulated for the batch apply (overlay Apply commits
   *  them ALL as one undo step). */
  corners: ChamferCornerPick[]
  /** Line clicked but not yet paired with a second line. */
  pendingLineId: string | null
  /** Where the pending line was clicked (kept-side hint). */
  pendingClick: Vec2 | null
}

export interface ChamferClickOutcome {
  chain: ChamferChainState | null
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

function pickLine(
  entities: readonly SketchEntity[], world: Vec2, tol: number,
): SketchLineEntity | null {
  let best: { e: SketchLineEntity; d: number } | null = null
  for (const e of entities) {
    if (e.kind !== 'line') continue
    const d = segDistance(world, e.start, e.end)
    if (d <= tol && (!best || d < best.d)) best = { e, d }
  }
  return best?.e ?? null
}

interface Corner {
  a: SketchLineEntity
  b: SketchLineEntity
  /** The shared corner location (the coincident endpoints). */
  at: Vec2
}

/** Shared corner under the cursor: two LINE endpoints (from different
 *  lines) that sit on the same spot within EPS_TOUCH, nearest the click. */
function pickCorner(
  entities: readonly SketchEntity[], world: Vec2, tol: number,
): Corner | null {
  const ends: Array<{ line: SketchLineEntity; p: Vec2 }> = []
  for (const e of entities) {
    if (e.kind !== 'line') continue
    for (const p of [e.start, e.end]) {
      if (dist(p, world) <= tol) ends.push({ line: e, p })
    }
  }
  let best: { corner: Corner; d: number } | null = null
  for (let i = 0; i < ends.length; i++) {
    for (let j = i + 1; j < ends.length; j++) {
      if (ends[i].line.id === ends[j].line.id) continue
      if (dist(ends[i].p, ends[j].p) > EPS_TOUCH) continue
      const d = dist(ends[i].p, world)
      if (!best || d < best.d) {
        best = { corner: { a: ends[i].line, b: ends[j].line, at: ends[i].p }, d }
      }
    }
  }
  return best?.corner ?? null
}

// ---- Chamfer construction ----------------------------------------------------

interface TrimSide {
  line: SketchLineEntity
  /** Unit direction from the corner toward the KEPT side. */
  dir: Vec2
  /** Endpoint that moves to the trim point. */
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

export interface ChamferResult {
  transform: SketchDocTransform
  /** The created chamfer line (the caller may select/highlight it). */
  lineId: string
  /** Construction point at the untrimmed host-line intersection. */
  phantomPointId: string
  /** Driving distance from the phantom to host A's trim site. */
  setbackDimAId: string
  /** Driving dimension B: a second distance (equal/two-distance modes) or
   *  the chamfer-line angle (distance-angle mode, WO-1570). */
  setbackDimBId: string
}

/** Resolve the corner geometry two picks share: both entities are lines,
 *  their infinite-line intersection exists, both kept sides resolve, and
 *  the opening is not collinear. Shared by every chamfer constructor so
 *  the parallel/collinear/corner-side refusal wording never drifts
 *  between equal-distance and the WO-1570 two-distance / distance-angle
 *  modes. Returns a rejection string on failure (same convention as the
 *  constructors themselves). */
function resolveChamferSides(
  doc: SketchDoc, aId: string, bId: string, hintA: Vec2, hintB: Vec2,
): { a: SketchLineEntity; b: SketchLineEntity; C: Vec2; sideA: TrimSide; sideB: TrimSide } | string {
  const a = doc.entities.find((e) => e.id === aId)
  const b = doc.entities.find((e) => e.id === bId)
  if (!a || a.kind !== 'line' || !b || b.kind !== 'line') {
    return 'Chamfer: both picks must be lines'
  }
  const C = lineLineIntersection(a, b)
  if (!C) return 'Chamfer: the lines are parallel - no corner to chamfer'

  const sideA = trimSide(a, C, hintA)
  const sideB = trimSide(b, C, hintB)
  if (!sideA || !sideB) return 'Chamfer: could not resolve the corner sides'

  // Corner opening angle between the two kept directions; a collinear
  // corner (0 or pi) has no wedge to cut.
  const cosT = Math.max(-1, Math.min(1, sideA.dir.x * sideB.dir.x + sideA.dir.y * sideB.dir.y))
  const theta = Math.acos(cosT)
  if (theta <= EPS_ANG || Math.PI - theta <= EPS_ANG) {
    return 'Chamfer: the lines are collinear - no corner to chamfer'
  }
  return { a, b, C, sideA, sideB }
}

/** SIGNED directed angle (radians, atan2(cross, dot) convention, matching
 *  `lineAngle`/`l2l_angle_ll`) from line `a`'s own start->end direction to
 *  the chamfer segment TA->TB — MEASURED from the final geometry (never the
 *  construction angle directly) so the committed angle dimension (operands
 *  a -> the chamfer line, no reverseB) is EXACTLY the quantity the solver's
 *  near-sector l2l_angle_ll constrains, for either draw direction of `a`
 *  (WO-1570 audit FAIL: an unsigned `acos` magnitude contradicted the
 *  directed convention whenever `a` ran toward the corner, dragging the
 *  chamfer off its leg on the very next solve — see
 *  skc58AngleDimNoMotion.test.ts for the same directed-angle no-motion bar
 *  applied to the smart-dimension tool). */
function measureChamferAngle(line: SketchLineEntity, TA: Vec2, TB: Vec2): number {
  return lineAngle(line, { start: TA, end: TB })
}

/** Shared tail: build the chamfer line, its theoretical-corner rig and
 *  driving dimension(s) from already-resolved trim points. `dA`/`dimB` are
 *  taken as literal values (never re-derived via distance() from TA/TB) so
 *  an equal-distance or two-distance chamfer's dimension echoes the exact
 *  input number, not a float that merely rounds to it. */
function buildChamferFromTrimPoints(
  doc: SketchDoc,
  a: SketchLineEntity,
  b: SketchLineEntity,
  sideA: TrimSide,
  sideB: TrimSide,
  C: Vec2,
  TA: Vec2,
  TB: Vec2,
  dA: number,
  dimB: { kind: 'distance'; value: number } | { kind: 'angle'; value: number },
  newId: () => string,
): ChamferResult {
  // The chamfer line runs from A's trim point to B's trim point. Winding
  // is irrelevant for a straight segment (unlike the fillet arc).
  const lineId = newId()
  const chamfer: SketchLineEntity = {
    id: lineId,
    kind: 'line',
    construction: a.construction && b.construction,
    provenance: projectedProvenance(a, b),
    start: TA,
    end: TB,
    // UI-50C-R1 major 1: durable chamfer identity -- see SketchLineEntity's
    // own doc comment. Set HERE ONLY.
    chamferSetback: true,
  }
  const phantomPointId = newId()

  // The corner's own coincident (the two moved sites) is consumed by the
  // chamfer; every other constraint survives.
  const cornerSiteA: PointRef = { entityId: a.id, site: sideA.movedSite }
  const cornerSiteB: PointRef = { entityId: b.id, site: sideB.movedSite }

  // Both joints: location-exact coincident (chamfer start <-> A's moved
  // site, chamfer end <-> B's moved site). No tangent — a chamfer is a
  // straight cut, the corner relationships live on the chamfer line.
  const joints: SketchConstraint[] = [
    { id: newId(), kind: 'coincident',
      a: { entityId: lineId, site: 'start' }, b: cornerSiteA },
    { id: newId(), kind: 'coincident',
      a: { entityId: lineId, site: 'end' }, b: cornerSiteB },
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

  const setbackDimAId = newId()
  const setbackDimBId = newId()
  const setbackDimA: SketchDimension = {
    id: setbackDimAId,
    kind: 'distance',
    /* SKC-41A-MUTATION: setback-a-driving */ driving: true,
    value: dA,
    a: theoretical.phantomRef,
    b: cornerSiteA,
  }
  const setbackDimB: SketchDimension = dimB.kind === 'angle'
    ? {
        id: setbackDimBId,
        kind: 'angle',
        driving: true,
        value: dimB.value,
        a: a.id,
        b: lineId,
      }
    : {
        id: setbackDimBId,
        kind: 'distance',
        /* SKC-41A-MUTATION: setback-b-driving */ driving: true,
        value: dimB.value,
        a: theoretical.phantomRef,
        b: cornerSiteB,
      }

  return {
    transform: {
      entities: markProjectedGeometryDetached(
        doc.entities,
        [...theoretical.entities, chamfer],
        [a.id, b.id],
      ),
      constraints: detachProjectedFixes(doc.entities, [
        ...theoretical.constraints,
        ...joints,
        ...theoretical.pinConstraints,
      ], [a.id, b.id]),
      dimensions: [
        ...doc.dimensions,
        /* SKC-41A-MUTATION: keep-setback-a */ setbackDimA,
        /* SKC-41A-MUTATION: keep-setback-b */ setbackDimB,
      ],
    },
    lineId,
    phantomPointId,
    setbackDimAId,
    setbackDimBId,
  }
}

/**
 * Cut an EQUAL-DISTANCE chamfer of setback `d` at the corner of lines
 * a/b. `hintA`/`hintB` choose the kept side of each line (the clicks, or
 * the far endpoints for a shared-corner click). Returns the transform or a
 * rejection string (parallel / collinear / does not fit, naming the max
 * usable setback).
 */
export function chamferLines(
  doc: SketchDoc,
  aId: string,
  bId: string,
  hintA: Vec2,
  hintB: Vec2,
  setback: number,
  newId: () => string = () => crypto.randomUUID(),
): ChamferResult | string {
  if (!(setback > 0)) return 'Chamfer: setback must be positive'
  const resolved = resolveChamferSides(doc, aId, bId, hintA, hintB)
  if (typeof resolved === 'string') return resolved
  const { a, b, C, sideA, sideB } = resolved

  // Equal-distance fit: the setback must leave a non-zero stub on BOTH
  // legs. The limiting leg sets the max usable setback.
  const availMin = Math.min(sideA.avail, sideB.avail)
  if (setback >= availMin - EPS_LEN) {
    return `Chamfer: setback ${setback} does not fit this corner - max usable setback is ${availMin.toFixed(2)} mm`
  }

  const TA: Vec2 = { x: C.x + sideA.dir.x * setback, y: C.y + sideA.dir.y * setback }
  const TB: Vec2 = { x: C.x + sideB.dir.x * setback, y: C.y + sideB.dir.y * setback }

  return buildChamferFromTrimPoints(
    doc, a, b, sideA, sideB, C, TA, TB, setback, { kind: 'distance', value: setback }, newId,
  )
}

/**
 * WO-1570: cut a TWO-DISTANCE chamfer — `d1` on the first-picked leg (a),
 * `d2` on the second (b), independently. Each leg is checked against its
 * own available length; a refusal names the SPECIFIC leg and its max
 * usable distance.
 */
export function chamferLinesTwoDistance(
  doc: SketchDoc,
  aId: string,
  bId: string,
  hintA: Vec2,
  hintB: Vec2,
  d1: number,
  d2: number,
  newId: () => string = () => crypto.randomUUID(),
): ChamferResult | string {
  if (!(d1 > 0)) return 'Chamfer: d1 must be positive'
  if (!(d2 > 0)) return 'Chamfer: d2 must be positive'
  const resolved = resolveChamferSides(doc, aId, bId, hintA, hintB)
  if (typeof resolved === 'string') return resolved
  const { a, b, C, sideA, sideB } = resolved

  if (d1 >= sideA.avail - EPS_LEN) {
    return `Chamfer: d1 ${d1} does not fit the first leg - max usable d1 is ${sideA.avail.toFixed(2)} mm`
  }
  if (d2 >= sideB.avail - EPS_LEN) {
    return `Chamfer: d2 ${d2} does not fit the second leg - max usable d2 is ${sideB.avail.toFixed(2)} mm`
  }

  const TA: Vec2 = { x: C.x + sideA.dir.x * d1, y: C.y + sideA.dir.y * d1 }
  const TB: Vec2 = { x: C.x + sideB.dir.x * d2, y: C.y + sideB.dir.y * d2 }

  return buildChamferFromTrimPoints(
    doc, a, b, sideA, sideB, C, TA, TB, d1, { kind: 'distance', value: d2 }, newId,
  )
}

/**
 * WO-1570: cut a DISTANCE-AND-ANGLE chamfer — the chamfer line leaves the
 * first-picked leg (a) at distance `d` from the corner, at `angleDeg` to
 * that leg (measured toward the second leg's kept side). The chamfer
 * line's other end is wherever that ray meets the second leg's (infinite)
 * line; a refusal names the max usable DISTANCE at the given angle when
 * that point falls outside the second leg's available length.
 */
export function chamferLinesDistanceAngle(
  doc: SketchDoc,
  aId: string,
  bId: string,
  hintA: Vec2,
  hintB: Vec2,
  d: number,
  angleDeg: number,
  newId: () => string = () => crypto.randomUUID(),
): ChamferResult | string {
  if (!(d > 0)) return 'Chamfer: distance must be positive'
  if (!(angleDeg > 0 && angleDeg < 180)) return 'Chamfer: angle must be between 0 and 180 degrees'
  const resolved = resolveChamferSides(doc, aId, bId, hintA, hintB)
  if (typeof resolved === 'string') return resolved
  const { a, b, C, sideA, sideB } = resolved

  if (d >= sideA.avail - EPS_LEN) {
    return `Chamfer: distance ${d} does not fit the first leg - max usable distance is ${sideA.avail.toFixed(2)} mm`
  }

  // `angleDeg` is the shop-drawing convention: the angle AT the trim point
  // between the leg (pointing back toward the corner, i.e. -sideA.dir) and
  // the chamfer line. Sanity check against the equal-distance case: a
  // square corner cut at equal setbacks makes exactly 45deg with each leg
  // by this definition (the isosceles triangle's base angle) -- rotating
  // sideA.dir itself (the AWAY-from-corner direction) would read 135deg.
  const towardCorner: Vec2 = { x: -sideA.dir.x, y: -sideA.dir.y }
  const cross = towardCorner.x * sideB.dir.y - towardCorner.y * sideB.dir.x
  const sign = cross >= 0 ? 1 : -1
  const angleRad = (angleDeg * Math.PI) / 180
  const dirChamfer = rotate(towardCorner, sign * angleRad)

  const TA: Vec2 = { x: C.x + sideA.dir.x * d, y: C.y + sideA.dir.y * d }
  const TB = raysIntersection(TA, dirChamfer, C, sideB.dir)
  if (!TB) {
    return 'Chamfer: this angle leaves the chamfer line parallel to the second leg - choose a different angle'
  }
  // Distance of TB from the corner along the second leg's kept direction.
  const s = (TB.x - C.x) * sideB.dir.x + (TB.y - C.y) * sideB.dir.y
  if (s <= EPS_LEN) {
    return 'Chamfer: this angle does not reach the second leg - choose a different angle'
  }
  if (s >= sideB.avail - EPS_LEN) {
    // s scales linearly with d at a fixed angle (both TA and the ray
    // direction are affine in d) -- back-solve the usable d from the
    // second leg's own ceiling.
    const maxD = d * ((sideB.avail - CEILING_MARGIN) / s)
    return `Chamfer: distance ${d} at ${angleDeg} deg does not fit the second leg - ` +
      `max usable distance at this angle is ${Math.max(0, maxD).toFixed(2)} mm`
  }

  const measuredAngle = measureChamferAngle(a, TA, TB)
  return buildChamferFromTrimPoints(
    doc, a, b, sideA, sideB, C, TA, TB, d, { kind: 'angle', value: measuredAngle }, newId,
  )
}

// ---- Accumulation helpers -----------------------------------------------------------

/** Kept-side hint for a corner pick: away from the corner = far end. */
function farOf(l: SketchLineEntity, cornerAt: Vec2): Vec2 {
  return dist(l.start, cornerAt) <= dist(l.end, cornerAt) ? l.end : l.start
}

function samePair(c: ChamferCornerPick, aId: string, bId: string): boolean {
  return (c.aId === aId && c.bId === bId) || (c.aId === bId && c.bId === aId)
}

/** WO-1570: a newly-picked corner joining an in-progress batch inherits the
 *  batch's current mode/d2/angle/swap (from the first staged corner) so
 *  chaining several corners mid-session never silently reverts a later
 *  corner to equal-distance. */
function inheritMode(
  corners: readonly ChamferCornerPick[],
): Pick<ChamferCornerPick, 'mode' | 'd2' | 'angleDeg' | 'swapped'> {
  const first = corners[0]
  return first
    ? { mode: first.mode, d2: first.d2, angleDeg: first.angleDeg, swapped: first.swapped }
    : {}
}

// ---- WO-1570: mode / swap edits (pure; the confirm overlay applies these
// to the live chain via a direct store write — see SketchConfirmOverlay.tsx)
// -----------------------------------------------------------------------

/** Set the batch's mode on every staged corner at once (a mode switch mid
 *  batch never needs a re-pick). */
export function chamferSetMode(chain: ChamferChainState, mode: ChamferMode): ChamferChainState {
  return { ...chain, corners: chain.corners.map((c) => ({ ...c, mode })) }
}

/** Two-distance mode: set d2 on every staged corner. */
export function chamferSetD2(chain: ChamferChainState, d2: number): ChamferChainState {
  return { ...chain, corners: chain.corners.map((c) => ({ ...c, d2 })) }
}

/** Distance-angle mode: set the angle (degrees) on every staged corner. */
export function chamferSetAngleDeg(chain: ChamferChainState, angleDeg: number): ChamferChainState {
  return { ...chain, corners: chain.corners.map((c) => ({ ...c, angleDeg })) }
}

/** Swap which leg is "first" (gets d1 / the distance) on every staged
 *  corner, without re-picking. */
export function chamferToggleSwap(chain: ChamferChainState): ChamferChainState {
  return {
    ...chain,
    corners: chain.corners.map((c) => ({ ...c, swapped: !(c.swapped ?? false) })),
  }
}

/** Toggle a resolved corner in/out of the accumulated set. */
function toggleCorner(
  corners: ChamferCornerPick[], pick: ChamferCornerPick,
): ChamferCornerPick[] {
  return corners.some((c) => samePair(c, pick.aId, pick.bId))
    ? corners.filter((c) => !samePair(c, pick.aId, pick.bId))
    : [...corners, pick]
}

/** Corners seeded from a pre-selection: every SHARED CORNER among the
 *  selected lines (two selected-line endpoints within EPS_TOUCH). Side
 *  hints = the far endpoints (the kept sides of a corner pick). */
export function chamferSeedFromSelection(
  entities: readonly SketchEntity[], selectedIds: readonly string[],
): ChamferCornerPick[] {
  const lines = selectedIds
    .map((id) => entities.find((e) => e.id === id))
    .filter((e): e is SketchLineEntity => e !== undefined && e.kind === 'line')
  const corners: ChamferCornerPick[] = []
  for (let i = 0; i < lines.length; i++) {
    for (let j = i + 1; j < lines.length; j++) {
      for (const pa of [lines[i].start, lines[i].end]) {
        for (const pb of [lines[j].start, lines[j].end]) {
          if (dist(pa, pb) > EPS_TOUCH) continue
          if (corners.some((c) => samePair(c, lines[i].id, lines[j].id))) continue
          corners.push({
            aId: lines[i].id, bId: lines[j].id,
            hintA: farOf(lines[i], pa), hintB: farOf(lines[j], pb),
            at: { x: pa.x, y: pa.y },
          })
        }
      }
    }
  }
  return corners
}

// ---- Preview + batch apply ------------------------------------------------------------

export interface ChamferChainPreview {
  /** Chamfer-line segment per RESOLVABLE corner (current setback). */
  lines: Vec2[][]
  /** The same preview lines paired with their theoretical sharp corners.
   *  The shared staged-size gesture consumes these exact rendered paths. */
  dragRegions: StagedSizeDragRegion[]
  /** Corner locations where the setback does NOT fit (skipped on Apply). */
  warnings: Vec2[]
  /** EVERY staged corner location (fit or not) — the viewport marks each
   *  with a selection ring so "which corners are staged" is unmistakable
   *  (Operator's verdict: selected chamfers need the same clear visual element
   *  fillet already has — T-SKC45-CHAMFER, SKC-50). */
  corners: Vec2[]
  fits: number
  misfits: number
}

/** Max setback that fits BOTH lines at one corner (SKC-46 default-derivation clamp), or null when
 *  the corner cannot resolve at all.
 *
 *  SKC-46-R1 (BLOCKER 1): this is the STRICT ceiling `chamferLines` will actually accept, not the
 *  bare geometric max -- reduced by `CEILING_MARGIN` so every value at or below the return here
 *  satisfies `chamferLines`'s own `setback < availMin - EPS_LEN` accept rule with headroom.
 *  Floored at 0 (never negative) so seeding still sees a real number on a corner too small for
 *  ANY margin -- `seedStagedSize` reads a sub-floor value as a refusal. */
export function chamferMaxUsableSetback(
  doc: SketchDoc, aId: string, bId: string, hintA: Vec2, hintB: Vec2,
): number | null {
  const a = doc.entities.find((e) => e.id === aId)
  const b = doc.entities.find((e) => e.id === bId)
  if (!a || a.kind !== 'line' || !b || b.kind !== 'line') return null
  const C = lineLineIntersection(a, b)
  if (!C) return null
  const sideA = trimSide(a, C, hintA)
  const sideB = trimSide(b, C, hintB)
  if (!sideA || !sideB) return null
  const cosT = Math.max(-1, Math.min(1, sideA.dir.x * sideB.dir.x + sideA.dir.y * sideB.dir.y))
  const theta = Math.acos(cosT)
  if (theta <= EPS_ANG || Math.PI - theta <= EPS_ANG) return null
  const availMin = Math.min(sideA.avail, sideB.avail)
  return Math.max(0, availMin - CEILING_MARGIN)
}

/** Max setback that fits EVERY staged corner in the chain (the min across corners), discriminated
 *  by `classifyChainMax` (SKC-46-R2) into no-corner / unresolvable / non-finite / sub-floor /
 *  finite-legal -- see the matching filletTool.ts comment (this is the chain-level function that
 *  knows `corners.length`, so it is the site that distinguishes "no corners staged" from "every
 *  staged corner is unresolvable"). Used to seed/clamp the shared setback scalar for a batch. */
export function chamferChainMaxSetback(chain: ChamferChainState, doc: SketchDoc): ChainMaxResult {
  const perCorner = chain.corners.map(
    (c) => chamferMaxUsableSetback(doc, c.aId, c.bId, c.hintA, c.hintB),
  )
  return classifyChainMax(perCorner)
}

/**
 * Live preview of every accumulated corner at `setback`: a ghost chamfer
 * line per resolvable corner (the SAME chamferLines construction Apply
 * uses — the preview line IS the committed line), a warning marker per
 * corner the setback does not fit. Each corner previews against the
 * pristine document; Apply replays them sequentially, which only differs
 * when two chamfers would overlap on a shared line — those skip at Apply
 * time with a named notice.
 */
// BK-136 (SKC-46 rider): same double-computation bug as filletChainPreview -- the armed hover
// path and the tool-overlay paint both call this with the SAME (chain, doc, setback) on the same
// pointermove tick. Same size-1 memo shape as filletTool.ts (kept as a sibling copy rather than a
// shared helper: the two tools' preview shapes differ and a shared generic would need to know
// both, which is exactly the divergence risk a one-line duplicate avoids).
function shallowArrayEqual<T>(a: readonly T[], b: readonly T[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

let chamferPreviewMemo: {
  chain: ChamferChainState
  doc: SketchDoc
  setback: number
  result: ChamferChainPreview
} | null = null

/** Test seam ONLY (SKC-46, BK-136 mutation proof): how many times the preview was actually
 *  COMPUTED (memo misses), never how many times `chamferChainPreview` was CALLED. Production code
 *  never reads this. */
let chamferPreviewComputeCount = 0
export function __chamferPreviewComputeCount(): number {
  return chamferPreviewComputeCount
}
export function __resetChamferChainPreviewMemo(): void {
  chamferPreviewMemo = null
  chamferPreviewComputeCount = 0
}

export function chamferChainPreview(
  chain: ChamferChainState, doc: SketchDoc, setback: number,
): ChamferChainPreview {
  const memo = chamferPreviewMemo
  if (
    memo && memo.chain === chain && memo.setback === setback &&
    shallowArrayEqual(memo.doc.entities, doc.entities) &&
    shallowArrayEqual(memo.doc.constraints, doc.constraints) &&
    shallowArrayEqual(memo.doc.dimensions, doc.dimensions)
  ) {
    return memo.result
  }
  chamferPreviewComputeCount++
  const result = computeChamferChainPreview(chain, doc, setback)
  chamferPreviewMemo = { chain, doc, setback, result }
  return result
}

/** WO-1570: resolve one staged corner through whichever constructor its
 *  mode names (equal-distance keeps calling `chamferLines` unchanged), with
 *  `swapped` exchanging which pick is "first" (gets d1 / the distance).
 *  Preview-only -- `chamferApplyAll` inlines the same dispatch itself
 *  rather than calling this, so the SKC-46-R2 routing pin (below) can keep
 *  asserting its body's construction path by grepping literal text. */
function resolveCornerForMode(
  doc: SketchDoc, c: ChamferCornerPick, d1: number, newId: () => string,
): ChamferResult | string {
  const swap = c.swapped ?? false
  const aId = swap ? c.bId : c.aId
  const bId = swap ? c.aId : c.bId
  const hintA = swap ? c.hintB : c.hintA
  const hintB = swap ? c.hintA : c.hintB
  const mode = c.mode ?? 'equal'
  if (mode === 'two-distance') {
    return chamferLinesTwoDistance(doc, aId, bId, hintA, hintB, d1, c.d2 ?? d1, newId)
  }
  if (mode === 'distance-angle') {
    return chamferLinesDistanceAngle(doc, aId, bId, hintA, hintB, d1, c.angleDeg ?? 45, newId)
  }
  return chamferLines(doc, aId, bId, hintA, hintB, d1, newId)
}

function computeChamferChainPreview(
  chain: ChamferChainState, doc: SketchDoc, setback: number,
): ChamferChainPreview {
  const lines: Vec2[][] = []
  const dragRegions: StagedSizeDragRegion[] = []
  const warnings: Vec2[] = []
  const corners: Vec2[] = []
  let id = 0
  for (const c of chain.corners) {
    corners.push({ x: c.at.x, y: c.at.y })
    const r = resolveCornerForMode(doc, c, setback, () => `__cp${id++}__`)
    if (typeof r === 'string') {
      warnings.push({ x: c.at.x, y: c.at.y })
      continue
    }
    const ln = r.transform.entities.find(
      (e): e is SketchLineEntity => e.id === r.lineId && e.kind === 'line',
    )
    if (ln) {
      const path = [{ ...ln.start }, { ...ln.end }]
      lines.push(path)
      dragRegions.push({
        corner: { x: c.at.x, y: c.at.y },
        path,
      })
    }
  }
  return { lines, dragRegions, warnings, corners, fits: lines.length, misfits: warnings.length }
}

export interface ChamferApplyResult {
  /** null = no corner could be chamfered (nothing to commit). */
  transform: SketchDocTransform | null
  applied: number
  /** Skipped corners (setback does not fit / sequential overlap), with
   *  the line-pair ids for naming in the flash notice. */
  skipped: Array<{ pick: ChamferCornerPick; reason: string }>
}

/**
 * Apply ALL accumulated corners at `setback`, sequentially against the
 * evolving document (one undo step at the store). Corners that cannot
 * resolve are skipped and reported, never silently dropped.
 */
export function chamferApplyAll(
  doc: SketchDoc,
  corners: readonly ChamferCornerPick[],
  setback: number,
  newId: () => string = () => crypto.randomUUID(),
): ChamferApplyResult {
  let current: SketchDoc = doc
  let applied = 0
  const skipped: ChamferApplyResult['skipped'] = []
  for (const c of corners) {
    // WO-1570: mode dispatch inlined (not routed through a shared helper)
    // so the SKC-46-R2 routing pin below can keep proving, by literal
    // text, that the equal-distance path never bypasses chamferLines.
    const swap = c.swapped ?? false
    const aId = swap ? c.bId : c.aId
    const bId = swap ? c.aId : c.bId
    const hintA = swap ? c.hintB : c.hintA
    const hintB = swap ? c.hintA : c.hintB
    const mode = c.mode ?? 'equal'
    const r = mode === 'two-distance'
      ? chamferLinesTwoDistance(current, aId, bId, hintA, hintB, setback, c.d2 ?? setback, newId)
      : mode === 'distance-angle'
        ? chamferLinesDistanceAngle(current, aId, bId, hintA, hintB, setback, c.angleDeg ?? 45, newId)
        : chamferLines(current, aId, bId, hintA, hintB, setback, newId)
    if (typeof r === 'string') {
      skipped.push({ pick: c, reason: r })
      continue
    }
    current = r.transform
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
 * CLICK(p) for the armed chamfer tool (accumulate-then-confirm flow):
 *   - click a SHARED CORNER (two coincident line endpoints): toggle that
 *     corner in/out of the set (the rectangle-corner gesture)
 *   - click a line, then another line: toggle THEIR corner (each click's
 *     position chooses the kept side -- click the side to keep)
 *   - every resolvable corner shows a live preview line; the confirm
 *     overlay's Apply commits the whole set as one undo step
 *   - empty idle click is quiet; anything else explains itself
 */
export function chamferClick(
  chain: ChamferChainState | null,
  doc: SketchDoc,
  world: Vec2,
  tol: number,
): ChamferClickOutcome {
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
        ...inheritMode(corners),
      })
      return {
        chain: { kind: 'chamfer', corners: next, pendingLineId: null, pendingClick: null },
        notice: null,
      }
    }
  }

  const hit = pickLine(doc.entities, world, tol)
  if (!hit) {
    if (!chain) return { chain: null, notice: null } // quiet idle click
    return {
      chain,
      notice: pendingLineId
        ? 'Chamfer: click the second line of the corner (or Esc to cancel)'
        : 'Chamfer: click more corners - or Apply in the overlay (Enter)',
    }
  }

  // First line of a pair.
  if (!pendingLineId) {
    return {
      chain: {
        kind: 'chamfer', corners,
        pendingLineId: hit.id, pendingClick: { x: world.x, y: world.y },
      },
      notice: null,
    }
  }
  // Re-click on the pending line toggles it back off.
  if (hit.id === pendingLineId) {
    return {
      chain: { kind: 'chamfer', corners, pendingLineId: null, pendingClick: null },
      notice: null,
    }
  }

  // Second line: resolve the pair into a corner (geometry validated by
  // the corner-side resolution; parallel lines are rejected up front).
  const a = doc.entities.find((e) => e.id === pendingLineId)
  if (!a || a.kind !== 'line') {
    return {
      chain: { kind: 'chamfer', corners, pendingLineId: null, pendingClick: null },
      notice: 'Chamfer: the first line is gone - pick again',
    }
  }
  const C = lineLineIntersection(a, hit)
  if (!C) {
    return { chain, notice: 'Chamfer: the lines are parallel - no corner to chamfer' }
  }
  const next = toggleCorner(corners, {
    aId: pendingLineId, bId: hit.id,
    hintA: pendingClick ?? farOf(a, C), hintB: { x: world.x, y: world.y },
    at: C,
    ...inheritMode(corners),
  })
  return {
    chain: { kind: 'chamfer', corners: next, pendingLineId: null, pendingClick: null },
    notice: null,
  }
}
