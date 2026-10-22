// SPDX-License-Identifier: LGPL-2.1-or-later
// Loopback fillet ACCEPTANCE layer (WO-1069).
//
// `buildLoopback` (wallCleanLoop.ts) fits the two tangent fillets that cap the keep-down
// traverse between two wall-follow far ends, trimming each ride back so it ends/starts exactly
// on its fillet's contact point. Its own retry ladder shrinks the radius when the FIT fails.
// This module adds the check the ladder was missing: that the accepted fit's contacts still
// lie ON the rides they trimmed.
//
// THE DEFECT (Kidney/fix1 at loopbackFilletPct 25, measured 2026-08-27)
//   Both trims order a ride by projecting it onto ONE direction -- the exit's last segment,
//   the entry's first segment. On a CURVED wall that ordering is wrong far from the joint: a
//   contact that has slid off the ride's FAR end projects back near its OTHER end, so the trim
//   pops the whole ride away and returns a 2-point stub running BACKWARD along the wall. E.g.
//   the exit ride [(142.424,55.801) .. (143.276,58.669)] came back as the 0.10mm stub
//   [(142.424,55.801) (142.329,55.834)]. That stub is a genuine reversal in the cut, so
//   processFeature's milling-direction gate rejected the whole loopback, and the straight
//   keep-down fallback emitted a bare link between the RAW ride far ends -- a 179.0/178.1deg
//   corner at (66.65, 33.72), plus 19 more from 164 to 176deg on the same fixture.
//
// THE FIX
//   Reject the fit when either contact has left its ride's span and re-fit at half the fillet
//   percentage (which halves Rf, so the tangent lengths shrink and the contacts move back onto
//   the rides). A smaller fillet is a smaller rounding of the same corner -- it is never a
//   kink, a reversal, or a retract. Only when the whole ladder fails does the caller see null
//   and fall back, exactly as before.

// WO-3018: every sampling, steering, sharpening and cap number comes from the policy record.
import { ADAPTIVE_POLICY as AP } from '../../../../kernel/ops/adaptive/policy'
import type { Pt } from './clipperEngine'
import { buildLoopback, type Loopback } from './wallCleanLoop'

const dist = (a: Pt, b: Pt): number => Math.hypot(a.x - b.x, a.y - b.y)
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y })
const unit = (v: Pt): Pt => { const m = Math.hypot(v.x, v.y) || 1; return { x: v.x / m, y: v.y / m } }
const angleBetweenDeg = (a: Pt, b: Pt): number =>
  Math.acos(Math.max(-1, Math.min(1, a.x * b.x + a.y * b.y))) * 180 / Math.PI

/** Nearest point on an OPEN polyline, as {segment index, fraction along it}. */
function nearestSegOnPolyline(p: Pt, poly: Pt[]): { seg: number; t: number } {
  let best = { d: Infinity, seg: 0, t: 0 }
  for (let i = 0; i < poly.length - 1; i++) {
    const a = poly[i], b = poly[i + 1]
    const abx = b.x - a.x, aby = b.y - a.y
    const l2 = abx * abx + aby * aby
    let t = l2 > 1e-12 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / l2 : 0
    t = Math.max(0, Math.min(1, t))
    const d = Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t))
    if (d < best.d) best = { d, seg: i, t }
  }
  return { seg: best.seg, t: best.t }
}

/** Arclength position of `p` along `poly` (mm from its start) and the polyline's total length. */
function arcPositionOnPolyline(p: Pt, poly: Pt[]): { s: number; total: number } {
  const { seg, t } = nearestSegOnPolyline(p, poly)
  let s = 0, total = 0
  for (let i = 0; i < poly.length - 1; i++) {
    const d = dist(poly[i], poly[i + 1])
    if (i < seg) s += d
    else if (i === seg) s += d * t
    total += d
  }
  return { s, total }
}

/** fp slack only: a contact one micron inside the ride's far vertex still leaves a forward ride. */
const CONTACT_SPAN_EPS = 1e-6

/** Does the loopback's exit-side contact still sit inside the exit ride's span? The exit ride
 *  runs A -> E, so its contact must be strictly PAST its start. */
export function exitContactOnRide(contact: Pt, rawExitRide: Pt[]): boolean {
  if (rawExitRide.length < 2) return false
  return arcPositionOnPolyline(contact, rawExitRide).s > CONTACT_SPAN_EPS
}

/** Does the loopback's entry-side contact still sit inside the entry ride's span? The entry
 *  ride runs F -> B, so its contact must be strictly BEFORE its end. */
export function entryContactOnRide(contact: Pt, rawEntryRide: Pt[]): boolean {
  if (rawEntryRide.length < 2) return false
  const { s, total } = arcPositionOnPolyline(contact, rawEntryRide)
  return s < total - CONTACT_SPAN_EPS
}

/** Both contacts of a built loopback still lie on the rides that were trimmed to reach them. */
export function loopbackContactsStayOnRides(
  built: { exit: Pt[]; entry: Pt[] },
  rawExitRide: Pt[],
  rawEntryRide: Pt[],
): boolean {
  if (built.exit.length < 2 || built.entry.length < 2) return false
  return exitContactOnRide(built.exit[built.exit.length - 1], rawExitRide)
    && entryContactOnRide(built.entry[0], rawEntryRide)
}

/** Fillet percentages the acceptance ladder tries, largest first. Halving the percentage halves
 *  Rf, which is what pulls an off-ride contact back onto its ride. Four rungs reach 12.5% of the
 *  requested rounding -- past that the fillet is smaller than buildLoopback's own 0.05mm floor
 *  for every pct the UI can produce. */
const PCT_LADDER = AP.sharpening.loopbackPctLadder

/**
 * Build the loopback and ACCEPT it only if its trimmed rides are still forward wall rides.
 * Same signature and same return contract as `buildLoopback`; the only difference is the extra
 * rung of retries at reduced fillet percentage before giving up.
 */
export function buildAcceptedLoopback(
  exitRide: Pt[], entryRide: Pt[], toolRadius: number, arcTol: number, loopbackFilletPct = AP.defaults.loopbackFilletPct,
  escapes?: (pts: Pt[]) => boolean,
): { exit: Pt[]; entry: Pt[]; loopback: Loopback } | null {
  for (const k of PCT_LADDER) {
    const built = buildLoopback(exitRide, entryRide, toolRadius, arcTol, loopbackFilletPct * k, escapes)
    if (!built) return null   // the fit itself failed and already warned (ADR-0003 fail-loud)
    if (loopbackContactsStayOnRides(built, exitRide, entryRide) && loopbackShapeIsSane(built.loopback)) return built
  }
  console.warn(
    `[loopbackFillet] no acceptable fillet chain after the reduced-pct ladder near `
    + `(${exitRide[exitRide.length - 1].x.toFixed(2)}, ${exitRide[exitRide.length - 1].y.toFixed(2)}) `
    + `-- rejecting the loopback (WO-1069)`)
  return null
}

// ---------------------------------------------------------------------------------------
// SHAPE ACCEPTANCE -- the same MEASUREMENT the loopback-fillet regression guard applies to the
// emitted stream, run here so the engine never emits a chain that fails it.
//
// Rule (b) no internal reversal, and rule (c) the two-tangent-arc certificate: SOME split of
// the loopback polyline yields two pieces whose least-squares circle fits each sweep <= 185deg.
// A legitimate U-turn is two arcs; a PIGTAIL is not. With |EF| down at a fifth of a millimetre
// the adaptive clamp (t <= |EF|/2) drives both fillets to a ~0.09mm effective radius, and the
// two ~176deg hairpins plus the traverse between them form a crossed double loop 0.70mm long
// to move the tool 0.21mm -- no split of it certifies (best piece 187-197deg, measured on nine
// Kidney pct25 transitions). That is not a fillet, it is a reversal wearing one, and no machine
// benefits from it.

const MAX_ARC_SWEEP_DEG = AP.sharpening.loopbackMaxArcSweepDeg
const REVERSAL_DEG = AP.sharpening.loopbackReversalDeg

/** Least-squares (Kasa) circle through `pts`; null when the normal equations are singular. */
function circleFit(pts: Pt[]): { cx: number; cy: number; r: number } | null {
  const n = pts.length
  if (n < 3) return null
  let Sx = 0, Sy = 0, Sxx = 0, Syy = 0, Sxy = 0, Sxz = 0, Syz = 0, Sz = 0
  for (const p of pts) {
    const z = p.x * p.x + p.y * p.y
    Sx += p.x; Sy += p.y; Sxx += p.x * p.x; Syy += p.y * p.y; Sxy += p.x * p.y
    Sxz += p.x * z; Syz += p.y * z; Sz += z
  }
  const A = [[Sxx, Sxy, Sx], [Sxy, Syy, Sy], [Sx, Sy, n]]
  const B = [Sxz, Syz, Sz]
  for (let c = 0; c < 3; c++) {
    let piv = c
    for (let r = c + 1; r < 3; r++) if (Math.abs(A[r][c]) > Math.abs(A[piv][c])) piv = r
    if (Math.abs(A[piv][c]) < 1e-12) return null
    if (piv !== c) { const t = A[piv]; A[piv] = A[c]; A[c] = t; const tb = B[piv]; B[piv] = B[c]; B[c] = tb }
    for (let r = c + 1; r < 3; r++) {
      const f = A[r][c] / A[c][c]
      for (let k = c; k < 3; k++) A[r][k] -= f * A[c][k]
      B[r] -= f * B[c]
    }
  }
  const sol = [0, 0, 0]
  for (let r = 2; r >= 0; r--) {
    let acc = B[r]
    for (let k = r + 1; k < 3; k++) acc -= A[r][k] * sol[k]
    sol[r] = acc / A[r][r]
  }
  const cx = sol[0] / 2, cy = sol[1] / 2
  return { cx, cy, r: Math.sqrt(Math.max(0, sol[2] + cx * cx + cy * cy)) }
}

/** Unwrapped sweep (deg) of `pts` about (cx, cy). */
function sweepAboutDeg(pts: Pt[], cx: number, cy: number): number {
  let total = 0
  let prev = Math.atan2(pts[0].y - cy, pts[0].x - cx)
  for (let i = 1; i < pts.length; i++) {
    const a = Math.atan2(pts[i].y - cy, pts[i].x - cx)
    let d = a - prev
    while (d > Math.PI) d -= 2 * Math.PI
    while (d < -Math.PI) d += 2 * Math.PI
    total += d; prev = a
  }
  return Math.abs(total) * 180 / Math.PI
}

/** Measured sweep of one piece: its circle-fit sweep, or 0 for a (near-)straight piece. */
function pieceSweepDeg(pts: Pt[]): number {
  if (pts.length < 3) return 0
  const fit = circleFit(pts)
  if (!fit || fit.r > 1e4) return 0
  return sweepAboutDeg(pts, fit.cx, fit.cy)
}

/** Drop consecutive duplicates so tangents and sweeps are well defined. */
function dedupConsecutive(pts: Pt[]): Pt[] {
  const out: Pt[] = [pts[0]]
  for (let i = 1; i < pts.length; i++) if (dist(pts[i], out[out.length - 1]) > 1e-9) out.push(pts[i])
  return out
}

/** The loopback pass this chain will be emitted as (fillet1 -> traverse -> fillet2). */
export function loopbackPolyline(lb: Loopback): Pt[] {
  return [...lb.fillet1, ...lb.traverse.slice(1), ...lb.fillet2.slice(1)]
}

/** Does the emitted loopback decompose into two arcs of at most 185deg, with no internal
 *  reversal? (Rules (b) and (c) of the loopback-fillet guard, measured identically.) */
export function loopbackShapeIsSane(lb: Loopback): boolean {
  const pts = dedupConsecutive(loopbackPolyline(lb))
  if (pts.length < 3) return true            // a straight 2-point loopback is trivially fine
  for (let i = 1; i < pts.length - 1; i++) {
    const d1 = unit(sub(pts[i], pts[i - 1]))
    const d2 = unit(sub(pts[i + 1], pts[i]))
    if (angleBetweenDeg(d1, d2) > REVERSAL_DEG) return false
  }
  for (let i = 1; i < pts.length - 1; i++) {
    if (pieceSweepDeg(pts.slice(0, i + 1)) <= MAX_ARC_SWEEP_DEG
      && pieceSweepDeg(pts.slice(i)) <= MAX_ARC_SWEEP_DEG) return true
  }
  return false
}
