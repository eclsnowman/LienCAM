// WO SKC-5, Q7 (docs/3d/SKETCH-PLANE-SYSTEM-RECON.md open question 7,
// "Recommended" -- Operator-approved 2026-07-09 as part of the whole slice):
// deterministic projected-model-X with prior-frame preservation. Extracted
// from datumPlane.ts so the policy itself (a pure function of a normal + an
// optional prior frame) is independently testable without a DAG/ElementMap
// fixture.
//
// docs/stable-id-spec.md defines the persisted face snapshot as
// {surfaceType, centroid, normal|axis, area} -- NO xDir (SKC-7.audit.json's
// scopedAsks #3 confirms this reading is correct). A plane's second in-plane
// axis is therefore this WO's own invention, not something the kernel or
// stable-id spec hands us -- which is exactly why it must be a PURE,
// deterministic function of data that is itself stable (the plane's own
// normal, plus the sketch's own last-good frame), never kernel parameter-U
// (explicitly rejected by Q7 option C: "kernel parameterization may drift").

import type { Vec3 } from '../geom/geom-service'
import { vDot, vLength, vSub, vUnit } from './planeMath'
import type { PlaneFrame } from './planeMath'

const WORLD_X: Vec3 = { x: 1, y: 0, z: 0 }
const WORLD_Y: Vec3 = { x: 0, y: 1, z: 0 }
/** Below this the candidate direction is judged "too parallel to the
 *  normal" to serve as a stable in-plane axis (a plane whose normal is
 *  near-exactly world X, e.g. a YZ-ish face, would otherwise project world X
 *  down to a near-zero vector and amplify noise on normalize). */
const MIN_PROJECTED_LENGTH = 1e-6
/** Two normals within this dot-product of parallel are treated as "the same
 *  physical plane orientation" for prior-frame xDir preservation -- loose
 *  enough to survive floating-point centroid/normal drift across a param
 *  edit that only translates the face, tight enough to never straddle a
 *  genuine reorientation (a flipNormal toggle, or binding a different face
 *  entirely, both land far below this). */
const SAME_ORIENTATION_DOT_MIN = 0.999

function projectOntoPlane(v: Vec3, unitNormal: Vec3): Vec3 {
  const along = vDot(v, unitNormal)
  return vSub(v, { x: unitNormal.x * along, y: unitNormal.y * along, z: unitNormal.z * along })
}

/**
 * Deterministic xDir for a plane with the given (already flip-resolved,
 * unit) `normal`:
 *  1. If `priorFrame` exists and its normal is (near-)parallel to `normal`
 *     (same orientation, e.g. a parameter edit that only moved the face),
 *     project the PRIOR xDir onto the new plane and keep it -- continuity
 *     across small edits (AC #2) beats re-deriving from scratch every pass.
 *  2. Otherwise project world +X onto the plane; if that degenerates
 *     (normal too close to world X), fall back to projecting world +Y.
 * Never reads kernel parameterization (Q7 option C, rejected).
 */
export function computeXDir(normal: Vec3, priorFrame?: PlaneFrame): Vec3 {
  const n = vUnit(normal)

  if (priorFrame !== undefined) {
    const priorNormal = vUnit(priorFrame.normal)
    if (vDot(priorNormal, n) > SAME_ORIENTATION_DOT_MIN) {
      const projected = projectOntoPlane(priorFrame.xDir, n)
      if (vLength(projected) > MIN_PROJECTED_LENGTH) return vUnit(projected)
    }
  }

  const projectedX = projectOntoPlane(WORLD_X, n)
  if (vLength(projectedX) > MIN_PROJECTED_LENGTH) return vUnit(projectedX)
  return vUnit(projectOntoPlane(WORLD_Y, n))
}
