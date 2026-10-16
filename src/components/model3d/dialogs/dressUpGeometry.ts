// WO UI-13A: small pure geometry helpers shared by the new Sweep/Draft/Hole
// dialogs and SolidsWorkbenchPage.tsx's executor -- kept out of workbench/
// (this WO's ownership manifest is SolidsWorkbenchPage.tsx + dialogs/** only)
// so every helper a new dialog needs lives inside the manifest.

import { textFor } from '../../../i18n'
const workbenchText = textFor('sketch-and-model-workbench')
import type { PathChain, Vec3 } from '../../../geom/geom-service'
import { localToWorld, type PlaneFrame } from '../../../sketch3d/planeMath'
import type { Sketch as CamSketch, SketchEntity as CamSketchEntity } from '../../../lib/sketch/sketcher'

export type PathAxis = 'x' | 'y' | 'z'

/** The real picked-face frame Draft needs for a face-normal neutral plane.
 *  The viewport supplies the ray hit point and the mesh normal transformed
 *  into world space; both are persisted so regen replays the same plane. */
export interface DraftFaceFrame {
  origin: Vec3
  normal: Vec3
}

export type DraftFaceNormalResult =
  | { ok: true; pullDir: Vec3; neutralPlane: { origin: Vec3; normal: Vec3 } }
  | { ok: false; reason: string }

/** A straight open path of the given length starting at the world origin,
 *  traced along one world axis -- the minimum "pick a path" affordance for
 *  Sweep (this WO owns no path-sketch UI; see SweepDialog.tsx's header).
 *  `plane.xDir` is set to the travel axis so the path's local u coordinate
 *  IS the distance travelled; `plane.normal` is any axis perpendicular to
 *  it (the sweep engine only cares that segments trace a real 3D line, not
 *  which plane orientation was used to describe it). */
export function buildAxisPathChain(axis: PathAxis, length: number): PathChain {
  const byAxis: Record<PathAxis, { xDir: Vec3; normal: Vec3 }> = {
    x: { xDir: { x: 1, y: 0, z: 0 }, normal: { x: 0, y: 0, z: 1 } },
    y: { xDir: { x: 0, y: 1, z: 0 }, normal: { x: 1, y: 0, z: 0 } },
    z: { xDir: { x: 0, y: 0, z: 1 }, normal: { x: 0, y: 1, z: 0 } },
  }
  const { xDir, normal } = byAxis[axis]
  return {
    sketchId: 'UI13A_PATH',
    plane: { origin: { x: 0, y: 0, z: 0 }, normal, xDir },
    segments: [{ kind: 'line', a: [0, 0], b: [length, 0], srcId: 'UI13A_PATH.e0' }],
  }
}

/** Draft's DEFAULT request (WO UI-13A) -- world -Z pull, plane through the
 *  origin. WO UI-16 (C2) widens the dialog to the six principal axes +
 *  a plane offset along the chosen axis, but these constants stay the
 *  single source of truth for the dialog's INITIAL state (decomposePrincipalAxis
 *  below derives axis+flip from DRAFT_PULL_DIR itself, never a second
 *  hardcoded 'z'/true pair) -- see DraftDialog.tsx. */
export const DRAFT_PULL_DIR: Vec3 = { x: 0, y: 0, z: -1 }
export const DRAFT_NEUTRAL_PLANE: { origin: Vec3; normal: Vec3 } = { origin: { x: 0, y: 0, z: 0 }, normal: { x: 0, y: 0, z: -1 } }

const AXIS_UNIT: Record<PathAxis, Vec3> = {
  x: { x: 1, y: 0, z: 0 },
  y: { x: 0, y: 1, z: 0 },
  z: { x: 0, y: 0, z: 1 },
}

/** WO UI-16 (C2): the pull direction for one of the six principal axes --
 *  the ONLY directions the kernel's neutral-plane refusal can accept a
 *  non-through-origin plane for (BK-53 translate-conjugation requires the
 *  neutral plane's normal to be (anti)parallel to pullDir --
 *  geom-engine.ts:2864-2878's applyDraft refusal). A free-tilt plane is a
 *  KERNEL constraint, not a UI omission -- see DraftDialog.tsx's header. */
export function draftPullDir(axis: PathAxis, flip: boolean): Vec3 {
  const u = AXIS_UNIT[axis]
  // `|| 0` normalizes a negated 0 component back to +0 (flipping 'x' negates y/z too) -- cosmetic
  // (-0 === 0 and behaves identically in every arithmetic use), but keeps DRAFT_PULL_DIR's own
  // literal {x:0,y:0,z:-1} byte-comparable to draftPullDir('z', true)'s output (decomposePrincipalAxis's
  // own round-trip test relies on this).
  return flip ? { x: -u.x || 0, y: -u.y || 0, z: -u.z || 0 } : { ...u }
}

/** WO UI-16 (C2): the neutral plane for a draft -- origin `offset` mm along
 *  `pullDir` from the world origin, normal = pullDir. Constructed so the
 *  normal is ALWAYS parallel to pullDir: the dialog can never emit a tilted
 *  plane, by construction (C2 acceptance #3), independent of any UI bug. */
export function draftNeutralPlane(pullDir: Vec3, offset: number): { origin: Vec3; normal: Vec3 } {
  return { origin: { x: pullDir.x * offset, y: pullDir.y * offset, z: pullDir.z * offset }, normal: { ...pullDir } }
}

/** Resolve Draft's selected-face mode without a silent axis fallback.
 *  The face normal is normalized, optionally flipped, and used as BOTH the
 *  pull direction and neutral-plane normal. The selected point is the plane
 *  origin; offset moves that plane along the chosen pull direction. */
export function draftFaceNormalPlane(
  frame: DraftFaceFrame | undefined,
  flip: boolean,
  offset: number,
): DraftFaceNormalResult {
  if (frame === undefined) {
    return { ok: false, reason: workbenchText('dressUpGeometry.selectedFaceFrameIsUnavailableRePickTheFace') }
  }
  const origin = frame.origin
  if (![origin.x, origin.y, origin.z].every(Number.isFinite)) {
    return { ok: false, reason: workbenchText('dressUpGeometry.selectedFaceFrameOriginIsDegenerateRePickThe') }
  }
  const normal = frame.normal
  if (![normal.x, normal.y, normal.z].every(Number.isFinite)) {
    return { ok: false, reason: workbenchText('dressUpGeometry.selectedFaceNormalIsDegenerateRePickTheFace') }
  }
  const length = Math.hypot(normal.x, normal.y, normal.z)
  if (!(length > 1e-9)) {
    return { ok: false, reason: workbenchText('dressUpGeometry.selectedFaceNormalIsDegenerateRePickTheFace') }
  }
  if (!Number.isFinite(offset)) {
    return { ok: false, reason: workbenchText('dressUpGeometry.draftNeutralPlaneOffsetMustBeAFiniteNumber') }
  }
  const directionScale = (flip ? -1 : 1) / length
  const pullDir = {
    x: normal.x * directionScale || 0,
    y: normal.y * directionScale || 0,
    z: normal.z * directionScale || 0,
  }
  return {
    ok: true,
    pullDir,
    neutralPlane: {
      origin: {
        x: origin.x + pullDir.x * offset,
        y: origin.y + pullDir.y * offset,
        z: origin.z + pullDir.z * offset,
      },
      normal: { ...pullDir },
    },
  }
}

/** WO UI-16 (C2): the inverse of draftPullDir -- decomposes a principal-axis
 *  vector (DRAFT_PULL_DIR itself, by construction) into the (axis, flip) pair
 *  DraftDialog's controls initialize from, so the dialog's defaults derive
 *  from the SAME constant the executor falls back to rather than a second,
 *  independently-hardcoded 'z'/true pair drifting out of sync with it. */
export function decomposePrincipalAxis(v: Vec3): { axis: PathAxis; flip: boolean } {
  for (const axis of ['x', 'y', 'z'] as const) {
    const u = AXIS_UNIT[axis]
    if (v.x === u.x && v.y === u.y && v.z === u.z) return { axis, flip: false }
    if (v.x === -u.x && v.y === -u.y && v.z === -u.z) return { axis, flip: true }
  }
  // DRAFT_PULL_DIR is a principal axis by construction; this only guards a future edit to it.
  return { axis: 'z', flip: true }
}

function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x }
}

function normalize(v: Vec3): Vec3 {
  const len = Math.hypot(v.x, v.y, v.z) || 1
  return { x: v.x / len, y: v.y / len, z: v.z / len }
}

/** Two orthonormal in-plane directions for a face normal -- lets HoleDialog
 *  place a linear/circular arrangement of points around a single picked
 *  point without needing a second pick per point (HoleRequest.points is
 *  just Vec3[]; there is no separate "hole pattern" backend op -- see
 *  HoleDialog.tsx's header). */
export function perpBasis(normal: Vec3): { u: Vec3; v: Vec3 } {
  const n = normalize(normal)
  const upCandidate: Vec3 = Math.abs(n.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 }
  const u = normalize(cross(upCandidate, n))
  const v = cross(n, u)
  return { u, v }
}

export function addScaled(origin: Vec3, u: Vec3, su: number, v: Vec3, sv: number): Vec3 {
  return { x: origin.x + u.x * su + v.x * sv, y: origin.y + u.y * su + v.y * sv, z: origin.z + u.z * su + v.z * sv }
}

/** WO UI-16 (C4): one candidate snap point on a CAM sketch -- point self,
 *  line endpoints, circle/arc centers, arc endpoints. Mirrors
 *  src/sketch3d/pointSamples.ts's sketch3dPointSamples in spirit (same
 *  "every constrainable point site" enumeration), but over the CURRENT
 *  workbench sketch model (`Sketch`/`SketchEntity` from lib/sketch/sketcher):
 *  WO SKC-15C severed the old Sketch3dDocument model from every workbench
 *  sketch-creation path ("no workbench path creates one any more" --
 *  SolidsWorkbenchPage.tsx's drawSketchOutline comment), so
 *  sketch3dPointSamples itself would silently return [] for every sketch a
 *  user can actually draw on this page today; reusing it verbatim here would
 *  be a defect, not a shortcut. Ellipse/elliptical-arc/spline/text are
 *  skipped (the smallest useful slice -- datumPlane.ts's own V1 convention),
 *  never a crash on an unhandled kind. */
export interface CamSketchPointSample {
  id: string
  label: string
  local: { x: number; y: number }
}

function pointFromPolar(center: { x: number; y: number }, radius: number, angle: number): { x: number; y: number } {
  return { x: center.x + radius * Math.cos(angle), y: center.y + radius * Math.sin(angle) }
}

function entityPointSamples(e: CamSketchEntity): Array<{ id: string; label: string; local: { x: number; y: number } }> {
  switch (e.kind) {
    case 'point':
      return [{ id: `${e.id}:self`, label: workbenchText('dressUpGeometry.point'), local: e.at }]
    case 'line':
      return [
        { id: `${e.id}:start`, label: workbenchText('dressUpGeometry.lineStart'), local: e.start },
        { id: `${e.id}:end`, label: workbenchText('dressUpGeometry.lineEnd'), local: e.end },
      ]
    case 'circle':
      return [{ id: `${e.id}:center`, label: workbenchText('dressUpGeometry.circleCenter'), local: e.center }]
    case 'arc':
      return [
        { id: `${e.id}:center`, label: workbenchText('dressUpGeometry.arcCenter'), local: e.center },
        { id: `${e.id}:start`, label: workbenchText('dressUpGeometry.arcStart'), local: pointFromPolar(e.center, e.radius, e.startAngle) },
        { id: `${e.id}:end`, label: workbenchText('dressUpGeometry.arcEnd'), local: pointFromPolar(e.center, e.radius, e.endAngle) },
      ]
    default:
      return []
  }
}

export function camSketchPointSamples(sketch: CamSketch): CamSketchPointSample[] {
  const out: CamSketchPointSample[] = []
  for (const entity of sketch.entities) out.push(...entityPointSamples(entity))
  return out
}

/** WO UI-16 (C4): sketch-local (u, v) -> world, for the picked face's plane
 *  frame -- HoleDialog's snap-candidate projection. Delegates to
 *  sketch3d/planeMath.ts's own localToWorld (the SAME primitive
 *  datumPlane.ts/planeSketch.ts already use for every other plane-frame
 *  projection on this page) rather than re-deriving the u/normal-cross-xDir
 *  math a second time. */
export function projectSketchPointToWorld(frame: PlaneFrame, local: { x: number; y: number }): Vec3 {
  return localToWorld(frame, local)
}
