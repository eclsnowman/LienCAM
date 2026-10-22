// WO-3031 (alpha.3 A3-13): the one lead-in / lead-out library (REQ-ENTRY-7) - straight,
// polyline, arc, ramp and helix leads - each reproducing a lead today's families build
// inline or in their own helper (read-only, not edited):
//   straight  Contour open pass (contour2d.ts:262-278), Thread Mill straight lead
//             (threadmill2d.ts:252, :298), Adaptive 2D side entry (adaptiveClearing2d/engine/emit.ts:363)
//   polyline  Adaptive 2D / 3D lead passes (engine/emit.ts:431, cam3d/rough/emit.ts:696),
//             Engrave lead points (engrave2d/index.ts:298, :305), Contour rough-to-finish blend
//             (contour2d.ts:2016-2025)
//   arc       Thread Mill tangent semicircle (threadHelix.ts generateLeadArc); Adaptive 3D
//             G2 / G3 lead arcs (arcMoveLead)
//   ramp      a lead that descends along its path (the 3D finishing linker's ramp lead lives
//             in src/kernel/linking/finishLinker3d.ts, at parity there)
//   helix     Thread Mill exit climb (threadmill2d.ts:271), built by the one helix builder
// At parity the lead-in / lead-out radius fields are read where today reads them and
// ignored where today ignores them (policy.ts lead_fields_honoured, MD-70).

import type { MoveRole, ToolpathMove, Vec2 } from '../../types'
import { HELIX_FI_STEP, buildHelix, type HelixSpec } from './helix'
import { rampDescent } from './ramp'
import { onOneCircle } from './classify'

export type LeadRole = Extract<MoveRole, 'lead_in' | 'lead_out'>
export const LEAD_KINDS = ['straight', 'polyline', 'arc', 'ramp', 'helix'] as const
/** straight: one feed move; polyline: feed moves at one Z; arc: a tangent semicircle
 *  (arcLead), a sampled arc or G2 / G3 moves (arcMoveLead) at one Z; ramp: a descent along
 *  a path; helix: a descent about one centre. */
export type LeadKind = typeof LEAD_KINDS[number]

/** One feed move to `to` at `z`. */
export function straightLead(moves: ToolpathMove[], to: Vec2, z: number, feed: number | undefined, role: LeadRole): void {
  moves.push({ type: 'feed', x: to.x, y: to.y, z, feed, role })
}

/** Feed moves through `points` at `z` (the tool already stands at the point before `points[0]`). */
export function polylineLead(
  moves: ToolpathMove[], points: readonly Vec2[], z: number, feed: number | undefined, role: LeadRole,
): void {
  for (const p of points) moves.push({ type: 'feed', x: p.x, y: p.y, z, feed, role })
}

/** One circular-arc move (G2 / G3) to `to` about `centre` at `z`: the Adaptive 3D lead arcs. */
export function arcMoveLead(
  moves: ToolpathMove[], to: Vec2, centre: Vec2, sense: 'arc_cw' | 'arc_ccw', z: number,
  feed: number | undefined, role: LeadRole,
): void {
  moves.push({ type: sense, x: to.x, y: to.y, z, cx: centre.x, cy: centre.y, feed, role })
}

/** A lead that descends from fromZ to toZ along `points`, Z linear in distance (the ramp builder). */
export function rampLead(
  moves: ToolpathMove[], from: Vec2, points: readonly Vec2[], fromZ: number, toZ: number,
  feed: number, role: LeadRole,
): void {
  const cum: number[] = []
  let total = 0
  let prev = from
  for (const p of points) {
    total += Math.hypot(p.x - prev.x, p.y - prev.y)
    cum.push(total)
    prev = p
  }
  rampDescent(moves, (_length, visit) => points.forEach((p, i) => visit(p, cum[i])), fromZ, toZ, total, feed, role)
}

/** A helical lead: the one helix builder, carrying the lead's role. */
export function helixLead(moves: ToolpathMove[], spec: Omit<HelixSpec, 'role'>, role: LeadRole): Vec2 {
  return buildHelix(moves, { ...spec, role })
}

/** Today's tangent lead semicircle input (src/lib/cam/threadHelix.ts LeadArcSpec). */
export interface LeadArcSpec {
  cx: number; cy: number
  /** Orbit radius R (> 0); the arc has radius R/2. */
  radius: number
  /** Orbit point angle; Q = O + R (cos angle, sin angle). */
  angle: number
  dir: 1 | -1
  z: number
  feed: number
  kindRole: LeadRole
}

/**
 * The tangent lead semicircle of radius R/2 between the orbit centre O and the orbit point Q,
 * tangent to the orbit at Q (src/lib/cam/threadHelix.ts generateLeadArc). 'lead_in' runs
 * O .. just before Q (the helix emits Q); 'lead_out' runs just after Q .. O.
 */
export function arcLead(spec: LeadArcSpec): ToolpathMove[] {
  const { cx, cy, radius, angle, dir, z, feed, kindRole } = spec
  if (radius <= 0) throw new Error('generateLeadArc: radius must be > 0')
  const rho = radius / 2
  const ux = Math.cos(angle)
  const uy = Math.sin(angle)
  const ccx = cx + rho * ux
  const ccy = cy + rho * uy
  const qx = cx + radius * ux
  const qy = cy + radius * uy
  const betaStart = dir === 1 ? angle - Math.PI : angle + Math.PI
  const step = dir === 1 ? HELIX_FI_STEP : -HELIX_FI_STEP
  const ptsOToQ: ToolpathMove[] = []
  ptsOToQ.push({ type: 'feed', x: cx, y: cy, z, feed, role: kindRole })
  let beta = betaStart + step
  while (Math.abs(beta - angle) > 1e-9 && (angle - beta) * step > 1e-9) {
    ptsOToQ.push({ type: 'feed', x: ccx + rho * Math.cos(beta), y: ccy + rho * Math.sin(beta), z, feed, role: kindRole })
    beta += step
  }
  ptsOToQ.push({ type: 'feed', x: qx, y: qy, z, feed, role: kindRole })
  if (kindRole === 'lead_in') return ptsOToQ.slice(0, ptsOToQ.length - 1)
  return [...ptsOToQ].reverse().slice(1)
}

/** Which library lead a run of lead moves is, read from the moves (`from` is where the tool
 *  stood before the run): one move is straight (a fed descent included); a run at one Z on
 *  a circle is an arc, otherwise a polyline; a run that changes Z on a circle is a helix,
 *  otherwise a ramp. */
export function classifyLeadRun(from: { x: number; y: number; z: number }, run: readonly ToolpathMove[]): LeadKind {
  if (run.length === 1 && run[0].type === 'feed') return 'straight'
  const flat = run.every(m => Math.abs(m.z - from.z) <= 1e-9)
  const circle = run.some(m => m.type === 'arc_cw' || m.type === 'arc_ccw') || onOneCircle([from, ...run])
  if (flat) return circle ? 'arc' : 'polyline'
  return circle ? 'helix' : 'ramp'
}

/** Rebuild a run of lead moves through the library, for the kind `classifyLeadRun` read.
 *  Straight, polyline and ramp take the run's own points; an arc the families sample inline
 *  (Adaptive 2D / 3D lead arcs) is a polyline on its circle. Feed and role are the run's.
 *  Thread Mill's tangent semicircle is `arcLead`, compared on its own recorded calls. */
export function rebuildLeadRun(from: { x: number; y: number; z: number }, run: readonly ToolpathMove[]): ToolpathMove[] | undefined {
  const kind = classifyLeadRun(from, run)
  const role = run[0].role as LeadRole
  const feed = run[0].feed
  if (run.some(m => m.role !== role || m.feed !== feed)) return undefined
  const out: ToolpathMove[] = []
  if (kind === 'straight') straightLead(out, run[0], run[0].z, feed, role)
  else if (kind === 'polyline' || kind === 'arc') {
    for (const m of run) {
      if (m.type === 'feed') polylineLead(out, [m], from.z, feed, role)
      else if ((m.type === 'arc_cw' || m.type === 'arc_ccw') && m.cx !== undefined && m.cy !== undefined) {
        arcMoveLead(out, m, { x: m.cx, y: m.cy }, m.type, from.z, feed, role)
      } else return undefined
    }
  } else if (kind === 'ramp' && feed !== undefined && run.every(m => m.type === 'feed')) {
    rampLead(out, from, run, from.z, run[run.length - 1].z, feed, role)
  } else return undefined
  return out
}
