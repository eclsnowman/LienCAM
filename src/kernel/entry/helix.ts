// WO-3031 (alpha.3 A3-13): the one helix builder. Today four helices descend into
// material, each written where its family lives (read-only, not edited):
//   - the shared 2.5D descent `helixDescent` (src/lib/cam/moves/index.ts, WO-1679): Pocket,
//     Adaptive 2D, Contour / Engrave trochoidal orbits;
//   - the thread polyline `generateThreadHelix` (src/lib/cam/threadHelix.ts): Thread Mill;
//   - the helical arcs `generateHelixArcs` (same file, WO-2039): Bore's helical entry;
//   - the 3D rough `emitHelix` closure (src/cam3d/rough/emit.ts): Adaptive 3D.
// Here they are one builder: centre, orbit radius, Z span, start angle and sense are the
// shared geometry; each family passes its own pitch (a ramp angle, or bore / thread's
// own mm per turn) and its own sampling recipe, so every family's moves stay exactly
// today's. Which family samples how is a parity fact in mapping.ts.

import type { MoveRole, ToolpathMove, Vec2 } from '../../types'
import { ENTRY_GATES } from './gates'

/** Smallest helix radius worth spiralling at (src/lib/cam/moves/index.ts MIN_HELIX_RADIUS_MM);
 *  below it a helix is a plunge at ramp feed. Read from the gate table (gates.ts). */
export const MIN_HELIX_RADIUS_MM = ENTRY_GATES.helix_floor_2d.value

/** Angular step of the dense thread polyline and of the Adaptive 2D fixed sampling
 *  (src/lib/cam/threadHelix.ts HELIX_FI_STEP). */
export const HELIX_FI_STEP = Math.PI / 16

/** A helical arc whose XY chord is shorter than this is written as a straight feed
 *  (src/lib/cam/threadHelix.ts HELIX_ARC_MIN_CHORD_MM). */
export const HELIX_ARC_MIN_CHORD_MM = 0.01

/** True when a helix of `radius` is a real helix rather than a disguised plunge. */
export function helixFits(radius: number, minRadius = MIN_HELIX_RADIUS_MM): boolean {
  return Number.isFinite(radius) && radius >= minRadius
}

/** How far the helix drops per turn. */
export type HelixPitch =
  /** A ramp angle: drop per turn = 2 pi `pitchRadius` (default the orbit radius) x tanAngle. */
  | { kind: 'angle'; tanAngle: number; pitchRadius?: number }
  /** The family's own mm per turn (Bore from its orbit and ramp angle, Thread Mill its thread pitch). */
  | { kind: 'pitch'; mm: number }

/** Each family's sampling recipe, as today. */
export type HelixSampling =
  /** 2.5D descent default: equal steps, `stepsPerRev` per turn, at least `minSteps`; start not emitted. */
  | { kind: 'even'; stepsPerRev: number; minSteps: number }
  /** A point every `stepRad` from the start (start included), capped at `maxPoints`, then the exact end. */
  | { kind: 'fixed'; stepRad: number; maxPoints: number }
  /** Thread polyline: start emitted, a point every HELIX_FI_STEP, the exact end (overwriting a coincident last point). */
  | { kind: 'dense' }
  /** Helical arcs of at most half a turn, after a feed to the start (Bore, WO-2039). */
  | { kind: 'arcs' }
  /** Adaptive 3D: `segmentsPerTurn` per turn and at least one turn, then (when `cleanupTurn`)
   *  one full turn at depth; refuses above `maxPoints`. */
  | { kind: 'turns'; segmentsPerTurn: number; cleanupTurn: boolean; maxPoints: number }

export interface HelixSpec {
  centre: Vec2
  /** Radius the tool centre actually orbits at. */
  radius: number
  fromZ: number
  toZ: number
  pitch: HelixPitch
  sampling: HelixSampling
  /** Feed every helix move carries (absent: no feed word, as the 3D IR). */
  feed?: number
  /** Default 'helix'. */
  role?: MoveRole
  /** Angle of the first point (radians). Default 0 = +X of the centre. */
  startAngle?: number
  /** +1 counter-clockwise (default), -1 clockwise. */
  direction?: 1 | -1
}

const EPS_3D = 1e-9

/** Drop per turn, with each family's own arithmetic order. */
function dropPerTurn(spec: HelixSpec): number {
  return spec.pitch.kind === 'pitch'
    ? spec.pitch.mm
    : 2 * Math.PI * (spec.pitch.pitchRadius ?? spec.radius) * spec.pitch.tanAngle
}

/**
 * The one helix builder: spiral around `centre` from fromZ to toZ, Z linear in swept angle,
 * the last move exactly at toZ. Emits feed (or arc) moves only - the approach to the start
 * point is the caller's. Returns the end point.
 */
export function buildHelix(moves: ToolpathMove[], spec: HelixSpec): Vec2 {
  switch (spec.sampling.kind) {
    case 'even':
    case 'fixed':
      return descentHelix(moves, spec, spec.sampling)
    case 'dense':
      return denseHelix(moves, spec)
    case 'arcs':
      return arcHelix(moves, spec)
    case 'turns':
      return turnsHelix(moves, spec, spec.sampling)
  }
}

// -- 2.5D descent (src/lib/cam/moves/index.ts helixDescent) ----------------------------

function descentHelix(
  moves: ToolpathMove[], h: HelixSpec,
  sampling: Extract<HelixSampling, { kind: 'even' | 'fixed' }>,
): Vec2 {
  const dir = h.direction ?? 1
  const phi0 = h.startAngle ?? 0
  const drop = h.fromZ - h.toZ
  const dropPerRev = dropPerTurn(h)
  const role = h.role ?? 'helix'
  const at = (phi: number) => ({
    x: h.centre.x + h.radius * Math.cos(phi0 + dir * phi),
    y: h.centre.y + h.radius * Math.sin(phi0 + dir * phi),
  })
  const push = (p: Vec2, z: number) =>
    moves.push({ type: 'feed', x: p.x, y: p.y, z, feed: h.feed, role })

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

// -- Thread polyline (src/lib/cam/threadHelix.ts generateThreadHelix) ------------------

/** Ascending or descending span in today's thread terms (bottomZ < topZ). */
function threadSpan(h: HelixSpec, name: string) {
  if (h.radius <= 0) throw new Error(`${name}: radius must be > 0`)
  const pitch = dropPerTurn(h)
  if (pitch <= 0) throw new Error(`${name}: pitch must be > 0`)
  const descend = h.toZ < h.fromZ
  const bottomZ = descend ? h.toZ : h.fromZ
  const topZ = descend ? h.fromZ : h.toZ
  if (topZ <= bottomZ) throw new Error(`${name}: topZ must be > bottomZ`)
  return { pitch, descend, bottomZ, topZ }
}

function denseHelix(moves: ToolpathMove[], h: HelixSpec): Vec2 {
  const { pitch, descend, bottomZ, topZ } = threadSpan(h, 'generateThreadHelix')
  const { x: cx, y: cy } = h.centre
  const { radius, feed } = h
  const dir = h.direction ?? 1
  const role = h.role ?? 'helix'
  const phi0 = h.startAngle ?? 0
  const revs = (topZ - bottomZ) / pitch
  const totalAngleAbs = revs * 2 * Math.PI
  const dz = topZ - bottomZ
  const startZ = descend ? topZ : bottomZ
  const endZ = descend ? bottomZ : topZ
  const zSign = descend ? -1 : 1
  const out: ToolpathMove[] = []
  const pushAt = (a: number): void => {
    const ang = phi0 + dir * a
    out.push({
      type: 'feed',
      x: cx + radius * Math.cos(ang),
      y: cy + radius * Math.sin(ang),
      z: startZ + zSign * (a / totalAngleAbs) * dz,
      feed,
      role,
    })
  }
  pushAt(0)
  let a = HELIX_FI_STEP
  while (a < totalAngleAbs - 1e-9) {
    pushAt(a)
    a += HELIX_FI_STEP
  }
  const finalAngle = phi0 + dir * totalAngleAbs
  const prevA = a - HELIX_FI_STEP
  if (totalAngleAbs - prevA <= 1e-9 && out.length > 1) {
    const last = out[out.length - 1]
    last.x = cx + radius * Math.cos(finalAngle)
    last.y = cy + radius * Math.sin(finalAngle)
    last.z = endZ
  } else {
    out.push({
      type: 'feed',
      x: cx + radius * Math.cos(finalAngle),
      y: cy + radius * Math.sin(finalAngle),
      z: endZ,
      feed,
      role,
    })
  }
  moves.push(...out)
  const last = out[out.length - 1]
  return { x: last.x, y: last.y }
}

// -- Helical arcs (src/lib/cam/threadHelix.ts generateHelixArcs) -----------------------

function arcHelix(moves: ToolpathMove[], h: HelixSpec): Vec2 {
  const { pitch, descend, bottomZ, topZ } = threadSpan(h, 'generateHelixArcs')
  const { x: cx, y: cy } = h.centre
  const { radius, feed } = h
  const dir = h.direction ?? 1
  const role = h.role ?? 'helix'
  const phi0 = h.startAngle ?? 0
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
  const start = at(0)
  moves.push({ type: 'feed', x: start.x, y: start.y, z: startZ, feed, role })
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
  return prev
}

// -- Adaptive 3D turns (src/cam3d/rough/emit.ts emitHelix) -----------------------------

function turnsHelix(
  moves: ToolpathMove[], h: HelixSpec,
  sampling: Extract<HelixSampling, { kind: 'turns' }>,
): Vec2 {
  const c = h.centre
  const r = h.radius
  const dir = h.direction ?? 1
  const role = h.role ?? 'helix'
  const zStart = h.fromZ
  const zEnd = h.toZ
  const totalDepth = zStart - zEnd
  const depthPerTurn = dropPerTurn(h)
  const totalAngle = depthPerTurn > EPS_3D ? (totalDepth / depthPerTurn) * 2 * Math.PI : 2 * Math.PI
  const angStep = (2 * Math.PI) / sampling.segmentsPerTurn
  const nSeg = Math.max(sampling.segmentsPerTurn, Math.ceil(totalAngle / angStep - EPS_3D))
  const cleanupSegs = sampling.cleanupTurn ? sampling.segmentsPerTurn : 0
  if (nSeg + cleanupSegs > sampling.maxPoints) {
    throw new Error(
      `emitLevelPasses: helix requires ${nSeg + cleanupSegs} points, above the ` +
        `${sampling.maxPoints}-point safety limit; ` +
        `increase the helix angle or diameter, or reduce the descent depth.`,
    )
  }
  const push = (x: number, y: number, z: number) =>
    moves.push(h.feed === undefined ? { type: 'feed', x, y, z, role } : { type: 'feed', x, y, z, feed: h.feed, role })
  let end = { x: c.x + r, y: c.y }
  for (let k = 1; k <= nSeg; k++) {
    const fi = dir * (totalAngle * k) / nSeg
    end = { x: c.x + r * Math.cos(fi), y: c.y + r * Math.sin(fi) }
    push(end.x, end.y, zStart - (totalDepth * k) / nSeg)
  }
  for (let k = 1; k <= cleanupSegs; k++) {
    const fi = dir * (totalAngle + (2 * Math.PI * k) / cleanupSegs)
    end = { x: c.x + r * Math.cos(fi), y: c.y + r * Math.sin(fi) }
    push(end.x, end.y, zEnd)
  }
  return end
}

// -- Today's call shapes, routed through the one builder ------------------------------

/** Today's `helixDescent` input (src/lib/cam/moves/index.ts). */
export interface HelixDescent {
  centre: Vec2
  radius: number
  fromZ: number
  toZ: number
  tanAngle: number
  pitchRadius?: number
  feed: number
  startAngle?: number
  direction?: 1 | -1
  sampling?:
    | { kind: 'even'; stepsPerRev: number; minSteps: number }
    | { kind: 'fixed'; stepRad: number; maxPoints: number }
}

/** The 2.5D descent default sampling: 36 steps per turn, at least 12. */
export const DESCENT_DEFAULT_SAMPLING = Object.freeze({ kind: 'even', stepsPerRev: 36, minSteps: 12 } as const)

/** 2.5D helical descent (Pocket, Adaptive 2D, trochoidal Contour / Engrave), 'helix' feed moves. */
export function helixDescent(moves: ToolpathMove[], h: HelixDescent): Vec2 {
  return buildHelix(moves, {
    centre: h.centre, radius: h.radius, fromZ: h.fromZ, toZ: h.toZ,
    pitch: { kind: 'angle', tanAngle: h.tanAngle, pitchRadius: h.pitchRadius },
    sampling: h.sampling ?? DESCENT_DEFAULT_SAMPLING,
    feed: h.feed, role: 'helix', startAngle: h.startAngle, direction: h.direction,
  })
}

/** Today's thread / bore helix input (src/lib/cam/threadHelix.ts ThreadHelixSpec). */
export interface ThreadHelixSpec {
  cx: number; cy: number
  radius: number
  pitch: number
  bottomZ: number
  topZ: number
  dir: 1 | -1
  feed: number
  startAngle?: number
  role?: 'helix'
  descend?: boolean
}

function threadSpec(spec: ThreadHelixSpec, sampling: HelixSampling): HelixSpec {
  const descend = spec.descend ?? false
  return {
    centre: { x: spec.cx, y: spec.cy }, radius: spec.radius,
    fromZ: descend ? spec.topZ : spec.bottomZ, toZ: descend ? spec.bottomZ : spec.topZ,
    pitch: { kind: 'pitch', mm: spec.pitch }, sampling,
    feed: spec.feed, role: spec.role ?? 'helix', startAngle: spec.startAngle, direction: spec.dir,
  }
}

/** Thread Mill's helix: the thread's own pitch, a dense polyline. */
export function threadHelix(spec: ThreadHelixSpec): ToolpathMove[] {
  // Today's input checks first, in today's order (a zero span is refused, never built).
  if (spec.radius <= 0) throw new Error('generateThreadHelix: radius must be > 0')
  if (spec.pitch <= 0) throw new Error('generateThreadHelix: pitch must be > 0')
  if (spec.topZ <= spec.bottomZ) throw new Error('generateThreadHelix: topZ must be > bottomZ')
  const moves: ToolpathMove[] = []
  buildHelix(moves, threadSpec(spec, { kind: 'dense' }))
  return moves
}

/** Bore's helical entry: its own pitch, helical arcs of at most half a turn (WO-2039). */
export function helixArcs(spec: ThreadHelixSpec): ToolpathMove[] {
  if (spec.radius <= 0) throw new Error('generateHelixArcs: radius must be > 0')
  if (spec.pitch <= 0) throw new Error('generateHelixArcs: pitch must be > 0')
  if (spec.topZ <= spec.bottomZ) throw new Error('generateHelixArcs: topZ must be > bottomZ')
  const moves: ToolpathMove[] = []
  buildHelix(moves, threadSpec(spec, { kind: 'arcs' }))
  return moves
}

/** Bore's pitch today (src/lib/cam/bore2d.ts emitHelicalEntry): the authored ramp angle
 *  (never below 0.25 deg) on the orbit circumference, kept strictly positive. */
export function borePitch(orbitRadius: number, rampAngleDeg: number, eps = 1e-6): number {
  const tanAngle = Math.tan(Math.max(0.25, rampAngleDeg) * Math.PI / 180)
  return Math.max(eps, 2 * Math.PI * orbitRadius * tanAngle)
}

/** Thread Mill's pitch today (src/lib/cam/threadmill2d.ts): TPI (when > 0) wins, else the pitch. */
export function threadPitch(params: { tpi?: number; pitch: number }): number {
  return (params.tpi && params.tpi > 0) ? 25.4 / params.tpi : params.pitch
}
