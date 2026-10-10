// ============================================================
// World -> Work coordinate transform (ADR-0043 section 1)
// ============================================================
// Moves carry WORLD coordinates. Anything that talks to a machine - the file
// post, or the live program builder - works in WORK coordinates under the
// active fixture offset. The UNIFORM rule is:
//
//     work = R^T * (world - wcs.origin)
//
// where R is the WCS basis (xAxis,yAxis,zAxis as columns). In v1 the basis is
// the identity (a rotated WCS is rejected upstream by detectRotatedWcs), so
// the rotation collapses to a plain subtraction. The un-rotate step is written
// out explicitly anyway so enabling rotated WCS later is a clean drop-in.
//
// This file lives in the NEUTRAL program layer, not in the post, because there
// are now two consumers of it. ADR-0021's one-way rule forbids the live
// builder importing the post, and a second copy of the transform is exactly
// how two builders start disagreeing about where the tool goes. One copy, both
// callers: `src/lib/post/coords.ts` re-exports it for the post's existing
// callers, and nothing in `src/lib/program/` imports the post, ever.

import type { Vec3, WCS } from '../../types'

/** Transform a single point's coords from world to work space. */
export function toWork(
  move: { x: number; y: number; z: number },
  wcs: WCS,
): { x: number; y: number; z: number } {
  // Translate into WCS-origin-relative space.
  const dx = move.x - wcs.origin.x
  const dy = move.y - wcs.origin.y
  const dz = move.z - wcs.origin.z

  // Un-rotate by the WCS basis: project the translated vector onto each axis.
  // With identity axes these dot products return (dx, dy, dz) unchanged. A
  // future rotated WCS supplies real axes and this becomes the inverse rotation
  // (R^T) for free, since the basis is orthonormal.
  const x = dot(wcs.xAxis, dx, dy, dz)
  const y = dot(wcs.yAxis, dx, dy, dz)
  const z = dot(wcs.zAxis, dx, dy, dz)
  return { x, y, z }
}

function dot(axis: Vec3, dx: number, dy: number, dz: number): number {
  return axis.x * dx + axis.y * dy + axis.z * dz
}

/** Inverse of toWork: transform a single point's coords from work to world space.
 *  toWork is  work = R^T * (world - origin)  with R = [xAxis yAxis zAxis] (columns),
 *  so the inverse is  world = origin + R * work. With identity axes this collapses
 *  to a plain addition (work + origin); a future rotated WCS re-rotates correctly
 *  because R is orthonormal. Used to lift a work-relative safe-Z into a common
 *  world/machine frame so multi-setup retracts can clear EVERY setup's stock top. */
export function toWorld(
  point: { x: number; y: number; z: number },
  wcs: WCS,
): { x: number; y: number; z: number } {
  // R * work: each world axis gets the work component times that basis column.
  const x = wcs.xAxis.x * point.x + wcs.yAxis.x * point.y + wcs.zAxis.x * point.z
  const y = wcs.xAxis.y * point.x + wcs.yAxis.y * point.y + wcs.zAxis.y * point.z
  const z = wcs.xAxis.z * point.x + wcs.yAxis.z * point.y + wcs.zAxis.z * point.z
  return { x: x + wcs.origin.x, y: y + wcs.origin.y, z: z + wcs.origin.z }
}
