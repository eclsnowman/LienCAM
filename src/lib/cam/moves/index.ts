import type { ToolpathMove, ToolpathStockBlock } from '../types'
import type { MoveRole, Vec2 } from '../../../types'
import type { StockState } from '../stockState'
import { highestMaterialOver } from '../smartHeights/earlierMaterial'

// -- WO-3083: where every entry starts - one rule for every operation ------------------------
// The owner, 2026-10-23 release review: "chamfer start height helix entry is really high ...
// This is a common theme across several operations." Operations used to start their helix,
// ramp or plunge at three different heights (the Feed plane Top + 5, the material itself, or
// Pocket's material + 1). Now every entry starts ENTRY_CLEARANCE_MM above the highest material
// under its footprint (Pocket's WO-1972 rule, moved here): the tool rapids down to there and
// feeds from there.

/** Pocket's "Helix start above material" default, mm: every entry starts this far above the
 *  material it meets. */
export const ENTRY_CLEARANCE_MM = 1

/** What an operation knows about the material its entries meet, in the moves' frame. */
export interface EntryMaterial {
  /** What the earlier operations of the setup left (the store's replay). */
  readonly remaining?: StockState
  /** The stock block as loaded. */
  readonly stockBlock?: ToolpathStockBlock
  /** The operation's resolved Top. */
  readonly topZ: number
  /** The operation's Feed plane. An operator who set it lower than the rule's start (but still
   *  above the material) keeps it: the rule never adds air the operator took out. */
  readonly feedZ?: number
}

/** A replayed stock state the lookup can read; undefined when it is empty or malformed. */
export function usableStock(stock: StockState | undefined): StockState | undefined {
  if (!stock || !(stock.resolutionMm > 0) || !(stock.nx > 0) || !(stock.ny > 0)) return undefined
  return stock.topZ?.length === stock.nx * stock.ny ? stock : undefined
}

/** The operation's entry material: remaining stock (when usable), the block, and Top. */
export function entryMaterialOf(
  payload: { stockBlock?: ToolpathStockBlock }, topZ: number, feedZ?: number,
): EntryMaterial {
  // Every 2D request carries the reach inputs (ToolReachInputs.remainingStock) beside its own fields.
  const remaining = usableStock((payload as { remainingStock?: StockState }).remainingStock)
  return { ...(remaining ? { remaining } : {}), ...(payload.stockBlock ? { stockBlock: payload.stockBlock } : {}),
    topZ, ...(feedZ !== undefined && Number.isFinite(feedZ) ? { feedZ } : {}) }
}

/** `clearance` above `materialZ`, or the operator's lower Feed plane when it is still above it. */
export function entryAbove(materialZ: number, clearance = ENTRY_CLEARANCE_MM, feedZ?: number): number {
  const start = materialZ + clearance
  return feedZ !== undefined && feedZ > materialZ && feedZ < start ? feedZ : start
}

/**
 * The highest material under a footprint of radius `reach` around `centre`: the remaining
 * stock's highest column over the footprint's square padded by one cell (reads too high,
 * never too low); with no remaining stock, the block as loaded where the footprint is over
 * it; with neither, Top. `ceilingZ` is what this operation already cut there (the level
 * above) - the material is never above it.
 */
export function materialUnder(src: EntryMaterial, centre: Vec2, reach: number, ceilingZ?: number): number {
  let surfaceZ: number | undefined
  if (src.remaining) {
    const pad = Math.max(0, reach) + src.remaining.resolutionMm
    surfaceZ = highestMaterialOver(src.remaining, {
      minX: centre.x - pad, minY: centre.y - pad, maxX: centre.x + pad, maxY: centre.y + pad,
    })
  } else if (src.stockBlock) {
    const b = src.stockBlock
    const over = centre.x + reach >= b.min.x && centre.x - reach <= b.max.x &&
      centre.y + reach >= b.min.y && centre.y - reach <= b.max.y
    if (over && Number.isFinite(b.max.z)) surfaceZ = b.max.z
  }
  let materialZ = surfaceZ ?? ceilingZ ?? src.topZ
  if (ceilingZ !== undefined) materialZ = Math.min(materialZ, ceilingZ)
  return materialZ
}

/** WO-3083: one entry height for a whole operation - `clearance` above the highest material
 *  over the bounding square of `points` grown by `reach` (reads too high, never too low). For
 *  operations whose entries all sit on or beside one footprint (a contour, a faced region). */
export function entryStartOver(
  src: EntryMaterial, points: readonly Vec2[], reach: number, clearance = ENTRY_CLEARANCE_MM,
): number {
  if (points.length === 0) return src.topZ + clearance
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const p of points) {
    if (p.x < minX) minX = p.x
    if (p.y < minY) minY = p.y
    if (p.x > maxX) maxX = p.x
    if (p.y > maxY) maxY = p.y
  }
  const centre = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 }
  return entryAbove(materialUnder(src, centre, Math.max(maxX - minX, maxY - minY) / 2 + reach), clearance, src.feedZ)
}

/** WO-3083: one entry height for entries that all start on (or within `reach` of) a path - a
 *  contour's loops: `clearance` above the highest material under the paths' own footprint.
 *  Every segment is read along its length (a closed path's closing segment too), at no more
 *  than one stock cell apart, so material standing between two vertices is never missed. */
export function entryStartAlong(
  src: EntryMaterial, paths: readonly { readonly points: readonly Vec2[]; readonly closed?: boolean }[],
  reach: number, clearance = ENTRY_CLEARANCE_MM,
): number {
  const step = src.remaining ? src.remaining.resolutionMm : Math.max(reach, 0.5)
  let highest = -Infinity
  const read = (p: Vec2) => { highest = Math.max(highest, materialUnder(src, p, reach)) }
  for (const { points, closed } of paths) {
    const n = points.length
    for (let i = 0; i < n; i++) {
      const a = points[i]
      read(a)
      const b = i + 1 < n ? points[i + 1] : closed && n > 2 ? points[0] : undefined
      if (!b) continue
      const k = Math.min(100_000, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / step))
      for (let j = 1; j < k; j++) read({ x: a.x + (b.x - a.x) * j / k, y: a.y + (b.y - a.y) * j / k })
    }
  }
  return entryAbove(highest === -Infinity ? src.topZ : highest, clearance, src.feedZ)
}

/** WO-3083: where an entry descending to `floorZ` starts - `clearance` above the material
 *  under its footprint, never below `floorZ` + `clearance`. */
export function entryStartZ(
  src: EntryMaterial, centre: Vec2, reach: number, floorZ: number,
  opts: { ceilingZ?: number; clearance?: number } = {},
): number {
  const clearance = opts.clearance ?? ENTRY_CLEARANCE_MM
  return entryAbove(Math.max(materialUnder(src, centre, reach, opts.ceilingZ), floorZ), clearance, src.feedZ)
}

/** Rapid to point `p` at clearanceZ → retractZ → feedZ. The Retract stop is skipped when it
 *  would sit below the entry height (it would dip and climb again). */
export function rapidEntryAt(
  moves: ToolpathMove[], p: Vec2,
  feedZ: number, retractZ: number, clearanceZ: number
) {
  moves.push({ type: 'rapid', x: p.x, y: p.y, z: clearanceZ,   role: 'rapid' })
  if (retractZ >= feedZ) moves.push({ type: 'rapid', x: p.x, y: p.y, z: retractZ, role: 'rapid' })
  moves.push({ type: 'rapid', x: p.x, y: p.y, z: feedZ,    role: 'rapid' })
}

/** WO-3083 rule 2: carry the tool to `p` ready to enter from `startZ`. The operation's first
 *  entry (nothing emitted yet) comes down through Clearance; every later hop between the
 *  features of one operation rises only to Retract, crosses there and drops to `startZ`. A
 *  hop whose own corridor crosses workholding is lifted by the reach trim (raiseTraverses),
 *  not here. The builder makes the final exit to Clearance. */
export function hopTo(
  moves: ToolpathMove[], p: Vec2, startZ: number, retractZ: number, clearanceZ: number,
): void {
  const last = moves[moves.length - 1]
  if (!last) {
    rapidEntryAt(moves, p, startZ, retractZ, clearanceZ)
    return
  }
  // An entry that starts above Retract (an operator Retract set below the material) crosses at
  // its own start height: the hop never ends below where the entry begins.
  const travelZ = Math.max(retractZ, last.z, startZ)
  if (last.z < travelZ) moves.push({ type: 'rapid', x: last.x, y: last.y, z: travelZ, role: 'rapid' })
  moves.push({ type: 'rapid', x: p.x, y: p.y, z: travelZ, role: 'rapid' })
  if (startZ < travelZ) moves.push({ type: 'rapid', x: p.x, y: p.y, z: startZ, role: 'rapid' })
}

/** WO-3083 rule 2 for builders whose links all ride Clearance (contour, face): every hop
 *  between the operation's first entry and its last cut crosses at Retract instead. Only rapids
 *  AT Clearance are lowered; the first entry and the final exit keep Clearance; a hop that
 *  would leave below Retract lifts straight up first (never a climbing XY rapid); a lowered
 *  move that would not move at all is dropped. Workholding a hop's corridor crosses is lifted
 *  later by the reach trim (raiseTraverses), as for every other operation. */
export function hopsAtRetract(moves: ToolpathMove[], retractZ: number, clearanceZ: number): ToolpathMove[] {
  const EPS = 1e-9
  if (!(clearanceZ > retractZ + EPS)) return moves
  const isCut = (m: ToolpathMove) => m.type !== 'rapid'
  const first = moves.findIndex(isCut)
  let lastCut = -1
  for (let i = moves.length - 1; i >= 0; i--) if (isCut(moves[i])) { lastCut = i; break }
  if (first < 0) return moves
  const out: ToolpathMove[] = moves.slice(0, first)
  let changed = false
  for (let i = first; i < moves.length; i++) {
    const m = moves[i]
    const prev = out[out.length - 1]
    const lower = i < lastCut && m.type === 'rapid' && Math.abs(m.z - clearanceZ) <= EPS
    if (!lower) {
      // A rapid down to where a lowered hop already stands adds nothing.
      if (changed && prev && m.type === 'rapid' && prev.x === m.x && prev.y === m.y && Math.abs(prev.z - m.z) <= EPS) continue
      out.push(m)
      continue
    }
    changed = true
    if (!prev) { out.push({ ...m, z: retractZ }); continue }
    const moved = Math.hypot(m.x - prev.x, m.y - prev.y) > EPS
    if (moved && prev.z < retractZ - EPS) out.push({ ...m, x: prev.x, y: prev.y, z: retractZ })
    const at = out[out.length - 1]
    if (at.x === m.x && at.y === m.y && Math.abs(at.z - retractZ) <= EPS) continue
    out.push({ ...m, z: retractZ })
  }
  return changed ? out : moves
}

/** WO-3083 rule 2: rise straight up to Retract after a feature (the next hop crosses there). */
export function liftTo(moves: ToolpathMove[], z: number): void {
  const last = moves[moves.length - 1]
  if (!last || last.z >= z) return
  moves.push({ type: 'rapid', x: last.x, y: last.y, z, role: 'rapid' })
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

// -- Floor hop: the one reposition over a cleared floor (WO-2835) ----------------------------
// Every operation that repositions between two cuts over a floor it has proven cleared moves
// through here, so the shape and the height setting live in one place.

/** WO-2835 default floor-hop height (mm): the middle of the operator's 0.2-0.5 mm (2026-10-15). */
export const DEFAULT_FLOOR_HOP_MM = 0.3

/** The operation's floor-hop height from its linking settings: absent is the default, 0 turns
 *  the hop off (the operation keeps its legacy reposition), anything negative or not finite
 *  reads as the default. */
export function resolveFloorHopMm(linking: { floorHopMm?: number } | undefined): number {
  const value = linking?.floorHopMm
  return Number.isFinite(value) && (value as number) >= 0 ? (value as number) : DEFAULT_FLOOR_HOP_MM
}

/** WO-2835 (the operator 10-15: "3d move zup x/y move zdown", blended): the floor hop from `a` (the
 *  cut's end, at floor depth `z`) to `b`, as G0 rapids along the straight a -> b line. The
 *  rise and the descent each cover `hop` mm of XY (45 degrees), and the hold between them
 *  sits `hop` above the floor. A travel shorter than two rises becomes one peak at its
 *  midpoint. `land` ends the descent at `b` on the floor (the caller has proven `b` stands
 *  in air); otherwise the hop holds its height to `b` (rising more steeply when the travel
 *  is shorter than `hop`) and the caller's fed plunge or entry takes it from there.
 *
 *  Corner rounding: every segment here shares the a -> b XY line, so a controller blending
 *  the rise/hold/descent corners within its corner tolerance moves only in Z, inside the
 *  convex hull of segments that never go below the floor. The corners at `a` and `b` (cut ->
 *  hop, hop -> next cut) are the same corners the legacy traverse had. */
export function floorHop(
  moves: ToolpathMove[], a: { x: number; y: number }, b: { x: number; y: number },
  z: number, hop: number, land: boolean,
): void {
  floorHopAlong(moves, [a, b], z, hop, land)
}

/** The same hop along a travel polyline (`path[0]` is where the tool stands; WO-2787's routed
 *  keep-downs): Z rises 1:1 with the distance travelled up to `hop`, holds, and (when `land`)
 *  falls 1:1 over the last `hop` of the travel, so the XY route is the proven one, unchanged.
 *  Every vertex of the path is kept; the rise, hold and descent breakpoints are added. */
export function floorHopAlong(
  moves: ToolpathMove[], path: readonly { x: number; y: number }[],
  z: number, hop: number, land: boolean,
): void {
  const cum = [0]
  for (let i = 1; i < path.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(path[i].x - path[i - 1].x, path[i].y - path[i - 1].y))
  }
  const len = cum[cum.length - 1]
  const end = path[path.length - 1]
  if (!(len > 1e-9)) {
    if (!land && path.length > 0) moves.push({ type: 'rapid', x: end.x, y: end.y, z: z + hop, role: 'rapid' })
    return
  }
  const lift = (s: number): number => z + Math.max(0, land ? Math.min(s, hop, len - s) : Math.min(s, hop))
  const breaks = (land ? (len < 2 * hop ? [len / 2] : [hop, len - hop]) : [hop]).filter(s => s > 1e-9 && s < len - 1e-9)
  let next = 0
  for (let i = 1; i < path.length; i++) {
    const a = path[i - 1], b = path[i], sa = cum[i - 1], sb = cum[i]
    while (next < breaks.length && breaks[next] <= sb + 1e-12) {
      const s = breaks[next++]
      if (s <= sa + 1e-12 || s >= sb - 1e-12) continue
      const t = (s - sa) / (sb - sa)
      moves.push({ type: 'rapid', x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, z: lift(s), role: 'rapid' })
    }
    const last = i === path.length - 1
    moves.push({ type: 'rapid', x: b.x, y: b.y, z: last ? (land ? z : z + hop) : lift(sb), role: 'rapid' })
  }
}
