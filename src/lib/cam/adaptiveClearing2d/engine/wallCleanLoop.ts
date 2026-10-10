// SPDX-License-Identifier: LGPL-2.1-or-later
// Ported from FreeCAD's Adaptive2d (src/Mod/CAM/libarea/Adaptive.cpp and Path Adaptive Python), Copyright (c) 2018 Kresimir Tusek.
// This file remains under LGPL-2.1-or-later; the LienCAM project as a whole is distributed under GPL-3.0-or-later (see /LICENSE).
// "Wall cleanup as we go" transition geometry.
//
// A wall-clean transition replaces the link between two adjacent wall-reaching cut passes
// with up to three pieces:
//   priorCut.end (A, on a cutRegion loop) -> wall-follow EXIT (rides A's loop) -> E
//   [optional] loopback: fillet1 -> fast-traverse -> fillet2  (E -> F, over cleared stock)
//   F <- wall-follow ENTRY (rides B's loop) <- nextCut.start (B, on a cutRegion loop)
//
// SAFETY (defect-fix rationale, 2026-06-09):
//   The wall-follow EXIT and ENTRY are built by WALKING THE ACTUAL cutRegion LOOP POLYLINE
//   the arc-end projects onto, vertex by vertex, in the cut-continuation winding. Because the
//   ride is literally a sub-polyline of a cutRegion boundary loop, it is GUARANTEED on the
//   boundary -- it can never leave the region or cross a hole, and it never jumps between
//   loops (a ride stays on the single loop its arc-end sits on).
//
//   The optional LOOPBACK between the two far ends (E, F) is a straight fast-traverse capped by
//   two tangent fillets. It is built ONLY when E and F lie on the SAME loop; the CALLER decides
//   whether to emit it at all using the engine's existing keep-down vs lift safety check, then
//   verifies every emitted point is inside cutRegion (ADR-0003 fail-loud). When E and F are on
//   different loops (outer wall vs island), no loopback is built -- the caller lifts instead.
//
//   This replaces the prior chord-based construction (a straight chord between two projected
//   points), which could escape the region near concavities or the island -- the observed
//   "paths outside the boundary" defect.
//
// PURE clipper2-wasm-free / OCCT-free: only analytic geometry + sampleArc.

import type { Pt, Loop, Loops } from './clipperEngine'
import { sampleArc } from '../../geometry'

/** A wall-follow ride: a sub-polyline of ONE cutRegion loop (guaranteed on the boundary). */
export interface WallFollowRide {
  points: Pt[]   // exit: starts at the arc end A; entry: ends at the arc start B
  far: Pt        // the far end of the ride (away from A / B)
  loop: number   // the cutRegion loop index this ride sits on
}

/** The optional loopback joining two wall-follow far ends over cleared stock. */
export interface Loopback {
  fillet1: Pt[]   // tangent fillet at E: fillet1[0] == E
  traverse: Pt[]  // straight fast-traverse: traverse[0] == fillet1[last]
  fillet2: Pt[]   // tangent fillet at F: fillet2[0] == traverse[last], fillet2[last] == F
}

/** Full wall-clean transition (exit ride + loopback + entry ride), as a flat 5-piece chain. */
export interface WallCleanTransition {
  exit: Pt[]
  fillet1: Pt[]
  traverse: Pt[]
  fillet2: Pt[]
  entry: Pt[]
}

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
function unit(v: Pt): Pt { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m } }
function tangentAtStart(p: Pt[]): Pt { return unit(sub(p[1], p[0])) }
function tangentAtEnd(p: Pt[]): Pt { return unit(sub(p[p.length - 1], p[p.length - 2])) }
/** Angle (deg) between two near-coincident-safe directions a->b across points; 0 if degenerate. */
function jointKinkDeg(pA: Pt, pB: Pt, t: Pt): number {
  if (dist(pA, pB) < 1e-9) return 0
  const d = unit(sub(pB, pA))
  const dd = Math.max(-1, Math.min(1, d.x * t.x + d.y * t.y))
  return Math.acos(dd) * 180 / Math.PI
}

export interface WallProj { d: number; foot: Pt; loop: number; seg: number }
/** Nearest point on any cutRegion loop edge to p, with the loop + segment it sits on. */
export function nearestOnLoops(p: Pt, loops: Loops): WallProj {
  let best: WallProj = { d: Infinity, foot: p, loop: -1, seg: -1 }
  for (let li = 0; li < loops.length; li++) {
    const lp = loops[li]
    for (let i = 0; i < lp.length; i++) {
      const a = lp[i], b = lp[(i + 1) % lp.length]
      const ab = sub(b, a); const L2 = ab.x * ab.x + ab.y * ab.y
      let t = L2 > 1e-12 ? ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / L2 : 0
      t = Math.max(0, Math.min(1, t))
      const foot = { x: a.x + ab.x * t, y: a.y + ab.y * t }
      const d = dist(p, foot)
      if (d < best.d) best = { d, foot, loop: li, seg: i }
    }
  }
  return best
}

function loopPerimeter(lp: Loop): number {
  let s = 0
  for (let i = 0; i < lp.length; i++) s += dist(lp[i], lp[(i + 1) % lp.length])
  return s
}

/** Walk the closed loop from `startFoot` (on segment startSeg) in the ride direction
 *  (sign +1 = increasing vertex index, -1 = decreasing) for `length` mm. Returns the
 *  sampled polyline starting at startFoot -- a TRUE sub-polyline of the loop, so every
 *  point is on the boundary by construction. */
function rideAlongLoop(lp: Loop, startSeg: number, startFoot: Pt, sign: number, length: number): Pt[] {
  const n = lp.length
  const out: Pt[] = [startFoot]
  let remaining = length
  let seg = startSeg
  let cur = startFoot
  let guard = 0
  while (remaining > 1e-9 && guard++ < 4 * n) {
    const vIdx = sign > 0 ? (seg + 1) % n : seg
    const v = lp[vIdx]
    const d = dist(cur, v)
    if (d <= remaining) {
      out.push(v); remaining -= d; cur = v
      seg = sign > 0 ? (seg + 1) % n : (seg - 1 + n) % n
    } else {
      const dir = unit(sub(v, cur))
      out.push({ x: cur.x + dir.x * remaining, y: cur.y + dir.y * remaining })
      remaining = 0
    }
  }
  return out
}

/** Default wall-follow ride length: reaches a neighbour wall node plus an overlap that is at
 *  least the loopback fillet radius, clamped to a safe fraction of the loop perimeter so a
 *  ride never wraps. cuspGap (the straight A..B separation) folds in the adjacent-cusp sliver. */
function rideBudget(toolRadius: number, cuspGap: number, per: number, loopbackFilletPct = 25): number {
  const Rf = (loopbackFilletPct / 100) * toolRadius
  const overlap = 1.5 * Rf
  return Math.min(Math.max(cuspGap + overlap, 3.0), 0.25 * per)
}

/**
 * Build the wall-follow EXIT: ride from A (priorCut.end) along A's cutRegion loop in the
 * cut's own (behind-the-cut) continuation winding, for `length` mm. The result is a true
 * sub-polyline of that loop (cannot leave the region / cross a hole / jump loops).
 * Returns null if A does not project onto any loop or the loop is degenerate.
 */
export function buildWallFollowExit(
  priorCut: Pt[], cutRegion: Loops, toolRadius: number, length?: number, loopbackFilletPct = 25,
): WallFollowRide | null {
  if (priorCut.length < 2 || cutRegion.length === 0) return null
  const A = priorCut[priorCut.length - 1]
  const projA = nearestOnLoops(A, cutRegion)
  if (projA.loop < 0) return null
  const loop = cutRegion[projA.loop]
  if (loop.length < 3) return null
  const per = loopPerimeter(loop)
  const L = length ?? rideBudget(toolRadius, 0, per, loopbackFilletPct)
  const nTravelIn = tangentAtEnd(priorCut)
  const segA = loop[projA.seg], segAb = loop[(projA.seg + 1) % loop.length]
  const loopFwdTan = unit(sub(segAb, segA))
  const rideSign = (loopFwdTan.x * nTravelIn.x + loopFwdTan.y * nTravelIn.y) >= 0 ? 1 : -1
  const rideRaw = rideAlongLoop(loop, projA.seg, projA.foot, rideSign, L)
  const points: Pt[] = [A, ...rideRaw.slice(1)]
  if (points.length < 2) return null
  return { points, far: points[points.length - 1], loop: projA.loop }
}

/**
 * Build the wall-follow ENTRY: ride to B (nextCut.start) along B's cutRegion loop, arriving in
 * the cut-continuation winding (the polyline ENDS at B, no reversal at the cut). True
 * sub-polyline of that loop. Returns null on degenerate input.
 */
export function buildWallFollowEntry(
  nextCut: Pt[], cutRegion: Loops, toolRadius: number, length?: number, loopbackFilletPct = 25,
): WallFollowRide | null {
  if (nextCut.length < 2 || cutRegion.length === 0) return null
  const B = nextCut[0]
  const projB = nearestOnLoops(B, cutRegion)
  if (projB.loop < 0) return null
  const loop = cutRegion[projB.loop]
  if (loop.length < 3) return null
  const per = loopPerimeter(loop)
  const L = length ?? rideBudget(toolRadius, 0, per, loopbackFilletPct)
  const n1TravelOut = tangentAtStart(nextCut)
  const segB = loop[projB.seg], segBb = loop[(projB.seg + 1) % loop.length]
  const loopFwdTan = unit(sub(segBb, segB))
  // Ride AWAY from B: pick the sign whose +loop tangent OPPOSES the cut's outgoing travel, so
  // after reversing, the arrival tangent (toward B) aligns with the cut (no reversal).
  const awaySign = (loopFwdTan.x * n1TravelOut.x + loopFwdTan.y * n1TravelOut.y) >= 0 ? -1 : 1
  const rideAway = rideAlongLoop(loop, projB.seg, projB.foot, awaySign, L)
  const points: Pt[] = [...rideAway].reverse()
  if (points.length < 2) return null
  points[points.length - 1] = B   // exact coincidence at B
  return { points, far: points[0], loop: projB.loop }
}

/** Wall distance from footA (on segment segA) to footB (on segment segB) walking the loop in
 *  `sign` direction. Returns Infinity when footB is never reached within one lap. */
function forwardDistanceAlongLoop(lp: Loop, segA: number, footA: Pt, segB: number, footB: Pt, sign: number): number {
  const n = lp.length
  if (segA === segB) {
    // Same segment: ahead only if B sits further along the segment in the ride direction.
    const a = lp[segA], b = lp[(segA + 1) % n]
    const ab = sub(b, a)
    const tA = ab.x * (footA.x - a.x) + ab.y * (footA.y - a.y)
    const tB = ab.x * (footB.x - a.x) + ab.y * (footB.y - a.y)
    if ((sign > 0 && tB >= tA - 1e-9) || (sign < 0 && tB <= tA + 1e-9)) return dist(footA, footB)
  }
  let total = 0
  let seg = segA
  let cur = footA
  for (let guard = 0; guard < n; guard++) {
    const vIdx = sign > 0 ? (seg + 1) % n : seg
    const v = lp[vIdx]
    total += dist(cur, v)
    cur = v
    seg = sign > 0 ? (seg + 1) % n : (seg - 1 + n) % n
    if (seg === segB) return total + dist(cur, footB)
  }
  return Infinity
}

/**
 * WO-1178 (Operator's Tee finding, 2026-09-02): the next cut starts a short way AHEAD of the prior
 * cut's end on the SAME wall. The exit ride (A forward for its budget) and the entry ride (back
 * from B for its budget) then OVERLAP, and the connection between their far ends runs BACKWARD
 * along the wall the tool just rode -- on a rounded inside corner that backward chord leaves the
 * region, the backward arc is an opposite-sense ride, and the ladder concedes a hop over ground
 * the tool had already cleaned (Tee: a 3.2 mm micro-lift across the 2.5 mm fillet). Ride the
 * wall ONCE, forward, from A to B. Null when A and B do not share a loop, when B is further
 * ahead than `maxLength` (default: the two cusp budgets together, the overlap condition), or
 * when the next cut would leave B against the ride's own travel sense (a reversal at B).
 */
export function buildWallFollowThrough(
  priorCut: Pt[], nextCut: Pt[], cutRegion: Loops, toolRadius: number, maxLength?: number, loopbackFilletPct = 25,
): WallFollowRide | null {
  if (priorCut.length < 2 || nextCut.length < 2 || cutRegion.length === 0) return null
  const A = priorCut[priorCut.length - 1]
  const B = nextCut[0]
  const projA = nearestOnLoops(A, cutRegion)
  const projB = nearestOnLoops(B, cutRegion)
  if (projA.loop < 0 || projB.loop !== projA.loop) return null
  const loop = cutRegion[projA.loop]
  if (loop.length < 3) return null
  const per = loopPerimeter(loop)
  const budget = maxLength ?? 2 * rideBudget(toolRadius, 0, per, loopbackFilletPct)
  const nTravelIn = tangentAtEnd(priorCut)
  const segA = loop[projA.seg], segAb = loop[(projA.seg + 1) % loop.length]
  const loopFwdTan = unit(sub(segAb, segA))
  const rideSign = (loopFwdTan.x * nTravelIn.x + loopFwdTan.y * nTravelIn.y) >= 0 ? 1 : -1
  const ahead = forwardDistanceAlongLoop(loop, projA.seg, projA.foot, projB.seg, projB.foot, rideSign)
  if (!(ahead > 1e-9) || ahead > budget) return null
  const rideRaw = rideAlongLoop(loop, projA.seg, projA.foot, rideSign, ahead)
  const points: Pt[] = [A, ...rideRaw.slice(1)]
  if (points.length < 2) return null
  points[points.length - 1] = B   // exact coincidence at B
  // The ride must hand the tool to the next cut in the cut's own travel sense, never reversed.
  const arrive = tangentAtEnd(points)
  const depart = tangentAtStart(nextCut)
  if (arrive.x * depart.x + arrive.y * depart.y < 0) return null
  return { points, far: B, loop: projA.loop }
}

/** Unwrapped sweep (deg) of a sampled polyline about centre O. Each consecutive step is
 *  wrapped to (-180, 180]; the sum exposes a 2pi-wrapped arc (|sum| ~ 360 - turn). */
function sweepAboutCentre(pts: Pt[], O: Pt): number {
  let total = 0
  let prev = Math.atan2(pts[0].y - O.y, pts[0].x - O.x)
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(pts[i].y - O.y, pts[i].x - O.x)
    let d = a - prev
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    total += d
    prev = a
  }
  return total * 180 / Math.PI
}

type LoopbackJoint = { arc: Pt[]; A: Pt; B: Pt; sweepDeg: number }
type JointFail = { fail: string }

/** Gate-free loopback arc joining incoming line (p0, travel tangent t0) to outgoing line
 *  (p1, travel tangent t1) with radius R. Permits a > 90 sweep (a U-turn loopback is exempt
 *  from the <= 90 lead gate). Returns the arc polyline from contact A to contact B, plus A and
 *  B so the caller can TRIM both adjoining pieces back to the tangent points.
 *
 *  VALIDATED CONSTRUCTION (ADR-0003 fail-loud, defect-fix 2026-06-10):
 *   - ADAPTIVE radius: the tangent length is clamped to maxTanLen (= |EF|/2 at the call site)
 *     and the radius shrunk to match, so contacts can never overshoot / cross the traverse.
 *   - the old silent den~0 fallback (A=p0, B=p1 -- B OFF the fillet circle, which made
 *     sampleArc's span<=0 += 2pi sweep the LONG way = the 341deg pigtail) is REMOVED;
 *     anti-parallel tangents now fail loud (the contact-overlap clamp upstream repairs the
 *     geometry that used to produce them).
 *   - post-construction validation: contacts on the fillet circle, apex at the expected joint,
 *     and the SAMPLED sweep equal to the intended turn (no 2pi wrap).
 *   - a near-zero turn (post-clamp collinear pass-through) needs no arc: it returns a short
 *     straight stub at the joint so the 5-piece chain keeps distinct, forward-ordered points.
 *
 *  @param jointAt which end of (p0..p1) the corner sits on: fillet1 = 'start' (corner at the
 *                 exit ride's end), fillet2 = 'end' (corner at the entry ride's start). */
function loopbackArc(
  p0: Pt, t0: Pt, p1: Pt, t1: Pt, R: number, chordTol: number,
  jointAt: 'start' | 'end' | 'corner', maxTanLen: number,
): LoopbackJoint | JointFail {
  const d0 = unit(t0), d1 = unit(t1)
  if ((d0.x === 0 && d0.y === 0) || (d1.x === 0 && d1.y === 0)) return { fail: 'degenerate tangent' }
  const dot = Math.max(-1, Math.min(1, d0.x * d1.x + d0.y * d1.y))
  const turnDeg = Math.acos(dot) * 180 / Math.PI
  const gap = dist(p0, p1)
  if (turnDeg < 0.5) {
    // Straight pass-through: no fillet needed (this is the normal joint shape AFTER the
    // contact-overlap clamp re-ordered same-wall contacts). Emit a short straight stub.
    const stub = Math.min(0.25 * gap, 0.5)
    if (stub < 1e-9) return { fail: `zero-turn joint with zero gap (gap=${gap.toExponential(2)})` }
    const A: Pt = jointAt === 'start' ? { x: p0.x, y: p0.y } : { x: p1.x - d0.x * stub, y: p1.y - d0.y * stub }
    const B: Pt = jointAt === 'start' ? { x: p0.x + d1.x * stub, y: p0.y + d1.y * stub } : { x: p1.x, y: p1.y }
    return { arc: [A, B], A, B, sweepDeg: turnDeg }
  }
  const crossv = d0.x * d1.y - d0.y * d1.x
  const sgn = crossv >= 0 ? 1 : -1
  const thetaRad = turnDeg * Math.PI / 180
  // ADAPTIVE Rf: t <= maxTanLen, radius shrunk to keep t = R*tan(theta/2) consistent.
  let t = R * Math.tan(thetaRad / 2)
  let Reff = R
  if (t > maxTanLen) {
    t = maxTanLen
    Reff = t / Math.tan(thetaRad / 2)
  }
  if (!Number.isFinite(Reff) || Reff < 1e-6) {
    return { fail: `adaptive radius degenerate (turn=${turnDeg.toFixed(2)}deg t=${t.toFixed(4)} Reff=${Reff.toExponential(2)})` }
  }
  const den = d0.x * (-d1.y) - d0.y * (-d1.x)
  if (Math.abs(den) <= 1e-9) {
    return { fail: `anti-parallel tangents (turn=${turnDeg.toFixed(2)}deg) -- contact-overlap clamp missed this joint` }
  }
  const rx = p1.x - p0.x, ry = p1.y - p0.y
  const s = (rx * (-d1.y) - ry * (-d1.x)) / den
  // VALIDATE: the apex must sit at the joint (fillet1: at p0, the exit end on the E->F line;
  // fillet2: at p1 = F; direct corner: anywhere near the E/F cluster). A displaced apex =
  // inconsistent tangent geometry -> contacts land far from the joint and the trim would
  // mangle the rides.
  if (jointAt === 'corner') {
    // Direct corner: contacts must land within a ride-length budget of the ride far ends
    // (|s - t| on the exit side, |(B - p1) . d1| on the entry side, both checked below after
    // t is known) -- a far-away ray intersection (long dog-leg geometry) is NOT a corner.
    if (!Number.isFinite(s)) return { fail: `corner apex not finite` }
  } else {
    const sExpected = jointAt === 'start' ? 0 : gap
    if (!Number.isFinite(s) || Math.abs(s - sExpected) > maxTanLen + 0.1 * gap + 0.05) {
      return { fail: `apex displaced from joint (s=${s.toFixed(3)} expected=${sExpected.toFixed(3)} turn=${turnDeg.toFixed(1)}deg)` }
    }
  }
  const apex = { x: p0.x + d0.x * s, y: p0.y + d0.y * s }
  const A: Pt = { x: apex.x - d0.x * t, y: apex.y - d0.y * t }
  const B: Pt = { x: apex.x + d1.x * t, y: apex.y + d1.y * t }
  // VALIDATE: forward-ordered contacts -- the traverse-side contact stays on the traverse
  // (fillet1's B never past F; fillet2's A never before the traverse start). The ride-side
  // contacts are validated at the attempt level against the ORIGINAL rides (here p0/p1 move
  // during the trim fixed-point, so a local check would spuriously reject legitimate
  // forward re-trims within the original ride).
  if (jointAt === 'start' && (B.x - p1.x) * d1.x + (B.y - p1.y) * d1.y > 1e-6) {
    return { fail: `traverse contact past F (overshoot ${((B.x - p1.x) * d1.x + (B.y - p1.y) * d1.y).toFixed(4)}mm)` }
  }
  if (jointAt === 'end' && (A.x - p0.x) * d0.x + (A.y - p0.y) * d0.y < -1e-6) {
    return { fail: `traverse contact before E (undershoot ${((A.x - p0.x) * d0.x + (A.y - p0.y) * d0.y).toFixed(4)}mm)` }
  }
  if (jointAt === 'corner') {
    const offA = Math.abs((A.x - p0.x) * d0.x + (A.y - p0.y) * d0.y)
    const offB = Math.abs((B.x - p1.x) * d1.x + (B.y - p1.y) * d1.y)
    if (offA > maxTanLen + 1e-6 || offB > maxTanLen + 1e-6) {
      return { fail: `corner contacts beyond ride budget (offA=${offA.toFixed(3)} offB=${offB.toFixed(3)} budget=${maxTanLen.toFixed(3)})` }
    }
  }
  const O = { x: A.x - d0.y * sgn * Reff, y: A.y + d0.x * sgn * Reff }
  // VALIDATE: both contacts on the fillet circle (the old den~0 fallback violated this for B).
  if (Math.abs(dist(A, O) - Reff) > 1e-5 || Math.abs(dist(B, O) - Reff) > 1e-5) {
    return { fail: `contact off fillet circle (|AO|-R=${(dist(A, O) - Reff).toExponential(2)} |BO|-R=${(dist(B, O) - Reff).toExponential(2)})` }
  }
  const a0 = Math.atan2(A.y - O.y, A.x - O.x)
  const a1 = Math.atan2(B.y - O.y, B.x - O.x)
  const dir: 'CCW' | 'CW' = sgn > 0 ? 'CCW' : 'CW'
  const arc = sampleArc(O, Reff, a0, a1, dir, Math.max(chordTol, 1e-3))
  if (arc.length === 0) return { fail: 'sampleArc returned no points' }
  arc[0] = { x: A.x, y: A.y }
  arc.push({ x: B.x, y: B.y })
  // VALIDATE: the sampled sweep equals the intended turn (a 2pi wrap reads ~360 - turn).
  const sampledSweep = Math.abs(sweepAboutCentre(arc, O))
  if (Math.abs(sampledSweep - turnDeg) > 2.0) {
    return { fail: `sampled sweep ${sampledSweep.toFixed(1)}deg != intended turn ${turnDeg.toFixed(1)}deg (2pi wrap)` }
  }
  return { arc, A, B, sweepDeg: turnDeg }
}

// ---- CONTACT-OVERLAP CLAMP (root fix 2026-06-10) ----------------------------------------
// The wall-ride budget (min 3.0mm) can OVERSHOOT, so the outgoing contact F (entry ride
// start) lands BEHIND the incoming contact E (exit ride end) on the same wall. The E->F
// traverse then runs anti-parallel to both ride tangents: an exact-180deg reversal that the
// old construction degraded to a straight reversal link (small Rf) or a 341deg pigtail
// (large Rf, via the off-circle den~0 fallback). Fix the GEOMETRY, not the gate: restore
// forward-ordered contacts by advancing the entry ride's start to just past E (preferred --
// the overlapped wall span is simply ridden by BOTH rides, no coverage lost), or by trimming
// the exit ride back to just before F. After the clamp the joint is a normal small-turn
// fillet (or a collinear pass-through).

/** Both rides are sub-polylines of the same cutRegion wall, so a genuine overlap is exact to
 *  fp noise; legit U-turn far ends sit >= a stepover (~0.4mm) off the opposing ride. */
const OVERLAP_EPS = 1e-3
/** Forward separation E -> F' guaranteed after the clamp (mm). */
const CLAMP_MARGIN = 0.02

function nearestOnOpenPolyline(p: Pt, poly: Pt[]): { d: number; seg: number; t: number } {
  let best = { d: Infinity, seg: 0, t: 0 }
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1]
    const ab = sub(b, a); const L2 = ab.x * ab.x + ab.y * ab.y
    let t = L2 > 1e-12 ? ((p.x - a.x) * ab.x + (p.y - a.y) * ab.y) / L2 : 0
    t = Math.max(0, Math.min(1, t))
    const foot = { x: a.x + ab.x * t, y: a.y + ab.y * t }
    const d = dist(p, foot)
    if (d < best.d) best = { d, seg: i, t }
  }
  return best
}

/** New entry ride starting at the FIRST point whose projection past E along `dir` reaches
 *  `margin` (walks the entry polyline forward; interpolates within a segment). Null if the
 *  whole entry ride stays behind E (cannot advance). */
function advanceEntryPast(entry: Pt[], E: Pt, dir: Pt, margin: number): Pt[] | null {
  const g = (p: Pt): number => (p.x - E.x) * dir.x + (p.y - E.y) * dir.y
  for (let i = 0; i < entry.length - 1; i++) {
    const ga = g(entry[i]), gb = g(entry[i + 1])
    if (ga >= margin) {
      const out = entry.slice(i)
      return out.length >= 2 ? out : null
    }
    if (gb >= margin && gb > ga) {
      const t = (margin - ga) / (gb - ga)
      const P: Pt = { x: entry[i].x + (entry[i + 1].x - entry[i].x) * t, y: entry[i].y + (entry[i + 1].y - entry[i].y) * t }
      const out: Pt[] = [P, ...entry.slice(i + 1)]
      if (out.length >= 2 && dist(out[0], out[1]) < 1e-9) out.splice(1, 1)
      return out.length >= 2 && dist(out[0], out[out.length - 1]) > 1e-9 ? out : null
    }
  }
  return null
}

/** Trim the exit ride so it ends where its projection along `dir` first reaches `clearance`
 *  BEHIND the point B (= the entry ride's end, when the exit overshot past it). Returns the
 *  unchanged ride if it already lies entirely behind; null if nothing usable remains. */
function trimExitUntilBehind(exit: Pt[], B: Pt, dir: Pt, clearance: number): Pt[] | null {
  const h = (p: Pt): number => (p.x - B.x) * dir.x + (p.y - B.y) * dir.y
  if (h(exit[0]) >= -clearance) return null   // whole ride at/past B: nothing usable behind
  for (let i = 0; i < exit.length - 1; i++) {
    const ha = h(exit[i]), hb = h(exit[i + 1])
    if (hb >= -clearance && hb > ha) {
      const t = (-clearance - ha) / (hb - ha)
      const P: Pt = { x: exit[i].x + (exit[i + 1].x - exit[i].x) * t, y: exit[i].y + (exit[i + 1].y - exit[i].y) * t }
      const out = exit.slice(0, i + 1)
      if (dist(P, out[out.length - 1]) > 1e-9) out.push(P)
      return out.length >= 2 ? out : null
    }
  }
  return exit.slice()   // already entirely behind B - clearance: no trim needed
}

/**
 * Build the optional loopback between the two wall-follow far ends, with the TRIM that lands
 * each fillet's wall-side contact exactly on the ride's final straight direction so the chain
 * is fully tangent and coincident. Mutates copies of the rides (clamping overlapped contacts,
 * then trimming them back to the fillet tangent points) and returns BOTH the adjusted rides
 * and the loopback pieces.
 *
 * Construction is fail-loud (ADR-0003): a failed/invalid fillet is retried once at half the
 * radius (the adaptive clamp shrinks it further if needed); if it still fails, a structured
 * console.warn names what failed and null is returned (the caller's straight-link fallback
 * is the tripwire path -- it should be unreachable on all current fixtures).
 *
 * @returns { exit, entry, loopback } adjusted exit/entry rides + fillet1/traverse/fillet2, or
 *          null if the geometry degenerates (E==F, fillet build fails after retry).
 */
export function buildLoopback(
  exitRide: Pt[], entryRide: Pt[], toolRadius: number, arcTol: number, loopbackFilletPct = 25,
  escapes?: (pts: Pt[]) => boolean,
): { exit: Pt[]; entry: Pt[]; loopback: Loopback } | null {
  if (exitRide.length < 2 || entryRide.length < 2) return null
  let exit0 = exitRide.slice()
  let entry0 = entryRide.slice()

  // ---- CONTACT-OVERLAP CLAMP: restore forward-ordered contacts on a shared wall ----
  {
    const E0 = exit0[exit0.length - 1], F0 = entry0[0]
    const tExit = tangentAtEnd(exit0)
    const fwd = (F0.x - E0.x) * tExit.x + (F0.y - E0.y) * tExit.y
    // Overlap probe: both rides are sub-polylines of the same wall, so any span overlap puts
    // at least one VERTEX of one ride on the other (to fp noise). Probe every vertex both
    // ways -- far ends alone miss the case where the exit overshoots past the entry's END B
    // (e.g. exit [69.3..72.3] vs entry [68.6..71.6]: all four far ends are off the other ride
    // while the spans overlap by 2.3mm).
    let dProbe = Infinity
    for (const p of exit0) dProbe = Math.min(dProbe, nearestOnOpenPolyline(p, entry0).d)
    for (const p of entry0) dProbe = Math.min(dProbe, nearestOnOpenPolyline(p, exit0).d)
    if (dProbe < OVERLAP_EPS && fwd < CLAMP_MARGIN) {
      let newExit = exit0
      let newEntry = advanceEntryPast(entry0, E0, tExit, CLAMP_MARGIN)
      if (!newEntry) {
        // E overshot past the entry ride's END (B): trim the exit back to just before B,
        // then advance the entry past the new exit end.
        const B0 = entry0[entry0.length - 1]
        const trimmed = trimExitUntilBehind(exit0, B0, tExit, 2 * CLAMP_MARGIN)
        if (trimmed) {
          newExit = trimmed
          newEntry = advanceEntryPast(entry0, trimmed[trimmed.length - 1], tangentAtEnd(trimmed), CLAMP_MARGIN)
        }
      }
      if (!newEntry) {
        console.warn(
          `[wallCleanLoop] loopback contact overlap UNREPAIRABLE: E=(${E0.x.toFixed(3)},${E0.y.toFixed(3)}) ` +
          `F=(${F0.x.toFixed(3)},${F0.y.toFixed(3)}) fwd=${fwd.toFixed(3)}mm dProbe=${dProbe.toExponential(2)} ` +
          `-- falling back to straight link (ADR-0003 tripwire)`)
        return null
      }
      exit0 = newExit
      entry0 = newEntry
    }
  }

  const E = exit0[exit0.length - 1]
  const F = entry0[0]
  if (dist(E, F) < 1e-6) {
    console.warn(`[wallCleanLoop] loopback far ends coincide at (${E.x.toFixed(3)},${E.y.toFixed(3)}) -- no loopback built`)
    return null
  }
  // Fillet radius is LIVE: it is driven directly by loopbackFilletPct so the UI knob actually
  // changes the rounding. Only a tiny geometric epsilon (0.05mm) guards against a degenerate
  // zero-radius arc; this is NOT a 1.0mm floor (the old Math.max(Rf, 1.0) clamp silently pinned
  // every pct <= 50% of an R2 tool to 1.0mm, so the knob did nothing -- defect-fix 2026-06-09).
  const Rf = (loopbackFilletPct / 100) * toolRadius
  const Rlb = Math.max(Rf, 0.05)
  const CHORD = Math.min(Math.max(arcTol, 0.005), Rlb * 0.0015)
  const tEF = unit(sub(F, E))
  // ADAPTIVE Rf: per-joint tangent length <= |EF|/2 so the two fillets' traverse contacts can
  // never overshoot the traverse or cross each other; ALSO <= 90% of the fillet's OWN ride
  // length, so the ride-side contact always lands ON the ride (a tangent length longer than
  // the ride degenerated the trim into an off-ride start = the 162deg-joint token arcs).
  const polyLen = (p: Pt[]): number => { let s = 0; for (let i = 1; i < p.length; i++) s += dist(p[i - 1], p[i]); return s }
  const maxTan = dist(E, F) / 2
  const maxTan1 = Math.min(maxTan, 0.9 * polyLen(exit0))
  const maxTan2 = Math.min(maxTan, 0.9 * polyLen(entry0))

  // Signed joint turns: when both joints turn the SAME way and their sum passes 180deg, the
  // two-fillet route THROUGH the E->F chord direction goes the LONG way around (a closed
  // balloon loop at a wall corner -- the pct100 pigtail family, just built from two valid
  // arcs). The honest geometry there is the DIRECT short-way fillet between the two rides
  // (turn = sum - 360, e.g. a -90deg corner instead of a +270deg balloon).
  const signedAng = (a: Pt, b: Pt): number => Math.atan2(a.x * b.y - a.y * b.x, a.x * b.x + a.y * b.y) * 180 / Math.PI
  const sumTurn = signedAng(tangentAtEnd(exit0), tEF) + signedAng(tEF, tangentAtStart(entry0))

  // Direct corner fillet (short way), with trim+rebuild fixed-point on both rides. Returns
  // null when the geometry is not actually a corner (contacts outside the ride budget --
  // e.g. a long dog-leg whose ray intersection sits far away); the caller then falls back to
  // the normal two-fillet construction.
  const rideBudget = Math.min(0.9 * polyLen(exit0), 0.9 * polyLen(entry0))
  const attemptCorner = (R: number, mt: number): { exit: Pt[]; entry: Pt[]; loopback: Loopback } | null => {
    let exit = exit0.slice()
    let entry = entry0.slice()
    let fil = loopbackArc(exit[exit.length - 1], tangentAtEnd(exit), entry[0], tangentAtStart(entry), R, CHORD, 'corner', mt)
    if ('fail' in fil) return null
    for (let iter = 0; iter < 3; iter++) {
      const tEx = trimRideToTangent(exit, fil.A)
      const tEn = trimEntryFromTangent(entry, fil.B)
      const reFil = loopbackArc(tEx[tEx.length - 1], tangentAtEnd(tEx), tEn[0], tangentAtStart(tEn), R, CHORD, 'corner', mt)
      if ('fail' in reFil) break
      exit = tEx; entry = tEn; fil = reFil
      if (dist(exit[exit.length - 1], fil.A) < 1e-7 && dist(entry[0], fil.B) < 1e-7) break
    }
    exit = trimRideToTangent(exit, fil.A)
    entry = trimEntryFromTangent(entry, fil.B)
    const arc = fil.arc.slice()
    arc[0] = exit[exit.length - 1]
    arc[arc.length - 1] = entry[0]
    while (arc.length < 4) {
      const a = arc[arc.length - 2], b = arc[arc.length - 1]
      arc.splice(arc.length - 1, 0, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 })
    }
    // Carve the single arc into the 5-piece chain shape (fillet1 / 1-segment "traverse" /
    // fillet2) so callers see the same structure; concatenation reproduces the arc exactly.
    const i = Math.floor((arc.length - 1) / 2)
    const fillet1 = arc.slice(0, i + 1)
    const traverse = [arc[i], arc[i + 1]]
    const fillet2 = arc.slice(i + 1)
    if (exit.length < 2 || entry.length < 2) return null
    // chain joints must be tangent (see the kink validation in the two-fillet path)
    if (jointKinkDeg(arc[0], arc[1], tangentAtEnd(exit)) > 45) return null
    if (jointKinkDeg(arc[arc.length - 2], arc[arc.length - 1], tangentAtStart(entry)) > 45) return null
    return { exit, entry, loopback: { fillet1, traverse, fillet2 } }
  }

  const attempt = (R: number, k: number): { exit: Pt[]; entry: Pt[]; loopback: Loopback } | JointFail => {
    const mt1 = maxTan1 * k, mt2 = maxTan2 * k

    if (Math.abs(sumTurn) > 181) {
      // LONG-WAY decomposition: prefer the direct short-way corner fillet; if the geometry is
      // not a true corner (direct contacts off the rides), fall through to the two-fillet
      // dog-leg below (whose long traverse keeps it from ballooning). The ride budget is a
      // fixed ride-length constraint -- only the radius shrinks down the ladder.
      const corner = attemptCorner(R, rideBudget)
      if (corner) return corner
    }

    // ---- EXIT side (fillet 1) with trim+rebuild fixed-point ----
    let exit = exit0.slice()
    let filA = loopbackArc(exit[exit.length - 1], tangentAtEnd(exit), F, tEF, R, CHORD, 'start', mt1)
    if ('fail' in filA) return { fail: `fillet1: ${filA.fail}` }
    for (let iter = 0; iter < 3; iter++) {
      const trimmed = trimRideToTangent(exit, filA.A)
      const reFil = loopbackArc(trimmed[trimmed.length - 1], tangentAtEnd(trimmed), F, tEF, R, CHORD, 'start', mt1)
      if ('fail' in reFil) break
      exit = trimmed; filA = reFil
      if (dist(exit[exit.length - 1], filA.A) < 1e-7) break
      exit = trimRideToTangent(exit, filA.A)
    }

    // ---- ENTRY side (fillet 2) ----
    let entry = entry0.slice()
    let filB = loopbackArc(E, tEF, entry[0], tangentAtStart(entry), R, CHORD, 'end', mt2)
    if ('fail' in filB) return { fail: `fillet2: ${filB.fail}` }
    for (let iter = 0; iter < 3; iter++) {
      const trimmed = trimEntryFromTangent(entry, filB.B)
      const reFil = loopbackArc(E, tEF, trimmed[0], tangentAtStart(trimmed), R, CHORD, 'end', mt2)
      if ('fail' in reFil) break
      entry = trimmed; filB = reFil
      if (dist(entry[0], filB.B) < 1e-7) break
      entry = trimEntryFromTangent(entry, filB.B)
    }

    // ---- VALIDATE: traverse contacts forward-ordered along E->F (never crossed) ----
    const order = (filB.A.x - filA.B.x) * tEF.x + (filB.A.y - filA.B.y) * tEF.y
    if (order < -1e-6) return { fail: `crossed traverse contacts (overlap ${(-order).toFixed(4)}mm)` }

    // (Ride-side contacts may legitimately sit off a CURVED wall toward the pocket -- the
    // tangent line leaves the wall there, over cleared stock. The only invalid case is a
    // contact escaping the cut REGION, which the caller-supplied `escapes` test rejects in
    // the retry ladder below.)

    // Land the rides exactly on the KEPT fillets' contacts. (Never snap the arc start to an
    // un-trimmed ride end: when the fixed-point loop breaks early, that snap created a jump
    // discontinuity the circle-fit audit read as a >180deg sweep.)
    exit = trimRideToTangent(exit, filA.A)
    entry = trimEntryFromTangent(entry, filB.B)
    const fillet1: Pt[] = filA.arc.slice()
    fillet1[0] = exit[exit.length - 1]
    const fillet2: Pt[] = filB.arc.slice()
    fillet2[fillet2.length - 1] = entry[0]
    const traverse: Pt[] = [fillet1[fillet1.length - 1], fillet2[0]]

    if (exit.length < 2 || entry.length < 2 || fillet1.length < 2 || fillet2.length < 2) {
      return { fail: 'degenerate chain piece after trim' }
    }
    // ---- VALIDATE: chain joints tangent. A contact landing AT a wall polyline corner makes
    // the kept fillet tangent to the PRE-corner direction while the trimmed ride continues
    // POST-corner (a 70-90deg kink); failing here lets the ladder shrink R so the contact
    // clears the corner.
    const kink1 = jointKinkDeg(fillet1[0], fillet1[1], tangentAtEnd(exit))
    const kink2 = jointKinkDeg(fillet2[fillet2.length - 2], fillet2[fillet2.length - 1], tangentAtStart(entry))
    if (kink1 > 45 || kink2 > 45) {
      return { fail: `kinked chain joint (exit ${kink1.toFixed(1)}deg / entry ${kink2.toFixed(1)}deg)` }
    }
    return { exit, entry, loopback: { fillet1, traverse, fillet2 } }
  }

  // Build with a retry ladder at reduced Rf AND reduced tangent budget (the adaptive clamp
  // shrinks further): curved/kinked walls can displace the apex during the trim fixed-point
  // (crossing the two fillets' traverse contacts) or bulge a fillet out of the cut region;
  // shrinking both restores the slack and hugs the wall corner.
  let last: JointFail = { fail: 'no attempt ran' }
  for (const k of [1, 0.5, 0.25, 0.1]) {
    const res = attempt(Rlb * k, k)
    if ('fail' in res) { last = res; continue }
    if (escapes) {
      const allPts = [
        ...res.exit,
        ...res.loopback.fillet1, ...res.loopback.traverse.slice(1), ...res.loopback.fillet2.slice(1),
        ...res.entry,
      ]
      if (escapes(allPts)) { last = { fail: `fillet chain escapes cut region at R=${(Rlb * k).toFixed(3)}` }; continue }
    }
    return res
  }
  console.warn(
    `[wallCleanLoop] loopback fillet build FAILED (fail-loud, after reduced-Rf retries): ` +
    `last="${last.fail}" E=(${E.x.toFixed(3)},${E.y.toFixed(3)}) F=(${F.x.toFixed(3)},${F.y.toFixed(3)}) ` +
    `Rf=${Rlb.toFixed(3)} pct=${loopbackFilletPct} -- falling back to straight link (ADR-0003 tripwire)`)
  return null
}

/** Trim a wall-follow EXIT ride so it ends exactly at the fillet tangent point `tan`. */
function trimRideToTangent(ride: Pt[], tan: Pt): Pt[] {
  if (ride.length < 2) return ride
  const Eprev = ride[ride.length - 2]
  const E = ride[ride.length - 1]
  const lastDir = unit(sub(E, Eprev))
  const sTan = (tan.x - Eprev.x) * lastDir.x + (tan.y - Eprev.y) * lastDir.y
  const out = ride.slice(0, ride.length - 1)
  if (sTan <= 1e-9) {
    while (out.length >= 2) {
      const p = out[out.length - 1]
      const sp = (p.x - Eprev.x) * lastDir.x + (p.y - Eprev.y) * lastDir.y
      if (sp <= sTan + 1e-9) break
      out.pop()
    }
  }
  if (dist(out[out.length - 1], tan) > 1e-9) out.push({ x: tan.x, y: tan.y })
  if (out.length < 2) return [ride[0], { x: tan.x, y: tan.y }]
  return out
}

/** Trim a wall-follow ENTRY ride (which ENDS at B) so it starts exactly at the fillet
 *  tangent point `tan`. */
function trimEntryFromTangent(entry: Pt[], tan: Pt): Pt[] {
  if (entry.length < 2) return entry
  const F = entry[0]
  const Fnext = entry[1]
  const firstDir = unit(sub(Fnext, F))
  const sTan = (tan.x - Fnext.x) * firstDir.x + (tan.y - Fnext.y) * firstDir.y
  const out = entry.slice(1)
  if (sTan >= -1e-9) {
    while (out.length >= 2) {
      const p = out[0]
      const sp = (p.x - Fnext.x) * firstDir.x + (p.y - Fnext.y) * firstDir.y
      if (sp >= sTan - 1e-9) break
      out.shift()
    }
  }
  if (dist(tan, out[0]) > 1e-9) out.unshift({ x: tan.x, y: tan.y })
  if (out.length < 2) return [{ x: tan.x, y: tan.y }, entry[entry.length - 1]]
  return out
}

/**
 * SAME-LOOP convenience builder (back-compat): build a complete wall-clean transition between
 * two adjacent cut passes whose ends sit on the SAME cutRegion loop. Composes the exit ride,
 * the entry ride, and the trimmed loopback into one flat 5-piece chain. Returns null on a
 * cross-loop pair (no shared wall) or on any degeneracy.
 *
 * NOTE: production firing in processFeature.ts does NOT use this wrapper -- it builds the exit
 * and entry rides independently (so a wall-follow fires even cross-loop) and decides the
 * loopback vs lift with the engine's own keep-down safety check. This wrapper exists so the
 * unit tests can exercise the same-loop coincidence/trim/tangency invariants in one call.
 */
export function buildWallCleanTransition(
  priorCut: Pt[], nextCut: Pt[], cutRegion: Loops, toolRadius: number, arcTol: number, loopbackFilletPct = 25,
): WallCleanTransition | null {
  if (priorCut.length < 2 || nextCut.length < 2 || cutRegion.length === 0) return null
  const A = priorCut[priorCut.length - 1]
  const B = nextCut[0]
  const projA = nearestOnLoops(A, cutRegion)
  const projB = nearestOnLoops(B, cutRegion)
  if (projA.loop < 0 || projB.loop < 0) return null
  if (projA.loop !== projB.loop) return null   // cross-loop: no shared wall -> bail

  const loop = cutRegion[projA.loop]
  if (loop.length < 3) return null
  const per = loopPerimeter(loop)
  const L = rideBudget(toolRadius, dist(A, B), per, loopbackFilletPct)

  const exitRide = buildWallFollowExit(priorCut, cutRegion, toolRadius, L)
  const entryRide = buildWallFollowEntry(nextCut, cutRegion, toolRadius, L)
  if (!exitRide || !entryRide) return null

  const lb = buildLoopback(exitRide.points, entryRide.points, toolRadius, arcTol, loopbackFilletPct)
  if (!lb) return null
  return { exit: lb.exit, fillet1: lb.loopback.fillet1, traverse: lb.loopback.traverse, fillet2: lb.loopback.fillet2, entry: lb.entry }
}
