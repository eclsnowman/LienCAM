// WO SKC-8: relocated from src/components/sketch3dlab/draftEntities.ts (WO INT-2) and now the
// SINGLE shared copy consumed by both the sketch3d lab and the SolidsWorkbenchPage editing
// session's draw tools. sketch3dlab/draftEntities.ts is a thin re-export shim over this file.
//
// Builds a new geometry entity from the draw tool's collected click points. Pure construction
// only - the caller appends the result to the document and runs a solve; nothing here touches the
// solver or auto-constraint inference.
//
// WO SKC-12: this file is also the ONE place sketch3d arc entities are allowed to derive NEW
// angles from raw trigonometry (Math.atan2/circumcenter) -- both construction (makeArcEntity, via
// canonicalArcFromThreePoints) AND mutation (withPointAt's arc branch, via withArcPointAt) route
// through the SAME canonicalArcFromThreePoints helper, so there is nowhere else in the tree a
// second, disagreeing arc-math version could live (src/tests/sketch3d-shared/shareDoNotFork.test.ts
// enforces this with a capability scan, not just a name-match).
import type {
  Sketch3dArcEntity,
  Sketch3dCircleEntity,
  Sketch3dEntity,
  Sketch3dLineEntity,
  Sketch3dPointSite,
  Sketch3dVec2,
} from '../../sketch3d'
import { pointPositionOf } from './picking'

export function makeLineEntity(id: string, start: Sketch3dVec2, end: Sketch3dVec2): Sketch3dLineEntity {
  return { id, kind: 'line', start, end }
}

export function makeCircleEntity(id: string, center: Sketch3dVec2, radiusPoint: Sketch3dVec2): Sketch3dCircleEntity {
  return { id, kind: 'circle', center, radius: Math.hypot(radiusPoint.x - center.x, radiusPoint.y - center.y) }
}

/** WO SKC-8 (A1): rigid kinematic translate of a whole entity by (dx, dy) -- used ONLY for the
 *  select tool's entity-BODY drag (a line grabbed away from either endpoint; see picking.ts's
 *  pickGrabTarget for why circle/arc bodies never need this: their single addressable point IS
 *  their center, so a center-drag through Sketch3dDragSession already translates them rigidly).
 *  Pure/no-solve: the caller applies this per pointer move for live visual feedback, then commits
 *  through the normal document-solve path exactly once on release. */
export function translateEntity(entity: Sketch3dEntity, dx: number, dy: number): Sketch3dEntity {
  switch (entity.kind) {
    case 'point':
      return { ...entity, at: { x: entity.at.x + dx, y: entity.at.y + dy } }
    case 'line':
      return { ...entity, start: { x: entity.start.x + dx, y: entity.start.y + dy }, end: { x: entity.end.x + dx, y: entity.end.y + dy } }
    case 'circle':
      return { ...entity, center: { x: entity.center.x + dx, y: entity.center.y + dy } }
    case 'arc':
      return { ...entity, center: { x: entity.center.x + dx, y: entity.center.y + dy } }
  }
}

const TWO_PI = Math.PI * 2
const COLLINEAR_EPS = 1e-9

/** Circumcenter of 3 points (the unique point equidistant from all 3), via the standard
 *  perpendicular-bisector-intersection determinant formula. Throws if the points are collinear
 *  (or coincident) -- there is no finite circumcenter, and the caller (makeArcEntity) has no
 *  sane fallback to offer the user (an arc through 3 collinear points is a straight line, a
 *  different tool's job). */
function circumcenter(a: Sketch3dVec2, b: Sketch3dVec2, c: Sketch3dVec2): Sketch3dVec2 {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y))
  if (Math.abs(d) < COLLINEAR_EPS) {
    throw new Error('sketch3d 3-point arc: start/end/through points are collinear (or coincident) -- no arc through them')
  }
  const aSq = a.x * a.x + a.y * a.y
  const bSq = b.x * b.x + b.y * b.y
  const cSq = c.x * c.x + c.y * c.y
  const x = (aSq * (b.y - c.y) + bSq * (c.y - a.y) + cSq * (a.y - b.y)) / d
  const y = (aSq * (c.x - b.x) + bSq * (a.x - c.x) + cSq * (b.x - a.x)) / d
  return { x, y }
}

/** WO SKC-12: an arc in canonical-CCW form (mirrors CAM's own `BuiltArc`,
 *  src/lib/sketch/tools/arcTools.ts) plus which angular SITE the first of the two physical
 *  endpoint arguments passed to `canonicalArcFromThreePoints` landed on -- needed by
 *  `withArcPointAt` below to know whether it must swap start/end so the site the caller is
 *  dragging keeps naming the point actually under the cursor. */
export interface Sketch3dBuiltArc {
  center: Sketch3dVec2
  radius: number
  startAngle: number
  endAngle: number
  firstPointSite: 'start' | 'end'
}

/** WO SKC-12 (the canonicalizing arc constructor -- Cut 1 of docs/3d/SKETCH-CONVERGENCE-PLAN.md
 *  Section 8): mirrors CAM's `arcThrough3Points` (arcTools.ts:68-79) EXACTLY -- center/radius from
 *  the circumcircle of the 3 points (so all three are always exactly on the resulting circle,
 *  A6's "all three on the curve"), startAngle/endAngle always the PLAIN principal `atan2` value of
 *  whichever point ends up at that site (never extended outside (-pi, pi], unlike the pre-SKC-12
 *  signed-sweep encoding this replaces). Major vs minor is expressed by WHICH physical point is
 *  assigned to `startAngle` vs `endAngle` -- a swap, never a negative/out-of-range delta -- so
 *  `endAngle - startAngle`'s RAW sign carries no meaning on its own; only `norm(endAngle -
 *  startAngle)` (the CCW sweep) does. This is the ROOT FIX for the arc-drag bug class documented
 *  in SKETCH-CONVERGENCE-PLAN.md Section 2: a `Math.atan2` recompute can never again "overwrite" a
 *  major-arc encoding, because there is no encoding outside what `Math.atan2` already produces. */
export function canonicalArcFromThreePoints(
  start: Sketch3dVec2,
  end: Sketch3dVec2,
  through: Sketch3dVec2,
): Sketch3dBuiltArc {
  const center = circumcenter(start, end, through)
  const radius = Math.hypot(start.x - center.x, start.y - center.y)
  const aStart = Math.atan2(start.y - center.y, start.x - center.x)
  const aEnd = Math.atan2(end.y - center.y, end.x - center.x)
  const aThrough = Math.atan2(through.y - center.y, through.x - center.x)

  // CCW angular distance from `from`, normalized into [0, 2*pi).
  const ccwFrom = (from: number, angle: number): number => (((angle - from) % TWO_PI) + TWO_PI) % TWO_PI

  // Does the direct CCW sweep start->end already pass through `through`? If so, keep start/end as
  // given. Otherwise `through` names the COMPLEMENTARY arc -- represent THAT sweep by swapping
  // which point is the angular start vs end (both remain plain atan2 values; nothing goes outside
  // the principal range), exactly like arcTools.ts's own swap.
  return ccwFrom(aStart, aThrough) <= ccwFrom(aStart, aEnd)
    ? { center, radius, startAngle: aStart, endAngle: aEnd, firstPointSite: 'start' }
    : { center, radius, startAngle: aEnd, endAngle: aStart, firstPointSite: 'end' }
}

/** WO SKC-8 (Operator's BK-71-rider rejection, A2/A6): industry-standard 3-point arc construction --
 *  start, end, then a through-point that disambiguates which of the two arcs between start/end
 *  (minor or major) is meant, exactly like every mainstream CAD sketcher's 3-point arc tool.
 *  REPLACES the old center-start-end construction (WO INT-2), which Operator rejected as "does not
 *  work like any other 3-point arc system I have ever used" and which never guaranteed the third
 *  click actually landed on the resulting arc (it only used that click's ANGLE, discarding its
 *  radius).
 *
 *  WO SKC-12: now a thin wrapper over canonicalArcFromThreePoints -- see that function's header
 *  for the encoding (CAM canonical-CCW, swap-based major/minor, no signed/extended deltas). */
export function makeArcEntity(
  id: string,
  start: Sketch3dVec2,
  end: Sketch3dVec2,
  through: Sketch3dVec2,
): Sketch3dArcEntity {
  const { center, radius, startAngle, endAngle } = canonicalArcFromThreePoints(start, end, through)
  return { id, kind: 'arc', center, radius, startAngle, endAngle }
}

/** WO SKC-12 (item 2 -- the shared point-override primitive, next to the canonicalizing
 *  constructor it reuses): moves ONE addressable point of `entity` to `at`, recomputing whatever
 *  derived fields that implies, WITHOUT touching the solver. This REPLACES
 *  SolidsWorkbenchPage.tsx's former private `withPointAt` (the SolidsWorkbenchPage.tsx:259
 *  `Math.atan2` overwrite + the start-site radius recompute that silently relocated the arc's far
 *  endpoint, both documented in SKETCH-CONVERGENCE-PLAN.md Section 2) -- that fork is deleted;
 *  every point-site drag (workbench AND any future sketch3d-shared consumer) now runs through
 *  here, so there is nowhere else a second version of this math can live. */
export function withPointAt(entity: Sketch3dEntity, site: Sketch3dPointSite, at: Sketch3dVec2): Sketch3dEntity {
  switch (entity.kind) {
    case 'point':
      return { ...entity, at }
    case 'line':
      if (site === 'start') return { ...entity, start: at }
      if (site === 'end') return { ...entity, end: at }
      return entity
    case 'circle':
      return site === 'center' ? { ...entity, center: at } : entity
    case 'arc':
      if (site === 'center') return { ...entity, center: at }
      if (site === 'start' || site === 'end') return withArcPointAt(entity, site, at)
      return entity
  }
}

/** WO SKC-12: the arc-endpoint-drag case of withPointAt. Keeps the OTHER (non-dragged) endpoint's
 *  Cartesian position EXACTLY fixed (mutation-proof test 5c's "start-site drag preserves the far
 *  endpoint") by re-deriving the arc through the SAME canonicalizing 3-point constructor
 *  construction uses -- passing the fixed far endpoint and the entity's OWN current sweep
 *  midpoint (a point already known to lie on the correct side of the chord) as the other two
 *  points. Using the current midpoint as the disambiguator is what keeps a major arc major (test
 *  5b) across a zero-distance drag (the 3 points reconstruct the identical circle, byte-close) and
 *  across a real, non-flipping delta (continuity of the same 3-point construction). Degenerate
 *  drag positions (onto the far point or the center) leave the entity unchanged rather than
 *  throwing out of a live pointer-move handler. */
function withArcPointAt(entity: Sketch3dArcEntity, site: 'start' | 'end', at: Sketch3dVec2): Sketch3dArcEntity {
  const farSite: 'start' | 'end' = site === 'start' ? 'end' : 'start'
  const far = pointPositionOf(entity, farSite)
  const sweep = ((((entity.endAngle - entity.startAngle) % TWO_PI) + TWO_PI) % TWO_PI)
  const midAngle = entity.startAngle + sweep / 2
  const mid: Sketch3dVec2 = {
    x: entity.center.x + entity.radius * Math.cos(midAngle),
    y: entity.center.y + entity.radius * Math.sin(midAngle),
  }
  let built: Sketch3dBuiltArc
  try {
    built = canonicalArcFromThreePoints(at, far, mid)
  } catch {
    return entity
  }
  const { center, radius, startAngle, endAngle, firstPointSite } = built
  // `at` was passed as the constructor's first point -- remap so the DRAGGED site (not whichever
  // site the constructor's own swap rule picked) is the one that ends up at `at`.
  return firstPointSite === site
    ? { ...entity, center, radius, startAngle, endAngle }
    : { ...entity, center, radius, startAngle: endAngle, endAngle: startAngle }
}

/** Pure helper (exported for tests): does the arc's CANONICAL sweep -- always CCW from
 *  `startAngle` by `norm(endAngle - startAngle)`, matching canonicalArcFromThreePoints's
 *  convention (WO SKC-12: never CW, never a raw signed delta) -- pass through `angle`? Lets a
 *  test verify a constructed arc's through-point is genuinely ON the swept arc, not just on the
 *  full circle. */
export function isAngleOnArcSweep(startAngle: number, endAngle: number, angle: number, epsilon = 1e-6): boolean {
  const sweep = (((endAngle - startAngle) % TWO_PI) + TWO_PI) % TWO_PI
  let rel = (((angle - startAngle) % TWO_PI) + TWO_PI) % TWO_PI
  if (rel > TWO_PI - epsilon) rel -= TWO_PI
  return rel >= -epsilon && rel <= sweep + epsilon
}
