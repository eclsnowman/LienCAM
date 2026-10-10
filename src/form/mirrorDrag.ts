// Form - dragging the mirror plane in the view. A press on the plane (not on
// the cage, not on the gizmo) grabs it where the pointer hit it; the plane then
// slides along its own normal, to where the pointer's ray passes closest to the
// line through that grab point along the normal.

import type { Vec3 } from './cage'

const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2]
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]]
const unit = (a: Vec3): Vec3 => { const l = Math.hypot(a[0], a[1], a[2]); return [a[0] / l, a[1] / l, a[2] / l] }

/**
 * How far along `normal` (from `grab`) the pointer ray `origin + s dir` passes
 * closest to the line `grab + t normal`, or null when the ray runs along the
 * normal (the plane seen edge-on from straight above: no slide can be read).
 */
export function slideAlongNormal(origin: Vec3, dir: Vec3, grab: Vec3, normal: Vec3): number | null {
  const d = unit(dir), n = unit(normal)
  const b = dot(d, n)
  const denom = 1 - b * b
  if (denom < 1e-6) return null
  const w = sub(origin, grab)
  return (dot(n, w) - b * dot(d, w)) / denom
}

/** The mirror plane's new place (n . p = at) for a slide `t` from where it was grabbed, to 0.01 mm. */
export function slidMirrorAt(atWhenGrabbed: number, t: number): number {
  return Math.round((atWhenGrabbed + t) * 100) / 100
}
