// Ortho-lock (Shift while drawing) — PURE, headless-testable.
//
// Holding Shift during a rubber-band draw step locks the direction from the
// anchor (the segment's previous point) to the nearest of the 8 principal
// rays — 0/45/90/135/180/225/270/315 deg. The cursor is PROJECTED onto the
// chosen ray, so the resulting point lies EXACTLY on the locked line and its
// distance is the projection of the cursor offset onto that ray
// (standard parametric CAD ortho feel). Releasing Shift restores free drawing.
//
// No store, no three.js, no DOM. The viewport applies this to the cursor
// BEFORE snapping/inference (via the store's lockCursor handler) so the
// locked direction wins over soft H/V alignment while Shift is held.

import type { Vec2 } from './types'
import type { ToolChainState } from './tools/toolMachine'

// The 8 principal directions as integer lattice vectors (normalized below).
// Axis entries stay exact (no trig round-off), diagonals share a unit length.
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],   // 0 deg   E
  [1, 1],   // 45 deg  NE
  [0, 1],   // 90 deg  N
  [-1, 1],  // 135 deg NW
  [-1, 0],  // 180 deg W
  [-1, -1], // 225 deg SW
  [0, -1],  // 270 deg S
  [1, -1],  // 315 deg SE
]

const QUARTER = Math.PI / 4

/**
 * Project `cursor` onto the nearest 0/45/90deg ray from `anchor`. The result
 * lies exactly on that ray; its distance from the anchor is the projection of
 * the cursor offset onto the ray (never negative — the nearest ray is always
 * within +/-22.5 deg, so the projection is forward). When the cursor sits on
 * the anchor there is no direction to lock, so the anchor itself is returned.
 */
export function applyOrthoLock(anchor: Vec2, cursor: Vec2): Vec2 {
  const dx = cursor.x - anchor.x
  const dy = cursor.y - anchor.y
  if (dx === 0 && dy === 0) return { x: anchor.x, y: anchor.y } // degenerate

  // Nearest principal sector (round to the closest 45 deg step), wrapped to 0..7.
  const ang = Math.atan2(dy, dx)
  const k = ((Math.round(ang / QUARTER) % 8) + 8) % 8
  const [rx, ry] = DIRS[k]
  const rl = Math.hypot(rx, ry)
  const ux = rx / rl
  const uy = ry / rl

  // Distance along the ray = projection of the cursor offset onto it.
  const proj = dx * ux + dy * uy
  return { x: anchor.x + ux * proj, y: anchor.y + uy * proj }
}

/**
 * Rubber-band anchor for the CURRENT direction step of the in-progress
 * chain, or null when this step has no clean anchor->cursor DIRECTION (a
 * distance/radius/param step, or a tool with no rubber-band-from-a-point
 * step). One shared mechanism: every tool whose current step swings a ray
 * from a fixed point returns that point, so the same locked cursor drives
 * its preview AND its commit (the viewport locks the cursor upstream).
 *
 * Per-tool / per-step coverage:
 *   line        prev point          ALWAYS (next segment swings from there)
 *   rect        the first click     diagonal step (lock to 45deg = a square)
 *   polygon     center              center -> vertex-0 (locks the rotation;
 *                                   the ray projection sets the radius)
 *   ellipse     center, but ONLY    the major-axis step (center -> major
 *               while major is null endpoint). The later MINOR DISTANCE step
 *                                   is perpendicular -> ortho skipped.
 *   ellipse-arc center, but ONLY    same as ellipse: only the major-axis
 *               while major is null direction step. The minor-distance and
 *                                   the start/end PARAM picks are skipped.
 *   slot        cap A, but ONLY     the axis step (A -> B). The later WIDTH
 *               while b is null     step is a perpendicular distance -> skipped.
 *   slotArc     centerline start,   the first centerline step (start -> end).
 *               ONLY while end null The through-point (bends the arc) and the
 *                                   width (distance) steps are skipped.
 *
 * Skipped tools/steps (no clean direction): circle (radius / 3-point), arc
 * (radius / 3-point / tangent), smart-dim + every MODIFY tool. They return
 * null, so Shift is a no-op there (byte-identical to free drawing).
 */
export function orthoAnchor(chain: ToolChainState | null): Vec2 | null {
  if (!chain) return null
  switch (chain.kind) {
    case 'line':
      return { x: chain.prev.x, y: chain.prev.y }
    case 'rect':
      // anchor is undefined only in the pre-click1 rotated staging state
      // (Tab pressed while armed) -> no anchor to snap to yet.
      return chain.anchor ? { x: chain.anchor.x, y: chain.anchor.y } : null
    case 'polygon':
      return { x: chain.center.x, y: chain.center.y }
    case 'ellipse':
      // Direction step is the major axis only; minor is a distance step.
      return chain.major ? null : { x: chain.center.x, y: chain.center.y }
    case 'ellipse-arc':
      // Same as the ellipse: major-axis direction step only.
      return chain.major ? null : { x: chain.center.x, y: chain.center.y }
    case 'slot':
      // Axis step (A -> B) only; the width step is a perpendicular distance.
      return chain.b ? null : { x: chain.a.x, y: chain.a.y }
    case 'slotArc':
      // First centerline step (start -> end) only; through/width are not it.
      return chain.end ? null : { x: chain.start.x, y: chain.start.y }
    default:
      // circle, arc, dim + MODIFY tools: no anchor->cursor direction step.
      return null
  }
}

/**
 * Lock the cursor to the chain's ortho directions when an anchor exists,
 * otherwise return the cursor unchanged. Callers gate this on Shift being
 * held; with no anchor (no chain in progress, or a tool without a direction
 * step) the cursor passes through, so Shift is a no-op there.
 */
export function orthoLockCursor(chain: ToolChainState | null, cursor: Vec2): Vec2 {
  const a = orthoAnchor(chain)
  return a ? applyOrthoLock(a, cursor) : cursor
}
