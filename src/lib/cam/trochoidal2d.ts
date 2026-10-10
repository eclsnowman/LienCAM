// WO-2289: the trochoidal orbit sampler and its geometry contract.
//
// A Contour's rough pass can cut a channel wider than the tool by moving the
// cutter in overlapping circular orbits whose centre advances along a GUIDE
// loop. Premise and method from PureCutCNC's planning/TROCHOIDAL_EDGE_DESIGN.md
// (Apache-2.0, Copyright 2026 Franja (Frank) Povazanj); reimplemented here in
// LienCAM's idiom - Y-up, millimetres, a world-fixed orbit phase - no code copied.
//
// With D the cutter diameter, W the channel width and S the radial stock to leave:
//
//   R           = (W - D) / 2        orbit radius of the tool centre
//   A           = 0.01 x D           allowance for the polyline sagitta
//   guideOffset = S + W / 2 + A      guide distance from the design boundary
//
// so the tool centre reaches at most guideOffset - R = D/2 + S + A toward the wall:
// exactly 0.01 D clear of where the Offset rough pass runs, inside and outside
// alike. Every guide point sits guideOffset from the boundary and every orbit
// point sits R from a guide point, so (distance is 1-Lipschitz) no orbit point is
// ever nearer the wall than that - the one expression the clearance rests on.
// Compute guideOffset once (trochoidalGuideOffset) and reuse it.
//
// Orbit sense (Y-up): climb keeps the material on the cutter's right
// (./millingDirection). The material is ahead of the orbit, and a COUNTER-
// clockwise orbit sweeps its leading edge leftward across it, so the material
// is on the cutter's right: climb -> CCW (+1), conventional -> CW (-1).

import type { Vec2 } from '../../types'

/** Largest distance an emitted chord may sit from the true orbit, as a fraction of D. */
export const ORBIT_SAGITTA_FRACTION = 0.0022
/** Guide allowance: covers the sagitta on both cut sides with room to spare. */
export const TROCHOIDAL_ALLOWANCE_FRACTION = 0.01
/** Longest chord an orbit is cut in, as a fraction of D. */
const ORBIT_CHORD_FRACTION = 0.1
/** A vanishing orbit stays a polygon, not a triangle. Never binds at W >= 1.15 D. */
const MIN_STEPS_PER_LOOP = 8

/** Channel width range and default, as ratios of the tool diameter. Below 1.15 D the
 *  orbit degenerates toward a plain contour while paying the full per-loop move count. */
export const TROCHOIDAL_MIN_WIDTH_RATIO = 1.15
export const TROCHOIDAL_MAX_WIDTH_RATIO = 2.5
export const TROCHOIDAL_DEFAULT_WIDTH_RATIO = 1.5
/** Advance per orbit range and default, as ratios of the tool diameter. Below 0.01 D an
 *  orbit retraces the same arc; above 0.5 D the loops stop overlapping into one channel. */
export const TROCHOIDAL_MIN_ADVANCE_RATIO = 0.01
export const TROCHOIDAL_MAX_ADVANCE_RATIO = 0.5
export const TROCHOIDAL_DEFAULT_ADVANCE_RATIO = 0.1

export interface TrochoidalGeometry {
  /** Channel width W (mm). */
  width: number
  /** Requested centre advance per orbit (mm). */
  advance: number
  /** Orbit radius R = (W - D) / 2 (mm). */
  orbitRadius: number
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v))

/**
 * The channel an operation asks for, resolved against its tool. An unset field
 * follows the tool (1.5 D wide, 0.1 D advance), so a different cutter re-derives
 * the channel; a set field is kept, snapped into its range.
 */
export function resolveTrochoidalGeometry(
  toolDiameter: number,
  width?: number,
  advance?: number,
): TrochoidalGeometry {
  const D = toolDiameter
  const w = Number.isFinite(width) ? (width as number) : D * TROCHOIDAL_DEFAULT_WIDTH_RATIO
  const a = Number.isFinite(advance) ? (advance as number) : D * TROCHOIDAL_DEFAULT_ADVANCE_RATIO
  const W = clamp(w, D * TROCHOIDAL_MIN_WIDTH_RATIO, D * TROCHOIDAL_MAX_WIDTH_RATIO)
  return {
    width: W,
    advance: clamp(a, D * TROCHOIDAL_MIN_ADVANCE_RATIO, D * TROCHOIDAL_MAX_ADVANCE_RATIO),
    orbitRadius: (W - D) / 2,
  }
}

/** The Channel width and Advance per orbit field limits for a tool (mm), shared by
 *  the New Operation dialog and the Properties panel so both lenses snap alike. */
export function trochoidalFieldLimits(toolDiameter: number): {
  width: { min: number; max: number }
  advance: { min: number; max: number }
} {
  const D = toolDiameter
  return {
    width: { min: D * TROCHOIDAL_MIN_WIDTH_RATIO, max: D * TROCHOIDAL_MAX_WIDTH_RATIO },
    advance: { min: D * TROCHOIDAL_MIN_ADVANCE_RATIO, max: D * TROCHOIDAL_MAX_ADVANCE_RATIO },
  }
}

/** guideOffset = S + W/2 + 0.01 D: the guide's distance from the design boundary. */
export function trochoidalGuideOffset(toolDiameter: number, width: number, stockToLeave: number): number {
  return Math.max(0, stockToLeave) + width / 2 + TROCHOIDAL_ALLOWANCE_FRACTION * toolDiameter
}

/** Orbit sense in Y-up for the planner's (cut-hand resolved) direction. */
export function orbitSenseFor(direction: 'climb' | 'conventional'): 1 | -1 {
  return direction === 'climb' ? 1 : -1
}

/**
 * Steps per orbit from the two bounds: no chord longer than 0.1 D, and no chord
 * further than 0.0022 D from the circle. A chord subtending 2t on radius R has
 * sagitta R(1 - cos t), so the half-angle allowed is acos(1 - tol / R). The two
 * cross near R = 0.57 D; the chord cap governs above it, the sagitta below.
 */
export function orbitStepsPerLoop(orbitRadius: number, toolDiameter: number): number {
  const chordSteps = Math.ceil(2 * Math.PI * orbitRadius / (toolDiameter * ORBIT_CHORD_FRACTION))
  const tol = toolDiameter * ORBIT_SAGITTA_FRACTION
  const sagittaSteps = tol < orbitRadius ? Math.ceil(Math.PI / Math.acos(1 - tol / orbitRadius)) : MIN_STEPS_PER_LOOP
  return Math.max(MIN_STEPS_PER_LOOP, chordSteps, sagittaSteps)
}

export interface TrochoidOptions {
  orbitRadius: number
  /** Requested centre advance per orbit (mm); rounded so a whole number of orbits closes the guide. */
  advance: number
  toolDiameter: number
  /** +1 counter-clockwise (climb), -1 clockwise (conventional), Y-up. */
  sense: 1 | -1
}

export interface Trochoid {
  /** Tool-centre points. points[0] = guide[0] + (R, 0); on a closed guide the last
   *  point is points[0] again, so the seam closes with no ridge (an open guide's
   *  ends: buildOpenTrochoid). The first stepsPerLoop moves are a stationary orbit
   *  that clears the entry bore before the centre advances. */
  points: Vec2[]
  /** Guide arc distance of each point's orbit centre (0 through the stationary orbit). */
  centreDistance: number[]
  loopCount: number
  /** guideLength / loopCount: the advance actually cut, within a fraction of the request. */
  actualAdvance: number
  stepsPerLoop: number
  guideLength: number
}

interface ClosedPath { points: Vec2[]; cumulative: number[]; length: number }

function closedPath(guide: readonly Vec2[]): ClosedPath | null {
  const points: Vec2[] = []
  for (const p of guide) {
    const last = points[points.length - 1]
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) points.push({ x: p.x, y: p.y })
  }
  while (points.length > 1 && Math.hypot(
    points[0].x - points[points.length - 1].x, points[0].y - points[points.length - 1].y) <= 1e-9) {
    points.pop()
  }
  if (points.length < 3) return null
  const cumulative = [0]
  let length = 0
  for (let i = 0; i < points.length; i++) {
    const a = points[i]
    const b = points[(i + 1) % points.length]
    length += Math.hypot(b.x - a.x, b.y - a.y)
    cumulative.push(length)
  }
  return length > 1e-9 ? { points, cumulative, length } : null
}

/** Point at arc distance `d` along a closed guide (wraps). */
function pointAlongClosed(path: ClosedPath, d: number): Vec2 {
  let s = d % path.length
  if (s < 0) s += path.length
  let lo = 0
  let hi = path.points.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (path.cumulative[mid] <= s) lo = mid
    else hi = mid - 1
  }
  const a = path.points[lo]
  const b = path.points[(lo + 1) % path.points.length]
  const seg = path.cumulative[lo + 1] - path.cumulative[lo]
  const t = seg > 1e-12 ? (s - path.cumulative[lo]) / seg : 0
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** Arc distance along the closed guide of the guide point nearest `p`. */
export function nearestGuideDistance(guide: readonly Vec2[], p: Vec2): number {
  const path = closedPath(guide)
  if (!path) return 0
  let best = Infinity
  let bestD = 0
  for (let i = 0; i < path.points.length; i++) {
    const a = path.points[i]
    const b = path.points[(i + 1) % path.points.length]
    const dx = b.x - a.x
    const dy = b.y - a.y
    const len2 = dx * dx + dy * dy
    const t = len2 > 1e-18 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / len2, 0, 1) : 0
    const dist = Math.hypot(a.x + dx * t - p.x, a.y + dy * t - p.y)
    if (dist < best) {
      best = dist
      bestD = path.cumulative[i] + t * (path.cumulative[i + 1] - path.cumulative[i])
    }
  }
  return bestD
}

/** Guide length of a closed loop (mm). */
export function closedLength(guide: readonly Vec2[]): number {
  return closedPath(guide)?.length ?? 0
}

/** Rotate a closed guide so arc distance `d0` becomes its first point. */
export function reseamClosed(guide: readonly Vec2[], d0: number): Vec2[] {
  const path = closedPath(guide)
  if (!path) return guide.slice()
  const start = pointAlongClosed(path, d0)
  let s = d0 % path.length
  if (s < 0) s += path.length
  const out: Vec2[] = [start]
  const n = path.points.length
  let i = 0
  while (i < n - 1 && path.cumulative[i + 1] <= s) i++
  for (let k = 1; k <= n; k++) {
    const p = path.points[(i + k) % n]
    const prev = out[out.length - 1]
    if (Math.hypot(p.x - prev.x, p.y - prev.y) <= 1e-9) continue
    if (Math.hypot(p.x - start.x, p.y - start.y) <= 1e-9) continue
    out.push(p)
  }
  return out
}

/**
 * Overlapping orbits around a closed guide. The orbit phase is fixed to the world
 * (phase 0 = +X) rather than to the guide's tangent, so a sharp guide corner never
 * spins the orbit and every chord keeps the sampling bound. loopCount is a whole
 * number, so the centre and the phase both return to the start at the seam.
 * Returns null for a guide or orbit that cannot carry one.
 */
export function buildTrochoid(guide: readonly Vec2[], o: TrochoidOptions): Trochoid | null {
  const path = closedPath(guide)
  if (!path || !(o.orbitRadius > 0) || !(o.advance > 0) || !(o.toolDiameter > 0)) return null
  const R = o.orbitRadius
  const loopCount = Math.max(1, Math.ceil(path.length / o.advance))
  const actualAdvance = path.length / loopCount
  const stepsPerLoop = orbitStepsPerLoop(R, o.toolDiameter)
  const moving = loopCount * stepsPerLoop
  const at = (c: Vec2, step: number): Vec2 => {
    const phase = o.sense * 2 * Math.PI * step / stepsPerLoop
    return { x: c.x + R * Math.cos(phase), y: c.y + R * Math.sin(phase) }
  }

  const c0 = path.points[0]
  const points: Vec2[] = [at(c0, 0)]
  const centreDistance: number[] = [0]
  for (let step = 1; step <= stepsPerLoop; step++) {
    points.push(at(c0, step))
    centreDistance.push(0)
  }
  for (let step = 1; step <= moving; step++) {
    const d = path.length * step / moving
    points.push(at(pointAlongClosed(path, d), step))
    centreDistance.push(d)
  }
  points[points.length - 1] = { ...points[0] }
  return { points, centreDistance, loopCount, actualAdvance, stepsPerLoop, guideLength: path.length }
}

// -- Open guides (WO-2299) ------------------------------------------------------
//
// Engrave's Trochoidal style cuts a slot W wide centred on an OPEN curve: the
// guide is the curve itself. The orbit centre runs from the first point to the
// last, so the slot's swept edge reaches R + D/2 = W/2 from the curve everywhere
// and rounds each end on a half-circle centred at the curve's end point - never
// further past it than W/2. The cut opens with a stationary orbit at the start
// (the entry bore, inside the slot) and closes with one at the end, so both end
// caps are cut whole. The phase stays world-fixed as on a closed guide.

interface OpenPath { points: Vec2[]; cumulative: number[]; length: number }

function openPath(guide: readonly Vec2[]): OpenPath | null {
  const points: Vec2[] = []
  for (const p of guide) {
    const last = points[points.length - 1]
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 1e-9) points.push({ x: p.x, y: p.y })
  }
  if (points.length < 2) return null
  const cumulative = [0]
  let length = 0
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y)
    cumulative.push(length)
  }
  return length > 1e-9 ? { points, cumulative, length } : null
}

/** Point at arc distance `d` along an open guide (clamped to its ends). */
function pointAlongOpen(path: OpenPath, d: number): Vec2 {
  const s = clamp(d, 0, path.length)
  let lo = 0
  let hi = path.points.length - 2
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (path.cumulative[mid] <= s) lo = mid
    else hi = mid - 1
  }
  const a = path.points[lo]
  const b = path.points[lo + 1]
  const seg = path.cumulative[lo + 1] - path.cumulative[lo]
  const t = seg > 1e-12 ? (s - path.cumulative[lo]) / seg : 0
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }
}

/** Guide length of an open curve (mm). */
export function openLength(guide: readonly Vec2[]): number {
  return openPath(guide)?.length ?? 0
}

/**
 * Overlapping orbits along an open guide, start to end. Same sampling as
 * buildTrochoid: world-fixed phase, a whole number of orbits (advance rounded down
 * to fit), every chord within the sagitta bound. The trochoid's points[0] is
 * guide[0] + (R, 0); the first stepsPerLoop moves are a stationary orbit at the
 * start and the last stepsPerLoop a stationary orbit at the end, which finishes on
 * guide[last] + (R, 0). Returns null for a guide or orbit that cannot carry one.
 */
export function buildOpenTrochoid(guide: readonly Vec2[], o: TrochoidOptions): Trochoid | null {
  const path = openPath(guide)
  if (!path || !(o.orbitRadius > 0) || !(o.advance > 0) || !(o.toolDiameter > 0)) return null
  const R = o.orbitRadius
  const loopCount = Math.max(1, Math.ceil(path.length / o.advance))
  const actualAdvance = path.length / loopCount
  const stepsPerLoop = orbitStepsPerLoop(R, o.toolDiameter)
  const moving = loopCount * stepsPerLoop
  const at = (c: Vec2, step: number): Vec2 => {
    const phase = o.sense * 2 * Math.PI * step / stepsPerLoop
    return { x: c.x + R * Math.cos(phase), y: c.y + R * Math.sin(phase) }
  }

  const c0 = path.points[0]
  const c1 = path.points[path.points.length - 1]
  const points: Vec2[] = [at(c0, 0)]
  const centreDistance: number[] = [0]
  for (let step = 1; step <= stepsPerLoop; step++) {
    points.push(at(c0, step))
    centreDistance.push(0)
  }
  for (let step = 1; step <= moving; step++) {
    const d = path.length * step / moving
    points.push(at(step === moving ? c1 : pointAlongOpen(path, d), step))
    centreDistance.push(d)
  }
  for (let step = 1; step <= stepsPerLoop; step++) {
    points.push(at(c1, step))
    centreDistance.push(path.length)
  }
  return { points, centreDistance, loopCount, actualAdvance, stepsPerLoop, guideLength: path.length }
}
