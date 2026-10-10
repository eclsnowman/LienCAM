// WO SKC-5: pure Vec3 + PlaneFrame math shared by the face-plane datum
// executor (datumPlane.ts), legacy face-boundary compatibility, and explicit
// model Project / Use. Zero kernel dependency -- plain numbers in, plain
// numbers out, exactly like element-map.ts's own private vec helpers (not
// reused directly since they are unexported there; this is the sketch3d
// lane's own copy of the same tiny primitives).
//
// Convention (verified against the codebase's existing hardcoded planes,
// workbench/profileGeometry.ts's planeFor()): a sketch-plane's local Y axis
// is `normal x xDir`, NOT `xDir x normal`. Cross-checked both ways:
//   xy: normal=(0,0,1), xDir=(1,0,0) -> normal x xDir = (0,1,0)  (world Y) -- matches.
//   xz: normal=(0,-1,0), xDir=(1,0,0) -> normal x xDir = (0,0,1) (world Z) -- matches
//       profileGeometry.ts's rectangleWorldCorners xz case, which maps local
//       y (rectangle "height") to world z.
// Getting this backwards would silently mirror every projected/emitted
// profile left-right -- there is no test that would catch a sign flip here
// except this cross-check against already-proven fixtures, so it is
// recorded explicitly rather than left to be re-derived.

import type { PlaneDef, Vec3 } from '../geom/geom-service'

/** Shape-identical to geom-service.ts's PlaneDef -- the SAME type, aliased
 *  under the name this WO's design doc and audit use ("PlaneFrame"), so a
 *  resolved datum frame drops into ProfileRegion.plane with zero mapping. */
export type PlaneFrame = PlaneDef

export function vAdd(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z }
}

export function vSub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }
}

export function vScale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s }
}

export function vDot(a: Vec3, b: Vec3): number {
  return a.x * b.x + a.y * b.y + a.z * b.z
}

export function vCross(a: Vec3, b: Vec3): Vec3 {
  return {
    x: a.y * b.z - a.z * b.y,
    y: a.z * b.x - a.x * b.z,
    z: a.x * b.y - a.y * b.x,
  }
}

export function vLength(a: Vec3): number {
  return Math.sqrt(vDot(a, a))
}

/** Zero-safe unit vector -- returns the input unchanged (never NaN) for a
 *  near-zero vector, since every caller here already guards length before
 *  normalizing and would rather see an honest non-unit fallback than NaN
 *  propagate silently into a persisted PlaneFrame. */
export function vUnit(a: Vec3): Vec3 {
  const len = vLength(a)
  return len < 1e-12 ? a : vScale(a, 1 / len)
}

/** The plane's local Y axis (see file header for the verified convention). */
export function planeYDir(frame: Pick<PlaneFrame, 'normal' | 'xDir'>): Vec3 {
  return vUnit(vCross(frame.normal, frame.xDir))
}

/** World -> sketch-local (u, v): projections of `p - origin` onto xDir/yDir. */
export function worldToLocal(frame: PlaneFrame, p: Vec3): { x: number; y: number } {
  const rel = vSub(p, frame.origin)
  const yDir = planeYDir(frame)
  return { x: vDot(rel, frame.xDir), y: vDot(rel, yDir) }
}

/** Sketch-local (u, v) -> world. Inverse of worldToLocal. */
export function localToWorld(frame: PlaneFrame, local: { x: number; y: number }): Vec3 {
  const yDir = planeYDir(frame)
  return vAdd(frame.origin, vAdd(vScale(frame.xDir, local.x), vScale(yDir, local.y)))
}
