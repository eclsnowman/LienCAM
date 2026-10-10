/**
 * Copyright 2026 Franja (Frank) Povazanj
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Modified by LienCAM, 2026 (WO-2291): adapted from PureCutCNC
 * src/engine/toolpaths/engagement.ts (head 1597362). Kept the capsule closed
 * forms, the nominal engagement, the feed rung ladder and the quantizer's
 * hysteresis/rise gate; dropped the telemetry accumulator and the
 * fragment-merge pricing; the quantizer reports the scale per sample instead
 * of emitting fragments; units are mm; re-tested on LienCAM's Y-up frame.
 */

// engagement2d.ts - cutter engagement against the material earlier passes at
// the same Z level already swept, and the feed scale it earns.
//
// Engagement is the angular measure, in [0, pi], of the cutter's LEADING
// semicircle (the half centred on the motion direction) that lies in material
// not yet swept. A full slot is pi; a cutter sitting wholly in cut space is 0.
// A query with no prior sweep nearby reads pi: virgin stock is full engagement.
//
// Prior sweeps are capsules of the tool radius, one per swept straight segment:
// two radius-r endpoint discs and the rectangle between them, each in closed
// form. Wherever the estimate is uncertain (degenerate input, a zero-length
// sweep, anything the index cannot see) it resolves toward MORE engagement, so
// toward the lower feed.
//
// Endpoint disc: query centre C, disc centre Q, v = Q - C, D = |v|. A cutter
// circle point C + r*u(theta) lies in the disc iff cos(theta - atan2(v)) >= D/(2r),
// so the covered arc is [phi - h, phi + h] with h = acos(D / 2r), empty past 2r.
//
// Body rectangle: e the unit vector A->B, n its perpendicular, w = C - A,
// L = |B - A|, alpha measured from e. A circle point is inside iff
//   e.w + r cos(alpha) in [0, L]   and   |n.w + r sin(alpha)| <= r,
// two interval constraints on cos/sin, each at most two arcs.
//
// Check: a straight pass parallel to a prior pass at radial depth a reads
// arccos(1 - a/r) (0 at a = 0, pi/2 at a = r, pi at a = 2r).

const ZERO_LENGTH_EPS = 1e-9
const DEGENERATE_DIRECTION_EPS = 1e-12

/**
 * The feed rung ladder as cumulative fractions of the drop (1 - slotScale)
 * measured down from full feed: rung k = 1 - FRACTIONS[k] * (1 - slotScale).
 * Few rungs on purpose: post arc fitting joins only moves of equal feed, so a
 * continuous feed would shatter every run. Finer at the top, where laps a few
 * percent over nominal sit.
 */
const FEED_RUNG_DROP_FRACTIONS = [0, 0.05, 0.1, 0.2, 0.4, 0.6, 0.8, 1]

/** The feed scales a slot scale emits, descending from 1 to slotScale. */
export function engagementFeedRungs(slotScale: number): number[] {
  const clamped = Math.min(1, Math.max(0, slotScale))
  const drop = 1 - clamped
  return FEED_RUNG_DROP_FRACTIONS.map(fraction => clamped + drop * (1 - fraction))
}

/**
 * Worst-case over-report of the closed forms (acos/asin amplify ~16 ulp of
 * argument error into sqrt(2 * 16 * eps) rad); engagement within this of
 * nominal counts as nominal.
 */
export const ENGAGEMENT_ESTIMATE_EPSILON = Math.sqrt(2 * 16 * Number.EPSILON)

interface PriorSweep {
  ax: number; ay: number; bx: number; by: number
  dx: number; dy: number; length: number; lengthSq: number
  /** Per-query de-duplication marker (a long sweep sits in several cells). */
  queryMark: number
}

/** Sorted union of arcs clipped into the leading semicircle [-pi/2, pi/2]. */
class LeadingIntervalUnion {
  private readonly intervals: Array<[number, number]> = []

  clear(): void { this.intervals.length = 0 }

  /** Add an interval; true when the union now covers the whole semicircle. */
  add(lo: number, hi: number): boolean {
    let index = 0
    while (index < this.intervals.length && this.intervals[index][1] < lo) index++
    if (index === this.intervals.length || this.intervals[index][0] > hi) {
      this.intervals.splice(index, 0, [lo, hi])
    } else {
      const current = this.intervals[index]
      current[0] = Math.min(current[0], lo)
      current[1] = Math.max(current[1], hi)
      while (index + 1 < this.intervals.length && this.intervals[index + 1][0] <= current[1]) {
        current[1] = Math.max(current[1], this.intervals[index + 1][1])
        this.intervals.splice(index + 1, 1)
      }
    }
    return this.intervals.length === 1
      && this.intervals[0][0] <= -Math.PI / 2
      && this.intervals[0][1] >= Math.PI / 2
  }

  engagement(): number {
    let covered = 0
    for (const [lo, hi] of this.intervals) covered += hi - lo
    return Math.min(Math.PI, Math.max(0, Math.PI - covered))
  }
}

/**
 * Clip a covered arc [arcLo, arcHi] (absolute angles, width <= 2pi) to the
 * leading semicircle around direction psi and add the pieces.
 */
function pushLeadingClip(arcLo: number, arcHi: number, psi: number, intervals: LeadingIntervalUnion): boolean {
  let s = arcLo - psi
  while (s < -Math.PI) s += 2 * Math.PI
  while (s >= Math.PI) s -= 2 * Math.PI
  const hi = s + (arcHi - arcLo)
  const firstLo = Math.max(s, -Math.PI / 2)
  const firstHi = Math.min(hi, Math.PI / 2)
  if (firstLo < firstHi && intervals.add(firstLo, firstHi)) return true
  if (hi > (3 * Math.PI) / 2) {
    const wrapHi = hi - 2 * Math.PI
    if (wrapHi > -Math.PI / 2 && intervals.add(-Math.PI / 2, wrapHi)) return true
  }
  return false
}

/** Normalised arc set [lo, hi) on [0, 2pi), split at the wrap: up to two arcs. */
function normalizedRange(from: number, to: number): Array<[number, number]> {
  const twoPi = 2 * Math.PI
  if (to - from >= twoPi) return [[0, twoPi]]
  let lo = from
  while (lo < 0) lo += twoPi
  while (lo >= twoPi) lo -= twoPi
  const hi = lo + (to - from)
  return hi <= twoPi ? [[lo, hi]] : [[lo, twoPi], [0, hi - twoPi]]
}

function clipArcs(active: Array<[number, number]>, lo: number, hi: number): Array<[number, number]> {
  const next: Array<[number, number]> = []
  for (const [a0, a1] of active) {
    for (const [c0, c1] of normalizedRange(lo, hi)) {
      const from = Math.max(a0, c0)
      const to = Math.min(a1, c1)
      if (from < to) next.push([from, to])
    }
  }
  return next
}

/**
 * Prior sweeps of one Z level on a grid of side 2r. A sweep is stored in every
 * cell its centreline crosses; a query scans its own 3x3 block, which holds
 * every sweep point within 2r of it.
 */
export class SweptMaterialIndex {
  private readonly cells = new Map<string, PriorSweep[]>()
  private readonly radius: number
  private readonly cellSize: number
  private queryMark = 0
  private readonly leading = new LeadingIntervalUnion()

  constructor(toolRadius: number) {
    if (!Number.isFinite(toolRadius) || toolRadius <= 0) {
      throw new RangeError(`SweptMaterialIndex: toolRadius must be a positive finite number, got ${toolRadius}`)
    }
    this.radius = toolRadius
    this.cellSize = 2 * toolRadius
  }

  /** Record the straight sweep A -> B. Zero-length sweeps are skipped (more engagement). */
  addSweptSegment(ax: number, ay: number, bx: number, by: number): void {
    const dx = bx - ax
    const dy = by - ay
    const length = Math.hypot(dx, dy)
    if (length <= ZERO_LENGTH_EPS) return
    const sweep: PriorSweep = { ax, ay, bx, by, dx, dy, length, lengthSq: dx * dx + dy * dy, queryMark: -1 }
    for (const key of this.cellKeys(sweep)) {
      const bucket = this.cells.get(key)
      if (bucket) bucket.push(sweep)
      else this.cells.set(key, [sweep])
    }
  }

  private cellKeys(sweep: PriorSweep): Set<string> {
    const c = this.cellSize
    const { dx, dy } = sweep
    const crossings: number[] = [0, 1]
    if (Math.abs(dx) > ZERO_LENGTH_EPS) {
      const minX = Math.min(sweep.ax, sweep.bx), maxX = Math.max(sweep.ax, sweep.bx)
      for (let k = Math.floor(minX / c) + 1; k * c < maxX; k++) {
        const t = (k * c - sweep.ax) / dx
        if (t > 0 && t < 1) crossings.push(t)
      }
    }
    if (Math.abs(dy) > ZERO_LENGTH_EPS) {
      const minY = Math.min(sweep.ay, sweep.by), maxY = Math.max(sweep.ay, sweep.by)
      for (let k = Math.floor(minY / c) + 1; k * c < maxY; k++) {
        const t = (k * c - sweep.ay) / dy
        if (t > 0 && t < 1) crossings.push(t)
      }
    }
    crossings.sort((p, q) => p - q)
    const keys = new Set<string>()
    for (let i = 0; i + 1 < crossings.length; i++) {
      const t = (crossings[i] + crossings[i + 1]) / 2
      keys.add(`${Math.floor((sweep.ax + dx * t) / c)},${Math.floor((sweep.ay + dy * t) / c)}`)
    }
    return keys
  }

  /**
   * Engagement (rad, [0, pi]) of a cutter centred at (x, y) moving along
   * (dirX, dirY). Degenerate input or no sweep in range reads pi.
   */
  engagementAt(x: number, y: number, dirX: number, dirY: number): number {
    if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(dirX) || !Number.isFinite(dirY)) return Math.PI
    const dirLength = Math.hypot(dirX, dirY)
    if (dirLength <= DEGENERATE_DIRECTION_EPS) return Math.PI
    const fx = dirX / dirLength
    const fy = dirY / dirLength
    const psi = Math.atan2(fy, fx)
    const col = Math.floor(x / this.cellSize)
    const row = Math.floor(y / this.cellSize)
    const intervals = this.leading
    intervals.clear()
    const mark = ++this.queryMark
    let foundAny = false
    for (let dc = -1; dc <= 1; dc++) {
      for (let dr = -1; dr <= 1; dr++) {
        const bucket = this.cells.get(`${col + dc},${row + dr}`)
        if (!bucket) continue
        foundAny = true
        for (const sweep of bucket) {
          if (sweep.queryMark === mark) continue
          sweep.queryMark = mark
          if (this.addCapsuleArcs(sweep, x, y, psi, fx, fy, intervals)) return 0
        }
      }
    }
    if (!foundAny) return Math.PI
    return intervals.engagement()
  }

  /** Add one capsule's covered arcs; true when the leading semicircle is all covered. */
  private addCapsuleArcs(
    sweep: PriorSweep, x: number, y: number, psi: number, fx: number, fy: number,
    intervals: LeadingIntervalUnion,
  ): boolean {
    const r = this.radius
    // A centreline more than r behind the cutter cannot reach its leading half.
    const forwardExtent = Math.max((sweep.ax - x) * fx + (sweep.ay - y) * fy, (sweep.bx - x) * fx + (sweep.by - y) * fy)
    if (forwardExtent < -r) return false
    const { dx, dy, lengthSq, length } = sweep
    const t = Math.max(0, Math.min(1, ((x - sweep.ax) * dx + (y - sweep.ay) * dy) / lengthSq))
    const px = sweep.ax + dx * t - x
    const py = sweep.ay + dy * t - y
    if (px * px + py * py > 4 * r * r) return false
    if (this.addDiscArcs(sweep.ax, sweep.ay, x, y, psi, intervals)) return true
    if (this.addDiscArcs(sweep.bx, sweep.by, x, y, psi, intervals)) return true
    const ex = dx / length, ey = dy / length
    const wx = x - sweep.ax, wy = y - sweep.ay
    const along = ex * wx + ey * wy
    const perp = -ey * wx + ex * wy
    if (along <= -r || along >= length + r || perp <= -2 * r || perp >= 2 * r) return false
    const cLo = -along / r
    const cHi = (length - along) / r
    const sLo = -(r + perp) / r
    const sHi = (r - perp) / r
    if (cLo > cHi || sLo > sHi) return false
    const phiE = Math.atan2(ey, ex)
    const loC = Math.max(-1, Math.min(1, cLo))
    const hiC = Math.max(-1, Math.min(1, cHi))
    const loS = Math.max(-1, Math.min(1, sLo))
    const hiS = Math.max(-1, Math.min(1, sHi))
    // Angles here are measured from e; start from the leading half only.
    let arcs = normalizedRange(psi - phiE - Math.PI / 2, psi - phiE + Math.PI / 2)
    if (loC > -1) arcs = clipArcs(arcs, -Math.acos(loC), Math.acos(loC))
    if (hiC < 1) {
      const bound = Math.acos(hiC)
      arcs = clipArcs(arcs, bound, 2 * Math.PI - bound)
    }
    if (loS > -1) {
      const bound = Math.asin(loS)
      arcs = clipArcs(arcs, bound, Math.PI - bound)
    }
    if (hiS < 1) {
      const bound = Math.asin(hiS)
      arcs = clipArcs(arcs, Math.PI - bound, 2 * Math.PI + bound)
    }
    for (const [lo, hi] of arcs) {
      if (pushLeadingClip(phiE + lo, phiE + hi, psi, intervals)) return true
    }
    return false
  }

  private addDiscArcs(qx: number, qy: number, x: number, y: number, psi: number, intervals: LeadingIntervalUnion): boolean {
    const vx = qx - x
    const vy = qy - y
    const dSq = vx * vx + vy * vy
    const twoR = 2 * this.radius
    if (dSq > twoR * twoR) return false
    if (vx === 0 && vy === 0) return true
    const h = Math.acos(Math.min(1, Math.max(-1, Math.sqrt(dSq) / twoR)))
    const arcLo = Math.atan2(vy, vx) - h
    return pushLeadingClip(arcLo, arcLo + 2 * h, psi, intervals)
  }
}

/** Engagement a stepover gives a straight pass: arccos(1 - stepover / r), in [0, pi]. */
export function nominalEngagement(stepover: number, toolRadius: number): number {
  if (!Number.isFinite(toolRadius) || toolRadius <= 0) {
    throw new RangeError(`nominalEngagement: toolRadius must be a positive finite number, got ${toolRadius}`)
  }
  return Math.acos(Math.min(1, Math.max(-1, 1 - stepover / toolRadius)))
}

/** Unquantised scale: 1 at or below nominal, linear down to slotScale at pi. */
function continuousFeedScale(engagement: number, nominal: number, slotScale: number): number {
  if (engagement <= nominal || !(nominal < Math.PI)) return 1
  const t = (Math.min(engagement, Math.PI) - nominal) / (Math.PI - nominal)
  return 1 + (slotScale - 1) * t
}

/**
 * Feed scale an engagement earns: exactly 1 at or below nominal (plus the
 * estimate deadband), otherwise linear from 1 at nominal to slotScale at pi,
 * rounded DOWN onto the rung ladder. Never above 1, never below slotScale.
 */
export function engagementFeedScale(engagement: number, nominal: number, slotScale: number): number {
  if (!(engagement > nominal + ENGAGEMENT_ESTIMATE_EPSILON)) return 1
  const clampedSlot = Math.min(1, Math.max(0, slotScale))
  if (clampedSlot >= 1 || !(nominal < Math.PI)) return 1
  const continuous = continuousFeedScale(engagement, nominal, clampedSlot)
  for (const rung of engagementFeedRungs(clampedSlot)) {
    if (rung <= continuous + 1e-12) return rung
  }
  return clampedSlot
}

/** Share of a rung's width the raw scale must clear before the feed rises into it. */
const HYSTERESIS_FRACTION = 0.25
/** Floor on that margin, as a share of the whole drop (1 - slotScale). */
const MIN_HYSTERESIS_DROP_FRACTION = 0.05
/** A rise of more than one rung (material fell away, not chatter) holds only this share of the minimum stretch. */
const MULTI_RUNG_RISE_BAR_FRACTION = 0.25

/**
 * Turns engagement samples along a path into feed scales a controller and the
 * post's arc fitting can live with. A drop to a lower rung is immediate (a
 * feed reduction is never delayed); a rise waits until the held stretch is at
 * least `minStretch` long (a quarter of that for a multi-rung rise) and the
 * raw scale sits a hysteresis margin inside the higher rung. A rise to full
 * feed waits only for the estimate deadband. Every hold keeps the lower feed.
 */
export class EngagementFeedQuantizer {
  private readonly nominal: number
  private readonly slotScale: number
  private readonly rungs: number[]
  private readonly minStretch: number
  private current: number | null = null
  private held = 0

  constructor(options: { nominal: number; slotScale: number; minStretch: number }) {
    this.nominal = options.nominal
    this.slotScale = Math.min(1, Math.max(0, options.slotScale))
    this.rungs = engagementFeedRungs(this.slotScale)
    this.minStretch = Math.max(0, options.minStretch)
  }

  /** Start a new stretch (a path broken by a non-cut move). */
  reset(): void {
    this.current = null
    this.held = 0
  }

  private rungIndex(scale: number): number {
    return this.rungs.findIndex(rung => Math.abs(rung - scale) <= 1e-12)
  }

  /** Feed `distance` mm cut at `engagement` rad; returns the scale that stretch runs at. */
  push(engagement: number, distance: number): number {
    const clamped = Math.min(Math.PI, Math.max(0, Number.isFinite(engagement) ? engagement : Math.PI))
    const step = Math.max(0, distance)
    const raw = engagementFeedScale(clamped, this.nominal, this.slotScale)
    if (this.current === null || raw < this.current) {
      this.current = raw
      this.held = step
      return raw
    }
    if (raw === this.current) {
      this.held += step
      return raw
    }
    if (raw >= 1) {
      this.current = 1
      this.held = step
      return 1
    }
    const index = this.rungIndex(raw)
    const width = index === this.rungs.length - 1 ? this.rungs[index - 1] - this.rungs[index] : this.rungs[index] - this.rungs[index + 1]
    const gapAbove = this.rungs[index - 1] - this.rungs[index]
    const margin = Math.min(gapAbove / 2, Math.max(HYSTERESIS_FRACTION * width, MIN_HYSTERESIS_DROP_FRACTION * (1 - this.slotScale)))
    const oneRung = Math.abs(index - this.rungIndex(this.current)) <= 1
    const bar = this.minStretch * (oneRung ? 1 : MULTI_RUNG_RISE_BAR_FRACTION)
    const continuous = continuousFeedScale(clamped, this.nominal, this.slotScale)
    if (continuous >= raw + margin && this.held >= bar - 1e-9) {
      this.current = raw
      this.held = step
      return raw
    }
    this.held += step
    return this.current
  }
}
