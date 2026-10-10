// WO-1969: surface-following Engrave.
//
// The store samples the part's top surface under the engraved paths into a
// regular height grid (surfaceField.ts, through the 3D kernel) and hands it to
// the Engrave builder inside its worker params. The builder then rides every
// cutting point at surface(x, y) - pass depth instead of one fixed Z. Pure and
// synchronous: this file is what the toolpath worker runs, so it carries no
// kernel, no mesh and no async work.

import type { ToolpathMove } from '../types'
import type { Vec2 } from '../../../types'

/** The part's top surface under the paths, world frame, plus how deep to cut
 *  below it. Heights are row-major (y outer, x inner): node (ix, iy) is at
 *  (x0 + ix*dx, y0 + iy*dy). NaN marks a node with no part under it. */
export interface EngraveSurfaceField {
  x0: number
  y0: number
  dx: number
  dy: number
  nx: number
  ny: number
  z: ArrayLike<number>
  /** Total cut depth below the surface, mm (positive). */
  depthMm: number
  /** Formula axial offset added to every cutting Z, mm. */
  axialOffsetMm: number
  /** The depth error allowed between two emitted points, mm. */
  toleranceMm: number
  /** Highest surface node, world Z: the height held where a whole curve is off the part. */
  maxZ: number
}

/** Engrave worker params as the store sends them for a surface-following op. */
export interface EngraveSurfaceFollowParams {
  surfaceFollow?: EngraveSurfaceField
}

/** Surface height at (x, y), bilinear between the four grid nodes around it.
 *  Nodes with no part under them drop out and the rest are re-weighted, so the
 *  height stays right up to the part's edge; NaN when none of the four has a
 *  surface (or the point is outside the grid): the path is off the part there. */
export function surfaceHeightAt(field: EngraveSurfaceField, x: number, y: number): number {
  const fx = (x - field.x0) / field.dx
  const fy = (y - field.y0) / field.dy
  if (!(fx >= -1e-9 && fy >= -1e-9 && fx <= field.nx - 1 + 1e-9 && fy <= field.ny - 1 + 1e-9)) return NaN
  const ix = Math.min(Math.max(Math.floor(fx), 0), Math.max(field.nx - 2, 0))
  const iy = Math.min(Math.max(Math.floor(fy), 0), Math.max(field.ny - 2, 0))
  const tx = field.nx > 1 ? Math.min(Math.max(fx - ix, 0), 1) : 0
  const ty = field.ny > 1 ? Math.min(Math.max(fy - iy, 0), 1) : 0
  const ix1 = Math.min(ix + 1, field.nx - 1)
  const iy1 = Math.min(iy + 1, field.ny - 1)
  const corners: Array<[number, number]> = [
    [field.z[iy * field.nx + ix], (1 - tx) * (1 - ty)],
    [field.z[iy * field.nx + ix1], tx * (1 - ty)],
    [field.z[iy1 * field.nx + ix], (1 - tx) * ty],
    [field.z[iy1 * field.nx + ix1], tx * ty],
  ]
  let sum = 0
  let weight = 0
  for (const [z, w] of corners) {
    if (!Number.isFinite(z)) continue
    sum += z * w
    weight += w
  }
  if (weight > 1e-12) return sum / weight
  // Exactly on a node whose weight is 1 with that node valid is handled above;
  // here every node carrying weight is off the part.
  return NaN
}

/** One target of the ride: a point the builder would have fed to at a fixed Z. */
export interface SurfaceRidePoint {
  p: Vec2
  role: 'lead_in' | 'cut' | 'lead_out'
  feed: number
}

const MAX_SPLIT_DEPTH = 8

/**
 * Feed moves that ride the surface through `targets`, starting from `start`
 * (the plunge point). Each straight segment is cut into pieces no longer than
 * the grid spacing, then any piece whose surface bows away from its chord by
 * more than the tolerance is halved again - so the depth error between two
 * emitted points stays within `toleranceMm`. Off-part points hold the last
 * surface height; returns whether any did.
 */
export function rideSurface(
  field: EngraveSurfaceField,
  start: Vec2,
  targets: readonly SurfaceRidePoint[],
  passOffsetMm: number,
  fallbackSurfaceZ: number,
): { moves: ToolpathMove[]; entryZ: number; lastSurfaceZ: number; offPart: boolean } {
  const spacing = Math.max(Math.min(field.dx, field.dy), 1e-3)
  const tol = field.toleranceMm > 0 ? field.toleranceMm : 0.01
  const samples: Array<{ x: number; y: number; s: number; role: SurfaceRidePoint['role']; feed: number }> = []

  const push = (x: number, y: number, s: number, role: SurfaceRidePoint['role'], feed: number) => {
    samples.push({ x, y, s, role, feed })
  }
  const split = (
    ax: number, ay: number, as: number,
    bx: number, by: number, bs: number,
    role: SurfaceRidePoint['role'], feed: number, depth: number,
  ) => {
    if (depth < MAX_SPLIT_DEPTH && Number.isFinite(as) && Number.isFinite(bs)) {
      const mx = (ax + bx) / 2
      const my = (ay + by) / 2
      const ms = surfaceHeightAt(field, mx, my)
      if (Number.isFinite(ms) && Math.abs(ms - (as + bs) / 2) > tol) {
        split(ax, ay, as, mx, my, ms, role, feed, depth + 1)
        split(mx, my, ms, bx, by, bs, role, feed, depth + 1)
        return
      }
    }
    push(bx, by, bs, role, feed)
  }

  let px = start.x
  let py = start.y
  let ps = surfaceHeightAt(field, px, py)
  const startSurface = ps
  for (const target of targets) {
    const len = Math.hypot(target.p.x - px, target.p.y - py)
    const pieces = Math.max(1, Math.ceil(len / spacing - 1e-9))
    for (let k = 1; k <= pieces; k++) {
      const t = k / pieces
      const bx = k === pieces ? target.p.x : px + (target.p.x - px) * t
      const by = k === pieces ? target.p.y : py + (target.p.y - py) * t
      const bs = surfaceHeightAt(field, bx, by)
      const ax = k === 1 ? px : px + (target.p.x - px) * ((k - 1) / pieces)
      const ay = k === 1 ? py : py + (target.p.y - py) * ((k - 1) / pieces)
      const as = k === 1 ? ps : samples[samples.length - 1].s
      split(ax, ay, as, bx, by, bs, target.role, target.feed, 0)
    }
    px = target.p.x
    py = target.p.y
    ps = samples.length ? samples[samples.length - 1].s : ps
  }

  // Off the part: hold the last surface height seen along the ride. A ride
  // that starts off the part takes the first height it finds; one that never
  // meets the part holds the height it was handed.
  const firstOn = [startSurface, ...samples.map(sample => sample.s)].find(Number.isFinite)
  const entrySurface = firstOn ?? fallbackSurfaceZ
  let offPart = !Number.isFinite(startSurface)
  const lift = passOffsetMm + field.axialOffsetMm
  const moves: ToolpathMove[] = []
  let held = entrySurface
  for (const sample of samples) {
    if (Number.isFinite(sample.s)) held = sample.s
    else offPart = true
    moves.push({ type: 'feed', x: sample.x, y: sample.y, z: held + lift, feed: sample.feed, role: sample.role })
  }
  return { moves, entryZ: entrySurface + lift, lastSurfaceZ: held, offPart }
}

/** How many cutting moves of a finished surface-following path sit where the
 *  field has no part under them. The store says so on the console, once. */
export function surfaceFollowOffPartMoves(
  moves: readonly ToolpathMove[],
  field: EngraveSurfaceField,
): number {
  let count = 0
  for (const move of moves) {
    if (move.type !== 'feed') continue
    if (move.role !== 'cut' && move.role !== 'lead_in' && move.role !== 'lead_out') continue
    if (!Number.isFinite(surfaceHeightAt(field, move.x, move.y))) count++
  }
  return count
}
