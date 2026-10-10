import type { ToolpathMove } from '../types'
import type { MoveRole, Vec2 } from '../../../types'

/** Rapid to point `p` at clearanceZ → retractZ → feedZ. */
export function rapidEntryAt(
  moves: ToolpathMove[], p: Vec2,
  feedZ: number, retractZ: number, clearanceZ: number
) {
  moves.push({ type: 'rapid', x: p.x, y: p.y, z: clearanceZ,   role: 'rapid' })
  moves.push({ type: 'rapid', x: p.x, y: p.y, z: retractZ, role: 'rapid' })
  moves.push({ type: 'rapid', x: p.x, y: p.y, z: feedZ,    role: 'rapid' })
}

/** Rapid to path[0] at clearanceZ → retractZ → feedZ. */
export function rapidEntry(
  moves: ToolpathMove[], path: Vec2[],
  feedZ: number, retractZ: number, clearanceZ: number
) {
  rapidEntryAt(moves, path[0], feedZ, retractZ, clearanceZ)
}

/** Feed plunge at path[fromIdx] from current Z to depth. */
export function plungeTo(
  moves: ToolpathMove[], path: Vec2[], fromIdx: number, depth: number, feedRate: number,
  role: MoveRole = 'plunge'
) {
  const p = path[fromIdx]
  moves.push({ type: 'feed', x: p.x, y: p.y, z: depth, feed: feedRate, role })
}

// ── Entry moves: the one helix builder and the one ramp builder ──────────────────────────
// Every operation that descends into material with a helix or a ramp builds it here
// (WO-1679). Operations supply only their own geometry (where the helix sits, which path
// the ramp follows) and their feeds; the descent profile, the final-depth guarantee, the
// minimum helix radius and the feed each entry move carries live in one place.

/** Smallest helix radius worth spiralling at: below it a helix is a plunge at ramp feed,
 *  so every operation plunges at its plunge rate instead. */
export const MIN_HELIX_RADIUS_MM = 0.2

/** True when a helix of `radius` is a real helix rather than a disguised plunge. */
export function helixFits(radius: number, minRadius = MIN_HELIX_RADIUS_MM): boolean {
  return Number.isFinite(radius) && radius >= minRadius
}

export interface HelixDescent {
  centre: Vec2
  /** Radius the tool centre actually orbits at. */
  radius: number
  fromZ: number
  toZ: number
  /** tan(descent angle); the drop per revolution is 2 pi `pitchRadius` x tanAngle. */
  tanAngle: number
  /** Radius the drop per revolution is measured on. Defaults to `radius`. */
  pitchRadius?: number
  /** Feed of every helix move (the operation's ramp feed). */
  feed: number
  /** Angle of the first point (radians). Default 0 = +X of the centre. */
  startAngle?: number
  /** +1 counter-clockwise (default), -1 clockwise. */
  direction?: 1 | -1
  /** How the sweep is sampled.
   *  'even' (default): equal steps, `stepsPerRev` per revolution, at least `minSteps`;
   *    the start point is not emitted (the approach already put the tool there).
   *  'fixed': a point every `stepRad` from the start (start included), capped at
   *    `maxPoints`, then the exact end. */
  sampling?:
    | { kind: 'even'; stepsPerRev: number; minSteps: number }
    | { kind: 'fixed'; stepRad: number; maxPoints: number }
}

/**
 * The one helix builder: spiral from fromZ down to toZ around `centre`, Z linear in swept
 * angle, the last move exactly at toZ. Emits 'helix' feed moves only -- the approach to
 * the start point is the caller's (its heights differ by operation). Returns the end point.
 */
export function helixDescent(moves: ToolpathMove[], h: HelixDescent): Vec2 {
  const dir = h.direction ?? 1
  const phi0 = h.startAngle ?? 0
  const drop = h.fromZ - h.toZ
  const dropPerRev = 2 * Math.PI * (h.pitchRadius ?? h.radius) * h.tanAngle
  const sampling = h.sampling ?? { kind: 'even', stepsPerRev: 36, minSteps: 12 }
  const at = (phi: number) => ({
    x: h.centre.x + h.radius * Math.cos(phi0 + dir * phi),
    y: h.centre.y + h.radius * Math.sin(phi0 + dir * phi),
  })
  const push = (p: Vec2, z: number) =>
    moves.push({ type: 'feed', x: p.x, y: p.y, z, feed: h.feed, role: 'helix' })

  if (sampling.kind === 'fixed') {
    const sweep = dropPerRev > 1e-9 ? (drop / dropPerRev) * 2 * Math.PI : 2 * Math.PI
    let pts = 0
    for (let phi = 0; phi < sweep && pts < sampling.maxPoints; phi += sampling.stepRad, pts++) {
      push(at(phi), h.fromZ - (phi / sweep) * drop)
    }
    const end = at(sweep)
    push(end, h.toZ)
    return end
  }

  const revs = drop / Math.max(dropPerRev, 1e-6)
  const steps = Math.max(sampling.minSteps, Math.ceil(revs * sampling.stepsPerRev))
  let end = at(0)
  for (let i = 1; i <= steps; i++) {
    const frac = i / steps
    end = at(frac * revs * 2 * Math.PI)
    push(end, Math.max(h.toZ, h.fromZ - frac * drop))
  }
  if ((moves[moves.length - 1]?.z ?? h.toZ) > h.toZ + 1e-6) push(end, h.toZ)
  return end
}

/** Visits points along an operation's own path, `traveled` mm from the ramp start, until
 *  `length` mm have been covered (the last visit at or past `length`). */
export type RampWalk = (length: number, visit: (point: Vec2, traveled: number) => void) => void

/**
 * The one ramp builder: descend from fromZ to toZ over `length` mm of XY travel along the
 * path `walk` traces. Z is linear in distance travelled; any point at or past `length` is
 * exactly toZ. Emits 'ramp' feed moves at `feed` (the operation's ramp feed).
 */
export function rampDescent(
  moves: ToolpathMove[], walk: RampWalk,
  fromZ: number, toZ: number, length: number, feed: number,
): void {
  const drop = fromZ - toZ
  walk(length, (p, traveled) => {
    const z = traveled >= length - 1e-9 ? toZ : Math.max(toZ, fromZ - (traveled / length) * drop)
    moves.push({ type: 'feed', x: p.x, y: p.y, z, feed, role: 'ramp' })
  })
}

/**
 * Ramp from fromZ to toZ along the closed contour starting at path[fromIdx], stepping
 * vertex to vertex (the vertex that completes the ramp length lands at toZ).
 * Returns the path index where toZ is first reached.
 */
export function rampTo(
  moves: ToolpathMove[], path: Vec2[], fromIdx: number,
  fromZ: number, toZ: number, tanAngle: number, rampRate: number
): number {
  const n         = path.length
  const totalDrop = fromZ - toZ
  if (totalDrop <= 1e-6) return fromIdx

  let landed = -1
  rampDescent(moves, (length, visit) => {
    let distAccum = 0
    for (let step = 0; step < n * 50 && distAccum < length; step++) {
      const i = (fromIdx + step) % n
      const j = (i + 1)         % n
      distAccum += Math.hypot(path[j].x - path[i].x, path[j].y - path[i].y)
      visit(path[j], distAccum)
      if (distAccum >= length) landed = j
    }
    // A contour too short to carry the ramp in 50 laps: finish the drop where it began.
    if (landed < 0) visit(path[fromIdx], length)
  }, fromZ, toZ, totalDrop / tanAngle, rampRate)
  return landed < 0 ? fromIdx : landed
}

/** Cut one full closed loop at `depth`. Returns fromIdx. */
export function cutLoop(
  moves: ToolpathMove[], path: Vec2[], fromIdx: number, depth: number, feedRate: number
): number {
  return cutLoopWithOverlap(moves, path, fromIdx, depth, feedRate, 0)
}

/**
 * Cut one full closed loop then continue `overlapMm` past the start point
 * to eliminate the witness mark where the loop closes.
 *
 * Returns the path vertex index the tool ends up at after the overlap so
 * chained passes (spring passes, additional finish passes) start from the
 * correct position instead of rewinding to the original fromIdx.
 */
export function cutLoopWithOverlap(
  moves: ToolpathMove[], path: Vec2[], fromIdx: number, depth: number,
  feedRate: number, overlapMm: number
): number {
  const n = path.length
  for (let step = 0; step < n; step++) {
    const idx = (fromIdx + step) % n
    moves.push({ type: 'feed', x: path[idx].x, y: path[idx].y, z: depth, feed: feedRate, role: 'cut' })
  }
  // Closing move back to loop start
  moves.push({ type: 'feed', x: path[fromIdx].x, y: path[fromIdx].y, z: depth, feed: feedRate, role: 'cut' })

  // Overlap: continue past start for overlapMm to blend the seam.
  // Returns j (the vertex ahead of the interpolated endpoint) so the next
  // chained pass continues forward without rewinding.
  if (overlapMm > 0) {
    let distAccum = 0
    let step = 0
    while (step < n && distAccum < overlapMm) {
      const i = (fromIdx + step) % n
      const j = (fromIdx + step + 1) % n
      const dx = path[j].x - path[i].x
      const dy = path[j].y - path[i].y
      const segLen = Math.sqrt(dx * dx + dy * dy)
      if (distAccum + segLen >= overlapMm) {
        const t = (overlapMm - distAccum) / segLen
        moves.push({ type: 'feed', x: path[i].x + t * dx, y: path[i].y + t * dy, z: depth, feed: feedRate, role: 'cut' })
        return j  // next pass starts from the vertex ahead of the overlap endpoint
      }
      distAccum += segLen
      moves.push({ type: 'feed', x: path[j].x, y: path[j].y, z: depth, feed: feedRate, role: 'cut' })
      step++
    }
  }

  return fromIdx
}

/** Retract Z-only from wherever the tool currently is, then rapid to clearanceZ. */
export function retractFrom(moves: ToolpathMove[], retractZ: number, clearanceZ: number) {
  const last = moves[moves.length - 1]
  const x = last?.x ?? 0
  const y = last?.y ?? 0
  moves.push({ type: 'rapid', x, y, z: retractZ, role: 'rapid' })
  moves.push({ type: 'rapid', x, y, z: clearanceZ,   role: 'rapid' })
}
