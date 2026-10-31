// Pure thread-milling helix geometry.
// See ADR-0031 (thread_mill operation contract).
//
// No side effects: no Math.random, no Date, no I/O. The only import is the
// type-only ToolpathMove. Given an orbit center, radius, pitch and a Z span,
// generateThreadHelix emits a dense feed polyline approximating the helical
// thread-milling pass; generateHelixArcs emits the same helix as helical arcs
// (the bore's helical entry, WO-2039); threadOrbitSense + threadTravelUp
// resolve the orbit sense and axial travel direction.

import type { ToolpathMove } from '../../types'

/** Angular step (radians) for the dense helix polyline. */
export const HELIX_FI_STEP = Math.PI / 16

/**
 * Resolve the ORBIT SENSE for a thread-milling pass (chip-load model).
 *
 * Like 2D contouring, climb vs conventional is set by which side of the cutter
 * engages the wall, which in turn is set by the cut choice, the inside/outside
 * geometry (internal vs external is a mechanical mirror), and the spindle/flute
 * rotation. With signs climb=+1/conventional=-1 (c), internal=+1/external=-1
 * (e) and M3/CW-from-top=+1 (p), the orbit sense is the product:
 *
 *   s = c * e * p
 *
 * Note s does NOT depend on hand -- hand only couples this orbit sense to the
 * axial travel direction along the fixed groove (see threadTravelUp).
 *
 * @returns +1 = CCW looking down the -Z axis from +Z; -1 = CW.
 */
export function threadOrbitSense(
  kind: 'internal' | 'external',
  cut: 'climb' | 'conventional',
  spindleSign: 1 | -1,
): 1 | -1 {
  if (kind !== 'internal' && kind !== 'external') {
    throw new Error(`threadOrbitSense: invalid kind "${kind}"`)
  }
  if (cut !== 'climb' && cut !== 'conventional') {
    throw new Error(`threadOrbitSense: invalid cut "${cut}"`)
  }
  if (spindleSign !== 1 && spindleSign !== -1) {
    throw new Error(`threadOrbitSense: invalid spindle "${spindleSign}"`)
  }
  const c = cut === 'climb' ? 1 : -1
  const e = kind === 'internal' ? 1 : -1
  return (c * e * spindleSign) as 1 | -1
}

/**
 * Resolve the AXIAL travel direction for a thread-milling pass.
 *
 * The groove is fixed by the thread hand; the orbit sense then decides whether
 * following that groove means ascending or descending. With hand signs
 * right=+1/left=-1 (h):
 *
 *   travelUp = (orbitSense * h) > 0
 *
 * @returns true = ascend bottom->top, false = descend top->bottom.
 */
export function threadTravelUp(
  orbitSense: 1 | -1,
  hand: 'right' | 'left',
): boolean {
  if (orbitSense !== 1 && orbitSense !== -1) {
    throw new Error(`threadTravelUp: invalid orbitSense "${orbitSense}"`)
  }
  if (hand !== 'right' && hand !== 'left') {
    throw new Error(`threadTravelUp: invalid hand "${hand}"`)
  }
  const h = hand === 'right' ? 1 : -1
  return (orbitSense * h) > 0
}

/** WO-3193: the operator's axial direction choice on a thread mill. */
export type ThreadAxialDirection = 'bottom-up' | 'top-down'

export interface ThreadMotion {
  orbitSense: 1 | -1                 // +1 CCW from +Z, -1 CW
  travelUp: boolean                  // true = bottom -> top
  axialDirection: ThreadAxialDirection
  cut: 'climb' | 'conventional'      // what the orbit sense gives on this kind/spindle
}

/**
 * WO-3193: resolve a thread mill's motion. With an explicit axialDirection the
 * direction is the input: the orbit sense that follows the hand's groove in that
 * direction is s = h when ascending, -h when descending (the inverse of
 * threadTravelUp), and climb/conventional is what results (c = s * e * p, the
 * inverse of threadOrbitSense). Without one (every op saved before WO-3193) the
 * direction is derived from cutDirection exactly as before, so no saved
 * toolpath changes.
 */
export function resolveThreadMotion(
  params: {
    threadKind: 'internal' | 'external'
    handedness: 'right' | 'left'
    cutDirection: 'climb' | 'conventional'
    axialDirection?: ThreadAxialDirection
  },
  spindleSign: 1 | -1,
): ThreadMotion {
  const { threadKind: kind, handedness: hand, axialDirection } = params
  if (axialDirection === undefined) {
    const orbitSense = threadOrbitSense(kind, params.cutDirection, spindleSign)
    const travelUp = threadTravelUp(orbitSense, hand)
    return { orbitSense, travelUp, axialDirection: travelUp ? 'bottom-up' : 'top-down', cut: params.cutDirection }
  }
  if (axialDirection !== 'bottom-up' && axialDirection !== 'top-down') {
    throw new Error(`resolveThreadMotion: invalid axialDirection "${axialDirection}"`)
  }
  if (hand !== 'right' && hand !== 'left') {
    throw new Error(`resolveThreadMotion: invalid hand "${hand}"`)
  }
  if (kind !== 'internal' && kind !== 'external') {
    throw new Error(`resolveThreadMotion: invalid kind "${kind}"`)
  }
  if (spindleSign !== 1 && spindleSign !== -1) {
    throw new Error(`resolveThreadMotion: invalid spindle "${spindleSign}"`)
  }
  const travelUp = axialDirection === 'bottom-up'
  const h = hand === 'right' ? 1 : -1
  const orbitSense = (travelUp ? h : -h) as 1 | -1
  const e = kind === 'internal' ? 1 : -1
  const cut = orbitSense * e * spindleSign > 0 ? 'climb' : 'conventional'
  return { orbitSense, travelUp, axialDirection, cut }
}

/**
 * WO-3194 (plan page D9, 2026-10-27: "Compensate so the edge runs at the set
 * feed"). The helix F word is programmed at the tool CENTRE, but the cutting edge
 * rides the thread wall: centre radius + tool radius inside a hole, centre radius -
 * tool radius around a boss. Scale the centre feed so the EDGE moves at the set feed:
 *   internal  F_centre = F * R / (R + r)
 *   external  F_centre = F * R / (R - r)
 * Only the cutting helix uses this; leads, plunge and exit keep their own rates.
 * An edge radius <= 0 (an external root at or past the boss centre) has no edge
 * circle to compensate against, so the set feed is returned unchanged.
 */
export function threadEdgeFeed(
  feed: number,
  centreRadius: number,
  toolRadius: number,
  kind: 'internal' | 'external',
): number {
  const edgeRadius = kind === 'internal' ? centreRadius + toolRadius : centreRadius - toolRadius
  if (!(centreRadius > 0) || !(edgeRadius > 0)) return feed
  return feed * centreRadius / edgeRadius
}

export interface ThreadHelixSpec {
  cx: number; cy: number;      // orbit center (hole center) XY
  radius: number;              // orbit radius of the tool CENTER (> 0)
  pitch: number;               // mm per revolution (> 0)
  bottomZ: number;             // thread bottom (start, lower)
  topZ: number;                // thread top (end, higher); must be > bottomZ
  dir: 1 | -1;                 // +1 CCW, -1 CW (from threadOrbitSense)
  feed: number;                // feedrate to tag on each move (> 0)
  // generateHelixArcs only: feedrate for the FIRST move (the feed to the start point,
  // at the start Z). It finishes whatever approach came before - an arc lead-in stops
  // just short of the start point - so it is not cutting helix. Default `feed`.
  entryFeed?: number;
  startAngle?: number;         // optional orbit start angle in radians (default 0)
  role?: 'helix';              // default 'helix'
  descend?: boolean;           // default false (ascend). true = top->bottom traversal.
}

/**
 * Generate a dense feed polyline approximating a thread-milling helix.
 *
 * The tool center orbits (cx,cy) at `radius`. By default (descend=false) it
 * climbs from bottomZ to topZ, the first emitted point at z === bottomZ and the
 * last at z === topZ (exact equality, assigned literally to avoid float drift),
 * with Z strictly increasing across points. When descend=true the SAME XY orbit
 * (the `dir` sense) is traversed top-to-bottom instead: the first emitted point
 * is at z === topZ and the last at z === bottomZ, with Z strictly decreasing.
 * Either way it advances exactly `pitch` per full 2*pi revolution. Callers still
 * pass bottomZ < topZ; descend only flips which end is the start.
 */
export function generateThreadHelix(spec: ThreadHelixSpec): ToolpathMove[] {
  const { cx, cy, radius, pitch, bottomZ, topZ, dir, feed } = spec
  if (radius <= 0) throw new Error('generateThreadHelix: radius must be > 0')
  if (pitch <= 0) throw new Error('generateThreadHelix: pitch must be > 0')
  if (topZ <= bottomZ) throw new Error('generateThreadHelix: topZ must be > bottomZ')

  const role: 'helix' = spec.role ?? 'helix'
  const phi0 = spec.startAngle ?? 0
  const descend = spec.descend ?? false

  const revs = (topZ - bottomZ) / pitch
  const totalAngleAbs = revs * 2 * Math.PI
  const dz = topZ - bottomZ

  // startZ is the height of the FIRST emitted point; zStep is the per-fraction
  // delta. Ascend: bottomZ -> topZ. Descend: topZ -> bottomZ (mirrored in Z).
  const startZ = descend ? topZ : bottomZ
  const endZ = descend ? bottomZ : topZ
  const zSign = descend ? -1 : 1

  const moves: ToolpathMove[] = []

  const pushAt = (a: number): void => {
    const ang = phi0 + dir * a
    moves.push({
      type: 'feed',
      x: cx + radius * Math.cos(ang),
      y: cy + radius * Math.sin(ang),
      z: startZ + zSign * (a / totalAngleAbs) * dz,
      feed,
      role,
    })
  }

  // First point at a = 0 -> z exactly startZ (bottomZ ascending, topZ descending).
  pushAt(0)

  let a = HELIX_FI_STEP
  while (a < totalAngleAbs - 1e-9) {
    pushAt(a)
    a += HELIX_FI_STEP
  }

  // Final point at a = totalAngleAbs EXACTLY. If the previous emitted point is
  // already within 1e-9 of totalAngleAbs (i.e. a - HELIX_FI_STEP landed there),
  // overwrite it instead of emitting a zero-length final segment.
  const finalAngle = phi0 + dir * totalAngleAbs
  const prevA = a - HELIX_FI_STEP
  if (totalAngleAbs - prevA <= 1e-9 && moves.length > 1) {
    const last = moves[moves.length - 1]
    last.x = cx + radius * Math.cos(finalAngle)
    last.y = cy + radius * Math.sin(finalAngle)
    last.z = endZ
  } else {
    moves.push({
      type: 'feed',
      x: cx + radius * Math.cos(finalAngle),
      y: cy + radius * Math.sin(finalAngle),
      z: endZ,
      feed,
      role,
    })
  }

  return moves
}

/** A helical arc whose XY chord is shorter than this (mm) is written as a
 *  straight feed instead. After the post rounds its endpoints, an arc that short
 *  can read as start == end - a full circle the controller would cut - and as a
 *  line it deviates from the helix by well under a micron at the smallest orbit
 *  bore2d will helix on (0.05 mm). */
export const HELIX_ARC_MIN_CHORD_MM = 0.01

/**
 * The same helix generateThreadHelix samples, emitted as helical ARCS (WO-2039).
 *
 * The first move is the same feed to the start point generateThreadHelix emits
 * (a = 0), so the arcs always have a known start. The rest of the helix is split
 * into equal-sweep arcs of at most half a turn each (never a full circle, which
 * is ambiguous and which the machine program refuses), each ending exactly on the
 * helix with Z ramped linearly - which is what a G2/G3 with a Z word cuts: the
 * true helix, not a chord approximation of it. Arc type follows `dir`
 * (+1 CCW -> arc_ccw, -1 CW -> arc_cw); centre is (cx, cy). Endpoint Z values,
 * the first/last Z equalities and `descend` all match generateThreadHelix.
 * A segment whose XY chord is under HELIX_ARC_MIN_CHORD_MM is a straight feed.
 */
export function generateHelixArcs(spec: ThreadHelixSpec): ToolpathMove[] {
  const { cx, cy, radius, pitch, bottomZ, topZ, dir, feed } = spec
  if (radius <= 0) throw new Error('generateHelixArcs: radius must be > 0')
  if (pitch <= 0) throw new Error('generateHelixArcs: pitch must be > 0')
  if (topZ <= bottomZ) throw new Error('generateHelixArcs: topZ must be > bottomZ')

  const role: 'helix' = spec.role ?? 'helix'
  const phi0 = spec.startAngle ?? 0
  const descend = spec.descend ?? false
  const dz = topZ - bottomZ
  const totalAngleAbs = (dz / pitch) * 2 * Math.PI
  const startZ = descend ? topZ : bottomZ
  const endZ = descend ? bottomZ : topZ
  const zSign = descend ? -1 : 1
  const arcType = dir === 1 ? 'arc_ccw' : 'arc_cw'

  const at = (a: number) => {
    const ang = phi0 + dir * a
    return { x: cx + radius * Math.cos(ang), y: cy + radius * Math.sin(ang) }
  }

  const moves: ToolpathMove[] = []
  const start = at(0)
  moves.push({ type: 'feed', x: start.x, y: start.y, z: startZ, feed: spec.entryFeed ?? feed, role })

  const segments = Math.max(1, Math.ceil(totalAngleAbs / Math.PI - 1e-9))
  let prev = start
  for (let k = 1; k <= segments; k++) {
    const last = k === segments
    const a = last ? totalAngleAbs : (k / segments) * totalAngleAbs
    const p = at(a)
    const z = last ? endZ : startZ + zSign * (a / totalAngleAbs) * dz
    if (Math.hypot(p.x - prev.x, p.y - prev.y) < HELIX_ARC_MIN_CHORD_MM) {
      moves.push({ type: 'feed', x: p.x, y: p.y, z, feed, role })
    } else {
      moves.push({ type: arcType, x: p.x, y: p.y, z, cx, cy, feed, role })
    }
    prev = p
  }
  return moves
}

/**
 * Spec for a tangent lead semicircle that blends the helix to/from the orbit
 * center without a cusp. See ADR-0031 (thread_mill operation contract).
 */
export interface LeadArcSpec {
  cx: number; cy: number;     // orbit center O
  radius: number;             // orbit radius R (> 0); the arc has radius R/2
  angle: number;              // orbit point angle; Q = O + R*(cos angle, sin angle)
  dir: 1 | -1;                // orbit travel sense at Q (from threadOrbitSense)
  z: number;                  // plane height (bottomZ for lead-in, topZ for lead-out)
  feed: number;
  kindRole: 'lead_in' | 'lead_out';
}

/**
 * Generate a tangent lead semicircle of radius R/2 connecting the orbit center
 * O and the orbit point Q. The arc is tangent to the orbit at Q so it blends
 * with the helix without a cusp.
 *
 * Geometry: u = (cos angle, sin angle); Q = O + R*u; arc center C = O + (R/2)*u,
 * arc radius rho = R/2; O sits at beta = angle + PI, Q at beta = angle. The
 * sweep is exactly PI radians, with direction chosen so the tangent at Q matches
 * the orbit tangent t = dir*(-sin angle, cos angle).
 *
 * Emission:
 *  - 'lead_in':  O .. (just before Q); the helix re-emits Q as its first point.
 *  - 'lead_out': (just after Q) .. O; the helix already emitted Q=E as its last.
 */
export function generateLeadArc(spec: LeadArcSpec): ToolpathMove[] {
  const { cx, cy, radius, angle, dir, z, feed, kindRole } = spec
  if (radius <= 0) throw new Error('generateLeadArc: radius must be > 0')

  const rho = radius / 2
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  // Arc center C = O + (radius/2)*u.
  const ccx = cx + rho * ux
  const ccy = cy + rho * uy

  // Q's coords, assigned literally (no float drift) for clamping the endpoint.
  const qx = cx + radius * ux
  const qy = cy + radius * uy

  // O sits at beta = angle + PI, Q at beta = angle. Direction set so the tangent
  // AT Q matches the orbit tangent t = dir*(-sin angle, cos angle).
  const betaStart = dir === 1 ? angle - Math.PI : angle + Math.PI
  const step = dir === 1 ? HELIX_FI_STEP : -HELIX_FI_STEP

  // Build the full ordered point list O .. Q INCLUSIVE.
  const ptsOToQ: ToolpathMove[] = []
  // First point is exactly O.
  ptsOToQ.push({ type: 'feed', x: cx, y: cy, z, feed, role: kindRole })

  // Step from betaStart toward beta = angle. The total sweep is exactly PI; stop
  // just before overshooting `angle`, then emit Q exactly.
  let beta = betaStart + step
  // Number of intermediate steps before reaching `angle` (sweep magnitude PI).
  while (Math.abs(beta - angle) > 1e-9 && (angle - beta) * step > 1e-9) {
    ptsOToQ.push({
      type: 'feed',
      x: ccx + rho * Math.cos(beta),
      y: ccy + rho * Math.sin(beta),
      z,
      feed,
      role: kindRole,
    })
    beta += step
  }
  // Final point is exactly Q (clamped).
  ptsOToQ.push({ type: 'feed', x: qx, y: qy, z, feed, role: kindRole })

  if (kindRole === 'lead_in') {
    // O .. just-before-Q (helix emits Q as its first point).
    return ptsOToQ.slice(0, ptsOToQ.length - 1)
  }
  // lead_out: reverse(ptsOToQ) with the FIRST element (Q) dropped -> just-after-Q .. O.
  const reversed = [...ptsOToQ].reverse()
  return reversed.slice(1)
}
